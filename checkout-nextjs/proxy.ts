import type { NextRequest, NextResponse } from "next/server";
import { nextWithContentSecurityPolicy } from "./lib/csp";

/**
 * Puts a Content Security Policy with a fresh nonce on every page (see
 * lib/csp.ts for why it cannot be a fixed header in next.config.ts).
 */
export function proxy(req: NextRequest): NextResponse {
  return nextWithContentSecurityPolicy(req);
}

export const config = {
  // Pages only: not the API routes (they answer JSON), and not Next.js's
  // static files, image optimizer or the favicon.
  matcher: ["/((?!api/|_next/static/|_next/image$|favicon\\.ico$).*)"],
};
