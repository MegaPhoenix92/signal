import net from 'node:net';
import tls from 'node:tls';

const DEFAULT_REDIS_TIMEOUT_MS = 1000;
const DEFAULT_POSTGRES_TABLE = 'signal_rate_limits';
const REDIS_RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local burst = tonumber(ARGV[1])
local rps = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local existing = redis.call('HMGET', key, 'tokens', 'updatedAt')
local tokens = tonumber(existing[1])
local updatedAt = tonumber(existing[2])
if tokens == nil or updatedAt == nil then
  tokens = burst
  updatedAt = now
end
local elapsedSeconds = math.max(0, (now - updatedAt) / 1000)
tokens = math.min(burst, tokens + elapsedSeconds * rps)
updatedAt = now
if tokens < 1 then
  local retryAfterSeconds = math.max(1, math.ceil((1 - tokens) / rps))
  redis.call('HSET', key, 'tokens', tostring(tokens), 'updatedAt', tostring(updatedAt))
  redis.call('PEXPIRE', key, ttl)
  return {0, retryAfterSeconds}
end
tokens = tokens - 1
redis.call('HSET', key, 'tokens', tostring(tokens), 'updatedAt', tostring(updatedAt))
redis.call('PEXPIRE', key, ttl)
return {1, 0}
`;

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

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeTokenBucketConfig(config) {
  const burst = Number(config?.burst);
  const rps = Number(config?.rps);
  if (!Number.isFinite(burst) || burst <= 0 || !Number.isFinite(rps) || rps <= 0) {
    throw new Error('Rate limit token bucket requires positive burst and rps values.');
  }
  return { burst, rps };
}

function tokenBucketTtlMs(config) {
  const { burst, rps } = normalizeTokenBucketConfig(config);
  return Math.max(1000, Math.ceil((burst / rps) * 1000));
}

export function consumeTokenBucketState(bucket, config, now = Date.now()) {
  const { burst, rps } = normalizeTokenBucketConfig(config);
  const previous = bucket && Number.isFinite(Number(bucket.tokens)) && Number.isFinite(Number(bucket.updatedAt))
    ? { tokens: Number(bucket.tokens), updatedAt: Number(bucket.updatedAt) }
    : { tokens: burst, updatedAt: now };
  const elapsedSeconds = Math.max(0, (now - previous.updatedAt) / 1000);
  const next = {
    tokens: Math.min(burst, previous.tokens + elapsedSeconds * rps),
    updatedAt: now,
  };

  if (next.tokens < 1) {
    return {
      allowed: false,
      bucket: next,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - next.tokens) / rps)),
    };
  }

  next.tokens -= 1;
  return {
    allowed: true,
    bucket: next,
    retryAfterSeconds: 0,
  };
}

export function createMemoryTokenBucketStore() {
  const buckets = new Map();
  return {
    kind: 'memory',
    async consumeTokenBucket(key, config, now = Date.now()) {
      const result = consumeTokenBucketState(buckets.get(key), config, now);
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
}

export function createTokenBucketRateLimiter({
  now = () => Date.now(),
  store = createMemoryTokenBucketStore(),
} = {}) {
  return {
    storeKind: store.kind ?? 'custom',
    async consume(key, config) {
      return store.consumeTokenBucket(String(key), config, now());
    },
    reset() {
      store.reset?.();
    },
  };
}

function rateLimitStoreError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

export function createRateLimitStoreFromEnv(env = process.env) {
  const requested = (env.SIGNAL_RATE_LIMIT_STORE ?? 'memory').trim().toLowerCase();
  if (!requested || requested === 'memory') {
    return createMemoryTokenBucketStore();
  }
  if (requested === 'redis') {
    const url = env.SIGNAL_RATE_LIMIT_REDIS_URL ?? env.REDIS_URL;
    if (!url) {
      throw rateLimitStoreError('SIGNAL_RATE_LIMIT_STORE=redis requires REDIS_URL or SIGNAL_RATE_LIMIT_REDIS_URL.', 'RATE_LIMIT_STORE_UNCONFIGURED', { store: 'redis' });
    }
    return createRedisRateLimitStore({
      timeoutMs: positiveInteger(env.SIGNAL_RATE_LIMIT_STORE_TIMEOUT_MS, DEFAULT_REDIS_TIMEOUT_MS),
      url,
    });
  }
  if (requested === 'postgres' || requested === 'postgresql') {
    const connectionString = env.SIGNAL_RATE_LIMIT_DATABASE_URL ?? env.DATABASE_URL;
    if (!connectionString) {
      throw rateLimitStoreError('SIGNAL_RATE_LIMIT_STORE=postgres requires DATABASE_URL or SIGNAL_RATE_LIMIT_DATABASE_URL.', 'RATE_LIMIT_STORE_UNCONFIGURED', { store: 'postgres' });
    }
    return createPostgresRateLimitStore({
      connectionString,
      tableName: env.SIGNAL_RATE_LIMIT_POSTGRES_TABLE ?? DEFAULT_POSTGRES_TABLE,
    });
  }
  throw rateLimitStoreError(`Unsupported SIGNAL_RATE_LIMIT_STORE: ${requested}`, 'RATE_LIMIT_STORE_UNSUPPORTED', { store: requested });
}

export function createApiRateLimiter({
  env = process.env,
  now = () => Date.now(),
  store = createRateLimitStoreFromEnv(env),
} = {}) {
  return createTokenBucketRateLimiter({ now, store });
}

function redisRateLimitKey(key) {
  return `signal:api-rate-limit:${key}`;
}

function encodeRedisCommand(args) {
  return `*${args.length}\r\n${args.map((arg) => {
    const value = String(arg);
    return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  }).join('')}`;
}

function redisUrlParts(urlText) {
  const url = new URL(urlText);
  if (!['redis:', 'rediss:'].includes(url.protocol)) {
    throw rateLimitStoreError('Redis rate limit store requires a redis:// or rediss:// URL.', 'RATE_LIMIT_STORE_INVALID_URL', { store: 'redis' });
  }
  return {
    database: url.pathname && url.pathname !== '/' ? decodeURIComponent(url.pathname.slice(1)) : null,
    host: url.hostname,
    password: url.password ? decodeURIComponent(url.password) : null,
    port: Number(url.port || (url.protocol === 'rediss:' ? 6380 : 6379)),
    secure: url.protocol === 'rediss:',
    username: url.username ? decodeURIComponent(url.username) : null,
  };
}

function redisCommandsFor(urlText, command) {
  const parts = redisUrlParts(urlText);
  const commands = [];
  if (parts.password) {
    commands.push(parts.username ? ['AUTH', parts.username, parts.password] : ['AUTH', parts.password]);
  }
  if (parts.database && parts.database !== '0') {
    commands.push(['SELECT', parts.database]);
  }
  commands.push(command);
  return { commands, parts };
}

function incompleteRedisResponse() {
  const error = new Error('Incomplete Redis response.');
  error.incomplete = true;
  return error;
}

function parseRedisResponse(buffer, offset = 0) {
  if (offset >= buffer.length) {
    throw incompleteRedisResponse();
  }
  const prefix = buffer[offset];
  const lineEnd = buffer.indexOf('\r\n', offset);
  if (lineEnd < 0) {
    throw incompleteRedisResponse();
  }
  const line = buffer.slice(offset + 1, lineEnd);
  const nextOffset = lineEnd + 2;
  if (prefix === '+') {
    return { offset: nextOffset, value: line };
  }
  if (prefix === '-') {
    throw rateLimitStoreError(line, 'RATE_LIMIT_REDIS_ERROR', { store: 'redis' });
  }
  if (prefix === ':') {
    return { offset: nextOffset, value: Number(line) };
  }
  if (prefix === '$') {
    const length = Number(line);
    if (length === -1) {
      return { offset: nextOffset, value: null };
    }
    const valueEnd = nextOffset + length;
    if (buffer.length < valueEnd + 2) {
      throw incompleteRedisResponse();
    }
    return {
      offset: valueEnd + 2,
      value: buffer.slice(nextOffset, valueEnd),
    };
  }
  if (prefix === '*') {
    const count = Number(line);
    if (count === -1) {
      return { offset: nextOffset, value: null };
    }
    const values = [];
    let cursor = nextOffset;
    for (let index = 0; index < count; index += 1) {
      const parsed = parseRedisResponse(buffer, cursor);
      values.push(parsed.value);
      cursor = parsed.offset;
    }
    return { offset: cursor, value: values };
  }
  throw rateLimitStoreError('Unsupported Redis response type.', 'RATE_LIMIT_REDIS_RESPONSE_UNSUPPORTED', { prefix, store: 'redis' });
}

function redisRequest(urlText, commands, timeoutMs) {
  const { commands: sequencedCommands, parts } = redisCommandsFor(urlText, commands);
  return new Promise((resolve, reject) => {
    let buffer = '';
    let closed = false;
    let offset = 0;
    const responses = [];
    let socket = null;
    function writeCommands() {
      socket.write(sequencedCommands.map(encodeRedisCommand).join(''));
    }
    function finish(value) {
      if (closed) {
        return;
      }
      closed = true;
      clearTimeout(timer);
      socket.end();
      resolve(value);
    }
    function fail(error) {
      if (closed) {
        return;
      }
      closed = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    }
    const timer = setTimeout(() => {
      fail(rateLimitStoreError('Redis rate limit store request timed out.', 'RATE_LIMIT_STORE_TIMEOUT', { store: 'redis', timeoutMs }));
    }, timeoutMs);
    socket = parts.secure
      ? tls.connect({ host: parts.host, port: parts.port, servername: parts.host }, writeCommands)
      : net.connect({ host: parts.host, port: parts.port }, writeCommands);
    socket.on('error', fail);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      try {
        while (responses.length < sequencedCommands.length) {
          const parsed = parseRedisResponse(buffer, offset);
          responses.push(parsed.value);
          offset = parsed.offset;
        }
        finish(responses.at(-1));
      } catch (error) {
        if (error.incomplete) {
          return;
        }
        fail(error);
      }
    });
  });
}

export function createRedisRateLimitStore({ timeoutMs = DEFAULT_REDIS_TIMEOUT_MS, url }) {
  return {
    kind: 'redis',
    async consumeTokenBucket(key, config, now = Date.now()) {
      const ttlMs = tokenBucketTtlMs(config);
      const result = await redisRequest(url, [
        'EVAL',
        REDIS_RATE_LIMIT_SCRIPT,
        '1',
        redisRateLimitKey(key),
        String(normalizeTokenBucketConfig(config).burst),
        String(normalizeTokenBucketConfig(config).rps),
        String(now),
        String(ttlMs),
      ], timeoutMs);
      const [allowed, retryAfterSeconds] = Array.isArray(result) ? result : [0, 1];
      return {
        allowed: Number(allowed) === 1,
        retryAfterSeconds: Math.max(0, Number(retryAfterSeconds) || 0),
      };
    },
  };
}

function quotedPostgresIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw rateLimitStoreError('Invalid rate limit Postgres table identifier.', 'RATE_LIMIT_STORE_INVALID_TABLE', { tableName: identifier });
  }
  return `"${identifier}"`;
}

export function createPostgresRateLimitStore({
  connectionString,
  tableName = DEFAULT_POSTGRES_TABLE,
} = {}) {
  const table = quotedPostgresIdentifier(tableName);
  let poolPromise = null;
  let ensureTablePromise = null;

  async function getPool() {
    if (!poolPromise) {
      poolPromise = import('pg').then((pg) => {
        const Pool = pg.Pool ?? pg.default?.Pool;
        if (!Pool) {
          throw rateLimitStoreError('pg Pool export is unavailable.', 'RATE_LIMIT_POSTGRES_DRIVER_UNAVAILABLE', { store: 'postgres' });
        }
        return new Pool({ connectionString });
      });
    }
    return poolPromise;
  }

  async function ensureTable() {
    if (!ensureTablePromise) {
      ensureTablePromise = getPool().then((pool) => pool.query(`
        CREATE TABLE IF NOT EXISTS ${table} (
          key text PRIMARY KEY,
          tokens double precision NOT NULL,
          updated_at_ms bigint NOT NULL,
          expires_at timestamptz NOT NULL
        )
      `));
    }
    await ensureTablePromise;
  }

  return {
    kind: 'postgres',
    async consumeTokenBucket(key, config, now = Date.now()) {
      await ensureTable();
      const pool = await getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT tokens, updated_at_ms FROM ${table} WHERE key = $1 FOR UPDATE`, [key]);
        const bucket = existing.rows[0]
          ? { tokens: Number(existing.rows[0].tokens), updatedAt: Number(existing.rows[0].updated_at_ms) }
          : null;
        const result = consumeTokenBucketState(bucket, config, now);
        await client.query(`
          INSERT INTO ${table} (key, tokens, updated_at_ms, expires_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (key)
          DO UPDATE SET tokens = EXCLUDED.tokens, updated_at_ms = EXCLUDED.updated_at_ms, expires_at = EXCLUDED.expires_at
        `, [
          key,
          result.bucket.tokens,
          Math.trunc(result.bucket.updatedAt),
          new Date(now + tokenBucketTtlMs(config)),
        ]);
        await client.query('COMMIT');
        return {
          allowed: result.allowed,
          retryAfterSeconds: result.retryAfterSeconds,
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async reset() {
      await ensureTable();
      const pool = await getPool();
      await pool.query(`DELETE FROM ${table}`);
    },
  };
}
