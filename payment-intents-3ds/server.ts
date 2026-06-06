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
 * Verified against @vonpay/checkout-node@0.9.1 + the Payment Intents 3DS docs.
 * See the README for the two SDK-vs-docs gaps this sample works around
 * (`paymentMethod` is not yet on the typed CreatePaymentIntentParams, and
 * `PaymentIntent.nextAction` is typed `string | null` while the wire payload
 * is the `{ type, redirect_to_url }` object).
 */
import express, { type Request, type Response } from "express";
import {
  VonPayCheckout,
  VonPayError,
  type CreatePaymentIntentParams,
  type PaymentIntent,
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

// ─── Type bridges for two documented-but-not-yet-typed wire shapes ───────
//
// 1. `payment_method` + `return_url` are documented request fields on
//    POST /v1/payment_intents (see the Payment Intents guide), but the 0.9.1
//    typed `CreatePaymentIntentParams` does not include them yet. The SDK's
//    `paymentIntents.create` deep-converts every param to snake_case and
//    forwards it, so passing them through works at runtime — we widen the
//    param type locally and narrow back at the call boundary.
interface ChargeParams extends CreatePaymentIntentParams {
  /** vp_pmt_* token from POST /v1/tokens (or VORA Mirror's submit()). */
  paymentMethod: { id: string };
  /** Absolute URL the issuer challenge returns the buyer to. */
  returnUrl: string;
}

// 2. `PaymentIntent.nextAction` is typed `string | null` in 0.9.1, but on a
//    `requires_action` response the runtime value is the structured object
//    below. The API wire shape is `{ type, redirect_to_url: { url } }`, but the
//    SDK camelCases every response key (except `metadata`) before returning —
//    so the runtime field is `redirectToUrl`, NOT `redirect_to_url`. The `type`
//    is a string VALUE (not a key) so it stays `"redirect_to_url"`. We read the
//    runtime value defensively and branch on `type` so a future action type
//    can't silently break the redirect.
interface RedirectToUrlAction {
  type: "redirect_to_url";
  // SDK-camelCased key (wire is `redirect_to_url`).
  redirectToUrl: { url: string };
}

function extractRedirectUrl(intent: PaymentIntent): string | null {
  // The typed field is `string | null`; the live shape is an object. Treat the
  // runtime value as unknown and validate before trusting it.
  const action = intent.nextAction as unknown;
  if (
    action !== null &&
    typeof action === "object" &&
    (action as RedirectToUrlAction).type === "redirect_to_url"
  ) {
    const url = (action as RedirectToUrlAction).redirectToUrl?.url;
    // The URL comes from a trusted source (the API), but we still validate the
    // scheme before handing it to res.redirect — never redirect a browser to a
    // javascript:/data: URL even if a response were ever malformed.
    if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
  }
  return null;
}

// ─── Express app ────────────────────────────────────────────────────────
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

  const amount =
    typeof body.amount === "number" && Number.isInteger(body.amount) && body.amount > 0
      ? body.amount
      : 4999; // minor units → $49.99

  const orderId = `ord_${Date.now().toString(36)}`;

  const chargeParams: ChargeParams = {
    amount,
    currency: "USD",
    captureMethod: "manual",
    paymentMethod: { id: paymentMethodId },
    returnUrl,
    metadata: { order_id: orderId, sample: "payment-intents-3ds" },
  };

  let intent: PaymentIntent;
  try {
    intent = await vonpay.paymentIntents.create(
      // Narrow the widened params back to the SDK's type at the boundary. The
      // extra fields ride through the SDK's snake_case forwarding (see the
      // ChargeParams note above).
      chargeParams as CreatePaymentIntentParams,
      { idempotencyKey: `${orderId}:authorize` },
    );
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
      // Declined before any challenge. `declineCode` is a generic reason.
      res.status(402).json({
        outcome: "failed",
        intentId: intent.id,
        declineCode: intent.declineCode,
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
// typed WebhookEvent union (session.* / refund.created), which is shaped for
// the hosted-checkout family. The discrete-lifecycle `payment_intent.*` events
// use a DIFFERENT payload shape — discriminator `type`, body nested under
// `data`, decline reason at `data.failure_reason` — and are not in the SDK's
// typed union in 0.9.1. So we verify with constructEvent, then read the
// payment_intent.* shape off a parallel parse of the same raw bytes. The HMAC
// check is unchanged; only the TypeScript type is widened.
interface PaymentIntentEvent {
  /** Webhook event id (vp_evt_*) — use this to dedupe redeliveries. */
  id?: string;
  /** Discriminator: "payment_intent.succeeded" | ".failed" | ".cancelled" | … */
  type?: string;
  merchant_id?: string;
  data?: {
    session_id?: string | null;
    transaction_id?: string;
    amount?: number;
    currency?: string;
    /** Present on payment_intent.failed — generic reason (e.g. card_declined). */
    failure_reason?: string;
  };
}

app.post("/webhooks", (req: Request, res: Response): void => {
  const signature = req.headers["x-vonpay-signature"];
  if (typeof signature !== "string") {
    res.status(400).json({ error: "Missing x-vonpay-signature header" });
    return;
  }

  try {
    // Verify signature + replay window (throws on failure). We discard the
    // typed return value here because the payment_intent.* family is shaped
    // differently from the SDK's union — we re-read it below.
    vonpay.webhooks.constructEvent(req.body as Buffer, signature, webhookSecret);
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

  // Signature is verified — now read the event payload in its real shape.
  let event: PaymentIntentEvent;
  try {
    const raw = (req.body as Buffer).toString("utf8");
    event = JSON.parse(raw) as PaymentIntentEvent;
  } catch {
    // Verified-but-unparseable body should never happen. Ack so we don't loop.
    res.status(200).json({ received: true });
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
        transactionId: event.data?.transaction_id,
        msg: "fulfill_order",
      });
      break;
    case "payment_intent.failed":
      // 3DS challenge rejected, or the charge declined. Do NOT fulfill.
      console.log({
        route: "/webhooks",
        type: event.type,
        eventId: event.id,
        transactionId: event.data?.transaction_id,
        failureReason: event.data?.failure_reason,
        msg: "do_not_fulfill",
      });
      break;
    default:
      // Forward-compatible: ack unknown events so they aren't redelivered. New
      // event types can ship without an SDK bump — never 5xx one you don't know.
      // This includes session.* / refund.created (handled in other samples) and
      // payment_intent.cancelled.
      console.log({
        route: "/webhooks",
        msg: "event_ignored",
        type: event.type ?? "(none)",
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
