#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLogger,
} from './signal-logger.mjs';

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
  const migrationsDir = path.resolve(env.SIGNAL_STATE_SERVICE_MIGRATIONS_DIR ?? path.join(rootDir, 'scripts', 'migrations'));
  const migrationTable = env.SIGNAL_STATE_SERVICE_MIGRATION_TABLE ?? 'signal_schema_migrations';
  const tablePrefix = env.SIGNAL_STATE_SERVICE_TABLE_PREFIX ?? 'signal_state';
  const stateId = env.SIGNAL_STATE_SERVICE_STATE_ID ?? 'default';
  const migrate = env.SIGNAL_STATE_SERVICE_MIGRATE !== 'false';
  const rls = env.SIGNAL_STATE_SERVICE_RLS === 'true'
    || env.SIGNAL_STATE_SERVICE_ENABLE_RLS === 'true'
    || env.SIGNAL_TENANT_ISOLATION_MODE === 'rls';

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
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(migrationTable)) {
    throw new Error('SIGNAL_STATE_SERVICE_MIGRATION_TABLE must be a safe SQL identifier.');
  }
  if (!stateId || stateId.length > 120) {
    throw new Error('SIGNAL_STATE_SERVICE_STATE_ID must be between 1 and 120 characters.');
  }
  if (backend === 'postgres' && !databaseUrl) {
    throw new Error('DATABASE_URL or SIGNAL_STATE_SERVICE_DATABASE_URL is required when SIGNAL_STATE_SERVICE_BACKEND=postgres.');
  }
  const backupRetentionDays = Number(env.SIGNAL_STATE_BACKUP_RETENTION_DAYS ?? 30);
  if (!Number.isInteger(backupRetentionDays) || backupRetentionDays < 0) {
    throw new Error('SIGNAL_STATE_BACKUP_RETENTION_DAYS must be a non-negative integer.');
  }

  return {
    allowUnauthenticated,
    backend,
    backupDir,
    backupRetentionDays,
    backupTable: `${tablePrefix}_backups`,
    databaseUrl,
    host,
    migrate,
    migrationsDir,
    migrationTable,
    port,
    rls,
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

function migrationVersionFromFile(name) {
  const match = name.match(/^(\d+)-([A-Za-z0-9_-]+)\.sql$/);
  if (!match) {
    return null;
  }
  return {
    version: Number(match[1]),
    name: match[2],
  };
}

function splitSqlStatements(sql) {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function loadMigrationFiles(config) {
  const entries = await fs.readdir(config.migrationsDir);
  const migrations = [];
  for (const entry of entries) {
    const parsed = migrationVersionFromFile(entry);
    if (!parsed) {
      continue;
    }
    const rawSql = await fs.readFile(path.join(config.migrationsDir, entry), 'utf8');
    const sql = rawSql
      .replaceAll('{{STATE_TABLE}}', quoteIdentifier(config.stateTable))
      .replaceAll('{{BACKUP_TABLE}}', quoteIdentifier(config.backupTable))
      .replaceAll('{{BACKUP_INDEX}}', quoteIdentifier(`${config.backupTable}_state_idx`));
    migrations.push({
      ...parsed,
      checksum: digest(rawSql),
      file: entry,
      sql,
    });
  }
  return migrations.sort((left, right) => left.version - right.version);
}

async function migrationTableExists(config, pool) {
  const result = await pool.query('SELECT to_regclass($1) AS regclass', [config.migrationTable]);
  return Boolean(result.rows?.[0]?.regclass);
}

async function ensureMigrationTable(config, pool) {
  const migrationTable = quoteIdentifier(config.migrationTable);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${migrationTable} (
      version integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      checksum text NOT NULL
    )
  `);
}

async function appliedMigrations(config, pool) {
  if (!(await migrationTableExists(config, pool))) {
    return [];
  }
  const result = await pool.query(`
    SELECT version, name, checksum, applied_at
    FROM ${quoteIdentifier(config.migrationTable)}
    ORDER BY version
  `);
  return result.rows ?? [];
}

export async function postgresMigrationStatus(config, pool) {
  const files = await loadMigrationFiles(config);
  const applied = await appliedMigrations(config, pool);
  const appliedByVersion = new Map(applied.map((row) => [Number(row.version), row]));
  const rows = files.map((file) => {
    const row = appliedByVersion.get(file.version);
    return {
      version: file.version,
      name: file.name,
      checksum: file.checksum,
      appliedAt: timestamp(row?.applied_at),
      appliedChecksum: row?.checksum ?? null,
      status: row ? (row.checksum === file.checksum ? 'applied' : 'checksum_mismatch') : 'pending',
    };
  });
  return {
    applied: rows.filter((row) => row.status === 'applied').length,
    pending: rows.filter((row) => row.status === 'pending').length,
    ok: rows.every((row) => row.status === 'applied'),
    rows,
  };
}

async function runPostgresMigrations(config, pool, { migrate }) {
  const files = await loadMigrationFiles(config);
  if (migrate) {
    await ensureMigrationTable(config, pool);
  }
  const applied = await appliedMigrations(config, pool);
  const appliedByVersion = new Map(applied.map((row) => [Number(row.version), row]));
  for (const file of files) {
    const row = appliedByVersion.get(file.version);
    if (row && row.checksum !== file.checksum) {
      throw new StateServiceError(`Applied migration checksum changed for ${file.file}.`, {
        code: 'STATE_SERVICE_MIGRATION_CHECKSUM_CHANGED',
        status: 500,
      });
    }
  }
  const pending = files.filter((file) => !appliedByVersion.has(file.version));
  if (!migrate && pending.length > 0) {
    throw new StateServiceError(`Postgres state schema has ${pending.length} pending migration(s). Set SIGNAL_STATE_SERVICE_MIGRATE=true before startup.`, {
      code: 'STATE_SERVICE_MIGRATIONS_PENDING',
      status: 503,
    });
  }
  for (const file of pending) {
    await pool.query('BEGIN');
    try {
      for (const statement of splitSqlStatements(file.sql)) {
        await pool.query(statement);
      }
      await pool.query(
        `INSERT INTO ${quoteIdentifier(config.migrationTable)} (version, name, checksum) VALUES ($1, $2, $3)`,
        [file.version, file.name, file.checksum],
      );
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }
  return postgresMigrationStatus(config, pool);
}

function rlsPolicyName(tableName) {
  return `${tableName}_service_role_policy`;
}

export async function verifyPostgresRlsPolicies(config, pool) {
  const tableNames = [config.stateTable, config.backupTable];
  const policyRows = await pool.query(
    `SELECT tablename, policyname
     FROM pg_policies
     WHERE tablename = ANY($1)`,
    [tableNames],
  );
  const rlsRows = await pool.query(
    `SELECT relname, relrowsecurity
     FROM pg_class
     WHERE relname = ANY($1)`,
    [tableNames],
  );
  const policiesByTable = new Map();
  for (const row of policyRows.rows ?? []) {
    if (!policiesByTable.has(row.tablename)) {
      policiesByTable.set(row.tablename, []);
    }
    policiesByTable.get(row.tablename).push(row.policyname);
  }
  const rlsByTable = new Map((rlsRows.rows ?? []).map((row) => [row.relname, Boolean(row.relrowsecurity)]));
  const tables = tableNames.map((tableName) => {
    const policies = policiesByTable.get(tableName) ?? [];
    return {
      table: tableName,
      rlsEnabled: rlsByTable.get(tableName) === true,
      policies,
      policyCount: policies.length,
    };
  });
  const ok = tables.every((table) => table.rlsEnabled && table.policyCount > 0);
  return {
    ok,
    tables,
  };
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

async function pruneFileBackups(backupDir, retentionDays) {
  if (!retentionDays || retentionDays <= 0) {
    return;
  }
  const cutoffMs = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
  let entries = [];
  try {
    entries = await fs.readdir(backupDir);
  } catch {
    return;
  }
  await Promise.all(entries.filter((entry) => entry.endsWith('.json')).map(async (entry) => {
    const filePath = path.join(backupDir, entry);
    try {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < cutoffMs) {
        await fs.unlink(filePath);
      }
    } catch {
      // Best-effort retention cleanup.
    }
  }));
}

function assertIfMatchForWrite(currentMeta, ifMatch) {
  if (!currentMeta.exists) {
    return;
  }
  if (!ifMatch) {
    throw new StateServiceError('If-Match is required when state exists.', {
      code: 'STATE_PRECONDITION_REQUIRED',
      status: 428,
    });
  }
  if (!etagMatches(currentMeta, ifMatch)) {
    throw new StateServiceError('State revision conflict — concurrent write detected.', {
      code: 'STATE_REVISION_CONFLICT',
      status: 409,
    });
  }
}

export class FileStateStore {
  constructor(config) {
    this.config = config;
    this.writeChain = Promise.resolve();
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

  async write(rawBody, { ifMatch } = {}) {
    const run = async () => {
      const next = parseStatePayload(rawBody);
      const currentMeta = await this.meta();
      assertIfMatchForWrite(currentMeta, ifMatch);
      await fs.mkdir(path.dirname(this.config.stateFile), { recursive: true });
      await fs.mkdir(this.config.backupDir, { recursive: true });
      if (currentMeta.exists) {
        const backupStamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fs.copyFile(this.config.stateFile, path.join(this.config.backupDir, `state-${backupStamp}.json`));
        await pruneFileBackups(this.config.backupDir, this.config.backupRetentionDays);
      }
      const tempPath = `${this.config.stateFile}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.writeFile(tempPath, next.body);
        await fs.rename(tempPath, this.config.stateFile);
      } catch (error) {
        await fs.unlink(tempPath).catch(() => {});
        throw error;
      }
      return this.meta();
    };
    const next = this.writeChain.catch(() => {}).then(run);
    this.writeChain = next;
    return next;
  }

  async close() {}
}

export class PostgresStateStore {
  constructor(config, pool) {
    this.config = config;
    this.pool = pool;
    this.stateTable = quoteIdentifier(config.stateTable);
    this.backupTable = quoteIdentifier(config.backupTable);
    this.rlsStatus = null;
    this.migrationsStatus = null;
  }

  async init() {
    this.migrationsStatus = await runPostgresMigrations(this.config, this.pool, { migrate: this.config.migrate });
    if (this.config.rls) {
      if (this.config.migrate) {
        await this.applyRlsPolicies();
      }
      this.rlsStatus = await verifyPostgresRlsPolicies(this.config, this.pool);
      if (!this.rlsStatus.ok) {
        throw new StateServiceError('Postgres RLS mode is enabled, but state-service RLS policies are not installed for every state table.', {
          code: 'STATE_SERVICE_RLS_NOT_VERIFIED',
          status: 500,
        });
      }
    }
  }

  async applyRlsPolicies() {
    for (const [tableName, quotedTable] of [
      [this.config.stateTable, this.stateTable],
      [this.config.backupTable, this.backupTable],
    ]) {
      const quotedPolicy = quoteIdentifier(rlsPolicyName(tableName));
      await this.pool.query(`ALTER TABLE ${quotedTable} ENABLE ROW LEVEL SECURITY`);
      await this.pool.query(`DROP POLICY IF EXISTS ${quotedPolicy} ON ${quotedTable}`);
      await this.pool.query(`
        CREATE POLICY ${quotedPolicy}
        ON ${quotedTable}
        FOR ALL
        USING (true)
        WITH CHECK (true)
      `);
    }
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
        rls: this.rlsStatus,
        migrations: this.migrationsStatus,
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
      rls: this.rlsStatus,
      migrations: this.migrationsStatus,
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

  async write(rawBody, { ifMatch } = {}) {
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
      const currentMeta = previous.rows.length
        ? {
            exists: true,
            revision: Number(previous.rows[0].revision),
            digest: previous.rows[0].body_digest,
          }
        : { exists: false };
      assertIfMatchForWrite(currentMeta, ifMatch);
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
        if (this.config.backupRetentionDays > 0) {
          await client.query(
            `DELETE FROM ${this.backupTable}
             WHERE state_id = $1
               AND backed_up_at < now() - ($2::text || ' days')::interval`,
            [this.config.stateId, String(this.config.backupRetentionDays)],
          );
        }
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

  async migrations() {
    this.migrationsStatus = await postgresMigrationStatus(this.config, this.pool);
    return this.migrationsStatus;
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
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/ready') {
    try {
      const meta = await store.meta();
      if (!authorized(req, config)) {
        json(res, 200, {
          ok: true,
          ready: meta.exists,
          service: 'signal-state-service',
        });
        return;
      }
      json(res, 200, {
        ok: true,
        ready: meta.exists,
        service: 'signal-state-service',
        storage: storageSummary(config),
        state: meta,
      });
    } catch (error) {
      json(res, 503, {
        ok: false,
        service: 'signal-state-service',
        code: 'STATE_SERVICE_NOT_READY',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    if (!authorized(req, config)) {
      json(res, 401, { ok: false, code: 'UNAUTHORIZED', error: 'State service bearer token is required.' });
      return;
    }
    json(res, 200, {
      ok: true,
      service: 'signal-state-service',
      storage: storageSummary(config),
      state: await store.meta(),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/migrations') {
    if (!authorized(req, config)) {
      json(res, 401, { ok: false, code: 'UNAUTHORIZED', error: 'State service bearer token is required.' });
      return;
    }
    if (config.backend !== 'postgres') {
      json(res, 200, {
        ok: true,
        backend: config.backend,
        migrations: { applied: 0, pending: 0, ok: true, rows: [] },
      });
      return;
    }
    json(res, 200, {
      ok: true,
      backend: config.backend,
      migrations: await store.migrations(),
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
    try {
      const meta = await store.write(await readRawBody(req), {
        ifMatch: req.headers['if-match'],
      });
      const etag = formatStateEtag(meta);
      json(res, 200, { ok: true, state: meta }, etag ? { ETag: etag } : {});
    } catch (error) {
      if (error instanceof StateServiceError) {
        const currentMeta = error.status === 409 ? await store.meta().catch(() => null) : null;
        json(res, error.status, {
          ok: false,
          code: error.code,
          error: error.message,
          ...(currentMeta ? { state: currentMeta } : {}),
        });
        return;
      }
      throw error;
    }
    return;
  }

  json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'Use GET or PUT for /state.' });
}

function storageSummary(config) {
  if (config.backend === 'postgres') {
    return {
      backend: 'postgres',
      migrate: config.migrate,
      rls: config.rls,
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

export async function startStateService({ env = process.env, log, pgPool } = {}) {
  const logger = createLogger({ env, service: 'signal-state-service', sink: log ?? console.log });
  const config = createStateServiceConfig(env);
  const store = await createStateStore(config, { pgPool });
  await store.init();
  const server = createStateServiceServer(config, store);
  await listen(server, config.port, config.host);
  logger.info('listening', { host: config.host, port: config.port });
  if (config.backend === 'postgres') {
    logger.info('storage', { backend: 'postgres', backupTable: config.backupTable, rls: config.rls, stateTable: config.stateTable });
  } else {
    logger.info('storage', { backend: 'file', backupDir: config.backupDir, stateFile: config.stateFile });
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
    createLogger({ service: 'signal-state-service', sink: console.error }).error('fatal', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
