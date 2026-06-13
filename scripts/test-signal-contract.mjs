#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bootstrapState, recordSchedulerHeartbeat } from './signal-state.mjs';
import { signEmailWebhookPayload, signSendGridWebhookPayload } from './signal-email-provider.mjs';
import { signStripeWebhookPayload } from './signal-payment-provider.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bareAdminCommands = new Set(['bootstrap', 'doctor', 'export', 'status']);
const valueOptions = new Set([
  '--actor',
  '--env-file',
  '--input',
  '--limit',
  '--output',
  '--save-evidence',
  '--stripe-customer',
  '--template',
  '--ttl-seconds',
]);

function collectStrings(value, strings = []) {
  if (typeof value === 'string') {
    strings.push(value);
    return strings;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, strings));
    return strings;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectStrings(item, strings));
  }
  return strings;
}

function adminReferenceKey(reference) {
  return reference.subcommand ? `${reference.command} ${reference.subcommand}` : reference.command;
}

function parseAdminReferenceTail(tail, source) {
  const tokens = tail.trim().split(/\s+/).filter(Boolean);
  const command = tokens[0];
  if (!command) {
    return null;
  }
  const next = tokens[1];
  const subcommand = next && !next.startsWith('-') && !next.startsWith('<') && !valueOptions.has(next)
    ? next
    : null;
  return { command, source, subcommand };
}

function collectAdminReferences(...values) {
  const references = new Map();
  values.flatMap((value) => collectStrings(value)).forEach((text) => {
    for (const match of text.matchAll(/npm run admin -- ([^\n]+)/g)) {
      const reference = parseAdminReferenceTail(match[1], text);
      if (reference) {
        references.set(adminReferenceKey(reference), reference);
      }
    }
  });
  return [...references.values()].sort((left, right) => adminReferenceKey(left).localeCompare(adminReferenceKey(right)));
}

function collectDocumentedAdminReferences(markdown) {
  return [...markdown.matchAll(/^- `([^`]+)`/gm)]
    .map((match) => parseAdminReferenceTail(match[1], 'docs/PRODUCT_COMPLETION_GOAL.md'))
    .filter(Boolean);
}

function adminCommandBlock(adminSource, commandName) {
  const marker = `    case '${commandName}':`;
  const start = adminSource.indexOf(marker);
  if (start < 0) {
    return null;
  }
  const nextCase = adminSource.indexOf('\n    case ', start + marker.length);
  const defaultCase = adminSource.indexOf('\n    default:', start + marker.length);
  const end = nextCase >= 0 ? nextCase : (defaultCase >= 0 ? defaultCase : adminSource.length);
  return adminSource.slice(start, end);
}

function adminSourceSupportsReference(adminSource, reference) {
  const block = adminCommandBlock(adminSource, reference.command);
  if (!block) {
    return false;
  }
  if (!reference.subcommand) {
    return bareAdminCommands.has(reference.command) || /if \(!subcommand/.test(block);
  }
  return block.includes(`subcommand === '${reference.subcommand}'`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => {
        if (!port) {
          reject(new Error('Failed to allocate a local test port.'));
          return;
        }
        resolve(port);
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseJsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    sleep(2000),
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

test('frontend source guards empty live state and non-JSON POST failures', async () => {
  const appEntrySource = await fs.readFile(path.join(rootDir, 'src', 'App.tsx'), 'utf8');
  const appSource = await fs.readFile(path.join(rootDir, 'src', 'pages', 'AppSurface.tsx'), 'utf8');
  const adminSource = await fs.readFile(path.join(rootDir, 'src', 'pages', 'AdminConsole.tsx'), 'utf8');
  const dataSource = await fs.readFile(path.join(rootDir, 'src', 'signalData.ts'), 'utf8');
  const stateSource = await fs.readFile(path.join(rootDir, 'scripts', 'signal-state.mjs'), 'utf8');
  const billingDomainSource = await fs.readFile(path.join(rootDir, 'scripts', 'domains', 'billing-read-model.mjs'), 'utf8');

  assert.match(appEntrySource, /lazy\(\(\) => import\('\.\/pages\/AppSurface'\)\)/);
  assert.match(appSource, /if \(!currentUser \|\| !tenant\)/);
  assert.match(appSource, /Workspace data unavailable/);
  assert.match(adminSource, /if \(!currentActor \|\| !tenant\)/);
  assert.match(adminSource, /Admin data unavailable/);
  assert.match(dataSource, /async function getJson<T>/);
  assert.match(dataSource, /async function readJsonPayload\(response: Response\)/);
  assert.equal((dataSource.match(/return getJson</g) ?? []).length, 28);
  assert.equal((dataSource.match(/response\.json\(\)\.catch\(\(\) => null\)/g) ?? []).length, 1);
  assert.match(stateSource, /from '\.\/domains\/billing-read-model\.mjs'/);
  assert.match(billingDomainSource, /export function billingReadModel/);

  const verifyCoreSource = await fs.readFile(path.join(rootDir, 'scripts', 'verify-signal-local-core.mjs'), 'utf8');
  const verifyTestSource = await fs.readFile(path.join(rootDir, 'scripts', 'test-signal-verify-local.mjs'), 'utf8');
  assert.match(verifyCoreSource, /export async function verifySignalLocal/);
  assert.match(verifyTestSource, /verifySignalLocal/);
});

test('Signal local API, CLI, auth, flow, and subscription contract', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-contract-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const sessionSecret = 'signal_contract_test_secret_32chars!';
  const emailWebhookSecret = 'signal_contract_email_webhook_secret';
  const sendGridKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sendGridPrivateKey = sendGridKeyPair.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const sendGridPublicKey = sendGridKeyPair.publicKey.export({ format: 'pem', type: 'spki' });
  const stripeWebhookSecret = 'signal_contract_stripe_webhook_secret';
  const port = await freePort();
  const apiBaseUrl = `http://127.0.0.1:${port}`;
  let apiProcess = null;
  let apiOutput = '';
  const blankSandboxProviderEnv = {
    SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET: '',
    SIGNAL_EMAIL_PROVIDER_TOKEN: '',
    SIGNAL_GMAIL_ACCESS_TOKEN: '',
    SIGNAL_OUTLOOK_ACCESS_TOKEN: '',
    SIGNAL_PROVIDER_ACCESS_TOKEN: '',
    SIGNAL_PROVIDER_SANDBOX_TIMEOUT_MS: '1000',
    SIGNAL_SENDGRID_API_KEY: '',
    SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: '',
    SIGNAL_STRIPE_PRICE_TEAM: '',
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
  };

  t.after(async () => {
    await stopProcess(apiProcess);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });

  const cliEnv = {
    ...process.env,
    SIGNAL_ADMIN_STATE: statePath,
    SIGNAL_OAUTH_STATE_KEY: 'signal_contract_oauth_state_key',
    SIGNAL_SESSION_SECRET: sessionSecret,
  };

  async function runCli(args, env = {}) {
    const { stdout } = await execFileAsync(process.execPath, [path.join(rootDir, 'scripts', 'signal-admin.mjs'), ...args], {
      cwd: rootDir,
      env: { ...cliEnv, ...env },
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  }

  await t.test('completion and QA report admin command references are implemented', async () => {
    const [adminSource, docsSource, completionAudit, qaAnswers, tenantIsolation] = await Promise.all([
      fs.readFile(path.join(rootDir, 'scripts', 'signal-admin.mjs'), 'utf8'),
      fs.readFile(path.join(rootDir, 'docs', 'PRODUCT_COMPLETION_GOAL.md'), 'utf8'),
      runCli(['completion-audit', '--json'], blankSandboxProviderEnv),
      runCli(['qa-answers', '--json'], blankSandboxProviderEnv),
      runCli(['tenant-isolation', '--json'], blankSandboxProviderEnv),
    ]);
    const referencesByKey = new Map([
      ...collectAdminReferences(completionAudit, qaAnswers, tenantIsolation),
      ...collectDocumentedAdminReferences(docsSource),
    ].map((reference) => [adminReferenceKey(reference), reference]));
    const unsupported = [...referencesByKey.values()]
      .filter((reference) => !adminSourceSupportsReference(adminSource, reference))
      .map(adminReferenceKey);

    assert.deepEqual(unsupported, []);

    const jobsList = await runCli(['jobs', 'list', '--json']);
    assert.equal(jobsList.ok, true);
    assert.ok(Array.isArray(jobsList.jobs));

    const sessionList = await runCli(['session', 'list', '--json']);
    assert.equal(sessionList.ok, true);
    assert.ok(Array.isArray(sessionList.availableUsers));
  });

  async function requestApi(pathname, { body, headers = {}, method = 'GET', token } = {}) {
    const response = await fetch(`${apiBaseUrl}${pathname}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      method,
    });
    return {
      headers: response.headers,
      payload: await parseJsonResponse(response),
      status: response.status,
    };
  }

  async function mutate(token, action, args = {}) {
    return requestApi('/api/mutations', {
      body: { action, args },
      method: 'POST',
      token,
    });
  }

  async function waitForApi() {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (apiProcess.exitCode !== null) {
        throw new Error(`Signal API exited before test startup.\n${apiOutput}`);
      }
      try {
        const response = await fetch(`${apiBaseUrl}/api/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) {
          return;
        }
      } catch {
        // Keep polling until the local API binds the test port.
      }
      await sleep(100);
    }
    throw new Error(`Signal API did not start on ${apiBaseUrl}.\n${apiOutput}`);
  }

  await t.test('app route source exposes public, workspace, and admin modes', async () => {
    const appEntrySource = await fs.readFile(path.join(rootDir, 'src', 'App.tsx'), 'utf8');
    const appSource = await fs.readFile(path.join(rootDir, 'src', 'pages', 'AppSurface.tsx'), 'utf8');
    const appRoutingSource = await fs.readFile(path.join(rootDir, 'src', 'pages', 'appRouting.ts'), 'utf8');
    const appStateSource = await fs.readFile(path.join(rootDir, 'src', 'pages', 'appState.ts'), 'utf8');
    const adminSource = await fs.readFile(path.join(rootDir, 'src', 'pages', 'AdminConsole.tsx'), 'utf8');
    const routeSource = `${appSource}\n${adminSource}`;
    const dataSource = await fs.readFile(path.join(rootDir, 'src', 'signalData.ts'), 'utf8');
    assert.match(appEntrySource, /Suspense/);
    assert.match(appSource, /window\.addEventListener\('hashchange'/);
    assert.match(appSource, /resolveAppRoute/);
    assert.match(appRoutingSource, /appRoutes/);
    assert.match(appRoutingSource, /#onboarding/);
    assert.match(appStateSource, /export function useSignalAppState/);
    assert.match(appStateSource, /optimisticMutationResponse/);
    assert.match(appStateSource, /Rolled back optimistic/);
    assert.match(appStateSource, /signals\.feedback/);
    assert.match(appStateSource, /accounts\.action-status/);
    assert.match(appStateSource, /payments\.recover/);
    assert.match(appSource, /mode === 'register'/);
    assert.match(appSource, /mode === 'workspace'/);
    assert.match(appSource, /mode === 'admin'/);
    assert.match(appSource, /lazy\(\(\) => import\('\.\/AdminConsole'\)/);
    assert.match(appSource, /Workspace registration/);
    assert.match(appSource, /Invite acceptance/);
    assert.match(appSource, /Complete onboarding/);
    assert.match(appSource, /tenants\.onboarding-complete/);
    assert.match(dataSource, /users\.invite-claim/);
    assert.match(dataSource, /tenants\.onboarding-complete/);
    assert.match(dataSource, /registerSignalWorkspace/);
    assert.match(dataSource, /\/api\/registration/);
    assert.match(appSource, /Workspace registration is self-service/);
    assert.match(appSource, /RBAC and privacy proof/);
    assert.match(appSource, /Onboarding and org decision/);
    assert.match(routeSource, /Onboarding, RBAC, and privacy readiness/);
    assert.match(routeSource, /onboarding-readiness/);
    assert.match(dataSource, /OnboardingReadinessReport/);
    assert.match(dataSource, /\/api\/onboarding-readiness/);
    assert.match(routeSource, /Tenant isolation audit/);
    assert.match(routeSource, /tenant-isolation/);
    assert.match(dataSource, /TenantIsolationAuditReport/);
    assert.match(dataSource, /\/api\/tenant-isolation/);
    assert.match(appSource, /Billing and usage/);
    assert.match(appSource, /Dashboard QA/);
    assert.match(routeSource, /Dashboard calculation audit/);
    assert.match(routeSource, /dashboard-audit/);
    assert.match(routeSource, /Digestion pipeline audit/);
    assert.match(routeSource, /digestion-pipeline/);
    assert.match(dataSource, /SignalDigestionPipelineReport/);
    assert.match(dataSource, /\/api\/digestion-pipeline/);
    assert.match(routeSource, /Webhook and rate-limit health/);
    assert.match(routeSource, /Email launch handoff/);
    assert.match(routeSource, /email-handoff/);
    assert.match(dataSource, /EmailHandoffReport/);
    assert.match(dataSource, /\/api\/email-handoff/);
    assert.match(routeSource, /operations-health/);
    assert.match(dataSource, /OperationsHealthReport/);
    assert.match(dataSource, /\/api\/operations-health/);
    assert.match(routeSource, /Production env audit/);
    assert.match(routeSource, /production-env/);
    assert.match(dataSource, /ProductionEnvAuditReport/);
    assert.match(dataSource, /\/api\/production-env/);
    assert.match(routeSource, /Production operations drill/);
    assert.match(routeSource, /production-drill/);
    assert.match(dataSource, /ProductionDrillReport/);
    assert.match(dataSource, /\/api\/production-drill/);
    assert.match(routeSource, /Production setup plan/);
    assert.match(routeSource, /production-plan/);
    assert.match(dataSource, /ProductionSetupPlanReport/);
    assert.match(dataSource, /\/api\/production-plan/);
    assert.match(routeSource, /Provider launch matrix/);
    assert.match(routeSource, /provider-launch/);
    assert.match(dataSource, /ProviderLaunchMatrixReport/);
    assert.match(dataSource, /\/api\/provider-launch/);
    assert.match(routeSource, /Provider handoff/);
    assert.match(routeSource, /provider-handoff/);
    assert.match(dataSource, /ProviderHandoffReport/);
    assert.match(dataSource, /\/api\/provider-handoff/);
    assert.match(routeSource, /Lifecycle playbook/);
    assert.match(routeSource, /lifecycle-playbook/);
    assert.match(dataSource, /LifecyclePlaybookReport/);
    assert.match(dataSource, /\/api\/lifecycle-playbook/);
    assert.match(routeSource, /Payment lifecycle audit/);
    assert.match(routeSource, /payment-lifecycle/);
    assert.match(dataSource, /PaymentLifecycleAuditReport/);
    assert.match(dataSource, /\/api\/payment-lifecycle/);
    assert.match(routeSource, /Payment launch handoff/);
    assert.match(routeSource, /payment-handoff/);
    assert.match(dataSource, /PaymentHandoffReport/);
    assert.match(dataSource, /\/api\/payment-handoff/);
    assert.match(routeSource, /Stakeholder QA answers/);
    assert.match(routeSource, /qa-answers/);
    assert.match(dataSource, /QaAnswersReport/);
    assert.match(dataSource, /\/api\/qa-answers/);
    assert.match(routeSource, /Completion audit/);
    assert.match(routeSource, /completion-audit/);
    assert.match(dataSource, /CompletionAuditReport/);
    assert.match(dataSource, /\/api\/completion-audit/);
    assert.match(routeSource, /Local agent handoff/);
    assert.match(routeSource, /agent-handoff/);
    assert.match(dataSource, /LocalAgentHandoffReport/);
    assert.match(dataSource, /\/api\/agent-handoff/);
    assert.match(routeSource, /Production backend handoff/);
    assert.match(routeSource, /backend-handoff/);
    assert.match(dataSource, /BackendHandoffReport/);
    assert.match(dataSource, /\/api\/backend-handoff/);
    assert.match(routeSource, /Backend cutover drill/);
    assert.match(routeSource, /backend-cutover/);
    assert.match(dataSource, /BackendCutoverDrillReport/);
    assert.match(dataSource, /\/api\/backend-cutover/);
    assert.match(routeSource, /Scheduler operations handoff/);
    assert.match(routeSource, /scheduler-handoff/);
    assert.match(dataSource, /SchedulerHandoffReport/);
    assert.match(dataSource, /\/api\/scheduler-handoff/);
    assert.match(routeSource, /Membership privacy boundary/);
    assert.match(routeSource, /Membership seats/);
    assert.match(appSource, /Strategy recommendations/);
    assert.match(appSource, /Lifecycle notices/);
    assert.match(routeSource, /Provider validation schedule/);
    assert.match(routeSource, /Backend boundary/);
    assert.match(dataSource, /integrations\.schedule/);
    assert.match(dataSource, /BackendReadiness/);
    assert.match(appSource, /<MarketingPage \/>/);
    assert.match(dataSource, /\/api\/state/);
    assert.match(dataSource, /\/api\/mutations/);
  });

  const adminTokenResult = await runCli(['session', 'token', 'usr_admin', '--json']);
  const memberTokenResult = await runCli(['session', 'token', 'usr_product', '--json']);
  const revokedCliTokenResult = await runCli(['session', 'token', 'usr_sales', '--json']);
  const sandboxCliResult = await runCli(['integrations', 'validate-sandbox', '--json'], blankSandboxProviderEnv);
  const cliRevoke = await runCli(['session', 'revoke', revokedCliTokenResult.details.apiSessionId, '--json'], {
    SIGNAL_ADMIN_ACTOR: 'usr_admin',
  });
  const adminToken = adminTokenResult.details.token;
  const memberToken = memberTokenResult.details.token;
  const revokedCliToken = revokedCliTokenResult.details.token;
  assert.match(adminToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.match(memberToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(sandboxCliResult.ok, false);
  assert.equal(sandboxCliResult.recorded.status, 'blocked');
  assert.match(sandboxCliResult.recorded.id, /^pvr_/);
  assert.equal(sandboxCliResult.sandbox.summary.blocked, 4);
  const cliIntegrationsList = await runCli(['integrations', '--json']);
  assert.equal(cliIntegrationsList.ok, true);
  assert.equal(cliIntegrationsList.providerValidationSchedules.length, 4);
  assert(cliIntegrationsList.providerValidationSchedules.some((schedule) => schedule.providerId === 'stripe' && schedule.lastRunId === sandboxCliResult.recorded.id));
  assert(cliIntegrationsList.providerValidationSchedules.some((schedule) => schedule.providerId === 'outbound-email' && schedule.lastRunId === sandboxCliResult.recorded.id && schedule.requiredEnv.includes('SIGNAL_SENDGRID_API_KEY')));
  const evidenceExportPath = path.join(tempDir, 'provider-sandbox-evidence.json');
  const cliEvidenceExport = await runCli(['integrations', 'evidence-export', sandboxCliResult.recorded.id, evidenceExportPath, '--json'], {
    SIGNAL_ADMIN_ACTOR: 'usr_admin',
  });
  assert.equal(cliEvidenceExport.action, 'integrations.sandbox.evidence-export');
  assert.equal(cliEvidenceExport.details.runId, sandboxCliResult.recorded.id);
  assert.equal(cliEvidenceExport.details.path, evidenceExportPath);
  const exportedEvidence = JSON.parse(await fs.readFile(evidenceExportPath, 'utf8'));
  assert.equal(exportedEvidence.artifactType, 'signal.provider_sandbox_evidence');
  assert.equal(exportedEvidence.schemaVersion, 1);
  assert.equal(exportedEvidence.sourceRun.id, sandboxCliResult.recorded.id);
  assert.equal(exportedEvidence.artifactDigest, cliEvidenceExport.details.artifactDigest);
  const exportedEvidenceJson = JSON.stringify(exportedEvidence);
  assert(!exportedEvidenceJson.includes(sessionSecret), 'provider evidence artifact should not expose local session secret');
  assert(!/sk_(?:live|test)_/.test(exportedEvidenceJson), 'provider evidence artifact should not expose Stripe keys');
  assert(!/SG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(exportedEvidenceJson), 'provider evidence artifact should not expose SendGrid keys');
  const cliEvidenceImport = await runCli(['integrations', 'evidence-import', evidenceExportPath, '--json'], {
    SIGNAL_ADMIN_ACTOR: 'usr_admin',
  });
  assert.equal(cliEvidenceImport.action, 'integrations.sandbox.evidence-import');
  assert.equal(cliEvidenceImport.details.importedFromRunId, sandboxCliResult.recorded.id);
  assert.match(cliEvidenceImport.details.id, /^pvr_/);
  assert.equal(cliEvidenceImport.details.status, 'blocked');
  const savedEvidencePath = path.join(tempDir, 'provider-sandbox-saved-evidence.json');
  const cliSavedEvidence = await runCli(['integrations', 'validate-sandbox', '--save-evidence', savedEvidencePath, '--json'], blankSandboxProviderEnv);
  assert.equal(cliSavedEvidence.ok, false);
  assert.equal(cliSavedEvidence.evidence.path, savedEvidencePath);
  assert.equal(cliSavedEvidence.evidence.runId, cliSavedEvidence.recorded.id);
  const savedEvidence = JSON.parse(await fs.readFile(savedEvidencePath, 'utf8'));
  assert.equal(savedEvidence.sourceRun.id, cliSavedEvidence.recorded.id);
  assert.equal(savedEvidence.artifactDigest, cliSavedEvidence.evidence.artifactDigest);
  const cliSchedule = await runCli(['integrations', 'schedule', 'stripe', 'weekly', '--json'], {
    SIGNAL_ADMIN_ACTOR: 'usr_admin',
  });
  assert.equal(cliSchedule.action, 'integrations.schedule');
  assert.equal(cliSchedule.details.cadence, 'weekly');
  assert.equal(cliSchedule.details.status, 'active');
  const cliScheduledSkip = await runCli(['integrations', 'run-scheduled', '--json']);
  assert.equal(cliScheduledSkip.ok, true);
  assert.equal(cliScheduledSkip.skipped, true);
  assert.equal(cliScheduledSkip.recorded, null);
  const cliRefreshDryRun = await runCli(['integrations', 'refresh-evidence', '--dry-run', '--json'], blankSandboxProviderEnv);
  assert.equal(cliRefreshDryRun.forced, true);
  assert.equal(cliRefreshDryRun.skipped, false);
  assert.equal(cliRefreshDryRun.recorded, null);
  assert.equal(cliRefreshDryRun.evidence, null);
  assert(Array.isArray(cliRefreshDryRun.dueSchedules));
  assert.equal(cliRefreshDryRun.sandbox.summary.total, 4);
  const cliJobsList = await runCli(['jobs', '--json']);
  assert(cliJobsList.jobs.some((job) => job.queue === 'provider_validation' && job.type === 'provider.sandbox.scheduled'));
  const cliProviderValidationNoop = await runCli(['jobs', 'run', 'provider_validation', '--limit', '1', '--json']);
  assert.equal(cliProviderValidationNoop.action, 'jobs.run');
  assert.equal(cliProviderValidationNoop.details.count, 0);
  const cliBackend = await runCli(['backend', '--json']);
  assert.equal(cliBackend.ok, true);
  assert.equal(cliBackend.backend.mode, 'local-json');
  assert.equal(cliBackend.backend.productionReady, false);
  assert(cliBackend.backend.checks.some((check) => check.id === 'signed_session_enforced'));
  const cliBackendHandoff = await runCli(['backend-handoff', '--json']);
  assert.equal(cliBackendHandoff.ok, true);
  assert.equal(cliBackendHandoff.handoff.ok, true);
  assert.equal(cliBackendHandoff.handoff.productionReady, false);
  assert.equal(cliBackendHandoff.handoff.summary.secretSafe, true);
  assert.equal(cliBackendHandoff.handoff.nextAction.id, 'backend_mode');
  assert(cliBackendHandoff.handoff.actions.some((row) => row.id === 'state_service_storage' && row.command.includes('state-service')));
  assert(cliBackendHandoff.handoff.actions.some((row) => row.id === 'identity_tenant_isolation' && row.command.includes('backend --env-file')));
  assert(cliBackendHandoff.handoff.runnableCommands.some((command) => command.includes('test:state-service')));
  assert(!JSON.stringify(cliBackendHandoff.handoff).includes(sessionSecret), 'backend handoff must not serialize local session secrets');
  const cliBackendCutover = await runCli(['backend-cutover', '--json']);
  assert.equal(cliBackendCutover.ok, true);
  assert.equal(cliBackendCutover.cutover.ok, true);
  assert.equal(cliBackendCutover.cutover.productionReady, false);
  assert.equal(cliBackendCutover.cutover.summary.secretSafe, true);
  assert.equal(cliBackendCutover.cutover.nextStep.id, 'start_external_state_service');
  assert(cliBackendCutover.cutover.rows.some((row) => row.id === 'verify_state_service_health' && row.command.includes('state-service:admin -- health')));
  assert(cliBackendCutover.cutover.rows.some((row) => row.id === 'api_external_mode_smoke' && row.rollbackCommand.includes('restart local development')));
  assert(cliBackendCutover.cutover.runnableCommands.some((command) => command.includes('backend-cutover --env-file')));
  assert(!JSON.stringify(cliBackendCutover.cutover).includes(sessionSecret), 'backend cutover drill must not serialize local session secrets');
  const cliSchedulerHandoff = await runCli(['scheduler-handoff', '--json']);
  assert.equal(cliSchedulerHandoff.ok, true);
  assert.equal(cliSchedulerHandoff.handoff.ok, true);
  assert.equal(cliSchedulerHandoff.handoff.productionReady, false);
  assert.equal(cliSchedulerHandoff.handoff.summary.secretSafe, true);
  assert.equal(cliSchedulerHandoff.handoff.nextStep.id, 'configure_scheduler_env');
  assert(cliSchedulerHandoff.handoff.rows.some((row) => row.id === 'dry_run_scheduler_tick' && row.command.includes('scheduler -- --once --dry-run')));
  assert(cliSchedulerHandoff.handoff.rows.some((row) => row.id === 'enable_continuous_scheduler' && row.rollbackCommand.includes('Stop the scheduler process')));
  assert(cliSchedulerHandoff.handoff.runnableCommands.some((command) => command.includes('scheduler-handoff --env-file')));
  assert(!JSON.stringify(cliSchedulerHandoff.handoff).includes(sessionSecret), 'scheduler handoff must not serialize local session secrets');
  const cliReadiness = await runCli(['readiness', '--json']);
  assert.equal(cliReadiness.ok, true);
  assert.equal(cliReadiness.readiness.productionReady, false);
  assert.equal(cliReadiness.readiness.summary.localReady, cliReadiness.readiness.summary.total);
  assert.equal(cliReadiness.readiness.summary.total, 10);
  assert(cliReadiness.readiness.requirements.every((requirement) => requirement.localOk), JSON.stringify(cliReadiness.readiness.requirements.filter((requirement) => !requirement.localOk)));
  assert(cliReadiness.readiness.requirements.some((requirement) => requirement.id === 'workspace_onboarding' && requirement.localOk === true));
  assert(cliReadiness.readiness.requirements.some((requirement) => requirement.id === 'provider_integrations' && requirement.status === 'needs_live_provider'));
  assert(cliReadiness.readiness.requirements.some((requirement) => requirement.id === 'production_backend_and_scheduler' && requirement.status === 'needs_production'));
  const cliCompletionAudit = await runCli(['completion-audit', '--json'], blankSandboxProviderEnv);
  assert.equal(cliCompletionAudit.ok, true);
  assert.equal(cliCompletionAudit.completion.ok, true);
  assert.equal(cliCompletionAudit.completion.localComplete, true);
  assert.equal(cliCompletionAudit.completion.productionReady, false);
  assert.equal(cliCompletionAudit.completion.summary.localReady, cliCompletionAudit.completion.summary.total);
  assert.equal(cliCompletionAudit.completion.summary.secretSafe, true);
  assert.equal(cliCompletionAudit.completion.nextLocal, null);
  assert.equal(cliCompletionAudit.completion.nextProduction.id, 'workspace_registration_onboarding');
  assert.equal(cliCompletionAudit.completion.rows.length, 8);
  assert(cliCompletionAudit.completion.rows.every((row) => row.localOk), JSON.stringify(cliCompletionAudit.completion.rows.filter((row) => !row.localOk)));
  assert.deepEqual(
    cliCompletionAudit.completion.rows.map((row) => row.id).sort(),
    [
      'core_admin_area',
      'core_user_workspace',
      'email_flow_management',
      'local_admin_cli_agent',
      'payment_processing_architecture',
      'public_product_entry',
      'rbac_privacy_multi_member_org',
      'workspace_registration_onboarding',
    ],
  );
  assert(cliCompletionAudit.completion.rows.some((row) => row.id === 'core_user_workspace' && row.localOk === true));
  assert(cliCompletionAudit.completion.rows.some((row) => row.id === 'email_flow_management' && row.commands.some((command) => command.includes('email-handoff'))));
  assert(cliCompletionAudit.completion.runnableCommands.some((command) => command.includes('completion-audit --json')));
  assert(!JSON.stringify(cliCompletionAudit.completion).includes(sessionSecret), 'completion audit must not serialize local session secrets');
  const cliAgentHandoff = await runCli(['agent-handoff', '--json'], blankSandboxProviderEnv);
  assert.equal(cliAgentHandoff.ok, true);
  assert.equal(cliAgentHandoff.handoff.ok, true);
  assert.equal(cliAgentHandoff.handoff.goLiveReady, false);
  assert.equal(cliAgentHandoff.handoff.summary.secretSafe, true);
  assert.equal(cliAgentHandoff.handoff.nextAction.id, 'production_backend');
  assert.equal(cliAgentHandoff.handoff.summary.blockedGates, 7);
  assert(cliAgentHandoff.handoff.nextAction.command.includes('backend'));
  assert(cliAgentHandoff.handoff.runnableCommands.some((command) => command.includes('launch-gate')));
  assert(cliAgentHandoff.handoff.providerAttention.some((row) => row.id === 'stripe' && row.command.includes('provider-launch')));
  assert(!JSON.stringify(cliAgentHandoff.handoff).includes(sessionSecret), 'agent handoff must not serialize local session secrets');
  const cliOnboardingReadiness = await runCli(['onboarding-readiness', '--json']);
  assert.equal(cliOnboardingReadiness.ok, true);
  assert.equal(cliOnboardingReadiness.onboarding.ok, true);
  assert.equal(cliOnboardingReadiness.onboarding.recommendation.decision, 'support_multi_member_orgs');
  assert.equal(cliOnboardingReadiness.onboarding.productionReady, false);
  assert(cliOnboardingReadiness.onboarding.rows.some((row) => row.area === 'multi_user_org' && row.localOk === true));
  assert(cliOnboardingReadiness.onboarding.rows.some((row) => row.area === 'data_privacy' && row.localOk === true));
  assert(cliOnboardingReadiness.onboarding.roleMatrix.some((row) => row.role === 'member' && row.guardrails.includes('owner_or_team_scope')));
  const cliTenantIsolation = await runCli(['tenant-isolation', '--json']);
  assert.equal(cliTenantIsolation.ok, true);
  assert.equal(cliTenantIsolation.isolation.ok, true);
  assert.equal(cliTenantIsolation.isolation.productionReady, false);
  assert(cliTenantIsolation.isolation.rows.some((row) => row.area === 'actor_scoped_visibility' && row.localOk === true));
  assert(cliTenantIsolation.isolation.rows.some((row) => row.area === 'production_rls_policy' && row.requiredEnv.includes('SIGNAL_TENANT_ISOLATION_MODE')));
  assert(cliTenantIsolation.isolation.roleMatrix.some((row) => row.role === 'member' && row.guardrails.includes('owner_or_team_scope')));
  const cliDigestionPipeline = await runCli(['digestion-pipeline', '--json']);
  assert.equal(cliDigestionPipeline.ok, false);
  assert.equal(cliDigestionPipeline.pipeline.ok, false);
  assert.equal(cliDigestionPipeline.pipeline.productionReady, false);
  assert.equal(cliDigestionPipeline.pipeline.recommendation.decision, 'shared_detector_with_tenant_controls');
  assert.equal(cliDigestionPipeline.pipeline.summary.perTenantModels, 0);
  assert(cliDigestionPipeline.pipeline.summary.localReady < cliDigestionPipeline.pipeline.summary.total);
  assert(cliDigestionPipeline.pipeline.rows.some((row) => row.area === 'detector_execution' && row.localOk === false));
  assert(cliDigestionPipeline.pipeline.rows.some((row) => row.area === 'quality_suppression_feedback' && row.localOk === true));
  assert(cliDigestionPipeline.pipeline.rows.some((row) => row.area === 'model_learning_boundary' && row.commands.some((command) => command.includes('models --json'))));
  const cliOperationsHealth = await runCli(['operations-health', '--json']);
  assert.equal(cliOperationsHealth.ok, true);
  assert.equal(cliOperationsHealth.operations.ok, true);
  assert.equal(cliOperationsHealth.operations.productionReady, false);
  assert(cliOperationsHealth.operations.webhooks.some((row) => row.channel === 'gmail' && row.path === '/api/webhooks/gmail'));
  assert(cliOperationsHealth.operations.webhooks.some((row) => row.channel === 'outbound_email' && row.path === '/api/webhooks/email'));
  assert(cliOperationsHealth.operations.webhooks.some((row) => row.channel === 'stripe' && row.path === '/api/webhooks/stripe'));
  assert(cliOperationsHealth.operations.queues.some((row) => row.queue === 'billing_webhook' && row.failed === 0));
  assert(cliOperationsHealth.operations.queues.some((row) => row.queue === 'outbound_email'));
  assert(cliOperationsHealth.operations.queues.some((row) => row.queue === 'provider_validation'));
  assert.equal(cliOperationsHealth.operations.summary.activeBackoffs, 0);
  const cliProductionDrill = await runCli(['production-drill', '--json']);
  assert.equal(cliProductionDrill.ok, true);
  assert.equal(cliProductionDrill.drill.ok, true);
  assert.equal(cliProductionDrill.drill.productionReady, false);
  assert(cliProductionDrill.drill.rows.some((row) => row.area === 'backup_restore_rehearsal' && row.requiredEnv.includes('SIGNAL_STATE_RESTORE_REHEARSAL_AT')));
  assert(cliProductionDrill.drill.rows.some((row) => row.area === 'scheduler_daemon' && row.requiredEnv.includes('SIGNAL_SCHEDULER_LOCK_POLICY')));
  assert(cliProductionDrill.drill.rows.some((row) => row.area === 'alerting_runbook' && row.requiredEnv.includes('SIGNAL_OPERATIONS_RUNBOOK_URL')));
  const cliProductionEnv = await runCli(['production-env', '--json'], blankSandboxProviderEnv);
  assert.equal(cliProductionEnv.ok, true);
  assert.equal(cliProductionEnv.env.ok, true);
  assert.equal(cliProductionEnv.env.envReady, false);
  assert.equal(cliProductionEnv.env.templateReady, true);
  assert.equal(cliProductionEnv.env.summary.secretSafe, true);
  assert.equal(cliProductionEnv.env.summary.totalRows, 9);
  assert(cliProductionEnv.env.rows.some((row) => row.id === 'backend_state_service' && row.missingRequired.includes('DATABASE_URL')));
  assert(cliProductionEnv.env.rows.some((row) => row.id === 'production_plan_union' && row.requiredEnv.includes('SIGNAL_OPERATIONS_ALERT_CHANNEL')));
  assert(!JSON.stringify(cliProductionEnv.env).includes(sessionSecret), 'production env audit must not serialize local session secrets');
  const cliProductionPlan = await runCli(['production-plan', '--json'], blankSandboxProviderEnv);
  assert.equal(cliProductionPlan.ok, true);
  assert.equal(cliProductionPlan.plan.ok, true);
  assert.equal(cliProductionPlan.plan.productionReady, false);
  assert.equal(cliProductionPlan.plan.summary.secretSafe, true);
  assert.equal(cliProductionPlan.plan.summary.total, 10);
  assert(cliProductionPlan.plan.rows.some((row) => row.id === 'durable_backend_storage' && row.status === 'blocked' && row.requiredEnv.includes('DATABASE_URL')));
  assert(cliProductionPlan.plan.rows.some((row) => row.id === 'provider_sandbox_evidence' && row.commands.some((command) => command.includes('validate-sandbox'))));
  assert(cliProductionPlan.plan.rows.some((row) => row.id === 'provider_parity_drift' && row.commands.some((command) => command.includes('email-flows sync'))));
  assert(cliProductionPlan.plan.rows.some((row) => row.id === 'launch_evidence_package' && row.commands.some((command) => command.includes('launch-gate package'))));
  assert(!JSON.stringify(cliProductionPlan.plan).includes(sessionSecret), 'production setup plan must not serialize local session secrets');
  const cliProviderLaunch = await runCli(['provider-launch', '--json'], blankSandboxProviderEnv);
  assert.equal(cliProviderLaunch.ok, true);
  assert.equal(cliProviderLaunch.launch.productionReady, false);
  assert.equal(cliProviderLaunch.launch.summary.total, 5);
  assert.equal(cliProviderLaunch.launch.summary.secretSafe, true);
  assert(cliProviderLaunch.launch.rows.some((row) => row.id === 'gmail' && row.webhookPath === '/api/webhooks/gmail' && row.evidenceCommands.some((command) => command.includes('validate-sandbox'))));
  assert(cliProviderLaunch.launch.rows.some((row) => row.id === 'outlook' && row.lifecycleWebhookPath === '/api/webhooks/outlook/lifecycle'));
  assert(cliProviderLaunch.launch.rows.some((row) => row.id === 'outbound-email' && row.label.includes('SendGrid') && row.signedReplayCommand.includes('notifications webhook-signed')));
  assert(cliProviderLaunch.launch.rows.some((row) => row.id === 'stripe' && row.launchCommands.some((command) => command.includes('payments checkout'))));
  assert(!JSON.stringify(cliProviderLaunch.launch).includes(sessionSecret), 'provider launch matrix must not serialize local session secrets');
  const cliProviderHandoff = await runCli(['provider-handoff', '--json'], blankSandboxProviderEnv);
  assert.equal(cliProviderHandoff.ok, true);
  assert.equal(cliProviderHandoff.handoff.ok, true);
  assert.equal(cliProviderHandoff.handoff.productionReady, false);
  assert.equal(cliProviderHandoff.handoff.summary.secretSafe, true);
  assert.equal(cliProviderHandoff.handoff.nextAction.id, 'gmail_configuration');
  assert(cliProviderHandoff.handoff.actions.some((row) => row.id === 'gmail_configuration' && row.requiredEnv.includes('SIGNAL_GMAIL_CLIENT_ID')));
  assert(cliProviderHandoff.handoff.actions.some((row) => row.id === 'stripe_configuration' && row.command.includes('provider-launch')));
  assert(cliProviderHandoff.handoff.runnableCommands.some((command) => command.includes('validate-sandbox')));
  assert(!JSON.stringify(cliProviderHandoff.handoff).includes(sessionSecret), 'provider handoff must not serialize local session secrets');
  const cliEmailHandoff = await runCli(['email-handoff', '--json'], blankSandboxProviderEnv);
  assert.equal(cliEmailHandoff.ok, true);
  assert.equal(cliEmailHandoff.handoff.ok, true);
  assert.equal(cliEmailHandoff.handoff.productionReady, false);
  assert.equal(cliEmailHandoff.handoff.summary.secretSafe, true);
  assert.equal(cliEmailHandoff.handoff.nextStep.id, 'configure_gmail_env');
  assert(cliEmailHandoff.handoff.rows.some((row) => row.id === 'prove_watch_and_sync_launch' && row.command.includes('mailboxes watch')));
  assert(cliEmailHandoff.handoff.rows.some((row) => row.id === 'prove_outbound_digest_delivery' && row.command.includes('notifications digest')));
  assert(cliEmailHandoff.handoff.rows.some((row) => row.id === 'replay_signed_delivery_webhooks' && row.command.includes('notifications webhook-signed')));
  assert(cliEmailHandoff.handoff.runnableCommands.some((command) => command.includes('email-handoff --env-file')));
  assert(!JSON.stringify(cliEmailHandoff.handoff).includes(sessionSecret), 'email handoff must not serialize local session secrets');
  assert(!JSON.stringify(cliEmailHandoff.handoff).includes(emailWebhookSecret), 'email handoff must not serialize email webhook secrets');
  const cliModels = await runCli(['models', '--json']);
  assert.equal(cliModels.ok, true);
  assert(cliModels.modelGovernancePolicies.some((policy) => policy.tenantId === 'tenant_demo' && policy.detectorBoundary === 'shared_detector' && policy.perTenantModel === false));
  assert(cliModels.modelGovernanceReports.some((report) => report.evidence.enabledDetectorFlows >= 1 && report.evidence.sourceMessages >= 1));
  const cliModelPolicy = await runCli(['models', 'policy', 'tenant_demo', 'opt_in_tuning', 'Governance_reviewed', '--json'], {
    SIGNAL_ADMIN_ACTOR: 'usr_admin',
  });
  assert.equal(cliModelPolicy.action, 'models.policy');
  assert.equal(cliModelPolicy.details.learningMode, 'opt_in_tuning');
  assert.equal(cliModelPolicy.details.trainingDataUse, 'opt_in_only');
  assert.equal(cliModelPolicy.details.perTenantModel, false);
  assert.equal(cliRevoke.action, 'session.revoke');
  assert.equal(cliRevoke.details.sessionId, revokedCliTokenResult.details.apiSessionId);
  const cliSessionList = await runCli(['session', '--json']);
  assert(cliSessionList.apiSessions.some((session) => session.id === adminTokenResult.details.apiSessionId && session.status === 'active'));
  assert(cliSessionList.apiSessions.some((session) => session.id === revokedCliTokenResult.details.apiSessionId && session.status === 'revoked'));
  const cliTenantList = await runCli(['tenants', '--json']);
  assert.equal(cliTenantList.ok, true);
  assert.equal(cliTenantList.tenants[0].status, 'active');
  assert.equal(cliTenantList.summary.tenantStatus, 'active');
  const cliUserList = await runCli(['users', '--json']);
  assert.equal(cliUserList.ok, true);
  assert(cliUserList.memberships.some((membership) => membership.userId === 'usr_admin' && membership.role === 'admin' && membership.status === 'active'));
  assert.equal(cliUserList.summary.activeMemberships, cliUserList.memberships.filter((membership) => membership.status === 'active').length);
  const cliAccountsList = await runCli(['accounts', '--json']);
  assert.equal(cliAccountsList.ok, true);
  assert(cliAccountsList.accountRecommendations.some((recommendation) => recommendation.kind === 'renewal_save' && recommendation.priority === 'critical' && recommendation.evidenceSignalIds.length >= 1));
  const cliLifecycleList = await runCli(['lifecycle', '--json']);
  assert.equal(cliLifecycleList.ok, true);
  assert(cliLifecycleList.lifecycleNotices.some((notice) => notice.category === 'payment' && notice.trigger === 'subscription_starting_point'));
  assert(cliLifecycleList.lifecycleNotices.some((notice) => notice.category === 'source' && notice.sourceIds?.mailboxId));
  const cliLifecyclePlaybook = await runCli(['lifecycle-playbook', '--json']);
  assert.equal(cliLifecyclePlaybook.ok, true);
  assert.equal(cliLifecyclePlaybook.playbook.summary.secretSafe, true);
  assert(cliLifecyclePlaybook.playbook.rows.some((row) => row.id === 'failed_payment_recovery' && row.commands.some((command) => command.includes('payments recover'))));
  assert(cliLifecyclePlaybook.playbook.rows.some((row) => row.id === 'cancel_resubscription' && row.triggers.includes('subscription_canceled')));
  assert(cliLifecyclePlaybook.playbook.rows.some((row) => row.id === 'multi_member_rbac_privacy' && row.adminAction.includes('membership role')));
  assert(cliLifecyclePlaybook.playbook.rows.some((row) => row.id === 'mailbox_disconnect_reauth' && row.commands.some((command) => command.includes('mailboxes disconnect'))));
  const cliPaymentLifecycle = await runCli(['payment-lifecycle', '--json']);
  assert.equal(cliPaymentLifecycle.ok, false);
  assert.equal(cliPaymentLifecycle.payment.ok, false);
  assert.equal(cliPaymentLifecycle.payment.productionReady, false);
  assert(cliPaymentLifecycle.payment.summary.localReady < cliPaymentLifecycle.payment.summary.total);
  assert(cliPaymentLifecycle.payment.rows.some((row) => row.area === 'failed_payment_recovery' && row.commands.some((command) => command.includes('payments recover'))));
  assert(cliPaymentLifecycle.payment.rows.some((row) => row.area === 'signed_webhook_replay' && row.localOk === false));
  assert(cliPaymentLifecycle.payment.rows.some((row) => row.area === 'stripe_launch_evidence' && row.requiredEnv.includes('STRIPE_WEBHOOK_SECRET')));
  const cliPaymentHandoff = await runCli(['payment-handoff', '--json'], blankSandboxProviderEnv);
  assert.equal(cliPaymentHandoff.ok, true);
  assert.equal(cliPaymentHandoff.handoff.ok, true);
  assert.equal(cliPaymentHandoff.handoff.productionReady, false);
  assert.equal(cliPaymentHandoff.handoff.summary.secretSafe, true);
  assert.equal(cliPaymentHandoff.handoff.nextStep.id, 'configure_stripe_env');
  assert(cliPaymentHandoff.handoff.rows.some((row) => row.id === 'prove_signed_webhook_replay' && row.command.includes('webhook-signed')));
  assert(cliPaymentHandoff.handoff.rows.some((row) => row.id === 'prove_failed_payment_recovery' && row.command.includes('payments recover')));
  assert(cliPaymentHandoff.handoff.rows.some((row) => row.id === 'package_payment_launch_evidence' && row.rollbackCommand.includes('Reject the launch package')));
  assert(cliPaymentHandoff.handoff.runnableCommands.some((command) => command.includes('payment-handoff --env-file')));
  assert(!JSON.stringify(cliPaymentHandoff.handoff).includes(sessionSecret), 'payment handoff must not serialize local session secrets');
  assert(!JSON.stringify(cliPaymentHandoff.handoff).includes(stripeWebhookSecret), 'payment handoff must not serialize Stripe webhook secrets');
  const cliQaAnswers = await runCli(['qa-answers', '--json']);
  assert.equal(cliQaAnswers.ok, true);
  assert.equal(cliQaAnswers.qa.ok, true);
  assert.equal(cliQaAnswers.qa.productionReady, false);
  assert.equal(cliQaAnswers.qa.summary.secretSafe, true);
  assert(cliQaAnswers.qa.rows.some((row) => row.id === 'dashboard_calculations_backend' && row.commands.some((command) => command.includes('dashboard-audit'))));
  assert(cliQaAnswers.qa.rows.some((row) => row.id === 'data_digestion_model_boundary' && row.answer.includes('shared detector')));
  assert(cliQaAnswers.qa.rows.some((row) => row.id === 'data_digestion_model_boundary' && row.commands.some((command) => command.includes('digestion-pipeline'))));
  assert(cliQaAnswers.qa.rows.some((row) => row.id === 'multi_user_same_org_rbac' && row.status === 'needs_production'));
  assert(cliQaAnswers.qa.rows.some((row) => row.id === 'payment_lifecycle_handling' && row.status === 'needs_live_provider'));

  apiProcess = spawn(process.execPath, [path.join(rootDir, 'scripts', 'signal-api.mjs')], {
    cwd: rootDir,
    env: {
      ...process.env,
      SIGNAL_ADMIN_STATE: statePath,
      SIGNAL_API_HOST: '127.0.0.1',
      SIGNAL_API_PORT: String(port),
      ...blankSandboxProviderEnv,
      SIGNAL_OAUTH_STATE_KEY: cliEnv.SIGNAL_OAUTH_STATE_KEY,
      SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
      SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET: emailWebhookSecret,
      SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: sendGridPublicKey,
      SIGNAL_SESSION_SECRET: sessionSecret,
      SIGNAL_WEBHOOK_ACTOR: 'usr_admin',
      STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apiProcess.stdout.on('data', (chunk) => {
    apiOutput += chunk.toString();
  });
  apiProcess.stderr.on('data', (chunk) => {
    apiOutput += chunk.toString();
  });
  await waitForApi();

  await t.test('signed session boundary protects local API state', async () => {
    const rejected = await requestApi('/api/state');
    assert.equal(rejected.status, 401);
    assert.equal(rejected.payload.code, 'SESSION_TOKEN_REQUIRED');

    const revokedCliRejected = await requestApi('/api/state', { token: revokedCliToken });
    assert.equal(revokedCliRejected.status, 401);
    assert.equal(revokedCliRejected.payload.code, 'SESSION_REVOKED');

    const rawActorRejected = await requestApi('/api/state', {
      headers: { 'X-Signal-Actor': 'usr_admin' },
    });
    assert.equal(rawActorRejected.status, 401);
    assert.equal(rawActorRejected.payload.code, 'SESSION_TOKEN_REQUIRED');

    const session = await requestApi('/api/session', { token: adminToken });
    assert.equal(session.status, 200);
    assert.equal(session.payload.auth.mode, 'signed_session');
    assert.equal(session.payload.auth.transport, 'header');
    assert.equal(session.payload.actor.id, 'usr_admin');

    const corsSession = await requestApi('/api/session', {
      headers: { Origin: 'http://127.0.0.1:5173' },
      token: adminToken,
    });
    assert.equal(corsSession.status, 200);
    assert.equal(corsSession.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
    assert.equal(corsSession.headers.get('access-control-allow-credentials'), 'true');

    const state = await requestApi('/api/state', { token: adminToken });
    assert.equal(state.status, 200);
    assert.equal(state.payload.ok, true);
    assert.equal(state.payload.summary.activeUserId, 'usr_admin');
    const initialProviderValidationRunCount = state.payload.summary.providerValidationRuns;
    assert(initialProviderValidationRunCount >= 3);
    assert.equal(state.payload.summary.providerValidationSchedules, 4);
    assert(state.payload.summary.activeProviderValidationSchedules >= 1);
    assert.equal(state.payload.backend.mode, 'local-json');
    assert.equal(state.payload.backend.productionReady, false);
    assert(state.payload.summary.lifecycleNotices >= 1);
    assert(state.payload.state.lifecycleNotices.some((notice) => notice.category === 'payment'));
    assert.equal(state.payload.state.providerValidationRuns[0].status, 'blocked');
    assert(state.payload.state.providerValidationSchedules.some((schedule) => schedule.providerId === 'stripe' && schedule.cadence === 'weekly'));
    assert(!JSON.stringify(state.payload.state.providerValidationRuns).includes(sessionSecret), 'provider validation evidence should not expose local session secret');

    const pagedSignals = await requestApi('/api/signals?pageSize=2', { token: adminToken });
    assert.equal(pagedSignals.status, 200);
    assert.equal(pagedSignals.payload.pagination.page, 1);
    assert.equal(pagedSignals.payload.pagination.pageSize, 2);
    assert.equal(pagedSignals.payload.pagination.total, state.payload.state.signals.length);
    assert.equal(pagedSignals.payload.pagination.hasNextPage, true);
    assert.equal(pagedSignals.payload.signals.length, 2);

    const clampedJobs = await requestApi('/api/jobs?pageSize=500', { token: adminToken });
    assert.equal(clampedJobs.status, 200);
    assert.equal(clampedJobs.payload.pagination.pageSize, 100);
    assert.equal(clampedJobs.payload.pagination.total, state.payload.state.jobs.length);

    const payments = await requestApi('/api/payments', { token: adminToken });
    assert.equal(payments.status, 200);
    assert(payments.payload.payments.some((row) => row.kind === 'subscription' && row.id === 'sub_demo'));
    assert(payments.payload.payments.some((row) => row.kind === 'invoice' && row.id === 'inv_demo_paid'));
    assert.equal(payments.payload.summary.subscriptions, state.payload.state.subscriptions.length);
    assert.equal(payments.payload.pagination.total, payments.payload.summary.total);

    const invalidPageSize = await requestApi('/api/signals?pageSize=0', { token: adminToken });
    assert.equal(invalidPageSize.status, 400);
    assert.equal(invalidPageSize.payload.code, 'INVALID_PAGINATION');
    assert.equal(invalidPageSize.payload.details.parameter, 'pageSize');

    const memberScopedState = await requestApi('/api/state', { token: memberToken });
    assert.equal(memberScopedState.status, 200);
    assert.deepEqual(memberScopedState.payload.state.signals.map((signal) => signal.id).sort(), ['sig_product_001']);
    assert.deepEqual(memberScopedState.payload.state.mailboxes.map((mailbox) => mailbox.id).sort(), ['mbx_gmail_product']);

    const memberSignals = await requestApi('/api/signals', { token: memberToken });
    assert.equal(memberSignals.status, 200);
    assert.deepEqual(memberSignals.payload.signals.map((signal) => signal.id).sort(), ['sig_product_001']);
    assert.equal(memberSignals.payload.signals.some((signal) => signal.ownerUserId === 'usr_sales'), false);
    assert.equal(JSON.stringify(memberSignals.payload.signals).includes('sig_expansion_001'), false);
    assert.equal(Object.hasOwn(memberSignals.payload.signals[0], 'sourceSnippet'), false);

    const memberMailboxes = await requestApi('/api/mailboxes', { token: memberToken });
    assert.equal(memberMailboxes.status, 200);
    assert.deepEqual(memberMailboxes.payload.mailboxes.map((mailbox) => mailbox.id).sort(), ['mbx_gmail_product']);
    assert.equal(memberMailboxes.payload.mailboxes.some((mailbox) => mailbox.ownerUserId === 'usr_sales'), false);
    assert.equal(JSON.stringify(memberMailboxes.payload.mailboxes).includes('mbx_gmail_sales'), false);
    assert.equal(Object.hasOwn(memberMailboxes.payload.mailboxes[0], 'credentialDigest'), false);

    const integrations = await requestApi('/api/integrations', { token: adminToken });
    assert.equal(integrations.status, 200);
    assert.equal(integrations.payload.providerValidationSchedules.length, 4);
    assert.equal(integrations.payload.summary.providerValidationSchedules, 4);
    assert(integrations.payload.providerValidationRuns.some((run) => run.status === 'blocked'));

    const scheduledDue = await requestApi('/api/integrations/scheduled', { token: adminToken });
    assert.equal(scheduledDue.status, 200);
    assert.equal(scheduledDue.payload.providerValidationSchedules.length, 4);
    assert.equal(scheduledDue.payload.dueSchedules.length, 0);

    const scheduledRun = await requestApi('/api/integrations/scheduled', {
      body: { force: true },
      method: 'POST',
      token: adminToken,
    });
    assert.equal(scheduledRun.status, 200);
    assert.equal(scheduledRun.payload.skipped, false);
    assert.equal(scheduledRun.payload.forced, true);
    assert.equal(scheduledRun.payload.recorded.status, 'blocked');
    assert.match(scheduledRun.payload.recorded.id, /^pvr_/);
    assert.equal(scheduledRun.payload.summary.providerValidationRuns, initialProviderValidationRunCount + 1);
    assert(scheduledRun.payload.state.providerValidationSchedules.some((schedule) => schedule.lastRunId === scheduledRun.payload.recorded.id));
    assert(!JSON.stringify(scheduledRun.payload.state.providerValidationRuns).includes(sessionSecret), 'scheduled sandbox evidence should not expose local session secret');
    const afterScheduledProviderValidationRunCount = scheduledRun.payload.summary.providerValidationRuns;

    const backend = await requestApi('/api/backend', { token: adminToken });
    assert.equal(backend.status, 200);
    assert.equal(backend.payload.backend.mode, 'local-json');
    assert.equal(backend.payload.backend.productionReady, false);
    assert(backend.payload.backend.summary.missingRequiredEnv.includes('DATABASE_URL'));

    const backendHandoff = await requestApi('/api/backend-handoff', { token: adminToken });
    assert.equal(backendHandoff.status, 200);
    assert.equal(backendHandoff.payload.ok, true);
    assert.equal(backendHandoff.payload.handoff.ok, true);
    assert.equal(backendHandoff.payload.handoff.productionReady, false);
    assert.equal(backendHandoff.payload.handoff.summary.secretSafe, true);
    assert.equal(backendHandoff.payload.handoff.nextAction.id, 'backend_mode');
    assert(backendHandoff.payload.handoff.actions.some((row) => row.id === 'state_service_health' && row.command.includes('state-service:admin')));
    assert(!JSON.stringify(backendHandoff.payload.handoff).includes(sessionSecret), 'backend handoff API must not serialize local session secrets');

    const backendCutover = await requestApi('/api/backend-cutover', { token: adminToken });
    assert.equal(backendCutover.status, 200);
    assert.equal(backendCutover.payload.ok, true);
    assert.equal(backendCutover.payload.cutover.ok, true);
    assert.equal(backendCutover.payload.cutover.productionReady, false);
    assert.equal(backendCutover.payload.cutover.summary.secretSafe, true);
    assert.equal(backendCutover.payload.cutover.nextStep.id, 'start_external_state_service');
    assert(backendCutover.payload.cutover.rows.some((row) => row.id === 'backup_restore_rehearsal' && row.command.includes('state-service:admin -- backup')));
    assert(backendCutover.payload.cutover.rows.some((row) => row.id === 'scheduler_single_runner_cutover' && row.rollbackCommand.includes('continuous scheduler disabled')));
    assert(!JSON.stringify(backendCutover.payload.cutover).includes(sessionSecret), 'backend cutover API must not serialize local session secrets');

    const schedulerHandoff = await requestApi('/api/scheduler-handoff', { token: adminToken });
    assert.equal(schedulerHandoff.status, 200);
    assert.equal(schedulerHandoff.payload.ok, true);
    assert.equal(schedulerHandoff.payload.handoff.ok, true);
    assert.equal(schedulerHandoff.payload.handoff.productionReady, false);
    assert.equal(schedulerHandoff.payload.handoff.summary.secretSafe, true);
    assert.equal(schedulerHandoff.payload.handoff.nextStep.id, 'configure_scheduler_env');
    assert(schedulerHandoff.payload.handoff.rows.some((row) => row.id === 'activate_provider_validation_schedules' && row.command.includes('run-scheduled')));
    assert(schedulerHandoff.payload.handoff.rows.some((row) => row.id === 'wire_alerting_runbook' && row.requiredEnv.includes('SIGNAL_OPERATIONS_RUNBOOK_URL')));
    assert(!JSON.stringify(schedulerHandoff.payload.handoff).includes(sessionSecret), 'scheduler handoff API must not serialize local session secrets');

    const emailHandoff = await requestApi('/api/email-handoff', { token: adminToken });
    assert.equal(emailHandoff.status, 200);
    assert.equal(emailHandoff.payload.ok, true);
    assert.equal(emailHandoff.payload.handoff.ok, true);
    assert.equal(emailHandoff.payload.handoff.productionReady, false);
    assert.equal(emailHandoff.payload.handoff.summary.secretSafe, true);
    assert.equal(emailHandoff.payload.handoff.nextStep.id, 'configure_gmail_env');
    assert(emailHandoff.payload.handoff.rows.some((row) => row.id === 'save_email_sandbox_evidence' && row.command.includes('validate-sandbox')));
    assert(emailHandoff.payload.handoff.rows.some((row) => row.id === 'replay_signed_delivery_webhooks' && row.requiredEnv.includes('SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET')));
    assert(emailHandoff.payload.handoff.runnableCommands.some((command) => command.includes('/api/email-handoff')));
    assert(!JSON.stringify(emailHandoff.payload.handoff).includes(sessionSecret), 'email handoff API must not serialize local session secrets');
    assert(!JSON.stringify(emailHandoff.payload.handoff).includes(emailWebhookSecret), 'email handoff API must not serialize email webhook secrets');

    const readiness = await requestApi('/api/readiness', { token: adminToken });
    assert.equal(readiness.status, 200);
    assert.equal(readiness.payload.ok, true);
    assert.equal(readiness.payload.readiness.productionReady, false);
    assert.equal(readiness.payload.readiness.summary.localReady, readiness.payload.readiness.summary.total);
    assert.equal(readiness.payload.readiness.summary.total, 10);
    assert(readiness.payload.readiness.requirements.every((requirement) => requirement.localOk), JSON.stringify(readiness.payload.readiness.requirements.filter((requirement) => !requirement.localOk)));
    assert(readiness.payload.readiness.requirements.some((requirement) => requirement.id === 'model_governance_and_tuning' && requirement.localOk === true));
    assert(readiness.payload.readiness.requirements.some((requirement) => requirement.id === 'provider_integrations' && requirement.status === 'needs_live_provider'));
    assert(readiness.payload.readiness.requirements.some((requirement) => requirement.id === 'production_backend_and_scheduler' && requirement.status === 'needs_production'));

    const completionAudit = await requestApi('/api/completion-audit', { token: adminToken });
    assert.equal(completionAudit.status, 200);
    assert.equal(completionAudit.payload.ok, true);
    assert.equal(completionAudit.payload.completion.ok, true);
    assert.equal(completionAudit.payload.completion.localComplete, true);
    assert.equal(completionAudit.payload.completion.productionReady, false);
    assert.equal(completionAudit.payload.completion.summary.localReady, completionAudit.payload.completion.summary.total);
    assert.equal(completionAudit.payload.completion.summary.secretSafe, true);
    assert.equal(completionAudit.payload.completion.nextLocal, null);
    assert.equal(completionAudit.payload.completion.nextProduction.id, 'workspace_registration_onboarding');
    assert.equal(completionAudit.payload.completion.rows.length, 8);
    assert(completionAudit.payload.completion.rows.every((row) => row.localOk), JSON.stringify(completionAudit.payload.completion.rows.filter((row) => !row.localOk)));
    assert.deepEqual(
      completionAudit.payload.completion.rows.map((row) => row.id).sort(),
      [
        'core_admin_area',
        'core_user_workspace',
        'email_flow_management',
        'local_admin_cli_agent',
        'payment_processing_architecture',
        'public_product_entry',
        'rbac_privacy_multi_member_org',
        'workspace_registration_onboarding',
      ],
    );
    assert(completionAudit.payload.completion.rows.some((row) => row.id === 'local_admin_cli_agent' && row.api === '/api/agent-handoff'));
    assert(completionAudit.payload.completion.rows.some((row) => row.id === 'payment_processing_architecture' && row.commands.some((command) => command.includes('payment-handoff'))));
    assert(!JSON.stringify(completionAudit.payload.completion).includes(sessionSecret), 'completion audit API must not serialize local session secrets');

    const agentHandoff = await requestApi('/api/agent-handoff', { token: adminToken });
    assert.equal(agentHandoff.status, 200);
    assert.equal(agentHandoff.payload.ok, true);
    assert.equal(agentHandoff.payload.handoff.ok, true);
    assert.equal(agentHandoff.payload.handoff.goLiveReady, false);
    assert.equal(agentHandoff.payload.handoff.summary.secretSafe, true);
    assert.equal(agentHandoff.payload.handoff.nextAction.id, 'production_backend');
    assert(agentHandoff.payload.handoff.nextAction.command.includes('backend'));
    assert(agentHandoff.payload.handoff.runnableCommands.some((command) => command.includes('production-plan')));
    assert(agentHandoff.payload.providerLaunch?.rows.some((row) => row.id === 'stripe'));
    assert(!JSON.stringify(agentHandoff.payload.handoff).includes(sessionSecret), 'agent handoff API must not serialize local session secrets');

    const onboardingReadiness = await requestApi('/api/onboarding-readiness', { token: adminToken });
    assert.equal(onboardingReadiness.status, 200);
    assert.equal(onboardingReadiness.payload.ok, true);
    assert.equal(onboardingReadiness.payload.onboarding.ok, true);
    assert.equal(onboardingReadiness.payload.onboarding.recommendation.decision, 'support_multi_member_orgs');
    assert.equal(onboardingReadiness.payload.onboarding.productionReady, false);
    assert(onboardingReadiness.payload.onboarding.rows.some((row) => row.area === 'rbac_controls' && row.localOk === true));
    assert(onboardingReadiness.payload.onboarding.rows.some((row) => row.area === 'focus_and_notifications' && row.localOk === true));
    assert.equal(onboardingReadiness.payload.onboarding.backend.mode, onboardingReadiness.payload.backend.mode);

    const tenantIsolation = await requestApi('/api/tenant-isolation', { token: adminToken });
    assert.equal(tenantIsolation.status, 200);
    assert.equal(tenantIsolation.payload.ok, true);
    assert.equal(tenantIsolation.payload.isolation.ok, true);
    assert.equal(tenantIsolation.payload.isolation.productionReady, false);
    assert(tenantIsolation.payload.isolation.rows.some((row) => row.area === 'actor_scoped_visibility' && row.localOk === true));
    assert(tenantIsolation.payload.isolation.rows.some((row) => row.area === 'production_rls_policy' && row.requiredEnv.includes('SIGNAL_TENANT_ISOLATION_MODE')));
    assert.equal(tenantIsolation.payload.isolation.backend.mode, tenantIsolation.payload.backend.mode);

    const dashboardAuditCli = await runCli(['dashboard-audit', '--json'], blankSandboxProviderEnv);
    assert.equal(dashboardAuditCli.ok, true);
    assert.equal(dashboardAuditCli.audit.ok, true);
    assert(dashboardAuditCli.audit.rows.some((row) => row.area === 'user_workspace' && row.scope === 'actor_visible' && row.summaryKey === 'openSignals'));
    assert(dashboardAuditCli.audit.rows.some((row) => row.area === 'admin_dashboard' && row.scope === 'global_total' && row.summaryKey === 'openInvoices'));
    assert.equal(dashboardAuditCli.audit.summary.failed, 0);
    assert.equal(dashboardAuditCli.audit.backend.mode, 'local-json');
    assert(!JSON.stringify(dashboardAuditCli.audit).includes(sessionSecret), 'dashboard audit must not serialize local session secrets');

    const dashboardAudit = await requestApi('/api/dashboard-audit', { token: adminToken });
    assert.equal(dashboardAudit.status, 200);
    assert.equal(dashboardAudit.payload.ok, true);
    assert.equal(dashboardAudit.payload.audit.ok, true);
    assert.equal(dashboardAudit.payload.audit.summary.failed, 0);
    assert(dashboardAudit.payload.audit.rows.every((row) => row.displayValue <= row.totalValue));
    assert.equal(dashboardAudit.payload.audit.backend.mode, dashboardAudit.payload.backend.mode);

    const operationsHealth = await requestApi('/api/operations-health', { token: adminToken });
    assert.equal(operationsHealth.status, 200);
    assert.equal(operationsHealth.payload.ok, true);
    assert.equal(operationsHealth.payload.operations.ok, true);
    assert(Number.isInteger(operationsHealth.payload.operations.summary.failedJobs));
    assert(operationsHealth.payload.operations.webhooks.some((row) => row.channel === 'gmail'));
    assert(operationsHealth.payload.operations.queues.some((row) => row.queue === 'email_sync'));
    assert(operationsHealth.payload.operations.lifecycle.categories.some((row) => row.category === 'payment'));
    assert.equal(operationsHealth.payload.operations.backend.mode, operationsHealth.payload.backend.mode);

    const productionDrill = await requestApi('/api/production-drill', { token: adminToken });
    assert.equal(productionDrill.status, 200);
    assert.equal(productionDrill.payload.ok, true);
    assert.equal(productionDrill.payload.drill.ok, true);
    assert.equal(productionDrill.payload.drill.productionReady, false);
    assert(productionDrill.payload.drill.rows.some((row) => row.area === 'state_service_health'));
    assert(productionDrill.payload.drill.rows.some((row) => row.area === 'live_provider_recurring_tests'));
    assert.equal(productionDrill.payload.drill.summary.total, 8);

    const productionEnv = await requestApi('/api/production-env', { token: adminToken });
    assert.equal(productionEnv.status, 200);
    assert.equal(productionEnv.payload.ok, true);
    assert.equal(productionEnv.payload.env.ok, true);
    assert.equal(productionEnv.payload.env.templateReady, true);
    assert.equal(productionEnv.payload.env.envReady, false);
    assert.equal(productionEnv.payload.env.summary.totalRows, 9);
    assert.equal(productionEnv.payload.env.summary.secretSafe, true);
    assert(productionEnv.payload.env.rows.some((row) => row.id === 'stripe' && row.requiredEnv.includes('STRIPE_WEBHOOK_SECRET')));
    assert(productionEnv.payload.env.rows.some((row) => row.id === 'production_plan_union' && row.templateMissing.length === 0));

    const productionPlan = await requestApi('/api/production-plan', { token: adminToken });
    assert.equal(productionPlan.status, 200);
    assert.equal(productionPlan.payload.ok, true);
    assert.equal(productionPlan.payload.plan.ok, true);
    assert.equal(productionPlan.payload.plan.productionReady, false);
    assert.equal(productionPlan.payload.plan.summary.total, 10);
    assert.equal(productionPlan.payload.plan.summary.secretSafe, true);
    assert(productionPlan.payload.plan.rows.some((row) => row.id === 'identity_tenant_isolation' && row.owner === 'security'));
    assert(productionPlan.payload.plan.rows.some((row) => row.id === 'email_launch' && row.commands.some((command) => command.includes('mailboxes watch'))));
    assert(productionPlan.payload.plan.rows.some((row) => row.id === 'launch_evidence_package' && row.commands.some((command) => command.includes('launch-gate package'))));

    const providerLaunch = await requestApi('/api/provider-launch', { token: adminToken });
    assert.equal(providerLaunch.status, 200);
    assert.equal(providerLaunch.payload.ok, true);
    assert.equal(providerLaunch.payload.launch.ok, true);
    assert.equal(providerLaunch.payload.launch.productionReady, false);
    assert(providerLaunch.payload.launch.rows.some((row) => row.id === 'stripe' && row.signedReplayCommand.includes('payments webhook-signed')));
    assert(providerLaunch.payload.launch.rows.some((row) => row.id === 'outbound-email' && row.webhookPath === '/api/webhooks/email'));
    assert.equal(providerLaunch.payload.launch.summary.secretSafe, true);

    const providerHandoff = await requestApi('/api/provider-handoff', { token: adminToken });
    assert.equal(providerHandoff.status, 200);
    assert.equal(providerHandoff.payload.ok, true);
    assert.equal(providerHandoff.payload.handoff.ok, true);
    assert.equal(providerHandoff.payload.handoff.productionReady, false);
    assert.equal(providerHandoff.payload.handoff.summary.secretSafe, true);
    assert(providerHandoff.payload.handoff.actions.some((row) => row.id.endsWith('_configuration')));
    assert(providerHandoff.payload.handoff.runnableCommands.some((command) => command.includes('validate-sandbox')));

    const emailHandoffReport = await requestApi('/api/email-handoff', { token: adminToken });
    assert.equal(emailHandoffReport.status, 200);
    assert.equal(emailHandoffReport.payload.ok, true);
    assert.equal(emailHandoffReport.payload.handoff.ok, true);
    assert.equal(emailHandoffReport.payload.handoff.productionReady, false);
    assert.equal(emailHandoffReport.payload.handoff.summary.secretSafe, true);
    assert.equal(emailHandoffReport.payload.handoff.nextStep.id, 'configure_gmail_env');
    assert(emailHandoffReport.payload.handoff.rows.some((row) => row.id === 'prove_watch_and_sync_launch' && row.command.includes('mailboxes watch')));
    assert(emailHandoffReport.payload.handoff.rows.some((row) => row.id === 'prove_outbound_digest_delivery' && row.command.includes('notifications digest')));

    const lifecyclePlaybook = await requestApi('/api/lifecycle-playbook', { token: adminToken });
    assert.equal(lifecyclePlaybook.status, 200);
    assert.equal(lifecyclePlaybook.payload.ok, true);
    assert.equal(lifecyclePlaybook.payload.playbook.ok, true);
    assert.equal(lifecyclePlaybook.payload.playbook.summary.secretSafe, true);
    assert(lifecyclePlaybook.payload.playbook.rows.some((row) => row.id === 'workspace_registration_invites' && row.commands.some((command) => command.includes('users invite'))));
    assert(lifecyclePlaybook.payload.playbook.rows.some((row) => row.id === 'failed_payment_recovery' && row.triggers.includes('payment_failed')));
    assert(lifecyclePlaybook.payload.playbook.rows.some((row) => row.id === 'outbound_email_delivery' && row.commands.some((command) => command.includes('notifications digest'))));

    const paymentLifecycle = await requestApi('/api/payment-lifecycle', { token: adminToken });
    assert.equal(paymentLifecycle.status, 200);
    assert.equal(paymentLifecycle.payload.ok, false);
    assert.equal(paymentLifecycle.payload.payment.ok, false);
    assert.equal(paymentLifecycle.payload.payment.productionReady, false);
    assert(paymentLifecycle.payload.payment.summary.localReady < paymentLifecycle.payload.payment.summary.total);
    assert(paymentLifecycle.payload.payment.rows.some((row) => row.area === 'checkout_portal_self_service' && row.localOk === false));
    assert(paymentLifecycle.payload.payment.rows.some((row) => row.area === 'signed_webhook_replay' && row.commands.some((command) => command.includes('webhook-signed'))));

    const paymentHandoff = await requestApi('/api/payment-handoff', { token: adminToken });
    assert.equal(paymentHandoff.status, 200);
    assert.equal(paymentHandoff.payload.ok, true);
    assert.equal(paymentHandoff.payload.handoff.ok, true);
    assert.equal(paymentHandoff.payload.handoff.productionReady, false);
    assert.equal(paymentHandoff.payload.handoff.summary.secretSafe, true);
    assert.equal(paymentHandoff.payload.handoff.nextStep.id, 'configure_stripe_env');
    assert(paymentHandoff.payload.handoff.rows.some((row) => row.id === 'save_stripe_sandbox_evidence' && row.command.includes('validate-sandbox')));
    assert(paymentHandoff.payload.handoff.rows.some((row) => row.id === 'prove_signed_webhook_replay' && row.command.includes('webhook-signed')));

    const digestionPipeline = await requestApi('/api/digestion-pipeline', { token: adminToken });
    assert.equal(digestionPipeline.status, 200);
    assert.equal(digestionPipeline.payload.ok, false);
    assert.equal(digestionPipeline.payload.pipeline.ok, false);
    assert.equal(digestionPipeline.payload.pipeline.productionReady, false);
    assert(digestionPipeline.payload.pipeline.summary.localReady < digestionPipeline.payload.pipeline.summary.total);
    assert(digestionPipeline.payload.pipeline.rows.some((row) => row.area === 'permissioned_source_ingestion' && row.localOk === false));
    assert(digestionPipeline.payload.pipeline.rows.some((row) => row.area === 'quality_suppression_feedback' && row.localOk === true));
    assert(digestionPipeline.payload.pipeline.rows.some((row) => row.area === 'model_learning_boundary' && row.requiredEnv.includes('SIGNAL_TENANT_ISOLATION_MODE')));

    const qaAnswers = await requestApi('/api/qa-answers', { token: adminToken });
    assert.equal(qaAnswers.status, 200);
    assert.equal(qaAnswers.payload.ok, true);
    assert.equal(qaAnswers.payload.qa.ok, true);
    assert.equal(qaAnswers.payload.qa.productionReady, false);
    assert.equal(qaAnswers.payload.qa.summary.secretSafe, true);
    assert(qaAnswers.payload.digestionPipeline?.rows.some((row) => row.area === 'detector_execution'));
    assert(qaAnswers.payload.qa.rows.some((row) => row.id === 'email_notification_admin_monitoring' && row.status === 'needs_live_provider'));
    assert(qaAnswers.payload.qa.rows.some((row) => row.id === 'workspace_registration_invitation' && row.commands.some((command) => command.includes('users invite'))));

    const launchGateCli = await runCli(['launch-gate', '--json'], blankSandboxProviderEnv);
    assert.equal(launchGateCli.ok, false);
    assert.equal(launchGateCli.launchGate.goLiveReady, false);
    assert(launchGateCli.launchGate.gates.some((gate) => gate.id === 'local_product_surface' && gate.status === 'pass'));
    assert(launchGateCli.launchGate.gates.some((gate) => gate.id === 'production_backend' && gate.status === 'blocked' && gate.requiredEnv.includes('DATABASE_URL')));
    assert(launchGateCli.launchGate.gates.some((gate) => gate.id === 'provider_sandbox_evidence' && gate.status === 'blocked'));
    assert(!JSON.stringify(launchGateCli.launchGate).includes(sessionSecret), 'launch gate must not serialize local session secrets');

    const launchGate = await requestApi('/api/launch-gate', { token: adminToken });
    assert.equal(launchGate.status, 200);
    assert.equal(launchGate.payload.ok, false);
    assert.equal(launchGate.payload.launchGate.goLiveReady, false);
    assert(launchGate.payload.launchGate.gates.some((gate) => gate.id === 'tenant_isolation' && gate.requiredEnv.includes('SIGNAL_TENANT_ISOLATION_MODE')));
    assert(launchGate.payload.launchGate.gates.some((gate) => gate.id === 'payment_launch' && gate.status === 'blocked'));

    const envFilePath = path.join(tempDir, 'signal-production-preflight.env');
    await fs.writeFile(envFilePath, [
      'SIGNAL_BACKEND_MODE=external-service',
      'SIGNAL_STATE_SERVICE_BACKEND=postgres',
      'SIGNAL_STATE_SERVICE_URL=https://state.signal.example/state',
      'SIGNAL_STATE_SERVICE_TOKEN=state_service_secret_value',
      'DATABASE_URL=postgres://signal:db_password@db.example/signal',
      'SIGNAL_REQUIRE_SIGNED_SESSION=true',
      'SIGNAL_SESSION_SECRET=super_secret_session_value_32chars!',
      'SIGNAL_COOKIE_SECURE=true',
      'SIGNAL_WEBHOOK_ACTOR=usr_system_webhook',
      'SIGNAL_OAUTH_ACTOR=usr_system_oauth',
      'SIGNAL_AUTH_PROVIDER=jwks',
      'SIGNAL_AUTH_JWKS_URL=https://idp.example/.well-known/jwks.json',
      'SIGNAL_API_CORS_ORIGINS=https://signal.example',
      'SIGNAL_JOB_SCHEDULER=signal-scheduler',
      'SIGNAL_PROVIDER_VALIDATION_SCHEDULER=signal-scheduler',
      'SIGNAL_TENANT_ISOLATION_MODE=rls',
      'SIGNAL_STATE_SERVICE_RLS=true',
      'SIGNAL_STATE_BACKUP_SCHEDULE=daily',
      'SIGNAL_STATE_BACKUP_RETENTION_DAYS=30',
      'SIGNAL_STATE_RESTORE_REHEARSAL_AT=2026-06-04T09:00:00.000Z',
      'SIGNAL_STATE_MIGRATION_ROLLOUT_PLAN=https://change.example/signal-state-migration',
      'SIGNAL_SCHEDULER_LOCK_POLICY=single-runner',
      'SIGNAL_OPERATIONS_RUNBOOK_URL=https://runbooks.example/signal-production',
      'SIGNAL_OPERATIONS_ALERT_CHANNEL=ops-oncall',
      'SIGNAL_GMAIL_CLIENT_ID=gmail-client-id',
      'SIGNAL_GMAIL_CLIENT_SECRET=gmail_client_secret_value',
      'SIGNAL_GMAIL_REDIRECT_URI=https://signal.example/api/oauth/gmail/callback',
      'SIGNAL_GMAIL_ACCESS_TOKEN=gmail_access_token_value',
      'SIGNAL_OUTLOOK_CLIENT_ID=outlook-client-id',
      'SIGNAL_OUTLOOK_CLIENT_SECRET=outlook_client_secret_value',
      'SIGNAL_OUTLOOK_TENANT_ID=common',
      'SIGNAL_OUTLOOK_REDIRECT_URI=https://signal.example/api/oauth/outlook/callback',
      'SIGNAL_OUTLOOK_ACCESS_TOKEN=outlook_access_token_value',
      'SIGNAL_TOKEN_ENCRYPTION_KEY=token_encryption_secret_value',
      'SIGNAL_EMAIL_PROVIDER_URL=https://api.sendgrid.com/v3/mail/send',
      'SIGNAL_EMAIL_PROVIDER_TOKEN=sendgrid_preflight_key',
      'SIGNAL_EMAIL_FROM=alerts@signal.example',
      'SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET=email_webhook_secret_value',
      'SIGNAL_SENDGRID_API_KEY=sendgrid_api_key_value',
      'SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY=sendgrid_public_key_value',
      'STRIPE_SECRET_KEY=sk_test_preflight_secret',
      'STRIPE_WEBHOOK_SECRET=whsec_preflight_secret',
      'SIGNAL_STRIPE_PRICE_TEAM=price_preflight_team',
      '',
    ].join('\n'), 'utf8');
    const launchGatePreflight = await runCli(['launch-gate', '--env-file', envFilePath, '--json'], blankSandboxProviderEnv);
    assert.equal(launchGatePreflight.envSource.type, 'env-file');
    assert.equal(launchGatePreflight.envSource.path, envFilePath);
    assert(launchGatePreflight.envSource.keys.includes('DATABASE_URL'));
    assert(launchGatePreflight.launchGate.gates.some((gate) => gate.id === 'production_backend' && gate.status === 'pass'));
    const incompleteBootEnvPath = path.join(tempDir, 'signal-production-boot-incomplete.env');
    await fs.writeFile(incompleteBootEnvPath, [
      'SIGNAL_BACKEND_MODE=external-service',
      'SIGNAL_STATE_SERVICE_BACKEND=postgres',
      'SIGNAL_STATE_SERVICE_URL=https://state.signal.example/state',
      'SIGNAL_STATE_SERVICE_TOKEN=state_service_secret_value',
      'DATABASE_URL=postgres://signal:db_password@db.example/signal',
      'SIGNAL_REQUIRE_SIGNED_SESSION=true',
      'SIGNAL_SESSION_SECRET=super_secret_session_value_32chars!',
      'SIGNAL_AUTH_PROVIDER=jwks',
      'SIGNAL_AUTH_JWKS_URL=https://idp.example/.well-known/jwks.json',
      'SIGNAL_API_CORS_ORIGINS=https://signal.example',
      'SIGNAL_JOB_SCHEDULER=signal-scheduler',
      'SIGNAL_PROVIDER_VALIDATION_SCHEDULER=signal-scheduler',
      'SIGNAL_TENANT_ISOLATION_MODE=rls',
      'SIGNAL_STATE_SERVICE_RLS=true',
      '',
    ].join('\n'), 'utf8');
    const launchGateIncompleteBoot = await runCli(['launch-gate', '--env-file', incompleteBootEnvPath, '--json'], blankSandboxProviderEnv);
    assert.equal(launchGateIncompleteBoot.launchGate.goLiveReady, false);
    assert(launchGateIncompleteBoot.launchGate.gates.some((gate) =>
      gate.id === 'production_backend' &&
      gate.status === 'blocked' &&
      gate.requiredEnv.includes('SIGNAL_COOKIE_SECURE') &&
      gate.requiredEnv.includes('SIGNAL_WEBHOOK_ACTOR') &&
      gate.requiredEnv.includes('SIGNAL_OAUTH_ACTOR')));
    assert(launchGatePreflight.launchGate.gates.some((gate) => gate.id === 'tenant_isolation' && gate.status === 'pass'));
    assert(launchGatePreflight.launchGate.gates.some((gate) => gate.id === 'provider_configuration' && gate.status === 'pass'));
    assert(launchGatePreflight.launchGate.gates.some((gate) => gate.id === 'provider_sandbox_evidence' && gate.status === 'blocked'));
    const launchGatePreflightJson = JSON.stringify(launchGatePreflight);
    assert(!launchGatePreflightJson.includes('db_password'), 'env-file preflight must not serialize database passwords');
    assert(!launchGatePreflightJson.includes('super_secret_session_value'), 'env-file preflight must not serialize session secrets');
    assert(!launchGatePreflightJson.includes('sk_test_preflight_secret'), 'env-file preflight must not serialize Stripe secret keys');
    assert(!launchGatePreflightJson.includes('sendgrid_preflight_key'), 'env-file preflight must not serialize email provider tokens');

    const backendHandoffPreflight = await runCli(['backend-handoff', '--env-file', envFilePath, '--json'], blankSandboxProviderEnv);
    assert.equal(backendHandoffPreflight.envSource.type, 'env-file');
    assert.equal(backendHandoffPreflight.handoff.ok, true);
    assert.equal(backendHandoffPreflight.handoff.productionReady, true);
    assert.equal(backendHandoffPreflight.handoff.summary.productionReady, true);
    assert.equal(backendHandoffPreflight.handoff.summary.secretSafe, true);
    assert.equal(backendHandoffPreflight.handoff.backend.readyChecks, backendHandoffPreflight.handoff.backend.totalChecks);
    assert.equal(backendHandoffPreflight.handoff.nextAction.id, 'backend_launch_evidence');
    assert(backendHandoffPreflight.handoff.nextAction.command.includes('launch-gate package'));
    const backendHandoffPreflightJson = JSON.stringify(backendHandoffPreflight);
    assert(!backendHandoffPreflightJson.includes('db_password'), 'backend handoff preflight must not serialize database passwords');
    assert(!backendHandoffPreflightJson.includes('super_secret_session_value'), 'backend handoff preflight must not serialize session secrets');
    assert(!backendHandoffPreflightJson.includes('sk_test_preflight_secret'), 'backend handoff preflight must not serialize Stripe secret keys');
    assert(!backendHandoffPreflightJson.includes('sendgrid_preflight_key'), 'backend handoff preflight must not serialize email provider tokens');
    const backendCutoverPreflight = await runCli(['backend-cutover', '--env-file', envFilePath, '--json'], blankSandboxProviderEnv);
    assert.equal(backendCutoverPreflight.envSource.type, 'env-file');
    assert.equal(backendCutoverPreflight.cutover.ok, true);
    assert.equal(backendCutoverPreflight.cutover.summary.secretSafe, true);
    assert.equal(backendCutoverPreflight.cutover.backend.readyChecks, backendCutoverPreflight.cutover.backend.totalChecks);
    assert(backendCutoverPreflight.cutover.rows.some((row) => row.id === 'start_external_state_service' && row.productionOk === true));
    assert(backendCutoverPreflight.cutover.rows.some((row) => row.id === 'api_external_mode_smoke' && row.command.includes('SIGNAL_BACKEND_MODE=external-service')));
    assert(backendCutoverPreflight.cutover.runnableCommands.some((command) => command.includes('backend-cutover --env-file')));
    const backendCutoverPreflightJson = JSON.stringify(backendCutoverPreflight);
    assert(!backendCutoverPreflightJson.includes('db_password'), 'backend cutover preflight must not serialize database passwords');
    assert(!backendCutoverPreflightJson.includes('super_secret_session_value'), 'backend cutover preflight must not serialize session secrets');
    assert(!backendCutoverPreflightJson.includes('sk_test_preflight_secret'), 'backend cutover preflight must not serialize Stripe secret keys');
    assert(!backendCutoverPreflightJson.includes('sendgrid_preflight_key'), 'backend cutover preflight must not serialize email provider tokens');

    const schedulerHandoffPreflight = await runCli(['scheduler-handoff', '--env-file', envFilePath, '--json'], blankSandboxProviderEnv);
    assert.equal(schedulerHandoffPreflight.envSource.type, 'env-file');
    assert.equal(schedulerHandoffPreflight.handoff.ok, true);
    assert.equal(schedulerHandoffPreflight.handoff.summary.secretSafe, true);
    assert(schedulerHandoffPreflight.handoff.rows.some((row) => row.id === 'configure_scheduler_env' && row.productionOk === true));
    assert(schedulerHandoffPreflight.handoff.rows.some((row) => row.id === 'configure_scheduler_env' && row.missingEnv.length === 0));
    assert(schedulerHandoffPreflight.handoff.rows.some((row) => row.id === 'wire_alerting_runbook' && row.missingEnv.length === 0));
    assert(schedulerHandoffPreflight.handoff.rows.some((row) => row.id === 'enable_continuous_scheduler' && row.command.includes('SIGNAL_JOB_SCHEDULER=signal-scheduler')));
    assert(schedulerHandoffPreflight.handoff.runnableCommands.some((command) => command.includes('scheduler-handoff --env-file')));
    const schedulerHandoffPreflightJson = JSON.stringify(schedulerHandoffPreflight);
    assert(!schedulerHandoffPreflightJson.includes('db_password'), 'scheduler handoff preflight must not serialize database passwords');
    assert(!schedulerHandoffPreflightJson.includes('super_secret_session_value'), 'scheduler handoff preflight must not serialize session secrets');
    assert(!schedulerHandoffPreflightJson.includes('sk_test_preflight_secret'), 'scheduler handoff preflight must not serialize Stripe secret keys');
    assert(!schedulerHandoffPreflightJson.includes('sendgrid_preflight_key'), 'scheduler handoff preflight must not serialize email provider tokens');

    const paymentHandoffPreflight = await runCli(['payment-handoff', '--env-file', envFilePath, '--json'], blankSandboxProviderEnv);
    assert.equal(paymentHandoffPreflight.envSource.type, 'env-file');
    assert.equal(paymentHandoffPreflight.handoff.ok, true);
    assert.equal(paymentHandoffPreflight.handoff.productionReady, false);
    assert.equal(paymentHandoffPreflight.handoff.summary.secretSafe, true);
    assert(paymentHandoffPreflight.handoff.rows.some((row) => row.id === 'configure_stripe_env' && row.productionOk === true && row.missingEnv.length === 0));
    assert(paymentHandoffPreflight.handoff.rows.some((row) => row.id === 'prove_signed_webhook_replay' && row.missingEnv.length === 0));
    assert(paymentHandoffPreflight.handoff.rows.some((row) => row.id === 'save_stripe_sandbox_evidence' && row.command.includes('validate-sandbox')));
    assert(paymentHandoffPreflight.handoff.runnableCommands.some((command) => command.includes('payment-handoff --env-file')));
    const paymentHandoffPreflightJson = JSON.stringify(paymentHandoffPreflight);
    assert(!paymentHandoffPreflightJson.includes('db_password'), 'payment handoff preflight must not serialize database passwords');
    assert(!paymentHandoffPreflightJson.includes('super_secret_session_value'), 'payment handoff preflight must not serialize session secrets');
    assert(!paymentHandoffPreflightJson.includes('sk_test_preflight_secret'), 'payment handoff preflight must not serialize Stripe secret keys');
    assert(!paymentHandoffPreflightJson.includes('sendgrid_preflight_key'), 'payment handoff preflight must not serialize email provider tokens');

    const agentHandoffPreflight = await runCli(['agent-handoff', '--env-file', envFilePath, '--json'], blankSandboxProviderEnv);
    assert.equal(agentHandoffPreflight.envSource.type, 'env-file');
    assert.equal(agentHandoffPreflight.handoff.ok, true);
    assert.equal(agentHandoffPreflight.handoff.nextAction.id, 'provider_sandbox_evidence');
    assert.equal(agentHandoffPreflight.handoff.summary.secretSafe, true);
    assert(agentHandoffPreflight.handoff.runnableCommands.some((command) => command.includes('validate-sandbox')));
    const agentHandoffPreflightJson = JSON.stringify(agentHandoffPreflight);
    assert(!agentHandoffPreflightJson.includes('db_password'), 'agent handoff preflight must not serialize database passwords');
    assert(!agentHandoffPreflightJson.includes('super_secret_session_value'), 'agent handoff preflight must not serialize session secrets');
    assert(!agentHandoffPreflightJson.includes('sk_test_preflight_secret'), 'agent handoff preflight must not serialize Stripe secret keys');
    assert(!agentHandoffPreflightJson.includes('sendgrid_preflight_key'), 'agent handoff preflight must not serialize email provider tokens');

    const productionDrillPreflight = await runCli(['production-drill', '--env-file', envFilePath, '--json'], blankSandboxProviderEnv);
    assert.equal(productionDrillPreflight.envSource.type, 'env-file');
    assert.equal(productionDrillPreflight.drill.productionReady, false);
    assert(productionDrillPreflight.drill.rows.some((row) => row.area === 'state_service_health' && row.productionOk === true));
    assert(productionDrillPreflight.drill.rows.some((row) => row.area === 'backup_restore_rehearsal' && row.productionOk === true));
    assert(productionDrillPreflight.drill.rows.some((row) => row.area === 'migration_rollout' && row.productionOk === true));
    assert(productionDrillPreflight.drill.rows.some((row) => row.area === 'alerting_runbook' && row.productionOk === true));
    const productionDrillPreflightJson = JSON.stringify(productionDrillPreflight);
    assert(!productionDrillPreflightJson.includes('db_password'), 'production drill preflight must not serialize database passwords');
    assert(!productionDrillPreflightJson.includes('super_secret_session_value'), 'production drill preflight must not serialize session secrets');
    assert(!productionDrillPreflightJson.includes('sk_test_preflight_secret'), 'production drill preflight must not serialize Stripe secret keys');

    const productionEnvPreflight = await runCli(['production-env', '--env-file', envFilePath, '--json'], blankSandboxProviderEnv);
    assert.equal(productionEnvPreflight.env.source.type, 'env-file');
    assert.equal(productionEnvPreflight.env.templateReady, true);
    assert.equal(productionEnvPreflight.env.summary.secretSafe, true);
    assert(productionEnvPreflight.env.summary.configuredRequired > cliProductionEnv.env.summary.configuredRequired);
    assert(productionEnvPreflight.env.rows.some((row) => row.id === 'backend_state_service' && row.configuredRequired.includes('DATABASE_URL')));
    assert(productionEnvPreflight.env.rows.some((row) => row.id === 'production_plan_union' && row.presentInSource.includes('SIGNAL_GMAIL_ACCESS_TOKEN')));
    const productionEnvPreflightJson = JSON.stringify(productionEnvPreflight);
    assert(!productionEnvPreflightJson.includes('db_password'), 'production env preflight must not serialize database passwords');
    assert(!productionEnvPreflightJson.includes('super_secret_session_value'), 'production env preflight must not serialize session secrets');
    assert(!productionEnvPreflightJson.includes('sk_test_preflight_secret'), 'production env preflight must not serialize Stripe secret keys');
    assert(!productionEnvPreflightJson.includes('sendgrid_preflight_key'), 'production env preflight must not serialize email provider tokens');

    const productionPlanPreflight = await runCli(['production-plan', '--env-file', envFilePath, '--json'], blankSandboxProviderEnv);
    assert.equal(productionPlanPreflight.envSource.type, 'env-file');
    assert.equal(productionPlanPreflight.plan.summary.total, 10);
    assert.equal(productionPlanPreflight.plan.summary.secretSafe, true);
    assert(productionPlanPreflight.plan.rows.some((row) => row.id === 'durable_backend_storage' && row.productionOk === true));
    assert(productionPlanPreflight.plan.rows.some((row) => row.id === 'provider_sandbox_evidence' && row.status === 'blocked'));
    const productionPlanPreflightJson = JSON.stringify(productionPlanPreflight);
    assert(!productionPlanPreflightJson.includes('db_password'), 'production plan preflight must not serialize database passwords');
    assert(!productionPlanPreflightJson.includes('super_secret_session_value'), 'production plan preflight must not serialize session secrets');
    assert(!productionPlanPreflightJson.includes('sk_test_preflight_secret'), 'production plan preflight must not serialize Stripe secret keys');
    assert(!productionPlanPreflightJson.includes('sendgrid_preflight_key'), 'production plan preflight must not serialize email provider tokens');

    const providerLaunchPreflight = await runCli(['provider-launch', '--env-file', envFilePath, '--json'], blankSandboxProviderEnv);
    assert.equal(providerLaunchPreflight.envSource.type, 'env-file');
    assert.equal(providerLaunchPreflight.launch.summary.configured, 5);
    assert.equal(providerLaunchPreflight.launch.productionReady, false);
    assert.equal(providerLaunchPreflight.launch.summary.secretSafe, true);
    assert(providerLaunchPreflight.launch.rows.some((row) => row.id === 'session' && row.configurationReady === true));
    assert(providerLaunchPreflight.launch.rows.some((row) => row.id === 'gmail' && row.status === 'needs_sandbox'));
    assert(providerLaunchPreflight.launch.rows.some((row) => row.id === 'stripe' && row.status === 'needs_sandbox'));
    const providerLaunchPreflightJson = JSON.stringify(providerLaunchPreflight);
    assert(!providerLaunchPreflightJson.includes('super_secret_session_value'), 'provider launch preflight must not serialize session secrets');
    assert(!providerLaunchPreflightJson.includes('sk_test_preflight_secret'), 'provider launch preflight must not serialize Stripe secret keys');
    assert(!providerLaunchPreflightJson.includes('sendgrid_preflight_key'), 'provider launch preflight must not serialize email provider tokens');
    const providerHandoffPreflight = await runCli(['provider-handoff', '--env-file', envFilePath, '--json'], blankSandboxProviderEnv);
    assert.equal(providerHandoffPreflight.envSource.type, 'env-file');
    assert.equal(providerHandoffPreflight.handoff.ok, true);
    assert.equal(providerHandoffPreflight.handoff.productionReady, false);
    assert.equal(providerHandoffPreflight.handoff.summary.configured, 5);
    assert.equal(providerHandoffPreflight.handoff.summary.secretSafe, true);
    assert.equal(providerHandoffPreflight.handoff.nextAction.id, 'gmail_sandbox');
    assert(providerHandoffPreflight.handoff.actions.some((row) => row.id === 'stripe_sandbox' && row.command.includes('validate-sandbox')));
    const providerHandoffPreflightJson = JSON.stringify(providerHandoffPreflight);
    assert(!providerHandoffPreflightJson.includes('super_secret_session_value'), 'provider handoff preflight must not serialize session secrets');
    assert(!providerHandoffPreflightJson.includes('sk_test_preflight_secret'), 'provider handoff preflight must not serialize Stripe secret keys');
    assert(!providerHandoffPreflightJson.includes('sendgrid_preflight_key'), 'provider handoff preflight must not serialize email provider tokens');

    const emailHandoffPreflight = await runCli(['email-handoff', '--env-file', envFilePath, '--json'], blankSandboxProviderEnv);
    assert.equal(emailHandoffPreflight.envSource.type, 'env-file');
    assert.equal(emailHandoffPreflight.handoff.ok, true);
    assert.equal(emailHandoffPreflight.handoff.productionReady, false);
    assert.equal(emailHandoffPreflight.handoff.summary.secretSafe, true);
    assert(emailHandoffPreflight.handoff.rows.some((row) => row.id === 'configure_gmail_env' && row.productionOk === true && row.missingEnv.length === 0));
    assert(emailHandoffPreflight.handoff.rows.some((row) => row.id === 'configure_outbound_email_env' && row.productionOk === true && row.missingEnv.length === 0));
    assert(emailHandoffPreflight.handoff.rows.some((row) => row.id === 'save_email_sandbox_evidence' && row.missingEnv.length === 0 && row.command.includes('validate-sandbox')));
    assert(emailHandoffPreflight.handoff.rows.some((row) => row.id === 'replay_signed_delivery_webhooks' && row.missingEnv.length === 0));
    assert(emailHandoffPreflight.handoff.runnableCommands.some((command) => command.includes('email-handoff --env-file')));
    const emailHandoffPreflightJson = JSON.stringify(emailHandoffPreflight);
    assert(!emailHandoffPreflightJson.includes('db_password'), 'email handoff preflight must not serialize database passwords');
    assert(!emailHandoffPreflightJson.includes('super_secret_session_value'), 'email handoff preflight must not serialize session secrets');
    assert(!emailHandoffPreflightJson.includes('sk_test_preflight_secret'), 'email handoff preflight must not serialize Stripe secret keys');
    assert(!emailHandoffPreflightJson.includes('sendgrid_preflight_key'), 'email handoff preflight must not serialize email provider tokens');
    assert(!emailHandoffPreflightJson.includes('email_webhook_secret_value'), 'email handoff preflight must not serialize email webhook secrets');
    assert(!emailHandoffPreflightJson.includes('gmail_access_token_value'), 'email handoff preflight must not serialize Gmail access tokens');
    assert(!emailHandoffPreflightJson.includes('outlook_access_token_value'), 'email handoff preflight must not serialize Outlook access tokens');
    assert(!emailHandoffPreflightJson.includes('sendgrid_api_key_value'), 'email handoff preflight must not serialize SendGrid API keys');
    assert(!emailHandoffPreflightJson.includes('sendgrid_public_key_value'), 'email handoff preflight must not serialize SendGrid webhook public-key values');

    await recordSchedulerHeartbeat({
      failed: 0,
      finishedAt: new Date().toISOString(),
      ok: true,
      queues: ['provider_validation', 'governance', 'email_sync'],
      ran: 0,
      recordedAt: new Date().toISOString(),
      statePath,
      workerId: 'contract-preflight-scheduler',
    }, { actorUserId: 'usr_admin', statePath });

    const launchPackagePath = path.join(tempDir, 'signal-launch-evidence.json');
    const launchPackageResult = await runCli(['launch-gate', 'package', launchPackagePath, '--env-file', envFilePath, '--json'], blankSandboxProviderEnv);
    assert.equal(launchPackageResult.ok, false);
    assert.match(launchPackageResult.artifactDigest, /^[a-f0-9]{24}$/);
    assert.equal(launchPackageResult.path, launchPackagePath);
    const launchPackage = JSON.parse(await fs.readFile(launchPackagePath, 'utf8'));
    assert.equal(launchPackage.artifactType, 'signal.launch_evidence_package');
    assert.equal(launchPackage.schemaVersion, 1);
    assert.equal(launchPackage.artifactDigest, launchPackageResult.artifactDigest);
    assert.equal(launchPackage.launchGate.summary.blocked, launchPackageResult.launchGate.summary.blocked);
    assert(launchPackage.commands.includes('npm run admin -- readiness --json'));
    assert(launchPackage.stateEvidence.providerValidationSchedules.length >= 4);
    assert.equal(launchPackage.privacy.environmentValues, 'omitted');
    const launchPackageJson = JSON.stringify(launchPackage);
    assert(!launchPackageJson.includes('db_password'), 'launch package must not serialize database passwords');
    assert(!launchPackageJson.includes('super_secret_session_value'), 'launch package must not serialize session secrets');
    assert(!launchPackageJson.includes('sk_test_preflight_secret'), 'launch package must not serialize Stripe secret keys');
    assert(!launchPackageJson.includes('sendgrid_preflight_key'), 'launch package must not serialize email provider tokens');
    await assert.rejects(
      runCli(['launch-gate', 'verify-package', launchPackagePath, '--json'], blankSandboxProviderEnv),
      /LAUNCH_PACKAGE_INVALID|freshness blockers present: sandbox_evidence_not_passed/,
    );

    const tamperedLaunchPackagePath = path.join(tempDir, 'signal-launch-evidence-tampered.json');
    await fs.writeFile(tamperedLaunchPackagePath, JSON.stringify({ ...launchPackage, generatedAt: '2026-01-01T00:00:00.000Z' }, null, 2), 'utf8');
    await assert.rejects(
      runCli(['launch-gate', 'verify-package', tamperedLaunchPackagePath, '--json'], blankSandboxProviderEnv),
      /LAUNCH_PACKAGE_INVALID|artifactDigest mismatch/,
    );

    const leakedLaunchPackagePath = path.join(tempDir, 'signal-launch-evidence-leaked.json');
    const leakedLaunchPackage = { ...launchPackage, leakedCredential: 'sk_test_leaked_secret_value' };
    const { artifactDigest: _oldLaunchDigest, ...leakedLaunchCore } = leakedLaunchPackage;
    leakedLaunchPackage.artifactDigest = crypto.createHash('sha256').update(JSON.stringify(leakedLaunchCore), 'utf8').digest('hex').slice(0, 24);
    await fs.writeFile(leakedLaunchPackagePath, JSON.stringify(leakedLaunchPackage, null, 2), 'utf8');
    await assert.rejects(
      runCli(['launch-gate', 'verify-package', leakedLaunchPackagePath, '--json'], blankSandboxProviderEnv),
      /LAUNCH_PACKAGE_INVALID|credential-looking values/,
    );

    const placeholderEnvFilePath = path.join(tempDir, 'signal-placeholder.env');
    await fs.writeFile(placeholderEnvFilePath, [
      'SIGNAL_BACKEND_MODE=external-service',
      'DATABASE_URL=postgres://signal:<password>@db.example/signal',
      'SIGNAL_STATE_SERVICE_URL=<state-service-url>',
      'SIGNAL_TENANT_ISOLATION_MODE=rls',
      '',
    ].join('\n'), 'utf8');
    const placeholderBackend = await runCli(['backend', '--env-file', placeholderEnvFilePath, '--json'], blankSandboxProviderEnv);
    assert.equal(placeholderBackend.envSource.type, 'env-file');
    assert(placeholderBackend.backend.summary.missingRequiredEnv.includes('DATABASE_URL or SIGNAL_STATE_SERVICE_DATABASE_URL'));
    const placeholderStateStorage = placeholderBackend.backend.checks.find((check) => check.id === 'state_service_storage');
    assert.equal(placeholderStateStorage.missingEnv.includes('DATABASE_URL'), false);
    assert(placeholderStateStorage.missingEnv.includes('DATABASE_URL or SIGNAL_STATE_SERVICE_DATABASE_URL'));
    assert(!JSON.stringify(placeholderBackend).includes('<password>'), 'placeholder env values must not be serialized');

    const sandbox = await requestApi('/api/integrations/sandbox', { token: adminToken });
    assert.equal(sandbox.status, 200);
    assert.equal(sandbox.payload.ok, false);
    assert.equal(sandbox.payload.sandbox.summary.blocked, 4);
    assert.equal(sandbox.payload.sandbox.providers.length, 4);
    assert.equal(sandbox.payload.providerValidationRuns.length, afterScheduledProviderValidationRunCount);
    assert(!JSON.stringify(sandbox.payload.sandbox).includes(sessionSecret), 'sandbox report should not expose local session secret');

    const recordedSandbox = await requestApi('/api/integrations/sandbox', {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(recordedSandbox.status, 200);
    assert.equal(recordedSandbox.payload.ok, false);
    assert.equal(recordedSandbox.payload.recorded.status, 'blocked');
    assert.match(recordedSandbox.payload.recorded.id, /^pvr_/);
    assert.equal(recordedSandbox.payload.summary.providerValidationRuns, afterScheduledProviderValidationRunCount + 1);
    assert.equal(recordedSandbox.payload.summary.providerValidationSchedules, 4);
    assert(recordedSandbox.payload.state.providerValidationSchedules.some((schedule) => schedule.providerId === 'stripe' && schedule.lastRunId === recordedSandbox.payload.recorded.id));
    assert(recordedSandbox.payload.state.providerValidationRuns.some((run) => run.id === recordedSandbox.payload.recorded.id));
    assert(!JSON.stringify(recordedSandbox.payload.state.providerValidationRuns).includes(sessionSecret), 'recorded sandbox evidence should not expose local session secret');

    const apiIssuedToken = await requestApi('/api/session/token', {
      body: { ttlSeconds: 900, userId: 'usr_product' },
      method: 'POST',
      token: adminToken,
    });
    assert.equal(apiIssuedToken.status, 200);
    assert.match(apiIssuedToken.payload.details.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const cookieHeader = apiIssuedToken.headers.get('set-cookie');
    assert.match(cookieHeader, /signal_session=/);
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /SameSite=Lax/);
    assert.match(cookieHeader, /Path=\//);
    assert.match(cookieHeader, /Max-Age=900/);

    const cookieSession = await requestApi('/api/session', {
      headers: { Cookie: `signal_session=${encodeURIComponent(apiIssuedToken.payload.details.token)}` },
    });
    assert.equal(cookieSession.status, 200);
    assert.equal(cookieSession.payload.actor.id, 'usr_product');
    assert.equal(cookieSession.payload.auth.mode, 'signed_session');
    assert.equal(cookieSession.payload.auth.transport, 'cookie');

    const revokedCookie = await mutate(adminToken, 'session.revoke', {
      sessionId: apiIssuedToken.payload.details.apiSessionId,
    });
    assert.equal(revokedCookie.status, 200);
    assert.equal(revokedCookie.payload.action, 'session.revoke');

    const cookieRejected = await requestApi('/api/session', {
      headers: { Cookie: `signal_session=${encodeURIComponent(apiIssuedToken.payload.details.token)}` },
    });
    assert.equal(cookieRejected.status, 401);
    assert.equal(cookieRejected.payload.code, 'SESSION_REVOKED');

    const stateFile = await fs.readFile(statePath, 'utf8');
    assert(!stateFile.includes(apiIssuedToken.payload.details.token), 'state file should not persist API-issued session tokens');
    assert(!stateFile.includes(revokedCliToken), 'state file should not persist CLI-issued session tokens');
  });

  await t.test('CLI mutations are reflected through the API state boundary', async () => {
    const invite = await runCli(['users', 'invite', 'tenant_demo', 'contract-cli@acme.example', 'member', 'sales', '--json'], {
      SIGNAL_ADMIN_ACTOR: 'usr_admin',
    });
    assert.equal(invite.ok, true);
    assert.equal(invite.action, 'users.invite');

    const claimableInvite = await runCli(['users', 'invite', 'tenant_demo', 'claim-api@acme.example', 'member', 'success', '--json'], {
      SIGNAL_ADMIN_ACTOR: 'usr_admin',
    });
    assert.equal(claimableInvite.action, 'users.invite');
    assert.ok(claimableInvite.details.claimCode, 'invite mutation should return claim code once in details');

    const stateBeforeClaim = await requestApi('/api/state', { token: adminToken });
    assert.equal(stateBeforeClaim.status, 200);
    assert(!JSON.stringify(stateBeforeClaim.payload.state).includes(claimableInvite.details.claimCode), 'pending invite claim code should not be exposed in API state');

    const claimWithoutAuth = await requestApi('/api/invites/claim', {
      body: {
        claimCode: claimableInvite.details.claimCode,
        email: 'claim-api@acme.example',
        name: 'Claim Api',
        team: 'success',
      },
      method: 'POST',
    });
    assert.equal(claimWithoutAuth.status, 200);
    assert.equal(claimWithoutAuth.payload.action, 'users.invite-claim');
    assert.equal(claimWithoutAuth.payload.actor.email, 'claim-api@acme.example');
    assert.equal(claimWithoutAuth.payload.summary.activeUserId, claimWithoutAuth.payload.details.userId);
    assert(!JSON.stringify(claimWithoutAuth.payload.state).includes(claimableInvite.details.claimCode), 'accepted invite claim code should not remain in pending invite state');

    const wrongClaim = await requestApi('/api/invites/claim', {
      body: {
        claimCode: claimableInvite.details.claimCode,
        email: 'wrong-claim@acme.example',
      },
      method: 'POST',
    });
    assert.equal(wrongClaim.status, 404);
    assert.equal(wrongClaim.payload.code, 'INVITE_CLAIM_INVALID');

    const cliClaimInvite = await runCli(['users', 'invite', 'tenant_demo', 'claim-cli@acme.example', 'member', 'success', '--json'], {
      SIGNAL_ADMIN_ACTOR: 'usr_admin',
    });
    const cliClaimed = await runCli(['users', 'claim', cliClaimInvite.details.claimCode, 'claim-cli@acme.example', 'Claim_Cli', 'success', '--json']);
    assert.equal(cliClaimed.ok, true);
    assert.equal(cliClaimed.action, 'users.invite-claim');
    assert.equal(cliClaimed.actor.email, 'claim-cli@acme.example');

    const publicRegistration = await requestApi('/api/registration', {
      body: {
        adminEmail: 'owner@self-api.example',
        adminName: 'Self Service Owner',
        domain: 'self-api.example',
        name: 'Self Service Lab',
        planId: 'plan_beta',
      },
      method: 'POST',
    });
    assert.equal(publicRegistration.status, 200);
    assert.equal(publicRegistration.payload.action, 'tenants.register');
    assert.equal(publicRegistration.payload.actor.email, 'owner@self-api.example');
    assert.equal(publicRegistration.payload.details.registrationMode, 'self_service');
    assert.equal(publicRegistration.payload.summary.activeUserId, publicRegistration.payload.details.adminUserId);
    assert(publicRegistration.payload.state.tenants.some((item) => item.id === publicRegistration.payload.details.tenantId && item.registrationMode === 'self_service'));
    assert(publicRegistration.payload.state.memberships.some((item) => item.tenantId === publicRegistration.payload.details.tenantId && item.userId === publicRegistration.payload.details.adminUserId && item.role === 'admin' && item.status === 'active'));
    assert(publicRegistration.payload.state.auditEvents.some((item) => item.action === 'tenants.register' && item.actor === publicRegistration.payload.details.adminUserId));

    const cliRegistered = await runCli(['tenants', 'register', 'Cli_Self_Service_Lab', 'cli-self.example', 'owner@cli-self.example', 'Cli_Self_Owner', 'plan_beta', '--json']);
    assert.equal(cliRegistered.ok, true);
    assert.equal(cliRegistered.action, 'tenants.register');
    assert.equal(cliRegistered.actor.email, 'owner@cli-self.example');
    assert.equal(cliRegistered.details.registrationMode, 'self_service');

    const workspace = await runCli(['tenants', 'create', 'Contract_Lab', 'contract.example', 'owner@contract.example', 'Owner_Name', 'plan_beta', '--json'], {
      SIGNAL_ADMIN_ACTOR: 'usr_admin',
    });
    assert.equal(workspace.ok, true);
    assert.equal(workspace.action, 'tenants.create');
    assert.equal(workspace.details.registrationMode, 'admin_created');
    assert.match(workspace.details.tenantId, /^tenant_contract/);

    const crossTenantCompletion = await mutate(adminToken, 'tenants.onboarding-complete', {
      tenantId: workspace.details.tenantId,
    });
    assert.equal(crossTenantCompletion.status, 403);
    assert.equal(crossTenantCompletion.payload.code, 'FORBIDDEN');

    const incompleteCompletion = await execFileAsync(process.execPath, [path.join(rootDir, 'scripts', 'signal-admin.mjs'), 'tenants', 'complete-onboarding', workspace.details.tenantId, '--json'], {
      cwd: rootDir,
      env: { ...cliEnv, SIGNAL_ADMIN_ACTOR: workspace.details.adminUserId },
      maxBuffer: 10 * 1024 * 1024,
    }).then(
      () => ({ status: 0, payload: null }),
      (error) => ({ status: error.code, payload: JSON.parse(error.stderr) }),
    );
    assert.equal(incompleteCompletion.status, 1);
    assert.equal(incompleteCompletion.payload.code, 'ONBOARDING_INCOMPLETE');
    assert(incompleteCompletion.payload.missing.includes('mailbox_source'));

    const ownerMailboxSession = await runCli(['mailboxes', 'connect-url', workspace.details.tenantId, 'gmail', workspace.details.adminUserId, '--json'], {
      SIGNAL_ADMIN_ACTOR: workspace.details.adminUserId,
    });
    assert.equal(ownerMailboxSession.action, 'mailboxes.connect-url');
    const ownerMailbox = await runCli(['mailboxes', 'complete', ownerMailboxSession.details.sessionId, '--json'], {
      SIGNAL_ADMIN_ACTOR: workspace.details.adminUserId,
    });
    assert.equal(ownerMailbox.action, 'mailboxes.complete');
    const completedOnboarding = await runCli(['tenants', 'complete-onboarding', workspace.details.tenantId, '--json'], {
      SIGNAL_ADMIN_ACTOR: workspace.details.adminUserId,
    });
    assert.equal(completedOnboarding.ok, true);
    assert.equal(completedOnboarding.action, 'tenants.onboarding-complete');
    assert.equal(completedOnboarding.details.registrationStatus, 'active');
    assert(completedOnboarding.details.requirements.every((requirement) => requirement.ok));

    const state = await requestApi('/api/state', { token: adminToken });
    assert.equal(state.status, 200);
    assert(state.payload.state.invites.some((item) => item.email === 'contract-cli@acme.example' && item.status === 'pending'));
    assert(state.payload.state.invites.some((item) => item.email === 'claim-api@acme.example' && item.status === 'accepted'));
    assert(state.payload.state.memberships.some((item) => item.userId === claimWithoutAuth.payload.details.userId && item.inviteId === claimableInvite.details.inviteId && item.status === 'active'));
    assert(state.payload.state.auditEvents.some((item) => item.action === 'users.invite-claim' && item.actor === claimWithoutAuth.payload.details.userId));
    assert(state.payload.state.tenants.some((item) => item.id === publicRegistration.payload.details.tenantId && item.registrationMode === 'self_service'));
    assert(state.payload.state.tenants.some((item) => item.id === cliRegistered.details.tenantId && item.registrationMode === 'self_service'));
    assert(state.payload.state.tenants.some((item) => item.id === workspace.details.tenantId && item.billingOwnerUserId === workspace.details.adminUserId));
    assert(state.payload.state.tenants.some((item) => item.id === workspace.details.tenantId && item.registrationStatus === 'active' && item.onboardingCompletedByUserId === workspace.details.adminUserId));
    assert(state.payload.state.memberships.some((item) => item.tenantId === workspace.details.tenantId && item.userId === workspace.details.adminUserId && item.role === 'admin' && item.status === 'active'));
    assert(state.payload.state.notificationEvents.some((item) => item.userId === workspace.details.adminUserId && item.type === 'onboarding.workspace_created'));
    assert(state.payload.state.notificationEvents.some((item) => item.userId === workspace.details.adminUserId && item.type === 'onboarding.workspace_completed'));
    assert(state.payload.state.accountRecommendations.some((item) => item.status === 'open' && item.strategy && item.rationale));
  });

  await t.test('role gates reject member-only admin mutations', async () => {
    const bootstrapForbidden = await requestApi('/api/bootstrap', {
      body: { force: false },
      method: 'POST',
      token: memberToken,
    });
    assert.equal(bootstrapForbidden.status, 403);
    assert.equal(bootstrapForbidden.payload.code, 'FORBIDDEN');

    const sandboxForbidden = await requestApi('/api/integrations/sandbox', {
      token: memberToken,
    });
    assert.equal(sandboxForbidden.status, 403);
    assert.equal(sandboxForbidden.payload.code, 'FORBIDDEN');

    const sandboxRecordForbidden = await requestApi('/api/integrations/sandbox', {
      method: 'POST',
      token: memberToken,
    });
    assert.equal(sandboxRecordForbidden.status, 403);
    assert.equal(sandboxRecordForbidden.payload.code, 'FORBIDDEN');

    const scheduleForbidden = await mutate(memberToken, 'integrations.schedule', {
      providerId: 'stripe',
      status: 'paused',
    });
    assert.equal(scheduleForbidden.status, 403);
    assert.equal(scheduleForbidden.payload.code, 'FORBIDDEN');

    const scheduledForbidden = await requestApi('/api/integrations/scheduled', {
      body: { force: true },
      method: 'POST',
      token: memberToken,
    });
    assert.equal(scheduledForbidden.status, 403);
    assert.equal(scheduledForbidden.payload.code, 'FORBIDDEN');

    const backendForbidden = await requestApi('/api/backend', {
      token: memberToken,
    });
    assert.equal(backendForbidden.status, 403);
    assert.equal(backendForbidden.payload.code, 'FORBIDDEN');
    const backendHandoffForbidden = await requestApi('/api/backend-handoff', {
      token: memberToken,
    });
    assert.equal(backendHandoffForbidden.status, 403);
    assert.equal(backendHandoffForbidden.payload.code, 'FORBIDDEN');

    const backendCutoverForbidden = await requestApi('/api/backend-cutover', {
      token: memberToken,
    });
    assert.equal(backendCutoverForbidden.status, 403);
    assert.equal(backendCutoverForbidden.payload.code, 'FORBIDDEN');

    const schedulerHandoffForbidden = await requestApi('/api/scheduler-handoff', {
      token: memberToken,
    });
    assert.equal(schedulerHandoffForbidden.status, 403);
    assert.equal(schedulerHandoffForbidden.payload.code, 'FORBIDDEN');

    const readinessForbidden = await requestApi('/api/readiness', {
      token: memberToken,
    });
    assert.equal(readinessForbidden.status, 403);
    assert.equal(readinessForbidden.payload.code, 'FORBIDDEN');

    const completionAuditForbidden = await requestApi('/api/completion-audit', {
      token: memberToken,
    });
    assert.equal(completionAuditForbidden.status, 403);
    assert.equal(completionAuditForbidden.payload.code, 'FORBIDDEN');

    const agentHandoffForbidden = await requestApi('/api/agent-handoff', {
      token: memberToken,
    });
    assert.equal(agentHandoffForbidden.status, 403);
    assert.equal(agentHandoffForbidden.payload.code, 'FORBIDDEN');

    const onboardingReadinessForbidden = await requestApi('/api/onboarding-readiness', {
      token: memberToken,
    });
    assert.equal(onboardingReadinessForbidden.status, 403);
    assert.equal(onboardingReadinessForbidden.payload.code, 'FORBIDDEN');

    const tenantIsolationForbidden = await requestApi('/api/tenant-isolation', {
      token: memberToken,
    });
    assert.equal(tenantIsolationForbidden.status, 403);
    assert.equal(tenantIsolationForbidden.payload.code, 'FORBIDDEN');

    const dashboardAuditForbidden = await requestApi('/api/dashboard-audit', {
      token: memberToken,
    });
    assert.equal(dashboardAuditForbidden.status, 403);
    assert.equal(dashboardAuditForbidden.payload.code, 'FORBIDDEN');

    const operationsHealthForbidden = await requestApi('/api/operations-health', {
      token: memberToken,
    });
    assert.equal(operationsHealthForbidden.status, 403);
    assert.equal(operationsHealthForbidden.payload.code, 'FORBIDDEN');

    const productionDrillForbidden = await requestApi('/api/production-drill', {
      token: memberToken,
    });
    assert.equal(productionDrillForbidden.status, 403);
    assert.equal(productionDrillForbidden.payload.code, 'FORBIDDEN');

    const productionEnvForbidden = await requestApi('/api/production-env', {
      token: memberToken,
    });
    assert.equal(productionEnvForbidden.status, 403);
    assert.equal(productionEnvForbidden.payload.code, 'FORBIDDEN');

    const productionPlanForbidden = await requestApi('/api/production-plan', {
      token: memberToken,
    });
    assert.equal(productionPlanForbidden.status, 403);
    assert.equal(productionPlanForbidden.payload.code, 'FORBIDDEN');

    const providerLaunchForbidden = await requestApi('/api/provider-launch', {
      token: memberToken,
    });
    assert.equal(providerLaunchForbidden.status, 403);
    assert.equal(providerLaunchForbidden.payload.code, 'FORBIDDEN');

    const providerHandoffForbidden = await requestApi('/api/provider-handoff', {
      token: memberToken,
    });
    assert.equal(providerHandoffForbidden.status, 403);
    assert.equal(providerHandoffForbidden.payload.code, 'FORBIDDEN');

    const emailHandoffForbidden = await requestApi('/api/email-handoff', {
      token: memberToken,
    });
    assert.equal(emailHandoffForbidden.status, 403);
    assert.equal(emailHandoffForbidden.payload.code, 'FORBIDDEN');

    const lifecyclePlaybookForbidden = await requestApi('/api/lifecycle-playbook', {
      token: memberToken,
    });
    assert.equal(lifecyclePlaybookForbidden.status, 403);
    assert.equal(lifecyclePlaybookForbidden.payload.code, 'FORBIDDEN');

    const paymentLifecycleForbidden = await requestApi('/api/payment-lifecycle', {
      token: memberToken,
    });
    assert.equal(paymentLifecycleForbidden.status, 403);
    assert.equal(paymentLifecycleForbidden.payload.code, 'FORBIDDEN');

    const paymentHandoffForbidden = await requestApi('/api/payment-handoff', {
      token: memberToken,
    });
    assert.equal(paymentHandoffForbidden.status, 403);
    assert.equal(paymentHandoffForbidden.payload.code, 'FORBIDDEN');

    const digestionPipelineForbidden = await requestApi('/api/digestion-pipeline', {
      token: memberToken,
    });
    assert.equal(digestionPipelineForbidden.status, 403);
    assert.equal(digestionPipelineForbidden.payload.code, 'FORBIDDEN');

    const qaAnswersForbidden = await requestApi('/api/qa-answers', {
      token: memberToken,
    });
    assert.equal(qaAnswersForbidden.status, 403);
    assert.equal(qaAnswersForbidden.payload.code, 'FORBIDDEN');

    const launchGateForbidden = await requestApi('/api/launch-gate', {
      token: memberToken,
    });
    assert.equal(launchGateForbidden.status, 403);
    assert.equal(launchGateForbidden.payload.code, 'FORBIDDEN');

    const modelPolicyForbidden = await mutate(memberToken, 'models.policy', {
      learningMode: 'opt_in_tuning',
      tenantId: 'tenant_demo',
    });
    assert.equal(modelPolicyForbidden.status, 403);
    assert.equal(modelPolicyForbidden.payload.code, 'FORBIDDEN');

    const forbidden = await mutate(memberToken, 'users.invite', {
      email: 'blocked-member@acme.example',
      role: 'member',
      team: 'sales',
      tenantId: 'tenant_demo',
    });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.payload.code, 'FORBIDDEN');

    const tenantForbidden = await mutate(memberToken, 'tenants.status', {
      reason: 'member should not control tenant state',
      status: 'suspended',
      tenantId: 'tenant_demo',
    });
    assert.equal(tenantForbidden.status, 403);
    assert.equal(tenantForbidden.payload.code, 'FORBIDDEN');

    const createTenantForbidden = await mutate(memberToken, 'tenants.create', {
      adminEmail: 'owner@blocked.example',
      domain: 'blocked.example',
      name: 'Blocked Workspace',
      planId: 'plan_beta',
    });
    assert.equal(createTenantForbidden.status, 403);
    assert.equal(createTenantForbidden.payload.code, 'FORBIDDEN');

    const portalForbidden = await mutate(memberToken, 'payments.portal', {
      tenantId: 'tenant_demo',
    });
    assert.equal(portalForbidden.status, 403);
    assert.equal(portalForbidden.payload.code, 'FORBIDDEN');

    const overrideForbidden = await mutate(memberToken, 'payments.override', {
      amountCents: 2500,
      reason: 'member should not create credits',
      tenantId: 'tenant_demo',
      type: 'support_credit',
    });
    assert.equal(overrideForbidden.status, 403);
    assert.equal(overrideForbidden.payload.code, 'FORBIDDEN');

    const syncForbidden = await mutate(memberToken, 'payments.sync', {
      tenantId: 'tenant_demo',
    });
    assert.equal(syncForbidden.status, 403);
    assert.equal(syncForbidden.payload.code, 'FORBIDDEN');

    const routeForbidden = await mutate(memberToken, 'email-flows.route', {
      flowId: 'flow_buying_intent',
      ownerUserId: 'usr_admin',
      routeTo: 'founder',
    });
    assert.equal(routeForbidden.status, 403);
    assert.equal(routeForbidden.payload.code, 'FORBIDDEN');

    const accountReviewForbidden = await mutate(memberToken, 'accounts.review', {
      account: 'Acme Health',
      note: 'member should not review admin account',
    });
    assert.equal(accountReviewForbidden.status, 403);
    assert.equal(accountReviewForbidden.payload.code, 'FORBIDDEN');
  });

  await t.test('mailbox owners can manage their own source through signed API mutations', async () => {
    const nonOwnerPause = await mutate(memberToken, 'mailboxes.pause', {
      mailboxId: 'mbx_gmail_sales',
    });
    assert.equal(nonOwnerPause.status, 403);
    assert.equal(nonOwnerPause.payload.code, 'FORBIDDEN');

    const connect = await mutate(memberToken, 'mailboxes.connect-url', {
      ownerUserId: 'usr_product',
      provider: 'gmail',
      tenantId: 'tenant_demo',
    });
    assert.equal(connect.status, 200);
    assert.equal(connect.payload.action, 'mailboxes.connect-url');
    assert.match(connect.payload.details.localCallbackUrl, /^http:\/\/127\.0\.0\.1:8787\/api\/oauth\/gmail\/callback/);

    const completed = await mutate(memberToken, 'mailboxes.complete', {
      sessionId: connect.payload.details.sessionId,
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.payload.action, 'mailboxes.complete');

    const mailboxId = completed.payload.details.mailboxId;
    const paused = await mutate(memberToken, 'mailboxes.pause', { mailboxId });
    assert.equal(paused.status, 200);
    assert.equal(paused.payload.details.nextStatus, 'paused');

    const resumed = await mutate(memberToken, 'mailboxes.resume', { mailboxId });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.payload.details.nextStatus, 'connected');

    const synced = await mutate(memberToken, 'mailboxes.sync', { mailboxId });
    assert.equal(synced.status, 200);
    assert.equal(synced.payload.action, 'mailboxes.sync');

    const disconnected = await mutate(memberToken, 'mailboxes.disconnect', { mailboxId });
    assert.equal(disconnected.status, 200);
    assert.equal(disconnected.payload.action, 'mailboxes.disconnect');
    const state = await requestApi('/api/state', { token: adminToken });
    assert(state.payload.state.lifecycleNotices.some((notice) => notice.sourceIds?.mailboxId === mailboxId && notice.trigger === 'mailbox_disconnected' && notice.status === 'open'));
  });

  await t.test('tenant suspension gates member product mutations and is reversible', async () => {
    const renamedDomain = await mutate(adminToken, 'tenants.domain', {
      domain: 'https://Contract.Acme.Example/path',
      tenantId: 'tenant_demo',
    });
    assert.equal(renamedDomain.status, 200);
    assert.equal(renamedDomain.payload.details.nextDomain, 'contract.acme.example');

    const suspended = await mutate(adminToken, 'tenants.status', {
      reason: 'Contract review',
      status: 'suspended',
      tenantId: 'tenant_demo',
    });
    assert.equal(suspended.status, 200);
    assert.equal(suspended.payload.details.nextStatus, 'suspended');
    assert.equal(suspended.payload.summary.tenantStatus, 'suspended');

    const suspendedState = await requestApi('/api/state', { token: adminToken });
    assert.equal(suspendedState.payload.state.tenants[0].status, 'suspended');
    assert.equal(suspendedState.payload.state.tenants[0].suspensionReason, 'Contract review');

    const memberBlocked = await mutate(memberToken, 'accounts.action-status', {
      actionId: 'act_ventureworks_export_discovery',
      status: 'done',
    });
    assert.equal(memberBlocked.status, 423);
    assert.equal(memberBlocked.payload.code, 'TENANT_SUSPENDED');

    const restoredDomain = await mutate(adminToken, 'tenants.domain', {
      domain: 'acme.example',
      tenantId: 'tenant_demo',
    });
    assert.equal(restoredDomain.status, 200);
    assert.equal(restoredDomain.payload.details.nextDomain, 'acme.example');

    const reactivated = await mutate(adminToken, 'tenants.status', {
      status: 'active',
      tenantId: 'tenant_demo',
    });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.payload.details.nextStatus, 'active');
    assert.equal(reactivated.payload.summary.tenantStatus, 'active');
  });

  await t.test('billing override ledger records and revokes entitlement overrides', async () => {
    const supportCredit = await mutate(adminToken, 'payments.override', {
      amountCents: 2500,
      reason: 'Contract credit',
      tenantId: 'tenant_demo',
      type: 'support_credit',
    });
    assert.equal(supportCredit.status, 200);
    assert.equal(supportCredit.payload.details.amountCents, 2500);
    assert.match(supportCredit.payload.details.overrideId, /^bo_/);

    const manualAccess = await mutate(adminToken, 'payments.override', {
      planId: 'plan_beta',
      reason: 'Contract access',
      tenantId: 'tenant_demo',
      type: 'manual_entitlement',
    });
    assert.equal(manualAccess.status, 200);
    assert.equal(manualAccess.payload.details.planId, 'plan_beta');
    assert.equal(manualAccess.payload.summary.activeBillingOverrides, 2);

    const overrideState = await requestApi('/api/state', { token: adminToken });
    const entitlement = overrideState.payload.state.entitlements.find((item) => item.tenantId === 'tenant_demo');
    assert.equal(entitlement.source, 'override');
    assert.equal(entitlement.overrideId, manualAccess.payload.details.overrideId);
    assert.equal(entitlement.seatLimit, 5);
    assert(overrideState.payload.state.paymentEvents.some((event) => event.billingOverrideId === manualAccess.payload.details.overrideId && event.type === 'billing.override.manual_entitlement.created'));

    const paymentsList = await runCli(['payments', '--json']);
    assert(paymentsList.billingOverrides.some((override) => override.id === supportCredit.payload.details.overrideId && override.status === 'active'));

    const revokedManual = await mutate(adminToken, 'payments.override-revoke', {
      overrideId: manualAccess.payload.details.overrideId,
      reason: 'Contract resolved',
    });
    assert.equal(revokedManual.status, 200);
    assert.equal(revokedManual.payload.details.status, 'revoked');

    const revokedCredit = await mutate(adminToken, 'payments.override-revoke', {
      overrideId: supportCredit.payload.details.overrideId,
      reason: 'Credit settled',
    });
    assert.equal(revokedCredit.status, 200);

    const restoredState = await requestApi('/api/state', { token: adminToken });
    const restoredEntitlement = restoredState.payload.state.entitlements.find((item) => item.tenantId === 'tenant_demo');
    assert.equal(restoredEntitlement.source, 'subscription');
    assert.equal(restoredEntitlement.seatLimit, 10);
    assert.equal(restoredState.payload.summary.activeBillingOverrides, 0);

    const expiredAccess = await mutate(adminToken, 'payments.override', {
      expiresAt: '2020-01-01T00:00:00.000Z',
      planId: 'plan_beta',
      reason: 'Expired contract access',
      tenantId: 'tenant_demo',
      type: 'manual_entitlement',
    });
    assert.equal(expiredAccess.status, 200);

    const expiredState = await requestApi('/api/state', { token: adminToken });
    const expiredOverrideSubscription = expiredState.payload.state.subscriptions.find((item) => item.billingOverrideId === expiredAccess.payload.details.overrideId);
    assert.equal(expiredOverrideSubscription.status, 'active');

    const paymentSync = await mutate(adminToken, 'payments.sync', {
      tenantId: 'tenant_demo',
    });
    assert.equal(paymentSync.status, 200);
    assert.equal(paymentSync.payload.action, 'payments.sync');
    assert(paymentSync.payload.details.expiredOverrideIds.includes(expiredAccess.payload.details.overrideId));
    assert(paymentSync.payload.details.canceledSubscriptionIds.includes(expiredOverrideSubscription.id));

    const syncedState = await requestApi('/api/state', { token: adminToken });
    const syncedEntitlement = syncedState.payload.state.entitlements.find((item) => item.tenantId === 'tenant_demo');
    assert.equal(syncedEntitlement.source, 'subscription');
    assert.equal(syncedEntitlement.seatLimit, 10);
    assert.equal(syncedState.payload.state.subscriptions.find((item) => item.id === expiredOverrideSubscription.id).status, 'canceled');
    assert(syncedState.payload.state.paymentEvents.some((event) => event.type === 'billing.sync.completed' && event.tenantId === 'tenant_demo'));

    const returnCheckout = await mutate(adminToken, 'payments.checkout', {
      planId: 'plan_team',
      tenantId: 'tenant_demo',
    });
    assert.equal(returnCheckout.status, 200);
    const billingReturn = await fetch(`${apiBaseUrl}/api/billing/return?session_id=${encodeURIComponent(returnCheckout.payload.details.sessionId)}&result=success`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      redirect: 'manual',
    });
    assert.equal(billingReturn.status, 303);
    assert.match(billingReturn.headers.get('location'), /^http:\/\/127\.0\.0\.1:5173\/#workspace\?billing=success/);

    const returnedState = await requestApi('/api/state', { token: adminToken });
    const returnedSession = returnedState.payload.state.billingSessions.find((item) => item.id === returnCheckout.payload.details.sessionId);
    assert.equal(returnedSession.status, 'returned');
    assert.equal(returnedSession.returnResult, 'success');
    const firstReturnEvent = returnedState.payload.state.paymentEvents.find((event) => event.type === 'billing.return.success' && event.sessionId === returnedSession.id);
    const firstReturnJob = returnedState.payload.state.jobs.find((job) => job.type === 'payment.return.success' && job.targetId === returnedSession.id && job.status === 'succeeded');
    assert(firstReturnEvent, 'billing return should record a payment event');
    assert(firstReturnJob, 'billing return should record a billing job');
    assert.equal(firstReturnEvent.providerEventId, `billing.return.${returnedSession.id}.success`);
    assert.equal(firstReturnJob.providerIdempotencyKey, `billing.return.${returnedSession.id}.success`);

    const billingReturnReplay = await fetch(`${apiBaseUrl}/api/billing/return?session_id=${encodeURIComponent(returnCheckout.payload.details.sessionId)}&result=success`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      redirect: 'manual',
    });
    assert.equal(billingReturnReplay.status, 303);
    const replayedState = await requestApi('/api/state', { token: adminToken });
    const replayedReturnEvents = replayedState.payload.state.paymentEvents.filter((event) => event.type === 'billing.return.success' && event.sessionId === returnedSession.id);
    const replayedReturnJobs = replayedState.payload.state.jobs.filter((job) => job.type === 'payment.return.success' && job.targetId === returnedSession.id && job.status === 'succeeded');
    assert.equal(replayedReturnEvents.length, 1, 'billing return replay should not append duplicate payment events');
    assert.equal(replayedReturnJobs.length, 1, 'billing return replay should not append duplicate billing jobs');

    const cliSync = await runCli(['payments', 'sync', 'tenant_demo', '--json'], { SIGNAL_ADMIN_ACTOR: 'usr_admin' });
    assert.equal(cliSync.action, 'payments.sync');
    assert(cliSync.details.expiredOverrideIds.includes(expiredAccess.payload.details.overrideId));
  });

  await t.test('account review snapshots are available through API and CLI timeline', async () => {
    const review = await mutate(memberToken, 'accounts.review', {
      account: 'VentureWorks',
      note: 'Contract product review',
    });
    assert.equal(review.status, 200);
    assert.equal(review.payload.action, 'accounts.review');
    assert.equal(review.payload.actor.id, 'usr_product');
    assert.match(review.payload.details.reviewId, /^ar_/);

    const state = await requestApi('/api/state', { token: adminToken });
    assert(state.payload.state.accountReviews.some((item) => item.id === review.payload.details.reviewId && item.note === 'Contract product review'));
    assert(state.payload.state.accountEvents.some((event) => event.reviewId === review.payload.details.reviewId && event.type === 'account_review'));
    assert.equal(state.payload.summary.accountReviews, 1);

    const timeline = await runCli(['accounts', 'timeline', 'VentureWorks', '--json']);
    assert.equal(timeline.ok, true);
    assert(timeline.reviews.some((item) => item.id === review.payload.details.reviewId));
    assert(timeline.events.some((event) => event.reviewId === review.payload.details.reviewId));
    assert(timeline.recommendations.some((item) => item.kind === 'product_discovery' && item.strategy));
  });

  await t.test('email-flow transitions reject disabled flow execution', async () => {
    const disabled = await mutate(adminToken, 'email-flows.disable', { flowId: 'flow_product_ideas' });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.payload.details.nextStatus, 'disabled');

    const rejectedRun = await mutate(adminToken, 'email-flows.run', {
      flowId: 'flow_product_ideas',
      mailboxId: 'mbx_gmail_sales',
    });
    assert.equal(rejectedRun.status, 409);
    assert.equal(rejectedRun.payload.code, 'FLOW_DISABLED');

    const enabled = await mutate(adminToken, 'email-flows.enable', { flowId: 'flow_product_ideas' });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.payload.details.nextStatus, 'enabled');

    const routed = await mutate(adminToken, 'email-flows.route', {
      flowId: 'flow_product_ideas',
      note: 'Contract CRM follow-up',
      ownerUserId: 'usr_sales',
      routeTo: 'crm',
    });
    assert.equal(routed.status, 200);
    assert.equal(routed.payload.action, 'email-flows.route');
    assert.equal(routed.payload.details.nextRouteTo, 'crm');
    assert.equal(routed.payload.details.nextOwnerUserId, 'usr_sales');

    const run = await mutate(adminToken, 'email-flows.run', {
      flowId: 'flow_product_ideas',
      mailboxId: 'mbx_gmail_sales',
    });
    assert.equal(run.status, 200);
    assert.equal(run.payload.action, 'email-flows.run');
    assert.deepEqual(run.payload.details.routeTargets, ['crm']);

    const routedState = await requestApi('/api/state', { token: adminToken });
    const routedSignal = routedState.payload.state.signals.find((signal) => signal.sourceMessageId === 'msg_ventureworks_export_001' && signal.flowId === 'flow_product_ideas');
    assert.equal(routedSignal.ownerUserId, 'usr_sales');
    assert.equal(routedSignal.routeTo, 'crm');
    assert.equal(routedSignal.routingRuleId, routed.payload.details.routingRuleId);
    assert(routedState.payload.state.routingRules.some((rule) => rule.id === routed.payload.details.routingRuleId && rule.routeTo === 'crm'));

    const flowList = await runCli(['email-flows', '--json']);
    assert(flowList.routingRules.some((rule) => rule.id === routed.payload.details.routingRuleId && rule.ownerUserId === 'usr_sales'));

    const exercisedPipeline = await requestApi('/api/digestion-pipeline', { token: adminToken });
    assert.equal(exercisedPipeline.status, 200);
    assert(exercisedPipeline.payload.pipeline.rows.some((row) => row.area === 'detector_execution' && row.localOk === true));
    assert(exercisedPipeline.payload.pipeline.rows.some((row) => row.area === 'routing_and_user_outcomes' && row.localOk === true));
    assert(exercisedPipeline.payload.pipeline.summary.generatedSignals > 0);
  });

  await t.test('signal CRM handoff is available through API and CLI with owner gates', async () => {
    const nonOwnerHandoff = await mutate(memberToken, 'signals.handoff', {
      signalId: 'sig_expansion_001',
      target: 'task',
    });
    assert.equal(nonOwnerHandoff.status, 403);
    assert.equal(nonOwnerHandoff.payload.code, 'FORBIDDEN');

    const handoff = await mutate(memberToken, 'signals.handoff', {
      signalId: 'sig_product_001',
      target: 'crm',
      note: 'Contract CRM handoff',
    });
    assert.equal(handoff.status, 200);
    assert.equal(handoff.payload.action, 'signals.handoff');
    assert.equal(handoff.payload.details.status, 'queued');
    assert.equal(handoff.payload.details.target, 'crm');

    const ranHandoffJob = await mutate(adminToken, 'jobs.run', {
      limit: 1,
      queue: 'signal_handoff',
    });
    assert.equal(ranHandoffJob.status, 200);
    assert.equal(ranHandoffJob.payload.action, 'jobs.run');
    assert.equal(ranHandoffJob.payload.details.succeeded, 1);
    assert.equal(ranHandoffJob.payload.details.outcomes[0].handoffId, handoff.payload.details.handoffId);
    assert.equal(ranHandoffJob.payload.details.outcomes[0].handoffStatus, 'sent');

    const taskHandoff = await mutate(memberToken, 'signals.handoff', {
      signalId: 'sig_product_001',
      target: 'task',
      note: 'Contract task handoff',
    });
    assert.equal(taskHandoff.status, 200);
    assert.equal(taskHandoff.payload.details.status, 'queued');

    const sent = await mutate(memberToken, 'signals.handoff-status', {
      handoffId: handoff.payload.details.handoffId,
      note: 'Sent from contract status test',
      providerRef: 'crm_contract_manual',
      status: 'sent',
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.payload.action, 'signals.handoff-status');
    assert.equal(sent.payload.details.nextStatus, 'sent');

    const sentTask = await mutate(memberToken, 'signals.handoff-status', {
      handoffId: taskHandoff.payload.details.handoffId,
      note: 'Sent task from contract test',
      providerRef: 'task_contract_manual',
      status: 'sent',
    });
    assert.equal(sentTask.status, 200);

    const signalList = await runCli(['signals', '--json']);
    assert(signalList.signalHandoffs.some((item) => item.id === handoff.payload.details.handoffId && item.status === 'sent' && item.providerRef === 'crm_contract_manual' && item.providerRequestDigest));
    assert(signalList.signalHandoffs.some((item) => item.id === taskHandoff.payload.details.handoffId && item.status === 'sent' && item.providerRef === 'task_contract_manual'));
    assert(signalList.signals.some((signal) => signal.id === 'sig_product_001' && signal.latestHandoffStatus === 'sent'));
  });

  await t.test('subscription gates restrict member product actions when billing is past due', async () => {
    const memberAllowed = await mutate(memberToken, 'signals.status', {
      signalId: 'sig_product_001',
      status: 'open',
    });
    assert.equal(memberAllowed.status, 200);
    assert.equal(memberAllowed.payload.actor.id, 'usr_product');

    const failedPayment = await mutate(adminToken, 'payments.webhook', {
      subscriptionId: 'sub_demo',
      type: 'invoice.payment_failed',
    });
    assert.equal(failedPayment.status, 200);
    assert.equal(failedPayment.payload.details.status, 'past_due');
    assert(failedPayment.payload.state.lifecycleNotices.some((notice) => notice.trigger === 'payment_failed' && notice.status === 'open'));
    assert.equal(failedPayment.payload.summary.openLifecycleNotices, failedPayment.payload.state.lifecycleNotices.filter((notice) => notice.status === 'open').length);

    const memberBlocked = await mutate(memberToken, 'signals.status', {
      signalId: 'sig_product_001',
      status: 'routed',
    });
    assert.equal(memberBlocked.status, 402);
    assert.equal(memberBlocked.payload.code, 'PAYMENT_REQUIRED');

    const paidPayment = await mutate(adminToken, 'payments.webhook', {
      subscriptionId: 'sub_demo',
      type: 'invoice.paid',
    });
    assert.equal(paidPayment.status, 200);
    assert.equal(paidPayment.payload.details.status, 'active');
  });

  await t.test('payment webhooks reject negative amountDueCents', async () => {
    const negative = await mutate(adminToken, 'payments.webhook', {
      amountDueCents: -100,
      subscriptionId: 'sub_demo',
      type: 'invoice.paid',
    });
    assert.equal(negative.status, 400);
    assert.equal(negative.payload.code, 'ARG_INVALID');
  });

  await t.test('local worker mutation is available without consuming demo queues', async () => {
    const run = await mutate(adminToken, 'jobs.run', {
      limit: 1,
      queue: 'contract_noop_queue',
    });
    assert.equal(run.status, 200);
    assert.equal(run.payload.action, 'jobs.run');
    assert.equal(run.payload.details.count, 0);
    const providerValidationRun = await mutate(adminToken, 'jobs.run', {
      limit: 1,
      queue: 'provider_validation',
    });
    assert.equal(providerValidationRun.status, 200);
    assert.equal(providerValidationRun.payload.action, 'jobs.run');
    assert.equal(providerValidationRun.payload.details.count, 0);
  });

  await t.test('signed Stripe webhook reconciles provider identifiers through the API', async () => {
    async function postSignedStripeEvent(event) {
      const body = JSON.stringify(event);
      const response = await fetch(`${apiBaseUrl}/api/webhooks/stripe`, {
        body,
        headers: {
          'Content-Type': 'application/json',
          'Stripe-Signature': signStripeWebhookPayload(body, stripeWebhookSecret),
          'X-Signal-Actor': 'usr_admin',
        },
        method: 'POST',
      });
      return {
        body,
        payload: await parseJsonResponse(response),
        response,
      };
    }

    const checkoutBody = JSON.stringify({
      id: 'evt_contract_stripe_checkout',
      type: 'checkout.session.completed',
      livemode: false,
      data: {
        object: {
          id: 'cs_contract_checkout',
          object: 'checkout.session',
          customer: 'cus_contract_signal',
          subscription: 'sub_stripe_contract_signal',
          metadata: {
            planId: 'plan_team',
            tenantId: 'tenant_demo',
          },
        },
      },
    });
    const checkoutResponse = await fetch(`${apiBaseUrl}/api/webhooks/stripe`, {
      body: checkoutBody,
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': signStripeWebhookPayload(checkoutBody, stripeWebhookSecret),
        'X-Signal-Actor': 'usr_admin',
      },
      method: 'POST',
    });
    const checkoutPayload = await parseJsonResponse(checkoutResponse);
    assert.equal(checkoutResponse.status, 200);
    assert.equal(checkoutPayload.action, 'payments.webhook');
    assert.equal(checkoutPayload.details.providerCustomerId, 'cus_contract_signal');
    assert.equal(checkoutPayload.details.providerSubscriptionId, 'sub_stripe_contract_signal');

    const invoiceBody = JSON.stringify({
      id: 'evt_contract_stripe_failed',
      type: 'invoice.payment_failed',
      livemode: false,
      data: {
        object: {
          id: 'in_contract_failed',
          object: 'invoice',
          amount_due: 4900,
          customer: 'cus_contract_signal',
          hosted_invoice_url: 'https://invoice.stripe.com/i/in_contract_failed',
          subscription: 'sub_stripe_contract_signal',
        },
      },
    });
    const invoiceResponse = await fetch(`${apiBaseUrl}/api/webhooks/stripe`, {
      body: invoiceBody,
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': signStripeWebhookPayload(invoiceBody, stripeWebhookSecret),
        'X-Signal-Actor': 'usr_admin',
      },
      method: 'POST',
    });
    const invoicePayload = await parseJsonResponse(invoiceResponse);
    assert.equal(invoiceResponse.status, 200);
    assert.equal(invoicePayload.details.status, 'past_due');
    assert.equal(invoicePayload.details.providerInvoiceId, 'in_contract_failed');
    assert.equal(invoicePayload.details.providerSubscriptionId, 'sub_stripe_contract_signal');

    const pausedEvent = await postSignedStripeEvent({
      id: 'evt_contract_stripe_subscription_paused',
      type: 'customer.subscription.paused',
      livemode: false,
      data: {
        object: {
          id: 'sub_stripe_contract_signal',
          object: 'subscription',
          customer: 'cus_contract_signal',
          status: 'paused',
          metadata: {
            planId: 'plan_team',
            tenantId: 'tenant_demo',
          },
        },
      },
    });
    assert.equal(pausedEvent.response.status, 200);
    assert.equal(pausedEvent.payload.details.status, 'past_due');
    assert.equal(pausedEvent.payload.details.providerEventType, 'customer.subscription.paused');

    const replayCreatedEvent = await postSignedStripeEvent({
      id: 'evt_contract_stripe_subscription_created_replay',
      type: 'customer.subscription.created',
      livemode: false,
      data: {
        object: {
          id: 'sub_stripe_contract_replay',
          object: 'subscription',
          customer: 'cus_contract_replay',
          status: 'active',
          metadata: {
            planId: 'plan_team',
            tenantId: 'tenant_demo',
          },
        },
      },
    });
    assert.equal(replayCreatedEvent.response.status, 200);
    assert.equal(replayCreatedEvent.payload.details.providerSubscriptionId, 'sub_stripe_contract_replay');

    const deletedEvent = await postSignedStripeEvent({
      id: 'evt_contract_stripe_subscription_deleted_replay',
      type: 'customer.subscription.deleted',
      livemode: false,
      data: {
        object: {
          id: 'sub_stripe_contract_replay',
          object: 'subscription',
          customer: 'cus_contract_replay',
          status: 'canceled',
          metadata: {
            planId: 'plan_team',
            tenantId: 'tenant_demo',
          },
        },
      },
    });
    assert.equal(deletedEvent.response.status, 200);
    assert.equal(deletedEvent.payload.details.status, 'canceled');

    const resumedEvent = await postSignedStripeEvent({
      id: 'evt_contract_stripe_subscription_resumed',
      type: 'customer.subscription.resumed',
      livemode: false,
      data: {
        object: {
          id: 'sub_stripe_contract_signal',
          object: 'subscription',
          customer: 'cus_contract_signal',
          status: 'active',
          current_period_end: 1780872600,
          metadata: {
            planId: 'plan_team',
            tenantId: 'tenant_demo',
          },
        },
      },
    });
    assert.equal(resumedEvent.response.status, 200);
    assert.equal(resumedEvent.payload.details.status, 'active');

    const state = await requestApi('/api/state', { token: adminToken });
    const subscription = state.payload.state.subscriptions.find((item) => item.id === 'sub_demo');
    assert.equal(subscription.provider, 'stripe');
    assert.equal(subscription.providerCustomerId, 'cus_contract_signal');
    assert.equal(subscription.providerSubscriptionId, 'sub_stripe_contract_signal');
    assert.equal(subscription.providerStatus, 'active');
    assert.equal(subscription.currentPeriodEndAt, '2026-06-07T22:50:00.000Z');
    assert(state.payload.state.subscriptions.some((item) => item.providerSubscriptionId === 'sub_stripe_contract_replay' && item.status === 'canceled'), 'subscription.created/deleted replay should be visible in state');
    assert.equal(state.payload.state.entitlements.find((item) => item.tenantId === 'tenant_demo')?.status, 'active');
    const invoice = state.payload.state.invoices.find((item) => item.providerInvoiceId === 'in_contract_failed');
    assert.equal(invoice.providerCustomerId, 'cus_contract_signal');
    assert.equal(invoice.providerSubscriptionId, 'sub_stripe_contract_signal');

    const recovery = await mutate(adminToken, 'payments.recover', {
      invoiceId: invoice.id,
    });
    assert.equal(recovery.status, 200);
    assert.equal(recovery.payload.action, 'payments.recover');

    const paidEvent = await postSignedStripeEvent({
      id: 'evt_contract_stripe_paid',
      type: 'invoice.paid',
      livemode: false,
      data: {
        object: {
          id: 'in_contract_failed',
          object: 'invoice',
          amount_paid: 4900,
          customer: 'cus_contract_signal',
          subscription: 'sub_stripe_contract_signal',
        },
      },
    });
    assert.equal(paidEvent.response.status, 200);
    assert.equal(paidEvent.payload.details.status, 'active');

    const portal = await mutate(adminToken, 'payments.portal', {
      tenantId: 'tenant_demo',
    });
    assert.equal(portal.status, 200);
    assert.equal(portal.payload.action, 'payments.portal');

    const unknownEvent = await postSignedStripeEvent({
      id: 'evt_contract_stripe_unknown_ignored',
      type: 'payment_intent.processing',
      livemode: false,
      data: {
        object: {
          id: 'pi_contract_processing',
          object: 'payment_intent',
          customer: 'cus_contract_signal',
          metadata: {
            tenantId: 'tenant_demo',
          },
          status: 'processing',
        },
      },
    });
    assert.equal(unknownEvent.response.status, 200);
    assert.equal(unknownEvent.payload.details.status, 'ignored');
    assert.equal(unknownEvent.payload.details.jobId, null);

    const trialEvent = await postSignedStripeEvent({
      id: 'evt_contract_stripe_trial_will_end',
      type: 'customer.subscription.trial_will_end',
      livemode: false,
      data: {
        object: {
          id: 'sub_stripe_contract_signal',
          object: 'subscription',
          customer: 'cus_contract_signal',
          status: 'trialing',
          trial_end: 1781131800,
          metadata: {
            planId: 'plan_team',
            tenantId: 'tenant_demo',
          },
        },
      },
    });
    assert.equal(trialEvent.response.status, 200);

    const seedProviderPrice = await mutate(adminToken, 'payments.webhook', {
      planId: 'plan_team',
      provider: 'stripe',
      providerPriceId: 'price_contract_team',
      providerSubscriptionId: 'sub_stripe_contract_signal',
      status: 'active',
      subscriptionId: 'sub_stripe_contract_signal',
      tenantId: 'tenant_demo',
      type: 'subscription.updated',
    });
    assert.equal(seedProviderPrice.status, 200);

    const planChangedEvent = await postSignedStripeEvent({
      id: 'evt_contract_stripe_plan_changed',
      type: 'customer.subscription.updated',
      livemode: false,
      data: {
        object: {
          id: 'sub_stripe_contract_signal',
          object: 'subscription',
          customer: 'cus_contract_signal',
          status: 'active',
          items: {
            data: [
              {
                price: {
                  id: 'price_contract_team_v2',
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
    assert.equal(planChangedEvent.response.status, 200);

    for (const [matrixSubscriptionId, invoiceEventType, expectedStatus] of [
      ['sub_contract_draft_matrix', 'invoice.created', 'draft'],
      ['sub_contract_open_matrix', 'invoice.finalized', 'open'],
      ['sub_contract_past_due_matrix', 'invoice.payment_failed', 'past_due'],
      ['sub_contract_paid_matrix', 'invoice.paid', 'paid'],
      ['sub_contract_uncollectible_matrix', 'invoice.marked_uncollectible', 'uncollectible'],
      ['sub_contract_void_matrix', 'invoice.voided', 'void'],
    ]) {
      const matrixSubscription = await mutate(adminToken, 'payments.webhook', {
        planId: 'plan_team',
        status: 'active',
        subscriptionId: matrixSubscriptionId,
        tenantId: 'tenant_demo',
        type: 'subscription.updated',
      });
      assert.equal(matrixSubscription.status, 200);
      const matrixInvoice = await postSignedStripeEvent({
        id: `evt_contract_stripe_${expectedStatus}_matrix`,
        type: invoiceEventType,
        livemode: false,
        data: {
          object: {
            id: `in_contract_${expectedStatus}_matrix`,
            object: 'invoice',
            amount_due: 4900,
            customer: 'cus_contract_signal',
            hosted_invoice_url: `https://invoice.stripe.com/i/in_contract_${expectedStatus}_matrix`,
            status: expectedStatus === 'void' ? 'void' : expectedStatus,
            subscription: matrixSubscriptionId,
          },
        },
      });
      assert.equal(matrixInvoice.response.status, 200);
    }

    const matrixState = await requestApi('/api/state', { token: adminToken });
    const openInvoice = matrixState.payload.state.invoices.find((item) => item.providerInvoiceId === 'in_contract_open_matrix');
    assert(openInvoice, 'contract matrix should create an open invoice');
    const refund = await mutate(adminToken, 'payments.refund', {
      amountCents: 1200,
      invoiceId: invoice.id,
      reason: 'Contract refund',
    });
    assert.equal(refund.status, 200);
    const supportCredit = await mutate(adminToken, 'payments.override', {
      amountCents: 1000,
      reason: 'Contract credit',
      tenantId: 'tenant_demo',
      type: 'support_credit',
    });
    assert.equal(supportCredit.status, 200);
    assert(supportCredit.payload.details.creditedInvoiceId, 'support credit should apply to an open or past-due invoice when one exists');

    const creditNote = await postSignedStripeEvent({
      id: 'evt_contract_stripe_credit_note',
      type: 'credit_note.created',
      livemode: false,
      data: {
        object: {
          id: 'cn_contract_credit',
          object: 'credit_note',
          amount: 500,
          invoice: 'in_contract_open_matrix',
          customer: 'cus_contract_signal',
        },
      },
    });
    assert.equal(creditNote.response.status, 200);
    assert.equal(creditNote.payload.details.invoiceId, openInvoice.id);

    const paritySync = await mutate(adminToken, 'payments.sync', {
      tenantId: 'tenant_demo',
    });
    assert.equal(paritySync.status, 200);

    const readyPaymentLifecycle = await requestApi('/api/payment-lifecycle', { token: adminToken });
    assert.equal(readyPaymentLifecycle.status, 200);
    assert.equal(
      readyPaymentLifecycle.payload.payment.ok,
      true,
      JSON.stringify(readyPaymentLifecycle.payload.payment.rows.filter((row) => !row.localOk)),
    );
    assert.equal(readyPaymentLifecycle.payload.payment.summary.localReady, readyPaymentLifecycle.payload.payment.summary.total);
    assert.equal(readyPaymentLifecycle.payload.payment.productionReady, false);
    assert(readyPaymentLifecycle.payload.payment.rows.some((row) => row.area === 'failed_payment_recovery' && row.localOk === true));
    assert(readyPaymentLifecycle.payload.payment.rows.some((row) => row.area === 'signed_webhook_replay' && row.localOk === true));
    assert(readyPaymentLifecycle.payload.payment.rows.some((row) => row.area === 'ignored_webhook_resilience' && row.localOk === true));
    assert(readyPaymentLifecycle.payload.payment.rows.some((row) => row.area === 'invoice_status_matrix' && row.localOk === true));
    assert(readyPaymentLifecycle.payload.payment.rows.some((row) => row.area === 'refund_credit_reconciliation' && row.localOk === true));
    assert(readyPaymentLifecycle.payload.payment.rows.some((row) => row.area === 'plan_change_trial_end' && row.localOk === true));
  });

  await t.test('signed email delivery webhook and unsubscribe callback reconcile provider state', async () => {
    const digest = await mutate(adminToken, 'notifications.digest-run', { tenantId: 'tenant_demo' });
    assert.equal(digest.status, 200);
    const deliveryMessageId = digest.payload.details.deliveryMessageIds[0];
    assert(deliveryMessageId, 'digest run should create an outbound delivery record');

    const rawBody = JSON.stringify({
      id: 'evt_contract_email_bounce',
      messageId: deliveryMessageId,
      provider: 'contract_mail',
      reason: 'Contract test bounce',
      status: 'bounced',
    });
    const signature = signEmailWebhookPayload(rawBody, emailWebhookSecret);
    const webhookResponse = await fetch(`${apiBaseUrl}/api/webhooks/email`, {
      body: rawBody,
      headers: {
        'Content-Type': 'application/json',
        'Signal-Email-Signature': signature,
      },
      method: 'POST',
    });
    const webhookPayload = await parseJsonResponse(webhookResponse);
    assert.equal(webhookResponse.status, 200);
    assert.equal(webhookPayload.action, 'notifications.delivery-webhook');
    assert.equal(webhookPayload.details.nextStatus, 'bounced');

    const bouncedState = await requestApi('/api/state', { token: adminToken });
    const bouncedMessage = bouncedState.payload.state.emailDeliveryMessages.find((message) => message.id === deliveryMessageId);
    assert.equal(bouncedMessage.status, 'bounced');
    assert.equal(bouncedMessage.providerEventId, 'evt_contract_email_bounce');

    const sendGridBody = JSON.stringify([
      {
        event: 'delivered',
        sg_event_id: 'sg_contract_delivered',
        sg_message_id: 'sg_contract_message',
        signal_message_id: deliveryMessageId,
        signal_unsubscribe_code: bouncedMessage.unsubscribeCode,
      },
      {
        event: 'open',
        sg_event_id: 'sg_contract_open',
        sg_message_id: 'sg_contract_message',
        signal_message_id: deliveryMessageId,
      },
    ]);
    const sendGridSigned = signSendGridWebhookPayload(sendGridBody, sendGridPrivateKey);
    const sendGridResponse = await fetch(`${apiBaseUrl}/api/webhooks/email`, {
      body: sendGridBody,
      headers: {
        'Content-Type': 'application/json',
        'X-Twilio-Email-Event-Webhook-Signature': sendGridSigned.signatureHeader,
        'X-Twilio-Email-Event-Webhook-Timestamp': sendGridSigned.timestampHeader,
      },
      method: 'POST',
    });
    const sendGridPayload = await parseJsonResponse(sendGridResponse);
    assert.equal(sendGridResponse.status, 200);
    assert.equal(sendGridPayload.action, 'notifications.delivery-webhook');
    assert.equal(sendGridPayload.details.count, 2);

    const sendGridState = await requestApi('/api/state', { token: adminToken });
    const sendGridMessage = sendGridState.payload.state.emailDeliveryMessages.find((message) => message.id === deliveryMessageId);
    assert.equal(sendGridMessage.provider, 'sendgrid');
    assert.equal(sendGridMessage.providerMessageId, 'sg_contract_message');
    assert.equal(sendGridMessage.providerStatus, 'open');

    const unsubscribe = await requestApi(`/api/email/unsubscribe/${encodeURIComponent(bouncedMessage.unsubscribeCode)}`);
    assert.equal(unsubscribe.status, 200);
    assert.equal(unsubscribe.payload.action, 'notifications.unsubscribe');
  });
});

test('bootstrap --force requires --yes and backs up existing state', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-bootstrap-force-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const cliEnv = {
    ...process.env,
    SIGNAL_ADMIN_STATE: statePath,
  };

  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  await fs.writeFile(statePath, '{"marker":"existing"}', 'utf8');

  await assert.rejects(
    execFileAsync(process.execPath, [path.join(rootDir, 'scripts', 'signal-admin.mjs'), 'bootstrap', '--force', '--json'], {
      cwd: rootDir,
      env: cliEnv,
      maxBuffer: 10 * 1024 * 1024,
    }),
    /BOOTSTRAP_CONFIRMATION_REQUIRED/,
  );

  const { stdout } = await execFileAsync(process.execPath, [path.join(rootDir, 'scripts', 'signal-admin.mjs'), 'bootstrap', '--force', '--yes', '--json'], {
    cwd: rootDir,
    env: cliEnv,
    maxBuffer: 10 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.ok(result.backupPath);
  assert.match(result.backupPath, /\.backup-/);
});
