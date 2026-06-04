import crypto from 'node:crypto';

export class OAuthProviderError extends Error {
  constructor(message, { code = 'OAUTH_PROVIDER_ERROR', status = 400, details = {} } = {}) {
    super(message);
    this.name = 'OAuthProviderError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const gmailScopes = {
  selected_label_snippets: 'https://www.googleapis.com/auth/gmail.readonly',
  thread_metadata: 'https://www.googleapis.com/auth/gmail.readonly',
};

const outlookScopes = {
  selected_label_snippets: 'Mail.Read',
  thread_metadata: 'Mail.Read',
};

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlJson(value) {
  return base64UrlEncode(JSON.stringify(value));
}

function hmacSha256(value, signingValue) {
  return crypto.createHmac('sha256', value).update(signingValue, 'utf8').digest('base64url');
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signingKey(env = process.env) {
  return env.SIGNAL_OAUTH_STATE_KEY ?? 'signal-local-oauth-state-key';
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OAuthProviderError(`${label} is required.`, {
      code: 'OAUTH_ARG_MISSING',
      details: { label },
    });
  }
  return value;
}

export function oauthStateDigest(oauthState) {
  return crypto.createHash('sha256').update(oauthState, 'utf8').digest('hex').slice(0, 24);
}

export function signOAuthState(payload, { env = process.env } = {}) {
  const body = base64UrlJson(payload);
  const signature = hmacSha256(signingKey(env), body);
  return `${body}.${signature}`;
}

export function verifyOAuthState(oauthState, { env = process.env, nowMs = Date.now() } = {}) {
  const value = requireString(oauthState, 'OAuth state');
  const [body, signature] = value.split('.');
  if (!body || !signature) {
    throw new OAuthProviderError('OAuth state is malformed.', {
      code: 'OAUTH_STATE_MALFORMED',
    });
  }

  const expectedSignature = hmacSha256(signingKey(env), body);
  if (!timingSafeEqualText(signature, expectedSignature)) {
    throw new OAuthProviderError('OAuth state signature verification failed.', {
      code: 'OAUTH_STATE_SIGNATURE_INVALID',
      status: 401,
    });
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new OAuthProviderError('OAuth state payload is not valid JSON.', {
      code: 'OAUTH_STATE_PAYLOAD_INVALID',
    });
  }

  if (!payload.expiresAt || Date.parse(payload.expiresAt) < nowMs) {
    throw new OAuthProviderError('OAuth state has expired.', {
      code: 'OAUTH_STATE_EXPIRED',
      status: 410,
      details: { expiresAt: payload.expiresAt ?? null },
    });
  }

  return payload;
}

export function providerRedirectUri(provider, { env = process.env, apiBaseUrl = env.SIGNAL_API_BASE_URL ?? 'http://127.0.0.1:8787' } = {}) {
  const configured = provider === 'gmail'
    ? env.SIGNAL_GMAIL_REDIRECT_URI
    : env.SIGNAL_OUTLOOK_REDIRECT_URI;
  return configured ?? `${apiBaseUrl}/api/oauth/${provider}/callback`;
}

function providerClientId(provider, env = process.env) {
  return provider === 'gmail'
    ? env.SIGNAL_GMAIL_CLIENT_ID
    : env.SIGNAL_OUTLOOK_CLIENT_ID;
}

function providerClientSecret(provider, env = process.env) {
  return provider === 'gmail'
    ? env.SIGNAL_GMAIL_CLIENT_SECRET
    : env.SIGNAL_OUTLOOK_CLIENT_SECRET;
}

export function providerScopes(provider, selectedScopes = []) {
  const aliases = selectedScopes.length ? selectedScopes : ['thread_metadata', 'selected_label_snippets'];
  const mappedScopes = aliases.flatMap((scope) => {
    if (provider === 'gmail') {
      return gmailScopes[scope] ? [gmailScopes[scope]] : [];
    }
    return outlookScopes[scope] ? [outlookScopes[scope]] : [];
  });
  const baseScopes = provider === 'gmail'
    ? ['openid', 'email', 'profile']
    : ['openid', 'email', 'profile', 'offline_access', 'User.Read'];
  return [...new Set([...baseScopes, ...mappedScopes])];
}

export function providerAuthEndpoint(provider, env = process.env) {
  if (provider === 'gmail') {
    return 'https://accounts.google.com/o/oauth2/v2/auth';
  }
  const tenant = env.SIGNAL_OUTLOOK_TENANT_ID ?? 'common';
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`;
}

export function providerTokenEndpoint(provider, env = process.env) {
  if (provider === 'gmail') {
    return 'https://oauth2.googleapis.com/token';
  }
  const tenant = env.SIGNAL_OUTLOOK_TENANT_ID ?? 'common';
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

export function isOAuthTokenExchangeConfigured(provider, env = process.env) {
  return Boolean(
    providerClientId(provider, env)
      && providerClientSecret(provider, env)
      && providerRedirectUri(provider, { env }),
  );
}

function parseJsonResponse(body, provider) {
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new OAuthProviderError('OAuth token endpoint returned non-JSON response.', {
      code: 'OAUTH_TOKEN_RESPONSE_INVALID',
      status: 502,
      details: { provider },
    });
  }
}

export async function exchangeOAuthCodeForTokens({
  provider,
  code,
  env = process.env,
  fetchImpl = globalThis.fetch,
  redirectUri,
} = {}) {
  const sourceProvider = requireString(provider, 'OAuth provider');
  const authorizationCode = requireString(code, 'OAuth authorization code');
  const callbackUri = redirectUri ?? providerRedirectUri(sourceProvider, { env });
  const clientId = providerClientId(sourceProvider, env);
  const clientSecret = providerClientSecret(sourceProvider, env);
  if (!clientId || !clientSecret) {
    throw new OAuthProviderError('OAuth token exchange is not configured for this provider.', {
      code: 'OAUTH_TOKEN_EXCHANGE_NOT_CONFIGURED',
      status: 412,
      details: {
        provider: sourceProvider,
        requiredEnv: sourceProvider === 'gmail'
          ? ['SIGNAL_GMAIL_CLIENT_ID', 'SIGNAL_GMAIL_CLIENT_SECRET', 'SIGNAL_GMAIL_REDIRECT_URI']
          : ['SIGNAL_OUTLOOK_CLIENT_ID', 'SIGNAL_OUTLOOK_CLIENT_SECRET', 'SIGNAL_OUTLOOK_TENANT_ID', 'SIGNAL_OUTLOOK_REDIRECT_URI'],
      },
    });
  }
  if (typeof fetchImpl !== 'function') {
    throw new OAuthProviderError('A fetch implementation is required for OAuth token exchange.', {
      code: 'OAUTH_FETCH_MISSING',
      status: 500,
      details: { provider: sourceProvider },
    });
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: authorizationCode,
    grant_type: 'authorization_code',
    redirect_uri: callbackUri,
  });
  const response = await fetchImpl(providerTokenEndpoint(sourceProvider, env), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const text = await response.text();
  const parsed = parseJsonResponse(text, sourceProvider);

  if (!response.ok) {
    throw new OAuthProviderError('OAuth token exchange failed.', {
      code: 'OAUTH_TOKEN_EXCHANGE_FAILED',
      status: 502,
      details: {
        provider: sourceProvider,
        responseStatus: response.status,
        providerError: parsed.error ?? null,
        providerErrorDescription: parsed.error_description ?? null,
      },
    });
  }

  return {
    exchangedAt: new Date().toISOString(),
    provider: sourceProvider,
    response: parsed,
  };
}

export async function refreshOAuthTokens({
  provider,
  refreshToken,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const sourceProvider = requireString(provider, 'OAuth provider');
  const token = requireString(refreshToken, 'OAuth refresh token');
  const clientId = providerClientId(sourceProvider, env);
  const clientSecret = providerClientSecret(sourceProvider, env);
  if (!clientId || !clientSecret) {
    throw new OAuthProviderError('OAuth token refresh is not configured for this provider.', {
      code: 'OAUTH_TOKEN_REFRESH_NOT_CONFIGURED',
      status: 412,
      details: {
        provider: sourceProvider,
        requiredEnv: sourceProvider === 'gmail'
          ? ['SIGNAL_GMAIL_CLIENT_ID', 'SIGNAL_GMAIL_CLIENT_SECRET']
          : ['SIGNAL_OUTLOOK_CLIENT_ID', 'SIGNAL_OUTLOOK_CLIENT_SECRET', 'SIGNAL_OUTLOOK_TENANT_ID'],
      },
    });
  }
  if (typeof fetchImpl !== 'function') {
    throw new OAuthProviderError('A fetch implementation is required for OAuth token refresh.', {
      code: 'OAUTH_FETCH_MISSING',
      status: 500,
      details: { provider: sourceProvider },
    });
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: token,
  });
  const response = await fetchImpl(providerTokenEndpoint(sourceProvider, env), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const text = await response.text();
  const parsed = parseJsonResponse(text, sourceProvider);

  if (!response.ok) {
    throw new OAuthProviderError('OAuth token refresh failed.', {
      code: 'OAUTH_TOKEN_REFRESH_FAILED',
      status: 502,
      details: {
        provider: sourceProvider,
        responseStatus: response.status,
        providerError: parsed.error ?? null,
        providerErrorDescription: parsed.error_description ?? null,
      },
    });
  }

  return {
    provider: sourceProvider,
    refreshedAt: new Date().toISOString(),
    response: parsed,
  };
}

export function createOAuthStatePayload({ sessionId, tenantId, provider, ownerUserId, mailboxId, expiresAt }) {
  return {
    expiresAt,
    mailboxId: mailboxId ?? null,
    nonce: crypto.randomBytes(12).toString('base64url'),
    ownerUserId,
    provider,
    sessionId,
    tenantId,
  };
}

export function providerAuthorizationUrl({ provider, oauthState, selectedScopes, env = process.env } = {}) {
  const sourceProvider = requireString(provider, 'OAuth provider');
  const state = requireString(oauthState, 'OAuth state');
  const scopes = providerScopes(sourceProvider, selectedScopes);
  const url = new URL(providerAuthEndpoint(sourceProvider, env));
  url.searchParams.set('client_id', providerClientId(sourceProvider, env) ?? `signal-local-${sourceProvider}-client`);
  url.searchParams.set('redirect_uri', providerRedirectUri(sourceProvider, { env }));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  if (sourceProvider === 'gmail') {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
  } else {
    url.searchParams.set('response_mode', 'query');
  }
  return url.toString();
}

export function localOAuthCallbackUrl({ provider, oauthState, code = 'local_oauth_code', env = process.env } = {}) {
  const url = new URL(providerRedirectUri(provider, { env }));
  url.searchParams.set('code', code);
  url.searchParams.set('state', requireString(oauthState, 'OAuth state'));
  return url.toString();
}
