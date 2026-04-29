"use client";

import { useEffect, useState } from "react";

interface PayLink {
  id: string;
  amount: number;
  currency: string;
  description: string;
  status: string;
  createdAt: string;
}

export default function LinksDashboard() {
  const [links, setLinks] = useState<PayLink[]>([]);
  const [amount, setAmount] = useState("25.00");
  const [currency, setCurrency] = useState("USD");
  const [description, setDescription] = useState("Invoice #001");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/links");
    const { links } = (await res.json()) as { links: PayLink[] };
    setLinks(links);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const minorUnits = Math.round(Number.parseFloat(amount) * 100);
    if (!Number.isFinite(minorUnits) || minorUnits <= 0) {
      setError("Amount must be a positive number");
      setSubmitting(false);
      return;
    }

    const res = await fetch("/api/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: minorUnits, currency, description }),
    });

    if (!res.ok) {
      const { error } = (await res.json()) as { error?: string };
      setError(error ?? "Failed to create link");
      setSubmitting(false);
      return;
    }

    const link = (await res.json()) as PayLink;
    window.location.href = `/links/${link.id}`;
  }

  return (
    <main>
      <h1>Pay-by-Link dashboard</h1>
      <p>Create a hosted-checkout link, share the URL or QR, track the status.</p>

      <form onSubmit={handleCreate} style={{ display: "grid", gap: 12, maxWidth: 420, margin: "1.5rem 0" }}>
        <label>
          Amount (major units)
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            style={{ display: "block", width: "100%", padding: 8 }}
          />
        </label>
        <label>
          Currency
          <input
            type="text"
            value={currency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            required
            style={{ display: "block", width: "100%", padding: 8 }}
          />
        </label>
        <label>
          Description
          <input
            type="text"
            value={description}
            maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
            required
            style={{ display: "block", width: "100%", padding: 8 }}
          />
        </label>
        {error && <p style={{ color: "crimson" }}>{error}</p>}
        <button type="submit" disabled={submitting} style={{ padding: 10 }}>
          {submitting ? "Creating…" : "Create pay link"}
        </button>
      </form>

      <h2>Links</h2>
      {links.length === 0 ? (
        <p>No links yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={cell}>Description</th>
              <th style={cell}>Amount</th>
              <th style={cell}>Status</th>
              <th style={cell}>Created</th>
              <th style={cell}></th>
            </tr>
          </thead>
          <tbody>
            {links.map((link) => (
              <tr key={link.id}>
                <td style={cell}>{link.description}</td>
                <td style={cell}>
                  {(link.amount / 100).toFixed(2)} {link.currency}
                </td>
                <td style={cell}>
                  <StatusBadge status={link.status} />
                </td>
                <td style={cell}>{new Date(link.createdAt).toLocaleString()}</td>
                <td style={cell}>
                  <a href={`/links/${link.id}`}>Open</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

const cell: React.CSSProperties = {
  border: "1px solid #ddd",
  padding: 8,
  textAlign: "left",
  fontSize: 14,
};

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "#666",
    paid: "#0a7a2f",
    failed: "#b00020",
    expired: "#855",
  };
  return <span style={{ color: colors[status] ?? "#333", fontWeight: 600 }}>{status}</span>;
}
