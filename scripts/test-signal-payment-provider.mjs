#!/usr/bin/env node

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStripeBillingPortalSession,
  createStripeCheckoutSession,
  stripeBillingPortalIdempotencyKey,
  stripeCheckoutIdempotencyKey,
} from './signal-payment-provider.mjs';

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
    subscription,
    tenant,
  });

  assert.equal(stripeCheckoutIdempotencyKey({ plan, subscription, tenant }), 'signal-checkout-tenant_demo-plan_team-sub_demo');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'signal-checkout-tenant_demo-plan_team-sub_demo');
  assert.equal(checkout.requestIdempotencyKey, 'signal-checkout-tenant_demo-plan_team-sub_demo');
});

test('billing portal sessions derive a stable Stripe idempotency key by default', async () => {
  const calls = [];
  const portal = await createStripeBillingPortalSession({
    env,
    fetchImpl: stripeFetchRecorder(calls),
    subscription,
    tenant,
  });

  assert.equal(stripeBillingPortalIdempotencyKey({ subscription, tenant }), 'signal-portal-tenant_demo-sub_demo-cus_signal');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'signal-portal-tenant_demo-sub_demo-cus_signal');
  assert.equal(portal.requestIdempotencyKey, 'signal-portal-tenant_demo-sub_demo-cus_signal');
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
