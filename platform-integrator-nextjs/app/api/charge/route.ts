import { NextRequest, NextResponse } from "next/server";
import { VonPayCheckout } from "@vonpay/checkout-node";
import { getTenant, getTenantCredentials } from "@/lib/tenants";

// The shape the tenant page mints: `ord_` + a random (v4) UUID. Anything else
// is refused rather than used as a key, so a missing or free-form value can
// never silently collide with another order's session.
const ORDER_ID_PATTERN =
  /^ord_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * POST /api/charge — create a checkout session for a specific tenant.
 *
 * The platform's UI form posts:
 *   tenantId       — internal tenant ID (resolves to the merchant's API key)
 *   orderId        — the order this charge is for, minted once when the
 *                    form was rendered (`ord_<uuid>`); keys idempotency
 *   customerId     — your CRM's customer ID (becomes buyerId in Von Payments)
 *   customerEmail  — buyer email (becomes buyerEmail)
 *   amountCents    — charge amount in minor units
 *
 * The handler:
 *   1. Resolves the tenant and looks up their vp_sk credential
 *   2. Builds a tenant-scoped successUrl
 *   3. Calls vonpay.sessions.create() with an Idempotency-Key
 *   4. 303-redirects to the returned checkoutUrl
 */
export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const tenantId = String(formData.get("tenantId") ?? "");
  const orderId = String(formData.get("orderId") ?? "");
  const customerId = String(formData.get("customerId") ?? "");
  const customerEmail = String(formData.get("customerEmail") ?? "");
  const amountCents = Number.parseInt(String(formData.get("amountCents") ?? "0"), 10);

  const tenant = getTenant(tenantId);
  if (!tenant) {
    return NextResponse.json({ error: "unknown_tenant" }, { status: 400 });
  }
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  }
  if (!ORDER_ID_PATTERN.test(orderId)) {
    return NextResponse.json({ error: "invalid_order_id" }, { status: 400 });
  }

  let credentials;
  try {
    credentials = getTenantCredentials(tenantId);
  } catch (err) {
    console.error("Tenant credential lookup failed:", err);
    return NextResponse.json({ error: "tenant_credentials_missing" }, { status: 500 });
  }

  const baseUrl = process.env.BASE_URL ?? new URL(req.url).origin;
  const vonpay = new VonPayCheckout({
    apiKey: credentials.vpSk,
    // Pin the API version. The platform's adapter contract changes
    // when this changes — leave it explicit, don't track latest.
    apiVersion: "2026-05-05",
  });

  // Idempotency-Key — every connector should send one. Key it on the ORDER:
  // a double-click or a retried POST of the same form carries the same
  // orderId, so the server returns the one session it already created; two
  // separate purchases carry two ids and can never be merged, even for the
  // same customer, the same amount and the same minute. Do NOT mint the id
  // here: a fresh id per request would make every retry a new session.
  //
  // ⚠️ This sample mints the id when the page renders, because it has no
  // order table. In production, create the order row first and use its id.
  const idempotencyKey = `${tenantId}:${orderId}`;

  try {
    const session = await vonpay.sessions.create(
      {
        amount: amountCents,
        currency: "USD",
        successUrl: `${baseUrl}/tenants/${tenantId}/confirm`,
        cancelUrl: `${baseUrl}/tenants/${tenantId}`,
        buyerId: customerId,
        buyerEmail: customerEmail,
        lineItems: [
          {
            name: "Acme CRM charge",
            quantity: 1,
            unitAmount: amountCents,
          },
        ],
      },
      {
        // SDK passes this through as Idempotency-Key on the wire.
        idempotencyKey,
      },
    );

    // 303 See Other ensures the browser GETs the checkoutUrl after a POST.
    return NextResponse.redirect(session.checkoutUrl, 303);
  } catch (err) {
    // Log the detail server-side only. Never forward String(err) to the caller
    // — a VonPayError message can carry a request id, decline code, or key
    // prefix that should not leave the server.
    console.error(`Session create failed for tenant ${tenantId}:`, err);
    return NextResponse.json(
      { error: "session_create_failed" },
      { status: 502 },
    );
  }
}
