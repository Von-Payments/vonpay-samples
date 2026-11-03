import { NextRequest, NextResponse } from "next/server";
import { VonPayCheckout } from "@vonpay/checkout-node";
import {
  findTenantByVonPayMerchantId,
  getTenantCredentials,
} from "@/lib/tenants";
import { getOrderBySession, type OrderRecord } from "@/lib/orders";

/**
 * POST /api/webhooks — multi-tenant webhook receiver.
 *
 * The platform receives webhooks from Von Payments for ALL its tenants
 * at this single endpoint. Each event payload includes a `merchantId`
 * field — the platform routes the event back to the right tenant by
 * looking up the merchantId in its DB.
 *
 * Signature model: each webhook endpoint is signed with the per-endpoint
 * `whsec_*` secret minted when that endpoint is registered in the
 * dashboard — NOT your API key. Each of your tenants registers their own
 * webhook endpoint in their own dashboard, so each tenant has their own
 * `whsec_*`. The verifier therefore needs the right `whsec_*` for the
 * right event. The challenge: we need to know which tenant this event
 * belongs to *before* we can pick the right secret to verify with.
 *
 * Solution:
 *   1. Parse the body as JSON without verifying (read-only)
 *   2. Extract merchantId from the parsed payload
 *   3. Look up the tenant + their `whsec_*` endpoint secret
 *   4. Verify the signature using that `whsec_*` against the RAW body
 *   5. If valid: process the event. If invalid: 400.
 *
 * The body parse in step 1 is a read; we don't act on the data until
 * step 4 confirms it's authentic. This is safe because parsing JSON
 * doesn't have side effects.
 *
 * The signed timestamp lives INSIDE the `x-vonpay-signature` header
 * (`t=<unix>,v1=<hex>`) — there is no separate timestamp header, and
 * `constructEvent` takes 3 args: (rawBody, signatureHeader, secret).
 */

// Idempotency: in-memory cache for this process. Replace with Redis or
// equivalent in production — webhook deliveries can hit multiple
// instances and you must dedupe across them.
//
// The dedup key is the TENANT plus the event `id` (`vp_evt_*`) — see the
// handler below for why the tenant is part of it.
const seenEventKeys = new Map<string, number>();
const SEEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Peek — has this event already been processed to COMPLETION? Does not record. */
function alreadyCompleted(eventKey: string): boolean {
  const now = Date.now();
  // Sweep stale entries cheap (every call — the map is small).
  for (const [k, ts] of seenEventKeys) {
    if (now - ts > SEEN_TTL_MS) seenEventKeys.delete(k);
  }
  return seenEventKeys.has(eventKey);
}

/**
 * Record an event as COMPLETED. Call only AFTER processing has succeeded.
 *
 * ⛔ MARK ON SUCCESS, NOT ON RECEIPT. Until 2026-09-12 this file recorded the
 * key at the moment the event arrived, and then returned early on any later
 * delivery. If processing threw on the FIRST delivery — a DB write timeout, a
 * failed outbound post to the merchant, no attacker required — the event was
 * already recorded as seen. The buyer had paid, the platform never updated its
 * model, and every subsequent delivery, including a manual resend, was dropped
 * as a duplicate.
 *
 * Recording completion instead means a failed first attempt leaves no mark, so
 * a redelivery genuinely retries.
 *
 * ⚠️ An in-memory Map cannot claim a key atomically, so two duplicate
 * deliveries processed CONCURRENTLY can both run. A real platform inserts the
 * event id into a table with a UNIQUE index as `processing` and updates it to
 * `completed` — which closes that window and survives the restart this Map
 * does not.
 */
function markCompleted(eventKey: string): void {
  seenEventKeys.set(eventKey, Date.now());
}

/**
 * The order a payment event is about, ONLY if it belongs to `tenantId`.
 *
 * ⛔ A valid signature proves which TENANT sent the event, not which order it
 * may touch. Each tenant registers its own endpoint and can read its own
 * `whsec_*`, so a tenant (or anyone who obtains one tenant's secret) can sign
 * an event that names ANOTHER tenant's session id. Session ids are not
 * secret: they travel in checkout and return URLs. Without this check, that
 * event would mark another tenant's order paid. The confirm page applies the
 * same rule: it refuses an order whose `tenantId` is not this tenant's.
 */
function orderOfTenant(tenantId: string, sessionId: string | null | undefined): OrderRecord | undefined {
  if (!sessionId) return undefined;
  const order = getOrderBySession(sessionId);
  return order && order.tenantId === tenantId ? order : undefined;
}

export async function POST(req: NextRequest) {
  // Read raw body — required for HMAC verification. Capture this BEFORE
  // JSON parsing; re-serialized JSON will not match the signature.
  const rawBody = await req.text();
  const signature = req.headers.get("x-vonpay-signature") ?? "";

  // Step 1+2: peek at the payload to find merchantId. We're NOT
  // trusting the data yet — just routing.
  let peekedMerchantId: string;
  try {
    const peek = JSON.parse(rawBody);
    peekedMerchantId = String(peek.merchantId ?? peek.merchant_id ?? "");
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!peekedMerchantId) {
    return NextResponse.json({ error: "missing_merchant_id" }, { status: 400 });
  }

  // Step 3: route to the tenant.
  const tenant = findTenantByVonPayMerchantId(peekedMerchantId);
  if (!tenant) {
    // Unknown merchant — possibly a misconfigured webhook URL or a
    // merchant we offboarded. Log + 200 (so Von Payments doesn't keep
    // retrying forever) but don't process. `peekedMerchantId` comes from the
    // UNVERIFIED body — sanitize before logging so a crafted payload can't
    // inject newlines/escape sequences into the log stream.
    const safeMerchantId = peekedMerchantId.replace(/[^\w-]/g, "?").slice(0, 64);
    console.warn(`Webhook for unknown merchant '${safeMerchantId}' — ignoring`);
    return NextResponse.json({ received: true, routed: false });
  }
  let credentials;
  try {
    credentials = getTenantCredentials(tenant.id);
  } catch (err) {
    // This tenant's secret is missing or still the .env.example value. 500,
    // not 4xx: the delivery is fine; this server is not configured yet, and
    // the retry succeeds once it is.
    console.error(
      `Webhook for tenant ${tenant.id} refused:`,
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "webhook_secret_not_configured" }, { status: 500 });
  }
  const { vpSk, webhookSecret } = credentials;

  // Step 4: verify against the tenant's endpoint secret (whsec_*), using
  // the SDK's constructEvent which throws on signature mismatch, stale
  // timestamp, or malformed header. The SDK client is instantiated with
  // the tenant's API key so its error reporter is tenant-scoped; the
  // signature itself is checked against the whsec_* endpoint secret.
  const vonpay = new VonPayCheckout(vpSk);
  let event;
  try {
    event = vonpay.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    // Log only err.message — passing the full err object to a structured
    // logger may serialize signature / HMAC bytes from the VonPayError's
    // diagnostic fields. We never want those in stdout.
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof TypeError) {
      // The SDK refused the SECRET (empty, an example value, or an API key),
      // before looking at the delivery. That is a setup problem on this
      // server, not a bad delivery: answer 500 so the sender retries, rather
      // than 400, which tells it to give up and drops the event.
      console.error(`Webhook secret for tenant ${tenant.id} refused by the SDK:`, message);
      return NextResponse.json({ error: "webhook_secret_not_configured" }, { status: 500 });
    }
    console.error(`Webhook signature verification failed for tenant ${tenant.id}:`, message);
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  // A "Send test event" delivery is signed and can carry a real order's ids: acknowledge it and do nothing else.
  if (event.test_event === true) {
    return NextResponse.json({ received: true });
  }

  // Idempotency dedupe — events can be retried by Von Payments; we should
  // process each unique event at most once. `event.id` (`vp_evt_*`) is unique
  // per outbound event. Do NOT compose a key from the rest of the payload: a
  // single money movement can emit more than one event, and a payload-derived
  // key can collapse two distinct events into one.
  //
  // ⛔ Key on the VERIFIED tenant as well as the event id. The signature proves
  // which tenant signed the event, not that its id is genuine: a tenant can
  // sign an event that carries ANOTHER tenant's real `vp_evt_*` id (ids show
  // up in dashboards and logs). Keyed on the id alone, that forged event would
  // be recorded first, and the victim's genuine delivery then dropped as a
  // duplicate. With the tenant in the key, one tenant cannot touch another's.
  const eventKey = `${tenant.id}:${event.id}`;
  if (alreadyCompleted(eventKey)) {
    console.log(`Duplicate webhook ${eventKey} for tenant ${tenant.id} — skipping`);
    return NextResponse.json({ received: true, deduped: true });
  }

  // Step 5: process the event for the right tenant. This is where the
  // platform updates its own data model — mark the order paid, send
  // a receipt, post to the merchant's outbound webhook, etc.
  //
  // Session IDs are deep-link tokens — keep them out of general
  // application logs and only surface in systems with the same trust
  // boundary as the API key itself.
  console.log(`[${tenant.name}] webhook received: ${event.type}`);

  // ⚠️ These are `charge.*`, not `session.*`. The server emits `session.*`
  // internally, but those keys are absent from the merchant subscription
  // catalog — which accepts an unknown event key, stores nothing and returns
  // success. An endpoint subscribed to `session.succeeded` receives nothing,
  // forever, with no error raised at any layer. For a PLATFORM that is the
  // worst version of this bug: no tenant's order would ever be fulfilled, and
  // nothing anywhere would report a fault.
  switch (event.type) {
    case "charge.succeeded": {
      // Buyer actually paid. Find the order on YOUR side, for THIS tenant only.
      const order = orderOfTenant(tenant.id, event.data.session_id);
      if (!order) {
        // Not an order this tenant created here: do not touch anything. Still
        // ack (200), since a redelivery cannot change the answer.
        console.warn(`[${tenant.name}] ${event.type} for no order of this tenant — ignored`);
        break;
      }
      // Update your CRM's `orders` row → status=paid and trigger any
      // downstream effects (fulfillment, receipt, etc.).
      // `event.data.transaction_id` is available here; pass it to your
      // systems but avoid logging it verbatim.
      console.log(`[${tenant.name}] order ${order.orderId} paid`);
      break;
    }
    case "charge.failed": {
      // Payment did not complete — do NOT fulfill. Same rule: only this
      // tenant's own order.
      const order = orderOfTenant(tenant.id, event.data.session_id);
      if (!order) {
        console.warn(`[${tenant.name}] ${event.type} for no order of this tenant — ignored`);
        break;
      }
      // Update your CRM's `orders` row → status=failed and surface it in your
      // platform UI. `event.data.failure_reason` is the buyer-safe explanation.
      console.log(`[${tenant.name}] order ${order.orderId} failed`);
      break;
    }
    case "charge.refunded":
      // Update your CRM's order/transaction → refunded. Look the order up the
      // same way (`orderOfTenant`): only this tenant's own order.
      //
      // ⚠️ Read `refund_amount` (what THIS event moved) and
      // `amount_refunded_total` (running total), NOT `amount` or `is_partial`.
      // Those two are ambiguous across payment connectors on a SECOND partial
      // refund — some report this refund's delta, some the cumulative total.
      // Compare `amount_refunded_total` against `original_charge_amount`.
      break;
    case "refund.failed":
      // A refund could NOT be completed — no money moved on this event. Put
      // the order back into a "refund owed" state and alert someone; nothing
      // retries this for you. `reason_code` is `refund_declined` (terminal) or
      // `refund_unresolved` (no provider response — the true state is unknown,
      // so do NOT assume the buyer was not paid).
      break;
    default:
      // Unknown event type — ack 200 but take no action.
      break;
  }

  // ⛔ Record completion only now, after the switch above has run without
  // throwing. If it threw, this line is never reached, the event stays
  // unrecorded, and a redelivery can genuinely retry it. See `markCompleted`.
  markCompleted(eventKey);

  // Ack with a bare 200 — the delivery engine only needs to know we received
  // it. Don't echo the internal tenant id back to a third party.
  return NextResponse.json({ received: true });
}
