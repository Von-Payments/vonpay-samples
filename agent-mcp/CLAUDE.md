# Project — Von Payments integration

This project uses [Von Payments](https://vonpay.com) for hosted checkout, embedded payment fields, and discrete-lifecycle payments. Drop this file at your project root — Claude Code, Cursor, and Continue.dev read it automatically. For other agent runtimes, save under whatever filename your client uses (`AGENTS.md` is the emerging cross-client convention).

## API

- **Base URL:** `https://checkout.vonpay.com`
- **Auth:** Bearer token in the `Authorization` header
- **Keys:**
  - Secret keys: `vp_sk_test_*` (sandbox) or `vp_sk_live_*` (production). Server-only — never bundle in browser code.
  - Publishable keys: `vp_pk_test_*` or `vp_pk_live_*`. Client-safe; used by the browser SDK.

## SDKs

- **Node:** `@vonpay/checkout-node@0.9.1` (npm; check `npm view @vonpay/checkout-node version` for latest)
- **Python:** `vonpay-checkout==0.9.1` (PyPI; check `pip index versions vonpay-checkout` for latest)
- **Browser fields:** `https://js.vonpay.com/v1/vora.js` (auto-update) or `https://js.vonpay.com/v1.3.3/vora.js` (pinned)
- **React wrapper:** `@vonpay/vora-react` — provider + hook for the browser fields (not yet published to npm)
- **MCP server (for agents):** `@vonpay/checkout-mcp@0.4.5` — adds 11 tools to any MCP-compatible client (Claude Code, Cursor, Claude Desktop, Continue.dev, Windsurf, custom runtimes). Same surface as the SDK.
- **CLI:** `@vonpay/checkout-cli@0.4.1` — local dev, webhook tail, signature verify. `--json` everywhere; `doctor --for-llm` for agent self-diagnosis.

## SDK surface (Node + Python — same shape, snake-cased in Python)

- **Sessions** — hosted-redirect checkout flow:
  - `client.sessions.create({ amount, currency, country, ... })` — returns `{ id, checkoutUrl }`
  - `client.sessions.get(id)`
  - `client.sessions.validate(params)` — dry-run validation
- **Payment intents** — discrete-lifecycle (recurring / MIT / saved cards / fulfillment-on-ship):
  - `client.paymentIntents.create({ amount, currency, captureMethod?, mit? }, { idempotencyKey? })`
  - `client.paymentIntents.capture(id, { amountToCapture? })` — full or partial
  - `client.paymentIntents.void(id)` — pre-capture cancellation
- **Refunds** — post-settlement:
  - `client.refunds.create({ paymentIntent, amount? }, { idempotencyKey? })`
- **Tokens** — save-card / network-token flows:
  - `client.tokens.create({ buyerId?, providerReference? })`
- **Capabilities** — read before invoking optional operations:
  - `client.capabilities.get()` — returns `supportedOperations.{partialCapture, partialRefund, voidAfterCapture, mit, ...}`
- **Webhooks** — HMAC-SHA256-signed events:
  - `client.webhooks.verifySignature(rawBody, signatureHeader, secret)`
  - `client.webhooks.constructEvent(rawBody, signatureHeader, secret)`

## Error handling

Every error has a typed `code`, a one-line `fix`, a `docs` URL, and a `nextAction` field. Read `VonPayError.nextAction` to branch:

- `fix_input` → change the request body and retry
- `rotate_key` → ask the user for a new key; do not retry the same one
- `wait_and_retry` → exponential backoff, retry once
- `contact_support` → terminal; surface a support path to the user
- `ignore` → terminal but expected (e.g. card declined); show the error UI, do not retry

The SDK's `VonPayError.llmHint` is a 1-3 sentence diagnostic written for an agent to act on.

## MCP tools (when the MCP server is wired in)

Available under the `vonpay_checkout_*` prefix:

- `create_session`, `get_session`, `simulate_payment`
- `create_payment_intent`, `capture_payment_intent`, `void_payment_intent`
- `create_refund`, `create_token`
- `health`, `list_test_cards`, `diagnose_error`

Each tool's input is validated by Zod; errors include the same `llmHint` + `nextAction` fields as the SDK.

## Discovery (unauthenticated)

When orienting against this project from scratch, fetch:

- `https://checkout.vonpay.com/.well-known/vonpay.json` — API metadata, SDK packages, MCP package, docs URLs
- `https://checkout.vonpay.com/llms.txt` — single-file API reference (623 lines, designed for LLM context windows)

## Conventions in this project

- Webhook signatures are verified with your per-endpoint webhook signing secret (`whsec_…`, shown once when you create the endpoint) — NOT the merchant API key. The `x-vonpay-signature` header carries `t=<unix-seconds>,v1=<hex>`; the HMAC-SHA256 is over `${t}.${rawBody}`.
- Session IDs: `vp_cs_(test|live)_*`. Payment intents: `vpi_*`. Refunds: `vpr_*`. Tokens: `vp_pmt_(test|live)_*` (all tokens use this prefix; reusability is governed by the token's `setup_for_future_use` field — `null` for single-use, `"on_session"` for in-session reuse like upsells, `"off_session"` for recurring / MIT).
- All amounts are in minor units (e.g. `1499` = $14.99). Currencies are uppercase ISO 4217.
- Idempotency keys are accepted on every create-style endpoint. Pass any UUID-shaped string; same key + same body → same result returned. Safe to retry.

## Docs

[https://docs.vonpay.com](https://docs.vonpay.com) — quickstart, API reference, error codes, integration guides, AI agents guide, Vora Mirror (embedded fields).
