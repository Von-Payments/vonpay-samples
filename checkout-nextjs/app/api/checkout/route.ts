import { NextResponse } from "next/server";
import { VonPayCheckout } from "@vonpay/checkout-node";

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
  try {
    const session = await vonpay.sessions.create({
      amount: 2500,
      currency: "USD",
      successUrl: `${process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"}/confirm`,
      cancelUrl: `${process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"}/`,
      lineItems: [{ name: "Sample Item", quantity: 1, unitAmount: 2500 }],
    });

    return NextResponse.json({ checkoutUrl: session.checkoutUrl });
  } catch (err) {
    console.error("Checkout error:", err);
    return NextResponse.json({ error: "Failed to create checkout session" }, { status: 500 });
  }
}
