# Saved cards + MIT — Node sample

Server-side **save-a-card, then rebill it** flow: vault a reusable card, run the cardholder-initiated anchor charge, then fire a **merchant-initiated (MIT)** recurring renewal against the card on file. Single-script Node.js demo against the Vonpay Checkout API.

- **Stack:** Node 20+, TypeScript strict, ESM
- **SDK:** [`@vonpay/checkout-node@^0.9.0`](https://www.npmjs.com/package/@vonpay/checkout-node)
- **Best for:** Subscriptions, recurring billing, scheduled installments, retry/dunning loops — anywhere you charge a saved card while the buyer is not present.

## What it demonstrates

| Step | Endpoint | How it's called |
|---|---|---|
| 1. Read the capability matrix | `GET /v1/capabilities` | `vonpay.capabilities.get()` |
| 2. Vault a reusable card (off-session consent) | `POST /v1/tokens` | `vonpay.tokens.create({ setupForFutureUse: "off_session" })` |
| 3. Cardholder-initiated anchor charge (CIT) | `POST /v1/payment_intents` | `vonpay.paymentIntents.create({ payment_method: { id } })` |
| 4. Merchant-initiated recurring charge (MIT) | `POST /v1/payment_intents` | `vonpay.paymentIntents.create({ payment_method: { id }, mit: { … } })` |

Every step is a typed SDK method — no raw `fetch`, no hand-rolled signing.

## The save-card / MIT model

A **saved card** is a vault token (`vp_pmt_*`) created with a reusability scope, `setupForFutureUse`:

- omitted / `null` — **single-use**: only the originating intent may use it.
- `"on_session"` — reusable while the buyer is interactively present (e.g. one-click upsells).
- `"off_session"` — reusable when the buyer is **absent**. Required for recurring / MIT.

To **charge** a saved card, pass it back as `payment_method: { id: token.id }` on `paymentIntents.create` — both the cardholder-initiated anchor and every merchant-initiated renewal reference the same vaulted token this way. (`payment_method` is a documented request field that isn't on the typed `CreatePaymentIntentParams` in 0.9.1 yet, so the sample widens the param type locally via a small `ChargeParams` bridge; it rides through at runtime.)

A **merchant-initiated transaction (MIT)** is any charge you drive against that card while the buyer is away — a subscription renewal, a retry, a scheduled installment. Scheme rules require MITs to be tagged and chained to the original cardholder-consent transaction, so `paymentIntents.create` takes an extra `mit` block:

| Field | Values | Notes |
|---|---|---|
| `initiator` | `"merchant"` \| `"customer"` | `"merchant"` for pure server-driven renewals/retries. |
| `reason` | `"recurring"` \| `"unscheduled"` \| `"installment"` | `recurring` = fixed-cadence subscription; `unscheduled` = retry / variable cadence; `installment` = fixed-count plan. |
| `originalTransactionId` | `vpi_(test\|live)_*` | The **first, cardholder-initiated** intent in the chain — where consent was captured. The chain anchors here for scheme compliance. |

> **You own the rebill loop.** Vonpay vaults the token and relays the charge. You keep the token reference (server-side, keyed to your customer), run the scheduler that fires "charge customer X on day N", handle dunning on failure, and own the subscription state machine. The MIT primitives are the substrate you build that loop on.

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

The script runs once and exits. Expected output on a sandbox key (which reports `mit: false`):

```
saved-cards-mit sample { baseUrl: 'https://checkout.vonpay.com', runId: '...' }
capabilities { mit: false, networkTokens: false }
vaulted card { id: 'vp_pmt_test_...', status: 'active', setupForFutureUse: 'off_session', card: 'visa •••• 4242 (12/2030)' }
anchor charge (CIT) { id: 'vpi_test_...', status: 'succeeded', amount: 2999, currency: 'USD', declineCode: null }
skipping MIT renewal — supportedOperations.mit is false { hint: '...', anchorTransactionId: 'vpi_test_...' }
done (anchor + saved card only)
```

On a **live processor with MIT support enabled** (`mit: true`), the script continues into step 4 and you'll also see:

```
renewal charge (MIT) { id: 'vpi_live_...', status: 'succeeded', amount: 2999, currency: 'USD', declineCode: null }
done { savedCard: 'vp_pmt_live_...', anchorTransactionId: 'vpi_live_...', renewalTransactionId: 'vpi_live_...' }
```

> **Sandbox gates MIT off.** `supportedOperations.mit` is `false` on sandbox keys, so the sample stops cleanly after the anchor charge rather than faking a renewal. This is exactly how your code should behave — branch on the capability matrix, never hard-code per-processor assumptions. To exercise the full MIT path, run against a live key whose processor has MIT enabled.

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
| `VON_PAY_BASE_URL` | no | `https://checkout.vonpay.com` |

The default base URL is production (`checkout.vonpay.com`). A `vp_sk_test_` key runs in sandbox mode there, so no host change is needed; set `VON_PAY_BASE_URL` only if support directs you to a different host.

## Where the card details come from

This sample uses a **sandbox** key, where `tokens.create` auto-mints a mock card token for you — no card data crosses your server, which is the point of tokenization.

In production with an iframe-vault provider, the buyer's card never touches your server either. Your browser front-end (e.g. [VORA Mirror](https://docs.vonpay.com/mirror/quickstart)) collects the card in a hosted iframe and mints a vault handle; you pass that handle as `providerReference` to `tokens.create`, along with `setupForFutureUse: "off_session"` to capture reuse consent. The resulting `vp_pmt_*` token is what you keep on file and rebill.

```typescript
const token = await vonpay.tokens.create({
  buyerId: "buyer_42",
  providerReference: browserMintedVaultHandle, // from the iframe submit
  setupForFutureUse: "off_session",
});
```

## How the chain works

```
[buyer present]                         [buyer absent — your scheduler]
  tokens.create (off_session)             paymentIntents.create({
        │  └─ vp_pmt_… token id            payment_method: { id: vp_pmt_… },
        ▼                                   mit: {
  paymentIntents.create  ──── anchor ───────▶ initiator: "merchant",
  ({ payment_method:       vpi_… id           reason: "recurring",
     { id: vp_pmt_… } })                       originalTransactionId: vpi_…
  (cardholder-initiated)                     }
  status: succeeded                         })
```

The MIT must anchor on a **succeeded, cardholder-initiated** intent. The sample stops if the anchor charge doesn't reach `succeeded` (decline, 3DS pending) — there's nothing to rebill against until consent has actually been captured.

Server-side, every MIT runs a chain-validity check before dispatch:

- `originalTransactionId` must belong to the same merchant.
- It must be on the same processor (or the merchant must have network-token support for cross-processor chains).
- It must be a chargeable anchor — a real cardholder-initiated intent, not another MIT in the chain.

Violations surface as a `VonPayError` with a `code` and (on a state-machine rejection) a `rejectReason` you can branch on.

## Idempotency

Each run derives deterministic keys from a single `runId`:

- `token-{runId}` — the vault create
- `{subscriptionId}-anchor` — the cardholder-initiated charge
- `{subscriptionId}-cycle-2` — the renewal

In production, tie the renewal key to the billing cycle (e.g. `sub_8821-cycle-2026-05`) so a retried renewal job collapses to a single charge instead of double-billing the customer.

## Error handling

Each step is wrapped in `try`/`catch`. `VonPayError` (thrown by every SDK method) carries:

- `code` — machine-readable error code (e.g. `validation_invalid_amount`, `payment_method_consent_missing`, `invalid_transition`)
- `status` — HTTP status
- `requestId` — `X-Request-Id` header; paste this when filing a support ticket
- `currentStatus` + `rejectReason` — populated on lifecycle-endpoint state rejections

If the token isn't vaulted off-session, the MIT charge would be rejected with `payment_method_consent_missing` — the sample checks `token.setupForFutureUse` up front and bails with a clear message rather than chasing that 422 later.

## Going to production

- Move `VON_PAY_SECRET_KEY` into your secret manager (AWS Secrets Manager, Vault, Doppler, etc.). Never commit it.
- Persist the `vp_pmt_*` token id and the anchor `vpi_*` id against your customer record — you need both for every future renewal.
- Read `vonpay.capabilities.get()` once at startup and branch on `supportedOperations.mit`. Sandbox returns `false`; a live processor with MIT enabled returns `true`.
- Use a deterministic, cycle-scoped `idempotencyKey` for every renewal so scheduler retries don't double-bill.
- Build the dunning loop: a renewal that returns `failed` (or a `VonPayError`) is the trigger for retry / `unscheduled` MITs and your subscription state machine.

## Reference docs

- [Payment intents guide — saved cards / MIT](https://docs.vonpay.com/integration/payment-intents#saved-cards--merchant-initiated-mit-charges)
- [Tokenization — reusability model](https://docs.vonpay.com/mirror/tokenization)
- [Test cards + sandbox triggers](https://docs.vonpay.com/reference/test-cards)
- [Error codes](https://docs.vonpay.com/reference/error-codes)

## Tested against

`@vonpay/checkout-node@0.9.1` — typecheck verified 2026-06-05.
