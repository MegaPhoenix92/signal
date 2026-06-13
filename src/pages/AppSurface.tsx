import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  BellRing,
  Brain,
  CheckCircle2,
  Clock3,
  CreditCard,
  Database,
  Eye,
  Fingerprint,
  Gauge,
  Inbox,
  Layers3,
  Lightbulb,
  LockKeyhole,
  MailCheck,
  Menu,
  PauseCircle,
  PlayCircle,
  Plug,
  Radar,
  Route,
  Search,
  Settings2,
  ShieldCheck,
  TerminalSquare,
  UserCog,
  Users,
  WalletCards,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  doctorLocalState,
  fallbackBackendReadiness,
  fallbackProviderReadiness,
  fallbackStateResponse,
  fallbackLocalAgentHandoff,
  fallbackCompletionAudit,
  fallbackBackendHandoff,
  fallbackBackendCutover,
  fallbackSchedulerHandoff,
  fallbackDashboardAudit,
  fallbackSignalDigestionPipeline,
  fallbackLifecyclePlaybook,
  fallbackOnboardingReadiness,
  fallbackOperationsHealth,
  fallbackPaymentHandoff,
  fallbackPaymentLifecycleAudit,
  fallbackProviderHandoff,
  fallbackProviderLaunchMatrix,
  fallbackProductionEnvAudit,
  fallbackProductionPlan,
  fallbackProductionDrill,
  fallbackQaAnswers,
  fallbackTenantIsolationAudit,
  fallbackEmailHandoff,
  fetchAgentHandoff,
  fetchBackendHandoff,
  fetchBackendCutover,
  fetchSchedulerHandoff,
  fetchDashboardAudit,
  fetchSignalDigestionPipeline,
  fetchLifecyclePlaybook,
  fetchOnboardingReadiness,
  fetchOperationsHealth,
  fetchEmailHandoff,
  fetchPaymentHandoff,
  fetchPaymentLifecycle,
  fetchCompletionAudit,
  fetchProviderHandoff,
  fetchProviderLaunch,
  fetchProductionEnv,
  fetchProductionPlan,
  fetchProductionDrill,
  fetchTenantIsolation,
  claimSignalInvite,
  fetchProviderReadiness,
  fetchProviderSandbox,
  fetchQaAnswers,
  fetchSignalState,
  formatCurrency,
  formatPercent,
  localApiUrl,
  mutateSignalState,
  ownerName,
  registerSignalWorkspace,
  runProviderScheduledValidation,
  switchSignalSession,
  titleize,
  type DoctorReport,
  type DashboardAuditReport,
  type SignalDigestionPipelineReport,
  type OnboardingReadinessReport,
  type TenantIsolationAuditReport,
  type OperationsHealthReport,
  type EmailHandoffReport,
  type PaymentHandoffReport,
  type PaymentLifecycleAuditReport,
  type CompletionAuditReport,
  type ProviderHandoffReport,
  type ProviderLaunchMatrixReport,
  type ProductionEnvAuditReport,
  type ProductionSetupPlanReport,
  type ProductionDrillReport,
  type QaAnswersReport,
  type LocalAgentHandoffReport,
  type BackendHandoffReport,
  type BackendCutoverDrillReport,
  type SchedulerHandoffReport,
  type AccountAction,
  type AccountEvent,
  type AccountProfile,
  type AccountRecommendation,
  type AccountReview,
  type BillingOverride,
  type DataRequest,
  type EmailDeliveryMessage,
  type EmailSyncCursor,
  type EmailFlow,
  type EmailRoutingRule,
  type EmailWatchSubscription,
  type GovernancePolicy,
  type IncidentNote,
  type Invoice,
  type Job,
  type LifecycleNotice,
  type LifecyclePlaybookReport,
  type Mailbox,
  type MailboxConnectionSession,
  type NotificationDigestRun,
  type NotificationEvent,
  type NotificationPreference,
  type BackendReadiness,
  type ProviderReadiness,
  type ProviderReadinessItem,
  type ProviderSandboxReport,
  type ProviderValidationSchedule,
  type RedactionRule,
  type FlowRun,
  type Signal,
  type SignalAppData,
  type SignalHandoff,
  type SignalMutationAction,
  type SignalStateResponse,
  type SourceMessage,
  type StateSummary,
  type SuppressionRule,
  type TenantMembership,
  type User,
  type UserInvite,
} from '../signalData';
import { resolveAppRoute } from './appRouting';
import { useSignalAppState } from './appState';
import type { Accent, AdminReportSection, AppMode, DataSource, LiveState, RegistrationFormErrors } from './appTypes';
import {
  AccountActionCard,
  AccountEventRow,
  AccountHealthCard,
  AccountRecommendationCard,
  AccountReviewCard,
  AdminTable,
  BarViz,
  BusyLabel,
  CheckItem,
  CommandStrip,
  InlineError,
  inviteClaimCodeSummary,
  InvoiceCard,
  lifecycleNoticeRows,
  MailboxCard,
  membershipsForTenant,
  MutationButton,
  activeMembershipsForTenant,
  membershipForUser,
  MetricCard,
  NotificationEventCard,
  PanelHead,
  ProductHeader,
  ProgressViz,
  resolveTeamCheckoutPlanId,
  SeedReadOnlyCallout,
  SignalRow,
  StateBanner,
  tenantTeamUser,
  useRevealObserver,
  useMutationFeedback,
  validDomain,
  validEmail,
} from './appShared';

const AdminConsole = lazy(() => import('./AdminConsole').then((m) => ({ default: m.AdminConsole })));


type SignalCard = {
  icon: LucideIcon;
  title: string;
  body: string;
  metric: string;
  accent: Accent;
};

type WorkflowStep = {
  icon: LucideIcon;
  label: string;
  title: string;
  body: string;
  stat: string;
};

const signalCards: SignalCard[] = [
  {
    icon: Radar,
    title: 'Buying intent',
    body: 'Find budget, timing, stakeholder, and competitor mentions hiding across customer threads.',
    metric: '41 hot accounts',
    accent: 'lime',
  },
  {
    icon: Lightbulb,
    title: 'Product ideas',
    body: 'Cluster recurring asks, complaints, and workarounds into a ranked product opportunity feed.',
    metric: '128 idea mentions',
    accent: 'gold',
  },
  {
    icon: Users,
    title: 'Relationship drift',
    body: 'See champions, executives, detractors, and silent buyers before a renewal becomes fragile.',
    metric: '9 exec gaps',
    accent: 'cyan',
  },
  {
    icon: BellRing,
    title: 'Customer risk',
    body: 'Watch for angry sentiment, support escalation, contract anxiety, and unresolved commitments.',
    metric: '6 saves queued',
    accent: 'coral',
  },
];

const workflowSteps: WorkflowStep[] = [
  {
    icon: Plug,
    label: 'Connect',
    title: 'Approve Gmail and Outlook sources',
    body: 'Teams connect only the mailboxes and labels they choose. OAuth scopes, sync windows, and retention rules stay visible.',
    stat: '7 min setup',
  },
  {
    icon: Search,
    label: 'Detect',
    title: 'Turn language into account signals',
    body: 'Signal scores thread clusters for urgency, stakeholder strength, product demand, and relationship health.',
    stat: '24/7 watch',
  },
  {
    icon: Workflow,
    label: 'Route',
    title: 'Send the right signal to the right owner',
    body: 'Push tasks to sales, product, success, or CRM workflows with the customer quote and confidence attached.',
    stat: '3 routed lanes',
  },
];

const dashboardRows = [
  ['Acme Health', 'Renewal risk', 'Champion has not replied in 19 days', 'Owner: Mia'],
  ['Northstar Ops', 'Expansion intent', 'Asked for usage-based rollout plan', 'Owner: Ray'],
  ['VentureWorks', 'Product idea', 'Requests CSV export for board reports', 'Owner: Priya'],
];

const securityItems = [
  {
    icon: ShieldCheck,
    title: 'Consent-first ingestion',
    body: 'Mailbox owners can choose sources, pause syncs, and remove connected accounts without engineering help.',
  },
  {
    icon: LockKeyhole,
    title: 'Retention controls',
    body: 'Set short-lived analysis windows, redact sensitive snippets, and keep raw thread access narrow.',
  },
  {
    icon: Fingerprint,
    title: 'Audit trail',
    body: 'Every account signal shows source, confidence, route, owner, and last action for review.',
  },
];

const marketingNavLinks = [
  { href: '#signals', label: 'Signals' },
  { href: '#workflow', label: 'Workflow' },
  { href: '#security', label: 'Security' },
  { href: '#register', label: 'Register' },
  { href: '#workspace', label: 'Workspace' },
  { href: '#admin', label: 'Admin' },
];
function MarketingPage() {
  const [activeStep, setActiveStep] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const activeWorkflow = useMemo(() => workflowSteps[activeStep], [activeStep]);
  const ActiveIcon = activeWorkflow.icon;

  useEffect(() => {
    if (!mobileNavOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileNavOpen(false);
        requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileNavOpen]);

  function closeMobileNav() {
    setMobileNavOpen(false);
  }

  return (
    <div className="app-shell">
      <header className="site-nav" aria-label="Main navigation">
        <a className="brand" href="#top" aria-label="Signal home">
          <span className="brand-mark">
            <Radar size={18} aria-hidden="true" />
          </span>
          <span>Signal</span>
        </a>
        <nav className="nav-links" aria-label="Page sections">
          {marketingNavLinks.map((link) => (
            <a key={link.href} href={link.href}>{link.label}</a>
          ))}
        </nav>
        <a className="nav-action" href="#register">
          <span>Start setup</span>
          <ArrowRight size={16} aria-hidden="true" />
        </a>
        <button
          ref={mobileMenuButtonRef}
          aria-controls="mobile-nav-menu"
          aria-expanded={mobileNavOpen}
          aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'}
          className="mobile-nav-toggle"
          type="button"
          onClick={() => setMobileNavOpen((open) => !open)}
        >
          {mobileNavOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
        </button>
        <nav id="mobile-nav-menu" className="mobile-nav-panel" aria-label="Mobile navigation" hidden={!mobileNavOpen}>
          {marketingNavLinks.map((link) => (
            <a key={link.href} href={link.href} onClick={closeMobileNav}>{link.label}</a>
          ))}
          <a className="mobile-nav-action" href="#register" onClick={closeMobileNav}>
            <span>Start setup</span>
            <ArrowRight size={16} aria-hidden="true" />
          </a>
        </nav>
      </header>

      <main>
        <section className="hero" id="top">
          <div className="hero-media" aria-hidden="true">
            <img src="/signal-command-center.png" alt="" />
          </div>
          <div className="hero-shade" aria-hidden="true" />
          <div className="hero-inner">
            <p className="eyebrow">
              <span>Permissioned inbox intelligence</span>
              for sales, product, and success teams
            </p>
            <h1>Signal</h1>
            <p className="hero-copy">
              Turn Gmail and Outlook conversations into buying triggers, product ideas, renewal warnings, and relationship dashboards before they disappear into the inbox.
            </p>
            <div className="hero-actions" aria-label="Primary actions">
              <a className="button button-primary" href="#register">
                <MailCheck size={19} aria-hidden="true" />
                <span>Create workspace</span>
                <ArrowRight size={18} aria-hidden="true" />
              </a>
              <a className="button button-secondary" href="#workspace">
                <Activity size={19} aria-hidden="true" />
                <span>Open workspace</span>
              </a>
            </div>
            <dl className="hero-metrics" aria-label="Signal highlights">
              <div>
                <dt>Sources</dt>
                <dd>Gmail + Outlook</dd>
              </div>
              <div>
                <dt>Routes</dt>
                <dd>Sales + Product + Success</dd>
              </div>
              <div>
                <dt>Posture</dt>
                <dd>Consent + audit first</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="proof-strip" aria-label="Signal routing summary">
          <div className="proof-item">
            <Inbox size={20} aria-hidden="true" />
            <span>Mailboxes</span>
          </div>
          <div className="proof-line" aria-hidden="true" />
          <div className="proof-item">
            <Brain size={20} aria-hidden="true" />
            <span>Signal models</span>
          </div>
          <div className="proof-line" aria-hidden="true" />
          <div className="proof-item">
            <Database size={20} aria-hidden="true" />
            <span>CRM and roadmap</span>
          </div>
        </section>

        <section className="section signal-section" id="signals">
          <div className="section-inner">
            <div className="section-heading" data-reveal>
              <p className="kicker">
                <Zap size={18} aria-hidden="true" />
                What Signal catches
              </p>
              <h2>Customer language becomes operational intelligence.</h2>
              <p>
                The strongest sales and product signals are already in email. Signal turns those loose threads into ranked, routed, accountable work.
              </p>
            </div>

            <div className="signal-grid" aria-label="Signal categories">
              {signalCards.map((card, index) => {
                const Icon = card.icon;
                return (
                  <article className={`signal-card accent-${card.accent}`} key={card.title} data-reveal style={{ transitionDelay: `${index * 90}ms` }}>
                    <div className="card-icon" aria-hidden="true">
                      <Icon size={24} />
                    </div>
                    <h3>{card.title}</h3>
                    <p>{card.body}</p>
                    <strong>
                      <span className="demo-data-badge">Demo data</span>
                      {card.metric}
                    </strong>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="section workflow-section" id="workflow">
          <div className="section-inner workflow-layout">
            <div className="workflow-copy" data-reveal>
              <p className="kicker">
                <Workflow size={18} aria-hidden="true" />
                Inbox to action
              </p>
              <h2>A monitoring layer built for revenue teams and product leaders.</h2>
              <p>
                Signal keeps the messy email layer intact while making the next action obvious. Use it for account reviews, product discovery, renewal prep, and founder-led customer monitoring.
              </p>

              <div className="workflow-tabs" role="tablist" aria-label="Signal workflow">
                {workflowSteps.map((step, index) => {
                  const Icon = step.icon;
                  const selected = activeStep === index;
                  return (
                    <button
                      className="workflow-tab"
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      key={step.label}
                      onClick={() => setActiveStep(index)}
                    >
                      <Icon size={18} aria-hidden="true" />
                      <span>{step.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <article className="workflow-panel" data-reveal aria-live="polite">
              <div className="workflow-panel-head">
                <span className="panel-icon" aria-hidden="true">
                  <ActiveIcon size={28} />
                </span>
                <span className="panel-stat">Demo data · {activeWorkflow.stat}</span>
              </div>
              <h3>{activeWorkflow.title}</h3>
              <p>{activeWorkflow.body}</p>
              <div className="signal-path" aria-label="Signal processing path">
                <span>Inbox</span>
                <ArrowRight size={16} aria-hidden="true" />
                <span>Classifier</span>
                <ArrowRight size={16} aria-hidden="true" />
                <span>Owner</span>
              </div>
            </article>
          </div>
        </section>

        <section className="section dashboard-section" aria-label="Dashboard preview">
          <div className="section-inner dashboard-layout">
            <div className="dashboard-visual" data-reveal>
              <img src="/signal-command-center.png" alt="Signal dashboard showing connected sources, signal feed, relationship health, and idea radar." />
            </div>

            <div className="dashboard-copy" data-reveal>
              <p className="kicker">
                <BarChart3 size={18} aria-hidden="true" />
                Relationship dashboard
              </p>
              <h2>See why an account moved, not just that it moved.</h2>
              <p>
                Each alert carries the source conversation, account context, route, and next best action. Teams can scan the board in standup and still drill into the customer language behind the score.
              </p>

              <div className="mini-table" aria-label="Example signal queue">
                <span className="demo-data-badge mini-table-badge">Example data</span>
                {dashboardRows.map(([account, type, detail, owner]) => (
                  <div className="mini-row" key={account}>
                    <span>{account}</span>
                    <span>{type}</span>
                    <span>{detail}</span>
                    <span>{owner}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="section security-section" id="security">
          <div className="section-inner">
            <div className="section-heading compact" data-reveal>
              <p className="kicker">
                <ShieldCheck size={18} aria-hidden="true" />
                Built for sensitive data
              </p>
              <h2>Email intelligence needs governance from day one.</h2>
            </div>

            <div className="security-grid">
              {securityItems.map((item, index) => {
                const Icon = item.icon;
                return (
                  <article className="security-card" key={item.title} data-reveal style={{ transitionDelay: `${index * 100}ms` }}>
                    <Icon size={24} aria-hidden="true" />
                    <h3>{item.title}</h3>
                    <p>{item.body}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="section cta-section" id="demo">
          <div className="section-inner cta-layout">
            <div data-reveal>
              <p className="kicker">
                <Gauge size={18} aria-hidden="true" />
                Private beta
              </p>
              <h2>Start with one shared inbox and one revenue segment.</h2>
              <p>
                Prove the signal quality on real conversations, tune routing with your team, then expand to customer success, product, and founder dashboards.
              </p>
            </div>
            <div className="cta-actions" data-reveal>
              <a className="button button-dark" href="#register">
                <MailCheck size={19} aria-hidden="true" />
                <span>Start onboarding</span>
              </a>
              <a className="button button-quiet" href="#admin">
                <Eye size={19} aria-hidden="true" />
                <span>Review admin</span>
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="footer-brand">
          <Radar size={18} aria-hidden="true" />
          <span>Signal</span>
        </div>
        <div className="footer-links" aria-label="Footer">
          <span>Gmail</span>
          <span>Outlook</span>
          <span>CRM</span>
          <span>Roadmap</span>
        </div>
        <p>
          <CheckCircle2 size={16} aria-hidden="true" />
          Permissioned sources. Accountable routes. Human-owned action.
        </p>
        <p className="footer-time">
          <Clock3 size={16} aria-hidden="true" />
          Monitoring built for the next customer conversation.
        </p>
      </footer>
    </div>
  );
}

function RegistrationOnboarding({ liveState }: { liveState: LiveState }) {
  const { actorUserId, backendReadiness, claimInvite, data, error, isLoading, isMutating, lastMutation, lastUpdatedAt, mutate, onboardingReadiness: loadedOnboardingReadiness, pollingIntervalMs, refresh, registerWorkspace, setActorUserId, source, summary } = liveState;
  const onboardingReadiness = loadedOnboardingReadiness ?? fallbackOnboardingReadiness(data, backendReadiness);
  const currentActor = data.users.find((user) => user.id === actorUserId) ?? data.users[0];
  const tenant = data.tenants.find((item) => item.id === currentActor?.tenantId) ?? data.tenants[0];
  const currentMembership = membershipForUser(data, currentActor?.id, tenant?.id);
  const plans = data.plans ?? [];
  const defaultPlanId = plans.find((plan) => plan.id === 'plan_beta')?.id ?? plans[0]?.id ?? 'plan_beta';
  const [workspaceName, setWorkspaceName] = useState('Revenue Signal Lab');
  const [workspaceDomain, setWorkspaceDomain] = useState('signal-lab.example');
  const [adminEmail, setAdminEmail] = useState('owner@signal-lab.example');
  const [adminName, setAdminName] = useState('Workspace Owner');
  const [planId, setPlanId] = useState(defaultPlanId);
  const [inviteTenantId, setInviteTenantId] = useState(tenant?.id ?? 'tenant_demo');
  const [inviteEmail, setInviteEmail] = useState('success@acme.example');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [inviteTeam, setInviteTeam] = useState('success');
  const pendingInvites = [...(data.invites ?? [])].filter((invite) => invite.status === 'pending').sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const [acceptInviteId, setAcceptInviteId] = useState(pendingInvites[0]?.id ?? '');
  const [claimCode, setClaimCode] = useState(pendingInvites[0]?.claimCode ?? '');
  const [claimEmail, setClaimEmail] = useState(pendingInvites[0]?.email ?? '');
  const [acceptName, setAcceptName] = useState('');
  const [acceptTeam, setAcceptTeam] = useState('');
  const [workspaceErrors, setWorkspaceErrors] = useState<RegistrationFormErrors>({});
  const [inviteErrors, setInviteErrors] = useState<RegistrationFormErrors>({});
  const [claimErrors, setClaimErrors] = useState<RegistrationFormErrors>({});
  const selectedInvite = pendingInvites.find((invite) => invite.id === acceptInviteId) ?? pendingInvites[0];
  const selectedInviteTenant = selectedInvite ? data.tenants.find((item) => item.id === selectedInvite.tenantId) : null;
  const tenantMemberships = tenant ? membershipsForTenant(data, tenant.id) : [];
  const activeTenantMemberships = tenant ? activeMembershipsForTenant(data, tenant.id) : [];
  const tenantInvites = tenant ? (data.invites ?? []).filter((invite) => invite.tenantId === tenant.id) : [];
  const activeSeats = summary.activeMemberships ?? activeTenantMemberships.length;
  const pendingInviteSeats = summary.pendingInviteSeats ?? pendingInvites.length;
  const connectedTenantMailbox = tenant ? data.mailboxes.find((mailbox) => mailbox.tenantId === tenant.id && mailbox.status === 'connected') : null;
  const currentPreference = data.notificationPreferences?.find((preference) => preference.userId === currentActor?.id);
  const tenantEntitlement = data.entitlements.find((entitlement) => entitlement.tenantId === tenant?.id && entitlement.status === 'active');
  const latestReadyMailboxSession = [...(data.mailboxConnectionSessions ?? [])].reverse().find((session) =>
    session.tenantId === tenant?.id &&
    session.ownerUserId === currentActor?.id &&
    session.status === 'ready');
  const canUseApi = source === 'api' && !isMutating;
  const canRegisterWorkspace = canUseApi;
  const canAdminMutate = canUseApi && currentActor?.role === 'admin';
  const canCompleteOnboarding = canUseApi && Boolean(currentActor && tenant);
  const onboardingFeedback = useMutationFeedback(mutate);

  function validateWorkspaceFields() {
    const next: RegistrationFormErrors = {};
    if (!workspaceName.trim()) {
      next.workspaceName = 'Workspace name is required.';
    }
    if (!workspaceDomain.trim()) {
      next.workspaceDomain = 'Domain is required.';
    } else if (!validDomain(workspaceDomain)) {
      next.workspaceDomain = 'Use a domain like company.example.';
    }
    if (!adminEmail.trim()) {
      next.adminEmail = 'Owner email is required.';
    } else if (!validEmail(adminEmail)) {
      next.adminEmail = 'Use a valid owner email.';
    }
    if (!adminName.trim()) {
      next.adminName = 'Owner name is required.';
    }
    return next;
  }

  function validateInviteFields() {
    const next: RegistrationFormErrors = {};
    if (!inviteTenantId) {
      next.inviteTenantId = 'Select a workspace.';
    }
    if (!inviteEmail.trim()) {
      next.inviteEmail = 'Invite email is required.';
    } else if (!validEmail(inviteEmail)) {
      next.inviteEmail = 'Use a valid invite email.';
    }
    return next;
  }

  function validateClaimFields() {
    const next: RegistrationFormErrors = {};
    if (!claimCode.trim()) {
      next.claimCode = 'Claim code is required.';
    }
    if (!claimEmail.trim()) {
      next.claimEmail = 'Invite email is required.';
    } else if (!validEmail(claimEmail)) {
      next.claimEmail = 'Use a valid invite email.';
    }
    return next;
  }

  useEffect(() => {
    if (!inviteTenantId && tenant?.id) {
      setInviteTenantId(tenant.id);
    }
  }, [inviteTenantId, tenant?.id]);

  useEffect(() => {
    if (!acceptInviteId && pendingInvites[0]?.id) {
      setAcceptInviteId(pendingInvites[0].id);
    }
  }, [acceptInviteId, pendingInvites]);

  useEffect(() => {
    if (selectedInvite) {
      setClaimCode(selectedInvite.claimCode ?? '');
      setClaimEmail(selectedInvite.email);
      setClaimErrors({});
    } else if (pendingInvites.length === 0) {
      setClaimCode('');
      setClaimEmail('');
    }
  }, [pendingInvites.length, selectedInvite?.claimCode, selectedInvite?.email, selectedInvite?.id]);

  async function handleWorkspaceSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validateWorkspaceFields();
    setWorkspaceErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      return;
    }
    const outcome = await registerWorkspace({
      adminEmail,
      adminName,
      domain: workspaceDomain,
      name: workspaceName,
      planId,
    });
    if (outcome.ok) {
      setWorkspaceName('');
      setWorkspaceDomain('');
      setAdminEmail('');
      setAdminName('');
      setWorkspaceErrors({});
      return;
    }
    setWorkspaceErrors({ form: outcome.error });
  }

  async function handleInviteSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validateInviteFields();
    setInviteErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      return;
    }
    const outcome = await mutate('users.invite', {
      email: inviteEmail,
      role: inviteRole,
      team: inviteTeam || undefined,
      tenantId: inviteTenantId,
    });
    if (outcome.ok) {
      setInviteEmail('');
      setInviteRole('member');
      setInviteTeam('');
      setInviteErrors({});
      return;
    }
    setInviteErrors({ form: outcome.error });
  }

  async function acceptSelectedInvite() {
    if (!selectedInvite) {
      return;
    }
    const outcome = await mutate('users.invite-accept', {
      inviteId: selectedInvite.id,
      name: acceptName || undefined,
      team: acceptTeam || selectedInvite.team || undefined,
    });
    if (outcome.ok) {
      setAcceptName('');
      setAcceptTeam('');
      setClaimErrors({});
      return;
    }
    setClaimErrors({ form: outcome.error });
  }

  async function handleClaimInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validateClaimFields();
    setClaimErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      return;
    }
    const outcome = await claimInvite({
      claimCode,
      email: claimEmail,
      name: acceptName || undefined,
      team: acceptTeam || selectedInvite?.team || undefined,
    });
    if (outcome.ok) {
      setAcceptInviteId('');
      setClaimCode('');
      setClaimEmail('');
      setAcceptName('');
      setAcceptTeam('');
      setClaimErrors({});
      return;
    }
    setClaimErrors({ form: outcome.error });
  }

  const registrationRows = [
    ['Workspace registration', tenant?.registrationStatus ? titleize(tenant.registrationStatus) : 'Missing'],
    ['Active membership', currentMembership ? `${titleize(currentMembership.role)} · ${titleize(currentMembership.status)}` : 'Missing'],
    ['Connected source', connectedTenantMailbox ? `${titleize(connectedTenantMailbox.provider)} · ${connectedTenantMailbox.id}` : 'Not connected'],
    ['Digest preference', currentPreference ? `${titleize(currentPreference.digestCadence)} · ${titleize(currentPreference.emailDeliveryStatus ?? 'subscribed')}` : 'Missing'],
    ['Billing start', tenantEntitlement ? `Entitlement ${titleize(tenantEntitlement.status)}` : 'Entitlement missing'],
    ['Completion', tenant?.onboardingCompletedAt ? `Completed ${new Date(tenant.onboardingCompletedAt).toLocaleString()}` : 'Not completed'],
  ];

  const privacyRows = tenantMemberships.map((membership) => [
    ownerName(data.users, membership.userId),
    membership.role,
    membership.team ?? 'general',
    titleize(membership.status),
    membership.inviteId ? 'Invite accepted' : 'Direct membership',
  ]);
  const onboardingReadinessRows = onboardingReadiness.rows.map((row) => [
    titleize(row.area),
    row.localOk ? 'Ready' : 'Attention',
    row.productionOk ? 'Ready' : 'Not ready',
    row.evidence.join(' · '),
  ]);

  return (
    <div className="product-shell">
      <ProductHeader active="register" />
      <main className="product-main">
        <StateBanner actorUserId={actorUserId} data={data} error={error} isLoading={isLoading} isMutating={isMutating} lastMutation={lastMutation} lastUpdatedAt={lastUpdatedAt} onActorChange={setActorUserId} onRefresh={refresh} pollingIntervalMs={pollingIntervalMs} source={source} summary={summary} />
        <section className="product-hero-panel registration-hero" data-reveal>
          <div>
            <p className="kicker">
              <UserCog size={18} aria-hidden="true" />
              Registration
            </p>
            <h1>Create the workspace before the dashboard.</h1>
            <p>
              Self-service registration now creates the tenant, owner membership, billing starting point, onboarding notifications, and user invite queue through the same audited state boundary as the admin CLI.
            </p>
          </div>
          <div className="operator-card">
            <span>Operator session</span>
            <strong>{currentActor?.name ?? 'No active user'}</strong>
            <small>{currentActor ? `${currentActor.email} · ${currentActor.role}` : 'Start the local API to mutate state'}</small>
            <small>{currentMembership ? `${currentMembership.id} · ${titleize(currentMembership.status)}` : 'Membership required for app access'}</small>
            <a className="button button-primary" href="#workspace">
              <Activity size={18} aria-hidden="true" />
              <span>Open workspace</span>
            </a>
          </div>
        </section>

        {(!canUseApi || !canAdminMutate) && (
          <section className="billing-gate-panel" aria-live="polite">
            <div>
              <span>{canUseApi ? 'Admin controls gated' : 'Local API required'}</span>
              <strong>{canUseApi ? 'Workspace registration is self-service; invitations, role changes, and admin acceptance stay admin-gated.' : 'Start the local API to register a workspace or manage invites.'}</strong>
              <small>{canUseApi ? 'Use the session selector or CLI to switch to an admin actor before creating invites or accepted memberships.' : 'Seed data can render the screen, but it cannot persist a new workspace registration.'}</small>
            </div>
            <button className="inline-action" disabled={source !== 'api' || isMutating} type="button" onClick={() => void setActorUserId('usr_admin')}>
              Switch to admin
            </button>
          </section>
        )}

        <section className="registration-grid">
          <article className="ops-panel registration-form-panel" data-reveal>
            <PanelHead icon={ShieldCheck} title="Workspace registration" action={canRegisterWorkspace ? 'Self-service ready' : 'API required'} />
            <form className="onboarding-form" noValidate onSubmit={(event) => void handleWorkspaceSubmit(event)}>
              <label>
                <span>Workspace name</span>
                <input
                  aria-describedby={workspaceErrors.workspaceName ? 'workspace-name-error' : undefined}
                  aria-invalid={Boolean(workspaceErrors.workspaceName)}
                  name="workspaceName"
                  value={workspaceName}
                  onChange={(event) => {
                    setWorkspaceName(event.target.value);
                    setWorkspaceErrors((current) => ({ ...current, workspaceName: undefined, form: undefined }));
                  }}
                  required
                />
                {workspaceErrors.workspaceName && <small id="workspace-name-error" className="field-error" role="alert">{workspaceErrors.workspaceName}</small>}
              </label>
              <label>
                <span>Domain</span>
                <input
                  aria-describedby={workspaceErrors.workspaceDomain ? 'workspace-domain-error' : undefined}
                  aria-invalid={Boolean(workspaceErrors.workspaceDomain)}
                  name="workspaceDomain"
                  value={workspaceDomain}
                  onChange={(event) => {
                    setWorkspaceDomain(event.target.value);
                    setWorkspaceErrors((current) => ({ ...current, workspaceDomain: undefined, form: undefined }));
                  }}
                  required
                />
                {workspaceErrors.workspaceDomain && <small id="workspace-domain-error" className="field-error" role="alert">{workspaceErrors.workspaceDomain}</small>}
              </label>
              <label>
                <span>Owner email</span>
                <input
                  aria-describedby={workspaceErrors.adminEmail ? 'workspace-admin-email-error' : undefined}
                  aria-invalid={Boolean(workspaceErrors.adminEmail)}
                  name="adminEmail"
                  type="email"
                  value={adminEmail}
                  onChange={(event) => {
                    setAdminEmail(event.target.value);
                    setWorkspaceErrors((current) => ({ ...current, adminEmail: undefined, form: undefined }));
                  }}
                  required
                />
                {workspaceErrors.adminEmail && <small id="workspace-admin-email-error" className="field-error" role="alert">{workspaceErrors.adminEmail}</small>}
              </label>
              <label>
                <span>Owner name</span>
                <input
                  aria-describedby={workspaceErrors.adminName ? 'workspace-admin-name-error' : undefined}
                  aria-invalid={Boolean(workspaceErrors.adminName)}
                  name="adminName"
                  value={adminName}
                  onChange={(event) => {
                    setAdminName(event.target.value);
                    setWorkspaceErrors((current) => ({ ...current, adminName: undefined, form: undefined }));
                  }}
                  required
                />
                {workspaceErrors.adminName && <small id="workspace-admin-name-error" className="field-error" role="alert">{workspaceErrors.adminName}</small>}
              </label>
              <label>
                <span>Plan</span>
                <select name="planId" value={planId} onChange={(event) => setPlanId(event.target.value)}>
                  {plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>{plan.name}</option>
                  ))}
                </select>
              </label>
              {workspaceErrors.form && <p className="form-message is-error" role="alert">{workspaceErrors.form}</p>}
              <button className="inline-action" disabled={!canRegisterWorkspace || isMutating} type="submit">
                <BusyLabel busy={isMutating} busyText="Creating...">Create workspace</BusyLabel>
              </button>
            </form>
            <CommandStrip commands={['npm run admin -- tenants register Revenue_Signal_Lab signal-lab.example owner@signal-lab.example Workspace_Owner plan_beta', 'curl -X POST http://127.0.0.1:8787/api/registration -H "Content-Type: application/json" -d \'{"name":"Revenue Signal Lab","domain":"signal-lab.example","adminEmail":"owner@signal-lab.example","adminName":"Workspace Owner","planId":"plan_beta"}\'', 'npm run admin -- tenants create Revenue_Signal_Lab signal-lab.example owner@signal-lab.example Workspace_Owner plan_beta']} />
          </article>

          <article className="ops-panel registration-form-panel" data-reveal>
            <PanelHead icon={Users} title="Member invitation" action={`${pendingInvites.length} pending`} />
            <form className="onboarding-form" noValidate onSubmit={(event) => void handleInviteSubmit(event)}>
              <label>
                <span>Workspace</span>
                <select
                  aria-describedby={inviteErrors.inviteTenantId ? 'invite-tenant-error' : undefined}
                  aria-invalid={Boolean(inviteErrors.inviteTenantId)}
                  name="inviteTenantId"
                  value={inviteTenantId}
                  onChange={(event) => {
                    setInviteTenantId(event.target.value);
                    setInviteErrors((current) => ({ ...current, inviteTenantId: undefined, form: undefined }));
                  }}
                >
                  {data.tenants.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
                {inviteErrors.inviteTenantId && <small id="invite-tenant-error" className="field-error" role="alert">{inviteErrors.inviteTenantId}</small>}
              </label>
              <label>
                <span>Email</span>
                <input
                  aria-describedby={inviteErrors.inviteEmail ? 'invite-email-error' : undefined}
                  aria-invalid={Boolean(inviteErrors.inviteEmail)}
                  name="inviteEmail"
                  type="email"
                  value={inviteEmail}
                  onChange={(event) => {
                    setInviteEmail(event.target.value);
                    setInviteErrors((current) => ({ ...current, inviteEmail: undefined, form: undefined }));
                  }}
                  required
                />
                {inviteErrors.inviteEmail && <small id="invite-email-error" className="field-error" role="alert">{inviteErrors.inviteEmail}</small>}
              </label>
              <label>
                <span>Role</span>
                <select name="inviteRole" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as 'admin' | 'member')}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
              <label>
                <span>Team</span>
                <input name="inviteTeam" value={inviteTeam} onChange={(event) => setInviteTeam(event.target.value)} />
              </label>
              {inviteErrors.form && <p className="form-message is-error" role="alert">{inviteErrors.form}</p>}
              <button className="inline-action" disabled={!canAdminMutate || isMutating} type="submit">
                <BusyLabel busy={isMutating} busyText="Creating...">Create invite</BusyLabel>
              </button>
            </form>
            <CommandStrip commands={['npm run admin -- users invite tenant_demo teammate@acme.example member success', 'npm run admin -- users --json']} />
          </article>

          <article className="ops-panel registration-form-panel" data-reveal>
            <PanelHead icon={MailCheck} title="Invite acceptance" action={selectedInvite ? selectedInvite.email : 'No pending invite'} />
            <form className="onboarding-form" noValidate onSubmit={(event) => void handleClaimInvite(event)}>
              <label>
                <span>Invite preview</span>
                <select
                  name="acceptInviteId"
                  value={selectedInvite?.id ?? ''}
                  onChange={(event) => {
                    setAcceptInviteId(event.target.value);
                    setClaimErrors({});
                  }}
                  disabled={pendingInvites.length === 0 || isMutating}
                >
                  {pendingInvites.length === 0 && <option value="">No pending invites</option>}
                  {pendingInvites.map((invite) => (
                    <option key={invite.id} value={invite.id}>{invite.email}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Claim code</span>
                <input
                  aria-describedby={claimErrors.claimCode ? 'claim-code-error' : undefined}
                  aria-invalid={Boolean(claimErrors.claimCode)}
                  name="claimCode"
                  value={claimCode}
                  onChange={(event) => {
                    setClaimCode(event.target.value);
                    setClaimErrors((current) => ({ ...current, claimCode: undefined, form: undefined }));
                  }}
                  required
                />
                {claimErrors.claimCode && <small id="claim-code-error" className="field-error" role="alert">{claimErrors.claimCode}</small>}
              </label>
              <label>
                <span>Invite email</span>
                <input
                  aria-describedby={claimErrors.claimEmail ? 'claim-email-error' : undefined}
                  aria-invalid={Boolean(claimErrors.claimEmail)}
                  name="claimEmail"
                  type="email"
                  value={claimEmail}
                  onChange={(event) => {
                    setClaimEmail(event.target.value);
                    setClaimErrors((current) => ({ ...current, claimEmail: undefined, form: undefined }));
                  }}
                  required
                />
                {claimErrors.claimEmail && <small id="claim-email-error" className="field-error" role="alert">{claimErrors.claimEmail}</small>}
              </label>
              <label>
                <span>Accepted name</span>
                <input name="acceptName" value={acceptName} onChange={(event) => setAcceptName(event.target.value)} placeholder={selectedInvite ? ownerName([{ id: selectedInvite.email, name: selectedInvite.email, email: selectedInvite.email, role: selectedInvite.role, status: 'active', tenantId: selectedInvite.tenantId }], selectedInvite.email) : ''} />
              </label>
              <label>
                <span>Team</span>
                <input name="acceptTeam" value={acceptTeam} onChange={(event) => setAcceptTeam(event.target.value)} placeholder={selectedInvite?.team ?? 'sales'} />
              </label>
              {claimErrors.form && <p className="form-message is-error" role="alert">{claimErrors.form}</p>}
              <button className="inline-action" disabled={!canUseApi || isMutating || !claimCode || !claimEmail} type="submit">
                <BusyLabel busy={isMutating} busyText="Claiming...">Claim invite</BusyLabel>
              </button>
            </form>
            <button className="inline-action secondary-inline-action" disabled={!canAdminMutate || isMutating || !selectedInvite} type="button" onClick={() => void acceptSelectedInvite()}>
              <BusyLabel busy={isMutating} busyText="Accepting...">Admin accept selected</BusyLabel>
            </button>
            {selectedInvite && (
              <div className="invite-acceptance-summary">
                <span>{selectedInviteTenant?.name ?? selectedInvite.tenantId}</span>
                <strong>{selectedInvite.email}</strong>
                <small>{selectedInvite.role} · {selectedInvite.team ?? 'general'} · {inviteClaimCodeSummary(selectedInvite)}</small>
              </div>
            )}
            <CommandStrip commands={['npm run admin -- users claim <claimCode> teammate@acme.example New_Member success', 'curl -X POST http://127.0.0.1:8787/api/invites/claim -H "Content-Type: application/json" -d \'{\"claimCode\":\"<claimCode>\",\"email\":\"teammate@acme.example\"}\'', 'npm run admin -- users accept <inviteId> New_Member success']} />
          </article>

          <article className="ops-panel registration-form-panel" data-reveal>
            <PanelHead icon={LockKeyhole} title="RBAC and privacy proof" action={`${activeSeats}+${pendingInviteSeats} seats`} />
            <div className="check-list">
              <CheckItem ok={Boolean(currentMembership)} label="Every signed-in user must resolve to an active tenant membership before state access." />
              <CheckItem ok={tenantMemberships.every((membership) => membership.tenantId === tenant?.id)} label="Membership records are tenant-scoped and carry role, team, status, and invite source." />
              <CheckItem ok={currentActor?.role === 'admin' || data.mailboxes.filter((mailbox) => mailbox.tenantId === tenant?.id).every((mailbox) => mailbox.ownerUserId === currentActor?.id || mailbox.status !== 'connected')} label="Members only manage owned mailbox sources; admins can govern tenant-wide sources." />
              <CheckItem ok={Boolean(currentPreference)} label="Notification focus, digest cadence, mute rules, and unsubscribe state are stored per user." />
            </div>
            <AdminTable columns={['User', 'Role', 'Team', 'Status', 'Source']} rows={privacyRows.length ? privacyRows : [['No members', '-', '-', '-', '-']]} />
          </article>

          <article className="ops-panel registration-form-panel" data-reveal>
            <PanelHead icon={ShieldCheck} title="Onboarding and org decision" action={titleize(onboardingReadiness.recommendation.decision)} />
            <div className="check-list">
              <CheckItem ok={onboardingReadiness.ok} label={`${onboardingReadiness.summary.localReady}/${onboardingReadiness.summary.total} local onboarding, invite, RBAC, and privacy checks pass.`} />
              <CheckItem ok={onboardingReadiness.recommendation.decision === 'support_multi_member_orgs'} label={onboardingReadiness.recommendation.summary} />
              <CheckItem ok={onboardingReadiness.productionReady} label={onboardingReadiness.productionReady ? 'Production multi-org guardrails are satisfied.' : onboardingReadiness.recommendation.productionGuardrail} />
              <CheckItem ok label={onboardingReadiness.recommendation.perTenantModelDefault} />
            </div>
            <AdminTable columns={['Area', 'Local', 'Production', 'Evidence']} rows={onboardingReadinessRows} />
            <CommandStrip commands={['npm run admin -- onboarding-readiness --json', 'curl http://127.0.0.1:8787/api/onboarding-readiness', 'npm run admin -- readiness --json']} />
          </article>
        </section>

        <section className="ops-panel onboarding-panel registration-status-panel" data-reveal>
          <PanelHead icon={Gauge} title="Onboarding completion" action={tenant?.name ?? 'No workspace'} />
          <AdminTable columns={['Step', 'State']} rows={registrationRows} />
          <div className="button-row">
            <MutationButton
              action="mailboxes.connect-url"
              actionKey="onboarding-mailbox-connect"
              args={{ ownerUserId: currentActor?.id, provider: 'gmail', tenantId: tenant?.id }}
              busyText="Creating..."
              disabled={!canUseApi || !currentActor || !tenant}
              feedback={onboardingFeedback}
            >
              Create Gmail auth
            </MutationButton>
            <MutationButton
              action="mailboxes.complete"
              actionKey="onboarding-mailbox-complete"
              args={{ sessionId: latestReadyMailboxSession?.id }}
              busyText="Completing..."
              disabled={!canUseApi || !latestReadyMailboxSession}
              feedback={onboardingFeedback}
            >
              Complete auth
            </MutationButton>
            <MutationButton
              action="notifications.preference"
              actionKey="onboarding-digest"
              args={{ patch: { digestCadence: 'daily', immediateAlerts: true }, userId: currentActor?.id }}
              busyText="Saving..."
              disabled={!canUseApi || !currentActor}
              feedback={onboardingFeedback}
            >
              Set daily digest
            </MutationButton>
            <MutationButton
              action="tenants.onboarding-complete"
              actionKey="onboarding-complete"
              args={{ tenantId: tenant?.id }}
              busyText="Completing..."
              disabled={!canCompleteOnboarding}
              feedback={onboardingFeedback}
            >
              Complete onboarding
            </MutationButton>
            <a className="inline-action" href="#workspace">Continue to workspace</a>
            <a className="inline-action" href="#admin">Review admin</a>
          </div>
          <InlineError message={onboardingFeedback.errorFor('onboarding-mailbox-connect', 'onboarding-mailbox-complete', 'onboarding-digest', 'onboarding-complete')} />
          <CommandStrip commands={['npm run admin -- mailboxes connect-url tenant_demo gmail usr_admin', 'npm run admin -- mailboxes complete <sessionId>', 'npm run admin -- tenants complete-onboarding tenant_demo --actor usr_admin', 'curl -X POST http://127.0.0.1:8787/api/mutations -H "Content-Type: application/json" -H "X-Signal-Actor: usr_admin" -d \'{"action":"tenants.onboarding-complete","args":{"tenantId":"tenant_demo"}}\'']} />
        </section>
      </main>
    </div>
  );
}

function prioritySortValue(priority: 'critical' | 'high' | 'medium' | 'low') {
  return {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  }[priority];
}


function UserWorkspace({ liveState }: { liveState: LiveState }) {
  const { actorUserId, backendReadiness, data, digestionPipeline: loadedDigestionPipeline, error, isLoading, isMutating, lastMutation, lastUpdatedAt, mutate, onboardingReadiness: loadedOnboardingReadiness, pollingIntervalMs, refresh, setActorUserId, source, summary } = liveState;
  const onboardingReadiness = loadedOnboardingReadiness ?? fallbackOnboardingReadiness(data, backendReadiness);
  const digestionPipeline = loadedDigestionPipeline ?? fallbackSignalDigestionPipeline(data, backendReadiness);
  const users = data.users;
  const currentUser = users.find((user) => user.id === actorUserId) ?? users.find((user) => user.team === 'sales') ?? users[0];
  const tenant = data.tenants.find((item) => item.id === currentUser?.tenantId) ?? data.tenants[0];
  if (!currentUser || !tenant) {
    return (
      <div className="product-shell">
        <ProductHeader active="workspace" />
        <main className="product-main">
          <StateBanner actorUserId={actorUserId} data={data} error={error} isLoading={isLoading} isMutating={isMutating} lastMutation={lastMutation} lastUpdatedAt={lastUpdatedAt} onActorChange={setActorUserId} onRefresh={refresh} pollingIntervalMs={pollingIntervalMs} source={source} summary={summary} />
          {source === 'seed' && <SeedReadOnlyCallout area="workspace" />}
          <section className="ops-panel empty-state" data-reveal>
            <h3>Workspace data unavailable</h3>
            <p>The live API returned no tenant or user records for the workspace view.</p>
            <small>Refresh after bootstrapping a tenant and active membership, or fall back to the seeded local state.</small>
            <div className="button-row">
              <a className="inline-action" href="#register">Register workspace</a>
              <a className="inline-action" href="#top">Return to public site</a>
            </div>
          </section>
        </main>
      </div>
    );
  }
  const tenantUsers = users.filter((user) => user.tenantId === tenant.id);
  const salesDemoUser = tenantTeamUser(users, tenant.id, 'sales');
  const productDemoUser = tenantTeamUser(users, tenant.id, 'product');
  const checkoutTeamPlanId = resolveTeamCheckoutPlanId(data, tenant.planId);
  const tenantMemberships = membershipsForTenant(data, tenant.id);
  const activeTenantMemberships = activeMembershipsForTenant(data, tenant.id);
  const currentMembership = membershipForUser(data, currentUser?.id, tenant.id);
  const activeCurrentMembership = currentMembership?.status === 'active' ? currentMembership : null;
  const currentRole = activeCurrentMembership?.role ?? currentUser.role;
  const currentTeam = activeCurrentMembership?.team ?? currentUser.team;
  const [selectedAccountName, setSelectedAccountName] = useState('');
  const workspaceFeedback = useMutationFeedback(mutate);
  const visibleSignals = data.signals.filter((signal) =>
    signal.tenantId === tenant.id &&
    (
      currentRole === 'admin' ||
      signal.ownerUserId === currentUser.id ||
      signal.routeTo === currentTeam
    ));
  const assignedSignals = visibleSignals.filter((signal) => signal.ownerUserId === currentUser.id || currentRole === 'admin' || signal.status === 'open');
  const latestFeedbackBySignal = new Map([...((data.signalFeedback ?? []))]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((feedback) => [feedback.signalId, feedback.label]));
  const latestHandoffBySignal = new Map([...((data.signalHandoffs ?? []))]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((handoff) => [handoff.signalId, handoff]));
  const openSignals = visibleSignals.filter((signal) => signal.status === 'open');
  const productSignals = visibleSignals.filter((signal) => signal.type === 'product_idea');
  const generatedSignals = visibleSignals.filter((signal) => signal.sourceMessageId && signal.flowId);
  const memberAccountNames = new Set([
    ...visibleSignals.map((signal) => signal.account),
    ...(data.accountActions ?? []).filter((action) => action.ownerUserId === currentUser.id).map((action) => action.account),
  ]);
  const accounts = (data.accountProfiles ?? []).filter((account) =>
    account.tenantId === tenant.id &&
    (
      currentRole === 'admin' ||
      account.ownerUserId === currentUser.id ||
      memberAccountNames.has(account.name)
    ));
  const selectedAccount = accounts.find((account) => account.name === selectedAccountName) ?? accounts[0];
  const accountActions = selectedAccount ? (data.accountActions ?? []).filter((action) => action.account === selectedAccount.name) : [];
  const accountEvents = selectedAccount ? [...(data.accountEvents ?? [])].filter((event) => event.account === selectedAccount.name).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)) : [];
  const accountReviews = selectedAccount ? [...(data.accountReviews ?? [])].filter((review) => review.account === selectedAccount.name).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) : [];
  const accountRecommendations = selectedAccount ? [...(data.accountRecommendations ?? [])].filter((recommendation) => recommendation.account === selectedAccount.name).sort((a, b) => prioritySortValue(b.priority) - prioritySortValue(a.priority)) : [];
  const openAccountRecommendations = (data.accountRecommendations ?? []).filter((recommendation) => recommendation.tenantId === tenant.id && recommendation.status === 'open' && (currentRole === 'admin' || recommendation.ownerUserId === currentUser.id));
  const openAccountActions = (data.accountActions ?? []).filter((action) => action.tenantId === tenant.id && action.status === 'open' && (currentRole === 'admin' || action.ownerUserId === currentUser.id));
  const atRiskAccounts = accounts.filter((account) => account.healthScore < 55 || account.healthTrend === 'down');
  const visibleMailboxes = data.mailboxes.filter((mailbox) => mailbox.tenantId === tenant.id && (currentRole === 'admin' || mailbox.ownerUserId === currentUser.id));
  const connectedMailboxes = visibleMailboxes.filter((mailbox) => mailbox.status === 'connected');
  const tenantFlows = data.emailFlows.filter((flow) => flow.tenantId === tenant.id);
  const latestFlowRun = [...(data.flowRuns ?? [])].filter((run) => run.tenantId === tenant.id).slice(-1)[0];
  const entitlement = data.entitlements.find((item) => item.tenantId === tenant.id);
  const subscription = data.subscriptions.find((item) => item.tenantId === tenant.id);
  const plan = data.plans.find((item) => item.id === (subscription?.planId ?? tenant.planId));
  const tenantInvoices = [...(data.invoices ?? [])].filter((invoice) => invoice.tenantId === tenant.id).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const pastDueInvoice = tenantInvoices.find((invoice) => invoice.status === 'past_due');
  const latestBillingSessions = [...(data.billingSessions ?? [])].filter((session) => session.tenantId === tenant.id).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const latestBillingSession = latestBillingSessions[0];
  const billingOwner = users.find((user) => user.id === (tenant.billingOwnerUserId ?? tenant.ownerUserId));
  const canManageBilling = currentRole === 'admin' || currentUser.id === tenant.billingOwnerUserId || currentUser.id === tenant.ownerUserId;
  const visibleMailboxIds = new Set(visibleMailboxes.map((mailbox) => mailbox.id));
  const tenantLifecycleNotices = [...(data.lifecycleNotices ?? [])].filter((notice) => notice.tenantId === tenant.id);
  const visibleLifecycleNotices = tenantLifecycleNotices.filter((notice) =>
    currentRole === 'admin' ||
    notice.ownerUserId === currentUser.id ||
    (notice.category === 'payment' && canManageBilling) ||
    (notice.sourceIds?.mailboxId && visibleMailboxIds.has(notice.sourceIds.mailboxId)));
  const paymentLifecycleNotices = visibleLifecycleNotices.filter((notice) => notice.category === 'payment' || notice.category === 'access' || notice.category === 'onboarding');
  const sourceLifecycleNotices = visibleLifecycleNotices.filter((notice) => ['source', 'provider', 'notification'].includes(notice.category));
  const activeTenantSeats = activeTenantMemberships.length || tenantUsers.filter((user) => user.status === 'active').length;
  const pendingTenantInvites = (data.invites ?? []).filter((invite) => invite.tenantId === tenant.id && invite.status === 'pending').length;
  const visibleSourceMessages = (data.sourceMessages ?? []).filter((message) => visibleMailboxes.some((mailbox) => mailbox.id === message.mailboxId));
  const visibleNotifications = (data.notificationEvents ?? []).filter((event) => event.tenantId === tenant.id && event.userId === currentUser.id);
  const tenantSuspended = tenant.status === 'suspended';
  const accessRestricted = tenantSuspended || entitlement?.status !== 'active';
  const memberActionGated = accessRestricted && currentRole !== 'admin';
  const currentUserMailbox = data.mailboxes.find((mailbox) => mailbox.tenantId === tenant.id && mailbox.ownerUserId === currentUser.id && mailbox.status === 'connected');
  const currentUserInvite = (data.invites ?? []).find((invite) => invite.acceptedUserId === currentUser.id || invite.email.toLowerCase() === currentUser.email.toLowerCase());
  const notificationPreference = data.notificationPreferences?.find((preference) => preference.userId === currentUser.id);
  const userEmailDeliveries = [...(data.emailDeliveryMessages ?? [])].filter((message) => message.userId === currentUser.id).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const mailboxSessionsDescending = [...(data.mailboxConnectionSessions ?? [])].reverse();
  const latestSessionForMailbox = (mailboxId: string) => mailboxSessionsDescending.find((session) => session.mailboxId === mailboxId);
  const mailboxWatchesDescending = [...(data.emailWatchSubscriptions ?? [])].reverse();
  const latestWatchForMailbox = (mailboxId: string) => mailboxWatchesDescending.find((watch) => watch.mailboxId === mailboxId);
  const onboardingSteps = [
    {
      label: tenant.registrationStatus === 'active' || tenant.registrationStatus === 'pending_onboarding'
        ? `${tenant.name} workspace is registered.`
        : `${tenant.name} workspace registration is incomplete.`,
      ok: tenant.registrationStatus === 'active' || tenant.registrationStatus === 'pending_onboarding',
    },
    {
      label: currentUserInvite?.status === 'accepted' || currentUser.status === 'active'
        ? `${currentUser.name} has an active workspace membership.`
        : `${currentUser.email} still needs an accepted invite.`,
      ok: Boolean(activeCurrentMembership) || currentUserInvite?.status === 'accepted' || currentUser.status === 'active',
    },
    {
      label: currentUserMailbox
        ? `${titleize(currentUserMailbox.provider)} source is connected.`
        : 'Mailbox source is not connected for this user.',
      ok: Boolean(currentUserMailbox),
    },
    {
      label: notificationPreference?.digestCadence === 'off'
        ? 'Digest delivery is paused.'
        : `${notificationPreference ? titleize(notificationPreference.digestCadence) : 'No'} digest preference is set.`,
      ok: Boolean(notificationPreference),
    },
    {
      label: entitlement?.status === 'active'
        ? `${plan?.name ?? tenant.planId} billing entitlement is active.`
        : 'Billing entitlement is restricted.',
      ok: entitlement?.status === 'active',
    },
  ];
  const userNotifications = [...visibleNotifications]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const unreadNotifications = userNotifications.filter((event) => event.status === 'unread');
  const selectedAccountMuted = Boolean(selectedAccount && notificationPreference?.mutedAccounts?.includes(selectedAccount.name));
  const canMutateNotifications = source === 'api' && !isMutating;
  const pendingInvites = (data.invites ?? []).filter((invite) => invite.tenantId === tenant.id && invite.status === 'pending');
  const canInviteMembers = currentRole === 'admin' && source === 'api' && !isMutating;
  const canStartMailboxAuth = source === 'api' && !isMutating && !memberActionGated;
  const canMutateBilling = source === 'api' && !isMutating && canManageBilling;
  const billingLifecycleRows = [
    ['Starting point', subscription?.trialEndsAt ? `Trial ends ${new Date(subscription.trialEndsAt).toLocaleDateString()}` : subscription?.status ? titleize(subscription.status) : 'Checkout required'],
    ['Failed payment', pastDueInvoice ? `${formatCurrency(pastDueInvoice.amountDueCents)} past due` : 'No past-due invoice'],
    ['Cancel/resubscribe', subscription?.canceledAt ? `Canceled ${new Date(subscription.canceledAt).toLocaleDateString()}` : latestBillingSession?.type === 'checkout' ? 'Checkout session ready' : 'Portal-managed'],
    ['Payment source', latestBillingSession ? `${titleize(latestBillingSession.type)} · ${latestBillingSession.providerMode ?? 'local'}` : subscription?.provider ?? 'local_test'],
  ];
  const dataBoundaryRows = [
    ['Display source', source === 'api' ? 'Local API summary + state' : 'Seed fallback'],
    ['Membership seats', `${activeTenantMemberships.length}/${tenantMemberships.length} active for tenant`],
    ['Org model', onboardingReadiness.recommendation.decision === 'support_multi_member_orgs' ? 'Multi-member workspace' : onboardingReadiness.recommendation.decision],
    ['Onboarding readiness', `${onboardingReadiness.summary.localReady}/${onboardingReadiness.summary.total} local checks`],
    ['Open signals', `${openSignals.length} visible / ${summary.openSignals} total summary`],
    ['Accounts', `${accounts.length} visible / ${summary.accounts ?? data.accountProfiles.length} total summary`],
    ['Mailboxes', `${visibleMailboxes.length} visible / ${summary.mailboxes} total summary`],
    ['Source snippets', `${visibleSourceMessages.length} visible source messages`],
  ];
  const pipelineVizItems = digestionPipeline.rows.map((row) => ({
    accent: row.localOk ? 'lime' as const : 'gold' as const,
    detail: row.localOk ? 'Ready' : 'Attention',
    label: titleize(row.area),
    total: 1,
    value: row.localOk ? 1 : 0,
  }));
  const signalTypeVizItems = ['buying_intent', 'product_idea', 'relationship_risk', 'customer_risk'].map((type, index) => ({
    accent: (['lime', 'gold', 'cyan', 'coral'] as const)[index],
    label: titleize(type),
    value: visibleSignals.filter((signal) => signal.type === type).length,
  }));
  const accountHealthVizItems = [
    {
      accent: 'lime' as const,
      label: '80+',
      value: accounts.filter((account) => account.healthScore >= 80).length,
    },
    {
      accent: 'cyan' as const,
      label: '60-79',
      value: accounts.filter((account) => account.healthScore >= 60 && account.healthScore < 80).length,
    },
    {
      accent: 'gold' as const,
      label: '40-59',
      value: accounts.filter((account) => account.healthScore >= 40 && account.healthScore < 60).length,
    },
    {
      accent: 'coral' as const,
      label: '<40',
      value: accounts.filter((account) => account.healthScore < 40).length,
    },
  ];

  const updatePreference = (patch: Partial<NotificationPreference>) =>
    mutate('notifications.preference', {
      patch,
      userId: currentUser.id,
    });

  useEffect(() => {
    if (accounts.length && !accounts.some((account) => account.name === selectedAccountName)) {
      setSelectedAccountName(accounts[0].name);
    }
  }, [accounts, selectedAccountName]);

  return (
    <div className="product-shell">
      <ProductHeader active="workspace" />
      <main className="product-main">
        <StateBanner actorUserId={actorUserId} data={data} error={error} isLoading={isLoading} isMutating={isMutating} lastMutation={lastMutation} lastUpdatedAt={lastUpdatedAt} onActorChange={setActorUserId} onRefresh={refresh} pollingIntervalMs={pollingIntervalMs} source={source} summary={summary} />
        {source === 'seed' && <SeedReadOnlyCallout area="workspace" />}
        <section className="product-hero-panel workspace-hero" data-reveal>
          <div>
            <p className="kicker">
              <Activity size={18} aria-hidden="true" />
              User workspace
            </p>
            <h1>Revenue signals for {tenant.name}.</h1>
            <p>
              A working product area for sales, product, and success teams to inspect mailbox signals, route account work, and monitor customer relationships from local application state.
            </p>
          </div>
          <div className="operator-card">
            <span>Signed in as</span>
            <strong>{currentUser.name}</strong>
            <small>{currentUser.email}</small>
            <small>{currentMembership ? `Membership ${currentMembership.id} · ${titleize(currentMembership.status)}` : 'Membership missing'}</small>
            <a className="button button-primary" href={currentRole === 'admin' ? '#admin' : '#workspace'}>
              <UserCog size={18} aria-hidden="true" />
              <span>{currentRole === 'admin' ? 'Open admin controls' : 'Member session'}</span>
            </a>
          </div>
        </section>

        {accessRestricted && (
          <section className="billing-gate-panel" aria-live="polite">
            <div>
              <span>{tenantSuspended ? 'Workspace access restricted' : 'Billing attention required'}</span>
              <strong>{tenantSuspended ? 'Tenant suspended' : subscription?.status ? titleize(subscription.status) : 'Subscription missing'}</strong>
              <small>
                {tenantSuspended
                  ? tenant.suspensionReason ?? 'Member product actions are paused until an admin reactivates this workspace.'
                  : pastDueInvoice
                  ? `${formatCurrency(pastDueInvoice.amountDueCents)} invoice past due · next attempt ${pastDueInvoice.nextPaymentAttemptAt ? new Date(pastDueInvoice.nextPaymentAttemptAt).toLocaleDateString() : 'not scheduled'}`
                  : 'Product actions are restricted until billing returns to an active entitlement.'}
              </small>
            </div>
            <a className="inline-action" href="#admin">
              {tenantSuspended ? 'Review admin controls' : 'Review billing'}
            </a>
          </section>
        )}

        <section className="ops-panel onboarding-panel" data-reveal>
          <PanelHead icon={UserCog} title="Onboarding progress" action={currentUserInvite?.status ? titleize(currentUserInvite.status) : 'Active user'} />
          <div className="onboarding-grid">
            <div>
              <span>Workspace seat</span>
              <strong>{currentUser.name}</strong>
              <small>{currentRole} · {currentTeam ?? 'general'} · {currentUser.email}</small>
            </div>
            <div className="check-list">
              {onboardingSteps.map((step) => (
                <CheckItem key={step.label} ok={step.ok} label={step.label} />
              ))}
            </div>
            <div className="button-row compact-actions">
              <button className="inline-action" disabled={!canInviteMembers} type="button" onClick={() => mutate('users.invite', { tenantId: tenant.id, email: `member-${Date.now()}@${tenant.domain}`, role: 'member', team: 'sales' })}>
                Invite member
              </button>
              <MutationButton
                action="mailboxes.connect-url"
                actionKey="workspace-onboarding-mailbox-connect"
                args={{ ownerUserId: currentUser.id, provider: 'gmail', tenantId: tenant.id }}
                busyText="Creating..."
                disabled={!canStartMailboxAuth}
                feedback={workspaceFeedback}
              >
                Create Gmail auth
              </MutationButton>
              {pendingInvites[0] && (
                <button className="inline-action" disabled={!canInviteMembers} type="button" onClick={() => mutate('users.invite-accept', { inviteId: pendingInvites[0].id })}>
                  Accept latest invite
                </button>
              )}
            </div>
            <InlineError message={workspaceFeedback.errorFor('workspace-onboarding-mailbox-connect')} />
          </div>
        </section>

        <section className="metric-grid" aria-label="Workspace metrics">
          <MetricCard icon={Radar} label="Open signals" value={String(openSignals.length)} detail="Need owner action" accent="lime" />
          <MetricCard icon={Gauge} label="At-risk accounts" value={String(atRiskAccounts.length)} detail={`${accounts.length} monitored accounts`} accent="cyan" />
          <MetricCard icon={Lightbulb} label="Idea queue" value={String(productSignals.length)} detail={`${generatedSignals.length} generated signals`} accent="gold" />
          <MetricCard icon={CheckCircle2} label="Next actions" value={String(openAccountActions.length)} detail={entitlement ? `${titleize(entitlement.status)} entitlement` : 'No entitlement'} accent="coral" />
          <MetricCard icon={Brain} label="Strategy recs" value={String(openAccountRecommendations.length)} detail="Source-backed account guidance" accent="cyan" />
          <MetricCard icon={BellRing} label="Unread alerts" value={String(unreadNotifications.length)} detail={`${summary.digestRuns ?? data.notificationDigestRuns?.length ?? 0} digest runs`} accent="lime" />
          <MetricCard icon={AlertTriangle} label="Lifecycle notices" value={String(visibleLifecycleNotices.filter((notice) => notice.status === 'open').length)} detail="Billing, source, and provider state" accent="coral" />
        </section>

        <section className="viz-grid" aria-label="Workspace visualizations">
          <ProgressViz title="Digestion pipeline" items={pipelineVizItems} />
          <BarViz title="Signals by type" items={signalTypeVizItems} />
          <BarViz title="Account health bands" items={accountHealthVizItems} />
        </section>

        <section className="account-monitor-grid" aria-label="Account relationship monitor">
            <article className="ops-panel account-overview-panel is-visible" data-reveal>
            <PanelHead icon={Gauge} title="Account health monitor" action={`${connectedMailboxes.length}/${visibleMailboxes.length} visible sources connected`} />
            <div className="account-card-stack">
              {accounts.map((account) => (
                <AccountHealthCard
                  account={account}
                  isSelected={selectedAccount?.id === account.id}
                  key={account.id}
                  onSelect={() => setSelectedAccountName(account.name)}
                  owner={ownerName(users, account.ownerUserId)}
                  openActions={(data.accountActions ?? []).filter((action) => action.account === account.name && action.status === 'open').length}
                />
              ))}
              {accounts.length === 0 && (
                <div className="empty-state">
                  <strong>No accounts match this session.</strong>
                  <small>{currentRole === 'admin' ? 'Create account profiles or connect tenant sources so relationship health can populate.' : 'Ask an admin to assign accounts or connect your mailbox source so relationship health can populate.'}</small>
                  <a className="inline-action" href={currentRole === 'admin' ? '#admin' : '#register'}>{currentRole === 'admin' ? 'Review admin setup' : 'Review onboarding'}</a>
                </div>
              )}
            </div>
          </article>

          {selectedAccount && (
            <article className="ops-panel account-detail-panel is-visible" data-reveal>
              <PanelHead icon={Layers3} title={selectedAccount.name} action={selectedAccount.stage} />
              <div className="account-detail-grid">
                <div className="account-health-summary">
                  <span>{selectedAccount.domain}</span>
                  <strong>{selectedAccount.healthScore}</strong>
                  <small>{titleize(selectedAccount.healthTrend)} trend · Last touch {new Date(selectedAccount.lastTouchAt).toLocaleDateString()}</small>
                  <div className="health-bar" aria-label={`Health score ${selectedAccount.healthScore}`}>
                    <span style={{ width: `${selectedAccount.healthScore}%` }} />
                  </div>
                  <p>{selectedAccount.summary}</p>
                  <div className="tag-row">
                    {selectedAccount.tags.map((tag) => (
                      <span key={tag}>{titleize(tag)}</span>
                    ))}
                  </div>
                </div>
                <div className="stakeholder-stack">
                  {selectedAccount.stakeholders.map((stakeholder) => (
                    <div className="stakeholder-row" key={stakeholder.id}>
                      <div>
                        <strong>{stakeholder.name}</strong>
                        <small>{stakeholder.title} · {titleize(stakeholder.role)}</small>
                      </div>
                      <span className={`status-pill ${stakeholder.sentiment === 'positive' ? 'active' : stakeholder.sentiment === 'concerned' ? 'past_due' : 'ready'}`}>
                        {titleize(stakeholder.sentiment)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="account-work-grid">
                <div>
                  <h3>Next actions</h3>
                  <div className="account-action-stack">
                    {accountActions.length ? accountActions.map((action) => {
                      const canChangeAction = currentRole === 'admin' || action.ownerUserId === currentUser.id;
                      return (
                        <AccountActionCard
                          action={action}
                          canMutate={canChangeAction && !memberActionGated && source === 'api' && !isMutating}
                          key={action.id}
                          onStatus={(status) => mutate('accounts.action-status', { actionId: action.id, status })}
                          owner={ownerName(users, action.ownerUserId)}
                        />
                      );
                    }) : (
                      <div className="empty-state">
                        <strong>No account actions yet.</strong>
                        <small>{currentRole === 'admin' ? 'Route signals or create account reviews to seed follow-up work for this account.' : 'No follow-up work is assigned to your session for this account.'}</small>
                        <a className="inline-action" href={currentRole === 'admin' ? '#admin/email' : '#workspace'}>{currentRole === 'admin' ? 'Review signal flows' : 'Review signal queue'}</a>
                      </div>
                    )}
                  </div>
                </div>
                <div>
                  <h3>Strategy recommendations</h3>
                  <div className="account-review-stack">
                    {accountRecommendations.length ? accountRecommendations.map((recommendation) => (
                      <AccountRecommendationCard
                        key={recommendation.id}
                        owner={ownerName(users, recommendation.ownerUserId)}
                        recommendation={recommendation}
                      />
                    )) : (
                      <div className="account-review-card">
                        <span>No recommendations</span>
                        <strong>Awaiting account evidence</strong>
                        <small>Run detector flows or create account actions to generate source-backed guidance.</small>
                      </div>
                    )}
                  </div>
                </div>
                <div>
                  <h3>Timeline</h3>
                  <div className="account-event-stack">
                    {accountEvents.length ? accountEvents.map((event) => (
                      <AccountEventRow event={event} key={event.id} />
                    )) : (
                      <div className="empty-state">
                        <strong>No account events yet.</strong>
                        <small>{currentRole === 'admin' ? 'Run detector flows or mailbox sync to attach customer activity to this account.' : 'Customer activity will appear here after a visible source syncs for your account.'}</small>
                        <a className="inline-action" href={currentRole === 'admin' ? '#admin/email' : '#workspace'}>{currentRole === 'admin' ? 'Review email flows' : 'Review mailbox sources'}</a>
                      </div>
                    )}
                  </div>
                </div>
                <div>
                  <h3>Account reviews</h3>
                  <div className="button-row compact-actions">
                    <button
                      className="inline-action"
                      disabled={isMutating || source !== 'api' || memberActionGated || !(currentRole === 'admin' || selectedAccount.ownerUserId === currentUser.id)}
                      type="button"
                      onClick={() => mutate('accounts.review', { account: selectedAccount.name, note: 'Workspace relationship review' })}
                    >
                      Create review
                    </button>
                  </div>
                  <div className="account-review-stack">
                    {accountReviews.length ? accountReviews.map((review) => (
                      <AccountReviewCard key={review.id} review={review} reviewer={ownerName(users, review.createdByUserId)} />
                    )) : (
                      <div className="account-review-card">
                        <span>No reviews</span>
                        <strong>Awaiting snapshot</strong>
                        <small>Create a review to preserve the current health, actions, signals, and timeline context.</small>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </article>
          )}
        </section>

        <section className="workspace-grid">
          <article className="ops-panel billing-panel" data-reveal>
            <PanelHead icon={WalletCards} title="Billing and usage" action={canManageBilling ? 'Billing owner access' : 'Viewer access'} />
            <div className="entitlement-card">
              <span>{plan?.name ?? tenant.planId}</span>
              <strong>{subscription?.status ? titleize(subscription.status) : 'No subscription'}</strong>
              <small>
                {entitlement
                  ? `${activeTenantSeats}+${pendingTenantInvites}/${entitlement.seatLimit} seats · ${visibleMailboxes.length}/${entitlement.mailboxLimit} visible sources · ${visibleSignals.length}/${entitlement.signalLimit.toLocaleString()} visible signals`
                  : 'No stored entitlement found for this workspace.'}
              </small>
              <small>Billing owner: {billingOwner ? billingOwner.name : 'Unassigned'}</small>
              {latestBillingSession && <small>Latest session: {titleize(latestBillingSession.type)} · {latestBillingSession.url}</small>}
            </div>
            <AdminTable columns={['Stage', 'State']} rows={billingLifecycleRows} />
            <AdminTable columns={['Area', 'Trigger', 'Severity', 'Status', 'Action']} rows={lifecycleNoticeRows(paymentLifecycleNotices, 4)} />
            <div className="invoice-stack compact-invoices">
              {tenantInvoices.slice(0, 3).map((invoice) => (
                <InvoiceCard
                  invoice={invoice}
                  key={invoice.id}
                  action={
                    ['open', 'past_due'].includes(invoice.status) ? (
                      <>
                        <MutationButton
                          action="payments.recover"
                          actionKey={`workspace-payment-recover-${invoice.id}`}
                          args={{ invoiceId: invoice.id }}
                          busyText="Creating..."
                          disabled={!canMutateBilling}
                          feedback={workspaceFeedback}
                        >
                          Recovery link
                        </MutationButton>
                        <InlineError message={workspaceFeedback.errorFor(`workspace-payment-recover-${invoice.id}`)} />
                      </>
                    ) : null
                  }
                />
              ))}
            </div>
            <div className="button-row compact-actions">
              <MutationButton
                action="payments.portal"
                actionKey="workspace-payment-portal"
                args={{ tenantId: tenant.id }}
                busyText="Opening..."
                disabled={!canMutateBilling || !subscription}
                feedback={workspaceFeedback}
              >
                Open billing portal
              </MutationButton>
              <MutationButton
                action="payments.checkout"
                actionKey="workspace-payment-checkout"
                args={{ planId: checkoutTeamPlanId, tenantId: tenant.id }}
                busyText="Starting..."
                disabled={!canMutateBilling}
                feedback={workspaceFeedback}
              >
                Start team checkout
              </MutationButton>
            </div>
            <InlineError message={workspaceFeedback.errorFor('workspace-payment-portal', 'workspace-payment-checkout')} />
            <AdminTable columns={['Area', 'Trigger', 'Severity', 'Status', 'Action']} rows={lifecycleNoticeRows(sourceLifecycleNotices, 5)} />
          </article>

          <article className="ops-panel qa-panel" data-reveal>
            <PanelHead icon={Database} title="Dashboard QA" action="State-backed calculations" />
            <AdminTable columns={['Check', 'Value']} rows={dataBoundaryRows} />
            <div className="check-list">
              <CheckItem ok={true} label="Tenant-specific thresholds, routing rules, suppression rules, and feedback labels tune results without creating a separate model per org." />
              <CheckItem ok={onboardingReadiness.recommendation.decision === 'support_multi_member_orgs'} label="Multi-member organizations are supported when tenant membership remains the RBAC and privacy boundary." />
              <CheckItem ok={Boolean(activeCurrentMembership)} label="Active tenant membership is required before role, team, and ownership rules grant access." />
              <CheckItem ok={currentRole === 'admin' || visibleMailboxes.every((mailbox) => mailbox.ownerUserId === currentUser.id)} label={currentRole === 'admin' ? 'Admin membership can review every tenant source.' : 'Member session only sees owned mailbox source cards.'} />
              <CheckItem ok={Boolean(notificationPreference)} label="Each user has digest cadence, immediate alert mode, mute rules, and unsubscribe state." />
              <CheckItem ok={(summary.failedEmailDeliveries ?? 0) === 0} label={`${summary.failedEmailDeliveries ?? 0} failed outbound email deliveries in local state.`} />
            </div>
          </article>

          <article className="ops-panel notification-panel" data-reveal>
            <PanelHead icon={BellRing} title="Notification center" action={`${userNotifications.length} alerts`} />
            <div className="preference-controls">
              <div>
                <span>Digest</span>
                <strong>{notificationPreference ? titleize(notificationPreference.digestCadence) : 'Missing'}</strong>
                <small>{notificationPreference?.immediateAlerts ? 'Immediate dashboard alerts' : 'Quiet dashboard digest'} · Email {titleize(notificationPreference?.emailDeliveryStatus ?? 'subscribed')}</small>
                {userEmailDeliveries[0] && <small>Last email delivery: {titleize(userEmailDeliveries[0].status)} to {userEmailDeliveries[0].toEmail}</small>}
              </div>
              <div className="button-row compact-actions">
                {(['daily', 'weekly', 'off'] as const).map((cadence) => (
                  <button className="inline-action" disabled={!canMutateNotifications || notificationPreference?.digestCadence === cadence} key={cadence} type="button" onClick={() => updatePreference({ digestCadence: cadence })}>
                    {titleize(cadence)}
                  </button>
                ))}
                <button className="inline-action" disabled={!canMutateNotifications} type="button" onClick={() => updatePreference({ immediateAlerts: !notificationPreference?.immediateAlerts })}>
                  {notificationPreference?.immediateAlerts ? 'Quiet mode' : 'Immediate alerts'}
                </button>
                <button className="inline-action" disabled={!canMutateNotifications || notificationPreference?.emailDeliveryStatus === 'unsubscribed'} type="button" onClick={() => mutate('notifications.unsubscribe', { userId: currentUser.id })}>
                  Unsubscribe email
                </button>
                {selectedAccount && (
                  <button
                    className="inline-action"
                    disabled={!canMutateNotifications}
                    type="button"
                    onClick={() => updatePreference({
                      mutedAccounts: selectedAccountMuted
                        ? (notificationPreference?.mutedAccounts ?? []).filter((account) => account !== selectedAccount.name)
                        : [...new Set([...(notificationPreference?.mutedAccounts ?? []), selectedAccount.name])],
                    })}
                  >
                    {selectedAccountMuted ? 'Unmute account' : 'Mute account'}
                  </button>
                )}
              </div>
            </div>
            <div className="notification-stack">
              {userNotifications.slice(0, 5).map((notification) => (
                <NotificationEventCard
                  canMutate={canMutateNotifications}
                  key={notification.id}
                  notification={notification}
                  onStatus={(status) => mutate('notifications.status', { notificationId: notification.id, status })}
                  owner={ownerName(users, notification.userId)}
                />
              ))}
              {userNotifications.length === 0 && (
                <div className="empty-state">
                  <strong>No notifications yet.</strong>
                  <small>Run email flows or account actions to queue local alerts.</small>
                </div>
              )}
            </div>
          </article>

          <article className="ops-panel large-panel" data-reveal>
            <PanelHead icon={Radar} title="Signal queue" action={source === 'api' ? 'Live local API' : 'Seed fallback'} />
            <div className="signal-list">
              {assignedSignals.map((signal) => {
                const signalStatusKey = `workspace-signal-status-${signal.id}`;
                const signalHandoffKey = `workspace-signal-handoff-${signal.id}`;
                const signalUsefulKey = `workspace-signal-feedback-useful-${signal.id}`;
                const signalNoisyKey = `workspace-signal-feedback-noisy-${signal.id}`;
                const canMutateSignal = source === 'api' && !isMutating && !memberActionGated;
                const canMutateOwnedSignal = canMutateSignal && (currentRole === 'admin' || signal.ownerUserId === currentUser.id);

                return (
                  <SignalRow
                    key={signal.id}
                    signal={signal}
                    users={users}
                    feedbackLabel={signal.lastFeedbackLabel ?? latestFeedbackBySignal.get(signal.id)}
                    handoff={latestHandoffBySignal.get(signal.id)}
                    action={
                      <>
                        <MutationButton
                          action="signals.status"
                          actionKey={signalStatusKey}
                          args={{ signalId: signal.id, status: signal.status === 'routed' ? 'open' : 'routed' }}
                          busyText={signal.status === 'routed' ? 'Reopening...' : 'Routing...'}
                          disabled={!canMutateSignal}
                          feedback={workspaceFeedback}
                        >
                          {memberActionGated ? 'Billing gated' : signal.status === 'routed' ? 'Reopen' : 'Route'}
                        </MutationButton>
                        <MutationButton
                          action="signals.handoff"
                          actionKey={signalHandoffKey}
                          args={{ signalId: signal.id, target: 'crm', note: 'Workspace CRM handoff' }}
                          busyText="Handing off..."
                          disabled={!canMutateOwnedSignal}
                          feedback={workspaceFeedback}
                        >
                          CRM handoff
                        </MutationButton>
                        <MutationButton
                          action="signals.feedback"
                          actionKey={signalUsefulKey}
                          args={{ signalId: signal.id, label: 'useful', note: 'Workspace quick feedback' }}
                          busyText="Saving..."
                          disabled={!canMutateOwnedSignal}
                          feedback={workspaceFeedback}
                        >
                          Useful
                        </MutationButton>
                        <MutationButton
                          action="signals.feedback"
                          actionKey={signalNoisyKey}
                          args={{ signalId: signal.id, label: 'noisy', note: 'Workspace quick feedback' }}
                          busyText="Saving..."
                          disabled={!canMutateOwnedSignal}
                          feedback={workspaceFeedback}
                        >
                          Noisy
                        </MutationButton>
                        <InlineError message={workspaceFeedback.errorFor(signalStatusKey, signalHandoffKey, signalUsefulKey, signalNoisyKey)} />
                      </>
                    }
                  />
                );
              })}
              {assignedSignals.length === 0 && (
                <div className="empty-state">
                  <strong>No signals match this session.</strong>
                  <small>{currentRole === 'admin' ? 'Run detector flows or connect tenant mailboxes so the queue has routeable work.' : 'Connect your mailbox source or ask an admin to route signals to your team.'}</small>
                  <a className="inline-action" href={currentRole === 'admin' ? '#admin/email' : '#register'}>{currentRole === 'admin' ? 'Open email flows' : 'Review onboarding'}</a>
                </div>
              )}
            </div>
          </article>

          <article className="ops-panel" data-reveal>
            <PanelHead icon={Route} title="Next best routes" action="Sales + Product + Success" />
            <div className="route-stack">
              {tenantFlows.map((flow) => (
                <div className="route-item" key={flow.id}>
                  <span className={`status-dot ${flow.status}`} />
                  <div>
                    <strong>{flow.name}</strong>
                    <small>Routes to {titleize(flow.routeTo)}</small>
                  </div>
                </div>
              ))}
              {latestFlowRun && (
                <div className="route-item flow-run-summary">
                  <span className="status-dot enabled" />
                  <div>
                    <strong>Latest detector run</strong>
                    <small>{latestFlowRun.createdSignals} created · {latestFlowRun.skippedSignals} skipped · {new Date(latestFlowRun.completedAt ?? latestFlowRun.startedAt).toLocaleString()}</small>
                  </div>
                </div>
              )}
            </div>
          </article>

          <article className="ops-panel" data-reveal>
            <PanelHead icon={Inbox} title="Mailbox sources" action="Permissioned" />
            <div className="mailbox-stack">
              {visibleMailboxes.map((mailbox) => {
                const canManageMailbox = currentRole === 'admin' || mailbox.ownerUserId === currentUser.id;
                const latestSession = latestSessionForMailbox(mailbox.id);
                const readySession = latestSession?.status === 'ready' ? latestSession : undefined;
                const canMutateMailbox = source === 'api' && !isMutating && !memberActionGated;
                const mailboxSyncKey = `workspace-mailbox-sync-${mailbox.id}`;
                const mailboxPauseKey = `workspace-mailbox-pause-${mailbox.id}`;
                const mailboxDisconnectKey = `workspace-mailbox-disconnect-${mailbox.id}`;
                const mailboxResumeKey = `workspace-mailbox-resume-${mailbox.id}`;
                const mailboxConnectKey = `workspace-mailbox-connect-${mailbox.id}`;
                const mailboxCompleteKey = `workspace-mailbox-complete-${readySession?.id ?? mailbox.id}`;
                return (
                  <MailboxCard
                    key={mailbox.id}
                    cursor={data.emailSyncCursors.find((cursor) => cursor.mailboxId === mailbox.id)}
                    mailbox={mailbox}
                    session={latestSession}
                    users={users}
                    watch={latestWatchForMailbox(mailbox.id)}
                    action={
                      canManageMailbox ? (
                        <>
                          {mailbox.status === 'connected' && (
                            <>
                              <MutationButton action="mailboxes.sync" actionKey={mailboxSyncKey} args={{ mailboxId: mailbox.id }} busyText="Syncing..." disabled={!canMutateMailbox} feedback={workspaceFeedback}>
                                Sync source
                              </MutationButton>
                              <MutationButton action="mailboxes.pause" actionKey={mailboxPauseKey} args={{ mailboxId: mailbox.id }} busyText="Pausing..." disabled={!canMutateMailbox} feedback={workspaceFeedback}>
                                Pause
                              </MutationButton>
                              <MutationButton action="mailboxes.disconnect" actionKey={mailboxDisconnectKey} args={{ mailboxId: mailbox.id }} busyText="Disconnecting..." disabled={!canMutateMailbox} feedback={workspaceFeedback}>
                                Disconnect
                              </MutationButton>
                            </>
                          )}
                          {mailbox.status === 'paused' && (
                            <MutationButton action="mailboxes.resume" actionKey={mailboxResumeKey} args={{ mailboxId: mailbox.id }} busyText="Resuming..." disabled={!canMutateMailbox} feedback={workspaceFeedback}>
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
                              feedback={workspaceFeedback}
                            >
                              Create auth link
                            </MutationButton>
                          )}
                          {readySession && (
                            <MutationButton action="mailboxes.complete" actionKey={mailboxCompleteKey} args={{ sessionId: readySession.id }} busyText="Completing..." disabled={!canMutateMailbox} feedback={workspaceFeedback}>
                              Complete auth
                            </MutationButton>
                          )}
                          <InlineError message={workspaceFeedback.errorFor(mailboxSyncKey, mailboxPauseKey, mailboxDisconnectKey, mailboxResumeKey, mailboxConnectKey, mailboxCompleteKey)} />
                        </>
                      ) : null
                    }
                  />
                );
              })}
              {visibleMailboxes.length === 0 && (
                <div className="empty-state">
                  <strong>No mailbox sources are visible.</strong>
                  <small>{currentRole === 'admin' ? 'Connect a tenant source so signals, events, and notifications can be generated.' : 'Connect your mailbox source or ask an admin to grant access to an existing source.'}</small>
                  <MutationButton
                    action="mailboxes.connect-url"
                    actionKey="workspace-empty-mailbox-connect"
                    args={{ ownerUserId: currentUser.id, provider: 'gmail', tenantId: tenant.id }}
                    busyText="Creating..."
                    disabled={!canStartMailboxAuth}
                    feedback={workspaceFeedback}
                  >
                    Create Gmail auth
                  </MutationButton>
                  <InlineError message={workspaceFeedback.errorFor('workspace-empty-mailbox-connect')} />
                </div>
              )}
            </div>
          </article>

          <article className="ops-panel relationship-panel" data-reveal>
            <PanelHead icon={Layers3} title="Account relationship board" action="Health scan" />
            {accounts.map((account) => (
              <div className="relationship-row" key={account.id}>
                <span>{account.name}</span>
                <strong>{account.healthScore} health</strong>
                <small>{ownerName(users, account.ownerUserId)} · {titleize(account.healthTrend)} · {(data.accountRecommendations ?? []).filter((recommendation) => recommendation.account === account.name && recommendation.status === 'open').length} open recs</small>
              </div>
            ))}
          </article>
        </section>
      </main>
    </div>
  );
}

function App() {
  const [route, setRoute] = useState(resolveAppRoute);
  const mode = route.mode;
  const liveState = useSignalAppState(mode);

  useEffect(() => {
    const onHashChange = () => setRoute(resolveAppRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useRevealObserver([mode]);

  if (mode === 'workspace') {
    return <UserWorkspace liveState={liveState} />;
  }

  if (mode === 'register') {
    return <RegistrationOnboarding liveState={liveState} />;
  }

  if (mode === 'admin') {
    return (
      <Suspense fallback={<div className="app-loading">Loading admin console...</div>}>
        <AdminConsole liveState={liveState} />
      </Suspense>
    );
  }

  return <MarketingPage />;
}

export default App;
