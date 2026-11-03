/**
 * The embedded-checkout sample's routes, built around the one thing that
 * differs between running it and testing it: the SDK client. `server.ts`
 * supplies the real one and listens; a test can supply a stubbed client and
 * drive these exact handlers over HTTP.
 *
 * See server.ts for what each route does and which env vars it reads.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response } from "express";
import {
  VonPayError,
  type PaymentIntentStatus,
  type VonPayCheckout,
} from "@vonpay/checkout-node";

// Re-exported so a test builds its errors from the SAME module this file
// checks with `instanceof`.
export { VonPayError };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The amount the demo charges. Real integrations derive this from the cart,
// on the server: the browser never sends an amount.
const AMOUNT = 4999; // $49.99 in the currency's minor unit
const CURRENCY = "USD";

/** The parts of the SDK client these routes use. */
export type CheckoutClient = Pick<VonPayCheckout, "paymentIntents" | "sessions">;

export interface AppDeps {
  client: CheckoutClient;
  /** vp_pk_* — sent to the browser. */
  publishableKey: string;
  /** Optional API base override, passed to the browser SDK too. */
  apiBase?: string;
  /**
   * Express's `trust proxy` setting. Leave it off (the default) when browsers
   * reach this server directly. Behind a TLS-terminating proxy or load
   * balancer, set it to that hop (e.g. `1`), so `req.secure` reflects the
   * buyer's HTTPS connection and the checkout cookie is marked `Secure`.
   * Never trust a proxy you do not run: `X-Forwarded-Proto` is then the
   * caller's word.
   */
  trustProxy?: boolean | number | string;
}

// ───────────────────────────────────────────────────────────────────────
// The checkout record. A real integration keeps this on its order row; the
// sample keeps it in memory, keyed by a random id in an httpOnly cookie, so
// the browser can name ITS checkout but cannot point the server at anyone
// else's session or payment. (In memory: restarting the server forgets it,
// and nothing evicts old entries. A dev stub, not something to deploy.)
// ───────────────────────────────────────────────────────────────────────

interface CheckoutRecord {
  sessionId: string;
  /** The payment intent this server created, once it has charged. */
  intentId?: string;
  /** A charge request is running right now (set before the API call). */
  charging?: boolean;
  /**
   * A charge was sent and its answer was lost or ambiguous, so no intent id
   * was recorded. Money may have moved: no further charge on this checkout.
   */
  chargeUnresolved?: boolean;
}

const COOKIE = "embedded_checkout";

type Outcome =
  | "paid" // money captured
  | "held" // authorised, not captured: capture or void it; do not fulfil yet
  | "pending" // started, result not final: wait for the webhook
  | "requires_action" // the bank wants a 3-D Secure check
  | "failed"; // declined, voided or cancelled: nothing to fulfil

function outcomeForIntent(status: PaymentIntentStatus): Outcome {
  switch (status) {
    case "succeeded":
      return "paid";
    case "authorized":
      return "held";
    case "captured":
      // A capture still pending at the processor: not money in hand yet.
      return "pending";
    case "requires_action":
      return "requires_action";
    case "failed":
    case "voided":
    // The bank's security check was cancelled by staff (in your dashboard's
    // virtual terminal). No money moved.
    case "cancelled":
      return "failed";
  }
}

export function createApp({ client, publishableKey, apiBase, trustProxy = false }: AppDeps): Express {
  const app = express();
  app.set("trust proxy", trustProxy);
  app.use(express.json());

  const checkouts = new Map<string, CheckoutRecord>();

  function readCheckout(req: Request): CheckoutRecord | undefined {
    const header = req.headers.cookie ?? "";
    for (const part of header.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name !== COOKIE) continue;
      // A malformed cookie (a stray `%`) names no checkout: treat it as none
      // rather than failing the request.
      try {
        return checkouts.get(decodeURIComponent(rest.join("=")));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  // Expose the publishable key + amount to the browser. The publishable key
  // is safe to ship to the client: it can only authenticate VORA's public
  // endpoints, never move money on its own.
  app.get("/api/config", (_req: Request, res: Response) => {
    res.json({
      publishableKey,
      apiBase: apiBase ?? null,
      amount: AMOUNT,
      currency: CURRENCY,
    });
  });

  /**
   * Create a checkout session. The browser calls this, gets back the
   * session id, then loads the card field against it with the publishable
   * key. The session carries the amount/currency the embed will charge.
   */
  app.post("/api/create-session", async (req: Request, res: Response) => {
    // Stand-in for YOUR order id. In a real app, create the order first and use its id.
    const orderId = `order_${randomUUID()}`;
    try {
      const session = await client.sessions.create(
        {
          amount: AMOUNT,
          currency: CURRENCY,
          // Tag the session so it's identifiable in your dashboard.
          metadata: { sample: "checkout-embedded", order_id: orderId },
        },
        // Key on YOUR order id. Here orderId is made per request, so this only dedupes the SDK's own retry of this call; to dedupe a double-click or refresh, create the order first and reuse its id.
        { idempotencyKey: `session:${orderId}` },
      );

      const checkoutId = randomUUID();
      checkouts.set(checkoutId, { sessionId: session.id });
      // The cookie is the only thing that lets a browser charge THIS
      // checkout. httpOnly: page scripts cannot read it. sameSite "lax": a
      // cross-site POST to /api/charge does not carry it. secure: whenever
      // THIS request arrived over HTTPS (`req.secure`; behind a
      // TLS-terminating proxy that needs `trustProxy`, see AppDeps).
      res.cookie(COOKIE, checkoutId, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.secure,
        path: "/",
      });
      // session.id (vp_cs_*) is the only field the browser needs. It is
      // safe to expose. Do not forward the whole session object.
      res.status(201).json({ session_id: session.id });
    } catch (err) {
      logUpstreamError("create-session", err);
      res.status(statusFor(err)).json({ error: MESSAGES.sessionNotCreated });
    }
  });

  /**
   * Charge a tokenized card server-side. Called ONLY on the tokenize-only
   * flow, where the browser's submit resolved with a `vp_pmt_*` token and
   * the actual money movement happens here.
   *
   * Do NOT call this on a charge-and-save session: there the embed already
   * charged the buyer at submit, so charging the token here would charge
   * them twice. The browser discriminates the submit result and only POSTs
   * here when it received a token (see public/checkout.js). The `sessionId`
   * sent below makes the server refuse it too.
   */
  //
  // ⚠ Before deploying a route like this, rate-limit it (per buyer and per IP)
  // and put your bot / card-testing protection in front of it. It moves money
  // with your secret key on every call, which is exactly what card testers
  // look for. This dev stub deliberately has neither.
  app.post("/api/charge", async (req: Request, res: Response) => {
    const checkout = readCheckout(req);
    if (checkout === undefined) {
      res.status(409).json({
        error: "No checkout on this server for this browser. Create a checkout session first.",
      });
      return;
    }
    const token: unknown = req.body?.token;
    if (typeof token !== "string" || !/^vp_pmt_(test|live)_[A-Za-z0-9_-]+$/.test(token)) {
      res.status(400).json({ error: "A vp_pmt_* token is required." });
      return;
    }

    // ⛔ ONE LIVE CHARGE PER CHECKOUT, enforced HERE. The idempotency key only
    // protects a retry of the SAME token; a buyer whose page lost the answer
    // and pays again sends a NEW token, so a new key, so a second real charge.
    // The `sessionId` guard does not cover it either: it refuses a charge only
    // when the session itself charged at submit. So this server refuses a
    // second charge while the checkout has one in flight, one whose answer was
    // lost, or one that did not fail. Each refusal says `outcome_unknown`,
    // which tells the page not to offer Pay again.
    if (checkout.charging === true || checkout.chargeUnresolved === true) {
      res.status(409).json({
        error: "A payment for this checkout is in progress or its result is not known yet.",
        code: "checkout_charge_unresolved",
        outcome_unknown: true,
      });
      return;
    }
    checkout.charging = true;
    try {
      if (checkout.intentId !== undefined) {
        const previous = await client.paymentIntents.retrieve(checkout.intentId);
        if (outcomeForIntent(previous.status) !== "failed") {
          checkout.charging = false;
          res.status(409).json({
            error: "This checkout already has a payment that did not fail.",
            code: "checkout_already_charged",
            outcome_unknown: true,
          });
          return;
        }
      }
    } catch (err) {
      checkout.charging = false;
      logUpstreamError("previous-charge read", err);
      // Nothing new was sent, so this is not an unknown outcome.
      res.status(statusFor(err)).json({ error: MESSAGES.previousChargeUnread, outcome_unknown: false });
      return;
    }

    try {
      // Charge the token through the SDK's typed paymentIntents.create.
      // Don't hand-roll a fetch. The payment-method handle travels as
      // `paymentMethod: { id }`, which the SDK serializes to the documented
      // `payment_method: { id }` wire field.
      const intent = await client.paymentIntents.create(
        {
          amount: AMOUNT,
          currency: CURRENCY,
          // captureMethod defaults to "automatic" (auth + capture in one call).
          paymentMethod: { id: token },
          // Arms the server's double-charge guard: if this session already
          // charged the buyer when the form was submitted, this charge is
          // refused instead of billing the card twice. Safe to always send.
          sessionId: checkout.sessionId,
          metadata: { sample: "checkout-embedded" },
        },
        {
          // One key per logical charge, reused verbatim on a retry of the SAME
          // charge, so a retried request can never charge twice. A new card is
          // a new token and therefore a new charge. From 28 October 2026 the
          // API refuses a charge sent without a key.
          idempotencyKey: `checkout-embedded:${checkout.sessionId}:${token}:charge`,
        },
      );
      checkout.intentId = intent.id;
      res.status(201).json({
        intent_id: intent.id,
        status: intent.status,
        outcome: outcomeForIntent(intent.status),
      });
    } catch (err) {
      // An answered refusal (4xx that is not "reconcile") moved no money.
      // Anything else ("reconcile", a 5xx, a network failure) may have, and
      // left no intent id to read: lock the checkout until a person or the
      // webhook says.
      const answered =
        err instanceof VonPayError && err.status < 500 && err.nextAction !== "reconcile";
      if (!answered) checkout.chargeUnresolved = true;
      logUpstreamError("charge", err);
      res.status(statusFor(err)).json({
        error: answered ? MESSAGES.chargeRefused : MESSAGES.chargeUnknown,
        outcome_unknown: !answered,
      });
    } finally {
      checkout.charging = false;
    }
  });

  app.use(express.static(path.join(__dirname, "public")));

  return app;
}

// ── Error helpers ─────────────────────────────────────────────────────
// The browser gets the status and one fixed sentence per outcome. The API's
// own error text stays in the server log (logUpstreamError): it is written
// for you, the developer, and can name request ids, codes or settings that a
// buyer's browser has no use for.

const MESSAGES = {
  sessionNotCreated: "Could not start the checkout. Please try again later.",
  previousChargeUnread: "Could not check this checkout's earlier payment. Nothing new was charged. Please try again.",
  chargeRefused: "The payment was not accepted, and the card was not charged. Try again or use another card.",
  chargeUnknown: "We could not confirm whether the card was charged. Please do not pay again.",
} as const;

function statusFor(err: unknown): number {
  if (err instanceof VonPayError && typeof err.status === "number") {
    return err.status >= 400 && err.status < 600 ? err.status : 502;
  }
  return 502;
}

function logUpstreamError(op: string, err: unknown): void {
  if (err instanceof VonPayError) {
    console.error(`[${op}] VonPayError`, {
      status: err.status,
      code: err.code,
      message: err.message,
    });
  } else {
    console.error(`[${op}] error`, err);
  }
}
