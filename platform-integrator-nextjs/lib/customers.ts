/**
 * Mock customer list per tenant. In a real CRM/platform, this is your
 * own model — `customers`, `subscribers`, `orders`, whatever shape your
 * product uses. Von Payments doesn't care; the platform owns customer
 * data and only passes amounts + line items to Vora at charge time.
 *
 * ⚠️ This list is where the PRICE comes from. `/api/charge` looks the customer
 * up here, on the server, and charges `chargeAmount` from this record. The
 * browser only says WHICH customer; it never says how much. In production this
 * is your own order or invoice row, read on the server.
 */

export interface Customer {
  id: string;
  name: string;
  email: string;
  /** What this customer is charged, in MINOR units (4995 = $49.95). */
  chargeAmount: number;
  /** ISO 4217 currency code for `chargeAmount`. */
  currency: string;
}

export const CUSTOMERS: Record<string, Customer[]> = {
  tenant_a: [
    { id: "cus_a1", name: "Jamie Liu", email: "jamie@example.com", chargeAmount: 4995, currency: "USD" },
    { id: "cus_a2", name: "Pat Rivera", email: "pat@example.com", chargeAmount: 8900, currency: "USD" },
    { id: "cus_a3", name: "Sam O'Hara", email: "sam@example.com", chargeAmount: 15999, currency: "USD" },
  ],
  tenant_b: [
    { id: "cus_b1", name: "Northwind Co.", email: "billing@northwind.com", chargeAmount: 29900, currency: "USD" },
    { id: "cus_b2", name: "Solstice Labs", email: "ap@solsticelabs.io", chargeAmount: 149900, currency: "USD" },
  ],
  tenant_c: [
    { id: "cus_c1", name: "Reed Patel", email: "reed@example.com", chargeAmount: 19900, currency: "USD" },
    { id: "cus_c2", name: "Mira Chen", email: "mira@example.com", chargeAmount: 19900, currency: "USD" },
    { id: "cus_c3", name: "Avery Stone", email: "avery@example.com", chargeAmount: 9900, currency: "USD" },
  ],
};

/**
 * Server-side lookup: the customer record for (tenant, customer id), or
 * undefined when that customer does not belong to that tenant. Keyed on BOTH,
 * so a form posted for one tenant can never charge another tenant's customer.
 */
export function getCustomer(tenantId: string, customerId: string): Customer | undefined {
  return (CUSTOMERS[tenantId] ?? []).find((c) => c.id === customerId);
}
