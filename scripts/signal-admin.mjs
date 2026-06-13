#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  SignalStateError,
  acceptUserInvite,
  assignSignal,
  bootstrapState,
  cancelSubscription,
  claimUserInvite,
  completeTenantOnboarding,
  completeMailboxConnection,
  compTenant,
  createBillingOverride,
  createSuppressionRule,
  createAccountReview,
  createBillingPortalSession,
  createCheckoutSession,
  createDataRequest,
  createInvoiceRecoverySession,
  createIncidentNote,
  createMailboxConnectionSession,
  createRedactionRule,
  createSignalHandoff,
  createTenantWorkspace,
  completionAuditReport,
  createUserInvite,
  dashboardAuditReport,
  completeMailboxConnectionFromOAuthCallback,
  disconnectMailbox,
  drainJobs,
  doctor,
  emailHandoffReport,
  formatStatus,
  handlePaymentWebhook,
  handleSignedStripePaymentWebhook,
  handleEmailDeliveryWebhook,
  handleSignedEmailDeliveryWebhook,
  handleSignedSendGridEmailDeliveryWebhook,
  handleProviderWatchNotification,
  issueSessionToken,
  backendHandoffReport,
  backendCutoverDrillReport,
  localAgentHandoffReport,
  launchGateReport,
  lifecyclePlaybookReport,
  listApiSessions,
  loadState,
  modelGovernanceReports,
  onboardingReadinessReport,
  operationsHealthReport,
  paymentHandoffReport,
  paymentLifecycleAuditReport,
  loadProductionEnvTemplate,
  productionEnvAuditReport,
  productionOperationsDrillReport,
  productionSetupPlanReport,
  providerHandoffReport,
  providerLaunchMatrixReport,
  providerReadiness,
  qaAnswersReport,
  providerValidationSchedulesDue,
  productReadinessReport,
  registerTenantWorkspace,
  recordInvoiceRefund,
  schedulerHandoffReport,
  exportProviderSandboxEvidence,
  importProviderSandboxEvidence,
  replayMailbox,
  renewMailboxWatch,
  recordProviderSandboxValidation,
  recordSignalFeedback,
  requeueDeadLetterJob,
  resolveIncidentNote,
  retryJob,
  runJobs,
  runNotificationDigest,
  runEmailFlows,
  revokeSessionToken,
  revokeBillingOverride,
  revokeUserSessions,
  revokeUserInvite,
  setAccountActionStatus,
  setEmailFlowStatus,
  setMailboxStatus,
  setNotificationPreference,
  setNotificationStatus,
  setEmailDeliveryStatus,
  setSignalQualityThreshold,
  setSignalHandoffStatus,
  setSignalStatus,
  setDataRequestStatus,
  setGovernancePolicy,
  setModelGovernancePolicy,
  setEmailFlowRouting,
  setProviderValidationSchedule,
  setRedactionRuleStatus,
  setSuppressionRuleStatus,
  setSubscriptionStatus,
  setTenantDomain,
  setTenantStatus,
  setUserRole,
  setUserStatus,
  signalDigestionPipelineReport,
  setupMailboxWatch,
  summarizeState,
  tenantIsolationAuditReport,
  syncPaymentState,
  switchSession,
  syncMailbox,
  unsubscribeEmailDigest,
  verifyLocalSessionToken,
  table,
  resolveStatePath,
} from './signal-state.mjs';
import {
  signStripeWebhookPayload,
} from './signal-payment-provider.mjs';
import {
  signEmailWebhookPayload,
} from './signal-email-provider.mjs';
import {
  listProviderCredentialRecords,
  rotateProviderCredentialVault,
  verifyProviderCredentialVault,
} from './signal-token-vault.mjs';
import {
  validateProviderSandbox,
} from './signal-provider-sandbox.mjs';
import {
  backendReadiness,
} from './signal-backend-readiness.mjs';

const args = process.argv.slice(2);
const positionals = positionalArgs(args);
const command = positionals[0] ?? 'help';
const subcommand = positionals[1] ?? null;
const flags = new Set(args.filter((arg) => arg.startsWith('-')));
const wantsJson = flags.has('--json');
const force = flags.has('--force');
const confirmed = flags.has('--yes');
const dryRun = flags.has('--dry-run');
const saveEvidencePath = optionValue('--save-evidence');
const envFilePath = optionValue('--env-file');
const envTemplatePath = optionValue('--template');
const livePaymentProvider = flags.has('--live-provider') || process.env.SIGNAL_PAYMENT_PROVIDER_MODE === 'live';
const liveProviderWatch = flags.has('--live-provider') || process.env.SIGNAL_PROVIDER_WATCH_MODE === 'live';
const liveProviderSync = flags.has('--live-provider') || process.env.SIGNAL_PROVIDER_SYNC_MODE === 'live';
const actorFlagIndex = args.findIndex((arg) => arg === '--actor');
const actorUserId = actorFlagIndex >= 0 ? args[actorFlagIndex + 1] : process.env.SIGNAL_ADMIN_ACTOR;
const ttlFlagIndex = args.findIndex((arg) => arg === '--ttl-seconds');
const ttlSeconds = ttlFlagIndex >= 0 ? Number(args[ttlFlagIndex + 1]) : undefined;
const limitFlagIndex = args.findIndex((arg) => arg === '--limit');
const limit = limitFlagIndex >= 0 ? Number(args[limitFlagIndex + 1]) : undefined;
const stripeCustomerFlagIndex = args.findIndex((arg) => arg === '--stripe-customer');
const stripeCustomerId = stripeCustomerFlagIndex >= 0 ? args[stripeCustomerFlagIndex + 1] : undefined;
const amountValue = optionValue('--amount');
const planValue = optionValue('--plan');
const providerInvoiceValue = optionValue('--provider-invoice');
const providerPriceValue = optionValue('--provider-price');
const mutationOptions = { actorUserId, livePaymentProvider, liveProviderSync, liveProviderWatch, stripeCustomerId, ttlSeconds };

function positionalArgs(argv) {
  const valueOptions = new Set([
    '--actor',
    '--env-file',
    '--input',
    '--limit',
    '--output',
    '--amount',
    '--plan',
    '--provider-invoice',
    '--provider-price',
    '--save-evidence',
    '--stripe-customer',
    '--template',
    '--ttl-seconds',
  ]);
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (valueOptions.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      continue;
    }
    values.push(arg);
  }
  return values;
}

function optionValue(name) {
  const index = args.findIndex((arg) => arg === name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  return value && !value.startsWith('-') ? value : undefined;
}

function resolveCliPath(inputPath, usage = 'payments webhook-signed <payload.json> <Stripe-Signature>') {
  if (!inputPath) {
    throw new SignalStateError('File path is required.', {
      code: 'ARG_MISSING',
      details: { usage },
    });
  }
  return path.resolve(process.cwd(), inputPath);
}

async function writeJsonFile(inputPath, value, usage) {
  const outputPath = resolveCliPath(inputPath, usage);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return outputPath;
}

async function readJsonFile(inputPath, usage) {
  const inputFilePath = resolveCliPath(inputPath, usage);
  try {
    return JSON.parse(await fs.readFile(inputFilePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SignalStateError(`Invalid JSON file: ${inputFilePath}`, {
        code: 'ARG_INVALID',
        details: { usage },
      });
    }
    throw error;
  }
}

function parseEnvFile(contents) {
  const parsed = {};
  const invalid = [];
  contents.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }
    const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const separatorIndex = normalized.indexOf('=');
    if (separatorIndex <= 0) {
      invalid.push(index + 1);
      return;
    }
    const key = normalized.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      invalid.push(index + 1);
      return;
    }
    let value = normalized.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const commentIndex = value.search(/\s#/);
      if (commentIndex >= 0) {
        value = value.slice(0, commentIndex).trim();
      }
    }
    if (/<[^>]+>/.test(value)) {
      value = '';
    }
    parsed[key] = value;
  });
  return { invalid, parsed };
}

async function readinessEnv() {
  if (!envFilePath) {
    return {
      env: process.env,
      source: {
        configuredKeys: 0,
        keys: [],
        path: null,
        type: 'process',
      },
    };
  }
  const inputFilePath = resolveCliPath(envFilePath, 'launch-gate --env-file <path>');
  const { invalid, parsed } = parseEnvFile(await fs.readFile(inputFilePath, 'utf8'));
  if (invalid.length) {
    throw new SignalStateError('Invalid env file syntax.', {
      code: 'ENV_FILE_INVALID',
      details: {
        invalidLines: invalid,
        path: inputFilePath,
      },
    });
  }
  const keys = Object.keys(parsed).sort();
  return {
    env: { ...process.env, ...parsed },
    source: {
      configuredKeys: keys.length,
      keys,
      path: inputFilePath,
      type: 'env-file',
    },
  };
}

function stripeWebhookSecret() {
  const value = process.env.STRIPE_WEBHOOK_SECRET;
  if (!value) {
    throw new SignalStateError('STRIPE_WEBHOOK_SECRET is required for signed Stripe webhook commands.', {
      code: 'PAYMENT_WEBHOOK_SECRET_MISSING',
      status: 412,
      details: { requiredEnv: 'STRIPE_WEBHOOK_SECRET' },
    });
  }
  return value;
}

function emailWebhookSecret() {
  const value = process.env.SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET;
  if (!value) {
    throw new SignalStateError('SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET is required for signed email webhook commands.', {
      code: 'EMAIL_WEBHOOK_SECRET_MISSING',
      status: 412,
      details: { requiredEnv: 'SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET' },
    });
  }
  return value;
}

function sendGridWebhookPublicKey() {
  const value = process.env.SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
  if (!value) {
    throw new SignalStateError('SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY is required for signed SendGrid webhook commands.', {
      code: 'EMAIL_WEBHOOK_PUBLIC_KEY_MISSING',
      status: 412,
      details: { requiredEnv: 'SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY' },
    });
  }
  return value;
}

const commands = [
  ['bootstrap', 'Create local state from data/sample-seed.json'],
  ['status', 'Summarize tenants, users, mailboxes, signals, and payments'],
  ['readiness', 'Audit product readiness across onboarding, RBAC, email flow, models, notifications, payments, providers, backend, and local agent ops'],
  ['completion-audit', 'Audit the full local SaaS completion goal across public, onboarding, user, admin, CLI, email, and payment surfaces'],
  ['agent-handoff', 'Show the next ranked local-agent action across launch gates, provider proof, backend, scheduler, and evidence packaging'],
  ['backend-handoff', 'Rank production backend setup work across durable state, auth, tenant isolation, scheduler, backup, migration, and runbook proof'],
  ['backend-cutover', 'Drill the local-agent cutover from local JSON state to the external state-service backend'],
  ['onboarding-readiness', 'Audit workspace registration, invitations, multi-member org support, RBAC controls, and member data privacy'],
  ['tenant-isolation', 'Audit multi-user tenant membership boundaries, actor-scoped visibility, admin gates, and production RLS/auth evidence'],
  ['dashboard-audit', 'Compare user/admin dashboard calculations with shared state summary and backend boundary'],
  ['digestion-pipeline', 'Audit email ingestion, source digestion, detector runs, quality feedback, routing outcomes, and model-learning policy'],
  ['operations-health', 'Audit webhooks, provider backoff, worker queues, lifecycle notices, outbound email, and billing event monitoring'],
  ['production-env', 'Audit selected production env names and .env.production.example template coverage without printing secret values'],
  ['production-drill', 'Audit production backend, state-service backup/restore, identity, scheduler, live-provider tests, and alerting rehearsal'],
  ['production-plan', 'Show the ordered production setup plan across backend, auth, providers, scheduler, launch evidence, owners, env names, and proof commands'],
  ['provider-handoff', 'Rank signed-session, Gmail, Outlook, SendGrid/outbound email, and Stripe launch work for local agents'],
  ['provider-launch', 'Audit provider-by-provider launch readiness, required evidence, live commands, and signed webhook replay proof'],
  ['email-handoff', 'Rank Gmail, Outlook, and outbound email launch work across env, watches, digest sends, signed webhooks, sandbox evidence, and rollback'],
  ['payment-lifecycle', 'Audit subscription start, Checkout/Portal, failed payment recovery, cancellation, entitlements, and signed Stripe webhook replay'],
  ['payment-handoff', 'Rank Stripe payment launch work across env, Checkout/Portal, signed webhooks, recovery, entitlements, sandbox evidence, and rollback'],
  ['qa-answers', 'Answer stakeholder QA for dashboard calculations, models, multi-user orgs, priorities, relationships, notifications, payments, and launch caveats'],
  ['launch-gate', 'Show go-live blockers, required env names, proof commands, owner areas, write a package, or verify a package'],
  ['session', 'Show, switch, issue, or verify signed local API sessions'],
  ['tenants', 'List workspaces, domains, suspension state, seats, and plans; run: tenants register|create|complete-onboarding|status|domain'],
  ['users', 'List users and invites, or run: users invite|claim|accept|revoke|role|disable|activate'],
  ['mailboxes', 'List sources, or run: mailboxes connect-url|callback|complete|pause|resume|disconnect|sync|replay|watch|renew-watch'],
  ['email-flows', 'List flows, or run: email-flows route|enable|disable|run'],
  ['quality', 'Inspect detector thresholds, suppression rules, and feedback; run: quality threshold|suppress|rule'],
  ['models', 'Inspect tenant data digestion and model-learning governance; run: models policy'],
  ['governance', 'Inspect retention, redaction, export/delete requests, and incidents; run: governance policy|redact|request|incident'],
  ['integrations', 'Inspect Gmail, Outlook, SendGrid, and Stripe provider readiness; run: integrations validate-sandbox|evidence-export|evidence-import|run-scheduled|schedule'],
  ['accounts', 'List account health, timeline events, and next actions; run: accounts review|timeline|action'],
  ['notifications', 'List alert events, delivery, and preferences, or run: notifications preference|status|digest|delivery-status|webhook|sendgrid-webhook-signed|unsubscribe|mute-account|mute-type'],
  ['signals', 'List signals, or run: signals assign|status|feedback|handoff|handoff-status'],
  ['payments', 'List payments, or run: payments sync|override|override-revoke|comp|status|cancel|checkout|portal|recover|webhook|webhook-signed|webhook-sign'],
  ['lifecycle', 'List source-backed lifecycle notices for billing, provider, source, onboarding, and notification states'],
  ['lifecycle-playbook', 'Explain admin/user handling for onboarding, RBAC, disconnects, notifications, failed payment, cancellation, and resubscription'],
  ['jobs', 'List jobs, or run: jobs run|retry|drain'],
  ['backend', 'Inspect local-vs-production backend, auth, scheduler, CORS, and tenant isolation readiness'],
  ['scheduler-handoff', 'Rank production scheduler, retry, monitoring, and rollback proof for local agents'],
  ['doctor', 'Run local readiness checks'],
  ['export', 'Print full local state; use --json for agent handoff'],
];

function emit(value) {
  if (wantsJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (typeof value === 'string') {
    console.log(value);
    return;
  }

  console.log(JSON.stringify(value, null, 2));
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof SignalStateError ? error.details : {};
  const code = error instanceof SignalStateError ? error.code : 'CLI_ERROR';

  if (wantsJson) {
    console.error(JSON.stringify({ ok: false, code, error: message, ...details }, null, 2));
  } else {
    console.error(message);
    if (details.usage) {
      console.error(`Usage: npm run admin -- ${details.usage}`);
    }
  }
  process.exit(1);
}

function emitMutation(result) {
  emit(
    wantsJson
      ? {
          ok: true,
          action: result.action,
          actor: {
            email: result.actor.email,
            id: result.actor.id,
            name: result.actor.name,
            role: result.actor.role,
          },
          details: result.details,
          summary: result.summary,
        }
      : `${result.action}: ${result.details.message} (${result.actor.email})`,
  );
}

function unknownSubcommand() {
  throw new SignalStateError(`Unknown ${command} subcommand: ${subcommand}`, {
    code: 'UNKNOWN_SUBCOMMAND',
    details: { command, subcommand },
  });
}

async function listUsers() {
  const state = await loadState();
  const memberships = state.memberships ?? [];
  const rows = state.users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    team: user.team ?? '-',
    status: user.status,
  }));
  const membershipRows = memberships.map((membership) => ({
    id: membership.id,
    tenant: membership.tenantId,
    user: membership.userId,
    role: membership.role,
    team: membership.team ?? '-',
    status: membership.status,
  }));
  const inviteRows = (state.invites ?? []).map((invite) => ({
    id: invite.id,
    email: invite.email,
    role: invite.role,
    team: invite.team ?? '-',
    status: invite.status,
    expires: invite.expiresAt ? new Date(invite.expiresAt).toISOString().slice(0, 10) : '-',
  }));
  emit(
    wantsJson
      ? { ok: true, users: state.users, memberships, invites: state.invites, summary: summarizeState(state) }
      : [
          table(rows, ['id', 'name', 'email', 'role', 'team', 'status']),
          '',
          'Memberships',
          table(membershipRows, ['id', 'tenant', 'user', 'role', 'team', 'status']),
          '',
          `Seats: ${activeSeatText(summarizeState(state))}`,
          '',
          'Invites',
          table(inviteRows, ['id', 'email', 'role', 'team', 'status', 'expires']),
        ].join('\n'),
  );
}

function activeSeatText(summary) {
  return `${summary.activeSeats}+${summary.pendingInviteSeats}/${summary.seatLimit ?? 'unlimited'} active+pending`;
}

async function listTenants() {
  const state = await loadState();
  const rows = state.tenants.map((tenant) => {
    const plan = state.plans.find((item) => item.id === tenant.planId);
    const subscription = state.subscriptions.find((item) => item.tenantId === tenant.id);
    const entitlement = state.entitlements.find((item) => item.tenantId === tenant.id);
    const activeSeats = (state.memberships ?? []).filter((membership) => membership.tenantId === tenant.id && membership.status === 'active').length;
    const pendingSeats = (state.invites ?? []).filter((invite) => invite.tenantId === tenant.id && invite.status === 'pending').length;
    return {
      id: tenant.id,
      name: tenant.name,
      domain: tenant.domain,
      status: tenant.status,
      onboarding: tenant.registrationStatus ?? 'pending_onboarding',
      seats: `${activeSeats}+${pendingSeats}/${entitlement?.seatLimit ?? plan?.seatLimit ?? 'unlimited'}`,
      plan: plan?.name ?? tenant.planId,
      subscription: subscription?.status ?? '-',
      billingOwner: tenant.billingOwnerUserId ?? tenant.ownerUserId ?? '-',
    };
  });
  emit(
    wantsJson
      ? { ok: true, tenants: state.tenants, summary: summarizeState(state) }
      : table(rows, ['id', 'name', 'domain', 'status', 'onboarding', 'seats', 'plan', 'subscription', 'billingOwner']),
  );
}

async function listSession() {
  const state = await loadState();
  const activeUser = state.users.find((user) => user.id === state.session?.activeUserId) ?? null;
  const rows = state.users.map((user) => ({
    id: user.id,
    name: user.name,
    role: user.role,
    status: user.status,
    active: user.id === activeUser?.id ? 'yes' : '',
  }));
  const apiSessionRows = listApiSessions(state).map((session) => ({
    id: session.id,
    user: session.userId,
    status: session.status,
    issued: session.issuedAt ? new Date(session.issuedAt).toISOString().slice(0, 16) : '-',
    expires: session.expiresAt ? new Date(session.expiresAt).toISOString().slice(0, 16) : '-',
    digest: session.digest,
  }));
  emit(
    wantsJson
      ? { ok: true, activeUser, apiSessions: listApiSessions(state), availableUsers: state.users, session: state.session }
      : [
          `Active session: ${activeUser ? `${activeUser.name} (${activeUser.role})` : 'none'}`,
          '',
          table(rows, ['id', 'name', 'role', 'status', 'active']),
          '',
          'API sessions',
          table(apiSessionRows, ['id', 'user', 'status', 'issued', 'expires', 'digest']),
        ].join('\n'),
  );
}

async function listMailboxes() {
  const state = await loadState();
  const credentialRecords = await listProviderCredentialRecords();
  const rows = state.mailboxes.map((mailbox) => {
    const cursor = state.emailSyncCursors.find((item) => item.mailboxId === mailbox.id);
    const watch = [...(state.emailWatchSubscriptions ?? [])].reverse().find((item) => item.mailboxId === mailbox.id);
    const retryAt = cursor?.providerBackoffUntil ?? watch?.providerRetryAfterAt;
    return {
      id: mailbox.id,
      provider: mailbox.provider,
      status: mailbox.status,
      owner: mailbox.ownerUserId,
      cursor: cursor?.status ?? '-',
      mode: cursor?.providerSyncMode ?? '-',
      upserted: cursor?.lastUpsertedSourceMessages ?? '-',
      watch: watch?.status ?? '-',
      retryAt: retryAt ? new Date(retryAt).toISOString().slice(0, 16) : '-',
      credential: mailbox.credentialStatus ?? '-',
      lookbackDays: mailbox.syncPolicy?.lookbackDays ?? '-',
      rawRetentionDays: mailbox.syncPolicy?.rawRetentionDays ?? '-',
    };
  });
  const cursorRows = [...(state.emailSyncCursors ?? [])].map((cursor) => ({
    id: cursor.id,
    mailbox: cursor.mailboxId,
    provider: cursor.provider,
    status: cursor.status,
    mode: cursor.providerSyncMode ?? '-',
    messages: cursor.lastProviderMessageCount ?? '-',
    upserted: cursor.lastUpsertedSourceMessages ?? '-',
    requestDigest: cursor.providerRequestDigest ?? '-',
    responseDigest: cursor.providerResponseDigest ?? '-',
  }));
  const sessionRows = [...(state.mailboxConnectionSessions ?? [])].slice(-8).reverse().map((session) => ({
    id: session.id,
    provider: session.provider,
    status: session.status,
    oauth: session.oauthStateStatus ?? '-',
    credential: session.credentialStatus ?? '-',
    callback: session.callbackPath ?? '-',
  }));
  const watchRows = [...(state.emailWatchSubscriptions ?? [])].slice(-8).reverse().map((watch) => ({
    id: watch.id,
    mailbox: watch.mailboxId,
    provider: watch.provider,
    status: watch.status,
    mode: watch.setupMode ?? '-',
    expires: watch.expirationAt ? new Date(watch.expirationAt).toISOString().slice(0, 16) : '-',
    credentialSource: watch.providerCredentialSource ?? '-',
    refreshedAt: watch.providerCredentialRefreshedAt ? new Date(watch.providerCredentialRefreshedAt).toISOString().slice(0, 16) : '-',
    retryAt: watch.providerRetryAfterAt ? new Date(watch.providerRetryAfterAt).toISOString().slice(0, 16) : '-',
    providerStatus: watch.providerResponseStatus ?? '-',
    notifications: watch.notificationCount ?? 0,
  }));
  emit(
    wantsJson
      ? { ok: true, mailboxes: state.mailboxes, mailboxConnectionSessions: state.mailboxConnectionSessions, emailSyncCursors: state.emailSyncCursors, emailWatchSubscriptions: state.emailWatchSubscriptions, providerCredentialRecords: credentialRecords.records }
      : [
          table(rows, ['id', 'provider', 'status', 'owner', 'cursor', 'mode', 'upserted', 'watch', 'retryAt', 'credential', 'lookbackDays', 'rawRetentionDays']),
          '',
          'Connection sessions',
          table(sessionRows, ['id', 'provider', 'status', 'oauth', 'credential', 'callback']),
          '',
          'Sync cursors',
          table(cursorRows, ['id', 'mailbox', 'provider', 'status', 'mode', 'messages', 'upserted', 'requestDigest', 'responseDigest']),
          '',
          'Provider watches',
          table(watchRows, ['id', 'mailbox', 'provider', 'status', 'mode', 'expires', 'credentialSource', 'refreshedAt', 'retryAt', 'providerStatus', 'notifications']),
          '',
          `Connection sessions: ${state.mailboxConnectionSessions.length}`,
          `Sync cursors: ${state.emailSyncCursors.length}`,
          `Provider watches: ${(state.emailWatchSubscriptions ?? []).length}`,
          `Credential records: ${credentialRecords.records.length}`,
        ].join('\n'),
  );
}

async function listEmailFlows() {
  const state = await loadState();
  const rows = state.emailFlows.map((flow) => ({
    owner: state.routingRules?.find((rule) => rule.flowId === flow.id && rule.status === 'active')?.ownerUserId ?? '-',
    id: flow.id,
    name: flow.name,
    rule: state.routingRules?.find((rule) => rule.flowId === flow.id)?.status ?? '-',
    status: flow.status,
    routeTo: state.routingRules?.find((rule) => rule.flowId === flow.id && rule.status === 'active')?.routeTo ?? flow.routeTo,
    runs: state.flowRuns.filter((run) => run.flowIds?.includes(flow.id) || run.flowId === flow.id).length,
    detects: flow.detects.join(', '),
  }));
  emit(
    wantsJson
      ? { ok: true, emailFlows: state.emailFlows, routingRules: state.routingRules ?? [], sourceMessages: state.sourceMessages, flowRuns: state.flowRuns }
      : [
          table(rows, ['id', 'name', 'status', 'rule', 'routeTo', 'owner', 'runs', 'detects']),
          '',
          `Routing rules: ${state.routingRules?.length ?? 0}`,
          `Source messages: ${state.sourceMessages.length}`,
          `Flow runs: ${state.flowRuns.length}`,
        ].join('\n'),
  );
}

async function listQuality() {
  const state = await loadState();
  const settingsRows = (state.signalQualitySettings ?? []).map((settings) => ({
    tenant: settings.tenantId,
    minimum: settings.minimumConfidence,
    autoRoute: settings.autoRouteThreshold,
    requireSource: settings.requireSourceReference ? 'yes' : 'no',
    updatedBy: settings.updatedByUserId ?? '-',
  }));
  const ruleRows = (state.suppressionRules ?? []).map((rule) => ({
    id: rule.id,
    type: rule.type,
    value: rule.value,
    status: rule.status,
    reason: rule.reason ?? '-',
  }));
  const feedbackRows = [...(state.signalFeedback ?? [])].slice(-8).reverse().map((feedback) => ({
    id: feedback.id,
    signal: feedback.signalId,
    user: feedback.userId,
    label: feedback.label,
    note: feedback.note ?? '-',
  }));
  emit(
    wantsJson
      ? { ok: true, signalQualitySettings: state.signalQualitySettings, suppressionRules: state.suppressionRules, signalFeedback: state.signalFeedback }
      : [
          'Quality settings',
          table(settingsRows, ['tenant', 'minimum', 'autoRoute', 'requireSource', 'updatedBy']),
          '',
          'Suppression rules',
          table(ruleRows, ['id', 'type', 'value', 'status', 'reason']),
          '',
          'Recent feedback',
          table(feedbackRows, ['id', 'signal', 'user', 'label', 'note']),
        ].join('\n'),
  );
}

async function listModels() {
  const state = await loadState();
  const reports = modelGovernanceReports(state);
  const rows = reports.map(({ evidence, policy }) => ({
    tenant: policy.tenantId,
    boundary: policy.detectorBoundary,
    learning: policy.learningMode,
    perTenantModel: policy.perTenantModel ? 'yes' : 'no',
    trainingData: policy.trainingDataUse,
    flows: `${evidence.enabledDetectorFlows}/${evidence.totalDetectorFlows}`,
    sourceMessages: evidence.sourceMessages,
    feedback: evidence.feedbackLabels,
    digest: evidence.evidenceDigest,
  }));
  emit(
    wantsJson
      ? { ok: true, modelGovernancePolicies: state.modelGovernancePolicies ?? [], modelGovernanceReports: reports }
      : [
          'Model governance',
          table(rows, ['tenant', 'boundary', 'learning', 'perTenantModel', 'trainingData', 'flows', 'sourceMessages', 'feedback', 'digest']),
          '',
          'Decision: shared detector/model boundary by default; tenant-specific tuning through thresholds, routing, suppression, feedback, and retention.',
        ].join('\n'),
  );
}

async function updateModelPolicy() {
  emitMutation(await setModelGovernancePolicy(positionals[2], {
    learningMode: positionals[3],
    note: positionals.slice(4).join(' ') || undefined,
  }, mutationOptions));
}

async function listGovernance() {
  const state = await loadState();
  const policyRows = (state.governancePolicies ?? []).map((policy) => ({
    tenant: policy.tenantId,
    sourceDays: policy.sourceRetentionDays,
    rawDays: policy.rawSnippetRetentionDays,
    exportDays: policy.exportWindowDays,
    redaction: policy.redactionMode,
    deletion: policy.deletionReview,
  }));
  const ruleRows = (state.redactionRules ?? []).map((rule) => ({
    id: rule.id,
    scope: rule.scope,
    label: rule.label,
    status: rule.status,
    replacement: rule.replacement,
  }));
  const requestRows = [...(state.dataRequests ?? [])].slice(-8).reverse().map((request) => ({
    id: request.id,
    type: request.type,
    requester: request.requesterEmail,
    target: request.targetAccount ?? request.targetUserId ?? '-',
    status: request.status,
    due: request.dueAt ? new Date(request.dueAt).toISOString().slice(0, 10) : '-',
  }));
  const incidentRows = [...(state.incidentNotes ?? [])].slice(-8).reverse().map((note) => ({
    id: note.id,
    severity: note.severity,
    status: note.status,
    title: note.title,
  }));
  emit(
    wantsJson
      ? { ok: true, governancePolicies: state.governancePolicies, redactionRules: state.redactionRules, dataRequests: state.dataRequests, incidentNotes: state.incidentNotes }
      : [
          'Governance policies',
          table(policyRows, ['tenant', 'sourceDays', 'rawDays', 'exportDays', 'redaction', 'deletion']),
          '',
          'Redaction rules',
          table(ruleRows, ['id', 'scope', 'label', 'status', 'replacement']),
          '',
          'Data requests',
          table(requestRows, ['id', 'type', 'requester', 'target', 'status', 'due']),
          '',
          'Incident notes',
          table(incidentRows, ['id', 'severity', 'status', 'title']),
        ].join('\n'),
  );
}

async function listIntegrations() {
  const { env, source: envSource } = await readinessEnv();
  const readiness = providerReadiness(env);
  const state = await loadState({ allowMissing: true });
  const validationRuns = [...(state?.providerValidationRuns ?? [])].sort((left, right) => Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? ''));
  const validationSchedules = [...(state?.providerValidationSchedules ?? [])].sort((left, right) => String(left.providerId ?? '').localeCompare(String(right.providerId ?? '')));
  const rows = readiness.providers.map((provider) => ({
    id: provider.id,
    category: provider.category,
    ready: provider.ready ? 'yes' : 'no',
    configured: `${provider.configuredRequired.length}/${provider.requiredEnv.length}`,
    missing: provider.missingRequired.length ? provider.missingRequired.join(', ') : '-',
    webhook: provider.webhookPath,
  }));
  const validationRows = validationRuns.slice(0, 5).map((run) => ({
    id: run.id,
    status: run.status,
    passed: `${run.summary.passed}/${run.summary.total}`,
    recordedAt: run.recordedAt,
    digest: run.reportDigest,
  }));
  const scheduleRows = validationSchedules.map((schedule) => ({
    provider: schedule.providerId,
    cadence: schedule.cadence,
    status: schedule.status,
    last: schedule.lastRunAt ?? '-',
    next: schedule.nextRunAt ?? '-',
  }));
  emit(
    wantsJson
      ? { ok: true, envSource, readiness, providerValidationRuns: validationRuns, providerValidationSchedules: validationSchedules }
      : [
          `Provider readiness: ${readiness.ok ? 'READY' : 'INCOMPLETE'}`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['id', 'category', 'ready', 'configured', 'missing', 'webhook']),
          '',
          'Provider validation schedules',
          scheduleRows.length ? table(scheduleRows, ['provider', 'cadence', 'status', 'last', 'next']) : 'No provider validation schedules configured.',
          '',
          'Provider sandbox validation evidence',
          validationRows.length ? table(validationRows, ['id', 'status', 'passed', 'recordedAt', 'digest']) : 'No provider sandbox validation runs recorded.',
        ].join('\n'),
  );
}

async function updateIntegrationsSchedule() {
  const providerId = positionals[2];
  const commandValue = positionals[3];
  const secondValue = positionals[4];
  const values = [commandValue, secondValue].filter(Boolean);
  const cadence = values.find((value) => ['daily', 'weekly', 'manual'].includes(value));
  const status = values.find((value) => ['active', 'paused'].includes(value));
  emitMutation(await setProviderValidationSchedule(providerId, { cadence, status }, mutationOptions));
}

async function validateIntegrationsSandbox() {
  if (saveEvidencePath && dryRun) {
    throw new SignalStateError('--save-evidence requires a recorded validation run; omit --dry-run.', {
      code: 'ARG_INVALID',
      details: { usage: 'integrations validate-sandbox --save-evidence <evidence.json> [--json]' },
    });
  }
  const sandbox = await validateProviderSandbox();
  const recorded = dryRun ? null : await recordProviderSandboxValidation(sandbox, mutationOptions);
  let evidence = null;
  if (saveEvidencePath && recorded) {
    const exported = await exportProviderSandboxEvidence(recorded.details.id, mutationOptions);
    const outputPath = await writeJsonFile(saveEvidencePath, exported.details.artifact, 'integrations validate-sandbox --save-evidence <evidence.json>');
    evidence = {
      artifactDigest: exported.details.artifactDigest,
      path: outputPath,
      reportDigest: exported.details.reportDigest,
      runId: exported.details.id,
    };
  }
  const rows = sandbox.providers.map((provider) => ({
    id: provider.id,
    status: provider.status,
    checks: provider.checks.length,
    missing: provider.missingRequired.length ? provider.missingRequired.join(', ') : '-',
  }));
  emit(
    wantsJson
      ? { ok: sandbox.ok, evidence, recorded: recorded?.details ?? null, sandbox, summary: recorded?.summary }
      : [
          `Provider sandbox validation: ${sandbox.ok ? 'PASSED' : 'INCOMPLETE'}`,
          recorded ? `Recorded run: ${recorded.details.id} (${recorded.details.status})` : 'Dry run: not recorded',
          evidence ? `Evidence saved: ${evidence.path} (${evidence.artifactDigest})` : null,
          '',
          table(rows, ['id', 'status', 'checks', 'missing']),
        ].filter((line) => line !== null).join('\n'),
  );
}

async function exportIntegrationsEvidence() {
  const runRef = positionals[2];
  const outputPath = positionals[3] ?? optionValue('--output');
  if (!runRef || !outputPath) {
    throw new SignalStateError('Provider evidence export requires a run id or latest plus an output path.', {
      code: 'ARG_MISSING',
      details: { usage: 'integrations evidence-export <latest|runId|reportDigest> <evidence.json>' },
    });
  }
  const exported = await exportProviderSandboxEvidence(runRef, mutationOptions);
  const resolvedOutputPath = await writeJsonFile(outputPath, exported.details.artifact, 'integrations evidence-export <latest|runId|reportDigest> <evidence.json>');
  const details = {
    artifactDigest: exported.details.artifactDigest,
    path: resolvedOutputPath,
    reportDigest: exported.details.reportDigest,
    runId: exported.details.id,
    status: exported.details.status,
    summary: exported.details.summary,
  };
  emit(
    wantsJson
      ? { ok: true, action: exported.action, details, summary: exported.summary }
      : `Exported provider sandbox evidence ${details.runId} to ${details.path} (${details.artifactDigest})`,
  );
}

async function importIntegrationsEvidence() {
  const inputPath = positionals[2] ?? optionValue('--input');
  const artifact = await readJsonFile(inputPath, 'integrations evidence-import <evidence.json>');
  const imported = await importProviderSandboxEvidence(artifact, mutationOptions);
  emit(
    wantsJson
      ? { ok: true, action: imported.action, details: imported.details, summary: imported.summary }
      : `Imported provider sandbox evidence ${imported.details.importedFromRunId} as ${imported.details.id} (${imported.details.status})`,
  );
}

async function runScheduledIntegrationsValidation() {
  const state = await loadState();
  const dueSchedules = providerValidationSchedulesDue(state);
  if (!force && dueSchedules.length === 0) {
    emit(
      wantsJson
        ? {
            ok: true,
            dueSchedules,
            forced: false,
            recorded: null,
            skipped: true,
            summary: summarizeState(state),
          }
        : 'No provider validation schedules are due. Use --force to run the sandbox validation anyway.',
    );
    return;
  }

  const sandbox = await validateProviderSandbox();
  const recorded = dryRun ? null : await recordProviderSandboxValidation(sandbox, mutationOptions);
  const refreshedState = recorded?.state ?? await loadState();
  emit(
    wantsJson
      ? {
          ok: sandbox.ok,
          dueSchedules,
          forced: force,
          recorded: recorded?.details ?? null,
          sandbox,
          skipped: false,
          summary: recorded?.summary ?? summarizeState(refreshedState),
        }
      : [
          `Scheduled provider validation: ${sandbox.ok ? 'PASSED' : 'INCOMPLETE'}`,
          `Schedules: ${force ? 'forced' : `${dueSchedules.length} due`}`,
          recorded ? `Recorded run: ${recorded.details.id} (${recorded.details.status})` : 'Dry run: not recorded',
        ].join('\n'),
  );
}

async function listSignals() {
  const state = await loadState();
  const rows = state.signals.map((signal) => ({
    id: signal.id,
    account: signal.account,
    type: signal.type,
    severity: signal.severity,
    confidence: signal.confidence,
    status: signal.status,
    handoff: signal.latestHandoffStatus ?? '-',
  }));
  emit(
    wantsJson
      ? { ok: true, signals: state.signals, signalHandoffs: state.signalHandoffs ?? [] }
      : table(rows, ['id', 'account', 'type', 'severity', 'confidence', 'status', 'handoff']),
  );
}

async function listAccounts() {
  const state = await loadState();
  const rows = state.accountProfiles.map((account) => ({
    id: account.id,
    name: account.name,
    health: account.healthScore,
    trend: account.healthTrend,
    owner: account.ownerUserId,
    openActions: state.accountActions.filter((action) => action.account === account.name && action.status === 'open').length,
    openRecs: (state.accountRecommendations ?? []).filter((recommendation) => recommendation.account === account.name && recommendation.status === 'open').length,
    reviews: (state.accountReviews ?? []).filter((review) => review.account === account.name).length,
  }));
  emit(
    wantsJson
      ? { ok: true, accountProfiles: state.accountProfiles, accountEvents: state.accountEvents, accountActions: state.accountActions, accountReviews: state.accountReviews ?? [], accountRecommendations: state.accountRecommendations ?? [] }
      : [
          table(rows, ['id', 'name', 'health', 'trend', 'owner', 'openActions', 'openRecs', 'reviews']),
          '',
          `Events: ${state.accountEvents.length}`,
          `Open actions: ${state.accountActions.filter((action) => action.status === 'open').length}`,
          `Open recommendations: ${(state.accountRecommendations ?? []).filter((recommendation) => recommendation.status === 'open').length}`,
          `Reviews: ${state.accountReviews?.length ?? 0}`,
        ].join('\n'),
  );
}

async function listAccountTimeline(accountRef) {
  const state = await loadState();
  const ref = (accountRef ? accountRef.replaceAll('_', ' ') : '').trim();
  const account = state.accountProfiles.find((candidate) =>
    candidate.id === accountRef ||
    candidate.name.toLowerCase() === ref.toLowerCase());
  if (!account) {
    throw new SignalStateError(`Account not found: ${ref || accountRef}`, {
      code: 'NOT_FOUND',
      status: 404,
      details: { account: ref || accountRef },
    });
  }
  const events = [...(state.accountEvents ?? [])]
    .filter((event) => event.account === account.name)
    .sort((left, right) => Date.parse(right.occurredAt ?? '') - Date.parse(left.occurredAt ?? ''));
  const actions = [...(state.accountActions ?? [])]
    .filter((action) => action.account === account.name)
    .sort((left, right) => Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? ''));
  const reviews = [...(state.accountReviews ?? [])]
    .filter((review) => review.account === account.name)
    .sort((left, right) => Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? ''));
  const recommendations = [...(state.accountRecommendations ?? [])]
    .filter((recommendation) => recommendation.account === account.name)
    .sort((left, right) => Date.parse(right.updatedAt ?? right.createdAt ?? '') - Date.parse(left.updatedAt ?? left.createdAt ?? ''));
  const eventRows = events.map((event) => ({
    id: event.id,
    type: event.type,
    title: event.title,
    occurredAt: event.occurredAt ? new Date(event.occurredAt).toISOString().slice(0, 16) : '-',
  }));
  const actionRows = actions.map((action) => ({
    id: action.id,
    owner: action.ownerUserId,
    priority: action.priority,
    status: action.status,
    title: action.title,
  }));
  const reviewRows = reviews.map((review) => ({
    id: review.id,
    risk: review.riskLevel,
    health: review.healthScore,
    openActions: review.openActionIds?.length ?? 0,
    createdAt: review.createdAt ? new Date(review.createdAt).toISOString().slice(0, 16) : '-',
  }));
  const recommendationRows = recommendations.map((recommendation) => ({
    id: recommendation.id,
    kind: recommendation.kind,
    priority: recommendation.priority,
    status: recommendation.status,
    title: recommendation.title,
  }));
  emit(
    wantsJson
      ? { ok: true, account, events, actions, reviews, recommendations }
      : [
          `${account.name} timeline`,
          '',
          table(eventRows.length ? eventRows : [{ id: '-', type: '-', title: 'No timeline events', occurredAt: '-' }], ['id', 'type', 'title', 'occurredAt']),
          '',
          'Next actions',
          table(actionRows.length ? actionRows : [{ id: '-', owner: '-', priority: '-', status: '-', title: 'No account actions' }], ['id', 'owner', 'priority', 'status', 'title']),
          '',
          'Recommendations',
          table(recommendationRows.length ? recommendationRows : [{ id: '-', kind: '-', priority: '-', status: '-', title: 'No account recommendations' }], ['id', 'kind', 'priority', 'status', 'title']),
          '',
          'Reviews',
          table(reviewRows.length ? reviewRows : [{ id: '-', risk: '-', health: '-', openActions: '-', createdAt: 'No account reviews' }], ['id', 'risk', 'health', 'openActions', 'createdAt']),
        ].join('\n'),
  );
}

async function listNotifications() {
  const state = await loadState();
  const rows = state.notificationEvents.map((event) => ({
    id: event.id,
    user: event.userId,
    account: event.account ?? '-',
    type: event.type,
    status: event.status,
    channel: event.channel,
  }));
  const preferenceRows = state.notificationPreferences.map((preference) => ({
    user: preference.userId,
    cadence: preference.digestCadence,
    immediate: preference.immediateAlerts ? 'yes' : 'no',
    email: preference.emailDeliveryStatus ?? 'subscribed',
    mutedAccounts: preference.mutedAccounts?.length ?? 0,
    mutedTypes: preference.mutedSignalTypes?.length ?? 0,
  }));
  const deliveryRows = (state.emailDeliveryMessages ?? []).slice(-8).reverse().map((message) => ({
    id: message.id,
    provider: message.providerMode ? `${message.provider}:${message.providerMode}` : message.provider,
    user: message.userId,
    to: message.toEmail,
    status: message.status,
    notifications: message.notificationIds?.length ?? 0,
  }));
  emit(
    wantsJson
      ? { ok: true, notificationPreferences: state.notificationPreferences, notificationEvents: state.notificationEvents, notificationDigestRuns: state.notificationDigestRuns, emailDeliveryMessages: state.emailDeliveryMessages }
      : [
          table(rows, ['id', 'user', 'account', 'type', 'status', 'channel']),
          '',
          'Preferences',
          table(preferenceRows, ['user', 'cadence', 'immediate', 'email', 'mutedAccounts', 'mutedTypes']),
          '',
          `Digest runs: ${state.notificationDigestRuns.length}`,
          '',
          'Email delivery',
          table(deliveryRows, ['id', 'provider', 'user', 'to', 'status', 'notifications']),
        ].join('\n'),
  );
}

async function mutateNotificationMuteList({ listName, mode, value, userId }) {
  const state = await loadState();
  const preference = state.notificationPreferences.find((item) => item.userId === userId);
  const currentValues = preference?.[listName] ?? [];
  const nextValues = mode === 'add'
    ? [...new Set([...currentValues, value].filter(Boolean))]
    : currentValues.filter((item) => item !== value);
  emitMutation(await setNotificationPreference(userId, { [listName]: nextValues }, mutationOptions));
}

async function listPayments() {
  const state = await loadState();
  const rows = state.subscriptions.map((subscription) => {
    const plan = state.plans.find((item) => item.id === subscription.planId);
    return {
      id: subscription.id,
      provider: subscription.provider,
      customer: subscription.providerCustomerId ?? subscription.stripeCustomerId ?? '-',
      providerSub: subscription.providerSubscriptionId ?? subscription.stripeSubscriptionId ?? '-',
      plan: plan?.name ?? subscription.planId,
      status: subscription.status,
      monthly: plan ? `$${(plan.monthlyCents / 100).toFixed(2)}` : '-',
    };
  });
  const sessionRows = [...(state.billingSessions ?? [])].slice(-8).reverse().map((session) => ({
    id: session.id,
    provider: session.provider,
    mode: session.providerMode ?? 'local',
    type: session.type,
    status: session.status,
    providerSession: session.providerSessionId ?? '-',
    request: session.providerRequestDigest ?? '-',
  }));
  const overrideRows = [...(state.billingOverrides ?? [])].slice(-8).reverse().map((override) => ({
    id: override.id,
    type: override.type,
    status: override.status,
    plan: override.planId ?? '-',
    amount: override.amountCents ? `$${(override.amountCents / 100).toFixed(2)}` : '-',
    reason: override.reason,
  }));
  const lifecycleRows = (state.lifecycleNotices ?? [])
    .filter((notice) => notice.category === 'payment')
    .slice(0, 8)
    .map((notice) => ({
      id: notice.id,
      trigger: notice.trigger,
      severity: notice.severity,
      status: notice.status,
      action: notice.actionTarget ?? '-',
    }));
  emit(
    wantsJson
      ? { ok: true, plans: state.plans, subscriptions: state.subscriptions, entitlements: state.entitlements, invoices: state.invoices, billingSessions: state.billingSessions, billingOverrides: state.billingOverrides, paymentEvents: state.paymentEvents, lifecycleNotices: state.lifecycleNotices ?? [] }
      : [
          table(rows, ['id', 'provider', 'customer', 'providerSub', 'plan', 'status', 'monthly']),
          '',
          'Billing sessions',
          table(sessionRows, ['id', 'provider', 'mode', 'type', 'status', 'providerSession', 'request']),
          '',
          'Billing overrides',
          table(overrideRows.length ? overrideRows : [{ id: '-', type: '-', status: '-', plan: '-', amount: '-', reason: 'No billing overrides recorded' }], ['id', 'type', 'status', 'plan', 'amount', 'reason']),
          '',
          'Payment lifecycle notices',
          table(lifecycleRows.length ? lifecycleRows : [{ id: '-', trigger: '-', severity: '-', status: '-', action: 'No payment lifecycle notices' }], ['id', 'trigger', 'severity', 'status', 'action']),
          '',
          `Entitlements: ${state.entitlements.length}`,
          `Invoices: ${state.invoices.length} (${state.invoices.filter((invoice) => ['open', 'past_due'].includes(invoice.status)).length} open)`,
          `Billing sessions: ${state.billingSessions.length}`,
          `Billing overrides: ${(state.billingOverrides ?? []).filter((override) => override.status === 'active').length}/${state.billingOverrides?.length ?? 0} active`,
          `Payment events: ${state.paymentEvents.length}`,
        ].join('\n'),
  );
}

async function listLifecycle() {
  const state = await loadState();
  const rows = (state.lifecycleNotices ?? []).map((notice) => ({
    id: notice.id,
    category: notice.category,
    trigger: notice.trigger,
    severity: notice.severity,
    status: notice.status,
    owner: notice.ownerUserId ?? '-',
    action: notice.actionTarget ?? '-',
    title: notice.title,
  }));
  const summary = summarizeState(state);
  emit(
    wantsJson
      ? { ok: true, lifecycleNotices: state.lifecycleNotices ?? [], summary }
      : [
          `Lifecycle notices: ${summary.openLifecycleNotices ?? 0}/${summary.lifecycleNotices ?? 0} open`,
          '',
          table(rows.length ? rows : [{ id: '-', category: '-', trigger: '-', severity: '-', status: '-', owner: '-', action: '-', title: 'No lifecycle notices' }], ['id', 'category', 'trigger', 'severity', 'status', 'owner', 'action', 'title']),
        ].join('\n'),
  );
}

async function listLifecyclePlaybook() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const backend = backendReadiness({ env, statePath: resolveStatePath() });
  const playbook = lifecyclePlaybookReport(state, { backend, statePath: resolveStatePath() });
  const rows = playbook.rows.map((row) => ({
    flow: row.id,
    status: row.status,
    owner: row.owner,
    open: row.open,
    critical: row.critical,
    action: row.adminAction,
    command: row.commands[0] ?? '-',
  }));
  emit(
    wantsJson
      ? { ok: playbook.ok, playbook, backend, envSource }
      : [
          `Lifecycle playbook: ${playbook.ok ? 'LOCAL READY' : 'ATTENTION'}`,
          `Summary: ${playbook.summary.ready}/${playbook.summary.total} ready, ${playbook.summary.actionReady} action-ready, ${playbook.summary.attention} attention, ${playbook.summary.openNotices} open notice(s)`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['flow', 'status', 'owner', 'open', 'critical', 'action', 'command']),
        ].join('\n'),
  );
}

async function listJobs() {
  const state = await loadState();
  const rows = state.jobs.map((job) => ({
    id: job.id,
    queue: job.queue,
    type: job.type,
    status: job.status,
    attempts: `${job.attempts}/${job.maxAttempts}`,
    nextRunAt: job.nextRunAt ? new Date(job.nextRunAt).toISOString().slice(0, 16) : '-',
    nextAttemptAt: job.nextAttemptAt ? new Date(job.nextAttemptAt).toISOString().slice(0, 16) : '-',
    credentialSource: job.providerCredentialSource ?? '-',
    refreshedAt: job.providerCredentialRefreshedAt ? new Date(job.providerCredentialRefreshedAt).toISOString().slice(0, 16) : '-',
    providerStatus: job.providerResponseStatus ?? '-',
    requestDigest: job.providerRequestDigest ?? '-',
    upserted: job.sourceMessagesUpserted ?? '-',
    target: job.targetId,
  }));
  const dlqRows = (state.deadLetter ?? []).map((job) => ({
    id: job.deadLetterId ?? job.id,
    job: job.originalJobId ?? job.id,
    queue: job.queue,
    type: job.type,
    attempts: `${job.attempts}/${job.maxAttempts}`,
    failedAt: job.failedAt ? new Date(job.failedAt).toISOString().slice(0, 16) : '-',
    error: job.message ?? '-',
    target: job.targetId,
  }));
  emit(wantsJson ? { ok: true, deadLetter: state.deadLetter ?? [], jobs: state.jobs } : [
    table(rows, ['id', 'queue', 'type', 'status', 'attempts', 'nextRunAt', 'nextAttemptAt', 'credentialSource', 'refreshedAt', 'providerStatus', 'requestDigest', 'upserted', 'target']),
    '',
    'Dead letter',
    table(dlqRows, ['id', 'job', 'queue', 'type', 'attempts', 'failedAt', 'error', 'target']),
  ].join('\n'));
}

async function listBackendReadiness() {
  const { env, source: envSource } = await readinessEnv();
  const readiness = backendReadiness({ env, statePath: resolveStatePath() });
  const rows = readiness.checks.map((item) => ({
    id: item.id,
    ready: item.ok ? 'yes' : 'no',
    local: item.localOk ? 'yes' : 'no',
    missing: item.missingEnv.length ? item.missingEnv.join(', ') : '-',
    message: item.message,
  }));
  emit(
    wantsJson
      ? { ok: true, backend: readiness, envSource }
      : [
          `Backend mode: ${readiness.mode}`,
          `Production ready: ${readiness.productionReady ? 'yes' : 'no'}`,
          `Ready checks: ${readiness.summary.readyChecks}/${readiness.summary.totalChecks}`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['id', 'ready', 'local', 'missing', 'message']),
        ].join('\n'),
  );
}

async function listBackendHandoff() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const statePath = resolveStatePath();
  const backend = backendReadiness({ env, statePath });
  const provider = providerReadiness(env);
  const readiness = productReadinessReport(state, { backend, provider });
  const operations = operationsHealthReport(state, { backend, statePath });
  const productionDrill = productionOperationsDrillReport(state, {
    backend,
    env,
    operations,
    provider,
    readiness,
  });
  const handoff = backendHandoffReport(state, {
    backend,
    env,
    operations,
    productionDrill,
    provider,
    readiness,
    statePath,
  });
  const rows = handoff.actions.map((row) => ({
    priority: row.priority,
    action: row.id,
    status: row.status,
    owner: row.owner,
    env: row.requiredEnv.length ? row.requiredEnv.slice(0, 5).join(', ') : '-',
    blocker: row.blocker,
    command: row.command,
  }));
  emit(
    wantsJson
      ? { ok: handoff.ok, handoff, backend, operations, productionDrill, readiness, envSource, summary: summarizeState(state, statePath), doctor: doctor(state) }
      : [
          `Backend handoff: ${handoff.productionReady ? 'PRODUCTION READY' : `${handoff.summary.blocked} blocked backend action(s)`}`,
          `Next action: ${handoff.nextAction.id} (${handoff.nextAction.owner})`,
          `Command: ${handoff.nextAction.command}`,
          `Backend checks: ${handoff.backend.readyChecks}/${handoff.backend.totalChecks}`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows.length ? rows : [{ priority: '-', action: 'backend_launch_evidence', status: 'ready_for_proof', owner: 'platform', env: '-', blocker: 'Backend checks pass.', command: handoff.nextAction.command }], ['priority', 'action', 'status', 'owner', 'env', 'blocker', 'command']),
        ].join('\n'),
  );
}

async function listBackendCutover() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const statePath = resolveStatePath();
  const backend = backendReadiness({ env, statePath });
  const provider = providerReadiness(env);
  const operations = operationsHealthReport(state, { backend, statePath });
  const readiness = productReadinessReport(state, { backend, provider });
  const productionDrill = productionOperationsDrillReport(state, {
    backend,
    env,
    operations,
    provider,
    readiness,
  });
  const cutover = backendCutoverDrillReport(state, {
    backend,
    env,
    productionDrill,
    statePath,
  });
  const rows = cutover.rows.map((row) => ({
    priority: row.priority,
    step: row.id,
    status: row.status,
    owner: row.owner,
    env: row.missingEnv.length ? row.missingEnv.slice(0, 5).join(', ') : '-',
    command: row.command,
    rollback: row.rollbackCommand ?? '-',
  }));
  emit(
    wantsJson
      ? { ok: cutover.ok, cutover, backend, productionDrill, envSource, summary: summarizeState(state, statePath), doctor: doctor(state) }
      : [
          `Backend cutover drill: ${cutover.productionReady ? 'PRODUCTION READY' : `${cutover.summary.blocked} cutover step(s) need proof`}`,
          `Next step: ${cutover.nextStep.id} (${cutover.nextStep.owner})`,
          `Command: ${cutover.nextStep.command}`,
          `Backend checks: ${cutover.backend.readyChecks}/${cutover.backend.totalChecks}`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['priority', 'step', 'status', 'owner', 'env', 'command', 'rollback']),
        ].join('\n'),
  );
}

async function listSchedulerHandoff() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const statePath = resolveStatePath();
  const backend = backendReadiness({ env, statePath });
  const provider = providerReadiness(env);
  const readiness = productReadinessReport(state, { backend, provider });
  const launchGate = launchGateReport(state, { backend, env, provider, readiness, statePath: resolveStatePath() });
  const operations = operationsHealthReport(state, { backend, statePath });
  const productionDrill = productionOperationsDrillReport(state, {
    backend,
    env,
    launchGate,
    operations,
    provider,
    readiness,
  });
  const handoff = schedulerHandoffReport(state, {
    backend,
    env,
    launchGate,
    operations,
    productionDrill,
    provider,
    readiness,
    statePath,
  });
  const rows = handoff.rows.map((row) => ({
    priority: row.priority,
    step: row.id,
    status: row.status,
    owner: row.owner,
    env: row.missingEnv.length ? row.missingEnv.slice(0, 5).join(', ') : '-',
    blocker: row.blocker,
    command: row.command,
  }));
  emit(
    wantsJson
      ? { ok: handoff.ok, handoff, backend, launchGate, operations, productionDrill, envSource, summary: summarizeState(state, statePath), doctor: doctor(state) }
      : [
          `Scheduler handoff: ${handoff.productionReady ? 'PRODUCTION READY' : `${handoff.summary.blocked} scheduler step(s) need proof`}`,
          `Next step: ${handoff.nextStep.id} (${handoff.nextStep.owner})`,
          `Command: ${handoff.nextStep.command}`,
          `Queues: ${handoff.operations.failedJobs} failed job(s), ${handoff.operations.activeProviderSchedules}/${handoff.operations.totalProviderSchedules} active provider validation schedule(s)`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['priority', 'step', 'status', 'owner', 'env', 'blocker', 'command']),
        ].join('\n'),
  );
}

async function listProductReadiness() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const backend = backendReadiness({ env, statePath: resolveStatePath() });
  const provider = providerReadiness(env);
  const readiness = productReadinessReport(state, { backend, provider });
  const rows = readiness.requirements.map((requirement) => ({
    id: requirement.id,
    status: requirement.status,
    local: requirement.localOk ? 'yes' : 'no',
    production: requirement.productionOk ? 'yes' : 'no',
    evidence: requirement.evidence.join(' | '),
    gaps: requirement.gaps.length ? requirement.gaps.join(' | ') : '-',
  }));
  emit(
    wantsJson
      ? { ok: readiness.ok, readiness, envSource }
      : [
          `Product readiness: ${readiness.ok ? 'LOCAL READY' : 'NEEDS ATTENTION'}`,
          `Production readiness: ${readiness.productionReady ? 'READY' : 'NOT READY'}`,
          `Summary: ${readiness.summary.localReady}/${readiness.summary.total} local ready, ${readiness.summary.productionReady}/${readiness.summary.total} production ready`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['id', 'status', 'local', 'production', 'evidence', 'gaps']),
        ].join('\n'),
  );
}

async function listCompletionAudit() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const statePath = resolveStatePath();
  const backend = backendReadiness({ env, statePath });
  const provider = providerReadiness(env);
  const readiness = productReadinessReport(state, { backend, provider });
  const dashboardAudit = dashboardAuditReport(state, { backend, statePath });
  const digestionPipeline = signalDigestionPipelineReport(state, { backend, statePath });
  const onboarding = onboardingReadinessReport(state, { backend, statePath });
  const tenantIsolation = tenantIsolationAuditReport(state, { backend, statePath });
  const operations = operationsHealthReport(state, { backend, statePath });
  const lifecyclePlaybook = lifecyclePlaybookReport(state, { backend, statePath });
  const providerLaunch = providerLaunchMatrixReport(state, { backend, env, provider });
  const launchGate = launchGateReport(state, { backend, env, provider, readiness, statePath: resolveStatePath() });
  const paymentLifecycle = paymentLifecycleAuditReport(state, { backend, provider, providerLaunch, statePath });
  const emailHandoff = emailHandoffReport(state, {
    backend,
    env,
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
    env,
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
    env,
    launchGate,
    operations,
    provider,
    providerLaunch,
    readiness,
    statePath,
  });
  const agentHandoff = localAgentHandoffReport(state, {
    backend,
    env,
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
    env,
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
  const rows = completion.rows.map((row) => ({
    area: row.id,
    status: row.status,
    local: row.localOk ? 'yes' : 'no',
    production: row.productionOk ? 'yes' : 'no',
    owner: row.owner,
    blocker: row.blockers[0] ?? '-',
    command: row.commands[0] ?? '-',
  }));
  emit(
    wantsJson
      ? { ok: completion.ok, completion, backend, provider, readiness, launchGate, envSource, summary: summarizeState(state, statePath), doctor: doctor(state) }
      : [
          `Completion audit: ${completion.localComplete ? 'LOCAL COMPLETE' : 'NEEDS LOCAL WORK'}`,
          `Production readiness: ${completion.productionReady ? 'READY' : 'NOT READY'}`,
          `Summary: ${completion.summary.localReady}/${completion.summary.total} local complete, ${completion.summary.productionReady}/${completion.summary.total} production ready, ${completion.summary.needsProduction} production proof gap(s)`,
          `Next local: ${completion.nextLocal?.id ?? 'none'}`,
          `Next production: ${completion.nextProduction?.id ?? 'none'}`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['area', 'status', 'local', 'production', 'owner', 'blocker', 'command']),
        ].join('\n'),
  );
}

async function listAgentHandoff() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const statePath = resolveStatePath();
  const backend = backendReadiness({ env, statePath });
  const provider = providerReadiness(env);
  const readiness = productReadinessReport(state, { backend, provider });
  const launchGate = launchGateReport(state, { backend, env, provider, readiness, statePath: resolveStatePath() });
  const operations = operationsHealthReport(state, { backend, statePath });
  const providerLaunch = providerLaunchMatrixReport(state, { backend, env, provider });
  const productionPlan = productionSetupPlanReport(state, {
    backend,
    env,
    launchGate,
    operations,
    provider,
    providerLaunch,
    readiness,
    statePath,
  });
  const handoff = localAgentHandoffReport(state, {
    backend,
    env,
    launchGate,
    operations,
    productionPlan,
    provider,
    providerLaunch,
    readiness,
    statePath,
  });
  const rows = handoff.nextActions.map((row) => ({
    priority: row.priority,
    action: row.id,
    status: row.status,
    owner: row.owner,
    env: row.requiredEnv.length ? row.requiredEnv.slice(0, 5).join(', ') : '-',
    blocker: row.blocker,
    command: row.command,
  }));
  emit(
    wantsJson
      ? { ok: handoff.ok, handoff, backend, provider, readiness, launchGate, operations, providerLaunch, productionPlan, envSource, summary: summarizeState(state, statePath), doctor: doctor(state) }
      : [
          `Agent handoff: ${handoff.goLiveReady ? 'GO-LIVE READY' : `${handoff.summary.blockedGates} blocked launch gate(s)`}`,
          `Next action: ${handoff.nextAction.id} (${handoff.nextAction.owner})`,
          `Command: ${handoff.nextAction.command}`,
          `Summary: ${handoff.summary.localReady}/${handoff.summary.localTotal} local ready, ${handoff.summary.providerLaunchReady}/${handoff.summary.providerTotal} provider launch-ready, ${handoff.summary.failedJobs} failed job(s)`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows.length ? rows : [{ priority: '-', action: 'launch_evidence_package', status: 'ready_for_proof', owner: 'operations', env: '-', blocker: 'All launch gates pass.', command: handoff.nextAction.command }], ['priority', 'action', 'status', 'owner', 'env', 'blocker', 'command']),
        ].join('\n'),
  );
}

async function listDashboardAudit() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const backend = backendReadiness({ env, statePath: resolveStatePath() });
  const audit = dashboardAuditReport(state, { actorUserId, backend, statePath: resolveStatePath() });
  const rows = audit.rows.map((row) => ({
    area: row.area,
    check: row.check,
    display: row.displayValue,
    summary: `${row.summaryKey}=${row.summaryValue}`,
    total: row.totalValue,
    scope: row.scope,
    status: row.ok ? 'pass' : 'mismatch',
  }));
  emit(
    wantsJson
      ? { ok: audit.ok, audit, backend, envSource }
      : [
          `Dashboard audit: ${audit.ok ? 'PASS' : 'MISMATCH'}`,
          `Summary: ${audit.summary.passed}/${audit.summary.total} passed, ${audit.summary.failed} failed`,
          `Backend: ${audit.backend.mode} (${audit.backend.readyChecks}/${audit.backend.totalChecks} production checks ready)`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['area', 'check', 'display', 'summary', 'total', 'scope', 'status']),
        ].join('\n'),
  );
}

async function listDigestionPipeline() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const statePath = resolveStatePath();
  const backend = backendReadiness({ env, statePath });
  const pipeline = signalDigestionPipelineReport(state, { backend, statePath });
  const rows = pipeline.rows.map((row) => ({
    area: row.area,
    status: row.status,
    local: row.localOk ? 'yes' : 'no',
    production: row.productionOk ? 'yes' : 'no',
    evidence: row.evidence.join(' | '),
    env: row.requiredEnv?.length ? row.requiredEnv.join(', ') : '-',
    command: row.commands?.[0] ?? '-',
  }));
  emit(
    wantsJson
      ? { ok: pipeline.ok, pipeline, backend, envSource, summary: summarizeState(state, statePath), doctor: doctor(state) }
      : [
          `Digestion pipeline audit: ${pipeline.ok ? 'LOCAL READY' : 'NEEDS ATTENTION'}`,
          `Summary: ${pipeline.summary.localReady}/${pipeline.summary.total} local ready, ${pipeline.summary.productionReady}/${pipeline.summary.total} production ready`,
          `Decision: ${pipeline.recommendation.decision}`,
          `Production guardrail: ${pipeline.recommendation.productionGuardrail}`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['area', 'status', 'local', 'production', 'evidence', 'env', 'command']),
        ].join('\n'),
  );
}

async function listOnboardingReadiness() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const backend = backendReadiness({ env, statePath: resolveStatePath() });
  const onboarding = onboardingReadinessReport(state, { backend, statePath: resolveStatePath() });
  const rows = onboarding.rows.map((row) => ({
    area: row.area,
    status: row.status,
    local: row.localOk ? 'yes' : 'no',
    production: row.productionOk ? 'yes' : 'no',
    evidence: row.evidence.join(' | '),
    recommendation: row.recommendation,
  }));
  emit(
    wantsJson
      ? { ok: onboarding.ok, onboarding, backend, envSource }
      : [
          `Onboarding readiness: ${onboarding.ok ? 'LOCAL READY' : 'NEEDS ATTENTION'}`,
          `Decision: ${onboarding.recommendation.decision}`,
          `Summary: ${onboarding.summary.localReady}/${onboarding.summary.total} local ready, ${onboarding.summary.productionReady}/${onboarding.summary.total} production ready`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['area', 'status', 'local', 'production', 'evidence', 'recommendation']),
        ].join('\n'),
  );
}

async function listTenantIsolation() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const statePath = resolveStatePath();
  const backend = backendReadiness({ env, statePath });
  const isolation = tenantIsolationAuditReport(state, { actorUserId, backend, statePath });
  const rows = isolation.rows.map((row) => ({
    area: row.area,
    status: row.status,
    local: row.localOk ? 'yes' : 'no',
    production: row.productionOk ? 'yes' : 'no',
    evidence: row.evidence.join(' | '),
    env: row.requiredEnv?.length ? row.requiredEnv.join(', ') : '-',
    command: row.commands?.[0] ?? '-',
  }));
  emit(
    wantsJson
      ? { ok: isolation.ok, isolation, backend, envSource, summary: summarizeState(state, statePath), doctor: doctor(state) }
      : [
          `Tenant isolation audit: ${isolation.ok ? 'LOCAL READY' : 'NEEDS ATTENTION'}`,
          `Summary: ${isolation.summary.localReady}/${isolation.summary.total} local ready, ${isolation.summary.productionReady}/${isolation.summary.total} production ready`,
          `Decision: ${isolation.recommendation.decision}`,
          `Production guardrail: ${isolation.recommendation.productionGuardrail}`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['area', 'status', 'local', 'production', 'evidence', 'env', 'command']),
        ].join('\n'),
  );
}

async function listOperationsHealth() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const backend = backendReadiness({ env, statePath: resolveStatePath() });
  const operations = operationsHealthReport(state, { backend, statePath: resolveStatePath() });
  const rows = operations.webhooks.map((row) => ({
    channel: row.channel,
    status: row.status,
    path: row.path,
    evidence: row.evidence.join(' | '),
    latest: row.latestAt ?? '-',
  }));
  const queueRows = operations.queues.map((row) => ({
    queue: row.queue,
    status: row.status,
    total: row.total,
    queued: row.queued,
    running: row.running,
    failed: row.failed,
  }));
  emit(
    wantsJson
      ? { ok: operations.ok, operations, backend, envSource }
      : [
          `Operations health: ${operations.ok ? 'LOCAL READY' : 'NEEDS ATTENTION'}`,
          `Summary: ${operations.summary.totalWebhooks - operations.summary.unhealthyWebhooks}/${operations.summary.totalWebhooks} webhooks healthy, ${operations.summary.failedJobs} failed job(s), ${operations.summary.activeBackoffs} active backoff(s), ${operations.summary.criticalLifecycle} critical lifecycle notice(s)`,
          `Production monitoring: ${operations.productionReady ? 'READY' : 'NOT READY'}`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['channel', 'status', 'path', 'evidence', 'latest']),
          '',
          table(queueRows, ['queue', 'status', 'total', 'queued', 'running', 'failed']),
        ].join('\n'),
  );
}

async function listEmailHandoff() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const statePath = resolveStatePath();
  const backend = backendReadiness({ env, statePath });
  const provider = providerReadiness(env);
  const readiness = productReadinessReport(state, { backend, provider });
  const providerLaunch = providerLaunchMatrixReport(state, { backend, env, provider });
  const launchGate = launchGateReport(state, { backend, env, provider, readiness, statePath: resolveStatePath() });
  const operations = operationsHealthReport(state, { backend, statePath });
  const lifecyclePlaybook = lifecyclePlaybookReport(state, { backend, statePath });
  const handoff = emailHandoffReport(state, {
    backend,
    env,
    launchGate,
    lifecyclePlaybook,
    operations,
    provider,
    providerLaunch,
    readiness,
    statePath,
  });
  const rows = handoff.rows.map((row) => ({
    priority: row.priority,
    step: row.id,
    status: row.status,
    owner: row.owner,
    env: row.missingEnv.length ? row.missingEnv.slice(0, 5).join(', ') : '-',
    blocker: row.blocker,
    command: row.command,
  }));
  emit(
    wantsJson
      ? { ok: handoff.ok, handoff, backend, provider, providerLaunch, operations, lifecyclePlaybook, launchGate, envSource, summary: summarizeState(state, statePath), doctor: doctor(state) }
      : [
          `Email handoff: ${handoff.productionReady ? 'PRODUCTION READY' : `${handoff.summary.blocked} email launch step(s) blocked`}`,
          `Next step: ${handoff.nextStep.id} (${handoff.nextStep.owner})`,
          `Command: ${handoff.nextStep.command}`,
          `Email launch: Gmail ${handoff.provider.gmailSandboxStatus}; Outlook ${handoff.provider.outlookSandboxStatus}; outbound ${handoff.provider.outboundSandboxStatus}`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['priority', 'step', 'status', 'owner', 'env', 'blocker', 'command']),
        ].join('\n'),
  );
}

async function listPaymentLifecycleAudit() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const statePath = resolveStatePath();
  const backend = backendReadiness({ env, statePath });
  const provider = providerReadiness(env);
  const providerLaunch = providerLaunchMatrixReport(state, { backend, env, provider });
  const payment = paymentLifecycleAuditReport(state, { backend, provider, providerLaunch, statePath });
  const rows = payment.rows.map((row) => ({
    area: row.area,
    status: row.status,
    local: row.localOk ? 'yes' : 'no',
    production: row.productionOk ? 'yes' : 'no',
    evidence: row.evidence.join(' | '),
    env: row.requiredEnv?.length ? row.requiredEnv.join(', ') : '-',
    command: row.commands?.[0] ?? '-',
  }));
  emit(
    wantsJson
      ? { ok: payment.ok, payment, backend, provider, providerLaunch, envSource, summary: summarizeState(state, statePath), doctor: doctor(state) }
      : [
          `Payment lifecycle audit: ${payment.ok ? 'LOCAL READY' : 'NEEDS ATTENTION'}`,
          `Summary: ${payment.summary.localReady}/${payment.summary.total} local ready, ${payment.summary.productionReady}/${payment.summary.total} production ready`,
          `Stripe launch: ${payment.provider.stripeStatus}`,
          `Production guardrail: ${payment.recommendation.productionGuardrail}`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['area', 'status', 'local', 'production', 'evidence', 'env', 'command']),
        ].join('\n'),
  );
}

async function listPaymentHandoff() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const statePath = resolveStatePath();
  const backend = backendReadiness({ env, statePath });
  const provider = providerReadiness(env);
  const readiness = productReadinessReport(state, { backend, provider });
  const providerLaunch = providerLaunchMatrixReport(state, { backend, env, provider });
  const launchGate = launchGateReport(state, { backend, env, provider, readiness, statePath: resolveStatePath() });
  const payment = paymentLifecycleAuditReport(state, { backend, provider, providerLaunch, statePath });
  const handoff = paymentHandoffReport(state, {
    backend,
    env,
    launchGate,
    paymentLifecycle: payment,
    provider,
    providerLaunch,
    readiness,
    statePath,
  });
  const rows = handoff.rows.map((row) => ({
    priority: row.priority,
    step: row.id,
    status: row.status,
    owner: row.owner,
    env: row.missingEnv.length ? row.missingEnv.slice(0, 5).join(', ') : '-',
    blocker: row.blocker,
    command: row.command,
  }));
  emit(
    wantsJson
      ? { ok: handoff.ok, handoff, backend, provider, providerLaunch, payment, launchGate, envSource, summary: summarizeState(state, statePath), doctor: doctor(state) }
      : [
          `Payment handoff: ${handoff.productionReady ? 'PRODUCTION READY' : `${handoff.summary.blocked} payment launch step(s) blocked`}`,
          `Next step: ${handoff.nextStep.id} (${handoff.nextStep.owner})`,
          `Command: ${handoff.nextStep.command}`,
          `Stripe launch: ${handoff.provider.stripeStatus}; sandbox ${handoff.provider.stripeSandboxStatus}`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['priority', 'step', 'status', 'owner', 'env', 'blocker', 'command']),
        ].join('\n'),
  );
}

async function listProductionDrill() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const backend = backendReadiness({ env, statePath: resolveStatePath() });
  const provider = providerReadiness(env);
  const readiness = productReadinessReport(state, { backend, provider });
  const launchGate = launchGateReport(state, { backend, env, provider, readiness, statePath: resolveStatePath() });
  const operations = operationsHealthReport(state, { backend, statePath: resolveStatePath() });
  const drill = productionOperationsDrillReport(state, { backend, env, launchGate, operations, provider, readiness });
  const rows = drill.rows.map((row) => ({
    area: row.area,
    status: row.status,
    owner: row.owner,
    production: row.productionOk ? 'yes' : 'no',
    env: row.requiredEnv.length ? row.requiredEnv.join(', ') : '-',
    command: row.commands[0] ?? '-',
  }));
  emit(
    wantsJson
      ? { ok: drill.ok, drill, backend, provider, readiness, launchGate, operations, envSource }
      : [
          `Production operations drill: ${drill.productionReady ? 'PRODUCTION READY' : 'NEEDS EXTERNAL PROOF'}`,
          `Summary: ${drill.summary.productionReady}/${drill.summary.total} production drill rows ready, ${drill.summary.blocked} blocked`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['area', 'status', 'owner', 'production', 'env', 'command']),
        ].join('\n'),
  );
}

async function listProductionEnv() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const template = await loadProductionEnvTemplate(envTemplatePath ? resolveCliPath(envTemplatePath, 'production-env --template <path>') : undefined);
  const backend = backendReadiness({ env, statePath: resolveStatePath() });
  const provider = providerReadiness(env);
  const readiness = productReadinessReport(state, { backend, provider });
  const launchGate = launchGateReport(state, { backend, env, provider, readiness, statePath: resolveStatePath() });
  const operations = operationsHealthReport(state, { backend, statePath: resolveStatePath() });
  const drill = productionOperationsDrillReport(state, { backend, env, launchGate, operations, provider, readiness });
  const providerLaunch = providerLaunchMatrixReport(state, { backend, env, provider });
  const plan = productionSetupPlanReport(state, {
    backend,
    env,
    launchGate,
    productionDrill: drill,
    provider,
    providerLaunch,
    readiness,
    statePath: resolveStatePath(),
  });
  const envAudit = productionEnvAuditReport({
    backend,
    env,
    envSource,
    productionPlan: plan,
    provider,
    template,
  });
  const rows = envAudit.rows.map((row) => ({
    section: row.id,
    status: row.status,
    owner: row.owner,
    configured: `${row.configuredRequired.length}/${row.requiredEnv.length}`,
    present: `${row.presentInSource.length}/${row.requiredEnv.length}`,
    missing: row.missingRequired.length ? row.missingRequired.slice(0, 5).join(', ') : '-',
    template: row.templateMissing.length ? row.templateMissing.slice(0, 5).join(', ') : 'covered',
  }));
  emit(
    wantsJson
      ? { ok: envAudit.ok, env: envAudit, backend, provider, productionPlan: plan, envSource }
      : [
          `Production env audit: ${envAudit.envReady ? 'READY' : 'MISSING VALUES'}`,
          `Template: ${envAudit.templateReady ? 'COVERS REQUIRED NAMES' : 'NEEDS UPDATE'} (${envAudit.template.path ?? 'none'})`,
          `Summary: ${envAudit.summary.configuredRequired}/${envAudit.summary.requiredEnv} required configured, ${envAudit.summary.missingRequired} missing, ${envAudit.summary.templateMissingRequired} template gap(s)`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['section', 'status', 'owner', 'configured', 'present', 'missing', 'template']),
        ].join('\n'),
  );
}

async function listProductionPlan() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const backend = backendReadiness({ env, statePath: resolveStatePath() });
  const provider = providerReadiness(env);
  const readiness = productReadinessReport(state, { backend, provider });
  const launchGate = launchGateReport(state, { backend, env, provider, readiness, statePath: resolveStatePath() });
  const operations = operationsHealthReport(state, { backend, statePath: resolveStatePath() });
  const drill = productionOperationsDrillReport(state, { backend, env, launchGate, operations, provider, readiness });
  const providerLaunch = providerLaunchMatrixReport(state, { backend, env, provider });
  const plan = productionSetupPlanReport(state, {
    backend,
    env,
    launchGate,
    productionDrill: drill,
    provider,
    providerLaunch,
    readiness,
    statePath: resolveStatePath(),
  });
  const rows = plan.rows.map((row) => ({
    phase: row.id,
    status: row.status,
    owner: row.owner,
    env: row.requiredEnv.length ? row.requiredEnv.slice(0, 5).join(', ') : '-',
    blockers: row.blockers.length ? row.blockers.slice(0, 2).join(' | ') : '-',
    command: row.commands[0] ?? '-',
  }));
  emit(
    wantsJson
      ? { ok: plan.ok, plan, backend, provider, readiness, launchGate, productionDrill: drill, providerLaunch, envSource }
      : [
          `Production setup plan: ${plan.productionReady ? 'PRODUCTION READY' : 'BLOCKED'}`,
          `Summary: ${plan.summary.complete}/${plan.summary.total} complete, ${plan.summary.blocked} blocked, ${plan.summary.missingRequiredEnv} missing env name(s), next ${plan.summary.nextPhaseId ?? 'none'}`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['phase', 'status', 'owner', 'env', 'blockers', 'command']),
        ].join('\n'),
  );
}

async function listProviderLaunch() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const backend = backendReadiness({ env, statePath: resolveStatePath() });
  const provider = providerReadiness(env);
  const launch = providerLaunchMatrixReport(state, { backend, env, provider });
  const rows = launch.rows.map((row) => ({
    provider: row.id,
    status: row.status,
    owner: row.owner,
    config: row.configurationReady ? 'yes' : 'no',
    sandbox: row.sandboxStatus,
    env: row.missingEnv.length ? row.missingEnv.join(', ') : '-',
    command: row.launchCommands[0] ?? row.evidenceCommands[0] ?? '-',
  }));
  emit(
    wantsJson
      ? { ok: launch.ok, launch, backend, provider, envSource }
      : [
          `Provider launch matrix: ${launch.productionReady ? 'PRODUCTION READY' : 'NEEDS EXTERNAL PROOF'}`,
          `Summary: ${launch.summary.launchReady}/${launch.summary.total} launch-ready, ${launch.summary.configured}/${launch.summary.total} configured, ${launch.summary.sandboxPassed}/${launch.summary.sandboxRequired} sandbox passed`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['provider', 'status', 'owner', 'config', 'sandbox', 'env', 'command']),
        ].join('\n'),
  );
}

async function listProviderHandoff() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const statePath = resolveStatePath();
  const backend = backendReadiness({ env, statePath });
  const provider = providerReadiness(env);
  const launch = providerLaunchMatrixReport(state, { backend, env, provider });
  const handoff = providerHandoffReport(state, {
    backend,
    env,
    launch,
    provider,
    statePath,
  });
  const rows = handoff.actions.map((row) => ({
    priority: row.priority,
    action: row.id,
    provider: row.providerId,
    status: row.status,
    owner: row.owner,
    env: row.requiredEnv.length ? row.requiredEnv.slice(0, 5).join(', ') : '-',
    command: row.command,
  }));
  emit(
    wantsJson
      ? { ok: handoff.ok, handoff, backend, provider, providerLaunch: launch, envSource, summary: summarizeState(state, statePath), doctor: doctor(state) }
      : [
          `Provider handoff: ${handoff.productionReady ? 'PRODUCTION READY' : `${handoff.summary.blocked} provider action(s) blocked`}`,
          `Next action: ${handoff.nextAction.id} (${handoff.nextAction.owner})`,
          `Command: ${handoff.nextAction.command}`,
          `Provider launch: ${handoff.launch.launchReady}/${handoff.launch.total} ready, ${handoff.launch.configured}/${handoff.launch.total} configured, ${handoff.launch.sandboxPassed}/${handoff.launch.sandboxRequired} sandbox passed`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows.length ? rows : [{ priority: '-', action: 'provider_launch_evidence', provider: 'all', status: 'ready_for_proof', owner: 'integrations', env: '-', command: handoff.nextAction.command }], ['priority', 'action', 'provider', 'status', 'owner', 'env', 'command']),
        ].join('\n'),
  );
}

async function listQaAnswers() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const backend = backendReadiness({ env, statePath: resolveStatePath() });
  const provider = providerReadiness(env);
  const readiness = productReadinessReport(state, { backend, provider });
  const dashboardAudit = dashboardAuditReport(state, { backend, statePath: resolveStatePath() });
  const onboarding = onboardingReadinessReport(state, { backend, statePath: resolveStatePath() });
  const operations = operationsHealthReport(state, { backend, statePath: resolveStatePath() });
  const lifecyclePlaybook = lifecyclePlaybookReport(state, { backend, statePath: resolveStatePath() });
  const providerLaunch = providerLaunchMatrixReport(state, { backend, env, provider });
  const qa = qaAnswersReport(state, {
    backend,
    dashboardAudit,
    lifecyclePlaybook,
    onboarding,
    operations,
    provider,
    providerLaunch,
    readiness,
    statePath: resolveStatePath(),
  });
  const rows = qa.rows.map((row) => ({
    id: row.id,
    status: row.status,
    owner: row.owner,
    local: row.localOk ? 'yes' : 'no',
    production: row.productionOk ? 'yes' : 'no',
    answer: row.answer,
    command: row.commands[0] ?? '-',
  }));
  emit(
    wantsJson
      ? { ok: qa.ok, qa, backend, provider, readiness, dashboardAudit, onboarding, operations, lifecyclePlaybook, providerLaunch, envSource }
      : [
          `QA answers: ${qa.ok ? 'LOCAL READY' : 'NEEDS LOCAL WORK'}`,
          `Summary: ${qa.summary.localReady}/${qa.summary.total} local-ready, ${qa.summary.productionReady}/${qa.summary.total} production-ready, ${qa.summary.needsLiveProvider} need live providers, ${qa.summary.needsProduction} need production backend`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['id', 'status', 'owner', 'local', 'production', 'answer', 'command']),
        ].join('\n'),
  );
}

async function listLaunchGate() {
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const backend = backendReadiness({ env, statePath: resolveStatePath() });
  const provider = providerReadiness(env);
  const readiness = productReadinessReport(state, { backend, provider });
  const launchGate = launchGateReport(state, { backend, env, provider, readiness, statePath: resolveStatePath() });
  const rows = launchGate.gates.map((gate) => ({
    id: gate.id,
    status: gate.status,
    owner: gate.owner,
    env: gate.requiredEnv.length ? gate.requiredEnv.join(', ') : '-',
    evidence: gate.evidence.join(' | '),
    blockers: gate.blockers.length ? gate.blockers.join(' | ') : '-',
    command: gate.commands[0] ?? '-',
  }));
  emit(
    wantsJson
      ? { ok: launchGate.goLiveReady, launchGate, readiness, backend, provider, envSource }
      : [
          `Launch gate: ${launchGate.goLiveReady ? 'GO LIVE READY' : 'BLOCKED'}`,
          `Summary: ${launchGate.summary.passed}/${launchGate.summary.total} passed, ${launchGate.summary.blocked} blocked, ${launchGate.summary.attention} attention`,
          `Env source: ${envSource.type === 'env-file' ? `${envSource.path} (${envSource.configuredKeys} names)` : 'process environment'}`,
          '',
          table(rows, ['id', 'status', 'owner', 'env', 'evidence', 'blockers', 'command']),
        ].join('\n'),
  );
}

function launchPackageDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 24);
}

function redactProofCommand(command) {
  return String(command)
    .replace(/\b(DATABASE_URL)=postgres(?:ql)?:\/\/[^\s]+/gi, '$1=<redacted-database-url>')
    .replace(
      /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY)[A-Z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s]+)/g,
      '$1=<redacted>',
    );
}

function sanitizeLaunchGateForPackage(launchGate = {}) {
  return {
    ...launchGate,
    gates: (launchGate.gates ?? []).map((gate) => ({
      ...gate,
      commands: (gate.commands ?? []).map(redactProofCommand),
    })),
  };
}

function launchEvidencePackage({ backend, envSource, launchGate, provider, readiness, state }) {
  const safeLaunchGate = sanitizeLaunchGateForPackage(launchGate);
  const providerValidationRuns = [...(state.providerValidationRuns ?? [])]
    .sort((left, right) => Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? ''))
    .slice(0, 8)
    .map((run) => ({
      id: run.id,
      recordedAt: run.recordedAt ?? null,
      reportDigest: run.reportDigest ?? null,
      status: run.status,
      summary: run.summary,
    }));
  const providerValidationSchedules = [...(state.providerValidationSchedules ?? [])]
    .sort((left, right) => String(left.providerId ?? '').localeCompare(String(right.providerId ?? '')))
    .map((schedule) => ({
      cadence: schedule.cadence,
      lastRunAt: schedule.lastRunAt ?? null,
      lastRunId: schedule.lastRunId ?? null,
      lastRunStatus: schedule.lastRunStatus ?? null,
      nextRunAt: schedule.nextRunAt ?? null,
      providerId: schedule.providerId,
      status: schedule.status,
    }));
  const summary = summarizeState(state);
  const core = {
    artifactType: 'signal.launch_evidence_package',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceCommand: 'signal-admin launch-gate package',
    envSource,
    launchGate: safeLaunchGate,
    freshness: launchGate.freshness ?? {
      applies: false,
      blockers: [],
      policy: null,
    },
    productReadiness: {
      generatedAt: readiness.generatedAt,
      productionReady: readiness.productionReady,
      summary: readiness.summary,
      requirements: readiness.requirements.map((requirement) => ({
        evidence: requirement.evidence,
        gaps: requirement.gaps,
        id: requirement.id,
        label: requirement.label,
        localOk: requirement.localOk,
        productionOk: requirement.productionOk,
        status: requirement.status,
      })),
    },
    backend: {
      mode: backend.mode,
      productionReady: backend.productionReady,
      summary: backend.summary,
      checks: backend.checks.map((check) => ({
        configuredEnv: check.configuredEnv,
        id: check.id,
        label: check.label,
        localOk: check.localOk,
        message: check.message,
        missingEnv: check.missingEnv,
        ok: check.ok,
        requiredEnv: check.requiredEnv,
      })),
    },
    provider: {
      ok: provider.ok,
      summary: provider.summary,
      providers: provider.providers.map((item) => ({
        boundary: item.boundary,
        callbackPath: item.callbackPath,
        category: item.category,
        configuredOptional: item.configuredOptional,
        configuredRequired: item.configuredRequired,
        id: item.id,
        label: item.label,
        missingRequired: item.missingRequired,
        provider: item.provider,
        ready: item.ready,
        requiredEnv: item.requiredEnv,
        webhookPath: item.webhookPath,
      })),
    },
    stateEvidence: {
      activeEntitlements: summary.activeEntitlements,
      activeMemberships: summary.activeMemberships,
      activeProviderValidationSchedules: summary.activeProviderValidationSchedules,
      connectedMailboxes: summary.connectedMailboxes,
      emailDeliveries: summary.emailDeliveries,
      failedEmailDeliveries: summary.failedEmailDeliveries,
      failedJobs: summary.failedJobs,
      generatedSignals: summary.generatedSignals,
      jobs: summary.jobs,
      openInvoices: summary.openInvoices,
      paymentEvents: summary.paymentEvents,
      providerValidationRuns,
      providerValidationSchedules,
      schedulerHeartbeat: state.schedulerHeartbeat ?? null,
      subscriptions: summary.subscriptions,
      tenants: summary.tenants,
      users: summary.users,
    },
    commands: [...new Set(safeLaunchGate.gates.flatMap((gate) => gate.commands))],
    privacy: {
      environmentValues: 'omitted',
      providerCredentialValues: 'omitted',
      rawEmailBodies: 'omitted',
      rawProviderPayloads: 'omitted',
      stateExport: 'summary-only',
    },
  };
  return {
    ...core,
    artifactDigest: launchPackageDigest(core),
  };
}

async function writeLaunchGatePackage() {
  const outputPath = positionals[2] ?? optionValue('--output');
  if (!outputPath) {
    throw new SignalStateError('Launch evidence package path is required.', {
      code: 'ARG_MISSING',
      details: { usage: 'launch-gate package <output.json> [--env-file <path>] [--json]' },
    });
  }
  const state = await loadState();
  const { env, source: envSource } = await readinessEnv();
  const backend = backendReadiness({ env, statePath: resolveStatePath() });
  const provider = providerReadiness(env);
  const readiness = productReadinessReport(state, { backend, provider });
  const launchGate = launchGateReport(state, { backend, env, provider, readiness, statePath: resolveStatePath() });
  const artifact = launchEvidencePackage({ backend, envSource, launchGate, provider, readiness, state });
  const resolvedOutputPath = await writeJsonFile(outputPath, artifact, 'launch-gate package <output.json>');
  emit(
    wantsJson
      ? {
          ok: launchGate.goLiveReady,
          artifactDigest: artifact.artifactDigest,
          launchGate: {
            goLiveReady: launchGate.goLiveReady,
            summary: launchGate.summary,
          },
          path: resolvedOutputPath,
        }
      : `Wrote Signal launch evidence package to ${resolvedOutputPath} (${artifact.artifactDigest})`,
  );
}

function launchPackageCalculatedDigest(artifact = {}) {
  const { artifactDigest: _artifactDigest, ...core } = artifact;
  return launchPackageDigest(core);
}

function safePlaceholderValue(value) {
  const normalized = String(value).trim().replace(/^['"]|['"]$/g, '');
  return (
    normalized === '...' ||
    normalized === '<redacted>' ||
    normalized === '[redacted]' ||
    normalized.toLowerCase() === 'redacted' ||
    /^<[^>\s]+>$/.test(normalized)
  );
}

function hasUnsafeCredentialAssignment(text) {
  const assignmentPattern =
    /(?:^|[\s?&])([A-Za-z0-9_]*(?:access_token|refresh_token|client_secret|api_key|password|secret|token)[A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s&]+))/gi;
  for (const match of text.matchAll(assignmentPattern)) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (!safePlaceholderValue(value) && value.length >= 8) {
      return true;
    }
  }
  return false;
}

function hasUnsafePostgresCredential(text) {
  const databaseUrlPattern = /postgres(?:ql)?:\/\/[^:\s/]+:([^@\s]+)@/gi;
  for (const match of text.matchAll(databaseUrlPattern)) {
    const password = match[1] ?? '';
    if (!safePlaceholderValue(password) && password.length >= 6) {
      return true;
    }
  }
  return false;
}

function stringLooksLikeSecretValue(value) {
  const text = String(value);
  return (
    /sk_(?:live|test)_[A-Za-z0-9_]{8,}/.test(text) ||
    /whsec_[A-Za-z0-9_]{8,}/.test(text) ||
    /SG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text) ||
    /ya29\.[A-Za-z0-9_-]{20,}/.test(text) ||
    hasUnsafePostgresCredential(text) ||
    hasUnsafeCredentialAssignment(text)
  );
}

function secretValuePaths(value, prefix = '') {
  if (typeof value === 'string') {
    return stringLooksLikeSecretValue(value) ? [prefix || '<root>'] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => secretValuePaths(item, `${prefix}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, nested]) => secretValuePaths(nested, prefix ? `${prefix}.${key}` : key));
  }
  return [];
}

function validateLaunchEvidencePackage(artifact = {}) {
  const issues = [];
  if (artifact.artifactType !== 'signal.launch_evidence_package') {
    issues.push('artifactType must be signal.launch_evidence_package');
  }
  if (artifact.schemaVersion !== 1) {
    issues.push('schemaVersion must be 1');
  }
  if (!artifact.artifactDigest) {
    issues.push('artifactDigest is required');
  } else {
    const calculatedDigest = launchPackageCalculatedDigest(artifact);
    if (calculatedDigest !== artifact.artifactDigest) {
      issues.push(`artifactDigest mismatch: expected ${calculatedDigest}`);
    }
  }
  if (artifact.privacy?.environmentValues !== 'omitted') {
    issues.push('privacy.environmentValues must be omitted');
  }
  if (artifact.privacy?.providerCredentialValues !== 'omitted') {
    issues.push('privacy.providerCredentialValues must be omitted');
  }
  if (!artifact.launchGate?.summary || !Array.isArray(artifact.launchGate?.gates)) {
    issues.push('launchGate summary and gates are required');
  }
  if (!artifact.productReadiness?.summary || !Array.isArray(artifact.productReadiness?.requirements)) {
    issues.push('productReadiness summary and requirements are required');
  }
  if (!artifact.backend?.summary || !Array.isArray(artifact.backend?.checks)) {
    issues.push('backend summary and checks are required');
  }
  if (!artifact.provider?.summary || !Array.isArray(artifact.provider?.providers)) {
    issues.push('provider summary and providers are required');
  }
  if (!artifact.freshness?.policy || !Array.isArray(artifact.freshness?.blockers)) {
    issues.push('freshness policy and blockers are required');
  }
  if (artifact.freshness?.blockers?.length) {
    issues.push(`freshness blockers present: ${artifact.freshness.blockers.map((blocker) => blocker.id ?? blocker.message).slice(0, 6).join(', ')}`);
  }
  const timestampFields = [
    ['generatedAt', artifact.generatedAt],
    ...((artifact.stateEvidence?.providerValidationRuns ?? []).map((run, index) => [`stateEvidence.providerValidationRuns[${index}].recordedAt`, run.recordedAt])),
    ...((artifact.stateEvidence?.providerValidationSchedules ?? [])
      .filter((schedule) => schedule.nextRunAt)
      .map((schedule, index) => [`stateEvidence.providerValidationSchedules[${index}].nextRunAt`, schedule.nextRunAt])),
    ['freshness.sandboxEvidence.recordedAt', artifact.freshness?.sandboxEvidence?.recordedAt],
    ['stateEvidence.schedulerHeartbeat.recordedAt', artifact.stateEvidence?.schedulerHeartbeat?.recordedAt],
  ].filter(([, value]) => value !== null && value !== undefined);
  timestampFields.forEach(([field, value]) => {
    if (!Number.isFinite(Date.parse(value))) {
      issues.push(`${field} must be an ISO timestamp`);
    }
  });
  const secretPaths = secretValuePaths(artifact);
  if (secretPaths.length) {
    issues.push(`credential-looking values found at ${secretPaths.slice(0, 8).join(', ')}`);
  }
  return {
    ok: issues.length === 0,
    issues,
    summary: {
      artifactDigest: artifact.artifactDigest ?? null,
      generatedAt: artifact.generatedAt ?? null,
      goLiveReady: artifact.launchGate?.goLiveReady ?? false,
      launchBlocked: artifact.launchGate?.summary?.blocked ?? null,
      launchPassed: artifact.launchGate?.summary?.passed ?? null,
      providerValidationRuns: artifact.stateEvidence?.providerValidationRuns?.length ?? 0,
    },
  };
}

async function verifyLaunchGatePackage() {
  const inputPath = positionals[2] ?? optionValue('--input');
  if (!inputPath) {
    throw new SignalStateError('Launch evidence package path is required.', {
      code: 'ARG_MISSING',
      details: { usage: 'launch-gate verify-package <input.json> [--json]' },
    });
  }
  const inputFilePath = resolveCliPath(inputPath, 'launch-gate verify-package <input.json>');
  const artifact = await readJsonFile(inputFilePath, 'launch-gate verify-package <input.json>');
  const verification = validateLaunchEvidencePackage(artifact);
  if (!verification.ok) {
    throw new SignalStateError('Launch evidence package verification failed.', {
      code: 'LAUNCH_PACKAGE_INVALID',
      details: {
        issues: verification.issues,
        path: inputFilePath,
      },
      status: 422,
    });
  }
  emit(
    wantsJson
      ? { ok: true, path: inputFilePath, verification }
      : [
          `Launch evidence package verified: ${inputFilePath}`,
          `Digest: ${verification.summary.artifactDigest}`,
          `Launch gate: ${verification.summary.goLiveReady ? 'go-live ready' : 'blocked'}`,
        ].join('\n'),
  );
}

async function run() {
  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      emit([
        'Signal local admin CLI',
        '',
        'Usage: npm run admin -- <command> [subcommand] [args] [--json] [--actor <userId>] [--env-file <path>] [--live-provider]',
        '',
        table(commands.map(([name, description]) => ({ command: name, description })), ['command', 'description']),
        '',
        'Mutation examples:',
        '  npm run admin -- completion-audit --json',
        '  npm run admin -- completion-audit --env-file ./.env.production --json',
        '  npm run admin -- agent-handoff --json',
        '  npm run admin -- agent-handoff --env-file ./.env.production --json',
        '  npm run admin -- backend-handoff --json',
        '  npm run admin -- backend-handoff --env-file ./.env.production --json',
        '  npm run admin -- backend-cutover --json',
        '  npm run admin -- backend-cutover --env-file ./.env.production --json',
        '  npm run admin -- readiness --json',
        '  npm run admin -- onboarding-readiness --json',
        '  npm run admin -- tenant-isolation --json',
        '  npm run admin -- dashboard-audit --json',
        '  npm run admin -- digestion-pipeline --json',
        '  npm run admin -- digestion-pipeline --env-file ./.env.production --json',
        '  npm run admin -- operations-health --json',
        '  npm run admin -- production-drill --json',
        '  npm run admin -- production-drill --env-file ./.env.production --json',
        '  npm run admin -- production-env --json',
        '  npm run admin -- production-env --env-file ./.env.production --json',
        '  npm run admin -- production-env --template ./.env.production.example --json',
        '  npm run admin -- production-plan --json',
        '  npm run admin -- production-plan --env-file ./.env.production --json',
        '  npm run admin -- provider-handoff --json',
        '  npm run admin -- provider-handoff --env-file ./.env.production --json',
        '  npm run admin -- provider-launch --json',
        '  npm run admin -- provider-launch --env-file ./.env.production --json',
        '  npm run admin -- email-handoff --json',
        '  npm run admin -- email-handoff --env-file ./.env.production --json',
        '  npm run admin -- payment-lifecycle --json',
        '  npm run admin -- payment-lifecycle --env-file ./.env.production --json',
        '  npm run admin -- payment-handoff --json',
        '  npm run admin -- payment-handoff --env-file ./.env.production --json',
        '  npm run admin -- qa-answers --json',
        '  npm run admin -- qa-answers --env-file ./.env.production --json',
        '  npm run admin -- launch-gate --json',
        '  npm run admin -- launch-gate --env-file ./.env.production --json',
        '  npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json',
        '  npm run admin -- launch-gate verify-package ./signal-launch-evidence.json --json',
        '  npm run admin -- backend --env-file ./.env.production --json',
        '  npm run admin -- integrations --env-file ./.env.production --json',
        '  npm run admin -- session switch usr_product',
        '  SIGNAL_SESSION_SECRET=<local-session-secret> npm run admin -- session token usr_admin --json',
        '  SIGNAL_SESSION_SECRET=<local-session-secret> npm run admin -- session verify <token> --json',
        '  npm run admin -- session revoke <sessionId|digest|token> --actor usr_admin',
        '  npm run admin -- tenants --json',
        '  npm run admin -- tenants register New_Revenue_Lab newlab.example owner@newlab.example Owner_Name plan_beta',
        '  npm run admin -- tenants create New_Revenue_Lab newlab.example owner@newlab.example Owner_Name plan_beta',
        '  npm run admin -- tenants complete-onboarding tenant_demo --actor usr_admin',
        '  npm run admin -- tenants status tenant_demo suspended Maintenance_window',
        '  npm run admin -- tenants status tenant_demo active',
        '  npm run admin -- tenants domain tenant_demo acme.example',
        '  npm run admin -- users role usr_sales admin --actor usr_admin',
        '  npm run admin -- users revoke-sessions usr_sales --actor usr_admin',
        '  npm run admin -- users invite tenant_demo rowan@acme.example member success',
        '  npm run admin -- users claim local-rowan-success rowan@acme.example Rowan_Lee success',
        '  npm run admin -- users accept inv_rowan_success Rowan_Lee',
        '  npm run admin -- users revoke <inviteId>',
        '  npm run admin -- mailboxes connect-url tenant_demo outlook usr_admin mbx_outlook_success',
        '  npm run admin -- mailboxes callback gmail <code> <state>',
        '  npm run admin -- mailboxes complete mcs_outlook_reauth',
        '  npm run admin -- mailboxes pause mbx_gmail_sales',
        '  npm run admin -- mailboxes watch mbx_gmail_sales',
        '  SIGNAL_TOKEN_ENCRYPTION_KEY=... npm run admin -- mailboxes watch <storedCredentialMailboxId> --live-provider',
        '  SIGNAL_TOKEN_ENCRYPTION_KEYS=v2:<new>,v1:<old> npm run admin -- token-vault rotate --json',
        '  SIGNAL_TOKEN_ENCRYPTION_KEYS=v2:<new>,v1:<old> npm run admin -- token-vault verify --json',
        '  SIGNAL_GMAIL_ACCESS_TOKEN=... npm run admin -- mailboxes watch mbx_gmail_sales --live-provider',
        '  SIGNAL_OUTLOOK_ACCESS_TOKEN=... npm run admin -- mailboxes renew-watch watch_outlook_mbx_outlook_success --live-provider',
        '  npm run admin -- mailboxes renew-watch watch_gmail_mbx_gmail_sales',
        '  npm run admin -- mailboxes replay mbx_gmail_sales',
        '  npm run admin -- email-flows run',
        '  npm run admin -- email-flows run flow_product_ideas mbx_gmail_sales',
        '  npm run admin -- email-flows route flow_buying_intent founder usr_admin Founder_review',
        '  npm run admin -- email-flows disable flow_product_ideas',
        '  npm run admin -- quality threshold tenant_demo 0.80',
        '  npm run admin -- quality suppress tenant_demo domain internal.example Internal_threads',
        '  npm run admin -- quality rule sup_internal_domains disabled',
        '  npm run admin -- models --json',
        '  npm run admin -- models policy tenant_demo opt_in_tuning Governance_reviewed',
        '  npm run admin -- models policy tenant_demo disabled',
        '  npm run admin -- governance policy tenant_demo 30 7',
        '  npm run admin -- governance redact tenant_demo exports Customer_names customer_name [customer]',
        '  npm run admin -- governance request tenant_demo export ops@acme.example Acme_Health',
        '  npm run admin -- governance request-status dsr_export_acme_health completed Export_ready',
        '  npm run admin -- governance incident tenant_demo watch Outlook_reauth Needs_owner_reauth',
        '  npm run admin -- governance resolve-incident inc_outlook_reauth_watch',
        '  npm run admin -- integrations --json',
        '  npm run admin -- integrations validate-sandbox --json',
        '  npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
        '  npm run admin -- integrations evidence-export latest ./signal-provider-evidence.json --json',
        '  npm run admin -- integrations evidence-import ./signal-provider-evidence.json --json',
        '  npm run admin -- integrations validate-sandbox --dry-run --json',
        '  npm run admin -- integrations run-scheduled --json',
        '  npm run admin -- integrations run-scheduled --force --json',
        '  npm run admin -- integrations schedule stripe weekly --json',
        '  npm run admin -- integrations schedule outlook paused --json',
        '  npm run admin -- accounts --json',
        '  npm run admin -- accounts timeline Acme_Health',
        '  npm run admin -- accounts review VentureWorks Product_discovery_review',
        '  npm run admin -- accounts action act_acme_exec_save done',
        '  npm run admin -- notifications digest tenant_demo',
        '  npm run admin -- notifications preference usr_sales daily immediate',
        '  npm run admin -- notifications delivery-status <messageId> sent',
        '  npm run admin -- notifications webhook ./email-event.json',
        '  SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET=<email-webhook-secret> npm run admin -- notifications webhook-sign ./email-event.json',
        '  SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET=<email-webhook-secret> npm run admin -- notifications webhook-signed ./email-event.json <Signal-Email-Signature>',
        '  SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY=... npm run admin -- notifications sendgrid-webhook-signed ./sendgrid-events.json <signature> <timestamp>',
        '  npm run admin -- notifications unsubscribe usr_product',
        '  npm run admin -- notifications mute-account usr_product Acme Health',
        '  npm run admin -- notifications status ntf_sig_sig_risk_001 read',
        '  npm run admin -- signals assign sig_risk_001 usr_sales',
        '  npm run admin -- signals feedback sig_risk_001 useful Renewal_save_signal',
        '  npm run admin -- signals handoff sig_product_001 crm CRM_followup',
        '  npm run admin -- signals handoff-status <handoffId> sent crm_task_123 Sent_to_CRM',
        '  npm run admin -- payments comp tenant_demo plan_beta',
        '  npm run admin -- payments sync tenant_demo',
        '  npm run admin -- payments sync tenant_demo --live-provider',
        '  npm run admin -- payments override tenant_demo beta_access Beta_extension plan_beta',
        '  npm run admin -- payments override tenant_demo support_credit Onboarding_credit 2500',
        '  npm run admin -- payments override tenant_demo manual_entitlement Support_access plan_team',
        '  npm run admin -- payments override-revoke <overrideId> Resolved',
        '  npm run admin -- payments checkout tenant_demo plan_team',
        '  npm run admin -- payments checkout tenant_demo plan_team --live-provider',
        '  npm run admin -- payments recover <invoiceId>',
        '  npm run admin -- payments refund <invoiceId> 2500 Courtesy_credit',
        '  npm run admin -- payments cancel sub_demo',
        '  npm run admin -- payments portal tenant_demo --live-provider',
        '  npm run admin -- payments portal tenant_demo --live-provider --stripe-customer cus_... # override stored customer',
        '  npm run admin -- payments webhook invoice.payment_failed sub_demo',
        '  npm run admin -- payments webhook subscription.updated sub_demo past_due',
        '  STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-sign ./stripe-event.json',
        '  STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>',
        '  npm run admin -- lifecycle --json',
        '  npm run admin -- lifecycle-playbook --json',
        '  npm run admin -- operations-health --json',
        '  npm run admin -- production-drill --env-file ./.env.production --json',
        '  npm run admin -- scheduler-handoff --env-file ./.env.production --json',
        '  npm run admin -- provider-launch --env-file ./.env.production --json',
        '  npm run admin -- jobs run',
        '  npm run admin -- jobs run email_sync --limit 5',
        '  npm run admin -- jobs run provider_validation --limit 1',
        '  npm run admin -- jobs run signal_handoff --limit 5',
        '  npm run admin -- jobs retry job_mbx_outlook_success',
        '  npm run admin -- jobs dlq',
        '  npm run admin -- jobs requeue <deadLetterId|jobId>',
        '  npm run scheduler -- --once --dry-run --json',
        '  SIGNAL_JOB_SCHEDULER=signal-scheduler npm run scheduler',
        '  npm run admin -- backend --json',
        '  SIGNAL_STATE_SERVICE_BACKEND=postgres DATABASE_URL=postgres://... SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service',
        '',
        `State path: ${resolveStatePath()}`,
      ].join('\n'));
      return;

    case 'bootstrap': {
      if (force && !confirmed) {
        throw new SignalStateError('Force bootstrap requires --yes to confirm destructive overwrite.', {
          code: 'BOOTSTRAP_CONFIRMATION_REQUIRED',
          status: 400,
          details: { usage: 'npm run admin -- bootstrap --force --yes' },
        });
      }
      const result = await bootstrapState({ force });
      emit(wantsJson
        ? { backupPath: result.backupPath ?? null, ok: true, statePath: result.statePath, summary: result.summary }
        : [
          `Bootstrapped local Signal state at ${result.statePath}`,
          result.backupPath ? `Previous state backed up to ${result.backupPath}` : null,
        ].filter(Boolean).join('\n'));
      return;
    }

    case 'status': {
      const state = await loadState();
      const summary = summarizeState(state);
      emit(wantsJson ? { ok: true, summary } : formatStatus(summary));
      return;
    }

    case 'readiness':
      if (!subcommand) {
        await listProductReadiness();
        return;
      }
      unknownSubcommand();
      return;

    case 'completion-audit':
      if (!subcommand) {
        await listCompletionAudit();
        return;
      }
      unknownSubcommand();
      return;

    case 'agent-handoff':
      if (!subcommand) {
        await listAgentHandoff();
        return;
      }
      unknownSubcommand();
      return;

    case 'backend-handoff':
      if (!subcommand) {
        await listBackendHandoff();
        return;
      }
      unknownSubcommand();
      return;

    case 'backend-cutover':
      if (!subcommand) {
        await listBackendCutover();
        return;
      }
      unknownSubcommand();
      return;

    case 'scheduler-handoff':
      if (!subcommand) {
        await listSchedulerHandoff();
        return;
      }
      unknownSubcommand();
      return;

    case 'onboarding-readiness':
      if (!subcommand) {
        await listOnboardingReadiness();
        return;
      }
      unknownSubcommand();
      return;

    case 'tenant-isolation':
      if (!subcommand) {
        await listTenantIsolation();
        return;
      }
      unknownSubcommand();
      return;

    case 'dashboard-audit':
      if (!subcommand) {
        await listDashboardAudit();
        return;
      }
      unknownSubcommand();
      return;

    case 'digestion-pipeline':
      if (!subcommand) {
        await listDigestionPipeline();
        return;
      }
      unknownSubcommand();
      return;

    case 'operations-health':
      if (!subcommand) {
        await listOperationsHealth();
        return;
      }
      unknownSubcommand();
      return;

    case 'email-handoff':
      if (!subcommand) {
        await listEmailHandoff();
        return;
      }
      unknownSubcommand();
      return;

    case 'payment-lifecycle':
      if (!subcommand) {
        await listPaymentLifecycleAudit();
        return;
      }
      unknownSubcommand();
      return;

    case 'payment-handoff':
      if (!subcommand) {
        await listPaymentHandoff();
        return;
      }
      unknownSubcommand();
      return;

    case 'production-drill':
      if (!subcommand) {
        await listProductionDrill();
        return;
      }
      unknownSubcommand();
      return;

    case 'production-env':
      if (!subcommand) {
        await listProductionEnv();
        return;
      }
      unknownSubcommand();
      return;

    case 'production-plan':
      if (!subcommand) {
        await listProductionPlan();
        return;
      }
      unknownSubcommand();
      return;

    case 'provider-launch':
      if (!subcommand) {
        await listProviderLaunch();
        return;
      }
      unknownSubcommand();
      return;

    case 'provider-handoff':
      if (!subcommand) {
        await listProviderHandoff();
        return;
      }
      unknownSubcommand();
      return;

    case 'qa-answers':
      if (!subcommand) {
        await listQaAnswers();
        return;
      }
      unknownSubcommand();
      return;

    case 'launch-gate':
      if (!subcommand) {
        await listLaunchGate();
        return;
      }
      if (subcommand === 'package') {
        await writeLaunchGatePackage();
        return;
      }
      if (subcommand === 'verify-package') {
        await verifyLaunchGatePackage();
        return;
      }
      unknownSubcommand();
      return;

    case 'session':
      if (!subcommand || subcommand === 'list') {
        await listSession();
        return;
      }
      if (subcommand === 'switch') {
        emitMutation(await switchSession(positionals[2], mutationOptions));
        return;
      }
      if (subcommand === 'token') {
        const result = await issueSessionToken(positionals[2], mutationOptions);
        emit(
          wantsJson
            ? {
                ok: true,
                action: result.action,
                actor: {
                  email: result.actor.email,
                  id: result.actor.id,
                  name: result.actor.name,
                  role: result.actor.role,
                },
                details: result.details,
                summary: result.summary,
              }
            : [
                result.details.message,
                `Expires: ${result.details.expiresAt}`,
                `Digest: ${result.details.tokenDigest}`,
                result.details.token,
              ].join('\n'),
        );
        return;
      }
      if (subcommand === 'verify') {
        emit(await verifyLocalSessionToken(positionals[2], { statePath: mutationOptions.statePath }));
        return;
      }
      if (subcommand === 'revoke') {
        emitMutation(await revokeSessionToken(positionals[2], mutationOptions));
        return;
      }
      unknownSubcommand();
      return;

    case 'tenants':
      if (!subcommand) {
        await listTenants();
        return;
      }
      if (subcommand === 'register') {
        emitMutation(await registerTenantWorkspace({
          adminEmail: positionals[4],
          adminName: positionals[5],
          domain: positionals[3],
          name: positionals[2],
          planId: positionals[6] ?? 'plan_beta',
        }, { statePath: mutationOptions.statePath }));
        return;
      }
      if (subcommand === 'create') {
        emitMutation(await createTenantWorkspace({
          adminEmail: positionals[4],
          adminName: positionals[5],
          domain: positionals[3],
          name: positionals[2],
          planId: positionals[6] ?? 'plan_beta',
        }, mutationOptions));
        return;
      }
      if (subcommand === 'complete-onboarding') {
        emitMutation(await completeTenantOnboarding(positionals[2], mutationOptions));
        return;
      }
      if (subcommand === 'status') {
        emitMutation(await setTenantStatus(positionals[2], positionals[3], { reason: positionals.slice(4).join(' ') || undefined }, mutationOptions));
        return;
      }
      if (subcommand === 'domain') {
        emitMutation(await setTenantDomain(positionals[2], positionals[3], mutationOptions));
        return;
      }
      unknownSubcommand();
      return;

    case 'users':
      if (!subcommand) {
        await listUsers();
        return;
      }
      if (subcommand === 'role') {
        emitMutation(await setUserRole(positionals[2], positionals[3], mutationOptions));
        return;
      }
      if (subcommand === 'revoke-sessions') {
        emitMutation(await revokeUserSessions(positionals[2], mutationOptions));
        return;
      }
      if (subcommand === 'disable') {
        emitMutation(await setUserStatus(positionals[2], 'disabled', mutationOptions));
        return;
      }
      if (subcommand === 'activate') {
        emitMutation(await setUserStatus(positionals[2], 'active', mutationOptions));
        return;
      }
      if (subcommand === 'invite') {
        emitMutation(await createUserInvite({ tenantId: positionals[2], email: positionals[3], role: positionals[4] ?? 'member', team: positionals[5] }, mutationOptions));
        return;
      }
      if (subcommand === 'claim') {
        emitMutation(await claimUserInvite({
          claimCode: positionals[2],
          email: positionals[3],
          name: positionals[4],
          team: positionals[5],
        }, mutationOptions));
        return;
      }
      if (subcommand === 'accept') {
        emitMutation(await acceptUserInvite(positionals[2], { name: positionals.slice(3).join(' ') }, mutationOptions));
        return;
      }
      if (subcommand === 'revoke') {
        emitMutation(await revokeUserInvite(positionals[2], mutationOptions));
        return;
      }
      unknownSubcommand();
      return;

    case 'token-vault':
      if (subcommand === 'verify') {
        const result = await verifyProviderCredentialVault();
        emit(wantsJson ? result : `Token vault verify: ${result.ok ? 'OK' : 'FAILED'} (${result.summary.failed}/${result.summary.total} failed)`);
        return;
      }
      if (subcommand === 'rotate') {
        const result = await rotateProviderCredentialVault();
        emit(wantsJson ? result : `Token vault rotated ${result.rotated}/${result.total} record(s) to ${result.targetKeyId}`);
        return;
      }
      unknownSubcommand();
      return;

    case 'mailboxes':
      if (!subcommand) {
        await listMailboxes();
        return;
      }
      if (subcommand === 'pause') {
        emitMutation(await setMailboxStatus(positionals[2], 'paused', mutationOptions));
        return;
      }
      if (subcommand === 'resume') {
        emitMutation(await setMailboxStatus(positionals[2], 'connected', mutationOptions));
        return;
      }
      if (subcommand === 'connect-url') {
        emitMutation(await createMailboxConnectionSession({ tenantId: positionals[2], provider: positionals[3], ownerUserId: positionals[4], mailboxId: positionals[5] }, mutationOptions));
        return;
      }
      if (subcommand === 'complete') {
        emitMutation(await completeMailboxConnection(positionals[2], mutationOptions));
        return;
      }
      if (subcommand === 'callback') {
        emitMutation(await completeMailboxConnectionFromOAuthCallback(positionals[2], {
          code: positionals[3],
          state: positionals[4],
        }, mutationOptions));
        return;
      }
      if (subcommand === 'disconnect') {
        emitMutation(await disconnectMailbox(positionals[2], mutationOptions));
        return;
      }
      if (subcommand === 'sync') {
        emitMutation(await syncMailbox(positionals[2], mutationOptions));
        return;
      }
      if (subcommand === 'replay') {
        emitMutation(await replayMailbox(positionals[2], mutationOptions));
        return;
      }
      if (subcommand === 'watch') {
        emitMutation(await setupMailboxWatch(positionals[2], mutationOptions));
        return;
      }
      if (subcommand === 'renew-watch') {
        emitMutation(await renewMailboxWatch(positionals[2], mutationOptions));
        return;
      }
      if (subcommand === 'notification') {
        const provider = positionals[2];
        const payload = positionals[3] ? JSON.parse(await fs.readFile(resolveCliPath(positionals[3], 'mailboxes notification <gmail|outlook> <payload.json>'), 'utf8')) : {};
        emitMutation(await handleProviderWatchNotification(provider, payload, mutationOptions));
        return;
      }
      unknownSubcommand();
      return;

    case 'email-flows':
      if (!subcommand) {
        await listEmailFlows();
        return;
      }
      if (subcommand === 'enable') {
        emitMutation(await setEmailFlowStatus(positionals[2], 'enabled', mutationOptions));
        return;
      }
      if (subcommand === 'disable') {
        emitMutation(await setEmailFlowStatus(positionals[2], 'disabled', mutationOptions));
        return;
      }
      if (subcommand === 'route') {
        emitMutation(await setEmailFlowRouting(positionals[2], {
          routeTo: positionals[3],
          ownerUserId: positionals[4],
          note: positionals.slice(5).join(' ') || undefined,
        }, mutationOptions));
        return;
      }
      if (subcommand === 'run') {
        emitMutation(await runEmailFlows({ flowId: positionals[2], mailboxId: positionals[3] }, mutationOptions));
        return;
      }
      unknownSubcommand();
      return;

    case 'quality':
      if (!subcommand) {
        await listQuality();
        return;
      }
      if (subcommand === 'threshold') {
        emitMutation(await setSignalQualityThreshold(positionals[2], positionals[3], mutationOptions));
        return;
      }
      if (subcommand === 'suppress') {
        emitMutation(await createSuppressionRule({ tenantId: positionals[2], type: positionals[3], value: positionals[4], reason: positionals.slice(5).join(' ') || undefined }, mutationOptions));
        return;
      }
      if (subcommand === 'rule') {
        emitMutation(await setSuppressionRuleStatus(positionals[2], positionals[3], mutationOptions));
        return;
      }
      unknownSubcommand();
      return;

    case 'models':
      if (!subcommand) {
        await listModels();
        return;
      }
      if (subcommand === 'policy') {
        await updateModelPolicy();
        return;
      }
      unknownSubcommand();
      return;

    case 'governance':
      if (!subcommand) {
        await listGovernance();
        return;
      }
      if (subcommand === 'policy') {
        emitMutation(await setGovernancePolicy(positionals[2], {
          sourceRetentionDays: positionals[3],
          rawSnippetRetentionDays: positionals[4],
          exportWindowDays: positionals[5],
          redactionMode: positionals[6],
          deletionReview: positionals[7],
        }, mutationOptions));
        return;
      }
      if (subcommand === 'redact') {
        emitMutation(await createRedactionRule({
          tenantId: positionals[2],
          scope: positionals[3],
          label: positionals[4],
          pattern: positionals[5],
          replacement: positionals.slice(6).join(' ') || undefined,
        }, mutationOptions));
        return;
      }
      if (subcommand === 'redaction-rule') {
        emitMutation(await setRedactionRuleStatus(positionals[2], positionals[3], mutationOptions));
        return;
      }
      if (subcommand === 'request') {
        emitMutation(await createDataRequest({
          tenantId: positionals[2],
          type: positionals[3],
          requesterEmail: positionals[4],
          targetAccount: positionals.slice(5).join(' ') || undefined,
        }, mutationOptions));
        return;
      }
      if (subcommand === 'request-status') {
        emitMutation(await setDataRequestStatus(positionals[2], positionals[3], { note: positionals.slice(4).join(' ') || undefined }, mutationOptions));
        return;
      }
      if (subcommand === 'incident') {
        emitMutation(await createIncidentNote({
          tenantId: positionals[2],
          severity: positionals[3],
          title: positionals[4],
          body: positionals.slice(5).join(' ') || undefined,
        }, mutationOptions));
        return;
      }
      if (subcommand === 'resolve-incident') {
        emitMutation(await resolveIncidentNote(positionals[2], mutationOptions));
        return;
      }
      unknownSubcommand();
      return;

    case 'integrations':
      if (!subcommand) {
        await listIntegrations();
        return;
      }
      if (subcommand === 'validate-sandbox') {
        await validateIntegrationsSandbox();
        return;
      }
      if (subcommand === 'evidence-export') {
        await exportIntegrationsEvidence();
        return;
      }
      if (subcommand === 'evidence-import') {
        await importIntegrationsEvidence();
        return;
      }
      if (subcommand === 'run-scheduled') {
        await runScheduledIntegrationsValidation();
        return;
      }
      if (subcommand === 'schedule') {
        await updateIntegrationsSchedule();
        return;
      }
      unknownSubcommand();
      return;

    case 'accounts':
      if (!subcommand) {
        await listAccounts();
        return;
      }
      if (subcommand === 'timeline') {
        await listAccountTimeline(positionals[2]);
        return;
      }
      if (subcommand === 'review') {
        emitMutation(await createAccountReview(positionals[2], { note: positionals.slice(3).join(' ') || undefined }, mutationOptions));
        return;
      }
      if (subcommand === 'action') {
        emitMutation(await setAccountActionStatus(positionals[2], positionals[3], mutationOptions));
        return;
      }
      unknownSubcommand();
      return;

    case 'notifications':
      if (!subcommand) {
        await listNotifications();
        return;
      }
      if (subcommand === 'digest') {
        emitMutation(await runNotificationDigest({ tenantId: positionals[2], userId: positionals[3] }, mutationOptions));
        return;
      }
      if (subcommand === 'delivery-status') {
        emitMutation(await setEmailDeliveryStatus(positionals[2], positionals[3], { reason: positionals.slice(4).join(' ') || undefined }, mutationOptions));
        return;
      }
      if (subcommand === 'webhook') {
        const payloadPath = resolveCliPath(positionals[2], 'notifications webhook <payload.json>');
        const payload = JSON.parse(await fs.readFile(payloadPath, 'utf8'));
        emitMutation(await handleEmailDeliveryWebhook(payload, mutationOptions));
        return;
      }
      if (subcommand === 'webhook-sign') {
        const payloadPath = resolveCliPath(positionals[2], 'notifications webhook-sign <payload.json>');
        const rawBody = await fs.readFile(payloadPath, 'utf8');
        const signatureHeader = signEmailWebhookPayload(rawBody, emailWebhookSecret());
        emit(wantsJson ? { ok: true, signatureHeader } : signatureHeader);
        return;
      }
      if (subcommand === 'webhook-signed') {
        const payloadPath = resolveCliPath(positionals[2], 'notifications webhook-signed <payload.json> <Signal-Email-Signature>');
        const signatureHeader = positionals[3];
        const rawBody = await fs.readFile(payloadPath, 'utf8');
        emitMutation(await handleSignedEmailDeliveryWebhook(rawBody, signatureHeader, {
          ...mutationOptions,
          endpointSecret: emailWebhookSecret(),
        }));
        return;
      }
      if (subcommand === 'sendgrid-webhook-signed') {
        const payloadPath = resolveCliPath(positionals[2], 'notifications sendgrid-webhook-signed <payload.json> <signature> <timestamp>');
        const signatureHeader = positionals[3];
        const timestampHeader = positionals[4];
        const rawBody = await fs.readFile(payloadPath, 'utf8');
        emitMutation(await handleSignedSendGridEmailDeliveryWebhook(rawBody, signatureHeader, timestampHeader, {
          ...mutationOptions,
          endpointPublicKey: sendGridWebhookPublicKey(),
        }));
        return;
      }
      if (subcommand === 'unsubscribe') {
        emitMutation(await unsubscribeEmailDigest(positionals[2], mutationOptions));
        return;
      }
      if (subcommand === 'preference') {
        const mode = positionals[4];
        emitMutation(await setNotificationPreference(positionals[2], {
          digestCadence: positionals[3],
          ...(mode === 'immediate' ? { immediateAlerts: true } : {}),
          ...(mode === 'quiet' ? { immediateAlerts: false } : {}),
        }, mutationOptions));
        return;
      }
      if (subcommand === 'status') {
        emitMutation(await setNotificationStatus(positionals[2], positionals[3], mutationOptions));
        return;
      }
      if (subcommand === 'mute-account') {
        await mutateNotificationMuteList({ listName: 'mutedAccounts', mode: 'add', userId: positionals[2], value: positionals.slice(3).join(' ') });
        return;
      }
      if (subcommand === 'unmute-account') {
        await mutateNotificationMuteList({ listName: 'mutedAccounts', mode: 'remove', userId: positionals[2], value: positionals.slice(3).join(' ') });
        return;
      }
      if (subcommand === 'mute-type') {
        await mutateNotificationMuteList({ listName: 'mutedSignalTypes', mode: 'add', userId: positionals[2], value: positionals[3] });
        return;
      }
      if (subcommand === 'unmute-type') {
        await mutateNotificationMuteList({ listName: 'mutedSignalTypes', mode: 'remove', userId: positionals[2], value: positionals[3] });
        return;
      }
      unknownSubcommand();
      return;

    case 'signals':
      if (!subcommand) {
        await listSignals();
        return;
      }
      if (subcommand === 'assign') {
        emitMutation(await assignSignal(positionals[2], positionals[3], mutationOptions));
        return;
      }
      if (subcommand === 'status') {
        emitMutation(await setSignalStatus(positionals[2], positionals[3], mutationOptions));
        return;
      }
      if (subcommand === 'feedback') {
        emitMutation(await recordSignalFeedback(positionals[2], positionals[3], { note: positionals.slice(4).join(' ') || undefined }, mutationOptions));
        return;
      }
      if (subcommand === 'handoff') {
        emitMutation(await createSignalHandoff(positionals[2], { target: positionals[3] ?? 'crm', note: positionals.slice(4).join(' ') || undefined }, mutationOptions));
        return;
      }
      if (subcommand === 'handoff-status') {
        emitMutation(await setSignalHandoffStatus(positionals[2], positionals[3], { providerRef: positionals[4], note: positionals.slice(5).join(' ') || undefined }, mutationOptions));
        return;
      }
      unknownSubcommand();
      return;

    case 'payments':
      if (!subcommand) {
        await listPayments();
        return;
      }
      if (subcommand === 'sync') {
        emitMutation(await syncPaymentState({ tenantId: positionals[2] }, mutationOptions));
        return;
      }
      if (subcommand === 'comp') {
        emitMutation(await compTenant(positionals[2], positionals[3], mutationOptions));
        return;
      }
      if (subcommand === 'override') {
        const overrideType = positionals[3];
        const valueArg = positionals[5];
        emitMutation(await createBillingOverride(positionals[2], overrideType, {
          amountCents: overrideType === 'support_credit' ? valueArg : undefined,
          expiresAt: positionals[6],
          planId: overrideType === 'support_credit' ? undefined : valueArg,
          reason: positionals[4],
        }, mutationOptions));
        return;
      }
      if (subcommand === 'override-revoke') {
        emitMutation(await revokeBillingOverride(positionals[2], { reason: positionals.slice(3).join(' ') || undefined }, mutationOptions));
        return;
      }
      if (subcommand === 'status') {
        emitMutation(await setSubscriptionStatus(positionals[2], positionals[3], mutationOptions));
        return;
      }
      if (subcommand === 'cancel') {
        emitMutation(await cancelSubscription(positionals[2], mutationOptions));
        return;
      }
      if (subcommand === 'checkout') {
        emitMutation(await createCheckoutSession(positionals[2], positionals[3], mutationOptions));
        return;
      }
      if (subcommand === 'portal') {
        emitMutation(await createBillingPortalSession(positionals[2], mutationOptions));
        return;
      }
      if (subcommand === 'recover') {
        emitMutation(await createInvoiceRecoverySession(positionals[2], mutationOptions));
        return;
      }
      if (subcommand === 'refund') {
        emitMutation(await recordInvoiceRefund(positionals[2], {
          amountCents: positionals[3],
          reason: positionals.slice(4).join(' ') || undefined,
        }, mutationOptions));
        return;
      }
      if (subcommand === 'webhook') {
        const eventType = positionals[2];
        const webhookArgs =
          eventType === 'checkout.completed'
            ? { tenantId: positionals[3], planId: positionals[4] }
            : {
                amountCents: amountValue,
                amountDueCents: amountValue,
                planId: planValue ?? positionals[5],
                providerInvoiceId: providerInvoiceValue,
                providerPriceId: providerPriceValue,
                status: positionals[4],
                subscriptionId: positionals[3],
              };
        emitMutation(await handlePaymentWebhook(eventType, webhookArgs, mutationOptions));
        return;
      }
      if (subcommand === 'webhook-sign') {
        const payloadPath = resolveCliPath(positionals[2], 'payments webhook-sign <payload.json>');
        const rawBody = await fs.readFile(payloadPath, 'utf8');
        const signatureHeader = signStripeWebhookPayload(rawBody, stripeWebhookSecret());
        emit(wantsJson ? { ok: true, signatureHeader } : signatureHeader);
        return;
      }
      if (subcommand === 'webhook-signed') {
        const payloadPath = resolveCliPath(positionals[2]);
        const signatureHeader = positionals[3];
        const rawBody = await fs.readFile(payloadPath, 'utf8');
        emitMutation(await handleSignedStripePaymentWebhook(rawBody, signatureHeader, {
          ...mutationOptions,
          endpointSecret: stripeWebhookSecret(),
        }));
        return;
      }
      unknownSubcommand();
      return;

    case 'lifecycle':
      if (!subcommand) {
        await listLifecycle();
        return;
      }
      unknownSubcommand();
      return;

    case 'lifecycle-playbook':
      if (!subcommand) {
        await listLifecyclePlaybook();
        return;
      }
      unknownSubcommand();
      return;

    case 'jobs':
      if (!subcommand || subcommand === 'list') {
        await listJobs();
        return;
      }
      if (subcommand === 'run') {
        const target = positionals[2];
        emitMutation(await runJobs({
          jobId: target?.startsWith('job_') ? target : undefined,
          queue: target && !target.startsWith('job_') ? target : undefined,
          limit,
        }, mutationOptions));
        return;
      }
      if (subcommand === 'retry') {
        emitMutation(await retryJob(positionals[2], mutationOptions));
        return;
      }
      if (subcommand === 'dlq') {
        const state = await loadState();
        emit(wantsJson ? { ok: true, deadLetter: state.deadLetter ?? [] } : table((state.deadLetter ?? []).map((job) => ({
          id: job.deadLetterId ?? job.id,
          job: job.originalJobId ?? job.id,
          queue: job.queue,
          type: job.type,
          attempts: `${job.attempts}/${job.maxAttempts}`,
          failedAt: job.failedAt ? new Date(job.failedAt).toISOString().slice(0, 16) : '-',
          error: job.message ?? '-',
          target: job.targetId,
        })), ['id', 'job', 'queue', 'type', 'attempts', 'failedAt', 'error', 'target']));
        return;
      }
      if (subcommand === 'requeue') {
        emitMutation(await requeueDeadLetterJob(positionals[2], mutationOptions));
        return;
      }
      if (subcommand === 'drain') {
        emitMutation(await drainJobs(positionals[2], mutationOptions));
        return;
      }
      unknownSubcommand();
      return;

    case 'backend':
      if (!subcommand) {
        await listBackendReadiness();
        return;
      }
      unknownSubcommand();
      return;

    case 'doctor': {
      const state = await loadState();
      const report = doctor(state);
      if (wantsJson) {
        emit(report);
      } else {
        emit([
          `Signal local doctor: ${report.ok ? 'PASS' : 'FAIL'}`,
          '',
          ...report.checks.map((check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.id}: ${check.message}`),
        ].join('\n'));
      }
      if (!report.ok) {
        process.exit(1);
      }
      return;
    }

    case 'export': {
      const state = await loadState();
      emit(wantsJson ? { ok: true, state } : JSON.stringify(state, null, 2));
      return;
    }

    default:
      throw new SignalStateError(`Unknown command: ${command}`, {
        code: 'UNKNOWN_COMMAND',
        details: { command, usage: 'help' },
      });
  }
}

run().catch(fail);
