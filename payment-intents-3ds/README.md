# Payment Intents - 3D Secure (3DS / SCA) handling

Server-side handling for a payment intent that returns **`requires_action`** - the issuer wants to challenge the buyer (3D Secure / Strong Customer Authentication). Single Express server that creates the intent, redirects the buyer to the bank's challenge page, and confirms the terminal outcome from the webhook.

- **Stack:** Node 20+, TypeScript strict, ESM, Express 5
- **SDK:** [`@vonpay/checkout-node`](https://www.npmjs.com/package/@vonpay/checkout-node) 4.x (`^4.10.0`): 2.5.0 is the first release that types `returnUrl` on `paymentIntents.create`, and 2.7.0 the first that types `test_event` on webhook events
- **Best for:** server-driven (Payment Intents) integrations in regions where SCA applies (EU/UK/EEA), or any flow where the issuer may step up to 3DS

## The 3DS server-side model in one paragraph

You don't decide whether to challenge - the issuer does. When it wants to, `POST /v1/payment_intents` returns `status: "requires_action"` and a `next_action` of type `redirect_to_url`. The **only** correct move is a **top-level browser redirect** to that URL (banks block their challenge inside an iframe). After the buyer authenticates, the bank sends them back to your `return_url`, but that return is a **UX signal only** - the authoritative terminal state arrives on the `payment_intent.succeeded` / `payment_intent.failed` webhook. There is no client SDK "confirm" call in this server-driven path; the redirect is the confirm step.

> **Hosted Checkout already does all of this for you.** If a hosted redirect is acceptable, use [Sessions](https://docs.vonpay.com/integration/create-session) - Von Payments renders the card form, runs 3DS, and redirects back, and you stay out of PCI scope. Payment Intents are for the cases Sessions can't cover (delayed capture, fraud-check-before-capture, platform integrators driving the state machine themselves).

## What it demonstrates

| Route | What happens |
|---|---|
| `POST /orders` | Start an order on the server (the page at `/` does this for you). Returns `{ orderId }` |
| `POST /charge` | For an order this server created (`orderId`), create a manual-capture intent with a `vp_pmt_*` token. Branch on `status`: `requires_action` → redirect to the 3DS URL · `authorized` → capture immediately · `failed` → surface the decline. A second `POST /charge` on an order that holds or took money answers `409` |
| `GET /3ds/return` | Where the issuer returns the buyer after the challenge. Reads the payment from the API and captures it if the money is held. Does **not** fulfill |
| `POST /webhooks` | Verify `x-vonpay-signature`, then act on `payment_intent.succeeded` / `payment_intent.failed` to confirm the post-challenge terminal state |

`POST /orders` and `GET /` are demo-only stubs. They need no sign-in, and every call creates an order in an in-memory map that nothing ever removes (a restart forgets them all). In a real app the order is created for the signed-in buyer, from a cart priced on your server, and stored in your database.

**Before deploying, rate-limit `/orders` and `/charge`** (per buyer and per IP) and put bot / card-testing protection in front of them. `/charge` moves money with your secret key on every call, which is exactly what card testers look for. This sample has neither.

**Each order has a status.** It starts as `open`, then takes the payment's status from the API's answer and from the webhooks.

| Order status | What a second `POST /charge` does |
|---|---|
| `open` | Charges the order |
| `authorized`, `captured`, `succeeded` | Answers `409 order_already_charged` with the order's status and payment id. The API is not called |
| `requires_action` | Replays the same redirect to the bank's check, so a double submit still reaches the bank |
| `failed` | Replays the same decline. To try again, start a new order |

A real app keeps this status on the order row and changes it with an atomic update, because this in-memory map is per process.

The intent is created with `captureMethod: "manual"` so a 3DS success lands on `authorized` (funds held, not captured) and the server captures explicitly: in `/charge` when there was no challenge, and after a challenge on the `payment_intent.authorized` webhook or when the buyer returns, whichever comes first. Switch to `captureMethod: "automatic"` and the same flow collapses straight to `succeeded`.

## Reading the challenge URL

Everything this sample sends and reads is on the SDK's typed surface - `paymentMethod` and `returnUrl` on `CreatePaymentIntentParams`, and `nextAction` typed as `PaymentIntentNextAction | null`. Two details are worth knowing:

1. **The SDK camelCases response keys.** The API wire shape is `{ type: "redirect_to_url", redirect_to_url: { url } }`, but the SDK returns it as `nextAction.redirectToUrl.url`. Reading `nextAction.redirect_to_url.url` gives `undefined`. (The `type` is a string *value*, not a key, so it stays `"redirect_to_url"`.) The sample branches on `type` in `extractRedirectUrl`, so a future `next_action` type can't silently break the redirect.
2. **Redirect from the create response, and re-read if you lost it.** `nextAction` arrives on the response that creates the payment. If that response is lost (a timeout, a crash), `vonpay.paymentIntents.retrieve(id)` returns the same `nextAction` for as long as the payment is still `requires_action`, with an `issuedAt` time saying when the link was issued. Check it before sending a buyer: how long a challenge link stays usable is set by the payment provider, and an old link may no longer work.

## Setup

### 1. Get a sandbox key + webhook secret

[vonpay.com/developers](https://vonpay.com/developers) → **Activate Vora Sandbox**. You'll get a `vp_sk_test_…` secret key. Create a webhook endpoint pointing at your public `/webhooks` URL - you'll be shown a `whsec_…` signing secret once.

Test payments run on a sandbox account backed by a payment provider's test environment, and behave exactly as they would on that provider live. A test key on a live account, or on a sandbox account with no payment provider, is refused with `422 sandbox_account_required`.

### 2. A saved card to charge

This server-only sample charges a card that is already saved (`vp_pmt_test_…`). Nothing is made up for you in test mode: save a real card on your sandbox with `tokens.create` (see the [saved-cards-mit](../saved-cards-mit) sample), using the sandbox's challenge card `4111 1111 1118 1072` (Mastercard: `5240 0000 0000 1072`), expiry `03/30`, CVC `100`. Set its token as `VON_PAY_PAYMENT_METHOD` and the buyer you saved it for as `VON_PAY_BUYER_ID`. Without a card, `/charge` answers `400` and charges nothing.

The card is never read from the request. Card ids are not secrets (they show up in logs, support tickets and your own saved-card screens), so a route that charges whatever card id it is sent lets anyone charge anyone's saved card. In a real app, look up the signed-in customer's card on your server and send `buyerId` with the charge: the API refuses a card that was saved for a different buyer.

### 3. Configure + run

```bash
cp .env.example .env
# edit .env - paste in vp_sk_test_..., whsec_... and vp_pmt_test_...

npm install
npm run dev
```

Open `http://localhost:3000` and click **Pay**, or drive it from curl:

```bash
ORDER=$(curl -s -X POST http://localhost:3000/orders | sed -E 's/.*"orderId":"([^"]+)".*/\1/')
curl -i -X POST http://localhost:3000/charge -d "orderId=$ORDER"
```

Run the second command twice: it can never charge the card twice. The idempotency key comes from the stored order, so the API answers a repeat with the payment it already made. If the first answer took or held money, the second answer is `409 order_already_charged`.

When the bank challenges, `/charge` responds `303` with a `Location` header pointing at the challenge URL - that's the redirect your buyer's browser follows.

## Getting a 3DS challenge in test mode

Whether the bank challenges is decided by your sandbox's payment provider test environment, from the card you saved - Von Payments does not simulate it. Your sandbox runs 3-D Secure on every card payment:

| Card | What happens |
|---|---|
| `4111 1111 1110 1203` (Visa) / `5200 0000 0000 1203` (Mastercard) | 3-D Secure with no challenge: approves |
| `4111 1111 1118 1072` (Visa) / `5240 0000 0000 1072` (Mastercard) | 3-D Secure challenge: you choose pass or fail |
| any card above at an order total of 2,000.12 (`200012`) | Declined by the card's issuer |

Use expiry `03/30` and CVC `100`. Common numbers such as `4242 4242 4242 4242` are declined. If your dashboard shows different test cards for your sandbox, use those.

Declines are decided by the order total, not the card: an ordinary total like this sample's 49.99 approves, and 2,000.12 (`200012`) declines (see [Test mode](https://docs.vonpay.com/reference/test-cards)).

`vp_pmt_test_*` tokens work only with test keys - a live key refuses one with `400 payment_method_mode_mismatch`.

## Why the webhook is the source of truth

The buyer's browser returning to `/3ds/return` tells you the challenge *finished*, not that it *passed* - the browser can be closed, lose connectivity, or be tampered with mid-flow. So the return page trusts nothing from the link except which order came back, and it reads the payment from the API. The link carries the order's id because the payment provider adds only its own `transaction_id` and `transaction_status`. The terminal state is confirmed server-side:

- `payment_intent.succeeded` → 3DS passed and funds settled. **This** is the signal to fulfill.
- `payment_intent.failed` → challenge rejected or charge declined. Do **not** fulfill.
- `payment_intent.authorized` → 3DS passed on a manual-capture payment. The money is held, not taken, so **this sample captures it here**, with the order's `{order}:capture` key. Do **not** fulfill yet: wait for `payment_intent.succeeded`.

The return page captures a held payment too, with the same key, so together they make one capture.

**If that capture fails, the order is kept at `authorized`, so a second `/charge` still answers `409`:**

| What happened | What the sample does |
|---|---|
| The API refused the capture | Answers the webhook `200`. No money moved, and a repeat cannot help. A person captures or voids the hold |
| The API said to try again later | Answers the webhook `503`, so the delivery comes back and repeats the same key. On the return page, reloading repeats it |
| The answer was lost or unclear (a 5xx, a network failure, or `payment_outcome_unknown`) | Answers the webhook `200`, marks the order, and never captures it again. The capture may have gone through, and an idempotency key does not make a repeat safe. Read the payment with `paymentIntents.retrieve()` or ask a person first |

A real app alerts its staff in the first and last rows. An unused hold lapses at the bank, in as little as a few days.

**Check that your endpoint receives `payment_intent.authorized`.** It is not currently selectable when you create a webhook subscription. An endpoint that subscribed while it was offered still receives it. Without this event, the return page is the only capture after a challenge, and **a buyer who never comes back is still missed**: that payment stays held until it lapses. Find those payments another way, such as a scheduled job that reads each order still waiting with `paymentIntents.retrieve()`.

`vonpay.webhooks.constructEvent` verifies the signature and returns the typed `WebhookEvent` union, which includes the `payment_intent.*` events - discriminator `type`, body nested under `data`, decline reason at `data.failure_reason` (see the [webhook events reference](https://docs.vonpay.com/integration/webhook-events)). Switching on `event.type` narrows `event.data`, so there is no second parse and no widened type. Dedupe redeliveries on the event `id` (`vp_evt_*`) with a durable store.

**Check `event.test_event` first.** A delivery from **Send test event** is signed like a real one and can carry a real session's ids, so when it is `true` the handler returns 2xx and does nothing else (the field is typed from SDK 2.7.0; this sample's `^4.10.0` covers it).

### Testing the webhook locally

Expose your local server (e.g. `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`), register the public `/webhooks` URL in the dashboard, then run a `/charge` with a card that gets challenged and complete the test challenge. The `payment_intent.succeeded` / `.failed` event lands on `/webhooks` within seconds of the bank's terminal callback.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Run `server.ts` via `tsx` (no build step) |
| `npm start` | Same server through `ts-node/esm` (CI-friendlier) |
| `npm run typecheck` | `tsc --noEmit` against `server.ts` - runs in CI before publish |

## Configuration

| Env var | Required | Default |
|---|---|---|
| `VON_PAY_SECRET_KEY` | yes | - |
| `VON_PAY_WEBHOOK_SECRET` | yes | - |
| `VON_PAY_PAYMENT_METHOD` | yes, to charge | - |
| `VON_PAY_BUYER_ID` | recommended (sent as `buyerId`) | - |
| `VON_PAY_BASE_URL` | no | `https://checkout.vonpay.com` |
| `VON_PAY_RETURN_URL` | no | `http://localhost:{PORT}/3ds/return` |
| `PORT` | no | `3000` |

The default base URL is production (`checkout.vonpay.com`). A `vp_sk_test_` key runs in sandbox mode there, so no host change is needed; set `VON_PAY_BASE_URL` only if support directs you to a different host.

## Going to production

- **Rate-limit `/orders` and `/charge`.** See [What it demonstrates](#what-it-demonstrates).
- **Never trust the return page.** Fulfill from the `payment_intent.succeeded` webhook, not from `/3ds/return`. The return only says which order came back: read that payment from the API before you act on it.
- **Redirect at the top level.** Always do a full-page navigation (or a new top-level tab) to the challenge URL - banks frame-bust their 3DS pages, so an iframe redirect fails.
- **Verify webhooks with the `whsec_*` secret**, not your API key, over the **raw** request body. Mount `express.raw()` on the webhook route only.
- **Make the idempotency keys deterministic.** This sample derives them from the stored order's id (`{order}:authorize`, `{order}:capture`), never from an id made up per request, so a retry or double submit of the same order collapses into one payment. In production use your real order row's id. The API replays a decline for the same key too: to let the buyer try again, start a new order or add an attempt number to the key.
- **Make `/webhooks` idempotent.** Redeliveries carry the same logical event - dedupe on the event id (durable store, not in-memory) so a retry doesn't double-fulfill.

## Reference docs

- [Payment intents - authentication challenges (3DS)](https://docs.vonpay.com/integration/payment-intents#authentication-challenges-3ds)
- [Webhooks](https://docs.vonpay.com/integration/webhooks) - signature verification + event types
- [Test mode - the order totals that decline](https://docs.vonpay.com/reference/test-cards)

## Tested against

`@vonpay/checkout-node` 4.x - typecheck with `npm run typecheck`. End-to-end 3DS smoke (charge → redirect → challenge → `payment_intent.succeeded` webhook) requires a `vp_sk_test_…` key plus a publicly reachable `/webhooks` URL.
