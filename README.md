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

Each sample demonstrates the full checkout lifecycle:
- **Session creation** — server-side, with line items + buyer info
- **Return URL verification** — both v1 (`?sig=...`) and v2 (`?sig=v2_...`) signatures auto-detected
- **Webhook handling** — HMAC-SHA256 signature verification + replay window
- **Production-shaped error handling** — typed `VonPayError` from `@vonpay/checkout-node`, decline-code awareness

## Five-minute setup

### 1. Get sandbox keys

Sign up at [app.vonpay.com](https://app.vonpay.com) (OTP login, no approval queue for sandbox). From the dashboard, click **Activate Vora Sandbox** at `/dashboard/developers` — you'll have three keys instantly:

- `vp_sk_test_...` — secret API key (server-only, never ship to client)
- `vp_pk_test_...` — publishable key
- `ss_test_...` — session signing secret (verifies return URL signatures)

> **Why no shared demo keys?** Sandbox activation is faster than copying-pasting keys from a README. The dashboard hands you all three in one click and they're tied to your own test merchant — no rate-limiting collisions with other developers.

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

## SDKs used

| SDK | Package | Used in |
|---|---|---|
| Node.js | [`@vonpay/checkout-node`](https://www.npmjs.com/package/@vonpay/checkout-node) | nextjs, express, paybylink-nextjs |
| Python | [`vonpay-checkout`](https://pypi.org/project/vonpay-checkout/) | flask |
| CLI | [`@vonpay/checkout-cli`](https://www.npmjs.com/package/@vonpay/checkout-cli) | (not used in samples — install separately for ad-hoc testing) |
| MCP | [`@vonpay/checkout-mcp`](https://www.npmjs.com/package/@vonpay/checkout-mcp) | (agent-runtime integration; see docs/sdks/mcp.md) |

Samples pin to exact SDK versions during the pre-1.0 window. Renovate keeps the pins fresh — see [`renovate.json`](./renovate.json).

## What the samples don't cover (today)

- **Recurring billing / MIT renewals** — the Checkout product is session-based today; subscriptions API isn't a public surface yet.
- **Mobile native (iOS / Android)** — no native SDKs published; use the hosted checkout pattern from a webview.
- **Multi-acquirer routing UI** — routing happens server-side automatically; the public API exposes session outcome, not the routing decision tree. (See [`/vora`](https://vonpay.com/vora) for the routing story; `/orchestration` demo for a visual.)

When the underlying product surfaces these, samples will land here.

## Contributing

This repo mirrors a private internal monorepo. Bug reports + small fixes welcome via PR; larger changes (new samples, new patterns) — open an issue first so we can talk shape before you spend the time.

## License

[MIT](./LICENSE) — copy code into your stack freely.

## Support

- Docs: [docs.vonpay.com](https://docs.vonpay.com)
- API status: [status.vonpay.com](https://status.vonpay.com) *(if available)*
- Issues with the SDK or samples: [github.com/Von-Payments/vonpay-samples/issues](https://github.com/Von-Payments/vonpay-samples/issues)
- Production / underwriting: [vonpay.com/contact](https://vonpay.com/contact)
