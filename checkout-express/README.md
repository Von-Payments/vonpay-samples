# Von Payments Checkout — Express sample

Minimal end-to-end reference integration on Express 5: create a session, redirect the buyer to `checkout.vonpay.com`, verify the signed return redirect on `/success`, and verify HMAC webhooks on `/webhooks`.

- **Stack:** Express 5, TypeScript (run via `tsx`)
- **Von Payments SDK:** `@vonpay/checkout-node@^0.9.0`
- **What it demonstrates:** session creation, signed return verification, HMAC webhook verification with raw-body parsing

## 5-minute setup

### 1. Get test keys

Sign up at [app.vonpay.com](https://app.vonpay.com), complete OTP, then `/dashboard/developers` → **Create sandbox**. Copy the values from the banner (only shown once):

- `vp_sk_test_...` — secret API key
- `ss_test_...` — session signing secret (used to verify redirect signatures)

### 2. Install and run

```bash
export VON_PAY_SECRET_KEY=vp_sk_test_...
export VON_PAY_SESSION_SECRET=ss_test_...

npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), click the **Pay** button, complete checkout at `checkout.vonpay.com`, watch the redirect come back signed and verified on `/success`.

### 3. Watch the webhook

Webhooks arrive at `POST /webhooks`. For local dev, tunnel your port and point the webhook URL at the tunnel:

```bash
# In another terminal
ngrok http 3000
# Register https://<id>.ngrok.io/webhooks in /dashboard/developers/webhooks
```

## How it works

```
server.ts        — Express server: /, /checkout, /webhooks, /success, /health
```

The `sessions.create()` call returns `{ id, checkoutUrl, expiresAt }`. The server redirects the buyer to `checkoutUrl`. After payment, the buyer is redirected back to `/success` with a signed query string that `VonPayCheckout.verifyReturnSignature(params, sessionSecret, ...)` validates.

Webhooks carry an `x-vonpay-signature` header of the form `t=<unix-seconds>,v1=<hex>` (the timestamp is inside the header — there is no separate timestamp header). `vonpay.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret)` verifies the HMAC, checks the timestamp is within the freshness window (≤5 min old, ≤30 sec future), and returns a parsed `WebhookEvent` discriminated union. The secret is your **per-endpoint signing secret** (`whsec_…`, set as `VON_PAY_WEBHOOK_SECRET`) — not your API key.

## Security notes

- **Always use raw body for webhook verification.** This sample mounts `express.text({ type: "application/json" })` only on `/webhooks` so the body is a `string`, not a parsed object.
- **Pin the SDK.** `"latest"` drifts silently; this sample pins `^0.9.0`.
- **Three different secrets.** The webhook signing secret (`whsec_…`, set as `VON_PAY_WEBHOOK_SECRET`) signs webhooks. The API key (`vp_sk_*`) authenticates API calls. The session signing secret (`ss_*`) signs return-URL redirects.

## Related

- [Quickstart](https://docs.vonpay.com/quickstart)
- [Node SDK reference](https://docs.vonpay.com/sdks/node-sdk)
- [Webhook verification guide](https://docs.vonpay.com/integration/webhook-verification)
- `samples/checkout-nextjs` — same flow on Next.js App Router
- `samples/checkout-flask` — Python equivalent
