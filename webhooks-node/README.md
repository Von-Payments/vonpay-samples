# Von Payments — webhook receiver sample (Node + Express)

A standalone reference integration showing how to **receive, verify, and process** Von Payments webhooks. The other samples in this repo show how to *send* API calls — this one shows how to handle the asynchronous events Von Payments delivers back to you.

- **Stack:** Node 20+, Express 5, TypeScript strict, ESM
- **SDK:** [`@vonpay/checkout-node@^0.9.0`](https://www.npmjs.com/package/@vonpay/checkout-node)
- **Best for:** any merchant or integrator that needs to react to settlement, failures, or refunds

## What it demonstrates

| Route | Header | Secret | Events |
|---|---|---|---|
| `POST /webhooks/vonpay` | `x-vonpay-signature: t=<unix>,v1=<hex>` | Per-endpoint `whsec_*` | `session.succeeded`, `session.failed`, `refund.created` |

The handler shows:

- **One-call verify + parse** with the SDK's `webhooks.constructEvent` — it verifies the HMAC, enforces the replay window, accepts a rotation grace signature, and returns a typed event. No hand-rolled crypto.
- **Raw-body parsing** (`express.raw` mounted *before* `express.json`) — webhook signatures are computed over the original bytes, not over re-serialized JSON.
- **Idempotent processing** — keep a per-event guard so a redelivery (after a 5xx, a manual resend, or a secret rotation) doesn't double-fulfill.
- **Correct error responses** — `400 { error: "Invalid signature" }` on verification failure; `200` on a handler bug *after* a valid signature (don't make Von Payments retry your bug).
- **Safe logging** — log `err.message`, never the full error object or the raw body (both can carry signature/HMAC bytes and, on a future schema bump, PII).

## 5-minute setup

### 1. Get sandbox keys

Sign up at [app.vonpay.com](https://app.vonpay.com), then `/dashboard/developers` → **Activate Vora Sandbox**. You'll get a `vp_sk_test_…` secret key.

Create a webhook endpoint at `/dashboard/developers/webhooks` — that mints the per-endpoint `whsec_…` signing secret you'll verify against. It's shown **once** at create time; store it immediately.

### 2. Configure + run

```bash
cp .env.example .env
# edit .env — paste in vp_sk_test_… and whsec_…

npm install
npm run dev
```

Server starts on `http://localhost:3000`. Hit `GET /` for a route reference.

### 3. Test locally

The fastest way to test verification end-to-end is the CLI — it signs a synthetic event with your endpoint's `whsec_*` exactly the way the live delivery engine does, and it can target `localhost` directly (no tunnel needed):

```bash
npm install -g @vonpay/checkout-cli
vonpay checkout login
vonpay checkout trigger session.succeeded --url http://localhost:3000/webhooks/vonpay
```

A passing test means your signature verification is correct, not just that the JSON parsed.

To receive **real** deliveries from a sandbox checkout, the endpoint needs a publicly-reachable URL:

- **ngrok** — `ngrok http 3000`, then register `https://….ngrok-free.app/webhooks/vonpay` in the dashboard.
- **cloudflared** — `cloudflared tunnel --url http://localhost:3000`. Same idea, no account needed.

Register the public URL in the dashboard at [app.vonpay.com/dashboard/developers/webhooks](https://app.vonpay.com/dashboard/developers/webhooks), choose the events you want, then complete a sandbox checkout to fire `session.succeeded`.

See the [test-in-sandbox guide](https://docs.vonpay.com/guides/test-in-sandbox) for the full sandbox flow.

### 4. Expected log output

A successful delivery prints one structured JSON line per event (note: business IDs like `sessionId` / `transactionId` are deliberately kept out of the log line — they are sensitive deep-link tokens):

```json
{"level":"info","route":"/webhooks/vonpay","event":"session.succeeded","merchantId":"merch_abc123","amount":1499,"currency":"USD","replay":false}
```

A redelivery (same event after a transient 5xx) prints `"replay":true`.

A bad signature:

```json
{"level":"warn","route":"/webhooks/vonpay","msg":"signature_verification_failed","error":"Webhook signature verification failed"}
```

## File layout

```
webhooks-node/
├── server.ts           # Express app — webhook route + health
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md
```

## Key code

**Verification + parse** is one SDK call. The signed timestamp lives *inside* the `x-vonpay-signature` header (the `t=` part) — there is no separate timestamp header:

```typescript
const event = vonpay.webhooks.constructEvent(
  req.body,                            // raw Buffer from express.raw
  req.headers["x-vonpay-signature"],   // t=<unix>,v1=<hex>
  webhookSecret,                       // whsec_* — NOT your API key
);
```

`constructEvent` parses the header, recomputes `HMAC_SHA256(secret, "${t}.${rawBody}")`, timing-safe-compares against each `v1=` entry (it accepts on any match, which is what makes a secret rotation seamless), enforces the replay window (reject if `now − t > 5 min` or `t − now > 30 sec`), and returns a typed `WebhookEvent`. It throws on any failure — catch it and return `400`.

**Raw-body parsing** is mounted on the webhook route ONLY:

```typescript
app.use("/webhooks/vonpay", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json()); // anything else gets parsed JSON
```

If `express.json()` runs first, the original bytes are gone and the HMAC will not match. This is the most common webhook bug we see in the wild.

## Going to production

Before flipping this code at `vp_sk_live_*`:

- **Persistent idempotency store.** The in-memory `Set` evaporates on process restart and does not deduplicate across instances behind a load balancer. Replace with one of:
  - Redis with a `SET event:<key> 1 EX 86400 NX` (returns nil → already handled, return 200 immediately)
  - Postgres `INSERT INTO processed_events (event_key) ON CONFLICT DO NOTHING` and check the affected-row count
- **Log carefully.** The structured log lines above are the right shape — event type, merchant id, amounts. **Never log the secret, never log the raw body** (it contains the signature, and on a future schema bump may carry PII), and keep session/transaction IDs out of general application logs — they are deep-link tokens with the same trust boundary as the API key.
- **Monitor delivery failures.** Alert on `level:warn route:/webhooks/vonpay msg:signature_verification_failed` — a sustained spike means the secret is out of sync or someone is probing your endpoint. Alert separately on `level:error msg:handler_failed_after_verification` — that's a bug *you* shipped, not a bad signature.
- **Move the secrets out of `.env`.** Production secret managers: AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager, Doppler, 1Password Secrets Automation. Never check `.env` into git (the `.gitignore` here already blocks it; respect it).
- **Rotate signing secrets on a schedule.** Endpoint-secret rotation is an immediate cutover — during the brief overlap the delivery engine may sign with two secrets and emit a second `v1=` entry, which `constructEvent` already accepts. Deploy the new secret to your env before completing the rotation in the dashboard. See [Webhook Signing Secrets → Rotate](https://docs.vonpay.com/integration/webhook-secrets).
- **Respond fast, work async.** This sample logs synchronously for clarity. In production, push the verified event onto a queue (SQS, BullMQ, Inngest, Trigger.dev) and `res.status(200)` immediately — delivery times out at ~10 seconds and a slow handler triggers retries which compound under load.

## A note on abandoned carts

There is no `session.expired` / "buyer abandoned the checkout" event today. The catalog only fires once a charge is attempted — a buyer who lands on the hosted checkout and closes the tab never produces an event. If you need abandoned-cart signals, poll `GET /v1/sessions/:id` after the session's TTL elapses. See [Webhooks → What this surface doesn't cover today](https://docs.vonpay.com/integration/webhooks).

## References

- [Webhooks](https://docs.vonpay.com/integration/webhooks) — overview, envelope, headers, retry behavior, best practices
- [Webhook signature verification](https://docs.vonpay.com/integration/webhook-verification) — the canonical algorithm + reference verifiers in five languages
- [Webhook event reference](https://docs.vonpay.com/integration/webhook-events) — full event catalog + per-event payload shapes
- [Webhook signing secrets](https://docs.vonpay.com/integration/webhook-secrets) — create, view-once, rotate, revoke
- [Webhook retries](https://docs.vonpay.com/integration/webhook-retries) — schedule, response-code semantics, circuit breaker
- [Test in sandbox](https://docs.vonpay.com/guides/test-in-sandbox) — end-to-end sandbox walkthrough

## Tested against

`@vonpay/checkout-node@0.9.1` · Node 20+ · Express 5
