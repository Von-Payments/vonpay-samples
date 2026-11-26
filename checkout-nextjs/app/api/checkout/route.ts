import { NextResponse } from "next/server";
import { VonPayCheckout } from "@vonpay/checkout-node";
import { CHECKOUT_COOKIE, hasRoomForCheckout, saveOrder } from "@/lib/orders";

const vonpay = new VonPayCheckout({
  apiKey: process.env.VON_PAY_SECRET_KEY!,
  // Shorter than the SDK's defaults (30 s a try, 2 retries): this client only
  // creates sessions, and a buyer is waiting. ⛔ Do not shorten a client that
  // captures or voids: a timeout there leaves a result nobody knows.
  timeout: 10_000,
  maxRetries: 1,
  // Wire your error reporting here. SDK calls this synchronously on
  // sessions.* failures, constructEvent verification failures, and final-
  // retry network errors. Never phones home; passing nothing preserves
  // pre-0.2.0 behavior. See https://docs.vonpay.com/sdks/node-sdk#error-reporting
  // errorReporter: (err, ctx) => {
  //   Sentry.captureException(err, { tags: { sdk: "vonpay-node", method: ctx.method }, contexts: { vonpay: ctx } });
  // },
});

// ⚠ Before deploying, rate-limit this route (per IP and per buyer) and put bot
// protection in front of it. Every call creates a checkout session on your
// key, and an open route like this is what card testers look for. This sample
// has neither.
export async function POST() {
  if (!hasRoomForCheckout()) {
    return NextResponse.json({ error: "Too many checkouts. Please try again later." }, { status: 503 });
  }
  // Stand-in for YOUR order id — in a real app, create the order first and use its id.
  const orderId = `order_${crypto.randomUUID()}`;
  const amount = 2500;
  const currency = "USD";
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  try {
    const session = await vonpay.sessions.create(
      {
        amount,
        currency,
        successUrl: `${baseUrl}/confirm`,
        cancelUrl: `${baseUrl}/`,
        lineItems: [{ name: "Sample Item", quantity: 1, unitAmount: amount }],
        metadata: { order_id: orderId },
      },
      // Key on YOUR order id. Here orderId is made per request, so this only dedupes the SDK's own retry of this call; to dedupe a double-click or refresh, create the order first and reuse its id.
      { idempotencyKey: `session:${orderId}` },
    );

    // Remember which order this session pays for, on YOUR server. The confirm
    // page looks the order up from this record, never from the URL.
    const checkoutRef = saveOrder(session.id, { orderId, amount, currency, status: "pending", expiresAt: session.expiresAt });

    const res = NextResponse.json({ checkoutUrl: session.checkoutUrl });
    // And tie the return to this browser, by a random reference that only this
    // server maps to the session. HttpOnly: page scripts cannot read it.
    // SameSite=Lax: it still comes back on the redirect from checkout.
    res.cookies.set(CHECKOUT_COOKIE, checkoutRef, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: baseUrl.startsWith("https://"),
    });
    return res;
  } catch (err) {
    // Log only the message: the full error object can carry request details.
    console.error("Checkout error:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "Failed to create checkout session" }, { status: 500 });
  }
}
