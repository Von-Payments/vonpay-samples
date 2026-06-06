# Von Payments — sample apps

Official runnable sample integrations for the Von Payments Checkout API. Clone any sample, drop in your sandbox keys, and you have a working checkout flow in five minutes.

> **What's a sample?** A complete, runnable application that demonstrates one integration pattern end-to-end. Not a snippet. You should be able to `git clone`, copy `.env.example` to `.env`, install dependencies, run, and watch a real session resolve in the sandbox.

## Samples

| Sample | Stack | Pattern | Best for |
|---|---|---|---|
| [`checkout-nextjs`](./checkout-nextjs) | Next.js 15 / React 19 / TypeScript | Hosted checkout (cart → redirect → confirmation) | Direct merchants on Next.js, Shopify-style storefronts |
| [`checkout-express`](./checkout-express) | Node 20+ / Express 5 / TypeScript | Hosted checkout, server-only | Headless backends, API-only flows, server-rendered apps |
| [`checkout-flask`](./checkout-flask) | Python 3.9+ / Flask | Hosted checkout, server-only | Python services, internal billing, SaaS server-side |
| [`checkout-paybylink-nextjs`](./checkout-paybylink-nextjs) | Next.js 15 / React 19 | Pay-by-link (operator generates link, customer pays) | Sales / support flows, B2B, invoicing |
| [`platform-integrator-nextjs`](./platform-integrator-nextjs) | Next.js 15 / React 19 | **Multi-tenant platform** — per-merchant credential lookup, tenant-scoped sessions, multi-tenant webhook routing | Subscription-billing CRMs, headless commerce platforms, ISVs reselling Vora to their merchants |
| [`payment-intents-node`](./payment-intents-node) | Node 20+ / TypeScript | **Server-side Payment Intents** (auth → capture → refund, idempotency replay) | Delayed-capture flows, fraud-check-before-capture, platform integrators driving the lifecycle from their server |
| [`payment-intents-python`](./payment-intents-python) | Python 3.11+ | Server-side Payment Intents (Python mirror of `payment-intents-node`) | Same as above, on Python stacks |
| [`payment-intents-3ds`](./payment-intents-3ds) | Node 20+ / Express 5 / TypeScript | **3DS / `requires_action`** — branch on intent status, top-level redirect to the issuer challenge, confirm terminal state from the webhook | Card flows that hit a 3-D Secure challenge; anyone who must handle `requires_action` correctly |
| [`saved-cards-mit`](./saved-cards-mit) | Node 20+ / TypeScript | **Saved cards + MIT** — vault a card off-session, anchor a cardholder-initiated charge, rebill with the `mit` block | Subscriptions, recurring billing, stored-credential rebills |
| [`checkout-embedded`](./checkout-embedded) | Node 20+ / Express 5 / TypeScript + CDN `<script>` | **Embedded card fields (Vora Mirror)** — in-page card collection via `vora.js`, tokenize, charge the `vp_pmt_*` token server-side | In-page checkout without a redirect; staying out of PCI scope while keeping your own UI |
| [`webhooks-node`](./webhooks-node) | Node 20+ / Express 5 / TypeScript | **Webhook receiver** — verify the `t=,v1=` signature with the `whsec_*` secret, idempotent processing, replay-window enforcement | Any integration that needs to react to async events (`session.*`, `refund.created`, `payment_intent.*`) |
| [`agent-mcp`](./agent-mcp) | MCP config (no runtime) | **AI-agent integration** — wire `@vonpay/checkout-mcp` into Claude Code, Cursor, Claude Desktop, or any MCP runtime | Building (or coding with) an agent that creates sessions and drives the payment lifecycle |

Each sample demonstrates the full checkout lifecycle:
- **Session creation** — server-side, with line items + buyer info
- **Return URL verification** — both v1 (`?sig=...`) and v2 (`?sig=v2.…`) signatures auto-detected (the v2 prefix is `v2.` with a dot)
- **Webhook handling** — HMAC-SHA256 signature verification with the per-endpoint `whsec_*` secret + replay window
- **Production-shaped error handling** — typed `VonPayError` from `@vonpay/checkout-node`, decline-code awareness

## Five-minute setup

### 1. Get sandbox keys

Start at [vonpay.com/developers](https://vonpay.com/developers) — the developer-first landing page. The **Get sandbox keys** button deep-links straight into the developer dashboard, where one click on **Activate Vora Sandbox** mints all three keys instantly:

- `vp_sk_test_...` — secret API key (server-only, never ship to client)
- `vp_pk_test_...` — publishable key
- `ss_test_...` — session signing secret (verifies return URL signatures)

OTP sign-in (any email), no merchant application, no ops approval, no shared demo credentials.

> **Already signed in?** Skip the landing page and jump straight to [app.vonpay.com/dashboard/developers](https://app.vonpay.com/dashboard/developers).
>
> **Why no shared demo keys?** Sandbox activation is faster than copy-pasting keys from a README. The dashboard hands you all three in one click and they're tied to your own test merchant — no rate-limiting collisions with other developers.

### 2. Pick a sample, configure, run

```bash
git clone https://github.com/Von-Payments/vonpay-samples.git
cd vonpay-samples/checkout-nextjs    # or any sample

cp .env.example .env.local           # edit with your three keys
npm install
npm run dev
```

Open `http://localhost:3000`, click pay, complete checkout with a [test card](https://docs.vonpay.com/reference/test-cards), watch the return + webhook fire.

### 3. Read the docs

- **[docs.vonpay.com/quickstart](https://docs.vonpay.com/quickstart)** — full 5-minute walkthrough
- **[docs.vonpay.com/sdks](https://docs.vonpay.com/sdks)** — `@vonpay/checkout-{node,python,cli,mcp}` SDK references
- **[docs.vonpay.com/reference](https://docs.vonpay.com/reference)** — API surface, webhooks, errors, test cards

## Building with AI / agent runtimes

Two surfaces let you skip writing client code entirely and integrate from inside an agent or a terminal:

- **MCP server** — [`@vonpay/checkout-mcp`](https://www.npmjs.com/package/@vonpay/checkout-mcp). Drop-in Model Context Protocol server. Add it to Claude Desktop, Cursor, Claude Code, or any MCP-aware runtime, and the agent can create sessions, list test cards, simulate payments, and inspect webhook events directly. See [`docs.vonpay.com/sdks/mcp`](https://docs.vonpay.com/sdks/mcp) for the install snippet.
- **CLI** — [`@vonpay/checkout-cli`](https://www.npmjs.com/package/@vonpay/checkout-cli). One-command session creation, webhook tail, signature verification. Works equally well for ad-hoc testing and as a tool any agent can shell out to. `npx @vonpay/checkout-cli --help`.

The samples themselves are written to be agent-paste-friendly: short files, explicit env vars, no hidden imports, typed errors. Drop a sample folder into Cursor / Claude Code and ask the agent to extend it — it has everything it needs in-context.

## SDKs

| SDK | Package | Current version | Used in |
|---|---|---|---|
| Node.js | [`@vonpay/checkout-node`](https://www.npmjs.com/package/@vonpay/checkout-node) | `0.9.1` | nextjs, express, paybylink-nextjs, platform-integrator-nextjs, payment-intents-node, payment-intents-3ds, saved-cards-mit, checkout-embedded, webhooks-node |
| Python | [`vonpay-checkout`](https://pypi.org/project/vonpay-checkout/) | `0.9.1` | flask, payment-intents-python |
| CLI | [`@vonpay/checkout-cli`](https://www.npmjs.com/package/@vonpay/checkout-cli) | `0.4.1` | install separately for ad-hoc testing or agent-tool use |
| MCP | [`@vonpay/checkout-mcp`](https://www.npmjs.com/package/@vonpay/checkout-mcp) | `0.4.5` | agent-mcp; install in an MCP-aware runtime (Claude Desktop, Cursor, etc.) |

Embedded card fields load the browser SDK (`vora.js`) from the CDN `<script>` at `https://js.vonpay.com/v1/vora.js` — there is no npm package for it; see [`checkout-embedded`](./checkout-embedded).

During the pre-1.0 window the Node samples pin `@vonpay/checkout-node` to `^0.9.0` and the Python samples pin `vonpay-checkout==0.9.1`. The pins are bumped on each SDK release; [Renovate](./renovate.json) opens the bump PRs. Check a sample's `package.json` / `requirements.txt` for the version it's actually built against.

## Roadmap

Not yet covered by the samples — by design or by product timing:

- **Mobile native (iOS / Android)** — no native SDKs yet; use the hosted checkout pattern from a webview in the meantime.
- **Multi-acquirer routing UI** — routing happens server-side automatically; the public API exposes session outcome, not the decision tree. The story is at [vonpay.com/vora](https://vonpay.com/vora); a visual is at [`/demos/vora/orchestration`](https://vonpay.com/demos/vora/orchestration).

> **Already covered:**
> - **Embedded card fields (Vora Mirror)** — in-page card collection without a redirect, via `vora.js` from the CDN. See [`checkout-embedded`](./checkout-embedded).
> - **Recurring billing / saved cards** — vault a card off-session, then rebill with the `mit` block on Payment Intents. See [`saved-cards-mit`](./saved-cards-mit) and the [Payment Intents guide](https://docs.vonpay.com/integration/payment-intents#saved-cards--merchant-initiated-mit-charges).
> - **3DS / `requires_action`** — branch on intent status and redirect to the issuer challenge. See [`payment-intents-3ds`](./payment-intents-3ds).

When the underlying product surfaces these, samples will land here.

## Contributing

Bug reports + small fixes welcome via PR; larger changes (new samples, new patterns) — open an issue first so we can talk shape before you spend the time.

## License

[MIT](./LICENSE) — copy code into your stack freely.

## Support

- **Docs** — [docs.vonpay.com](https://docs.vonpay.com)
- **Sample bugs / typos / suggestions** — [open an issue on this repo](https://github.com/Von-Payments/vonpay-samples/issues)
- **SDK bugs** — file on the package's repo: [`checkout-node`](https://github.com/Von-Payments/checkout-node/issues), [`checkout-python`](https://github.com/Von-Payments/checkout-python/issues), [`checkout-cli`](https://github.com/Von-Payments/checkout-cli/issues), [`checkout-mcp`](https://github.com/Von-Payments/checkout-mcp/issues)
- **Ready to switch from sandbox to live keys?** — book a 15-minute call at [vonpay.com/contact](https://vonpay.com/contact). Live keys require a quick KYB review; sandbox stays free forever.
