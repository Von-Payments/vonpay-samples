# CLAUDE.md — working in this repo

This is the **public mirror** of the Von Payments sample apps. Read this before
editing anything.

## Ownership — what is edited here vs. upstream

| Path | Owner | Edit here? |
|---|---|---|
| `<sample>/**` (every sample folder) | Von Payments SDK repository, `samples/` | **No.** Synced here by that repo's `sync-samples` script; a daily job compares the two and reports any difference as drift. An edit made only here is overwritten by the next sync. |
| `README.md`, `AGENTS.md`, `llms.txt`, `CLAUDE.md`, `LICENSE`, `.gitattributes`, `renovate.json`, `.github/` | this repo | Yes |

If a sample is wrong, fix it upstream and sync; do not patch it here. If you
only have access to this repo, open an issue.

## Gates

- CI (`.github/workflows/ci.yml`): per-sample `npm install` + typecheck/build
  (Node) and `py_compile` (Python). No functional tests.
- Leak check (`.github/workflows/leak-check.yml`): ticket IDs and secret-key
  material only. The full-glossary leak scan runs from the SDK repository on a
  schedule, not here — this repo carries no leak/drift rule files on purpose.
- Renovate is disabled here (`renovate.json`): bumps land upstream.

## Supabase projects

N/A. This repo has no database, no migrations and no replication; the DB-parity and replication-wiring checks do not run here.

## Facts the root docs must agree with

`AGENTS.md` and `llms.txt` are read by integrators' coding agents. Every
version, event name, field name and method in them must match the samples'
pins/lockfiles and the published SDK type definitions — check, don't recall.
They carry a "checked on <date>" line; update it when you re-verify.
