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
  loadState,
  providerValidationSchedulesDue,
  requeueDeadLetterJob,
  requeueDeadLetterJobs,
  runJobs,
  saveState,
} from './signal-state.mjs';
import {
  acquirePostgresSchedulerLock,
  acquireSchedulerLock,
  createSchedulerConfig,
  runSchedulerOnce,
  schedulerDueSummary,
} from './signal-scheduler.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

test('Signal scheduler due summary reports waiting jobs', () => {
  const now = Date.parse('2026-06-04T12:00:00.000Z');
  const state = {
    jobs: [
      { id: 'job_due', queue: 'email_sync', status: 'queued', nextRunAt: null },
      { id: 'job_waiting', queue: 'email_sync', status: 'queued', nextRunAt: '2026-06-04T12:05:00.000Z' },
      { id: 'job_backoff', queue: 'email_sync', status: 'queued', nextAttemptAt: '2026-06-04T12:10:00.000Z' },
      { id: 'job_failed', queue: 'email_sync', status: 'failed', nextRunAt: null },
    ],
  };
  const summary = schedulerDueSummary(state, { limit: 5, now, queues: ['email_sync'] });
  assert.deepEqual(summary, [{
    due: 1,
    nextRunAt: '2026-06-04T12:05:00.000Z',
    queue: 'email_sync',
    sampledJobIds: ['job_due'],
    waiting: 2,
  }]);
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
