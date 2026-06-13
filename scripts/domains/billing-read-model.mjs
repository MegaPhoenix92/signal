export function defaultBillingTenantId(state) {
  return state.tenants?.[0]?.id ?? 'tenant_demo';
}

export function countBillingTypes(items) {
  return items.reduce((counts, item) => {
    const key = item?.type ?? item?.trigger ?? item?.status ?? 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function defaultIsHttpResource(value) {
  return /^https?:\/\//i.test(String(value ?? ''));
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

function filterTenantItems(items, tenant) {
  return (items ?? []).filter((item) => !tenant?.id || item.tenantId === tenant.id);
}

export function billingReadModel(state, {
  summary = {},
  tenantId = defaultBillingTenantId(state),
} = {}) {
  const tenant = (state.tenants ?? []).find((item) => item.id === tenantId) ?? state.tenants?.[0] ?? null;
  const subscriptions = filterTenantItems(state.subscriptions, tenant);
  const activeSubscriptions = subscriptions.filter((subscription) => ['trialing', 'active'].includes(subscription.status));
  const canceledSubscriptions = subscriptions.filter((subscription) => subscription.status === 'canceled');
  const entitlements = filterTenantItems(state.entitlements, tenant);
  const activeEntitlements = entitlements.filter((entitlement) => entitlement.status === 'active');
  const invoices = filterTenantItems(state.invoices, tenant);
  const openInvoices = invoices.filter((invoice) => ['open', 'past_due'].includes(invoice.status));
  const paidInvoices = invoices.filter((invoice) => invoice.status === 'paid');
  const invoiceStatusCounts = countBillingTypes(invoices);
  const invoiceStatusesCovered = ['draft', 'open', 'paid', 'past_due', 'void', 'uncollectible']
    .filter((status) => (invoiceStatusCounts[status] ?? 0) > 0);
  const adjustedInvoices = invoices.filter((invoice) => (invoice.refundedCents ?? 0) > 0 || (invoice.creditedCents ?? 0) > 0);
  const sessions = filterTenantItems(state.billingSessions, tenant);
  const sessionCounts = countBillingTypes(sessions);
  const paymentEvents = filterTenantItems(state.paymentEvents, tenant);
  const eventCounts = countBillingTypes(paymentEvents);
  const paymentNotices = filterTenantItems(state.lifecycleNotices, tenant)
    .filter((notice) => notice.category === 'payment');
  const noticeCounts = countBillingTypes(paymentNotices);
  const billingJobs = filterTenantItems(state.jobs, tenant)
    .filter((job) => job.queue === 'billing_webhook');
  const failedBillingJobs = billingJobs.filter((job) => job.status === 'failed');
  const billingOverrides = filterTenantItems(state.billingOverrides, tenant);
  const activeBillingOverrides = billingOverrides.filter((override) => override.status === 'active');
  const signedStripeEvents = paymentEvents.filter((event) => event.provider === 'stripe' && event.signatureStatus === 'verified');
  const signedEventIds = signedStripeEvents.map((event) => event.providerEventId).filter(Boolean);
  const duplicateSignedEventIds = signedEventIds.filter((id, index) => signedEventIds.indexOf(id) !== index);
  const ignoredProviderEvents = paymentEvents.filter((event) => event.appliedType === 'provider.event.ignored' || event.status === 'ignored');
  const driftEvents = paymentEvents.filter((event) => event.type === 'billing.drift.detected');
  const planChangeEvents = paymentEvents.filter((event) =>
    event.providerEventType === 'customer.subscription.trial_will_end' ||
    (event.appliedType === 'subscription.updated' && Boolean(event.providerPreviousPriceId)));
  const distinctPaymentEventTypes = new Set(paymentEvents
    .map((event) => event.appliedType ?? event.type ?? event.providerEventType)
    .filter(Boolean));
  const activeSubscription = activeSubscriptions[0] ?? subscriptions[0] ?? null;
  const activeEntitlement = activeEntitlements[0] ?? entitlements[0] ?? null;
  const activeEntitlementOpenInvoices = openInvoices.filter((invoice) => invoice.subscriptionId === activeEntitlement?.subscriptionId);

  return {
    activeBillingOverrides,
    activeEntitlement,
    activeEntitlementOpenInvoices,
    activeEntitlements,
    activeSubscription,
    activeSubscriptions,
    adjustedInvoices,
    appliedProviderEvents: paymentEvents.filter((event) => event.appliedType),
    billingJobs,
    billingOverrides,
    canceledSubscriptions,
    checkoutCreatedEvents: paymentEvents.filter((event) => event.type === 'checkout.session.created'),
    distinctPaymentEventTypes,
    driftEvents,
    duplicateSignedEventIds,
    entitlements,
    eventCounts,
    failedBillingJobs,
    ignoredProviderEvents,
    invoiceStatusCounts,
    invoiceStatusesCovered,
    invoices,
    noticeCounts,
    openInvoices,
    paidInvoices,
    paymentEvents,
    paymentNotices,
    planChangeEvents,
    portalCreatedEvents: paymentEvents.filter((event) => event.type === 'billing_portal.session.created'),
    providerEventIdEvents: paymentEvents.filter((event) => event.providerEventId),
    sessionCounts,
    signedStripeEvents,
    subscriptions,
    subscriptionsWithProviderPlanChange: subscriptions.filter((subscription) => subscription.providerPlanChangedAt),
    summary,
    tenant,
    trialWillEndEvents: paymentEvents.filter((event) => event.providerEventType === 'customer.subscription.trial_will_end'),
  };
}

export function buildPaymentLifecycleAuditReport(state, {
  backend = null,
  isHttpResource = defaultIsHttpResource,
  provider,
  providerLaunch = null,
  providerLaunchMatrixReport,
  statePath,
  summary = {},
} = {}) {
  if (typeof providerLaunchMatrixReport !== 'function') {
    throw new TypeError('providerLaunchMatrixReport is required to build a payment lifecycle audit report.');
  }

  const billing = billingReadModel(state, { summary });
  const {
    activeBillingOverrides,
    activeEntitlement,
    activeEntitlementOpenInvoices,
    activeEntitlements,
    activeSubscription,
    activeSubscriptions,
    adjustedInvoices,
    appliedProviderEvents,
    billingJobs,
    billingOverrides,
    canceledSubscriptions,
    checkoutCreatedEvents,
    distinctPaymentEventTypes,
    driftEvents,
    duplicateSignedEventIds,
    entitlements,
    eventCounts,
    failedBillingJobs,
    ignoredProviderEvents,
    invoiceStatusCounts,
    invoiceStatusesCovered,
    invoices,
    noticeCounts,
    openInvoices,
    paidInvoices,
    paymentEvents,
    paymentNotices,
    planChangeEvents,
    portalCreatedEvents,
    providerEventIdEvents,
    sessionCounts,
    signedStripeEvents,
    subscriptions,
    subscriptionsWithProviderPlanChange,
    tenant,
    trialWillEndEvents,
  } = billing;
  const launch = providerLaunch ?? providerLaunchMatrixReport(state, { backend, provider });
  const stripeLaunch = launch.rows.find((row) => row.id === 'stripe') ?? null;
  const stripeConfigured = Boolean(stripeLaunch?.configurationReady);
  const stripeSandboxPassed = stripeLaunch?.sandboxStatus === 'passed';
  const stripeLaunchReady = Boolean(stripeLaunch?.launchReady);

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
        `${checkoutCreatedEvents.length} checkout created event(s)`,
        `${portalCreatedEvents.length} portal created event(s)`,
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
        `${activeBillingOverrides.length}/${billingOverrides.length} active billing override(s)`,
        `${activeEntitlementOpenInvoices.length}/${invoices.length} open invoice(s) tied to active entitlement subscription`,
        `${summary.activeSeats ?? 0}/${summary.seatLimit ?? 'unlimited'} active seats`,
      ],
      localOk: activeEntitlements.length > 0 && activeEntitlementOpenInvoices.length === 0 && failedBillingJobs.length === 0,
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
        `${providerEventIdEvents.length} provider event id(s) recorded`,
        `${appliedProviderEvents.length} applied provider event(s)`,
      ],
      localOk: signedStripeEvents.length > 0 && duplicateSignedEventIds.length === 0,
      productionOk: stripeLaunchReady && stripeSandboxPassed,
      recommendation: 'Treat signed provider webhooks as the production subscription source of truth and reject unsigned or replayed event payloads.',
      requiredEnv: ['STRIPE_WEBHOOK_SECRET'],
      commands: ['STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-sign ./stripe-event.json', 'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>'],
    }),
    paymentLifecycleAuditRow({
      area: 'ignored_webhook_resilience',
      check: 'Signed but unsupported Stripe events are recorded as ignored payment events without failed billing jobs or business-state mutation.',
      evidence: [
        `${ignoredProviderEvents.length} ignored provider event(s) recorded`,
        `${signedStripeEvents.filter((event) => event.appliedType === 'provider.event.ignored').length} verified ignored Stripe event(s)`,
        `${failedBillingJobs.length}/${billingJobs.length} failed billing_webhook job(s)`,
      ],
      localOk: ignoredProviderEvents.length > 0 && failedBillingJobs.length === 0,
      productionOk: stripeLaunchReady && signedStripeEvents.some((event) => event.appliedType === 'provider.event.ignored'),
      recommendation: 'Record provider event coverage first, then map newly relevant Stripe event types deliberately instead of throwing in the webhook path.',
      requiredEnv: ['STRIPE_WEBHOOK_SECRET'],
      commands: ['STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-unknown-event.json <Stripe-Signature>'],
    }),
    paymentLifecycleAuditRow({
      area: 'invoice_status_matrix',
      check: 'Invoice lifecycle exercises draft, open, paid, past_due, void, and uncollectible states without UI/report crashes.',
      evidence: [
        `${invoiceStatusesCovered.length}/6 invoice status value(s) covered`,
        `draft=${invoiceStatusCounts.draft ?? 0}, open=${invoiceStatusCounts.open ?? 0}, paid=${invoiceStatusCounts.paid ?? 0}, past_due=${invoiceStatusCounts.past_due ?? 0}, void=${invoiceStatusCounts.void ?? 0}, uncollectible=${invoiceStatusCounts.uncollectible ?? 0}`,
      ],
      localOk: invoiceStatusesCovered.length === 6,
      productionOk: stripeLaunchReady && signedStripeEvents.some((event) => event.appliedType === 'invoice.uncollectible'),
      recommendation: 'Keep invoice status handling aligned with Stripe terminal states and block recovery for draft, void, and uncollectible invoices.',
      requiredEnv: ['STRIPE_WEBHOOK_SECRET'],
      commands: ['npm run admin -- payments webhook invoice.draft sub_demo --amount 4900', 'npm run admin -- payments webhook invoice.uncollectible sub_demo --amount 4900'],
    }),
    paymentLifecycleAuditRow({
      area: 'plan_change_trial_end',
      check: 'Trial-ending and provider plan-change subscription events are recorded and leave entitlement state derived from the current plan.',
      evidence: [
        `${trialWillEndEvents.length} trial_will_end event(s)`,
        `${planChangeEvents.length} trial/plan-change event(s) with provider evidence`,
        `${subscriptionsWithProviderPlanChange.length} subscription provider price change(s)`,
      ],
      localOk: planChangeEvents.length > 0 && activeEntitlements.length > 0,
      productionOk: stripeLaunchReady && signedStripeEvents.some((event) => event.providerEventType === 'customer.subscription.trial_will_end'),
      recommendation: 'Prefer Stripe Customer Portal for upgrades, but record provider plan deltas and recompute entitlements when subscription.updated changes price metadata.',
      requiredEnv: ['STRIPE_WEBHOOK_SECRET', 'SIGNAL_STRIPE_PRICE_TEAM'],
      commands: ['npm run admin -- payments webhook subscription.updated sub_demo active --plan plan_team --provider-price price_new_team'],
    }),
    paymentLifecycleAuditRow({
      area: 'refund_credit_reconciliation',
      check: 'Refunds, credit notes, and local support credits are visible in payment events and invoice net amounts.',
      evidence: [
        `${eventCounts['invoice.refunded'] ?? 0} refund event(s)`,
        `${(eventCounts['invoice.credit_applied'] ?? 0) + (eventCounts['billing.override.support_credit.created'] ?? 0)} credit event(s)`,
        `${adjustedInvoices.length} invoice(s) with refund or credit totals`,
      ],
      localOk: (eventCounts['invoice.refunded'] ?? 0) > 0 &&
        ((eventCounts['invoice.credit_applied'] ?? 0) > 0 || (eventCounts['billing.override.support_credit.created'] ?? 0) > 0) &&
        adjustedInvoices.length > 0,
      productionOk: stripeLaunchReady && signedStripeEvents.some((event) => event.appliedType === 'invoice.refunded'),
      recommendation: 'Use provider webhooks for refunds/credit notes and audited local support credits only as reconciled billing ledger entries.',
      requiredEnv: ['STRIPE_WEBHOOK_SECRET', 'STRIPE_SECRET_KEY'],
      commands: ['npm run admin -- payments refund <invoiceId> 2500 Courtesy_credit', 'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-refund-event.json <Stripe-Signature>'],
    }),
    paymentLifecycleAuditRow({
      area: 'provider_state_parity',
      check: 'Payment sync records provider parity proof and flags provider/local drift before production launch.',
      evidence: [
        `${eventCounts['billing.sync.completed'] ?? 0} billing sync event(s)`,
        `${driftEvents.length} billing drift event(s)`,
        `${paymentNotices.filter((notice) => notice.trigger === 'billing_drift_detected').length} drift lifecycle notice(s)`,
      ],
      localOk: (eventCounts['billing.sync.completed'] ?? 0) > 0 && driftEvents.length === 0,
      productionOk: stripeLaunchReady && (eventCounts['billing.sync.completed'] ?? 0) > 0 && driftEvents.length === 0,
      recommendation: 'Run payments sync with live-provider mode before launch; treat local force/status commands as simulation unless provider parity is clean.',
      requiredEnv: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
      commands: ['npm run admin -- payments sync tenant_demo --live-provider', 'npm run admin -- payment-lifecycle --json'],
    }),
    paymentLifecycleAuditRow({
      area: 'billing_test_matrix',
      check: 'Billing readiness proof exercises tenant isolation, billing_webhook retry/drain, override expiration, signed replay, recovery, refund, credit, and invoice status vectors.',
      evidence: [
        `${distinctPaymentEventTypes.size} distinct payment event type(s)`,
        `${billingJobs.length} billing_webhook job(s), ${failedBillingJobs.length} failed`,
        `${billingOverrides.length} billing override record(s)`,
        `${invoiceStatusesCovered.length}/6 invoice status value(s) covered`,
      ],
      localOk: distinctPaymentEventTypes.size >= 10 &&
        billingJobs.length > 0 &&
        failedBillingJobs.length === 0 &&
        billingOverrides.length > 0 &&
        invoiceStatusesCovered.length === 6,
      productionOk: stripeLaunchReady &&
        stripeSandboxPassed &&
        signedStripeEvents.length > 0 &&
        failedBillingJobs.length === 0,
      recommendation: 'Keep the billing readiness proof tied to test:tenant-isolation, test:scheduler, verify-local, payment-provider, and payment-handoff so queue and tenant-scope regressions block launch evidence.',
      requiredEnv: ['STRIPE_WEBHOOK_SECRET', 'SIGNAL_STATE_SERVICE_URL', 'DATABASE_URL'],
      commands: ['npm run test:tenant-isolation', 'npm run test:scheduler', 'npm run test:verify-local', 'npm run test:payment-provider', 'npm run test:local'],
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

export function paymentLifecycleRowByArea(report, area) {
  return report?.rows?.find?.((row) => row.area === area) ?? null;
}
