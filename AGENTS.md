# AGENTS.md — guidance for AI coding agents

You're extending the Von Payments sample apps. This file gives you the facts you
need to do it correctly: the SDK release lines the samples build against, the
guardrails that are easy to get wrong, what the 2.x SDK types cover, and how to
pick a starting sample.

Read this alongside [`llms.txt`](./llms.txt). Keep everything factual — no
invented endpoints, events, or fields. Every claim below was checked against the
samples' code and the published SDK type definitions on **2026-09-21**; when in
doubt, the sample's own `package.json` / `requirements.txt` and the installed
SDK's `.d.ts` files win over this page.

## SDK release lines (checked 2026-09-21)

| Package | Samples pin | Current release | Where |
|---|---|---|---|
| `@vonpay/checkout-node` | `^2` (lockfiles at `2.0.0`) | `2.6.1` | npm — Node / TypeScript server SDK |
| `vonpay-checkout` | `>=2,<3` | `2.6.1` | PyPI — Python server SDK |
| `@vonpay/checkout-mcp` | `^1` (lockfile at `1.0.0`) | `2.0.1` | npm — MCP server (`agent-mcp` sample) |
| `@vonpay/checkout-cli` | not pinned by any sample | `0.5.3` | npm — CLI |
| `vora.js` | CDN only, `https://js.vonpay.com/v1/vora.js` | `/v1/` channel auto-ships patches | browser SDK for embedded card fields — **no npm package** |

Rules of thumb:

- **Never pin to a 0.x version.** A caret range on 0.x locks the *minor*, so the
  pin can never move; the samples sat on `^0.9.0` for a year that way, through a
  webhook envelope change and a money bug. Use the `2.x` line for the server SDKs.
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
   merchant_id, data }` — the payload is nested under `data`, the merchant id is
   the snake-case `merchant_id`. Dedupe on `id`; handlers must be idempotent.

   Event names in the 2.x SDK's typed `WebhookEventType` union:
   `charge.succeeded`, `charge.failed`, `charge.refunded`, `refund.failed`,
   `payment_intent.succeeded`, `payment_intent.failed`, `payment_intent.cancelled`,
   `session.succeeded`, `session.failed`, `dispute.created`, `dispute.won`,
   `dispute.lost`, `application.approved`, `application.denied`,
   `merchant.ready_for_payments`, `payout.paid`, `payout.failed`.

   The samples branch on `charge.succeeded` / `charge.failed` / `charge.refunded`
   / `refund.failed` (hosted checkout + refunds) and `payment_intent.succeeded` /
   `payment_intent.failed` (server-driven flow). There is **no** `session.expired`
   and **no** `refund.created` event — do not invent them. (A refund shows up as
   `charge.refunded`.)

   ⚠️ **Do not subscribe an endpoint to `session.succeeded` / `session.failed`.**
   They are typed and emitted internally, but they are not in the merchant
   subscription catalog — which accepts an unknown key, stores nothing and
   returns success. An endpoint subscribed to one receives nothing, forever,
   with no error at any layer. `charge.*` is the subscribable family for
   hosted-checkout fulfilment.

2. **Embedded card fields load `vora.js` from the CDN `<script>`** at
   `https://js.vonpay.com/v1/vora.js`. Do **not** add or npm-install any
   processor or card-network SDK for embedded checkout — the card is collected
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
   `404 payment_method_not_found`. If you omit it, nothing rejects the charge —
   which is exactly how a billing job that joins the wrong token to the wrong
   subscriber bills someone else's card. Tokens saved with no buyer on file are
   unrestricted.
   Recurring / merchant-initiated charges add the `mit` block:
   `{ initiator: "merchant", reason: "recurring" | "unscheduled" | "installment", originalTransactionId: "<anchor vpi_* id>" }`.
   Vault a reusable card with `tokens.create({ setupForFutureUse: "off_session" })`.

4. **A return-URL signature is NOT proof of payment.** A declined payment is
   signed just as authentically as an approved one — every one of these samples
   once rendered "Payment successful" on a decline for exactly that reason. Do
   not verify the redirect yourself, and do not try to verify it with a per-
   merchant `ss_*` secret: the redirect is signed with a platform-wide secret,
   so a merchant-side check can never match.

   Use `sessions.confirmReturn(params, undefined, { expectedSuccessUrl,
   expectedKeyMode, maxAgeSeconds })` (Python: `confirm_return`). It reads the
   session **from the server** and returns `{ paid, status, reason, sessionId,
   amount, signatureValid }`. Branch three ways, as the samples do:

   - `paid === true` → fulfil **once** (record the `sessionId`; a replayed URL
     reads `succeeded` again).
   - `reason === "still_pending"` → HTTP 200, neutral "confirming your payment",
     no retry button. On the 3-D Secure path the buyer lands here *before* the
     charge settles; telling them it failed makes them pay twice.
   - anything else not paid → HTTP 402, genuinely not paid.
   - the lookup **threw** → log it and show the neutral page; "we could not
     check" is not "they did not pay".

   Render `outcome.amount` (from the server), never `params.amount` from the
   query string — the query string is buyer-controlled.

## What the 2.x types cover

The local type bridges the 0.9-era samples needed are no longer required:

- `paymentMethod` is on `CreatePaymentIntentParams` since `2.0.0`;
  `returnUrl` since `2.5.0` (so not on the `2.0.0` the lockfiles hold —
  `npm update` to pick it up).
- `PaymentIntent.nextAction` is typed as `PaymentIntentNextAction | null`,
  i.e. the structured `{ type: "redirect_to_url", redirectToUrl: { url } }`
  object (the SDK camel-cases the wire key `redirect_to_url`).
- `payment_intent.*` events are members of the typed `WebhookEvent` union.
- `mit`, `buyerId`, `captureMethod`, `sessionId` are all typed.

Some samples still carry a small `ChargeParams` widening or an `as unknown`
read of `nextAction` from that era. On 2.x they are redundant, not required —
don't copy them into new code.

## Conventions when extending a sample

- Keep files short and explicit; no hidden imports. Samples are written to be
  paste-friendly into an agent context.
- Use the typed SDK surface — don't hand-roll HMAC or raw `fetch` for anything
  the SDK already does (sessions, intents, tokens, webhook verification, return
  confirmation).
- Use sandbox keys (`vp_sk_test_*`) for development. `vp_pmt_test_*` tokens are
  sandbox-only.
- Pass an `idempotencyKey` on every create-style call (Node: the `RequestOptions`
  second argument; Python: the `idempotency_key=` keyword) so retries are safe.
  Never derive it from an attempt counter — that turns a retry into a second
  charge.
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

- Quickstart — https://docs.vonpay.com/quickstart
- SDK references — https://docs.vonpay.com/sdks
- API / webhooks / errors / test cards — https://docs.vonpay.com/reference
