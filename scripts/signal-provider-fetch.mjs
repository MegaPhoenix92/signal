export function providerRequestTimeoutMs(env = process.env) {
  const value = env.SIGNAL_PROVIDER_REQUEST_TIMEOUT_MS;
  if (value === undefined || value === null || value === '') {
    return 30_000;
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    return 30_000;
  }
  return numeric;
}

export function providerRequestMaxRetries(env = process.env) {
  const value = env.SIGNAL_PROVIDER_REQUEST_MAX_RETRIES;
  if (value === undefined || value === null || value === '') {
    return 2;
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 8) {
    return 2;
  }
  return numeric;
}

function abortSignal(timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

function retryAfterMs(response) {
  const header = response.headers?.get?.('retry-after');
  if (!header) {
    return null;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

function backoffDelayMs(attempt, { baseMs = 500, capMs = 30_000 } = {}) {
  const exponential = Math.min(capMs, baseMs * (2 ** attempt));
  const jitter = Math.random() * exponential * 0.2;
  return Math.round(exponential + jitter);
}

function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function shouldRetryResponse(method, status, attempt, maxRetries) {
  if (attempt >= maxRetries) {
    return false;
  }
  if (isRetryableStatus(status)) {
    return true;
  }
  return ['GET', 'HEAD'].includes(method) && status >= 500;
}

function isRetryableFetchError(error) {
  return error?.name === 'TimeoutError'
    || error?.name === 'AbortError'
    || error?.code === 'ECONNRESET'
    || error?.code === 'ETIMEDOUT'
    || error?.code === 'ENOTFOUND'
    || error?.code === 'EAI_AGAIN';
}

export async function providerFetch(url, init = {}, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = providerRequestTimeoutMs(env),
  maxRetries = providerRequestMaxRetries(env),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function.');
  }
  const method = String(init.method ?? 'GET').toUpperCase();
  let attempt = 0;
  let lastError = null;

  while (attempt <= maxRetries) {
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: init.signal ?? abortSignal(timeoutMs),
      });
      if (!response.ok && shouldRetryResponse(method, response.status, attempt, maxRetries)) {
        const delayMs = retryAfterMs(response) ?? backoffDelayMs(attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        attempt += 1;
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (!isRetryableFetchError(error) || attempt >= maxRetries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt)));
      attempt += 1;
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error('Provider fetch failed without a response.');
}