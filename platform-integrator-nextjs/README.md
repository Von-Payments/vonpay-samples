# Von Payments Checkout — platform integrator sample (Next.js)

Multi-tenant reference integration for platforms (CRMs, subscription engines, ISVs) that resell Von Payments to their own merchants. Demonstrates the per-tenant credential pattern: each merchant onboarded to the platform has their own Von Payments API key stored on the platform side; the platform looks up the right key at charge time and at webhook time.

- **Stack:** Next.js 15 / React 19 / TypeScript strict
- **SDK:** [`@vonpay/checkout-node@^0.4.0`](https://www.npmjs.com/package/@vonpay/checkout-node)
- **Best for:** subscription-billing CRMs, headless commerce platforms, ISV cart products, marketplace operators — anywhere your product has many "merchants" and each wants to plug Von Payments in as their gateway

## What it demonstrates

The patterns that aren't obvious from the single-merchant samples:

| Pattern | Where |
|---|---|
| Per-tenant credential lookup | `lib/tenants.ts` → `getTenantCredentials(tenantId)` |
| Tenant-scoped session creation with `Idempotency-Key` | `app/api/charge/route.ts` |
| Tenant-scoped `Von-Pay-Version` header | `app/api/charge/route.ts` (via SDK config) |
| Tenant-scoped return-URL signature verification | `app/tenants/[merchantId]/confirm/page.tsx` |
| **Multi-tenant webhook routing** — single endpoint, route by `merchantId` | `app/api/webhooks/route.ts` |
| In-memory event-ID idempotency dedup | `app/api/webhooks/route.ts` (replace with Redis in production) |
| CRM-style platform UI: tenants → customers → charge | `app/page.tsx` + `app/tenants/[merchantId]/page.tsx` |

## How the multi-tenant model works

There is no special "platform account" credential format in Von Payments today. The platform model is:

1. **Each of your platform's merchants signs up at app.vonpay.com** (or you walk them through it during onboarding) and gets their own `vp_sk_test_*` + `ss_test_*` keys.
2. **Your platform stores those keys** in your DB, keyed by your internal merchant/tenant ID. Encrypt at rest.
3. **At charge time:** look up the tenant's `vp_sk`, instantiate the SDK with that key, create the session.
4. **At webhook time:** the inbound payload includes `merchantId`. Use it to route the event back to the right tenant.

This sample simulates 3 tenants via env vars (`TENANT_A_VP_SK`, `TENANT_B_VP_SK`, `TENANT_C_VP_SK`). Replace the env-var lookup in `lib/tenants.ts` with a real DB query in production.

## 5-minute setup

### 1. Get sandbox keys for 3 tenants

Sign up at [app.vonpay.com](https://app.vonpay.com) **3 times** with 3 different work emails (e.g. `you+tenantA@yourdomain.com` — Gmail / Office365 plus-addressing works fine). Each signup goes through OTP, then **Activate Vora Sandbox** at `/dashboard/developers`. You'll get `vp_sk_test_*` + `ss_test_*` per tenant.

> Why three? To prove the multi-tenant routing. One signup is enough to *run* the sample, but the 3-tenant story is the whole point.

### 2. Configure + run

```bash
cp .env.example .env.local
# Edit .env.local — paste 3 pairs of TENANT_*_VP_SK + TENANT_*_SS

npm install
npm run dev
```

Open `http://localhost:3000`:

1. Click into a tenant (e.g. **Acme Vitamins**)
2. Click **Charge** on a customer row
3. The browser hits `/api/charge`, which looks up Acme's keys and creates a session
4. You're redirected to the Von Payments hosted checkout
5. Complete with a [test card](https://docs.vonpay.com/reference/test-cards) (e.g. `4242 4242 4242 4242`)
6. Return to `/tenants/tenant_a/confirm` — the page verifies the return signature using **Acme's** session signing secret, not the other tenants'

### 3. Test webhooks (optional)

Expose port 3000 via [`ngrok`](https://ngrok.com) and register the public URL in **each** tenant's dashboard webhook configuration. The shared `/api/webhooks` endpoint handles events for all 3 tenants — verify by completing checkouts on different tenants and watching the per-tenant log lines.

## Critical patterns

### Per-tenant credentials, not per-platform

```typescript
// lib/tenants.ts
export function getTenantCredentials(tenantId: string): TenantCredentials {
  // In production: SELECT vp_sk_encrypted, ss_encrypted FROM merchant_tenants
  //                WHERE id = $1
  // Decrypt at request time. Never log raw secrets.
  const upper = tenantId.replace(/^tenant_/, "").toUpperCase();
  return {
    vpSk: process.env[`TENANT_${upper}_VP_SK`]!,
    ss: process.env[`TENANT_${upper}_SS`]!,
  };
}
```

The platform owns the mapping from your internal `tenantId` → Von Payments credentials. Vora doesn't know your tenant model and doesn't need to.

### Idempotency-Key per logical charge attempt

```typescript
// app/api/charge/route.ts
const idempotencyKey = `${tenantId}:${customerId}:${amountCents}:${minuteBucket}:${randomUUID()}`;
const session = await vonpay.sessions.create(params, { idempotencyKey });
```

Browser refreshes, network blips, and middleware retries can cause the same charge POST to land twice. The Idempotency-Key turns the second call into a no-op (returns the same session). **Send one on every connector POST.** It's not server-enforced today, but the contract is documented in [docs.vonpay.com/platforms](https://docs.vonpay.com/platforms#idempotency).

### Multi-tenant webhook routing

```typescript
// app/api/webhooks/route.ts
const peek = JSON.parse(rawBody);            // 1. peek at merchantId (no side effects)
const tenant = findTenantByVonPayMerchantId(peek.merchantId);  // 2. route
const { vpSk } = getTenantCredentials(tenant.id);              // 3. fetch tenant's secret
const event = vonpay.webhooks.constructEvent(rawBody, sig, vpSk, ts);  // 4. VERIFY
// 5. ...now we trust the data. Update DB, fire downstream effects.
```

The signature is verified using the **tenant's** `vp_sk_*` (not a platform-wide secret), so we need to know who the tenant is *before* verification. The 2-step "peek then verify" pattern is safe because JSON-parsing a string has no side effects — we only act on the data after step 4 succeeds.

### Idempotent event processing

```typescript
if (event.id && !dedupe(event.id)) {
  return NextResponse.json({ received: true, deduped: true });
}
```

Webhook deliveries are retried on failure. The receiver must dedupe by `event.id`. The sample uses an in-memory Map; production should use Redis or a persistent store so dedup works across instances.

## Going to production

- **DB-backed credential storage** — replace the env-var lookup with a real query, encrypted columns, decrypt at request time. Never log raw `vp_sk_*` or `ss_*` values.
- **Tenant offboarding** — when you offboard a merchant, mark their tenant row inactive. The webhook handler should 200-and-ignore events for offboarded tenants (don't 401, that signals a bug to Von Payments).
- **Webhook idempotency** — replace the in-memory Map with Redis or a short-TTL DB table. Across multiple instances or auto-scaling, in-memory dedup misses cross-instance retries.
- **Per-tenant audit log** — every charge call + webhook event should write to a per-tenant audit log. Helps diagnose merchant disputes ("we never charged that customer") and is usually required for compliance.
- **Switch from `vp_sk_test_*` to `vp_sk_live_*`** per tenant after each merchant clears KYC + contract — see [Going Live](https://docs.vonpay.com/guides/going-live).

## What this sample doesn't cover

- **Webhooks v2 (`whsec_*` per-subscription secrets)** — not yet emitted by any endpoint. The v1 pattern shown here will keep working; v2 will be additive. See [Webhook Verification](https://docs.vonpay.com/integration/webhook-verification) for the full v1 + v2 walkthrough.
- **Per-tenant rate limiting** — your platform should rate-limit charge POSTs per tenant to prevent abuse; not shown here.
- **Outbound webhooks to your merchants** — your platform may want to forward `session.succeeded` events to the merchant's own webhook URL (their internal CRM, fulfillment system). Not in scope of this sample.

## Tested against

`@vonpay/checkout-node@^0.4.0` · last verified 2026-04-29
