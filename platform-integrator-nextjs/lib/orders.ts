/**
 * Your order records: which tenant and order each checkout session was created
 * for, keyed by session id. The confirm page looks the order up HERE, never
 * from the URL.
 *
 * In memory for the sample, held on `globalThis` so the charge route and the
 * confirm page (which Next.js may load as separate modules) share one map. A
 * real platform keeps this in its order table, scoped to the tenant.
 */
export interface OrderRecord {
  tenantId: string;
  orderId: string;
  customerId: string;
  /** Minor units, exactly as sent to `sessions.create()`. */
  amount: number;
  currency: string;
}

const holder = globalThis as typeof globalThis & {
  __vonpaySamplePlatformOrders?: Map<string, OrderRecord>;
};
const ordersBySession = (holder.__vonpaySamplePlatformOrders ??= new Map<string, OrderRecord>());

/**
 * ⚠ In memory, so a flood of charges grows this map without limit. At the cap
 * the charge route refuses new checkouts rather than forget an order someone
 * may be paying. A real platform keeps orders in its database.
 */
export const MAX_OPEN_ORDERS = 10_000;

export function hasRoomForOrder(): boolean {
  return ordersBySession.size < MAX_OPEN_ORDERS;
}

export function saveOrder(sessionId: string, order: OrderRecord): void {
  ordersBySession.set(sessionId, order);
}

export function getOrderBySession(sessionId: string): OrderRecord | undefined {
  return ordersBySession.get(sessionId);
}
