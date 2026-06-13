import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  listProviderCredentialRecords,
  loadProviderCredential,
  rotateProviderCredentialVault,
  storeProviderCredential,
  verifyProviderCredentialVault,
} from './signal-token-vault.mjs';

test('token vault supports legacy keys, keyring decrypt, and rotation', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-token-vault-'));
  const vaultPath = path.join(tempDir, 'vault.json');
  const legacyEnv = { SIGNAL_TOKEN_ENCRYPTION_KEY: 'legacy-token-key' };
  const keyringEnv = { SIGNAL_TOKEN_ENCRYPTION_KEYS: 'v2:new-token-key,v1:legacy-token-key' };
  const newestOnlyEnv = { SIGNAL_TOKEN_ENCRYPTION_KEYS: 'v2:new-token-key' };

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
