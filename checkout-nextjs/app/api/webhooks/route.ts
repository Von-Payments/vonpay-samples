import { NextRequest, NextResponse } from "next/server";
import { VonPayCheckout } from "@vonpay/checkout-node";

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

  const body = await req.text();
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

  return NextResponse.json({ received: true });
}
