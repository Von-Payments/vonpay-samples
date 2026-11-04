/**
 * Server-side 3D Secure (3DS / SCA) handling for the Payment Intents API.
 *
 * This is the SERVER-DRIVEN path. The buyer's bank decides whether to
 * challenge — you don't. When it does, the payment intent comes back with
 * `status: "requires_action"` and a `next_action` that points at the issuer's
 * challenge page. The only correct move is a TOP-LEVEL browser redirect to that
 * URL (banks block their challenge inside an iframe). After the challenge, the
 * terminal outcome is confirmed by a `payment_intent.succeeded` /
 * `payment_intent.failed` webhook — never by the buyer's browser.
 *
 * Flow demonstrated:
 *   POST /orders       Start an order (the page at / does this for you).
 *   POST /charge       Create a manual-capture intent against the saved card,
 *                      for that order. Branch on status:
 *                        requires_action → redirect the buyer to the 3DS URL
 *                        authorized      → no challenge; capture immediately
 *                        failed          → surface the decline
 *                      A second /charge on an order that holds or took money
 *                      answers 409.
 *   GET  /3ds/return   Where the issuer sends the buyer back. Reads the payment
 *                      from the API and captures it if the money is held. It
 *                      never fulfills: that waits for the webhook.
 *   POST /webhooks     Verify the signature, then act on payment_intent.* to
 *                      confirm the post-challenge terminal state and update
 *                      the order. payment_intent.authorized also captures a
 *                      payment that passed the bank's check.
 *
 * Written against @vonpay/checkout-node 4.x — 4.5.0 or later. 2.5.0 is the
 * first release that types `returnUrl` on `paymentIntents.create`, and 2.7.0
 * the first that types `test_event` on webhook events. Every field
 * this sample sends and reads is on the SDK's typed surface: no casts, no local
 * type bridges.
 */
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import {
  VonPayCheckout,
  VonPayError,
  type CreatePaymentIntentParams,
  type PaymentIntent,
  type WebhookEvent,
} from "@vonpay/checkout-node";

// ─── Config ─────────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT ?? "3000", 10);

const apiKey = process.env.VON_PAY_SECRET_KEY;
if (!apiKey) {
  console.error(
    "VON_PAY_SECRET_KEY is required. Copy .env.example to .env and paste your sandbox key.",
  );
  process.exit(2);
}

// Per-endpoint webhook signing secret (whsec_…), shown ONCE when you create the
// webhook endpoint in the dashboard. This is NOT your API key — verifying with
// the API key will fail against real deliveries.
// Refused when missing or still the .env.example placeholder: verifying against
// an empty or published value would accept a forged delivery.
const webhookSecret = process.env.VON_PAY_WEBHOOK_SECRET?.trim();
if (!webhookSecret || webhookSecret === "whsec_your_endpoint_signing_secret") {
  console.error(
    "VON_PAY_WEBHOOK_SECRET is required (whsec_…). Copy .env.example to .env and fill it in.",
  );
  process.exit(2);
}

const baseUrl =
  process.env.VON_PAY_BASE_URL?.replace(/\/+$/, "") ??
  "https://checkout.vonpay.com";

// Where the issuer's challenge page sends the buyer back. Must be a real,
// reachable URL on YOUR site. Forwarded to the API as `return_url`. Parsed here
// so a bad value stops the server at start, not at a buyer's charge.
const returnUrl = new URL(
  process.env.VON_PAY_RETURN_URL?.replace(/\/+$/, "") ??
    `http://localhost:${port}/3ds/return`,
);

// ⛔ Each order's return link carries that order's own id. The payment provider
// adds only its own `transaction_id` and `transaction_status` to this link, so
// without this the return page cannot tell which order came back. The name is
// unusual so it cannot replace a parameter your own return link already has.
const ORDER_PARAM = "vonpay_sample_order";
function returnUrlFor(orderId: string): string {
  const url = new URL(returnUrl);
  url.searchParams.set(ORDER_PARAM, orderId);
  return url.toString();
}

const vonpay = new VonPayCheckout({ apiKey, baseUrl });

// The saved card to charge (`vp_pmt_test_*` on a test key) and the buyer it
// was saved for. In a real app both come from YOUR records for the signed-in
// customer, never from the request.
const savedPaymentMethodId = process.env.VON_PAY_PAYMENT_METHOD?.trim() || undefined;
const savedCardBuyerId = process.env.VON_PAY_BUYER_ID?.trim() || undefined;

// ─── Reading the 3DS redirect off the intent ──────────────────────────────
//
// On `requires_action`, `intent.nextAction` is a `PaymentIntentNextAction`.
// The API wire shape is `{ type, redirect_to_url: { url } }`, but the SDK
// camelCases every response KEY (except `metadata`) — so read
// `nextAction.redirectToUrl.url`, NOT `redirect_to_url.url` (which is
// `undefined`). The `type` is a string VALUE, not a key, so it stays
// `"redirect_to_url"`. We branch on `type` so a future action type can't
// silently break the redirect.
//
// Redirect from THIS response. If it is ever lost (a timeout, a crash),
// `vonpay.paymentIntents.retrieve(id)` returns the same `nextAction` while the
// payment is still `requires_action`, with an `issuedAt` time — check that
// before sending a buyer, since an old challenge link may no longer work.
function extractRedirectUrl(intent: PaymentIntent): string | null {
  const action = intent.nextAction;
  if (action?.type !== "redirect_to_url") return null;
  const url = action.redirectToUrl?.url;
  // The URL comes from a trusted source (the API), but we still validate the
  // scheme before handing it to res.redirect — never redirect a browser to a
  // javascript:/data: URL even if a response were ever malformed.
  if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
  return null;
}

// ─── Express app ────────────────────────────────────────────────────────
// ⛔ Fixed demo amount. A real integration sources this from the cart —
// SERVER-SIDE.
//
// This was read off the request body with a bound:
//
//     typeof body.amount === "number" && Number.isInteger(body.amount) && body.amount > 0
//       ? body.amount : 4999
//
// ⚠ A BOUND IS NOT A PRICE CONTROL, and this one reads as though it were.
// Positive, integer, a number — every value that passes is still a number the
// BUYER chose, so `curl -d '{"amount":1}'` charges one cent for the $49.99 item.
// The check only narrows WHICH wrong price an attacker can pick.
//
// The only correct shape is that the browser cannot influence the amount at all.
// The three sibling samples in this repo already do it this way.
const AMOUNT_MINOR = 4999; // $49.99
const CURRENCY = "USD";

const app = express();

// Webhook signature verification is byte-for-byte over the RAW body, so mount
// express.raw() ON THE WEBHOOK ROUTE ONLY, above the generic JSON parser. Every
// other route still gets parsed JSON.
app.use("/webhooks", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Orders ─────────────────────────────────────────────────────────────
// Your order records, in memory for the sample (restarting forgets them, and
// nothing evicts old ones). A real app creates the order row in its database
// and uses that row's id.
//
// ⛔ The idempotency keys below are built from the STORED order's id, never
// from an id made up inside /charge. A double click or a retried POST of the
// same order then sends the SAME key, and the API returns the payment it
// already made instead of charging the card a second time. An id minted per
// request would give every retry a new key, which protects nothing.
interface Order {
  id: string;
  amount: number;
  currency: string;
  /** "open" until a charge comes back, then the payment's own status. */
  status: "open" | PaymentIntent["status"];
  /** The payment made for this order, once the API has answered. */
  intentId?: string;
  /**
   * A capture was sent and its answer was lost or ambiguous. Money may have
   * moved: this order is not captured again until a person has checked it.
   */
  captureUnknown?: boolean;
  /** The capture call now running, so a second path joins it. See captureOrder. */
  capturing?: Promise<CaptureResult>;
}
type CaptureResult = PaymentIntent | "refused" | "retry_later" | "unknown";
const orders = new Map<string, Order>();

function createOrder(): Order {
  const order: Order = { id: `ord_${randomUUID()}`, amount: AMOUNT_MINOR, currency: CURRENCY, status: "open" };
  orders.set(order.id, order);
  return order;
}

// Money is held or taken. A repeat /charge must not read like a new payment.
function orderHoldsMoney(order: Order): boolean {
  return order.status === "authorized" || order.status === "captured" || order.status === "succeeded";
}

// Only an order still holding money captures, and never after an unknown capture.
// A function, not an inline test: the answer can change during an await, because a
// webhook and a buyer's return run at the same time.
function mayCapture(order: Order): boolean {
  return order.status === "authorized" && order.captureUnknown !== true;
}

// Webhooks can arrive late and out of order, and a read can race a webhook, so a
// late failure or hold never moves an order back from a state that holds or took
// money. A released hold is the one exception: the money is free again, and an
// order left at `authorized` would refuse every new /charge.
function moveOrder(order: Order, status: PaymentIntent["status"]): void {
  const holdReleased = order.status === "authorized" && (status === "voided" || status === "cancelled");
  if (status === "succeeded" || status === "captured" || holdReleased || !orderHoldsMoney(order)) {
    order.status = status;
  }
}

// Apply a webhook to the order that made this payment.
function updateOrderFromWebhook(
  intentId: string | null,
  status: "authorized" | "succeeded" | "failed",
): Order | undefined {
  if (intentId === null) return undefined;
  for (const order of orders.values()) {
    if (order.intentId !== intentId) continue;
    moveOrder(order, status);
    return order;
  }
  return undefined;
}

// The one capture call. Every path uses it, so the key is always {order}:capture
// and a repeat from any path collapses into one capture.
//
// The webhook and the buyer's return can arrive together. The second one joins the
// call already running: two calls at once can get a "still running" answer, which
// would read as an unknown capture. This map is per process, so a real app with
// more than one process takes this claim with an atomic update on the order row.
function captureOrder(order: Order, intentId: string): Promise<CaptureResult> {
  order.capturing ??= sendCapture(order, intentId).finally(() => {
    order.capturing = undefined;
  });
  return order.capturing;
}

// ⛔ Three different failures. The order is kept in all of them, at `authorized`:
//   refused      The API answered no. No money moved, and repeating cannot help.
//   retry_later  The API answered no for now. No money moved. Repeat the same key.
//   unknown      A 5xx, a lost answer, or "reconcile". The capture may have gone
//                through, and an idempotency key does not make a repeat safe here.
//                Do NOT capture again: read the payment or ask a person first.
async function sendCapture(order: Order, intentId: string): Promise<CaptureResult> {
  try {
    const captured = await vonpay.paymentIntents.capture(intentId, undefined, {
      idempotencyKey: `${order.id}:capture`,
    });
    order.status = captured.status;
    return captured;
  } catch (err) {
    logVonPayError("capture", err);
    if (err instanceof VonPayError && err.status < 500 && err.nextAction !== "reconcile") {
      return err.retryable ? "retry_later" : "refused";
    }
    order.captureUnknown = true;
    return "unknown";
  }
}

// POST /orders — start an order. Returns its id; pass it to /charge.
app.post("/orders", (_req: Request, res: Response): void => {
  res.status(201).json({ orderId: createOrder().id });
});

// ─── Create + 3DS branch ─────────────────────────────────────────────────
// POST /charge  { orderId } — the server decides what is charged, and to which
// card. The order id only says WHICH of your orders this is.
//
// ⛔ The card is NOT read from the request. This route used to accept
// `{ paymentMethod: "vp_pmt_..." }` in the body, which let anyone who had seen
// another buyer's saved-card id (a support paste, a log, their own devtools)
// charge that card through your server. Card ids are not secrets. Look the card
// up server-side for the signed-in customer, exactly as the amount below is
// fixed server-side, and send `buyerId` so the API refuses a card saved for
// someone else.
//
// We use capture_method: "manual" so a 3DS success lands on `authorized`
// (auth held, not captured) and we capture explicitly. With
// capture_method: "automatic" the same flow collapses straight to `succeeded`.
//
// ⚠ Before deploying, rate-limit /orders and /charge (per buyer and per IP) and
// put your bot / card-testing protection in front of them. /charge moves money
// with your secret key on every call, which is exactly what card testers look
// for. This sample deliberately has neither.
app.post("/charge", async (req: Request, res: Response): Promise<void> => {
  // There is no made-up test token: in test mode a `vp_pmt_test_*` token is a
  // real card saved on your sandbox account's payment provider test
  // environment, and whether the bank challenges is up to that environment —
  // use a card your provider's test environment challenges.
  const paymentMethodId = savedPaymentMethodId;
  if (!paymentMethodId) {
    res.status(400).json({
      error: "No saved card to charge. Set VON_PAY_PAYMENT_METHOD (and VON_PAY_BUYER_ID).",
    });
    return;
  }

  // The order must be one THIS server created. Its stored amount and id are
  // what get charged and keyed; nothing else in the request is read.
  const requested: unknown = req.body?.orderId;
  const order = typeof requested === "string" ? orders.get(requested) : undefined;
  if (!order) {
    res.status(400).json({
      error: "Unknown order. Start one with POST /orders (or load the page at /), then pay it.",
    });
    return;
  }
  const orderId = order.id;

  // ⛔ An order that holds or took money answers a conflict, so a repeat cannot
  // read like a new payment. The idempotency key alone would replay the old
  // answer in silence. A payment still at the bank's check (requires_action) or
  // declined is not refused here: its replay is the same redirect or decline.
  if (orderHoldsMoney(order)) {
    res.status(409).json({
      error: "This order already has a payment. Do not pay again.",
      code: "order_already_charged",
      orderStatus: order.status,
      intentId: order.intentId,
    });
    return;
  }

  const chargeParams: CreatePaymentIntentParams = {
    amount: order.amount,
    currency: order.currency,
    captureMethod: "manual",
    paymentMethod: { id: paymentMethodId },
    // ⛔ Send the buyer the card was saved for on every saved-card charge. The
    // API returns 404 payment_method_not_found when it does not match, which is
    // what stops a stored card being billed to the wrong customer. It only
    // protects you when you send it (see the saved-cards-mit sample).
    ...(savedCardBuyerId ? { buyerId: savedCardBuyerId } : {}),
    returnUrl: returnUrlFor(orderId),
    metadata: { order_id: orderId, sample: "payment-intents-3ds" },
  };

  let intent: PaymentIntent;
  try {
    // Same order → same key → the API answers a repeat with the payment it
    // already made. ⚠ It replays a decline too: to let the buyer try again
    // after a decline, start a new order (or add an attempt number to the key).
    intent = await vonpay.paymentIntents.create(chargeParams, {
      idempotencyKey: `${orderId}:authorize`,
    });
  } catch (err) {
    logVonPayError("charge.create", err);
    res.status(502).json({ error: "Could not create payment intent" });
    return;
  }

  order.status = intent.status;
  order.intentId = intent.id;

  switch (intent.status) {
    case "requires_action": {
      // 3DS / SCA: the bank wants to challenge the buyer. Redirect at the TOP
      // LEVEL of the browser — never inside an iframe (banks frame-bust).
      const url = extractRedirectUrl(intent);
      if (!url) {
        // requires_action with no usable redirect we recognize. Fail safe.
        console.error({
          route: "/charge",
          msg: "requires_action_without_known_redirect",
          intentId: intent.id,
        });
        res
          .status(502)
          .json({ error: "Authentication required but no supported next_action" });
        return;
      }
      console.log({
        route: "/charge",
        msg: "redirecting_to_3ds_challenge",
        intentId: intent.id,
        orderId,
      });
      // 303 so the browser does a GET to the challenge page.
      res.redirect(303, url);
      return;
    }

    case "authorized": {
      // No challenge required. Funds are held — capture to settle.
      const captured = await captureOrder(order, intent.id);
      if (typeof captured === "string") {
        // The order stays `authorized`: the money is held, so another /charge
        // answers 409. Finish the capture, or void the hold, from your own
        // back office.
        res.status(502).json({ error: "Authorized but capture failed" });
        return;
      }
      res.json({
        outcome: "captured",
        intentId: captured.id,
        status: captured.status,
        amount: captured.amount,
        currency: captured.currency,
      });
      return;
    }

    case "failed": {
      // Declined before any challenge.
      //
      // ⛔ `declineCode` IS NOT UNCONDITIONALLY BROWSER-SAFE, and this sample
      // used to relay it raw. When it is `blocked_by_rule` it means one of YOUR
      // OWN rules refused the charge, not the cardholder's bank — and anyone
      // holding your publishable key could then iterate cards and map which
      // brands, ranges or countries your rules refuse, in order to route around
      // them. The buyer's next step is identical either way: a different card.
      //
      // So substitute the generic value for that one case. Everything else is
      // safe to pass through, and `declineMessage` (SDK 2.1.0+) gives you
      // buyer-ready copy under the same rule.
      const browserSafeDeclineCode =
        intent.declineCode === "blocked_by_rule" ? "card_declined" : intent.declineCode;

      res.status(402).json({
        outcome: "failed",
        intentId: intent.id,
        declineCode: browserSafeDeclineCode,
      });
      return;
    }

    default: {
      // succeeded / voided are unexpected for a manual-capture create — surface
      // them rather than guessing.
      res.json({
        outcome: "unexpected_status",
        intentId: intent.id,
        status: intent.status,
      });
    }
  }
});

// ─── 3DS return landing ───────────────────────────────────────────────────
// The issuer sends the buyer back here after the challenge. The link says only
// WHICH order came back, and anyone can open or reload it, so nothing else in the
// request is read and the payment's status comes from the API, on your key.
//
// A payment the API reports as held is captured here too, because the
// payment_intent.authorized webhook may not reach you (see the README). Both paths
// use the order's {order}:capture key, so together they make one capture, and
// reloading this page makes none.
//
// ⛔ Do not fulfill from this handler. Fulfill on payment_intent.succeeded.
// ⚠ A buyer who never comes back does not reach this code. Without the webhook,
// that payment stays held until you find it some other way.
app.get("/3ds/return", async (req: Request, res: Response): Promise<void> => {
  const requested = req.query[ORDER_PARAM];
  const order = typeof requested === "string" ? orders.get(requested) : undefined;
  if (order?.intentId) await captureOnReturn(order, order.intentId);
  res.type("html").send(
    [
      "<h1>Authentication complete</h1>",
      "<p>Your bank has finished the security check. We're confirming the",
      "payment now — your order updates as soon as we receive the result.</p>",
      `<p>Reference: ${escapeHtml(order?.id ?? "(none)")}</p>`,
      "<p><em>This page never fulfills. The real outcome is verified server-side",
      "from the payment_intent.succeeded / payment_intent.failed webhook.</em></p>",
    ].join("\n"),
  );
});

// The buyer sees the same page whatever happens here. A failed read or capture is
// left for the webhook, or for a person, as the capture table in the README says.
async function captureOnReturn(order: Order, intentId: string): Promise<void> {
  if (order.status === "succeeded" || order.status === "captured" || order.captureUnknown === true) {
    return;
  }

  let status: PaymentIntent["status"];
  try {
    ({ status } = await vonpay.paymentIntents.retrieve(intentId));
  } catch (err) {
    logVonPayError("return.retrieve", err);
    return;
  }
  moveOrder(order, status);

  // Capture only what the API says is held NOW. A webhook may have captured or
  // marked the order during the read, and staff may have voided the hold.
  if (status !== "authorized" || !mayCapture(order)) return;
  await captureOrder(order, intentId);
}

// ─── Webhook receiver — confirms the post-3DS terminal state ──────────────
// Header:  x-vonpay-signature: t=<unix>,v1=<hex>  (timestamp is INSIDE the
//          header; there is no separate timestamp header)
// Secret:  the per-endpoint whsec_* signing secret (NOT your API key)
//
// `constructEvent` verifies the signature + replay window and throws on any
// failure (the verification gate this sample relies on). It returns the SDK's
// typed `WebhookEvent` union, which includes the `payment_intent.*` family:
// discriminator `type`, body nested under `data`, decline reason at
// `data.failure_reason`. Switching on `event.type` narrows `event.data`.
app.post("/webhooks", async (req: Request, res: Response): Promise<void> => {
  const signature = req.headers["x-vonpay-signature"];
  if (typeof signature !== "string") {
    res.status(400).json({ error: "Missing x-vonpay-signature header" });
    return;
  }

  let event: WebhookEvent;
  try {
    // Verify signature + replay window (throws on failure).
    event = vonpay.webhooks.constructEvent(req.body as Buffer, signature, webhookSecret);
  } catch (err) {
    // 400 (not 200) so the delivery engine retries. Log only err.message — the
    // full error object can carry signature/HMAC bytes in its diagnostic
    // fields, which must never reach stdout.
    console.warn({
      route: "/webhooks",
      msg: "signature_verification_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  // A "Send test event" delivery is signed and can carry a real order's ids: acknowledge it and do nothing else.
  if (event.test_event === true) {
    res.status(200).json({ received: true });
    return;
  }

  switch (event.type) {
    case "payment_intent.succeeded":
      // 3DS passed (or no challenge was needed) and funds settled. THIS is the
      // signal to fulfill — not the /3ds/return page. Look the order up by
      // event.data.payment_intent_id (and dedupe on event.id) and mark it paid.
      updateOrderFromWebhook(event.data.payment_intent_id, "succeeded");
      console.log({
        route: "/webhooks",
        type: event.type,
        eventId: event.id,
        transactionId: event.data.transaction_id,
        msg: "fulfill_order",
      });
      break;
    case "payment_intent.authorized": {
      // 3DS passed on a manual-capture payment. The money is held, not taken,
      // and an unused hold lapses at the bank, so capture it here. The return
      // page captures too, but the buyer's browser may never come back.
      const order = updateOrderFromWebhook(event.data.payment_intent_id, "authorized");
      console.log({
        route: "/webhooks",
        type: event.type,
        eventId: event.id,
        orderFound: order !== undefined,
        msg: "funds_held",
      });
      // A redelivery or a late event finds the order already captured, or with
      // a capture nobody may repeat.
      if (!order || !mayCapture(order)) break;

      const captured = await captureOrder(order, event.data.payment_intent_id as string);
      if (captured === "retry_later") {
        // 5xx so the delivery comes back. The repeat sends the same key.
        res.status(503).json({ error: "Capture not finished. Send this delivery again." });
        return;
      }
      // "refused" and "unknown" are acknowledged: a repeat cannot help the first
      // and is not safe for the second. The order stays `authorized` for a person
      // to check. A real app alerts its staff here.
      break;
    }
    case "payment_intent.failed":
      // 3DS challenge rejected, or the charge declined. Do NOT fulfill.
      updateOrderFromWebhook(event.data.payment_intent_id, "failed");
      console.log({
        route: "/webhooks",
        type: event.type,
        eventId: event.id,
        transactionId: event.data.transaction_id,
        failureReason: event.data.failure_reason,
        msg: "do_not_fulfill",
      });
      break;
    default:
      // Forward-compatible: ack unknown events so they aren't redelivered. New
      // event types can ship without an SDK bump — never 5xx one you don't know.
      // This includes charge.* / refund.* (handled in other samples) and
      // payment_intent.cancelled.
      console.log({
        route: "/webhooks",
        msg: "event_ignored",
        type: event.type,
      });
  }

  res.status(200).json({ received: true });
});

// ─── Health + index ───────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    const health = await vonpay.health();
    res.json(health);
  } catch (err) {
    console.error(
      "Health check failed:",
      err instanceof Error ? err.message : String(err),
    );
    res.status(503).json({ status: "unreachable" });
  }
});

app.get("/", (_req, res) => {
  // One order per page view. Submitting this form twice sends the same order
  // id, so it can only ever be charged once: the second submit gets the same
  // decline or bank redirect, or a 409 once the order holds money.
  const order = createOrder();
  res.type("html").send(
    [
      "<h1>Von Payments — Payment Intents 3DS sample</h1>",
      "<p>Click pay to create a manual-capture intent with the saved card in",
      "VON_PAY_PAYMENT_METHOD. If the bank challenges, the server redirects",
      "you to the issuer challenge, then confirms the outcome from the webhook.</p>",
      '<form action="/charge" method="POST">',
      `  <input type="hidden" name="orderId" value="${escapeHtml(order.id)}" />`,
      "  <button type=\"submit\">Pay $49.99 (3DS challenge)</button>",
      "</form>",
      "<p>POST /orders — start an order</p>",
      "<p>POST /charge — create intent for an order, redirect to 3DS on requires_action</p>",
      "<p>GET  /3ds/return — issuer challenge return (captures a held payment, never fulfills)</p>",
      "<p>POST /webhooks — verifies x-vonpay-signature, confirms terminal state</p>",
    ].join("\n"),
  );
});

app.listen(port, () => {
  console.log({
    msg: "server_started",
    url: `http://localhost:${port}`,
    baseUrl,
    returnUrl: returnUrl.toString(),
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function logVonPayError(label: string, err: unknown): void {
  if (err instanceof VonPayError) {
    // VonPayError carries machine-readable code + status + requestId, plus
    // lifecycle extras (currentStatus / rejectReason) on 422 invalid_transition.
    console.error(`[${label}] VonPayError`, {
      code: err.code,
      status: err.status,
      requestId: err.requestId,
      currentStatus: err.currentStatus,
      rejectReason: err.rejectReason,
      message: err.message,
    });
    return;
  }
  console.error(`[${label}]`, err instanceof Error ? err.message : String(err));
}
