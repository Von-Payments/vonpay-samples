# CLAUDE.md - working in this repo

This is the **public mirror** of the Von Payments sample apps. Read this before
editing anything.

## Ownership - what is edited here vs. upstream

| Path | Owner | Edit here? |
|---|---|---|
| `<sample>/**` (every sample folder) | Von Payments SDK repository, `samples/` | **No.** Synced here by that repo's `sync-samples` script; a daily job compares the two and reports any difference as drift. An edit made only here is overwritten by the next sync. |
| `README.md`, `AGENTS.md`, `llms.txt`, `CLAUDE.md`, `LICENSE`, `.gitattributes`, `.gitignore`, `renovate.json`, `.github/`, `scripts/`, `.claude/` | this repo | Yes |

If a sample is wrong, fix it upstream and sync; do not patch it here. If you
only have access to this repo, open an issue.

## Gates

- CI (`.github/workflows/ci.yml`): per-sample `npm ci` (the committed
  lockfile, exactly) + typecheck/build (Node) and `py_compile` (Python). No
  functional tests; the sandbox run of the samples lives in the SDK repository
  (`samples-run.yml`). Docs-only changes skip it (`paths-ignore`).
- Leak check (`.github/workflows/leak-check.yml`): ticket IDs and secret-key
  material only; on a hit it prints file:line, never the value (public log).
  The full-glossary leak scan runs from the SDK repository on a schedule, not
  here - this repo carries no glossary rule files on purpose.
- Root-guide check (`scripts/check-root-docs.mjs`, a step in the leak-check
  job so docs-only PRs get it too): README.md, AGENTS.md and llms.txt must
  match the sample folders and their pins. What it covers and what it does not
  is stated once, in the script's header. Run it locally with
  `node scripts/check-root-docs.mjs`. The same script (`--list`) gives CI its
  list of samples, so a new sample folder is built without editing `ci.yml`.
- Two drift checks, two subjects: the SDK repository's daily job compares the
  sample folders here with its own `samples/`; `check-root-docs.mjs` compares
  the root guides (owned here) with those folders.
- No repo-root toolchain: there is no root `package.json`, so the gates above
  run per sample folder.
- Renovate is disabled here (`renovate.json`): bumps land upstream.

## Database projects

N/A. This repo has no database, no migrations and no replication; the DB-parity and replication-wiring checks do not run here.

## Facts the root docs must agree with

`AGENTS.md` and `llms.txt` are read by integrators' coding agents. Every
version, event name, field name and method in them must match the samples'
pins/lockfiles and the published SDK type definitions - check, don't recall.
They carry a "checked on <date>" line; update it when you re-verify.
