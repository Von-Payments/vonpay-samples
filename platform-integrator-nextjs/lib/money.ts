import { minorUnitDigits } from "@vonpay/checkout-node";

/**
 * Format an amount in MINOR units (what the Von Payments API sends and
 * receives) for display.
 *
 * Not every currency has 2 decimals (JPY has 0, KWD has 3), so dividing by 100
 * shows the wrong figure for those. The number of decimals comes from the SDK's
 * `minorUnitDigits`, which uses the API's own table — the same decimals the API
 * used when it charged the amount. (Your runtime's Intl data can disagree with
 * the API for some currencies, e.g. ISK, so only the symbol comes from Intl.)
 */
export function formatMinorAmount(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const digits = minorUnitDigits(code);
  if (digits === undefined) {
    // Malformed or unrecognised currency code. Show the raw minor units rather than guess.
    return `${amount} ${code} (minor units)`;
  }
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: code,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount / 10 ** digits);
}
