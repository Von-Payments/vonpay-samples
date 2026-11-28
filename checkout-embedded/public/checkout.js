/**
 * Embedded checkout (Embedded Fields) — browser integration.
 *
 * Flow:
 *   1. Fetch the publishable key + amount from our server (/api/config).
 *   2. Ask our server to create a checkout session (/api/create-session).
 *   3. `new Vora({ publishableKey })` — the global `Vora` constructor comes
 *      from the CDN <script> in index.html.
 *   4. `vora.sessions.retrieve(sessionId)` — loads the session + the right
 *      card binder for this merchant.
 *   5. `vora.elements.create()` → `elements.create("card", { style })` +
 *      `card.mount(...)` — renders the card iframe. The card emits "ready" /
 *      "change" events.
 *   6. On submit, `elements.submit()` resolves to a three-way result:
 *        - { error }   → nothing was charged; show the error, let them retry.
 *        - { token }   → tokenize-only flow; charge the token server-side.
 *                        Only when the result has NO `chargeStatus`.
 *        - { charged } → charge-and-save flow; the embed already charged.
 *                        Do NOT charge again — that would double-charge.
 *      A result WITH a `chargeStatus` means the embed already charged, held
 *      or started this payment at submit (its token, if any, was used):
 *      never charge it again from the server. It is one of: waiting on a
 *      3-D Secure check (`requires_action`), authorized and held
 *      (`succeeded` + `charged: false`; your server captures it), or still
 *      settling / not confirmed (wait for the webhook).
 *      After any payment is placed, Pay stays off for this checkout.
 *
 * The client result is a UX signal only. Confirm settlement server-side
 * via the Von Payments webhook before fulfilling the order.
 */

const statusEl = document.getElementById("status");
const payButton = document.getElementById("pay");
const form = document.getElementById("checkout-form");

function showStatus(kind, html) {
  statusEl.className = `status show ${kind}`;
  statusEl.innerHTML = html;
}

function clearStatus() {
  statusEl.className = "status";
  statusEl.innerHTML = "";
}

async function main() {
  // The CDN script attaches `Vora` to the window. If it didn't load
  // (blocked, offline), fail loudly rather than throwing a vague
  // "Vora is not defined" later.
  if (typeof window.Vora !== "function") {
    showStatus(
      "error",
      "The Embedded Fields SDK failed to load from js.vonpay.com. Check your network and reload.",
    );
    return;
  }

  // 1. Config (publishable key + amount + optional API base).
  let config;
  try {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error(`/api/config returned ${res.status}`);
    config = await res.json();
  } catch (err) {
    showStatus("error", `Could not load checkout config: ${escapeHtml(String(err))}`);
    return;
  }

  // 2. Create a session on our server (secret key never reaches us here).
  let sessionId;
  try {
    const res = await fetch("/api/create-session", { method: "POST" });
    const body = await res.json();
    if (!res.ok || !body.session_id) {
      throw new Error(body.error ?? `create-session returned ${res.status}`);
    }
    sessionId = body.session_id;
  } catch (err) {
    showStatus("error", `Could not create a session: ${escapeHtml(String(err))}`);
    return;
  }

  // 3. Initialize the SDK with the publishable key.
  const voraOptions = { publishableKey: config.publishableKey };
  if (config.apiBase) voraOptions.apiBaseUrl = config.apiBase;
  const vora = new window.Vora(voraOptions);

  // 4. Retrieve the session — loads the card binder for this merchant.
  try {
    await vora.sessions.retrieve(sessionId);
  } catch (err) {
    showStatus("error", `Could not load the session: ${escapeHtml(readError(err))}`);
    return;
  }

  // 5. Create the elements collection, then the card in it, and mount it.
  //    The card emits "ready" / "change" events; the collection submits it.
  const elements = vora.elements.create();
  const card = elements.create("card", {
    style: {
      font: { family: "system-ui, sans-serif", size: "16px" },
      color: { text: "#1f2937", placeholder: "#9ca3af" },
    },
    // A neutral placeholder: a real buyer sees this too, so it is not a test card.
    placeholder: { number: "1234 1234 1234 1234" },
  });

  try {
    card.mount("#card-element");
  } catch (err) {
    showStatus("error", `Could not mount the card field: ${escapeHtml(readError(err))}`);
    return;
  }

  // Once a payment is placed (charged, held, waiting on the bank, or of
  // unknown outcome), Pay stays off for this checkout. `locked` makes the card's
  // "ready" / "change" events unable to turn it back on: a buyer who edits the
  // still-mounted card after a terminal result must not get a second submit.
  // Only resetButton() (a result where nothing was charged) clears it.
  let locked = false;
  function lockPay(text) {
    locked = true;
    payButton.disabled = true;
    payButton.textContent = text;
  }

  // Enable Pay once the field is ready; gate it on validity as they type.
  card.on("ready", () => {
    if (!locked) payButton.disabled = false;
  });
  card.on("change", (event) => {
    if (!locked) payButton.disabled = !event.complete;
  });

  // 6. Submit → branch the three-way result.
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (locked) return;
    payButton.disabled = true;
    payButton.textContent = "Processing…";
    clearStatus();

    let result;
    try {
      result = await elements.submit();
    } catch (err) {
      // The SDK normally returns errors as result.error; this guards the
      // rare path where it throws instead.
      showStatus("error", `Payment failed: ${escapeHtml(readError(err))}`);
      resetButton();
      return;
    }

    // Discriminate in order: error → already charged at submit → token.
    if (result.error) {
      // No charge was made by this attempt.
      const finished = result.error.code === "frame_payment_declined" && result.error.retryable === false;
      showStatus(
        "error",
        `Payment failed (${escapeHtml(result.error.code)}): ${escapeHtml(result.error.message)}${finished ? " This checkout cannot take another payment." : ""}`,
      );
      if (finished) {
        // A decline that ended the session: the SDK refuses a resubmit, so do
        // not offer Pay again. A real shop starts a new checkout for its order.
        lockPay("Checkout ended");
        return;
      }
      resetButton();
      return;
    }

    if (result.charged === true) {
      // Charge-and-save flow: the embed already charged the buyer on submit.
      // A token may come back too (the card was also saved). Do NOT call
      // /api/charge — that would charge them a second time.
      showStatus(
        "pending",
        `Charge submitted${result.last4 ? ` on ${escapeHtml(brandLine(result))}` : ""}. The card was charged during submit; confirm settlement via the webhook before fulfilling the order.`,
      );
      lockPay("Submitted");
      return;
    }

    if (result.chargeStatus === "requires_action") {
      // The bank wants a 3-D Secure check before the charge made at submit can
      // finish. Nothing is charged yet. This sample has no page for the bank
      // to send the buyer back to, so it does not send the buyer there. A real
      // integration sends the buyer to result.redirectUrl
      // (window.location.href = result.redirectUrl) and confirms the outcome
      // on the charge.* webhook when they return, never on the return alone.
      // Do not offer Pay again: this checkout already has a payment waiting
      // on that check.
      showStatus(
        "error",
        "Your bank wants to verify this payment (3-D Secure). This sample cannot complete a bank check, so the payment was not finished. Use a card that needs no check, or see the payment-intents-3ds sample.",
      );
      lockPay("Bank check needed");
      return;
    }

    if (result.chargeStatus === "succeeded" && result.charged === false) {
      // AUTHORIZED AND HELD (a session created with captureMethod: "manual").
      // The funds are reserved on the card; nothing is taken until YOUR server
      // captures the payment intent. No webhook fires for a hold: this result
      // is the signal. Before capturing, read the payment intent with your
      // secret key and check its metadata.session_id is this checkout's
      // session (the id came through the buyer's browser). Capture promptly:
      // a hold lapses after about 7 days. Any token here was used in the hold.
      showStatus(
        "success",
        `Payment authorized${result.last4 ? ` on ${escapeHtml(brandLine(result))}` : ""} and held${result.paymentIntentId ? ` (payment intent <code>${escapeHtml(result.paymentIntentId)}</code>)` : ""}. Nothing is taken until the shop captures it.`,
      );
      lockPay("Authorized");
      return;
    }

    if (result.chargeStatus !== undefined || result.charged !== undefined || result.recovered === true) {
      // The embed charged at submit and the payment is still settling, or the
      // SDK has no yes / no on whether money moved. Any token on this result
      // was already used in that charge. Never charge it again; the webhook
      // (or a server-side read) has the outcome.
      showUnknownOutcome();
      return;
    }

    if (result.token) {
      // Tokenize-only flow: we hold a vp_pmt_* token and no charge has run.
      // Charge it server-side.
      try {
        const res = await fetch("/api/charge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: result.token }),
        });
        const body = await res.json();
        if (!res.ok) {
          if (body.outcome_unknown === true) {
            // The server cannot say whether money moved (or this checkout
            // already has a payment). Do NOT offer Pay again: a second
            // attempt could charge the buyer twice.
            showUnknownOutcome();
            return;
          }
          throw new Error(body.error ?? `charge returned ${res.status}`);
        }
        if (body.outcome === "failed") {
          // Declined: nothing to fulfil, and the buyer may try another card.
          showStatus("error", "The card was declined. Try another card.");
          resetButton();
          return;
        }
        if (body.outcome === "requires_action") {
          // The bank wants a 3-D Secure check. This sample has no page for
          // the bank to send the buyer back to, so it cannot finish one. Say
          // so plainly, and do not offer Pay again: this checkout already has
          // a payment waiting on that check. (A real integration sends a
          // return URL with the charge and redirects the buyer to the bank:
          // see the payment-intents-3ds sample.)
          showStatus(
            "error",
            "Your bank wants to verify this payment (3-D Secure). This sample cannot complete a bank check, so the payment was not finished. Use a card that needs no check, or see the payment-intents-3ds sample.",
          );
          lockPay("Bank check needed");
          return;
        }
        showStatus(
          body.outcome === "paid" ? "success" : "pending",
          `Payment on ${escapeHtml(brandLine(result))}: <strong>${escapeHtml(body.outcome)}</strong> (payment intent <code>${escapeHtml(body.intent_id)}</code>).<br />Confirm settlement via the webhook before fulfilling the order.`,
        );
        lockPay("Submitted");
      } catch (err) {
        // The request or its answer was lost on the way. The server may have
        // charged the card, so do not offer Pay again on this page.
        console.error("charge request failed:", err);
        showUnknownOutcome();
      }
      return;
    }

    // Defensive: anything else (a shape this page does not know, or a
    // card-update `status: "card_collected"` result, which this sample's
    // sessions never produce) is surfaced, and Pay stays off: an unknown
    // shape could be a payment.
    showStatus("error", "Unexpected result from submit(). Check the payment in your dashboard before trying again. See the console.");
    console.error("elements.submit() returned an unrecognized shape:", result);
    lockPay("Check the dashboard");
  });

  function resetButton() {
    locked = false;
    payButton.disabled = false;
    payButton.textContent = `Pay ${formatAmount(config.amount, config.currency)}`;
  }

  function showUnknownOutcome() {
    showStatus(
      "pending",
      "We could not confirm whether this payment went through. Please do not pay again. The webhook (or your dashboard) has the result.",
    );
    lockPay("Result pending");
  }
}

function brandLine(result) {
  if (result.brand && result.last4) return `${result.brand} ending ${result.last4}`;
  if (result.last4) return `card ending ${result.last4}`;
  return "the card";
}

function readError(err) {
  // FrameError carries a .code + .message; fall back for plain errors.
  if (err && typeof err === "object" && "message" in err) {
    const code = "code" in err && err.code ? `${err.code}: ` : "";
    return `${code}${err.message}`;
  }
  return String(err);
}

// ── Currency decimals ────────────────────────────────────────────────
// The SAME table as `minorUnitDigits` in @vonpay/checkout-node (the API's own
// decimals). It is copied here because this code also runs in the browser,
// where the server SDK cannot be imported. Keep it identical to the SDK's.
//
// Real currency codes: active ISO 4217 codes that have a minor unit.
const CURRENCY_CODES = new Set([
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
const DISPUTED = new Set([
  "CLF", "IQD", "ISK", "LYD", "MGA", "UYI", "UYW",
]);
// The API's 0- and 3-decimal currencies; every other code is 2.
const ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF",
  "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);
const THREE_DECIMAL = new Set([
  "BHD", "JOD", "KWD", "OMR", "TND",
]);

// Decimals the API uses for `code`, or null when it is not a real currency.
function currencyDecimals(code) {
  if (!CURRENCY_CODES.has(code)) return null;
  if (DISPUTED.has(code)) return null;
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

// `minor` is in MINOR units, as the API sends it. Not every currency has 2
// decimals (JPY has 0, KWD has 3), so use the API's own decimals (above)
// instead of dividing by 100 — and not Intl's, which disagree for some.
function formatAmount(minor, currency) {
  if (typeof minor !== "number") return "";
  const code = (currency ?? "USD").toUpperCase();
  const exponent = currencyDecimals(code);
  if (exponent === null) {
    // Not a currency code we know. Show the raw minor units rather than guess.
    return `${minor} ${code} (minor units)`;
  }
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: code,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(minor / 10 ** exponent);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

main();
