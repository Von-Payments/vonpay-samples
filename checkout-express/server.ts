import express from "express";
import { VonPayCheckout } from "@vonpay/checkout-node";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const app = express();
const port = parseInt(process.env.PORT ?? "3000", 10);

const apiKey = process.env.VON_PAY_SECRET_KEY!;
// Per-endpoint webhook signing secret (whsec_…), shown once when you create
// the webhook endpoint. This is NOT your API key — verifying with the API key
// will fail against real production deliveries.
const webhookSecret = process.env.VON_PAY_WEBHOOK_SECRET!;
const vonpay = new VonPayCheckout(apiKey);

// Capture the RAW body for the webhook route (a Buffer, byte-faithful) — the
// HMAC must be computed over the exact bytes Von Payments signed, so this must
// run BEFORE express.json(). express.json() elsewhere is fine for normal routes.
app.post("/webhooks", express.raw({ type: "application/json" }));
app.use(express.json());

// ── Create checkout session ──────────────────────────────────────────
app.post("/checkout", async (_req, res) => {
  try {
    const session = await vonpay.sessions.create({
      amount: 2500,
      currency: "USD",
      successUrl: `http://localhost:${port}/success`,
      cancelUrl: `http://localhost:${port}/`,
      lineItems: [{ name: "Sample Item", quantity: 1, unitAmount: 2500 }],
    });
    res.redirect(303, session.checkoutUrl);
  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ── Webhook handler ──────────────────────────────────────────────────
app.post("/webhooks", (req, res) => {
  // The signed timestamp lives INSIDE the x-vonpay-signature header
  // (t=<unix>,v1=<hex>) — there is no separate timestamp header.
  const signature = req.headers["x-vonpay-signature"] as string;
  // Raw bytes from express.raw() — constructEvent accepts string | Buffer.
  const body = req.body as Buffer;

  let event;
  try {
    event = vonpay.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    // Log only err.message — passing the full err object to a structured
    // logger may serialize signature / HMAC bytes from the
    // VonPayError's diagnostic fields. We never want those in stdout.
    console.error("Webhook verification failed:", err instanceof Error ? err.message : String(err));
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  // Branch on event type. `charge.succeeded` is the event that means the buyer
  // actually paid; do NOT fulfill orders on `charge.failed`. Session IDs
  // are deep-link tokens — keep them out of general application logs and only
  // surface in systems with the same trust boundary as the API key itself.
  //
  // ⚠️ Do NOT subscribe to `session.succeeded`. The server emits it internally,
  // but it is absent from the merchant subscription catalog — which accepts an
  // unknown event key, stores nothing and returns success. An endpoint
  // subscribed to it receives nothing, forever, and no error is raised at any
  // layer. `charge.*` is the subscribable family.
  switch (event.type) {
    case "charge.succeeded":
      // Replace this with your order-fulfillment logic. `event.data.session_id`
      // and `event.data.transaction_id` are available here; pass them to your
      // fulfillment system but avoid logging them verbatim. Dedupe on
      // `event.id` so a redelivery cannot fulfill the same order twice.
      break;
    case "charge.failed":
      // Payment did not complete — do not fulfill.
      // `event.data.failure_reason` is the buyer-safe explanation.
      break;
    default:
      // Unknown event type — accept the webhook (ack 200) but take no action.
      break;
  }

  res.json({ received: true });
});

// ── Success return page ──────────────────────────────────────────────
app.get("/success", async (req, res) => {
  const params = req.query as Record<string, string>;

  // `confirmReturn` verifies the signature AND confirms server-side that the
  // payment actually succeeded.
  //
  // ⚠️ Do NOT use `verifyReturnSignature` here and treat its `true` as proof of
  // payment. It proves the message is AUTHENTIC — a DECLINED payment is signed
  // just as authentically as an approved one. This page used to render
  // "Payment successful" on signature validity alone, which meant deliberately
  // paying with a card you knew would decline produced a valid "success" page.
  //
  // The webhook handler above already had this guard; the return handler did
  // not. Note that it is the WEBHOOK that should trigger fulfilment — buyers
  // close laptops and never load this page.
  let outcome;
  try {
    // ⚠️ NO `secret` ARGUMENT, DELIBERATELY. Returns are signed with a
    // PLATFORM-WIDE secret that no merchant holds — holding it would let any
    // merchant forge any other merchant's confirmations. Passing a per-merchant
    // `ss_*` here buys a check that can only ever FAIL, and gating the page on
    // that failure renders "invalid signature" to a buyer who just paid.
    // `signatureValid` is `null` here (not checked); the authenticated session
    // read is what answers "did this buyer pay".
    outcome = await vonpay.sessions.confirmReturn(params, undefined, {
      expectedSuccessUrl: `http://localhost:${port}/success`,
      expectedKeyMode: apiKey.includes("_test_") ? "test" : "live",
      maxAgeSeconds: 600,
    });
  } catch (err) {
    // The lookup failed — we could not check. That is NOT "they did not pay",
    // so do not tell the buyer their payment failed.
    //
    // Log it. A revoked key or a rate-limit block would otherwise show every
    // buyer "please refresh in a moment" forever with nothing in your logs —
    // a permanent failure wearing the costume of a temporary one.
    console.error(
      "Return confirmation failed:",
      err instanceof Error ? err.message : String(err),
    );
    res
      .status(503)
      .send("<h1>We could not confirm your payment just now</h1>" +
            "<p>No action needed — if you were charged, your order is safe. " +
            "Please refresh in a moment.</p>");
    return;
  }

  // ⚠️ IN FLIGHT is not DECLINED. On the 3-D Secure path the buyer is returned
  // here BEFORE the charge settles, so this is the ordinary case there — not an
  // edge case. Telling this buyer their payment failed is how they end up
  // paying twice. Never a 402, never a retry affordance; the webhook settles it.
  if (outcome.reason === "still_pending") {
    res
      .status(200)
      .send("<h1>Confirming your payment…</h1>" +
            "<p>Your bank is still finishing this off. You do not need to pay " +
            "again — we'll email you as soon as it completes.</p>");
    return;
  }

  if (!outcome.paid) {
    res
      .status(402)
      .send(`<h1>Payment not completed</h1><p>Status: ${esc(outcome.status ?? "unknown")}</p>`);
    return;
  }

  // ⚠️ Render the SERVER's amount, never `amount` from the redirect query
  // string. The query string is buyer-controlled and unauthenticated: anyone
  // can complete a real 1-unit payment and then edit the URL to show a
  // confirmation for any figure they like. `outcome.amount` came back from the
  // authenticated session read.
  const displayAmount =
    typeof outcome.amount === "number" ? (outcome.amount / 100).toFixed(2) : "—";

  // ⚠️ Displaying a confirmation is safe to repeat. FULFILLING is not — this
  // URL can be replayed, and the status keeps reading "succeeded" every time.
  // Before shipping goods, record which session IDs you have already fulfilled
  // and refuse to fulfil one twice. Fulfil from the webhook, not from here.
  res.send(`
    <h1>Payment successful</h1>
    <p>Session: ${esc(params.session)}</p>
    <p>Status: ${esc(outcome.status ?? "")}</p>
    <p>Amount: ${esc(displayAmount)} ${esc(outcome.currency ?? "")}</p>
    <p>Transaction: ${esc(outcome.transactionId ?? "N/A")}</p>
  `);
});

// ── Health check ─────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    const health = await vonpay.health();
    res.json(health);
  } catch (err) {
    console.error("Health check failed:", err);
    res.status(503).json({ status: "unreachable" });
  }
});

app.get("/", (_req, res) => {
  res.send(`
    <h1>VonPay Checkout - Express Sample</h1>
    <form action="/checkout" method="POST">
      <button type="submit">Pay $25.00</button>
    </form>
  `);
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
