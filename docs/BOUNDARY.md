# Boundary — Signal

**Locked 2026-08-19.** Tenant advantage is one-way inbound. No crossover of tenant digest into public or sibling tenants.

## Two stores

```
Public / market research DB  ──enrich──▶  Tenant Signal DB
Marketing scrub automation   ──update──▶  Tenant Signal DB
Tenant mailbox digest        ── ✕ ──▶    Public research
Tenant A                     ── ✕ ──▶    Tenant B
```

| Store | Holds | Readers | Writers |
|---|---|---|---|
| **Tenant Signal** | That company’s permissioned inbox digest + optional enrichments | Members + **that tenant’s** authorized agents | Detector, tenant users, **inbound enrich** (research, mkt scrub) |
| **Public research** | Market corpus — **not** tenant mail, not snippets, not account names | Paying public/agentic research API | Separate ingestion (licensed/public feeds — source TBD). **Never** tenant mailboxes |

## Inbound enrich (tenant advantage)

Allowed **into** the tenant store only:

1. **Public research enrich** — attach cited market context (segment, comps, category trend) onto a tenant signal. Tenant-scoped copy. Opt-in.
2. **Marketing scrub** — automation that cleans / normalizes / updates marketing records **in the tenant DB** (list hygiene, consent flags, campaign tags). Tenant-authorized. Does **not** publish those records outward.

Both are **pulls into the tenant**. Neither is an export.

**Not enrich:** raw tenant snippets, accounts, or mail into public research. Not using Tenant A to fill Tenant B. Not dual-write into Neon `sales_signals`.

## Other systems

| System | Relation |
|---|---|
| **CEO OS Neon** `sales_signals` | Chris’s internal pipeline ledger. Optional later *export* from Signal → Neon. One writer per field. Not this pack. |
| **Mission Control** | TROZLAN operator console. Not Signal. |
| **Nous** | Long-run harness for MC. Signal detector is `shared_detector`, not Nous. |
| **agent-gateway / AgentHub** | Future auth/meter for the agentic door (P5). |
| **QuoteWerks / RJO sales SQL** | Human quoting SSoT. Signal does not own quotes. |
| **Hermes `state.db`** | Do not dual-write. |

## Agentic doors

| API | May read | May write |
|---|---|---|
| Tenant-authorized agent API | That tenant’s Signal DB | Only if the tenant granted a write scope (default: read + cite enrich) |
| Public research API | Public research DB only | No tenant writes |

## If a change…

| If it… | It belongs |
|---|---|
| Reads a mailbox or writes a `Signal` from mail | Tenant detector — never public store |
| Cleans marketing lists into the tenant | Mkt-scrub inbound — tenant store only |
| Serves market comps to a tenant | Research enrich — copy into tenant, cite source |
| Serves market comps to a stranger agent | Public research API — research store only |
| Quotes or opportunities as SSoT | QuoteWerks / CEO OS — not Signal |
