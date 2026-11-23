import { randomBytes } from "node:crypto";
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
 *
 * Hosts: the browser talks only to this site. It goes to the hosted checkout by
 * a plain navigation (a link, `window.location`, or a form post answered with a
 * redirect), and only that last one is checked by the policy (`form-action`).
 * Your server, not the browser, calls the Von Payments API. Add a host here
 * only when a page really loads from it, and only a host that exists.
 */
export function contentSecurityPolicy(nonce: string): string {
  const dev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    // A form that posts here may be answered with a redirect to the hosted
    // checkout; browsers apply form-action to that redirect too.
    "form-action 'self' https://checkout.vonpay.com",
  ].join("; ");
}

/**
 * A new nonce: 16 random bytes (128 bits), base64. proxy.ts runs on the
 * Node.js runtime (the only runtime Next.js 16 gives a proxy), so `node:crypto`
 * is available there.
 */
export function newNonce(): string {
  return randomBytes(16).toString("base64");
}

/** Let the request through with a fresh nonce on it and the policy on the response. */
export function nextWithContentSecurityPolicy(req: NextRequest): NextResponse {
  const nonce = newNonce();
  const policy = contentSecurityPolicy(nonce);
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", policy);
  return res;
}
