/**
 * Server-side 3D Secure (3DS / SCA) handling for the Payment Intents API.
 *
 * This is the SERVER-DRIVEN path. The buyer's bank decides whether to
 * challenge — you don't. When it does, the payment intent comes back with
 * `status: "requires_action"` and a `next_action` that points at the issuer's
 * challenge page. The only correct move is a TOP-LEVEL browser redirect to that
 * URL (banks block their challenge inside an iframe). After the challenge, the
 * terminal outcome is confirmed by a `payment_intent.succeeded` /
 * `payment_intent.failed` webhook — never by the buyer's browser.
 *
 * Flow demonstrated:
 *   POST /charge       Create a manual-capture intent with a vp_pmt_* token.
 *                      Branch on status:
 *                        requires_action → redirect the buyer to the 3DS URL
 *                        authorized      → no challenge; capture immediately
 *                        failed          → surface the decline
 *   GET  /3ds/return   Where the issuer sends the buyer back. UX only — the
 *                      real outcome arrives on the webhook.
 *   POST /webhooks     Verify the signature, then act on payment_intent.* to
 *                      confirm the post-challenge terminal state.
 *
 * Written against @vonpay/checkout-node 2.x — 2.5.0 or later, which is the
 * first release that types `returnUrl` on `paymentIntents.create`. Every field
 * this sample sends and reads is on the SDK's typed surface: no casts, no local
 * type bridges.
 */
import express, { type Request, type Response } from "express";
import {
  VonPayCheckout,
  VonPayError,
  type CreatePaymentIntentParams,
  type PaymentIntent,
  type WebhookEvent,
} from "@vonpay/checkout-node";

// ─── Config ─────────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT ?? "3000", 10);

const apiKey = process.env.VON_PAY_SECRET_KEY;
if (!apiKey) {
  console.error(
    "VON_PAY_SECRET_KEY is required. Copy .env.example to .env and paste your sandbox key.",
  );
  process.exit(2);
}

// Per-endpoint webhook signing secret (whsec_…), shown ONCE when you create the
// webhook endpoint in the dashboard. This is NOT your API key — verifying with
// the API key will fail against real deliveries.
const webhookSecret = process.env.VON_PAY_WEBHOOK_SECRET;
if (!webhookSecret) {
  console.error(
    "VON_PAY_WEBHOOK_SECRET is required (whsec_…). Copy .env.example to .env and fill it in.",
  );
  process.exit(2);
}

const baseUrl =
  process.env.VON_PAY_BASE_URL?.replace(/\/+$/, "") ??
  "https://checkout.vonpay.com";

// Where the issuer's challenge page sends the buyer back. Must be a real,
// reachable URL on YOUR site. Forwarded to the API as `return_url`.
const returnUrl =
  process.env.VON_PAY_RETURN_URL?.replace(/\/+$/, "") ??
  `http://localhost:${port}/3ds/return`;

const vonpay = new VonPayCheckout({ apiKey, baseUrl });

// ─── Reading the 3DS redirect off the intent ──────────────────────────────
//
// On `requires_action`, `intent.nextAction` is a `PaymentIntentNextAction`.
// The API wire shape is `{ type, redirect_to_url: { url } }`, but the SDK
// camelCases every response KEY (except `metadata`) — so read
// `nextAction.redirectToUrl.url`, NOT `redirect_to_url.url` (which is
// `undefined`). The `type` is a string VALUE, not a key, so it stays
// `"redirect_to_url"`. We branch on `type` so a future action type can't
// silently break the redirect.
//
// ⚠️ Capture it from THIS response. `nextAction` is returned only on the call
// that creates the payment; it is not persisted, so a later read or an
// idempotent replay will not carry it.
function extractRedirectUrl(intent: PaymentIntent): string | null {
  const action = intent.nextAction;
  if (action?.type !== "redirect_to_url") return null;
  const url = action.redirectToUrl?.url;
  // The URL comes from a trusted source (the API), but we still validate the
  // scheme before handing it to res.redirect — never redirect a browser to a
  // javascript:/data: URL even if a response were ever malformed.
  if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
  return null;
}

// ─── Express app ────────────────────────────────────────────────────────
// ⛔ Fixed demo amount. A real integration sources this from the cart —
// SERVER-SIDE.
//
// This was read off the request body with a bound:
//
//     typeof body.amount === "number" && Number.isInteger(body.amount) && body.amount > 0
//       ? body.amount : 4999
//
// ⚠ A BOUND IS NOT A PRICE CONTROL, and this one reads as though it were.
// Positive, integer, a number — every value that passes is still a number the
// BUYER chose, so `curl -d '{"amount":1}'` charges one cent for the $49.99 item.
// The check only narrows WHICH wrong price an attacker can pick.
//
// The only correct shape is that the browser cannot influence the amount at all.
// The three sibling samples in this repo already do it this way.
const AMOUNT_MINOR = 4999; // $49.99
const CURRENCY = "USD";

const app = express();

// Webhook signature verification is byte-for-byte over the RAW body, so mount
// express.raw() ON THE WEBHOOK ROUTE ONLY, above the generic JSON parser. Every
// other route still gets parsed JSON.
app.use("/webhooks", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json());

// ─── Create + 3DS branch ─────────────────────────────────────────────────
// POST /charge  { paymentMethod?: string, amount?: number }
//
// We use capture_method: "manual" so a 3DS success lands on `authorized`
// (auth held, not captured) and we capture explicitly. With
// capture_method: "automatic" the same flow collapses straight to `succeeded`.
app.post("/charge", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as { paymentMethod?: unknown; amount?: unknown };

  // In a real app this token comes from POST /v1/tokens (or VORA Mirror's
  // tokenize/submit) on the front end. The sandbox 3DS-challenge token below
  // is documented in the Test Cards reference — it deterministically returns
  // `requires_action` then settles to `succeeded` after the challenge.
  const paymentMethodId =
    typeof body.paymentMethod === "string" && body.paymentMethod.length > 0
      ? body.paymentMethod
      : "vp_pmt_test_3ds_success_sample";

  const orderId = `ord_${Date.now().toString(36)}`;

  const chargeParams: CreatePaymentIntentParams = {
    amount: AMOUNT_MINOR,
    currency: CURRENCY,
    captureMethod: "manual",
    paymentMethod: { id: paymentMethodId },
    returnUrl,
    metadata: { order_id: orderId, sample: "payment-intents-3ds" },
  };

  let intent: PaymentIntent;
  try {
    intent = await vonpay.paymentIntents.create(chargeParams, {
      idempotencyKey: `${orderId}:authorize`,
    });
  } catch (err) {
    logVonPayError("charge.create", err);
    res.status(502).json({ error: "Could not create payment intent" });
    return;
  }

  switch (intent.status) {
    case "requires_action": {
      // 3DS / SCA: the bank wants to challenge the buyer. Redirect at the TOP
      // LEVEL of the browser — never inside an iframe (banks frame-bust).
      const url = extractRedirectUrl(intent);
      if (!url) {
        // requires_action with no usable redirect we recognize. Fail safe.
        console.error({
          route: "/charge",
          msg: "requires_action_without_known_redirect",
          intentId: intent.id,
        });
        res
          .status(502)
          .json({ error: "Authentication required but no supported next_action" });
        return;
      }
      console.log({
        route: "/charge",
        msg: "redirecting_to_3ds_challenge",
        intentId: intent.id,
        orderId,
      });
      // 303 so the browser does a GET to the challenge page.
      res.redirect(303, url);
      return;
    }

    case "authorized": {
      // No challenge required. Funds are held — capture to settle.
      try {
        const captured = await vonpay.paymentIntents.capture(intent.id, undefined, {
          idempotencyKey: `${orderId}:capture`,
        });
        res.json({
          outcome: "captured",
          intentId: captured.id,
          status: captured.status,
          amount: captured.amount,
          currency: captured.currency,
        });
      } catch (err) {
        logVonPayError("charge.capture", err);
        res.status(502).json({ error: "Authorized but capture failed" });
      }
      return;
    }

    case "failed": {
      // Declined before any challenge.
      //
      // ⛔ `declineCode` IS NOT UNCONDITIONALLY BROWSER-SAFE, and this sample
      // used to relay it raw. When it is `blocked_by_rule` it means one of YOUR
      // OWN rules refused the charge, not the cardholder's bank — and anyone
      // holding your publishable key could then iterate cards and map which
      // brands, ranges or countries your rules refuse, in order to route around
      // them. The buyer's next step is identical either way: a different card.
      //
      // So substitute the generic value for that one case. Everything else is
      // safe to pass through, and `declineMessage` (SDK 2.1.0+) gives you
      // buyer-ready copy under the same rule.
      const browserSafeDeclineCode =
        intent.declineCode === "blocked_by_rule" ? "card_declined" : intent.declineCode;

      res.status(402).json({
        outcome: "failed",
        intentId: intent.id,
        declineCode: browserSafeDeclineCode,
      });
      return;
    }

    default: {
      // succeeded / voided are unexpected for a manual-capture create — surface
      // them rather than guessing.
      res.json({
        outcome: "unexpected_status",
        intentId: intent.id,
        status: intent.status,
      });
    }
  }
});

// ─── 3DS return landing ───────────────────────────────────────────────────
// The issuer sends the buyer back here after the challenge. This is a UX
// signal ONLY — the authoritative outcome arrives on the webhook below. Do not
// fulfill from this handler. In a real app you would look the order up by the
// returned reference and show "we're confirming your payment" until the webhook
// flips it terminal.
app.get("/3ds/return", (req: Request, res: Response): void => {
  const params = req.query as Record<string, string | undefined>;
  res.type("html").send(
    [
      "<h1>Authentication complete</h1>",
      "<p>Your bank has finished the security check. We're confirming the",
      "payment now — your order updates as soon as we receive the result.</p>",
      `<p>Reference: ${escapeHtml(params.payment_intent ?? params.id ?? "(none)")}</p>`,
      "<p><em>This page is a UX hint. The real outcome is verified server-side",
      "from the payment_intent.succeeded / payment_intent.failed webhook.</em></p>",
    ].join("\n"),
  );
});

// ─── Webhook receiver — confirms the post-3DS terminal state ──────────────
// Header:  x-vonpay-signature: t=<unix>,v1=<hex>  (timestamp is INSIDE the
//          header; there is no separate timestamp header)
// Secret:  the per-endpoint whsec_* signing secret (NOT your API key)
//
// `constructEvent` verifies the signature + replay window and throws on any
// failure (the verification gate this sample relies on). It returns the SDK's
// typed `WebhookEvent` union, which includes the `payment_intent.*` family:
// discriminator `type`, body nested under `data`, decline reason at
// `data.failure_reason`. Switching on `event.type` narrows `event.data`.
app.post("/webhooks", (req: Request, res: Response): void => {
  const signature = req.headers["x-vonpay-signature"];
  if (typeof signature !== "string") {
    res.status(400).json({ error: "Missing x-vonpay-signature header" });
    return;
  }

  let event: WebhookEvent;
  try {
    // Verify signature + replay window (throws on failure).
    event = vonpay.webhooks.constructEvent(req.body as Buffer, signature, webhookSecret);
  } catch (err) {
    // 400 (not 200) so the delivery engine retries. Log only err.message — the
    // full error object can carry signature/HMAC bytes in its diagnostic
    // fields, which must never reach stdout.
    console.warn({
      route: "/webhooks",
      msg: "signature_verification_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  switch (event.type) {
    case "payment_intent.succeeded":
      // 3DS passed (or no challenge was needed) and funds settled. THIS is the
      // signal to fulfill — not the /3ds/return page. Look the order up by
      // event.data.transaction_id (and dedupe on event.id) and mark it paid.
      console.log({
        route: "/webhooks",
        type: event.type,
        eventId: event.id,
        transactionId: event.data.transaction_id,
        msg: "fulfill_order",
      });
      break;
    case "payment_intent.failed":
      // 3DS challenge rejected, or the charge declined. Do NOT fulfill.
      console.log({
        route: "/webhooks",
        type: event.type,
        eventId: event.id,
        transactionId: event.data.transaction_id,
        failureReason: event.data.failure_reason,
        msg: "do_not_fulfill",
      });
      break;
    default:
      // Forward-compatible: ack unknown events so they aren't redelivered. New
      // event types can ship without an SDK bump — never 5xx one you don't know.
      // This includes charge.* / refund.* (handled in other samples) and
      // payment_intent.cancelled.
      console.log({
        route: "/webhooks",
        msg: "event_ignored",
        type: event.type,
      });
  }

  res.status(200).json({ received: true });
});

// ─── Health + index ───────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    const health = await vonpay.health();
    res.json(health);
  } catch (err) {
    console.error(
      "Health check failed:",
      err instanceof Error ? err.message : String(err),
    );
    res.status(503).json({ status: "unreachable" });
  }
});

app.get("/", (_req, res) => {
  res.type("html").send(
    [
      "<h1>Von Payments — Payment Intents 3DS sample</h1>",
      "<p>Click pay to create a manual-capture intent with a sandbox 3DS",
      "challenge token. The server redirects you to the issuer challenge,",
      "then confirms the outcome from the webhook.</p>",
      '<form action="/charge" method="POST">',
      "  <button type=\"submit\">Pay $49.99 (3DS challenge)</button>",
      "</form>",
      "<p>POST /charge — create intent, redirect to 3DS on requires_action</p>",
      "<p>GET  /3ds/return — issuer challenge return (UX only)</p>",
      "<p>POST /webhooks — verifies x-vonpay-signature, confirms terminal state</p>",
    ].join("\n"),
  );
});

app.listen(port, () => {
  console.log({
    msg: "server_started",
    url: `http://localhost:${port}`,
    baseUrl,
    returnUrl,
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function logVonPayError(label: string, err: unknown): void {
  if (err instanceof VonPayError) {
    // VonPayError carries machine-readable code + status + requestId, plus
    // lifecycle extras (currentStatus / rejectReason) on 422 invalid_transition.
    console.error(`[${label}] VonPayError`, {
      code: err.code,
      status: err.status,
      requestId: err.requestId,
      currentStatus: err.currentStatus,
      rejectReason: err.rejectReason,
      message: err.message,
    });
    return;
  }
  console.error(`[${label}]`, err instanceof Error ? err.message : String(err));
}
