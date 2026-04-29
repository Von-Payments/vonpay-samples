"use client";

import { useEffect, useState } from "react";

interface Props {
  id: string;
  initialStatus: string;
  initialTransactionId?: string;
}

export default function LinkStatusPoller({ id, initialStatus, initialTransactionId }: Props) {
  const [status, setStatus] = useState(initialStatus);
  const [transactionId, setTransactionId] = useState(initialTransactionId);

  useEffect(() => {
    if (status !== "pending") return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/links/${id}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { status: string; transactionId?: string };
        setStatus(data.status);
        setTransactionId(data.transactionId);
      } catch {
        // Swallow transient network errors — next tick will retry.
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [id, status]);

  const color =
    status === "paid" ? "#0a7a2f" : status === "failed" ? "#b00020" : status === "expired" ? "#855" : "#666";

  return (
    <p style={{ fontSize: 20, fontWeight: 600, color }}>
      {status}
      {transactionId && (
        <span style={{ fontSize: 13, fontWeight: 400, color: "#666", marginLeft: 12 }}>
          tx <code>{transactionId}</code>
        </span>
      )}
    </p>
  );
}
