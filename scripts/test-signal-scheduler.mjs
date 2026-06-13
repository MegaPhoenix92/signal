#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  bootstrapState,
  doctor,
  drainJobs,
  enforceStateRetention,
  handlePaymentWebhook,
  jobClaimable,
  launchGateReport,
  loadState,
  operationsHealthReport,
  providerLaunchMatrixReport,
  providerReadiness,
  providerValidationSchedulesDue,
  requeueDeadLetterJob,
  requeueDeadLetterJobs,
  runJobs,
  saveState,
  signalDigestionPipelineReport,
  stateCollectionLimits,
} from './signal-state.mjs';
import {
  backendReadiness,
} from './signal-backend-readiness.mjs';
import {
  acquirePostgresSchedulerLock,
  acquireSchedulerLock,
  createSchedulerConfig,
  refreshSchedulerLock,
  runSchedulerOnce,
  schedulerDueSummary,
} from './signal-scheduler.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function productionEnv(overrides = {}) {
  return {
    DATABASE_URL: 'postgres://signal:<redacted>@db.example/signal',
    NODE_ENV: 'production',
    SIGNAL_API_CORS_ORIGINS: 'https://app.signal.example',
    SIGNAL_AUTH_JWKS_URL: 'https://auth.signal.example/.well-known/jwks.json',
    SIGNAL_AUTH_PROVIDER: 'jwks',
    SIGNAL_BACKEND_MODE: 'external-service',
    SIGNAL_COOKIE_SECURE: 'true',
    SIGNAL_EMAIL_FROM: 'alerts@signal.example',
    SIGNAL_EMAIL_PROVIDER_TOKEN: 'email-token',
    SIGNAL_EMAIL_PROVIDER_URL: 'https://email.signal.example/send',
    SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET: 'email-webhook-secret',
    SIGNAL_GMAIL_CLIENT_ID: 'gmail-client',
    SIGNAL_GMAIL_CLIENT_SECRET: 'gmail-secret',
    SIGNAL_GMAIL_REDIRECT_URI: 'https://api.signal.example/api/oauth/gmail/callback',
    SIGNAL_JOB_SCHEDULER: 'signal-scheduler',
    SIGNAL_LAUNCH_BACKUP_REHEARSAL_MAX_AGE_DAYS: '30',
    SIGNAL_LAUNCH_SANDBOX_EVIDENCE_MAX_AGE_DAYS: '7',
    SIGNAL_LAUNCH_SCHEDULE_OVERDUE_GRACE_HOURS: '24',
    SIGNAL_LAUNCH_SCHEDULER_HEARTBEAT_MAX_AGE_HOURS: '1',
    SIGNAL_OPERATIONS_ALERT_CHANNEL: 'ops-oncall',
    SIGNAL_OUTLOOK_CLIENT_ID: 'outlook-client',
    SIGNAL_OUTLOOK_CLIENT_SECRET: 'outlook-secret',
    SIGNAL_OUTLOOK_REDIRECT_URI: 'https://api.signal.example/api/oauth/outlook/callback',
    SIGNAL_OUTLOOK_TENANT_ID: 'tenant',
    SIGNAL_PROVIDER_VALIDATION_SCHEDULER: 'signal-scheduler',
    SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
    SIGNAL_SENDGRID_API_KEY: 'sendgrid-key',
    SIGNAL_SESSION_SECRET: 'session-secret-32chars',
    SIGNAL_STATE_RESTORE_REHEARSAL_AT: new Date().toISOString(),
    SIGNAL_STATE_SERVICE_BACKEND: 'postgres',
    SIGNAL_STATE_SERVICE_RLS: 'true',
    SIGNAL_STATE_SERVICE_TOKEN: 'state-service-token',
    SIGNAL_STATE_SERVICE_URL: 'https://state.signal.example/state',
    SIGNAL_STRIPE_PRICE_TEAM: 'price_team',
    SIGNAL_TENANT_ISOLATION_MODE: 'rls',
    SIGNAL_TOKEN_ENCRYPTION_KEY: 'token-encryption-key-32chars',
    STRIPE_SECRET_KEY: 'sk_test_placeholder',
    STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
    ...overrides,
  };
}

function passedProviderValidationRun({ recordedAt = new Date().toISOString(), id = 'pvr_fresh' } = {}) {
  const providers = [
    { id: 'gmail', label: 'Gmail', category: 'email', status: 'passed', missingRequired: [], checks: [] },
    { id: 'outlook', label: 'Outlook', category: 'email', status: 'passed', missingRequired: [], checks: [] },
    { id: 'sendgrid', label: 'SendGrid', category: 'email', status: 'passed', missingRequired: [], checks: [] },
    { id: 'stripe', label: 'Stripe', category: 'payment', status: 'passed', missingRequired: [], checks: [] },
  ];
  return {
    id,
    generatedAt: recordedAt,
    ok: true,
    providers,
    recordedAt,
    recordedByUserId: 'usr_admin',
    reportDigest: `digest_${id}`,
    status: 'passed',
    summary: { blocked: 0, failed: 0, passed: providers.length, total: providers.length },
  };
}

async function makeProductionEvidenceState(statePath, {
  providerRunAt = new Date().toISOString(),
  scheduleNextRunAt = '2099-01-01T00:00:00.000Z',
} = {}) {
  await bootstrapState({ force: true, statePath });
  const state = await loadState({ statePath });
  state.providerValidationRuns = [passedProviderValidationRun({ recordedAt: providerRunAt })];
  (state.providerValidationSchedules ?? []).forEach((schedule) => {
    schedule.status = 'active';
    schedule.lastRunAt = providerRunAt;
    schedule.lastRunId = state.providerValidationRuns[0].id;
    schedule.lastRunStatus = 'passed';
    schedule.nextRunAt = scheduleNextRunAt;
  });
  state.schedulerHeartbeat = {
    failed: 0,
    finishedAt: new Date().toISOString(),
    ok: true,
    queues: ['provider_validation'],
    ran: 1,
    recordedAt: new Date().toISOString(),
    statePath,
    workerId: 'test-scheduler',
  };
  await saveState(state, { statePath });
  return loadState({ statePath });
}

async function forceProviderValidationDue(statePath) {
  const state = await loadState({ statePath });
  (state.providerValidationSchedules ?? []).forEach((schedule) => {
    if (schedule.status === 'active' && schedule.cadence !== 'manual') {
      schedule.nextRunAt = '2026-01-01T00:00:00.000Z';
    }
  });
  const job = state.jobs.find((candidate) => candidate.queue === 'provider_validation');
  if (job) {
    job.status = 'queued';
    job.nextRunAt = null;
  }
  await saveState(state, { statePath });
  return loadState({ statePath });
}

test('Signal scheduler dry-run reports due queues without mutating state', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-scheduler-dry-run-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const lockFile = path.join(tempDir, 'scheduler.lock');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const before = await forceProviderValidationDue(statePath);
  assert(providerValidationSchedulesDue(before).length > 0, 'bootstrap state should have a due provider validation schedule');
  const beforeAuditCount = before.auditEvents.length;
  const config = createSchedulerConfig({
    argv: ['--once', '--dry-run', '--queue', 'provider_validation', '--limit', '1', '--lock-file', lockFile],
    env: { SIGNAL_ADMIN_STATE: statePath },
  });

  const result = await runSchedulerOnce(config);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.queues[0].queue, 'provider_validation');
  assert.equal(result.queues[0].due, 1);
  const after = await loadState({ statePath });
  assert.equal(after.auditEvents.length, beforeAuditCount, 'dry-run should not append audit events');
  assert.equal((after.providerValidationRuns ?? []).length, (before.providerValidationRuns ?? []).length, 'dry-run should not record provider validation evidence');
});

test('Signal scheduler runs due provider validation through the audited job boundary', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-scheduler-run-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const lockFile = path.join(tempDir, 'scheduler.lock');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const before = await forceProviderValidationDue(statePath);
  const beforeRuns = before.providerValidationRuns.length;
  const config = createSchedulerConfig({
    argv: ['--once', '--queue', 'provider_validation', '--limit', '1', '--lock-file', lockFile],
    env: {
      SIGNAL_ADMIN_STATE: statePath,
      SIGNAL_PROVIDER_SANDBOX_TIMEOUT_MS: '1000',
    },
  });

  const result = await runSchedulerOnce(config);
  assert.equal(result.ok, true);
  assert.equal(result.ran, 1);
  assert.equal(result.outcomes[0].queue, 'provider_validation');
  assert.equal(result.outcomes[0].count, 1);
  const after = await loadState({ statePath });
  assert.equal(after.providerValidationRuns.length, beforeRuns + 1);
  assert(after.auditEvents.some((event) => event.action === 'jobs.run' && event.actor === 'usr_admin'));
  const providerValidationJob = after.jobs.find((job) => job.queue === 'provider_validation');
  assert.equal(providerValidationJob?.status, 'queued');
  assert(providerValidationJob?.nextRunAt, 'recurring provider validation job should advance nextRunAt after running');
});

test('Signal scheduler drains due provider validation, governance, and email sync queues on once', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-scheduler-drain-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const lockFile = path.join(tempDir, 'scheduler.lock');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const state = await forceProviderValidationDue(statePath);
  const connectedMailbox = state.mailboxes.find((mailbox) => mailbox.status === 'connected');
  assert(connectedMailbox, 'bootstrap state should include a connected mailbox');
  state.jobs = state.jobs.filter((job) => job.queue !== 'email_sync');
  state.jobs.push(
    {
      id: 'job_governance_due',
      tenantId: connectedMailbox.tenantId,
      queue: 'governance',
      type: 'data_request.export.review',
      targetId: 'dsr_scheduler_drain',
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      nextRunAt: null,
      message: 'drain governance work',
    },
    {
      id: 'job_email_due_1',
      tenantId: connectedMailbox.tenantId,
      queue: 'email_sync',
      type: 'mailbox.sync',
      targetId: connectedMailbox.id,
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      nextRunAt: null,
      message: 'drain first email sync',
    },
    {
      id: 'job_email_due_2',
      tenantId: connectedMailbox.tenantId,
      queue: 'email_sync',
      type: 'mailbox.sync',
      targetId: connectedMailbox.id,
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      nextRunAt: null,
      message: 'drain second email sync',
    },
  );
  await saveState(state, { statePath });

  const config = createSchedulerConfig({
    argv: ['--once', '--queues', 'provider_validation,governance,email_sync', '--limit', '1', '--lock-file', lockFile],
    env: {
      SIGNAL_ADMIN_STATE: statePath,
      SIGNAL_PROVIDER_SANDBOX_TIMEOUT_MS: '1000',
    },
  });

  const result = await runSchedulerOnce(config);
  assert.equal(result.ok, true);
  assert.equal(result.ran, 4);
  assert.equal(result.outcomes.find((outcome) => outcome.queue === 'provider_validation')?.count, 1);
  assert.equal(result.outcomes.find((outcome) => outcome.queue === 'governance')?.count, 1);
  assert.equal(result.outcomes.find((outcome) => outcome.queue === 'email_sync')?.count, 2);

  const after = await loadState({ statePath });
  const due = schedulerDueSummary(after, {
    leaseMs: config.jobLeaseMs,
    limit: 10,
    queues: ['provider_validation', 'governance', 'email_sync'],
  });
  assert.deepEqual(due.map((queue) => queue.due), [0, 0, 0]);
});

test('Signal scheduler stress drains concurrent digestion queues and retries billing without double-applying events', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-scheduler-cross-domain-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const lockFile = path.join(tempDir, 'scheduler.lock');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  let state = await loadState({ statePath });
  const connectedMailbox = state.mailboxes.find((mailbox) => mailbox.id === 'mbx_gmail_sales' && mailbox.status === 'connected');
  assert(connectedMailbox, 'scheduler stress requires the seeded connected Gmail mailbox');
  const paymentEventCount = state.paymentEvents.length;
  const sourceMessageCount = state.sourceMessages.length;
  const flowRunCount = state.flowRuns.length;
  const digestRunCount = state.notificationDigestRuns.length;
  const deliveryMessageCount = state.emailDeliveryMessages.length;
  const targetQueues = new Set(['email_sync', 'signal_detection', 'billing_webhook', 'notification_digest']);
  state.jobs = state.jobs.filter((job) => !targetQueues.has(job.queue));
  state.invoices.push({
    id: 'inv_scheduler_matrix_missing_subscription',
    tenantId: 'tenant_demo',
    subscriptionId: 'sub_scheduler_matrix_missing',
    provider: 'local_test',
    status: 'past_due',
    amountDueCents: 4900,
    currency: 'usd',
    hostedInvoiceUrl: 'signal://billing/invoice/tenant_demo/inv_scheduler_matrix_missing_subscription',
    createdAt: '2026-06-13T00:00:00.000Z',
    dueAt: '2026-06-20T00:00:00.000Z',
    retryCount: 1,
    nextPaymentAttemptAt: null,
    creditedCents: 0,
    refundedCents: 0,
  });
  state.jobs.push(
    {
      id: 'job_matrix_email_sync',
      tenantId: 'tenant_demo',
      queue: 'email_sync',
      type: 'mailbox.sync',
      targetId: connectedMailbox.id,
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      nextRunAt: null,
      message: 'Stress email sync and detector handoff.',
    },
    {
      id: 'job_matrix_signal_detection',
      tenantId: 'tenant_demo',
      queue: 'signal_detection',
      type: 'email_flow.run',
      targetId: 'tenant_demo',
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      nextRunAt: null,
      message: 'Stress signal detection worker.',
    },
    {
      id: 'job_matrix_billing_reconcile',
      tenantId: 'tenant_demo',
      queue: 'billing_webhook',
      type: 'payment.webhook.invoice.payment_failed',
      targetId: 'inv_demo_open',
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      nextRunAt: null,
      message: 'Stress billing reconciliation without webhook replay.',
    },
    {
      id: 'job_matrix_billing_retry',
      tenantId: 'tenant_demo',
      queue: 'billing_webhook',
      type: 'payment.webhook.invoice.payment_failed',
      targetId: 'inv_scheduler_matrix_missing_subscription',
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      nextRunAt: null,
      message: 'Stress billing retry when subscription is temporarily missing.',
    },
    {
      id: 'job_matrix_notification_digest',
      tenantId: 'tenant_demo',
      queue: 'notification_digest',
      type: 'notifications.digest.prepare_delivery',
      targetId: 'tenant_demo',
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      nextRunAt: null,
      message: 'Stress notification digest worker.',
    },
  );
  await saveState(state, { statePath });

  const config = createSchedulerConfig({
    argv: ['--once', '--queues', 'email_sync,signal_detection,billing_webhook,notification_digest', '--limit', '10', '--lock-file', lockFile],
    env: { SIGNAL_ADMIN_STATE: statePath },
  });
  const result = await runSchedulerOnce(config);
  assert.equal(result.ok, false, 'one billing retry job should fail while the other queues still drain');
  assert.equal(result.ran, 5);
  assert.equal(result.outcomes.find((outcome) => outcome.queue === 'email_sync')?.succeeded, 1);
  assert.equal(result.outcomes.find((outcome) => outcome.queue === 'signal_detection')?.succeeded, 1);
  assert.equal(result.outcomes.find((outcome) => outcome.queue === 'notification_digest')?.succeeded, 1);
  assert.equal(result.outcomes.find((outcome) => outcome.queue === 'billing_webhook')?.succeeded, 1);
  assert.equal(result.outcomes.find((outcome) => outcome.queue === 'billing_webhook')?.failed, 1);

  state = await loadState({ statePath });
  assert.equal(state.paymentEvents.length, paymentEventCount, 'scheduler billing reconciliation must not append duplicate payment events');
  assert(state.sourceMessages.length >= sourceMessageCount, 'email sync should preserve or grow source-message state');
  assert(state.flowRuns.length >= flowRunCount + 2, 'email sync plus signal_detection should record detector flow runs');
  assert(state.notificationDigestRuns.length > digestRunCount, 'notification digest queue should record a digest run');
  assert(state.emailDeliveryMessages.length >= deliveryMessageCount, 'notification digest queue should preserve delivery ledger rows');
  assert.equal(state.jobs.find((job) => job.id === 'job_matrix_email_sync')?.status, 'succeeded');
  assert.equal(state.jobs.find((job) => job.id === 'job_matrix_signal_detection')?.status, 'succeeded');
  assert.equal(state.jobs.find((job) => job.id === 'job_matrix_notification_digest')?.status, 'succeeded');
  assert.equal(state.jobs.find((job) => job.id === 'job_matrix_billing_reconcile')?.status, 'succeeded');
  const retryJob = state.jobs.find((job) => job.id === 'job_matrix_billing_retry');
  assert.equal(retryJob?.status, 'queued');
  assert.equal(retryJob?.attempts, 1);
  assert(retryJob?.nextAttemptAt, 'failed billing job should be rescheduled with backoff');
  assert.equal(retryJob?.failureHistory?.length, 1);
  const pipeline = signalDigestionPipelineReport(state, { statePath });
  assert(pipeline.rows.some((row) => row.area === 'detector_execution' && row.localOk === true));
  assert(pipeline.rows.some((row) => row.area === 'routing_and_user_outcomes' && row.localOk === true));
  assert.equal(state.schedulerHeartbeat?.ok, false, 'failed stress tick should record scheduler heartbeat evidence');
  assert.equal(state.schedulerHeartbeat?.ran, 5);

  retryJob.nextAttemptAt = '2026-01-01T00:00:00.000Z';
  retryJob.nextRunAt = retryJob.nextAttemptAt;
  state.subscriptions.push({
    id: 'sub_scheduler_matrix_missing',
    tenantId: 'tenant_demo',
    provider: 'local_test',
    planId: 'plan_team',
    status: 'past_due',
  });
  await saveState(state, { statePath });

  const retryConfig = createSchedulerConfig({
    argv: ['--once', '--queue', 'billing_webhook', '--limit', '10', '--lock-file', lockFile],
    env: { SIGNAL_ADMIN_STATE: statePath },
  });
  const retryRun = await runSchedulerOnce(retryConfig);
  assert.equal(retryRun.ok, true);
  assert.equal(retryRun.ran, 1);

  state = await loadState({ statePath });
  assert.equal(state.jobs.find((job) => job.id === 'job_matrix_billing_retry')?.status, 'succeeded');
  assert.equal(state.invoices.find((invoice) => invoice.id === 'inv_scheduler_matrix_missing_subscription')?.nextPaymentAttemptAt !== null, true);
  assert.equal(state.paymentEvents.length, paymentEventCount, 'billing retry should reconcile without replaying payment events');
  assert.equal(
    state.jobs.filter((job) => job.id.startsWith('job_matrix_') && ['queued', 'running', 'failed'].includes(job.status)).length,
    0,
  );
});

test('Signal scheduler auto-renews provider watches expiring within 24h', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-scheduler-watch-renew-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const lockFile = path.join(tempDir, 'scheduler.lock');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const state = await loadState({ statePath });
  const mailbox = state.mailboxes.find((candidate) => candidate.provider === 'gmail' && candidate.status === 'connected');
  assert(mailbox, 'bootstrap state should include a connected Gmail mailbox');
  state.emailWatchSubscriptions = [{
    id: 'watch_gmail_expiring',
    tenantId: mailbox.tenantId,
    mailboxId: mailbox.id,
    provider: mailbox.provider,
    status: 'active',
    expirationAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    notificationUrl: 'https://api.signal.example/api/webhooks/gmail',
    providerWatchId: 'gmail-watch-old',
    createdAt: new Date().toISOString(),
    renewalCount: 0,
  }];
  await saveState(state, { statePath });

  const config = createSchedulerConfig({
    argv: ['--once', '--queue', 'governance', '--lock-file', lockFile],
    env: { SIGNAL_ADMIN_STATE: statePath },
  });
  const result = await runSchedulerOnce(config);
  assert.equal(result.ok, true);
  assert.equal(result.watchRenewals.count, 1);
  assert.equal(result.watchRenewals.succeeded, 1);

  const after = await loadState({ statePath });
  const renewed = after.emailWatchSubscriptions.find((watch) => watch.id === 'watch_gmail_expiring');
  assert.equal(renewed.status, 'active');
  assert(Date.parse(renewed.expirationAt) > Date.now() + 24 * 60 * 60 * 1000, 'renewed watch should no longer expire within 24h');
  assert.equal(renewed.renewalCount, 1);
  assert(after.auditEvents.some((event) => event.action === 'mailboxes.watch-renew' && event.targetId === mailbox.id));
});

test('Signal scheduler failed watch renewal records lifecycle notice, audit event, and operations alert', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-scheduler-watch-fail-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const lockFile = path.join(tempDir, 'scheduler.lock');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const state = await loadState({ statePath });
  const mailbox = state.mailboxes.find((candidate) => candidate.provider === 'gmail' && candidate.status === 'connected');
  assert(mailbox, 'bootstrap state should include a connected Gmail mailbox');
  state.emailWatchSubscriptions = [{
    id: 'watch_gmail_failure',
    tenantId: mailbox.tenantId,
    mailboxId: mailbox.id,
    provider: mailbox.provider,
    status: 'active',
    expirationAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    notificationUrl: 'https://api.signal.example/api/webhooks/gmail',
    providerWatchId: 'gmail-watch-old',
    createdAt: new Date().toISOString(),
    renewalCount: 0,
  }];
  await saveState(state, { statePath });

  const fetchImpl = async () => ({
    headers: { get: () => null },
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ error: { code: 'forbidden', message: 'denied', status: 'PERMISSION_DENIED' } }),
  });
  const config = createSchedulerConfig({
    argv: ['--once', '--queue', 'governance', '--lock-file', lockFile, '--live-provider'],
    env: {
      SIGNAL_ADMIN_STATE: statePath,
      SIGNAL_GMAIL_ACCESS_TOKEN: 'fake-gmail-token',
      SIGNAL_OPERATIONS_ALERT_CHANNEL: 'ops-oncall',
      SIGNAL_PROVIDER_WATCH_MODE: 'live',
    },
  });

  const result = await runSchedulerOnce(config, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.watchRenewals.failed, 1);

  const after = await loadState({ statePath });
  const failedWatch = after.emailWatchSubscriptions.find((watch) => watch.id === 'watch_gmail_failure');
  assert.equal(failedWatch.status, 'failed');
  assert.equal(failedWatch.providerResponseStatus, 403);
  assert(after.lifecycleNotices.some((notice) => notice.sourceIds?.watchId === failedWatch.id && notice.trigger === 'provider_watch_attention'));
  assert(after.auditEvents.some((event) => event.action === 'mailboxes.watch-renew' && event.targetId === mailbox.id));
  assert(after.auditEvents.some((event) => event.action === 'scheduler.alert'));
  assert(after.notificationEvents.some((event) => event.channel === 'ops-oncall' && event.type === 'operations.scheduler.watch_renew_failed'));
  assert(!JSON.stringify(after).includes('fake-gmail-token'), 'provider access token must not be stored in state');
});

test('Signal scheduler config parses interval, queues, actor, and limits', () => {
  const config = createSchedulerConfig({
    argv: ['--once', '--queue', 'email_sync', '--queue', 'provider_validation', '--limit', '2', '--interval-ms', '1500', '--actor', 'usr_admin'],
    env: {
      SIGNAL_ADMIN_STATE: '/tmp/signal-state.json',
      SIGNAL_SCHEDULER_LOCK_FILE: '/tmp/signal-scheduler.lock',
    },
  });
  assert.equal(config.actorUserId, 'usr_admin');
  assert.equal(config.intervalMs, 1500);
  assert.equal(config.limit, 2);
  assert.deepEqual(config.queues, ['email_sync', 'provider_validation']);
});

test('Signal scheduler lock prevents concurrent one-shot runs', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-scheduler-lock-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const lockFile = path.join(tempDir, 'scheduler.lock');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const config = createSchedulerConfig({
    argv: ['--once', '--dry-run', '--queue', 'provider_validation', '--lock-file', lockFile],
    env: { SIGNAL_ADMIN_STATE: statePath },
  });
  const lock = await acquireSchedulerLock(config);
  assert.equal(lock.acquired, true);
  try {
    const result = await runSchedulerOnce(config);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'lock_held');
  } finally {
    await lock.release();
  }
});

test('Signal scheduler CLI emits JSON dry-run output', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-scheduler-cli-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const lockFile = path.join(tempDir, 'scheduler.lock');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(rootDir, 'scripts', 'signal-scheduler.mjs'),
    '--once',
    '--dry-run',
    '--json',
    '--queue',
    'provider_validation',
    '--lock-file',
    lockFile,
  ], {
    cwd: rootDir,
    env: {
      ...process.env,
      SIGNAL_ADMIN_STATE: statePath,
    },
    maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.queues[0].queue, 'provider_validation');
});

test('Signal scheduler due summary reports waiting jobs and excludes active leases', () => {
  const now = Date.parse('2026-06-04T12:00:00.000Z');
  const leaseMs = 300_000;
  const state = {
    jobs: [
      { id: 'job_due', queue: 'email_sync', status: 'queued', nextRunAt: null },
      { id: 'job_waiting', queue: 'email_sync', status: 'queued', nextRunAt: '2026-06-04T12:05:00.000Z' },
      { id: 'job_backoff', queue: 'email_sync', status: 'queued', nextAttemptAt: '2026-06-04T12:10:00.000Z' },
      { id: 'job_failed', queue: 'email_sync', status: 'failed', nextRunAt: null },
      { id: 'job_running', queue: 'email_sync', status: 'running', leaseExpiresAt: '2026-06-04T12:30:00.000Z' },
      { id: 'job_stale', queue: 'email_sync', status: 'running', leaseExpiresAt: '2026-06-04T11:00:00.000Z' },
    ],
  };
  const summary = schedulerDueSummary(state, { leaseMs, limit: 5, now, queues: ['email_sync'] });
  assert.deepEqual(summary, [{
    due: 2,
    nextRunAt: '2026-06-04T12:05:00.000Z',
    queue: 'email_sync',
    sampledJobIds: ['job_due', 'job_stale'],
    waiting: 4,
  }]);
  assert.equal(jobClaimable(state.jobs[4], now, leaseMs), false);
  assert.equal(jobClaimable(state.jobs[5], now, leaseMs), true);
});

test('Signal scheduler runs, retries, and drains billing_webhook jobs without double-applying payment events', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-scheduler-billing-webhook-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const lockFile = path.join(tempDir, 'scheduler.lock');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  await handlePaymentWebhook('invoice.payment_failed', {
    amountDueCents: 4900,
    providerInvoiceId: 'in_scheduler_billing_retry',
    subscriptionId: 'sub_demo',
  }, { actorUserId: 'usr_admin', statePath });

  let state = await loadState({ statePath });
  const invoice = state.invoices.find((candidate) => candidate.providerInvoiceId === 'in_scheduler_billing_retry');
  assert(invoice, 'billing scheduler test requires a webhook-created invoice');
  const paymentEventCount = state.paymentEvents.length;
  state.jobs = state.jobs.filter((job) => job.queue !== 'billing_webhook');
  state.invoices.push({
    id: 'inv_scheduler_missing_subscription',
    tenantId: 'tenant_demo',
    subscriptionId: 'sub_scheduler_missing',
    provider: 'local_test',
    status: 'past_due',
    amountDueCents: 4900,
    currency: 'usd',
    hostedInvoiceUrl: 'signal://billing/invoice/tenant_demo/inv_scheduler_missing_subscription',
    createdAt: '2026-06-13T00:00:00.000Z',
    dueAt: '2026-06-20T00:00:00.000Z',
    retryCount: 1,
    nextPaymentAttemptAt: null,
    creditedCents: 0,
    refundedCents: 0,
  });
  state.jobs.push(
    {
      id: 'job_billing_claim_invoice',
      tenantId: 'tenant_demo',
      queue: 'billing_webhook',
      type: 'payment.webhook.invoice.payment_failed',
      targetId: invoice.id,
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      message: 'Claim and reconcile a webhook-created invoice.',
    },
    {
      id: 'job_billing_retry_invoice',
      tenantId: 'tenant_demo',
      queue: 'billing_webhook',
      type: 'payment.webhook.invoice.payment_failed',
      targetId: 'inv_scheduler_missing_subscription',
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      message: 'Exercise billing retry when invoice subscription is temporarily missing.',
    },
    {
      id: 'job_billing_scheduler_once',
      tenantId: 'tenant_demo',
      queue: 'billing_webhook',
      type: 'payment.webhook.invoice.payment_failed',
      targetId: invoice.id,
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      message: 'Exercise scheduler daemon billing run.',
    },
    {
      id: 'job_billing_active_lease',
      tenantId: 'tenant_demo',
      queue: 'billing_webhook',
      type: 'payment.webhook.invoice.payment_failed',
      targetId: invoice.id,
      status: 'running',
      attempts: 0,
      maxAttempts: 3,
      claimedBy: 'worker_other',
      runningSince: '2026-06-13T00:00:00.000Z',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      message: 'Active lease should not be claimed by another worker.',
    },
  );
  await saveState(state, { statePath });

  const firstRun = await runJobs({ queue: 'billing_webhook', limit: 2 }, {
    actorUserId: 'usr_admin',
    jobLeaseMs: 300_000,
    statePath,
    workerId: 'billing-test-worker',
  });
  assert.equal(firstRun.details.count, 2);
  assert.equal(firstRun.details.succeeded, 1);
  assert.equal(firstRun.details.failed, 1);

  state = await loadState({ statePath });
  assert.equal(state.paymentEvents.length, paymentEventCount, 'billing job reconciliation must not append duplicate payment events');
  const claimedJob = state.jobs.find((job) => job.id === 'job_billing_claim_invoice');
  assert.equal(claimedJob.status, 'succeeded');
  assert.equal(claimedJob.attempts, 1);
  assert.equal(claimedJob.claimedBy, undefined, 'successful job should clear claim metadata');
  const retryJob = state.jobs.find((job) => job.id === 'job_billing_retry_invoice');
  assert.equal(retryJob.status, 'queued');
  assert.equal(retryJob.attempts, 1);
  assert(retryJob.nextAttemptAt, 'failed billing job should receive retry backoff');
  assert.equal(retryJob.failureHistory.length, 1);
  const activeLeaseJob = state.jobs.find((job) => job.id === 'job_billing_active_lease');
  assert.equal(activeLeaseJob.status, 'running', 'active billing lease should not be double-claimed');
  assert.equal(activeLeaseJob.attempts, 0);

  retryJob.nextAttemptAt = '2026-01-01T00:00:00.000Z';
  retryJob.nextRunAt = retryJob.nextAttemptAt;
  state.subscriptions.push({
    id: 'sub_scheduler_missing',
    tenantId: 'tenant_demo',
    provider: 'local_test',
    planId: 'plan_team',
    status: 'past_due',
  });
  await saveState(state, { statePath });

  const retryRun = await runJobs({ jobId: 'job_billing_retry_invoice', limit: 1 }, {
    actorUserId: 'usr_admin',
    jobLeaseMs: 300_000,
    statePath,
    workerId: 'billing-retry-worker',
  });
  assert.equal(retryRun.details.succeeded, 1);
  state = await loadState({ statePath });
  assert.equal(state.jobs.find((job) => job.id === 'job_billing_retry_invoice')?.status, 'succeeded');
  assert.equal(state.paymentEvents.length, paymentEventCount, 'billing retry should reconcile state without replaying payment events');

  const schedulerConfig = createSchedulerConfig({
    argv: ['--once', '--queue', 'billing_webhook', '--limit', '1', '--lock-file', lockFile],
    env: { SIGNAL_ADMIN_STATE: statePath },
  });
  const schedulerRun = await runSchedulerOnce(schedulerConfig);
  assert.equal(schedulerRun.ok, true);
  assert.equal(schedulerRun.ran, 1);
  assert.equal(schedulerRun.outcomes.find((outcome) => outcome.queue === 'billing_webhook')?.count, 1);

  const drained = await drainJobs('billing_webhook', { actorUserId: 'usr_admin', statePath });
  assert.equal(drained.details.count, 1);
  state = await loadState({ statePath });
  assert.equal(state.jobs.find((job) => job.id === 'job_billing_active_lease')?.status, 'drained');
  assert.equal(state.jobs.filter((job) => job.queue === 'billing_webhook' && ['queued', 'running'].includes(job.status)).length, 0);
});

test('Signal scheduler applies backoff, dead-letters exhausted jobs, and requeues DLQ entries', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-scheduler-dlq-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const state = await loadState({ statePath });
  state.deadLetter = [];
  state.jobs.push({
    id: 'job_no_worker',
    tenantId: 'tenant_demo',
    queue: 'missing_worker',
    type: 'missing.worker',
    targetId: 'target_missing',
    status: 'queued',
    attempts: 0,
    maxAttempts: 2,
    message: 'exercise failure path',
  });
  await saveState(state, { statePath });

  const first = await runJobs({ queue: 'missing_worker', limit: 1 }, { actorUserId: 'usr_admin', statePath });
  assert.equal(first.details.failed, 1);
  const backedOffState = await loadState({ statePath });
  const backedOffJob = backedOffState.jobs.find((job) => job.id === 'job_no_worker');
  assert.equal(backedOffJob.status, 'queued');
  assert.equal(backedOffJob.attempts, 1);
  assert(backedOffJob.nextAttemptAt, 'failed job should receive nextAttemptAt before retry');
  const waiting = schedulerDueSummary(backedOffState, { queues: ['missing_worker'], now: Date.now() });
  assert.equal(waiting[0].due, 0);
  assert.equal(waiting[0].waiting, 1);

  backedOffJob.nextAttemptAt = '2026-01-01T00:00:00.000Z';
  backedOffJob.nextRunAt = backedOffJob.nextAttemptAt;
  await saveState(backedOffState, { statePath });

  const second = await runJobs({ queue: 'missing_worker', limit: 1 }, { actorUserId: 'usr_admin', statePath });
  assert.equal(second.details.failed, 1);
  const deadLetterState = await loadState({ statePath });
  assert.equal(deadLetterState.jobs.some((job) => job.id === 'job_no_worker'), false);
  assert.equal(deadLetterState.deadLetter?.length, 1);
  assert.equal(deadLetterState.deadLetter[0].status, 'dead-letter');
  assert.equal(deadLetterState.deadLetter[0].failureHistory.length, 2);

  const requeued = await requeueDeadLetterJob(deadLetterState.deadLetter[0].deadLetterId, { actorUserId: 'usr_admin', statePath });
  assert.equal(requeued.details.jobId, 'job_no_worker');
  const requeuedState = await loadState({ statePath });
  assert.equal(requeuedState.deadLetter.length, 0);
  const activeJob = requeuedState.jobs.find((job) => job.id === 'job_no_worker');
  assert.equal(activeJob.status, 'queued');
  assert.equal(activeJob.attempts, 0);

  requeuedState.deadLetter.push({
    ...activeJob,
    id: 'job_bulk_dlq',
    originalJobId: 'job_bulk_dlq',
    deadLetterId: 'dlq_job_bulk_dlq',
    status: 'dead-letter',
  });
  await saveState(requeuedState, { statePath });
  const bulk = await requeueDeadLetterJobs(['dlq_job_bulk_dlq'], { actorUserId: 'usr_admin', statePath });
  assert.equal(bulk.details.results[0].ok, true);
  const bulkState = await loadState({ statePath });
  assert.equal(bulkState.deadLetter.length, 0);
  assert.equal(bulkState.jobs.find((job) => job.id === 'job_bulk_dlq')?.status, 'queued');
});

test('Signal scheduler lock refresh keeps a live daemon lock fresh', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-scheduler-refresh-'));
  const lockFile = path.join(tempDir, 'scheduler.lock');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  const config = createSchedulerConfig({
    argv: ['--once', '--lock-file', lockFile],
    env: { SIGNAL_ADMIN_STATE: '/tmp/signal-state.json', SIGNAL_SCHEDULER_LOCK_STALE_MS: '1000' },
  });
  const lock = await acquireSchedulerLock(config);
  assert.equal(lock.acquired, true);
  const before = await fs.stat(lockFile);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await refreshSchedulerLock(lock, config);
  const after = await fs.stat(lockFile);
  assert(after.mtimeMs > before.mtimeMs, 'refreshSchedulerLock should update lock mtime');
  await lock.release();
});

test('Signal state retention trims bounded audit and payment collections', () => {
  const state = {
    auditEvents: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }],
    paymentEvents: [{ id: 'p1' }, { id: 'p2' }],
    jobs: [
      { id: 'job_active', status: 'queued' },
      { id: 'job_old_1', status: 'succeeded' },
      { id: 'job_old_2', status: 'succeeded' },
      { id: 'job_old_3', status: 'succeeded' },
    ],
  };
  enforceStateRetention(state, {
    SIGNAL_STATE_AUDIT_EVENT_MAX: '2',
    SIGNAL_STATE_PAYMENT_EVENT_MAX: '1',
    SIGNAL_STATE_JOB_MAX: '2',
  });
  assert.deepEqual(state.auditEvents.map((event) => event.id), ['a2', 'a3']);
  assert.deepEqual(state.paymentEvents.map((event) => event.id), ['p2']);
  assert.deepEqual(state.jobs.map((job) => job.id), ['job_active', 'job_old_3']);
  assert.equal(stateCollectionLimits({ SIGNAL_STATE_AUDIT_EVENT_MAX: '10' }).auditEvents, 10);
});

test('Signal scheduler can coordinate with a Postgres advisory lock', async () => {
  const calls = [];
  const held = new Set();
  const pgPool = {
    async query(sql, params) {
      calls.push({ params, sql });
      if (sql.includes('pg_try_advisory_lock')) {
        const key = params[0];
        if (held.has(key)) {
          return { rows: [{ acquired: false }] };
        }
        held.add(key);
        return { rows: [{ acquired: true }] };
      }
      if (sql.includes('pg_advisory_unlock')) {
        held.delete(params[0]);
        return { rows: [{ released: true }] };
      }
      throw new Error(`Unexpected advisory lock query: ${sql}`);
    },
  };
  const config = createSchedulerConfig({
    argv: ['--once', '--queue', 'provider_validation'],
    env: {
      DATABASE_URL: 'postgres://signal:secret@db.example/signal',
      SIGNAL_ADMIN_STATE: '/tmp/signal-state.json',
      SIGNAL_STATE_SERVICE_BACKEND: 'postgres',
    },
    overrides: { pgPool },
  });

  const first = await acquirePostgresSchedulerLock(config, { pgPool });
  assert.equal(first.acquired, true);
  const second = await acquirePostgresSchedulerLock(config, { pgPool });
  assert.equal(second.acquired, false);
  assert.equal(second.reason, 'advisory_lock_held');
  await first.release();
  const third = await acquirePostgresSchedulerLock(config, { pgPool });
  assert.equal(third.acquired, true);
  await third.release();
  assert(calls.some((call) => call.sql.includes('pg_try_advisory_lock')));
  assert(calls.some((call) => call.sql.includes('pg_advisory_unlock')));
});

test('Launch freshness blocks stale sandbox evidence only in production context', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-scheduler-freshness-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  const staleRunAt = '2000-01-01T00:00:00.000Z';
  const state = await makeProductionEvidenceState(statePath, { providerRunAt: staleRunAt });
  const localGate = launchGateReport(state, {
    backend: backendReadiness({ env: {}, statePath }),
    env: {},
    provider: providerReadiness({}),
    statePath,
  });
  assert.equal(localGate.freshness.applies, false);
  assert.equal(localGate.freshnessBlockers.length, 0);

  const env = productionEnv();
  const productionGate = launchGateReport(state, {
    backend: backendReadiness({ env, statePath }),
    env,
    provider: providerReadiness(env),
    statePath,
  });
  assert.equal(productionGate.goLiveReady, false);
  assert(productionGate.freshnessBlockers.some((blocker) => blocker.id === 'sandbox_evidence_stale'));
  const sandboxGate = productionGate.gates.find((gate) => gate.id === 'provider_sandbox_evidence');
  assert.equal(sandboxGate.status, 'blocked');
  assert(sandboxGate.freshnessBlockers.some((blocker) => blocker.includes('sandbox evidence')));
});

test('Launch freshness surfaces missing and blocked provider evidence across launch, operations, and doctor reports', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-scheduler-evidence-blockers-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const env = productionEnv();
  const provider = providerReadiness(env);
  const backend = backendReadiness({ env, statePath });
  let state = await loadState({ statePath });

  const missingGate = launchGateReport(state, { backend, env, provider, statePath });
  assert(missingGate.freshnessBlockers.some((blocker) => blocker.id === 'sandbox_evidence_missing'));
  const missingSandboxGate = missingGate.gates.find((gate) => gate.id === 'provider_sandbox_evidence');
  assert.equal(missingSandboxGate.status, 'blocked');
  assert(missingSandboxGate.freshnessBlockers.some((blocker) => blocker.includes('No provider sandbox validation evidence')));

  const missingProviderLaunch = providerLaunchMatrixReport(state, { backend, env, provider, statePath });
  assert(missingProviderLaunch.freshnessBlockers.some((blocker) => blocker.id === 'sandbox_evidence_missing'));
  assert(missingProviderLaunch.rows.find((row) => row.id === 'stripe')?.freshnessBlockers.some((blocker) => blocker.includes('No provider sandbox validation evidence')));

  const missingOperations = operationsHealthReport(state, { backend, env, statePath });
  assert(missingOperations.issues.some((issue) => issue.includes('No provider sandbox validation evidence')));
  assert(missingOperations.summary.freshnessBlocked > 0);
  assert.equal(doctor(state).checks.find((check) => check.id === 'provider_validation_latest_evidence')?.ok, true);

  const blockedRun = passedProviderValidationRun({ id: 'pvr_blocked', recordedAt: new Date().toISOString() });
  blockedRun.ok = false;
  blockedRun.status = 'blocked';
  blockedRun.summary = { blocked: blockedRun.providers.length, failed: 0, passed: 0, total: blockedRun.providers.length };
  blockedRun.providers = blockedRun.providers.map((providerRow) => ({
    ...providerRow,
    checks: [],
    missingRequired: [`${providerRow.id.toUpperCase()}_SANDBOX_TOKEN`],
    status: 'blocked',
  }));
  state.providerValidationRuns = [blockedRun];
  await saveState(state, { statePath });
  state = await loadState({ statePath });

  const blockedGate = launchGateReport(state, { backend, env, provider, statePath });
  assert(blockedGate.freshnessBlockers.some((blocker) => blocker.id === 'sandbox_evidence_not_passed'));
  const blockedDoctorCheck = doctor(state).checks.find((check) => check.id === 'provider_validation_latest_evidence');
  assert.equal(blockedDoctorCheck?.ok, false);
  assert.equal(blockedDoctorCheck?.details?.status, 'blocked');
});

test('Provider launch rejects overdue provider validation schedules beyond grace', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-scheduler-overdue-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  const env = productionEnv();
  const state = await makeProductionEvidenceState(statePath);
  const gmailSchedule = state.providerValidationSchedules.find((schedule) => schedule.providerId === 'gmail');
  gmailSchedule.nextRunAt = '2000-01-01T00:00:00.000Z';
  await saveState(state, { statePath });
  const report = providerLaunchMatrixReport(await loadState({ statePath }), {
    backend: backendReadiness({ env, statePath }),
    env,
    provider: providerReadiness(env),
    statePath,
  });
  const gmail = report.rows.find((row) => row.id === 'gmail');
  assert.equal(report.productionReady, false);
  assert.equal(gmail.scheduleReady, true);
  assert.equal(gmail.launchReady, false);
  assert.equal(gmail.status, 'needs_freshness');
  assert(gmail.freshnessBlockers.some((blocker) => blocker.includes('overdue')));
});

test('Launch gate verify-package rejects stale freshness evidence', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-scheduler-package-freshness-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const envPath = path.join(tempDir, 'production.env');
  const packagePath = path.join(tempDir, 'launch-evidence.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  const env = productionEnv();
  await makeProductionEvidenceState(statePath, { providerRunAt: '2000-01-01T00:00:00.000Z' });
  await fs.writeFile(envPath, `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);

  await execFileAsync(process.execPath, [
    path.join(rootDir, 'scripts', 'signal-admin.mjs'),
    'launch-gate',
    'package',
    packagePath,
    '--env-file',
    envPath,
    '--json',
  ], {
    cwd: rootDir,
    env: {
      ...process.env,
      SIGNAL_ADMIN_STATE: statePath,
    },
    maxBuffer: 1024 * 1024,
  });

  await assert.rejects(
    execFileAsync(process.execPath, [
      path.join(rootDir, 'scripts', 'signal-admin.mjs'),
      'launch-gate',
      'verify-package',
      packagePath,
      '--json',
    ], {
      cwd: rootDir,
      env: {
        ...process.env,
        SIGNAL_ADMIN_STATE: statePath,
      },
      maxBuffer: 1024 * 1024,
    }),
    /Launch evidence package verification failed/,
  );
});
