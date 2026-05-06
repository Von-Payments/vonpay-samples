# Von Payments — webhook receiver sample (Node + Express)

A standalone reference integration showing how to **receive, verify, and process** Von Payments webhooks. The other samples in this repo show how to *send* API calls — this one shows how to handle the asynchronous events Von Payments delivers back to you.

- **Stack:** Node 20+, Express 5, TypeScript strict, ESM
- **SDK:** [`@vonpay/checkout-node@0.5.0`](https://www.npmjs.com/package/@vonpay/checkout-node)
- **Best for:** any merchant or platform integrator that needs to react to settlement, refunds, disputes, payouts, or post-3DS status updates

## What it demonstrates

| Surface | Route | Header | Secret | Events |
|---|---|---|---|---|
| **Session-level** | `POST /webhooks/session` | `X-VonPay-Signature: <hex>` | Your merchant API key (`vp_sk_*`) | `session.succeeded`, `session.failed`, `session.expired`, `refund.created` |
| **Subscription-level** | `POST /webhooks/subscription` | `x-vonpay-signature: t=<unix>,v1=<hex>` | Per-subscription `whsec_*` | `payment_intent.*`, `charge.*`, `dispute.*`, `payout.*`, `application.*`, `merchant.ready_for_payments` |

Both routes show:
- **Raw-body parsing** (`express.raw` mounted *before* `express.json`) — webhook signatures are computed over the original bytes, not over re-serialized JSON
- **Time-safe HMAC compare** (`crypto.timingSafeEqual`) — `===` leaks the secret one byte at a time under a timing attack
- **Asymmetric replay window** on the subscription surface — reject `now − t > 5 min` (stolen) and `t − now > 30 sec` (clock skew)
- **Dual-secret rotation grace** — the subscription header may carry up to two `v1=` entries, accept on any match
- **Idempotent processing** — keep a per-`event.id` guard so a redelivery (after a 5xx, for example) doesn't double-fulfill
- **Correct error responses** — `400 { error: "Invalid signature" }` on verification failure; `200` on a handler bug *after* a valid signature (don't make Von Payments retry your bug)

## 5-minute setup

### 1. Get sandbox keys

Sign up at [app.vonpay.com](https://app.vonpay.com), then `/dashboard/developers` → **Activate Vora Sandbox**. You'll get `vp_sk_test_…` (used as the session-webhook secret).

If you intend to consume the subscription surface (`payment_intent.*`, `charge.*`, etc.), also create a webhook subscription at `/dashboard/developers/webhooks` — that mints a `whsec_…` secret.

### 2. Configure + run

```bash
cp .env.example .env
# edit .env — paste in vp_sk_test_… (and optionally whsec_… if you have one)

npm install
npm run dev
```

Server starts on `http://localhost:3000`. Hit `GET /` for a route reference.

### 3. Test locally

Webhooks need a publicly-reachable URL. Two options:

- **ngrok** — `ngrok http 3000`. Use the `https://….ngrok-free.app/webhooks/session` URL when registering the endpoint.
- **cloudflared** — `cloudflared tunnel --url http://localhost:3000`. Same idea, no account needed.
- **webhook.site** — useful for *inspecting* deliveries without verifying. Forward to your localhost via `webhook.site` → settings → URL forwarding. Verification will obviously fail until you run this server.

Register the public URL in the dashboard at [app.vonpay.com/dashboard/developers/webhooks](https://app.vonpay.com/dashboard/developers/webhooks). Choose which events you want delivered. Then trigger one — completing a sandbox checkout will fire `session.succeeded` to the session route, and (if you have a subscription) `charge.succeeded` to the subscription route.

See the [test-in-sandbox guide](https://docs.vonpay.com/guides/test-in-sandbox) for the full sandbox flow.

### 4. Expected log output

A successful session-level delivery prints (one line per event, structured JSON):

```json
{"level":"info","route":"/webhooks/session","event":"session.succeeded","sessionId":"vp_cs_test_kJq7Lp","merchantId":"merch_abc123","transactionId":"vp_txn_9f2nd","amount":1499,"currency":"USD","replay":false}
```

A subscription-level `payment_intent.succeeded`:

```json
{"level":"info","route":"/webhooks/subscription","eventId":"vp_evt_8x4n2pq7m1","type":"payment_intent.succeeded","merchantId":"vp_mer_abc123","paymentIntent":"vp_txn_abc123","amount":1499,"currency":"USD","livemode":false,"replay":false}
```

A redelivery (same event after a transient 5xx) prints `"replay":true` — the structured log gives you a quick visual on retry behavior without trawling the dashboard delivery log.

A bad signature:

```json
{"level":"warn","route":"/webhooks/session","msg":"signature_verification_failed","error":"Webhook signature verification failed"}
```

## File layout

```
webhooks-node/
├── server.ts           # Express app — both routes + verification
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md
```

## Key code

**Session-level verification** uses the SDK helper:

```typescript
const event = vonpay.webhooks.constructEvent(
  req.body,                          // raw Buffer from express.raw
  req.headers["x-vonpay-signature"], // hex HMAC
  apiKey,                            // your vp_sk_* IS the secret
  req.headers["x-vonpay-timestamp"], // ISO 8601, ±5 min tolerance
);
```

**Subscription-level verification** is hand-rolled because the SDK does not (yet) ship a helper for the `t=…,v1=…` surface. The full implementation lives in `verifySubscriptionSignature()` in `server.ts` — it parses the header, enforces the asymmetric replay window, computes `HMAC_SHA256(secret, "${t}.${rawBody}")` for each configured secret, and `timingSafeEqual`s against each `v1=` entry from the header. A length-mismatched candidate throws `timingSafeEqual` and is treated as no-match — never short-circuited on length, since that leaks one bit of timing info per request.

**Raw-body parsing** is mounted on the webhook routes ONLY:

```typescript
app.use("/webhooks/session",      express.raw({ type: "application/json", limit: "1mb" }));
app.use("/webhooks/subscription", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json()); // anything else gets parsed JSON
```

If `express.json()` runs first, the original bytes are gone and the HMAC will not match. This is the most common webhook bug we see in the wild.

## Going to production

Before flipping this code at `vp_sk_live_*`:

- **Persistent idempotency store.** The in-memory `Set<eventId>` evaporates on process restart and does not deduplicate across instances behind a load balancer. Replace with one of:
  - Redis with a `SET event:<id> 1 EX 86400 NX` (returns nil → already handled, return 200 immediately)
  - Postgres `INSERT INTO processed_events (event_id) ON CONFLICT DO NOTHING` and check `affectedRows > 0`
  - Postgres advisory lock keyed on a hash of `event_id`, for handlers that fan out to multiple side-effects atomically
- **Tighten the replay window if you can.** The 5-minute past tolerance covers normal retry latency. If your endpoint sits behind a CDN with low p99 latency, dropping to 2 minutes shrinks the stolen-at-rest exploitation window. Anything below 60 seconds will start eating legitimate retries.
- **Rotate secrets without downtime.** Add the new `whsec_…` to `WEBHOOK_SUBSCRIPTION_SECRET` as `whsec_NEW,whsec_OLD`, then create the new secret in the dashboard. The dashboard signs each delivery with both during the grace window — the verifier accepts a match against either. Once all in-flight deliveries from the old secret have drained, drop the old secret from the env and revoke it in the dashboard.
- **Log carefully.** What you see in the structured log lines above is the right shape — event id, type, merchant id, business-relevant ids, amounts. **Never log the secret, never log the raw body** (it contains the signature, and during a future schema bump may carry PII), never log the full headers.
- **Monitor delivery failures.** Set up an alert on `level:warn route:/webhooks/* msg:signature_verification_failed` — a sustained spike means either secrets are out of sync or someone is probing your endpoint. Set up a separate alert on `level:error msg:handler_failed_after_verification` — that's a bug *you* shipped, not a bad signature.
- **Move the secrets out of `.env`.** Production secret managers: AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager, Doppler, 1Password Secrets Automation. Never check `.env` into git (the `.gitignore` here already blocks it; respect it).
- **Respond fast, work async.** This sample logs synchronously for clarity. In production, push the verified event onto a queue (SQS, BullMQ, Inngest, Trigger.dev) and `res.status(200)` immediately — Von Payments delivery times out at ~10 seconds and a slow handler triggers retries which compound under load.

## References

- [Webhook signature verification](https://docs.vonpay.com/integration/webhook-verification) — the canonical spec, both surfaces, six-language reference verifiers
- [Webhook event reference](https://docs.vonpay.com/integration/webhook-events) — full envelope + per-event payload schemas
- [Webhook signing secrets](https://docs.vonpay.com/integration/webhook-secrets) — creating and rotating `whsec_*`
- [Webhooks (session-level)](https://docs.vonpay.com/integration/webhooks) — the simpler API-key-signed surface
- [Test in sandbox](https://docs.vonpay.com/guides/test-in-sandbox) — end-to-end sandbox walkthrough

## Tested against

`@vonpay/checkout-node@0.5.0` · Node 20+ · Express 5
