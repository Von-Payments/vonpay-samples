"use client";

import { useEffect, useState } from "react";
import type { OtherPayment } from "@/lib/storage";
import { PaymentNotes, StatusBadge } from "../link-status";

interface LinkState {
  status: string;
  transactionId?: string;
  refundedAmount?: number;
  otherPayments?: OtherPayment[];
  reviewNote?: string;
}

interface Props {
  id: string;
  amount: number;
  currency: string;
  initial: LinkState;
}

export default function LinkStatusPoller({ id, amount, currency, initial }: Props) {
  const [link, setLink] = useState(initial);

  // Keep polling after `paid`: a refund or a second payment can still arrive.
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/links/${id}`, { cache: "no-store" });
        if (!res.ok) return;
        setLink((await res.json()) as LinkState);
      } catch {
        // Swallow transient network errors: the next tick will retry.
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [id]);

  return (
    <div>
      <p style={{ margin: 0 }}>
        <StatusBadge status={link.status} fontSize={20} />
        {link.transactionId && (
          <span style={{ fontSize: 13, color: "#666", marginLeft: 12 }}>
            tx <code>{link.transactionId}</code>
          </span>
        )}
      </p>
      <PaymentNotes
        status={link.status}
        amount={amount}
        currency={currency}
        refundedAmount={link.refundedAmount}
        otherPayments={link.otherPayments}
        reviewNote={link.reviewNote}
      />
    </div>
  );
}
