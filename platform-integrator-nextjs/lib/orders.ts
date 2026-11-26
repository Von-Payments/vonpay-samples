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
  /** When the checkout session stops working (the API's `expiresAt`). Absent or unreadable: the order is never freed. */
  expiresAt?: string;
  /** Absent: unpaid. Set by the webhook only: it decides whether an order is paid. */
  status?: "paid" | "failed" | "needs_review";
  /** The confirm page read this session as paid, so the order is never freed, even if its webhook is missing. */
  seenPaid?: boolean;
}

const holder = globalThis as typeof globalThis & {
  __vonpaySamplePlatformTenantOrders?: Map<string, Map<string, OrderRecord>>;
};
// Tenant → session id → order. One map per tenant, so one tenant's flood fills
// only that tenant's share.
const ordersByTenant = (holder.__vonpaySamplePlatformTenantOrders ??= new Map<string, Map<string, OrderRecord>>());

/**
 * ⚠ In memory, so a flood of charges grows a tenant's map. At the cap the
 * charge route first frees that tenant's old UNPAID orders, then refuses its
 * new checkouts rather than forget an order someone may be paying. Another
 * tenant is not affected. The cap protects this process's memory; it is not a
 * rate limit. A real platform keeps orders in its database.
 */
export const MAX_STORED_ORDERS_PER_TENANT = 10_000;

/**
 * How long after its session expired an unpaid order is kept. A payment can
 * still complete after the session's time limit: the API keeps a payment that
 * is waiting on the bank open for up to 24 hours past it, and not every late
 * payment is refunded automatically. Its webhook is then retried for about 79
 * hours. So about 103 hours, rounded up to five days.
 */
export const FREE_AFTER_EXPIRY_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * Forget this tenant's orders nobody can pay any more: unpaid or failed, with a
 * session that expired more than FREE_AFTER_EXPIRY_MS ago. ⛔ A paid or
 * needs_review order is never freed, whatever its age, nor one the confirm page
 * saw paid.
 */
export function freeExpiredOrders(tenantId: string, now = Date.now()): void {
  const orders = ordersByTenant.get(tenantId);
  if (orders === undefined) return;
  for (const [sessionId, order] of orders) {
    // Only a known unpaid state is freed: a state added later is kept by default.
    if ((order.status !== undefined && order.status !== "failed") || order.seenPaid === true) continue;
    // An unreadable time is NaN, and no comparison with NaN is true: kept.
    if (Date.parse(order.expiresAt ?? "") + FREE_AFTER_EXPIRY_MS < now) orders.delete(sessionId);
  }
}

/** Room for one more order of this tenant. Looks for orders to free only when its share is full. */
const lastLook = new Map<string, number>();
export function hasRoomForOrder(tenantId: string): boolean {
  // At most one look a second: while the store is full of recent orders, a look frees nothing.
  if (
    (ordersByTenant.get(tenantId)?.size ?? 0) >= MAX_STORED_ORDERS_PER_TENANT &&
    Date.now() - (lastLook.get(tenantId) ?? 0) >= 1_000
  ) {
    lastLook.set(tenantId, Date.now());
    freeExpiredOrders(tenantId);
  }
  return (ordersByTenant.get(tenantId)?.size ?? 0) < MAX_STORED_ORDERS_PER_TENANT;
}

export function saveOrder(sessionId: string, order: OrderRecord): void {
  let orders = ordersByTenant.get(order.tenantId);
  if (orders === undefined) ordersByTenant.set(order.tenantId, (orders = new Map()));
  orders.set(sessionId, order);
}

export function getOrderBySession(sessionId: string): OrderRecord | undefined {
  for (const orders of ordersByTenant.values()) {
    const order = orders.get(sessionId);
    if (order !== undefined) return order;
  }
  return undefined;
}

/** This tenant's order with this order id, if it is stored. */
export function getOrderById(tenantId: string, orderId: string): OrderRecord | undefined {
  for (const order of ordersByTenant.get(tenantId)?.values() ?? []) {
    if (order.orderId === orderId) return order;
  }
  return undefined;
}
