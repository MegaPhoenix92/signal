# Signals, route, handoff

| Field | Value |
|-------|-------|
| **Slug** | `signals-route-handoff` |
| **Status** | `partial` |
| **Last reconciled** | 2026-08-19 |
| **Git SHA** | `18817990d33a1f3a970a44aae6567164358c86b8` |

## MVP boundary

**In:** `Signal` (status open/routed/dismissed), routing targets, CRM/task `SignalHandoff`, feedback, account recommendations, notifications/digests.

**Out:** Headless public peek. Neon `sales_signals` as SSoT.

## Capability matrix

| Capability | Status | Contract | Data | Surface |
|------------|--------|----------|------|---------|
| Signal record | shipped | `Signal` `src/signalData.ts` ~291 | `signals[]` | workspace + admin |
| Route targets | shipped | `RoutingTarget` | flows + rules | admin route actions |
| Handoff | partial | `SignalHandoff` crm \| task | handoffs[] | `signals handoff` CLI |
| Feedback | shipped | `useful \| noisy \| wrong_route \| …` | `signalFeedback` | admin feedback |
| Tenant agent API | stub | — | — | P5 |
| Public research API | stub | — | — | P5 |

## Gaps

| Gap | Severity | Evidence |
|-----|----------|----------|
| No versioned agent contract or meter | P2 | no `/api/v1/signals` machine SKU |
| Snippet fields exist — must default-deny on agent door | P1 for P5 | `sourceSnippet` on `Signal` |

## Change log

| Date | SHA | Summary |
|------|-----|---------|
| 2026-08-19 | `1881799` | Initial reconcile |
