import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import { VonPayCheckout, type WebhookEvent } from "@vonpay/checkout-node";

// ─── Subscription-level event envelope ──────────────────────────────────
// Subscription webhooks (the whsec_* surface) share a fixed envelope with
// per-event `data` payloads. See:
// https://docs.vonpay.com/integration/webhook-events
type SubscriptionEventType =
  | "charge.succeeded"
  | "charge.failed"
  | "charge.refunded"
  | "payment_intent.succeeded"
  | "payment_intent.failed"
  | "payment_intent.cancelled"
  | "dispute.created"
  | "dispute.won"
  | "dispute.lost"
  | "application.approved"
  | "application.denied"
  | "merchant.ready_for_payments"
  | "payout.paid"
  | "payout.failed";

interface SubscriptionEventEnvelope {
  id: string; // vp_evt_*  — unique per outbound event, idempotency key
  type: SubscriptionEventType | string; // server may add new types without an SDK bump
  created: number; // unix seconds when the event was emitted
  livemode: boolean;
  merchant_id: string;
  data: Record<string, unknown>;
}

// ─── Config ─────────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT ?? "3000", 10);

const apiKey = process.env.VON_PAY_SECRET_KEY;
if (!apiKey) {
  console.error(
    "VON_PAY_SECRET_KEY is required. Copy .env.example to .env and fill it in.",
  );
  process.exit(1);
}

// WEBHOOK_SUBSCRIPTION_SECRET is optional — the /webhooks/session route works
// without it. If you only consume session-level webhooks (session.succeeded,
// refund.created, etc.) you can leave it blank. Provide it as `whsec_NEW` for
// a single secret, or `whsec_NEW,whsec_OLD` to keep an old secret live during
// rotation (the verifier accepts a match against EITHER).
const subscriptionSecretsRaw = process.env.WEBHOOK_SUBSCRIPTION_SECRET ?? "";
const subscriptionSecrets = subscriptionSecretsRaw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (subscriptionSecrets.length > 2) {
  console.error(
    "WEBHOOK_SUBSCRIPTION_SECRET accepts at most two comma-separated secrets (current + previous during rotation).",
  );
  process.exit(1);
}

const vonpay = new VonPayCheckout(apiKey);

// ─── In-memory idempotency guard ────────────────────────────────────────
// Production deployments MUST replace this with a durable store (Redis with
// TTL, a Postgres table with a UNIQUE index on event_id, or a Postgres
// advisory lock keyed on the event_id hash). An in-memory Set evaporates on
// process restart and does not deduplicate across instances behind a load
// balancer — both are exactly the conditions a retry storm exploits.
const handledEventIds = new Set<string>();
const HANDLED_EVENT_CAP = 10_000;

function markHandled(eventId: string): boolean {
  if (handledEventIds.has(eventId)) return false;
  if (handledEventIds.size >= HANDLED_EVENT_CAP) {
    // Drop the oldest entry. Set iteration order is insertion order in V8.
    const first = handledEventIds.values().next().value;
    if (first !== undefined) handledEventIds.delete(first);
  }
  handledEventIds.add(eventId);
  return true;
}

// ─── Subscription-level signature verification (whsec_*) ────────────────
// The subscription surface uses `x-vonpay-signature: t=<ts>,v1=<hmac>` with a
// per-subscription whsec_* secret. The HMAC is over `${t}.${raw_body}` so the
// timestamp is bound into the signature — re-using the body with a fresh
// timestamp will not validate.
//
// During a rotation grace window the header may carry TWO `v1=` entries. We
// accept if ANY of them matches ANY of our configured secrets.
//
// Replay window is asymmetric per spec:
//   - past:   reject if `now - t > 300`  (5 minutes)
//   - future: reject if `t - now > 30`   (30 seconds — receiver-clock skew only)
//
// Spec: https://docs.vonpay.com/integration/webhook-verification
const REPLAY_WINDOW_PAST_SEC = 300;
const REPLAY_WINDOW_FUTURE_SEC = 30;
const MAX_V1_ENTRIES = 2;

interface ParsedSignatureHeader {
  t: number;
  v1s: string[];
}

function parseSubscriptionSignatureHeader(
  header: string,
): ParsedSignatureHeader | null {
  if (!header) return null;
  const parts = header.split(",").map((p) => p.trim());

  const tPart = parts.find((p) => p.startsWith("t="));
  if (!tPart) return null;
  const tStr = tPart.slice(2);
  if (!/^\d+$/.test(tStr)) return null;
  const t = parseInt(tStr, 10);
  if (!Number.isFinite(t)) return null;

  const v1s = parts
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3));
  if (v1s.length === 0) return null;
  if (v1s.length > MAX_V1_ENTRIES) return null; // spec: reject >2 as malformed

  return { t, v1s };
}

function verifySubscriptionSignature(
  rawBody: Buffer,
  headerValue: string,
  secrets: string[],
): { ok: true } | { ok: false; reason: string } {
  if (secrets.length === 0) {
    return { ok: false, reason: "no_secret_configured" };
  }
  const parsed = parseSubscriptionSignatureHeader(headerValue);
  if (!parsed) return { ok: false, reason: "header_malformed" };

  const now = Math.floor(Date.now() / 1000);
  if (now - parsed.t > REPLAY_WINDOW_PAST_SEC) {
    return { ok: false, reason: "stale_timestamp" };
  }
  if (parsed.t - now > REPLAY_WINDOW_FUTURE_SEC) {
    return { ok: false, reason: "future_timestamp" };
  }

  // signed_payload = `${t}.${raw_body}`. HMAC the RAW bytes — never the
  // re-serialized JSON, since serializers normalize whitespace and key order
  // differently across languages and the byte stream would no longer match.
  const tPrefix = Buffer.from(`${parsed.t}.`, "utf8");
  const signedPayload = Buffer.concat([tPrefix, rawBody]);

  for (const secret of secrets) {
    const expectedHex = createHmac("sha256", secret)
      .update(signedPayload)
      .digest("hex");
    const expectedBuf = Buffer.from(expectedHex, "utf8");

    for (const candidate of parsed.v1s) {
      const candidateBuf = Buffer.from(candidate, "utf8");
      try {
        // timingSafeEqual REQUIRES equal-length buffers. A length mismatch
        // throws; we treat that as no-match and continue. Wrapping in
        // try/catch (vs. an `if (a.length !== b.length) return false`) keeps
        // the failure path constant-time — an early length check leaks one
        // bit of timing info per request.
        if (timingSafeEqual(candidateBuf, expectedBuf)) {
          return { ok: true };
        }
      } catch {
        // length mismatch — try next candidate
      }
    }
  }

  return { ok: false, reason: "no_v1_matched" };
}

// ─── Express app ────────────────────────────────────────────────────────
const app = express();

// IMPORTANT: webhook signature verification is byte-for-byte over the RAW
// request body. If `express.json()` (or any other body parser) runs first it
// will parse the buffer into an object and the original bytes are lost — the
// HMAC will not match.
//
// The fix is to mount `express.raw()` ON THE WEBHOOK ROUTES ONLY, ABOVE the
// generic JSON parser. Each route receives `req.body` as a Buffer, untouched.
// Any other route (health, anything you add later) still gets parsed JSON.
app.use(
  "/webhooks/session",
  express.raw({ type: "application/json", limit: "1mb" }),
);
app.use(
  "/webhooks/subscription",
  express.raw({ type: "application/json", limit: "1mb" }),
);
app.use(express.json());

// ─── Route 1: session-level webhooks ────────────────────────────────────
// Surface:   `X-VonPay-Signature: <hex-hmac>` header
// Secret:    your merchant API key (vp_sk_*) — there is no separate webhook
//            secret for this surface
// Events:    session.succeeded, session.failed, session.expired,
//            refund.created
//
// We lean on the SDK's `webhooks.constructEvent` here — it verifies the
// signature, enforces the ±5 min timestamp tolerance, and returns a typed
// WebhookEvent in one call. If you would rather hand-roll the HMAC, the
// pattern in /webhooks/subscription below shows it.
app.post("/webhooks/session", (req: Request, res: Response): void => {
  const signature = req.headers["x-vonpay-signature"];
  const timestamp = req.headers["x-vonpay-timestamp"];

  if (typeof signature !== "string" || typeof timestamp !== "string") {
    res.status(400).json({ error: "Missing signature headers" });
    return;
  }

  let event: WebhookEvent;
  try {
    event = vonpay.webhooks.constructEvent(
      req.body as Buffer, // raw body — express.raw made this a Buffer
      signature,
      apiKey, // session-level secret = merchant API key
      timestamp,
    );
  } catch (err) {
    // 400 (not 200) ONLY on signature/replay-window failure. Returning 200
    // here would tell Von Payments delivery the request was accepted and
    // suppress the legitimate retry an attacker just bypassed.
    console.warn({
      level: "warn",
      route: "/webhooks/session",
      msg: "signature_verification_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  // Idempotency guard. The session-level surface does not include a stable
  // outbound event id, so we de-dupe on `(event, sessionId)`. With the
  // subscription surface (next route) we use `event.id` which IS stable.
  const dedupeKey = `session:${event.event}:${event.sessionId}`;
  const isFirstDelivery = markHandled(dedupeKey);

  try {
    switch (event.event) {
      case "session.succeeded":
        console.log({
          level: "info",
          route: "/webhooks/session",
          event: event.event,
          sessionId: event.sessionId,
          merchantId: event.merchantId,
          transactionId: event.transactionId,
          amount: event.amount,
          currency: event.currency,
          replay: !isFirstDelivery,
        });
        // → fulfill order, send receipt, mark order paid in your DB
        break;
      case "session.failed":
        console.log({
          level: "info",
          route: "/webhooks/session",
          event: event.event,
          sessionId: event.sessionId,
          merchantId: event.merchantId,
          error: event.error,
          failureCode: event.failureCode,
          replay: !isFirstDelivery,
        });
        // → mark order failed, surface failureCode in the buyer UI
        break;
      case "session.expired":
        console.log({
          level: "info",
          route: "/webhooks/session",
          event: event.event,
          sessionId: event.sessionId,
          merchantId: event.merchantId,
          replay: !isFirstDelivery,
        });
        // → release reserved inventory, mark order abandoned
        break;
      case "refund.created":
        console.log({
          level: "info",
          route: "/webhooks/session",
          event: event.event,
          sessionId: event.sessionId,
          refundId: event.refundId,
          transactionId: event.transactionId,
          amount: event.amount,
          currency: event.currency,
          replay: !isFirstDelivery,
        });
        // → reverse fulfillment, post a credit memo, notify the buyer
        break;
      default:
        // Forward-compatible — unknown events are a no-op. The 200 below
        // tells Von Payments delivery the event was received; if our handler
        // was wrong, the alert + log above is what gets us paged, not a 5xx
        // that triggers redelivery.
        console.log({
          level: "info",
          route: "/webhooks/session",
          msg: "unknown_event_ignored",
          event: (event as { event: string }).event,
        });
    }
  } catch (handlerErr) {
    // We've already verified the signature. A bug in our own handler must
    // NOT trigger Von Payments to retry — we'd just hit the same bug again.
    // Log + alert + acknowledge. Real systems should fire a Sentry/Datadog
    // alert here so the on-call sees the failure even though we returned 200.
    console.error({
      level: "error",
      route: "/webhooks/session",
      msg: "handler_failed_after_verification",
      eventId: dedupeKey,
      error: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
    });
  }

  res.status(200).json({ received: true });
});

// ─── Route 2: subscription-level webhooks ───────────────────────────────
// Surface:   `x-vonpay-signature: t=<unix>,v1=<hmac>` header
// Secret:    per-subscription whsec_*
// Events:    full event catalog — payment_intent.*, charge.*, dispute.*,
//            payout.*, application.*, merchant.ready_for_payments
//
// The SDK does not (today) ship a constructEvent helper for this surface, so
// we verify the HMAC directly against the spec.
app.post("/webhooks/subscription", (req: Request, res: Response): void => {
  const headerValue = req.headers["x-vonpay-signature"];
  if (typeof headerValue !== "string") {
    res.status(400).json({ error: "Missing x-vonpay-signature header" });
    return;
  }

  const verdict = verifySubscriptionSignature(
    req.body as Buffer,
    headerValue,
    subscriptionSecrets,
  );
  if (!verdict.ok) {
    console.warn({
      level: "warn",
      route: "/webhooks/subscription",
      msg: "signature_verification_failed",
      reason: verdict.reason,
    });
    // 400 because the upstream MUST treat this as a failed delivery and
    // retry. Returning 200 on bad-sig requests would silently swallow real
    // attacks and silently swallow legitimate misconfigurations.
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  // Signature is valid — safe to parse the JSON envelope.
  let envelope: SubscriptionEventEnvelope;
  try {
    envelope = JSON.parse((req.body as Buffer).toString("utf8")) as SubscriptionEventEnvelope;
  } catch (parseErr) {
    console.error({
      level: "error",
      route: "/webhooks/subscription",
      msg: "json_parse_failed_after_signature_ok",
      error: parseErr instanceof Error ? parseErr.message : String(parseErr),
    });
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  // Idempotency guard. `id` is stable per outbound event — same body, same
  // signature, same id will be re-delivered if we 5xx, and we want exactly
  // one fulfillment side-effect per id even across retries.
  const isFirstDelivery = markHandled(`subscription:${envelope.id}`);

  try {
    switch (envelope.type) {
      case "payment_intent.succeeded":
      case "payment_intent.failed":
      case "payment_intent.cancelled":
        console.log({
          level: "info",
          route: "/webhooks/subscription",
          eventId: envelope.id,
          type: envelope.type,
          merchantId: envelope.merchant_id,
          paymentIntent: envelope.data.transaction_id,
          amount: envelope.data.amount,
          currency: envelope.data.currency,
          failureReason: envelope.data.failure_reason,
          livemode: envelope.livemode,
          replay: !isFirstDelivery,
        });
        // → reconcile the discrete-lifecycle payment intent against your
        //   order ledger; capture / void / refund decisions live elsewhere
        break;
      case "charge.succeeded":
      case "charge.failed":
      case "charge.refunded":
        console.log({
          level: "info",
          route: "/webhooks/subscription",
          eventId: envelope.id,
          type: envelope.type,
          merchantId: envelope.merchant_id,
          sessionId: envelope.data.session_id,
          transactionId: envelope.data.transaction_id,
          amount: envelope.data.amount ?? envelope.data.amount_refunded,
          currency: envelope.data.currency,
          failureReason: envelope.data.failure_reason,
          livemode: envelope.livemode,
          replay: !isFirstDelivery,
        });
        // → for charge.refunded, sum amount_refunded across deliveries to
        //   compute the cumulative refunded total per transaction_id
        break;
      case "dispute.created":
      case "dispute.won":
      case "dispute.lost":
        console.log({
          level: "info",
          route: "/webhooks/subscription",
          eventId: envelope.id,
          type: envelope.type,
          merchantId: envelope.merchant_id,
          disputeId: envelope.data.dispute_id,
          transactionId: envelope.data.transaction_id,
          amount: envelope.data.amount,
          currency: envelope.data.currency,
          livemode: envelope.livemode,
          replay: !isFirstDelivery,
        });
        // → page on-call within the 24-hour SLA for dispute.created;
        //   adjust merchant balance + notify on dispute.won / dispute.lost
        break;
      case "payout.paid":
      case "payout.failed":
        console.log({
          level: "info",
          route: "/webhooks/subscription",
          eventId: envelope.id,
          type: envelope.type,
          merchantId: envelope.merchant_id,
          payoutId: envelope.data.payout_id,
          amount: envelope.data.amount,
          currency: envelope.data.currency,
          failureReason: envelope.data.failure_reason,
          livemode: envelope.livemode,
          replay: !isFirstDelivery,
        });
        // → reconcile against the merchant's bank statement;
        //   surface "fix bank details" banner on payout.failed
        break;
      case "application.approved":
      case "application.denied":
      case "merchant.ready_for_payments":
        console.log({
          level: "info",
          route: "/webhooks/subscription",
          eventId: envelope.id,
          type: envelope.type,
          merchantId: envelope.merchant_id,
          applicationId: envelope.data.application_id,
          reason: envelope.data.reason,
          livemode: envelope.livemode,
          replay: !isFirstDelivery,
        });
        // → flip "Vora live" on/off for the merchant on
        //   merchant.ready_for_payments; surface denial reason in the UI
        break;
      default:
        // Forward-compatible: new event types may ship without an SDK bump.
        // Log and acknowledge — never 5xx an unknown type.
        console.log({
          level: "info",
          route: "/webhooks/subscription",
          msg: "unknown_event_ignored",
          eventId: envelope.id,
          type: envelope.type,
        });
    }
  } catch (handlerErr) {
    // Same logic as the session route — signature is verified, so a handler
    // bug must not trigger redelivery. Log + alert, return 200.
    console.error({
      level: "error",
      route: "/webhooks/subscription",
      msg: "handler_failed_after_verification",
      eventId: envelope.id,
      error: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
    });
  }

  res.status(200).json({ received: true });
});

// ─── Health ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/", (_req, res) => {
  res.type("text/plain").send(
    [
      "Von Payments — webhook receiver sample",
      "",
      "POST /webhooks/session       — session-level (X-VonPay-Signature, secret = vp_sk_*)",
      "POST /webhooks/subscription  — subscription-level (x-vonpay-signature t=,v1=, secret = whsec_*)",
      "GET  /health",
      "",
      "Register your public URL at app.vonpay.com/dashboard/developers/webhooks.",
    ].join("\n"),
  );
});

app.listen(port, () => {
  console.log({
    level: "info",
    msg: "server_started",
    url: `http://localhost:${port}`,
    sessionRoute: "/webhooks/session",
    subscriptionRoute: "/webhooks/subscription",
    subscriptionSecretsConfigured: subscriptionSecrets.length,
  });
});
