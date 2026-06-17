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
  }).localType, 'provider.event.ignored');
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
