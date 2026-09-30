import { NextRequest, NextResponse } from "next/server";
import { VonPayCheckout } from "@vonpay/checkout-node";
import { getTenant, getTenantCredentials } from "@/lib/tenants";
import { getCustomer } from "@/lib/customers";

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
 *
 * ⛔ The form does NOT post an amount, and this route reads none. Everything a
 * browser sends can be edited — a hidden field is one right-click away — so a
 * price taken from the form lets anyone pay $0.01 for a $1,499 invoice. The
 * amount, currency and buyer email come from the customer record on the SERVER
 * (`getCustomer`). The browser cannot influence the amount at all; it only
 * picks which customer.
 *
 * ⚠️ Auth: intentionally unauthenticated for local-dev convenience. Gate this
 * route behind your platform's own sign-in before deploying — as written,
 * anyone who can reach it can start a checkout on any tenant's API key. Also
 * check that the signed-in user is allowed to act for `tenantId`.
 *
 * The handler:
 *   1. Resolves the tenant and the customer, and looks up the tenant's vp_sk
 *   2. Builds a tenant-scoped successUrl
 *   3. Calls vonpay.sessions.create() with an Idempotency-Key
 *   4. 303-redirects to the returned checkoutUrl
 */
export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const tenantId = String(formData.get("tenantId") ?? "");
  const orderId = String(formData.get("orderId") ?? "");
  const customerId = String(formData.get("customerId") ?? "");

  const tenant = getTenant(tenantId);
  if (!tenant) {
    return NextResponse.json({ error: "unknown_tenant" }, { status: 400 });
  }
  // Price, currency and email come from YOUR record, looked up on the server —
  // never from the form. Keyed on the tenant too, so a customer id belonging to
  // one tenant cannot be charged under another.
  const customer = getCustomer(tenant.id, customerId);
  if (!customer) {
    return NextResponse.json({ error: "unknown_customer" }, { status: 400 });
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
        amount: customer.chargeAmount,
        currency: customer.currency,
        successUrl: `${baseUrl}/tenants/${tenantId}/confirm`,
        cancelUrl: `${baseUrl}/tenants/${tenantId}`,
        buyerId: customer.id,
        buyerEmail: customer.email,
        lineItems: [
          {
            name: "Acme CRM charge",
            quantity: 1,
            unitAmount: customer.chargeAmount,
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
