/**
 * Von Payments — Embedded checkout (VORA Mirror) sample server.
 *
 * VORA Mirror is the embedded card-collection path: the buyer stays on
 * your domain and the card field is rendered inside a Von Payments-owned
 * iframe loaded from the browser SDK at https://js.vonpay.com/v1/vora.js.
 * Sensitive card data never touches this server or your DOM.
 *
 * This server does the one thing a VORA Mirror integration needs a
 * backend for: it creates a checkout session with your SECRET key so the
 * browser never sees it. The browser then retrieves the session with the
 * PUBLISHABLE key and mounts the card field.
 *
 *   POST /api/create-session   Calls sessions.create() with the secret key.
 *                              Returns { session_id } — the publishable
 *                              `vp_cs_*` id is safe to hand to the browser.
 *
 *   POST /api/charge           Charges a `vp_pmt_*` token server-side via
 *                              paymentIntents.create(). ONLY called on the
 *                              tokenize-only flow (when submit returns a
 *                              token). On the charge-and-save flow the embed
 *                              already charged the buyer, so the browser
 *                              does NOT call this — see public/checkout.js.
 *
 * Static files in ./public are served as-is. Open http://localhost:4000.
 *
 * Required env (see .env.example):
 *   VON_PAY_SECRET_KEY        vp_sk_test_* or vp_sk_live_* (server-only)
 *   VON_PAY_PUBLISHABLE_KEY   vp_pk_test_* or vp_pk_live_* (sent to browser)
 *   PORT                      defaults to 4000
 *   VON_PAY_API_BASE          defaults to the SDK's built-in base
 */

import express, { type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  VonPayCheckout,
  VonPayError,
  type CreatePaymentIntentParams,
} from "@vonpay/checkout-node";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// The amount the demo charges. Real integrations derive this from the cart.
const AMOUNT = 4999; // $49.99 in the currency's minor unit
const CURRENCY = "USD";

const vonpay = new VonPayCheckout(
  API_BASE ? { apiKey: SECRET_KEY, baseUrl: API_BASE } : SECRET_KEY,
);

const app = express();
app.use(express.json());

// Expose the publishable key + amount to the browser. The publishable key
// is safe to ship to the client — it can only authenticate VORA's public
// endpoints, never move money on its own.
app.get("/api/config", (_req: Request, res: Response) => {
  res.json({
    publishableKey: PUBLISHABLE_KEY,
    apiBase: API_BASE ?? null,
    amount: AMOUNT,
    currency: CURRENCY,
  });
});

/**
 * Create a checkout session. The browser calls this, gets back the
 * session id, then loads the card field against it with the publishable
 * key. The session carries the amount/currency the embed will charge.
 */
app.post("/api/create-session", async (_req: Request, res: Response) => {
  try {
    const session = await vonpay.sessions.create({
      amount: AMOUNT,
      currency: CURRENCY,
      // Tag the session so it's identifiable in your dashboard.
      metadata: { sample: "checkout-embedded" },
    });
    // session.id (vp_cs_*) is the only field the browser needs — it is
    // safe to expose. Do not forward the whole session object.
    res.status(201).json({ session_id: session.id });
  } catch (err) {
    logUpstreamError("create-session", err);
    res.status(statusFor(err)).json({ error: messageFor(err) });
  }
});

/**
 * Charge a tokenized card server-side. Called ONLY on the tokenize-only
 * flow, where the browser's submit resolved with a `vp_pmt_*` token and
 * the actual money movement happens here.
 *
 * Do NOT call this on a charge-and-save session: there the embed already
 * charged the buyer at submit, so charging the token here would charge
 * them twice. The browser discriminates the submit result and only POSTs
 * here when it received a token (see public/checkout.js).
 */
app.post("/api/charge", async (req: Request, res: Response) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (!token.startsWith("vp_pmt_")) {
    res.status(400).json({ error: "A vp_pmt_* token is required." });
    return;
  }

  try {
    // Charge the token through the SDK's typed paymentIntents.create
    // (shipped natively since 0.6.0 — don't hand-roll a fetch).
    //
    // The payment-method handle travels as `paymentMethod: { id }`, which
    // the SDK serializes to the documented `payment_method: { id }` wire
    // field (see docs.vonpay.com/integration/payment-intents). As of
    // @vonpay/checkout-node@0.9.1 that field is not yet part of the
    // exported `CreatePaymentIntentParams` type, so we attach it via a
    // narrowly-scoped param object. This is the documented request shape,
    // not a workaround value.
    const params = {
      amount: AMOUNT,
      currency: CURRENCY,
      // captureMethod defaults to "automatic" (auth + capture in one call).
      paymentMethod: { id: token },
      metadata: { sample: "checkout-embedded" },
    } satisfies CreatePaymentIntentParams & {
      paymentMethod: { id: string };
    };

    const intent = await vonpay.paymentIntents.create(
      params as CreatePaymentIntentParams,
    );
    res.status(201).json({ id: intent.id, status: intent.status });
  } catch (err) {
    logUpstreamError("charge", err);
    res.status(statusFor(err)).json({ error: messageFor(err) });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Embedded checkout sample running at http://localhost:${PORT}`);
});

// ── Error helpers ─────────────────────────────────────────────────────
// Surface a useful status + message to the browser without leaking
// internals. VonPayError carries a typed status + code from the API.

function statusFor(err: unknown): number {
  if (err instanceof VonPayError && typeof err.status === "number") {
    return err.status >= 400 && err.status < 600 ? err.status : 502;
  }
  return 502;
}

function messageFor(err: unknown): string {
  if (err instanceof VonPayError) {
    return err.message;
  }
  return "Could not reach the Von Payments API. Check your keys and network.";
}

function logUpstreamError(op: string, err: unknown): void {
  if (err instanceof VonPayError) {
    console.error(`[${op}] VonPayError`, {
      status: err.status,
      code: err.code,
      message: err.message,
    });
  } else {
    console.error(`[${op}] error`, err);
  }
}
