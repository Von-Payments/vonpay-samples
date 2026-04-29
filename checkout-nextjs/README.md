# Von Payments Checkout — Next.js sample

End-to-end reference integration for the **cart → redirect** pattern (Shopify-style hosted checkout). A merchant server creates a session, redirects the buyer to `checkout.vonpay.com`, and receives both a signed return redirect and an HMAC-signed webhook when the session resolves.

- **Stack:** Next.js 15 App Router, React 19, TypeScript strict
- **Von Payments SDK:** `@vonpay/checkout-node@^0.4.0`
- **What it demonstrates:** session creation, signed return verification (v1 + v2 auto-detect), HMAC webhook verification, security headers (CSP / HSTS / X-Frame-Options)

## 5-minute setup

### 1. Get test keys

Sign up at [app.vonpay.com](https://app.vonpay.com), complete OTP, then `/dashboard/developers` → **Create sandbox**. Copy the three values from the banner (they're only shown once):

- `vp_sk_test_...` — secret API key
- `vp_pk_test_...` — publishable key (not used in this sample)
- `ss_test_...` — session signing secret (used to verify redirect signatures)

### 2. Install and configure

```bash
cp .env.example .env.local
# edit .env.local with the keys from step 1

npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), click **Pay $25.00**, complete checkout at `checkout.vonpay.com`, watch the redirect come back signed and verified on `/confirm`.

### 3. Watch the webhook

Webhooks arrive at `/api/webhooks`. For local dev, tunnel your port and point the webhook URL at the tunnel:

```bash
# In another terminal
ngrok http 3000
# Copy the https://<id>.ngrok.io/api/webhooks URL
# Register it in /dashboard/developers/webhooks
```

Or use [webhook.site](https://webhook.site) to inspect deliveries without local tunneling.

## How it works

```
app/page.tsx                   — "Pay $25.00" button (client)
app/api/checkout/route.ts      — POST → vonpay.sessions.create(), returns checkoutUrl
app/confirm/page.tsx           — Signed return verification (v1/v2 auto-detect)
app/api/webhooks/route.ts      — HMAC-signed webhook verification
next.config.ts                 — CSP / HSTS / X-Frame-Options / Referrer-Policy headers
```

The `sessions.create()` call receives a fully-typed request and returns an `{id, checkoutUrl, expiresAt}` response. The buyer is redirected to `checkoutUrl`; after payment they're redirected back to `successUrl` with a signed query string that `VonPayCheckout.verifyReturnSignature(params, sessionSecret, ...)` validates.

Webhooks carry an `X-VonPay-Signature` HMAC header. `vonpay.webhooks.constructEvent(rawBody, signature, secretKey, timestamp)` verifies the signature, checks the timestamp is within the ±5-minute replay window, and returns a parsed `WebhookEvent` discriminated union.

## Security notes

- **Always use raw body for webhook verification.** Next.js route handlers give you `req.text()` — use it directly, don't `JSON.parse()` first.
- **Pin the SDK.** `"latest"` drifts silently; this sample pins `^0.1.3` and the `VONPAY_CHECKOUT_NODE_VERSION` badge in package.json is the canonical reference.
- **Secret key and session signing secret are different.** The API key (`vp_sk_*`) signs webhooks. The session signing secret (`ss_*`) signs return-URL redirects. Never swap them — your code will fail open or fail closed in subtle ways.
- **Security headers ship in `next.config.ts`.** Remove them only if you have a deliberate reason.

## Deploying

1. Set `VON_PAY_SECRET_KEY`, `VON_PAY_SESSION_SECRET`, and `NEXT_PUBLIC_BASE_URL` as environment variables in your host (Vercel, Railway, etc.).
2. Set `NEXT_PUBLIC_BASE_URL` to the production URL of the deployed app — the `successUrl` binding in v2 signatures requires byte-exact canonical URL matching.
3. Register the webhook at your production `/api/webhooks` URL in `/dashboard/developers/webhooks`. Verify signatures fire correctly via the "Send test event" button in the dashboard.

## Who this sample is for

A merchant or developer integrating Von Payments into a single-product checkout (cart → redirect pattern). If you're instead building a **platform/CRM connector** that needs to integrate Vora alongside other gateways inside someone else's product (subscription-billing CRMs, ISV cart platforms, headless commerce platforms), start at the [Platforms integration spec](https://docs.vonpay.com/platforms) and the [Platform Integrator Sandbox guide](https://docs.vonpay.com/guides/platform-sandbox) — the API surface and sandbox provisioning are the same as this sample exercises, but the deployment shape is different.

## Related

- [Quickstart](https://docs.vonpay.com/quickstart)
- [Node SDK reference](https://docs.vonpay.com/sdks/node-sdk)
- [Webhook verification guide](https://docs.vonpay.com/integration/webhook-verification)
- [Sandbox guide](https://docs.vonpay.com/guides/sandbox)
- [Platforms integration spec](https://docs.vonpay.com/platforms) — for CRM/cart connector authors
- [Platform Integrator Sandbox](https://docs.vonpay.com/guides/platform-sandbox) — for ISV dev teams
