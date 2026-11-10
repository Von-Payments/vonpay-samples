/**
 * Funnel sample: reads the environment, builds the SDK client, serves the page
 * in `public/` and the routes in `server/app.ts`.
 *
 * Env vars (see .env.example):
 *   VONPAY_SECRET_KEY        vp_sk_test_* (or vp_sk_live_*). Required.
 *   VONPAY_PUBLISHABLE_KEY   vp_pk_test_* for the same account. Required.
 *   VONPAY_API_BASE          Optional. Unset = https://checkout.vonpay.com (a
 *                            test key runs in sandbox mode there).
 *   VONPAY_RETURN_URL        Where the bank's 3-D Secure page sends the shopper
 *                            back. Default http://localhost:4242/?vonpay_return=1
 *                            (localhost is accepted on test keys only).
 *   STORED_CREDENTIAL_USE    Optional: recurring | installment | unscheduled.
 *                            What the saved card is for later (see README).
 *   PORT                     Default 4242.
 *   VONPAY_TRUST_PROXY       Optional Express `trust proxy` hop count, only
 *                            behind a TLS-terminating proxy you run.
 *   NODE_ENV=production      Marks the order cookie Secure on every response.
 *
 * ⛔ Not safe to deploy as-is: see "Before you go live" in the README.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { VonPayCheckout, type MITReason } from "@vonpay/checkout-node";
import { DEFAULT_TERMS, createApp, termsMentionLaterCharges } from "./app.js";

const SECRET_KEY = process.env.VONPAY_SECRET_KEY;
const PUBLISHABLE_KEY = process.env.VONPAY_PUBLISHABLE_KEY ?? "";
const API_BASE = process.env.VONPAY_API_BASE?.replace(/\/+$/, "") || undefined;
const PORT = Number(process.env.PORT ?? "4242");
const RETURN_URL = process.env.VONPAY_RETURN_URL ?? `http://localhost:${PORT}/?vonpay_return=1`;

const USES: readonly MITReason[] = ["recurring", "installment", "unscheduled"];
const USE_ENV = process.env.STORED_CREDENTIAL_USE?.trim() || undefined;
if (USE_ENV !== undefined && !(USES as readonly string[]).includes(USE_ENV)) {
  // eslint-disable-next-line no-console
  console.error(`STORED_CREDENTIAL_USE must be one of ${USES.join(", ")} (got "${USE_ENV}").`);
  process.exit(2);
}
const STORED_CREDENTIAL_USE = USE_ENV as MITReason | undefined;

const TRUST_PROXY_ENV = process.env.VONPAY_TRUST_PROXY;
const TRUST_PROXY =
  TRUST_PROXY_ENV === undefined || TRUST_PROXY_ENV === ""
    ? false
    : /^\d+$/.test(TRUST_PROXY_ENV)
      ? Number(TRUST_PROXY_ENV)
      : TRUST_PROXY_ENV;

const vonpay = SECRET_KEY
  ? new VonPayCheckout({ apiKey: SECRET_KEY, ...(API_BASE ? { baseUrl: API_BASE } : {}) })
  : null;
if (vonpay === null || PUBLISHABLE_KEY === "") {
  // eslint-disable-next-line no-console
  console.warn("[funnel-one-click] Set VONPAY_SECRET_KEY and VONPAY_PUBLISHABLE_KEY in .env, then restart.");
}

// Agreement and declaration go together: words that promise later charges,
// with no declaration of what the saved card is for, make the later charges
// carry no stored-credential lineage (they may be declined).
if (STORED_CREDENTIAL_USE === undefined && termsMentionLaterCharges(DEFAULT_TERMS)) {
  // eslint-disable-next-line no-console
  console.warn(
    "[funnel-one-click] ⚠ The order-button terms mention later charges, but STORED_CREDENTIAL_USE is not set, " +
      "so no declaration of what the saved card is for reaches the card networks. Set it (recurring | installment | " +
      "unscheduled) to match your offer, or change the terms if there are no later charges. " +
      "See https://docs.vonpay.com/guides/recurring-and-saved-cards#step-2--declare-what-the-stored-card-is-for",
  );
}

const app = createApp({
  client: vonpay,
  returnUrl: RETURN_URL,
  publishableKey: PUBLISHABLE_KEY,
  ...(API_BASE ? { browserApiBase: API_BASE } : {}),
  ...(STORED_CREDENTIAL_USE ? { storedCredentialUse: STORED_CREDENTIAL_USE } : {}),
  trustProxy: TRUST_PROXY,
});
app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), "..", "public")));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[funnel-one-click] http://localhost:${PORT}  (API: ${API_BASE ?? "https://checkout.vonpay.com"})`);
});
