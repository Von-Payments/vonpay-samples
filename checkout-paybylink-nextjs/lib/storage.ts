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
  __vonpaySamplePayLinkEvents?: Set<string>;
};
const store = (holder.__vonpaySamplePayLinks ??= new Map<string, PayLink>());

// Webhook event ids (`vp_evt_*`) already processed to completion. In
// production keep these in a table with a UNIQUE index on the event id: this
// Set forgets everything on restart and is not shared between instances.
const handledEventIds = (holder.__vonpaySamplePayLinkEvents ??= new Set<string>());

/** Peek: has this webhook event already been processed? Does not record. */
export function eventAlreadyHandled(eventId: string): boolean {
  return handledEventIds.has(eventId);
}

/**
 * Record a webhook event as processed. Call this only AFTER the handler has
 * finished without throwing. If it is recorded on arrival instead, a handler
 * that fails part-way leaves the event marked, and every redelivery (including
 * a manual resend) is dropped as a duplicate.
 */
export function markEventHandled(eventId: string): void {
  handledEventIds.add(eventId);
}

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

/**
 * Set a link's status from a webhook.
 *
 * ⛔ `paid` is final. Webhooks can arrive late and out of order, and one link
 * can see a failed attempt (a declined card) as well as the payment that went
 * through. A `charge.failed` that lands after `charge.succeeded` must not turn
 * a paid link back into a failed one, or the merchant chases a buyer who has
 * already paid. A refund is a separate state; it does not come through here.
 */
export function updateStatus(
  sessionId: string,
  status: LinkStatus,
  transactionId?: string,
): PayLink | undefined {
  for (const link of store.values()) {
    if (link.sessionId === sessionId) {
      if (link.status === "paid") return link;
      link.status = status;
      if (transactionId) link.transactionId = transactionId;
      store.set(link.id, link);
      return link;
    }
  }
  return undefined;
}
