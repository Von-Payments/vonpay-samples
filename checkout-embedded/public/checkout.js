/**
 * Embedded checkout (VORA Mirror) — browser integration.
 *
 * Flow:
 *   1. Fetch the publishable key + amount from our server (/api/config).
 *   2. Ask our server to create a checkout session (/api/create-session).
 *   3. `new Vora({ publishableKey })` — the global `Vora` constructor comes
 *      from the CDN <script> in index.html.
 *   4. `vora.sessions.retrieve(sessionId)` — loads the session + the right
 *      card binder for this merchant.
 *   5. `vora.fields.create("card")` + `card.mount(...)` — renders the card
 *      iframe. The mount handle emits "ready" / "change" events.
 *   6. On submit, `card.tokenize()` resolves to a three-way result:
 *        - { error }   → nothing was charged; show the error, let them retry.
 *        - { token }   → tokenize-only flow; charge the token server-side.
 *        - { charged } → charge-and-save flow; the embed already charged.
 *                        Do NOT charge again — that would double-charge.
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
      "The VORA Mirror SDK failed to load from js.vonpay.com. Check your network and reload.",
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

  // 5. Create + mount the card field. mount() returns a handle that emits
  //    "ready" / "change" events; tokenize() lives on the field itself.
  const card = vora.fields.create("card", {
    style: {
      font: { family: "system-ui, sans-serif", size: "16px" },
      color: { text: "#1f2937", placeholder: "#9ca3af" },
    },
    placeholder: { number: "4242 4242 4242 4242" },
  });

  let mounted;
  try {
    mounted = card.mount("#card-element");
  } catch (err) {
    showStatus("error", `Could not mount the card field: ${escapeHtml(readError(err))}`);
    return;
  }

  // Enable Pay once the field is ready; gate it on validity as they type.
  mounted.on("ready", () => {
    payButton.disabled = false;
  });
  mounted.on("change", (event) => {
    payButton.disabled = !event.complete;
  });

  // 6. Submit → tokenize → branch the three-way result.
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    payButton.disabled = true;
    payButton.textContent = "Processing…";
    clearStatus();

    let result;
    try {
      result = await card.tokenize();
    } catch (err) {
      // The SDK normally returns errors as result.error; this guards the
      // rare path where it throws instead.
      showStatus("error", `Payment failed: ${escapeHtml(readError(err))}`);
      resetButton();
      return;
    }

    // Discriminate in order: error → token → charged.
    if (result.error) {
      // Nothing was charged. Show the error and let the buyer retry.
      showStatus(
        "error",
        `Payment failed (${escapeHtml(result.error.code)}): ${escapeHtml(result.error.message)}`,
      );
      resetButton();
      return;
    }

    if (result.token) {
      // Tokenize-only flow: we hold a vp_pmt_* token. Charge it server-side.
      try {
        const res = await fetch("/api/charge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: result.token }),
        });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error ?? `charge returned ${res.status}`);
        }
        showStatus(
          "success",
          `Charged ${escapeHtml(brandLine(result))}. Payment intent <code>${escapeHtml(body.id)}</code> is <strong>${escapeHtml(body.status)}</strong>.<br />Confirm settlement via the webhook before fulfilling the order.`,
        );
      } catch (err) {
        showStatus("error", `Charge failed: ${escapeHtml(String(err))}`);
        resetButton();
      }
      return;
    }

    if (result.charged) {
      // Charge-and-save flow: the embed already charged the buyer on submit.
      // Do NOT call /api/charge — that would charge them a second time.
      showStatus(
        "pending",
        `Charge submitted${result.last4 ? ` on ${escapeHtml(brandLine(result))}` : ""}. The card was charged during submit; confirm settlement via the webhook before fulfilling the order.`,
      );
      payButton.textContent = "Submitted";
      return;
    }

    // Defensive: a result with none of error/token/charged is a contract
    // violation we should surface rather than silently swallow.
    showStatus("error", "Unexpected empty result from tokenize(). See the console.");
    console.error("tokenize() returned an unrecognized shape:", result);
    resetButton();
  });

  function resetButton() {
    payButton.disabled = false;
    payButton.textContent = `Pay ${formatAmount(config.amount, config.currency)}`;
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

function formatAmount(minor, currency) {
  if (typeof minor !== "number") return "";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency ?? "USD",
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency ?? ""}`.trim();
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

main();
