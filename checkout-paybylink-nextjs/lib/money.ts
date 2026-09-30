/**
 * Amounts in the Von Payments API are in MINOR units (e.g. cents).
 *
 * Not every currency has 2 decimals (JPY has 0, KWD has 3), so multiplying or
 * dividing by 100 is wrong for those. Ask the currency data how many decimals
 * the currency uses instead of assuming. Returns null for a malformed currency
 * code (Intl throws on those).
 */
function currencyDecimals(currency: string): number | null {
  try {
    const formatter = new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() });
    return formatter.resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return null;
  }
}

/** Format an amount in minor units for display, e.g. (2500, "USD") → "$25.00". */
export function formatMinorAmount(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const exponent = currencyDecimals(code);
  if (exponent === null) {
    // Not a well-formed currency code (Intl throws). Show the raw minor units rather than guess.
    return `${amount} ${code} (minor units)`;
  }
  return new Intl.NumberFormat("en", { style: "currency", currency: code }).format(
    amount / 10 ** exponent,
  );
}

/**
 * Convert an amount typed in major units ("25.00") to minor units (2500) for
 * the API. Returns null when the currency code is malformed or the input has more
 * decimals than the currency allows (e.g. "1.5" JPY).
 */
export function toMinorAmount(major: string, currency: string): number | null {
  const exponent = currencyDecimals(currency);
  if (exponent === null) return null;
  const value = Number.parseFloat(major);
  if (!Number.isFinite(value)) return null;
  const minor = Math.round(value * 10 ** exponent);
  // Refuse input the currency cannot represent instead of silently rounding it.
  if (Math.abs(minor / 10 ** exponent - value) > 1e-9) return null;
  return minor;
}
