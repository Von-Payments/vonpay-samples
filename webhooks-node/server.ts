import express, { type Request, type Response } from "express";
import { VonPayCheckout, type SubscriptionEventData, type WebhookEvent } from "@vonpay/checkout-node";

// ─── Config ─────────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT ?? "3000", 10);

const apiKey = process.env.VON_PAY_SECRET_KEY;
if (!apiKey) {
  console.error(
    "VON_PAY_SECRET_KEY is required. Copy .env.example to .env and fill it in.",
  );
  process.exit(1);
}

// Per-endpoint webhook signing secret (whsec_…), shown ONCE when you create the
// webhook endpoint in the dashboard. This is NOT your API key — verifying with
// the API key will fail against real deliveries. The SDK's constructEvent keys
// the HMAC off this secret.
// Refused when missing or still the .env.example placeholder: verifying against
// an empty or published value would accept a forged delivery.
const webhookSecret = process.env.VON_PAY_WEBHOOK_SECRET?.trim();
if (!webhookSecret || webhookSecret === "whsec_your_endpoint_signing_secret") {
  console.error(
    "VON_PAY_WEBHOOK_SECRET is required (whsec_…). Copy .env.example to .env and fill it in.",
  );
  process.exit(1);
}

const vonpay = new VonPayCheckout(apiKey);

// ─── In-memory idempotency guard ────────────────────────────────────────
// Production deployments MUST replace this with a durable store (Redis with a
// TTL, or a Postgres table with a UNIQUE index on the event id). An in-memory
// Set evaporates on process restart and does not deduplicate across instances
// behind a load balancer — both are exactly the conditions a retry storm
// exploits. See "Going to production" in the README.
const handledKeys = new Set<string>();
const HANDLED_KEY_CAP = 10_000;

/** Peek — has this event already been fulfilled SUCCESSFULLY? Does not record. */
function alreadyCompleted(key: string): boolean {
  return handledKeys.has(key);
}

/**
 * Record an event as COMPLETED. Call this only AFTER the handler has run
 * without throwing.
 *
 * ⛔ MARK ON SUCCESS, NOT ON RECEIPT — this ordering is the whole guard.
 *
 * The obvious shape is to mark the key the moment the event arrives. It is
 * wrong, and it fails in the direction that loses money silently: if the
 * handler then throws (a DB write times out, a downstream fulfilment call
 * 500s — no attacker required), the event is already recorded as handled. The
 * buyer has paid, the order never ships, and every later delivery — including
 * the manual resend this sample's README tells operators to use — is dropped
 * as a duplicate. The failure is invisible: the endpoint answers 200 throughout.
 *
 * Recording completion instead means a first-attempt failure leaves NO mark, so
 * a resend genuinely retries.
 *
 * ⚠️ Honest limit of an in-memory Set: two duplicate deliveries processed
 * CONCURRENTLY can both observe "not completed" and both run. A real
 * implementation claims the key atomically — a Postgres row with a UNIQUE
 * index on the event id, inserted as `processing` and updated to `completed` —
 * which closes that window and survives the restart this Set does not.
 */
function markCompleted(key: string): void {
  if (handledKeys.has(key)) return;
  if (handledKeys.size >= HANDLED_KEY_CAP) {
    // Drop the oldest entry. Set iteration order is insertion order in V8.
    //
    // ⚠️ Eviction is itself a double-fulfilment window: an event whose key has
    // aged out reads as new again. It needs sustained volume past the cap with
    // no restart, which is the same condition the note above describes — one
    // more reason the durable store is not optional in production.
    const first = handledKeys.values().next().value;
    if (first !== undefined) handledKeys.delete(first);
  }
  handledKeys.add(key);
}

// ─── Subscriptions: what your system keeps ──────────────────────────────
// A stand-in for your own database (orders, memberships). Replace both maps
// with real tables; the handlers below show WHAT to store and WHEN.
//
// Subscription events are opt-in: an endpoint receives them only when it lists
// each one by name (`"*"` does not include them). Select all five:
// subscription.created, .renewed, .payment_failed, .cancelled, .updated.
interface Membership {
  subscriptionId: string; // vsub_live_… / vsub_test_…
  status: string; // an open list: store unknown values as sent
  renewalAmount: number | null; // minor units
  currency: string | null;
  nextBillAt: number | null; // Unix seconds; null while paused, held or ended
  cancelReason: string | null;
  lastDeclineCode: string | null;
  metadata: Record<string, unknown>; // your sign-up metadata, as you sent it
  lastEventAt: number; // the envelope `created` of the newest event applied
}
const memberships = new Map<string, Membership>(); // key: subscription_id
// One renewal order per subscription and cycle. Keyed by the BUSINESS pair,
// not only the event id: it is the line that must never be crossed twice.
const renewalOrders = new Map<string, { paymentIntentId: string | null; amount: number | null }>();

/**
 * Apply the state an event carries. Every subscription event carries the whole
 * current state, so applying the newest one is enough.
 *
 * ⚠️ Events arrive in NO guaranteed order. An older event that arrives late (a
 * redelivered `renewed` after the `cancelled`) must not bring an ended
 * membership back, so state from an event older than the newest one applied is
 * skipped. Same-second events still apply. Where order matters to you, re-read
 * the subscription with `subscriptions.retrieve(id)` instead.
 */
function applyState(data: SubscriptionEventData, created: number): Membership {
  const m: Membership = memberships.get(data.subscription_id) ?? {
    subscriptionId: data.subscription_id,
    status: data.status,
    renewalAmount: null,
    currency: null,
    nextBillAt: null,
    cancelReason: null,
    lastDeclineCode: null,
    metadata: {},
    lastEventAt: 0,
  };
  if (created >= m.lastEventAt) {
    m.status = data.status;
    m.renewalAmount = data.renewal_amount;
    m.currency = data.currency;
    m.nextBillAt = data.next_bill_at;
    m.cancelReason = data.cancel_reason; // null unless the membership has ended
    // `{}` when you sent none (or more than about 7 KB): applied as sent.
    m.metadata = data.metadata ?? m.metadata;
    m.lastEventAt = created;
  } else {
    console.log({ level: "info", route: "/webhooks/vonpay", msg: "older_event_state_skipped", subscriptionId: m.subscriptionId });
  }
  memberships.set(m.subscriptionId, m);
  return m;
}

/**
 * One handler per subscription event. Each one is safe to run twice: the event
 * id guard in the route stops a redelivery, and each write below is keyed so a
 * repeat changes nothing (for example a second `subscription.renewed` for the
 * same cycle creates no second order).
 */
function handleSubscriptionEvent(type: string, d: SubscriptionEventData, created: number): void {
  switch (type) {
    case "subscription.created":
      // Link the Von Payments subscription to YOUR record: by the sign-up
      // payment (`payment_intent_id`) or by the ids you put in `metadata`.
      // The sign-up's 201 answer may already have given you `subscription.id`;
      // if it was null there, this event is where you learn it.
      applyState(d, created);
      break;
    case "subscription.renewed": {
      // A renewal charge succeeded: build the renewal order HERE (not from
      // charge.succeeded). Same item, cycle `billing_cycle`, amount `amount`,
      // payment `payment_intent_id`. The order is created even when the event
      // arrives late: it is keyed by the cycle, not by arrival order.
      if (d.billing_cycle === null) {
        // Never expected on a renewal. Throwing leaves the event unrecorded, so
        // a resend can retry it, instead of filing every such renewal under one key.
        throw new Error("subscription.renewed without billing_cycle");
      }
      const m = applyState(d, created);
      if (m.lastEventAt === created) m.lastDeclineCode = null; // the renewal paid
      const orderKey = `${d.subscription_id}:${d.billing_cycle}`;
      if (renewalOrders.has(orderKey)) {
        console.log({ level: "info", route: "/webhooks/vonpay", msg: "renewal_order_exists", orderKey });
      } else {
        renewalOrders.set(orderKey, { paymentIntentId: d.payment_intent_id, amount: d.amount });
        console.log({ level: "info", route: "/webhooks/vonpay", msg: "renewal_order_created", orderKey, amount: d.amount });
      }
      break;
    }
    case "subscription.payment_failed": {
      // One event per declined attempt; the membership is past due and retries
      // follow. `status: "failed"` means it was the final try and the
      // membership has ended: no subscription.cancelled follows, so this is
      // where you end it (`cancel_reason` says why).
      const m = applyState(d, created);
      if (m.lastEventAt === created) m.lastDeclineCode = d.decline_code;
      break;
    }
    case "subscription.cancelled":
      // Any cancel: your API call, your staff, the customer, a chargeback, or a
      // revoked card permission. No refund is implied.
      applyState(d, created);
      break;
    case "subscription.updated":
      // Paused, resumed, held, released, price / discount / date / interval
      // changed, card updated, a cancel scheduled or withdrawn, or restarted (a
      // restart is an update, never a second `created`). The event carries the
      // new state, so applying it is enough; `changed_fields` says what moved
      // and `actor` says who moved it (show it in your support view).
      applyState(d, created);
      console.log({
        level: "info",
        route: "/webhooks/vonpay",
        event: type,
        changedFields: d.changed_fields,
        actor: d.actor?.type ?? null,
      });
      break;
  }
}

/** `subscription_id` on a payment event: set when Von Payments charged it for a subscription. */
const subscriptionIdOf = (data: object): string | null =>
  (data as { subscription_id?: string | null }).subscription_id ?? null;

// ─── Express app ────────────────────────────────────────────────────────
const app = express();

// IMPORTANT: webhook signature verification is byte-for-byte over the RAW
// request body. If `express.json()` (or any other body parser) runs first it
// parses the buffer into an object and the original bytes are lost — the HMAC
// will not match.
//
// The fix is to mount `express.raw()` ON THE WEBHOOK ROUTE ONLY, ABOVE the
// generic JSON parser. The route receives `req.body` as a Buffer, untouched.
// Any other route (health, etc.) still gets parsed JSON.
app.use("/webhooks/vonpay", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json());

// ─── Webhook receiver ───────────────────────────────────────────────────
// Header:  `x-vonpay-signature: t=<unix>,v1=<hex>` — the signed timestamp lives
//          INSIDE the header (the `t=` part); there is no separate timestamp
//          header.
// Secret:  the per-endpoint `whsec_*` signing secret (NOT your API key).
// Events:  charge.succeeded, charge.failed, charge.refunded, refund.failed, and
//          (opt-in, select each by name) subscription.created, .renewed,
//          .payment_failed, .cancelled and .updated.
//          ⚠️ NOT session.succeeded — the server emits `session.*` internally,
//          but those keys are absent from the merchant subscription catalog,
//          which accepts an unknown key, stores nothing and returns success.
//          An endpoint subscribed to one receives nothing, forever, with no
//          error at any layer. (`refund.created` never existed at all.)
//
// `vonpay.webhooks.constructEvent` does the whole verify-and-parse step in one
// call: it parses the header, recomputes HMAC-SHA256 over `${t}.${rawBody}`,
// timing-safe-compares against each `v1=` entry (multiple entries appear during
// a secret rotation window — it accepts on any match), enforces the replay
// window (reject if `now - t > 5 min` or `t - now > 30 sec`), and returns a
// typed WebhookEvent. It throws on any failure — there is no need to hand-roll
// the HMAC.
app.post("/webhooks/vonpay", (req: Request, res: Response): void => {
  const signature = req.headers["x-vonpay-signature"];
  if (typeof signature !== "string") {
    res.status(400).json({ error: "Missing x-vonpay-signature header" });
    return;
  }

  let event: WebhookEvent;
  try {
    event = vonpay.webhooks.constructEvent(
      req.body as Buffer, // raw body — express.raw made this a Buffer
      signature,
      webhookSecret, // per-endpoint whsec_* signing secret
    );
  } catch (err) {
    // 400 (not 200) on signature/replay-window failure. Returning 200 here
    // would tell the delivery engine the request was accepted and suppress the
    // legitimate retry. Log only err.message — passing the full error object to
    // a structured logger may serialize signature / HMAC bytes from its
    // diagnostic fields, which must never reach stdout.
    console.warn({
      level: "warn",
      route: "/webhooks/vonpay",
      msg: "signature_verification_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  // A "Send test event" delivery is signed and can carry a real order's ids: acknowledge it and do nothing else.
  if (event.test_event === true) {
    res.status(200).json({ received: true });
    return;
  }

  // Idempotency guard. A redelivery (after a transient 5xx, a manual resend, or
  // during a secret rotation) carries the same logical event — dedupe so a
  // retry does not double-fulfill.
  //
  // Dedupe on `event.id` (`vp_evt_*`), which is unique per outbound event. Do
  // NOT build a composite key from the payload: one money movement can emit
  // more than one event (e.g. a charge event and a session event for the same
  // payment), so a payload-derived key can collapse two distinct events into
  // one and silently drop the second.
  const dedupeKey = event.id;
  const isFirstDelivery = !alreadyCompleted(dedupeKey);

  // ⛔ THIS EARLY RETURN IS THE GUARD. Until 2026-09-12 the dedupe decision was
  // computed here and then used ONLY inside log lines — the switch below ran on
  // every delivery, including redeliveries. The comment above and the README
  // both promised idempotent processing; the code did not implement it, and
  // this is the most-cloned webhook receiver we publish.
  //
  // It costs nothing to get wrong in the sample and everything downstream: the
  // switch is where a merchant puts "fulfill the order, send the receipt". A
  // redelivery needs no attacker — our own retry after a transient 5xx, or an
  // ops resend, is enough to ship twice.
  //
  // ⚠️ The first version of this guard read a flag set BEFORE the handler ran,
  // which quietly converted a failed first attempt into a permanent drop. See
  // `markCompleted` for why the key is now recorded only on success.
  //
  // Returning 200 (not 4xx) is deliberate: the delivery WAS accepted, we have
  // simply already acted on it. A non-2xx here would make the sender retry the
  // duplicate it just sent.
  if (!isFirstDelivery) {
    console.log({
      level: "info",
      route: "/webhooks/vonpay",
      msg: "duplicate_delivery_ignored",
      event: event.type,
      dedupeKey,
    });
    res.status(200).json({ received: true, deduped: true });
    return;
  }

  try {
    // A payment Von Payments made for a subscription (a renewal, a "bill now",
    // or the overdue charge on a card update) carries `subscription_id` and
    // `billing_cycle` on charge.* and payment_intent.*; a sign-up and every
    // other payment carry null. Do NOT fulfil it, or fail an order, as a new
    // purchase: the order comes from subscription.renewed and a failed renewal
    // from subscription.payment_failed. A REFUND of a renewal charge is still a
    // refund: charge.refunded is not skipped.
    const isPaymentEvent = event.type.startsWith("charge.") || event.type.startsWith("payment_intent.");
    const subscriptionId = isPaymentEvent && event.type !== "charge.refunded" ? subscriptionIdOf(event.data) : null;
    if (subscriptionId !== null) {
      console.log({ level: "info", route: "/webhooks/vonpay", event: event.type, msg: "renewal_payment", subscriptionId });
    } else {
      switch (event.type) {
        case "subscription.created":
        case "subscription.renewed":
        case "subscription.payment_failed":
        case "subscription.cancelled":
        case "subscription.updated":
          handleSubscriptionEvent(event.type, event.data, event.created);
          break;
        case "charge.succeeded":
          // → fulfill the order, send the receipt, mark the order paid in your DB.
          // This is the fulfilment event. Session and transaction IDs are
          // sensitive deep-link tokens — pass them to your fulfillment system but
          // avoid logging them verbatim.
          console.log({
            level: "info",
            route: "/webhooks/vonpay",
            event: event.type,
            merchantId: event.merchant_id,
            amount: event.data.amount,
            currency: event.data.currency,
          });
          break;
        case "charge.failed":
          // → mark the order failed; surface the failure reason in the buyer UI.
          // Do NOT fulfill on a failed charge.
          console.log({
            level: "info",
            route: "/webhooks/vonpay",
            event: event.type,
            merchantId: event.merchant_id,
            error: event.data.failure_reason,
            failureCode: event.data.failure_code,
          });
          break;
        case "charge.refunded":
          // → reverse fulfillment, post a credit memo, notify the buyer.
          //
          // ⚠️ Read `refund_amount` (what THIS event moved) and
          // `amount_refunded_total` (running total against the charge), NOT
          // `amount` or `is_partial`. Those two are ambiguous across payment
          // connectors on a SECOND partial refund — some report this refund's
          // delta and some the cumulative total, and nothing on the wire tells
          // you which. Decide "is this charge now fully refunded?" by comparing
          // `amount_refunded_total` against `original_charge_amount`.
          console.log({
            level: "info",
            route: "/webhooks/vonpay",
            event: event.type,
            merchantId: event.merchant_id,
            refundId: event.data.refund_id,
            refundAmount: event.data.refund_amount,
            refundedTotal: event.data.amount_refunded_total,
            originalChargeAmount: event.data.original_charge_amount,
            currency: event.data.currency,
          });
          break;
        case "refund.failed":
          // → a refund could NOT be completed. No money moved on this event:
          // `refund_amount` is the reversal that failed to go through. Put the
          // order back in a "refund owed" state and alert someone — nothing
          // retries this for you. `reason_code` is a locked two-value set:
          // `refund_declined` (terminal decline) or `refund_unresolved` (no
          // provider response — the true state is unknown, so do NOT assume the
          // buyer was not paid). `retry_available` says whether a retry is
          // permitted at all.
          console.log({
            level: "warn",
            route: "/webhooks/vonpay",
            event: event.type,
            merchantId: event.merchant_id,
            refundId: event.data.refund_id,
            refundAmount: event.data.refund_amount,
            reasonCode: event.data.reason_code,
            retryAvailable: event.data.retry_available,
          });
          break;
        default:
          // Forward-compatible — unknown events are a no-op. The 200 below acks
          // the delivery; new event types may ship without an SDK bump, so never
          // 5xx an event you don't recognize (that just triggers redelivery).
          console.log({
            level: "info",
            route: "/webhooks/vonpay",
            msg: "unknown_event_ignored",
            event: event.type,
          });
      }
    }

    // ⛔ COMPLETION IS RECORDED HERE — the last statement of the try, reached
    // only if the handler above did not throw. Moving this earlier (to where
    // the event arrives) is the bug described on `markCompleted`: it converts
    // a failed first attempt into a permanent drop.
    markCompleted(dedupeKey);
  } catch (handlerErr) {
    // The signature is already verified, so a bug in OUR handler must NOT
    // trigger a retry — we would just hit the same bug again. Log + alert +
    // acknowledge with 200. Real systems should fire a Sentry/Datadog alert
    // here so on-call sees the failure even though we returned 200.
    //
    // ⚠️ Note what is NOT done here: the event is deliberately left UNRECORDED,
    // so a manual resend from the dashboard can genuinely retry it. Returning
    // 200 stops the automatic retry loop (which would only re-hit the same
    // bug); leaving the key unmarked keeps the human recovery path open. Those
    // are two different decisions and this sample makes both on purpose.
    console.error({
      level: "error",
      route: "/webhooks/vonpay",
      msg: "handler_failed_after_verification",
      dedupeKey,
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
      "POST /webhooks/vonpay  — verifies x-vonpay-signature (t=,v1=) with your whsec_* secret",
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
    webhookRoute: "/webhooks/vonpay",
  });
});
