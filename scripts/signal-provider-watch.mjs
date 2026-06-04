import crypto from 'node:crypto';

export class ProviderWatchError extends Error {
  constructor(message, { code = 'PROVIDER_WATCH_ERROR', status = 400, details = {} } = {}) {
    super(message);
    this.name = 'ProviderWatchError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function nowMs() {
  return Date.now();
}

function isoFromNow(milliseconds) {
  return new Date(nowMs() + milliseconds).toISOString();
}

function digest(value, length = 24) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, length);
}

function requireValue(value, label, code = 'PROVIDER_WATCH_ARG_MISSING') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProviderWatchError(`${label} is required.`, {
      code,
      details: { label },
    });
  }
  return value;
}

function responseHeader(response, name) {
  return response?.headers?.get?.(name) ?? response?.headers?.get?.(name.toLowerCase()) ?? null;
}

export function retryAfterToIso(value, { now = nowMs() } = {}) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return new Date(now + seconds * 1000).toISOString();
  }
  const parsedDate = Date.parse(value);
  if (Number.isFinite(parsedDate)) {
    return new Date(parsedDate).toISOString();
  }
  return null;
}

function providerErrorMessage(parsed) {
  if (typeof parsed?.error === 'string') {
    return parsed.error;
  }
  return parsed?.error?.message ?? parsed?.message ?? null;
}

function requestNotificationUrl(request) {
  return request?.notificationUrl ?? request?.body?.notificationUrl ?? null;
}

function requestBodyDigest(request) {
  const body = { ...(request?.body ?? {}) };
  if (body.clientState) {
    body.clientState = '[digest-only]';
  }
  return digest(JSON.stringify(body));
}

function apiBaseUrl(env = process.env) {
  return env.SIGNAL_API_BASE_URL ?? 'http://127.0.0.1:8787';
}

function notificationUrl(provider, env = process.env) {
  const configured = provider === 'gmail'
    ? env.SIGNAL_GMAIL_NOTIFICATION_URL
    : env.SIGNAL_OUTLOOK_NOTIFICATION_URL;
  return configured ?? `${apiBaseUrl(env)}/api/webhooks/${provider}`;
}

function sourceTargets(mailbox = {}) {
  return [...(mailbox.syncPolicy?.labels ?? []), ...(mailbox.syncPolicy?.folders ?? [])].filter(Boolean);
}

export function providerWatchEndpoint(provider) {
  if (provider === 'gmail') {
    return 'https://gmail.googleapis.com/gmail/v1/users/me/watch';
  }
  if (provider === 'outlook') {
    return 'https://graph.microsoft.com/v1.0/subscriptions';
  }
  throw new ProviderWatchError(`Unsupported provider for watch setup: ${provider}`, {
    code: 'PROVIDER_WATCH_UNSUPPORTED',
    details: { provider },
  });
}

export function createProviderWatchSecret(provider, mailboxId) {
  return `signal_${provider}_${mailboxId}_${crypto.randomBytes(18).toString('base64url')}`;
}

export function createGmailWatchRequest({ mailbox, env = process.env } = {}) {
  const topicName = env.SIGNAL_GMAIL_PUBSUB_TOPIC ?? 'projects/signal-local/topics/gmail-watch';
  const labelIds = sourceTargets(mailbox);
  return {
    endpoint: providerWatchEndpoint('gmail'),
    body: {
      topicName,
      ...(labelIds.length ? { labelFilterBehavior: 'include', labelIds } : {}),
    },
    notificationUrl: notificationUrl('gmail', env),
  };
}

export function createOutlookSubscriptionRequest({ mailbox, env = process.env, clientState = createProviderWatchSecret('outlook', mailbox?.id ?? 'mailbox') } = {}) {
  const url = requireValue(notificationUrl('outlook', env), 'SIGNAL_OUTLOOK_NOTIFICATION_URL');
  const expirationDateTime = isoFromNow(2 * 24 * 60 * 60 * 1000);
  return {
    clientState,
    endpoint: providerWatchEndpoint('outlook'),
    body: {
      changeType: 'created,updated',
      clientState,
      expirationDateTime,
      notificationUrl: url,
      resource: env.SIGNAL_OUTLOOK_SUBSCRIPTION_RESOURCE ?? 'me/messages',
      ...(env.SIGNAL_OUTLOOK_LIFECYCLE_NOTIFICATION_URL ? { lifecycleNotificationUrl: env.SIGNAL_OUTLOOK_LIFECYCLE_NOTIFICATION_URL } : {}),
    },
  };
}

export function createProviderWatchRequest({ mailbox, env = process.env, clientState } = {}) {
  if (!mailbox?.provider) {
    throw new ProviderWatchError('Mailbox with provider is required for watch setup.', {
      code: 'PROVIDER_WATCH_MAILBOX_MISSING',
    });
  }
  if (mailbox.provider === 'gmail') {
    return createGmailWatchRequest({ mailbox, env });
  }
  return createOutlookSubscriptionRequest({ mailbox, env, clientState });
}

export function localProviderWatchResponse({ mailbox, request } = {}) {
  if (mailbox?.provider === 'gmail') {
    return {
      expiration: String(nowMs() + 7 * 24 * 60 * 60 * 1000),
      historyId: `${nowMs()}`,
      id: `gmail-watch-${mailbox.id}`,
    };
  }
  return {
    id: `outlook-sub-${mailbox.id}-${digest(JSON.stringify(request.body), 8)}`,
    expirationDateTime: request.body.expirationDateTime,
    resource: request.body.resource,
  };
}

export async function createProviderWatch({ mailbox, env = process.env, fetchImpl = globalThis.fetch, accessToken, live = false, clientState } = {}) {
  const request = createProviderWatchRequest({ mailbox, env, clientState });
  if (!live) {
    return {
      live: false,
      request,
      response: localProviderWatchResponse({ mailbox, request }),
    };
  }
  if (!accessToken) {
    throw new ProviderWatchError('Provider access token is required for live watch setup.', {
      code: 'PROVIDER_WATCH_ACCESS_TOKEN_MISSING',
      status: 412,
      details: {
        endpoint: request.endpoint,
        notificationUrl: requestNotificationUrl(request),
        provider: mailbox?.provider,
        requestDigest: requestBodyDigest(request),
      },
    });
  }
  if (typeof fetchImpl !== 'function') {
    throw new ProviderWatchError('A fetch implementation is required for live watch setup.', {
      code: 'PROVIDER_WATCH_FETCH_MISSING',
      status: 500,
      details: {
        endpoint: request.endpoint,
        notificationUrl: requestNotificationUrl(request),
        provider: mailbox?.provider,
        requestDigest: requestBodyDigest(request),
      },
    });
  }

  const response = await fetchImpl(request.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request.body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderWatchError('Provider watch endpoint returned non-JSON response.', {
      code: 'PROVIDER_WATCH_RESPONSE_INVALID',
      status: 502,
      details: {
        endpoint: request.endpoint,
        notificationUrl: requestNotificationUrl(request),
        provider: mailbox?.provider,
        requestDigest: requestBodyDigest(request),
        responseStatus: response.status,
      },
    });
  }
  if (!response.ok) {
    const retryAfterHeader = responseHeader(response, 'retry-after');
    const retryAfterAt = retryAfterToIso(retryAfterHeader);
    throw new ProviderWatchError('Provider watch setup failed.', {
      code: 'PROVIDER_WATCH_SETUP_FAILED',
      status: 502,
      details: {
        endpoint: request.endpoint,
        notificationUrl: requestNotificationUrl(request),
        provider: mailbox?.provider,
        providerError: providerErrorMessage(parsed),
        providerErrorCode: parsed.error?.code ?? parsed.code ?? null,
        providerErrorStatus: parsed.error?.status ?? parsed.status ?? null,
        rateLimited: response.status === 429,
        requestDigest: requestBodyDigest(request),
        retryAfter: retryAfterHeader,
        retryAfterAt,
        responseStatus: response.status,
      },
    });
  }
  return {
    live: true,
    request,
    response: parsed,
  };
}

export function normalizeProviderWatchResult({ mailbox, result, clientState } = {}) {
  const now = new Date().toISOString();
  if (mailbox.provider === 'gmail') {
    return {
      clientStateDigest: null,
      expirationAt: result.response.expiration ? new Date(Number(result.response.expiration)).toISOString() : isoFromNow(7 * 24 * 60 * 60 * 1000),
      historyId: result.response.historyId ?? null,
      notificationUrl: result.request.notificationUrl,
      providerWatchId: result.response.id ?? `gmail-watch-${mailbox.id}`,
      resource: result.request.body.topicName,
      setupMode: result.live ? 'live' : 'local',
      setupRequestDigest: digest(JSON.stringify(result.request.body)),
      setupAt: now,
      status: 'active',
      topicName: result.request.body.topicName,
    };
  }

  return {
    clientStateDigest: clientState ? digest(clientState) : null,
    expirationAt: result.response.expirationDateTime ?? result.request.body.expirationDateTime,
    historyId: null,
    notificationUrl: result.request.body.notificationUrl,
    providerWatchId: result.response.id ?? `outlook-sub-${mailbox.id}`,
    resource: result.response.resource ?? result.request.body.resource,
    setupMode: result.live ? 'live' : 'local',
    setupRequestDigest: digest(JSON.stringify({ ...result.request.body, clientState: clientState ? '[digest-only]' : null })),
    setupAt: now,
    status: 'active',
    topicName: null,
  };
}

export function parseGmailPubSubNotification(body = {}) {
  const encoded = body.message?.data;
  if (!encoded) {
    throw new ProviderWatchError('Gmail Pub/Sub notification is missing message.data.', {
      code: 'GMAIL_NOTIFICATION_DATA_MISSING',
    });
  }
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    throw new ProviderWatchError('Gmail Pub/Sub notification data is invalid.', {
      code: 'GMAIL_NOTIFICATION_DATA_INVALID',
    });
  }
}

export function parseOutlookChangeNotification(body = {}) {
  const notifications = Array.isArray(body.value) ? body.value : [];
  if (notifications.length === 0) {
    throw new ProviderWatchError('Outlook notification payload is missing value entries.', {
      code: 'OUTLOOK_NOTIFICATION_EMPTY',
    });
  }
  return notifications;
}

export function digestClientState(value) {
  return digest(value);
}
