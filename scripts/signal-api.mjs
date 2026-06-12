#!/usr/bin/env node

import http from 'node:http';
import {
  SignalStateError,
  applyMutation,
  bootstrapState,
  claimUserInvite,
  completeMailboxConnectionFromOAuthCallback,
  completionAuditReport,
  dashboardAuditReport,
  emailHandoffReport,
  getActor,
  backendHandoffReport,
  backendCutoverDrillReport,
  doctor,
  ensureState,
  handleSignedEmailDeliveryWebhook,
  handleSignedSendGridEmailDeliveryWebhook,
  handleSignedStripePaymentWebhook,
  handleProviderWatchNotification,
  issueSessionToken,
  launchGateReport,
  lifecyclePlaybookReport,
  localAgentHandoffReport,
  loadProductionEnvTemplate,
  loadState,
  onboardingReadinessReport,
  operationsHealthReport,
  paymentHandoffReport,
  paymentLifecycleAuditReport,
  productionOperationsDrillReport,
  productionEnvAuditReport,
  productionSetupPlanReport,
  providerHandoffReport,
  providerLaunchMatrixReport,
  providerReadiness,
  qaAnswersReport,
  providerValidationSchedulesDue,
  productReadinessReport,
  recordProviderSandboxValidation,
  registerTenantWorkspace,
  resolveStatePath,
  schedulerHandoffReport,
  signalDigestionPipelineReport,
  summarizeState,
  switchSession,
  tenantIsolationAuditReport,
  unsubscribeEmailDigest,
} from './signal-state.mjs';
import {
  SessionTokenError,
} from './signal-session-token.mjs';
import {
  assertApiSecurityConfig,
  requestAuth,
  requestSessionToken,
  requireAdminRequestAuth,
  requireRegisteredSessionRequestAuth,
  requireOAuthActor,
  requireWebhookActor,
  resolveOAuthActor,
  resolveWebhookActor,
  sessionCookieHeader,
} from './signal-api-auth.mjs';
import {
  ProviderWatchError,
  verifyGmailPubSubPushAuthorization,
} from './signal-provider-watch.mjs';
import {
  validateProviderSandbox,
} from './signal-provider-sandbox.mjs';
import {
  backendReadiness,
} from './signal-backend-readiness.mjs';
import {
  createRateLimiter,
  requestClientIp,
} from './signal-api-rate-limit.mjs';

assertApiSecurityConfig(process.env);

const host = process.env.SIGNAL_API_HOST ?? '127.0.0.1';
const port = Number(process.env.SIGNAL_API_PORT ?? 8787);
const statePath = resolveStatePath(process.env.SIGNAL_ADMIN_STATE);
const inviteClaimRateLimiter = createRateLimiter({
  maxAttempts: Number(process.env.SIGNAL_INVITE_CLAIM_RATE_LIMIT ?? 5),
  windowMs: Number(process.env.SIGNAL_INVITE_CLAIM_RATE_WINDOW_MS ?? 60 * 60 * 1000),
});
const corsHeaders = 'Authorization, Content-Type, Signal-Email-Signature, Stripe-Signature, X-Signal-Actor, X-Signal-Session, X-Twilio-Email-Event-Webhook-Signature, X-Twilio-Email-Event-Webhook-Timestamp';

function configuredCorsOrigins() {
  return (process.env.SIGNAL_API_CORS_ORIGINS ?? process.env.SIGNAL_API_CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isLoopbackOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

function allowedCorsOrigin(req) {
  const origin = req.headers.origin?.toString();
  const configuredOrigins = configuredCorsOrigins();
  if (!origin) {
    return configuredOrigins.includes('*') ? '*' : null;
  }
  if (configuredOrigins.includes(origin)) {
    return origin;
  }
  if (configuredOrigins.includes('*')) {
    return '*';
  }
  if (configuredOrigins.length === 0 && isLoopbackOrigin(origin)) {
    return origin;
  }
  return null;
}

function applyCorsHeaders(req, res) {
  const origin = allowedCorsOrigin(req);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    if (origin !== '*') {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
  }
  res.setHeader('Access-Control-Allow-Headers', corsHeaders);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Vary', 'Origin');
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
  });
  res.end(text);
}

function notFound(res) {
  sendJson(res, 404, { ok: false, error: 'Not found' });
}

async function readBody(req) {
  const raw = await readRawBody(req);
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new SignalStateError('Invalid JSON body', {
      code: 'INVALID_JSON',
      status: 400,
    });
  }
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function requestStateAuth(req, body = {}) {
  const auth = await requestAuth(req, body);
  if (auth.auth.mode !== 'signed_session') {
    if (auth.auth.mode === 'jwks') {
      const state = await loadState({ statePath });
      requireRegisteredSessionRequestAuth(state, auth);
    }
    return auth;
  }
  const state = await loadState({ statePath });
  requireRegisteredSessionRequestAuth(state, auth);
  return auth;
}

async function authenticatedState(req, body = {}) {
  const auth = await requestAuth(req, body);
  const state = await loadState({ statePath });
  requireRegisteredSessionRequestAuth(state, auth);
  return { auth, state };
}

function errorPayload(error) {
  if (error instanceof SignalStateError || error instanceof SessionTokenError || error instanceof ProviderWatchError) {
    return {
      status: error.status,
      payload: {
        ok: false,
        code: error.code,
        error: error.message,
        details: error.details,
      },
    };
  }

  return {
    status: 500,
    payload: {
      ok: false,
      code: 'API_ERROR',
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

async function route(req, res) {
  const url = new URL(req.url ?? '/', `http://${host}:${port}`);

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const { state, summary } = await ensureState({ statePath });
    sendJson(res, 200, {
      ok: true,
      service: 'signal-local-api',
      statePath,
      summary,
      backend: backendReadiness({ statePath }),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/backend') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'backend.readiness');
    const backend = backendReadiness({ statePath });
    sendJson(res, 200, {
      ok: true,
      backend,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/backend-handoff') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'backend.handoff');
    const backend = backendReadiness({ statePath });
    const provider = providerReadiness();
    const readiness = productReadinessReport(state, { backend, provider });
    const operations = operationsHealthReport(state, { backend, statePath });
    const productionDrill = productionOperationsDrillReport(state, {
      backend,
      operations,
      provider,
      readiness,
    });
    const handoff = backendHandoffReport(state, {
      backend,
      operations,
      productionDrill,
      provider,
      readiness,
      statePath,
    });
    sendJson(res, 200, {
      ok: handoff.ok,
      handoff,
      backend,
      operations,
      productionDrill,
      readiness,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/backend-cutover') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'backend.cutover');
    const backend = backendReadiness({ statePath });
    const provider = providerReadiness();
    const readiness = productReadinessReport(state, { backend, provider });
    const operations = operationsHealthReport(state, { backend, statePath });
    const productionDrill = productionOperationsDrillReport(state, {
      backend,
      operations,
      provider,
      readiness,
    });
    const cutover = backendCutoverDrillReport(state, {
      backend,
      productionDrill,
      statePath,
    });
    sendJson(res, 200, {
      ok: cutover.ok,
      cutover,
      backend,
      productionDrill,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/scheduler-handoff') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'scheduler.handoff');
    const backend = backendReadiness({ statePath });
    const provider = providerReadiness();
    const readiness = productReadinessReport(state, { backend, provider });
    const launchGate = launchGateReport(state, { backend, provider, readiness });
    const operations = operationsHealthReport(state, { backend, statePath });
    const productionDrill = productionOperationsDrillReport(state, {
      backend,
      launchGate,
      operations,
      provider,
      readiness,
    });
    const handoff = schedulerHandoffReport(state, {
      backend,
      launchGate,
      operations,
      productionDrill,
      provider,
      readiness,
      statePath,
    });
    sendJson(res, 200, {
      ok: handoff.ok,
      handoff,
      backend,
      launchGate,
      operations,
      productionDrill,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/readiness') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'product.readiness');
    const backend = backendReadiness({ statePath });
    const provider = providerReadiness();
    const readiness = productReadinessReport(state, { backend, provider });
    sendJson(res, 200, {
      ok: readiness.ok,
      readiness,
      backend,
      provider,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/completion-audit') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'completion.audit');
    const backend = backendReadiness({ statePath });
    const provider = providerReadiness();
    const readiness = productReadinessReport(state, { backend, provider });
    const dashboardAudit = dashboardAuditReport(state, { backend, statePath });
    const digestionPipeline = signalDigestionPipelineReport(state, { backend, statePath });
    const onboarding = onboardingReadinessReport(state, { backend, statePath });
    const tenantIsolation = tenantIsolationAuditReport(state, { backend, statePath });
    const operations = operationsHealthReport(state, { backend, statePath });
    const lifecyclePlaybook = lifecyclePlaybookReport(state, { backend, statePath });
    const providerLaunch = providerLaunchMatrixReport(state, { backend, provider });
    const launchGate = launchGateReport(state, { backend, provider, readiness });
    const paymentLifecycle = paymentLifecycleAuditReport(state, { backend, provider, providerLaunch, statePath });
    const emailHandoff = emailHandoffReport(state, {
      backend,
      launchGate,
      lifecyclePlaybook,
      operations,
      provider,
      providerLaunch,
      readiness,
      statePath,
    });
    const paymentHandoff = paymentHandoffReport(state, {
      backend,
      launchGate,
      paymentLifecycle,
      provider,
      providerLaunch,
      readiness,
      statePath,
    });
    const qaAnswers = qaAnswersReport(state, {
      backend,
      dashboardAudit,
      digestionPipeline,
      lifecyclePlaybook,
      onboarding,
      operations,
      provider,
      providerLaunch,
      readiness,
      statePath,
    });
    const productionPlan = productionSetupPlanReport(state, {
      backend,
      launchGate,
      operations,
      provider,
      providerLaunch,
      readiness,
      statePath,
    });
    const agentHandoff = localAgentHandoffReport(state, {
      backend,
      launchGate,
      operations,
      productionPlan,
      provider,
      providerLaunch,
      readiness,
      statePath,
    });
    const completion = completionAuditReport(state, {
      agentHandoff,
      backend,
      dashboardAudit,
      digestionPipeline,
      emailHandoff,
      launchGate,
      lifecyclePlaybook,
      onboarding,
      operations,
      paymentHandoff,
      paymentLifecycle,
      productionPlan,
      provider,
      providerLaunch,
      qaAnswers,
      readiness,
      statePath,
      tenantIsolation,
    });
    sendJson(res, 200, {
      ok: completion.ok,
      completion,
      backend,
      provider,
      readiness,
      launchGate,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-handoff') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'agent.handoff');
    const backend = backendReadiness({ statePath });
    const provider = providerReadiness();
    const readiness = productReadinessReport(state, { backend, provider });
    const launchGate = launchGateReport(state, { backend, provider, readiness });
    const operations = operationsHealthReport(state, { backend, statePath });
    const providerLaunch = providerLaunchMatrixReport(state, { backend, provider });
    const productionPlan = productionSetupPlanReport(state, {
      backend,
      launchGate,
      operations,
      provider,
      providerLaunch,
      readiness,
      statePath,
    });
    const handoff = localAgentHandoffReport(state, {
      backend,
      launchGate,
      operations,
      productionPlan,
      provider,
      providerLaunch,
      readiness,
      statePath,
    });
    sendJson(res, 200, {
      ok: handoff.ok,
      handoff,
      backend,
      provider,
      readiness,
      launchGate,
      operations,
      providerLaunch,
      productionPlan,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard-audit') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'dashboard.audit');
    const backend = backendReadiness({ statePath });
    const audit = dashboardAuditReport(state, { backend, statePath });
    sendJson(res, 200, {
      ok: audit.ok,
      audit,
      backend,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/digestion-pipeline') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'digestion.pipeline');
    const backend = backendReadiness({ statePath });
    const pipeline = signalDigestionPipelineReport(state, { backend, statePath });
    sendJson(res, 200, {
      ok: pipeline.ok,
      pipeline,
      backend,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/onboarding-readiness') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'onboarding.readiness');
    const backend = backendReadiness({ statePath });
    const onboarding = onboardingReadinessReport(state, { backend, statePath });
    sendJson(res, 200, {
      ok: onboarding.ok,
      onboarding,
      backend,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/tenant-isolation') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'tenant.isolation');
    const backend = backendReadiness({ statePath });
    const isolation = tenantIsolationAuditReport(state, { backend, statePath });
    sendJson(res, 200, {
      ok: isolation.ok,
      isolation,
      backend,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/operations-health') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'operations.health');
    const backend = backendReadiness({ statePath });
    const operations = operationsHealthReport(state, { backend, statePath });
    sendJson(res, 200, {
      ok: operations.ok,
      operations,
      backend,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/production-drill') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'production.drill');
    const backend = backendReadiness({ statePath });
    const provider = providerReadiness();
    const readiness = productReadinessReport(state, { backend, provider });
    const launchGate = launchGateReport(state, { backend, provider, readiness });
    const operations = operationsHealthReport(state, { backend, statePath });
    const drill = productionOperationsDrillReport(state, { backend, launchGate, operations, provider, readiness });
    sendJson(res, 200, {
      ok: drill.ok,
      drill,
      backend,
      provider,
      readiness,
      launchGate,
      operations,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/provider-launch') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'provider.launch');
    const backend = backendReadiness({ statePath });
    const provider = providerReadiness();
    const launch = providerLaunchMatrixReport(state, { backend, provider });
    sendJson(res, 200, {
      ok: launch.ok,
      launch,
      backend,
      provider,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/production-plan') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'production.plan');
    const backend = backendReadiness({ statePath });
    const provider = providerReadiness();
    const readiness = productReadinessReport(state, { backend, provider });
    const launchGate = launchGateReport(state, { backend, provider, readiness });
    const operations = operationsHealthReport(state, { backend, statePath });
    const drill = productionOperationsDrillReport(state, { backend, launchGate, operations, provider, readiness });
    const providerLaunch = providerLaunchMatrixReport(state, { backend, provider });
    const plan = productionSetupPlanReport(state, {
      backend,
      launchGate,
      productionDrill: drill,
      provider,
      providerLaunch,
      readiness,
      statePath,
    });
    sendJson(res, 200, {
      ok: plan.ok,
      plan,
      backend,
      provider,
      readiness,
      launchGate,
      operations,
      productionDrill: drill,
      providerLaunch,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/production-env') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'production.env');
    const backend = backendReadiness({ statePath });
    const provider = providerReadiness();
    const readiness = productReadinessReport(state, { backend, provider });
    const launchGate = launchGateReport(state, { backend, provider, readiness });
    const operations = operationsHealthReport(state, { backend, statePath });
    const drill = productionOperationsDrillReport(state, { backend, launchGate, operations, provider, readiness });
    const providerLaunch = providerLaunchMatrixReport(state, { backend, provider });
    const plan = productionSetupPlanReport(state, {
      backend,
      launchGate,
      productionDrill: drill,
      provider,
      providerLaunch,
      readiness,
      statePath,
    });
    const template = await loadProductionEnvTemplate();
    const envAudit = productionEnvAuditReport({
      backend,
      env: process.env,
      envSource: {
        configuredKeys: 0,
        keys: [],
        path: null,
        type: 'process',
      },
      productionPlan: plan,
      provider,
      template,
    });
    sendJson(res, 200, {
      ok: envAudit.ok,
      env: envAudit,
      backend,
      provider,
      productionPlan: plan,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/lifecycle-playbook') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'lifecycle.playbook');
    const backend = backendReadiness({ statePath });
    const playbook = lifecyclePlaybookReport(state, { backend, statePath });
    sendJson(res, 200, {
      ok: playbook.ok,
      playbook,
      backend,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/provider-handoff') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'provider.handoff');
    const backend = backendReadiness({ statePath });
    const provider = providerReadiness();
    const providerLaunch = providerLaunchMatrixReport(state, { backend, provider });
    const handoff = providerHandoffReport(state, {
      backend,
      launch: providerLaunch,
      provider,
      statePath,
    });
    sendJson(res, 200, {
      ok: handoff.ok,
      handoff,
      backend,
      provider,
      providerLaunch,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/email-handoff') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'email.handoff');
    const backend = backendReadiness({ statePath });
    const provider = providerReadiness();
    const readiness = productReadinessReport(state, { backend, provider });
    const providerLaunch = providerLaunchMatrixReport(state, { backend, provider });
    const launchGate = launchGateReport(state, { backend, provider, readiness });
    const operations = operationsHealthReport(state, { backend, statePath });
    const lifecyclePlaybook = lifecyclePlaybookReport(state, { backend, statePath });
    const handoff = emailHandoffReport(state, {
      backend,
      launchGate,
      lifecyclePlaybook,
      operations,
      provider,
      providerLaunch,
      readiness,
      statePath,
    });
    sendJson(res, 200, {
      ok: handoff.ok,
      handoff,
      backend,
      provider,
      providerLaunch,
      operations,
      lifecyclePlaybook,
      launchGate,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/payment-lifecycle') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'payment.lifecycle');
    const backend = backendReadiness({ statePath });
    const provider = providerReadiness();
    const providerLaunch = providerLaunchMatrixReport(state, { backend, provider });
    const payment = paymentLifecycleAuditReport(state, { backend, provider, providerLaunch, statePath });
    sendJson(res, 200, {
      ok: payment.ok,
      payment,
      backend,
      provider,
      providerLaunch,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/payment-handoff') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'payment.handoff');
    const backend = backendReadiness({ statePath });
    const provider = providerReadiness();
    const readiness = productReadinessReport(state, { backend, provider });
    const providerLaunch = providerLaunchMatrixReport(state, { backend, provider });
    const launchGate = launchGateReport(state, { backend, provider, readiness });
    const payment = paymentLifecycleAuditReport(state, { backend, provider, providerLaunch, statePath });
    const handoff = paymentHandoffReport(state, {
      backend,
      launchGate,
      paymentLifecycle: payment,
      provider,
      providerLaunch,
      readiness,
      statePath,
    });
    sendJson(res, 200, {
      ok: handoff.ok,
      handoff,
      backend,
      provider,
      providerLaunch,
      payment,
      launchGate,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/qa-answers') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'qa.answers');
    const backend = backendReadiness({ statePath });
    const provider = providerReadiness();
    const readiness = productReadinessReport(state, { backend, provider });
    const dashboardAudit = dashboardAuditReport(state, { backend, statePath });
    const digestionPipeline = signalDigestionPipelineReport(state, { backend, statePath });
    const onboarding = onboardingReadinessReport(state, { backend, statePath });
    const operations = operationsHealthReport(state, { backend, statePath });
    const lifecyclePlaybook = lifecyclePlaybookReport(state, { backend, statePath });
    const providerLaunch = providerLaunchMatrixReport(state, { backend, provider });
    const qa = qaAnswersReport(state, {
      backend,
      dashboardAudit,
      digestionPipeline,
      lifecyclePlaybook,
      onboarding,
      operations,
      provider,
      providerLaunch,
      readiness,
      statePath,
    });
    sendJson(res, 200, {
      ok: qa.ok,
      qa,
      backend,
      provider,
      readiness,
      dashboardAudit,
      digestionPipeline,
      onboarding,
      operations,
      lifecyclePlaybook,
      providerLaunch,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/launch-gate') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'launch.gate');
    const backend = backendReadiness({ statePath });
    const provider = providerReadiness();
    const readiness = productReadinessReport(state, { backend, provider });
    const launchGate = launchGateReport(state, { backend, provider, readiness });
    sendJson(res, 200, {
      ok: launchGate.goLiveReady,
      launchGate,
      readiness,
      backend,
      provider,
      summary: summarizeState(state, statePath),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    const { auth: requestActor, state } = await authenticatedState(req);
    const actor = getActor(state, requestActor.actorUserId ?? state.session?.activeUserId, { allowMissing: true });
    sendJson(res, 200, {
      ok: true,
      actor: actor
        ? {
            email: actor.email,
            id: actor.id,
            name: actor.name,
            role: actor.role,
            status: actor.status,
            team: actor.team ?? null,
          }
        : null,
      availableUsers: state.users.map((user) => ({
        email: user.email,
        id: user.id,
        name: user.name,
        role: user.role,
        status: user.status,
        team: user.team ?? null,
      })),
      auth: requestActor.auth,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/session') {
    const body = await readBody(req);
    const auth = await requestStateAuth(req, body);
    const result = await switchSession(body.userId, { actorUserId: auth.actorUserId, statePath });
    sendJson(res, 200, {
      ok: true,
      action: result.action,
      actor: {
        email: result.actor.email,
        id: result.actor.id,
        name: result.actor.name,
        role: result.actor.role,
        status: result.actor.status,
        team: result.actor.team ?? null,
      },
      details: result.details,
      state: result.state,
      summary: result.summary,
      auth: auth.auth,
      doctor: doctor(result.state),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/session/token') {
    const body = await readBody(req);
    const auth = await requestStateAuth(req, body);
    const result = await issueSessionToken(body.userId, {
      actorUserId: auth.actorUserId,
      statePath,
      ttlSeconds: body.ttlSeconds,
    });
    sendJson(res, 200, {
      ok: true,
      action: result.action,
      actor: {
        email: result.actor.email,
        id: result.actor.id,
        name: result.actor.name,
        role: result.actor.role,
      },
      auth: auth.auth,
      details: result.details,
      summary: result.summary,
      doctor: doctor(result.state),
    }, {
      'Set-Cookie': sessionCookieHeader(result.details.token, {
        expiresAt: result.details.expiresAt,
        issuedAt: result.details.issuedAt,
      }),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const { state } = await authenticatedState(req);
    sendJson(res, 200, {
      ok: true,
      state,
      summary: summarizeState(state, statePath),
      backend: backendReadiness({ statePath }),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/summary') {
    const { state } = await authenticatedState(req);
    sendJson(res, 200, {
      ok: true,
      summary: summarizeState(state, statePath),
      backend: backendReadiness({ statePath }),
      doctor: doctor(state),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/integrations') {
    const { state } = await authenticatedState(req);
    sendJson(res, 200, {
      ok: true,
      readiness: providerReadiness(),
      providerValidationRuns: [...(state.providerValidationRuns ?? [])].sort((left, right) => Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? '')),
      providerValidationSchedules: state.providerValidationSchedules ?? [],
      summary: summarizeState(state, statePath),
    });
    return;
  }

  if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/integrations/sandbox') {
    const { auth, state } = await authenticatedState(req);
    requireAdminRequestAuth(state, auth, 'integrations.sandbox');
    const sandbox = await validateProviderSandbox();
    if (req.method === 'POST') {
      const recorded = await recordProviderSandboxValidation(sandbox, { actorUserId: auth.actorUserId, statePath });
      sendJson(res, 200, {
        ok: sandbox.ok,
        sandbox,
        recorded: recorded.details,
        state: recorded.state,
        summary: recorded.summary,
        doctor: doctor(recorded.state),
      });
      return;
    }
    sendJson(res, 200, {
      ok: sandbox.ok,
      sandbox,
      providerValidationRuns: [...(state.providerValidationRuns ?? [])].sort((left, right) => Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? '')),
      providerValidationSchedules: state.providerValidationSchedules ?? [],
    });
    return;
  }

  if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/integrations/scheduled') {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const { auth, state } = await authenticatedState(req, body);
    requireAdminRequestAuth(state, auth, 'integrations.scheduled');
    const dueSchedules = providerValidationSchedulesDue(state);
    if (req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        dueSchedules,
        providerValidationSchedules: state.providerValidationSchedules ?? [],
        summary: summarizeState(state, statePath),
      });
      return;
    }

    const forceRun = Boolean(body.force);
    if (!forceRun && dueSchedules.length === 0) {
      sendJson(res, 200, {
        ok: true,
        dueSchedules,
        forced: false,
        providerValidationSchedules: state.providerValidationSchedules ?? [],
        recorded: null,
        skipped: true,
        summary: summarizeState(state, statePath),
        doctor: doctor(state),
      });
      return;
    }

    const sandbox = await validateProviderSandbox();
    const recorded = await recordProviderSandboxValidation(sandbox, { actorUserId: auth.actorUserId, statePath });
    sendJson(res, 200, {
      ok: sandbox.ok,
      dueSchedules,
      forced: forceRun,
      sandbox,
      recorded: recorded.details,
      skipped: false,
      state: recorded.state,
      summary: recorded.summary,
      doctor: doctor(recorded.state),
    });
    return;
  }

  const unsubscribeMatch = url.pathname.match(/^\/api\/email\/unsubscribe\/([^/]+)$/);
  if ((req.method === 'GET' || req.method === 'POST') && unsubscribeMatch) {
    const result = await unsubscribeEmailDigest(decodeURIComponent(unsubscribeMatch[1]), {
      actorUserId: process.env.SIGNAL_UNSUBSCRIBE_ACTOR ?? process.env.SIGNAL_WEBHOOK_ACTOR,
      statePath,
    });
    sendJson(res, 200, {
      ok: true,
      action: result.action,
      details: result.details,
      summary: result.summary,
      doctor: doctor(result.state),
    });
    return;
  }

  const oauthCallbackMatch = url.pathname.match(/^\/api\/oauth\/(gmail|outlook)\/callback$/);
  if (req.method === 'GET' && oauthCallbackMatch) {
    const oauthActorUserId = requireOAuthActor(await resolveOAuthActor(req, {
      authenticateSession: requestStateAuth,
    }));
    const result = await completeMailboxConnectionFromOAuthCallback(oauthCallbackMatch[1], {
      code: url.searchParams.get('code'),
      error: url.searchParams.get('error'),
      errorDescription: url.searchParams.get('error_description'),
      state: url.searchParams.get('state'),
    }, { actorUserId: oauthActorUserId, statePath });
    sendJson(res, 200, {
      ok: true,
      action: result.action,
      details: result.details,
      summary: result.summary,
      doctor: doctor(result.state),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/bootstrap') {
    const body = await readBody(req);
    const { auth, state } = await authenticatedState(req, body);
    requireAdminRequestAuth(state, auth, 'bootstrap');
    const result = await bootstrapState({ force: Boolean(body.force), statePath });
    sendJson(res, 200, {
      ok: true,
      state: result.state,
      summary: result.summary,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/invites/claim') {
    const rateLimit = inviteClaimRateLimiter.consume(`invite-claim:${requestClientIp(req)}`);
    if (!rateLimit.allowed) {
      throw new SignalStateError('Invite claim rate limit exceeded. Try again later.', {
        code: 'INVITE_CLAIM_RATE_LIMITED',
        status: 429,
        details: {
          retryAfterSeconds: Math.ceil(rateLimit.retryAfterMs / 1000),
        },
      });
    }
    const body = await readBody(req);
    const result = await claimUserInvite(body, { statePath });
    sendJson(res, 200, {
      ok: true,
      action: result.action,
      actor: {
        email: result.actor.email,
        id: result.actor.id,
        name: result.actor.name,
        role: result.actor.role,
      },
      details: result.details,
      state: result.state,
      summary: result.summary,
      doctor: doctor(result.state),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/registration') {
    const body = await readBody(req);
    const result = await registerTenantWorkspace(body, { statePath });
    sendJson(res, 200, {
      ok: true,
      action: result.action,
      actor: {
        email: result.actor.email,
        id: result.actor.id,
        name: result.actor.name,
        role: result.actor.role,
      },
      details: result.details,
      state: result.state,
      summary: result.summary,
      doctor: doctor(result.state),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/mutations') {
    const body = await readBody(req);
    const auth = await requestStateAuth(req, body);
    const result = await applyMutation(body.action, body.args ?? {}, { actorUserId: auth.actorUserId, statePath });
    sendJson(res, 200, {
      ok: true,
      action: result.action,
      actor: {
        email: result.actor.email,
        id: result.actor.id,
        name: result.actor.name,
        role: result.actor.role,
      },
      details: result.details,
      state: result.state,
      summary: result.summary,
      auth: auth.auth,
      doctor: doctor(result.state),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/webhooks/stripe') {
    const rawBody = await readRawBody(req);
    const signatureHeader = req.headers['stripe-signature']?.toString();
    const webhookActorUserId = requireWebhookActor(resolveWebhookActor(req));
    const result = await handleSignedStripePaymentWebhook(rawBody, signatureHeader, {
      actorUserId: webhookActorUserId,
      statePath,
    });
    sendJson(res, 200, {
      ok: true,
      action: result.action,
      details: result.details,
      summary: result.summary,
      doctor: doctor(result.state),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/webhooks/email') {
    const rawBody = await readRawBody(req);
    const signatureHeader = req.headers['signal-email-signature']?.toString();
    const sendGridSignatureHeader = req.headers['x-twilio-email-event-webhook-signature']?.toString();
    const sendGridTimestampHeader = req.headers['x-twilio-email-event-webhook-timestamp']?.toString();
    const webhookActorUserId = requireWebhookActor(resolveWebhookActor(req));
    const result = sendGridSignatureHeader && sendGridTimestampHeader
      ? await handleSignedSendGridEmailDeliveryWebhook(rawBody, sendGridSignatureHeader, sendGridTimestampHeader, {
          actorUserId: webhookActorUserId,
          statePath,
        })
      : await handleSignedEmailDeliveryWebhook(rawBody, signatureHeader, {
          actorUserId: webhookActorUserId,
          statePath,
        });
    sendJson(res, 200, {
      ok: true,
      action: result.action,
      details: result.details,
      summary: result.summary,
      doctor: doctor(result.state),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/webhooks/gmail') {
    await verifyGmailPubSubPushAuthorization(req);
    const body = await readBody(req);
    const webhookActorUserId = requireWebhookActor(resolveWebhookActor(req));
    const result = await handleProviderWatchNotification('gmail', body, {
      actorUserId: webhookActorUserId,
      statePath,
    });
    sendJson(res, 200, {
      ok: true,
      action: result.action,
      details: result.details,
      summary: result.summary,
      doctor: doctor(result.state),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/webhooks/outlook') {
    const validationToken = url.searchParams.get('validationToken');
    if (validationToken) {
      sendText(res, 200, validationToken);
      return;
    }
    const body = await readBody(req);
    const webhookActorUserId = requireWebhookActor(resolveWebhookActor(req));
    const result = await handleProviderWatchNotification('outlook', body, {
      actorUserId: webhookActorUserId,
      statePath,
    });
    sendJson(res, 200, {
      ok: true,
      action: result.action,
      details: result.details,
      summary: result.summary,
      doctor: doctor(result.state),
    });
    return;
  }

  notFound(res);
}

const server = http.createServer((req, res) => {
  applyCorsHeaders(req, res);
  route(req, res).catch((error) => {
    const { status, payload } = errorPayload(error);
    sendJson(res, status, payload);
  });
});

server.listen(port, host, async () => {
  await ensureState({ statePath });
  console.log(`Signal local API listening on http://${host}:${port}`);
  console.log(`State: ${statePath}`);
});
