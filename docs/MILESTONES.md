# Milestones — Signal

**Locked:** 2026-08-19. P1–P3 are **historical** (GitHub issues closed). P4 is this pack. P5 is headless + research + mkt scrub.

A milestone is done when the check is machine-runnable or the spec status is reconciled to a SHA — not when a folder exists.

## Map

| ID | Name | Status |
|---|---|---|
| **P1** | Go-live (P0) | Historical — GH milestone, 8/8 issues closed. Durable backend, auth, isolation, providers, scheduler |
| **P2** | Correctness + IA (P1) | Historical — 7/7 closed. Routes, admin nav, signals/accounts UI |
| **P3** | Polish (P2/P3) | Historical — 13/13 closed. UX, a11y, domain APIs |
| **P4** | Spec truth | **This PR** — PRODUCT / ARCHITECTURE / BOUNDARY / specs match `1881799` |
| **P5** | Tenant advantage + agentic doors | Not started — **required** `public_sales_signal` automatic worker, public research store, tenant agent API, mkt-scrub inbound, meter |

Do not mark P1–P3 “production live” in marketing. Last closed issues included **CRITICAL compose boot** (#157, #161); #162/#163 followed on `origin/main`. Live compose proof is a P4/P5 ops check, not assumed.

## P4 — Spec truth (current)

**Done when**

- This file + PRODUCT + ARCHITECTURE + BOUNDARY + `docs/specs/index.md` are on `main`
- Canonical vs observed type lists are written (not silently merged)
- `PRODUCT_COMPLETION_GOAL.md` is a pointer, not a fake product goal
- Runbook remains the launch path

**Out:** implementing agent API, research warehouse, mkt-scrub job, Neon dual-write, stack rewrite.

## P5 — Tenant advantage + agentic doors

**In**

1. Tenant-authorized headless API (read signals; default no snippets)
2. Per-interaction meter + audit log
3. **Automatic `public_sales_signal` worker** (required) — ingest public/licensed feeds → digest → public research DB + audit. Never tenant mail.
4. **Public research DB** (separate) + one-way enrich into tenant
5. **Marketing scrub** automation that **updates the tenant DB only**
6. Queryable store if agent volume requires it (not the monolith JSON blob)

**Done when**

- A scheduler tick of `public_sales_signal` writes a public research row from a **non-tenant** fixture and leaves an audit row
- A tenant agent can list that tenant’s signals with a key and an audit row
- A public agent can query research and **cannot** read tenant mail
- Enrich + mkt scrub write only to the tenant store, with source citation
- Compose/API boot is proven against the runbook (or blockers are open issues)

**Out:** public marketplace of customer inboxes; using Tenant A to train Tenant B; LLM detector unless PRODUCT is amended.

## Explicitly not scheduled

- Rewriting API to Next/Prisma
- Dual-write to CEO OS Neon
- Hermes `state.db`
- Merging research and tenant into one database
