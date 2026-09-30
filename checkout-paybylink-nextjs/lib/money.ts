/**
 * True when this runtime recognises `code` as a real currency. `Intl` does NOT
 * throw on a well-formed but unknown code (e.g. "XYZ"): it quietly assumes 2
 * decimals, which would show a confident wrong amount. So check the runtime's
 * own currency list first, and when a runtime has no such list, trust Intl.
 */
function isKnownCurrency(code: string): boolean {
  const supportedValuesOf = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  return typeof supportedValuesOf !== "function" || supportedValuesOf("currency").includes(code);
}

/**
 * Amounts in the Von Payments API are in MINOR units (e.g. cents).
 *
 * Not every currency has 2 decimals (JPY has 0, KWD has 3), so multiplying or
 * dividing by 100 is wrong for those. Ask the currency data how many decimals
 * the currency uses instead of assuming. Returns null for a malformed currency
 * code (Intl throws on those) and for one this runtime does not recognise.
 */
function currencyDecimals(currency: string): number | null {
  try {
    const code = currency.toUpperCase();
    if (!isKnownCurrency(code)) return null;
    const formatter = new Intl.NumberFormat("en", { style: "currency", currency: code });
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
    // Malformed or unrecognised currency code. Show the raw minor units rather than guess.
    return `${amount} ${code} (minor units)`;
  }
  return new Intl.NumberFormat("en", { style: "currency", currency: code }).format(
    amount / 10 ** exponent,
  );
}

/**
 * Convert an amount typed in major units ("25.00") to minor units (2500) for
 * the API. Returns null when the currency code is malformed or unrecognised, or the input has more
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
