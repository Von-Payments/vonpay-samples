# AGENTS.md — guidance for AI coding agents

You're extending the Von Payments sample apps. This file gives you the facts you
need to do it correctly: the canonical SDK versions, the guardrails that are easy
to get wrong, the known SDK type gaps, and how to pick a starting sample.

Read this alongside [`llms.txt`](./llms.txt). Keep everything binder-neutral and
factual — no invented endpoints, events, or fields.

## Use these SDK versions (authoritative)

Pin to these; do not assume newer.

| Package | Version | Where |
|---|---|---|
| `@vonpay/checkout-node` | `0.9.1` | npm — Node / TypeScript server SDK |
| `vonpay-checkout` | `0.9.1` | PyPI — Python server SDK |
| `@vonpay/checkout-cli` | `0.4.1` | npm — CLI |
| `@vonpay/checkout-mcp` | `0.4.5` | npm — MCP server |
| `vora.js` | CDN only at `https://js.vonpay.com/v1/vora.js` | browser SDK for embedded card fields — **no npm package** |

**Always check the sample's own `package.json` (Node) or `requirements.txt`
(Python) for the pinned version rather than assuming.** Node samples pin
`@vonpay/checkout-node` to `^0.9.0`; Python samples pin `vonpay-checkout==0.9.1`.

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
   signature format: `x-vonpay-signature: t=<unix>,v1=<hex>`. The signed
   timestamp is inside the header (`t=`), not a separate header. Call
   `vonpay.webhooks.constructEvent(rawBody, signatureHeader, whsec)` (3 args)
   over the **raw** request body. Hosted-checkout events today:
   `session.succeeded`, `session.failed`, `refund.created`. The discrete
   payment-intents flow surfaces terminal state via `payment_intent.succeeded` /
   `payment_intent.failed`. There is **no** `session.expired` and **no**
   `dispute.*` event — do not invent them.

2. **Embedded card fields load `vora.js` from the CDN `<script>`** at
   `https://js.vonpay.com/v1/vora.js`. Do **not** add or npm-install any
   processor or card-network SDK for embedded checkout — the card
   is collected in a Von Payments hosted iframe, so card data never touches your
   server or DOM.

3. **Charge a saved card / recurring.** Pass
   `payment_method: { id: "vp_pmt_*" }` to `paymentIntents.create`. Recurring /
   merchant-initiated charges use the `mit` block:
   `{ initiator: "merchant", reason: "recurring", originalTransactionId: "<anchor vpi_* id>" }`.
   Vault a reusable card with `tokens.create({ setupForFutureUse: "off_session" })`.

4. **Return-URL v2 signature prefix is `v2.` (a dot)**, e.g. `?sig=v2.xxxxx` —
   not `v2_`. Verify against the session signing secret (`ss_*`), not the API key.

## Known SDK type gaps (0.9.1)

These are real wire fields/shapes that the published TypeScript types don't fully
cover yet. The affected samples widen the type locally — that's the documented
workaround, not a hack. When a later SDK types these, drop the local bridge.

1. **`payment_method` / `returnUrl` on `paymentIntents.create`.** Both are valid
   request fields on the wire, but they are **not** on the typed
   `CreatePaymentIntentParams` in 0.9.1. To charge a saved card or pass a 3DS
   return URL, extend the params type locally (e.g.
   `interface ChargeParams extends CreatePaymentIntentParams { paymentMethod: { id: string }; returnUrl?: string }`)
   and cast at the call site. The SDK forwards them on the wire. See
   `saved-cards-mit` and `payment-intents-3ds`.

2. **`PaymentIntent.nextAction` is typed `string | null`, but the runtime value
   is an object.** On a `requires_action` response the field is the structured
   object `{ type: "redirect_to_url", redirectToUrl: { url: string } }` (the SDK
   camel-cases the wire key `redirect_to_url` → `redirectToUrl`; the `type` is a
   string *value* and stays `"redirect_to_url"`). Read it as `unknown`, validate
   the shape, then use `.redirectToUrl.url`. See `payment-intents-3ds`.

## Conventions when extending a sample

- Keep files short and explicit; no hidden imports. Samples are written to be
  paste-friendly into an agent context.
- Use the typed SDK surface — don't hand-roll HMAC or raw `fetch` for anything
  the SDK already does (sessions, intents, tokens, webhook verification).
- Use sandbox keys (`vp_sk_test_*`) for development. `vp_pmt_test_*` tokens are
  sandbox-only.
- Pass an `idempotencyKey` on every create-style call so retries are safe.
- Stay binder-neutral and leak-clean: no internal codenames, no dropped-vendor
  names, no internal infra/flag references. This is a public repo.

## Docs

- Quickstart — https://docs.vonpay.com/quickstart
- SDK references — https://docs.vonpay.com/sdks
- API / webhooks / errors / test cards — https://docs.vonpay.com/reference
