import { NextRequest, NextResponse } from "next/server";
import { VonPayCheckout } from "@vonpay/checkout-node";

const apiKey = process.env.VON_PAY_SECRET_KEY!;
const vonpay = new VonPayCheckout(apiKey);

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("x-vonpay-signature");
  const timestamp = req.headers.get("x-vonpay-timestamp");

  if (!signature || !timestamp) {
    return NextResponse.json({ error: "Missing signature headers" }, { status: 400 });
  }

  try {
    const event = vonpay.webhooks.constructEvent(body, signature, apiKey, timestamp);
    console.log(`Webhook received: ${event.event} for session ${event.sessionId}`);
    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("Webhook verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }
}
