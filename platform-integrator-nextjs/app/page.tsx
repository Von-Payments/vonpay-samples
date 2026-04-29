import Link from "next/link";
import { TENANTS } from "@/lib/tenants";

export default function PlatformHome() {
  return (
    <>
      <div style={{ marginBottom: "2rem" }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", margin: 0 }}>
          Tenants
        </h1>
        <p className="muted" style={{ marginTop: 6 }}>
          Each tenant is a Von Payments merchant onboarded to the platform.
          Charges are created using the tenant&apos;s own API keys.
        </p>
      </div>

      <div style={{ display: "grid", gap: "0.75rem" }}>
        {TENANTS.map((t) => (
          <Link
            key={t.id}
            href={`/tenants/${t.id}`}
            className="card"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              textDecoration: "none",
              color: "inherit",
              transition: "border-color 0.15s",
            }}
          >
            <div>
              <div style={{ fontWeight: 600 }}>{t.name}</div>
              <div className="muted" style={{ marginTop: 4 }}>
                merchant_id: <code>{t.slug}</code> · tenant_id: <code>{t.id}</code>
              </div>
            </div>
            <span className="badge">Active</span>
          </Link>
        ))}
      </div>

      <div className="card" style={{ marginTop: "2.5rem", background: "#fafafb" }}>
        <strong style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: "0.08em" }}>
          What this sample shows
        </strong>
        <p style={{ marginTop: 8, fontSize: 14, lineHeight: 1.6 }}>
          A platform serving 3 onboarded merchants. Each tenant has its own
          Von Payments API key stored on the platform. When a customer is
          charged, the platform looks up the right tenant&apos;s key, creates a
          checkout session via <code>POST /v1/sessions</code>, and redirects
          the buyer. The webhook handler routes inbound events back to the
          correct tenant by <code>merchantId</code>.
        </p>
        <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
          See <code>lib/tenants.ts</code> for the per-tenant credential
          lookup, <code>app/api/charge/route.ts</code> for session creation,
          and <code>app/api/webhooks/route.ts</code> for tenant-routed webhook
          handling.
        </p>
      </div>
    </>
  );
}
