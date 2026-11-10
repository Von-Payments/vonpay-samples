/**
 * The funnel sample's routes. `server/index.ts` supplies the real SDK client
 * and listens; tests/scripts/samples-funnel-one-click.test.ts supplies a
 * stubbed client and drives these exact handlers over HTTP.
 *
 * ⛔ A REFERENCE, NOT A DEPLOYMENT. Orders live in memory, there is no rate
 * limit and no bot protection, and nothing is fulfilled. Read "Before you go
 * live" in the README before you copy any of it into a store.
 *
 * The flow, as a one-page direct-response funnel runs it:
 *
 *   Browser (public/funnel.js)               Server (here)
 *   ──────────────────────────               ─────────────
 *   page opens  → POST /api/order  ───────►  creates YOUR order record first,
 *                                            then an Elements session that
 *                                            saves the card (no charge yet)
 *               ◄───────  { session_id, terms }
 *   shopper reads the terms at the button, presses it
 *   collection.submit()  → { token }         (card saved with the shopper's
 *                                            agreement: setupForFutureUse)
 *   POST /api/charge { token } ───────────►  records the consent, then
 *                                            paymentIntents.create(...) and
 *                                            reads the saved card back
 *               ◄───────  { outcome, add_on_offer }
 *   the shopper accepts the add-on on the next screen (often ~80 s later)
 *   POST /api/add-on  ────────────────────►  paymentIntents.create(...) on the
 *                                            SAME saved card, buyer present,
 *                                            no `mit` block
 *   back from a 3-D Secure page → GET /api/outcome (the server's own read)
 *
 * ⛔ Nothing about the money is taken from the browser except the token. The
 * amounts, the order, the session, the saved card and the API key all come
 * from this server's record.
 */

import { createHash, randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import {
  VonPayError,
  type MITReason,
  type PaymentIntent,
  type PaymentIntentRead,
  type PaymentIntentStatus,
  type VonPayCheckout,
} from "@vonpay/checkout-node";

// ── The offer. A real funnel reads these from its campaign, on the server; the
//    browser never sends an amount. ──
export const MAIN_OFFER = { name: "Starter kit", amountMinor: 4999 } as const;
export const ADD_ON_OFFER = { id: "refill-pack", name: "Refill pack", amountMinor: 1999 } as const;
export const CURRENCY = "USD";

/**
 * Minor units to a display price. ⚠ USD (two decimals) only: a zero-decimal
 * currency (JPY, KRW) or a three-decimal one (KWD) needs that currency's own
 * exponent, not `/ 100`.
 */
export function formatPrice(minor: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: CURRENCY }).format(minor / 100);
}

/**
 * The words the shopper agrees to, shown NEXT TO the order button (not only
 * behind a link). With these words as the agreement, the page saves the card
 * for later use (`vora.elements.create({ setupForFutureUse: "off_session" })`).
 * The price comes from MAIN_OFFER, so the words and the charge cannot disagree.
 *
 * ⛔ EXAMPLE TEXT. Replace it with your offer's real terms before you go live:
 * the price, how often you charge, any trial and when it ends, and how to
 * cancel. Card-network rules for trials and stored cards, and the laws where
 * you sell, decide what these words must say; get your own legal advice. If
 * your words do not describe a later charge, do not send `"off_session"`: see
 * the README ("No later charges?"). If they do, also declare what the card is
 * for (STORED_CREDENTIAL_USE): the server warns at start when you have not.
 */
export function termsFor(amountMinor: number): string {
  return (
    `By placing this order you agree to pay ${formatPrice(amountMinor)} today, and you agree that we keep this card on file ` +
    "for the one-click offers you accept on the next page and for the later charges described in our " +
    "offer terms. Cancel any time at example.com/cancel."
  );
}
export const DEFAULT_TERMS = termsFor(MAIN_OFFER.amountMinor);

/**
 * Do these words promise charges after today's order? A rough check for the
 * start-up warning only (server/index.ts): it decides nothing about money.
 */
export function termsMentionLaterCharges(terms: string): boolean {
  return /\blater charges?\b|\bevery (week|month|year)\b|\b(monthly|weekly|yearly|annually)\b|\brecurring\b|\bsubscription\b|\brenew/i.test(terms);
}

/** A short, stable id for one wording of the terms: which text a shopper saw. */
export function termsVersion(terms: string): string {
  return createHash("sha256").update(terms, "utf8").digest("hex").slice(0, 16);
}

/** The consent record written when the shopper's order reaches this server. */
export interface ConsentRecord {
  orderId: string;
  buyerId: string;
  sessionId: string;
  /** The exact words shown at the button, and their version (`termsVersion`). */
  termsShown: string;
  termsVersion: string;
  /** When THIS server received the charge request (server clock). */
  chargeRequestedAt: string;
  /** When the page says the button was pressed (the browser's clock: as reported, not proof). */
  pressedAtReported: string | null;
}

/** The parts of the SDK client these routes use. */
export type CheckoutClient = Pick<VonPayCheckout, "paymentIntents" | "sessions" | "paymentMethods">;

export interface AppDeps {
  /** The SDK client, or null when VONPAY_SECRET_KEY is not set. */
  client: CheckoutClient | null;
  /** Where the bank's 3-D Secure page sends the shopper back. */
  returnUrl: string;
  /** Sent to the browser for `new Vora({ publishableKey })`. Public by design. */
  publishableKey: string;
  /** Optional `apiBaseUrl` for the browser SDK (unset = production host). */
  browserApiBase?: string;
  /**
   * What the saved card will be used for later, declared to the card networks
   * (`storedCredentialUse` on the session). Unset = no declaration. Use the
   * same word you will later send as `mit.reason`.
   */
  storedCredentialUse?: MITReason;
  /** The words shown at the order button (see DEFAULT_TERMS). */
  terms?: string;
  /**
   * ⛔ YOUR HOOK: write the consent record to your own database. Called on
   * /api/charge BEFORE the charge; if it throws, nothing is charged (no
   * record, no charge). The default only logs, which is not a record.
   */
  persistConsentRecord?: (record: ConsentRecord) => Promise<void> | void;
  /**
   * Mark the cookie `Secure` on every response, not only when the request
   * arrived over HTTPS. Default: on when NODE_ENV is "production".
   */
  secureCookies?: boolean;
  /**
   * Express `trust proxy`. Leave it off (the default) when browsers reach this
   * server directly. Behind a TLS-terminating proxy you run, set it to that
   * hop count (e.g. 1) so `req.secure` reflects the shopper's HTTPS. Never
   * trust a proxy you do not run.
   */
  trustProxy?: boolean | number | string;
  /** Most orders kept in memory; the oldest go first. Default 10,000. */
  maxOrders?: number;
}

const NO_KEY_ERROR = "VONPAY_SECRET_KEY is not configured. Set it in .env and restart.";
const COOKIE = "funnel_order";

/** The default hook. ⛔ Replace it: a log line is not a consent record. */
function logConsentRecord(record: ConsentRecord): void {
  // eslint-disable-next-line no-console
  console.log("[funnel-one-click] consent record (replace persistConsentRecord with a database write)", {
    orderId: record.orderId,
    termsVersion: record.termsVersion,
    chargeRequestedAt: record.chargeRequestedAt,
  });
}

// ───────────────────────────────────────────────────────────────────────
// Your order record. A real funnel keeps this on its order row; the sample
// keeps it in memory (capped), keyed by a random id in an httpOnly cookie, so
// a browser can name ITS order and nobody else's. Restarting the server
// forgets it: a dev stub, not a deployment.
// ───────────────────────────────────────────────────────────────────────

/** One charge on the order: the main offer, or the add-on. */
interface ChargeState {
  /** The payment intent this server created, once it has charged. */
  intentId?: string;
  /** A request is running right now (set before the API call). */
  charging?: boolean;
  /**
   * A charge was sent and its answer was lost or ambiguous. Money may have
   * moved: no further charge for this step until a person or the webhook says.
   */
  unresolved?: boolean;
}

interface OrderRecord {
  orderId: string;
  /** YOUR customer reference, sent as `buyerId` on the session and every charge. */
  buyerId: string;
  sessionId: string;
  /** The words shown at the button. */
  termsShown: string;
  /** When this server first received the charge request (server clock). */
  chargeRequestedAt?: string;
  /** The saved card (`vp_pmt_*`), once the main charge used it. */
  tokenId?: string;
  /**
   * What the checkout recorded on the saved card (`setupForFutureUse`).
   * Undefined = not read yet, or the read failed (read again next time).
   */
  savedFor?: "off_session" | "on_session" | null;
  main: ChargeState;
  addOn: ChargeState;
}

type Outcome =
  | "paid" // money captured
  | "held" // authorised, not captured: capture or void it; do not fulfil yet
  | "pending" // started, result not final: read again later
  | "requires_action" // the bank wants a 3-D Secure check
  | "failed" // declined, voided or cancelled: nothing to fulfil
  | "not_paid"; // nothing has been charged for this step

export function outcomeForIntent(status: PaymentIntentStatus): Outcome {
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
    case "cancelled":
      return "failed";
  }
}

/**
 * The intent fields that are safe to hand the shopper's browser: the code
 * only, never the API's own wording (the page shows its own fixed text). A
 * refusal by one of YOUR rules (`blocked_by_rule`) reads as a plain decline,
 * so a card tester cannot map your rules from the answers.
 */
function browserView(intent: PaymentIntent | PaymentIntentRead) {
  const declineCode = "declineCode" in intent ? (intent.declineCode ?? null) : null;
  return {
    intent_id: intent.id,
    status: intent.status,
    outcome: outcomeForIntent(intent.status),
    decline_code: declineCode === "blocked_by_rule" ? "card_declined" : declineCode,
    // Forwarded as-is: `vora.redirectToChallenge()` accepts the SDK's shape
    // and checks the address itself before it navigates.
    next_action: intent.status === "requires_action" ? (intent.nextAction ?? null) : null,
  };
}

/**
 * An answered refusal moved no money: a 4xx that is not "reconcile", and not
 * 408 (request timeout) or 499 (connection closed), which say nothing about
 * whether the charge ran. Anything else may have moved money: a 5xx, a
 * redirect, a timeout, a dropped connection.
 */
function answeredRefusal(err: unknown): boolean {
  return (
    err instanceof VonPayError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 408 &&
    err.status !== 499 &&
    err.nextAction !== "reconcile"
  );
}

function sendError(res: Response, label: string, err: unknown): void {
  if (err instanceof VonPayError) {
    // Log the machine-readable fields only: never the request or the token.
    // eslint-disable-next-line no-console
    console.error(`[funnel-one-click] ${label}`, {
      code: err.code,
      status: err.status,
      requestId: err.requestId,
      nextAction: err.nextAction,
    });
    const answered = answeredRefusal(err);
    res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
      // A fixed message plus the code: the API's own wording stays in your logs.
      error: answered ? "The payment was not accepted." : "The result of this payment is not known yet.",
      code: err.code,
      // ⛔ The page must not say "failed" or offer to pay again until it has
      // read the outcome.
      outcome_unknown: !answered,
    });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(`[funnel-one-click] ${label}`, err instanceof Error ? err.message : String(err));
  res.status(502).json({ error: "The result of this payment is not known yet.", outcome_unknown: true });
}

const TOKEN_SHAPE = /^vp_pmt_(test|live)_[A-Za-z0-9_-]+$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function createApp({
  client,
  returnUrl,
  publishableKey,
  browserApiBase,
  storedCredentialUse,
  terms = DEFAULT_TERMS,
  persistConsentRecord = logConsentRecord,
  secureCookies = process.env.NODE_ENV === "production",
  trustProxy = false,
  maxOrders = 10_000,
}: AppDeps): Express {
  const app = express();
  app.set("trust proxy", trustProxy);
  // Against clickjacking: no other site may frame this page (a framed order
  // button can be clicked by a shopper who cannot see it). Not a script policy.
  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
  app.use(express.json({ limit: "8kb" }));

  const termsId = termsVersion(terms);
  const orders = new Map<string, OrderRecord>();

  function readOrder(req: Request): OrderRecord | undefined {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name !== COOKIE) continue;
      try {
        return orders.get(decodeURIComponent(rest.join("=")));
      } catch {
        // A malformed cookie (`%E0%A4%A`) is "no order", never a crash.
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * Run one charge for one step of the order, at most once.
   *
   * ⛔ ONE LIVE CHARGE PER STEP, enforced here. The idempotency key protects a
   * retry of the same request; this guard also refuses a second press while a
   * charge is in flight, after its answer was lost, or after it did not fail.
   */
  async function chargeOnce(
    res: Response,
    step: ChargeState,
    label: string,
    create: () => Promise<PaymentIntent>,
    afterCharge?: (intent: PaymentIntent) => Promise<Record<string, unknown>>,
  ): Promise<void> {
    if (client === null) {
      res.status(500).json({ error: NO_KEY_ERROR });
      return;
    }
    if (step.charging === true || step.unresolved === true) {
      res.status(409).json({
        error: "A payment for this step is in progress or its result is not known yet.",
        code: "funnel_charge_unresolved",
        outcome_unknown: true,
      });
      return;
    }
    step.charging = true;
    try {
      if (step.intentId !== undefined) {
        let previous: PaymentIntentRead;
        try {
          previous = await client.paymentIntents.retrieve(step.intentId);
        } catch (err) {
          sendError(res, `${label}: previous-charge read failed`, err);
          return;
        }
        if (outcomeForIntent(previous.status) !== "failed") {
          res.status(409).json({
            error: "This step already has a payment that did not fail.",
            code: "funnel_already_charged",
            outcome_unknown: true,
          });
          return;
        }
      }

      let intent: PaymentIntent;
      try {
        intent = await create();
      } catch (err) {
        if (!answeredRefusal(err)) step.unresolved = true;
        sendError(res, `${label} failed`, err);
        return;
      }
      step.intentId = intent.id;
      const extra = afterCharge ? await afterCharge(intent) : {};
      res.status(201).json({ ...browserView(intent), ...extra });
    } finally {
      // Cleared on EVERY exit, or the step would stay locked for good.
      step.charging = false;
    }
  }

  /**
   * What the checkout recorded on the saved card. Read on the SERVER, never
   * taken from the browser: it decides whether the add-on can be offered.
   * Only a definite answer is kept; a failed read is tried again next time.
   */
  async function readSavedFor(order: OrderRecord): Promise<void> {
    if (client === null || order.tokenId === undefined) return;
    try {
      const list = await client.paymentMethods.list({ buyerId: order.buyerId, limit: 100 });
      const v = list.data.find((pm) => pm.id === order.tokenId)?.setupForFutureUse;
      order.savedFor = v === "off_session" || v === "on_session" ? v : null;
    } catch (err) {
      // Unknown is not "saved": offer no add-on now, ask again on the next read.
      // eslint-disable-next-line no-console
      console.error("[funnel-one-click] saved-card read failed", err instanceof VonPayError ? err.code : String(err));
    }
  }

  function addOnOffer(order: OrderRecord) {
    // The add-on is offered only when the main payment is paid and the card is
    // saved for reuse. A card saved for no reuse cannot be charged a second time.
    return order.savedFor === "off_session" || order.savedFor === "on_session"
      ? { id: ADD_ON_OFFER.id, name: ADD_ON_OFFER.name, amount_minor: ADD_ON_OFFER.amountMinor, currency: CURRENCY }
      : null;
  }

  app.get("/api/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  /** Public, browser-safe settings for the page. */
  app.get("/api/config", (_req, res) => {
    res.json({
      publishable_key: publishableKey,
      ...(browserApiBase ? { api_base: browserApiBase } : {}),
    });
  });

  /**
   * Open an order. The order record exists BEFORE any charge (funnel stores
   * work this way), then an Elements session that only SAVES the card:
   * `chargeAtSubmit` stays false, so this server makes the first charge.
   *
   * ⚠ Rate-limit this route too before going live: each call creates a
   * session with your secret key, and card testers start here.
   */
  app.post("/api/order", async (req: Request, res: Response) => {
    if (client === null) return res.status(500).json({ error: NO_KEY_ERROR });
    const orderId = `ord_${randomUUID()}`;
    const buyerId = `cus_${randomUUID()}`;
    try {
      const session = await client.sessions.create({
        amount: MAIN_OFFER.amountMinor,
        currency: CURRENCY,
        integrationMode: "elements",
        chargeAtSubmit: false,
        // The card is saved to THIS customer, and every charge names it.
        buyerId,
        ...(storedCredentialUse !== undefined ? { storedCredentialUse } : {}),
        // Which wording this order was offered under, next to the order id.
        metadata: { sample: "funnel-one-click", order_id: orderId, terms_version: termsId },
      });
      const cookieId = randomUUID();
      // Capped: the oldest order goes first (a Map keeps insertion order).
      while (orders.size >= maxOrders) {
        const oldest = orders.keys().next().value;
        if (oldest === undefined) break;
        orders.delete(oldest);
      }
      orders.set(cookieId, { orderId, buyerId, sessionId: session.id, termsShown: terms, main: {}, addOn: {} });
      // httpOnly: page scripts cannot read it. sameSite "lax": the bank's
      // redirect back (a cross-site top-level GET) carries it; a cross-site
      // POST does not. Secure over HTTPS, and always in production.
      res.cookie(COOKIE, cookieId, { httpOnly: true, sameSite: "lax", secure: req.secure || secureCookies, path: "/" });
      return res.status(201).json({
        order_id: orderId,
        session_id: session.id,
        terms,
        terms_version: termsId,
        offer: { name: MAIN_OFFER.name, amount_minor: MAIN_OFFER.amountMinor, currency: CURRENCY },
      });
    } catch (err) {
      return sendError(res, "order/session create failed", err);
    }
  });

  /**
   * Charge the main offer on the card the page just saved.
   *
   * ⚠ Before deploying a route like this, rate-limit it and put bot /
   * card-testing protection in front of it: it moves money with your secret
   * key on every call. This dev stub has neither.
   */
  app.post("/api/charge", async (req: Request, res: Response) => {
    if (client === null) return res.status(500).json({ error: NO_KEY_ERROR });
    const order = readOrder(req);
    if (order === undefined) return res.status(409).json({ error: "No order for this browser. Reload the page." });
    const token: unknown = req.body?.token;
    if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) {
      return res.status(400).json({ error: "token is required: pass the vp_pmt_* that submit() returned." });
    }
    const pressed: unknown = req.body?.pressed_at;
    order.chargeRequestedAt ??= new Date().toISOString();
    // No record, no charge: the record is your evidence of what the shopper agreed to.
    try {
      await persistConsentRecord({
        orderId: order.orderId,
        buyerId: order.buyerId,
        sessionId: order.sessionId,
        termsShown: order.termsShown,
        termsVersion: termsId,
        chargeRequestedAt: order.chargeRequestedAt,
        pressedAtReported: typeof pressed === "string" && ISO_TIME.test(pressed) ? pressed : null,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[funnel-one-click] consent record failed", err instanceof Error ? err.message : String(err));
      return res.status(500).json({ error: "The order could not be recorded. Nothing was charged.", code: "funnel_consent_not_recorded" });
    }
    await chargeOnce(
      res,
      order.main,
      "main charge",
      () => {
        order.tokenId = token;
        return client.paymentIntents.create(
          {
            amount: MAIN_OFFER.amountMinor,
            currency: CURRENCY,
            paymentMethod: { id: token },
            // ⛔ Send on EVERY charge of a saved card: the API refuses the card
            // when it was saved for a different customer.
            buyerId: order.buyerId,
            // Refuses this charge if the session somehow charged at submit.
            sessionId: order.sessionId,
            returnUrl,
            metadata: { sample: "funnel-one-click", order_id: order.orderId, step: "main" },
          },
          // One key per charge decision, reused verbatim on a retry. A new card
          // is a new token, so a new key.
          { idempotencyKey: `funnel:${order.orderId}:main:${token}` },
        );
      },
      async (intent) => {
        // Offer the add-on only on a PAID main order. After a 3-D Secure
        // check, GET /api/outcome makes the offer instead.
        if (outcomeForIntent(intent.status) !== "paid") return { add_on_offer: null };
        await readSavedFor(order);
        return { saved_for: order.savedFor ?? null, add_on_offer: addOnOffer(order) };
      },
    );
    return undefined;
  });

  /**
   * The one-click add-on: the SAME saved card, while the shopper is on the
   * page. No `mit` block: the shopper is present and pressed the button, so
   * this is not a merchant-initiated charge.
   *
   * ⚠ Any script running on the page can call this route; see the README
   * ("Who can press the add-on button?").
   */
  app.post("/api/add-on", async (req: Request, res: Response) => {
    const order = readOrder(req);
    if (order === undefined) return res.status(409).json({ error: "No order for this browser. Reload the page." });
    if (req.body?.offer_id !== ADD_ON_OFFER.id) return res.status(400).json({ error: "Unknown offer." });
    if (order.main.intentId === undefined || order.tokenId === undefined) {
      return res.status(409).json({ error: "The main order is not paid yet.", code: "funnel_main_not_paid" });
    }
    if (client === null) return res.status(500).json({ error: NO_KEY_ERROR });
    try {
      const main = await client.paymentIntents.retrieve(order.main.intentId);
      if (outcomeForIntent(main.status) !== "paid") {
        return res.status(409).json({ error: "The main order is not paid yet.", code: "funnel_main_not_paid" });
      }
    } catch (err) {
      return sendError(res, "main-charge read failed", err);
    }
    if (order.savedFor === undefined) await readSavedFor(order);
    if (addOnOffer(order) === null) {
      return res.status(409).json({
        error: "This card was not saved for reuse, so the add-on needs the card again.",
        code: "funnel_card_not_reusable",
      });
    }
    const tokenId = order.tokenId;
    await chargeOnce(res, order.addOn, "add-on charge", () =>
      client.paymentIntents.create(
        {
          amount: ADD_ON_OFFER.amountMinor,
          currency: CURRENCY,
          paymentMethod: { id: tokenId },
          buyerId: order.buyerId,
          returnUrl,
          metadata: { sample: "funnel-one-click", order_id: order.orderId, step: "add_on", offer: ADD_ON_OFFER.id },
        },
        // One key per PURCHASE DECISION (this order, this offer): a double
        // press or a retried request can never charge the add-on twice.
        // ⚠ The same key also means a DECLINED add-on cannot be retried: the
        // API answers the first result again. A second try (another card, a
        // later moment) is a new purchase decision and needs a new key.
        { idempotencyKey: `funnel:${order.orderId}:add-on:${ADD_ON_OFFER.id}` },
      ),
    );
    return undefined;
  });

  /**
   * The server's own read of both steps, for the page after a 3-D Secure
   * return. The query string the bank appends is never read: anyone can type it.
   * Fulfil from the `payment_intent.succeeded` webhook (see samples/webhooks-node),
   * never from a page.
   */
  app.get("/api/outcome", async (req: Request, res: Response) => {
    if (client === null) return res.status(500).json({ error: NO_KEY_ERROR });
    const order = readOrder(req);
    if (order === undefined) return res.status(404).json({ error: "No order for this browser (the server may have restarted)." });
    try {
      const read = async (step: ChargeState) => {
        if (step.intentId === undefined) return { outcome: step.unresolved ? "pending" : "not_paid" };
        const view = browserView(await client.paymentIntents.retrieve(step.intentId));
        // A later attempt whose answer was lost: never report the earlier decline as its result.
        return step.unresolved ? { ...view, outcome: "pending", decline_code: null, next_action: null } : view;
      };
      const main = await read(order.main);
      if (main.outcome === "paid" && order.savedFor === undefined) await readSavedFor(order);
      return res.json({
        order_id: order.orderId,
        main,
        add_on: await read(order.addOn),
        add_on_offer: main.outcome === "paid" ? addOnOffer(order) : null,
      });
    } catch (err) {
      return sendError(res, "outcome read failed", err);
    }
  });

  return app;
}
