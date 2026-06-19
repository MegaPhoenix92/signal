import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertApiSecurityConfig } from './signal-api-auth.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const composeApiEnv = {
  SIGNAL_API_CORS_ORIGINS: 'http://localhost:5173',
  SIGNAL_API_HOST: '0.0.0.0',
  SIGNAL_API_PORT: '8787',
  SIGNAL_BACKEND_MODE: 'external-service',
  SIGNAL_COOKIE_SECURE: 'true',
  SIGNAL_OAUTH_ACTOR: 'usr_system_oauth',
  SIGNAL_OAUTH_STATE_KEY: 'signal-compose-oauth-state-key',
  SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
  SIGNAL_SESSION_SECRET: 'signal-compose-session-secret-32chars',
  SIGNAL_STATE_SERVICE_TOKEN: 'local-compose-state-token',
  SIGNAL_STATE_SERVICE_URL: 'http://state-service:8791/state',
  SIGNAL_WEBHOOK_ACTOR: 'usr_system_webhook',
};

test('pg is a runtime dependency for production images', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'));
  assert.ok(packageJson.dependencies?.pg, 'pg must be listed under dependencies');
  assert.equal(packageJson.devDependencies?.pg, undefined, 'pg must not remain under devDependencies');
});

test('docker compose api config passes production security assertions', () => {
  assert.doesNotThrow(() => assertApiSecurityConfig(composeApiEnv));
});

test('production web bundle inlines VITE_SIGNAL_API_URL', async () => {
  const distDir = path.join(rootDir, 'dist');
  const entries = await fs.readdir(distDir, { withFileTypes: true });
  const assetPaths = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.js')) {
      assetPaths.push(path.join(distDir, entry.name));
    }
    if (entry.isDirectory()) {
      const nested = await fs.readdir(path.join(distDir, entry.name), { withFileTypes: true });
      for (const nestedEntry of nested) {
        if (nestedEntry.isFile() && nestedEntry.name.endsWith('.js')) {
          assetPaths.push(path.join(distDir, entry.name, nestedEntry.name));
        }
      }
    }
  }

  const configuredUrl = process.env.VITE_SIGNAL_API_URL ?? 'http://127.0.0.1:8787';
  const bundles = await Promise.all(assetPaths.map((assetPath) => fs.readFile(assetPath, 'utf8')));
  assert.ok(
    bundles.some((bundle) => bundle.includes(configuredUrl)),
    `built assets must inline VITE_SIGNAL_API_URL (${configuredUrl})`,
  );
  assert.ok(
    bundles.every((bundle) => !bundle.includes('VITE_SIGNAL_API_URL is required in production builds.')),
    'built assets must not ship the production-build throw message',
  );
});

test('Dockerfile declares VITE_SIGNAL_API_URL for production web builds', async () => {
  const dockerfile = await fs.readFile(path.join(rootDir, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /ARG VITE_SIGNAL_API_URL/);
  assert.match(dockerfile, /ENV VITE_SIGNAL_API_URL=\$VITE_SIGNAL_API_URL/);
});