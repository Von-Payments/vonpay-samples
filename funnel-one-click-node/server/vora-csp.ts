/**
 * The page's Content Security Policy, built at start from the list vora.js
 * publishes for the EXACT version the page pins. A copy of that list is kept in
 * this sample (`public/csp.json`, next to the page), so the server starts with
 * no network.
 *
 * Every vora.js version publishes the sources it needs at
 * `https://js.vonpay.com/v<version>/csp.json`, one list for test keys and one
 * for live keys (the card frames and wallet scripts differ). The kept copy is
 * that file, byte for byte, for the pinned version.
 *
 * ⛔ Pinned by hash, like the script. The pinned script tag carries the
 * file's sha384 next to vora.js's own: `data-vora-csp-integrity`, taken from
 * https://js.vonpay.com/integrity.json (`versions["v<version>"].artifacts`,
 * the entry with `role: "csp"`). The file's bytes are hashed BEFORE they are
 * parsed, and a different hash stops the start. So a changed or swapped file
 * cannot change this page's policy, even one that looks valid.
 *
 * ⛔ Fails closed. When the file cannot be read, does not match the pinned
 * hash, is not the pinned version's, or holds anything that is not a plain
 * source, `loadVoraCsp` throws and the server must refuse to start. A page
 * served with a guessed policy either breaks the card form or allows more than
 * it should.
 *
 * Re-pinning vora.js: change the version, the script's `integrity`,
 * `data-vora-csp-integrity` (all three from integrity.json) and `public/csp.json`
 * together. Download the file, never edit it:
 * `curl -o public/csp.json https://js.vonpay.com/v<version>/csp.json`
 *
 * This file is identical in checkout-embedded and funnel-one-click-node.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type KeyMode = "test" | "live";

/** The directives vora.js's list may name. Anything else in the file is refused. */
const VORA_DIRECTIVES = ["script-src", "frame-src", "connect-src", "img-src", "style-src", "font-src"] as const;
type VoraDirective = (typeof VORA_DIRECTIVES)[number];

/** A host source (`https://host`, `https://*.host`, optional port) or one of the two keywords the list uses. */
const SOURCE = /^(?:https:\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?|'self'|'unsafe-inline')$/;

/**
 * ⛔ The one place a keyword that turns off a protection may appear:
 * `'unsafe-inline'` in style-src (the payment form and Google Pay add a
 * `<style>` element to the page). Any `'unsafe-…'` keyword anywhere else, and
 * `'unsafe-eval'` everywhere, is refused whatever the file says: inline or
 * eval'd script would undo what the policy is for. Checked before `SOURCE`, so
 * the refusal names the keyword.
 */
function refuseUnsafeKeyword(directive: string, source: string): void {
  if (!/^'(?:wasm-)?unsafe-/i.test(source)) return;
  if (directive === "style-src" && source === "'unsafe-inline'") return;
  throw new Error(
    `csp.json's ${directive} holds ${source}. This page never allows it there (only 'unsafe-inline' in style-src), so it will not start with this list`,
  );
}

/** A sha384 in Subresource Integrity form: `sha384-` and 64 base64 characters. */
const SHA384 = /^sha384-[A-Za-z0-9+/]{64}$/;

/** What the page pins: the vora.js version and the sha384 of that version's csp.json. */
export interface VoraPin {
  version: string;
  cspIntegrity: string;
}

/** The live (not commented) `<script>` tags that load a pinned `js.vonpay.com/v<x.y.z>/vora.js`. */
function pinnedTags(html: string): { tag: string; version: string }[] {
  const live = html.replace(/<!--[\s\S]*?-->/g, "");
  return [...live.matchAll(/<script\b[^>]*\bsrc="https:\/\/js\.vonpay\.com\/v(\d+\.\d+\.\d+)\/vora\.js"[^>]*>/g)].map((m) => ({
    tag: m[0],
    version: m[1]!,
  }));
}

/** The vora.js version a page loads: the one `js.vonpay.com/v<x.y.z>/vora.js` in a live (not commented) script tag. */
export function pinnedVoraVersion(html: string): string {
  const versions = new Set(pinnedTags(html).map((t) => t.version));
  if (versions.size !== 1) {
    throw new Error(
      `the page must load exactly one pinned vora.js (https://js.vonpay.com/vX.Y.Z/vora.js); found ${versions.size === 0 ? "none" : [...versions].join(", ")}`,
    );
  }
  return [...versions][0]!;
}

/** The pinned version and its csp.json hash (`data-vora-csp-integrity` on the same script tag). */
export function pinnedVora(html: string): VoraPin {
  const version = pinnedVoraVersion(html);
  const hashes = new Set(
    pinnedTags(html).map((t) => /\bdata-vora-csp-integrity="([^"]*)"/.exec(t.tag)?.[1] ?? ""),
  );
  const [cspIntegrity] = [...hashes];
  if (hashes.size !== 1 || cspIntegrity === undefined || !SHA384.test(cspIntegrity)) {
    throw new Error(
      `the pinned vora.js script tag must carry data-vora-csp-integrity="sha384-…", the hash of https://js.vonpay.com/v${version}/csp.json from https://js.vonpay.com/integrity.json (versions["v${version}"].artifacts, role "csp")`,
    );
  }
  return { version, cspIntegrity };
}

/** Read the pinned version from a page file. */
export function pinnedVoraVersionOf(htmlPath: string): string {
  return pinnedVoraVersion(readFileSync(htmlPath, "utf8"));
}

/** Read the pinned version and csp.json hash from a page file. */
export function pinnedVoraOf(htmlPath: string): VoraPin {
  return pinnedVora(readFileSync(htmlPath, "utf8"));
}

/** The Subresource Integrity form of bytes' sha384. */
export function sha384Of(bytes: Uint8Array): string {
  return `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
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
      if (typeof source === "string") refuseUnsafeKeyword(name, source);
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

/** The kept copy of the pinned version's list: `csp.json` next to the page. */
export function cspFileBeside(htmlPath: string): string {
  return join(dirname(htmlPath), "csp.json");
}

/**
 * Read the kept list, check its bytes against the pinned hash, and build the
 * policy. No network. Throws a message that says what to fix; the caller
 * refuses to start.
 */
export function loadVoraCsp(opts: {
  version: string;
  /** The sha384 of the file the page pins (`data-vora-csp-integrity`). */
  cspIntegrity: string;
  /** The kept copy of the pinned version's csp.json (see cspFileBeside). */
  cspFile: string;
  mode: KeyMode;
  apiOrigin?: string;
}): string {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(opts.cspFile);
  } catch (err) {
    throw new Error(
      `could not read ${opts.cspFile} (${err instanceof Error ? err.message : String(err)}). Download it from ${voraCspUrl(opts.version)}`,
    );
  }
  if (!SHA384.test(opts.cspIntegrity)) {
    throw new Error(`the pinned hash for ${opts.cspFile} is not a sha384 ("${opts.cspIntegrity}")`);
  }
  // ⛔ Hash the bytes as they are, BEFORE parsing them.
  const found = sha384Of(bytes);
  if (found !== opts.cspIntegrity) {
    throw new Error(
      `${opts.cspFile} does not match the pinned hash: the file is ${found}, the page pins ${opts.cspIntegrity} (data-vora-csp-integrity in public/index.html). Not using it. It must be ${voraCspUrl(opts.version)} byte for byte (an editor or git may have changed its line endings)`,
    );
  }
  let file: unknown;
  try {
    file = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${opts.cspFile} is not valid JSON`);
  }
  try {
    return buildPolicy(voraSources(file, opts.version, opts.mode), opts.apiOrigin);
  } catch (err) {
    throw new Error(`${opts.cspFile}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
