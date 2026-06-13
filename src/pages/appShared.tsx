import { useEffect, useMemo, useRef, useState, type CSSProperties, type DependencyList, type ReactNode } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Command,
  Copy,
  ExternalLink,
  Menu,
  PlayCircle,
  Radar,
  RefreshCw,
  Search,
  TerminalSquare,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  formatCurrency,
  formatPercent,
  ownerName,
  titleize,
  type AccountAction,
  type AccountEvent,
  type AccountProfile,
  type AccountRecommendation,
  type AccountReview,
  type BillingOverride,
  type DataRequest,
  type EmailDeliveryMessage,
  type EmailFlow,
  type EmailRoutingRule,
  type EmailSyncCursor,
  type EmailWatchSubscription,
  type FlowRun,
  type GovernancePolicy,
  type IncidentNote,
  type Invoice,
  type Job,
  type LifecycleNotice,
  type Mailbox,
  type MailboxConnectionSession,
  type NotificationDigestRun,
  type NotificationEvent,
  type ProviderReadinessItem,
  type RedactionRule,
  type Signal,
  type SignalAppData,
  type SignalMutationAction,
  type SignalHandoff,
  type SourceMessage,
  type SuppressionRule,
  type TenantMembership,
  type User,
  type StateSummary,
  type UserInvite,
} from '../signalData';
import type { Accent, AppMode, DataSource, MutationOutcome } from './appTypes';

export type { Accent } from './appTypes';

export function tenantTeamUser(users: User[], tenantId: string, team: string) {
  return users.find((user) => user.tenantId === tenantId && user.team === team);
}

export function resolveTeamCheckoutPlanId(data: SignalAppData, tenantPlanId?: string) {
  return data.plans.find((plan) => plan.id === 'plan_team')?.id ?? tenantPlanId ?? data.plans[0]?.id ?? 'plan_team';
}

export function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function validDomain(value: string) {
  return /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i.test(value.trim());
}

export async function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

export function csvCell(value: unknown) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function downloadTextFile(filename: string, mimeType: string, content: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function latestLocalIso(items: Array<Record<string, unknown>>, fields: string[]) {
  return items
    .flatMap((item) => fields.map((field) => item[field]))
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort()
    .at(-1) ?? null;
}

export function useRevealObserver(dependencies: DependencyList) {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.documentElement.classList.add('motion-reduced');
      return;
    }

    const revealItems = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]')).filter((item) => !item.classList.contains('is-visible'));
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.18 },
    );

    revealItems.forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, dependencies);
}

export function billingOverrideValue(override: BillingOverride) {
  if (override.type === 'support_credit') {
    return override.amountCents ? formatCurrency(override.amountCents) : 'Credit';
  }
  return override.planId ?? 'Tenant state';
}

export function lifecycleNoticeRows(notices: LifecycleNotice[], limit = 5) {
  const rows = notices.slice(0, limit).map((notice) => [
    titleize(notice.category),
    titleize(notice.trigger),
    titleize(notice.severity),
    titleize(notice.status),
    notice.actionLabel ?? notice.title,
  ]);
  return rows.length ? rows : [['None', '-', '-', '-', 'No lifecycle notices']];
}

export function membershipsForTenant(data: SignalAppData, tenantId: string): TenantMembership[] {
  return (data.memberships ?? []).filter((membership) => membership.tenantId === tenantId);
}

export function activeMembershipsForTenant(data: SignalAppData, tenantId: string): TenantMembership[] {
  return membershipsForTenant(data, tenantId).filter((membership) =>
    membership.status === 'active' &&
    data.users.some((user) => user.id === membership.userId && user.status === 'active'));
}

export function membershipForUser(data: SignalAppData, userId?: string, tenantId?: string): TenantMembership | undefined {
  if (!userId) {
    return undefined;
  }
  return (data.memberships ?? []).find((membership) =>
    membership.userId === userId &&
    (!tenantId || membership.tenantId === tenantId));
}

const productNavLinks: Array<{ href: string; label: string; mode?: AppMode }> = [
  { href: '#register', label: 'Register', mode: 'register' },
  { href: '#workspace', label: 'Workspace', mode: 'workspace' },
  { href: '#admin', label: 'Admin', mode: 'admin' },
  { href: '#top', label: 'Public', mode: 'marketing' },
];

export function ProductHeader({ active }: { active: AppMode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileMenuButtonRef = useRef<HTMLButtonElement | null>(null);

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
    <header className="product-header">
      <a className="brand" href="#top" aria-label="Signal public site">
        <span className="brand-mark">
          <Radar size={18} aria-hidden="true" />
        </span>
        <span>Signal</span>
      </a>
      <nav className="product-nav" aria-label="Signal product areas">
        {productNavLinks.map((link) => (
          <a key={link.href} className={active === link.mode ? 'is-active' : ''} href={link.href}>
            {link.label}
          </a>
        ))}
      </nav>
      <button
        ref={mobileMenuButtonRef}
        aria-controls="product-mobile-nav-menu"
        aria-expanded={mobileNavOpen}
        aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'}
        className="mobile-nav-toggle"
        type="button"
        onClick={() => setMobileNavOpen((open) => !open)}
      >
        {mobileNavOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
      </button>
      <nav id="product-mobile-nav-menu" className="mobile-nav-panel" aria-label="Mobile product navigation" hidden={!mobileNavOpen}>
        {productNavLinks.map((link) => (
          <a key={link.href} className={active === link.mode ? 'is-active' : ''} href={link.href} onClick={closeMobileNav}>
            {link.label}
          </a>
        ))}
      </nav>
    </header>
  );
}

export function BusyLabel({ busy, busyText, children }: { busy: boolean; busyText: string; children: ReactNode }) {
  return (
    <>
      {busy && <RefreshCw className="busy-spinner" size={15} aria-hidden="true" />}
      <span className="button-label">{busy ? busyText : children}</span>
    </>
  );
}

export function InlineError({ message }: { message?: string | null }) {
  if (!message) {
    return null;
  }

  return (
    <p className="form-message is-error inline-mutation-error" role="alert">
      {message}
    </p>
  );
}

type MutationHandler = (action: SignalMutationAction, args: Record<string, unknown>) => Promise<MutationOutcome>;

type LocalCommandMutation = {
  action: SignalMutationAction;
  args: Record<string, unknown>;
};

export type MutationFeedback = {
  errorFor: (...keys: string[]) => string | null;
  isPending: (key: string) => boolean;
  pendingKey: string | null;
  run: (key: string, action: SignalMutationAction, args: Record<string, unknown>) => Promise<MutationOutcome>;
};

export function useMutationFeedback(mutate: MutationHandler): MutationFeedback {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function run(key: string, action: SignalMutationAction, args: Record<string, unknown>) {
    setPendingKey(key);
    // Clear prior errors on each new mutation. Actions are globally serialized
    // (isMutating disables all controls during a mutation), so only the most
    // recent failure should surface — this avoids a stale sibling error lingering
    // in a shared InlineError region after a later action succeeds.
    setErrors({});

    try {
      const outcome = await mutate(action, args);
      if (!outcome.ok) {
        setErrors((current) => ({ ...current, [key]: outcome.error }));
      }
      return outcome;
    } finally {
      setPendingKey((current) => current === key ? null : current);
    }
  }

  return {
    errorFor: (...keys: string[]) => keys.map((key) => errors[key]).find(Boolean) ?? null,
    isPending: (key: string) => pendingKey === key,
    pendingKey,
    run,
  };
}

function adminCommandTokens(command: string) {
  const trimmed = command.trim();
  if (!trimmed.startsWith('npm run admin -- ')) {
    return [];
  }
  return trimmed.slice('npm run admin -- '.length).split(/\s+/).filter(Boolean);
}

function commandHasUnsafeLiveSideEffects(command: string) {
  return /<[^>]+>/.test(command) ||
    /\bcurl\b/.test(command) ||
    /\s--env-file\b/.test(command) ||
    /\s--live-provider\b/.test(command) ||
    /^[A-Z0-9_]+=/.test(command.trim());
}

export function localSafeMutationForCommand(command: string): LocalCommandMutation | null {
  if (commandHasUnsafeLiveSideEffects(command)) {
    return null;
  }

  const tokens = adminCommandTokens(command);
  const [area, verb, firstArg, secondArg, ...rest] = tokens;
  if (!area || !verb) {
    return null;
  }

  if (area === 'mailboxes' && verb === 'sync' && firstArg) {
    return { action: 'mailboxes.sync', args: { mailboxId: firstArg } };
  }
  if (area === 'email-flows' && verb === 'run') {
    return {
      action: 'email-flows.run',
      args: {
        ...(firstArg ? { flowId: firstArg } : {}),
        ...(secondArg ? { mailboxId: secondArg } : {}),
      },
    };
  }
  if (area === 'notifications' && verb === 'digest' && firstArg) {
    return { action: 'notifications.digest-run', args: { tenantId: firstArg } };
  }
  if (area === 'payments' && verb === 'sync') {
    return { action: 'payments.sync', args: firstArg ? { tenantId: firstArg } : {} };
  }
  if (area === 'jobs' && verb === 'run') {
    const limitIndex = tokens.indexOf('--limit');
    const limit = limitIndex >= 0 ? Number(tokens[limitIndex + 1]) : undefined;
    const target = firstArg && firstArg !== '--limit' ? firstArg : undefined;
    return {
      action: 'jobs.run',
      args: {
        ...(target ? (target.startsWith('job_') ? { jobId: target } : { queue: target }) : {}),
        ...(Number.isInteger(limit) ? { limit } : {}),
      },
    };
  }
  if (area === 'jobs' && verb === 'drain') {
    return { action: 'jobs.drain', args: firstArg ? { queue: firstArg } : {} };
  }
  if (area === 'accounts' && verb === 'action' && firstArg && secondArg) {
    return { action: 'accounts.action-status', args: { actionId: firstArg, status: secondArg } };
  }
  if (area === 'signals' && verb === 'feedback' && firstArg && secondArg) {
    return {
      action: 'signals.feedback',
      args: {
        label: secondArg,
        signalId: firstArg,
        ...(rest.length ? { note: rest.join(' ').replaceAll('_', ' ') } : {}),
      },
    };
  }
  if (area === 'signals' && verb === 'handoff' && firstArg && secondArg) {
    return {
      action: 'signals.handoff',
      args: {
        signalId: firstArg,
        target: secondArg,
        ...(rest.length ? { note: rest.join(' ').replaceAll('_', ' ') } : {}),
      },
    };
  }

  return null;
}

export function MutationButton({
  action,
  actionKey,
  args,
  busyText,
  children,
  className = 'inline-action',
  disabled = false,
  feedback,
}: {
  action: SignalMutationAction;
  actionKey: string;
  args: Record<string, unknown>;
  busyText: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  feedback: MutationFeedback;
}) {
  const busy = feedback.isPending(actionKey);

  return (
    <button className={className} disabled={disabled || busy} type="button" onClick={() => void feedback.run(actionKey, action, args)}>
      <BusyLabel busy={busy} busyText={busyText}>{children}</BusyLabel>
    </button>
  );
}

export function MetricCard({ icon: Icon, label, value, detail, accent }: { icon: LucideIcon; label: string; value: string; detail: string; accent: Accent }) {
  return (
    <article className={`metric-card accent-${accent}`} data-reveal>
      <Icon size={22} aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

export function StateBanner({
  actorUserId,
  contextTenantId,
  contextTenantLabel = 'Admin context tenant',
  data,
  error,
  isLoading,
  isMutating,
  lastMutation,
  lastUpdatedAt,
  onActorChange,
  onContextTenantChange,
  onRefresh,
  pollingIntervalMs,
  source,
  summary,
}: {
  actorUserId: string;
  contextTenantId?: string;
  contextTenantLabel?: string;
  data: SignalAppData;
  error: string | null;
  isLoading: boolean;
  isMutating: boolean;
  lastMutation: string | null;
  lastUpdatedAt?: string;
  onActorChange: (userId: string) => Promise<void>;
  onContextTenantChange?: (tenantId: string) => void;
  onRefresh: () => Promise<void>;
  pollingIntervalMs?: number;
  source: DataSource;
  summary: StateSummary;
}) {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const actor = data.users.find((user) => user.id === actorUserId) ?? data.users[0];
  const contextTenant = contextTenantId && data.tenants.some((tenant) => tenant.id === contextTenantId)
    ? contextTenantId
    : actor?.tenantId ?? data.tenants[0]?.id ?? '';
  const freshnessText = lastUpdatedAt
    ? `Updated ${new Date(lastUpdatedAt).toLocaleTimeString()}${pollingIntervalMs && pollingIntervalMs > 0 ? ` · polling ${Math.round(pollingIntervalMs / 1000)}s` : ''}`
    : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <section className={`state-banner ${source}`} aria-live="polite">
        <div>
          <span>{source === 'api' ? 'Local API connected' : 'Seed fallback'}</span>
          <strong>{source === 'api' ? summary.statePath ?? 'signal-local.json' : `Start API: npm run api`}</strong>
          <small>{error ? `API note: ${error}` : lastMutation ? `Last mutation: ${lastMutation}` : `${summary.connectedMailboxes}/${summary.mailboxes} sources · ${summary.openSignals} open signals`}</small>
          {freshnessText && <small>{freshnessText}</small>}
        </div>
        <label className="actor-select">
          <span>Session</span>
          <select id="signal-session-select" name="signal-session" disabled={isMutating} value={actor?.id ?? actorUserId} onChange={(event) => void onActorChange(event.target.value)}>
            {data.users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name} ({user.role})
              </option>
            ))}
          </select>
        </label>
        {onContextTenantChange && (
          <label className="actor-select context-tenant-select">
            <span>{contextTenantLabel}</span>
            <select
              id="signal-admin-context-tenant-select"
              name="signal-admin-context-tenant"
              disabled={isMutating}
              value={contextTenant}
              onChange={(event) => onContextTenantChange(event.target.value)}
            >
              {data.tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name} ({tenant.domain})
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="state-banner-actions">
          <button className="inline-action palette-button" type="button" onClick={() => setCommandPaletteOpen(true)}>
            <Command size={16} aria-hidden="true" />
            Command
          </button>
          <button className="inline-action" disabled={isLoading} type="button" onClick={() => void onRefresh()}>
            <RefreshCw size={16} aria-hidden="true" />
            {isLoading ? 'Refreshing' : 'Refresh state'}
          </button>
        </div>
      </section>
      <CommandPalette
        data={data}
        onClose={() => setCommandPaletteOpen(false)}
        onRefresh={onRefresh}
        open={commandPaletteOpen}
        summary={summary}
      />
    </>
  );
}

type CommandPaletteItem = {
  command?: string;
  detail: string;
  group: string;
  href?: string;
  id: string;
  title: string;
};

function commandPaletteItems(data: SignalAppData, summary: StateSummary): CommandPaletteItem[] {
  const adminCommandItems: CommandPaletteItem[] = [
    { command: 'npm run admin -- dashboard-audit --json', detail: 'Audit visible dashboard counts against state summary.', group: 'Commands', id: 'cmd-dashboard-audit', title: 'Dashboard audit' },
    { command: 'npm run admin -- digestion-pipeline --json', detail: 'Review ingestion, detector, feedback, routing, and model policy stages.', group: 'Commands', id: 'cmd-digestion-pipeline', title: 'Digestion pipeline' },
    { command: 'npm run admin -- jobs run provider_validation --limit 1', detail: 'Run one due provider validation job locally.', group: 'Commands', id: 'cmd-provider-validation-job', title: 'Run provider validation job' },
    { command: 'npm run admin -- notifications digest tenant_demo', detail: 'Prepare local notification digest delivery.', group: 'Commands', id: 'cmd-digest', title: 'Run notification digest' },
    { command: 'npm run admin -- payments sync tenant_demo', detail: 'Reconcile local billing overrides and entitlements.', group: 'Commands', id: 'cmd-payments-sync', title: 'Sync payments' },
  ];
  const navItems: CommandPaletteItem[] = [
    { detail: `${summary.openSignals} open signals`, group: 'Navigation', href: '#workspace', id: 'nav-workspace', title: 'Open workspace' },
    { detail: 'Admin dashboard', group: 'Navigation', href: '#admin/dashboard', id: 'nav-admin-dashboard', title: 'Open admin dashboard' },
    { detail: 'Tenant, user, invite, and onboarding controls', group: 'Navigation', href: '#admin/organization', id: 'nav-admin-org', title: 'Open organization admin' },
    { detail: 'Detector, source, routing, and pipeline controls', group: 'Navigation', href: '#admin/email', id: 'nav-admin-email', title: 'Open email flows' },
    { detail: 'Jobs, sessions, backend, and notification controls', group: 'Navigation', href: '#admin/cli', id: 'nav-admin-cli', title: 'Open CLI console' },
  ];
  const tenantItems = data.tenants.map((tenant): CommandPaletteItem => ({
    detail: `${tenant.domain} · ${titleize(tenant.status)}`,
    group: 'Tenants',
    href: `#admin/dashboard?tenant=${encodeURIComponent(tenant.id)}`,
    id: `tenant-${tenant.id}`,
    title: tenant.name,
  }));
  const signalItems = data.signals.slice(0, 12).map((signal): CommandPaletteItem => ({
    detail: `${signal.account} · ${titleize(signal.type)} · ${titleize(signal.status)}`,
    group: 'Signals',
    href: `#admin/platform/signals?tenant=${encodeURIComponent(signal.tenantId)}`,
    id: `signal-${signal.id}`,
    title: signal.summary,
  }));
  const accountItems = (data.accountProfiles ?? []).slice(0, 12).map((account): CommandPaletteItem => ({
    detail: `${account.name} · health ${account.healthScore} · ${titleize(account.healthTrend)}`,
    group: 'Accounts',
    href: `#admin/platform/accounts?tenant=${encodeURIComponent(account.tenantId)}`,
    id: `account-${account.id}`,
    title: account.name,
  }));
  const jobItems = data.jobs.slice(0, 10).map((job): CommandPaletteItem => ({
    command: `npm run admin -- jobs run ${job.id}`,
    detail: `${job.queue} · ${titleize(job.status)} · ${job.targetId}`,
    group: 'Jobs',
    id: `job-${job.id}`,
    title: job.id,
  }));

  return [...navItems, ...adminCommandItems, ...tenantItems, ...signalItems, ...accountItems, ...jobItems];
}

function CommandPalette({
  data,
  onClose,
  onRefresh,
  open,
  summary,
}: {
  data: SignalAppData;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  open: boolean;
  summary: StateSummary;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const items = useMemo(() => commandPaletteItems(data, summary), [data, summary]);
  const visibleItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return items.slice(0, 24);
    }
    return items
      .filter((item) => [item.title, item.detail, item.group, item.command ?? '', item.href ?? ''].join(' ').toLowerCase().includes(needle))
      .slice(0, 24);
  }, [items, query]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery('');
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(visibleItems.length - 1, 0)));
  }, [visibleItems.length]);

  if (!open) {
    return null;
  }

  async function activateItem(item: CommandPaletteItem) {
    if (item.href) {
      window.location.hash = item.href;
      onClose();
      return;
    }
    if (item.command) {
      await copyToClipboard(item.command);
      onClose();
    }
  }

  return (
    <div className="command-palette-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-label="Command palette"
        aria-modal="true"
        className="command-palette"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-palette-search">
          <Search size={18} aria-hidden="true" />
          <input
            aria-label="Search commands, tenants, signals, and accounts"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                onClose();
                return;
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((current) => Math.min(current + 1, visibleItems.length - 1));
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((current) => Math.max(current - 1, 0));
              }
              if (event.key === 'Enter' && visibleItems[activeIndex]) {
                event.preventDefault();
                void activateItem(visibleItems[activeIndex]);
              }
            }}
            placeholder="Search Signal"
            ref={inputRef}
            value={query}
          />
        </div>
        <div className="command-palette-list" role="listbox">
          {visibleItems.length ? visibleItems.map((item, index) => (
            <button
              aria-selected={activeIndex === index}
              className="command-palette-item"
              key={item.id}
              role="option"
              type="button"
              onClick={() => void activateItem(item)}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <span>
                <small>{item.group}</small>
                <strong>{item.title}</strong>
                <em>{item.command ?? item.href ?? item.detail}</em>
              </span>
              <span>
                {item.href ? <ExternalLink size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
              </span>
            </button>
          )) : (
            <div className="command-palette-empty">No matching command or record</div>
          )}
        </div>
        <footer className="command-palette-footer">
          <button className="inline-action" type="button" onClick={() => void onRefresh()}>
            <RefreshCw size={15} aria-hidden="true" />
            Refresh state
          </button>
          <span>Cmd/Ctrl K</span>
        </footer>
      </section>
    </div>
  );
}

export function SeedReadOnlyCallout({ area }: { area: 'workspace' | 'admin' }) {
  return (
    <section className="ops-panel seed-mode-callout" role="note" aria-label="Read-only seed mode" data-reveal>
      <div className="seed-mode-copy">
        <TerminalSquare size={20} aria-hidden="true" />
        <div>
          <span>Read-only seed mode</span>
          <strong>{area === 'admin' ? 'Admin writes are disabled until the live API is running.' : 'Workspace actions are disabled until the live API is running.'}</strong>
          <small>Start the full local stack or the API-only server before using write actions. Seed data stays available for review without persisting changes.</small>
        </div>
      </div>
      <div className="seed-mode-command-row" aria-label="Live API commands">
        <code>npm run dev:local</code>
        <code>npm run api</code>
      </div>
    </section>
  );
}

export function PanelHead({ icon: Icon, title, action }: { icon: LucideIcon; title: string; action: string }) {
  return (
    <div className="panel-head">
      <div>
        <Icon size={20} aria-hidden="true" />
        <h2>{title}</h2>
      </div>
      <span>{action}</span>
    </div>
  );
}

export function SignalRow({
  action,
  feedbackLabel,
  handoff,
  signal,
  users,
}: {
  action?: ReactNode;
  feedbackLabel?: string;
  handoff?: SignalHandoff;
  signal: Signal;
  users: User[];
}) {
  return (
    <div className={`signal-row severity-${signal.severity}`}>
      <div className="signal-row-main">
        <span>{signal.account}</span>
        <strong>{titleize(signal.type)}</strong>
        <p>{signal.summary}</p>
        {signal.sourceSnippet && <small className="signal-source">Source: {signal.sourceSnippet}</small>}
        {handoff && <small>{titleize(handoff.target)} handoff: {titleize(handoff.status)}{handoff.providerRef ? ` · ${handoff.providerRef}` : ''}</small>}
        {!handoff && signal.latestHandoffStatus && <small>Handoff: {titleize(signal.latestHandoffStatus)}</small>}
      </div>
      <div className="signal-row-meta">
        <span>{formatPercent(signal.confidence)}</span>
        <small>{ownerName(users, signal.ownerUserId)}</small>
        {feedbackLabel && <small>Feedback: {titleize(feedbackLabel)}</small>}
        <em>{signal.status}</em>
        {action}
      </div>
    </div>
  );
}

export function AccountHealthCard({
  account,
  isSelected,
  onSelect,
  openActions,
  owner,
}: {
  account: AccountProfile;
  isSelected: boolean;
  onSelect: () => void;
  openActions: number;
  owner: string;
}) {
  return (
    <button className="account-health-card" data-selected={isSelected} type="button" onClick={onSelect}>
      <div>
        <span>{account.stage}</span>
        <strong>{account.name}</strong>
        <small>{owner} · {openActions} open action{openActions === 1 ? '' : 's'}</small>
      </div>
      <div className="account-health-score">
        <strong>{account.healthScore}</strong>
        <small>{titleize(account.healthTrend)}</small>
      </div>
    </button>
  );
}

export function AccountActionCard({
  action,
  canMutate,
  onStatus,
  owner,
}: {
  action: AccountAction;
  canMutate: boolean;
  onStatus: (status: AccountAction['status']) => Promise<unknown>;
  owner: string;
}) {
  return (
    <div className="account-action-card">
      <div>
        <span>{titleize(action.priority)} priority</span>
        <strong>{action.title}</strong>
        <small>{action.description}</small>
        <small>{owner} · Due {new Date(action.dueAt).toLocaleDateString()}</small>
      </div>
      <div className="card-actions">
        <span className={`status-pill ${action.status}`}>{titleize(action.status)}</span>
        <button className="inline-action" disabled={!canMutate || action.status === 'done'} type="button" onClick={() => onStatus('done')}>
          Done
        </button>
        <button className="inline-action" disabled={!canMutate || action.status === 'muted'} type="button" onClick={() => onStatus(action.status === 'muted' ? 'open' : 'muted')}>
          {action.status === 'muted' ? 'Unmute' : 'Mute'}
        </button>
      </div>
    </div>
  );
}

export function AccountEventRow({ event }: { event: AccountEvent }) {
  return (
    <div className="account-event-row">
      <span>{new Date(event.occurredAt).toLocaleDateString()}</span>
      <strong>{event.title}</strong>
      <small>{event.detail}</small>
    </div>
  );
}

export function AccountReviewCard({ review, reviewer }: { review: AccountReview; reviewer: string }) {
  return (
    <div className="account-review-card">
      <span>{titleize(review.riskLevel)} risk · {review.healthScore} health</span>
      <strong>{review.note ?? review.summary}</strong>
      <small>{review.openSignalIds.length} open signals · {review.openActionIds.length} open actions · {review.stakeholderIds.length} stakeholders</small>
      <small>{reviewer} · {new Date(review.createdAt).toLocaleString()}</small>
    </div>
  );
}

export function AccountRecommendationCard({ owner, recommendation }: { owner: string; recommendation: AccountRecommendation }) {
  return (
    <div className="account-review-card">
      <span>{titleize(recommendation.priority)} priority · {titleize(recommendation.kind)}</span>
      <strong>{recommendation.title}</strong>
      <small>{recommendation.rationale}</small>
      <small>{recommendation.strategy}</small>
      <small>
        {owner} · {recommendation.evidenceSignalIds.length} signal refs · {recommendation.evidenceActionIds.length} action refs · {recommendation.stakeholderIds.length} stakeholders
      </small>
    </div>
  );
}

export function NotificationEventCard({
  canMutate,
  notification,
  onStatus,
  owner,
}: {
  canMutate: boolean;
  notification: NotificationEvent;
  onStatus: (status: NotificationEvent['status']) => Promise<unknown>;
  owner: string;
}) {
  return (
    <div className="notification-card">
      <div>
        <span>{notification.account ?? 'Workspace'} · {notification.channel.replaceAll('_', ' ')}</span>
        <strong>{notification.title}</strong>
        <small>{notification.body}</small>
        <small>{owner} · {new Date(notification.createdAt).toLocaleString()}</small>
      </div>
      <div className="card-actions">
        <span className={`status-pill ${notification.status}`}>{titleize(notification.status)}</span>
        {notification.mutedBy && <small>Muted by {notification.mutedBy}</small>}
        <button className="inline-action" disabled={!canMutate || notification.status === 'read'} type="button" onClick={() => onStatus('read')}>
          Read
        </button>
        <button className="inline-action" disabled={!canMutate || notification.status === 'unread'} type="button" onClick={() => onStatus('unread')}>
          Unread
        </button>
        <button className="inline-action" disabled={!canMutate || notification.status === 'muted'} type="button" onClick={() => onStatus('muted')}>
          Mute
        </button>
      </div>
    </div>
  );
}

export function inviteClaimCodeSummary(invite: UserInvite) {
  if (invite.status === 'pending') {
    return invite.claimCode ? `Code ${invite.claimCode}` : 'Claim code delivered out of band';
  }
  return `Claim digest ${invite.claimCodeDigest ?? invite.claimCode ?? '—'}`;
}

export function InviteCard({
  canMutate,
  invite,
  onAccept,
  onRevoke,
}: {
  canMutate: boolean;
  invite: UserInvite;
  onAccept: () => Promise<unknown>;
  onRevoke: () => Promise<unknown>;
}) {
  return (
    <div className="invite-card">
      <div>
        <span>{invite.role} · {invite.team ?? 'general'}</span>
        <strong>{invite.email}</strong>
        <small>{inviteClaimCodeSummary(invite)} · Expires {new Date(invite.expiresAt).toLocaleDateString()}</small>
        {invite.acceptedUserId && <small>Accepted as {invite.acceptedUserId}</small>}
      </div>
      <div className="card-actions">
        <span className={`status-pill ${invite.status}`}>{titleize(invite.status)}</span>
        {invite.status === 'pending' && (
          <>
            <button className="inline-action" disabled={!canMutate} type="button" onClick={onAccept}>
              Accept
            </button>
            <button className="inline-action" disabled={!canMutate} type="button" onClick={onRevoke}>
              Revoke
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function SuppressionRuleCard({
  canMutate,
  onStatus,
  rule,
}: {
  canMutate: boolean;
  onStatus: (status: SuppressionRule['status']) => Promise<unknown>;
  rule: SuppressionRule;
}) {
  return (
    <div className="suppression-rule-card">
      <div>
        <span>{rule.type}</span>
        <strong>{rule.value}</strong>
        <small>{rule.reason}</small>
      </div>
      <div className="card-actions">
        <span className={`status-pill ${rule.status}`}>{titleize(rule.status)}</span>
        <button className="inline-action" disabled={!canMutate || rule.status === 'active'} type="button" onClick={() => onStatus('active')}>
          Enable
        </button>
        <button className="inline-action" disabled={!canMutate || rule.status === 'disabled'} type="button" onClick={() => onStatus('disabled')}>
          Disable
        </button>
      </div>
    </div>
  );
}

export function GovernancePolicyCard({
  canMutate,
  onPolicy,
  policy,
  updatedBy,
}: {
  canMutate: boolean;
  onPolicy: (patch: Partial<GovernancePolicy>) => Promise<unknown>;
  policy: GovernancePolicy;
  updatedBy: string;
}) {
  return (
    <div className="governance-card">
      <div>
        <span>{titleize(policy.redactionMode)} redaction · {titleize(policy.deletionReview)} delete review</span>
        <strong>{policy.sourceRetentionDays} day source retention</strong>
        <small>{policy.rawSnippetRetentionDays} raw snippet days · {policy.exportWindowDays} day export window · Updated by {updatedBy}</small>
      </div>
      <div className="card-actions">
        <button className="inline-action" disabled={!canMutate} type="button" onClick={() => onPolicy({ sourceRetentionDays: 14, rawSnippetRetentionDays: 3, exportWindowDays: 14, redactionMode: 'strict', deletionReview: 'manual' })}>
          Minimize
        </button>
        <button className="inline-action" disabled={!canMutate} type="button" onClick={() => onPolicy({ sourceRetentionDays: 30, rawSnippetRetentionDays: 7, exportWindowDays: 30, redactionMode: 'standard', deletionReview: 'manual' })}>
          Review 30d
        </button>
      </div>
    </div>
  );
}

export function RedactionRuleCard({
  canMutate,
  onStatus,
  rule,
}: {
  canMutate: boolean;
  onStatus: (status: RedactionRule['status']) => Promise<unknown>;
  rule: RedactionRule;
}) {
  return (
    <div className="governance-card">
      <div>
        <span>{rule.scope.replaceAll('_', ' ')}</span>
        <strong>{rule.label}</strong>
        <small>{rule.pattern} to {rule.replacement}</small>
      </div>
      <div className="card-actions">
        <span className={`status-pill ${rule.status}`}>{titleize(rule.status)}</span>
        <button className="inline-action" disabled={!canMutate || rule.status === 'active'} type="button" onClick={() => onStatus('active')}>
          Enable
        </button>
        <button className="inline-action" disabled={!canMutate || rule.status === 'disabled'} type="button" onClick={() => onStatus('disabled')}>
          Disable
        </button>
      </div>
    </div>
  );
}

export function DataRequestCard({
  canMutate,
  onStatus,
  request,
}: {
  canMutate: boolean;
  onStatus: (status: DataRequest['status']) => Promise<unknown>;
  request: DataRequest;
}) {
  return (
    <div className="governance-card">
      <div>
        <span>{request.type} · due {new Date(request.dueAt).toLocaleDateString()}</span>
        <strong>{request.requesterEmail}</strong>
        <small>{request.targetAccount ?? request.targetUserId ?? 'Workspace'} · {request.note ?? 'No note'}</small>
        {request.exportUri && <small>{request.exportUri}</small>}
      </div>
      <div className="card-actions">
        <span className={`status-pill ${request.status}`}>{titleize(request.status)}</span>
        <button className="inline-action" disabled={!canMutate || request.status === 'processing'} type="button" onClick={() => onStatus('processing')}>
          Process
        </button>
        <button className="inline-action" disabled={!canMutate || request.status === 'completed'} type="button" onClick={() => onStatus('completed')}>
          Complete
        </button>
        <button className="inline-action" disabled={!canMutate || request.status === 'rejected'} type="button" onClick={() => onStatus('rejected')}>
          Reject
        </button>
      </div>
    </div>
  );
}

export function IncidentNoteCard({
  canMutate,
  note,
  onResolve,
  owner,
}: {
  canMutate: boolean;
  note: IncidentNote;
  onResolve: () => Promise<unknown>;
  owner: string;
}) {
  return (
    <div className="governance-card">
      <div>
        <span>{titleize(note.severity)} · {new Date(note.createdAt).toLocaleString()}</span>
        <strong>{note.title}</strong>
        <small>{note.body}</small>
        <small>{owner}</small>
      </div>
      <div className="card-actions">
        <span className={`status-pill ${note.status}`}>{titleize(note.status)}</span>
        <button className="inline-action" disabled={!canMutate || note.status === 'resolved'} type="button" onClick={onResolve}>
          Resolve
        </button>
      </div>
    </div>
  );
}

export function DigestRunCard({ run }: { run: NotificationDigestRun }) {
  return (
    <div className="digest-run-card">
      <div>
        <span>{run.channel.replaceAll('_', ' ')}</span>
        <strong>{run.sentCount} notification{run.sentCount === 1 ? '' : 's'} prepared</strong>
        <small>{run.userIds.length} user{run.userIds.length === 1 ? '' : 's'} · {new Date(run.completedAt ?? run.createdAt).toLocaleString()}</small>
      </div>
      <span className={`status-pill ${run.status}`}>{titleize(run.status)}</span>
    </div>
  );
}

export function EmailDeliveryCard({ message }: { message: EmailDeliveryMessage }) {
  return (
    <div className="digest-run-card">
      <div>
        <span>{message.provider} · {message.toEmail}</span>
        <strong>{message.subject}</strong>
        <small>{message.notificationIds.length} notification{message.notificationIds.length === 1 ? '' : 's'} · {new Date(message.sentAt ?? message.createdAt).toLocaleString()}</small>
        {message.statusReason && <small>{message.statusReason}</small>}
      </div>
      <span className={`status-pill ${message.status}`}>{titleize(message.status)}</span>
    </div>
  );
}

export function MailboxCard({ action, cursor, mailbox, session, users, watch }: { action?: ReactNode; cursor?: EmailSyncCursor; mailbox: Mailbox; session?: MailboxConnectionSession; users: User[]; watch?: EmailWatchSubscription }) {
  const selectedTargets = [...(mailbox.syncPolicy.labels ?? []), ...(mailbox.syncPolicy.folders ?? [])].join(', ');

  return (
    <div className="mailbox-card">
      <div>
        <span className={`provider-badge ${mailbox.provider}`}>{mailbox.provider}</span>
        <strong>{ownerName(users, mailbox.ownerUserId)}</strong>
        <small>{selectedTargets || 'No selected folders'} · {mailbox.syncPolicy.lookbackDays} day lookback</small>
        <small>
          Cursor {cursor?.status ?? 'missing'} · Last sync {cursor?.lastSyncedAt ? new Date(cursor.lastSyncedAt).toLocaleString() : 'not run'}
        </small>
        {cursor?.providerRequestDigest && (
          <small>
            {titleize(cursor.providerSyncMode ?? 'local')} sync · {cursor.lastProviderMessageCount ?? 0} provider message{(cursor.lastProviderMessageCount ?? 0) === 1 ? '' : 's'} · {cursor.lastUpsertedSourceMessages ?? 0} upserted · Request {cursor.providerRequestDigest}
          </small>
        )}
        {(cursor?.providerBackoffUntil || cursor?.providerBackoffReason) && (
          <small>
            Provider backoff {cursor.providerBackoffUntil ? `until ${new Date(cursor.providerBackoffUntil).toLocaleString()}` : 'active'}
            {cursor.providerBackoffReason ? ` · ${cursor.providerBackoffReason}` : ''}
          </small>
        )}
        {session && <small>OAuth state {titleize(session.oauthStateStatus ?? 'legacy')} · {session.oauthStateDigest ?? session.id}</small>}
        {session?.callbackPath && <small>Callback: {session.callbackPath}</small>}
        {(mailbox.credentialStatus || session?.credentialStatus) && (
          <small>
            Credential {titleize(mailbox.credentialStatus ?? session?.credentialStatus ?? 'local_only')}
            {(mailbox.credentialExpiresAt ?? session?.credentialExpiresAt) ? ` · Expires ${new Date(mailbox.credentialExpiresAt ?? session?.credentialExpiresAt ?? '').toLocaleString()}` : ''}
          </small>
        )}
        {watch && (
          <small>
            Watch {titleize(watch.status)} · {titleize(watch.setupMode ?? 'local')} · Expires {new Date(watch.expirationAt).toLocaleString()}
            {watch.providerCredentialSource ? ` · Credential ${titleize(watch.providerCredentialSource)}` : ''}
            {watch.providerCredentialRefreshedAt ? ` · Refreshed ${new Date(watch.providerCredentialRefreshedAt).toLocaleString()}` : ''}
          </small>
        )}
        {watch?.providerRetryAfterAt && (
          <small>
            Retry after {new Date(watch.providerRetryAfterAt).toLocaleString()}
            {watch.providerResponseStatus ? ` · HTTP ${watch.providerResponseStatus}` : ''}
          </small>
        )}
        {watch?.providerLastError && <small>Provider error: {watch.providerLastError}</small>}
      </div>
      <div className="card-actions">
        <span className={`status-pill ${mailbox.status}`}>{titleize(mailbox.status)}</span>
        {cursor && <span className={`status-pill ${cursor.status}`}>{titleize(cursor.status)}</span>}
        {watch && <span className={`status-pill ${watch.status}`}>{titleize(watch.status)}</span>}
        {action}
      </div>
    </div>
  );
}

export function FlowCard({ action, flow, rule, users }: { action?: ReactNode; flow: EmailFlow; rule?: EmailRoutingRule; users: User[] }) {
  const routeTo = rule?.routeTo ?? flow.routeTo;
  const owner = rule?.ownerUserId ? ownerName(users, rule.ownerUserId) : 'Auto owner';
  return (
    <div className="flow-card">
      <div>
        <strong>{flow.name}</strong>
        <small>{flow.detects.join(', ')}</small>
      </div>
      <span className={`status-pill ${flow.status}`}>{titleize(flow.status)}</span>
      <em>Route: {titleize(routeTo)} · {owner}</em>
      {rule && <small>{titleize(rule.status)} rule · {rule.id}</small>}
      {action && <div className="card-actions">{action}</div>}
    </div>
  );
}

export function FlowRunCard({ run }: { run: FlowRun }) {
  return (
    <div className="flow-run-card">
      <div>
        <span>{run.flowIds.length === 1 ? run.flowIds[0] : `${run.flowIds.length} flows`}</span>
        <strong>{run.createdSignals} created · {run.skippedSignals} skipped</strong>
        <small>
          {run.scannedMessages} scanned · {run.matchedMessages} matched · {run.suppressedMessages ?? 0} suppressed · {new Date(run.completedAt ?? run.startedAt).toLocaleString()}
        </small>
        {run.routeTargets?.length ? <small>Routes: {run.routeTargets.map(titleize).join(', ')}</small> : null}
      </div>
      <span className={`status-pill ${run.status}`}>{titleize(run.status)}</span>
    </div>
  );
}

export function SourceMessageCard({ message }: { message: SourceMessage }) {
  return (
    <div className="source-message-card">
      <div>
        <span>{message.account}</span>
        <strong>{message.subject}</strong>
        <small>{message.snippet}</small>
        <small>
          {message.mailboxId} · {titleize(message.providerSyncMode ?? 'local')} sync · {message.processedFlowIds?.length ?? 0} processed flow{(message.processedFlowIds?.length ?? 0) === 1 ? '' : 's'}
          {message.providerMessageId ? ` · Provider ${message.providerMessageId}` : ''}
        </small>
        {message.providerRequestDigest && <small>Request {message.providerRequestDigest} · Response {message.providerResponseDigest ?? '-'}</small>}
      </div>
    </div>
  );
}

export function ProviderReadinessCard({ provider }: { provider: ProviderReadinessItem }) {
  return (
    <div className="provider-readiness-card">
      <div className="provider-readiness-head">
        <div>
          <span className={`provider-badge ${provider.id}`}>{provider.category}</span>
          <strong>{provider.label}</strong>
          <small>{provider.boundary}</small>
        </div>
        <span className={`status-pill ${provider.ready ? 'connected' : 'needs_reauth'}`}>
          {provider.ready ? 'Ready' : 'Missing config'}
        </span>
      </div>
      <div className="env-list">
        {provider.required.map((item) => (
          <span className={item.configured ? 'is-configured' : 'is-missing'} key={item.key}>
            {item.configured ? 'Set' : 'Missing'} {item.key}
          </span>
        ))}
        {provider.optional.map((item) => (
          <span className={item.configured ? 'is-configured' : 'is-optional'} key={item.key}>
            {item.configured ? 'Set' : 'Optional'} {item.key}
          </span>
        ))}
      </div>
      <div className="provider-paths">
        <code>{provider.callbackPath}</code>
        <code>{provider.webhookPath}</code>
      </div>
    </div>
  );
}

export function InvoiceCard({ action, invoice }: { action?: ReactNode; invoice: Invoice }) {
  const hasAdjustments = Boolean((invoice.refundedCents ?? 0) > 0 || (invoice.creditedCents ?? 0) > 0);
  return (
    <div className="invoice-card">
      <div>
        <span>{invoice.provider}</span>
        <strong>{formatCurrency(invoice.amountDueCents)} {invoice.currency.toUpperCase()}</strong>
        {hasAdjustments && (
          <small>
            Net {formatCurrency(invoice.netAmountDueCents ?? invoice.amountDueCents)}
            {(invoice.creditedCents ?? 0) > 0 ? ` · Credit ${formatCurrency(invoice.creditedCents ?? 0)}` : ''}
            {(invoice.refundedCents ?? 0) > 0 ? ` · Refunded ${formatCurrency(invoice.refundedCents ?? 0)}` : ''}
          </small>
        )}
        <small>
          Due {new Date(invoice.dueAt).toLocaleDateString()} · Retry {invoice.retryCount}
          {invoice.nextPaymentAttemptAt ? ` · Next attempt ${new Date(invoice.nextPaymentAttemptAt).toLocaleDateString()}` : ''}
        </small>
        <small>{invoice.hostedInvoiceUrl}</small>
      </div>
      <div className="card-actions">
        <span className={`status-pill ${invoice.status}`}>{titleize(invoice.status)}</span>
        {action}
      </div>
    </div>
  );
}

export function JobCard({ action, job }: { action?: ReactNode; job: Job }) {
  return (
    <div className="job-card">
      <div>
        <span>{job.queue}</span>
        <strong>{job.type}</strong>
        <small>{job.message}</small>
      </div>
      <div className="card-actions">
        <span className={`status-pill ${job.status}`}>{titleize(job.status)}</span>
        <small>{job.attempts}/{job.maxAttempts} attempts</small>
        {action}
      </div>
    </div>
  );
}

export function CheckItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="check-item">
      {ok ? <CheckCircle2 size={18} aria-hidden="true" /> : <AlertTriangle size={18} aria-hidden="true" />}
      <span>{label}</span>
    </div>
  );
}

export function AdminTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  if (columns.length > 6) {
    return (
      <div className="admin-table admin-table-records" role="table">
        {rows.map((row, rowIndex) => (
          <div className="admin-record-row" role="row" key={`${rowIndex}-${row.join('-')}`}>
            {row.map((cell, index) => (
              <span className="admin-record-cell" role="cell" key={`${columns[index]}-${cell}-${index}`}>
                <small>{columns[index]}</small>
                <strong>{cell}</strong>
              </span>
            ))}
          </div>
        ))}
      </div>
    );
  }

  const tableStyle = { '--admin-table-columns': columns.length } as CSSProperties;
  return (
    <div className="admin-table" role="table" style={tableStyle}>
      <div className="admin-table-row admin-table-head" role="row">
        {columns.map((column, index) => (
          <span role="columnheader" key={`${column}-${index}`}>
            {column}
          </span>
        ))}
      </div>
      {rows.map((row, rowIndex) => (
        <div className="admin-table-row" role="row" key={`${rowIndex}-${row.join('-')}`}>
          {row.map((cell, index) => (
            <span role="cell" key={`${cell}-${index}`}>
              {cell}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

export function CommandStrip({ commands, disabled = false, feedback }: { commands: string[]; disabled?: boolean; feedback?: MutationFeedback }) {
  const commandRows = commands.map((command) => ({
    command,
    key: `command:${command}`,
    mutation: feedback ? localSafeMutationForCommand(command) : null,
  }));

  return (
    <div className="command-strip" aria-label="Related CLI commands">
      {commandRows.map(({ command, key, mutation }) => (
        <div className="command-strip-row" key={command}>
          <code>{command}</code>
          <button className="command-action" type="button" onClick={() => void copyToClipboard(command)} title="Copy command" aria-label={`Copy ${command}`}>
            <Copy size={15} aria-hidden="true" />
          </button>
          {feedback && mutation && (
            <button
              className="command-action command-run"
              disabled={disabled || feedback.isPending(key)}
              type="button"
              onClick={() => void feedback.run(key, mutation.action, mutation.args)}
              title="Run local state simulation"
            >
              <PlayCircle size={15} aria-hidden="true" />
              <BusyLabel busy={feedback.isPending(key)} busyText="Running">Run sim</BusyLabel>
            </button>
          )}
        </div>
      ))}
      {feedback && <InlineError message={feedback.errorFor(...commandRows.map((row) => row.key))} />}
    </div>
  );
}

export type VizItem = {
  accent?: Accent;
  detail?: string;
  label: string;
  total?: number;
  value: number;
};

function vizPercent(item: VizItem) {
  const total = item.total ?? item.value;
  if (!total || total <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((item.value / total) * 100)));
}

export function ProgressViz({ items, title }: { items: VizItem[]; title: string }) {
  return (
    <article className="viz-panel" data-reveal>
      <div className="viz-panel-head">
        <span>
          <BarChart3 size={18} aria-hidden="true" />
          {title}
        </span>
        <strong>{items.reduce((total, item) => total + item.value, 0)}</strong>
      </div>
      <div className="viz-list">
        {items.map((item) => {
          const percent = vizPercent(item);
          return (
            <div className={`viz-row accent-${item.accent ?? 'cyan'}`} key={item.label}>
              <div>
                <strong>{item.label}</strong>
                <small>{item.detail ?? `${item.value}${item.total ? `/${item.total}` : ''}`}</small>
              </div>
              <span>{percent}%</span>
              <div className="viz-track" aria-hidden="true">
                <i style={{ '--viz-value': `${percent}%` } as CSSProperties} />
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}

export function BarViz({ items, title }: { items: VizItem[]; title: string }) {
  const max = Math.max(...items.map((item) => item.value), 1);

  return (
    <article className="viz-panel bar-viz" data-reveal>
      <div className="viz-panel-head">
        <span>
          <BarChart3 size={18} aria-hidden="true" />
          {title}
        </span>
        <strong>{items.reduce((total, item) => total + item.value, 0)}</strong>
      </div>
      <div className="bar-viz-list">
        {items.map((item) => {
          const percent = Math.round((item.value / max) * 100);
          return (
            <div className={`bar-viz-row accent-${item.accent ?? 'lime'}`} key={item.label}>
              <span>{item.label}</span>
              <div className="bar-viz-track" aria-hidden="true">
                <i style={{ '--viz-value': `${percent}%` } as CSSProperties} />
              </div>
              <strong>{item.value}</strong>
            </div>
          );
        })}
      </div>
    </article>
  );
}
