# Architecture — Signal

**Reconciled:** 2026-08-19 · `1881799` on `origin/main`.  
**Rule:** document the stack that exists. Do not narrate a rewrite.

## Processes (production)

| Process | Command | Port | Role |
|---|---|---|---|
| API | `npm run api` → `scripts/signal-api.mjs` | 8787 | HTTP, OAuth, webhooks, mutations |
| Web | Vite React SPA (`src/`) | 5173 | Member + admin hash routes |
| Scheduler | `scripts/signal-scheduler.mjs` | — | Sync, detection jobs, digests, billing webhooks |
| State service | `scripts/signal-state-service.mjs` | 8791 | Durable state (file or Postgres) |

Local: file JSON `data/signal-local.json`. Production: `SIGNAL_BACKEND_MODE=external-service` + Postgres.

## Tech stack (ACTUAL)

| Layer | Choice |
|---|---|
| Runtime | Node **≥22**, ESM `.mjs` |
| UI | Vite 8, React 19, TypeScript |
| API | Hand-rolled Node HTTP in `signal-api.mjs` (not a named Express/Fastify app) |
| DB | `pg`. Schema is **one JSON document** + backups (`scripts/migrations/001-initial.sql`) |
| Isolation | App-level `scopeStateForActor` + optional Postgres **RLS on the blob tables**, not row-per-signal |
| Auth | JWKS + signed session. Local `SIGNAL_ALLOW_LOCAL_ACTOR=true` |
| Mail | Gmail + Outlook OAuth, watch/sync |
| Billing | Stripe (checkout, portal, webhooks) |
| Email out | Provider URL / SendGrid-shaped env |
| Tests | `node:test` (`npm run test:local`) |
| Ship | Docker + Compose (four processes) |

**Not in `package.json`:** OpenAI/Anthropic/xAI SDKs, Prisma, Next.js, LangGraph.

## Data flow

```
Gmail / Outlook  →  mailbox sync / watch
                 →  email-flows + jobs signal_detection
                 →  Signal + AccountAction + Notification
                 →  Member UI  |  (P5) tenant agent API

public_sales_signal (automatic, isolated job)
                 → Public research DB ──enrich──▶ tenant JSON state
Mkt scrub job    ──update──▶ tenant JSON state
tenant digest    ── ✕ ──▶   public research
```

## Why the JSON blob matters

`001-initial.sql` stores `body jsonb` as the whole app state. RLS protects service-role access to that document. Per-tenant filtering is still application-level. A **research DB** and high-volume agent query are **not** this schema — they are P5 (separate store). Do not pretend the blob is a research warehouse.

## Headless (P5)

Today `/api/*` is the same process the SPA uses (readiness, digestion-pipeline, webhooks, CRUD). P5 adds:

- Stable machine contract (versioned) for tenant-authorized agents
- API keys / AgentHub identity; meter + audit (who peeked, which tenant, which fields)
- Default deny on raw snippets
- Separate public research base URL and credentials

Until then: do not sell per-peek.

## Pointers

- Operator launch: [PRODUCTION_RUNBOOK.md](./PRODUCTION_RUNBOOK.md)
- Feature status: [specs/index.md](./specs/index.md)
- Phases: [MILESTONES.md](./MILESTONES.md)
