import Link from "next/link";
import { notFound } from "next/navigation";
import { VonPayCheckout } from "@vonpay/checkout-node";
import { getTenant, getTenantCredentials } from "@/lib/tenants";

interface Props {
  params: Promise<{ merchantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ConfirmPage({ params, searchParams }: Props) {
  const { merchantId } = await params;
  const tenant = getTenant(merchantId);
  if (!tenant) notFound();

  // Coerce searchParams into the flat string-keyed shape the SDK expects.
  const sp = await searchParams;
  const params2: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") params2[k] = v;
  }

  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  // `ss` is deliberately NOT destructured: the confirm page no longer verifies
  // the return signature (see the note at `confirmReturn` below). It is still
  // used for webhooks, where the per-tenant secret IS the right one.
  const { vpSk } = getTenantCredentials(merchantId);

  // Confirm SERVER-SIDE against the tenant's own credentials.
  //
  // ⚠️ Do NOT verify the signature and then read `status` out of the query
  // string. The signature proves the redirect is AUTHENTIC, and the status it
  // carries is a snapshot from the moment of redirect — it is not a live
  // reading. The same signed URL stays replayable for its whole max-age window
  // and keeps reporting the same thing. `confirmReturn` verifies the signature
  // AND re-reads the session from the API, which is what "did they pay?"
  // actually means. The SDK auto-detects v1 vs v2 from the `sig` prefix; the v2
  // options below are ignored by a v1 signature.
  let outcome;
  try {
    // Constructed INSIDE the try: the constructor throws on a missing or
    // malformed tenant key, and outside it that becomes a framework 500 for a
    // buyer who has just paid — bypassing the friendly page below.
    const vonpay = new VonPayCheckout(vpSk);
    // ⚠️ NO `secret` ARGUMENT, DELIBERATELY. Returns are signed with a
    // PLATFORM-WIDE secret that no merchant holds — holding it would let any
    // merchant forge any other merchant's confirmations. Passing a per-merchant
    // `ss_*` here buys a check that can only ever FAIL, and gating the page on
    // that failure renders "invalid signature" to a buyer who just paid.
    // `signatureValid` is `null` here (not checked); the authenticated session
    // read is what answers "did this buyer pay".
    outcome = await vonpay.sessions.confirmReturn(params2, undefined, {
      expectedSuccessUrl: `${baseUrl}/tenants/${merchantId}/confirm`,
      expectedKeyMode: vpSk.includes("_test_") ? "test" : "live",
      maxAgeSeconds: 600,
    });
  } catch (err) {
    // Log it: a revoked tenant key would otherwise show every one of that
    // tenant's buyers a soft error forever, with nothing in your logs.
    console.error(
      `Return confirmation failed for tenant ${merchantId}:`,
      err instanceof Error ? err.message : String(err),
    );
    // We could not CHECK. That is not the same as "they did not pay", so do
    // not tell the buyer their payment failed.
    return (
      <div className="card">
        <h1 style={{ marginTop: 0 }}>We could not confirm this payment just now</h1>
        <p className="muted">
          No action needed — if the buyer was charged, the order is safe. The
          webhook will settle it. Please refresh in a moment.
        </p>
        <Link href={`/tenants/${merchantId}`} className="btn">
          ← Back to {tenant.name}
        </Link>
      </div>
    );
  }

  // ⚠️ IN FLIGHT is not DECLINED. On the 3-D Secure path the buyer is returned
  // here BEFORE the charge settles, so this is the ordinary case there, not an
  // edge case. Showing a failure to a buyer whose card IS being charged is how
  // they end up paying twice. The webhook settles it; never offer a "pay again"
  // affordance from this branch.
  if (outcome.reason === "still_pending") {
    return (
      <div className="card">
        <h1 style={{ marginTop: 0 }}>Confirming this payment…</h1>
        <p className="muted">
          The buyer&apos;s bank is still finishing this off. They do not need to
          pay again — {tenant.name} will receive the webhook as soon as it
          completes.
        </p>
        <Link href={`/tenants/${merchantId}`} className="btn">
          ← Back to {tenant.name}
        </Link>
      </div>
    );
  }

  // `outcome.status` is the server's reading, not the query string's snapshot.
  const status = outcome.status ?? "unknown";
  const sessionId = outcome.sessionId ?? params2.session ?? "";
  const txId = outcome.transactionId ?? "";
  // ⚠️ Render the SERVER's amount, never `amount` from the redirect query
  // string. The query string is buyer-controlled and unauthenticated: anyone
  // can complete a real 1-unit payment and then edit the URL to show a
  // confirmation for any figure they like. `outcome.amount` came back from the
  // authenticated session read.
  const minor = typeof outcome.amount === "number" ? outcome.amount : NaN;
  const dollarAmount = Number.isFinite(minor) ? `$${(minor / 100).toFixed(2)}` : "—";

  return (
    <>
      <div style={{ marginBottom: "1rem", fontSize: 13 }}>
        <Link href={`/tenants/${merchantId}`} style={{ color: "#6b6b70", textDecoration: "none" }}>
          ← {tenant.name}
        </Link>
      </div>

      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: 22, fontWeight: 700 }}>
          {status === "succeeded" ? "Payment captured" : `Status: ${status}`}
        </h1>
        <p className="muted">
          Tenant: <strong style={{ color: "#0a0a0a" }}>{tenant.name}</strong>
          {" "}· merchant_id: <code>{tenant.slug}</code>
        </p>
        <table style={{ width: "100%", marginTop: 16, borderCollapse: "collapse" }}>
          <tbody>
            <Row label="Session" value={sessionId} />
            <Row label="Transaction" value={txId || "—"} />
            <Row label="Amount" value={`${dollarAmount} ${outcome.currency ?? ""}`} />
          </tbody>
        </table>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr style={{ borderTop: "1px solid #f0f0f3" }}>
      <td style={{ padding: "8px 0", color: "#6b6b70", fontSize: 13, width: 180 }}>{label}</td>
      <td style={{ padding: "8px 0", fontFamily: 'ui-monospace, "SF Mono", monospace', fontSize: 13 }}>
        {value}
      </td>
    </tr>
  );
}
