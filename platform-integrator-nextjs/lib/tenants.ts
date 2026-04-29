/**
 * Tenant registry — in a real platform, this lives in your DB
 * (Postgres, DynamoDB, whatever) and is keyed by an internal merchant
 * ID. Each tenant row stores the merchant's Von Payments credentials.
 *
 * Two columns matter on the platform side:
 *   - vp_sk         — secret API key, used to sign outbound requests
 *   - ss            — session signing secret, used to verify return
 *                     URL signatures when the buyer redirects back
 *
 * Both should be encrypted at rest. Decryption happens at request time
 * (here: env-var lookup) and is cached for the request scope, not
 * across requests.
 *
 * For this sample we simulate 3 onboarded tenants via env vars.
 * Replace `getTenantCredentials` with a real DB lookup in production.
 */

export interface TenantCredentials {
  /** The merchant's Von Payments secret API key. */
  vpSk: string;
  /** The merchant's Von Payments session signing secret. */
  ss: string;
}

export interface Tenant {
  id: string;
  /** Display name shown in the platform's UI. */
  name: string;
  /** Sub-domain or slug — your platform's choice. */
  slug: string;
}

/** The platform's known tenants. In production, list from your DB. */
export const TENANTS: Tenant[] = [
  { id: "tenant_a", name: "Acme Vitamins", slug: "acme-vitamins" },
  { id: "tenant_b", name: "Brightline SaaS", slug: "brightline" },
  { id: "tenant_c", name: "Cobalt Coaching", slug: "cobalt" },
];

/**
 * Look up the Von Payments credentials for a tenant.
 *
 * In production, this hits your DB. The sample reads from process.env
 * so each tenant maps to a TENANT_{A|B|C}_VP_SK and TENANT_{A|B|C}_SS
 * pair. Throws if the tenant is unknown or credentials are missing.
 */
export function getTenantCredentials(tenantId: string): TenantCredentials {
  const upper = tenantId.replace(/^tenant_/, "").toUpperCase();
  const vpSk = process.env[`TENANT_${upper}_VP_SK`];
  const ss = process.env[`TENANT_${upper}_SS`];

  if (!vpSk || !ss) {
    throw new Error(
      `No credentials configured for tenant '${tenantId}'. ` +
        `Set TENANT_${upper}_VP_SK and TENANT_${upper}_SS in .env.local.`,
    );
  }
  return { vpSk, ss };
}

export function getTenant(tenantId: string): Tenant | undefined {
  return TENANTS.find((t) => t.id === tenantId);
}

/**
 * Reverse lookup: given a merchantId returned in a Von Payments webhook
 * payload, find the tenant on the platform side that owns it. In
 * production, this is a DB lookup keyed by `merchant_id`. Here we map
 * tenant IDs 1:1 to merchants — your real platform may have a more
 * complex relationship.
 *
 * For this sample we accept the inbound merchant_id as the tenant_id.
 * Webhook routing matches on this.
 */
export function findTenantByVonPayMerchantId(
  vonPayMerchantId: string,
): Tenant | undefined {
  // Real implementation: SELECT tenant_id FROM merchant_tenants
  //                     WHERE vonpay_merchant_id = $1
  // Here, we treat the slug as the merchant_id for demo simplicity.
  return TENANTS.find((t) => t.slug === vonPayMerchantId);
}
