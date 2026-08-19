# Inbound enrich + marketing scrub

| Field | Value |
|-------|-------|
| **Slug** | `inbound-enrichment` |
| **Status** | `stub` |
| **Last reconciled** | 2026-08-19 |
| **Git SHA** | `18817990d33a1f3a970a44aae6567164358c86b8` |

## MVP boundary

**In (locked, not built):** one-way **tenant advantage**.

1. **Public research enrich** — market corpus (separate DB) may attach cited context onto a tenant signal.
2. **Marketing scrub** — automation that **updates the tenant DB** (list hygiene, consent, campaign tags). Tenant-authorized.

**Out:** tenant mail or snippets → public research; Tenant A → Tenant B; dual-write to Neon; public agents reading tenant digest.

## Capability matrix

| Capability | Status | Contract | Data | Surface |
|------------|--------|----------|------|---------|
| Research store | stub | — | new DB, not `001-initial.sql` blob | P5 public agent API |
| Enrich into tenant | stub | — | tenant JSON / later query store | P5 job |
| Mkt scrub → tenant | stub | — | tenant DB only | P5 automation |
| Leak tenant → public | **forbidden** | [BOUNDARY.md](../BOUNDARY.md) | — | never |

## Gaps

| Gap | Severity | Evidence |
|-----|----------|----------|
| No research schema or ingest | P2 | no code |
| No scrub job | P2 | no code |
| Blob state is a poor research query engine | P1 for P5 | `001-initial.sql` |

## Change log

| Date | SHA | Summary |
|------|-----|---------|
| 2026-08-19 | `1881799` | Locked as stub after Chris: tenant advantage + mkt scrub inbound |
