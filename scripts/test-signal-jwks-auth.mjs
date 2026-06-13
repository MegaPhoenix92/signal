#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bootstrapState,
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

function startJwksServer({ jwk, port }) {
  const server = http.createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(`${JSON.stringify({ keys: [jwk] })}\n`);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end('{"ok":false}\n');
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function stopServer(server) {
  if (!server) {
    return;
  }
  await new Promise((resolve) => server.close(resolve));
}

async function waitForHttp(url, output, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        return;
      }
    } catch {
      // Poll until the local service is ready.
    }
    await sleep(100);
  }
  throw new Error(`${label} did not become ready at ${url}.\n${output()}`);
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signJwt({ kid, payload, privateKey }) {
  const header = {
    alg: 'RS256',
    kid,
    typ: 'JWT',
  };
  const unsigned = `${encodeJson(header)}.${encodeJson(payload)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned, 'utf8'), privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

test('Signal API accepts JWKS-backed production bearer auth', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-jwks-auth-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const apiPort = await freePort();
  const jwksPort = await freePort();
  const issuer = 'https://auth.signal.example/';
  const audience = 'signal-api';
  const kid = 'signal-test-key';
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    alg: 'RS256',
    kid,
    use: 'sig',
  };
  let apiProcess = null;
  let apiOutput = '';
  let jwksServer = null;

  try {
    await bootstrapState({ force: true, statePath });
    jwksServer = await startJwksServer({ jwk, port: jwksPort });
    apiProcess = spawn(process.execPath, [path.join(rootDir, 'scripts', 'signal-api.mjs')], {
      cwd: rootDir,
      env: {
        ...process.env,
        SIGNAL_ADMIN_STATE: statePath,
        SIGNAL_API_HOST: '127.0.0.1',
        SIGNAL_API_PORT: String(apiPort),
        SIGNAL_AUTH_AUDIENCE: audience,
        SIGNAL_AUTH_ISSUER: issuer,
        SIGNAL_AUTH_JWKS_URL: `http://127.0.0.1:${jwksPort}/.well-known/jwks.json`,
        SIGNAL_AUTH_PROVIDER: 'jwks',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    apiProcess.stdout.on('data', (chunk) => {
      apiOutput += chunk.toString();
    });
    apiProcess.stderr.on('data', (chunk) => {
      apiOutput += chunk.toString();
    });
    await waitForHttp(`http://127.0.0.1:${apiPort}/api/health`, () => apiOutput, 'Signal API');

    const nowSeconds = Math.floor(Date.now() / 1000);
    const tokenFor = (patch) => signJwt({
      kid,
      privateKey,
      payload: {
        aud: audience,
        exp: nowSeconds + 3600,
        iat: nowSeconds,
        iss: issuer,
        tenantId: 'tenant_demo',
        ...patch,
      },
    });
    const adminToken = tokenFor({
      email: 'avery@acme.example',
      role: 'admin',
      sub: 'usr_admin',
    });
    const memberToken = tokenFor({
      email: 'mia@acme.example',
      role: 'member',
      sub: 'usr_sales',
    });

    async function requestApi(pathname, { body, headers = {}, method = 'GET', token } = {}) {
      const response = await fetch(`http://127.0.0.1:${apiPort}${pathname}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        method,
      });
      return {
        payload: await parseJsonResponse(response),
        status: response.status,
      };
    }

    const missing = await requestApi('/api/session');
    assert.equal(missing.status, 401);
    assert.equal(missing.payload.code, 'SESSION_TOKEN_REQUIRED');

    const rawActorRejected = await requestApi('/api/session', {
      headers: { 'X-Signal-Actor': 'usr_admin' },
    });
    assert.equal(rawActorRejected.status, 401);
    assert.equal(rawActorRejected.payload.code, 'SESSION_TOKEN_REQUIRED');

    const adminSession = await requestApi('/api/session', { token: adminToken });
    assert.equal(adminSession.status, 200);
    assert.equal(adminSession.payload.actor.id, 'usr_admin');
    assert.equal(adminSession.payload.auth.mode, 'jwks');
    assert.equal(adminSession.payload.auth.role, 'admin');
    assert.equal(adminSession.payload.auth.tenantId, 'tenant_demo');

    const adminMutation = await requestApi('/api/mutations', {
      body: {
        action: 'jobs.run',
        args: { limit: 1, queue: 'provider_validation' },
      },
      method: 'POST',
      token: adminToken,
    });
    assert.equal(adminMutation.status, 200);
    assert.equal(adminMutation.payload.action, 'jobs.run');

    const memberBackend = await requestApi('/api/backend', { token: memberToken });
    assert.equal(memberBackend.status, 403);
    assert.equal(memberBackend.payload.code, 'FORBIDDEN');

    const mismatchedRole = await requestApi('/api/session', {
      token: tokenFor({
        email: 'avery@acme.example',
        role: 'member',
        sub: 'usr_admin',
      }),
    });
    assert.equal(mismatchedRole.status, 403);
    assert.equal(mismatchedRole.payload.code, 'AUTH_CLAIMS_MISMATCH');

    const badAudience = await requestApi('/api/session', {
      token: tokenFor({
        aud: 'wrong-audience',
        email: 'avery@acme.example',
        role: 'admin',
        sub: 'usr_admin',
      }),
    });
    assert.equal(badAudience.status, 401);
    assert.equal(badAudience.payload.code, 'AUTH_TOKEN_AUDIENCE_INVALID');

    const missingRole = await requestApi('/api/session', {
      token: tokenFor({
        email: 'avery@acme.example',
        sub: 'usr_admin',
      }),
    });
    assert.equal(missingRole.status, 403);
    assert.equal(missingRole.payload.code, 'AUTH_ROLE_CLAIM_MISSING');

    const expired = await requestApi('/api/session', {
      token: tokenFor({
        email: 'avery@acme.example',
        exp: nowSeconds - 3600,
        role: 'admin',
        sub: 'usr_admin',
      }),
    });
    assert.equal(expired.status, 401);
    assert.equal(expired.payload.code, 'AUTH_TOKEN_EXPIRED');

    const { privateKey: wrongSigningKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const wrongKeySignature = await requestApi('/api/session', {
      token: signJwt({
        kid,
        privateKey: wrongSigningKey,
        payload: {
          aud: audience,
          email: 'avery@acme.example',
          exp: nowSeconds + 3600,
          iat: nowSeconds,
          iss: issuer,
          role: 'admin',
          sub: 'usr_admin',
          tenantId: 'tenant_demo',
        },
      }),
    });
    assert.equal(wrongKeySignature.status, 401);
    assert.equal(wrongKeySignature.payload.code, 'AUTH_TOKEN_SIGNATURE_INVALID');

    const stateFile = await fs.readFile(statePath, 'utf8');
    assert(!stateFile.includes(adminToken), 'JWKS bearer token should not be persisted in local state');
  } finally {
    await stopProcess(apiProcess);
    await stopServer(jwksServer);
    await fs.rm(tempDir, { force: true, recursive: true });
  }
});
