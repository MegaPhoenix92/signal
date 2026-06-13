import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ApiAuthError,
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
  createProviderWatchSecret,
  digestClientState,
} from './signal-provider-watch.mjs';
import {
  createLogger,
} from './signal-logger.mjs';
import {
  bootstrapState,
  createMailboxConnectionSession,
  completeMailboxConnectionFromOAuthCallback,
  applyMutation,
  issueSessionToken,
  loadState,
  revokeSessionToken,
  saveState,
  setUserRole,
  setUserStatus,
} from './signal-state.mjs';
import {
  SessionTokenError,
  createSessionToken,
} from './signal-session-token.mjs';
import {
  consumeTokenBucketState,
  createRateLimiter,
  createTokenBucketRateLimiter,
  normalizeInviteClaimRateLimitEmail,
  requestClientIp,
} from './signal-api-rate-limit.mjs';

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
    (error) => error instanceof ApiAuthError && error.code === 'API_AUTH_NOT_CONFIGURED',
  );
  assert.doesNotThrow(() => assertApiSecurityConfig({
    SIGNAL_API_HOST: '0.0.0.0',
    SIGNAL_API_CORS_ORIGINS: 'https://signal.example',
    SIGNAL_BACKEND_MODE: 'external-service',
    SIGNAL_STATE_SERVICE_URL: 'http://state-service.example/state',
    SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
    SIGNAL_SESSION_SECRET: 'signal_test_session_secret_32chars!',
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
      SIGNAL_SESSION_SECRET: 'signal_test_session_secret_32chars!',
      SIGNAL_COOKIE_SECURE: 'true',
      SIGNAL_WEBHOOK_ACTOR: 'usr_system_webhook',
      SIGNAL_OAUTH_ACTOR: 'usr_system_oauth',
    }),
    /SIGNAL_ALLOW_LOCAL_ACTOR/i,
  );
});

test('assertApiSecurityConfig blocks local actor mode in production mode', () => {
  assert.throws(
    () => assertApiSecurityConfig({
      NODE_ENV: 'production',
      SIGNAL_API_HOST: '127.0.0.1',
      SIGNAL_ALLOW_LOCAL_ACTOR: 'true',
    }),
    /SIGNAL_ALLOW_LOCAL_ACTOR/i,
  );
  assert.throws(
    () => assertApiSecurityConfig({
      SIGNAL_API_HOST: '127.0.0.1',
      SIGNAL_BACKEND_MODE: 'external-service',
      SIGNAL_ALLOW_LOCAL_ACTOR: 'true',
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
      SIGNAL_SESSION_SECRET: 'signal_test_session_secret_32chars!',
      SIGNAL_COOKIE_SECURE: 'true',
      SIGNAL_WEBHOOK_ACTOR: 'usr_system_webhook',
      SIGNAL_OAUTH_ACTOR: 'usr_system_oauth',
    }),
    /file-backed state|HTTP state-service URL/i,
  );
  assert.doesNotThrow(() => assertApiSecurityConfig({
    SIGNAL_API_HOST: '0.0.0.0',
    SIGNAL_API_CORS_ORIGINS: 'https://signal.example',
    SIGNAL_BACKEND_MODE: 'external-service',
    SIGNAL_STATE_SERVICE_URL: 'http://state-service.example/state',
    SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
    SIGNAL_SESSION_SECRET: 'signal_test_session_secret_32chars!',
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
      SIGNAL_SESSION_SECRET: 'signal_test_session_secret_32chars!',
    }),
    /SIGNAL_WEBHOOK_ACTOR/i,
  );
  assert.throws(
    () => assertApiSecurityConfig({
      SIGNAL_API_HOST: '0.0.0.0',
      SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
      SIGNAL_SESSION_SECRET: 'signal_test_session_secret_32chars!',
      SIGNAL_WEBHOOK_ACTOR: 'usr_system_webhook',
      SIGNAL_OAUTH_ACTOR: 'usr_system_oauth',
    }),
    /SIGNAL_COOKIE_SECURE|HTTPS SIGNAL_APP_BASE_URL/i,
  );
});

test('assertApiSecurityConfig rejects wildcard CORS origins on non-loopback hosts', () => {
  assert.throws(
    () => assertApiSecurityConfig({
      SIGNAL_API_HOST: '0.0.0.0',
      SIGNAL_API_CORS_ORIGINS: '*',
      SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
      SIGNAL_SESSION_SECRET: 'signal_test_session_secret_32chars!',
      SIGNAL_COOKIE_SECURE: 'true',
      SIGNAL_WEBHOOK_ACTOR: 'usr_system_webhook',
      SIGNAL_OAUTH_ACTOR: 'usr_system_oauth',
      SIGNAL_BACKEND_MODE: 'external-service',
      SIGNAL_STATE_SERVICE_URL: 'http://state-service.example/state',
    }),
    /SIGNAL_API_CORS_ORIGINS cannot include \*/i,
  );
});

test('assertApiSecurityConfig requires explicit CORS origins on non-loopback hosts', () => {
  assert.throws(
    () => assertApiSecurityConfig({
      SIGNAL_API_HOST: '0.0.0.0',
      SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
      SIGNAL_SESSION_SECRET: 'signal_test_session_secret_32chars!',
      SIGNAL_COOKIE_SECURE: 'true',
      SIGNAL_WEBHOOK_ACTOR: 'usr_system_webhook',
      SIGNAL_OAUTH_ACTOR: 'usr_system_oauth',
      SIGNAL_BACKEND_MODE: 'external-service',
      SIGNAL_STATE_SERVICE_URL: 'http://state-service.example/state',
    }),
    /explicit SIGNAL_API_CORS_ORIGINS/i,
  );
});

test('assertApiSecurityConfig requires Gmail webhook audience when Gmail intake is configured', () => {
  assert.throws(
    () => assertApiSecurityConfig({
      SIGNAL_API_HOST: '0.0.0.0',
      SIGNAL_GMAIL_NOTIFICATION_URL: 'https://signal.example/api/webhooks/gmail',
      SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
      SIGNAL_SESSION_SECRET: 'signal_test_session_secret_32chars!',
      SIGNAL_COOKIE_SECURE: 'true',
      SIGNAL_WEBHOOK_ACTOR: 'usr_system_webhook',
      SIGNAL_OAUTH_ACTOR: 'usr_system_oauth',
      SIGNAL_API_CORS_ORIGINS: 'https://signal.example',
      SIGNAL_BACKEND_MODE: 'external-service',
      SIGNAL_STATE_SERVICE_URL: 'http://state-service.example/state',
    }),
    /SIGNAL_GMAIL_WEBHOOK_AUDIENCE/i,
  );
});

test('assertApiSecurityConfig rejects short SIGNAL_SESSION_SECRET values', () => {
  assert.throws(
    () => assertApiSecurityConfig({ SIGNAL_SESSION_SECRET: 'too-short' }),
    (error) => error instanceof ApiAuthError && error.code === 'SESSION_SECRET_TOO_SHORT',
  );
});

test('session token signing rejects short SIGNAL_SESSION_SECRET values', () => {
  assert.throws(
    () => createSessionToken({
      user: { email: 'admin@acme.example', id: 'usr_admin', role: 'admin', tenantId: 'tenant_demo' },
      env: { SIGNAL_SESSION_SECRET: 'short-secret' },
    }),
    (error) => error instanceof SessionTokenError && error.code === 'SESSION_SECRET_TOO_SHORT',
  );
});

test('invite claim rate limiter blocks repeated attempts per client IP', () => {
  const limiter = createRateLimiter({ maxAttempts: 2, windowMs: 60_000 });
  const first = limiter.consume('invite-claim:ip:127.0.0.1');
  const second = limiter.consume('invite-claim:ip:127.0.0.1');
  const third = limiter.consume('invite-claim:ip:127.0.0.1');
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
  assert(third.retryAfterMs > 0);
});

test('invite claim rate limiter blocks repeated attempts per normalized email', () => {
  const limiter = createRateLimiter({ maxAttempts: 2, windowMs: 60_000 });
  const email = normalizeInviteClaimRateLimitEmail('Rate.Limit@Acme.Example');
  assert.equal(email, 'rate.limit@acme.example');
  const first = limiter.consume(`invite-claim:email:${email}`);
  const second = limiter.consume(`invite-claim:email:${email}`);
  const third = limiter.consume(`invite-claim:email:${email}`);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
  assert(third.retryAfterMs > 0);
});

test('shared token bucket adapter enforces API limits across limiter instances', async () => {
  let now = 1_000;
  const buckets = new Map();
  const sharedStore = {
    kind: 'fake-shared',
    async consumeTokenBucket(key, config, timestamp) {
      const result = consumeTokenBucketState(buckets.get(key), config, timestamp);
      buckets.set(key, result.bucket);
      return {
        allowed: result.allowed,
        retryAfterSeconds: result.retryAfterSeconds,
      };
    },
    reset() {
      buckets.clear();
    },
  };
  const firstReplica = createTokenBucketRateLimiter({ now: () => now, store: sharedStore });
  const secondReplica = createTokenBucketRateLimiter({ now: () => now, store: sharedStore });

  const first = await firstReplica.consume('authenticated|203.0.113.10', { burst: 1, rps: 0.01 });
  const second = await secondReplica.consume('authenticated|203.0.113.10', { burst: 1, rps: 0.01 });
  now += 100_000;
  const afterRefill = await secondReplica.consume('authenticated|203.0.113.10', { burst: 1, rps: 0.01 });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.retryAfterSeconds, 100);
  assert.equal(afterRefill.allowed, true);
});

test('requestClientIp ignores spoofed X-Forwarded-For unless the socket peer is trusted', () => {
  const ip = requestClientIp({
    headers: { 'x-forwarded-for': '203.0.113.10, 198.51.100.20' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  assert.equal(ip, '127.0.0.1');
});

test('requestClientIp uses the rightmost untrusted X-Forwarded-For hop behind trusted proxies', () => {
  const ip = requestClientIp({
    headers: { 'x-forwarded-for': '203.0.113.10, 198.51.100.20' },
    socket: { remoteAddress: '10.0.0.5' },
  }, {
    env: { SIGNAL_TRUSTED_PROXY: '10.0.0.5,198.51.100.20' },
  });
  assert.equal(ip, '203.0.113.10');
});

test('requestClientIp falls back to socket IP when X-Forwarded-For hop is not a valid address', () => {
  const ip = requestClientIp({
    headers: { 'x-forwarded-for': 'uid-rotating-bucket' },
    socket: { remoteAddress: '10.0.0.5' },
  }, {
    env: { SIGNAL_TRUSTED_PROXY: '10.0.0.5' },
  });
  assert.equal(ip, '10.0.0.5');
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

test('OAuth callback rejects signed state with a nonce mismatch', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-oauth-nonce-mismatch-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const oauthEnv = { SIGNAL_OAUTH_STATE_KEY: 'oauth-nonce-mismatch-key' };
  const previousOAuthStateKey = process.env.SIGNAL_OAUTH_STATE_KEY;
  process.env.SIGNAL_OAUTH_STATE_KEY = oauthEnv.SIGNAL_OAUTH_STATE_KEY;
  t.after(() => {
    if (previousOAuthStateKey === undefined) {
      delete process.env.SIGNAL_OAUTH_STATE_KEY;
    } else {
      process.env.SIGNAL_OAUTH_STATE_KEY = previousOAuthStateKey;
    }
  });

  const oauthPayload = createOAuthStatePayload({
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    mailboxId: 'mbx_outlook_success',
    ownerUserId: 'usr_admin',
    provider: 'outlook',
    sessionId: 'mcs_outlook_reauth',
    tenantId: 'tenant_demo',
  });
  const oauthState = signOAuthState(oauthPayload, { env: oauthEnv });
  const state = await loadState({ statePath });
  const session = state.mailboxConnectionSessions.find((candidate) => candidate.id === 'mcs_outlook_reauth');
  session.oauthStateDigest = oauthStateDigest(oauthState);
  session.oauthStateNonce = 'mismatched-nonce';
  await saveState(state, { statePath });

  await assert.rejects(
    () => completeMailboxConnectionFromOAuthCallback('outlook', { code: 'local_mcs_outlook_reauth', state: oauthState }, {
      actorUserId: 'usr_admin',
      env: oauthEnv,
      statePath,
    }),
    (error) => {
      assert.equal(error.code, 'OAUTH_STATE_NONCE_MISMATCH');
      assert.equal(error.status, 401);
      assert.equal(error.details?.sessionId, 'mcs_outlook_reauth');
      return true;
    },
  );
});

test('OAuth callback rejects a session whose provider differs from the callback provider', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-oauth-session-provider-mismatch-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const oauthEnv = { SIGNAL_OAUTH_STATE_KEY: 'oauth-session-provider-mismatch-key' };
  const previousOAuthStateKey = process.env.SIGNAL_OAUTH_STATE_KEY;
  process.env.SIGNAL_OAUTH_STATE_KEY = oauthEnv.SIGNAL_OAUTH_STATE_KEY;
  t.after(() => {
    if (previousOAuthStateKey === undefined) {
      delete process.env.SIGNAL_OAUTH_STATE_KEY;
    } else {
      process.env.SIGNAL_OAUTH_STATE_KEY = previousOAuthStateKey;
    }
  });

  const oauthPayload = createOAuthStatePayload({
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    mailboxId: 'mbx_outlook_success',
    ownerUserId: 'usr_admin',
    provider: 'outlook',
    sessionId: 'mcs_outlook_reauth',
    tenantId: 'tenant_demo',
  });
  const oauthState = signOAuthState(oauthPayload, { env: oauthEnv });
  const state = await loadState({ statePath });
  const session = state.mailboxConnectionSessions.find((candidate) => candidate.id === 'mcs_outlook_reauth');
  session.provider = 'gmail';
  session.oauthStateDigest = oauthStateDigest(oauthState);
  session.oauthStateNonce = oauthPayload.nonce;
  session.selectedScopes = ['selected_label_snippets'];
  await saveState(state, { statePath });

  await assert.rejects(
    () => completeMailboxConnectionFromOAuthCallback('outlook', { code: 'local_mcs_outlook_reauth', state: oauthState }, {
      actorUserId: 'usr_admin',
      env: oauthEnv,
      statePath,
    }),
    (error) => {
      assert.equal(error.code, 'OAUTH_SESSION_PROVIDER_MISMATCH');
      assert.equal(error.status, 400);
      return true;
    },
  );
});

test('OAuth callback fails closed when token exchange is unconfigured for provider codes', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-oauth-exchange-unconfigured-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const oauthEnv = { SIGNAL_OAUTH_STATE_KEY: 'oauth-exchange-unconfigured-key' };
  const previousOAuthStateKey = process.env.SIGNAL_OAUTH_STATE_KEY;
  process.env.SIGNAL_OAUTH_STATE_KEY = oauthEnv.SIGNAL_OAUTH_STATE_KEY;
  t.after(() => {
    if (previousOAuthStateKey === undefined) {
      delete process.env.SIGNAL_OAUTH_STATE_KEY;
    } else {
      process.env.SIGNAL_OAUTH_STATE_KEY = previousOAuthStateKey;
    }
  });

  const connect = await createMailboxConnectionSession({
    tenantId: 'tenant_demo',
    provider: 'gmail',
    ownerUserId: 'usr_admin',
  }, {
    actorUserId: 'usr_admin',
    statePath,
  });
  const sessionId = connect.details.sessionId;
  const oauthState = new URL(connect.details.localCallbackUrl).searchParams.get('state');

  await assert.rejects(
    () => completeMailboxConnectionFromOAuthCallback('gmail', { code: 'provider-code', state: oauthState }, {
      actorUserId: 'usr_admin',
      env: oauthEnv,
      statePath,
    }),
    (error) => {
      assert.equal(error.code, 'OAUTH_TOKEN_EXCHANGE_NOT_CONFIGURED');
      assert.equal(error.status, 412);
      return true;
    },
  );

  const state = await loadState({ statePath });
  const failedSession = state.mailboxConnectionSessions.find((candidate) => candidate.id === sessionId);
  assert.equal(failedSession.status, 'failed');
  assert.equal(failedSession.failureCode, 'OAUTH_TOKEN_EXCHANGE_NOT_CONFIGURED');
  assert.equal(state.mailboxes.some((mailbox) => mailbox.id === 'mbx_gmail_usr_admin'), false);
  assert(state.jobs.some((job) => job.targetId === sessionId && job.type === 'mailbox.oauth.callback.failed' && job.status === 'failed'));
});

test('requireOAuthActor fails closed when OAuth actor is not configured', () => {
  assert.throws(
    () => requireOAuthActor(null),
    (error) => error.code === 'OAUTH_ACTOR_REQUIRED',
  );
});

test('structured logger emits JSON and redacts sensitive fields', () => {
  const lines = [];
  const logger = createLogger({ service: 'signal-test', sink: (line) => lines.push(line) });
  logger.info('credential_check', {
    authorization: 'Bearer secret-token-value',
    nested: {
      refreshToken: 'refresh-token-value',
    },
    requestId: 'req_test',
  });

  assert.equal(lines.length, 1);
  assert(!lines[0].includes('secret-token-value'));
  assert(!lines[0].includes('refresh-token-value'));
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.service, 'signal-test');
  assert.equal(parsed.event, 'credential_check');
  assert.equal(parsed.authorization, '[redacted]');
  assert.equal(parsed.nested.refreshToken, '[redacted]');
  assert.equal(parsed.requestId, 'req_test');
  assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T/);
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

test('API health is liveness and readiness reports local state dependency', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-api-ready-local-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  api = await startApiForSecurityTest({ port, statePath });

  const health = await fetch(`${api.apiBaseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await parseJsonResponse(health), {
    ok: true,
    service: 'signal-local-api',
  });

  const ready = await fetch(`${api.apiBaseUrl}/api/ready`);
  const payload = await parseJsonResponse(ready);
  assert.equal(ready.status, 200);
  assert.equal(payload.ok, true);
  assert(payload.components.some((component) => component.component === 'state' && component.ok));
  assert.equal(payload.service, 'signal-local-api');
  assert.equal(payload.summary, undefined);
  assert.equal(payload.doctor, undefined);
  assert.equal(payload.statePath, undefined);
});

test('API readiness returns 503 when external state service is unavailable', async (t) => {
  const port = await freePort();
  const stateServicePort = await freePort();
  const stateUrl = `http://127.0.0.1:${stateServicePort}/state`;
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
  });

  api = await startApiForSecurityTest({
    port,
    statePath: stateUrl,
    env: {
      SIGNAL_BACKEND_MODE: 'external-service',
      SIGNAL_READY_TIMEOUT_MS: '250',
      SIGNAL_STATE_SERVICE_URL: stateUrl,
    },
  });

  const health = await fetch(`${api.apiBaseUrl}/api/health`);
  assert.equal(health.status, 200);

  const ready = await fetch(`${api.apiBaseUrl}/api/ready`);
  const payload = await parseJsonResponse(ready);
  assert.equal(ready.status, 503);
  assert.equal(payload.ok, false);
  assert.equal(payload.service, 'signal-local-api');
  assert.match(payload.code, /READY|STATE|FETCH|API_ERROR/i);
});

test('signed API state is scoped for platform operators, tenant admins, and members', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-api-scoped-state-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  const env = { SIGNAL_REQUIRE_SIGNED_SESSION: 'true', SIGNAL_SESSION_SECRET: 'scoped-state-secret-32chars-value!' };
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const state = await loadState({ statePath });
  state.users.find((user) => user.id === 'usr_admin').platformRole = 'operator';
  state.tenants.push({
    id: 'tenant_other',
    name: 'Other Tenant',
    domain: 'other.example',
    status: 'active',
    planId: 'plan_team',
    ownerUserId: 'usr_other_admin',
    billingOwnerUserId: 'usr_other_admin',
  });
  state.users.push({
    id: 'usr_other_admin',
    tenantId: 'tenant_other',
    name: 'Other Admin',
    email: 'admin@other.example',
    role: 'admin',
    status: 'active',
  });
  state.memberships.push({
    id: 'mem_tenant_other_usr_other_admin',
    tenantId: 'tenant_other',
    userId: 'usr_other_admin',
    role: 'admin',
    team: 'ops',
    status: 'active',
    createdAt: new Date().toISOString(),
  });
  state.auditEvents = [
    ...(state.auditEvents ?? []),
    { id: 'audit_demo_scope', action: 'tenants.status', targetId: 'tenant_demo', message: 'Demo tenant audit', createdAt: '2026-06-01T00:00:00.000Z', actor: 'usr_admin' },
    { id: 'audit_other_scope', action: 'tenants.status', targetId: 'tenant_other', message: 'Other tenant audit', createdAt: '2026-06-01T00:01:00.000Z', actor: 'usr_other_admin' },
  ];
  await saveState(state, { statePath });

  const operatorToken = await issueSessionToken('usr_admin', { actorUserId: 'usr_admin', env, statePath });
  const tenantAdminToken = await issueSessionToken('usr_other_admin', { actorUserId: 'usr_admin', env, statePath });
  const memberToken = await issueSessionToken('usr_sales', { actorUserId: 'usr_admin', env, statePath });
  api = await startApiForSecurityTest({ port, statePath, env });

  const operatorState = await signedSessionGet(api.apiBaseUrl, operatorToken.details.token);
  assert.equal(operatorState.status, 200);
  assert.deepEqual(operatorState.payload.state.tenants.map((item) => item.id).sort(), ['tenant_demo', 'tenant_other']);
  assert(operatorState.payload.state.auditEvents.some((event) => event.id === 'audit_other_scope'));

  const tenantAdminState = await signedSessionGet(api.apiBaseUrl, tenantAdminToken.details.token);
  assert.equal(tenantAdminState.status, 200);
  assert.deepEqual(tenantAdminState.payload.state.tenants.map((item) => item.id), ['tenant_other']);
  assert(tenantAdminState.payload.state.auditEvents.some((event) => event.id === 'audit_other_scope'));
  assert.equal(tenantAdminState.payload.state.auditEvents.some((event) => event.id === 'audit_demo_scope'), false);

  const memberState = await signedSessionGet(api.apiBaseUrl, memberToken.details.token);
  assert.equal(memberState.status, 200);
  assert.deepEqual(memberState.payload.state.tenants.map((item) => item.id), ['tenant_demo']);
  assert.equal(Object.hasOwn(memberState.payload.state, 'auditEvents'), false);
});

async function signedSessionGet(apiBaseUrl, token, pathname = '/api/state') {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    payload: await parseJsonResponse(response),
    status: response.status,
  };
}

test('revoked signed API sessions are rejected on the next request', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-session-revoked-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  const env = { SIGNAL_REQUIRE_SIGNED_SESSION: 'true', SIGNAL_SESSION_SECRET: 'signal_test_session_secret_32chars!' };
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const issued = await issueSessionToken('usr_admin', { actorUserId: 'usr_admin', env, statePath });
  api = await startApiForSecurityTest({ port, statePath, env });

  assert.equal((await signedSessionGet(api.apiBaseUrl, issued.details.token)).status, 200);
  await revokeSessionToken(issued.details.token, { actorUserId: 'usr_admin', statePath });

  const revoked = await signedSessionGet(api.apiBaseUrl, issued.details.token);
  assert.equal(revoked.status, 401);
  assert.equal(revoked.payload.code, 'SESSION_REVOKED');
});

test('role changes revoke existing sessions before the next admin request', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-session-demotion-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  const env = { SIGNAL_REQUIRE_SIGNED_SESSION: 'true', SIGNAL_SESSION_SECRET: 'session-demotion-secret-32chars!' };
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const issued = await issueSessionToken('usr_admin', { actorUserId: 'usr_admin', env, statePath });
  api = await startApiForSecurityTest({ port, statePath, env });
  assert.equal((await signedSessionGet(api.apiBaseUrl, issued.details.token, '/api/backend')).status, 200);

  const roleChange = await setUserRole('usr_admin', 'member', { actorUserId: 'usr_admin', statePath });
  assert.equal(roleChange.details.revokedSessions, 1);

  const demoted = await signedSessionGet(api.apiBaseUrl, issued.details.token, '/api/backend');
  assert.equal(demoted.status, 401);
  assert.equal(demoted.payload.code, 'SESSION_REVOKED');
});

test('disabling a user rejects all of their existing signed sessions', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-session-disabled-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  const env = { SIGNAL_REQUIRE_SIGNED_SESSION: 'true', SIGNAL_SESSION_SECRET: 'session-disabled-secret-32chars!' };
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const issued = await issueSessionToken('usr_sales', { actorUserId: 'usr_admin', env, statePath });
  api = await startApiForSecurityTest({ port, statePath, env });
  assert.equal((await signedSessionGet(api.apiBaseUrl, issued.details.token)).status, 200);

  const disabled = await setUserStatus('usr_sales', 'disabled', { actorUserId: 'usr_admin', statePath });
  assert.equal(disabled.details.revokedSessions, 1);

  const rejected = await signedSessionGet(api.apiBaseUrl, issued.details.token);
  assert.equal(rejected.status, 401);
  assert.equal(rejected.payload.code, 'SESSION_REVOKED');
});

test('users.revoke-sessions revokes every active session for a user', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-user-revoke-sessions-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  const env = { SIGNAL_REQUIRE_SIGNED_SESSION: 'true', SIGNAL_SESSION_SECRET: 'session-revoke-all-secret-32chars!' };
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const first = await issueSessionToken('usr_sales', { actorUserId: 'usr_admin', env, statePath });
  const second = await issueSessionToken('usr_sales', { actorUserId: 'usr_admin', env, statePath });
  api = await startApiForSecurityTest({ port, statePath, env });
  assert.equal((await signedSessionGet(api.apiBaseUrl, first.details.token)).status, 200);
  assert.equal((await signedSessionGet(api.apiBaseUrl, second.details.token)).status, 200);

  const revoked = await applyMutation('users.revoke-sessions', { userId: 'usr_sales' }, { actorUserId: 'usr_admin', statePath });
  assert.equal(revoked.details.revokedSessions, 2);

  for (const token of [first.details.token, second.details.token]) {
    const response = await signedSessionGet(api.apiBaseUrl, token);
    assert.equal(response.status, 401);
    assert.equal(response.payload.code, 'SESSION_REVOKED');
  }
});

test('local actor mode rejects unknown actors through API routes', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-local-actor-unknown-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  api = await startApiForSecurityTest({
    port,
    statePath,
    env: { SIGNAL_ALLOW_LOCAL_ACTOR: 'true' },
  });

  const response = await fetch(`${api.apiBaseUrl}/api/state`, {
    headers: { 'X-Signal-Actor': 'usr_missing' },
  });
  const payload = await parseJsonResponse(response);
  assert.equal(response.status, 401);
  assert.equal(payload.code, 'ACTOR_INVALID');
});

test('API rejects oversized JSON bodies before route mutation handling', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-body-limit-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  api = await startApiForSecurityTest({
    port,
    statePath,
    env: { SIGNAL_API_MAX_BODY_BYTES: '32' },
  });

  const response = await fetch(`${api.apiBaseUrl}/api/registration`, {
    body: JSON.stringify({ name: 'Oversized workspace name', domain: 'oversized.example', adminEmail: 'admin@example.test' }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const payload = await parseJsonResponse(response);
  assert.equal(response.status, 413);
  assert.equal(payload.code, 'REQUEST_BODY_TOO_LARGE');
});

test('API rate limiter returns 429 with Retry-After and health is exempt', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-rate-limit-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  api = await startApiForSecurityTest({
    port,
    statePath,
    env: {
      SIGNAL_API_UNAUTH_RATE_LIMIT_BURST: '1',
      SIGNAL_API_UNAUTH_RATE_LIMIT_RPS: '0.01',
    },
  });

  const body = JSON.stringify({ name: 'Rate Limit', domain: 'rate-limit.example', adminEmail: 'rate-limit@example.test' });
  const first = await fetch(`${api.apiBaseUrl}/api/registration`, {
    body,
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  assert.notEqual(first.status, 429);

  const second = await fetch(`${api.apiBaseUrl}/api/registration`, {
    body,
    headers: {
      'Authorization': 'Bearer rotated-session-token-shard',
      'Content-Type': 'application/json',
      'X-Signal-Actor': 'usr_rotated_actor',
    },
    method: 'POST',
  });
  const payload = await parseJsonResponse(second);
  assert.equal(second.status, 429);
  assert.equal(payload.code, 'RATE_LIMITED');
  assert.match(second.headers.get('retry-after') ?? '', /^\d+$/);

  const health = await fetch(`${api.apiBaseUrl}/api/health`);
  assert.equal(health.status, 200);
});

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
  const oauthPayload = createOAuthStatePayload({
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    mailboxId: 'mbx_outlook_success',
    ownerUserId: 'usr_admin',
    provider: 'outlook',
    sessionId: 'mcs_outlook_reauth',
    tenantId: 'tenant_demo',
  });
  const oauthState = signOAuthState(oauthPayload, { env: oauthEnv });
  const state = await loadState({ statePath });
  const session = state.mailboxConnectionSessions.find((candidate) => candidate.id === 'mcs_outlook_reauth');
  session.oauthStateDigest = oauthStateDigest(oauthState);
  session.oauthStateNonce = oauthPayload.nonce;
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

function startGoogleJwksServer({ jwk, port }) {
  const server = http.createServer((req, res) => {
    if (req.url === '/oauth2/v3/certs') {
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

test('malformed JSON request bodies return 400 instead of 500', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-invalid-json-'));
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
    body: '{not-json',
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const payload = await parseJsonResponse(response);
  assert.equal(response.status, 400);
  assert.equal(payload.code, 'INVALID_JSON');
  assert.equal(payload.error, 'Invalid JSON body');
});

test('wildcard CORS does not reflect arbitrary origins with credentials', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-cors-wildcard-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  api = await startApiForSecurityTest({
    port,
    statePath,
    env: { SIGNAL_API_CORS_ORIGINS: '*' },
  });

  const response = await fetch(`${api.apiBaseUrl}/api/health`, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
});

test('Gmail webhook rejects unauthenticated push when audience verification is enabled', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-gmail-webhook-auth-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  api = await startApiForSecurityTest({
    port,
    statePath,
    env: {
      SIGNAL_GMAIL_WEBHOOK_AUDIENCE: `http://127.0.0.1:${port}/api/webhooks/gmail`,
      SIGNAL_WEBHOOK_ACTOR: 'usr_admin',
    },
  });

  const response = await fetch(`${api.apiBaseUrl}/api/webhooks/gmail`, {
    body: JSON.stringify({ message: { data: Buffer.from('{}', 'utf8').toString('base64') } }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const payload = await parseJsonResponse(response);
  assert.equal(response.status, 401);
  assert.equal(payload.code, 'GMAIL_WEBHOOK_AUTH_REQUIRED');
});

test('Gmail webhook accepts verified Pub/Sub push tokens when audience verification is enabled', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-gmail-webhook-verified-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  const jwksPort = await freePort();
  const audience = `http://127.0.0.1:${port}/api/webhooks/gmail`;
  const kid = 'gmail-webhook-test-key';
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    alg: 'RS256',
    kid,
    use: 'sig',
  };
  let api = null;
  let jwksServer = null;

  t.after(async () => {
    await stopServer(jwksServer);
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  jwksServer = await startGoogleJwksServer({ jwk, port: jwksPort });
  const state = await loadState({ statePath });
  state.emailWatchSubscriptions = state.emailWatchSubscriptions ?? [];
  state.emailWatchSubscriptions.push({
    expirationAt: new Date(Date.now() + 86_400_000).toISOString(),
    id: 'watch_gmail_security_test',
    mailboxId: 'mbx_gmail_sales',
    notificationUrl: `${audience}`,
    provider: 'gmail',
    providerWatchId: 'gmail-watch-security-test',
    status: 'active',
  });
  await saveState(state, { statePath });

  api = await startApiForSecurityTest({
    port,
    statePath,
    env: {
      SIGNAL_GMAIL_WEBHOOK_AUDIENCE: audience,
      SIGNAL_GMAIL_WEBHOOK_JWKS_URL: `http://127.0.0.1:${jwksPort}/oauth2/v3/certs`,
      SIGNAL_WEBHOOK_ACTOR: 'usr_admin',
    },
  });

  const token = signJwt({
    kid,
    privateKey,
    payload: {
      aud: audience,
      email: 'pubsub@system.gserviceaccount.com',
      exp: Math.floor(Date.now() / 1000) + 300,
      iss: 'https://accounts.google.com',
      sub: 'pubsub@system.gserviceaccount.com',
    },
  });
  const response = await fetch(`${api.apiBaseUrl}/api/webhooks/gmail`, {
    body: JSON.stringify({
      message: {
        data: Buffer.from(JSON.stringify({ emailAddress: 'mia@acme.example', historyId: '12345' }), 'utf8').toString('base64'),
      },
    }),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  const payload = await parseJsonResponse(response);
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.action, 'mailboxes.watch-notification');
});

test('Outlook webhook rejects notifications missing clientState', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-outlook-webhook-client-state-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  api = await startApiForSecurityTest({
    port,
    statePath,
    env: { SIGNAL_WEBHOOK_ACTOR: 'usr_admin' },
  });

  const response = await fetch(`${api.apiBaseUrl}/api/webhooks/outlook`, {
    body: JSON.stringify({
      value: [
        {
          resource: 'me/messages/msg-001',
          resourceData: { id: 'msg-001' },
        },
      ],
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const payload = await parseJsonResponse(response);
  assert.equal(response.status, 401);
  assert.equal(payload.code, 'OUTLOOK_NOTIFICATION_CLIENT_STATE_REQUIRED');
});

test('Outlook webhook accepts notifications with matching clientState', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-outlook-webhook-valid-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const state = await loadState({ statePath });
  const mailboxId = 'mbx_outlook_success';
  const clientState = createProviderWatchSecret('outlook', mailboxId, { local: true });
  state.emailWatchSubscriptions = state.emailWatchSubscriptions ?? [];
  state.emailWatchSubscriptions.push({
    clientStateDigest: digestClientState(clientState),
    expirationAt: new Date(Date.now() + 86_400_000).toISOString(),
    id: 'watch_outlook_security_test',
    mailboxId,
    notificationUrl: `http://127.0.0.1:${port}/api/webhooks/outlook`,
    provider: 'outlook',
    providerWatchId: 'outlook-sub-security-test',
    status: 'active',
  });
  await saveState(state, { statePath });

  api = await startApiForSecurityTest({
    port,
    statePath,
    env: { SIGNAL_WEBHOOK_ACTOR: 'usr_admin' },
  });

  const response = await fetch(`${api.apiBaseUrl}/api/webhooks/outlook`, {
    body: JSON.stringify({
      value: [
        {
          clientState,
          resource: 'me/messages/msg-001',
          resourceData: { id: 'msg-001' },
        },
      ],
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const payload = await parseJsonResponse(response);
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.action, 'mailboxes.watch-notification');
});

test('Outlook lifecycle webhook validates clientState and queues watch renewal', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-outlook-lifecycle-valid-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const state = await loadState({ statePath });
  const mailboxId = 'mbx_outlook_success';
  const clientState = createProviderWatchSecret('outlook', mailboxId, { local: true });
  state.emailWatchSubscriptions = state.emailWatchSubscriptions ?? [];
  state.emailWatchSubscriptions.push({
    clientStateDigest: digestClientState(clientState),
    expirationAt: new Date(Date.now() + 86_400_000).toISOString(),
    id: 'watch_outlook_lifecycle_test',
    mailboxId,
    notificationUrl: `http://127.0.0.1:${port}/api/webhooks/outlook`,
    provider: 'outlook',
    providerWatchId: 'outlook-sub-lifecycle-test',
    status: 'active',
  });
  await saveState(state, { statePath });

  api = await startApiForSecurityTest({
    port,
    statePath,
    env: { SIGNAL_WEBHOOK_ACTOR: 'usr_admin' },
  });

  const response = await fetch(`${api.apiBaseUrl}/api/webhooks/outlook/lifecycle`, {
    body: JSON.stringify({
      value: [
        {
          clientState,
          lifecycleEvent: 'reauthorizationRequired',
          subscriptionId: 'outlook-sub-lifecycle-test',
        },
      ],
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const payload = await parseJsonResponse(response);
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.action, 'mailboxes.watch-lifecycle');
  assert.deepEqual(payload.details.lifecycleEvents, ['reauthorizationRequired']);

  const updated = await loadState({ statePath });
  const watch = updated.emailWatchSubscriptions.find((candidate) => candidate.id === 'watch_outlook_lifecycle_test');
  assert.equal(watch.status, 'expired');
  assert.equal(watch.providerLastErrorCode, 'OUTLOOK_LIFECYCLE_REAUTHORIZATION_REQUIRED');
  assert.equal(watch.clientStateDigest, digestClientState(clientState));
  assert(!JSON.stringify(watch).includes(clientState), 'raw Outlook clientState must not be stored on lifecycle intake');
  const firstJob = updated.jobs.find((job) => job.type === 'mailbox.watch.renew' && job.targetId === mailboxId && job.status === 'queued');
  assert(firstJob, 'first lifecycle notification should queue watch renewal');
  assert.equal(firstJob.providerIdempotencyKey, 'outlook.lifecycle.outlook-sub-lifecycle-test.reauthorizationRequired');
  assert.equal(watch.lifecycleNotificationCount, 1, 'first lifecycle notification should increment count once');
  assert.equal(payload.details.duplicateCount ?? 0, 0);
  assert(updated.lifecycleNotices.some((notice) => notice.trigger === 'provider_watch_attention' && notice.sourceIds?.watchId === watch.id));

  const replay = await fetch(`${api.apiBaseUrl}/api/webhooks/outlook/lifecycle`, {
    body: JSON.stringify({
      value: [
        {
          clientState,
          lifecycleEvent: 'reauthorizationRequired',
          subscriptionId: 'outlook-sub-lifecycle-test',
        },
      ],
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const replayPayload = await parseJsonResponse(replay);
  assert.equal(replay.status, 200, JSON.stringify(replayPayload));
  assert.equal(replayPayload.action, 'mailboxes.watch-lifecycle');
  assert.equal(replayPayload.details.duplicateCount, 1);
  assert.equal(replayPayload.details.duplicates.length, 1);

  const replayed = await loadState({ statePath });
  const replayedWatch = replayed.emailWatchSubscriptions.find((candidate) => candidate.id === 'watch_outlook_lifecycle_test');
  const replayedJobs = replayed.jobs.filter((job) => job.type === 'mailbox.watch.renew' && job.targetId === mailboxId && job.status === 'queued');
  assert.equal(replayedWatch.lifecycleNotificationCount, 1, 'outlook lifecycle replay should not increment lifecycle notification count');
  assert.equal(replayedJobs.length, 1, 'outlook lifecycle replay should not append duplicate renewal jobs');
});

test('Outlook lifecycle webhook rejects oversized notification batches', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-outlook-lifecycle-batch-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  api = await startApiForSecurityTest({
    port,
    statePath,
    env: { SIGNAL_WEBHOOK_ACTOR: 'usr_admin' },
  });

  const response = await fetch(`${api.apiBaseUrl}/api/webhooks/outlook/lifecycle`, {
    body: JSON.stringify({
      value: Array.from({ length: 51 }, (_, index) => ({
        clientState: `state-${index}`,
        lifecycleEvent: 'missed',
      })),
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const payload = await parseJsonResponse(response);
  assert.equal(response.status, 400, JSON.stringify(payload));
  assert.equal(payload.code, 'OUTLOOK_NOTIFICATION_BATCH_TOO_LARGE');
});

test('Outlook lifecycle webhook dedups missed and subscriptionRemoved replays', async (t) => {
  for (const lifecycleEvent of ['missed', 'subscriptionRemoved']) {
    await t.test(`dedups ${lifecycleEvent} lifecycle replay`, async (subtest) => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `signal-outlook-lifecycle-${lifecycleEvent}-`));
      const statePath = path.join(tempDir, 'signal-state.json');
      const port = await freePort();
      let api = null;

      subtest.after(async () => {
        await stopProcess(api?.child);
        await fs.rm(tempDir, { force: true, recursive: true });
      });

      await bootstrapState({ force: true, statePath });
      const mailboxId = 'mbx_outlook_success';
      const clientState = createProviderWatchSecret('outlook', mailboxId, { local: true });
      const watchId = `watch_outlook_${lifecycleEvent}_replay`;
      const state = await loadState({ statePath });
      state.emailWatchSubscriptions = state.emailWatchSubscriptions ?? [];
      state.emailWatchSubscriptions.push({
        clientStateDigest: digestClientState(clientState),
        expirationAt: new Date(Date.now() + 86_400_000).toISOString(),
        id: watchId,
        mailboxId,
        notificationUrl: `http://127.0.0.1:${port}/api/webhooks/outlook/lifecycle`,
        provider: 'outlook',
        providerWatchId: `outlook-sub-${lifecycleEvent}`,
        status: 'active',
      });
      await saveState(state, { statePath });

      api = await startApiForSecurityTest({
        port,
        statePath,
        env: { SIGNAL_WEBHOOK_ACTOR: 'usr_admin' },
      });

      const body = {
        value: [{
          clientState,
          lifecycleEvent,
          subscriptionId: `outlook-sub-${lifecycleEvent}`,
        }],
      };
      const expectedJobType = lifecycleEvent === 'missed' ? 'outlook.watch.notification' : 'mailbox.watch.renew';
      const postLifecycle = () => fetch(`${api.apiBaseUrl}/api/webhooks/outlook/lifecycle`, {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });

      const first = await postLifecycle();
      const firstPayload = await parseJsonResponse(first);
      assert.equal(first.status, 200, JSON.stringify(firstPayload));
      assert.equal(firstPayload.details.duplicateCount ?? 0, 0);

      const replay = await postLifecycle();
      const replayPayload = await parseJsonResponse(replay);
      assert.equal(replay.status, 200, JSON.stringify(replayPayload));
      assert.equal(replayPayload.details.duplicateCount, 1);

      const updated = await loadState({ statePath });
      const watch = updated.emailWatchSubscriptions.find((candidate) => candidate.id === watchId);
      const jobs = updated.jobs.filter((job) => job.type === expectedJobType && job.targetId === mailboxId);
      assert.equal(watch.lifecycleNotificationCount, 1);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].providerIdempotencyKey, `outlook.lifecycle.outlook-sub-${lifecycleEvent}.${lifecycleEvent}`);
    });
  }
});

test('POST /api/invites/claim returns 429 after repeated attempts for the same email', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-invite-claim-email-rate-limit-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  api = await startApiForSecurityTest({
    port,
    statePath,
    env: {
      SIGNAL_INVITE_CLAIM_RATE_LIMIT: '2',
      SIGNAL_INVITE_CLAIM_RATE_WINDOW_MS: '60000',
    },
  });

  const requestClaim = (claimCode) => fetch(`${api.apiBaseUrl}/api/invites/claim`, {
    body: JSON.stringify({
      claimCode,
      email: 'rate-limit-email@acme.example',
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });

  const first = await requestClaim('invalid-claim-code-1');
  const second = await requestClaim('invalid-claim-code-2');
  const third = await requestClaim('invalid-claim-code-3');
  const thirdPayload = await parseJsonResponse(third);

  assert.equal(first.status, 404);
  assert.equal(second.status, 404);
  assert.equal(third.status, 429);
  assert.equal(thirdPayload.code, 'INVITE_CLAIM_RATE_LIMITED');
});

test('POST /api/invites/claim returns 429 after repeated attempts from the same IP', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-invite-claim-rate-limit-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  api = await startApiForSecurityTest({
    port,
    statePath,
    env: {
      SIGNAL_INVITE_CLAIM_RATE_LIMIT: '2',
      SIGNAL_INVITE_CLAIM_RATE_WINDOW_MS: '60000',
    },
  });

  const requestClaim = (email) => fetch(`${api.apiBaseUrl}/api/invites/claim`, {
    body: JSON.stringify({
      claimCode: 'invalid-claim-code',
      email,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });

  const first = await requestClaim('rate-limit-1@acme.example');
  const second = await requestClaim('rate-limit-2@acme.example');
  const third = await requestClaim('rate-limit-3@acme.example');
  const thirdPayload = await parseJsonResponse(third);

  assert.equal(first.status, 404);
  assert.equal(second.status, 404);
  assert.equal(third.status, 429);
  assert.equal(thirdPayload.code, 'INVITE_CLAIM_RATE_LIMITED');
});

test('API status requires authenticated admin access', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-api-status-auth-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  const env = { SIGNAL_REQUIRE_SIGNED_SESSION: 'true', SIGNAL_SESSION_SECRET: 'status-auth-secret-32chars-value!' };
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const issued = await issueSessionToken('usr_admin', { actorUserId: 'usr_admin', env, statePath });
  api = await startApiForSecurityTest({ port, statePath, env });

  const anonymous = await fetch(`${api.apiBaseUrl}/api/status`);
  const anonymousPayload = await parseJsonResponse(anonymous);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymousPayload.code, 'SESSION_TOKEN_REQUIRED');

  const authorized = await signedSessionGet(api.apiBaseUrl, issued.details.token, '/api/status');
  assert.equal(authorized.status, 200);
  assert.equal(authorized.payload.ok, true);
  assert(authorized.payload.summary);
  assert(authorized.payload.doctor);
});

test('Public email unsubscribe rejects predictable user identifiers', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-api-unsubscribe-auth-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  api = await startApiForSecurityTest({
    port,
    statePath,
    env: { SIGNAL_WEBHOOK_ACTOR: 'usr_admin' },
  });

  const byUserId = await fetch(`${api.apiBaseUrl}/api/email/unsubscribe/usr_sales`);
  const byUserIdPayload = await parseJsonResponse(byUserId);
  assert.equal(byUserId.status, 404);
  assert.equal(byUserIdPayload.code, 'NOT_FOUND');

  const byPredictableCode = await fetch(`${api.apiBaseUrl}/api/email/unsubscribe/unsub_usr_sales`);
  const byPredictableCodePayload = await parseJsonResponse(byPredictableCode);
  assert.equal(byPredictableCode.status, 404);
  assert.equal(byPredictableCodePayload.code, 'NOT_FOUND');
});

test('Public email unsubscribe accepts only the stored unsubscribe token', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-api-unsubscribe-token-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const state = await loadState({ statePath });
  const preference = state.notificationPreferences.find((candidate) => candidate.userId === 'usr_sales');
  assert(preference?.unsubscribeCode);
  assert(!preference.unsubscribeCode.startsWith('unsub_usr_'));

  api = await startApiForSecurityTest({
    port,
    statePath,
    env: { SIGNAL_WEBHOOK_ACTOR: 'usr_admin' },
  });

  const response = await fetch(`${api.apiBaseUrl}/api/email/unsubscribe/${encodeURIComponent(preference.unsubscribeCode)}`);
  const payload = await parseJsonResponse(response);
  assert.equal(response.status, 200);
  assert.equal(payload.action, 'notifications.unsubscribe');
  assert.equal(payload.details.userId, 'usr_sales');
  assert.equal(payload.summary, undefined);
  assert.equal(payload.doctor, undefined);
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
