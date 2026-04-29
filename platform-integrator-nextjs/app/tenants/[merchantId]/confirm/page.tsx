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
  const { vpSk, ss } = getTenantCredentials(merchantId);

  // Verify the return signature against the tenant's session signing secret.
  // The SDK auto-detects v1 vs v2 from the `sig` parameter prefix; v2 options
  // (expectedSuccessUrl + expectedKeyMode) are passed unconditionally — v1
  // signatures ignore them.
  const valid = VonPayCheckout.verifyReturnSignature(params2, ss, {
    expectedSuccessUrl: `${baseUrl}/tenants/${merchantId}/confirm`,
    expectedKeyMode: vpSk.includes("_test_") ? "test" : "live",
    maxAgeSeconds: 600,
  });

  if (!valid) {
    return (
      <div className="card" style={{ borderColor: "#fecaca", background: "#fef2f2" }}>
        <h1 style={{ marginTop: 0, color: "#991b1b" }}>Invalid return signature</h1>
        <p className="muted">
          The redirect from Von Payments was not signed correctly for this
          tenant. This can happen if the wrong session signing secret is
          configured, or if someone tampered with the redirect URL.
        </p>
        <Link href={`/tenants/${merchantId}`} className="btn">
          ← Back to {tenant.name}
        </Link>
      </div>
    );
  }

  const status = params2.status ?? "unknown";
  const sessionId = params2.session ?? "";
  const txId = params2.transaction_id ?? "";
  const minor = Number.parseInt(params2.amount ?? "", 10);
  const dollarAmount = Number.isFinite(minor)
    ? `$${(minor / 100).toFixed(2)}`
    : params2.amount;

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
            <Row label="Amount" value={`${dollarAmount} ${params2.currency ?? ""}`} />
            <Row label="Signature verified" value="✓ valid" />
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
