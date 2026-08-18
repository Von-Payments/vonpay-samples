import { VonPayCheckout } from "@vonpay/checkout-node";

export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const params = await searchParams;
  const sessionSecret = process.env.VON_PAY_SESSION_SECRET!;
  const apiKey = process.env.VON_PAY_SECRET_KEY ?? "";
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

  // `confirmReturn` verifies the signature AND confirms server-side that the
  // payment actually succeeded.
  //
  // ⚠️ Do NOT use `verifyReturnSignature` here and treat its `true` as proof of
  // payment. It proves the message is AUTHENTIC — a DECLINED payment is signed
  // just as authentically as an approved one. This page used to render
  // "Payment successful" on signature validity alone, which meant deliberately
  // paying with a card you knew would decline produced a valid success page.
  //
  // Fulfil from your webhook handler, not from here — buyers close laptops and
  // never load this page. https://docs.vonpay.com/integration/handle-return
  let outcome;
  try {
    // Constructed INSIDE the try on purpose: the constructor throws when the
    // key is missing, and outside it that becomes a framework 500 for a buyer
    // who has just paid — bypassing the friendly page below.
    const vonpay = new VonPayCheckout(apiKey);
    outcome = await vonpay.sessions.confirmReturn(params, sessionSecret, {
      expectedSuccessUrl: `${baseUrl}/confirm`,
      expectedKeyMode: apiKey.includes("_test_") ? "test" : "live",
      maxAgeSeconds: 600,
    });
  } catch (err) {
    // Log it: a revoked key would otherwise show every buyer "refresh in a
    // moment" forever with nothing in your logs.
    console.error(
      "Return confirmation failed:",
      err instanceof Error ? err.message : String(err),
    );
    // The lookup failed — we could not check. That is NOT "they did not pay",
    // so do not tell the buyer their payment failed.
    return (
      <main>
        <h1>We could not confirm your payment just now</h1>
        <p>
          No action needed — if you were charged, your order is safe. Please
          refresh in a moment.
        </p>
        <p>
          <a href="/links">← Back to dashboard</a>
        </p>
      </main>
    );
  }

  if (!outcome.signatureValid) {
    return (
      <main>
        <h1>Invalid return signature</h1>
        <p>The payment confirmation could not be verified.</p>
        <p>
          <a href="/links">← Back to dashboard</a>
        </p>
      </main>
    );
  }

  // ⚠️ IN FLIGHT is not DECLINED. On the 3-D Secure path the buyer is returned
  // here BEFORE the charge settles, so this is the ordinary case there — not an
  // edge case. Telling this buyer their payment failed is how they end up
  // paying twice. The webhook settles it; never offer a "pay again" affordance.
  if (outcome.reason === "still_pending") {
    return (
      <main>
        <h1>Confirming your payment…</h1>
        <p>
          Your bank is still finishing this off. You do not need to pay again —
          we&apos;ll email you as soon as it completes.
        </p>
        <p>
          <a href="/links">← Back to dashboard</a>
        </p>
      </main>
    );
  }

  if (!outcome.paid) {
    return (
      <main>
        <h1>Payment not completed</h1>
        <p>Status: {outcome.status ?? "unknown"}</p>
        <p>
          <a href="/links">← Back to dashboard</a>
        </p>
      </main>
    );
  }

  const minorAmount = Number.parseInt(params.amount ?? "", 10);
  const displayAmount = Number.isFinite(minorAmount) ? (minorAmount / 100).toFixed(2) : params.amount;

  // ⚠️ Displaying a confirmation is safe to repeat. FULFILLING is not — this URL
  // can be replayed, and the status keeps reading "succeeded" every time. Record
  // which session IDs you have already fulfilled and refuse to fulfil one twice.
  return (
    <main>
      <h1>Payment successful</h1>
      <p>Session: {outcome.sessionId}</p>
      <p>Status: {outcome.status}</p>
      <p>
        Amount: {displayAmount} {params.currency}
      </p>
      <p>Transaction: {params.transaction_id ?? "N/A"}</p>
      <p>
        <a href="/links">← Back to dashboard</a>
      </p>
    </main>
  );
}
