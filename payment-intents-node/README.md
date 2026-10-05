# Payment Intents - Node sample

Server-side payment intent flow: **authorize → capture → partial refund**, plus an idempotency replay. Single-script Node.js demo against the Vonpay Checkout API.

- **Stack:** Node 20+, TypeScript strict, ESM
- **SDK:** [`@vonpay/checkout-node`](https://www.npmjs.com/package/@vonpay/checkout-node) 3.x - 3.4.0 or later (`^3.4.0`)
- **Best for:** B2B / invoicing flows, headless billing where the merchant server drives the lifecycle (no hosted checkout)

## What it demonstrates

| Step | Endpoint | How it's called |
|---|---|---|
| 1. Create a manual-capture intent | `POST /v1/payment_intents` | `vonpay.paymentIntents.create()` |
| 2. Capture the full authorized amount | `POST /v1/payment_intents/{id}/capture` | `vonpay.paymentIntents.capture()` |
| 3. Partial refund | `POST /v1/refunds` | `vonpay.refunds.create()` |
| 4. Idempotency replay | `POST /v1/payment_intents` (same `Idempotency-Key`) | `vonpay.paymentIntents.create()` |

Every step runs through the typed SDK surface - no hand-rolled HTTP. Each call accepts an `{ idempotencyKey }` option so retries collapse cleanly, and lifecycle failures throw a typed `VonPayError` carrying `code`, `status`, `requestId`, and (on `422 invalid_transition`) `currentStatus` + `rejectReason`.

## Setup

### 1. Get a sandbox key

[vonpay.com/developers](https://vonpay.com/developers) → **Activate Vora Sandbox** in the dashboard. You'll get a `vp_sk_test_…` secret key.

Test payments run on a sandbox account backed by a payment provider's test environment, and behave exactly as they would on that provider live. A test key on a live account, or on a sandbox account with no payment provider, is refused with `422 sandbox_account_required`.

### 2. A saved card to charge

Nothing is made up for you in test mode, so the payment intent needs a real saved card (`vp_pmt_test_…`) from your sandbox. Save one with `tokens.create` (see the [saved-cards-mit](../saved-cards-mit) sample) and set it as `VON_PAY_PAYMENT_METHOD`.

Without it, depending on your payment provider, the create is refused with `payment_method_required` or returns `requires_payment_method` (for a front end to finish), and the script stops before capture.

### 3. Configure + run

```bash
cp .env.example .env
# edit .env - paste in vp_sk_test_... and vp_pmt_test_...

npm install
npm run dev
```

The script runs once and exits. Expected output when the card is approved:

```
payment-intents-node sample { baseUrl: 'https://checkout.vonpay.com', runId: '...' }
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
| `npm run typecheck` | `tsc --noEmit` against `server.ts` - runs in CI before publish |

## Configuration

| Env var | Required | Default |
|---|---|---|
| `VON_PAY_SECRET_KEY` | yes | - |
| `VON_PAY_PAYMENT_METHOD` | to run past create | - |
| `VON_PAY_BASE_URL` | no | `https://checkout.vonpay.com` |

The default base URL is production (`checkout.vonpay.com`). A `vp_sk_test_` key runs in sandbox mode there, so no host change is needed; set `VON_PAY_BASE_URL` only if support directs you to a different host.

## How idempotency works here

Each run generates a single `runId` and derives three keys from it:

- `pi-create-{runId}` - used for the original create AND the replay
- `pi-capture-{runId}` - used for the capture
- `pi-refund-{runId}` - used for the refund

Re-running the script gives you a fresh `runId`, so you get a fresh authorize. Replaying *within* a single run with the create key returns the original intent verbatim - that's the property the last step verifies.

## Error handling

Each step is wrapped in `try`/`catch`. Every lifecycle call throws a typed `VonPayError` (from the SDK) on failure, which logs:

- `code` - machine-readable error code (e.g. `validation_invalid_amount`, `invalid_transition`)
- `status` - HTTP status
- `requestId` - `X-Request-Id` header, paste this when filing a support ticket
- `currentStatus` + `rejectReason` - populated on `422 invalid_transition` from the lifecycle endpoints (capture / void / refund), so you can branch (e.g. void → refund) without a follow-up retrieve
- `nextAction` - programmatic decision helper (`fix_input` / `wait_and_retry` / `contact_support` / …) for agent or LLM consumers

## Going to production

- Move `VON_PAY_SECRET_KEY` into your secret manager (AWS Secrets Manager, Vault, Doppler, etc.). Never commit it.
- Treat `Idempotency-Key` as required, not optional. Use a deterministic value tied to the upstream order (e.g. `order:{order_id}:authorize`) so retries collapse cleanly.
- Read `vonpay.capabilities.get()` once at startup - `supportedOperations.voidAfterCapture` tells you whether a post-capture void is `rerouted_to_refund` (most processors), so you can branch between `paymentIntents.void()` and `refunds.create()` without round-tripping a failed call.
- Inspect `intent.status` after `create` - your code should handle the decline path, not just the happy path. In test mode the order total decides a decline, not the card: an ordinary total approves, and an order total of `200012` (2,000.12) is declined by the card's issuer. Save the card with one of your sandbox's test cards (`5200 0000 0000 1203` approves, expiry `03/30`, CVC `100`; common numbers such as `4242 4242 4242 4242` are declined). See [Test mode](https://docs.vonpay.com/reference/test-cards).

## Reference docs

- [Payment intents guide](https://docs.vonpay.com/integration/payment-intents) - full lifecycle walkthrough
- [Test mode - the order totals that decline](https://docs.vonpay.com/reference/test-cards)
- [Error codes](https://docs.vonpay.com/reference/error-codes)

## Tested against

`@vonpay/checkout-node` 3.x - typecheck with `npm run typecheck`. Live sandbox smoke (auth → capture → refund → idempotency replay) requires a `vp_sk_test_…` key.
