import { randomUUID } from "node:crypto";
import express from "express";
import { VonPayCheckout, minorUnitDigits } from "@vonpay/checkout-node";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Format an amount in MINOR units (what the API sends) for display.
 * Not every currency has 2 decimals (JPY has 0, KWD has 3), so dividing by 100
 * shows the wrong figure for those. The decimals come from the SDK's
 * `minorUnitDigits` — the API's own table, the same decimals the API charged
 * with. (Intl's data can disagree with the API, e.g. for ISK, so only the
 * symbol comes from Intl.)
 */
function formatMinorAmount(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const digits = minorUnitDigits(code);
  if (digits === undefined) {
    // Malformed or unrecognised currency code. Show the raw minor units rather than guess.
    return `${amount} ${code} (minor units)`;
  }
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: code,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount / 10 ** digits);
}

const app = express();
const port = parseInt(process.env.PORT ?? "3000", 10);

const apiKey = process.env.VON_PAY_SECRET_KEY!;
// Per-endpoint webhook signing secret (whsec_…), shown once when you create
// the webhook endpoint. This is NOT your API key — verifying with the API key
// will fail against real production deliveries.
//
// Refuse to start when it is missing or still the .env.example placeholder:
// verifying against an empty or published value would accept a forged
// delivery.
const webhookSecret = process.env.VON_PAY_WEBHOOK_SECRET?.trim() ?? "";
if (!webhookSecret || webhookSecret === "whsec_your_endpoint_signing_secret") {
  console.error(
    "VON_PAY_WEBHOOK_SECRET is required (whsec_…). Copy .env.example to .env and set it to your endpoint's signing secret.",
  );
  process.exit(1);
}
// The SDK targets production by default; a `vp_sk_test_*` key runs in sandbox
// mode there (no separate host). Override VON_PAY_BASE_URL only if support
// directs you elsewhere.
const baseUrl =
  process.env.VON_PAY_BASE_URL?.replace(/\/+$/, "") ??
  "https://checkout.vonpay.com";
// Shorter than the SDK's defaults (30 s a try, 2 retries): this client only
// creates and reads sessions, and a buyer is waiting on each call. ⛔ Do not
// shorten a client that captures or voids: a timeout there leaves a result
// nobody knows.
const vonpay = new VonPayCheckout({ apiKey, baseUrl, timeout: 10_000, maxRetries: 1 });

// Capture the RAW body for the webhook route (a Buffer, byte-faithful) — the
// HMAC must be computed over the exact bytes Von Payments signed, so this must
// run BEFORE express.json(). express.json() elsewhere is fine for normal routes.
app.post("/webhooks", express.raw({ type: "application/json" }));
app.use(express.json());

// This app's own public address (set BASE_URL when deployed, e.g.
// https://shop.example.com). The return URL and the cookie below are built
// from it; on https the cookie is marked Secure.
const appUrl = (process.env.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");

// ── Your order records ───────────────────────────────────────────────
// The order each checkout session was created for, keyed by session id.
// In memory for the sample; a real app keeps this in its database (and the
// webhook handler marks the same row paid).
interface OrderRecord {
  orderId: string;
  amount: number; // minor units, exactly as sent to sessions.create()
  currency: string;
  /** When the checkout session stops working (ms). `undefined`: unknown, so the order is never freed. */
  expiresAt?: number;
  /** The cookie reference that names this order, freed together with it. */
  checkoutRef?: string;
  /** The return page read this session as paid, so the order is never freed, even if its webhook is missing. */
  seenPaid?: boolean;
  /**
   * Set by the webhook. "needs_review": a payment arrived for a different
   * amount or currency, so a person checks it before anything ships.
   */
  status: "pending" | "paid" | "failed" | "needs_review";
}
const ordersBySession = new Map<string, OrderRecord>();

// The cookie that ties a return to the browser that started the checkout. It
// holds a random reference that only this server can map to the session, not
// the session id itself: the session id is in the return URL and the checkout
// page, and a cookie value anyone can read off a URL proves nothing about the
// browser.
const CHECKOUT_COOKIE = "vonpay_checkout_ref";
const sessionByCheckoutRef = new Map<string, string>();

// ⚠ In memory, so a flood of POST /checkout grows these maps. At the cap this
// server first frees old UNPAID orders, then refuses new checkouts (503) rather
// than forget an order someone may be paying. The cap protects this process's
// memory; it is not a rate limit. A real app keeps orders in its database.
const MAX_STORED_CHECKOUTS = 10_000;

// How long after its session expired an unpaid order is kept. A payment can
// still complete after the session's time limit: the API keeps a payment that
// is waiting on the bank open for up to 24 hours past it, and not every late
// payment is refunded automatically. Its webhook is then retried for about 79
// hours. So about 103 hours, rounded up to five days.
const FREE_AFTER_EXPIRY_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * Make room by forgetting orders nobody can pay any more: unpaid ("pending" or
 * "failed"), with a session that expired more than FREE_AFTER_EXPIRY_MS ago.
 * ⛔ A paid or needs_review order is never freed, whatever its age, nor one
 * the return page saw paid.
 */
function freeExpiredOrders(now = Date.now()): void {
  for (const [sessionId, order] of ordersBySession) {
    if ((order.status !== "pending" && order.status !== "failed") || order.seenPaid === true) continue;
    if (order.expiresAt === undefined || !(order.expiresAt + FREE_AFTER_EXPIRY_MS < now)) continue;
    ordersBySession.delete(sessionId);
    if (order.checkoutRef !== undefined) sessionByCheckoutRef.delete(order.checkoutRef);
  }
}

/** Room for one more order. Looks for orders to free only when the store is full. */
let lastLook = 0;
function hasRoomForCheckout(): boolean {
  // At most one look a second: while the store is full of recent orders, a look frees nothing.
  if (ordersBySession.size >= MAX_STORED_CHECKOUTS && Date.now() - lastLook >= 1_000) {
    lastLook = Date.now();
    freeExpiredOrders();
  }
  return ordersBySession.size < MAX_STORED_CHECKOUTS;
}

// Webhook event ids (`vp_evt_*`) already processed to completion. Recorded
// only AFTER the handler succeeded, so a failed attempt is retried, not
// dropped. A real app keeps these in a table with a UNIQUE event id. This Set
// keeps the newest HANDLED_EVENT_CAP ids, so a flood of signed deliveries
// cannot grow it without limit.
const handledEventIds = new Set<string>();
const HANDLED_EVENT_CAP = 10_000;

function markEventHandled(eventId: string): void {
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

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

// ── Create checkout session ──────────────────────────────────────────
// ⚠ Before deploying, rate-limit this route (per IP and per buyer) and put
// bot protection in front of it. Every call creates a checkout session on
// your key, and an open route like this is what card testers look for. This
// sample has neither.
app.post("/checkout", async (_req, res) => {
  if (!hasRoomForCheckout()) {
    res.status(503).json({ error: "Too many checkouts. Please try again later." });
    return;
  }
  // Stand-in for YOUR order id — in a real app, create the order first and use its id.
  const orderId = `order_${randomUUID()}`;
  const amount = 2500;
  const currency = "USD";
  try {
    const session = await vonpay.sessions.create(
      {
        amount,
        currency,
        successUrl: `${appUrl}/success`,
        cancelUrl: `${appUrl}/`,
        lineItems: [{ name: "Sample Item", quantity: 1, unitAmount: amount }],
        metadata: { order_id: orderId },
      },
      // Key on YOUR order id. Here orderId is made per request, so this only dedupes the SDK's own retry of this call; to dedupe a double-click or refresh, create the order first and reuse its id.
      { idempotencyKey: `session:${orderId}` },
    );
    // Remember which order this session pays for, on YOUR server. The return
    // page looks the order up from this record, never from the URL.
    const checkoutRef = randomUUID();
    const expiresAt = Date.parse(session.expiresAt);
    ordersBySession.set(session.id, {
      orderId,
      amount,
      currency,
      status: "pending",
      checkoutRef,
      // An unreadable time is "unknown": that order is never freed.
      ...(Number.isNaN(expiresAt) ? {} : { expiresAt }),
    });
    // And tie the return to this browser, by a random reference mapped to the
    // session on this server. HttpOnly: page scripts cannot read it.
    // SameSite=Lax: it still comes back on the redirect from checkout.
    sessionByCheckoutRef.set(checkoutRef, session.id);
    res.cookie(CHECKOUT_COOKIE, checkoutRef, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: appUrl.startsWith("https://"),
    });
    res.redirect(303, session.checkoutUrl);
  } catch (err) {
    // Log only the message: the full error object can carry request details
    // you do not want in your logs.
    console.error("Checkout error:", err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ── Webhook handler ──────────────────────────────────────────────────
app.post("/webhooks", (req, res) => {
  // The signed timestamp lives INSIDE the x-vonpay-signature header
  // (t=<unix>,v1=<hex>) — there is no separate timestamp header.
  const signature = req.headers["x-vonpay-signature"] as string;
  // Raw bytes from express.raw() — constructEvent accepts string | Buffer.
  const body = req.body as Buffer;

  let event;
  try {
    event = vonpay.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    // Log only err.message — passing the full err object to a structured
    // logger may serialize signature / HMAC bytes from the
    // VonPayError's diagnostic fields. We never want those in stdout.
    console.error("Webhook verification failed:", err instanceof Error ? err.message : String(err));
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  // A "Send test event" delivery is signed and can carry a real order's ids: acknowledge it and do nothing else.
  if (event.test_event === true) {
    res.json({ received: true });
    return;
  }

  // Dedupe on `event.id` (`vp_evt_*`), unique per outbound event. A
  // redelivery (after a timeout or a 5xx, or a manual resend) carries the same
  // id: acknowledge it with 200 and do nothing else.
  if (handledEventIds.has(event.id)) {
    res.json({ received: true, deduped: true });
    return;
  }

  // Branch on event type. `charge.succeeded` is the event that means the buyer
  // actually paid; do NOT fulfill orders on `charge.failed`. Session IDs
  // are deep-link tokens — keep them out of general application logs and only
  // surface in systems with the same trust boundary as the API key itself.
  //
  // ⚠️ Do NOT subscribe to `session.succeeded`. The server emits it internally,
  // but it is absent from the merchant subscription catalog — which accepts an
  // unknown event key, stores nothing and returns success. An endpoint
  // subscribed to it receives nothing, forever, and no error is raised at any
  // layer. `charge.*` is the subscribable family.
  try {
    switch (event.type) {
      case "charge.succeeded": {
        // Find YOUR order for this session. No order: not a checkout this
        // server started, or one it no longer holds (it restarted, or freed
        // the order long after its session expired). Acknowledge: a retry
        // cannot make the order appear. ⚠ The buyer may have paid, so a person
        // checks it: `sessions.get(session_id)` returns the metadata you set
        // (`order_id`), then they fulfil or refund it.
        const order = event.data.session_id ? ordersBySession.get(event.data.session_id) : undefined;
        if (!order) {
          console.warn(`Webhook ${event.type} ${event.id}: no order for this session; nothing fulfilled. Check this payment by hand.`);
          break;
        }
        // ⛔ A LATE payment that Von Payments already refunded in full: it
        // arrived after this checkout was closed as not paid, and the buyer
        // got the money back. Never fulfil on it, and leave the order as it
        // is: a payment the buyer made another way is a different event.
        if (event.data.late_payment_auto_refunded === true) {
          console.warn(`Order ${order.orderId}: a late payment was refunded automatically. Not fulfilled; order unchanged.`);
          break;
        }
        // ⛔ Check what was paid against the order before fulfilling. A
        // payment for another amount or currency is not this order as priced:
        // hold it for a person. A field the event leaves out is not a mismatch.
        const { amount, currency } = event.data;
        const amountDiffers = typeof amount === "number" && amount !== order.amount;
        const currencyDiffers = typeof currency === "string" && currency.toUpperCase() !== order.currency;
        if (amountDiffers || currencyDiffers) {
          order.status = "needs_review";
          console.error(`Order ${order.orderId}: paid ${amount} ${currency}, expected ${order.amount} ${order.currency}. Not fulfilled.`);
          break;
        }
        // Only from pending or failed: an order held for a person stays held.
        if (order.status === "pending" || order.status === "failed") {
          order.status = "paid";
          // Replace this with your order-fulfillment logic (mark the order row
          // paid, ship, send the receipt). Pass `event.data.transaction_id` to
          // your fulfillment system but avoid logging it verbatim.
          console.log(`Order ${order.orderId} paid.`);
        }
        break;
      }
      case "charge.failed": {
        // Payment did not complete — do not fulfill.
        // `event.data.failure_reason` is the buyer-safe explanation.
        // ⛔ A failure never undoes a payment: events arrive out of order, and
        // a declined first attempt can land after the payment that went through.
        const order = event.data.session_id ? ordersBySession.get(event.data.session_id) : undefined;
        if (order?.status === "pending") order.status = "failed";
        break;
      }
      default:
        // Unknown event type — accept the webhook (ack 200) but take no action.
        break;
    }
  } catch (err) {
    // OUR handler failed (a database write, say). 500 so the sender retries;
    // the event is not recorded, so the retry runs the handler again.
    console.error("Webhook handler failed:", err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: "Handler failed" });
    return;
  }

  // Record the event only now, after it was processed without throwing.
  markEventHandled(event.id);
  res.json({ received: true });
});

// ── Success return page ──────────────────────────────────────────────
// Shown when a return cannot be matched to an order this server created for
// this browser. Neutral on purpose: it is NOT "payment failed" (the buyer may
// well have paid; the webhook settles that) and it offers no "pay again".
const NOT_MATCHED_PAGE =
  "<h1>We couldn't match this payment to an order started in this browser</h1>" +
  "<p>If you paid, your order is safe and you will get a confirmation. " +
  "You do not need to pay again.</p>";

app.get("/success", async (req, res) => {
  const params = req.query as Record<string, string>;
  // This URL carries the session id and the signed return query. Send no
  // Referer from this page, so a link or an asset on it cannot pass them on.
  res.set("Referrer-Policy", "no-referrer");

  // ⚠️ Match the return to an order YOUR server created, before anything else.
  // `confirmReturn` answers "did this session succeed?" for ANY session on
  // your account. Without this check, a success URL copied from another paid
  // order of your shop (a cheap one, say) would show "Payment successful" for
  // this one. So start from the session this browser started (the cookie set
  // at /checkout) and its order record on your server, and hand both to
  // `confirmReturn` below: `expectedSessionId` refuses a return that names any
  // other session, and `expectedAmount` + `expectedCurrency` refuse a session
  // paid for a different figure.
  const checkoutRef = readCookie(req.headers.cookie, CHECKOUT_COOKIE);
  const sessionId = (checkoutRef && sessionByCheckoutRef.get(checkoutRef)) ?? "";
  const order = sessionId ? ordersBySession.get(sessionId) : undefined;
  if (!order) {
    res.status(400).send(NOT_MATCHED_PAGE);
    return;
  }

  // `confirmReturn` verifies the signature AND confirms server-side that the
  // payment actually succeeded.
  //
  // ⚠️ Do NOT use `verifyReturnSignature` here and treat its `true` as proof of
  // payment. It proves the message is AUTHENTIC — a DECLINED payment is signed
  // just as authentically as an approved one. This page used to render
  // "Payment successful" on signature validity alone, which meant deliberately
  // paying with a card you knew would decline produced a valid "success" page.
  //
  // The webhook handler above already had this guard; the return handler did
  // not. Note that it is the WEBHOOK that should trigger fulfilment — buyers
  // close laptops and never load this page.
  let outcome;
  try {
    // ⚠️ NO `secret` ARGUMENT, DELIBERATELY. Returns are signed with a
    // PLATFORM-WIDE secret that no merchant holds — holding it would let any
    // merchant forge any other merchant's confirmations. Passing a per-merchant
    // `ss_*` here buys a check that can only ever FAIL, and gating the page on
    // that failure renders "invalid signature" to a buyer who just paid.
    // `signatureValid` is `null` here (not checked); the authenticated session
    // read is what answers "did this buyer pay".
    outcome = await vonpay.sessions.confirmReturn(params, undefined, {
      expectedSuccessUrl: `${appUrl}/success`,
      expectedKeyMode: apiKey.includes("_test_") ? "test" : "live",
      expectedSessionId: sessionId,
      expectedAmount: order.amount,
      expectedCurrency: order.currency,
    });
  } catch (err) {
    // The lookup failed — we could not check. That is NOT "they did not pay",
    // so do not tell the buyer their payment failed.
    //
    // Log it. A revoked key or a rate-limit block would otherwise show every
    // buyer "please refresh in a moment" forever with nothing in your logs —
    // a permanent failure wearing the costume of a temporary one.
    console.error(
      "Return confirmation failed:",
      err instanceof Error ? err.message : String(err),
    );
    res
      .status(503)
      .send("<h1>We could not confirm your payment just now</h1>" +
            "<p>No action needed — if you were charged, your order is safe. " +
            "Please refresh in a moment.</p>");
    return;
  }

  if (outcome.paid) order.seenPaid = true;

  // Not this order's payment: the return names another session (or none), or
  // the session was for a different amount or currency. Checked before the
  // status, so a paid session for another figure never reads as paid here.
  if (
    outcome.reason === "missing_session" ||
    outcome.reason === "session_mismatch" ||
    outcome.reason === "amount_mismatch"
  ) {
    if (outcome.reason === "amount_mismatch") {
      console.error(
        `Return for order ${order.orderId}: the session's amount does not match the order; not shown as paid.`,
      );
    }
    res.status(400).send(NOT_MATCHED_PAGE);
    return;
  }

  // ⚠️ IN FLIGHT is not DECLINED. On the 3-D Secure path the buyer is returned
  // here BEFORE the charge settles, so this is the ordinary case there — not an
  // edge case. Telling this buyer their payment failed is how they end up
  // paying twice. Never a 402, never a retry affordance; the webhook settles it.
  if (outcome.reason === "still_pending") {
    res
      .status(200)
      .send("<h1>Confirming your payment…</h1>" +
            "<p>Your bank is still finishing this off. You do not need to pay " +
            "again — we'll email you as soon as it completes.</p>");
    return;
  }

  // ⚠️ RETURNED is not DECLINED. The buyer paid and the money went back, so this
  // is neither a failure nor a reason to offer "pay again". Do not fulfil.
  if (outcome.reason === "refunded") {
    res
      .status(200)
      .send("<h1>This payment was returned</h1>" +
            "<p>The payment for this order went back to the buyer. There is nothing " +
            "to pay. Contact us if this looks wrong.</p>");
    return;
  }

  if (!outcome.paid) {
    res
      .status(402)
      .send(`<h1>Payment not completed</h1><p>Status: ${esc(outcome.status ?? "unknown")}</p>`);
    return;
  }

  // ⚠️ Render the SERVER's amount, never `amount` from the redirect query
  // string. The query string is buyer-controlled and unauthenticated: anyone
  // can complete a real 1-unit payment and then edit the URL to show a
  // confirmation for any figure they like. `outcome.amount` came back from the
  // authenticated session read, and `confirmReturn` already checked it equals
  // your order's amount (`expectedAmount`). A paid outcome always carries it.
  const displayAmount =
    outcome.amount === undefined ? "N/A" : formatMinorAmount(outcome.amount, order.currency);

  // ⚠️ Displaying a confirmation is safe to repeat. FULFILLING is not — this
  // URL can be replayed, and the status keeps reading "succeeded" every time.
  // Before shipping goods, record which session IDs you have already fulfilled
  // and refuse to fulfil one twice. Fulfil from the webhook, not from here.
  // ⚠️ `needsReview` is still a payment, but hold the fulfilment and look first.
  // `second_payment`: two payments on this session, so check both before you ship
  // or refund. `refund_state_unknown`: the refund totals were not sent, which is
  // normal for a few moments after a payment and while a hold is open.
  if (outcome.needsReview) {
    console.warn(`Return for order ${order.orderId} needs review: ${outcome.reviewReason}`);
  }
  const heading = outcome.needsReview ? "Payment received" : "Payment successful";
  const reviewNote = outcome.needsReview
    ? "<p>We are checking this order and will email you. You do not need to pay again.</p>"
    : "";
  res.send(`
    <h1>${heading}</h1>${reviewNote}
    <p>Order: ${esc(order.orderId)}</p>
    <p>Session: ${esc(sessionId)}</p>
    <p>Status: ${esc(outcome.status ?? "")}</p>
    <p>Amount: ${esc(displayAmount)}</p>
    <p>Transaction: ${esc(outcome.transactionId ?? "N/A")}</p>
  `);
});

// ── Health check ─────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    const health = await vonpay.health();
    res.json(health);
  } catch (err) {
    console.error("Health check failed:", err instanceof Error ? err.message : String(err));
    res.status(503).json({ status: "unreachable" });
  }
});

app.get("/", (_req, res) => {
  res.send(`
    <h1>VonPay Checkout - Express Sample</h1>
    <form action="/checkout" method="POST">
      <button type="submit">Pay $25.00</button>
    </form>
  `);
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port} (public address ${appUrl})`);
});
