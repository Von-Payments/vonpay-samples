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
 * ⚠ In memory, so a flood of checkouts grows these maps without limit. At the
 * cap this server refuses new checkouts rather than forget an order someone
 * may be paying. A real app keeps orders in its database.
 */
export const MAX_OPEN_CHECKOUTS = 10_000;

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

export function hasRoomForCheckout(): boolean {
  return ordersBySession.size < MAX_OPEN_CHECKOUTS;
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
