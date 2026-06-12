import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PaymentProviderError,
  createStripeBillingPortalSession,
  createStripeCheckoutSession,
  parseSignedStripeWebhook,
} from './signal-payment-provider.mjs';
import {
  EmailProviderError,
  deliverEmailMessage,
  parseEmailWebhookPayload,
  parseSignedEmailWebhook,
  parseSignedSendGridWebhook,
} from './signal-email-provider.mjs';
import {
  OAuthProviderError,
  createOAuthStatePayload,
  exchangeOAuthCodeForTokens,
  isOAuthTokenExchangeConfigured,
  localOAuthCallbackUrl,
  oauthStateDigest,
  providerAuthorizationUrl,
  providerRedirectUri,
  signOAuthState,
  verifyOAuthState,
} from './signal-oauth-provider.mjs';
import {
  TokenVaultError,
  loadProviderCredential,
  storeProviderCredential,
} from './signal-token-vault.mjs';
import {
  ProviderWatchError,
  createProviderWatch,
  createProviderWatchSecret,
  digestClientState,
  normalizeProviderWatchResult,
  parseGmailPubSubNotification,
  parseOutlookChangeNotification,
} from './signal-provider-watch.mjs';
import {
  ProviderSyncError,
  fetchProviderSync,
  normalizeProviderSyncResult,
} from './signal-provider-sync.mjs';
import {
  SessionTokenError,
  createSessionToken,
  sessionTokenDigest,
  verifySessionToken,
} from './signal-session-token.mjs';
import {
  validateProviderSandbox,
} from './signal-provider-sandbox.mjs';
import {
  backendReadiness,
} from './signal-backend-readiness.mjs';

export class SignalStateError extends Error {
  constructor(message, { code = 'SIGNAL_STATE_ERROR', status = 400, details = {} } = {}) {
    super(message);
    this.name = 'SignalStateError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const seedPath = path.join(rootDir, 'data', 'sample-seed.json');
export const defaultStatePath = path.join(rootDir, 'data', 'signal-local.json');

function isHttpResource(value) {
  return /^https?:\/\//i.test(String(value ?? ''));
}

function configuredStateServiceUrl() {
  return process.env.SIGNAL_BACKEND_MODE === 'external-service' ? process.env.SIGNAL_STATE_SERVICE_URL : null;
}

export function resolveStatePath(statePath = process.env.SIGNAL_ADMIN_STATE) {
  const configured = statePath ?? configuredStateServiceUrl();
  if (isHttpResource(configured)) {
    return String(configured).replace(/\/+$/, '');
  }
  return configured ? path.resolve(configured) : defaultStatePath;
}

function stateServiceHeaders(extra = {}) {
  return {
    ...extra,
    ...(process.env.SIGNAL_STATE_SERVICE_TOKEN ? { Authorization: `Bearer ${process.env.SIGNAL_STATE_SERVICE_TOKEN}` } : {}),
  };
}

const stateRevisionByPath = new Map();
const stateMutationChains = new Map();

function parseStateEtag(etag) {
  if (!etag) {
    return null;
  }
  const trimmed = String(etag).trim();
  const match = trimmed.match(/^W\/"([^"]+)"$/) || trimmed.match(/^"([^"]+)"$/);
  return match ? match[1] : trimmed;
}

function rememberStateRevision(statePath, revision) {
  if (revision !== null && revision !== undefined && revision !== '') {
    stateRevisionByPath.set(statePath, revision);
  }
}

function withStateMutationLock(statePath, fn) {
  const key = resolveStatePath(statePath);
  const previous = stateMutationChains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  stateMutationChains.set(key, next);
  return next.finally(() => {
    if (stateMutationChains.get(key) === next) {
      stateMutationChains.delete(key);
    }
  });
}

// Multi-process deployments still perform read-modify-write at the API layer.
// Long-term follow-up (issue #5): push transactional RMW into the state-service backend.
async function runLockedStateWriter(resolvedStatePath, writer, { retryOnConflict = true } = {}) {
  return withStateMutationLock(resolvedStatePath, async () => {
    const maxAttempts = isHttpResource(resolvedStatePath) && retryOnConflict ? 5 : 1;
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await writer();
      } catch (error) {
        if (error instanceof SignalStateError && error.code === 'STATE_REVISION_CONFLICT' && attempt < maxAttempts - 1) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new SignalStateError('State mutation failed after retrying concurrent writes.', {
      code: 'STATE_REVISION_CONFLICT',
      status: 409,
      details: { statePath: resolvedStatePath },
    });
  });
}

function stateServiceError(message, { code = 'STATE_SERVICE_ERROR', status = 502, details = {} } = {}) {
  return new SignalStateError(message, { code, status, details });
}

export async function readJson(filePath) {
  if (isHttpResource(filePath)) {
    const response = await fetch(filePath, {
      headers: stateServiceHeaders({ Accept: 'application/json' }),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(Number(process.env.SIGNAL_STATE_SERVICE_TIMEOUT_MS ?? 5000)) : undefined,
    });
    if (!response.ok) {
      throw stateServiceError(`State service read failed with ${response.status}.`, {
        code: response.status === 404 ? 'STATE_MISSING' : 'STATE_SERVICE_READ_FAILED',
        status: response.status === 404 ? 404 : 502,
        details: { serviceUrl: filePath, statusCode: response.status },
      });
    }
    rememberStateRevision(filePath, parseStateEtag(response.headers.get('etag')));
    return response.json();
  }
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function writeJson(filePath, value, { ifMatch } = {}) {
  if (isHttpResource(filePath)) {
    const expectedRevision = ifMatch ?? stateRevisionByPath.get(filePath);
    const headers = stateServiceHeaders({
      'Content-Type': 'application/json',
      ...(expectedRevision !== null && expectedRevision !== undefined
        ? { 'If-Match': `"${expectedRevision}"` }
        : {}),
    });
    const response = await fetch(filePath, {
      body: `${JSON.stringify(value, null, 2)}\n`,
      headers,
      method: 'PUT',
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(Number(process.env.SIGNAL_STATE_SERVICE_TIMEOUT_MS ?? 5000)) : undefined,
    });
    if (response.status === 409) {
      throw stateServiceError('State revision conflict — concurrent write detected.', {
        code: 'STATE_REVISION_CONFLICT',
        status: 409,
        details: { serviceUrl: filePath, statusCode: 409 },
      });
    }
    if (response.status === 428) {
      throw stateServiceError('State service requires If-Match for updates.', {
        code: 'STATE_PRECONDITION_REQUIRED',
        status: 428,
        details: { serviceUrl: filePath, statusCode: 428 },
      });
    }
    if (!response.ok) {
      throw stateServiceError(`State service write failed with ${response.status}.`, {
        code: 'STATE_SERVICE_WRITE_FAILED',
        details: { serviceUrl: filePath, statusCode: response.status },
      });
    }
    const payload = await response.json().catch(() => null);
    const nextRevision = parseStateEtag(response.headers.get('etag'))
      ?? (payload?.state?.revision !== undefined ? String(payload.state.revision) : null)
      ?? payload?.state?.digest
      ?? null;
    rememberStateRevision(filePath, nextRevision);
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

export async function exists(filePath) {
  if (isHttpResource(filePath)) {
    const response = await fetch(filePath, {
      headers: stateServiceHeaders({ Accept: 'application/json' }),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(Number(process.env.SIGNAL_STATE_SERVICE_TIMEOUT_MS ?? 5000)) : undefined,
    });
    if (response.status === 404) {
      return false;
    }
    if (response.ok) {
      return true;
    }
    throw stateServiceError(`State service existence check failed with ${response.status}.`, {
      code: 'STATE_SERVICE_EXISTS_FAILED',
      details: { serviceUrl: filePath, statusCode: response.status },
    });
  }
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function bootstrapState({ force = false, statePath } = {}) {
  const resolvedStatePath = resolveStatePath(statePath);
  return withStateMutationLock(resolvedStatePath, async () => {
    if ((await exists(resolvedStatePath)) && !force) {
      throw new SignalStateError(`Local state already exists at ${resolvedStatePath}. Use force to overwrite.`, {
        code: 'STATE_EXISTS',
        status: 409,
        details: { statePath: resolvedStatePath },
      });
    }

    const seed = await readJson(seedPath);
    const stamped = normalizeState({
      ...seed,
      meta: {
        ...seed.meta,
        bootstrappedAt: new Date().toISOString(),
        statePath: resolvedStatePath,
      },
    });
    let ifMatch;
    if (force && isHttpResource(resolvedStatePath) && (await exists(resolvedStatePath))) {
      await readJson(resolvedStatePath);
      ifMatch = stateRevisionByPath.get(resolvedStatePath);
    }
    await writeJson(resolvedStatePath, stamped, { ifMatch });
    return {
      state: stamped,
      statePath: resolvedStatePath,
      summary: summarizeState(stamped, resolvedStatePath),
    };
  });
}

export async function ensureState({ statePath } = {}) {
  const resolvedStatePath = resolveStatePath(statePath);
  if (!(await exists(resolvedStatePath))) {
    return bootstrapState({ force: false, statePath: resolvedStatePath });
  }

  const state = normalizeState(await readJson(resolvedStatePath));
  return {
    state,
    statePath: resolvedStatePath,
    summary: summarizeState(state, resolvedStatePath),
  };
}

export async function loadState({ allowMissing = false, statePath } = {}) {
  const resolvedStatePath = resolveStatePath(statePath);
  if (!(await exists(resolvedStatePath))) {
    if (allowMissing) {
      return null;
    }
    throw new SignalStateError(`Local state does not exist at ${resolvedStatePath}. Run: npm run admin:bootstrap`, {
      code: 'STATE_MISSING',
      status: 404,
      details: { statePath: resolvedStatePath },
    });
  }
  return normalizeState(await readJson(resolvedStatePath));
}

export async function saveState(state, { ifMatch, statePath } = {}) {
  const resolvedStatePath = resolveStatePath(statePath);
  normalizeState(state);
  state.meta = {
    ...state.meta,
    updatedAt: new Date().toISOString(),
  };
  await writeJson(resolvedStatePath, state, {
    ifMatch: ifMatch ?? stateRevisionByPath.get(resolvedStatePath),
  });
  return {
    state,
    statePath: resolvedStatePath,
    summary: summarizeState(state, resolvedStatePath),
  };
}

export async function switchSession(userId, { actorUserId, statePath } = {}) {
  const resolvedStatePath = resolveStatePath(statePath);
  return runLockedStateWriter(resolvedStatePath, async () => {
    const state = await loadState({ statePath });
    const previousActor = getActor(state, actorUserId ?? state.session?.activeUserId, { allowMissing: true });
    const nextActor = getActor(state, requireArg(userId, 'user id', 'session switch <userId>'));
    const previousUserId = state.session?.activeUserId ?? null;
    state.session = {
      activeUserId: nextActor.id,
      allowedRoles: ['admin', 'member'],
      localOnly: true,
      ...(state.session ?? {}),
    };
    state.session.activeUserId = nextActor.id;

    const details = {
      message: `Local session switched to ${nextActor.email}`,
      nextUserId: nextActor.id,
      previousUserId,
      targetId: nextActor.id,
    };
    appendAudit(state, 'session.switch', nextActor.id, details.message, previousActor ?? nextActor);
    const saved = await saveState(state, { statePath });
    return {
      ok: true,
      action: 'session.switch',
      actor: nextActor,
      details,
      state: saved.state,
      summary: saved.summary,
    };
  });
}

export function normalizeState(state) {
  state.tenants = state.tenants ?? [];
  state.tenants.forEach((tenant) => {
    const tenantAdmin = state.users?.find((user) => user.tenantId === tenant.id && user.role === 'admin' && user.status === 'active')
      ?? state.users?.find((user) => user.tenantId === tenant.id && user.status === 'active')
      ?? state.users?.[0];
    tenant.status = ['active', 'suspended'].includes(tenant.status) ? tenant.status : 'active';
    tenant.ownerUserId = tenant.ownerUserId ?? tenantAdmin?.id ?? null;
    tenant.billingOwnerUserId = tenant.billingOwnerUserId ?? tenant.ownerUserId ?? tenantAdmin?.id ?? null;
    tenant.registrationStatus = ['active', 'pending_onboarding'].includes(tenant.registrationStatus) ? tenant.registrationStatus : 'active';
    tenant.createdAt = tenant.createdAt ?? state.meta?.bootstrappedAt ?? state.meta?.updatedAt ?? null;
    tenant.createdByUserId = tenant.createdByUserId ?? tenant.ownerUserId ?? tenantAdmin?.id ?? null;
    tenant.statusUpdatedAt = tenant.statusUpdatedAt ?? state.meta?.updatedAt ?? state.meta?.bootstrappedAt ?? null;
  });
  state.session = {
    activeUserId: 'usr_admin',
    allowedRoles: ['admin', 'member'],
    localOnly: true,
    ...(state.session ?? {}),
  };
  state.apiSessions = state.apiSessions ?? [];
  state.auditEvents = state.auditEvents ?? [];
  state.billingSessions = state.billingSessions ?? [];
  state.billingOverrides = state.billingOverrides ?? [];
  refreshBillingOverrideStatuses(state);
  state.entitlements = state.entitlements ?? [];
  state.emailSyncCursors = state.emailSyncCursors ?? [];
  state.providerValidationRuns = state.providerValidationRuns ?? [];
  state.providerValidationSchedules = state.providerValidationSchedules ?? defaultProviderValidationSchedules(state);
  ensureDefaultProviderValidationSchedules(state);
  state.invites = state.invites ?? defaultInvites(state);
  state.memberships = state.memberships ?? defaultMemberships(state);
  ensureDefaultMemberships(state);
  state.invoices = state.invoices ?? [];
  state.jobs = state.jobs ?? [];
  ensureProviderValidationSchedulerJob(state);
  state.mailboxConnectionSessions = state.mailboxConnectionSessions ?? [];
  state.paymentEvents = state.paymentEvents ?? [];
  state.sourceMessages = state.sourceMessages ?? defaultSourceMessages(state);
  state.sourceMessages.forEach((message) => {
    message.processedFlowIds = message.processedFlowIds ?? [];
    message.providerSyncMode = message.providerSyncMode ?? 'local';
  });
  state.routingRules = state.routingRules ?? defaultRoutingRules(state);
  ensureDefaultRoutingRules(state);
  state.flowRuns = state.flowRuns ?? [];
  state.signalHandoffs = state.signalHandoffs ?? [];
  state.accountProfiles = state.accountProfiles ?? defaultAccountProfiles(state);
  state.accountEvents = state.accountEvents ?? defaultAccountEvents(state);
  state.accountActions = state.accountActions ?? defaultAccountActions(state);
  state.accountReviews = state.accountReviews ?? [];
  state.accountRecommendations = state.accountRecommendations ?? defaultAccountRecommendations(state);
  ensureDefaultAccountRecommendations(state);
  state.notificationPreferences = state.notificationPreferences ?? defaultNotificationPreferences(state);
  ensureDefaultNotificationPreferences(state);
  state.notificationEvents = state.notificationEvents ?? defaultNotificationEvents(state);
  state.notificationDigestRuns = state.notificationDigestRuns ?? [];
  state.emailDeliveryMessages = state.emailDeliveryMessages ?? defaultEmailDeliveryMessages(state);
  state.emailWatchSubscriptions = state.emailWatchSubscriptions ?? [];
  refreshNotificationQueue(state);
  state.signalQualitySettings = state.signalQualitySettings ?? defaultSignalQualitySettings(state);
  ensureDefaultSignalQualitySettings(state);
  state.suppressionRules = state.suppressionRules ?? defaultSuppressionRules(state);
  state.signalFeedback = state.signalFeedback ?? [];
  state.modelGovernancePolicies = state.modelGovernancePolicies ?? defaultModelGovernancePolicies(state);
  ensureDefaultModelGovernancePolicies(state);
  state.governancePolicies = state.governancePolicies ?? defaultGovernancePolicies(state);
  ensureDefaultGovernancePolicies(state);
  state.redactionRules = state.redactionRules ?? defaultRedactionRules(state);
  state.dataRequests = state.dataRequests ?? defaultDataRequests(state);
  state.incidentNotes = state.incidentNotes ?? defaultIncidentNotes(state);
  state.subscriptions?.forEach((subscription) => upsertEntitlementFromSubscription(state, subscription));
  ensureDefaultEmailSyncCursors(state);
  ensureDefaultMailboxConnectionSessions(state);
  ensureDefaultBillingSessions(state);
  ensureDefaultJobs(state);
  state.lifecycleNotices = deriveLifecycleNotices(state);
  return state;
}

export function summarizeState(state, statePath = resolveStatePath()) {
  const activeUser = getActor(state, state.session?.activeUserId, { allowMissing: true });
  return {
    statePath,
    schemaVersion: state.meta?.schemaVersion ?? null,
    environment: state.meta?.environment ?? 'local',
    tenants: state.tenants?.length ?? 0,
    activeTenants: state.tenants?.filter((tenant) => tenant.status === 'active').length ?? 0,
    suspendedTenants: state.tenants?.filter((tenant) => tenant.status === 'suspended').length ?? 0,
    tenantStatus: state.tenants?.[0]?.status ?? null,
    users: state.users?.length ?? 0,
    admins: state.users?.filter((user) => user.role === 'admin' && user.status === 'active').length ?? 0,
    invites: state.invites?.length ?? 0,
    pendingInvites: state.invites?.filter((invite) => invite.status === 'pending').length ?? 0,
    acceptedInvites: state.invites?.filter((invite) => invite.status === 'accepted').length ?? 0,
    memberships: state.memberships?.length ?? 0,
    activeMemberships: state.memberships?.filter((membership) => membership.status === 'active').length ?? 0,
    disabledMemberships: state.memberships?.filter((membership) => membership.status === 'disabled').length ?? 0,
    activeSeats: activeSeatCount(state),
    pendingInviteSeats: pendingInviteSeatCount(state),
    seatLimit: seatLimitForTenant(state, defaultTenantId(state)),
    seatsAvailable: seatsAvailableForTenant(state, defaultTenantId(state)),
    mailboxes: state.mailboxes?.length ?? 0,
    connectedMailboxes: state.mailboxes?.filter((mailbox) => mailbox.status === 'connected').length ?? 0,
    mailboxConnectionSessions: state.mailboxConnectionSessions?.length ?? 0,
    activeSyncCursors: state.emailSyncCursors?.filter((cursor) => cursor.status === 'active').length ?? 0,
    blockedSyncCursors: state.emailSyncCursors?.filter((cursor) => cursor.status === 'blocked').length ?? 0,
    emailWatchSubscriptions: state.emailWatchSubscriptions?.length ?? 0,
    activeEmailWatchSubscriptions: state.emailWatchSubscriptions?.filter((watch) => watch.status === 'active').length ?? 0,
    expiringEmailWatchSubscriptions: state.emailWatchSubscriptions?.filter((watch) => watch.status === 'active' && Date.parse(watch.expirationAt ?? '') < Date.now() + 24 * 60 * 60 * 1000).length ?? 0,
    emailFlows: state.emailFlows?.length ?? 0,
    enabledEmailFlows: state.emailFlows?.filter((flow) => flow.status === 'enabled').length ?? 0,
    routingRules: state.routingRules?.length ?? 0,
    activeRoutingRules: state.routingRules?.filter((rule) => rule.status === 'active').length ?? 0,
    sourceMessages: state.sourceMessages?.length ?? 0,
    flowRuns: state.flowRuns?.length ?? 0,
    generatedSignals: state.signals?.filter((signal) => signal.sourceMessageId && signal.flowId).length ?? 0,
    openSignals: state.signals?.filter((signal) => signal.status === 'open').length ?? 0,
    signalHandoffs: state.signalHandoffs?.length ?? 0,
    queuedSignalHandoffs: state.signalHandoffs?.filter((handoff) => handoff.status === 'queued').length ?? 0,
    failedSignalHandoffs: state.signalHandoffs?.filter((handoff) => handoff.status === 'failed').length ?? 0,
    accounts: state.accountProfiles?.length ?? 0,
    atRiskAccounts: state.accountProfiles?.filter((account) => account.healthScore < 55 || account.healthTrend === 'down').length ?? 0,
    accountEvents: state.accountEvents?.length ?? 0,
    openAccountActions: state.accountActions?.filter((action) => action.status === 'open').length ?? 0,
    accountReviews: state.accountReviews?.length ?? 0,
    accountRecommendations: state.accountRecommendations?.length ?? 0,
    openAccountRecommendations: state.accountRecommendations?.filter((recommendation) => recommendation.status === 'open').length ?? 0,
    latestAccountReviewAt: [...(state.accountReviews ?? [])].sort((left, right) => Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? ''))[0]?.createdAt ?? null,
    notificationPreferences: state.notificationPreferences?.length ?? 0,
    notificationEvents: state.notificationEvents?.length ?? 0,
    unreadNotifications: state.notificationEvents?.filter((event) => event.status === 'unread').length ?? 0,
    mutedNotifications: state.notificationEvents?.filter((event) => event.status === 'muted').length ?? 0,
    digestRuns: state.notificationDigestRuns?.length ?? 0,
    emailDeliveries: state.emailDeliveryMessages?.length ?? 0,
    queuedEmailDeliveries: state.emailDeliveryMessages?.filter((message) => message.status === 'queued').length ?? 0,
    failedEmailDeliveries: state.emailDeliveryMessages?.filter((message) => ['failed', 'bounced'].includes(message.status)).length ?? 0,
    unsubscribedUsers: state.notificationPreferences?.filter((preference) => preference.emailDeliveryStatus === 'unsubscribed' || !(preference.channels ?? []).includes('email_digest')).length ?? 0,
    signalQualitySettings: state.signalQualitySettings?.length ?? 0,
    suppressionRules: state.suppressionRules?.length ?? 0,
    activeSuppressionRules: state.suppressionRules?.filter((rule) => rule.status === 'active').length ?? 0,
    signalFeedback: state.signalFeedback?.length ?? 0,
    modelGovernancePolicies: state.modelGovernancePolicies?.length ?? 0,
    optInModelLearningPolicies: state.modelGovernancePolicies?.filter((policy) => policy.learningMode === 'opt_in_tuning').length ?? 0,
    perTenantModels: state.modelGovernancePolicies?.filter((policy) => policy.perTenantModel === true).length ?? 0,
    governancePolicies: state.governancePolicies?.length ?? 0,
    activeRedactionRules: state.redactionRules?.filter((rule) => rule.status === 'active').length ?? 0,
    openDataRequests: state.dataRequests?.filter((request) => ['open', 'processing'].includes(request.status)).length ?? 0,
    openIncidentNotes: state.incidentNotes?.filter((note) => note.status === 'open').length ?? 0,
    subscriptions: state.subscriptions?.length ?? 0,
    invoices: state.invoices?.length ?? 0,
    openInvoices: state.invoices?.filter((invoice) => ['open', 'past_due'].includes(invoice.status)).length ?? 0,
    pastDueInvoices: state.invoices?.filter((invoice) => invoice.status === 'past_due').length ?? 0,
    billingOverrides: state.billingOverrides?.length ?? 0,
    activeBillingOverrides: state.billingOverrides?.filter((override) => override.status === 'active').length ?? 0,
    revokedBillingOverrides: state.billingOverrides?.filter((override) => override.status === 'revoked').length ?? 0,
    paymentEvents: state.paymentEvents?.length ?? 0,
    billingSessions: state.billingSessions?.length ?? 0,
    lifecycleNotices: state.lifecycleNotices?.length ?? 0,
    openLifecycleNotices: state.lifecycleNotices?.filter((notice) => notice.status === 'open').length ?? 0,
    criticalLifecycleNotices: state.lifecycleNotices?.filter((notice) => notice.status === 'open' && notice.severity === 'critical').length ?? 0,
    activeEntitlements: state.entitlements?.filter((entitlement) => entitlement.status === 'active').length ?? 0,
    jobs: state.jobs?.length ?? 0,
    failedJobs: state.jobs?.filter((job) => job.status === 'failed').length ?? 0,
    apiSessions: state.apiSessions?.length ?? 0,
    activeApiSessions: activeApiSessions(state).length,
    revokedApiSessions: state.apiSessions?.filter((session) => session.status === 'revoked').length ?? 0,
    providerValidationRuns: state.providerValidationRuns?.length ?? 0,
    latestProviderValidationStatus: [...(state.providerValidationRuns ?? [])].sort((left, right) => Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? ''))[0]?.status ?? null,
    latestProviderValidationAt: [...(state.providerValidationRuns ?? [])].sort((left, right) => Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? ''))[0]?.recordedAt ?? null,
    providerValidationSchedules: state.providerValidationSchedules?.length ?? 0,
    activeProviderValidationSchedules: state.providerValidationSchedules?.filter((schedule) => schedule.status === 'active').length ?? 0,
    dueProviderValidationSchedules: providerValidationSchedulesDue(state).length,
    auditEvents: state.auditEvents?.length ?? 0,
    activeUserId: activeUser?.id ?? null,
    activeUserRole: activeUser?.role ?? null,
  };
}

function dashboardAuditRow({
  area,
  check,
  detail,
  displayValue,
  scope = 'tenant',
  summaryKey,
  summaryValue,
  totalValue,
}) {
  const expectedTotal = Number(totalValue ?? 0);
  const reportedTotal = Number(summaryValue ?? 0);
  const visibleValue = Number(displayValue ?? 0);
  const totalMatchesSummary = expectedTotal === reportedTotal;
  const visibleWithinTotal = visibleValue <= expectedTotal;
  return {
    area,
    check,
    detail,
    displayValue: visibleValue,
    ok: totalMatchesSummary && visibleWithinTotal,
    scope,
    summaryKey,
    summaryValue: reportedTotal,
    totalValue: expectedTotal,
  };
}

function visibleDashboardScope(state, actor, tenantId) {
  const membership = membershipForUser(state, actor?.id, tenantId);
  const role = membership?.role ?? actor?.role ?? null;
  const team = membership?.team ?? actor?.team ?? null;
  const isAdmin = role === 'admin';
  const visibleSignals = (state.signals ?? []).filter((signal) =>
    signal.tenantId === tenantId &&
    (
      isAdmin ||
      signal.ownerUserId === actor?.id ||
      signal.routeTo === team
    ));
  const memberAccountNames = new Set([
    ...visibleSignals.map((signal) => signal.account),
    ...(state.accountActions ?? [])
      .filter((action) => action.tenantId === tenantId && action.ownerUserId === actor?.id)
      .map((action) => action.account),
  ]);
  const visibleAccounts = (state.accountProfiles ?? []).filter((account) =>
    account.tenantId === tenantId &&
    (
      isAdmin ||
      account.ownerUserId === actor?.id ||
      memberAccountNames.has(account.name)
    ));
  const visibleMailboxes = (state.mailboxes ?? []).filter((mailbox) =>
    mailbox.tenantId === tenantId &&
    (
      isAdmin ||
      mailbox.ownerUserId === actor?.id
    ));
  const visibleMailboxIds = new Set(visibleMailboxes.map((mailbox) => mailbox.id));
  const visibleSourceMessages = (state.sourceMessages ?? []).filter((message) =>
    message.tenantId === tenantId &&
    visibleMailboxIds.has(message.mailboxId));
  const visibleNotifications = (state.notificationEvents ?? []).filter((event) =>
    event.tenantId === tenantId &&
    (isAdmin || event.userId === actor?.id));
  return {
    actor: actor
      ? {
          id: actor.id,
          role,
          team,
          tenantId,
        }
      : null,
    visibleAccounts,
    visibleMailboxes,
    visibleNotifications,
    visibleSignals,
    visibleSourceMessages,
  };
}

export function dashboardAuditReport(state, {
  backend = null,
  statePath = resolveStatePath(),
} = {}) {
  const summary = summarizeState(state, statePath);
  const tenantId = defaultTenantId(state);
  const actor = getActor(state, state.session?.activeUserId, { allowMissing: true });
  const scope = visibleDashboardScope(state, actor, tenantId);
  const globalOpenSignals = (state.signals ?? []).filter((signal) => signal.status === 'open');
  const globalAccounts = state.accountProfiles ?? [];
  const globalMailboxes = state.mailboxes ?? [];
  const globalSourceMessages = state.sourceMessages ?? [];
  const globalUnreadNotifications = (state.notificationEvents ?? []).filter((event) => event.status === 'unread');
  const globalActiveMemberships = (state.memberships ?? []).filter((membership) => membership.status === 'active');
  const globalPendingInvites = (state.invites ?? []).filter((invite) => invite.status === 'pending');
  const globalOpenInvoices = (state.invoices ?? []).filter((invoice) => ['open', 'past_due'].includes(invoice.status));
  const globalOpenLifecycleNotices = (state.lifecycleNotices ?? []).filter((notice) => notice.status === 'open');
  const rows = [
    dashboardAuditRow({
      area: 'user_workspace',
      check: 'Open signals',
      detail: 'Visible workspace signal count is scoped by role, owner, and team; global total matches shared summary.',
      displayValue: scope.visibleSignals.filter((signal) => signal.status === 'open').length,
      scope: 'actor_visible',
      summaryKey: 'openSignals',
      summaryValue: summary.openSignals,
      totalValue: globalOpenSignals.length,
    }),
    dashboardAuditRow({
      area: 'user_workspace',
      check: 'Accounts',
      detail: 'Visible account cards are scoped by owner/team signal evidence; global total matches shared summary.',
      displayValue: scope.visibleAccounts.length,
      scope: 'actor_visible',
      summaryKey: 'accounts',
      summaryValue: summary.accounts,
      totalValue: globalAccounts.length,
    }),
    dashboardAuditRow({
      area: 'user_workspace',
      check: 'Mailboxes',
      detail: 'Visible source cards are admin-wide or mailbox-owner scoped; global total matches shared summary.',
      displayValue: scope.visibleMailboxes.length,
      scope: 'actor_visible',
      summaryKey: 'mailboxes',
      summaryValue: summary.mailboxes,
      totalValue: globalMailboxes.length,
    }),
    dashboardAuditRow({
      area: 'user_workspace',
      check: 'Source snippets',
      detail: 'Visible source snippets only come from visible mailbox sources; global total matches shared summary.',
      displayValue: scope.visibleSourceMessages.length,
      scope: 'actor_visible',
      summaryKey: 'sourceMessages',
      summaryValue: summary.sourceMessages,
      totalValue: globalSourceMessages.length,
    }),
    dashboardAuditRow({
      area: 'user_workspace',
      check: 'Unread notifications',
      detail: 'Member notification center is user-scoped; global unread total matches shared summary.',
      displayValue: scope.visibleNotifications.filter((event) => event.status === 'unread').length,
      scope: 'actor_visible',
      summaryKey: 'unreadNotifications',
      summaryValue: summary.unreadNotifications,
      totalValue: globalUnreadNotifications.length,
    }),
    dashboardAuditRow({
      area: 'admin_dashboard',
      check: 'Active memberships',
      detail: 'Admin user and seat cards use membership records as the source of truth.',
      displayValue: globalActiveMemberships.length,
      scope: 'global_total',
      summaryKey: 'activeMemberships',
      summaryValue: summary.activeMemberships,
      totalValue: globalActiveMemberships.length,
    }),
    dashboardAuditRow({
      area: 'admin_dashboard',
      check: 'Pending invites',
      detail: 'Admin invite and seat cards use pending invite records as the source of truth.',
      displayValue: globalPendingInvites.length,
      scope: 'global_total',
      summaryKey: 'pendingInvites',
      summaryValue: summary.pendingInvites,
      totalValue: globalPendingInvites.length,
    }),
    dashboardAuditRow({
      area: 'admin_dashboard',
      check: 'Open invoices',
      detail: 'Admin payment cards use invoice records, not browser-provided billing totals.',
      displayValue: globalOpenInvoices.length,
      scope: 'global_total',
      summaryKey: 'openInvoices',
      summaryValue: summary.openInvoices,
      totalValue: globalOpenInvoices.length,
    }),
    dashboardAuditRow({
      area: 'admin_dashboard',
      check: 'Lifecycle notices',
      detail: 'Admin operations and payment panels derive notices from source records in state.',
      displayValue: globalOpenLifecycleNotices.length,
      scope: 'global_total',
      summaryKey: 'openLifecycleNotices',
      summaryValue: summary.openLifecycleNotices,
      totalValue: globalOpenLifecycleNotices.length,
    }),
  ];
  const backendChecks = backend?.checks ?? [];
  const backendBoundary = {
    mode: backend?.mode ?? (isHttpResource(statePath) ? 'external-service' : 'local-json'),
    productionReady: backend?.productionReady ?? false,
    readyChecks: backend?.summary?.readyChecks ?? backendChecks.filter((check) => check.ok).length,
    statePath,
    totalChecks: backend?.summary?.totalChecks ?? backendChecks.length,
  };
  const issues = rows
    .filter((row) => !row.ok)
    .map((row) => `${row.area}.${row.summaryKey}: displayed ${row.displayValue}, total ${row.totalValue}, summary ${row.summaryValue}`);
  return {
    generatedAt: new Date().toISOString(),
    ok: issues.length === 0,
    actor: scope.actor,
    backend: backendBoundary,
    issues,
    rows,
    summary: {
      failed: rows.filter((row) => !row.ok).length,
      passed: rows.filter((row) => row.ok).length,
      scopedRows: rows.filter((row) => row.scope === 'actor_visible').length,
      total: rows.length,
    },
  };
}

function onboardingReadinessRow({
  area,
  check,
  evidence = [],
  localOk,
  productionOk,
  recommendation,
}) {
  return {
    area,
    check,
    evidence,
    localOk: Boolean(localOk),
    productionOk: Boolean(productionOk),
    recommendation,
    status: localOk ? (productionOk ? 'production_ready' : 'local_ready') : 'attention',
  };
}

export function onboardingReadinessReport(state, {
  backend = null,
  statePath = resolveStatePath(),
} = {}) {
  const summary = summarizeState(state, statePath);
  const tenantId = defaultTenantId(state);
  const tenant = (state.tenants ?? []).find((item) => item.id === tenantId) ?? state.tenants?.[0] ?? null;
  const actor = getActor(state, state.session?.activeUserId, { allowMissing: true });
  const memberships = (state.memberships ?? []).filter((membership) => !tenant?.id || membership.tenantId === tenant.id);
  const activeMemberships = memberships.filter((membership) =>
    membership.status === 'active' &&
    (state.users ?? []).some((user) => user.id === membership.userId && user.status === 'active'));
  const activeAdmins = activeMemberships.filter((membership) => membership.role === 'admin');
  const activeMembers = activeMemberships.filter((membership) => membership.role === 'member');
  const pendingInvites = (state.invites ?? []).filter((invite) => (!tenant?.id || invite.tenantId === tenant.id) && invite.status === 'pending');
  const acceptedInvites = (state.invites ?? []).filter((invite) => (!tenant?.id || invite.tenantId === tenant.id) && invite.status === 'accepted');
  const acceptedInvitesWithMembership = acceptedInvites.filter((invite) => memberships.some((membership) => membership.inviteId === invite.id));
  const subscription = (state.subscriptions ?? []).find((item) => item.tenantId === tenant?.id);
  const entitlement = (state.entitlements ?? []).find((item) => item.tenantId === tenant?.id);
  const checkoutSession = (state.billingSessions ?? []).find((session) => session.tenantId === tenant?.id && session.type === 'checkout');
  const onboardingNotifications = (state.notificationEvents ?? []).filter((event) =>
    event.tenantId === tenant?.id &&
    String(event.type ?? '').startsWith('onboarding.'));
  const onboardingJobs = (state.jobs ?? []).filter((job) => job.tenantId === tenant?.id && job.queue === 'user_onboarding');
  const notificationPreferences = state.notificationPreferences ?? [];
  const activeUsers = (state.users ?? []).filter((user) => user.tenantId === tenant?.id && user.status === 'active');
  const usersWithPreferences = activeUsers.filter((user) => notificationPreferences.some((preference) => preference.userId === user.id));
  const tenantGovernance = (state.governancePolicies ?? []).find((policy) => policy.tenantId === tenant?.id);
  const modelPolicy = (state.modelGovernancePolicies ?? []).find((policy) => policy.tenantId === tenant?.id);
  const mailboxOwnershipOk = (state.mailboxes ?? [])
    .filter((mailbox) => !tenant?.id || mailbox.tenantId === tenant.id)
    .every((mailbox) => activeMemberships.some((membership) => membership.userId === mailbox.ownerUserId));
  const routingOwnershipOk = (state.routingRules ?? [])
    .filter((rule) => !tenant?.id || rule.tenantId === tenant.id)
    .every((rule) => !rule.ownerUserId || activeMemberships.some((membership) => membership.userId === rule.ownerUserId));
  const orphanMemberships = memberships.filter((membership) =>
    !(state.users ?? []).some((user) => user.id === membership.userId) ||
    !(state.tenants ?? []).some((candidate) => candidate.id === membership.tenantId));
  const seatLimit = seatLimitForTenant(state, tenant?.id);
  const seatsAvailable = seatsAvailableForTenant(state, tenant?.id);
  const tenantIsolation = backend?.checks?.find?.((check) => check.id === 'tenant_isolation');
  const signedSession = backend?.checks?.find?.((check) => check.id === 'signed_session_enforced');
  const productionAuth = backend?.checks?.find?.((check) => check.id === 'production_auth_provider');
  const durableState = backend?.checks?.find?.((check) => check.id === 'durable_state');
  const productionIsolationReady = Boolean(tenantIsolation?.ok && signedSession?.ok && productionAuth?.ok && durableState?.ok);
  const actorScope = visibleDashboardScope(state, actor, tenant?.id ?? tenantId);

  const rows = [
    onboardingReadinessRow({
      area: 'registration_flow',
      check: 'Workspace creation creates the tenant, admin owner, billing owner, subscription start, entitlement, checkout session, onboarding notification, onboarding job, and audit trail.',
      evidence: [
        tenant ? `${tenant.name} (${tenant.domain})` : 'No tenant',
        `owner ${tenant?.ownerUserId ?? 'missing'} / billing ${tenant?.billingOwnerUserId ?? 'missing'}`,
        `${subscription?.status ?? 'missing'} subscription, ${entitlement?.status ?? 'missing'} entitlement`,
        `${onboardingNotifications.length} onboarding notification(s), ${onboardingJobs.length} onboarding job(s)`,
      ],
      localOk: Boolean(tenant?.id && tenant.ownerUserId && tenant.billingOwnerUserId && subscription && entitlement) &&
        Boolean(checkoutSession || subscription?.status) &&
        Boolean(tenant?.registrationStatus === 'active' || (onboardingNotifications.length && onboardingJobs.length)),
      productionOk: Boolean(durableState?.ok && productionAuth?.ok),
      recommendation: 'Keep registration as a workspace-first flow; do not create personal-only accounts before tenant membership exists.',
    }),
    onboardingReadinessRow({
      area: 'member_invitation',
      check: 'Member invitation and acceptance create bounded invite records, accepted users, active memberships, seat accounting, and invite provenance.',
      evidence: [
        `${pendingInvites.length} pending invite(s), ${acceptedInvitesWithMembership.length}/${acceptedInvites.length} accepted invite(s) with membership provenance`,
        `${activeMemberships.length}+${pendingInvites.length}/${seatLimit ?? 'unlimited'} active+pending seats`,
        `${seatsAvailable ?? 'unlimited'} available seat(s)`,
      ],
      localOk: pendingInvites.every((invite) => invite.expiresAt && Date.parse(invite.expiresAt) > Date.parse(invite.createdAt)) &&
        (pendingInvites.length > 0 || acceptedInvites.length > 0) &&
        activeMemberships.length > 1 &&
        (seatsAvailable === null || seatsAvailable >= 0),
      productionOk: Boolean(durableState?.ok && productionAuth?.ok),
      recommendation: 'Use invite-only member creation for B2B workspaces; keep claim codes one-time and digest accepted codes after use.',
    }),
    onboardingReadinessRow({
      area: 'multi_user_org',
      check: 'Multi-user organizations are supported through tenant memberships, role, team, status, owner, billing owner, and seat limits.',
      evidence: [
        `${activeAdmins.length} active admin(s), ${activeMembers.length} active member(s)`,
        `${memberships.length} membership record(s) for ${tenant?.id ?? 'unknown tenant'}`,
        `${orphanMemberships.length} orphan membership record(s)`,
      ],
      localOk: Boolean(tenant && activeAdmins.length > 0 && activeMemberships.length > 1 && orphanMemberships.length === 0),
      productionOk: productionIsolationReady,
      recommendation: 'Multi-member orgs are the right SaaS model; production must enforce tenant isolation and managed auth before many customer orgs share one backend.',
    }),
    onboardingReadinessRow({
      area: 'rbac_controls',
      check: 'Admin/member permissions are resolved from active membership before workspace, source, billing, and admin mutations run.',
      evidence: [
        `actor ${actor?.id ?? 'none'} as ${actor?.role ?? 'unknown'}`,
        `${actorScope.visibleSignals.length}/${state.signals?.length ?? 0} visible signal rows for the active actor`,
        `${actorScope.visibleMailboxes.length}/${summary.mailboxes ?? 0} visible mailbox source rows for the active actor`,
      ],
      localOk: Boolean(actor && memberships.some((membership) => membership.userId === actor.id && membership.status === 'active')) && mailboxOwnershipOk && routingOwnershipOk,
      productionOk: productionIsolationReady,
      recommendation: 'Admins can see tenant-wide controls; members should keep owner/team-scoped signals, owned mailboxes, own notifications, and owned account work.',
    }),
    onboardingReadinessRow({
      area: 'data_privacy',
      check: 'Privacy posture keeps email-derived evidence tenant-isolated, owner/team scoped for members, retention-governed, and redaction-ready.',
      evidence: [
        tenantGovernance ? `${tenantGovernance.sourceRetentionDays} day source retention / ${tenantGovernance.rawSnippetRetentionDays} day raw snippets` : 'Missing governance policy',
        modelPolicy ? `${modelPolicy.detectorBoundary}, learning ${modelPolicy.learningMode}, per-org model ${modelPolicy.perTenantModel ? 'on' : 'off'}` : 'Missing model governance',
        `${usersWithPreferences.length}/${activeUsers.length} active users have notification preferences`,
      ],
      localOk: Boolean(tenantGovernance && modelPolicy?.dataBoundary === 'tenant_isolated' && modelPolicy?.perTenantModel === false && usersWithPreferences.length === activeUsers.length),
      productionOk: productionIsolationReady,
      recommendation: 'Do not give members unrestricted tenant email visibility; keep raw provider credentials and bodies outside app state.',
    }),
    onboardingReadinessRow({
      area: 'focus_and_notifications',
      check: 'Each user can carry focus controls for digest cadence, immediate alerts, mute rules, account ownership, and routed priorities.',
      evidence: [
        `${state.routingRules?.filter((rule) => rule.tenantId === tenant?.id && rule.status === 'active').length ?? 0} active routing rule(s)`,
        `${state.notificationPreferences?.filter((preference) => activeUsers.some((user) => user.id === preference.userId)).length ?? 0} notification preference record(s)`,
        `${state.accountRecommendations?.filter((recommendation) => recommendation.tenantId === tenant?.id && recommendation.status === 'open').length ?? 0} open recommendation(s)`,
      ],
      localOk: routingOwnershipOk && usersWithPreferences.length === activeUsers.length,
      productionOk: Boolean(productionAuth?.ok),
      recommendation: 'Support user-specific outcomes through routes, ownership, notification preferences, and mute rules rather than separate org models.',
    }),
    onboardingReadinessRow({
      area: 'admin_monitoring',
      check: 'Admins have CLI/API/UI control over workspace creation, invites, roles, disable/reactivate, privacy evidence, audit events, and session registry.',
      evidence: [
        `${summary.auditEvents} audit event(s)`,
        `${summary.apiSessions ?? 0} API session record(s)`,
        'CLI: tenants, users, session, readiness, onboarding-readiness',
      ],
      localOk: activeAdmins.length > 0,
      productionOk: Boolean(signedSession?.ok && productionAuth?.ok),
      recommendation: 'Keep admin/system operations separate from member workspace workflows and require signed admin sessions for API access.',
    }),
  ];
  const issues = rows
    .filter((row) => !row.localOk)
    .map((row) => `${row.area}: ${row.check}`);
  return {
    generatedAt: new Date().toISOString(),
    ok: issues.length === 0,
    productionReady: rows.every((row) => row.productionOk),
    actor: actor
      ? {
          id: actor.id,
          role: actor.role,
          team: actor.team ?? null,
          tenantId: actor.tenantId,
        }
      : null,
    backend: {
      mode: backend?.mode ?? (isHttpResource(statePath) ? 'external-service' : 'local-json'),
      productionReady: backend?.productionReady ?? false,
      tenantIsolationReady: Boolean(tenantIsolation?.ok),
      signedSessionReady: Boolean(signedSession?.ok),
      statePath,
    },
    issues,
    recommendation: {
      decision: 'support_multi_member_orgs',
      summary: 'Use multi-member organizations for the SaaS product, but make tenant membership the RBAC and privacy control plane.',
      productionGuardrail: 'Do not launch shared production multi-org data until durable storage, managed auth, signed sessions, and tenant isolation checks pass.',
      perTenantModelDefault: 'Use a shared detector/model boundary with tenant-specific thresholds, routing, suppression, feedback, retention, and notification preferences.',
    },
    roleMatrix: [
      {
        role: 'admin',
        dataAccess: 'Tenant-wide workspace, source, signal, billing, privacy, invite, and operations visibility.',
        allowedActions: ['create_workspace', 'invite_member', 'accept_invite', 'change_role', 'disable_member', 'manage_sources', 'manage_billing', 'manage_governance'],
        guardrails: ['signed_admin_session', 'audit_event', 'tenant_membership_required'],
      },
      {
        role: 'member',
        dataAccess: 'Owned mailbox sources, owned or team-routed signals, own notifications, assigned account actions, and visible relationship recommendations.',
        allowedActions: ['claim_invite', 'manage_own_source', 'update_own_notifications', 'route_owned_signal', 'complete_owned_action'],
        guardrails: ['active_membership_required', 'owner_or_team_scope', 'no_admin_routes', 'billing_gate_for_product_actions'],
      },
    ],
    rows,
    summary: {
      activeAdmins: activeAdmins.length,
      activeMembers: activeMembers.length,
      activeMemberships: activeMemberships.length,
      localReady: rows.filter((row) => row.localOk).length,
      pendingInvites: pendingInvites.length,
      productionReady: rows.filter((row) => row.productionOk).length,
      seatLimit,
      seatsAvailable,
      total: rows.length,
      visibleMailboxesForActor: actorScope.visibleMailboxes.length,
      visibleSignalsForActor: actorScope.visibleSignals.length,
    },
    tenant: tenant
      ? {
          id: tenant.id,
          name: tenant.name,
          domain: tenant.domain,
          status: tenant.status,
          ownerUserId: tenant.ownerUserId ?? null,
          billingOwnerUserId: tenant.billingOwnerUserId ?? null,
          registrationStatus: tenant.registrationStatus ?? null,
        }
      : null,
  };
}

function tenantIsolationAuditRow({
  area,
  check,
  evidence = [],
  localOk,
  productionOk,
  recommendation,
  requiredEnv = [],
  commands = [],
}) {
  return {
    area,
    check,
    evidence,
    localOk: Boolean(localOk),
    productionOk: Boolean(productionOk),
    recommendation,
    requiredEnv,
    commands,
    status: localOk ? (productionOk ? 'production_ready' : 'local_ready') : 'attention',
  };
}

export function tenantIsolationAuditReport(state, {
  backend = null,
  statePath = resolveStatePath(),
} = {}) {
  const summary = summarizeState(state, statePath);
  const tenantId = defaultTenantId(state);
  const tenant = (state.tenants ?? []).find((item) => item.id === tenantId) ?? state.tenants?.[0] ?? null;
  const actor = getActor(state, state.session?.activeUserId, { allowMissing: true });
  const scope = visibleDashboardScope(state, actor, tenant?.id ?? tenantId);
  const memberships = state.memberships ?? [];
  const tenantMemberships = memberships.filter((membership) => !tenant?.id || membership.tenantId === tenant.id);
  const activeMemberships = tenantMemberships.filter((membership) =>
    membership.status === 'active' &&
    (state.users ?? []).some((user) => user.id === membership.userId && user.status === 'active'));
  const activeAdmins = activeMemberships.filter((membership) => membership.role === 'admin');
  const activeMembers = activeMemberships.filter((membership) => membership.role === 'member');
  const orphanMemberships = memberships.filter((membership) =>
    !(state.users ?? []).some((user) => user.id === membership.userId) ||
    !(state.tenants ?? []).some((candidate) => candidate.id === membership.tenantId));
  const actorMembership = tenantMemberships.find((membership) => membership.userId === actor?.id && membership.status === 'active');
  const tenantUsers = (state.users ?? []).filter((user) => !tenant?.id || user.tenantId === tenant.id);
  const tenantOwnedUserIds = new Set(activeMemberships.map((membership) => membership.userId));
  const tenantMailboxes = (state.mailboxes ?? []).filter((mailbox) => !tenant?.id || mailbox.tenantId === tenant.id);
  const tenantSignals = (state.signals ?? []).filter((signal) => !tenant?.id || signal.tenantId === tenant.id);
  const tenantActions = (state.accountActions ?? []).filter((action) => !tenant?.id || action.tenantId === tenant.id);
  const tenantRecommendations = (state.accountRecommendations ?? []).filter((recommendation) => !tenant?.id || recommendation.tenantId === tenant.id);
  const tenantRoutingRules = (state.routingRules ?? []).filter((rule) => !tenant?.id || rule.tenantId === tenant.id);
  const tenantNotifications = (state.notificationEvents ?? []).filter((event) => !tenant?.id || event.tenantId === tenant.id);
  const tenantSources = (state.sourceMessages ?? []).filter((message) => !tenant?.id || message.tenantId === tenant.id);
  const visibleWithinTenant = scope.visibleSignals.length <= tenantSignals.length &&
    scope.visibleMailboxes.length <= tenantMailboxes.length &&
    scope.visibleSourceMessages.length <= tenantSources.length &&
    scope.visibleNotifications.length <= tenantNotifications.length;
  const ownsOrRoutesOk = [
    ...tenantMailboxes.map((mailbox) => mailbox.ownerUserId),
    ...tenantSignals.map((signal) => signal.ownerUserId),
    ...tenantActions.map((action) => action.ownerUserId),
    ...tenantRecommendations.map((recommendation) => recommendation.ownerUserId),
    ...tenantRoutingRules.map((rule) => rule.ownerUserId).filter(Boolean),
  ].every((userId) => tenantOwnedUserIds.has(userId));
  const mutationAuditActions = new Set((state.auditEvents ?? [])
    .filter((event) => !tenant?.id || event.tenantId === tenant.id)
    .map((event) => event.action));
  const adminMutationEvidence = [
    'tenants.create',
    'tenants.register',
    'users.invite',
    'users.role',
    'payments.override',
  ].filter((action) => mutationAuditActions.has(action));
  const backendChecks = backend?.checks ?? [];
  const backendCheck = (id) => backendChecks.find((check) => check.id === id);
  const tenantIsolation = backendCheck('tenant_isolation');
  const signedSession = backendCheck('signed_session_enforced');
  const productionAuth = backendCheck('production_auth_provider');
  const durableState = backendCheck('durable_state');
  const durableStateService = backendCheck('state_service_storage');
  const backendBoundary = {
    mode: backend?.mode ?? (isHttpResource(statePath) ? 'external-service' : 'local-json'),
    productionReady: backend?.productionReady ?? false,
    tenantIsolationReady: Boolean(tenantIsolation?.ok),
    signedSessionReady: Boolean(signedSession?.ok),
    productionAuthReady: Boolean(productionAuth?.ok),
    durableStateReady: Boolean(durableState?.ok || durableStateService?.ok),
    statePath,
  };
  const productionIsolationReady = backendBoundary.tenantIsolationReady &&
    backendBoundary.signedSessionReady &&
    backendBoundary.productionAuthReady &&
    backendBoundary.durableStateReady;
  const rows = [
    tenantIsolationAuditRow({
      area: 'tenant_membership_boundary',
      check: 'Every user-visible workspace object resolves through tenant membership, active status, and tenant references.',
      evidence: [
        `${tenantUsers.length} tenant user(s), ${tenantMemberships.length} tenant membership record(s)`,
        `${activeAdmins.length} active admin(s), ${activeMembers.length} active member(s)`,
        `${orphanMemberships.length} orphan membership record(s)`,
        `actor membership ${actorMembership ? actorMembership.role : 'missing'}`,
      ],
      localOk: Boolean(tenant?.id && actorMembership && activeAdmins.length > 0 && orphanMemberships.length === 0),
      productionOk: productionIsolationReady,
      recommendation: 'Keep multi-user organizations; tenant membership is the user, role, and privacy boundary.',
      commands: ['npm run admin -- tenant-isolation --json', 'npm run admin -- users --json'],
    }),
    tenantIsolationAuditRow({
      area: 'actor_scoped_visibility',
      check: 'User workspace signals, mailboxes, source snippets, and notifications are derived from actor-scoped visibility helpers.',
      evidence: [
        `${scope.visibleSignals.length}/${tenantSignals.length} visible signal row(s)`,
        `${scope.visibleMailboxes.length}/${tenantMailboxes.length} visible mailbox row(s)`,
        `${scope.visibleSourceMessages.length}/${tenantSources.length} visible source snippet(s)`,
        `${scope.visibleNotifications.length}/${tenantNotifications.length} visible notification(s)`,
      ],
      localOk: Boolean(actorMembership) && visibleWithinTenant,
      productionOk: productionIsolationReady,
      recommendation: 'Members should see owned/team-routed work and own notifications; admins can see tenant-wide operations.',
      commands: ['npm run admin -- dashboard-audit --json', 'curl http://127.0.0.1:8787/api/dashboard-audit'],
    }),
    tenantIsolationAuditRow({
      area: 'owner_team_routing',
      check: 'Mailboxes, routed signals, account actions, recommendations, and routing rules point to active members in the same tenant.',
      evidence: [
        `${tenantMailboxes.length} mailbox owner assignment(s)`,
        `${tenantSignals.length} signal owner/team route(s)`,
        `${tenantActions.length} account action owner assignment(s)`,
        `${tenantRecommendations.length} recommendation owner assignment(s)`,
      ],
      localOk: ownsOrRoutesOk,
      productionOk: productionIsolationReady,
      recommendation: 'Use owner and team routing to personalize outcomes instead of splitting each member into a separate organization.',
      commands: ['npm run admin -- signals --json', 'npm run admin -- accounts --json'],
    }),
    tenantIsolationAuditRow({
      area: 'admin_mutation_gates',
      check: 'Admin mutations are auditable and require admin membership or self-service registration entrypoints before state changes.',
      evidence: [
        `${adminMutationEvidence.length} admin/self-service mutation action(s) observed: ${adminMutationEvidence.join(', ') || 'none'}`,
        `${summary.apiSessions ?? 0} API session record(s)`,
        `${summary.auditEvents ?? 0} audit event(s)`,
      ],
      localOk: activeAdmins.length > 0 && Boolean(actorMembership) && actorMembership.role === 'admin',
      productionOk: Boolean(signedSession?.ok && productionAuth?.ok),
      recommendation: 'Keep admin setup, role changes, billing overrides, and source controls behind signed admin sessions; keep registration as the only public workspace creation path.',
      commands: ['npm run admin -- session list --json', 'npm run admin -- export --json'],
    }),
    tenantIsolationAuditRow({
      area: 'production_auth_claims',
      check: 'Production API requests must carry managed identity, signed sessions, and org/member claims that map to active membership.',
      evidence: [
        signedSession?.message ?? 'Signed session check missing',
        productionAuth?.message ?? 'Production auth provider check missing',
      ],
      localOk: true,
      productionOk: Boolean(signedSession?.ok && productionAuth?.ok),
      recommendation: 'Map provider identity claims to tenant membership on every request and fail closed when membership is missing or inactive.',
      requiredEnv: ['SIGNAL_SESSION_SECRET', 'SIGNAL_AUTH_PROVIDER', 'SIGNAL_AUTH_JWKS_URL'],
      commands: ['npm run admin -- backend --env-file ./.env.production --json'],
    }),
    tenantIsolationAuditRow({
      area: 'production_rls_policy',
      check: 'Production storage must enforce tenant isolation through database policy, RLS, or an equivalent state-service authorization layer.',
      evidence: [
        tenantIsolation?.message ?? 'Tenant isolation backend check missing',
        `backend mode ${backendBoundary.mode}`,
      ],
      localOk: true,
      productionOk: Boolean(tenantIsolation?.ok),
      recommendation: 'Do not run multiple customer organizations on shared production storage until the tenant isolation backend check is green.',
      requiredEnv: ['SIGNAL_TENANT_ISOLATION_MODE', 'SIGNAL_STATE_SERVICE_URL', 'DATABASE_URL'],
      commands: ['npm run admin -- backend --env-file ./.env.production --json', 'npm run admin -- production-plan --json'],
    }),
    tenantIsolationAuditRow({
      area: 'durable_state_boundary',
      check: 'Production data must use durable storage/state-service health, backup, restore, and migration evidence instead of local JSON.',
      evidence: [
        durableState?.message ?? 'Durable state check missing',
        durableStateService?.message ?? 'State-service storage check missing',
        `state path ${statePath}`,
      ],
      localOk: true,
      productionOk: backendBoundary.durableStateReady,
      recommendation: 'Local JSON is acceptable for the local agent; production needs durable tenant-isolated state and backup/restore proof.',
      requiredEnv: ['SIGNAL_STATE_BACKEND', 'SIGNAL_STATE_SERVICE_URL', 'DATABASE_URL', 'SIGNAL_STATE_BACKUP_POLICY'],
      commands: ['npm run admin -- production-drill --env-file ./.env.production --json'],
    }),
  ];
  const issues = rows
    .filter((row) => !row.localOk)
    .map((row) => `${row.area}: ${row.check}`);
  return {
    generatedAt: new Date().toISOString(),
    ok: issues.length === 0,
    productionReady: rows.every((row) => row.productionOk),
    actor: scope.actor,
    backend: backendBoundary,
    issues,
    recommendation: {
      decision: 'support_multi_member_orgs',
      summary: 'The SaaS should keep multi-member organizations because tenant membership, role, owner, and team routing can support per-user focus while preserving one workspace.',
      productionGuardrail: 'Production tenant isolation still needs durable backend, managed auth, signed sessions, and policy/RLS evidence before multiple customer orgs share infrastructure.',
      memberPrivacyDefault: 'Members should default to owned mailbox sources, owned/team-routed signals, own notifications, and assigned account work; admins keep tenant-wide operations visibility.',
    },
    roleMatrix: [
      {
        role: 'admin',
        dataAccess: 'Tenant-wide workspace, source, signal, billing, privacy, invite, API session, and operations visibility.',
        allowedActions: ['invite_member', 'change_role', 'disable_member', 'manage_sources', 'manage_billing', 'manage_governance', 'view_audits'],
        guardrails: ['signed_admin_session', 'active_admin_membership', 'audit_event', 'tenant_policy_enforced'],
      },
      {
        role: 'member',
        dataAccess: 'Owned mailbox sources, owned or team-routed signals, own notifications, assigned account actions, and visible recommendations.',
        allowedActions: ['claim_invite', 'manage_own_source', 'update_own_notifications', 'complete_owned_action', 'send_signal_feedback'],
        guardrails: ['active_membership_required', 'owner_or_team_scope', 'no_admin_routes', 'tenant_policy_enforced'],
      },
    ],
    rows,
    summary: {
      activeAdmins: activeAdmins.length,
      activeMembers: activeMembers.length,
      actorScopedRows: rows.filter((row) => row.area === 'actor_scoped_visibility').length,
      localReady: rows.filter((row) => row.localOk).length,
      orphanMemberships: orphanMemberships.length,
      productionReady: rows.filter((row) => row.productionOk).length,
      total: rows.length,
      visibleMailboxesForActor: scope.visibleMailboxes.length,
      visibleSignalsForActor: scope.visibleSignals.length,
    },
    tenant: tenant
      ? {
          id: tenant.id,
          name: tenant.name,
          domain: tenant.domain,
          status: tenant.status,
          ownerUserId: tenant.ownerUserId ?? null,
          billingOwnerUserId: tenant.billingOwnerUserId ?? null,
          registrationStatus: tenant.registrationStatus ?? null,
        }
      : null,
  };
}

const operationsWebhookCatalog = [
  {
    channel: 'gmail',
    label: 'Gmail provider watch',
    path: '/api/webhooks/gmail',
    provider: 'gmail',
  },
  {
    channel: 'outlook',
    label: 'Outlook provider watch',
    path: '/api/webhooks/outlook',
    provider: 'outlook',
  },
  {
    channel: 'outbound_email',
    label: 'Outbound email status',
    path: '/api/webhooks/email',
  },
  {
    channel: 'stripe',
    label: 'Stripe billing event',
    path: '/api/webhooks/stripe',
  },
];

const operationsQueues = [
  'email_sync',
  'signal_detection',
  'notification_digest',
  'outbound_email',
  'billing_webhook',
  'provider_validation',
  'signal_handoff',
  'user_onboarding',
  'governance',
];

function latestIso(items, fields) {
  return items
    .flatMap((item) => fields.map((field) => item?.[field]))
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort()
    .at(-1) ?? null;
}

function countStatuses(items) {
  return items.reduce((counts, item) => {
    const status = item?.status ?? 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
}

function webhookHealthRows(state) {
  const watches = state.emailWatchSubscriptions ?? [];
  const deliveries = state.emailDeliveryMessages ?? [];
  const paymentEvents = state.paymentEvents ?? [];
  const jobs = state.jobs ?? [];
  return operationsWebhookCatalog.map((item) => {
    if (item.channel === 'gmail' || item.channel === 'outlook') {
      const providerWatches = watches.filter((watch) => watch.provider === item.provider);
      const activeWatches = providerWatches.filter((watch) => watch.status === 'active');
      const failedWatches = providerWatches.filter((watch) => watch.status === 'failed');
      const backoffWatches = providerWatches.filter((watch) =>
        Number.isFinite(Date.parse(watch.providerRetryAfterAt ?? watch.providerBackoffUntil)) &&
        Date.parse(watch.providerRetryAfterAt ?? watch.providerBackoffUntil) > Date.now());
      const status = backoffWatches.length ? 'backoff' : failedWatches.length ? 'attention' : activeWatches.length ? 'ready' : providerWatches.length ? 'watch' : 'not_configured';
      return {
        channel: item.channel,
        evidence: [
          `${activeWatches.length}/${providerWatches.length} active watch subscription(s)`,
          `${providerWatches.reduce((total, watch) => total + (watch.notificationCount ?? 0), 0)} provider notification(s)`,
          `${failedWatches.length} failed watch subscription(s)`,
        ],
        label: item.label,
        latestAt: latestIso(providerWatches, ['lastNotificationAt', 'updatedAt', 'setupAt', 'createdAt']),
        localOk: failedWatches.length === 0 && backoffWatches.length === 0,
        path: item.path,
        status,
      };
    }

    if (item.channel === 'outbound_email') {
      const statuses = countStatuses(deliveries);
      const failed = (statuses.failed ?? 0) + (statuses.bounced ?? 0);
      const queued = statuses.queued ?? 0;
      return {
        channel: item.channel,
        evidence: [
          `${deliveries.length} delivery ledger record(s)`,
          `${queued} queued, ${statuses.sent ?? 0} sent, ${failed} failed or bounced, ${statuses.suppressed ?? 0} suppressed`,
          `${jobs.filter((job) => job.queue === 'outbound_email').length} outbound_email worker job(s)`,
        ],
        label: item.label,
        latestAt: latestIso(deliveries, ['providerStatusUpdatedAt', 'sentAt', 'createdAt']),
        localOk: failed === 0,
        path: item.path,
        status: failed ? 'attention' : queued ? 'queued' : deliveries.length ? 'ready' : 'idle',
      };
    }

    const billingJobs = jobs.filter((job) => job.queue === 'billing_webhook');
    const failedBillingJobs = billingJobs.filter((job) => job.status === 'failed');
    const signedEvents = paymentEvents.filter((event) => event.signatureStatus === 'verified');
    return {
      channel: item.channel,
      evidence: [
        `${paymentEvents.length} payment event(s)`,
        `${signedEvents.length} signed provider event(s)`,
        `${failedBillingJobs.length}/${billingJobs.length} failed billing_webhook job(s)`,
      ],
      label: item.label,
      latestAt: latestIso([...paymentEvents, ...billingJobs], ['signatureVerifiedAt', 'createdAt', 'lastRunAt']),
      localOk: paymentEvents.length > 0 && failedBillingJobs.length === 0,
      path: item.path,
      status: failedBillingJobs.length ? 'attention' : paymentEvents.length ? 'ready' : 'idle',
    };
  });
}

function queueHealthRows(state) {
  return operationsQueues.map((queue) => {
    const jobs = (state.jobs ?? []).filter((job) => job.queue === queue);
    const statuses = countStatuses(jobs);
    const failed = statuses.failed ?? 0;
    const queued = statuses.queued ?? 0;
    const running = statuses.running ?? 0;
    return {
      queue,
      drained: statuses.drained ?? 0,
      failed,
      latestAt: latestIso(jobs, ['lastRunAt', 'nextRunAt']),
      localOk: failed === 0,
      queued,
      running,
      status: failed ? 'attention' : running ? 'running' : queued ? 'queued' : jobs.length ? 'ready' : 'idle',
      succeeded: statuses.succeeded ?? 0,
      total: jobs.length,
    };
  });
}

function providerBackoffRows(state) {
  const now = Date.now();
  const cursorRows = (state.emailSyncCursors ?? [])
    .filter((cursor) => cursor.providerBackoffUntil || cursor.providerLastErrorAt || (cursor.providerResponseStatus ?? 0) >= 400)
    .map((cursor) => {
      const backoffUntilMs = Date.parse(cursor.providerBackoffUntil ?? '');
      const active = Number.isFinite(backoffUntilMs) && backoffUntilMs > now;
      return {
        active,
        kind: 'sync_cursor',
        provider: cursor.provider,
        reason: cursor.providerBackoffReason ?? cursor.providerLastErrorAt ?? 'provider_response_observed',
        responseStatus: cursor.providerResponseStatus ?? null,
        retryAfterAt: cursor.providerBackoffUntil ?? null,
        status: active ? 'active_backoff' : cursor.providerLastErrorAt ? 'recent_error' : 'observed',
        targetId: cursor.mailboxId,
      };
    });
  const watchRows = (state.emailWatchSubscriptions ?? [])
    .filter((watch) => watch.providerRetryAfterAt || watch.providerBackoffReason || watch.providerLastErrorAt || (watch.providerResponseStatus ?? 0) >= 400)
    .map((watch) => {
      const retryAfterMs = Date.parse(watch.providerRetryAfterAt ?? '');
      const active = Number.isFinite(retryAfterMs) && retryAfterMs > now;
      return {
        active,
        kind: 'provider_watch',
        provider: watch.provider,
        reason: watch.providerBackoffReason ?? watch.providerLastErrorCode ?? watch.providerLastErrorAt ?? 'provider_response_observed',
        responseStatus: watch.providerResponseStatus ?? null,
        retryAfterAt: watch.providerRetryAfterAt ?? null,
        status: active ? 'active_backoff' : watch.providerLastErrorAt ? 'recent_error' : 'observed',
        targetId: watch.id,
      };
    });
  const jobRows = (state.jobs ?? [])
    .filter((job) => job.providerRetryAfterAt || job.providerErrorCode || (job.providerResponseStatus ?? 0) >= 400)
    .map((job) => {
      const retryAfterMs = Date.parse(job.providerRetryAfterAt ?? '');
      const active = Number.isFinite(retryAfterMs) && retryAfterMs > now;
      return {
        active,
        kind: 'worker_job',
        provider: job.queue,
        reason: job.providerErrorCode ?? job.message ?? 'provider_response_observed',
        responseStatus: job.providerResponseStatus ?? null,
        retryAfterAt: job.providerRetryAfterAt ?? null,
        status: active ? 'active_backoff' : job.providerErrorCode ? 'recent_error' : 'observed',
        targetId: job.id,
      };
    });
  return [...cursorRows, ...watchRows, ...jobRows].sort((left, right) =>
    Number(right.active) - Number(left.active) ||
    String(right.retryAfterAt ?? '').localeCompare(String(left.retryAfterAt ?? '')));
}

function lifecycleHealth(state) {
  const notices = [...(state.lifecycleNotices ?? [])].sort((left, right) =>
    String(right.updatedAt ?? right.createdAt ?? '').localeCompare(String(left.updatedAt ?? left.createdAt ?? '')));
  const categories = ['source', 'provider', 'notification', 'payment', 'access', 'onboarding'];
  return {
    categories: categories.map((category) => {
      const categoryNotices = notices.filter((notice) => notice.category === category);
      const open = categoryNotices.filter((notice) => notice.status === 'open');
      const critical = open.filter((notice) => notice.severity === 'critical');
      return {
        category,
        critical: critical.length,
        latestAt: latestIso(categoryNotices, ['updatedAt', 'createdAt']),
        localOk: critical.length === 0,
        open: open.length,
        status: critical.length ? 'attention' : open.length ? 'watch' : categoryNotices.length ? 'ready' : 'idle',
        total: categoryNotices.length,
      };
    }),
    latest: notices.slice(0, 8).map((notice) => ({
      actionLabel: notice.actionLabel ?? null,
      category: notice.category,
      id: notice.id,
      severity: notice.severity,
      status: notice.status,
      title: notice.title,
      trigger: notice.trigger,
      updatedAt: notice.updatedAt ?? notice.createdAt ?? null,
    })),
  };
}

export function operationsHealthReport(state, {
  backend = null,
  statePath = resolveStatePath(),
} = {}) {
  const summary = summarizeState(state, statePath);
  const backendBoundary = {
    mode: backend?.mode ?? (isHttpResource(statePath) ? 'external-service' : 'local-json'),
    productionReady: backend?.productionReady ?? false,
    schedulerReady: Boolean(backend?.checks?.find?.((check) => check.id === 'job_scheduler')?.ok),
    statePath,
  };
  const webhooks = webhookHealthRows(state);
  const queues = queueHealthRows(state);
  const rateLimits = providerBackoffRows(state);
  const lifecycle = lifecycleHealth(state);
  const blockingQueues = new Set(['billing_webhook', 'outbound_email']);
  const failedQueues = queues.filter((queue) => queue.failed > 0 && blockingQueues.has(queue.queue));
  const failedDeliveries = (state.emailDeliveryMessages ?? []).filter((message) => ['failed', 'bounced'].includes(message.status));
  const activeBackoffs = rateLimits.filter((row) => row.active);
  const blockingLifecycleCategories = new Set(['payment', 'access']);
  const criticalLifecycle = lifecycle.categories.filter((category) => category.critical > 0 && blockingLifecycleCategories.has(category.category));
  const issues = [
    ...webhooks.filter((row) => !row.localOk).map((row) => `${row.channel}: ${row.label} is ${row.status}`),
    ...failedQueues.map((row) => `${row.queue}: ${row.failed} failed job(s)`),
    ...failedDeliveries.map((message) => `outbound_email: ${message.id} is ${message.status}`),
    ...activeBackoffs.map((row) => `${row.kind}:${row.targetId} backoff until ${row.retryAfterAt}`),
    ...criticalLifecycle.map((row) => `${row.category}: ${row.critical} critical open lifecycle notice(s)`),
  ];
  return {
    generatedAt: new Date().toISOString(),
    ok: issues.length === 0,
    productionReady: Boolean(backendBoundary.productionReady && backendBoundary.schedulerReady),
    backend: backendBoundary,
    issues,
    lifecycle,
    queues,
    rateLimits,
    recommendation: {
      summary: 'Use operations-health before launch and after provider incidents to reconcile webhook channels, provider backoff, worker queues, lifecycle notices, outbound email, and billing events from one state boundary.',
      productionGuardrail: 'Production still needs managed scheduler/observability, alert routing, durable tenant-isolated state, signed webhook evidence, and live provider sandbox evidence before this can be treated as production monitoring.',
      localAgentCommand: 'npm run admin -- operations-health --json',
    },
    summary: {
      activeBackoffs: activeBackoffs.length,
      criticalLifecycle: criticalLifecycle.reduce((total, row) => total + row.critical, 0),
      failedDeliveries: failedDeliveries.length,
      failedQueues: failedQueues.length,
      failedJobs: summary.failedJobs ?? 0,
      monitoredQueues: queues.length,
      openLifecycle: summary.openLifecycleNotices ?? 0,
      productionReady: Boolean(backendBoundary.productionReady && backendBoundary.schedulerReady),
      totalWebhooks: webhooks.length,
      unhealthyWebhooks: webhooks.filter((row) => !row.localOk).length,
    },
    webhooks,
  };
}

export function formatStatus(summary) {
  return [
    'Signal local admin status',
    '',
    `State: ${summary.statePath}`,
    `Environment: ${summary.environment}`,
    `Tenants: ${summary.tenants}`,
    `Tenant status: ${summary.tenantStatus ?? 'unknown'} (${summary.suspendedTenants} suspended)`,
    `Users: ${summary.users} (${summary.admins} active admin)`,
    `Memberships: ${summary.activeMemberships}/${summary.memberships} active`,
    `Invites: ${summary.pendingInvites}/${summary.invites} pending`,
    `Seats: ${summary.activeSeats}+${summary.pendingInviteSeats}/${summary.seatLimit ?? 'unlimited'} active+pending`,
    `Mailboxes: ${summary.connectedMailboxes}/${summary.mailboxes} connected`,
    `Connection sessions: ${summary.mailboxConnectionSessions}`,
    `Sync cursors: ${summary.activeSyncCursors} active, ${summary.blockedSyncCursors} blocked`,
    `Provider watches: ${summary.activeEmailWatchSubscriptions}/${summary.emailWatchSubscriptions} active, ${summary.expiringEmailWatchSubscriptions} expiring soon`,
    `Email flows: ${summary.enabledEmailFlows}/${summary.emailFlows} enabled`,
    `Routing rules: ${summary.activeRoutingRules}/${summary.routingRules} active`,
    `Source messages: ${summary.sourceMessages}`,
    `Flow runs: ${summary.flowRuns}`,
    `Generated signals: ${summary.generatedSignals}`,
    `Open signals: ${summary.openSignals}`,
    `Signal handoffs: ${summary.queuedSignalHandoffs}/${summary.signalHandoffs} queued`,
    `Accounts: ${summary.accounts} (${summary.atRiskAccounts} at risk)`,
    `Account actions: ${summary.openAccountActions} open`,
    `Account reviews: ${summary.accountReviews}`,
    `Account recommendations: ${summary.openAccountRecommendations}/${summary.accountRecommendations} open`,
    `Notifications: ${summary.unreadNotifications}/${summary.notificationEvents} unread`,
    `Digest runs: ${summary.digestRuns}`,
    `Email delivery: ${summary.queuedEmailDeliveries}/${summary.emailDeliveries} queued, ${summary.failedEmailDeliveries} failed, ${summary.unsubscribedUsers} unsubscribed`,
    `Quality rules: ${summary.activeSuppressionRules}/${summary.suppressionRules} active suppression, ${summary.signalFeedback} feedback labels`,
    `Model governance: ${summary.modelGovernancePolicies} policies, ${summary.perTenantModels} per-tenant models enabled`,
    `Governance: ${summary.activeRedactionRules} active redaction, ${summary.openDataRequests} open data requests, ${summary.openIncidentNotes} open incidents`,
    `Subscriptions: ${summary.subscriptions}`,
    `Invoices: ${summary.openInvoices}/${summary.invoices} open`,
    `Billing overrides: ${summary.activeBillingOverrides}/${summary.billingOverrides} active`,
    `Payment events: ${summary.paymentEvents}`,
    `Billing sessions: ${summary.billingSessions}`,
    `Lifecycle notices: ${summary.openLifecycleNotices}/${summary.lifecycleNotices} open`,
    `Jobs: ${summary.jobs} (${summary.failedJobs} failed)`,
    `API sessions: ${summary.activeApiSessions}/${summary.apiSessions} active`,
    `Provider validation runs: ${summary.providerValidationRuns} (${summary.latestProviderValidationStatus ?? 'not run'})`,
    `Provider validation schedules: ${summary.activeProviderValidationSchedules}/${summary.providerValidationSchedules} active, ${summary.dueProviderValidationSchedules} due`,
    `Active entitlements: ${summary.activeEntitlements}`,
    `Audit events: ${summary.auditEvents}`,
  ].join('\n');
}

export const providerRequirementCatalog = [
  {
    id: 'session',
    label: 'Signed Session Boundary',
    category: 'auth',
    provider: 'signal',
    requiredEnv: ['SIGNAL_SESSION_SECRET'],
    optionalEnv: ['SIGNAL_REQUIRE_SIGNED_SESSION', 'SIGNAL_SESSION_AUDIENCE', 'SIGNAL_SESSION_ISSUER', 'SIGNAL_SESSION_TTL_SECONDS'],
    callbackPath: '/api/session',
    webhookPath: '/api/session/token',
    boundary: 'Signed local API bearer sessions, optional raw actor lockout, and server-verified actor claims.',
  },
  {
    id: 'gmail',
    label: 'Gmail OAuth',
    category: 'email',
    provider: 'gmail',
    requiredEnv: ['SIGNAL_GMAIL_CLIENT_ID', 'SIGNAL_GMAIL_CLIENT_SECRET', 'SIGNAL_GMAIL_REDIRECT_URI', 'SIGNAL_TOKEN_ENCRYPTION_KEY'],
    optionalEnv: ['SIGNAL_API_BASE_URL', 'SIGNAL_GMAIL_PUBSUB_TOPIC', 'SIGNAL_GMAIL_NOTIFICATION_URL', 'SIGNAL_GMAIL_WEBHOOK_AUDIENCE', 'SIGNAL_OAUTH_STATE_KEY', 'SIGNAL_TOKEN_VAULT'],
    callbackPath: '/api/oauth/gmail/callback',
    webhookPath: '/api/webhooks/gmail',
    boundary: 'OAuth connection, label-scoped sync, history cursor replay, and Pub/Sub push notifications.',
  },
  {
    id: 'outlook',
    label: 'Microsoft Graph OAuth',
    category: 'email',
    provider: 'outlook',
    requiredEnv: ['SIGNAL_OUTLOOK_CLIENT_ID', 'SIGNAL_OUTLOOK_CLIENT_SECRET', 'SIGNAL_OUTLOOK_TENANT_ID', 'SIGNAL_OUTLOOK_REDIRECT_URI', 'SIGNAL_TOKEN_ENCRYPTION_KEY'],
    optionalEnv: ['SIGNAL_API_BASE_URL', 'SIGNAL_OAUTH_STATE_KEY', 'SIGNAL_OUTLOOK_NOTIFICATION_URL', 'SIGNAL_OUTLOOK_LIFECYCLE_NOTIFICATION_URL', 'SIGNAL_OUTLOOK_SUBSCRIPTION_RESOURCE', 'SIGNAL_OUTLOOK_WEBHOOK_CLIENT_STATE', 'SIGNAL_TOKEN_VAULT'],
    callbackPath: '/api/oauth/outlook/callback',
    webhookPath: '/api/webhooks/outlook',
    boundary: 'Graph OAuth connection, folder-scoped sync, delta cursor replay, and subscription notifications.',
  },
  {
    id: 'outbound-email',
    label: 'Outbound Email Provider',
    category: 'email',
    provider: 'email_delivery',
    requiredEnv: ['SIGNAL_EMAIL_PROVIDER_URL', 'SIGNAL_EMAIL_PROVIDER_TOKEN', 'SIGNAL_EMAIL_FROM', 'SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET'],
    optionalEnv: ['SIGNAL_EMAIL_PROVIDER', 'SIGNAL_EMAIL_PROVIDER_MODE', 'SIGNAL_EMAIL_PROVIDER_NAME', 'SIGNAL_EMAIL_UNSUBSCRIBE_BASE_URL', 'SIGNAL_SENDGRID_API_BASE_URL', 'SIGNAL_SENDGRID_API_KEY', 'SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY', 'SIGNAL_SENDGRID_SANDBOX_MODE', 'SIGNAL_SENDGRID_ASM_GROUP_ID', 'SIGNAL_SENDGRID_ASM_GROUPS_TO_DISPLAY', 'SIGNAL_SENDGRID_CATEGORIES', 'SIGNAL_SENDGRID_CLICK_TRACKING', 'SIGNAL_SENDGRID_OPEN_TRACKING', 'SIGNAL_SENDGRID_IP_POOL_NAME', 'SIGNAL_SENDGRID_REPLY_TO'],
    callbackPath: '/api/email/unsubscribe/:code',
    webhookPath: '/api/webhooks/email',
    boundary: 'Provider-backed digest delivery, signed status webhooks, unsubscribe suppression, and delivery reconciliation.',
  },
  {
    id: 'stripe',
    label: 'Stripe Billing',
    category: 'payment',
    provider: 'stripe',
    requiredEnv: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SIGNAL_STRIPE_PRICE_TEAM'],
    optionalEnv: ['STRIPE_PUBLISHABLE_KEY', 'SIGNAL_APP_BASE_URL', 'SIGNAL_STRIPE_ALLOW_PROMOTION_CODES', 'SIGNAL_STRIPE_CANCEL_URL', 'SIGNAL_STRIPE_PORTAL_RETURN_URL', 'SIGNAL_STRIPE_PRICE_BETA', 'SIGNAL_STRIPE_PRICE_BUSINESS', 'SIGNAL_STRIPE_SUCCESS_URL'],
    callbackPath: '/api/billing/return',
    webhookPath: '/api/webhooks/stripe',
    boundary: 'Live Checkout sessions, Billing Portal handoffs, signed webhooks, subscription source of truth, and entitlement updates.',
  },
];

function envStatus(env, keys) {
  return keys.map((key) => ({
    key,
    configured: Boolean(env[key]),
  }));
}

export function providerReadiness(env = process.env) {
  const providers = providerRequirementCatalog.map((requirement) => {
    const required = envStatus(env, requirement.requiredEnv);
    const optional = envStatus(env, requirement.optionalEnv);
    const missingRequired = required.filter((item) => !item.configured).map((item) => item.key);
    const configuredRequired = required.filter((item) => item.configured).map((item) => item.key);
    const configuredOptional = optional.filter((item) => item.configured).map((item) => item.key);
    return {
      ...requirement,
      configuredRequired,
      configuredOptional,
      missingRequired,
      required,
      optional,
      ready: missingRequired.length === 0,
    };
  });

  return {
    ok: providers.every((provider) => provider.ready),
    localOnly: true,
    providers,
    summary: {
      readyProviders: providers.filter((provider) => provider.ready).length,
      totalProviders: providers.length,
      missingRequired: providers.reduce((count, provider) => count + provider.missingRequired.length, 0),
    },
  };
}

const providerValidationCadences = ['daily', 'weekly', 'manual'];
const providerValidationScheduleStatuses = ['active', 'paused'];
const scheduledProviderIds = ['gmail', 'outlook', 'outbound-email', 'stripe'];

function scheduleAnchorIso(state) {
  return state.meta?.bootstrappedAt ?? state.meta?.updatedAt ?? nowIso();
}

function addCadenceIntervalIso(anchor, cadence) {
  if (cadence === 'manual') {
    return null;
  }
  const anchorMs = Date.parse(anchor ?? '');
  const baseMs = Number.isFinite(anchorMs) ? anchorMs : Date.now();
  const days = cadence === 'weekly' ? 7 : 1;
  return new Date(baseMs + days * 24 * 60 * 60 * 1000).toISOString();
}

function defaultProviderValidationCadence(providerId) {
  return providerId === 'outbound-email' ? 'weekly' : 'daily';
}

function providerValidationScheduleFromRequirement(requirement, state) {
  const cadence = defaultProviderValidationCadence(requirement.id);
  const requiredEnv = requirement.id === 'outbound-email'
    ? [...new Set([...requirement.requiredEnv, 'SIGNAL_SENDGRID_API_KEY'])]
    : requirement.requiredEnv;
  return {
    id: `pvs_${requirement.id.replace(/[^a-z0-9]+/gi, '_')}`,
    providerId: requirement.id,
    providerLabel: requirement.id === 'outbound-email' ? 'SendGrid / Outbound Email Provider' : requirement.label,
    category: requirement.category,
    cadence,
    status: 'active',
    requiredEnv,
    lastRunAt: null,
    lastRunId: null,
    lastRunStatus: null,
    nextRunAt: addCadenceIntervalIso(scheduleAnchorIso(state), cadence),
    createdAt: scheduleAnchorIso(state),
    createdByUserId: state.session?.activeUserId ?? null,
    updatedAt: null,
    updatedByUserId: null,
  };
}

function defaultProviderValidationSchedules(state) {
  return providerRequirementCatalog
    .filter((requirement) => scheduledProviderIds.includes(requirement.id))
    .map((requirement) => providerValidationScheduleFromRequirement(requirement, state));
}

function scheduleProviderIdForSandboxProvider(providerId) {
  return providerId === 'sendgrid' ? 'outbound-email' : providerId;
}

function normalizeProviderValidationSchedule(schedule, state) {
  const requirement = providerRequirementCatalog.find((candidate) => candidate.id === schedule.providerId);
  const cadence = providerValidationCadences.includes(schedule.cadence) ? schedule.cadence : defaultProviderValidationCadence(schedule.providerId);
  const status = providerValidationScheduleStatuses.includes(schedule.status) ? schedule.status : 'active';
  schedule.providerLabel = schedule.providerId === 'outbound-email' ? 'SendGrid / Outbound Email Provider' : schedule.providerLabel ?? requirement?.label ?? schedule.providerId;
  schedule.category = ['email', 'payment'].includes(schedule.category) ? schedule.category : requirement?.category ?? 'email';
  schedule.cadence = cadence;
  schedule.status = status;
  schedule.requiredEnv = Array.isArray(schedule.requiredEnv) ? schedule.requiredEnv.map((item) => String(item)) : requirement?.requiredEnv ?? [];
  if (schedule.providerId === 'outbound-email' && !schedule.requiredEnv.includes('SIGNAL_SENDGRID_API_KEY')) {
    schedule.requiredEnv.push('SIGNAL_SENDGRID_API_KEY');
  }
  schedule.createdAt = schedule.createdAt ?? scheduleAnchorIso(state);
  schedule.createdByUserId = schedule.createdByUserId ?? state.session?.activeUserId ?? null;
  schedule.lastRunAt = schedule.lastRunAt ?? null;
  schedule.lastRunId = schedule.lastRunId ?? null;
  schedule.lastRunStatus = schedule.lastRunStatus ?? null;
  schedule.nextRunAt = status === 'active' ? (schedule.nextRunAt ?? addCadenceIntervalIso(schedule.createdAt, cadence)) : null;
  schedule.updatedAt = schedule.updatedAt ?? null;
  schedule.updatedByUserId = schedule.updatedByUserId ?? null;
  return schedule;
}

function ensureDefaultProviderValidationSchedules(state) {
  state.providerValidationSchedules = state.providerValidationSchedules ?? [];
  state.providerValidationSchedules.forEach((schedule) => normalizeProviderValidationSchedule(schedule, state));
  defaultProviderValidationSchedules(state).forEach((schedule) => {
    if (!(state.providerValidationSchedules ?? []).some((candidate) => candidate.providerId === schedule.providerId)) {
      state.providerValidationSchedules.push(schedule);
    }
  });
  backfillProviderValidationScheduleRuns(state);
}

function backfillProviderValidationScheduleRuns(state) {
  const runs = [...(state.providerValidationRuns ?? [])].sort((left, right) => Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? ''));
  (state.providerValidationSchedules ?? []).forEach((schedule) => {
    if (schedule.lastRunId) {
      return;
    }
    const latestRun = runs.find((run) => (run.providers ?? []).some((provider) => scheduleProviderIdForSandboxProvider(provider.id) === schedule.providerId));
    const latestProvider = latestRun?.providers?.find((provider) => scheduleProviderIdForSandboxProvider(provider.id) === schedule.providerId);
    if (!latestRun || !latestProvider) {
      return;
    }
    schedule.lastRunAt = latestRun.recordedAt;
    schedule.lastRunId = latestRun.id;
    schedule.lastRunStatus = latestProvider.status;
    schedule.nextRunAt = schedule.status === 'active' ? addCadenceIntervalIso(latestRun.recordedAt, schedule.cadence) : null;
  });
}

export function providerValidationSchedulesDue(state, now = Date.now()) {
  return (state.providerValidationSchedules ?? []).filter((schedule) => {
    if (schedule.status !== 'active' || schedule.cadence === 'manual' || !schedule.nextRunAt) {
      return false;
    }
    const nextRunMs = Date.parse(schedule.nextRunAt);
    return Number.isFinite(nextRunMs) && nextRunMs <= now;
  });
}

function updateProviderValidationSchedulesFromRun(state, run, actor) {
  ensureDefaultProviderValidationSchedules(state);
  (run.providers ?? []).forEach((provider) => {
    const scheduleProviderId = scheduleProviderIdForSandboxProvider(provider.id);
    const schedule = (state.providerValidationSchedules ?? []).find((candidate) => candidate.providerId === scheduleProviderId);
    if (!schedule) {
      return;
    }
    schedule.lastRunAt = run.recordedAt;
    schedule.lastRunId = run.id;
    schedule.lastRunStatus = provider.status;
    schedule.nextRunAt = schedule.status === 'active' ? addCadenceIntervalIso(run.recordedAt, schedule.cadence) : null;
    schedule.updatedAt = run.recordedAt;
    schedule.updatedByUserId = actor.id;
  });
}

function providerValidationSchedulerJobNextRunAt(state) {
  const dueSchedules = providerValidationSchedulesDue(state);
  if (dueSchedules.length > 0) {
    return null;
  }
  const nextRunTimes = (state.providerValidationSchedules ?? [])
    .filter((schedule) => schedule.status === 'active' && schedule.cadence !== 'manual' && schedule.nextRunAt)
    .map((schedule) => Date.parse(schedule.nextRunAt))
    .filter((timestamp) => Number.isFinite(timestamp));
  if (nextRunTimes.length === 0) {
    return null;
  }
  return new Date(Math.min(...nextRunTimes)).toISOString();
}

function ensureProviderValidationSchedulerJob(state) {
  state.jobs = state.jobs ?? [];
  const nextRunAt = providerValidationSchedulerJobNextRunAt(state);
  const job = state.jobs.find((candidate) => candidate.queue === 'provider_validation' && candidate.type === 'provider.sandbox.scheduled');
  if (!job) {
    appendJob(state, {
      tenantId: state.tenants?.[0]?.id ?? 'tenant_demo',
      queue: 'provider_validation',
      type: 'provider.sandbox.scheduled',
      targetId: 'provider_validation_schedules',
      status: 'queued',
      attempts: 0,
      maxAttempts: 1,
      nextRunAt,
      message: 'Run due provider sandbox validation schedules through the shared worker boundary.',
    });
    return;
  }
  job.tenantId = job.tenantId ?? state.tenants?.[0]?.id ?? 'tenant_demo';
  job.targetId = job.targetId ?? 'provider_validation_schedules';
  job.message = job.message ?? 'Run due provider sandbox validation schedules through the shared worker boundary.';
  job.maxAttempts = job.maxAttempts ?? 1;
  if (['queued', 'running'].includes(job.status)) {
    job.nextRunAt = nextRunAt;
  }
}

function recordProviderSandboxValidationInState(state, actor, sandbox) {
  state.providerValidationRuns = state.providerValidationRuns ?? [];
  const sanitized = sanitizeProviderSandboxReport(sandbox);
  const reportDigest = sha256Digest(JSON.stringify(sanitized));
  const run = {
    id: makeId('pvr'),
    generatedAt: sanitized.generatedAt,
    ok: sanitized.ok,
    providers: sanitized.providers,
    recordedAt: nowIso(),
    recordedByUserId: actor.id,
    reportDigest,
    status: sandboxRunStatus(sanitized),
    summary: sanitized.summary,
  };
  state.providerValidationRuns.push(run);
  updateProviderValidationSchedulesFromRun(state, run, actor);
  return {
    id: run.id,
    message: `Recorded provider sandbox validation ${run.status} (${run.summary.passed}/${run.summary.total} passed).`,
    reportDigest: run.reportDigest,
    status: run.status,
    summary: run.summary,
    targetId: run.id,
  };
}

export function sensitiveKeyPaths(value, prefix = '') {
  if (!value || typeof value !== 'object') {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) => {
    const currentPath = prefix ? `${prefix}.${key}` : key;
    const isSensitive = /(secret|token|password|privateKey|apiKey)/i.test(key);
    const childPaths = sensitiveKeyPaths(child, currentPath);
    return isSensitive ? [currentPath, ...childPaths] : childPaths;
  });
}

export function doctor(state) {
  const sensitivePaths = sensitiveKeyPaths(state);
  const checks = [
    {
      id: 'active_admin',
      ok: state.users?.some((user) => user.role === 'admin' && user.status === 'active') ?? false,
      message: 'At least one active admin exists.',
    },
    {
      id: 'seat_capacity',
      ok: seatLimitForTenant(state, defaultTenantId(state)) === null || activeSeatCount(state) + pendingInviteSeatCount(state) <= seatLimitForTenant(state, defaultTenantId(state)),
      message: 'Active users and pending invites fit inside the current seat entitlement.',
    },
    {
      id: 'tenant_statuses',
      ok: (state.tenants ?? []).every((tenant) => tenant.id && tenant.domain && ['active', 'suspended'].includes(tenant.status)),
      message: 'Every tenant has a domain and explicit active or suspended status.',
    },
    {
      id: 'tenant_owners',
      ok: (state.tenants ?? []).every((tenant) =>
        tenant.ownerUserId &&
        tenant.billingOwnerUserId &&
        (state.users ?? []).some((user) => user.id === tenant.ownerUserId && user.tenantId === tenant.id) &&
        (state.users ?? []).some((user) => user.id === tenant.billingOwnerUserId && user.tenantId === tenant.id)),
      message: 'Every tenant has a workspace owner and billing owner inside the tenant.',
    },
    {
      id: 'tenant_memberships',
      ok: (state.users ?? []).every((user) =>
        (state.memberships ?? []).some((membership) =>
          membership.userId === user.id &&
          membership.tenantId === user.tenantId &&
          membership.role === user.role &&
          membership.status === (user.status === 'active' ? 'active' : 'disabled'))) &&
        (state.memberships ?? []).every((membership) =>
          ['admin', 'member'].includes(membership.role) &&
          ['active', 'disabled'].includes(membership.status) &&
          (state.tenants ?? []).some((tenant) => tenant.id === membership.tenantId) &&
          (state.users ?? []).some((user) => user.id === membership.userId)),
      message: 'Tenant memberships mirror user role/status and reference existing tenants and users.',
    },
    {
      id: 'pending_invite_expiry',
      ok: (state.invites ?? [])
        .filter((invite) => invite.status === 'pending')
        .every((invite) => Boolean(invite.expiresAt) && Date.parse(invite.expiresAt) > Date.parse(invite.createdAt ?? '')),
      message: 'Pending invites have bounded local expiration timestamps.',
    },
    {
      id: 'connected_mailbox',
      ok: state.mailboxes?.some((mailbox) => mailbox.status === 'connected') ?? false,
      message: 'At least one mailbox is connected.',
    },
    {
      id: 'sync_cursor_coverage',
      ok: (state.mailboxes ?? []).every((mailbox) => (state.emailSyncCursors ?? []).some((cursor) => cursor.mailboxId === mailbox.id)),
      message: 'Every mailbox has a provider sync cursor record.',
    },
    {
      id: 'watch_subscriptions_audited',
      ok: (state.emailWatchSubscriptions ?? []).every((watch) => watch.mailboxId && watch.provider && watch.notificationUrl && watch.expirationAt && ['active', 'expired', 'paused', 'failed'].includes(watch.status)),
      message: 'Provider watch subscriptions are auditable and statused.',
    },
    {
      id: 'enabled_email_flow',
      ok: state.emailFlows?.some((flow) => flow.status === 'enabled') ?? false,
      message: 'At least one email detector flow is enabled.',
    },
    {
      id: 'routing_rules_audited',
      ok: (state.emailFlows ?? []).every((flow) => (state.routingRules ?? []).some((rule) => rule.flowId === flow.id && rule.tenantId === flow.tenantId)) &&
        (state.routingRules ?? []).every((rule) => rule.flowId && rule.routeTo && rule.createdAt && rule.createdByUserId && ['active', 'disabled'].includes(rule.status)),
      message: 'Every detector flow has an auditable routing rule.',
    },
    {
      id: 'signal_quality_settings',
      ok: (state.tenants ?? []).every((tenant) => (state.signalQualitySettings ?? []).some((settings) => settings.tenantId === tenant.id && typeof settings.minimumConfidence === 'number')),
      message: 'Every tenant has detector quality settings.',
    },
    {
      id: 'suppression_rules_audited',
      ok: (state.suppressionRules ?? []).every((rule) => rule.createdByUserId && rule.createdAt && ['active', 'disabled'].includes(rule.status)),
      message: 'Suppression rules are auditable and have explicit status.',
    },
    {
      id: 'model_governance_boundary',
      ok: (state.tenants ?? []).every((tenant) =>
        (state.modelGovernancePolicies ?? []).some((policy) =>
          policy.tenantId === tenant.id &&
          policy.detectorBoundary === 'shared_detector' &&
          policy.dataBoundary === 'tenant_isolated' &&
          policy.perTenantModel === false &&
          modelLearningModes.includes(policy.learningMode) &&
          modelTrainingDataUseModes.includes(policy.trainingDataUse) &&
          Array.isArray(policy.tuningControls) &&
          policy.tuningControls.includes('quality_threshold') &&
          policy.tuningControls.includes('feedback_labels'))) &&
        (state.modelGovernancePolicies ?? []).every((policy) => policy.learningMode !== 'disabled' || policy.trainingDataUse === 'excluded_by_default'),
      message: 'Model governance uses a shared detector boundary with tenant-specific controls and opt-in-only learning.',
    },
    {
      id: 'governance_policy',
      ok: (state.tenants ?? []).every((tenant) => (state.governancePolicies ?? []).some((policy) => policy.tenantId === tenant.id && Number(policy.sourceRetentionDays) >= Number(policy.rawSnippetRetentionDays))),
      message: 'Every tenant has source retention and redaction governance policy.',
    },
    {
      id: 'data_requests_audited',
      ok: (state.dataRequests ?? []).every((request) => request.requesterEmail && request.requestedAt && ['open', 'processing', 'completed', 'rejected'].includes(request.status)),
      message: 'Export and delete requests are auditable and statused.',
    },
    {
      id: 'incident_notes_audited',
      ok: (state.incidentNotes ?? []).every((note) => note.title && note.createdByUserId && ['open', 'resolved'].includes(note.status)),
      message: 'Incident notes have owners, status, and audit context.',
    },
    {
      id: 'source_message_fixtures',
      ok: (state.sourceMessages ?? []).length > 0,
      message: 'Local source-message fixtures are available for detector flow testing.',
    },
    {
      id: 'signal_handoffs_audited',
      ok: (state.signalHandoffs ?? []).every((handoff) => handoff.signalId && handoff.createdAt && handoff.createdByUserId && ['crm', 'task'].includes(handoff.target) && ['queued', 'sent', 'failed', 'canceled'].includes(handoff.status)),
      message: 'Signal CRM/task handoffs are auditable and statused.',
    },
    {
      id: 'account_profile_coverage',
      ok: [...new Set((state.signals ?? []).map((signal) => signal.account))].every((account) => (state.accountProfiles ?? []).some((profile) => profile.name === account)),
      message: 'Every signaled account has a relationship profile.',
    },
    {
      id: 'account_actions_available',
      ok: (state.accountActions ?? []).some((action) => action.status === 'open'),
      message: 'Open account next actions are available for relationship monitoring.',
    },
    {
      id: 'account_reviews_audited',
      ok: (state.accountReviews ?? []).every((review) => review.account && review.createdAt && review.createdByUserId && Array.isArray(review.openActionIds) && Array.isArray(review.latestEventIds)),
      message: 'Account reviews are auditable snapshots of actions, signals, and timeline context.',
    },
    {
      id: 'account_recommendations_available',
      ok: (state.accountRecommendations ?? []).every((recommendation) =>
        recommendation.account &&
        recommendation.accountId &&
        recommendation.ownerUserId &&
        recommendation.title &&
        recommendation.rationale &&
        recommendation.strategy &&
        ['critical', 'high', 'medium', 'low'].includes(recommendation.priority) &&
        ['open', 'done', 'muted'].includes(recommendation.status) &&
        Array.isArray(recommendation.evidenceSignalIds) &&
        Array.isArray(recommendation.evidenceActionIds) &&
        Array.isArray(recommendation.stakeholderIds)) &&
        (state.accountRecommendations ?? []).some((recommendation) => recommendation.status === 'open'),
      message: 'Account recommendations are source-referenced strategy records with priority and status.',
    },
    {
      id: 'notification_preferences',
      ok: (state.users ?? [])
        .filter((user) => user.status === 'active')
        .every((user) => (state.notificationPreferences ?? []).some((preference) => preference.userId === user.id)),
      message: 'Every active user has notification digest and mute preferences.',
    },
    {
      id: 'notification_events_available',
      ok: (state.notificationEvents ?? []).some((event) => ['unread', 'read', 'sent', 'muted'].includes(event.status)),
      message: 'Dashboard notification events are available for signals and account work.',
    },
    {
      id: 'email_delivery_preferences',
      ok: (state.notificationPreferences ?? []).every((preference) => preference.unsubscribeCode && ['subscribed', 'unsubscribed'].includes(preference.emailDeliveryStatus ?? 'subscribed')),
      message: 'Every notification preference has email delivery subscription state.',
    },
    {
      id: 'email_delivery_ledger',
      ok: (state.emailDeliveryMessages ?? []).every((message) => message.toEmail && ['queued', 'sent', 'failed', 'bounced', 'suppressed'].includes(message.status)),
      message: 'Outbound digest email delivery records are statused.',
    },
    {
      id: 'subscription_state',
      ok: state.subscriptions?.some((subscription) => ['trialing', 'active'].includes(subscription.status)) ?? false,
      message: 'A trialing or active subscription exists.',
    },
    {
      id: 'active_entitlement',
      ok: state.entitlements?.some((entitlement) => entitlement.status === 'active') ?? false,
      message: 'At least one active entitlement is computed from billing state.',
    },
    {
      id: 'billing_overrides_audited',
      ok: (state.billingOverrides ?? []).every((override) => override.tenantId && override.reason && override.createdAt && override.createdByUserId && ['active', 'revoked', 'expired'].includes(override.status)),
      message: 'Billing overrides have tenant, reason, status, and audit metadata.',
    },
    {
      id: 'invoice_recovery_known',
      ok: !(state.invoices ?? []).some((invoice) => invoice.status === 'past_due' && !invoice.nextPaymentAttemptAt),
      message: 'Past-due invoices have a next payment attempt or recovery path.',
    },
    {
      id: 'billing_jobs_settled',
      ok: !(state.jobs ?? []).some((job) => job.queue === 'billing_webhook' && job.status === 'failed'),
      message: 'No billing webhook jobs are failed.',
    },
    {
      id: 'lifecycle_notices_audited',
      ok: (state.lifecycleNotices ?? []).every((notice) =>
        notice.id &&
        notice.tenantId &&
        notice.title &&
        notice.body &&
        notice.createdAt &&
        ['access', 'onboarding', 'payment', 'source', 'notification', 'provider'].includes(notice.category) &&
        ['info', 'watch', 'critical'].includes(notice.severity) &&
        ['open', 'monitoring', 'resolved'].includes(notice.status)) &&
        (state.lifecycleNotices ?? []).some((notice) => notice.category === 'payment') &&
        (state.lifecycleNotices ?? []).some((notice) => notice.category === 'source'),
      message: 'Lifecycle notices are auditable records linked to billing, source, notification, and provider state.',
    },
    {
      id: 'no_local_secrets',
      ok: sensitivePaths.length === 0,
      message: 'Local state does not contain secret-like fields.',
      details: sensitivePaths,
    },
    {
      id: 'active_session_user',
      ok: Boolean(getActor(state, state.session?.activeUserId, { allowMissing: true })),
      message: 'The local session points to an active user.',
    },
    {
      id: 'api_sessions_digest_only',
      ok: (state.apiSessions ?? []).every((session) => session.id && session.digest && !session.value && !session.secret && !session.plaintext && ['active', 'revoked', 'expired'].includes(apiSessionStatus(session))),
      message: 'Local API sessions store revocable digest metadata only.',
    },
    {
      id: 'provider_validation_runs_sanitized',
      ok: (state.providerValidationRuns ?? []).every((run) =>
        run.id &&
        run.recordedAt &&
        run.reportDigest &&
        ['passed', 'failed', 'blocked'].includes(run.status) &&
        !run.report &&
        !run.raw &&
        !run.token &&
        !run.secret &&
        !run.apiKey &&
        !run.plaintext),
      message: 'Provider sandbox validation evidence is recorded without raw secrets or raw reports.',
    },
    {
      id: 'provider_validation_schedules_audited',
      ok: scheduledProviderIds.every((providerId) => (state.providerValidationSchedules ?? []).some((schedule) => schedule.providerId === providerId)) &&
        (state.providerValidationSchedules ?? []).every((schedule) =>
          schedule.id &&
          scheduledProviderIds.includes(schedule.providerId) &&
          providerValidationCadences.includes(schedule.cadence) &&
          providerValidationScheduleStatuses.includes(schedule.status) &&
          Array.isArray(schedule.requiredEnv) &&
          !schedule.raw &&
          !schedule.report &&
          !schedule.token &&
          !schedule.secret &&
          !schedule.apiKey &&
          !schedule.plaintext),
      message: 'Provider sandbox validation schedules are statused and contain metadata only.',
    },
  ];

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

function readinessRequirement({ evidence = [], gaps = [], id, label, localOk, productionOk = localOk, status }) {
  const computedStatus = status ?? (
    productionOk
      ? 'ready'
      : localOk
        ? 'local_ready'
        : 'needs_attention'
  );
  return {
    evidence,
    gaps,
    id,
    label,
    localOk: Boolean(localOk),
    productionOk: Boolean(productionOk),
    status: computedStatus,
  };
}

function doctorCheckMap(report) {
  return new Map((report.checks ?? []).map((check) => [check.id, check]));
}

function allDoctorChecksOk(checksById, ids) {
  return ids.every((id) => checksById.get(id)?.ok === true);
}

function latestProviderValidationRun(state) {
  return [...(state.providerValidationRuns ?? [])].sort((left, right) => Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? ''))[0] ?? null;
}

export function productReadinessReport(state, {
  backend = null,
  provider = providerReadiness(),
} = {}) {
  const summary = summarizeState(state);
  const doctorReport = doctor(state);
  const checksById = doctorCheckMap(doctorReport);
  const latestProviderRun = latestProviderValidationRun(state);
  const providerValidationLocalOk = allDoctorChecksOk(checksById, ['provider_validation_runs_sanitized', 'provider_validation_schedules_audited']);
  const backendProductionReady = backend?.productionReady === true;
  const providerProductionReady = provider?.ok === true && latestProviderRun?.status === 'passed';
  const providerMissingEnv = provider?.summary?.missingRequired ?? 0;
  const requirements = [
    readinessRequirement({
      id: 'workspace_onboarding',
      label: 'Workspace registration, onboarding, invites, and seats',
      localOk: allDoctorChecksOk(checksById, ['tenant_owners', 'tenant_memberships', 'pending_invite_expiry', 'seat_capacity']) &&
        (state.subscriptions ?? []).some((subscription) => subscription.tenantId === defaultTenantId(state)) &&
        (state.entitlements ?? []).some((entitlement) => entitlement.tenantId === defaultTenantId(state)),
      evidence: [
        `${summary.tenants} tenant(s)`,
        `${summary.activeMemberships}/${summary.memberships} active memberships`,
        `${summary.pendingInvites}/${summary.invites} pending invites`,
        `${summary.activeSeats}+${summary.pendingInviteSeats}/${summary.seatLimit ?? 'unlimited'} seats`,
      ],
      gaps: [],
    }),
    readinessRequirement({
      id: 'multi_user_rbac_privacy',
      label: 'Multi-user organization, RBAC, privacy, and tenant isolation',
      localOk: allDoctorChecksOk(checksById, ['tenant_memberships', 'active_session_user', 'api_sessions_digest_only', 'no_local_secrets']),
      productionOk: backendProductionReady,
      status: backendProductionReady ? 'ready' : 'needs_production',
      evidence: [
        `${summary.admins} active admin(s)`,
        `${summary.activeMemberships} active membership(s)`,
        `${summary.apiSessions} digest-only API session record(s)`,
        `Backend tenant isolation: ${backend?.checks?.find?.((check) => check.id === 'tenant_isolation')?.ok ? 'configured' : 'not production configured'}`,
      ],
      gaps: backendProductionReady ? [] : ['Configure durable production tenant isolation mode and managed auth/storage before multi-customer production use.'],
    }),
    readinessRequirement({
      id: 'email_source_and_detection_flow',
      label: 'Email source ingestion, detector runs, routing, and signal handoff',
      localOk: allDoctorChecksOk(checksById, ['connected_mailbox', 'sync_cursor_coverage', 'source_message_fixtures', 'enabled_email_flow', 'routing_rules_audited', 'signal_handoffs_audited']),
      evidence: [
        `${summary.connectedMailboxes}/${summary.mailboxes} connected mailbox source(s)`,
        `${summary.sourceMessages} source message fixture(s)`,
        `${summary.enabledEmailFlows}/${summary.emailFlows} enabled detector flow(s)`,
        `${summary.generatedSignals} generated source-backed signal(s)`,
        `${summary.queuedSignalHandoffs}/${summary.signalHandoffs} queued handoff(s)`,
      ],
      gaps: [],
    }),
    readinessRequirement({
      id: 'model_governance_and_tuning',
      label: 'Data digestion model boundary and tenant-specific tuning',
      localOk: allDoctorChecksOk(checksById, ['model_governance_boundary', 'signal_quality_settings', 'suppression_rules_audited']),
      evidence: [
        `${summary.modelGovernancePolicies} model governance polic${summary.modelGovernancePolicies === 1 ? 'y' : 'ies'}`,
        `${summary.perTenantModels} per-tenant trained model(s) enabled`,
        `${summary.activeSuppressionRules}/${summary.suppressionRules} active suppression rule(s)`,
        `${summary.signalFeedback} feedback label(s)`,
      ],
      gaps: (summary.perTenantModels ?? 0) === 0 ? [] : ['Disable per-tenant model records unless governed opt-in training is explicitly approved.'],
    }),
    readinessRequirement({
      id: 'relationship_dashboard_and_recommendations',
      label: 'Relationship dashboard, indicators, priorities, and recommendations',
      localOk: allDoctorChecksOk(checksById, ['account_profile_coverage', 'account_actions_available', 'account_recommendations_available']),
      evidence: [
        `${summary.accounts} account profile(s)`,
        `${summary.atRiskAccounts} at-risk account(s)`,
        `${summary.openAccountActions} open next action(s)`,
        `${summary.openAccountRecommendations}/${summary.accountRecommendations} open recommendation(s)`,
      ],
      gaps: [],
    }),
    readinessRequirement({
      id: 'notifications_and_admin_monitoring',
      label: 'User notifications, digest email flow, and admin monitoring',
      localOk: allDoctorChecksOk(checksById, ['notification_preferences', 'notification_events_available', 'email_delivery_preferences', 'email_delivery_ledger']) &&
        (summary.digestRuns ?? 0) >= 0,
      evidence: [
        `${summary.notificationPreferences} notification preference record(s)`,
        `${summary.unreadNotifications}/${summary.notificationEvents} unread notification(s)`,
        `${summary.digestRuns} digest run(s)`,
        `${summary.failedEmailDeliveries}/${summary.emailDeliveries} failed email deliver${summary.emailDeliveries === 1 ? 'y' : 'ies'}`,
      ],
      gaps: [],
    }),
    readinessRequirement({
      id: 'payment_lifecycle_and_entitlements',
      label: 'Payment lifecycle, entitlement gates, recovery, cancellation, and resubscription',
      localOk: allDoctorChecksOk(checksById, ['subscription_state', 'active_entitlement', 'billing_overrides_audited', 'invoice_recovery_known', 'billing_jobs_settled', 'lifecycle_notices_audited']),
      evidence: [
        `${summary.subscriptions} subscription record(s)`,
        `${summary.activeEntitlements} active entitlement(s)`,
        `${summary.openInvoices}/${summary.invoices} open invoice(s)`,
        `${summary.billingSessions} billing session(s)`,
        `${summary.paymentEvents} payment event(s)`,
      ],
      gaps: [],
    }),
    readinessRequirement({
      id: 'provider_integrations',
      label: 'Gmail, Outlook, SendGrid, and Stripe provider readiness',
      localOk: providerValidationLocalOk,
      productionOk: providerProductionReady,
      status: providerProductionReady ? 'ready' : 'needs_live_provider',
      evidence: [
        `${provider?.summary?.readyProviders ?? 0}/${provider?.summary?.totalProviders ?? 0} provider config group(s) ready`,
        `${providerMissingEnv} required env var(s) missing`,
        latestProviderRun ? `Latest sandbox evidence ${latestProviderRun.status} at ${latestProviderRun.recordedAt}` : 'No sandbox evidence recorded',
      ],
      gaps: providerProductionReady ? [] : ['Run provider sandbox validation with real sandbox credentials and save sanitized evidence.'],
    }),
    readinessRequirement({
      id: 'local_admin_agent_operations',
      label: 'Local admin CLI, API, jobs, audit, and agent operations',
      localOk: allDoctorChecksOk(checksById, ['api_sessions_digest_only', 'provider_validation_schedules_audited']) &&
        (state.jobs ?? []).some((job) => ['email_sync', 'provider_validation', 'notification_digest', 'outbound_email', 'billing_webhook', 'signal_handoff'].includes(job.queue)) &&
        Array.isArray(state.auditEvents),
      evidence: [
        `${summary.jobs} job record(s)`,
        `${summary.failedJobs} failed job(s)`,
        `${summary.auditEvents} audit event(s)`,
        `${summary.activeApiSessions}/${summary.apiSessions} active API session(s)`,
      ],
      gaps: [],
    }),
    readinessRequirement({
      id: 'production_backend_and_scheduler',
      label: 'Production backend, storage, auth, CORS, tenant isolation, and scheduler',
      localOk: Boolean(backend),
      productionOk: backendProductionReady,
      status: backendProductionReady ? 'ready' : 'needs_production',
      evidence: [
        `Backend mode: ${backend?.mode ?? 'unknown'}`,
        `${backend?.summary?.readyChecks ?? 0}/${backend?.summary?.totalChecks ?? 0} production backend check(s) ready`,
        `${backend?.summary?.missingRequiredEnv?.length ?? 0} backend env var name(s) missing`,
      ],
      gaps: backendProductionReady ? [] : ['Configure production backend mode, durable storage, managed auth/JWKS, CORS origins, tenant isolation, and scheduler environment.'],
    }),
  ];

  return {
    ok: requirements.every((requirement) => requirement.localOk),
    productionReady: requirements.every((requirement) => requirement.productionOk),
    generatedAt: new Date().toISOString(),
    requirements,
    summary: {
      localReady: requirements.filter((requirement) => requirement.localOk).length,
      needsAttention: requirements.filter((requirement) => !requirement.localOk).length,
      needsLiveProvider: requirements.filter((requirement) => requirement.status === 'needs_live_provider').length,
      needsProduction: requirements.filter((requirement) => requirement.status === 'needs_production').length,
      productionReady: requirements.filter((requirement) => requirement.productionOk).length,
      total: requirements.length,
    },
  };
}

function readinessById(report, id) {
  return report.requirements.find((requirement) => requirement.id === id) ?? null;
}

function backendCheckById(backend, id) {
  return backend?.checks?.find?.((check) => check.id === id) ?? null;
}

function providerById(provider, id) {
  return provider?.providers?.find?.((item) => item.id === id) ?? null;
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function launchGateItem({
  blockers = [],
  commands = [],
  evidence = [],
  id,
  label,
  owner,
  requiredEnv = [],
  status,
}) {
  return {
    blockers,
    commands,
    evidence,
    id,
    label,
    owner,
    requiredEnv: uniqueValues(requiredEnv),
    status: status ?? (blockers.length ? 'blocked' : 'pass'),
  };
}

export function launchGateReport(state, {
  backend = null,
  provider = providerReadiness(),
  readiness = null,
} = {}) {
  const summary = summarizeState(state);
  const product = readiness ?? productReadinessReport(state, { backend, provider });
  const latestProviderRun = latestProviderValidationRun(state);
  const backendFailedChecks = backend?.checks?.filter?.((check) => !check.ok) ?? [];
  const tenantIsolation = backendCheckById(backend, 'tenant_isolation');
  const scheduler = backendCheckById(backend, 'job_scheduler');
  const stripe = providerById(provider, 'stripe');
  const gmail = providerById(provider, 'gmail');
  const outlook = providerById(provider, 'outlook');
  const outboundEmail = providerById(provider, 'outbound-email');
  const providerMissingEnv = provider?.providers?.flatMap?.((item) => item.missingRequired ?? []) ?? [];
  const emailProviderMissingEnv = [gmail, outlook, outboundEmail].flatMap((item) => item?.missingRequired ?? []);
  const activeProviderSchedules = state.providerValidationSchedules?.filter((schedule) => schedule.status === 'active').length ?? 0;
  const providerSandboxPassed = latestProviderRun?.status === 'passed';
  const productBlockers = product.requirements
    .filter((requirement) => !requirement.localOk)
    .map((requirement) => `${requirement.label}: ${requirement.gaps.join('; ') || 'local evidence missing'}`);

  const gates = [
    launchGateItem({
      id: 'local_product_surface',
      label: 'Local product surface and contracts',
      owner: 'product',
      status: product.ok ? 'pass' : 'attention',
      evidence: [
        `${product.summary.localReady}/${product.summary.total} local readiness areas pass`,
        `${summary.users} user(s), ${summary.mailboxes} mailbox source(s), ${summary.subscriptions} subscription record(s)`,
      ],
      blockers: productBlockers,
      commands: [
        'npm run admin -- readiness --json',
        'npm run test:local',
      ],
    }),
    launchGateItem({
      id: 'production_backend',
      label: 'Production backend, durable state, auth, CORS, and storage',
      owner: 'platform',
      status: backend?.productionReady ? 'pass' : 'blocked',
      evidence: [
        `Backend mode: ${backend?.mode ?? 'unknown'}`,
        `${backend?.summary?.readyChecks ?? 0}/${backend?.summary?.totalChecks ?? 0} backend checks production-ready`,
      ],
      blockers: backendFailedChecks.map((check) => check.message),
      requiredEnv: backend?.summary?.missingRequiredEnv ?? [],
      commands: [
        'npm run admin -- backend --json',
        'SIGNAL_STATE_SERVICE_BACKEND=postgres DATABASE_URL=postgres://... SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service',
      ],
    }),
    launchGateItem({
      id: 'tenant_isolation',
      label: 'Multi-org tenant isolation enforcement',
      owner: 'security',
      status: tenantIsolation?.ok ? 'pass' : 'blocked',
      evidence: [
        tenantIsolation?.message ?? 'Tenant isolation readiness has not been evaluated.',
        `${summary.tenants} tenant(s), ${summary.memberships} membership record(s)`,
      ],
      blockers: tenantIsolation?.ok ? [] : [tenantIsolation?.message ?? 'Configure a durable tenant isolation policy before production.'],
      requiredEnv: tenantIsolation?.missingEnv ?? ['SIGNAL_TENANT_ISOLATION_MODE'],
      commands: [
        'SIGNAL_TENANT_ISOLATION_MODE=rls npm run admin -- backend --json',
      ],
    }),
    launchGateItem({
      id: 'provider_configuration',
      label: 'Gmail, Outlook, SendGrid, and Stripe configuration',
      owner: 'integrations',
      status: provider?.ok ? 'pass' : 'blocked',
      evidence: [
        `${provider?.summary?.readyProviders ?? 0}/${provider?.summary?.totalProviders ?? 0} provider groups configured`,
        `${provider?.summary?.missingRequired ?? 0} required provider env var name(s) missing`,
      ],
      blockers: provider?.providers
        ?.filter?.((item) => !item.ready)
        .map((item) => `${item.label}: missing ${item.missingRequired.join(', ')}`) ?? [],
      requiredEnv: providerMissingEnv,
      commands: [
        'npm run admin -- integrations --json',
      ],
    }),
    launchGateItem({
      id: 'provider_sandbox_evidence',
      label: 'Live-provider sandbox evidence artifact',
      owner: 'integrations',
      status: providerSandboxPassed ? 'pass' : 'blocked',
      evidence: [
        latestProviderRun ? `Latest sandbox evidence: ${latestProviderRun.status} at ${latestProviderRun.recordedAt}` : 'No sandbox evidence recorded',
        `${state.providerValidationRuns?.length ?? 0} recorded sandbox run(s)`,
      ],
      blockers: providerSandboxPassed ? [] : ['Run sandbox validation with real provider sandbox credentials and save sanitized evidence.'],
      requiredEnv: ['SIGNAL_GMAIL_ACCESS_TOKEN', 'SIGNAL_OUTLOOK_ACCESS_TOKEN', 'SIGNAL_SENDGRID_API_KEY', 'STRIPE_SECRET_KEY', 'SIGNAL_STRIPE_PRICE_TEAM'],
      commands: [
        'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
        'npm run admin -- integrations evidence-export latest ./signal-provider-evidence.json --json',
      ],
    }),
    launchGateItem({
      id: 'email_notification_launch',
      label: 'Email ingestion, watch renewal, and outbound notification launch',
      owner: 'integrations',
      status: gmail?.ready && outlook?.ready && outboundEmail?.ready && providerSandboxPassed ? 'pass' : 'blocked',
      evidence: [
        `${summary.connectedMailboxes}/${summary.mailboxes} mailbox source(s) connected locally`,
        `${summary.activeEmailWatchSubscriptions}/${summary.emailWatchSubscriptions} active provider watch subscription(s)`,
        `${summary.failedEmailDeliveries}/${summary.emailDeliveries} failed outbound email deliver${summary.emailDeliveries === 1 ? 'y' : 'ies'}`,
      ],
      blockers: gmail?.ready && outlook?.ready && outboundEmail?.ready && providerSandboxPassed
        ? []
        : ['Gmail, Outlook, SendGrid/outbound email config and sandbox evidence must pass before production email launch.'],
      requiredEnv: emailProviderMissingEnv,
      commands: [
        'npm run admin -- mailboxes watch mbx_gmail_sales --live-provider',
        'npm run admin -- mailboxes renew-watch watch_outlook_mbx_outlook_success --live-provider',
        'npm run admin -- notifications digest tenant_demo --live-provider',
      ],
    }),
    launchGateItem({
      id: 'payment_launch',
      label: 'Stripe checkout, billing portal, webhooks, and entitlement launch',
      owner: 'billing',
      status: stripe?.ready && providerSandboxPassed ? 'pass' : 'blocked',
      evidence: [
        `${summary.subscriptions} subscription record(s)`,
        `${summary.activeEntitlements} active entitlement(s)`,
        `${summary.openInvoices}/${summary.invoices} open invoice(s)`,
        `${summary.paymentEvents} payment event(s)`,
      ],
      blockers: stripe?.ready && providerSandboxPassed
        ? []
        : ['Stripe env, test price lookup, signed webhook replay, and saved sandbox evidence must pass before production billing launch.'],
      requiredEnv: stripe?.missingRequired ?? ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SIGNAL_STRIPE_PRICE_TEAM'],
      commands: [
        'npm run admin -- payments checkout tenant_demo plan_team --live-provider',
        'npm run admin -- payments portal tenant_demo --live-provider',
        'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>',
      ],
    }),
    launchGateItem({
      id: 'scheduler_operations',
      label: 'Production scheduler, retries, and monitoring',
      owner: 'operations',
      status: scheduler?.ok && summary.failedJobs === 0 && activeProviderSchedules >= 4 ? 'pass' : 'blocked',
      evidence: [
        scheduler?.message ?? 'Scheduler readiness has not been evaluated.',
        `${summary.failedJobs}/${summary.jobs} failed job(s)`,
        `${activeProviderSchedules}/${state.providerValidationSchedules?.length ?? 0} active provider validation schedule(s)`,
      ],
      blockers: scheduler?.ok && summary.failedJobs === 0 && activeProviderSchedules >= 4
        ? []
        : ['Configure production scheduler env, keep validation schedules active, and clear failed jobs.'],
      requiredEnv: scheduler?.missingEnv ?? ['SIGNAL_JOB_SCHEDULER', 'SIGNAL_PROVIDER_VALIDATION_SCHEDULER'],
      commands: [
        'SIGNAL_JOB_SCHEDULER=signal-scheduler npm run scheduler',
        'npm run admin -- jobs run provider_validation --limit 1',
        'npm run admin -- jobs drain billing_webhook',
      ],
    }),
  ];

  return {
    generatedAt: new Date().toISOString(),
    goLiveReady: gates.every((gate) => gate.status === 'pass'),
    gates,
    summary: {
      attention: gates.filter((gate) => gate.status === 'attention').length,
      blocked: gates.filter((gate) => gate.status === 'blocked').length,
      passed: gates.filter((gate) => gate.status === 'pass').length,
      total: gates.length,
    },
  };
}

function configuredKeys(env = {}, keys = []) {
  return keys.filter((key) => Boolean(env[key]));
}

function missingKeys(env = {}, keys = []) {
  return keys.filter((key) => !env[key]);
}

function productionDrillRow({
  area,
  check,
  commands = [],
  evidence = [],
  localOk = true,
  owner,
  productionOk,
  recommendation,
  requiredEnv = [],
}) {
  return {
    area,
    check,
    commands,
    evidence,
    localOk: Boolean(localOk),
    owner,
    productionOk: Boolean(productionOk),
    recommendation,
    requiredEnv: uniqueValues(requiredEnv),
    status: productionOk ? 'production_ready' : localOk ? 'needs_proof' : 'attention',
  };
}

export function productionOperationsDrillReport(state, {
  backend = null,
  env = process.env,
  launchGate = null,
  operations = null,
  provider = providerReadiness(env),
  readiness = null,
} = {}) {
  const summary = summarizeState(state);
  const product = readiness ?? productReadinessReport(state, { backend, provider });
  const gate = launchGate ?? launchGateReport(state, { backend, provider, readiness: product });
  const health = operations ?? operationsHealthReport(state, { backend });
  const latestProviderRun = latestProviderValidationRun(state);
  const durableState = backendCheckById(backend, 'durable_state');
  const stateServiceStorage = backendCheckById(backend, 'state_service_storage');
  const signedSession = backendCheckById(backend, 'signed_session_enforced');
  const productionAuth = backendCheckById(backend, 'production_auth_provider');
  const tenantIsolation = backendCheckById(backend, 'tenant_isolation');
  const scheduler = backendCheckById(backend, 'job_scheduler');
  const configuredStateService = backend?.mode === 'external-service' && Boolean(env.SIGNAL_STATE_SERVICE_URL);
  const stateServiceTokenConfigured = Boolean(env.SIGNAL_STATE_SERVICE_TOKEN);
  const stateServiceReady = Boolean(configuredStateService && durableState?.ok && stateServiceStorage?.ok && stateServiceTokenConfigured);
  const backupScheduleEnv = ['SIGNAL_STATE_BACKUP_SCHEDULE', 'SIGNAL_STATE_BACKUP_RETENTION_DAYS'];
  const restoreRehearsalEnv = ['SIGNAL_STATE_RESTORE_REHEARSAL_AT'];
  const migrationPlanEnv = ['SIGNAL_STATE_MIGRATION_ROLLOUT_PLAN'];
  const schedulerLockEnv = ['SIGNAL_SCHEDULER_LOCK_POLICY'];
  const runbookEnv = ['SIGNAL_OPERATIONS_RUNBOOK_URL', 'SIGNAL_OPERATIONS_ALERT_CHANNEL'];
  const backupScheduleReady = configuredKeys(env, backupScheduleEnv).length === backupScheduleEnv.length;
  const restoreRehearsalReady = configuredKeys(env, restoreRehearsalEnv).length === restoreRehearsalEnv.length;
  const migrationPlanReady = configuredKeys(env, migrationPlanEnv).length === migrationPlanEnv.length;
  const schedulerLockReady = configuredKeys(env, schedulerLockEnv).length === schedulerLockEnv.length;
  const runbookReady = configuredKeys(env, runbookEnv).length === runbookEnv.length;
  const activeProviderSchedules = state.providerValidationSchedules?.filter((schedule) => schedule.status === 'active').length ?? 0;
  const providerSandboxPassed = latestProviderRun?.status === 'passed';
  const identityReady = Boolean(signedSession?.ok && productionAuth?.ok && tenantIsolation?.ok);
  const schedulerReady = Boolean(scheduler?.ok && schedulerLockReady && summary.failedJobs === 0 && activeProviderSchedules >= 4);
  const liveProviderSchedulerReady = Boolean(provider?.ok && providerSandboxPassed && activeProviderSchedules >= 4);

  const rows = [
    productionDrillRow({
      area: 'local_contracts',
      check: 'Local contracts, browser routes, API mutations, scheduler, state-service, and launch package tests are the baseline before production rehearsal.',
      owner: 'product',
      productionOk: product.productionReady,
      evidence: [
        `${product.summary.localReady}/${product.summary.total} local readiness areas pass`,
        `${gate.summary.passed}/${gate.summary.total} launch gate(s) currently pass`,
      ],
      recommendation: 'Run npm run test:local and launch-gate package before any provider or deployment rehearsal.',
      commands: [
        'npm run test:local',
        'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json',
      ],
    }),
    productionDrillRow({
      area: 'state_service_health',
      check: 'External state service is configured, bearer-protected, database-backed, and reachable through the local-agent admin boundary.',
      owner: 'platform',
      productionOk: stateServiceReady,
      requiredEnv: uniqueValues([
        'SIGNAL_BACKEND_MODE',
        'SIGNAL_STATE_SERVICE_URL',
        'SIGNAL_STATE_SERVICE_TOKEN',
        ...(stateServiceStorage?.missingEnv ?? []),
      ]),
      evidence: [
        `Backend mode: ${backend?.mode ?? 'unknown'}`,
        stateServiceStorage?.message ?? 'State-service storage not evaluated',
        `State-service token configured: ${stateServiceTokenConfigured ? 'yes' : 'no'}`,
      ],
      recommendation: 'Run health through the same state-service URL the API will use; do not test backups against local JSON mode.',
      commands: [
        'SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- health --json',
      ],
    }),
    productionDrillRow({
      area: 'backup_restore_rehearsal',
      check: 'Production backup policy, manual backup, digest verification, and restore dry run have explicit proof.',
      owner: 'platform',
      productionOk: Boolean(stateServiceReady && backupScheduleReady && restoreRehearsalReady),
      requiredEnv: [...missingKeys(env, backupScheduleEnv), ...missingKeys(env, restoreRehearsalEnv)],
      evidence: [
        `Backup schedule configured: ${backupScheduleReady ? 'yes' : 'no'}`,
        `Restore rehearsal timestamp configured: ${restoreRehearsalReady ? env.SIGNAL_STATE_RESTORE_REHEARSAL_AT : 'no'}`,
      ],
      recommendation: 'Store the backup artifact outside app state, verify its digest, and complete a dry-run restore before launch.',
      commands: [
        'SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- backup ./signal-prod-backup.json --json',
        'npm run state-service:admin -- verify ./signal-prod-backup.json --json',
        'SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- restore ./signal-prod-backup.json --dry-run --json',
      ],
    }),
    productionDrillRow({
      area: 'migration_rollout',
      check: 'State-service database migrations, rollback owner, and rollout order are declared before production writes begin.',
      owner: 'platform',
      productionOk: Boolean(stateServiceReady && migrationPlanReady),
      requiredEnv: missingKeys(env, migrationPlanEnv),
      evidence: [
        `Migration rollout plan configured: ${migrationPlanReady ? 'yes' : 'no'}`,
        durableState?.message ?? 'Durable state not evaluated',
      ],
      recommendation: 'Use the Postgres-backed state service migration contract and record the rollout plan URL or change ticket in environment metadata.',
      commands: [
        'SIGNAL_STATE_SERVICE_BACKEND=postgres DATABASE_URL=postgres://... SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service',
        'npm run test:state-service',
      ],
    }),
    productionDrillRow({
      area: 'identity_tenant_isolation',
      check: 'Managed/JWKS identity, signed sessions, durable membership mapping, and tenant isolation are all configured.',
      owner: 'security',
      productionOk: identityReady,
      requiredEnv: uniqueValues([
        ...(signedSession?.missingEnv ?? []),
        ...(productionAuth?.missingEnv ?? []),
        ...(tenantIsolation?.missingEnv ?? []),
      ]),
      evidence: [
        signedSession?.message ?? 'Signed session not evaluated',
        productionAuth?.message ?? 'Production auth not evaluated',
        tenantIsolation?.message ?? 'Tenant isolation not evaluated',
      ],
      recommendation: 'Do not support many customer orgs on one backend until server-verified role and tenant claims match durable memberships.',
      commands: [
        'npm run admin -- backend --env-file ./.env.production --json',
        'npm run test:jwks-auth',
      ],
    }),
    productionDrillRow({
      area: 'scheduler_daemon',
      check: 'Managed scheduler process, single-runner policy, active validation schedules, and clean queues are ready.',
      owner: 'operations',
      productionOk: schedulerReady,
      requiredEnv: uniqueValues([...(scheduler?.missingEnv ?? []), ...missingKeys(env, schedulerLockEnv)]),
      evidence: [
        scheduler?.message ?? 'Scheduler not evaluated',
        `${summary.failedJobs}/${summary.jobs} failed job(s)`,
        `${activeProviderSchedules}/${state.providerValidationSchedules?.length ?? 0} active provider validation schedule(s)`,
        `Single-runner policy configured: ${schedulerLockReady ? 'yes' : 'no'}`,
      ],
      recommendation: 'Run the scheduler dry-run and one managed queue tick before enabling continuous production scheduling.',
      commands: [
        'npm run scheduler -- --once --dry-run --json',
        'SIGNAL_JOB_SCHEDULER=signal-scheduler SIGNAL_PROVIDER_VALIDATION_SCHEDULER=signal-scheduler npm run scheduler -- --once --json',
      ],
    }),
    productionDrillRow({
      area: 'live_provider_recurring_tests',
      check: 'Live-provider sandbox evidence is passed and scheduled for recurring production-safe checks.',
      owner: 'integrations',
      productionOk: liveProviderSchedulerReady,
      requiredEnv: provider?.providers?.flatMap?.((item) => item.missingRequired ?? []) ?? [],
      evidence: [
        `${provider?.summary?.readyProviders ?? 0}/${provider?.summary?.totalProviders ?? 0} provider group(s) configured`,
        latestProviderRun ? `Latest sandbox evidence ${latestProviderRun.status} at ${latestProviderRun.recordedAt}` : 'No provider sandbox evidence recorded',
        `${activeProviderSchedules}/${state.providerValidationSchedules?.length ?? 0} active provider validation schedule(s)`,
      ],
      recommendation: 'Use real Gmail, Outlook, SendGrid, and Stripe sandbox credentials and save sanitized evidence before go-live.',
      commands: [
        'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
        'npm run admin -- integrations run-scheduled --force --json',
      ],
    }),
    productionDrillRow({
      area: 'alerting_runbook',
      check: 'Operations alert destination and launch runbook are configured for failed jobs, webhooks, provider backoff, billing, and lifecycle notices.',
      owner: 'operations',
      productionOk: Boolean(health.productionReady && runbookReady),
      requiredEnv: missingKeys(env, runbookEnv),
      evidence: [
        `Operations health production-ready: ${health.productionReady ? 'yes' : 'no'}`,
        `Alert channel configured: ${env.SIGNAL_OPERATIONS_ALERT_CHANNEL ? 'yes' : 'no'}`,
        `Runbook URL configured: ${env.SIGNAL_OPERATIONS_RUNBOOK_URL ? 'yes' : 'no'}`,
      ],
      recommendation: 'Wire operations-health output into the alert channel before accepting production traffic.',
      commands: [
        'npm run admin -- operations-health --env-file ./.env.production --json',
      ],
    }),
  ];

  return {
    generatedAt: new Date().toISOString(),
    ok: rows.every((row) => row.localOk),
    productionReady: rows.every((row) => row.productionOk),
    issues: rows.filter((row) => !row.localOk || !row.productionOk).map((row) => `${row.area}: ${row.check}`),
    recommendation: {
      summary: 'Use production-drill after launch-gate to rehearse the deployable backend, state-service, backup/restore, identity, scheduler, live-provider tests, and alerting runbook.',
      productionGuardrail: 'Do not mark Signal production-ready until every production drill row has current external evidence from the target deployment.',
      localAgentCommand: 'npm run admin -- production-drill --env-file ./.env.production --json',
    },
    rows,
    summary: {
      blocked: rows.filter((row) => !row.productionOk).length,
      localReady: rows.filter((row) => row.localOk).length,
      productionReady: rows.filter((row) => row.productionOk).length,
      total: rows.length,
    },
  };
}

function latestSandboxProviderForLaunch(state, providerId) {
  const runs = [...(state.providerValidationRuns ?? [])].sort((left, right) =>
    Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? ''));
  for (const run of runs) {
    const provider = (run.providers ?? []).find((candidate) =>
      candidate.id === providerId || scheduleProviderIdForSandboxProvider(candidate.id) === providerId);
    if (provider) {
      return {
        ...provider,
        recordedAt: run.recordedAt ?? run.generatedAt ?? null,
        reportDigest: run.reportDigest ?? null,
        runId: run.id ?? null,
        runStatus: run.status ?? null,
      };
    }
  }
  return null;
}

function providerLaunchCommands(providerId) {
  const commandMap = {
    session: {
      evidence: [
        'SIGNAL_SESSION_SECRET=<local-session-secret> SIGNAL_REQUIRE_SIGNED_SESSION=true npm run admin -- session token usr_admin --json',
        'SIGNAL_SESSION_SECRET=<local-session-secret> npm run admin -- session verify <token> --json',
        'npm run admin -- backend --env-file ./.env.production --json',
      ],
      launch: [
        'SIGNAL_REQUIRE_SIGNED_SESSION=true npm run api',
      ],
      replay: 'SIGNAL_SESSION_SECRET=<local-session-secret> npm run admin -- session verify <token> --json',
    },
    gmail: {
      evidence: [
        'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
        'SIGNAL_GMAIL_ACCESS_TOKEN=<gmail-sandbox-token> npm run admin -- mailboxes watch mbx_gmail_sales --live-provider --json',
      ],
      launch: [
        'npm run admin -- mailboxes watch mbx_gmail_sales --live-provider',
        'npm run admin -- mailboxes sync mbx_gmail_sales --live-provider',
      ],
      replay: 'curl -X POST http://127.0.0.1:8787/api/webhooks/gmail -H "Authorization: Bearer <admin-token>" -d @gmail-pubsub-event.json',
    },
    outlook: {
      evidence: [
        'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
        'SIGNAL_OUTLOOK_ACCESS_TOKEN=<outlook-sandbox-token> npm run admin -- mailboxes renew-watch watch_outlook_mbx_outlook_success --live-provider --json',
      ],
      launch: [
        'npm run admin -- mailboxes renew-watch watch_outlook_mbx_outlook_success --live-provider',
        'npm run admin -- mailboxes sync mbx_outlook_success --live-provider',
      ],
      replay: 'curl -X POST http://127.0.0.1:8787/api/webhooks/outlook -H "Authorization: Bearer <admin-token>" -d @outlook-change-event.json',
    },
    'outbound-email': {
      evidence: [
        'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
        'npm run admin -- notifications digest tenant_demo --live-provider',
      ],
      launch: [
        'npm run admin -- notifications digest tenant_demo --live-provider',
        'SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET=<email-webhook-secret> npm run admin -- notifications webhook-signed ./email-event.json <Signal-Email-Signature>',
      ],
      replay: 'SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET=<email-webhook-secret> npm run admin -- notifications webhook-signed ./email-event.json <Signal-Email-Signature>',
    },
    stripe: {
      evidence: [
        'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
        'npm run admin -- payments checkout tenant_demo plan_team --live-provider',
        'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>',
      ],
      launch: [
        'npm run admin -- payments checkout tenant_demo plan_team --live-provider',
        'npm run admin -- payments portal tenant_demo --live-provider',
      ],
      replay: 'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>',
    },
  };
  return commandMap[providerId] ?? { evidence: [], launch: [], replay: null };
}

function providerLaunchEvidence(providerId) {
  const evidenceMap = {
    session: [
      'Signed session token can be issued and verified.',
      'Production backend requires signed sessions and disables raw actor fallback.',
      'Admin/member API access is role checked against durable membership records.',
    ],
    gmail: [
      'OAuth callback and token vault configuration are present.',
      'Sandbox Gmail API check passes and saved evidence artifact verifies.',
      'Live watch registration and Pub/Sub webhook replay reach /api/webhooks/gmail.',
    ],
    outlook: [
      'Graph OAuth callback and token vault configuration are present.',
      'Sandbox Microsoft Graph check passes and saved evidence artifact verifies.',
      'Subscription renewal, lifecycle notices, and webhook replay reach /api/webhooks/outlook.',
    ],
    'outbound-email': [
      'Provider-backed digest handoff succeeds through generic or SendGrid delivery.',
      'Signed delivery-status webhook replay updates the local delivery ledger.',
      'Unsubscribe and SendGrid compliance settings are configured for production sends.',
    ],
    stripe: [
      'Checkout and billing portal handoffs succeed against Stripe test mode.',
      'Signed Stripe webhook replay updates subscription, invoice, and entitlement state.',
      'Failed payment, cancelation, recovery, and resubscription lifecycle notices reconcile.',
    ],
  };
  return evidenceMap[providerId] ?? [];
}

function providerLaunchOwner(providerId) {
  if (providerId === 'session') {
    return 'security';
  }
  if (providerId === 'stripe') {
    return 'billing';
  }
  return 'integrations';
}

function providerLaunchStatus({ configured, launchReady, sandboxRequired, sandboxStatus, scheduleReady }) {
  if (launchReady) {
    return 'production_ready';
  }
  if (!configured) {
    return 'needs_config';
  }
  if (sandboxRequired && sandboxStatus !== 'passed') {
    return 'needs_sandbox';
  }
  if (sandboxRequired && !scheduleReady) {
    return 'needs_schedule';
  }
  return 'needs_proof';
}

function providerLaunchStringLooksUnsafe(value) {
  const text = String(value);
  return (
    /sk_(?:live|test)_[A-Za-z0-9_]{8,}/.test(text) ||
    /SG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text) ||
    /ya29\.[A-Za-z0-9_-]{20,}/.test(text) ||
    /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY)[A-Z0-9_]*=(?!<)[^\s]{8,}/i.test(text) ||
    /(?:access_token|refresh_token|client_secret|api_key)=((?!<)[^&\s]{8,})/i.test(text)
  );
}

function providerLaunchUnsafePaths(value, prefix = '') {
  if (typeof value === 'string') {
    return providerLaunchStringLooksUnsafe(value) ? [prefix || '<root>'] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => providerLaunchUnsafePaths(child, `${prefix}[${index}]`));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    const currentPath = prefix ? `${prefix}.${key}` : key;
    return providerLaunchUnsafePaths(child, currentPath);
  });
}

export function providerLaunchMatrixReport(state, {
  backend = null,
  env = process.env,
  provider = providerReadiness(env),
} = {}) {
  const signedSession = backendCheckById(backend, 'signed_session_enforced');
  const reportRows = provider.providers.map((item) => {
    const sandboxRequired = item.id !== 'session';
    const schedule = (state.providerValidationSchedules ?? []).find((candidate) => candidate.providerId === item.id) ?? null;
    const sandboxProvider = latestSandboxProviderForLaunch(state, item.id);
    const sandboxStatus = sandboxRequired ? (sandboxProvider?.status ?? 'not_recorded') : (signedSession?.ok ? 'passed' : 'not_applicable');
    const scheduleReady = !sandboxRequired || schedule?.status === 'active';
    const configurationReady = item.ready && (item.id !== 'session' || Boolean(signedSession?.ok || env.SIGNAL_SESSION_SECRET));
    const sandboxReady = !sandboxRequired || sandboxStatus === 'passed';
    const launchReady = Boolean(configurationReady && sandboxReady && scheduleReady);
    const commands = providerLaunchCommands(item.id);
    const missingEnv = item.missingRequired ?? [];
    return {
      id: item.id,
      label: item.id === 'outbound-email' ? 'SendGrid / Outbound Email Provider' : item.label,
      category: item.category,
      owner: providerLaunchOwner(item.id),
      provider: item.provider,
      boundary: item.boundary,
      callbackPath: item.callbackPath,
      webhookPath: item.webhookPath,
      configurationReady,
      configuredRequired: item.configuredRequired ?? [],
      missingEnv,
      requiredEnv: item.requiredEnv ?? [],
      optionalEnv: item.optionalEnv ?? [],
      sandboxRequired,
      sandboxStatus,
      latestEvidenceAt: sandboxProvider?.recordedAt ?? null,
      latestEvidenceRunId: sandboxProvider?.runId ?? null,
      latestEvidenceDigest: sandboxProvider?.reportDigest ?? null,
      latestProviderRequestIds: sandboxProvider?.checks?.map((check) => check.providerRequestId).filter(Boolean) ?? [],
      schedule: schedule
        ? {
            cadence: schedule.cadence,
            lastRunAt: schedule.lastRunAt ?? null,
            lastRunStatus: schedule.lastRunStatus ?? null,
            nextRunAt: schedule.nextRunAt ?? null,
            status: schedule.status,
          }
        : null,
      scheduleReady,
      requiredEvidence: providerLaunchEvidence(item.id),
      evidenceCommands: commands.evidence,
      launchCommands: commands.launch,
      signedReplayCommand: commands.replay,
      localAgentCommand: item.id === 'session'
        ? 'npm run admin -- backend --env-file ./.env.production --json'
        : 'npm run admin -- provider-launch --env-file ./.env.production --json',
      launchReady,
      status: providerLaunchStatus({
        configured: configurationReady,
        launchReady,
        sandboxRequired,
        sandboxStatus,
        scheduleReady,
      }),
    };
  });
  const launchMatrix = {
    generatedAt: new Date().toISOString(),
    ok: true,
    productionReady: reportRows.every((row) => row.launchReady),
    rows: reportRows,
    recommendation: {
      summary: 'Use provider-launch as the provider-by-provider handoff between configuration, saved sandbox evidence, live watch/send/payment commands, and signed webhook replay proof.',
      productionGuardrail: 'Do not enable production Gmail, Outlook, SendGrid/outbound email, Stripe, or signed-session traffic until each provider row is production_ready with current external evidence.',
      localAgentCommand: 'npm run admin -- provider-launch --env-file ./.env.production --json',
    },
    summary: {
      blocked: reportRows.filter((row) => !row.launchReady).length,
      configured: reportRows.filter((row) => row.configurationReady).length,
      launchReady: reportRows.filter((row) => row.launchReady).length,
      missingRequiredEnv: reportRows.reduce((count, row) => count + row.missingEnv.length, 0),
      sandboxPassed: reportRows.filter((row) => row.sandboxRequired && row.sandboxStatus === 'passed').length,
      sandboxRequired: reportRows.filter((row) => row.sandboxRequired).length,
      scheduledActive: reportRows.filter((row) => row.sandboxRequired && row.schedule?.status === 'active').length,
      secretSafe: false,
      total: reportRows.length,
    },
  };
  launchMatrix.summary.secretSafe = providerLaunchUnsafePaths(launchMatrix).length === 0;
  return launchMatrix;
}

function providerHandoffPriority(row) {
  const base = {
    session: 10,
    gmail: 20,
    outlook: 30,
    'outbound-email': 40,
    stripe: 50,
  }[row.id] ?? 90;
  if (!row.configurationReady) {
    return base;
  }
  if (row.sandboxRequired && row.sandboxStatus !== 'passed') {
    return base + 100;
  }
  if (row.sandboxRequired && !row.scheduleReady) {
    return base + 200;
  }
  return base + 300;
}

function providerSandboxRequiredEnv(providerId) {
  const sandboxEnv = {
    gmail: ['SIGNAL_GMAIL_ACCESS_TOKEN'],
    outlook: ['SIGNAL_OUTLOOK_ACCESS_TOKEN'],
    'outbound-email': ['SIGNAL_SENDGRID_API_KEY', 'SIGNAL_EMAIL_PROVIDER_TOKEN'],
    stripe: ['STRIPE_SECRET_KEY', 'SIGNAL_STRIPE_PRICE_TEAM'],
  };
  return sandboxEnv[providerId] ?? [];
}

function providerScheduleCommand(providerId) {
  if (providerId === 'session') {
    return null;
  }
  const cadence = providerId === 'outbound-email' ? 'weekly' : 'daily';
  return `npm run admin -- integrations schedule ${providerId} ${cadence} --json`;
}

function providerHandoffActionFromRow(row) {
  const evidence = [
    row.boundary,
    `${row.configuredRequired.length}/${row.requiredEnv.length} required env name(s) configured`,
    row.sandboxRequired ? `Sandbox status: ${row.sandboxStatus}` : 'Sandbox proof not required',
    row.schedule ? `Schedule ${row.schedule.status} (${row.schedule.cadence})` : 'No provider validation schedule',
  ];
  if (!row.configurationReady) {
    return {
      id: `${row.id}_configuration`,
      providerId: row.id,
      label: `${row.label} configuration`,
      owner: row.owner,
      status: 'needs_config',
      priority: providerHandoffPriority(row),
      blocker: row.missingEnv.length
        ? `Configure ${row.missingEnv.slice(0, 4).join(', ')}${row.missingEnv.length > 4 ? ', ...' : ''}.`
        : 'Configuration proof is missing.',
      evidence,
      requiredEnv: row.missingEnv,
      command: row.localAgentCommand,
      followUpCommands: row.evidenceCommands.slice(0, 3),
    };
  }
  if (row.sandboxRequired && row.sandboxStatus !== 'passed') {
    return {
      id: `${row.id}_sandbox`,
      providerId: row.id,
      label: `${row.label} sandbox evidence`,
      owner: row.owner,
      status: 'needs_sandbox',
      priority: providerHandoffPriority(row),
      blocker: 'Run sandbox validation with real provider sandbox credentials and save sanitized evidence.',
      evidence: [
        ...evidence,
        row.latestEvidenceAt ? `Latest evidence ${row.sandboxStatus} at ${row.latestEvidenceAt}` : 'No passing saved provider evidence',
      ],
      requiredEnv: providerSandboxRequiredEnv(row.id),
      command: row.evidenceCommands[0] ?? 'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
      followUpCommands: row.evidenceCommands.slice(1, 4),
    };
  }
  if (row.sandboxRequired && !row.scheduleReady) {
    const scheduleCommand = providerScheduleCommand(row.id) ?? 'npm run admin -- integrations run-scheduled --json';
    return {
      id: `${row.id}_schedule`,
      providerId: row.id,
      label: `${row.label} validation schedule`,
      owner: 'operations',
      status: 'needs_schedule',
      priority: providerHandoffPriority(row),
      blocker: 'Provider validation schedule must be active before production launch.',
      evidence,
      requiredEnv: [],
      command: scheduleCommand,
      followUpCommands: ['npm run admin -- integrations run-scheduled --force --json'],
    };
  }
  return {
    id: `${row.id}_proof`,
    providerId: row.id,
    label: `${row.label} launch proof`,
    owner: row.owner,
    status: row.launchReady ? 'ready' : 'needs_proof',
    priority: providerHandoffPriority(row),
    blocker: row.launchReady ? 'No blocker.' : 'Launch command and signed webhook replay proof are still required.',
    evidence: [
      ...evidence,
      ...(row.requiredEvidence ?? []).slice(0, 2),
    ],
    requiredEnv: [],
    command: row.launchCommands[0] ?? row.signedReplayCommand ?? row.localAgentCommand,
    followUpCommands: [
      ...(row.launchCommands ?? []).slice(1, 3),
      row.signedReplayCommand,
    ].filter(Boolean),
  };
}

export function providerHandoffReport(state, {
  backend = null,
  env = process.env,
  launch = null,
  provider = providerReadiness(env),
  statePath = resolveStatePath(),
} = {}) {
  const currentBackend = backend ?? backendReadiness({ env, statePath });
  const providerMatrix = launch ?? providerLaunchMatrixReport(state, {
    backend: currentBackend,
    env,
    provider,
  });
  const actions = (providerMatrix.rows ?? [])
    .filter((row) => !row.launchReady)
    .map(providerHandoffActionFromRow)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  const nextAction = actions[0] ?? {
    id: 'provider_launch_evidence',
    providerId: 'all',
    label: 'Provider launch evidence package',
    owner: 'integrations',
    status: 'ready_for_proof',
    priority: 500,
    blocker: 'All provider rows are launch-ready; export and verify the sanitized evidence artifact.',
    evidence: [`${providerMatrix.summary.launchReady}/${providerMatrix.summary.total} provider launch rows ready`],
    requiredEnv: [],
    command: 'npm run admin -- integrations evidence-export latest ./signal-provider-evidence.json --json',
    followUpCommands: ['npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json'],
  };
  const runnableCommands = uniqueValues([
    'npm run admin -- provider-launch --json',
    'npm run admin -- provider-handoff --json',
    'npm run admin -- integrations --json',
    'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
    'npm run admin -- integrations run-scheduled --force --json',
    'npm run admin -- payment-lifecycle --json',
    'npm run admin -- operations-health --json',
    nextAction.command,
    ...(nextAction.followUpCommands ?? []),
  ].filter(Boolean));
  const report = {
    generatedAt: new Date().toISOString(),
    ok: true,
    productionReady: providerMatrix.productionReady,
    nextAction,
    actions,
    launch: {
      productionReady: providerMatrix.productionReady,
      configured: providerMatrix.summary.configured,
      launchReady: providerMatrix.summary.launchReady,
      missingRequiredEnv: providerMatrix.summary.missingRequiredEnv,
      sandboxPassed: providerMatrix.summary.sandboxPassed,
      sandboxRequired: providerMatrix.summary.sandboxRequired,
      scheduledActive: providerMatrix.summary.scheduledActive,
      total: providerMatrix.summary.total,
    },
    providerRows: providerMatrix.rows.map((row) => ({
      id: row.id,
      label: row.label,
      owner: row.owner,
      status: row.status,
      configurationReady: row.configurationReady,
      sandboxStatus: row.sandboxStatus,
      scheduleReady: row.scheduleReady,
      launchReady: row.launchReady,
      missingEnv: row.missingEnv,
      localAgentCommand: row.localAgentCommand,
    })),
    recommendation: {
      summary: 'Use provider-handoff after backend-handoff: it ranks signed-session, Gmail, Outlook, SendGrid/outbound email, and Stripe launch work for the local agent.',
      productionGuardrail: 'This report stays secret-safe and never treats placeholder or missing provider proof as production-ready. Production launch still requires saved sandbox evidence, signed webhook replay, active schedules, and launch-gate proof.',
      localAgentCommand: 'npm run admin -- provider-handoff --env-file ./.env.production --json',
    },
    runnableCommands,
    summary: {
      blocked: actions.length,
      configured: providerMatrix.summary.configured,
      launchReady: providerMatrix.summary.launchReady,
      missingRequiredEnv: providerMatrix.summary.missingRequiredEnv,
      nextActionId: nextAction.id,
      productionReady: providerMatrix.productionReady,
      sandboxPassed: providerMatrix.summary.sandboxPassed,
      sandboxRequired: providerMatrix.summary.sandboxRequired,
      scheduledActive: providerMatrix.summary.scheduledActive,
      secretSafe: false,
      total: providerMatrix.summary.total,
    },
  };
  report.summary.secretSafe = providerLaunchUnsafePaths(report).length === 0;
  report.ok = report.summary.secretSafe && Boolean(providerMatrix.ok);
  return report;
}

const lifecyclePlaybookCatalog = [
  {
    id: 'workspace_registration_invites',
    label: 'Workspace registration, creation, and member invitation',
    category: 'onboarding',
    triggers: ['workspace_onboarding'],
    owner: 'workspace_admin',
    severity: 'info',
    notificationFlow: 'Admin onboarding reminder plus invite claim/acceptance audit events.',
    userAction: 'Register the workspace, claim the invite, and finish mailbox plus digest setup.',
    adminAction: 'Review the registered workspace, invite members by role/team, accept claimed users, and watch seat usage.',
    commands: [
      'npm run admin -- tenants register "New Workspace" newco.example admin@newco.example "Admin User" plan_team',
      'curl -X POST http://127.0.0.1:8787/api/registration',
      'npm run admin -- users invite tenant_demo rep@example.com member sales',
      'npm run admin -- users claim <inviteCode> "Member Name"',
      'npm run admin -- users accept <inviteId>',
      'npm run admin -- onboarding-readiness --json',
    ],
    evidence: (state, summary) => [
      `${summary.tenants ?? 0} workspace(s)`,
      `${summary.activeMemberships ?? 0}/${summary.memberships ?? 0} active memberships`,
      `${summary.pendingInvites ?? 0}/${summary.invites ?? 0} pending invites`,
      `${summary.activeSeats ?? 0}+${summary.pendingInviteSeats ?? 0}/${summary.seatLimit ?? 'unlimited'} active+pending seats`,
    ],
    localOk: (state, summary) => (summary.tenants ?? 0) > 0 && (summary.admins ?? 0) > 0 && (summary.activeMemberships ?? 0) > 0,
  },
  {
    id: 'multi_member_rbac_privacy',
    label: 'Multi-member org, RBAC, and member data privacy',
    category: 'access',
    triggers: ['tenant_suspended'],
    owner: 'security',
    severity: 'critical',
    notificationFlow: 'Admins get access-boundary notices; members see only owned/team-routed work.',
    userAction: 'Use the assigned workspace role and manage only owned sources, notifications, and account actions.',
    adminAction: 'Resolve membership role/status before every admin, source, billing, and privacy mutation.',
    commands: [
      'npm run admin -- users --json',
      'npm run admin -- users role <userId> member sales',
      'npm run admin -- users disable <userId>',
      'npm run admin -- session token usr_admin --json',
      'npm run admin -- onboarding-readiness --json',
    ],
    evidence: (state, summary) => [
      `${summary.admins ?? 0} active admin(s)`,
      `${summary.activeMemberships ?? 0} active membership(s)`,
      `${summary.apiSessions ?? 0} API session record(s)`,
      `${state.modelGovernancePolicies?.filter((policy) => policy.dataBoundary === 'tenant_isolated').length ?? 0} tenant-isolated model governance policy row(s)`,
    ],
    localOk: (state, summary) => (summary.admins ?? 0) > 0 &&
      (summary.activeMemberships ?? 0) > 1 &&
      (state.modelGovernancePolicies ?? []).every((policy) => policy.dataBoundary === 'tenant_isolated'),
  },
  {
    id: 'user_focus_priority_notifications',
    label: 'User focus, priorities, outcomes, and notifications',
    category: 'notification',
    triggers: ['email_delivery_failed'],
    owner: 'customer_success',
    severity: 'watch',
    notificationFlow: 'Immediate alerts, daily/weekly digests, mute rules, and account ownership route outcomes per user.',
    userAction: 'Set digest cadence, mute noisy accounts or signal types, and act on assigned account recommendations.',
    adminAction: 'Tune routing rules, ownership, thresholds, and notification preferences without creating separate org models.',
    commands: [
      'npm run admin -- notifications preference usr_sales daily immediate',
      'npm run admin -- notifications mute-account usr_product Acme Health',
      'npm run admin -- signals assign sig_risk_001 usr_sales',
      'npm run admin -- notifications digest tenant_demo',
      'npm run admin -- accounts action <actionId> completed',
    ],
    evidence: (state, summary) => [
      `${summary.activeRoutingRules ?? 0}/${summary.routingRules ?? 0} active routing rule(s)`,
      `${state.notificationPreferences?.length ?? 0} notification preference record(s)`,
      `${summary.openAccountRecommendations ?? 0}/${summary.accountRecommendations ?? 0} open recommendation(s)`,
      `${summary.unreadNotifications ?? 0}/${summary.notificationEvents ?? 0} unread notification(s)`,
    ],
    localOk: (state, summary) => (summary.activeRoutingRules ?? 0) > 0 &&
      (state.notificationPreferences?.length ?? 0) >= (summary.activeMemberships ?? 0),
  },
  {
    id: 'mailbox_disconnect_reauth',
    label: 'Mailbox disconnect, reconnect, and source privacy recovery',
    category: 'source',
    triggers: ['mailbox_needs_reauth', 'mailbox_disconnected', 'mailbox_paused'],
    owner: 'integrations',
    severity: 'critical',
    notificationFlow: 'Source owners and admins get reconnect tasks; raw credentials stay in the vault boundary.',
    userAction: 'Reconnect the mailbox through a scoped auth link or disconnect a source no longer needed.',
    adminAction: 'Create a signed provider auth link, complete the connection, replay sync, or disconnect the source.',
    commands: [
      'npm run admin -- mailboxes connect-url tenant_demo gmail usr_sales',
      'npm run admin -- mailboxes complete <connectionSessionId>',
      'npm run admin -- mailboxes disconnect <mailboxId>',
      'npm run admin -- mailboxes replay <mailboxId>',
      'npm run admin -- lifecycle --json',
    ],
    evidence: (state, summary) => [
      `${summary.connectedMailboxes ?? 0}/${summary.mailboxes ?? 0} connected mailbox source(s)`,
      `${summary.mailboxConnectionSessions ?? 0} connection session(s)`,
      `${summary.blockedSyncCursors ?? 0} blocked sync cursor(s)`,
      `${summary.activeEmailWatchSubscriptions ?? 0}/${summary.emailWatchSubscriptions ?? 0} active provider watch(es)`,
    ],
    localOk: (state, summary) => (summary.mailboxes ?? 0) > 0 && (summary.blockedSyncCursors ?? 0) === 0,
  },
  {
    id: 'provider_backoff_watch',
    label: 'Provider watch, rate-limit, and retry backoff handling',
    category: 'provider',
    triggers: ['provider_sync_backoff', 'provider_watch_attention'],
    owner: 'integrations',
    severity: 'watch',
    notificationFlow: 'Admin operations sees active provider backoff and worker queue state before customers are spammed.',
    userAction: 'No user action unless a source reconnect is required.',
    adminAction: 'Respect Retry-After, renew watches, replay source cursors, and run scheduled provider validation.',
    commands: [
      'npm run admin -- mailboxes renew-watch <watchId>',
      'npm run admin -- mailboxes replay <mailboxId>',
      'npm run admin -- integrations run-scheduled --json',
      'npm run scheduler -- --once --dry-run --json',
      'npm run admin -- operations-health --json',
    ],
    evidence: (state, summary) => [
      `${summary.activeProviderValidationSchedules ?? 0}/${summary.providerValidationSchedules ?? 0} active provider validation schedule(s)`,
      `${summary.dueProviderValidationSchedules ?? 0} due validation schedule(s)`,
      `${summary.failedJobs ?? 0} failed job(s)`,
      `${summary.expiringEmailWatchSubscriptions ?? 0} expiring email watch(es)`,
    ],
    localOk: (state, summary) => (summary.failedJobs ?? 0) === 0,
  },
  {
    id: 'outbound_email_delivery',
    label: 'Email notification delivery, unsubscribe, and webhook reconciliation',
    category: 'notification',
    triggers: ['email_delivery_failed'],
    owner: 'communications',
    severity: 'watch',
    notificationFlow: 'Digest delivery creates provider messages; signed delivery webhooks reconcile sent, failed, bounced, and suppressed states.',
    userAction: 'Update notification preferences, unsubscribe, or mute account/signal types.',
    adminAction: 'Run digest, review failed delivery webhooks, replay signed status events, and keep suppression rules honored.',
    commands: [
      'npm run admin -- notifications digest tenant_demo',
      'npm run admin -- notifications delivery-status <messageId> sent',
      'SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET=<email-webhook-secret> npm run admin -- notifications webhook-signed ./email-event.json <Signal-Email-Signature>',
      'SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY=<sendgrid-public-key> npm run admin -- notifications sendgrid-webhook-signed ./sendgrid-events.json <signature> <timestamp>',
      'npm run admin -- notifications unsubscribe usr_product',
    ],
    evidence: (state, summary) => [
      `${summary.digestRuns ?? 0} digest run(s)`,
      `${summary.failedEmailDeliveries ?? 0}/${summary.emailDeliveries ?? 0} failed email delivery record(s)`,
      `${summary.unsubscribedUsers ?? 0} unsubscribed user(s)`,
      `${summary.unreadNotifications ?? 0}/${summary.notificationEvents ?? 0} unread notification(s)`,
    ],
    localOk: (state, summary) => (summary.failedEmailDeliveries ?? 0) === 0 &&
      (state.notificationPreferences?.length ?? 0) > 0,
  },
  {
    id: 'failed_payment_recovery',
    label: 'Failed payment, dunning, and recovery session handling',
    category: 'payment',
    triggers: ['payment_failed', 'invoice_open', 'payment_recovery_ready'],
    owner: 'billing',
    severity: 'critical',
    notificationFlow: 'Billing owner receives recovery notice; admins can create Checkout/Billing recovery handoffs and signed webhook replays.',
    userAction: 'Open the recovery link or billing portal to update payment method.',
    adminAction: 'Use Stripe Billing state as source of truth, create a recovery session, and wait for signed invoice webhooks.',
    commands: [
      'npm run admin -- payments recover <invoiceId>',
      'npm run admin -- payments portal tenant_demo --live-provider',
      'npm run admin -- payments webhook invoice.payment_failed sub_demo',
      'npm run admin -- payments webhook invoice.paid sub_demo',
      'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>',
    ],
    evidence: (state, summary) => [
      `${summary.openInvoices ?? 0}/${summary.invoices ?? 0} open invoice(s)`,
      `${summary.billingSessions ?? 0} billing session(s)`,
      `${summary.paymentEvents ?? 0} payment event(s)`,
      `${summary.activeEntitlements ?? 0} active entitlement(s)`,
    ],
    localOk: (state, summary) => (summary.openInvoices ?? 0) === 0 &&
      (summary.billingSessions ?? 0) > 0 &&
      (summary.paymentEvents ?? 0) > 0,
  },
  {
    id: 'cancel_resubscription',
    label: 'Cancellation, resubscription, and subscription starting point',
    category: 'payment',
    triggers: ['subscription_canceled', 'resubscription_ready', 'checkout_ready', 'subscription_starting_point', 'portal_ready'],
    owner: 'billing',
    severity: 'watch',
    notificationFlow: 'Cancellation opens an admin/user checkout path; active subscriptions expose portal and entitlement sync.',
    userAction: 'Start checkout for resubscription or open the billing portal for an active plan.',
    adminAction: 'Cancel only through the billing source of truth, then create Checkout or Portal sessions for the tenant.',
    commands: [
      'npm run admin -- payments cancel sub_demo',
      'npm run admin -- payments checkout tenant_demo plan_team',
      'npm run admin -- payments checkout tenant_demo plan_team --live-provider',
      'npm run admin -- payments portal tenant_demo --live-provider',
      'npm run admin -- payments sync tenant_demo',
    ],
    evidence: (state, summary) => [
      `${summary.subscriptions ?? 0} subscription record(s)`,
      `${summary.activeEntitlements ?? 0} active entitlement(s)`,
      `${summary.activeBillingOverrides ?? 0}/${summary.billingOverrides ?? 0} active billing override(s)`,
      `${summary.billingSessions ?? 0} billing session(s)`,
    ],
    localOk: (state, summary) => (summary.subscriptions ?? 0) > 0 && (summary.activeEntitlements ?? 0) > 0,
  },
];

function lifecyclePlaybookStatus({ critical, open, observed, localOk }) {
  if (critical > 0 || !localOk) {
    return 'attention';
  }
  if (open > 0) {
    return 'action_ready';
  }
  if (observed > 0) {
    return 'observed';
  }
  return 'ready';
}

function compactLifecyclePlaybookNotice(notice) {
  return {
    actionLabel: notice.actionLabel ?? null,
    actionTarget: notice.actionTarget ?? null,
    id: notice.id,
    severity: notice.severity,
    status: notice.status,
    title: notice.title,
    trigger: notice.trigger,
    updatedAt: notice.updatedAt ?? notice.createdAt ?? null,
  };
}

export function lifecyclePlaybookReport(state, {
  backend = null,
  statePath = resolveStatePath(),
} = {}) {
  const summary = summarizeState(state, statePath);
  const notices = [...(state.lifecycleNotices ?? [])];
  const rows = lifecyclePlaybookCatalog.map((item) => {
    const matchingNotices = notices.filter((notice) => item.triggers.includes(notice.trigger));
    const openNotices = matchingNotices.filter((notice) => notice.status === 'open');
    const criticalNotices = openNotices.filter((notice) => notice.severity === 'critical');
    const evidence = item.evidence(state, summary);
    const localOk = Boolean(item.localOk(state, summary)) && criticalNotices.length === 0;
    return {
      id: item.id,
      label: item.label,
      category: item.category,
      triggers: item.triggers,
      owner: item.owner,
      severity: criticalNotices.length ? 'critical' : openNotices.length ? 'watch' : item.severity,
      notificationFlow: item.notificationFlow,
      userAction: item.userAction,
      adminAction: item.adminAction,
      commands: item.commands,
      evidence,
      notices: matchingNotices.slice(0, 5).map(compactLifecyclePlaybookNotice),
      open: openNotices.length,
      critical: criticalNotices.length,
      observed: matchingNotices.length,
      latestAt: latestIso(matchingNotices, ['updatedAt', 'createdAt']),
      sampleNoticeId: matchingNotices[0]?.id ?? null,
      localOk,
      status: lifecyclePlaybookStatus({
        critical: criticalNotices.length,
        localOk,
        observed: matchingNotices.length,
        open: openNotices.length,
      }),
    };
  });
  const report = {
    generatedAt: new Date().toISOString(),
    ok: true,
    productionReady: Boolean(backend?.productionReady),
    rows,
    recommendation: {
      summary: 'Use lifecycle-playbook when answering onboarding, RBAC/privacy, source disconnect, notification, failed payment, cancellation, and resubscription QA from the same admin boundary.',
      productionGuardrail: 'This playbook proves the local handling model. Production still needs durable tenant isolation, managed auth, live provider sandbox evidence, signed webhooks, and scheduler/alert routing before customer traffic.',
      localAgentCommand: 'npm run admin -- lifecycle-playbook --json',
    },
    summary: {
      actionReady: rows.filter((row) => row.status === 'action_ready').length,
      attention: rows.filter((row) => row.status === 'attention').length,
      criticalNotices: rows.reduce((total, row) => total + row.critical, 0),
      observed: rows.filter((row) => row.observed > 0).length,
      openNotices: rows.reduce((total, row) => total + row.open, 0),
      ready: rows.filter((row) => row.status === 'ready' || row.status === 'observed').length,
      secretSafe: false,
      total: rows.length,
    },
  };
  report.summary.secretSafe = providerLaunchUnsafePaths(report).length === 0;
  report.ok = report.summary.secretSafe && rows.length === lifecyclePlaybookCatalog.length;
  return report;
}

function paymentLifecycleAuditRow({
  area,
  check,
  evidence = [],
  localOk,
  productionOk,
  recommendation,
  requiredEnv = [],
  commands = [],
}) {
  return {
    area,
    check,
    evidence,
    localOk: Boolean(localOk),
    productionOk: Boolean(productionOk),
    recommendation,
    requiredEnv,
    commands,
    status: localOk ? (productionOk ? 'production_ready' : 'needs_live_provider') : 'attention',
  };
}

function countPaymentTypes(items) {
  return items.reduce((counts, item) => {
    const key = item?.type ?? item?.trigger ?? item?.status ?? 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

export function paymentLifecycleAuditReport(state, {
  backend = null,
  provider = providerReadiness(),
  providerLaunch = null,
  statePath = resolveStatePath(),
} = {}) {
  const summary = summarizeState(state, statePath);
  const tenantId = defaultTenantId(state);
  const tenant = (state.tenants ?? []).find((item) => item.id === tenantId) ?? state.tenants?.[0] ?? null;
  const subscriptions = (state.subscriptions ?? []).filter((subscription) => !tenant?.id || subscription.tenantId === tenant.id);
  const activeSubscriptions = subscriptions.filter((subscription) => ['trialing', 'active'].includes(subscription.status));
  const canceledSubscriptions = subscriptions.filter((subscription) => subscription.status === 'canceled');
  const entitlements = (state.entitlements ?? []).filter((entitlement) => !tenant?.id || entitlement.tenantId === tenant.id);
  const activeEntitlements = entitlements.filter((entitlement) => entitlement.status === 'active');
  const invoices = (state.invoices ?? []).filter((invoice) => !tenant?.id || invoice.tenantId === tenant.id);
  const openInvoices = invoices.filter((invoice) => ['open', 'past_due'].includes(invoice.status));
  const paidInvoices = invoices.filter((invoice) => invoice.status === 'paid');
  const sessions = (state.billingSessions ?? []).filter((session) => !tenant?.id || session.tenantId === tenant.id);
  const sessionCounts = countPaymentTypes(sessions);
  const paymentEvents = (state.paymentEvents ?? []).filter((event) => !tenant?.id || event.tenantId === tenant.id);
  const eventCounts = countPaymentTypes(paymentEvents);
  const paymentNotices = (state.lifecycleNotices ?? []).filter((notice) => (!tenant?.id || notice.tenantId === tenant.id) && notice.category === 'payment');
  const noticeCounts = countPaymentTypes(paymentNotices);
  const billingJobs = (state.jobs ?? []).filter((job) => (!tenant?.id || job.tenantId === tenant.id) && job.queue === 'billing_webhook');
  const failedBillingJobs = billingJobs.filter((job) => job.status === 'failed');
  const billingOverrides = (state.billingOverrides ?? []).filter((override) => !tenant?.id || override.tenantId === tenant.id);
  const signedStripeEvents = paymentEvents.filter((event) => event.provider === 'stripe' && event.signatureStatus === 'verified');
  const signedEventIds = signedStripeEvents.map((event) => event.providerEventId).filter(Boolean);
  const duplicateSignedEventIds = signedEventIds.filter((id, index) => signedEventIds.indexOf(id) !== index);
  const launch = providerLaunch ?? providerLaunchMatrixReport(state, { backend, provider });
  const stripeLaunch = launch.rows.find((row) => row.id === 'stripe') ?? null;
  const stripeConfigured = Boolean(stripeLaunch?.configurationReady);
  const stripeSandboxPassed = stripeLaunch?.sandboxStatus === 'passed';
  const stripeLaunchReady = Boolean(stripeLaunch?.launchReady);
  const activeSubscription = activeSubscriptions[0] ?? subscriptions[0] ?? null;
  const activeEntitlement = activeEntitlements[0] ?? entitlements[0] ?? null;

  const rows = [
    paymentLifecycleAuditRow({
      area: 'subscription_starting_point',
      check: 'Workspace registration or checkout creates a subscription, billing owner, entitlement, checkout session, payment event, and lifecycle notice.',
      evidence: [
        `${subscriptions.length} subscription record(s), ${activeSubscriptions.length} active/trialing`,
        `${activeEntitlements.length}/${entitlements.length} active entitlement record(s)`,
        `${sessionCounts.checkout ?? 0} checkout session(s)`,
        `${noticeCounts.subscription_starting_point ?? 0} subscription starting-point notice(s)`,
      ],
      localOk: Boolean(tenant?.billingOwnerUserId && activeSubscription && activeEntitlement && (sessionCounts.checkout ?? 0) > 0),
      productionOk: stripeLaunchReady,
      recommendation: 'Use Stripe Billing plus Checkout Sessions for recurring SaaS start, with local registration creating only auditable local bootstrap state.',
      requiredEnv: stripeLaunch?.requiredEnv ?? ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SIGNAL_STRIPE_PRICE_TEAM'],
      commands: ['npm run admin -- tenants register New_Workspace newco.example owner@newco.example Owner_Name plan_team', 'npm run admin -- payments checkout tenant_demo plan_team --live-provider'],
    }),
    paymentLifecycleAuditRow({
      area: 'checkout_portal_self_service',
      check: 'Billing owners can create Checkout and Billing Portal sessions while admins retain local CLI recovery controls.',
      evidence: [
        `${sessionCounts.checkout ?? 0} checkout session(s)`,
        `${sessionCounts.portal ?? 0} portal session(s)`,
        `${paymentEvents.filter((event) => event.type === 'checkout.session.created').length} checkout created event(s)`,
        `${paymentEvents.filter((event) => event.type === 'billing_portal.session.created').length} portal created event(s)`,
      ],
      localOk: (sessionCounts.checkout ?? 0) > 0 && (sessionCounts.portal ?? 0) > 0,
      productionOk: stripeConfigured && stripeSandboxPassed,
      recommendation: 'Keep self-service plan changes in Stripe Checkout and Customer Portal instead of manual PaymentIntent renewal loops.',
      requiredEnv: stripeLaunch?.requiredEnv ?? ['STRIPE_SECRET_KEY', 'SIGNAL_STRIPE_PRICE_TEAM'],
      commands: ['npm run admin -- payments checkout tenant_demo plan_team --live-provider', 'npm run admin -- payments portal tenant_demo --live-provider'],
    }),
    paymentLifecycleAuditRow({
      area: 'failed_payment_recovery',
      check: 'Failed invoices create recovery sessions, lifecycle notices, billing jobs, and webhook-driven paid/recovered state.',
      evidence: [
        `${eventCounts['invoice.payment_failed'] ?? 0} failed-payment event(s)`,
        `${sessionCounts.payment_recovery ?? 0} payment recovery session(s)`,
        `${paidInvoices.length}/${invoices.length} paid invoice record(s)`,
        `${failedBillingJobs.length}/${billingJobs.length} failed billing_webhook job(s)`,
      ],
      localOk: (eventCounts['invoice.payment_failed'] ?? 0) > 0 &&
        (sessionCounts.payment_recovery ?? 0) > 0 &&
        (eventCounts['invoice.paid'] ?? 0) > 0 &&
        failedBillingJobs.length === 0,
      productionOk: stripeLaunchReady && signedStripeEvents.some((event) => event.appliedType === 'invoice.payment_failed') && signedStripeEvents.some((event) => event.appliedType === 'invoice.paid'),
      recommendation: 'Use Stripe dunning/webhooks as the source of truth, then expose local recovery sessions and lifecycle notices for admins and billing owners.',
      requiredEnv: ['STRIPE_WEBHOOK_SECRET', 'STRIPE_SECRET_KEY'],
      commands: ['npm run admin -- payments recover <invoiceId>', 'npm run admin -- payments webhook invoice.payment_failed sub_demo', 'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>'],
    }),
    paymentLifecycleAuditRow({
      area: 'cancel_resubscribe',
      check: 'Cancellation and resubscription use subscription state, entitlement recomputation, checkout handoff, and lifecycle notices.',
      evidence: [
        `${canceledSubscriptions.length} canceled subscription record(s)`,
        `${eventCounts['subscription.canceled'] ?? 0} cancellation event(s)`,
        `${noticeCounts.subscription_canceled ?? 0} cancellation notice(s)`,
        `${sessionCounts.checkout ?? 0} checkout/resubscription handoff(s)`,
      ],
      localOk: (canceledSubscriptions.length > 0 || (eventCounts['subscription.canceled'] ?? 0) > 0) &&
        (sessionCounts.checkout ?? 0) > 0 &&
        activeEntitlements.length > 0,
      productionOk: stripeLaunchReady,
      recommendation: 'Cancel through the billing source of truth, recompute entitlements, then route resubscription through Checkout or Portal.',
      requiredEnv: stripeLaunch?.requiredEnv ?? ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SIGNAL_STRIPE_PRICE_TEAM'],
      commands: ['npm run admin -- payments cancel sub_demo', 'npm run admin -- payments checkout tenant_demo plan_team', 'npm run admin -- payments sync tenant_demo'],
    }),
    paymentLifecycleAuditRow({
      area: 'entitlement_source_of_truth',
      check: 'Product access is computed from subscription, invoice, and override state rather than browser-provided billing counters.',
      evidence: [
        `${activeEntitlement?.status ?? 'missing'} entitlement from ${activeEntitlement?.source ?? 'missing source'}`,
        `${billingOverrides.filter((override) => override.status === 'active').length}/${billingOverrides.length} active billing override(s)`,
        `${openInvoices.length}/${invoices.length} open invoice(s)`,
        `${summary.activeSeats ?? 0}/${summary.seatLimit ?? 'unlimited'} active seats`,
      ],
      localOk: activeEntitlements.length > 0 && openInvoices.length === 0 && failedBillingJobs.length === 0,
      productionOk: stripeLaunchReady,
      recommendation: 'Compute entitlements from stored provider-backed billing state and keep override records revocable and audited.',
      requiredEnv: ['STRIPE_WEBHOOK_SECRET', 'SIGNAL_STATE_SERVICE_URL', 'DATABASE_URL'],
      commands: ['npm run admin -- payments sync tenant_demo', 'npm run admin -- payments override tenant_demo beta_access Beta_extension plan_beta', 'npm run admin -- payments override-revoke <overrideId> Resolved'],
    }),
    paymentLifecycleAuditRow({
      area: 'signed_webhook_replay',
      check: 'Signed Stripe-style webhook replay deduplicates provider events and updates subscription, invoice, and entitlement records.',
      evidence: [
        `${signedStripeEvents.length} verified Stripe webhook event(s)`,
        `${duplicateSignedEventIds.length} duplicate provider event id(s)`,
        `${paymentEvents.filter((event) => event.providerEventId).length} provider event id(s) recorded`,
        `${paymentEvents.filter((event) => event.appliedType).length} applied provider event(s)`,
      ],
      localOk: signedStripeEvents.length > 0 && duplicateSignedEventIds.length === 0,
      productionOk: stripeLaunchReady && stripeSandboxPassed,
      recommendation: 'Treat signed provider webhooks as the production subscription source of truth and reject unsigned or replayed event payloads.',
      requiredEnv: ['STRIPE_WEBHOOK_SECRET'],
      commands: ['STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-sign ./stripe-event.json', 'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>'],
    }),
    paymentLifecycleAuditRow({
      area: 'stripe_launch_evidence',
      check: 'Stripe production launch needs configured prices/secrets, Billing Checkout/Portal sandbox proof, signed webhook replay, and active validation schedule.',
      evidence: [
        `configuration ${stripeConfigured ? 'ready' : 'missing'}`,
        `sandbox ${stripeLaunch?.sandboxStatus ?? 'not_recorded'}`,
        `schedule ${stripeLaunch?.schedule?.status ?? 'missing'}`,
        `${stripeLaunch?.missingEnv?.length ?? 0} missing required env name(s)`,
      ],
      localOk: Boolean(stripeLaunch),
      productionOk: stripeLaunchReady,
      recommendation: 'Before production traffic, run the Stripe sandbox evidence path and save sanitized provider evidence.',
      requiredEnv: stripeLaunch?.requiredEnv ?? ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SIGNAL_STRIPE_PRICE_TEAM'],
      commands: ['npm run admin -- provider-launch --env-file ./.env.production --json', 'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json'],
    }),
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    ok: rows.every((row) => row.localOk),
    productionReady: rows.every((row) => row.productionOk),
    tenant: tenant
      ? {
          id: tenant.id,
          name: tenant.name,
          domain: tenant.domain,
          billingOwnerUserId: tenant.billingOwnerUserId ?? null,
          ownerUserId: tenant.ownerUserId ?? null,
          status: tenant.status,
        }
      : null,
    backend: {
      mode: backend?.mode ?? (isHttpResource(statePath) ? 'external-service' : 'local-json'),
      productionReady: backend?.productionReady ?? false,
      statePath,
    },
    provider: {
      stripeConfigured,
      stripeLaunchReady,
      stripeSandboxPassed,
      stripeStatus: stripeLaunch?.status ?? 'missing',
    },
    issues: rows.filter((row) => !row.localOk).map((row) => `${row.area}: ${row.check}`),
    recommendation: {
      summary: 'Use payment-lifecycle as the billing-owner/admin proof surface for subscription start, failed payment, recovery, cancellation, resubscription, entitlements, and signed Stripe webhook replay.',
      productionGuardrail: 'Do not launch paid production billing until Stripe configuration, Checkout/Portal sandbox proof, signed webhook replay, provider evidence, and durable state are all production-ready.',
      localAgentCommand: 'npm run admin -- payment-lifecycle --json',
    },
    rows,
    summary: {
      activeEntitlements: activeEntitlements.length,
      canceledSubscriptions: canceledSubscriptions.length,
      checkoutSessions: sessionCounts.checkout ?? 0,
      failedBillingJobs: failedBillingJobs.length,
      localReady: rows.filter((row) => row.localOk).length,
      openInvoices: openInvoices.length,
      paymentEvents: paymentEvents.length,
      portalSessions: sessionCounts.portal ?? 0,
      productionReady: rows.filter((row) => row.productionOk).length,
      recoverySessions: sessionCounts.payment_recovery ?? 0,
      signedWebhookEvents: signedStripeEvents.length,
      total: rows.length,
    },
  };
  return report;
}

function paymentLifecycleRowByArea(report, area) {
  return report?.rows?.find?.((row) => row.area === area) ?? null;
}

function paymentHandoffStep({
  blocker,
  command,
  completion,
  env = process.env,
  evidence = [],
  followUpCommands = [],
  id,
  label,
  owner = 'billing',
  priority,
  productionOk = false,
  requiredEnv = [],
  rollbackCommand = null,
}) {
  const configuredEnv = configuredKeys(env, requiredEnv);
  const missingEnv = missingKeys(env, requiredEnv);
  return {
    id,
    label,
    owner,
    priority,
    status: productionOk ? 'ready' : 'needs_proof',
    localOk: true,
    productionOk: Boolean(productionOk),
    requiredEnv: uniqueValues(requiredEnv),
    configuredEnv,
    missingEnv,
    evidence,
    blocker,
    command,
    followUpCommands,
    rollbackCommand,
    completion,
  };
}

export function paymentHandoffReport(state, {
  backend = null,
  env = process.env,
  launchGate = null,
  paymentLifecycle = null,
  provider = providerReadiness(env),
  providerLaunch = null,
  readiness = null,
  statePath = resolveStatePath(),
} = {}) {
  const currentBackend = backend ?? backendReadiness({ env, statePath });
  const product = readiness ?? productReadinessReport(state, { backend: currentBackend, provider });
  const launch = providerLaunch ?? providerLaunchMatrixReport(state, { backend: currentBackend, env, provider });
  const gate = launchGate ?? launchGateReport(state, { backend: currentBackend, provider, readiness: product });
  const payment = paymentLifecycle ?? paymentLifecycleAuditReport(state, {
    backend: currentBackend,
    provider,
    providerLaunch: launch,
    statePath,
  });
  const paymentGate = launchGateById(gate, 'payment_launch');
  const stripeRow = providerLaunchById(launch, 'stripe');
  const subscriptionStart = paymentLifecycleRowByArea(payment, 'subscription_starting_point');
  const checkoutPortal = paymentLifecycleRowByArea(payment, 'checkout_portal_self_service');
  const failedPayment = paymentLifecycleRowByArea(payment, 'failed_payment_recovery');
  const cancelResubscribe = paymentLifecycleRowByArea(payment, 'cancel_resubscribe');
  const entitlementTruth = paymentLifecycleRowByArea(payment, 'entitlement_source_of_truth');
  const signedWebhook = paymentLifecycleRowByArea(payment, 'signed_webhook_replay');
  const stripeEvidence = paymentLifecycleRowByArea(payment, 'stripe_launch_evidence');
  const stripeRequiredEnv = stripeRow?.requiredEnv?.length ? stripeRow.requiredEnv : ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SIGNAL_STRIPE_PRICE_TEAM'];
  const stripeSandboxEnv = providerSandboxRequiredEnv('stripe');
  const checkoutEnv = uniqueValues(['STRIPE_SECRET_KEY', 'SIGNAL_STRIPE_PRICE_TEAM']);
  const webhookEnv = ['STRIPE_WEBHOOK_SECRET'];
  const billingStateEnv = ['SIGNAL_STATE_SERVICE_URL', 'DATABASE_URL'];
  const paymentLaunchReady = Boolean(paymentGate?.status === 'pass' && payment.productionReady && stripeRow?.launchReady);
  const rows = [
    paymentHandoffStep({
      id: 'configure_stripe_env',
      label: 'Configure Stripe billing environment',
      priority: 10,
      env,
      productionOk: Boolean(stripeRow?.configurationReady),
      requiredEnv: stripeRequiredEnv,
      evidence: [
        stripeRow ? `${stripeRow.label}: ${stripeRow.status}` : 'Stripe launch row missing',
        `${stripeRow?.missingEnv?.length ?? stripeRequiredEnv.length} missing Stripe env name(s)`,
      ],
      blocker: stripeRow?.configurationReady ? 'None' : 'Stripe secret, webhook secret, or team price env is missing.',
      command: 'npm run admin -- provider-launch --env-file ./.env.production --json',
      followUpCommands: ['npm run admin -- payment-handoff --env-file ./.env.production --json'],
      rollbackCommand: 'Keep live Stripe provider mode disabled until configuration, sandbox evidence, and signed webhook replay pass.',
      completion: 'Stripe launch row reports configuration-ready with required env names present and no credential values serialized.',
    }),
    paymentHandoffStep({
      id: 'prove_checkout_portal',
      label: 'Prove Checkout and Billing Portal handoffs',
      priority: 20,
      env,
      productionOk: Boolean(checkoutPortal?.productionOk),
      requiredEnv: checkoutEnv,
      evidence: checkoutPortal?.evidence ?? [],
      blocker: checkoutPortal?.productionOk ? 'None' : 'Checkout and Billing Portal proof still needs live Stripe sandbox execution.',
      command: 'npm run admin -- payments checkout tenant_demo plan_team --live-provider',
      followUpCommands: ['npm run admin -- payments portal tenant_demo --live-provider', 'npm run admin -- payment-lifecycle --env-file ./.env.production --json'],
      rollbackCommand: 'Disable live checkout controls and keep local checkout sessions only until Stripe sandbox sessions succeed.',
      completion: 'Stripe Checkout and Billing Portal sessions succeed in test mode and local session metadata remains secret-safe.',
    }),
    paymentHandoffStep({
      id: 'prove_signed_webhook_replay',
      label: 'Prove signed Stripe webhook replay',
      priority: 30,
      env,
      productionOk: Boolean(signedWebhook?.productionOk),
      requiredEnv: webhookEnv,
      evidence: signedWebhook?.evidence ?? [],
      blocker: signedWebhook?.productionOk ? 'None' : 'Signed Stripe webhook replay has not produced production-ready subscription, invoice, and entitlement evidence.',
      command: 'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>',
      followUpCommands: ['STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-sign ./stripe-event.json', 'npm run admin -- payment-lifecycle --json'],
      rollbackCommand: 'Reject unsigned or stale webhook payloads; keep entitlement state driven by verified local events only.',
      completion: 'Verified Stripe webhook replay updates subscriptions, invoices, entitlements, and deduplicates provider event ids.',
    }),
    paymentHandoffStep({
      id: 'prove_failed_payment_recovery',
      label: 'Prove failed payment recovery and dunning',
      priority: 40,
      env,
      productionOk: Boolean(failedPayment?.productionOk),
      requiredEnv: webhookEnv,
      evidence: failedPayment?.evidence ?? [],
      blocker: failedPayment?.productionOk ? 'None' : 'Failed-payment and paid-invoice recovery need signed Stripe evidence.',
      command: 'npm run admin -- payments recover <invoiceId>',
      followUpCommands: ['npm run admin -- payments webhook invoice.payment_failed sub_demo', 'npm run admin -- payments webhook invoice.paid sub_demo'],
      rollbackCommand: 'Keep restricted entitlements in place for past-due invoices until a signed paid invoice event is verified.',
      completion: 'Past-due invoice, recovery session, lifecycle notice, and signed paid-invoice replay reconcile without failed billing jobs.',
    }),
    paymentHandoffStep({
      id: 'prove_cancel_resubscribe_entitlements',
      label: 'Prove cancellation, resubscription, and entitlements',
      priority: 50,
      env,
      productionOk: Boolean(cancelResubscribe?.productionOk && entitlementTruth?.productionOk && subscriptionStart?.productionOk),
      requiredEnv: uniqueValues([...stripeRequiredEnv, ...billingStateEnv]),
      evidence: [
        ...(subscriptionStart?.evidence ?? []),
        ...(cancelResubscribe?.evidence ?? []),
        ...(entitlementTruth?.evidence ?? []),
      ],
      blocker: cancelResubscribe?.productionOk && entitlementTruth?.productionOk && subscriptionStart?.productionOk
        ? 'None'
        : 'Subscription starting point, cancellation/resubscription, and entitlement source-of-truth need production Stripe plus durable state proof.',
      command: 'npm run admin -- payments sync tenant_demo',
      followUpCommands: ['npm run admin -- payments cancel sub_demo', 'npm run admin -- payments checkout tenant_demo plan_team --live-provider'],
      rollbackCommand: 'Use billing overrides only as audited temporary access; revoke overrides after Stripe source-of-truth recovery.',
      completion: 'Registration/checkout, cancellation, resubscription, entitlement recomputation, and audited override rollback all reconcile.',
    }),
    paymentHandoffStep({
      id: 'save_stripe_sandbox_evidence',
      label: 'Save Stripe sandbox evidence',
      priority: 60,
      env,
      productionOk: Boolean(stripeRow?.launchReady && stripeEvidence?.productionOk),
      requiredEnv: uniqueValues([...stripeSandboxEnv, ...stripeRequiredEnv]),
      evidence: [
        `Sandbox: ${stripeRow?.sandboxStatus ?? 'not_recorded'}`,
        `Schedule: ${stripeRow?.schedule?.status ?? 'missing'}`,
        ...(stripeEvidence?.evidence ?? []),
      ],
      blocker: stripeRow?.launchReady && stripeEvidence?.productionOk ? 'None' : 'Stripe sandbox validation evidence is missing or not passed.',
      command: 'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
      followUpCommands: ['npm run admin -- integrations evidence-export latest ./signal-provider-evidence.json --json'],
      rollbackCommand: 'Do not package launch evidence until sanitized Stripe sandbox evidence imports/exports cleanly.',
      completion: 'Saved sandbox evidence proves Stripe price lookup, Checkout/Portal, signed webhook replay, and validation schedule readiness.',
    }),
    paymentHandoffStep({
      id: 'package_payment_launch_evidence',
      label: 'Package redacted payment launch evidence',
      priority: 70,
      env,
      productionOk: paymentLaunchReady,
      evidence: [
        paymentGate?.evidence?.join(' | ') ?? 'Payment launch gate not evaluated.',
        `${payment.summary.productionReady}/${payment.summary.total} payment lifecycle production row(s) ready`,
        stripeRow ? `${stripeRow.label}: ${stripeRow.status}` : 'Stripe launch row missing',
      ],
      blocker: paymentLaunchReady ? 'None' : 'Payment launch evidence cannot be packaged until Stripe launch, lifecycle, sandbox, and gate proof all pass.',
      command: 'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json',
      followUpCommands: ['npm run admin -- launch-gate verify-package ./signal-launch-evidence.json --json'],
      rollbackCommand: 'Reject the launch package if payment gate, signed webhook, or Stripe sandbox proof is missing.',
      completion: 'Launch evidence package includes payment lifecycle, provider launch, signed webhook replay, Stripe sandbox, and entitlement proof without credentials.',
    }),
  ];
  const nextStep = rows.find((row) => !row.productionOk) ?? {
    id: 'payment_handoff_complete',
    label: 'Payment launch evidence complete',
    owner: 'billing',
    priority: 100,
    status: 'ready',
    localOk: true,
    productionOk: true,
    requiredEnv: [],
    configuredEnv: [],
    missingEnv: [],
    evidence: [`${rows.length}/${rows.length} payment handoff steps ready`],
    blocker: 'None',
    command: 'npm run admin -- launch-gate --env-file ./.env.production --json',
    followUpCommands: ['npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json'],
    rollbackCommand: 'Keep payment rollback notes attached to the launch package.',
    completion: 'Payment proof is complete; continue through remaining launch gates.',
  };
  const report = {
    generatedAt: new Date().toISOString(),
    ok: true,
    productionReady: paymentLaunchReady,
    nextStep,
    rows,
    payment: {
      ok: payment.ok,
      productionReady: payment.productionReady,
      localReady: payment.summary.localReady,
      total: payment.summary.total,
      signedWebhookEvents: payment.summary.signedWebhookEvents,
      openInvoices: payment.summary.openInvoices,
      activeEntitlements: payment.summary.activeEntitlements,
    },
    provider: {
      stripeConfigured: Boolean(stripeRow?.configurationReady),
      stripeLaunchReady: Boolean(stripeRow?.launchReady),
      stripeSandboxStatus: stripeRow?.sandboxStatus ?? 'missing',
      stripeScheduleStatus: stripeRow?.schedule?.status ?? 'missing',
      stripeStatus: stripeRow?.status ?? 'missing',
    },
    recommendation: {
      summary: 'Use payment-handoff after payment-lifecycle to move Stripe billing from local proof to launch evidence.',
      productionGuardrail: 'Do not enable paid production billing until Stripe configuration, Checkout/Portal sandbox proof, signed webhook replay, failed-payment recovery, entitlement source-of-truth, saved sandbox evidence, and launch package verification all pass.',
      localAgentCommand: 'npm run admin -- payment-handoff --env-file ./.env.production --json',
    },
    runnableCommands: uniqueValues([
      'npm run admin -- payment-handoff --json',
      'npm run admin -- payment-handoff --env-file ./.env.production --json',
      'curl http://127.0.0.1:8787/api/payment-handoff',
      'npm run admin -- payment-lifecycle --json',
      'npm run admin -- provider-launch --env-file ./.env.production --json',
      'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
      nextStep.command,
      nextStep.rollbackCommand,
      ...nextStep.followUpCommands,
    ].filter(Boolean)),
    summary: {
      blocked: rows.filter((row) => !row.productionOk).length,
      configuredEnv: uniqueValues(rows.flatMap((row) => row.configuredEnv ?? [])).length,
      localReady: payment.summary.localReady,
      missingRequiredEnv: uniqueValues(rows.flatMap((row) => row.missingEnv ?? [])).length,
      nextStepId: nextStep.id,
      productionReady: rows.filter((row) => row.productionOk).length,
      secretSafe: false,
      total: rows.length,
    },
  };
  report.summary.secretSafe = providerLaunchUnsafePaths(report).length === 0;
  report.ok = report.summary.secretSafe && rows.length === 7;
  return report;
}

function emailHandoffStep({
  blocker,
  command,
  completion,
  env = process.env,
  evidence = [],
  followUpCommands = [],
  id,
  label,
  owner = 'integrations',
  priority,
  productionOk = false,
  requiredEnv = [],
  rollbackCommand = null,
}) {
  const configuredEnv = configuredKeys(env, requiredEnv);
  const missingEnv = missingKeys(env, requiredEnv);
  return {
    id,
    label,
    owner,
    priority,
    status: productionOk ? 'ready' : 'needs_proof',
    localOk: true,
    productionOk: Boolean(productionOk),
    requiredEnv: uniqueValues(requiredEnv),
    configuredEnv,
    missingEnv,
    evidence,
    blocker,
    command,
    followUpCommands,
    rollbackCommand,
    completion,
  };
}

function operationsWebhookByChannel(report, channel) {
  return report?.webhooks?.find?.((row) => row.channel === channel) ?? null;
}

function operationsQueueByName(report, queue) {
  return report?.queues?.find?.((row) => row.queue === queue) ?? null;
}

export function emailHandoffReport(state, {
  backend = null,
  env = process.env,
  launchGate = null,
  lifecyclePlaybook = null,
  operations = null,
  provider = providerReadiness(env),
  providerLaunch = null,
  readiness = null,
  statePath = resolveStatePath(),
} = {}) {
  const currentBackend = backend ?? backendReadiness({ env, statePath });
  const product = readiness ?? productReadinessReport(state, { backend: currentBackend, provider });
  const launch = providerLaunch ?? providerLaunchMatrixReport(state, { backend: currentBackend, env, provider });
  const gate = launchGate ?? launchGateReport(state, { backend: currentBackend, provider, readiness: product });
  const health = operations ?? operationsHealthReport(state, { backend: currentBackend, statePath });
  const lifecycle = lifecyclePlaybook ?? lifecyclePlaybookReport(state, { backend: currentBackend, statePath });
  const summary = summarizeState(state, statePath);
  const emailGate = launchGateById(gate, 'email_notification_launch');
  const gmailRow = providerLaunchById(launch, 'gmail');
  const outlookRow = providerLaunchById(launch, 'outlook');
  const outboundRow = providerLaunchById(launch, 'outbound-email');
  const emailRows = [gmailRow, outlookRow, outboundRow].filter(Boolean);
  const gmailRequiredEnv = gmailRow?.requiredEnv?.length
    ? gmailRow.requiredEnv
    : ['SIGNAL_GMAIL_CLIENT_ID', 'SIGNAL_GMAIL_CLIENT_SECRET', 'SIGNAL_GMAIL_REDIRECT_URI', 'SIGNAL_TOKEN_ENCRYPTION_KEY'];
  const outlookRequiredEnv = outlookRow?.requiredEnv?.length
    ? outlookRow.requiredEnv
    : ['SIGNAL_OUTLOOK_CLIENT_ID', 'SIGNAL_OUTLOOK_CLIENT_SECRET', 'SIGNAL_OUTLOOK_TENANT_ID', 'SIGNAL_OUTLOOK_REDIRECT_URI', 'SIGNAL_TOKEN_ENCRYPTION_KEY'];
  const outboundRequiredEnv = outboundRow?.requiredEnv?.length
    ? outboundRow.requiredEnv
    : ['SIGNAL_EMAIL_PROVIDER_URL', 'SIGNAL_EMAIL_PROVIDER_TOKEN', 'SIGNAL_EMAIL_FROM', 'SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET'];
  const emailSandboxEnv = uniqueValues([
    ...providerSandboxRequiredEnv('gmail'),
    ...providerSandboxRequiredEnv('outlook'),
    ...providerSandboxRequiredEnv('outbound-email'),
  ]);
  const webhookEnv = ['SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET'];
  const sendGridWebhookEnv = ['SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY'];
  const gmailWebhook = operationsWebhookByChannel(health, 'gmail');
  const outlookWebhook = operationsWebhookByChannel(health, 'outlook');
  const outboundWebhook = operationsWebhookByChannel(health, 'outbound_email');
  const emailSyncQueue = operationsQueueByName(health, 'email_sync');
  const notificationQueue = operationsQueueByName(health, 'notification_digest');
  const outboundQueue = operationsQueueByName(health, 'outbound_email');
  const outboundPlaybook = lifecycle.rows?.find?.((row) => row.id === 'outbound_email_delivery') ?? null;
  const watchPlaybook = lifecycle.rows?.find?.((row) => row.id === 'provider_backoff_watch') ?? null;
  const signedDeliveryMessages = (state.emailDeliveryMessages ?? []).filter((message) => message.providerSignatureStatus === 'verified');
  const signedDeliveryEventIds = signedDeliveryMessages
    .flatMap((message) => message.providerEventIds ?? (message.providerEventId ? [message.providerEventId] : []))
    .filter(Boolean);
  const duplicateSignedDeliveryEventIds = signedDeliveryEventIds.filter((id, index) => signedDeliveryEventIds.indexOf(id) !== index);
  const activeEmailProviderSchedules = (state.providerValidationSchedules ?? []).filter((schedule) =>
    ['gmail', 'outlook', 'outbound-email'].includes(schedule.providerId) &&
    schedule.status === 'active').length;
  const providerLaunchReady = emailRows.length === 3 && emailRows.every((row) => row.launchReady);
  const emailSandboxPassed = emailRows.length === 3 && emailRows.every((row) => row.sandboxStatus === 'passed');
  const watchProofReady = Boolean(
    gmailRow?.launchReady &&
    outlookRow?.launchReady &&
    gmailWebhook?.localOk &&
    outlookWebhook?.localOk &&
    emailSyncQueue?.failed === 0 &&
    (summary.activeEmailWatchSubscriptions ?? 0) >= 2
  );
  const digestProofReady = Boolean(
    outboundRow?.launchReady &&
    outboundWebhook?.localOk &&
    notificationQueue?.failed === 0 &&
    outboundQueue?.failed === 0 &&
    (summary.digestRuns ?? 0) > 0 &&
    (summary.failedEmailDeliveries ?? 0) === 0
  );
  const signedWebhookReady = signedDeliveryMessages.length > 0 && duplicateSignedDeliveryEventIds.length === 0;
  const emailLaunchReady = Boolean(emailGate?.status === 'pass' && providerLaunchReady && emailSandboxPassed && digestProofReady && signedWebhookReady);
  const rows = [
    emailHandoffStep({
      id: 'configure_gmail_env',
      label: 'Configure Gmail OAuth and watch environment',
      priority: 10,
      env,
      productionOk: Boolean(gmailRow?.configurationReady),
      requiredEnv: gmailRequiredEnv,
      evidence: [
        gmailRow ? `${gmailRow.label}: ${gmailRow.status}` : 'Gmail launch row missing',
        `${gmailRow?.missingEnv?.length ?? gmailRequiredEnv.length} missing Gmail env name(s)`,
        gmailWebhook?.status ? `Webhook health: ${gmailWebhook.status}` : 'Gmail webhook health not evaluated',
      ],
      blocker: gmailRow?.configurationReady ? 'None' : 'Gmail OAuth/watch env is missing or placeholder-only.',
      command: 'npm run admin -- provider-launch --env-file ./.env.production --json',
      followUpCommands: ['npm run admin -- email-handoff --env-file ./.env.production --json'],
      rollbackCommand: 'Keep Gmail live watch mode disabled until OAuth env, sandbox proof, and watch replay pass.',
      completion: 'Gmail provider launch row is configuration-ready and no credential values are serialized.',
    }),
    emailHandoffStep({
      id: 'configure_outlook_env',
      label: 'Configure Outlook OAuth and Graph webhook environment',
      priority: 20,
      env,
      productionOk: Boolean(outlookRow?.configurationReady),
      requiredEnv: outlookRequiredEnv,
      evidence: [
        outlookRow ? `${outlookRow.label}: ${outlookRow.status}` : 'Outlook launch row missing',
        `${outlookRow?.missingEnv?.length ?? outlookRequiredEnv.length} missing Outlook env name(s)`,
        outlookWebhook?.status ? `Webhook health: ${outlookWebhook.status}` : 'Outlook webhook health not evaluated',
      ],
      blocker: outlookRow?.configurationReady ? 'None' : 'Outlook OAuth/Graph env is missing or placeholder-only.',
      command: 'npm run admin -- provider-launch --env-file ./.env.production --json',
      followUpCommands: ['npm run admin -- email-handoff --env-file ./.env.production --json'],
      rollbackCommand: 'Keep Outlook live watch renewal disabled until OAuth env, sandbox proof, and notification replay pass.',
      completion: 'Outlook provider launch row is configuration-ready and no credential values are serialized.',
    }),
    emailHandoffStep({
      id: 'configure_outbound_email_env',
      label: 'Configure outbound digest email environment',
      priority: 30,
      env,
      productionOk: Boolean(outboundRow?.configurationReady),
      requiredEnv: outboundRequiredEnv,
      evidence: [
        outboundRow ? `${outboundRow.label}: ${outboundRow.status}` : 'Outbound email launch row missing',
        `${outboundRow?.missingEnv?.length ?? outboundRequiredEnv.length} missing outbound email env name(s)`,
        outboundWebhook?.status ? `Delivery webhook health: ${outboundWebhook.status}` : 'Outbound webhook health not evaluated',
      ],
      blocker: outboundRow?.configurationReady ? 'None' : 'SendGrid/outbound email provider env or signed delivery webhook secret is missing.',
      command: 'npm run admin -- provider-launch --env-file ./.env.production --json',
      followUpCommands: ['npm run admin -- notifications digest tenant_demo --live-provider'],
      rollbackCommand: 'Keep live outbound email sends disabled and use local delivery records until provider proof passes.',
      completion: 'Outbound provider row is configuration-ready and digest delivery can use the provider without exposing tokens.',
    }),
    emailHandoffStep({
      id: 'save_email_sandbox_evidence',
      label: 'Save Gmail, Outlook, and outbound email sandbox evidence',
      priority: 40,
      env,
      productionOk: emailSandboxPassed && activeEmailProviderSchedules >= 3,
      requiredEnv: emailSandboxEnv,
      evidence: [
        `Gmail sandbox: ${gmailRow?.sandboxStatus ?? 'not_recorded'}`,
        `Outlook sandbox: ${outlookRow?.sandboxStatus ?? 'not_recorded'}`,
        `Outbound email sandbox: ${outboundRow?.sandboxStatus ?? 'not_recorded'}`,
        `${activeEmailProviderSchedules}/3 active email provider validation schedule(s)`,
      ],
      blocker: emailSandboxPassed && activeEmailProviderSchedules >= 3 ? 'None' : 'Saved provider sandbox evidence or active validation schedules are missing for email providers.',
      command: 'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
      followUpCommands: ['npm run admin -- integrations evidence-export latest ./signal-provider-evidence.json --json', 'npm run admin -- integrations run-scheduled --force --json'],
      rollbackCommand: 'Do not package email launch evidence until sanitized provider evidence imports/exports cleanly.',
      completion: 'Saved sandbox evidence proves Gmail watch, Outlook notification, outbound send, and active validation schedules.',
    }),
    emailHandoffStep({
      id: 'prove_watch_and_sync_launch',
      label: 'Prove Gmail and Outlook watch plus sync launch',
      priority: 50,
      env,
      productionOk: watchProofReady,
      requiredEnv: uniqueValues([...providerSandboxRequiredEnv('gmail'), ...providerSandboxRequiredEnv('outlook')]),
      evidence: [
        `${summary.activeEmailWatchSubscriptions ?? 0}/${summary.emailWatchSubscriptions ?? 0} active email watch subscription(s)`,
        `Gmail webhook: ${gmailWebhook?.status ?? 'missing'}`,
        `Outlook webhook: ${outlookWebhook?.status ?? 'missing'}`,
        `Email sync queue failed jobs: ${emailSyncQueue?.failed ?? 0}`,
        `Watch playbook: ${watchPlaybook?.status ?? 'not_evaluated'}`,
      ],
      blocker: watchProofReady ? 'None' : 'Live Gmail/Outlook watch setup, renewal, sync, or webhook proof is missing.',
      command: 'npm run admin -- mailboxes watch mbx_gmail_sales --live-provider',
      followUpCommands: ['npm run admin -- mailboxes renew-watch watch_outlook_mbx_outlook_success --live-provider', 'npm run admin -- operations-health --json'],
      rollbackCommand: 'Pause or renew only the affected watch and keep local replay mode available while provider backoff is active.',
      completion: 'Gmail and Outlook live watches are active, webhooks are healthy, and email_sync has no failed queue blockers.',
    }),
    emailHandoffStep({
      id: 'prove_outbound_digest_delivery',
      label: 'Prove outbound digest delivery',
      priority: 60,
      env,
      productionOk: digestProofReady,
      requiredEnv: providerSandboxRequiredEnv('outbound-email'),
      evidence: [
        `${summary.digestRuns ?? 0} digest run(s)`,
        `${summary.failedEmailDeliveries ?? 0}/${summary.emailDeliveries ?? 0} failed delivery record(s)`,
        `Notification queue failed jobs: ${notificationQueue?.failed ?? 0}`,
        `Outbound queue failed jobs: ${outboundQueue?.failed ?? 0}`,
        `Delivery playbook: ${outboundPlaybook?.status ?? 'not_evaluated'}`,
      ],
      blocker: digestProofReady ? 'None' : 'Outbound digest send proof, clean queue state, or provider delivery evidence is missing.',
      command: 'npm run admin -- notifications digest tenant_demo --live-provider',
      followUpCommands: ['npm run admin -- notifications --json', 'npm run admin -- operations-health --json'],
      rollbackCommand: 'Disable live outbound provider mode and keep dashboard notifications/local delivery ledger active until delivery proof passes.',
      completion: 'Live-provider digest send records delivery status without failed outbound_email or notification_digest jobs.',
    }),
    emailHandoffStep({
      id: 'replay_signed_delivery_webhooks',
      label: 'Replay signed delivery webhooks',
      priority: 70,
      env,
      productionOk: signedWebhookReady,
      requiredEnv: uniqueValues([...webhookEnv, ...sendGridWebhookEnv]),
      evidence: [
        `${signedDeliveryMessages.length} verified email delivery webhook message(s)`,
        `${duplicateSignedDeliveryEventIds.length} duplicate provider delivery event id(s)`,
        `${summary.emailDeliveries ?? 0} delivery ledger record(s)`,
      ],
      blocker: signedWebhookReady ? 'None' : 'Signed generic/SendGrid delivery webhook replay has not produced verified, deduplicated delivery records.',
      command: 'SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET=<email-webhook-secret> npm run admin -- notifications webhook-signed ./email-event.json <Signal-Email-Signature>',
      followUpCommands: ['SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY=<sendgrid-public-key> npm run admin -- notifications sendgrid-webhook-signed ./sendgrid-events.json <signature> <timestamp>', 'npm run admin -- operations-health --json'],
      rollbackCommand: 'Reject unsigned or replayed delivery events and keep failed delivery notices visible until signed provider events reconcile.',
      completion: 'Signed generic and SendGrid delivery webhooks reconcile sent, failed, bounced, and suppressed statuses without duplicate provider event ids.',
    }),
    emailHandoffStep({
      id: 'package_email_launch_evidence',
      label: 'Package redacted email launch evidence',
      priority: 80,
      env,
      productionOk: emailLaunchReady,
      evidence: [
        emailGate?.evidence?.join(' | ') ?? 'Email launch gate not evaluated.',
        `${emailRows.filter((row) => row.launchReady).length}/3 email provider launch row(s) ready`,
        `${health.summary.totalWebhooks - health.summary.unhealthyWebhooks}/${health.summary.totalWebhooks} webhook channel(s) locally healthy`,
      ],
      blocker: emailLaunchReady ? 'None' : 'Email launch evidence cannot be packaged until provider config, sandbox proof, watches, digest sends, signed webhooks, and launch gate all pass.',
      command: 'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json',
      followUpCommands: ['npm run admin -- launch-gate verify-package ./signal-launch-evidence.json --json'],
      rollbackCommand: 'Reject launch evidence if Gmail, Outlook, outbound email, signed delivery webhooks, or operations-health proof is missing.',
      completion: 'Launch package includes email provider launch, sandbox evidence, watch/sync proof, outbound send proof, signed delivery webhooks, and rollback notes without credentials.',
    }),
  ];
  const nextStep = rows.find((row) => !row.productionOk) ?? {
    id: 'email_handoff_complete',
    label: 'Email launch evidence complete',
    owner: 'integrations',
    priority: 100,
    status: 'ready',
    localOk: true,
    productionOk: true,
    requiredEnv: [],
    configuredEnv: [],
    missingEnv: [],
    evidence: [`${rows.length}/${rows.length} email handoff steps ready`],
    blocker: 'None',
    command: 'npm run admin -- launch-gate --env-file ./.env.production --json',
    followUpCommands: ['npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json'],
    rollbackCommand: 'Keep email rollback notes attached to the launch package.',
    completion: 'Email proof is complete; continue through remaining launch gates.',
  };
  const report = {
    generatedAt: new Date().toISOString(),
    ok: true,
    productionReady: emailLaunchReady,
    nextStep,
    rows,
    email: {
      connectedMailboxes: summary.connectedMailboxes ?? 0,
      activeEmailWatchSubscriptions: summary.activeEmailWatchSubscriptions ?? 0,
      emailWatchSubscriptions: summary.emailWatchSubscriptions ?? 0,
      enabledEmailFlows: summary.enabledEmailFlows ?? 0,
      emailFlows: summary.emailFlows ?? 0,
      digestRuns: summary.digestRuns ?? 0,
      emailDeliveries: summary.emailDeliveries ?? 0,
      failedEmailDeliveries: summary.failedEmailDeliveries ?? 0,
      signedDeliveryMessages: signedDeliveryMessages.length,
      activeEmailProviderSchedules,
    },
    provider: {
      gmailConfigured: Boolean(gmailRow?.configurationReady),
      gmailLaunchReady: Boolean(gmailRow?.launchReady),
      gmailSandboxStatus: gmailRow?.sandboxStatus ?? 'missing',
      outlookConfigured: Boolean(outlookRow?.configurationReady),
      outlookLaunchReady: Boolean(outlookRow?.launchReady),
      outlookSandboxStatus: outlookRow?.sandboxStatus ?? 'missing',
      outboundConfigured: Boolean(outboundRow?.configurationReady),
      outboundLaunchReady: Boolean(outboundRow?.launchReady),
      outboundSandboxStatus: outboundRow?.sandboxStatus ?? 'missing',
    },
    operations: {
      ok: health.ok,
      productionReady: health.productionReady,
      failedDeliveries: health.summary.failedDeliveries,
      failedQueues: health.summary.failedQueues,
      activeBackoffs: health.summary.activeBackoffs,
      unhealthyWebhooks: health.summary.unhealthyWebhooks,
    },
    recommendation: {
      summary: 'Use email-handoff after provider-handoff to move Gmail, Outlook, and outbound digest email from local proof to launch evidence.',
      productionGuardrail: 'Do not enable production email ingestion or outbound digest delivery until Gmail/Outlook/outbound env, saved sandbox evidence, live watch/sync proof, signed delivery webhook replay, clean operations health, and launch evidence packaging all pass.',
      localAgentCommand: 'npm run admin -- email-handoff --env-file ./.env.production --json',
    },
    runnableCommands: uniqueValues([
      'npm run admin -- email-handoff --json',
      'npm run admin -- email-handoff --env-file ./.env.production --json',
      'curl http://127.0.0.1:8787/api/email-handoff',
      'npm run admin -- provider-launch --env-file ./.env.production --json',
      'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
      'npm run admin -- mailboxes watch mbx_gmail_sales --live-provider',
      'npm run admin -- mailboxes renew-watch watch_outlook_mbx_outlook_success --live-provider',
      'npm run admin -- notifications digest tenant_demo --live-provider',
      'SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET=<email-webhook-secret> npm run admin -- notifications webhook-signed ./email-event.json <Signal-Email-Signature>',
      'SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY=<sendgrid-public-key> npm run admin -- notifications sendgrid-webhook-signed ./sendgrid-events.json <signature> <timestamp>',
      nextStep.command,
      nextStep.rollbackCommand,
      ...nextStep.followUpCommands,
    ].filter(Boolean)),
    summary: {
      activeEmailProviderSchedules,
      blocked: rows.filter((row) => !row.productionOk).length,
      configuredEnv: uniqueValues(rows.flatMap((row) => row.configuredEnv ?? [])).length,
      localReady: product.summary.localReady,
      missingRequiredEnv: uniqueValues(rows.flatMap((row) => row.missingEnv ?? [])).length,
      nextStepId: nextStep.id,
      productionReady: rows.filter((row) => row.productionOk).length,
      secretSafe: false,
      total: rows.length,
    },
  };
  report.summary.secretSafe = providerLaunchUnsafePaths(report).length === 0;
  report.ok = report.summary.secretSafe && rows.length === 8 && Boolean(health.ok);
  return report;
}

function qaAnswerStatus({ localOk, productionOk, needsLiveProvider = false }) {
  if (!localOk) {
    return 'needs_local_work';
  }
  if (productionOk) {
    return 'production_ready';
  }
  return needsLiveProvider ? 'needs_live_provider' : 'needs_production';
}

function qaAnswerRow({
  answer,
  commands,
  evidence,
  id,
  localOk,
  owner,
  productionCaveat,
  productionOk,
  question,
  needsLiveProvider = false,
}) {
  return {
    id,
    question,
    answer,
    owner,
    evidence,
    commands,
    localOk: Boolean(localOk),
    productionOk: Boolean(productionOk),
    productionCaveat,
    status: qaAnswerStatus({ localOk, productionOk, needsLiveProvider }),
  };
}

function readinessEvidence(report, id) {
  return readinessById(report, id)?.evidence ?? [];
}

function providerLaunchById(report, id) {
  return report?.rows?.find?.((row) => row.id === id) ?? null;
}

export function qaAnswersReport(state, {
  backend = null,
  dashboardAudit = null,
  digestionPipeline = null,
  lifecyclePlaybook = null,
  onboarding = null,
  operations = null,
  provider = providerReadiness(),
  providerLaunch = null,
  readiness = null,
  statePath = resolveStatePath(),
} = {}) {
  const summary = summarizeState(state, statePath);
  const product = readiness ?? productReadinessReport(state, { backend, provider });
  const dashboard = dashboardAudit ?? dashboardAuditReport(state, { backend, statePath });
  const pipeline = digestionPipeline ?? signalDigestionPipelineReport(state, { backend, statePath });
  const onboardingReport = onboarding ?? onboardingReadinessReport(state, { backend, statePath });
  const operationsReport = operations ?? operationsHealthReport(state, { backend, statePath });
  const lifecycle = lifecyclePlaybook ?? lifecyclePlaybookReport(state, { backend, statePath });
  const launch = providerLaunch ?? providerLaunchMatrixReport(state, { backend, provider });
  const launchRows = {
    gmail: providerLaunchById(launch, 'gmail'),
    outlook: providerLaunchById(launch, 'outlook'),
    outboundEmail: providerLaunchById(launch, 'outbound-email'),
    stripe: providerLaunchById(launch, 'stripe'),
  };
  const model = readinessById(product, 'model_governance_and_tuning');
  const relationship = readinessById(product, 'relationship_dashboard_and_recommendations');
  const notifications = readinessById(product, 'notifications_and_admin_monitoring');
  const emailFlow = readinessById(product, 'email_source_and_detection_flow');
  const payments = readinessById(product, 'payment_lifecycle_and_entitlements');
  const multiUser = readinessById(product, 'multi_user_rbac_privacy');
  const onboardingWorkspace = readinessById(product, 'workspace_onboarding');
  const modelBoundaryStageReady = pipeline.rows.some((row) => row.area === 'model_learning_boundary' && row.localOk);
  const emailProductionReady = Boolean(launchRows.gmail?.launchReady && launchRows.outlook?.launchReady && launchRows.outboundEmail?.launchReady);
  const paymentProductionReady = Boolean(launchRows.stripe?.launchReady);
  const backendProductionReady = Boolean(backend?.productionReady);
  const rows = [
    qaAnswerRow({
      id: 'dashboard_calculations_backend',
      question: 'Do dashboard display calculations match the DB/backend connection?',
      answer: `Yes locally. Dashboard numbers reconcile against summarizeState from the current state boundary; the current backend mode is ${dashboard.backend.mode}. Production still needs the durable backend checks to pass before claiming DB-backed readiness.`,
      owner: 'product_platform',
      localOk: dashboard.ok,
      productionOk: backendProductionReady,
      productionCaveat: backendProductionReady
        ? 'Production backend checks are configured.'
        : 'Current app is on local-json; production DB/state-service, managed auth, CORS, scheduler, and tenant isolation are not configured.',
      evidence: [
        `${dashboard.summary.passed}/${dashboard.summary.total} dashboard audit check(s) pass`,
        `${dashboard.summary.scopedRows} actor-scoped dashboard row(s)`,
        `Backend mode: ${dashboard.backend.mode}`,
        `${backend?.summary?.readyChecks ?? 0}/${backend?.summary?.totalChecks ?? 0} production backend check(s) ready`,
      ],
      commands: [
        'npm run admin -- dashboard-audit --json',
        'curl http://127.0.0.1:8787/api/dashboard-audit',
        'npm run admin -- backend --env-file ./.env.production --json',
      ],
    }),
    qaAnswerRow({
      id: 'data_digestion_model_boundary',
      question: 'Do we need a data digestion model, model learning pipeline, or one model per org?',
      answer: 'Use a shared detector/data digestion boundary by default, with tenant-isolated data plus tenant-specific thresholds, routing, suppression, feedback labels, retention, and opt-in learning controls. Do not create one trained model per org unless a governed opt-in tuning policy is approved.',
      owner: 'ai_governance',
      localOk: Boolean(model?.localOk && modelBoundaryStageReady),
      productionOk: Boolean(model?.productionOk && pipeline.productionReady),
      productionCaveat: pipeline.recommendation.productionGuardrail,
      evidence: [
        ...readinessEvidence(product, 'model_governance_and_tuning'),
        `${pipeline.summary.localReady}/${pipeline.summary.total} digestion pipeline stage(s) locally ready`,
        `${pipeline.summary.sourceMessages} source message(s), ${pipeline.summary.generatedSignals} source-backed signal(s)`,
        `${pipeline.summary.perTenantModels} per-tenant trained model(s) enabled`,
      ],
      commands: [
        'npm run admin -- digestion-pipeline --json',
        'curl http://127.0.0.1:8787/api/digestion-pipeline',
        'npm run admin -- models --json',
        'npm run admin -- models policy tenant_demo opt_in_tuning Governance_reviewed --json',
        'npm run admin -- quality threshold tenant_demo 0.74',
      ],
    }),
    qaAnswerRow({
      id: 'multi_user_same_org_rbac',
      question: 'Can the system handle multiple users in the same org, and how is that handled?',
      answer: 'Yes locally. Multi-user orgs are handled through tenant memberships, role, team, status, owner/billing owner, seat limits, signed admin sessions, and owner/team-scoped member visibility. Production requires durable tenant isolation and managed auth before many customer orgs share one backend.',
      owner: 'security',
      localOk: Boolean(multiUser?.localOk && onboardingReport.ok),
      productionOk: Boolean(onboardingReport.productionReady && backendProductionReady),
      productionCaveat: onboardingReport.recommendation.productionGuardrail,
      evidence: [
        ...readinessEvidence(product, 'multi_user_rbac_privacy'),
        `${onboardingReport.summary.activeAdmins} active admin(s)`,
        `${onboardingReport.summary.activeMembers} active member(s)`,
        `${onboardingReport.summary.visibleSignalsForActor} signal row(s) visible for active actor`,
      ],
      commands: [
        'npm run admin -- onboarding-readiness --json',
        'curl http://127.0.0.1:8787/api/onboarding-readiness',
        'npm run admin -- users --json',
        'npm run admin -- session token usr_admin --json',
      ],
    }),
    qaAnswerRow({
      id: 'workspace_registration_invitation',
      question: 'Is user onboarding, registration, workspace creation, and member invitation complete?',
      answer: 'Yes locally. Self-service workspace registration, owner/admin registration, invite claim, admin acceptance, membership records, seats, onboarding notifications, and session switching are represented in CLI, API, and UI flows.',
      owner: 'workspace_admin',
      localOk: Boolean(onboardingWorkspace?.localOk && onboardingReport.summary.localReady === onboardingReport.summary.total),
      productionOk: Boolean(onboardingReport.productionReady),
      productionCaveat: onboardingReport.recommendation.productionGuardrail,
      evidence: [
        ...readinessEvidence(product, 'workspace_onboarding'),
        `${onboardingReport.summary.pendingInvites} pending invite(s)`,
        `${onboardingReport.summary.seatsAvailable ?? 'unlimited'} seat(s) available`,
      ],
      commands: [
        'npm run admin -- tenants register New_Revenue_Lab newlab.example owner@newlab.example Owner_Name plan_beta',
        'curl -X POST http://127.0.0.1:8787/api/registration',
        'npm run admin -- users invite tenant_demo rowan@acme.example member success',
        'npm run admin -- users claim <inviteCode> "Rowan Lee"',
        'npm run admin -- users accept <inviteId>',
      ],
    }),
    qaAnswerRow({
      id: 'focus_priorities_notifications',
      question: 'Can each user/org define focus, outcomes, priorities, and notifications?',
      answer: 'Yes locally. Focus is modeled through routing rules, account ownership, signal assignment, notification preferences, mute rules, digest cadence, immediate alerts, and tenant quality thresholds instead of separate models per customer.',
      owner: 'customer_success',
      localOk: Boolean(notifications?.localOk && relationship?.localOk),
      productionOk: Boolean(notifications?.productionOk && relationship?.productionOk),
      productionCaveat: 'Live email delivery still depends on provider launch readiness for production notification sends.',
      evidence: [
        ...readinessEvidence(product, 'notifications_and_admin_monitoring'),
        `${summary.activeRoutingRules}/${summary.routingRules} active routing rule(s)`,
        `${summary.openAccountRecommendations}/${summary.accountRecommendations} open recommendation(s)`,
      ],
      commands: [
        'npm run admin -- notifications preference usr_sales daily immediate',
        'npm run admin -- notifications mute-account usr_product Acme Health',
        'npm run admin -- signals assign sig_risk_001 usr_sales',
        'npm run admin -- quality threshold tenant_demo 0.74',
      ],
    }),
    qaAnswerRow({
      id: 'contact_relationship_strategy',
      question: 'Do we have user/contact relationship indicators, recommendations, and strategy?',
      answer: 'Yes locally. The relationship dashboard includes account health, at-risk accounts, stakeholder timelines, open next actions, account reviews, and recommendations backed by source-linked signals.',
      owner: 'sales_strategy',
      localOk: Boolean(relationship?.localOk),
      productionOk: Boolean(relationship?.productionOk),
      productionCaveat: 'Production relationship recommendations still depend on production email ingestion and tenant-isolated storage before live customer data.',
      evidence: readinessEvidence(product, 'relationship_dashboard_and_recommendations'),
      commands: [
        'npm run admin -- accounts --json',
        'npm run admin -- accounts review Acme_Health QBR_risk renewal_save',
        'npm run admin -- signals feedback sig_risk_001 useful Renewal_save_signal',
      ],
    }),
    qaAnswerRow({
      id: 'email_notification_admin_monitoring',
      question: 'Do we have email notification flow, admin settings, and monitoring?',
      answer: 'Yes locally. Admins can manage email flows, run detector jobs, send digests, inspect delivery ledger state, process signed delivery webhooks, monitor provider watches/backoff, and use operations health for queues and webhooks. Production send/ingest launch still needs live provider configuration and sandbox proof.',
      owner: 'integrations',
      localOk: Boolean(emailFlow?.localOk && notifications?.localOk && operationsReport.ok),
      productionOk: emailProductionReady,
      needsLiveProvider: true,
      productionCaveat: emailProductionReady
        ? 'Gmail, Outlook, and outbound email provider launch rows are ready.'
        : 'Gmail, Outlook, and SendGrid/outbound email config plus saved sandbox evidence must pass before production email launch.',
      evidence: [
        ...readinessEvidence(product, 'email_source_and_detection_flow'),
        `${operationsReport.summary.totalWebhooks - operationsReport.summary.unhealthyWebhooks}/${operationsReport.summary.totalWebhooks} webhook channel(s) healthy`,
        `${operationsReport.summary.failedDeliveries} failed delivery record(s)`,
        `${launchRows.outboundEmail?.sandboxStatus ?? 'not_recorded'} outbound email sandbox status`,
      ],
      commands: [
        'npm run admin -- email-flows --json',
        'npm run admin -- notifications digest tenant_demo',
        'npm run admin -- operations-health --json',
        'npm run admin -- provider-launch --env-file ./.env.production --json',
      ],
    }),
    qaAnswerRow({
      id: 'payment_lifecycle_handling',
      question: 'How do we handle failed payment, disconnect notice, cancellation, resubscription, and subscription starting point?',
      answer: 'Yes locally. Billing uses subscription state and entitlement gates, Stripe-style Checkout/Billing Portal handoffs, invoice recovery sessions, signed webhook replay, lifecycle notices, cancellation, and resubscription commands. Production billing launch still needs Stripe config and sandbox evidence.',
      owner: 'billing',
      localOk: Boolean(payments?.localOk && lifecycle.ok),
      productionOk: paymentProductionReady,
      needsLiveProvider: true,
      productionCaveat: paymentProductionReady
        ? 'Stripe launch row is production-ready.'
        : 'Stripe secret, webhook secret, price config, live Checkout/Portal proof, signed webhook replay, and saved sandbox evidence are required before production billing launch.',
      evidence: [
        ...readinessEvidence(product, 'payment_lifecycle_and_entitlements'),
        `${lifecycle.summary.actionReady} lifecycle playbook action-ready row(s)`,
        `${launchRows.stripe?.sandboxStatus ?? 'not_recorded'} Stripe sandbox status`,
      ],
      commands: [
        'npm run admin -- lifecycle-playbook --json',
        'npm run admin -- payments recover <invoiceId>',
        'npm run admin -- payments checkout tenant_demo plan_team',
        'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>',
      ],
    }),
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    ok: true,
    productionReady: rows.every((row) => row.productionOk),
    rows,
    recommendation: {
      summary: 'Use qa-answers for stakeholder QA: each answer ties the visible product claim to local evidence, CLI/API proof, owner, and production caveat.',
      productionGuardrail: 'Local answers are ready, but production remains blocked until backend tenant isolation, managed auth/storage, live provider sandbox evidence, signed webhooks, and scheduler/alerting are configured.',
      localAgentCommand: 'npm run admin -- qa-answers --json',
    },
    summary: {
      localReady: rows.filter((row) => row.localOk).length,
      needsLiveProvider: rows.filter((row) => row.status === 'needs_live_provider').length,
      needsLocalWork: rows.filter((row) => row.status === 'needs_local_work').length,
      needsProduction: rows.filter((row) => row.status === 'needs_production').length,
      productionReady: rows.filter((row) => row.productionOk).length,
      secretSafe: false,
      total: rows.length,
    },
  };
  report.summary.secretSafe = providerLaunchUnsafePaths(report).length === 0;
  report.ok = report.summary.secretSafe && rows.length === 8;
  return report;
}

function launchGateById(report, id) {
  return report?.gates?.find?.((gate) => gate.id === id) ?? null;
}

function drillRowByArea(report, area) {
  return report?.rows?.find?.((row) => row.area === area) ?? null;
}

function productionPlanStatus(productionOk, blockers = []) {
  if (productionOk) {
    return 'complete';
  }
  return blockers.length ? 'blocked' : 'ready_for_proof';
}

function productionPlanRow({
  blockers = [],
  commands = [],
  completionCriteria = [],
  dependsOn = [],
  evidence = [],
  id,
  owner,
  phase,
  productionOk,
  requiredEnv = [],
}) {
  const uniqueBlockers = uniqueValues(blockers);
  return {
    id,
    phase,
    owner,
    status: productionPlanStatus(Boolean(productionOk), uniqueBlockers),
    productionOk: Boolean(productionOk),
    evidence: uniqueValues(evidence),
    blockers: uniqueBlockers,
    requiredEnv: uniqueValues(requiredEnv),
    commands: uniqueValues(commands),
    completionCriteria: uniqueValues(completionCriteria),
    dependsOn: uniqueValues(dependsOn),
    localAgentCanRun: commands.length > 0,
  };
}

function productionPlanDrillBlockers(...rows) {
  return rows
    .filter((row) => row && !row.productionOk)
    .map((row) => `${row.area}: ${row.recommendation}`);
}

function productionPlanDrillEnv(...rows) {
  return rows.flatMap((row) => row?.requiredEnv ?? []);
}

function productionPlanDrillCommands(...rows) {
  return rows.flatMap((row) => row?.commands ?? []);
}

function productionPlanDrillEvidence(...rows) {
  return rows.flatMap((row) => row?.evidence ?? []);
}

export function productionSetupPlanReport(state, {
  backend = null,
  env = process.env,
  launchGate = null,
  productionDrill = null,
  provider = providerReadiness(env),
  providerLaunch = null,
  readiness = null,
  statePath = resolveStatePath(),
} = {}) {
  const product = readiness ?? productReadinessReport(state, { backend, provider });
  const gate = launchGate ?? launchGateReport(state, { backend, provider, readiness: product });
  const operations = operationsHealthReport(state, { backend, statePath });
  const drill = productionDrill ?? productionOperationsDrillReport(state, { backend, env, launchGate: gate, operations, provider, readiness: product });
  const launch = providerLaunch ?? providerLaunchMatrixReport(state, { backend, env, provider });
  const gateRows = {
    local: launchGateById(gate, 'local_product_surface'),
    backend: launchGateById(gate, 'production_backend'),
    tenantIsolation: launchGateById(gate, 'tenant_isolation'),
    providerConfiguration: launchGateById(gate, 'provider_configuration'),
    providerSandbox: launchGateById(gate, 'provider_sandbox_evidence'),
    email: launchGateById(gate, 'email_notification_launch'),
    payment: launchGateById(gate, 'payment_launch'),
    scheduler: launchGateById(gate, 'scheduler_operations'),
  };
  const drillRows = {
    localContracts: drillRowByArea(drill, 'local_contracts'),
    stateService: drillRowByArea(drill, 'state_service_health'),
    backupRestore: drillRowByArea(drill, 'backup_restore_rehearsal'),
    migration: drillRowByArea(drill, 'migration_rollout'),
    identity: drillRowByArea(drill, 'identity_tenant_isolation'),
    scheduler: drillRowByArea(drill, 'scheduler_daemon'),
    liveProviders: drillRowByArea(drill, 'live_provider_recurring_tests'),
    alerting: drillRowByArea(drill, 'alerting_runbook'),
  };
  const providerRows = {
    gmail: providerLaunchById(launch, 'gmail'),
    outlook: providerLaunchById(launch, 'outlook'),
    outboundEmail: providerLaunchById(launch, 'outbound-email'),
    stripe: providerLaunchById(launch, 'stripe'),
  };
  const allProviderRows = launch.rows ?? [];
  const emailProviderRows = [providerRows.gmail, providerRows.outlook, providerRows.outboundEmail].filter(Boolean);
  const rows = [
    productionPlanRow({
      id: 'local_baseline',
      phase: 'Local baseline and evidence package starting point',
      owner: 'product',
      productionOk: gateRows.local?.status === 'pass' && drillRows.localContracts?.localOk,
      evidence: [
        ...(gateRows.local?.evidence ?? []),
        ...(drillRows.localContracts?.evidence ?? []),
      ],
      blockers: [
        ...(gateRows.local?.blockers ?? []),
        ...productionPlanDrillBlockers(drillRows.localContracts).filter((item) => !drillRows.localContracts?.localOk),
      ],
      commands: [
        'npm run test:local',
        'npm run admin -- readiness --json',
        'npm run admin -- qa-answers --json',
      ],
      completionCriteria: [
        'Full local test gate passes.',
        'Product readiness reports every local requirement ready.',
        'Stakeholder QA answers have no local-work rows.',
      ],
    }),
    productionPlanRow({
      id: 'durable_backend_storage',
      phase: 'Durable backend, state service, backup, restore, and migration',
      owner: 'platform',
      productionOk: gateRows.backend?.status === 'pass' &&
        drillRows.stateService?.productionOk &&
        drillRows.backupRestore?.productionOk &&
        drillRows.migration?.productionOk,
      evidence: [
        ...(gateRows.backend?.evidence ?? []),
        ...productionPlanDrillEvidence(drillRows.stateService, drillRows.backupRestore, drillRows.migration),
      ],
      blockers: [
        ...(gateRows.backend?.blockers ?? []),
        ...productionPlanDrillBlockers(drillRows.stateService, drillRows.backupRestore, drillRows.migration),
      ],
      requiredEnv: [
        ...(gateRows.backend?.requiredEnv ?? []),
        ...productionPlanDrillEnv(drillRows.stateService, drillRows.backupRestore, drillRows.migration),
      ],
      commands: [
        ...(gateRows.backend?.commands ?? []),
        ...productionPlanDrillCommands(drillRows.stateService, drillRows.backupRestore, drillRows.migration),
        'npm run test:state-service',
      ],
      completionCriteria: [
        'API uses external state service instead of local JSON.',
        'Production storage is database-backed.',
        'Backup, digest verification, and restore dry run are proven.',
        'Migration rollout plan is recorded.',
      ],
      dependsOn: ['local_baseline'],
    }),
    productionPlanRow({
      id: 'identity_tenant_isolation',
      phase: 'Managed auth, signed sessions, and tenant isolation',
      owner: 'security',
      productionOk: gateRows.tenantIsolation?.status === 'pass' && drillRows.identity?.productionOk,
      evidence: [
        ...(gateRows.tenantIsolation?.evidence ?? []),
        ...productionPlanDrillEvidence(drillRows.identity),
      ],
      blockers: [
        ...(gateRows.tenantIsolation?.blockers ?? []),
        ...productionPlanDrillBlockers(drillRows.identity),
      ],
      requiredEnv: [
        ...(gateRows.tenantIsolation?.requiredEnv ?? []),
        ...productionPlanDrillEnv(drillRows.identity),
      ],
      commands: [
        ...(gateRows.tenantIsolation?.commands ?? []),
        ...productionPlanDrillCommands(drillRows.identity),
        'npm run test:jwks-auth',
      ],
      completionCriteria: [
        'Raw actor fallback is disabled.',
        'Managed auth/JWKS verifies API sessions.',
        'Tenant isolation mode is configured for shared multi-org production use.',
      ],
      dependsOn: ['durable_backend_storage'],
    }),
    productionPlanRow({
      id: 'provider_configuration',
      phase: 'Provider environment configuration',
      owner: 'integrations',
      productionOk: gateRows.providerConfiguration?.status === 'pass',
      evidence: [
        ...(gateRows.providerConfiguration?.evidence ?? []),
        ...allProviderRows.map((row) => `${row.label}: ${row.configurationReady ? 'configured' : `${row.missingEnv.length} env missing`}`),
      ],
      blockers: gateRows.providerConfiguration?.blockers ?? [],
      requiredEnv: [
        ...(gateRows.providerConfiguration?.requiredEnv ?? []),
        ...allProviderRows.flatMap((row) => row.missingEnv ?? []),
      ],
      commands: [
        'npm run admin -- integrations --env-file ./.env.production --json',
        'npm run admin -- provider-launch --env-file ./.env.production --json',
        'npm run admin -- backend --env-file ./.env.production --json',
      ],
      completionCriteria: [
        'Signed sessions, Gmail, Outlook, outbound email, and Stripe required environment names are configured.',
        'Provider launch matrix reports every provider configuration-ready.',
      ],
      dependsOn: ['identity_tenant_isolation'],
    }),
    productionPlanRow({
      id: 'provider_sandbox_evidence',
      phase: 'Live-provider sandbox validation and saved evidence',
      owner: 'integrations',
      productionOk: gateRows.providerSandbox?.status === 'pass' && drillRows.liveProviders?.productionOk,
      evidence: [
        ...(gateRows.providerSandbox?.evidence ?? []),
        ...productionPlanDrillEvidence(drillRows.liveProviders),
        ...allProviderRows.map((row) => `${row.label}: sandbox ${row.sandboxStatus}`),
      ],
      blockers: [
        ...(gateRows.providerSandbox?.blockers ?? []),
        ...productionPlanDrillBlockers(drillRows.liveProviders),
      ],
      requiredEnv: [
        ...(gateRows.providerSandbox?.requiredEnv ?? []),
        ...productionPlanDrillEnv(drillRows.liveProviders),
      ],
      commands: [
        ...(gateRows.providerSandbox?.commands ?? []),
        ...productionPlanDrillCommands(drillRows.liveProviders),
        ...allProviderRows.flatMap((row) => row.evidenceCommands ?? []),
      ],
      completionCriteria: [
        'Provider sandbox validation passes with real sandbox credentials.',
        'Sanitized evidence artifact is saved and import/export verified.',
        'No credential values are serialized into app state or evidence packages.',
      ],
      dependsOn: ['provider_configuration'],
    }),
    productionPlanRow({
      id: 'email_launch',
      phase: 'Gmail, Outlook, and outbound email launch',
      owner: 'integrations',
      productionOk: gateRows.email?.status === 'pass' && emailProviderRows.every((row) => row.launchReady),
      evidence: [
        ...(gateRows.email?.evidence ?? []),
        ...emailProviderRows.map((row) => `${row.label}: ${row.status}`),
      ],
      blockers: gateRows.email?.blockers ?? [],
      requiredEnv: [
        ...(gateRows.email?.requiredEnv ?? []),
        ...emailProviderRows.flatMap((row) => row.missingEnv ?? []),
      ],
      commands: [
        ...(gateRows.email?.commands ?? []),
        ...emailProviderRows.flatMap((row) => row.launchCommands ?? []),
        ...emailProviderRows.map((row) => row.signedReplayCommand).filter(Boolean),
      ],
      completionCriteria: [
        'Gmail watch registration succeeds.',
        'Outlook subscription renewal succeeds.',
        'Outbound email digest send succeeds.',
        'Signed email delivery webhook replay updates delivery ledger.',
      ],
      dependsOn: ['provider_sandbox_evidence'],
    }),
    productionPlanRow({
      id: 'payment_launch',
      phase: 'Stripe billing launch',
      owner: 'billing',
      productionOk: gateRows.payment?.status === 'pass' && providerRows.stripe?.launchReady,
      evidence: [
        ...(gateRows.payment?.evidence ?? []),
        providerRows.stripe ? `${providerRows.stripe.label}: ${providerRows.stripe.status}` : null,
      ],
      blockers: gateRows.payment?.blockers ?? [],
      requiredEnv: [
        ...(gateRows.payment?.requiredEnv ?? []),
        ...(providerRows.stripe?.missingEnv ?? []),
      ],
      commands: [
        ...(gateRows.payment?.commands ?? []),
        ...(providerRows.stripe?.launchCommands ?? []),
        providerRows.stripe?.signedReplayCommand,
      ].filter(Boolean),
      completionCriteria: [
        'Stripe Checkout session succeeds in test mode.',
        'Billing Portal handoff succeeds.',
        'Signed Stripe webhook replay updates subscription, invoice, and entitlement state.',
        'Failed payment and resubscription lifecycle playbook rows reconcile.',
      ],
      dependsOn: ['provider_sandbox_evidence'],
    }),
    productionPlanRow({
      id: 'scheduler_alerting',
      phase: 'Scheduler, retries, alerts, and runbook',
      owner: 'operations',
      productionOk: gateRows.scheduler?.status === 'pass' &&
        drillRows.scheduler?.productionOk &&
        drillRows.alerting?.productionOk,
      evidence: [
        ...(gateRows.scheduler?.evidence ?? []),
        ...productionPlanDrillEvidence(drillRows.scheduler, drillRows.alerting),
      ],
      blockers: [
        ...(gateRows.scheduler?.blockers ?? []),
        ...productionPlanDrillBlockers(drillRows.scheduler, drillRows.alerting),
      ],
      requiredEnv: [
        ...(gateRows.scheduler?.requiredEnv ?? []),
        ...productionPlanDrillEnv(drillRows.scheduler, drillRows.alerting),
      ],
      commands: [
        ...(gateRows.scheduler?.commands ?? []),
        ...productionPlanDrillCommands(drillRows.scheduler, drillRows.alerting),
        'npm run admin -- operations-health --env-file ./.env.production --json',
      ],
      completionCriteria: [
        'Production scheduler runs as a single runner.',
        'Provider validation schedules are active.',
        'Operations alert channel and runbook URL are configured.',
        'Failed jobs and active provider backoffs are clear.',
      ],
      dependsOn: ['durable_backend_storage', 'provider_sandbox_evidence'],
    }),
    productionPlanRow({
      id: 'launch_evidence_package',
      phase: 'Redacted launch evidence package and final go-live proof',
      owner: 'operations',
      productionOk: gate.goLiveReady && drill.productionReady && launch.productionReady,
      evidence: [
        `${gate.summary.passed}/${gate.summary.total} launch gate(s) passed`,
        `${drill.summary.productionReady}/${drill.summary.total} production drill row(s) ready`,
        `${launch.summary.launchReady}/${launch.summary.total} provider launch row(s) ready`,
      ],
      blockers: gate.goLiveReady && drill.productionReady && launch.productionReady
        ? []
        : ['Complete every blocked production setup phase before writing final launch evidence.'],
      commands: [
        'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json',
        'npm run admin -- launch-gate verify-package ./signal-launch-evidence.json --json',
        'npm run admin -- production-plan --env-file ./.env.production --json',
      ],
      completionCriteria: [
        'Launch gate is go-live ready.',
        'Production drill is production-ready.',
        'Provider launch matrix is production-ready.',
        'Launch evidence package verifies and contains no secret values.',
      ],
      dependsOn: ['email_launch', 'payment_launch', 'scheduler_alerting'],
    }),
  ];
  const missingRequiredEnv = uniqueValues(rows.flatMap((row) => row.productionOk ? [] : row.requiredEnv));
  const report = {
    generatedAt: new Date().toISOString(),
    ok: true,
    productionReady: rows.every((row) => row.productionOk),
    rows,
    recommendation: {
      summary: 'Use production-plan as the ordered setup map for local agents and operators: it groups backend, auth, provider, scheduler, launch, and evidence work by owner and proof command.',
      productionGuardrail: 'This plan names missing environment variables and proof commands only. It does not make production ready until real credentials, live provider evidence, durable state, tenant isolation, scheduler, alerts, and launch evidence all pass.',
      localAgentCommand: 'npm run admin -- production-plan --env-file ./.env.production --json',
    },
    summary: {
      blocked: rows.filter((row) => row.status === 'blocked').length,
      complete: rows.filter((row) => row.status === 'complete').length,
      localAgentRunnable: rows.filter((row) => row.localAgentCanRun).length,
      missingRequiredEnv: missingRequiredEnv.length,
      nextPhaseId: rows.find((row) => !row.productionOk)?.id ?? null,
      productionReady: rows.filter((row) => row.productionOk).length,
      readyForProof: rows.filter((row) => row.status === 'ready_for_proof').length,
      secretSafe: false,
      total: rows.length,
    },
  };
  report.summary.secretSafe = providerLaunchUnsafePaths(report).length === 0;
  report.ok = report.summary.secretSafe && rows.length === 9;
  return report;
}

export function productionEnvTemplateKeys(contents) {
  const invalid = [];
  const keys = [];
  String(contents ?? '').split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }
    const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const separatorIndex = normalized.indexOf('=');
    const key = normalized.slice(0, separatorIndex).trim();
    if (separatorIndex <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      invalid.push(index + 1);
      return;
    }
    keys.push(key);
  });
  return {
    invalid,
    keys: uniqueValues(keys).sort(),
  };
}

export async function loadProductionEnvTemplate(templatePath = path.join(rootDir, '.env.production.example')) {
  const resolvedPath = path.resolve(templatePath);
  const parsed = productionEnvTemplateKeys(await fs.readFile(resolvedPath, 'utf8'));
  return {
    ...parsed,
    path: resolvedPath,
  };
}

function productionEnvSectionCatalog() {
  const provider = Object.fromEntries(providerRequirementCatalog.map((requirement) => [requirement.id, requirement]));
  return [
    {
      id: 'backend_state_service',
      label: 'Backend and state service',
      owner: 'platform',
      requiredEnv: ['SIGNAL_BACKEND_MODE', 'SIGNAL_STATE_SERVICE_BACKEND', 'SIGNAL_STATE_SERVICE_URL', 'SIGNAL_STATE_SERVICE_TOKEN', 'DATABASE_URL'],
      optionalEnv: ['SIGNAL_STATE_SERVICE_DATABASE_URL', 'SIGNAL_STATE_SERVICE_TIMEOUT_MS'],
      commands: ['npm run admin -- backend --env-file ./.env.production --json', 'npm run state-service'],
    },
    {
      id: 'auth_tenant_isolation',
      label: 'Auth, sessions, CORS, and tenant isolation',
      owner: 'security',
      requiredEnv: ['SIGNAL_REQUIRE_SIGNED_SESSION', 'SIGNAL_SESSION_SECRET', 'SIGNAL_AUTH_PROVIDER', 'SIGNAL_AUTH_JWKS_URL', 'SIGNAL_API_CORS_ORIGINS', 'SIGNAL_TENANT_ISOLATION_MODE'],
      optionalEnv: ['SIGNAL_SESSION_AUDIENCE', 'SIGNAL_SESSION_ISSUER', 'SIGNAL_SESSION_TTL_SECONDS'],
      commands: ['npm run test:jwks-auth', 'npm run admin -- backend --env-file ./.env.production --json'],
    },
    {
      id: 'backup_migration',
      label: 'Backup, restore, and migration proof',
      owner: 'platform',
      requiredEnv: ['SIGNAL_STATE_BACKUP_SCHEDULE', 'SIGNAL_STATE_BACKUP_RETENTION_DAYS', 'SIGNAL_STATE_RESTORE_REHEARSAL_AT', 'SIGNAL_STATE_MIGRATION_ROLLOUT_PLAN'],
      optionalEnv: [],
      commands: ['npm run state-service:admin -- backup ./signal-prod-backup.json --json', 'npm run state-service:admin -- restore ./signal-prod-backup.json --dry-run --json'],
    },
    {
      id: 'scheduler_alerting',
      label: 'Scheduler, validation, alerting, and runbook',
      owner: 'operations',
      requiredEnv: ['SIGNAL_JOB_SCHEDULER', 'SIGNAL_PROVIDER_VALIDATION_SCHEDULER', 'SIGNAL_SCHEDULER_LOCK_POLICY', 'SIGNAL_OPERATIONS_RUNBOOK_URL', 'SIGNAL_OPERATIONS_ALERT_CHANNEL'],
      optionalEnv: [],
      commands: ['npm run scheduler -- --once --dry-run --json', 'npm run admin -- operations-health --env-file ./.env.production --json'],
    },
    {
      id: 'gmail',
      label: provider.gmail.label,
      owner: 'integrations',
      requiredEnv: [...provider.gmail.requiredEnv, 'SIGNAL_GMAIL_ACCESS_TOKEN'],
      optionalEnv: provider.gmail.optionalEnv,
      commands: ['npm run admin -- mailboxes watch mbx_gmail_sales --live-provider --json'],
    },
    {
      id: 'outlook',
      label: provider.outlook.label,
      owner: 'integrations',
      requiredEnv: [...provider.outlook.requiredEnv, 'SIGNAL_OUTLOOK_ACCESS_TOKEN'],
      optionalEnv: provider.outlook.optionalEnv,
      commands: ['npm run admin -- mailboxes renew-watch watch_outlook_mbx_outlook_success --live-provider --json'],
    },
    {
      id: 'outbound_email',
      label: 'SendGrid / outbound email',
      owner: 'integrations',
      requiredEnv: [...provider['outbound-email'].requiredEnv, 'SIGNAL_SENDGRID_API_KEY'],
      optionalEnv: provider['outbound-email'].optionalEnv,
      commands: ['npm run admin -- notifications digest tenant_demo --live-provider', 'npm run admin -- notifications sendgrid-webhook-signed ./sendgrid-event.json <timestamp> <signature>'],
    },
    {
      id: 'stripe',
      label: provider.stripe.label,
      owner: 'billing',
      requiredEnv: provider.stripe.requiredEnv,
      optionalEnv: provider.stripe.optionalEnv,
      commands: ['npm run admin -- payments checkout tenant_demo plan_team --live-provider', 'npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>'],
    },
  ];
}

function productionEnvSourceKeys(envSource) {
  return new Set(Array.isArray(envSource?.keys) ? envSource.keys : []);
}

function productionEnvRow({ env, envSource, owner, label, id, requiredEnv = [], optionalEnv = [], templateKeys, commands = [] }) {
  const required = uniqueValues(requiredEnv);
  const optional = uniqueValues(optionalEnv);
  const sourceKeys = productionEnvSourceKeys(envSource);
  const templateKeySet = new Set(templateKeys);
  const missingRequired = required.filter((key) => !env[key]);
  const configuredRequired = required.filter((key) => Boolean(env[key]));
  const presentInSource = required.filter((key) => sourceKeys.has(key));
  const templateMissing = required.filter((key) => !templateKeySet.has(key));
  const configuredOptional = optional.filter((key) => Boolean(env[key]));
  const status = templateMissing.length ? 'template_gap' : missingRequired.length ? 'missing_values' : 'ready';
  return {
    id,
    label,
    owner,
    status,
    requiredEnv: required,
    optionalEnv: optional,
    configuredRequired,
    missingRequired,
    presentInSource,
    templateMissing,
    configuredOptional,
    commands,
    evidence: [
      `${configuredRequired.length}/${required.length} required env name(s) configured`,
      `${presentInSource.length}/${required.length} required env name(s) present in selected env source`,
      `${required.length - templateMissing.length}/${required.length} required env name(s) covered by template`,
    ],
  };
}

export function productionEnvAuditReport({
  backend = null,
  env = process.env,
  envSource = null,
  productionPlan = null,
  provider = providerReadiness(env),
  template = null,
} = {}) {
  const templateKeys = template?.keys ?? [];
  const sections = productionEnvSectionCatalog();
  const planRequiredEnv = productionPlan?.rows?.flatMap?.((row) => row.requiredEnv ?? []) ?? [];
  const backendRequiredEnv = backend?.checks?.flatMap?.((check) => check.requiredEnv ?? []) ?? [];
  const providerRequiredEnv = provider?.providers?.flatMap?.((item) => item.requiredEnv ?? []) ?? [];
  const allRequiredEnv = uniqueValues([
    ...sections.flatMap((section) => section.requiredEnv),
    ...planRequiredEnv,
    ...backendRequiredEnv,
    ...providerRequiredEnv,
  ]).sort();
  const allOptionalEnv = uniqueValues(sections.flatMap((section) => section.optionalEnv)).sort();
  const rows = [
    ...sections.map((section) => productionEnvRow({
      ...section,
      env,
      envSource,
      templateKeys,
    })),
    productionEnvRow({
      id: 'production_plan_union',
      label: 'Production setup plan required names',
      owner: 'operations',
      requiredEnv: allRequiredEnv,
      optionalEnv: allOptionalEnv,
      commands: [
        'npm run admin -- production-plan --env-file ./.env.production --json',
        'npm run admin -- launch-gate --env-file ./.env.production --json',
      ],
      env,
      envSource,
      templateKeys,
    }),
  ];
  const missingRequired = uniqueValues(rows.flatMap((row) => row.missingRequired)).sort();
  const configuredRequired = allRequiredEnv.filter((key) => Boolean(env[key]));
  const sourceKeys = productionEnvSourceKeys(envSource);
  const presentInSource = allRequiredEnv.filter((key) => sourceKeys.has(key));
  const templateMissingRequired = allRequiredEnv.filter((key) => !templateKeys.includes(key));
  const unsafePaths = providerLaunchUnsafePaths({
    rows,
    summary: {
      missingRequired,
      templateMissingRequired,
    },
  });
  const report = {
    generatedAt: new Date().toISOString(),
    ok: true,
    envReady: missingRequired.length === 0 && templateMissingRequired.length === 0,
    templateReady: templateMissingRequired.length === 0 && (template?.invalid?.length ?? 0) === 0,
    rows,
    recommendation: {
      summary: 'Use production-env before production-plan or launch-gate to verify that the selected env source and committed template cover every required production setup name without printing values.',
      productionGuardrail: 'This audit proves names and placeholders only. It does not validate provider credentials, external service reachability, webhook signatures, or provider sandbox evidence.',
      localAgentCommand: 'npm run admin -- production-env --env-file ./.env.production --json',
    },
    source: {
      configuredKeys: envSource?.configuredKeys ?? 0,
      keys: envSource?.keys ?? [],
      path: envSource?.path ?? null,
      type: envSource?.type ?? 'process',
    },
    template: {
      invalid: template?.invalid ?? [],
      keys: templateKeys,
      path: template?.path ?? null,
    },
    summary: {
      configuredRequired: configuredRequired.length,
      envReady: missingRequired.length === 0,
      missingRequired: missingRequired.length,
      optionalEnv: allOptionalEnv.length,
      presentInSource: presentInSource.length,
      requiredEnv: allRequiredEnv.length,
      rowsReady: rows.filter((row) => row.status === 'ready').length,
      secretSafe: false,
      templateMissingRequired: templateMissingRequired.length,
      templateReady: templateMissingRequired.length === 0 && (template?.invalid?.length ?? 0) === 0,
      totalRows: rows.length,
    },
  };
  report.summary.secretSafe = unsafePaths.length === 0;
  report.ok = report.summary.secretSafe && report.template.invalid.length === 0 && rows.length === 9;
  return report;
}

function localAgentHandoffPriority(row) {
  if (row.status === 'blocked') {
    const order = {
      production_backend: 10,
      tenant_isolation: 20,
      provider_configuration: 30,
      provider_sandbox_evidence: 40,
      email_notification_launch: 50,
      payment_launch: 60,
      scheduler_operations: 70,
    };
    return order[row.id] ?? 90;
  }
  if (row.status === 'attention') {
    return 5;
  }
  return 100;
}

function localAgentNextActionFromGate(gate) {
  return {
    id: gate.id,
    label: gate.label,
    owner: gate.owner,
    status: gate.status,
    priority: localAgentHandoffPriority(gate),
    blocker: gate.blockers?.[0] ?? (gate.status === 'pass' ? 'No blocker.' : 'Proof is missing.'),
    evidence: gate.evidence ?? [],
    requiredEnv: gate.requiredEnv ?? [],
    command: gate.commands?.[0] ?? 'npm run admin -- launch-gate --json',
    followUpCommands: (gate.commands ?? []).slice(1, 4),
  };
}

export function localAgentHandoffReport(state, {
  backend = null,
  env = process.env,
  launchGate = null,
  operations = null,
  productionPlan = null,
  provider = providerReadiness(env),
  providerLaunch = null,
  readiness = null,
  statePath = resolveStatePath(),
} = {}) {
  const product = readiness ?? productReadinessReport(state, { backend, provider });
  const gate = launchGate ?? launchGateReport(state, { backend, provider, readiness: product });
  const operationHealth = operations ?? operationsHealthReport(state, { backend, statePath });
  const providerMatrix = providerLaunch ?? providerLaunchMatrixReport(state, { backend, env, provider });
  const plan = productionPlan ?? productionSetupPlanReport(state, {
    backend,
    env,
    launchGate: gate,
    operations: operationHealth,
    provider,
    providerLaunch: providerMatrix,
    readiness: product,
    statePath,
  });
  const summary = summarizeState(state, statePath);
  const nextActions = (gate.gates ?? [])
    .filter((row) => row.status !== 'pass')
    .map(localAgentNextActionFromGate)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  const nextAction = nextActions[0] ?? {
    id: 'launch_evidence_package',
    label: 'Redacted launch evidence package',
    owner: 'operations',
    status: 'ready_for_proof',
    priority: 100,
    blocker: 'All launch gates pass; write and verify final redacted launch evidence.',
    evidence: [`${gate.summary?.passed ?? 0}/${gate.summary?.total ?? 0} launch gate(s) passed`],
    requiredEnv: [],
    command: 'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json',
    followUpCommands: ['npm run admin -- launch-gate verify-package ./signal-launch-evidence.json --json'],
  };
  const providerAttention = (providerMatrix.rows ?? [])
    .filter((row) => !row.launchReady)
    .map((row) => ({
      id: row.id,
      label: row.label,
      owner: row.owner,
      status: row.status,
      missingEnv: row.missingEnv ?? [],
      sandboxStatus: row.sandboxStatus,
      command: row.localAgentCommand ?? row.evidenceCommands?.[0] ?? 'npm run admin -- provider-launch --json',
    }));
  const runnableCommands = uniqueValues([
    'npm run test:local',
    'npm run admin -- readiness --json',
    'npm run admin -- launch-gate --json',
    'npm run admin -- production-plan --json',
    'npm run admin -- provider-launch --json',
    'npm run admin -- operations-health --json',
    nextAction.command,
    ...(nextAction.followUpCommands ?? []),
  ].filter(Boolean));
  const report = {
    generatedAt: new Date().toISOString(),
    ok: true,
    goLiveReady: Boolean(gate.goLiveReady),
    nextAction,
    nextActions,
    providerAttention,
    runnableCommands,
    recommendation: {
      summary: 'Use agent-handoff as the local operator starting point: it ranks the remaining launch blockers, chooses the next command, and points to the broader proof reports.',
      productionGuardrail: 'This report is an operator handoff only. It never promotes production readiness without passing launch-gate, provider-launch, production-plan, operations-health, and real external evidence.',
      localAgentCommand: 'npm run admin -- agent-handoff --json',
    },
    summary: {
      activeApiSessions: summary.activeApiSessions ?? 0,
      blockedGates: gate.summary?.blocked ?? 0,
      failedJobs: summary.failedJobs ?? 0,
      goLiveReady: Boolean(gate.goLiveReady),
      localReady: product.summary?.localReady ?? 0,
      localTotal: product.summary?.total ?? 0,
      nextActionId: nextAction.id,
      productionPlanNextPhaseId: plan.summary?.nextPhaseId ?? null,
      providerLaunchReady: providerMatrix.summary?.launchReady ?? 0,
      providerTotal: providerMatrix.summary?.total ?? 0,
      secretSafe: false,
      totalActions: nextActions.length,
    },
  };
  report.summary.secretSafe = providerLaunchUnsafePaths(report).length === 0;
  report.ok = report.summary.secretSafe && product.ok && operationHealth.ok;
  return report;
}

function backendHandoffPriority(row) {
  const order = {
    backend_mode: 10,
    durable_state: 20,
    state_service_storage: 30,
    signed_session_enforced: 40,
    production_auth_provider: 50,
    cors_origins: 60,
    tenant_isolation: 70,
    job_scheduler: 80,
    state_service_health: 90,
    backup_restore_rehearsal: 100,
    migration_rollout: 110,
    scheduler_daemon: 120,
    alerting_runbook: 130,
  };
  return order[row.id ?? row.area] ?? 200;
}

function backendHandoffActionFromCheck(check) {
  const commandMap = {
    backend_mode: 'SIGNAL_BACKEND_MODE=external-service npm run admin -- backend --json',
    durable_state: 'SIGNAL_BACKEND_MODE=external-service SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run admin -- backend --json',
    state_service_storage: 'SIGNAL_STATE_SERVICE_BACKEND=postgres DATABASE_URL=postgres://... SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service',
    signed_session_enforced: 'SIGNAL_REQUIRE_SIGNED_SESSION=true SIGNAL_SESSION_SECRET=<local-session-secret> npm run admin -- backend --json',
    production_auth_provider: 'SIGNAL_AUTH_PROVIDER=jwks SIGNAL_AUTH_JWKS_URL=<jwks-url> npm run test:jwks-auth',
    cors_origins: 'SIGNAL_API_CORS_ORIGINS=https://app.example.com npm run admin -- backend --json',
    job_scheduler: 'SIGNAL_JOB_SCHEDULER=signal-scheduler SIGNAL_PROVIDER_VALIDATION_SCHEDULER=signal-scheduler npm run scheduler -- --once --dry-run --json',
    tenant_isolation: 'SIGNAL_TENANT_ISOLATION_MODE=rls npm run admin -- backend --json',
  };
  return {
    id: check.id,
    label: check.label,
    owner: ['signed_session_enforced', 'production_auth_provider', 'tenant_isolation'].includes(check.id) ? 'security' : check.id === 'job_scheduler' ? 'operations' : 'platform',
    status: check.ok ? 'ready' : 'blocked',
    priority: backendHandoffPriority(check),
    blocker: check.ok ? 'No blocker.' : check.message,
    evidence: [check.message],
    requiredEnv: check.missingEnv ?? [],
    command: commandMap[check.id] ?? 'npm run admin -- backend --json',
    followUpCommands: check.id === 'state_service_storage'
      ? ['npm run test:state-service', 'SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- health --json']
      : [],
  };
}

function backendHandoffActionFromDrill(row) {
  return {
    id: row.area,
    label: row.check,
    owner: row.owner,
    status: row.productionOk ? 'ready' : row.status,
    priority: backendHandoffPriority(row),
    blocker: row.productionOk ? 'No blocker.' : row.recommendation,
    evidence: row.evidence ?? [],
    requiredEnv: row.requiredEnv ?? [],
    command: row.commands?.[0] ?? 'npm run admin -- production-drill --json',
    followUpCommands: (row.commands ?? []).slice(1, 4),
  };
}

export function backendHandoffReport(state, {
  backend = null,
  env = process.env,
  operations = null,
  productionDrill = null,
  provider = providerReadiness(env),
  readiness = null,
  statePath = resolveStatePath(),
} = {}) {
  const currentBackend = backend ?? backendReadiness({ env, statePath });
  const currentOperations = operations ?? operationsHealthReport(state, { backend: currentBackend, statePath });
  const currentReadiness = readiness ?? productReadinessReport(state, { backend: currentBackend, provider });
  const drill = productionDrill ?? productionOperationsDrillReport(state, {
    backend: currentBackend,
    operations: currentOperations,
    provider,
    readiness: currentReadiness,
  });
  const backendActions = (currentBackend.checks ?? [])
    .filter((check) => !check.ok)
    .map(backendHandoffActionFromCheck);
  const drillAreas = new Set(['state_service_health', 'backup_restore_rehearsal', 'migration_rollout', 'identity_tenant_isolation', 'scheduler_daemon', 'alerting_runbook']);
  const drillActions = (drill.rows ?? [])
    .filter((row) => drillAreas.has(row.area) && !row.productionOk)
    .map(backendHandoffActionFromDrill);
  const actions = [...backendActions, ...drillActions]
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  const nextAction = actions[0] ?? {
    id: 'backend_launch_evidence',
    label: 'Backend launch evidence package',
    owner: 'platform',
    status: 'ready_for_proof',
    priority: 200,
    blocker: 'Backend checks pass; package and verify launch evidence.',
    evidence: [`${currentBackend.summary?.readyChecks ?? 0}/${currentBackend.summary?.totalChecks ?? 0} backend checks ready`],
    requiredEnv: [],
    command: 'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json',
    followUpCommands: ['npm run admin -- launch-gate verify-package ./signal-launch-evidence.json --json'],
  };
  const runnableCommands = uniqueValues([
    'npm run admin -- backend --json',
    'npm run admin -- backend-handoff --json',
    'npm run admin -- production-drill --json',
    'npm run test:state-service',
    'npm run test:jwks-auth',
    'npm run test:scheduler',
    nextAction.command,
    ...(nextAction.followUpCommands ?? []),
  ].filter(Boolean));
  const report = {
    generatedAt: new Date().toISOString(),
    ok: true,
    productionReady: Boolean(currentBackend.productionReady && drill.rows
      ?.filter((row) => ['state_service_health', 'backup_restore_rehearsal', 'migration_rollout', 'identity_tenant_isolation', 'scheduler_daemon', 'alerting_runbook'].includes(row.area))
      .every((row) => row.productionOk)),
    nextAction,
    actions,
    backend: {
      mode: currentBackend.mode,
      productionReady: currentBackend.productionReady,
      readyChecks: currentBackend.summary?.readyChecks ?? 0,
      totalChecks: currentBackend.summary?.totalChecks ?? 0,
      missingRequiredEnv: currentBackend.summary?.missingRequiredEnv ?? [],
    },
    recommendation: {
      summary: 'Use backend-handoff to work the first launch blocker before provider launch: durable state, signed auth, tenant isolation, CORS, scheduler, backup/restore, migration, and runbook proof.',
      productionGuardrail: 'This report is secret-safe and names required environment variables only. It does not prove production readiness until the target deployment passes backend, production-drill, state-service, JWKS auth, scheduler, and launch-gate checks.',
      localAgentCommand: 'npm run admin -- backend-handoff --env-file ./.env.production --json',
    },
    runnableCommands,
    summary: {
      blocked: actions.length,
      backendReadyChecks: currentBackend.summary?.readyChecks ?? 0,
      backendTotalChecks: currentBackend.summary?.totalChecks ?? 0,
      drillReady: drill.summary?.productionReady ?? 0,
      drillTotal: drill.summary?.total ?? 0,
      missingRequiredEnv: uniqueValues(actions.flatMap((row) => row.requiredEnv ?? [])).length,
      nextActionId: nextAction.id,
      productionReady: Boolean(currentBackend.productionReady),
      secretSafe: false,
    },
  };
  report.summary.secretSafe = providerLaunchUnsafePaths(report).length === 0;
  report.ok = report.summary.secretSafe && Boolean(currentBackend.ok) && Boolean(currentOperations.ok);
  return report;
}

function backendCutoverStepStatus({ env = process.env, id, requiredEnv = [], productionOk = false, localOk = true }) {
  const configured = configuredKeys(env, requiredEnv);
  const missing = missingKeys(env, requiredEnv);
  return {
    id,
    configuredEnv: configured,
    missingEnv: missing,
    localOk: Boolean(localOk),
    productionOk: Boolean(productionOk),
    status: productionOk ? 'ready' : localOk ? 'needs_proof' : 'attention',
  };
}

function backendCutoverStep({
  command,
  completion,
  env = process.env,
  evidence = [],
  id,
  label,
  owner,
  priority,
  productionOk = false,
  requiredEnv = [],
  rollbackCommand = null,
}) {
  const status = backendCutoverStepStatus({ env, id, productionOk, requiredEnv });
  return {
    id,
    label,
    owner,
    priority,
    status: status.status,
    localOk: status.localOk,
    productionOk: status.productionOk,
    requiredEnv: uniqueValues(requiredEnv),
    configuredEnv: status.configuredEnv,
    missingEnv: status.missingEnv,
    evidence,
    command,
    rollbackCommand,
    completion,
  };
}

export function backendCutoverDrillReport(state, {
  backend = null,
  env = process.env,
  productionDrill = null,
  statePath = resolveStatePath(),
} = {}) {
  const currentBackend = backend ?? backendReadiness({ env, statePath });
  const drill = productionDrill ?? productionOperationsDrillReport(state, { backend: currentBackend, env });
  const summary = summarizeState(state, statePath);
  const checks = Object.fromEntries((currentBackend.checks ?? []).map((check) => [check.id, check]));
  const drillRows = Object.fromEntries((drill.rows ?? []).map((row) => [row.area, row]));
  const stateServiceEnv = ['SIGNAL_BACKEND_MODE', 'SIGNAL_STATE_SERVICE_URL', 'SIGNAL_STATE_SERVICE_TOKEN'];
  const postgresEnv = ['SIGNAL_STATE_SERVICE_BACKEND', 'DATABASE_URL'];
  const identityEnv = ['SIGNAL_REQUIRE_SIGNED_SESSION', 'SIGNAL_SESSION_SECRET', 'SIGNAL_AUTH_PROVIDER', 'SIGNAL_AUTH_JWKS_URL', 'SIGNAL_TENANT_ISOLATION_MODE'];
  const corsEnv = ['SIGNAL_API_CORS_ORIGINS'];
  const schedulerEnv = ['SIGNAL_JOB_SCHEDULER', 'SIGNAL_PROVIDER_VALIDATION_SCHEDULER', 'SIGNAL_SCHEDULER_LOCK_POLICY'];
  const backupEnv = ['SIGNAL_STATE_BACKUP_SCHEDULE', 'SIGNAL_STATE_BACKUP_RETENTION_DAYS', 'SIGNAL_STATE_RESTORE_REHEARSAL_AT', 'SIGNAL_STATE_MIGRATION_ROLLOUT_PLAN'];
  const stateServiceReady = Boolean(checks.backend_mode?.ok && checks.durable_state?.ok && checks.state_service_storage?.ok);
  const identityReady = Boolean(checks.signed_session_enforced?.ok && checks.production_auth_provider?.ok && checks.tenant_isolation?.ok);
  const schedulerReady = Boolean(checks.job_scheduler?.ok && drillRows.scheduler_daemon?.productionOk);
  const backupReady = Boolean(drillRows.backup_restore_rehearsal?.productionOk && drillRows.migration_rollout?.productionOk);
  const rows = [
    backendCutoverStep({
      id: 'snapshot_local_state',
      label: 'Snapshot current local state',
      owner: 'platform',
      priority: 10,
      productionOk: true,
      evidence: [
        `State path: ${statePath}`,
        `${summary.tenants} tenant(s), ${summary.users} user(s), ${summary.mailboxes} mailbox source(s), ${summary.auditEvents} audit event(s)`,
      ],
      command: 'npm run state-service:admin -- verify ./signal-prod-backup.json --json',
      rollbackCommand: 'Keep the pre-cutover local JSON state file unchanged until the external state-service verification passes.',
      completion: 'A pre-cutover backup artifact is stored outside app state and its digest verifies.',
    }),
    backendCutoverStep({
      id: 'start_external_state_service',
      label: 'Start external state-service backend',
      owner: 'platform',
      priority: 20,
      productionOk: stateServiceReady,
      requiredEnv: uniqueValues([...stateServiceEnv, ...postgresEnv]),
      evidence: [
        checks.backend_mode?.message ?? 'Backend mode not evaluated',
        checks.durable_state?.message ?? 'Durable state not evaluated',
        checks.state_service_storage?.message ?? 'State-service storage not evaluated',
      ],
      command: 'SIGNAL_STATE_SERVICE_BACKEND=postgres DATABASE_URL=postgres://... SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service',
      rollbackCommand: 'Stop the new state-service process and keep API traffic on SIGNAL_BACKEND_MODE=local-json.',
      completion: 'State service starts with Postgres storage, bearer protection, sanitized health metadata, and no credential values in logs or state.',
    }),
    backendCutoverStep({
      id: 'verify_state_service_health',
      label: 'Verify external state-service health',
      owner: 'platform',
      priority: 30,
      productionOk: Boolean(stateServiceReady && env.SIGNAL_STATE_SERVICE_TOKEN),
      requiredEnv: stateServiceEnv,
      evidence: [
        `Backend mode: ${currentBackend.mode}`,
        checks.state_service_storage?.message ?? 'State-service storage not evaluated',
      ],
      command: 'SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- health --json',
      rollbackCommand: 'Do not switch API env until health passes through the same URL the API will use.',
      completion: 'Health succeeds through the bearer-protected /state boundary using env names only.',
    }),
    backendCutoverStep({
      id: 'backup_restore_rehearsal',
      label: 'Run backup, verify, and restore dry run',
      owner: 'platform',
      priority: 40,
      productionOk: backupReady,
      requiredEnv: backupEnv,
      evidence: drillRows.backup_restore_rehearsal?.evidence ?? [],
      command: 'SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- backup ./signal-prod-backup.json --json',
      rollbackCommand: 'Use npm run state-service:admin -- restore ./signal-prod-backup.json --dry-run --json before any real restore.',
      completion: 'Backup digest verifies and restore dry run completes against the target state-service URL.',
    }),
    backendCutoverStep({
      id: 'identity_tenant_isolation_cutover',
      label: 'Enforce signed auth and tenant isolation',
      owner: 'security',
      priority: 50,
      productionOk: identityReady,
      requiredEnv: identityEnv,
      evidence: [
        checks.signed_session_enforced?.message ?? 'Signed session not evaluated',
        checks.production_auth_provider?.message ?? 'Production auth provider not evaluated',
        checks.tenant_isolation?.message ?? 'Tenant isolation not evaluated',
      ],
      command: 'SIGNAL_REQUIRE_SIGNED_SESSION=true SIGNAL_AUTH_PROVIDER=jwks SIGNAL_AUTH_JWKS_URL=<jwks-url> SIGNAL_TENANT_ISOLATION_MODE=rls npm run test:jwks-auth',
      rollbackCommand: 'Keep raw actor fallback disabled in production; if JWKS fails, remove production traffic from the deployment rather than loosening auth.',
      completion: 'JWKS auth, signed-session enforcement, role/tenant claim mapping, and tenant-isolation mode all pass.',
    }),
    backendCutoverStep({
      id: 'api_external_mode_smoke',
      label: 'Start API in external-service mode',
      owner: 'platform',
      priority: 60,
      productionOk: Boolean(stateServiceReady && identityReady && checks.cors_origins?.ok),
      requiredEnv: uniqueValues([...stateServiceEnv, ...identityEnv, ...corsEnv]),
      evidence: [
        checks.cors_origins?.message ?? 'CORS origins not evaluated',
        `Backend ready checks: ${currentBackend.summary?.readyChecks ?? 0}/${currentBackend.summary?.totalChecks ?? 0}`,
      ],
      command: 'SIGNAL_BACKEND_MODE=external-service SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run api',
      rollbackCommand: 'Stop the external-mode API process and restart local development with npm run api.',
      completion: 'API /api/health and admin readiness routes load from the external state-service boundary.',
    }),
    backendCutoverStep({
      id: 'scheduler_single_runner_cutover',
      label: 'Run scheduler one-shot against external backend',
      owner: 'operations',
      priority: 70,
      productionOk: schedulerReady,
      requiredEnv: schedulerEnv,
      evidence: drillRows.scheduler_daemon?.evidence ?? [],
      command: 'SIGNAL_JOB_SCHEDULER=signal-scheduler SIGNAL_PROVIDER_VALIDATION_SCHEDULER=signal-scheduler npm run scheduler -- --once --json',
      rollbackCommand: 'Keep continuous scheduler disabled until one-shot execution and operations-health pass.',
      completion: 'One scheduler tick runs with single-runner policy, no failed jobs, and active provider validation schedules.',
    }),
    backendCutoverStep({
      id: 'package_cutover_evidence',
      label: 'Package redacted backend cutover evidence',
      owner: 'operations',
      priority: 80,
      productionOk: Boolean(currentBackend.productionReady && backupReady && schedulerReady),
      evidence: [
        `${currentBackend.summary?.readyChecks ?? 0}/${currentBackend.summary?.totalChecks ?? 0} backend checks ready`,
        `${drill.summary?.productionReady ?? 0}/${drill.summary?.total ?? 0} production drill rows ready`,
      ],
      command: 'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json',
      rollbackCommand: 'Verify the package before launch; failed package verification blocks cutover.',
      completion: 'Launch evidence package verifies, omits credentials, and includes backend, drill, state-service, auth, and scheduler proof.',
    }),
  ];
  const nextStep = rows.find((row) => !row.productionOk) ?? {
    id: 'backend_cutover_complete',
    label: 'Backend cutover evidence complete',
    owner: 'platform',
    priority: 100,
    status: 'ready',
    localOk: true,
    productionOk: true,
    requiredEnv: [],
    configuredEnv: [],
    missingEnv: [],
    evidence: [`${rows.length}/${rows.length} backend cutover steps ready`],
    command: 'npm run admin -- launch-gate --env-file ./.env.production --json',
    rollbackCommand: 'Keep final backup and rollback runbook attached to the launch package.',
    completion: 'Backend cutover proof is complete; continue through provider, email, payment, and scheduler launch gates.',
  };
  const report = {
    generatedAt: new Date().toISOString(),
    ok: true,
    productionReady: rows.every((row) => row.productionOk),
    nextStep,
    rows,
    backend: {
      mode: currentBackend.mode,
      productionReady: currentBackend.productionReady,
      readyChecks: currentBackend.summary?.readyChecks ?? 0,
      totalChecks: currentBackend.summary?.totalChecks ?? 0,
      missingRequiredEnv: currentBackend.summary?.missingRequiredEnv ?? [],
    },
    recommendation: {
      summary: 'Use backend-cutover after backend-handoff: it is the local-agent drill for moving Signal from local JSON state to the external state-service backend.',
      productionGuardrail: 'Do not switch production traffic until health, backup/restore, JWKS auth, tenant isolation, external-mode API smoke, scheduler one-shot, and redacted launch evidence all pass.',
      localAgentCommand: 'npm run admin -- backend-cutover --env-file ./.env.production --json',
    },
    runnableCommands: uniqueValues([
      'npm run admin -- backend-cutover --json',
      'npm run admin -- backend-cutover --env-file ./.env.production --json',
      'npm run admin -- backend-handoff --env-file ./.env.production --json',
      'npm run test:state-service',
      'npm run test:jwks-auth',
      'npm run test:scheduler',
      nextStep.command,
      nextStep.rollbackCommand,
    ].filter(Boolean)),
    summary: {
      blocked: rows.filter((row) => !row.productionOk).length,
      configuredEnv: uniqueValues(rows.flatMap((row) => row.configuredEnv ?? [])).length,
      missingRequiredEnv: uniqueValues(rows.flatMap((row) => row.missingEnv ?? [])).length,
      nextStepId: nextStep.id,
      productionReady: rows.filter((row) => row.productionOk).length,
      secretSafe: false,
      total: rows.length,
    },
  };
  report.summary.secretSafe = providerLaunchUnsafePaths(report).length === 0;
  report.ok = report.summary.secretSafe && Boolean(currentBackend.ok);
  return report;
}

function schedulerHandoffStep({
  blocker,
  command,
  completion,
  env = process.env,
  evidence = [],
  followUpCommands = [],
  id,
  label,
  owner = 'operations',
  priority,
  productionOk = false,
  requiredEnv = [],
  rollbackCommand = null,
}) {
  const configuredEnv = configuredKeys(env, requiredEnv);
  const missingEnv = missingKeys(env, requiredEnv);
  return {
    id,
    label,
    owner,
    priority,
    status: productionOk ? 'ready' : 'needs_proof',
    localOk: true,
    productionOk: Boolean(productionOk),
    requiredEnv: uniqueValues(requiredEnv),
    configuredEnv,
    missingEnv,
    evidence,
    blocker,
    command,
    followUpCommands,
    rollbackCommand,
    completion,
  };
}

export function schedulerHandoffReport(state, {
  backend = null,
  env = process.env,
  launchGate = null,
  operations = null,
  productionDrill = null,
  provider = providerReadiness(env),
  readiness = null,
  statePath = resolveStatePath(),
} = {}) {
  const currentBackend = backend ?? backendReadiness({ env, statePath });
  const product = readiness ?? productReadinessReport(state, { backend: currentBackend, provider });
  const gate = launchGate ?? launchGateReport(state, { backend: currentBackend, provider, readiness: product });
  const health = operations ?? operationsHealthReport(state, { backend: currentBackend, statePath });
  const drill = productionDrill ?? productionOperationsDrillReport(state, {
    backend: currentBackend,
    env,
    launchGate: gate,
    operations: health,
    provider,
    readiness: product,
  });
  const summary = summarizeState(state, statePath);
  const scheduler = backendCheckById(currentBackend, 'job_scheduler');
  const schedulerGate = launchGateById(gate, 'scheduler_operations');
  const drillRows = Object.fromEntries((drill.rows ?? []).map((row) => [row.area, row]));
  const activeProviderSchedules = state.providerValidationSchedules?.filter((schedule) => schedule.status === 'active').length ?? 0;
  const totalProviderSchedules = state.providerValidationSchedules?.length ?? 0;
  const dueProviderSchedules = providerValidationSchedulesDue(state).length;
  const failedJobs = summary.failedJobs ?? 0;
  const schedulerEnv = ['SIGNAL_JOB_SCHEDULER', 'SIGNAL_PROVIDER_VALIDATION_SCHEDULER'];
  const singleRunnerEnv = ['SIGNAL_SCHEDULER_LOCK_POLICY'];
  const alertingEnv = ['SIGNAL_OPERATIONS_RUNBOOK_URL', 'SIGNAL_OPERATIONS_ALERT_CHANNEL'];
  const backendEnv = ['SIGNAL_BACKEND_MODE', 'SIGNAL_STATE_SERVICE_URL', 'SIGNAL_STATE_SERVICE_TOKEN', 'SIGNAL_TENANT_ISOLATION_MODE'];
  const schedulerEnvReady = Boolean(scheduler?.ok && missingKeys(env, singleRunnerEnv).length === 0);
  const cleanQueuesReady = Boolean(health.ok && failedJobs === 0);
  const schedulesReady = activeProviderSchedules >= 4;
  const alertingReady = Boolean(drillRows.alerting_runbook?.productionOk && missingKeys(env, alertingEnv).length === 0);
  const schedulerProductionReady = Boolean(
    schedulerEnvReady &&
    cleanQueuesReady &&
    schedulesReady &&
    alertingReady &&
    drillRows.scheduler_daemon?.productionOk &&
    schedulerGate?.status === 'pass'
  );
  const rows = [
    schedulerHandoffStep({
      id: 'configure_scheduler_env',
      label: 'Configure managed scheduler env',
      priority: 10,
      env,
      productionOk: schedulerEnvReady,
      requiredEnv: uniqueValues([...schedulerEnv, ...singleRunnerEnv]),
      evidence: [
        scheduler?.message ?? 'Scheduler readiness has not been evaluated.',
        `Single-runner policy configured: ${missingKeys(env, singleRunnerEnv).length === 0 ? 'yes' : 'no'}`,
        `Backend mode: ${currentBackend.mode}`,
      ],
      blocker: schedulerEnvReady ? 'None' : 'Production scheduler env or single-runner policy is missing.',
      command: 'SIGNAL_JOB_SCHEDULER=signal-scheduler SIGNAL_PROVIDER_VALIDATION_SCHEDULER=signal-scheduler npm run admin -- backend --env-file ./.env.production --json',
      followUpCommands: ['npm run admin -- production-drill --env-file ./.env.production --json'],
      rollbackCommand: 'Keep continuous scheduler disabled until backend and production-drill checks pass.',
      completion: 'Backend readiness reports job scheduler and validation scheduler env as configured with a single-runner policy.',
    }),
    schedulerHandoffStep({
      id: 'dry_run_scheduler_tick',
      label: 'Dry-run one scheduler tick',
      priority: 20,
      env,
      productionOk: Boolean(scheduler?.ok && cleanQueuesReady),
      requiredEnv: schedulerEnv,
      evidence: [
        `${failedJobs}/${summary.jobs} failed job(s)`,
        `Operations health: ${health.ok ? 'local ready' : 'attention'}`,
      ],
      blocker: scheduler?.ok && cleanQueuesReady ? 'None' : 'Dry-run proof is blocked by scheduler env or failed worker jobs.',
      command: 'npm run scheduler -- --once --dry-run --json',
      followUpCommands: ['npm run admin -- operations-health --json', 'npm run test:scheduler'],
      rollbackCommand: 'Dry-run only; do not enable the daemon when this row remains needs_proof.',
      completion: 'The scheduler enumerates due work without mutating state and operations-health remains locally clean.',
    }),
    schedulerHandoffStep({
      id: 'activate_provider_validation_schedules',
      label: 'Keep provider validation schedules active',
      priority: 30,
      env,
      productionOk: schedulesReady,
      requiredEnv: ['SIGNAL_PROVIDER_VALIDATION_SCHEDULER'],
      evidence: [
        `${activeProviderSchedules}/${totalProviderSchedules} active provider validation schedule(s)`,
        `${dueProviderSchedules} due provider validation schedule(s)`,
      ],
      blocker: schedulesReady ? 'None' : 'Provider validation schedules are not all active.',
      command: 'SIGNAL_PROVIDER_VALIDATION_SCHEDULER=signal-scheduler npm run admin -- integrations run-scheduled --force --json',
      followUpCommands: [
        'npm run admin -- integrations schedule gmail daily active --json',
        'npm run admin -- integrations schedule outlook daily active --json',
        'npm run admin -- integrations schedule outbound-email daily active --json',
        'npm run admin -- integrations schedule stripe daily active --json',
      ],
      rollbackCommand: 'Pause only the specific provider schedule causing an incident; keep the scheduler daemon disabled if all schedules cannot stay active.',
      completion: 'Gmail, Outlook, outbound email, and Stripe validation schedules are active and recorded in state.',
    }),
    schedulerHandoffStep({
      id: 'clear_failed_jobs',
      label: 'Clear failed jobs before daemon start',
      priority: 40,
      env,
      productionOk: cleanQueuesReady,
      evidence: [
        `${failedJobs}/${summary.jobs} failed job(s)`,
        `${health.summary.failedQueues} failed monitored queue(s)`,
        `${health.summary.activeBackoffs} active provider backoff window(s)`,
      ],
      blocker: cleanQueuesReady ? 'None' : 'Failed jobs, critical lifecycle notices, or provider backoff need operator action.',
      command: 'npm run admin -- operations-health --json',
      followUpCommands: ['npm run admin -- jobs retry <jobId>', 'npm run admin -- jobs drain billing_webhook', 'npm run admin -- jobs drain outbound_email'],
      rollbackCommand: 'Do not drain queues blindly; retry or drain only after the owning integration/billing issue is understood.',
      completion: 'Operations health is locally ready with no failed billing or outbound-email queue blockers.',
    }),
    schedulerHandoffStep({
      id: 'wire_alerting_runbook',
      label: 'Wire scheduler alerts and runbook',
      priority: 50,
      env,
      productionOk: alertingReady,
      requiredEnv: alertingEnv,
      evidence: [
        ...(drillRows.alerting_runbook?.evidence ?? ['Alerting runbook not evaluated']),
        `Operations health command: npm run admin -- operations-health --env-file ./.env.production --json`,
      ],
      blocker: alertingReady ? 'None' : 'Operations alert channel or launch runbook proof is missing.',
      command: 'npm run admin -- production-drill --env-file ./.env.production --json',
      followUpCommands: ['npm run admin -- scheduler-handoff --env-file ./.env.production --json'],
      rollbackCommand: 'Keep continuous scheduling disabled until failed-job alerts and the production runbook are attached.',
      completion: 'Failed jobs, provider backoff, outbound email, billing webhook, and lifecycle alerts have an owner and runbook URL.',
    }),
    schedulerHandoffStep({
      id: 'enable_continuous_scheduler',
      label: 'Enable continuous scheduler runner',
      priority: 60,
      env,
      productionOk: schedulerProductionReady,
      requiredEnv: uniqueValues([...schedulerEnv, ...singleRunnerEnv, ...alertingEnv, ...backendEnv]),
      evidence: [
        schedulerGate?.evidence?.join(' | ') ?? 'Launch gate scheduler row not evaluated.',
        drillRows.scheduler_daemon?.evidence?.join(' | ') ?? 'Production scheduler drill row not evaluated.',
      ],
      blocker: schedulerProductionReady ? 'None' : 'Continuous scheduler must wait for env, schedules, clean queues, alerting, backend, and launch-gate proof.',
      command: 'SIGNAL_JOB_SCHEDULER=signal-scheduler SIGNAL_PROVIDER_VALIDATION_SCHEDULER=signal-scheduler npm run scheduler',
      followUpCommands: ['npm run admin -- scheduler-handoff --env-file ./.env.production --json', 'npm run admin -- launch-gate --env-file ./.env.production --json'],
      rollbackCommand: 'Stop the scheduler process or unset SIGNAL_JOB_SCHEDULER; keep API traffic on the last known-good backend until operations-health passes.',
      completion: 'Exactly one scheduler runner is active against the production backend, operations-health is clean, and launch-gate scheduler_operations passes.',
    }),
    schedulerHandoffStep({
      id: 'package_scheduler_evidence',
      label: 'Package redacted scheduler evidence',
      priority: 70,
      env,
      productionOk: schedulerProductionReady,
      evidence: [
        `${gate.summary.passed}/${gate.summary.total} launch gate(s) pass`,
        `${drill.summary.productionReady}/${drill.summary.total} production drill row(s) ready`,
      ],
      blocker: schedulerProductionReady ? 'None' : 'Scheduler evidence cannot be packaged until the continuous scheduler row is ready.',
      command: 'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json',
      followUpCommands: ['npm run admin -- launch-gate verify-package ./signal-launch-evidence.json --json'],
      rollbackCommand: 'Reject the launch package if verification fails or scheduler proof is missing.',
      completion: 'The launch evidence package includes scheduler handoff, production-drill, operations-health, and launch-gate proof without credentials.',
    }),
  ];
  const nextStep = rows.find((row) => !row.productionOk) ?? {
    id: 'scheduler_handoff_complete',
    label: 'Scheduler handoff evidence complete',
    owner: 'operations',
    priority: 100,
    status: 'ready',
    localOk: true,
    productionOk: true,
    requiredEnv: [],
    configuredEnv: [],
    missingEnv: [],
    evidence: [`${rows.length}/${rows.length} scheduler handoff steps ready`],
    blocker: 'None',
    command: 'npm run admin -- launch-gate --env-file ./.env.production --json',
    followUpCommands: ['npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json'],
    rollbackCommand: 'Keep scheduler rollback notes attached to the launch package.',
    completion: 'Scheduler proof is complete; continue through provider, email, and payment launch gates.',
  };
  const report = {
    generatedAt: new Date().toISOString(),
    ok: true,
    productionReady: schedulerProductionReady,
    nextStep,
    rows,
    backend: {
      mode: currentBackend.mode,
      productionReady: currentBackend.productionReady,
      schedulerReady: Boolean(scheduler?.ok),
    },
    operations: {
      ok: health.ok,
      productionReady: health.productionReady,
      failedJobs,
      activeProviderSchedules,
      totalProviderSchedules,
      dueProviderSchedules,
    },
    recommendation: {
      summary: 'Use scheduler-handoff after backend-cutover to prove the production scheduler can run safely as a single managed runner.',
      productionGuardrail: 'Do not enable continuous production scheduling until scheduler env, active provider validation schedules, clean queues, alert routing, runbook ownership, external backend, and redacted launch evidence all pass.',
      localAgentCommand: 'npm run admin -- scheduler-handoff --env-file ./.env.production --json',
    },
    runnableCommands: uniqueValues([
      'npm run admin -- scheduler-handoff --json',
      'npm run admin -- scheduler-handoff --env-file ./.env.production --json',
      'curl http://127.0.0.1:8787/api/scheduler-handoff',
      'npm run scheduler -- --once --dry-run --json',
      'SIGNAL_JOB_SCHEDULER=signal-scheduler SIGNAL_PROVIDER_VALIDATION_SCHEDULER=signal-scheduler npm run scheduler -- --once --json',
      'npm run admin -- operations-health --json',
      'npm run test:scheduler',
      nextStep.command,
      nextStep.rollbackCommand,
      ...nextStep.followUpCommands,
    ].filter(Boolean)),
    summary: {
      activeProviderSchedules,
      blocked: rows.filter((row) => !row.productionOk).length,
      configuredEnv: uniqueValues(rows.flatMap((row) => row.configuredEnv ?? [])).length,
      dueProviderSchedules,
      failedJobs,
      missingRequiredEnv: uniqueValues(rows.flatMap((row) => row.missingEnv ?? [])).length,
      nextStepId: nextStep.id,
      productionReady: rows.filter((row) => row.productionOk).length,
      secretSafe: false,
      total: rows.length,
    },
  };
  report.summary.secretSafe = providerLaunchUnsafePaths(report).length === 0;
  report.ok = report.summary.secretSafe && Boolean(currentBackend.ok) && Boolean(health.ok);
  return report;
}

function completionAuditRow({
  api = null,
  blockers = [],
  commands = [],
  evidence = [],
  id,
  label,
  localOk,
  owner,
  productionOk = localOk,
}) {
  const normalizedBlockers = uniqueValues(blockers);
  return {
    api,
    blockers: normalizedBlockers,
    commands: uniqueValues(commands),
    evidence: uniqueValues(evidence),
    id,
    label,
    localOk: Boolean(localOk),
    owner,
    productionOk: Boolean(productionOk),
    status: productionOk
      ? 'production_ready'
      : localOk
        ? 'local_complete'
        : 'needs_local_work',
  };
}

export function completionAuditReport(state, {
  agentHandoff = null,
  backend = null,
  dashboardAudit = null,
  digestionPipeline = null,
  emailHandoff = null,
  env = process.env,
  launchGate = null,
  lifecyclePlaybook = null,
  onboarding = null,
  operations = null,
  paymentHandoff = null,
  paymentLifecycle = null,
  productionPlan = null,
  provider = providerReadiness(env),
  providerLaunch = null,
  qaAnswers = null,
  readiness = null,
  statePath = resolveStatePath(),
  tenantIsolation = null,
} = {}) {
  const summary = summarizeState(state, statePath);
  const currentBackend = backend;
  const currentProvider = provider;
  const product = readiness ?? productReadinessReport(state, { backend: currentBackend, provider: currentProvider });
  const dashboard = dashboardAudit ?? dashboardAuditReport(state, { backend: currentBackend, statePath });
  const pipeline = digestionPipeline ?? signalDigestionPipelineReport(state, { backend: currentBackend, statePath });
  const onboardingReport = onboarding ?? onboardingReadinessReport(state, { backend: currentBackend, statePath });
  const isolation = tenantIsolation ?? tenantIsolationAuditReport(state, { backend: currentBackend, statePath });
  const health = operations ?? operationsHealthReport(state, { backend: currentBackend, statePath });
  const lifecycle = lifecyclePlaybook ?? lifecyclePlaybookReport(state, { backend: currentBackend, statePath });
  const launch = providerLaunch ?? providerLaunchMatrixReport(state, { backend: currentBackend, env, provider: currentProvider });
  const gate = launchGate ?? launchGateReport(state, { backend: currentBackend, provider: currentProvider, readiness: product });
  const payment = paymentLifecycle ?? paymentLifecycleAuditReport(state, { backend: currentBackend, provider: currentProvider, providerLaunch: launch, statePath });
  const email = emailHandoff ?? emailHandoffReport(state, {
    backend: currentBackend,
    env,
    launchGate: gate,
    lifecyclePlaybook: lifecycle,
    operations: health,
    provider: currentProvider,
    providerLaunch: launch,
    readiness: product,
    statePath,
  });
  const paymentLaunch = paymentHandoff ?? paymentHandoffReport(state, {
    backend: currentBackend,
    env,
    launchGate: gate,
    paymentLifecycle: payment,
    provider: currentProvider,
    providerLaunch: launch,
    readiness: product,
    statePath,
  });
  const qa = qaAnswers ?? qaAnswersReport(state, {
    backend: currentBackend,
    dashboardAudit: dashboard,
    digestionPipeline: pipeline,
    lifecyclePlaybook: lifecycle,
    onboarding: onboardingReport,
    operations: health,
    provider: currentProvider,
    providerLaunch: launch,
    readiness: product,
    statePath,
  });
  const plan = productionPlan ?? productionSetupPlanReport(state, {
    backend: currentBackend,
    env,
    launchGate: gate,
    operations: health,
    provider: currentProvider,
    providerLaunch: launch,
    readiness: product,
    statePath,
  });
  const handoff = agentHandoff ?? localAgentHandoffReport(state, {
    backend: currentBackend,
    env,
    launchGate: gate,
    operations: health,
    productionPlan: plan,
    provider: currentProvider,
    providerLaunch: launch,
    readiness: product,
    statePath,
  });
  const readinessRow = (id) => readinessById(product, id);
  const qaRow = (id) => qa.rows.find((row) => row.id === id);
  const localProductGate = launchGateById(gate, 'local_product_surface');
  const emailGate = launchGateById(gate, 'email_notification_launch');
  const paymentGate = launchGateById(gate, 'payment_launch');
  const dashboardQa = qaRow('dashboard_calculations_backend');
  const onboardingQa = qaRow('workspace_registration_invitation');
  const relationshipQa = qaRow('contact_relationship_strategy');
  const emailQa = qaRow('email_notification_admin_monitoring');
  const paymentQa = qaRow('payment_lifecycle_handling');
  const rows = [
    completionAuditRow({
      id: 'public_product_entry',
      label: 'Public product entry and route into the app',
      owner: 'product',
      localOk: product.ok && localProductGate?.status === 'pass',
      productionOk: localProductGate?.status === 'pass',
      evidence: [
        `${product.summary.localReady}/${product.summary.total} local product readiness area(s) pass`,
        `${summary.tenants} tenant(s), ${summary.users} user(s), ${summary.mailboxes} mailbox source(s), ${summary.subscriptions} subscription record(s)`,
      ],
      blockers: localProductGate?.blockers ?? [],
      commands: ['npm run admin -- readiness --json', 'npm run test:browser-routes'],
      api: '/api/readiness',
    }),
    completionAuditRow({
      id: 'workspace_registration_onboarding',
      label: 'Self-service registration, workspace creation, onboarding, and member invitation',
      owner: 'workspace_admin',
      localOk: Boolean(onboardingReport.ok && onboardingQa?.localOk),
      productionOk: onboardingReport.productionReady,
      evidence: [
        `${onboardingReport.summary.activeAdmins} active admin(s) and ${onboardingReport.summary.activeMembers} active member(s)`,
        `${summary.pendingInvites ?? 0}/${summary.invites ?? 0} pending invite(s)`,
        `${summary.activeSeats ?? 0}+${summary.pendingInviteSeats ?? 0}/${summary.seatLimit ?? 'unlimited'} active+pending seat(s)`,
      ],
      blockers: onboardingReport.productionReady ? [] : [onboardingReport.recommendation.productionGuardrail],
      commands: ['npm run admin -- onboarding-readiness --json', 'npm run admin -- tenants register New_Revenue_Lab newlab.example owner@newlab.example Owner_Name plan_beta', 'npm run admin -- users invite tenant_demo rowan@acme.example member success'],
      api: '/api/onboarding-readiness',
    }),
    completionAuditRow({
      id: 'rbac_privacy_multi_member_org',
      label: 'Multi-member organization RBAC and member data privacy',
      owner: 'security',
      localOk: Boolean(isolation.ok && readinessRow('multi_user_rbac_privacy')?.localOk),
      productionOk: Boolean(isolation.productionReady && readinessRow('multi_user_rbac_privacy')?.productionOk),
      evidence: [
        `${isolation.summary.activeAdmins} admin(s), ${isolation.summary.activeMembers} member(s)`,
        `${isolation.summary.actorScopedRows} actor-scoped audit row(s)`,
        `${summary.activeApiSessions ?? 0}/${summary.apiSessions ?? 0} active API session(s)`,
      ],
      blockers: isolation.productionReady ? [] : [isolation.recommendation.productionGuardrail],
      commands: ['npm run admin -- tenant-isolation --json', 'npm run admin -- users --json', 'npm run admin -- session token usr_admin --json'],
      api: '/api/tenant-isolation',
    }),
    completionAuditRow({
      id: 'core_user_workspace',
      label: 'Core user workspace: signals, accounts, recommendations, focus, notifications, and billing view',
      owner: 'product',
      localOk: Boolean(
        dashboard.ok &&
        readinessRow('email_source_and_detection_flow')?.localOk &&
        readinessRow('relationship_dashboard_and_recommendations')?.localOk &&
        readinessRow('notifications_and_admin_monitoring')?.localOk &&
        readinessRow('payment_lifecycle_and_entitlements')?.localOk &&
        relationshipQa?.localOk
      ),
      productionOk: Boolean(currentBackend?.productionReady && launch.summary.passed === launch.summary.total),
      evidence: [
        `${dashboard.summary.passed}/${dashboard.summary.total} dashboard calculation check(s) pass`,
        `${pipeline.summary.localReady}/${pipeline.summary.total} digestion pipeline stage(s) locally ready`,
        `${summary.openSignals} open signal(s), ${summary.openAccountRecommendations ?? 0}/${summary.accountRecommendations ?? 0} open recommendation(s)`,
        `${payment.summary.localReady}/${payment.summary.total} payment lifecycle check(s) locally ready`,
      ],
      blockers: currentBackend?.productionReady && launch.summary.passed === launch.summary.total ? [] : ['Production user workspace needs durable backend, tenant isolation, provider launch, and scheduler evidence.'],
      commands: ['npm run admin -- dashboard-audit --json', 'npm run admin -- digestion-pipeline --json', 'npm run admin -- payment-lifecycle --json', 'npm run test:browser-routes'],
      api: '/api/dashboard-audit',
    }),
    completionAuditRow({
      id: 'core_admin_area',
      label: 'Core admin area: tenant, users, source governance, monitoring, operations, and QA',
      owner: 'operations',
      localOk: Boolean(product.ok && health.ok && lifecycle.ok && qa.ok),
      productionOk: Boolean(gate.goLiveReady && health.productionReady && qa.productionReady),
      evidence: [
        `${product.summary.localReady}/${product.summary.total} readiness area(s) local-ready`,
        `${health.summary.totalWebhooks - health.summary.unhealthyWebhooks}/${health.summary.totalWebhooks} webhook channel(s) healthy`,
        `${lifecycle.summary.localReady}/${lifecycle.summary.total} lifecycle playbook row(s) local-ready`,
        `${qa.summary.localReady}/${qa.summary.total} QA answer row(s) local-ready`,
      ],
      blockers: gate.goLiveReady ? [] : [`${gate.summary.blocked} launch gate(s) need production proof.`],
      commands: ['npm run admin -- operations-health --json', 'npm run admin -- lifecycle-playbook --json', 'npm run admin -- qa-answers --json'],
      api: '/api/operations-health',
    }),
    completionAuditRow({
      id: 'local_admin_cli_agent',
      label: 'Local admin CLI and agent handoff capability',
      owner: 'local_agent',
      localOk: Boolean(handoff.ok && readinessRow('local_admin_agent_operations')?.localOk),
      productionOk: handoff.goLiveReady,
      evidence: [
        `${handoff.summary.totalActions} ranked local-agent action(s)`,
        `${summary.jobs ?? 0} job record(s), ${summary.failedJobs ?? 0} failed job(s)`,
        `${summary.auditEvents ?? 0} audit event(s)`,
        `Next action: ${handoff.nextAction.id}`,
      ],
      blockers: handoff.goLiveReady ? [] : [handoff.nextAction.blocker],
      commands: ['npm run admin -- agent-handoff --json', 'npm run admin -- completion-audit --json', 'npm run admin -- export --json'],
      api: '/api/agent-handoff',
    }),
    completionAuditRow({
      id: 'email_flow_management',
      label: 'Email flow management, notifications, launch handoff, monitoring, and rollback',
      owner: 'integrations',
      localOk: Boolean(readinessRow('email_source_and_detection_flow')?.localOk && health.ok && email.ok && emailQa?.localOk),
      productionOk: Boolean(email.productionReady && emailGate?.status === 'pass'),
      evidence: [
        `${pipeline.summary.localReady}/${pipeline.summary.total} ingestion/detector stage(s) local-ready`,
        `${email.summary.total - email.summary.blocked}/${email.summary.total} email handoff step(s) launch-ready`,
        `${summary.activeEmailWatchSubscriptions ?? 0}/${summary.emailWatchSubscriptions ?? 0} active watch subscription(s)`,
        `${summary.failedEmailDeliveries ?? 0}/${summary.emailDeliveries ?? 0} failed email delivery record(s)`,
      ],
      blockers: email.productionReady ? [] : [email.nextStep.blocker],
      commands: ['npm run admin -- email-handoff --json', 'npm run admin -- operations-health --json', 'npm run admin -- notifications digest tenant_demo'],
      api: '/api/email-handoff',
    }),
    completionAuditRow({
      id: 'payment_processing_architecture',
      label: 'Payment processing architecture, lifecycle handling, entitlements, and Stripe handoff',
      owner: 'billing',
      localOk: Boolean(readinessRow('payment_lifecycle_and_entitlements')?.localOk && paymentLaunch.ok && paymentQa?.localOk),
      productionOk: Boolean(paymentLaunch.productionReady && paymentGate?.status === 'pass'),
      evidence: [
        `${payment.summary.localReady}/${payment.summary.total} payment lifecycle check(s) local-ready`,
        `${paymentLaunch.summary.total - paymentLaunch.summary.blocked}/${paymentLaunch.summary.total} payment handoff step(s) launch-ready`,
        `${summary.subscriptions} subscription record(s), ${summary.activeEntitlements ?? 0} active entitlement(s)`,
        `${summary.paymentEvents} payment event(s), ${summary.billingSessions ?? 0} billing session(s)`,
      ],
      blockers: paymentLaunch.productionReady ? [] : [paymentLaunch.nextStep.blocker],
      commands: ['npm run admin -- payment-lifecycle --json', 'npm run admin -- payment-handoff --json', 'npm run admin -- payments checkout tenant_demo plan_team'],
      api: '/api/payment-handoff',
    }),
  ];
  const localComplete = rows.every((row) => row.localOk);
  const productionReady = rows.every((row) => row.productionOk) && gate.goLiveReady;
  const nextLocal = rows.find((row) => !row.localOk) ?? null;
  const nextProduction = rows.find((row) => !row.productionOk) ?? null;
  const report = {
    generatedAt: new Date().toISOString(),
    ok: localComplete,
    localComplete,
    productionReady,
    nextLocal,
    nextProduction,
    rows,
    recommendation: {
      decision: localComplete ? 'local_saas_slice_complete' : 'continue_local_completion',
      summary: localComplete
        ? 'The local Signal SaaS slice covers public entry, onboarding, user workspace, admin operations, local-agent CLI, email management, and payment lifecycle architecture.'
        : `Continue local completion with ${nextLocal?.label ?? 'the next incomplete row'}.`,
      productionGuardrail: productionReady
        ? 'Production launch evidence is complete.'
        : 'Do not treat local completion as production launch readiness. Production still requires durable backend/auth/tenant isolation, live provider credentials, signed webhook replay, scheduler, and redacted launch evidence proof.',
      localAgentCommand: nextLocal?.commands?.[0] ?? nextProduction?.commands?.[0] ?? 'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json',
    },
    runnableCommands: uniqueValues([
      'npm run admin -- completion-audit --json',
      'curl http://127.0.0.1:8787/api/completion-audit',
      'npm run test:local',
      'npm run admin -- readiness --json',
      'npm run admin -- qa-answers --json',
      'npm run admin -- agent-handoff --json',
      'npm run admin -- launch-gate --env-file ./.env.production --json',
      ...rows.flatMap((row) => row.commands.slice(0, 2)),
    ]),
    summary: {
      localComplete,
      localReady: rows.filter((row) => row.localOk).length,
      needsLocalWork: rows.filter((row) => !row.localOk).length,
      needsProduction: rows.filter((row) => row.localOk && !row.productionOk).length,
      productionReady: rows.filter((row) => row.productionOk).length,
      secretSafe: false,
      total: rows.length,
    },
    supportingReports: {
      agentHandoff: handoff.ok,
      dashboardAudit: dashboard.ok,
      digestionPipeline: pipeline.ok,
      emailHandoff: email.ok,
      lifecyclePlaybook: lifecycle.ok,
      operationsHealth: health.ok,
      onboardingReadiness: onboardingReport.ok,
      paymentHandoff: paymentLaunch.ok,
      paymentLifecycle: payment.ok,
      qaAnswers: qa.ok,
      tenantIsolation: isolation.ok,
    },
  };
  report.summary.secretSafe = providerLaunchUnsafePaths(report).length === 0;
  report.ok = report.localComplete && report.summary.secretSafe;
  return report;
}

export function table(rows, columns) {
  const widths = columns.map((column) =>
    Math.max(
      column.length,
      ...rows.map((row) => String(row[column] ?? '').length),
    ),
  );
  const line = columns.map((column, index) => column.padEnd(widths[index])).join('  ');
  const divider = widths.map((width) => '-'.repeat(width)).join('  ');
  const body = rows
    .map((row) => columns.map((column, index) => String(row[column] ?? '').padEnd(widths[index])).join('  '))
    .join('\n');
  return [line, divider, body].filter(Boolean).join('\n');
}

function requireArg(value, label, usage) {
  if (!value) {
    throw new SignalStateError(`Missing ${label}.`, {
      code: 'ARG_MISSING',
      details: { label, usage },
    });
  }
  return value;
}

function apiSessionStatus(session, now = Date.now()) {
  if (session.status === 'revoked' || session.revokedAt) {
    return 'revoked';
  }
  const expiresMs = Date.parse(session.expiresAt ?? '');
  if (Number.isFinite(expiresMs) && expiresMs <= now) {
    return 'expired';
  }
  return session.status === 'expired' ? 'expired' : 'active';
}

function activeApiSessions(state, now = Date.now()) {
  return (state.apiSessions ?? []).filter((session) => apiSessionStatus(session, now) === 'active');
}

function apiSessionDigest(input, usage = 'session revoke <sessionId|digest|token>') {
  const value = requireArg(input, 'session id, digest, or token', usage);
  return value.includes('.') ? sessionTokenDigest(value) : value;
}

function findApiSession(state, input, usage = 'session revoke <sessionId|digest|token>') {
  const value = requireArg(input, 'session id, digest, or token', usage);
  const digest = apiSessionDigest(value, usage);
  const session = (state.apiSessions ?? []).find((candidate) => candidate.id === value || candidate.digest === digest);
  if (!session) {
    throw new SignalStateError(`API session was not found: ${digest}`, {
      code: 'SESSION_NOT_FOUND',
      status: 404,
      details: { sessionRef: digest },
    });
  }
  return session;
}

function registerApiSession(state, issued, target, actor) {
  state.apiSessions = state.apiSessions ?? [];
  const existing = state.apiSessions.find((session) => session.digest === issued.tokenDigest);
  const record = existing ?? {
    digest: issued.tokenDigest,
    id: `apis_${issued.tokenDigest.slice(0, 10)}`,
  };
  Object.assign(record, {
    authMode: 'hmac_local',
    expiresAt: issued.expiresAt,
    issuedAt: issued.issuedAt,
    issuedByUserId: actor.id,
    roleAtIssue: target.role,
    status: 'active',
    tenantId: target.tenantId,
    updatedAt: nowIso(),
    userId: target.id,
  });
  if (!existing) {
    state.apiSessions.push(record);
  }
  return record;
}

export function validateApiSession(state, verification) {
  const session = (state.apiSessions ?? []).find((candidate) => candidate.digest === verification.tokenDigest);
  if (!session) {
    throw new SignalStateError('API session is not registered in local state.', {
      code: 'SESSION_NOT_FOUND',
      status: 401,
      details: { sessionRef: verification.tokenDigest },
    });
  }
  const status = apiSessionStatus(session);
  if (status !== 'active') {
    throw new SignalStateError(`API session is ${status}: ${session.id}`, {
      code: status === 'revoked' ? 'SESSION_REVOKED' : 'SESSION_EXPIRED',
      status: 401,
      details: { sessionId: session.id, sessionStatus: status },
    });
  }
  if (session.userId !== verification.payload.sub) {
    throw new SignalStateError('API session subject does not match the signed token subject.', {
      code: 'SESSION_SUBJECT_MISMATCH',
      status: 401,
      details: { sessionId: session.id, sessionUserId: session.userId, tokenUserId: verification.payload.sub },
    });
  }
  const actor = getActor(state, session.userId);
  return {
    actor,
    session: {
      ...session,
      status,
    },
  };
}

export function listApiSessions(state) {
  return [...(state.apiSessions ?? [])]
    .map((session) => ({
      ...session,
      status: apiSessionStatus(session),
    }))
    .sort((left, right) => Date.parse(right.issuedAt ?? '') - Date.parse(left.issuedAt ?? ''));
}

function requireOneOf(value, allowed, label, usage) {
  if (!allowed.includes(value)) {
    throw new SignalStateError(`Invalid ${label}: ${value}. Allowed: ${allowed.join(', ')}`, {
      code: 'ARG_INVALID',
      details: { allowed, label, usage, value },
    });
  }
  return value;
}

function requirePositiveInteger(value, label, usage) {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new SignalStateError(`Invalid ${label}: ${value}`, {
      code: 'ARG_INVALID',
      details: { label, usage, value },
    });
  }
  return numberValue;
}

function findById(collection, id, label) {
  const item = collection.find((candidate) => candidate.id === id);
  if (!item) {
    throw new SignalStateError(`${label} not found: ${id}`, {
      code: 'NOT_FOUND',
      status: 404,
      details: { id, label },
    });
  }
  return item;
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function sha256Digest(value, length = 24) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, length);
}

function sandboxRunStatus(sandbox) {
  if ((sandbox.summary?.failed ?? 0) > 0) {
    return 'failed';
  }
  if ((sandbox.summary?.blocked ?? 0) > 0) {
    return 'blocked';
  }
  return 'passed';
}

function sanitizeSandboxCheck(check = {}) {
  return {
    id: String(check.id ?? 'unknown_check'),
    status: ['passed', 'failed', 'blocked'].includes(check.status) ? check.status : 'failed',
    ...(check.endpoint ? { endpoint: String(check.endpoint) } : {}),
    ...(check.method ? { method: String(check.method) } : {}),
    ...(check.objectId ? { objectId: String(check.objectId) } : {}),
    ...(check.providerErrorCode ? { providerErrorCode: String(check.providerErrorCode) } : {}),
    ...(check.providerErrorType ? { providerErrorType: String(check.providerErrorType) } : {}),
    ...(check.providerRequestId ? { providerRequestId: String(check.providerRequestId) } : {}),
    ...(check.requestDigest ? { requestDigest: String(check.requestDigest) } : {}),
    ...(typeof check.statusCode === 'number' ? { statusCode: check.statusCode } : {}),
  };
}

export function sanitizeProviderSandboxReport(sandbox = {}) {
  const providers = (sandbox.providers ?? []).map((provider) => ({
    id: String(provider.id ?? 'unknown_provider'),
    label: String(provider.label ?? provider.id ?? 'Unknown provider'),
    category: ['auth', 'email', 'payment'].includes(provider.category) ? provider.category : 'email',
    status: ['passed', 'failed', 'blocked'].includes(provider.status) ? provider.status : 'failed',
    missingRequired: (provider.missingRequired ?? []).map((item) => String(item)),
    checks: (provider.checks ?? []).map((check) => sanitizeSandboxCheck(check)),
  }));
  const summary = {
    blocked: Number(sandbox.summary?.blocked ?? providers.filter((provider) => provider.status === 'blocked').length),
    failed: Number(sandbox.summary?.failed ?? providers.filter((provider) => provider.status === 'failed').length),
    passed: Number(sandbox.summary?.passed ?? providers.filter((provider) => provider.status === 'passed').length),
    total: Number(sandbox.summary?.total ?? providers.length),
  };
  return {
    generatedAt: sandbox.generatedAt ?? nowIso(),
    ok: summary.failed === 0 && summary.blocked === 0,
    providers,
    summary,
  };
}

const providerSandboxEvidenceArtifactType = 'signal.provider_sandbox_evidence';
const providerSandboxEvidenceSchemaVersion = 1;

function providerValidationRunAsSandboxReport(run = {}) {
  return sanitizeProviderSandboxReport({
    generatedAt: run.generatedAt,
    ok: run.ok,
    providers: run.providers ?? [],
    summary: run.summary,
  });
}

function createProviderSandboxEvidenceArtifact(run, { exportedAt = nowIso(), exportedByUserId = null, sourceCommand = 'signal-admin integrations evidence-export' } = {}) {
  const sandbox = providerValidationRunAsSandboxReport(run);
  const sourceRun = {
    id: String(run.id ?? 'unknown_run'),
    generatedAt: sandbox.generatedAt,
    recordedAt: run.recordedAt ?? null,
    recordedByUserId: run.recordedByUserId ?? null,
    reportDigest: run.reportDigest ?? sha256Digest(JSON.stringify(sandbox)),
    status: sandboxRunStatus(sandbox),
  };
  const core = {
    artifactType: providerSandboxEvidenceArtifactType,
    schemaVersion: providerSandboxEvidenceSchemaVersion,
    exportedAt,
    exportedByUserId,
    sourceCommand,
    sourceRun,
    sandbox,
    providerStatuses: sandbox.providers.map((provider) => ({
      id: provider.id,
      category: provider.category,
      status: provider.status,
      checks: provider.checks.length,
      missingRequired: provider.missingRequired,
    })),
    privacy: {
      credentialValues: 'omitted',
      environmentNamesOnly: true,
      providerMessages: 'omitted',
      rawPayloads: 'omitted',
    },
    summary: sandbox.summary,
  };
  return {
    ...core,
    artifactDigest: sha256Digest(JSON.stringify(core)),
  };
}

function providerSandboxEvidenceDigest(artifact = {}) {
  const { artifactDigest, ...core } = artifact;
  return sha256Digest(JSON.stringify(core));
}

function stringLooksLikeCredentialValue(value) {
  const text = String(value);
  return (
    /sk_(?:live|test)_[A-Za-z0-9_]{8,}/.test(text) ||
    /SG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text) ||
    /ya29\.[A-Za-z0-9_-]{20,}/.test(text) ||
    /(?:access_token|refresh_token|client_secret|api_key)=([^&\s]{8,})/i.test(text)
  );
}

function credentialValuePaths(value, prefix = '') {
  if (typeof value === 'string') {
    return stringLooksLikeCredentialValue(value) ? [prefix || '<root>'] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => credentialValuePaths(child, `${prefix}[${index}]`));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    const currentPath = prefix ? `${prefix}.${key}` : key;
    return credentialValuePaths(child, currentPath);
  });
}

function assertProviderSandboxEvidenceArtifactSafe(artifact) {
  const sensitivePaths = sensitiveKeyPaths(artifact);
  if (sensitivePaths.length > 0) {
    throw new SignalStateError('Provider sandbox evidence artifact contains sensitive key names.', {
      code: 'PROVIDER_EVIDENCE_UNSAFE',
      status: 400,
      details: { sensitivePaths },
    });
  }
  const credentialPaths = credentialValuePaths(artifact);
  if (credentialPaths.length > 0) {
    throw new SignalStateError('Provider sandbox evidence artifact appears to contain credential values.', {
      code: 'PROVIDER_EVIDENCE_UNSAFE',
      status: 400,
      details: { credentialPaths },
    });
  }
}

function sanitizeProviderSandboxEvidenceArtifact(artifact = {}) {
  assertProviderSandboxEvidenceArtifactSafe(artifact);
  if (artifact.artifactType !== providerSandboxEvidenceArtifactType || artifact.schemaVersion !== providerSandboxEvidenceSchemaVersion) {
    throw new SignalStateError('Unsupported provider sandbox evidence artifact.', {
      code: 'PROVIDER_EVIDENCE_UNSUPPORTED',
      status: 400,
      details: {
        artifactType: artifact.artifactType ?? null,
        schemaVersion: artifact.schemaVersion ?? null,
        supportedArtifactType: providerSandboxEvidenceArtifactType,
        supportedSchemaVersion: providerSandboxEvidenceSchemaVersion,
      },
    });
  }
  if (!artifact.artifactDigest) {
    throw new SignalStateError('Provider sandbox evidence artifact is missing an artifact digest.', {
      code: 'PROVIDER_EVIDENCE_DIGEST_MISSING',
      status: 400,
      details: { requiredField: 'artifactDigest' },
    });
  }
  const calculatedDigest = providerSandboxEvidenceDigest(artifact);
  if (artifact.artifactDigest !== calculatedDigest) {
    throw new SignalStateError('Provider sandbox evidence artifact digest does not match its contents.', {
      code: 'PROVIDER_EVIDENCE_DIGEST_MISMATCH',
      status: 400,
      details: { calculatedDigest, providedDigest: artifact.artifactDigest },
    });
  }
  const sandbox = sanitizeProviderSandboxReport(artifact.sandbox);
  if (sandbox.providers.length === 0 || sandbox.summary.total === 0) {
    throw new SignalStateError('Provider sandbox evidence artifact does not contain provider validation results.', {
      code: 'PROVIDER_EVIDENCE_EMPTY',
      status: 400,
      details: { providerCount: sandbox.providers.length, total: sandbox.summary.total },
    });
  }
  return {
    artifactDigest: artifact.artifactDigest,
    artifactType: providerSandboxEvidenceArtifactType,
    exportedAt: artifact.exportedAt ?? null,
    schemaVersion: providerSandboxEvidenceSchemaVersion,
    sandbox,
    sourceCommand: artifact.sourceCommand ?? null,
    sourceRun: {
      generatedAt: artifact.sourceRun?.generatedAt ?? sandbox.generatedAt,
      id: String(artifact.sourceRun?.id ?? 'unknown_run'),
      recordedAt: artifact.sourceRun?.recordedAt ?? null,
      reportDigest: artifact.sourceRun?.reportDigest ?? null,
      status: artifact.sourceRun?.status ?? sandboxRunStatus(sandbox),
    },
  };
}

function providerValidationRunByRef(state, runRef = 'latest') {
  const runs = [...(state.providerValidationRuns ?? [])].sort((left, right) => Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? ''));
  if (runs.length === 0) {
    throw new SignalStateError('No provider sandbox validation evidence runs are available to export.', {
      code: 'NOT_FOUND',
      status: 404,
      details: { runRef },
    });
  }
  if (!runRef || runRef === 'latest') {
    return runs[0];
  }
  const run = runs.find((candidate) => candidate.id === runRef || candidate.reportDigest === runRef);
  if (!run) {
    throw new SignalStateError(`Provider sandbox validation run not found: ${runRef}`, {
      code: 'NOT_FOUND',
      status: 404,
      details: { runRef },
    });
  }
  return run;
}

function expiresInIso(milliseconds) {
  return new Date(Date.now() + milliseconds).toISOString();
}

function appendPaymentEvent(state, {
  tenantId,
  provider = 'local_test',
  type,
  status = 'recorded',
  subscriptionId,
  providerSubscriptionId,
  providerCustomerId,
  sessionId,
  invoiceId,
  providerInvoiceId,
  providerEventId,
  providerEventType,
  providerStatus,
  appliedType,
  billingOverrideId,
  amountCents,
  signatureStatus,
  signatureVerifiedAt,
  signatureTimestamp,
  livemode,
}) {
  state.paymentEvents = state.paymentEvents ?? [];
  const event = {
    id: makeId('evt'),
    tenantId,
    provider,
    type,
    status,
    ...(providerEventId ? { providerEventId } : {}),
    ...(providerEventType ? { providerEventType } : {}),
    ...(providerStatus ? { providerStatus } : {}),
    ...(appliedType ? { appliedType } : {}),
    ...(billingOverrideId ? { billingOverrideId } : {}),
    ...(typeof amountCents === 'number' ? { amountCents } : {}),
    ...(signatureStatus ? { signatureStatus } : {}),
    ...(signatureVerifiedAt ? { signatureVerifiedAt } : {}),
    ...(signatureTimestamp ? { signatureTimestamp } : {}),
    ...(typeof livemode === 'boolean' ? { livemode } : {}),
    ...(subscriptionId ? { subscriptionId } : {}),
    ...(providerSubscriptionId ? { providerSubscriptionId } : {}),
    ...(providerCustomerId ? { providerCustomerId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(invoiceId ? { invoiceId } : {}),
    ...(providerInvoiceId ? { providerInvoiceId } : {}),
    createdAt: nowIso(),
  };
  state.paymentEvents.push(event);
  return event;
}

function latestInvoiceForSubscription(state, subscriptionId) {
  return [...(state.invoices ?? [])]
    .filter((invoice) => invoice.subscriptionId === subscriptionId)
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0] ?? null;
}

function findSubscriptionByLocalOrProviderId(state, subscriptionId, provider = 'local_test') {
  const id = requireArg(subscriptionId, 'subscription id', 'payments webhook <type> <subscriptionId>');
  const subscription = (state.subscriptions ?? []).find((candidate) =>
    candidate.id === id ||
    candidate.providerSubscriptionId === id ||
    candidate.stripeSubscriptionId === id);
  if (!subscription) {
    throw new SignalStateError(`Subscription not found: ${id}`, {
      code: 'NOT_FOUND',
      status: 404,
      details: { provider, subscriptionId: id },
    });
  }
  return subscription;
}

function optionalSubscriptionByLocalOrProviderId(state, subscriptionId) {
  if (!subscriptionId) {
    return null;
  }
  return (state.subscriptions ?? []).find((candidate) =>
    candidate.id === subscriptionId ||
    candidate.providerSubscriptionId === subscriptionId ||
    candidate.stripeSubscriptionId === subscriptionId) ?? null;
}

function upsertSubscriptionFromProviderMetadata(state, {
  planId,
  provider = 'local_test',
  providerSubscriptionId,
  status = 'active',
  subscriptionId,
  tenantId,
} = {}) {
  let subscription = optionalSubscriptionByLocalOrProviderId(state, subscriptionId)
    ?? optionalSubscriptionByLocalOrProviderId(state, providerSubscriptionId);
  if (subscription) {
    return subscription;
  }

  const tenant = findById(state.tenants, requireArg(tenantId, 'tenant id', 'payments webhook subscription.updated <subscriptionId> <status>'), 'Tenant');
  const plan = findById(state.plans, requireArg(planId ?? tenant.planId, 'plan id', 'payments webhook subscription.updated <subscriptionId> <status>'), 'Plan');
  subscription = {
    id: subscriptionId && !subscriptionId.startsWith('sub_') ? `sub_${tenant.id}` : (subscriptionId ?? `sub_${tenant.id}`),
    tenantId: tenant.id,
    provider,
    planId: plan.id,
    status,
  };
  state.subscriptions = state.subscriptions ?? [];
  state.subscriptions.push(subscription);
  tenant.planId = plan.id;
  return subscription;
}

function applySubscriptionProviderRefs(subscription, {
  provider,
  providerCustomerId,
  providerEventId,
  providerEventType,
  providerPriceId,
  providerSessionId,
  providerStatus,
  providerSubscriptionId,
  currentPeriodEndAt,
  livemode,
  signatureStatus,
  signatureVerifiedAt,
} = {}) {
  if (provider && provider !== 'local_test') {
    subscription.provider = provider;
  }
  if (providerSubscriptionId) {
    subscription.providerSubscriptionId = providerSubscriptionId;
    if (provider === 'stripe') {
      subscription.stripeSubscriptionId = providerSubscriptionId;
    }
  }
  if (providerCustomerId) {
    subscription.providerCustomerId = providerCustomerId;
    if (provider === 'stripe') {
      subscription.stripeCustomerId = providerCustomerId;
    }
  }
  if (providerPriceId) {
    subscription.providerPriceId = providerPriceId;
  }
  if (providerStatus) {
    subscription.providerStatus = providerStatus;
  }
  if (providerSessionId) {
    subscription.providerCheckoutSessionId = providerSessionId;
  }
  if (currentPeriodEndAt) {
    subscription.currentPeriodEndAt = currentPeriodEndAt;
  }
  if (typeof livemode === 'boolean') {
    subscription.livemode = livemode;
  }
  if (providerEventId) {
    subscription.providerLastEventId = providerEventId;
  }
  if (providerEventType) {
    subscription.providerLastEventType = providerEventType;
  }
  if (signatureStatus) {
    subscription.providerSignatureStatus = signatureStatus;
  }
  if (signatureVerifiedAt) {
    subscription.providerSignatureVerifiedAt = signatureVerifiedAt;
  }
  if (provider && provider !== 'local_test') {
    subscription.providerSyncedAt = nowIso();
  }
  return subscription;
}

function applyInvoiceProviderRefs(invoice, {
  hostedInvoiceUrl,
  nextPaymentAttemptAt,
  providerCustomerId,
  providerEventId,
  providerEventType,
  providerInvoiceId,
  providerPriceId,
  providerSubscriptionId,
  signatureStatus,
  signatureVerifiedAt,
} = {}) {
  if (!invoice) {
    return null;
  }
  if (providerInvoiceId) {
    invoice.providerInvoiceId = providerInvoiceId;
  }
  if (providerSubscriptionId) {
    invoice.providerSubscriptionId = providerSubscriptionId;
  }
  if (providerCustomerId) {
    invoice.providerCustomerId = providerCustomerId;
  }
  if (providerPriceId) {
    invoice.providerPriceId = providerPriceId;
  }
  if (hostedInvoiceUrl) {
    invoice.hostedInvoiceUrl = hostedInvoiceUrl;
  }
  if (nextPaymentAttemptAt !== undefined) {
    invoice.nextPaymentAttemptAt = nextPaymentAttemptAt;
  }
  if (providerEventId) {
    invoice.providerLastEventId = providerEventId;
  }
  if (providerEventType) {
    invoice.providerLastEventType = providerEventType;
  }
  if (signatureStatus) {
    invoice.providerSignatureStatus = signatureStatus;
  }
  if (signatureVerifiedAt) {
    invoice.providerSignatureVerifiedAt = signatureVerifiedAt;
  }
  return invoice;
}

function upsertInvoiceForSubscription(state, subscription, status, { amountDueCents, retryCount } = {}) {
  const plan = state.plans?.find((candidate) => candidate.id === subscription.planId);
  state.invoices = state.invoices ?? [];
  let invoice = latestInvoiceForSubscription(state, subscription.id);
  if (!invoice || invoice.status === 'paid' || invoice.status === 'void') {
    invoice = {
      id: makeId('inv'),
      tenantId: subscription.tenantId,
      subscriptionId: subscription.id,
      provider: subscription.provider,
      amountDueCents: amountDueCents ?? plan?.monthlyCents ?? 0,
      currency: 'usd',
      hostedInvoiceUrl: `signal://billing/invoice/${subscription.tenantId}/${subscription.id}`,
      createdAt: nowIso(),
      dueAt: expiresInIso(7 * 24 * 60 * 60 * 1000),
      retryCount: 0,
      nextPaymentAttemptAt: null,
    };
    state.invoices.push(invoice);
  }

  invoice.status = status;
  invoice.amountDueCents = amountDueCents ?? invoice.amountDueCents ?? plan?.monthlyCents ?? 0;
  invoice.provider = subscription.provider;
  invoice.tenantId = subscription.tenantId;
  invoice.subscriptionId = subscription.id;
  invoice.hostedInvoiceUrl = `signal://billing/invoice/${subscription.tenantId}/${invoice.id}`;

  if (status === 'paid') {
    invoice.paidAt = nowIso();
    invoice.nextPaymentAttemptAt = null;
  } else if (status === 'past_due') {
    invoice.paidAt = null;
    invoice.retryCount = retryCount ?? ((invoice.retryCount ?? 0) + 1);
    invoice.nextPaymentAttemptAt = expiresInIso(2 * 24 * 60 * 60 * 1000);
  } else if (status === 'open') {
    invoice.paidAt = null;
    invoice.nextPaymentAttemptAt = invoice.nextPaymentAttemptAt ?? expiresInIso(2 * 24 * 60 * 60 * 1000);
  } else if (status === 'void') {
    invoice.nextPaymentAttemptAt = null;
  }

  return invoice;
}

function appendJob(state, {
  tenantId,
  queue,
  type,
  targetId,
  status = 'queued',
  attempts = 0,
  maxAttempts = 3,
  message,
  nextRunAt,
  providerCredentialRefreshedAt,
  providerCredentialSource,
  providerCredentialVaultRef,
  providerErrorCode,
  providerRequestDigest,
  providerResponseDigest,
  providerResponseStatus,
  providerRetryAfterAt,
  providerValidationRunId,
  providerValidationStatus,
  sourceMessagesCreated,
  sourceMessagesUpdated,
  sourceMessagesUpserted,
}) {
  state.jobs = state.jobs ?? [];
  const job = {
    id: makeId('job'),
    tenantId,
    queue,
    type,
    targetId,
    status,
    attempts,
    maxAttempts,
    lastRunAt: status === 'queued' ? null : nowIso(),
    message,
  };
  if (nextRunAt !== undefined) {
    job.nextRunAt = nextRunAt;
  }
  if (providerCredentialRefreshedAt !== undefined) {
    job.providerCredentialRefreshedAt = providerCredentialRefreshedAt;
  }
  if (providerCredentialSource !== undefined) {
    job.providerCredentialSource = providerCredentialSource;
  }
  if (providerCredentialVaultRef !== undefined) {
    job.providerCredentialVaultRef = providerCredentialVaultRef;
  }
  if (providerErrorCode !== undefined) {
    job.providerErrorCode = providerErrorCode;
  }
  if (providerRequestDigest !== undefined) {
    job.providerRequestDigest = providerRequestDigest;
  }
  if (providerResponseDigest !== undefined) {
    job.providerResponseDigest = providerResponseDigest;
  }
  if (providerResponseStatus !== undefined) {
    job.providerResponseStatus = providerResponseStatus;
  }
  if (providerRetryAfterAt !== undefined) {
    job.providerRetryAfterAt = providerRetryAfterAt;
  }
  if (providerValidationRunId !== undefined) {
    job.providerValidationRunId = providerValidationRunId;
  }
  if (providerValidationStatus !== undefined) {
    job.providerValidationStatus = providerValidationStatus;
  }
  if (sourceMessagesCreated !== undefined) {
    job.sourceMessagesCreated = sourceMessagesCreated;
  }
  if (sourceMessagesUpdated !== undefined) {
    job.sourceMessagesUpdated = sourceMessagesUpdated;
  }
  if (sourceMessagesUpserted !== undefined) {
    job.sourceMessagesUpserted = sourceMessagesUpserted;
  }
  state.jobs.push(job);
  return job;
}

function lifecycleText(value) {
  return String(value ?? '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function lifecycleOwnerForTenant(state, tenantId) {
  const tenant = (state.tenants ?? []).find((candidate) => candidate.id === tenantId);
  return tenant?.billingOwnerUserId
    ?? tenant?.ownerUserId
    ?? (state.users ?? []).find((user) => user.tenantId === tenantId && user.role === 'admin' && user.status === 'active')?.id
    ?? null;
}

function compactSourceIds(sourceIds = {}) {
  return Object.fromEntries(Object.entries(sourceIds).filter(([, value]) => Boolean(value)));
}

function lifecycleNotice({
  actionLabel,
  actionTarget,
  body,
  category,
  createdAt,
  id,
  ownerUserId,
  provider,
  resolvedAt,
  severity = 'info',
  sourceIds,
  status = 'monitoring',
  tenantId,
  title,
  trigger,
  updatedAt,
}) {
  return {
    id,
    tenantId,
    category,
    trigger,
    severity,
    status,
    title,
    body,
    ...(ownerUserId ? { ownerUserId } : {}),
    ...(provider ? { provider } : {}),
    ...(actionLabel ? { actionLabel } : {}),
    ...(actionTarget ? { actionTarget } : {}),
    ...(Object.keys(compactSourceIds(sourceIds)).length ? { sourceIds: compactSourceIds(sourceIds) } : {}),
    createdAt: createdAt ?? nowIso(),
    ...(updatedAt ? { updatedAt } : {}),
    ...(resolvedAt ? { resolvedAt } : {}),
  };
}

function latestByCreatedAt(collection) {
  return [...collection].sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))[0] ?? null;
}

function latestBillingSession(state, tenantId, type) {
  return latestByCreatedAt((state.billingSessions ?? []).filter((session) => session.tenantId === tenantId && session.type === type));
}

function lifecycleNoticeForSubscription(state, subscription) {
  const tenant = (state.tenants ?? []).find((candidate) => candidate.id === subscription.tenantId);
  const plan = (state.plans ?? []).find((candidate) => candidate.id === subscription.planId);
  const isRestricted = ['past_due', 'canceled'].includes(subscription.status);
  const isCanceled = subscription.status === 'canceled';
  return lifecycleNotice({
    actionLabel: isCanceled ? 'Start checkout' : 'Open billing portal',
    actionTarget: isCanceled ? `payments checkout ${subscription.tenantId} ${subscription.planId}` : `payments portal ${subscription.tenantId}`,
    body: `${plan?.name ?? subscription.planId} subscription is ${lifecycleText(subscription.status)} through ${subscription.provider}. Entitlements are computed from this billing state, not browser counters.`,
    category: 'payment',
    createdAt: subscription.canceledAt ?? tenant?.createdAt ?? state.meta?.bootstrappedAt ?? state.meta?.updatedAt ?? nowIso(),
    id: `lcn_subscription_${subscription.id}`,
    ownerUserId: lifecycleOwnerForTenant(state, subscription.tenantId),
    provider: subscription.provider,
    resolvedAt: isCanceled ? null : undefined,
    severity: isRestricted ? 'watch' : 'info',
    sourceIds: { subscriptionId: subscription.id, tenantId: subscription.tenantId },
    status: isRestricted ? 'open' : 'monitoring',
    tenantId: subscription.tenantId,
    title: isCanceled ? 'Subscription canceled' : 'Subscription starting point',
    trigger: isCanceled ? 'subscription_canceled' : 'subscription_starting_point',
    updatedAt: subscription.providerSyncedAt ?? subscription.currentPeriodEndAt ?? null,
  });
}

function lifecycleNoticeForInvoice(state, invoice) {
  const open = ['open', 'past_due'].includes(invoice.status);
  const pastDue = invoice.status === 'past_due';
  return lifecycleNotice({
    actionLabel: open ? 'Create recovery session' : 'Review invoice',
    actionTarget: open ? `payments recover ${invoice.id}` : `payments`,
    body: `${invoice.id} is ${lifecycleText(invoice.status)} for $${((invoice.amountDueCents ?? 0) / 100).toFixed(0)} ${String(invoice.currency ?? 'usd').toUpperCase()}${invoice.nextPaymentAttemptAt ? ` with next attempt ${invoice.nextPaymentAttemptAt}` : ''}.`,
    category: 'payment',
    createdAt: invoice.createdAt,
    id: `lcn_invoice_${invoice.id}`,
    ownerUserId: lifecycleOwnerForTenant(state, invoice.tenantId),
    provider: invoice.provider,
    resolvedAt: invoice.status === 'paid' ? invoice.paidAt ?? invoice.createdAt : null,
    severity: pastDue ? 'critical' : open ? 'watch' : 'info',
    sourceIds: { invoiceId: invoice.id, subscriptionId: invoice.subscriptionId, tenantId: invoice.tenantId },
    status: open ? 'open' : 'resolved',
    tenantId: invoice.tenantId,
    title: pastDue ? 'Failed payment needs recovery' : invoice.status === 'paid' ? 'Payment recovered' : 'Invoice recovery path',
    trigger: pastDue ? 'payment_failed' : invoice.status === 'paid' ? 'payment_recovered' : 'invoice_open',
    updatedAt: invoice.paidAt ?? invoice.nextPaymentAttemptAt ?? invoice.dueAt,
  });
}

function lifecycleNoticeForBillingSession(state, session) {
  const subscription = (state.subscriptions ?? []).find((candidate) => candidate.id === session.subscriptionId || candidate.tenantId === session.tenantId);
  const isExpired = Number.isFinite(Date.parse(session.expiresAt ?? '')) && Date.parse(session.expiresAt) <= Date.now();
  const isRecovery = session.type === 'payment_recovery';
  const isCheckout = session.type === 'checkout';
  const trigger = isRecovery ? 'payment_recovery_ready' : isCheckout && ['past_due', 'canceled'].includes(subscription?.status) ? 'resubscription_ready' : `${session.type}_ready`;
  return lifecycleNotice({
    actionLabel: isRecovery ? 'Send recovery link' : isCheckout ? 'Use checkout link' : 'Open billing portal',
    actionTarget: isRecovery ? `payments recover ${session.invoiceId}` : isCheckout ? `payments checkout ${session.tenantId} ${session.planId ?? subscription?.planId ?? 'plan_team'}` : `payments portal ${session.tenantId}`,
    body: `${lifecycleText(session.type)} session is ${isExpired ? 'expired' : 'ready'} via ${session.providerMode ?? 'local'} ${session.provider}.`,
    category: 'payment',
    createdAt: session.createdAt,
    id: `lcn_billing_session_${session.id}`,
    ownerUserId: lifecycleOwnerForTenant(state, session.tenantId),
    provider: session.provider,
    resolvedAt: isExpired ? session.expiresAt : null,
    severity: isRecovery ? 'watch' : 'info',
    sourceIds: { billingSessionId: session.id, invoiceId: session.invoiceId, subscriptionId: session.subscriptionId, tenantId: session.tenantId },
    status: isExpired ? 'resolved' : 'monitoring',
    tenantId: session.tenantId,
    title: isRecovery ? 'Payment recovery session ready' : isCheckout ? 'Checkout/resubscription handoff ready' : 'Billing portal session ready',
    trigger,
    updatedAt: session.expiresAt,
  });
}

function lifecycleNoticeForMailbox(state, mailbox) {
  const owner = mailbox.ownerUserId ?? lifecycleOwnerForTenant(state, mailbox.tenantId);
  const actionTarget = mailbox.status === 'paused'
    ? `mailboxes resume ${mailbox.id}`
    : mailbox.status === 'connected'
    ? `mailboxes sync ${mailbox.id}`
    : `mailboxes connect-url ${mailbox.tenantId} ${mailbox.provider} ${mailbox.ownerUserId} ${mailbox.id}`;
  const severity = ['needs_reauth', 'disconnected'].includes(mailbox.status) ? 'critical' : mailbox.status === 'paused' ? 'watch' : 'info';
  return lifecycleNotice({
    actionLabel: mailbox.status === 'paused' ? 'Resume source' : mailbox.status === 'connected' ? 'Sync source' : 'Create auth link',
    actionTarget,
    body: `${lifecycleText(mailbox.provider)} source for ${ownerNameForState(state, owner)} is ${lifecycleText(mailbox.status)} with ${mailbox.syncPolicy?.lookbackDays ?? 0} day lookback and raw retention ${mailbox.syncPolicy?.rawRetentionDays ?? 0} days.`,
    category: 'source',
    createdAt: mailbox.credentialStoredAt ?? state.meta?.bootstrappedAt ?? state.meta?.updatedAt ?? nowIso(),
    id: `lcn_mailbox_${mailbox.id}`,
    ownerUserId: owner,
    provider: mailbox.provider,
    severity,
    sourceIds: { mailboxId: mailbox.id, tenantId: mailbox.tenantId },
    status: ['needs_reauth', 'disconnected'].includes(mailbox.status) ? 'open' : 'monitoring',
    tenantId: mailbox.tenantId,
    title: mailbox.status === 'connected' ? 'Mailbox source connected' : `Mailbox source ${lifecycleText(mailbox.status)}`,
    trigger: `mailbox_${mailbox.status}`,
    updatedAt: mailbox.credentialExpiresAt ?? null,
  });
}

function ownerNameForState(state, userId) {
  return (state.users ?? []).find((user) => user.id === userId)?.name ?? 'Unassigned';
}

function lifecycleNoticeForCursor(state, cursor) {
  const mailbox = (state.mailboxes ?? []).find((candidate) => candidate.id === cursor.mailboxId);
  const hasBackoff = Boolean(cursor.providerBackoffUntil || cursor.providerLastErrorAt || cursor.providerResponseStatus);
  if (!hasBackoff) {
    return null;
  }
  return lifecycleNotice({
    actionLabel: 'Replay source cursor',
    actionTarget: `mailboxes replay ${cursor.mailboxId}`,
    body: `${lifecycleText(cursor.provider)} cursor is ${lifecycleText(cursor.status)}${cursor.providerBackoffUntil ? ` until ${cursor.providerBackoffUntil}` : ''}${cursor.providerResponseStatus ? ` after provider status ${cursor.providerResponseStatus}` : ''}.`,
    category: 'provider',
    createdAt: cursor.providerLastErrorAt ?? cursor.lastSyncedAt ?? state.meta?.updatedAt ?? nowIso(),
    id: `lcn_cursor_${cursor.id}`,
    ownerUserId: mailbox?.ownerUserId ?? lifecycleOwnerForTenant(state, mailbox?.tenantId ?? defaultTenantId(state)),
    provider: cursor.provider,
    severity: cursor.providerResponseStatus === 429 ? 'watch' : 'critical',
    sourceIds: { cursorId: cursor.id, mailboxId: cursor.mailboxId, tenantId: mailbox?.tenantId },
    status: 'open',
    tenantId: mailbox?.tenantId ?? defaultTenantId(state),
    title: 'Provider sync backoff',
    trigger: 'provider_sync_backoff',
    updatedAt: cursor.providerBackoffUntil ?? cursor.providerLastErrorAt ?? null,
  });
}

function lifecycleNoticeForWatch(state, watch) {
  const mailbox = (state.mailboxes ?? []).find((candidate) => candidate.id === watch.mailboxId);
  const open = ['expired', 'failed'].includes(watch.status) || Boolean(watch.providerRetryAfterAt || watch.providerLastErrorAt);
  if (!open) {
    return null;
  }
  return lifecycleNotice({
    actionLabel: 'Renew provider watch',
    actionTarget: `mailboxes renew-watch ${watch.id}`,
    body: `${lifecycleText(watch.provider)} watch is ${lifecycleText(watch.status)}${watch.providerRetryAfterAt ? ` with retry after ${watch.providerRetryAfterAt}` : ''}.`,
    category: 'provider',
    createdAt: watch.providerLastErrorAt ?? watch.updatedAt ?? watch.createdAt,
    id: `lcn_watch_${watch.id}`,
    ownerUserId: mailbox?.ownerUserId ?? lifecycleOwnerForTenant(state, watch.tenantId),
    provider: watch.provider,
    severity: watch.status === 'failed' ? 'critical' : 'watch',
    sourceIds: { mailboxId: watch.mailboxId, tenantId: watch.tenantId, watchId: watch.id },
    status: 'open',
    tenantId: watch.tenantId,
    title: 'Provider watch needs attention',
    trigger: 'provider_watch_attention',
    updatedAt: watch.providerRetryAfterAt ?? watch.expirationAt ?? null,
  });
}

function lifecycleNoticeForDelivery(state, message) {
  if (!['failed', 'bounced'].includes(message.status)) {
    return null;
  }
  return lifecycleNotice({
    actionLabel: 'Review delivery webhook',
    actionTarget: `notifications delivery-status ${message.id} sent`,
    body: `${message.subject} to ${message.toEmail} is ${lifecycleText(message.status)}${message.statusReason ? `: ${message.statusReason}` : ''}.`,
    category: 'notification',
    createdAt: message.providerStatusUpdatedAt ?? message.createdAt,
    id: `lcn_delivery_${message.id}`,
    ownerUserId: message.userId,
    provider: message.provider,
    severity: 'watch',
    sourceIds: { emailDeliveryMessageId: message.id, tenantId: message.tenantId },
    status: 'open',
    tenantId: message.tenantId,
    title: 'Email notification delivery failed',
    trigger: 'email_delivery_failed',
    updatedAt: message.providerStatusUpdatedAt ?? message.createdAt,
  });
}

function deriveLifecycleNotices(state) {
  const notices = [];
  for (const tenant of state.tenants ?? []) {
    if (tenant.status === 'suspended') {
      notices.push(lifecycleNotice({
        actionLabel: 'Reactivate tenant',
        actionTarget: `tenants status ${tenant.id} active`,
        body: tenant.suspensionReason ?? 'Tenant product access is suspended until an admin reactivates it.',
        category: 'access',
        createdAt: tenant.suspendedAt ?? tenant.statusUpdatedAt ?? state.meta?.updatedAt ?? nowIso(),
        id: `lcn_tenant_suspended_${tenant.id}`,
        ownerUserId: tenant.ownerUserId ?? lifecycleOwnerForTenant(state, tenant.id),
        severity: 'critical',
        sourceIds: { tenantId: tenant.id },
        status: 'open',
        tenantId: tenant.id,
        title: 'Tenant access suspended',
        trigger: 'tenant_suspended',
        updatedAt: tenant.statusUpdatedAt ?? null,
      }));
    }
    if (tenant.registrationStatus === 'pending_onboarding') {
      notices.push(lifecycleNotice({
        actionLabel: 'Complete onboarding',
        actionTarget: `tenants status ${tenant.id} active`,
        body: `${tenant.name} is registered and still completing first mailbox, invite, digest, or billing setup.`,
        category: 'onboarding',
        createdAt: tenant.createdAt ?? state.meta?.updatedAt ?? nowIso(),
        id: `lcn_onboarding_${tenant.id}`,
        ownerUserId: tenant.ownerUserId ?? lifecycleOwnerForTenant(state, tenant.id),
        severity: 'info',
        sourceIds: { tenantId: tenant.id },
        status: 'monitoring',
        tenantId: tenant.id,
        title: 'Workspace onboarding in progress',
        trigger: 'workspace_onboarding',
        updatedAt: tenant.statusUpdatedAt ?? null,
      }));
    }
  }

  (state.subscriptions ?? []).forEach((subscription) => notices.push(lifecycleNoticeForSubscription(state, subscription)));
  (state.invoices ?? [])
    .filter((invoice) => ['past_due', 'open', 'paid'].includes(invoice.status))
    .forEach((invoice) => notices.push(lifecycleNoticeForInvoice(state, invoice)));
  for (const tenant of state.tenants ?? []) {
    ['checkout', 'portal', 'payment_recovery'].forEach((type) => {
      const session = latestBillingSession(state, tenant.id, type);
      if (session) {
        notices.push(lifecycleNoticeForBillingSession(state, session));
      }
    });
  }
  (state.mailboxes ?? []).forEach((mailbox) => notices.push(lifecycleNoticeForMailbox(state, mailbox)));
  (state.emailSyncCursors ?? []).map((cursor) => lifecycleNoticeForCursor(state, cursor)).filter(Boolean).forEach((notice) => notices.push(notice));
  (state.emailWatchSubscriptions ?? []).map((watch) => lifecycleNoticeForWatch(state, watch)).filter(Boolean).forEach((notice) => notices.push(notice));
  (state.emailDeliveryMessages ?? []).map((message) => lifecycleNoticeForDelivery(state, message)).filter(Boolean).forEach((notice) => notices.push(notice));

  const statusRank = { open: 3, monitoring: 2, resolved: 1 };
  const severityRank = { critical: 3, watch: 2, info: 1 };
  const uniqueNotices = [...new Map(notices.map((notice) => [notice.id, notice])).values()];
  return uniqueNotices.sort((left, right) =>
    (statusRank[right.status] - statusRank[left.status]) ||
    (severityRank[right.severity] - severityRank[left.severity]) ||
    String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')));
}

function entitlementStatusForSubscription(subscription) {
  return ['trialing', 'active'].includes(subscription.status) ? 'active' : 'restricted';
}

function refreshBillingOverrideStatuses(state) {
  const now = Date.now();
  (state.billingOverrides ?? []).forEach((override) => {
    override.status = ['active', 'revoked', 'expired'].includes(override.status) ? override.status : 'active';
    if (override.status === 'active' && override.expiresAt && Date.parse(override.expiresAt) <= now) {
      override.status = 'expired';
      override.expiredAt = override.expiredAt ?? nowIso();
      override.updatedAt = override.updatedAt ?? override.expiredAt;
    }
  });
}

function activeEntitlementOverrideForTenant(state, tenantId) {
  refreshBillingOverrideStatuses(state);
  return [...(state.billingOverrides ?? [])]
    .filter((override) =>
      override.tenantId === tenantId &&
      override.status === 'active' &&
      ['beta_access', 'manual_entitlement'].includes(override.type) &&
      override.planId)
    .sort((left, right) => Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? ''))[0] ?? null;
}

function effectiveEntitlementSubscription(state, changedSubscription) {
  if (['trialing', 'active'].includes(changedSubscription.status)) {
    return changedSubscription;
  }
  return (state.subscriptions ?? []).find((subscription) =>
    subscription.tenantId === changedSubscription.tenantId &&
    ['trialing', 'active'].includes(subscription.status)) ?? changedSubscription;
}

function upsertEntitlementFromSubscription(state, subscription) {
  const entitlementSubscription = effectiveEntitlementSubscription(state, subscription);
  const entitlementOverride = activeEntitlementOverrideForTenant(state, entitlementSubscription.tenantId);
  const plan = state.plans?.find((candidate) => candidate.id === (entitlementOverride?.planId ?? entitlementSubscription.planId));
  if (!plan) {
    return null;
  }

  state.entitlements = state.entitlements ?? [];
  let entitlement = state.entitlements.find((candidate) => candidate.tenantId === entitlementSubscription.tenantId);
  if (!entitlement) {
    entitlement = {
      id: `ent_${entitlementSubscription.tenantId}`,
      tenantId: entitlementSubscription.tenantId,
      subscriptionId: entitlementSubscription.id,
      source: 'subscription',
      status: entitlementStatusForSubscription(entitlementSubscription),
    };
    state.entitlements.push(entitlement);
  }

  Object.assign(entitlement, {
    adminControls: entitlementSubscription.status !== 'canceled',
    mailboxLimit: plan.mailboxLimit,
    retentionDays: plan.id === 'plan_beta' ? 7 : 14,
    seatLimit: plan.seatLimit,
    signalLimit: plan.signalLimit,
    source: entitlementOverride ? 'override' : 'subscription',
    status: entitlementOverride ? 'active' : entitlementStatusForSubscription(entitlementSubscription),
    subscriptionId: entitlementSubscription.id,
    updatedAt: nowIso(),
  });
  if (entitlementOverride) {
    entitlement.overrideId = entitlementOverride.id;
    entitlement.overrideType = entitlementOverride.type;
  } else {
    entitlement.overrideId = null;
    entitlement.overrideType = null;
  }

  return entitlement;
}

function ensureDefaultBillingSessions(state) {
  if ((state.billingSessions ?? []).length > 0) {
    return;
  }
  const subscription = state.subscriptions?.[0];
  if (!subscription) {
    return;
  }
  state.billingSessions = [
    {
      id: `bs_checkout_${subscription.tenantId}`,
      tenantId: subscription.tenantId,
      provider: subscription.provider,
      type: 'checkout',
      status: 'ready',
      planId: subscription.planId,
      url: `signal://billing/checkout/${subscription.tenantId}/${subscription.planId}`,
      createdAt: state.meta?.bootstrappedAt ?? nowIso(),
      expiresAt: expiresInIso(60 * 60 * 1000),
    },
  ];
}

function cursorStatusForMailbox(mailbox) {
  return mailbox.status === 'connected' ? 'active' : 'blocked';
}

function sourceTargetsForMailbox(mailbox) {
  return [...(mailbox.syncPolicy?.labels ?? []), ...(mailbox.syncPolicy?.folders ?? [])];
}

function defaultSourceMessages(state) {
  const firstMailbox = state.mailboxes?.find((mailbox) => mailbox.status === 'connected') ?? state.mailboxes?.[0];
  if (!firstMailbox) {
    return [];
  }

  const tenantId = firstMailbox.tenantId;
  const mailboxId = firstMailbox.id;
  return [
    {
      id: 'msg_northstar_budget_001',
      tenantId,
      mailboxId,
      providerThreadId: 'local-thread-northstar-budget',
      account: 'Northstar Ops',
      from: 'kai@northstar.example',
      subject: 'Budget and security review timing',
      snippet: 'We have budget approved if the security review clears this month. Can you send a rollout timeline before the competitor workshop?',
      receivedAt: '2026-06-02T14:18:00.000Z',
      labels: ['Prospects', 'Customers'],
      processedFlowIds: [],
    },
    {
      id: 'msg_ventureworks_export_001',
      tenantId,
      mailboxId,
      providerThreadId: 'local-thread-ventureworks-export',
      account: 'VentureWorks',
      from: 'ops@ventureworks.example',
      subject: 'Feature request for board export workflow',
      snippet: 'The board packet workflow pain is still manual. We need a CSV export need and Salesforce integration ask before month end.',
      receivedAt: '2026-06-02T16:42:00.000Z',
      labels: ['Customers'],
      processedFlowIds: [],
    },
    {
      id: 'msg_acme_health_renewal_001',
      tenantId,
      mailboxId,
      providerThreadId: 'local-thread-acme-renewal',
      account: 'Acme Health',
      from: 'programs@acmehealth.example',
      subject: 'Renewal anxiety and executive gap',
      snippet: 'Our champion silence has the team worried. There is renewal anxiety because the executive gap remains open.',
      receivedAt: '2026-06-03T09:05:00.000Z',
      labels: ['Customers'],
      processedFlowIds: [],
    },
  ];
}

const accountDefaults = {
  'Acme Health': {
    id: 'acct_acme_health',
    domain: 'acmehealth.example',
    stage: 'Renewal risk',
    ownerUserId: 'usr_admin',
    healthScore: 41,
    healthTrend: 'down',
    lastTouchAt: '2026-06-03T09:05:00.000Z',
    nextReviewAt: '2026-06-04T14:30:00.000Z',
    summary: 'Renewal account with champion silence, anxiety, and an unresolved executive gap.',
    tags: ['renewal_risk', 'executive_gap', 'champion_silence'],
    stakeholders: [
      { id: 'stk_acme_programs', name: 'Sam Rivera', title: 'Programs Director', role: 'champion', sentiment: 'concerned', lastTouchAt: '2026-05-15T13:00:00.000Z' },
      { id: 'stk_acme_exec', name: 'Morgan Ellis', title: 'VP Operations', role: 'executive', sentiment: 'unknown', lastTouchAt: null },
    ],
  },
  'Northstar Ops': {
    id: 'acct_northstar_ops',
    domain: 'northstar.example',
    stage: 'Expansion evaluation',
    ownerUserId: 'usr_sales',
    healthScore: 82,
    healthTrend: 'up',
    lastTouchAt: '2026-06-02T14:18:00.000Z',
    nextReviewAt: '2026-06-05T15:00:00.000Z',
    summary: 'Expansion opportunity with approved budget, security review timing, and competitor pressure.',
    tags: ['expansion', 'security_review', 'competitor'],
    stakeholders: [
      { id: 'stk_northstar_finance', name: 'Kai Morgan', title: 'Finance Lead', role: 'economic_buyer', sentiment: 'positive', lastTouchAt: '2026-06-02T14:18:00.000Z' },
      { id: 'stk_northstar_it', name: 'Jordan Lee', title: 'IT Security', role: 'security_reviewer', sentiment: 'neutral', lastTouchAt: '2026-06-01T18:30:00.000Z' },
    ],
  },
  VentureWorks: {
    id: 'acct_ventureworks',
    domain: 'ventureworks.example',
    stage: 'Product discovery',
    ownerUserId: 'usr_product',
    healthScore: 68,
    healthTrend: 'flat',
    lastTouchAt: '2026-06-02T16:42:00.000Z',
    nextReviewAt: '2026-06-06T16:00:00.000Z',
    summary: 'Product-led account asking for export and CRM integration improvements around board reporting.',
    tags: ['product_idea', 'workflow_pain', 'integration'],
    stakeholders: [
      { id: 'stk_ventureworks_ops', name: 'Riley Park', title: 'Operations Lead', role: 'power_user', sentiment: 'mixed', lastTouchAt: '2026-06-02T16:42:00.000Z' },
    ],
  },
};

function defaultTenantId(state) {
  return state.tenants?.[0]?.id ?? 'tenant_demo';
}

function membershipIdFor(tenantId, userId) {
  return `mem_${tenantId}_${userId}`.replace(/[^a-z0-9_]+/gi, '_');
}

function membershipForUser(state, userId, tenantId = null) {
  return (state.memberships ?? []).find((membership) =>
    membership.userId === userId &&
    (!tenantId || membership.tenantId === tenantId));
}

function activeMembershipForUser(state, userId, tenantId = null) {
  return (state.memberships ?? []).find((membership) =>
    membership.userId === userId &&
    membership.status === 'active' &&
    (!tenantId || membership.tenantId === tenantId));
}

function membershipFromUser(state, user, createdByUserId = null) {
  return {
    id: membershipIdFor(user.tenantId, user.id),
    tenantId: user.tenantId,
    userId: user.id,
    role: ['admin', 'member'].includes(user.role) ? user.role : 'member',
    ...(user.team ? { team: user.team } : {}),
    status: user.status === 'active' ? 'active' : 'disabled',
    createdAt: state.meta?.bootstrappedAt ?? state.meta?.updatedAt ?? nowIso(),
    createdByUserId,
  };
}

function defaultMemberships(state) {
  return (state.users ?? []).map((user) => membershipFromUser(state, user, state.users?.find((candidate) => candidate.tenantId === user.tenantId && candidate.role === 'admin')?.id ?? user.id));
}

function ensureDefaultMemberships(state) {
  state.memberships = state.memberships ?? [];
  for (const user of state.users ?? []) {
    let membership = membershipForUser(state, user.id, user.tenantId);
    if (!membership) {
      membership = membershipFromUser(state, user, state.users?.find((candidate) => candidate.tenantId === user.tenantId && candidate.role === 'admin')?.id ?? user.id);
      state.memberships.push(membership);
    }
    membership.id = membership.id ?? membershipIdFor(membership.tenantId, membership.userId);
    membership.role = ['admin', 'member'].includes(membership.role) ? membership.role : (['admin', 'member'].includes(user.role) ? user.role : 'member');
    membership.status = ['active', 'disabled'].includes(membership.status) ? membership.status : (user.status === 'active' ? 'active' : 'disabled');
    membership.createdAt = membership.createdAt ?? state.meta?.bootstrappedAt ?? state.meta?.updatedAt ?? nowIso();
    membership.createdByUserId = membership.createdByUserId ?? state.users?.find((candidate) => candidate.tenantId === membership.tenantId && candidate.role === 'admin')?.id ?? null;
    user.role = membership.role;
    if (membership.team) {
      user.team = membership.team;
    }
    user.status = membership.status === 'active' ? 'active' : 'disabled';
  }
}

function activeSeatCount(state, tenantId = defaultTenantId(state)) {
  const memberships = (state.memberships ?? []).filter((membership) => membership.tenantId === tenantId);
  if (memberships.length) {
    return memberships.filter((membership) =>
      membership.status === 'active' &&
      (state.users ?? []).some((user) => user.id === membership.userId && user.status === 'active')).length;
  }
  return (state.users ?? []).filter((user) => user.tenantId === tenantId && user.status === 'active').length;
}

function pendingInviteSeatCount(state, tenantId = defaultTenantId(state)) {
  return (state.invites ?? []).filter((invite) => invite.tenantId === tenantId && invite.status === 'pending').length;
}

function seatLimitForTenant(state, tenantId = defaultTenantId(state)) {
  const entitlement = (state.entitlements ?? []).find((candidate) => candidate.tenantId === tenantId);
  if (typeof entitlement?.seatLimit === 'number') {
    return entitlement.seatLimit;
  }
  const tenant = (state.tenants ?? []).find((candidate) => candidate.id === tenantId);
  const plan = (state.plans ?? []).find((candidate) => candidate.id === tenant?.planId);
  return typeof plan?.seatLimit === 'number' ? plan.seatLimit : null;
}

function seatsAvailableForTenant(state, tenantId = defaultTenantId(state)) {
  const limit = seatLimitForTenant(state, tenantId);
  if (limit === null) {
    return null;
  }
  return Math.max(0, limit - activeSeatCount(state, tenantId) - pendingInviteSeatCount(state, tenantId));
}

function defaultInvites(state) {
  const tenantId = defaultTenantId(state);
  const admin = state.users?.find((user) => user.tenantId === tenantId && user.role === 'admin') ?? state.users?.[0];
  const timestamp = state.meta?.bootstrappedAt ?? state.meta?.updatedAt ?? '2026-06-03T00:00:00.000Z';
  return [
    {
      id: 'inv_rowan_success',
      tenantId,
      email: 'rowan@acme.example',
      role: 'member',
      team: 'success',
      status: 'pending',
      claimCode: 'local-rowan-success',
      invitedByUserId: admin?.id ?? 'usr_admin',
      createdAt: timestamp,
      expiresAt: '2026-06-10T00:00:00.000Z',
    },
    {
      id: 'inv_priya_product',
      tenantId,
      email: 'priya@acme.example',
      role: 'member',
      team: 'product',
      status: 'accepted',
      claimCode: 'local-priya-product',
      invitedByUserId: admin?.id ?? 'usr_admin',
      createdAt: '2026-05-30T15:30:00.000Z',
      expiresAt: '2026-06-06T15:30:00.000Z',
      acceptedAt: '2026-05-30T16:04:00.000Z',
      acceptedUserId: 'usr_product',
    },
  ];
}

function defaultSignalQualitySettings(state) {
  const timestamp = state.meta?.bootstrappedAt ?? state.meta?.updatedAt ?? nowIso();
  return (state.tenants ?? [{ id: defaultTenantId(state) }]).map((tenant) => ({
    id: `qlt_${tenant.id}`,
    tenantId: tenant.id,
    minimumConfidence: 0.72,
    requireSourceReference: true,
    autoRouteThreshold: 0.88,
    updatedAt: timestamp,
    updatedByUserId: state.users?.find((user) => user.tenantId === tenant.id && user.role === 'admin')?.id ?? state.users?.[0]?.id ?? 'usr_admin',
  }));
}

function ensureDefaultSignalQualitySettings(state) {
  state.signalQualitySettings = state.signalQualitySettings ?? [];
  const knownTenantIds = new Set(state.signalQualitySettings.map((settings) => settings.tenantId));
  defaultSignalQualitySettings(state).forEach((settings) => {
    if (!knownTenantIds.has(settings.tenantId)) {
      state.signalQualitySettings.push(settings);
    }
  });
  state.signalQualitySettings.forEach((settings) => {
    settings.minimumConfidence = Number.isFinite(Number(settings.minimumConfidence)) ? Number(settings.minimumConfidence) : 0.72;
    settings.autoRouteThreshold = Number.isFinite(Number(settings.autoRouteThreshold)) ? Number(settings.autoRouteThreshold) : 0.88;
    settings.requireSourceReference = settings.requireSourceReference !== false;
    settings.updatedAt = settings.updatedAt ?? nowIso();
    settings.updatedByUserId = settings.updatedByUserId ?? state.users?.find((user) => user.tenantId === settings.tenantId && user.role === 'admin')?.id ?? state.users?.[0]?.id ?? 'usr_admin';
  });
}

function defaultSuppressionRules(state) {
  const tenantId = defaultTenantId(state);
  const admin = state.users?.find((user) => user.tenantId === tenantId && user.role === 'admin') ?? state.users?.[0];
  const timestamp = state.meta?.bootstrappedAt ?? state.meta?.updatedAt ?? nowIso();
  return [
    {
      id: 'sup_internal_domains',
      tenantId,
      type: 'domain',
      value: 'internal.example',
      status: 'active',
      reason: 'Suppress internal operational threads from signal generation.',
      createdByUserId: admin?.id ?? 'usr_admin',
      createdAt: timestamp,
    },
  ];
}

const modelLearningModes = ['disabled', 'opt_in_tuning'];
const modelTrainingDataUseModes = ['excluded_by_default', 'opt_in_only'];

function defaultModelGovernancePolicies(state) {
  const timestamp = state.meta?.bootstrappedAt ?? state.meta?.updatedAt ?? nowIso();
  return (state.tenants ?? [{ id: defaultTenantId(state) }]).map((tenant) => {
    const admin = state.users?.find((user) => user.tenantId === tenant.id && user.role === 'admin') ?? state.users?.[0];
    return {
      id: `mdl_${tenant.id}`,
      tenantId: tenant.id,
      status: 'active',
      detectorBoundary: 'shared_detector',
      dataBoundary: 'tenant_isolated',
      learningMode: 'disabled',
      trainingDataUse: 'excluded_by_default',
      perTenantModel: false,
      tuningControls: ['quality_threshold', 'routing_rules', 'suppression_rules', 'feedback_labels', 'retention_policy'],
      decision: 'Shared detector/model boundary with tenant-specific controls; no separately trained org model by default.',
      updatedAt: timestamp,
      updatedByUserId: admin?.id ?? 'usr_admin',
    };
  });
}

function ensureDefaultModelGovernancePolicies(state) {
  state.modelGovernancePolicies = state.modelGovernancePolicies ?? [];
  const knownTenantIds = new Set(state.modelGovernancePolicies.map((policy) => policy.tenantId));
  defaultModelGovernancePolicies(state).forEach((policy) => {
    if (!knownTenantIds.has(policy.tenantId)) {
      state.modelGovernancePolicies.push(policy);
    }
  });
  state.modelGovernancePolicies.forEach((policy) => {
    const tenant = (state.tenants ?? []).find((candidate) => candidate.id === policy.tenantId);
    const admin = state.users?.find((user) => user.tenantId === policy.tenantId && user.role === 'admin') ?? state.users?.[0];
    policy.id = policy.id ?? `mdl_${policy.tenantId}`;
    policy.tenantId = policy.tenantId ?? tenant?.id ?? defaultTenantId(state);
    policy.status = policy.status === 'paused' ? 'paused' : 'active';
    policy.detectorBoundary = policy.detectorBoundary === 'shared_detector' ? 'shared_detector' : 'shared_detector';
    policy.dataBoundary = policy.dataBoundary === 'tenant_isolated' ? 'tenant_isolated' : 'tenant_isolated';
    policy.learningMode = modelLearningModes.includes(policy.learningMode) ? policy.learningMode : 'disabled';
    policy.trainingDataUse = policy.learningMode === 'disabled'
      ? 'excluded_by_default'
      : (modelTrainingDataUseModes.includes(policy.trainingDataUse) ? policy.trainingDataUse : 'opt_in_only');
    policy.perTenantModel = false;
    policy.tuningControls = Array.isArray(policy.tuningControls) && policy.tuningControls.length
      ? policy.tuningControls.map((control) => String(control))
      : ['quality_threshold', 'routing_rules', 'suppression_rules', 'feedback_labels', 'retention_policy'];
    policy.decision = policy.decision ?? 'Shared detector/model boundary with tenant-specific controls; no separately trained org model by default.';
    policy.updatedAt = policy.updatedAt ?? nowIso();
    policy.updatedByUserId = policy.updatedByUserId ?? admin?.id ?? 'usr_admin';
  });
}

function modelGovernanceEvidenceForTenant(state, tenantId = defaultTenantId(state)) {
  const qualitySettings = qualitySettingsForTenant(state, tenantId);
  const governancePolicy = (state.governancePolicies ?? []).find((policy) => policy.tenantId === tenantId);
  const tenantSourceMessages = (state.sourceMessages ?? []).filter((message) => message.tenantId === tenantId);
  const tenantFlows = (state.emailFlows ?? []).filter((flow) => flow.tenantId === tenantId);
  const tenantRoutingRules = (state.routingRules ?? []).filter((rule) => rule.tenantId === tenantId);
  const tenantSuppressionRules = (state.suppressionRules ?? []).filter((rule) => rule.tenantId === tenantId);
  const tenantSignals = (state.signals ?? []).filter((signal) => signal.tenantId === tenantId);
  const tenantFeedback = (state.signalFeedback ?? []).filter((feedback) => feedback.tenantId === tenantId);
  const evidence = {
    activeRoutingRules: tenantRoutingRules.filter((rule) => rule.status === 'active').length,
    activeSuppressionRules: tenantSuppressionRules.filter((rule) => rule.status === 'active').length,
    enabledDetectorFlows: tenantFlows.filter((flow) => flow.status === 'enabled').length,
    feedbackLabels: tenantFeedback.length,
    generatedSignals: tenantSignals.filter((signal) => signal.sourceMessageId && signal.flowId).length,
    governancePolicyId: governancePolicy?.id ?? null,
    qualitySettingsId: qualitySettings?.id ?? null,
    rawSnippetRetentionDays: governancePolicy?.rawSnippetRetentionDays ?? null,
    sourceMessages: tenantSourceMessages.length,
    sourceRetentionDays: governancePolicy?.sourceRetentionDays ?? null,
    totalDetectorFlows: tenantFlows.length,
  };
  return {
    ...evidence,
    evidenceDigest: sha256Digest(JSON.stringify(evidence)),
  };
}

export function modelGovernanceReports(state) {
  ensureDefaultModelGovernancePolicies(state);
  return (state.modelGovernancePolicies ?? []).map((policy) => ({
    policy,
    evidence: modelGovernanceEvidenceForTenant(state, policy.tenantId),
  }));
}

function digestionPipelineAuditRow({
  area,
  check,
  commands = [],
  evidence = [],
  localOk,
  productionOk,
  recommendation,
  requiredEnv = [],
}) {
  return {
    area,
    check,
    evidence,
    localOk: Boolean(localOk),
    productionOk: Boolean(productionOk),
    recommendation,
    requiredEnv,
    commands,
    status: localOk ? (productionOk ? 'production_ready' : 'local_ready') : 'attention',
  };
}

export function signalDigestionPipelineReport(state, {
  backend = null,
  statePath = resolveStatePath(),
} = {}) {
  ensureDefaultModelGovernancePolicies(state);
  ensureDefaultRoutingRules(state);
  ensureDefaultSignalQualitySettings(state);

  const summary = summarizeState(state, statePath);
  const tenantId = defaultTenantId(state);
  const tenant = (state.tenants ?? []).find((item) => item.id === tenantId) ?? state.tenants?.[0] ?? null;
  const tenantScoped = (items = []) => items.filter((item) => !tenant?.id || item.tenantId === tenant.id);
  const mailboxes = tenantScoped(state.mailboxes ?? []);
  const connectedMailboxes = mailboxes.filter((mailbox) => mailbox.status === 'connected');
  const mailboxIds = new Set(mailboxes.map((mailbox) => mailbox.id));
  const sourceMessages = tenantScoped(state.sourceMessages ?? []).filter((message) => !message.mailboxId || mailboxIds.has(message.mailboxId));
  const providerBackedSourceMessages = sourceMessages.filter((message) => message.providerRequestDigest || message.providerResponseDigest || message.providerMessageId || message.providerCursor);
  const processedSourceMessages = sourceMessages.filter((message) => (message.processedFlowIds ?? []).length > 0);
  const syncCursors = (state.emailSyncCursors ?? []).filter((cursor) => mailboxIds.has(cursor.mailboxId));
  const activeSyncCursors = syncCursors.filter((cursor) => cursor.status === 'active');
  const watches = tenantScoped(state.emailWatchSubscriptions ?? []);
  const activeWatches = watches.filter((watch) => watch.status === 'active');
  const flows = tenantScoped(state.emailFlows ?? []);
  const enabledFlows = flows.filter((flow) => flow.status === 'enabled');
  const routingRules = tenantScoped(state.routingRules ?? []);
  const activeRoutingRules = routingRules.filter((rule) => rule.status === 'active');
  const flowRuns = tenantScoped(state.flowRuns ?? []);
  const succeededFlowRuns = flowRuns.filter((run) => run.status === 'succeeded');
  const latestRun = [...succeededFlowRuns].sort((left, right) => Date.parse(right.completedAt ?? right.startedAt ?? '') - Date.parse(left.completedAt ?? left.startedAt ?? ''))[0] ?? null;
  const signals = tenantScoped(state.signals ?? []);
  const sourceBackedSignals = signals.filter((signal) => signal.sourceMessageId && signal.flowId);
  const routedSignals = sourceBackedSignals.filter((signal) =>
    signal.ownerUserId &&
    (signal.routeTo || signal.routingRuleId || activeRoutingRules.some((rule) => rule.flowId === signal.flowId)));
  const signalDetectionJobs = tenantScoped(state.jobs ?? []).filter((job) => job.queue === 'signal_detection');
  const failedSignalDetectionJobs = signalDetectionJobs.filter((job) => job.status === 'failed');
  const qualitySettings = qualitySettingsForTenant(state, tenant?.id ?? tenantId);
  const suppressionRules = tenantScoped(state.suppressionRules ?? []);
  const activeSuppressionRules = suppressionRules.filter((rule) => rule.status === 'active');
  const feedback = tenantScoped(state.signalFeedback ?? []);
  const modelPolicies = tenantScoped(state.modelGovernancePolicies ?? []);
  const activePolicy = modelPolicies.find((policy) => policy.status === 'active') ?? modelPolicies[0] ?? null;
  const governancePolicy = tenantScoped(state.governancePolicies ?? [])[0] ?? null;
  const redactionRules = tenantScoped(state.redactionRules ?? []);
  const openRecommendations = tenantScoped(state.accountRecommendations ?? []).filter((recommendation) => recommendation.status === 'open');
  const openActions = tenantScoped(state.accountActions ?? []).filter((action) => action.status === 'open');
  const backendProductionReady = Boolean(backend?.productionReady);
  const modelBoundaryOk = Boolean(activePolicy &&
    activePolicy.detectorBoundary === 'shared_detector' &&
    activePolicy.dataBoundary === 'tenant_isolated' &&
    activePolicy.perTenantModel === false &&
    (activePolicy.learningMode !== 'opt_in_tuning' || activePolicy.trainingDataUse === 'opt_in_only'));
  const rows = [
    digestionPipelineAuditRow({
      area: 'permissioned_source_ingestion',
      check: 'Permissioned Gmail/Outlook mailbox sources create sync cursors, provider watch state, and retained source-message records without storing raw credentials in app state.',
      evidence: [
        `${connectedMailboxes.length}/${mailboxes.length} connected mailbox source(s)`,
        `${activeSyncCursors.length}/${syncCursors.length} active sync cursor(s)`,
        `${activeWatches.length}/${watches.length} active provider watch subscription(s)`,
        `${sourceMessages.length} retained source message record(s)`,
      ],
      localOk: connectedMailboxes.length > 0 && activeSyncCursors.length === mailboxes.length && sourceMessages.length > 0,
      productionOk: backendProductionReady,
      recommendation: 'Keep ingestion provider-scoped and cursor-driven; store only sanitized provider digests and source snippets in app state.',
      requiredEnv: ['SIGNAL_GMAIL_CLIENT_ID', 'SIGNAL_OUTLOOK_CLIENT_ID', 'SIGNAL_TOKEN_ENCRYPTION_KEY', 'SIGNAL_STATE_SERVICE_URL'],
      commands: ['npm run admin -- mailboxes --json', 'npm run admin -- mailboxes sync <mailboxId> --live-provider'],
    }),
    digestionPipelineAuditRow({
      area: 'source_digest_retention',
      check: 'Source-message snippets are governed by retention, raw-snippet windows, redaction rules, and processed-flow provenance.',
      evidence: [
        `${processedSourceMessages.length}/${sourceMessages.length} source message(s) tagged with processed flow provenance`,
        `${providerBackedSourceMessages.length} provider-backed source digest(s)`,
        governancePolicy ? `${governancePolicy.sourceRetentionDays} source days / ${governancePolicy.rawSnippetRetentionDays} raw days` : 'missing governance policy',
        `${redactionRules.length} redaction rule(s)`,
      ],
      localOk: Boolean(governancePolicy) && sourceMessages.length > 0 && redactionRules.length > 0,
      productionOk: backendProductionReady,
      recommendation: 'Use the source-message layer as the digestion ledger; do not train or export from raw provider bodies by default.',
      requiredEnv: ['DATABASE_URL', 'SIGNAL_TENANT_ISOLATION_MODE'],
      commands: ['npm run admin -- governance --json', 'npm run admin -- dashboard-audit --json'],
    }),
    digestionPipelineAuditRow({
      area: 'detector_execution',
      check: 'Enabled detector flows scan source snippets, match configured terms, create replay-safe signals, and record flow-run/job evidence.',
      evidence: [
        `${enabledFlows.length}/${flows.length} enabled detector flow(s)`,
        `${succeededFlowRuns.length}/${flowRuns.length} succeeded flow run(s)`,
        `${sourceBackedSignals.length} source-backed generated signal(s)`,
        latestRun ? `latest run scanned ${latestRun.scannedMessages} and matched ${latestRun.matchedMessages}` : 'no flow run yet',
      ],
      localOk: enabledFlows.length > 0 && succeededFlowRuns.length > 0 && sourceBackedSignals.length > 0 && failedSignalDetectionJobs.length === 0,
      productionOk: backendProductionReady,
      recommendation: 'Treat detector runs as deterministic local jobs first; schedule production workers only after durable state and provider evidence pass.',
      requiredEnv: ['SIGNAL_JOB_SCHEDULER', 'SIGNAL_STATE_SERVICE_URL'],
      commands: ['npm run admin -- email-flows run', 'npm run admin -- jobs run signal_detection --limit 1'],
    }),
    digestionPipelineAuditRow({
      area: 'quality_suppression_feedback',
      check: 'Quality thresholds, source-reference requirements, suppression rules, and user feedback labels control which signals become recommendations or future tuning candidates.',
      evidence: [
        `minimum confidence ${qualitySettings.minimumConfidence}`,
        `${activeSuppressionRules.length}/${suppressionRules.length} active suppression rule(s)`,
        `${feedback.length} feedback label(s)`,
        `${failedSignalDetectionJobs.length} failed signal_detection job(s)`,
      ],
      localOk: Boolean(qualitySettings) && suppressionRules.length > 0 && feedback.length > 0 && failedSignalDetectionJobs.length === 0,
      productionOk: backendProductionReady,
      recommendation: 'Use feedback and suppression for tenant-specific tuning before considering any governed learning pipeline.',
      requiredEnv: ['SIGNAL_STATE_SERVICE_URL', 'DATABASE_URL'],
      commands: ['npm run admin -- quality --json', 'npm run admin -- signals feedback <signalId> useful'],
    }),
    digestionPipelineAuditRow({
      area: 'routing_and_user_outcomes',
      check: 'Signals route through tenant rules to owners/teams, account actions, notifications, handoffs, and relationship recommendations.',
      evidence: [
        `${activeRoutingRules.length}/${routingRules.length} active routing rule(s)`,
        `${routedSignals.length}/${sourceBackedSignals.length} routed source-backed signal(s)`,
        `${openActions.length} open account action(s)`,
        `${openRecommendations.length} open relationship recommendation(s)`,
      ],
      localOk: activeRoutingRules.length > 0 && sourceBackedSignals.length > 0 && routedSignals.length === sourceBackedSignals.length && openRecommendations.length > 0,
      productionOk: backendProductionReady,
      recommendation: 'Personalize outcomes through routing, ownership, priorities, and notification preferences instead of separate per-user models.',
      requiredEnv: ['SIGNAL_REQUIRE_SIGNED_SESSION', 'SIGNAL_AUTH_PROVIDER', 'SIGNAL_AUTH_JWKS_URL'],
      commands: ['npm run admin -- signals --json', 'npm run admin -- accounts --json', 'npm run admin -- notifications --json'],
    }),
    digestionPipelineAuditRow({
      area: 'model_learning_boundary',
      check: 'The MVP uses a shared detector/model boundary with tenant-isolated data and opt-in-only future tuning; per-org trained models stay disabled by default.',
      evidence: [
        activePolicy ? `${activePolicy.detectorBoundary} / ${activePolicy.dataBoundary}` : 'missing model policy',
        activePolicy ? `${activePolicy.learningMode} learning / ${activePolicy.trainingDataUse}` : 'missing learning policy',
        `${summary.perTenantModels ?? 0} per-tenant trained model(s) enabled`,
        `${activePolicy?.tuningControls?.length ?? 0} tenant tuning control(s)`,
      ],
      localOk: modelBoundaryOk,
      productionOk: backendProductionReady && modelBoundaryOk,
      recommendation: 'Do not create one model per org by default; require explicit admin opt-in, retention review, and tenant-isolated evaluation evidence first.',
      requiredEnv: ['SIGNAL_TENANT_ISOLATION_MODE', 'DATABASE_URL', 'SIGNAL_STATE_SERVICE_URL'],
      commands: ['npm run admin -- models --json', 'npm run admin -- models policy tenant_demo opt_in_tuning Governance_reviewed'],
    }),
  ];
  return {
    generatedAt: new Date().toISOString(),
    ok: rows.every((row) => row.localOk),
    productionReady: rows.every((row) => row.productionOk),
    tenant: tenant
      ? {
          id: tenant.id,
          name: tenant.name,
          domain: tenant.domain,
          status: tenant.status,
        }
      : null,
    backend: {
      mode: backend?.mode ?? (isHttpResource(statePath) ? 'external-service' : 'local-json'),
      productionReady: backendProductionReady,
      statePath,
    },
    recommendation: {
      decision: 'shared_detector_with_tenant_controls',
      summary: 'Use a tenant-isolated data digestion pipeline with shared detectors, tenant-specific thresholds/routing/suppression/feedback, and opt-in-only future learning.',
      productionGuardrail: 'Do not enable production learning or multi-customer shared storage until durable tenant isolation, managed auth, scheduler, provider evidence, and retention controls are all verified.',
      localAgentCommand: 'npm run admin -- digestion-pipeline --json',
    },
    issues: rows.filter((row) => !row.localOk).map((row) => `${row.area}: ${row.check}`),
    rows,
    summary: {
      activeRoutingRules: activeRoutingRules.length,
      connectedMailboxes: connectedMailboxes.length,
      enabledDetectorFlows: enabledFlows.length,
      feedbackLabels: feedback.length,
      flowRuns: flowRuns.length,
      generatedSignals: sourceBackedSignals.length,
      localReady: rows.filter((row) => row.localOk).length,
      perTenantModels: summary.perTenantModels ?? 0,
      processedSourceMessages: processedSourceMessages.length,
      productionReady: rows.filter((row) => row.productionOk).length,
      signalDetectionJobs: signalDetectionJobs.length,
      sourceMessages: sourceMessages.length,
      total: rows.length,
    },
  };
}

function qualitySettingsForTenant(state, tenantId = defaultTenantId(state)) {
  ensureDefaultSignalQualitySettings(state);
  return state.signalQualitySettings.find((settings) => settings.tenantId === tenantId) ?? defaultSignalQualitySettings({ ...state, tenants: [{ id: tenantId }] })[0];
}

function senderDomain(message) {
  return String(message.from ?? '').split('@')[1]?.toLowerCase() ?? '';
}

function suppressionRuleMatches(rule, message) {
  const value = String(rule.value ?? '').toLowerCase();
  if (!value || rule.status !== 'active') {
    return false;
  }
  if (rule.type === 'domain') {
    return senderDomain(message) === value;
  }
  if (rule.type === 'sender') {
    return String(message.from ?? '').toLowerCase() === value;
  }
  if (rule.type === 'account') {
    return String(message.account ?? '').toLowerCase() === value;
  }
  if (rule.type === 'term') {
    return sourceMessageText(message).includes(value);
  }
  return false;
}

function suppressionRuleForMessage(state, message) {
  return (state.suppressionRules ?? []).find((rule) => rule.tenantId === message.tenantId && suppressionRuleMatches(rule, message)) ?? null;
}

function signalQualityBlocker(state, signal) {
  const settings = qualitySettingsForTenant(state, signal.tenantId);
  if (settings.requireSourceReference && (!signal.sourceMessageId || !signal.sourceSnippet)) {
    return {
      type: 'missing_source_reference',
      message: 'Signal requires retained source reference.',
    };
  }
  if (signal.confidence < settings.minimumConfidence) {
    return {
      type: 'confidence_threshold',
      message: `Confidence ${signal.confidence} is below ${settings.minimumConfidence}.`,
      minimumConfidence: settings.minimumConfidence,
    };
  }
  return null;
}

function defaultGovernancePolicies(state) {
  const timestamp = state.meta?.bootstrappedAt ?? state.meta?.updatedAt ?? nowIso();
  return (state.tenants ?? [{ id: defaultTenantId(state) }]).map((tenant) => {
    const entitlement = (state.entitlements ?? []).find((item) => item.tenantId === tenant.id);
    const admin = state.users?.find((user) => user.tenantId === tenant.id && user.role === 'admin') ?? state.users?.[0];
    const sourceRetentionDays = entitlement?.retentionDays ?? 14;
    return {
      id: `gov_${tenant.id}`,
      tenantId: tenant.id,
      sourceRetentionDays,
      rawSnippetRetentionDays: Math.min(7, sourceRetentionDays),
      exportWindowDays: 30,
      deletionReview: 'manual',
      redactionMode: 'standard',
      updatedAt: timestamp,
      updatedByUserId: admin?.id ?? 'usr_admin',
    };
  });
}

function ensureDefaultGovernancePolicies(state) {
  state.governancePolicies = state.governancePolicies ?? [];
  const knownTenantIds = new Set(state.governancePolicies.map((policy) => policy.tenantId));
  defaultGovernancePolicies(state).forEach((policy) => {
    if (!knownTenantIds.has(policy.tenantId)) {
      state.governancePolicies.push(policy);
    }
  });
  state.governancePolicies.forEach((policy) => {
    policy.sourceRetentionDays = Number.isFinite(Number(policy.sourceRetentionDays)) ? Number(policy.sourceRetentionDays) : 14;
    policy.rawSnippetRetentionDays = Number.isFinite(Number(policy.rawSnippetRetentionDays)) ? Number(policy.rawSnippetRetentionDays) : Math.min(7, policy.sourceRetentionDays);
    policy.rawSnippetRetentionDays = Math.min(policy.rawSnippetRetentionDays, policy.sourceRetentionDays);
    policy.exportWindowDays = Number.isFinite(Number(policy.exportWindowDays)) ? Number(policy.exportWindowDays) : 30;
    policy.deletionReview = ['manual', 'automatic'].includes(policy.deletionReview) ? policy.deletionReview : 'manual';
    policy.redactionMode = ['standard', 'strict'].includes(policy.redactionMode) ? policy.redactionMode : 'standard';
    policy.updatedAt = policy.updatedAt ?? nowIso();
    policy.updatedByUserId = policy.updatedByUserId ?? state.users?.find((user) => user.tenantId === policy.tenantId && user.role === 'admin')?.id ?? state.users?.[0]?.id ?? 'usr_admin';
  });
}

function governancePolicyForTenant(state, tenantId = defaultTenantId(state)) {
  ensureDefaultGovernancePolicies(state);
  return state.governancePolicies.find((policy) => policy.tenantId === tenantId) ?? defaultGovernancePolicies({ ...state, tenants: [{ id: tenantId }] })[0];
}

function defaultRedactionRules(state) {
  const tenantId = defaultTenantId(state);
  const admin = state.users?.find((user) => user.tenantId === tenantId && user.role === 'admin') ?? state.users?.[0];
  const timestamp = state.meta?.bootstrappedAt ?? state.meta?.updatedAt ?? nowIso();
  return [
    {
      id: 'redact_payment_terms',
      tenantId,
      label: 'Payment card references',
      scope: 'source_snippets',
      pattern: 'card|cc|bank account|routing number',
      replacement: '[payment detail]',
      status: 'active',
      createdByUserId: admin?.id ?? 'usr_admin',
      createdAt: timestamp,
    },
    {
      id: 'redact_private_health',
      tenantId,
      label: 'Private health context',
      scope: 'exports',
      pattern: 'patient|diagnosis|medical record',
      replacement: '[private context]',
      status: 'active',
      createdByUserId: admin?.id ?? 'usr_admin',
      createdAt: timestamp,
    },
  ];
}

function defaultDataRequests(state) {
  const tenantId = defaultTenantId(state);
  return [
    {
      id: 'dsr_export_acme_health',
      tenantId,
      type: 'export',
      requesterEmail: 'ops@acmehealth.example',
      targetAccount: 'Acme Health',
      targetUserId: null,
      status: 'open',
      note: 'Local fixture for customer data export review.',
      exportUri: null,
      requestedAt: '2026-06-03T10:00:00.000Z',
      dueAt: '2026-07-03T10:00:00.000Z',
      handledByUserId: null,
      completedAt: null,
    },
  ];
}

function defaultIncidentNotes(state) {
  const tenantId = defaultTenantId(state);
  const admin = state.users?.find((user) => user.tenantId === tenantId && user.role === 'admin') ?? state.users?.[0];
  return [
    {
      id: 'inc_outlook_reauth_watch',
      tenantId,
      severity: 'watch',
      status: 'open',
      title: 'Outlook source needs reauthorization',
      body: 'Customer success mailbox remains blocked until the owner completes the local OAuth handoff.',
      createdByUserId: admin?.id ?? 'usr_admin',
      createdAt: '2026-06-03T11:00:00.000Z',
      resolvedByUserId: null,
      resolvedAt: null,
    },
  ];
}

function defaultAccountProfiles(state) {
  const tenantId = defaultTenantId(state);
  const accountNames = [...new Set([
    ...Object.keys(accountDefaults),
    ...(state.signals ?? []).map((signal) => signal.account),
    ...(state.sourceMessages ?? []).map((message) => message.account),
  ].filter(Boolean))];

  return accountNames.map((name) => {
    const defaults = accountDefaults[name] ?? {};
    const latestSignal = [...(state.signals ?? [])].reverse().find((signal) => signal.account === name);
    return {
      id: defaults.id ?? `acct_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      tenantId: latestSignal?.tenantId ?? tenantId,
      name,
      domain: defaults.domain ?? `${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`,
      stage: defaults.stage ?? 'Monitoring',
      ownerUserId: defaults.ownerUserId ?? latestSignal?.ownerUserId ?? state.users?.find((user) => user.role === 'admin')?.id ?? state.users?.[0]?.id,
      healthScore: defaults.healthScore ?? healthScoreForSignal(latestSignal),
      healthTrend: defaults.healthTrend ?? healthTrendForSignal(latestSignal),
      lastTouchAt: latestSignal?.receivedAt ?? defaults.lastTouchAt ?? state.meta?.updatedAt ?? nowIso(),
      nextReviewAt: defaults.nextReviewAt ?? expiresInIso(72 * 60 * 60 * 1000),
      summary: defaults.summary ?? `Account is monitored from ${latestSignal ? titleForSignal(latestSignal) : 'local relationship signals'}.`,
      tags: defaults.tags ?? [latestSignal?.type ?? 'monitoring'],
      stakeholders: defaults.stakeholders ?? [],
    };
  });
}

function defaultAccountEvents(state) {
  return (state.signals ?? []).map((signal) => ({
    id: `evt_acct_${signal.id}`,
    tenantId: signal.tenantId,
    account: signal.account,
    type: signal.type,
    title: titleForSignal(signal),
    detail: signal.summary,
    occurredAt: signal.receivedAt ?? state.meta?.updatedAt ?? state.meta?.bootstrappedAt ?? nowIso(),
    sourceMessageId: signal.sourceMessageId ?? null,
    signalId: signal.id,
  }));
}

function defaultAccountActions(state) {
  const tenantId = defaultTenantId(state);
  const seededActions = [
    {
      id: 'act_northstar_security_packet',
      tenantId,
      account: 'Northstar Ops',
      ownerUserId: 'usr_sales',
      title: 'Send security review packet',
      description: 'Package rollout timeline, security answers, and competitor displacement notes for the finance lead.',
      status: 'open',
      priority: 'high',
      dueAt: '2026-06-05T15:00:00.000Z',
      signalId: 'sig_expansion_001',
      createdAt: state.meta?.bootstrappedAt ?? '2026-06-03T00:00:00.000Z',
    },
    {
      id: 'act_ventureworks_export_discovery',
      tenantId,
      account: 'VentureWorks',
      ownerUserId: 'usr_product',
      title: 'Scope export workflow',
      description: 'Review the CSV export and CRM integration ask before product planning.',
      status: 'open',
      priority: 'medium',
      dueAt: '2026-06-06T16:00:00.000Z',
      signalId: 'sig_product_001',
      createdAt: state.meta?.bootstrappedAt ?? '2026-06-03T00:00:00.000Z',
    },
    {
      id: 'act_acme_exec_save',
      tenantId,
      account: 'Acme Health',
      ownerUserId: 'usr_admin',
      title: 'Schedule executive save plan',
      description: 'Prepare renewal risk review and find an executive bridge for the stalled champion path.',
      status: 'open',
      priority: 'critical',
      dueAt: '2026-06-04T14:30:00.000Z',
      signalId: 'sig_risk_001',
      createdAt: state.meta?.bootstrappedAt ?? '2026-06-03T00:00:00.000Z',
    },
  ];
  const knownSignalIds = new Set(seededActions.map((action) => action.signalId));
  return [
    ...seededActions,
    ...(state.signals ?? [])
      .filter((signal) => !knownSignalIds.has(signal.id))
      .map((signal) => actionForSignal(signal, state)),
  ];
}

function recommendationIdForAccount(account) {
  return `rec_${account.id}`;
}

function recommendationKindForAccount(account) {
  const tags = new Set(account.tags ?? []);
  if (tags.has('renewal_risk') || account.stage?.toLowerCase().includes('renewal')) {
    return 'renewal_save';
  }
  if (tags.has('expansion') || account.stage?.toLowerCase().includes('expansion')) {
    return 'expansion';
  }
  if (tags.has('product_idea') || tags.has('workflow_pain') || account.stage?.toLowerCase().includes('product')) {
    return 'product_discovery';
  }
  if (account.healthScore < 60 || account.healthTrend === 'down') {
    return 'relationship_repair';
  }
  return 'account_review';
}

function recommendationPriorityForAccount(account, openSignals, openActions) {
  if (
    account.healthScore < 50 ||
    openSignals.some((signal) => signal.severity === 'critical') ||
    openActions.some((action) => action.priority === 'critical')
  ) {
    return 'critical';
  }
  if (account.healthScore < 70 || account.healthTrend === 'down' || openActions.some((action) => action.priority === 'high')) {
    return 'high';
  }
  if (openSignals.length || openActions.length) {
    return 'medium';
  }
  return 'low';
}

function recommendationCopyForAccount(account, kind, openSignals, openActions, stakeholders) {
  const primarySignal = openSignals[0];
  const primaryAction = openActions[0];
  const concernedStakeholders = stakeholders.filter((stakeholder) => ['concerned', 'mixed', 'unknown'].includes(stakeholder.sentiment));
  if (kind === 'renewal_save') {
    return {
      title: `Run renewal save plan for ${account.name}`,
      rationale: `${account.name} is at ${account.healthScore} health with ${account.healthTrend} trend, ${openSignals.length} open signal${openSignals.length === 1 ? '' : 's'}, and ${concernedStakeholders.length} stakeholder concern marker${concernedStakeholders.length === 1 ? '' : 's'}.`,
      strategy: primaryAction?.description ?? 'Create an executive bridge, re-engage the champion, and resolve the highest-severity renewal blocker before the next review.',
    };
  }
  if (kind === 'expansion') {
    return {
      title: `Advance expansion path for ${account.name}`,
      rationale: `${account.name} has ${account.healthScore} health, ${account.healthTrend} trend, and ${openSignals.length} expansion-related signal${openSignals.length === 1 ? '' : 's'} from recent account context.`,
      strategy: primaryAction?.description ?? 'Send proof, answer security questions, and align budget owner timing while the account is in a positive buying window.',
    };
  }
  if (kind === 'product_discovery') {
    return {
      title: `Package product discovery for ${account.name}`,
      rationale: `${account.name} has product/workflow tags plus ${openSignals.length} open source-backed signal${openSignals.length === 1 ? '' : 's'} and ${openActions.length} action${openActions.length === 1 ? '' : 's'}.`,
      strategy: primaryAction?.description ?? 'Turn the account ask into a product brief with affected users, workflow impact, integration need, and CRM follow-up owner.',
    };
  }
  if (kind === 'relationship_repair') {
    return {
      title: `Repair relationship coverage for ${account.name}`,
      rationale: `${account.name} has ${account.healthScore} health, ${account.healthTrend} trend, and ${concernedStakeholders.length} stakeholder${concernedStakeholders.length === 1 ? '' : 's'} needing attention.`,
      strategy: primaryAction?.description ?? 'Map the missing stakeholder path, schedule a relationship review, and create a concrete next touch for the account owner.',
    };
  }
  return {
    title: `Review account strategy for ${account.name}`,
    rationale: `${account.name} has ${openSignals.length} open signal${openSignals.length === 1 ? '' : 's'}, ${openActions.length} open action${openActions.length === 1 ? '' : 's'}, and ${stakeholders.length} stakeholder${stakeholders.length === 1 ? '' : 's'} tracked.`,
    strategy: primarySignal?.summary ?? 'Create an account review snapshot and confirm the next owner action before the next digest.',
  };
}

function recommendationForAccount(state, account) {
  const openSignals = (state.signals ?? [])
    .filter((signal) => signal.account === account.name && signal.status === 'open')
    .sort((left, right) => priorityRank(right.severity) - priorityRank(left.severity));
  const openActions = (state.accountActions ?? [])
    .filter((action) => action.account === account.name && action.status === 'open')
    .sort((left, right) => priorityRank(right.priority) - priorityRank(left.priority));
  const stakeholders = account.stakeholders ?? [];
  const kind = recommendationKindForAccount(account);
  const priority = recommendationPriorityForAccount(account, openSignals, openActions);
  const copy = recommendationCopyForAccount(account, kind, openSignals, openActions, stakeholders);
  return {
    id: recommendationIdForAccount(account),
    tenantId: account.tenantId,
    account: account.name,
    accountId: account.id,
    ownerUserId: account.ownerUserId,
    kind,
    priority,
    status: 'open',
    title: copy.title,
    rationale: copy.rationale,
    strategy: copy.strategy,
    evidenceSignalIds: openSignals.slice(0, 5).map((signal) => signal.id),
    evidenceActionIds: openActions.slice(0, 5).map((action) => action.id),
    stakeholderIds: stakeholders.map((stakeholder) => stakeholder.id),
    createdAt: account.lastReviewAt ?? account.lastTouchAt ?? state.meta?.bootstrappedAt ?? nowIso(),
    createdByUserId: account.ownerUserId,
  };
}

function defaultAccountRecommendations(state) {
  return (state.accountProfiles ?? []).map((account) => recommendationForAccount(state, account));
}

function ensureDefaultAccountRecommendations(state) {
  state.accountRecommendations = state.accountRecommendations ?? [];
  const existingById = new Map(state.accountRecommendations.map((recommendation) => [recommendation.id, recommendation]));
  for (const account of state.accountProfiles ?? []) {
    const generated = recommendationForAccount(state, account);
    const existing = existingById.get(generated.id);
    if (!existing) {
      state.accountRecommendations.push(generated);
      continue;
    }
    Object.assign(existing, {
      ...generated,
      status: ['open', 'done', 'muted'].includes(existing.status) ? existing.status : generated.status,
      createdAt: existing.createdAt ?? generated.createdAt,
      createdByUserId: existing.createdByUserId ?? generated.createdByUserId,
      updatedAt: existing.updatedAt ?? generated.updatedAt ?? null,
    });
  }
}

function priorityRank(priority = 'low') {
  return {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  }[priority] ?? 0;
}

const notificationCadences = ['daily', 'weekly', 'off'];
const notificationStatuses = ['unread', 'read', 'muted', 'sent'];

function defaultDigestCadenceForUser(user) {
  if (user.role === 'admin') {
    return 'daily';
  }
  if (user.team === 'product') {
    return 'weekly';
  }
  return 'daily';
}

function defaultImmediateAlertsForUser(user) {
  return user.role === 'admin' || user.team === 'sales';
}

function unsubscribeCodeForUser(userId) {
  return `unsub_${userId}`;
}

function defaultNotificationPreferences(state) {
  const timestamp = state.meta?.bootstrappedAt ?? state.meta?.updatedAt ?? nowIso();
  return (state.users ?? [])
    .filter((user) => user.status === 'active')
    .map((user) => ({
      id: `pref_${user.id}`,
      tenantId: user.tenantId ?? defaultTenantId(state),
      userId: user.id,
      digestCadence: defaultDigestCadenceForUser(user),
      immediateAlerts: defaultImmediateAlertsForUser(user),
      channels: ['dashboard', 'email_digest'],
      mutedAccounts: [],
      mutedSignalTypes: user.team === 'product' ? ['renewal_risk'] : [],
      emailDeliveryStatus: 'subscribed',
      unsubscribeCode: unsubscribeCodeForUser(user.id),
      unsubscribedAt: null,
      updatedAt: timestamp,
    }));
}

function ensureDefaultNotificationPreferences(state) {
  state.notificationPreferences = state.notificationPreferences ?? [];
  const existingUserIds = new Set(state.notificationPreferences.map((preference) => preference.userId));
  defaultNotificationPreferences(state).forEach((preference) => {
    if (!existingUserIds.has(preference.userId)) {
      state.notificationPreferences.push(preference);
    }
  });
  state.notificationPreferences.forEach((preference) => {
    preference.channels = preference.channels?.length ? preference.channels : ['dashboard', 'email_digest'];
    preference.mutedAccounts = preference.mutedAccounts ?? [];
    preference.mutedSignalTypes = preference.mutedSignalTypes ?? [];
    preference.digestCadence = notificationCadences.includes(preference.digestCadence) ? preference.digestCadence : 'daily';
    preference.immediateAlerts = Boolean(preference.immediateAlerts);
    preference.emailDeliveryStatus = ['subscribed', 'unsubscribed'].includes(preference.emailDeliveryStatus) ? preference.emailDeliveryStatus : ((preference.channels ?? []).includes('email_digest') ? 'subscribed' : 'unsubscribed');
    preference.unsubscribeCode = preference.unsubscribeCode ?? unsubscribeCodeForUser(preference.userId);
    preference.unsubscribedAt = preference.emailDeliveryStatus === 'unsubscribed' ? (preference.unsubscribedAt ?? state.meta?.updatedAt ?? nowIso()) : (preference.unsubscribedAt ?? null);
  });
}

function preferenceForUser(state, userId) {
  ensureDefaultNotificationPreferences(state);
  let preference = state.notificationPreferences.find((candidate) => candidate.userId === userId);
  if (!preference) {
    const user = findById(state.users ?? [], userId, 'User');
    preference = defaultNotificationPreferences({ ...state, users: [user] })[0];
    state.notificationPreferences.push(preference);
  }
  return preference;
}

function signalTypeForNotification(eventLike) {
  if (eventLike.signalType) {
    return eventLike.signalType;
  }
  if (eventLike.type?.startsWith?.('signal.')) {
    return eventLike.type.replace(/^signal\./, '');
  }
  return eventLike.type;
}

function shouldMuteNotification(preference, eventLike) {
  const signalType = signalTypeForNotification(eventLike);
  return (
    (eventLike.account && (preference.mutedAccounts ?? []).includes(eventLike.account)) ||
    (signalType && (preference.mutedSignalTypes ?? []).includes(signalType))
  );
}

function notificationChannelForPreference(preference) {
  return preference.immediateAlerts ? 'dashboard_alert' : 'dashboard_digest';
}

function upsertNotificationEvent(state, event) {
  state.notificationEvents = state.notificationEvents ?? [];
  const existing = state.notificationEvents.find((candidate) => candidate.id === event.id);
  if (!existing) {
    state.notificationEvents.push(event);
    return event;
  }

  const preserved = {
    digestRunId: existing.digestRunId ?? null,
    mutedBy: existing.mutedBy ?? null,
    readAt: existing.readAt ?? null,
    status: existing.status ?? event.status,
  };
  Object.assign(existing, event, preserved);
  return existing;
}

function upsertNotificationForSignal(state, signal) {
  if (!signal.ownerUserId || signal.status === 'dismissed') {
    return null;
  }
  const preference = preferenceForUser(state, signal.ownerUserId);
  const mutedByPreference = shouldMuteNotification(preference, {
    account: signal.account,
    signalType: signal.type,
  });
  return upsertNotificationEvent(state, {
    id: `ntf_sig_${signal.id}`,
    tenantId: signal.tenantId,
    userId: signal.ownerUserId,
    account: signal.account,
    type: `signal.${signal.type}`,
    title: `New ${titleForSignal(signal)} signal`,
    body: signal.summary,
    status: mutedByPreference ? 'muted' : 'unread',
    channel: notificationChannelForPreference(preference),
    mutedBy: mutedByPreference ? 'preference' : null,
    signalId: signal.id,
    sourceMessageId: signal.sourceMessageId ?? null,
    accountActionId: null,
    createdAt: signal.receivedAt ?? state.meta?.updatedAt ?? state.meta?.bootstrappedAt ?? nowIso(),
    readAt: null,
    digestRunId: null,
  });
}

function upsertNotificationForAccountAction(state, action) {
  if (!action.ownerUserId) {
    return null;
  }
  if (action.status === 'done') {
    return (state.notificationEvents ?? []).find((event) => event.id === `ntf_action_${action.id}`) ?? null;
  }
  const preference = preferenceForUser(state, action.ownerUserId);
  const signal = action.signalId ? (state.signals ?? []).find((candidate) => candidate.id === action.signalId) : null;
  const mutedByPreference = shouldMuteNotification(preference, {
    account: action.account,
    signalType: signal?.type ?? action.priority,
  });
  return upsertNotificationEvent(state, {
    id: `ntf_action_${action.id}`,
    tenantId: action.tenantId,
    userId: action.ownerUserId,
    account: action.account,
    type: 'account_action',
    title: action.title,
    body: action.description,
    status: action.status === 'muted' || mutedByPreference ? 'muted' : 'unread',
    channel: notificationChannelForPreference(preference),
    mutedBy: action.status === 'muted' ? 'manual' : mutedByPreference ? 'preference' : null,
    signalId: action.signalId ?? null,
    sourceMessageId: signal?.sourceMessageId ?? null,
    accountActionId: action.id,
    createdAt: action.createdAt ?? state.meta?.updatedAt ?? state.meta?.bootstrappedAt ?? nowIso(),
    readAt: null,
    digestRunId: null,
  });
}

function defaultNotificationEvents(state) {
  const notificationState = {
    ...state,
    notificationEvents: [],
    notificationPreferences: state.notificationPreferences ?? defaultNotificationPreferences(state),
  };
  (state.signals ?? []).forEach((signal) => upsertNotificationForSignal(notificationState, signal));
  (state.accountActions ?? [])
    .filter((action) => action.status === 'open' || action.status === 'muted')
    .forEach((action) => upsertNotificationForAccountAction(notificationState, action));
  return notificationState.notificationEvents.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
}

function deliveryMessageForDigestRun(state, digestRun, userId, notificationIds, status = 'queued') {
  const user = findById(state.users ?? [], userId, 'User');
  const preference = preferenceForUser(state, userId);
  const message = {
    id: `del_${digestRun.id}_${userId}`,
    tenantId: digestRun.tenantId,
    digestRunId: digestRun.id,
    userId,
    toEmail: user.email,
    provider: 'local_email',
    subject: `Signal digest: ${notificationIds.length} update${notificationIds.length === 1 ? '' : 's'}`,
    status,
    notificationIds,
    unsubscribeCode: preference.unsubscribeCode,
    createdAt: digestRun.createdAt ?? nowIso(),
    sentAt: status === 'sent' ? (digestRun.completedAt ?? nowIso()) : null,
    statusReason: status === 'suppressed' ? 'Email digest unsubscribed.' : null,
  };
  return message;
}

function upsertEmailDeliveryMessage(state, message) {
  state.emailDeliveryMessages = state.emailDeliveryMessages ?? [];
  const existing = state.emailDeliveryMessages.find((candidate) => candidate.id === message.id);
  if (existing) {
    Object.assign(existing, message);
    return existing;
  }
  state.emailDeliveryMessages.push(message);
  return message;
}

function defaultEmailDeliveryMessages(state) {
  const messages = [];
  (state.notificationDigestRuns ?? []).forEach((digestRun) => {
    (digestRun.userIds ?? []).forEach((userId) => {
      const notificationIds = (digestRun.notificationIds ?? []).filter((notificationId) => {
        const event = (state.notificationEvents ?? []).find((candidate) => candidate.id === notificationId);
        return event?.userId === userId;
      });
      messages.push(deliveryMessageForDigestRun(state, digestRun, userId, notificationIds, 'sent'));
    });
  });
  return messages;
}

function refreshNotificationMuteRules(state, userId) {
  const preference = preferenceForUser(state, userId);
  (state.notificationEvents ?? [])
    .filter((event) => event.userId === userId && event.status !== 'sent')
    .forEach((event) => {
      const shouldMute = shouldMuteNotification(preference, event);
      if (shouldMute && event.status !== 'muted') {
        event.status = 'muted';
        event.mutedBy = 'preference';
        event.readAt = null;
      } else if (!shouldMute && event.status === 'muted' && event.mutedBy === 'preference') {
        event.status = 'unread';
        event.mutedBy = null;
      }
      event.channel = notificationChannelForPreference(preference);
    });
}

function refreshNotificationQueue(state) {
  ensureDefaultNotificationPreferences(state);
  state.notificationEvents = state.notificationEvents ?? [];
  (state.signals ?? []).forEach((signal) => upsertNotificationForSignal(state, signal));
  (state.accountActions ?? [])
    .filter((action) => action.status === 'open' || action.status === 'muted')
    .forEach((action) => upsertNotificationForAccountAction(state, action));
  state.notificationPreferences.forEach((preference) => refreshNotificationMuteRules(state, preference.userId));
  state.notificationEvents.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
}

function ensureDefaultEmailSyncCursors(state) {
  state.emailSyncCursors = state.emailSyncCursors ?? [];
  state.mailboxes?.forEach((mailbox) => {
    let cursor = state.emailSyncCursors.find((candidate) => candidate.mailboxId === mailbox.id);
    if (!cursor) {
      cursor = {
        id: `cur_${mailbox.id}`,
        mailboxId: mailbox.id,
        provider: mailbox.provider,
        status: cursorStatusForMailbox(mailbox),
        cursor: `${mailbox.provider}-cursor-${mailbox.id}`,
        lastSyncedAt: mailbox.status === 'connected' ? (state.meta?.updatedAt ?? state.meta?.bootstrappedAt ?? nowIso()) : null,
        lastReplayAt: null,
        windowStartAt: new Date(Date.now() - (mailbox.syncPolicy?.lookbackDays ?? 30) * 24 * 60 * 60 * 1000).toISOString(),
      };
      state.emailSyncCursors.push(cursor);
    }
    cursor.provider = mailbox.provider;
    cursor.providerSyncMode = cursor.providerSyncMode ?? 'local';
    cursor.status = (cursor.providerBackoffUntil || cursor.providerBackoffReason)
      ? 'blocked'
      : cursorStatusForMailbox(mailbox);
  });
}

function ensureDefaultMailboxConnectionSessions(state) {
  state.mailboxConnectionSessions = state.mailboxConnectionSessions ?? [];
  state.mailboxes
    ?.filter((mailbox) => mailbox.status === 'needs_reauth')
    .forEach((mailbox) => {
      const existingSession = state.mailboxConnectionSessions.some((session) => session.mailboxId === mailbox.id && session.status === 'ready');
      if (existingSession) {
        return;
      }
      state.mailboxConnectionSessions.push({
        id: `mcs_${mailbox.id}`,
        tenantId: mailbox.tenantId,
        mailboxId: mailbox.id,
        provider: mailbox.provider,
        ownerUserId: mailbox.ownerUserId,
        status: 'ready',
        url: `signal://oauth/${mailbox.provider}/${mailbox.tenantId}/${mailbox.id}`,
        selectedScopes: mailbox.selectedScopes ?? ['thread_metadata'],
        createdAt: state.meta?.updatedAt ?? state.meta?.bootstrappedAt ?? nowIso(),
        expiresAt: expiresInIso(60 * 60 * 1000),
      });
    });
}

function ensureDefaultJobs(state) {
  if ((state.jobs ?? []).length > 0) {
    return;
  }

  state.jobs = [];
  state.mailboxes?.forEach((mailbox) => {
    const failed = mailbox.status === 'needs_reauth';
    state.jobs.push({
      id: `job_${mailbox.id}`,
      tenantId: mailbox.tenantId,
      queue: 'email_sync',
      type: failed ? 'mailbox.reauth' : 'mailbox.sync',
      targetId: mailbox.id,
      status: failed ? 'failed' : 'succeeded',
      attempts: failed ? 1 : 1,
      maxAttempts: 3,
      lastRunAt: state.meta?.updatedAt ?? state.meta?.bootstrappedAt ?? nowIso(),
      message: failed ? 'Mailbox owner reauthorization is required.' : `Synced ${mailbox.provider} source metadata.`,
    });
  });

  state.subscriptions?.forEach((subscription) => {
    state.jobs.push({
      id: `job_billing_${subscription.id}`,
      tenantId: subscription.tenantId,
      queue: 'billing_webhook',
      type: 'payment.webhook',
      targetId: subscription.id,
      status: 'succeeded',
      attempts: 1,
      maxAttempts: 5,
      lastRunAt: state.meta?.updatedAt ?? state.meta?.bootstrappedAt ?? nowIso(),
      message: 'Billing state is synchronized from local provider events.',
    });
  });
}

const routingTargets = ['sales', 'product', 'customer_success', 'founder', 'crm'];

function defaultRoutingRules(state) {
  const createdAt = state.meta?.updatedAt ?? state.meta?.bootstrappedAt ?? nowIso();
  return (state.emailFlows ?? []).map((flow) => ({
    id: `rr_${flow.id}`,
    tenantId: flow.tenantId,
    flowId: flow.id,
    routeTo: routingTargets.includes(flow.routeTo) ? flow.routeTo : 'sales',
    ownerUserId: null,
    status: 'active',
    note: 'Default local routing rule from seeded detector route.',
    createdAt,
    createdByUserId: 'usr_admin',
    updatedAt: createdAt,
    updatedByUserId: 'usr_admin',
  }));
}

function ensureDefaultRoutingRules(state) {
  state.routingRules = state.routingRules ?? [];
  for (const flow of state.emailFlows ?? []) {
    const existing = state.routingRules.find((rule) => rule.flowId === flow.id);
    if (!existing) {
      state.routingRules.push(defaultRoutingRules({ ...state, emailFlows: [flow] })[0]);
      continue;
    }
    existing.tenantId = existing.tenantId ?? flow.tenantId;
    existing.routeTo = routingTargets.includes(existing.routeTo) ? existing.routeTo : (routingTargets.includes(flow.routeTo) ? flow.routeTo : 'sales');
    existing.status = ['active', 'disabled'].includes(existing.status) ? existing.status : 'active';
    existing.createdAt = existing.createdAt ?? state.meta?.updatedAt ?? state.meta?.bootstrappedAt ?? nowIso();
    existing.createdByUserId = existing.createdByUserId ?? 'usr_admin';
  }
}

const flowRouteProfiles = {
  customer_success: {
    ownerTeam: 'success',
    severity: 'critical',
    type: 'renewal_risk',
  },
  crm: {
    ownerTeam: 'sales',
    severity: 'high',
    type: 'buying_intent',
  },
  founder: {
    ownerRole: 'admin',
    severity: 'critical',
    type: 'buying_intent',
  },
  product: {
    ownerTeam: 'product',
    severity: 'medium',
    type: 'product_idea',
  },
  sales: {
    ownerTeam: 'sales',
    severity: 'high',
    type: 'buying_intent',
  },
};

function healthScoreForSignal(signal) {
  if (!signal) {
    return 70;
  }
  if (signal.severity === 'critical') {
    return 42;
  }
  if (signal.severity === 'high') {
    return signal.type === 'renewal_risk' ? 50 : 78;
  }
  if (signal.severity === 'medium') {
    return 66;
  }
  return 74;
}

function healthTrendForSignal(signal) {
  if (!signal) {
    return 'flat';
  }
  if (signal.type === 'renewal_risk' || signal.severity === 'critical') {
    return 'down';
  }
  if (signal.type === 'buying_intent' || signal.type === 'expansion_intent') {
    return 'up';
  }
  return 'flat';
}

function titleForSignal(signal) {
  return signal.type.replaceAll('_', ' ');
}

function actionTitleForSignal(signal) {
  if (signal.type === 'renewal_risk') {
    return 'Prepare renewal save plan';
  }
  if (signal.type === 'product_idea') {
    return 'Scope product discovery';
  }
  if (signal.type === 'buying_intent' || signal.type === 'expansion_intent') {
    return 'Package buying committee follow-up';
  }
  return 'Review account signal';
}

function actionPriorityForSignal(signal) {
  if (signal.severity === 'critical') {
    return 'critical';
  }
  if (signal.severity === 'high') {
    return 'high';
  }
  return 'medium';
}

function actionForSignal(signal, state) {
  return {
    id: `act_${signal.id}`,
    tenantId: signal.tenantId,
    account: signal.account,
    ownerUserId: accountDefaults[signal.account]?.ownerUserId ?? signal.ownerUserId ?? state.users?.find((user) => user.role === 'admin')?.id ?? state.users?.[0]?.id,
    title: actionTitleForSignal(signal),
    description: signal.summary,
    status: 'open',
    priority: actionPriorityForSignal(signal),
    dueAt: expiresInIso(signal.severity === 'critical' ? 24 * 60 * 60 * 1000 : 72 * 60 * 60 * 1000),
    signalId: signal.id,
    createdAt: nowIso(),
  };
}

function ensureAccountMonitoringForSignal(state, signal) {
  state.accountProfiles = state.accountProfiles ?? defaultAccountProfiles(state);
  state.accountEvents = state.accountEvents ?? [];
  state.accountActions = state.accountActions ?? [];

  let profile = state.accountProfiles.find((account) => account.name === signal.account);
  if (!profile) {
    profile = defaultAccountProfiles({ ...state, signals: [signal] }).find((account) => account.name === signal.account);
    if (profile) {
      state.accountProfiles.push(profile);
    }
  }

  if (profile) {
    profile.healthScore = Math.min(profile.healthScore ?? 70, healthScoreForSignal(signal));
    profile.healthTrend = healthTrendForSignal(signal);
    profile.lastTouchAt = signal.receivedAt ?? nowIso();
    profile.ownerUserId = profile.ownerUserId ?? signal.ownerUserId;
    profile.tags = [...new Set([...(profile.tags ?? []), signal.type])];
  }

  const eventId = `evt_acct_${signal.id}`;
  if (!state.accountEvents.some((event) => event.id === eventId)) {
    state.accountEvents.push({
      id: eventId,
      tenantId: signal.tenantId,
      account: signal.account,
      type: signal.type,
      title: titleForSignal(signal),
      detail: signal.summary,
      occurredAt: signal.receivedAt ?? nowIso(),
      sourceMessageId: signal.sourceMessageId ?? null,
      signalId: signal.id,
    });
  }

  const actionId = `act_${signal.id}`;
  if (!state.accountActions.some((action) => action.id === actionId)) {
    state.accountActions.push(actionForSignal(signal, state));
  }
}

function sourceMessageText(message) {
  return [
    message.account,
    message.from,
    message.subject,
    message.snippet,
    ...(message.labels ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function matchingTerms(flow, message) {
  const text = sourceMessageText(message);
  return (flow.detects ?? []).filter((term) => text.includes(term.toLowerCase()));
}

function activeRoutingRuleForFlow(state, flow) {
  return [...(state.routingRules ?? [])]
    .filter((rule) => rule.flowId === flow.id && rule.status === 'active')
    .sort((left, right) => Date.parse(right.updatedAt ?? right.createdAt ?? '') - Date.parse(left.updatedAt ?? left.createdAt ?? ''))[0] ?? null;
}

function effectiveFlowRouting(state, flow) {
  const rule = activeRoutingRuleForFlow(state, flow);
  const routeTo = routingTargets.includes(rule?.routeTo) ? rule.routeTo : (routingTargets.includes(flow.routeTo) ? flow.routeTo : 'sales');
  return {
    ownerUserId: rule?.ownerUserId ?? null,
    profile: flowRouteProfiles[routeTo] ?? flowRouteProfiles.sales,
    routingRuleId: rule?.id ?? null,
    routeTo,
  };
}

function ownerForFlow(state, flow, message, mailbox) {
  const routing = effectiveFlowRouting(state, flow);
  const profile = routing.profile;
  const explicitOwner = routing.ownerUserId
    ? state.users?.find((user) => user.id === routing.ownerUserId && user.tenantId === flow.tenantId && user.status === 'active')
    : null;
  const routedOwner = state.users?.find((user) => (
    user.tenantId === flow.tenantId &&
    user.status === 'active' &&
    user.team === profile.ownerTeam
  ));
  const mailboxOwner = state.users?.find((user) => user.id === mailbox.ownerUserId && user.status === 'active');
  const adminOwner = state.users?.find((user) => user.tenantId === flow.tenantId && user.role === 'admin' && user.status === 'active');
  if (profile.ownerRole === 'admin' || routing.routeTo === 'customer_success') {
    return explicitOwner?.id ?? routedOwner?.id ?? adminOwner?.id ?? mailboxOwner?.id ?? message.ownerUserId ?? state.users?.[0]?.id;
  }
  return explicitOwner?.id ?? routedOwner?.id ?? mailboxOwner?.id ?? adminOwner?.id ?? message.ownerUserId ?? state.users?.[0]?.id;
}

function signalIdForSource(flowId, messageId) {
  const suffix = `${flowId}_${messageId}`.replace(/^(flow|msg)_/g, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 78);
  return `sig_${suffix}`;
}

function signalSummaryForMatch(flow, message, matches) {
  const terms = matches.length ? matches.join(', ') : 'flow language';
  return `${message.account} mentioned ${terms} in "${message.subject}".`;
}

function signalForSourceMessage(state, flow, message, mailbox, matches) {
  const routing = effectiveFlowRouting(state, flow);
  const profile = routing.profile;
  const confidence = Math.min(0.96, 0.72 + matches.length * 0.06);
  return {
    id: signalIdForSource(flow.id, message.id),
    tenantId: flow.tenantId,
    account: message.account,
    type: profile.type,
    severity: profile.severity,
    confidence: Number(confidence.toFixed(2)),
    summary: signalSummaryForMatch(flow, message, matches),
    ownerUserId: ownerForFlow(state, flow, message, mailbox),
    routeTo: routing.routeTo,
    routingRuleId: routing.routingRuleId,
    status: 'open',
    sourceMessageId: message.id,
    flowId: flow.id,
    sourceSnippet: message.snippet,
    receivedAt: message.receivedAt,
  };
}

export function getActor(state, actorUserId, { allowMissing = false, requireExplicit = false } = {}) {
  if (requireExplicit && !actorUserId) {
    throw new SignalStateError('Actor identity is required.', {
      code: 'ACTOR_REQUIRED',
      status: 401,
      details: {},
    });
  }
  const fallbackUserId = actorUserId ?? state.session?.activeUserId ?? process.env.SIGNAL_ADMIN_ACTOR ?? 'usr_admin';
  const user = state.users?.find((candidate) => candidate.id === fallbackUserId && candidate.status === 'active');
  const membership = user ? activeMembershipForUser(state, user.id, user.tenantId) : null;
  if ((!user || !membership) && !allowMissing) {
    throw new SignalStateError(`Actor is not an active user: ${fallbackUserId}`, {
      code: 'ACTOR_INVALID',
      status: 401,
      details: { actorUserId: fallbackUserId, membershipStatus: membership?.status ?? 'missing' },
    });
  }
  if (!user) {
    return null;
  }
  return membership
    ? {
        ...user,
        role: membership.role,
        team: membership.team ?? user.team,
        membershipId: membership.id,
        membershipStatus: membership.status,
      }
    : user;
}

export async function issueSessionToken(userId, { actorUserId, env = process.env, statePath, ttlSeconds } = {}) {
  return mutateState(
    'session.token',
    (state, actor) => {
      const target = getActor(state, requireArg(userId, 'user id', 'session token <userId>'));
      requireAdminOrOwner(actor, target.id, 'session.token');
      let issued;
      try {
        issued = createSessionToken({
          env,
          tenantId: target.tenantId,
          ttlSeconds,
          user: target,
        });
      } catch (tokenError) {
        throw signalErrorFromProviderError(tokenError);
      }
      const apiSession = registerApiSession(state, issued, target, actor);
      return {
        apiSessionId: apiSession.id,
        expiresAt: issued.expiresAt,
        issuedAt: issued.issuedAt,
        message: `Issued signed session token for ${target.email}`,
        targetId: target.id,
        token: issued.token,
        tokenDigest: issued.tokenDigest,
        userId: target.id,
      };
    },
    { actorUserId, statePath },
  );
}

export async function verifyLocalSessionToken(token, { env = process.env, statePath } = {}) {
  let verification;
  try {
    verification = verifySessionToken(requireArg(token, 'session token', 'session verify <token>'), { env });
  } catch (tokenError) {
    throw signalErrorFromProviderError(tokenError);
  }
  const state = await loadState({ statePath });
  const { actor, session } = validateApiSession(state, verification);
  return {
    ok: true,
    actor: {
      email: actor.email,
      id: actor.id,
      name: actor.name,
      role: actor.role,
      status: actor.status,
      team: actor.team ?? null,
    },
    payload: verification.payload,
    session,
    tokenDigest: verification.tokenDigest,
    verifiedAt: verification.verifiedAt,
  };
}

export async function revokeSessionToken(sessionRef, options = {}) {
  return mutateState(
    'session.revoke',
    (state, actor) => {
      const session = findApiSession(state, sessionRef);
      requireAdminOrOwner(actor, session.userId, 'session.revoke');
      const previousStatus = apiSessionStatus(session);
      session.status = 'revoked';
      session.revokedAt = nowIso();
      session.revokedByUserId = actor.id;
      session.updatedAt = session.revokedAt;
      const target = getActor(state, session.userId, { allowMissing: true });
      return {
        message: `Revoked API session ${session.id}${target ? ` for ${target.email}` : ''}`,
        previousStatus,
        sessionDigest: session.digest,
        sessionId: session.id,
        targetId: session.userId,
        userId: session.userId,
      };
    },
    options,
  );
}

export async function recordProviderSandboxValidation(sandbox, options = {}) {
  return mutateState(
    'integrations.sandbox.record',
    (state, actor) => {
      requireAdmin(actor, 'integrations.sandbox.record');
      return recordProviderSandboxValidationInState(state, actor, sandbox);
    },
    options,
  );
}

export async function exportProviderSandboxEvidence(runRef = 'latest', options = {}) {
  return mutateState(
    'integrations.sandbox.evidence-export',
    (state, actor) => {
      requireAdmin(actor, 'integrations.sandbox.evidence-export');
      const run = providerValidationRunByRef(state, runRef);
      const artifact = createProviderSandboxEvidenceArtifact(run, {
        exportedByUserId: actor.id,
      });
      return {
        artifact,
        artifactDigest: artifact.artifactDigest,
        id: run.id,
        message: `Exported provider sandbox evidence for ${run.id}.`,
        reportDigest: run.reportDigest,
        status: run.status,
        summary: run.summary,
        targetId: run.id,
      };
    },
    options,
  );
}

export async function importProviderSandboxEvidence(artifact, options = {}) {
  return mutateState(
    'integrations.sandbox.evidence-import',
    (state, actor) => {
      requireAdmin(actor, 'integrations.sandbox.evidence-import');
      const sanitizedArtifact = sanitizeProviderSandboxEvidenceArtifact(artifact);
      const recorded = recordProviderSandboxValidationInState(state, actor, sanitizedArtifact.sandbox);
      return {
        ...recorded,
        artifactDigest: sanitizedArtifact.artifactDigest,
        importedFromRecordedAt: sanitizedArtifact.sourceRun.recordedAt,
        importedFromReportDigest: sanitizedArtifact.sourceRun.reportDigest,
        importedFromRunId: sanitizedArtifact.sourceRun.id,
        message: `Imported provider sandbox evidence ${sanitizedArtifact.artifactDigest} as ${recorded.id} (${recorded.status}).`,
        sourceCommand: sanitizedArtifact.sourceCommand,
        sourceExportedAt: sanitizedArtifact.exportedAt,
        targetId: recorded.id,
      };
    },
    options,
  );
}

export async function setProviderValidationSchedule(providerId, { cadence, status } = {}, options = {}) {
  return mutateState(
    'integrations.schedule',
    (state, actor) => {
      requireAdmin(actor, 'integrations.schedule');
      ensureDefaultProviderValidationSchedules(state);
      const normalizedProviderId = requireOneOf(
        providerId,
        scheduledProviderIds,
        'provider id',
        'integrations schedule <gmail|outlook|outbound-email|stripe> [daily|weekly|manual|active|paused]',
      );
      const schedule = (state.providerValidationSchedules ?? []).find((candidate) => candidate.providerId === normalizedProviderId);
      if (!schedule) {
        throw new SignalStateError(`Provider validation schedule not found: ${normalizedProviderId}`, {
          code: 'NOT_FOUND',
          status: 404,
          details: { providerId: normalizedProviderId },
        });
      }
      const previousCadence = schedule.cadence;
      const previousStatus = schedule.status;
      if (cadence !== undefined && cadence !== null && cadence !== '') {
        schedule.cadence = requireOneOf(
          cadence,
          providerValidationCadences,
          'provider validation cadence',
          'integrations schedule <providerId> <daily|weekly|manual>',
        );
      }
      if (status !== undefined && status !== null && status !== '') {
        schedule.status = requireOneOf(
          status,
          providerValidationScheduleStatuses,
          'provider validation schedule status',
          'integrations schedule <providerId> <active|paused>',
        );
      }
      schedule.updatedAt = nowIso();
      schedule.updatedByUserId = actor.id;
      schedule.nextRunAt = schedule.status === 'active' ? addCadenceIntervalIso(schedule.updatedAt, schedule.cadence) : null;
      return {
        id: schedule.id,
        cadence: schedule.cadence,
        message: `Updated ${schedule.providerLabel} validation schedule to ${schedule.status}/${schedule.cadence}.`,
        nextRunAt: schedule.nextRunAt,
        previousCadence,
        previousStatus,
        providerId: schedule.providerId,
        status: schedule.status,
        targetId: schedule.id,
      };
    },
    options,
  );
}

export async function setTenantStatus(tenantId, nextStatus, { reason } = {}, options = {}) {
  return mutateState(
    'tenants.status',
    (state, actor) => {
      requireAdmin(actor, 'tenants.status');
      const tenant = findById(state.tenants ?? [], requireArg(tenantId, 'tenant id', 'tenants status <tenantId> <active|suspended> [reason]'), 'Tenant');
      const status = requireOneOf(nextStatus, ['active', 'suspended'], 'tenant status', 'tenants status <tenantId> <active|suspended> [reason]');
      const previousStatus = tenant.status ?? 'active';
      tenant.status = status;
      tenant.statusUpdatedAt = nowIso();
      tenant.statusUpdatedByUserId = actor.id;
      tenant.suspensionReason = status === 'suspended' ? (String(reason ?? '').replaceAll('_', ' ').trim() || 'Suspended by local admin') : null;
      tenant.suspendedAt = status === 'suspended' ? tenant.statusUpdatedAt : null;
      tenant.suspendedByUserId = status === 'suspended' ? actor.id : null;
      return {
        message: `${tenant.domain} tenant status changed from ${previousStatus} to ${status}`,
        nextStatus: status,
        previousStatus,
        reason: tenant.suspensionReason,
        targetId: tenant.id,
        tenantId: tenant.id,
      };
    },
    options,
  );
}

export async function setTenantDomain(tenantId, domain, options = {}) {
  return mutateState(
    'tenants.domain',
    (state, actor) => {
      requireAdmin(actor, 'tenants.domain');
      const tenant = findById(state.tenants ?? [], requireArg(tenantId, 'tenant id', 'tenants domain <tenantId> <domain>'), 'Tenant');
      const nextDomain = normalizeDomain(domain, 'tenants domain <tenantId> <domain>');
      const previousDomain = tenant.domain;
      const conflict = (state.tenants ?? []).find((candidate) => candidate.id !== tenant.id && candidate.domain === nextDomain);
      if (conflict) {
        throw new SignalStateError(`Domain already belongs to tenant: ${nextDomain}`, {
          code: 'TENANT_DOMAIN_CONFLICT',
          status: 409,
          details: { domain: nextDomain, tenantId: tenant.id, conflictingTenantId: conflict.id },
        });
      }
      tenant.domain = nextDomain;
      tenant.domainUpdatedAt = nowIso();
      tenant.domainUpdatedByUserId = actor.id;
      return {
        message: `${tenant.id} domain changed from ${previousDomain} to ${nextDomain}`,
        nextDomain,
        previousDomain,
        targetId: tenant.id,
        tenantId: tenant.id,
      };
    },
    options,
  );
}

function requireAdmin(actor, action) {
  if (actor.role !== 'admin') {
    throw new SignalStateError(`Admin role required for ${action}.`, {
      code: 'FORBIDDEN',
      status: 403,
      details: { action, actorUserId: actor.id, actorRole: actor.role, requiredRole: 'admin' },
    });
  }
}

function requireAdminOrOwner(actor, ownerUserId, action) {
  if (actor.role === 'admin' || actor.id === ownerUserId) {
    return;
  }
  throw new SignalStateError(`Admin role or ownership required for ${action}.`, {
    code: 'FORBIDDEN',
    status: 403,
    details: { action, actorUserId: actor.id, actorRole: actor.role, ownerUserId },
  });
}

function requireBillingOwner(state, actor, tenant, action) {
  const ownerUserId = tenant.billingOwnerUserId ?? tenant.ownerUserId ?? state.users?.find((user) => user.tenantId === tenant.id && user.role === 'admin')?.id;
  if (actor.role === 'admin' || actor.id === ownerUserId) {
    return;
  }
  throw new SignalStateError(`Admin role or billing ownership required for ${action}.`, {
    code: 'FORBIDDEN',
    status: 403,
    details: { action, actorUserId: actor.id, actorRole: actor.role, billingOwnerUserId: ownerUserId, tenantId: tenant.id },
  });
}

function requireActiveEntitlementForMember(state, actor, tenantId, action) {
  if (actor.role === 'admin') {
    return;
  }
  const tenant = findById(state.tenants ?? [], tenantId, 'Tenant');
  if (tenant.status === 'suspended') {
    throw new SignalStateError(`Tenant is suspended for ${action}.`, {
      code: 'TENANT_SUSPENDED',
      status: 423,
      details: { action, actorUserId: actor.id, actorRole: actor.role, tenantId, tenantStatus: tenant.status },
    });
  }
  const entitlement = state.entitlements?.find((candidate) => candidate.tenantId === tenantId);
  if (entitlement?.status === 'active') {
    return;
  }
  throw new SignalStateError(`Active billing entitlement required for ${action}.`, {
    code: 'PAYMENT_REQUIRED',
    status: 402,
    details: { action, actorUserId: actor.id, actorRole: actor.role, tenantId, entitlementStatus: entitlement?.status ?? 'missing' },
  });
}

function normalizeEmail(email, usage) {
  const normalized = requireArg(email, 'email', usage).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new SignalStateError(`Invalid email: ${email}`, {
      code: 'ARG_INVALID',
      details: { email, usage },
    });
  }
  return normalized;
}

function normalizeDomain(domain, usage) {
  const normalized = requireArg(domain, 'domain', usage)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new SignalStateError(`Invalid domain: ${domain}`, {
      code: 'ARG_INVALID',
      details: { domain, usage },
    });
  }
  return normalized;
}

function userIdFromEmail(state, email) {
  const base = email
    .split('@')[0]
    .replace(/\+.*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'user';
  let candidate = `usr_${base}`;
  let index = 2;
  while ((state.users ?? []).some((user) => user.id === candidate)) {
    candidate = `usr_${base}_${index}`;
    index += 1;
  }
  return candidate;
}

function displayNameFromEmail(email) {
  return email
    .split('@')[0]
    .replace(/\+.*/, '')
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ') || email;
}

function tenantIdFromDomain(state, domain) {
  const base = domain
    .split('.')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'workspace';
  let candidate = `tenant_${base}`;
  let index = 2;
  while ((state.tenants ?? []).some((tenant) => tenant.id === candidate)) {
    candidate = `tenant_${base}_${index}`;
    index += 1;
  }
  return candidate;
}

function requireSeatCapacityForInvite(state, tenantId, action) {
  const limit = seatLimitForTenant(state, tenantId);
  if (limit === null) {
    return;
  }
  const used = activeSeatCount(state, tenantId) + pendingInviteSeatCount(state, tenantId);
  if (used < limit) {
    return;
  }
  throw new SignalStateError(`Seat limit reached for ${action}.`, {
    code: 'SEAT_LIMIT_REACHED',
    status: 402,
    details: { action, activeSeats: activeSeatCount(state, tenantId), pendingInviteSeats: pendingInviteSeatCount(state, tenantId), seatLimit: limit, tenantId },
  });
}

function requireSeatCapacityForAcceptance(state, tenantId, action) {
  const limit = seatLimitForTenant(state, tenantId);
  if (limit === null || activeSeatCount(state, tenantId) < limit) {
    return;
  }
  throw new SignalStateError(`Seat limit reached for ${action}.`, {
    code: 'SEAT_LIMIT_REACHED',
    status: 402,
    details: { action, activeSeats: activeSeatCount(state, tenantId), seatLimit: limit, tenantId },
  });
}

function appendAudit(state, action, targetId, message, actor) {
  state.auditEvents = state.auditEvents ?? [];
  state.auditEvents.push({
    id: `audit_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    action,
    targetId,
    message,
    createdAt: new Date().toISOString(),
    actor: actor.id,
    actorRole: actor.role,
  });
}

async function mutateState(action, mutator, {
  actorUserId,
  requireExplicitActor = false,
  retryOnConflict = true,
  statePath,
} = {}) {
  const resolvedStatePath = resolveStatePath(statePath);
  return runLockedStateWriter(resolvedStatePath, async () => {
    const state = await loadState({ statePath });
    const actor = getActor(state, actorUserId, { requireExplicit: requireExplicitActor });
    const details = await mutator(state, actor);
    appendAudit(state, action, details.targetId ?? details.id ?? action, details.message, actor);
    const saved = await saveState(state, { statePath });
    return {
      ok: true,
      action,
      actor,
      details,
      state: saved.state,
      summary: saved.summary,
    };
  }, { retryOnConflict });
}

function createTenantWorkspaceInState(state, {
  name,
  domain,
  adminEmail,
  adminName,
  planId = 'plan_beta',
} = {}, {
  action = 'tenants.create',
  actor = null,
  registrationMode = 'admin',
  usage = 'tenants create <workspaceName> <domain> <adminEmail> [adminName] [planId]',
} = {}) {
  const workspaceName = String(requireArg(name, 'workspace name', usage)).replaceAll('_', ' ').trim();
  const workspaceDomain = normalizeDomain(domain, usage);
  const ownerEmail = normalizeEmail(adminEmail, usage);
  const ownerName = (adminName ? String(adminName).replaceAll('_', ' ') : displayNameFromEmail(ownerEmail)).trim();
  const plan = findById(state.plans ?? [], planId ?? 'plan_beta', 'Plan');

  if ((state.tenants ?? []).some((tenant) => tenant.domain.toLowerCase() === workspaceDomain)) {
    throw new SignalStateError(`Tenant domain already exists: ${workspaceDomain}`, {
      code: 'TENANT_EXISTS',
      status: 409,
      details: { domain: workspaceDomain },
    });
  }
  if ((state.users ?? []).some((user) => user.email.toLowerCase() === ownerEmail && user.status === 'active')) {
    throw new SignalStateError(`Active user already exists for ${ownerEmail}`, {
      code: 'USER_EXISTS',
      status: 409,
      details: { email: ownerEmail },
    });
  }

  const tenantId = tenantIdFromDomain(state, workspaceDomain);
  const user = {
    id: userIdFromEmail(state, ownerEmail),
    tenantId,
    name: ownerName,
    email: ownerEmail,
    role: 'admin',
    team: 'ops',
    status: 'active',
  };
  const createdAt = nowIso();
  const creatorUserId = actor?.id ?? user.id;
  const tenant = {
    id: tenantId,
    name: workspaceName,
    domain: workspaceDomain,
    status: 'active',
    planId: plan.id,
    ownerUserId: user.id,
    billingOwnerUserId: user.id,
    registrationStatus: 'pending_onboarding',
    createdAt,
    createdByUserId: creatorUserId,
    registrationMode,
    statusUpdatedAt: createdAt,
    statusUpdatedByUserId: creatorUserId,
  };
  const subscription = {
    id: `sub_${tenantId}`,
    tenantId,
    provider: 'local_test',
    planId: plan.id,
    status: plan.monthlyCents > 0 ? 'trialing' : 'active',
    ...(plan.monthlyCents > 0 ? { trialEndsAt: expiresInIso(14 * 24 * 60 * 60 * 1000) } : {}),
  };

  state.tenants.push(tenant);
  state.users.push(user);
  state.memberships = state.memberships ?? [];
  state.memberships.push({
    id: membershipIdFor(tenantId, user.id),
    tenantId,
    userId: user.id,
    role: 'admin',
    team: 'ops',
    status: 'active',
    createdAt,
    createdByUserId: creatorUserId,
  });
  state.subscriptions = state.subscriptions ?? [];
  state.subscriptions.push(subscription);
  upsertEntitlementFromSubscription(state, subscription);
  preferenceForUser(state, user.id);
  state.billingSessions = state.billingSessions ?? [];
  state.billingSessions.push({
    id: makeId('bs_checkout'),
    tenantId,
    provider: 'local_test',
    type: 'checkout',
    status: 'ready',
    planId: plan.id,
    subscriptionId: subscription.id,
    url: `signal://billing/checkout/${tenantId}/${plan.id}`,
    createdAt,
    expiresAt: expiresInIso(60 * 60 * 1000),
    providerMode: 'local',
  });
  appendPaymentEvent(state, {
    tenantId,
    provider: 'local_test',
    type: 'workspace.registration.started',
    status: 'recorded',
    subscriptionId: subscription.id,
  });
  upsertNotificationEvent(state, {
    id: `ntf_workspace_created_${user.id}`,
    tenantId,
    userId: user.id,
    account: null,
    type: 'onboarding.workspace_created',
    title: 'Complete workspace onboarding',
    body: 'Invite teammates, connect a Gmail or Outlook source, and confirm notification preferences.',
    status: 'unread',
    channel: 'dashboard_alert',
    mutedBy: null,
    signalId: null,
    sourceMessageId: null,
    accountActionId: null,
    createdAt,
    readAt: null,
    digestRunId: null,
  });
  appendJob(state, {
    tenantId,
    queue: 'user_onboarding',
    type: action,
    targetId: tenantId,
    status: 'succeeded',
    attempts: 1,
    maxAttempts: 3,
    message: `Created local workspace registration for ${workspaceName}.`,
  });
  state.session = {
    allowedRoles: ['admin', 'member'],
    localOnly: true,
    ...(state.session ?? {}),
    activeUserId: user.id,
  };

  return {
    message: `${workspaceName} workspace registered for ${ownerEmail}`,
    adminUserId: user.id,
    billingOwnerUserId: user.id,
    planId: plan.id,
    registrationMode,
    registrationStatus: tenant.registrationStatus,
    subscriptionId: subscription.id,
    targetId: tenant.id,
    tenantId: tenant.id,
  };
}

export async function createTenantWorkspace({ name, domain, adminEmail, adminName, planId = 'plan_beta' } = {}, options = {}) {
  return mutateState(
    'tenants.create',
    (state, actor) => {
      requireAdmin(actor, 'tenants.create');
      return createTenantWorkspaceInState(state, { name, domain, adminEmail, adminName, planId }, {
        action: 'tenants.create',
        actor,
        registrationMode: 'admin_created',
      });
    },
    options,
  );
}

export async function registerTenantWorkspace({ name, domain, adminEmail, adminName, planId = 'plan_beta' } = {}, { statePath } = {}) {
  const resolvedStatePath = resolveStatePath(statePath);
  return runLockedStateWriter(resolvedStatePath, async () => {
    const state = await loadState({ statePath });
    const details = createTenantWorkspaceInState(state, { name, domain, adminEmail, adminName, planId }, {
      action: 'tenants.register',
      registrationMode: 'self_service',
      usage: 'registration <workspaceName> <domain> <adminEmail> [adminName] [planId]',
    });
    const actor = getActor(state, details.adminUserId);
    appendAudit(state, 'tenants.register', details.targetId, details.message, actor);
    const saved = await saveState(state, { statePath });
    return {
      ok: true,
      action: 'tenants.register',
      actor,
      details,
      state: saved.state,
      summary: saved.summary,
    };
  });
}

function requireTenantOwnerOrAdminMember(state, actor, tenant, action) {
  const membership = activeMembershipForUser(state, actor.id, tenant.id);
  if (actor.id === tenant.ownerUserId || membership?.role === 'admin') {
    return membership ?? null;
  }
  throw new SignalStateError(`Workspace owner or tenant admin membership required for ${action}.`, {
    code: 'FORBIDDEN',
    status: 403,
    details: { action, actorUserId: actor.id, actorRole: actor.role, tenantId: tenant.id, requiredRole: 'tenant_admin_or_owner' },
  });
}

function tenantOnboardingCompletionEvidence(state, tenant) {
  const ownerUserId = tenant.ownerUserId;
  const owner = (state.users ?? []).find((user) => user.id === ownerUserId && user.tenantId === tenant.id && user.status === 'active') ?? null;
  const ownerMembership = owner ? activeMembershipForUser(state, owner.id, tenant.id) : null;
  const entitlement = (state.entitlements ?? []).find((candidate) => candidate.tenantId === tenant.id && candidate.status === 'active') ?? null;
  const connectedMailbox = (state.mailboxes ?? []).find((mailbox) => mailbox.tenantId === tenant.id && mailbox.status === 'connected') ?? null;
  const preference = owner ? (state.notificationPreferences ?? []).find((candidate) => candidate.userId === owner.id) ?? null : null;
  const billingSession = (state.billingSessions ?? []).find((session) => session.tenantId === tenant.id && session.type === 'checkout') ?? null;
  const requirements = [
    {
      id: 'owner_membership',
      ok: Boolean(owner && ownerMembership?.role === 'admin' && ownerMembership.status === 'active'),
      evidence: owner && ownerMembership ? `${owner.email} has ${ownerMembership.role}/${ownerMembership.status} membership` : 'Workspace owner membership is missing',
    },
    {
      id: 'billing_start',
      ok: Boolean(entitlement && billingSession),
      evidence: entitlement ? `Entitlement ${entitlement.status}; checkout ${billingSession?.status ?? 'missing'}` : 'Active entitlement is missing',
    },
    {
      id: 'mailbox_source',
      ok: Boolean(connectedMailbox),
      evidence: connectedMailbox ? `${connectedMailbox.provider} source ${connectedMailbox.id} is connected` : 'At least one Gmail or Outlook source must be connected',
    },
    {
      id: 'digest_preference',
      ok: Boolean(preference),
      evidence: preference ? `${preference.digestCadence} digest; delivery ${preference.emailDeliveryStatus ?? 'subscribed'}` : 'Owner digest preference is missing',
    },
  ];
  return {
    ok: requirements.every((requirement) => requirement.ok),
    missing: requirements.filter((requirement) => !requirement.ok).map((requirement) => requirement.id),
    requirements,
  };
}

export async function completeTenantOnboarding(tenantId, options = {}) {
  return mutateState(
    'tenants.onboarding-complete',
    (state, actor) => {
      const tenant = findById(state.tenants ?? [], requireArg(tenantId, 'tenant id', 'tenants complete-onboarding <tenantId>'), 'Tenant');
      requireTenantOwnerOrAdminMember(state, actor, tenant, 'tenants.onboarding-complete');
      const completion = tenantOnboardingCompletionEvidence(state, tenant);
      if (!completion.ok) {
        throw new SignalStateError(`Workspace onboarding is incomplete for ${tenant.id}.`, {
          code: 'ONBOARDING_INCOMPLETE',
          status: 409,
          details: { tenantId: tenant.id, missing: completion.missing, requirements: completion.requirements },
        });
      }
      const previousRegistrationStatus = tenant.registrationStatus ?? 'pending_onboarding';
      if (tenant.registrationStatus === 'active' && tenant.onboardingCompletedAt) {
        return {
          alreadyComplete: true,
          message: `${tenant.name} onboarding already completed`,
          missing: completion.missing,
          previousRegistrationStatus,
          registrationStatus: tenant.registrationStatus,
          requirements: completion.requirements,
          targetId: tenant.id,
          tenantId: tenant.id,
        };
      }
      tenant.registrationStatus = 'active';
      tenant.onboardingCompletedAt = nowIso();
      tenant.onboardingCompletedByUserId = actor.id;
      upsertNotificationEvent(state, {
        id: `ntf_workspace_completed_${tenant.id}`,
        tenantId: tenant.id,
        userId: tenant.ownerUserId,
        account: null,
        type: 'onboarding.workspace_completed',
        title: 'Workspace onboarding complete',
        body: 'Your workspace is ready for member invites, source monitoring, and routed sales signals.',
        status: 'unread',
        channel: 'dashboard_alert',
        mutedBy: null,
        signalId: null,
        sourceMessageId: null,
        accountActionId: null,
        createdAt: tenant.onboardingCompletedAt,
        readAt: null,
        digestRunId: null,
      });
      appendJob(state, {
        tenantId: tenant.id,
        queue: 'user_onboarding',
        type: 'tenants.onboarding.completed',
        targetId: tenant.id,
        status: 'succeeded',
        attempts: 1,
        maxAttempts: 3,
        message: `Completed onboarding for ${tenant.name}.`,
      });
      return {
        message: `${tenant.name} onboarding completed`,
        missing: completion.missing,
        previousRegistrationStatus,
        registrationStatus: tenant.registrationStatus,
        requirements: completion.requirements,
        targetId: tenant.id,
        tenantId: tenant.id,
      };
    },
    options,
  );
}

export async function setUserRole(userId, nextRole, options = {}) {
  return mutateState(
    'users.role',
    (state, actor) => {
      requireAdmin(actor, 'users.role');
      const role = requireOneOf(nextRole, ['admin', 'member'], 'role', 'users role <userId> <admin|member>');
      const user = findById(state.users, requireArg(userId, 'user id', 'users role <userId> <admin|member>'), 'User');
      const previousRole = user.role;
      user.role = role;
      const membership = membershipForUser(state, user.id, user.tenantId);
      if (membership) {
        membership.role = role;
        membership.updatedAt = nowIso();
        membership.updatedByUserId = actor.id;
      }
      return {
        message: `${user.email} is now ${role}`,
        membershipId: membership?.id ?? null,
        nextRole: role,
        previousRole,
        targetId: user.id,
        userId: user.id,
      };
    },
    options,
  );
}

export async function setUserStatus(userId, nextStatus, options = {}) {
  return mutateState(
    nextStatus === 'active' ? 'users.activate' : 'users.disable',
    (state, actor) => {
      requireAdmin(actor, nextStatus === 'active' ? 'users.activate' : 'users.disable');
      const status = requireOneOf(nextStatus, ['active', 'disabled'], 'status', 'users disable|activate <userId>');
      const user = findById(state.users, requireArg(userId, 'user id', 'users disable|activate <userId>'), 'User');
      const previousStatus = user.status;
      user.status = status;
      const membership = membershipForUser(state, user.id, user.tenantId);
      if (membership) {
        membership.status = status === 'active' ? 'active' : 'disabled';
        membership.updatedAt = nowIso();
        membership.updatedByUserId = actor.id;
        if (membership.status === 'disabled') {
          membership.disabledAt = membership.updatedAt;
          membership.disabledByUserId = actor.id;
        }
      }
      return {
        message: `${user.email} status is now ${status}`,
        membershipId: membership?.id ?? null,
        nextStatus: status,
        previousStatus,
        targetId: user.id,
        userId: user.id,
      };
    },
    options,
  );
}

export async function createUserInvite({ tenantId, email, role = 'member', team = 'sales' } = {}, options = {}) {
  return mutateState(
    'users.invite',
    (state, actor) => {
      requireAdmin(actor, 'users.invite');
      const tenant = findById(state.tenants ?? [], requireArg(tenantId, 'tenant id', 'users invite <tenantId> <email> [admin|member] [team]'), 'Tenant');
      const inviteEmail = normalizeEmail(email, 'users invite <tenantId> <email> [admin|member] [team]');
      const inviteRole = requireOneOf(role, ['admin', 'member'], 'role', 'users invite <tenantId> <email> [admin|member] [team]');
      const inviteTeam = team ?? null;
      if ((state.users ?? []).some((user) => user.tenantId === tenant.id && user.email.toLowerCase() === inviteEmail && user.status === 'active')) {
        throw new SignalStateError(`Active user already exists for ${inviteEmail}`, {
          code: 'USER_EXISTS',
          status: 409,
          details: { email: inviteEmail, tenantId: tenant.id },
        });
      }
      if ((state.invites ?? []).some((invite) => invite.tenantId === tenant.id && invite.email.toLowerCase() === inviteEmail && invite.status === 'pending')) {
        throw new SignalStateError(`Pending invite already exists for ${inviteEmail}`, {
          code: 'INVITE_EXISTS',
          status: 409,
          details: { email: inviteEmail, tenantId: tenant.id },
        });
      }
      requireSeatCapacityForInvite(state, tenant.id, 'users.invite');
      state.invites = state.invites ?? [];
      const invite = {
        id: makeId('inv'),
        tenantId: tenant.id,
        email: inviteEmail,
        role: inviteRole,
        team: inviteTeam,
        status: 'pending',
        claimCode: `local-${inviteEmail.replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
        invitedByUserId: actor.id,
        createdAt: nowIso(),
        expiresAt: expiresInIso(7 * 24 * 60 * 60 * 1000),
      };
      state.invites.push(invite);
      appendJob(state, {
        tenantId: tenant.id,
        queue: 'user_onboarding',
        type: 'users.invite',
        targetId: invite.id,
        status: 'succeeded',
        attempts: 1,
        maxAttempts: 3,
        message: `Prepared local invite for ${invite.email}.`,
      });
      return {
        message: `Invite ready for ${invite.email}`,
        inviteId: invite.id,
        claimCode: invite.claimCode,
        email: invite.email,
        role: invite.role,
        targetId: invite.id,
        team: invite.team,
        tenantId: tenant.id,
      };
    },
    options,
  );
}

export async function acceptUserInvite(inviteId, { name, team } = {}, options = {}) {
  return mutateState(
    'users.invite-accept',
    (state, actor) => {
      requireAdmin(actor, 'users.invite-accept');
      const invite = findById(state.invites ?? [], requireArg(inviteId, 'invite id', 'users accept <inviteId> [name]'), 'Invite');
      return acceptInviteInState(state, invite, { action: 'users.invite-accept', acceptedByUserId: actor.id, name, team });
    },
    options,
  );
}

function requireInviteClaimable(state, invite, action) {
  if (invite.status !== 'pending') {
    throw new SignalStateError(`Invite is not pending: ${invite.id}`, {
      code: 'INVITE_NOT_PENDING',
      status: 409,
      details: { inviteId: invite.id, status: invite.status },
    });
  }
  if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) {
    invite.status = 'expired';
    throw new SignalStateError(`Invite is expired: ${invite.id}`, {
      code: 'INVITE_EXPIRED',
      status: 410,
      details: { expiresAt: invite.expiresAt, inviteId: invite.id },
    });
  }
  requireSeatCapacityForAcceptance(state, invite.tenantId, action);
  if ((state.users ?? []).some((user) => user.tenantId === invite.tenantId && user.email.toLowerCase() === invite.email.toLowerCase() && user.status === 'active')) {
    throw new SignalStateError(`Active user already exists for ${invite.email}`, {
      code: 'USER_EXISTS',
      status: 409,
      details: { email: invite.email, tenantId: invite.tenantId },
    });
  }
}

function acceptInviteInState(state, invite, { acceptedByUserId, action, name, team }) {
  requireInviteClaimable(state, invite, action);
  const user = {
    id: userIdFromEmail(state, invite.email),
    tenantId: invite.tenantId,
    name: (name ? String(name).replaceAll('_', ' ') : displayNameFromEmail(invite.email)).trim(),
    email: invite.email,
    role: invite.role,
    ...(team ?? invite.team ? { team: team ?? invite.team } : {}),
    status: 'active',
  };
  state.users.push(user);
  state.memberships = state.memberships ?? [];
  const createdAt = nowIso();
  const membership = {
    id: membershipIdFor(invite.tenantId, user.id),
    tenantId: invite.tenantId,
    userId: user.id,
    role: user.role,
    ...(user.team ? { team: user.team } : {}),
    status: 'active',
    inviteId: invite.id,
    createdAt,
    createdByUserId: acceptedByUserId,
  };
  state.memberships.push(membership);
  invite.status = 'accepted';
  invite.acceptedAt = createdAt;
  invite.acceptedUserId = user.id;
  invite.acceptedByUserId = acceptedByUserId;
  if (invite.claimCode) {
    invite.claimCodeDigest = sha256Digest(invite.claimCode);
    invite.claimCode = `claimed-${invite.claimCodeDigest}`;
  }
  preferenceForUser(state, user.id);
  upsertNotificationEvent(state, {
    id: `ntf_onboarding_${user.id}`,
    tenantId: user.tenantId,
    userId: user.id,
    account: null,
    type: 'onboarding.invite_accepted',
    title: 'Finish mailbox onboarding',
    body: 'Connect a Gmail or Outlook source to start receiving account signals.',
    status: 'unread',
    channel: 'dashboard_alert',
    mutedBy: null,
    signalId: null,
    sourceMessageId: null,
    accountActionId: null,
    createdAt,
    readAt: null,
    digestRunId: null,
  });
  appendJob(state, {
    tenantId: invite.tenantId,
    queue: 'user_onboarding',
    type: 'users.invite.accepted',
    targetId: user.id,
    status: 'succeeded',
    attempts: 1,
    maxAttempts: 3,
    message: `Accepted local invite for ${user.email}.`,
  });
  return {
    message: `${user.email} joined ${invite.tenantId}`,
    inviteId: invite.id,
    membershipId: membership.id,
    targetId: user.id,
    userId: user.id,
  };
}

export async function claimUserInvite({ claimCode, email, name, team } = {}, { statePath } = {}) {
  const usage = 'users claim <claimCode> <email> [name] [team]';
  const code = requireArg(claimCode, 'claim code', usage).trim();
  const claimEmail = normalizeEmail(email, usage);
  const resolvedStatePath = resolveStatePath(statePath);
  return runLockedStateWriter(resolvedStatePath, async () => {
  const state = await loadState({ statePath });
  const invite = (state.invites ?? []).find((candidate) =>
    candidate.claimCode === code &&
    candidate.email.toLowerCase() === claimEmail);
  if (!invite) {
    throw new SignalStateError('Invite claim code and email do not match a pending local invite.', {
      code: 'INVITE_CLAIM_INVALID',
      status: 404,
      details: { email: claimEmail },
    });
  }
  const details = acceptInviteInState(state, invite, {
    acceptedByUserId: null,
    action: 'users.invite-claim',
    name,
    team,
  });
  const user = findById(state.users ?? [], details.userId, 'User');
  invite.acceptedByUserId = user.id;
  const membership = membershipForUser(state, user.id, user.tenantId);
  if (membership) {
    membership.createdByUserId = user.id;
  }
  state.session = {
    allowedRoles: ['admin', 'member'],
    localOnly: true,
    ...(state.session ?? {}),
    activeUserId: user.id,
  };
  appendAudit(state, 'users.invite-claim', details.targetId, `Claimed local invite for ${user.email}.`, user);
  const saved = await saveState(state, { statePath });
  return {
    ok: true,
    action: 'users.invite-claim',
    actor: user,
    details: {
      ...details,
      claimCodeDigest: sha256Digest(code),
      email: user.email,
      message: `Claimed local invite for ${user.email}.`,
    },
    state: saved.state,
    summary: saved.summary,
  };
  });
}

export async function revokeUserInvite(inviteId, options = {}) {
  return mutateState(
    'users.invite-revoke',
    (state, actor) => {
      requireAdmin(actor, 'users.invite-revoke');
      const invite = findById(state.invites ?? [], requireArg(inviteId, 'invite id', 'users revoke <inviteId>'), 'Invite');
      if (invite.status !== 'pending') {
        throw new SignalStateError(`Only pending invites can be revoked: ${invite.id}`, {
          code: 'INVITE_NOT_PENDING',
          status: 409,
          details: { inviteId: invite.id, status: invite.status },
        });
      }
      invite.status = 'revoked';
      invite.revokedAt = nowIso();
      invite.revokedByUserId = actor.id;
      return {
        message: `${invite.email} invite revoked`,
        inviteId: invite.id,
        targetId: invite.id,
      };
    },
    options,
  );
}

export async function setMailboxStatus(mailboxId, nextStatus, options = {}) {
  return mutateState(
    nextStatus === 'connected' ? 'mailboxes.resume' : 'mailboxes.pause',
    (state, actor) => {
      const action = nextStatus === 'connected' ? 'mailboxes.resume' : 'mailboxes.pause';
      const status = requireOneOf(nextStatus, ['connected', 'paused'], 'status', 'mailboxes pause|resume <mailboxId>');
      const mailbox = findById(state.mailboxes, requireArg(mailboxId, 'mailbox id', 'mailboxes pause|resume <mailboxId>'), 'Mailbox');
      requireAdminOrOwner(actor, mailbox.ownerUserId, action);
      requireActiveEntitlementForMember(state, actor, mailbox.tenantId, action);
      const previousStatus = mailbox.status;
      mailbox.status = status;
      return {
        mailboxId: mailbox.id,
        message: `${mailbox.id} is now ${status}`,
        nextStatus: status,
        previousStatus,
        targetId: mailbox.id,
      };
    },
    options,
  );
}

function completeMailboxConnectionInState(state, session, { callbackCodeDigest = null, oauthStateVerified = false, credentialRecord = null } = {}) {
  const tenant = findById(state.tenants, session.tenantId, 'Tenant');
  const owner = findById(state.users, session.ownerUserId, 'User');
  let mailbox = session.mailboxId ? state.mailboxes.find((candidate) => candidate.id === session.mailboxId) : null;
  if (!mailbox) {
    mailbox = {
      id: `mbx_${session.provider}_${owner.id}`,
      tenantId: tenant.id,
      ownerUserId: owner.id,
      provider: session.provider,
      status: 'connected',
      selectedScopes: session.selectedScopes ?? ['thread_metadata', 'selected_label_snippets'],
      syncPolicy: session.provider === 'gmail'
        ? { labels: ['Customers'], lookbackDays: 90, rawRetentionDays: 14 }
        : { folders: ['Customers'], lookbackDays: 60, rawRetentionDays: 7 },
    };
    state.mailboxes.push(mailbox);
    session.mailboxId = mailbox.id;
  }
  mailbox.status = 'connected';
  mailbox.ownerUserId = owner.id;
  mailbox.selectedScopes = session.selectedScopes ?? mailbox.selectedScopes;
  session.status = 'completed';
  session.completedAt = nowIso();
  if (callbackCodeDigest) {
    session.callbackCodeDigest = callbackCodeDigest;
    session.callbackReceivedAt = session.completedAt;
  }
  if (oauthStateVerified) {
    session.oauthStateStatus = 'verified';
  }
  if (credentialRecord) {
    session.credentialStatus = 'stored';
    session.credentialVaultRef = credentialRecord.id;
    session.credentialDigest = credentialRecord.digest;
    session.credentialExpiresAt = credentialRecord.expiresAt;
    session.credentialStoredAt = credentialRecord.storedAt;
    session.credentialScopeCount = credentialRecord.scopeCount;
    mailbox.credentialStatus = 'stored';
    mailbox.credentialVaultRef = credentialRecord.id;
    mailbox.credentialDigest = credentialRecord.digest;
    mailbox.credentialExpiresAt = credentialRecord.expiresAt;
    mailbox.credentialStoredAt = credentialRecord.storedAt;
  } else {
    session.credentialStatus = session.credentialStatus ?? 'local_only';
  }

  state.emailSyncCursors = state.emailSyncCursors ?? [];
  let cursor = state.emailSyncCursors.find((candidate) => candidate.mailboxId === mailbox.id);
  if (!cursor) {
    cursor = {
      id: `cur_${mailbox.id}`,
      mailboxId: mailbox.id,
      provider: mailbox.provider,
      status: 'active',
      cursor: `${mailbox.provider}-cursor-${Date.now()}`,
      lastSyncedAt: null,
      lastReplayAt: null,
      windowStartAt: new Date(Date.now() - mailbox.syncPolicy.lookbackDays * 24 * 60 * 60 * 1000).toISOString(),
    };
    state.emailSyncCursors.push(cursor);
  }
  cursor.status = 'active';
  cursor.cursor = `${mailbox.provider}-cursor-${Date.now()}`;
  cursor.lastSyncedAt = nowIso();

  appendJob(state, {
    tenantId: tenant.id,
    queue: 'email_sync',
    type: oauthStateVerified ? 'mailbox.oauth.callback.completed' : 'mailbox.oauth.completed',
    targetId: mailbox.id,
    status: 'succeeded',
    attempts: 1,
    maxAttempts: 3,
    message: oauthStateVerified
      ? `Completed verified ${mailbox.provider} OAuth callback for ${owner.email}.`
      : `Completed local ${mailbox.provider} connection for ${owner.email}.`,
  });

  return {
    mailboxId: mailbox.id,
    message: `${mailbox.provider} mailbox connected for ${owner.email}`,
    oauthStateStatus: session.oauthStateStatus ?? null,
    credentialStatus: session.credentialStatus ?? null,
    credentialVaultRef: session.credentialVaultRef ?? null,
    credentialExpiresAt: session.credentialExpiresAt ?? null,
    sessionId: session.id,
    targetId: mailbox.id,
    tenantId: tenant.id,
  };
}

export async function createMailboxConnectionSession({ tenantId, provider, ownerUserId, mailboxId } = {}, options = {}) {
  return mutateState(
    'mailboxes.connect-url',
    (state, actor) => {
      const tenant = findById(state.tenants, requireArg(tenantId, 'tenant id', 'mailboxes connect-url <tenantId> <gmail|outlook> <ownerUserId> [mailboxId]'), 'Tenant');
      const sourceProvider = requireOneOf(provider, ['gmail', 'outlook'], 'provider', 'mailboxes connect-url <tenantId> <gmail|outlook> <ownerUserId> [mailboxId]');
      const owner = findById(state.users, requireArg(ownerUserId, 'owner user id', 'mailboxes connect-url <tenantId> <gmail|outlook> <ownerUserId> [mailboxId]'), 'User');
      requireAdminOrOwner(actor, owner.id, 'mailboxes.connect-url');
      requireActiveEntitlementForMember(state, actor, tenant.id, 'mailboxes.connect-url');
      let mailbox = null;
      if (mailboxId) {
        mailbox = findById(state.mailboxes, mailboxId, 'Mailbox');
        requireAdminOrOwner(actor, mailbox.ownerUserId, 'mailboxes.connect-url');
        if (mailbox.ownerUserId !== owner.id || mailbox.tenantId !== tenant.id || mailbox.provider !== sourceProvider) {
          throw new SignalStateError(`Mailbox ${mailbox.id} does not match the requested owner, tenant, or provider.`, {
            code: 'MAILBOX_OWNER_MISMATCH',
            status: 409,
            details: { mailboxId: mailbox.id, ownerUserId: owner.id, provider: sourceProvider, tenantId: tenant.id },
          });
        }
      }
      state.mailboxConnectionSessions = state.mailboxConnectionSessions ?? [];
      const expiresAt = expiresInIso(60 * 60 * 1000);
      const sessionId = makeId('mcs');
      const selectedScopes = mailbox?.selectedScopes ?? ['thread_metadata', 'selected_label_snippets'];
      const oauthPayload = createOAuthStatePayload({
        expiresAt,
        mailboxId: mailbox?.id ?? null,
        ownerUserId: owner.id,
        provider: sourceProvider,
        sessionId,
        tenantId: tenant.id,
      });
      const oauthState = signOAuthState(oauthPayload);
      const redirectUri = providerRedirectUri(sourceProvider);
      const session = {
        id: sessionId,
        tenantId: tenant.id,
        mailboxId: mailbox?.id ?? null,
        provider: sourceProvider,
        ownerUserId: owner.id,
        status: 'ready',
        authorizationUrl: providerAuthorizationUrl({ provider: sourceProvider, oauthState, selectedScopes }),
        callbackPath: `/api/oauth/${sourceProvider}/callback`,
        localCallbackUrl: localOAuthCallbackUrl({ provider: sourceProvider, oauthState, code: `local_${sessionId}` }),
        oauthStateDigest: oauthStateDigest(oauthState),
        oauthStateStatus: 'issued',
        redirectUri,
        url: providerAuthorizationUrl({ provider: sourceProvider, oauthState, selectedScopes }),
        selectedScopes,
        createdAt: nowIso(),
        expiresAt,
      };
      state.mailboxConnectionSessions.push(session);
      appendJob(state, {
        tenantId: tenant.id,
        queue: 'email_sync',
        type: 'mailbox.oauth.prepare',
        targetId: session.id,
        status: 'succeeded',
        attempts: 1,
        maxAttempts: 3,
        message: `Prepared local ${sourceProvider} connection handoff for ${owner.email}.`,
      });
      return {
        authorizationUrl: session.authorizationUrl,
        callbackPath: session.callbackPath,
        localCallbackUrl: session.localCallbackUrl,
        message: `Local ${sourceProvider} connection URL ready for ${owner.email}`,
        oauthStateDigest: session.oauthStateDigest,
        oauthStateStatus: session.oauthStateStatus,
        redirectUri: session.redirectUri,
        sessionId: session.id,
        targetId: session.id,
        tenantId: tenant.id,
        url: session.url,
      };
    },
    options,
  );
}

export async function completeMailboxConnection(sessionId, options = {}) {
  return mutateState(
    'mailboxes.complete',
    (state, actor) => {
      const session = findById(state.mailboxConnectionSessions ?? [], requireArg(sessionId, 'session id', 'mailboxes complete <sessionId>'), 'Mailbox connection session');
      requireAdminOrOwner(actor, session.ownerUserId, 'mailboxes.complete');
      requireActiveEntitlementForMember(state, actor, session.tenantId, 'mailboxes.complete');
      if (session.status !== 'ready') {
        throw new SignalStateError(`Connection session is not ready: ${session.id}`, {
          code: 'SESSION_NOT_READY',
          status: 409,
          details: { sessionId: session.id, status: session.status },
        });
      }
      return completeMailboxConnectionInState(state, session);
    },
    options,
  );
}

function shouldExchangeOAuthCode(sourceProvider, callbackCode, { env = process.env, exchangeCredentials = true, forceCredentialExchange = false } = {}) {
  if (!exchangeCredentials) {
    return false;
  }
  if (forceCredentialExchange) {
    return true;
  }
  if (String(callbackCode).startsWith('local_')) {
    return false;
  }
  return isOAuthTokenExchangeConfigured(sourceProvider, env);
}

function signalErrorFromProviderError(error) {
  if (error instanceof OAuthProviderError || error instanceof TokenVaultError || error instanceof ProviderWatchError || error instanceof ProviderSyncError || error instanceof PaymentProviderError || error instanceof EmailProviderError || error instanceof SessionTokenError) {
    return new SignalStateError(error.message, {
      code: error.code,
      status: error.status,
      details: error.details,
    });
  }
  return error;
}

export async function completeMailboxConnectionFromOAuthCallback(provider, { code, state: oauthState, error, errorDescription } = {}, options = {}) {
  return mutateState(
    'mailboxes.oauth-callback',
    async (localState, actor) => {
      const sourceProvider = requireOneOf(provider, ['gmail', 'outlook'], 'provider', 'mailboxes oauth-callback <gmail|outlook> <code> <state>');
      if (error) {
        throw new SignalStateError(`OAuth provider returned an error: ${error}`, {
          code: 'OAUTH_PROVIDER_REJECTED',
          status: 400,
          details: { error, errorDescription: errorDescription ?? null, provider: sourceProvider },
        });
      }
      const callbackCode = requireArg(code, 'authorization code', 'mailboxes oauth-callback <gmail|outlook> <code> <state>');
      let payload;
      try {
        payload = verifyOAuthState(oauthState);
      } catch (verifyError) {
        if (verifyError instanceof OAuthProviderError) {
          throw new SignalStateError(verifyError.message, {
            code: verifyError.code,
            status: verifyError.status,
            details: verifyError.details,
          });
        }
        throw verifyError;
      }
      if (payload.provider !== sourceProvider) {
        throw new SignalStateError('OAuth state provider does not match callback provider.', {
          code: 'OAUTH_STATE_PROVIDER_MISMATCH',
          status: 400,
          details: { callbackProvider: sourceProvider, stateProvider: payload.provider },
        });
      }
      const session = findById(localState.mailboxConnectionSessions ?? [], payload.sessionId, 'Mailbox connection session');
      requireAdminOrOwner(actor, session.ownerUserId, 'mailboxes.oauth-callback');
      requireActiveEntitlementForMember(localState, actor, session.tenantId, 'mailboxes.oauth-callback');
      const expectedDigest = session.oauthStateDigest ?? null;
      const receivedDigest = oauthStateDigest(oauthState);
      if (!expectedDigest || expectedDigest !== receivedDigest) {
        throw new SignalStateError('OAuth callback state does not match the connection session.', {
          code: 'OAUTH_STATE_SESSION_MISMATCH',
          status: 401,
          details: { sessionId: session.id },
        });
      }
      if (session.status !== 'ready') {
        throw new SignalStateError(`Connection session is not ready: ${session.id}`, {
          code: 'SESSION_NOT_READY',
          status: 409,
          details: { sessionId: session.id, status: session.status },
        });
      }

      let credentialRecord = null;
      let credentialExchangeStatus = shouldExchangeOAuthCode(sourceProvider, callbackCode, options) ? 'pending' : 'skipped';
      if (credentialExchangeStatus === 'pending') {
        try {
          const exchange = await exchangeOAuthCodeForTokens({
            provider: sourceProvider,
            code: callbackCode,
            env: options.env ?? process.env,
            fetchImpl: options.fetchImpl ?? globalThis.fetch,
            redirectUri: session.redirectUri,
          });
          const scopes = provider === sourceProvider ? session.selectedScopes ?? [] : [];
          const placeholderMailboxId = session.mailboxId ?? `mbx_${session.provider}_${session.ownerUserId}`;
          credentialRecord = await storeProviderCredential({
            env: options.env ?? process.env,
            mailboxId: placeholderMailboxId,
            ownerUserId: session.ownerUserId,
            provider: sourceProvider,
            response: exchange.response,
            scopes,
            tenantId: session.tenantId,
            vaultPath: options.tokenVaultPath,
          });
          credentialExchangeStatus = 'stored';
        } catch (providerError) {
          throw signalErrorFromProviderError(providerError);
        }
      }

      const details = completeMailboxConnectionInState(localState, session, {
        callbackCodeDigest: sha256Digest(callbackCode),
        credentialRecord,
        oauthStateVerified: true,
      });
      if (credentialRecord && credentialRecord.id !== details.credentialVaultRef) {
        const mailbox = findById(localState.mailboxes, details.mailboxId, 'Mailbox');
        mailbox.credentialVaultRef = credentialRecord.id;
        session.credentialVaultRef = credentialRecord.id;
      }
      return {
        ...details,
        credentialExchangeStatus,
        message: `Verified ${sourceProvider} OAuth callback for ${details.mailboxId}`,
      };
    },
    { ...options, requireExplicitActor: true, retryOnConflict: false },
  );
}

export async function disconnectMailbox(mailboxId, options = {}) {
  return mutateState(
    'mailboxes.disconnect',
    (state, actor) => {
      const mailbox = findById(state.mailboxes, requireArg(mailboxId, 'mailbox id', 'mailboxes disconnect <mailboxId>'), 'Mailbox');
      requireAdminOrOwner(actor, mailbox.ownerUserId, 'mailboxes.disconnect');
      requireActiveEntitlementForMember(state, actor, mailbox.tenantId, 'mailboxes.disconnect');
      const previousStatus = mailbox.status;
      mailbox.status = 'disconnected';
      const cursor = state.emailSyncCursors?.find((candidate) => candidate.mailboxId === mailbox.id);
      if (cursor) {
        cursor.status = 'blocked';
      }
      appendJob(state, {
        tenantId: mailbox.tenantId,
        queue: 'email_sync',
        type: 'mailbox.disconnect',
        targetId: mailbox.id,
        status: 'succeeded',
        attempts: 1,
        maxAttempts: 3,
        message: `Disconnected ${mailbox.provider} source without storing provider tokens.`,
      });
      return {
        mailboxId: mailbox.id,
        message: `${mailbox.id} disconnected`,
        previousStatus,
        targetId: mailbox.id,
      };
    },
    options,
  );
}

export async function syncMailbox(mailboxId, options = {}) {
  return mutateState(
    'mailboxes.sync',
    async (state, actor) => {
      const mailbox = findById(state.mailboxes, requireArg(mailboxId, 'mailbox id', 'mailboxes sync <mailboxId>'), 'Mailbox');
      requireAdminOrOwner(actor, mailbox.ownerUserId, 'mailboxes.sync');
      requireActiveEntitlementForMember(state, actor, mailbox.tenantId, 'mailboxes.sync');
      if (mailbox.status !== 'connected') {
        throw new SignalStateError(`Mailbox must be connected before sync: ${mailbox.id}`, {
          code: 'MAILBOX_NOT_CONNECTED',
          status: 409,
          details: { mailboxId: mailbox.id, status: mailbox.status },
        });
      }
      const job = appendJob(state, {
        tenantId: mailbox.tenantId,
        queue: 'email_sync',
        type: 'mailbox.sync',
        targetId: mailbox.id,
        status: 'running',
        attempts: 1,
        maxAttempts: 3,
        message: `Running ${mailbox.provider} source sync for ${sourceTargetsForMailbox(mailbox).join(', ') || 'default source set'}.`,
      });
      const sync = await applyProviderSyncAttempt(state, mailbox, job, options);
      job.status = sync.active ? 'succeeded' : sync.status;
      job.lastRunAt = nowIso();
      job.message = sync.active
        ? `Synced ${mailbox.provider} source targets and upserted ${sync.sourceMessagesUpserted} source message${sync.sourceMessagesUpserted === 1 ? '' : 's'}.`
        : `${mailbox.provider} source sync deferred by provider backoff.`;
      job.providerCredentialRefreshedAt = sync.providerCredentialRefreshedAt;
      job.providerCredentialSource = sync.providerCredentialSource;
      job.providerCredentialVaultRef = sync.providerCredentialVaultRef;
      job.providerRequestDigest = sync.providerRequestDigest;
      job.providerResponseDigest = sync.providerResponseDigest;
      job.providerResponseStatus = sync.providerResponseStatus;
      job.providerRetryAfterAt = sync.providerRetryAfterAt;
      job.sourceMessagesCreated = sync.sourceMessagesCreated;
      job.sourceMessagesUpdated = sync.sourceMessagesUpdated;
      job.sourceMessagesUpserted = sync.sourceMessagesUpserted;
      return {
        cursorId: sync.cursor.id,
        jobId: job.id,
        mailboxId: mailbox.id,
        message: sync.active
          ? `${mailbox.id} synced from ${sync.mode} provider cursor`
          : `${mailbox.id} sync deferred by provider backoff`,
        providerRequestDigest: sync.providerRequestDigest,
        providerResponseDigest: sync.providerResponseDigest,
        sourceMessagesUpserted: sync.sourceMessagesUpserted,
        targetId: mailbox.id,
      };
    },
    { ...options, retryOnConflict: false },
  );
}

export async function replayMailbox(mailboxId, options = {}) {
  return mutateState(
    'mailboxes.replay',
    async (state, actor) => {
      requireAdmin(actor, 'mailboxes.replay');
      const mailbox = findById(state.mailboxes, requireArg(mailboxId, 'mailbox id', 'mailboxes replay <mailboxId>'), 'Mailbox');
      if (mailbox.status !== 'connected') {
        throw new SignalStateError(`Mailbox must be connected before replay: ${mailbox.id}`, {
          code: 'MAILBOX_NOT_CONNECTED',
          status: 409,
          details: { mailboxId: mailbox.id, status: mailbox.status },
        });
      }
      const job = appendJob(state, {
        tenantId: mailbox.tenantId,
        queue: 'email_sync',
        type: 'mailbox.replay',
        targetId: mailbox.id,
        status: 'running',
        attempts: 1,
        maxAttempts: 3,
        message: `Running ${mailbox.provider} replay from retained cursor window.`,
      });
      const sync = await applyProviderSyncAttempt(state, mailbox, job, options);
      job.status = sync.active ? 'succeeded' : sync.status;
      job.lastRunAt = nowIso();
      job.message = sync.active
        ? `Replayed ${mailbox.provider} source and upserted ${sync.sourceMessagesUpserted} source message${sync.sourceMessagesUpserted === 1 ? '' : 's'}.`
        : `${mailbox.provider} source replay deferred by provider backoff.`;
      job.providerCredentialRefreshedAt = sync.providerCredentialRefreshedAt;
      job.providerCredentialSource = sync.providerCredentialSource;
      job.providerCredentialVaultRef = sync.providerCredentialVaultRef;
      job.providerRequestDigest = sync.providerRequestDigest;
      job.providerResponseDigest = sync.providerResponseDigest;
      job.providerResponseStatus = sync.providerResponseStatus;
      job.providerRetryAfterAt = sync.providerRetryAfterAt;
      job.sourceMessagesCreated = sync.sourceMessagesCreated;
      job.sourceMessagesUpdated = sync.sourceMessagesUpdated;
      job.sourceMessagesUpserted = sync.sourceMessagesUpserted;
      return {
        cursorId: sync.cursor.id,
        jobId: job.id,
        mailboxId: mailbox.id,
        message: sync.active
          ? `${mailbox.id} replayed from ${sync.mode} provider cursor window`
          : `${mailbox.id} replay deferred by provider backoff`,
        providerRequestDigest: sync.providerRequestDigest,
        providerResponseDigest: sync.providerResponseDigest,
        sourceMessagesUpserted: sync.sourceMessagesUpserted,
        targetId: mailbox.id,
      };
    },
    { ...options, retryOnConflict: false },
  );
}

function nextWatchRenewalAt(expirationAt) {
  const expiresMs = Date.parse(expirationAt);
  if (!Number.isFinite(expiresMs)) {
    return null;
  }
  return new Date(expiresMs - 6 * 60 * 60 * 1000).toISOString();
}

function providerWebhookUrl(provider, env = process.env) {
  const apiBaseUrl = env.SIGNAL_API_BASE_URL ?? 'http://127.0.0.1:8787';
  if (provider === 'gmail') {
    return env.SIGNAL_GMAIL_NOTIFICATION_URL ?? `${apiBaseUrl}/api/webhooks/gmail`;
  }
  return env.SIGNAL_OUTLOOK_NOTIFICATION_URL ?? `${apiBaseUrl}/api/webhooks/outlook`;
}

async function providerWatchCredential(mailbox, { env = process.env, fetchImpl = globalThis.fetch, providerAccessToken, tokenVaultPath } = {}) {
  if (providerAccessToken) {
    return {
      accessToken: providerAccessToken,
      source: 'option',
      vaultRef: null,
    };
  }
  const envToken = mailbox.provider === 'gmail'
    ? env.SIGNAL_GMAIL_ACCESS_TOKEN ?? env.SIGNAL_PROVIDER_ACCESS_TOKEN
    : env.SIGNAL_OUTLOOK_ACCESS_TOKEN ?? env.SIGNAL_PROVIDER_ACCESS_TOKEN;
  if (envToken) {
    return {
      accessToken: envToken,
      source: 'env',
      vaultRef: null,
    };
  }
  if (mailbox.credentialVaultRef) {
    const credential = await loadProviderCredential({
      credentialVaultRef: mailbox.credentialVaultRef,
      env,
      fetchImpl,
      mailboxId: mailbox.id,
      provider: mailbox.provider,
      refreshExpired: true,
      vaultPath: tokenVaultPath,
    });
    return {
      accessToken: credential.accessToken,
      digest: credential.digest,
      expiresAt: credential.expiresAt,
      refreshedAt: credential.refreshedAt,
      source: 'vault',
      vaultRef: credential.id,
    };
  }
  return {
    accessToken: null,
    source: 'missing',
    vaultRef: null,
  };
}

function syncProviderCredentialMetadata(state, mailbox, credential) {
  if (credential?.source !== 'vault' || !credential.vaultRef) {
    return;
  }
  mailbox.credentialStatus = 'stored';
  mailbox.credentialVaultRef = credential.vaultRef;
  mailbox.credentialDigest = credential.digest ?? mailbox.credentialDigest;
  mailbox.credentialExpiresAt = credential.expiresAt ?? mailbox.credentialExpiresAt ?? null;
  mailbox.credentialStoredAt = credential.refreshedAt ?? mailbox.credentialStoredAt ?? null;
  (state.mailboxConnectionSessions ?? [])
    .filter((session) => session.mailboxId === mailbox.id || session.credentialVaultRef === credential.vaultRef)
    .forEach((session) => {
      session.credentialStatus = 'stored';
      session.credentialVaultRef = credential.vaultRef;
      session.credentialDigest = credential.digest ?? session.credentialDigest;
      session.credentialExpiresAt = credential.expiresAt ?? session.credentialExpiresAt ?? null;
      session.credentialStoredAt = credential.refreshedAt ?? session.credentialStoredAt ?? null;
    });
}

function providerWatchRetryAfterAt(details = {}) {
  if (typeof details.retryAfterAt === 'string' && Number.isFinite(Date.parse(details.retryAfterAt))) {
    return details.retryAfterAt;
  }
  const responseStatus = Number(details.responseStatus);
  if (details.rateLimited || responseStatus === 429) {
    return expiresInIso(60 * 1000);
  }
  if (responseStatus >= 500) {
    return expiresInIso(5 * 60 * 1000);
  }
  return null;
}

function providerWatchFailureCode(error, details = {}) {
  return String(details.providerErrorCode ?? details.providerErrorStatus ?? error.code ?? 'PROVIDER_WATCH_SETUP_FAILED');
}

function providerWatchBackoffReason(error, operation, details = {}) {
  const statusLabel = details.responseStatus ? `HTTP ${details.responseStatus}` : error.code;
  const providerCode = providerWatchFailureCode(error, details);
  const providerMessage = details.providerError ? `: ${details.providerError}` : '';
  return `${operation} ${statusLabel} ${providerCode}${providerMessage}`.slice(0, 240);
}

function shouldPersistProviderWatchFailure(error) {
  return error instanceof ProviderWatchError && Number.isFinite(Number(error.details?.responseStatus));
}

function ensureEmailSyncCursor(state, mailbox) {
  state.emailSyncCursors = state.emailSyncCursors ?? [];
  let cursor = state.emailSyncCursors.find((candidate) => candidate.mailboxId === mailbox.id);
  if (!cursor) {
    cursor = {
      id: `cur_${mailbox.id}`,
      mailboxId: mailbox.id,
      provider: mailbox.provider,
      status: 'active',
      cursor: `${mailbox.provider}-worker-${Date.now()}`,
      lastSyncedAt: null,
      lastReplayAt: null,
      windowStartAt: new Date(Date.now() - (mailbox.syncPolicy?.lookbackDays ?? 14) * 24 * 60 * 60 * 1000).toISOString(),
    };
    state.emailSyncCursors.push(cursor);
  }
  return cursor;
}

function clearCursorProviderBackoff(cursor) {
  if (!cursor) {
    return;
  }
  cursor.providerBackoffReason = null;
  cursor.providerBackoffUntil = null;
  cursor.providerLastErrorAt = null;
  cursor.providerResponseStatus = null;
}

function markCursorProviderBackoff(state, mailbox, { reason, responseStatus, retryAfterAt }) {
  const cursor = ensureEmailSyncCursor(state, mailbox);
  cursor.status = 'blocked';
  cursor.providerBackoffReason = reason;
  cursor.providerBackoffUntil = retryAfterAt;
  cursor.providerLastErrorAt = nowIso();
  cursor.providerResponseStatus = responseStatus ?? null;
  return cursor;
}

function providerSyncRetryAfterAt(details = {}) {
  if (typeof details.retryAfterAt === 'string' && Number.isFinite(Date.parse(details.retryAfterAt))) {
    return details.retryAfterAt;
  }
  const responseStatus = Number(details.responseStatus);
  if (details.rateLimited || responseStatus === 429) {
    return expiresInIso(60 * 1000);
  }
  if (responseStatus >= 500) {
    return expiresInIso(5 * 60 * 1000);
  }
  return null;
}

function providerSyncBackoffReason(error, operation, details = {}) {
  const statusLabel = details.responseStatus ? `HTTP ${details.responseStatus}` : error.code;
  const providerCode = details.providerErrorCode ?? details.providerErrorStatus ?? error.code ?? 'PROVIDER_SYNC_FAILED';
  const providerMessage = details.providerError ? `: ${details.providerError}` : '';
  return `${operation} ${statusLabel} ${providerCode}${providerMessage}`.slice(0, 240);
}

function shouldPersistProviderSyncFailure(error) {
  return error instanceof ProviderSyncError && Number.isFinite(Number(error.details?.responseStatus));
}

function sourceMessageIdentity(message) {
  return `${message.mailboxId}:${message.providerMessageId ?? message.id}`;
}

function upsertProviderSourceMessages(state, mailbox, messages = []) {
  state.sourceMessages = state.sourceMessages ?? defaultSourceMessages(state);
  const byIdentity = new Map(state.sourceMessages.map((message) => [sourceMessageIdentity(message), message]));
  let created = 0;
  let updated = 0;

  messages.forEach((message) => {
    const existing = byIdentity.get(sourceMessageIdentity(message))
      ?? state.sourceMessages.find((candidate) => candidate.id === message.id);
    if (existing) {
      Object.assign(existing, {
        account: message.account,
        from: message.from,
        ingestedAt: message.ingestedAt,
        labels: message.labels ?? existing.labels ?? [],
        providerCursor: message.providerCursor,
        providerMessageId: message.providerMessageId,
        providerRequestDigest: message.providerRequestDigest,
        providerResponseDigest: message.providerResponseDigest,
        providerSyncMode: message.providerSyncMode,
        providerThreadId: message.providerThreadId,
        rawRetentionExpiresAt: message.rawRetentionExpiresAt,
        receivedAt: message.receivedAt,
        snippet: message.snippet,
        subject: message.subject,
      });
      existing.processedFlowIds = existing.processedFlowIds ?? [];
      updated += 1;
      byIdentity.set(sourceMessageIdentity(existing), existing);
      return;
    }

    const nextMessage = {
      ...message,
      tenantId: message.tenantId ?? mailbox.tenantId,
      mailboxId: mailbox.id,
      processedFlowIds: message.processedFlowIds ?? [],
    };
    state.sourceMessages.push(nextMessage);
    byIdentity.set(sourceMessageIdentity(nextMessage), nextMessage);
    created += 1;
  });

  return {
    created,
    total: messages.length,
    updated,
    upserted: created + updated,
  };
}

function recordProviderSyncFailure(state, mailbox, error, operation, credential = null) {
  const details = error.details ?? {};
  const retryAfterAt = providerSyncRetryAfterAt(details);
  const responseStatus = Number.isFinite(Number(details.responseStatus)) ? Number(details.responseStatus) : null;
  const reason = providerSyncBackoffReason(error, operation, details);
  const cursor = markCursorProviderBackoff(state, mailbox, { reason, responseStatus, retryAfterAt });
  cursor.providerRequestDigest = details.requestDigest ?? cursor.providerRequestDigest ?? null;
  cursor.providerSyncMode = 'live';
  cursor.lastProviderErrorAt = nowIso();
  cursor.providerCredentialRefreshedAt = credential?.refreshedAt ?? cursor.providerCredentialRefreshedAt ?? null;
  cursor.providerCredentialSource = credential?.source ?? cursor.providerCredentialSource ?? null;
  cursor.providerCredentialVaultRef = credential?.vaultRef ?? cursor.providerCredentialVaultRef ?? null;
  return {
    cursor,
    nextRunAt: retryAfterAt,
    providerCredentialRefreshedAt: cursor.providerCredentialRefreshedAt,
    providerCredentialSource: cursor.providerCredentialSource,
    providerCredentialVaultRef: cursor.providerCredentialVaultRef,
    providerErrorCode: details.providerErrorCode ?? details.providerErrorStatus ?? error.code,
    providerResponseStatus: responseStatus,
    providerRetryAfterAt: retryAfterAt,
    status: retryAfterAt ? 'queued' : 'failed',
  };
}

async function applyProviderSyncAttempt(state, mailbox, job, options = {}) {
  const cursor = ensureEmailSyncCursor(state, mailbox);
  const syncMode = job.type === 'mailbox.replay' ? 'replay' : 'delta';
  const operation = syncMode === 'replay' ? 'replay' : 'sync';
  const credential = options.liveProviderSync
    ? await providerWatchCredential(mailbox, { ...options, env: options.env ?? process.env })
    : { accessToken: null, source: 'local', vaultRef: null };

  let providerResult;
  try {
    syncProviderCredentialMetadata(state, mailbox, credential);
    providerResult = await fetchProviderSync({
      accessToken: credential.accessToken,
      cursor,
      env: options.env ?? process.env,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      live: Boolean(options.liveProviderSync),
      mailbox,
      mode: syncMode,
    });
  } catch (syncError) {
    if (!shouldPersistProviderSyncFailure(syncError)) {
      throw signalErrorFromProviderError(syncError);
    }
    return {
      active: false,
      ...recordProviderSyncFailure(state, mailbox, syncError, operation, credential),
    };
  }

  const normalized = normalizeProviderSyncResult({ mailbox, result: providerResult });
  const upsert = upsertProviderSourceMessages(state, mailbox, normalized.messages);
  cursor.status = 'active';
  clearCursorProviderBackoff(cursor);
  cursor.cursor = normalized.nextCursor ?? cursor.cursor;
  cursor.providerDeltaLink = normalized.providerDeltaLink;
  cursor.providerRequestDigest = normalized.providerRequestDigest;
  cursor.providerResponseDigest = normalized.providerResponseDigest;
  cursor.providerSyncMode = normalized.mode;
  cursor.lastProviderSyncAt = nowIso();
  cursor.lastProviderMessageCount = normalized.providerMessageCount;
  cursor.lastUpsertedSourceMessages = upsert.upserted;
  cursor.providerCredentialRefreshedAt = credential.refreshedAt ?? cursor.providerCredentialRefreshedAt ?? null;
  cursor.providerCredentialSource = credential.source;
  cursor.providerCredentialVaultRef = credential.vaultRef;
  if (syncMode === 'replay') {
    cursor.lastReplayAt = nowIso();
    cursor.lastProviderReplayAt = cursor.lastReplayAt;
  } else {
    cursor.lastSyncedAt = nowIso();
  }

  return {
    active: true,
    cursor,
    mode: normalized.mode,
    providerCredentialRefreshedAt: credential.refreshedAt,
    providerCredentialSource: credential.source,
    providerCredentialVaultRef: credential.vaultRef,
    providerMessageCount: normalized.providerMessageCount,
    providerRequestDigest: normalized.providerRequestDigest,
    providerResponseDigest: normalized.providerResponseDigest,
    sourceMessagesCreated: upsert.created,
    sourceMessagesUpdated: upsert.updated,
    sourceMessagesUpserted: upsert.upserted,
  };
}

function upsertWatchSubscription(state, mailbox, watchDetails, { existingWatchId = null } = {}) {
  state.emailWatchSubscriptions = state.emailWatchSubscriptions ?? [];
  let watch = existingWatchId
    ? state.emailWatchSubscriptions.find((candidate) => candidate.id === existingWatchId)
    : state.emailWatchSubscriptions.find((candidate) => candidate.mailboxId === mailbox.id && candidate.status === 'active');
  if (!watch) {
    watch = {
      id: `watch_${mailbox.provider}_${mailbox.id}`,
      tenantId: mailbox.tenantId,
      mailboxId: mailbox.id,
      provider: mailbox.provider,
      createdAt: nowIso(),
      renewalCount: 0,
    };
    state.emailWatchSubscriptions.push(watch);
  } else if (existingWatchId) {
    watch.renewalCount = (watch.renewalCount ?? 0) + 1;
  }

  Object.assign(watch, {
    clientStateDigest: watchDetails.clientStateDigest,
    expirationAt: watchDetails.expirationAt,
    historyId: watchDetails.historyId,
    notificationUrl: watchDetails.notificationUrl,
    providerWatchId: watchDetails.providerWatchId,
    resource: watchDetails.resource,
    setupAt: watchDetails.setupAt,
    setupMode: watchDetails.setupMode,
    setupRequestDigest: watchDetails.setupRequestDigest,
    status: watchDetails.status,
    topicName: watchDetails.topicName,
    nextRenewalAt: nextWatchRenewalAt(watchDetails.expirationAt),
    providerBackoffReason: null,
    providerLastError: null,
    providerLastErrorAt: null,
    providerLastErrorCode: null,
    providerResponseStatus: null,
    providerRetryAfterAt: null,
    updatedAt: nowIso(),
  });
  return watch;
}

function recordProviderWatchFailure(state, mailbox, error, { clientState = null, credential = null, env = process.env, existingWatchId = null, operation = 'setup' } = {}) {
  const details = error.details ?? {};
  const retryAfterAt = providerWatchRetryAfterAt(details);
  const reason = providerWatchBackoffReason(error, operation, details);
  const responseStatus = Number.isFinite(Number(details.responseStatus)) ? Number(details.responseStatus) : null;
  const existingWatch = existingWatchId
    ? (state.emailWatchSubscriptions ?? []).find((candidate) => candidate.id === existingWatchId)
    : [...(state.emailWatchSubscriptions ?? [])].reverse().find((candidate) => candidate.mailboxId === mailbox.id);
  state.emailWatchSubscriptions = state.emailWatchSubscriptions ?? [];
  const watch = existingWatch ?? {
    id: `watch_${mailbox.provider}_${mailbox.id}`,
    tenantId: mailbox.tenantId,
    mailboxId: mailbox.id,
    provider: mailbox.provider,
    createdAt: nowIso(),
    renewalCount: 0,
  };
  if (!existingWatch) {
    state.emailWatchSubscriptions.push(watch);
  }

  Object.assign(watch, {
    clientStateDigest: clientState ? digestClientState(clientState) : watch.clientStateDigest ?? null,
    expirationAt: watch.expirationAt ?? retryAfterAt ?? nowIso(),
    historyId: watch.historyId ?? null,
    notificationUrl: details.notificationUrl ?? watch.notificationUrl ?? providerWebhookUrl(mailbox.provider, env),
    providerWatchId: watch.providerWatchId ?? null,
    resource: watch.resource ?? null,
    setupAt: watch.setupAt ?? nowIso(),
    setupMode: 'live',
    setupRequestDigest: details.requestDigest ?? watch.setupRequestDigest ?? null,
    status: retryAfterAt ? 'paused' : 'failed',
    topicName: watch.topicName ?? null,
    nextRenewalAt: retryAfterAt,
    providerBackoffReason: reason,
    providerCredentialRefreshedAt: credential?.refreshedAt ?? watch.providerCredentialRefreshedAt ?? null,
    providerCredentialSource: credential?.source ?? watch.providerCredentialSource ?? null,
    providerCredentialVaultRef: credential?.vaultRef ?? watch.providerCredentialVaultRef ?? null,
    providerLastError: details.providerError ?? error.message,
    providerLastErrorAt: nowIso(),
    providerLastErrorCode: providerWatchFailureCode(error, details),
    providerResponseStatus: responseStatus,
    providerRetryAfterAt: retryAfterAt,
    updatedAt: nowIso(),
  });

  const cursor = markCursorProviderBackoff(state, mailbox, { reason, responseStatus, retryAfterAt });
  return {
    cursor,
    providerErrorCode: watch.providerLastErrorCode,
    providerCredentialRefreshedAt: watch.providerCredentialRefreshedAt,
    providerCredentialSource: watch.providerCredentialSource,
    providerCredentialVaultRef: watch.providerCredentialVaultRef,
    providerResponseStatus: responseStatus,
    providerRetryAfterAt: retryAfterAt,
    reason,
    status: watch.status,
    watch,
  };
}

async function applyProviderWatchAttempt(state, mailbox, options = {}, { existingWatchId = null, operation = 'setup' } = {}) {
  const clientState = mailbox.provider === 'outlook'
    ? createProviderWatchSecret(mailbox.provider, mailbox.id, { local: !options.liveProviderWatch })
    : null;
  const credential = options.liveProviderWatch
    ? await providerWatchCredential(mailbox, { ...options, env: options.env ?? process.env })
    : { accessToken: null, source: 'local', vaultRef: null };
  let watchResult;
  try {
    syncProviderCredentialMetadata(state, mailbox, credential);
    watchResult = await createProviderWatch({
      accessToken: credential.accessToken,
      clientState,
      env: options.env ?? process.env,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      live: Boolean(options.liveProviderWatch),
      mailbox,
    });
  } catch (watchError) {
    if (!shouldPersistProviderWatchFailure(watchError)) {
      throw signalErrorFromProviderError(watchError);
    }
    const failure = recordProviderWatchFailure(state, mailbox, watchError, {
      clientState,
      credential,
      env: options.env ?? process.env,
      existingWatchId,
      operation,
    });
    return {
      active: false,
      ...failure,
    };
  }

  const watch = upsertWatchSubscription(state, mailbox, normalizeProviderWatchResult({ clientState, mailbox, result: watchResult }), { existingWatchId });
  watch.providerCredentialRefreshedAt = credential.refreshedAt;
  watch.providerCredentialSource = credential.source;
  watch.providerCredentialVaultRef = credential.vaultRef;
  const cursor = state.emailSyncCursors?.find((candidate) => candidate.mailboxId === mailbox.id);
  if (cursor) {
    cursor.status = 'active';
    clearCursorProviderBackoff(cursor);
    if (watch.historyId) {
      cursor.cursor = `${mailbox.provider}-history-${watch.historyId}`;
    }
  }
  return {
    active: true,
    providerCredentialRefreshedAt: credential.refreshedAt,
    providerCredentialSource: credential.source,
    providerCredentialVaultRef: credential.vaultRef,
    cursor,
    watch,
  };
}

export async function setupMailboxWatch(mailboxId, options = {}) {
  return mutateState(
    'mailboxes.watch',
    async (state, actor) => {
      requireAdmin(actor, 'mailboxes.watch');
      const mailbox = findById(state.mailboxes, requireArg(mailboxId, 'mailbox id', 'mailboxes watch <mailboxId>'), 'Mailbox');
      if (mailbox.status !== 'connected') {
        throw new SignalStateError(`Mailbox must be connected before watch setup: ${mailbox.id}`, {
          code: 'MAILBOX_NOT_CONNECTED',
          status: 409,
          details: { mailboxId: mailbox.id, status: mailbox.status },
        });
      }
      const attempt = await applyProviderWatchAttempt(state, mailbox, options, { operation: 'setup' });
      const watch = attempt.watch;
      appendJob(state, {
        tenantId: mailbox.tenantId,
        queue: 'email_sync',
        type: 'mailbox.watch.setup',
        targetId: mailbox.id,
        status: attempt.active ? 'succeeded' : (attempt.providerRetryAfterAt ? 'queued' : 'failed'),
        attempts: 1,
        maxAttempts: 5,
        message: attempt.active
          ? `Prepared ${watch.setupMode} ${mailbox.provider} watch for ${mailbox.id}.`
          : `${mailbox.provider} watch setup ${attempt.status}; ${attempt.reason}.`,
        nextRunAt: attempt.active ? undefined : attempt.providerRetryAfterAt,
        providerCredentialRefreshedAt: attempt.providerCredentialRefreshedAt,
        providerCredentialSource: attempt.providerCredentialSource,
        providerCredentialVaultRef: attempt.providerCredentialVaultRef,
        providerErrorCode: attempt.active ? undefined : attempt.providerErrorCode,
        providerResponseStatus: attempt.active ? undefined : attempt.providerResponseStatus,
        providerRetryAfterAt: attempt.active ? undefined : attempt.providerRetryAfterAt,
      });
      return {
        expirationAt: watch.expirationAt,
        mailboxId: mailbox.id,
        message: attempt.active
          ? `${mailbox.provider} watch active for ${mailbox.id}`
          : `${mailbox.provider} watch ${attempt.status} for ${mailbox.id}; ${attempt.reason}`,
        mode: watch.setupMode,
        nextRenewalAt: watch.nextRenewalAt,
        providerCredentialRefreshedAt: attempt.providerCredentialRefreshedAt ?? null,
        providerCredentialSource: attempt.providerCredentialSource ?? null,
        providerCredentialVaultRef: attempt.providerCredentialVaultRef ?? null,
        providerResponseStatus: attempt.providerResponseStatus ?? null,
        providerRetryAfterAt: attempt.providerRetryAfterAt ?? null,
        providerWatchId: watch.providerWatchId,
        status: watch.status,
        targetId: mailbox.id,
        watchId: watch.id,
      };
    },
    { ...options, retryOnConflict: false },
  );
}

export async function renewMailboxWatch(watchId, options = {}) {
  return mutateState(
    'mailboxes.watch-renew',
    async (state, actor) => {
      requireAdmin(actor, 'mailboxes.watch-renew');
      const existingWatch = findById(state.emailWatchSubscriptions ?? [], requireArg(watchId, 'watch id', 'mailboxes renew-watch <watchId>'), 'Provider watch');
      const mailbox = findById(state.mailboxes, existingWatch.mailboxId, 'Mailbox');
      if (mailbox.status !== 'connected') {
        throw new SignalStateError(`Mailbox must be connected before watch renewal: ${mailbox.id}`, {
          code: 'MAILBOX_NOT_CONNECTED',
          status: 409,
          details: { mailboxId: mailbox.id, status: mailbox.status },
        });
      }
      const attempt = await applyProviderWatchAttempt(state, mailbox, options, { existingWatchId: existingWatch.id, operation: 'renewal' });
      const watch = attempt.watch;
      appendJob(state, {
        tenantId: mailbox.tenantId,
        queue: 'email_sync',
        type: 'mailbox.watch.renew',
        targetId: mailbox.id,
        status: attempt.active ? 'succeeded' : (attempt.providerRetryAfterAt ? 'queued' : 'failed'),
        attempts: 1,
        maxAttempts: 5,
        message: attempt.active
          ? `Renewed ${watch.setupMode} ${mailbox.provider} watch for ${mailbox.id}.`
          : `${mailbox.provider} watch renewal ${attempt.status}; ${attempt.reason}.`,
        nextRunAt: attempt.active ? undefined : attempt.providerRetryAfterAt,
        providerCredentialRefreshedAt: attempt.providerCredentialRefreshedAt,
        providerCredentialSource: attempt.providerCredentialSource,
        providerCredentialVaultRef: attempt.providerCredentialVaultRef,
        providerErrorCode: attempt.active ? undefined : attempt.providerErrorCode,
        providerResponseStatus: attempt.active ? undefined : attempt.providerResponseStatus,
        providerRetryAfterAt: attempt.active ? undefined : attempt.providerRetryAfterAt,
      });
      return {
        expirationAt: watch.expirationAt,
        mailboxId: mailbox.id,
        message: attempt.active
          ? `${mailbox.provider} watch renewed for ${mailbox.id}`
          : `${mailbox.provider} watch ${attempt.status} for ${mailbox.id}; ${attempt.reason}`,
        mode: watch.setupMode,
        nextRenewalAt: watch.nextRenewalAt,
        providerCredentialRefreshedAt: attempt.providerCredentialRefreshedAt ?? null,
        providerCredentialSource: attempt.providerCredentialSource ?? null,
        providerCredentialVaultRef: attempt.providerCredentialVaultRef ?? null,
        providerResponseStatus: attempt.providerResponseStatus ?? null,
        providerRetryAfterAt: attempt.providerRetryAfterAt ?? null,
        providerWatchId: watch.providerWatchId,
        renewalCount: watch.renewalCount,
        status: watch.status,
        targetId: mailbox.id,
        watchId: watch.id,
      };
    },
    { ...options, retryOnConflict: false },
  );
}

export async function handleProviderWatchNotification(provider, payload = {}, options = {}) {
  return mutateState(
    'mailboxes.watch-notification',
    (state, actor) => {
      const sourceProvider = requireOneOf(provider, ['gmail', 'outlook'], 'provider', 'provider watch notification');
      let notificationCount = 0;
      let mailboxId = null;
      let cursorValue = null;
      let targetWatch = null;

      try {
        if (sourceProvider === 'gmail') {
          const notification = parseGmailPubSubNotification(payload);
          cursorValue = notification.historyId ? String(notification.historyId) : null;
          targetWatch = [...(state.emailWatchSubscriptions ?? [])].reverse().find((watch) => watch.provider === 'gmail' && watch.status === 'active');
          notificationCount = 1;
        } else {
          const notifications = parseOutlookChangeNotification(payload);
          notificationCount = notifications.length;
          const firstNotification = notifications[0];
          if (!firstNotification.clientState) {
            throw new ProviderWatchError('Outlook notification clientState is required.', {
              code: 'OUTLOOK_NOTIFICATION_CLIENT_STATE_REQUIRED',
              status: 401,
            });
          }
          const receivedDigest = digestClientState(firstNotification.clientState);
          targetWatch = (state.emailWatchSubscriptions ?? []).find((watch) => watch.provider === 'outlook' && watch.clientStateDigest === receivedDigest);
          if (!targetWatch) {
            throw new ProviderWatchError('Outlook notification clientState did not match any active watch.', {
              code: 'OUTLOOK_NOTIFICATION_CLIENT_STATE_INVALID',
              status: 401,
            });
          }
          cursorValue = firstNotification.subscriptionId ?? firstNotification.resourceData?.id ?? null;
        }
      } catch (watchError) {
        throw signalErrorFromProviderError(watchError);
      }

      if (!targetWatch) {
        throw new SignalStateError(`No active ${sourceProvider} watch is available for notification intake.`, {
          code: 'WATCH_NOT_FOUND',
          status: 404,
          details: { provider: sourceProvider },
        });
      }

      mailboxId = targetWatch.mailboxId;
      const mailbox = findById(state.mailboxes, mailboxId, 'Mailbox');
      const cursor = state.emailSyncCursors?.find((candidate) => candidate.mailboxId === mailbox.id);
      if (cursor) {
        cursor.status = 'active';
        cursor.lastSyncedAt = nowIso();
        if (cursorValue) {
          cursor.cursor = `${sourceProvider}-notification-${cursorValue}`;
        }
      }
      targetWatch.lastNotificationAt = nowIso();
      targetWatch.notificationCount = (targetWatch.notificationCount ?? 0) + notificationCount;
      appendJob(state, {
        tenantId: mailbox.tenantId,
        queue: 'email_sync',
        type: `${sourceProvider}.watch.notification`,
        targetId: mailbox.id,
        status: 'queued',
        attempts: 0,
        maxAttempts: 3,
        message: `Received ${notificationCount} ${sourceProvider} watch notification${notificationCount === 1 ? '' : 's'} for ${mailbox.id}.`,
      });
      return {
        mailboxId: mailbox.id,
        message: `Received ${sourceProvider} watch notification for ${mailbox.id}`,
        notificationCount,
        provider: sourceProvider,
        targetId: mailbox.id,
        watchId: targetWatch.id,
      };
    },
    { ...options, requireExplicitActor: true },
  );
}

export async function setEmailFlowStatus(flowId, nextStatus, options = {}) {
  return mutateState(
    nextStatus === 'enabled' ? 'email-flows.enable' : 'email-flows.disable',
    (state, actor) => {
      requireAdmin(actor, nextStatus === 'enabled' ? 'email-flows.enable' : 'email-flows.disable');
      const status = requireOneOf(nextStatus, ['enabled', 'disabled'], 'status', 'email-flows enable|disable <flowId>');
      const flow = findById(state.emailFlows, requireArg(flowId, 'flow id', 'email-flows enable|disable <flowId>'), 'Email flow');
      const previousStatus = flow.status;
      flow.status = status;
      return {
        flowId: flow.id,
        message: `${flow.name} is now ${status}`,
        nextStatus: status,
        previousStatus,
        targetId: flow.id,
      };
    },
    options,
  );
}

export async function setEmailFlowRouting(flowId, { routeTo, ownerUserId, status = 'active', note } = {}, options = {}) {
  return mutateState(
    'email-flows.route',
    (state, actor) => {
      requireAdmin(actor, 'email-flows.route');
      ensureDefaultRoutingRules(state);
      const flow = findById(state.emailFlows, requireArg(flowId, 'flow id', 'email-flows route <flowId> <routeTarget> [ownerUserId] [note]'), 'Email flow');
      const nextRoute = requireOneOf(routeTo, routingTargets, 'route target', 'email-flows route <flowId> <sales|product|customer_success|founder|crm> [ownerUserId] [note]');
      const nextStatus = requireOneOf(status, ['active', 'disabled'], 'routing rule status', 'email-flows route <flowId> <routeTarget> [ownerUserId] [note]');
      const normalizedOwnerId = ownerUserId && !['-', 'null', 'none'].includes(String(ownerUserId).toLowerCase())
        ? ownerUserId
        : null;
      let owner = null;
      if (normalizedOwnerId) {
        owner = findById(state.users ?? [], normalizedOwnerId, 'User');
        if (owner.tenantId !== flow.tenantId || owner.status !== 'active') {
          throw new SignalStateError(`Routing owner must be an active user in ${flow.tenantId}: ${normalizedOwnerId}`, {
            code: 'ROUTING_OWNER_INVALID',
            status: 409,
            details: { flowId: flow.id, ownerUserId: normalizedOwnerId, tenantId: flow.tenantId },
          });
        }
      }

      let rule = (state.routingRules ?? []).find((candidate) => candidate.flowId === flow.id);
      if (!rule) {
        rule = {
          id: `rr_${flow.id}`,
          tenantId: flow.tenantId,
          flowId: flow.id,
          createdAt: nowIso(),
          createdByUserId: actor.id,
        };
        state.routingRules.push(rule);
      }
      const previousRouteTo = rule.routeTo ?? flow.routeTo;
      const previousOwnerUserId = rule.ownerUserId ?? null;
      const previousStatus = rule.status ?? 'active';
      Object.assign(rule, {
        note: String(note ?? '').replaceAll('_', ' ').trim() || rule.note || 'Updated by local admin',
        ownerUserId: owner?.id ?? null,
        routeTo: nextRoute,
        status: nextStatus,
        tenantId: flow.tenantId,
        updatedAt: nowIso(),
        updatedByUserId: actor.id,
      });
      flow.routeTo = nextRoute;
      flow.routingRuleId = rule.id;
      return {
        flowId: flow.id,
        message: `${flow.name} routes to ${nextRoute}${owner ? ` via ${owner.email}` : ''}`,
        nextOwnerUserId: rule.ownerUserId,
        nextRouteTo: nextRoute,
        nextStatus,
        previousOwnerUserId,
        previousRouteTo,
        previousStatus,
        routingRuleId: rule.id,
        targetId: rule.id,
        tenantId: flow.tenantId,
      };
    },
    options,
  );
}

function runEmailFlowsInState(state, actor, { flowId, mailboxId } = {}) {
  requireAdmin(actor, 'email-flows.run');
  state.sourceMessages = state.sourceMessages ?? defaultSourceMessages(state);
  state.flowRuns = state.flowRuns ?? [];
  state.signals = state.signals ?? [];

  const flows = flowId
    ? [findById(state.emailFlows, flowId, 'Email flow')]
    : (state.emailFlows ?? []).filter((flow) => flow.status === 'enabled');

  if (flowId && flows[0].status !== 'enabled') {
    throw new SignalStateError(`Email flow must be enabled before run: ${flows[0].id}`, {
      code: 'FLOW_DISABLED',
      status: 409,
      details: { flowId: flows[0].id, status: flows[0].status },
    });
  }

  if (flows.length === 0) {
    throw new SignalStateError('No enabled email flows are available to run.', {
      code: 'NO_ENABLED_FLOWS',
      status: 409,
      details: { usage: 'email-flows run [flowId] [mailboxId]' },
    });
  }

  const mailboxes = mailboxId
    ? [findById(state.mailboxes, mailboxId, 'Mailbox')]
    : (state.mailboxes ?? []).filter((mailbox) => mailbox.status === 'connected');

  mailboxes.forEach((mailbox) => {
    if (mailbox.status !== 'connected') {
      throw new SignalStateError(`Mailbox must be connected before flow run: ${mailbox.id}`, {
        code: 'MAILBOX_NOT_CONNECTED',
        status: 409,
        details: { mailboxId: mailbox.id, status: mailbox.status },
      });
    }
  });

  if (mailboxes.length === 0) {
    throw new SignalStateError('No connected mailbox is available for flow execution.', {
      code: 'NO_CONNECTED_MAILBOX',
      status: 409,
      details: { usage: 'email-flows run [flowId] [mailboxId]' },
    });
  }

  const mailboxById = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]));
  const sourceMessages = state.sourceMessages.filter((message) => mailboxById.has(message.mailboxId));
  const startedAt = nowIso();
  const createdSignalIds = [];
  let scannedMessages = 0;
  let matchedMessages = 0;
  let createdSignals = 0;
  let skippedSignals = 0;
  let suppressedMessages = 0;

  flows.forEach((flow) => {
    sourceMessages
      .filter((message) => message.tenantId === flow.tenantId)
      .forEach((message) => {
        scannedMessages += 1;
        const mailbox = mailboxById.get(message.mailboxId);
        const matches = matchingTerms(flow, message);
        if (!matches.length || !mailbox) {
          return;
        }

        matchedMessages += 1;
        const suppressionRule = suppressionRuleForMessage(state, message);
        if (suppressionRule) {
          suppressedMessages += 1;
          return;
        }
        message.processedFlowIds = [...new Set([...(message.processedFlowIds ?? []), flow.id])];
        const existingSignal = state.signals.some((signal) => signal.sourceMessageId === message.id && signal.flowId === flow.id);
        if (existingSignal) {
          skippedSignals += 1;
          return;
        }

        const signal = signalForSourceMessage(state, flow, message, mailbox, matches);
        const qualityBlocker = signalQualityBlocker(state, signal);
        if (qualityBlocker) {
          suppressedMessages += 1;
          return;
        }
        state.signals.push(signal);
        ensureAccountMonitoringForSignal(state, signal);
        upsertNotificationForSignal(state, signal);
        createdSignals += 1;
        createdSignalIds.push(signal.id);
      });
  });

  const run = {
    id: makeId('run_flow'),
    tenantId: flows[0].tenantId,
    flowId: flowId ?? null,
    flowIds: flows.map((flow) => flow.id),
    routingRuleIds: flows.map((flow) => activeRoutingRuleForFlow(state, flow)?.id).filter(Boolean),
    routeTargets: [...new Set(flows.map((flow) => effectiveFlowRouting(state, flow).routeTo))],
    mailboxId: mailboxId ?? null,
    mailboxIds: mailboxes.map((mailbox) => mailbox.id),
    status: 'succeeded',
    startedAt,
    completedAt: nowIso(),
    actorUserId: actor.id,
    scannedMessages,
    matchedMessages,
    suppressedMessages,
    createdSignals,
    skippedSignals,
    createdSignalIds,
  };
  state.flowRuns.push(run);

  const job = appendJob(state, {
    tenantId: run.tenantId,
    queue: 'signal_detection',
    type: 'email_flow.run',
    targetId: run.id,
    status: 'succeeded',
    attempts: 1,
    maxAttempts: 3,
    message: `Ran ${flows.length} email flow${flows.length === 1 ? '' : 's'} across ${sourceMessages.length} local source message${sourceMessages.length === 1 ? '' : 's'}.`,
  });

  return {
    message: `Ran ${flows.length} email flow${flows.length === 1 ? '' : 's'}; created ${createdSignals} signal${createdSignals === 1 ? '' : 's'}`,
    createdSignalIds,
    createdSignals,
    flowIds: run.flowIds,
    jobId: job.id,
    mailboxIds: run.mailboxIds,
    matchedMessages,
    runId: run.id,
    routeTargets: run.routeTargets,
    routingRuleIds: run.routingRuleIds,
    scannedMessages,
    skippedSignals,
    suppressedMessages,
    targetId: run.id,
  };
}

export async function runEmailFlows({ flowId, mailboxId } = {}, options = {}) {
  return mutateState(
    'email-flows.run',
    (state, actor) => runEmailFlowsInState(state, actor, { flowId, mailboxId }),
    options,
  );
}

function normalizeAccountRef(accountRef) {
  return requireArg(accountRef, 'account', 'accounts review <account> [note]')
    .replaceAll('_', ' ')
    .trim();
}

function findAccountProfileByRef(state, accountRef) {
  const ref = normalizeAccountRef(accountRef);
  const lowerRef = ref.toLowerCase();
  const account = (state.accountProfiles ?? []).find((candidate) =>
    candidate.id === accountRef ||
    candidate.id === ref ||
    candidate.name.toLowerCase() === lowerRef);
  if (!account) {
    throw new SignalStateError(`Account not found: ${ref}`, {
      code: 'NOT_FOUND',
      status: 404,
      details: { account: ref },
    });
  }
  return account;
}

export async function createAccountReview(accountRef, { note } = {}, options = {}) {
  return mutateState(
    'accounts.review',
    (state, actor) => {
      const account = findAccountProfileByRef(state, accountRef);
      requireAdminOrOwner(actor, account.ownerUserId, 'accounts.review');
      requireActiveEntitlementForMember(state, actor, account.tenantId, 'accounts.review');
      const accountSignals = (state.signals ?? []).filter((signal) => signal.account === account.name);
      const openSignals = accountSignals.filter((signal) => signal.status === 'open');
      const openActions = (state.accountActions ?? []).filter((action) => action.account === account.name && action.status === 'open');
      const latestEvents = [...(state.accountEvents ?? [])]
        .filter((event) => event.account === account.name)
        .sort((left, right) => Date.parse(right.occurredAt ?? '') - Date.parse(left.occurredAt ?? ''))
        .slice(0, 5);
      const riskLevel = account.healthScore < 50 || account.healthTrend === 'down' || openSignals.some((signal) => signal.severity === 'critical')
        ? 'high'
        : account.healthScore < 70
          ? 'medium'
          : 'low';
      const reviewNote = String(note ?? '').replaceAll('_', ' ').trim();
      const createdAt = nowIso();
      const review = {
        id: makeId('ar'),
        tenantId: account.tenantId,
        account: account.name,
        accountId: account.id,
        ownerUserId: account.ownerUserId,
        healthScore: account.healthScore,
        healthTrend: account.healthTrend,
        stage: account.stage,
        riskLevel,
        openSignalIds: openSignals.map((signal) => signal.id),
        openActionIds: openActions.map((action) => action.id),
        stakeholderIds: (account.stakeholders ?? []).map((stakeholder) => stakeholder.id),
        latestEventIds: latestEvents.map((event) => event.id),
        summary: `${account.name} review: ${openSignals.length} open signal${openSignals.length === 1 ? '' : 's'}, ${openActions.length} open action${openActions.length === 1 ? '' : 's'}, ${account.stakeholders?.length ?? 0} stakeholder${(account.stakeholders?.length ?? 0) === 1 ? '' : 's'} tracked.`,
        note: reviewNote || null,
        createdAt,
        createdByUserId: actor.id,
      };
      state.accountReviews = state.accountReviews ?? [];
      state.accountReviews.push(review);
      account.lastReviewAt = createdAt;
      account.nextReviewAt = expiresInIso(7 * 24 * 60 * 60 * 1000);
      state.accountEvents = state.accountEvents ?? [];
      state.accountEvents.push({
        id: makeId('evt_acct_review'),
        tenantId: account.tenantId,
        account: account.name,
        type: 'account_review',
        title: 'Account review snapshot',
        detail: review.note ? `${review.summary} Note: ${review.note}` : review.summary,
        occurredAt: createdAt,
        reviewId: review.id,
      });
      return {
        account: account.name,
        healthScore: account.healthScore,
        message: `Recorded account review for ${account.name}`,
        openActionCount: openActions.length,
        openSignalCount: openSignals.length,
        reviewId: review.id,
        riskLevel,
        targetId: review.id,
      };
    },
    options,
  );
}

export async function setAccountActionStatus(actionId, nextStatus, options = {}) {
  return mutateState(
    'accounts.action-status',
    (state, actor) => {
      const status = requireOneOf(nextStatus, ['open', 'done', 'muted'], 'status', 'accounts action <actionId> <open|done|muted>');
      const action = findById(state.accountActions ?? [], requireArg(actionId, 'account action id', 'accounts action <actionId> <open|done|muted>'), 'Account action');
      requireAdminOrOwner(actor, action.ownerUserId, 'accounts.action-status');
      requireActiveEntitlementForMember(state, actor, action.tenantId, 'accounts.action-status');
      const previousStatus = action.status;
      action.status = status;
      action.completedAt = status === 'done' ? nowIso() : null;
      state.accountEvents = state.accountEvents ?? [];
      state.accountEvents.push({
        id: makeId('evt_acct_action'),
        tenantId: action.tenantId,
        account: action.account,
        type: 'next_action',
        title: `${action.title} ${status}`,
        detail: `${actor.email} moved ${action.id} from ${previousStatus} to ${status}.`,
        occurredAt: nowIso(),
        actionId: action.id,
        signalId: action.signalId ?? null,
      });
      const notification = upsertNotificationForAccountAction(state, action);
      if (notification && status === 'done') {
        notification.status = 'read';
        notification.readAt = nowIso();
        notification.mutedBy = null;
      } else if (notification && status === 'muted') {
        notification.status = 'muted';
        notification.readAt = null;
        notification.mutedBy = 'manual';
      } else if (notification && status === 'open' && notification.status === 'read') {
        notification.status = 'unread';
        notification.readAt = null;
        notification.mutedBy = null;
        refreshNotificationMuteRules(state, notification.userId);
      }
      return {
        actionId: action.id,
        account: action.account,
        message: `${action.title} is now ${status}`,
        nextStatus: status,
        previousStatus,
        targetId: action.id,
      };
    },
    options,
  );
}

export async function setSignalQualityThreshold(tenantId, minimumConfidence, options = {}) {
  return mutateState(
    'quality.threshold',
    (state, actor) => {
      requireAdmin(actor, 'quality.threshold');
      const tenant = findById(state.tenants ?? [], requireArg(tenantId, 'tenant id', 'quality threshold <tenantId> <0.00-1.00>'), 'Tenant');
      const threshold = Number(minimumConfidence);
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        throw new SignalStateError(`Invalid minimum confidence: ${minimumConfidence}`, {
          code: 'ARG_INVALID',
          details: { minimumConfidence, usage: 'quality threshold <tenantId> <0.00-1.00>' },
        });
      }
      const settings = qualitySettingsForTenant(state, tenant.id);
      const previousMinimumConfidence = settings.minimumConfidence;
      settings.minimumConfidence = Number(threshold.toFixed(2));
      settings.updatedAt = nowIso();
      settings.updatedByUserId = actor.id;
      return {
        message: `${tenant.id} minimum confidence is now ${settings.minimumConfidence}`,
        previousMinimumConfidence,
        minimumConfidence: settings.minimumConfidence,
        targetId: settings.id,
        tenantId: tenant.id,
      };
    },
    options,
  );
}

export async function createSuppressionRule({ tenantId, type, value, reason } = {}, options = {}) {
  return mutateState(
    'quality.suppression-add',
    (state, actor) => {
      requireAdmin(actor, 'quality.suppression-add');
      const tenant = findById(state.tenants ?? [], requireArg(tenantId, 'tenant id', 'quality suppress <tenantId> <domain|sender|account|term> <value> [reason]'), 'Tenant');
      const ruleType = requireOneOf(type, ['domain', 'sender', 'account', 'term'], 'suppression type', 'quality suppress <tenantId> <domain|sender|account|term> <value> [reason]');
      const ruleValue = requireArg(value, 'suppression value', 'quality suppress <tenantId> <domain|sender|account|term> <value> [reason]').trim().toLowerCase();
      state.suppressionRules = state.suppressionRules ?? [];
      const existing = state.suppressionRules.find((rule) => rule.tenantId === tenant.id && rule.type === ruleType && rule.value.toLowerCase() === ruleValue);
      if (existing) {
        existing.status = 'active';
        existing.reason = reason ?? existing.reason;
        existing.updatedAt = nowIso();
        existing.updatedByUserId = actor.id;
        return {
          message: `${ruleType} suppression reactivated for ${ruleValue}`,
          ruleId: existing.id,
          targetId: existing.id,
          tenantId: tenant.id,
        };
      }
      const rule = {
        id: makeId('sup'),
        tenantId: tenant.id,
        type: ruleType,
        value: ruleValue,
        status: 'active',
        reason: reason ?? `Suppress ${ruleType} ${ruleValue}.`,
        createdByUserId: actor.id,
        createdAt: nowIso(),
      };
      state.suppressionRules.push(rule);
      return {
        message: `${ruleType} suppression active for ${ruleValue}`,
        ruleId: rule.id,
        targetId: rule.id,
        tenantId: tenant.id,
      };
    },
    options,
  );
}

export async function setSuppressionRuleStatus(ruleId, nextStatus, options = {}) {
  return mutateState(
    'quality.suppression-status',
    (state, actor) => {
      requireAdmin(actor, 'quality.suppression-status');
      const status = requireOneOf(nextStatus, ['active', 'disabled'], 'suppression status', 'quality suppression-status <ruleId> <active|disabled>');
      const rule = findById(state.suppressionRules ?? [], requireArg(ruleId, 'rule id', 'quality suppression-status <ruleId> <active|disabled>'), 'Suppression rule');
      const previousStatus = rule.status;
      rule.status = status;
      rule.updatedAt = nowIso();
      rule.updatedByUserId = actor.id;
      return {
        message: `${rule.id} is now ${status}`,
        nextStatus: status,
        previousStatus,
        ruleId: rule.id,
        targetId: rule.id,
      };
    },
    options,
  );
}

export async function setModelGovernancePolicy(tenantId, { learningMode, note } = {}, options = {}) {
  return mutateState(
    'models.policy',
    (state, actor) => {
      requireAdmin(actor, 'models.policy');
      const tenant = findById(state.tenants ?? [], requireArg(tenantId, 'tenant id', 'models policy <tenantId> <disabled|opt_in_tuning> [note]'), 'Tenant');
      ensureDefaultModelGovernancePolicies(state);
      const policy = (state.modelGovernancePolicies ?? []).find((candidate) => candidate.tenantId === tenant.id);
      if (!policy) {
        throw new SignalStateError(`Model governance policy not found for ${tenant.id}`, {
          code: 'NOT_FOUND',
          status: 404,
          details: { tenantId: tenant.id },
        });
      }
      const previousLearningMode = policy.learningMode;
      const nextLearningMode = requireOneOf(learningMode, modelLearningModes, 'model learning mode', 'models policy <tenantId> <disabled|opt_in_tuning> [note]');
      policy.learningMode = nextLearningMode;
      policy.trainingDataUse = nextLearningMode === 'disabled' ? 'excluded_by_default' : 'opt_in_only';
      policy.perTenantModel = false;
      policy.detectorBoundary = 'shared_detector';
      policy.dataBoundary = 'tenant_isolated';
      policy.note = note ? String(note).replaceAll('_', ' ') : policy.note ?? null;
      policy.updatedAt = nowIso();
      policy.updatedByUserId = actor.id;
      const evidence = modelGovernanceEvidenceForTenant(state, tenant.id);
      return {
        evidence,
        id: policy.id,
        learningMode: policy.learningMode,
        message: `Updated ${tenant.name} model governance to ${policy.learningMode}; per-tenant model remains disabled.`,
        perTenantModel: policy.perTenantModel,
        previousLearningMode,
        targetId: policy.id,
        tenantId: tenant.id,
        trainingDataUse: policy.trainingDataUse,
      };
    },
    options,
  );
}

export async function setGovernancePolicy(tenantId, patch = {}, options = {}) {
  return mutateState(
    'governance.policy',
    (state, actor) => {
      requireAdmin(actor, 'governance.policy');
      const tenant = findById(state.tenants ?? [], requireArg(tenantId, 'tenant id', 'governance policy <tenantId> [retentionDays] [rawDays]'), 'Tenant');
      const policy = governancePolicyForTenant(state, tenant.id);
      const sourceRetentionDays = patch.sourceRetentionDays === undefined
        ? policy.sourceRetentionDays
        : Number(patch.sourceRetentionDays);
      const rawSnippetRetentionDays = patch.rawSnippetRetentionDays === undefined
        ? policy.rawSnippetRetentionDays
        : Number(patch.rawSnippetRetentionDays);
      const exportWindowDays = patch.exportWindowDays === undefined
        ? policy.exportWindowDays
        : Number(patch.exportWindowDays);

      if (!Number.isFinite(sourceRetentionDays) || sourceRetentionDays < 7 || sourceRetentionDays > 365) {
        throw new SignalStateError('Source retention days must be between 7 and 365.', {
          code: 'ARG_INVALID',
          details: { sourceRetentionDays, usage: 'governance policy <tenantId> <sourceRetentionDays> [rawSnippetRetentionDays]' },
        });
      }
      if (!Number.isFinite(rawSnippetRetentionDays) || rawSnippetRetentionDays < 1 || rawSnippetRetentionDays > sourceRetentionDays) {
        throw new SignalStateError('Raw snippet retention must be at least 1 day and no longer than source retention.', {
          code: 'ARG_INVALID',
          details: { rawSnippetRetentionDays, sourceRetentionDays, usage: 'governance policy <tenantId> <sourceRetentionDays> [rawSnippetRetentionDays]' },
        });
      }
      if (!Number.isFinite(exportWindowDays) || exportWindowDays < 1 || exportWindowDays > 90) {
        throw new SignalStateError('Export window days must be between 1 and 90.', {
          code: 'ARG_INVALID',
          details: { exportWindowDays, usage: 'governance policy <tenantId> <sourceRetentionDays> [rawSnippetRetentionDays] [exportWindowDays]' },
        });
      }

      policy.sourceRetentionDays = sourceRetentionDays;
      policy.rawSnippetRetentionDays = rawSnippetRetentionDays;
      policy.exportWindowDays = exportWindowDays;
      policy.deletionReview = patch.deletionReview === undefined
        ? policy.deletionReview
        : requireOneOf(patch.deletionReview, ['manual', 'automatic'], 'deletion review mode', 'governance policy <tenantId> ...');
      policy.redactionMode = patch.redactionMode === undefined
        ? policy.redactionMode
        : requireOneOf(patch.redactionMode, ['standard', 'strict'], 'redaction mode', 'governance policy <tenantId> ...');
      policy.updatedAt = nowIso();
      policy.updatedByUserId = actor.id;

      return {
        message: `${tenant.domain} governance retention is ${sourceRetentionDays} days`,
        policyId: policy.id,
        rawSnippetRetentionDays,
        sourceRetentionDays,
        targetId: policy.id,
        tenantId: tenant.id,
      };
    },
    options,
  );
}

export async function createRedactionRule({ tenantId, label, scope, pattern, replacement } = {}, options = {}) {
  return mutateState(
    'governance.redaction-add',
    (state, actor) => {
      requireAdmin(actor, 'governance.redaction-add');
      const tenant = findById(state.tenants ?? [], requireArg(tenantId, 'tenant id', 'governance redact <tenantId> <scope> <label> <pattern> [replacement]'), 'Tenant');
      const ruleScope = requireOneOf(scope, ['source_snippets', 'notifications', 'exports'], 'redaction scope', 'governance redact <tenantId> <source_snippets|notifications|exports> <label> <pattern> [replacement]');
      const ruleLabel = requireArg(label, 'redaction label', 'governance redact <tenantId> <scope> <label> <pattern> [replacement]').trim();
      const rulePattern = requireArg(pattern, 'redaction pattern', 'governance redact <tenantId> <scope> <label> <pattern> [replacement]').trim();
      const existing = (state.redactionRules ?? []).find((rule) => rule.tenantId === tenant.id && rule.scope === ruleScope && rule.pattern.toLowerCase() === rulePattern.toLowerCase());

      if (existing) {
        existing.label = ruleLabel;
        existing.replacement = replacement ?? existing.replacement ?? '[redacted]';
        existing.status = 'active';
        existing.updatedAt = nowIso();
        existing.updatedByUserId = actor.id;
        return {
          message: `${existing.label} redaction rule reactivated`,
          ruleId: existing.id,
          targetId: existing.id,
          tenantId: tenant.id,
        };
      }

      const rule = {
        id: makeId('redact'),
        tenantId: tenant.id,
        label: ruleLabel,
        scope: ruleScope,
        pattern: rulePattern,
        replacement: replacement || '[redacted]',
        status: 'active',
        createdByUserId: actor.id,
        createdAt: nowIso(),
      };
      state.redactionRules = state.redactionRules ?? [];
      state.redactionRules.push(rule);
      return {
        message: `${rule.label} redaction rule active`,
        ruleId: rule.id,
        targetId: rule.id,
        tenantId: tenant.id,
      };
    },
    options,
  );
}

export async function setRedactionRuleStatus(ruleId, nextStatus, options = {}) {
  return mutateState(
    'governance.redaction-status',
    (state, actor) => {
      requireAdmin(actor, 'governance.redaction-status');
      const status = requireOneOf(nextStatus, ['active', 'disabled'], 'redaction status', 'governance redaction-rule <ruleId> <active|disabled>');
      const rule = findById(state.redactionRules ?? [], requireArg(ruleId, 'rule id', 'governance redaction-rule <ruleId> <active|disabled>'), 'Redaction rule');
      const previousStatus = rule.status;
      rule.status = status;
      rule.updatedAt = nowIso();
      rule.updatedByUserId = actor.id;
      return {
        message: `${rule.label} redaction ${status}`,
        nextStatus: status,
        previousStatus,
        ruleId: rule.id,
        targetId: rule.id,
      };
    },
    options,
  );
}

export async function createDataRequest({ tenantId, type, requesterEmail, targetUserId, targetAccount, note } = {}, options = {}) {
  return mutateState(
    'governance.request-create',
    (state, actor) => {
      requireAdmin(actor, 'governance.request-create');
      const tenant = findById(state.tenants ?? [], requireArg(tenantId, 'tenant id', 'governance request <tenantId> <export|delete> <requesterEmail> [target]'), 'Tenant');
      const requestType = requireOneOf(type, ['export', 'delete'], 'request type', 'governance request <tenantId> <export|delete> <requesterEmail> [target]');
      const email = requireArg(requesterEmail, 'requester email', 'governance request <tenantId> <export|delete> <requesterEmail> [target]').trim().toLowerCase();
      if (!email.includes('@')) {
        throw new SignalStateError(`Invalid requester email: ${email}`, {
          code: 'ARG_INVALID',
          details: { requesterEmail: email, usage: 'governance request <tenantId> <export|delete> <requesterEmail> [target]' },
        });
      }
      if (targetUserId) {
        findById(state.users ?? [], targetUserId, 'User');
      }
      const policy = governancePolicyForTenant(state, tenant.id);
      const request = {
        id: makeId('dsr'),
        tenantId: tenant.id,
        type: requestType,
        requesterEmail: email,
        targetUserId: targetUserId || null,
        targetAccount: targetAccount || null,
        status: 'open',
        note: note || null,
        exportUri: null,
        requestedAt: nowIso(),
        dueAt: expiresInIso(policy.exportWindowDays * 24 * 60 * 60 * 1000),
        handledByUserId: null,
        completedAt: null,
      };
      state.dataRequests = state.dataRequests ?? [];
      state.dataRequests.push(request);
      const job = appendJob(state, {
        tenantId: tenant.id,
        queue: 'governance',
        type: `data_request.${requestType}.review`,
        targetId: request.id,
        status: 'queued',
        message: `${requestType} request opened for ${email}.`,
      });
      return {
        message: `${requestType} request opened for ${email}`,
        requestId: request.id,
        jobId: job.id,
        targetId: request.id,
        tenantId: tenant.id,
      };
    },
    options,
  );
}

export async function setDataRequestStatus(requestId, nextStatus, { note } = {}, options = {}) {
  return mutateState(
    'governance.request-status',
    (state, actor) => {
      requireAdmin(actor, 'governance.request-status');
      const status = requireOneOf(nextStatus, ['open', 'processing', 'completed', 'rejected'], 'request status', 'governance request-status <requestId> <open|processing|completed|rejected> [note]');
      const request = findById(state.dataRequests ?? [], requireArg(requestId, 'request id', 'governance request-status <requestId> <status> [note]'), 'Data request');
      const previousStatus = request.status;
      request.status = status;
      request.handledByUserId = actor.id;
      if (note) {
        request.note = note;
      }
      if (status === 'completed') {
        request.completedAt = nowIso();
        request.exportUri = request.type === 'export' ? `signal://governance/export/${request.id}` : null;
      } else if (status !== 'rejected') {
        request.completedAt = null;
        request.exportUri = null;
      }
      const job = appendJob(state, {
        tenantId: request.tenantId,
        queue: 'governance',
        type: `data_request.${request.type}.${status}`,
        targetId: request.id,
        status: status === 'completed' || status === 'rejected' ? 'succeeded' : 'queued',
        attempts: status === 'completed' || status === 'rejected' ? 1 : 0,
        message: `${request.type} request marked ${status} by ${actor.email}.`,
      });
      return {
        message: `${request.id} marked ${status}`,
        nextStatus: status,
        previousStatus,
        requestId: request.id,
        jobId: job.id,
        targetId: request.id,
      };
    },
    options,
  );
}

export async function createIncidentNote({ tenantId, severity, title, body } = {}, options = {}) {
  return mutateState(
    'governance.incident-add',
    (state, actor) => {
      requireAdmin(actor, 'governance.incident-add');
      const tenant = findById(state.tenants ?? [], requireArg(tenantId, 'tenant id', 'governance incident <tenantId> <info|watch|incident> <title> [body]'), 'Tenant');
      const noteSeverity = requireOneOf(severity, ['info', 'watch', 'incident'], 'incident severity', 'governance incident <tenantId> <info|watch|incident> <title> [body]');
      const note = {
        id: makeId('inc'),
        tenantId: tenant.id,
        severity: noteSeverity,
        status: 'open',
        title: requireArg(title, 'incident title', 'governance incident <tenantId> <severity> <title> [body]').trim(),
        body: body || 'No additional local note.',
        createdByUserId: actor.id,
        createdAt: nowIso(),
        resolvedByUserId: null,
        resolvedAt: null,
      };
      state.incidentNotes = state.incidentNotes ?? [];
      state.incidentNotes.push(note);
      appendJob(state, {
        tenantId: tenant.id,
        queue: 'governance',
        type: `incident.${noteSeverity}.review`,
        targetId: note.id,
        status: noteSeverity === 'incident' ? 'queued' : 'succeeded',
        attempts: noteSeverity === 'incident' ? 0 : 1,
        message: `${noteSeverity} note opened: ${note.title}`,
      });
      return {
        message: `${noteSeverity} incident note opened`,
        incidentId: note.id,
        targetId: note.id,
        tenantId: tenant.id,
      };
    },
    options,
  );
}

export async function resolveIncidentNote(noteId, options = {}) {
  return mutateState(
    'governance.incident-resolve',
    (state, actor) => {
      requireAdmin(actor, 'governance.incident-resolve');
      const note = findById(state.incidentNotes ?? [], requireArg(noteId, 'incident id', 'governance resolve-incident <incidentId>'), 'Incident note');
      const previousStatus = note.status;
      note.status = 'resolved';
      note.resolvedByUserId = actor.id;
      note.resolvedAt = nowIso();
      appendJob(state, {
        tenantId: note.tenantId,
        queue: 'governance',
        type: 'incident.resolved',
        targetId: note.id,
        status: 'succeeded',
        attempts: 1,
        message: `${note.title} resolved by ${actor.email}.`,
      });
      return {
        message: `${note.title} resolved`,
        incidentId: note.id,
        nextStatus: note.status,
        previousStatus,
        targetId: note.id,
      };
    },
    options,
  );
}

export async function recordSignalFeedback(signalId, label, { note } = {}, options = {}) {
  return mutateState(
    'signals.feedback',
    (state, actor) => {
      const feedbackLabel = requireOneOf(label, ['useful', 'noisy', 'wrong_route', 'bad_source', 'product_gap'], 'feedback label', 'signals feedback <signalId> <useful|noisy|wrong_route|bad_source|product_gap> [note]');
      const signal = findById(state.signals ?? [], requireArg(signalId, 'signal id', 'signals feedback <signalId> <label> [note]'), 'Signal');
      requireAdminOrOwner(actor, signal.ownerUserId, 'signals.feedback');
      requireActiveEntitlementForMember(state, actor, signal.tenantId, 'signals.feedback');
      state.signalFeedback = state.signalFeedback ?? [];
      const feedback = {
        id: makeId('fb'),
        tenantId: signal.tenantId,
        signalId: signal.id,
        userId: actor.id,
        label: feedbackLabel,
        note: note ? String(note) : null,
        createdAt: nowIso(),
      };
      state.signalFeedback.push(feedback);
      signal.feedbackCount = (signal.feedbackCount ?? 0) + 1;
      signal.lastFeedbackLabel = feedbackLabel;
      signal.lastFeedbackAt = feedback.createdAt;
      return {
        message: `${signal.id} feedback recorded as ${feedbackLabel}`,
        feedbackId: feedback.id,
        label: feedbackLabel,
        signalId: signal.id,
        targetId: signal.id,
      };
    },
    options,
  );
}

export async function setNotificationPreference(userId, patch = {}, options = {}) {
  return mutateState(
    'notifications.preference',
    (state, actor) => {
      const user = findById(state.users ?? [], requireArg(userId, 'user id', 'notifications preference <userId> <daily|weekly|off> [immediate|quiet]'), 'User');
      requireAdminOrOwner(actor, user.id, 'notifications.preference');
      const preference = preferenceForUser(state, user.id);
      const previous = {
        digestCadence: preference.digestCadence,
        immediateAlerts: preference.immediateAlerts,
        mutedAccounts: [...(preference.mutedAccounts ?? [])],
        mutedSignalTypes: [...(preference.mutedSignalTypes ?? [])],
      };

      if (patch.digestCadence !== undefined) {
        preference.digestCadence = requireOneOf(patch.digestCadence, notificationCadences, 'digest cadence', 'notifications preference <userId> <daily|weekly|off> [immediate|quiet]');
      }
      if (patch.immediateAlerts !== undefined) {
        preference.immediateAlerts = Boolean(patch.immediateAlerts);
      }
      if (patch.channels !== undefined) {
        if (!Array.isArray(patch.channels)) {
          throw new SignalStateError('Notification channels must be an array.', {
            code: 'ARG_INVALID',
            details: { usage: 'notifications.preference', value: patch.channels },
          });
        }
        preference.channels = [...new Set(patch.channels.filter(Boolean))];
      }
      if (patch.mutedAccounts !== undefined) {
        if (!Array.isArray(patch.mutedAccounts)) {
          throw new SignalStateError('Muted accounts must be an array.', {
            code: 'ARG_INVALID',
            details: { usage: 'notifications.preference', value: patch.mutedAccounts },
          });
        }
        preference.mutedAccounts = [...new Set(patch.mutedAccounts.filter(Boolean))];
      }
      if (patch.mutedSignalTypes !== undefined) {
        if (!Array.isArray(patch.mutedSignalTypes)) {
          throw new SignalStateError('Muted signal types must be an array.', {
            code: 'ARG_INVALID',
            details: { usage: 'notifications.preference', value: patch.mutedSignalTypes },
          });
        }
        preference.mutedSignalTypes = [...new Set(patch.mutedSignalTypes.filter(Boolean))];
      }

      preference.updatedAt = nowIso();
      refreshNotificationMuteRules(state, user.id);
      return {
        message: `${user.email} notification preference updated`,
        preferenceId: preference.id,
        previous,
        targetId: preference.id,
        userId: user.id,
      };
    },
    options,
  );
}

export async function setNotificationStatus(notificationId, nextStatus, options = {}) {
  return mutateState(
    'notifications.status',
    (state, actor) => {
      const status = requireOneOf(nextStatus, notificationStatuses, 'notification status', 'notifications status <notificationId> <unread|read|muted|sent>');
      const notification = findById(state.notificationEvents ?? [], requireArg(notificationId, 'notification id', 'notifications status <notificationId> <unread|read|muted|sent>'), 'Notification event');
      requireAdminOrOwner(actor, notification.userId, 'notifications.status');
      const previousStatus = notification.status;
      notification.status = status;
      notification.readAt = status === 'read' ? nowIso() : null;
      notification.mutedBy = status === 'muted' ? 'manual' : null;
      if (status === 'sent') {
        notification.readAt = null;
      }
      return {
        message: `${notification.id} is now ${status}`,
        nextStatus: status,
        notificationId: notification.id,
        previousStatus,
        targetId: notification.id,
        userId: notification.userId,
      };
    },
    options,
  );
}

function runNotificationDigestInState(state, actor, { tenantId, userId } = {}) {
  requireAdmin(actor, 'notifications.digest-run');
  const targetTenantId = tenantId ?? defaultTenantId(state);
  findById(state.tenants ?? [], targetTenantId, 'Tenant');
  if (userId) {
    const user = findById(state.users ?? [], userId, 'User');
    if (user.tenantId !== targetTenantId) {
      throw new SignalStateError(`User does not belong to tenant: ${user.id}`, {
        code: 'ARG_INVALID',
        details: { tenantId: targetTenantId, userId: user.id },
      });
    }
  }
  refreshNotificationQueue(state);
  state.notificationDigestRuns = state.notificationDigestRuns ?? [];

  const eligibleEvents = (state.notificationEvents ?? []).filter((event) => {
    if (event.tenantId !== targetTenantId || event.status !== 'unread') {
      return false;
    }
    if (userId && event.userId !== userId) {
      return false;
    }
    const preference = preferenceForUser(state, event.userId);
    return preference.digestCadence !== 'off' && preference.emailDeliveryStatus !== 'unsubscribed' && (preference.channels ?? []).includes('email_digest');
  });

  const digestRun = {
    id: makeId('dig'),
    tenantId: targetTenantId,
    requestedUserId: userId ?? null,
    actorUserId: actor.id,
    status: 'succeeded',
    channel: 'email_digest',
    notificationIds: eligibleEvents.map((event) => event.id),
    userIds: [...new Set(eligibleEvents.map((event) => event.userId))],
    sentCount: eligibleEvents.length,
    createdAt: nowIso(),
    completedAt: nowIso(),
  };
  state.notificationDigestRuns.push(digestRun);
  eligibleEvents.forEach((event) => {
    event.status = 'sent';
    event.digestRunId = digestRun.id;
    event.readAt = null;
    event.mutedBy = null;
  });
  const deliveryMessages = digestRun.userIds.map((deliveryUserId) => {
    const notificationIds = eligibleEvents
      .filter((event) => event.userId === deliveryUserId)
      .map((event) => event.id);
    return upsertEmailDeliveryMessage(state, deliveryMessageForDigestRun(state, digestRun, deliveryUserId, notificationIds, 'queued'));
  });
  const job = appendJob(state, {
    tenantId: targetTenantId,
    queue: 'notification_digest',
    type: 'notifications.digest.prepare_delivery',
    targetId: digestRun.id,
    status: 'succeeded',
    attempts: 1,
    maxAttempts: 3,
    message: `Prepared ${eligibleEvents.length} local notification digest item${eligibleEvents.length === 1 ? '' : 's'} and ${deliveryMessages.length} outbound email message${deliveryMessages.length === 1 ? '' : 's'}.`,
  });

  return {
    message: `Prepared digest with ${eligibleEvents.length} notification${eligibleEvents.length === 1 ? '' : 's'} and ${deliveryMessages.length} email deliver${deliveryMessages.length === 1 ? 'y' : 'ies'}`,
    digestRunId: digestRun.id,
    deliveryMessageIds: deliveryMessages.map((message) => message.id),
    jobId: job.id,
    notificationIds: digestRun.notificationIds,
    sentCount: digestRun.sentCount,
    targetId: digestRun.id,
    tenantId: targetTenantId,
    userIds: digestRun.userIds,
  };
}

export async function runNotificationDigest({ tenantId, userId } = {}, options = {}) {
  return mutateState(
    'notifications.digest-run',
    (state, actor) => runNotificationDigestInState(state, actor, { tenantId, userId }),
    options,
  );
}

export async function setEmailDeliveryStatus(messageId, nextStatus, { reason } = {}, options = {}) {
  return mutateState(
    'notifications.delivery-status',
    (state, actor) => {
      requireAdmin(actor, 'notifications.delivery-status');
      const status = requireOneOf(nextStatus, ['queued', 'sent', 'failed', 'bounced', 'suppressed'], 'delivery status', 'notifications delivery-status <messageId> <queued|sent|failed|bounced|suppressed> [reason]');
      const message = findById(state.emailDeliveryMessages ?? [], requireArg(messageId, 'delivery message id', 'notifications delivery-status <messageId> <status> [reason]'), 'Email delivery message');
      const previousStatus = message.status;
      message.status = status;
      message.statusReason = reason ?? (status === 'sent' ? null : message.statusReason);
      message.sentAt = status === 'sent' ? nowIso() : status === 'queued' ? null : message.sentAt ?? null;
      const job = appendJob(state, {
        tenantId: message.tenantId,
        queue: 'outbound_email',
        type: `email.delivery.${status}`,
        targetId: message.id,
        status: ['sent', 'suppressed', 'bounced'].includes(status) ? 'succeeded' : status === 'failed' ? 'failed' : 'queued',
        attempts: status === 'queued' ? 0 : 1,
        maxAttempts: 3,
        message: `${message.id} marked ${status}${reason ? `: ${reason}` : ''}.`,
      });
      return {
        message: `${message.id} delivery is ${status}`,
        deliveryMessageId: message.id,
        jobId: job.id,
        nextStatus: status,
        previousStatus,
        targetId: message.id,
      };
    },
    options,
  );
}

export async function unsubscribeEmailDigest(userOrToken, options = {}) {
  return mutateState(
    'notifications.unsubscribe',
    (state, actor) => {
      const identifier = requireArg(userOrToken, 'user id or unsubscribe code', 'notifications unsubscribe <userId|unsubscribeCode>');
      const preference = (state.notificationPreferences ?? []).find((candidate) => candidate.userId === identifier || candidate.unsubscribeCode === identifier);
      if (!preference) {
        throw new SignalStateError(`Notification preference not found for unsubscribe identifier: ${identifier}`, {
          code: 'NOT_FOUND',
          status: 404,
          details: { identifier },
        });
      }
      requireAdminOrOwner(actor, preference.userId, 'notifications.unsubscribe');
      const previousStatus = preference.emailDeliveryStatus ?? 'subscribed';
      preference.emailDeliveryStatus = 'unsubscribed';
      preference.channels = (preference.channels ?? []).filter((channel) => channel !== 'email_digest');
      preference.unsubscribedAt = nowIso();
      preference.updatedAt = nowIso();
      const suppressedMessages = (state.emailDeliveryMessages ?? [])
        .filter((message) => message.userId === preference.userId && message.status === 'queued')
        .map((message) => {
          message.status = 'suppressed';
          message.statusReason = 'User unsubscribed from email digests.';
          return message.id;
        });
      const job = appendJob(state, {
        tenantId: preference.tenantId,
        queue: 'outbound_email',
        type: 'email.unsubscribe',
        targetId: preference.userId,
        status: 'succeeded',
        attempts: 1,
        maxAttempts: 1,
        message: `${preference.userId} unsubscribed from email digests.`,
      });
      return {
        message: `${preference.userId} unsubscribed from email digests`,
        jobId: job.id,
        previousStatus,
        suppressedMessages,
        targetId: preference.userId,
        userId: preference.userId,
      };
    },
    options,
  );
}

export async function assignSignal(signalId, userId, options = {}) {
  return mutateState(
    'signals.assign',
    (state, actor) => {
      requireAdmin(actor, 'signals.assign');
      const signal = findById(state.signals, requireArg(signalId, 'signal id', 'signals assign <signalId> <userId>'), 'Signal');
      const user = findById(state.users, requireArg(userId, 'user id', 'signals assign <signalId> <userId>'), 'User');
      const previousOwnerUserId = signal.ownerUserId;
      signal.ownerUserId = user.id;
      signal.status = signal.status === 'dismissed' ? 'open' : signal.status;
      return {
        message: `${signal.id} assigned to ${user.email}`,
        nextOwnerUserId: user.id,
        previousOwnerUserId,
        signalId: signal.id,
        targetId: signal.id,
      };
    },
    options,
  );
}

export async function setSignalStatus(signalId, nextStatus, options = {}) {
  return mutateState(
    'signals.status',
    (state, actor) => {
      const status = requireOneOf(nextStatus, ['open', 'routed', 'dismissed'], 'status', 'signals status <signalId> <open|routed|dismissed>');
      const signal = findById(state.signals, requireArg(signalId, 'signal id', 'signals status <signalId> <open|routed|dismissed>'), 'Signal');
      requireAdminOrOwner(actor, signal.ownerUserId, 'signals.status');
      requireActiveEntitlementForMember(state, actor, signal.tenantId, 'signals.status');
      const previousStatus = signal.status;
      signal.status = status;
      return {
        message: `${signal.id} is now ${status}`,
        nextStatus: status,
        previousStatus,
        signalId: signal.id,
        targetId: signal.id,
      };
    },
    options,
  );
}

export async function createSignalHandoff(signalId, { target = 'crm', note } = {}, options = {}) {
  return mutateState(
    'signals.handoff',
    (state, actor) => {
      const signal = findById(state.signals ?? [], requireArg(signalId, 'signal id', 'signals handoff <signalId> <crm|task> [note]'), 'Signal');
      requireAdminOrOwner(actor, signal.ownerUserId, 'signals.handoff');
      requireActiveEntitlementForMember(state, actor, signal.tenantId, 'signals.handoff');
      const handoffTarget = requireOneOf(target, ['crm', 'task'], 'handoff target', 'signals handoff <signalId> <crm|task> [note]');
      const existingQueued = (state.signalHandoffs ?? []).find((handoff) => handoff.signalId === signal.id && handoff.target === handoffTarget && handoff.status === 'queued');
      if (existingQueued) {
        signal.latestHandoffId = existingQueued.id;
        signal.latestHandoffStatus = existingQueued.status;
        return {
          duplicate: true,
          handoffId: existingQueued.id,
          message: `${signal.id} already has a queued ${handoffTarget} handoff`,
          providerRef: existingQueued.providerRef ?? null,
          signalId: signal.id,
          status: existingQueued.status,
          target: handoffTarget,
          targetId: existingQueued.id,
        };
      }
      const owner = state.users?.find((user) => user.id === signal.ownerUserId);
      const handoff = {
        id: makeId('sh'),
        tenantId: signal.tenantId,
        signalId: signal.id,
        account: signal.account,
        target: handoffTarget,
        status: 'queued',
        ownerUserId: signal.ownerUserId,
        routeTo: signal.routeTo ?? null,
        routingRuleId: signal.routingRuleId ?? null,
        provider: handoffTarget === 'crm' ? 'local_crm' : 'local_task',
        providerRef: null,
        payloadUri: `signal://handoff/${handoffTarget}/${signal.id}`,
        summary: signal.summary,
        note: String(note ?? '').replaceAll('_', ' ').trim() || null,
        createdAt: nowIso(),
        createdByUserId: actor.id,
        updatedAt: nowIso(),
        updatedByUserId: actor.id,
      };
      state.signalHandoffs = state.signalHandoffs ?? [];
      state.signalHandoffs.push(handoff);
      signal.status = signal.status === 'dismissed' ? 'open' : 'routed';
      signal.latestHandoffId = handoff.id;
      signal.latestHandoffStatus = handoff.status;
      appendJob(state, {
        tenantId: signal.tenantId,
        queue: 'signal_handoff',
        type: `signal.${handoffTarget}.handoff`,
        targetId: handoff.id,
        status: 'queued',
        maxAttempts: 3,
        message: `Prepared ${handoffTarget} handoff for ${signal.account}${owner ? ` owned by ${owner.email}` : ''}.`,
      });
      return {
        handoffId: handoff.id,
        message: `Prepared ${handoffTarget} handoff for ${signal.account}`,
        payloadUri: handoff.payloadUri,
        provider: handoff.provider,
        signalId: signal.id,
        status: handoff.status,
        target: handoff.target,
        targetId: handoff.id,
      };
    },
    options,
  );
}

export async function setSignalHandoffStatus(handoffId, nextStatus, { providerRef, note } = {}, options = {}) {
  return mutateState(
    'signals.handoff-status',
    (state, actor) => {
      const status = requireOneOf(nextStatus, ['queued', 'sent', 'failed', 'canceled'], 'handoff status', 'signals handoff-status <handoffId> <queued|sent|failed|canceled> [providerRef] [note]');
      const handoff = findById(state.signalHandoffs ?? [], requireArg(handoffId, 'handoff id', 'signals handoff-status <handoffId> <status> [providerRef] [note]'), 'Signal handoff');
      const signal = findById(state.signals ?? [], handoff.signalId, 'Signal');
      requireAdminOrOwner(actor, handoff.ownerUserId ?? signal.ownerUserId, 'signals.handoff-status');
      requireActiveEntitlementForMember(state, actor, signal.tenantId, 'signals.handoff-status');
      const previousStatus = handoff.status;
      handoff.status = status;
      handoff.providerRef = providerRef || handoff.providerRef || null;
      if (note) {
        handoff.note = String(note).replaceAll('_', ' ');
      }
      handoff.updatedAt = nowIso();
      handoff.updatedByUserId = actor.id;
      if (status === 'sent') {
        handoff.sentAt = handoff.sentAt ?? handoff.updatedAt;
        signal.status = 'routed';
      }
      if (status === 'failed') {
        handoff.failedAt = handoff.updatedAt;
      }
      if (status === 'canceled') {
        handoff.canceledAt = handoff.updatedAt;
      }
      signal.latestHandoffId = handoff.id;
      signal.latestHandoffStatus = handoff.status;
      appendJob(state, {
        tenantId: handoff.tenantId,
        queue: 'signal_handoff',
        type: `signal.${handoff.target}.handoff.${status}`,
        targetId: handoff.id,
        status: status === 'failed' ? 'failed' : 'succeeded',
        attempts: 1,
        maxAttempts: 3,
        message: `${handoff.id} ${handoff.target} handoff marked ${status}.`,
      });
      return {
        handoffId: handoff.id,
        message: `${handoff.id} handoff is now ${status}`,
        nextStatus: status,
        previousStatus,
        providerRef: handoff.providerRef,
        signalId: signal.id,
        target: handoff.target,
        targetId: handoff.id,
      };
    },
    options,
  );
}

function normalizeOverrideReason(reason, fallback) {
  return String(reason ?? '')
    .replaceAll('_', ' ')
    .trim() || fallback;
}

function normalizeOverrideExpiresAt(expiresAt) {
  if (!expiresAt) {
    return null;
  }
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) {
    throw new SignalStateError(`Invalid override expiration: ${expiresAt}`, {
      code: 'ARG_INVALID',
      details: { expiresAt, usage: 'payments override <tenantId> <type> <reason> [planId|amountCents] [expiresAt]' },
    });
  }
  return new Date(timestamp).toISOString();
}

function createBillingOverrideRecord(state, actor, tenant, type, { reason, planId, amountCents, expiresAt, subscriptionId } = {}) {
  state.billingOverrides = state.billingOverrides ?? [];
  const override = {
    id: makeId('bo'),
    tenantId: tenant.id,
    type,
    status: 'active',
    reason: normalizeOverrideReason(reason, `${type.replaceAll('_', ' ')} override`),
    createdAt: nowIso(),
    createdByUserId: actor.id,
    updatedAt: nowIso(),
  };
  if (planId) {
    override.planId = planId;
  }
  if (typeof amountCents === 'number') {
    override.amountCents = amountCents;
  }
  const normalizedExpiresAt = normalizeOverrideExpiresAt(expiresAt);
  if (normalizedExpiresAt) {
    override.expiresAt = normalizedExpiresAt;
  }
  if (subscriptionId) {
    override.subscriptionId = subscriptionId;
  }
  state.billingOverrides.push(override);
  return override;
}

function upsertOverrideSubscription(state, tenant, plan, override) {
  state.subscriptions = state.subscriptions ?? [];
  let subscription = state.subscriptions.find((item) => item.id === override.subscriptionId);
  if (!subscription) {
    subscription = {
      id: `sub_${override.id}`,
      tenantId: tenant.id,
      provider: 'local_override',
      planId: plan.id,
      status: 'active',
    };
    state.subscriptions.push(subscription);
  }
  Object.assign(subscription, {
    billingOverrideId: override.id,
    planId: plan.id,
    provider: 'local_override',
    status: 'active',
    trialEndsAt: override.expiresAt ?? subscription.trialEndsAt ?? null,
  });
  override.subscriptionId = subscription.id;
  return subscription;
}

function recomputeEntitlementForTenant(state, tenantId, fallbackSubscription = null) {
  const subscription = [...(state.subscriptions ?? [])]
    .filter((candidate) => candidate.tenantId === tenantId && ['trialing', 'active'].includes(candidate.status))
    .sort((left, right) => Date.parse(right.providerSyncedAt ?? right.trialEndsAt ?? '') - Date.parse(left.providerSyncedAt ?? left.trialEndsAt ?? ''))[0] ??
    fallbackSubscription ??
    (state.subscriptions ?? []).find((candidate) => candidate.tenantId === tenantId);
  return subscription ? upsertEntitlementFromSubscription(state, subscription) : null;
}

function reconcileExpiredBillingOverrides(state, tenant) {
  refreshBillingOverrideStatuses(state);
  const tenantOverrides = (state.billingOverrides ?? []).filter((override) => override.tenantId === tenant.id);
  const expiredOverrideIds = tenantOverrides.filter((override) => override.status === 'expired').map((override) => override.id);
  const canceledSubscriptionIds = [];
  for (const override of tenantOverrides.filter((item) => item.status === 'expired')) {
    const subscription = (state.subscriptions ?? []).find((candidate) =>
      candidate.id === override.subscriptionId ||
      candidate.billingOverrideId === override.id);
    if (subscription && subscription.status !== 'canceled') {
      subscription.status = 'canceled';
      subscription.canceledAt = subscription.canceledAt ?? nowIso();
      canceledSubscriptionIds.push(subscription.id);
    }
  }

  const activeSuspension = tenantOverrides.find((override) =>
    override.type === 'manual_suspension' && override.status === 'active');
  let tenantStatusChange = null;
  if (activeSuspension && tenant.status !== 'suspended') {
    tenant.status = 'suspended';
    tenant.statusUpdatedAt = nowIso();
    tenant.statusUpdatedByUserId = activeSuspension.createdByUserId;
    tenant.suspensionReason = activeSuspension.reason;
    tenant.suspendedAt = tenant.statusUpdatedAt;
    tenant.suspendedByUserId = activeSuspension.createdByUserId;
    tenantStatusChange = 'suspended';
  }

  if (!activeSuspension && tenant.status === 'suspended') {
    const inactiveSuspension = tenantOverrides.find((override) =>
      override.type === 'manual_suspension' &&
      ['expired', 'revoked'].includes(override.status) &&
      (tenant.suspensionReason === override.reason || tenant.suspendedByUserId === override.createdByUserId));
    if (inactiveSuspension) {
      tenant.status = 'active';
      tenant.statusUpdatedAt = nowIso();
      tenant.statusUpdatedByUserId = inactiveSuspension.revokedByUserId ?? inactiveSuspension.createdByUserId;
      tenant.suspensionReason = null;
      tenant.suspendedAt = null;
      tenant.suspendedByUserId = null;
      tenantStatusChange = 'reactivated';
    }
  }

  return {
    canceledSubscriptionIds,
    expiredOverrideIds,
    tenantStatusChange,
  };
}

export async function syncPaymentState({ tenantId } = {}, options = {}) {
  return mutateState(
    'payments.sync',
    (state, actor) => {
      requireAdmin(actor, 'payments.sync');
      const tenants = tenantId
        ? [findById(state.tenants ?? [], requireArg(tenantId, 'tenant id', 'payments sync [tenantId]'), 'Tenant')]
        : [...(state.tenants ?? [])];
      const results = tenants.map((tenant) => {
        const reconciliation = reconcileExpiredBillingOverrides(state, tenant);
        const entitlement = recomputeEntitlementForTenant(state, tenant.id);
        const event = appendPaymentEvent(state, {
          tenantId: tenant.id,
          provider: 'local_test',
          type: 'billing.sync.completed',
          status: 'recorded',
          subscriptionId: entitlement?.subscriptionId,
        });
        const job = appendJob(state, {
          tenantId: tenant.id,
          queue: 'billing_webhook',
          type: 'payment.sync',
          targetId: tenant.id,
          status: 'succeeded',
          attempts: 1,
          maxAttempts: 5,
          message: `Reconciled billing overrides and entitlement for ${tenant.name}.`,
        });
        return {
          canceledSubscriptionIds: reconciliation.canceledSubscriptionIds,
          entitlementId: entitlement?.id ?? null,
          entitlementSource: entitlement?.source ?? null,
          entitlementStatus: entitlement?.status ?? 'missing',
          eventId: event.id,
          expiredOverrideIds: reconciliation.expiredOverrideIds,
          jobId: job.id,
          tenantId: tenant.id,
          tenantStatusChange: reconciliation.tenantStatusChange,
        };
      });
      const expiredOverrideIds = results.flatMap((result) => result.expiredOverrideIds);
      const canceledSubscriptionIds = results.flatMap((result) => result.canceledSubscriptionIds);
      return {
        canceledSubscriptionIds,
        entitlementIds: results.map((result) => result.entitlementId).filter(Boolean),
        eventIds: results.map((result) => result.eventId),
        expiredOverrideIds,
        jobIds: results.map((result) => result.jobId),
        message: `Synced payment state for ${results.length} tenant${results.length === 1 ? '' : 's'}; ${expiredOverrideIds.length} expired override${expiredOverrideIds.length === 1 ? '' : 's'} reconciled.`,
        results,
        targetId: tenantId ?? 'payments.sync',
        tenantIds: results.map((result) => result.tenantId),
      };
    },
    options,
  );
}

export async function createBillingOverride(tenantId, type, { reason, planId, amountCents, expiresAt } = {}, options = {}) {
  return mutateState(
    'payments.override',
    (state, actor) => {
      requireAdmin(actor, 'payments.override');
      const tenant = findById(state.tenants, requireArg(tenantId, 'tenant id', 'payments override <tenantId> <type> <reason> [planId|amountCents]'), 'Tenant');
      const overrideType = requireOneOf(type, ['beta_access', 'support_credit', 'manual_entitlement', 'manual_suspension'], 'override type', 'payments override <tenantId> <beta_access|support_credit|manual_entitlement|manual_suspension> <reason> [planId|amountCents] [expiresAt]');
      const overrideReason = normalizeOverrideReason(reason, `${overrideType.replaceAll('_', ' ')} override`);
      let plan = null;
      let creditAmountCents = null;
      if (['beta_access', 'manual_entitlement'].includes(overrideType)) {
        const targetPlanId = planId ?? (overrideType === 'beta_access' ? 'plan_beta' : tenant.planId);
        plan = findById(state.plans, targetPlanId, 'Plan');
      }
      if (overrideType === 'support_credit') {
        creditAmountCents = requirePositiveInteger(amountCents, 'support credit amount in cents', 'payments override <tenantId> support_credit <reason> <amountCents>');
      }

      const override = createBillingOverrideRecord(state, actor, tenant, overrideType, {
        amountCents: creditAmountCents,
        expiresAt,
        planId: plan?.id,
        reason: overrideReason,
      });

      let subscription = null;
      let entitlement = null;
      if (plan) {
        subscription = upsertOverrideSubscription(state, tenant, plan, override);
        entitlement = upsertEntitlementFromSubscription(state, subscription);
      } else {
        entitlement = recomputeEntitlementForTenant(state, tenant.id);
      }

      if (overrideType === 'manual_suspension') {
        tenant.status = 'suspended';
        tenant.statusUpdatedAt = nowIso();
        tenant.statusUpdatedByUserId = actor.id;
        tenant.suspensionReason = override.reason;
        tenant.suspendedAt = tenant.statusUpdatedAt;
        tenant.suspendedByUserId = actor.id;
      }

      appendPaymentEvent(state, {
        tenantId: tenant.id,
        provider: 'local_override',
        type: `billing.override.${overrideType}.created`,
        status: 'recorded',
        amountCents: creditAmountCents,
        billingOverrideId: override.id,
        subscriptionId: subscription?.id,
      });

      return {
        message: `${tenant.name} billing override recorded: ${overrideType}`,
        amountCents: creditAmountCents,
        entitlementId: entitlement?.id,
        overrideId: override.id,
        overrideType,
        planId: plan?.id,
        status: override.status,
        subscriptionId: subscription?.id,
        targetId: override.id,
        tenantId: tenant.id,
      };
    },
    options,
  );
}

export async function revokeBillingOverride(overrideId, { reason } = {}, options = {}) {
  return mutateState(
    'payments.override-revoke',
    (state, actor) => {
      requireAdmin(actor, 'payments.override-revoke');
      const override = findById(state.billingOverrides ?? [], requireArg(overrideId, 'override id', 'payments override-revoke <overrideId> [reason]'), 'Billing override');
      if (override.status !== 'active') {
        throw new SignalStateError(`Billing override is already ${override.status}: ${override.id}`, {
          code: 'BILLING_OVERRIDE_NOT_ACTIVE',
          status: 409,
          details: { overrideId: override.id, status: override.status },
        });
      }
      override.status = 'revoked';
      override.revokedAt = nowIso();
      override.revokedByUserId = actor.id;
      override.revocationReason = normalizeOverrideReason(reason, 'Revoked by local admin');
      override.updatedAt = override.revokedAt;

      const subscription = (state.subscriptions ?? []).find((item) => item.id === override.subscriptionId || item.billingOverrideId === override.id);
      if (subscription) {
        subscription.status = 'canceled';
        subscription.canceledAt = override.revokedAt;
      }

      const tenant = (state.tenants ?? []).find((item) => item.id === override.tenantId);
      if (tenant && override.type === 'manual_suspension') {
        tenant.status = 'active';
        tenant.statusUpdatedAt = override.revokedAt;
        tenant.statusUpdatedByUserId = actor.id;
        tenant.suspensionReason = null;
        tenant.suspendedAt = null;
        tenant.suspendedByUserId = null;
      }

      const entitlement = recomputeEntitlementForTenant(state, override.tenantId, subscription);
      appendPaymentEvent(state, {
        tenantId: override.tenantId,
        provider: 'local_override',
        type: `billing.override.${override.type}.revoked`,
        status: 'recorded',
        amountCents: override.amountCents,
        billingOverrideId: override.id,
        subscriptionId: subscription?.id,
      });

      return {
        message: `${override.id} billing override revoked`,
        entitlementId: entitlement?.id,
        overrideId: override.id,
        overrideType: override.type,
        status: override.status,
        subscriptionId: subscription?.id,
        targetId: override.id,
        tenantId: override.tenantId,
      };
    },
    options,
  );
}

export async function compTenant(tenantId, planId, options = {}) {
  return mutateState(
    'payments.comp',
    (state, actor) => {
      requireAdmin(actor, 'payments.comp');
      const tenant = findById(state.tenants, requireArg(tenantId, 'tenant id', 'payments comp <tenantId> <planId>'), 'Tenant');
      const plan = findById(state.plans, requireArg(planId, 'plan id', 'payments comp <tenantId> <planId>'), 'Plan');
      tenant.planId = plan.id;
      let subscription = state.subscriptions.find((item) => item.tenantId === tenant.id);
      if (!subscription) {
        subscription = {
          id: `sub_${tenant.id}`,
          tenantId: tenant.id,
          provider: 'local_test',
          planId: plan.id,
          status: 'active',
        };
        state.subscriptions.push(subscription);
      }
      subscription.planId = plan.id;
      subscription.status = 'active';
      const entitlement = upsertEntitlementFromSubscription(state, subscription);
      appendPaymentEvent(state, {
        tenantId: tenant.id,
        provider: 'local_test',
        type: 'admin.comp.applied',
        status: 'recorded',
      });
      return {
        message: `${tenant.name} comped onto ${plan.name}`,
        entitlementId: entitlement?.id,
        planId: plan.id,
        targetId: tenant.id,
        tenantId: tenant.id,
      };
    },
    options,
  );
}

export async function setSubscriptionStatus(subscriptionId, nextStatus, options = {}) {
  return mutateState(
    'payments.status',
    (state, actor) => {
      requireAdmin(actor, 'payments.status');
      const status = requireOneOf(nextStatus, ['trialing', 'active', 'past_due', 'canceled'], 'status', 'payments status <subscriptionId> <trialing|active|past_due|canceled>');
      const subscription = findById(state.subscriptions, requireArg(subscriptionId, 'subscription id', 'payments status <subscriptionId> <status>'), 'Subscription');
      const previousStatus = subscription.status;
      subscription.status = status;
      const entitlement = upsertEntitlementFromSubscription(state, subscription);
      let invoice = null;
      if (status === 'past_due') {
        invoice = upsertInvoiceForSubscription(state, subscription, 'past_due');
      } else if (status === 'active') {
        invoice = upsertInvoiceForSubscription(state, subscription, 'paid');
      } else if (status === 'canceled') {
        invoice = latestInvoiceForSubscription(state, subscription.id);
        if (invoice && ['open', 'past_due'].includes(invoice.status)) {
          invoice.status = 'void';
          invoice.nextPaymentAttemptAt = null;
        }
      }
      appendPaymentEvent(state, {
        tenantId: subscription.tenantId,
        provider: subscription.provider,
        type: `subscription.${status}`,
        status: 'recorded',
        invoiceId: invoice?.id,
        subscriptionId: subscription.id,
      });
      return {
        message: `${subscription.id} is now ${status}`,
        entitlementId: entitlement?.id,
        invoiceId: invoice?.id,
        nextStatus: status,
        previousStatus,
        subscriptionId: subscription.id,
        targetId: subscription.id,
      };
    },
    options,
  );
}

export async function cancelSubscription(subscriptionId, options = {}) {
  return mutateState(
    'payments.cancel',
    (state, actor) => {
      requireAdmin(actor, 'payments.cancel');
      const subscription = findById(state.subscriptions, requireArg(subscriptionId, 'subscription id', 'payments cancel <subscriptionId>'), 'Subscription');
      const previousStatus = subscription.status;
      subscription.status = 'canceled';
      const entitlement = upsertEntitlementFromSubscription(state, subscription);
      const invoice = latestInvoiceForSubscription(state, subscription.id);
      if (invoice && ['open', 'past_due'].includes(invoice.status)) {
        invoice.status = 'void';
        invoice.nextPaymentAttemptAt = null;
      }
      const event = appendPaymentEvent(state, {
        tenantId: subscription.tenantId,
        provider: subscription.provider,
        type: 'subscription.canceled',
        status: 'recorded',
        invoiceId: invoice?.id,
        subscriptionId: subscription.id,
      });
      const job = appendJob(state, {
        tenantId: subscription.tenantId,
        queue: 'billing_webhook',
        type: 'payment.cancel',
        targetId: subscription.id,
        status: 'succeeded',
        attempts: 1,
        maxAttempts: 5,
        message: `Canceled local subscription ${subscription.id}; entitlement is ${entitlement?.status ?? 'restricted'}.`,
      });
      return {
        message: `${subscription.id} canceled locally`,
        entitlementId: entitlement?.id,
        eventId: event.id,
        invoiceId: invoice?.id,
        jobId: job.id,
        previousStatus,
        status: subscription.status,
        subscriptionId: subscription.id,
        targetId: subscription.id,
      };
    },
    options,
  );
}

export async function createCheckoutSession(tenantId, planId, options = {}) {
  return mutateState(
    'payments.checkout',
    async (state, actor) => {
      const tenant = findById(state.tenants, requireArg(tenantId, 'tenant id', 'payments checkout <tenantId> <planId>'), 'Tenant');
      requireBillingOwner(state, actor, tenant, 'payments.checkout');
      const plan = findById(state.plans, requireArg(planId, 'plan id', 'payments checkout <tenantId> <planId>'), 'Plan');
      const livePaymentProvider = options.livePaymentProvider === true || options.paymentProviderMode === 'live' || process.env.SIGNAL_PAYMENT_PROVIDER_MODE === 'live';
      const subscription = state.subscriptions?.find((candidate) => candidate.tenantId === tenant.id);
      state.billingSessions = state.billingSessions ?? [];
      const sessionAttempt = state.billingSessions.filter((session) => session.tenantId === tenant.id && session.type === 'checkout').length + 1;
      let providerSession = null;
      if (livePaymentProvider) {
        try {
          providerSession = await createStripeCheckoutSession({
            env: options.env ?? process.env,
            fetchImpl: options.fetchImpl,
            idempotencyKey: options.idempotencyKey,
            plan,
            sessionAttempt,
            stripeCustomerId: options.stripeCustomerId,
            subscription,
            tenant,
          });
        } catch (providerError) {
          throw signalErrorFromProviderError(providerError);
        }
      }
      const session = {
        id: makeId('bs_checkout'),
        tenantId: tenant.id,
        provider: providerSession?.provider ?? 'local_test',
        type: 'checkout',
        status: 'ready',
        planId: plan.id,
        url: providerSession?.url ?? `signal://billing/checkout/${tenant.id}/${plan.id}`,
        createdAt: nowIso(),
        expiresAt: providerSession?.expiresAt ?? expiresInIso(60 * 60 * 1000),
        ...(providerSession?.mode ? { providerMode: providerSession.mode } : { providerMode: 'local' }),
        ...(providerSession?.priceEnv ? { providerPriceEnv: providerSession.priceEnv } : {}),
        ...(providerSession?.providerCustomerId ? { providerCustomerId: providerSession.providerCustomerId } : {}),
        ...(providerSession?.providerRequestDigest ? { providerRequestDigest: providerSession.providerRequestDigest } : {}),
        ...(providerSession?.providerSessionId ? { providerSessionId: providerSession.providerSessionId } : {}),
      };
      state.billingSessions.push(session);
      if (providerSession && subscription) {
        applySubscriptionProviderRefs(subscription, {
          provider: providerSession.provider,
          providerCustomerId: providerSession.providerCustomerId,
          providerSessionId: providerSession.providerSessionId,
        });
      }
      appendPaymentEvent(state, {
        tenantId: tenant.id,
        provider: session.provider,
        type: 'checkout.session.created',
        providerCustomerId: providerSession?.providerCustomerId,
        sessionId: session.id,
      });
      appendJob(state, {
        tenantId: tenant.id,
        queue: 'billing_webhook',
        type: providerSession ? 'checkout.session.stripe.create' : 'checkout.session.prepare',
        targetId: session.id,
        status: 'succeeded',
        attempts: 1,
        maxAttempts: 5,
        message: providerSession ? `Created live Stripe checkout for ${plan.name}.` : `Prepared local checkout for ${plan.name}.`,
      });
      return {
        message: `${providerSession ? 'Stripe' : 'Local'} checkout ready for ${tenant.name} on ${plan.name}`,
        mode: providerSession?.mode ?? 'local',
        planId: plan.id,
        provider: session.provider,
        providerRequestDigest: session.providerRequestDigest,
        providerSessionId: session.providerSessionId,
        sessionId: session.id,
        targetId: session.id,
        tenantId: tenant.id,
        url: session.url,
      };
    },
    { ...options, retryOnConflict: false },
  );
}

export async function createBillingPortalSession(tenantId, options = {}) {
  return mutateState(
    'payments.portal',
    async (state, actor) => {
      const tenant = findById(state.tenants, requireArg(tenantId, 'tenant id', 'payments portal <tenantId>'), 'Tenant');
      requireBillingOwner(state, actor, tenant, 'payments.portal');
      const subscription = state.subscriptions.find((candidate) => candidate.tenantId === tenant.id);
      if (!subscription) {
        throw new SignalStateError(`Subscription not found for tenant: ${tenant.id}`, {
          code: 'NOT_FOUND',
          status: 404,
          details: { tenantId: tenant.id },
        });
      }
      const livePaymentProvider = options.livePaymentProvider === true || options.paymentProviderMode === 'live' || process.env.SIGNAL_PAYMENT_PROVIDER_MODE === 'live';
      state.billingSessions = state.billingSessions ?? [];
      const sessionAttempt = state.billingSessions.filter((session) => session.tenantId === tenant.id && session.type === 'portal').length + 1;
      let providerSession = null;
      if (livePaymentProvider) {
        try {
          providerSession = await createStripeBillingPortalSession({
            env: options.env ?? process.env,
            fetchImpl: options.fetchImpl,
            idempotencyKey: options.idempotencyKey,
            sessionAttempt,
            stripeCustomerId: options.stripeCustomerId,
            subscription,
            tenant,
          });
        } catch (providerError) {
          throw signalErrorFromProviderError(providerError);
        }
      }
      const session = {
        id: makeId('bs_portal'),
        tenantId: tenant.id,
        provider: providerSession?.provider ?? subscription.provider,
        type: 'portal',
        status: 'ready',
        subscriptionId: subscription.id,
        url: providerSession?.url ?? `signal://billing/portal/${tenant.id}/${subscription.id}`,
        createdAt: nowIso(),
        expiresAt: providerSession?.expiresAt ?? expiresInIso(30 * 60 * 1000),
        ...(providerSession?.mode ? { providerMode: providerSession.mode } : { providerMode: 'local' }),
        ...(providerSession?.providerCustomerId ? { providerCustomerId: providerSession.providerCustomerId } : {}),
        ...(providerSession?.providerRequestDigest ? { providerRequestDigest: providerSession.providerRequestDigest } : {}),
        ...(providerSession?.providerSessionId ? { providerSessionId: providerSession.providerSessionId } : {}),
      };
      state.billingSessions.push(session);
      if (providerSession) {
        applySubscriptionProviderRefs(subscription, {
          provider: providerSession.provider,
          providerCustomerId: providerSession.providerCustomerId,
        });
      }
      appendPaymentEvent(state, {
        tenantId: tenant.id,
        provider: session.provider,
        type: 'billing_portal.session.created',
        providerCustomerId: providerSession?.providerCustomerId,
        sessionId: session.id,
        subscriptionId: subscription.id,
      });
      return {
        message: `${providerSession ? 'Stripe' : 'Local'} billing portal ready for ${tenant.name}`,
        mode: providerSession?.mode ?? 'local',
        provider: session.provider,
        providerRequestDigest: session.providerRequestDigest,
        providerSessionId: session.providerSessionId,
        sessionId: session.id,
        subscriptionId: subscription.id,
        targetId: session.id,
        tenantId: tenant.id,
        url: session.url,
      };
    },
    { ...options, retryOnConflict: false },
  );
}

export async function createInvoiceRecoverySession(invoiceId, options = {}) {
  return mutateState(
    'payments.recover',
    (state, actor) => {
      const invoice = findById(state.invoices ?? [], requireArg(invoiceId, 'invoice id', 'payments recover <invoiceId>'), 'Invoice');
      const tenant = findById(state.tenants ?? [], invoice.tenantId, 'Tenant');
      requireBillingOwner(state, actor, tenant, 'payments.recover');
      if (invoice.status === 'paid' || invoice.status === 'void') {
        throw new SignalStateError(`Invoice is not recoverable: ${invoice.id}`, {
          code: 'INVOICE_NOT_RECOVERABLE',
          status: 409,
          details: { invoiceId: invoice.id, status: invoice.status },
        });
      }
      const subscription = findById(state.subscriptions, invoice.subscriptionId, 'Subscription');
      const session = {
        id: makeId('bs_recovery'),
        tenantId: invoice.tenantId,
        provider: invoice.provider,
        type: 'payment_recovery',
        status: 'ready',
        subscriptionId: subscription.id,
        invoiceId: invoice.id,
        url: `signal://billing/recover/${invoice.tenantId}/${invoice.id}`,
        createdAt: nowIso(),
        expiresAt: expiresInIso(30 * 60 * 1000),
      };
      state.billingSessions.push(session);
      invoice.status = 'open';
      invoice.nextPaymentAttemptAt = expiresInIso(24 * 60 * 60 * 1000);
      const event = appendPaymentEvent(state, {
        tenantId: invoice.tenantId,
        provider: invoice.provider,
        type: 'invoice.recovery_session.created',
        sessionId: session.id,
        invoiceId: invoice.id,
        subscriptionId: subscription.id,
      });
      const job = appendJob(state, {
        tenantId: invoice.tenantId,
        queue: 'billing_webhook',
        type: 'invoice.recovery',
        targetId: invoice.id,
        status: 'succeeded',
        attempts: 1,
        maxAttempts: 5,
        message: `Prepared local payment recovery for ${invoice.id}.`,
      });
      return {
        message: `Local payment recovery ready for ${invoice.id}`,
        eventId: event.id,
        invoiceId: invoice.id,
        jobId: job.id,
        sessionId: session.id,
        subscriptionId: subscription.id,
        targetId: invoice.id,
        tenantId: invoice.tenantId,
        url: session.url,
      };
    },
    options,
  );
}

export async function handlePaymentWebhook(eventType, {
  amountDueCents,
  currentPeriodEndAt,
  hostedInvoiceUrl,
  nextPaymentAttemptAt,
  subscriptionId,
  tenantId,
  planId,
  providerCustomerId,
  status,
  provider = 'local_test',
  providerInvoiceId,
  providerPriceId,
  providerEventId,
  providerEventType,
  providerSessionId,
  providerStatus,
  providerSubscriptionId,
  signatureStatus,
  signatureVerifiedAt,
  signatureTimestamp,
  livemode,
} = {}, options = {}) {
  return mutateState(
    'payments.webhook',
    (state, actor) => {
      requireAdmin(actor, 'payments.webhook');
      const type = requireOneOf(
        eventType,
        ['checkout.completed', 'invoice.paid', 'invoice.payment_failed', 'subscription.updated', 'subscription.canceled'],
        'webhook type',
        'payments webhook <type> <subscriptionId|tenantId> [status|planId]',
      );
      const existingProviderEvent = providerEventId
        ? (state.paymentEvents ?? []).find((event) => event.provider === provider && event.providerEventId === providerEventId)
        : null;
      if (existingProviderEvent) {
        return {
          message: `Ignored duplicate ${provider} webhook ${providerEventType ?? type}.`,
          duplicate: true,
          eventId: existingProviderEvent.id,
          provider,
          providerEventId,
          providerEventType,
          signatureStatus,
          status: 'duplicate',
          targetId: providerEventId,
        };
      }

      let subscription;
      let tenant;
      let plan;
      let nextStatus;
      let invoice = null;

      if (type === 'checkout.completed') {
        tenant = findById(state.tenants, requireArg(tenantId, 'tenant id', 'payments webhook checkout.completed <tenantId> <planId>'), 'Tenant');
        plan = findById(state.plans, requireArg(planId, 'plan id', 'payments webhook checkout.completed <tenantId> <planId>'), 'Plan');
        subscription = state.subscriptions.find((candidate) => candidate.tenantId === tenant.id);
        if (!subscription) {
          subscription = {
            id: `sub_${tenant.id}`,
            tenantId: tenant.id,
            provider,
            planId: plan.id,
            status: 'active',
          };
          state.subscriptions.push(subscription);
        }
        subscription.planId = plan.id;
        subscription.provider = provider;
        subscription.status = 'active';
        applySubscriptionProviderRefs(subscription, {
          provider,
          providerCustomerId,
          providerEventId,
          providerEventType,
          providerPriceId,
          providerSessionId,
          providerStatus,
          providerSubscriptionId,
          currentPeriodEndAt,
          livemode,
          signatureStatus,
          signatureVerifiedAt,
        });
        tenant.planId = plan.id;
        nextStatus = 'active';
      } else {
        const requiredSubscriptionId = requireArg(subscriptionId, 'subscription id', `payments webhook ${type} <subscriptionId>`);
        subscription = ['subscription.updated', 'subscription.canceled'].includes(type)
          ? upsertSubscriptionFromProviderMetadata(state, {
              planId,
              provider,
              providerSubscriptionId,
              status: type === 'subscription.canceled' ? 'canceled' : status,
              subscriptionId: requiredSubscriptionId,
              tenantId,
            })
          : findSubscriptionByLocalOrProviderId(state, requiredSubscriptionId, provider);
        tenant = findById(state.tenants, subscription.tenantId, 'Tenant');
        subscription.provider = provider === 'local_test' ? subscription.provider : provider;
        if (type === 'invoice.paid') {
          nextStatus = 'active';
        } else if (type === 'invoice.payment_failed') {
          nextStatus = 'past_due';
        } else if (type === 'subscription.canceled') {
          nextStatus = 'canceled';
        } else {
          nextStatus = requireOneOf(status, ['trialing', 'active', 'past_due', 'canceled'], 'subscription status', 'payments webhook subscription.updated <subscriptionId> <status>');
        }
        subscription.status = nextStatus;
        if (planId && state.plans?.some((candidate) => candidate.id === planId)) {
          subscription.planId = planId;
          tenant.planId = planId;
        }
        applySubscriptionProviderRefs(subscription, {
          provider,
          providerCustomerId,
          providerEventId,
          providerEventType,
          providerPriceId,
          providerStatus,
          providerSubscriptionId,
          currentPeriodEndAt,
          livemode,
          signatureStatus,
          signatureVerifiedAt,
        });
        plan = findById(state.plans, subscription.planId, 'Plan');
      }

      if (type === 'invoice.payment_failed') {
        invoice = upsertInvoiceForSubscription(state, subscription, 'past_due', { amountDueCents });
      } else if (type === 'invoice.paid') {
        invoice = upsertInvoiceForSubscription(state, subscription, 'paid', { amountDueCents });
      } else if (type === 'subscription.canceled') {
        invoice = latestInvoiceForSubscription(state, subscription.id);
        if (invoice && ['open', 'past_due'].includes(invoice.status)) {
          invoice.status = 'void';
          invoice.nextPaymentAttemptAt = null;
        }
      }
      applyInvoiceProviderRefs(invoice, {
        hostedInvoiceUrl,
        nextPaymentAttemptAt,
        providerCustomerId,
        providerEventId,
        providerEventType,
        providerInvoiceId,
        providerPriceId,
        providerSubscriptionId,
        signatureStatus,
        signatureVerifiedAt,
      });

      const entitlement = upsertEntitlementFromSubscription(state, subscription);
      const eventStatus = signatureStatus === 'verified' ? 'verified' : 'recorded';
      const event = appendPaymentEvent(state, {
        tenantId: tenant.id,
        provider: subscription.provider,
        type: providerEventType ?? type,
        status: eventStatus,
        appliedType: type,
        invoiceId: invoice?.id,
        livemode,
        providerCustomerId,
        providerEventId,
        providerEventType,
        providerInvoiceId,
        providerStatus,
        providerSubscriptionId,
        signatureStatus,
        signatureTimestamp,
        signatureVerifiedAt,
        subscriptionId: subscription.id,
      });
      const job = appendJob(state, {
        tenantId: tenant.id,
        queue: 'billing_webhook',
        type: provider === 'stripe' ? `payment.webhook.stripe.${type}` : `payment.webhook.${type}`,
        targetId: invoice?.id ?? subscription.id,
        status: 'succeeded',
        attempts: 1,
        maxAttempts: 5,
        message: signatureStatus === 'verified'
          ? `Applied verified ${provider} webhook ${providerEventType ?? type} as ${type}.`
          : `Applied local payment webhook ${type}.`,
      });

      return {
        message: `Applied ${type}; ${subscription.id} is ${nextStatus}`,
        entitlementId: entitlement?.id,
        eventId: event.id,
        jobId: job.id,
        invoiceId: invoice?.id,
        provider: subscription.provider,
        providerCustomerId: subscription.providerCustomerId,
        providerEventId,
        providerEventType,
        providerInvoiceId: invoice?.providerInvoiceId,
        providerSubscriptionId: subscription.providerSubscriptionId,
        planId: plan.id,
        signatureStatus,
        status: nextStatus,
        subscriptionId: subscription.id,
        targetId: subscription.id,
        tenantId: tenant.id,
      };
    },
    { ...options, requireExplicitActor: true },
  );
}

export async function handleSignedStripePaymentWebhook(rawBody, signatureHeader, {
  endpointSecret = process.env.STRIPE_WEBHOOK_SECRET,
  toleranceSeconds,
  actorUserId,
  statePath,
} = {}) {
  if (!endpointSecret) {
    throw new SignalStateError('STRIPE_WEBHOOK_SECRET is required to verify Stripe webhooks.', {
      code: 'PAYMENT_WEBHOOK_SECRET_MISSING',
      status: 412,
      details: { requiredEnv: 'STRIPE_WEBHOOK_SECRET' },
    });
  }

  let parsed;
  try {
    parsed = parseSignedStripeWebhook(rawBody, signatureHeader, endpointSecret, { toleranceSeconds });
  } catch (error) {
    if (error instanceof PaymentProviderError) {
      throw new SignalStateError(error.message, {
        code: error.code,
        status: error.status,
        details: error.details,
      });
    }
    throw error;
  }

  return handlePaymentWebhook(parsed.mapping.localType, {
    ...parsed.mapping.args,
    livemode: parsed.mapping.livemode,
    provider: parsed.mapping.provider,
    providerEventId: parsed.mapping.providerEventId,
    providerEventType: parsed.mapping.eventType,
    signatureStatus: parsed.verification.signatureStatus,
    signatureTimestamp: parsed.verification.timestamp,
    signatureVerifiedAt: parsed.verification.verifiedAt,
  }, { actorUserId, statePath });
}

function reconcileEmailWebhookInState(state, event) {
  const message = (state.emailDeliveryMessages ?? []).find((candidate) =>
    candidate.id === event.messageId ||
    (event.providerMessageId && candidate.providerMessageId === event.providerMessageId));
  if (!message) {
    throw new SignalStateError('Email delivery message not found for provider webhook.', {
      code: 'EMAIL_DELIVERY_NOT_FOUND',
      status: 404,
      details: {
        messageId: event.messageId,
        providerMessageId: event.providerMessageId,
      },
    });
  }

  message.providerEventIds = message.providerEventIds ?? [];
  if (event.providerEventId && message.providerEventIds.includes(event.providerEventId)) {
    return {
      duplicate: true,
      deliveryMessageId: message.id,
      message: `Ignored duplicate email provider event ${event.providerEventId}.`,
      providerEventId: event.providerEventId,
      status: message.status,
      targetId: message.id,
    };
  }

  const previousStatus = message.status;
  message.status = event.status;
  message.statusReason = event.reason ?? `Provider reported ${event.providerStatus}.`;
  message.provider = event.providerName ?? message.provider;
  message.providerStatus = event.providerStatus;
  message.providerStatusUpdatedAt = nowIso();
  message.providerSignatureStatus = event.signatureStatus ?? message.providerSignatureStatus ?? null;
  message.providerSignatureVerifiedAt = event.signatureVerifiedAt ?? message.providerSignatureVerifiedAt ?? null;
  if (event.providerEventId) {
    message.providerEventIds.push(event.providerEventId);
    message.providerEventId = event.providerEventId;
  }
  if (event.providerMessageId) {
    message.providerMessageId = event.providerMessageId;
  }
  if (event.status === 'sent') {
    message.sentAt = message.sentAt ?? nowIso();
  }
  if (event.status === 'suppressed' && (event.providerStatus === 'unsubscribed' || event.unsubscribeCode)) {
    const preference = (state.notificationPreferences ?? []).find((candidate) =>
      candidate.userId === message.userId || candidate.unsubscribeCode === event.unsubscribeCode);
    if (preference) {
      preference.emailDeliveryStatus = 'unsubscribed';
      preference.channels = (preference.channels ?? []).filter((channel) => channel !== 'email_digest');
      preference.unsubscribedAt = preference.unsubscribedAt ?? nowIso();
      preference.updatedAt = nowIso();
    }
  }

  const job = appendJob(state, {
    tenantId: message.tenantId,
    queue: 'outbound_email',
    type: `email.provider.${event.providerStatus}`,
    targetId: message.id,
    status: 'succeeded',
    attempts: 1,
    maxAttempts: 3,
    message: `${message.id} reconciled from provider status ${event.providerStatus}.`,
  });

  return {
    deliveryMessageId: message.id,
    jobId: job.id,
    message: `${message.id} reconciled as ${event.status}`,
    nextStatus: event.status,
    previousStatus,
    providerEventId: event.providerEventId,
    providerMessageId: message.providerMessageId ?? null,
    providerStatus: event.providerStatus,
    signatureStatus: event.signatureStatus ?? null,
    targetId: message.id,
    userId: message.userId,
  };
}

function reconcileEmailWebhookEventsInState(state, events) {
  const eventList = Array.isArray(events) ? events : [events];
  const reconciled = eventList.map((event) => reconcileEmailWebhookInState(state, event));
  if (reconciled.length === 1) {
    return reconciled[0];
  }
  return {
    count: reconciled.length,
    deliveryMessageIds: reconciled.map((item) => item.deliveryMessageId),
    duplicateCount: reconciled.filter((item) => item.duplicate).length,
    message: `Reconciled ${reconciled.length} email provider event${reconciled.length === 1 ? '' : 's'}.`,
    providerEventIds: reconciled.map((item) => item.providerEventId).filter(Boolean),
    statuses: reconciled.map((item) => item.nextStatus ?? item.status),
    targetId: 'email_provider_batch',
  };
}

export async function handleEmailDeliveryWebhook(payload, options = {}) {
  return mutateState(
    'notifications.delivery-webhook',
    (state, actor) => {
      requireAdmin(actor, 'notifications.delivery-webhook');
      let event;
      try {
        event = parseEmailWebhookPayload(payload);
      } catch (providerError) {
        throw signalErrorFromProviderError(providerError);
      }
      return reconcileEmailWebhookEventsInState(state, event);
    },
    { ...options, requireExplicitActor: true },
  );
}

export async function handleSignedEmailDeliveryWebhook(rawBody, signatureHeader, {
  actorUserId,
  endpointSecret = process.env.SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET,
  statePath,
  toleranceSeconds,
} = {}) {
  if (!endpointSecret) {
    throw new SignalStateError('SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET is required to verify email delivery webhooks.', {
      code: 'EMAIL_WEBHOOK_SECRET_MISSING',
      status: 412,
      details: { requiredEnv: 'SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET' },
    });
  }

  let event;
  try {
    event = parseSignedEmailWebhook(rawBody, signatureHeader, endpointSecret, { toleranceSeconds });
  } catch (providerError) {
    throw signalErrorFromProviderError(providerError);
  }

  return mutateState(
    'notifications.delivery-webhook',
    (state, actor) => {
      requireAdmin(actor, 'notifications.delivery-webhook');
      return reconcileEmailWebhookEventsInState(state, event);
    },
    { actorUserId, requireExplicitActor: true, statePath },
  );
}

export async function handleSignedSendGridEmailDeliveryWebhook(rawBody, signatureHeader, timestampHeader, {
  actorUserId,
  endpointPublicKey = process.env.SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY,
  statePath,
  toleranceSeconds,
} = {}) {
  if (!endpointPublicKey) {
    throw new SignalStateError('SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY is required to verify SendGrid event webhooks.', {
      code: 'EMAIL_WEBHOOK_PUBLIC_KEY_MISSING',
      status: 412,
      details: { requiredEnv: 'SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY' },
    });
  }

  let event;
  try {
    event = parseSignedSendGridWebhook(rawBody, signatureHeader, timestampHeader, endpointPublicKey, { toleranceSeconds });
  } catch (providerError) {
    throw signalErrorFromProviderError(providerError);
  }

  return mutateState(
    'notifications.delivery-webhook',
    (state, actor) => {
      requireAdmin(actor, 'notifications.delivery-webhook');
      return reconcileEmailWebhookEventsInState(state, event);
    },
    { actorUserId, requireExplicitActor: true, statePath },
  );
}

async function runEmailSyncJobInState(state, actor, job, options = {}) {
  const mailbox = findById(state.mailboxes ?? [], job.targetId, 'Mailbox');
  if (job.type === 'mailbox.reauth') {
    mailbox.status = 'needs_reauth';
    const cursor = state.emailSyncCursors?.find((candidate) => candidate.mailboxId === mailbox.id);
    if (cursor) {
      cursor.status = 'blocked';
    }
    throw new SignalStateError(`Mailbox owner reauthorization is required before ${mailbox.id} can sync.`, {
      code: 'MAILBOX_REAUTH_REQUIRED',
      status: 409,
      details: { jobId: job.id, mailboxId: mailbox.id, status: mailbox.status },
    });
  }
  if (mailbox.status !== 'connected') {
    throw new SignalStateError(`Mailbox must be connected before job run: ${mailbox.id}`, {
      code: 'MAILBOX_NOT_CONNECTED',
      status: 409,
      details: { jobId: job.id, mailboxId: mailbox.id, status: mailbox.status },
    });
  }

  const isWatchNotificationJob = String(job.type).endsWith('.watch.notification');
  const sync = await applyProviderSyncAttempt(state, mailbox, job, options);
  if (!sync.active) {
    return {
      cursorId: sync.cursor.id,
      mailboxId: mailbox.id,
      message: `${mailbox.provider} ${job.type} job for ${mailbox.id} deferred by provider backoff.`,
      nextRunAt: sync.nextRunAt,
      providerCredentialRefreshedAt: sync.providerCredentialRefreshedAt,
      providerCredentialSource: sync.providerCredentialSource,
      providerCredentialVaultRef: sync.providerCredentialVaultRef,
      providerErrorCode: sync.providerErrorCode,
      providerResponseStatus: sync.providerResponseStatus,
      providerRetryAfterAt: sync.providerRetryAfterAt,
      status: sync.status,
    };
  }

  let detectorRun = null;
  if (job.type === 'mailbox.sync' || isWatchNotificationJob) {
    detectorRun = runEmailFlowsInState(state, actor, { mailboxId: mailbox.id });
  }

  return {
    cursorId: sync.cursor.id,
    mailboxId: mailbox.id,
    message: detectorRun
      ? `Ran ${mailbox.provider} sync job for ${mailbox.id}; upserted ${sync.sourceMessagesUpserted} source message${sync.sourceMessagesUpserted === 1 ? '' : 's'}; detector run ${detectorRun.runId} created ${detectorRun.createdSignals} signal${detectorRun.createdSignals === 1 ? '' : 's'}.`
      : `Ran ${mailbox.provider} ${job.type} job for ${mailbox.id}; upserted ${sync.sourceMessagesUpserted} source message${sync.sourceMessagesUpserted === 1 ? '' : 's'}.`,
    mode: sync.mode,
    providerCredentialRefreshedAt: sync.providerCredentialRefreshedAt,
    providerCredentialSource: sync.providerCredentialSource,
    providerCredentialVaultRef: sync.providerCredentialVaultRef,
    providerRequestDigest: sync.providerRequestDigest,
    providerResponseDigest: sync.providerResponseDigest,
    runId: detectorRun?.runId,
    sourceMessagesCreated: sync.sourceMessagesCreated,
    sourceMessagesUpdated: sync.sourceMessagesUpdated,
    sourceMessagesUpserted: sync.sourceMessagesUpserted,
    status: 'succeeded',
  };
}

async function runProviderWatchJobInState(state, job, options = {}) {
  const mailbox = findById(state.mailboxes ?? [], job.targetId, 'Mailbox');
  if (mailbox.status !== 'connected') {
    throw new SignalStateError(`Mailbox must be connected before provider watch retry: ${mailbox.id}`, {
      code: 'MAILBOX_NOT_CONNECTED',
      status: 409,
      details: { jobId: job.id, mailboxId: mailbox.id, status: mailbox.status },
    });
  }
  const operation = job.type === 'mailbox.watch.renew' ? 'renewal' : 'setup';
  const existingWatch = operation === 'renewal'
    ? [...(state.emailWatchSubscriptions ?? [])].reverse().find((watch) => watch.mailboxId === mailbox.id)
    : null;
  const attempt = await applyProviderWatchAttempt(state, mailbox, {
    ...options,
    liveProviderWatch: Boolean(options.liveProviderWatch || job.providerRetryAfterAt || job.providerResponseStatus),
  }, {
    existingWatchId: existingWatch?.id ?? null,
    operation,
  });
  if (!attempt.active) {
    return {
      message: `${mailbox.provider} watch ${operation} ${attempt.status}; ${attempt.reason}.`,
      nextRunAt: attempt.providerRetryAfterAt,
      providerCredentialRefreshedAt: attempt.providerCredentialRefreshedAt,
      providerCredentialSource: attempt.providerCredentialSource,
      providerCredentialVaultRef: attempt.providerCredentialVaultRef,
      providerErrorCode: attempt.providerErrorCode,
      providerResponseStatus: attempt.providerResponseStatus,
      providerRetryAfterAt: attempt.providerRetryAfterAt,
      status: attempt.providerRetryAfterAt ? 'queued' : 'failed',
    };
  }
  return {
    message: `${mailbox.provider} watch ${operation} succeeded for ${mailbox.id}.`,
    nextRunAt: null,
    providerCredentialRefreshedAt: attempt.providerCredentialRefreshedAt,
    providerCredentialSource: attempt.providerCredentialSource,
    providerCredentialVaultRef: attempt.providerCredentialVaultRef,
    providerErrorCode: null,
    providerResponseStatus: null,
    providerRetryAfterAt: null,
    status: 'succeeded',
  };
}

async function runOutboundEmailJobInState(state, job, options = {}) {
  const message = findById(state.emailDeliveryMessages ?? [], job.targetId, 'Email delivery message');
  const preference = preferenceForUser(state, message.userId);
  const previousStatus = message.status;
  if (preference.emailDeliveryStatus === 'unsubscribed' || !(preference.channels ?? []).includes('email_digest')) {
    message.status = 'suppressed';
    message.statusReason = 'Suppressed by local worker because the user is unsubscribed from email digests.';
    message.sentAt = null;
    return {
      deliveryMessageId: message.id,
      message: `${message.id} suppressed by local outbound email worker.`,
      previousStatus,
      status: 'succeeded',
    };
  }

  let delivery;
  try {
    delivery = await deliverEmailMessage(message, {
      emailProviderMode: options.emailProviderMode,
      env: options.env ?? process.env,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      liveEmailProvider: Boolean(options.liveEmailProvider),
    });
  } catch (providerError) {
    throw signalErrorFromProviderError(providerError);
  }

  message.status = delivery.status;
  message.sentAt = delivery.status === 'sent' ? delivery.acceptedAt : message.sentAt ?? null;
  message.statusReason = delivery.providerMode === 'live'
    ? 'Accepted by live outbound email provider; awaiting provider status webhooks for later failures or bounces.'
    : 'Accepted by local outbound email worker.';
  message.provider = delivery.provider;
  message.providerMode = delivery.providerMode;
  message.providerMessageId = delivery.providerMessageId;
  message.providerRequestDigest = delivery.providerRequestDigest;
  message.providerResponseDigest = delivery.providerResponseDigest;
  message.providerAcceptedAt = delivery.acceptedAt;
  message.providerStatus = delivery.providerStatus ?? message.providerStatus ?? null;
  message.providerStatusUpdatedAt = delivery.providerStatus ? nowIso() : message.providerStatusUpdatedAt ?? null;
  message.deliveryAttemptCount = (message.deliveryAttemptCount ?? 0) + 1;
  return {
    deliveryMessageId: message.id,
    message: `${message.id} accepted by ${delivery.providerMode === 'live' ? 'live provider' : 'local outbound email worker'}.`,
    previousStatus,
    provider: delivery.provider,
    providerMessageId: delivery.providerMessageId,
    providerMode: delivery.providerMode,
    status: 'succeeded',
  };
}

function reconcileBillingJobInState(state, job) {
  const invoice = (state.invoices ?? []).find((candidate) => candidate.id === job.targetId);
  const subscription = invoice
    ? findById(state.subscriptions ?? [], invoice.subscriptionId, 'Subscription')
    : (state.subscriptions ?? []).find((candidate) => candidate.id === job.targetId);
  if (!subscription) {
    return {
      message: `Acknowledged billing job ${job.id}; no subscription reconciliation target was required.`,
      status: 'succeeded',
    };
  }

  const entitlement = upsertEntitlementFromSubscription(state, subscription);
  if (invoice && invoice.status === 'past_due') {
    invoice.nextPaymentAttemptAt = invoice.nextPaymentAttemptAt ?? expiresInIso(2 * 24 * 60 * 60 * 1000);
  }
  return {
    entitlementId: entitlement?.id,
    invoiceId: invoice?.id,
    message: `Reconciled billing state for ${subscription.id}; entitlement is ${entitlement?.status ?? 'restricted'}.`,
    status: 'succeeded',
    subscriptionId: subscription.id,
  };
}

function runSignalHandoffJobInState(state, actor, job) {
  const handoff = findById(state.signalHandoffs ?? [], job.targetId, 'Signal handoff');
  const signal = findById(state.signals ?? [], handoff.signalId, 'Signal');
  if (handoff.status === 'canceled') {
    return {
      handoffId: handoff.id,
      handoffStatus: handoff.status,
      message: `Skipped canceled ${handoff.target} handoff ${handoff.id}.`,
      signalId: signal.id,
      status: 'succeeded',
      target: handoff.target,
    };
  }

  const acceptedAt = nowIso();
  const providerRequestDigest = sha256Digest(JSON.stringify({
    account: handoff.account,
    handoffId: handoff.id,
    signalId: signal.id,
    target: handoff.target,
    tenantId: handoff.tenantId,
  }));
  const providerRef = handoff.providerRef ?? `${handoff.provider}_${handoff.id}`;
  const previousStatus = handoff.status;
  handoff.status = 'sent';
  handoff.providerRef = providerRef;
  handoff.providerRequestDigest = providerRequestDigest;
  handoff.providerResponseDigest = sha256Digest(JSON.stringify({
    acceptedAt,
    handoffId: handoff.id,
    providerRef,
    status: 'sent',
  }));
  handoff.providerStatus = 'accepted';
  handoff.providerAcceptedAt = acceptedAt;
  handoff.sentAt = handoff.sentAt ?? acceptedAt;
  handoff.updatedAt = acceptedAt;
  handoff.updatedByUserId = actor.id;

  signal.status = 'routed';
  signal.latestHandoffId = handoff.id;
  signal.latestHandoffStatus = handoff.status;

  return {
    handoffId: handoff.id,
    handoffStatus: handoff.status,
    message: `Delivered ${handoff.target} handoff ${handoff.id} to ${handoff.provider}.`,
    previousHandoffStatus: previousStatus,
    provider: handoff.provider,
    providerRef,
    providerRequestDigest: handoff.providerRequestDigest,
    providerResponseDigest: handoff.providerResponseDigest,
    signalId: signal.id,
    status: 'succeeded',
    target: handoff.target,
  };
}

async function runProviderValidationJobInState(state, actor, job, options = {}) {
  const dueSchedules = providerValidationSchedulesDue(state);
  if (dueSchedules.length === 0) {
    const nextRunAt = providerValidationSchedulerJobNextRunAt(state);
    return {
      dueSchedules: [],
      message: nextRunAt
        ? `No provider validation schedules are due; next scheduled run is ${nextRunAt}.`
        : 'No provider validation schedules are due.',
      nextRunAt,
      providerValidationRunId: null,
      providerValidationStatus: null,
      status: 'queued',
    };
  }

  const sandbox = await validateProviderSandbox({
    env: options.env ?? process.env,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    timeoutMs: options.providerSandboxTimeoutMs,
  });
  const recorded = recordProviderSandboxValidationInState(state, actor, sandbox);
  const nextRunAt = providerValidationSchedulerJobNextRunAt(state);
  return {
    dueSchedules: dueSchedules.map((schedule) => schedule.providerId),
    message: `Recorded scheduled provider validation ${recorded.status}: ${recorded.summary.passed}/${recorded.summary.total} providers passed.`,
    nextRunAt,
    providerResponseDigest: recorded.reportDigest,
    providerValidationRunId: recorded.id,
    providerValidationStatus: recorded.status,
    status: 'queued',
  };
}

async function runLocalJobInState(state, actor, job, options = {}) {
  if (job.queue === 'provider_validation') {
    return runProviderValidationJobInState(state, actor, job, options);
  }
  if (job.queue === 'email_sync' && (job.type === 'mailbox.watch.setup' || job.type === 'mailbox.watch.renew')) {
    return runProviderWatchJobInState(state, job, options);
  }
  if (job.queue === 'email_sync') {
    return runEmailSyncJobInState(state, actor, job, options);
  }
  if (job.queue === 'signal_detection') {
    return runEmailFlowsInState(state, actor, {});
  }
  if (job.queue === 'notification_digest') {
    return runNotificationDigestInState(state, actor, { tenantId: job.tenantId });
  }
  if (job.queue === 'outbound_email') {
    return runOutboundEmailJobInState(state, job, options);
  }
  if (job.queue === 'billing_webhook') {
    return reconcileBillingJobInState(state, job);
  }
  if (job.queue === 'signal_handoff') {
    return runSignalHandoffJobInState(state, actor, job);
  }
  if (job.queue === 'governance' || job.queue === 'user_onboarding') {
    return {
      message: `Acknowledged ${job.queue} job ${job.id} for ${job.targetId}.`,
      status: 'succeeded',
    };
  }
  throw new SignalStateError(`No local worker is registered for queue: ${job.queue}`, {
    code: 'JOB_WORKER_UNSUPPORTED',
    status: 409,
    details: { jobId: job.id, queue: job.queue, type: job.type },
  });
}

function jobRunLimit(limit) {
  if (limit === undefined || limit === null || limit === '') {
    return 10;
  }
  const numericLimit = Number(limit);
  if (!Number.isInteger(numericLimit) || numericLimit < 1 || numericLimit > 100) {
    throw new SignalStateError(`Invalid job run limit: ${limit}`, {
      code: 'ARG_INVALID',
      details: { limit, max: 100, min: 1, usage: 'jobs run [jobId|queue] [--limit <count>]' },
    });
  }
  return numericLimit;
}

function jobIsDue(job, now = Date.now()) {
  if (!job.nextRunAt) {
    return true;
  }
  const nextRunMs = Date.parse(job.nextRunAt);
  return !Number.isFinite(nextRunMs) || nextRunMs <= now;
}

export async function runJobs({ jobId, queue, limit } = {}, options = {}) {
  return mutateState(
    'jobs.run',
    async (state, actor) => {
      requireAdmin(actor, 'jobs.run');
      const maxJobs = jobRunLimit(limit);
      const runnableStatuses = ['queued', 'running'];
      let jobs;
      if (jobId) {
        const job = findById(state.jobs ?? [], jobId, 'Job');
        if (!runnableStatuses.includes(job.status)) {
          throw new SignalStateError(`Job is not runnable: ${job.id}`, {
            code: 'JOB_NOT_RUNNABLE',
            status: 409,
            details: { jobId: job.id, status: job.status },
          });
        }
        jobs = jobIsDue(job) ? [job] : [];
      } else {
        jobs = (state.jobs ?? [])
          .filter((job) => runnableStatuses.includes(job.status) && (!queue || job.queue === queue))
          .filter((job) => jobIsDue(job))
          .slice(0, maxJobs);
      }

      const outcomes = [];
      for (const job of jobs) {
        const previousStatus = job.status;
        job.status = 'running';
        job.attempts = Math.max(1, job.attempts ?? 0);
        job.lastRunAt = nowIso();
        try {
          const result = await runLocalJobInState(state, actor, job, options);
          job.status = result.status ?? 'succeeded';
          job.lastRunAt = nowIso();
          job.message = result.message;
          if (result.nextRunAt !== undefined) {
            job.nextRunAt = result.nextRunAt;
          }
          if (result.providerCredentialRefreshedAt !== undefined) {
            job.providerCredentialRefreshedAt = result.providerCredentialRefreshedAt;
          }
          if (result.providerCredentialSource !== undefined) {
            job.providerCredentialSource = result.providerCredentialSource;
          }
          if (result.providerCredentialVaultRef !== undefined) {
            job.providerCredentialVaultRef = result.providerCredentialVaultRef;
          }
          if (result.providerErrorCode !== undefined) {
            job.providerErrorCode = result.providerErrorCode;
          }
          if (result.providerRequestDigest !== undefined) {
            job.providerRequestDigest = result.providerRequestDigest;
          }
          if (result.providerResponseDigest !== undefined) {
            job.providerResponseDigest = result.providerResponseDigest;
          }
          if (result.providerResponseStatus !== undefined) {
            job.providerResponseStatus = result.providerResponseStatus;
          }
          if (result.providerRetryAfterAt !== undefined) {
            job.providerRetryAfterAt = result.providerRetryAfterAt;
          }
          if (result.providerValidationRunId !== undefined) {
            job.providerValidationRunId = result.providerValidationRunId;
          }
          if (result.providerValidationStatus !== undefined) {
            job.providerValidationStatus = result.providerValidationStatus;
          }
          if (result.sourceMessagesCreated !== undefined) {
            job.sourceMessagesCreated = result.sourceMessagesCreated;
          }
          if (result.sourceMessagesUpdated !== undefined) {
            job.sourceMessagesUpdated = result.sourceMessagesUpdated;
          }
          if (result.sourceMessagesUpserted !== undefined) {
            job.sourceMessagesUpserted = result.sourceMessagesUpserted;
          }
          outcomes.push({
            jobId: job.id,
            previousStatus,
            queue: job.queue,
            status: job.status,
            type: job.type,
            ...result,
          });
        } catch (error) {
          const signalError = error instanceof SignalStateError ? error : new SignalStateError(error instanceof Error ? error.message : String(error), { code: 'JOB_RUN_FAILED' });
          job.status = 'failed';
          job.lastRunAt = nowIso();
          job.message = signalError.message;
          outcomes.push({
            code: signalError.code,
            error: signalError.message,
            jobId: job.id,
            previousStatus,
            queue: job.queue,
            status: 'failed',
            type: job.type,
          });
        }
      }
      const failed = outcomes.filter((outcome) => outcome.status === 'failed').length;
      const succeeded = outcomes.length - failed;
      return {
        message: `Ran ${outcomes.length} local job${outcomes.length === 1 ? '' : 's'} (${succeeded} succeeded, ${failed} failed)`,
        count: outcomes.length,
        failed,
        jobId: jobId ?? null,
        outcomes,
        queue: queue ?? null,
        succeeded,
        targetId: jobId ?? queue ?? 'queued_jobs',
      };
    },
    { ...options, retryOnConflict: false },
  );
}

export async function retryJob(jobId, options = {}) {
  return mutateState(
    'jobs.retry',
    (state, actor) => {
      requireAdmin(actor, 'jobs.retry');
      const job = findById(state.jobs ?? [], requireArg(jobId, 'job id', 'jobs retry <jobId>'), 'Job');
      if (job.status !== 'failed') {
        throw new SignalStateError(`Only failed jobs can be retried: ${job.id}`, {
          code: 'JOB_NOT_FAILED',
          status: 409,
          details: { jobId: job.id, status: job.status },
        });
      }
      if ((job.attempts ?? 0) >= (job.maxAttempts ?? 3)) {
        throw new SignalStateError(`Job retry attempts exhausted: ${job.id}`, {
          code: 'JOB_RETRY_EXHAUSTED',
          status: 409,
          details: { attempts: job.attempts, jobId: job.id, maxAttempts: job.maxAttempts },
        });
      }
      const previousStatus = job.status;
      job.status = 'queued';
      job.attempts = (job.attempts ?? 0) + 1;
      job.lastRunAt = null;
      job.message = `Retry queued by ${actor.email}.`;
      job.nextRunAt = null;
      job.providerErrorCode = null;
      job.providerResponseStatus = null;
      job.providerRetryAfterAt = null;
      return {
        message: `${job.id} queued for retry`,
        nextStatus: job.status,
        previousStatus,
        targetId: job.id,
        jobId: job.id,
      };
    },
    options,
  );
}

export async function drainJobs(queue, options = {}) {
  return mutateState(
    'jobs.drain',
    (state, actor) => {
      requireAdmin(actor, 'jobs.drain');
      const jobs = (state.jobs ?? []).filter((job) => ['queued', 'running'].includes(job.status) && (!queue || job.queue === queue));
      jobs.forEach((job) => {
        job.status = 'drained';
        job.lastRunAt = nowIso();
        job.message = `Drained by ${actor.email}.`;
      });
      return {
        message: `${jobs.length} ${queue ? `${queue} ` : ''}job${jobs.length === 1 ? '' : 's'} drained`,
        count: jobs.length,
        queue: queue ?? null,
        targetId: queue ?? 'all_jobs',
      };
    },
    options,
  );
}

export async function applyMutation(action, args = {}, options = {}) {
  switch (action) {
    case 'session.token':
      return issueSessionToken(args.userId, { ...options, ttlSeconds: args.ttlSeconds });
    case 'session.revoke':
      return revokeSessionToken(args.sessionRef ?? args.sessionId ?? args.digest ?? args.token, options);
    case 'tenants.create':
      return createTenantWorkspace(args, options);
    case 'tenants.onboarding-complete':
      return completeTenantOnboarding(args.tenantId, options);
    case 'tenants.status':
      return setTenantStatus(args.tenantId, args.status, args, options);
    case 'tenants.domain':
      return setTenantDomain(args.tenantId, args.domain, options);
    case 'users.role':
      return setUserRole(args.userId, args.role, options);
    case 'users.disable':
      return setUserStatus(args.userId, 'disabled', options);
    case 'users.activate':
      return setUserStatus(args.userId, 'active', options);
    case 'users.invite':
      return createUserInvite(args, options);
    case 'users.invite-accept':
      return acceptUserInvite(args.inviteId, args, options);
    case 'users.invite-revoke':
      return revokeUserInvite(args.inviteId, options);
    case 'mailboxes.pause':
      return setMailboxStatus(args.mailboxId, 'paused', options);
    case 'mailboxes.resume':
      return setMailboxStatus(args.mailboxId, 'connected', options);
    case 'mailboxes.connect-url':
      return createMailboxConnectionSession(args, options);
    case 'mailboxes.complete':
      return completeMailboxConnection(args.sessionId, options);
    case 'mailboxes.oauth-callback':
      return completeMailboxConnectionFromOAuthCallback(args.provider, args, options);
    case 'mailboxes.disconnect':
      return disconnectMailbox(args.mailboxId, options);
    case 'mailboxes.sync':
      return syncMailbox(args.mailboxId, { ...options, liveProviderSync: args.liveProviderSync ?? options.liveProviderSync });
    case 'mailboxes.replay':
      return replayMailbox(args.mailboxId, { ...options, liveProviderSync: args.liveProviderSync ?? options.liveProviderSync });
    case 'mailboxes.watch':
      return setupMailboxWatch(args.mailboxId, options);
    case 'mailboxes.watch-renew':
      return renewMailboxWatch(args.watchId, options);
    case 'mailboxes.watch-notification':
      return handleProviderWatchNotification(args.provider, args.payload, options);
    case 'email-flows.enable':
      return setEmailFlowStatus(args.flowId, 'enabled', options);
    case 'email-flows.disable':
      return setEmailFlowStatus(args.flowId, 'disabled', options);
    case 'email-flows.route':
      return setEmailFlowRouting(args.flowId, args, options);
    case 'email-flows.run':
      return runEmailFlows(args, options);
    case 'integrations.sandbox.record':
      return recordProviderSandboxValidation(args.sandbox ?? args, options);
    case 'integrations.sandbox.evidence-export':
      return exportProviderSandboxEvidence(args.runId ?? args.runRef ?? 'latest', options);
    case 'integrations.sandbox.evidence-import':
      return importProviderSandboxEvidence(args.artifact ?? args, options);
    case 'integrations.schedule':
      return setProviderValidationSchedule(args.providerId, args, options);
    case 'accounts.action-status':
      return setAccountActionStatus(args.actionId, args.status, options);
    case 'accounts.review':
      return createAccountReview(args.account ?? args.accountName ?? args.accountId, args, options);
    case 'quality.threshold':
      return setSignalQualityThreshold(args.tenantId, args.minimumConfidence, options);
    case 'quality.suppression-add':
      return createSuppressionRule(args, options);
    case 'quality.suppression-status':
      return setSuppressionRuleStatus(args.ruleId, args.status, options);
    case 'models.policy':
      return setModelGovernancePolicy(args.tenantId, args, options);
    case 'governance.policy':
      return setGovernancePolicy(args.tenantId, args, options);
    case 'governance.redaction-add':
      return createRedactionRule(args, options);
    case 'governance.redaction-status':
      return setRedactionRuleStatus(args.ruleId, args.status, options);
    case 'governance.request-create':
      return createDataRequest(args, options);
    case 'governance.request-status':
      return setDataRequestStatus(args.requestId, args.status, args, options);
    case 'governance.incident-add':
      return createIncidentNote(args, options);
    case 'governance.incident-resolve':
      return resolveIncidentNote(args.incidentId, options);
    case 'notifications.preference':
      return setNotificationPreference(args.userId, args.patch ?? args, options);
    case 'notifications.status':
      return setNotificationStatus(args.notificationId, args.status, options);
    case 'notifications.digest-run':
      return runNotificationDigest(args, options);
    case 'notifications.delivery-status':
      return setEmailDeliveryStatus(args.messageId, args.status, args, options);
    case 'notifications.delivery-webhook':
      return handleEmailDeliveryWebhook(args.payload ?? args, options);
    case 'notifications.unsubscribe':
      return unsubscribeEmailDigest(args.userOrToken ?? args.userId ?? args.code, options);
    case 'signals.assign':
      return assignSignal(args.signalId, args.userId, options);
    case 'signals.status':
      return setSignalStatus(args.signalId, args.status, options);
    case 'signals.feedback':
      return recordSignalFeedback(args.signalId, args.label, args, options);
    case 'signals.handoff':
      return createSignalHandoff(args.signalId, args, options);
    case 'signals.handoff-status':
      return setSignalHandoffStatus(args.handoffId, args.status, args, options);
    case 'payments.comp':
      return compTenant(args.tenantId, args.planId, options);
    case 'payments.override':
      return createBillingOverride(args.tenantId, args.type, args, options);
    case 'payments.override-revoke':
      return revokeBillingOverride(args.overrideId, args, options);
    case 'payments.sync':
      return syncPaymentState(args, options);
    case 'payments.status':
      return setSubscriptionStatus(args.subscriptionId, args.status, options);
    case 'payments.cancel':
      return cancelSubscription(args.subscriptionId, options);
    case 'payments.checkout':
      return createCheckoutSession(args.tenantId, args.planId, {
        ...options,
        livePaymentProvider: args.livePaymentProvider,
        paymentProviderMode: args.paymentProviderMode,
        stripeCustomerId: args.stripeCustomerId,
      });
    case 'payments.portal':
      return createBillingPortalSession(args.tenantId, {
        ...options,
        livePaymentProvider: args.livePaymentProvider,
        paymentProviderMode: args.paymentProviderMode,
        stripeCustomerId: args.stripeCustomerId,
      });
    case 'payments.recover':
      return createInvoiceRecoverySession(args.invoiceId, options);
    case 'payments.webhook':
      return handlePaymentWebhook(args.type, args, options);
    case 'jobs.run':
      return runJobs(args, { ...options, liveProviderSync: args.liveProviderSync ?? options.liveProviderSync });
    case 'jobs.retry':
      return retryJob(args.jobId, options);
    case 'jobs.drain':
      return drainJobs(args.queue, options);
    default:
      throw new SignalStateError(`Unknown mutation action: ${action}`, {
        code: 'UNKNOWN_MUTATION',
        status: 404,
        details: { action },
      });
  }
}
