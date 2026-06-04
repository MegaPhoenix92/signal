#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const positionals = args.filter((arg) => !arg.startsWith('-'));
const flags = new Set(args.filter((arg) => arg.startsWith('-')));
const command = positionals[0] ?? 'help';
const wantsJson = flags.has('--json');
const dryRun = flags.has('--dry-run');

function flagValue(name) {
  const index = args.findIndex((arg) => arg === name);
  return index >= 0 ? args[index + 1] : undefined;
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 24);
}

function stateServiceUrls(env = process.env) {
  const stateUrl = new URL(env.SIGNAL_STATE_SERVICE_URL ?? 'http://127.0.0.1:8791/state');
  const healthUrl = new URL(stateUrl.href);
  healthUrl.pathname = healthUrl.pathname.replace(/\/state\/?$/, '/health');
  if (healthUrl.pathname === stateUrl.pathname) {
    healthUrl.pathname = '/health';
  }
  return {
    healthUrl: healthUrl.href,
    stateUrl: stateUrl.href,
  };
}

function authHeaders(env = process.env) {
  return env.SIGNAL_STATE_SERVICE_TOKEN ? { Authorization: `Bearer ${env.SIGNAL_STATE_SERVICE_TOKEN}` } : {};
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(payload?.error ?? `State service request failed with ${response.status}`);
    error.status = response.status;
    error.code = payload?.code ?? 'STATE_SERVICE_REQUEST_FAILED';
    throw error;
  }
  return payload;
}

async function requestState(url, env = process.env) {
  const response = await fetch(url, {
    headers: authHeaders(env),
  });
  const text = await response.text();
  if (!response.ok) {
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    const error = new Error(payload.error ?? `State service read failed with ${response.status}`);
    error.status = response.status;
    error.code = payload.code ?? 'STATE_SERVICE_READ_FAILED';
    throw error;
  }
  return text;
}

function parseStateArtifact(raw, source = 'state artifact') {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${source} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object.`);
  }
  return {
    digest: digest(`${JSON.stringify(parsed, null, 2)}\n`),
    parsed,
    raw: `${JSON.stringify(parsed, null, 2)}\n`,
  };
}

function stateSummary(parsed) {
  return {
    auditEvents: parsed.auditEvents?.length ?? 0,
    invitations: parsed.invites?.length ?? 0,
    memberships: parsed.memberships?.length ?? 0,
    schemaVersion: parsed.meta?.schemaVersion ?? parsed.schemaVersion ?? null,
    tenants: parsed.tenants?.length ?? 0,
    users: parsed.users?.length ?? 0,
  };
}

function defaultBackupPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(rootDir, 'data', 'state-service-manual-backups', `signal-state-${stamp}.json`);
}

function emit(value) {
  if (wantsJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === 'string') {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function fail(error) {
  const payload = {
    ok: false,
    code: error.code ?? 'STATE_SERVICE_ADMIN_ERROR',
    error: error instanceof Error ? error.message : String(error),
    status: error.status,
  };
  if (wantsJson) {
    console.error(JSON.stringify(payload, null, 2));
  } else {
    console.error(payload.error);
  }
  process.exit(1);
}

async function commandHealth() {
  const { healthUrl, stateUrl } = stateServiceUrls();
  const health = await requestJson(healthUrl);
  emit(wantsJson ? { ok: true, health, stateUrl } : [
    `State service: ${health.ok ? 'ok' : 'not ok'}`,
    `Storage: ${health.storage?.backend ?? 'unknown'}`,
    `State exists: ${health.state?.exists ? 'yes' : 'no'}`,
    `State URL: ${stateUrl}`,
  ].join('\n'));
}

async function commandBackup() {
  const { healthUrl, stateUrl } = stateServiceUrls();
  const outputPath = path.resolve(process.cwd(), positionals[1] ?? flagValue('--output') ?? defaultBackupPath());
  const [health, raw] = await Promise.all([
    requestJson(healthUrl),
    requestState(stateUrl),
  ]);
  const artifact = parseStateArtifact(raw, 'state service response');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, artifact.raw, { mode: 0o600 });
  emit({
    ok: true,
    backup: {
      bytes: Buffer.byteLength(artifact.raw),
      createdAt: new Date().toISOString(),
      digest: artifact.digest,
      path: outputPath,
      storage: health.storage,
      summary: stateSummary(artifact.parsed),
    },
  });
}

async function commandVerify() {
  const inputPath = path.resolve(process.cwd(), positionals[1] ?? '');
  if (!positionals[1]) {
    throw new Error('Backup file path is required for verify.');
  }
  const raw = await fs.readFile(inputPath, 'utf8');
  const artifact = parseStateArtifact(raw, inputPath);
  emit({
    ok: true,
    backup: {
      bytes: Buffer.byteLength(artifact.raw),
      digest: artifact.digest,
      path: inputPath,
      summary: stateSummary(artifact.parsed),
    },
  });
}

async function commandRestore() {
  const inputPath = path.resolve(process.cwd(), positionals[1] ?? '');
  if (!positionals[1]) {
    throw new Error('Backup file path is required for restore.');
  }
  const { stateUrl } = stateServiceUrls();
  const raw = await fs.readFile(inputPath, 'utf8');
  const artifact = parseStateArtifact(raw, inputPath);
  if (dryRun) {
    emit({
      ok: true,
      dryRun: true,
      restore: {
        digest: artifact.digest,
        path: inputPath,
        stateUrl,
        summary: stateSummary(artifact.parsed),
      },
    });
    return;
  }
  const restored = await requestJson(stateUrl, {
    body: artifact.raw,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    method: 'PUT',
  });
  emit({
    ok: true,
    restore: {
      digest: artifact.digest,
      path: inputPath,
      serviceState: restored.state,
      stateUrl,
      summary: stateSummary(artifact.parsed),
    },
  });
}

async function run() {
  switch (command) {
    case 'health':
      await commandHealth();
      return;
    case 'backup':
      await commandBackup();
      return;
    case 'verify':
      await commandVerify();
      return;
    case 'restore':
      await commandRestore();
      return;
    case 'help':
    case '--help':
    case '-h':
      emit([
        'Signal state-service admin CLI',
        '',
        'Usage: npm run state-service:admin -- <health|backup|verify|restore> [path] [--json] [--dry-run]',
        '',
        'Examples:',
        '  SIGNAL_STATE_SERVICE_URL=http://127.0.0.1:8791/state SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- health',
        '  SIGNAL_STATE_SERVICE_URL=http://127.0.0.1:8791/state SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- backup ./backup.json --json',
        '  SIGNAL_STATE_SERVICE_URL=http://127.0.0.1:8791/state SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- restore ./backup.json --dry-run --json',
        '  SIGNAL_STATE_SERVICE_URL=http://127.0.0.1:8791/state SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- restore ./backup.json --json',
      ].join('\n'));
      return;
    default:
      throw new Error(`Unknown state-service admin command: ${command}`);
  }
}

run().catch(fail);
