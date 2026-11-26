/**
 * Funnel sample: reads the environment, builds the SDK client, serves the page
 * in `public/` and the routes in `server/app.ts`.
 *
 * Env vars (see .env.example):
 *   VON_PAY_SECRET_KEY       vp_sk_test_* (or vp_sk_live_*). Required.
 *   VON_PAY_PUBLISHABLE_KEY  vp_pk_test_* for the same account. Required.
 *   VON_PAY_BASE_URL         Optional. Unset = https://checkout.vonpay.com (a
 *                            test key runs in sandbox mode there).
 *   VON_PAY_RETURN_URL       Where the bank's 3-D Secure page sends the shopper
 *                            back. Default http://localhost:4242/?vonpay_return=1
 *                            (localhost is accepted on test keys only).
 *   STORED_CREDENTIAL_USE    Optional: recurring | installment | unscheduled.
 *                            What the saved card is for later (see README).
 *   PORT                     Default 4242.
 *   VON_PAY_TRUST_PROXY      Optional Express `trust proxy` hop count, only
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
import { cspFileBeside, keyModeOf, loadVoraCsp, pinnedVoraOf } from "./vora-csp.js";

const SECRET_KEY = process.env.VON_PAY_SECRET_KEY;
const PUBLISHABLE_KEY = process.env.VON_PAY_PUBLISHABLE_KEY ?? "";
const API_BASE = process.env.VON_PAY_BASE_URL?.replace(/\/+$/, "") || undefined;
const PORT = Number(process.env.PORT ?? "4242");
const RETURN_URL = process.env.VON_PAY_RETURN_URL ?? `http://localhost:${PORT}/?vonpay_return=1`;

const USES: readonly MITReason[] = ["recurring", "installment", "unscheduled"];
const USE_ENV = process.env.STORED_CREDENTIAL_USE?.trim() || undefined;
if (USE_ENV !== undefined && !(USES as readonly string[]).includes(USE_ENV)) {
  // eslint-disable-next-line no-console
  console.error(`STORED_CREDENTIAL_USE must be one of ${USES.join(", ")} (got "${USE_ENV}").`);
  process.exit(2);
}
const STORED_CREDENTIAL_USE = USE_ENV as MITReason | undefined;

const TRUST_PROXY_ENV = process.env.VON_PAY_TRUST_PROXY;
const TRUST_PROXY =
  TRUST_PROXY_ENV === undefined || TRUST_PROXY_ENV === ""
    ? false
    : /^\d+$/.test(TRUST_PROXY_ENV)
      ? Number(TRUST_PROXY_ENV)
      : TRUST_PROXY_ENV;

// The old names (before every sample moved to VON_PAY_*): say so instead of
// starting with no key.
const RENAMED = ["SECRET_KEY", "PUBLISHABLE_KEY", "RETURN_URL", "TRUST_PROXY"].filter(
  (name) => process.env[`VONPAY_${name}`] !== undefined && process.env[`VON_PAY_${name}`] === undefined,
);
if (process.env.VONPAY_API_BASE !== undefined && process.env.VON_PAY_BASE_URL === undefined) RENAMED.push("API_BASE");
if (RENAMED.length > 0) {
  // eslint-disable-next-line no-console
  console.error(
    `[funnel-one-click] These settings were renamed: ${RENAMED.map((n) => `VONPAY_${n} → ${n === "API_BASE" ? "VON_PAY_BASE_URL" : `VON_PAY_${n}`}`).join(", ")}. Rename them in .env.`,
  );
  process.exit(2);
}

// ⛔ The API host is also handed to the browser (`/api/config` → `new Vora({
// apiBaseUrl })`), so only a Von Payments host, or this machine on a test key,
// is accepted. Anything else could point the buyer's card page at a server
// you do not run.
const ALLOWED_API_HOSTS = new Set(["checkout.vonpay.com", "checkout-staging.vonpay.com"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
function apiBaseProblem(value: string, secretKey: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL";
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    return "must be an origin only (scheme, host and port)";
  }
  if (url.protocol === "https:" && url.port === "" && ALLOWED_API_HOSTS.has(url.hostname)) return null;
  if (LOCAL_HOSTS.has(url.hostname) && secretKey.startsWith("vp_sk_test_")) return null;
  return "must be https://checkout.vonpay.com or https://checkout-staging.vonpay.com (or localhost on a test key)";
}
if (API_BASE !== undefined) {
  const problem = apiBaseProblem(API_BASE, SECRET_KEY ?? "");
  if (problem !== null) {
    // eslint-disable-next-line no-console
    console.error(`[funnel-one-click] VON_PAY_BASE_URL ${problem}.`);
    process.exit(2);
  }
}

const vonpay = SECRET_KEY
  ? new VonPayCheckout({ apiKey: SECRET_KEY, ...(API_BASE ? { baseUrl: API_BASE } : {}) })
  : null;
if (vonpay === null || PUBLISHABLE_KEY === "") {
  // eslint-disable-next-line no-console
  console.warn("[funnel-one-click] Set VON_PAY_SECRET_KEY and VON_PAY_PUBLISHABLE_KEY in .env, then restart.");
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

// The page's Content Security Policy, from public/csp.json: the published list
// for the vora.js version public/index.html pins (checked against the hash
// pinned on the same script tag), test or live list by the key's mode. No
// network. If it cannot be read or does not match, refuse to start: see
// vora-csp.ts.
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
let contentSecurityPolicy: string;
try {
  const page = join(PUBLIC_DIR, "index.html");
  contentSecurityPolicy = loadVoraCsp({
    ...pinnedVoraOf(page),
    cspFile: cspFileBeside(page),
    mode: keyModeOf(SECRET_KEY || PUBLISHABLE_KEY),
    apiOrigin: API_BASE ? new URL(API_BASE).origin : undefined,
  });
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(
    `[funnel-one-click] Could not build the page's Content Security Policy: ${err instanceof Error ? err.message : String(err)}. ` +
      "The server will not start without it. Check the keys, and that public/csp.json is the file for the vora.js version public/index.html pins.",
  );
  process.exit(2);
}

const app = createApp({
  client: vonpay,
  returnUrl: RETURN_URL,
  publishableKey: PUBLISHABLE_KEY,
  ...(API_BASE ? { browserApiBase: API_BASE } : {}),
  ...(STORED_CREDENTIAL_USE ? { storedCredentialUse: STORED_CREDENTIAL_USE } : {}),
  trustProxy: TRUST_PROXY,
  contentSecurityPolicy,
});
app.use(express.static(PUBLIC_DIR));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[funnel-one-click] http://localhost:${PORT}  (API: ${API_BASE ?? "https://checkout.vonpay.com"})`);
});
