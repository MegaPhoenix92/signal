#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  billingReadModel,
  countBillingTypes,
  paymentLifecycleRowByArea,
} from './domains/billing-read-model.mjs';
import {
  bootstrapState,
  paymentLifecycleAuditReport,
} from './signal-state.mjs';

test('billing read model scopes seeded billing records for the default tenant', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-billing-domain-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  const { state, summary } = await bootstrapState({ force: true, statePath });
  const tenantId = state.tenants[0].id;
  const model = billingReadModel(state, { summary });

  assert.equal(model.tenant.id, tenantId);
  assert.equal(model.subscriptions.length, state.subscriptions.filter((subscription) => subscription.tenantId === tenantId).length);
  assert.equal(model.invoices.length, state.invoices.filter((invoice) => invoice.tenantId === tenantId).length);
  assert.equal(model.openInvoices.length, state.invoices.filter((invoice) => invoice.tenantId === tenantId && ['open', 'past_due'].includes(invoice.status)).length);
  assert.equal(model.paymentEvents.length, state.paymentEvents.filter((event) => event.tenantId === tenantId).length);
  assert.equal(model.sessionCounts.checkout ?? 0, state.billingSessions.filter((session) => session.tenantId === tenantId && session.type === 'checkout').length);
  assert.equal(model.eventCounts['invoice.payment_failed'] ?? 0, state.paymentEvents.filter((event) => event.tenantId === tenantId && event.type === 'invoice.payment_failed').length);
  assert.equal(model.noticeCounts.subscription_starting_point ?? 0, state.lifecycleNotices.filter((notice) => notice.tenantId === tenantId && notice.category === 'payment' && notice.trigger === 'subscription_starting_point').length);
  assert.equal(model.distinctPaymentEventTypes.size, new Set(
    state.paymentEvents
      .filter((event) => event.tenantId === tenantId)
      .map((event) => event.appliedType ?? event.type ?? event.providerEventType)
      .filter(Boolean),
  ).size);
  assert(model.distinctPaymentEventTypes.size > 0);
  assert(model.activeEntitlements.length > 0);
  assert(model.failedBillingJobs.length === 0);
});

test('billing read model counts billing types by type, trigger, status, then unknown', () => {
  assert.deepEqual(countBillingTypes([
    { type: 'checkout' },
    { trigger: 'subscription_starting_point' },
    { status: 'paid' },
    {},
    null,
  ]), {
    checkout: 1,
    paid: 1,
    subscription_starting_point: 1,
    unknown: 2,
  });
});

test('payment lifecycle report uses billing read model aggregates without changing report shape', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-billing-lifecycle-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  const { state, summary } = await bootstrapState({ force: true, statePath });
  const model = billingReadModel(state, { summary });
  const report = paymentLifecycleAuditReport(state, { statePath });
  const failedPayment = paymentLifecycleRowByArea(report, 'failed_payment_recovery');

  assert.equal(report.summary.activeEntitlements, model.activeEntitlements.length);
  assert.equal(report.summary.openInvoices, model.openInvoices.length);
  assert.equal(report.summary.paymentEvents, model.paymentEvents.length);
  assert.equal(report.summary.recoverySessions, model.sessionCounts.payment_recovery ?? 0);
  assert.equal(failedPayment.area, 'failed_payment_recovery');
  assert(failedPayment.evidence.includes(`${model.sessionCounts.payment_recovery ?? 0} payment recovery session(s)`));
});
