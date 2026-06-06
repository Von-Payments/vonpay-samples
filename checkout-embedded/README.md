# Von Payments Checkout — Embedded (VORA Mirror) sample

Embedded card collection: the buyer stays on **your** domain and the card
field is rendered inside a Von Payments-owned iframe (VORA Mirror). Card
data never touches your server or your DOM, so you stay out of PCI scope —
without sending the buyer to a hosted checkout page.

- **Stack:** Node 20+ / Express 5 / TypeScript (server, run via `tsx`) +
  a static HTML/JS page (browser)
- **Von Payments SDKs:**
  - Server: `@vonpay/checkout-node@^0.9.0`
  - Browser: the VORA Mirror SDK, loaded from
    `https://js.vonpay.com/v1/vora.js` (CDN `<script>` — there is no public
    npm package to install)
- **What it demonstrates:** create a session server-side, mount the card
  iframe in the browser, tokenize on submit, and handle all three submit
  outcomes (`token` / `charged` / `error`) correctly

## How it works

```
server.ts            Express server:
                       GET  /api/config          → publishable key + amount
                       POST /api/create-session  → mints a session (secret key)
                       POST /api/charge          → charges a vp_pmt_* token
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

The client result is a **UX signal only** — it tells the browser the embed
accepted the card, not that money has settled. Confirm settlement
server-side via the [webhook](https://docs.vonpay.com/integration/webhooks)
before you fulfill the order.

## 5-minute setup

### 1. Get test keys

Sign up at [app.vonpay.com](https://app.vonpay.com), complete OTP, then
`/dashboard/developers` → **Create sandbox**. You need two keys for the
embedded flow (both shown in the banner once):

- `vp_sk_test_...` — secret key (server-only)
- `vp_pk_test_...` — publishable key (shipped to the browser)

### 2. Configure and run

```bash
cp .env.example .env
# Edit .env: set VON_PAY_SECRET_KEY and VON_PAY_PUBLISHABLE_KEY

npm install
npm run dev
```

Open [http://localhost:4000](http://localhost:4000), type a sandbox test
card, and click **Pay**.

### 3. Test cards

Any future expiry, any 3-digit CVC. Sandbox mode never charges real money.

| Card                  | Outcome                                  |
| --------------------- | ---------------------------------------- |
| `4242 4242 4242 4242` | Succeeds; no 3DS challenge               |
| `4000 0025 0000 3155` | 3DS challenge; succeeds after auth       |
| `4000 0000 0000 9995` | Tokenizes, then declines at charge       |

See [docs.vonpay.com/reference/test-cards](https://docs.vonpay.com/reference/test-cards)
for the full matrix.

## Pinning the SDK version

`index.html` loads the auto-updating `/v1/` channel:

```html
<script src="https://js.vonpay.com/v1/vora.js" crossorigin="anonymous"></script>
```

For stricter supply-chain control, pin a specific version with
browser-enforced Subresource Integrity. Copy the exact `integrity` hash for
the version from [`js.vonpay.com/integrity.json`](https://js.vonpay.com/integrity.json):

```html
<script
  src="https://js.vonpay.com/v1.3.2/vora.js"
  integrity="sha384-<hash-from-integrity.json>"
  crossorigin="anonymous"
></script>
```

## Security notes

- **Two keys, two scopes.** The secret key (`vp_sk_*`) stays on the server
  and creates sessions / charges tokens. The publishable key (`vp_pk_*`) is
  safe in the browser — it can only authenticate VORA's public endpoints,
  never move money on its own. The SDK throws if you pass a secret key to
  `new Vora(...)`.
- **Do not add a card-processor SDK.** The card field is a Von Payments
  iframe; the processor is chosen server-side. Importing a processor's own
  SDK breaks routing, 3DS, and wallet handling.
- **Confirm settlement via the webhook.** The `token` / `charged` result is
  a front-end signal, not proof of settlement.

## Notes / current SDK surface

As of `@vonpay/checkout-node@0.9.1`, the server-side token charge in
`/api/charge` passes the token as `paymentMethod: { id }`, which the SDK
serializes to the documented `payment_method: { id }` wire field. That field
is the documented request shape (see
[Payment Intents](https://docs.vonpay.com/integration/payment-intents)) but
is not yet part of the exported `CreatePaymentIntentParams` TypeScript type,
so the sample attaches it through a narrowly-scoped param object. This is the
documented request, not a placeholder.

## Related

- [VORA Mirror quickstart](https://docs.vonpay.com/mirror/quickstart)
- [Charge-and-save flow](https://docs.vonpay.com/mirror/charge-and-save)
- [Tokenization model](https://docs.vonpay.com/mirror/tokenization)
- [Payment Intents reference](https://docs.vonpay.com/integration/payment-intents)
- [Webhooks](https://docs.vonpay.com/integration/webhooks)
- `checkout-express` — hosted-redirect equivalent (no embedded fields)
