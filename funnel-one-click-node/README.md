# Funnel checkout + one-click add-on: Node sample

A one-page funnel checkout on Vora Elements, the way direct-response offer stores run one:

1. The shopper lands on one page with the offer, the card fields and your terms next to the button.
2. Pressing **Place my order** saves the card, with the shopper's agreement to keep it on file.
3. **Your server** makes the first charge on the saved card.
4. On the next screen (often a minute or so later), the shopper accepts a one-click add-on. Your server charges the **same saved card**. Nothing is typed again.

⛔ **A reference, not a deployment.** Orders live in memory, nothing limits how often the routes are called, and nothing is fulfilled. Do not put this server in front of real shoppers as it is: read [Before you go live](#before-you-go-live).

- **Stack:** Node 20.6+ (for `tsx --env-file`), TypeScript (server), plain JavaScript page (no build step), Express
- **SDKs:** [`@vonpay/checkout-node`](https://www.npmjs.com/package/@vonpay/checkout-node) 4.x on the server; `vora.js` from the CDN in the page (pinned, with Subresource Integrity)
- **Best for:** one-page funnels, order bumps, post-purchase one-click offers

## Run it

```bash
npm install
cp .env.example .env    # set VONPAY_SECRET_KEY and VONPAY_PUBLISHABLE_KEY (test keys)
npm run dev             # http://localhost:4242
```

Sandbox test card: `5200 0000 0000 1203`, expiry `03/30`, CVC `100`. Your sandbox account may ask for a 3-D Secure check on both charges; the sample handles it (the bank sends the shopper back, and the page asks the server for the result).

## What happens, step by step

| Step | Where | Call |
|---|---|---|
| Open the order (your order record exists **before** any charge) | server | `sessions.create({ integrationMode: "elements", chargeAtSubmit: false, buyerId })` |
| Save the card with the shopper's agreement | page | `vora.elements.create({ setupForFutureUse: "off_session" })`, then `collection.submit()` → `vp_pmt_*` |
| First charge | server | `paymentIntents.create({ paymentMethod: { id }, buyerId, sessionId, returnUrl }, { idempotencyKey })` |
| Check the card was saved for reuse | server | `paymentMethods.list({ buyerId })` → `setupForFutureUse` on that card |
| One-click add-on, same card | server | `paymentIntents.create({ paymentMethod: { id }, buyerId, returnUrl }, { idempotencyKey })`: **no `mit` block** |
| After a 3-D Secure check | server | `paymentIntents.retrieve(id)` (never the address the bank sends back) |

The routes are in [`server/app.ts`](server/app.ts); the page is [`public/index.html`](public/index.html) + [`public/funnel.js`](public/funnel.js).

**vora.js version.** The page loads one pinned build, `https://js.vonpay.com/v1.49.0/vora.js`, with its Subresource Integrity hash. To move to a newer build, change the version and the `integrity` value together, taking the hash from `https://js.vonpay.com/integrity.json` (`versions["v1.X.Y"].sha384`). The page's own wording as agreement needs vora.js 1.43.0 or later.

## How the shopper agrees to keep the card on file

There are two supported ways ([Saving a card and charging it later](https://docs.vonpay.com/guides/recurring-and-saved-cards#collect-consent)): our save-card checkbox, or **your own wording at the order button**. This sample uses your own wording, because a one-page funnel has one decision point, the order button, and the agreement belongs right there. The shopper reads the full terms next to the button and agrees by pressing it. The checkout records it on the saved card as `setupForFutureUseMethod: "checkout_terms"`.

If you prefer a box the shopper ticks, mount our `save-for-future-use` element instead and drop `setupForFutureUse` from `vora.elements.create()`. The box starts unticked and cannot be pre-ticked.

⛔ **Rules that do not change, whichever way you choose:**

- **Agreement cannot be added after the card is saved.** A card saved without it stays one-time only. Later you cannot charge it while the shopper is away, and a subscription cannot use it. Capture the agreement on the first order, from day one.
- **Never pre-tick a box**, and never send `"off_session"` for wording the shopper did not see. The card networks do not accept either as agreement. Nothing in the API checks your wording: whatever you send is recorded as the shopper's agreement, and a bank refuses a later charge the shopper never agreed to.
- **Put the full terms next to the button**, not only behind a link: the price, how often you charge, any trial and when it ends, and how to cancel. The text in [`server/app.ts`](server/app.ts) (`DEFAULT_TERMS`) is **example text**: replace it with your offer's real terms.
- **Keep a record** of the words each shopper saw and when they placed the order. They are your evidence if a later charge is disputed. The sample builds the record on `/api/charge`, **before** the charge, and hands it to `persistConsentRecord` in [`server/app.ts`](server/app.ts): the exact words, a version of them (`termsVersion`, also sent as `terms_version` in the session metadata next to `order_id`), the time this server received the request (`chargeRequestedAt`), and the press time the page reports (`pressedAtReported`, the browser's clock: as reported, not proof). ⛔ The default hook only logs. Replace it with a write to your own database. If the write fails, nothing is charged.
- **Agreement and declaration go together.** The example terms promise later charges. Words like that need a declaration of what the card is for (`STORED_CREDENTIAL_USE`, [below](#declaring-what-the-card-is-for)); the saved-card guide sends both together ([Step 2](https://docs.vonpay.com/guides/recurring-and-saved-cards#step-2--declare-what-the-stored-card-is-for), and "a declaration without consent is dropped" there). The server prints a warning at start when the terms mention later charges and `STORED_CREDENTIAL_USE` is not set.
- **Trial and continuity offers** (a trial that turns into a paid plan) have their own card-network rules and laws, for example on reminders before the trial ends and on cancelling online. Get your own legal advice on what your terms and emails must say; this sample gives none.

### No later charges?

If your offer has **no** charges after the order and its add-ons, do not ask for agreement to later charges. Instead use a session that charges at submit (`chargeAtSubmit: true`) and set the session's `setupForFutureUse: "on_session"`: the card may then be charged again only while the shopper is present, which is exactly the one-click add-on. See `CreateSessionParams.setupForFutureUse` in `@vonpay/checkout-node`.

### Declaring what the card is for

When your offer does have later charges, also tell the card networks what the saved card is for: set `STORED_CREDENTIAL_USE` (`recurring`, `installment` or `unscheduled`). The sample sends it as `storedCredentialUse` on the session. Use the same word as `mit.reason` on the later charge. Leave it empty and no declaration is made ([Step 2](https://docs.vonpay.com/guides/recurring-and-saved-cards#step-2--declare-what-the-stored-card-is-for)).

## The one-click add-on

- **Same card, same customer.** Send the saved card's `vp_pmt_*` and the same `buyerId` on every charge. The API refuses the card when it was saved for a different customer, which stops a card being billed to the wrong person.
- **No `mit` block.** The shopper is on the page and pressed the button, so this is not a merchant-initiated charge.
- **One charge per purchase decision.** The idempotency key is built from the order and the offer (`funnel:<order>:add-on:<offer>`), so a double press or a retried request can never charge twice. The server also refuses a second press while the first is running, after its answer was lost, or after it succeeded.
- **Offered only on a paid order**, and only when the server's own read shows the card was saved for reuse.
- **3-D Secure can happen on the add-on too.** Send `returnUrl`, and handle `requires_action` as on the first charge.
- **A declined add-on cannot be tried again under the same key**: the API answers the first result again. Another try (another card, a later offer) is a new purchase decision with a new key.

### Who can press the add-on button?

⚠ **Any script running on the page can call `/api/add-on`**, not only the shopper's click. The route trusts the order cookie, and a script on your own page sends that cookie too: an analytics tag, a chat widget, an A/B testing tool, or a tag that was compromised. A script that calls it charges the add-on to the saved card. If the shopper disputes it, you have no proof that a person pressed the button.

This sample does not defend against that. You can add, on your own funnel:

- **An offer window:** accept the add-on only for a short time after the main order is paid, and only once per offer.
- **Server-side click evidence:** record when the add-on request arrived, the shopper's IP address and user agent, next to the order. Keep it with the consent record.
- **A script Content Security Policy** (`script-src` limited to your own origin and `https://js.vonpay.com`): see the [OWASP Content Security Policy Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html).
- **Fewer third-party tags on payment pages**, each one listed and reviewed. PCI DSS 4.0 asks merchants to authorise and keep an inventory of every script on a payment page (requirement 6.4.3) and to detect changes to it (requirement 11.6.1).

The sample does stop other sites from framing the page (`frame-ancestors 'none'`, `X-Frame-Options: DENY`), so a hidden frame cannot trick a shopper into pressing the button. That is a separate risk from scripts on your own page.

### On a Next Commerce (29next) store

When your charges create the store order ([order mirroring](https://docs.vonpay.com/connected-platforms/next-commerce#post-purchase-upsells-one-order-multiple-payments)), the add-on also names the parent order and your id for the purchase decision. The idempotency key stays:

```ts
await vonpay.paymentIntents.create(
  {
    amount: 1999,
    currency: "USD",
    paymentMethod: { id: savedCardId },
    buyerId,
    returnUrl,
    mirror: {
      destination: "nextcommerce",
      shop: "your-store.29next.store",
      parentOrderRef: mainPaymentIntentId, // the first charge's vpi_… (or the order number)
      upsellKey: `${orderId}-refill-pack`, // one per purchase decision; a repeat gets 409 upsell_duplicate, not a charge
      lineItems: [{ title: "Refill pack", quantity: 1, price: "19.99" }],
    },
  },
  { idempotencyKey: `funnel:${orderId}:add-on:refill-pack` },
);
```

This sample does not run the mirror path (it needs a connected store); the snippet shows the fields as the SDK types them.

## Before you go live

This sample is **not safe to deploy as it is**. At least:

- Replace `DEFAULT_TERMS` with your real terms, and set `STORED_CREDENTIAL_USE` when they promise later charges.
- Replace `persistConsentRecord` with a write to your database.
- Rate-limit `/api/order`, `/api/charge` and `/api/add-on` (per shopper and per IP), and put bot / card-testing protection in front of them. `/api/order` creates a session with your secret key on every call, and the other two move money: card testers use all three.
- Keep orders in your database, not in memory (the sample keeps at most 10,000 and drops the oldest).
- Fulfil from the `payment_intent.succeeded` webhook ([`webhooks-node`](../webhooks-node) shows how), never from the page reaching a screen. Send the shopper's confirmation from there too: this sample sends none.
- Decide what you add against scripts calling the add-on ([above](#who-can-press-the-add-on-button)).
- Use live keys, an `https://` `VONPAY_RETURN_URL`, and `NODE_ENV=production` (the order cookie is then always `Secure`). Behind a TLS-terminating proxy or load balancer you run, set `VONPAY_TRUST_PROXY` to its hop count (for example `1`), so the server sees the shopper's HTTPS. Never set it for a proxy you do not run: the forwarded headers are then the caller's word.

## Read more

- [Saving a card and charging it later](https://docs.vonpay.com/guides/recurring-and-saved-cards): agreement, declarations, later charges
- [Embedded fields (Elements)](https://docs.vonpay.com/embedded-fields/elements)
- [Creating a session](https://docs.vonpay.com/integration/create-session)
- [Next Commerce order mirroring and add-ons](https://docs.vonpay.com/connected-platforms/next-commerce)
- [`saved-cards-mit`](../saved-cards-mit): charging a saved card later, while the shopper is away
