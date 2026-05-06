/**
 * Server-side payment intent flow — auth → capture → partial refund → idempotency replay.
 *
 * Demonstrates the manual-capture lifecycle for the Vonpay Checkout API:
 *   1. Create a manual-capture intent (authorizes funds, does not settle).
 *   2. Capture the full authorized amount.
 *   3. Issue a partial refund.
 *   4. Replay step 1 with the same Idempotency-Key — server returns the
 *      original intent, not a duplicate.
 *
 * SDK 0.5.0 exposes `paymentIntents.create` only. Capture and refund are
 * called through raw `fetch` here; switch to `paymentIntents.capture` and
 * `refunds.create` once 0.6.x ships.
 */
import {
  VonPayCheckout,
  VonPayError,
  type PaymentIntent,
} from "@vonpay/checkout-node";

const SECRET_KEY = process.env["VON_PAY_SECRET_KEY"];
if (!SECRET_KEY) {
  console.error(
    "VON_PAY_SECRET_KEY is required. Copy .env.example to .env and paste your sandbox key.",
  );
  process.exit(2);
}

const BASE_URL =
  process.env["VON_PAY_BASE_URL"]?.replace(/\/+$/, "") ??
  "https://checkout-staging.vonpay.com";

const vonpay = new VonPayCheckout({ apiKey: SECRET_KEY, baseUrl: BASE_URL });

interface RefundWire {
  id: string;
  payment_intent: string;
  amount: number;
  currency: string;
  status: "pending" | "succeeded" | "failed";
  reason: string | null;
}

/** Wire-shape (snake_case) of the PaymentIntent returned by capture. */
interface PaymentIntentWire {
  id: string;
  status: PaymentIntent["status"];
  amount: number;
  currency: string;
  capture_method: PaymentIntent["captureMethod"];
  next_action: string | null;
  decline_code: string | null;
  created_at: string;
  metadata?: Record<string, string>;
}

interface ErrorWire {
  error?: string;
  code?: string;
  fix?: string;
  payment_intent?: string;
  current_status?: string;
  reject_reason?: string;
}

/**
 * Raw HTTP call against Vonpay endpoints not yet wrapped by SDK 0.5.0.
 * Matches the SDK's auth + idempotency + Von-Pay-Version conventions so a
 * future migration to `paymentIntents.capture` / `refunds.create` is a
 * one-liner.
 */
async function vonpayFetch<T>(
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${SECRET_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Idempotency-Key": idempotencyKey,
  };

  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const requestId = response.headers.get("X-Request-Id") ?? "";

  if (!response.ok) {
    let payload: ErrorWire = {};
    try {
      payload = (await response.json()) as ErrorWire;
    } catch {
      // Body wasn't JSON — fall through with empty payload.
    }
    const err = new Error(
      `${path} failed: ${response.status} ${payload.code ?? "unknown"} — ${payload.error ?? response.statusText}`,
    );
    Object.assign(err, {
      status: response.status,
      code: payload.code,
      requestId,
      currentStatus: payload.current_status,
      rejectReason: payload.reject_reason,
    });
    throw err;
  }

  return (await response.json()) as T;
}

function logError(label: string, err: unknown): void {
  if (err instanceof VonPayError) {
    // VonPayError (SDK 0.5.0) carries code + status + requestId. Lifecycle
    // extras (current_status / reject_reason on 422 invalid_transition) come
    // back from the raw-fetch path below — capture/void/refund aren't yet
    // wrapped by the SDK.
    console.error(`[${label}] VonPayError`, {
      code: err.code,
      status: err.status,
      requestId: err.requestId,
      message: err.message,
    });
    return;
  }
  if (err instanceof Error) {
    const extras = err as Error & {
      status?: number;
      code?: string;
      requestId?: string;
      currentStatus?: string;
      rejectReason?: string;
    };
    console.error(`[${label}] Error`, {
      message: extras.message,
      status: extras.status,
      code: extras.code,
      requestId: extras.requestId,
      currentStatus: extras.currentStatus,
      rejectReason: extras.rejectReason,
    });
    return;
  }
  console.error(`[${label}] non-Error thrown`, { type: typeof err, value: String(err) });
}

async function main(): Promise<void> {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const createKey = `pi-create-${runId}`;
  const captureKey = `pi-capture-${runId}`;
  const refundKey = `pi-refund-${runId}`;

  console.log("payment-intents-node sample", { baseUrl: BASE_URL, runId });

  let intent: PaymentIntent;
  try {
    intent = await vonpay.paymentIntents.create(
      {
        amount: 2500,
        currency: "USD",
        captureMethod: "manual",
        metadata: { sample: "payment-intents-node", run_id: runId },
      },
      { idempotencyKey: createKey },
    );
    console.log("created", {
      id: intent.id,
      status: intent.status,
      captureMethod: intent.captureMethod,
      amount: intent.amount,
      currency: intent.currency,
    });
  } catch (err) {
    logError("create", err);
    process.exit(1);
  }

  // The capture endpoint requires `authorized`. If the sandbox returned
  // anything else (decline, processor quirk), bail cleanly so the operator
  // can inspect rather than chasing a 422.
  if (intent.status !== "authorized") {
    console.error("create did not return authorized — aborting before capture", {
      id: intent.id,
      status: intent.status,
      declineCode: intent.declineCode,
    });
    process.exit(1);
  }

  let captured: PaymentIntentWire;
  try {
    captured = await vonpayFetch<PaymentIntentWire>(
      `/v1/payment_intents/${encodeURIComponent(intent.id)}/capture`,
      {},
      captureKey,
    );
    console.log("captured", {
      id: captured.id,
      status: captured.status,
      amount: captured.amount,
    });
  } catch (err) {
    logError("capture", err);
    process.exit(1);
  }

  let refund: RefundWire;
  try {
    refund = await vonpayFetch<RefundWire>(
      "/v1/refunds",
      {
        payment_intent: intent.id,
        amount: 500,
        reason: "customer_requested",
      },
      refundKey,
    );
    console.log("refunded", {
      id: refund.id,
      paymentIntent: refund.payment_intent,
      amount: refund.amount,
      status: refund.status,
    });
  } catch (err) {
    logError("refund", err);
    process.exit(1);
  }

  // Replay the create with the same Idempotency-Key. Server should return
  // the original intent verbatim — same id, no second authorization.
  let replay: PaymentIntent;
  try {
    replay = await vonpay.paymentIntents.create(
      {
        amount: 2500,
        currency: "USD",
        captureMethod: "manual",
        metadata: { sample: "payment-intents-node", run_id: runId },
      },
      { idempotencyKey: createKey },
    );
  } catch (err) {
    logError("idempotency-replay", err);
    process.exit(1);
  }

  const replayMatched = replay.id === intent.id;
  console.log("idempotency-replay", {
    replayedId: replay.id,
    originalId: intent.id,
    matched: replayMatched,
  });
  if (!replayMatched) {
    console.error(
      "idempotency replay did not return the original intent — investigate",
    );
    process.exit(1);
  }

  console.log("done");
}

main().catch((err: unknown) => {
  logError("main", err);
  process.exit(1);
});
