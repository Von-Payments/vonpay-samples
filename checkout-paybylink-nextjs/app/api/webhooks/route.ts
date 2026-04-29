import { NextRequest, NextResponse } from "next/server";
import { VonPayCheckout } from "@vonpay/checkout-node";
import { updateStatus, type LinkStatus } from "@/lib/storage";

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

    let nextStatus: LinkStatus | undefined;
    let transactionId: string | undefined;
    if (event.event === "session.succeeded") {
      nextStatus = "paid";
      transactionId = event.transactionId;
    } else if (event.event === "session.failed") {
      nextStatus = "failed";
    } else if (event.event === "session.expired") {
      nextStatus = "expired";
    }

    if (nextStatus) {
      const updated = updateStatus(event.sessionId, nextStatus, transactionId);
      console.log(
        `webhook ${event.event} → session ${event.sessionId}`,
        updated ? `link ${updated.id} → ${nextStatus}` : "(no matching link)",
      );
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    // Log only the message — avoid serializing the full error object, which in
    // some structured loggers could walk into the SDK client and surface the
    // API key.
    console.error("Webhook verification failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }
}
