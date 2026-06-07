import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertApiSecurityConfig,
  isLoopbackApiHost,
  localActorAllowed,
  requireOAuthActor,
  requestAuth,
  resolveOAuthActor,
  resolveWebhookActor,
  sessionCookieHeader,
  sessionCookieSecure,
} from './signal-api-auth.mjs';
import {
  OAuthProviderError,
  createOAuthStatePayload,
  oauthStateDigest,
  signOAuthState,
  verifyOAuthState,
} from './signal-oauth-provider.mjs';
import { signStripeWebhookPayload } from './signal-payment-provider.mjs';
import {
  bootstrapState,
  completeMailboxConnectionFromOAuthCallback,
  loadState,
  saveState,
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

test('OAuth state signing fails closed when SIGNAL_OAUTH_STATE_KEY is missing', () => {
  assert.throws(
    () => signOAuthState({ expiresAt: new Date(Date.now() + 60_000).toISOString(), provider: 'gmail' }, { env: {} }),
    (error) => error instanceof OAuthProviderError && error.code === 'OAUTH_STATE_KEY_MISSING',
  );
});

test('OAuth state verification rejects signatures from a removed public fallback key', () => {
  const oauthState = signOAuthState(
    { expiresAt: new Date(Date.now() + 60_000).toISOString(), provider: 'gmail' },
    { env: { SIGNAL_OAUTH_STATE_KEY: 'deployment-specific-secret' } },
  );
  assert.throws(
    () => verifyOAuthState(oauthState, { env: { SIGNAL_OAUTH_STATE_KEY: 'different-secret' } }),
    (error) => error instanceof OAuthProviderError && error.code === 'OAUTH_STATE_SIGNATURE_INVALID',
  );
});

test('requestAuth rejects unauthenticated local actor impersonation unless explicitly allowed', async () => {
  await assert.rejects(
    requestAuth({ headers: { 'x-signal-actor': 'usr_admin' } }, {}, { env: {} }),
    (error) => error.code === 'SESSION_TOKEN_REQUIRED',
  );

  const allowed = await requestAuth(
    { headers: { 'x-signal-actor': 'usr_admin' } },
    {},
    { env: { SIGNAL_ALLOW_LOCAL_ACTOR: 'true' } },
  );
  assert.equal(allowed.actorUserId, 'usr_admin');
  assert.equal(allowed.auth.mode, 'local_actor');
});

test('assertApiSecurityConfig blocks non-loopback hosts without verified auth', () => {
  assert.throws(
    () => assertApiSecurityConfig({ SIGNAL_API_HOST: '0.0.0.0' }),
    /not loopback/i,
  );
  assert.doesNotThrow(() => assertApiSecurityConfig({
    SIGNAL_API_HOST: '0.0.0.0',
    SIGNAL_BACKEND_MODE: 'external-service',
    SIGNAL_STATE_SERVICE_URL: 'http://state-service.example/state',
    SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
    SIGNAL_SESSION_SECRET: 'test-secret',
    SIGNAL_COOKIE_SECURE: 'true',
    SIGNAL_WEBHOOK_ACTOR: 'usr_system_webhook',
    SIGNAL_OAUTH_ACTOR: 'usr_system_oauth',
  }));
});

test('assertApiSecurityConfig blocks local actor mode on non-loopback hosts', () => {
  assert.throws(
    () => assertApiSecurityConfig({
      SIGNAL_API_HOST: '0.0.0.0',
      SIGNAL_ALLOW_LOCAL_ACTOR: 'true',
      SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
      SIGNAL_SESSION_SECRET: 'test-secret',
      SIGNAL_COOKIE_SECURE: 'true',
      SIGNAL_WEBHOOK_ACTOR: 'usr_system_webhook',
      SIGNAL_OAUTH_ACTOR: 'usr_system_oauth',
    }),
    /SIGNAL_ALLOW_LOCAL_ACTOR/i,
  );
});

test('assertApiSecurityConfig rejects file-backed state on non-loopback hosts', () => {
  assert.throws(
    () => assertApiSecurityConfig({
      SIGNAL_API_HOST: '0.0.0.0',
      SIGNAL_ADMIN_STATE: '/tmp/signal-state.json',
      SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
      SIGNAL_SESSION_SECRET: 'test-secret',
      SIGNAL_COOKIE_SECURE: 'true',
      SIGNAL_WEBHOOK_ACTOR: 'usr_system_webhook',
      SIGNAL_OAUTH_ACTOR: 'usr_system_oauth',
    }),
    /file-backed state|HTTP state-service URL/i,
  );
  assert.doesNotThrow(() => assertApiSecurityConfig({
    SIGNAL_API_HOST: '0.0.0.0',
    SIGNAL_BACKEND_MODE: 'external-service',
    SIGNAL_STATE_SERVICE_URL: 'http://state-service.example/state',
    SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
    SIGNAL_SESSION_SECRET: 'test-secret',
    SIGNAL_COOKIE_SECURE: 'true',
    SIGNAL_WEBHOOK_ACTOR: 'usr_system_webhook',
    SIGNAL_OAUTH_ACTOR: 'usr_system_oauth',
  }));
});

test('assertApiSecurityConfig requires system actors and secure cookies on non-loopback hosts', () => {
  assert.throws(
    () => assertApiSecurityConfig({
      SIGNAL_API_HOST: '0.0.0.0',
      SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
      SIGNAL_SESSION_SECRET: 'test-secret',
    }),
    /SIGNAL_WEBHOOK_ACTOR/i,
  );
  assert.throws(
    () => assertApiSecurityConfig({
      SIGNAL_API_HOST: '0.0.0.0',
      SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
      SIGNAL_SESSION_SECRET: 'test-secret',
      SIGNAL_WEBHOOK_ACTOR: 'usr_system_webhook',
      SIGNAL_OAUTH_ACTOR: 'usr_system_oauth',
    }),
    /SIGNAL_COOKIE_SECURE|HTTPS SIGNAL_APP_BASE_URL/i,
  );
});

test('assertApiSecurityConfig requires OAuth state key when provider clients are configured', () => {
  assert.throws(
    () => assertApiSecurityConfig({ SIGNAL_GMAIL_CLIENT_ID: 'configured' }),
    /SIGNAL_OAUTH_STATE_KEY/i,
  );
  assert.doesNotThrow(() => assertApiSecurityConfig({
    SIGNAL_GMAIL_CLIENT_ID: 'configured',
    SIGNAL_OAUTH_STATE_KEY: 'oauth-state-secret',
  }));
});

test('loopback helper recognizes local-only bind addresses', () => {
  assert.equal(isLoopbackApiHost('127.0.0.1'), true);
  assert.equal(isLoopbackApiHost('localhost'), true);
  assert.equal(isLoopbackApiHost('0.0.0.0'), false);
  assert.equal(localActorAllowed({ SIGNAL_ALLOW_LOCAL_ACTOR: 'true' }), true);
});

test('resolveWebhookActor ignores caller-supplied X-Signal-Actor unless local actor mode is enabled', async () => {
  const spoofed = await resolveWebhookActor({ headers: { 'x-signal-actor': 'usr_admin' } }, { env: {} });
  assert.equal(spoofed, null);

  const configured = await resolveWebhookActor({ headers: { 'x-signal-actor': 'usr_admin' } }, {
    env: { SIGNAL_WEBHOOK_ACTOR: 'usr_system_webhook' },
  });
  assert.equal(configured, 'usr_system_webhook');

  const local = await resolveWebhookActor({ headers: { 'x-signal-actor': 'usr_admin' } }, {
    env: { SIGNAL_ALLOW_LOCAL_ACTOR: 'true' },
  });
  assert.equal(local, 'usr_admin');
});

test('resolveOAuthActor ignores caller-supplied X-Signal-Actor unless local actor mode is enabled', async () => {
  const spoofed = await resolveOAuthActor({ headers: { 'x-signal-actor': 'usr_admin' } }, { env: {} });
  assert.equal(spoofed, null);

  const configured = await resolveOAuthActor({ headers: { 'x-signal-actor': 'usr_admin' } }, {
    env: { SIGNAL_OAUTH_ACTOR: 'usr_system_oauth' },
  });
  assert.equal(configured, 'usr_system_oauth');
});

test('session cookie adds Secure when production HTTPS base URL is configured', () => {
  assert.equal(sessionCookieSecure({ SIGNAL_APP_BASE_URL: 'https://signal.example' }), true);
  assert.equal(sessionCookieSecure({ SIGNAL_APP_BASE_URL: 'http://127.0.0.1:8787' }), false);
  const header = sessionCookieHeader('token_value', {
    env: { SIGNAL_APP_BASE_URL: 'https://signal.example' },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    issuedAt: new Date().toISOString(),
  });
  assert.match(header, /;\s*Secure(?:;|$)/);
});

test('sessionCookieSecure honors explicit SIGNAL_COOKIE_SECURE overrides', () => {
  assert.equal(sessionCookieSecure({
    SIGNAL_COOKIE_SECURE: 'true',
    SIGNAL_APP_BASE_URL: 'http://127.0.0.1:8787',
  }), true);
  assert.equal(sessionCookieSecure({
    SIGNAL_COOKIE_SECURE: 'false',
    SIGNAL_APP_BASE_URL: 'https://signal.example',
  }), false);
  const insecureHeader = sessionCookieHeader('token_value', {
    env: {
      SIGNAL_COOKIE_SECURE: 'false',
      SIGNAL_APP_BASE_URL: 'https://signal.example',
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    issuedAt: new Date().toISOString(),
  });
  assert.doesNotMatch(insecureHeader, /;\s*Secure(?:;|$)/);
});

test('OAuth callback rejects legacy connection sessions missing oauthStateDigest', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-oauth-digest-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const oauthEnv = { SIGNAL_OAUTH_STATE_KEY: 'oauth-digest-test-key' };
  const previousOAuthStateKey = process.env.SIGNAL_OAUTH_STATE_KEY;
  process.env.SIGNAL_OAUTH_STATE_KEY = oauthEnv.SIGNAL_OAUTH_STATE_KEY;
  t.after(() => {
    if (previousOAuthStateKey === undefined) {
      delete process.env.SIGNAL_OAUTH_STATE_KEY;
    } else {
      process.env.SIGNAL_OAUTH_STATE_KEY = previousOAuthStateKey;
    }
  });
  const oauthState = signOAuthState(createOAuthStatePayload({
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    mailboxId: 'mbx_outlook_success',
    ownerUserId: 'usr_admin',
    provider: 'outlook',
    sessionId: 'mcs_outlook_reauth',
    tenantId: 'tenant_demo',
  }), { env: oauthEnv });

  await assert.rejects(
    () => completeMailboxConnectionFromOAuthCallback('outlook', { code: 'provider-code', state: oauthState }, {
      actorUserId: 'usr_admin',
      statePath,
    }),
    (error) => {
      assert.equal(error.code, 'OAUTH_STATE_SESSION_MISMATCH');
      assert.equal(error.status, 401);
      assert.equal(error.details?.sessionId, 'mcs_outlook_reauth');
      return true;
    },
  );
});

test('OAuth callback rejects signed state that does not match session oauthStateDigest', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-oauth-digest-mismatch-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const oauthEnv = { SIGNAL_OAUTH_STATE_KEY: 'oauth-digest-mismatch-key' };
  const previousOAuthStateKey = process.env.SIGNAL_OAUTH_STATE_KEY;
  process.env.SIGNAL_OAUTH_STATE_KEY = oauthEnv.SIGNAL_OAUTH_STATE_KEY;
  t.after(() => {
    if (previousOAuthStateKey === undefined) {
      delete process.env.SIGNAL_OAUTH_STATE_KEY;
    } else {
      process.env.SIGNAL_OAUTH_STATE_KEY = previousOAuthStateKey;
    }
  });

  const boundOAuthState = signOAuthState(createOAuthStatePayload({
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    mailboxId: 'mbx_outlook_success',
    ownerUserId: 'usr_admin',
    provider: 'outlook',
    sessionId: 'mcs_outlook_reauth',
    tenantId: 'tenant_demo',
  }), { env: oauthEnv });
  const mismatchedOAuthState = signOAuthState(createOAuthStatePayload({
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    mailboxId: 'mbx_outlook_success',
    ownerUserId: 'usr_admin',
    provider: 'outlook',
    sessionId: 'mcs_outlook_reauth',
    tenantId: 'tenant_demo',
  }), { env: oauthEnv });

  const state = await loadState({ statePath });
  const session = state.mailboxConnectionSessions.find((candidate) => candidate.id === 'mcs_outlook_reauth');
  session.oauthStateDigest = oauthStateDigest(boundOAuthState);
  await saveState(state, { statePath });

  await assert.rejects(
    () => completeMailboxConnectionFromOAuthCallback('outlook', { code: 'provider-code', state: mismatchedOAuthState }, {
      actorUserId: 'usr_admin',
      statePath,
    }),
    (error) => {
      assert.equal(error.code, 'OAUTH_STATE_SESSION_MISMATCH');
      assert.equal(error.status, 401);
      assert.equal(error.details?.sessionId, 'mcs_outlook_reauth');
      return true;
    },
  );
});

test('requireOAuthActor fails closed when OAuth actor is not configured', () => {
  assert.throws(
    () => requireOAuthActor(null),
    (error) => error.code === 'OAUTH_ACTOR_REQUIRED',
  );
});

async function startApiForSecurityTest({ port, statePath, env = {} }) {
  const apiBaseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'signal-api.mjs')], {
    cwd: rootDir,
    env: {
      ...process.env,
      SIGNAL_ADMIN_STATE: statePath,
      SIGNAL_API_HOST: '127.0.0.1',
      SIGNAL_API_PORT: String(port),
      ...env,
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
      throw new Error(`Signal API exited before security test startup.\n${output}`);
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

test('production OAuth callback route ignores spoofed X-Signal-Actor and uses SIGNAL_OAUTH_ACTOR', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-oauth-actor-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  let api = null;
  const oauthEnv = { SIGNAL_OAUTH_STATE_KEY: 'oauth-actor-http-test-key' };
  const previousOAuthStateKey = process.env.SIGNAL_OAUTH_STATE_KEY;
  process.env.SIGNAL_OAUTH_STATE_KEY = oauthEnv.SIGNAL_OAUTH_STATE_KEY;

  t.after(async () => {
    if (previousOAuthStateKey === undefined) {
      delete process.env.SIGNAL_OAUTH_STATE_KEY;
    } else {
      process.env.SIGNAL_OAUTH_STATE_KEY = previousOAuthStateKey;
    }
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const oauthState = signOAuthState(createOAuthStatePayload({
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    mailboxId: 'mbx_outlook_success',
    ownerUserId: 'usr_admin',
    provider: 'outlook',
    sessionId: 'mcs_outlook_reauth',
    tenantId: 'tenant_demo',
  }), { env: oauthEnv });
  const state = await loadState({ statePath });
  const session = state.mailboxConnectionSessions.find((candidate) => candidate.id === 'mcs_outlook_reauth');
  session.oauthStateDigest = oauthStateDigest(oauthState);
  await saveState(state, { statePath });

  api = await startApiForSecurityTest({
    port,
    statePath,
    env: { SIGNAL_OAUTH_ACTOR: 'usr_admin' },
  });

  const callbackUrl = new URL(`${api.apiBaseUrl}/api/oauth/outlook/callback`);
  callbackUrl.searchParams.set('code', 'local_mcs_outlook_reauth');
  callbackUrl.searchParams.set('state', oauthState);
  const response = await fetch(callbackUrl, {
    headers: { 'X-Signal-Actor': 'usr_sales' },
  });
  const payload = await parseJsonResponse(response);
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.action, 'mailboxes.oauth-callback');

  const persisted = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const oauthAudit = persisted.auditEvents.filter((event) => event.action === 'mailboxes.oauth-callback').at(-1);
  assert.ok(oauthAudit, 'OAuth callback should append an audit event');
  assert.equal(oauthAudit.actor, 'usr_admin');
  assert.notEqual(oauthAudit.actor, 'usr_sales');
});

test('webhook route fails closed when SIGNAL_WEBHOOK_ACTOR is missing', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-webhook-actor-missing-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  api = await startApiForSecurityTest({ port, statePath });

  const response = await fetch(`${api.apiBaseUrl}/api/webhooks/gmail`, {
    body: JSON.stringify({}),
    headers: {
      'Content-Type': 'application/json',
      'X-Signal-Actor': 'usr_sales',
    },
    method: 'POST',
  });
  const payload = await parseJsonResponse(response);
  assert.equal(response.status, 500);
  assert.equal(payload.code, 'WEBHOOK_ACTOR_REQUIRED');
});

test('OAuth callback route fails closed when SIGNAL_OAUTH_ACTOR is missing', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-oauth-actor-missing-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  api = await startApiForSecurityTest({ port, statePath });

  const callbackUrl = new URL(`${api.apiBaseUrl}/api/oauth/outlook/callback`);
  callbackUrl.searchParams.set('code', 'local_mcs_outlook_reauth');
  callbackUrl.searchParams.set('state', 'ignored');
  const response = await fetch(callbackUrl, {
    headers: { 'X-Signal-Actor': 'usr_sales' },
  });
  const payload = await parseJsonResponse(response);
  assert.equal(response.status, 500);
  assert.equal(payload.code, 'OAUTH_ACTOR_REQUIRED');
});

test('production webhook route ignores spoofed X-Signal-Actor and uses SIGNAL_WEBHOOK_ACTOR', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-webhook-actor-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  const apiBaseUrl = `http://127.0.0.1:${port}`;
  const stripeWebhookSecret = 'signal_security_stripe_webhook_secret';
  let api = null;
  let output = '';

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  api = await startApiForSecurityTest({
    port,
    statePath,
    env: {
      SIGNAL_WEBHOOK_ACTOR: 'usr_admin',
      STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
    },
  });

  const eventBody = JSON.stringify({
    id: 'evt_security_webhook_actor',
    type: 'checkout.session.completed',
    livemode: false,
    data: {
      object: {
        id: 'cs_security_webhook_actor',
        object: 'checkout.session',
        customer: 'cus_security_webhook_actor',
        subscription: 'sub_security_webhook_actor',
        metadata: {
          planId: 'plan_team',
          tenantId: 'tenant_demo',
        },
      },
    },
  });
  const response = await fetch(`${apiBaseUrl}/api/webhooks/stripe`, {
    body: eventBody,
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': signStripeWebhookPayload(eventBody, stripeWebhookSecret),
      'X-Signal-Actor': 'usr_sales',
      'X-Signal-Session': 'stale_session_token_should_be_ignored',
    },
    method: 'POST',
  });
  const payload = await parseJsonResponse(response);
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.action, 'payments.webhook');

  const persisted = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const webhookAudit = persisted.auditEvents.filter((event) => event.action === 'payments.webhook').at(-1);
  assert.ok(webhookAudit, 'webhook mutation should append an audit event');
  assert.equal(webhookAudit.actor, 'usr_admin');
  assert.notEqual(webhookAudit.actor, 'usr_sales');
});

test('signal-api refuses to boot on non-loopback host without verified auth', async () => {
  let output = '';
  const child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'signal-api.mjs')], {
    cwd: rootDir,
    env: {
      ...process.env,
      SIGNAL_API_HOST: '0.0.0.0',
      SIGNAL_API_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const exitCode = await new Promise((resolve) => {
    child.on('exit', resolve);
  });
  assert.notEqual(exitCode, 0);
  assert.match(output, /not loopback/i);
});