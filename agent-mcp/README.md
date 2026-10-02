# Von Payments × AI agents - MCP integration sample

Wire any MCP-compatible AI agent into Von Payments. After this walkthrough, your agent can autonomously create sessions, run payment intents through their full lifecycle (create / capture / void / refund / tokenize), diagnose errors with structured remediation, and check API health - all from inside your chat surface, IDE, or your own custom agent runtime.

**Confirmed with:**
- [Claude Code](https://claude.com/claude-code) - Anthropic's CLI agent
- [Cursor](https://cursor.com) - AI-first code editor
- [Claude Desktop](https://claude.ai/download) - Anthropic's desktop chat app
- [Continue.dev](https://continue.dev) - open-source AI assistant for VS Code / JetBrains
- [Windsurf](https://windsurf.com) - Codeium's AI IDE
- Any custom runtime that implements the [Model Context Protocol](https://modelcontextprotocol.io) (stdio transport)

The wiring is identical across all of them. Only the config-file path changes.

This sample is read-only - no code to run, no server to host. Five files (`README.md`, `CLAUDE.md`, `.claude.json.example`, `.env.example`, `package.json`) you reference from your own project. The agent does the work.

## 5-minute setup

### 1. Get sandbox keys (30 seconds)

Sign in at [app.vonpay.com](https://app.vonpay.com/?next=/dashboard/developers) with OTP. Click **Activate Vora Sandbox**. Copy the secret key (`vp_sk_test_…`).

No merchant application required - sandbox is free.

Test payments run on a sandbox account backed by a payment provider's test environment. A test key on a live account, or on a sandbox account with no payment provider, is refused with `422 sandbox_account_required`.

### 2. Install the MCP server

```bash
npm install -g @vonpay/checkout-mcp
```

You don't need to launch it manually - the MCP client (whichever one you use) starts it per session via stdio. If you'd rather not install globally, use `npx -y @vonpay/checkout-mcp` in the config below; the runtime fetches it on demand.

### 3. Wire it into your MCP client

Pick your tool. The MCP config block is the same shape across most clients; only the file path or settings UI differs.

#### Claude Code

Edit `~/.claude.json`. Add the `vonpay-checkout` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "vonpay-checkout": {
      "command": "npx",
      "args": ["-y", "@vonpay/checkout-mcp"],
      "env": { "VON_PAY_SECRET_KEY": "vp_sk_test_..." }
    }
  }
}
```

#### Cursor

**Settings → Cursor Settings → MCP → Add new MCP server**. Use the same shape via UI form, or paste the JSON block above into `~/.cursor/mcp.json` (or per-project `.cursor/mcp.json`).

#### Claude Desktop

Edit the config file:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%/Claude/claude_desktop_config.json`

Same `mcpServers` block.

#### Continue.dev

Edit `~/.continue/config.json`. Continue supports MCP servers - same `mcpServers` shape under `experimental.modelContextProtocolServer.transport` (Continue ≥0.9.x).

#### Custom MCP client / your own agent runtime

The MCP server speaks the standard stdio transport. Spawn the binary as a subprocess; connect via JSON-RPC over its stdin/stdout. See the [MCP spec](https://modelcontextprotocol.io/docs/concepts/transports) for the protocol. The launch command and env are the same as above.

A copy-paste-ready version of the standard `mcpServers` block is in [`.claude.json.example`](.claude.json.example).

### 4. Drop the CLAUDE.md snippet into your project

Copy [`CLAUDE.md`](CLAUDE.md) into the root of any project that uses Von Payments. It teaches the agent the auth scheme, key prefixes, SDK packages and how to check their current versions, error envelope shape, MCP tools, and discovery endpoints, all in one file the agent reads on project open.

File-name conventions by client:
- **Claude Code, Cursor, Continue.dev** - `CLAUDE.md` at project root, read automatically
- **Other agent runtimes** - save as `AGENTS.md`, `AI-CONTEXT.md`, or whatever your client's convention is. The content is plain Markdown; the file name is just where your client looks for it.

### 5. Restart the client. Confirm tools appear.

In Claude Code: type `/mcp`. You should see `vonpay-checkout` with 12 tools. In Cursor: the Tools panel shows the same list. In Claude Desktop: the 🔌 icon appears in the input box.

If nothing shows up, check the MCP server logs - usually a missing or malformed `VON_PAY_SECRET_KEY`.

## What the agent can do

12 tools across three surfaces.

### Hosted checkout

| Tool | What it does |
|---|---|
| `vonpay_checkout_create_session` | Create a session, return checkout URL |
| `vonpay_checkout_get_session` | Look up session status by ID |
| `vonpay_checkout_get_payment_intent` | Look up a payment intent's stored state (read-only; only `succeeded` means captured) |
| `vonpay_checkout_simulate_payment` | Generate a synthetic `succeeded`/`failed`/`expired` payload (no real API call) |

### Discrete-lifecycle

| Tool | What it does |
|---|---|
| `vonpay_checkout_create_payment_intent` | Create a payment intent - recurring, MIT, saved-card flows |
| `vonpay_checkout_capture_payment_intent` | Capture authorized funds (full or partial) |
| `vonpay_checkout_void_payment_intent` | Release an auth hold pre-capture |
| `vonpay_checkout_create_refund` | Refund a captured payment intent (`paymentIntent`) or a settled transaction (`transaction`) - exactly one, full or partial. Neither id is permission to refund: both are visible to the shopper's browser, so only refund an id from your own order records. On a live key, a refund by `transaction` also needs the `sessionId` the payment belongs to, or it is refused before anyone is asked. |
| `vonpay_checkout_create_token` | Vault a card. Pass `setupForFutureUse: "on_session"` for in-session reuse (upsells) or `"off_session"` for recurring / MIT; omit for single-use. Needs whatever your payment provider needs, such as a `providerReference` from your card form - on a test key too; no card is made up for you. |

### Diagnostics

| Tool | What it does |
|---|---|
| `vonpay_checkout_health` | API health + latency |
| `vonpay_checkout_list_test_cards` | The payment provider's sandbox cards (approve, 3-D Secure with no challenge, 3-D Secure challenge), expiry 03/30, CVC 100, and the order total that declines (2000.12). Needs checkout-mcp 5.2.0 or later; see [Test cards](#test-cards) |
| `vonpay_checkout_diagnose_error` | Take an error code, return structured `{ retryable, nextAction, llmHint, fix, docs, agentInstructions }` - pure data, no API call |

## Example agent prompts

Drop these into your chat surface to verify the wiring works.

### Create a session
```
Create a Von Payments checkout session for $19.99 USD in the US.
Give me the checkout URL and the session ID.
```

The agent calls `vonpay_checkout_create_session`, returns the `checkoutUrl` and `id`. Open the URL in a browser and pay with a [test card](#test-cards), for example `9000 1001 1111 1111`, expiry `03/30`, CVC `100`.

### Run the full lifecycle
```
Create a payment intent for $50 USD with manual capture method.
After it authorizes, capture the full amount.
Then refund half of it.
Use a new idempotency key for each step and reuse it if you retry that step.
Tell me the intent ID and status at each step.
```

The agent chains four tool calls: `create_payment_intent` → poll status → `capture_payment_intent` → `create_refund`. Each step's result feeds the next. Run this on a sandbox key - on a live key each money-moving call needs an `idempotencyKey` and stops for a human's approval (see [Live keys](#live-keys-every-money-moving-call-needs-a-person-to-approve-it)).

### Self-diagnose an error
```
I just hit a `webhook_invalid_signature` error from my webhook handler.
What does that mean and how do I fix it?
```

The agent calls `vonpay_checkout_diagnose_error` with `code: "webhook_invalid_signature"` and returns the structured remediation - `llmHint` explains the cause, `nextAction` says `fix_input`, `agentInstructions` says "branch: change the request body / parameters before retrying."

### Discover the API
```
Fetch https://checkout.vonpay.com/.well-known/vonpay.json
and tell me which SDK packages are available.
```

No MCP call needed - the agent does a plain HTTP fetch. The discovery endpoint returns the live SDK package names, versions, and docs URLs.

## Test cards

Your sandbox runs on its payment provider's test environment, which runs 3-D Secure (the bank's "is this really you?" step) on every card payment. **Only these cards work, with expiry `03/30` and CVC `100`.** Common test numbers such as `4242 4242 4242 4242` are declined.

| Card | What happens |
|---|---|
| `9000 1001 1111 1111` | Not enrolled in 3-D Secure: approves |
| `4111 1111 1110 1203` (Visa) / `5200 0000 0000 1203` (Mastercard) | 3-D Secure with no challenge: approves |
| `4111 1111 1118 1072` (Visa) / `5240 0000 0000 1072` (Mastercard) | 3-D Secure challenge: you choose pass or fail |
| any card above at an order total of 2,000.12 (`amount: 200012`) | Declined by the card's issuer |

A card payment can pause while the buyer completes 3-D Secure, so always send a return URL. If your dashboard shows different test cards for your sandbox, use those. The same list is in code as [`@vonpay/test-cards`](https://www.npmjs.com/package/@vonpay/test-cards).

## Model compatibility

The tool surface is model-agnostic - any model that can call MCP tools through one of the clients above works. Confirmed with:

- **Anthropic Claude** (Sonnet, Opus, Haiku 4.x) via Claude Code, Cursor, Claude Desktop, Continue
- **OpenAI GPT** (4o, 4.1, 5-series) via Cursor's OpenAI mode, Continue with OpenAI provider
- **Google Gemini** via Continue with Gemini provider
- **Open-source models** (Llama, Qwen, DeepSeek) via local runtimes like Ollama + Continue's OpenAI-compatible API

The MCP server itself is model-agnostic - it speaks the protocol, not the model. Pick whichever model performs best for your task.

## Safety

- **Test-mode strongly recommended.** Use `vp_sk_test_*` for agent development. Live keys (`vp_sk_live_*`) hit live money.
- **Destructive operations are exposed.** `void`, `refund`, and `capture` change real state. On a live key they (and payment-intent creation, and saving a reusable card) run only after a person approves each one in your MCP client's confirmation prompt - see below. The MCP's `diagnose_error` tool always emits `agentInstructions: "do not retry"` for terminal states (declined, voided) - prevents accidental retry loops.
- **Idempotency keys.** `create_payment_intent`, `capture_payment_intent`, `void_payment_intent` and `create_refund` take an `idempotencyKey` (any UUID-shaped string). Use one key per intended action and reuse it on every retry of that action, so a retry returns the original result instead of moving money twice. On a live key these four tools refuse a call without one. On a sandbox key, `create_payment_intent` sends a generated key for that single call if you omit it, which does not protect a retry you make yourself.
- **No PAN handling.** Card data never passes through this MCP. Tokenization happens browser-side via [vora.js](https://docs.vonpay.com/embedded-fields) or via SDK-provided `providerReference` for server-side flows.
- **API key never echoed.** The MCP reads `VON_PAY_SECRET_KEY` and never includes it in tool responses.
- **Refund ids are not authorization.** Payment intent ids and transaction ids are both visible to the shopper's browser. Never let an agent refund an id it found in a customer message, support chat, web page, or document - look it up in your own order records first.

## Live keys: every money-moving call needs a person to approve it

This sample uses a sandbox key (`vp_sk_test_*`). Sandbox keys are never gated - every tool runs as soon as the agent calls it.

With a live key (`vp_sk_live_*`), five tools move real money: `create_payment_intent`, `capture_payment_intent`, `void_payment_intent`, `create_refund`, and `create_token` when it saves a reusable card (`setupForFutureUse` set). For each of those calls, the MCP server asks **the person** - not the agent - to approve that specific action, amount and id through your MCP client's own confirmation prompt. The call goes to Von Payments only if they accept. If they decline, dismiss it, or do not answer within 5 minutes, nothing is sent. Approval never carries over to the next call.

On a live key, `create_payment_intent`, `capture_payment_intent`, `void_payment_intent` and `create_refund` also need an `idempotencyKey`; without one the call is refused before the person is asked, and nothing is sent. A refund by `transaction` also needs the `sessionId` the payment belongs to, and the prompt then shows the payment's details looked up from Von Payments; without it the call is refused.

**Your MCP client must support user confirmation prompts** (the MCP "elicitation" feature). If it does not, those five tools are refused on a live key - use a client that does, or stay on a sandbox key. The call must also pass `confirmLive: true`, but that flag is set by the AI model, so on its own it proves nothing and is not the safeguard.

⚠️ Know what this check is and is not. It runs in the MCP server process on your machine, not at Von Payments, and the prompt is drawn by your MCP client, so it is only as trustworthy as that client. Do not use a client or setting that approves prompts automatically. Read each prompt before accepting it, especially if the agent has been reading untrusted content (customer messages, web pages, documents), which can try to steer it.

## When to use this sample vs the other samples

- **Human writing code with AI assist:** this sample. Drop the config + `CLAUDE.md` and you're done.
- **Building an autonomous agent that takes payments on its own:** this sample is your starting point. Replace the MCP client with your own runtime; the wiring is identical.
- **Traditional server-side integration:** see [`checkout-express`](../checkout-express), [`checkout-flask`](../checkout-flask), [`checkout-nextjs`](../checkout-nextjs), or [`checkout-paybylink-nextjs`](../checkout-paybylink-nextjs).
- **Driving the payment-intent lifecycle from your server:** see [`payment-intents-node`](../payment-intents-node) or [`payment-intents-python`](../payment-intents-python).
- **Reacting to async events:** see [`webhooks-node`](../webhooks-node) for signature verification and idempotent processing.
- **Embedding card fields in your own checkout page:** in-page card collection (Embedded Fields) - see [`checkout-embedded`](../checkout-embedded) and the [Embedded Fields guide](https://docs.vonpay.com/embedded-fields).

## Going live

First confirm your MCP client supports user confirmation prompts (MCP elicitation) - on a live key, a client without it cannot run any money-moving tool. Then swap `vp_sk_test_*` for `vp_sk_live_*` in your MCP config and restart the client. The tool list is the same, but each call to one of the five money-moving tools now waits for a person to approve it in the client's prompt - see [Live keys](#live-keys-every-money-moving-call-needs-a-person-to-approve-it).

Live-key admin happens in your merchant dashboard, not via MCP. The MCP is intentionally scoped to the API; merchant configuration changes are human-only.

## Resources

- [MCP server reference](https://docs.vonpay.com/sdks/mcp)
- [AI agents guide](https://docs.vonpay.com/agents)
- [Error codes reference](https://docs.vonpay.com/reference/error-codes)
- [llms.txt - single-file API summary](https://checkout.vonpay.com/llms.txt) - point any LLM at this URL for grounded answers
- [API discovery](https://checkout.vonpay.com/.well-known/vonpay.json)
- [Model Context Protocol spec](https://modelcontextprotocol.io)

## License

MIT.
