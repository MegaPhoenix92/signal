import crypto from 'node:crypto';
import {
  SignalStateError,
  getActor,
  validateApiSession,
} from './signal-state.mjs';
import { verifySessionToken } from './signal-session-token.mjs';

export const SIGNAL_SESSION_COOKIE_NAME = 'signal_session';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function headerValue(req, name) {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value.find((item) => nonEmptyString(item)) ?? null;
  }
  return nonEmptyString(value);
}

export function parseCookieHeader(cookieHeader) {
  const cookies = new Map();
  for (const part of (cookieHeader ?? '').split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }
    const name = part.slice(0, separatorIndex).trim();
    const rawValue = part.slice(separatorIndex + 1).trim();
    if (!name) {
      continue;
    }
    try {
      cookies.set(name, decodeURIComponent(rawValue));
    } catch {
      cookies.set(name, rawValue);
    }
  }
  return cookies;
}

export function authorizationSessionToken(req) {
  const authorization = headerValue(req, 'authorization') ?? '';
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return nonEmptyString(authorization.slice(7));
  }
  return headerValue(req, 'x-signal-session');
}

export function requestSessionToken(req, body = {}) {
  return nonEmptyString(body.sessionToken)
    ?? authorizationSessionToken(req)
    ?? nonEmptyString(parseCookieHeader(headerValue(req, 'cookie')).get(SIGNAL_SESSION_COOKIE_NAME));
}

export function signedSessionRequired(env = process.env) {
  return env.SIGNAL_REQUIRE_SIGNED_SESSION === 'true';
}

export function localActorAllowed(env = process.env) {
  return env.SIGNAL_ALLOW_LOCAL_ACTOR === 'true';
}

export function productionModeEnabled(env = process.env) {
  return env.NODE_ENV === 'production'
    || env.SIGNAL_BACKEND_MODE === 'production-node'
    || env.SIGNAL_BACKEND_MODE === 'external-service'
    || env.SIGNAL_RUNTIME_ENV === 'production';
}

export function isLoopbackApiHost(host = process.env.SIGNAL_API_HOST ?? '127.0.0.1') {
  const normalized = String(host).trim().toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '[::1]';
}

function oauthProviderConfigured(env = process.env) {
  return Boolean(env.SIGNAL_GMAIL_CLIENT_ID || env.SIGNAL_OUTLOOK_CLIENT_ID);
}

function configuredCorsOrigins(env = process.env) {
  return String(env.SIGNAL_API_CORS_ORIGINS ?? env.SIGNAL_API_CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function gmailWebhookConfigured(env = process.env) {
  return Boolean(env.SIGNAL_GMAIL_CLIENT_ID || env.SIGNAL_GMAIL_NOTIFICATION_URL);
}

function productionAuthProvider(env = process.env) {
  return env.SIGNAL_AUTH_PROVIDER === 'jwks' ? 'jwks' : null;
}

function isHttpStatePath(statePath) {
  return /^https?:\/\//i.test(String(statePath ?? '').trim());
}

function stateTargetForEnv(env = process.env) {
  return env.SIGNAL_ADMIN_STATE
    ?? (env.SIGNAL_BACKEND_MODE === 'external-service' ? env.SIGNAL_STATE_SERVICE_URL : null);
}

export function assertApiSecurityConfig(env = process.env) {
  const host = env.SIGNAL_API_HOST ?? '127.0.0.1';
  const authEnforced = signedSessionRequired(env) || productionAuthProvider(env) === 'jwks';
  const loopback = isLoopbackApiHost(host);

  if (localActorAllowed(env) && productionModeEnabled(env)) {
    throw new Error('SIGNAL_ALLOW_LOCAL_ACTOR=true is not allowed in production mode.');
  }

  if (!loopback && !authEnforced) {
    throw new Error(
      'SIGNAL_API_HOST is not loopback but signed-session/JWKS auth is not enabled. '
      + 'Set SIGNAL_REQUIRE_SIGNED_SESSION=true with SIGNAL_SESSION_SECRET, or SIGNAL_AUTH_PROVIDER=jwks with SIGNAL_AUTH_JWKS_URL.',
    );
  }

  if (!loopback && localActorAllowed(env)) {
    throw new Error('SIGNAL_ALLOW_LOCAL_ACTOR=true is not allowed on non-loopback hosts.');
  }

  if (!loopback && !env.SIGNAL_WEBHOOK_ACTOR) {
    throw new Error('Non-loopback hosts require SIGNAL_WEBHOOK_ACTOR for webhook mutations.');
  }

  if (!loopback && !env.SIGNAL_OAUTH_ACTOR) {
    throw new Error('Non-loopback hosts require SIGNAL_OAUTH_ACTOR for OAuth callback mutations.');
  }

  if (!loopback && signedSessionRequired(env) && !sessionCookieSecure(env)) {
    throw new Error(
      'Non-loopback signed-session mode requires SIGNAL_COOKIE_SECURE=true or an HTTPS SIGNAL_APP_BASE_URL.',
    );
  }

  if (!loopback && !isHttpStatePath(stateTargetForEnv(env))) {
    throw new Error(
      'Non-loopback hosts must use an HTTP state-service URL (SIGNAL_STATE_SERVICE_URL), not local file-backed state.',
    );
  }

  if (productionAuthProvider(env) === 'jwks' && !env.SIGNAL_AUTH_JWKS_URL) {
    throw new Error('SIGNAL_AUTH_PROVIDER=jwks requires SIGNAL_AUTH_JWKS_URL.');
  }

  if (signedSessionRequired(env) && !env.SIGNAL_SESSION_SECRET) {
    throw new Error('SIGNAL_REQUIRE_SIGNED_SESSION=true requires SIGNAL_SESSION_SECRET.');
  }

  if (oauthProviderConfigured(env) && !env.SIGNAL_OAUTH_STATE_KEY) {
    throw new Error('OAuth provider client IDs are configured but SIGNAL_OAUTH_STATE_KEY is missing.');
  }

  if (!loopback) {
    const corsOrigins = configuredCorsOrigins(env);
    if (corsOrigins.includes('*')) {
      throw new Error(
        'SIGNAL_API_CORS_ORIGINS cannot include * on non-loopback hosts when credentialed CORS is enabled.',
      );
    }
    if (corsOrigins.length === 0) {
      throw new Error('Non-loopback hosts require explicit SIGNAL_API_CORS_ORIGINS.');
    }
  }

  if (!loopback && gmailWebhookConfigured(env) && !env.SIGNAL_GMAIL_WEBHOOK_AUDIENCE) {
    throw new Error('Non-loopback Gmail webhook intake requires SIGNAL_GMAIL_WEBHOOK_AUDIENCE.');
  }
}

function decodeJsonPart(value, label) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new SignalStateError(`${label} is not valid base64url JSON.`, {
      code: 'AUTH_TOKEN_FORMAT_INVALID',
      status: 401,
    });
  }
}

function claimAtPath(payload, path) {
  return String(path ?? '')
    .split('.')
    .filter(Boolean)
    .reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), payload);
}

function normalizeClaimList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function selectedRoleClaim(payload, env = process.env) {
  const configured = claimAtPath(payload, env.SIGNAL_AUTH_ROLE_CLAIM ?? 'role');
  const candidates = normalizeClaimList(configured).length ? normalizeClaimList(configured) : normalizeClaimList(payload.roles);
  if (candidates.includes('admin')) {
    return 'admin';
  }
  if (candidates.includes('member')) {
    return 'member';
  }
  return typeof configured === 'string' && configured.trim() ? configured.trim() : null;
}

function claimString(payload, env, envKey, fallbackPath) {
  const value = claimAtPath(payload, env[envKey] ?? fallbackPath);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function expectedClaimValues(envValue) {
  return String(envValue ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function assertExpectedClaim(payload, claimName, expectedValues, code) {
  if (expectedValues.length === 0) {
    return;
  }
  const actual = payload[claimName];
  const actualValues = Array.isArray(actual) ? actual.map((item) => String(item)) : [String(actual ?? '')];
  if (!actualValues.some((value) => expectedValues.includes(value))) {
    throw new SignalStateError('Verified auth token claims are not accepted by this API.', {
      code,
      status: 401,
      details: { claim: claimName, expected: expectedValues, received: actualValues.filter(Boolean) },
    });
  }
}

const jwksCache = new Map();

async function fetchJwks(url, { fetchImpl = fetch, env = process.env } = {}) {
  const cacheSeconds = Number(env.SIGNAL_AUTH_JWKS_CACHE_SECONDS ?? 300);
  const cached = jwksCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.jwks;
  }
  const response = await fetchImpl(url, {
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(Number(env.SIGNAL_AUTH_JWKS_TIMEOUT_MS ?? 5000)) : undefined,
  });
  if (!response.ok) {
    throw new SignalStateError(`JWKS endpoint returned ${response.status}.`, {
      code: 'AUTH_JWKS_FETCH_FAILED',
      status: 401,
      details: { statusCode: response.status },
    });
  }
  const jwks = await response.json();
  jwksCache.set(url, {
    expiresAt: Date.now() + Math.max(0, cacheSeconds) * 1000,
    jwks,
  });
  return jwks;
}

async function verifyJwksBearerToken(token, { env = process.env, fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const jwksUrl = env.SIGNAL_AUTH_JWKS_URL;
  if (!jwksUrl) {
    throw new SignalStateError('SIGNAL_AUTH_JWKS_URL is required for JWKS auth.', {
      code: 'AUTH_JWKS_URL_MISSING',
      status: 412,
      details: { requiredEnv: 'SIGNAL_AUTH_JWKS_URL' },
    });
  }
  const parts = String(token).split('.');
  if (parts.length !== 3) {
    throw new SignalStateError('Bearer token must have three JWT parts for JWKS auth.', {
      code: 'AUTH_TOKEN_FORMAT_INVALID',
      status: 401,
    });
  }
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = decodeJsonPart(headerPart, 'auth token header');
  const payload = decodeJsonPart(payloadPart, 'auth token payload');
  if (header.alg !== 'RS256' || !header.kid) {
    throw new SignalStateError('JWKS auth only accepts RS256 tokens with a key id.', {
      code: 'AUTH_TOKEN_HEADER_INVALID',
      status: 401,
      details: { alg: header.alg ?? null, kid: header.kid ?? null },
    });
  }
  const jwks = await fetchJwks(jwksUrl, { env, fetchImpl });
  const jwk = (jwks.keys ?? []).find((key) => key.kid === header.kid && key.kty === 'RSA');
  if (!jwk) {
    throw new SignalStateError('JWKS key id was not found.', {
      code: 'AUTH_JWKS_KEY_NOT_FOUND',
      status: 401,
      details: { kid: header.kid },
    });
  }
  const publicKey = crypto.createPublicKey({ format: 'jwk', key: jwk });
  const verified = crypto.verify('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`, 'utf8'), publicKey, Buffer.from(signaturePart, 'base64url'));
  if (!verified) {
    throw new SignalStateError('JWKS bearer token signature verification failed.', {
      code: 'AUTH_TOKEN_SIGNATURE_INVALID',
      status: 401,
    });
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= nowSeconds) {
    throw new SignalStateError('JWKS bearer token has expired.', {
      code: 'AUTH_TOKEN_EXPIRED',
      status: 401,
      details: { exp: payload.exp, now: nowSeconds },
    });
  }
  if (payload.nbf !== undefined && Number(payload.nbf) > nowSeconds) {
    throw new SignalStateError('JWKS bearer token is not valid yet.', {
      code: 'AUTH_TOKEN_NOT_BEFORE',
      status: 401,
      details: { nbf: payload.nbf, now: nowSeconds },
    });
  }
  assertExpectedClaim(payload, 'iss', expectedClaimValues(env.SIGNAL_AUTH_ISSUER), 'AUTH_TOKEN_ISSUER_INVALID');
  assertExpectedClaim(payload, 'aud', expectedClaimValues(env.SIGNAL_AUTH_AUDIENCE), 'AUTH_TOKEN_AUDIENCE_INVALID');
  const subject = claimAtPath(payload, env.SIGNAL_AUTH_SUB_CLAIM ?? 'sub');
  if (typeof subject !== 'string' || !subject.trim()) {
    throw new SignalStateError('Verified auth token must include a subject claim.', {
      code: 'AUTH_SUBJECT_CLAIM_MISSING',
      status: 401,
      details: { claim: env.SIGNAL_AUTH_SUB_CLAIM ?? 'sub' },
    });
  }
  return {
    actorUserId: subject.trim(),
    auth: {
      email: claimString(payload, env, 'SIGNAL_AUTH_EMAIL_CLAIM', 'email'),
      jwksKid: header.kid,
      mode: 'jwks',
      role: selectedRoleClaim(payload, env),
      tenantId: claimString(payload, env, 'SIGNAL_AUTH_TENANT_CLAIM', 'tenantId'),
      tokenDigest: crypto.createHash('sha256').update(String(token), 'utf8').digest('hex').slice(0, 24),
      transport: 'header',
      verifiedAt: new Date(nowMs).toISOString(),
    },
  };
}

export async function requestAuth(req, body = {}, { env = process.env, fetchImpl = fetch } = {}) {
  const token = requestSessionToken(req, body);
  if (token) {
    if (productionAuthProvider(env) === 'jwks') {
      return verifyJwksBearerToken(token, { env, fetchImpl });
    }
    const verification = verifySessionToken(token, { env });
    return {
      actorUserId: verification.payload.sub,
      auth: {
        mode: 'signed_session',
        tokenDigest: verification.tokenDigest,
        transport: authorizationSessionToken(req) ? 'header' : 'cookie',
        verifiedAt: verification.verifiedAt,
      },
    };
  }
  if (signedSessionRequired(env) || productionAuthProvider(env)) {
    throw new SignalStateError('A verified bearer token is required for this API operation.', {
      code: 'SESSION_TOKEN_REQUIRED',
      status: 401,
      details: { requiredEnv: productionAuthProvider(env) === 'jwks' ? 'SIGNAL_AUTH_JWKS_URL' : 'SIGNAL_SESSION_SECRET' },
    });
  }
  if (!localActorAllowed(env)) {
    throw new SignalStateError('A verified bearer token is required for this API operation.', {
      code: 'SESSION_TOKEN_REQUIRED',
      status: 401,
      details: {
        requiredEnv: 'SIGNAL_ALLOW_LOCAL_ACTOR,SIGNAL_REQUIRE_SIGNED_SESSION,SIGNAL_AUTH_PROVIDER',
      },
    });
  }
  const actorUserId = body.actorUserId ?? headerValue(req, 'x-signal-actor');
  if (!actorUserId) {
    throw new SignalStateError('A local actor identity is required for this API operation.', {
      code: 'LOCAL_ACTOR_REQUIRED',
      status: 401,
      details: { requiredBody: 'actorUserId', requiredHeader: 'X-Signal-Actor' },
    });
  }
  return {
    actorUserId,
    auth: {
      mode: 'local_actor',
    },
  };
}

export function requireKnownLocalActor(state, requestActor) {
  if (requestActor?.auth?.mode !== 'local_actor') {
    return null;
  }
  const actor = getActor(state, requestActor.actorUserId, { requireExplicit: true });
  requestActor.auth.actorStatus = actor.status;
  requestActor.auth.membershipId = actor.membershipId ?? null;
  requestActor.auth.membershipStatus = actor.membershipStatus ?? null;
  return actor;
}

export function requireAdminRequestAuth(state, requestActor, action) {
  const actor = getActor(state, requestActor.actorUserId);
  if (actor.role !== 'admin') {
    throw new SignalStateError(`Admin role required for ${action}.`, {
      code: 'FORBIDDEN',
      status: 403,
      details: { action, actorUserId: actor.id, actorRole: actor.role, requiredRole: 'admin' },
    });
  }
  return actor;
}

export function requireRegisteredSessionRequestAuth(state, requestActor) {
  if (requestActor.auth.mode !== 'signed_session') {
    if (requestActor.auth.mode === 'jwks') {
      const actor = getActor(state, requestActor.actorUserId);
      if (!requestActor.auth.role) {
        throw new SignalStateError('Verified auth token must include a role claim.', {
          code: 'AUTH_ROLE_CLAIM_MISSING',
          status: 403,
          details: { actorUserId: actor.id },
        });
      }
      if (requestActor.auth.role !== actor.role) {
        throw new SignalStateError('Verified auth token role does not match the active membership role.', {
          code: 'AUTH_CLAIMS_MISMATCH',
          status: 403,
          details: { actorUserId: actor.id, membershipRole: actor.role, tokenRole: requestActor.auth.role },
        });
      }
      if (requestActor.auth.tenantId && requestActor.auth.tenantId !== actor.tenantId) {
        throw new SignalStateError('Verified auth token tenant does not match the active membership tenant.', {
          code: 'AUTH_CLAIMS_MISMATCH',
          status: 403,
          details: { actorTenantId: actor.tenantId, actorUserId: actor.id, tokenTenantId: requestActor.auth.tenantId },
        });
      }
      requestActor.auth.actorStatus = actor.status;
      requestActor.auth.membershipId = actor.membershipId ?? null;
      requestActor.auth.membershipStatus = actor.membershipStatus ?? null;
      return null;
    }
    return null;
  }
  const { actor, session } = validateApiSession(state, {
    payload: { sub: requestActor.actorUserId },
    tokenDigest: requestActor.auth.tokenDigest,
  });
  requestActor.actorUserId = actor.id;
  requestActor.auth = {
    ...requestActor.auth,
    apiSessionId: session.id,
    apiSessionStatus: session.status,
  };
  return session;
}

export function sessionCookieSecure(env = process.env) {
  if (env.SIGNAL_COOKIE_SECURE === 'false') {
    return false;
  }
  if (env.SIGNAL_COOKIE_SECURE === 'true') {
    return true;
  }
  return /^https:\/\//i.test(env.SIGNAL_APP_BASE_URL ?? '');
}

export function resolveWebhookActor(req, { env = process.env } = {}) {
  if (localActorAllowed(env)) {
    return headerValue(req, 'x-signal-actor') ?? env.SIGNAL_WEBHOOK_ACTOR ?? null;
  }
  return env.SIGNAL_WEBHOOK_ACTOR ?? null;
}

export async function resolveOAuthActor(req, { env = process.env, authenticateSession } = {}) {
  if (requestSessionToken(req)) {
    if (!authenticateSession) {
      throw new SignalStateError('OAuth callback session validation is not configured.', {
        code: 'OAUTH_SESSION_AUTH_UNAVAILABLE',
        status: 500,
      });
    }
    const auth = await authenticateSession(req);
    return auth.actorUserId;
  }
  if (localActorAllowed(env)) {
    return headerValue(req, 'x-signal-actor') ?? env.SIGNAL_OAUTH_ACTOR ?? null;
  }
  return env.SIGNAL_OAUTH_ACTOR ?? null;
}

export function requireWebhookActor(actorUserId) {
  if (!actorUserId) {
    throw new SignalStateError('SIGNAL_WEBHOOK_ACTOR is required for webhook mutations.', {
      code: 'WEBHOOK_ACTOR_REQUIRED',
      status: 500,
    });
  }
  return actorUserId;
}

export function requireOAuthActor(actorUserId) {
  if (!actorUserId) {
    throw new SignalStateError('SIGNAL_OAUTH_ACTOR is required for OAuth callback mutations.', {
      code: 'OAUTH_ACTOR_REQUIRED',
      status: 500,
    });
  }
  return actorUserId;
}

export function sessionCookieHeader(token, { expiresAt, issuedAt, env = process.env } = {}) {
  const cookieParts = [
    `${SIGNAL_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
  ];
  if (sessionCookieSecure(env)) {
    cookieParts.push('Secure');
  }
  const expiresMs = Date.parse(expiresAt);
  if (Number.isFinite(expiresMs)) {
    cookieParts.push(`Expires=${new Date(expiresMs).toUTCString()}`);
    const issuedMs = Number.isFinite(Date.parse(issuedAt)) ? Date.parse(issuedAt) : Date.now();
    const maxAgeSeconds = Math.max(0, Math.floor((expiresMs - issuedMs) / 1000));
    cookieParts.push(`Max-Age=${maxAgeSeconds}`);
  }
  return cookieParts.join('; ');
}
