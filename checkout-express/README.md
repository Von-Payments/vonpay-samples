# Von Payments Checkout — Express sample

Server-only reference integration for the **cart → redirect** pattern using the Node.js SDK on Express. A merchant server creates a session, redirects the buyer to `checkout.vonpay.com`, and verifies both the signed return redirect and the HMAC-signed webhook when the session resolves.

- **Stack:** Node 20+, Express 5, TypeScript strict, ESM
- **SDK:** [`@vonpay/checkout-node@^0.4.0`](https://www.npmjs.com/package/@vonpay/checkout-node)
- **Best for:** headless backends, API-only flows, server-rendered apps with no frontend framework

## What it demonstrates

| Feature | Where |
|---|---|
| Session creation with line items | `server.ts` → `POST /checkout` |
| Return URL signature verification (v1 + v2 auto-detect) | `server.ts` → `GET /success` |
| HMAC-SHA256 webhook signature verification | `server.ts` → `POST /webhooks` |
| Health check (SDK → API connectivity) | `server.ts` → `GET /health` |

## 5-minute setup

### 1. Get sandbox keys

Sign up at [app.vonpay.com](https://app.vonpay.com), complete OTP, then `/dashboard/developers` → **Activate Vora Sandbox**. You'll get:

- `vp_sk_test_...` — secret API key
- `ss_test_...` — session signing secret

### 2. Configure + run

```bash
cp .env.example .env
# edit .env — paste in vp_sk_test_... and ss_test_...

npm install
npm run dev
```

Open `http://localhost:3000`, click **Pay $25.00**, complete checkout with a [test card](https://docs.vonpay.com/reference/test-cards) (e.g. `4242 4242 4242 4242`), watch the return page render with the verified session details.

### 3. Test the webhook (optional)

To exercise webhook verification locally, expose port 3000 via [`ngrok`](https://ngrok.com) or [`cloudflared`](https://github.com/cloudflare/cloudflared) and register the public URL as your webhook endpoint in the dashboard. Then complete a checkout and watch `Webhook received: session.succeeded` log.

## File layout

```
checkout-express/
├── server.ts          # Express app — all routes + handlers
├── package.json
├── tsconfig.json
└── .env.example
```

## Key code

**Session creation** — `server.ts`:

```typescript
const session = await vonpay.sessions.create({
  amount: 2500,
  currency: "USD",
  successUrl: `http://localhost:${port}/success`,
  cancelUrl: `http://localhost:${port}/`,
  lineItems: [{ name: "Sample Item", quantity: 1, unitAmount: 2500 }],
});
res.redirect(303, session.checkoutUrl);
```

**Return signature verification** — `GET /success`:

```typescript
const valid = VonPayCheckout.verifyReturnSignature(params, sessionSecret, {
  expectedSuccessUrl: `http://localhost:${port}/success`,
  expectedKeyMode: apiKey.includes("_test_") ? "test" : "live",
  maxAgeSeconds: 600,
});
```

The SDK auto-detects v1 vs v2 signatures from the `sig` parameter prefix; pass v2 options unconditionally — v1 ignores them. See [docs.vonpay.com/integration/handle-return](https://docs.vonpay.com/integration/handle-return) for the full spec.

**Webhook verification** — `POST /webhooks`:

```typescript
const event = vonpay.webhooks.constructEvent(
  rawBody,
  req.headers["x-vonpay-signature"],
  apiKey,
  req.headers["x-vonpay-timestamp"],
);
```

The handler must read the **raw** request body (note the `express.text({ type: "application/json" })` middleware before `express.json()`) so the HMAC matches byte-for-byte.

## Going to production

- Move `VON_PAY_SECRET_KEY` and `VON_PAY_SESSION_SECRET` into your secret manager (AWS Secrets Manager, HashiCorp Vault, Doppler, etc.). Never commit them.
- Switch from `vp_sk_test_*` to `vp_sk_live_*` after KYC + contract review — see [Going Live](https://docs.vonpay.com/guides/going-live).
- Add idempotency to the webhook handler — `event.id` is unique per delivery; cache seen IDs (Redis recommended) to handle retries.
- Add request-rate limiting on `POST /checkout` to prevent abuse.

## Tested against

`@vonpay/checkout-node@^0.4.0` · last verified 2026-04-28
