// Browser side of the funnel sample. Plain JavaScript, no build step: copy it
// into any funnel page. The browser collects the card and shows what the
// SERVER read; it never decides an amount and never reads a result from the URL.
"use strict";

const $ = (id) => document.getElementById(id);
// ⚠ Two-decimal currencies (USD) only: a zero-decimal currency (JPY, KRW) or a
// three-decimal one (KWD) needs that currency's own exponent, not `/ 100`.
const money = (minor, currency) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);

/** The page's own words for a decline: the API's wording is never shown raw. */
const DECLINE_TEXT = {
  card_declined: "Your card was declined. Try another card.",
  insufficient_funds: "Your card was declined. Try another card.",
  expired_card: "This card has expired. Try another card.",
};
const declineText = (code) => DECLINE_TEXT[code] || "The payment did not go through. Try another card.";

/** Call this sample's server. Throws with `outcomeUnknown` when money may have moved. */
async function api(path, body) {
  let res;
  try {
    res = await fetch(path, body === undefined ? undefined : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // A network failure after the request left can mean the charge happened.
    throw Object.assign(new Error("The connection dropped."), { outcomeUnknown: true });
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    if (res.ok) throw Object.assign(new Error("The server's answer could not be read."), { outcomeUnknown: true });
  }
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `HTTP ${res.status}`), {
      code: data.code,
      outcomeUnknown: data.outcome_unknown === true || res.status >= 500,
    });
  }
  return data;
}

let vora = null;

function show(step) {
  for (const id of ["order-step", "add-on-step", "done-step"]) $(id).hidden = id !== step;
}

function done(title, text) {
  $("done-title").textContent = title;
  $("done-text").textContent = text;
  show("done-step");
}

/** Never say "failed" while the server cannot tell whether money moved. */
function unknownOutcome() {
  done(
    "We are checking your payment",
    // Your store sends the real confirmation (from the payment webhook: see
    // samples/webhooks-node). This sample sends none, so it promises none.
    "We could not confirm the result yet. Please do not pay again.",
  );
}

function offerAddOn(offer) {
  $("add-on-text").textContent = `Add ${offer.name} for ${money(offer.amount_minor, offer.currency)}, charged to the card you just used. One click, nothing to type.`;
  show("add-on-step");
}

/** Render the server's answer for the main charge. `canRetry`: the card fields are on the page. */
function afterMainCharge(r, canRetry = true) {
  if (r.outcome === "requires_action" && r.next_action) return vora.redirectToChallenge(r.next_action);
  if (r.outcome === "paid" && r.add_on_offer) return offerAddOn(r.add_on_offer);
  if (r.outcome === "paid") return done("Thank you! Your order is paid.", "");
  if ((r.outcome === "failed" || r.outcome === "not_paid") && !canRetry) {
    // Back from a failed bank check: drop the return marker and open a fresh
    // order on the same page, so the shopper can try another card.
    history.replaceState(null, "", location.pathname);
    return startOrder().then(() => {
      $("order-error").textContent = declineText(r.decline_code);
    });
  }
  if (r.outcome === "failed") {
    $("order-error").textContent = declineText(r.decline_code);
    $("pay").disabled = false;
    return undefined;
  }
  return unknownOutcome(); // held / pending: not final yet
}

function afterAddOn(r) {
  if (r.outcome === "requires_action" && r.next_action) return vora.redirectToChallenge(r.next_action);
  if (r.outcome === "paid") return done("Added! Thank you.", "Both items are on your order.");
  if (r.outcome === "failed") return done("Your order is paid.", "The add-on could not be charged, so it was not added.");
  return unknownOutcome();
}

async function startOrder() {
  const order = await api("/api/order", {});
  $("offer-name").textContent = order.offer.name;
  $("offer-price").textContent = money(order.offer.amount_minor, order.offer.currency);
  // The server's words, shown in full next to the button.
  $("terms").textContent = order.terms;

  await vora.sessions.retrieve(order.session_id);

  // The page's own wording is the shopper's agreement to keep the card for
  // later use. Read once, here. Never a pre-ticked box.
  const collection = vora.elements.create({ setupForFutureUse: "off_session" });
  const style = { font: { family: "system-ui, sans-serif", size: "16px" } };
  const fields = {
    "card-number": collection.create("card-number", { showIcon: true, style }),
    "card-expiry": collection.create("card-expiry", { style }),
    "card-cvc": collection.create("card-cvc", { style }),
  };
  const complete = { "card-number": false, "card-expiry": false, "card-cvc": false };
  for (const [type, el] of Object.entries(fields)) {
    el.on("change", (e) => {
      complete[type] = e.complete;
      $("pay").disabled = !Object.values(complete).every(Boolean);
      $("order-error").textContent = e.error ? e.error.message : "";
    });
    el.mount(`#${type}`);
  }

  let paying = false;
  $("pay").addEventListener("click", async () => {
    if (paying) return; // a double click must not save or charge twice
    paying = true;
    // When the shopper pressed the button, by this browser's clock. The server
    // keeps it as reported, next to its own time; it is not proof on its own.
    const pressedAt = new Date().toISOString();
    $("pay").disabled = true;
    $("order-error").textContent = "";
    try {
      const result = await collection.submit();
      if (result.error) {
        $("order-error").textContent = result.error.message;
        $("pay").disabled = false;
        return;
      }
      // This session only saves the card (chargeAtSubmit: false). If it ever
      // reports a charge, never charge again: ask the server what it reads.
      if (result.charged !== undefined) {
        afterMainCharge((await api("/api/outcome")).main);
        return;
      }
      if (!result.token) {
        $("order-error").textContent = "Your card could not be saved. Please try again.";
        $("pay").disabled = false;
        return;
      }
      try {
        afterMainCharge(await api("/api/charge", { token: result.token, pressed_at: pressedAt }));
      } catch (err) {
        if (!err.outcomeUnknown) {
          $("order-error").textContent = err.message;
          $("pay").disabled = false;
          return;
        }
        try {
          afterMainCharge((await api("/api/outcome")).main);
        } catch {
          unknownOutcome();
        }
      }
    } finally {
      paying = false;
    }
  });
}

function wireAddOn() {
  let charging = false;
  $("add-on-yes").addEventListener("click", async () => {
    if (charging) return;
    charging = true;
    $("add-on-yes").disabled = true;
    $("add-on-no").disabled = true;
    try {
      afterAddOn(await api("/api/add-on", { offer_id: "refill-pack" }));
    } catch (err) {
      if (!err.outcomeUnknown) {
        done("Your order is paid.", "The add-on was not added.");
        return;
      }
      try {
        afterAddOn((await api("/api/outcome")).add_on);
      } catch {
        unknownOutcome();
      }
    }
  });
  $("add-on-no").addEventListener("click", () => done("Thank you! Your order is paid.", ""));
}

/** Back from the bank's 3-D Secure page: ask the server, never the URL. */
async function resume() {
  const o = await api("/api/outcome");
  if (o.add_on.outcome !== "not_paid") return afterAddOn(o.add_on);
  if (o.main.outcome === "paid" && o.add_on_offer) return offerAddOn(o.add_on_offer);
  return afterMainCharge(o.main, false);
}

(async () => {
  wireAddOn();
  try {
    const config = await api("/api/config");
    vora = new window.Vora({
      publishableKey: config.publishable_key,
      ...(config.api_base ? { apiBaseUrl: config.api_base } : {}),
    });
    if (new URLSearchParams(location.search).has("vonpay_return")) await resume();
    else await startOrder();
  } catch (err) {
    $("order-error").textContent = err.message || String(err);
  }
})();
