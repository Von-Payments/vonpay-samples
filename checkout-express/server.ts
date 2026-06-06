import express from "express";
import { VonPayCheckout } from "@vonpay/checkout-node";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const app = express();
const port = parseInt(process.env.PORT ?? "3000", 10);

const apiKey = process.env.VON_PAY_SECRET_KEY!;
const sessionSecret = process.env.VON_PAY_SESSION_SECRET!;
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

  // Branch on event type. Only `session.succeeded` means the buyer actually paid;
  // do NOT fulfill orders on `session.failed`. Session IDs
  // are deep-link tokens — keep them out of general application logs and only
  // surface in systems with the same trust boundary as the API key itself.
  switch (event.event) {
    case "session.succeeded":
      // Replace this with your order-fulfillment logic. `event.sessionId` and
      // `event.transactionId` are available here; pass them to your
      // fulfillment system but avoid logging them verbatim.
      break;
    case "session.failed":
      // Payment did not complete — do not fulfill.
      break;
    default:
      // Unknown event type — accept the webhook (ack 200) but take no action.
      break;
  }

  res.json({ received: true });
});

// ── Success return page ──────────────────────────────────────────────
app.get("/success", (req, res) => {
  const params = req.query as Record<string, string>;

  // v2 signatures require expectedSuccessUrl + expectedKeyMode; v1 ignores these options.
  // SDK auto-detects the format from params.sig prefix.
  const valid = VonPayCheckout.verifyReturnSignature(params, sessionSecret, {
    expectedSuccessUrl: `http://localhost:${port}/success`,
    expectedKeyMode: apiKey.includes("_test_") ? "test" : "live",
    maxAgeSeconds: 600,
  });
  if (!valid) {
    res.status(400).send("<h1>Invalid return signature</h1>");
    return;
  }

  const minorAmount = Number.parseInt(params.amount ?? "", 10);
  const displayAmount = Number.isFinite(minorAmount)
    ? (minorAmount / 100).toFixed(2)
    : params.amount;

  res.send(`
    <h1>Payment successful</h1>
    <p>Session: ${esc(params.session)}</p>
    <p>Status: ${esc(params.status)}</p>
    <p>Amount: ${esc(displayAmount)} ${esc(params.currency)}</p>
    <p>Transaction: ${esc(params.transaction_id ?? "N/A")}</p>
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
