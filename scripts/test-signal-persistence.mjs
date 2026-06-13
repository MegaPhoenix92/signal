#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bootstrapState,
  completionAuditReport,
  dashboardAuditReport,
  doctor,
  issueSessionToken,
  loadState,
  productReadinessReport,
  providerReadiness,
  signalDigestionPipelineReport,
} from './signal-state.mjs';
import {
  backendReadiness,
} from './signal-backend-readiness.mjs';
import { verifySignalLocal } from './verify-signal-local-core.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => {
        if (!port) {
          reject(new Error('Failed to allocate a local test port.'));
          return;
        }
        resolve(port);
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseJsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    sleep(2000),
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

async function startApi({ port, sessionSecret, statePath }) {
  const apiBaseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'signal-api.mjs')], {
    cwd: rootDir,
    env: {
      ...process.env,
      SIGNAL_ADMIN_STATE: statePath,
      SIGNAL_API_HOST: '127.0.0.1',
      SIGNAL_API_PORT: String(port),
      SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
      SIGNAL_SESSION_SECRET: sessionSecret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Signal API exited before persistence test startup.\n${output}`);
    }
    try {
      const response = await fetch(`${apiBaseUrl}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        return {
          apiBaseUrl,
          child,
          output: () => output,
        };
      }
    } catch {
      // Keep polling until the API binds the requested port.
    }
    await sleep(100);
  }
  throw new Error(`Signal API did not start on ${apiBaseUrl}.\n${output}`);
}

async function requestApi(apiBaseUrl, pathname, { body, method = 'GET', token } = {}) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    method,
  });
  return {
    payload: await parseJsonResponse(response),
    status: response.status,
  };
}

test('Signal local API persists mutations across process restart', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-persistence-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const sessionSecret = 'signal_persistence_test_secret_32!';
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const tokenResult = await issueSessionToken('usr_admin', {
    actorUserId: 'usr_admin',
    env: { SIGNAL_SESSION_SECRET: sessionSecret },
    statePath,
    ttlSeconds: 900,
  });
  const token = tokenResult.details.token;

  api = await startApi({ port, sessionSecret, statePath });
  const before = await requestApi(api.apiBaseUrl, '/api/state', { token });
  assert.equal(before.status, 200);
  const startingAuditCount = before.payload.state.auditEvents.length;

  const inviteEmail = `persist-${Date.now()}@acme.example`;
  const invite = await requestApi(api.apiBaseUrl, '/api/mutations', {
    body: {
      action: 'users.invite',
      args: {
        email: inviteEmail,
        role: 'member',
        team: 'sales',
        tenantId: 'tenant_demo',
      },
    },
    method: 'POST',
    token,
  });
  assert.equal(invite.status, 200);
  assert.equal(invite.payload.action, 'users.invite');
  assert.equal(invite.payload.details.email, inviteEmail);

  await stopProcess(api.child);
  api = null;

  const fileState = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert(fileState.invites.some((item) => item.email === inviteEmail && item.status === 'pending'), 'state file should persist the API-created invite before restart');
  assert(fileState.auditEvents.some((event) => event.action === 'users.invite' && event.actor === 'usr_admin'), 'state file should persist the invite audit event before restart');
  assert(!JSON.stringify(fileState).includes(token), 'state file should not persist bearer session tokens');

  api = await startApi({ port, sessionSecret, statePath });
  const after = await requestApi(api.apiBaseUrl, '/api/state', { token });
  assert.equal(after.status, 200);
  assert(after.payload.state.invites.some((item) => item.email === inviteEmail && item.status === 'pending'), 'restarted API should read persisted invite state');
  assert(after.payload.state.auditEvents.length > startingAuditCount, 'restarted API should expose persisted audit trail growth');
  assert(after.payload.state.auditEvents.some((event) => event.action === 'users.invite' && event.actor === 'usr_admin'), 'restarted API should expose persisted mutation audit event');
  assert.equal(after.payload.summary.pendingInvites, after.payload.state.invites.filter((item) => item.status === 'pending').length);
});

async function startLocalActorApi({ port, statePath }) {
  const apiBaseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'signal-api.mjs')], {
    cwd: rootDir,
    env: {
      ...process.env,
      SIGNAL_ADMIN_STATE: statePath,
      SIGNAL_ALLOW_LOCAL_ACTOR: 'true',
      SIGNAL_API_HOST: '127.0.0.1',
      SIGNAL_API_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Signal API exited before concurrent mutation test startup.\n${output}`);
    }
    try {
      const response = await fetch(`${apiBaseUrl}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        return { apiBaseUrl, child, output: () => output };
      }
    } catch {
      // Keep polling until the API binds the requested port.
    }
    await sleep(100);
  }
  throw new Error(`Signal API did not start on ${apiBaseUrl}.\n${output}`);
}

test('Signal local API preserves concurrent mutations without lost updates', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-concurrency-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  api = await startLocalActorApi({ port, statePath });

  const suffix = Date.now();
  const domainA = `concurrent-a-${suffix}.test`;
  const domainB = `concurrent-b-${suffix}.test`;
  const mutationHeaders = {
    'Content-Type': 'application/json',
    'X-Signal-Actor': 'usr_admin',
  };
  const [updateA, updateB] = await Promise.all([
    fetch(`${api.apiBaseUrl}/api/mutations`, {
      body: JSON.stringify({
        action: 'tenants.domain',
        args: {
          domain: domainA,
          tenantId: 'tenant_demo',
        },
      }),
      headers: mutationHeaders,
      method: 'POST',
    }).then(async (response) => ({ payload: await parseJsonResponse(response), status: response.status })),
    fetch(`${api.apiBaseUrl}/api/mutations`, {
      body: JSON.stringify({
        action: 'tenants.domain',
        args: {
          domain: domainB,
          tenantId: 'tenant_demo',
        },
      }),
      headers: mutationHeaders,
      method: 'POST',
    }).then(async (response) => ({ payload: await parseJsonResponse(response), status: response.status })),
  ]);

  assert.equal(updateA.status, 200);
  assert.equal(updateB.status, 200);
  assert.equal(updateA.payload.ok, true);
  assert.equal(updateB.payload.ok, true);

  const fileState = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const tenantDemo = fileState.tenants.find((tenant) => tenant.id === 'tenant_demo');
  assert.ok(tenantDemo, 'tenant_demo should remain present after concurrent domain updates');
  assert.ok([domainA, domainB].includes(tenantDemo.domain), 'final tenant domain should reflect one of the concurrent updates');

  const domainAudits = fileState.auditEvents.filter((event) =>
    event.action === 'tenants.domain' && event.targetId === 'tenant_demo');
  assert.equal(domainAudits.length, 2, 'concurrent updates to the same tenant record should append both audit events without losing one');
  assert.deepEqual(
    new Set(domainAudits.map((event) => event.actor)),
    new Set(['usr_admin']),
    'both concurrent domain updates should be attributed to the same actor',
  );
});

test('Signal local JSON backup/restore preserves full digestion, account, notification, governance, and completion reports', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-persistence-restore-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const registrationStatePath = path.join(tempDir, 'signal-registration-state.json');
  const vaultPath = path.join(tempDir, 'signal-vault.json');
  const backupPath = path.join(tempDir, 'signal-state.backup.json');
  const restoredPath = path.join(tempDir, 'signal-state.restored.json');
  const reportEnv = {
    SIGNAL_EMAIL_PROVIDER_TOKEN: '',
    SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET: '',
    SIGNAL_GMAIL_ACCESS_TOKEN: '',
    SIGNAL_OUTLOOK_ACCESS_TOKEN: '',
    SIGNAL_PROVIDER_ACCESS_TOKEN: '',
    SIGNAL_PROVIDER_SANDBOX_TIMEOUT_MS: '1000',
    SIGNAL_SENDGRID_API_KEY: '',
    SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: '',
    SIGNAL_STRIPE_PRICE_TEAM: '',
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
  };

  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await verifySignalLocal({
    cleanup: false,
    registrationStatePath,
    statePath,
    vaultPath,
  });

  await fs.copyFile(statePath, backupPath);
  await fs.copyFile(backupPath, restoredPath);

  const restored = await loadState({ statePath: restoredPath });
  assert(restored.sourceMessages.some((message) => message.providerRequestDigest && message.providerResponseDigest), 'restored state should preserve provider-backed source-message digestion provenance');
  assert(restored.flowRuns.some((run) => run.status === 'succeeded' && run.createdSignalIds.length >= 1), 'restored state should preserve detector flow run output');
  assert(restored.signals.some((signal) => signal.sourceMessageId && signal.flowId), 'restored state should preserve source-backed signals');
  assert(restored.accountEvents.some((event) => event.type === 'next_action'), 'restored state should preserve account timeline events');
  assert(restored.accountRecommendations.some((recommendation) => recommendation.status === 'open' && recommendation.strategy), 'restored state should preserve account recommendations');
  assert(restored.notificationDigestRuns.length >= 1, 'restored state should preserve notification digest runs');
  assert(restored.emailDeliveryMessages.some((message) => ['sent', 'bounced', 'suppressed'].includes(message.status)), 'restored state should preserve notification delivery outcomes');
  assert(restored.governancePolicies.some((policy) => policy.sourceRetentionDays === 30 && policy.redactionMode === 'strict'), 'restored state should preserve governance policy updates');
  assert(restored.redactionRules.some((rule) => rule.label === 'Executive names' && rule.status === 'disabled'), 'restored state should preserve redaction rule status updates');

  const doctorReport = doctor(restored);
  assert.equal(doctorReport.ok, true, JSON.stringify(doctorReport.checks.filter((check) => !check.ok)));
  const dashboard = dashboardAuditReport(restored, { statePath: restoredPath });
  assert.equal(dashboard.ok, true, JSON.stringify(dashboard.rows.filter((row) => !row.localOk)));
  const digestion = signalDigestionPipelineReport(restored, { statePath: restoredPath });
  assert.equal(digestion.ok, true, JSON.stringify(digestion.rows.filter((row) => !row.localOk)));
  assert.equal(digestion.summary.localReady, digestion.summary.total);
  const backend = backendReadiness({ env: {}, statePath: restoredPath });
  const readiness = productReadinessReport(restored, { backend, provider: providerReadiness(reportEnv) });
  assert.equal(readiness.ok, true, JSON.stringify(readiness.requirements.filter((requirement) => !requirement.localOk)));
  assert.equal(readiness.summary.localReady, readiness.summary.total);
  assert.equal(readiness.summary.total, 10);
  const completion = completionAuditReport(restored, {
    backend,
    dashboardAudit: dashboard,
    digestionPipeline: digestion,
    env: reportEnv,
    provider: providerReadiness(reportEnv),
    readiness,
    statePath: restoredPath,
  });
  assert.equal(completion.rows.length, 8);
  assert.equal(completion.summary.secretSafe, true);
  assert(completion.rows.some((row) => row.id === 'core_user_workspace' && row.localOk), JSON.stringify(completion.rows.filter((row) => !row.localOk)));
  assert(completion.rows.some((row) => row.id === 'payment_processing_architecture' && row.localOk), JSON.stringify(completion.rows.filter((row) => !row.localOk)));
});
