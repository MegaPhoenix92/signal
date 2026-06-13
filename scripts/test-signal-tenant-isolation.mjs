#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  bootstrapState,
  createBillingOverride,
  doctor,
  handlePaymentWebhook,
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

test('tenant scope isolates billing overrides, invoices, payment events, entitlements, and billing jobs', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-tenant-billing-scope-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const tenantB = await registerTenant(statePath, {
    adminEmail: 'billing.owner@zeta.example',
    domain: 'zeta.example',
    name: 'Zeta Billing',
  });

  await handlePaymentWebhook('invoice.open', {
    amountDueCents: 4900,
    providerInvoiceId: 'in_demo_billing_scope',
    subscriptionId: 'sub_demo',
  }, { actorUserId: 'usr_admin', statePath });

  let state = await loadState({ statePath });
  const tenantBSubscription = state.subscriptions.find((subscription) => subscription.tenantId === tenantB.actor.tenantId);
  assert(tenantBSubscription, 'registered tenant should create a tenant-local subscription');

  await handlePaymentWebhook('invoice.payment_failed', {
    amountDueCents: 8900,
    providerInvoiceId: 'in_zeta_billing_scope',
    subscriptionId: tenantBSubscription.id,
  }, { actorUserId: 'usr_admin', statePath });
  const tenantBOverride = await createBillingOverride(tenantB.actor.tenantId, 'support_credit', {
    amountCents: 1000,
    reason: 'Zeta onboarding credit',
  }, { actorUserId: tenantB.actor.id, statePath });

  state = await loadState({ statePath });
  const demoInvoice = state.invoices.find((invoice) => invoice.providerInvoiceId === 'in_demo_billing_scope');
  const tenantBInvoice = state.invoices.find((invoice) => invoice.providerInvoiceId === 'in_zeta_billing_scope');
  assert(demoInvoice, 'demo tenant invoice should exist');
  assert(tenantBInvoice, 'second tenant invoice should exist');

  const tenantBScoped = scopeStateForActor(state, tenantB.actor.id);
  assert(tenantBScoped.billingOverrides.some((override) => override.id === tenantBOverride.details.overrideId), 'tenant admin should see own billing override');
  assert(tenantBScoped.paymentEvents.some((event) => event.invoiceId === tenantBInvoice.id), 'tenant admin should see own payment events');
  assert(tenantBScoped.invoices.some((invoice) => invoice.id === tenantBInvoice.id), 'tenant admin should see own invoices');
  assert(tenantBScoped.entitlements.every((entitlement) => entitlement.tenantId === tenantB.actor.tenantId), 'tenant admin entitlements must stay tenant-local');
  assert(tenantBScoped.jobs.some((job) => job.tenantId === tenantB.actor.tenantId && job.queue === 'billing_webhook'), 'tenant admin should see own billing webhook jobs');

  assert.equal(tenantBScoped.billingOverrides.some((override) => override.tenantId === 'tenant_demo'), false, 'tenant admin must not see other-tenant billing overrides');
  assert.equal(tenantBScoped.paymentEvents.some((event) => event.tenantId === 'tenant_demo'), false, 'tenant admin must not see other-tenant payment events');
  assert.equal(tenantBScoped.invoices.some((invoice) => invoice.id === demoInvoice.id), false, 'tenant admin must not see other-tenant invoices');
  assert.equal(tenantBScoped.jobs.some((job) => job.tenantId === 'tenant_demo' && job.queue === 'billing_webhook'), false, 'tenant admin must not see other-tenant billing jobs');

  const demoMemberScoped = scopeStateForActor(state, 'usr_product');
  assert.equal(demoMemberScoped.billingOverrides.some((override) => override.tenantId === tenantB.actor.tenantId), false, 'demo member must not see second-tenant overrides');
  assert.equal(demoMemberScoped.paymentEvents.some((event) => event.tenantId === tenantB.actor.tenantId), false, 'demo member must not see second-tenant payment events');
  assert.equal(demoMemberScoped.invoices.some((invoice) => invoice.id === tenantBInvoice.id), false, 'demo member must not see second-tenant invoices');
});

test('tenant scope isolates non-payment source, signal, account, notification, and governance records', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-tenant-domain-scope-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const tenantB = await registerTenant(statePath, {
    adminEmail: 'scope.owner@theta.example',
    domain: 'theta.example',
    name: 'Theta Scope',
  });

  const state = await loadState({ statePath });
  const now = '2026-06-13T20:30:00.000Z';
  const demoTenantId = 'tenant_demo';
  const demoOwnerUserId = 'usr_product';
  const tenantBId = tenantB.actor.tenantId;
  const tenantBOwnerUserId = tenantB.actor.id;
  const cases = [];
  const addPair = (collection, demoRecord, tenantRecord) => {
    state[collection] = [...(state[collection] ?? []), demoRecord, tenantRecord];
    cases.push({
      collection,
      demoId: demoRecord.id,
      tenantBId: tenantRecord.id,
    });
  };

  state.users = [
    ...(state.users ?? []),
    {
      id: 'usr_scope_demo_admin',
      tenantId: demoTenantId,
      name: 'Demo Scope Admin',
      email: 'demo.scope.admin@acme.example',
      role: 'admin',
      status: 'active',
      team: 'ops',
    },
    {
      id: 'usr_scope_demo_guard',
      tenantId: demoTenantId,
      name: 'Demo Scope Guard',
      email: 'demo.scope.guard@acme.example',
      role: 'member',
      status: 'active',
      team: 'product',
    },
    {
      id: 'usr_scope_theta_guard',
      tenantId: tenantBId,
      name: 'Theta Scope Guard',
      email: 'theta.scope.guard@theta.example',
      role: 'member',
      status: 'active',
      team: 'sales',
    },
    {
      id: 'usr_platform_scope_guard',
      tenantId: demoTenantId,
      name: 'Platform Scope Guard',
      email: 'platform.scope.guard@signal.example',
      role: 'operator',
      platformRole: 'operator',
      status: 'active',
    },
  ];
  cases.push({ collection: 'users', demoId: 'usr_scope_demo_guard', tenantBId: 'usr_scope_theta_guard' });
  state.memberships = [
    ...(state.memberships ?? []),
    {
      id: 'mem_scope_demo_admin',
      tenantId: demoTenantId,
      userId: 'usr_scope_demo_admin',
      role: 'admin',
      status: 'active',
      team: 'ops',
      createdAt: now,
      createdByUserId: 'usr_admin',
    },
  ];

  addPair(
    'memberships',
    { id: 'mem_scope_demo_guard', tenantId: demoTenantId, userId: 'usr_scope_demo_guard', role: 'member', status: 'active', team: 'product', createdAt: now, createdByUserId: 'usr_admin' },
    { id: 'mem_scope_theta_guard', tenantId: tenantBId, userId: 'usr_scope_theta_guard', role: 'member', status: 'active', team: 'sales', createdAt: now, createdByUserId: tenantBOwnerUserId },
  );
  addPair(
    'invites',
    { id: 'inv_scope_demo', tenantId: demoTenantId, email: 'invite.demo.scope@acme.example', role: 'member', status: 'pending', createdAt: now, invitedByUserId: 'usr_admin' },
    { id: 'inv_scope_theta', tenantId: tenantBId, email: 'invite.theta.scope@theta.example', role: 'member', status: 'pending', createdAt: now, invitedByUserId: tenantBOwnerUserId },
  );
  addPair(
    'mailboxes',
    { id: 'mbx_scope_demo', tenantId: demoTenantId, ownerUserId: demoOwnerUserId, provider: 'gmail', email: 'scope.demo@acme.example', status: 'connected', team: 'product', syncPolicy: { lookbackDays: 14, rawRetentionDays: 7 } },
    { id: 'mbx_scope_theta', tenantId: tenantBId, ownerUserId: tenantBOwnerUserId, provider: 'outlook', email: 'scope.theta@theta.example', status: 'connected', team: 'sales', syncPolicy: { lookbackDays: 14, rawRetentionDays: 7 } },
  );
  addPair(
    'mailboxConnectionSessions',
    { id: 'mcs_scope_demo', tenantId: demoTenantId, mailboxId: 'mbx_scope_demo', provider: 'gmail', status: 'ready', createdAt: now },
    { id: 'mcs_scope_theta', tenantId: tenantBId, mailboxId: 'mbx_scope_theta', provider: 'outlook', status: 'ready', createdAt: now },
  );
  addPair(
    'emailSyncCursors',
    { id: 'cur_scope_demo', tenantId: demoTenantId, mailboxId: 'mbx_scope_demo', provider: 'gmail', status: 'idle', lastSyncedAt: now },
    { id: 'cur_scope_theta', tenantId: tenantBId, mailboxId: 'mbx_scope_theta', provider: 'outlook', status: 'idle', lastSyncedAt: now },
  );
  addPair(
    'emailWatchSubscriptions',
    { id: 'watch_scope_demo', tenantId: demoTenantId, mailboxId: 'mbx_scope_demo', provider: 'gmail', status: 'active', createdAt: now, expirationAt: '2026-06-14T20:30:00.000Z' },
    { id: 'watch_scope_theta', tenantId: tenantBId, mailboxId: 'mbx_scope_theta', provider: 'outlook', status: 'active', createdAt: now, expirationAt: '2026-06-14T20:30:00.000Z' },
  );
  addPair(
    'emailFlows',
    { id: 'flow_scope_demo', tenantId: demoTenantId, name: 'Demo scope detector', status: 'enabled', ownerUserId: 'usr_admin', createdAt: now },
    { id: 'flow_scope_theta', tenantId: tenantBId, name: 'Theta scope detector', status: 'enabled', ownerUserId: tenantBOwnerUserId, createdAt: now },
  );
  addPair(
    'routingRules',
    { id: 'route_scope_demo', tenantId: demoTenantId, flowId: 'flow_scope_demo', ownerUserId: demoOwnerUserId, team: 'product', status: 'active', createdAt: now },
    { id: 'route_scope_theta', tenantId: tenantBId, flowId: 'flow_scope_theta', ownerUserId: tenantBOwnerUserId, team: 'sales', status: 'active', createdAt: now },
  );
  addPair(
    'sourceMessages',
    { id: 'src_scope_demo', tenantId: demoTenantId, mailboxId: 'mbx_scope_demo', provider: 'gmail', subject: 'Demo source', snippet: 'Demo source snippet', receivedAt: now, processedFlowIds: ['flow_scope_demo'] },
    { id: 'src_scope_theta', tenantId: tenantBId, mailboxId: 'mbx_scope_theta', provider: 'outlook', subject: 'Theta source', snippet: 'Theta source snippet', receivedAt: now, processedFlowIds: ['flow_scope_theta'] },
  );
  addPair(
    'flowRuns',
    { id: 'run_scope_demo', tenantId: demoTenantId, flowId: 'flow_scope_demo', sourceMessageId: 'src_scope_demo', status: 'passed', createdAt: now },
    { id: 'run_scope_theta', tenantId: tenantBId, flowId: 'flow_scope_theta', sourceMessageId: 'src_scope_theta', status: 'passed', createdAt: now },
  );
  addPair(
    'signals',
    { id: 'sig_scope_demo', tenantId: demoTenantId, ownerUserId: demoOwnerUserId, sourceMessageId: 'src_scope_demo', flowId: 'flow_scope_demo', account: 'Demo Scope Account', type: 'relationship_risk', status: 'open', title: 'Demo scope signal', confidence: 0.91, createdAt: now },
    { id: 'sig_scope_theta', tenantId: tenantBId, ownerUserId: tenantBOwnerUserId, sourceMessageId: 'src_scope_theta', flowId: 'flow_scope_theta', account: 'Theta Scope Account', type: 'expansion_signal', status: 'open', title: 'Theta scope signal', confidence: 0.92, createdAt: now },
  );
  addPair(
    'signalHandoffs',
    { id: 'handoff_scope_demo', tenantId: demoTenantId, signalId: 'sig_scope_demo', ownerUserId: demoOwnerUserId, status: 'open', createdAt: now },
    { id: 'handoff_scope_theta', tenantId: tenantBId, signalId: 'sig_scope_theta', ownerUserId: tenantBOwnerUserId, status: 'open', createdAt: now },
  );
  addPair(
    'accountProfiles',
    { id: 'acct_scope_demo', tenantId: demoTenantId, name: 'Demo Scope Account', ownerUserId: demoOwnerUserId, healthScore: 62, healthTrend: 'stable', lastTouchAt: now },
    { id: 'acct_scope_theta', tenantId: tenantBId, name: 'Theta Scope Account', ownerUserId: tenantBOwnerUserId, healthScore: 71, healthTrend: 'up', lastTouchAt: now },
  );
  addPair(
    'accountEvents',
    { id: 'acct_evt_scope_demo', tenantId: demoTenantId, account: 'Demo Scope Account', ownerUserId: demoOwnerUserId, type: 'meeting', occurredAt: now },
    { id: 'acct_evt_scope_theta', tenantId: tenantBId, account: 'Theta Scope Account', ownerUserId: tenantBOwnerUserId, type: 'meeting', occurredAt: now },
  );
  addPair(
    'accountActions',
    { id: 'acct_act_scope_demo', tenantId: demoTenantId, account: 'Demo Scope Account', ownerUserId: demoOwnerUserId, title: 'Demo action', status: 'open', dueAt: '2026-06-15T00:00:00.000Z' },
    { id: 'acct_act_scope_theta', tenantId: tenantBId, account: 'Theta Scope Account', ownerUserId: tenantBOwnerUserId, title: 'Theta action', status: 'open', dueAt: '2026-06-15T00:00:00.000Z' },
  );
  addPair(
    'accountReviews',
    { id: 'acct_review_scope_demo', tenantId: demoTenantId, account: 'Demo Scope Account', ownerUserId: demoOwnerUserId, status: 'open', createdAt: now },
    { id: 'acct_review_scope_theta', tenantId: tenantBId, account: 'Theta Scope Account', ownerUserId: tenantBOwnerUserId, status: 'open', createdAt: now },
  );
  addPair(
    'accountRecommendations',
    { id: 'acct_rec_scope_demo', tenantId: demoTenantId, account: 'Demo Scope Account', ownerUserId: demoOwnerUserId, title: 'Demo recommendation', status: 'open', priority: 'medium', evidenceSignalIds: ['sig_scope_demo'], evidenceActionIds: ['acct_act_scope_demo'], stakeholderIds: [demoOwnerUserId] },
    { id: 'acct_rec_scope_theta', tenantId: tenantBId, account: 'Theta Scope Account', ownerUserId: tenantBOwnerUserId, title: 'Theta recommendation', status: 'open', priority: 'medium', evidenceSignalIds: ['sig_scope_theta'], evidenceActionIds: ['acct_act_scope_theta'], stakeholderIds: [tenantBOwnerUserId] },
  );
  addPair(
    'notificationPreferences',
    { id: 'pref_scope_demo', tenantId: demoTenantId, userId: demoOwnerUserId, digestCadence: 'daily', immediateAlerts: true, channels: ['dashboard'], mutedAccounts: [], mutedSignalTypes: [], emailDeliveryStatus: 'subscribed', updatedAt: now },
    { id: 'pref_scope_theta', tenantId: tenantBId, userId: tenantBOwnerUserId, digestCadence: 'daily', immediateAlerts: true, channels: ['dashboard'], mutedAccounts: [], mutedSignalTypes: [], emailDeliveryStatus: 'subscribed', updatedAt: now },
  );
  addPair(
    'notificationEvents',
    { id: 'ntf_scope_demo', tenantId: demoTenantId, userId: demoOwnerUserId, signalId: 'sig_scope_demo', type: 'signal.created', title: 'Demo notification', status: 'unread', createdAt: now },
    { id: 'ntf_scope_theta', tenantId: tenantBId, userId: tenantBOwnerUserId, signalId: 'sig_scope_theta', type: 'signal.created', title: 'Theta notification', status: 'unread', createdAt: now },
  );
  addPair(
    'notificationDigestRuns',
    { id: 'digest_scope_demo', tenantId: demoTenantId, userId: demoOwnerUserId, status: 'sent', createdAt: now, notificationIds: ['ntf_scope_demo'] },
    { id: 'digest_scope_theta', tenantId: tenantBId, userId: tenantBOwnerUserId, status: 'sent', createdAt: now, notificationIds: ['ntf_scope_theta'] },
  );
  addPair(
    'emailDeliveryMessages',
    { id: 'email_delivery_scope_demo', tenantId: demoTenantId, userId: demoOwnerUserId, toEmail: 'priya@acme.example', subject: 'Demo delivery', status: 'sent', provider: 'sendgrid', createdAt: now },
    { id: 'email_delivery_scope_theta', tenantId: tenantBId, userId: tenantBOwnerUserId, toEmail: 'scope.owner@theta.example', subject: 'Theta delivery', status: 'sent', provider: 'sendgrid', createdAt: now },
  );
  addPair(
    'signalQualitySettings',
    { id: 'qlt_scope_demo', tenantId: demoTenantId, minimumConfidence: 0.7, requireSourceReference: true, autoRouteThreshold: 0.9, updatedAt: now, updatedByUserId: 'usr_admin' },
    { id: 'qlt_scope_theta', tenantId: tenantBId, minimumConfidence: 0.7, requireSourceReference: true, autoRouteThreshold: 0.9, updatedAt: now, updatedByUserId: tenantBOwnerUserId },
  );
  addPair(
    'suppressionRules',
    { id: 'sup_scope_demo', tenantId: demoTenantId, type: 'domain', value: 'demo-internal.example', status: 'active', reason: 'scope test', createdAt: now, createdByUserId: 'usr_admin' },
    { id: 'sup_scope_theta', tenantId: tenantBId, type: 'domain', value: 'theta-internal.example', status: 'active', reason: 'scope test', createdAt: now, createdByUserId: tenantBOwnerUserId },
  );
  addPair(
    'signalFeedback',
    { id: 'feedback_scope_demo', tenantId: demoTenantId, signalId: 'sig_scope_demo', userId: demoOwnerUserId, label: 'useful', createdAt: now },
    { id: 'feedback_scope_theta', tenantId: tenantBId, signalId: 'sig_scope_theta', userId: tenantBOwnerUserId, label: 'useful', createdAt: now },
  );
  addPair(
    'modelGovernancePolicies',
    { id: 'mdl_scope_demo', tenantId: demoTenantId, status: 'active', detectorBoundary: 'shared_detector', dataBoundary: 'tenant_isolated', learningMode: 'disabled', trainingDataUse: 'excluded_by_default', perTenantModel: false, updatedAt: now, updatedByUserId: 'usr_admin' },
    { id: 'mdl_scope_theta', tenantId: tenantBId, status: 'active', detectorBoundary: 'shared_detector', dataBoundary: 'tenant_isolated', learningMode: 'disabled', trainingDataUse: 'excluded_by_default', perTenantModel: false, updatedAt: now, updatedByUserId: tenantBOwnerUserId },
  );
  addPair(
    'governancePolicies',
    { id: 'gov_scope_demo', tenantId: demoTenantId, sourceRetentionDays: 30, rawSnippetRetentionDays: 7, status: 'active', updatedAt: now, updatedByUserId: 'usr_admin' },
    { id: 'gov_scope_theta', tenantId: tenantBId, sourceRetentionDays: 30, rawSnippetRetentionDays: 7, status: 'active', updatedAt: now, updatedByUserId: tenantBOwnerUserId },
  );
  addPair(
    'redactionRules',
    { id: 'redact_scope_demo', tenantId: demoTenantId, scope: 'source_snippet', pattern: 'demo-secret', replacement: '[redacted]', status: 'active', createdAt: now, createdByUserId: 'usr_admin' },
    { id: 'redact_scope_theta', tenantId: tenantBId, scope: 'source_snippet', pattern: 'theta-secret', replacement: '[redacted]', status: 'active', createdAt: now, createdByUserId: tenantBOwnerUserId },
  );
  addPair(
    'dataRequests',
    { id: 'data_request_scope_demo', tenantId: demoTenantId, requesterEmail: 'privacy.demo@acme.example', requestType: 'access', status: 'open', requestedAt: now, createdByUserId: 'usr_admin' },
    { id: 'data_request_scope_theta', tenantId: tenantBId, requesterEmail: 'privacy.theta@theta.example', requestType: 'access', status: 'open', requestedAt: now, createdByUserId: tenantBOwnerUserId },
  );
  addPair(
    'incidentNotes',
    { id: 'incident_scope_demo', tenantId: demoTenantId, title: 'Demo incident', status: 'open', severity: 'watch', createdAt: now, createdByUserId: 'usr_admin' },
    { id: 'incident_scope_theta', tenantId: tenantBId, title: 'Theta incident', status: 'open', severity: 'watch', createdAt: now, createdByUserId: tenantBOwnerUserId },
  );
  addPair(
    'lifecycleNotices',
    { id: 'lcn_scope_demo', tenantId: demoTenantId, ownerUserId: demoOwnerUserId, category: 'source', title: 'Demo lifecycle', status: 'open', severity: 'info', createdAt: now, sourceIds: { tenantId: demoTenantId, mailboxId: 'mbx_scope_demo' } },
    { id: 'lcn_scope_theta', tenantId: tenantBId, ownerUserId: tenantBOwnerUserId, category: 'source', title: 'Theta lifecycle', status: 'open', severity: 'info', createdAt: now, sourceIds: { tenantId: tenantBId, mailboxId: 'mbx_scope_theta' } },
  );
  addPair(
    'jobs',
    { id: 'job_scope_demo', tenantId: demoTenantId, queue: 'signal_detection', status: 'queued', createdAt: now, payload: { sourceMessageId: 'src_scope_demo' } },
    { id: 'job_scope_theta', tenantId: tenantBId, queue: 'signal_detection', status: 'queued', createdAt: now, payload: { sourceMessageId: 'src_scope_theta' } },
  );
  addPair(
    'deadLetter',
    { id: 'dead_scope_demo', tenantId: demoTenantId, queue: 'signal_detection', status: 'failed', originalJobId: 'job_scope_demo', failedAt: now, reason: 'scope test' },
    { id: 'dead_scope_theta', tenantId: tenantBId, queue: 'signal_detection', status: 'failed', originalJobId: 'job_scope_theta', failedAt: now, reason: 'scope test' },
  );
  addPair(
    'webhookEvents',
    { id: 'wh_scope_demo', tenantId: demoTenantId, provider: 'gmail', eventType: 'history', accepted: true, receivedAt: now, status: 200 },
    { id: 'wh_scope_theta', tenantId: tenantBId, provider: 'outlook', eventType: 'notification', accepted: true, receivedAt: now, status: 200 },
  );

  assert(cases.length >= 30, 'tenant isolation stress test should cover the full non-payment app scoping surface');

  const hasRecord = (scopedState, collection, id) => (scopedState[collection] ?? []).some((item) => item.id === id);
  const tenantBScoped = scopeStateForActor(state, tenantBOwnerUserId);
  const demoAdminScoped = scopeStateForActor(state, 'usr_scope_demo_admin');
  const demoMemberScoped = scopeStateForActor(state, demoOwnerUserId);
  const platformScoped = scopeStateForActor(state, 'usr_platform_scope_guard');

  for (const item of cases) {
    assert.equal(hasRecord(tenantBScoped, item.collection, item.tenantBId), true, `tenant admin should see own ${item.collection} record`);
    assert.equal(hasRecord(tenantBScoped, item.collection, item.demoId), false, `tenant admin must not see other-tenant ${item.collection} record`);
    assert.equal(hasRecord(demoAdminScoped, item.collection, item.demoId), true, `demo admin should see own ${item.collection} record`);
    assert.equal(hasRecord(demoAdminScoped, item.collection, item.tenantBId), false, `demo admin must not see other-tenant ${item.collection} record`);
    assert.equal(hasRecord(demoMemberScoped, item.collection, item.tenantBId), false, `demo member must not see second-tenant ${item.collection} record`);
    assert.equal(hasRecord(platformScoped, item.collection, item.demoId), true, `platform operator should see demo ${item.collection} record`);
    assert.equal(hasRecord(platformScoped, item.collection, item.tenantBId), true, `platform operator should see second-tenant ${item.collection} record`);
  }
});
