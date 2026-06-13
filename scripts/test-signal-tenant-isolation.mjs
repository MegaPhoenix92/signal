#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  bootstrapState,
  doctor,
  loadState,
  registerTenantWorkspace,
  saveState,
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

test('tenant scope fails closed on records with missing tenantId and doctor reports orphans', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-tenant-scope-fail-closed-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const tenantB = await registerTenant(statePath, {
    adminEmail: 'scope.admin@epsilon.example',
    domain: 'epsilon.example',
    name: 'Epsilon Labs',
  });
  const state = await loadState({ statePath });
  state.webhookEvents = [
    ...(state.webhookEvents ?? []),
    {
      id: 'wh_orphan_missing_tenant',
      provider: 'stripe',
      eventType: 'invoice.paid',
      accepted: true,
      receivedAt: '2026-06-03T00:07:00.000Z',
      status: 200,
    },
    {
      id: 'wh_orphan_unknown_tenant',
      provider: 'gmail',
      eventType: 'history',
      accepted: false,
      receivedAt: '2026-06-03T00:08:00.000Z',
      status: 403,
      tenantId: 'tenant_missing',
    },
  ];
  state.users = [
    ...(state.users ?? []),
    {
      id: 'usr_tenant_admin_only',
      tenantId: 'tenant_demo',
      name: 'Demo Tenant Admin',
      email: 'demo.admin@acme.example',
      role: 'admin',
      status: 'active',
    },
  ];
  state.memberships = [
    ...(state.memberships ?? []),
    {
      id: 'mem_tenant_demo_usr_tenant_admin_only',
      tenantId: 'tenant_demo',
      userId: 'usr_tenant_admin_only',
      role: 'admin',
      team: 'ops',
      status: 'active',
      createdAt: '2026-06-03T00:00:00.000Z',
      createdByUserId: 'usr_admin',
    },
  ];
  state.accountRecommendations = [
    ...(state.accountRecommendations ?? []),
    {
      id: 'rec_orphan_missing_tenant',
      account: 'Orphan Account',
      accountId: 'acct_orphan',
      ownerUserId: 'usr_tenant_admin_only',
      title: 'orphan recommendation',
      rationale: 'test',
      strategy: 'test',
      priority: 'low',
      status: 'open',
      evidenceSignalIds: [],
      evidenceActionIds: [],
      stakeholderIds: [],
    },
  ];
  await saveState(state, { statePath });

  const scoped = scopeStateForActor(state, tenantB.actor.id);
  assert.equal(scoped.webhookEvents.some((event) => event.id === 'wh_orphan_missing_tenant'), false);
  assert.equal(scoped.webhookEvents.some((event) => event.id === 'wh_orphan_unknown_tenant'), false);
  assert.equal(scoped.webhookEvents.some((event) => event.id === 'wh_seed_stripe_accepted'), false);
  assert.equal(scoped.accountRecommendations.some((item) => item.id === 'rec_orphan_missing_tenant'), false);

  const tenantAdminScoped = scopeStateForActor(state, 'usr_tenant_admin_only');
  assert.equal(tenantAdminScoped.accountRecommendations.some((item) => item.id === 'rec_orphan_missing_tenant'), false);

  const report = doctor(state);
  const tenantScopedCheck = report.checks.find((check) => check.id === 'tenant_scoped_records');
  assert(tenantScopedCheck);
  assert.equal(tenantScopedCheck.ok, false);
  assert.equal(tenantScopedCheck.details?.orphans?.length, 3);
});
