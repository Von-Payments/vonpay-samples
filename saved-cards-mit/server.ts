/**
 * Saved cards + merchant-initiated (MIT) charges — Node sample.
 *
 * Demonstrates the full server-side "save a card, then rebill it" lifecycle
 * against the Vonpay Checkout API, using only typed SDK methods:
 *
 *   1. Read `capabilities.get()` and confirm `supportedOperations.mit`. MIT
 *      is processor-gated — branch on the matrix, never hard-code.
 *   2. Vault a reusable payment-method token with
 *      `setupForFutureUse: "off_session"`. Off-session consent is REQUIRED
 *      before any merchant-initiated charge will succeed.
 *   3. Run the cardholder-initiated anchor charge (CIT) — the first intent in
 *      the chain, where the buyer was present and gave consent. This intent's
 *      `vpi_*` id becomes the `originalTransactionId` for every later MIT.
 *   4. Run a merchant-initiated recurring charge (MIT) — a subscription
 *      renewal driven by your scheduler, with the `mit` block anchored on the
 *      CIT id.
 *
 * Single-script demo: it runs once and exits. There is no hosted-checkout
 * redirect here — the merchant server drives the whole lifecycle.
 *
 * SDK surface: every call below is a typed method on `@vonpay/checkout-node`
 * (>= 0.6.0): `capabilities.get`, `tokens.create`, `paymentIntents.create`
 * (incl. the `mit` block). No raw fetch, no hand-rolled HMAC.
 */
import {
  VonPayCheckout,
  VonPayError,
  type Capabilities,
  type CreatePaymentIntentParams,
  type PaymentIntent,
  type Token,
} from "@vonpay/checkout-node";

// ─── Type bridge for a documented-but-not-yet-typed wire field ────────────
//
// `payment_method` is a documented request field on POST /v1/payment_intents
// (it is how the charge references the vaulted card), but the 0.9.1 typed
// `CreatePaymentIntentParams` does not include it yet. `paymentIntents.create`
// deep-converts every param to snake_case and forwards it, so passing it
// through works at runtime — we widen the param type locally. Without this the
// vaulted token would never reach the charge and the renewal would be rejected
// with `payment_method_required` / `payment_method_consent_missing`.
interface ChargeParams extends CreatePaymentIntentParams {
  /** vp_pmt_* token from `tokens.create` (or Vora Mirror's submit()). */
  paymentMethod: { id: string };
}

const SECRET_KEY = process.env["VON_PAY_SECRET_KEY"];
if (!SECRET_KEY) {
  console.error(
    "VON_PAY_SECRET_KEY is required. Copy .env.example to .env and paste your sandbox key.",
  );
  process.exit(2);
}

// The SDK targets production by default; a `vp_sk_test_*` key runs in sandbox
// mode there (no separate host). Override VON_PAY_BASE_URL only if support
// directs you elsewhere.
const BASE_URL =
  process.env["VON_PAY_BASE_URL"]?.replace(/\/+$/, "") ??
  "https://checkout.vonpay.com";

const vonpay = new VonPayCheckout({ apiKey: SECRET_KEY, baseUrl: BASE_URL });

/** Pretty-print a VonPayError (or any thrown value) with the fields worth keeping. */
function logError(label: string, err: unknown): void {
  if (err instanceof VonPayError) {
    // VonPayError carries the machine-readable code, HTTP status, the
    // X-Request-Id for support tickets, and — on a 4xx lifecycle rejection —
    // currentStatus + rejectReason so you can branch without a follow-up call.
    console.error(`[${label}] VonPayError`, {
      code: err.code,
      status: err.status,
      requestId: err.requestId,
      currentStatus: err.currentStatus,
      rejectReason: err.rejectReason,
      message: err.message,
    });
    return;
  }
  if (err instanceof Error) {
    console.error(`[${label}] Error`, { message: err.message });
    return;
  }
  console.error(`[${label}] non-Error thrown`, {
    type: typeof err,
    value: String(err),
  });
}

async function main(): Promise<void> {
  // A single run id keeps idempotency keys + metadata correlated across the
  // four steps. Re-running the script gives you a fresh run id (fresh chain).
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const subscriptionId = `sub_${runId}`;

  console.log("saved-cards-mit sample", { baseUrl: BASE_URL, runId });

  // ── Step 1: capability gate ────────────────────────────────────────────
  // MIT is processor-gated. Read the matrix once and branch on it — don't
  // assume every connected processor supports merchant-initiated charges.
  let caps: Capabilities;
  try {
    caps = await vonpay.capabilities.get();
  } catch (err) {
    logError("capabilities", err);
    process.exit(1);
  }

  const mitSupported = caps.supportedOperations.mit;
  console.log("capabilities", {
    mit: mitSupported,
    networkTokens: caps.supportedOperations.networkTokens,
  });

  // ── Step 2: vault a reusable card ──────────────────────────────────────
  // `setupForFutureUse: "off_session"` captures the buyer's consent to be
  // charged when they are NOT present. This is mandatory for MIT — a token
  // vaulted single-use (omitted) or "on_session" is rejected with
  // `payment_method_consent_missing` on the MIT charge.
  //
  // On a sandbox key the server auto-mints a mock card token; with a live
  // iframe-vault provider you'd pass `providerReference` (the browser-minted
  // vault handle from Vora Mirror's elements.submit()) — see the README.
  let token: Token;
  try {
    token = await vonpay.tokens.create(
      {
        buyerId: `buyer_${runId}`,
        setupForFutureUse: "off_session",
        metadata: { sample: "saved-cards-mit", subscription_id: subscriptionId },
      },
      { idempotencyKey: `token-${runId}` },
    );
    console.log("vaulted card", {
      id: token.id,
      status: token.status,
      setupForFutureUse: token.setupForFutureUse,
      card: token.card
        ? `${token.card.brand} •••• ${token.card.last4} (${token.card.expMonth}/${token.card.expYear})`
        : undefined,
    });
  } catch (err) {
    logError("tokens.create", err);
    process.exit(1);
  }

  if (token.setupForFutureUse !== "off_session") {
    // Defensive: if the vault row didn't land off-session, MIT will be
    // rejected downstream. Surface it now rather than chasing a 422 later.
    console.error(
      "token was not vaulted off-session — MIT charges will be rejected with payment_method_consent_missing",
      { id: token.id, setupForFutureUse: token.setupForFutureUse },
    );
    process.exit(1);
  }

  // ── Step 3: cardholder-initiated anchor charge (CIT) ───────────────────
  // The buyer is present here (e.g. the checkout where they subscribed). This
  // is the first intent in the chain — it captures cardholder consent and its
  // id becomes the anchor for every later merchant-initiated renewal.
  let anchor: PaymentIntent;
  try {
    const anchorParams: ChargeParams = {
      amount: 2999,
      currency: "USD",
      captureMethod: "automatic",
      // Charge the card we just vaulted. This is what makes it a saved-card
      // charge — without `payment_method` the intent has no instrument to bill.
      paymentMethod: { id: token.id },
      metadata: {
        sample: "saved-cards-mit",
        subscription_id: subscriptionId,
        flow: "cardholder_initiated_anchor",
      },
    };
    anchor = await vonpay.paymentIntents.create(anchorParams, {
      idempotencyKey: `${subscriptionId}-anchor`,
    });
    console.log("anchor charge (CIT)", {
      id: anchor.id,
      status: anchor.status,
      amount: anchor.amount,
      currency: anchor.currency,
      declineCode: anchor.declineCode,
    });
  } catch (err) {
    logError("paymentIntents.create (anchor)", err);
    process.exit(1);
  }

  // The MIT chain must anchor on a SUCCEEDED cardholder-initiated intent. If
  // the anchor didn't settle (decline, 3DS pending), there's nothing to rebill
  // against yet — stop here rather than tagging a broken chain.
  if (anchor.status !== "succeeded") {
    console.error(
      "anchor intent did not succeed — cannot anchor an MIT chain on it",
      {
        id: anchor.id,
        status: anchor.status,
        declineCode: anchor.declineCode,
        nextAction: anchor.nextAction,
      },
    );
    process.exit(1);
  }

  // ── Step 4: merchant-initiated recurring charge (MIT) ──────────────────
  // This is the renewal your scheduler fires N days later with the buyer
  // absent. The `mit` block tags it for scheme-level stored-credential
  // compliance and anchors it to the CIT id from step 3.
  if (!mitSupported) {
    // Sandbox / processors without MIT enabled report `mit: false`. We don't
    // fake a renewal — we tell you exactly why it's skipped and what to do.
    console.log("skipping MIT renewal — supportedOperations.mit is false", {
      hint: "Sandbox keys report mit:false. Connect a live processor with MIT support enabled to run the renewal.",
      anchorTransactionId: anchor.id,
    });
    console.log("done (anchor + saved card only)");
    return;
  }

  let renewal: PaymentIntent;
  try {
    const renewalParams: ChargeParams = {
      amount: 2999,
      currency: "USD",
      captureMethod: "automatic",
      // Same vaulted card as the anchor — rebilled off-session.
      paymentMethod: { id: token.id },
      mit: {
        initiator: "merchant",
        reason: "recurring",
        // The anchor: the first (cardholder-initiated) intent in the chain.
        originalTransactionId: anchor.id,
      },
      metadata: {
        sample: "saved-cards-mit",
        subscription_id: subscriptionId,
        flow: "merchant_initiated_renewal",
        cycle_id: `${subscriptionId}-cycle-2`,
      },
    };
    renewal = await vonpay.paymentIntents.create(renewalParams, {
      // Deterministic key tied to the billing cycle — a retried renewal job
      // collapses to one charge instead of double-billing the customer.
      idempotencyKey: `${subscriptionId}-cycle-2`,
    });
    console.log("renewal charge (MIT)", {
      id: renewal.id,
      status: renewal.status,
      amount: renewal.amount,
      currency: renewal.currency,
      declineCode: renewal.declineCode,
    });
  } catch (err) {
    logError("paymentIntents.create (MIT renewal)", err);
    process.exit(1);
  }

  if (renewal.status !== "succeeded") {
    console.error("renewal did not succeed — run your dunning flow", {
      id: renewal.id,
      status: renewal.status,
      declineCode: renewal.declineCode,
    });
    process.exit(1);
  }

  console.log("done", {
    savedCard: token.id,
    anchorTransactionId: anchor.id,
    renewalTransactionId: renewal.id,
  });
}

main().catch((err: unknown) => {
  logError("main", err);
  process.exit(1);
});
