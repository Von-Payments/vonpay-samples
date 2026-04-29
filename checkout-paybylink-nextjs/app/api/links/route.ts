import { NextRequest, NextResponse } from "next/server";
import { VonPayCheckout } from "@vonpay/checkout-node";
import { saveLink, listLinks, type PayLink } from "@/lib/storage";

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

// Auth: intentionally unauthenticated for local-dev convenience. Gate this route
// behind session / Bearer auth before deploying — POST creates real sessions
// against your API key; GET enumerates every link you've ever made.
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    amount?: number;
    currency?: string;
    description?: string;
  };

  const amount = Number(body.amount);
  const currency = (body.currency ?? "USD").toUpperCase();
  const description = String(body.description ?? "").slice(0, 200);

  if (!Number.isInteger(amount) || amount <= 0) {
    return NextResponse.json({ error: "amount must be a positive integer (minor units)" }, { status: 400 });
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    return NextResponse.json({ error: "currency must be a 3-letter ISO code" }, { status: 400 });
  }
  if (!description) {
    return NextResponse.json({ error: "description is required" }, { status: 400 });
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const linkId = crypto.randomUUID();

  try {
    const session = await vonpay.sessions.create({
      amount,
      currency,
      successUrl: `${baseUrl}/confirm`,
      // cancelUrl points at the dashboard (not the individual link) so a buyer
      // who bails still lands somewhere valid even if the server has restarted
      // and the in-memory store is gone.
      cancelUrl: `${baseUrl}/links`,
      lineItems: [{ name: description, quantity: 1, unitAmount: amount }],
    });

    const link: PayLink = {
      id: linkId,
      sessionId: session.id,
      checkoutUrl: session.checkoutUrl,
      amount,
      currency,
      description,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: session.expiresAt,
    };
    saveLink(link);

    return NextResponse.json(link, { status: 201 });
  } catch (err) {
    // Log only the message — same hygiene as webhooks/route.ts: avoid
    // serializing the full error object, which in some structured loggers
    // could walk into the SDK client and surface the API key.
    console.error("pay-link create failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "Failed to create pay link" }, { status: 500 });
  }
}

export async function GET() {
  // Strip `checkoutUrl` from the list projection — it's a bearer token that
  // should only appear on the single-link detail response.
  const links = listLinks().map(({ checkoutUrl, ...rest }) => rest);
  return NextResponse.json({ links });
}
