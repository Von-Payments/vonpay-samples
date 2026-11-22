import { NextResponse, type NextRequest } from "next/server";
import { nextWithContentSecurityPolicy } from "./lib/csp";

/**
 * Sign-in for the merchant's side of this sample: the dashboard pages and the
 * `/api/links` routes. Those create real checkout sessions with your API key
 * and show every link's `checkoutUrl`, which is a bearer token for paying it.
 *
 * The buyer's side stays open: the return page (`/confirm`) and the webhook
 * receiver (`/api/webhooks`, which checks its own signature).
 *
 * How it works:
 *   - ADMIN_TOKEN set: every request here needs HTTP Basic auth whose password
 *     is ADMIN_TOKEN (any user name). The browser asks once and then sends it
 *     on every page load and on the dashboard's own requests. From a shell:
 *     `curl -u admin:$ADMIN_TOKEN http://localhost:3000/api/links`.
 *   - ADMIN_TOKEN not set and NODE_ENV=production (`next start`, or a
 *     production deploy): every request here is refused with 403. The routes
 *     are never left open by a missing setting.
 *   - ADMIN_TOKEN not set otherwise (`npm run dev`): open, for local testing.
 *   - A request that changes something (anything but GET / HEAD) must also come
 *     from this site's own pages. The browser re-sends the Basic password on
 *     its own, so without this check another web site could make a signed-in
 *     merchant's browser create links (cross-site request forgery).
 *
 * This is a stand-in. A real dashboard uses your own sign-in and checks that
 * the signed-in person may see each link.
 */
export function proxy(req: NextRequest): NextResponse {
  const refused = isBuyerPath(req.nextUrl.pathname) ? undefined : signInRefusal(req);
  if (refused !== undefined) return refused;
  // Every page that gets through carries a Content Security Policy with a
  // fresh nonce (lib/csp.ts says why it cannot be a fixed header).
  return nextWithContentSecurityPolicy(req);
}

/**
 * The buyer's paths: the return page (`/confirm`) and the webhook receiver
 * (`/api/webhooks`, which checks its own signature). They need no sign-in.
 * Every other path does, so a page or route you add later is closed until you
 * decide otherwise; to open a new buyer-facing path, add it here.
 */
const BUYER_PATH = /^\/(?:confirm|api\/webhooks)(?:\/|$)/;

function isBuyerPath(pathname: string): boolean {
  return BUYER_PATH.test(pathname);
}

/** Why this request may not reach the merchant's side, as the response to send; undefined when it may. */
function signInRefusal(req: NextRequest): NextResponse | undefined {
  const token = process.env.ADMIN_TOKEN?.trim();
  if (!token) {
    if (process.env.NODE_ENV === "production") {
      return new NextResponse(
        "ADMIN_TOKEN is not set. The pay-link dashboard and /api/links are closed until it is.",
        { status: 403 },
      );
    }
    return undefined;
  }

  if (!fromThisSite(req)) {
    return new NextResponse("Cross-site request refused.", { status: 403 });
  }
  if (!sameText(basicAuthPassword(req), token)) {
    return new NextResponse("Sign in required.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Pay links", charset="UTF-8"' },
    });
  }
  return undefined;
}

export const config = {
  // Every path except Next.js's static files and image optimizer
  // (`/_next/static/…`, `/_next/image`) and the favicon. The proxy decides
  // inside which paths need a sign-in (BUYER_PATH); it runs on the buyer's
  // paths too, to put the Content Security Policy on them.
  matcher: ["/((?!_next/static/|_next/image$|favicon\\.ico$).*)"],
};

/**
 * Did this request come from this site's own pages? GET and HEAD always pass
 * (they change nothing). Otherwise the browser's `Sec-Fetch-Site` header must
 * say `same-origin` (or `none`: typed in the address bar), or, for a browser
 * that does not send it, the `Origin` header must be this site. A request
 * with neither header did not come from a browser (curl, a script): it cannot
 * be a forged browser request, and it still needs the password.
 */
function fromThisSite(req: NextRequest): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none";
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).host === req.nextUrl.host;
  } catch {
    return false;
  }
}

/** The password from an `Authorization: Basic …` header, or "" when absent or malformed. */
function basicAuthPassword(req: NextRequest): string {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!match) return "";
  try {
    // atob gives one character per byte; decode those bytes as UTF-8 so a
    // token with non-ASCII characters compares correctly.
    const bytes = Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const colon = decoded.indexOf(":");
    return colon === -1 ? "" : decoded.slice(colon + 1);
  } catch {
    return "";
  }
}

/** Compare without stopping at the first different character, so timing does not reveal the token. */
function sameText(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
