#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  bootstrapState,
  createCheckoutSession,
  handleOutlookLifecycleNotification,
  reconcileBillingReturn,
} from './signal-state.mjs';
import {
  digestClientState,
  parseOutlookChangeNotification,
  ProviderWatchError,
} from './signal-provider-watch.mjs';

async function tempStatePath(label) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), label));
  return {
    statePath: path.join(tempDir, 'signal-state.json'),
    tempDir,
  };
}

test('reconcileBillingReturn replays are idempotent with session-scoped dedup keys', async (t) => {
  const { statePath, tempDir } = await tempStatePath('signal-billing-return-dedup-');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const created = await createCheckoutSession('tenant_demo', 'plan_team', { actorUserId: 'usr_admin', statePath });
  const sessionId = created.details.sessionId;
  const checkout = await reconcileBillingReturn({
    sessionId,
    tenantId: 'tenant_demo',
    result: 'success',
  }, { actorUserId: 'usr_admin', statePath });
  assert.equal(checkout.details.duplicate, false);
  assert.match(checkout.details.eventId, /^evt_/);
  assert.match(checkout.details.jobId, /^job_/);

  const replay = await reconcileBillingReturn({
    sessionId,
    tenantId: 'tenant_demo',
    result: 'success',
  }, { actorUserId: 'usr_admin', statePath });
  assert.equal(replay.details.duplicate, true);
  assert.equal(replay.details.status, 'duplicate');
  assert.equal(replay.details.eventId, checkout.details.eventId);
  assert.equal(replay.details.jobId, checkout.details.jobId);

  const cancel = await reconcileBillingReturn({
    sessionId,
    tenantId: 'tenant_demo',
    result: 'cancel',
  }, { actorUserId: 'usr_admin', statePath });
  assert.equal(cancel.details.duplicate, false);
  assert.notEqual(cancel.details.eventId, checkout.details.eventId);
});

test('reconcileBillingReturn keeps distinct sessions for the same tenant', async (t) => {
  const { statePath, tempDir } = await tempStatePath('signal-billing-return-sessions-');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const firstSession = await createCheckoutSession('tenant_demo', 'plan_team', { actorUserId: 'usr_admin', statePath });
  const secondSession = await createCheckoutSession('tenant_demo', 'plan_team', { actorUserId: 'usr_admin', statePath });
  const first = await reconcileBillingReturn({
    sessionId: firstSession.details.sessionId,
    tenantId: 'tenant_demo',
    result: 'success',
  }, { actorUserId: 'usr_admin', statePath });
  const second = await reconcileBillingReturn({
    sessionId: secondSession.details.sessionId,
    tenantId: 'tenant_demo',
    result: 'success',
  }, { actorUserId: 'usr_admin', statePath });
  assert.equal(first.details.duplicate, false);
  assert.equal(second.details.duplicate, false);
  assert.notEqual(first.details.eventId, second.details.eventId);
  assert.notEqual(first.details.jobId, second.details.jobId);
});

async function outlookLifecycleFixture(statePath, { lifecycleEvent, subscriptionId = null, watchId = 'watch_outlook_dedup_test' } = {}) {
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const mailboxId = 'mbx_outlook_success';
  // Local watch secrets are deterministic per mailboxId; use watch-scoped clientState so
  // applyOutlookLifecycleToWatch resolves the intended subscription in multi-watch tests.
  const clientState = `signal_outlook_${watchId}_dedup_test`;
  state.emailWatchSubscriptions = state.emailWatchSubscriptions ?? [];
  state.emailWatchSubscriptions.push({
    clientStateDigest: digestClientState(clientState),
    expirationAt: new Date(Date.now() + 86_400_000).toISOString(),
    id: watchId,
    mailboxId,
    notificationUrl: 'http://127.0.0.1:8787/api/webhooks/outlook/lifecycle',
    provider: 'outlook',
    providerWatchId: 'outlook-sub-dedup-test',
    status: 'active',
  });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const payload = {
    value: [{
      clientState,
      lifecycleEvent,
      ...(subscriptionId ? { subscriptionId } : {}),
    }],
  };
  return { clientState, mailboxId, payload, watchId };
}

test('reconcileBillingReturn tenant-only success and cancel do not mis-dedup each other', async (t) => {
  const { statePath, tempDir } = await tempStatePath('signal-billing-return-tenant-only-');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  // Keep a non-matching placeholder so normalizeState does not auto-create tenant_demo checkout sessions.
  state.billingSessions = [{
    createdAt: state.meta?.bootstrappedAt ?? new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    id: 'bs_checkout_placeholder',
    planId: 'plan_team',
    provider: 'local_test',
    status: 'ready',
    tenantId: 'tenant_other',
    type: 'checkout',
    url: 'signal://billing/checkout/tenant_other/plan_team',
  }];
  state.jobs.push({
    attempts: 1,
    id: 'job_null_idempotency_seed',
    maxAttempts: 5,
    message: 'seed job without provider idempotency key',
    queue: 'billing_webhook',
    status: 'succeeded',
    targetId: 'tenant_demo',
    tenantId: 'tenant_demo',
    type: 'payment.return.success',
  });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const success = await reconcileBillingReturn({
    tenantId: 'tenant_demo',
    result: 'success',
  }, { actorUserId: 'usr_admin', statePath });
  const cancel = await reconcileBillingReturn({
    tenantId: 'tenant_demo',
    result: 'cancel',
  }, { actorUserId: 'usr_admin', statePath });
  assert.equal(success.details.duplicate, false);
  assert.equal(cancel.details.duplicate, false);
  assert.notEqual(success.details.eventId, cancel.details.eventId);
  assert.notEqual(success.details.jobId, cancel.details.jobId);

  const replaySuccess = await reconcileBillingReturn({
    tenantId: 'tenant_demo',
    result: 'success',
  }, { actorUserId: 'usr_admin', statePath });
  assert.equal(replaySuccess.details.duplicate, false, 'null dedup keys must not match unrelated succeeded jobs');
});

test('reconcileBillingReturn treats event-only or job-only side effects as replay', async (t) => {
  const { statePath, tempDir } = await tempStatePath('signal-billing-return-asymmetric-');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const created = await createCheckoutSession('tenant_demo', 'plan_team', { actorUserId: 'usr_admin', statePath });
  const sessionId = created.details.sessionId;
  const dedupKey = `billing.return.${sessionId}.success`;

  for (const keep of ['event', 'job']) {
    const checkout = await reconcileBillingReturn({
      sessionId,
      tenantId: 'tenant_demo',
      result: 'success',
    }, { actorUserId: 'usr_admin', statePath });
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (keep === 'event') {
      state.jobs = state.jobs.filter((job) => job.id !== checkout.details.jobId);
    } else {
      state.paymentEvents = state.paymentEvents.filter((event) => event.id !== checkout.details.eventId);
    }
    const eventCountBefore = state.paymentEvents.filter((event) =>
      event.type === 'billing.return.success' && event.sessionId === sessionId).length;
    const jobCountBefore = state.jobs.filter((job) =>
      job.type === 'payment.return.success' && job.targetId === sessionId && job.status === 'succeeded').length;
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const replay = await reconcileBillingReturn({
      sessionId,
      tenantId: 'tenant_demo',
      result: 'success',
    }, { actorUserId: 'usr_admin', statePath });
    assert.equal(replay.details.duplicate, true, `${keep}-only seed should replay`);
    assert.equal(replay.details.status, 'duplicate');
    if (keep === 'event') {
      assert.equal(replay.details.eventId, checkout.details.eventId);
      assert.equal(replay.details.jobId, null);
    } else {
      assert.equal(replay.details.eventId, null);
      assert.equal(replay.details.jobId, checkout.details.jobId);
    }

    const replayed = JSON.parse(await fs.readFile(statePath, 'utf8'));
    const returnEvents = replayed.paymentEvents.filter((event) => event.type === 'billing.return.success' && event.sessionId === sessionId);
    const returnJobs = replayed.jobs.filter((job) => job.type === 'payment.return.success' && job.targetId === sessionId && job.status === 'succeeded');
    assert.equal(returnEvents.length, eventCountBefore, `${keep}-only replay should not append duplicate events`);
    assert.equal(returnJobs.length, jobCountBefore, `${keep}-only replay should not append duplicate jobs`);
    if (returnEvents[0]) {
      assert.equal(returnEvents[0].providerEventId, dedupKey);
    }

    const reset = JSON.parse(await fs.readFile(statePath, 'utf8'));
    reset.billingSessions = reset.billingSessions.map((session) =>
      session.id === sessionId
        ? { ...session, returnedAt: null, returnResult: null, status: 'ready', updatedAt: session.createdAt }
        : session);
    reset.paymentEvents = reset.paymentEvents.filter((event) => event.sessionId !== sessionId);
    reset.jobs = reset.jobs.filter((job) => job.targetId !== sessionId || !job.type.startsWith('payment.return.'));
    await fs.writeFile(statePath, `${JSON.stringify(reset, null, 2)}\n`, 'utf8');
  }
});

test('handleOutlookLifecycleNotification dedups by watch id when subscription id is absent', async (t) => {
  const { statePath, tempDir } = await tempStatePath('signal-outlook-lifecycle-watch-dedup-');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const { payload } = await outlookLifecycleFixture(statePath, { lifecycleEvent: 'missed' });
  const first = await handleOutlookLifecycleNotification(payload, {
    actorUserId: 'usr_admin',
    statePath,
  });
  assert.equal(first.details.duplicateCount, 0);
  const replay = await handleOutlookLifecycleNotification(payload, {
    actorUserId: 'usr_admin',
    statePath,
  });
  assert.equal(replay.details.duplicateCount, 1);
  assert.equal(replay.details.duplicates.length, 1);
  assert.equal(replay.details.duplicates[0].lifecycleEvent, 'missed');
});

test('handleOutlookLifecycleNotification queues distinct jobs for two watches without subscriptionId', async (t) => {
  const { statePath, tempDir } = await tempStatePath('signal-outlook-lifecycle-multi-watch-');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const first = await outlookLifecycleFixture(statePath, { lifecycleEvent: 'missed', watchId: 'watch_outlook_multi_a' });
  const second = await outlookLifecycleFixture(statePath, { lifecycleEvent: 'missed', watchId: 'watch_outlook_multi_b' });

  await handleOutlookLifecycleNotification(first.payload, { actorUserId: 'usr_admin', statePath });
  await handleOutlookLifecycleNotification(second.payload, { actorUserId: 'usr_admin', statePath });

  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const jobs = state.jobs.filter((job) =>
    job.type === 'outlook.watch.notification' && job.targetId === 'mbx_outlook_success');
  assert.equal(jobs.length, 2);
  assert.notEqual(jobs[0].providerIdempotencyKey, jobs[1].providerIdempotencyKey);
  assert.deepEqual(
    new Set(jobs.map((job) => job.providerIdempotencyKey)),
    new Set([
      'outlook.lifecycle.watch_outlook_multi_a.missed',
      'outlook.lifecycle.watch_outlook_multi_b.missed',
    ]),
  );
});

test('handleOutlookLifecycleNotification replay does not mutate a renewed watch', async (t) => {
  const { statePath, tempDir } = await tempStatePath('signal-outlook-lifecycle-renewed-watch-');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const { payload, watchId } = await outlookLifecycleFixture(statePath, {
    lifecycleEvent: 'reauthorizationRequired',
    subscriptionId: 'outlook-sub-renewed-watch',
    watchId: 'watch_outlook_renewed',
  });
  await handleOutlookLifecycleNotification(payload, { actorUserId: 'usr_admin', statePath });

  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const watch = state.emailWatchSubscriptions.find((candidate) => candidate.id === watchId);
  assert.equal(watch.status, 'expired');
  watch.status = 'active';
  watch.providerLastError = null;
  watch.providerLastErrorAt = null;
  watch.providerLastErrorCode = null;
  watch.providerBackoffReason = null;
  watch.providerLifecycleEvent = null;
  watch.nextRenewalAt = null;
  const renewedSnapshot = {
    lifecycleNotificationCount: watch.lifecycleNotificationCount,
    nextRenewalAt: watch.nextRenewalAt,
    providerBackoffReason: watch.providerBackoffReason,
    providerLastError: watch.providerLastError,
    providerLastErrorAt: watch.providerLastErrorAt,
    providerLastErrorCode: watch.providerLastErrorCode,
    providerLifecycleEvent: watch.providerLifecycleEvent,
    status: watch.status,
  };
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const replay = await handleOutlookLifecycleNotification(payload, { actorUserId: 'usr_admin', statePath });
  assert.equal(replay.details.duplicateCount, 1);

  const replayed = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const replayedWatch = replayed.emailWatchSubscriptions.find((candidate) => candidate.id === watchId);
  assert.deepEqual({
    lifecycleNotificationCount: replayedWatch.lifecycleNotificationCount,
    nextRenewalAt: replayedWatch.nextRenewalAt,
    providerBackoffReason: replayedWatch.providerBackoffReason,
    providerLastError: replayedWatch.providerLastError,
    providerLastErrorAt: replayedWatch.providerLastErrorAt,
    providerLastErrorCode: replayedWatch.providerLastErrorCode,
    providerLifecycleEvent: replayedWatch.providerLifecycleEvent,
    status: replayedWatch.status,
  }, renewedSnapshot);
});

test('handleOutlookLifecycleNotification keeps distinct keys across lifecycle events and watches', async (t) => {
  const { statePath, tempDir } = await tempStatePath('signal-outlook-lifecycle-events-');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  for (const lifecycleEvent of ['reauthorizationRequired', 'subscriptionRemoved', 'missed']) {
    const { payload, watchId } = await outlookLifecycleFixture(statePath, {
      lifecycleEvent,
      subscriptionId: `outlook-sub-${lifecycleEvent}`,
      watchId: `watch_outlook_${lifecycleEvent}`,
    });
    const result = await handleOutlookLifecycleNotification(payload, {
      actorUserId: 'usr_admin',
      statePath,
    });
    assert.equal(result.details.duplicateCount, 0, `${lifecycleEvent} first delivery should record`);
    const replay = await handleOutlookLifecycleNotification(payload, {
      actorUserId: 'usr_admin',
      statePath,
    });
    assert.equal(replay.details.duplicateCount, 1, `${lifecycleEvent} replay should dedup`);
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    const watch = state.emailWatchSubscriptions.find((candidate) => candidate.id === watchId);
    assert.equal(watch.lifecycleNotificationCount, 1, `${lifecycleEvent} should increment count once`);
    const expectedJobType = lifecycleEvent === 'missed' ? 'outlook.watch.notification' : 'mailbox.watch.renew';
    const expectedDedupKey = `outlook.lifecycle.outlook-sub-${lifecycleEvent}.${lifecycleEvent}`;
    const jobs = state.jobs.filter((job) =>
      job.type === expectedJobType && job.providerIdempotencyKey === expectedDedupKey);
    assert.equal(jobs.length, 1, `${lifecycleEvent} should queue one job`);
    assert.equal(jobs[0].providerIdempotencyKey, expectedDedupKey);
  }
});

test('parseOutlookChangeNotification rejects oversized lifecycle batches', () => {
  assert.throws(
    () => parseOutlookChangeNotification({ value: Array.from({ length: 51 }, (_, index) => ({ clientState: `state-${index}` })) }),
    (error) => error instanceof ProviderWatchError
      && error.code === 'OUTLOOK_NOTIFICATION_BATCH_TOO_LARGE'
      && /exceeds 50 entries/.test(error.message),
  );
});