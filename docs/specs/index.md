# Signal spec rollup

Last updated: **2026-08-19** · git `1881799` · owner reconcile (not `/spec --apply`)

Status = code truth. `stub` = locked in PRODUCT/BOUNDARY, not implemented.

| Feature | Slug | Status | Notes |
|---------|------|--------|--------|
| Mailbox ingest | [mailbox-ingest](./mailbox-ingest.md) | `partial` | Gmail/Outlook OAuth, watch, sync |
| Email flows + detect | [email-flows-detect](./email-flows-detect.md) | `partial` | Flows exist; type strings not canonical |
| Signals, route, handoff | [signals-route-handoff](./signals-route-handoff.md) | `partial` | CRM/task handoff types exist |
| Workspace + tenancy | [workspace-tenancy](./workspace-tenancy.md) | `partial` | App scope + RLS on JSON blob |
| Billing (Stripe) | [billing-stripe](./billing-stripe.md) | `partial` | Webhooks + known 2026-06 billing bugs closed |
| Admin + launch gate | [admin-launch-gate](./admin-launch-gate.md) | `shipped` | CLI + [PRODUCTION_RUNBOOK.md](../PRODUCTION_RUNBOOK.md) |
| Inbound enrich + mkt scrub | [inbound-enrichment](./inbound-enrichment.md) | `stub` | Tenant advantage — P5 |

## Module map

```
Connect mailboxes → Detect flows → Signals / actions → Member UI
                                              ↘ (P5) tenant agent API
Public research + mkt scrub ──inbound only──▶ tenant store
```

## Refresh

Re-read `src/signalData.ts` + `scripts/signal-api.mjs` + this SHA. Do not invent endpoints. When TROZLAN `/spec` is wired here, run it; until then this index is hand-reconciled.
