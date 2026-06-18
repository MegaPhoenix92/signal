#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  STRIPE_IDEMPOTENCY_KEY_MAX_LENGTH,
  assertStripeLivemodeMatches,
  createStripeBillingPortalSession,
  createStripeCheckoutSession,
  createStripeCheckoutSessionRequest,
  resolveExpectedStripeLivemode,
  signStripeWebhookPayload,
  parseSignedStripeWebhook,
  stripeEventToLocalPaymentWebhook,
  stripeBillingPortalIdempotencyKey,
  stripeCheckoutIdempotencyKey,
  verifyStripeWebhookSignature,
} from './signal-payment-provider.mjs';
import {
  bootstrapState,
  createCheckoutSession,
  handlePaymentWebhook,
  handleSignedStripePaymentWebhook,
  loadState,
  SignalStateError,
} from './signal-state.mjs';

const env = {
  SIGNAL_APP_BASE_URL: 'https://app.signal.test',
  SIGNAL_STRIPE_PRICE_TEAM: 'price_signal_team',
  STRIPE_SECRET_KEY: 'sk_test_signal',
};

const tenant = {
  id: 'tenant_demo',
  stripeCustomerId: 'cus_tenant_fallback',
};

const plan = {
  id: 'plan_team',
};

const subscription = {
  id: 'sub_demo',
  providerCustomerId: 'cus_signal',
  providerSubscriptionId: 'sub_stripe_signal',
};

function stripeFetchRecorder(calls) {
  return async (url, init) => {
    calls.push({ init, url });
    if (url.endsWith('/checkout/sessions')) {
      return new Response(JSON.stringify({
        customer: 'cus_signal',
        expires_at: 1780527000,
        id: 'cs_test_signal',
        object: 'checkout.session',
        url: 'https://checkout.stripe.test/session',
      }), { status: 200 });
    }
    if (url.endsWith('/billing_portal/sessions')) {
      return new Response(JSON.stringify({
        id: 'bps_test_signal',
        object: 'billing_portal.session',
        url: 'https://billing.stripe.test/session',
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: 'unexpected Stripe endpoint' } }), { status: 404 });
  };
}

test('checkout sessions derive a stable Stripe idempotency key by default', async () => {
  const calls = [];
  const checkout = await createStripeCheckoutSession({
    env,
    fetchImpl: stripeFetchRecorder(calls),
    plan,
    sessionAttempt: 1,
    subscription,
    tenant,
  });

  const expectedKey = stripeCheckoutIdempotencyKey({ plan, sessionAttempt: 1, subscription, tenant });
  assert.match(expectedKey, /^signal-checkout-[a-f0-9]{64}$/);
  assert.equal(calls[0].init.headers['Idempotency-Key'], expectedKey);
  assert.equal(checkout.requestIdempotencyKey, expectedKey);
});

test('billing portal sessions derive a stable Stripe idempotency key by default', async () => {
  const calls = [];
  const portal = await createStripeBillingPortalSession({
    env,
    fetchImpl: stripeFetchRecorder(calls),
    sessionAttempt: 2,
    subscription,
    tenant,
  });

  const expectedKey = stripeBillingPortalIdempotencyKey({ sessionAttempt: 2, subscription, tenant });
  assert.match(expectedKey, /^signal-portal-[a-f0-9]{64}$/);
  assert.equal(calls[0].init.headers['Idempotency-Key'], expectedKey);
  assert.equal(portal.requestIdempotencyKey, expectedKey);
});

test('derived Stripe idempotency keys are stable per attempt and unique across attempts', () => {
  assert.equal(
    stripeCheckoutIdempotencyKey({ plan, sessionAttempt: 3, subscription, tenant }),
    stripeCheckoutIdempotencyKey({ plan, sessionAttempt: 3, subscription, tenant }),
  );
  assert.notEqual(
    stripeCheckoutIdempotencyKey({ plan, sessionAttempt: 3, subscription, tenant }),
    stripeCheckoutIdempotencyKey({ plan, sessionAttempt: 4, subscription, tenant }),
  );
  assert.notEqual(
    stripeBillingPortalIdempotencyKey({ sessionAttempt: 3, subscription, tenant }),
    stripeBillingPortalIdempotencyKey({ sessionAttempt: 4, subscription, tenant }),
  );
});

test('explicit Stripe idempotency keys override derived defaults', async () => {
  const calls = [];
  await createStripeCheckoutSession({
    env,
    fetchImpl: stripeFetchRecorder(calls),
    idempotencyKey: 'manual-checkout-key',
    plan,
    subscription,
    tenant,
  });
  await createStripeBillingPortalSession({
    env,
    fetchImpl: stripeFetchRecorder(calls),
    idempotencyKey: 'manual-portal-key',
    subscription,
    tenant,
  });

  assert.equal(calls[0].init.headers['Idempotency-Key'], 'manual-checkout-key');
  assert.equal(calls[1].init.headers['Idempotency-Key'], 'manual-portal-key');
});

test('derived Stripe idempotency keys require a session attempt scope', async () => {
  assert.throws(
    () => stripeCheckoutIdempotencyKey({ plan, subscription, tenant }),
    /session attempt scope is required/,
  );
  await assert.rejects(
    () => createStripeCheckoutSession({
      env,
      fetchImpl: stripeFetchRecorder([]),
      plan,
      subscription,
      tenant,
    }),
    /session attempt scope is required/,
  );
});

test('derived Stripe idempotency keys stay within Stripe length limits', () => {
  const longTenant = { id: `tenant_${'x'.repeat(120)}` };
  const longPlan = { id: `plan_${'y'.repeat(120)}` };
  const longSubscription = { id: `sub_${'z'.repeat(120)}` };
  const key = stripeCheckoutIdempotencyKey({
    plan: longPlan,
    sessionAttempt: 1,
    subscription: longSubscription,
    tenant: longTenant,
  });

  assert(key.length <= STRIPE_IDEMPOTENCY_KEY_MAX_LENGTH);
  assert.match(key, /^signal-checkout-[a-f0-9]{64}$/);
  assert.equal(key, stripeCheckoutIdempotencyKey({
    plan: longPlan,
    sessionAttempt: 1,
    subscription: longSubscription,
    tenant: longTenant,
  }));
});

test('derived Stripe idempotency keys differ when long inputs differ past the old truncation point', () => {
  const longPrefix = 'x'.repeat(120);
  const leftTenant = { id: `tenant_${longPrefix}_left` };
  const rightTenant = { id: `tenant_${longPrefix}_right` };
  const longPlan = { id: `plan_${'y'.repeat(120)}` };
  const longSubscription = { id: `sub_${'z'.repeat(120)}` };

  const left = stripeCheckoutIdempotencyKey({
    plan: longPlan,
    sessionAttempt: 1,
    subscription: longSubscription,
    tenant: leftTenant,
  });
  const right = stripeCheckoutIdempotencyKey({
    plan: longPlan,
    sessionAttempt: 1,
    subscription: longSubscription,
    tenant: rightTenant,
  });

  assert.notEqual(left, right);
  assert(left.length <= STRIPE_IDEMPOTENCY_KEY_MAX_LENGTH);
  assert(right.length <= STRIPE_IDEMPOTENCY_KEY_MAX_LENGTH);
});

test('createCheckoutSession retries reuse the same derived Stripe idempotency key', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-checkout-idempotency-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const calls = [];
  let failOnce = true;
  const fetchImpl = async (url, init) => {
    calls.push({ init, url });
    if (failOnce) {
      failOnce = false;
      throw new Error('simulated Stripe timeout');
    }
    return new Response(JSON.stringify({
      customer: 'cus_signal',
      expires_at: 1780527000,
      id: 'cs_retry_signal',
      object: 'checkout.session',
      url: 'https://checkout.stripe.test/retry',
    }), { status: 200 });
  };

  await assert.rejects(
    () => createCheckoutSession('tenant_demo', 'plan_team', {
      actorUserId: 'usr_admin',
      env,
      fetchImpl,
      livePaymentProvider: true,
      statePath,
    }),
    /simulated Stripe timeout/,
  );
  assert.equal(calls.length, 1);
  const firstKey = calls[0].init.headers['Idempotency-Key'];
  assert(firstKey);

  const checkout = await createCheckoutSession('tenant_demo', 'plan_team', {
    actorUserId: 'usr_admin',
    env,
    fetchImpl,
    livePaymentProvider: true,
    statePath,
  });
  assert.equal(checkout.action, 'payments.checkout');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers['Idempotency-Key'], firstKey);

  const state = await loadState({ statePath });
  const billingSession = state.billingSessions.find((session) => session.providerSessionId === 'cs_retry_signal');
  assert.equal(billingSession?.providerIdempotencyKey, firstKey);
  const billingJob = state.jobs.find((job) => job.targetId === billingSession?.id);
  assert.equal(billingJob?.providerIdempotencyKey, firstKey);
});

test('Stripe webhook verification rejects future-dated signatures', () => {
  const body = JSON.stringify({ id: 'evt_future', object: 'event' });
  const secret = 'whsec_future_timestamp_test';
  const futureTimestamp = Math.floor(Date.now() / 1000) + 120;
  const signature = signStripeWebhookPayload(body, secret, { timestamp: futureTimestamp });

  assert.throws(
    () => verifyStripeWebhookSignature(body, signature, secret),
    (error) => error.code === 'PAYMENT_WEBHOOK_TIMESTAMP_STALE',
  );
});

test('Stripe webhook verification rejects stale signatures', () => {
  const body = JSON.stringify({ id: 'evt_stale', object: 'event' });
  const secret = 'whsec_stale_timestamp_test';
  const staleTimestamp = Math.floor(Date.now() / 1000) - 600;
  const signature = signStripeWebhookPayload(body, secret, { timestamp: staleTimestamp });

  assert.throws(
    () => verifyStripeWebhookSignature(body, signature, secret),
    (error) => error.code === 'PAYMENT_WEBHOOK_TIMESTAMP_STALE',
  );
});

test('Stripe mapper records unknown events as ignored instead of throwing', () => {
  const mapping = stripeEventToLocalPaymentWebhook({
    id: 'evt_unknown_recorded',
    type: 'payment_intent.processing',
    livemode: false,
    data: {
      object: {
        id: 'pi_processing',
        object: 'payment_intent',
        customer: 'cus_signal',
        metadata: {
          tenantId: 'tenant_demo',
        },
        status: 'processing',
      },
    },
  });

  assert.equal(mapping.localType, 'provider.event.ignored');
  assert.equal(mapping.eventType, 'payment_intent.processing');
  assert.equal(mapping.args.tenantId, 'tenant_demo');
  assert.equal(mapping.args.providerCustomerId, 'cus_signal');
});

test('Stripe mapper supports invoice terminal states, canonical refunds, credits, and trial notices', () => {
  const baseInvoice = {
    customer: 'cus_signal',
    hosted_invoice_url: 'https://invoice.stripe.test/in_123',
    id: 'in_123',
    object: 'invoice',
    subscription: 'sub_stripe_signal',
  };

  assert.equal(stripeEventToLocalPaymentWebhook({
    id: 'evt_invoice_draft',
    type: 'invoice.created',
    data: { object: { ...baseInvoice, amount_due: 4900, status: 'draft' } },
  }).localType, 'invoice.draft');
  assert.equal(stripeEventToLocalPaymentWebhook({
    id: 'evt_invoice_open',
    type: 'invoice.finalized',
    data: { object: { ...baseInvoice, amount_due: 4900, status: 'open' } },
  }).localType, 'invoice.open');
  assert.equal(stripeEventToLocalPaymentWebhook({
    id: 'evt_invoice_uncollectible',
    type: 'invoice.marked_uncollectible',
    data: { object: { ...baseInvoice, amount_due: 4900, status: 'uncollectible' } },
  }).localType, 'invoice.uncollectible');
  assert.equal(stripeEventToLocalPaymentWebhook({
    id: 'evt_refund',
    type: 'refund.created',
    data: { object: { id: 're_123', amount: 1200, invoice: 'in_123', object: 'refund' } },
  }).localType, 'invoice.refunded');
  assert.equal(stripeEventToLocalPaymentWebhook({
    id: 'evt_charge_refunded',
    type: 'charge.refunded',
    data: { object: { id: 'ch_123', amount_refunded: 1200, invoice: 'in_123', object: 'charge' } },
  }).localType, 'invoice.refunded');
  assert.equal(stripeEventToLocalPaymentWebhook({
    id: 'evt_credit',
    type: 'credit_note.created',
    data: { object: { id: 'cn_123', amount: 900, invoice: 'in_123', object: 'credit_note' } },
  }).localType, 'invoice.credit_applied');
  assert.equal(stripeEventToLocalPaymentWebhook({
    id: 'evt_trial',
    type: 'customer.subscription.trial_will_end',
    data: {
      object: {
        id: 'sub_stripe_signal',
        object: 'subscription',
        status: 'trialing',
        trial_end: 1780527000,
      },
    },
  }).localType, 'subscription.trial_will_end');
});

test('signed Stripe parser returns ignored mapping for unknown but valid signed events', () => {
  const secret = 'whsec_unknown_event_test';
  const body = JSON.stringify({
    id: 'evt_unknown_signed',
    type: 'payment_intent.processing',
    livemode: false,
    data: { object: { id: 'pi_processing', object: 'payment_intent' } },
  });
  const signature = signStripeWebhookPayload(body, secret);
  const parsed = parseSignedStripeWebhook(body, signature, secret);

  assert.equal(parsed.mapping.localType, 'provider.event.ignored');
  assert.equal(parsed.verification.signatureStatus, 'verified');
});

test('resolveExpectedStripeLivemode honors SIGNAL_STRIPE_LIVEMODE and NODE_ENV fallback', () => {
  assert.equal(resolveExpectedStripeLivemode({ SIGNAL_STRIPE_LIVEMODE: 'true' }), true);
  assert.equal(resolveExpectedStripeLivemode({ SIGNAL_STRIPE_LIVEMODE: 'false' }), false);
  assert.equal(resolveExpectedStripeLivemode({ NODE_ENV: 'production' }), true);
  assert.equal(resolveExpectedStripeLivemode({ NODE_ENV: 'development' }), false);
});

test('assertStripeLivemodeMatches rejects cross-environment webhook delivery', () => {
  assert.throws(
    () => assertStripeLivemodeMatches(true, false),
    (error) => error.code === 'PAYMENT_WEBHOOK_LIVEMODE_MISMATCH',
  );
  assert.doesNotThrow(() => assertStripeLivemodeMatches(false, false));
});

test('signed Stripe webhook handler rejects livemode mismatch before mutating state', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-livemode-guard-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const secret = 'whsec_livemode_guard_test';
  const previousLivemode = process.env.SIGNAL_STRIPE_LIVEMODE;
  const previousNodeEnv = process.env.NODE_ENV;

  t.after(async () => {
    if (previousLivemode === undefined) {
      delete process.env.SIGNAL_STRIPE_LIVEMODE;
    } else {
      process.env.SIGNAL_STRIPE_LIVEMODE = previousLivemode;
    }
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  process.env.SIGNAL_STRIPE_LIVEMODE = 'true';

  const body = JSON.stringify({
    id: 'evt_livemode_mismatch',
    type: 'invoice.paid',
    created: 1_700_000_000,
    livemode: false,
    data: {
      object: {
        amount_due: 4900,
        customer: 'cus_signal',
        id: 'in_livemode_mismatch',
        object: 'invoice',
        subscription: 'sub_stripe_signal',
      },
    },
  });
  const signature = signStripeWebhookPayload(body, secret);

  await assert.rejects(
    () => handleSignedStripePaymentWebhook(body, signature, {
      actorUserId: 'usr_admin',
      endpointSecret: secret,
      statePath,
    }),
    (error) => error instanceof SignalStateError && error.code === 'PAYMENT_WEBHOOK_LIVEMODE_MISMATCH',
  );

  const state = await loadState({ statePath });
  assert.equal(
    state.paymentEvents.some((event) => event.providerEventId === 'evt_livemode_mismatch'),
    false,
    'livemode mismatch must not append payment events',
  );
});

test('subscription webhook ordering ignores stale provider events after cancellation', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-subscription-ordering-'));
  const statePath = path.join(tempDir, 'signal-state.json');

  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });

  await handlePaymentWebhook('subscription.updated', {
    planId: 'plan_team',
    provider: 'stripe',
    providerEventCreatedAt: 1_700_000_100,
    providerEventId: 'evt_sub_active',
    providerEventType: 'customer.subscription.updated',
    providerStatus: 'active',
    providerSubscriptionId: 'sub_stripe_signal',
    status: 'active',
    subscriptionId: 'sub_demo',
    tenantId: 'tenant_demo',
  }, { actorUserId: 'usr_admin', statePath });

  await handlePaymentWebhook('subscription.canceled', {
    planId: 'plan_team',
    provider: 'stripe',
    providerEventCreatedAt: 1_700_000_200,
    providerEventId: 'evt_sub_deleted',
    providerEventType: 'customer.subscription.deleted',
    providerStatus: 'canceled',
    providerSubscriptionId: 'sub_stripe_signal',
    subscriptionId: 'sub_demo',
    tenantId: 'tenant_demo',
  }, { actorUserId: 'usr_admin', statePath });

  const staleUpdate = await handlePaymentWebhook('subscription.updated', {
    planId: 'plan_team',
    provider: 'stripe',
    providerEventCreatedAt: 1_700_000_050,
    providerEventId: 'evt_sub_stale_active',
    providerEventType: 'customer.subscription.updated',
    providerStatus: 'active',
    providerSubscriptionId: 'sub_stripe_signal',
    status: 'active',
    subscriptionId: 'sub_demo',
    tenantId: 'tenant_demo',
  }, { actorUserId: 'usr_admin', statePath });

  assert.equal(staleUpdate.details.status, 'out_of_order');

  const state = await loadState({ statePath });
  const subscription = state.subscriptions.find((item) => item.id === 'sub_demo');
  assert.equal(subscription?.status, 'canceled');
  assert.equal(subscription?.providerLastEventCreatedAt, 1_700_000_200);
  assert(state.paymentEvents.some((event) => event.providerEventId === 'evt_sub_stale_active' && event.status === 'out_of_order'));
});

test('invoice webhooks do not advance Stripe subscription ordering watermark', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-invoice-ordering-'));
  const statePath = path.join(tempDir, 'signal-state.json');

  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });

  await handlePaymentWebhook('subscription.updated', {
    planId: 'plan_team',
    provider: 'stripe',
    providerEventCreatedAt: 1_700_000_100,
    providerEventId: 'evt_sub_active_ordering',
    providerEventType: 'customer.subscription.updated',
    providerStatus: 'active',
    providerSubscriptionId: 'sub_stripe_signal',
    status: 'active',
    subscriptionId: 'sub_demo',
    tenantId: 'tenant_demo',
  }, { actorUserId: 'usr_admin', statePath });

  await handlePaymentWebhook('invoice.paid', {
    amountDueCents: 4900,
    provider: 'stripe',
    providerEventCreatedAt: 1_700_000_200,
    providerEventId: 'evt_invoice_paid_ordering',
    providerEventType: 'invoice.paid',
    providerInvoiceId: 'in_signal_invoice_ordering',
    providerStatus: 'paid',
    providerSubscriptionId: 'sub_stripe_signal',
    subscriptionId: 'sub_demo',
    tenantId: 'tenant_demo',
  }, { actorUserId: 'usr_admin', statePath });

  const cancellation = await handlePaymentWebhook('subscription.canceled', {
    planId: 'plan_team',
    provider: 'stripe',
    providerEventCreatedAt: 1_700_000_150,
    providerEventId: 'evt_sub_canceled_after_invoice',
    providerEventType: 'customer.subscription.deleted',
    providerStatus: 'canceled',
    providerSubscriptionId: 'sub_stripe_signal',
    subscriptionId: 'sub_demo',
    tenantId: 'tenant_demo',
  }, { actorUserId: 'usr_admin', statePath });

  assert.equal(cancellation.details.status, 'canceled');

  const state = await loadState({ statePath });
  const subscription = state.subscriptions.find((item) => item.id === 'sub_demo');
  assert.equal(subscription?.status, 'canceled');
  assert.equal(subscription?.providerLastEventCreatedAt, 1_700_000_150);
  assert.equal(
    state.paymentEvents.some((event) => event.providerEventId === 'evt_sub_canceled_after_invoice' && event.status === 'out_of_order'),
    false,
  );
});

test('createStripeCheckoutSessionRequest includes subscriptionId metadata when subscription is known', () => {
  const request = createStripeCheckoutSessionRequest({
    tenant,
    plan: { id: 'plan_team' },
    subscription: { id: 'sub_demo' },
    env,
  });

  assert.equal(request.params.metadata.subscriptionId, 'sub_demo');
  assert.equal(request.params.subscription_data.metadata.subscriptionId, 'sub_demo');
});

test('invoice.paid mapper falls back to amount_paid when amount_due is absent', () => {
  const mapping = stripeEventToLocalPaymentWebhook({
    id: 'evt_invoice_paid_amount_paid',
    type: 'invoice.paid',
    data: {
      object: {
        amount_paid: 3125,
        customer: 'cus_signal',
        id: 'in_amount_paid',
        metadata: { subscriptionId: 'sub_demo' },
        object: 'invoice',
        subscription: 'sub_stripe_signal',
      },
    },
  });

  assert.equal(mapping.args.amountDueCents, 3125);
});

test('checkout.session.completed mapper preserves metadata subscriptionId', () => {
  const mapping = stripeEventToLocalPaymentWebhook({
    id: 'evt_checkout_sub_id',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_checkout_sub_id',
        customer: 'cus_signal',
        metadata: {
          planId: 'plan_team',
          subscriptionId: 'sub_checkout_target',
          tenantId: 'tenant_demo',
        },
        object: 'checkout.session',
        subscription: 'sub_stripe_checkout_new',
      },
    },
  });

  assert.equal(mapping.args.subscriptionId, 'sub_checkout_target');
  assert.equal(mapping.args.providerSubscriptionId, 'sub_stripe_checkout_new');
});

test('checkout.completed binds Stripe identifiers to the matching subscription', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-checkout-bind-'));
  const statePath = path.join(tempDir, 'signal-state.json');

  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const seeded = await loadState({ statePath });
  seeded.subscriptions.push({
    id: 'sub_legacy',
    tenantId: 'tenant_demo',
    planId: 'plan_team',
    provider: 'local_test',
    status: 'canceled',
  });
  await fs.writeFile(statePath, `${JSON.stringify(seeded, null, 2)}\n`);

  await handlePaymentWebhook('checkout.completed', {
    planId: 'plan_team',
    provider: 'stripe',
    providerCustomerId: 'cus_checkout_bind',
    providerEventId: 'evt_checkout_bind',
    providerEventType: 'checkout.session.completed',
    providerSessionId: 'cs_checkout_bind',
    providerStatus: 'complete',
    providerSubscriptionId: 'sub_stripe_checkout_bind',
    tenantId: 'tenant_demo',
  }, { actorUserId: 'usr_admin', statePath });

  const state = await loadState({ statePath });
  const legacy = state.subscriptions.find((item) => item.id === 'sub_demo');
  const bound = state.subscriptions.find((item) => item.providerSubscriptionId === 'sub_stripe_checkout_bind');
  assert.equal(legacy?.providerSubscriptionId, undefined);
  assert.equal(bound?.providerCustomerId, 'cus_checkout_bind');
  assert.equal(bound?.planId, 'plan_team');
  assert.notEqual(bound?.id, 'sub_demo');
});

test('checkout.completed uses metadata subscriptionId before creating a new subscription', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-checkout-metadata-'));
  const statePath = path.join(tempDir, 'signal-state.json');

  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const seeded = await loadState({ statePath });
  seeded.subscriptions.push({
    id: 'sub_checkout_target',
    tenantId: 'tenant_demo',
    planId: 'plan_team',
    provider: 'local_test',
    status: 'trialing',
  });
  await fs.writeFile(statePath, `${JSON.stringify(seeded, null, 2)}\n`);

  await handlePaymentWebhook('checkout.completed', {
    planId: 'plan_team',
    provider: 'stripe',
    providerCustomerId: 'cus_checkout_metadata',
    providerEventId: 'evt_checkout_metadata',
    providerEventType: 'checkout.session.completed',
    providerSessionId: 'cs_checkout_metadata',
    providerStatus: 'complete',
    providerSubscriptionId: 'sub_stripe_metadata_new',
    subscriptionId: 'sub_checkout_target',
    tenantId: 'tenant_demo',
  }, { actorUserId: 'usr_admin', statePath });

  const state = await loadState({ statePath });
  const target = state.subscriptions.find((item) => item.id === 'sub_checkout_target');
  const demo = state.subscriptions.find((item) => item.id === 'sub_demo');
  assert.equal(target?.providerSubscriptionId, 'sub_stripe_metadata_new');
  assert.equal(target?.status, 'active');
  assert.equal(demo?.providerSubscriptionId, undefined);
  assert.equal(state.subscriptions.filter((item) => item.tenantId === 'tenant_demo').length, 2);
});

test('Stripe invoice lifecycle webhooks reject missing amountDueCents', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-invoice-amount-required-'));
  const statePath = path.join(tempDir, 'signal-state.json');

  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });

  for (const type of [
    'invoice.draft',
    'invoice.open',
    'invoice.paid',
    'invoice.payment_failed',
    'invoice.uncollectible',
  ]) {
    await assert.rejects(
      () => handlePaymentWebhook(type, {
        provider: 'stripe',
        providerEventId: `evt_missing_amount_${type}`,
        providerEventType: type.replace('.', '_'),
        providerInvoiceId: `in_missing_${type}`,
        providerSubscriptionId: 'sub_stripe_signal',
        subscriptionId: 'sub_demo',
        tenantId: 'tenant_demo',
      }, { actorUserId: 'usr_admin', statePath }),
      (error) => error instanceof SignalStateError && error.code === 'ARG_INVALID',
    );
  }
});

test('Stripe invoice lifecycle webhooks reject malformed amountDueCents', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-invoice-amount-malformed-'));
  const statePath = path.join(tempDir, 'signal-state.json');

  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });

  for (const amountDueCents of ['not-a-number', 49.5]) {
    await assert.rejects(
      () => handlePaymentWebhook('invoice.paid', {
        amountDueCents,
        provider: 'stripe',
        providerEventId: `evt_malformed_amount_${amountDueCents}`,
        providerEventType: 'invoice.paid',
        providerInvoiceId: 'in_malformed_amount',
        providerSubscriptionId: 'sub_stripe_signal',
        subscriptionId: 'sub_demo',
        tenantId: 'tenant_demo',
      }, { actorUserId: 'usr_admin', statePath }),
      (error) => error instanceof SignalStateError && error.code === 'ARG_INVALID',
    );
  }
});

test('Stripe invoice.paid records the provider amount instead of plan defaults', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-invoice-amount-explicit-'));
  const statePath = path.join(tempDir, 'signal-state.json');

  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });

  await handlePaymentWebhook('invoice.paid', {
    amountDueCents: 3125,
    provider: 'stripe',
    providerEventId: 'evt_invoice_paid_explicit_amount',
    providerEventType: 'invoice.paid',
    providerInvoiceId: 'in_explicit_amount',
    providerSubscriptionId: 'sub_stripe_signal',
    subscriptionId: 'sub_demo',
    tenantId: 'tenant_demo',
  }, { actorUserId: 'usr_admin', statePath });

  const state = await loadState({ statePath });
  const invoice = state.invoices.find((item) => item.providerInvoiceId === 'in_explicit_amount');
  assert.equal(invoice?.amountDueCents, 3125);
});

test('refund.created does not double-apply a Stripe refund after charge.refunded', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-refund-dedup-'));
  const statePath = path.join(tempDir, 'signal-state.json');

  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });

  const invoicePaid = stripeEventToLocalPaymentWebhook({
    id: 'evt_invoice_paid_refund_dedup',
    type: 'invoice.paid',
    created: 1_700_000_000,
    data: {
      object: {
        amount_due: 4900,
        customer: 'cus_signal',
        id: 'in_refund_dedup',
        metadata: {
          subscriptionId: 'sub_demo',
          tenantId: 'tenant_demo',
        },
        object: 'invoice',
        subscription: 'sub_stripe_signal',
      },
    },
  });

  await handlePaymentWebhook(invoicePaid.localType, {
    ...invoicePaid.args,
    livemode: invoicePaid.livemode,
    provider: invoicePaid.provider,
    providerEventCreatedAt: invoicePaid.providerEventCreatedAt,
    providerEventId: invoicePaid.providerEventId,
    providerEventType: invoicePaid.eventType,
  }, { actorUserId: 'usr_admin', statePath });

  const canonicalRefund = stripeEventToLocalPaymentWebhook({
    id: 'evt_charge_refunded_dedup',
    type: 'charge.refunded',
    created: 1_700_000_100,
    data: {
      object: {
        amount_refunded: 1200,
        customer: 'cus_signal',
        id: 'ch_refund_dedup',
        invoice: 'in_refund_dedup',
        metadata: {
          subscriptionId: 'sub_demo',
          tenantId: 'tenant_demo',
        },
        object: 'charge',
        subscription: 'sub_stripe_signal',
      },
    },
  });

  const duplicateRefund = stripeEventToLocalPaymentWebhook({
    id: 'evt_refund_created_dedup',
    type: 'refund.created',
    created: 1_700_000_101,
    data: {
      object: {
        amount: 1200,
        customer: 'cus_signal',
        id: 're_refund_dedup',
        invoice: 'in_refund_dedup',
        metadata: {
          subscriptionId: 'sub_demo',
          tenantId: 'tenant_demo',
        },
        object: 'refund',
        subscription: 'sub_stripe_signal',
      },
    },
  });

  const canonicalResult = await handlePaymentWebhook(canonicalRefund.localType, {
    ...canonicalRefund.args,
    livemode: canonicalRefund.livemode,
    provider: canonicalRefund.provider,
    providerEventCreatedAt: canonicalRefund.providerEventCreatedAt,
    providerEventId: canonicalRefund.providerEventId,
    providerEventType: canonicalRefund.eventType,
  }, { actorUserId: 'usr_admin', statePath });
  const duplicateResult = await handlePaymentWebhook(duplicateRefund.localType, {
    ...duplicateRefund.args,
    livemode: duplicateRefund.livemode,
    provider: duplicateRefund.provider,
    providerEventCreatedAt: duplicateRefund.providerEventCreatedAt,
    providerEventId: duplicateRefund.providerEventId,
    providerEventType: duplicateRefund.eventType,
  }, { actorUserId: 'usr_admin', statePath });

  assert.equal(canonicalResult.details.status, 'paid');
  assert.equal(duplicateResult.details.status, 'ignored');

  const state = await loadState({ statePath });
  const invoice = state.invoices.find((item) => item.providerInvoiceId === 'in_refund_dedup');
  assert.equal(invoice?.amountDueCents, 4900);
  assert.equal(invoice?.refundedCents, 1200);
  assert.equal(invoice?.netAmountDueCents, 3700);
  assert.equal(
    state.paymentEvents.filter((event) => event.appliedType === 'invoice.refunded').length,
    1,
  );
  assert(
    state.paymentEvents.some((event) => event.providerEventId === 'evt_refund_created_dedup' && event.status === 'ignored'),
  );
});

test('charge.refunded applies cumulative Stripe refund totals across partial refunds', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-refund-partial-'));
  const statePath = path.join(tempDir, 'signal-state.json');

  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });

  await handlePaymentWebhook('invoice.paid', {
    amountDueCents: 4900,
    provider: 'stripe',
    providerEventCreatedAt: 1_700_000_000,
    providerEventId: 'evt_invoice_paid_partial_refund',
    providerEventType: 'invoice.paid',
    providerInvoiceId: 'in_partial_refund',
    providerStatus: 'paid',
    providerSubscriptionId: 'sub_stripe_signal',
    subscriptionId: 'sub_demo',
    tenantId: 'tenant_demo',
  }, { actorUserId: 'usr_admin', statePath });

  const firstRefund = stripeEventToLocalPaymentWebhook({
    id: 'evt_charge_refunded_partial_1',
    type: 'charge.refunded',
    created: 1_700_000_100,
    data: {
      object: {
        amount_refunded: 500,
        customer: 'cus_signal',
        id: 'ch_partial_refund',
        invoice: 'in_partial_refund',
        metadata: {
          subscriptionId: 'sub_demo',
          tenantId: 'tenant_demo',
        },
        object: 'charge',
        subscription: 'sub_stripe_signal',
      },
    },
  });
  const secondRefund = stripeEventToLocalPaymentWebhook({
    id: 'evt_charge_refunded_partial_2',
    type: 'charge.refunded',
    created: 1_700_000_200,
    data: {
      object: {
        amount_refunded: 800,
        customer: 'cus_signal',
        id: 'ch_partial_refund',
        invoice: 'in_partial_refund',
        metadata: {
          subscriptionId: 'sub_demo',
          tenantId: 'tenant_demo',
        },
        object: 'charge',
        subscription: 'sub_stripe_signal',
      },
    },
  });

  await handlePaymentWebhook(firstRefund.localType, {
    ...firstRefund.args,
    livemode: firstRefund.livemode,
    provider: firstRefund.provider,
    providerEventCreatedAt: firstRefund.providerEventCreatedAt,
    providerEventId: firstRefund.providerEventId,
    providerEventType: firstRefund.eventType,
  }, { actorUserId: 'usr_admin', statePath });
  await handlePaymentWebhook(secondRefund.localType, {
    ...secondRefund.args,
    livemode: secondRefund.livemode,
    provider: secondRefund.provider,
    providerEventCreatedAt: secondRefund.providerEventCreatedAt,
    providerEventId: secondRefund.providerEventId,
    providerEventType: secondRefund.eventType,
  }, { actorUserId: 'usr_admin', statePath });

  const state = await loadState({ statePath });
  const invoice = state.invoices.find((item) => item.providerInvoiceId === 'in_partial_refund');
  assert.equal(invoice?.refundedCents, 800);
  assert.equal(invoice?.netAmountDueCents, 4100);
});

test('refund.created applies a Stripe refund when charge.refunded was not delivered', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-refund-only-'));
  const statePath = path.join(tempDir, 'signal-state.json');

  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });

  await handlePaymentWebhook('invoice.paid', {
    amountDueCents: 4900,
    provider: 'stripe',
    providerEventCreatedAt: 1_700_000_000,
    providerEventId: 'evt_invoice_paid_refund_only',
    providerEventType: 'invoice.paid',
    providerInvoiceId: 'in_refund_only',
    providerStatus: 'paid',
    providerSubscriptionId: 'sub_stripe_signal',
    subscriptionId: 'sub_demo',
    tenantId: 'tenant_demo',
  }, { actorUserId: 'usr_admin', statePath });

  const refundOnly = stripeEventToLocalPaymentWebhook({
    id: 'evt_refund_created_only',
    type: 'refund.created',
    created: 1_700_000_100,
    data: {
      object: {
        amount: 900,
        customer: 'cus_signal',
        id: 're_refund_only',
        invoice: 'in_refund_only',
        metadata: {
          subscriptionId: 'sub_demo',
          tenantId: 'tenant_demo',
        },
        object: 'refund',
        subscription: 'sub_stripe_signal',
      },
    },
  });

  const result = await handlePaymentWebhook(refundOnly.localType, {
    ...refundOnly.args,
    livemode: refundOnly.livemode,
    provider: refundOnly.provider,
    providerEventCreatedAt: refundOnly.providerEventCreatedAt,
    providerEventId: refundOnly.providerEventId,
    providerEventType: refundOnly.eventType,
  }, { actorUserId: 'usr_admin', statePath });

  assert.equal(result.details.status, 'paid');

  const state = await loadState({ statePath });
  const invoice = state.invoices.find((item) => item.providerInvoiceId === 'in_refund_only');
  assert.equal(invoice?.refundedCents, 900);
  assert.equal(invoice?.netAmountDueCents, 4000);
});

test('Stripe mapper includes provider event created timestamp', () => {
  const mapping = stripeEventToLocalPaymentWebhook({
    id: 'evt_created_ts',
    type: 'customer.subscription.updated',
    created: 1_700_000_321,
    data: {
      object: {
        id: 'sub_stripe_signal',
        object: 'subscription',
        status: 'active',
      },
    },
  });

  assert.equal(mapping.providerEventCreatedAt, 1_700_000_321);
});
