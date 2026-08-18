import { NextRequest, NextResponse } from "next/server";
import { VonPayCheckout } from "@vonpay/checkout-node";
import { updateStatus, type LinkStatus } from "@/lib/storage";

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

  try {
    const event = vonpay.webhooks.constructEvent(body, signature, webhookSecret);

    let nextStatus: LinkStatus | undefined;
    let transactionId: string | undefined;
    let sessionId: string | null = null;
    if (event.type === "session.succeeded") {
      nextStatus = "paid";
      // Every field on `event.data` is nullable — the processor does not always
      // report one. Coerce to `undefined` rather than storing a literal null.
      transactionId = event.data.transaction_id ?? undefined;
      sessionId = event.data.session_id;
    } else if (event.type === "session.failed") {
      nextStatus = "failed";
      sessionId = event.data.session_id;
    }

    // Without a session id there is nothing to match a link against. Ack the
    // delivery anyway — retrying cannot conjure the field, and a 5xx here would
    // just loop the delivery engine forever.
    if (nextStatus && sessionId) {
      const updated = updateStatus(sessionId, nextStatus, transactionId);
      // Log only the merchant-side identifiers (link id + status). Vonpay
      // session IDs are deep-link tokens — keep them out of general logs.
      console.log(
        `webhook ${event.type} →`,
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
