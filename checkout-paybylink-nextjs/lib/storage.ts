export type LinkStatus = "pending" | "paid" | "failed" | "expired";

export interface PayLink {
  id: string;
  sessionId: string;
  checkoutUrl: string;
  amount: number;
  currency: string;
  description: string;
  status: LinkStatus;
  createdAt: string;
  expiresAt: string;
  transactionId?: string;
}

// Dev-only in-memory store. In production, swap for Postgres / SQLite / Redis
// and make sure link rows are scoped to the authenticated merchant operator.
const store = new Map<string, PayLink>();

export function saveLink(link: PayLink): void {
  store.set(link.id, link);
}

export function getLink(id: string): PayLink | undefined {
  return store.get(id);
}

export function listLinks(): PayLink[] {
  return Array.from(store.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateStatus(
  sessionId: string,
  status: LinkStatus,
  transactionId?: string,
): PayLink | undefined {
  for (const link of store.values()) {
    if (link.sessionId === sessionId) {
      link.status = status;
      if (transactionId) link.transactionId = transactionId;
      store.set(link.id, link);
      return link;
    }
  }
  return undefined;
}
