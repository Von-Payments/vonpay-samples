import { NextRequest, NextResponse } from "next/server";
import { VonPayCheckout } from "@vonpay/checkout-node";

const apiKey = process.env.VON_PAY_SECRET_KEY!;
// Per-endpoint webhook signing secret (whsec_…), shown once when you create
// the webhook endpoint. This is NOT your API key.
const webhookSecret = process.env.VON_PAY_WEBHOOK_SECRET!;
const vonpay = new VonPayCheckout(apiKey);

export async function POST(req: NextRequest) {
  const body = await req.text();
  // The signed timestamp lives inside the signature header (t=,v1=) — there
  // is no separate timestamp header.
  const signature = req.headers.get("x-vonpay-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature header" }, { status: 400 });
  }

  let event;
  try {
    event = vonpay.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    // Log only err.message — passing the full err object to a structured
    // logger may serialize signature / HMAC bytes from the
    // VonPayError's diagnostic fields. We never want those in stdout.
    console.error("Webhook verification failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
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

  return NextResponse.json({ received: true });
}
