import crypto from 'node:crypto';
import {
  providerFetch,
} from './signal-provider-fetch.mjs';

export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;
export const STRIPE_API_VERSION = '2026-02-25.clover';
export const STRIPE_API_BASE_URL = 'https://api.stripe.com/v1';
export const STRIPE_IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export class PaymentProviderError extends Error {
  constructor(message, { code = 'PAYMENT_PROVIDER_ERROR', status = 400, details = {} } = {}) {
    super(message);
    this.name = 'PaymentProviderError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PaymentProviderError(`${label} is required.`, {
      code: 'PAYMENT_PROVIDER_ARG_MISSING',
      details: { label },
    });
  }
  return value;
}

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stripeApiBaseUrl(env = process.env) {
  return (env.STRIPE_API_BASE_URL ?? STRIPE_API_BASE_URL).replace(/\/+$/, '');
}

function normalizeAppBaseUrl(env = process.env) {
  return (env.SIGNAL_APP_BASE_URL ?? env.SIGNAL_PUBLIC_APP_URL ?? 'http://127.0.0.1:5173').replace(/\/+$/, '');
}

function stripePlanSuffix(plan) {
  return String(plan?.stripePriceEnv ?? plan?.id ?? '')
    .replace(/^plan_/i, '')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase();
}

export function stripePriceEnvKeyForPlan(plan) {
  const suffix = stripePlanSuffix(plan);
  if (!suffix) {
    throw new PaymentProviderError('Plan id is required to resolve a Stripe price.', {
      code: 'PAYMENT_PROVIDER_PLAN_INVALID',
    });
  }
  return `SIGNAL_STRIPE_PRICE_${suffix}`;
}

export function stripePriceIdForPlan(plan, env = process.env) {
  const explicit = optionalString(plan?.stripePriceId);
  if (explicit) {
    return explicit;
  }
  return optionalString(env[stripePriceEnvKeyForPlan(plan)]) ?? optionalString(env[`STRIPE_PRICE_${stripePlanSuffix(plan)}`]);
}

function requireStripePriceId(plan, env) {
  const priceId = stripePriceIdForPlan(plan, env);
  if (!priceId) {
    throw new PaymentProviderError('Stripe recurring price id is required for live checkout.', {
      code: 'PAYMENT_PROVIDER_PRICE_MISSING',
      status: 412,
      details: { requiredEnv: stripePriceEnvKeyForPlan(plan), planId: plan?.id },
    });
  }
  return priceId;
}

function safeStripeCustomerId({ subscription, tenant, fallback }) {
  return optionalString(fallback)
    ?? optionalString(subscription?.providerCustomerId)
    ?? optionalString(subscription?.stripeCustomerId)
    ?? optionalString(subscription?.customerId)
    ?? optionalString(tenant?.providerCustomerId)
    ?? optionalString(tenant?.stripeCustomerId);
}

function appendStripeFormValue(form, key, value) {
  if (value === undefined || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendStripeFormValue(form, `${key}[${index}]`, item));
    return;
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([childKey, childValue]) => appendStripeFormValue(form, `${key}[${childKey}]`, childValue));
    return;
  }
  form.append(key, String(value));
}

export function encodeStripeForm(params) {
  const form = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => appendStripeFormValue(form, key, value));
  return form.toString();
}

function digestStripeRequest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);
}

function idempotencyPart(value, fallback) {
  const normalized = optionalString(value)?.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function idempotencyAttemptPart(sessionAttempt) {
  const attemptValue = typeof sessionAttempt === 'number'
    ? (Number.isSafeInteger(sessionAttempt) && sessionAttempt > 0 ? String(sessionAttempt) : null)
    : sessionAttempt;
  const normalized = idempotencyPart(attemptValue, null);
  if (!normalized) {
    throw new PaymentProviderError('Stripe session attempt scope is required for derived idempotency keys.', {
      code: 'PAYMENT_PROVIDER_IDEMPOTENCY_SCOPE_MISSING',
      status: 500,
    });
  }
  return normalized;
}

function finalizeStripeIdempotencyKey(prefix, parts) {
  const canonicalKey = [prefix, ...parts].join('\0');
  const digest = crypto.createHash('sha256').update(canonicalKey, 'utf8').digest('hex');
  return `${prefix}-${digest}`;
}

export function stripeCheckoutIdempotencyKey({ tenant, plan, subscription, sessionAttempt } = {}) {
  return finalizeStripeIdempotencyKey('signal-checkout', [
    idempotencyPart(tenant?.id, 'tenant'),
    idempotencyPart(plan?.id, 'plan'),
    idempotencyPart(subscription?.id ?? subscription?.providerSubscriptionId ?? subscription?.stripeSubscriptionId, 'new'),
    idempotencyAttemptPart(sessionAttempt),
  ]);
}

export function stripeBillingPortalIdempotencyKey({ tenant, subscription, stripeCustomerId, sessionAttempt } = {}) {
  const customerId = safeStripeCustomerId({ fallback: stripeCustomerId, subscription, tenant });
  return finalizeStripeIdempotencyKey('signal-portal', [
    idempotencyPart(tenant?.id, 'tenant'),
    idempotencyPart(subscription?.id ?? subscription?.providerSubscriptionId ?? subscription?.stripeSubscriptionId, 'subscription'),
    idempotencyPart(customerId, 'customer'),
    idempotencyAttemptPart(sessionAttempt),
  ]);
}

async function parseStripeResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PaymentProviderError('Stripe API response was not valid JSON.', {
      code: 'PAYMENT_PROVIDER_RESPONSE_INVALID',
      status: 502,
    });
  }
}

async function postStripeForm(endpoint, params, { env = process.env, fetchImpl = fetch, idempotencyKey } = {}) {
  const secretKey = requireString(env.STRIPE_SECRET_KEY, 'STRIPE_SECRET_KEY');
  if (!fetchImpl) {
    throw new PaymentProviderError('Fetch implementation is required for live Stripe requests.', {
      code: 'PAYMENT_PROVIDER_FETCH_MISSING',
      status: 500,
    });
  }

  const body = encodeStripeForm(params);
  const response = await providerFetch(endpoint, {
    body,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': STRIPE_API_VERSION,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    method: 'POST',
  }, { env, fetchImpl });
  const payload = await parseStripeResponse(response);
  if (!response.ok) {
    throw new PaymentProviderError(payload.error?.message ?? 'Stripe API request failed.', {
      code: 'PAYMENT_PROVIDER_REQUEST_FAILED',
      status: response.status,
      details: {
        endpoint,
        requestDigest: digestStripeRequest(body),
        stripeErrorCode: payload.error?.code,
        stripeErrorType: payload.error?.type,
        stripeRequestId: response.headers?.get?.('request-id') ?? response.headers?.get?.('stripe-request-id') ?? null,
      },
    });
  }

  return {
    payload,
    request: {
      apiVersion: STRIPE_API_VERSION,
      bodyDigest: digestStripeRequest(body),
      endpoint,
      idempotencyKey,
    },
  };
}

export function createStripeCheckoutSessionRequest({ tenant, plan, subscription, env = process.env, stripeCustomerId } = {}) {
  const priceId = requireStripePriceId(plan, env);
  const customerId = safeStripeCustomerId({ fallback: stripeCustomerId, subscription, tenant });
  const appBaseUrl = normalizeAppBaseUrl(env);
  const successUrl = env.SIGNAL_STRIPE_SUCCESS_URL ?? `${appBaseUrl}/#workspace?billing=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = env.SIGNAL_STRIPE_CANCEL_URL ?? `${appBaseUrl}/#workspace?billing=cancel`;
  const metadata = {
    planId: plan.id,
    signalPlanId: plan.id,
    signalTenantId: tenant.id,
    tenantId: tenant.id,
  };

  return {
    endpoint: `${stripeApiBaseUrl(env)}/checkout/sessions`,
    params: {
      allow_promotion_codes: env.SIGNAL_STRIPE_ALLOW_PROMOTION_CODES === 'true' ? true : undefined,
      cancel_url: cancelUrl,
      client_reference_id: tenant.id,
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata,
      mode: 'subscription',
      success_url: successUrl,
      subscription_data: { metadata },
    },
    priceEnv: stripePriceEnvKeyForPlan(plan),
    priceId,
  };
}

export async function createStripeCheckoutSession({ tenant, plan, subscription, env = process.env, fetchImpl = fetch, idempotencyKey, sessionAttempt, stripeCustomerId } = {}) {
  const request = createStripeCheckoutSessionRequest({ tenant, plan, subscription, env, stripeCustomerId });
  const requestIdempotencyKey = idempotencyKey ?? stripeCheckoutIdempotencyKey({ tenant, plan, subscription, sessionAttempt });
  const result = await postStripeForm(request.endpoint, request.params, { env, fetchImpl, idempotencyKey: requestIdempotencyKey });
  const session = result.payload;
  return {
    expiresAt: typeof session.expires_at === 'number' ? new Date(session.expires_at * 1000).toISOString() : null,
    mode: 'live',
    priceEnv: request.priceEnv,
    priceId: request.priceId,
    provider: 'stripe',
    providerCustomerId: typeof session.customer === 'string' ? session.customer : null,
    providerRequestDigest: result.request.bodyDigest,
    providerSessionId: session.id,
    requestIdempotencyKey: result.request.idempotencyKey,
    url: session.url,
  };
}

export function createStripeBillingPortalSessionRequest({ tenant, subscription, env = process.env, stripeCustomerId } = {}) {
  const customerId = safeStripeCustomerId({ fallback: stripeCustomerId, subscription, tenant });
  if (!customerId) {
    throw new PaymentProviderError('Stripe customer id is required for live billing portal sessions.', {
      code: 'PAYMENT_PROVIDER_CUSTOMER_MISSING',
      status: 412,
      details: { tenantId: tenant?.id },
    });
  }
  const appBaseUrl = normalizeAppBaseUrl(env);
  return {
    customerId,
    endpoint: `${stripeApiBaseUrl(env)}/billing_portal/sessions`,
    params: {
      customer: customerId,
      return_url: env.SIGNAL_STRIPE_PORTAL_RETURN_URL ?? `${appBaseUrl}/#admin?billing=portal_return`,
    },
  };
}

export async function createStripeBillingPortalSession({ tenant, subscription, env = process.env, fetchImpl = fetch, idempotencyKey, sessionAttempt, stripeCustomerId } = {}) {
  const request = createStripeBillingPortalSessionRequest({ tenant, subscription, env, stripeCustomerId });
  const requestIdempotencyKey = idempotencyKey ?? stripeBillingPortalIdempotencyKey({ tenant, subscription, sessionAttempt, stripeCustomerId });
  const result = await postStripeForm(request.endpoint, request.params, { env, fetchImpl, idempotencyKey: requestIdempotencyKey });
  const session = result.payload;
  return {
    expiresAt: null,
    mode: 'live',
    provider: 'stripe',
    providerCustomerId: request.customerId,
    providerRequestDigest: result.request.bodyDigest,
    providerSessionId: session.id,
    requestIdempotencyKey: result.request.idempotencyKey,
    url: session.url,
  };
}

export function parseStripeSignatureHeader(signatureHeader) {
  const header = requireString(signatureHeader, 'Stripe-Signature header');
  const pairs = header.split(',').map((part) => part.trim()).filter(Boolean);
  let timestamp = null;
  const signatures = [];

  pairs.forEach((pair) => {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex < 0) {
      return;
    }
    const key = pair.slice(0, separatorIndex);
    const value = pair.slice(separatorIndex + 1);
    if (key === 't') {
      timestamp = Number(value);
    } else if (key === 'v1') {
      signatures.push(value);
    }
  });

  if (!Number.isFinite(timestamp)) {
    throw new PaymentProviderError('Stripe webhook signature is missing a valid timestamp.', {
      code: 'PAYMENT_WEBHOOK_TIMESTAMP_MISSING',
    });
  }

  if (signatures.length === 0) {
    throw new PaymentProviderError('Stripe webhook signature is missing a v1 digest.', {
      code: 'PAYMENT_WEBHOOK_SIGNATURE_MISSING',
    });
  }

  return { signatures, timestamp };
}

function stripeSignedPayload(rawBody, timestamp) {
  return `${timestamp}.${rawBody}`;
}

function hmacSha256Hex(value, signingValue) {
  return crypto.createHmac('sha256', value).update(signingValue, 'utf8').digest('hex');
}

function timingSafeHexEqual(left, right) {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) {
    return false;
  }
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function signStripeWebhookPayload(rawBody, endpointSecret, { timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const body = requireString(rawBody, 'raw webhook body');
  const secret = requireString(endpointSecret, 'Stripe webhook endpoint secret');
  const signature = hmacSha256Hex(secret, stripeSignedPayload(body, timestamp));
  return `t=${timestamp},v1=${signature}`;
}

export function verifyStripeWebhookSignature(rawBody, signatureHeader, endpointSecret, { nowMs = Date.now(), toleranceSeconds = STRIPE_WEBHOOK_TOLERANCE_SECONDS } = {}) {
  const body = requireString(rawBody, 'raw webhook body');
  const secret = requireString(endpointSecret, 'Stripe webhook endpoint secret');
  const parsed = parseStripeSignatureHeader(signatureHeader);
  const ageSeconds = Math.floor(nowMs / 1000) - parsed.timestamp;

  if (ageSeconds > toleranceSeconds || ageSeconds < 0) {
    throw new PaymentProviderError('Stripe webhook signature timestamp is outside the allowed tolerance.', {
      code: 'PAYMENT_WEBHOOK_TIMESTAMP_STALE',
      details: { ageSeconds, toleranceSeconds, timestamp: parsed.timestamp },
    });
  }

  const expected = hmacSha256Hex(secret, stripeSignedPayload(body, parsed.timestamp));
  const matched = parsed.signatures.some((signature) => timingSafeHexEqual(signature, expected));
  if (!matched) {
    throw new PaymentProviderError('Stripe webhook signature verification failed.', {
      code: 'PAYMENT_WEBHOOK_SIGNATURE_INVALID',
    });
  }

  return {
    ageSeconds,
    signatureStatus: 'verified',
    timestamp: parsed.timestamp,
    toleranceSeconds,
    verifiedAt: new Date(nowMs).toISOString(),
  };
}

function objectMetadata(object) {
  return object && typeof object === 'object' && object.metadata && typeof object.metadata === 'object'
    ? object.metadata
    : {};
}

function objectId(value) {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (value && typeof value === 'object' && typeof value.id === 'string' && value.id.length > 0) {
    return value.id;
  }
  return null;
}

function metadataSubscriptionId(metadata) {
  if (metadata.subscriptionId || metadata.signalSubscriptionId) {
    return metadata.subscriptionId ?? metadata.signalSubscriptionId;
  }
  return null;
}

function metadataTenantId(metadata, object) {
  return metadata.tenantId ?? metadata.signalTenantId ?? object.client_reference_id ?? null;
}

function metadataPlanId(metadata) {
  return metadata.planId ?? metadata.signalPlanId ?? null;
}

function objectProviderSubscriptionId(object) {
  return objectId(object.subscription) ?? (object.object === 'subscription' ? objectId(object) : null);
}

function objectCustomerId(object) {
  return objectId(object.customer);
}

function objectInvoiceId(object) {
  return object.object === 'invoice' ? objectId(object) : objectId(object.invoice) ?? objectId(object.latest_invoice);
}

function objectPriceId(object) {
  const firstLine = Array.isArray(object.lines?.data) ? object.lines.data[0] : null;
  const firstItem = Array.isArray(object.items?.data) ? object.items.data[0] : null;
  return objectId(object.price)
    ?? objectId(object.plan)
    ?? objectId(firstLine?.price)
    ?? objectId(firstLine?.plan)
    ?? objectId(firstItem?.price)
    ?? objectId(firstItem?.plan);
}

function objectAmountCents(object) {
  const value = object.amount
    ?? object.amount_due
    ?? object.amount_refunded
    ?? object.amount_paid
    ?? object.total;
  return Number.isFinite(value) ? value : undefined;
}

function ignoredStripeEventMapping({
  eventType,
  livemode,
  providerCustomerId,
  providerEventId,
  providerInvoiceId,
  providerPriceId,
  providerSubscriptionId,
  subscriptionId,
  tenantId,
  amountCents,
  providerStatus,
}) {
  return {
    args: {
      amountCents,
      providerCustomerId,
      providerInvoiceId,
      providerPriceId,
      providerStatus,
      providerSubscriptionId,
      subscriptionId,
      tenantId,
    },
    eventType,
    livemode,
    localType: 'provider.event.ignored',
    provider: 'stripe',
    providerEventId,
  };
}

function unixSecondsToIso(value) {
  return Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined;
}

function mapStripeSubscriptionStatus(status) {
  if (['trialing', 'active', 'past_due', 'canceled'].includes(status)) {
    return status;
  }
  if (status === 'unpaid' || status === 'incomplete' || status === 'paused') {
    return 'past_due';
  }
  if (status === 'incomplete_expired') {
    return 'canceled';
  }
  return 'active';
}

function requireMappedValue(value, label, eventType) {
  if (!value) {
    throw new PaymentProviderError(`Stripe ${eventType} event is missing ${label}.`, {
      code: 'PAYMENT_WEBHOOK_MAPPING_MISSING',
      details: { eventType, label },
    });
  }
  return value;
}

export function resolveExpectedStripeLivemode(env = process.env) {
  const configured = env.SIGNAL_STRIPE_LIVEMODE;
  if (configured === 'true') {
    return true;
  }
  if (configured === 'false') {
    return false;
  }
  return env.NODE_ENV === 'production';
}

export function assertStripeLivemodeMatches(expectedLivemode, actualLivemode) {
  if (typeof actualLivemode !== 'boolean') {
    throw new PaymentProviderError('Stripe webhook event is missing livemode.', {
      code: 'PAYMENT_WEBHOOK_LIVEMODE_MISSING',
      status: 400,
    });
  }
  if (actualLivemode !== expectedLivemode) {
    throw new PaymentProviderError(
      `Stripe webhook livemode:${actualLivemode} does not match deployment expectation (${expectedLivemode}).`,
      {
        code: 'PAYMENT_WEBHOOK_LIVEMODE_MISMATCH',
        status: 400,
        details: { expectedLivemode, actualLivemode },
      },
    );
  }
}

function finalizeStripeEventMapping(event, mapping) {
  return {
    ...mapping,
    providerEventCreatedAt: Number.isFinite(event.created) ? event.created : undefined,
  };
}

export function stripeEventToLocalPaymentWebhook(event) {
  if (!event || typeof event !== 'object') {
    throw new PaymentProviderError('Stripe webhook payload must be a JSON event object.', {
      code: 'PAYMENT_WEBHOOK_PAYLOAD_INVALID',
    });
  }

  const providerEventId = requireMappedValue(event.id, 'event id', event.type ?? 'unknown');
  const eventType = requireMappedValue(event.type, 'event type', providerEventId);
  const object = event.data?.object ?? {};
  const metadata = objectMetadata(object);
  const tenantId = metadataTenantId(metadata, object);
  const planId = metadataPlanId(metadata);
  const localSubscriptionId = metadataSubscriptionId(metadata);
  const providerSubscriptionId = objectProviderSubscriptionId(object);
  const subscriptionId = localSubscriptionId ?? providerSubscriptionId;
  const providerCustomerId = objectCustomerId(object);
  const providerInvoiceId = objectInvoiceId(object);
  const providerPriceId = objectPriceId(object);
  const amountCents = objectAmountCents(object);

  if (eventType === 'checkout.session.completed') {
    return finalizeStripeEventMapping(event, {
      args: {
        planId: requireMappedValue(planId, 'metadata.planId', eventType),
        providerCustomerId,
        providerSessionId: objectId(object),
        providerSubscriptionId,
        tenantId: requireMappedValue(tenantId, 'metadata.tenantId', eventType),
      },
      eventType,
      livemode: Boolean(event.livemode),
      localType: 'checkout.completed',
      provider: 'stripe',
      providerEventId,
    });
  }

  if (eventType === 'invoice.paid') {
    return finalizeStripeEventMapping(event, {
      args: {
        amountDueCents: Number.isFinite(object.amount_due) ? object.amount_due : undefined,
        hostedInvoiceUrl: optionalString(object.hosted_invoice_url),
        nextPaymentAttemptAt: unixSecondsToIso(object.next_payment_attempt),
        providerCustomerId,
        providerInvoiceId,
        providerPriceId,
        providerSubscriptionId,
        subscriptionId: requireMappedValue(subscriptionId, 'subscription id', eventType),
      },
      eventType,
      livemode: Boolean(event.livemode),
      localType: 'invoice.paid',
      provider: 'stripe',
      providerEventId,
    });
  }

  if (eventType === 'invoice.created' || eventType === 'invoice.finalized') {
    return finalizeStripeEventMapping(event, {
      args: {
        amountDueCents: Number.isFinite(object.amount_due) ? object.amount_due : amountCents,
        hostedInvoiceUrl: optionalString(object.hosted_invoice_url),
        nextPaymentAttemptAt: unixSecondsToIso(object.next_payment_attempt),
        providerCustomerId,
        providerInvoiceId,
        providerPriceId,
        providerStatus: object.status,
        providerSubscriptionId,
        subscriptionId: requireMappedValue(subscriptionId, 'subscription id', eventType),
      },
      eventType,
      livemode: Boolean(event.livemode),
      localType: eventType === 'invoice.created' && object.status === 'draft' ? 'invoice.draft' : 'invoice.open',
      provider: 'stripe',
      providerEventId,
    });
  }

  if (eventType === 'invoice.marked_uncollectible' || eventType === 'invoice.voided') {
    return finalizeStripeEventMapping(event, {
      args: {
        amountDueCents: Number.isFinite(object.amount_due) ? object.amount_due : amountCents,
        hostedInvoiceUrl: optionalString(object.hosted_invoice_url),
        nextPaymentAttemptAt: unixSecondsToIso(object.next_payment_attempt),
        providerCustomerId,
        providerInvoiceId,
        providerPriceId,
        providerStatus: object.status,
        providerSubscriptionId,
        subscriptionId: requireMappedValue(subscriptionId, 'subscription id', eventType),
      },
      eventType,
      livemode: Boolean(event.livemode),
      localType: eventType === 'invoice.marked_uncollectible' ? 'invoice.uncollectible' : 'invoice.void',
      provider: 'stripe',
      providerEventId,
    });
  }

  if (eventType === 'invoice.payment_failed' || eventType === 'invoice.payment_action_required') {
    return finalizeStripeEventMapping(event, {
      args: {
        amountDueCents: Number.isFinite(object.amount_due) ? object.amount_due : undefined,
        hostedInvoiceUrl: optionalString(object.hosted_invoice_url),
        nextPaymentAttemptAt: unixSecondsToIso(object.next_payment_attempt),
        providerCustomerId,
        providerInvoiceId,
        providerPriceId,
        providerSubscriptionId,
        subscriptionId: requireMappedValue(subscriptionId, 'subscription id', eventType),
      },
      eventType,
      livemode: Boolean(event.livemode),
      localType: 'invoice.payment_failed',
      provider: 'stripe',
      providerEventId,
    });
  }

  if (eventType === 'customer.subscription.created' || eventType === 'customer.subscription.updated' || eventType === 'customer.subscription.paused' || eventType === 'customer.subscription.resumed' || eventType === 'customer.subscription.trial_will_end') {
    const mappedStatus = eventType === 'customer.subscription.paused'
      ? 'past_due'
      : eventType === 'customer.subscription.resumed'
        ? 'active'
        : eventType === 'customer.subscription.trial_will_end'
          ? 'trialing'
          : mapStripeSubscriptionStatus(object.status);
    return finalizeStripeEventMapping(event, {
      args: {
        status: mappedStatus,
        planId,
        tenantId,
        providerCustomerId,
        providerInvoiceId,
        providerPriceId,
        providerStatus: object.status,
        providerSubscriptionId,
        currentPeriodEndAt: unixSecondsToIso(object.current_period_end),
        trialEndsAt: unixSecondsToIso(object.trial_end),
        subscriptionId: requireMappedValue(subscriptionId, 'subscription id', eventType),
      },
      eventType,
      livemode: Boolean(event.livemode),
      localType: eventType === 'customer.subscription.trial_will_end' ? 'subscription.trial_will_end' : 'subscription.updated',
      provider: 'stripe',
      providerEventId,
    });
  }

  if (eventType === 'customer.subscription.deleted') {
    return finalizeStripeEventMapping(event, {
      args: {
        tenantId,
        planId,
        providerCustomerId,
        providerInvoiceId,
        providerPriceId,
        providerStatus: object.status,
        providerSubscriptionId,
        subscriptionId: requireMappedValue(subscriptionId, 'subscription id', eventType),
      },
      eventType,
      livemode: Boolean(event.livemode),
      localType: 'subscription.canceled',
      provider: 'stripe',
      providerEventId,
    });
  }

  if (eventType === 'charge.refunded' || eventType === 'refund.created') {
    return finalizeStripeEventMapping(event, {
      args: {
        amountCents,
        providerCustomerId,
        providerInvoiceId,
        providerPriceId,
        providerStatus: object.status,
        providerSubscriptionId,
        subscriptionId,
        tenantId,
      },
      eventType,
      livemode: Boolean(event.livemode),
      localType: 'invoice.refunded',
      provider: 'stripe',
      providerEventId,
    });
  }

  if (eventType.startsWith('refund.')) {
    return finalizeStripeEventMapping(event, ignoredStripeEventMapping({
      amountCents,
      eventType,
      livemode: Boolean(event.livemode),
      providerCustomerId,
      providerEventId,
      providerInvoiceId,
      providerPriceId,
      providerStatus: object.status,
      providerSubscriptionId,
      subscriptionId,
      tenantId,
    }));
  }

  if (eventType.startsWith('credit_note.')) {
    return finalizeStripeEventMapping(event, {
      args: {
        amountCents,
        providerCustomerId,
        providerInvoiceId,
        providerPriceId,
        providerStatus: object.status,
        providerSubscriptionId,
        subscriptionId,
        tenantId,
      },
      eventType,
      livemode: Boolean(event.livemode),
      localType: 'invoice.credit_applied',
      provider: 'stripe',
      providerEventId,
    });
  }

  if (eventType.startsWith('customer.balance_transaction.')) {
    return finalizeStripeEventMapping(event, {
      args: {
        amountCents,
        providerCustomerId,
        providerInvoiceId,
        providerPriceId,
        providerStatus: object.status,
        providerSubscriptionId,
        subscriptionId,
        tenantId,
      },
      eventType,
      livemode: Boolean(event.livemode),
      localType: 'customer.balance_adjusted',
      provider: 'stripe',
      providerEventId,
    });
  }

  return finalizeStripeEventMapping(event, ignoredStripeEventMapping({
    amountCents,
    eventType,
    livemode: Boolean(event.livemode),
    providerCustomerId,
    providerEventId,
    providerInvoiceId,
    providerPriceId,
    providerStatus: object.status,
    providerSubscriptionId,
    subscriptionId,
    tenantId,
  }));
}

export function parseSignedStripeWebhook(rawBody, signatureHeader, endpointSecret, options = {}) {
  const verification = verifyStripeWebhookSignature(rawBody, signatureHeader, endpointSecret, options);
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw new PaymentProviderError('Stripe webhook body is not valid JSON.', {
      code: 'PAYMENT_WEBHOOK_JSON_INVALID',
    });
  }

  return {
    event,
    mapping: stripeEventToLocalPaymentWebhook(event),
    verification,
  };
}
