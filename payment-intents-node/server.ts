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
 * Every step runs through the typed SDK surface — `paymentIntents.create`,
 * `paymentIntents.capture`, and `refunds.create` — and threads an
 * `idempotencyKey` through the request options so retries collapse cleanly.
 */
import {
  VonPayCheckout,
  VonPayError,
  type PaymentIntent,
  type Refund,
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
  "https://checkout.vonpay.com";

const vonpay = new VonPayCheckout({ apiKey: SECRET_KEY, baseUrl: BASE_URL });

/**
 * Log an error from any step in the lifecycle.
 *
 * `VonPayError` carries everything you need to triage a failure without a
 * follow-up retrieve:
 *   - `code` / `status` — machine-readable error code + HTTP status
 *   - `requestId` — paste this when filing a support ticket
 *   - `currentStatus` + `rejectReason` — populated on `422 invalid_transition`
 *     from the lifecycle endpoints (capture / void / refund), so you can branch
 *     (e.g. void → refund) without round-tripping a failed call
 *   - `nextAction` — programmatic decision helper (fix_input / wait_and_retry / …)
 */
function logError(label: string, err: unknown): void {
  if (err instanceof VonPayError) {
    console.error(`[${label}] VonPayError`, {
      code: err.code,
      status: err.status,
      requestId: err.requestId,
      currentStatus: err.currentStatus,
      rejectReason: err.rejectReason,
      nextAction: err.nextAction,
      message: err.message,
    });
    return;
  }
  if (err instanceof Error) {
    console.error(`[${label}] Error`, { message: err.message });
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

  // Capture the full authorized amount. Omit the params object (or pass
  // `{ amountToCapture }`) for a partial capture — the server enforces that
  // remaining = authorized − previous captures.
  let captured: PaymentIntent;
  try {
    captured = await vonpay.paymentIntents.capture(intent.id, undefined, {
      idempotencyKey: captureKey,
    });
    console.log("captured", {
      id: captured.id,
      status: captured.status,
      amount: captured.amount,
    });
  } catch (err) {
    logError("capture", err);
    process.exit(1);
  }

  // Partial refund. Omit `amount` to refund the full remaining balance.
  let refund: Refund;
  try {
    refund = await vonpay.refunds.create(
      {
        paymentIntent: intent.id,
        amount: 500,
        reason: "customer_requested",
      },
      { idempotencyKey: refundKey },
    );
    console.log("refunded", {
      id: refund.id,
      paymentIntent: refund.paymentIntent,
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
