/**
 * Your order records: the order each checkout session was created for, keyed
 * by session id. The return page looks the order up HERE, never from the URL.
 *
 * In memory for the sample, held on `globalThis` so the API route and the
 * confirm page (which Next.js may load as separate modules) share one map. A
 * real app keeps this in its database, and its webhook handler marks the same
 * row paid.
 */
export interface OrderRecord {
  orderId: string;
  /** Minor units, exactly as sent to `sessions.create()`. */
  amount: number;
  currency: string;
}

/** The cookie that ties a return to the browser that started the checkout. */
export const CHECKOUT_COOKIE = "vonpay_checkout_session";

const store = globalThis as typeof globalThis & {
  __vonpaySampleOrders?: Map<string, OrderRecord>;
};
const ordersBySession = (store.__vonpaySampleOrders ??= new Map<string, OrderRecord>());

export function saveOrder(sessionId: string, order: OrderRecord): void {
  ordersBySession.set(sessionId, order);
}

export function getOrderBySession(sessionId: string): OrderRecord | undefined {
  return ordersBySession.get(sessionId);
}
