# Email flows + detect

| Field | Value |
|-------|-------|
| **Slug** | `email-flows-detect` |
| **Status** | `partial` |
| **Last reconciled** | 2026-08-19 |
| **Git SHA** | `18817990d33a1f3a970a44aae6567164358c86b8` |

## MVP boundary

**In:** `EmailFlow` (`detects[]`, `routeTo`, enable/disable/run). Shared detector policy. Digestion pipeline admin/API.

**Out:** LLM detector, per-tenant trained models as default, using tenant mail to train public research.

## Capability matrix

| Capability | Status | Contract | Data | Surface |
|------------|--------|----------|------|---------|
| Flow type | shipped | `EmailFlow` `src/signalData.ts` ~225 | `emailFlows` in app state | Admin email-flows strip |
| Run / route mutations | shipped | `email-flows.run` `enable` `disable` `route` | same | `AdminConsole.tsx` |
| Detector governance | shipped as policy | `ModelGovernancePolicy` `shared_detector` | policies in state | `models` CLI |
| Type canon | **gap** | UI cards vs seed strings | seed + `AppSurface.tsx` | P4 honesty / P5 fix |

## Gaps

| Gap | Severity | Evidence |
|-----|----------|----------|
| Type strings disagree (UI `buying_intent` vs seed `expansion_intent` / `email_signal`) | P1 | `AppSurface.tsx` ~220; `sample-seed.json` |
| No model SDK — “scores thread clusters” on landing is narrative | P2 | `package.json` deps; landing copy |
| `node:test` covers jobs/scheduler; live detector quality unproven | P2 | `test-signal-scheduler.mjs` |

## Change log

| Date | SHA | Summary |
|------|-----|---------|
| 2026-08-19 | `1881799` | Initial reconcile |
