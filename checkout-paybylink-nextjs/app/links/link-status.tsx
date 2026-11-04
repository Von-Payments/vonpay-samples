import { formatMinorAmount } from "@/lib/money";
import type { OtherPayment } from "@/lib/storage";

const COLORS: Record<string, string> = {
  pending: "#666",
  paid: "#0a7a2f",
  failed: "#b00020",
  refunded: "#7a5c00",
  needs_review: "#b35900",
};

const LABELS: Record<string, string> = {
  needs_review: "needs review",
};

export function StatusBadge({ status, fontSize }: { status: string; fontSize?: number }) {
  return (
    <span style={{ color: COLORS[status] ?? "#333", fontWeight: 600, fontSize }}>
      {LABELS[status] ?? status}
    </span>
  );
}

export interface PaymentNotesProps {
  status: string;
  amount: number;
  currency: string;
  refundedAmount?: number;
  otherPayments?: OtherPayment[];
  reviewNote?: string;
}

/** What staff need to see beside the status: refunds, and why a link needs review. */
export function PaymentNotes({
  status,
  amount,
  currency,
  refundedAmount,
  otherPayments,
  reviewNote,
}: PaymentNotesProps) {
  const money = (minor: number) => formatMinorAmount(minor, currency);
  return (
    <div style={{ fontSize: 13, fontWeight: 400, color: "#444" }}>
      {refundedAmount ? (
        <p style={{ margin: "4px 0" }}>
          Refunded {money(refundedAmount)} of {money(amount)}
        </p>
      ) : null}
      {status === "needs_review" && (
        <p style={{ margin: "4px 0" }}>
          Check this link in your dashboard before you fulfil or refund. Do not ask the buyer to
          pay again.
        </p>
      )}
      {reviewNote && <p style={{ margin: "4px 0" }}>{reviewNote}</p>}
      {(otherPayments ?? []).map((payment) => (
        <p key={payment.transactionId} style={{ margin: "4px 0" }}>
          Other payment <code>{payment.transactionId}</code>
          {payment.refundedAmount > 0 && `: refunded ${money(payment.refundedAmount)}`}
        </p>
      ))}
    </div>
  );
}
