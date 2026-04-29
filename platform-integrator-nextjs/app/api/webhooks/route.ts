import { NextRequest, NextResponse } from "next/server";
import { VonPayCheckout } from "@vonpay/checkout-node";
import {
  findTenantByVonPayMerchantId,
  getTenantCredentials,
} from "@/lib/tenants";

/**
 * POST /api/webhooks — multi-tenant webhook receiver.
 *
 * The platform receives webhooks from Von Payments for ALL its tenants
 * at this single endpoint. Each event payload includes a `merchantId`
 * field — the platform routes the event back to the right tenant by
 * looking up the merchantId in its DB.
 *
 * Signature verification model: each merchant signs with THEIR OWN
 * vp_sk_* secret. So the verifier needs the right key for the right
 * event. The challenge: we need to know which tenant this event
 * belongs to *before* we can verify the signature.
 *
 * Solution today (Webhooks v1):
 *   1. Parse the body as JSON without verifying (read-only)
 *   2. Extract merchantId from the parsed payload
 *   3. Look up the tenant + their vp_sk
 *   4. Verify the signature using that vp_sk against the RAW body
 *   5. If valid: process the event. If invalid: 401.
 *
 * The body parse in step 1 is a read; we don't act on the data until
 * step 4 confirms it's authentic. This is safe because parsing JSON
 * doesn't have side effects.
 *
 * (Webhooks v2, when it ships, will include per-subscription `whsec_*`
 * secrets — at that point the secret is keyed by subscription ID
 * rather than per-merchant API key. The lookup pattern stays the same
 * shape.)
 */

// Idempotency: in-memory cache for this process. Replace with Redis or
// equivalent in production — webhook deliveries can hit multiple
// instances and you must dedupe across them.
//
// The Webhooks v1 payload doesn't carry a top-level event id; we
// compose one from sessionId + event-type + timestamp, which is
// unique per delivery. Webhooks v2 (when it ships) will include a
// dedicated event id; replace this composite at that point.
const seenEventKeys = new Map<string, number>();
const SEEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function dedupe(eventKey: string): boolean {
  const now = Date.now();
  // Sweep stale entries cheap (every call — the map is small).
  for (const [k, ts] of seenEventKeys) {
    if (now - ts > SEEN_TTL_MS) seenEventKeys.delete(k);
  }
  if (seenEventKeys.has(eventKey)) return false;
  seenEventKeys.set(eventKey, now);
  return true;
}

export async function POST(req: NextRequest) {
  // Read raw body — required for HMAC verification.
  const rawBody = await req.text();
  const signature = req.headers.get("x-vonpay-signature") ?? "";
  const timestamp = req.headers.get("x-vonpay-timestamp") ?? "";

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
    // merchant we offboarded. Log + 200 (so VonPay doesn't keep
    // retrying forever) but don't process.
    console.warn(`Webhook for unknown merchant '${peekedMerchantId}' — ignoring`);
    return NextResponse.json({ received: true, routed: false });
  }
  const { vpSk } = getTenantCredentials(tenant.id);

  // Step 4: verify against the tenant's key, using the SDK's
  // constructEvent which throws on signature mismatch.
  const vonpay = new VonPayCheckout(vpSk);
  let event;
  try {
    event = vonpay.webhooks.constructEvent(rawBody, signature, vpSk, timestamp);
  } catch (err) {
    console.error(`Webhook signature verification failed for tenant ${tenant.id}:`, err);
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  // Idempotency dedupe — events can be retried by VonPay; we should
  // process each unique event at most once. Composite key from
  // sessionId + event-type + timestamp.
  const eventKey = `${event.sessionId}:${event.event}:${event.timestamp}`;
  if (!dedupe(eventKey)) {
    console.log(`Duplicate webhook ${eventKey} for tenant ${tenant.id} — skipping`);
    return NextResponse.json({ received: true, deduped: true });
  }

  // Step 5: process the event for the right tenant. This is where the
  // platform updates its own data model — mark the order paid, send
  // a receipt, post to the merchant's outbound webhook, etc.
  console.log(
    `[${tenant.name}] webhook received: ${event.event} for session ${event.sessionId}`,
  );

  switch (event.event) {
    case "session.succeeded":
      // TODO: update your CRM's `orders` row → status=paid
      // TODO: trigger any downstream effects (fulfillment, receipt, etc.)
      break;
    case "session.failed":
      // TODO: update your CRM's `orders` row → status=failed
      // TODO: surface the failure in your platform's UI
      break;
    case "session.expired":
      // TODO: clean up the pending order; possibly retry
      break;
    case "refund.created":
      // TODO: update your CRM's order/transaction → refunded
      break;
  }

  return NextResponse.json({ received: true, tenant: tenant.id });
}
