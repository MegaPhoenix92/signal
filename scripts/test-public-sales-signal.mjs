#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PUBLIC_SALES_SIGNAL_JOB,
  queryPublicResearch,
  runPublicSalesSignalJob,
} from './public-sales-signal.mjs';
import {
  createSchedulerConfig,
  runSchedulerOnce,
} from './signal-scheduler.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(rootDir, 'data', 'public-sales-signal-fixture.json');

const TENANT_MAILBOX_TABLES = [
  'mailboxes',
  'sourceMessages',
  'emailSyncCursors',
  'mailboxConnectionSessions',
  'emailWatchSubscriptions',
];

function instrumentTenantState(state) {
  const opened = [];
  const proxied = new Proxy(state, {
    get(target, prop, receiver) {
      if (TENANT_MAILBOX_TABLES.includes(String(prop))) {
        opened.push(String(prop));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { opened, state: proxied };
}

test('public_sales_signal job name is isolated from tenant detector queues', () => {
  assert.equal(PUBLIC_SALES_SIGNAL_JOB, 'public_sales_signal');
  assert.notEqual(PUBLIC_SALES_SIGNAL_JOB, 'signal_detection');
  assert.notEqual(PUBLIC_SALES_SIGNAL_JOB, 'email_sync');
});

test('public_sales_signal --once writes fixture research + audit without opening tenant mailboxes', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-public-sales-'));
  const publicStorePath = path.join(tempDir, 'public-sales-signal.json');
  const lockFile = path.join(tempDir, 'scheduler.lock');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  const tenantSecret = {
    id: 'sig_tenant_secret',
    tenantId: 'tenant_demo',
    title: 'Acme renewal from mailbox',
    snippet: 'Confidential tenant mail about Acme Corp',
  };
  const { opened, state: tenantState } = instrumentTenantState({
    mailboxes: [{ id: 'mbx_secret', tenantId: 'tenant_demo', status: 'connected' }],
    sourceMessages: [{ id: 'msg_secret', mailboxId: 'mbx_secret', tenantId: 'tenant_demo' }],
    emailSyncCursors: [{ mailboxId: 'mbx_secret', cursor: 'secret-cursor' }],
    mailboxConnectionSessions: [{ mailboxId: 'mbx_secret' }],
    emailWatchSubscriptions: [{ id: 'watch_secret', mailboxId: 'mbx_secret', status: 'active' }],
    signals: [tenantSecret],
  });

  let loadStateCalls = 0;
  let runJobsCalls = 0;
  let watchRenewCalls = 0;

  const config = createSchedulerConfig({
    argv: ['--once', '--queues', PUBLIC_SALES_SIGNAL_JOB, '--lock-file', lockFile, '--no-lock'],
    env: {
      SIGNAL_PUBLIC_SALES_SIGNAL_STATE: publicStorePath,
      SIGNAL_PUBLIC_SALES_SIGNAL_FIXTURE: fixturePath,
    },
  });

  const result = await runSchedulerOnce(config, {
    async loadStateImpl() {
      loadStateCalls += 1;
      throw new Error('tenant store must not be opened for public_sales_signal');
    },
    async runJobsImpl() {
      runJobsCalls += 1;
      throw new Error('must not reuse jobs.run / signal_detection on public feeds');
    },
    async renewMailboxWatchImpl() {
      watchRenewCalls += 1;
      throw new Error('must not open mailbox watches for public_sales_signal');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  const publicOutcome = result.outcomes.find((outcome) => outcome.queue === PUBLIC_SALES_SIGNAL_JOB);
  assert.ok(publicOutcome, 'scheduler should report public_sales_signal outcome');
  assert(publicOutcome.succeeded >= 1, 'scheduler tick should write at least one public research row');
  assert.equal(publicOutcome.action, PUBLIC_SALES_SIGNAL_JOB);
  assert.notEqual(publicOutcome.action, 'email-flows.run');
  assert.equal(loadStateCalls, 0, 'tenant JSON blob must not be loaded');
  assert.equal(runJobsCalls, 0, 'tenant job runner must not run');
  assert.equal(watchRenewCalls, 0, 'mailbox watch renewal must not run');
  assert.deepEqual(opened, [], 'tenant mailbox tables were not opened');

  const jobResult = await runPublicSalesSignalJob({
    fixturePath,
    storePath: publicStorePath,
    tenantState,
    now: '2026-08-19T12:00:00.000Z',
  });
  assert.equal(jobResult.ok, true);
  assert(jobResult.written >= 1);
  assert.deepEqual(opened, [], 'public job must not read tenant mailbox collections');

  const store = JSON.parse(await fs.readFile(publicStorePath, 'utf8'));
  assert(Array.isArray(store.research) && store.research.length >= 1, 'public store should contain research rows');
  assert(Array.isArray(store.audit) && store.audit.length >= 1, 'public store should contain audit rows');
  const audit = store.audit[store.audit.length - 1];
  assert.equal(typeof audit.source, 'string');
  assert.ok(audit.source.startsWith('fixture:'), 'source must be the committed fixture, not a vendor');
  assert.equal(typeof audit.timestamp, 'string');
  assert.ok(Number.isFinite(Date.parse(audit.timestamp)), 'audit timestamp must be parseable');
  assert.equal(audit.job, PUBLIC_SALES_SIGNAL_JOB);

  const publicJson = JSON.stringify(store);
  assert.equal(publicJson.includes('sig_tenant_secret'), false, 'tenant signals[] must not land in the public store');
  assert.equal(publicJson.includes('Acme Corp'), false);
  assert.equal(publicJson.includes('mbx_secret'), false);
  assert.equal(publicJson.includes('sales_signals'), false);

  const publicAgentView = queryPublicResearch({ publicStore: store, tenantState });
  assert(publicAgentView.length >= 1);
  assert.equal(publicAgentView.some((row) => row.id === tenantSecret.id), false);
  assert.equal(
    JSON.stringify(publicAgentView).includes('Confidential tenant mail'),
    false,
    'public-agent query cannot see tenant signals',
  );
  assert.equal(opened.includes('mailboxes'), false);
});
