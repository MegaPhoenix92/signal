import crypto from 'node:crypto';

export const SIGNAL_SESSION_TOKEN_VERSION = 1;
export const SIGNAL_SESSION_TOKEN_ALG = 'HS256';

export class SessionTokenError extends Error {
  constructor(message, { code = 'SESSION_TOKEN_ERROR', status = 401, details = {} } = {}) {
    super(message);
    this.name = 'SessionTokenError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function requireString(value, label, code = 'SESSION_TOKEN_ARG_MISSING') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SessionTokenError(`${label} is required.`, {
      code,
      details: { label },
    });
  }
  return value;
}

function sessionSecret(env = process.env) {
  const value = env.SIGNAL_SESSION_SECRET;
  if (!value) {
    throw new SessionTokenError('SIGNAL_SESSION_SECRET is required for signed session tokens.', {
      code: 'SESSION_SECRET_MISSING',
      status: 412,
      details: { requiredEnv: 'SIGNAL_SESSION_SECRET' },
    });
  }
  return value;
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeJson(value, label) {
  try {
    return JSON.parse(Buffer.from(requireString(value, label), 'base64url').toString('utf8'));
  } catch {
    throw new SessionTokenError(`${label} is not valid base64url JSON.`, {
      code: 'SESSION_TOKEN_FORMAT_INVALID',
    });
  }
}

function hmacSha256(value, secret) {
  return crypto.createHmac('sha256', secret).update(value, 'utf8').digest('base64url');
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function sessionTokenDigest(token) {
  return crypto.createHash('sha256').update(requireString(token, 'session token'), 'utf8').digest('hex').slice(0, 24);
}

export function createSessionToken({ user, tenantId, env = process.env, ttlSeconds, nowMs = Date.now() } = {}) {
  if (!user?.id) {
    throw new SessionTokenError('Active user is required to issue a session token.', {
      code: 'SESSION_TOKEN_USER_MISSING',
      details: { userId: user?.id },
    });
  }
  const secret = sessionSecret(env);
  const issuedAt = Math.floor(nowMs / 1000);
  const ttl = Number(ttlSeconds ?? env.SIGNAL_SESSION_TTL_SECONDS ?? 60 * 60);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new SessionTokenError('Session token TTL must be a positive number of seconds.', {
      code: 'SESSION_TOKEN_TTL_INVALID',
      details: { ttlSeconds },
    });
  }
  const expiresAt = issuedAt + Math.floor(ttl);
  const header = {
    alg: SIGNAL_SESSION_TOKEN_ALG,
    typ: 'SignalSession',
    v: SIGNAL_SESSION_TOKEN_VERSION,
  };
  const payload = {
    aud: env.SIGNAL_SESSION_AUDIENCE ?? 'signal-local-api',
    email: user.email,
    exp: expiresAt,
    iat: issuedAt,
    iss: env.SIGNAL_SESSION_ISSUER ?? 'signal-local',
    jti: crypto.randomBytes(12).toString('hex'),
    local: true,
    role: user.role,
    sub: user.id,
    tenantId: tenantId ?? user.tenantId,
  };
  const unsigned = `${encodeJson(header)}.${encodeJson(payload)}`;
  const token = `${unsigned}.${hmacSha256(unsigned, secret)}`;
  return {
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    issuedAt: new Date(issuedAt * 1000).toISOString(),
    payload,
    token,
    tokenDigest: sessionTokenDigest(token),
  };
}

export function verifySessionToken(token, { env = process.env, nowMs = Date.now() } = {}) {
  const value = requireString(token, 'session token');
  const parts = value.split('.');
  if (parts.length !== 3) {
    throw new SessionTokenError('Session token must have three signed parts.', {
      code: 'SESSION_TOKEN_FORMAT_INVALID',
    });
  }
  const [headerPart, payloadPart, signature] = parts;
  const header = decodeJson(headerPart, 'session token header');
  const payload = decodeJson(payloadPart, 'session token payload');
  if (header.alg !== SIGNAL_SESSION_TOKEN_ALG || header.typ !== 'SignalSession' || header.v !== SIGNAL_SESSION_TOKEN_VERSION) {
    throw new SessionTokenError('Session token header is not supported.', {
      code: 'SESSION_TOKEN_HEADER_INVALID',
      details: { alg: header.alg, typ: header.typ, v: header.v },
    });
  }
  const expected = hmacSha256(`${headerPart}.${payloadPart}`, sessionSecret(env));
  if (!timingSafeEqual(signature, expected)) {
    throw new SessionTokenError('Session token signature verification failed.', {
      code: 'SESSION_TOKEN_SIGNATURE_INVALID',
    });
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= nowSeconds) {
    throw new SessionTokenError('Session token has expired.', {
      code: 'SESSION_TOKEN_EXPIRED',
      details: { exp: payload.exp, now: nowSeconds },
    });
  }
  const expectedIssuer = env.SIGNAL_SESSION_ISSUER ?? 'signal-local';
  const expectedAudience = env.SIGNAL_SESSION_AUDIENCE ?? 'signal-local-api';
  if (payload.iss !== expectedIssuer || payload.aud !== expectedAudience) {
    throw new SessionTokenError('Session token issuer or audience is invalid.', {
      code: 'SESSION_TOKEN_CLAIMS_INVALID',
      details: { aud: payload.aud, expectedAudience, expectedIssuer, iss: payload.iss },
    });
  }
  return {
    payload,
    tokenDigest: sessionTokenDigest(value),
    verifiedAt: new Date(nowMs).toISOString(),
  };
}
