# Saved cards + MIT - Node sample

Server-side **save-a-card, then rebill it** flow: vault a reusable card, run the cardholder-initiated anchor charge, then fire a **merchant-initiated (MIT)** recurring renewal against the card on file. Single-script Node.js demo against the Vonpay Checkout API.

- **Stack:** Node 20+, TypeScript strict, ESM
- **SDK:** [`@vonpay/checkout-node`](https://www.npmjs.com/package/@vonpay/checkout-node) 3.x - 3.7.0 or later (`^3.7.0`)
- **Best for:** Subscriptions, recurring billing, scheduled installments, retry/dunning loops - anywhere you charge a saved card while the buyer is not present.

## What it demonstrates

| Step | Endpoint | How it's called |
|---|---|---|
| 1. Read the capability matrix | `GET /v1/capabilities` | `vonpay.capabilities.get()` |
| 2. Vault a reusable card (off-session consent) | `POST /v1/tokens` | `vonpay.tokens.create({ setupForFutureUse: "off_session" })` |
| 3. Cardholder-initiated anchor charge (CIT) | `POST /v1/payment_intents` | `vonpay.paymentIntents.create({ payment_method: { id } })` |
| 4. Merchant-initiated recurring charge (MIT) | `POST /v1/payment_intents` | `vonpay.paymentIntents.create({ payment_method: { id }, mit: { … } })` |

Every step is a typed SDK method - no raw `fetch`, no hand-rolled signing.

## The save-card / MIT model

A **saved card** is a vault token (`vp_pmt_*`) created with a reusability scope, `setupForFutureUse`:

- omitted / `null` - **single-use**: only the originating intent may use it.
- `"on_session"` - reusable while the buyer is interactively present (e.g. one-click upsells).
- `"off_session"` - reusable when the buyer is **absent**. Required for recurring / MIT.

To **charge** a saved card, pass it back as `payment_method: { id: token.id }` on `paymentIntents.create` - both the cardholder-initiated anchor and every merchant-initiated renewal reference the same vaulted token this way. In the Node SDK that is `paymentMethod: { id: token.id }` on the typed `CreatePaymentIntentParams`; the SDK sends it as `payment_method` on the wire.

A **merchant-initiated transaction (MIT)** is any charge you drive against that card while the buyer is away - a subscription renewal, a retry, a scheduled installment. Scheme rules require MITs to be tagged and chained to the original cardholder-consent transaction, so `paymentIntents.create` takes an extra `mit` block:

| Field | Values | Notes |
|---|---|---|
| `initiator` | `"merchant"` \| `"customer"` | `"merchant"` for pure server-driven renewals/retries. |
| `reason` | `"recurring"` \| `"unscheduled"` \| `"installment"` | `recurring` = fixed-cadence subscription; `unscheduled` = retry / variable cadence; `installment` = fixed-count plan. |
| `originalTransactionId` | `vpi_(test\|live)_*` | The **first, cardholder-initiated** intent in the chain - where consent was captured. The chain anchors here for scheme compliance. |

> **You own the rebill loop.** Vonpay vaults the token and relays the charge. You keep the token reference (server-side, keyed to your customer), run the scheduler that fires "charge customer X on day N", handle dunning on failure, and own the subscription state machine. The MIT primitives are the substrate you build that loop on.

## Setup

### 1. Get a sandbox key

[vonpay.com/developers](https://vonpay.com/developers) → **Activate Vora Sandbox** in the dashboard. You'll get a `vp_sk_test_…` secret key.

Test payments run on a sandbox account backed by a payment provider's test environment, and behave exactly as they would on that provider live. A test key on a live account, or on a sandbox account with no payment provider, is refused with `422 sandbox_account_required`.

### 2. The card to save

Nothing is made up for you in test mode: `tokens.create` saves a real card on your sandbox's payment provider test environment, and needs whatever that provider needs - for example a `providerReference`, the vault handle your browser card form returns on submit (see [Where the card details come from](#where-the-card-details-come-from)). Set it as `VON_PAY_PROVIDER_REFERENCE`. A provider that needs one refuses the save without it (`400 validation_error`).

### 3. Configure + run

```bash
cp .env.example .env
# edit .env - paste in vp_sk_test_... and the provider reference

npm install
npm run dev
```

The script runs once and exits. Expected output when the payment provider reports `mit: false`:

```
saved-cards-mit sample { baseUrl: 'https://checkout.vonpay.com', runId: '...' }
capabilities { mit: false, networkTokens: false }
vaulted card { id: 'vp_pmt_test_...', status: 'active', setupForFutureUse: 'off_session', card: '<brand> •••• <last4> (<exp>)' }
anchor charge (CIT) { id: 'vpi_test_...', status: 'succeeded', amount: 2999, currency: 'USD', declineCode: null }
skipping MIT renewal - supportedOperations.mit is false { hint: '...', anchorTransactionId: 'vpi_test_...' }
done (anchor + saved card only)
```

With a **payment provider that has MIT support enabled** (`mit: true`), the script continues into step 4 and you'll also see:

```
renewal charge (MIT) { id: 'vpi_test_...', status: 'succeeded', amount: 2999, currency: 'USD', declineCode: null }
done { savedCard: 'vp_pmt_test_...', anchorTransactionId: 'vpi_test_...', renewalTransactionId: 'vpi_test_...' }
```

(On a live key the ids read `_live_` instead of `_test_`.)

> **Branch on the capability matrix.** `supportedOperations.mit` reports what your account's payment provider supports - on a test key too, since a sandbox reports its own provider's matrix. When it is `false` the sample stops cleanly after the anchor charge rather than faking a renewal. This is exactly how your code should behave - never hard-code per-processor assumptions.
>
> In test mode the order total decides a decline, not the card: this sample's 29.99 approves, and 2,000.12 (`200012`) is declined by the card's issuer. Save the card with one of your sandbox's test cards: `5200 0000 0000 1203` (approves, 3-D Secure with no challenge), expiry `03/30`, CVC `100`. Common numbers such as `4242 4242 4242 4242` are declined (see [Test mode](https://docs.vonpay.com/reference/test-cards)).

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
| `VON_PAY_PROVIDER_REFERENCE` | when your payment provider needs one | - |
| `VON_PAY_BASE_URL` | no | `https://checkout.vonpay.com` |

The default base URL is production (`checkout.vonpay.com`). A `vp_sk_test_` key runs in sandbox mode there, so no host change is needed; set `VON_PAY_BASE_URL` only if support directs you to a different host.

## Where the card details come from

Nothing is auto-created, on a test key or a live one: `tokens.create` saves the card your payment provider already holds, and no card data crosses your server - which is the point of tokenization.

With an iframe-vault provider, the buyer's card never touches your server. Your browser front-end (e.g. [Embedded Fields](https://docs.vonpay.com/embedded-fields/quickstart)) collects the card in a hosted iframe and mints a vault handle; you pass that handle as `providerReference` to `tokens.create`, along with `setupForFutureUse: "off_session"` to capture reuse consent. The resulting `vp_pmt_*` token is what you keep on file and rebill.

```typescript
const token = await vonpay.tokens.create({
  buyerId: "buyer_42",
  providerReference: browserMintedVaultHandle, // from the iframe submit
  setupForFutureUse: "off_session",
});
```

## Send `buyerId` on every charge against a saved card

**It is a protection, and it only applies when you send it.** When a token was
vaulted against a buyer, the server requires the charge to name the same buyer
and returns `404 payment_method_not_found` on a mismatch. That is what stops a
stored card being billed to the wrong customer.

The realistic failure is not an attacker - it is a billing job that joins the
wrong token to the wrong subscriber row and charges someone else's card. Nothing
rejects that charge unless `buyerId` is present.

> ⚠️ Until 2026-09-12 this sample vaulted **with** a buyer and then charged
> **without** one, at both call sites, and the diagram below showed it that way.
> If you copied this sample before that date, add `buyerId` to your
> `paymentIntents.create` calls.

Omit it only for genuine guest or one-off charges; tokens saved with no buyer on
file are unrestricted.

## How the chain works

```
[buyer present]                         [buyer absent - your scheduler]
  tokens.create (off_session)             paymentIntents.create({
        │  └─ vp_pmt_… token id            payment_method: { id: vp_pmt_… },
        ▼                                   buyer_id: "buyer_42",   ← REQUIRED
  paymentIntents.create  ──── anchor ───────▶ mit: {
  ({ payment_method:       vpi_… id             initiator: "merchant",
     { id: vp_pmt_… },                          reason: "recurring",
     buyer_id: "buyer_42" })                    originalTransactionId: vpi_…
  (cardholder-initiated)                      }
  status: succeeded                         })
```

The MIT must anchor on a **succeeded, cardholder-initiated** intent. The sample stops if the anchor charge doesn't reach `succeeded` (decline, 3DS pending) - there's nothing to rebill against until consent has actually been captured.

Server-side, every MIT runs a chain-validity check before dispatch:

- `originalTransactionId` must belong to the same merchant.
- It must be on the same processor (or the merchant must have network-token support for cross-processor chains).
- It must be a chargeable anchor - a real cardholder-initiated intent, not another MIT in the chain.

Violations surface as a `VonPayError` with a `code` and (on a state-machine rejection) a `rejectReason` you can branch on.

## Idempotency

Each run derives deterministic keys from a single `runId`:

- `token-{runId}` - the vault create
- `{subscriptionId}-anchor` - the cardholder-initiated charge
- `{subscriptionId}-cycle-2` - the renewal

In production, tie the renewal key to the billing cycle (e.g. `sub_8821-cycle-2026-05`) so a retried renewal job collapses to a single charge instead of double-billing the customer.

## Error handling

Each step is wrapped in `try`/`catch`. `VonPayError` (thrown by every SDK method) carries:

- `code` - machine-readable error code (e.g. `validation_invalid_amount`, `payment_method_consent_missing`, `invalid_transition`)
- `status` - HTTP status
- `requestId` - `X-Request-Id` header; paste this when filing a support ticket
- `currentStatus` + `rejectReason` - populated on lifecycle-endpoint state rejections

If the token isn't vaulted off-session, the MIT charge would be rejected with `payment_method_consent_missing` - the sample checks `token.setupForFutureUse` up front and bails with a clear message rather than chasing that 422 later.

## Going to production

- Move `VON_PAY_SECRET_KEY` into your secret manager (AWS Secrets Manager, Vault, Doppler, etc.). Never commit it.
- Persist the `vp_pmt_*` token id and the anchor `vpi_*` id against your customer record - you need both for every future renewal.
- Read `vonpay.capabilities.get()` once at startup and branch on `supportedOperations.mit`. Sandbox returns `false`; a live processor with MIT enabled returns `true`.
- Use a deterministic, cycle-scoped `idempotencyKey` for every renewal so scheduler retries don't double-bill.
- Build the dunning loop: a renewal that returns `failed` (or a `VonPayError`) is the trigger for retry / `unscheduled` MITs and your subscription state machine.

## Reference docs

- [Payment intents guide - saved cards / MIT](https://docs.vonpay.com/integration/payment-intents#saved-cards--merchant-initiated-mit-charges)
- [Tokenization - reusability model](https://docs.vonpay.com/embedded-fields/tokenization)
- [Test mode - the order totals that decline](https://docs.vonpay.com/reference/test-cards)
- [Error codes](https://docs.vonpay.com/reference/error-codes)

## Tested against

`@vonpay/checkout-node` 3.x - typecheck with `npm run typecheck`.
