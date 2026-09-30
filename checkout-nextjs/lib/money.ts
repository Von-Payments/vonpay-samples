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
    formatter = new Intl.NumberFormat("en", { style: "currency", currency: code });
  } catch {
    // Not a well-formed currency code (Intl throws). Show the raw minor units rather than guess.
    return `${amount} ${code} (minor units)`;
  }
  const exponent = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amount / 10 ** exponent);
}
