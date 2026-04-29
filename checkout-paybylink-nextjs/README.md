# Von Payments Checkout — Pay-by-Link (Next.js sample)

Reference integration for the **pay-by-link** pattern: a merchant operator creates a hosted-checkout session from a dashboard form, shares the resulting `checkoutUrl` as a link or QR code, and watches the status update when the webhook arrives. Same `sessions.create()` surface as the cart → redirect flow, different UX: no cart, no per-buyer client code — the merchant is the one creating the session.

- **Stack:** Next.js 15 App Router, React 19, TypeScript strict
- **Von Payments SDK:** `@vonpay/checkout-node@^0.4.0`
- **What it demonstrates:** session creation for asynchronous payment, QR-code rendering, webhook-driven status updates, client-side polling of link status, signed return verification (v1 + v2 auto-detect), security headers (CSP / HSTS / X-Frame-Options)

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

Open [http://localhost:3000](http://localhost:3000) — the root redirects to `/links`. Fill in the form, click **Create pay link**, share the URL or QR. When the buyer completes payment, `/api/webhooks` receives `session.succeeded` and flips the link's status to `paid`. The detail page polls every 5 seconds while the status is `pending`, so the badge updates without a manual refresh.

> **Dev-mode caveat:** the in-memory store in `lib/storage.ts` resets on every Next.js dev-server hot-reload (any file save). Create a link, then avoid editing files until you're done testing, or swap in a persistent store.

### 3. Register the webhook

Webhooks arrive at `/api/webhooks`. For local dev, tunnel your port and point the webhook URL at the tunnel:

```bash
# In another terminal
ngrok http 3000
# Register https://<id>.ngrok.io/api/webhooks in /dashboard/developers/webhooks
```

Without a webhook registered, the status stays `pending` — the signed return redirect at `/confirm` still verifies correctly, but the dashboard won't know the session completed.

## How it works

```
app/page.tsx                       — redirects to /links
app/links/page.tsx                 — dashboard (client): form + table of created links
app/links/[id]/page.tsx            — detail (server): URL, QR SVG, status poller, metadata
app/links/[id]/status-poller.tsx   — client component: polls /api/links/[id] every 5s
app/confirm/page.tsx               — signed return verification (v1/v2 auto-detect)
app/api/links/route.ts             — POST create / GET list
app/api/links/[id]/route.ts        — GET single link
app/api/webhooks/route.ts          — HMAC webhook verification + in-memory status update
lib/storage.ts                     — in-memory link store (dev-only; swap for DB in prod)
next.config.ts                     — CSP / HSTS / X-Frame-Options / Referrer-Policy headers
```

The `sessions.create()` call is the same one the cart → redirect sample makes — the difference is that here the merchant operator creates the session ahead of time (no buyer cart) and surfaces the URL out-of-band (email, SMS, QR). `cancelUrl` points back at the link detail page so a buyer who bails can resume from the same link.

Webhooks carry an `X-VonPay-Signature` HMAC header. `vonpay.webhooks.constructEvent(rawBody, signature, secretKey, timestamp)` verifies the signature, checks the timestamp is within the ±5-minute replay window, and returns a parsed `WebhookEvent` discriminated union. This sample listens for `session.succeeded`, `session.failed`, and `session.expired` to update the link's status.

## Security notes

- **Always use raw body for webhook verification.** Next.js route handlers give you `req.text()` — use it directly, don't `JSON.parse()` first.
- **Pin the SDK.** `"latest"` drifts silently; this sample pins `^0.1.3`.
- **In-memory storage is dev-only.** `lib/storage.ts` uses a `Map` that resets on server restart. In production, persist to Postgres / SQLite / Redis and scope link rows to the authenticated merchant operator.
- **Secret key and session signing secret are different.** The API key (`vp_sk_*`) signs webhooks. The session signing secret (`ss_*`) signs return-URL redirects. Never swap them — your code will fail open or fail closed in subtle ways.
- **Security headers ship in `next.config.ts`.** Remove them only if you have a deliberate reason.
- **Link URLs are bearer tokens.** Anyone with a `checkoutUrl` can complete the payment on that session. Treat them like one-time tokens: use TLS everywhere, expire them server-side, and don't email them through unencrypted channels.

## Deploying

1. Set `VON_PAY_SECRET_KEY`, `VON_PAY_SESSION_SECRET`, and `NEXT_PUBLIC_BASE_URL` as environment variables in your host (Vercel, Railway, etc.).
2. Set `NEXT_PUBLIC_BASE_URL` to the production URL of the deployed app — the `successUrl` binding in v2 signatures requires byte-exact canonical URL matching.
3. Register the webhook at your production `/api/webhooks` URL in `/dashboard/developers/webhooks`. Verify signatures fire correctly via the "Send test event" button in the dashboard.
4. **Replace `lib/storage.ts` with a real database** before handing this to real merchants.

## Who this sample is for

A merchant operator who wants to share a checkout link out-of-band (email, SMS, QR code) — invoices, deposits, ad-hoc payment requests. Same `sessions.create()` API as the cart-redirect sample, different distribution shape.

If you're instead building a **platform/CRM connector** integrating Vora into someone else's product, start at the [Platforms integration spec](https://docs.vonpay.com/platforms) and the [Platform Integrator Sandbox guide](https://docs.vonpay.com/guides/platform-sandbox).

## Related

- [Quickstart](https://docs.vonpay.com/quickstart)
- [Node SDK reference](https://docs.vonpay.com/sdks/node-sdk)
- [Webhook verification guide](https://docs.vonpay.com/integration/webhook-verification)
- [Sandbox guide](https://docs.vonpay.com/guides/sandbox)
- [Platforms integration spec](https://docs.vonpay.com/platforms) — for CRM/cart connector authors
- [Platform Integrator Sandbox](https://docs.vonpay.com/guides/platform-sandbox) — for ISV dev teams
- `samples/checkout-nextjs` — cart → redirect pattern (Shopify-style checkout button)
