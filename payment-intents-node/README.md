# Payment Intents — Node sample

Server-side payment intent flow: **authorize → capture → partial refund**, plus an idempotency replay. Single-script Node.js demo against the Vonpay Checkout API.

- **Stack:** Node 20+, TypeScript strict, ESM
- **SDK:** [`@vonpay/checkout-node@0.5.0`](https://www.npmjs.com/package/@vonpay/checkout-node)
- **Best for:** B2B / invoicing flows, headless billing where the merchant server drives the lifecycle (no hosted checkout)

## What it demonstrates

| Step | Endpoint | How it's called |
|---|---|---|
| 1. Create a manual-capture intent | `POST /v1/payment_intents` | `vonpay.paymentIntents.create()` |
| 2. Capture the full authorized amount | `POST /v1/payment_intents/{id}/capture` | raw `fetch` (see note below) |
| 3. Partial refund | `POST /v1/refunds` | raw `fetch` (see note below) |
| 4. Idempotency replay | `POST /v1/payment_intents` (same `Idempotency-Key`) | `vonpay.paymentIntents.create()` |

> **SDK surface note.** Published `@vonpay/checkout-node@0.5.0` exposes only `paymentIntents.create` and `capabilities.get`. Capture and refund use raw `fetch` here — same auth, same headers, same idempotency semantics. When `0.6.x` ships, swap them for `vonpay.paymentIntents.capture()` and `vonpay.refunds.create()`.

## Setup

### 1. Get a sandbox key

[vonpay.com/developers](https://vonpay.com/developers) → **Activate Vora Sandbox** in the dashboard. You'll get a `vp_sk_test_…` secret key — that's all this sample needs.

### 2. Configure + run

```bash
cp .env.example .env
# edit .env — paste in vp_sk_test_...

npm install
npm run dev
```

The script runs once and exits. Expected output (sandbox happy path):

```
payment-intents-node sample { baseUrl: 'https://checkout-staging.vonpay.com', runId: '...' }
created { id: 'vpi_test_...', status: 'authorized', captureMethod: 'manual', amount: 2500, currency: 'USD' }
captured { id: 'vpi_test_...', status: 'succeeded', amount: 2500 }
refunded { id: 'vpr_test_...', paymentIntent: 'vpi_test_...', amount: 500, status: 'succeeded' }
idempotency-replay { replayedId: 'vpi_test_...', originalId: 'vpi_test_...', matched: true }
done
```

The two intent IDs in `idempotency-replay` are identical because the server short-circuited the second call on the same `Idempotency-Key`.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Run `server.ts` once via `tsx` (no build step) |
| `npm start` | Same script through `ts-node/esm` (CI-friendlier) |
| `npm run typecheck` | `tsc --noEmit` against `server.ts` — runs in CI before publish |

## Configuration

| Env var | Required | Default |
|---|---|---|
| `VON_PAY_SECRET_KEY` | yes | — |
| `VON_PAY_BASE_URL` | no | `https://checkout-staging.vonpay.com` |

The default base URL is staging because the sample is shipped with sandbox keys in mind. Point at `https://checkout.vonpay.com` once you've moved to a live `vp_sk_live_…` key.

## How idempotency works here

Each run generates a single `runId` and derives three keys from it:

- `pi-create-{runId}` — used for the original create AND the replay
- `pi-capture-{runId}` — used for the capture
- `pi-refund-{runId}` — used for the refund

Re-running the script gives you a fresh `runId`, so you get a fresh authorize. Replaying *within* a single run with the create key returns the original intent verbatim — that's the property the last step verifies.

## Error handling

Each step is wrapped in `try`/`catch`. Both `VonPayError` (from the SDK) and the raw-fetch error path log:

- `code` — machine-readable error code (e.g. `validation_invalid_amount`, `invalid_transition`)
- `status` — HTTP status
- `requestId` — `X-Request-Id` header, paste this when filing a support ticket
- `currentStatus` + `rejectReason` — populated on `422 invalid_transition` from the lifecycle endpoints

## Going to production

- Move `VON_PAY_SECRET_KEY` into your secret manager (AWS Secrets Manager, Vault, Doppler, etc.). Never commit it.
- Treat `Idempotency-Key` as required, not optional. Use a deterministic value tied to the upstream order (e.g. `order:{order_id}:authorize`) so retries collapse cleanly.
- Read `vonpay.capabilities.get()` once at startup — it tells you whether `void_after_capture` is `rerouted_to_refund` (most processors), so you can branch between void and refund without round-tripping a failed call.
- Inspect `intent.status` after `create`. Sandbox returns `failed` for amount `200` (deterministic decline trigger) — your code should handle the decline path, not just the happy path.

## Reference docs

- [Payment intents guide](https://docs.vonpay.com/integration/payment-intents) — full lifecycle walkthrough
- [Test cards + sandbox triggers](https://docs.vonpay.com/reference/test-cards)
- [Error codes](https://docs.vonpay.com/reference/error-codes)

## Tested against

`@vonpay/checkout-node@0.5.0` — last verified 2026-05-06.
