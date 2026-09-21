# Code Review Rules

Single source of truth for all code rules. The code-reviewer agent checks every PR against this list. Specialist agents (DBA, DevSecOps, QA) add rules here when they discover bug patterns.

Each rule has an ID, what to check, and how it's enforced.

---

## Standard Guards

### standard/auth-guard
**Rule:** Every API route must have authentication. Public routes must be explicitly documented.
**Check:** Search for route handlers without auth calls.
**Applies here?** This repo has no server of its own (sample apps run in the reader's own environment); N/A for the root docs files, but applies to any server code added inside a sample if this repo ever stops being a pure mirror.

### standard/encrypt-pii
**Rule:** PII (bank numbers, SSN, EIN, government IDs, DOB) must be encrypted at rest. Never store or log PII in plaintext.
**Check:** New fields containing PII must use encryption helpers.
**Applies here?** N/A — no datastore in this repo.

### standard/no-pii-in-responses
**Rule:** Never expose full account numbers, routing numbers, SSN, DOB, or government IDs in API responses. Mask sensitive fields.
**Check:** Any endpoint returning sensitive data must mask it.
**Applies here?** N/A — no API server owned by this repo.

### standard/parameterized-sql
**Rule:** Use parameterized queries ($1, $2) for all SQL. No string interpolation in queries.
**Check:** Search for template literals or string concatenation in SQL.
**Applies here?** N/A — no SQL in this repo.

### standard/rls-on-all-tables
**Rule:** Every new table must have `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY`.
**Check:** New CREATE TABLE statements must be followed by RLS enablement.
**Applies here?** N/A — no database.

### standard/log-sanitization
**Rule:** PII field names must be in sanitization/redaction lists. No PII in log output.
**Check:** New PII fields must be added to sensitive key lists.
**Applies here?** N/A for the root docs; applies inside sample server code (owned upstream, not edited here).

### standard/no-empty-catch
**Rule:** No empty catch blocks. Every catch must log or handle the error.
**Check:** Search for catch blocks with no logging or error handling inside.
**Applies here?** Applies inside sample server code (owned upstream, not edited here).

### standard/no-hardcoded-secrets
**Rule:** No API keys, tokens, passwords, or secrets in source code. Use environment variables.
**Check:** Search for patterns like live-mode key prefixes, bearer tokens, hardcoded connection strings.
**Applies here?** Yes — checked. This repo is public; `.github/workflows/leak-check.yml` already greps for `vp_sk_(live|test)_...` and `whsec_...` with >=20 entropy chars. The reviewer additionally greps root-doc diffs for the same patterns on every review.

### standard/one-action-one-control
**Rule:** A screen offers ONE control per user-visible action. Two controls for one action are permitted only when they take different ARGUMENTS — never when they differ merely in placement, label, or wording.
**Applies here?** N/A — this repo has no UI of its own; the sample UIs are owned upstream.

---

## Repo-specific rules (vonpay-samples)

### docs/facts-must-trace-to-source
**Source:** code-reviewer, PR review of the 2026-09-21 root-docs SDK-version rewrite (branch `work/2026-09-21`).
**Rule:** Every version, event name, envelope field, method signature, type name, and error-code behavior claimed in `AGENTS.md` / `llms.txt` / `README.md` must be traceable to (a) a sample's own `package.json`/lockfile/`requirements.txt`, (b) the published SDK's `.d.ts` / `.py` source, or (c) a registry lookup (`npm view`, PyPI JSON) — never to the author's memory of how a similar SDK (e.g. Stripe) behaves, and never inferred from an error code's name alone when the exact trigger condition isn't stated in the type docs or a sample's own README/comments.
**Why it is missed:** A claim can be *directionally* correct (the error code exists, the field exists) while still misstating the actual trigger condition or guarantee, because the reviewer's confidence comes from "the identifier is real" rather than "the specific behavior sentence is real." This is exactly how a real vs. invented API/field distinction blurs into a real-field/invented-behavior slop pattern.
**Check:** For any sentence in a diff to these files that asserts *what happens* (not just *what exists*) — e.g. "X can only happen with Y", "Z otherwise" — grep for that specific behavior in the SDK's `.d.ts`/`.py` docstrings AND in the relevant sample's own README/comments (samples are written by the same team and often spell out the exact failure mode). If the specific trigger condition isn't stated anywhere in either source, and especially if a sample's own README states the opposite or a materially different condition, flag it — do not accept "the error code exists in the enum" as confirmation of "this is when it fires."
**Example caught:** `AGENTS.md`/`llms.txt` (2026-09-21 diff) claimed a saved-card token "can only be charged with that buyer (`buyer_required_for_saved_card` otherwise)". The SDK's own `CreatePaymentIntentParams.buyerId` doc says the opposite: "This is a protection, and it only applies when you send it... a mismatch returns `404 payment_method_not_found`." The `saved-cards-mit` sample's own README is even more explicit: "Nothing rejects that charge unless `buyerId` is present." No source anywhere documents `buyer_required_for_saved_card` firing on omission — the claim was an inference from the error code's name, not a sourced fact, and it asserted a safety net that does not exist for a money-moving flow.
**Enforced by:** Manual verification against `/dist/*.d.ts` (Node), the Python wheel's `.py` sources, and each sample's own README/comments before approving any diff to `AGENTS.md`, `llms.txt`, or `README.md`. No automated check exists yet — CI only runs typecheck/build + the narrow leak-check; consider a future CI job that greps these three files for SDK method/type names and fails if a named symbol doesn't exist in the pinned `.d.ts`.

### docs/gitattributes-no-reflag
**Source:** code-reviewer, same PR.
**Rule:** A new `.gitattributes` normalization rule (e.g. `* text=auto eol=lf`) must not retroactively mark already-tracked files as modified.
**Check:** Run `git ls-files --eol` before and after and confirm no tracked non-binary file's working-tree `w/` eol differs from `lf` (i.e. the normalization is a no-op on the existing tree, and only affects future checkouts/clones on other platforms).
**Enforced by:** Manual `git ls-files --eol` diff-count check in this review; consider a CI step that runs `git status --porcelain` immediately after checkout as a canary.

### docs/renovate-disabled-config-must-validate
**Source:** code-reviewer, same PR.
**Rule:** When `renovate.json` in a mirror/downstream repo is switched to `{ "enabled": false, "description": "..." }`, it must still pass Renovate's own config validator (schema drift between Renovate major versions can silently make `enabled`/`description` invalid or add required keys).
**Check:** `npx --package renovate -- renovate-config-validator renovate.json` before merge.
**Enforced by:** Manual run in this review; not yet wired into CI (`ci.yml` doesn't touch `renovate.json`).
