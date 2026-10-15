export type LinkStatus = "pending" | "paid" | "failed";

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
// Held on `globalThis` so the API routes and the pages (which Next.js may load
// as separate modules) all see the same links; the confirm page depends on it.
const holder = globalThis as typeof globalThis & {
  __vonpaySamplePayLinks?: Map<string, PayLink>;
};
const store = (holder.__vonpaySamplePayLinks ??= new Map<string, PayLink>());

export function saveLink(link: PayLink): void {
  store.set(link.id, link);
}

export function getLink(id: string): PayLink | undefined {
  return store.get(id);
}

/** The link a checkout session was created for, or undefined if it is not one of yours. */
export function getLinkBySessionId(sessionId: string): PayLink | undefined {
  for (const link of store.values()) {
    if (link.sessionId === sessionId) return link;
  }
  return undefined;
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
