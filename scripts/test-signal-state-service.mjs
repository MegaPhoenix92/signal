#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  bootstrapState,
  issueSessionToken,
} from './signal-state.mjs';
import {
  createStateServiceConfig,
  createStateStore,
  StateServiceError,
} from './signal-state-service.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

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

async function waitForHttp(url, output, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        return;
      }
    } catch {
      // Poll until the local service binds.
    }
    await sleep(100);
  }
  throw new Error(`${label} did not become ready at ${url}.\n${output()}`);
}

async function startStateService({ backupDir, port, stateFile, token }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'signal-state-service.mjs')], {
    cwd: rootDir,
    env: {
      ...process.env,
      SIGNAL_STATE_SERVICE_BACKUP_DIR: backupDir,
      SIGNAL_STATE_SERVICE_FILE: stateFile,
      SIGNAL_STATE_SERVICE_HOST: '127.0.0.1',
      SIGNAL_STATE_SERVICE_PORT: String(port),
      SIGNAL_STATE_SERVICE_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  await waitForHttp(`${baseUrl}/health`, () => output, 'Signal state service');
  return {
    baseUrl,
    child,
    output: () => output,
  };
}

async function startApi({ apiPort, serviceToken, serviceUrl, sessionSecret }) {
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  let output = '';
  const child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'signal-api.mjs')], {
    cwd: rootDir,
    env: {
      ...process.env,
      SIGNAL_API_HOST: '127.0.0.1',
      SIGNAL_API_PORT: String(apiPort),
      SIGNAL_BACKEND_MODE: 'external-service',
      SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
      SIGNAL_SESSION_SECRET: sessionSecret,
      SIGNAL_STATE_SERVICE_TOKEN: serviceToken,
      SIGNAL_STATE_SERVICE_URL: serviceUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  await waitForHttp(`${apiBaseUrl}/api/health`, () => output, 'Signal API');
  return {
    apiBaseUrl,
    child,
  };
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

class FakePgPool {
  constructor() {
    this.backups = [];
    this.current = null;
    this.ended = false;
    this.queries = [];
  }

  async query(sql, params = []) {
    return this.handleQuery(sql, params);
  }

  async connect() {
    return {
      query: (sql, params = []) => this.handleQuery(sql, params),
      release: () => {},
    };
  }

  async end() {
    this.ended = true;
  }

  async handleQuery(sql, params = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ params, sql: normalized });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized)) {
      return { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith('CREATE TABLE') || normalized.startsWith('CREATE INDEX')) {
      return { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith('SELECT count(*)::int AS backup_count')) {
      return {
        rowCount: 1,
        rows: [{ backup_count: this.backups.length }],
      };
    }
    if (normalized.startsWith('SELECT revision, body_digest')) {
      if (!this.current) {
        return { rowCount: 0, rows: [] };
      }
      return {
        rowCount: 1,
        rows: [{
          body_digest: this.current.body_digest,
          revision: this.current.revision,
          size_bytes: JSON.stringify(this.current.body).length,
          updated_at: this.current.updated_at,
        }],
      };
    }
    if (normalized.startsWith('SELECT body FROM')) {
      return this.current ? { rowCount: 1, rows: [{ body: this.current.body }] } : { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith('SELECT body, revision, body_digest')) {
      return this.current ? { rowCount: 1, rows: [this.current] } : { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith('INSERT INTO') && normalized.includes('_backups')) {
      this.backups.push({
        body: JSON.parse(params[2]),
        body_digest: params[3],
        revision: params[1],
        state_id: params[0],
      });
      return { rowCount: 1, rows: [] };
    }
    if (normalized.startsWith('INSERT INTO') && normalized.includes('_current')) {
      this.current = {
        body: JSON.parse(params[1]),
        body_digest: params[3],
        revision: params[2],
        state_id: params[0],
        updated_at: new Date('2026-06-04T12:00:00.000Z'),
      };
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected fake pg query: ${normalized}`);
  }
}

test('Signal state service postgres backend migrates, versions, and backs up state', async () => {
  const config = createStateServiceConfig({
    DATABASE_URL: 'postgres://signal:secret@db.example/signal',
    SIGNAL_STATE_SERVICE_BACKEND: 'postgres',
    SIGNAL_STATE_SERVICE_HOST: '127.0.0.1',
    SIGNAL_STATE_SERVICE_PORT: '8791',
    SIGNAL_STATE_SERVICE_STATE_ID: 'tenant_demo',
    SIGNAL_STATE_SERVICE_TABLE_PREFIX: 'signal_state_test',
    SIGNAL_STATE_SERVICE_TOKEN: 'state_service_token',
  });
  const pool = new FakePgPool();
  const store = await createStateStore(config, { pgPool: pool });
  await store.init();
  assert(pool.queries.some((query) => query.sql.includes('CREATE TABLE IF NOT EXISTS "signal_state_test_current"')), 'postgres mode should create the current state table');
  assert(pool.queries.some((query) => query.sql.includes('CREATE TABLE IF NOT EXISTS "signal_state_test_backups"')), 'postgres mode should create the backup table');

  assert.equal(await store.read(), null);
  const firstMeta = await store.write(JSON.stringify({ auditEvents: [], meta: { tenantId: 'tenant_demo' } }));
  assert.equal(firstMeta.backend, 'postgres');
  assert.equal(firstMeta.exists, true);
  assert.equal(firstMeta.revision, 1);
  assert.equal(firstMeta.backups, 0);
  assert.equal(firstMeta.stateTable, 'signal_state_test_current');
  assert(!JSON.stringify(firstMeta).includes('secret'), 'postgres metadata must not serialize database credentials');

  const secondMeta = await store.write(JSON.stringify({
    apiSessions: [{ digest: 'session_digest_only' }],
    auditEvents: [{ action: 'users.invite', actor: 'usr_admin' }],
    meta: { tenantId: 'tenant_demo' },
  }), {
    ifMatch: `"${firstMeta.revision}"`,
  });
  assert.equal(secondMeta.revision, 2);
  assert.equal(secondMeta.backups, 1);
  assert.equal(pool.backups.length, 1);
  assert.equal(pool.backups[0].revision, 1);
  assert.match(await store.read(), /session_digest_only/);
  await assert.rejects(
    () => store.write('[]'),
    (error) => error instanceof StateServiceError && error.code === 'STATE_INVALID_SHAPE' && error.status === 400,
  );
  await store.close();
  assert.equal(pool.ended, true);
});

test('Signal state service postgres backend requires database configuration', () => {
  assert.throws(
    () => createStateServiceConfig({
      SIGNAL_STATE_SERVICE_BACKEND: 'postgres',
      SIGNAL_STATE_SERVICE_TOKEN: 'state_service_token',
    }),
    /DATABASE_URL/,
  );
});

test('Signal state-service admin CLI backs up, verifies, and restores through bearer-protected service', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-state-service-admin-'));
  const stateFile = path.join(tempDir, 'service-state.json');
  const backupDir = path.join(tempDir, 'backups');
  const backupPath = path.join(tempDir, 'manual-backup.json');
  const serviceToken = 'state_service_admin_test_token';
  const stateServicePort = await freePort();
  let stateService = null;

  t.after(async () => {
    await stopProcess(stateService?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  stateService = await startStateService({ backupDir, port: stateServicePort, stateFile, token: serviceToken });
  const serviceEnv = {
    ...process.env,
    SIGNAL_STATE_SERVICE_TOKEN: serviceToken,
    SIGNAL_STATE_SERVICE_URL: `${stateService.baseUrl}/state`,
  };

  const originalState = {
    auditEvents: [{ action: 'seed', actor: 'usr_admin' }],
    invites: [],
    memberships: [{ id: 'mem_tenant_demo_usr_admin', tenantId: 'tenant_demo', userId: 'usr_admin', role: 'admin', status: 'active' }],
    meta: { schemaVersion: 1 },
    tenants: [{ id: 'tenant_demo', name: 'Demo', domain: 'acme.example', status: 'active' }],
    users: [{ id: 'usr_admin', tenantId: 'tenant_demo', name: 'Avery Lane', email: 'avery@acme.example', role: 'admin', status: 'active' }],
  };
  const changedState = {
    ...originalState,
    auditEvents: [...originalState.auditEvents, { action: 'changed', actor: 'usr_admin' }],
    users: [...originalState.users, { id: 'usr_added', tenantId: 'tenant_demo', name: 'Added User', email: 'added@acme.example', role: 'member', status: 'active' }],
  };

  const seed = await fetch(`${stateService.baseUrl}/state`, {
    body: JSON.stringify(originalState),
    headers: {
      Authorization: `Bearer ${serviceToken}`,
      'Content-Type': 'application/json',
    },
    method: 'PUT',
  });
  assert.equal(seed.status, 200);

  async function runStateServiceAdmin(args) {
    const { stdout } = await execFileAsync(process.execPath, [path.join(rootDir, 'scripts', 'signal-state-service-admin.mjs'), ...args], {
      cwd: rootDir,
      env: serviceEnv,
      maxBuffer: 5 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  }

  const health = await runStateServiceAdmin(['health', '--json']);
  assert.equal(health.ok, true);
  assert.equal(health.health.storage.backend, 'file');
  assert.equal(health.health.state.exists, true);

  const backup = await runStateServiceAdmin(['backup', backupPath, '--json']);
  assert.equal(backup.ok, true);
  assert.equal(backup.backup.path, backupPath);
  assert.equal(backup.backup.summary.users, 1);
  assert(await fs.stat(backupPath));

  const verified = await runStateServiceAdmin(['verify', backupPath, '--json']);
  assert.equal(verified.ok, true);
  assert.equal(verified.backup.digest, backup.backup.digest);

  const beforeChange = await fetch(`${stateService.baseUrl}/state`, {
    headers: { Authorization: `Bearer ${serviceToken}` },
  });
  assert.equal(beforeChange.status, 200);
  const changeEtag = beforeChange.headers.get('etag');
  assert.ok(changeEtag, 'state service GET should return an ETag before update');

  const changed = await fetch(`${stateService.baseUrl}/state`, {
    body: JSON.stringify(changedState),
    headers: {
      Authorization: `Bearer ${serviceToken}`,
      'Content-Type': 'application/json',
      'If-Match': changeEtag,
    },
    method: 'PUT',
  });
  assert.equal(changed.status, 200);

  const dryRun = await runStateServiceAdmin(['restore', backupPath, '--dry-run', '--json']);
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.restore.summary.users, 1);

  const restored = await runStateServiceAdmin(['restore', backupPath, '--json']);
  assert.equal(restored.ok, true);
  assert.equal(restored.restore.serviceState.exists, true);

  const restoredResponse = await fetch(`${stateService.baseUrl}/state`, {
    headers: { Authorization: `Bearer ${serviceToken}` },
  });
  assert.equal(restoredResponse.status, 200);
  const restoredState = await restoredResponse.json();
  assert.equal(restoredState.users.length, 1);
  assert.equal(restoredState.users[0].id, 'usr_admin');
  assert.equal(restoredState.auditEvents.length, 1);
});

test('Signal state service enforces optimistic concurrency with ETag and If-Match', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-state-etag-'));
  const stateFile = path.join(tempDir, 'etag-state.json');
  const backupDir = path.join(tempDir, 'backups');
  const serviceToken = 'state_service_etag_test_token';
  const stateServicePort = await freePort();
  let stateService = null;

  t.after(async () => {
    await stopProcess(stateService?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  stateService = await startStateService({ backupDir, port: stateServicePort, stateFile, token: serviceToken });
  const serviceHeaders = {
    Authorization: `Bearer ${serviceToken}`,
    'Content-Type': 'application/json',
  };
  const originalState = {
    auditEvents: [{ action: 'seed', actor: 'usr_admin' }],
    meta: { schemaVersion: 1 },
    tenants: [{ id: 'tenant_demo', name: 'Demo', domain: 'acme.example', status: 'active' }],
    users: [{ id: 'usr_admin', tenantId: 'tenant_demo', name: 'Avery Lane', email: 'avery@acme.example', role: 'admin', status: 'active' }],
  };

  const seed = await fetch(`${stateService.baseUrl}/state`, {
    body: JSON.stringify(originalState),
    headers: serviceHeaders,
    method: 'PUT',
  });
  assert.equal(seed.status, 200);

  const read = await fetch(`${stateService.baseUrl}/state`, {
    headers: { Authorization: `Bearer ${serviceToken}` },
  });
  assert.equal(read.status, 200);
  const etag = read.headers.get('etag');
  assert.ok(etag, 'state service GET should return an ETag');

  const staleWrite = await fetch(`${stateService.baseUrl}/state`, {
    body: JSON.stringify({
      ...originalState,
      auditEvents: [...originalState.auditEvents, { action: 'stale', actor: 'usr_admin' }],
    }),
    headers: {
      ...serviceHeaders,
      'If-Match': '"stale-revision"',
    },
    method: 'PUT',
  });
  assert.equal(staleWrite.status, 409);
  const stalePayload = await staleWrite.json();
  assert.equal(stalePayload.code, 'STATE_REVISION_CONFLICT');

  const afterStaleRead = await fetch(`${stateService.baseUrl}/state`, {
    headers: { Authorization: `Bearer ${serviceToken}` },
  });
  assert.equal(afterStaleRead.status, 200);
  const afterStaleState = await afterStaleRead.json();
  assert.equal(afterStaleState.auditEvents.length, 1);
  assert.equal(afterStaleState.auditEvents[0].action, 'seed');
  assert.ok(!afterStaleState.auditEvents.some((event) => event.action === 'stale'), 'stale PUT must not persist');

  const missingIfMatch = await fetch(`${stateService.baseUrl}/state`, {
    body: JSON.stringify({
      ...originalState,
      auditEvents: [...originalState.auditEvents, { action: 'blocked', actor: 'usr_admin' }],
    }),
    headers: serviceHeaders,
    method: 'PUT',
  });
  assert.equal(missingIfMatch.status, 428);
  const missingIfMatchPayload = await missingIfMatch.json();
  assert.equal(missingIfMatchPayload.code, 'STATE_PRECONDITION_REQUIRED');

  const freshWrite = await fetch(`${stateService.baseUrl}/state`, {
    body: JSON.stringify({
      ...originalState,
      auditEvents: [...originalState.auditEvents, { action: 'fresh', actor: 'usr_admin' }],
    }),
    headers: {
      ...serviceHeaders,
      'If-Match': etag,
    },
    method: 'PUT',
  });
  assert.equal(freshWrite.status, 200);
});

test('Signal API can persist state through an external state service backend', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-state-service-'));
  const apiPort = await freePort();
  const stateServicePort = await freePort();
  const stateFile = path.join(tempDir, 'external-state.json');
  const backupDir = path.join(tempDir, 'backups');
  const serviceToken = 'state_service_test_token';
  const sessionSecret = 'signal_state_service_session_secret';
  const serviceUrl = `http://127.0.0.1:${stateServicePort}/state`;
  const previousServiceToken = process.env.SIGNAL_STATE_SERVICE_TOKEN;
  let api = null;
  let stateService = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await stopProcess(stateService?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
    if (previousServiceToken === undefined) {
      delete process.env.SIGNAL_STATE_SERVICE_TOKEN;
    } else {
      process.env.SIGNAL_STATE_SERVICE_TOKEN = previousServiceToken;
    }
  });

  stateService = await startStateService({ backupDir, port: stateServicePort, stateFile, token: serviceToken });
  const unauthorized = await fetch(serviceUrl);
  assert.equal(unauthorized.status, 401, 'state service should require a bearer token by default');
  process.env.SIGNAL_STATE_SERVICE_TOKEN = serviceToken;
  await bootstrapState({ force: true, statePath: serviceUrl });
  const tokenResult = await issueSessionToken('usr_admin', {
    actorUserId: 'usr_admin',
    env: { SIGNAL_SESSION_SECRET: sessionSecret },
    statePath: serviceUrl,
    ttlSeconds: 900,
  });
  const token = tokenResult.details.token;
  assert(await fs.stat(stateFile), 'state service should write the external state file');

  api = await startApi({ apiPort, serviceToken, serviceUrl, sessionSecret });
  const backend = await requestApi(api.apiBaseUrl, '/api/backend', { token });
  assert.equal(backend.status, 200);
  assert.equal(backend.payload.backend.mode, 'external-service');
  assert.equal(backend.payload.backend.checks.find((check) => check.id === 'durable_state')?.ok, true);

  const inviteEmail = `state-service-${Date.now()}@acme.example`;
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
  assert.equal(invite.payload.details.email, inviteEmail);

  await stopProcess(api.child);
  api = null;

  const persistedState = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert(persistedState.invites.some((item) => item.email === inviteEmail && item.status === 'pending'), 'state service should persist API-created invite before restart');
  assert(persistedState.auditEvents.some((event) => event.action === 'users.invite' && event.actor === 'usr_admin'), 'state service should persist mutation audit events');
  assert(!JSON.stringify(persistedState).includes(token), 'state service should not persist bearer session tokens');
  const backups = await fs.readdir(backupDir);
  assert(backups.some((item) => item.endsWith('.json')), 'state service should create backup snapshots on overwrite');

  api = await startApi({ apiPort, serviceToken, serviceUrl, sessionSecret });
  const after = await requestApi(api.apiBaseUrl, '/api/state', { token });
  assert.equal(after.status, 200);
  assert(after.payload.state.invites.some((item) => item.email === inviteEmail && item.status === 'pending'), 'restarted API should read state from the external state service');
  assert.equal(after.payload.summary.statePath, serviceUrl);
});
