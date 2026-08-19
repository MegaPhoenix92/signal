#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  jobClaimable,
  loadState,
  recordSchedulerAlert,
  recordSchedulerHeartbeat,
  renewMailboxWatch,
  resolveStatePath,
  runJobs,
  summarizeState,
} from './signal-state.mjs';
import {
  createLogger,
} from './signal-logger.mjs';
import {
  PUBLIC_SALES_SIGNAL_JOB,
  runPublicSalesSignalJob,
} from './public-sales-signal.mjs';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultSchedulerQueues = [
  'provider_validation',
  'email_sync',
  'notification_digest',
  'outbound_email',
  'billing_webhook',
  'signal_handoff',
  'signal_detection',
  'governance',
  'user_onboarding',
  PUBLIC_SALES_SIGNAL_JOB,
];

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function flagValues(argv, name) {
  const values = [];
  argv.forEach((arg, index) => {
    if (arg === name && argv[index + 1]) {
      values.push(argv[index + 1]);
    }
  });
  return values;
}

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return numeric;
}

function parseQueues(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function createSchedulerConfig({ argv = process.argv.slice(2), env = process.env, overrides = {} } = {}) {
  const queuesFromFlags = [
    ...flagValues(argv, '--queue'),
    ...parseQueues(flagValue(argv, '--queues')),
  ];
  const queuesFromEnv = parseQueues(env.SIGNAL_SCHEDULER_QUEUES);
  const queues = queuesFromFlags.length ? queuesFromFlags : (queuesFromEnv.length ? queuesFromEnv : defaultSchedulerQueues);
  const intervalMs = positiveInteger(flagValue(argv, '--interval-ms') ?? env.SIGNAL_SCHEDULER_INTERVAL_MS, 60_000, 'Scheduler interval');
  const limit = positiveInteger(flagValue(argv, '--limit') ?? env.SIGNAL_SCHEDULER_LIMIT, 5, 'Scheduler limit');
  const lockFile = path.resolve(flagValue(argv, '--lock-file') ?? env.SIGNAL_SCHEDULER_LOCK_FILE ?? path.join(rootDir, 'data', 'signal-scheduler.lock'));
  const lockBackend = env.SIGNAL_SCHEDULER_LOCK_BACKEND ?? (env.SIGNAL_STATE_SERVICE_BACKEND === 'postgres' ? 'postgres' : 'file');

  return {
    actorUserId: flagValue(argv, '--actor') ?? env.SIGNAL_SCHEDULER_ACTOR ?? env.SIGNAL_ADMIN_ACTOR ?? 'usr_admin',
    drain: argv.includes('--drain') || argv.includes('--once') || env.SIGNAL_SCHEDULER_DRAIN === 'true',
    drainMaxIterations: positiveInteger(env.SIGNAL_SCHEDULER_DRAIN_MAX_ITERATIONS, 100, 'Scheduler drain max iterations'),
    dryRun: argv.includes('--dry-run') || env.SIGNAL_SCHEDULER_DRY_RUN === 'true',
    env,
    intervalMs,
    json: argv.includes('--json'),
    limit,
    lockFile,
    lockBackend,
    lockStaleMs: positiveInteger(env.SIGNAL_SCHEDULER_LOCK_STALE_MS, Math.max(intervalMs * 3, 300_000), 'Scheduler lock stale window'),
    lock: !argv.includes('--no-lock') && env.SIGNAL_SCHEDULER_LOCK !== 'false',
    liveProviderWatch: argv.includes('--live-provider') || env.SIGNAL_PROVIDER_WATCH_MODE === 'live',
    once: argv.includes('--once') || env.SIGNAL_SCHEDULER_ONCE === 'true',
    pgPool: overrides.pgPool,
    heartbeatFile: path.resolve(env.SIGNAL_SCHEDULER_HEARTBEAT_FILE ?? path.join(rootDir, 'data', 'signal-scheduler-heartbeat.json')),
    providerSandboxTimeoutMs: positiveInteger(env.SIGNAL_PROVIDER_SANDBOX_TIMEOUT_MS, 10_000, 'Provider sandbox timeout'),
    jobLeaseMs: positiveInteger(env.SIGNAL_JOB_LEASE_MS, Math.max(intervalMs * 3, 300_000), 'Job lease window'),
    queues,
    statePath: flagValue(argv, '--state') ?? env.SIGNAL_ADMIN_STATE,
    watchRenewalWindowMs: positiveInteger(env.SIGNAL_PROVIDER_WATCH_RENEWAL_WINDOW_MS, 24 * 60 * 60 * 1000, 'Provider watch renewal window'),
    workerId: env.SIGNAL_SCHEDULER_WORKER_ID ?? `scheduler_${process.pid}`,
  };
}



function advisoryLockKey(config) {
  const hash = crypto.createHash('sha256')
    .update(`signal-scheduler:${resolveStatePath(config.statePath)}:${config.queues.join(',')}`, 'utf8')
    .digest();
  return hash.readInt32BE(0);
}

export async function acquirePostgresSchedulerLock(config, { pgPool } = {}) {
  let pool = pgPool ?? config.pgPool;
  let shouldClosePool = false;
  if (!pool) {
    const databaseUrl = config.env.SIGNAL_STATE_SERVICE_DATABASE_URL ?? config.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('Postgres scheduler lock requires SIGNAL_STATE_SERVICE_DATABASE_URL or DATABASE_URL.');
    }
    const pg = await import('pg');
    const Pool = pg.Pool ?? pg.default?.Pool;
    pool = new Pool({
      application_name: 'signal-scheduler-lock',
      connectionString: databaseUrl,
      max: 1,
    });
    shouldClosePool = true;
  }
  const key = advisoryLockKey(config);
  const result = await pool.query('SELECT pg_try_advisory_lock($1) AS acquired', [key]);
  const acquired = result.rows?.[0]?.acquired === true;
  if (!acquired) {
    if (shouldClosePool) {
      await pool.end?.();
    }
    return {
      acquired: false,
      lockBackend: 'postgres',
      reason: 'advisory_lock_held',
      async release() {},
    };
  }
  return {
    acquired: true,
    lockBackend: 'postgres',
    lockKey: key,
    async release() {
      try {
        await pool.query('SELECT pg_advisory_unlock($1) AS released', [key]);
      } finally {
        if (shouldClosePool) {
          await pool.end?.();
        }
      }
    },
  };
}

function runnableJobsForQueue(state, queue, limit, { leaseMs, now = Date.now() } = {}) {
  return (state.jobs ?? [])
    .filter((job) => job.queue === queue && jobClaimable(job, now, leaseMs))
    .slice(0, limit);
}

export function providerWatchesExpiringWithin(state, { now = Date.now(), windowMs = 24 * 60 * 60 * 1000 } = {}) {
  return (state.emailWatchSubscriptions ?? [])
    .filter((watch) => {
      if (watch.status !== 'active') {
        return false;
      }
      const expirationMs = Date.parse(watch.expirationAt ?? '');
      return Number.isFinite(expirationMs) && expirationMs <= now + windowMs;
    });
}

export function schedulerDueSummary(state, { leaseMs, queues = defaultSchedulerQueues, limit = 5, now = Date.now() } = {}) {
  return queues.map((queue) => {
    const dueJobs = runnableJobsForQueue(state, queue, limit, { leaseMs, now });
    const waitingJobs = (state.jobs ?? []).filter((job) => job.queue === queue && !jobClaimable(job, now, leaseMs));
    return {
      due: dueJobs.length,
      nextRunAt: waitingJobs
        .map((job) => Date.parse(job.nextAttemptAt ?? job.nextRunAt ?? ''))
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right)
        .map((value) => new Date(value).toISOString())[0] ?? null,
      queue,
      sampledJobIds: dueJobs.map((job) => job.id),
      waiting: waitingJobs.length,
    };
  });
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readLockPayload(lockFile) {
  try {
    const content = await fs.readFile(lockFile, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function refreshSchedulerLock(lock, config) {
  if (!lock?.acquired || lock.disabled || lock.lockBackend === 'postgres' || !config.lockFile) {
    return;
  }
  const now = new Date();
  await fs.utimes(config.lockFile, now, now);
}

export async function acquireSchedulerLock(config) {
  if (!config.lock) {
    return {
      acquired: true,
      disabled: true,
      async release() {},
    };
  }

  if (config.lockBackend === 'postgres') {
    return acquirePostgresSchedulerLock(config);
  }

  await fs.mkdir(path.dirname(config.lockFile), { recursive: true });
  const payload = {
    acquiredAt: new Date().toISOString(),
    actorUserId: config.actorUserId,
    intervalMs: config.intervalMs,
    lockFile: config.lockFile,
    pid: process.pid,
    queues: config.queues,
    statePath: resolveStatePath(config.statePath),
  };

  async function writeLock() {
    const handle = await fs.open(config.lockFile, 'wx');
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`);
    await handle.close();
  }

  try {
    await writeLock();
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
    const stat = await fs.stat(config.lockFile);
    const ageMs = Date.now() - stat.mtimeMs;
    const existing = await readLockPayload(config.lockFile);
    const holderAlive = existing?.pid ? processAlive(existing.pid) : false;
    const staleByAge = config.lockStaleMs && ageMs > config.lockStaleMs;
    const staleByPid = existing?.pid && !holderAlive;
    if (staleByAge || staleByPid) {
      await fs.rm(config.lockFile, { force: true });
      await writeLock();
    } else {
      return {
        acquired: false,
        ageMs,
        lockFile: config.lockFile,
        reason: 'lock_held',
        async release() {},
      };
    }
  }

  return {
    acquired: true,
    lockFile: config.lockFile,
    async release() {
      await fs.rm(config.lockFile, { force: true });
    },
  };
}

async function emitSchedulerOperationsAlert(config, {
  details = {},
  logger = createLogger({ env: config.env, service: 'signal-scheduler', sink: console.error }),
  message,
  recordSchedulerAlertImpl = recordSchedulerAlert,
  severity = 'critical',
  title = 'Signal scheduler failure',
  type = 'scheduler.failure',
} = {}) {
  const channel = config.env.SIGNAL_OPERATIONS_ALERT_CHANNEL;
  if (!channel) {
    return null;
  }
  logger.error('operations_alert', {
    channel,
    details,
    message,
    severity,
    title,
    type,
  });
  try {
    return await recordSchedulerAlertImpl({
      channel,
      details,
      message,
      severity,
      title,
      type,
    }, {
      actorUserId: config.actorUserId,
      statePath: config.statePath,
    });
  } catch (error) {
    logger.error('operations_alert_record_failed', {
      channel,
      error: error instanceof Error ? error.message : String(error),
      type,
    });
    return null;
  }
}

async function renewExpiringProviderWatches(config, {
  fetchImpl,
  loadStateImpl = loadState,
  logger,
  recordSchedulerAlertImpl = recordSchedulerAlert,
  renewMailboxWatchImpl = renewMailboxWatch,
} = {}) {
  const statePath = resolveStatePath(config.statePath);
  const state = await loadStateImpl({ statePath });
  const watches = providerWatchesExpiringWithin(state, { windowMs: config.watchRenewalWindowMs });
  const outcomes = [];
  for (const watch of watches) {
    try {
      const result = await renewMailboxWatchImpl(watch.id, {
        actorUserId: config.actorUserId,
        env: config.env,
        fetchImpl,
        liveProviderWatch: config.liveProviderWatch,
        statePath,
      });
      const status = result.details?.status ?? 'unknown';
      const ok = status === 'active';
      outcomes.push({
        mailboxId: result.details?.mailboxId ?? watch.mailboxId,
        ok,
        provider: watch.provider,
        status,
        watchId: watch.id,
      });
      if (!ok) {
        await emitSchedulerOperationsAlert(config, {
          details: {
            mailboxId: result.details?.mailboxId ?? watch.mailboxId,
            provider: watch.provider,
            providerResponseStatus: result.details?.providerResponseStatus ?? null,
            status,
            watchId: watch.id,
          },
          logger,
          message: `Provider watch renewal failed for ${watch.provider} watch ${watch.id}.`,
          recordSchedulerAlertImpl,
          title: 'Provider watch renewal failed',
          type: 'scheduler.watch_renew_failed',
        });
      }
    } catch (error) {
      outcomes.push({
        error: error instanceof Error ? error.message : String(error),
        mailboxId: watch.mailboxId,
        ok: false,
        provider: watch.provider,
        status: 'failed',
        watchId: watch.id,
      });
      await emitSchedulerOperationsAlert(config, {
        details: {
          error: error instanceof Error ? error.message : String(error),
          mailboxId: watch.mailboxId,
          provider: watch.provider,
          watchId: watch.id,
        },
        logger,
        message: `Provider watch renewal failed for ${watch.provider} watch ${watch.id}.`,
        recordSchedulerAlertImpl,
        title: 'Provider watch renewal failed',
        type: 'scheduler.watch_renew_failed',
      });
    }
  }
  return {
    count: outcomes.length,
    failed: outcomes.filter((outcome) => !outcome.ok).length,
    outcomes,
    succeeded: outcomes.filter((outcome) => outcome.ok).length,
  };
}

async function runSchedulerQueue(config, queue, {
  loadStateImpl = loadState,
  logger,
  recordSchedulerAlertImpl = recordSchedulerAlert,
  runJobsImpl = runJobs,
  statePath,
} = {}) {
  let action = 'jobs.run';
  let count = 0;
  let failed = 0;
  let succeeded = 0;
  let summary = null;
  const batches = [];
  for (let iteration = 0; iteration < config.drainMaxIterations; iteration += 1) {
    if (config.drain) {
      const state = await loadStateImpl({ statePath });
      const due = schedulerDueSummary(state, {
        leaseMs: config.jobLeaseMs,
        limit: config.limit,
        queues: [queue],
      })[0];
      if (due.due === 0) {
        return {
          action,
          batches,
          count,
          failed,
          iterations: batches.length,
          queue,
          skipped: count === 0,
          succeeded,
          summary,
        };
      }
    }

    const result = await runJobsImpl({ queue, limit: config.limit }, {
      actorUserId: config.actorUserId,
      env: config.env,
      jobLeaseMs: config.jobLeaseMs,
      providerSandboxTimeoutMs: config.providerSandboxTimeoutMs,
      statePath,
      workerId: config.workerId,
    });
    action = result.action;
    count += result.details.count;
    failed += result.details.failed;
    succeeded += result.details.succeeded;
    summary = result.summary;
    batches.push(result.details);
    if (result.details.failed > 0) {
      await emitSchedulerOperationsAlert(config, {
        details: {
          failed: result.details.failed,
          queue,
          succeeded: result.details.succeeded,
        },
        logger,
        message: `Scheduler queue ${queue} recorded ${result.details.failed} failed job(s).`,
        recordSchedulerAlertImpl,
        title: 'Scheduler job failure',
        type: 'scheduler.job_failed',
      });
    }
    if (!config.drain || result.details.count === 0) {
      return {
        action,
        batches,
        count,
        failed,
        iterations: batches.length,
        queue,
        skipped: count === 0,
        succeeded,
        summary,
      };
    }
  }
  throw new Error(`Scheduler drain exceeded ${config.drainMaxIterations} iteration(s) for ${queue}.`);
}

export async function runSchedulerTick(config, {
  fetchImpl,
  loadStateImpl = loadState,
  logger = createLogger({ env: config.env, service: 'signal-scheduler', sink: console.error }),
  recordSchedulerAlertImpl = recordSchedulerAlert,
  recordSchedulerHeartbeatImpl = recordSchedulerHeartbeat,
  renewMailboxWatchImpl = renewMailboxWatch,
  runJobsImpl = runJobs,
  runPublicSalesSignalJobImpl = runPublicSalesSignalJob,
} = {}) {
  const publicQueues = config.queues.filter((queue) => queue === PUBLIC_SALES_SIGNAL_JOB);
  const tenantQueues = config.queues.filter((queue) => queue !== PUBLIC_SALES_SIGNAL_JOB);
  const startedAt = new Date().toISOString();

  if (tenantQueues.length === 0 && publicQueues.length > 0) {
    if (config.dryRun) {
      return {
        ok: true,
        actorUserId: config.actorUserId,
        dryRun: true,
        queues: publicQueues.map((queue) => ({ queue, due: 1, waiting: 0 })),
        startedAt,
        statePath: 'public-sales-signal',
        outcomes: [],
      };
    }
    const jobResult = await runPublicSalesSignalJobImpl({ env: config.env });
    const outcomes = [{
      queue: PUBLIC_SALES_SIGNAL_JOB,
      action: PUBLIC_SALES_SIGNAL_JOB,
      count: jobResult.written ?? 0,
      succeeded: jobResult.ok ? (jobResult.written ?? 0) : 0,
      failed: jobResult.ok ? 0 : 1,
    }];
    return {
      ok: Boolean(jobResult.ok),
      actorUserId: config.actorUserId,
      dryRun: false,
      finishedAt: new Date().toISOString(),
      outcomes,
      ran: jobResult.written ?? 0,
      startedAt,
      statePath: jobResult.storePath,
      watchRenewals: { count: 0, succeeded: 0, failed: 0 },
    };
  }

  const statePath = resolveStatePath(config.statePath);
  const state = await loadStateImpl({ statePath });

  if (config.dryRun) {
    return {
      ok: true,
      actorUserId: config.actorUserId,
      dryRun: true,
      queues: schedulerDueSummary(state, { leaseMs: config.jobLeaseMs, limit: config.limit, queues: config.queues }),
      startedAt,
      statePath,
      summary: summarizeState(state, statePath),
    };
  }

  try {
    const watchRenewals = await renewExpiringProviderWatches(config, {
      fetchImpl,
      loadStateImpl,
      logger,
      recordSchedulerAlertImpl,
      renewMailboxWatchImpl,
    });
    const outcomes = [];
    for (const queue of config.queues) {
      const result = await runSchedulerQueue(config, queue, {
        loadStateImpl,
        logger,
        recordSchedulerAlertImpl,
        runJobsImpl,
        statePath,
      });
      outcomes.push(result);
    }

    const failed = outcomes.reduce((sum, outcome) => sum + outcome.failed, 0) + watchRenewals.failed;
    const ran = outcomes.reduce((sum, outcome) => sum + outcome.count, 0);
    const finishedAt = new Date().toISOString();
    const ok = failed === 0;
    await recordSchedulerHeartbeatImpl({
      failed,
      finishedAt,
      ok,
      queues: config.queues,
      ran,
      recordedAt: finishedAt,
      statePath,
      workerId: config.workerId,
    }, {
      actorUserId: config.actorUserId,
      statePath,
    });
    const refreshedState = await loadStateImpl({ statePath });
    return {
      ok,
      actorUserId: config.actorUserId,
      dryRun: false,
      finishedAt,
      outcomes,
      ran,
      startedAt,
      statePath,
      summary: summarizeState(refreshedState, statePath),
      watchRenewals,
    };
  } catch (error) {
    await emitSchedulerOperationsAlert(config, {
      details: { error: error instanceof Error ? error.message : String(error) },
      logger,
      message: error instanceof Error ? error.message : String(error),
      recordSchedulerAlertImpl,
      title: 'Scheduler tick failed',
      type: 'scheduler.tick_failed',
    });
    throw error;
  }
}

export async function runSchedulerOnce(config, options = {}) {
  const lock = await acquireSchedulerLock(config);
  if (!lock.acquired) {
    return {
      ok: false,
      skipped: true,
      reason: lock.reason,
      lockFile: lock.lockFile,
      ageMs: lock.ageMs,
    };
  }
  try {
    return await runSchedulerTick(config, options);
  } finally {
    await lock.release();
  }
}

export async function startSchedulerDaemon(config, { log } = {}) {
  const logger = createLogger({ env: config.env, service: 'signal-scheduler', sink: log ?? console.log });
  const lock = await acquireSchedulerLock(config);
  if (!lock.acquired) {
    throw new Error(`Signal scheduler lock is held at ${lock.lockFile}.`);
  }
  let stopped = false;
  let pending = Promise.resolve();
  let wake = null;

  function waitInterval() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, config.intervalMs);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  }

  async function runLoop() {
    while (!stopped) {
      await refreshSchedulerLock(lock, config);
      const result = await runSchedulerTick({ ...config, lock: false }, { logger });
      await fs.mkdir(path.dirname(config.heartbeatFile), { recursive: true });
      await fs.writeFile(config.heartbeatFile, `${JSON.stringify({
        ok: result.ok,
        ran: result.ran ?? 0,
        recordedAt: new Date().toISOString(),
        statePath: result.statePath,
      }, null, 2)}\n`);
      logger.info('tick', { ok: result.ok, ran: result.ran ?? 0, statePath: result.statePath });
      if (!stopped) {
        await waitInterval();
      }
    }
  }

  pending = runLoop().finally(async () => {
    await lock.release();
  });

  return {
    async stop() {
      stopped = true;
      wake?.();
      await pending;
    },
  };
}

function formatSchedulerResult(result) {
  if (result.skipped) {
    return `Signal scheduler skipped: ${result.reason} (${result.lockFile})`;
  }
  if (result.dryRun) {
    return [
      `Signal scheduler dry run for ${result.statePath}`,
      ...result.queues.map((queue) => `${queue.queue}: ${queue.due} due, ${queue.waiting} waiting${queue.nextRunAt ? `, next ${queue.nextRunAt}` : ''}`),
    ].join('\n');
  }
  return [
    `Signal scheduler ran ${result.ran} due job${result.ran === 1 ? '' : 's'} for ${result.statePath}`,
    result.watchRenewals?.count ? `Provider watches: ${result.watchRenewals.succeeded} renewed, ${result.watchRenewals.failed} failed` : null,
    ...result.outcomes.map((outcome) => `${outcome.queue}: ${outcome.count} ran, ${outcome.succeeded} succeeded, ${outcome.failed} failed`),
  ].filter(Boolean).join('\n');
}

async function main() {
  const config = createSchedulerConfig();
  if (config.once || config.dryRun) {
    const result = await runSchedulerOnce(config);
    console.log(config.json ? JSON.stringify(result, null, 2) : formatSchedulerResult(result));
    process.exit(result.ok || result.skipped ? 0 : 1);
  }

  const scheduler = await startSchedulerDaemon(config);
  const shutdown = async () => {
    await scheduler.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  createLogger({ env: config.env, service: 'signal-scheduler' }).info('daemon_started', {
    intervalMs: config.intervalMs,
    queues: config.queues,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    createLogger({ service: 'signal-scheduler', sink: console.error }).error('fatal', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
