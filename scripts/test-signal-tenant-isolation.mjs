#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  bootstrapState,
  loadState,
  registerTenantWorkspace,
  setUserRole,
  scopeStateForActor,
  switchSession,
} from './signal-state.mjs';

async function registerTenant(statePath, { name, domain, adminEmail }) {
  return registerTenantWorkspace({
    adminEmail,
    adminName: `${name} Owner`,
    domain,
    name,
    planId: 'plan_team',
  }, { statePath });
}

test('tenant admin cannot mutate users in another tenant', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-tenant-isolation-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const tenantB = await registerTenant(statePath, {
    adminEmail: 'owner@beta.example',
    domain: 'beta.example',
    name: 'Beta Labs',
  });

  await assert.rejects(
    () => setUserRole('usr_sales', 'admin', { actorUserId: tenantB.actor.id, statePath }),
    (error) => error.code === 'FORBIDDEN',
  );
});

test('session switch rejects cross-tenant impersonation for local admins', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-session-switch-tenant-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const tenantB = await registerTenant(statePath, {
    adminEmail: 'gamma.owner@gamma.example',
    domain: 'gamma.example',
    name: 'Gamma Labs',
  });

  await assert.rejects(
    () => switchSession('usr_sales', { actorUserId: tenantB.actor.id, statePath }),
    (error) => error.code === 'FORBIDDEN',
  );
});

test('self-service registration creates an isolated tenant admin', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-tenant-create-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const created = await registerTenant(statePath, {
    adminEmail: 'delta.owner@delta.example',
    domain: 'delta.example',
    name: 'Delta Labs',
  });

  assert.equal(created.action, 'tenants.register');
  assert.notEqual(created.actor.tenantId, 'tenant_demo');
  assert.equal(created.actor.role, 'admin');
});

test('member state scope hides same-tenant peer mailbox source and signal records', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-member-state-scope-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const state = await loadState({ statePath });
  const productState = scopeStateForActor(state, 'usr_product');
  const adminState = scopeStateForActor(state, 'usr_admin');

  assert(productState.mailboxes.some((mailbox) => mailbox.id === 'mbx_gmail_product'), 'member should retain owned mailbox records');
  assert(productState.sourceMessages.some((message) => message.mailboxId === 'mbx_gmail_product'), 'member should retain owned source snippets');
  assert(productState.signals.some((signal) => signal.id === 'sig_product_001'), 'member should retain owned signal records');

  assert.equal(productState.mailboxes.some((mailbox) => mailbox.ownerUserId === 'usr_sales'), false, 'member must not receive peer-owned mailboxes');
  assert.equal(productState.sourceMessages.some((message) => message.mailboxId === 'mbx_gmail_sales'), false, 'member must not receive peer-owned source snippets');
  assert.equal(productState.signals.some((signal) => signal.ownerUserId === 'usr_sales'), false, 'member must not receive peer-owned signals');
  assert.equal(productState.users.find((user) => user.id === 'usr_product')?.email, 'priya@acme.example');
  assert.equal(productState.users.find((user) => user.id === 'usr_sales')?.email, null);
  assert.equal(productState.users.find((user) => user.id === 'usr_sales')?.name, 'Mia Chen');

  assert(adminState.mailboxes.some((mailbox) => mailbox.ownerUserId === 'usr_sales'), 'admin should retain tenant-wide mailbox visibility');
  assert(adminState.sourceMessages.some((message) => message.mailboxId === 'mbx_gmail_sales'), 'admin should retain tenant-wide source visibility');
  assert(adminState.signals.some((signal) => signal.ownerUserId === 'usr_sales'), 'admin should retain tenant-wide signal visibility');
  assert.equal(adminState.users.find((user) => user.id === 'usr_sales')?.email, 'mia@acme.example');
});
