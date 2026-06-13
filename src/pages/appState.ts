import { useCallback, useEffect, useRef, useState } from 'react';
import {
  claimSignalInvite,
  doctorLocalState,
  fallbackBackendCutover,
  fallbackBackendHandoff,
  fallbackBackendReadiness,
  fallbackCompletionAudit,
  fallbackDashboardAudit,
  fallbackEmailHandoff,
  fallbackLifecyclePlaybook,
  fallbackLocalAgentHandoff,
  fallbackOnboardingReadiness,
  fallbackOperationsHealth,
  fallbackPaymentHandoff,
  fallbackPaymentLifecycleAudit,
  fallbackProductionDrill,
  fallbackProductionEnvAudit,
  fallbackProductionPlan,
  fallbackProviderHandoff,
  fallbackProviderLaunchMatrix,
  fallbackProviderReadiness,
  fallbackQaAnswers,
  fallbackSchedulerHandoff,
  fallbackSignalDigestionPipeline,
  fallbackStateResponse,
  fallbackTenantIsolationAudit,
  fetchAgentHandoff,
  fetchBackendCutover,
  fetchBackendHandoff,
  fetchCompletionAudit,
  fetchDashboardAudit,
  fetchEmailHandoff,
  fetchLifecyclePlaybook,
  fetchOnboardingReadiness,
  fetchOperationsHealth,
  fetchPaymentHandoff,
  fetchPaymentLifecycle,
  fetchProductionDrill,
  fetchProductionEnv,
  fetchProductionPlan,
  fetchProviderHandoff,
  fetchProviderLaunch,
  fetchProviderReadiness,
  fetchProviderSandbox,
  fetchQaAnswers,
  fetchSchedulerHandoff,
  fetchSignalDigestionPipeline,
  fetchSignalState,
  fetchTenantIsolation,
  mutateSignalState,
  registerSignalWorkspace,
  runProviderScheduledValidation,
  switchSignalSession,
  type BackendCutoverDrillReport,
  type BackendHandoffReport,
  type CompletionAuditReport,
  type DashboardAuditReport,
  type EmailHandoffReport,
  type LifecyclePlaybookReport,
  type LocalAgentHandoffReport,
  type OnboardingReadinessReport,
  type OperationsHealthReport,
  type PaymentHandoffReport,
  type PaymentLifecycleAuditReport,
  type ProductionDrillReport,
  type ProductionEnvAuditReport,
  type ProductionSetupPlanReport,
  type ProviderHandoffReport,
  type ProviderLaunchMatrixReport,
  type ProviderReadiness,
  type ProviderSandboxReport,
  type QaAnswersReport,
  type SchedulerHandoffReport,
  type SignalDigestionPipelineReport,
  type SignalAppData,
  type SignalMutationAction,
  type SignalStateResponse,
  type StateSummary,
  type TenantIsolationAuditReport,
} from '../signalData';
import type { AdminReportSection, AppMode, DataSource } from './appTypes';

function activeUserIdFromResponse(response: { state: SignalAppData; summary: StateSummary }) {
  return response.summary.activeUserId ?? response.state.session?.activeUserId ?? 'usr_admin';
}

async function dashboardAuditForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<DashboardAuditReport> {
  if (mode === 'admin') {
    try {
      const auditResponse = await fetchDashboardAudit(signal);
      return auditResponse.audit;
    } catch {
      // Member sessions and offline local development can still render a seed/local audit.
    }
  }
  return response.dashboardAudit ?? fallbackDashboardAudit(response.state, response.backend ?? fallbackBackendReadiness());
}

async function digestionPipelineForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<SignalDigestionPipelineReport> {
  if (mode === 'admin') {
    try {
      const pipelineResponse = await fetchSignalDigestionPipeline(signal);
      return pipelineResponse.pipeline;
    } catch {
      // Member sessions and offline local development can still render a seed/local pipeline audit.
    }
  }
  return response.digestionPipeline ?? fallbackSignalDigestionPipeline(response.state, response.backend ?? fallbackBackendReadiness());
}

async function onboardingReadinessForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<OnboardingReadinessReport> {
  if (mode === 'admin') {
    try {
      const onboardingResponse = await fetchOnboardingReadiness(signal);
      return onboardingResponse.onboarding;
    } catch {
      // Member sessions and offline local development can still render a seed/local report.
    }
  }
  return response.onboardingReadiness ?? fallbackOnboardingReadiness(response.state, response.backend ?? fallbackBackendReadiness());
}

async function tenantIsolationForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<TenantIsolationAuditReport> {
  if (mode === 'admin') {
    try {
      const isolationResponse = await fetchTenantIsolation(signal);
      return isolationResponse.isolation;
    } catch {
      // Member sessions and offline local development can still render a seed/local report.
    }
  }
  return response.tenantIsolation ?? fallbackTenantIsolationAudit(response.state, response.backend ?? fallbackBackendReadiness());
}

async function operationsHealthForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<OperationsHealthReport> {
  if (mode === 'admin') {
    try {
      const operationsResponse = await fetchOperationsHealth(signal);
      return operationsResponse.operations;
    } catch {
      // Member sessions and offline local development can still render a seed/local operations report.
    }
  }
  return response.operationsHealth ?? fallbackOperationsHealth(response.state, response.backend ?? fallbackBackendReadiness());
}

async function emailHandoffForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<EmailHandoffReport> {
  if (mode === 'admin') {
    try {
      const handoffResponse = await fetchEmailHandoff(signal);
      return handoffResponse.handoff;
    } catch {
      // Member sessions and offline local development can still render seed/local email launch handoff.
    }
  }
  const backend = response.backend ?? fallbackBackendReadiness();
  const provider = fallbackProviderReadiness();
  const launch = response.providerLaunch ?? fallbackProviderLaunchMatrix(response.state, backend, provider);
  const operations = response.operationsHealth ?? fallbackOperationsHealth(response.state, backend);
  return response.emailHandoff ?? fallbackEmailHandoff(response.state, backend, provider, launch, operations);
}

async function paymentLifecycleForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<PaymentLifecycleAuditReport> {
  if (mode === 'admin') {
    try {
      const paymentResponse = await fetchPaymentLifecycle(signal);
      return paymentResponse.payment;
    } catch {
      // Member sessions and offline local development can still render seed/local payment lifecycle evidence.
    }
  }
  return response.paymentLifecycle ?? fallbackPaymentLifecycleAudit(response.state, response.backend ?? fallbackBackendReadiness(), fallbackProviderReadiness());
}

async function paymentHandoffForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<PaymentHandoffReport> {
  if (mode === 'admin') {
    try {
      const handoffResponse = await fetchPaymentHandoff(signal);
      return handoffResponse.handoff;
    } catch {
      // Member sessions and offline local development can still render seed/local payment launch handoff.
    }
  }
  const backend = response.backend ?? fallbackBackendReadiness();
  const provider = fallbackProviderReadiness();
  const launch = response.providerLaunch ?? fallbackProviderLaunchMatrix(response.state, backend, provider);
  const payment = response.paymentLifecycle ?? fallbackPaymentLifecycleAudit(response.state, backend, provider);
  return response.paymentHandoff ?? fallbackPaymentHandoff(response.state, backend, provider, launch, payment);
}

async function productionDrillForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<ProductionDrillReport> {
  if (mode === 'admin') {
    try {
      const drillResponse = await fetchProductionDrill(signal);
      return drillResponse.drill;
    } catch {
      // Member sessions and offline local development can still render a seed/local production drill.
    }
  }
  const backend = response.backend ?? fallbackBackendReadiness();
  return response.productionDrill ?? fallbackProductionDrill(response.state, backend, fallbackProviderReadiness(), response.operationsHealth ?? fallbackOperationsHealth(response.state, backend));
}

async function providerLaunchForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<ProviderLaunchMatrixReport> {
  if (mode === 'admin') {
    try {
      const launchResponse = await fetchProviderLaunch(signal);
      return launchResponse.launch;
    } catch {
      // Member sessions and offline local development can still render a seed/local provider launch matrix.
    }
  }
  const backend = response.backend ?? fallbackBackendReadiness();
  return response.providerLaunch ?? fallbackProviderLaunchMatrix(response.state, backend, fallbackProviderReadiness());
}

async function providerHandoffForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<ProviderHandoffReport> {
  if (mode === 'admin') {
    try {
      const handoffResponse = await fetchProviderHandoff(signal);
      return handoffResponse.handoff;
    } catch {
      // Member sessions and offline local development can still render a seed/local provider handoff.
    }
  }
  const backend = response.backend ?? fallbackBackendReadiness();
  const provider = fallbackProviderReadiness();
  const launch = response.providerLaunch ?? fallbackProviderLaunchMatrix(response.state, backend, provider);
  return response.providerHandoff ?? fallbackProviderHandoff(response.state, backend, provider, launch);
}

async function productionEnvForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<ProductionEnvAuditReport> {
  if (mode === 'admin') {
    try {
      const envResponse = await fetchProductionEnv(signal);
      return envResponse.env;
    } catch {
      // Member sessions and offline local development can still render a seed/local production env audit.
    }
  }
  const backend = response.backend ?? fallbackBackendReadiness();
  return response.productionEnv ?? fallbackProductionEnvAudit(response.state, backend, fallbackProviderReadiness());
}

async function productionPlanForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<ProductionSetupPlanReport> {
  if (mode === 'admin') {
    try {
      const planResponse = await fetchProductionPlan(signal);
      return planResponse.plan;
    } catch {
      // Member sessions and offline local development can still render a seed/local production plan.
    }
  }
  const backend = response.backend ?? fallbackBackendReadiness();
  return response.productionPlan ?? fallbackProductionPlan(response.state, backend, fallbackProviderReadiness());
}

async function lifecyclePlaybookForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<LifecyclePlaybookReport> {
  if (mode === 'admin') {
    try {
      const playbookResponse = await fetchLifecyclePlaybook(signal);
      return playbookResponse.playbook;
    } catch {
      // Member sessions and offline local development can still render a seed/local lifecycle playbook.
    }
  }
  const backend = response.backend ?? fallbackBackendReadiness();
  return response.lifecyclePlaybook ?? fallbackLifecyclePlaybook(response.state, backend);
}

async function qaAnswersForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<QaAnswersReport> {
  if (mode === 'admin') {
    try {
      const qaResponse = await fetchQaAnswers(signal);
      return qaResponse.qa;
    } catch {
      // Member sessions and offline local development can still render seed/local QA answers.
    }
  }
  const backend = response.backend ?? fallbackBackendReadiness();
  return response.qaAnswers ?? fallbackQaAnswers(response.state, backend, fallbackProviderReadiness());
}

async function agentHandoffForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<LocalAgentHandoffReport> {
  if (mode === 'admin') {
    try {
      const handoffResponse = await fetchAgentHandoff(signal);
      return handoffResponse.handoff;
    } catch {
      // Member sessions and offline local development can still render a seed/local handoff.
    }
  }
  const backend = response.backend ?? fallbackBackendReadiness();
  return response.agentHandoff ?? fallbackLocalAgentHandoff(response.state, backend, fallbackProviderReadiness());
}

async function backendHandoffForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<BackendHandoffReport> {
  if (mode === 'admin') {
    try {
      const handoffResponse = await fetchBackendHandoff(signal);
      return handoffResponse.handoff;
    } catch {
      // Member sessions and offline local development can still render a seed/local backend handoff.
    }
  }
  const backend = response.backend ?? fallbackBackendReadiness();
  const operations = response.operationsHealth ?? fallbackOperationsHealth(response.state, backend);
  const drill = response.productionDrill ?? fallbackProductionDrill(response.state, backend, fallbackProviderReadiness(), operations);
  return response.backendHandoff ?? fallbackBackendHandoff(response.state, backend, operations, drill);
}

async function backendCutoverForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<BackendCutoverDrillReport> {
  if (mode === 'admin') {
    try {
      const cutoverResponse = await fetchBackendCutover(signal);
      return cutoverResponse.cutover;
    } catch {
      // Member sessions and offline local development can still render a seed/local backend cutover drill.
    }
  }
  const backend = response.backend ?? fallbackBackendReadiness();
  const operations = response.operationsHealth ?? fallbackOperationsHealth(response.state, backend);
  const drill = response.productionDrill ?? fallbackProductionDrill(response.state, backend, fallbackProviderReadiness(), operations);
  return response.backendCutover ?? fallbackBackendCutover(response.state, backend, drill);
}

async function schedulerHandoffForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<SchedulerHandoffReport> {
  if (mode === 'admin') {
    try {
      const handoffResponse = await fetchSchedulerHandoff(signal);
      return handoffResponse.handoff;
    } catch {
      // Member sessions and offline local development can still render a seed/local scheduler handoff.
    }
  }
  const backend = response.backend ?? fallbackBackendReadiness();
  const operations = response.operationsHealth ?? fallbackOperationsHealth(response.state, backend);
  const drill = response.productionDrill ?? fallbackProductionDrill(response.state, backend, fallbackProviderReadiness(), operations);
  return response.schedulerHandoff ?? fallbackSchedulerHandoff(response.state, backend, operations, drill);
}

async function completionAuditForResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal): Promise<CompletionAuditReport> {
  if (mode === 'admin') {
    try {
      const completionResponse = await fetchCompletionAudit(signal);
      return completionResponse.completion;
    } catch {
      // Member sessions and offline local development can still render a seed/local completion audit.
    }
  }
  return response.completionAudit ?? fallbackCompletionAudit(
    response.state,
    response.backend ?? fallbackBackendReadiness(),
    fallbackProviderReadiness(),
  );
}

type AdminReportPatch = Partial<Pick<
  SignalStateResponse,
  | 'agentHandoff'
  | 'completionAudit'
  | 'backendHandoff'
  | 'backendCutover'
  | 'schedulerHandoff'
  | 'digestionPipeline'
  | 'lifecyclePlaybook'
  | 'onboardingReadiness'
  | 'tenantIsolation'
  | 'operationsHealth'
  | 'emailHandoff'
  | 'paymentHandoff'
  | 'paymentLifecycle'
  | 'providerHandoff'
  | 'providerLaunch'
  | 'productionEnv'
  | 'productionPlan'
  | 'productionDrill'
  | 'qaAnswers'
>>;

type AdminReportKey = keyof AdminReportPatch;
type AdminReportLoader = (response: SignalStateResponse, mode: AppMode, signal?: AbortSignal) => Promise<AdminReportPatch>;

const adminSectionReportKeys: Record<AdminReportSection, AdminReportKey[]> = {
  dashboard: [],
  organization: ['onboardingReadiness'],
  email: ['emailHandoff', 'digestionPipeline'],
  billing: ['paymentHandoff', 'paymentLifecycle', 'lifecyclePlaybook'],
  integrations: ['providerHandoff'],
  platform: ['backendHandoff', 'schedulerHandoff', 'onboardingReadiness', 'tenantIsolation', 'operationsHealth'],
  launch: ['agentHandoff', 'completionAudit', 'backendCutover', 'providerLaunch', 'productionEnv', 'productionPlan', 'productionDrill', 'qaAnswers'],
  audit: [],
  cli: [],
};

const adminSectionReportLoaders: Partial<Record<AdminReportSection, AdminReportLoader>> = {
  organization: async (response, mode, signal) => ({
    onboardingReadiness: await onboardingReadinessForResponse(response, mode, signal),
  }),
  email: async (response, mode, signal) => {
    const [emailHandoff, digestionPipeline] = await Promise.all([
      emailHandoffForResponse(response, mode, signal),
      digestionPipelineForResponse(response, mode, signal),
    ]);
    return { emailHandoff, digestionPipeline };
  },
  billing: async (response, mode, signal) => {
    const [paymentHandoff, paymentLifecycle, lifecyclePlaybook] = await Promise.all([
      paymentHandoffForResponse(response, mode, signal),
      paymentLifecycleForResponse(response, mode, signal),
      lifecyclePlaybookForResponse(response, mode, signal),
    ]);
    return { paymentHandoff, paymentLifecycle, lifecyclePlaybook };
  },
  integrations: async (response, mode, signal) => ({
    providerHandoff: await providerHandoffForResponse(response, mode, signal),
  }),
  platform: async (response, mode, signal) => {
    const [backendHandoff, schedulerHandoff, onboardingReadiness, tenantIsolation, operationsHealth] = await Promise.all([
      backendHandoffForResponse(response, mode, signal),
      schedulerHandoffForResponse(response, mode, signal),
      onboardingReadinessForResponse(response, mode, signal),
      tenantIsolationForResponse(response, mode, signal),
      operationsHealthForResponse(response, mode, signal),
    ]);
    return { backendHandoff, schedulerHandoff, onboardingReadiness, tenantIsolation, operationsHealth };
  },
  launch: async (response, mode, signal) => {
    const [agentHandoff, completionAudit, backendCutover, providerLaunch, productionEnv, productionPlan, productionDrill, qaAnswers] = await Promise.all([
      agentHandoffForResponse(response, mode, signal),
      completionAuditForResponse(response, mode, signal),
      backendCutoverForResponse(response, mode, signal),
      providerLaunchForResponse(response, mode, signal),
      productionEnvForResponse(response, mode, signal),
      productionPlanForResponse(response, mode, signal),
      productionDrillForResponse(response, mode, signal),
      qaAnswersForResponse(response, mode, signal),
    ]);
    return { agentHandoff, completionAudit, backendCutover, providerLaunch, productionEnv, productionPlan, productionDrill, qaAnswers };
  },
};

function adminSectionHasReports(response: SignalStateResponse, section: AdminReportSection) {
  return adminSectionReportKeys[section].every((key) => Boolean(response[key]));
}

async function enrichStateResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal) {
  const dashboardAudit = await dashboardAuditForResponse(response, mode, signal);
  return {
    ...response,
    dashboardAudit,
  };
}

async function enrichFullStateResponse(response: ReturnType<typeof fallbackStateResponse>, mode: AppMode, signal?: AbortSignal) {
  const [agentHandoff, completionAudit, backendHandoff, backendCutover, schedulerHandoff, dashboardAudit, digestionPipeline, lifecyclePlaybook, onboardingReadiness, tenantIsolation, operationsHealth, emailHandoff, paymentLifecycle, paymentHandoff, productionDrill, productionEnv, productionPlan, providerHandoff, providerLaunch, qaAnswers] = await Promise.all([
    agentHandoffForResponse(response, mode, signal),
    completionAuditForResponse(response, mode, signal),
    backendHandoffForResponse(response, mode, signal),
    backendCutoverForResponse(response, mode, signal),
    schedulerHandoffForResponse(response, mode, signal),
    dashboardAuditForResponse(response, mode, signal),
    digestionPipelineForResponse(response, mode, signal),
    lifecyclePlaybookForResponse(response, mode, signal),
    onboardingReadinessForResponse(response, mode, signal),
    tenantIsolationForResponse(response, mode, signal),
    operationsHealthForResponse(response, mode, signal),
    emailHandoffForResponse(response, mode, signal),
    paymentLifecycleForResponse(response, mode, signal),
    paymentHandoffForResponse(response, mode, signal),
    productionDrillForResponse(response, mode, signal),
    productionEnvForResponse(response, mode, signal),
    productionPlanForResponse(response, mode, signal),
    providerHandoffForResponse(response, mode, signal),
    providerLaunchForResponse(response, mode, signal),
    qaAnswersForResponse(response, mode, signal),
  ]);
  return {
    ...response,
    agentHandoff,
    completionAudit,
    backendHandoff,
    backendCutover,
    schedulerHandoff,
    dashboardAudit,
    digestionPipeline,
    lifecyclePlaybook,
    onboardingReadiness,
    tenantIsolation,
    operationsHealth,
    emailHandoff,
    paymentHandoff,
    paymentLifecycle,
    providerHandoff,
    providerLaunch,
    productionEnv,
    productionPlan,
    productionDrill,
    qaAnswers,
  };
}

async function fetchLiveStateBundle(mode: AppMode, signal?: AbortSignal) {
  const [stateResponse, readinessResponse] = await Promise.all([
    fetchSignalState(signal),
    fetchProviderReadiness(signal),
  ]);
  const response = mode === 'admin'
    ? await enrichStateResponse(stateResponse, mode, signal)
    : await enrichFullStateResponse(stateResponse, mode, signal);
  return {
    readiness: readinessResponse.readiness,
    response,
  };
}

type OptimisticMutationResponse = {
  message: string;
  response: SignalStateResponse;
};

const feedbackLabels = ['useful', 'noisy', 'wrong_route', 'bad_source', 'product_gap'] as const;
type FeedbackLabel = typeof feedbackLabels[number];

function optimisticMutationResponse(
  current: SignalStateResponse,
  action: SignalMutationAction,
  args: Record<string, unknown>,
  actorUserId: string,
): OptimisticMutationResponse | null {
  const now = new Date().toISOString();

  if (action === 'signals.feedback') {
    const signalId = typeof args.signalId === 'string' ? args.signalId : '';
    const label = typeof args.label === 'string' && feedbackLabels.includes(args.label as FeedbackLabel)
      ? args.label as FeedbackLabel
      : null;
    if (!signalId || !label || !current.state.signals.some((signal) => signal.id === signalId)) {
      return null;
    }
    const nextState: SignalAppData = {
      ...current.state,
      signalFeedback: [
        ...(current.state.signalFeedback ?? []),
        {
          createdAt: now,
          id: `optimistic_feedback_${signalId}`,
          label,
          note: typeof args.note === 'string' ? args.note : null,
          signalId,
          tenantId: current.state.signals.find((signal) => signal.id === signalId)?.tenantId ?? '',
          userId: actorUserId,
        },
      ],
      signals: current.state.signals.map((signal) => signal.id === signalId
        ? {
            ...signal,
            feedbackCount: (signal.feedbackCount ?? 0) + 1,
            lastFeedbackAt: now,
            lastFeedbackLabel: label,
          }
        : signal),
    };
    return {
      message: `Optimistically recorded ${signalId} feedback as ${label}`,
      response: { ...current, state: nextState },
    };
  }

  if (action === 'accounts.action-status') {
    const actionId = typeof args.actionId === 'string' ? args.actionId : '';
    const status = typeof args.status === 'string' ? args.status : '';
    if (!actionId || !['open', 'done', 'muted'].includes(status)) {
      return null;
    }
    let patched = false;
    const nextState: SignalAppData = {
      ...current.state,
      accountActions: (current.state.accountActions ?? []).map((accountAction) => {
        if (accountAction.id !== actionId) {
          return accountAction;
        }
        patched = true;
        return {
          ...accountAction,
          completedAt: status === 'done' ? now : null,
          status: status as typeof accountAction.status,
        };
      }),
    };
    return patched
      ? {
          message: `Optimistically moved ${actionId} to ${status}`,
          response: { ...current, state: nextState },
        }
      : null;
  }

  if (action === 'payments.recover') {
    const invoiceId = typeof args.invoiceId === 'string' ? args.invoiceId : '';
    const invoice = current.state.invoices.find((item) => item.id === invoiceId);
    if (!invoice || !['open', 'past_due'].includes(invoice.status)) {
      return null;
    }
    const sessionId = `optimistic_recovery_${invoice.id}`;
    const nextAttemptAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const nextState: SignalAppData = {
      ...current.state,
      billingSessions: [
        ...(current.state.billingSessions ?? []),
        {
          createdAt: now,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          id: sessionId,
          invoiceId: invoice.id,
          provider: invoice.provider,
          status: 'ready',
          subscriptionId: invoice.subscriptionId,
          tenantId: invoice.tenantId,
          type: 'payment_recovery',
          url: `signal://billing/recover/${invoice.tenantId}/${invoice.id}`,
        },
      ],
      invoices: current.state.invoices.map((item) => item.id === invoice.id
        ? {
            ...item,
            nextPaymentAttemptAt: nextAttemptAt,
            status: 'open',
          }
        : item),
      paymentEvents: [
        ...(current.state.paymentEvents ?? []),
        {
          createdAt: now,
          id: `optimistic_payment_${invoice.id}`,
          invoiceId: invoice.id,
          provider: invoice.provider,
          sessionId,
          status: 'recorded',
          subscriptionId: invoice.subscriptionId,
          tenantId: invoice.tenantId,
          type: 'invoice.recovery_session.created',
        },
      ],
    };
    return {
      message: `Optimistically prepared recovery for ${invoice.id}`,
      response: { ...current, state: nextState },
    };
  }

  return null;
}

function signalPollingIntervalMs() {
  const configured = Number(import.meta.env.VITE_SIGNAL_POLL_INTERVAL_MS ?? 45_000);
  return Number.isFinite(configured) && configured >= 0 ? configured : 45_000;
}

export function useSignalAppState(mode: AppMode) {
  const [response, setResponse] = useState(fallbackStateResponse);
  const [providerReadiness, setProviderReadiness] = useState<ProviderReadiness>(fallbackProviderReadiness);
  const [providerSandbox, setProviderSandbox] = useState<ProviderSandboxReport | null>(null);
  const [source, setSource] = useState<DataSource>('seed');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [isValidatingSandbox, setIsValidatingSandbox] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(() => new Date().toISOString());
  const [lastMutation, setLastMutation] = useState<string | null>(null);
  const pollingIntervalMs = signalPollingIntervalMs();
  const [actorUserId, setActorUserIdState] = useState<string>(() => activeUserIdFromResponse(fallbackStateResponse()));
  const [sectionLoading, setSectionLoading] = useState<Partial<Record<AdminReportSection, boolean>>>({});
  const responseRef = useRef(response);
  const loadedSectionsRef = useRef<Set<AdminReportSection>>(new Set());
  const sectionRequestsRef = useRef<Partial<Record<AdminReportSection, Promise<void>>>>({});
  const sectionCacheVersionRef = useRef(0);

  useEffect(() => {
    responseRef.current = response;
  }, [response]);

  function resetAdminSectionCache(nextResponse?: SignalStateResponse) {
    sectionCacheVersionRef.current += 1;
    sectionRequestsRef.current = {};
    loadedSectionsRef.current = new Set(
      (Object.keys(adminSectionReportKeys) as AdminReportSection[]).filter((section) => nextResponse && adminSectionHasReports(nextResponse, section)),
    );
    setSectionLoading({});
  }

  function markStateUpdated() {
    setLastUpdatedAt(new Date().toISOString());
  }

  async function refresh() {
    setIsLoading(true);
    setError(null);
    try {
      const next = await fetchLiveStateBundle(mode);
      setResponse(next.response);
      responseRef.current = next.response;
      resetAdminSectionCache(next.response);
      setProviderReadiness(next.readiness);
      setActorUserIdState(activeUserIdFromResponse(next.response));
      setSource('api');
      markStateUpdated();
    } catch (refreshError) {
      const fallback = fallbackStateResponse();
      setSource('seed');
      setResponse(fallback);
      responseRef.current = fallback;
      resetAdminSectionCache(fallback);
      setProviderReadiness(fallbackProviderReadiness());
      setProviderSandbox(null);
      setActorUserIdState(activeUserIdFromResponse(fallback));
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
      markStateUpdated();
    } finally {
      setIsLoading(false);
    }
  }

  async function mutate(action: SignalMutationAction, args: Record<string, unknown>) {
    setIsMutating(true);
    setError(null);
    const previousResponse = responseRef.current;
    const optimistic = optimisticMutationResponse(previousResponse, action, args, actorUserId);
    if (optimistic) {
      setResponse(optimistic.response);
      responseRef.current = optimistic.response;
      setLastMutation(optimistic.message);
      markStateUpdated();
    }
    try {
      const result = await mutateSignalState(action, args, actorUserId);
      const backend = responseRef.current.backend ?? fallbackBackendReadiness();
      const nextResponse = await enrichStateResponse({
        backend,
        doctor: result.doctor,
        ok: true,
        state: result.state,
        summary: result.summary,
      }, mode);
      setResponse(nextResponse);
      responseRef.current = nextResponse;
      resetAdminSectionCache(nextResponse);
      setActorUserIdState(activeUserIdFromResponse({ state: result.state, summary: result.summary }));
      try {
        const readiness = await fetchProviderReadiness();
        setProviderReadiness(readiness.readiness);
      } catch {
        setProviderReadiness(fallbackProviderReadiness());
      }
      setLastMutation(result.details.message);
      setSource('api');
      markStateUpdated();
      return { ok: true } as const;
    } catch (mutationError) {
      const message = mutationError instanceof Error ? mutationError.message : String(mutationError);
      if (optimistic) {
        setResponse(previousResponse);
        responseRef.current = previousResponse;
        setLastMutation(`Rolled back optimistic ${action}`);
      }
      setError(message);
      return { ok: false, error: message } as const;
    } finally {
      setIsMutating(false);
    }
  }

  async function claimInvite(args: Record<string, unknown>) {
    setIsMutating(true);
    setError(null);
    try {
      const result = await claimSignalInvite(args);
      const backend = response.backend ?? fallbackBackendReadiness();
      const nextResponse = await enrichStateResponse({
        backend,
        doctor: result.doctor,
        ok: true,
        state: result.state,
        summary: result.summary,
      }, mode);
      setResponse(nextResponse);
      responseRef.current = nextResponse;
      resetAdminSectionCache(nextResponse);
      setActorUserIdState(activeUserIdFromResponse({ state: result.state, summary: result.summary }));
      try {
        const readiness = await fetchProviderReadiness();
        setProviderReadiness(readiness.readiness);
      } catch {
        setProviderReadiness(fallbackProviderReadiness());
      }
      setLastMutation(result.details.message);
      setSource('api');
      markStateUpdated();
      return { ok: true } as const;
    } catch (claimError) {
      const message = claimError instanceof Error ? claimError.message : String(claimError);
      setError(message);
      return { ok: false, error: message } as const;
    } finally {
      setIsMutating(false);
    }
  }

  async function registerWorkspace(args: Record<string, unknown>) {
    setIsMutating(true);
    setError(null);
    try {
      const result = await registerSignalWorkspace(args);
      const backend = response.backend ?? fallbackBackendReadiness();
      const nextResponse = await enrichStateResponse({
        backend,
        doctor: result.doctor,
        ok: true,
        state: result.state,
        summary: result.summary,
      }, mode);
      setResponse(nextResponse);
      responseRef.current = nextResponse;
      resetAdminSectionCache(nextResponse);
      setActorUserIdState(activeUserIdFromResponse({ state: result.state, summary: result.summary }));
      try {
        const readiness = await fetchProviderReadiness();
        setProviderReadiness(readiness.readiness);
      } catch {
        setProviderReadiness(fallbackProviderReadiness());
      }
      setLastMutation(result.details.message);
      setSource('api');
      markStateUpdated();
      return { ok: true } as const;
    } catch (registrationError) {
      const message = registrationError instanceof Error ? registrationError.message : String(registrationError);
      setError(message);
      return { ok: false, error: message } as const;
    } finally {
      setIsMutating(false);
    }
  }

  async function setActorUserId(userId: string) {
    if (source !== 'api') {
      setActorUserIdState(userId);
      const user = response.state.users.find((item) => item.id === userId);
      setLastMutation(user ? `Seed session switched to ${user.email}` : 'Seed session switched');
      markStateUpdated();
      return;
    }

    setIsMutating(true);
    setError(null);
    try {
      const result = await switchSignalSession(userId);
      const backend = response.backend ?? fallbackBackendReadiness();
      const nextResponse = await enrichStateResponse({
        backend,
        doctor: result.doctor,
        ok: true,
        state: result.state,
        summary: result.summary,
      }, mode);
      setResponse(nextResponse);
      responseRef.current = nextResponse;
      resetAdminSectionCache(nextResponse);
      setActorUserIdState(activeUserIdFromResponse({ state: result.state, summary: result.summary }));
      try {
        const readiness = await fetchProviderReadiness();
        setProviderReadiness(readiness.readiness);
      } catch {
        setProviderReadiness(fallbackProviderReadiness());
      }
      setLastMutation(result.details.message);
      setSource('api');
      markStateUpdated();
    } catch (sessionError) {
      setError(sessionError instanceof Error ? sessionError.message : String(sessionError));
    } finally {
      setIsMutating(false);
    }
  }

  async function validateSandbox() {
    setIsValidatingSandbox(true);
    setError(null);
    try {
      const result = await fetchProviderSandbox();
      setProviderSandbox(result.sandbox);
      if (result.state && result.summary) {
        const backend = response.backend ?? fallbackBackendReadiness();
        const nextResponse = await enrichStateResponse({
          backend,
          doctor: result.doctor ?? doctorLocalState(result.state),
          ok: true,
          state: result.state,
          summary: result.summary,
        }, mode);
        setResponse(nextResponse);
        responseRef.current = nextResponse;
        resetAdminSectionCache(nextResponse);
        setActorUserIdState(activeUserIdFromResponse({ state: result.state, summary: result.summary }));
        markStateUpdated();
      }
      setLastMutation(
        result.recorded
          ? `Recorded sandbox validation ${result.recorded.status}: ${result.sandbox.summary.passed}/${result.sandbox.summary.total} providers passed`
          : `Sandbox validation: ${result.sandbox.summary.passed}/${result.sandbox.summary.total} providers passed`,
      );
      markStateUpdated();
    } catch (sandboxError) {
      setError(sandboxError instanceof Error ? sandboxError.message : String(sandboxError));
    } finally {
      setIsValidatingSandbox(false);
    }
  }

  async function runScheduledValidation(force = false) {
    setIsValidatingSandbox(true);
    setError(null);
    try {
      const result = await runProviderScheduledValidation(force);
      if (result.sandbox) {
        setProviderSandbox(result.sandbox);
      }
      if (result.state && result.summary) {
        const backend = response.backend ?? fallbackBackendReadiness();
        const nextResponse = await enrichStateResponse({
          backend,
          doctor: result.doctor ?? doctorLocalState(result.state),
          ok: true,
          state: result.state,
          summary: result.summary,
        }, mode);
        setResponse(nextResponse);
        responseRef.current = nextResponse;
        resetAdminSectionCache(nextResponse);
        setActorUserIdState(activeUserIdFromResponse({ state: result.state, summary: result.summary }));
        markStateUpdated();
      }
      try {
        const readiness = await fetchProviderReadiness();
        setProviderReadiness(readiness.readiness);
      } catch {
        setProviderReadiness(fallbackProviderReadiness());
      }
      setLastMutation(
        result.skipped
          ? 'No provider validation schedules are due'
          : result.recorded
            ? `Recorded scheduled sandbox validation ${result.recorded.status}: ${result.recorded.summary.passed}/${result.recorded.summary.total} providers passed`
            : 'Scheduled sandbox validation completed',
      );
      setSource('api');
      markStateUpdated();
    } catch (scheduledError) {
      setError(scheduledError instanceof Error ? scheduledError.message : String(scheduledError));
    } finally {
      setIsValidatingSandbox(false);
    }
  }

  useEffect(() => {
    if (mode === 'marketing') {
      return;
    }

    const abortController = new AbortController();
    setIsLoading(true);
    setError(null);
    fetchLiveStateBundle(mode, abortController.signal)
      .then((next) => {
        setResponse(next.response);
        responseRef.current = next.response;
        resetAdminSectionCache(next.response);
        setProviderReadiness(next.readiness);
        setActorUserIdState(activeUserIdFromResponse(next.response));
        setSource('api');
        markStateUpdated();
      })
      .catch((loadError) => {
        if (abortController.signal.aborted) {
          return;
        }
        const fallback = fallbackStateResponse();
        setResponse(fallback);
        responseRef.current = fallback;
        resetAdminSectionCache(fallback);
        setProviderReadiness(fallbackProviderReadiness());
        setProviderSandbox(null);
        setActorUserIdState(activeUserIdFromResponse(fallback));
        setSource('seed');
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        markStateUpdated();
      })
      .finally(() => {
        if (!abortController.signal.aborted) {
          setIsLoading(false);
        }
      });

    return () => abortController.abort();
  }, [mode]);

  useEffect(() => {
    if (mode === 'marketing' || pollingIntervalMs <= 0 || isLoading || isMutating) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      void refresh();
    }, pollingIntervalMs);

    return () => window.clearInterval(intervalId);
  }, [mode, pollingIntervalMs, isLoading, isMutating]);

  const loadAdminSection = useCallback(async (section: AdminReportSection) => {
    if (mode !== 'admin' || source === 'seed') {
      loadedSectionsRef.current.add(section);
      return;
    }

    if (loadedSectionsRef.current.has(section)) {
      return;
    }

    const currentResponse = responseRef.current;
    if (adminSectionHasReports(currentResponse, section)) {
      loadedSectionsRef.current.add(section);
      return;
    }

    const loader = adminSectionReportLoaders[section];
    if (!loader) {
      loadedSectionsRef.current.add(section);
      return;
    }

    const inFlight = sectionRequestsRef.current[section];
    if (inFlight) {
      return inFlight;
    }

    const requestVersion = sectionCacheVersionRef.current;
    setSectionLoading((current) => ({ ...current, [section]: true }));

    const request = loader(currentResponse, mode)
      .then((patch) => {
        if (sectionCacheVersionRef.current !== requestVersion) {
          return;
        }
        loadedSectionsRef.current.add(section);
        setResponse((current) => {
          const next = { ...current, ...patch };
          responseRef.current = next;
          return next;
        });
      })
      .catch((sectionError) => {
        if (sectionCacheVersionRef.current === requestVersion) {
          setError(sectionError instanceof Error ? sectionError.message : String(sectionError));
        }
      })
      .finally(() => {
        if (sectionCacheVersionRef.current === requestVersion) {
          delete sectionRequestsRef.current[section];
          setSectionLoading((current) => ({ ...current, [section]: false }));
        }
      });

    sectionRequestsRef.current[section] = request;
    return request;
  }, [mode, source]);

  return {
    agentHandoff: response.agentHandoff,
    completionAudit: response.completionAudit,
    backendHandoff: response.backendHandoff,
    backendCutover: response.backendCutover,
    schedulerHandoff: response.schedulerHandoff,
    backendReadiness: response.backend ?? fallbackBackendReadiness(),
    data: response.state,
    dashboardAudit: response.dashboardAudit ?? fallbackDashboardAudit(response.state, response.backend ?? fallbackBackendReadiness()),
    doctor: source === 'api' ? response.doctor : doctorLocalState(response.state),
    error,
    isLoading,
    isMutating,
    isValidatingSandbox,
    claimInvite,
    lifecyclePlaybook: response.lifecyclePlaybook,
    digestionPipeline: response.digestionPipeline,
    lastMutation,
    lastUpdatedAt,
    loadAdminSection,
    mutate,
    onboardingReadiness: response.onboardingReadiness,
    tenantIsolation: response.tenantIsolation,
    operationsHealth: response.operationsHealth,
    emailHandoff: response.emailHandoff,
    paymentHandoff: response.paymentHandoff,
    paymentLifecycle: response.paymentLifecycle,
    providerHandoff: response.providerHandoff,
    providerLaunch: response.providerLaunch,
    productionEnv: response.productionEnv,
    productionPlan: response.productionPlan,
    productionDrill: response.productionDrill,
    qaAnswers: response.qaAnswers,
    providerReadiness,
    providerSandbox,
    pollingIntervalMs,
    registerWorkspace,
    refresh,
    actorUserId,
    runScheduledValidation,
    sectionLoading,
    setActorUserId,
    validateSandbox,
    source,
    summary: response.summary,
  };
}
