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
  issueSessionToken,
} from './signal-state.mjs';

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
  const [tenantA, tenantB] = await Promise.all([
    fetch(`${api.apiBaseUrl}/api/mutations`, {
      body: JSON.stringify({
        action: 'tenants.create',
        args: {
          name: `Tenant A ${suffix}`,
          domain: `a-${suffix}.test`,
          adminEmail: `a-${suffix}@acme.example`,
        },
      }),
      headers: {
        'Content-Type': 'application/json',
        'X-Signal-Actor': 'usr_admin',
      },
      method: 'POST',
    }).then(async (response) => ({ payload: await parseJsonResponse(response), status: response.status })),
    fetch(`${api.apiBaseUrl}/api/mutations`, {
      body: JSON.stringify({
        action: 'tenants.create',
        args: {
          name: `Tenant B ${suffix}`,
          domain: `b-${suffix}.test`,
          adminEmail: `b-${suffix}@acme.example`,
        },
      }),
      headers: {
        'Content-Type': 'application/json',
        'X-Signal-Actor': 'usr_admin',
      },
      method: 'POST',
    }).then(async (response) => ({ payload: await parseJsonResponse(response), status: response.status })),
  ]);

  assert.equal(tenantA.status, 200);
  assert.equal(tenantB.status, 200);
  assert.equal(tenantA.payload.ok, true);
  assert.equal(tenantB.payload.ok, true);

  const fileState = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const tenantARecord = fileState.tenants.find((tenant) => tenant.domain === `a-${suffix}.test`);
  const tenantBRecord = fileState.tenants.find((tenant) => tenant.domain === `b-${suffix}.test`);
  assert.ok(tenantARecord?.id, 'concurrent mutation A should persist with an id');
  assert.ok(tenantBRecord?.id, 'concurrent mutation B should persist with an id');
  assert.notEqual(tenantARecord.id, tenantBRecord.id, 'concurrent tenants should receive distinct ids');

  const createAudits = fileState.auditEvents.filter((event) =>
    event.action === 'tenants.create'
    && (event.targetId === tenantARecord.id || event.targetId === tenantBRecord.id));
  assert.equal(createAudits.length, 2, 'both concurrent tenant creates should append audit events');
  assert.equal(new Set(createAudits.map((event) => event.actor)).size, 1);
  assert.equal(createAudits[0].actor, 'usr_admin');
});
