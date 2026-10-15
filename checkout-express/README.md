# Von Payments Checkout - Express sample

Minimal end-to-end reference integration on Express 5: create a session, redirect the buyer to `checkout.vonpay.com`, confirm the outcome server-side on `/success`, and verify HMAC webhooks on `/webhooks`.

- **Stack:** Express 5, TypeScript (run via `tsx`)
- **Von Payments SDK:** `@vonpay/checkout-node` 3.x - 3.7.0 or later (`^3.7.0`)
- **What it demonstrates:** session creation with an idempotency key, server-side return confirmation, HMAC webhook verification with raw-body parsing

## 5-minute setup

### 1. Get test keys

Sign up at [app.vonpay.com](https://app.vonpay.com), complete OTP, then `/dashboard/developers` → **Create sandbox**. Copy the values from the banner (only shown once):

- `vp_sk_test_...` - secret API key

Then register a webhook endpoint at `/dashboard/developers/webhooks` to get its signing secret (`whsec_...`, shown once).

You do not need a session signing secret (`ss_...`) for this sample. The return redirect is signed with a platform-wide secret no merchant holds, so the sample confirms the payment with your API key instead (see below).

### 2. Install and run

```bash
export VON_PAY_SECRET_KEY=vp_sk_test_...
export VON_PAY_WEBHOOK_SECRET=whsec_...
# Optional: this app's own public address (defaults to http://localhost:3000).
# Set it when deployed, e.g. https://shop.example.com: the return URL is built
# from it, and on https the checkout cookie is marked Secure.
# export BASE_URL=https://shop.example.com

npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), click the **Pay** button, complete checkout at `checkout.vonpay.com`, watch `/success` confirm the payment with an authenticated session read.

### 3. Watch the webhook

Webhooks arrive at `POST /webhooks`. For local dev, tunnel your port and point the webhook URL at the tunnel:

```bash
# In another terminal
ngrok http 3000
# Register https://<id>.ngrok.io/webhooks in /dashboard/developers/webhooks
```

## How it works

```
server.ts        - Express server: /, /checkout, /webhooks, /success, /health
```

The `sessions.create()` call sends an idempotency key derived from the order id, so a retry that reuses the same order id returns the same session. This sample creates its order id per request, so in your code create the order first and reuse its id - otherwise a double-click or refresh still makes a second session; it returns `{ id, checkoutUrl, expiresAt }`. The server redirects the buyer to `checkoutUrl`. After payment, the buyer is redirected back to `/success` with a signed query string. ⚠️ This sample does **not** verify that signature, deliberately: returns are signed with a platform-wide secret no merchant holds, so a per-merchant `ss_*` can only ever fail the check. ``sessions.confirmReturn()`` instead re-reads the session from the API using your own secret key - an authenticated answer to “did this buyer pay”, which the signature never was.

**Match the return to YOUR order before showing success.** `confirmReturn()` tells you whether *a* session of your account was paid - any session. On its own, a success link copied from another paid order of your shop (a cheap one, say) would show "Payment successful" for this one. So `/checkout` records which order each session is for, on the server (here an in-memory map; use your database), and sets an HttpOnly cookie naming the session. `/success` shows a payment only when the returned session is the one this browser started, has an order record, and was paid the order's amount and currency. Anything else gets a neutral "we couldn't match this payment" page (HTTP 400) - not "payment failed", and no "pay again". This follows the usual practice for hosted checkouts: look your order up by the returned session id in your own records, never trust the URL alone, and fulfil from the webhook.

- **One checkout per browser at a time.** The cookie holds the latest session this browser started. If a buyer opens two checkouts in two tabs and pays the first, its return gets the "couldn't match" page: the payment is still safe and the webhook still fulfils it. A real shop ties the return to the buyer's account or cart, or keeps every open session for the browser.
- **The SDK can do this check for you.** An upcoming release of the SDK adds `expectedSessionId` and `expectedAmount` + `expectedCurrency` to `confirmReturn()`; a mismatch then comes back as not paid. This sample will switch to them once that release is published.

Webhooks carry an `x-vonpay-signature` header of the form `t=<unix-seconds>,v1=<hex>` (the timestamp is inside the header - there is no separate timestamp header). `vonpay.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret)` verifies the HMAC, checks the timestamp is within the freshness window (≤5 min old, ≤30 sec future), and returns a parsed `WebhookEvent` discriminated union. The secret is your **per-endpoint signing secret** (`whsec_…`, set as `VON_PAY_WEBHOOK_SECRET`) - not your API key.

**Check `event.test_event` first.** A delivery from **Send test event** is signed like a real one and can carry a real session's ids, so when it is `true` the handler returns 2xx and does nothing else (the field is typed from SDK 2.7.0; this sample's `^3.7.0` covers it).

## Security notes

- **Always use raw body for webhook verification.** This sample mounts `express.raw({ type: "application/json" })` only on `/webhooks` so the body is the exact bytes that were signed, not a parsed object.
- **Pin the SDK.** `"latest"` drifts silently; this sample pins the major with a 3.7.0 floor (`^3.7.0`) and commits a lockfile.
- **Two different secrets.** The webhook signing secret (`whsec_…`, set as `VON_PAY_WEBHOOK_SECRET`) signs webhooks. The API key (`vp_sk_*`) authenticates API calls and is what confirms a return. A per-merchant session signing secret (`ss_*`) is not used: it cannot verify the return redirect.

## Related

- [Quickstart](https://docs.vonpay.com/quickstart)
- [Node SDK reference](https://docs.vonpay.com/sdks/node-sdk)
- [Webhook verification guide](https://docs.vonpay.com/integration/webhook-verification)
- `samples/checkout-nextjs` - same flow on Next.js App Router
- `samples/checkout-flask` - Python equivalent
