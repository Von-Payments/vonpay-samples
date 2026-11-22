#!/usr/bin/env node
// Root-guide drift check for vonpay-samples.
//
// README.md, AGENTS.md and llms.txt are read by integrators and their coding
// agents. CLAUDE.md requires every version and sample they name to match the
// sample folders. Three syncs in a row moved the sample pins without touching
// the root guides, so this check fails the PR when they disagree.
//
// What it checks, in each of the three root guides:
//   1. Every sample folder (a top-level folder with package.json or
//      requirements.txt) is named somewhere in the guide (presence only).
//   2. For each @vonpay package a sample declares: the pin (e.g. ^4.10.0) as
//      a whole token, and the locked version written as "lockfile 4.10.0" or
//      "lockfiles `4.10.0`". All samples that declare the package must agree
//      on both, or the check fails first.
//   3. The vonpay-checkout pin from requirements.txt (same agreement rule).
//   4. The vora.js version the samples pin in a live <script src> tag
//      (js.vonpay.com/vX.Y.Z/vora.js, outside HTML comments), when any sample
//      pins one (same agreement rule).
//   5. A "checked YYYY-MM-DD" line exists.
//
// Not covered: "current release" numbers, the freshness of the checked date,
// and behaviour sentences (review rule docs/facts-must-trace-to-source).
//
// `--list` prints the sample folders instead, as GitHub Actions outputs
// (node=[...] and python=[...]); ci.yml builds its matrix from them, so this
// file is the one place that decides what a sample is.
//
// This file is the single home for what the check covers; CLAUDE.md and
// .claude/review-rules.md point here. No dependencies; runs on the stock
// runner Node. Exit 1 on any problem.

import { readFileSync, readdirSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DOCS = ["README.md", "AGENTS.md", "llms.txt"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".github", ".claude", "scripts", ".next", "dist", "build"]);
const PAGE_EXT = /\.(html|tsx|jsx|ts|js|mjs)$/; // files that can load the script; READMEs only describe it

const problems = [];
const clean = (v) => String(v).replace(/[\u0000-\u001f\u007f]/g, " "); // no runner commands via names
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isRealDir = (p) => {
  const st = lstatSync(p);
  return st.isDirectory() && !st.isSymbolicLink();
};

const samples = readdirSync(ROOT)
  .filter((d) => !d.startsWith(".") && !SKIP_DIRS.has(d))
  .filter((d) => isRealDir(join(ROOT, d)))
  .filter((d) => existsSync(join(ROOT, d, "package.json")) || existsSync(join(ROOT, d, "requirements.txt")))
  .sort();

if (samples.length === 0) {
  console.error("::error::check-root-docs: found no sample folders; run from the repo root");
  process.exit(1);
}

if (process.argv.includes("--list")) {
  // Folder names reach $GITHUB_OUTPUT and a job matrix: allow plain names only.
  const bad = samples.filter((s) => !/^[a-z0-9][a-z0-9-]*$/.test(s));
  if (bad.length) {
    console.error(`::error::check-root-docs --list: sample folder names must be lowercase letters, digits and '-': ${bad.map(clean).join(", ")}`);
    process.exit(1);
  }
  const node = samples.filter((s) => existsSync(join(ROOT, s, "package.json")));
  const python = samples.filter((s) => !node.includes(s) && existsSync(join(ROOT, s, "requirements.txt")));
  console.log(`node=${JSON.stringify(node)}`);
  console.log(`python=${JSON.stringify(python)}`);
  process.exit(0);
}

// One value per fact; record a problem if the samples disagree.
function agree(label, byWhere) {
  const values = [...new Set(byWhere.values())];
  if (values.length > 1) {
    const detail = [...byWhere].map(([w, v]) => `${w}=${v}`).join(", ");
    problems.push(`samples disagree on ${label}: ${detail}`);
    return null;
  }
  return values[0] ?? null;
}

// Facts the guides must state: { label, re }.
const required = [];
const versionToken = (v) => `(?<![\\w.^~=<>])${escapeRe(v)}(?![\\w.])`;

// 2. @vonpay npm packages: pin + locked version.
const npmPins = new Map(); // pkg -> Map(folder -> spec)
const npmLocks = new Map(); // pkg -> Map(folder -> version)
for (const s of samples) {
  const pkgPath = join(ROOT, s, "package.json");
  if (!existsSync(pkgPath)) continue;
  const pkg = readJson(pkgPath);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const lockPath = join(ROOT, s, "package-lock.json");
  const lock = existsSync(lockPath) ? readJson(lockPath) : null;
  for (const [name, spec] of Object.entries(deps)) {
    if (!name.startsWith("@vonpay/")) continue;
    if (!npmPins.has(name)) npmPins.set(name, new Map());
    npmPins.get(name).set(s, spec);
    const locked = lock?.packages?.[`node_modules/${name}`]?.version;
    if (!lock) {
      problems.push(`${s}: declares ${name} but has no package-lock.json (this repo's samples ship npm lockfiles)`);
    } else if (!locked) {
      problems.push(`${s}: declares ${name} but its package-lock.json has no entry for it`);
    } else {
      if (!npmLocks.has(name)) npmLocks.set(name, new Map());
      npmLocks.get(name).set(s, locked);
    }
  }
}
for (const name of [...npmPins.keys()].sort()) {
  const spec = agree(`${name} pin`, npmPins.get(name));
  const locked = agree(`${name} locked version`, npmLocks.get(name) ?? new Map());
  if (spec) required.push({ label: `${name} pin ${spec}`, re: new RegExp(`(?<![\\w.])${escapeRe(spec)}(?![\\w.])`) });
  if (locked) required.push({ label: `${name} locked version (as "lockfile ${locked}")`, re: new RegExp(`lockfiles?(?: at)? \`?${escapeRe(locked)}\`?(?![\\w.])`) });
}

// 3. Python SDK pin.
const pyPins = new Map();
for (const s of samples) {
  const reqPath = join(ROOT, s, "requirements.txt");
  if (!existsSync(reqPath)) continue;
  for (const line of readFileSync(reqPath, "utf8").split("\n")) {
    const m = line.trim().match(/^vonpay-checkout\s*([<>=!~][^#\s]*)/);
    if (m) pyPins.set(s, m[1]);
  }
}
const pySpec = agree("vonpay-checkout pin", pyPins);
if (pySpec) required.push({ label: `vonpay-checkout pin ${pySpec}`, re: new RegExp(`(?<![\\w.])${escapeRe(pySpec)}(?![\\w.])`) });

// 4. Pinned vora.js version in live <script src> tags.
function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && PAGE_EXT.test(e.name)) out.push(p);
  }
  return out;
}
const voraPins = new Map(); // "file#n" -> version
for (const s of samples) {
  for (const file of walk(join(ROOT, s), [])) {
    const text = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
    let n = 0;
    for (const m of text.matchAll(/<script\b[^>]*\bsrc=["']https:\/\/js\.vonpay\.com\/v(\d+\.\d+\.\d+)\/vora\.js["']/g)) {
      voraPins.set(`${file.slice(ROOT.length + 1)}#${++n}`, `v${m[1]}`);
    }
  }
}
const voraPin = agree("pinned vora.js version", voraPins);
if (voraPin) required.push({ label: `vora.js pin ${voraPin}`, re: new RegExp(versionToken(voraPin)) });

// Check each guide.
const named = (text, name) => {
  for (let i = text.indexOf(name); i !== -1; i = text.indexOf(name, i + 1)) {
    const before = i === 0 ? "" : text[i - 1];
    const after = text[i + name.length] ?? "";
    if (!/[\w-]/.test(before) && !/[\w-]/.test(after)) return true;
  }
  return false;
};
for (const doc of DOCS) {
  const path = join(ROOT, doc);
  if (!existsSync(path)) {
    problems.push(`${doc}: missing`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  for (const s of samples) if (!named(text, s)) problems.push(`${doc}: does not name sample folder ${s}`);
  for (const r of required) if (!r.re.test(text)) problems.push(`${doc}: does not state ${r.label}`);
  if (!/checked (on )?\d{4}-\d{2}-\d{2}/.test(text)) problems.push(`${doc}: has no "checked YYYY-MM-DD" line`);
}

if (problems.length) {
  console.error("::error::Root guides do not match the sample folders. Update README.md, AGENTS.md and llms.txt (and their checked date):");
  for (const p of problems) console.error(`  - ${clean(p)}`);
  process.exit(1);
}
console.log(`Root guides match: ${samples.length} samples, ${required.length} pinned facts, ${DOCS.length} guides.`);
