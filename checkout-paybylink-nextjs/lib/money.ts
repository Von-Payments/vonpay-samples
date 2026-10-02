// ── Currency decimals ────────────────────────────────────────────────
// The SAME table as `minorUnitDigits` in @vonpay/checkout-node (the API's own
// decimals). It is copied here because this code also runs in the browser,
// where the server SDK cannot be imported. Keep it identical to the SDK's.
//
// Real currency codes: active ISO 4217 codes that have a minor unit.
const CURRENCY_CODES: ReadonlySet<string> = new Set([
  "AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD",
  "BDT", "BHD", "BIF", "BMD", "BND", "BOB", "BOV", "BRL", "BSD", "BTN", "BWP",
  "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CLF", "CLP", "CNY", "COP",
  "COU", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN",
  "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ",
  "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK",
  "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD",
  "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD",
  "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN",
  "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP",
  "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR",
  "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP",
  "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH",
  "UGX", "USD", "USN", "UYI", "UYU", "UYW", "UZS", "VED", "VES", "VND", "VUV",
  "WST", "XAD", "XAF", "XCD", "XCG", "XOF", "XPF", "YER", "ZAR", "ZMW", "ZWG",
]);
// Codes whose decimals are not settled yet (the API's table and ISO 4217
// disagree, and Von Payments is confirming which one the payment processor
// applies). Never guess money: these are treated as unknown.
const DISPUTED: ReadonlySet<string> = new Set([
  "CLF", "IQD", "ISK", "LYD", "MGA", "UYI", "UYW",
]);
// The API's 0- and 3-decimal currencies; every other code is 2.
const ZERO_DECIMAL: ReadonlySet<string> = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF",
  "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);
const THREE_DECIMAL: ReadonlySet<string> = new Set([
  "BHD", "JOD", "KWD", "OMR", "TND",
]);

/**
 * How many decimals the Von Payments API uses for `currency` (2 for USD, 0 for
 * JPY, 3 for KWD), or null for a code that is not a real currency or whose
 * decimals are not settled (DISPUTED). Runtime Intl data is NOT used: it
 * disagrees with the API for some currencies (HUF, COP, …), and a confident
 * wrong answer here mis-states a charge.
 */
function currencyDecimals(currency: string): number | null {
  const code = currency.toUpperCase();
  if (!CURRENCY_CODES.has(code)) return null;
  if (DISPUTED.has(code)) return null;
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/** Format an amount in minor units for display, e.g. (2500, "USD") → "$25.00". */
export function formatMinorAmount(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const exponent = currencyDecimals(code);
  if (exponent === null) {
    // Malformed or unrecognised currency code. Show the raw minor units rather than guess.
    return `${amount} ${code} (minor units)`;
  }
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: code,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(amount / 10 ** exponent);
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
