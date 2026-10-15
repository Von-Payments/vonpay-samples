import { NextResponse } from "next/server";
import { VonPayCheckout } from "@vonpay/checkout-node";
import { CHECKOUT_COOKIE, saveOrder } from "@/lib/orders";

const vonpay = new VonPayCheckout({
  apiKey: process.env.VON_PAY_SECRET_KEY!,
  // Wire your error reporting here. SDK calls this synchronously on
  // sessions.* failures, constructEvent verification failures, and final-
  // retry network errors. Never phones home; passing nothing preserves
  // pre-0.2.0 behavior. See https://docs.vonpay.com/sdks/node-sdk#error-reporting
  // errorReporter: (err, ctx) => {
  //   Sentry.captureException(err, { tags: { sdk: "vonpay-node", method: ctx.method }, contexts: { vonpay: ctx } });
  // },
});

export async function POST() {
  // Stand-in for YOUR order id — in a real app, create the order first and use its id.
  const orderId = `order_${Date.now().toString(36)}`;
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
    saveOrder(session.id, { orderId, amount, currency });

    const res = NextResponse.json({ checkoutUrl: session.checkoutUrl });
    // And tie the return to this browser. HttpOnly: page scripts cannot read
    // it. SameSite=Lax: it still comes back on the redirect from checkout.
    res.cookies.set(CHECKOUT_COOKIE, session.id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: baseUrl.startsWith("https://"),
    });
    return res;
  } catch (err) {
    console.error("Checkout error:", err);
    return NextResponse.json({ error: "Failed to create checkout session" }, { status: 500 });
  }
}
