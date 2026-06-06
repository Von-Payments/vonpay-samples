# Von Payments Checkout — platform integrator sample (Next.js)

Multi-tenant reference integration for platforms (CRMs, subscription engines, ISVs) that resell Von Payments to their own merchants. Demonstrates the per-tenant credential pattern: each merchant onboarded to the platform has their own Von Payments API key, return-signing secret, and webhook signing secret stored on the platform side; the platform looks up the right credentials at charge time and at webhook time.

- **Stack:** Next.js 15 / React 19 / TypeScript strict
- **Von Payments SDK:** [`@vonpay/checkout-node@^0.9.0`](https://www.npmjs.com/package/@vonpay/checkout-node)
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
| Per-tenant webhook signature verification with the tenant's `whsec_*` | `app/api/webhooks/route.ts` |
| In-memory event idempotency dedup | `app/api/webhooks/route.ts` (replace with Redis in production) |
| CRM-style platform UI: tenants → customers → charge | `app/page.tsx` + `app/tenants/[merchantId]/page.tsx` |

## How the multi-tenant model works

There is no special "platform account" credential format in Von Payments today. The platform model is:

1. **Each of your platform's merchants signs up at app.vonpay.com** (or you walk them through it during onboarding) and gets their own `vp_sk_test_*` API key + `ss_test_*` return-signing secret.
2. **Each merchant registers a webhook endpoint** in their dashboard and gets a per-endpoint `whsec_*` signing secret (shown once at create time).
3. **Your platform stores all three** in your DB, keyed by your internal merchant/tenant ID. Encrypt at rest.
4. **At charge time:** look up the tenant's `vp_sk`, instantiate the SDK with that key, create the session.
5. **At webhook time:** the inbound payload includes `merchantId`. Use it to route the event back to the right tenant, then verify the signature with that tenant's `whsec_*`.

This sample simulates 3 tenants via env vars (`TENANT_A_VP_SK` / `TENANT_A_SS` / `TENANT_A_WHSEC`, and so on). Replace the env-var lookup in `lib/tenants.ts` with a real DB query in production.

## 5-minute setup

### 1. Get sandbox keys for 3 tenants

Sign up at [app.vonpay.com](https://app.vonpay.com) **3 times** with 3 different work emails (e.g. `you+tenantA@yourdomain.com` — Gmail / Office365 plus-addressing works fine). Each signup goes through OTP, then **Activate Vora Sandbox** at `/dashboard/developers`. You'll get `vp_sk_test_*` + `ss_test_*` per tenant. Register a webhook endpoint per tenant at `/dashboard/developers/webhooks` to get each tenant's `whsec_*`.

> Why three? To prove the multi-tenant routing. One signup is enough to *run* the sample, but the 3-tenant story is the whole point.

### 2. Configure + run

```bash
cp .env.example .env.local
# Edit .env.local — paste 3 triples of TENANT_*_VP_SK + TENANT_*_SS + TENANT_*_WHSEC

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
  // In production: SELECT vp_sk_encrypted, ss_encrypted, whsec_encrypted
  //                FROM merchant_tenants WHERE id = $1
  // Decrypt at request time. Never log raw secrets.
  const upper = tenantId.replace(/^tenant_/, "").toUpperCase();
  return {
    vpSk: process.env[`TENANT_${upper}_VP_SK`]!,
    ss: process.env[`TENANT_${upper}_SS`]!,
    webhookSecret: process.env[`TENANT_${upper}_WHSEC`]!,
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

Browser refreshes, network blips, and middleware retries can cause the same charge POST to land twice. The Idempotency-Key turns the second call into a no-op (returns the same session). **Send one on every connector POST.** The SDK forwards it as the `Idempotency-Key` header.

### Multi-tenant webhook routing + per-tenant verification

```typescript
// app/api/webhooks/route.ts
const rawBody = await req.text();                  // 1. raw body for HMAC
const signature = req.headers.get("x-vonpay-signature");
const peek = JSON.parse(rawBody);                  // 2. peek at merchantId (no side effects)
const tenant = findTenantByVonPayMerchantId(peek.merchantId);
const { webhookSecret } = getTenantCredentials(tenant.id);  // 3. fetch tenant's whsec_*
const event = vonpay.webhooks.constructEvent(rawBody, signature, webhookSecret);  // 4. VERIFY
// 5. ...now we trust the data. Update DB, fire downstream effects.
```

The signature is verified using the **tenant's** per-endpoint `whsec_*` secret (not the API key, not a platform-wide secret), so we need to know who the tenant is *before* verification. The 2-step "peek then verify" pattern is safe because JSON-parsing a string has no side effects — we only act on the data after step 4 succeeds.

`constructEvent` takes **three** arguments — `(rawBody, signatureHeader, whsec)`. The signed timestamp lives inside the `x-vonpay-signature` header (`t=<unix>,v1=<hex>`); there is no separate timestamp header.

### Idempotent event processing

```typescript
const eventKey = `${event.sessionId}:${event.event}:${event.timestamp}`;
if (!dedupe(eventKey)) {
  return NextResponse.json({ received: true, deduped: true });
}
```

Webhook deliveries are retried on failure. The receiver must dedupe. The sample composes a key from `sessionId + event-type + timestamp` and tracks it in an in-memory Map; production should use Redis or a persistent store so dedup works across instances.

## Going to production

- **DB-backed credential storage** — replace the env-var lookup with a real query, encrypted columns, decrypt at request time. Never log raw `vp_sk_*`, `ss_*`, or `whsec_*` values.
- **Tenant offboarding** — when you offboard a merchant, mark their tenant row inactive. The webhook handler should 200-and-ignore events for offboarded tenants (don't 401, that signals a bug to Von Payments).
- **Webhook idempotency** — replace the in-memory Map with Redis or a short-TTL DB table. Across multiple instances or auto-scaling, in-memory dedup misses cross-instance retries.
- **Per-tenant audit log** — every charge call + webhook event should write to a per-tenant audit log. Helps diagnose merchant disputes ("we never charged that customer") and is usually required for compliance.
- **Switch from `vp_sk_test_*` to `vp_sk_live_*`** per tenant after each merchant clears KYC + contract — see [Going Live](https://docs.vonpay.com/guides/going-live). Rotate the live `whsec_*` on a schedule per [Webhook Signing Secrets](https://docs.vonpay.com/integration/webhook-secrets).

## What this sample doesn't cover

- **Per-tenant rate limiting** — your platform should rate-limit charge POSTs per tenant to prevent abuse; not shown here.
- **Outbound webhooks to your merchants** — your platform may want to forward `session.succeeded` events to the merchant's own webhook URL (their internal CRM, fulfillment system). Not in scope of this sample.
- **Captures, voids, and refunds** — the SDK exposes `paymentIntents.capture`, `paymentIntents.void`, and `refunds.create` natively. A platform would call these with the tenant's `vp_sk`, the same way `/api/charge` does for sessions.

## Tested against

`@vonpay/checkout-node@0.9.1` · last verified 2026-06-05
