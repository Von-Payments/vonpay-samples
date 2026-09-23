# Von Payments Checkout — Next.js sample

End-to-end reference integration for the **cart → redirect** pattern (Shopify-style hosted checkout). A merchant server creates a session, redirects the buyer to `checkout.vonpay.com`, and confirms the outcome server-side on return and from an HMAC-signed webhook when the session resolves.

- **Stack:** Next.js 15 App Router, React 19, TypeScript strict
- **Von Payments SDK:** `@vonpay/checkout-node` 2.x (`^2`)
- **What it demonstrates:** session creation with an idempotency key, server-side return confirmation, HMAC webhook verification, security headers (CSP / HSTS / X-Frame-Options)

## 5-minute setup

### 1. Get test keys

Sign up at [app.vonpay.com](https://app.vonpay.com), complete OTP, then `/dashboard/developers` → **Create sandbox**. Copy the values you need from the banner (they're only shown once):

- `vp_sk_test_...` — secret API key
- `vp_pk_test_...` — publishable key (not used in this sample)

Then register a webhook endpoint at `/dashboard/developers/webhooks` to get its signing secret (`whsec_...`, shown once).

You do not need a session signing secret (`ss_...`) for this sample. The return redirect is signed with a platform-wide secret no merchant holds, so the sample confirms the payment with your API key instead (see below).

### 2. Install and configure

```bash
cp .env.example .env.local
# edit .env.local with the keys from step 1

npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), click **Pay $25.00**, complete checkout at `checkout.vonpay.com`, watch `/confirm` confirm the payment with an authenticated session read.

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
app/confirm/page.tsx           — Server-side return confirmation (confirmReturn)
app/api/webhooks/route.ts      — HMAC-signed webhook verification
next.config.ts                 — CSP / HSTS / X-Frame-Options / Referrer-Policy headers
```

The `sessions.create()` call receives a fully-typed request plus an idempotency key derived from the order id (a retry that reuses the same order id returns the same session. This sample creates its order id per request, so in your code create the order first and reuse its id — otherwise a double-click or refresh still makes a second session), and returns an `{id, checkoutUrl, expiresAt}` response. The buyer is redirected to `checkoutUrl`; After payment, the buyer is redirected back to `successUrl` with a signed query string. ⚠️ This sample does **not** verify that signature, deliberately: returns are signed with a platform-wide secret no merchant holds, so a per-merchant `ss_*` can only ever fail the check. ``sessions.confirmReturn()`` instead re-reads the session from the API using your own secret key — an authenticated answer to “did this buyer pay”, which the signature never was.

Webhooks carry an `x-vonpay-signature` header of the form `t=<unix-seconds>,v1=<hex>` (the timestamp is inside the header — there is no separate timestamp header). `vonpay.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret)` verifies the HMAC, checks the timestamp is within the freshness window (≤5 min old, ≤30 sec future), and returns a parsed `WebhookEvent` discriminated union. The secret is your **per-endpoint signing secret** (`whsec_…`, set as `VON_PAY_WEBHOOK_SECRET`) — not your API key.

## Security notes

- **Always use raw body for webhook verification.** Next.js route handlers give you `req.text()` — use it directly, don't `JSON.parse()` first.
- **Pin the SDK.** `"latest"` drifts silently; this sample pins the major (`^2`) and commits a lockfile.
- **Two different secrets.** The webhook signing secret (`whsec_…`, set as `VON_PAY_WEBHOOK_SECRET`) signs webhooks. The API key (`vp_sk_*`) authenticates API calls and is what confirms a return. A per-merchant session signing secret (`ss_*`) is not used: it cannot verify the return redirect. Never swap them.
- **Security headers ship in `next.config.ts`.** Remove them only if you have a deliberate reason.

## Deploying

1. Set `VON_PAY_SECRET_KEY`, `VON_PAY_WEBHOOK_SECRET`, and `NEXT_PUBLIC_BASE_URL` as environment variables in your host (Vercel, Fly.io, AWS, etc.).
2. Set `NEXT_PUBLIC_BASE_URL` to the production URL of the deployed app — `/confirm` checks that the return landed on the exact `successUrl` the session was created with.
3. Register the webhook at your production `/api/webhooks` URL in `/dashboard/developers/webhooks`. Verify signatures fire correctly via the "Send test event" button in the dashboard.

## Who this sample is for

A merchant or developer integrating Von Payments into a single-product checkout (cart → redirect). If you're instead building a **platform / CRM connector** that integrates Von Payments inside another product (a CRM, ISV cart platform, or similar), start at the [Platforms integration spec](https://docs.vonpay.com/platforms) and the [Platform Integrator Sandbox guide](https://docs.vonpay.com/guides/platform-sandbox) — the API surface and sandbox provisioning are the same as this sample exercises, but the deployment shape is different.

## Related

- [Quickstart](https://docs.vonpay.com/quickstart)
- [Node SDK reference](https://docs.vonpay.com/sdks/node-sdk)
- [Webhook verification guide](https://docs.vonpay.com/integration/webhook-verification)
- [Sandbox guide](https://docs.vonpay.com/guides/sandbox)
- [Platforms integration spec](https://docs.vonpay.com/platforms) — for CRM/cart connector authors
- [Platform Integrator Sandbox](https://docs.vonpay.com/guides/platform-sandbox) — for ISV dev teams
