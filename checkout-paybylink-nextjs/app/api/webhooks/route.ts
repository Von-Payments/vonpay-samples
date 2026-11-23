import { NextRequest, NextResponse } from "next/server";
import { VonPayCheckout } from "@vonpay/checkout-node";
import {
  eventAlreadyHandled,
  markEventHandled,
  recordRefund,
  updateStatus,
} from "@/lib/storage";

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
    // Log only the message — avoid serializing the full error object, which in
    // some structured loggers could walk into the SDK client and surface the
    // API key.
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

  // Dedupe on `event.id` (`vp_evt_*`), which is unique per outbound event. A
  // redelivery (after a timeout or a 5xx, or a manual resend) carries the same
  // id: acknowledge it and do nothing else. Do NOT build a key from the
  // payload: one payment can emit more than one event.
  //
  // 200, not 4xx: the delivery WAS accepted, it was simply handled already.
  if (eventAlreadyHandled(event.id)) {
    return NextResponse.json({ received: true, deduped: true });
  }

  let nextStatus: "paid" | "failed" | undefined;
  let transactionId: string | undefined;
  let sessionId: string | undefined;
  let paid: { amount: number | null; currency: string | null } | undefined;
  // Every field on `event.data` is nullable — the processor does not always
  // report one. Coerce to `undefined` rather than storing a literal null.
  //
  // ⚠️ These are `charge.*`, not `session.*`. The server emits `session.*`
  // internally, but those keys are absent from the merchant subscription
  // catalog — which accepts an unknown event key, stores nothing and returns
  // success. An endpoint subscribed to `session.succeeded` receives nothing,
  // forever, with no error raised at any layer, and every paid link would sit
  // at `pending` for good. `charge.*` is the subscribable family.
  if (event.type === "charge.succeeded" && event.data.late_payment_auto_refunded === true) {
    // ⛔ A LATE payment that Von Payments already refunded in full: it arrived
    // after this checkout was closed as not paid, and the buyer got the money
    // back. Never mark the link paid on it, and leave the link as it is: a
    // payment the buyer made another way is a different event.
    console.log(`webhook ${event.type} → a late payment was refunded automatically; link unchanged`);
  } else if (event.type === "charge.succeeded") {
    nextStatus = "paid";
    // `vp_tx_id` is the id to compare. `transaction_id` is not one id space:
    // two events for the SAME payment can carry different values in it, so it
    // is only the fallback for an event with no `vp_tx_id`.
    transactionId = event.data.vp_tx_id ?? event.data.transaction_id ?? undefined;
    sessionId = event.data.session_id ?? undefined;
    // What was paid. updateStatus compares it with the link's own amount and
    // currency, and sends a mismatch to needs_review instead of `paid`.
    paid = { amount: event.data.amount, currency: event.data.currency };
  } else if (event.type === "charge.failed") {
    nextStatus = "failed";
    sessionId = event.data.session_id ?? undefined;
  }

  // Without a session id there is nothing to match a link against. Ack the
  // delivery anyway — retrying cannot conjure the field, and a 5xx here would
  // just loop the delivery engine forever.
  if (nextStatus && sessionId) {
    // A paid link stays paid, even if a failed attempt's event lands after it.
    // A second success with a different transaction id goes to needs_review
    // (see updateStatus in lib/storage.ts).
    // A payment for a different amount or currency goes to needs_review too.
    const updated = updateStatus(sessionId, nextStatus, transactionId, paid);
    // Log only the merchant-side identifiers (link id + status). Vonpay
    // session IDs are deep-link tokens — keep them out of general logs.
    console.log(
      `webhook ${event.type} →`,
      updated ? `link ${updated.id} → ${updated.status}` : "(no matching link)",
    );
  }

  // One event per refund. Read `amount_refunded_total` and `refund_amount`. Do
  // NOT read `amount` or `is_partial`: on a second partial refund some payment
  // connections report a running total there and others report one refund, and
  // nothing on the event says which.
  //
  // `abandoned_payment_reversed` is the payment system giving back a payment
  // that was already closed (you never got its `charge.succeeded`), or releasing
  // its hold. It says nothing about the payment that paid this link. The same
  // goes for `late_payment_auto_refunded`: the automatic refund of a late
  // payment, which never paid this link.
  if (
    event.type === "charge.refunded" &&
    event.data.session_id &&
    event.data.reason !== "abandoned_payment_reversed" &&
    event.data.late_payment_auto_refunded !== true
  ) {
    const updated = recordRefund(event.data.session_id, {
      transactionId: event.data.vp_tx_id ?? event.data.transaction_id ?? undefined,
      refundedTotal: event.data.amount_refunded_total,
      refundAmount: event.data.refund_amount,
      originalAmount: event.data.original_charge_amount,
    });
    console.log(
      `webhook ${event.type} →`,
      updated ? `link ${updated.id} → ${updated.status}` : "(no matching link)",
    );
  }

  // Record the event only now, after it was processed without throwing. If
  // processing threw, the event stays unrecorded and a redelivery retries it.
  markEventHandled(event.id);

  return NextResponse.json({ received: true });
}
