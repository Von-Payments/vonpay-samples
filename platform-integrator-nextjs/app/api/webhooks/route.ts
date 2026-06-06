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
// We compose a dedup key from sessionId + event-type + timestamp, which
// is unique per delivery for the typed event shape returned by
// constructEvent.
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
  const { vpSk, webhookSecret } = getTenantCredentials(tenant.id);

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
    console.error(
      `Webhook signature verification failed for tenant ${tenant.id}:`,
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  // Idempotency dedupe — events can be retried by Von Payments; we should
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
  //
  // Session IDs are deep-link tokens — keep them out of general
  // application logs and only surface in systems with the same trust
  // boundary as the API key itself.
  console.log(`[${tenant.name}] webhook received: ${event.event}`);

  switch (event.event) {
    case "session.succeeded":
      // Buyer actually paid. Update your CRM's `orders` row → status=paid
      // and trigger any downstream effects (fulfillment, receipt, etc.).
      // `event.sessionId` + `event.transactionId` are available here;
      // pass them to your systems but avoid logging them verbatim.
      break;
    case "session.failed":
      // Payment did not complete — do NOT fulfill. Update your CRM's
      // `orders` row → status=failed and surface it in your platform UI.
      break;
    case "refund.created":
      // Update your CRM's order/transaction → refunded.
      // `event.refundId` identifies the refund.
      break;
    default:
      // Unknown event type — ack 200 but take no action.
      break;
  }

  // Ack with a bare 200 — the delivery engine only needs to know we received
  // it. Don't echo the internal tenant id back to a third party.
  return NextResponse.json({ received: true });
}
