import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  decryptVaultPayload,
  listProviderCredentialRecords,
  loadProviderCredential,
  rotateProviderCredentialVault,
  storeProviderCredential,
  verifyProviderCredentialVault,
} from './signal-token-vault.mjs';

function legacySha256Encrypted(payload, material) {
  const key = crypto.createHash('sha256').update(material, 'utf8').digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    algorithm: 'A256GCM',
    ciphertext: ciphertext.toString('base64url'),
    encryptedAt: new Date().toISOString(),
    iv: iv.toString('base64url'),
    keyDigest: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16),
    keyId: 'v1',
    tag: cipher.getAuthTag().toString('base64url'),
  };
}

test('token vault supports legacy keys, keyring decrypt, and rotation', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-token-vault-'));
  const vaultPath = path.join(tempDir, 'vault.json');
  const legacyEnv = { SIGNAL_TOKEN_ENCRYPTION_KEY: 'legacy-token-key' };
  const keyringEnv = { SIGNAL_TOKEN_ENCRYPTION_KEYS: 'v2:new-token-key-value!,v1:legacy-token-key' };
  const newestOnlyEnv = { SIGNAL_TOKEN_ENCRYPTION_KEYS: 'v2:new-token-key-value!' };

  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await storeProviderCredential({
    env: legacyEnv,
    mailboxId: 'mbx_legacy',
    ownerUserId: 'usr_admin',
    provider: 'gmail',
    response: {
      access_token: 'legacy-access-token',
      expires_in: 3600,
      refresh_token: 'legacy-refresh-token',
      token_type: 'Bearer',
    },
    scopes: ['gmail.readonly'],
    tenantId: 'tenant_demo',
    vaultPath,
  });

  const legacyVault = JSON.parse(await fs.readFile(vaultPath, 'utf8'));
  delete legacyVault.records[0].encrypted.keyId;
  await fs.writeFile(vaultPath, `${JSON.stringify(legacyVault, null, 2)}\n`);

  const legacyCredential = await loadProviderCredential({
    env: legacyEnv,
    mailboxId: 'mbx_legacy',
    provider: 'gmail',
    vaultPath,
  });
  assert.equal(legacyCredential.accessToken, 'legacy-access-token');

  const keyringCredential = await loadProviderCredential({
    env: keyringEnv,
    mailboxId: 'mbx_legacy',
    provider: 'gmail',
    vaultPath,
  });
  assert.equal(keyringCredential.accessToken, 'legacy-access-token');

  await storeProviderCredential({
    env: keyringEnv,
    mailboxId: 'mbx_new',
    ownerUserId: 'usr_admin',
    provider: 'outlook',
    response: {
      access_token: 'new-access-token',
      expires_in: 3600,
      refresh_token: 'new-refresh-token',
      token_type: 'Bearer',
    },
    scopes: ['mail.read'],
    tenantId: 'tenant_demo',
    vaultPath,
  });

  const listed = await listProviderCredentialRecords({ env: keyringEnv, vaultPath });
  const newRecord = listed.records.find((record) => record.id === 'cred_outlook_mbx_new');
  assert.equal(newRecord.keyId, 'v2');
  assert.equal(newRecord.keyMatches, true);
  assert.equal((await verifyProviderCredentialVault({ env: keyringEnv, vaultPath })).ok, true);

  const rotated = await rotateProviderCredentialVault({ env: keyringEnv, vaultPath });
  assert.equal(rotated.rotated, 1);
  assert.equal(rotated.targetKeyId, 'v2');

  const rotatedVault = JSON.parse(await fs.readFile(vaultPath, 'utf8'));
  assert(rotatedVault.records.every((record) => record.encrypted.keyId === 'v2'));
  assert.equal((await verifyProviderCredentialVault({ env: newestOnlyEnv, vaultPath })).ok, true);

  const rotatedCredential = await loadProviderCredential({
    env: newestOnlyEnv,
    mailboxId: 'mbx_legacy',
    provider: 'gmail',
    vaultPath,
  });
  assert.equal(rotatedCredential.accessToken, 'legacy-access-token');
});

test('token vault rejects short passphrase material and accepts raw 32-byte keys', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-token-vault-material-'));
  const vaultPath = path.join(tempDir, 'vault.json');
  const rawKey = crypto.randomBytes(32).toString('base64url');
  const rawEnv = { SIGNAL_TOKEN_ENCRYPTION_KEY: rawKey };

  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await assert.rejects(
    () => storeProviderCredential({
      env: { SIGNAL_TOKEN_ENCRYPTION_KEY: 'too-short' },
      mailboxId: 'mbx_short',
      ownerUserId: 'usr_admin',
      provider: 'gmail',
      response: {
        access_token: 'short-access-token',
        expires_in: 3600,
        refresh_token: 'short-refresh-token',
        token_type: 'Bearer',
      },
      scopes: ['gmail.readonly'],
      tenantId: 'tenant_demo',
      vaultPath,
    }),
    (error) => error.code === 'TOKEN_VAULT_KEY_TOO_SHORT',
  );

  await storeProviderCredential({
    env: rawEnv,
    mailboxId: 'mbx_raw',
    ownerUserId: 'usr_admin',
    provider: 'gmail',
    response: {
      access_token: 'raw-access-token',
      expires_in: 3600,
      refresh_token: 'raw-refresh-token',
      token_type: 'Bearer',
    },
    scopes: ['gmail.readonly'],
    tenantId: 'tenant_demo',
    vaultPath,
  });

  const rawCredential = await loadProviderCredential({
    env: rawEnv,
    mailboxId: 'mbx_raw',
    provider: 'gmail',
    vaultPath,
  });
  assert.equal(rawCredential.accessToken, 'raw-access-token');

  const rawVault = JSON.parse(await fs.readFile(vaultPath, 'utf8'));
  assert.equal(rawVault.records[0].encrypted.kdf, 'raw-v1');
});

test('token vault decrypts legacy sha256-v1 records and increments hkdf encryption counters', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-token-vault-kdf-'));
  const vaultPath = path.join(tempDir, 'vault.json');
  const legacyEnv = { SIGNAL_TOKEN_ENCRYPTION_KEY: 'legacy-token-key' };
  const payload = {
    provider: 'gmail',
    tenantId: 'tenant_demo',
    mailboxId: 'mbx_sha256',
    ownerUserId: 'usr_admin',
    scopes: ['gmail.readonly'],
    response: {
      access_token: 'sha256-access-token',
      expires_in: 3600,
      refresh_token: 'sha256-refresh-token',
      token_type: 'Bearer',
    },
    issuedAt: new Date().toISOString(),
  };

  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await fs.writeFile(vaultPath, `${JSON.stringify({
    meta: {
      createdAt: new Date().toISOString(),
      localOnly: true,
      schemaVersion: 1,
    },
    records: [{
      id: 'cred_gmail_mbx_sha256',
      tenantId: 'tenant_demo',
      mailboxId: 'mbx_sha256',
      ownerUserId: 'usr_admin',
      provider: 'gmail',
      status: 'active',
      digest: 'legacy-digest',
      scopeCount: 1,
      refreshAvailable: true,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      encrypted: legacySha256Encrypted(payload, legacyEnv.SIGNAL_TOKEN_ENCRYPTION_KEY),
    }],
  }, null, 2)}\n`);

  const legacyCredential = await loadProviderCredential({
    env: legacyEnv,
    mailboxId: 'mbx_sha256',
    provider: 'gmail',
    vaultPath,
  });
  assert.equal(legacyCredential.accessToken, 'sha256-access-token');

  await storeProviderCredential({
    env: legacyEnv,
    mailboxId: 'mbx_counter_a',
    ownerUserId: 'usr_admin',
    provider: 'gmail',
    response: {
      access_token: 'counter-access-a',
      expires_in: 3600,
      refresh_token: 'counter-refresh-a',
      token_type: 'Bearer',
    },
    scopes: ['gmail.readonly'],
    tenantId: 'tenant_demo',
    vaultPath,
  });
  await storeProviderCredential({
    env: legacyEnv,
    mailboxId: 'mbx_counter_b',
    ownerUserId: 'usr_admin',
    provider: 'outlook',
    response: {
      access_token: 'counter-access-b',
      expires_in: 3600,
      refresh_token: 'counter-refresh-b',
      token_type: 'Bearer',
    },
    scopes: ['mail.read'],
    tenantId: 'tenant_demo',
    vaultPath,
  });

  const hkdfVault = JSON.parse(await fs.readFile(vaultPath, 'utf8'));
  assert.equal(hkdfVault.meta.kdfVersion, 'hkdf-v1');
  assert.ok(hkdfVault.meta.kdfSalt);
  const hkdfRecords = hkdfVault.records.filter((record) => record.encrypted.kdf === 'hkdf-v1');
  assert.equal(hkdfRecords.length, 2);
  assert.notEqual(hkdfRecords[0].encrypted.iv, hkdfRecords[1].encrypted.iv);

  const decrypted = decryptVaultPayload(hkdfRecords[1].encrypted, {
    env: legacyEnv,
    vaultMeta: hkdfVault.meta,
  });
  assert.equal(decrypted.response.access_token, 'counter-access-b');
});