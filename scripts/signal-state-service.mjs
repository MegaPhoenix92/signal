#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowedBackends = ['file', 'postgres'];

export class StateServiceError extends Error {
  constructor(message, { code = 'STATE_SERVICE_ERROR', status = 500 } = {}) {
    super(message);
    this.name = 'StateServiceError';
    this.code = code;
    this.status = status;
  }
}

export function createStateServiceConfig(env = process.env) {
  const host = env.SIGNAL_STATE_SERVICE_HOST ?? '127.0.0.1';
  const port = Number(env.SIGNAL_STATE_SERVICE_PORT ?? 8791);
  const backend = env.SIGNAL_STATE_SERVICE_BACKEND ?? 'file';
  const token = env.SIGNAL_STATE_SERVICE_TOKEN;
  const allowUnauthenticated = env.SIGNAL_STATE_SERVICE_ALLOW_UNAUTHENTICATED === 'true';
  const stateFile = path.resolve(env.SIGNAL_STATE_SERVICE_FILE ?? path.join(rootDir, 'data', 'signal-state-service.json'));
  const backupDir = path.resolve(env.SIGNAL_STATE_SERVICE_BACKUP_DIR ?? path.join(path.dirname(stateFile), 'signal-state-service-backups'));
  const databaseUrl = env.SIGNAL_STATE_SERVICE_DATABASE_URL ?? env.DATABASE_URL ?? '';
  const tablePrefix = env.SIGNAL_STATE_SERVICE_TABLE_PREFIX ?? 'signal_state';
  const stateId = env.SIGNAL_STATE_SERVICE_STATE_ID ?? 'default';
  const migrate = env.SIGNAL_STATE_SERVICE_MIGRATE !== 'false';

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid SIGNAL_STATE_SERVICE_PORT: ${env.SIGNAL_STATE_SERVICE_PORT}`);
  }
  if (!allowedBackends.includes(backend)) {
    throw new Error(`Invalid SIGNAL_STATE_SERVICE_BACKEND: ${backend}`);
  }
  if (!token && !allowUnauthenticated) {
    throw new Error('SIGNAL_STATE_SERVICE_TOKEN is required. Set SIGNAL_STATE_SERVICE_ALLOW_UNAUTHENTICATED=true only for isolated local development.');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tablePrefix)) {
    throw new Error('SIGNAL_STATE_SERVICE_TABLE_PREFIX must be a safe SQL identifier prefix.');
  }
  if (!stateId || stateId.length > 120) {
    throw new Error('SIGNAL_STATE_SERVICE_STATE_ID must be between 1 and 120 characters.');
  }
  if (backend === 'postgres' && !databaseUrl) {
    throw new Error('DATABASE_URL or SIGNAL_STATE_SERVICE_DATABASE_URL is required when SIGNAL_STATE_SERVICE_BACKEND=postgres.');
  }

  return {
    allowUnauthenticated,
    backend,
    backupDir,
    backupTable: `${tablePrefix}_backups`,
    databaseUrl,
    host,
    migrate,
    port,
    stateFile,
    stateId,
    stateTable: `${tablePrefix}_current`,
    tablePrefix,
    token,
  };
}

function json(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function parseIfMatchHeader(value) {
  if (!value) {
    return null;
  }
  const trimmed = String(value).trim();
  const match = trimmed.match(/^W\/"([^"]+)"$/) || trimmed.match(/^"([^"]+)"$/);
  return match ? match[1] : trimmed;
}

function formatStateEtag(meta) {
  if (!meta?.exists) {
    return null;
  }
  if (Number.isFinite(meta.revision)) {
    return `"${meta.revision}"`;
  }
  if (meta.digest) {
    return `"${meta.digest}"`;
  }
  return null;
}

function etagMatches(meta, ifMatchHeader) {
  const expected = parseIfMatchHeader(ifMatchHeader);
  if (!expected) {
    return false;
  }
  if (Number.isFinite(meta.revision)) {
    return String(meta.revision) === expected;
  }
  return meta.digest === expected;
}

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseStatePayload(rawBody) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new StateServiceError('State payload must be JSON.', {
      code: 'STATE_INVALID_JSON',
      status: 400,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StateServiceError('State payload must be a JSON object.', {
      code: 'STATE_INVALID_SHAPE',
      status: 400,
    });
  }
  const body = `${JSON.stringify(parsed, null, 2)}\n`;
  return {
    body,
    digest: digest(body),
    parsed,
  };
}

function authorized(req, config) {
  if (config.allowUnauthenticated) {
    return true;
  }
  return req.headers.authorization === `Bearer ${config.token}`;
}

function quoteIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

function serializePgBody(value) {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function timestamp(value) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class FileStateStore {
  constructor(config) {
    this.config = config;
  }

  async init() {}

  async meta() {
    if (!(await exists(this.config.stateFile))) {
      return {
        backend: 'file',
        exists: false,
        statePath: this.config.stateFile,
      };
    }
    const stat = await fs.stat(this.config.stateFile);
    const content = await fs.readFile(this.config.stateFile, 'utf8');
    let backupCount = 0;
    try {
      const backups = await fs.readdir(this.config.backupDir);
      backupCount = backups.filter((item) => item.endsWith('.json')).length;
    } catch {
      backupCount = 0;
    }
    return {
      backend: 'file',
      backups: backupCount,
      digest: digest(content),
      exists: true,
      sizeBytes: stat.size,
      statePath: this.config.stateFile,
      updatedAt: stat.mtime.toISOString(),
    };
  }

  async read() {
    if (!(await exists(this.config.stateFile))) {
      return null;
    }
    return fs.readFile(this.config.stateFile, 'utf8');
  }

  async write(rawBody) {
    const next = parseStatePayload(rawBody);
    await fs.mkdir(path.dirname(this.config.stateFile), { recursive: true });
    await fs.mkdir(this.config.backupDir, { recursive: true });
    if (await exists(this.config.stateFile)) {
      const backupStamp = new Date().toISOString().replace(/[:.]/g, '-');
      await fs.copyFile(this.config.stateFile, path.join(this.config.backupDir, `state-${backupStamp}.json`));
    }
    const tempPath = `${this.config.stateFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, next.body);
    await fs.rename(tempPath, this.config.stateFile);
    return this.meta();
  }

  async close() {}
}

export class PostgresStateStore {
  constructor(config, pool) {
    this.config = config;
    this.pool = pool;
    this.stateTable = quoteIdentifier(config.stateTable);
    this.backupTable = quoteIdentifier(config.backupTable);
  }

  async init() {
    if (!this.config.migrate) {
      return;
    }
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.stateTable} (
        id text PRIMARY KEY,
        body jsonb NOT NULL,
        revision integer NOT NULL DEFAULT 1,
        body_digest text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.backupTable} (
        backup_id bigserial PRIMARY KEY,
        state_id text NOT NULL,
        revision integer NOT NULL,
        body jsonb NOT NULL,
        body_digest text NOT NULL,
        backed_up_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.config.backupTable}_state_idx`)}
      ON ${this.backupTable} (state_id, revision)
    `);
  }

  async meta() {
    const result = await this.pool.query(
      `SELECT revision, body_digest, octet_length(body::text) AS size_bytes, updated_at
       FROM ${this.stateTable}
       WHERE id = $1`,
      [this.config.stateId],
    );
    const backupResult = await this.pool.query(
      `SELECT count(*)::int AS backup_count
       FROM ${this.backupTable}
       WHERE state_id = $1`,
      [this.config.stateId],
    );
    const backupCount = Number(backupResult.rows[0]?.backup_count ?? 0);
    if (!result.rows.length) {
      return {
        backend: 'postgres',
        backups: backupCount,
        exists: false,
        stateId: this.config.stateId,
        stateTable: this.config.stateTable,
        backupTable: this.config.backupTable,
      };
    }
    const row = result.rows[0];
    return {
      backend: 'postgres',
      backupTable: this.config.backupTable,
      backups: backupCount,
      digest: row.body_digest,
      exists: true,
      revision: Number(row.revision),
      sizeBytes: Number(row.size_bytes ?? 0),
      stateId: this.config.stateId,
      stateTable: this.config.stateTable,
      updatedAt: timestamp(row.updated_at),
    };
  }

  async read() {
    const result = await this.pool.query(
      `SELECT body
       FROM ${this.stateTable}
       WHERE id = $1`,
      [this.config.stateId],
    );
    if (!result.rows.length) {
      return null;
    }
    return `${serializePgBody(result.rows[0].body)}\n`;
  }

  async write(rawBody) {
    const next = parseStatePayload(rawBody);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const previous = await client.query(
        `SELECT body, revision, body_digest
         FROM ${this.stateTable}
         WHERE id = $1
         FOR UPDATE`,
        [this.config.stateId],
      );
      const revision = previous.rows.length ? Number(previous.rows[0].revision) + 1 : 1;
      if (previous.rows.length) {
        await client.query(
          `INSERT INTO ${this.backupTable} (state_id, revision, body, body_digest, backed_up_at)
           VALUES ($1, $2, $3::jsonb, $4, now())`,
          [
            this.config.stateId,
            Number(previous.rows[0].revision),
            JSON.stringify(previous.rows[0].body),
            previous.rows[0].body_digest,
          ],
        );
      }
      await client.query(
        `INSERT INTO ${this.stateTable} (id, body, revision, body_digest, updated_at)
         VALUES ($1, $2::jsonb, $3, $4, now())
         ON CONFLICT (id)
         DO UPDATE SET body = EXCLUDED.body,
                       revision = EXCLUDED.revision,
                       body_digest = EXCLUDED.body_digest,
                       updated_at = now()`,
        [this.config.stateId, JSON.stringify(next.parsed), revision, next.digest],
      );
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original database error.
      }
      throw error;
    } finally {
      client.release();
    }
    return this.meta();
  }

  async close() {
    await this.pool.end?.();
  }
}

export async function createStateStore(config, { pgPool } = {}) {
  if (config.backend === 'file') {
    return new FileStateStore(config);
  }
  let pool = pgPool;
  if (!pool) {
    const pg = await import('pg');
    const Pool = pg.Pool ?? pg.default?.Pool;
    if (!Pool) {
      throw new Error('The pg package did not expose a Pool constructor.');
    }
    pool = new Pool({
      application_name: 'signal-state-service',
      connectionString: config.databaseUrl,
      max: Number(process.env.SIGNAL_STATE_SERVICE_PG_POOL_SIZE ?? 4),
    });
  }
  return new PostgresStateStore(config, pool);
}

export function createStateServiceServer(config, store) {
  return http.createServer((req, res) => {
    route(req, res, config, store).catch((error) => {
      if (error instanceof StateServiceError) {
        json(res, error.status, {
          ok: false,
          code: error.code,
          error: error.message,
        });
        return;
      }
      json(res, 500, {
        ok: false,
        code: 'STATE_SERVICE_ERROR',
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

async function route(req, res, config, store) {
  const url = new URL(req.url ?? '/', `http://${config.host}:${config.port}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      ok: true,
      service: 'signal-state-service',
      authenticated: !config.allowUnauthenticated,
      storage: storageSummary(config),
      state: await store.meta(),
    });
    return;
  }

  if (url.pathname !== '/state') {
    json(res, 404, { ok: false, code: 'NOT_FOUND', error: 'Not found' });
    return;
  }

  if (!authorized(req, config)) {
    json(res, 401, { ok: false, code: 'UNAUTHORIZED', error: 'State service bearer token is required.' });
    return;
  }

  if (req.method === 'GET') {
    const meta = await store.meta();
    const body = await store.read();
    if (!body) {
      json(res, 404, { ok: false, code: 'STATE_MISSING', error: 'State has not been bootstrapped.' });
      return;
    }
    const etag = formatStateEtag(meta);
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (etag) {
      headers.ETag = etag;
    }
    res.writeHead(200, headers);
    res.end(body);
    return;
  }

  if (req.method === 'PUT') {
    const currentMeta = await store.meta();
    const ifMatch = req.headers['if-match'];
    if (currentMeta.exists && ifMatch && !etagMatches(currentMeta, ifMatch)) {
      json(res, 409, {
        ok: false,
        code: 'STATE_REVISION_CONFLICT',
        error: 'State revision conflict — concurrent write detected.',
        state: currentMeta,
      });
      return;
    }
    const meta = await store.write(await readRawBody(req));
    const etag = formatStateEtag(meta);
    json(res, 200, { ok: true, state: meta }, etag ? { ETag: etag } : {});
    return;
  }

  json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'Use GET or PUT for /state.' });
}

function storageSummary(config) {
  if (config.backend === 'postgres') {
    return {
      backend: 'postgres',
      migrate: config.migrate,
      stateId: config.stateId,
      stateTable: config.stateTable,
      backupTable: config.backupTable,
    };
  }
  return {
    backend: 'file',
    statePath: config.stateFile,
    backupDir: config.backupDir,
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startStateService({ env = process.env, log = console.log, pgPool } = {}) {
  const config = createStateServiceConfig(env);
  const store = await createStateStore(config, { pgPool });
  await store.init();
  const server = createStateServiceServer(config, store);
  await listen(server, config.port, config.host);
  log(`Signal state service listening on http://${config.host}:${config.port}`);
  if (config.backend === 'postgres') {
    log(`Backend: postgres`);
    log(`State table: ${config.stateTable}`);
    log(`Backup table: ${config.backupTable}`);
  } else {
    log(`Backend: file`);
    log(`State: ${config.stateFile}`);
    log(`Backups: ${config.backupDir}`);
  }
  return {
    config,
    server,
    store,
    async close() {
      await closeServer(server);
      await store.close();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let running;
  const shutdown = async () => {
    if (running) {
      await running.close();
    }
  };
  process.on('SIGTERM', () => {
    shutdown().finally(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    shutdown().finally(() => process.exit(0));
  });

  startStateService().then((service) => {
    running = service;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
