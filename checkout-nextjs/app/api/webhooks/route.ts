import { NextRequest, NextResponse } from "next/server";
import { VonPayCheckout } from "@vonpay/checkout-node";
import { eventAlreadyHandled, getOrderBySession, markEventHandled } from "@/lib/orders";

const apiKey = process.env.VON_PAY_SECRET_KEY!;
const vonpay = new VonPayCheckout(apiKey);

// The placeholder value .env.example ships with. It is not a secret.
const PLACEHOLDER_WEBHOOK_SECRET = "whsec_your_endpoint_signing_secret";

/**
 * Per-endpoint webhook signing secret (whsec_…), shown once when you create
 * the webhook endpoint. This is NOT your API key. Returns null when it is
 * missing or still the placeholder: verifying against either would let a
 * forged delivery through (an empty or published key is no secret), so the
 * handler refuses instead.
 */
function webhookSecret(): string | null {
  const secret = process.env.VON_PAY_WEBHOOK_SECRET?.trim();
  if (!secret || secret === PLACEHOLDER_WEBHOOK_SECRET) return null;
  return secret;
}

// A real delivery is a few kilobytes. Refuse anything larger BEFORE reading it
// into memory: the signature cannot be checked until the whole body is read,
// so without a cap anyone can make this route buffer as much as they send.
const MAX_WEBHOOK_BYTES = 1024 * 1024;

/** The request body as text, or null when it is larger than MAX_WEBHOOK_BYTES. */
async function readCappedBody(req: NextRequest): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES) return null;
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_WEBHOOK_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(req: NextRequest) {
  const secret = webhookSecret();
  if (secret === null) {
    console.error(
      "VON_PAY_WEBHOOK_SECRET is not set, or is still the .env.example placeholder. " +
        "Set it to your endpoint's whsec_… signing secret. Refusing this delivery.",
    );
    // 500, not 4xx: the delivery is fine; this server is not configured yet.
    // The sender retries, and the retry succeeds once the secret is set.
    return NextResponse.json({ error: "webhook_secret_not_configured" }, { status: 500 });
  }

  const body = await readCappedBody(req);
  if (body === null) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }
  // The signed timestamp lives inside the signature header (t=,v1=) — there
  // is no separate timestamp header.
  const signature = req.headers.get("x-vonpay-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature header" }, { status: 400 });
  }

  let event;
  try {
    event = vonpay.webhooks.constructEvent(body, signature, secret);
  } catch (err) {
    // Log only err.message — passing the full err object to a structured
    // logger may serialize signature / HMAC bytes from the
    // VonPayError's diagnostic fields. We never want those in stdout.
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof TypeError) {
      // The SDK refused the SECRET (empty, an example value, or an API key),
      // before looking at the delivery. That is a setup problem on this
      // server, not a bad delivery: answer 500 so the sender retries, rather
      // than 400, which tells it to give up and drops the event.
      console.error("Webhook signing secret refused by the SDK:", message);
      return NextResponse.json({ error: "webhook_secret_not_configured" }, { status: 500 });
    }
    console.error("Webhook verification failed:", message);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // A "Send test event" delivery is signed and can carry a real order's ids: acknowledge it and do nothing else.
  if (event.test_event === true) {
    return NextResponse.json({ received: true });
  }

  // Dedupe on `event.id` (`vp_evt_*`), unique per outbound event. A
  // redelivery (after a timeout or a 5xx, or a manual resend) carries the same
  // id: acknowledge it with 200 and do nothing else.
  if (eventAlreadyHandled(event.id)) {
    return NextResponse.json({ received: true, deduped: true });
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
  try {
    switch (event.type) {
      case "charge.succeeded": {
        // Find YOUR order for this session. No order: not a checkout this
        // server started, or one it no longer holds (it restarted, or freed
        // the order long after its session expired). Acknowledge: a retry
        // cannot make the order appear. ⚠ The buyer may have paid, so a person
        // checks it: `sessions.get(session_id)` returns the metadata you set
        // (`order_id`), then they fulfil or refund it.
        const order = event.data.session_id ? getOrderBySession(event.data.session_id) : undefined;
        if (!order) {
          console.warn(`Webhook ${event.type} ${event.id}: no order for this session; nothing fulfilled. Check this payment by hand.`);
          break;
        }
        // ⛔ A LATE payment that Von Payments already refunded in full: it
        // arrived after this checkout was closed as not paid, and the buyer
        // got the money back. Never fulfil on it, and leave the order as it
        // is: a payment the buyer made another way is a different event.
        if (event.data.late_payment_auto_refunded === true) {
          console.warn(`Order ${order.orderId}: a late payment was refunded automatically. Not fulfilled; order unchanged.`);
          break;
        }
        // ⛔ Check what was paid against the order before fulfilling. A
        // payment for another amount or currency is not this order as priced:
        // hold it for a person. A field the event leaves out is not a mismatch.
        const { amount, currency } = event.data;
        const amountDiffers = typeof amount === "number" && amount !== order.amount;
        const currencyDiffers = typeof currency === "string" && currency.toUpperCase() !== order.currency;
        if (amountDiffers || currencyDiffers) {
          order.status = "needs_review";
          console.error(`Order ${order.orderId}: paid ${amount} ${currency}, expected ${order.amount} ${order.currency}. Not fulfilled.`);
          break;
        }
        // Only from pending or failed: an order held for a person stays held.
        if (order.status === "pending" || order.status === "failed") {
          order.status = "paid";
          // Replace this with your order-fulfillment logic (mark the order row
          // paid, ship, send the receipt). Pass `event.data.transaction_id` to
          // your fulfillment system but avoid logging it verbatim.
          console.log(`Order ${order.orderId} paid.`);
        }
        break;
      }
      case "charge.failed": {
        // Payment did not complete — do not fulfill.
        // `event.data.failure_reason` is the buyer-safe explanation.
        // ⛔ A failure never undoes a payment: events arrive out of order, and
        // a declined first attempt can land after the payment that went through.
        const order = event.data.session_id ? getOrderBySession(event.data.session_id) : undefined;
        if (order?.status === "pending") order.status = "failed";
        break;
      }
      default:
        // Unknown event type — accept the webhook (ack 200) but take no action.
        break;
    }
  } catch (err) {
    // OUR handler failed (a database write, say). 500 so the sender retries;
    // the event is not recorded, so the retry runs the handler again.
    console.error("Webhook handler failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }

  // Record the event only now, after it was processed without throwing.
  markEventHandled(event.id);
  return NextResponse.json({ received: true });
}
