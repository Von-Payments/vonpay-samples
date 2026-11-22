/**
 * The page's Content Security Policy, built at start from the list vora.js
 * publishes for the EXACT version the page pins.
 *
 * Every vora.js version publishes the sources it needs at
 * `https://js.vonpay.com/v<version>/csp.json`, one list for test keys and one
 * for live keys (the card frames and wallet scripts differ). Reading that file
 * for the pinned version keeps the policy and the script tag in step: re-pin
 * the script, restart, and the policy follows.
 *
 * ⛔ Fails closed. When the file cannot be fetched, is not the pinned
 * version's, or holds anything that is not a plain source, `loadVoraCsp`
 * throws and the server must refuse to start. A page served with a guessed
 * policy either breaks the card form or allows more than it should.
 *
 * This file is identical in checkout-embedded and funnel-one-click-node.
 */

import { readFileSync } from "node:fs";

export type KeyMode = "test" | "live";

/** The directives vora.js's list may name. Anything else in the file is refused. */
const VORA_DIRECTIVES = ["script-src", "frame-src", "connect-src", "img-src", "style-src", "font-src"] as const;
type VoraDirective = (typeof VORA_DIRECTIVES)[number];

/** A host source (`https://host`, `https://*.host`, optional port) or one of the two keywords the list uses. */
const SOURCE = /^(?:https:\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?|'self'|'unsafe-inline')$/;

/** The vora.js version a page loads: the one `js.vonpay.com/v<x.y.z>/vora.js` in a live (not commented) script tag. */
export function pinnedVoraVersion(html: string): string {
  const live = html.replace(/<!--[\s\S]*?-->/g, "");
  const versions = new Set(
    [...live.matchAll(/<script\b[^>]*\bsrc="https:\/\/js\.vonpay\.com\/v(\d+\.\d+\.\d+)\/vora\.js"/g)].map((m) => m[1]),
  );
  if (versions.size !== 1) {
    throw new Error(
      `the page must load exactly one pinned vora.js (https://js.vonpay.com/vX.Y.Z/vora.js); found ${versions.size === 0 ? "none" : [...versions].join(", ")}`,
    );
  }
  return [...versions][0]!;
}

/** Read the pinned version from a page file. */
export function pinnedVoraVersionOf(htmlPath: string): string {
  return pinnedVoraVersion(readFileSync(htmlPath, "utf8"));
}

/** `test` for a vp_sk_test_ / vp_pk_test_ key, `live` for a vp_sk_live_ / vp_pk_live_ key. */
export function keyModeOf(key: string): KeyMode {
  if (/^vp_(?:sk|pk)_test_/.test(key)) return "test";
  if (/^vp_(?:sk|pk)_live_/.test(key)) return "live";
  throw new Error("the key must start with vp_sk_test_, vp_sk_live_, vp_pk_test_ or vp_pk_live_");
}

export function voraCspUrl(version: string): string {
  return `https://js.vonpay.com/v${version}/csp.json`;
}

/** Check the published file and return the sources for one key mode. Throws on anything unexpected. */
export function voraSources(file: unknown, version: string, mode: KeyMode): Record<VoraDirective, string[]> {
  const f = file as { version?: unknown; modes?: Record<string, { version?: unknown; directives?: unknown }> };
  if (typeof f !== "object" || f === null) throw new Error("csp.json is not a JSON object");
  if (f.version !== version) throw new Error(`csp.json is for vora.js ${String(f.version)}, the page pins ${version}`);
  const entry = f.modes?.[mode];
  if (entry === undefined || entry.version !== version) throw new Error(`csp.json has no ${mode} list for ${version}`);
  const directives = entry.directives;
  if (typeof directives !== "object" || directives === null || Array.isArray(directives)) {
    throw new Error(`csp.json's ${mode} list has no directives`);
  }
  const out = Object.fromEntries(VORA_DIRECTIVES.map((d) => [d, [] as string[]])) as Record<VoraDirective, string[]>;
  for (const [name, sources] of Object.entries(directives)) {
    if (!(VORA_DIRECTIVES as readonly string[]).includes(name)) throw new Error(`csp.json names an unexpected directive: ${name}`);
    if (!Array.isArray(sources)) throw new Error(`csp.json's ${name} is not a list`);
    for (const source of sources) {
      if (typeof source !== "string" || !SOURCE.test(source)) {
        throw new Error(`csp.json's ${name} holds a source this page will not use: ${JSON.stringify(source)}`);
      }
      out[name as VoraDirective].push(source);
    }
  }
  if (!out["script-src"].includes("https://js.vonpay.com")) throw new Error("csp.json's script-src does not allow js.vonpay.com");
  return out;
}

/**
 * The full policy: this page's own needs (`'self'` for its own files and API
 * routes, no plugins, no framing by other sites) plus vora.js's list.
 * `apiOrigin` is the Von Payments API host the browser SDK is pointed at when
 * it is not the default one (it is added to connect-src and frame-src).
 */
export function buildPolicy(sources: Record<VoraDirective, string[]>, apiOrigin?: string): string {
  const list = (...parts: string[]) => [...new Set(parts)].join(" ");
  const extra = apiOrigin ? [apiOrigin] : [];
  return [
    "default-src 'self'",
    `script-src ${list("'self'", ...sources["script-src"])}`,
    `style-src ${list("'self'", ...sources["style-src"])}`,
    `img-src ${list("'self'", "data:", ...sources["img-src"])}`,
    `font-src ${list("'self'", ...sources["font-src"])}`,
    `connect-src ${list("'self'", ...sources["connect-src"], ...extra)}`,
    `frame-src ${list(...sources["frame-src"], ...extra)}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Fetch the pinned version's list and build the policy. Throws a message
 * that says what to fix; the caller refuses to start.
 */
export async function loadVoraCsp(opts: {
  version: string;
  mode: KeyMode;
  apiOrigin?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string> {
  const url = voraCspUrl(opts.version);
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
  } catch (err) {
    throw new Error(`could not fetch ${url} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  let file: unknown;
  try {
    file = await res.json();
  } catch {
    throw new Error(`${url} is not valid JSON`);
  }
  try {
    return buildPolicy(voraSources(file, opts.version, opts.mode), opts.apiOrigin);
  } catch (err) {
    throw new Error(`${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
