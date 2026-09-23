import { NextRequest, NextResponse } from "next/server";
import { VonPayCheckout } from "@vonpay/checkout-node";
import { getTenant, getTenantCredentials } from "@/lib/tenants";

/**
 * POST /api/charge — create a checkout session for a specific tenant.
 *
 * The platform's UI form posts:
 *   tenantId       — internal tenant ID (resolves to the merchant's API key)
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

  // Idempotency-Key — every connector should send one. If the platform
  // retries this charge POST (browser refresh, network blip), the
  // server treats both calls as the same session instead of creating
  // two. Recommend: stable per logical-charge-attempt, not per-request —
  // so NO random component: a fresh UUID per call would make every retry
  // a new session and defeat the key. Best is your own charge/order id;
  // this sample has none, so customerId + amount + minute bucket stands in.
  // ⚠️ That stand-in MERGES two genuine purchases by the same customer for the
  // same amount within one minute into one session. Do not ship it: use your
  // own persisted order id.
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const idempotencyKey = `${tenantId}:${customerId}:${amountCents}:${minuteBucket}`;

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
