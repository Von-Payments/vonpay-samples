import { NextResponse, type NextRequest } from "next/server";

/**
 * Content Security Policy with a new nonce on every request: the form the
 * Next.js guide gives for a strict policy
 * (https://nextjs.org/docs/app/guides/content-security-policy).
 *
 * ⛔ Why a nonce and not a fixed `script-src 'self'` in next.config.ts: the App
 * Router writes small inline scripts into every page (the data React needs to
 * start the page in the browser). A fixed `'self'` policy blocks them, so the
 * page renders but no button or form handler ever runs. Next.js reads the
 * nonce from the request's policy header and puts it on its own scripts, which
 * needs the page to render per request (see `connection()` in app/layout.tsx).
 *
 * `'strict-dynamic'`: a script the nonce allowed may load the page's other
 * scripts. `'unsafe-eval'` only in `next dev`, which React needs for its error
 * overlay; a production build does not use eval.
 *
 * Styles keep `'unsafe-inline'`: the pages use `style={…}` attributes, which a
 * nonce cannot allow.
 */
export function contentSecurityPolicy(nonce: string): string {
  const dev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' https://api.vonpay.com https://checkout.vonpay.com",
    "frame-src https://checkout.vonpay.com",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    // A form that posts here may be answered with a redirect to the hosted
    // checkout; browsers apply form-action to that redirect too.
    "form-action 'self' https://checkout.vonpay.com",
  ].join("; ");
}

/** Let the request through with a fresh nonce on it and the policy on the response. */
export function nextWithContentSecurityPolicy(req: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = contentSecurityPolicy(nonce);
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", policy);
  return res;
}
