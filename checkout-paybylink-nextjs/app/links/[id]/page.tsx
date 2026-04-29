import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { getLink } from "@/lib/storage";
import LinkStatusPoller from "./status-poller";

export default async function LinkDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const link = getLink(id);
  if (!link) notFound();

  const qrDataUrl = await QRCode.toDataURL(link.checkoutUrl, {
    width: 240,
    margin: 1,
    errorCorrectionLevel: "M",
  });

  return (
    <main>
      <p>
        <a href="/links">← Back to dashboard</a>
      </p>
      <h1>{link.description}</h1>
      <p style={{ fontSize: 18 }}>
        <strong>
          {(link.amount / 100).toFixed(2)} {link.currency}
        </strong>
      </p>

      <section style={{ margin: "1.5rem 0" }}>
        <h2>Share this link</h2>
        {/* checkoutUrl is a bearer token — anyone holding it can complete the payment.
            Treat it like a password: TLS only, don't log it, don't leak via Referer. */}
        <code
          style={{
            display: "block",
            padding: 12,
            background: "#f4f4f4",
            borderRadius: 4,
            wordBreak: "break-all",
            fontSize: 13,
          }}
        >
          {link.checkoutUrl}
        </code>
        <p style={{ marginTop: 8 }}>
          <a href={link.checkoutUrl} target="_blank" rel="noopener noreferrer">
            Open checkout in new tab →
          </a>
        </p>
      </section>

      <section style={{ margin: "1.5rem 0" }}>
        <h2>QR code</h2>
        <img
          src={qrDataUrl}
          alt="Checkout QR code"
          width={240}
          height={240}
          style={{ padding: 8, background: "#fff", border: "1px solid #eee" }}
        />
        <p style={{ fontSize: 13, color: "#666" }}>Scan with a phone camera to open the hosted checkout.</p>
      </section>

      <section style={{ margin: "1.5rem 0" }}>
        <h2>Status</h2>
        <LinkStatusPoller id={link.id} initialStatus={link.status} initialTransactionId={link.transactionId} />
        <p style={{ fontSize: 13, color: "#666" }}>
          Updates when the session.succeeded / session.failed / session.expired webhook arrives at
          <code> /api/webhooks</code>.
        </p>
      </section>

      <section style={{ margin: "1.5rem 0" }}>
        <h2>Metadata</h2>
        <dl style={{ fontSize: 14 }}>
          <dt>Session ID</dt>
          <dd>
            <code>{link.sessionId}</code>
          </dd>
          <dt>Created</dt>
          <dd>{new Date(link.createdAt).toLocaleString()}</dd>
          <dt>Expires</dt>
          <dd>{new Date(link.expiresAt).toLocaleString()}</dd>
        </dl>
      </section>
    </main>
  );
}
