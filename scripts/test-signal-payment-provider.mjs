#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  STRIPE_IDEMPOTENCY_KEY_MAX_LENGTH,
  createStripeBillingPortalSession,
  createStripeCheckoutSession,
  stripeBillingPortalIdempotencyKey,
  stripeCheckoutIdempotencyKey,
} from './signal-payment-provider.mjs';
import {
  bootstrapState,
  createCheckoutSession,
  loadState,
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

  assert.equal(stripeCheckoutIdempotencyKey({ plan, sessionAttempt: 1, subscription, tenant }), 'signal-checkout-tenant_demo-plan_team-sub_demo-1');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'signal-checkout-tenant_demo-plan_team-sub_demo-1');
  assert.equal(checkout.requestIdempotencyKey, 'signal-checkout-tenant_demo-plan_team-sub_demo-1');
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

  assert.equal(stripeBillingPortalIdempotencyKey({ sessionAttempt: 2, subscription, tenant }), 'signal-portal-tenant_demo-sub_demo-cus_signal-2');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'signal-portal-tenant_demo-sub_demo-cus_signal-2');
  assert.equal(portal.requestIdempotencyKey, 'signal-portal-tenant_demo-sub_demo-cus_signal-2');
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
  assert.match(key, /^signal-checkout-[a-f0-9]{32}$/);
  assert.equal(key, stripeCheckoutIdempotencyKey({
    plan: longPlan,
    sessionAttempt: 1,
    subscription: longSubscription,
    tenant: longTenant,
  }));
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
