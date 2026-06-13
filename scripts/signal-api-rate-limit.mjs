export function requestClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = raw.split(',')[0]?.trim();
    if (first) {
      return first;
    }
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

export function createRateLimiter({
  maxAttempts = 5,
  windowMs = 60 * 60 * 1000,
} = {}) {
  const buckets = new Map();

  function consume(key, now = Date.now()) {
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      buckets.set(key, { count: 1, windowStart: now });
      return { allowed: true, remaining: maxAttempts - 1, retryAfterMs: 0 };
    }

    if (bucket.count >= maxAttempts) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, windowMs - (now - bucket.windowStart)),
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      remaining: maxAttempts - bucket.count,
      retryAfterMs: 0,
    };
  }

  function reset() {
    buckets.clear();
  }

  return { consume, reset };
}