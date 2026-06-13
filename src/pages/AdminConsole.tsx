import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Clock3,
  CreditCard,
  Database,
  Fingerprint,
  Gauge,
  Inbox,
  Lightbulb,
  LockKeyhole,
  MailCheck,
  Plug,
  Radar,
  RefreshCw,
  Route,
  Settings2,
  ShieldCheck,
  TerminalSquare,
  UserCog,
  Users,
  WalletCards,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import {
  formatCurrency,
  formatPercent,
  ownerName,
  titleize,
  type BackendReadiness,
  type ProviderReadiness,
  type ProviderValidationSchedule,
  type SignalAppData,
  type StateSummary,
} from '../signalData';
import type { AdminSubRoute, AdminTab, LiveState } from './appTypes';
import {
  AdminTable,
  AccountEventRow,
  AccountRecommendationCard,
  AccountReviewCard,
  billingOverrideValue,
  CheckItem,
  CommandStrip,
  csvCell,
  DataRequestCard,
  DigestRunCard,
  downloadTextFile,
  EmailDeliveryCard,
  FlowCard,
  FlowRunCard,
  GovernancePolicyCard,
  IncidentNoteCard,
  InviteCard,
  InvoiceCard,
  JobCard,
  latestLocalIso,
  lifecycleNoticeRows,
  MailboxCard,
  membershipsForTenant,
  MutationButton,
  activeMembershipsForTenant,
  membershipForUser,
  MetricCard,
  InlineError,
  PanelHead,
  ProductHeader,
  ProviderReadinessCard,
  RedactionRuleCard,
  resolveTeamCheckoutPlanId,
  SeedReadOnlyCallout,
  SourceMessageCard,
  StateBanner,
  SuppressionRuleCard,
  tenantTeamUser,
  useRevealObserver,
  useMutationFeedback,
} from './appShared';

type AdminRoute = {
  tab: AdminTab;
  sub?: AdminSubRoute;
};

const adminContextTenantStorageKey = 'signal.admin.contextTenantId';

const adminTabs: Array<{ id: AdminTab; label: string; icon: LucideIcon }> = [
  { id: 'dashboard', label: 'Dashboard', icon: Gauge },
  { id: 'organization', label: 'Organization', icon: Users },
  { id: 'email', label: 'Email flows', icon: Workflow },
  { id: 'billing', label: 'Billing', icon: CreditCard },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'platform', label: 'Platform', icon: Activity },
  { id: 'launch', label: 'Launch readiness', icon: Route },
  { id: 'audit', label: 'Audit', icon: Fingerprint },
  { id: 'cli', label: 'CLI', icon: TerminalSquare },
];

const adminSubRoutes: Partial<Record<AdminTab, readonly AdminSubRoute[]>> = {
  organization: ['tenants', 'users'],
  platform: ['governance', 'signals', 'accounts'],
};

const platformSubRoutes: Array<{ id: AdminSubRoute; label: string }> = [
  { id: 'governance', label: 'Governance' },
  { id: 'signals', label: 'Signals' },
  { id: 'accounts', label: 'Accounts' },
];

const legacyAdminRoutes: Record<string, AdminRoute> = {
  overview: { tab: 'dashboard' },
  tenants: { tab: 'organization', sub: 'tenants' },
  users: { tab: 'organization', sub: 'users' },
  email: { tab: 'email' },
  governance: { tab: 'platform', sub: 'governance' },
  signals: { tab: 'platform', sub: 'signals' },
  accounts: { tab: 'platform', sub: 'accounts' },
  integrations: { tab: 'integrations' },
  payments: { tab: 'billing' },
  ops: { tab: 'launch' },
  audit: { tab: 'audit' },
  cli: { tab: 'cli' },
};

function isAdminTab(value: string): value is AdminTab {
  return adminTabs.some((tab) => tab.id === value);
}

function normalizeAdminRoute(route: AdminRoute): AdminRoute {
  const allowedSubRoutes = adminSubRoutes[route.tab] ?? [];
  if (route.sub && allowedSubRoutes.includes(route.sub)) {
    return route;
  }
  return { tab: route.tab };
}

function adminHashQuery(hash = window.location.hash) {
  const queryStart = hash.indexOf('?');
  if (queryStart < 0) {
    return new URLSearchParams();
  }
  const queryEnd = hash.indexOf('#', queryStart + 1);
  return new URLSearchParams(hash.slice(queryStart + 1, queryEnd < 0 ? undefined : queryEnd));
}

function getAdminTenantFromHash() {
  return adminHashQuery().get('tenant');
}

function readStoredAdminContextTenant() {
  try {
    return window.sessionStorage.getItem(adminContextTenantStorageKey);
  } catch {
    return null;
  }
}

function storeAdminContextTenant(tenantId: string) {
  try {
    window.sessionStorage.setItem(adminContextTenantStorageKey, tenantId);
  } catch {
    // Session storage can be unavailable in private or constrained browser contexts.
  }
}

function tenantExists(data: SignalAppData, tenantId?: string | null) {
  return Boolean(tenantId && data.tenants.some((tenant) => tenant.id === tenantId));
}

function fallbackAdminContextTenantId(data: SignalAppData, actorTenantId?: string) {
  return tenantExists(data, actorTenantId) ? actorTenantId ?? '' : data.tenants[0]?.id ?? '';
}

function getAdminRouteFromHash(): AdminRoute {
  const rawPath = window.location.hash.startsWith('#admin/')
    ? window.location.hash.slice('#admin/'.length).split(/[?#]/)[0]
    : '';
  const [rawTab = '', rawSub = ''] = rawPath.split('/');
  const legacyRoute = legacyAdminRoutes[rawTab];
  if (legacyRoute) {
    return legacyRoute;
  }
  if (!isAdminTab(rawTab)) {
    return { tab: 'dashboard' };
  }
  return normalizeAdminRoute({ tab: rawTab, sub: rawSub as AdminSubRoute });
}

function getAdminTabFromHash(): AdminTab {
  return getAdminRouteFromHash().tab;
}

function adminTabHash(tab: AdminTab, sub?: AdminSubRoute, tenantId?: string | null) {
  const base = sub ? `#admin/${tab}/${sub}` : `#admin/${tab}`;
  return tenantId ? `${base}?tenant=${encodeURIComponent(tenantId)}` : base;
}

function adminTabId(tab: AdminTab) {
  return `admin-tab-${tab}`;
}

function adminPanelId(tab: AdminTab) {
  return `admin-panel-${tab}`;
}

function AdminTabPanel({ activeTab, children, tab }: { activeTab: AdminTab; children?: ReactNode; tab: AdminTab }) {
  const selected = activeTab === tab;
  return (
    <section
      aria-labelledby={adminTabId(tab)}
      className="admin-tabpanel"
      hidden={!selected}
      id={adminPanelId(tab)}
      role="tabpanel"
      tabIndex={0}
    >
      {selected ? children : null}
    </section>
  );
}

function ReportLoadingPanel({ icon, title, wide = false }: { icon: LucideIcon; title: string; wide?: boolean }) {
  return (
    <article className={`ops-panel${wide ? ' wide-panel' : ''}`}>
      <PanelHead icon={icon} title={title} action="Loading..." />
      <div className="empty-state">
        <strong>Loading report...</strong>
      </div>
    </article>
  );
}

function modelEvidenceForTenant(data: SignalAppData, tenantId: string) {
  const tenantFlows = data.emailFlows.filter((flow) => flow.tenantId === tenantId);
  const tenantRoutingRules = (data.routingRules ?? []).filter((rule) => rule.tenantId === tenantId);
  const tenantSuppressionRules = (data.suppressionRules ?? []).filter((rule) => rule.tenantId === tenantId);
  const tenantFeedback = (data.signalFeedback ?? []).filter((feedback) => feedback.tenantId === tenantId);
  const tenantSignals = data.signals.filter((signal) => signal.tenantId === tenantId);
  const tenantSourceMessages = data.sourceMessages.filter((message) => message.tenantId === tenantId);
  const governancePolicy = data.governancePolicies.find((policy) => policy.tenantId === tenantId);
  return {
    activeRoutingRules: tenantRoutingRules.filter((rule) => rule.status === 'active').length,
    activeSuppressionRules: tenantSuppressionRules.filter((rule) => rule.status === 'active').length,
    enabledDetectorFlows: tenantFlows.filter((flow) => flow.status === 'enabled').length,
    feedbackLabels: tenantFeedback.length,
    generatedSignals: tenantSignals.filter((signal) => signal.sourceMessageId && signal.flowId).length,
    rawSnippetRetentionDays: governancePolicy?.rawSnippetRetentionDays ?? null,
    sourceMessages: tenantSourceMessages.length,
    sourceRetentionDays: governancePolicy?.sourceRetentionDays ?? null,
    totalDetectorFlows: tenantFlows.length,
  };
}

function productReadinessForAdmin(data: SignalAppData, summary: StateSummary, backendReadiness: BackendReadiness, providerReadiness: ProviderReadiness) {
  const latestProviderRun = [...(data.providerValidationRuns ?? [])].sort((left, right) => Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? ''))[0];
  const providerLiveReady = providerReadiness.ok && latestProviderRun?.status === 'passed';
  const rows = [
    {
      area: 'Onboarding',
      evidence: `${summary.activeMemberships ?? 0} active memberships · ${summary.pendingInvites ?? 0} pending invites · ${summary.activeEntitlements ?? 0} active entitlements`,
      gap: 'None for local flow',
      localOk: (summary.activeMemberships ?? 0) > 0 && (summary.activeEntitlements ?? 0) > 0,
      productionOk: true,
    },
    {
      area: 'RBAC + privacy',
      evidence: `${summary.admins} admin · ${summary.activeApiSessions ?? 0}/${summary.apiSessions ?? 0} active API sessions`,
      gap: backendReadiness.productionReady ? 'None' : 'Production tenant isolation and managed auth required',
      localOk: (summary.activeMemberships ?? 0) > 0,
      productionOk: backendReadiness.productionReady,
    },
    {
      area: 'Email + detectors',
      evidence: `${summary.connectedMailboxes}/${summary.mailboxes} sources · ${summary.enabledEmailFlows}/${summary.emailFlows} flows · ${summary.generatedSignals ?? 0} generated signals`,
      gap: 'None for local flow',
      localOk: summary.connectedMailboxes > 0 && summary.enabledEmailFlows > 0 && (summary.sourceMessages ?? 0) > 0,
      productionOk: true,
    },
    {
      area: 'Models',
      evidence: `${summary.modelGovernancePolicies ?? 0} policies · ${summary.perTenantModels ?? 0} per-org models · ${summary.signalFeedback ?? 0} feedback labels`,
      gap: 'Live learning pipeline remains opt-in future work',
      localOk: (summary.modelGovernancePolicies ?? 0) > 0 && (summary.perTenantModels ?? 0) === 0,
      productionOk: (summary.modelGovernancePolicies ?? 0) > 0 && (summary.perTenantModels ?? 0) === 0,
    },
    {
      area: 'Relationships',
      evidence: `${summary.accounts ?? 0} accounts · ${summary.openAccountActions ?? 0} actions · ${summary.openAccountRecommendations ?? 0}/${summary.accountRecommendations ?? 0} open recs`,
      gap: 'None for local flow',
      localOk: (summary.accounts ?? 0) > 0 && (summary.accountRecommendations ?? 0) > 0,
      productionOk: true,
    },
    {
      area: 'Notifications',
      evidence: `${summary.notificationPreferences ?? 0} preferences · ${summary.digestRuns ?? 0} digest runs · ${summary.failedEmailDeliveries ?? 0} failed deliveries`,
      gap: 'Live email provider validation required before production',
      localOk: (summary.notificationPreferences ?? 0) > 0,
      productionOk: providerLiveReady,
    },
    {
      area: 'Payments',
      evidence: `${summary.subscriptions} subscriptions · ${summary.activeEntitlements ?? 0} active entitlements · ${summary.paymentEvents} payment events`,
      gap: 'Live Stripe sandbox validation required before production',
      localOk: summary.subscriptions > 0 && (summary.activeEntitlements ?? 0) > 0,
      productionOk: providerLiveReady,
    },
    {
      area: 'Providers',
      evidence: `${providerReadiness.summary.readyProviders}/${providerReadiness.summary.totalProviders} provider groups ready · latest sandbox ${latestProviderRun?.status ?? 'not run'}`,
      gap: providerLiveReady ? 'None' : 'Run real sandbox credentials and save evidence',
      localOk: (data.providerValidationSchedules?.length ?? 0) >= 4,
      productionOk: providerLiveReady,
    },
    {
      area: 'Backend',
      evidence: `${backendReadiness.summary.readyChecks}/${backendReadiness.summary.totalChecks} production checks · mode ${backendReadiness.mode}`,
      gap: backendReadiness.productionReady ? 'None' : 'Configure durable storage, auth, CORS, tenant isolation, scheduler',
      localOk: true,
      productionOk: backendReadiness.productionReady,
    },
  ];
  return {
    localReady: rows.filter((row) => row.localOk).length,
    productionReady: rows.filter((row) => row.productionOk).length,
    rows,
    total: rows.length,
  };
}

function launchGateForAdmin(
  data: SignalAppData,
  summary: StateSummary,
  backendReadiness: BackendReadiness,
  providerReadiness: ProviderReadiness,
  productReadiness: ReturnType<typeof productReadinessForAdmin>,
) {
  const latestProviderRun = [...(data.providerValidationRuns ?? [])].sort((left, right) => Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? ''))[0];
  const backendFailed = backendReadiness.checks.filter((check) => !check.ok);
  const tenantIsolation = backendReadiness.checks.find((check) => check.id === 'tenant_isolation');
  const scheduler = backendReadiness.checks.find((check) => check.id === 'job_scheduler');
  const provider = (id: string) => providerReadiness.providers.find((item) => item.id === id);
  const gmail = provider('gmail');
  const outlook = provider('outlook');
  const outbound = provider('outbound-email');
  const stripe = provider('stripe');
  const providerSandboxPassed = latestProviderRun?.status === 'passed';
  const activeSchedules = data.providerValidationSchedules?.filter((schedule) => schedule.status === 'active').length ?? 0;
  const rows = [
    {
      blocker: productReadiness.localReady === productReadiness.total ? 'None' : 'Local readiness evidence missing',
      gate: 'Local product',
      owner: 'Product',
      requiredEnv: '-',
      status: productReadiness.localReady === productReadiness.total ? 'Pass' : 'Attention',
    },
    {
      blocker: backendReadiness.productionReady ? 'None' : backendFailed.map((check) => check.message).slice(0, 2).join(' · '),
      gate: 'Production backend',
      owner: 'Platform',
      requiredEnv: backendReadiness.summary.missingRequiredEnv.slice(0, 5).join(', ') || '-',
      status: backendReadiness.productionReady ? 'Pass' : 'Blocked',
    },
    {
      blocker: tenantIsolation?.ok ? 'None' : tenantIsolation?.message ?? 'Tenant isolation policy missing',
      gate: 'Tenant isolation',
      owner: 'Security',
      requiredEnv: tenantIsolation?.missingEnv.join(', ') || '-',
      status: tenantIsolation?.ok ? 'Pass' : 'Blocked',
    },
    {
      blocker: providerReadiness.ok ? 'None' : `${providerReadiness.summary.missingRequired} provider env var name(s) missing`,
      gate: 'Provider config',
      owner: 'Integrations',
      requiredEnv: providerReadiness.providers.flatMap((item) => item.missingRequired).slice(0, 5).join(', ') || '-',
      status: providerReadiness.ok ? 'Pass' : 'Blocked',
    },
    {
      blocker: providerSandboxPassed ? 'None' : `Latest sandbox evidence is ${latestProviderRun?.status ?? 'not recorded'}`,
      gate: 'Sandbox evidence',
      owner: 'Integrations',
      requiredEnv: 'SIGNAL_GMAIL_ACCESS_TOKEN, SIGNAL_OUTLOOK_ACCESS_TOKEN, SIGNAL_SENDGRID_API_KEY, STRIPE_SECRET_KEY',
      status: providerSandboxPassed ? 'Pass' : 'Blocked',
    },
    {
      blocker: gmail?.ready && outlook?.ready && outbound?.ready && providerSandboxPassed ? 'None' : 'Email providers and sandbox evidence must pass',
      gate: 'Email launch',
      owner: 'Integrations',
      requiredEnv: [gmail, outlook, outbound].flatMap((item) => item?.missingRequired ?? []).slice(0, 5).join(', ') || '-',
      status: gmail?.ready && outlook?.ready && outbound?.ready && providerSandboxPassed ? 'Pass' : 'Blocked',
    },
    {
      blocker: stripe?.ready && providerSandboxPassed ? 'None' : 'Stripe config, signed webhooks, and sandbox evidence must pass',
      gate: 'Payment launch',
      owner: 'Billing',
      requiredEnv: stripe?.missingRequired.join(', ') || '-',
      status: stripe?.ready && providerSandboxPassed ? 'Pass' : 'Blocked',
    },
    {
      blocker: scheduler?.ok && summary.failedJobs === 0 && activeSchedules >= 4 ? 'None' : 'Scheduler env, active validation schedules, or failed jobs need attention',
      gate: 'Scheduler ops',
      owner: 'Operations',
      requiredEnv: scheduler?.missingEnv.join(', ') || '-',
      status: scheduler?.ok && summary.failedJobs === 0 && activeSchedules >= 4 ? 'Pass' : 'Blocked',
    },
  ];
  const blocked = rows.filter((row) => row.status === 'Blocked').length;
  const attention = rows.filter((row) => row.status === 'Attention').length;
  return {
    attention,
    blocked,
    goLiveReady: blocked === 0 && attention === 0,
    rows,
    secretSafe: rows.every((row) => !/(sk_live_|sk_test_|password=|secret=|token=)/i.test(row.requiredEnv)),
  };
}

function prioritySortValue(priority: 'critical' | 'high' | 'medium' | 'low') {
  return {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  }[priority];
}

export function AdminConsole({ liveState }: { liveState: LiveState }) {
  const {
    agentHandoff,
    completionAudit,
    backendHandoff,
    backendCutover,
    schedulerHandoff,
    actorUserId,
    backendReadiness,
    data,
    dashboardAudit,
    digestionPipeline,
    doctor: doctorReport,
    error,
    isLoading,
    isMutating,
    isValidatingSandbox,
    lifecyclePlaybook,
    lastMutation,
    loadAdminSection,
    mutate,
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
    providerReadiness,
    providerSandbox,
    refresh,
    runScheduledValidation,
    sectionLoading,
    setActorUserId,
    source,
    summary,
    validateSandbox,
  } = liveState;
  const currentActor = data.users.find((user) => user.id === actorUserId) ?? data.users[0];
  const [activeRoute, setActiveRoute] = useState<AdminRoute>(() => getAdminRouteFromHash());
  const activeTab = activeRoute.tab;
  const [contextTenantId, setContextTenantId] = useState(() => {
    const hashTenantId = getAdminTenantFromHash();
    const storedTenantId = readStoredAdminContextTenant();
    return tenantExists(data, hashTenantId)
      ? hashTenantId ?? ''
      : tenantExists(data, storedTenantId)
        ? storedTenantId ?? ''
        : fallbackAdminContextTenantId(data, currentActor?.tenantId);
  });
  const adminTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [tenantSearch, setTenantSearch] = useState('');
  const [tenantStatusFilter, setTenantStatusFilter] = useState('all');
  const [tenantPlanFilter, setTenantPlanFilter] = useState('all');
  const [selectedTenantIds, setSelectedTenantIds] = useState<string[]>([]);
  const [signalStatusFilter, setSignalStatusFilter] = useState('all');
  const [signalOwnerFilter, setSignalOwnerFilter] = useState('all');
  const [signalFlowFilter, setSignalFlowFilter] = useState('all');
  const [selectedOperatorAccountId, setSelectedOperatorAccountId] = useState('');
  const [accountReviewNote, setAccountReviewNote] = useState('Admin operator review');
  const [auditActorFilter, setAuditActorFilter] = useState('all');
  const [auditActionFilter, setAuditActionFilter] = useState('all');
  const [auditTextFilter, setAuditTextFilter] = useState('');
  const [selectedDeadLetterIds, setSelectedDeadLetterIds] = useState<string[]>([]);
  const mutationFeedback = useMutationFeedback(mutate);
  useRevealObserver([activeTab, activeRoute.sub ?? '']);

  useEffect(() => {
    void loadAdminSection(activeTab);
  }, [activeTab, data, loadAdminSection]);

  useEffect(() => {
    const syncAdminRoute = () => {
      const route = getAdminRouteFromHash();
      const hashTenantId = getAdminTenantFromHash();
      const validHashTenantId = tenantExists(data, hashTenantId) ? hashTenantId : null;
      const nextHash = adminTabHash(route.tab, route.sub, validHashTenantId);
      setActiveRoute(route);
      if (validHashTenantId && validHashTenantId !== contextTenantId) {
        setContextTenantId(validHashTenantId);
        storeAdminContextTenant(validHashTenantId);
      }
      if (window.location.hash.startsWith('#admin/') && window.location.hash !== nextHash) {
        window.history.replaceState(null, '', nextHash);
      }
    };
    const onHashChange = () => syncAdminRoute();
    syncAdminRoute();
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [contextTenantId, data]);

  useEffect(() => {
    if (tenantExists(data, contextTenantId)) {
      return;
    }
    const fallbackTenantId = fallbackAdminContextTenantId(data, currentActor?.tenantId);
    if (fallbackTenantId) {
      setContextTenantId(fallbackTenantId);
      storeAdminContextTenant(fallbackTenantId);
    }
  }, [contextTenantId, currentActor?.tenantId, data]);

  // Reset operator-panel filters/selection when the admin context tenant changes.
  // Owner/flow filters hold ids scoped to the previous tenant; without this reset a
  // stale filter would silently filter the new tenant's signals to an empty list (#82/#89 review).
  useEffect(() => {
    setSignalStatusFilter('all');
    setSignalOwnerFilter('all');
    setSignalFlowFilter('all');
    setSelectedOperatorAccountId('');
    setAccountReviewNote('Admin operator review');
  }, [contextTenantId]);

  function selectAdminTab(tab: AdminTab, sub?: AdminSubRoute, focus = false) {
    const route = normalizeAdminRoute({ tab, sub });
    setActiveRoute(route);
    const nextHash = adminTabHash(route.tab, route.sub, contextTenantId);
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
    if (focus) {
      const nextIndex = adminTabs.findIndex((item) => item.id === route.tab);
      window.requestAnimationFrame(() => adminTabRefs.current[nextIndex]?.focus());
    }
  }

  function handleAdminTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const lastIndex = adminTabs.length - 1;
    const nextIndexByKey: Partial<Record<string, number>> = {
      ArrowDown: index === lastIndex ? 0 : index + 1,
      ArrowRight: index === lastIndex ? 0 : index + 1,
      ArrowUp: index === 0 ? lastIndex : index - 1,
      ArrowLeft: index === 0 ? lastIndex : index - 1,
      Home: 0,
      End: lastIndex,
    };
    const nextIndex = nextIndexByKey[event.key];
    if (nextIndex === undefined) {
      return;
    }
    event.preventDefault();
    selectAdminTab(adminTabs[nextIndex].id, undefined, true);
  }

  function selectAdminContextTenant(tenantId: string) {
    if (!tenantExists(data, tenantId)) {
      return;
    }
    setContextTenantId(tenantId);
    storeAdminContextTenant(tenantId);
    const nextHash = adminTabHash(activeRoute.tab, activeRoute.sub, tenantId);
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, '', nextHash);
    }
  }

  const tenant = data.tenants.find((item) => item.id === contextTenantId) ?? data.tenants.find((item) => item.id === currentActor?.tenantId) ?? data.tenants[0];
  if (!currentActor || !tenant) {
    return (
      <div className="product-shell admin-shell">
        <ProductHeader active="admin" />
        <main className="product-main">
          <StateBanner actorUserId={actorUserId} data={data} error={error} isLoading={isLoading} isMutating={isMutating} lastMutation={lastMutation} onActorChange={setActorUserId} onRefresh={refresh} source={source} summary={summary} />
          {source === 'seed' && <SeedReadOnlyCallout area="admin" />}
          <section className="ops-panel empty-state" data-reveal>
            <h3>Admin data unavailable</h3>
            <p>The live API returned no tenant or user records for the admin view.</p>
            <small>Refresh after creating an admin-backed tenant, or use the local seeded state until the backend is populated.</small>
            <div className="button-row">
              <a className="inline-action" href="#register">Register workspace</a>
              <a className="inline-action" href="#top">Return to public site</a>
            </div>
          </section>
        </main>
      </div>
    );
  }
  const plan = data.plans.find((item) => item.id === tenant.planId);
  const tenantUsers = data.users.filter((user) => user.tenantId === tenant.id);
  const tenantActiveUsers = tenantUsers.filter((user) => user.status === 'active');
  const tenantAdminUser = tenantUsers.find((user) => user.role === 'admin' && user.status === 'active') ?? tenantActiveUsers[0] ?? tenantUsers[0];
  const salesDemoUser = tenantTeamUser(tenantUsers, tenant.id, 'sales');
  const productDemoUser = tenantTeamUser(tenantUsers, tenant.id, 'product');
  const tenantMailboxes = data.mailboxes.filter((mailbox) => mailbox.tenantId === tenant.id);
  const tenantEmailFlows = data.emailFlows.filter((flow) => flow.tenantId === tenant.id);
  const tenantFlowRuns = (data.flowRuns ?? []).filter((run) => run.tenantId === tenant.id);
  const tenantSourceMessages = (data.sourceMessages ?? []).filter((message) => message.tenantId === tenant.id);
  const tenantSignals = data.signals.filter((signal) => signal.tenantId === tenant.id);
  const tenantSignalHandoffs = (data.signalHandoffs ?? []).filter((handoff) => handoff.tenantId === tenant.id);
  const tenantAccountProfiles = (data.accountProfiles ?? []).filter((account) => account.tenantId === tenant.id);
  const tenantAccountRecommendations = (data.accountRecommendations ?? []).filter((recommendation) => recommendation.tenantId === tenant.id);
  const tenantAccountActions = (data.accountActions ?? []).filter((action) => action.tenantId === tenant.id);
  const tenantAccountEvents = (data.accountEvents ?? []).filter((event) => event.tenantId === tenant.id);
  const tenantAccountReviews = (data.accountReviews ?? []).filter((review) => review.tenantId === tenant.id);
  const tenantSubscriptionsForContext = data.subscriptions.filter((item) => item.tenantId === tenant.id);
  const tenantBillingSessions = data.billingSessions.filter((session) => session.tenantId === tenant.id);
  const tenantBillingOverrides = (data.billingOverrides ?? []).filter((override) => override.tenantId === tenant.id);
  const tenantInvoices = (data.invoices ?? []).filter((invoice) => invoice.tenantId === tenant.id);
  const tenantPaymentEventsForContext = data.paymentEvents.filter((event) => event.tenantId === tenant.id);
  const tenantLifecycleNoticesForContext = (data.lifecycleNotices ?? []).filter((notice) => notice.tenantId === tenant.id);
  const tenantNotificationEvents = (data.notificationEvents ?? []).filter((event) => event.tenantId === tenant.id);
  const tenantDigestRuns = (data.notificationDigestRuns ?? []).filter((run) => run.tenantId === tenant.id);
  const tenantEmailDeliveries = (data.emailDeliveryMessages ?? []).filter((message) => message.tenantId === tenant.id);
  const tenantNotificationPreferences = (data.notificationPreferences ?? []).filter((preference) => preference.tenantId === tenant.id);
  const tenantSuppressionRules = (data.suppressionRules ?? []).filter((rule) => rule.tenantId === tenant.id);
  const tenantSignalFeedback = (data.signalFeedback ?? []).filter((feedback) => feedback.tenantId === tenant.id);
  const tenantRedactionRules = (data.redactionRules ?? []).filter((rule) => rule.tenantId === tenant.id);
  const tenantDataRequests = (data.dataRequests ?? []).filter((request) => request.tenantId === tenant.id);
  const tenantIncidentNotes = (data.incidentNotes ?? []).filter((note) => note.tenantId === tenant.id);
  const tenantInvites = (data.invites ?? []).filter((invite) => invite.tenantId === tenant.id);
  const checkoutTeamPlanId = resolveTeamCheckoutPlanId(data, tenant.planId);
  const subscription = tenantSubscriptionsForContext[0];
  const reauthCount = tenantMailboxes.filter((mailbox) => mailbox.status === 'needs_reauth').length;
  const enabledFlows = tenantEmailFlows.filter((flow) => flow.status === 'enabled').length;
  const routingRules = [...(data.routingRules ?? [])].filter((rule) => rule.tenantId === tenant.id).sort((left, right) => Date.parse(right.updatedAt ?? right.createdAt ?? '') - Date.parse(left.updatedAt ?? left.createdAt ?? ''));
  const routingRuleForFlow = (flowId: string) => routingRules.find((rule) => rule.flowId === flowId && rule.status === 'active') ?? routingRules.find((rule) => rule.flowId === flowId);
  const entitlement = data.entitlements.find((item) => item.tenantId === tenant.id);
  const latestBillingSessions = [...tenantBillingSessions].slice(-5).reverse();
  const billingOverrides = [...tenantBillingOverrides].sort((left, right) => Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? ''));
  const activeBillingOverrides = billingOverrides.filter((override) => override.status === 'active');
  const recentInvoices = [...tenantInvoices].slice(-5).reverse();
  const recoverableInvoices = tenantInvoices.filter((invoice) => ['open', 'past_due'].includes(invoice.status));
  const recentPaymentEvents = [...tenantPaymentEventsForContext].slice(-5).reverse();
  const failedJobs = data.jobs.filter((job) => job.status === 'failed');
  const queuedJobs = data.jobs.filter((job) => ['queued', 'running'].includes(job.status));
  const queuedSignalHandoffJobs = queuedJobs.filter((job) => job.queue === 'signal_handoff');
  const providerValidationJobs = data.jobs.filter((job) => job.queue === 'provider_validation');
  const queuedProviderValidationJobs = queuedJobs.filter((job) => job.queue === 'provider_validation');
  const mailboxSessionsDescending = [...data.mailboxConnectionSessions].filter((session) => session.tenantId === tenant.id).reverse();
  const latestMailboxSessions = mailboxSessionsDescending.slice(0, 4);
  const latestSessionForMailbox = (mailboxId: string) => mailboxSessionsDescending.find((session) => session.mailboxId === mailboxId);
  const mailboxWatchesDescending = [...(data.emailWatchSubscriptions ?? [])].filter((watch) => watch.tenantId === tenant.id).reverse();
  const latestWatchForMailbox = (mailboxId: string) => mailboxWatchesDescending.find((watch) => watch.mailboxId === mailboxId);
  const latestFlowRuns = [...tenantFlowRuns].slice(-5).reverse();
  const latestSourceMessages = [...tenantSourceMessages].slice(-5).reverse();
  const generatedSignals = tenantSignals.filter((signal) => signal.sourceMessageId && signal.flowId);
  const unreadNotifications = tenantNotificationEvents.filter((event) => event.status === 'unread');
  const mutedNotifications = tenantNotificationEvents.filter((event) => event.status === 'muted');
  const latestDigestRuns = [...tenantDigestRuns].slice(-5).reverse();
  const latestEmailDeliveries = [...tenantEmailDeliveries].slice(-6).reverse();
  const queuedEmailDeliveries = tenantEmailDeliveries.filter((message) => message.status === 'queued');
  const failedEmailDeliveries = tenantEmailDeliveries.filter((message) => ['failed', 'bounced'].includes(message.status));
  const apiSessions = [...(data.apiSessions ?? [])].sort((left, right) => Date.parse(right.issuedAt ?? '') - Date.parse(left.issuedAt ?? ''));
  const activeApiSessions = apiSessions.filter((session) => session.status === 'active');
  const revokedApiSessions = apiSessions.filter((session) => session.status === 'revoked');
  const providerValidationRuns = [...(data.providerValidationRuns ?? [])].sort((left, right) => Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? ''));
  const providerValidationSchedules = [...(data.providerValidationSchedules ?? [])].sort((left, right) => String(left.providerId).localeCompare(String(right.providerId))) as ProviderValidationSchedule[];
  const dueProviderValidationSchedules = providerValidationSchedules.filter((schedule) => {
    if (schedule.status !== 'active' || schedule.cadence === 'manual' || !schedule.nextRunAt) {
      return false;
    }
    const nextRunMs = Date.parse(schedule.nextRunAt);
    return Number.isFinite(nextRunMs) && nextRunMs <= Date.now();
  });
  const pendingInvites = tenantInvites.filter((invite) => invite.status === 'pending');
  const recentInvites = [...tenantInvites].slice(-6).reverse();
  const qualitySettings = data.signalQualitySettings?.find((settings) => settings.tenantId === tenant.id);
  const suppressionRules = tenantSuppressionRules;
  const latestFeedback = [...tenantSignalFeedback].slice(-6).reverse();
  const modelGovernancePolicy = data.modelGovernancePolicies?.find((policy) => policy.tenantId === tenant.id);
  const modelGovernanceEvidence = modelGovernancePolicy ? modelEvidenceForTenant(data, tenant.id) : null;
  const governancePolicy = data.governancePolicies?.find((policy) => policy.tenantId === tenant.id);
  const activeRedactionRules = tenantRedactionRules.filter((rule) => rule.status === 'active');
  const latestDataRequests = [...tenantDataRequests].slice(-6).reverse();
  const activeDataRequests = tenantDataRequests.filter((request) => ['open', 'processing'].includes(request.status));
  const latestIncidentNotes = [...tenantIncidentNotes].slice(-6).reverse();
  const openIncidentNotes = tenantIncidentNotes.filter((note) => note.status === 'open');
  const tenantMemberships = membershipsForTenant(data, tenant.id);
  const activeTenantMemberships = activeMembershipsForTenant(data, tenant.id);
  const activeSeats = activeTenantMemberships.length || tenantActiveUsers.length;
  const pendingInviteSeats = pendingInvites.length;
  const seatLimit = entitlement?.seatLimit ?? plan?.seatLimit ?? null;
  const seatsAvailable = seatLimit === null ? null : Math.max(0, seatLimit - activeSeats - pendingInviteSeats);
  const tenantSuspended = tenant.status === 'suspended';
  const tenantPlans = new Map(data.plans.map((item) => [item.id, item]));
  const tenantSubscriptions = new Map(data.subscriptions.map((item) => [item.tenantId, item]));
  const tenantEntitlements = new Map(data.entitlements.map((item) => [item.tenantId, item]));
  const tenantRows = data.tenants.map((item) => {
    const tenantPlan = tenantPlans.get(item.planId);
    const tenantSubscription = tenantSubscriptions.get(item.id);
    const tenantEntitlement = tenantEntitlements.get(item.id);
    const tenantActiveSeats = activeMembershipsForTenant(data, item.id).length || data.users.filter((user) => user.tenantId === item.id && user.status === 'active').length;
    const tenantPendingInvites = (data.invites ?? []).filter((invite) => invite.tenantId === item.id && invite.status === 'pending').length;
    const tenantNotices = (data.lifecycleNotices ?? []).filter((notice) => notice.tenantId === item.id && notice.status === 'open');
    const tenantJobs = data.jobs.filter((job) => job.tenantId === item.id);
    const tenantPaymentEvents = data.paymentEvents.filter((event) => event.tenantId === item.id);
    const tenantMailboxUpdates = data.mailboxes.filter((mailbox) => mailbox.tenantId === item.id).map((mailbox) => mailbox.updatedAt ?? mailbox.createdAt);
    const lastActivity = [
      item.statusUpdatedAt,
      item.domainUpdatedAt,
      item.onboardingCompletedAt,
      latestLocalIso(tenantJobs as Array<Record<string, unknown>>, ['lastRunAt', 'nextRunAt']),
      latestLocalIso(tenantPaymentEvents as Array<Record<string, unknown>>, ['createdAt', 'signatureVerifiedAt']),
      ...tenantMailboxUpdates,
    ].filter((value) => Number.isFinite(Date.parse(String(value ?? '')))).sort().at(-1) ?? item.createdAt ?? null;
    return {
      activeSeats: tenantActiveSeats,
      lastActivity,
      notices: tenantNotices,
      plan: tenantPlan,
      pendingInvites: tenantPendingInvites,
      seatLimit: tenantEntitlement?.seatLimit ?? tenantPlan?.seatLimit ?? null,
      subscription: tenantSubscription,
      tenant: item,
    };
  });
  const visibleTenantRows = tenantRows.filter((row) => {
    const query = tenantSearch.trim().toLowerCase();
    const matchesSearch = !query || [row.tenant.name, row.tenant.domain, row.tenant.id].some((value) => value.toLowerCase().includes(query));
    const matchesStatus = tenantStatusFilter === 'all' || row.tenant.status === tenantStatusFilter;
    const matchesPlan = tenantPlanFilter === 'all' || row.tenant.planId === tenantPlanFilter;
    return matchesSearch && matchesStatus && matchesPlan;
  });
  const selectedTenantRow = tenantRows.find((row) => row.tenant.id === tenant.id) ?? tenantRows.find((row) => selectedTenantIds.includes(row.tenant.id)) ?? visibleTenantRows[0] ?? tenantRows[0] ?? null;
  const lifecycleNotices = tenantLifecycleNoticesForContext;
  const openLifecycleNotices = lifecycleNotices.filter((notice) => notice.status === 'open');
  const paymentLifecycleNotices = lifecycleNotices.filter((notice) => notice.category === 'payment' || notice.category === 'access' || notice.category === 'onboarding');
  const sourceLifecycleNotices = lifecycleNotices.filter((notice) => ['source', 'provider', 'notification'].includes(notice.category));
  const activePlatformSubRoute = activeRoute.sub;
  const platformSubRoute: AdminSubRoute = activeTab === 'platform' && activePlatformSubRoute && platformSubRoutes.some((route) => route.id === activePlatformSubRoute)
    ? activePlatformSubRoute
    : 'governance';
  const signalOwnerOptions = tenantActiveUsers.length ? tenantActiveUsers : tenantUsers;
  const visibleOperatorSignals = tenantSignals.filter((signal) => {
    const matchesStatus = signalStatusFilter === 'all' || signal.status === signalStatusFilter;
    const matchesOwner = signalOwnerFilter === 'all' || signal.ownerUserId === signalOwnerFilter;
    const matchesFlow = signalFlowFilter === 'all' || (signal.flowId ?? 'none') === signalFlowFilter;
    return matchesStatus && matchesOwner && matchesFlow;
  });
  const selectedOperatorAccount = tenantAccountProfiles.find((account) => account.id === selectedOperatorAccountId) ?? tenantAccountProfiles[0] ?? null;
  const selectedAccountActions = selectedOperatorAccount
    ? [...tenantAccountActions].filter((action) => action.account === selectedOperatorAccount.name).sort((left, right) => Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? ''))
    : [];
  const selectedAccountRecommendations = selectedOperatorAccount
    ? [...tenantAccountRecommendations].filter((recommendation) => recommendation.account === selectedOperatorAccount.name).sort((left, right) => prioritySortValue(right.priority) - prioritySortValue(left.priority))
    : [];
  const selectedAccountEvents = selectedOperatorAccount
    ? [...tenantAccountEvents].filter((event) => event.account === selectedOperatorAccount.name).sort((left, right) => Date.parse(right.occurredAt ?? '') - Date.parse(left.occurredAt ?? ''))
    : [];
  const selectedAccountReviews = selectedOperatorAccount
    ? [...tenantAccountReviews].filter((review) => review.account === selectedOperatorAccount.name).sort((left, right) => Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? ''))
    : [];
  const canUseAdminMutations = source === 'api' && !isMutating;
  const auditEvents = [...(data.auditEvents ?? [])].sort((left, right) => Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? ''));
  const auditActors = [...new Set(auditEvents.map((event) => event.actor).filter(Boolean))].sort();
  const auditActions = [...new Set(auditEvents.map((event) => event.action).filter(Boolean))].sort();
  const visibleAuditEvents = auditEvents.filter((event) => {
    const query = auditTextFilter.trim().toLowerCase();
    const actorName = ownerName(data.users, event.actor);
    const matchesActor = auditActorFilter === 'all' || event.actor === auditActorFilter;
    const matchesAction = auditActionFilter === 'all' || event.action === auditActionFilter;
    const matchesText = !query || [event.id, event.action, event.targetId, event.message, event.actor, actorName].some((value) => String(value ?? '').toLowerCase().includes(query));
    return matchesActor && matchesAction && matchesText;
  });
  const deadLetterJobs = data.deadLetter ?? [];
  const webhookOutcomeRows = [...(data.webhookEvents ?? [])]
    .sort((left, right) => Date.parse(right.receivedAt ?? '') - Date.parse(left.receivedAt ?? ''))
    .slice(0, 12)
    .map((event) => [
      titleize(event.provider),
      event.accepted ? 'Accepted' : 'Rejected',
      event.eventType,
      event.status === null || event.status === undefined ? '-' : String(event.status),
      event.reason ?? '-',
      new Date(event.receivedAt).toLocaleString(),
    ]);
  const productReadiness = productReadinessForAdmin(data, summary, backendReadiness, providerReadiness);
  const launchGate = launchGateForAdmin(data, summary, backendReadiness, providerReadiness, productReadiness);
  const operationsWebhookRows = operationsHealth?.webhooks.map((row) => [
    titleize(row.channel),
    titleize(row.status),
    row.path,
    row.evidence.join(' | '),
    row.latestAt ? new Date(row.latestAt).toLocaleString() : '-',
  ]) ?? [];
  const operationsQueueRows = operationsHealth?.queues.map((row) => [
    row.queue,
    titleize(row.status),
    `${row.total} total`,
    `${row.queued} queued / ${row.running} running`,
    `${row.failed} failed / ${row.deadLetter ?? 0} DLQ`,
  ]) ?? [];
  const activeBackoffRows = operationsHealth?.rateLimits.filter((row) => row.active).map((row) => [
    row.provider,
    row.kind,
    row.targetId,
    row.retryAfterAt ? new Date(row.retryAfterAt).toLocaleString() : '-',
    row.reason,
  ]) ?? [];
  const operationsLifecycleRows = operationsHealth?.lifecycle.categories.map((row) => [
    titleize(row.category),
    titleize(row.status),
    `${row.open} open`,
    `${row.critical} critical`,
    row.latestAt ? new Date(row.latestAt).toLocaleString() : '-',
  ]) ?? [];
  const productionDrillRows = productionDrill?.rows.map((row) => [
    titleize(row.area),
    titleize(row.status),
    titleize(row.owner),
    row.requiredEnv.length ? row.requiredEnv.slice(0, 4).join(', ') : '-',
    row.commands[0] ?? '-',
  ]) ?? [];
  const productionPlanRows = productionPlan?.rows.map((row) => [
    row.phase,
    titleize(row.status),
    titleize(row.owner),
    row.requiredEnv.length ? row.requiredEnv.slice(0, 4).join(', ') : '-',
    row.blockers[0] ?? row.completionCriteria[0] ?? '-',
    row.commands[0] ?? '-',
  ]) ?? [];
  const productionEnvRows = productionEnv?.rows.map((row) => [
    row.label,
    titleize(row.status),
    titleize(row.owner),
    `${row.configuredRequired.length}/${row.requiredEnv.length}`,
    row.missingRequired.length ? row.missingRequired.slice(0, 4).join(', ') : '-',
    row.templateMissing.length ? row.templateMissing.slice(0, 4).join(', ') : 'Covered',
    row.commands[0] ?? '-',
  ]) ?? [];
  const providerLaunchRows = providerLaunch?.rows.map((row) => [
    row.label,
    titleize(row.status),
    titleize(row.owner),
    row.configurationReady ? 'Configured' : `${row.missingEnv.length} env missing`,
    row.sandboxRequired ? titleize(row.sandboxStatus) : 'Not required',
    row.launchCommands[0] ?? row.evidenceCommands[0] ?? '-',
  ]) ?? [];
  const providerHandoffRows = providerHandoff?.actions.map((row) => [
    String(row.priority),
    row.providerId,
    row.label,
    titleize(row.status),
    titleize(row.owner),
    row.requiredEnv.length ? row.requiredEnv.slice(0, 4).join(', ') : '-',
    row.command,
  ]) ?? [];
  const lifecyclePlaybookRows = lifecyclePlaybook?.rows.map((row) => [
    row.label,
    titleize(row.status),
    titleize(row.owner),
    `${row.open} open / ${row.critical} critical`,
    row.adminAction,
    row.commands[0] ?? '-',
  ]) ?? [];
  const emailHandoffRows = emailHandoff?.rows.map((row) => [
    String(row.priority),
    row.label,
    titleize(row.status),
    titleize(row.owner),
    row.missingEnv.length ? row.missingEnv.slice(0, 4).join(', ') : '-',
    row.blocker,
    row.command,
    row.rollbackCommand ?? '-',
  ]) ?? [];
  const paymentHandoffRows = paymentHandoff?.rows.map((row) => [
    String(row.priority),
    row.label,
    titleize(row.status),
    titleize(row.owner),
    row.missingEnv.length ? row.missingEnv.slice(0, 4).join(', ') : '-',
    row.blocker,
    row.command,
    row.rollbackCommand ?? '-',
  ]) ?? [];
  const qaAnswerRows = qaAnswers?.rows.map((row) => [
    row.question,
    titleize(row.status),
    titleize(row.owner),
    row.localOk ? 'Ready' : 'Attention',
    row.productionOk ? 'Ready' : row.productionCaveat,
    row.commands[0] ?? '-',
  ]) ?? [];
  const completionAuditRows = completionAudit?.rows.map((row) => [
    row.label,
    titleize(row.status),
    titleize(row.owner),
    row.localOk ? 'Complete' : 'Attention',
    row.productionOk ? 'Ready' : 'Needs proof',
    row.blockers[0] ?? '-',
    row.commands[0] ?? '-',
  ]) ?? [];
  const localAgentHandoffRows = agentHandoff ? (agentHandoff.nextActions.length ? agentHandoff.nextActions : [agentHandoff.nextAction]).map((row) => [
    String(row.priority),
    row.label,
    titleize(row.status),
    titleize(row.owner),
    row.requiredEnv.length ? row.requiredEnv.slice(0, 4).join(', ') : '-',
    row.blocker,
    row.command,
  ]) : [];
  const backendHandoffRows = backendHandoff ? (backendHandoff.actions.length ? backendHandoff.actions : [backendHandoff.nextAction]).map((row) => [
    String(row.priority),
    row.label,
    titleize(row.status),
    titleize(row.owner),
    row.requiredEnv.length ? row.requiredEnv.slice(0, 4).join(', ') : '-',
    row.blocker,
    row.command,
  ]) : [];
  const backendCutoverRows = backendCutover?.rows.map((row) => [
    String(row.priority),
    row.label,
    titleize(row.status),
    titleize(row.owner),
    row.missingEnv.length ? row.missingEnv.slice(0, 4).join(', ') : '-',
    row.command,
    row.rollbackCommand ?? '-',
  ]) ?? [];
  const schedulerHandoffRows = schedulerHandoff?.rows.map((row) => [
    String(row.priority),
    row.label,
    titleize(row.status),
    titleize(row.owner),
    row.missingEnv.length ? row.missingEnv.slice(0, 4).join(', ') : '-',
    row.blocker,
    row.command,
    row.rollbackCommand ?? '-',
  ]) ?? [];

  if (currentActor?.role !== 'admin') {
    return (
      <div className="product-shell admin-shell">
        <ProductHeader active="admin" />
        <main className="product-main">
          <StateBanner actorUserId={actorUserId} data={data} error={error} isLoading={isLoading} isMutating={isMutating} lastMutation={lastMutation} onActorChange={setActorUserId} onRefresh={refresh} source={source} summary={summary} />
          {source === 'seed' && <SeedReadOnlyCallout area="admin" />}
          <section className="admin-hero access-denied-panel">
            <div>
              <p className="kicker">
                <LockKeyhole size={18} aria-hidden="true" />
                Admin access
              </p>
              <h1>Admin controls require an admin session.</h1>
              <p>
                {currentActor.name} is signed in as a {currentActor.role}. User workspace access remains available, but local management actions for users, email flows, payments, jobs, and source governance stay hidden.
              </p>
              <div className="button-row">
                <a className="button button-secondary" href="#workspace">
                  <Activity size={18} aria-hidden="true" />
                  <span>Open workspace</span>
                </a>
                <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => void setActorUserId('usr_admin')}>
                  Switch to admin
                </button>
              </div>
            </div>
            <div className="admin-summary-card">
              <span>Current session</span>
              <strong>{currentActor.name}</strong>
              <small>{currentActor.email} · {currentActor.role}</small>
            </div>
          </section>
          <section className="ops-panel cli-panel is-visible" data-reveal>
            <PanelHead icon={TerminalSquare} title="Local session CLI" action="Agent handoff" />
            <p>
              Local agents can switch the active session explicitly before opening the admin console or running scoped API checks.
            </p>
            <div className="cli-grid">
              {[
                'npm run admin -- session',
                'npm run admin -- session switch usr_admin',
                'npm run admin -- session switch usr_product',
                'SIGNAL_SESSION_SECRET=<local-session-secret> npm run admin -- session token usr_admin --json',
                'curl -H "Authorization: Bearer <token>" http://127.0.0.1:8787/api/session',
              ].map((command) => (
                <code key={command}>{command}</code>
              ))}
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="product-shell admin-shell">
      <ProductHeader active="admin" />
      <main className="product-main">
        <StateBanner
          actorUserId={actorUserId}
          contextTenantId={tenant.id}
          data={data}
          error={error}
          isLoading={isLoading}
          isMutating={isMutating}
          lastMutation={lastMutation}
          onActorChange={setActorUserId}
          onContextTenantChange={selectAdminContextTenant}
          onRefresh={refresh}
          source={source}
          summary={summary}
        />
        {source === 'seed' && <SeedReadOnlyCallout area="admin" />}
        <section className="admin-hero" data-reveal>
          <div>
            <p className="kicker">
              <ShieldCheck size={18} aria-hidden="true" />
              Admin console
            </p>
            <h1>Manage users, email flows, and payments locally.</h1>
            <p>
              This console mirrors the local admin CLI so your local agent can manage application state while operators review users, source health, signal rules, and billing posture.
            </p>
          </div>
          <div className="admin-summary-card">
            <span>{tenant.domain}</span>
            <strong>{titleize(tenant.status)}</strong>
            <small>{subscription?.status ? `${titleize(subscription.status)} subscription` : plan ? `${plan.name} · ${formatCurrency(plan.monthlyCents)}/mo` : 'Plan missing'}</small>
          </div>
        </section>

        <div className="admin-console-layout">
          <aside className="admin-sidebar" aria-label="Admin navigation">
            <section className="admin-tabbar" role="tablist" aria-label="Admin sections" aria-orientation="vertical">
              {adminTabs.map((tab, index) => {
                const Icon = tab.icon;
                return (
                  <button
                    aria-controls={adminPanelId(tab.id)}
                    aria-selected={activeTab === tab.id}
                    className="admin-tab"
                    id={adminTabId(tab.id)}
                    key={tab.id}
                    onClick={() => selectAdminTab(tab.id)}
                    onKeyDown={(event) => handleAdminTabKeyDown(event, index)}
                    ref={(node) => {
                      adminTabRefs.current[index] = node;
                    }}
                    role="tab"
                    tabIndex={activeTab === tab.id ? 0 : -1}
                    type="button"
                  >
                    <Icon size={18} aria-hidden="true" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </section>
          </aside>
          <div className="admin-panel-region">
            {adminTabs.filter((tab) => tab.id !== activeTab).map((tab) => (
              <AdminTabPanel activeTab={activeTab} key={tab.id} tab={tab.id} />
            ))}
            <section
              aria-labelledby={adminTabId(activeTab)}
              className="admin-tabpanel"
              id={adminPanelId(activeTab)}
              role="tabpanel"
              tabIndex={0}
            >
              {activeTab === 'platform' && (
                <nav className="admin-subnav" aria-label="Platform admin views">
                  {platformSubRoutes.map((route) => (
                    <button
                      aria-current={platformSubRoute === route.id ? 'page' : undefined}
                      className="inline-action"
                      key={route.id}
                      type="button"
                      onClick={() => selectAdminTab('platform', route.id)}
                    >
                      {route.label}
                    </button>
                  ))}
                </nav>
              )}

        {activeTab === 'organization' && (
          <section className="admin-two-column is-visible" data-reveal>
            <article className="ops-panel wide-panel">
              <PanelHead icon={Database} title="Tenant operator view" action={`${visibleTenantRows.length}/${tenantRows.length} tenants`} />
              <div className="filter-row">
                <label>
                  <span>Search</span>
                  <input value={tenantSearch} onChange={(event) => setTenantSearch(event.target.value)} placeholder="Name, domain, or id" />
                </label>
                <label>
                  <span>Status</span>
                  <select value={tenantStatusFilter} onChange={(event) => setTenantStatusFilter(event.target.value)}>
                    <option value="all">All statuses</option>
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                  </select>
                </label>
                <label>
                  <span>Plan</span>
                  <select value={tenantPlanFilter} onChange={(event) => setTenantPlanFilter(event.target.value)}>
                    <option value="all">All plans</option>
                    {data.plans.map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="tenant-grid">
                {visibleTenantRows.map((row) => {
                  const checked = selectedTenantIds.includes(row.tenant.id);
                  return (
                    <label className={`tenant-row-card ${checked ? 'is-selected' : ''} ${row.tenant.id === tenant.id ? 'is-context' : ''}`} key={row.tenant.id}>
                      <input
                        checked={checked}
                        type="checkbox"
                        onChange={(event) => {
                          if (event.target.checked) {
                            selectAdminContextTenant(row.tenant.id);
                          }
                          setSelectedTenantIds((current) => event.target.checked
                            ? [...new Set([...current, row.tenant.id])]
                            : current.filter((id) => id !== row.tenant.id));
                        }}
                      />
                      <span>
                        <strong>{row.tenant.name}</strong>
                        <small>{row.tenant.domain} · {row.tenant.id}</small>
                      </span>
                      <span className={`status-pill ${row.tenant.status}`}>{titleize(row.tenant.status)}</span>
                      <span>{row.plan?.name ?? row.tenant.planId}</span>
                      <span>{row.activeSeats}+{row.pendingInvites}/{row.seatLimit ?? 'unlimited'} seats</span>
                      <span>{titleize(row.subscription?.status ?? 'missing')}</span>
                      <span>{row.notices.length} open notices</span>
                      <span>{row.lastActivity ? new Date(row.lastActivity).toLocaleString() : '-'}</span>
                    </label>
                  );
                })}
              </div>
              <div className="button-row">
                <button className="inline-action" disabled={visibleTenantRows.length === 0} type="button" onClick={() => setSelectedTenantIds(visibleTenantRows.map((row) => row.tenant.id))}>
                  Select filtered
                </button>
                <button className="inline-action" disabled={selectedTenantIds.length === 0} type="button" onClick={() => setSelectedTenantIds([])}>
                  Clear selection
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api' || selectedTenantIds.length === 0} type="button" onClick={() => mutate('tenants.status-bulk', { tenantIds: selectedTenantIds, status: 'suspended', reason: 'Bulk operator suspension' })}>
                  Suspend selected
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api' || selectedTenantIds.length === 0} type="button" onClick={() => mutate('tenants.status-bulk', { tenantIds: selectedTenantIds, status: 'active' })}>
                  Reactivate selected
                </button>
              </div>
            </article>
            <article className="ops-panel">
              <PanelHead icon={Users} title="Tenant drill-down" action={selectedTenantRow?.tenant.domain ?? 'No tenant'} />
              {selectedTenantRow ? (
                <>
                  <div className="entitlement-card seat-card">
                    <span>{selectedTenantRow.tenant.domain}</span>
                    <strong>{selectedTenantRow.tenant.name}</strong>
                    <small>{selectedTenantRow.plan?.name ?? selectedTenantRow.tenant.planId} · {selectedTenantRow.activeSeats}+{selectedTenantRow.pendingInvites}/{selectedTenantRow.seatLimit ?? 'unlimited'} seats</small>
                  </div>
                  <AdminTable
                    columns={['Member', 'Role', 'Team', 'Status']}
                    rows={membershipsForTenant(data, selectedTenantRow.tenant.id).map((membership) => [
                      ownerName(data.users, membership.userId),
                      membership.role,
                      membership.team ?? '-',
                      membership.status,
                    ])}
                  />
                  <AdminTable
                    columns={['Mailbox', 'Provider', 'Owner', 'Status']}
                    rows={data.mailboxes.filter((mailbox) => mailbox.tenantId === selectedTenantRow.tenant.id).map((mailbox) => [
                      mailbox.id,
                      mailbox.provider,
                      ownerName(data.users, mailbox.ownerUserId),
                      mailbox.status,
                    ])}
                  />
                  <AdminTable
                    columns={['Notice', 'Severity', 'Status', 'Action']}
                    rows={selectedTenantRow.notices.map((notice) => [
                      notice.title,
                      notice.severity,
                      notice.status,
                      notice.actionLabel ?? '-',
                    ])}
                  />
                </>
              ) : (
                <p>No tenant selected.</p>
              )}
            </article>
          </section>
        )}

        {activeTab === 'audit' && (
          <section className="admin-two-column is-visible" data-reveal>
            <article className="ops-panel wide-panel">
              <PanelHead icon={Fingerprint} title="Audit log" action={`${visibleAuditEvents.length}/${auditEvents.length} events`} />
              <div className="filter-row">
                <label>
                  <span>Actor</span>
                  <select value={auditActorFilter} onChange={(event) => setAuditActorFilter(event.target.value)}>
                    <option value="all">All actors</option>
                    {auditActors.map((actor) => (
                      <option key={actor} value={actor}>{ownerName(data.users, actor)}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Action</span>
                  <select value={auditActionFilter} onChange={(event) => setAuditActionFilter(event.target.value)}>
                    <option value="all">All actions</option>
                    {auditActions.map((action) => (
                      <option key={action} value={action}>{action}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Search</span>
                  <input value={auditTextFilter} onChange={(event) => setAuditTextFilter(event.target.value)} placeholder="Target, note, actor" />
                </label>
              </div>
              <div className="button-row">
                <button
                  className="inline-action"
                  type="button"
                  onClick={() => downloadTextFile('signal-audit-log.json', 'application/json', JSON.stringify(visibleAuditEvents, null, 2))}
                >
                  Export JSON
                </button>
                <button
                  className="inline-action"
                  type="button"
                  onClick={() => downloadTextFile(
                    'signal-audit-log.csv',
                    'text/csv',
                    [
                      ['createdAt', 'actor', 'action', 'targetId', 'message'].map(csvCell).join(','),
                      ...visibleAuditEvents.map((event) => [event.createdAt, ownerName(data.users, event.actor), event.action, event.targetId, event.message].map(csvCell).join(',')),
                    ].join('\n'),
                  )}
                >
                  Export CSV
                </button>
              </div>
              <AdminTable
                columns={['Timestamp', 'Actor', 'Action', 'Target', 'Summary']}
                rows={visibleAuditEvents.map((event) => [
                  new Date(event.createdAt).toLocaleString(),
                  ownerName(data.users, event.actor),
                  event.action,
                  event.targetId,
                  event.message,
                ])}
              />
            </article>
          </section>
        )}

        {activeTab === 'dashboard' && (
          <section className="admin-grid is-visible" data-reveal>
            <article className={`ops-panel admin-launch-banner ${launchGate.goLiveReady ? 'is-ready' : 'is-blocked'}`}>
              <PanelHead
                icon={ShieldCheck}
                title="Launch gate go/no-go"
                action={launchGate.goLiveReady ? 'Go' : 'No-go'}
              />
              <div className="launch-banner-grid">
                <div>
                  <span>Decision</span>
                  <strong>{launchGate.goLiveReady ? 'Go' : 'No-go'}</strong>
                  <small>{launchGate.goLiveReady ? 'All launch gates have proof.' : 'Production launch remains blocked by missing proof.'}</small>
                </div>
                <div>
                  <span>Blockers</span>
                  <strong>{launchGate.blocked}</strong>
                  <small>{launchGate.attention} attention item{launchGate.attention === 1 ? '' : 's'}</small>
                </div>
                <div>
                  <span>Secret safety</span>
                  <strong>{launchGate.secretSafe ? 'Safe' : 'Review'}</strong>
                  <small>Environment names and proof commands only.</small>
                </div>
              </div>
            </article>
            <MetricCard icon={Users} label="Users" value={String(tenantUsers.length)} detail={`${activeTenantMemberships.length} active memberships · ${pendingInvites.length} pending invites`} accent="lime" />
            <MetricCard icon={Inbox} label="Reauth needed" value={String(reauthCount)} detail="Outlook source" accent="coral" />
            <MetricCard icon={Workflow} label="Enabled flows" value={`${enabledFlows}/${tenantEmailFlows.length}`} detail={`${routingRules.filter((rule) => rule.status === 'active').length} active routes · ${generatedSignals.length} generated`} accent="cyan" />
            <MetricCard icon={Gauge} label="Accounts" value={String(tenantAccountProfiles.length)} detail={`${tenantAccountActions.filter((action) => action.status === 'open').length} open actions`} accent="lime" />
            <MetricCard icon={BellRing} label="Unread alerts" value={String(summary.unreadNotifications ?? unreadNotifications.length)} detail={`${summary.mutedNotifications ?? mutedNotifications.length} muted`} accent="cyan" />
            <MetricCard icon={CreditCard} label="Subscription" value={subscription?.status ? titleize(subscription.status) : 'Missing'} detail="Local state, provider webhook source" accent="gold" />
            <MetricCard icon={ShieldCheck} label="Tenant status" value={titleize(tenant.status)} detail={`${summary.suspendedTenants ?? data.tenants.filter((item) => item.status === 'suspended').length} suspended`} accent={tenantSuspended ? 'coral' : 'lime'} />
            <MetricCard icon={WalletCards} label="Overrides" value={String(summary.activeBillingOverrides ?? activeBillingOverrides.length)} detail={`${summary.billingOverrides ?? billingOverrides.length} billing overrides`} accent={activeBillingOverrides.length ? 'gold' : 'cyan'} />
            <MetricCard icon={WalletCards} label="Open invoices" value={String(recoverableInvoices.length)} detail={`${tenantInvoices.filter((invoice) => invoice.status === 'past_due').length} past due`} accent="coral" />
            <MetricCard icon={AlertTriangle} label="Lifecycle notices" value={String(summary.openLifecycleNotices ?? openLifecycleNotices.length)} detail={`${summary.criticalLifecycleNotices ?? openLifecycleNotices.filter((notice) => notice.severity === 'critical').length} critical`} accent="coral" />
            <MetricCard icon={Fingerprint} label="API sessions" value={String(summary.activeApiSessions ?? activeApiSessions.length)} detail={`${summary.revokedApiSessions ?? revokedApiSessions.length} revoked · digest-only`} accent="cyan" />
            <MetricCard icon={Plug} label="Provider readiness" value={`${providerReadiness.summary.readyProviders}/${providerReadiness.summary.totalProviders}`} detail={`${providerReadiness.summary.missingRequired} env vars missing`} accent="gold" />
            {providerLaunch ? (
              <MetricCard icon={ShieldCheck} label="Provider launch" value={`${providerLaunch.summary.launchReady}/${providerLaunch.summary.total}`} detail={`${providerLaunch.summary.sandboxPassed}/${providerLaunch.summary.sandboxRequired} sandbox proofs`} accent={providerLaunch.productionReady ? 'lime' : 'gold'} />
            ) : (
              <MetricCard icon={ShieldCheck} label="Provider launch" value={`${providerReadiness.summary.readyProviders}/${providerReadiness.summary.totalProviders}`} detail={sectionLoading.launch ? 'Loading launch matrix' : 'Proof matrix pending'} accent={providerReadiness.ok ? 'lime' : 'gold'} />
            )}
            <MetricCard icon={RefreshCw} label="Sandbox runs" value={String(summary.providerValidationRuns ?? providerValidationRuns.length)} detail={summary.latestProviderValidationStatus ? `${titleize(summary.latestProviderValidationStatus)} latest` : 'Not recorded'} accent="lime" />
            <MetricCard icon={RefreshCw} label="Validation schedules" value={`${summary.activeProviderValidationSchedules ?? providerValidationSchedules.filter((schedule) => schedule.status === 'active').length}/${summary.providerValidationSchedules ?? providerValidationSchedules.length}`} detail={`${summary.dueProviderValidationSchedules ?? dueProviderValidationSchedules.length} due`} accent="cyan" />
            <MetricCard icon={Database} label="Backend mode" value={titleize(backendReadiness.mode)} detail={backendReadiness.productionReady ? 'Production ready' : `${backendReadiness.summary.readyChecks}/${backendReadiness.summary.totalChecks} production checks ready`} accent={backendReadiness.productionReady ? 'lime' : 'gold'} />
            <article className="ops-panel wide-panel">
              <PanelHead icon={AlertTriangle} title="Readiness checks" action="CLI doctor parity" />
              <div className="check-list">
                {doctorReport.checks.map((check) => (
                  <CheckItem key={check.id} ok={check.ok} label={check.message} />
                ))}
              </div>
            </article>
            <article className="ops-panel dashboard-audit-panel">
              <PanelHead
                icon={Database}
                title="Dashboard calculation audit"
                action={`${dashboardAudit.summary.passed}/${dashboardAudit.summary.total} checks`}
              />
              <div className="check-list">
                <CheckItem ok={dashboardAudit.ok} label={dashboardAudit.ok ? 'Dashboard visible counts reconcile with shared state summary totals.' : `${dashboardAudit.summary.failed} dashboard calculation mismatch needs review.`} />
                <CheckItem ok={dashboardAudit.summary.scopedRows > 0} label="User workspace rows are explicitly actor-scoped while admin rows reconcile against global state totals." />
                <CheckItem ok={dashboardAudit.backend.mode !== 'unknown'} label={`Backend boundary for this audit is ${dashboardAudit.backend.mode}.`} />
              </div>
              <AdminTable
                columns={['Area', 'Check', 'Display', 'Summary', 'Total', 'Scope', 'Status']}
                rows={dashboardAudit.rows.map((row) => [
                  titleize(row.area),
                  row.check,
                  String(row.displayValue),
                  `${row.summaryKey}=${row.summaryValue}`,
                  String(row.totalValue),
                  titleize(row.scope),
                  row.ok ? 'Pass' : 'Mismatch',
                ])}
              />
              <CommandStrip commands={['npm run admin -- dashboard-audit --json', 'curl http://127.0.0.1:8787/api/dashboard-audit', 'npm run admin -- dashboard-audit --env-file ./.env.production --json']} />
            </article>
          </section>
        )}

        {activeTab === 'organization' && (
          <section className="admin-two-column is-visible" data-reveal>
            <article className="ops-panel">
              <PanelHead icon={ShieldCheck} title="Tenant workspace" action={titleize(tenant.status)} />
              <div className="entitlement-card seat-card">
                <span>{tenant.domain}</span>
                <strong>{tenant.name}</strong>
                <small>
                  {plan ? `${plan.name} · ${activeSeats}+${pendingInviteSeats}/${seatLimit ?? 'unlimited'} seats` : `Plan missing · ${activeSeats}+${pendingInviteSeats} seats`}
                </small>
              </div>
              {tenantSuspended && (
                <div className="alert-card">
                  <strong>Suspension reason</strong>
                  <small>{tenant.suspensionReason ?? 'No reason recorded.'}</small>
                </div>
              )}
              <AdminTable
                columns={['Tenant', 'Domain', 'Status', 'Plan', 'Seats', 'Owner', 'Billing']}
                rows={data.tenants.map((item) => {
                  const tenantPlan = data.plans.find((candidate) => candidate.id === item.planId);
                  const tenantEntitlement = data.entitlements.find((candidate) => candidate.tenantId === item.id);
                  const tenantSeatLimit = tenantEntitlement?.seatLimit ?? tenantPlan?.seatLimit ?? null;
                  const tenantActiveSeats = activeMembershipsForTenant(data, item.id).length || data.users.filter((user) => user.tenantId === item.id && user.status === 'active').length;
                  const tenantPendingInvites = pendingInvites.filter((invite) => invite.tenantId === item.id).length;
                  return [item.name, item.domain, titleize(item.status), tenantPlan?.name ?? '-', `${tenantActiveSeats}+${tenantPendingInvites}/${tenantSeatLimit ?? 'unlimited'}`, ownerName(data.users, item.ownerUserId ?? ''), ownerName(data.users, item.billingOwnerUserId ?? item.ownerUserId ?? '')];
                })}
              />
              <div className="button-row">
                <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('tenants.create', { name: `Local Workspace ${Date.now()}`, domain: `workspace-${Date.now()}.example`, adminEmail: `owner-${Date.now()}@workspace.example`, adminName: 'Local Owner', planId: 'plan_beta' })}>
                  Create workspace
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api' || tenantSuspended} type="button" onClick={() => mutate('tenants.status', { tenantId: tenant.id, status: 'suspended', reason: 'Manual local suspension review' })}>
                  Suspend tenant
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api' || !tenantSuspended} type="button" onClick={() => mutate('tenants.status', { tenantId: tenant.id, status: 'active' })}>
                  Reactivate tenant
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('tenants.domain', { tenantId: tenant.id, domain: 'acme.example' })}>
                  Reset domain
                </button>
              </div>
              <CommandStrip commands={['npm run admin -- tenants --json', 'npm run admin -- tenants register New_Revenue_Lab newlab.example owner@newlab.example Owner_Name plan_beta', 'npm run admin -- tenants create New_Revenue_Lab newlab.example owner@newlab.example Owner_Name plan_beta', 'npm run admin -- tenants status tenant_demo suspended Billing_review', 'npm run admin -- tenants status tenant_demo active', 'npm run admin -- tenants domain tenant_demo acme.example']} />
            </article>
            <article className="ops-panel">
              <PanelHead icon={UserCog} title="Users and memberships" action={`${activeSeats}/${seatLimit ?? 'unlimited'} active seats`} />
              <AdminTable
                columns={['Name', 'Email', 'Role', 'Team', 'Membership', 'Status']}
                rows={tenantUsers.map((user) => {
                  const membership = membershipForUser(data, user.id, user.tenantId);
                  return [
                    user.name,
                    user.email,
                    membership?.role ?? user.role,
                    membership?.team ?? user.team ?? '-',
                    membership?.id ?? 'missing',
                    membership?.status ?? user.status,
                  ];
                })}
              />
              <div className="button-row">
                <button className="inline-action" disabled={isMutating || source !== 'api' || !salesDemoUser} type="button" onClick={() => salesDemoUser && mutate('users.role', { role: 'admin', userId: salesDemoUser.id })}>
                  Promote {salesDemoUser?.name ?? 'sales member'}
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api' || !productDemoUser} type="button" onClick={() => productDemoUser && mutate('users.disable', { userId: productDemoUser.id })}>
                  Disable {productDemoUser?.name ?? 'product member'}
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api' || !productDemoUser} type="button" onClick={() => productDemoUser && mutate('users.activate', { userId: productDemoUser.id })}>
                  Reactivate {productDemoUser?.name ?? 'product member'}
                </button>
              </div>
              <CommandStrip commands={['npm run admin -- users --json', 'npm run admin -- users role usr_sales admin']} />
            </article>
            <article className="ops-panel">
              <PanelHead icon={LockKeyhole} title="Membership privacy boundary" action={`${tenantMemberships.length} records`} />
              <AdminTable
                columns={['Tenant', 'User', 'Role', 'Team', 'Status', 'Source']}
                rows={tenantMemberships.map((membership) => [
                  membership.tenantId,
                  ownerName(data.users, membership.userId),
                  membership.role,
                  membership.team ?? '-',
                  titleize(membership.status),
                  membership.inviteId ? `Invite ${membership.inviteId}` : 'Workspace registration',
                ])}
              />
              <CommandStrip commands={['npm run admin -- users --json', 'npm run admin -- doctor']} />
            </article>
            <article className="ops-panel">
              <PanelHead icon={MailCheck} title="Invites and seats" action={`${pendingInvites.length} pending`} />
              <div className="entitlement-card seat-card">
                <span>Seat usage</span>
                <strong>{activeSeats}+{pendingInviteSeats}/{seatLimit ?? 'unlimited'}</strong>
                <small>{seatsAvailable === null ? 'No seat limit reported' : `${seatsAvailable} seats available after pending invites`}</small>
              </div>
              <div className="button-row">
                <button
                  className="inline-action"
                  disabled={isMutating || source !== 'api' || seatsAvailable === 0}
                  type="button"
                  onClick={() => mutate('users.invite', { tenantId: tenant.id, email: `success-${Date.now()}@acme.example`, role: 'member', team: 'success' })}
                >
                  Invite success
                </button>
              </div>
              <div className="invite-stack">
                {recentInvites.map((invite) => (
                  <InviteCard
                    canMutate={source === 'api' && !isMutating}
                    invite={invite}
                    key={invite.id}
                    onAccept={() => mutate('users.invite-accept', { inviteId: invite.id })}
                    onRevoke={() => mutate('users.invite-revoke', { inviteId: invite.id })}
                  />
                ))}
              </div>
              <CommandStrip commands={['npm run admin -- users invite tenant_demo rowan@acme.example member success', 'npm run admin -- users accept inv_rowan_success Rowan_Lee', 'npm run admin -- users revoke <inviteId>']} />
            </article>
            {onboardingReadiness ? (
              <article className="ops-panel wide-panel">
                <PanelHead
                  icon={ShieldCheck}
                  title="Onboarding, RBAC, and privacy readiness"
                  action={`${onboardingReadiness.summary.localReady}/${onboardingReadiness.summary.total} local checks`}
                />
                <div className="check-list">
                  <CheckItem ok={onboardingReadiness.ok} label="Workspace creation, member invitation, membership RBAC, user focus controls, and privacy evidence pass locally." />
                  <CheckItem ok={onboardingReadiness.recommendation.decision === 'support_multi_member_orgs'} label={onboardingReadiness.recommendation.summary} />
                  <CheckItem ok={onboardingReadiness.productionReady} label={onboardingReadiness.productionReady ? 'Production multi-org guardrails are ready.' : onboardingReadiness.recommendation.productionGuardrail} />
                  <CheckItem ok label={onboardingReadiness.recommendation.perTenantModelDefault} />
                </div>
                <AdminTable
                  columns={['Area', 'Local', 'Production', 'Evidence', 'Recommendation']}
                  rows={onboardingReadiness.rows.map((row) => [
                    titleize(row.area),
                    row.localOk ? 'Ready' : 'Attention',
                    row.productionOk ? 'Ready' : 'Not ready',
                    row.evidence.join(' · '),
                    row.recommendation,
                  ])}
                />
                <AdminTable
                  columns={['Role', 'Data access', 'Actions', 'Guardrails']}
                  rows={onboardingReadiness.roleMatrix.map((role) => [
                    titleize(role.role),
                    role.dataAccess,
                    role.allowedActions.map(titleize).join(', '),
                    role.guardrails.map(titleize).join(', '),
                  ])}
                />
                <CommandStrip commands={['npm run admin -- onboarding-readiness --json', 'curl http://127.0.0.1:8787/api/onboarding-readiness', 'npm run admin -- users --json', 'npm run admin -- session token usr_admin --json']} />
              </article>
            ) : (
              <ReportLoadingPanel icon={ShieldCheck} title="Onboarding, RBAC, and privacy readiness" wide />
            )}
          </section>
        )}

        {activeTab === 'email' && (
          <section className="admin-two-column is-visible" data-reveal>
            <article className="ops-panel">
              <PanelHead icon={Inbox} title="Source governance" action="Provider source health" />
              <div className="button-row">
                <MutationButton
                  action="mailboxes.connect-url"
                  actionKey="admin-mailbox-connect-gmail"
                  args={{ ownerUserId: salesDemoUser?.id, provider: 'gmail', tenantId: tenant.id }}
                  busyText="Creating..."
                  disabled={isMutating || source !== 'api' || !salesDemoUser}
                  feedback={mutationFeedback}
                >
                  Connect Gmail
                </MutationButton>
                <MutationButton
                  action="mailboxes.connect-url"
                  actionKey="admin-mailbox-connect-outlook"
                  args={{ ownerUserId: tenantAdminUser?.id, provider: 'outlook', tenantId: tenant.id }}
                  busyText="Creating..."
                  disabled={isMutating || source !== 'api' || !tenantAdminUser}
                  feedback={mutationFeedback}
                >
                  Connect Outlook
                </MutationButton>
              </div>
              <InlineError message={mutationFeedback.errorFor('admin-mailbox-connect-gmail', 'admin-mailbox-connect-outlook')} />
              {tenantMailboxes.map((mailbox) => {
                const latestSession = latestSessionForMailbox(mailbox.id);
                const readySession = latestSession?.status === 'ready' ? latestSession : undefined;
                const latestWatch = latestWatchForMailbox(mailbox.id);
                const mailboxSyncKey = `admin-mailbox-sync-${mailbox.id}`;
                const mailboxReplayKey = `admin-mailbox-replay-${mailbox.id}`;
                const mailboxWatchKey = `admin-mailbox-watch-${mailbox.id}`;
                const mailboxRenewKey = `admin-mailbox-renew-${latestWatch?.id ?? mailbox.id}`;
                const mailboxPauseKey = `admin-mailbox-pause-${mailbox.id}`;
                const mailboxDisconnectKey = `admin-mailbox-disconnect-${mailbox.id}`;
                const mailboxResumeKey = `admin-mailbox-resume-${mailbox.id}`;
                const mailboxConnectKey = `admin-mailbox-connect-${mailbox.id}`;
                const mailboxCompleteKey = `admin-mailbox-complete-${readySession?.id ?? mailbox.id}`;
                const canMutateMailbox = source === 'api' && !isMutating;

                return (
                  <MailboxCard
                    key={mailbox.id}
                    cursor={data.emailSyncCursors.find((cursor) => cursor.mailboxId === mailbox.id)}
                    mailbox={mailbox}
                    session={latestSession}
                    users={data.users}
                    watch={latestWatch}
                    action={
                      <>
                        {mailbox.status === 'connected' && (
                          <>
                            <MutationButton action="mailboxes.sync" actionKey={mailboxSyncKey} args={{ mailboxId: mailbox.id }} busyText="Syncing..." disabled={!canMutateMailbox} feedback={mutationFeedback}>
                              Sync
                            </MutationButton>
                            <MutationButton action="mailboxes.replay" actionKey={mailboxReplayKey} args={{ mailboxId: mailbox.id }} busyText="Replaying..." disabled={!canMutateMailbox} feedback={mutationFeedback}>
                              Replay
                            </MutationButton>
                            <MutationButton action="mailboxes.watch" actionKey={mailboxWatchKey} args={{ mailboxId: mailbox.id }} busyText="Watching..." disabled={!canMutateMailbox} feedback={mutationFeedback}>
                              Watch
                            </MutationButton>
                            {latestWatch && (
                              <MutationButton action="mailboxes.watch-renew" actionKey={mailboxRenewKey} args={{ watchId: latestWatch.id }} busyText="Renewing..." disabled={!canMutateMailbox} feedback={mutationFeedback}>
                                Renew
                              </MutationButton>
                            )}
                            <MutationButton action="mailboxes.pause" actionKey={mailboxPauseKey} args={{ mailboxId: mailbox.id }} busyText="Pausing..." disabled={!canMutateMailbox} feedback={mutationFeedback}>
                              Pause
                            </MutationButton>
                            <MutationButton action="mailboxes.disconnect" actionKey={mailboxDisconnectKey} args={{ mailboxId: mailbox.id }} busyText="Disconnecting..." disabled={!canMutateMailbox} feedback={mutationFeedback}>
                              Disconnect
                            </MutationButton>
                          </>
                        )}
                        {mailbox.status === 'paused' && (
                          <MutationButton action="mailboxes.resume" actionKey={mailboxResumeKey} args={{ mailboxId: mailbox.id }} busyText="Resuming..." disabled={!canMutateMailbox} feedback={mutationFeedback}>
                            Resume
                          </MutationButton>
                        )}
                        {mailbox.status !== 'connected' && mailbox.status !== 'paused' && (
                          <MutationButton
                            action="mailboxes.connect-url"
                            actionKey={mailboxConnectKey}
                            args={{ mailboxId: mailbox.id, ownerUserId: mailbox.ownerUserId, provider: mailbox.provider, tenantId: mailbox.tenantId }}
                            busyText="Creating..."
                            disabled={!canMutateMailbox}
                            feedback={mutationFeedback}
                          >
                            Create auth link
                          </MutationButton>
                        )}
                        {readySession && (
                          <MutationButton action="mailboxes.complete" actionKey={mailboxCompleteKey} args={{ sessionId: readySession.id }} busyText="Completing..." disabled={!canMutateMailbox} feedback={mutationFeedback}>
                            Complete auth
                          </MutationButton>
                        )}
                        <InlineError message={mutationFeedback.errorFor(mailboxSyncKey, mailboxReplayKey, mailboxWatchKey, mailboxRenewKey, mailboxPauseKey, mailboxDisconnectKey, mailboxResumeKey, mailboxConnectKey, mailboxCompleteKey)} />
                      </>
                    }
                  />
                );
              })}
              {tenantMailboxes.length === 0 && (
                <div className="empty-state">
                  <strong>No mailbox sources for this tenant.</strong>
                  <small>Use the admin context tenant selector to switch back, or create a provider connection for {tenant.domain}.</small>
                </div>
              )}
              <AdminTable
                columns={['Session', 'Provider', 'Status', 'OAuth', 'Credential']}
                rows={latestMailboxSessions.map((session) => [session.id, session.provider, session.status, session.oauthStateStatus ?? 'legacy', session.credentialStatus ?? 'pending'])}
              />
              <AdminTable
                columns={['Watch', 'Provider', 'Status', 'Mode', 'Expires', 'Credential', 'Refreshed', 'Retry', 'Provider', 'Notifications']}
                rows={mailboxWatchesDescending.slice(0, 6).map((watch) => [
                  watch.id,
                  watch.provider,
                  watch.status,
                  watch.setupMode ?? 'local',
                  watch.expirationAt ? new Date(watch.expirationAt).toLocaleString() : '-',
                  watch.providerCredentialSource ?? '-',
                  watch.providerCredentialRefreshedAt ? new Date(watch.providerCredentialRefreshedAt).toLocaleString() : '-',
                  watch.providerRetryAfterAt ? new Date(watch.providerRetryAfterAt).toLocaleString() : '-',
                  watch.providerResponseStatus ? `HTTP ${watch.providerResponseStatus}` : '-',
                  String(watch.notificationCount ?? 0),
                ])}
              />
              <CommandStrip commands={['npm run admin -- mailboxes connect-url tenant_demo outlook usr_admin mbx_outlook_success', 'npm run admin -- mailboxes callback outlook <code> <state>', 'npm run admin -- mailboxes watch mbx_gmail_sales', 'npm run admin -- mailboxes renew-watch watch_gmail_mbx_gmail_sales', 'curl -X POST http://127.0.0.1:8787/api/webhooks/gmail', 'npm run admin -- mailboxes sync mbx_gmail_sales', 'npm run admin -- mailboxes replay mbx_gmail_sales']} />
            </article>
            {emailHandoff ? (
              <article className="ops-panel">
                <PanelHead
                  icon={MailCheck}
                  title="Email launch handoff"
                  action={emailHandoff.productionReady ? 'Production ready' : `${emailHandoff.summary.blocked} steps need proof`}
                />
                <div className="check-list">
                  <CheckItem ok={emailHandoff.ok} label="Email launch handoff is secret-safe and ranks Gmail, Outlook, outbound digest email, watches, signed delivery webhooks, sandbox evidence, monitoring, and rollback." />
                  <CheckItem ok={emailHandoff.productionReady} label={emailHandoff.productionReady ? 'Email launch proof is complete.' : `Next email step: ${emailHandoff.nextStep.label} owned by ${titleize(emailHandoff.nextStep.owner)}.`} />
                  <CheckItem ok={emailHandoff.summary.secretSafe} label="Email handoff commands expose environment variable names and placeholders only; credential values stay out of the report." />
                  <CheckItem ok={emailHandoff.email.failedEmailDeliveries === 0} label={`${emailHandoff.email.activeEmailWatchSubscriptions}/${emailHandoff.email.emailWatchSubscriptions} active provider watch subscriptions and ${emailHandoff.email.failedEmailDeliveries} failed delivery records.`} />
                </div>
                <AdminTable
                  columns={['Priority', 'Step', 'Status', 'Owner', 'Missing env', 'Blocker', 'Command', 'Rollback']}
                  rows={emailHandoffRows}
                />
                <CommandStrip commands={['npm run admin -- email-handoff --json', 'npm run admin -- email-handoff --env-file ./.env.production --json', 'curl http://127.0.0.1:8787/api/email-handoff', 'npm run admin -- mailboxes watch mbx_gmail_sales --live-provider', 'npm run admin -- mailboxes renew-watch watch_outlook_mbx_outlook_success --live-provider', 'npm run admin -- notifications digest tenant_demo --live-provider', 'SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET=<email-webhook-secret> npm run admin -- notifications webhook-signed ./email-event.json <Signal-Email-Signature>', 'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json']} />
              </article>
            ) : (
              <ReportLoadingPanel icon={MailCheck} title="Email launch handoff" />
            )}
            <article className="ops-panel">
              <PanelHead icon={Workflow} title={digestionPipeline ? 'Detector and routing rules' : 'Loading detector reports'} action="Email flow controls" />
              <div className="button-row">
                <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('email-flows.run', {})}>
                  Run enabled flows
                </button>
              </div>
              {tenantEmailFlows.map((flow) => (
                <FlowCard
                  key={flow.id}
                  flow={flow}
                  rule={routingRuleForFlow(flow.id)}
                  users={data.users}
                  action={
                    <>
                      <button
                        className="inline-action"
                        disabled={isMutating || source !== 'api'}
                        type="button"
                        onClick={() => mutate(flow.status === 'enabled' ? 'email-flows.disable' : 'email-flows.enable', { flowId: flow.id })}
                      >
                        {flow.status === 'enabled' ? 'Disable' : 'Enable'}
                      </button>
                      <button className="inline-action" disabled={isMutating || source !== 'api' || flow.status !== 'enabled'} type="button" onClick={() => mutate('email-flows.run', { flowId: flow.id })}>
                        Run
                      </button>
                      <button className="inline-action" disabled={isMutating || source !== 'api' || !tenantAdminUser} type="button" onClick={() => tenantAdminUser && mutate('email-flows.route', { flowId: flow.id, routeTo: 'founder', ownerUserId: tenantAdminUser.id, note: 'Founder review route' })}>
                        Founder
                      </button>
                      <button className="inline-action" disabled={isMutating || source !== 'api' || !salesDemoUser} type="button" onClick={() => salesDemoUser && mutate('email-flows.route', { flowId: flow.id, routeTo: 'crm', ownerUserId: salesDemoUser.id, note: 'CRM follow-up route' })}>
                        CRM
                      </button>
                    </>
                  }
                />
              ))}
              {tenantEmailFlows.length === 0 && (
                <div className="empty-state">
                  <strong>No detector flows for this tenant.</strong>
                  <small>Run the CLI bootstrap or create routing flows before operating {tenant.domain}.</small>
                </div>
              )}
              <AdminTable
                columns={['Rule', 'Flow', 'Route', 'Owner', 'Status']}
                rows={routingRules.length
                  ? routingRules.map((rule) => [
                      rule.id,
                      rule.flowId,
                      titleize(rule.routeTo),
                      rule.ownerUserId ? ownerName(data.users, rule.ownerUserId) : 'Auto owner',
                      titleize(rule.status),
                    ])
                  : [['No routing rules', '-', '-', '-', 'Run bootstrap or set a route']]}
              />
              <div className="flow-run-stack">
                {latestFlowRuns.map((run) => (
                  <FlowRunCard key={run.id} run={run} />
                ))}
                {latestFlowRuns.length === 0 && (
                  <div className="empty-state">
                    <strong>No detector runs yet.</strong>
                    <small>Run enabled flows to create replay-safe signals from local source-message snippets.</small>
                  </div>
                )}
              </div>
              <div className="source-message-stack">
                {latestSourceMessages.map((message) => (
                  <SourceMessageCard key={message.id} message={message} />
                ))}
              </div>
              <div className="quality-control-stack">
                <div className="quality-card">
                  <div>
                    <span>Quality threshold</span>
                    <strong>{qualitySettings ? formatPercent(qualitySettings.minimumConfidence) : 'Not configured'}</strong>
                    <small>{qualitySettings?.requireSourceReference ? 'Source references required' : 'Source references optional'} · {summary.activeSuppressionRules ?? suppressionRules.filter((rule) => rule.status === 'active').length} active suppression rules</small>
                  </div>
                  <div className="card-actions">
                    <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('quality.threshold', { tenantId: tenant.id, minimumConfidence: 0.72 })}>
                      Baseline
                    </button>
                    <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('quality.threshold', { tenantId: tenant.id, minimumConfidence: 0.85 })}>
                      Strict
                    </button>
                  </div>
                </div>
                <div className="button-row compact-actions">
                  <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('quality.suppression-add', { tenantId: tenant.id, type: 'domain', value: 'internal.example', reason: 'Suppress internal operational threads' })}>
                    Suppress internal
                  </button>
                  <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('quality.suppression-add', { tenantId: tenant.id, type: 'account', value: 'Acme Health', reason: 'Pause renewal-risk account during save plan' })}>
                    Suppress Acme
                  </button>
                </div>
                {suppressionRules.map((rule) => (
                  <SuppressionRuleCard
                    canMutate={source === 'api' && !isMutating}
                    key={rule.id}
                    onStatus={(status) => mutate('quality.suppression-status', { ruleId: rule.id, status })}
                    rule={rule}
                  />
                ))}
                <AdminTable
                  columns={['Signal', 'User', 'Label', 'Note']}
                  rows={latestFeedback.map((feedback) => [feedback.signalId, ownerName(data.users, feedback.userId), titleize(feedback.label), feedback.note ?? '-'])}
                />
              </div>
              <div className="quality-control-stack">
                <div className="quality-card">
                  <div>
                    <span>Model governance</span>
                    <strong>{modelGovernancePolicy ? titleize(modelGovernancePolicy.detectorBoundary) : 'Missing policy'}</strong>
                    <small>
                      {modelGovernancePolicy
                        ? `${titleize(modelGovernancePolicy.learningMode)} learning · Per-org model ${modelGovernancePolicy.perTenantModel ? 'enabled' : 'off'} · ${titleize(modelGovernancePolicy.trainingDataUse)}`
                        : 'Shared detector policy not found for this tenant.'}
                    </small>
                    {modelGovernancePolicy?.decision && <small>{modelGovernancePolicy.decision}</small>}
                  </div>
                  <div className="card-actions">
                    <button className="inline-action" disabled={isMutating || source !== 'api' || !modelGovernancePolicy || modelGovernancePolicy.learningMode === 'disabled'} type="button" onClick={() => mutate('models.policy', { tenantId: tenant.id, learningMode: 'disabled', note: 'Disabled from admin console' })}>
                      Disable learning
                    </button>
                    <button className="inline-action" disabled={isMutating || source !== 'api' || !modelGovernancePolicy || modelGovernancePolicy.learningMode === 'opt_in_tuning'} type="button" onClick={() => mutate('models.policy', { tenantId: tenant.id, learningMode: 'opt_in_tuning', note: 'Governance-reviewed opt-in tuning' })}>
                      Opt-in tuning
                    </button>
                  </div>
                </div>
                <div className="check-list">
                  <CheckItem ok={modelGovernancePolicy?.detectorBoundary === 'shared_detector'} label="Shared detector/model boundary is the MVP default." />
                  <CheckItem ok={modelGovernancePolicy?.dataBoundary === 'tenant_isolated'} label="Digest evidence stays tenant-isolated through source messages, routing, feedback, and retention policy." />
                  <CheckItem ok={modelGovernancePolicy?.perTenantModel === false} label="No separately trained per-org model is enabled by default." />
                  <CheckItem ok={modelGovernancePolicy?.learningMode !== 'opt_in_tuning' || modelGovernancePolicy.trainingDataUse === 'opt_in_only'} label="Future learning is opt-in only and controlled by admin policy." />
                </div>
                <AdminTable
                  columns={['Evidence', 'Value']}
                  rows={modelGovernanceEvidence
                    ? [
                        ['Detector flows', `${modelGovernanceEvidence.enabledDetectorFlows}/${modelGovernanceEvidence.totalDetectorFlows} enabled`],
                        ['Source messages', String(modelGovernanceEvidence.sourceMessages)],
                        ['Generated signals', String(modelGovernanceEvidence.generatedSignals)],
                        ['Routing / suppression', `${modelGovernanceEvidence.activeRoutingRules} routes · ${modelGovernanceEvidence.activeSuppressionRules} suppressions`],
                        ['Feedback labels', String(modelGovernanceEvidence.feedbackLabels)],
                        ['Retention', `${modelGovernanceEvidence.sourceRetentionDays ?? '-'} source days · ${modelGovernanceEvidence.rawSnippetRetentionDays ?? '-'} raw days`],
                      ]
                    : [['Policy', 'Missing']]}
                />
              </div>
              {digestionPipeline ? (
                <div className="quality-control-stack">
                  <div className="quality-card">
                    <div>
                      <span>Digestion pipeline audit</span>
                      <strong>{digestionPipeline.summary.localReady}/{digestionPipeline.summary.total} local stages</strong>
                      <small>{digestionPipeline.recommendation.summary}</small>
                    </div>
                    <div className="status-pill">{digestionPipeline.productionReady ? 'Production ready' : 'Production gated'}</div>
                  </div>
                  <div className="check-list">
                    <CheckItem ok={digestionPipeline.ok} label="Source ingestion, detector execution, quality feedback, routing outcomes, and model policy have local evidence." />
                    <CheckItem ok={digestionPipeline.summary.perTenantModels === 0} label="No per-org trained model is enabled by default." />
                    <CheckItem ok={digestionPipeline.productionReady} label={digestionPipeline.productionReady ? 'Production pipeline controls are ready.' : digestionPipeline.recommendation.productionGuardrail} />
                  </div>
                  <AdminTable
                    columns={['Stage', 'Status', 'Local', 'Production', 'Evidence', 'Env', 'Command']}
                    rows={digestionPipeline.rows.map((row) => [
                      titleize(row.area),
                      titleize(row.status),
                      row.localOk ? 'Ready' : 'Attention',
                      row.productionOk ? 'Ready' : 'Gated',
                      row.evidence.join(' | '),
                      row.requiredEnv.join(', ') || '-',
                      row.commands[0] ?? '-',
                    ])}
                  />
                </div>
              ) : (
                <div className="quality-control-stack">
                  <div className="empty-state">
                    <strong>Loading report...</strong>
                  </div>
                </div>
              )}
              <CommandStrip commands={['npm run admin -- email-flows run', 'npm run admin -- email-flows route flow_buying_intent founder usr_admin Founder_review', 'npm run admin -- email-flows route flow_product_ideas crm usr_sales CRM_followup', 'npm run admin -- signals handoff sig_product_001 crm CRM_followup', 'npm run admin -- quality threshold tenant_demo 0.85', 'npm run admin -- quality suppress tenant_demo domain internal.example', 'npm run admin -- digestion-pipeline --json', 'curl http://127.0.0.1:8787/api/digestion-pipeline', 'npm run admin -- models --json', 'npm run admin -- models policy tenant_demo opt_in_tuning Governance_reviewed', 'npm run admin -- signals feedback sig_risk_001 useful']} />
            </article>
          </section>
        )}

        {activeTab === 'platform' && platformSubRoute === 'signals' && (
          <section className="admin-two-column is-visible" data-reveal>
            <article className="ops-panel wide-panel">
              <PanelHead icon={Radar} title="Signals operator" action={`${visibleOperatorSignals.length}/${tenantSignals.length} signals`} />
              <div className="filter-row">
                <label>
                  <span>Status</span>
                  <select value={signalStatusFilter} onChange={(event) => setSignalStatusFilter(event.target.value)}>
                    <option value="all">All statuses</option>
                    <option value="open">Open</option>
                    <option value="routed">Routed</option>
                    <option value="dismissed">Dismissed</option>
                  </select>
                </label>
                <label>
                  <span>Owner</span>
                  <select value={signalOwnerFilter} onChange={(event) => setSignalOwnerFilter(event.target.value)}>
                    <option value="all">All owners</option>
                    {signalOwnerOptions.map((user) => (
                      <option key={user.id} value={user.id}>{user.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Flow</span>
                  <select value={signalFlowFilter} onChange={(event) => setSignalFlowFilter(event.target.value)}>
                    <option value="all">All flows</option>
                    <option value="none">No flow</option>
                    {tenantEmailFlows.map((flow) => (
                      <option key={flow.id} value={flow.id}>{flow.name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="operator-table" role="table" aria-label="Signals operator table">
                <div className="operator-row operator-row-head" role="row">
                  <span role="columnheader">Signal</span>
                  <span role="columnheader">Account</span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader">Owner</span>
                  <span role="columnheader">Route / flow</span>
                  <span role="columnheader">Actions</span>
                </div>
                {visibleOperatorSignals.map((signal) => {
                  const signalFlow = tenantEmailFlows.find((flow) => flow.id === signal.flowId);
                  const assignTarget = signalOwnerOptions.find((user) => user.id !== signal.ownerUserId) ?? signalOwnerOptions[0];
                  const signalAssignKey = `admin-signal-assign-${signal.id}`;
                  const signalStatusKey = `admin-signal-status-${signal.id}`;
                  const signalFeedbackKey = `admin-signal-feedback-${signal.id}`;
                  const signalHandoffKey = `admin-signal-handoff-${signal.id}`;
                  const nextSignalStatus = signal.status === 'routed' ? 'open' : 'routed';
                  return (
                    <div className="operator-row" role="row" key={signal.id}>
                      <span role="cell">
                        <strong>{signal.id}</strong>
                        <small>{titleize(signal.type)} · {titleize(signal.severity)} · {formatPercent(signal.confidence)}</small>
                      </span>
                      <span role="cell">{signal.account}</span>
                      <span role="cell"><span className={`status-pill ${signal.status}`}>{titleize(signal.status)}</span></span>
                      <span role="cell">{ownerName(data.users, signal.ownerUserId)}</span>
                      <span role="cell">
                        <strong>{titleize(signal.routeTo ?? signalFlow?.routeTo ?? 'unrouted')}</strong>
                        <small>{signalFlow?.name ?? signal.flowId ?? 'No flow'}</small>
                      </span>
                      <span role="cell">
                        <div className="button-row compact-actions">
                          <MutationButton
                            action="signals.assign"
                            actionKey={signalAssignKey}
                            args={{ signalId: signal.id, userId: assignTarget?.id }}
                            busyText="Assigning..."
                            disabled={!canUseAdminMutations || !assignTarget}
                            feedback={mutationFeedback}
                          >
                            Assign
                          </MutationButton>
                          <MutationButton
                            action="signals.status"
                            actionKey={signalStatusKey}
                            args={{ signalId: signal.id, status: nextSignalStatus }}
                            busyText="Updating..."
                            disabled={!canUseAdminMutations}
                            feedback={mutationFeedback}
                          >
                            {nextSignalStatus === 'open' ? 'Reopen' : 'Mark routed'}
                          </MutationButton>
                          <MutationButton
                            action="signals.feedback"
                            actionKey={signalFeedbackKey}
                            args={{ signalId: signal.id, label: 'useful', note: 'Admin operator feedback' }}
                            busyText="Saving..."
                            disabled={!canUseAdminMutations}
                            feedback={mutationFeedback}
                          >
                            Useful
                          </MutationButton>
                          <MutationButton
                            action="signals.handoff"
                            actionKey={signalHandoffKey}
                            args={{ signalId: signal.id, target: 'crm', note: 'Admin operator CRM handoff' }}
                            busyText="Queueing..."
                            disabled={!canUseAdminMutations}
                            feedback={mutationFeedback}
                          >
                            Handoff
                          </MutationButton>
                        </div>
                        <InlineError message={mutationFeedback.errorFor(signalAssignKey, signalStatusKey, signalFeedbackKey, signalHandoffKey)} />
                      </span>
                    </div>
                  );
                })}
                {visibleOperatorSignals.length === 0 && (
                  <div className="operator-row" role="row">
                    <span role="cell">
                      <strong>No signals match the current filters.</strong>
                      <small>Adjust status, owner, or flow for {tenant.domain}.</small>
                    </span>
                  </div>
                )}
              </div>
              <CommandStrip
                commands={[
                  'npm run admin -- signals --json',
                  `npm run admin -- signals assign ${tenantSignals[0]?.id ?? '<signalId>'} ${signalOwnerOptions[0]?.id ?? '<userId>'}`,
                  `npm run admin -- signals status ${tenantSignals[0]?.id ?? '<signalId>'} routed`,
                  `npm run admin -- signals feedback ${tenantSignals[0]?.id ?? '<signalId>'} useful Admin_operator_feedback`,
                  `npm run admin -- signals handoff ${tenantSignals[0]?.id ?? '<signalId>'} crm Admin_operator_CRM_handoff`,
                ]}
              />
            </article>
            <article className="ops-panel">
              <PanelHead icon={Route} title="Signal handoffs" action={`${tenantSignalHandoffs.length} handoffs`} />
              <AdminTable
                columns={['Signal', 'Target', 'Status', 'Owner', 'Provider']}
                rows={tenantSignalHandoffs.length
                  ? tenantSignalHandoffs.map((handoff) => [
                      handoff.signalId,
                      titleize(handoff.target),
                      titleize(handoff.status),
                      ownerName(data.users, handoff.ownerUserId ?? ''),
                      handoff.providerRef ?? handoff.provider,
                    ])
                  : [['No handoffs', '-', '-', '-', 'Queue CRM or task handoffs from the signal table']]}
              />
            </article>
          </section>
        )}

        {activeTab === 'platform' && platformSubRoute === 'accounts' && (
          <section className="admin-two-column is-visible" data-reveal>
            <article className="ops-panel">
              <PanelHead icon={Users} title="Accounts operator" action={`${tenantAccountProfiles.length} profiles`} />
              <div className="account-list operator-account-list">
                {tenantAccountProfiles.map((account) => {
                  const openActions = tenantAccountActions.filter((action) => action.account === account.name && action.status === 'open').length;
                  return (
                    <button
                      className="account-health-card"
                      data-selected={selectedOperatorAccount?.id === account.id}
                      key={account.id}
                      type="button"
                      onClick={() => setSelectedOperatorAccountId(account.id)}
                    >
                      <div>
                        <span>{account.stage}</span>
                        <strong>{account.name}</strong>
                        <small>{ownerName(data.users, account.ownerUserId)} · {openActions} open action{openActions === 1 ? '' : 's'}</small>
                      </div>
                      <div className="account-health-score">
                        <strong>{account.healthScore}</strong>
                        <small>{titleize(account.healthTrend)}</small>
                      </div>
                    </button>
                  );
                })}
                {tenantAccountProfiles.length === 0 && (
                  <div className="empty-state">
                    <strong>No account profiles for this tenant.</strong>
                    <small>Run account enrichment or switch the admin context tenant.</small>
                  </div>
                )}
              </div>
              <CommandStrip
                commands={[
                  'npm run admin -- accounts --json',
                  `npm run admin -- accounts timeline ${selectedOperatorAccount?.id ?? '<accountId>'}`,
                  `npm run admin -- accounts review ${selectedOperatorAccount?.id ?? '<accountId>'} Admin_operator_review`,
                  `npm run admin -- accounts action ${selectedAccountActions[0]?.id ?? '<actionId>'} done`,
                ]}
              />
            </article>
            <article className="ops-panel wide-panel">
              <PanelHead icon={Gauge} title="Account review workspace" action={selectedOperatorAccount?.name ?? tenant.domain} />
              {selectedOperatorAccount ? (
                <>
                  <div className="account-health-summary">
                    <span>{selectedOperatorAccount.domain}</span>
                    <strong>{selectedOperatorAccount.name}</strong>
                    <small>
                      {selectedOperatorAccount.stage} · {ownerName(data.users, selectedOperatorAccount.ownerUserId)} · Health {selectedOperatorAccount.healthScore} {titleize(selectedOperatorAccount.healthTrend)}
                    </small>
                  </div>
                  <div className="filter-row account-review-input-row">
                    <label>
                      <span>Review note</span>
                      <input value={accountReviewNote} onChange={(event) => setAccountReviewNote(event.target.value)} placeholder="Operator review note" />
                    </label>
                  </div>
                  <div className="button-row compact-actions">
                    <MutationButton
                      action="accounts.review"
                      actionKey={`admin-account-review-${selectedOperatorAccount.id}`}
                      args={{ account: selectedOperatorAccount.name, note: accountReviewNote || 'Admin operator review' }}
                      busyText="Recording..."
                      disabled={!canUseAdminMutations}
                      feedback={mutationFeedback}
                    >
                      Add review note
                    </MutationButton>
                  </div>
                  <InlineError message={mutationFeedback.errorFor(`admin-account-review-${selectedOperatorAccount.id}`)} />
                  <div className="operator-section-grid">
                    <section>
                      <h3>Recommendations</h3>
                      <div className="account-detail-stack">
                        {selectedAccountRecommendations.map((recommendation) => (
                          <AccountRecommendationCard key={recommendation.id} owner={ownerName(data.users, recommendation.ownerUserId)} recommendation={recommendation} />
                        ))}
                        {selectedAccountRecommendations.length === 0 && (
                          <div className="empty-state">
                            <strong>No recommendations.</strong>
                            <small>Recommendations appear after source-backed relationship analysis.</small>
                          </div>
                        )}
                      </div>
                    </section>
                    <section>
                      <h3>Actions</h3>
                      <div className="account-detail-stack">
                        {selectedAccountActions.map((action) => {
                          const actionDoneKey = `admin-account-action-done-${action.id}`;
                          return (
                            <div className="account-action-card" key={action.id}>
                              <div>
                                <span>{titleize(action.priority)} priority</span>
                                <strong>{action.title}</strong>
                                <small>{action.description}</small>
                                <small>{ownerName(data.users, action.ownerUserId)} · Due {new Date(action.dueAt).toLocaleDateString()}</small>
                              </div>
                              <div className="card-actions">
                                <span className={`status-pill ${action.status}`}>{titleize(action.status)}</span>
                                <MutationButton
                                  action="accounts.action-status"
                                  actionKey={actionDoneKey}
                                  args={{ actionId: action.id, status: 'done' }}
                                  busyText="Marking..."
                                  disabled={!canUseAdminMutations || action.status === 'done'}
                                  feedback={mutationFeedback}
                                >
                                  Mark done
                                </MutationButton>
                                <InlineError message={mutationFeedback.errorFor(actionDoneKey)} />
                              </div>
                            </div>
                          );
                        })}
                        {selectedAccountActions.length === 0 && (
                          <div className="empty-state">
                            <strong>No account actions.</strong>
                            <small>Open actions appear here when detectors or reviews create next steps.</small>
                          </div>
                        )}
                      </div>
                    </section>
                    <section>
                      <h3>Timeline</h3>
                      <div className="account-detail-stack">
                        {selectedAccountEvents.map((event) => (
                          <AccountEventRow event={event} key={event.id} />
                        ))}
                        {selectedAccountEvents.length === 0 && (
                          <div className="empty-state">
                            <strong>No timeline events.</strong>
                            <small>Account reviews, signal handoffs, and next actions add events.</small>
                          </div>
                        )}
                      </div>
                    </section>
                    <section>
                      <h3>Reviews</h3>
                      <div className="account-detail-stack">
                        {selectedAccountReviews.map((review) => (
                          <AccountReviewCard key={review.id} review={review} reviewer={ownerName(data.users, review.createdByUserId)} />
                        ))}
                        {selectedAccountReviews.length === 0 && (
                          <div className="empty-state">
                            <strong>No review snapshots.</strong>
                            <small>Add a review note to create the first operator snapshot.</small>
                          </div>
                        )}
                      </div>
                    </section>
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  <strong>No account selected.</strong>
                  <small>Choose an account profile to review recommendations, actions, and timeline events.</small>
                </div>
              )}
            </article>
          </section>
        )}

        {activeTab === 'platform' && platformSubRoute === 'governance' && (
          <section className="admin-two-column is-visible" data-reveal>
            <article className="ops-panel">
              <PanelHead icon={ShieldCheck} title="Retention and redaction" action={`${governancePolicy?.sourceRetentionDays ?? '-'} day source retention`} />
              {governancePolicy && (
                <GovernancePolicyCard
                  canMutate={source === 'api' && !isMutating}
                  onPolicy={(patch) => mutate('governance.policy', { tenantId: tenant.id, ...patch })}
                  policy={governancePolicy}
                  updatedBy={ownerName(data.users, governancePolicy.updatedByUserId)}
                />
              )}
              <div className="button-row compact-actions">
                <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('governance.redaction-add', { tenantId: tenant.id, scope: 'exports', label: 'Customer names', pattern: 'customer name|customer contact', replacement: '[customer]' })}>
                  Add export redaction
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('governance.redaction-add', { tenantId: tenant.id, scope: 'source_snippets', label: 'Contract terms', pattern: 'msa|pricing|discount', replacement: '[contract detail]' })}>
                  Add contract redaction
                </button>
              </div>
              <div className="governance-stack">
                {tenantRedactionRules.map((rule) => (
                  <RedactionRuleCard
                    canMutate={source === 'api' && !isMutating}
                    key={rule.id}
                    onStatus={(status) => mutate('governance.redaction-status', { ruleId: rule.id, status })}
                    rule={rule}
                  />
                ))}
              </div>
              <CommandStrip commands={['npm run admin -- governance --json', 'npm run admin -- governance policy tenant_demo 14 3 14 strict manual', 'npm run admin -- governance redact tenant_demo exports Customer_names customer_name [customer]', 'npm run admin -- governance redaction-rule <ruleId> disabled']} />
            </article>
            <article className="ops-panel">
              <PanelHead icon={Database} title="Export, delete, and incidents" action={`${activeDataRequests.length} active requests · ${openIncidentNotes.length} open incidents`} />
              <div className="button-row compact-actions">
                <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('governance.request-create', { tenantId: tenant.id, type: 'export', requesterEmail: 'ops@acmehealth.example', targetAccount: 'Acme Health', note: 'Dashboard export review' })}>
                  New export request
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('governance.request-create', { tenantId: tenant.id, type: 'delete', requesterEmail: 'privacy@acmehealth.example', targetAccount: 'Acme Health', note: 'Dashboard delete review' })}>
                  New delete request
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('governance.incident-add', { tenantId: tenant.id, severity: 'watch', title: 'Mailbox governance watch', body: 'Review source scope and reauthorization before next sync window.' })}>
                  Add watch note
                </button>
              </div>
              <div className="governance-stack">
                {latestDataRequests.map((request) => (
                  <DataRequestCard
                    canMutate={source === 'api' && !isMutating}
                    key={request.id}
                    onStatus={(status) => mutate('governance.request-status', { requestId: request.id, status, note: `Marked ${status} from admin console` })}
                    request={request}
                  />
                ))}
              </div>
              <div className="governance-stack">
                {latestIncidentNotes.map((note) => (
                  <IncidentNoteCard
                    canMutate={source === 'api' && !isMutating}
                    key={note.id}
                    note={note}
                    onResolve={() => mutate('governance.incident-resolve', { incidentId: note.id })}
                    owner={ownerName(data.users, note.createdByUserId)}
                  />
                ))}
              </div>
              <AdminTable
                columns={['Metric', 'Count', 'State']}
                rows={[
                  ['Active redaction', String(summary.activeRedactionRules ?? activeRedactionRules.length), 'Local rules'],
                  ['Open requests', String(summary.openDataRequests ?? activeDataRequests.length), 'Export/delete'],
                  ['Open incidents', String(summary.openIncidentNotes ?? openIncidentNotes.length), 'Operations'],
                ]}
              />
              <CommandStrip commands={['npm run admin -- governance request tenant_demo export ops@acme.example Acme_Health', 'npm run admin -- governance request-status <requestId> completed Export_ready', 'npm run admin -- governance incident tenant_demo watch Outlook_reauth', 'npm run admin -- governance resolve-incident <incidentId>']} />
            </article>
          </section>
        )}

        {activeTab === 'integrations' && (
          <section className="admin-two-column is-visible" data-reveal>
            <article className="ops-panel">
              <PanelHead icon={Plug} title="Provider readiness" action={providerReadiness.ok ? 'Ready for live providers' : `${providerReadiness.summary.missingRequired} env vars missing`} />
              <div className="integration-stack">
                {providerReadiness.providers.map((provider) => (
                  <ProviderReadinessCard key={provider.id} provider={provider} />
                ))}
              </div>
            </article>
            <article className="ops-panel">
              <PanelHead icon={ShieldCheck} title="Live integration boundaries" action="No secrets in local state" />
              <div className="check-list">
                <CheckItem ok={providerReadiness.providers.some((provider) => provider.id === 'gmail')} label="Gmail uses OAuth callbacks, encrypted credential vaulting, and webhook paths." />
                <CheckItem ok={providerReadiness.providers.some((provider) => provider.id === 'outlook')} label="Outlook uses Graph OAuth callbacks, encrypted credential vaulting, and subscription webhook paths." />
                <CheckItem ok={providerReadiness.providers.some((provider) => provider.id === 'outbound-email')} label="Outbound digest email uses generic or SendGrid provider handoff, signed status webhooks, SendGrid compliance controls, and unsubscribe suppression." />
                <CheckItem ok={providerReadiness.providers.some((provider) => provider.id === 'stripe')} label="Stripe readiness separates checkout, billing portal return, and signed webhook handling." />
                <CheckItem ok={!providerReadiness.ok} label={providerReadiness.ok ? 'All provider env requirements are configured.' : 'Missing env vars are reported by name only, never by value.'} />
              </div>
              <AdminTable
                columns={['Provider', 'Callback', 'Webhook']}
                rows={providerReadiness.providers.map((provider) => [provider.label, provider.callbackPath, provider.webhookPath])}
              />
              <CommandStrip commands={['npm run admin -- integrations', 'npm run admin -- integrations --json', 'curl http://127.0.0.1:8787/api/integrations']} />
            </article>
            {providerHandoff ? (
              <article className="ops-panel wide-panel">
                <PanelHead
                  icon={Radar}
                  title="Provider handoff"
                  action={providerHandoff.productionReady ? 'Ready for evidence' : `${providerHandoff.summary.blocked} blocked`}
                />
                <div className="check-list">
                  <CheckItem ok={providerHandoff.ok} label="Provider handoff ranks signed-session, Gmail, Outlook, SendGrid/outbound email, and Stripe launch work for the local agent." />
                  <CheckItem ok={providerHandoff.summary.secretSafe} label="Provider handoff is secret-safe and only shows env names, placeholders, commands, digests, and request IDs." />
                  <CheckItem ok={providerHandoff.productionReady} label={providerHandoff.productionReady ? 'Provider launch rows are production-ready.' : providerHandoff.recommendation.productionGuardrail} />
                  <CheckItem ok={providerHandoff.nextAction.id === 'provider_launch_evidence' || providerHandoff.nextAction.command.length > 0} label={`Next provider action: ${providerHandoff.nextAction.label} owned by ${titleize(providerHandoff.nextAction.owner)}.`} />
                </div>
                <AdminTable
                  columns={['Priority', 'Provider', 'Action', 'Status', 'Owner', 'Env', 'Command']}
                  rows={providerHandoffRows.length ? providerHandoffRows : [['-', 'all', 'Provider launch evidence package', 'Ready For Proof', 'Integrations', '-', providerHandoff.nextAction.command]]}
                />
                <AdminTable
                  columns={['Provider', 'Status', 'Config', 'Sandbox', 'Schedule', 'Command']}
                  rows={providerHandoff.providerRows.map((row) => [
                    row.label,
                    titleize(row.status),
                    row.configurationReady ? 'Configured' : `${row.missingEnv.length} env missing`,
                    titleize(row.sandboxStatus),
                    row.scheduleReady ? 'Active' : 'Needs schedule',
                    row.localAgentCommand,
                  ])}
                />
                <CommandStrip commands={['npm run admin -- provider-handoff --json', 'npm run admin -- provider-handoff --env-file ./.env.production --json', 'curl http://127.0.0.1:8787/api/provider-handoff', 'npm run admin -- provider-launch --env-file ./.env.production --json', 'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json', 'npm run admin -- integrations run-scheduled --force --json', 'npm run admin -- payment-lifecycle --env-file ./.env.production --json']} />
              </article>
            ) : (
              <ReportLoadingPanel icon={Radar} title="Provider handoff" wide />
            )}
            <article className="ops-panel">
              <PanelHead
                icon={RefreshCw}
                title="Provider validation schedule"
                action={`${summary.activeProviderValidationSchedules ?? providerValidationSchedules.filter((schedule) => schedule.status === 'active').length}/${summary.providerValidationSchedules ?? providerValidationSchedules.length} active`}
              />
              <div className="check-list">
                <CheckItem ok={providerValidationSchedules.length > 0} label="Gmail, Outlook, SendGrid, and Stripe sandbox checks have auditable local schedules." />
                <CheckItem ok={dueProviderValidationSchedules.length === 0} label={dueProviderValidationSchedules.length ? `${dueProviderValidationSchedules.length} provider validation schedule${dueProviderValidationSchedules.length === 1 ? '' : 's'} due for a sandbox run.` : 'No provider validation schedule is currently due.'} />
                <CheckItem ok={true} label="Schedules store provider IDs, cadence, timestamps, and env variable names only." />
              </div>
              <div className="button-row compact-actions">
                <button className="inline-action" disabled={isValidatingSandbox || source !== 'api'} type="button" onClick={() => void runScheduledValidation(false)}>
                  Run due
                </button>
                <button className="inline-action" disabled={isValidatingSandbox || source !== 'api'} type="button" onClick={() => void runScheduledValidation(true)}>
                  Run all now
                </button>
              </div>
              <div className="integration-stack">
                {providerValidationSchedules.map((schedule) => (
                  <div className="provider-readiness-card" key={schedule.id}>
                    <div className="provider-readiness-head">
                      <div>
                        <span className={`provider-badge ${schedule.providerId}`}>{schedule.category}</span>
                        <strong>{schedule.providerLabel}</strong>
                        <small>
                          {titleize(schedule.cadence)} cadence · Last {schedule.lastRunStatus ? titleize(schedule.lastRunStatus) : 'not run'} · Next {schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : 'manual'}
                        </small>
                      </div>
                      <span className={`status-pill ${schedule.status === 'active' ? 'connected' : 'paused'}`}>
                        {titleize(schedule.status)}
                      </span>
                    </div>
                    <div className="env-list">
                      {schedule.requiredEnv.map((item) => (
                        <span className="is-optional" key={`${schedule.id}-${item}`}>{item}</span>
                      ))}
                    </div>
                    <div className="button-row compact-actions">
                      <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('integrations.schedule', { providerId: schedule.providerId, cadence: 'daily', status: 'active' })}>
                        Daily
                      </button>
                      <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('integrations.schedule', { providerId: schedule.providerId, cadence: 'weekly', status: 'active' })}>
                        Weekly
                      </button>
                      <button className="inline-action" disabled={isMutating || source !== 'api' || schedule.status === 'paused'} type="button" onClick={() => mutate('integrations.schedule', { providerId: schedule.providerId, status: 'paused' })}>
                        Pause
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <AdminTable
                columns={['Provider', 'Cadence', 'Status', 'Last', 'Next']}
                rows={providerValidationSchedules.length
                  ? providerValidationSchedules.map((schedule) => [
                      schedule.providerId,
                      titleize(schedule.cadence),
                      titleize(schedule.status),
                      schedule.lastRunAt ? new Date(schedule.lastRunAt).toLocaleString() : '-',
                      schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : '-',
                    ])
                  : [['No schedules', '-', '-', '-', '-']]}
              />
              <CommandStrip commands={['npm run admin -- integrations run-scheduled --json', 'npm run admin -- integrations run-scheduled --force --json', 'npm run admin -- integrations schedule stripe weekly --json', 'curl -X POST http://127.0.0.1:8787/api/integrations/scheduled -d \'{"force":true}\'']} />
            </article>
            <article className="ops-panel">
              <PanelHead
                icon={RefreshCw}
                title={providerHandoff ? 'Provider sandbox validation' : 'Loading provider reports'}
                action={providerSandbox ? `${providerSandbox.summary.passed}/${providerSandbox.summary.total} passed` : 'Run on demand'}
              />
              <div className="check-list">
                <CheckItem
                  ok={providerSandbox?.ok ?? false}
                  label={
                    providerSandbox
                      ? `Last validation ${providerSandbox.ok ? 'passed' : 'needs attention'} at ${new Date(providerSandbox.generatedAt).toLocaleString()}.`
                      : 'Run a sandbox check before enabling live Gmail, Outlook, SendGrid, or Stripe flows.'
                  }
                />
                <CheckItem ok={true} label="The report records provider status, missing variable names, request digests, and provider request IDs without storing secrets." />
                <CheckItem ok={true} label="Evidence artifacts can be exported and replayed for QA without provider credential values." />
              </div>
              <div className="button-row">
                <button className="inline-action" disabled={isValidatingSandbox || source !== 'api'} type="button" onClick={() => void validateSandbox()}>
                  {isValidatingSandbox ? 'Validating...' : 'Validate sandbox'}
                </button>
              </div>
              {providerSandbox ? (
                <AdminTable
                  columns={['Provider', 'Status', 'Checks', 'Missing']}
                  rows={providerSandbox.providers.map((provider) => [
                    provider.label,
                    titleize(provider.status),
                    String(provider.checks.length),
                    provider.missingRequired.length ? provider.missingRequired.join(', ') : '-',
                  ])}
                />
              ) : (
                <AdminTable
                  columns={['Provider', 'Status', 'Checks', 'Missing']}
                  rows={[
                    ['Gmail', 'Not run', '-', 'SIGNAL_GMAIL_ACCESS_TOKEN'],
                    ['Outlook', 'Not run', '-', 'SIGNAL_OUTLOOK_ACCESS_TOKEN'],
                    ['SendGrid', 'Not run', '-', 'SIGNAL_SENDGRID_API_KEY'],
                    ['Stripe', 'Not run', '-', 'STRIPE_SECRET_KEY, SIGNAL_STRIPE_PRICE_TEAM'],
                  ]}
                />
              )}
              <AdminTable
                columns={['Run', 'Status', 'Passed', 'Recorded', 'Digest']}
                rows={providerValidationRuns.length
                  ? providerValidationRuns.slice(0, 5).map((run) => [
                      run.id,
                      titleize(run.status),
                      `${run.summary.passed}/${run.summary.total}`,
                      new Date(run.recordedAt).toLocaleString(),
                      run.reportDigest,
                    ])
                  : [['No recorded runs', '-', '-', '-', '-']]}
              />
              <CommandStrip commands={['npm run admin -- integrations validate-sandbox --json', 'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json', 'npm run admin -- integrations evidence-export latest ./signal-provider-evidence.json --json', 'npm run admin -- integrations evidence-import ./signal-provider-evidence.json --json', 'curl -X POST http://127.0.0.1:8787/api/integrations/sandbox']} />
            </article>
          </section>
        )}

        {activeTab === 'billing' && (
          <section className="admin-two-column is-visible" data-reveal>
            <article className="ops-panel">
              <PanelHead icon={CreditCard} title="Plans and entitlements" action="Local test provider" />
              <div className="entitlement-card">
                <span>Current entitlement</span>
                <strong>{entitlement ? titleize(entitlement.status) : 'Missing'}</strong>
                <small>
                  {entitlement
                    ? `${entitlement.seatLimit} seats · ${entitlement.mailboxLimit} mailboxes · ${entitlement.signalLimit.toLocaleString()} signals · ${entitlement.retentionDays} day retention`
                    : 'Run a checkout, comp, or webhook event to compute access.'}
                </small>
                {entitlement && (
                  <div className="entitlement-grid">
                    <span>{tenantUsers.length}/{entitlement.seatLimit} seats</span>
                    <span>{tenantMailboxes.length}/{entitlement.mailboxLimit} sources</span>
                    <span>{tenantSignals.length}/{entitlement.signalLimit.toLocaleString()} seeded signals</span>
                  </div>
                )}
                {entitlement?.overrideId && (
                  <small>Override source {titleize(entitlement.overrideType ?? 'manual_entitlement')} · {entitlement.overrideId}</small>
                )}
              </div>
              {data.plans.map((item) => (
                <div className="plan-row" key={item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    <small>{item.seatLimit} seats · {item.mailboxLimit} mailboxes · {item.signalLimit.toLocaleString()} signals</small>
                  </div>
                  <span>{formatCurrency(item.monthlyCents)}</span>
                </div>
              ))}
            </article>
            <article className="ops-panel">
              <PanelHead icon={ShieldCheck} title="Billing overrides" action={`${activeBillingOverrides.length} active`} />
              <AdminTable
                columns={['Override', 'Type', 'Status', 'Value', 'Reason']}
                rows={billingOverrides.length
                  ? billingOverrides.slice(0, 6).map((override) => [override.id, titleize(override.type), titleize(override.status), billingOverrideValue(override), override.reason])
                  : [['No overrides', '-', '-', '-', 'Record beta access, support credits, or manual entitlement changes']]}
              />
              <div className="button-row">
                <MutationButton
                  action="payments.override"
                  actionKey="admin-payment-override-beta"
                  args={{ tenantId: tenant.id, type: 'beta_access', reason: 'Beta extension', planId: 'plan_beta' }}
                  busyText="Applying..."
                  disabled={isMutating || source !== 'api'}
                  feedback={mutationFeedback}
                >
                  Beta access
                </MutationButton>
                <MutationButton
                  action="payments.override"
                  actionKey="admin-payment-override-credit"
                  args={{ tenantId: tenant.id, type: 'support_credit', reason: 'Onboarding credit', amountCents: 2500 }}
                  busyText="Applying..."
                  disabled={isMutating || source !== 'api'}
                  feedback={mutationFeedback}
                >
                  Support credit
                </MutationButton>
                <MutationButton
                  action="payments.override"
                  actionKey="admin-payment-override-manual"
                  args={{ tenantId: tenant.id, type: 'manual_entitlement', reason: 'Support access', planId: checkoutTeamPlanId }}
                  busyText="Applying..."
                  disabled={isMutating || source !== 'api'}
                  feedback={mutationFeedback}
                >
                  Manual access
                </MutationButton>
                <MutationButton
                  action="payments.override-revoke"
                  actionKey="admin-payment-override-revoke"
                  args={{ overrideId: activeBillingOverrides[0]?.id, reason: 'Resolved locally' }}
                  busyText="Revoking..."
                  disabled={isMutating || source !== 'api' || !activeBillingOverrides[0]}
                  feedback={mutationFeedback}
                >
                  Revoke latest
                </MutationButton>
              </div>
              <InlineError message={mutationFeedback.errorFor('admin-payment-override-beta', 'admin-payment-override-credit', 'admin-payment-override-manual', 'admin-payment-override-revoke')} />
              <CommandStrip commands={['npm run admin -- payments override tenant_demo beta_access Beta_extension plan_beta', 'npm run admin -- payments override tenant_demo support_credit Onboarding_credit 2500', 'npm run admin -- payments override tenant_demo manual_entitlement Support_access plan_team', 'npm run admin -- payments override-revoke <overrideId> Resolved']} />
            </article>
            <article className="ops-panel">
              <PanelHead icon={WalletCards} title="Subscription handling" action={`${recoverableInvoices.length} recoverable invoice${recoverableInvoices.length === 1 ? '' : 's'}`} />
              <div className="subscription-card subscription-card-expanded">
                <div className="subscription-summary">
                  <span>{subscription?.provider ?? 'missing provider'}</span>
                  <strong>{subscription?.status ? titleize(subscription.status) : 'No subscription'}</strong>
                  <small>Trial ends {subscription?.trialEndsAt ? new Date(subscription.trialEndsAt).toLocaleDateString() : 'not set'}</small>
                </div>
                <div className="provider-link-grid" aria-label="Payment provider identifiers">
                  <span>Customer <strong>{subscription?.providerCustomerId ?? subscription?.stripeCustomerId ?? 'local'}</strong></span>
                  <span>Subscription <strong>{subscription?.providerSubscriptionId ?? subscription?.stripeSubscriptionId ?? subscription?.id ?? 'missing'}</strong></span>
                  <span>Provider status <strong>{subscription?.providerStatus ?? subscription?.status ?? 'missing'}</strong></span>
                  <span>Synced <strong>{subscription?.providerSyncedAt ? new Date(subscription.providerSyncedAt).toLocaleDateString() : 'local'}</strong></span>
                </div>
              </div>
              <div className="invoice-stack">
                {recentInvoices.map((invoice) => (
                  <InvoiceCard
                    invoice={invoice}
                    key={invoice.id}
                    action={
                      ['open', 'past_due'].includes(invoice.status) ? (
                        <>
                          <MutationButton
                            action="payments.recover"
                            actionKey={`admin-payment-recover-${invoice.id}`}
                            args={{ invoiceId: invoice.id }}
                            busyText="Creating..."
                            disabled={isMutating || source !== 'api'}
                            feedback={mutationFeedback}
                          >
                            Recovery link
                          </MutationButton>
                          <InlineError message={mutationFeedback.errorFor(`admin-payment-recover-${invoice.id}`)} />
                        </>
                      ) : null
                    }
                  />
                ))}
              </div>
              <AdminTable
                columns={['Session', 'Provider', 'Mode', 'Type', 'Provider ref']}
                rows={latestBillingSessions.map((session) => [session.id, session.provider, session.providerMode ?? 'local', session.type, session.providerSessionId ?? session.providerRequestDigest ?? 'local'])}
              />
              <AdminTable
                columns={['Event', 'Provider', 'Status', 'Provider event']}
                rows={recentPaymentEvents.map((event) => [event.type, event.provider, event.signatureStatus ?? event.status, event.providerEventId ?? event.appliedType ?? 'local'])}
              />
              <h3>Lifecycle notices</h3>
              <AdminTable
                columns={['Area', 'Trigger', 'Severity', 'Status', 'Action']}
                rows={lifecycleNoticeRows(paymentLifecycleNotices, 8)}
              />
              <div className="button-row">
                <MutationButton
                  action="payments.checkout"
                  actionKey="admin-payment-checkout"
                  args={{ planId: checkoutTeamPlanId, tenantId: tenant.id }}
                  busyText="Creating..."
                  disabled={isMutating || source !== 'api'}
                  feedback={mutationFeedback}
                >
                  Create team checkout
                </MutationButton>
                <MutationButton
                  action="payments.portal"
                  actionKey="admin-payment-portal"
                  args={{ tenantId: tenant.id }}
                  busyText="Creating..."
                  disabled={isMutating || source !== 'api'}
                  feedback={mutationFeedback}
                >
                  Create portal session
                </MutationButton>
                <MutationButton
                  action="payments.sync"
                  actionKey="admin-payment-sync"
                  args={{ tenantId: tenant.id }}
                  busyText="Syncing..."
                  disabled={isMutating || source !== 'api'}
                  feedback={mutationFeedback}
                >
                  Sync billing state
                </MutationButton>
                <MutationButton
                  action="payments.override"
                  actionKey="admin-payment-beta-comp"
                  args={{ planId: 'plan_beta', reason: 'Beta comp', tenantId: tenant.id, type: 'beta_access' }}
                  busyText="Applying..."
                  disabled={isMutating || source !== 'api'}
                  feedback={mutationFeedback}
                >
                  Apply beta comp
                </MutationButton>
                {subscription && (
                  <>
                    <MutationButton
                      action="payments.webhook"
                      actionKey="admin-payment-webhook-failed"
                      args={{ subscriptionId: subscription.id, type: 'invoice.payment_failed' }}
                      busyText="Simulating..."
                      disabled={isMutating || source !== 'api'}
                      feedback={mutationFeedback}
                    >
                      Simulate failed payment
                    </MutationButton>
                    <MutationButton
                      action="payments.webhook"
                      actionKey="admin-payment-webhook-paid"
                      args={{ subscriptionId: subscription.id, type: 'invoice.paid' }}
                      busyText="Simulating..."
                      disabled={isMutating || source !== 'api'}
                      feedback={mutationFeedback}
                    >
                      Simulate invoice paid
                    </MutationButton>
                    <MutationButton
                      action="payments.cancel"
                      actionKey="admin-payment-cancel"
                      args={{ subscriptionId: subscription.id }}
                      busyText="Canceling..."
                      disabled={isMutating || source !== 'api'}
                      feedback={mutationFeedback}
                    >
                      Cancel subscription
                    </MutationButton>
                  </>
                )}
              </div>
              <InlineError message={mutationFeedback.errorFor('admin-payment-checkout', 'admin-payment-portal', 'admin-payment-sync', 'admin-payment-beta-comp', 'admin-payment-webhook-failed', 'admin-payment-webhook-paid', 'admin-payment-cancel')} />
              <CommandStrip commands={['npm run admin -- payments sync tenant_demo', 'npm run admin -- payments checkout tenant_demo plan_team', 'npm run admin -- payments checkout tenant_demo plan_team --live-provider', 'npm run admin -- payments portal tenant_demo --live-provider', 'npm run admin -- payments override tenant_demo beta_access Beta_extension plan_beta', 'npm run admin -- payments webhook invoice.payment_failed sub_demo', 'npm run admin -- payments webhook subscription.updated sub_demo past_due', 'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>', 'npm run admin -- payments recover <invoiceId>', 'npm run admin -- payments cancel sub_demo']} />
            </article>
            {paymentHandoff ? (
              <article className="ops-panel">
                <PanelHead
                  icon={WalletCards}
                  title="Payment launch handoff"
                  action={paymentHandoff.productionReady ? 'Production ready' : `${paymentHandoff.summary.blocked} steps need proof`}
                />
                <div className="check-list">
                  <CheckItem ok={paymentHandoff.ok} label="Payment launch handoff is secret-safe and ranks Stripe env, Checkout/Portal, signed webhooks, failed-payment recovery, cancellation/resubscription, entitlements, sandbox evidence, and rollback." />
                  <CheckItem ok={paymentHandoff.productionReady} label={paymentHandoff.productionReady ? 'Payment launch proof is complete.' : `Next payment step: ${paymentHandoff.nextStep.label} owned by ${titleize(paymentHandoff.nextStep.owner)}.`} />
                  <CheckItem ok={paymentHandoff.summary.secretSafe} label="Payment handoff commands expose environment variable names and placeholders only; credential values stay out of the report." />
                  <CheckItem ok={paymentHandoff.payment.signedWebhookEvents > 0} label={`${paymentHandoff.payment.signedWebhookEvents} signed Stripe-style webhook event(s) are available for launch evidence.`} />
                </div>
                <AdminTable
                  columns={['Priority', 'Step', 'Status', 'Owner', 'Missing env', 'Blocker', 'Command', 'Rollback']}
                  rows={paymentHandoffRows}
                />
                <CommandStrip commands={['npm run admin -- payment-handoff --json', 'npm run admin -- payment-handoff --env-file ./.env.production --json', 'curl http://127.0.0.1:8787/api/payment-handoff', 'npm run admin -- payments checkout tenant_demo plan_team --live-provider', 'npm run admin -- payments portal tenant_demo --live-provider', 'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>', 'npm run admin -- payments recover <invoiceId>', 'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json']} />
              </article>
            ) : (
              <ReportLoadingPanel icon={WalletCards} title="Payment launch handoff" />
            )}
            {paymentLifecycle ? (
              <article className="ops-panel">
                <PanelHead
                  icon={CreditCard}
                  title="Payment lifecycle audit"
                  action={`${paymentLifecycle.summary.localReady}/${paymentLifecycle.summary.total} local checks`}
                />
                <div className="check-list">
                  <CheckItem ok={paymentLifecycle.ok} label="Subscription start, Checkout/Portal, failed payment recovery, cancellation, entitlements, and signed webhook replay pass locally." />
                  <CheckItem ok={paymentLifecycle.productionReady} label={paymentLifecycle.productionReady ? 'Payment lifecycle is production-ready.' : paymentLifecycle.recommendation.productionGuardrail} />
                  <CheckItem ok={paymentLifecycle.summary.signedWebhookEvents > 0} label={`${paymentLifecycle.summary.signedWebhookEvents} verified Stripe-style webhook event(s) are recorded without exposing raw secrets.`} />
                </div>
                <AdminTable
                  columns={['Area', 'Local', 'Production', 'Evidence', 'Command']}
                  rows={paymentLifecycle.rows.map((row) => [
                    titleize(row.area),
                    row.localOk ? 'Ready' : 'Attention',
                    row.productionOk ? 'Ready' : 'Needs live provider',
                    row.evidence.join(' · '),
                    row.commands[0] ?? '-',
                  ])}
                />
                <CommandStrip commands={['npm run admin -- payment-lifecycle --json', 'curl http://127.0.0.1:8787/api/payment-lifecycle', 'npm run admin -- payment-lifecycle --env-file ./.env.production --json', 'npm run admin -- provider-launch --env-file ./.env.production --json', 'npm run admin -- payments refund <invoiceId> 2500 Courtesy_credit', 'npm run admin -- payments sync tenant_demo --live-provider']} />
              </article>
            ) : (
              <ReportLoadingPanel icon={CreditCard} title="Payment lifecycle audit" />
            )}
            {lifecyclePlaybook ? (
              <article className="ops-panel">
                <PanelHead
                  icon={Workflow}
                  title="Lifecycle playbook"
                  action={`${lifecyclePlaybook.summary.ready}/${lifecyclePlaybook.summary.total} ready`}
                />
                <div className="check-list">
                  <CheckItem ok={lifecyclePlaybook.ok} label={lifecyclePlaybook.ok ? 'Onboarding, RBAC/privacy, source, notification, and billing lifecycle handling is locally mapped.' : `${lifecyclePlaybook.summary.attention} lifecycle playbook row needs attention.`} />
                  <CheckItem ok={lifecyclePlaybook.summary.secretSafe} label="Lifecycle playbook commands use environment variable names and placeholders without credential values." />
                  <CheckItem ok={lifecyclePlaybook.rows.some((row) => row.id === 'failed_payment_recovery' && row.commands.some((command) => command.includes('payments recover')))} label="Failed payment recovery uses Billing recovery sessions and signed Stripe webhook replay." />
                  <CheckItem ok={lifecyclePlaybook.rows.some((row) => row.id === 'multi_member_rbac_privacy')} label="Multi-member org support is governed by membership, role, owner/team scope, and tenant-isolated data boundaries." />
                </div>
                <AdminTable
                  columns={['Flow', 'Status', 'Owner', 'Notices', 'Admin action', 'Command']}
                  rows={lifecyclePlaybookRows}
                />
                <CommandStrip commands={['npm run admin -- lifecycle-playbook --json', 'curl http://127.0.0.1:8787/api/lifecycle-playbook', 'npm run admin -- onboarding-readiness --json', 'npm run admin -- mailboxes disconnect <mailboxId>', 'npm run admin -- notifications digest tenant_demo', 'npm run admin -- payments recover <invoiceId>', 'npm run admin -- payments checkout tenant_demo plan_team', 'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>']} />
              </article>
            ) : (
              <ReportLoadingPanel icon={Workflow} title="Lifecycle playbook" />
            )}
          </section>
        )}

        {(activeTab === 'launch' || (activeTab === 'platform' && platformSubRoute === 'governance')) && (
          <section className="admin-two-column is-visible" data-reveal>
            {activeTab === 'launch' && (agentHandoff ? (
            <article className="ops-panel">
              <PanelHead
                icon={TerminalSquare}
                title="Local agent handoff"
                action={agentHandoff.goLiveReady ? 'Go-live ready' : `${agentHandoff.summary.blockedGates} blocked`}
              />
              <div className="check-list">
                <CheckItem ok={agentHandoff.ok} label={agentHandoff.ok ? 'Local operator handoff is secret-safe and backed by current readiness, launch-gate, provider, operations, and production-plan reports.' : 'Local operator handoff needs attention before it should guide agent work.'} />
                <CheckItem ok={agentHandoff.goLiveReady} label={agentHandoff.goLiveReady ? 'Every launch gate has proof; package and verify final redacted evidence.' : `Next action: ${agentHandoff.nextAction.label} owned by ${titleize(agentHandoff.nextAction.owner)}.`} />
                <CheckItem ok={agentHandoff.summary.secretSafe} label="Handoff commands expose environment variable names and placeholders only; credential values stay out of the report." />
                <CheckItem ok={agentHandoff.summary.failedJobs === 0} label={agentHandoff.summary.failedJobs === 0 ? 'No failed local worker jobs are blocking the next handoff.' : `${agentHandoff.summary.failedJobs} failed worker job needs local-agent recovery.`} />
              </div>
              <AdminTable
                columns={['Priority', 'Action', 'Status', 'Owner', 'Env', 'Blocker', 'Command']}
                rows={localAgentHandoffRows}
              />
              <CommandStrip commands={['npm run admin -- agent-handoff --json', 'npm run admin -- agent-handoff --env-file ./.env.production --json', 'curl http://127.0.0.1:8787/api/agent-handoff', 'npm run admin -- launch-gate --json', 'npm run admin -- production-plan --json']} />
            </article>
            ) : (
              <ReportLoadingPanel icon={TerminalSquare} title="Local agent handoff" />
            )
            )}
            {activeTab === 'launch' && (providerLaunch ? (
            <article className="ops-panel wide-panel">
              <PanelHead
                icon={ShieldCheck}
                title="Provider launch matrix"
                action={`${providerLaunch.summary.launchReady}/${providerLaunch.summary.total} ready`}
              />
              <div className="check-list">
                <CheckItem ok={providerLaunch.ok} label="The local agent can inspect Gmail, Outlook, SendGrid/outbound email, Stripe, and signed-session launch proof from one report." />
                <CheckItem ok={providerLaunch.productionReady} label={providerLaunch.productionReady ? 'Every provider row is production-ready.' : providerLaunch.recommendation.productionGuardrail} />
                <CheckItem ok={providerLaunch.summary.secretSafe} label="Provider launch output lists environment variable names, proof commands, digests, and request IDs without credential values." />
                <CheckItem ok={providerLaunch.rows.some((row) => row.id === 'outbound-email' && row.signedReplayCommand?.includes('webhook-signed'))} label="Outbound email and Stripe launch rows include signed webhook replay commands." />
              </div>
              <AdminTable
                columns={['Provider', 'Status', 'Owner', 'Config', 'Sandbox', 'Next command']}
                rows={providerLaunchRows}
              />
              <AdminTable
                columns={['Provider', 'Webhook', 'Evidence', 'Latest proof']}
                rows={providerLaunch.rows.map((row) => [
                  row.id,
                  row.webhookPath,
                  row.requiredEvidence.slice(0, 2).join(' | '),
                  row.latestEvidenceAt ? `${new Date(row.latestEvidenceAt).toLocaleString()} · ${row.latestEvidenceDigest ?? row.latestEvidenceRunId ?? 'recorded'}` : 'No saved provider evidence',
                ])}
              />
              <CommandStrip commands={['npm run admin -- provider-launch --json', 'npm run admin -- provider-launch --env-file ./.env.production --json', 'curl http://127.0.0.1:8787/api/provider-launch', 'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json', 'npm run admin -- mailboxes watch mbx_gmail_sales --live-provider', 'npm run admin -- notifications digest tenant_demo --live-provider', 'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>']} />
            </article>
            ) : (
              <ReportLoadingPanel icon={ShieldCheck} title="Provider launch matrix" wide />
            )
            )}
            {activeTab === 'platform' && (backendHandoff ? (
            <article className="ops-panel">
              <PanelHead
                icon={Database}
                title="Production backend handoff"
                action={backendHandoff.productionReady ? 'Production ready' : `${backendHandoff.summary.blocked} blocked`}
              />
              <div className="check-list">
                <CheckItem ok={backendHandoff.ok} label="Backend handoff is secret-safe and ranks durable state, signed auth, tenant isolation, CORS, scheduler, backup, migration, and runbook proof." />
                <CheckItem ok={backendHandoff.productionReady} label={backendHandoff.productionReady ? 'Production backend proof is complete.' : `Next backend action: ${backendHandoff.nextAction.label} owned by ${titleize(backendHandoff.nextAction.owner)}.`} />
                <CheckItem ok={backendHandoff.summary.secretSafe} label="Backend handoff lists environment names and placeholder commands without serialized credential values." />
                <CheckItem ok={backendHandoff.backend.readyChecks === backendHandoff.backend.totalChecks} label={`${backendHandoff.backend.readyChecks}/${backendHandoff.backend.totalChecks} backend readiness check(s) are production-ready.`} />
              </div>
              <AdminTable
                columns={['Priority', 'Action', 'Status', 'Owner', 'Env', 'Blocker', 'Command']}
                rows={backendHandoffRows}
              />
              <CommandStrip commands={['npm run admin -- backend-handoff --json', 'npm run admin -- backend-handoff --env-file ./.env.production --json', 'curl http://127.0.0.1:8787/api/backend-handoff', 'npm run admin -- backend --env-file ./.env.production --json', 'SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- health --json', 'npm run test:state-service', 'npm run test:jwks-auth', 'npm run scheduler -- --once --dry-run --json']} />
            </article>
            ) : (
              <ReportLoadingPanel icon={Database} title="Production backend handoff" />
            )
            )}
            {activeTab === 'launch' && (backendCutover ? (
            <article className="ops-panel wide-panel">
              <PanelHead
                icon={Route}
                title="Backend cutover drill"
                action={backendCutover.productionReady ? 'Ready for evidence' : `${backendCutover.summary.blocked} steps need proof`}
              />
              <div className="check-list">
                <CheckItem ok={backendCutover.ok} label="Backend cutover drill is secret-safe and turns the local JSON to external state-service switch into ordered local-agent steps." />
                <CheckItem ok={backendCutover.productionReady} label={backendCutover.productionReady ? 'External state-service cutover proof is complete.' : `Next cutover step: ${backendCutover.nextStep.label} owned by ${titleize(backendCutover.nextStep.owner)}.`} />
                <CheckItem ok={backendCutover.summary.secretSafe} label="Cutover rows show env names, placeholder commands, completion criteria, and rollback commands without credential values." />
                <CheckItem ok={backendCutover.backend.readyChecks === backendCutover.backend.totalChecks} label={`${backendCutover.backend.readyChecks}/${backendCutover.backend.totalChecks} backend checks are production-ready before cutover.`} />
              </div>
              <AdminTable
                columns={['Priority', 'Step', 'Status', 'Owner', 'Missing env', 'Command', 'Rollback']}
                rows={backendCutoverRows}
              />
              <CommandStrip commands={['npm run admin -- backend-cutover --json', 'npm run admin -- backend-cutover --env-file ./.env.production --json', 'curl http://127.0.0.1:8787/api/backend-cutover', 'SIGNAL_STATE_SERVICE_BACKEND=postgres DATABASE_URL=postgres://... SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service', 'SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- health --json', 'SIGNAL_BACKEND_MODE=external-service SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run api', 'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json']} />
            </article>
            ) : (
              <ReportLoadingPanel icon={Route} title="Backend cutover drill" wide />
            )
            )}
            {activeTab === 'platform' && (schedulerHandoff ? (
            <article className="ops-panel wide-panel">
              <PanelHead
                icon={RefreshCw}
                title="Scheduler operations handoff"
                action={schedulerHandoff.productionReady ? 'Production ready' : `${schedulerHandoff.summary.blocked} steps need proof`}
              />
              <div className="check-list">
                <CheckItem ok={schedulerHandoff.ok} label="Scheduler handoff is secret-safe and ranks production scheduler env, one-shot dry run, validation schedules, failed-job recovery, alerts, rollback, and launch evidence." />
                <CheckItem ok={schedulerHandoff.productionReady} label={schedulerHandoff.productionReady ? 'Continuous scheduler proof is complete.' : `Next scheduler step: ${schedulerHandoff.nextStep.label} owned by ${titleize(schedulerHandoff.nextStep.owner)}.`} />
                <CheckItem ok={schedulerHandoff.summary.secretSafe} label="Scheduler proof exposes environment variable names and placeholder commands without credential values." />
                <CheckItem ok={schedulerHandoff.operations.failedJobs === 0} label={schedulerHandoff.operations.failedJobs === 0 ? `${schedulerHandoff.operations.activeProviderSchedules}/${schedulerHandoff.operations.totalProviderSchedules} provider validation schedules active with no failed jobs.` : `${schedulerHandoff.operations.failedJobs} failed job(s) must be cleared before scheduler launch.`} />
              </div>
              <AdminTable
                columns={['Priority', 'Step', 'Status', 'Owner', 'Missing env', 'Blocker', 'Command', 'Rollback']}
                rows={schedulerHandoffRows}
              />
              <CommandStrip commands={['npm run admin -- scheduler-handoff --json', 'npm run admin -- scheduler-handoff --env-file ./.env.production --json', 'curl http://127.0.0.1:8787/api/scheduler-handoff', 'npm run scheduler -- --once --dry-run --json', 'SIGNAL_JOB_SCHEDULER=signal-scheduler SIGNAL_PROVIDER_VALIDATION_SCHEDULER=signal-scheduler npm run scheduler -- --once --json', 'npm run admin -- operations-health --json', 'npm run admin -- jobs retry <jobId>', 'npm run admin -- jobs drain billing_webhook', 'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json']} />
            </article>
            ) : (
              <ReportLoadingPanel icon={RefreshCw} title="Scheduler operations handoff" wide />
            )
            )}
            {activeTab === 'launch' && (
            <>
            {completionAudit ? (
              <article className="ops-panel wide-panel">
                <PanelHead
                  icon={CheckCircle2}
                  title="Completion audit"
                  action={`${completionAudit.summary.localReady}/${completionAudit.summary.total} local · ${completionAudit.summary.productionReady}/${completionAudit.summary.total} production`}
                />
                <div className="check-list">
                  <CheckItem ok={completionAudit.localComplete} label="The local SaaS slice covers public entry, onboarding, user workspace, admin operations, local-agent CLI, email flow management, and payment architecture." />
                  <CheckItem ok={completionAudit.productionReady} label={completionAudit.productionReady ? 'Production launch evidence is complete.' : completionAudit.recommendation.productionGuardrail} />
                  <CheckItem ok={completionAudit.summary.secretSafe} label="Completion audit exposes evidence, commands, API routes, and environment names without credential values." />
                </div>
                <AdminTable
                  columns={['Area', 'Status', 'Owner', 'Local', 'Production', 'Blocker', 'Command']}
                  rows={completionAuditRows}
                />
                <CommandStrip commands={['npm run admin -- completion-audit --json', 'npm run admin -- completion-audit --env-file ./.env.production --json', 'curl http://127.0.0.1:8787/api/completion-audit', 'npm run test:local', 'npm run admin -- agent-handoff --json', 'npm run admin -- launch-gate --env-file ./.env.production --json']} />
              </article>
            ) : (
              <ReportLoadingPanel icon={CheckCircle2} title="Completion audit" wide />
            )}
            <article className="ops-panel">
              <PanelHead
                icon={Gauge}
                title="Product readiness audit"
                action={`${productReadiness.localReady}/${productReadiness.total} local · ${productReadiness.productionReady}/${productReadiness.total} production`}
              />
              <div className="check-list">
                <CheckItem ok={productReadiness.localReady === productReadiness.total} label="Local app requirements are checked against current state, doctor, provider, and backend evidence." />
                <CheckItem ok={productReadiness.productionReady === productReadiness.total} label={productReadiness.productionReady === productReadiness.total ? 'Production requirements are satisfied.' : 'Production still needs live provider evidence and deployment configuration.'} />
              </div>
              <AdminTable
                columns={['Area', 'Local', 'Production', 'Evidence', 'Gap']}
                rows={productReadiness.rows.map((row) => [
                  row.area,
                  row.localOk ? 'Ready' : 'Attention',
                  row.productionOk ? 'Ready' : 'Not ready',
                  row.evidence,
                  row.gap,
                ])}
              />
              <CommandStrip commands={['npm run admin -- readiness --json', 'curl http://127.0.0.1:8787/api/readiness', 'npm run admin -- doctor', 'npm run admin -- backend --json', 'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json']} />
            </article>
            {qaAnswers ? (
              <article className="ops-panel">
                <PanelHead
                  icon={Lightbulb}
                  title="Stakeholder QA answers"
                  action={`${qaAnswers.summary.localReady}/${qaAnswers.summary.total} local · ${qaAnswers.summary.productionReady}/${qaAnswers.summary.total} production`}
                />
                <div className="check-list">
                  <CheckItem ok={qaAnswers.summary.localReady === qaAnswers.summary.total} label="Dashboard calculations, model boundary, multi-user org, onboarding, notifications, relationship strategy, email flow, and payment lifecycle answers have local evidence." />
                  <CheckItem ok={qaAnswers.productionReady} label={qaAnswers.productionReady ? 'All QA answers are production-ready.' : qaAnswers.recommendation.productionGuardrail} />
                  <CheckItem ok={qaAnswers.summary.secretSafe} label="QA answers expose commands, environment variable names, and evidence counts without credential values." />
                </div>
                <AdminTable
                  columns={['Question', 'Status', 'Owner', 'Local', 'Production caveat', 'Command']}
                  rows={qaAnswerRows}
                />
                <CommandStrip commands={['npm run admin -- qa-answers --json', 'npm run admin -- qa-answers --env-file ./.env.production --json', 'curl http://127.0.0.1:8787/api/qa-answers', 'npm run admin -- dashboard-audit --json', 'npm run admin -- onboarding-readiness --json', 'npm run admin -- lifecycle-playbook --json', 'npm run admin -- provider-launch --env-file ./.env.production --json']} />
              </article>
            ) : (
              <ReportLoadingPanel icon={Lightbulb} title="Stakeholder QA answers" />
            )}
            </>
            )}
            {activeTab === 'platform' && (
            <>
            {onboardingReadiness ? (
              <article className="ops-panel">
                <PanelHead
                  icon={Users}
                  title="Onboarding and RBAC readiness"
                  action={`${onboardingReadiness.summary.activeAdmins} admin · ${onboardingReadiness.summary.activeMembers} members`}
                />
                <div className="check-list">
                  <CheckItem ok={onboardingReadiness.ok} label="Registration, invite acceptance, membership, role, notification focus, and privacy rows pass locally." />
                  <CheckItem ok={onboardingReadiness.productionReady} label={onboardingReadiness.productionReady ? 'Production onboarding controls are ready.' : onboardingReadiness.recommendation.productionGuardrail} />
                  <CheckItem ok={onboardingReadiness.backend.tenantIsolationReady} label={onboardingReadiness.backend.tenantIsolationReady ? 'Tenant isolation is production-configured.' : 'Tenant isolation remains a production backend blocker.'} />
                </div>
                <AdminTable
                  columns={['Area', 'Status', 'Local', 'Production']}
                  rows={onboardingReadiness.rows.map((row) => [
                    titleize(row.area),
                    titleize(row.status),
                    row.localOk ? 'Ready' : 'Attention',
                    row.productionOk ? 'Ready' : 'Not ready',
                  ])}
                />
                <CommandStrip commands={['npm run admin -- onboarding-readiness --json', 'curl http://127.0.0.1:8787/api/onboarding-readiness', 'npm run admin -- onboarding-readiness --env-file ./.env.production --json']} />
              </article>
            ) : (
              <ReportLoadingPanel icon={Users} title="Onboarding and RBAC readiness" />
            )}
            {tenantIsolation ? (
              <article className="ops-panel">
                <PanelHead
                  icon={LockKeyhole}
                  title="Tenant isolation audit"
                  action={`${tenantIsolation.summary.localReady}/${tenantIsolation.summary.total} local checks`}
                />
                <div className="check-list">
                  <CheckItem ok={tenantIsolation.ok} label="Tenant membership, owner/team routing, admin gates, and actor-scoped visibility pass locally." />
                  <CheckItem ok={tenantIsolation.productionReady} label={tenantIsolation.productionReady ? 'Production tenant isolation is ready.' : tenantIsolation.recommendation.productionGuardrail} />
                  <CheckItem ok={tenantIsolation.rows.some((row) => row.area === 'actor_scoped_visibility' && row.localOk)} label="Actor-scoped visibility keeps member workspace counts inside the tenant boundary." />
                </div>
                <AdminTable
                  columns={['Area', 'Local', 'Production', 'Evidence', 'Command']}
                  rows={tenantIsolation.rows.map((row) => [
                    titleize(row.area),
                    row.localOk ? 'Ready' : 'Attention',
                    row.productionOk ? 'Ready' : 'Not ready',
                    row.evidence.join(' · '),
                    row.commands[0] ?? '-',
                  ])}
                />
                <CommandStrip commands={['npm run admin -- tenant-isolation --json', 'curl http://127.0.0.1:8787/api/tenant-isolation', 'npm run admin -- backend --env-file ./.env.production --json', 'npm run admin -- production-plan --json']} />
              </article>
            ) : (
              <ReportLoadingPanel icon={LockKeyhole} title="Tenant isolation audit" />
            )}
            {operationsHealth ? (
              <article className="ops-panel">
                <PanelHead
                  icon={Activity}
                  title="Webhook and rate-limit health"
                  action={operationsHealth.ok ? 'Local ready' : 'Attention'}
                />
                <div className="check-list">
                  <CheckItem ok={operationsHealth.ok} label={operationsHealth.ok ? 'Webhook channels, provider backoff, worker queues, lifecycle notices, outbound email, and billing events are locally monitored.' : `${operationsHealth.issues.length} operations health issue needs review.`} />
                  <CheckItem ok={operationsHealth.summary.activeBackoffs === 0} label={operationsHealth.summary.activeBackoffs === 0 ? 'No active provider retry/backoff window is blocking sync or watch processing.' : `${operationsHealth.summary.activeBackoffs} active provider retry/backoff window needs attention.`} />
                  <CheckItem ok={operationsHealth.summary.failedJobs === 0} label={operationsHealth.summary.failedJobs === 0 ? 'No worker queue has failed jobs.' : `${operationsHealth.summary.failedJobs} failed worker job needs retry or drain handling.`} />
                  <CheckItem ok={operationsHealth.productionReady} label={operationsHealth.productionReady ? 'Production operations monitoring is ready.' : operationsHealth.recommendation.productionGuardrail} />
                </div>
                <AdminTable
                  columns={['Channel', 'Status', 'Webhook path', 'Evidence', 'Latest']}
                  rows={operationsWebhookRows}
                />
                <AdminTable
                  columns={['Provider', 'Result', 'Event', 'HTTP', 'Reason', 'Received']}
                  rows={webhookOutcomeRows.length ? webhookOutcomeRows : [['No webhook outcomes recorded', '-', '-', '-', '-', '-']]}
                />
                <AdminTable
                  columns={['Queue', 'Status', 'Jobs', 'Active', 'Failed']}
                  rows={operationsQueueRows}
                />
                <AdminTable
                  columns={['Provider', 'Kind', 'Target', 'Retry after', 'Reason']}
                  rows={activeBackoffRows.length ? activeBackoffRows : [['No active provider backoff', '-', '-', '-', '-']]}
                />
                <AdminTable
                  columns={['Lifecycle', 'Status', 'Open', 'Critical', 'Latest']}
                  rows={operationsLifecycleRows}
                />
                <CommandStrip commands={['npm run admin -- operations-health --json', 'curl http://127.0.0.1:8787/api/operations-health', 'npm run admin -- jobs run outbound_email --limit 1', 'npm run admin -- jobs drain billing_webhook', 'npm run admin -- integrations run-scheduled --json']} />
              </article>
            ) : (
              <ReportLoadingPanel icon={Activity} title="Webhook and rate-limit health" />
            )}
            </>
            )}
            {activeTab === 'launch' && (
            <>
            <article className="ops-panel">
              <PanelHead
                icon={ShieldCheck}
                title="Production launch gate"
                action={launchGate.goLiveReady ? 'Go-live ready' : `${launchGate.blocked} blocked`}
              />
              <div className="check-list">
                <CheckItem ok={launchGate.goLiveReady} label={launchGate.goLiveReady ? 'All go-live gates have proof.' : 'Go-live is blocked until production backend and live provider evidence pass.'} />
                <CheckItem ok={launchGate.secretSafe} label="Launch gate lists required environment variable names and proof commands without secret values." />
              </div>
              <AdminTable
                columns={['Gate', 'Status', 'Owner', 'Required env', 'Blocker']}
                rows={launchGate.rows.map((row) => [
                  row.gate,
                  row.status,
                  row.owner,
                  row.requiredEnv,
                  row.blocker,
                ])}
              />
              <CommandStrip commands={['npm run admin -- launch-gate --json', 'npm run admin -- launch-gate --env-file ./.env.production --json', 'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json', 'npm run admin -- launch-gate verify-package ./signal-launch-evidence.json --json', 'npm run admin -- backend --env-file ./.env.production --json', 'curl http://127.0.0.1:8787/api/launch-gate', 'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json', 'SIGNAL_TENANT_ISOLATION_MODE=rls npm run admin -- backend --json', 'SIGNAL_JOB_SCHEDULER=signal-scheduler npm run scheduler']} />
            </article>
            {productionEnv ? (
              <article className="ops-panel">
                <PanelHead
                  icon={Settings2}
                  title="Production env audit"
                  action={`${productionEnv.summary.configuredRequired}/${productionEnv.summary.requiredEnv} configured`}
                />
                <div className="check-list">
                  <CheckItem ok={productionEnv.ok} label="The production env audit is secret-safe and reports names only." />
                  <CheckItem ok={productionEnv.templateReady} label={productionEnv.templateReady ? '.env.production.example covers every required production setup name.' : `${productionEnv.summary.templateMissingRequired} required env name(s) are missing from the template.`} />
                  <CheckItem ok={productionEnv.envReady} label={productionEnv.envReady ? 'Selected production env source has every required value configured.' : `${productionEnv.summary.missingRequired} required production env value(s) remain missing or placeholder-only.`} />
                  <CheckItem ok={productionEnv.summary.secretSafe} label="No environment values, provider tokens, webhook secrets, or database passwords are serialized in this report." />
                </div>
                <AdminTable
                  columns={['Section', 'Status', 'Owner', 'Configured', 'Missing values', 'Template', 'Command']}
                  rows={productionEnvRows}
                />
                <CommandStrip commands={['npm run admin -- production-env --json', 'npm run admin -- production-env --env-file ./.env.production --json', 'npm run admin -- production-env --template ./.env.production.example --json', 'curl http://127.0.0.1:8787/api/production-env', 'npm run admin -- production-plan --env-file ./.env.production --json', 'npm run admin -- launch-gate --env-file ./.env.production --json']} />
              </article>
            ) : (
              <ReportLoadingPanel icon={Settings2} title="Production env audit" />
            )}
            {productionPlan ? (
              <article className="ops-panel">
                <PanelHead
                  icon={Route}
                  title="Production setup plan"
                  action={`${productionPlan.summary.complete}/${productionPlan.summary.total} complete`}
                />
                <div className="check-list">
                  <CheckItem ok={productionPlan.ok} label="The local agent can inspect the ordered production setup map without reading credential values." />
                  <CheckItem ok={productionPlan.productionReady} label={productionPlan.productionReady ? 'Every production setup phase has proof.' : productionPlan.recommendation.productionGuardrail} />
                  <CheckItem ok={productionPlan.summary.secretSafe} label="Production setup rows list environment variable names, owner areas, blockers, and proof commands without secret values." />
                  <CheckItem ok={!productionPlan.summary.nextPhaseId} label={productionPlan.summary.nextPhaseId ? `Next phase: ${titleize(productionPlan.summary.nextPhaseId)}` : 'No remaining production setup phase.'} />
                </div>
                <AdminTable
                  columns={['Phase', 'Status', 'Owner', 'Missing env', 'Blocker/proof', 'Command']}
                  rows={productionPlanRows}
                />
                <CommandStrip commands={['npm run admin -- production-plan --json', 'npm run admin -- production-plan --env-file ./.env.production --json', 'curl http://127.0.0.1:8787/api/production-plan', 'npm run admin -- launch-gate --env-file ./.env.production --json', 'npm run admin -- provider-launch --env-file ./.env.production --json', 'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json']} />
              </article>
            ) : (
              <ReportLoadingPanel icon={Route} title="Production setup plan" />
            )}
            {productionDrill ? (
              <article className="ops-panel">
                <PanelHead
                  icon={Workflow}
                  title="Production operations drill"
                  action={`${productionDrill.summary.productionReady}/${productionDrill.summary.total} ready`}
                />
                <div className="check-list">
                  <CheckItem ok={productionDrill.ok} label="The local agent can inspect production drill rows without requiring secret values in app state." />
                  <CheckItem ok={productionDrill.productionReady} label={productionDrill.productionReady ? 'All production rehearsal rows have current external proof.' : productionDrill.recommendation.productionGuardrail} />
                  <CheckItem ok={productionDrill.rows.some((row) => row.area === 'backup_restore_rehearsal')} label="Backup policy, backup digest verification, and restore rehearsal are explicit launch drills." />
                  <CheckItem ok={productionDrill.rows.some((row) => row.area === 'alerting_runbook')} label="Operations alert channel and runbook proof are tracked before production traffic." />
                </div>
                <AdminTable
                  columns={['Drill', 'Status', 'Owner', 'Missing env/proof', 'Proof command']}
                  rows={productionDrillRows}
                />
                <CommandStrip commands={['npm run admin -- production-drill --json', 'npm run admin -- production-drill --env-file ./.env.production --json', 'curl http://127.0.0.1:8787/api/production-drill', 'SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- backup ./signal-prod-backup.json --json', 'npm run state-service:admin -- verify ./signal-prod-backup.json --json', 'SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- restore ./signal-prod-backup.json --dry-run --json', 'npm run scheduler -- --once --dry-run --json']} />
              </article>
            ) : (
              <ReportLoadingPanel icon={Workflow} title="Production operations drill" />
            )}
            </>
            )}
            {activeTab === 'platform' && (
            <>
            <article className="ops-panel">
              <PanelHead icon={Clock3} title="Operational jobs" action={`${failedJobs.length} failed · ${queuedJobs.length} queued`} />
              <div className="job-stack">
                {data.jobs.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    action={
                      job.status === 'failed' ? (
                        <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('jobs.retry', { jobId: job.id })}>
                          Retry
                        </button>
                      ) : job.status === 'queued' ? (
                        <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('jobs.run', { jobId: job.id })}>
                          Run
                        </button>
                      ) : null
                    }
                  />
                ))}
                {deadLetterJobs.map((job) => {
                  const deadLetterId = job.deadLetterId ?? job.id;
                  const checked = selectedDeadLetterIds.includes(deadLetterId);
                  return (
                    <div className={`job-card ${checked ? 'is-selected' : ''}`} key={deadLetterId}>
                      <label className="job-select">
                        <input
                          checked={checked}
                          type="checkbox"
                          onChange={(event) => {
                            setSelectedDeadLetterIds((current) => event.target.checked
                              ? [...new Set([...current, deadLetterId])]
                              : current.filter((id) => id !== deadLetterId));
                          }}
                        />
                        <span>
                          <strong>{job.type}</strong>
                          <small>{job.queue} · {job.message}</small>
                        </span>
                      </label>
                      <div className="card-actions">
                        <span className="status-pill failed">Dead letter</span>
                        <small>{job.attempts}/{job.maxAttempts} attempts</small>
                        <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('jobs.requeue', { deadLetterId })}>
                          Requeue
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="button-row">
                <button className="inline-action" disabled={isMutating || source !== 'api' || queuedJobs.length === 0} type="button" onClick={() => mutate('jobs.run', {})}>
                  Run queued
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api' || !queuedJobs.some((job) => job.queue === 'email_sync')} type="button" onClick={() => mutate('jobs.run', { queue: 'email_sync', limit: 5 })}>
                  Run email sync
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api' || queuedSignalHandoffJobs.length === 0} type="button" onClick={() => mutate('jobs.run', { queue: 'signal_handoff', limit: 5 })}>
                  Run handoffs
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api' || queuedProviderValidationJobs.length === 0} type="button" onClick={() => mutate('jobs.run', { queue: 'provider_validation', limit: 1 })}>
                  Run validation scheduler
                </button>
                <button className="inline-action" disabled={deadLetterJobs.length === 0} type="button" onClick={() => setSelectedDeadLetterIds(deadLetterJobs.map((job) => job.deadLetterId ?? job.id))}>
                  Select DLQ
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api' || selectedDeadLetterIds.length === 0} type="button" onClick={() => mutate('jobs.requeue-bulk', { deadLetterIds: selectedDeadLetterIds })}>
                  Requeue selected
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('jobs.drain', { queue: 'email_sync' })}>
                  Drain email sync
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('jobs.drain', { queue: 'billing_webhook' })}>
                  Drain billing webhooks
                </button>
              </div>
              <CommandStrip commands={['npm run admin -- jobs --json', 'npm run admin -- jobs run', 'npm run scheduler -- --once --dry-run --json', 'SIGNAL_JOB_SCHEDULER=signal-scheduler npm run scheduler', 'npm run admin -- jobs run provider_validation --limit 1', 'npm run admin -- jobs run signal_handoff --limit 5', 'npm run admin -- jobs drain billing_webhook']} />
            </article>
            <article className="ops-panel">
              <PanelHead icon={Gauge} title="Provider operations" action="Email + payment queues" />
              <div className="check-list">
                <CheckItem ok={reauthCount === 0} label={reauthCount === 0 ? 'All mailbox sources are authorized.' : `${reauthCount} mailbox source needs reauthorization.`} />
                <CheckItem ok={failedJobs.length === 0} label={failedJobs.length === 0 ? 'No operational jobs are failed.' : `${failedJobs.length} operational job needs attention.`} />
                <CheckItem ok={queuedSignalHandoffJobs.length === 0} label={queuedSignalHandoffJobs.length === 0 ? 'No CRM/task handoff jobs are waiting.' : `${queuedSignalHandoffJobs.length} CRM/task handoff job needs local-agent delivery.`} />
                <CheckItem ok={providerValidationJobs.length > 0} label="Provider validation schedules are attached to the shared worker queue and scheduler daemon." />
                <CheckItem ok={(summary.activeEntitlements ?? 0) > 0} label="Billing entitlement is available to gate product access." />
                <CheckItem ok={tenantBillingSessions.length > 0} label="Local checkout or portal session is available for billing handoff." />
                <CheckItem ok={tenantNotificationPreferences.length >= tenantActiveUsers.length} label="Notification digest preferences exist for every active user." />
              </div>
              <AdminTable
                columns={['Queue', 'Jobs', 'Failed']}
                rows={['email_sync', 'provider_validation', 'billing_webhook', 'notification_digest'].map((queue) => [
                  queue,
                  String(data.jobs.filter((job) => job.queue === queue).length),
                  String(data.jobs.filter((job) => job.queue === queue && job.status === 'failed').length),
                ])}
              />
              <AdminTable columns={['Area', 'Trigger', 'Severity', 'Status', 'Action']} rows={lifecycleNoticeRows(sourceLifecycleNotices, 8)} />
            </article>
            <article className="ops-panel">
              <PanelHead icon={Database} title="Backend boundary" action={backendReadiness.productionReady ? 'Production ready' : 'Local-only'} />
              <div className="check-list">
                <CheckItem ok={!backendReadiness.localOnly} label={backendReadiness.localOnly ? 'Local JSON state is active; production needs a durable backend or external state service.' : `Backend mode ${backendReadiness.mode} is configured.`} />
                <CheckItem ok={backendReadiness.checks.find((check) => check.id === 'signed_session_enforced')?.ok ?? false} label="Production API actor resolution requires signed sessions and no raw actor fallback." />
                <CheckItem ok={backendReadiness.checks.find((check) => check.id === 'tenant_isolation')?.ok ?? false} label="Production multi-org support needs database or policy-level tenant isolation." />
                <CheckItem ok={backendReadiness.checks.find((check) => check.id === 'job_scheduler')?.ok ?? false} label="Provider validation, sync, digest, and billing workers can run under the scheduler daemon when configured." />
              </div>
              <AdminTable
                columns={['Check', 'Ready', 'Missing env']}
                rows={backendReadiness.checks.map((check) => [
                  check.label,
                  check.ok ? 'Yes' : 'No',
                  check.missingEnv.length ? check.missingEnv.join(', ') : '-',
                ])}
              />
              <CommandStrip commands={['npm run admin -- backend --json', 'SIGNAL_JOB_SCHEDULER=signal-scheduler npm run scheduler', 'SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service', 'SIGNAL_STATE_SERVICE_URL=http://127.0.0.1:8791/state SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- backup ./signal-backup.json --json', 'SIGNAL_STATE_SERVICE_URL=http://127.0.0.1:8791/state SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- restore ./signal-backup.json --dry-run --json', 'SIGNAL_STATE_SERVICE_BACKEND=postgres DATABASE_URL=postgres://... SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service', 'SIGNAL_BACKEND_MODE=external-service SIGNAL_STATE_SERVICE_URL=http://127.0.0.1:8791/state SIGNAL_STATE_SERVICE_TOKEN=<token> npm run api']} />
            </article>
            <article className="ops-panel">
              <PanelHead icon={Fingerprint} title="API session registry" action={`${activeApiSessions.length} active · ${revokedApiSessions.length} revoked`} />
              <div className="check-list">
                <CheckItem ok label="Registered sessions store digest metadata only; plaintext bearer values stay out of local state." />
                <CheckItem ok={apiSessions.length === 0 || activeApiSessions.length > 0 || revokedApiSessions.length > 0} label={apiSessions.length === 0 ? 'No registered local API sessions yet.' : 'Issued sessions have explicit active, revoked, or expired status.'} />
              </div>
              {apiSessions.length > 0 ? (
                <AdminTable
                  columns={['Session', 'User', 'Status', 'Expires']}
                  rows={apiSessions.slice(0, 6).map((session) => [
                    session.id,
                    ownerName(data.users, session.userId),
                    titleize(session.status),
                    session.expiresAt ? new Date(session.expiresAt).toLocaleString() : '-',
                  ])}
                />
              ) : (
                <div className="empty-state">
                  <strong>No registered API sessions.</strong>
                  <small>Issue one with the local CLI or token API when running with signed-session enforcement.</small>
                </div>
              )}
              <div className="button-row compact-actions">
                {activeApiSessions.slice(0, 3).map((session) => (
                  <button className="inline-action" disabled={isMutating || source !== 'api'} key={session.id} type="button" onClick={() => mutate('session.revoke', { sessionId: session.id })}>
                    Revoke {ownerName(data.users, session.userId)}
                  </button>
                ))}
              </div>
              <CommandStrip commands={['npm run admin -- session --json', 'SIGNAL_SESSION_SECRET=<local-session-secret> npm run admin -- session token usr_admin --json', 'npm run admin -- session revoke <sessionId|digest|token> --actor usr_admin']} />
            </article>
            <article className="ops-panel">
              <PanelHead icon={MailCheck} title="Digest operations" action={`${queuedEmailDeliveries.length} queued email · ${failedEmailDeliveries.length} failed`} />
              <div className="button-row">
                <button className="inline-action" disabled={isMutating || source !== 'api'} type="button" onClick={() => mutate('notifications.digest-run', { tenantId: tenant.id })}>
                  Run tenant digest
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api' || !salesDemoUser} type="button" onClick={() => salesDemoUser && mutate('notifications.digest-run', { tenantId: tenant.id, userId: salesDemoUser.id })}>
                  Run {salesDemoUser?.name ?? 'sales'} digest
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api' || !productDemoUser} type="button" onClick={() => productDemoUser && mutate('notifications.preference', { patch: { digestCadence: 'off' }, userId: productDemoUser.id })}>
                  Pause {productDemoUser?.name ?? 'product'} digest
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api' || !queuedEmailDeliveries[0]} type="button" onClick={() => mutate('notifications.delivery-status', { messageId: queuedEmailDeliveries[0]?.id, status: 'sent', reason: 'Accepted by local outbound email adapter' })}>
                  Send first queued
                </button>
                <button className="inline-action" disabled={isMutating || source !== 'api' || !productDemoUser} type="button" onClick={() => productDemoUser && mutate('notifications.unsubscribe', { userId: productDemoUser.id })}>
                  Unsubscribe {productDemoUser?.name ?? 'product'} email
                </button>
              </div>
              <div className="digest-run-stack">
                {latestDigestRuns.map((run) => (
                  <DigestRunCard key={run.id} run={run} />
                ))}
                {latestDigestRuns.length === 0 && (
                  <div className="empty-state">
                    <strong>No digest runs yet.</strong>
                    <small>Run a tenant digest to mark unread dashboard alerts as sent through the local delivery ledger.</small>
                  </div>
                )}
              </div>
              <div className="digest-run-stack">
                {latestEmailDeliveries.map((message) => (
                  <EmailDeliveryCard key={message.id} message={message} />
                ))}
                {latestEmailDeliveries.length === 0 && (
                  <div className="empty-state">
                    <strong>No outbound email records yet.</strong>
                    <small>Run a digest to prepare local email delivery messages for users with email digest enabled.</small>
                  </div>
                )}
              </div>
              <AdminTable
                columns={['User', 'Cadence', 'Email', 'Muted']}
                rows={tenantNotificationPreferences.map((preference) => [
                  ownerName(data.users, preference.userId),
                  titleize(preference.digestCadence),
                  titleize(preference.emailDeliveryStatus ?? 'subscribed'),
                  String((preference.mutedAccounts?.length ?? 0) + (preference.mutedSignalTypes?.length ?? 0)),
                ])}
              />
              <CommandStrip commands={['npm run admin -- notifications --json', 'npm run admin -- notifications digest tenant_demo', 'SIGNAL_EMAIL_PROVIDER=sendgrid SIGNAL_EMAIL_PROVIDER_MODE=live SIGNAL_SENDGRID_ASM_GROUP_ID=... SIGNAL_SENDGRID_CATEGORIES=sales_signal,product_ideas npm run admin -- jobs run outbound_email --limit 1', 'SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET=<email-webhook-secret> npm run admin -- notifications webhook-signed ./email-event.json <Signal-Email-Signature>', 'SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY=... npm run admin -- notifications sendgrid-webhook-signed ./sendgrid-events.json <signature> <timestamp>', 'npm run admin -- notifications unsubscribe usr_product']} />
            </article>
            </>
            )}
          </section>
        )}

        {activeTab === 'cli' && (
          <section className="ops-panel cli-panel is-visible" data-reveal>
            <PanelHead icon={TerminalSquare} title="Local agent CLI contract" action="Scriptable operations" />
            <p>
              The local CLI is the management boundary for an agent running on this machine. It reads and writes ignored local state, emits JSON for automation, and refuses to store secret-like fields.
            </p>
            <div className="cli-grid">
              {[
                'npm run admin:bootstrap -- --force --yes',
                'npm run admin -- status --json',
                'SIGNAL_SESSION_SECRET=<local-session-secret> npm run admin -- session token usr_admin --json',
                'npm run admin -- session revoke <sessionId|digest|token> --actor usr_admin',
                'SIGNAL_REQUIRE_SIGNED_SESSION=true SIGNAL_SESSION_SECRET=<local-session-secret> npm run api',
                'npm run admin -- doctor',
                'npm run admin -- export --json',
                'npm run admin -- tenants register New_Revenue_Lab newlab.example owner@newlab.example Owner_Name plan_beta',
                'npm run admin -- tenants create New_Revenue_Lab newlab.example owner@newlab.example Owner_Name plan_beta',
                'npm run admin -- accounts --json',
                'npm run admin -- accounts action act_acme_exec_save done',
                'npm run admin -- notifications --json',
                'npm run admin -- notifications digest tenant_demo',
                'npm run admin -- notifications status ntf_sig_sig_risk_001 read',
                'npm run admin -- notifications mute-account usr_product Acme Health',
                'npm run admin -- signals assign sig_risk_001 usr_sales',
                'npm run admin -- signals handoff sig_product_001 crm CRM_followup',
                'npm run admin -- signals handoff-status <handoffId> sent crm_task_123',
                'npm run admin -- email-flows disable flow_product_ideas',
                'npm run admin -- payments sync tenant_demo',
                'npm run admin -- payments checkout tenant_demo plan_team',
                'npm run admin -- payments webhook invoice.paid sub_demo',
                'npm run admin -- jobs retry job_mbx_outlook_success',
              ].map((command) => (
                <code key={command}>{command}</code>
              ))}
            </div>
          </section>
        )}
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
