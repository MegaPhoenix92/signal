# Signal Production Runbook

This runbook is for Chris/operator execution of the production launch sequence for issues #72, #73, #74, and #75. It assumes the durable Postgres state-service code, JWKS/signed-session auth code, and Postgres RLS code are already present and covered by their local tests. This file documents operator actions and proof commands only; it must not contain live secrets.

Before starting, create `./.env.production` from `.env.production.example` outside git, replace placeholders with live values, and keep `SIGNAL_ALLOW_LOCAL_ACTOR` unset. `SIGNAL_ALLOW_LOCAL_ACTOR=true` is valid only for loopback development.

## 1. Provision durable Postgres and cut API to the external state service

OPERATOR-ONLY: Provision managed Postgres, create the Signal database/user, store the real database URL in the production secret manager, and start the state service with:

```bash
SIGNAL_STATE_SERVICE_BACKEND=postgres DATABASE_URL=<postgres-url> SIGNAL_STATE_SERVICE_TOKEN=<state-service-token> npm run state-service
```

Set the API to use:

```bash
SIGNAL_BACKEND_MODE=external-service
SIGNAL_STATE_SERVICE_URL=<state-service-url>
SIGNAL_STATE_SERVICE_TOKEN=<state-service-token>
```

Proof:

```bash
npm run admin -- backend --env-file ./.env.production --json
```

Expected: `backend.mode` is `external-service`, state-service storage is Postgres-backed, and `backend.productionReady` is true once the downstream auth, CORS, scheduler, and tenant-isolation env is also present.

## 2. Stand up IdP / JWKS and signed sessions

OPERATOR-ONLY: Create the production IdP/JWKS endpoint and configure:

```bash
SIGNAL_AUTH_PROVIDER=jwks
SIGNAL_AUTH_JWKS_URL=<jwks-url>
SIGNAL_REQUIRE_SIGNED_SESSION=true
SIGNAL_SESSION_SECRET=<at-least-32-character-random-secret>
SIGNAL_API_CORS_ORIGINS=<explicit-https-origin-list>
SIGNAL_COOKIE_SECURE=true
SIGNAL_WEBHOOK_ACTOR=<system-webhook-user-id>
SIGNAL_OAUTH_ACTOR=<system-oauth-user-id>
```

Remove `SIGNAL_ALLOW_LOCAL_ACTOR` from the production API environment.

Proof:

```bash
npm run test:jwks-auth
npm run admin -- provider-launch --env-file ./.env.production --json
```

Expected: JWKS auth tests pass, signed-session readiness is configured, and the provider launch report does not expose secret values.

## 3. Enable Postgres RLS tenant isolation

Set:

```bash
SIGNAL_TENANT_ISOLATION_MODE=rls
SIGNAL_STATE_SERVICE_RLS=true
SIGNAL_STATE_SERVICE_BACKEND=postgres
```

Apply state-service migrations on startup or with the managed deploy process. In RLS mode, the state service enables row-level security on its current and backup tables, creates service-role policies, and verifies `pg_policies` plus `relrowsecurity` before accepting traffic. Startup must fail if those policies are missing.

The state service currently stores one monolithic JSON state document plus backups. Postgres RLS protects those durable state-service tables and service-role access at the database boundary. Per-tenant record filtering inside the JSON document remains application-level and must continue to flow through `scopeStateForActor`, tenant membership, owner/team routing, and doctor/audit coverage.

Multi-tenant deployment notes:

- Use one shared production state-service boundary only after RLS startup verification passes.
- Tenant membership, role, and per-record JSON decisions remain application-level, while Postgres RLS protects the durable state tables from accidental cross-tenant reads/writes at the database boundary.
- Do not launch multiple customer organizations on the shared backend if `SIGNAL_TENANT_ISOLATION_MODE` is not `rls` or if `SIGNAL_STATE_SERVICE_RLS` is not true.
- Keep migrations and `pg_policies` verification in the deploy checklist for every schema change that touches state-service tables.

Proof:

```bash
npm run test:tenant-isolation
npm run test:state-service
npm run admin -- tenant-isolation --env-file ./.env.production --json
```

Expected: tenant-isolation tests pass, state-service RLS policy verification passes, and the report shows `productionOk`.

## 4. Load live provider secrets and save sandbox evidence

OPERATOR-ONLY: Load the 17 required provider/auth credential names into the production secret manager:

```bash
SIGNAL_SESSION_SECRET
SIGNAL_GMAIL_CLIENT_ID
SIGNAL_GMAIL_CLIENT_SECRET
SIGNAL_GMAIL_REDIRECT_URI
SIGNAL_TOKEN_ENCRYPTION_KEY
SIGNAL_OUTLOOK_CLIENT_ID
SIGNAL_OUTLOOK_CLIENT_SECRET
SIGNAL_OUTLOOK_TENANT_ID
SIGNAL_OUTLOOK_REDIRECT_URI
SIGNAL_EMAIL_PROVIDER_URL
SIGNAL_EMAIL_PROVIDER_TOKEN
SIGNAL_EMAIL_FROM
SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
SIGNAL_STRIPE_PRICE_TEAM
SIGNAL_SENDGRID_API_KEY
```

Also configure the sandbox validation credentials needed by the provider evidence gate:

```bash
SIGNAL_GMAIL_ACCESS_TOKEN
SIGNAL_OUTLOOK_ACCESS_TOKEN
```

Run sandbox validation and save sanitized evidence:

```bash
npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json
```

Refresh scheduled sandbox evidence explicitly before launch or after a stale/blocked report:

```bash
npm run admin -- integrations refresh-evidence --save-evidence ./signal-provider-evidence.json --json
```

Import or verify evidence when moving it between environments:

```bash
npm run admin -- integrations evidence-import ./signal-provider-evidence.json --json
npm run admin -- integrations evidence-export latest ./signal-provider-evidence.verify.json --json
```

Proof:

```bash
npm run admin -- provider-launch --env-file ./.env.production --json
npm run admin -- launch-gate --env-file ./.env.production --json
npm run admin -- operations-health --env-file ./.env.production --json
npm run admin -- doctor --json
```

Expected: `launch.summary.readyProviders` is `5/5`, provider sandbox statuses are passed where required, freshness blockers are empty, and no raw credential values are serialized into state or evidence.

Freshness failure playbook:

- `sandbox_evidence_missing`: run `integrations refresh-evidence --save-evidence`, then rerun `provider-launch` and `launch-gate`.
- `sandbox_evidence_not_passed`: inspect the provider rows for `missingRequired` or failed checks, rotate/fix the sandbox credential, then rerun the refresh command.
- `sandbox_evidence_stale` or `provider_validation_schedule_overdue`: run `integrations refresh-evidence --save-evidence`; if it stays overdue, verify `SIGNAL_PROVIDER_VALIDATION_SCHEDULER=signal-scheduler` and the managed scheduler heartbeat.
- `provider_validation_latest_evidence` fails in `doctor`: the latest saved run is blocked or failed; do not package launch evidence until a passed run replaces it.

## 4a. Rehearse Stripe billing exception handling

Before enabling paid production traffic, run the payment lifecycle audit and verify the exception rows are locally covered:

```bash
npm run admin -- payment-lifecycle --json
```

Operational drills:

```bash
# Valid signed-but-unknown Stripe event: record as ignored, do not fail the webhook worker.
STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-unknown-event.json <Stripe-Signature>

# Invoice status coverage for local simulation or signed replay fixtures.
npm run admin -- payments webhook invoice.draft sub_demo --amount 4900
npm run admin -- payments webhook invoice.uncollectible sub_demo --amount 4900

# Refunds and support credits: record ledger impact without storing card data.
npm run admin -- payments refund <invoiceId> 2500 Courtesy_credit
npm run admin -- payments override tenant_demo support_credit Support_credit 2500

# Provider parity: run before launch evidence packaging and after manual billing actions.
npm run admin -- payments sync tenant_demo --live-provider
```

Expected: `payment-lifecycle.rows` includes local-ready evidence for ignored webhook resilience, all invoice statuses, trial/plan-change events, refund/credit reconciliation, and provider-state parity. Unknown Stripe events should appear as ignored payment events, not failed `billing_webhook` jobs. Any `billing.drift.detected` lifecycle notice must be resolved before final launch evidence is packaged.

## 4b. Reconcile cross-domain provider drift

Before packaging launch evidence, run live-provider parity sync for every domain where admin overrides or provider-side changes can diverge from local state:

```bash
npm run admin -- email-flows sync tenant_demo --live-provider
npm run admin -- signals sync tenant_demo --live-provider
npm run admin -- accounts sync tenant_demo --live-provider
npm run admin -- operations-health --json
npm run admin -- digestion-pipeline --json
```

Expected: `launch-gate` includes `provider_parity_drift`, `operations-health.summary.openDriftEvents` is `0`, `digestion-pipeline.rows` includes `provider_parity_drift`, and any `email_drift_detected`, `signal_drift_detected`, or `account_drift_detected` lifecycle notice is resolved by a subsequent clean live-provider sync. Local runs without `--live-provider` are proof-only and must not require live provider credentials.

## 5. Deploy the managed scheduler daemon and alerting

OPERATOR-ONLY: Deploy exactly one managed scheduler runner against the production state-service boundary and wire alerts:

```bash
SIGNAL_JOB_SCHEDULER=signal-scheduler
SIGNAL_PROVIDER_VALIDATION_SCHEDULER=signal-scheduler
SIGNAL_SCHEDULER_LOCK_POLICY=single-runner
SIGNAL_OPERATIONS_ALERT_CHANNEL=<ops-alert-channel>
SIGNAL_OPERATIONS_RUNBOOK_URL=<runbook-url>
```

Dry-run first:

```bash
npm run scheduler -- --once --dry-run --json
```

Then run one managed tick before enabling continuous scheduling:

```bash
SIGNAL_JOB_SCHEDULER=signal-scheduler SIGNAL_PROVIDER_VALIDATION_SCHEDULER=signal-scheduler npm run scheduler -- --once --json
```

Proof:

```bash
npm run admin -- operations-health --env-file ./.env.production --json
```

Expected: `operations.backend.schedulerReady` is true, queues are clean, provider schedules are active, and alert routing is documented.

## 6. Rehearse backup, verify, and restore

OPERATOR-ONLY: Run the rehearsal against the managed state-service URL and store the backup artifact outside app state.

```bash
npm run state-service:admin -- backup ./signal-prod-backup.json --json
npm run state-service:admin -- verify ./signal-prod-backup.json --json
npm run state-service:admin -- restore ./signal-prod-backup.json --dry-run --json
```

Proof:

```bash
npm run admin -- production-drill --env-file ./.env.production --json
```

Expected: `backup_restore_rehearsal` is production-ready, the backup digest verifies, and restore dry-run succeeds before any destructive restore.

## 7. Final launch gate

Run the final go/no-go check:

```bash
npm run admin -- launch-gate --env-file ./.env.production --json
```

Expected: all launch gates pass. If any row is blocked, keep production traffic off the new deployment and resolve the named blocker before rerunning the gate.

Optional redacted evidence package:

```bash
npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json
npm run admin -- launch-gate verify-package ./signal-launch-evidence.json --json
```
