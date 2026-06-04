import crypto from 'node:crypto';

export class ProviderSyncError extends Error {
  constructor(message, { code = 'PROVIDER_SYNC_ERROR', status = 400, details = {} } = {}) {
    super(message);
    this.name = 'ProviderSyncError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const gmailBaseUrl = 'https://gmail.googleapis.com/gmail/v1/users/me';
const graphBaseUrl = 'https://graph.microsoft.com/v1.0';

function digest(value, length = 24) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, length);
}

function nowIso() {
  return new Date().toISOString();
}

function responseHeader(response, name) {
  return response?.headers?.get?.(name) ?? response?.headers?.get?.(name.toLowerCase()) ?? null;
}

function retryAfterToIso(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }
  const parsedDate = Date.parse(value);
  return Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : null;
}

function sourceTargets(mailbox = {}) {
  return [...(mailbox.syncPolicy?.labels ?? []), ...(mailbox.syncPolicy?.folders ?? [])].filter(Boolean);
}

function retentionExpiresAt(mailbox = {}) {
  const days = Number(mailbox.syncPolicy?.rawRetentionDays ?? 7);
  return new Date(Date.now() + Math.max(1, days) * 24 * 60 * 60 * 1000).toISOString();
}

function windowStartQueryDate(cursor = {}) {
  const value = cursor.windowStartAt && Number.isFinite(Date.parse(cursor.windowStartAt))
    ? new Date(cursor.windowStartAt)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const yyyy = value.getUTCFullYear();
  const mm = String(value.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(value.getUTCDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

function appendQuery(endpoint, query = {}) {
  const url = new URL(endpoint);
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => url.searchParams.append(key, entry));
      return;
    }
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function requestDigest(request) {
  return digest(JSON.stringify({
    endpoint: request.endpoint,
    method: request.method,
    mode: request.mode,
    provider: request.provider,
    query: request.query,
  }));
}

function responseDigest(response) {
  return digest(JSON.stringify(response ?? {}));
}

function gmailHistoryId(cursor = {}) {
  const values = [cursor.cursor, cursor.providerDeltaLink].filter(Boolean).map(String);
  for (const value of values) {
    const match = value.match(/(?:history|notification)-(\d+)/);
    if (match) {
      return match[1];
    }
    if (/^\d+$/.test(value)) {
      return value;
    }
  }
  return null;
}

function outlookFolderId(mailbox = {}, env = process.env) {
  return env.SIGNAL_OUTLOOK_SYNC_FOLDER_ID
    ?? mailbox.syncPolicy?.folders?.[0]
    ?? 'Inbox';
}

function createGmailSyncRequest({ cursor, env = process.env, mailbox, mode }) {
  const targets = sourceTargets(mailbox);
  const maxResults = env.SIGNAL_PROVIDER_SYNC_MAX_RESULTS ?? env.SIGNAL_GMAIL_SYNC_MAX_RESULTS ?? '25';
  if (mode === 'replay') {
    return {
      endpoint: `${gmailBaseUrl}/messages`,
      method: 'GET',
      mode,
      provider: 'gmail',
      query: {
        includeSpamTrash: 'false',
        labelIds: targets,
        maxResults,
        q: `after:${windowStartQueryDate(cursor)}`,
      },
    };
  }

  return {
    endpoint: `${gmailBaseUrl}/history`,
    method: 'GET',
    mode,
    provider: 'gmail',
    query: {
      historyTypes: 'messageAdded',
      labelId: targets[0],
      maxResults,
      startHistoryId: gmailHistoryId(cursor) ?? env.SIGNAL_GMAIL_INITIAL_HISTORY_ID ?? '1',
    },
  };
}

function createOutlookSyncRequest({ cursor, env = process.env, mailbox, mode }) {
  const maxResults = env.SIGNAL_PROVIDER_SYNC_MAX_RESULTS ?? env.SIGNAL_OUTLOOK_SYNC_MAX_RESULTS ?? '25';
  const previousDeltaLink = mode === 'delta' && (
    cursor.providerDeltaLink
    || (String(cursor.cursor ?? '').startsWith('https://graph.microsoft.com') ? cursor.cursor : null)
  );
  if (previousDeltaLink) {
    return {
      endpoint: previousDeltaLink,
      method: 'GET',
      mode,
      provider: 'outlook',
      query: {},
      usesStoredDeltaLink: true,
    };
  }

  const folder = encodeURIComponent(outlookFolderId(mailbox, env));
  return {
    endpoint: `${graphBaseUrl}/me/mailFolders/${folder}/messages/delta`,
    method: 'GET',
    mode,
    provider: 'outlook',
    query: {
      $select: 'id,conversationId,internetMessageId,from,subject,bodyPreview,receivedDateTime,categories',
      $top: maxResults,
    },
  };
}

export function createProviderSyncRequest({ cursor = {}, env = process.env, mailbox, mode = 'delta' } = {}) {
  if (!mailbox?.provider) {
    throw new ProviderSyncError('Mailbox with provider is required for provider sync.', {
      code: 'PROVIDER_SYNC_MAILBOX_MISSING',
    });
  }
  const syncMode = mode === 'replay' ? 'replay' : 'delta';
  const request = mailbox.provider === 'gmail'
    ? createGmailSyncRequest({ cursor, env, mailbox, mode: syncMode })
    : createOutlookSyncRequest({ cursor, env, mailbox, mode: syncMode });
  request.url = appendQuery(request.endpoint, request.query);
  request.requestDigest = requestDigest(request);
  return request;
}

function localMessageForRequest({ cursor = {}, mailbox, mode, request }) {
  const targets = sourceTargets(mailbox);
  const seed = mode === 'replay'
    ? `${mailbox.provider}:${mailbox.id}:replay:${cursor.windowStartAt ?? 'window'}`
    : `${mailbox.provider}:${mailbox.id}:delta:${cursor.cursor ?? 'cursor'}:${request.requestDigest}`;
  const messageId = `${mailbox.provider}-local-${digest(seed, 12)}`;
  return {
    account: `${mailbox.provider === 'gmail' ? 'Gmail' : 'Outlook'} Source Ops`,
    categories: targets,
    conversationId: `conv-${messageId}`,
    from: {
      emailAddress: {
        address: `${mailbox.provider}-source@signal.local`,
        name: `${mailbox.provider === 'gmail' ? 'Gmail' : 'Outlook'} Source Ops`,
      },
    },
    id: messageId,
    internetMessageId: `<${messageId}@signal.local>`,
    labelIds: targets,
    payload: {
      headers: [
        { name: 'From', value: `${mailbox.provider === 'gmail' ? 'Gmail' : 'Outlook'} Source Ops <${mailbox.provider}-source@signal.local>` },
        { name: 'Subject', value: `${mailbox.provider === 'gmail' ? 'Gmail' : 'Outlook'} cursor checkpoint` },
        { name: 'Date', value: nowIso() },
      ],
    },
    receivedDateTime: nowIso(),
    snippet: 'Routine provider metadata checkpoint for selected mailbox folders.',
    subject: `${mailbox.provider === 'gmail' ? 'Gmail' : 'Outlook'} cursor checkpoint`,
    threadId: `thread-${messageId}`,
  };
}

export function localProviderSyncResponse({ cursor = {}, mailbox, mode = 'delta', request } = {}) {
  const message = localMessageForRequest({ cursor, mailbox, mode, request });
  if (mailbox.provider === 'gmail') {
    const nextHistoryId = String(Date.now());
    const listKey = mode === 'replay' ? 'messages' : 'history';
    return {
      historyId: nextHistoryId,
      messageDetails: [message],
      ...(listKey === 'messages'
        ? { messages: [{ id: message.id, threadId: message.threadId }] }
        : { history: [{ id: nextHistoryId, messagesAdded: [{ message: { id: message.id, threadId: message.threadId } }] }] }),
    };
  }
  return {
    '@odata.deltaLink': `${graphBaseUrl}/me/mailFolders/${encodeURIComponent(outlookFolderId(mailbox))}/messages/delta?$deltatoken=${digest(message.id, 16)}`,
    value: [message],
  };
}

async function parseJsonResponse(response, { mailbox, request }) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderSyncError('Provider sync endpoint returned non-JSON response.', {
      code: 'PROVIDER_SYNC_RESPONSE_INVALID',
      status: 502,
      details: {
        endpoint: request.endpoint,
        provider: mailbox?.provider,
        requestDigest: request.requestDigest,
        responseStatus: response.status,
      },
    });
  }
}

function providerErrorMessage(parsed) {
  if (typeof parsed?.error === 'string') {
    return parsed.error;
  }
  return parsed?.error?.message ?? parsed?.message ?? null;
}

async function fetchJson(request, { accessToken, fetchImpl, mailbox }) {
  const response = await fetchImpl(request.url, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const parsed = await parseJsonResponse(response, { mailbox, request });
  if (!response.ok) {
    const retryAfterHeader = responseHeader(response, 'retry-after');
    throw new ProviderSyncError('Provider sync endpoint failed.', {
      code: 'PROVIDER_SYNC_REQUEST_FAILED',
      status: 502,
      details: {
        endpoint: request.endpoint,
        provider: mailbox?.provider,
        providerError: providerErrorMessage(parsed),
        providerErrorCode: parsed.error?.code ?? parsed.code ?? null,
        providerErrorStatus: parsed.error?.status ?? parsed.status ?? null,
        rateLimited: response.status === 429,
        requestDigest: request.requestDigest,
        retryAfter: retryAfterHeader,
        retryAfterAt: retryAfterToIso(retryAfterHeader),
        responseStatus: response.status,
      },
    });
  }
  return parsed;
}

function gmailMessageIds(response = {}) {
  const ids = new Set();
  (response.messages ?? []).forEach((message) => {
    if (message.id) {
      ids.add(message.id);
    }
  });
  (response.history ?? []).forEach((entry) => {
    (entry.messagesAdded ?? []).forEach((messageAdded) => {
      if (messageAdded.message?.id) {
        ids.add(messageAdded.message.id);
      }
    });
    (entry.messages ?? []).forEach((message) => {
      if (message.id) {
        ids.add(message.id);
      }
    });
  });
  return [...ids];
}

async function fetchGmailMessageDetails(response, { accessToken, fetchImpl, mailbox }) {
  if (Array.isArray(response.messageDetails)) {
    return response;
  }
  const details = [];
  for (const messageId of gmailMessageIds(response).slice(0, 25)) {
    const request = {
      endpoint: `${gmailBaseUrl}/messages/${encodeURIComponent(messageId)}`,
      method: 'GET',
      mode: 'detail',
      provider: 'gmail',
      query: {
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      },
    };
    request.url = appendQuery(request.endpoint, request.query);
    request.requestDigest = requestDigest(request);
    details.push(await fetchJson(request, { accessToken, fetchImpl, mailbox }));
  }
  return {
    ...response,
    messageDetails: details,
  };
}

export async function fetchProviderSync({ accessToken, cursor = {}, env = process.env, fetchImpl = globalThis.fetch, live = false, mailbox, mode = 'delta' } = {}) {
  const request = createProviderSyncRequest({ cursor, env, mailbox, mode });
  if (!live) {
    return {
      live: false,
      request,
      response: localProviderSyncResponse({ cursor, mailbox, mode: request.mode, request }),
    };
  }
  if (!accessToken) {
    throw new ProviderSyncError('Provider access token is required for live source sync.', {
      code: 'PROVIDER_SYNC_ACCESS_TOKEN_MISSING',
      status: 412,
      details: {
        endpoint: request.endpoint,
        provider: mailbox?.provider,
        requestDigest: request.requestDigest,
      },
    });
  }
  if (typeof fetchImpl !== 'function') {
    throw new ProviderSyncError('A fetch implementation is required for live source sync.', {
      code: 'PROVIDER_SYNC_FETCH_MISSING',
      status: 500,
      details: {
        endpoint: request.endpoint,
        provider: mailbox?.provider,
        requestDigest: request.requestDigest,
      },
    });
  }
  const response = await fetchJson(request, { accessToken, fetchImpl, mailbox });
  return {
    live: true,
    request,
    response: mailbox.provider === 'gmail'
      ? await fetchGmailMessageDetails(response, { accessToken, fetchImpl, mailbox })
      : response,
  };
}

function headerValue(message = {}, name) {
  const header = (message.payload?.headers ?? []).find((item) => String(item.name).toLowerCase() === name.toLowerCase());
  return header?.value ?? null;
}

function emailFromHeader(value = '') {
  const match = String(value).match(/<([^>]+)>/);
  if (match) {
    return match[1];
  }
  return String(value).trim();
}

function displayNameFromHeader(value = '') {
  const text = String(value);
  const match = text.match(/^([^<]+)</);
  return (match?.[1] ?? text.split('@')[0] ?? 'Unknown account').replaceAll('"', '').trim();
}

function accountFromAddress(from, fallback = 'Unknown account') {
  const label = displayNameFromHeader(from);
  if (label && !label.includes('@')) {
    return label;
  }
  const domain = String(emailFromHeader(from)).split('@')[1] ?? '';
  return domain
    ? domain.split('.')[0].replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
    : fallback;
}

function normalizedReceivedAt(value, fallback = nowIso()) {
  if (value && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return fallback;
}

function normalizedGmailMessage(message, { mailbox, request, response, resultMode }) {
  const fromHeader = headerValue(message, 'From') ?? 'unknown@example.invalid';
  const subject = headerValue(message, 'Subject') ?? '(no subject)';
  const dateHeader = headerValue(message, 'Date');
  return {
    id: `msg_${mailbox.provider}_${digest(`${mailbox.id}:${message.id}`)}`,
    tenantId: mailbox.tenantId,
    mailboxId: mailbox.id,
    providerMessageId: message.id,
    providerThreadId: message.threadId ?? null,
    providerCursor: response.historyId ? `gmail-history-${response.historyId}` : null,
    providerSyncMode: resultMode,
    providerRequestDigest: request.requestDigest,
    providerResponseDigest: responseDigest(response),
    account: message.account ?? accountFromAddress(fromHeader, 'Gmail source'),
    from: emailFromHeader(fromHeader),
    subject,
    snippet: String(message.snippet ?? '').slice(0, 600),
    receivedAt: normalizedReceivedAt(dateHeader),
    labels: message.labelIds ?? [],
    ingestedAt: nowIso(),
    rawRetentionExpiresAt: retentionExpiresAt(mailbox),
    processedFlowIds: [],
  };
}

function normalizedOutlookMessage(message, { mailbox, request, response, resultMode }) {
  const from = message.from?.emailAddress?.address ?? 'unknown@example.invalid';
  const fromName = message.from?.emailAddress?.name ?? from;
  return {
    id: `msg_${mailbox.provider}_${digest(`${mailbox.id}:${message.id ?? message.internetMessageId}`)}`,
    tenantId: mailbox.tenantId,
    mailboxId: mailbox.id,
    providerMessageId: message.internetMessageId ?? message.id,
    providerThreadId: message.conversationId ?? null,
    providerCursor: response['@odata.deltaLink'] ?? response['@odata.nextLink'] ?? null,
    providerSyncMode: resultMode,
    providerRequestDigest: request.requestDigest,
    providerResponseDigest: responseDigest(response),
    account: message.account ?? accountFromAddress(`${fromName} <${from}>`, 'Outlook source'),
    from,
    subject: message.subject ?? '(no subject)',
    snippet: String(message.bodyPreview ?? message.snippet ?? '').slice(0, 600),
    receivedAt: normalizedReceivedAt(message.receivedDateTime),
    labels: message.categories ?? [],
    ingestedAt: nowIso(),
    rawRetentionExpiresAt: retentionExpiresAt(mailbox),
    processedFlowIds: [],
  };
}

export function normalizeProviderSyncResult({ mailbox, result } = {}) {
  const mode = result.live ? 'live' : 'local';
  const providerResponseDigest = responseDigest(result.response);
  const messages = mailbox.provider === 'gmail'
    ? (result.response.messageDetails ?? []).map((message) => normalizedGmailMessage(message, { mailbox, request: result.request, response: result.response, resultMode: mode }))
    : (result.response.value ?? [])
      .filter((message) => !message['@removed'])
      .map((message) => normalizedOutlookMessage(message, { mailbox, request: result.request, response: result.response, resultMode: mode }));

  const nextCursor = mailbox.provider === 'gmail'
    ? (result.response.historyId ? `gmail-history-${result.response.historyId}` : null)
    : (result.response['@odata.deltaLink'] ?? result.response['@odata.nextLink'] ?? null);

  return {
    messages,
    mode,
    nextCursor,
    providerDeltaLink: mailbox.provider === 'outlook'
      ? (result.response['@odata.deltaLink'] ?? result.response['@odata.nextLink'] ?? null)
      : null,
    providerMessageCount: messages.length,
    providerRequestDigest: result.request.requestDigest,
    providerResponseDigest,
    request: result.request,
  };
}
