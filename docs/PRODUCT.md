# Product — Signal

**Status:** locked 2026-08-19 (Chris). Reconciled to `1881799` (`origin/main`).  
**Repo:** `MegaPhoenix92/signal` (public) · local `TROZLANIO/signal`

Signal **gathers a company’s permissioned inbox, digests it into sales and product/service-improvement signals, and shows them so the right team — or that tenant’s authorized agents — can act.**

Tenant advantage: **public research** and **marketing scrub** may *enrich* the tenant store. Tenant mail **never** feeds public research or another tenant.

## One-liner

Permissioned inbox intelligence for sales and product teams. Two doors, two databases.

## Two doors (same product)

| Door | Who | Store | Charge (intent) |
|---|---|---|---|
| **Member** | Humans in the workspace | Tenant Signal DB | Plan / seat (Stripe path already in tree) |
| **Agentic (tenant)** | That tenant’s authorized agents | Tenant Signal DB (headless API) | Per-interaction / peek — **P5**, not shipped |
| **Agentic (public research)** | Paying research/agent clients | **Public research DB only** | Per-query — **P5**, not shipped |

Public agents do **not** peek tenant mail. They query the research store. Research (and marketing scrub) may pull *into* a tenant that opted in.

## What a signal is

A `Signal` (`src/signalData.ts`) is tenant-scoped: `type`, `severity`, `confidence`, `summary`, owner, optional source snippet, `status` `open | routed | dismissed`, optional CRM/task handoff.

**Queues the product shows**

| Queue | Meaning | Types seen in UI / seed (not yet one canon) |
|---|---|---|
| **Sales** | Buy, expand, renew, relationship risk | UI: `buying_intent`. Seed: `expansion_intent`, `renewal_risk` |
| **Product / service** | Ideas, asks, quality of the offering | `product_idea`, seed `product_request` |
| **Risk** | Drift, churn, escalation | UI: `relationship_risk`, `customer_risk` |

Route targets in code: `sales` · `product` · `customer_success` · `founder` · `crm`.

P4 must pick **one canonical type list**. Until then this table is the honesty layer.

## Loop

```
Connect mailbox (Gmail / Outlook, consent)
        → Detect (email-flows + signal_detection job; shared_detector — no LLM SDK in package.json)
        → Route / notify / digest (daily|weekly)
        → Handoff (crm | task)
        → Optional inbound enrich (public research from automatic worker, marketing scrub) → tenant DB only

Public channel (automatic, isolated):

```
Licensed / public feeds → public_sales_signal worker → Public research DB
        → public agentic API (pay per query)
        → optional cited enrich → tenant DB
```

The public worker is **required**, not a nice-to-have. It never opens tenant mailboxes.
```

## Who it is for

- Sales, product, success, founder inside a tenant (Member door).
- That tenant’s own or partner agents (Agentic tenant door) — after P5.
- Researchers / other agents buying **market** lookups (public research door) — after P5. Not customer inboxes.

Not CEO OS Neon `sales_signals`. Not Mission Control. Not QuoteWerks.

## Detector honesty

`ModelGovernancePolicy.detectorBoundary` is `shared_detector`. `learningMode` is `disabled | opt_in_tuning`. `package.json` has **no** model provider. Do not document Signal as an LLM product until a provider is wired and this file is amended.

## Success

A tenant connects a mailbox, a flow produces a sales or product signal with confidence + route, a human (or later an authorized agent) acts. Enrichment from research/mkt scrub is optional advantage, never a leak.
