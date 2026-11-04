# Von Payments Checkout - Embedded Fields sample

Embedded card collection: the buyer stays on **your** domain and the card
field is rendered inside a Von Payments-owned iframe (Embedded Fields). Card
data never touches your server or your DOM, so you stay out of PCI scope -
without sending the buyer to a hosted checkout page.

- **Stack:** Node 20+ / Express 5 / TypeScript (server, run via `tsx`) +
  a static HTML/JS page (browser)
- **Von Payments SDKs:**
  - Server: `@vonpay/checkout-node` 4.x (`^4.5.0`)
  - Browser: the Embedded Fields SDK, loaded from
    `https://js.vonpay.com/v1/vora.js` (CDN `<script>` - there is no public
    npm package to install)
- **What it demonstrates:** create a session server-side, mount the card
  iframe in the browser, tokenize on submit, and handle all three submit
  outcomes (`token` / `charged` / `error`) correctly

## How it works

```
server.ts            Reads env, creates the SDK client, starts the server.
app.ts               The routes:
                       GET  /api/config          → publishable key + amount
                       POST /api/create-session  → mints a session (secret key)
                                                   + a cookie naming this checkout;
                                                   the same browser gets the same one
                       POST /api/charge          → charges a vp_pmt_* token,
                                                   at most once per checkout
                       (static files from ./public)

public/index.html    Loads vora.js from the CDN; card mount + Pay button.
public/checkout.js   Inits Vora, retrieves the session, mounts the card,
                     and branches the three-way submit result.
```

The handshake:

1. The browser asks the server for a session. The server calls
   `sessions.create()` with the **secret** key and returns only the session
   `id` (a `vp_cs_*`, safe to expose).
2. The browser does `new Vora({ publishableKey })`, `vora.sessions.retrieve(id)`,
   then `vora.fields.create("card").mount("#card-element")`. The card iframe
   is served by the active card processor and mounted inside your `<div>`.
3. On submit, `card.tokenize()` resolves to one of three shapes:

   | Result        | Meaning                                              | What this sample does                         |
   | ------------- | ---------------------------------------------------- | --------------------------------------------- |
   | `{ error }`   | Nothing was charged                                  | Show the error, re-enable Pay                 |
   | `{ token }`   | Tokenize-only: you hold a `vp_pmt_*`                 | `POST /api/charge` → server charges the token |
   | `{ charged }` | Charge-and-save: the embed already charged the buyer | Show success; **does not** charge again       |

> **Why the result is branched.** On a charge-and-save session the embed
> charges the card *during submit*. If you also called `POST /api/charge`
> (i.e. `paymentIntents.create`) for that session, you would charge the
> buyer twice. This sample only charges server-side when the result is a
> `token`. Which flow a session uses is decided by your checkout
> configuration; the result shape tells you which one ran.

**The server charges each checkout at most once.** `POST /api/create-session`
records the checkout on the server and sets an httpOnly cookie naming it, so a
browser can only charge its own checkout. `POST /api/charge` then:

- sends the checkout's `sessionId` with the charge, so the API refuses it if
  the embed already charged this session at submit;
- sends one idempotency key per session and token, so a retried request is
  never charged twice;
- refuses a second charge while one is in flight, after one whose answer was
  lost, or after one that did not fail. A buyer whose page lost the answer and
  clicks Pay again sends a NEW token (so a new key), and only this check stops
  the second charge. Each refusal says `outcome_unknown: true`, and the page
  then tells the buyer not to pay again. A confirmed decline does not block
  the next attempt.

Before deploying a route like `/api/charge`, rate-limit it (per buyer and per
IP) and put bot / card-testing protection in front of it: it moves money with
your secret key on every call. Behind a TLS-terminating proxy you run, set
`VON_PAY_TRUST_PROXY` to its hop count (e.g. `1`) so the cookie is marked
`Secure`.

**One browser, one checkout.** A second tab or a reload sends the cookie, so
`POST /api/create-session` returns the same session and the one-charge lock
covers it. This stays true after a payment, because the server cannot tell
whether the browser saw the answer. The route makes a new checkout only when
the cookie is missing, or when the session expired with no payment on it. To
try another payment in this demo, clear the `embedded_checkout` cookie or
restart the server.

`POST /api/create-session` is a dev stub. It needs no sign-in, and it adds an
entry to an in-memory map that nothing ever removes. Two things must change
before you deploy:

- **Key the session on your own order id.** The cookie protects one browser
  only. A buyer who lost the cookie or moved to another device gets a new
  checkout here, and can pay a second time. Create the session from your own
  order (for a signed-in buyer, from a cart priced on your server), and send
  the order id in the idempotency key, so one order can only ever have one
  session.
- **Persist the charge lock in the order row.** The lock in `/api/charge` is
  in memory, so it is per process. A second server process does not see it, and
  a restart forgets it. Keep the checkout state on the order row and change it
  with an atomic update.

Rate-limit the route like `/api/charge`.

The client result is a **UX signal only** - it tells the browser the embed
accepted the card, not that money has settled. Confirm settlement
server-side via the [webhook](https://docs.vonpay.com/integration/webhooks)
before you fulfill the order.

## 5-minute setup

### 1. Get test keys

Sign up at [app.vonpay.com](https://app.vonpay.com), complete OTP, then
`/dashboard/developers` → **Create sandbox**. You need two keys for the
embedded flow (both shown in the banner once):

- `vp_sk_test_...` - secret key (server-only)
- `vp_pk_test_...` - publishable key (shipped to the browser)

Test payments run on a sandbox account backed by a payment provider's test
environment. A test key on a live account, or on a sandbox account with no
payment provider, is refused with `422 sandbox_account_required`.

### 2. Configure and run

```bash
cp .env.example .env
# Edit .env: set VON_PAY_SECRET_KEY and VON_PAY_PUBLISHABLE_KEY

npm install
npm run dev
```

Open [http://localhost:4000](http://localhost:4000), type a test card, and
click **Pay**.

### 3. Test cards and outcomes

A test key never moves real money. Your sandbox runs on its payment provider's
test environment, which runs 3-D Secure on every card payment, so **only these
cards work, with expiry `03/30` and CVC `100`**. Common test numbers such as
`4242 4242 4242 4242` are declined.

| Card | What happens |
|---|---|
| `4111 1111 1110 1203` (Visa) / `5200 0000 0000 1203` (Mastercard) | 3-D Secure with no challenge: approves |
| `4111 1111 1118 1072` (Visa) / `5240 0000 0000 1072` (Mastercard) | 3-D Secure challenge: you choose pass or fail |
| any card above at an order total of 2,000.12 (`200012`) | Declined by the card's issuer |

The **order total** decides a decline, not the card: this sample's 49.99
approves. To test a decline, change `AMOUNT` in `app.ts` to `200012`
(2,000.12). If your dashboard shows different test cards for your sandbox,
use those.

**This sample has no 3-D Secure return path.** It sends no return URL with
the charge and has no page for the bank to send the buyer back to. So when the
bank asks for a check (the payment comes back as `requires_action`, as it can
with the challenge cards above), the page says that this sample cannot
complete a bank check, and that payment stays unfinished. Use the cards with
no challenge here. A real integration sends a return URL with every card
payment and redirects the buyer to the bank: see the
[payment-intents-3ds](../payment-intents-3ds) sample. More in
[docs.vonpay.com/reference/test-cards](https://docs.vonpay.com/reference/test-cards).

## Pinning the SDK version

`index.html` loads the auto-updating `/v1/` channel:

```html
<script src="https://js.vonpay.com/v1/vora.js" crossorigin="anonymous"></script>
```

For stricter supply-chain control, pin a specific version with
browser-enforced Subresource Integrity. Copy the exact `integrity` hash for
the version from [`js.vonpay.com/integrity.json`](https://js.vonpay.com/integrity.json)
(the newest release is named under `channels.v1.current`), and replace
`vX.Y.Z` below with that version:

```html
<script
  src="https://js.vonpay.com/vX.Y.Z/vora.js"
  integrity="sha384-<hash-from-integrity.json>"
  crossorigin="anonymous"
></script>
```

## Security notes

- **Two keys, two scopes.** The secret key (`vp_sk_*`) stays on the server
  and creates sessions / charges tokens. The publishable key (`vp_pk_*`) is
  safe in the browser - it can only authenticate VORA's public endpoints,
  never move money on its own. The SDK throws if you pass a secret key to
  `new Vora(...)`.
- **Do not add a card-processor SDK.** The card field is a Von Payments
  iframe; the processor is chosen server-side. Importing a processor's own
  SDK breaks routing, 3DS, and wallet handling.
- **Confirm settlement via the webhook.** The `token` / `charged` result is
  a front-end signal, not proof of settlement.

## Notes / current SDK surface

The server-side token charge in `/api/charge` passes the token as
`paymentMethod: { id }` on the typed `CreatePaymentIntentParams`, which the
SDK serializes to the documented `payment_method: { id }` wire field (see
[Payment Intents](https://docs.vonpay.com/integration/payment-intents)).

`/api/create-session` sends an idempotency key derived from the order id, so a
retry that reuses the same order id returns the same session. This sample makes
a stand-in order id for each new checkout. Replace it with your own order
record's id.

## Related

- [Embedded Fields quickstart](https://docs.vonpay.com/embedded-fields/quickstart)
- [Charge-and-save flow](https://docs.vonpay.com/embedded-fields/tokenization#charge-and-save)
- [Tokenization model](https://docs.vonpay.com/embedded-fields/tokenization)
- [Payment Intents reference](https://docs.vonpay.com/integration/payment-intents)
- [Webhooks](https://docs.vonpay.com/integration/webhooks)
- `checkout-express` - hosted-redirect equivalent (no embedded fields)
