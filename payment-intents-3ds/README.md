# Payment Intents — 3D Secure (3DS / SCA) handling

Server-side handling for a payment intent that returns **`requires_action`** — the issuer wants to challenge the buyer (3D Secure / Strong Customer Authentication). Single Express server that creates the intent, redirects the buyer to the bank's challenge page, and confirms the terminal outcome from the webhook.

- **Stack:** Node 20+, TypeScript strict, ESM, Express 5
- **SDK:** [`@vonpay/checkout-node@^0.9.0`](https://www.npmjs.com/package/@vonpay/checkout-node)
- **Best for:** server-driven (Payment Intents) integrations in regions where SCA applies (EU/UK/EEA), or any flow where the issuer may step up to 3DS

## The 3DS server-side model in one paragraph

You don't decide whether to challenge — the issuer does. When it wants to, `POST /v1/payment_intents` returns `status: "requires_action"` and a `next_action` of type `redirect_to_url`. The **only** correct move is a **top-level browser redirect** to that URL (banks block their challenge inside an iframe). After the buyer authenticates, the bank sends them back to your `return_url`, but that return is a **UX signal only** — the authoritative terminal state arrives on the `payment_intent.succeeded` / `payment_intent.failed` webhook. There is no client SDK "confirm" call in this server-driven path; the redirect is the confirm step.

> **Hosted Checkout already does all of this for you.** If a hosted redirect is acceptable, use [Sessions](https://docs.vonpay.com/integration/create-session) — Von Payments renders the card form, runs 3DS, and redirects back, and you stay out of PCI scope. Payment Intents are for the cases Sessions can't cover (delayed capture, fraud-check-before-capture, platform integrators driving the state machine themselves).

## What it demonstrates

| Route | What happens |
|---|---|
| `POST /charge` | Create a manual-capture intent with a `vp_pmt_*` token. Branch on `status`: `requires_action` → redirect to the 3DS URL · `authorized` → capture immediately · `failed` → surface the decline |
| `GET /3ds/return` | Where the issuer returns the buyer after the challenge. UX only — does **not** fulfill |
| `POST /webhooks` | Verify `x-vonpay-signature`, then act on `payment_intent.succeeded` / `payment_intent.failed` to confirm the post-challenge terminal state |

The intent is created with `captureMethod: "manual"` so a 3DS success lands on `authorized` (funds held, not captured) and the server captures explicitly. Switch to `captureMethod: "automatic"` and the same flow collapses straight to `succeeded`.

## Two SDK-vs-docs gaps this sample handles honestly

These are documented here so you understand the two small workarounds in `server.ts` — they are real gaps in the `0.9.1` typed surface, not invented patterns:

1. **`paymentMethod` / `returnUrl` are documented request fields but not on the `0.9.1` `CreatePaymentIntentParams` type.** The SDK's `paymentIntents.create` deep-converts every parameter to snake_case and forwards it, so these ride through at runtime. The sample widens the param type locally (`ChargeParams`) and narrows back to `CreatePaymentIntentParams` at the call boundary, rather than hand-rolling a `fetch`.
2. **`PaymentIntent.nextAction` is typed `string | null`, but on a `requires_action` response the runtime value is a structured object.** The API wire shape is `{ type: "redirect_to_url", redirect_to_url: { url } }`, but the SDK camelCases every response key before returning it — so at runtime the field is `redirectToUrl`, not `redirect_to_url`. (The `type` is a string *value*, not a key, so it stays `"redirect_to_url"`.) The sample reads the runtime value defensively (`extractRedirectUrl`) and branches on `type`, so a future `next_action` type can't silently break the redirect.

Both gaps are version-pinned to `@vonpay/checkout-node@0.9.1`; when a later SDK types these fields, drop the local bridges. (Confirmed empirically against the published `0.9.1` package: `paymentIntents.create` forwards `payment_method` / `return_url` on the wire, and returns `next_action` as `{ type, redirectToUrl: { url } }`.)

## Setup

### 1. Get a sandbox key + webhook secret

[vonpay.com/developers](https://vonpay.com/developers) → **Activate Vora Sandbox**. You'll get a `vp_sk_test_…` secret key. Create a webhook endpoint pointing at your public `/webhooks` URL — you'll be shown a `whsec_…` signing secret once.

### 2. Configure + run

```bash
cp .env.example .env
# edit .env — paste in vp_sk_test_... and whsec_...

npm install
npm run dev
```

Open `http://localhost:3000` and click **Pay**, or drive it from curl:

```bash
curl -i -X POST http://localhost:3000/charge \
  -H "Content-Type: application/json" \
  -d '{ "paymentMethod": "vp_pmt_test_3ds_success_sample", "amount": 4999 }'
```

With a 3DS token, `/charge` responds `303` with a `Location` header pointing at the sandbox challenge URL — that's the redirect your buyer's browser follows.

## Triggering 3DS in the sandbox

The sandbox encodes the intended outcome in the token's middle segment (see the [Test Cards reference](https://docs.vonpay.com/reference/test-cards)). Pass the token to `/charge` as `paymentMethod`:

| Token | Outcome |
|---|---|
| `vp_pmt_test_3ds_success_<anything>` | `requires_action` → (after challenge) `payment_intent.succeeded` |
| `vp_pmt_test_3ds_fail_<anything>` | `requires_action` → (after challenge) `payment_intent.failed` (`decline_code: fraud_suspected`) |
| `vp_pmt_test_success_<anything>` | `authorized` immediately — no challenge (auto-capture path → `succeeded`) |
| `vp_pmt_test_decline_<reason>_<anything>` | `failed` before any challenge |

`/charge` defaults to `vp_pmt_test_3ds_success_sample` when you don't pass a token, so the happy-path 3DS branch runs out of the box. `vp_pmt_test_*` tokens are sandbox-only — they're rejected with `payment_method_inactive` on live keys.

The card numbers behind these tokens (e.g. `4000 0027 6000 3184` for 3DS success) come from VORA Mirror tokenization on your front end in a real integration; this server-only sample uses the synthetic tokens directly so it runs without a browser card form.

## Why the webhook is the source of truth

The buyer's browser returning to `/3ds/return` tells you the challenge *finished*, not that it *passed* — the browser can be closed, lose connectivity, or be tampered with mid-flow. The terminal state is confirmed server-side:

- `payment_intent.succeeded` → 3DS passed and funds settled. **This** is the signal to fulfill.
- `payment_intent.failed` → challenge rejected or charge declined. Do **not** fulfill.

These `payment_intent.*` events are not in the `0.9.1` typed `WebhookEvent` union (which covers the hosted-checkout `session.succeeded` / `session.failed` / `refund.created` shape). They use a different payload shape — discriminator `type`, body nested under `data`, decline reason at `data.failure_reason` (see the [webhook events reference](https://docs.vonpay.com/integration/webhook-events)). The sample still verifies the signature with `vonpay.webhooks.constructEvent` — that gate is fully enforced — then parses the raw body into the documented `payment_intent.*` shape and branches on `type`. Only the TypeScript type is widened; the HMAC check is unchanged. Dedupe redeliveries on the event `id` (`vp_evt_*`) with a durable store.

### Testing the webhook locally

Expose your local server (e.g. `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`), register the public `/webhooks` URL in the dashboard, then run a `/charge` with a 3DS token and complete the sandbox challenge. The `payment_intent.succeeded` / `.failed` event lands on `/webhooks` within seconds of the bank's terminal callback.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Run `server.ts` via `tsx` (no build step) |
| `npm start` | Same server through `ts-node/esm` (CI-friendlier) |
| `npm run typecheck` | `tsc --noEmit` against `server.ts` — runs in CI before publish |

## Configuration

| Env var | Required | Default |
|---|---|---|
| `VON_PAY_SECRET_KEY` | yes | — |
| `VON_PAY_WEBHOOK_SECRET` | yes | — |
| `VON_PAY_BASE_URL` | no | `https://checkout.vonpay.com` |
| `VON_PAY_RETURN_URL` | no | `http://localhost:{PORT}/3ds/return` |
| `PORT` | no | `3000` |

The default base URL is production (`checkout.vonpay.com`). A `vp_sk_test_` key runs in sandbox mode there, so no host change is needed; set `VON_PAY_BASE_URL` only if support directs you to a different host.

## Going to production

- **Never trust the return page.** Fulfill from the `payment_intent.succeeded` webhook, not from `/3ds/return`. The return is a UX hint only.
- **Redirect at the top level.** Always do a full-page navigation (or a new top-level tab) to the challenge URL — banks frame-bust their 3DS pages, so an iframe redirect fails.
- **Verify webhooks with the `whsec_*` secret**, not your API key, over the **raw** request body. Mount `express.raw()` on the webhook route only.
- **Make the idempotency keys deterministic.** This sample derives them from a per-request order id (`{order}:authorize`, `{order}:capture`); in production tie them to your real upstream order id so retries collapse.
- **Make `/webhooks` idempotent.** Redeliveries carry the same logical event — dedupe on the event id (durable store, not in-memory) so a retry doesn't double-fulfill.

## Reference docs

- [Payment intents — authentication challenges (3DS)](https://docs.vonpay.com/integration/payment-intents#authentication-challenges-3ds)
- [Webhooks](https://docs.vonpay.com/integration/webhooks) — signature verification + event types
- [Test cards + sandbox triggers](https://docs.vonpay.com/reference/test-cards)

## Tested against

`@vonpay/checkout-node@0.9.1` — typecheck (`tsc --noEmit`) verified 2026-06-05. End-to-end 3DS smoke (charge → redirect → challenge → `payment_intent.succeeded` webhook) requires a `vp_sk_test_…` key plus a publicly reachable `/webhooks` URL.
