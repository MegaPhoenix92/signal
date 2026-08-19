# Workspace + tenancy

| Field | Value |
|-------|-------|
| **Slug** | `workspace-tenancy` |
| **Status** | `partial` |
| **Last reconciled** | 2026-08-19 |
| **Git SHA** | `18817990d33a1f3a970a44aae6567164358c86b8` |

## MVP boundary

**In:** Tenants, users, memberships, invites, roles admin/member, tenant isolation mode, RLS on state-service tables.

**Out:** Row-level SQL per signal. Cross-tenant enrich.

## Capability matrix

| Capability | Status | Contract | Data | Surface |
|------------|--------|----------|------|---------|
| Tenant / user / membership | shipped | `signalData.ts` Tenant, User, TenantMembership | JSON body | register / workspace |
| App-level scope | shipped | `scopeStateForActor` (runbook + data helpers) | same blob | API |
| Postgres RLS | partial | `SIGNAL_TENANT_ISOLATION_MODE=rls` | `001-initial.sql` blob + backup tables | state-service startup |
| JWKS + signed session | partial | `signal-api-auth.mjs`, `test-signal-jwks-auth.mjs` | sessions | runbook §2 |

## Gaps

| Gap | Severity | Evidence |
|-----|----------|----------|
| RLS is on the monolith document, not per-signal rows | P1 (scale) | `001-initial.sql` |
| Local actor bypass must stay off in prod | P0 ops | `SIGNAL_ALLOW_LOCAL_ACTOR` runbook |

## Change log

| Date | SHA | Summary |
|------|-----|---------|
| 2026-08-19 | `1881799` | Initial reconcile |
