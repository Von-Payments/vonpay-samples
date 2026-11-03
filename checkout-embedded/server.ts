/**
 * Von Payments — Embedded checkout (Embedded Fields) sample server.
 *
 * Embedded Fields is the embedded card-collection path: the buyer stays on
 * your domain and the card field is rendered inside a Von Payments-owned
 * iframe loaded from the browser SDK at https://js.vonpay.com/v1/vora.js.
 * Sensitive card data never touches this server or your DOM.
 *
 * This server does the one thing an Embedded Fields integration needs a
 * backend for: it creates a checkout session with your SECRET key so the
 * browser never sees it. The browser then retrieves the session with the
 * PUBLISHABLE key and mounts the card field. The routes live in app.ts:
 *
 *   POST /api/create-session   Calls sessions.create() with the secret key.
 *                              Returns { session_id }: the publishable
 *                              `vp_cs_*` id is safe to hand to the browser.
 *                              Also sets an httpOnly cookie that ties this
 *                              browser to its checkout on this server.
 *
 *   POST /api/charge           Charges a `vp_pmt_*` token server-side via
 *                              paymentIntents.create(), for the checkout the
 *                              cookie names, at most once. ONLY called on the
 *                              tokenize-only flow (when submit returns a
 *                              token). On the charge-and-save flow the embed
 *                              already charged the buyer, so the browser
 *                              does NOT call this. See public/checkout.js.
 *
 * Static files in ./public are served as-is. Open http://localhost:4000.
 *
 * Required env (see .env.example):
 *   VON_PAY_SECRET_KEY        vp_sk_test_* or vp_sk_live_* (server-only)
 *   VON_PAY_PUBLISHABLE_KEY   vp_pk_test_* or vp_pk_live_* (sent to browser)
 *   PORT                      defaults to 4000
 *   VON_PAY_API_BASE          defaults to the SDK's built-in base
 *   VON_PAY_TRUST_PROXY       optional; Express `trust proxy` (hop count) when
 *                             a TLS-terminating proxy you run sits in front
 */

import { VonPayCheckout } from "@vonpay/checkout-node";
import { createApp } from "./app.js";

const SECRET_KEY = process.env.VON_PAY_SECRET_KEY;
const PUBLISHABLE_KEY = process.env.VON_PAY_PUBLISHABLE_KEY;
const PORT = Number.parseInt(process.env.PORT ?? "4000", 10);
const API_BASE = process.env.VON_PAY_API_BASE;

if (!SECRET_KEY) {
  console.error(
    "Missing VON_PAY_SECRET_KEY. Copy .env.example to .env and fill it in.",
  );
  process.exit(1);
}
if (!PUBLISHABLE_KEY) {
  console.error(
    "Missing VON_PAY_PUBLISHABLE_KEY. Copy .env.example to .env and fill it in.",
  );
  process.exit(1);
}

// Express `trust proxy`: unset (off) when browsers reach this server directly.
// Behind a TLS-terminating proxy you run, set VON_PAY_TRUST_PROXY to its hop
// count (e.g. 1) so the checkout cookie is marked Secure. See AppDeps.trustProxy.
const TRUST_PROXY_ENV = process.env.VON_PAY_TRUST_PROXY;
const TRUST_PROXY =
  TRUST_PROXY_ENV === undefined || TRUST_PROXY_ENV === ""
    ? false
    : /^\d+$/.test(TRUST_PROXY_ENV)
      ? Number(TRUST_PROXY_ENV)
      : TRUST_PROXY_ENV;

const vonpay = new VonPayCheckout(
  API_BASE ? { apiKey: SECRET_KEY, baseUrl: API_BASE } : SECRET_KEY,
);

createApp({
  client: vonpay,
  publishableKey: PUBLISHABLE_KEY,
  apiBase: API_BASE,
  trustProxy: TRUST_PROXY,
}).listen(PORT, () => {
  console.log(`Embedded checkout sample running at http://localhost:${PORT}`);
});
