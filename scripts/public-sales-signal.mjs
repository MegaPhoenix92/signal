import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLIC_SALES_SIGNAL_JOB = 'public_sales_signal';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultPublicStorePath = path.join(rootDir, 'data', 'public-sales-signal.json');
export const defaultPublicFixturePath = path.join(rootDir, 'data', 'public-sales-signal-fixture.json');

export function resolvePublicStorePath({ env = process.env, storePath } = {}) {
  return path.resolve(storePath ?? env.SIGNAL_PUBLIC_SALES_SIGNAL_STATE ?? defaultPublicStorePath);
}

export function resolvePublicFixturePath({ env = process.env, fixturePath } = {}) {
  return path.resolve(fixturePath ?? env.SIGNAL_PUBLIC_SALES_SIGNAL_FIXTURE ?? defaultPublicFixturePath);
}

function emptyStore() {
  return { research: [], audit: [] };
}

export async function loadPublicResearchStore({ env = process.env, storePath } = {}) {
  const resolved = resolvePublicStorePath({ env, storePath });
  try {
    const parsed = JSON.parse(await fs.readFile(resolved, 'utf8'));
    return {
      research: Array.isArray(parsed.research) ? parsed.research : [],
      audit: Array.isArray(parsed.audit) ? parsed.audit : [],
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return emptyStore();
    }
    throw error;
  }
}

export async function savePublicResearchStore(store, { env = process.env, storePath } = {}) {
  const resolved = resolvePublicStorePath({ env, storePath });
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const normalized = {
    research: Array.isArray(store?.research) ? store.research : [],
    audit: Array.isArray(store?.audit) ? store.audit : [],
  };
  await fs.writeFile(resolved, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export async function loadPublicFeedFixture({ env = process.env, fixturePath } = {}) {
  const resolved = resolvePublicFixturePath({ env, fixturePath });
  const parsed = JSON.parse(await fs.readFile(resolved, 'utf8'));
  if (!parsed?.source || !String(parsed.source).startsWith('fixture:')) {
    throw new Error('public_sales_signal fixture must declare a fixture: source');
  }
  if (!Array.isArray(parsed.items) || parsed.items.length < 1) {
    throw new Error('public_sales_signal fixture must include at least one public research item');
  }
  return parsed;
}

function publicRowId(source, itemId) {
  return `pub_${crypto.createHash('sha256').update(`${source}:${itemId}`).digest('hex').slice(0, 16)}`;
}

export function queryPublicResearch({ publicStore, tenantState: _tenantState } = {}) {
  return [...(publicStore?.research ?? [])];
}

export async function runPublicSalesSignalJob({
  env = process.env,
  fixturePath,
  storePath,
  tenantState: _tenantState,
  now = new Date().toISOString(),
} = {}) {
  const fixture = await loadPublicFeedFixture({ env, fixturePath });
  const store = await loadPublicResearchStore({ env, storePath });
  const timestamp = now;
  let written = 0;

  for (const item of fixture.items) {
    const id = item.id || publicRowId(fixture.source, JSON.stringify(item));
    const existing = store.research.find((row) => row.id === id);
    const row = {
      id,
      source: fixture.source,
      type: item.type ?? 'category_intent',
      category: item.category ?? null,
      intent: item.intent ?? null,
      summary: item.summary ?? '',
      score: item.score ?? null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    if (existing) {
      Object.assign(existing, row);
    } else {
      store.research.push(row);
    }
    written += 1;
  }

  store.audit.push({
    id: `aud_${crypto.createHash('sha256').update(`${fixture.source}:${timestamp}:${written}`).digest('hex').slice(0, 16)}`,
    job: PUBLIC_SALES_SIGNAL_JOB,
    source: fixture.source,
    timestamp,
    written,
  });

  const saved = await savePublicResearchStore(store, { env, storePath });
  return {
    ok: written >= 1,
    written,
    source: fixture.source,
    storePath: resolvePublicStorePath({ env, storePath }),
    researchCount: saved.research.length,
  };
}
