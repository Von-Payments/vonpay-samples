/**
 * Mock customer list per tenant. In a real CRM/platform, this is your
 * own model — `customers`, `subscribers`, `orders`, whatever shape your
 * product uses. Von Payments doesn't care; the platform owns customer
 * data and only passes amounts + line items to Vora at charge time.
 */

export interface Customer {
  id: string;
  name: string;
  email: string;
  /** Last charge attempt's display amount in dollars (just for the UI). */
  lastAmountDollars: number;
}

export const CUSTOMERS: Record<string, Customer[]> = {
  tenant_a: [
    { id: "cus_a1", name: "Jamie Liu", email: "jamie@example.com", lastAmountDollars: 49.95 },
    { id: "cus_a2", name: "Pat Rivera", email: "pat@example.com", lastAmountDollars: 89.0 },
    { id: "cus_a3", name: "Sam O'Hara", email: "sam@example.com", lastAmountDollars: 159.99 },
  ],
  tenant_b: [
    { id: "cus_b1", name: "Northwind Co.", email: "billing@northwind.com", lastAmountDollars: 299.0 },
    { id: "cus_b2", name: "Solstice Labs", email: "ap@solsticelabs.io", lastAmountDollars: 1499.0 },
  ],
  tenant_c: [
    { id: "cus_c1", name: "Reed Patel", email: "reed@example.com", lastAmountDollars: 199.0 },
    { id: "cus_c2", name: "Mira Chen", email: "mira@example.com", lastAmountDollars: 199.0 },
    { id: "cus_c3", name: "Avery Stone", email: "avery@example.com", lastAmountDollars: 99.0 },
  ],
};
