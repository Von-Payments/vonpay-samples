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
 * Format an amount in MINOR units (what the Von Payments API sends and
 * receives) for display.
 *
 * Not every currency has 2 decimals (JPY has 0, KWD has 3), so dividing by 100
 * shows the wrong figure for those. Ask the currency data how many decimals
 * the currency uses instead of assuming.
 */
export function formatMinorAmount(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  let formatter: Intl.NumberFormat;
  try {
    if (!isKnownCurrency(code)) throw new RangeError(`unknown currency ${code}`);
    formatter = new Intl.NumberFormat("en", { style: "currency", currency: code });
  } catch {
    // Malformed (Intl throws) or not a currency this runtime knows. Show the raw minor units rather than guess.
    return `${amount} ${code} (minor units)`;
  }
  const exponent = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amount / 10 ** exponent);
}
