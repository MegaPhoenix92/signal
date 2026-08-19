# Public sales-signal automation

| Field | Value |
|-------|-------|
| **Slug** | `public-sales-signal-automation` |
| **Status** | `stub` (required for P5 — not optional) |
| **Last reconciled** | 2026-08-19 |
| **Git SHA** | `18817990d33a1f3a970a44aae6567164358c86b8` |

## What it is

An **always-on worker** that builds and refreshes the **public** sales-signal store. Agents (and paying research clients) consume that store. It does **not** read tenant mailboxes.

This is the automatic system for the public/agentic sales-signal channel. Tenant inbox detection stays a **different job**.

## Loop (must be automatic)

```
Licensed / public feeds (NOT tenant mail)
        → ingest
        → digest / normalize / type / score
        → write Public research DB
        → audit row (source, time, counts)
        → optional: push cited enrich into opted-in tenant DBs
```

No human in the ingest loop. Humans and agents only **read** (and tenants may accept enrich).

## Isolation

| Job | Store | Reads mailboxes? |
|---|---|---|
| `signal_detection` (exists) | Tenant JSON state | Yes — that tenant only |
| `public_sales_signal` (**this**, not built) | Public research DB | **Never** |
| `marketing_scrub` (P5) | Tenant DB | No — updates tenant marketing records |

Same scheduler **process family** (`signal-scheduler.mjs`) is allowed; the **job name, credentials, and database must be separate**. Do not reuse `email-flows.run` on public feeds.

## MVP boundary

**In:**

- Scheduled job `public_sales_signal` (cron via existing scheduler)
- Separate public research schema (not `001-initial.sql` tenant blob)
- Digestion to a **public** type list (market/category/intent — not account-named)
- Audit + freshness (stale feed = fail the run, do not silently serve)
- Metered public read API (P5)
- Optional one-way enrich into tenant (tenant advantage)

**Out:**

- Tenant snippets, domains, or message ids in the public store
- Using tenant `signal_detection` output as a public source
- Manual “upload a CSV of customer mail” as the happy path
- Invented feed vendors in this spec (source list is an owner decision at P5 build)

## Capability matrix

| Capability | Status | Contract | Data | Surface |
|------------|--------|----------|------|---------|
| Public worker | stub | job `public_sales_signal` | new DB | scheduler |
| Public digestion | stub | sibling of `/api/digestion-pipeline` | research rows | admin: public-pipeline only |
| Public agent API | stub | versioned, metered | research DB | P5 |
| Tenant enrich from public | stub | [inbound-enrichment](./inbound-enrichment.md) | tenant DB | P5 |
| Cross-over tenant → public | **forbidden** | [BOUNDARY.md](../BOUNDARY.md) | — | never |

## Done when (P5 slice)

- Scheduler tick writes ≥1 public research row from a configured **non-tenant** fixture/feed
- Audit log has source + timestamp; tenant mailbox tables were not opened
- A query as a “public agent” cannot see tenant `signals[]`
- An opted-in tenant can receive an enrich cite from that public row

## Change log

| Date | SHA | Summary |
|------|-----|---------|
| 2026-08-19 | `1881799` | Required automatic public sales-signal system (Chris) |
