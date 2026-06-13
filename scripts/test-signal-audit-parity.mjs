#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as signalState from './signal-state.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seedPath = path.join(rootDir, 'data', 'sample-seed.json');
const signalDataPath = path.join(rootDir, 'src', 'signalData.ts');
const parityStatePath = 'seed://sample-seed';
const omittedReportKeys = new Set(['generatedAt', 'localAgentCommand', 'recommendation', 'statePath']);

async function loadSignalDataModule(t) {
  const [source, seedJson] = await Promise.all([
    fs.readFile(signalDataPath, 'utf8'),
    fs.readFile(seedPath, 'utf8'),
  ]);
  const patchedSource = `const testImportMetaEnv = {};\n${source}`
    .replace("import seedData from '../data/sample-seed.json';", `const seedData = ${seedJson};`)
    .replaceAll('import.meta.env', 'testImportMetaEnv');
  const transpiled = ts.transpileModule(patchedSource, {
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ES2022,
      resolveJsonModule: true,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-audit-parity-'));
  t.after(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });
  const modulePath = path.join(tempDir, 'signalData.mjs');
  await fs.writeFile(modulePath, transpiled.outputText);
  return import(pathToFileURL(modulePath).href);
}

async function normalizedSeedState() {
  const seed = JSON.parse(await fs.readFile(seedPath, 'utf8'));
  return signalState.normalizeState(seed);
}

function sortKey(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return value.id
    ?? value.area
    ?? value.queue
    ?? value.channel
    ?? value.provider
    ?? value.category
    ?? value.section
    ?? value.key
    ?? value.label
    ?? value.check
    ?? JSON.stringify(value);
}

function normalizeString(value) {
  return value.replace(/state path [^,\]]+/g, 'state path <normalized>');
}

function auditProjection(value) {
  if (Array.isArray(value)) {
    const projected = value.map((item) => auditProjection(item));
    return projected.sort((left, right) => String(sortKey(left)).localeCompare(String(sortKey(right))));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !omittedReportKeys.has(key))
      .map(([key, item]) => [key, auditProjection(item)]));
  }
  return typeof value === 'string' ? normalizeString(value) : value;
}

function assertReportParity(name, engineReport, fallbackReport) {
  try {
    assert.deepEqual(auditProjection(fallbackReport), auditProjection(engineReport));
  } catch (error) {
    throw new Error(`Audit parity drift in ${name}:\n${error.message}`);
  }
}

function buildEngineReports(state, backend, provider, env) {
  const readiness = signalState.productReadinessReport(state, { backend, provider, statePath: parityStatePath });
  const dashboardAudit = signalState.dashboardAuditReport(state, { backend, statePath: parityStatePath });
  const digestionPipeline = signalState.signalDigestionPipelineReport(state, { backend, statePath: parityStatePath });
  const onboarding = signalState.onboardingReadinessReport(state, { backend, statePath: parityStatePath });
  const tenantIsolation = signalState.tenantIsolationAuditReport(state, { backend, statePath: parityStatePath });
  const operations = signalState.operationsHealthReport(state, { backend, statePath: parityStatePath });
  const lifecyclePlaybook = signalState.lifecyclePlaybookReport(state, { backend, statePath: parityStatePath });
  const providerLaunch = signalState.providerLaunchMatrixReport(state, { backend, env, provider, statePath: parityStatePath });
  const launchGate = signalState.launchGateReport(state, { backend, env, provider, readiness, statePath: parityStatePath });
  const productionDrill = signalState.productionOperationsDrillReport(state, {
    backend,
    env,
    launchGate,
    operations,
    provider,
    readiness,
    statePath: parityStatePath,
  });
  const paymentLifecycle = signalState.paymentLifecycleAuditReport(state, {
    backend,
    provider,
    providerLaunch,
    statePath: parityStatePath,
  });
  const emailHandoff = signalState.emailHandoffReport(state, {
    backend,
    env,
    launchGate,
    lifecyclePlaybook,
    operations,
    provider,
    providerLaunch,
    readiness,
    statePath: parityStatePath,
  });
  const paymentHandoff = signalState.paymentHandoffReport(state, {
    backend,
    env,
    launchGate,
    paymentLifecycle,
    provider,
    providerLaunch,
    readiness,
    statePath: parityStatePath,
  });
  const qaAnswers = signalState.qaAnswersReport(state, {
    backend,
    dashboardAudit,
    digestionPipeline,
    lifecyclePlaybook,
    onboarding,
    operations,
    provider,
    providerLaunch,
    readiness,
    statePath: parityStatePath,
  });
  const productionPlan = signalState.productionSetupPlanReport(state, {
    backend,
    env,
    launchGate,
    operations,
    provider,
    providerLaunch,
    readiness,
    statePath: parityStatePath,
  });
  const agentHandoff = signalState.localAgentHandoffReport(state, {
    backend,
    env,
    launchGate,
    operations,
    productionPlan,
    provider,
    providerLaunch,
    readiness,
    statePath: parityStatePath,
  });
  const backendHandoff = signalState.backendHandoffReport(state, {
    backend,
    env,
    operations,
    productionDrill,
    provider,
    readiness,
    statePath: parityStatePath,
  });
  const backendCutover = signalState.backendCutoverDrillReport(state, {
    backend,
    env,
    productionDrill,
    statePath: parityStatePath,
  });
  const schedulerHandoff = signalState.schedulerHandoffReport(state, {
    backend,
    env,
    launchGate,
    operations,
    provider,
    readiness,
    statePath: parityStatePath,
  });
  const completionAudit = signalState.completionAuditReport(state, {
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
    statePath: parityStatePath,
    tenantIsolation,
  });

  return {
    agentHandoff,
    backendCutover,
    backendHandoff,
    completionAudit,
    dashboardAudit,
    digestionPipeline,
    emailHandoff,
    lifecyclePlaybook,
    onboarding,
    operations,
    paymentHandoff,
    paymentLifecycle,
    productionDrill,
    productionPlan,
    providerHandoff: signalState.providerHandoffReport(state, {
      backend,
      env,
      provider,
      providerLaunch,
      statePath: parityStatePath,
    }),
    providerLaunch,
    qaAnswers,
    schedulerHandoff,
    tenantIsolation,
  };
}

function buildFallbackReports(signalData, data, backend, provider, env) {
  const dashboardAudit = signalData.fallbackDashboardAudit(data, backend);
  const digestionPipeline = signalData.fallbackSignalDigestionPipeline(data, backend);
  const onboarding = signalData.fallbackOnboardingReadiness(data, backend);
  const tenantIsolation = signalData.fallbackTenantIsolationAudit(data, backend);
  const operations = signalData.fallbackOperationsHealth(data, backend);
  const productionDrill = signalData.fallbackProductionDrill(data, backend, provider, operations, env);
  const providerLaunch = signalData.fallbackProviderLaunchMatrix(data, backend, provider);
  const lifecyclePlaybook = signalData.fallbackLifecyclePlaybook(data, backend);
  const paymentLifecycle = signalData.fallbackPaymentLifecycleAudit(data, backend, provider, providerLaunch);
  const emailHandoff = signalData.fallbackEmailHandoff(data, backend, provider, providerLaunch, operations, env);
  const paymentHandoff = signalData.fallbackPaymentHandoff(data, backend, provider, providerLaunch, paymentLifecycle, env);
  const productionPlan = signalData.fallbackProductionPlan(data, backend, provider);
  const agentHandoff = signalData.fallbackLocalAgentHandoff(data, backend, provider);

  return {
    agentHandoff,
    backendCutover: signalData.fallbackBackendCutover(data, backend, productionDrill, env),
    backendHandoff: signalData.fallbackBackendHandoff(data, backend, operations, productionDrill),
    completionAudit: signalData.fallbackCompletionAudit(data, backend, provider),
    dashboardAudit,
    digestionPipeline,
    emailHandoff,
    lifecyclePlaybook,
    onboarding,
    operations,
    paymentHandoff,
    paymentLifecycle,
    productionDrill,
    productionPlan,
    providerHandoff: signalData.fallbackProviderHandoff(data, backend, provider, providerLaunch),
    providerLaunch,
    qaAnswers: signalData.fallbackQaAnswers(data, backend, provider),
    schedulerHandoff: signalData.fallbackSchedulerHandoff(data, backend, operations, productionDrill, env),
    tenantIsolation,
  };
}

async function buildReportPairs(t) {
  const signalData = await loadSignalDataModule(t);
  const state = await normalizedSeedState();
  const fallbackSeed = structuredClone(state);
  fallbackSeed.meta = { ...(fallbackSeed.meta ?? {}), statePath: parityStatePath };
  const backend = signalData.fallbackBackendReadiness();
  const provider = signalData.fallbackProviderReadiness();
  const env = {};
  const engineReports = buildEngineReports(state, backend, provider, env);
  const fallbackReports = buildFallbackReports(signalData, fallbackSeed, backend, provider, env);
  return Object.keys(engineReports).sort().map((name) => ({
    engineReport: engineReports[name],
    fallbackReport: fallbackReports[name],
    name,
  }));
}

test('signalData seed fallback audit reports match state-engine audit logic', async (t) => {
  const pairs = await buildReportPairs(t);
  for (const { engineReport, fallbackReport, name } of pairs) {
    assertReportParity(name, engineReport, fallbackReport);
  }
});

test('audit parity guard fails on injected fallback formula drift', async (t) => {
  const pairs = await buildReportPairs(t);
  const dashboard = pairs.find((pair) => pair.name === 'dashboardAudit');
  assert(dashboard, 'dashboard parity pair should exist');
  const driftedFallback = structuredClone(dashboard.fallbackReport);
  const openSignals = driftedFallback.rows.find((row) => row.summaryKey === 'openSignals');
  assert(openSignals, 'dashboard fallback should include openSignals row');
  openSignals.displayValue += 1;

  assert.throws(
    () => assertReportParity('dashboardAudit.injected-drift', dashboard.engineReport, driftedFallback),
    /Audit parity drift in dashboardAudit\.injected-drift/,
  );
});
