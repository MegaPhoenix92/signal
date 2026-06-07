import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertApiSecurityConfig,
  isLoopbackApiHost,
  localActorAllowed,
  requestAuth,
  resolveOAuthActor,
  resolveWebhookActor,
  sessionCookieHeader,
  sessionCookieSecure,
} from './signal-api-auth.mjs';
import {
  OAuthProviderError,
  createOAuthStatePayload,
  signOAuthState,
  verifyOAuthState,
} from './signal-oauth-provider.mjs';
import {
  bootstrapState,
  completeMailboxConnectionFromOAuthCallback,
} from './signal-state.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
    SIGNAL_SESSION_SECRET: 'test-secret',
  }));
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
    (error) => error.code === 'OAUTH_STATE_SESSION_MISMATCH',
  );
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