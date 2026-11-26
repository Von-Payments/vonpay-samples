/**
 * - `paid`: one payment went through. A partial refund keeps this status and
 *   records `refundedAmount`.
 * - `refunded`: that one payment has been refunded in full.
 * - `needs_review`: the events do not add up to one payment, so a person must
 *   look before you fulfil or refund (see `otherPayments` and `reviewNote`).
 */
export type LinkStatus = "pending" | "paid" | "failed" | "refunded" | "needs_review";

/** A payment on this link other than the one in `PayLink.transactionId`. */
export interface OtherPayment {
  transactionId: string;
  /** Refunded so far on this payment, in minor units. */
  refundedAmount: number;
}

/** What `charge.refunded` says about one refund. Amounts are in minor units. */
export interface RefundReport {
  transactionId?: string;
  /** Total refunded on the payment, including this refund. Null means unknown, not zero. */
  refundedTotal: number | null;
  /** What this refund moved. Null means unknown, not zero. */
  refundAmount: number | null;
  /** The payment's full amount before any refund. */
  originalAmount: number | null;
}

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
  /** The confirm page read this link's session as paid, so it is never freed, even if its webhook is missing. */
  seenPaid?: boolean;
  /** The payment that paid this link. */
  transactionId?: string;
  /** Refunded so far on `transactionId`, in minor units. */
  refundedAmount?: number;
  /** Every other payment seen for this link. Any entry means `needs_review`. */
  otherPayments?: OtherPayment[];
  /** Why the link needs review, when `otherPayments` alone does not say. */
  reviewNote?: string;
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

/**
 * ⚠ In memory, so a flood of new links grows the store. At the cap
 * `POST /api/links` first frees old UNPAID links, then refuses a new link (503)
 * rather than forget one a buyer may be paying. The cap protects this process's
 * memory; it is not a rate limit. A real app keeps links in its database.
 */
export const MAX_LINKS = 10_000;

/**
 * How long after its session expired an unpaid link is kept. A payment can
 * still complete after the session's time limit: the API keeps a payment that
 * is waiting on the bank open for up to 24 hours past it, and not every late
 * payment is refunded automatically. Its webhook is then retried for about 79
 * hours. So about 103 hours, rounded up to five days.
 */
export const FREE_AFTER_EXPIRY_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * Forget links nobody can pay any more: pending or failed, with a session that
 * expired more than FREE_AFTER_EXPIRY_MS ago. ⛔ A paid, refunded or
 * needs_review link is never freed, whatever its age, nor one the confirm page
 * saw paid.
 */
export function freeExpiredLinks(now = Date.now()): void {
  for (const [id, link] of store) {
    if ((link.status !== "pending" && link.status !== "failed") || link.seenPaid === true) continue;
    // An unreadable time is NaN, and no comparison with NaN is true: kept.
    if (Date.parse(link.expiresAt) + FREE_AFTER_EXPIRY_MS < now) store.delete(id);
  }
}

/** Room for one more link. Looks for links to free only when the store is full. */
let lastLook = 0;
export function hasRoomForLink(): boolean {
  // At most one look a second: while the store is full of recent links, a look frees nothing.
  if (store.size >= MAX_LINKS && Date.now() - lastLook >= 1_000) {
    lastLook = Date.now();
    freeExpiredLinks();
  }
  return store.size < MAX_LINKS;
}

// Webhook event ids (`vp_evt_*`) already processed to completion. In
// production keep these in a table with a UNIQUE index on the event id: this
// Set forgets everything on restart and is not shared between instances. It
// keeps the newest HANDLED_EVENT_CAP ids, so a flood of signed deliveries
// cannot grow it without limit.
export const HANDLED_EVENT_CAP = 10_000;
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

function isKnownPayment(link: PayLink, transactionId: string | undefined): boolean {
  if (transactionId === undefined) return false;
  return (
    transactionId === link.transactionId ||
    (link.otherPayments ?? []).some((p) => p.transactionId === transactionId)
  );
}

/** A copy of the link, so a failed store write leaves the stored link as it was. */
function copyOf(link: PayLink): PayLink {
  return { ...link, otherPayments: link.otherPayments?.map((p) => ({ ...p })) };
}

/** Puts the link in review for a payment that is not the one it already holds. */
function addUnmatchedPayment(link: PayLink, transactionId: string | undefined, noIdNote: string): void {
  link.status = "needs_review";
  if (transactionId) {
    link.otherPayments = [...(link.otherPayments ?? []), { transactionId, refundedAmount: 0 }];
  } else {
    link.reviewNote = noIdNote;
  }
}

/** True when a reported payment matches the link's own amount and currency. */
function paidAsPriced(link: PayLink, paid: { amount: number | null; currency: string | null }): boolean {
  // `typeof`, not `!== null`: an event from an older server can leave a field out.
  if (typeof paid.amount === "number" && paid.amount !== link.amount) return false;
  if (typeof paid.currency === "string" && paid.currency.toUpperCase() !== link.currency.toUpperCase()) return false;
  return true;
}

/**
 * Set a link's status from `charge.succeeded` or `charge.failed`.
 *
 * ⛔ A payment that went through is never undone by a failure. Webhooks can
 * arrive late and out of order, and one link can see a failed attempt (a
 * declined card) as well as the payment that went through. A `charge.failed`
 * that lands after `charge.succeeded` must not turn a paid link back into a
 * failed one, or the merchant chases a buyer who has already paid.
 *
 * ⛔ A second success is not always a repeat. The same transaction id is the
 * same payment reported again: nothing changes. A different id is a SECOND
 * payment by this buyer (a payment form left open in another tab, say): the
 * link goes to `needs_review` with both ids kept. An event with no id cannot
 * be shown to be the same payment, so it goes to review too.
 */
export function updateStatus(
  sessionId: string,
  status: "paid" | "failed",
  transactionId?: string,
  paid?: { amount: number | null; currency: string | null },
): PayLink | undefined {
  const link = getLinkBySessionId(sessionId);
  if (!link) return undefined;

  // ⛔ A success for a different amount or currency than the link asked for is
  // not this link's payment as priced: a person checks it before anything
  // ships. An amount or currency the event did not report is not a mismatch.
  if (status === "paid" && paid !== undefined && !paidAsPriced(link, paid)) {
    const next = copyOf(link);
    next.status = "needs_review";
    next.reviewNote = `A payment of ${paid.amount} ${paid.currency} (minor units) was reported; the link asks for ${link.amount} ${link.currency}.`;
    if (transactionId && !isKnownPayment(next, transactionId)) {
      if (next.transactionId === undefined) next.transactionId = transactionId;
      else next.otherPayments = [...(next.otherPayments ?? []), { transactionId, refundedAmount: 0 }];
    }
    store.set(next.id, next);
    return next;
  }

  if (status === "failed") {
    if (link.status !== "pending") return link;
    const next = copyOf(link);
    next.status = "failed";
    store.set(next.id, next);
    return next;
  }

  const unpaid = link.status === "pending" || link.status === "failed";
  if (!unpaid && isKnownPayment(link, transactionId)) return link;

  const next = copyOf(link);
  if (unpaid) {
    next.status = "paid";
    if (transactionId) next.transactionId = transactionId;
  } else {
    addUnmatchedPayment(next, transactionId, "A payment was reported with no transaction id.");
  }
  store.set(next.id, next);
  return next;
}

/**
 * Record a `charge.refunded` on the link.
 *
 * ⛔ A refund is matched to a payment, not to the link. Only a refund of the
 * payment that paid this link can make it `refunded`. A refund of any other
 * payment leaves that payment standing: an automatic refund of a second payment
 * looks like any other refund, and marking the link refunded would tell the
 * merchant that a paid order is not paid.
 *
 * Refunds and successes can arrive out of order. A refund of a payment not seen
 * yet on an unpaid link counts as that payment, so its late `charge.succeeded`
 * is a repeat. A late partial refund cannot lower the total already recorded.
 */
export function recordRefund(sessionId: string, refund: RefundReport): PayLink | undefined {
  const link = getLinkBySessionId(sessionId);
  if (!link) return undefined;
  const next = copyOf(link);
  const id = refund.transactionId;

  if (id && !next.transactionId && (next.status === "pending" || next.status === "failed")) {
    next.status = "paid";
    next.transactionId = id;
  }

  if (!isKnownPayment(next, id)) {
    addUnmatchedPayment(next, id, "A refund could not be matched to a payment.");
  }
  if (!id) {
    store.set(next.id, next);
    return next;
  }

  const other = next.otherPayments?.find((p) => p.transactionId === id);
  const refundedSoFar = (other ? other.refundedAmount : next.refundedAmount) ?? 0;
  const total =
    refund.refundedTotal !== null
      ? Math.max(refundedSoFar, refund.refundedTotal)
      : refund.refundAmount !== null
        ? refundedSoFar + refund.refundAmount
        : null;

  if (total === null) {
    // Neither amount is known. Do not guess: a person checks the payment.
    next.status = "needs_review";
    next.reviewNote = "A refund of an unknown amount was reported.";
  } else if (other) {
    other.refundedAmount = total;
  } else {
    next.refundedAmount = total;
    if (next.status === "paid" && total >= (refund.originalAmount ?? next.amount)) {
      next.status = "refunded";
    }
  }
  store.set(next.id, next);
  return next;
}
