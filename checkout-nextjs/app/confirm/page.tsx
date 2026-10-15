import { cookies } from "next/headers";
import { VonPayCheckout } from "@vonpay/checkout-node";
import { formatMinorAmount } from "@/lib/money";
import { CHECKOUT_COOKIE, getOrderBySession } from "@/lib/orders";

// Shown when a return cannot be matched to an order this server created for
// this browser. Neutral on purpose: it is NOT "payment failed" (the buyer may
// well have paid; the webhook settles that) and it offers no "pay again".
function NotMatched() {
  return (
    <main>
      <h1>We couldn&apos;t match this payment to an order started in this browser</h1>
      <p>
        If you paid, your order is safe and you will get a confirmation. You do
        not need to pay again.
      </p>
    </main>
  );
}

export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const params = await searchParams;
  const apiKey = process.env.VON_PAY_SECRET_KEY ?? "";
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

  // ⚠️ Match the return to an order YOUR server created, before anything else.
  // `confirmReturn` answers "did this session succeed?" for ANY session on
  // your account. Without this check, a success URL copied from another paid
  // order of your shop (a cheap one, say) would show "Payment successful" for
  // this one. So start from the session this browser started (the cookie set
  // by /api/checkout) and its order record on your server, and hand both to
  // `confirmReturn` below: `expectedSessionId` refuses a return that names any
  // other session, and `expectedAmount` + `expectedCurrency` refuse a session
  // paid for a different figure.
  const sessionId = (await cookies()).get(CHECKOUT_COOKIE)?.value ?? "";
  const order = sessionId ? getOrderBySession(sessionId) : undefined;
  if (!order) {
    return <NotMatched />;
  }

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
    // ⚠️ NO `secret` ARGUMENT, DELIBERATELY. Returns are signed with a
    // PLATFORM-WIDE secret that no merchant holds — holding it would let any
    // merchant forge any other merchant's confirmations. Passing a per-merchant
    // `ss_*` here buys a check that can only ever FAIL, and gating the page on
    // that failure renders "invalid signature" to a buyer who just paid.
    // `signatureValid` is `null` here (not checked); the authenticated session
    // read is what answers "did this buyer pay".
    outcome = await vonpay.sessions.confirmReturn(params, undefined, {
      expectedSuccessUrl: `${baseUrl}/confirm`,
      expectedKeyMode: apiKey.includes("_test_") ? "test" : "live",
      maxAgeSeconds: 600,
      expectedSessionId: sessionId,
      expectedAmount: order.amount,
      expectedCurrency: order.currency,
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
      </main>
    );
  }

  // Not this order's payment: the return names another session (or none), or
  // the session was for a different amount or currency. Checked before the
  // status, so a paid session for another figure never reads as paid here.
  if (
    outcome.reason === "missing_session" ||
    outcome.reason === "session_mismatch" ||
    outcome.reason === "amount_mismatch"
  ) {
    if (outcome.reason === "amount_mismatch") {
      console.error(
        `Return for order ${order.orderId}: the session's amount does not match the order; not shown as paid.`,
      );
    }
    return <NotMatched />;
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
      </main>
    );
  }

  if (!outcome.paid) {
    return (
      <main>
        <h1>Payment not completed</h1>
        <p>Status: {outcome.status ?? "unknown"}</p>
      </main>
    );
  }

  // ⚠️ Render the SERVER's amount, never `amount` from the redirect query
  // string. The query string is buyer-controlled and unauthenticated: anyone
  // can complete a real 1-unit payment and then edit the URL to show a
  // confirmation for any figure they like. `outcome.amount` came back from the
  // authenticated session read, and `confirmReturn` already checked it equals
  // your order's amount (`expectedAmount`). A paid outcome always carries it.
  const displayAmount =
    outcome.amount === undefined ? "N/A" : formatMinorAmount(outcome.amount, order.currency);

  // ⚠️ Displaying a confirmation is safe to repeat. FULFILLING is not — this URL
  // can be replayed, and the status keeps reading "succeeded" every time. Record
  // which session IDs you have already fulfilled and refuse to fulfil one twice.
  return (
    <main>
      <h1>Payment successful</h1>
      <p>Order: {order.orderId}</p>
      <p>Session: {outcome.sessionId}</p>
      <p>Status: {outcome.status}</p>
      <p>Amount: {displayAmount}</p>
      <p>Transaction: {outcome.transactionId ?? "N/A"}</p>
    </main>
  );
}
