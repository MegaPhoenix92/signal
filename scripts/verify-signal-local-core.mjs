#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SignalStateError,
  acceptUserInvite,
  assignSignal,
  bootstrapState,
  cancelSubscription,
  claimUserInvite,
  clientExposureSecretPaths,
  completeMailboxConnection,
  completeMailboxConnectionFromOAuthCallback,
  compTenant,
  createAccountReview,
  createBillingOverride,
  createBillingPortalSession,
  createCheckoutSession,
  createDataRequest,
  createInvoiceRecoverySession,
  createIncidentNote,
  createMailboxConnectionSession,
  createRedactionRule,
  createSignalHandoff,
  createSuppressionRule,
  createTenantWorkspace,
  createUserInvite,
  disconnectMailbox,
  drainJobs,
  doctor,
  handlePaymentWebhook,
  handleEmailDeliveryWebhook,
  handleSignedEmailDeliveryWebhook,
  handleSignedSendGridEmailDeliveryWebhook,
  handleSignedStripePaymentWebhook,
  handleProviderWatchNotification,
  issueSessionToken,
  loadState,
  providerReadiness,
  providerValidationSchedulesDue,
  recordInvoiceRefund,
  recordProviderSandboxValidation,
  redactClientStateSecrets,
  recordSignalFeedback,
  resolveIncidentNote,
  replayMailbox,
  renewMailboxWatch,
  retryJob,
  revokeBillingOverride,
  revokeSessionToken,
  revokeUserInvite,
  runJobs,
  runEmailFlows,
  runNotificationDigest,
  saveState,
  setAccountActionStatus,
  setDataRequestStatus,
  setEmailDeliveryStatus,
  setEmailFlowStatus,
  setEmailFlowRouting,
  setGovernancePolicy,
  setModelGovernancePolicy,
  setMailboxStatus,
  setNotificationPreference,
  setNotificationStatus,
  setProviderValidationSchedule,
  setSignalQualityThreshold,
  setSignalHandoffStatus,
  setSignalStatus,
  setTenantDomain,
  setTenantStatus,
  setRedactionRuleStatus,
  setSuppressionRuleStatus,
  setUserRole,
  setUserStatus,
  setupMailboxWatch,
  syncPaymentState,
  switchSession,
  syncMailbox,
  unsubscribeEmailDigest,
  verifyLocalSessionToken,
} from './signal-state.mjs';
import {
  createProviderWatchSecret,
} from './signal-provider-watch.mjs';
import {
  signStripeWebhookPayload,
} from './signal-payment-provider.mjs';
import {
  deliverEmailMessage,
  signEmailWebhookPayload,
  signSendGridWebhookPayload,
} from './signal-email-provider.mjs';
import {
  decryptVaultPayload,
  listProviderCredentialRecords,
} from './signal-token-vault.mjs';
import {
  validateProviderSandbox,
} from './signal-provider-sandbox.mjs';
import {
  backendReadiness,
} from './signal-backend-readiness.mjs';


export async function verifySignalLocal() {
process.env.SIGNAL_OAUTH_STATE_KEY ??= 'signal-local-oauth-state-key';

const statePath = path.join(os.tmpdir(), `signal-verify-${Date.now()}.json`);
const registrationStatePath = path.join(os.tmpdir(), `signal-registration-verify-${Date.now()}.json`);
const vaultPath = path.join(os.tmpdir(), `signal-vault-${Date.now()}.json`);

const missingProviderReadiness = providerReadiness({});
assert.equal(missingProviderReadiness.ok, false);
assert(missingProviderReadiness.providers.some((provider) => provider.id === 'gmail' && provider.missingRequired.includes('SIGNAL_GMAIL_CLIENT_SECRET')));

const configuredProviderReadiness = providerReadiness({
  SIGNAL_GMAIL_CLIENT_ID: 'configured',
  SIGNAL_GMAIL_CLIENT_SECRET: 'configured',
  SIGNAL_GMAIL_REDIRECT_URI: 'configured',
  SIGNAL_OUTLOOK_CLIENT_ID: 'configured',
  SIGNAL_OUTLOOK_CLIENT_SECRET: 'configured',
  SIGNAL_OUTLOOK_TENANT_ID: 'configured',
  SIGNAL_OUTLOOK_REDIRECT_URI: 'configured',
  SIGNAL_EMAIL_PROVIDER_URL: 'configured',
  SIGNAL_EMAIL_PROVIDER_TOKEN: 'configured',
  SIGNAL_EMAIL_FROM: 'configured',
  SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET: 'configured',
  SIGNAL_SENDGRID_API_KEY: 'configured',
  SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: 'configured',
  SIGNAL_SENDGRID_ASM_GROUP_ID: '12345',
  SIGNAL_SENDGRID_CATEGORIES: 'sales_signal,product_ideas',
  SIGNAL_SENDGRID_CLICK_TRACKING: 'false',
  SIGNAL_SENDGRID_OPEN_TRACKING: 'false',
  STRIPE_SECRET_KEY: 'configured',
  STRIPE_WEBHOOK_SECRET: 'configured',
  SIGNAL_STRIPE_PRICE_TEAM: 'configured',
  SIGNAL_TOKEN_ENCRYPTION_KEY: 'configured',
  SIGNAL_SESSION_SECRET: 'configured',
});
assert.equal(configuredProviderReadiness.ok, true);
assert.equal(configuredProviderReadiness.summary.readyProviders, 5);
assert(configuredProviderReadiness.providers.find((provider) => provider.id === 'outbound-email')?.configuredOptional.includes('SIGNAL_SENDGRID_API_KEY'));
assert(configuredProviderReadiness.providers.find((provider) => provider.id === 'outbound-email')?.configuredOptional.includes('SIGNAL_SENDGRID_ASM_GROUP_ID'));

const localBackendReadiness = backendReadiness({ env: {}, statePath });
assert.equal(localBackendReadiness.mode, 'local-json');
assert.equal(localBackendReadiness.productionReady, false);
assert(localBackendReadiness.checks.some((check) => check.id === 'durable_state' && check.missingEnv.includes('DATABASE_URL')), 'backend readiness should name missing durable-state env vars');
const productionBackendReadiness = backendReadiness({
  env: {
    DATABASE_URL: 'postgres://signal:db_password@db.example/signal',
    SIGNAL_API_CORS_ORIGINS: 'https://app.signal.example',
    SIGNAL_AUTH_JWKS_URL: 'https://auth.signal.example/.well-known/jwks.json',
    SIGNAL_AUTH_PROVIDER: 'jwks',
    SIGNAL_BACKEND_MODE: 'production-node',
    SIGNAL_JOB_SCHEDULER: 'worker',
    SIGNAL_PROVIDER_VALIDATION_SCHEDULER: 'worker',
    SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
    SIGNAL_SESSION_SECRET: 'super_secret_session_value_32chars!',
    SIGNAL_COOKIE_SECURE: 'true',
    SIGNAL_WEBHOOK_ACTOR: 'usr_system_webhook',
    SIGNAL_OAUTH_ACTOR: 'usr_system_oauth',
    SIGNAL_STATE_SERVICE_BACKEND: 'postgres',
    SIGNAL_STATE_SERVICE_DATABASE_URL: 'postgres://signal:db_password@db.example/signal',
    SIGNAL_STATE_SERVICE_RLS: 'true',
    SIGNAL_STATE_SERVICE_URL: 'https://state.signal.example/state',
    SIGNAL_TENANT_ISOLATION_MODE: 'rls',
  },
  statePath,
});
assert.equal(productionBackendReadiness.productionReady, true);
const productionBackendJson = JSON.stringify(productionBackendReadiness);
assert(!productionBackendJson.includes('db_password'), 'backend readiness should not serialize database credentials');
assert(!productionBackendJson.includes('super_secret_session_value'), 'backend readiness should not serialize session secrets');
const externalFileBackendReadiness = backendReadiness({
  env: {
    SIGNAL_BACKEND_MODE: 'external-service',
    SIGNAL_STATE_SERVICE_BACKEND: 'file',
    SIGNAL_STATE_SERVICE_URL: 'https://state.signal.example/state',
  },
  statePath,
});
assert.equal(externalFileBackendReadiness.checks.find((check) => check.id === 'durable_state')?.ok, true);
assert.equal(externalFileBackendReadiness.checks.find((check) => check.id === 'state_service_storage')?.ok, false);
const externalPostgresBackendReadiness = backendReadiness({
  env: {
    DATABASE_URL: 'postgres://signal:db_password@db.example/signal',
    SIGNAL_BACKEND_MODE: 'external-service',
    SIGNAL_STATE_SERVICE_BACKEND: 'postgres',
    SIGNAL_STATE_SERVICE_URL: 'https://state.signal.example/state',
  },
  statePath,
});
assert.equal(externalPostgresBackendReadiness.checks.find((check) => check.id === 'state_service_storage')?.ok, true);
assert(!JSON.stringify(externalPostgresBackendReadiness).includes('db_password'), 'state-service readiness should not serialize database credentials');

const missingProviderSandbox = await validateProviderSandbox({
  env: {},
  fetchImpl: async () => {
    throw new Error('blocked sandbox checks should not call providers');
  },
});
assert.equal(missingProviderSandbox.ok, false);
assert.equal(missingProviderSandbox.summary.blocked, 4);
assert(missingProviderSandbox.providers.some((provider) => provider.id === 'gmail' && provider.missingRequired.includes('SIGNAL_GMAIL_ACCESS_TOKEN')));
assert(missingProviderSandbox.providers.some((provider) => provider.id === 'stripe' && provider.missingRequired.includes('STRIPE_SECRET_KEY')));

const sandboxCalls = [];
const configuredProviderSandbox = await validateProviderSandbox({
  env: {
    SIGNAL_GMAIL_ACCESS_TOKEN: 'gmail_access_token',
    SIGNAL_OUTLOOK_ACCESS_TOKEN: 'outlook_access_token',
    SIGNAL_SENDGRID_API_KEY: 'sendgrid_api_key',
    SIGNAL_STRIPE_PRICE_TEAM: 'price_team',
    STRIPE_SECRET_KEY: 'sk_test_signal_sandbox',
  },
  fetchImpl: async (url, init = {}) => {
    sandboxCalls.push({ headers: init.headers ?? {}, url: String(url) });
    if (String(url).includes('gmail.googleapis.com')) {
      return new Response(JSON.stringify({ emailAddress: 'sandbox@example.test', historyId: '123' }), {
        headers: { 'Content-Type': 'application/json', 'x-request-id': 'gmail_req' },
        status: 200,
      });
    }
    if (String(url).includes('graph.microsoft.com')) {
      return new Response(JSON.stringify({ id: 'outlook_user' }), {
        headers: { 'Content-Type': 'application/json', 'request-id': 'outlook_req' },
        status: 200,
      });
    }
    if (String(url).includes('sendgrid.com')) {
      return new Response(JSON.stringify({ id: 'sendgrid_user' }), {
        headers: { 'Content-Type': 'application/json', 'x-request-id': 'sendgrid_req' },
        status: 200,
      });
    }
    if (String(url).endsWith('/account')) {
      return new Response(JSON.stringify({ id: 'acct_signal_sandbox' }), {
        headers: { 'Content-Type': 'application/json', 'stripe-request-id': 'stripe_account_req' },
        status: 200,
      });
    }
    if (String(url).includes('/prices/price_team')) {
      return new Response(JSON.stringify({ id: 'price_team' }), {
        headers: { 'Content-Type': 'application/json', 'stripe-request-id': 'stripe_price_req' },
        status: 200,
      });
    }
    return new Response(JSON.stringify({ error: { code: 'unexpected_url', type: 'test' } }), { status: 404 });
  },
});
assert.equal(configuredProviderSandbox.ok, true);
assert.equal(configuredProviderSandbox.summary.passed, 4);
assert.equal(sandboxCalls.length, 5);
assert(sandboxCalls.some((call) => call.headers.Authorization === 'Bearer gmail_access_token'));
assert(sandboxCalls.some((call) => call.headers.Authorization === 'Bearer outlook_access_token'));
assert(sandboxCalls.some((call) => call.headers.Authorization === 'Bearer sendgrid_api_key'));
assert(sandboxCalls.some((call) => call.headers.Authorization === 'Bearer sk_test_signal_sandbox'));
const configuredProviderSandboxReport = JSON.stringify(configuredProviderSandbox);
assert(!configuredProviderSandboxReport.includes('gmail_access_token'), 'Gmail access token should not be serialized in sandbox report');
assert(!configuredProviderSandboxReport.includes('outlook_access_token'), 'Outlook access token should not be serialized in sandbox report');
assert(!configuredProviderSandboxReport.includes('sendgrid_api_key'), 'SendGrid API key should not be serialized in sandbox report');
assert(!configuredProviderSandboxReport.includes('sk_test_signal_sandbox'), 'Stripe secret key should not be serialized in sandbox report');

const liveStripeSandbox = await validateProviderSandbox({
  env: {
    SIGNAL_STRIPE_PRICE_TEAM: 'price_team',
    STRIPE_SECRET_KEY: 'sk_live_signal_sandbox',
  },
  fetchImpl: async () => {
    throw new Error('live Stripe keys should not be fetched by sandbox validation');
  },
});
assert.equal(liveStripeSandbox.providers.find((provider) => provider.id === 'stripe')?.status, 'failed');

async function expectForbidden(label, action) {
  try {
    await action();
  } catch (error) {
    assert(error instanceof SignalStateError, `${label}: expected SignalStateError`);
    assert.equal(error.code, 'FORBIDDEN', `${label}: expected FORBIDDEN`);
    return;
  }
  throw new Error(`${label}: expected forbidden error`);
}

async function expectStateError(label, expectedCode, action) {
  try {
    await action();
  } catch (error) {
    assert(error instanceof SignalStateError, `${label}: expected SignalStateError`);
    assert.equal(error.code, expectedCode, `${label}: expected ${expectedCode}`);
    return;
  }
  throw new Error(`${label}: expected ${expectedCode} error`);
}

function rateLimitedProviderFetch(provider, retryAfter = '120') {
  return async () => new Response(JSON.stringify({
    error: {
      code: 429,
      message: `${provider} verifier rate limit`,
      status: 'RESOURCE_EXHAUSTED',
    },
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': retryAfter,
    },
    status: 429,
  });
}

await bootstrapState({ force: true, statePath });
await bootstrapState({ force: true, statePath: registrationStatePath });
const registeredWorkspace = await createTenantWorkspace({
  adminEmail: 'founder@northstar.example',
  adminName: 'Founder Operator',
  domain: 'northstar.example',
  name: 'Northstar Revenue Lab',
  planId: 'plan_beta',
}, { actorUserId: 'usr_admin', statePath: registrationStatePath });
assert.equal(registeredWorkspace.action, 'tenants.create');
assert.match(registeredWorkspace.details.tenantId, /^tenant_northstar/);
assert.equal(registeredWorkspace.details.registrationStatus, 'pending_onboarding');
const registrationState = await loadState({ statePath: registrationStatePath });
assert(registrationState.tenants.some((tenant) => tenant.id === registeredWorkspace.details.tenantId && tenant.ownerUserId === registeredWorkspace.details.adminUserId && tenant.billingOwnerUserId === registeredWorkspace.details.adminUserId), 'registered workspace should track owner and billing owner');
assert(registrationState.users.some((user) => user.id === registeredWorkspace.details.adminUserId && user.role === 'admin' && user.tenantId === registeredWorkspace.details.tenantId), 'registered workspace should create an admin owner user');
assert(registrationState.memberships.some((membership) => membership.tenantId === registeredWorkspace.details.tenantId && membership.userId === registeredWorkspace.details.adminUserId && membership.role === 'admin' && membership.status === 'active'), 'registered workspace should create an active admin membership');
assert(registrationState.entitlements.some((entitlement) => entitlement.tenantId === registeredWorkspace.details.tenantId && entitlement.status === 'active'), 'registered workspace should create an active local entitlement');
assert(registrationState.notificationEvents.some((event) => event.userId === registeredWorkspace.details.adminUserId && event.type === 'onboarding.workspace_created'), 'registered workspace should create onboarding notification');
assert(registrationState.jobs.some((job) => job.tenantId === registeredWorkspace.details.tenantId && job.type === 'tenants.create'), 'registered workspace should create onboarding job evidence');
assert.equal(registrationState.session.activeUserId, registeredWorkspace.details.adminUserId);
let bootState = await loadState({ statePath });
assert(bootState.memberships.length >= bootState.users.length, 'memberships should be seeded for every local user');
assert(doctor(bootState).checks.find((check) => check.id === 'tenant_memberships')?.ok, 'doctor should validate tenant memberships');
assert(bootState.notificationPreferences.length >= 3, 'notification preferences should be seeded for active users');
assert(bootState.notificationEvents.some((event) => event.status === 'unread'), 'unread notification events should be available');
assert(bootState.invites.some((invite) => invite.status === 'pending'), 'pending invite fixtures should be available');
assert.equal(bootState.invites.filter((invite) => invite.status === 'pending').length, 1);
assert(bootState.signalQualitySettings.some((settings) => settings.minimumConfidence >= 0.7), 'quality settings should be available');
assert(bootState.suppressionRules.some((rule) => rule.status === 'active'), 'suppression rules should be available');
assert(bootState.modelGovernancePolicies.some((policy) => policy.detectorBoundary === 'shared_detector' && policy.perTenantModel === false), 'model governance should default to shared detector boundary without per-tenant models');
assert(bootState.governancePolicies.some((policy) => policy.sourceRetentionDays >= policy.rawSnippetRetentionDays), 'governance policies should be available');
assert(bootState.redactionRules.some((rule) => rule.status === 'active'), 'redaction rules should be available');
assert(bootState.dataRequests.some((request) => request.status === 'open'), 'data request fixtures should be available');
assert(bootState.incidentNotes.some((note) => note.status === 'open'), 'incident note fixtures should be available');
assert(bootState.notificationPreferences.every((preference) => preference.unsubscribeCode && preference.emailDeliveryStatus === 'subscribed'), 'notification preferences should include email delivery subscription state');
assert.equal(bootState.providerValidationRuns.length, 0, 'provider sandbox validation evidence should start empty');
assert.equal(bootState.providerValidationSchedules.length, 4, 'provider sandbox validation schedules should cover live provider boundaries');
assert(bootState.providerValidationSchedules.every((schedule) => ['daily', 'weekly', 'manual'].includes(schedule.cadence) && ['active', 'paused'].includes(schedule.status)), 'provider validation schedules should have valid cadence and status');
assert(doctor(bootState).checks.find((check) => check.id === 'provider_validation_schedules_audited')?.ok, 'doctor should validate provider validation schedule metadata');
assert(bootState.jobs.some((job) => job.queue === 'provider_validation' && job.type === 'provider.sandbox.scheduled'), 'provider validation scheduler job should be normalized into local worker state');
bootState.providerValidationSchedules.find((schedule) => schedule.providerId === 'gmail').nextRunAt = '2020-01-01T00:00:00.000Z';
await saveState(bootState, { statePath });
bootState = await loadState({ statePath });
assert(providerValidationSchedulesDue(bootState).some((schedule) => schedule.providerId === 'gmail'), 'provider validation schedule due helper should identify due schedules');
assert.equal(bootState.jobs.find((job) => job.queue === 'provider_validation')?.nextRunAt ?? null, null, 'provider validation scheduler job should become due when any provider schedule is due');
assert.equal(bootState.tenants[0].status, 'active', 'tenant status should default to active');
assert(doctor(bootState).checks.find((check) => check.id === 'tenant_statuses')?.ok, 'doctor should validate tenant status metadata');
assert(bootState.accountRecommendations?.some((recommendation) => recommendation.kind === 'renewal_save' && recommendation.priority === 'critical'), 'renewal-risk accounts should have critical strategy recommendations');
assert(doctor(bootState).checks.find((check) => check.id === 'account_recommendations_available')?.ok, 'doctor should validate account recommendations');
assert(doctor(bootState).checks.find((check) => check.id === 'model_governance_boundary')?.ok, 'doctor should validate model governance boundary');
assert(bootState.lifecycleNotices?.some((notice) => notice.category === 'payment' && notice.trigger === 'subscription_starting_point'), 'subscription starting-point lifecycle notice should be available');
assert(bootState.lifecycleNotices?.some((notice) => notice.category === 'source' && notice.trigger.startsWith('mailbox_')), 'mailbox source lifecycle notice should be available');
assert(doctor(bootState).checks.find((check) => check.id === 'lifecycle_notices_audited')?.ok, 'doctor should validate lifecycle notice audit shape');

const domainChanged = await setTenantDomain('tenant_demo', 'https://Revenue.Acme.Example/path', { actorUserId: 'usr_admin', statePath });
assert.equal(domainChanged.action, 'tenants.domain');
assert.equal(domainChanged.details.nextDomain, 'revenue.acme.example');
bootState = await loadState({ statePath });
assert.equal(bootState.tenants[0].domain, 'revenue.acme.example');
const domainRestored = await setTenantDomain('tenant_demo', 'acme.example', { actorUserId: 'usr_admin', statePath });
assert.equal(domainRestored.details.nextDomain, 'acme.example');

await expectForbidden('member cannot suspend tenant', () =>
  setTenantStatus('tenant_demo', 'suspended', { reason: 'Nope' }, { actorUserId: 'usr_product', statePath }),
);
const suspendedTenant = await setTenantStatus('tenant_demo', 'suspended', { reason: 'Billing review' }, { actorUserId: 'usr_admin', statePath });
assert.equal(suspendedTenant.action, 'tenants.status');
assert.equal(suspendedTenant.details.nextStatus, 'suspended');
assert.equal(suspendedTenant.summary.tenantStatus, 'suspended');
await expectStateError('suspended tenant gates member account action', 'TENANT_SUSPENDED', () =>
  setAccountActionStatus('act_ventureworks_export_discovery', 'done', { actorUserId: 'usr_product', statePath }),
);
const reactivatedTenant = await setTenantStatus('tenant_demo', 'active', {}, { actorUserId: 'usr_admin', statePath });
assert.equal(reactivatedTenant.details.nextStatus, 'active');

const ranProviderValidationWorker = await runJobs({ queue: 'provider_validation', limit: 1 }, {
  actorUserId: 'usr_admin',
  statePath,
  env: {},
  fetchImpl: async () => {
    throw new Error('blocked scheduled sandbox checks should not call providers');
  },
});
assert.equal(ranProviderValidationWorker.action, 'jobs.run');
assert.equal(ranProviderValidationWorker.details.count, 1);
assert.equal(ranProviderValidationWorker.details.outcomes[0].queue, 'provider_validation');
assert.equal(ranProviderValidationWorker.details.outcomes[0].providerValidationStatus, 'blocked');
assert.match(ranProviderValidationWorker.details.outcomes[0].providerValidationRunId, /^pvr_/);
bootState = await loadState({ statePath });
assert.equal(bootState.providerValidationRuns.length, 1, 'provider validation worker should record sanitized sandbox evidence when a schedule is due');
assert.equal(bootState.jobs.find((job) => job.queue === 'provider_validation')?.status, 'queued', 'provider validation worker should remain queued for recurring scheduler handoff');
assert(bootState.jobs.find((job) => job.queue === 'provider_validation')?.nextRunAt, 'provider validation worker should advance to the next provider schedule time');

const recordedSandbox = await recordProviderSandboxValidation(configuredProviderSandbox, { actorUserId: 'usr_admin', statePath });
assert.equal(recordedSandbox.action, 'integrations.sandbox.record');
assert.equal(recordedSandbox.actor.id, 'usr_admin');
assert.match(recordedSandbox.details.id, /^pvr_/);
assert.equal(recordedSandbox.details.status, 'passed');
assert.equal(recordedSandbox.summary.providerValidationRuns, 2);
bootState = await loadState({ statePath });
const validationRun = bootState.providerValidationRuns.find((run) => run.id === recordedSandbox.details.id);
assert(validationRun, 'direct provider sandbox validation run should be persisted');
assert.equal(validationRun.status, 'passed');
assert.equal(validationRun.summary.passed, 4);
assert.equal(validationRun.providers.length, 4);
assert(validationRun.providers.every((provider) => provider.checks.every((check) => !('message' in check))), 'persisted provider checks should omit transient provider messages');
const stripeSchedule = bootState.providerValidationSchedules.find((schedule) => schedule.providerId === 'stripe');
assert.equal(stripeSchedule?.lastRunId, validationRun.id);
assert.equal(stripeSchedule?.lastRunStatus, 'passed');
assert(stripeSchedule?.nextRunAt, 'recorded provider validation should update next scheduled run');
const outboundSchedule = bootState.providerValidationSchedules.find((schedule) => schedule.providerId === 'outbound-email');
assert.equal(outboundSchedule?.lastRunId, validationRun.id, 'SendGrid sandbox validation should update the outbound email schedule');
assert(outboundSchedule?.requiredEnv.includes('SIGNAL_SENDGRID_API_KEY'), 'outbound email validation schedule should name the SendGrid sandbox input');
const validationRunJson = JSON.stringify(validationRun);
assert(!validationRunJson.includes('gmail_access_token'), 'recorded sandbox evidence should not store Gmail access tokens');
assert(!validationRunJson.includes('outlook_access_token'), 'recorded sandbox evidence should not store Outlook access tokens');
assert(!validationRunJson.includes('sendgrid_api_key'), 'recorded sandbox evidence should not store SendGrid API keys');
assert(!validationRunJson.includes('sk_test_signal_sandbox'), 'recorded sandbox evidence should not store Stripe secret keys');
assert(doctor(bootState).checks.find((check) => check.id === 'provider_validation_runs_sanitized')?.ok, 'doctor should validate sanitized provider sandbox evidence');
const pausedStripeSchedule = await setProviderValidationSchedule('stripe', { status: 'paused' }, { actorUserId: 'usr_admin', statePath });
assert.equal(pausedStripeSchedule.action, 'integrations.schedule');
assert.equal(pausedStripeSchedule.details.status, 'paused');
assert.equal(pausedStripeSchedule.details.nextRunAt, null);
const weeklyStripeSchedule = await setProviderValidationSchedule('stripe', { cadence: 'weekly', status: 'active' }, { actorUserId: 'usr_admin', statePath });
assert.equal(weeklyStripeSchedule.details.cadence, 'weekly');
bootState = await loadState({ statePath });
assert.equal(bootState.providerValidationSchedules.find((schedule) => schedule.providerId === 'stripe')?.cadence, 'weekly');
await expectForbidden('member cannot manage provider validation schedule', () =>
  setProviderValidationSchedule('gmail', { status: 'paused' }, { actorUserId: 'usr_product', statePath }),
);
assert(!JSON.stringify(bootState.providerValidationSchedules).includes('sk_test_signal_sandbox'), 'provider validation schedules should not store provider secrets');

const memberSession = await switchSession('usr_product', { statePath });
assert.equal(memberSession.action, 'session.switch');
assert.equal(memberSession.actor.id, 'usr_product');
assert.equal(memberSession.summary.activeUserId, 'usr_product');
assert.equal(memberSession.summary.activeUserRole, 'member');

const sessionEnv = { SIGNAL_SESSION_SECRET: 'session_secret_for_verifier_32ch!', SIGNAL_SESSION_TTL_SECONDS: '900' };
await expectStateError('missing session secret is rejected', 'SESSION_SECRET_MISSING', () =>
  issueSessionToken('usr_admin', { actorUserId: 'usr_admin', env: {}, statePath }),
);
const issuedSession = await issueSessionToken('usr_admin', { actorUserId: 'usr_admin', env: sessionEnv, statePath, ttlSeconds: 600 });
assert.equal(issuedSession.action, 'session.token');
assert.equal(issuedSession.actor.id, 'usr_admin');
assert.equal(issuedSession.details.userId, 'usr_admin');
assert.match(issuedSession.details.apiSessionId, /^apis_/);
assert.match(issuedSession.details.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
assert.equal(issuedSession.details.tokenDigest.length, 24);
const verifiedSession = await verifyLocalSessionToken(issuedSession.details.token, { env: sessionEnv, statePath });
assert.equal(verifiedSession.actor.id, 'usr_admin');
assert.equal(verifiedSession.payload.sub, 'usr_admin');
assert.equal(verifiedSession.session.id, issuedSession.details.apiSessionId);
assert.equal(verifiedSession.tokenDigest, issuedSession.details.tokenDigest);
await expectStateError('tampered session token is rejected', 'SESSION_TOKEN_SIGNATURE_INVALID', () =>
  verifyLocalSessionToken(`${issuedSession.details.token.slice(0, -1)}x`, { env: sessionEnv, statePath }),
);
const revokedSession = await revokeSessionToken(issuedSession.details.apiSessionId, { actorUserId: 'usr_admin', statePath });
assert.equal(revokedSession.action, 'session.revoke');
assert.equal(revokedSession.details.sessionId, issuedSession.details.apiSessionId);
await expectStateError('revoked session token is rejected', 'SESSION_REVOKED', () =>
  verifyLocalSessionToken(issuedSession.details.token, { env: sessionEnv, statePath }),
);

const promoted = await setUserRole('usr_sales', 'admin', { actorUserId: 'usr_admin', statePath });
assert.equal(promoted.action, 'users.role');
assert.equal(promoted.actor.id, 'usr_admin');
assert.equal(promoted.details.nextRole, 'admin');
assert.match(promoted.details.membershipId, /^mem_/);
bootState = await loadState({ statePath });
assert.equal(bootState.memberships.find((membership) => membership.userId === 'usr_sales')?.role, 'admin', 'role changes should update membership role');

await expectForbidden('member cannot create invite', () =>
  createUserInvite({ tenantId: 'tenant_demo', email: 'fail@acme.example', role: 'member', team: 'sales' }, { actorUserId: 'usr_product', statePath }),
);

const invite = await createUserInvite({ tenantId: 'tenant_demo', email: 'taylor@acme.example', role: 'member', team: 'success' }, { actorUserId: 'usr_admin', statePath });
assert.equal(invite.action, 'users.invite');
assert.equal(invite.details.email, 'taylor@acme.example');
assert.equal(invite.summary.pendingInvites, 2);

const acceptedInvite = await acceptUserInvite(invite.details.inviteId, { name: 'Taylor Reyes' }, { actorUserId: 'usr_admin', statePath });
assert.equal(acceptedInvite.action, 'users.invite-accept');
assert.equal(acceptedInvite.summary.users, 4);

bootState = await loadState({ statePath });
assert(bootState.users.some((user) => user.email === 'taylor@acme.example' && user.team === 'success'), 'accepted invite should create active user with team');
const acceptedMembership = bootState.memberships.find((membership) => membership.userId === acceptedInvite.details.userId && membership.inviteId === invite.details.inviteId);
assert(acceptedMembership, 'accepted invite should create tenant membership with invite provenance');
assert.equal(acceptedMembership?.role, 'member');
assert.equal(acceptedMembership?.team, 'success');
assert.equal(acceptedMembership?.status, 'active');
assert(bootState.notificationPreferences.some((preference) => preference.userId === acceptedInvite.details.userId), 'accepted user should receive notification preferences');
assert(bootState.notificationEvents.some((event) => event.userId === acceptedInvite.details.userId && event.type === 'onboarding.invite_accepted'), 'accepted user should receive onboarding notification');
const disabledAcceptedUser = await setUserStatus(acceptedInvite.details.userId, 'disabled', { actorUserId: 'usr_admin', statePath });
assert.equal(disabledAcceptedUser.action, 'users.disable');
assert.equal(disabledAcceptedUser.details.membershipId, acceptedMembership?.id);
bootState = await loadState({ statePath });
assert.equal(bootState.memberships.find((membership) => membership.userId === acceptedInvite.details.userId)?.status, 'disabled', 'disable should update membership status');
const reactivatedAcceptedUser = await setUserStatus(acceptedInvite.details.userId, 'active', { actorUserId: 'usr_admin', statePath });
assert.equal(reactivatedAcceptedUser.action, 'users.activate');
bootState = await loadState({ statePath });
assert.equal(bootState.memberships.find((membership) => membership.userId === acceptedInvite.details.userId)?.status, 'active', 'reactivate should restore active membership status');

const claimInvite = await createUserInvite({ tenantId: 'tenant_demo', email: 'claim@acme.example', role: 'member', team: 'success' }, { actorUserId: 'usr_admin', statePath });
const claimedInvite = await claimUserInvite({ claimCode: claimInvite.details.claimCode, email: 'claim@acme.example', name: 'Claim User', team: 'success' }, { statePath });
assert.equal(claimedInvite.action, 'users.invite-claim');
assert.equal(claimedInvite.actor.email, 'claim@acme.example');
assert.equal(claimedInvite.summary.activeUserId, claimedInvite.details.userId);
bootState = await loadState({ statePath });
assert(bootState.users.some((user) => user.email === 'claim@acme.example' && user.team === 'success'), 'claimed invite should create active user with team');
assert(bootState.memberships.some((membership) => membership.userId === claimedInvite.details.userId && membership.inviteId === claimInvite.details.inviteId), 'claimed invite should create membership with invite provenance');
assert(bootState.auditEvents.some((event) => event.action === 'users.invite-claim' && event.actor === claimedInvite.details.userId), 'claimed invite should audit the new user as actor');
await expectStateError('wrong email cannot claim invite code', 'INVITE_CLAIM_INVALID', () =>
  claimUserInvite({ claimCode: claimInvite.details.claimCode, email: 'wrong@acme.example' }, { statePath }),
);

const revokedInvite = await revokeUserInvite('inv_rowan_success', { actorUserId: 'usr_admin', statePath });
assert.equal(revokedInvite.action, 'users.invite-revoke');

await expectStateError('cannot accept revoked invite', 'INVITE_NOT_PENDING', () =>
  acceptUserInvite('inv_rowan_success', {}, { actorUserId: 'usr_admin', statePath }),
);

await expectForbidden('member cannot pause mailbox', () =>
  setMailboxStatus('mbx_gmail_sales', 'paused', { actorUserId: 'usr_product', statePath }),
);

const paused = await setMailboxStatus('mbx_gmail_sales', 'paused', { actorUserId: 'usr_admin', statePath });
assert.equal(paused.action, 'mailboxes.pause');
assert.equal(paused.summary.connectedMailboxes, 0);

const resumed = await setMailboxStatus('mbx_gmail_sales', 'connected', { actorUserId: 'usr_admin', statePath });
assert.equal(resumed.action, 'mailboxes.resume');
assert.equal(resumed.summary.connectedMailboxes, 1);

await expectForbidden('member cannot create mailbox connection', () =>
  createMailboxConnectionSession({ tenantId: 'tenant_demo', provider: 'outlook', ownerUserId: 'usr_admin', mailboxId: 'mbx_outlook_success' }, { actorUserId: 'usr_product', statePath }),
);

const connectUrl = await createMailboxConnectionSession({ tenantId: 'tenant_demo', provider: 'outlook', ownerUserId: 'usr_admin', mailboxId: 'mbx_outlook_success' }, { actorUserId: 'usr_admin', statePath });
assert.equal(connectUrl.action, 'mailboxes.connect-url');
assert.match(connectUrl.details.url, /^https:\/\/login\.microsoftonline\.com\//);
assert.match(connectUrl.details.localCallbackUrl, /^http:\/\/127\.0\.0\.1:8787\/api\/oauth\/outlook\/callback/);
assert.equal(connectUrl.details.oauthStateStatus, 'issued');

const completedConnection = await completeMailboxConnection(connectUrl.details.sessionId, { actorUserId: 'usr_admin', statePath });
assert.equal(completedConnection.action, 'mailboxes.complete');
assert.equal(completedConnection.summary.connectedMailboxes, 2);

const gmailCallbackSession = await createMailboxConnectionSession({ tenantId: 'tenant_demo', provider: 'gmail', ownerUserId: 'usr_product' }, { actorUserId: 'usr_product', statePath });
assert.equal(gmailCallbackSession.action, 'mailboxes.connect-url');
const callbackUrl = new URL(gmailCallbackSession.details.localCallbackUrl);
await expectStateError('tampered OAuth state is rejected', 'OAUTH_STATE_SIGNATURE_INVALID', () =>
  completeMailboxConnectionFromOAuthCallback('gmail', { code: 'provider-code', state: `${callbackUrl.searchParams.get('state')}tampered` }, { actorUserId: 'usr_product', statePath }),
);
const callbackConnection = await completeMailboxConnectionFromOAuthCallback('gmail', { code: callbackUrl.searchParams.get('code'), state: callbackUrl.searchParams.get('state') }, { actorUserId: 'usr_product', statePath });
assert.equal(callbackConnection.action, 'mailboxes.oauth-callback');
assert.equal(callbackConnection.details.oauthStateStatus, 'verified');
assert.equal(callbackConnection.summary.connectedMailboxes, 3);

const ownerPaused = await setMailboxStatus(callbackConnection.details.mailboxId, 'paused', { actorUserId: 'usr_product', statePath });
assert.equal(ownerPaused.action, 'mailboxes.pause');
const ownerResumed = await setMailboxStatus(callbackConnection.details.mailboxId, 'connected', { actorUserId: 'usr_product', statePath });
assert.equal(ownerResumed.action, 'mailboxes.resume');
const ownerSynced = await syncMailbox(callbackConnection.details.mailboxId, { actorUserId: 'usr_product', statePath });
assert.equal(ownerSynced.action, 'mailboxes.sync');
const ownerDisconnected = await disconnectMailbox(callbackConnection.details.mailboxId, { actorUserId: 'usr_product', statePath });
assert.equal(ownerDisconnected.action, 'mailboxes.disconnect');
let lifecycleState = await loadState({ statePath });
assert(lifecycleState.lifecycleNotices.some((notice) => notice.sourceIds?.mailboxId === callbackConnection.details.mailboxId && notice.trigger === 'mailbox_disconnected' && notice.status === 'open'), 'mailbox disconnect should produce an open source lifecycle notice');

const tokenExchangeEnv = {
  SIGNAL_GMAIL_CLIENT_ID: 'gmail-client-id',
  SIGNAL_GMAIL_CLIENT_SECRET: 'gmail-client-secret',
  SIGNAL_GMAIL_REDIRECT_URI: 'http://127.0.0.1:8787/api/oauth/gmail/callback',
  SIGNAL_OAUTH_STATE_KEY: process.env.SIGNAL_OAUTH_STATE_KEY,
  SIGNAL_TOKEN_ENCRYPTION_KEY: 'local-verifier-token-encryption-key',
};
const tokenExchangeSession = await createMailboxConnectionSession({ tenantId: 'tenant_demo', provider: 'gmail', ownerUserId: 'usr_admin' }, { actorUserId: 'usr_admin', statePath });
const tokenExchangeCallbackUrl = new URL(tokenExchangeSession.details.localCallbackUrl);
const tokenExchangeCalls = [];
const tokenExchangeConnection = await completeMailboxConnectionFromOAuthCallback('gmail', { code: 'live-provider-code', state: tokenExchangeCallbackUrl.searchParams.get('state') }, {
  actorUserId: 'usr_admin',
  env: tokenExchangeEnv,
  fetchImpl: async (url, init) => {
    tokenExchangeCalls.push({
      body: Object.fromEntries(init.body.entries()),
      headers: init.headers,
      method: init.method,
      url,
    });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: 'live-access-token',
        expires_in: 3600,
        id_token: 'live-id-token',
        refresh_token: 'live-refresh-token',
        scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly',
        token_type: 'Bearer',
      }),
    };
  },
  statePath,
  tokenVaultPath: vaultPath,
});
assert.equal(tokenExchangeConnection.action, 'mailboxes.oauth-callback');
assert.equal(tokenExchangeConnection.details.credentialExchangeStatus, 'stored');
assert.equal(tokenExchangeConnection.details.credentialStatus, 'stored');
assert.match(tokenExchangeConnection.details.credentialVaultRef, /^cred_gmail_/);
assert.equal(tokenExchangeCalls.length, 1, 'configured real callback should exchange the provider code once');
assert.equal(tokenExchangeCalls[0].url, 'https://oauth2.googleapis.com/token');
assert.equal(tokenExchangeCalls[0].body.grant_type, 'authorization_code');
assert.equal(tokenExchangeCalls[0].body.code, 'live-provider-code');
assert.equal(tokenExchangeCalls[0].body.client_id, 'gmail-client-id');
assert.equal(tokenExchangeCalls[0].body.redirect_uri, tokenExchangeEnv.SIGNAL_GMAIL_REDIRECT_URI);
const vault = JSON.parse(await fs.readFile(vaultPath, 'utf8'));
const vaultText = JSON.stringify(vault);
assert(!vaultText.includes('live-access-token'), 'vault file should not contain plaintext access credential');
assert(!vaultText.includes('live-refresh-token'), 'vault file should not contain plaintext refresh credential');
const decryptedVaultPayload = decryptVaultPayload(vault.records[0].encrypted, { env: tokenExchangeEnv, vaultMeta: vault.meta });
assert.equal(decryptedVaultPayload.response.access_token, 'live-access-token');
assert.equal(decryptedVaultPayload.response.refresh_token, 'live-refresh-token');
const vaultRecords = await listProviderCredentialRecords({ vaultPath, env: tokenExchangeEnv });
assert.equal(vaultRecords.records.length, 1);
assert.equal(vaultRecords.records[0].keyMatches, true);

const vaultWatchCalls = [];
const vaultBackedWatch = await setupMailboxWatch(tokenExchangeConnection.details.mailboxId, {
  actorUserId: 'usr_admin',
  env: tokenExchangeEnv,
  fetchImpl: async (url, init) => {
    vaultWatchCalls.push({
      body: JSON.parse(init.body),
      headers: init.headers,
      method: init.method,
      url,
    });
    return new Response(JSON.stringify({
      expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
      historyId: 'vault-history-001',
      id: 'gmail-live-watch-from-vault',
    }), { headers: { 'Content-Type': 'application/json' }, status: 200 });
  },
  liveProviderWatch: true,
  statePath,
  tokenVaultPath: vaultPath,
});
assert.equal(vaultBackedWatch.action, 'mailboxes.watch');
assert.equal(vaultBackedWatch.details.mode, 'live');
assert.equal(vaultBackedWatch.details.providerCredentialSource, 'vault');
assert.equal(vaultBackedWatch.details.providerCredentialVaultRef, tokenExchangeConnection.details.credentialVaultRef);
assert.equal(vaultWatchCalls.length, 1, 'live watch should use the encrypted vault credential without an explicit access token');
assert.equal(vaultWatchCalls[0].headers.Authorization, 'Bearer live-access-token');
let credentialWatchState = await loadState({ statePath });
const vaultWatchRecord = credentialWatchState.emailWatchSubscriptions.find((watch) => watch.id === vaultBackedWatch.details.watchId);
assert.equal(vaultWatchRecord?.providerCredentialSource, 'vault');
assert.equal(vaultWatchRecord?.providerCredentialVaultRef, tokenExchangeConnection.details.credentialVaultRef);
assert(!JSON.stringify(credentialWatchState).includes('live-access-token'), 'local app state should not contain plaintext vault access credentials');

const expiringVault = JSON.parse(await fs.readFile(vaultPath, 'utf8'));
expiringVault.records[0].expiresAt = new Date(Date.now() - 60 * 1000).toISOString();
await fs.writeFile(vaultPath, `${JSON.stringify(expiringVault, null, 2)}\n`);
const vaultRefreshCalls = [];
const refreshedVaultWatch = await renewMailboxWatch(vaultBackedWatch.details.watchId, {
  actorUserId: 'usr_admin',
  env: tokenExchangeEnv,
  fetchImpl: async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      vaultRefreshCalls.push({
        body: Object.fromEntries(init.body.entries()),
        headers: init.headers,
        method: init.method,
        url,
      });
      return new Response(JSON.stringify({
        access_token: 'rotated-live-access-token',
        expires_in: 7200,
        scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly',
        token_type: 'Bearer',
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 });
    }
    vaultRefreshCalls.push({
      body: JSON.parse(init.body),
      headers: init.headers,
      method: init.method,
      url,
    });
    return new Response(JSON.stringify({
      expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
      historyId: 'vault-history-rotated',
      id: 'gmail-live-watch-after-refresh',
    }), { headers: { 'Content-Type': 'application/json' }, status: 200 });
  },
  liveProviderWatch: true,
  statePath,
  tokenVaultPath: vaultPath,
});
assert.equal(refreshedVaultWatch.action, 'mailboxes.watch-renew');
assert.equal(refreshedVaultWatch.details.providerCredentialSource, 'vault');
assert(refreshedVaultWatch.details.providerCredentialRefreshedAt, 'expired vault credentials should be refreshed before live watch renewal');
assert.equal(vaultRefreshCalls.length, 2, 'expired vault-backed watch renewal should refresh then register the watch');
assert.equal(vaultRefreshCalls[0].url, 'https://oauth2.googleapis.com/token');
assert.equal(vaultRefreshCalls[0].body.grant_type, 'refresh_token');
assert.equal(vaultRefreshCalls[0].body.refresh_token, 'live-refresh-token');
assert.equal(vaultRefreshCalls[1].headers.Authorization, 'Bearer rotated-live-access-token');
credentialWatchState = await loadState({ statePath });
const refreshedMailbox = credentialWatchState.mailboxes.find((mailbox) => mailbox.id === tokenExchangeConnection.details.mailboxId);
const refreshedWatchRecord = credentialWatchState.emailWatchSubscriptions.find((watch) => watch.id === vaultBackedWatch.details.watchId);
assert.equal(refreshedWatchRecord?.providerCredentialSource, 'vault');
assert(refreshedWatchRecord?.providerCredentialRefreshedAt, 'watch record should expose safe credential refresh metadata');
assert(refreshedMailbox?.credentialExpiresAt && Date.parse(refreshedMailbox.credentialExpiresAt) > Date.now(), 'mailbox safe credential expiry metadata should update after refresh');
const refreshedVault = JSON.parse(await fs.readFile(vaultPath, 'utf8'));
assert(!JSON.stringify(refreshedVault).includes('rotated-live-access-token'), 'vault should not contain plaintext rotated access token');
assert(!JSON.stringify(credentialWatchState).includes('rotated-live-access-token'), 'app state should not contain plaintext rotated access token');
assert.equal(decryptVaultPayload(refreshedVault.records[0].encrypted, { env: tokenExchangeEnv, vaultMeta: refreshedVault.meta }).response.access_token, 'rotated-live-access-token');

const liveSyncCalls = [];
const vaultBackedSync = await syncMailbox(tokenExchangeConnection.details.mailboxId, {
  actorUserId: 'usr_admin',
  env: tokenExchangeEnv,
  fetchImpl: async (url, init) => {
    liveSyncCalls.push({
      headers: init.headers,
      method: init.method,
      url,
    });
    if (String(url).includes('/history')) {
      return new Response(JSON.stringify({
        history: [
          {
            id: '7654321',
            messagesAdded: [
              { message: { id: 'gmail-live-msg-001', threadId: 'gmail-live-thread-001' } },
            ],
          },
        ],
        historyId: '7654321',
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 });
    }
    return new Response(JSON.stringify({
      id: 'gmail-live-msg-001',
      labelIds: ['Customers'],
      payload: {
        headers: [
          { name: 'From', value: 'Provider Ops <provider-ops@example.test>' },
          { name: 'Subject', value: 'Provider cursor checkpoint' },
          { name: 'Date', value: '2026-06-03T12:00:00.000Z' },
        ],
      },
      snippet: 'Routine provider metadata checkpoint for selected mailbox folders.',
      threadId: 'gmail-live-thread-001',
    }), { headers: { 'Content-Type': 'application/json' }, status: 200 });
  },
  liveProviderSync: true,
  statePath,
  tokenVaultPath: vaultPath,
});
assert.equal(vaultBackedSync.action, 'mailboxes.sync');
assert.equal(vaultBackedSync.details.sourceMessagesUpserted, 1);
assert(liveSyncCalls.length >= 2, 'live Gmail sync should fetch history and message metadata');
assert(liveSyncCalls.every((call) => call.headers.Authorization === 'Bearer rotated-live-access-token'), 'live sync should use the refreshed vault access token');
credentialWatchState = await loadState({ statePath });
const liveSyncedCursor = credentialWatchState.emailSyncCursors.find((cursor) => cursor.mailboxId === tokenExchangeConnection.details.mailboxId);
assert.equal(liveSyncedCursor?.providerSyncMode, 'live');
assert(liveSyncedCursor?.providerRequestDigest, 'live sync cursor should store a provider request digest');
assert(liveSyncedCursor?.providerResponseDigest, 'live sync cursor should store a provider response digest');
assert(credentialWatchState.sourceMessages.some((message) => message.providerMessageId === 'gmail-live-msg-001' && message.providerSyncMode === 'live'), 'live sync should upsert source-message snippets by provider message id');
assert(!JSON.stringify(credentialWatchState).includes('rotated-live-access-token'), 'app state should not contain plaintext live sync access tokens');

const syncedMailbox = await syncMailbox('mbx_gmail_sales', { actorUserId: 'usr_admin', statePath });
assert.equal(syncedMailbox.action, 'mailboxes.sync');
assert.equal(syncedMailbox.details.mailboxId, 'mbx_gmail_sales');
assert.equal(syncedMailbox.details.sourceMessagesUpserted, 1);

const replayedMailbox = await replayMailbox('mbx_gmail_sales', { actorUserId: 'usr_admin', statePath });
assert.equal(replayedMailbox.action, 'mailboxes.replay');
assert.equal(replayedMailbox.details.mailboxId, 'mbx_gmail_sales');
assert.equal(replayedMailbox.details.sourceMessagesUpserted, 1);

const replayedMailboxAgain = await replayMailbox('mbx_gmail_sales', { actorUserId: 'usr_admin', statePath });
assert.equal(replayedMailboxAgain.action, 'mailboxes.replay');
assert.equal(replayedMailboxAgain.details.mailboxId, 'mbx_gmail_sales');
assert.equal(replayedMailboxAgain.details.sourceMessagesUpserted, 1);
const replayDedupState = await loadState({ statePath });
const replayMessages = replayDedupState.sourceMessages.filter((message) => message.mailboxId === 'mbx_gmail_sales' && message.providerSyncMode === 'local' && message.providerMessageId?.includes('gmail-local-'));
assert.equal(new Set(replayMessages.map((message) => message.providerMessageId)).size, replayMessages.length, 'provider replay should upsert by provider message id without duplicates');

await expectForbidden('member cannot set up provider watch', () =>
  setupMailboxWatch('mbx_gmail_sales', { actorUserId: 'usr_product', statePath }),
);

const gmailWatch = await setupMailboxWatch('mbx_gmail_sales', { actorUserId: 'usr_admin', statePath });
assert.equal(gmailWatch.action, 'mailboxes.watch');
assert.equal(gmailWatch.details.mode, 'local');
assert.match(gmailWatch.details.watchId, /^watch_gmail_/);

const outlookWatch = await setupMailboxWatch('mbx_outlook_success', { actorUserId: 'usr_admin', statePath });
assert.equal(outlookWatch.action, 'mailboxes.watch');
assert.equal(outlookWatch.details.mode, 'local');
assert.match(outlookWatch.details.watchId, /^watch_outlook_/);

const renewedGmailWatch = await renewMailboxWatch(gmailWatch.details.watchId, { actorUserId: 'usr_admin', statePath });
assert.equal(renewedGmailWatch.action, 'mailboxes.watch-renew');
assert.equal(renewedGmailWatch.details.renewalCount, 1);

const gmailRateLimitedWatch = await renewMailboxWatch(gmailWatch.details.watchId, {
  actorUserId: 'usr_admin',
  fetchImpl: rateLimitedProviderFetch('gmail'),
  liveProviderWatch: true,
  providerAccessToken: 'gmail-access-token',
  statePath,
});
assert.equal(gmailRateLimitedWatch.action, 'mailboxes.watch-renew');
assert.equal(gmailRateLimitedWatch.details.status, 'paused');
assert.equal(gmailRateLimitedWatch.details.providerResponseStatus, 429);
assert(gmailRateLimitedWatch.details.providerRetryAfterAt, 'Gmail rate-limit response should expose retry timing');

let providerBackoffState = await loadState({ statePath });
let gmailBackoffWatch = providerBackoffState.emailWatchSubscriptions.find((watch) => watch.id === gmailWatch.details.watchId);
let gmailBackoffCursor = providerBackoffState.emailSyncCursors.find((cursor) => cursor.mailboxId === 'mbx_gmail_sales');
let gmailBackoffJob = [...providerBackoffState.jobs].reverse().find((job) => job.type === 'mailbox.watch.renew' && job.targetId === 'mbx_gmail_sales' && job.providerResponseStatus === 429);
assert.equal(gmailBackoffWatch?.status, 'paused');
assert.equal(gmailBackoffWatch?.providerResponseStatus, 429);
assert.equal(gmailBackoffCursor?.status, 'blocked');
assert.equal(gmailBackoffCursor?.providerResponseStatus, 429);
assert.equal(gmailBackoffJob?.status, 'queued');
assert(gmailBackoffJob?.nextRunAt, 'Gmail rate-limit job should defer until Retry-After');

const earlyGmailBackoffRun = await runJobs({ jobId: gmailBackoffJob.id }, { actorUserId: 'usr_admin', statePath });
assert.equal(earlyGmailBackoffRun.action, 'jobs.run');
assert.equal(earlyGmailBackoffRun.details.count, 0, 'provider-watch Retry-After jobs should not run early');

providerBackoffState = await loadState({ statePath });
gmailBackoffJob = providerBackoffState.jobs.find((job) => job.id === gmailBackoffJob.id);
gmailBackoffJob.nextRunAt = new Date(Date.now() - 1000).toISOString();
await saveState(providerBackoffState, { statePath });
const retriedGmailWatchJob = await runJobs({ jobId: gmailBackoffJob.id }, {
  actorUserId: 'usr_admin',
  fetchImpl: async () => new Response(JSON.stringify({
    expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
    historyId: '123456',
    id: 'gmail-live-watch-retry',
  }), { headers: { 'Content-Type': 'application/json' }, status: 200 }),
  liveProviderWatch: true,
  providerAccessToken: 'gmail-access-token',
  statePath,
});
assert.equal(retriedGmailWatchJob.details.count, 1);
assert.equal(retriedGmailWatchJob.details.succeeded, 1);
providerBackoffState = await loadState({ statePath });
gmailBackoffWatch = providerBackoffState.emailWatchSubscriptions.find((watch) => watch.id === gmailWatch.details.watchId);
gmailBackoffCursor = providerBackoffState.emailSyncCursors.find((cursor) => cursor.mailboxId === 'mbx_gmail_sales');
assert.equal(gmailBackoffWatch?.status, 'active');
assert.equal(gmailBackoffWatch?.providerResponseStatus, null);
assert.equal(gmailBackoffCursor?.status, 'active');
assert.equal(gmailBackoffCursor?.providerBackoffUntil, null);

const outlookRateLimitedWatch = await renewMailboxWatch(outlookWatch.details.watchId, {
  actorUserId: 'usr_admin',
  fetchImpl: rateLimitedProviderFetch('outlook', '90'),
  liveProviderWatch: true,
  providerAccessToken: 'outlook-access-token',
  statePath,
});
assert.equal(outlookRateLimitedWatch.action, 'mailboxes.watch-renew');
assert.equal(outlookRateLimitedWatch.details.status, 'paused');
assert.equal(outlookRateLimitedWatch.details.providerResponseStatus, 429);
providerBackoffState = await loadState({ statePath });
const outlookBackoffWatch = providerBackoffState.emailWatchSubscriptions.find((watch) => watch.id === outlookWatch.details.watchId);
const outlookBackoffCursor = providerBackoffState.emailSyncCursors.find((cursor) => cursor.mailboxId === 'mbx_outlook_success');
assert.equal(outlookBackoffWatch?.status, 'paused');
assert.equal(outlookBackoffWatch?.providerResponseStatus, 429);
assert.equal(outlookBackoffCursor?.status, 'blocked');

const restoredOutlookWatch = await renewMailboxWatch(outlookWatch.details.watchId, { actorUserId: 'usr_admin', statePath });
assert.equal(restoredOutlookWatch.action, 'mailboxes.watch-renew');
assert.equal(restoredOutlookWatch.details.status, 'active');

const gmailNotificationPayload = {
  message: {
    data: Buffer.from(JSON.stringify({ emailAddress: 'mia@acme.example', historyId: '987654' }), 'utf8').toString('base64'),
  },
};
const gmailNotification = await handleProviderWatchNotification('gmail', gmailNotificationPayload, { actorUserId: 'usr_admin', statePath });
assert.equal(gmailNotification.action, 'mailboxes.watch-notification');
assert.equal(gmailNotification.details.provider, 'gmail');
assert.equal(gmailNotification.details.notificationCount, 1);

const outlookClientState = createProviderWatchSecret('outlook', 'mbx_outlook_success', { local: true });
const outlookNotification = await handleProviderWatchNotification('outlook', {
  value: [
    {
      changeType: 'updated',
      clientState: outlookClientState,
      resource: 'me/messages/msg-001',
      resourceData: { id: 'msg-001' },
      subscriptionId: restoredOutlookWatch.details.providerWatchId,
    },
  ],
}, { actorUserId: 'usr_admin', statePath });
assert.equal(outlookNotification.action, 'mailboxes.watch-notification');
assert.equal(outlookNotification.details.provider, 'outlook');
assert.equal(outlookNotification.details.notificationCount, 1);

await expectStateError('missing Outlook client state is rejected', 'OUTLOOK_NOTIFICATION_CLIENT_STATE_REQUIRED', () =>
  handleProviderWatchNotification('outlook', {
    value: [
      {
        resource: 'me/messages/msg-missing-client-state',
        resourceData: { id: 'msg-missing-client-state' },
      },
    ],
  }, { actorUserId: 'usr_admin', statePath }),
);

await expectStateError('invalid Outlook client state is rejected', 'OUTLOOK_NOTIFICATION_CLIENT_STATE_INVALID', () =>
  handleProviderWatchNotification('outlook', {
    value: [
      {
        clientState: 'wrong-client-state',
        resource: 'me/messages/msg-002',
        resourceData: { id: 'msg-002' },
      },
    ],
  }, { actorUserId: 'usr_admin', statePath }),
);

const disconnectedMailbox = await disconnectMailbox('mbx_outlook_success', { actorUserId: 'usr_admin', statePath });
assert.equal(disconnectedMailbox.action, 'mailboxes.disconnect');
assert.equal(disconnectedMailbox.details.mailboxId, 'mbx_outlook_success');

await expectForbidden('member cannot disable email flow', () =>
  setEmailFlowStatus('flow_product_ideas', 'disabled', { actorUserId: 'usr_product', statePath }),
);

await expectForbidden('member cannot run email flows', () =>
  runEmailFlows({}, { actorUserId: 'usr_product', statePath }),
);

await expectForbidden('member cannot change email-flow routing', () =>
  setEmailFlowRouting('flow_buying_intent', { routeTo: 'founder', ownerUserId: 'usr_admin', note: 'Blocked member route' }, { actorUserId: 'usr_product', statePath }),
);

const founderRoute = await setEmailFlowRouting('flow_buying_intent', { routeTo: 'founder', ownerUserId: 'usr_admin', note: 'Founder review route' }, { actorUserId: 'usr_admin', statePath });
assert.equal(founderRoute.action, 'email-flows.route');
assert.equal(founderRoute.details.nextRouteTo, 'founder');
assert.equal(founderRoute.details.nextOwnerUserId, 'usr_admin');

await expectForbidden('member cannot change quality threshold', () =>
  setSignalQualityThreshold('tenant_demo', 0.82, { actorUserId: 'usr_product', statePath }),
);

await expectForbidden('member cannot change governance policy', () =>
  setGovernancePolicy('tenant_demo', { sourceRetentionDays: 30 }, { actorUserId: 'usr_product', statePath }),
);

const flowRun = await runEmailFlows({}, { actorUserId: 'usr_admin', statePath });
assert.equal(flowRun.action, 'email-flows.run');
assert.equal(flowRun.details.createdSignals, 3);
assert.equal(flowRun.details.matchedMessages, 3);
assert(flowRun.details.routeTargets.includes('founder'));

let routedSignalState = await loadState({ statePath });
const routedBuyingSignal = routedSignalState.signals.find((signal) => signal.sourceMessageId === 'msg_northstar_budget_001' && signal.flowId === 'flow_buying_intent');
assert.equal(routedBuyingSignal?.ownerUserId, 'usr_admin');
assert.equal(routedBuyingSignal?.routeTo, 'founder');
assert.equal(routedBuyingSignal?.routingRuleId, founderRoute.details.routingRuleId);
assert(doctor(routedSignalState).checks.find((check) => check.id === 'routing_rules_audited')?.ok, 'doctor should validate auditable routing rules');

const duplicateFlowRun = await runEmailFlows({}, { actorUserId: 'usr_admin', statePath });
assert.equal(duplicateFlowRun.action, 'email-flows.run');
assert.equal(duplicateFlowRun.details.createdSignals, 0);
assert.equal(duplicateFlowRun.details.skippedSignals, 3);

await expectForbidden('member cannot run operational jobs', () =>
  runJobs({ queue: 'email_sync' }, { actorUserId: 'usr_product', statePath }),
);

let workerState = await loadState({ statePath });
workerState.jobs.push({
  id: 'job_verify_gmail_sync_run',
  tenantId: 'tenant_demo',
  queue: 'email_sync',
  type: 'gmail.watch.notification',
  targetId: 'mbx_gmail_sales',
  status: 'queued',
  attempts: 0,
  maxAttempts: 3,
  lastRunAt: null,
  message: 'Verifier queued Gmail watch-notification worker job.',
});
await saveState(workerState, { statePath });
const ranEmailSyncJob = await runJobs({ jobId: 'job_verify_gmail_sync_run' }, { actorUserId: 'usr_admin', statePath });
assert.equal(ranEmailSyncJob.action, 'jobs.run');
assert.equal(ranEmailSyncJob.details.count, 1);
assert.equal(ranEmailSyncJob.details.succeeded, 1);
assert.equal(ranEmailSyncJob.details.outcomes[0].status, 'succeeded');
workerState = await loadState({ statePath });
assert.equal(workerState.jobs.find((job) => job.id === 'job_verify_gmail_sync_run')?.status, 'succeeded');

const qualityThreshold = await setSignalQualityThreshold('tenant_demo', 0.93, { actorUserId: 'usr_admin', statePath });
assert.equal(qualityThreshold.action, 'quality.threshold');
assert.equal(qualityThreshold.details.minimumConfidence, 0.93);

const suppressionRule = await createSuppressionRule({ tenantId: 'tenant_demo', type: 'domain', value: 'blocked.example', reason: 'Verifier suppression domain' }, { actorUserId: 'usr_admin', statePath });
assert.equal(suppressionRule.action, 'quality.suppression-add');

let qualityState = await loadState({ statePath });
qualityState.sourceMessages.push(
  {
    id: 'msg_blocked_domain_001',
    tenantId: 'tenant_demo',
    mailboxId: 'mbx_gmail_sales',
    providerThreadId: 'local-thread-blocked-domain',
    account: 'Blocked Co',
    from: 'lead@blocked.example',
    subject: 'Budget and security review timing',
    snippet: 'Budget, timeline, competitor, and security review language should be suppressed by domain.',
    receivedAt: '2026-06-03T12:00:00.000Z',
    labels: ['Prospects'],
    processedFlowIds: [],
  },
  {
    id: 'msg_low_confidence_001',
    tenantId: 'tenant_demo',
    mailboxId: 'mbx_gmail_sales',
    providerThreadId: 'local-thread-low-confidence',
    account: 'Low Confidence Co',
    from: 'lead@lowconfidence.example',
    subject: 'Budget question',
    snippet: 'Budget question only.',
    receivedAt: '2026-06-03T12:05:00.000Z',
    labels: ['Prospects'],
    processedFlowIds: [],
  },
);
await saveState(qualityState, { statePath });

const suppressedRun = await runEmailFlows({ flowId: 'flow_buying_intent', mailboxId: 'mbx_gmail_sales' }, { actorUserId: 'usr_admin', statePath });
assert.equal(suppressedRun.action, 'email-flows.run');
assert.equal(suppressedRun.details.createdSignals, 0);
assert(suppressedRun.details.suppressedMessages >= 2, 'suppression rule and confidence threshold should suppress matching messages');

const disabledSuppression = await setSuppressionRuleStatus(suppressionRule.details.ruleId, 'disabled', { actorUserId: 'usr_admin', statePath });
assert.equal(disabledSuppression.action, 'quality.suppression-status');
assert.equal(disabledSuppression.details.nextStatus, 'disabled');

const optInModelPolicy = await setModelGovernancePolicy('tenant_demo', { learningMode: 'opt_in_tuning', note: 'Verifier governance review' }, { actorUserId: 'usr_admin', statePath });
assert.equal(optInModelPolicy.action, 'models.policy');
assert.equal(optInModelPolicy.details.learningMode, 'opt_in_tuning');
assert.equal(optInModelPolicy.details.trainingDataUse, 'opt_in_only');
assert.equal(optInModelPolicy.details.perTenantModel, false);
const disabledModelPolicy = await setModelGovernancePolicy('tenant_demo', { learningMode: 'disabled' }, { actorUserId: 'usr_admin', statePath });
assert.equal(disabledModelPolicy.details.learningMode, 'disabled');
assert.equal(disabledModelPolicy.details.trainingDataUse, 'excluded_by_default');

const governancePolicy = await setGovernancePolicy('tenant_demo', { sourceRetentionDays: 30, rawSnippetRetentionDays: 7, exportWindowDays: 21, redactionMode: 'strict' }, { actorUserId: 'usr_admin', statePath });
assert.equal(governancePolicy.action, 'governance.policy');
assert.equal(governancePolicy.details.sourceRetentionDays, 30);

await expectStateError('governance policy rejects raw retention above source retention', 'ARG_INVALID', () =>
  setGovernancePolicy('tenant_demo', { sourceRetentionDays: 14, rawSnippetRetentionDays: 30 }, { actorUserId: 'usr_admin', statePath }),
);

const redactionRule = await createRedactionRule({ tenantId: 'tenant_demo', scope: 'exports', label: 'Executive names', pattern: 'executive sponsor', replacement: '[executive]' }, { actorUserId: 'usr_admin', statePath });
assert.equal(redactionRule.action, 'governance.redaction-add');

const disabledRedaction = await setRedactionRuleStatus(redactionRule.details.ruleId, 'disabled', { actorUserId: 'usr_admin', statePath });
assert.equal(disabledRedaction.action, 'governance.redaction-status');
assert.equal(disabledRedaction.details.nextStatus, 'disabled');

const dataRequest = await createDataRequest({ tenantId: 'tenant_demo', type: 'delete', requesterEmail: 'privacy@acmehealth.example', targetAccount: 'Acme Health', note: 'Verifier delete request' }, { actorUserId: 'usr_admin', statePath });
assert.equal(dataRequest.action, 'governance.request-create');

const completedRequest = await setDataRequestStatus(dataRequest.details.requestId, 'completed', { note: 'Handled in local verifier' }, { actorUserId: 'usr_admin', statePath });
assert.equal(completedRequest.action, 'governance.request-status');
assert.equal(completedRequest.details.nextStatus, 'completed');

const incidentNote = await createIncidentNote({ tenantId: 'tenant_demo', severity: 'incident', title: 'Verifier incident', body: 'Governance verifier incident note' }, { actorUserId: 'usr_admin', statePath });
assert.equal(incidentNote.action, 'governance.incident-add');

const resolvedIncident = await resolveIncidentNote(incidentNote.details.incidentId, { actorUserId: 'usr_admin', statePath });
assert.equal(resolvedIncident.action, 'governance.incident-resolve');
assert.equal(resolvedIncident.details.nextStatus, 'resolved');

await expectForbidden('member cannot close unowned account action', () =>
  setAccountActionStatus('act_acme_exec_save', 'done', { actorUserId: 'usr_product', statePath }),
);

const closedOwnAccountAction = await setAccountActionStatus('act_ventureworks_export_discovery', 'done', { actorUserId: 'usr_product', statePath });
assert.equal(closedOwnAccountAction.action, 'accounts.action-status');
assert.equal(closedOwnAccountAction.details.nextStatus, 'done');

const mutedAdminAction = await setAccountActionStatus('act_acme_exec_save', 'muted', { actorUserId: 'usr_admin', statePath });
assert.equal(mutedAdminAction.details.nextStatus, 'muted');

await expectForbidden('non-owner cannot create account review', () =>
  createAccountReview('Acme_Health', { note: 'Blocked member review' }, { actorUserId: 'usr_product', statePath }),
);

const productAccountReview = await createAccountReview('VentureWorks', { note: 'Product discovery review' }, { actorUserId: 'usr_product', statePath });
assert.equal(productAccountReview.action, 'accounts.review');
assert.equal(productAccountReview.actor.id, 'usr_product');
assert.match(productAccountReview.details.reviewId, /^ar_/);
assert.equal(productAccountReview.details.account, 'VentureWorks');
assert(productAccountReview.details.openActionCount >= 1);
let accountReviewState = await loadState({ statePath });
const storedProductReview = accountReviewState.accountReviews.find((review) => review.id === productAccountReview.details.reviewId);
assert.equal(storedProductReview?.note, 'Product discovery review');
assert.equal(storedProductReview?.createdByUserId, 'usr_product');
assert(accountReviewState.accountEvents.some((event) => event.reviewId === productAccountReview.details.reviewId && event.type === 'account_review'), 'account review should append timeline event');
assert(doctor(accountReviewState).checks.find((check) => check.id === 'account_reviews_audited')?.ok, 'doctor should validate account review audit metadata');

const memberPreference = await setNotificationPreference('usr_product', { digestCadence: 'weekly', immediateAlerts: false, mutedAccounts: ['Acme Health'] }, { actorUserId: 'usr_product', statePath });
assert.equal(memberPreference.action, 'notifications.preference');
assert.equal(memberPreference.details.userId, 'usr_product');

await expectForbidden('member cannot edit another user notification preference', () =>
  setNotificationPreference('usr_sales', { digestCadence: 'off' }, { actorUserId: 'usr_product', statePath }),
);

let notificationState = await loadState({ statePath });
const ownNotification = notificationState.notificationEvents.find((event) => event.userId === 'usr_product');
assert(ownNotification, 'member-owned notification should exist');
const readOwnNotification = await setNotificationStatus(ownNotification.id, 'read', { actorUserId: 'usr_product', statePath });
assert.equal(readOwnNotification.action, 'notifications.status');
assert.equal(readOwnNotification.details.nextStatus, 'read');

await expectForbidden('member cannot update another user notification status', () =>
  setNotificationStatus('ntf_sig_sig_risk_001', 'read', { actorUserId: 'usr_product', statePath }),
);

const digestRun = await runNotificationDigest({ tenantId: 'tenant_demo' }, { actorUserId: 'usr_admin', statePath });
assert.equal(digestRun.action, 'notifications.digest-run');
assert(digestRun.details.sentCount >= 1, 'admin digest should include unread notification events');
assert(digestRun.details.deliveryMessageIds.length >= 1, 'digest run should create outbound email delivery messages');

const sentDelivery = await setEmailDeliveryStatus(digestRun.details.deliveryMessageIds[0], 'sent', { reason: 'Verifier local SMTP accepted' }, { actorUserId: 'usr_admin', statePath });
assert.equal(sentDelivery.action, 'notifications.delivery-status');
assert.equal(sentDelivery.details.nextStatus, 'sent');

const queuedDelivery = await setEmailDeliveryStatus(digestRun.details.deliveryMessageIds[0], 'queued', { reason: 'Verifier local worker retry' }, { actorUserId: 'usr_admin', statePath });
assert.equal(queuedDelivery.details.nextStatus, 'queued');
const emailProviderCalls = [];
const emailProviderEnv = {
  SIGNAL_APP_BASE_URL: 'http://127.0.0.1:5173',
  SIGNAL_EMAIL_FROM: 'Signal <signals@acme.example>',
  SIGNAL_EMAIL_PROVIDER_MODE: 'live',
  SIGNAL_EMAIL_PROVIDER_NAME: 'contract_mail',
  SIGNAL_EMAIL_PROVIDER_TOKEN: 'email_provider_secret_for_verifier',
  SIGNAL_EMAIL_PROVIDER_URL: 'https://email.provider.test/send',
  SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET: 'email_webhook_secret_for_verifier',
};
const emailProviderFetch = async (url, init) => {
  emailProviderCalls.push({
    body: JSON.parse(init.body),
    headers: init.headers,
    method: init.method,
    url,
  });
  return new Response(JSON.stringify({
    id: 'msg_email_provider_001',
    status: 'accepted',
  }), { status: 202 });
};
const ranOutboundJob = await runJobs({ queue: 'outbound_email', limit: 1 }, {
  actorUserId: 'usr_admin',
  env: emailProviderEnv,
  fetchImpl: emailProviderFetch,
  liveEmailProvider: true,
  statePath,
});
assert.equal(ranOutboundJob.action, 'jobs.run');
assert.equal(ranOutboundJob.details.succeeded, 1);
let outboundState = await loadState({ statePath });
assert.equal(outboundState.emailDeliveryMessages.find((message) => message.id === digestRun.details.deliveryMessageIds[0])?.status, 'sent');
const liveDeliveryMessage = outboundState.emailDeliveryMessages.find((message) => message.id === digestRun.details.deliveryMessageIds[0]);
assert.equal(liveDeliveryMessage.provider, 'contract_mail');
assert.equal(liveDeliveryMessage.providerMode, 'live');
assert.equal(liveDeliveryMessage.providerMessageId, 'msg_email_provider_001');
assert.equal(liveDeliveryMessage.providerRequestDigest.length, 24);
assert.equal(emailProviderCalls.length, 1);
assert.equal(emailProviderCalls[0].url, emailProviderEnv.SIGNAL_EMAIL_PROVIDER_URL);
assert.equal(emailProviderCalls[0].method, 'POST');
assert.equal(emailProviderCalls[0].headers.Authorization, `Bearer ${emailProviderEnv.SIGNAL_EMAIL_PROVIDER_TOKEN}`);
assert.equal(emailProviderCalls[0].body.metadata.messageId, digestRun.details.deliveryMessageIds[0]);
assert.equal(emailProviderCalls[0].body.from, emailProviderEnv.SIGNAL_EMAIL_FROM);

const emailBouncePayload = JSON.stringify({
  id: 'evt_email_bounce_001',
  provider: 'contract_mail',
  providerMessageId: 'msg_email_provider_001',
  reason: 'Mailbox unavailable',
  status: 'bounced',
});
await expectStateError('invalid email webhook signature is rejected', 'EMAIL_WEBHOOK_SIGNATURE_INVALID', () =>
  handleSignedEmailDeliveryWebhook(emailBouncePayload, `t=${Math.floor(Date.now() / 1000)},v1=bad`, { actorUserId: 'usr_admin', endpointSecret: emailProviderEnv.SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET, statePath }),
);
const emailBounceHeader = signEmailWebhookPayload(emailBouncePayload, emailProviderEnv.SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET);
const bouncedDelivery = await handleSignedEmailDeliveryWebhook(emailBouncePayload, emailBounceHeader, { actorUserId: 'usr_admin', endpointSecret: emailProviderEnv.SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET, statePath });
assert.equal(bouncedDelivery.action, 'notifications.delivery-webhook');
assert.equal(bouncedDelivery.details.nextStatus, 'bounced');
assert.equal(bouncedDelivery.details.signatureStatus, 'verified');

const sendGridQueuedDelivery = await setEmailDeliveryStatus(digestRun.details.deliveryMessageIds[0], 'queued', { reason: 'Verifier SendGrid retry' }, { actorUserId: 'usr_admin', statePath });
const sendGridProviderCalls = [];
const sendGridProviderEnv = {
  SIGNAL_APP_BASE_URL: 'http://127.0.0.1:5173',
  SIGNAL_EMAIL_FROM: 'Signal <signals@acme.example>',
  SIGNAL_EMAIL_PROVIDER: 'sendgrid',
  SIGNAL_EMAIL_PROVIDER_MODE: 'live',
  SIGNAL_SENDGRID_API_BASE_URL: 'https://sendgrid.test',
  SIGNAL_SENDGRID_API_KEY: 'sendgrid_secret_for_verifier',
  SIGNAL_SENDGRID_ASM_GROUP_ID: '98765',
  SIGNAL_SENDGRID_ASM_GROUPS_TO_DISPLAY: '98765,98766',
  SIGNAL_SENDGRID_CATEGORIES: 'sales_signal,product_ideas',
  SIGNAL_SENDGRID_CLICK_TRACKING: 'false',
  SIGNAL_SENDGRID_IP_POOL_NAME: 'transactional',
  SIGNAL_SENDGRID_OPEN_TRACKING: 'false',
  SIGNAL_SENDGRID_REPLY_TO: 'Signal Ops <ops@acme.example>',
  SIGNAL_SENDGRID_SANDBOX_MODE: 'true',
};
const sendGridProviderFetch = async (url, init) => {
  sendGridProviderCalls.push({
    body: JSON.parse(init.body),
    headers: init.headers,
    method: init.method,
    url,
  });
  return new Response('', {
    headers: {
      'x-message-id': 'sg_msg_signal_digest_001',
    },
    status: 202,
  });
};
const ranSendGridJob = await runJobs({ jobId: sendGridQueuedDelivery.details.jobId }, {
  actorUserId: 'usr_admin',
  env: sendGridProviderEnv,
  fetchImpl: sendGridProviderFetch,
  liveEmailProvider: true,
  statePath,
});
assert.equal(ranSendGridJob.action, 'jobs.run');
assert.equal(ranSendGridJob.details.succeeded, 1);
assert.equal(sendGridProviderCalls.length, 1);
assert.equal(sendGridProviderCalls[0].url, 'https://sendgrid.test/v3/mail/send');
assert.equal(sendGridProviderCalls[0].headers.Authorization, `Bearer ${sendGridProviderEnv.SIGNAL_SENDGRID_API_KEY}`);
assert.equal(sendGridProviderCalls[0].body.from.email, 'signals@acme.example');
assert.equal(sendGridProviderCalls[0].body.from.name, 'Signal');
assert.equal(sendGridProviderCalls[0].body.personalizations[0].to[0].email, liveDeliveryMessage.toEmail);
assert.equal(sendGridProviderCalls[0].body.personalizations[0].custom_args.signal_message_id, digestRun.details.deliveryMessageIds[0]);
assert.deepEqual(sendGridProviderCalls[0].body.categories, ['signal_digest', 'sales_signal', 'product_ideas']);
assert.deepEqual(sendGridProviderCalls[0].body.asm, { group_id: 98765, groups_to_display: [98765, 98766] });
assert.equal(sendGridProviderCalls[0].body.ip_pool_name, 'transactional');
assert.equal(sendGridProviderCalls[0].body.reply_to.email, 'ops@acme.example');
assert.equal(sendGridProviderCalls[0].body.reply_to.name, 'Signal Ops');
assert.equal(sendGridProviderCalls[0].body.tracking_settings.click_tracking.enable, false);
assert.equal(sendGridProviderCalls[0].body.tracking_settings.open_tracking.enable, false);
assert.equal(sendGridProviderCalls[0].body.personalizations[0].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
assert.equal(sendGridProviderCalls[0].body.mail_settings.sandbox_mode.enable, true);
await assert.rejects(
  () => deliverEmailMessage(liveDeliveryMessage, {
    env: {
      ...sendGridProviderEnv,
      SIGNAL_SENDGRID_ASM_GROUP_ID: '',
      SIGNAL_SENDGRID_ASM_GROUPS_TO_DISPLAY: '98765',
    },
    fetchImpl: sendGridProviderFetch,
    liveEmailProvider: true,
  }),
  (error) => error.code === 'EMAIL_PROVIDER_CONFIG_INVALID' && error.details.requiredEnv === 'SIGNAL_SENDGRID_ASM_GROUP_ID',
);
await assert.rejects(
  () => deliverEmailMessage(liveDeliveryMessage, {
    env: {
      ...sendGridProviderEnv,
      SIGNAL_SENDGRID_CLICK_TRACKING: 'maybe',
    },
    fetchImpl: sendGridProviderFetch,
    liveEmailProvider: true,
  }),
  (error) => error.code === 'EMAIL_PROVIDER_CONFIG_INVALID' && error.details.label === 'SIGNAL_SENDGRID_CLICK_TRACKING',
);

outboundState = await loadState({ statePath });
const sendGridDeliveryMessage = outboundState.emailDeliveryMessages.find((message) => message.id === digestRun.details.deliveryMessageIds[0]);
assert.equal(sendGridDeliveryMessage.provider, 'sendgrid');
assert.equal(sendGridDeliveryMessage.providerMode, 'live');
assert.equal(sendGridDeliveryMessage.providerMessageId, 'sg_msg_signal_digest_001');
assert.equal(sendGridDeliveryMessage.providerStatus, 'accepted');

const sendGridKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const sendGridPrivateKey = sendGridKeyPair.privateKey.export({ format: 'pem', type: 'pkcs8' });
const sendGridPublicKey = sendGridKeyPair.publicKey.export({ format: 'pem', type: 'spki' });
const sendGridEventsPayload = JSON.stringify([
  {
    email: liveDeliveryMessage.toEmail,
    event: 'delivered',
    sg_event_id: 'sg_evt_delivered_001',
    sg_message_id: 'sg_msg_signal_digest_001',
    signal_message_id: digestRun.details.deliveryMessageIds[0],
    signal_unsubscribe_code: liveDeliveryMessage.unsubscribeCode,
  },
  {
    email: liveDeliveryMessage.toEmail,
    event: 'open',
    sg_event_id: 'sg_evt_open_001',
    sg_message_id: 'sg_msg_signal_digest_001',
    signal_message_id: digestRun.details.deliveryMessageIds[0],
  },
]);
const sendGridSignedHeaders = signSendGridWebhookPayload(sendGridEventsPayload, sendGridPrivateKey);
await expectStateError('invalid SendGrid webhook signature is rejected', 'EMAIL_WEBHOOK_SIGNATURE_INVALID', () =>
  handleSignedSendGridEmailDeliveryWebhook(sendGridEventsPayload, 'bad_signature', sendGridSignedHeaders.timestampHeader, { actorUserId: 'usr_admin', endpointPublicKey: sendGridPublicKey, statePath }),
);
const sendGridWebhookResult = await handleSignedSendGridEmailDeliveryWebhook(sendGridEventsPayload, sendGridSignedHeaders.signatureHeader, sendGridSignedHeaders.timestampHeader, {
  actorUserId: 'usr_admin',
  endpointPublicKey: sendGridPublicKey,
  statePath,
});
assert.equal(sendGridWebhookResult.action, 'notifications.delivery-webhook');
assert.equal(sendGridWebhookResult.details.count, 2);
assert.deepEqual(sendGridWebhookResult.details.statuses, ['sent', 'sent']);

outboundState = await loadState({ statePath });
assert.equal(outboundState.emailDeliveryMessages.find((message) => message.id === digestRun.details.deliveryMessageIds[0])?.provider, 'sendgrid');
assert.equal(outboundState.emailDeliveryMessages.find((message) => message.id === digestRun.details.deliveryMessageIds[0])?.providerStatus, 'open');

const emailUnsubscribe = await handleEmailDeliveryWebhook({
  id: 'evt_email_unsubscribe_001',
  messageId: digestRun.details.deliveryMessageIds[0],
  provider: 'sendgrid',
  providerMessageId: 'sg_msg_signal_digest_001',
  status: 'unsubscribed',
  unsubscribeCode: liveDeliveryMessage.unsubscribeCode,
}, { actorUserId: 'usr_admin', statePath });
assert.equal(emailUnsubscribe.action, 'notifications.delivery-webhook');
assert.equal(emailUnsubscribe.details.nextStatus, 'suppressed');
outboundState = await loadState({ statePath });
assert.equal(outboundState.emailDeliveryMessages.find((message) => message.id === digestRun.details.deliveryMessageIds[0])?.status, 'suppressed');
assert.equal(outboundState.notificationPreferences.find((preference) => preference.userId === liveDeliveryMessage.userId)?.emailDeliveryStatus, 'unsubscribed');

const secondDigestRun = await runNotificationDigest({ tenantId: 'tenant_demo' }, { actorUserId: 'usr_admin', statePath });
assert.equal(secondDigestRun.action, 'notifications.digest-run');
const unsubscribe = await unsubscribeEmailDigest('usr_sales', { actorUserId: 'usr_admin', statePath });
assert.equal(unsubscribe.action, 'notifications.unsubscribe');

const afterUnsubscribeDigest = await runNotificationDigest({ tenantId: 'tenant_demo', userId: 'usr_sales' }, { actorUserId: 'usr_admin', statePath });
assert.equal(afterUnsubscribeDigest.details.sentCount, 0, 'unsubscribed user should not receive email digest items');

let digestWorkerState = await loadState({ statePath });
digestWorkerState.jobs.push({
  id: 'job_verify_digest_run',
  tenantId: 'tenant_demo',
  queue: 'notification_digest',
  type: 'notifications.digest.prepare_delivery',
  targetId: 'tenant_demo',
  status: 'queued',
  attempts: 0,
  maxAttempts: 3,
  lastRunAt: null,
  message: 'Verifier queued notification digest worker job.',
});
await saveState(digestWorkerState, { statePath });
const ranDigestJob = await runJobs({ queue: 'notification_digest', limit: 1 }, { actorUserId: 'usr_admin', statePath });
assert.equal(ranDigestJob.action, 'jobs.run');
assert.equal(ranDigestJob.details.succeeded, 1);
digestWorkerState = await loadState({ statePath });
assert.equal(digestWorkerState.jobs.find((job) => job.id === 'job_verify_digest_run')?.status, 'succeeded');

await expectForbidden('member cannot assign another owner', () =>
  assignSignal('sig_risk_001', 'usr_sales', { actorUserId: 'usr_product', statePath }),
);

const routedOwnSignal = await setSignalStatus('sig_product_001', 'open', { actorUserId: 'usr_product', statePath });
assert.equal(routedOwnSignal.action, 'signals.status');
assert.equal(routedOwnSignal.details.nextStatus, 'open');

const ownFeedback = await recordSignalFeedback('sig_product_001', 'product_gap', { note: 'Useful product planning signal' }, { actorUserId: 'usr_product', statePath });
assert.equal(ownFeedback.action, 'signals.feedback');
assert.equal(ownFeedback.details.label, 'product_gap');

const ownHandoff = await createSignalHandoff('sig_product_001', { target: 'crm', note: 'Product CRM handoff' }, { actorUserId: 'usr_product', statePath });
assert.equal(ownHandoff.action, 'signals.handoff');
assert.equal(ownHandoff.details.status, 'queued');
assert.equal(ownHandoff.details.target, 'crm');

const ranHandoffJob = await runJobs({ queue: 'signal_handoff', limit: 1 }, { actorUserId: 'usr_admin', statePath });
assert.equal(ranHandoffJob.action, 'jobs.run');
assert.equal(ranHandoffJob.details.succeeded, 1);
assert.equal(ranHandoffJob.details.outcomes[0].handoffId, ownHandoff.details.handoffId);
assert.equal(ranHandoffJob.details.outcomes[0].handoffStatus, 'sent');

const ownTaskHandoff = await createSignalHandoff('sig_product_001', { target: 'task', note: 'Product task handoff' }, { actorUserId: 'usr_product', statePath });
assert.equal(ownTaskHandoff.action, 'signals.handoff');
assert.equal(ownTaskHandoff.details.status, 'queued');

const sentHandoff = await setSignalHandoffStatus(ownTaskHandoff.details.handoffId, 'sent', { providerRef: 'task_verify', note: 'Sent to task board' }, { actorUserId: 'usr_product', statePath });
assert.equal(sentHandoff.action, 'signals.handoff-status');
assert.equal(sentHandoff.details.nextStatus, 'sent');

await expectForbidden('non-owner cannot change signal status', () =>
  setSignalStatus('sig_expansion_001', 'dismissed', { actorUserId: 'usr_product', statePath }),
);

await expectForbidden('non-owner cannot record signal feedback', () =>
  recordSignalFeedback('sig_expansion_001', 'noisy', {}, { actorUserId: 'usr_product', statePath }),
);

await expectForbidden('non-owner cannot create signal handoff', () =>
  createSignalHandoff('sig_expansion_001', { target: 'task' }, { actorUserId: 'usr_product', statePath }),
);

const handoffState = await loadState({ statePath });
assert(handoffState.signalHandoffs.some((handoff) => handoff.id === ownHandoff.details.handoffId && handoff.status === 'sent' && handoff.providerRef && handoff.providerRequestDigest && handoff.providerResponseDigest));
assert(handoffState.signalHandoffs.some((handoff) => handoff.id === ownTaskHandoff.details.handoffId && handoff.status === 'sent' && handoff.providerRef === 'task_verify'));
assert.equal(handoffState.signals.find((signal) => signal.id === 'sig_product_001')?.latestHandoffStatus, 'sent');

await expectForbidden('member cannot comp tenant', () =>
  compTenant('tenant_demo', 'plan_beta', { actorUserId: 'usr_product', statePath }),
);

await expectForbidden('member cannot create checkout', () =>
  createCheckoutSession('tenant_demo', 'plan_team', { actorUserId: 'usr_product', statePath }),
);

await expectForbidden('member without billing ownership cannot create portal', () =>
  createBillingPortalSession('tenant_demo', { actorUserId: 'usr_product', statePath }),
);

const checkout = await createCheckoutSession('tenant_demo', 'plan_team', { actorUserId: 'usr_admin', statePath });
assert.equal(checkout.action, 'payments.checkout');
assert.match(checkout.details.url, /^signal:\/\/billing\/checkout\//);
assert.equal(checkout.summary.billingSessions, 2);

const portal = await createBillingPortalSession('tenant_demo', { actorUserId: 'usr_admin', statePath });
assert.equal(portal.action, 'payments.portal');
assert.match(portal.details.url, /^signal:\/\/billing\/portal\//);

let paymentState = await loadState({ statePath });
paymentState.tenants.find((tenant) => tenant.id === 'tenant_demo').billingOwnerUserId = 'usr_product';
await saveState(paymentState, { statePath });
const billingOwnerPortal = await createBillingPortalSession('tenant_demo', { actorUserId: 'usr_product', statePath });
assert.equal(billingOwnerPortal.action, 'payments.portal');
assert.match(billingOwnerPortal.details.url, /^signal:\/\/billing\/portal\//);
const billingOwnerCheckout = await createCheckoutSession('tenant_demo', 'plan_team', { actorUserId: 'usr_product', statePath });
assert.equal(billingOwnerCheckout.action, 'payments.checkout');

await expectForbidden('member cannot create billing override', () =>
  createBillingOverride('tenant_demo', 'support_credit', { amountCents: 2500, reason: 'Blocked member credit' }, { actorUserId: 'usr_product', statePath }),
);

const supportCredit = await createBillingOverride('tenant_demo', 'support_credit', { amountCents: 2500, reason: 'Onboarding credit' }, { actorUserId: 'usr_admin', statePath });
assert.equal(supportCredit.action, 'payments.override');
assert.equal(supportCredit.details.amountCents, 2500);
assert.equal(supportCredit.summary.activeBillingOverrides, 1);

const manualEntitlement = await createBillingOverride('tenant_demo', 'manual_entitlement', { planId: 'plan_beta', reason: 'Support access' }, { actorUserId: 'usr_admin', statePath });
assert.equal(manualEntitlement.details.overrideType, 'manual_entitlement');
assert.equal(manualEntitlement.details.planId, 'plan_beta');
paymentState = await loadState({ statePath });
let overrideEntitlement = paymentState.entitlements.find((entitlement) => entitlement.tenantId === 'tenant_demo');
assert.equal(overrideEntitlement?.source, 'override');
assert.equal(overrideEntitlement?.overrideId, manualEntitlement.details.overrideId);
assert.equal(overrideEntitlement?.seatLimit, 5);
assert(paymentState.paymentEvents.some((event) => event.billingOverrideId === manualEntitlement.details.overrideId && event.type === 'billing.override.manual_entitlement.created'), 'manual entitlement override should be present in payment events');

const revokedManualEntitlement = await revokeBillingOverride(manualEntitlement.details.overrideId, { reason: 'Resolved' }, { actorUserId: 'usr_admin', statePath });
assert.equal(revokedManualEntitlement.action, 'payments.override-revoke');
paymentState = await loadState({ statePath });
overrideEntitlement = paymentState.entitlements.find((entitlement) => entitlement.tenantId === 'tenant_demo');
assert.equal(overrideEntitlement?.source, 'subscription');
assert.equal(overrideEntitlement?.seatLimit, 10);
assert.equal(paymentState.billingOverrides.find((override) => override.id === manualEntitlement.details.overrideId)?.status, 'revoked');

const revokedSupportCredit = await revokeBillingOverride(supportCredit.details.overrideId, { reason: 'Credit settled' }, { actorUserId: 'usr_admin', statePath });
assert.equal(revokedSupportCredit.details.status, 'revoked');

await expectForbidden('member cannot sync payment state', () =>
  syncPaymentState({ tenantId: 'tenant_demo' }, { actorUserId: 'usr_product', statePath }),
);

const expiredManualEntitlement = await createBillingOverride('tenant_demo', 'manual_entitlement', {
  expiresAt: '2020-01-01T00:00:00.000Z',
  planId: 'plan_beta',
  reason: 'Expired verifier access',
}, { actorUserId: 'usr_admin', statePath });
assert.equal(expiredManualEntitlement.action, 'payments.override');
const expiredManualSuspension = await createBillingOverride('tenant_demo', 'manual_suspension', {
  expiresAt: '2020-01-01T00:00:00.000Z',
  reason: 'Expired verifier suspension',
}, { actorUserId: 'usr_admin', statePath });
assert.equal(expiredManualSuspension.action, 'payments.override');
paymentState = await loadState({ statePath });
const expiredOverrideSubscription = paymentState.subscriptions.find((subscription) => subscription.billingOverrideId === expiredManualEntitlement.details.overrideId);
assert.equal(expiredOverrideSubscription?.status, 'active');
assert.equal(paymentState.tenants.find((tenant) => tenant.id === 'tenant_demo')?.status, 'suspended');

const syncedPaymentState = await syncPaymentState({ tenantId: 'tenant_demo' }, { actorUserId: 'usr_admin', statePath });
assert.equal(syncedPaymentState.action, 'payments.sync');
assert(syncedPaymentState.details.expiredOverrideIds.includes(expiredManualEntitlement.details.overrideId));
assert(syncedPaymentState.details.expiredOverrideIds.includes(expiredManualSuspension.details.overrideId));
assert(syncedPaymentState.details.canceledSubscriptionIds.includes(expiredOverrideSubscription.id));
assert(syncedPaymentState.details.results.some((result) => result.tenantStatusChange === 'reactivated'));
paymentState = await loadState({ statePath });
const syncedEntitlement = paymentState.entitlements.find((entitlement) => entitlement.tenantId === 'tenant_demo');
assert.equal(paymentState.billingOverrides.find((override) => override.id === expiredManualEntitlement.details.overrideId)?.status, 'expired');
assert.equal(paymentState.billingOverrides.find((override) => override.id === expiredManualSuspension.details.overrideId)?.status, 'expired');
assert.equal(paymentState.subscriptions.find((subscription) => subscription.id === expiredOverrideSubscription.id)?.status, 'canceled');
assert.equal(paymentState.tenants.find((tenant) => tenant.id === 'tenant_demo')?.status, 'active');
assert.equal(syncedEntitlement?.source, 'subscription');
assert.equal(syncedEntitlement?.seatLimit, 10);
assert(paymentState.paymentEvents.some((event) => event.type === 'billing.sync.completed' && event.tenantId === 'tenant_demo'), 'payment sync should be recorded in payment events');
assert(paymentState.jobs.some((job) => job.type === 'payment.sync' && job.status === 'succeeded'), 'payment sync should append a succeeded billing job');

const stripeApiCalls = [];
const stripeEnv = {
  SIGNAL_APP_BASE_URL: 'http://127.0.0.1:5173',
  SIGNAL_STRIPE_PRICE_TEAM: 'price_signal_team_test',
  STRIPE_SECRET_KEY: 'sk_test_signal_live_boundary',
};
const stripeFetch = async (url, init) => {
  stripeApiCalls.push({
    body: init.body,
    headers: init.headers,
    method: init.method,
    url,
  });
  if (url.endsWith('/checkout/sessions')) {
    return new Response(JSON.stringify({
      customer: 'cus_signal_test',
      expires_at: 1780527000,
      id: 'cs_test_signal_checkout',
      object: 'checkout.session',
      url: 'https://checkout.stripe.com/c/pay/cs_test_signal_checkout',
    }), { status: 200 });
  }
  if (url.endsWith('/billing_portal/sessions')) {
    return new Response(JSON.stringify({
      id: 'bps_signal_portal',
      object: 'billing_portal.session',
      url: 'https://billing.stripe.com/p/session/bps_signal_portal',
    }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { message: 'Unexpected Stripe verifier URL' } }), { status: 404 });
};
const stripeWebhookSecret = 'whsec_signal_local_test';

const liveCheckout = await createCheckoutSession('tenant_demo', 'plan_team', {
  actorUserId: 'usr_admin',
  env: stripeEnv,
  fetchImpl: stripeFetch,
  idempotencyKey: 'signal-verifier-checkout',
  livePaymentProvider: true,
  statePath,
});
assert.equal(liveCheckout.action, 'payments.checkout');
assert.equal(liveCheckout.details.provider, 'stripe');
assert.equal(liveCheckout.details.mode, 'live');
assert.equal(liveCheckout.details.providerSessionId, 'cs_test_signal_checkout');
assert.match(liveCheckout.details.url, /^https:\/\/checkout\.stripe\.com\//);
assert.equal(stripeApiCalls[0].headers.Authorization, 'Bearer sk_test_signal_live_boundary');
assert.equal(stripeApiCalls[0].headers['Stripe-Version'], '2026-02-25.clover');
assert.equal(new URLSearchParams(stripeApiCalls[0].body).get('line_items[0][price]'), 'price_signal_team_test');
assert.equal(new URLSearchParams(stripeApiCalls[0].body).get('metadata[tenantId]'), 'tenant_demo');
assert.equal(new URLSearchParams(stripeApiCalls[0].body).get('subscription_data[metadata][planId]'), 'plan_team');

const stripeCheckoutPayload = JSON.stringify({
  id: 'evt_stripe_checkout_completed_local',
  type: 'checkout.session.completed',
  livemode: false,
  data: {
    object: {
      id: 'cs_test_signal_checkout',
      object: 'checkout.session',
      customer: 'cus_signal_test',
      subscription: 'sub_stripe_signal_test',
      metadata: {
        planId: 'plan_team',
        tenantId: 'tenant_demo',
      },
    },
  },
});
const stripeCheckoutHeader = signStripeWebhookPayload(stripeCheckoutPayload, stripeWebhookSecret);
const signedCheckoutPayment = await handleSignedStripePaymentWebhook(stripeCheckoutPayload, stripeCheckoutHeader, { actorUserId: 'usr_admin', endpointSecret: stripeWebhookSecret, statePath });
assert.equal(signedCheckoutPayment.details.provider, 'stripe');
assert.equal(signedCheckoutPayment.details.providerCustomerId, 'cus_signal_test');
assert.equal(signedCheckoutPayment.details.providerSubscriptionId, 'sub_stripe_signal_test');
paymentState = await loadState({ statePath });
const reconciledSubscription = paymentState.subscriptions.find((subscription) => subscription.id === 'sub_demo');
assert.equal(reconciledSubscription?.provider, 'stripe');
assert.equal(reconciledSubscription?.providerCustomerId, 'cus_signal_test');
assert.equal(reconciledSubscription?.providerSubscriptionId, 'sub_stripe_signal_test');

const livePortal = await createBillingPortalSession('tenant_demo', {
  actorUserId: 'usr_admin',
  env: stripeEnv,
  fetchImpl: stripeFetch,
  idempotencyKey: 'signal-verifier-portal',
  livePaymentProvider: true,
  statePath,
});
assert.equal(livePortal.action, 'payments.portal');
assert.equal(livePortal.details.provider, 'stripe');
assert.equal(livePortal.details.mode, 'live');
assert.equal(livePortal.details.providerSessionId, 'bps_signal_portal');
assert.match(livePortal.details.url, /^https:\/\/billing\.stripe\.com\//);
assert.equal(new URLSearchParams(stripeApiCalls[1].body).get('customer'), 'cus_signal_test');
assert.equal(new URLSearchParams(stripeApiCalls[1].body).get('return_url'), 'http://127.0.0.1:5173/#admin?billing=portal_return');

const failedPayment = await handlePaymentWebhook('invoice.payment_failed', { subscriptionId: 'sub_demo' }, { actorUserId: 'usr_admin', statePath });
assert.equal(failedPayment.action, 'payments.webhook');
assert.equal(failedPayment.details.status, 'past_due');

paymentState = await loadState({ statePath });
assert.equal(paymentState.subscriptions.find((subscription) => subscription.id === 'sub_demo')?.status, 'past_due');
assert.equal(paymentState.entitlements.find((entitlement) => entitlement.tenantId === 'tenant_demo')?.status, 'restricted');
const pastDueInvoice = paymentState.invoices.find((invoice) => invoice.subscriptionId === 'sub_demo' && invoice.status === 'past_due');
assert(pastDueInvoice, 'failed payment should create a past-due invoice');
assert(pastDueInvoice.nextPaymentAttemptAt, 'past-due invoice should have a next payment attempt');
assert(paymentState.lifecycleNotices.some((notice) => notice.trigger === 'payment_failed' && notice.sourceIds?.invoiceId === pastDueInvoice.id && notice.status === 'open'), 'failed payment should produce an open payment lifecycle notice');

await expectStateError('member cannot route signals when entitlement is restricted', 'PAYMENT_REQUIRED', () =>
  setSignalStatus('sig_product_001', 'routed', { actorUserId: 'usr_product', statePath }),
);

await expectStateError('member cannot update account action when entitlement is restricted', 'PAYMENT_REQUIRED', () =>
  setAccountActionStatus('act_ventureworks_export_discovery', 'open', { actorUserId: 'usr_product', statePath }),
);

const recoverySession = await createInvoiceRecoverySession(pastDueInvoice.id, { actorUserId: 'usr_product', statePath });
assert.equal(recoverySession.action, 'payments.recover');
assert.match(recoverySession.details.url, /^signal:\/\/billing\/recover\//);
paymentState = await loadState({ statePath });
assert(paymentState.lifecycleNotices.some((notice) => notice.trigger === 'payment_recovery_ready' && notice.sourceIds?.billingSessionId === recoverySession.details.sessionId), 'payment recovery session should produce lifecycle notice evidence');

const paidPayment = await handlePaymentWebhook('invoice.paid', { subscriptionId: 'sub_demo' }, { actorUserId: 'usr_admin', statePath });
assert.equal(paidPayment.details.status, 'active');

paymentState = await loadState({ statePath });
assert(paymentState.invoices.some((invoice) => invoice.subscriptionId === 'sub_demo' && invoice.status === 'paid'), 'paid webhook should mark invoice paid');

const canceled = await cancelSubscription('sub_demo', { actorUserId: 'usr_admin', statePath });
assert.equal(canceled.action, 'payments.cancel');
assert.equal(canceled.details.status, 'canceled');
paymentState = await loadState({ statePath });
assert(paymentState.lifecycleNotices.some((notice) => notice.trigger === 'subscription_canceled' && notice.status === 'open'), 'subscription cancel should produce an open cancellation lifecycle notice');

const restoredPayment = await handlePaymentWebhook('invoice.paid', { subscriptionId: 'sub_demo' }, { actorUserId: 'usr_admin', statePath });
assert.equal(restoredPayment.details.status, 'active');

const stripeFailedPayload = JSON.stringify({
  id: 'evt_stripe_invoice_failed_local',
  type: 'invoice.payment_failed',
  livemode: false,
  data: {
    object: {
      id: 'in_stripe_failed_local',
      object: 'invoice',
      customer: 'cus_signal_test',
      subscription: 'sub_stripe_signal_test',
      hosted_invoice_url: 'https://invoice.stripe.com/i/in_stripe_failed_local',
      amount_due: 4900,
      next_payment_attempt: 1780699800,
      lines: {
        data: [
          {
            price: {
              id: 'price_signal_team_test',
            },
          },
        ],
      },
    },
  },
});
const invalidStripeHeader = signStripeWebhookPayload(stripeFailedPayload, 'whsec_wrong_local_test');
await expectStateError('invalid Stripe webhook signature is rejected', 'PAYMENT_WEBHOOK_SIGNATURE_INVALID', () =>
  handleSignedStripePaymentWebhook(stripeFailedPayload, invalidStripeHeader, { actorUserId: 'usr_admin', endpointSecret: stripeWebhookSecret, statePath }),
);

const stripeFailedHeader = signStripeWebhookPayload(stripeFailedPayload, stripeWebhookSecret);
const signedFailedPayment = await handleSignedStripePaymentWebhook(stripeFailedPayload, stripeFailedHeader, { actorUserId: 'usr_admin', endpointSecret: stripeWebhookSecret, statePath });
assert.equal(signedFailedPayment.action, 'payments.webhook');
assert.equal(signedFailedPayment.details.provider, 'stripe');
assert.equal(signedFailedPayment.details.providerEventId, 'evt_stripe_invoice_failed_local');
assert.equal(signedFailedPayment.details.providerInvoiceId, 'in_stripe_failed_local');
assert.equal(signedFailedPayment.details.providerSubscriptionId, 'sub_stripe_signal_test');
assert.equal(signedFailedPayment.details.signatureStatus, 'verified');
assert.equal(signedFailedPayment.details.status, 'past_due');

const duplicateSignedPayment = await handleSignedStripePaymentWebhook(stripeFailedPayload, stripeFailedHeader, { actorUserId: 'usr_admin', endpointSecret: stripeWebhookSecret, statePath });
assert.equal(duplicateSignedPayment.details.duplicate, true);
assert.equal(duplicateSignedPayment.details.status, 'duplicate');

paymentState = await loadState({ statePath });
const verifiedStripeFailedEvent = paymentState.paymentEvents.find((event) => event.providerEventId === 'evt_stripe_invoice_failed_local');
assert(verifiedStripeFailedEvent, 'signed Stripe event should be recorded');
assert.equal(verifiedStripeFailedEvent.provider, 'stripe');
assert.equal(verifiedStripeFailedEvent.status, 'verified');
assert.equal(verifiedStripeFailedEvent.signatureStatus, 'verified');
assert.equal(verifiedStripeFailedEvent.appliedType, 'invoice.payment_failed');
assert.equal(verifiedStripeFailedEvent.providerSubscriptionId, 'sub_stripe_signal_test');
assert.equal(verifiedStripeFailedEvent.providerInvoiceId, 'in_stripe_failed_local');
const verifiedStripeFailedInvoice = paymentState.invoices.find((invoice) => invoice.providerInvoiceId === 'in_stripe_failed_local');
assert(verifiedStripeFailedInvoice, 'signed Stripe invoice event should store provider invoice id');
assert.equal(verifiedStripeFailedInvoice.providerSubscriptionId, 'sub_stripe_signal_test');
assert.equal(verifiedStripeFailedInvoice.providerCustomerId, 'cus_signal_test');
assert.equal(verifiedStripeFailedInvoice.hostedInvoiceUrl, 'https://invoice.stripe.com/i/in_stripe_failed_local');

const stripePaidPayload = JSON.stringify({
  id: 'evt_stripe_invoice_paid_local',
  type: 'invoice.paid',
  livemode: false,
  data: {
    object: {
      object: 'invoice',
      subscription: 'sub_demo',
      metadata: {
        subscriptionId: 'sub_demo',
      },
    },
  },
});
const stripePaidHeader = signStripeWebhookPayload(stripePaidPayload, stripeWebhookSecret);
const signedPaidPayment = await handleSignedStripePaymentWebhook(stripePaidPayload, stripePaidHeader, { actorUserId: 'usr_admin', endpointSecret: stripeWebhookSecret, statePath });
assert.equal(signedPaidPayment.details.provider, 'stripe');
assert.equal(signedPaidPayment.details.signatureStatus, 'verified');
assert.equal(signedPaidPayment.details.status, 'active');

const stripeSubscriptionPausedPayload = JSON.stringify({
  id: 'evt_stripe_subscription_paused_local',
  type: 'customer.subscription.paused',
  livemode: false,
  data: {
    object: {
      id: 'sub_stripe_signal_test',
      object: 'subscription',
      customer: 'cus_signal_test',
      status: 'paused',
      current_period_end: 1780786200,
      metadata: {
        planId: 'plan_team',
        tenantId: 'tenant_demo',
      },
    },
  },
});
const stripeSubscriptionPausedHeader = signStripeWebhookPayload(stripeSubscriptionPausedPayload, stripeWebhookSecret);
const signedPausedPayment = await handleSignedStripePaymentWebhook(stripeSubscriptionPausedPayload, stripeSubscriptionPausedHeader, { actorUserId: 'usr_admin', endpointSecret: stripeWebhookSecret, statePath });
assert.equal(signedPausedPayment.details.provider, 'stripe');
assert.equal(signedPausedPayment.details.status, 'past_due');
paymentState = await loadState({ statePath });
assert.equal(paymentState.subscriptions.find((subscription) => subscription.providerSubscriptionId === 'sub_stripe_signal_test')?.providerStatus, 'paused');
assert.equal(paymentState.subscriptions.find((subscription) => subscription.providerSubscriptionId === 'sub_stripe_signal_test')?.status, 'past_due');
assert.equal(paymentState.entitlements.find((entitlement) => entitlement.tenantId === 'tenant_demo')?.status, 'active');
assert(paymentState.paymentEvents.some((event) => event.providerEventType === 'customer.subscription.paused' && event.providerStatus === 'paused'), 'Stripe subscription lifecycle events should retain raw provider status');

const stripeActionRequiredPayload = JSON.stringify({
  id: 'evt_stripe_invoice_action_required_local',
  type: 'invoice.payment_action_required',
  livemode: false,
  data: {
    object: {
      id: 'in_stripe_action_required_local',
      object: 'invoice',
      amount_due: 4900,
      customer: 'cus_signal_test',
      hosted_invoice_url: 'https://invoice.stripe.com/i/in_stripe_action_required_local',
      subscription: 'sub_stripe_signal_test',
    },
  },
});
const stripeActionRequiredHeader = signStripeWebhookPayload(stripeActionRequiredPayload, stripeWebhookSecret);
const signedActionRequiredPayment = await handleSignedStripePaymentWebhook(stripeActionRequiredPayload, stripeActionRequiredHeader, { actorUserId: 'usr_admin', endpointSecret: stripeWebhookSecret, statePath });
assert.equal(signedActionRequiredPayment.details.provider, 'stripe');
assert.equal(signedActionRequiredPayment.details.status, 'past_due');
paymentState = await loadState({ statePath });
assert(paymentState.paymentEvents.some((event) => event.providerEventType === 'invoice.payment_action_required' && event.appliedType === 'invoice.payment_failed'), 'Stripe payment action required should be recorded as a failed-payment lifecycle event');

const stripeSubscriptionResumedPayload = JSON.stringify({
  id: 'evt_stripe_subscription_resumed_local',
  type: 'customer.subscription.resumed',
  livemode: false,
  data: {
    object: {
      id: 'sub_stripe_signal_test',
      object: 'subscription',
      customer: 'cus_signal_test',
      status: 'active',
      current_period_end: 1780872600,
      metadata: {
        planId: 'plan_team',
        tenantId: 'tenant_demo',
      },
    },
  },
});
const stripeSubscriptionResumedHeader = signStripeWebhookPayload(stripeSubscriptionResumedPayload, stripeWebhookSecret);
const signedResumedPayment = await handleSignedStripePaymentWebhook(stripeSubscriptionResumedPayload, stripeSubscriptionResumedHeader, { actorUserId: 'usr_admin', endpointSecret: stripeWebhookSecret, statePath });
assert.equal(signedResumedPayment.details.status, 'active');

const stripeReplayCreatedPayload = JSON.stringify({
  id: 'evt_stripe_subscription_created_replay_local',
  type: 'customer.subscription.created',
  livemode: false,
  data: {
    object: {
      id: 'sub_stripe_replay_only',
      object: 'subscription',
      customer: 'cus_replay_signal',
      status: 'active',
      current_period_end: 1780959000,
      metadata: {
        planId: 'plan_team',
        tenantId: 'tenant_demo',
      },
    },
  },
});
const stripeReplayCreatedHeader = signStripeWebhookPayload(stripeReplayCreatedPayload, stripeWebhookSecret);
const signedReplayCreatedPayment = await handleSignedStripePaymentWebhook(stripeReplayCreatedPayload, stripeReplayCreatedHeader, { actorUserId: 'usr_admin', endpointSecret: stripeWebhookSecret, statePath });
assert.equal(signedReplayCreatedPayment.details.providerSubscriptionId, 'sub_stripe_replay_only');
paymentState = await loadState({ statePath });
assert(paymentState.subscriptions.some((subscription) => subscription.providerSubscriptionId === 'sub_stripe_replay_only' && subscription.providerCustomerId === 'cus_replay_signal'), 'Stripe subscription.created replay should upsert a provider subscription from metadata');

const stripeSubscriptionDeletedPayload = JSON.stringify({
  id: 'evt_stripe_subscription_deleted_replay_local',
  type: 'customer.subscription.deleted',
  livemode: false,
  data: {
    object: {
      id: 'sub_stripe_replay_only',
      object: 'subscription',
      customer: 'cus_replay_signal',
      status: 'canceled',
      metadata: {
        planId: 'plan_team',
        tenantId: 'tenant_demo',
      },
    },
  },
});
const stripeSubscriptionDeletedHeader = signStripeWebhookPayload(stripeSubscriptionDeletedPayload, stripeWebhookSecret);
const signedDeletedPayment = await handleSignedStripePaymentWebhook(stripeSubscriptionDeletedPayload, stripeSubscriptionDeletedHeader, { actorUserId: 'usr_admin', endpointSecret: stripeWebhookSecret, statePath });
assert.equal(signedDeletedPayment.details.status, 'canceled');
paymentState = await loadState({ statePath });
assert(paymentState.paymentEvents.some((event) => event.providerEventType === 'customer.subscription.deleted' && event.appliedType === 'subscription.canceled'), 'Stripe subscription.deleted should be recorded as a cancellation lifecycle event');
assert.equal(paymentState.subscriptions.find((subscription) => subscription.providerSubscriptionId === 'sub_stripe_replay_only')?.status, 'canceled');

const stripeSubscriptionUpdatedActivePayload = JSON.stringify({
  id: 'evt_stripe_subscription_updated_active_local',
  type: 'customer.subscription.updated',
  livemode: false,
  data: {
    object: {
      id: 'sub_stripe_signal_test',
      object: 'subscription',
      customer: 'cus_signal_test',
      status: 'active',
      current_period_end: 1781045400,
      metadata: {
        planId: 'plan_team',
        tenantId: 'tenant_demo',
      },
    },
  },
});
const stripeSubscriptionUpdatedActiveHeader = signStripeWebhookPayload(stripeSubscriptionUpdatedActivePayload, stripeWebhookSecret);
const signedUpdatedActivePayment = await handleSignedStripePaymentWebhook(stripeSubscriptionUpdatedActivePayload, stripeSubscriptionUpdatedActiveHeader, { actorUserId: 'usr_admin', endpointSecret: stripeWebhookSecret, statePath });
assert.equal(signedUpdatedActivePayment.details.status, 'active');
paymentState = await loadState({ statePath });
assert.equal(paymentState.entitlements.find((entitlement) => entitlement.tenantId === 'tenant_demo')?.status, 'active');

const stripeUnknownPayload = JSON.stringify({
  id: 'evt_stripe_unknown_ignored_local',
  type: 'payment_intent.processing',
  livemode: false,
  data: {
    object: {
      id: 'pi_unknown_ignored_local',
      object: 'payment_intent',
      customer: 'cus_signal_test',
      metadata: {
        tenantId: 'tenant_demo',
      },
      status: 'processing',
    },
  },
});
const stripeUnknownHeader = signStripeWebhookPayload(stripeUnknownPayload, stripeWebhookSecret);
const signedUnknownPayment = await handleSignedStripePaymentWebhook(stripeUnknownPayload, stripeUnknownHeader, { actorUserId: 'usr_admin', endpointSecret: stripeWebhookSecret, statePath });
assert.equal(signedUnknownPayment.details.status, 'ignored');
assert.equal(signedUnknownPayment.details.jobId, null);
paymentState = await loadState({ statePath });
assert(paymentState.paymentEvents.some((event) => event.providerEventId === 'evt_stripe_unknown_ignored_local' && event.status === 'ignored' && event.appliedType === 'provider.event.ignored'), 'unknown signed Stripe events should be recorded as ignored');

const stripeTrialWillEndPayload = JSON.stringify({
  id: 'evt_stripe_trial_will_end_local',
  type: 'customer.subscription.trial_will_end',
  livemode: false,
  data: {
    object: {
      id: 'sub_stripe_signal_test',
      object: 'subscription',
      customer: 'cus_signal_test',
      status: 'trialing',
      trial_end: 1781131800,
      metadata: {
        planId: 'plan_team',
        tenantId: 'tenant_demo',
      },
    },
  },
});
const stripeTrialWillEndHeader = signStripeWebhookPayload(stripeTrialWillEndPayload, stripeWebhookSecret);
const signedTrialWillEnd = await handleSignedStripePaymentWebhook(stripeTrialWillEndPayload, stripeTrialWillEndHeader, { actorUserId: 'usr_admin', endpointSecret: stripeWebhookSecret, statePath });
assert.equal(signedTrialWillEnd.details.status, 'active');

await handlePaymentWebhook('subscription.updated', {
  planId: 'plan_team',
  provider: 'stripe',
  providerPriceId: 'price_signal_team_test',
  providerSubscriptionId: 'sub_stripe_signal_test',
  status: 'active',
  subscriptionId: 'sub_stripe_signal_test',
  tenantId: 'tenant_demo',
}, { actorUserId: 'usr_admin', statePath });

const stripePlanChangePayload = JSON.stringify({
  id: 'evt_stripe_subscription_plan_changed_local',
  type: 'customer.subscription.updated',
  livemode: false,
  data: {
    object: {
      id: 'sub_stripe_signal_test',
      object: 'subscription',
      customer: 'cus_signal_test',
      status: 'active',
      current_period_end: 1781218200,
      items: {
        data: [
          {
            price: {
              id: 'price_signal_team_test_v2',
            },
          },
        ],
      },
      metadata: {
        planId: 'plan_team',
        tenantId: 'tenant_demo',
      },
    },
  },
});
const stripePlanChangeHeader = signStripeWebhookPayload(stripePlanChangePayload, stripeWebhookSecret);
const signedPlanChange = await handleSignedStripePaymentWebhook(stripePlanChangePayload, stripePlanChangeHeader, { actorUserId: 'usr_admin', endpointSecret: stripeWebhookSecret, statePath });
assert.equal(signedPlanChange.details.status, 'active');
paymentState = await loadState({ statePath });
assert(paymentState.subscriptions.some((subscription) => subscription.providerSubscriptionId === 'sub_stripe_signal_test' && subscription.providerPriceId === 'price_signal_team_test_v2'), 'plan-changing provider subscription should store the latest provider price');
assert(paymentState.paymentEvents.some((event) => event.providerEventId === 'evt_stripe_subscription_plan_changed_local' && event.providerPreviousPriceId), 'plan-changing subscription update should record previous provider price');

for (const [matrixSubscriptionId, invoiceEventType, expectedStatus] of [
  ['sub_invoice_draft_matrix', 'invoice.created', 'draft'],
  ['sub_invoice_open_matrix', 'invoice.finalized', 'open'],
  ['sub_invoice_uncollectible_matrix', 'invoice.marked_uncollectible', 'uncollectible'],
  ['sub_invoice_void_matrix', 'invoice.voided', 'void'],
]) {
  await handlePaymentWebhook('subscription.updated', {
    planId: 'plan_team',
    status: 'active',
    subscriptionId: matrixSubscriptionId,
    tenantId: 'tenant_demo',
  }, { actorUserId: 'usr_admin', statePath });
  const invoicePayload = JSON.stringify({
    id: `evt_stripe_${expectedStatus}_invoice_local`,
    type: invoiceEventType,
    livemode: false,
    data: {
      object: {
        id: `in_${expectedStatus}_matrix`,
        object: 'invoice',
        amount_due: 4900,
        customer: 'cus_signal_test',
        hosted_invoice_url: `https://invoice.stripe.com/i/in_${expectedStatus}_matrix`,
        status: expectedStatus === 'void' ? 'void' : expectedStatus,
        subscription: matrixSubscriptionId,
      },
    },
  });
  const invoiceHeader = signStripeWebhookPayload(invoicePayload, stripeWebhookSecret);
  const invoiceResult = await handleSignedStripePaymentWebhook(invoicePayload, invoiceHeader, { actorUserId: 'usr_admin', endpointSecret: stripeWebhookSecret, statePath });
  assert.equal(invoiceResult.details.invoiceId !== null, true);
}

paymentState = await loadState({ statePath });
assert(['draft', 'open', 'paid', 'past_due', 'void', 'uncollectible'].every((status) =>
  paymentState.invoices.some((invoice) => invoice.status === status)), 'payment lifecycle should cover every invoice status');
assert(paymentState.lifecycleNotices.some((notice) => notice.trigger === 'invoice_uncollectible' && notice.status === 'open'), 'uncollectible invoices should surface as open lifecycle notices');

const refundableInvoice = paymentState.invoices.find((invoice) => invoice.providerInvoiceId === 'in_stripe_failed_local') ?? paymentState.invoices.find((invoice) => invoice.status === 'paid');
const recordedRefund = await recordInvoiceRefund(refundableInvoice.id, { amountCents: 1200, reason: 'Verifier refund' }, { actorUserId: 'usr_admin', statePath });
assert.equal(recordedRefund.details.refundedCents >= 1200, true);
paymentState = await loadState({ statePath });
const openInvoiceForCredit = paymentState.invoices.find((invoice) => invoice.status === 'open');
assert(openInvoiceForCredit, 'payment verifier should have an open invoice for support credit proof');
const lifecycleSupportCredit = await createBillingOverride('tenant_demo', 'support_credit', {
  amountCents: 1000,
  reason: 'Verifier credit',
}, { actorUserId: 'usr_admin', statePath });
assert.equal(lifecycleSupportCredit.details.creditedInvoiceId, openInvoiceForCredit.id);

const stripeCreditPayload = JSON.stringify({
  id: 'evt_stripe_credit_note_local',
  type: 'credit_note.created',
  livemode: false,
  data: {
    object: {
      id: 'cn_signal_credit_local',
      object: 'credit_note',
      amount: 500,
      invoice: openInvoiceForCredit.providerInvoiceId ?? openInvoiceForCredit.id,
      customer: 'cus_signal_test',
    },
  },
});
const stripeCreditHeader = signStripeWebhookPayload(stripeCreditPayload, stripeWebhookSecret);
const signedCredit = await handleSignedStripePaymentWebhook(stripeCreditPayload, stripeCreditHeader, { actorUserId: 'usr_admin', endpointSecret: stripeWebhookSecret, statePath });
assert.equal(signedCredit.details.invoiceId, openInvoiceForCredit.id);

const stripeRefundPayload = JSON.stringify({
  id: 'evt_stripe_refund_local',
  type: 'refund.created',
  livemode: false,
  data: {
    object: {
      id: 're_signal_refund_local',
      object: 'refund',
      amount: 600,
      invoice: refundableInvoice.providerInvoiceId ?? refundableInvoice.id,
      customer: 'cus_signal_test',
    },
  },
});
const stripeRefundHeader = signStripeWebhookPayload(stripeRefundPayload, stripeWebhookSecret);
const signedRefund = await handleSignedStripePaymentWebhook(stripeRefundPayload, stripeRefundHeader, { actorUserId: 'usr_admin', endpointSecret: stripeWebhookSecret, statePath });
assert.equal(signedRefund.details.status, 'paid');

const retryState = await loadState({ statePath });
const retryTarget = retryState.jobs.find((job) => job.id === 'job_outlook_reauth_001');
retryTarget.status = 'failed';
retryTarget.attempts = 1;
await saveState(retryState, { statePath });

await expectForbidden('member cannot retry job', () =>
  retryJob('job_outlook_reauth_001', { actorUserId: 'usr_product', statePath }),
);

const retriedJob = await retryJob('job_outlook_reauth_001', { actorUserId: 'usr_admin', statePath });
assert.equal(retriedJob.action, 'jobs.retry');
assert.equal(retriedJob.details.nextStatus, 'queued');

const drainedJobs = await drainJobs('email_sync', { actorUserId: 'usr_admin', statePath });
assert.equal(drainedJobs.action, 'jobs.drain');
assert(drainedJobs.details.count >= 1, 'at least one email sync job should be drained');

const state = await loadState({ statePath });
const report = doctor(state);
assert.equal(report.ok, true);
assert(state.auditEvents.length >= 4, 'audit events should be appended for allowed mutations');
assert(state.auditEvents.every((event) => event.actor && event.actorRole), 'audit events should include actor identity and role');
assert(state.auditEvents.some((event) => event.action === 'session.token'), 'signed session token issuance should be audited');
assert(!JSON.stringify(state).includes('session_secret_for_verifier'), 'local app state should not include session signing secrets');
assert(!JSON.stringify(state).includes(issuedSession.details.token), 'local app state should not include issued bearer session tokens');
assert(state.invites.some((invite) => invite.status === 'accepted'), 'accepted invite history should be recorded');
assert(state.invites.some((invite) => invite.status === 'revoked'), 'revoked invite history should be recorded');
assert(state.users.length >= 4, 'invite acceptance should add a local user');
assert(state.emailSyncCursors.every((cursor) => cursor.mailboxId), 'sync cursors should stay linked to mailboxes');
assert(state.emailSyncCursors.some((cursor) => cursor.cursor.includes('notification-987654') || cursor.cursor.includes('history-') || cursor.providerRequestDigest), 'Gmail watch notification should advance provider cursor state');
assert(state.emailWatchSubscriptions?.some((watch) => watch.provider === 'gmail' && watch.status === 'active' && watch.renewalCount >= 1), 'Gmail watch setup and renewal should be recorded');
assert(state.emailWatchSubscriptions?.some((watch) => watch.provider === 'outlook' && watch.status === 'active' && watch.clientStateDigest), 'Outlook watch should store only clientState digest');
assert(state.emailWatchSubscriptions?.every((watch) => watch.notificationUrl && watch.expirationAt && watch.setupRequestDigest), 'watch subscriptions should keep auditable setup metadata');
assert(state.mailboxConnectionSessions.some((session) => session.status === 'completed'), 'completed local OAuth handoff should be recorded');
assert(state.mailboxConnectionSessions.some((session) => session.oauthStateStatus === 'verified' && session.callbackCodeDigest), 'verified OAuth callbacks should store state and code digests');
assert(state.mailboxConnectionSessions.some((session) => session.credentialStatus === 'stored' && session.credentialVaultRef), 'live OAuth callback should store credential vault references only');
assert(state.mailboxes.some((mailbox) => mailbox.credentialStatus === 'stored' && mailbox.credentialVaultRef), 'mailboxes should expose safe credential status metadata');
assert(!JSON.stringify(state).includes('live-access-token'), 'local app state should not include plaintext provider credentials');
assert(!JSON.stringify(state).includes('live-refresh-token'), 'local app state should not include plaintext refresh credentials');
assert(state.flowRuns.length >= 3, 'email flow runs should be recorded');
assert(state.flowRuns.some((run) => (run.suppressedMessages ?? 0) >= 2), 'flow runs should record suppressed messages');
assert(state.signals.filter((signal) => signal.sourceMessageId && signal.flowId).length >= 3, 'generated signals should keep source references');
assert(state.signalQualitySettings.some((settings) => settings.minimumConfidence === 0.93), 'quality threshold updates should persist');
assert(state.suppressionRules.some((rule) => rule.value === 'blocked.example' && rule.status === 'disabled'), 'suppression rule status updates should persist');
assert(state.signalFeedback.some((feedback) => feedback.label === 'product_gap'), 'signal feedback labels should be recorded');
assert(state.modelGovernancePolicies.some((policy) => policy.tenantId === 'tenant_demo' && policy.learningMode === 'disabled' && policy.trainingDataUse === 'excluded_by_default' && policy.perTenantModel === false), 'model governance policy should persist shared-detector/no-per-tenant-model decision');
assert(doctor(state).checks.find((check) => check.id === 'model_governance_boundary')?.ok, 'final doctor should validate model governance boundary');
assert(state.governancePolicies.some((policy) => policy.sourceRetentionDays === 30 && policy.redactionMode === 'strict'), 'governance policy updates should persist');
assert(state.redactionRules.some((rule) => rule.label === 'Executive names' && rule.status === 'disabled'), 'redaction rule status updates should persist');
assert(state.dataRequests.some((request) => request.type === 'delete' && request.status === 'completed'), 'data request lifecycle should be recorded');
assert(state.incidentNotes.some((note) => note.title === 'Verifier incident' && note.status === 'resolved'), 'incident note lifecycle should be recorded');
assert(state.sourceMessages.every((message) => Array.isArray(message.processedFlowIds)), 'source messages should track processed flows');
assert(state.sourceMessages.some((message) => message.providerMessageId && message.providerRequestDigest && message.providerResponseDigest), 'source messages should keep safe provider sync provenance');
assert(state.emailSyncCursors.some((cursor) => cursor.providerRequestDigest && cursor.providerResponseDigest && (cursor.lastUpsertedSourceMessages ?? 0) >= 1), 'sync cursors should keep provider request/response digests and source-message counts');
assert(state.accountProfiles.length >= 3, 'account relationship profiles should be available');
assert(state.accountEvents.some((event) => event.type === 'next_action'), 'account action status changes should append timeline events');
assert(state.accountActions.some((action) => action.status === 'open'), 'at least one relationship next action should remain open for monitoring');
assert(state.accountRecommendations?.some((recommendation) => recommendation.status === 'open' && recommendation.evidenceSignalIds.length >= 1 && recommendation.strategy), 'account recommendations should include open source-backed strategy guidance');
assert(state.accountRecommendations?.every((recommendation) => recommendation.accountId && recommendation.ownerUserId && recommendation.rationale && Array.isArray(recommendation.evidenceActionIds)), 'account recommendations should retain account, owner, rationale, and action evidence shape');
assert(state.notificationPreferences.every((preference) => preference.userId), 'notification preferences should stay linked to users');
assert(state.notificationPreferences.some((preference) => preference.userId === 'usr_sales' && preference.emailDeliveryStatus === 'unsubscribed'), 'email unsubscribe should persist on preferences');
assert(state.notificationDigestRuns.length >= 1, 'digest runs should be recorded');
assert(state.jobs.some((job) => job.queue === 'notification_digest'), 'notification digest jobs should be recorded');
assert(state.emailDeliveryMessages.length >= 1, 'email delivery messages should be recorded');
assert(state.emailDeliveryMessages.some((message) => ['sent', 'bounced', 'suppressed'].includes(message.status)), 'email delivery status updates should persist');
assert(state.emailDeliveryMessages.some((message) => message.provider === 'sendgrid' && message.providerMode === 'live' && message.providerMessageId === 'sg_msg_signal_digest_001' && message.providerRequestDigest), 'SendGrid outbound email delivery should persist safe provider metadata');
assert(state.emailDeliveryMessages.some((message) => message.providerStatus === 'unsubscribed' && message.status === 'suppressed'), 'email provider webhook unsubscribe status should suppress delivery');
assert(state.auditEvents.some((event) => event.action === 'notifications.delivery-webhook'), 'email delivery webhooks should be audited');
assert(state.emailDeliveryMessages.every((message) => message.unsubscribeCode), 'email delivery messages should carry unsubscribe codes');
assert(state.billingSessions.some((session) => session.provider === 'stripe' && session.providerMode === 'live' && session.providerSessionId === 'cs_test_signal_checkout' && session.providerRequestDigest), 'live Stripe checkout sessions should persist safe provider metadata');
assert(state.billingSessions.some((session) => session.provider === 'stripe' && session.providerMode === 'live' && session.providerSessionId === 'bps_signal_portal' && session.providerRequestDigest), 'live Stripe portal sessions should persist safe provider metadata');
assert(state.lifecycleNotices.some((notice) => notice.category === 'payment' && ['payment_failed', 'payment_recovery_ready', 'subscription_starting_point'].includes(notice.trigger)), 'payment lifecycle notices should stay visible in final state');
assert(state.lifecycleNotices.some((notice) => notice.category === 'source' && notice.sourceIds?.mailboxId), 'source lifecycle notices should stay linked to mailbox state');
assert(doctor(state).checks.find((check) => check.id === 'lifecycle_notices_audited')?.ok, 'final doctor should validate lifecycle notices');
assert(!JSON.stringify(state).includes('sk_test_signal_live_boundary'), 'local app state should not include Stripe secret keys');
assert(!JSON.stringify(state).includes('email_provider_secret_for_verifier'), 'local app state should not include outbound email provider tokens');
assert(!JSON.stringify(state).includes('sendgrid_secret_for_verifier'), 'local app state should not include SendGrid API keys');
assert(state.jobs.some((job) => job.queue === 'outbound_email'), 'outbound email jobs should be recorded');
assert(state.jobs.some((job) => job.queue === 'governance'), 'governance jobs should be recorded');
assert(state.jobs.some((job) => job.type === 'mailbox.watch.setup'), 'provider watch setup jobs should be recorded');
assert(state.jobs.some((job) => job.type === 'gmail.watch.notification'), 'Gmail watch notification jobs should be queued');
assert(state.jobs.some((job) => job.type === 'outlook.watch.notification'), 'Outlook watch notification jobs should be queued');

const exposedInvitePaths = clientExposureSecretPaths(state);
const redactedState = redactClientStateSecrets(state);
assert.equal(clientExposureSecretPaths(redactedState).length, 0, 'client state redaction should remove pending invite claim codes');
if (exposedInvitePaths.length > 0) {
  const exposedInvite = (state.invites ?? []).find((invite) => invite.claimCode && !/^claimed-[a-f0-9]{24}$/i.test(invite.claimCode));
  assert(exposedInvite?.claimCode, 'local CLI state should retain pending invite claim codes for operator workflows');
  assert(!JSON.stringify(redactedState).includes(exposedInvite.claimCode), 'redacted client state should not serialize pending claim codes');
}

await fs.rm(statePath, { force: true });
await fs.rm(vaultPath, { force: true });
}
