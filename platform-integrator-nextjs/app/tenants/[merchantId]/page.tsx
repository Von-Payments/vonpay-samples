import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTenant } from "@/lib/tenants";
import { CUSTOMERS } from "@/lib/customers";
import { formatMinorAmount } from "@/lib/money";

// Render on every request. Each charge form below carries an order id minted
// at render time; a cached render would hand every visitor the SAME ids, and
// their purchases would collapse into one checkout session.
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ merchantId: string }>;
}

export default async function TenantPage({ params }: Props) {
  const { merchantId } = await params;
  const tenant = getTenant(merchantId);
  if (!tenant) notFound();

  const customers = CUSTOMERS[merchantId] ?? [];

  return (
    <>
      <div style={{ marginBottom: "1rem", fontSize: 13 }}>
        <Link href="/" style={{ color: "#6b6b70", textDecoration: "none" }}>
          ← Tenants
        </Link>
      </div>

      <div style={{ marginBottom: "2rem" }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", margin: 0 }}>
          {tenant.name}
        </h1>
        <p className="muted" style={{ marginTop: 6 }}>
          merchant_id: <code>{tenant.slug}</code> · {customers.length} customers
        </p>
      </div>

      <div style={{ display: "grid", gap: "0.5rem" }}>
        {customers.map((c) => (
          <form
            key={c.id}
            action="/api/charge"
            method="POST"
            className="card"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
            }}
          >
            <input type="hidden" name="tenantId" value={tenant.id} />
            {/* One id per rendered order. A double-click or a retried POST of
                this form resends the SAME id, so it dedupes to one session;
                a separate purchase gets a separate render and a new id. In
                production, create the order row first and use its id. */}
            <input type="hidden" name="orderId" value={`ord_${randomUUID()}`} />
            {/* Only WHICH customer — never the amount. The charge route looks
                the price up on the server; anything in this form can be
                edited by whoever is looking at the page. */}
            <input type="hidden" name="customerId" value={c.id} />
            <div>
              <div style={{ fontWeight: 600 }}>{c.name}</div>
              <div className="muted" style={{ marginTop: 4 }}>
                {c.email} · {formatMinorAmount(c.chargeAmount, c.currency)}
              </div>
            </div>
            <button type="submit" className="btn btn-primary">
              Charge {formatMinorAmount(c.chargeAmount, c.currency)} →
            </button>
          </form>
        ))}
      </div>

      <div className="card" style={{ marginTop: "2.5rem", background: "#fafafb" }}>
        <strong style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: "0.08em" }}>
          What happens when you click charge
        </strong>
        <ol
          style={{
            marginTop: 10,
            fontSize: 14,
            lineHeight: 1.65,
            paddingLeft: "1.25rem",
          }}
        >
          <li>
            Form POSTs to <code>/api/charge</code> with{" "}
            <code>tenantId={tenant.id}</code>, the <code>customerId</code>, and
            an <code>orderId</code> minted when this page rendered. No amount
            is sent.
          </li>
          <li>
            Server looks the customer up in its own records and takes the
            amount and currency from there — the browser cannot change the
            price.
          </li>
          <li>
            Server resolves the tenant&apos;s <code>vp_sk</code> via{" "}
            <code>getTenantCredentials({tenant.id})</code>.
          </li>
          <li>
            Server calls <code>vonpay.sessions.create()</code> with that key,
            an <code>Idempotency-Key</code> of{" "}
            <code>{"{tenantId}:{orderId}"}</code>, and a tenant-scoped{" "}
            <code>successUrl</code>.
          </li>
          <li>Server returns a 303 redirect to the Von Payments checkout URL.</li>
          <li>
            On return, <code>/tenants/{tenant.id}/confirm</code> re-reads the
            session from the API with the tenant&apos;s own <code>vp_sk</code>.
          </li>
          <li>
            Webhook arrives at <code>/api/webhooks</code> — the handler reads{" "}
            <code>merchantId</code> from the payload to route the event back
            to the right tenant.
          </li>
        </ol>
      </div>
    </>
  );
}
