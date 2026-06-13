import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  clientExposureSecretPaths,
  redactClientStateSecrets,
} from './signal-state.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seedPath = path.join(rootDir, 'data', 'sample-seed.json');

test('sample seed does not expose pending invite claim codes to clients', async () => {
  const seed = JSON.parse(await fs.readFile(seedPath, 'utf8'));
  const redacted = redactClientStateSecrets(seed);
  assert.equal(clientExposureSecretPaths(redacted).length, 0);
  assert(!JSON.stringify(redacted).includes('local-rowan-success'));
  assert(!JSON.stringify(redacted).includes('local-priya-product'));
});

test('client redaction keeps claimed invite digests', async () => {
  const seed = JSON.parse(await fs.readFile(seedPath, 'utf8'));
  const redacted = redactClientStateSecrets(seed);
  const acceptedInvite = (redacted.invites ?? []).find((invite) => invite.id === 'inv_priya_product');
  assert.equal(acceptedInvite?.claimCode, 'claimed-ae86595c37b96c046855c25b');
  assert.equal(acceptedInvite?.claimCodeDigest, 'ae86595c37b96c046855c25b');
});