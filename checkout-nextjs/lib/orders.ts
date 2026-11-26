/**
 * Your order records: the order each checkout session was created for, keyed
 * by session id. The return page looks the order up HERE, never from the URL,
 * and the webhook handler marks the same record paid.
 *
 * In memory for the sample, held on `globalThis` so the API routes and the
 * confirm page (which Next.js may load as separate modules) share one map. A
 * real app keeps this in its database.
 */
export interface OrderRecord {
  orderId: string;
  /** Minor units, exactly as sent to `sessions.create()`. */
  amount: number;
  currency: string;
  /** When the checkout session stops working (the API's `expiresAt`). Absent or unreadable: the order is never freed. */
  expiresAt?: string;
  /** The return page read this session as paid, so the order is never freed, even if its webhook is missing. */
  seenPaid?: boolean;
  /**
   * Set by the webhook. "needs_review": a payment arrived for a different
   * amount or currency, so a person checks it before anything ships.
   */
  status: "pending" | "paid" | "failed" | "needs_review";
}

/**
 * The cookie that ties a return to the browser that started the checkout. It
 * holds a random reference that only this server maps to the session, not the
 * session id itself: the session id is in the return URL for anyone to read.
 */
export const CHECKOUT_COOKIE = "vonpay_checkout_ref";

/**
 * ⚠ In memory, so a flood of checkouts grows these maps. At the cap this server
 * first frees old UNPAID orders, then refuses new checkouts rather than forget
 * an order someone may be paying. The cap protects this process's memory; it is
 * not a rate limit. A real app keeps orders in its database.
 */
export const MAX_STORED_CHECKOUTS = 10_000;

/**
 * How long after its session expired an unpaid order is kept. A payment can
 * still complete after the session's time limit: the API keeps a payment that
 * is waiting on the bank open for up to 24 hours past it, and not every late
 * payment is refunded automatically. Its webhook is then retried for about 79
 * hours. So about 103 hours, rounded up to five days.
 */
export const FREE_AFTER_EXPIRY_MS = 5 * 24 * 60 * 60 * 1000;

const store = globalThis as typeof globalThis & {
  __vonpaySampleOrders?: Map<string, OrderRecord>;
  __vonpaySampleCheckoutRefs?: Map<string, string>;
  __vonpaySampleHandledEvents?: Set<string>;
};
const ordersBySession = (store.__vonpaySampleOrders ??= new Map<string, OrderRecord>());
const sessionByCheckoutRef = (store.__vonpaySampleCheckoutRefs ??= new Map<string, string>());
// Webhook event ids (`vp_evt_*`) processed to completion. A real app keeps
// these in a table with a UNIQUE event id. This Set keeps the newest
// HANDLED_EVENT_CAP ids, so a flood of signed deliveries cannot grow it
// without limit.
export const HANDLED_EVENT_CAP = 10_000;
const handledEventIds = (store.__vonpaySampleHandledEvents ??= new Set<string>());

/**
 * Make room by forgetting orders nobody can pay any more: unpaid ("pending" or
 * "failed"), with a session that expired more than FREE_AFTER_EXPIRY_MS ago.
 * ⛔ A paid or needs_review order is never freed, whatever its age, nor one the
 * return page saw paid.
 */
export function freeExpiredOrders(now = Date.now()): void {
  const freed = new Set<string>();
  for (const [sessionId, order] of ordersBySession) {
    if ((order.status !== "pending" && order.status !== "failed") || order.seenPaid === true) continue;
    // An unreadable time is NaN, and no comparison with NaN is true: kept.
    if (!(Date.parse(order.expiresAt ?? "") + FREE_AFTER_EXPIRY_MS < now)) continue;
    ordersBySession.delete(sessionId);
    freed.add(sessionId);
  }
  if (freed.size === 0) return;
  for (const [ref, sessionId] of sessionByCheckoutRef) if (freed.has(sessionId)) sessionByCheckoutRef.delete(ref);
}

/** Room for one more order. Looks for orders to free only when the store is full. */
let lastLook = 0;
export function hasRoomForCheckout(): boolean {
  // At most one look a second: while the store is full of recent orders, a look frees nothing.
  if (ordersBySession.size >= MAX_STORED_CHECKOUTS && Date.now() - lastLook >= 1_000) {
    lastLook = Date.now();
    freeExpiredOrders();
  }
  return ordersBySession.size < MAX_STORED_CHECKOUTS;
}

/** Save the order and return the random reference to put in the browser's cookie. */
export function saveOrder(sessionId: string, order: OrderRecord): string {
  ordersBySession.set(sessionId, order);
  const checkoutRef = crypto.randomUUID();
  sessionByCheckoutRef.set(checkoutRef, sessionId);
  return checkoutRef;
}

/** The session a browser's cookie reference names, or undefined if this server did not issue it. */
export function sessionForCheckoutRef(checkoutRef: string): string | undefined {
  return sessionByCheckoutRef.get(checkoutRef);
}

export function getOrderBySession(sessionId: string): OrderRecord | undefined {
  return ordersBySession.get(sessionId);
}

/** Peek: has this webhook event already been processed? Does not record. */
export function eventAlreadyHandled(eventId: string): boolean {
  return handledEventIds.has(eventId);
}

/** Record a webhook event as processed. Call only AFTER the handler succeeded. */
export function markEventHandled(eventId: string): void {
  if (handledEventIds.has(eventId)) return;
  if (handledEventIds.size >= HANDLED_EVENT_CAP) {
    // Forget the oldest id (a Set iterates in insertion order). ⚠️ A forgotten
    // id reads as new again if it is ever redelivered: one more reason to keep
    // these in a database table in production.
    const oldest = handledEventIds.values().next().value;
    if (oldest !== undefined) handledEventIds.delete(oldest);
  }
  handledEventIds.add(eventId);
}
