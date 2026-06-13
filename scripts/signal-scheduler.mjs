#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadState,
  resolveStatePath,
  runJobs,
  summarizeState,
} from './signal-state.mjs';
import {
  createLogger,
} from './signal-logger.mjs';

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
    dryRun: argv.includes('--dry-run') || env.SIGNAL_SCHEDULER_DRY_RUN === 'true',
    env,
    intervalMs,
    json: argv.includes('--json'),
    limit,
    lockFile,
    lockBackend,
    lockStaleMs: positiveInteger(env.SIGNAL_SCHEDULER_LOCK_STALE_MS, Math.max(intervalMs * 3, 300_000), 'Scheduler lock stale window'),
    lock: !argv.includes('--no-lock') && env.SIGNAL_SCHEDULER_LOCK !== 'false',
    once: argv.includes('--once') || env.SIGNAL_SCHEDULER_ONCE === 'true',
    pgPool: overrides.pgPool,
    heartbeatFile: path.resolve(env.SIGNAL_SCHEDULER_HEARTBEAT_FILE ?? path.join(rootDir, 'data', 'signal-scheduler-heartbeat.json')),
    providerSandboxTimeoutMs: positiveInteger(env.SIGNAL_PROVIDER_SANDBOX_TIMEOUT_MS, 10_000, 'Provider sandbox timeout'),
    queues,
    statePath: flagValue(argv, '--state') ?? env.SIGNAL_ADMIN_STATE,
  };
}

function jobIsDue(job, now = Date.now()) {
  if (job.nextAttemptAt) {
    const nextAttemptMs = Date.parse(job.nextAttemptAt);
    if (Number.isFinite(nextAttemptMs) && nextAttemptMs > now) {
      return false;
    }
  }
  if (!job.nextRunAt) {
    return true;
  }
  const nextRunMs = Date.parse(job.nextRunAt);
  return !Number.isFinite(nextRunMs) || nextRunMs <= now;
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

function runnableJobsForQueue(state, queue, limit, now = Date.now()) {
  return (state.jobs ?? [])
    .filter((job) => ['queued', 'running'].includes(job.status) && job.queue === queue && jobIsDue(job, now))
    .slice(0, limit);
}

export function schedulerDueSummary(state, { queues = defaultSchedulerQueues, limit = 5, now = Date.now() } = {}) {
  return queues.map((queue) => {
    const dueJobs = runnableJobsForQueue(state, queue, limit, now);
    const waitingJobs = (state.jobs ?? []).filter((job) => ['queued', 'running'].includes(job.status) && job.queue === queue && !jobIsDue(job, now));
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
    if (config.lockStaleMs && ageMs > config.lockStaleMs) {
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

export async function runSchedulerTick(config, { loadStateImpl = loadState, runJobsImpl = runJobs } = {}) {
  const statePath = resolveStatePath(config.statePath);
  const startedAt = new Date().toISOString();
  const state = await loadStateImpl({ statePath });

  if (config.dryRun) {
    return {
      ok: true,
      actorUserId: config.actorUserId,
      dryRun: true,
      queues: schedulerDueSummary(state, { limit: config.limit, queues: config.queues }),
      startedAt,
      statePath,
      summary: summarizeState(state, statePath),
    };
  }

  const outcomes = [];
  for (const queue of config.queues) {
    const result = await runJobsImpl({ queue, limit: config.limit }, {
      actorUserId: config.actorUserId,
      env: config.env,
      providerSandboxTimeoutMs: config.providerSandboxTimeoutMs,
      statePath,
    });
    outcomes.push({
      action: result.action,
      count: result.details.count,
      failed: result.details.failed,
      queue,
      skipped: result.details.count === 0,
      succeeded: result.details.succeeded,
      summary: result.summary,
    });
  }

  const refreshedState = await loadStateImpl({ statePath });
  const failed = outcomes.reduce((sum, outcome) => sum + outcome.failed, 0);
  const ran = outcomes.reduce((sum, outcome) => sum + outcome.count, 0);
  return {
    ok: failed === 0,
    actorUserId: config.actorUserId,
    dryRun: false,
    finishedAt: new Date().toISOString(),
    outcomes,
    ran,
    startedAt,
    statePath,
    summary: summarizeState(refreshedState, statePath),
  };
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
      const result = await runSchedulerTick({ ...config, lock: false });
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
    ...result.outcomes.map((outcome) => `${outcome.queue}: ${outcome.count} ran, ${outcome.succeeded} succeeded, ${outcome.failed} failed`),
  ].join('\n');
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
