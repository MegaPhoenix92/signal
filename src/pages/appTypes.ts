import type {
  BackendCutoverDrillReport,
  BackendHandoffReport,
  BackendReadiness,
  CompletionAuditReport,
  DashboardAuditReport,
  DoctorReport,
  EmailHandoffReport,
  LocalAgentHandoffReport,
  LifecyclePlaybookReport,
  OnboardingReadinessReport,
  OperationsHealthReport,
  PaymentHandoffReport,
  PaymentLifecycleAuditReport,
  ProductionDrillReport,
  ProductionEnvAuditReport,
  ProductionSetupPlanReport,
  ProviderHandoffReport,
  ProviderLaunchMatrixReport,
  ProviderReadiness,
  ProviderSandboxReport,
  QaAnswersReport,
  SchedulerHandoffReport,
  SignalAppData,
  SignalDigestionPipelineReport,
  SignalMutationAction,
  StateSummary,
  TenantIsolationAuditReport,
} from '../signalData';

export type Accent = 'lime' | 'coral' | 'cyan' | 'gold';
export type AppMode = 'marketing' | 'register' | 'workspace' | 'admin';
export type AdminTab = 'dashboard' | 'organization' | 'email' | 'billing' | 'integrations' | 'platform' | 'launch' | 'audit' | 'cli';
export type AdminReportSection = AdminTab;
export type AdminSubRoute = 'tenants' | 'users' | 'governance' | 'signals' | 'accounts';
export type MutationOutcome = { ok: true } | { ok: false; error: string };
export type RegistrationFormErrors = Partial<Record<'workspaceName' | 'workspaceDomain' | 'adminEmail' | 'adminName' | 'inviteTenantId' | 'inviteEmail' | 'claimCode' | 'claimEmail' | 'form', string>>;
export type DataSource = 'api' | 'seed';

export type LiveState = {
  agentHandoff?: LocalAgentHandoffReport;
  completionAudit?: CompletionAuditReport;
  backendHandoff?: BackendHandoffReport;
  backendCutover?: BackendCutoverDrillReport;
  schedulerHandoff?: SchedulerHandoffReport;
  backendReadiness: BackendReadiness;
  data: SignalAppData;
  dashboardAudit: DashboardAuditReport;
  digestionPipeline?: SignalDigestionPipelineReport;
  lifecyclePlaybook?: LifecyclePlaybookReport;
  onboardingReadiness?: OnboardingReadinessReport;
  tenantIsolation?: TenantIsolationAuditReport;
  operationsHealth?: OperationsHealthReport;
  emailHandoff?: EmailHandoffReport;
  paymentHandoff?: PaymentHandoffReport;
  paymentLifecycle?: PaymentLifecycleAuditReport;
  providerHandoff?: ProviderHandoffReport;
  providerLaunch?: ProviderLaunchMatrixReport;
  productionEnv?: ProductionEnvAuditReport;
  productionPlan?: ProductionSetupPlanReport;
  productionDrill?: ProductionDrillReport;
  qaAnswers?: QaAnswersReport;
  doctor: DoctorReport;
  error: string | null;
  isLoading: boolean;
  isMutating: boolean;
  isValidatingSandbox: boolean;
  claimInvite: (args: Record<string, unknown>) => Promise<MutationOutcome>;
  lastUpdatedAt: string;
  lastMutation: string | null;
  loadAdminSection: (section: AdminReportSection) => Promise<void>;
  mutate: (action: SignalMutationAction, args: Record<string, unknown>) => Promise<MutationOutcome>;
  providerReadiness: ProviderReadiness;
  providerSandbox: ProviderSandboxReport | null;
  pollingIntervalMs: number;
  registerWorkspace: (args: Record<string, unknown>) => Promise<MutationOutcome>;
  refresh: () => Promise<void>;
  actorUserId: string;
  runScheduledValidation: (force?: boolean) => Promise<void>;
  sectionLoading: Partial<Record<AdminReportSection, boolean>>;
  setActorUserId: (userId: string) => Promise<void>;
  validateSandbox: () => Promise<void>;
  source: DataSource;
  summary: StateSummary;
};
