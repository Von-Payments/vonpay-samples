# AGENTS.md - guidance for AI coding agents

You're extending the Von Payments sample apps. This file gives you the facts you
need to do it correctly: the SDK release lines the samples build against, the
guardrails that are easy to get wrong, what the 4.x SDK types cover, and how to
pick a starting sample.

Read this alongside [`llms.txt`](./llms.txt). Keep everything factual - no
invented endpoints, events, or fields. Every claim below was checked against the
samples' code and the published SDK type definitions on **2026-11-03**; when in
doubt, the sample's own `package.json` / `requirements.txt` and the installed
SDK's `.d.ts` files win over this page.

## SDK release lines (checked 2026-11-03)

| Package | Samples pin | Current release | Where |
|---|---|---|---|
| `@vonpay/checkout-node` | `^4.5.0` (lockfiles at `4.5.0`) | `4.5.0` | npm - Node / TypeScript server SDK |
| `vonpay-checkout` | `>=4.5,<5` | `4.5.0` | PyPI - Python server SDK |
| `@vonpay/checkout-mcp` | `^6.4.2` (lockfile at `6.4.2`) | `6.4.2` | npm - MCP server (`agent-mcp` sample; 26 tools, including payment reports and subscription changes; `VONPAY_MCP_TOOLS=read` registers only the tools that read; on a live key every money action and subscription change waits for a person's approval in the MCP host's prompt) |
| `@vonpay/checkout-cli` | not pinned by any sample | `0.18.0` | npm - CLI |
| `@vonpay/test-cards` | not pinned by any sample | `0.2.1` | npm - the sandbox test cards as data |
| `vora.js` | CDN only, `https://js.vonpay.com/v1/vora.js` | `/v1/` channel auto-ships patches | browser SDK for embedded card fields - **no npm package** |

Rules of thumb:

- **Never pin to a 0.x version.** A caret range on 0.x locks the *minor*, so the
  pin can never move; the samples sat on `^0.9.0` for a year that way, through a
  webhook envelope change and a money bug. Use the `4.x` line for the server SDKs.
- **Always check the sample's own `package.json` (Node) or `requirements.txt`
  (Python)** for the range it is built against rather than assuming. The
  "current release" column above is a point-in-time reading, not a promise.

## Pick a sample by use case

| You want to… | Start from |
|---|---|
| Take a hosted checkout (redirect) on Next.js | `checkout-nextjs` |
| Take a hosted checkout, server-only (Node) | `checkout-express` |
| Take a hosted checkout, server-only (Python) | `checkout-flask` |
| Generate a pay-by-link for a customer | `checkout-paybylink-nextjs` |
| Run a multi-tenant platform (per-merchant credentials) | `platform-integrator-nextjs` |
| Drive auth → capture → refund from your server (Node) | `payment-intents-node` |
| Same, on Python | `payment-intents-python` |
| Handle a 3DS / `requires_action` challenge | `payment-intents-3ds` |
| Save a card and rebill it (subscriptions / MIT) | `saved-cards-mit` |
| Collect card fields in your own page (no redirect) | `checkout-embedded` |
| Receive + verify webhooks | `webhooks-node` |
| Wire an AI agent into the API (MCP) | `agent-mcp` |

## Guardrails (get these right)

1. **Webhook signing secret is NOT the API key.** Verify with the per-endpoint
   `whsec_*` secret (env `VON_PAY_WEBHOOK_SECRET`), not `vp_sk_*`. There is ONE
   signature format: `x-vonpay-signature: t=<unix-seconds>,v1=<hex>` (a second
   `,v1=<hex>` may appear during secret rotation). The signed timestamp is inside
   the header (`t=`), not a separate header. Call
   `vonpay.webhooks.constructEvent(rawBody, signatureHeader, whsec)` (3 args)
   over the **raw** request body.

   The parsed event is an envelope: `{ id: "vp_evt_*", type, created, livemode,
   merchant_id, data }` - the payload is nested under `data`, the merchant id is
   the snake-case `merchant_id`.

   Handle each delivery in this order, as `webhooks-node` does:

   - **Verify** the signature (`constructEvent`). Reject with 400 on failure.
   - **Check `event.test_event === true`** and, if so, return 2xx without doing
     anything else. A "Send test event" delivery is signed like a real one and
     can carry a real session's ids; the field is absent (not `false`) on every
     real event. `livemode: false` does NOT mean "test event" - real payments
     on a test key carry it too.
   - **Dedupe on `id`** in a durable store that all your servers share (the
     sample's in-memory set is for the demo only). Record the id only AFTER the
     handler succeeded: recording it on arrival turns a failed first attempt
     into a permanent drop, so the order is never fulfilled.
   - **Handle** the event. One payment can emit more than one event (for
     example a `charge.*` and a `payment_intent.*` event) with different ids,
     so make the fulfilment itself idempotent on your order, not only on the
     event id. Answer 2xx to an event type you do not handle, log it, and do
     nothing else.

   Event names in the 4.x SDK's typed `WebhookEventType` union:
   `charge.succeeded`, `charge.failed`, `charge.refunded`, `refund.failed`,
   `payment_intent.succeeded`, `payment_intent.failed`, `payment_intent.cancelled`,
   `payment_intent.authorized`, `payment_intent.held_for_review`,
   `session.succeeded`, `session.failed`, `dispute.created`, `dispute.won`,
   `dispute.lost`, `application.approved`, `application.denied`,
   `merchant.ready_for_payments`, `payout.paid`, `payout.failed`,
   `mirror.order.created`, `payment_method.attached`,
   `merchant.card_testing_suspected`, `subscription.created`,
   `subscription.renewed`, `subscription.payment_failed`,
   `subscription.cancelled`, `subscription.updated`.

   `payment_intent.authorized` fires only for a `captureMethod: "manual"`
   payment: the money is held, not taken. Do not fulfil on it; capture or void.

   These are **opt-in**. An endpoint receives each one only when it lists it
   by name (a `"*"` subscription does not count), and none is added to an
   existing endpoint for you:

   - `payment_intent.held_for_review` - do NOT fulfil on it. While the payment
     is held, `paymentIntents.retrieve()` reads `requires_action`, so a return
     page stays on "confirming your payment". The outcome arrives later as the
     normal `succeeded` / `failed` events. It is sent once, to the endpoints
     subscribed at that moment, and an endpoint can select it only once the
     merchant dashboard lists it.
   - `payment_method.attached` - not selectable yet.
   - `merchant.card_testing_suspected` - live mode only. It is an alert only:
     nothing was blocked. Review that window's payments and hold fulfilment of
     approved ones you do not recognise.
   - the five `subscription.*` events (typed from SDK 4.4.0; every Node
     sample pins `^4.5.0`).

   `webhooks-node` handles `charge.succeeded` / `charge.failed` /
   `charge.refunded` / `refund.failed` (hosted checkout + refunds) and the five
   `subscription.*` events; `payment-intents-3ds` confirms the terminal state
   from `payment_intent.succeeded` / `payment_intent.failed`.

   For subscriptions, as `webhooks-node` does:

   - Build the renewal order from `subscription.renewed`, keyed by
     `subscription_id` + `billing_cycle`.
   - `charge.*` and `payment_intent.*` carry `subscription_id` (and
     `billing_cycle`). It is set when Von Payments charged a subscription (a
     renewal, a "bill now", or the overdue charge taken after a card update)
     and `null` on every other payment, including the sign-up payment. Do not
     fulfil or fail an order from a payment event whose `subscription_id` is
     set: it is not a new purchase. A `charge.refunded` is still a refund.
   - The last `subscription.payment_failed` (with `status: "failed"`) ends the
     membership. No `subscription.cancelled` follows it, so end access there.
   - Events arrive in no guaranteed order, among themselves or relative to
     `charge.*`. Correlate on `payment_intent_id`, and do not let an event
     older than the state you already applied (compare `created`) overwrite it.

   There is **no** `session.expired` and **no**
   `refund.created` event - do not invent them. (A refund shows up as
   `charge.refunded`.)

   ⚠️ **Do not subscribe an endpoint to `session.succeeded` / `session.failed`.**
   They are typed and emitted internally, but they are not in the merchant
   subscription catalog - which accepts an unknown key, stores nothing and
   returns success. An endpoint subscribed to one receives nothing, forever,
   with no error at any layer. `charge.*` is the subscribable family for
   hosted-checkout fulfilment.

2. **Embedded card fields load `vora.js` from the CDN `<script>`** at
   `https://js.vonpay.com/v1/vora.js`. Do **not** add or npm-install any
   processor or card-network SDK for embedded checkout - the card is collected
   in a Von Payments hosted iframe, so card data never touches your server or
   DOM. The `/v1/` channel is mutable (patch releases ship to it), so it carries
   no `integrity` attribute; pin an immutable `/vX.Y.Z/` path plus its published
   SRI hash if you need stricter supply-chain control.

3. **Charge a saved card / recurring.** On the Node SDK pass
   `paymentMethod: { id: "vp_pmt_*" }` to `paymentIntents.create` (the SDK sends
   `payment_method` on the wire; the Python SDK uses the snake-case name
   directly). **Send `buyerId` on every charge against a saved card.** It is a
   protection that only applies when you send it: if the token was vaulted
   against a buyer and the `buyerId` doesn't match, the server returns
   `404 payment_method_not_found`. If you omit it, nothing rejects the charge -
   which is exactly how a billing job that joins the wrong token to the wrong
   subscriber bills someone else's card. Tokens saved with no buyer on file are
   unrestricted.
   Recurring / merchant-initiated charges add the `mit` block:
   `{ initiator: "merchant", reason: "recurring" | "unscheduled" | "installment", originalTransactionId: "<anchor vpi_* id>" }`.
   Vault a reusable card with `tokens.create({ setupForFutureUse: "off_session" })`.

4. **A return-URL signature is NOT proof of payment.** A declined payment is
   signed just as authentically as an approved one - every one of these samples
   once rendered "Payment successful" on a decline for exactly that reason. Do
   not verify the redirect yourself, and do not try to verify it with a per-
   merchant `ss_*` secret: the redirect is signed with a platform-wide secret,
   so a merchant-side check can never match.

   **Match the return to an order your server created, first.** `confirmReturn`
   answers "did this session succeed?" for ANY session on your account, so a
   success URL copied from another paid order (a cheap one, say) would
   otherwise read as paid for this one. Start from the session this browser
   started (for example a cookie set when you created the session) and that
   order's record on your server, and pass them in. Take the expected values
   only from your server's records, never from the return URL: an
   `expectedSessionId` copied from the URL checks the URL against itself. They
   are optional, and leaving them out silently turns the check off, so when
   there is no recorded order for this browser, do not call `confirmReturn`
   without them - refuse the page. `expectedAmount` is in minor units.

   Use `sessions.confirmReturn(params, undefined, { expectedSuccessUrl,
   expectedKeyMode, maxAgeSeconds, expectedSessionId, expectedAmount,
   expectedCurrency })` (Python: `confirm_return(..., expected_session_id=,
   expected_amount=, expected_currency=)`). It reads the session **from the
   server** and returns `{ paid, status, reason, sessionId, amount, currency,
   signatureValid }`. Branch as the samples do (the HTTP codes are what the
   Express and Flask samples send; the Next.js samples render the same pages
   without setting a status):

   - `reason` is `"missing_session"`, `"session_mismatch"` or
     `"amount_mismatch"` → not this order's payment. Do not show it as paid,
     and do not tell the buyer this order failed either (HTTP 400, "we
     couldn't match this payment to an order").
   - `paid === true` → show the confirmation. **The webhook
     (`charge.succeeded`) is the reliable fulfilment trigger**: buyers close
     the tab and never load this page. If you also fulfil here, call ONE
     idempotent fulfilment function from both paths, keyed on your order, so
     the two cannot ship it twice (a replayed URL reads `succeeded` again).
   - `reason === "still_pending"` → HTTP 200, neutral "confirming your payment",
     no retry button. On the 3-D Secure path the buyer lands here *before* the
     charge settles; telling them it failed makes them pay twice.
   - anything else not paid → HTTP 402, genuinely not paid.
   - the lookup **threw** → log it and show a neutral page (HTTP 503); "we
     could not check" is not "they did not pay".

   Render `outcome.amount` (from the server), never `params.amount` from the
   query string - the query string is buyer-controlled.

5. **Sandbox test cards.** A sandbox runs on its payment provider's test
   environment, which runs 3-D Secure on every card payment, so only these
   cards work, with expiry `03/30` and CVC `100`:

   | Card | What happens |
   |---|---|
   | `4111 1111 1110 1203` (Visa) / `5200 0000 0000 1203` (Mastercard) | 3-D Secure with no challenge: approves |
   | `4111 1111 1118 1072` (Visa) / `5240 0000 0000 1072` (Mastercard) | 3-D Secure challenge: pass or fail |
   | any card above at an order total of 2,000.12 (`amount: 200012`) | Declined by the card's issuer |

   Common numbers such as `4242 4242 4242 4242` are declined. A card payment can
   pause for 3-D Secure, so always send a return URL. If the merchant's dashboard
   shows different test cards for their sandbox, those win. The same list is
   published as data in `@vonpay/test-cards`, and the MCP server's
   `vonpay_checkout_list_test_cards` tool returns it (in
   `@vonpay/checkout-mcp` 6.4.2, which the sample pins).

## What the 4.x types cover

The local type bridges the 0.9-era samples needed are no longer required:

- `paymentMethod`, `returnUrl`, `buyerId`, `mit`, `captureMethod` and
  `sessionId` are typed on `CreatePaymentIntentParams`.
- `PaymentIntent.nextAction` is typed as `PaymentIntentNextAction | null`,
  i.e. the structured `{ type: "redirect_to_url", redirectToUrl: { url } }`
  object (the SDK camel-cases the wire key `redirect_to_url`).
- `payment_intent.*` and `subscription.*` events are members of the typed
  `WebhookEvent` union (the subscription payload is `SubscriptionEventData`).
- `minorUnitDigits(currency)` and `formatMinorUnits(amount, currency)` are
  exported (since `3.0.0`): the number of decimals the API uses for a
  currency, or `undefined` (never a guess) when the code is not a currency
  the API knows or its decimals are still being confirmed. `checkout-nextjs`,
  `checkout-express` and `platform-integrator-nextjs` format amounts with
  `minorUnitDigits`; the browser-side code
  in `checkout-embedded` and `checkout-paybylink-nextjs` carries a copy of
  the same table, because the server SDK cannot run in a browser.

None of the samples carry the old local type bridges any more; don't
reintroduce them.

## Conventions when extending a sample

- Keep files short and explicit; no hidden imports. Samples are written to be
  paste-friendly into an agent context.
- Use the typed SDK surface - don't hand-roll HMAC or raw `fetch` for anything
  the SDK already does (sessions, intents, tokens, webhook verification, return
  confirmation).
- Use sandbox keys (`vp_sk_test_*`) for development. `vp_pmt_test_*` tokens are
  sandbox-only.
- Amounts are in minor units. Never divide or multiply by 100: JPY has 0
  decimals and KWD has 3. Use the SDK's `minorUnitDigits`.
- Pass an `idempotencyKey` on every create-style call (Node: the `RequestOptions`
  second argument; Python: the `idempotency_key=` keyword) so retries are safe.
  Never derive it from an attempt counter - that turns a retry into a second
  charge. The announced cut-off (28 October 2026) has passed: the API may refuse
  a payment-intent create without one (`400 idempotency_key_required`, nothing
  is charged), and some payment connections already do.
- Keep the staff sign-in. In `checkout-paybylink-nextjs` and
  `platform-integrator-nextjs`, `proxy.ts` puts every page and route behind
  HTTP Basic auth with `ADMIN_TOKEN`, except the buyer's return page,
  `/api/webhooks` and Next.js static files. In production (`NODE_ENV=production`) those routes answer
  `403` until `ADMIN_TOKEN` is set. A new page or route is gated by default;
  add a path to the exception list in `proxy.ts` only when buyers must reach
  it. It is a stand-in: replace it with your own sign-in before deploying.
- Stay factual and leak-clean: no internal codenames, no dropped-vendor names,
  no internal infra/flag references. This is a public repo.

## How this repo is maintained

The sample folders are published here from the Von Payments SDK repository
and compared against it daily. Fixes to a sample land there first and are
synced here; a change made only to a sample folder in this repo is reported as
drift and overwritten by the next sync. The top-level files (this file,
`llms.txt`, `README.md`, `LICENSE`, `renovate.json`, `.github/`) are owned here.
Sample bugs: open an issue on this repo.

## Docs

- Quickstart - https://docs.vonpay.com/quickstart
- SDK references - https://docs.vonpay.com/sdks
- API / webhooks / errors / test cards - https://docs.vonpay.com/reference
