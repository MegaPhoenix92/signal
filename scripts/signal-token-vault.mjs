import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  refreshOAuthTokens,
} from './signal-oauth-provider.mjs';

export class TokenVaultError extends Error {
  constructor(message, { code = 'TOKEN_VAULT_ERROR', status = 400, details = {} } = {}) {
    super(message);
    this.name = 'TokenVaultError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultVaultPath = path.join(rootDir, 'data', 'signal-token-vault.json');
const cipherAlgorithm = 'aes-256-gcm';
const defaultRefreshSkewMs = 5 * 60 * 1000;
const MIN_PASSPHRASE_LENGTH = 16;
const RAW_KEY_BYTES = 32;
const LEGACY_KDF = 'sha256-v1';
const HKDF_KDF = 'hkdf-v1';
const RAW_KDF = 'raw-v1';
const HKDF_INFO = 'signal-token-vault-v1';

export function resolveTokenVaultPath(vaultPath = process.env.SIGNAL_TOKEN_VAULT) {
  return vaultPath ? path.resolve(vaultPath) : defaultVaultPath;
}

function requireEncryptionMaterial(env = process.env) {
  const value = env.SIGNAL_TOKEN_ENCRYPTION_KEY;
  if (!value) {
    throw new TokenVaultError('SIGNAL_TOKEN_ENCRYPTION_KEY is required to store provider credentials.', {
      code: 'TOKEN_VAULT_KEY_MISSING',
      status: 412,
      details: { requiredEnv: 'SIGNAL_TOKEN_ENCRYPTION_KEY' },
    });
  }
  return value;
}

function keyDigestFromBytes(keyBytes) {
  return crypto.createHash('sha256').update(keyBytes).digest('hex').slice(0, 16);
}

function decodeRawKeyMaterial(material) {
  if (typeof material !== 'string' || !/^[A-Za-z0-9+/=_-]+$/.test(material)) {
    return null;
  }
  for (const encoding of ['base64url', 'base64']) {
    try {
      const decoded = Buffer.from(material, encoding);
      if (decoded.length === RAW_KEY_BYTES) {
        return decoded;
      }
    } catch {
      // Try the next encoding.
    }
  }
  return null;
}

function assertPassphraseLength(material) {
  if (material.length < MIN_PASSPHRASE_LENGTH) {
    throw new TokenVaultError(`SIGNAL_TOKEN_ENCRYPTION_KEY must be at least ${MIN_PASSPHRASE_LENGTH} characters or a base64-encoded 32-byte key.`, {
      code: 'TOKEN_VAULT_KEY_TOO_SHORT',
      status: 412,
      details: { minLength: MIN_PASSPHRASE_LENGTH },
    });
  }
}

function deriveLegacyKeyBytes(material) {
  return crypto.createHash('sha256').update(material, 'utf8').digest();
}

function deriveHkdfKeyBytes(material, saltBase64url) {
  if (!saltBase64url) {
    throw new TokenVaultError('Token vault HKDF requires a per-vault salt.', {
      code: 'TOKEN_VAULT_KDF_SALT_MISSING',
      status: 412,
    });
  }
  const salt = Buffer.from(saltBase64url, 'base64url');
  const ikm = Buffer.isBuffer(material) ? material : Buffer.from(material, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, HKDF_INFO, RAW_KEY_BYTES));
}

function resolveKeyDerivation(material, { kdf = HKDF_KDF, salt = null } = {}) {
  const rawKey = decodeRawKeyMaterial(material);
  if (rawKey) {
    return {
      digest: keyDigestFromBytes(rawKey),
      kdf: RAW_KDF,
      key: rawKey,
      material,
    };
  }
  assertPassphraseLength(material);
  if (kdf === LEGACY_KDF) {
    const key = deriveLegacyKeyBytes(material);
    return {
      digest: keyDigestFromBytes(key),
      kdf: LEGACY_KDF,
      key,
      material,
    };
  }
  const key = deriveHkdfKeyBytes(material, salt);
  return {
    digest: keyDigestFromBytes(key),
    kdf: HKDF_KDF,
    key,
    material,
  };
}

function parseKeyring(env = process.env) {
  const configured = env.SIGNAL_TOKEN_ENCRYPTION_KEYS;
  if (!configured) {
    const material = requireEncryptionMaterial(env);
    return [{
      id: 'v1',
      material,
    }];
  }
  const keys = configured
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf(':');
      if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
        throw new TokenVaultError('SIGNAL_TOKEN_ENCRYPTION_KEYS entries must use <version>:<key> format.', {
          code: 'TOKEN_VAULT_KEYRING_INVALID',
          status: 412,
        });
      }
      const id = entry.slice(0, separatorIndex).trim();
      const material = entry.slice(separatorIndex + 1);
      if (!/^[A-Za-z0-9_.-]{1,40}$/.test(id)) {
        throw new TokenVaultError(`Invalid token vault key id: ${id}`, {
          code: 'TOKEN_VAULT_KEY_ID_INVALID',
          status: 412,
          details: { id },
        });
      }
      return {
        id,
        material,
      };
    });
  const ids = new Set(keys.map((key) => key.id));
  if (keys.length === 0 || ids.size !== keys.length) {
    throw new TokenVaultError('SIGNAL_TOKEN_ENCRYPTION_KEYS must include unique key ids.', {
      code: 'TOKEN_VAULT_KEYRING_INVALID',
      status: 412,
    });
  }
  return keys;
}

function currentKey(env = process.env, vaultMeta = null) {
  const entry = parseKeyring(env)[0];
  return {
    id: entry.id,
    ...resolveKeyDerivation(entry.material, {
      kdf: HKDF_KDF,
      salt: vaultMeta?.kdfSalt ?? null,
    }),
  };
}

function keyDigest(env = process.env, vaultMeta = null) {
  return currentKey(env, vaultMeta).digest;
}

function ensureVaultCryptoMeta(vault) {
  vault.meta = vault.meta ?? {};
  if (!vault.meta.kdfSalt) {
    vault.meta.kdfSalt = crypto.randomBytes(16).toString('base64url');
    vault.meta.kdfVersion = HKDF_KDF;
  }
  if (!Number.isFinite(vault.meta.encryptionCounter)) {
    vault.meta.encryptionCounter = 0;
  }
  return vault;
}

function nextEncryptionIv() {
  return crypto.randomBytes(12);
}

function deriveKeyForEncryptedRecord(entry, encrypted, vaultMeta) {
  const kdf = encrypted?.kdf ?? LEGACY_KDF;
  return resolveKeyDerivation(entry.material, {
    kdf,
    salt: kdf === HKDF_KDF ? vaultMeta?.kdfSalt ?? null : null,
  });
}

function credentialDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 24);
}

function nowIso() {
  return new Date().toISOString();
}

function expiryFromResponse(response, issuedAtMs = Date.now()) {
  const seconds = Number(response.expires_in);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(issuedAtMs + seconds * 1000).toISOString();
}

function isExpiredOrNearExpiry(expiresAt, { nowMs = Date.now(), skewMs = defaultRefreshSkewMs } = {}) {
  if (!expiresAt) {
    return false;
  }
  const expiresMs = Date.parse(expiresAt);
  return Number.isFinite(expiresMs) && expiresMs <= nowMs + skewMs;
}

function encryptJson(value, { env = process.env, vault } = {}) {
  ensureVaultCryptoMeta(vault);
  const key = currentKey(env, vault.meta);
  const iv = nextEncryptionIv();
  const cipher = crypto.createCipheriv(cipherAlgorithm, key.key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    algorithm: 'A256GCM',
    ciphertext: ciphertext.toString('base64url'),
    encryptedAt: nowIso(),
    iv: iv.toString('base64url'),
    kdf: key.kdf,
    keyDigest: key.digest,
    keyId: key.id,
    tag: tag.toString('base64url'),
  };
}

export function decryptVaultPayload(encrypted, { env = process.env, vaultMeta = null } = {}) {
  const keyring = parseKeyring(env);
  const candidates = encrypted?.keyId
    ? keyring.filter((key) => key.id === encrypted.keyId)
    : [
      ...keyring.filter((key) => encrypted?.keyDigest && deriveKeyForEncryptedRecord(key, encrypted, vaultMeta).digest === encrypted.keyDigest),
      ...keyring.filter((key) => !encrypted?.keyDigest || deriveKeyForEncryptedRecord(key, encrypted, vaultMeta).digest !== encrypted.keyDigest),
    ];
  if (candidates.length === 0) {
    throw new TokenVaultError('Provider credential record references an unknown token vault key.', {
      code: 'TOKEN_VAULT_KEY_NOT_FOUND',
      status: 401,
      details: { keyId: encrypted?.keyId ?? null },
    });
  }
  let lastError = null;
  for (const entry of candidates) {
    try {
      const derived = deriveKeyForEncryptedRecord(entry, encrypted, vaultMeta);
      const decipher = crypto.createDecipheriv(cipherAlgorithm, derived.key, Buffer.from(encrypted.iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, 'base64url')),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString('utf8'));
    } catch (error) {
      lastError = error;
    }
  }
  try {
    throw lastError;
  } catch (error) {
    throw new TokenVaultError('Unable to decrypt provider credential record.', {
      code: 'TOKEN_VAULT_DECRYPT_FAILED',
      status: 401,
      details: { reason: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function readVault(vaultPath) {
  try {
    return JSON.parse(await fs.readFile(vaultPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        meta: {
          schemaVersion: 1,
          createdAt: nowIso(),
          localOnly: true,
        },
        records: [],
      };
    }
    throw error;
  }
}

async function writeVault(vaultPath, vault) {
  await fs.mkdir(path.dirname(vaultPath), { recursive: true });
  vault.meta = {
    ...(vault.meta ?? {}),
    localOnly: true,
    schemaVersion: 1,
    updatedAt: nowIso(),
  };
  await fs.writeFile(vaultPath, `${JSON.stringify(vault, null, 2)}\n`);
}

function findCredentialRecord(vault, { credentialVaultRef, mailboxId, provider }) {
  const expectedRecordId = credentialVaultRef ?? `cred_${provider}_${mailboxId}`;
  return (vault.records ?? []).find((candidate) =>
    candidate.id === expectedRecordId ||
    (!credentialVaultRef && candidate.mailboxId === mailboxId && candidate.provider === provider && candidate.status === 'active'));
}

function assertRecordUsable(record, { credentialVaultRef, mailboxId, provider }) {
  const expectedRecordId = credentialVaultRef ?? `cred_${provider}_${mailboxId}`;
  if (!record) {
    throw new TokenVaultError(`No provider credential record is available for ${provider} mailbox ${mailboxId}.`, {
      code: 'TOKEN_VAULT_RECORD_MISSING',
      status: 404,
      details: { credentialVaultRef: expectedRecordId, mailboxId, provider },
    });
  }
  if (record.mailboxId !== mailboxId || record.provider !== provider) {
    throw new TokenVaultError('Provider credential record does not match the requested mailbox.', {
      code: 'TOKEN_VAULT_RECORD_MISMATCH',
      status: 409,
      details: { credentialVaultRef: record.id, mailboxId, provider },
    });
  }
  if (record.status !== 'active') {
    throw new TokenVaultError(`Provider credential record is not active: ${record.id}.`, {
      code: 'TOKEN_VAULT_RECORD_INACTIVE',
      status: 409,
      details: { credentialVaultRef: record.id, status: record.status },
    });
  }
}

function credentialFromRecord(record, payload, { refreshedAt = null } = {}) {
  const response = payload.response ?? {};
  if (!response.access_token) {
    throw new TokenVaultError(`Provider credential record does not contain an access token: ${record.id}.`, {
      code: 'TOKEN_VAULT_ACCESS_TOKEN_MISSING',
      status: 409,
      details: { credentialVaultRef: record.id, refreshAvailable: record.refreshAvailable },
    });
  }

  return {
    accessToken: response.access_token,
    digest: record.digest,
    expiresAt: record.expiresAt ?? null,
    id: record.id,
    mailboxId: record.mailboxId,
    ownerUserId: record.ownerUserId,
    provider: record.provider,
    refreshedAt,
    refreshAvailable: Boolean(record.refreshAvailable),
    scopeCount: record.scopeCount ?? 0,
    status: record.status,
    tokenType: response.token_type ?? 'Bearer',
  };
}

async function refreshCredentialRecord({
  env = process.env,
  fetchImpl = globalThis.fetch,
  record,
  payload,
  vault,
  vaultPath,
} = {}) {
  const existingResponse = payload.response ?? {};
  if (!existingResponse.refresh_token) {
    throw new TokenVaultError(`Provider credential record cannot be refreshed without a refresh token: ${record.id}.`, {
      code: 'TOKEN_VAULT_REFRESH_TOKEN_MISSING',
      status: 409,
      details: { credentialVaultRef: record.id, provider: record.provider },
    });
  }

  const refresh = await refreshOAuthTokens({
    env,
    fetchImpl,
    provider: record.provider,
    refreshToken: existingResponse.refresh_token,
  });
  const refreshedAtMs = Date.parse(refresh.refreshedAt);
  const mergedResponse = {
    ...existingResponse,
    ...refresh.response,
    refresh_token: refresh.response.refresh_token ?? existingResponse.refresh_token,
  };
  const refreshedPayload = {
    ...payload,
    response: mergedResponse,
    refreshedAt: refresh.refreshedAt,
  };
  const refreshedRecord = {
    ...record,
    digest: credentialDigest(mergedResponse),
    expiresAt: expiryFromResponse(mergedResponse, Number.isFinite(refreshedAtMs) ? refreshedAtMs : Date.now()),
    refreshAvailable: Boolean(mergedResponse.refresh_token),
    updatedAt: refresh.refreshedAt,
    encrypted: encryptJson(refreshedPayload, { env, vault }),
  };

  const existingIndex = (vault.records ?? []).findIndex((candidate) => candidate.id === record.id);
  if (existingIndex < 0) {
    throw new TokenVaultError(`Provider credential record disappeared during refresh: ${record.id}.`, {
      code: 'TOKEN_VAULT_RECORD_MISSING',
      status: 404,
      details: { credentialVaultRef: record.id },
    });
  }
  vault.records[existingIndex] = refreshedRecord;
  await writeVault(vaultPath, vault);

  return {
    payload: refreshedPayload,
    record: refreshedRecord,
    refreshedAt: refresh.refreshedAt,
  };
}

export async function storeProviderCredential({
  env = process.env,
  mailboxId,
  ownerUserId,
  provider,
  scopes = [],
  tenantId,
  response,
  vaultPath = resolveTokenVaultPath(env.SIGNAL_TOKEN_VAULT),
} = {}) {
  if (!mailboxId || !ownerUserId || !provider || !tenantId || !response) {
    throw new TokenVaultError('Mailbox, owner, provider, tenant, and provider response are required for credential storage.', {
      code: 'TOKEN_VAULT_ARG_MISSING',
    });
  }

  const resolvedVaultPath = resolveTokenVaultPath(vaultPath);
  const vault = ensureVaultCryptoMeta(await readVault(resolvedVaultPath));
  const recordId = `cred_${provider}_${mailboxId}`;
  const issuedAt = nowIso();
  const record = {
    id: recordId,
    tenantId,
    mailboxId,
    ownerUserId,
    provider,
    status: 'active',
    digest: credentialDigest(response),
    scopeCount: scopes.length,
    expiresAt: expiryFromResponse(response),
    refreshAvailable: Boolean(response.refresh_token),
    idAssertionAvailable: Boolean(response.id_token),
    updatedAt: issuedAt,
    encrypted: encryptJson({
      provider,
      tenantId,
      mailboxId,
      ownerUserId,
      scopes,
      response,
      issuedAt,
    }, { env, vault }),
  };

  const existingIndex = (vault.records ?? []).findIndex((item) => item.id === recordId);
  if (existingIndex >= 0) {
    record.createdAt = vault.records[existingIndex].createdAt ?? issuedAt;
    vault.records[existingIndex] = record;
  } else {
    record.createdAt = issuedAt;
    vault.records = [...(vault.records ?? []), record];
  }

  await writeVault(resolvedVaultPath, vault);

  return {
    digest: record.digest,
    expiresAt: record.expiresAt,
    id: record.id,
    path: resolvedVaultPath,
    refreshAvailable: record.refreshAvailable,
    scopeCount: record.scopeCount,
    status: record.status,
    storedAt: record.updatedAt,
  };
}

export async function listProviderCredentialRecords({ vaultPath = resolveTokenVaultPath(), env = process.env } = {}) {
  const resolvedVaultPath = resolveTokenVaultPath(vaultPath);
  const vault = await readVault(resolvedVaultPath);
  return {
    ok: true,
    path: resolvedVaultPath,
    records: (vault.records ?? []).map((record) => ({
      id: record.id,
      tenantId: record.tenantId,
      mailboxId: record.mailboxId,
      ownerUserId: record.ownerUserId,
      provider: record.provider,
      status: record.status,
      digest: record.digest,
      expiresAt: record.expiresAt,
      refreshAvailable: record.refreshAvailable,
      scopeCount: record.scopeCount,
      updatedAt: record.updatedAt,
      keyMatches: (env.SIGNAL_TOKEN_ENCRYPTION_KEY || env.SIGNAL_TOKEN_ENCRYPTION_KEYS) ? record.encrypted?.keyDigest === keyDigest(env, vault.meta) : null,
      keyId: record.encrypted?.keyId ?? 'v1',
    })),
  };
}

export async function verifyProviderCredentialVault({ vaultPath = resolveTokenVaultPath(), env = process.env } = {}) {
  const resolvedVaultPath = resolveTokenVaultPath(vaultPath);
  const vault = await readVault(resolvedVaultPath);
  const results = [];
  for (const record of vault.records ?? []) {
    try {
      decryptVaultPayload(record.encrypted, { env, vaultMeta: vault.meta });
      results.push({ id: record.id, keyId: record.encrypted?.keyId ?? 'v1', ok: true });
    } catch (error) {
      results.push({
        error: error instanceof Error ? error.message : String(error),
        id: record.id,
        keyId: record.encrypted?.keyId ?? 'v1',
        ok: false,
      });
    }
  }
  return {
    ok: results.every((result) => result.ok),
    path: resolvedVaultPath,
    records: results,
    summary: {
      failed: results.filter((result) => !result.ok).length,
      total: results.length,
    },
  };
}

export async function rotateProviderCredentialVault({ vaultPath = resolveTokenVaultPath(), env = process.env } = {}) {
  const resolvedVaultPath = resolveTokenVaultPath(vaultPath);
  const vault = ensureVaultCryptoMeta(await readVault(resolvedVaultPath));
  const targetKey = currentKey(env, vault.meta);
  let rotated = 0;
  vault.records = await Promise.all((vault.records ?? []).map(async (record) => {
    const payload = decryptVaultPayload(record.encrypted, { env, vaultMeta: vault.meta });
    if (
      record.encrypted?.keyId === targetKey.id &&
      record.encrypted?.keyDigest === targetKey.digest &&
      (record.encrypted?.kdf ?? LEGACY_KDF) === targetKey.kdf
    ) {
      return record;
    }
    rotated += 1;
    return {
      ...record,
      encrypted: encryptJson(payload, { env, vault }),
      rotatedAt: nowIso(),
      updatedAt: nowIso(),
    };
  }));
  await writeVault(resolvedVaultPath, vault);
  return {
    ok: true,
    path: resolvedVaultPath,
    rotated,
    targetKeyId: targetKey.id,
    total: vault.records.length,
  };
}

export async function loadProviderCredential({
  credentialVaultRef,
  env = process.env,
  fetchImpl = globalThis.fetch,
  mailboxId,
  provider,
  refreshExpired = false,
  refreshSkewMs = defaultRefreshSkewMs,
  vaultPath = resolveTokenVaultPath(env.SIGNAL_TOKEN_VAULT),
} = {}) {
  if (!mailboxId || !provider) {
    throw new TokenVaultError('Mailbox and provider are required to load provider credentials.', {
      code: 'TOKEN_VAULT_ARG_MISSING',
      details: { mailboxId, provider },
    });
  }

  const resolvedVaultPath = resolveTokenVaultPath(vaultPath);
  const vault = await readVault(resolvedVaultPath);
  let record = findCredentialRecord(vault, { credentialVaultRef, mailboxId, provider });
  assertRecordUsable(record, { credentialVaultRef, mailboxId, provider });

  let payload = decryptVaultPayload(record.encrypted, { env, vaultMeta: vault.meta });
  let refreshedAt = null;
  if (refreshExpired && isExpiredOrNearExpiry(record.expiresAt, { skewMs: refreshSkewMs })) {
    const refresh = await refreshCredentialRecord({
      env,
      fetchImpl,
      payload,
      record,
      vault,
      vaultPath: resolvedVaultPath,
    });
    record = refresh.record;
    payload = refresh.payload;
    refreshedAt = refresh.refreshedAt;
  }

  return credentialFromRecord(record, payload, { refreshedAt });
}
