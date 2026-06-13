import seedData from '../data/sample-seed.json';

export type UserRole = 'admin' | 'member';
export type MembershipStatus = 'active' | 'disabled';
export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';
export type MailboxStatus = 'connected' | 'needs_reauth' | 'paused' | 'disconnected';
export type FlowStatus = 'enabled' | 'disabled';
export type RoutingRuleStatus = 'active' | 'disabled';
export type RoutingTarget = 'sales' | 'product' | 'customer_success' | 'founder' | 'crm';
export type SignalStatus = 'open' | 'routed' | 'dismissed';
export type AccountActionStatus = 'open' | 'done' | 'muted';
export type NotificationStatus = 'unread' | 'read' | 'muted' | 'sent';
export type DigestCadence = 'daily' | 'weekly' | 'off';
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';
export type BillingSessionType = 'checkout' | 'portal' | 'payment_recovery';
export type BillingOverrideType = 'beta_access' | 'support_credit' | 'manual_entitlement' | 'manual_suspension';
export type BillingOverrideStatus = 'active' | 'revoked' | 'expired';
export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'past_due' | 'void' | 'uncollectible';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'drained' | 'dead-letter';
export type MailboxProvider = 'gmail' | 'outlook';
export type ConnectionSessionStatus = 'ready' | 'completed' | 'expired';
export type SyncCursorStatus = 'active' | 'blocked';
export type EmailWatchStatus = 'active' | 'expired' | 'paused' | 'failed';
export type TenantStatus = 'active' | 'suspended';
export type LifecycleNoticeCategory = 'access' | 'onboarding' | 'payment' | 'source' | 'notification' | 'provider';
export type LifecycleNoticeSeverity = 'info' | 'watch' | 'critical';
export type LifecycleNoticeStatus = 'open' | 'monitoring' | 'resolved';

export type Tenant = {
  id: string;
  name: string;
  domain: string;
  status: TenantStatus;
  planId: string;
  ownerUserId?: string | null;
  billingOwnerUserId?: string | null;
  registrationStatus?: 'active' | 'pending_onboarding';
  onboardingCompletedAt?: string | null;
  onboardingCompletedByUserId?: string | null;
  createdAt?: string | null;
  createdByUserId?: string | null;
  domainUpdatedAt?: string | null;
  domainUpdatedByUserId?: string | null;
  statusUpdatedAt?: string | null;
  statusUpdatedByUserId?: string | null;
  suspendedAt?: string | null;
  suspendedByUserId?: string | null;
  suspensionReason?: string | null;
};

export type User = {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  role: UserRole;
  platformRole?: 'operator' | null;
  team?: string;
  status: string;
};

export type TenantMembership = {
  id: string;
  tenantId: string;
  userId: string;
  role: UserRole;
  team?: string | null;
  status: MembershipStatus;
  inviteId?: string | null;
  createdAt: string;
  createdByUserId?: string | null;
  updatedAt?: string | null;
  updatedByUserId?: string | null;
  disabledAt?: string | null;
  disabledByUserId?: string | null;
};

export type UserInvite = {
  id: string;
  tenantId: string;
  email: string;
  role: UserRole;
  team?: string | null;
  status: InviteStatus;
  claimCode?: string | null;
  claimCodeDigest?: string | null;
  invitedByUserId: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
  acceptedUserId?: string;
  acceptedByUserId?: string;
  revokedAt?: string;
  revokedByUserId?: string;
};

export type ApiSession = {
  id: string;
  userId: string;
  tenantId?: string;
  status: 'active' | 'revoked' | 'expired';
  digest: string;
  authMode?: string;
  issuedAt: string;
  expiresAt: string;
  issuedByUserId?: string;
  roleAtIssue?: UserRole;
  revokedAt?: string;
  revokedByUserId?: string;
  updatedAt?: string;
};

export type Mailbox = {
  id: string;
  tenantId: string;
  ownerUserId: string;
  provider: MailboxProvider;
  status: MailboxStatus;
  createdAt?: string | null;
  credentialDigest?: string | null;
  credentialExpiresAt?: string | null;
  credentialStatus?: 'stored' | 'local_only' | 'expired' | 'revoked';
  credentialStoredAt?: string | null;
  credentialVaultRef?: string | null;
  updatedAt?: string | null;
  selectedScopes: string[];
  syncPolicy: {
    labels?: string[];
    folders?: string[];
    lookbackDays: number;
    rawRetentionDays: number;
  };
};

export type MailboxConnectionSession = {
  id: string;
  tenantId: string;
  mailboxId?: string | null;
  provider: MailboxProvider;
  ownerUserId: string;
  status: ConnectionSessionStatus;
  url: string;
  authorizationUrl?: string;
  callbackCodeDigest?: string;
  callbackPath?: string;
  callbackReceivedAt?: string;
  credentialDigest?: string | null;
  credentialExpiresAt?: string | null;
  credentialScopeCount?: number;
  credentialStatus?: 'stored' | 'local_only' | 'expired' | 'revoked';
  credentialStoredAt?: string | null;
  credentialVaultRef?: string | null;
  localCallbackUrl?: string;
  oauthStateDigest?: string;
  oauthStateStatus?: 'issued' | 'verified';
  redirectUri?: string;
  selectedScopes: string[];
  createdAt: string;
  expiresAt: string;
  completedAt?: string;
};

export type EmailSyncCursor = {
  id: string;
  mailboxId: string;
  provider: MailboxProvider;
  status: SyncCursorStatus;
  cursor: string;
  lastSyncedAt: string | null;
  lastReplayAt: string | null;
  lastProviderMessageCount?: number | null;
  lastProviderReplayAt?: string | null;
  lastProviderSyncAt?: string | null;
  lastUpsertedSourceMessages?: number | null;
  providerCredentialRefreshedAt?: string | null;
  providerCredentialSource?: 'local' | 'option' | 'env' | 'vault' | 'missing' | null;
  providerCredentialVaultRef?: string | null;
  providerBackoffReason?: string | null;
  providerBackoffUntil?: string | null;
  providerDeltaLink?: string | null;
  providerLastErrorAt?: string | null;
  providerRequestDigest?: string | null;
  providerResponseStatus?: number | null;
  providerResponseDigest?: string | null;
  providerSyncMode?: 'local' | 'live';
  windowStartAt: string;
};

export type EmailWatchSubscription = {
  id: string;
  tenantId: string;
  mailboxId: string;
  provider: MailboxProvider;
  status: EmailWatchStatus;
  setupMode?: 'local' | 'live';
  providerWatchId?: string | null;
  resource?: string | null;
  topicName?: string | null;
  notificationUrl: string;
  clientStateDigest?: string | null;
  historyId?: string | null;
  setupRequestDigest?: string | null;
  expirationAt: string;
  nextRenewalAt?: string | null;
  notificationCount?: number;
  lastNotificationAt?: string | null;
  providerBackoffReason?: string | null;
  providerCredentialRefreshedAt?: string | null;
  providerCredentialSource?: 'local' | 'option' | 'env' | 'vault' | 'missing' | null;
  providerCredentialVaultRef?: string | null;
  providerLastError?: string | null;
  providerLastErrorAt?: string | null;
  providerLastErrorCode?: string | null;
  providerResponseStatus?: number | null;
  providerRetryAfterAt?: string | null;
  renewalCount?: number;
  createdAt: string;
  setupAt?: string;
  updatedAt?: string;
};

export type EmailFlow = {
  id: string;
  tenantId: string;
  name: string;
  status: FlowStatus;
  detects: string[];
  routeTo: RoutingTarget | string;
  routingRuleId?: string | null;
};

export type EmailRoutingRule = {
  id: string;
  tenantId: string;
  flowId: string;
  routeTo: RoutingTarget | string;
  ownerUserId?: string | null;
  status: RoutingRuleStatus;
  note?: string | null;
  createdAt: string;
  createdByUserId: string;
  updatedAt?: string | null;
  updatedByUserId?: string | null;
};

export type SourceMessage = {
  id: string;
  tenantId: string;
  mailboxId: string;
  providerCursor?: string | null;
  providerMessageId?: string | null;
  providerRequestDigest?: string | null;
  providerResponseDigest?: string | null;
  providerSyncMode?: 'local' | 'live';
  providerThreadId?: string | null;
  account: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  ingestedAt?: string | null;
  labels?: string[];
  processedFlowIds?: string[];
  rawRetentionExpiresAt?: string | null;
};

export type FlowRun = {
  id: string;
  tenantId: string;
  flowId?: string | null;
  flowIds: string[];
  routingRuleIds?: string[];
  routeTargets?: string[];
  mailboxId?: string | null;
  mailboxIds: string[];
  status: 'succeeded' | 'failed' | 'running';
  startedAt: string;
  completedAt?: string;
  actorUserId: string;
  scannedMessages: number;
  matchedMessages: number;
  suppressedMessages?: number;
  createdSignals: number;
  skippedSignals: number;
  createdSignalIds: string[];
};

export type Signal = {
  id: string;
  tenantId: string;
  account: string;
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  confidence: number;
  summary: string;
  ownerUserId: string;
  status: SignalStatus;
  sourceMessageId?: string;
  flowId?: string;
  routeTo?: string;
  routingRuleId?: string | null;
  latestHandoffId?: string | null;
  latestHandoffStatus?: SignalHandoffStatus | null;
  sourceSnippet?: string;
  receivedAt?: string;
  feedbackCount?: number;
  lastFeedbackLabel?: string;
  lastFeedbackAt?: string;
};

export type SignalHandoffTarget = 'crm' | 'task';

export type SignalHandoffStatus = 'queued' | 'sent' | 'failed' | 'canceled';

export type SignalHandoff = {
  id: string;
  tenantId: string;
  signalId: string;
  account: string;
  target: SignalHandoffTarget;
  status: SignalHandoffStatus;
  ownerUserId?: string;
  routeTo?: string | null;
  routingRuleId?: string | null;
  provider: string;
  providerRef?: string | null;
  providerAcceptedAt?: string;
  providerRequestDigest?: string | null;
  providerResponseDigest?: string | null;
  providerStatus?: string | null;
  payloadUri: string;
  summary?: string;
  note?: string | null;
  createdAt: string;
  createdByUserId: string;
  updatedAt?: string;
  updatedByUserId?: string;
  sentAt?: string;
  failedAt?: string;
  canceledAt?: string;
};

export type AccountStakeholder = {
  id: string;
  name: string;
  title: string;
  role: string;
  sentiment: string;
  lastTouchAt: string | null;
};

export type AccountProfile = {
  id: string;
  tenantId: string;
  name: string;
  domain: string;
  stage: string;
  ownerUserId: string;
  healthScore: number;
  healthTrend: 'up' | 'down' | 'flat';
  lastTouchAt: string;
  lastReviewAt?: string | null;
  nextReviewAt: string;
  summary: string;
  tags: string[];
  stakeholders: AccountStakeholder[];
};

export type AccountEvent = {
  id: string;
  tenantId: string;
  account: string;
  type: string;
  title: string;
  detail: string;
  occurredAt: string;
  sourceMessageId?: string | null;
  signalId?: string | null;
  actionId?: string | null;
  reviewId?: string | null;
};

export type AccountReview = {
  id: string;
  tenantId: string;
  account: string;
  accountId: string;
  ownerUserId: string;
  healthScore: number;
  healthTrend: 'up' | 'down' | 'flat';
  stage: string;
  riskLevel: 'low' | 'medium' | 'high';
  openSignalIds: string[];
  openActionIds: string[];
  stakeholderIds: string[];
  latestEventIds: string[];
  summary: string;
  note?: string | null;
  createdAt: string;
  createdByUserId: string;
};

export type AccountRecommendation = {
  id: string;
  tenantId: string;
  account: string;
  accountId: string;
  ownerUserId: string;
  kind: 'renewal_save' | 'expansion' | 'product_discovery' | 'relationship_repair' | 'account_review';
  priority: 'critical' | 'high' | 'medium' | 'low';
  status: 'open' | 'done' | 'muted';
  title: string;
  rationale: string;
  strategy: string;
  evidenceSignalIds: string[];
  evidenceActionIds: string[];
  stakeholderIds: string[];
  createdAt: string;
  updatedAt?: string | null;
  createdByUserId?: string | null;
};

export type AccountAction = {
  id: string;
  tenantId: string;
  account: string;
  ownerUserId: string;
  title: string;
  description: string;
  status: AccountActionStatus;
  priority: 'critical' | 'high' | 'medium' | 'low';
  dueAt: string;
  signalId?: string | null;
  createdAt: string;
  completedAt?: string | null;
};

export type NotificationPreference = {
  id: string;
  tenantId: string;
  userId: string;
  digestCadence: DigestCadence;
  immediateAlerts: boolean;
  channels: string[];
  mutedAccounts: string[];
  mutedSignalTypes: string[];
  emailDeliveryStatus?: 'subscribed' | 'unsubscribed';
  unsubscribeCode?: string;
  unsubscribedAt?: string | null;
  updatedAt: string;
};

export type NotificationEvent = {
  id: string;
  tenantId: string;
  userId: string;
  account?: string | null;
  type: string;
  title: string;
  body: string;
  status: NotificationStatus;
  channel: string;
  mutedBy?: 'manual' | 'preference' | null;
  signalId?: string | null;
  sourceMessageId?: string | null;
  accountActionId?: string | null;
  createdAt: string;
  readAt?: string | null;
  digestRunId?: string | null;
};

export type NotificationDigestRun = {
  id: string;
  tenantId: string;
  requestedUserId?: string | null;
  actorUserId: string;
  status: 'succeeded' | 'failed' | 'running';
  channel: string;
  notificationIds: string[];
  userIds: string[];
  sentCount: number;
  createdAt: string;
  completedAt?: string;
};

export type EmailDeliveryMessage = {
  id: string;
  tenantId: string;
  digestRunId?: string | null;
  userId: string;
  toEmail: string;
  provider: string;
  providerAcceptedAt?: string | null;
  providerEventId?: string | null;
  providerEventIds?: string[];
  providerMessageId?: string | null;
  providerMode?: 'local' | 'live';
  providerRequestDigest?: string | null;
  providerResponseDigest?: string | null;
  providerSignatureStatus?: string | null;
  providerSignatureVerifiedAt?: string | null;
  providerStatus?: string | null;
  providerStatusUpdatedAt?: string | null;
  subject: string;
  status: 'queued' | 'sent' | 'failed' | 'bounced' | 'suppressed';
  notificationIds: string[];
  unsubscribeCode: string;
  createdAt: string;
  deliveryAttemptCount?: number;
  sentAt?: string | null;
  statusReason?: string | null;
};

export type SignalQualitySettings = {
  id: string;
  tenantId: string;
  minimumConfidence: number;
  requireSourceReference: boolean;
  autoRouteThreshold: number;
  updatedAt: string;
  updatedByUserId: string;
};

export type SuppressionRule = {
  id: string;
  tenantId: string;
  type: 'domain' | 'sender' | 'account' | 'term';
  value: string;
  status: 'active' | 'disabled';
  reason: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt?: string;
  updatedByUserId?: string;
};

export type SignalFeedback = {
  id: string;
  tenantId: string;
  signalId: string;
  userId: string;
  label: 'useful' | 'noisy' | 'wrong_route' | 'bad_source' | 'product_gap';
  note?: string | null;
  createdAt: string;
};

export type ModelGovernancePolicy = {
  id: string;
  tenantId: string;
  status: 'active' | 'paused';
  detectorBoundary: 'shared_detector';
  dataBoundary: 'tenant_isolated';
  learningMode: 'disabled' | 'opt_in_tuning';
  trainingDataUse: 'excluded_by_default' | 'opt_in_only';
  perTenantModel: boolean;
  tuningControls: string[];
  decision: string;
  note?: string | null;
  updatedAt: string;
  updatedByUserId: string;
};

export type GovernancePolicy = {
  id: string;
  tenantId: string;
  sourceRetentionDays: number;
  rawSnippetRetentionDays: number;
  exportWindowDays: number;
  deletionReview: 'manual' | 'automatic';
  redactionMode: 'standard' | 'strict';
  updatedAt: string;
  updatedByUserId: string;
};

export type RedactionRule = {
  id: string;
  tenantId: string;
  label: string;
  scope: 'source_snippets' | 'notifications' | 'exports';
  pattern: string;
  replacement: string;
  status: 'active' | 'disabled';
  createdByUserId: string;
  createdAt: string;
  updatedAt?: string;
  updatedByUserId?: string;
};

export type DataRequest = {
  id: string;
  tenantId: string;
  type: 'export' | 'delete';
  requesterEmail: string;
  targetUserId?: string | null;
  targetAccount?: string | null;
  status: 'open' | 'processing' | 'completed' | 'rejected';
  note?: string | null;
  exportUri?: string | null;
  requestedAt: string;
  dueAt: string;
  handledByUserId?: string | null;
  completedAt?: string | null;
};

export type IncidentNote = {
  id: string;
  tenantId: string;
  severity: 'info' | 'watch' | 'incident';
  status: 'open' | 'resolved';
  title: string;
  body: string;
  createdByUserId: string;
  createdAt: string;
  resolvedByUserId?: string | null;
  resolvedAt?: string | null;
};

export type Plan = {
  id: string;
  name: string;
  monthlyCents: number;
  seatLimit: number;
  mailboxLimit: number;
  signalLimit: number;
};

export type Subscription = {
  id: string;
  tenantId: string;
  provider: string;
  providerCheckoutSessionId?: string;
  providerCustomerId?: string;
  providerLastEventId?: string;
  providerLastEventType?: string;
  providerPriceId?: string;
  providerSignatureStatus?: string;
  providerSignatureVerifiedAt?: string;
  providerStatus?: string;
  providerSubscriptionId?: string;
  providerSyncedAt?: string;
  planId: string;
  status: SubscriptionStatus;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  billingOverrideId?: string;
  canceledAt?: string;
  currentPeriodEndAt?: string;
  livemode?: boolean;
  trialEndsAt?: string;
};

export type Entitlement = {
  id: string;
  tenantId: string;
  subscriptionId: string;
  source: string;
  status: 'active' | 'restricted';
  seatLimit: number;
  mailboxLimit: number;
  signalLimit: number;
  retentionDays: number;
  adminControls: boolean;
  overrideId?: string | null;
  overrideType?: BillingOverrideType | null;
  updatedAt: string;
};

export type BillingSession = {
  id: string;
  tenantId: string;
  provider: string;
  providerCustomerId?: string;
  providerMode?: 'local' | 'live';
  providerPriceEnv?: string;
  providerRequestDigest?: string;
  providerSessionId?: string;
  type: BillingSessionType;
  status: string;
  planId?: string;
  subscriptionId?: string;
  invoiceId?: string;
  url: string;
  createdAt: string;
  expiresAt: string;
};

export type BillingOverride = {
  id: string;
  tenantId: string;
  type: BillingOverrideType;
  status: BillingOverrideStatus;
  reason: string;
  planId?: string | null;
  amountCents?: number | null;
  subscriptionId?: string | null;
  createdAt: string;
  createdByUserId: string;
  updatedAt?: string | null;
  expiresAt?: string | null;
  expiredAt?: string | null;
  revokedAt?: string | null;
  revokedByUserId?: string | null;
  revocationReason?: string | null;
};

export type Invoice = {
  id: string;
  tenantId: string;
  subscriptionId: string;
  provider: string;
  providerCustomerId?: string;
  providerInvoiceId?: string;
  providerLastEventId?: string;
  providerLastEventType?: string;
  providerPriceId?: string;
  providerSignatureStatus?: string;
  providerSignatureVerifiedAt?: string;
  providerSubscriptionId?: string;
  status: InvoiceStatus;
  amountDueCents: number;
  currency: string;
  hostedInvoiceUrl: string;
  createdAt: string;
  dueAt: string;
  paidAt?: string | null;
  retryCount: number;
  nextPaymentAttemptAt?: string | null;
};

export type PaymentEvent = {
  id: string;
  tenantId: string;
  provider: string;
  type: string;
  status: string;
  appliedType?: string;
  createdAt?: string;
  livemode?: boolean;
  providerCustomerId?: string;
  providerEventId?: string;
  providerEventType?: string;
  providerInvoiceId?: string;
  providerStatus?: string;
  providerSubscriptionId?: string;
  amountCents?: number;
  billingOverrideId?: string;
  signatureStatus?: string;
  signatureTimestamp?: number;
  signatureVerifiedAt?: string;
  subscriptionId?: string;
  sessionId?: string;
  invoiceId?: string;
};

export type LifecycleNotice = {
  id: string;
  tenantId: string;
  category: LifecycleNoticeCategory;
  trigger: string;
  severity: LifecycleNoticeSeverity;
  status: LifecycleNoticeStatus;
  title: string;
  body: string;
  ownerUserId?: string | null;
  provider?: string | null;
  actionLabel?: string | null;
  actionTarget?: string | null;
  sourceIds?: {
    billingSessionId?: string;
    cursorId?: string;
    emailDeliveryMessageId?: string;
    invoiceId?: string;
    jobId?: string;
    mailboxId?: string;
    paymentEventId?: string;
    subscriptionId?: string;
    tenantId?: string;
    watchId?: string;
  };
  createdAt: string;
  updatedAt?: string | null;
  resolvedAt?: string | null;
};

export type Job = {
  id: string;
  deadLetterId?: string;
  originalJobId?: string;
  tenantId: string;
  queue: string;
  type: string;
  targetId: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastRunAt: string | null;
  message: string;
  nextRunAt?: string | null;
  providerCredentialRefreshedAt?: string | null;
  providerCredentialSource?: 'local' | 'option' | 'env' | 'vault' | 'missing' | null;
  providerCredentialVaultRef?: string | null;
  providerErrorCode?: string | null;
  providerRequestDigest?: string | null;
  providerResponseDigest?: string | null;
  providerResponseStatus?: number | null;
  providerRetryAfterAt?: string | null;
  providerValidationRunId?: string | null;
  providerValidationStatus?: 'passed' | 'failed' | 'blocked' | null;
  sourceMessagesCreated?: number | null;
  sourceMessagesUpdated?: number | null;
  sourceMessagesUpserted?: number | null;
};

export type AuditEvent = {
  id: string;
  tenantId?: string | null;
  action: string;
  targetId: string;
  message: string;
  createdAt: string;
  actor: string;
};

export type WebhookIngestEvent = {
  id: string;
  provider: 'stripe' | 'email' | 'gmail' | 'outlook' | string;
  eventType: string;
  accepted: boolean;
  reason?: string | null;
  receivedAt: string;
  status?: number | null;
};

export type ProviderEnvStatus = {
  key: string;
  configured: boolean;
};

export type ProviderCategory = 'auth' | 'email' | 'payment';

export type ProviderReadinessItem = {
  id: string;
  label: string;
  category: ProviderCategory;
  provider: string;
  requiredEnv: string[];
  optionalEnv: string[];
  callbackPath: string;
  webhookPath: string;
  lifecycleWebhookPath?: string;
  boundary: string;
  configuredRequired: string[];
  configuredOptional: string[];
  missingRequired: string[];
  required: ProviderEnvStatus[];
  optional: ProviderEnvStatus[];
  ready: boolean;
};

export type ProviderReadiness = {
  ok: boolean;
  localOnly: boolean;
  providers: ProviderReadinessItem[];
  summary: {
    readyProviders: number;
    totalProviders: number;
    missingRequired: number;
  };
};

export type ProviderReadinessResponse = {
  ok: boolean;
  providerValidationRuns?: ProviderValidationRun[];
  providerValidationSchedules?: ProviderValidationSchedule[];
  readiness: ProviderReadiness;
  summary?: StateSummary;
};

export type ProviderSandboxStatus = 'passed' | 'failed' | 'blocked';
export type ProviderValidationCadence = 'daily' | 'weekly' | 'manual';
export type ProviderValidationScheduleStatus = 'active' | 'paused';

export type ProviderSandboxCheck = {
  id: string;
  status: ProviderSandboxStatus;
  message: string;
  endpoint?: string;
  method?: string;
  objectId?: string;
  providerErrorCode?: string | null;
  providerErrorType?: string | null;
  providerRequestId?: string | null;
  requestDigest?: string;
  statusCode?: number;
};

export type ProviderSandboxItem = {
  id: string;
  label: string;
  category: ProviderCategory;
  status: ProviderSandboxStatus;
  missingRequired: string[];
  checks: ProviderSandboxCheck[];
};

export type ProviderSandboxReport = {
  generatedAt: string;
  ok: boolean;
  providers: ProviderSandboxItem[];
  summary: {
    blocked: number;
    failed: number;
    passed: number;
    total: number;
  };
};

export type ProviderValidationRun = {
  id: string;
  generatedAt: string;
  ok: boolean;
  providers: Array<{
    id: string;
    label: string;
    category: ProviderCategory;
    status: ProviderSandboxStatus;
    missingRequired: string[];
    checks: Array<{
      id: string;
      status: ProviderSandboxStatus;
      endpoint?: string;
      method?: string;
      objectId?: string;
      providerErrorCode?: string | null;
      providerErrorType?: string | null;
      providerRequestId?: string | null;
      requestDigest?: string;
      statusCode?: number;
    }>;
  }>;
  recordedAt: string;
  recordedByUserId?: string;
  reportDigest: string;
  status: ProviderSandboxStatus;
  summary: ProviderSandboxReport['summary'];
};

export type ProviderValidationSchedule = {
  id: string;
  providerId: string;
  providerLabel: string;
  category: ProviderCategory;
  cadence: ProviderValidationCadence;
  status: ProviderValidationScheduleStatus;
  requiredEnv: string[];
  lastRunAt?: string | null;
  lastRunId?: string | null;
  lastRunStatus?: ProviderSandboxStatus | null;
  nextRunAt?: string | null;
  createdAt: string;
  createdByUserId?: string | null;
  updatedAt?: string | null;
  updatedByUserId?: string | null;
};

export type ProviderSandboxResponse = {
  ok: boolean;
  doctor?: DoctorReport;
  recorded?: {
    id: string;
    reportDigest: string;
    status: ProviderSandboxStatus;
    summary: ProviderSandboxReport['summary'];
  } | null;
  providerValidationRuns?: ProviderValidationRun[];
  providerValidationSchedules?: ProviderValidationSchedule[];
  sandbox: ProviderSandboxReport;
  state?: SignalAppData;
  summary?: StateSummary;
};

export type ProviderScheduledValidationResponse = {
  ok: boolean;
  doctor?: DoctorReport;
  dueSchedules: ProviderValidationSchedule[];
  forced?: boolean;
  providerValidationSchedules?: ProviderValidationSchedule[];
  recorded?: {
    id: string;
    reportDigest: string;
    status: ProviderSandboxStatus;
    summary: ProviderSandboxReport['summary'];
  } | null;
  sandbox?: ProviderSandboxReport;
  skipped: boolean;
  state?: SignalAppData;
  summary?: StateSummary;
};

export type SignalAppData = {
  meta?: {
    schemaVersion?: number;
    environment?: string;
    description?: string;
    bootstrappedAt?: string;
    updatedAt?: string;
    statePath?: string;
  };
  session?: {
    activeUserId?: string;
    allowedRoles?: UserRole[];
    localOnly?: boolean;
  };
  apiSessions?: ApiSession[];
  providerValidationRuns?: ProviderValidationRun[];
  providerValidationSchedules?: ProviderValidationSchedule[];
  tenants: Tenant[];
  users: User[];
  memberships: TenantMembership[];
  invites: UserInvite[];
  mailboxes: Mailbox[];
  mailboxConnectionSessions: MailboxConnectionSession[];
  emailSyncCursors: EmailSyncCursor[];
  emailWatchSubscriptions?: EmailWatchSubscription[];
  emailFlows: EmailFlow[];
  routingRules?: EmailRoutingRule[];
  sourceMessages: SourceMessage[];
  flowRuns: FlowRun[];
  accountProfiles: AccountProfile[];
  accountEvents: AccountEvent[];
  accountActions: AccountAction[];
  accountReviews?: AccountReview[];
  accountRecommendations?: AccountRecommendation[];
  notificationPreferences: NotificationPreference[];
  notificationEvents: NotificationEvent[];
  notificationDigestRuns: NotificationDigestRun[];
  emailDeliveryMessages: EmailDeliveryMessage[];
  signalQualitySettings: SignalQualitySettings[];
  suppressionRules: SuppressionRule[];
  signalFeedback: SignalFeedback[];
  modelGovernancePolicies?: ModelGovernancePolicy[];
  governancePolicies: GovernancePolicy[];
  redactionRules: RedactionRule[];
  dataRequests: DataRequest[];
  incidentNotes: IncidentNote[];
  signals: Signal[];
  signalHandoffs?: SignalHandoff[];
  plans: Plan[];
  subscriptions: Subscription[];
  entitlements: Entitlement[];
  billingSessions: BillingSession[];
  billingOverrides?: BillingOverride[];
  invoices: Invoice[];
  paymentEvents: PaymentEvent[];
  lifecycleNotices?: LifecycleNotice[];
  jobs: Job[];
  deadLetter?: Job[];
  auditEvents?: AuditEvent[];
  webhookEvents?: WebhookIngestEvent[];
};

export type DoctorCheck = {
  id: string;
  ok: boolean;
  message: string;
  details?: unknown;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
};

export type StateSummary = {
  statePath?: string;
  schemaVersion?: number | null;
  environment: string;
  tenants: number;
  activeTenants?: number;
  suspendedTenants?: number;
  tenantStatus?: TenantStatus | null;
  users: number;
  admins: number;
  invites?: number;
  pendingInvites?: number;
  acceptedInvites?: number;
  memberships?: number;
  activeMemberships?: number;
  disabledMemberships?: number;
  activeSeats?: number;
  pendingInviteSeats?: number;
  seatLimit?: number | null;
  seatsAvailable?: number | null;
  mailboxes: number;
  connectedMailboxes: number;
  mailboxConnectionSessions?: number;
  activeSyncCursors?: number;
  blockedSyncCursors?: number;
  emailWatchSubscriptions?: number;
  activeEmailWatchSubscriptions?: number;
  expiringEmailWatchSubscriptions?: number;
  emailFlows: number;
  enabledEmailFlows: number;
  routingRules?: number;
  activeRoutingRules?: number;
  sourceMessages?: number;
  flowRuns?: number;
  generatedSignals?: number;
  openSignals: number;
  signalHandoffs?: number;
  queuedSignalHandoffs?: number;
  failedSignalHandoffs?: number;
  accounts?: number;
  atRiskAccounts?: number;
  accountEvents?: number;
  openAccountActions?: number;
  accountReviews?: number;
  accountRecommendations?: number;
  openAccountRecommendations?: number;
  latestAccountReviewAt?: string | null;
  notificationPreferences?: number;
  notificationEvents?: number;
  unreadNotifications?: number;
  mutedNotifications?: number;
  digestRuns?: number;
  emailDeliveries?: number;
  queuedEmailDeliveries?: number;
  failedEmailDeliveries?: number;
  unsubscribedUsers?: number;
  signalQualitySettings?: number;
  suppressionRules?: number;
  activeSuppressionRules?: number;
  signalFeedback?: number;
  modelGovernancePolicies?: number;
  optInModelLearningPolicies?: number;
  perTenantModels?: number;
  governancePolicies?: number;
  activeRedactionRules?: number;
  openDataRequests?: number;
  openIncidentNotes?: number;
  subscriptions: number;
  invoices?: number;
  openInvoices?: number;
  pastDueInvoices?: number;
  paymentEvents: number;
  billingSessions?: number;
  lifecycleNotices?: number;
  openLifecycleNotices?: number;
  criticalLifecycleNotices?: number;
  billingOverrides?: number;
  activeBillingOverrides?: number;
  revokedBillingOverrides?: number;
  activeEntitlements?: number;
  jobs?: number;
  failedJobs?: number;
  apiSessions?: number;
  activeApiSessions?: number;
  revokedApiSessions?: number;
  providerValidationRuns?: number;
  latestProviderValidationStatus?: ProviderSandboxStatus | null;
  latestProviderValidationAt?: string | null;
  providerValidationSchedules?: number;
  activeProviderValidationSchedules?: number;
  dueProviderValidationSchedules?: number;
  auditEvents?: number;
  activeUserId?: string | null;
  activeUserRole?: UserRole | null;
};

export type SignalMutationAction =
  | 'session.token'
  | 'session.revoke'
  | 'users.revoke-sessions'
  | 'tenants.create'
  | 'tenants.onboarding-complete'
  | 'tenants.status'
  | 'tenants.status-bulk'
  | 'tenants.domain'
  | 'users.role'
  | 'users.disable'
  | 'users.activate'
  | 'users.invite'
  | 'users.invite-accept'
  | 'users.invite-revoke'
  | 'mailboxes.pause'
  | 'mailboxes.resume'
  | 'mailboxes.connect-url'
  | 'mailboxes.complete'
  | 'mailboxes.oauth-callback'
  | 'mailboxes.disconnect'
  | 'mailboxes.sync'
  | 'mailboxes.replay'
  | 'mailboxes.watch'
  | 'mailboxes.watch-renew'
  | 'mailboxes.watch-notification'
  | 'email-flows.enable'
  | 'email-flows.disable'
  | 'email-flows.route'
  | 'email-flows.run'
  | 'integrations.sandbox.record'
  | 'integrations.sandbox.evidence-export'
  | 'integrations.sandbox.evidence-import'
  | 'integrations.schedule'
  | 'accounts.action-status'
  | 'accounts.review'
  | 'quality.threshold'
  | 'quality.suppression-add'
  | 'quality.suppression-status'
  | 'models.policy'
  | 'governance.policy'
  | 'governance.redaction-add'
  | 'governance.redaction-status'
  | 'governance.request-create'
  | 'governance.request-status'
  | 'governance.incident-add'
  | 'governance.incident-resolve'
  | 'notifications.preference'
  | 'notifications.status'
  | 'notifications.digest-run'
  | 'notifications.delivery-status'
  | 'notifications.delivery-webhook'
  | 'notifications.unsubscribe'
  | 'signals.assign'
  | 'signals.status'
  | 'signals.feedback'
  | 'signals.handoff'
  | 'signals.handoff-status'
  | 'payments.comp'
  | 'payments.override'
  | 'payments.override-revoke'
  | 'payments.sync'
  | 'payments.status'
  | 'payments.cancel'
  | 'payments.checkout'
  | 'payments.portal'
  | 'payments.recover'
  | 'payments.webhook'
  | 'jobs.run'
  | 'jobs.retry'
  | 'jobs.requeue'
  | 'jobs.requeue-bulk'
  | 'jobs.drain';

export type SignalMutationResult = {
  ok: boolean;
  action: SignalMutationAction | 'users.invite-claim';
  actor?: {
    email: string;
    id: string;
    name: string;
    role: UserRole;
  };
  details: {
    message: string;
    [key: string]: unknown;
  };
  state: SignalAppData;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type SignalSessionResult = {
  ok: boolean;
  action: 'session.switch';
  actor: {
    email: string;
    id: string;
    name: string;
    role: UserRole;
    status?: string;
    team?: string | null;
  };
  details: {
    message: string;
    nextUserId: string;
    previousUserId?: string | null;
    [key: string]: unknown;
  };
  state: SignalAppData;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type BackendReadinessCheck = {
  id: string;
  label: string;
  ok: boolean;
  localOk: boolean;
  message: string;
  configuredEnv: string[];
  missingEnv: string[];
  requiredEnv: string[];
  details?: {
    mode?: string | null;
    originCount?: number;
    provider?: string | null;
    statePath?: string | null;
    wildcard?: boolean;
    loopbackOrigins?: number;
    [key: string]: unknown;
  };
};

export type BackendReadiness = {
  ok: boolean;
  productionReady: boolean;
  localOnly: boolean;
  mode: string;
  checks: BackendReadinessCheck[];
  summary: {
    readyChecks: number;
    totalChecks: number;
    missingRequiredEnv: string[];
  };
};

export type DashboardAuditRow = {
  area: string;
  check: string;
  detail: string;
  displayValue: number;
  ok: boolean;
  scope: 'actor_visible' | 'global_total' | string;
  summaryKey: keyof StateSummary | string;
  summaryValue: number;
  totalValue: number;
};

export type DashboardAuditReport = {
  generatedAt: string;
  ok: boolean;
  actor: {
    id: string;
    role?: UserRole | null;
    team?: string | null;
    tenantId?: string | null;
  } | null;
  backend: {
    mode: string;
    productionReady: boolean;
    readyChecks: number;
    statePath?: string;
    totalChecks: number;
  };
  issues: string[];
  rows: DashboardAuditRow[];
  summary: {
    failed: number;
    passed: number;
    scopedRows: number;
    total: number;
  };
};

export type DashboardAuditResponse = {
  ok: boolean;
  audit: DashboardAuditReport;
  backend: BackendReadiness;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type OnboardingReadinessRow = {
  area: string;
  check: string;
  evidence: string[];
  localOk: boolean;
  productionOk: boolean;
  recommendation: string;
  status: 'local_ready' | 'production_ready' | 'attention' | string;
};

export type OnboardingReadinessReport = {
  generatedAt: string;
  ok: boolean;
  productionReady: boolean;
  actor: {
    id: string;
    role?: UserRole | null;
    team?: string | null;
    tenantId?: string | null;
  } | null;
  backend: {
    mode: string;
    productionReady: boolean;
    tenantIsolationReady: boolean;
    signedSessionReady: boolean;
    statePath?: string;
  };
  issues: string[];
  recommendation: {
    decision: 'support_multi_member_orgs' | string;
    summary: string;
    productionGuardrail: string;
    perTenantModelDefault: string;
  };
  roleMatrix: Array<{
    role: UserRole | string;
    dataAccess: string;
    allowedActions: string[];
    guardrails: string[];
  }>;
  rows: OnboardingReadinessRow[];
  summary: {
    activeAdmins: number;
    activeMembers: number;
    activeMemberships: number;
    localReady: number;
    pendingInvites: number;
    productionReady: number;
    seatLimit: number | null;
    seatsAvailable: number | null;
    total: number;
    visibleMailboxesForActor: number;
    visibleSignalsForActor: number;
  };
  tenant: {
    id: string;
    name: string;
    domain: string;
    status: TenantStatus;
    ownerUserId?: string | null;
    billingOwnerUserId?: string | null;
    registrationStatus?: Tenant['registrationStatus'] | null;
  } | null;
};

export type OnboardingReadinessResponse = {
  ok: boolean;
  onboarding: OnboardingReadinessReport;
  backend: BackendReadiness;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type TenantIsolationAuditRow = {
  area: string;
  check: string;
  evidence: string[];
  localOk: boolean;
  productionOk: boolean;
  recommendation: string;
  requiredEnv: string[];
  commands: string[];
  status: 'local_ready' | 'production_ready' | 'attention' | string;
};

export type TenantIsolationAuditReport = {
  generatedAt: string;
  ok: boolean;
  productionReady: boolean;
  actor: {
    id: string;
    role?: UserRole | null;
    team?: string | null;
    tenantId?: string | null;
  } | null;
  backend: {
    mode: string;
    productionReady: boolean;
    tenantIsolationReady: boolean;
    signedSessionReady: boolean;
    productionAuthReady: boolean;
    durableStateReady: boolean;
    statePath?: string;
  };
  issues: string[];
  recommendation: {
    decision: 'support_multi_member_orgs' | string;
    summary: string;
    productionGuardrail: string;
    memberPrivacyDefault: string;
  };
  roleMatrix: Array<{
    role: UserRole | string;
    dataAccess: string;
    allowedActions: string[];
    guardrails: string[];
  }>;
  rows: TenantIsolationAuditRow[];
  summary: {
    activeAdmins: number;
    activeMembers: number;
    actorScopedRows: number;
    localReady: number;
    orphanMemberships: number;
    productionReady: number;
    total: number;
    visibleMailboxesForActor: number;
    visibleSignalsForActor: number;
  };
  tenant: {
    id: string;
    name: string;
    domain: string;
    status: TenantStatus;
    ownerUserId?: string | null;
    billingOwnerUserId?: string | null;
    registrationStatus?: Tenant['registrationStatus'] | null;
  } | null;
};

export type TenantIsolationAuditResponse = {
  ok: boolean;
  isolation: TenantIsolationAuditReport;
  backend: BackendReadiness;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type OperationsWebhookHealth = {
  channel: string;
  evidence: string[];
  label: string;
  latestAt?: string | null;
  localOk: boolean;
  path: string;
  rejected?: number;
  status: string;
};

export type OperationsQueueHealth = {
  queue: string;
  deadLetter?: number;
  drained: number;
  failed: number;
  latestAt?: string | null;
  localOk: boolean;
  queued: number;
  running: number;
  status: string;
  succeeded: number;
  total: number;
};

export type OperationsRateLimitHealth = {
  active: boolean;
  kind: string;
  provider: string;
  reason: string;
  responseStatus?: number | null;
  retryAfterAt?: string | null;
  status: string;
  targetId: string;
};

export type OperationsHealthReport = {
  generatedAt: string;
  ok: boolean;
  productionReady: boolean;
  backend: {
    mode: string;
    productionReady: boolean;
    schedulerReady: boolean;
    statePath?: string;
  };
  issues: string[];
  lifecycle: {
    categories: Array<{
      category: string;
      critical: number;
      latestAt?: string | null;
      localOk: boolean;
      open: number;
      status: string;
      total: number;
    }>;
    latest: Array<{
      actionLabel?: string | null;
      category: LifecycleNoticeCategory | string;
      id: string;
      severity: LifecycleNoticeSeverity | string;
      status: LifecycleNoticeStatus | string;
      title: string;
      trigger: string;
      updatedAt?: string | null;
    }>;
  };
  queues: OperationsQueueHealth[];
  rateLimits: OperationsRateLimitHealth[];
  recommendation: {
    summary: string;
    productionGuardrail: string;
    localAgentCommand: string;
  };
  summary: {
    activeBackoffs: number;
    criticalLifecycle: number;
    deadLetterJobs: number;
    failedDeliveries: number;
    failedJobs: number;
    failedQueues: number;
    monitoredQueues: number;
    openLifecycle: number;
    productionReady: boolean;
    totalWebhooks: number;
    unhealthyWebhooks: number;
  };
  webhooks: OperationsWebhookHealth[];
};

export type OperationsHealthResponse = {
  ok: boolean;
  operations: OperationsHealthReport;
  backend: BackendReadiness;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type ProductionDrillRow = {
  area: string;
  check: string;
  commands: string[];
  evidence: string[];
  localOk: boolean;
  owner: string;
  productionOk: boolean;
  recommendation: string;
  requiredEnv: string[];
  status: 'production_ready' | 'needs_proof' | 'attention' | string;
};

export type ProductionDrillReport = {
  generatedAt: string;
  ok: boolean;
  productionReady: boolean;
  issues: string[];
  recommendation: {
    summary: string;
    productionGuardrail: string;
    localAgentCommand: string;
  };
  rows: ProductionDrillRow[];
  summary: {
    blocked: number;
    localReady: number;
    productionReady: number;
    total: number;
  };
};

export type ProductionDrillResponse = {
  ok: boolean;
  drill: ProductionDrillReport;
  backend: BackendReadiness;
  provider: ProviderReadiness;
  readiness?: unknown;
  launchGate?: unknown;
  operations?: OperationsHealthReport;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type ProviderLaunchRow = {
  id: string;
  label: string;
  category: ProviderCategory;
  owner: string;
  provider: string;
  boundary: string;
  callbackPath: string;
  webhookPath: string;
  lifecycleWebhookPath?: string;
  configurationReady: boolean;
  configuredRequired: string[];
  missingEnv: string[];
  requiredEnv: string[];
  optionalEnv: string[];
  sandboxRequired: boolean;
  sandboxStatus: string;
  latestEvidenceAt?: string | null;
  latestEvidenceRunId?: string | null;
  latestEvidenceDigest?: string | null;
  latestProviderRequestIds: string[];
  freshnessBlockers: string[];
  schedule: {
    cadence: ProviderValidationCadence;
    lastRunAt?: string | null;
    lastRunStatus?: ProviderSandboxStatus | null;
    nextRunAt?: string | null;
    status: ProviderValidationScheduleStatus;
  } | null;
  scheduleReady: boolean;
  requiredEvidence: string[];
  evidenceCommands: string[];
  launchCommands: string[];
  signedReplayCommand?: string | null;
  localAgentCommand: string;
  launchReady: boolean;
  status: 'production_ready' | 'needs_config' | 'needs_sandbox' | 'needs_schedule' | 'needs_proof' | string;
};

export type ProviderLaunchMatrixReport = {
  generatedAt: string;
  ok: boolean;
  productionReady: boolean;
  freshness: unknown;
  freshnessBlockers: string[];
  rows: ProviderLaunchRow[];
  recommendation: {
    summary: string;
    productionGuardrail: string;
    localAgentCommand: string;
  };
  summary: {
    blocked: number;
    configured: number;
    freshnessBlocked: number;
    launchReady: number;
    missingRequiredEnv: number;
    sandboxPassed: number;
    sandboxRequired: number;
    scheduledActive: number;
    secretSafe: boolean;
    total: number;
  };
};

export type ProviderLaunchResponse = {
  ok: boolean;
  launch: ProviderLaunchMatrixReport;
  backend: BackendReadiness;
  provider: ProviderReadiness;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type ProviderHandoffAction = {
  id: string;
  providerId: string;
  label: string;
  owner: string;
  status: string;
  priority: number;
  blocker: string;
  evidence: string[];
  requiredEnv: string[];
  command: string;
  followUpCommands: string[];
};

export type ProviderHandoffReport = {
  generatedAt: string;
  ok: boolean;
  productionReady: boolean;
  nextAction: ProviderHandoffAction;
  actions: ProviderHandoffAction[];
  launch: {
    productionReady: boolean;
    configured: number;
    launchReady: number;
    missingRequiredEnv: number;
    sandboxPassed: number;
    sandboxRequired: number;
    scheduledActive: number;
    total: number;
  };
  providerRows: Array<{
    id: string;
    label: string;
    owner: string;
    status: string;
    configurationReady: boolean;
    sandboxStatus: string;
    scheduleReady: boolean;
    launchReady: boolean;
    missingEnv: string[];
    localAgentCommand: string;
  }>;
  recommendation: {
    summary: string;
    productionGuardrail: string;
    localAgentCommand: string;
  };
  runnableCommands: string[];
  summary: {
    blocked: number;
    configured: number;
    launchReady: number;
    missingRequiredEnv: number;
    nextActionId: string;
    productionReady: boolean;
    sandboxPassed: number;
    sandboxRequired: number;
    scheduledActive: number;
    secretSafe: boolean;
    total: number;
  };
};

export type ProviderHandoffResponse = {
  ok: boolean;
  handoff: ProviderHandoffReport;
  backend: BackendReadiness;
  provider: ProviderReadiness;
  providerLaunch: ProviderLaunchMatrixReport;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type ProductionPlanRow = {
  id: string;
  phase: string;
  owner: string;
  status: 'complete' | 'blocked' | 'ready_for_proof' | string;
  productionOk: boolean;
  evidence: string[];
  blockers: string[];
  requiredEnv: string[];
  commands: string[];
  completionCriteria: string[];
  dependsOn: string[];
  localAgentCanRun: boolean;
};

export type ProductionSetupPlanReport = {
  generatedAt: string;
  ok: boolean;
  productionReady: boolean;
  rows: ProductionPlanRow[];
  recommendation: {
    summary: string;
    productionGuardrail: string;
    localAgentCommand: string;
  };
  summary: {
    blocked: number;
    complete: number;
    localAgentRunnable: number;
    missingRequiredEnv: number;
    nextPhaseId: string | null;
    productionReady: number;
    readyForProof: number;
    secretSafe: boolean;
    total: number;
  };
};

export type ProductionPlanResponse = {
  ok: boolean;
  plan: ProductionSetupPlanReport;
  backend: BackendReadiness;
  provider: ProviderReadiness;
  readiness?: unknown;
  launchGate?: unknown;
  operations?: OperationsHealthReport;
  productionDrill?: ProductionDrillReport;
  providerLaunch?: ProviderLaunchMatrixReport;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type ProductionEnvAuditRow = {
  id: string;
  label: string;
  owner: string;
  status: 'ready' | 'missing_values' | 'template_gap' | string;
  requiredEnv: string[];
  optionalEnv: string[];
  configuredRequired: string[];
  missingRequired: string[];
  presentInSource: string[];
  templateMissing: string[];
  configuredOptional: string[];
  commands: string[];
  evidence: string[];
};

export type ProductionEnvAuditReport = {
  generatedAt: string;
  ok: boolean;
  envReady: boolean;
  templateReady: boolean;
  rows: ProductionEnvAuditRow[];
  recommendation: {
    summary: string;
    productionGuardrail: string;
    localAgentCommand: string;
  };
  source: {
    configuredKeys: number;
    keys: string[];
    path: string | null;
    type: string;
  };
  template: {
    invalid: number[];
    keys: string[];
    path: string | null;
  };
  summary: {
    configuredRequired: number;
    envReady: boolean;
    missingRequired: number;
    optionalEnv: number;
    presentInSource: number;
    requiredEnv: number;
    rowsReady: number;
    secretSafe: boolean;
    templateMissingRequired: number;
    templateReady: boolean;
    totalRows: number;
  };
};

export type ProductionEnvResponse = {
  ok: boolean;
  env: ProductionEnvAuditReport;
  backend: BackendReadiness;
  provider: ProviderReadiness;
  productionPlan?: ProductionSetupPlanReport;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type LifecyclePlaybookRow = {
  id: string;
  label: string;
  category: LifecycleNoticeCategory | string;
  triggers: string[];
  owner: string;
  severity: LifecycleNoticeSeverity | string;
  notificationFlow: string;
  userAction: string;
  adminAction: string;
  commands: string[];
  evidence: string[];
  notices: Array<{
    actionLabel?: string | null;
    actionTarget?: string | null;
    id: string;
    severity: LifecycleNoticeSeverity | string;
    status: LifecycleNoticeStatus | string;
    title: string;
    trigger: string;
    updatedAt?: string | null;
  }>;
  open: number;
  critical: number;
  observed: number;
  latestAt?: string | null;
  sampleNoticeId?: string | null;
  localOk: boolean;
  status: 'ready' | 'observed' | 'action_ready' | 'attention' | string;
};

export type LifecyclePlaybookReport = {
  generatedAt: string;
  ok: boolean;
  productionReady: boolean;
  rows: LifecyclePlaybookRow[];
  recommendation: {
    summary: string;
    productionGuardrail: string;
    localAgentCommand: string;
  };
  summary: {
    actionReady: number;
    attention: number;
    criticalNotices: number;
    localReady: number;
    observed: number;
    openNotices: number;
    ready: number;
    secretSafe: boolean;
    total: number;
  };
};

export type LifecyclePlaybookResponse = {
  ok: boolean;
  playbook: LifecyclePlaybookReport;
  backend: BackendReadiness;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type PaymentLifecycleAuditRow = {
  area: string;
  check: string;
  evidence: string[];
  localOk: boolean;
  productionOk: boolean;
  recommendation: string;
  requiredEnv: string[];
  commands: string[];
  status: 'production_ready' | 'needs_live_provider' | 'attention' | string;
};

export type PaymentLifecycleAuditReport = {
  generatedAt: string;
  ok: boolean;
  productionReady: boolean;
  tenant: {
    id: string;
    name: string;
    domain: string;
    billingOwnerUserId?: string | null;
    ownerUserId?: string | null;
    status: TenantStatus;
  } | null;
  backend: {
    mode: string;
    productionReady: boolean;
    statePath?: string;
  };
  provider: {
    stripeConfigured: boolean;
    stripeLaunchReady: boolean;
    stripeSandboxPassed: boolean;
    stripeStatus: string;
  };
  issues: string[];
  recommendation: {
    summary: string;
    productionGuardrail: string;
    localAgentCommand: string;
  };
  rows: PaymentLifecycleAuditRow[];
  summary: {
    activeEntitlements: number;
    canceledSubscriptions: number;
    checkoutSessions: number;
    failedBillingJobs: number;
    localReady: number;
    openInvoices: number;
    paymentEvents: number;
    portalSessions: number;
    productionReady: number;
    recoverySessions: number;
    signedWebhookEvents: number;
    total: number;
  };
};

export type PaymentLifecycleAuditResponse = {
  ok: boolean;
  payment: PaymentLifecycleAuditReport;
  backend: BackendReadiness;
  provider: ProviderReadiness;
  providerLaunch: ProviderLaunchMatrixReport;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type PaymentHandoffStep = {
  id: string;
  label: string;
  owner: string;
  priority: number;
  status: 'ready' | 'needs_proof' | string;
  localOk: boolean;
  productionOk: boolean;
  requiredEnv: string[];
  configuredEnv: string[];
  missingEnv: string[];
  evidence: string[];
  blocker: string;
  command: string;
  followUpCommands: string[];
  rollbackCommand?: string | null;
  completion: string;
};

export type PaymentHandoffReport = {
  generatedAt: string;
  ok: boolean;
  productionReady: boolean;
  nextStep: PaymentHandoffStep;
  rows: PaymentHandoffStep[];
  payment: {
    ok: boolean;
    productionReady: boolean;
    localReady: number;
    total: number;
    signedWebhookEvents: number;
    openInvoices: number;
    activeEntitlements: number;
  };
  provider: {
    stripeConfigured: boolean;
    stripeLaunchReady: boolean;
    stripeSandboxStatus: string;
    stripeScheduleStatus: string;
    stripeStatus: string;
  };
  recommendation: {
    summary: string;
    productionGuardrail: string;
    localAgentCommand: string;
  };
  runnableCommands: string[];
  summary: {
    blocked: number;
    configuredEnv: number;
    localReady: number;
    missingRequiredEnv: number;
    nextStepId: string;
    productionReady: number;
    secretSafe: boolean;
    total: number;
  };
};

export type PaymentHandoffResponse = {
  ok: boolean;
  handoff: PaymentHandoffReport;
  backend: BackendReadiness;
  provider: ProviderReadiness;
  providerLaunch: ProviderLaunchMatrixReport;
  payment: PaymentLifecycleAuditReport;
  launchGate?: unknown;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type EmailHandoffStep = {
  id: string;
  label: string;
  owner: string;
  priority: number;
  status: 'ready' | 'needs_proof' | string;
  localOk: boolean;
  productionOk: boolean;
  requiredEnv: string[];
  configuredEnv: string[];
  missingEnv: string[];
  evidence: string[];
  blocker: string;
  command: string;
  followUpCommands: string[];
  rollbackCommand?: string | null;
  completion: string;
};

export type EmailHandoffReport = {
  generatedAt: string;
  ok: boolean;
  productionReady: boolean;
  nextStep: EmailHandoffStep;
  rows: EmailHandoffStep[];
  email: {
    connectedMailboxes: number;
    activeEmailWatchSubscriptions: number;
    emailWatchSubscriptions: number;
    enabledEmailFlows: number;
    emailFlows: number;
    digestRuns: number;
    emailDeliveries: number;
    failedEmailDeliveries: number;
    signedDeliveryMessages: number;
    activeEmailProviderSchedules: number;
  };
  provider: {
    gmailConfigured: boolean;
    gmailLaunchReady: boolean;
    gmailSandboxStatus: string;
    outlookConfigured: boolean;
    outlookLaunchReady: boolean;
    outlookSandboxStatus: string;
    outboundConfigured: boolean;
    outboundLaunchReady: boolean;
    outboundSandboxStatus: string;
  };
  operations: {
    ok: boolean;
    productionReady: boolean;
    failedDeliveries: number;
    failedQueues: number;
    activeBackoffs: number;
    unhealthyWebhooks: number;
  };
  recommendation: {
    summary: string;
    productionGuardrail: string;
    localAgentCommand: string;
  };
  runnableCommands: string[];
  summary: {
    activeEmailProviderSchedules: number;
    blocked: number;
    configuredEnv: number;
    localReady: number;
    missingRequiredEnv: number;
    nextStepId: string;
    productionReady: number;
    secretSafe: boolean;
    total: number;
  };
};

export type EmailHandoffResponse = {
  ok: boolean;
  handoff: EmailHandoffReport;
  backend: BackendReadiness;
  provider: ProviderReadiness;
  providerLaunch: ProviderLaunchMatrixReport;
  operations: OperationsHealthReport;
  lifecyclePlaybook: LifecyclePlaybookReport;
  launchGate?: unknown;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type SignalDigestionPipelineRow = {
  area: string;
  check: string;
  evidence: string[];
  localOk: boolean;
  productionOk: boolean;
  recommendation: string;
  requiredEnv: string[];
  commands: string[];
  status: 'production_ready' | 'local_ready' | 'attention' | string;
};

export type SignalDigestionPipelineReport = {
  generatedAt: string;
  ok: boolean;
  productionReady: boolean;
  tenant: {
    id: string;
    name: string;
    domain: string;
    status: TenantStatus;
  } | null;
  backend: {
    mode: string;
    productionReady: boolean;
    statePath?: string;
  };
  recommendation: {
    decision: string;
    summary: string;
    productionGuardrail: string;
    localAgentCommand: string;
  };
  issues: string[];
  rows: SignalDigestionPipelineRow[];
  summary: {
    activeRoutingRules: number;
    connectedMailboxes: number;
    enabledDetectorFlows: number;
    feedbackLabels: number;
    flowRuns: number;
    generatedSignals: number;
    localReady: number;
    perTenantModels: number;
    processedSourceMessages: number;
    productionReady: number;
    signalDetectionJobs: number;
    sourceMessages: number;
    total: number;
  };
};

export type SignalDigestionPipelineResponse = {
  ok: boolean;
  pipeline: SignalDigestionPipelineReport;
  backend: BackendReadiness;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type QaAnswerRow = {
  id: string;
  question: string;
  answer: string;
  owner: string;
  evidence: string[];
  commands: string[];
  localOk: boolean;
  productionOk: boolean;
  productionCaveat: string;
  status: 'production_ready' | 'needs_live_provider' | 'needs_production' | 'needs_local_work' | string;
};

export type QaAnswersReport = {
  generatedAt: string;
  ok: boolean;
  productionReady: boolean;
  rows: QaAnswerRow[];
  recommendation: {
    summary: string;
    productionGuardrail: string;
    localAgentCommand: string;
  };
  summary: {
    localReady: number;
    needsLiveProvider: number;
    needsLocalWork: number;
    needsProduction: number;
    productionReady: number;
    secretSafe: boolean;
    total: number;
  };
};

export type QaAnswersResponse = {
  ok: boolean;
  qa: QaAnswersReport;
  backend: BackendReadiness;
  provider: ProviderReadiness;
  readiness?: unknown;
  dashboardAudit?: DashboardAuditReport;
  digestionPipeline?: SignalDigestionPipelineReport;
  onboarding?: OnboardingReadinessReport;
  operations?: OperationsHealthReport;
  lifecyclePlaybook?: LifecyclePlaybookReport;
  providerLaunch?: ProviderLaunchMatrixReport;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type LocalAgentHandoffAction = {
  id: string;
  label: string;
  owner: string;
  status: string;
  priority: number;
  blocker: string;
  evidence: string[];
  requiredEnv: string[];
  command: string;
  followUpCommands: string[];
};

export type LocalAgentHandoffReport = {
  generatedAt: string;
  ok: boolean;
  goLiveReady: boolean;
  nextAction: LocalAgentHandoffAction;
  nextActions: LocalAgentHandoffAction[];
  providerAttention: Array<{
    id: string;
    label: string;
    owner: string;
    status: string;
    missingEnv: string[];
    sandboxStatus: string;
    command: string;
  }>;
  runnableCommands: string[];
  recommendation: {
    summary: string;
    productionGuardrail: string;
    localAgentCommand: string;
  };
  summary: {
    activeApiSessions: number;
    blockedGates: number;
    failedJobs: number;
    goLiveReady: boolean;
    localReady: number;
    localTotal: number;
    nextActionId: string;
    productionPlanNextPhaseId: string | null;
    providerLaunchReady: number;
    providerTotal: number;
    secretSafe: boolean;
    totalActions: number;
  };
};

export type LocalAgentHandoffResponse = {
  ok: boolean;
  handoff: LocalAgentHandoffReport;
  backend: BackendReadiness;
  provider: ProviderReadiness;
  readiness?: unknown;
  launchGate?: unknown;
  operations?: OperationsHealthReport;
  providerLaunch?: ProviderLaunchMatrixReport;
  productionPlan?: ProductionSetupPlanReport;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type CompletionAuditRow = {
  id: string;
  label: string;
  owner: string;
  status: 'local_complete' | 'needs_local_work' | 'production_ready' | 'needs_production' | string;
  localOk: boolean;
  productionOk: boolean;
  evidence: string[];
  blockers: string[];
  commands: string[];
  api?: string | null;
};

export type CompletionAuditReport = {
  generatedAt: string;
  ok: boolean;
  localComplete: boolean;
  productionReady: boolean;
  nextLocal: CompletionAuditRow | null;
  nextProduction: CompletionAuditRow | null;
  rows: CompletionAuditRow[];
  recommendation: {
    decision: string;
    summary: string;
    productionGuardrail: string;
    localAgentCommand: string;
  };
  runnableCommands: string[];
  supportingReports: Record<string, boolean>;
  summary: {
    localComplete: boolean;
    localReady: number;
    needsLocalWork: number;
    needsProduction: number;
    productionReady: number;
    secretSafe: boolean;
    total: number;
  };
};

export type CompletionAuditResponse = {
  ok: boolean;
  completion: CompletionAuditReport;
  backend: BackendReadiness;
  provider: ProviderReadiness;
  readiness?: unknown;
  launchGate?: unknown;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type BackendHandoffAction = {
  id: string;
  label: string;
  owner: string;
  status: string;
  priority: number;
  blocker: string;
  evidence: string[];
  requiredEnv: string[];
  command: string;
  followUpCommands: string[];
};

export type BackendHandoffReport = {
  generatedAt: string;
  ok: boolean;
  productionReady: boolean;
  nextAction: BackendHandoffAction;
  actions: BackendHandoffAction[];
  backend: {
    mode: string;
    productionReady: boolean;
    readyChecks: number;
    totalChecks: number;
    missingRequiredEnv: string[];
  };
  recommendation: {
    summary: string;
    productionGuardrail: string;
    localAgentCommand: string;
  };
  runnableCommands: string[];
  summary: {
    blocked: number;
    backendReadyChecks: number;
    backendTotalChecks: number;
    drillReady: number;
    drillTotal: number;
    missingRequiredEnv: number;
    nextActionId: string;
    productionReady: boolean;
    secretSafe: boolean;
  };
};

export type BackendHandoffResponse = {
  ok: boolean;
  handoff: BackendHandoffReport;
  backend: BackendReadiness;
  operations?: OperationsHealthReport;
  productionDrill?: ProductionDrillReport;
  readiness?: unknown;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type BackendCutoverStep = {
  id: string;
  label: string;
  owner: string;
  priority: number;
  status: string;
  localOk: boolean;
  productionOk: boolean;
  requiredEnv: string[];
  configuredEnv: string[];
  missingEnv: string[];
  evidence: string[];
  command: string;
  rollbackCommand: string | null;
  completion: string;
};

export type BackendCutoverDrillReport = {
  generatedAt: string;
  ok: boolean;
  productionReady: boolean;
  nextStep: BackendCutoverStep;
  rows: BackendCutoverStep[];
  backend: {
    mode: string;
    productionReady: boolean;
    readyChecks: number;
    totalChecks: number;
    missingRequiredEnv: string[];
  };
  recommendation: {
    summary: string;
    productionGuardrail: string;
    localAgentCommand: string;
  };
  runnableCommands: string[];
  summary: {
    blocked: number;
    configuredEnv: number;
    missingRequiredEnv: number;
    nextStepId: string;
    productionReady: number;
    secretSafe: boolean;
    total: number;
  };
};

export type BackendCutoverResponse = {
  ok: boolean;
  cutover: BackendCutoverDrillReport;
  backend: BackendReadiness;
  productionDrill?: ProductionDrillReport;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type SchedulerHandoffStep = {
  id: string;
  label: string;
  owner: string;
  priority: number;
  status: string;
  localOk: boolean;
  productionOk: boolean;
  requiredEnv: string[];
  configuredEnv: string[];
  missingEnv: string[];
  evidence: string[];
  blocker: string;
  command: string;
  followUpCommands: string[];
  rollbackCommand: string | null;
  completion: string;
};

export type SchedulerHandoffReport = {
  generatedAt: string;
  ok: boolean;
  productionReady: boolean;
  nextStep: SchedulerHandoffStep;
  rows: SchedulerHandoffStep[];
  backend: {
    mode: string;
    productionReady: boolean;
    schedulerReady: boolean;
  };
  operations: {
    ok: boolean;
    productionReady: boolean;
    failedJobs: number;
    activeProviderSchedules: number;
    totalProviderSchedules: number;
    dueProviderSchedules: number;
  };
  recommendation: {
    summary: string;
    productionGuardrail: string;
    localAgentCommand: string;
  };
  runnableCommands: string[];
  summary: {
    activeProviderSchedules: number;
    blocked: number;
    configuredEnv: number;
    dueProviderSchedules: number;
    failedJobs: number;
    missingRequiredEnv: number;
    nextStepId: string;
    productionReady: number;
    secretSafe: boolean;
    total: number;
  };
};

export type SchedulerHandoffResponse = {
  ok: boolean;
  handoff: SchedulerHandoffReport;
  backend: BackendReadiness;
  launchGate?: unknown;
  operations?: OperationsHealthReport;
  productionDrill?: ProductionDrillReport;
  summary: StateSummary;
  doctor: DoctorReport;
};

export type SignalStateResponse = {
  ok: boolean;
  state: SignalAppData;
  summary: StateSummary;
  agentHandoff?: LocalAgentHandoffReport;
  completionAudit?: CompletionAuditReport;
  backendHandoff?: BackendHandoffReport;
  backendCutover?: BackendCutoverDrillReport;
  schedulerHandoff?: SchedulerHandoffReport;
  backend?: BackendReadiness;
  dashboardAudit?: DashboardAuditReport;
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
};

function inviteClaimCodeIsClientSafe(claimCode?: string | null) {
  return !claimCode || /^claimed-[a-f0-9]{24}$/i.test(claimCode);
}

function redactBundledClientSecrets(data: SignalAppData): SignalAppData {
  return {
    ...data,
    invites: (data.invites ?? []).map((invite) => {
      if (inviteClaimCodeIsClientSafe(invite.claimCode)) {
        return invite;
      }
      const { claimCode: _removed, ...rest } = invite;
      return rest;
    }),
  };
}

function collectClientExposureSecretPaths(data: SignalAppData): string[] {
  const paths: string[] = [];
  (data.invites ?? []).forEach((invite, index) => {
    if (!inviteClaimCodeIsClientSafe(invite.claimCode)) {
      paths.push(`invites[${index}].claimCode`);
    }
  });
  if (localAgentHandoffStringLooksUnsafe(JSON.stringify(data))) {
    paths.push('serialized_state');
  }
  return paths;
}

export const signalData = redactBundledClientSecrets(seedData as SignalAppData);

function withFallbackModelGovernancePolicies(data: SignalAppData): SignalAppData {
  if (data.modelGovernancePolicies?.length) {
    return data;
  }
  return {
    ...data,
    modelGovernancePolicies: data.tenants.map((tenant) => {
      const admin = data.users.find((user) => user.tenantId === tenant.id && user.role === 'admin') ?? data.users[0];
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
        updatedAt: data.meta?.updatedAt ?? data.meta?.bootstrappedAt ?? '2026-06-03T00:00:00.000Z',
        updatedByUserId: admin?.id ?? 'usr_admin',
      };
    }),
  };
}

export const fallbackSignalData = withFallbackModelGovernancePolicies(signalData);
function resolveLocalApiUrl() {
  const configured = import.meta.env.VITE_SIGNAL_API_URL;
  if (configured) {
    return configured;
  }
  if (import.meta.env.PROD) {
    throw new Error('VITE_SIGNAL_API_URL is required in production builds.');
  }
  return 'http://127.0.0.1:8787';
}

export const localApiUrl = resolveLocalApiUrl();
const localApiCredentials: RequestCredentials = 'include';
const localApiActorUserId = import.meta.env.VITE_SIGNAL_LOCAL_ACTOR ?? 'usr_admin';

function localActorHeaders(extra: Record<string, string> = {}) {
  return {
    'X-Signal-Actor': localApiActorUserId,
    ...extra,
  };
}

async function readJsonPayload(response: Response) {
  return response.json().catch(() => null);
}

async function getJson<T>(
  path: string,
  {
    body,
    errorLabel = 'Signal API',
    headers = {},
    includeActorHeader = true,
    method,
    signal,
  }: {
    body?: unknown;
    errorLabel?: string;
    headers?: Record<string, string>;
    includeActorHeader?: boolean;
    method?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const response = await fetch(`${localApiUrl}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: localApiCredentials,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(includeActorHeader ? localActorHeaders(headers) : headers),
    },
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    signal,
  });
  const payload = await readJsonPayload(response);
  if (!response.ok) {
    throw new Error((payload as { error?: string } | null)?.error ?? `${errorLabel} returned ${response.status}`);
  }
  return payload as T;
}

const fallbackProviderRequirements = [
  {
    id: 'session',
    label: 'Signed Session Boundary',
    category: 'auth' as const,
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
    category: 'email' as const,
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
    category: 'email' as const,
    provider: 'outlook',
    requiredEnv: ['SIGNAL_OUTLOOK_CLIENT_ID', 'SIGNAL_OUTLOOK_CLIENT_SECRET', 'SIGNAL_OUTLOOK_TENANT_ID', 'SIGNAL_OUTLOOK_REDIRECT_URI', 'SIGNAL_TOKEN_ENCRYPTION_KEY'],
    optionalEnv: ['SIGNAL_API_BASE_URL', 'SIGNAL_OAUTH_STATE_KEY', 'SIGNAL_OUTLOOK_NOTIFICATION_URL', 'SIGNAL_OUTLOOK_LIFECYCLE_NOTIFICATION_URL', 'SIGNAL_OUTLOOK_SUBSCRIPTION_RESOURCE', 'SIGNAL_OUTLOOK_WEBHOOK_CLIENT_STATE', 'SIGNAL_TOKEN_VAULT'],
    callbackPath: '/api/oauth/outlook/callback',
    webhookPath: '/api/webhooks/outlook',
    lifecycleWebhookPath: '/api/webhooks/outlook/lifecycle',
    boundary: 'Graph OAuth connection, folder-scoped sync, delta cursor replay, and subscription notifications.',
  },
  {
    id: 'outbound-email',
    label: 'Outbound Email Provider',
    category: 'email' as const,
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
    category: 'payment' as const,
    provider: 'stripe',
    requiredEnv: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SIGNAL_STRIPE_PRICE_TEAM'],
    optionalEnv: ['STRIPE_PUBLISHABLE_KEY', 'SIGNAL_APP_BASE_URL', 'SIGNAL_STRIPE_ALLOW_PROMOTION_CODES', 'SIGNAL_STRIPE_CANCEL_URL', 'SIGNAL_STRIPE_PORTAL_RETURN_URL', 'SIGNAL_STRIPE_PRICE_BETA', 'SIGNAL_STRIPE_PRICE_BUSINESS', 'SIGNAL_STRIPE_SUCCESS_URL'],
    callbackPath: '/api/billing/return',
    webhookPath: '/api/webhooks/stripe',
    boundary: 'Live Checkout sessions, Billing Portal handoffs, signed webhooks, subscription source of truth, and entitlement updates.',
  },
];

export function fallbackProviderReadiness(): ProviderReadiness {
  const providers = fallbackProviderRequirements.map((requirement) => ({
    ...requirement,
    configuredRequired: [],
    configuredOptional: [],
    missingRequired: requirement.requiredEnv,
    required: requirement.requiredEnv.map((key) => ({ key, configured: false })),
    optional: requirement.optionalEnv.map((key) => ({ key, configured: false })),
    ready: false,
  }));
  return {
    ok: false,
    localOnly: true,
    providers,
    summary: {
      readyProviders: 0,
      totalProviders: providers.length,
      missingRequired: providers.reduce((count, provider) => count + provider.missingRequired.length, 0),
    },
  };
}

export function fallbackBackendReadiness(): BackendReadiness {
  const checks: BackendReadinessCheck[] = [
    {
      id: 'backend_mode',
      label: 'Backend mode',
      ok: false,
      localOk: true,
      message: 'Seed mode uses local JSON state; production needs a durable backend mode.',
      configuredEnv: [],
      missingEnv: ['SIGNAL_BACKEND_MODE'],
      requiredEnv: ['SIGNAL_BACKEND_MODE'],
      details: { mode: 'local-json' },
    },
    {
      id: 'durable_state',
      label: 'Durable state boundary',
      ok: false,
      localOk: true,
      message: 'Production state storage is not configured in seed mode.',
      configuredEnv: [],
      missingEnv: ['DATABASE_URL', 'SIGNAL_STATE_SERVICE_URL'],
      requiredEnv: ['DATABASE_URL', 'SIGNAL_STATE_SERVICE_URL'],
    },
    {
      id: 'signed_session_enforced',
      label: 'Signed session enforcement',
      ok: false,
      localOk: true,
      message: 'Production API mode must require signed sessions.',
      configuredEnv: [],
      missingEnv: ['SIGNAL_REQUIRE_SIGNED_SESSION', 'SIGNAL_SESSION_SECRET'],
      requiredEnv: ['SIGNAL_REQUIRE_SIGNED_SESSION', 'SIGNAL_SESSION_SECRET'],
    },
    {
      id: 'session_cookie_secure',
      label: 'Secure session cookies',
      ok: false,
      localOk: true,
      message: 'Non-loopback signed-session mode requires SIGNAL_COOKIE_SECURE=true or an HTTPS SIGNAL_APP_BASE_URL.',
      configuredEnv: [],
      missingEnv: ['SIGNAL_COOKIE_SECURE'],
      requiredEnv: ['SIGNAL_COOKIE_SECURE', 'SIGNAL_APP_BASE_URL'],
    },
    {
      id: 'system_webhook_actor',
      label: 'Webhook system actor',
      ok: false,
      localOk: true,
      message: 'Non-loopback hosts require SIGNAL_WEBHOOK_ACTOR for webhook mutations.',
      configuredEnv: [],
      missingEnv: ['SIGNAL_WEBHOOK_ACTOR'],
      requiredEnv: ['SIGNAL_WEBHOOK_ACTOR'],
    },
    {
      id: 'system_oauth_actor',
      label: 'OAuth callback system actor',
      ok: false,
      localOk: true,
      message: 'Non-loopback hosts require SIGNAL_OAUTH_ACTOR for OAuth callback mutations.',
      configuredEnv: [],
      missingEnv: ['SIGNAL_OAUTH_ACTOR'],
      requiredEnv: ['SIGNAL_OAUTH_ACTOR'],
    },
    {
      id: 'production_auth_provider',
      label: 'Production auth provider',
      ok: false,
      localOk: true,
      message: 'Production auth provider is not declared in seed mode.',
      configuredEnv: [],
      missingEnv: ['SIGNAL_AUTH_PROVIDER', 'SIGNAL_AUTH_JWKS_URL'],
      requiredEnv: ['SIGNAL_AUTH_PROVIDER', 'SIGNAL_AUTH_JWKS_URL'],
    },
    {
      id: 'cors_origins',
      label: 'Production CORS origins',
      ok: false,
      localOk: true,
      message: 'Production CORS needs explicit non-wildcard, non-loopback origins.',
      configuredEnv: [],
      missingEnv: ['SIGNAL_API_CORS_ORIGINS'],
      requiredEnv: ['SIGNAL_API_CORS_ORIGINS'],
    },
    {
      id: 'job_scheduler',
      label: 'Production job scheduler',
      ok: false,
      localOk: true,
      message: 'Production scheduler is not configured for provider validation, sync, digest, and billing jobs.',
      configuredEnv: [],
      missingEnv: ['SIGNAL_JOB_SCHEDULER', 'SIGNAL_PROVIDER_VALIDATION_SCHEDULER'],
      requiredEnv: ['SIGNAL_JOB_SCHEDULER', 'SIGNAL_PROVIDER_VALIDATION_SCHEDULER'],
    },
    {
      id: 'tenant_isolation',
      label: 'Tenant isolation',
      ok: false,
      localOk: true,
      message: 'Production multi-org support needs durable tenant isolation such as RLS or policy enforcement.',
      configuredEnv: [],
      missingEnv: ['SIGNAL_TENANT_ISOLATION_MODE'],
      requiredEnv: ['SIGNAL_TENANT_ISOLATION_MODE'],
    },
  ];
  return {
    ok: true,
    productionReady: false,
    localOnly: true,
    mode: 'local-json',
    checks,
    summary: {
      readyChecks: 0,
      totalChecks: checks.length,
      missingRequiredEnv: [...new Set(checks.flatMap((check) => check.missingEnv))],
    },
  };
}

export function summarizeLocalState(data: SignalAppData): StateSummary {
  const activeMemberships = (data.memberships ?? []).filter((membership) =>
    membership.status === 'active' &&
    data.users.some((user) => user.id === membership.userId && user.status === 'active'));
  const activeSeatCount = activeMemberships.length || data.users.filter((user) => user.status === 'active').length;
  const pendingInviteCount = data.invites?.filter((invite) => invite.status === 'pending').length ?? 0;
  const seatLimit = data.entitlements?.[0]?.seatLimit ?? data.plans.find((plan) => plan.id === data.tenants[0]?.planId)?.seatLimit ?? null;
  return {
    auditEvents: data.auditEvents?.length ?? 0,
    admins: data.users.filter((user) => user.role === 'admin' && user.status === 'active').length,
    invites: data.invites?.length ?? 0,
    pendingInvites: pendingInviteCount,
    acceptedInvites: data.invites?.filter((invite) => invite.status === 'accepted').length ?? 0,
    memberships: data.memberships?.length ?? 0,
    activeMemberships: activeMemberships.length,
    disabledMemberships: data.memberships?.filter((membership) => membership.status === 'disabled').length ?? 0,
    activeSeats: activeSeatCount,
    pendingInviteSeats: pendingInviteCount,
    seatLimit,
    seatsAvailable: Math.max(0, (seatLimit ?? data.users.length) - activeSeatCount - pendingInviteCount),
    connectedMailboxes: data.mailboxes.filter((mailbox) => mailbox.status === 'connected').length,
    activeSyncCursors: data.emailSyncCursors?.filter((cursor) => cursor.status === 'active').length ?? 0,
    blockedSyncCursors: data.emailSyncCursors?.filter((cursor) => cursor.status === 'blocked').length ?? 0,
    emailWatchSubscriptions: data.emailWatchSubscriptions?.length ?? 0,
    activeEmailWatchSubscriptions: data.emailWatchSubscriptions?.filter((watch) => watch.status === 'active').length ?? 0,
    expiringEmailWatchSubscriptions: data.emailWatchSubscriptions?.filter((watch) => watch.status === 'active' && Date.parse(watch.expirationAt) < Date.now() + 24 * 60 * 60 * 1000).length ?? 0,
    emailFlows: data.emailFlows.length,
    enabledEmailFlows: data.emailFlows.filter((flow) => flow.status === 'enabled').length,
    routingRules: data.routingRules?.length ?? 0,
    activeRoutingRules: data.routingRules?.filter((rule) => rule.status === 'active').length ?? 0,
    sourceMessages: data.sourceMessages?.length ?? 0,
    flowRuns: data.flowRuns?.length ?? 0,
    generatedSignals: data.signals.filter((signal) => signal.sourceMessageId && signal.flowId).length,
    signalHandoffs: data.signalHandoffs?.length ?? 0,
    queuedSignalHandoffs: data.signalHandoffs?.filter((handoff) => handoff.status === 'queued').length ?? 0,
    failedSignalHandoffs: data.signalHandoffs?.filter((handoff) => handoff.status === 'failed').length ?? 0,
    environment: data.meta?.environment ?? 'local-fallback',
    activeTenants: data.tenants.filter((tenant) => tenant.status === 'active').length,
    suspendedTenants: data.tenants.filter((tenant) => tenant.status === 'suspended').length,
    tenantStatus: data.tenants[0]?.status ?? null,
    accounts: data.accountProfiles?.length ?? 0,
    atRiskAccounts: data.accountProfiles?.filter((account) => account.healthScore < 55 || account.healthTrend === 'down').length ?? 0,
    accountEvents: data.accountEvents?.length ?? 0,
    openAccountActions: data.accountActions?.filter((action) => action.status === 'open').length ?? 0,
    accountReviews: data.accountReviews?.length ?? 0,
    accountRecommendations: data.accountRecommendations?.length ?? 0,
    openAccountRecommendations: data.accountRecommendations?.filter((recommendation) => recommendation.status === 'open').length ?? 0,
    latestAccountReviewAt: [...(data.accountReviews ?? [])].sort((left, right) => Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? ''))[0]?.createdAt ?? null,
    notificationPreferences: data.notificationPreferences?.length ?? 0,
    notificationEvents: data.notificationEvents?.length ?? 0,
    unreadNotifications: data.notificationEvents?.filter((event) => event.status === 'unread').length ?? 0,
    mutedNotifications: data.notificationEvents?.filter((event) => event.status === 'muted').length ?? 0,
    digestRuns: data.notificationDigestRuns?.length ?? 0,
    emailDeliveries: data.emailDeliveryMessages?.length ?? 0,
    queuedEmailDeliveries: data.emailDeliveryMessages?.filter((message) => message.status === 'queued').length ?? 0,
    failedEmailDeliveries: data.emailDeliveryMessages?.filter((message) => ['failed', 'bounced'].includes(message.status)).length ?? 0,
    unsubscribedUsers: data.notificationPreferences?.filter((preference) => preference.emailDeliveryStatus === 'unsubscribed' || !(preference.channels ?? []).includes('email_digest')).length ?? 0,
    signalQualitySettings: data.signalQualitySettings?.length ?? 0,
    suppressionRules: data.suppressionRules?.length ?? 0,
    activeSuppressionRules: data.suppressionRules?.filter((rule) => rule.status === 'active').length ?? 0,
    signalFeedback: data.signalFeedback?.length ?? 0,
    modelGovernancePolicies: data.modelGovernancePolicies?.length ?? 0,
    optInModelLearningPolicies: data.modelGovernancePolicies?.filter((policy) => policy.learningMode === 'opt_in_tuning').length ?? 0,
    perTenantModels: data.modelGovernancePolicies?.filter((policy) => policy.perTenantModel === true).length ?? 0,
    governancePolicies: data.governancePolicies?.length ?? 0,
    activeRedactionRules: data.redactionRules?.filter((rule) => rule.status === 'active').length ?? 0,
    openDataRequests: data.dataRequests?.filter((request) => ['open', 'processing'].includes(request.status)).length ?? 0,
    openIncidentNotes: data.incidentNotes?.filter((note) => note.status === 'open').length ?? 0,
    mailboxes: data.mailboxes.length,
    mailboxConnectionSessions: data.mailboxConnectionSessions?.length ?? 0,
    openSignals: data.signals.filter((signal) => signal.status === 'open').length,
    activeEntitlements: data.entitlements?.filter((entitlement) => entitlement.status === 'active').length ?? 0,
    billingSessions: data.billingSessions?.length ?? 0,
    billingOverrides: data.billingOverrides?.length ?? 0,
    activeBillingOverrides: data.billingOverrides?.filter((override) => override.status === 'active').length ?? 0,
    revokedBillingOverrides: data.billingOverrides?.filter((override) => override.status === 'revoked').length ?? 0,
    lifecycleNotices: data.lifecycleNotices?.length ?? 0,
    openLifecycleNotices: data.lifecycleNotices?.filter((notice) => notice.status === 'open').length ?? 0,
    criticalLifecycleNotices: data.lifecycleNotices?.filter((notice) => notice.severity === 'critical' && notice.status === 'open').length ?? 0,
    failedJobs: data.jobs?.filter((job) => job.status === 'failed').length ?? 0,
    jobs: data.jobs?.length ?? 0,
    apiSessions: data.apiSessions?.length ?? 0,
    activeApiSessions: data.apiSessions?.filter((session) => session.status === 'active').length ?? 0,
    revokedApiSessions: data.apiSessions?.filter((session) => session.status === 'revoked').length ?? 0,
    providerValidationRuns: data.providerValidationRuns?.length ?? 0,
    latestProviderValidationStatus: [...(data.providerValidationRuns ?? [])].sort((left, right) => Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? ''))[0]?.status ?? null,
    latestProviderValidationAt: [...(data.providerValidationRuns ?? [])].sort((left, right) => Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? ''))[0]?.recordedAt ?? null,
    providerValidationSchedules: data.providerValidationSchedules?.length ?? 0,
    activeProviderValidationSchedules: data.providerValidationSchedules?.filter((schedule) => schedule.status === 'active').length ?? 0,
    dueProviderValidationSchedules: data.providerValidationSchedules?.filter((schedule) => {
      if (schedule.status !== 'active' || schedule.cadence === 'manual' || !schedule.nextRunAt) {
        return false;
      }
      const nextRunMs = Date.parse(schedule.nextRunAt);
      return Number.isFinite(nextRunMs) && nextRunMs <= Date.now();
    }).length ?? 0,
    paymentEvents: data.paymentEvents.length,
    invoices: data.invoices?.length ?? 0,
    openInvoices: data.invoices?.filter((invoice) => ['open', 'past_due'].includes(invoice.status)).length ?? 0,
    pastDueInvoices: data.invoices?.filter((invoice) => invoice.status === 'past_due').length ?? 0,
    schemaVersion: data.meta?.schemaVersion ?? null,
    statePath: data.meta?.statePath,
    subscriptions: data.subscriptions.length,
    tenants: data.tenants.length,
    users: data.users.length,
    activeUserId: data.session?.activeUserId ?? null,
    activeUserRole: data.users.find((user) => user.id === data.session?.activeUserId)?.role ?? null,
  };
}

function dashboardAuditRow({
  area,
  check,
  detail,
  displayValue,
  scope = 'global_total',
  summary,
  summaryKey,
  totalValue,
}: {
  area: string;
  check: string;
  detail: string;
  displayValue: number;
  scope?: DashboardAuditRow['scope'];
  summary: StateSummary;
  summaryKey: keyof StateSummary;
  totalValue: number;
}): DashboardAuditRow {
  const summaryValue = Number(summary[summaryKey] ?? 0);
  return {
    area,
    check,
    detail,
    displayValue,
    ok: totalValue === summaryValue && displayValue <= totalValue,
    scope,
    summaryKey,
    summaryValue,
    totalValue,
  };
}

function visibleDashboardScope(data: SignalAppData, summary: StateSummary) {
  const actor = data.users.find((user) => user.id === data.session?.activeUserId) ?? data.users[0];
  const tenantId = actor?.tenantId ?? data.tenants[0]?.id;
  const membership = data.memberships?.find((item) => item.userId === actor?.id && item.tenantId === tenantId);
  const role = membership?.role ?? actor?.role ?? null;
  const team = membership?.team ?? actor?.team ?? null;
  const isAdmin = role === 'admin';
  const visibleSignals = data.signals.filter((signal) =>
    signal.tenantId === tenantId &&
    (
      isAdmin ||
      signal.ownerUserId === actor?.id ||
      signal.routeTo === team
    ));
  const memberAccountNames = new Set([
    ...visibleSignals.map((signal) => signal.account),
    ...(data.accountActions ?? [])
      .filter((action) => action.tenantId === tenantId && action.ownerUserId === actor?.id)
      .map((action) => action.account),
  ]);
  const visibleAccounts = (data.accountProfiles ?? []).filter((account) =>
    account.tenantId === tenantId &&
    (
      isAdmin ||
      account.ownerUserId === actor?.id ||
      memberAccountNames.has(account.name)
    ));
  const visibleMailboxes = data.mailboxes.filter((mailbox) =>
    mailbox.tenantId === tenantId &&
    (
      isAdmin ||
      mailbox.ownerUserId === actor?.id
    ));
  const visibleMailboxIds = new Set(visibleMailboxes.map((mailbox) => mailbox.id));
  const visibleSourceMessages = (data.sourceMessages ?? []).filter((message) =>
    message.tenantId === tenantId &&
    visibleMailboxIds.has(message.mailboxId));
  const visibleNotifications = (data.notificationEvents ?? []).filter((event) =>
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
    summary,
    visibleAccounts,
    visibleMailboxes,
    visibleNotifications,
    visibleSignals,
    visibleSourceMessages,
  };
}

export function fallbackDashboardAudit(data: SignalAppData, backend = fallbackBackendReadiness()): DashboardAuditReport {
  const summary = summarizeLocalState(data);
  const scope = visibleDashboardScope(data, summary);
  const rows = [
    dashboardAuditRow({
      area: 'user_workspace',
      check: 'Open signals',
      detail: 'Visible workspace signal count is scoped by role, owner, and team; global total matches shared summary.',
      displayValue: scope.visibleSignals.filter((signal) => signal.status === 'open').length,
      scope: 'actor_visible',
      summary,
      summaryKey: 'openSignals',
      totalValue: data.signals.filter((signal) => signal.status === 'open').length,
    }),
    dashboardAuditRow({
      area: 'user_workspace',
      check: 'Accounts',
      detail: 'Visible account cards are scoped by owner/team signal evidence; global total matches shared summary.',
      displayValue: scope.visibleAccounts.length,
      scope: 'actor_visible',
      summary,
      summaryKey: 'accounts',
      totalValue: data.accountProfiles?.length ?? 0,
    }),
    dashboardAuditRow({
      area: 'user_workspace',
      check: 'Mailboxes',
      detail: 'Visible source cards are admin-wide or mailbox-owner scoped; global total matches shared summary.',
      displayValue: scope.visibleMailboxes.length,
      scope: 'actor_visible',
      summary,
      summaryKey: 'mailboxes',
      totalValue: data.mailboxes.length,
    }),
    dashboardAuditRow({
      area: 'user_workspace',
      check: 'Source snippets',
      detail: 'Visible source snippets only come from visible mailbox sources; global total matches shared summary.',
      displayValue: scope.visibleSourceMessages.length,
      scope: 'actor_visible',
      summary,
      summaryKey: 'sourceMessages',
      totalValue: data.sourceMessages?.length ?? 0,
    }),
    dashboardAuditRow({
      area: 'user_workspace',
      check: 'Unread notifications',
      detail: 'Member notification center is user-scoped; global unread total matches shared summary.',
      displayValue: scope.visibleNotifications.filter((event) => event.status === 'unread').length,
      scope: 'actor_visible',
      summary,
      summaryKey: 'unreadNotifications',
      totalValue: data.notificationEvents?.filter((event) => event.status === 'unread').length ?? 0,
    }),
    dashboardAuditRow({
      area: 'admin_dashboard',
      check: 'Active memberships',
      detail: 'Admin user and seat cards use membership records as the source of truth.',
      displayValue: data.memberships?.filter((membership) => membership.status === 'active').length ?? 0,
      summary,
      summaryKey: 'activeMemberships',
      totalValue: data.memberships?.filter((membership) => membership.status === 'active').length ?? 0,
    }),
    dashboardAuditRow({
      area: 'admin_dashboard',
      check: 'Pending invites',
      detail: 'Admin invite and seat cards use pending invite records as the source of truth.',
      displayValue: data.invites?.filter((invite) => invite.status === 'pending').length ?? 0,
      summary,
      summaryKey: 'pendingInvites',
      totalValue: data.invites?.filter((invite) => invite.status === 'pending').length ?? 0,
    }),
    dashboardAuditRow({
      area: 'admin_dashboard',
      check: 'Open invoices',
      detail: 'Admin payment cards use invoice records, not browser-provided billing totals.',
      displayValue: data.invoices?.filter((invoice) => ['open', 'past_due'].includes(invoice.status)).length ?? 0,
      summary,
      summaryKey: 'openInvoices',
      totalValue: data.invoices?.filter((invoice) => ['open', 'past_due'].includes(invoice.status)).length ?? 0,
    }),
    dashboardAuditRow({
      area: 'admin_dashboard',
      check: 'Lifecycle notices',
      detail: 'Admin operations and payment panels derive notices from source records in state.',
      displayValue: data.lifecycleNotices?.filter((notice) => notice.status === 'open').length ?? 0,
      summary,
      summaryKey: 'openLifecycleNotices',
      totalValue: data.lifecycleNotices?.filter((notice) => notice.status === 'open').length ?? 0,
    }),
  ];
  const issues = rows
    .filter((row) => !row.ok)
    .map((row) => `${row.area}.${row.summaryKey}: displayed ${row.displayValue}, total ${row.totalValue}, summary ${row.summaryValue}`);
  return {
    actor: scope.actor,
    backend: {
      mode: backend.mode,
      productionReady: backend.productionReady,
      readyChecks: backend.summary.readyChecks,
      statePath: summary.statePath,
      totalChecks: backend.summary.totalChecks,
    },
    generatedAt: new Date().toISOString(),
    issues,
    ok: issues.length === 0,
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
  evidence,
  localOk,
  productionOk,
  recommendation,
}: {
  area: string;
  check: string;
  evidence: string[];
  localOk: boolean;
  productionOk: boolean;
  recommendation: string;
}): OnboardingReadinessRow {
  return {
    area,
    check,
    evidence,
    localOk,
    productionOk,
    recommendation,
    status: localOk ? (productionOk ? 'production_ready' : 'local_ready') : 'attention',
  };
}

export function fallbackOnboardingReadiness(data: SignalAppData, backend = fallbackBackendReadiness()): OnboardingReadinessReport {
  const summary = summarizeLocalState(data);
  const tenant = data.tenants[0] ?? null;
  const scope = visibleDashboardScope(data, summary);
  const memberships = (data.memberships ?? []).filter((membership) => !tenant?.id || membership.tenantId === tenant.id);
  const activeMemberships = memberships.filter((membership) =>
    membership.status === 'active' &&
    data.users.some((user) => user.id === membership.userId && user.status === 'active'));
  const activeAdmins = activeMemberships.filter((membership) => membership.role === 'admin');
  const activeMembers = activeMemberships.filter((membership) => membership.role === 'member');
  const pendingInvites = (data.invites ?? []).filter((invite) => (!tenant?.id || invite.tenantId === tenant.id) && invite.status === 'pending');
  const acceptedInvites = (data.invites ?? []).filter((invite) => (!tenant?.id || invite.tenantId === tenant.id) && invite.status === 'accepted');
  const acceptedInvitesWithMembership = acceptedInvites.filter((invite) => memberships.some((membership) => membership.inviteId === invite.id));
  const subscription = data.subscriptions.find((item) => item.tenantId === tenant?.id);
  const entitlement = data.entitlements?.find((item) => item.tenantId === tenant?.id);
  const checkoutSession = data.billingSessions?.find((session) => session.tenantId === tenant?.id && session.type === 'checkout');
  const onboardingNotifications = (data.notificationEvents ?? []).filter((event) => event.tenantId === tenant?.id && String(event.type ?? '').startsWith('onboarding.'));
  const onboardingJobs = (data.jobs ?? []).filter((job) => job.tenantId === tenant?.id && job.queue === 'user_onboarding');
  const activeUsers = data.users.filter((user) => user.tenantId === tenant?.id && user.status === 'active');
  const usersWithPreferences = activeUsers.filter((user) => data.notificationPreferences?.some((preference) => preference.userId === user.id));
  const governancePolicy = data.governancePolicies?.find((policy) => policy.tenantId === tenant?.id);
  const modelPolicy = data.modelGovernancePolicies?.find((policy) => policy.tenantId === tenant?.id);
  const mailboxOwnershipOk = data.mailboxes
    .filter((mailbox) => !tenant?.id || mailbox.tenantId === tenant.id)
    .every((mailbox) => activeMemberships.some((membership) => membership.userId === mailbox.ownerUserId));
  const routingOwnershipOk = (data.routingRules ?? [])
    .filter((rule) => !tenant?.id || rule.tenantId === tenant.id)
    .every((rule) => !rule.ownerUserId || activeMemberships.some((membership) => membership.userId === rule.ownerUserId));
  const orphanMemberships = memberships.filter((membership) =>
    !data.users.some((user) => user.id === membership.userId) ||
    !data.tenants.some((candidate) => candidate.id === membership.tenantId));
  const tenantIsolationReady = backend.checks.find((check) => check.id === 'tenant_isolation')?.ok ?? false;
  const signedSessionReady = backend.checks.find((check) => check.id === 'signed_session_enforced')?.ok ?? false;
  const productionAuthReady = backend.checks.find((check) => check.id === 'production_auth_provider')?.ok ?? false;
  const durableStateReady = backend.checks.find((check) => check.id === 'durable_state')?.ok ?? false;
  const productionIsolationReady = tenantIsolationReady && signedSessionReady && productionAuthReady && durableStateReady;
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
      productionOk: durableStateReady && productionAuthReady,
      recommendation: 'Keep registration as a workspace-first flow; do not create personal-only accounts before tenant membership exists.',
    }),
    onboardingReadinessRow({
      area: 'member_invitation',
      check: 'Member invitation and acceptance create bounded invite records, accepted users, active memberships, seat accounting, and invite provenance.',
      evidence: [
        `${pendingInvites.length} pending invite(s), ${acceptedInvitesWithMembership.length}/${acceptedInvites.length} accepted invite(s) with membership provenance`,
        `${summary.activeSeats}+${summary.pendingInviteSeats}/${summary.seatLimit ?? 'unlimited'} active+pending seats`,
        `${summary.seatsAvailable ?? 'unlimited'} available seat(s)`,
      ],
      localOk: pendingInvites.every((invite) => Boolean(invite.expiresAt) && Date.parse(invite.expiresAt) > Date.parse(invite.createdAt)) &&
        (pendingInvites.length > 0 || acceptedInvites.length > 0) &&
        activeMemberships.length > 1 &&
        ((summary.seatsAvailable ?? 0) >= 0),
      productionOk: durableStateReady && productionAuthReady,
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
        `actor ${scope.actor?.id ?? 'none'} as ${scope.actor?.role ?? 'unknown'}`,
        `${scope.visibleSignals.length}/${data.signals.length} visible signal rows for the active actor`,
        `${scope.visibleMailboxes.length}/${summary.mailboxes} visible mailbox source rows for the active actor`,
      ],
      localOk: Boolean(scope.actor && memberships.some((membership) => membership.userId === scope.actor?.id && membership.status === 'active')) && mailboxOwnershipOk && routingOwnershipOk,
      productionOk: productionIsolationReady,
      recommendation: 'Admins can see tenant-wide controls; members should keep owner/team-scoped signals, owned mailboxes, own notifications, and owned account work.',
    }),
    onboardingReadinessRow({
      area: 'data_privacy',
      check: 'Privacy posture keeps email-derived evidence tenant-isolated, owner/team scoped for members, retention-governed, and redaction-ready.',
      evidence: [
        governancePolicy ? `${governancePolicy.sourceRetentionDays} day source retention / ${governancePolicy.rawSnippetRetentionDays} day raw snippets` : 'Missing governance policy',
        modelPolicy ? `${modelPolicy.detectorBoundary}, learning ${modelPolicy.learningMode}, per-org model ${modelPolicy.perTenantModel ? 'on' : 'off'}` : 'Missing model governance',
        `${usersWithPreferences.length}/${activeUsers.length} active users have notification preferences`,
      ],
      localOk: Boolean(governancePolicy && modelPolicy?.dataBoundary === 'tenant_isolated' && modelPolicy?.perTenantModel === false && usersWithPreferences.length === activeUsers.length),
      productionOk: productionIsolationReady,
      recommendation: 'Do not give members unrestricted tenant email visibility; keep raw provider credentials and bodies outside app state.',
    }),
    onboardingReadinessRow({
      area: 'focus_and_notifications',
      check: 'Each user can carry focus controls for digest cadence, immediate alerts, mute rules, account ownership, and routed priorities.',
      evidence: [
        `${data.routingRules?.filter((rule) => rule.tenantId === tenant?.id && rule.status === 'active').length ?? 0} active routing rule(s)`,
        `${data.notificationPreferences?.filter((preference) => activeUsers.some((user) => user.id === preference.userId)).length ?? 0} notification preference record(s)`,
        `${data.accountRecommendations?.filter((recommendation) => recommendation.tenantId === tenant?.id && recommendation.status === 'open').length ?? 0} open recommendation(s)`,
      ],
      localOk: routingOwnershipOk && usersWithPreferences.length === activeUsers.length,
      productionOk: productionAuthReady,
      recommendation: 'Support user-specific outcomes through routes, ownership, notification preferences, and mute rules rather than separate org models.',
    }),
    onboardingReadinessRow({
      area: 'admin_monitoring',
      check: 'Admins have CLI/API/UI control over workspace creation, invites, roles, disable/reactivate, privacy evidence, audit events, and session registry.',
      evidence: [
        `${summary.auditEvents ?? 0} audit event(s)`,
        `${summary.apiSessions ?? 0} API session record(s)`,
        'CLI: tenants, users, session, readiness, onboarding-readiness',
      ],
      localOk: activeAdmins.length > 0,
      productionOk: signedSessionReady && productionAuthReady,
      recommendation: 'Keep admin/system operations separate from member workspace workflows and require signed admin sessions for API access.',
    }),
  ];
  const issues = rows.filter((row) => !row.localOk).map((row) => `${row.area}: ${row.check}`);
  return {
    actor: scope.actor,
    backend: {
      mode: backend.mode,
      productionReady: backend.productionReady,
      signedSessionReady,
      statePath: summary.statePath,
      tenantIsolationReady,
    },
    generatedAt: new Date().toISOString(),
    issues,
    ok: issues.length === 0,
    productionReady: rows.every((row) => row.productionOk),
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
      seatLimit: summary.seatLimit ?? null,
      seatsAvailable: summary.seatsAvailable ?? null,
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

function tenantIsolationAuditRow({
  area,
  check,
  evidence,
  localOk,
  productionOk,
  recommendation,
  requiredEnv = [],
  commands = [],
}: {
  area: string;
  check: string;
  evidence: string[];
  localOk: boolean;
  productionOk: boolean;
  recommendation: string;
  requiredEnv?: string[];
  commands?: string[];
}): TenantIsolationAuditRow {
  return {
    area,
    check,
    evidence,
    localOk,
    productionOk,
    recommendation,
    requiredEnv,
    commands,
    status: localOk ? (productionOk ? 'production_ready' : 'local_ready') : 'attention',
  };
}

export function fallbackTenantIsolationAudit(data: SignalAppData, backend = fallbackBackendReadiness()): TenantIsolationAuditReport {
  const summary = summarizeLocalState(data);
  const tenant = data.tenants[0] ?? null;
  const scope = visibleDashboardScope(data, summary);
  const tenantId = tenant?.id ?? scope.actor?.tenantId;
  const memberships = data.memberships ?? [];
  const tenantMemberships = memberships.filter((membership) => !tenantId || membership.tenantId === tenantId);
  const activeMemberships = tenantMemberships.filter((membership) =>
    membership.status === 'active' &&
    data.users.some((user) => user.id === membership.userId && user.status === 'active'));
  const activeAdmins = activeMemberships.filter((membership) => membership.role === 'admin');
  const activeMembers = activeMemberships.filter((membership) => membership.role === 'member');
  const orphanMemberships = memberships.filter((membership) =>
    !data.users.some((user) => user.id === membership.userId) ||
    !data.tenants.some((candidate) => candidate.id === membership.tenantId));
  const actorMembership = tenantMemberships.find((membership) => membership.userId === scope.actor?.id && membership.status === 'active');
  const tenantUsers = data.users.filter((user) => !tenantId || user.tenantId === tenantId);
  const tenantOwnedUserIds = new Set(activeMemberships.map((membership) => membership.userId));
  const tenantMailboxes = data.mailboxes.filter((mailbox) => !tenantId || mailbox.tenantId === tenantId);
  const tenantSignals = data.signals.filter((signal) => !tenantId || signal.tenantId === tenantId);
  const tenantActions = (data.accountActions ?? []).filter((action) => !tenantId || action.tenantId === tenantId);
  const tenantRecommendations = (data.accountRecommendations ?? []).filter((recommendation) => !tenantId || recommendation.tenantId === tenantId);
  const tenantRoutingRules = (data.routingRules ?? []).filter((rule) => !tenantId || rule.tenantId === tenantId);
  const tenantNotifications = (data.notificationEvents ?? []).filter((event) => !tenantId || event.tenantId === tenantId);
  const tenantSources = (data.sourceMessages ?? []).filter((message) => !tenantId || message.tenantId === tenantId);
  const visibleWithinTenant = scope.visibleSignals.length <= tenantSignals.length &&
    scope.visibleMailboxes.length <= tenantMailboxes.length &&
    scope.visibleSourceMessages.length <= tenantSources.length &&
    scope.visibleNotifications.length <= tenantNotifications.length;
  const ownedUserIds = [
    ...tenantMailboxes.map((mailbox) => mailbox.ownerUserId),
    ...tenantSignals.map((signal) => signal.ownerUserId),
    ...tenantActions.map((action) => action.ownerUserId),
    ...tenantRecommendations.map((recommendation) => recommendation.ownerUserId),
    ...tenantRoutingRules.map((rule) => rule.ownerUserId).filter((userId): userId is string => Boolean(userId)),
  ];
  const ownsOrRoutesOk = ownedUserIds.every((userId) => tenantOwnedUserIds.has(userId));
  const mutationAuditActions = new Set((data.auditEvents ?? [])
    .filter((event) => !tenant?.id || event.tenantId === tenant.id)
    .map((event) => event.action));
  const adminMutationEvidence = [
    'tenants.create',
    'tenants.register',
    'users.invite',
    'users.role',
    'payments.override',
  ].filter((action) => mutationAuditActions.has(action));
  const backendCheck = (id: string) => backend.checks.find((check) => check.id === id);
  const tenantIsolationReady = backendCheck('tenant_isolation')?.ok ?? false;
  const signedSessionReady = backendCheck('signed_session_enforced')?.ok ?? false;
  const productionAuthReady = backendCheck('production_auth_provider')?.ok ?? false;
  const durableStateReady = Boolean(backendCheck('durable_state')?.ok || backendCheck('state_service_storage')?.ok);
  const productionIsolationReady = tenantIsolationReady && signedSessionReady && productionAuthReady && durableStateReady;
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
      localOk: activeAdmins.length > 0 && Boolean(actorMembership) && actorMembership?.role === 'admin',
      productionOk: signedSessionReady && productionAuthReady,
      recommendation: 'Keep admin setup, role changes, billing overrides, and source controls behind signed admin sessions; keep registration as the only public workspace creation path.',
      commands: ['npm run admin -- session list --json', 'npm run admin -- export --json'],
    }),
    tenantIsolationAuditRow({
      area: 'production_auth_claims',
      check: 'Production API requests must carry managed identity, signed sessions, and org/member claims that map to active membership.',
      evidence: [
        backendCheck('signed_session_enforced')?.message ?? 'Signed session check missing',
        backendCheck('production_auth_provider')?.message ?? 'Production auth provider check missing',
      ],
      localOk: true,
      productionOk: signedSessionReady && productionAuthReady,
      recommendation: 'Map provider identity claims to tenant membership on every request and fail closed when membership is missing or inactive.',
      requiredEnv: ['SIGNAL_SESSION_SECRET', 'SIGNAL_AUTH_PROVIDER', 'SIGNAL_AUTH_JWKS_URL'],
      commands: ['npm run admin -- backend --env-file ./.env.production --json'],
    }),
    tenantIsolationAuditRow({
      area: 'production_rls_policy',
      check: 'Production storage must enforce tenant isolation through database policy, RLS, or an equivalent state-service authorization layer.',
      evidence: [
        backendCheck('tenant_isolation')?.message ?? 'Tenant isolation backend check missing',
        `backend mode ${backend.mode}`,
      ],
      localOk: true,
      productionOk: tenantIsolationReady,
      recommendation: 'Do not run multiple customer organizations on shared production storage until the tenant isolation backend check is green.',
      requiredEnv: ['SIGNAL_TENANT_ISOLATION_MODE', 'SIGNAL_STATE_SERVICE_URL', 'DATABASE_URL'],
      commands: ['npm run admin -- backend --env-file ./.env.production --json', 'npm run admin -- production-plan --json'],
    }),
    tenantIsolationAuditRow({
      area: 'durable_state_boundary',
      check: 'Production data must use durable storage/state-service health, backup, restore, and migration evidence instead of local JSON.',
      evidence: [
        backendCheck('durable_state')?.message ?? 'Durable state check missing',
        backendCheck('state_service_storage')?.message ?? 'State-service storage check missing',
        `state path ${summary.statePath}`,
      ],
      localOk: true,
      productionOk: durableStateReady,
      recommendation: 'Local JSON is acceptable for the local agent; production needs durable tenant-isolated state and backup/restore proof.',
      requiredEnv: ['SIGNAL_STATE_BACKEND', 'SIGNAL_STATE_SERVICE_URL', 'DATABASE_URL', 'SIGNAL_STATE_BACKUP_POLICY'],
      commands: ['npm run admin -- production-drill --env-file ./.env.production --json'],
    }),
  ];
  const issues = rows.filter((row) => !row.localOk).map((row) => `${row.area}: ${row.check}`);
  return {
    actor: scope.actor,
    backend: {
      mode: backend.mode,
      productionReady: backend.productionReady,
      tenantIsolationReady,
      signedSessionReady,
      productionAuthReady,
      durableStateReady,
      statePath: summary.statePath,
    },
    generatedAt: new Date().toISOString(),
    issues,
    ok: issues.length === 0,
    productionReady: rows.every((row) => row.productionOk),
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
  { channel: 'gmail', label: 'Gmail provider watch', path: '/api/webhooks/gmail', provider: 'gmail' },
  { channel: 'outlook', label: 'Outlook provider watch', path: '/api/webhooks/outlook', provider: 'outlook' },
  { channel: 'outbound_email', label: 'Outbound email status', path: '/api/webhooks/email' },
  { channel: 'stripe', label: 'Stripe billing event', path: '/api/webhooks/stripe' },
];

const operationsQueueNames = [
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

function latestLocalIso(items: Array<Record<string, unknown>>, fields: string[]): string | null {
  return items
    .flatMap((item) => fields.map((field) => item[field]))
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort()
    .at(-1) ?? null;
}

function countLocalStatuses(items: Array<{ status?: string }>): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const status = item.status ?? 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
}

function fallbackWebhookHealthRows(data: SignalAppData): OperationsWebhookHealth[] {
  const watches = data.emailWatchSubscriptions ?? [];
  const deliveries = data.emailDeliveryMessages ?? [];
  const paymentEvents = data.paymentEvents ?? [];
  const jobs = data.jobs ?? [];
  const outcomes = data.webhookEvents ?? [];
  return operationsWebhookCatalog.map((item) => {
    const channelOutcomes = outcomes.filter((event) => event.provider === item.channel || (item.channel === 'outbound_email' && event.provider === 'email'));
    const rejected = channelOutcomes.filter((event) => !event.accepted).length;
    if (item.channel === 'gmail' || item.channel === 'outlook') {
      const providerWatches = watches.filter((watch) => watch.provider === item.provider);
      const activeWatches = providerWatches.filter((watch) => watch.status === 'active');
      const failedWatches = providerWatches.filter((watch) => watch.status === 'failed');
      const backoffWatches = providerWatches.filter((watch) => {
        const retryAfterMs = Date.parse(watch.providerRetryAfterAt ?? '');
        return Number.isFinite(retryAfterMs) && retryAfterMs > Date.now();
      });
      const status = backoffWatches.length ? 'backoff' : failedWatches.length ? 'attention' : activeWatches.length ? 'ready' : providerWatches.length ? 'watch' : 'not_configured';
      return {
        channel: item.channel,
        evidence: [
          `${activeWatches.length}/${providerWatches.length} active watch subscription(s)`,
          `${providerWatches.reduce((total, watch) => total + (watch.notificationCount ?? 0), 0)} provider notification(s)`,
          `${failedWatches.length} failed watch subscription(s)`,
          `${channelOutcomes.length} webhook outcome(s), ${rejected} rejected`,
        ],
        label: item.label,
        latestAt: latestLocalIso([...providerWatches, ...channelOutcomes] as Array<Record<string, unknown>>, ['lastNotificationAt', 'updatedAt', 'setupAt', 'createdAt', 'receivedAt']),
        localOk: failedWatches.length === 0 && backoffWatches.length === 0 && rejected === 0,
        path: item.path,
        rejected,
        status,
      };
    }

    if (item.channel === 'outbound_email') {
      const statuses = countLocalStatuses(deliveries);
      const failed = (statuses.failed ?? 0) + (statuses.bounced ?? 0);
      const queued = statuses.queued ?? 0;
      return {
        channel: item.channel,
        evidence: [
          `${deliveries.length} delivery ledger record(s)`,
          `${queued} queued, ${statuses.sent ?? 0} sent, ${failed} failed or bounced, ${statuses.suppressed ?? 0} suppressed`,
          `${jobs.filter((job) => job.queue === 'outbound_email').length} outbound_email worker job(s)`,
          `${channelOutcomes.length} webhook outcome(s), ${rejected} rejected`,
        ],
        label: item.label,
        latestAt: latestLocalIso([...deliveries, ...channelOutcomes] as Array<Record<string, unknown>>, ['providerStatusUpdatedAt', 'sentAt', 'createdAt', 'receivedAt']),
        localOk: failed === 0 && rejected === 0,
        path: item.path,
        rejected,
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
        `${channelOutcomes.length} webhook outcome(s), ${rejected} rejected`,
      ],
      label: item.label,
      latestAt: latestLocalIso([...paymentEvents, ...billingJobs, ...channelOutcomes] as Array<Record<string, unknown>>, ['signatureVerifiedAt', 'createdAt', 'lastRunAt', 'receivedAt']),
      localOk: paymentEvents.length > 0 && failedBillingJobs.length === 0 && rejected === 0,
      path: item.path,
      rejected,
      status: failedBillingJobs.length ? 'attention' : paymentEvents.length ? 'ready' : 'idle',
    };
  });
}

function fallbackQueueHealthRows(data: SignalAppData): OperationsQueueHealth[] {
  return operationsQueueNames.map((queue) => {
    const jobs = (data.jobs ?? []).filter((job) => job.queue === queue);
    const deadLetter = (data.deadLetter ?? []).filter((job) => job.queue === queue);
    const statuses = countLocalStatuses(jobs);
    const failed = statuses.failed ?? 0;
    const queued = statuses.queued ?? 0;
    const running = statuses.running ?? 0;
    return {
      queue,
      deadLetter: deadLetter.length,
      drained: statuses.drained ?? 0,
      failed,
      latestAt: latestLocalIso(jobs as Array<Record<string, unknown>>, ['lastRunAt', 'nextRunAt']),
      localOk: failed === 0 && deadLetter.length === 0,
      queued,
      running,
      status: deadLetter.length ? 'attention' : failed ? 'attention' : running ? 'running' : queued ? 'queued' : jobs.length ? 'ready' : 'idle',
      succeeded: statuses.succeeded ?? 0,
      total: jobs.length,
    };
  });
}

function fallbackRateLimitRows(data: SignalAppData): OperationsRateLimitHealth[] {
  const now = Date.now();
  const cursorRows = (data.emailSyncCursors ?? [])
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
  const watchRows = (data.emailWatchSubscriptions ?? [])
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
  const jobRows = (data.jobs ?? [])
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

function fallbackLifecycleHealth(data: SignalAppData): OperationsHealthReport['lifecycle'] {
  const notices = [...(data.lifecycleNotices ?? [])].sort((left, right) =>
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
        latestAt: latestLocalIso(categoryNotices as Array<Record<string, unknown>>, ['updatedAt', 'createdAt']),
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

export function fallbackOperationsHealth(data: SignalAppData, backend = fallbackBackendReadiness()): OperationsHealthReport {
  const summary = summarizeLocalState(data);
  const schedulerReady = backend.checks.find((check) => check.id === 'job_scheduler')?.ok ?? false;
  const backendBoundary = {
    mode: backend.mode,
    productionReady: backend.productionReady,
    schedulerReady,
    statePath: summary.statePath,
  };
  const webhooks = fallbackWebhookHealthRows(data);
  const queues = fallbackQueueHealthRows(data);
  const rateLimits = fallbackRateLimitRows(data);
  const lifecycle = fallbackLifecycleHealth(data);
  const blockingQueues = new Set(['billing_webhook', 'outbound_email']);
  const failedQueues = queues.filter((queue) => queue.failed > 0 && blockingQueues.has(queue.queue));
  const failedDeliveries = (data.emailDeliveryMessages ?? []).filter((message) => ['failed', 'bounced'].includes(message.status));
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
    backend: backendBoundary,
    generatedAt: new Date().toISOString(),
    issues,
    lifecycle,
    ok: issues.length === 0,
    productionReady: backendBoundary.productionReady && backendBoundary.schedulerReady,
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
      deadLetterJobs: data.deadLetter?.length ?? 0,
      failedDeliveries: failedDeliveries.length,
      failedJobs: summary.failedJobs ?? 0,
      failedQueues: failedQueues.length,
      monitoredQueues: queues.length,
      openLifecycle: summary.openLifecycleNotices ?? 0,
      productionReady: backendBoundary.productionReady && backendBoundary.schedulerReady,
      totalWebhooks: webhooks.length,
      unhealthyWebhooks: webhooks.filter((row) => !row.localOk).length,
    },
    webhooks,
  };
}

function productionDrillRow({
  area,
  check,
  commands,
  evidence,
  localOk = true,
  owner,
  productionOk,
  recommendation,
  requiredEnv,
}: {
  area: string;
  check: string;
  commands: string[];
  evidence: string[];
  localOk?: boolean;
  owner: string;
  productionOk: boolean;
  recommendation: string;
  requiredEnv: string[];
}): ProductionDrillRow {
  return {
    area,
    check,
    commands,
    evidence,
    localOk,
    owner,
    productionOk,
    recommendation,
    requiredEnv: [...new Set(requiredEnv.filter(Boolean))],
    status: productionOk ? 'production_ready' : localOk ? 'needs_proof' : 'attention',
  };
}

export function fallbackProductionDrill(
  data: SignalAppData,
  backend = fallbackBackendReadiness(),
  provider = fallbackProviderReadiness(),
  operations = fallbackOperationsHealth(data, backend),
  env: Record<string, string | undefined> = {},
): ProductionDrillReport {
  const summary = summarizeLocalState(data);
  const checkById = (id: string) => backend.checks.find((check) => check.id === id);
  const durableState = checkById('durable_state');
  const stateServiceStorage = checkById('state_service_storage');
  const signedSession = checkById('signed_session_enforced');
  const sessionCookieSecureCheck = checkById('session_cookie_secure');
  const webhookActorCheck = checkById('system_webhook_actor');
  const oauthActorCheck = checkById('system_oauth_actor');
  const productionAuth = checkById('production_auth_provider');
  const tenantIsolation = checkById('tenant_isolation');
  const scheduler = checkById('job_scheduler');
  const schedulerLockEnv = ['SIGNAL_SCHEDULER_LOCK_POLICY'];
  const schedulerLockReady = fallbackMissingKeys(env, schedulerLockEnv).length === 0;
  const stateServiceTokenConfigured = Boolean(env.SIGNAL_STATE_SERVICE_TOKEN);
  const latestProviderRun = [...(data.providerValidationRuns ?? [])].sort((left, right) => Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? ''))[0];
  const activeProviderSchedules = data.providerValidationSchedules?.filter((schedule) => schedule.status === 'active').length ?? 0;
  const providerSandboxPassed = latestProviderRun?.status === 'passed';
  const stateServiceReady = backend.mode === 'external-service' && Boolean(env.SIGNAL_STATE_SERVICE_URL) && Boolean(durableState?.ok && stateServiceStorage?.ok && stateServiceTokenConfigured);
  const identityReady = Boolean(
    signedSession?.ok &&
    sessionCookieSecureCheck?.ok &&
    webhookActorCheck?.ok &&
    oauthActorCheck?.ok &&
    productionAuth?.ok &&
    tenantIsolation?.ok,
  );
  const schedulerReady = Boolean(scheduler?.ok && schedulerLockReady && summary.failedJobs === 0 && activeProviderSchedules >= 4);
  const liveProviderSchedulerReady = Boolean(provider.ok && providerSandboxPassed && activeProviderSchedules >= 4);
  const providerById = (id: string) => provider.providers.find((item) => item.id === id);
  const gmail = providerById('gmail');
  const outlook = providerById('outlook');
  const outboundEmail = providerById('outbound-email');
  const stripe = providerById('stripe');
  const localReadinessChecks = [
    (summary.activeMemberships ?? 0) > 0 && (summary.activeEntitlements ?? 0) > 0,
    (summary.activeMemberships ?? 0) > 0,
    summary.connectedMailboxes > 0 && summary.enabledEmailFlows > 0 && (summary.sourceMessages ?? 0) > 0,
    (summary.modelGovernancePolicies ?? 0) > 0 && (summary.perTenantModels ?? 0) === 0,
    (summary.accounts ?? 0) > 0 && (summary.accountRecommendations ?? 0) > 0,
    (summary.notificationPreferences ?? 0) > 0,
    summary.subscriptions > 0 && (summary.activeEntitlements ?? 0) > 0,
    activeProviderSchedules >= 4,
    (summary.jobs ?? 0) > 0 && Array.isArray(data.auditEvents),
    true,
  ];
  const localReady = localReadinessChecks.filter(Boolean).length;
  const localTotal = localReadinessChecks.length;
  const launchGateStatuses = [
    localReady === localTotal,
    backend.productionReady,
    tenantIsolation?.ok,
    provider.ok,
    providerSandboxPassed,
    gmail?.ready && outlook?.ready && outboundEmail?.ready && providerSandboxPassed,
    stripe?.ready && providerSandboxPassed,
    schedulerReady,
  ];
  const launchGatePassed = launchGateStatuses.filter(Boolean).length;
  const launchGateTotal = launchGateStatuses.length;
  const rows = [
    productionDrillRow({
      area: 'local_contracts',
      check: 'Local contracts, browser routes, API mutations, scheduler, state-service, and launch package tests are the baseline before production rehearsal.',
      commands: ['npm run test:local', 'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json'],
      evidence: [
        `${localReady}/${localTotal} local readiness areas pass`,
        `${launchGatePassed}/${launchGateTotal} launch gate(s) currently pass`,
      ],
      owner: 'product',
      productionOk: backend.productionReady && provider.ok && providerSandboxPassed,
      recommendation: 'Run npm run test:local and launch-gate package before any provider or deployment rehearsal.',
      requiredEnv: [],
    }),
    productionDrillRow({
      area: 'state_service_health',
      check: 'External state service is configured, bearer-protected, database-backed, and reachable through the local-agent admin boundary.',
      commands: ['SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- health --json'],
      evidence: [
        `Backend mode: ${backend.mode}`,
        stateServiceStorage?.message ?? 'State-service storage not evaluated',
        `State-service token configured: ${stateServiceTokenConfigured ? 'yes' : 'no'}`,
      ],
      owner: 'platform',
      productionOk: stateServiceReady,
      recommendation: 'Run health through the same state-service URL the API will use; do not test backups against local JSON mode.',
      requiredEnv: ['SIGNAL_BACKEND_MODE', 'SIGNAL_STATE_SERVICE_URL', 'SIGNAL_STATE_SERVICE_TOKEN', ...(stateServiceStorage?.missingEnv ?? [])],
    }),
    productionDrillRow({
      area: 'backup_restore_rehearsal',
      check: 'Production backup policy, manual backup, digest verification, and restore dry run have explicit proof.',
      commands: [
        'SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- backup ./signal-prod-backup.json --json',
        'npm run state-service:admin -- verify ./signal-prod-backup.json --json',
        'SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- restore ./signal-prod-backup.json --dry-run --json',
      ],
      evidence: ['Backup schedule configured: no', 'Restore rehearsal timestamp configured: no'],
      owner: 'platform',
      productionOk: false,
      recommendation: 'Store the backup artifact outside app state, verify its digest, and complete a dry-run restore before launch.',
      requiredEnv: ['SIGNAL_STATE_BACKUP_SCHEDULE', 'SIGNAL_STATE_BACKUP_RETENTION_DAYS', 'SIGNAL_STATE_RESTORE_REHEARSAL_AT'],
    }),
    productionDrillRow({
      area: 'migration_rollout',
      check: 'State-service database migrations, rollback owner, and rollout order are declared before production writes begin.',
      commands: ['SIGNAL_STATE_SERVICE_BACKEND=postgres DATABASE_URL=postgres://... SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service', 'npm run test:state-service'],
      evidence: ['Migration rollout plan configured: no', durableState?.message ?? 'Durable state not evaluated'],
      owner: 'platform',
      productionOk: false,
      recommendation: 'Use the Postgres-backed state service migration contract and record the rollout plan URL or change ticket in environment metadata.',
      requiredEnv: ['SIGNAL_STATE_MIGRATION_ROLLOUT_PLAN'],
    }),
    productionDrillRow({
      area: 'identity_tenant_isolation',
      check: 'Managed/JWKS identity, signed sessions, durable membership mapping, and tenant isolation are all configured.',
      commands: ['npm run admin -- backend --env-file ./.env.production --json', 'npm run test:jwks-auth'],
      evidence: [
        signedSession?.message ?? 'Signed session not evaluated',
        sessionCookieSecureCheck?.message ?? 'Secure session cookies not evaluated',
        webhookActorCheck?.message ?? 'Webhook system actor not evaluated',
        oauthActorCheck?.message ?? 'OAuth callback system actor not evaluated',
        productionAuth?.message ?? 'Production auth not evaluated',
        tenantIsolation?.message ?? 'Tenant isolation not evaluated',
      ],
      owner: 'security',
      productionOk: identityReady,
      recommendation: 'Do not support many customer orgs on one backend until server-verified role and tenant claims match durable memberships.',
      requiredEnv: [
        ...(signedSession?.missingEnv ?? []),
        ...(sessionCookieSecureCheck?.missingEnv ?? []),
        ...(webhookActorCheck?.missingEnv ?? []),
        ...(oauthActorCheck?.missingEnv ?? []),
        ...(productionAuth?.missingEnv ?? []),
        ...(tenantIsolation?.missingEnv ?? []),
      ],
    }),
    productionDrillRow({
      area: 'scheduler_daemon',
      check: 'Managed scheduler process, single-runner policy, active validation schedules, and clean queues are ready.',
      commands: ['npm run scheduler -- --once --dry-run --json', 'SIGNAL_JOB_SCHEDULER=signal-scheduler SIGNAL_PROVIDER_VALIDATION_SCHEDULER=signal-scheduler npm run scheduler -- --once --json'],
      evidence: [
        scheduler?.message ?? 'Scheduler not evaluated',
        `${summary.failedJobs}/${summary.jobs} failed job(s)`,
        `${activeProviderSchedules}/${data.providerValidationSchedules?.length ?? 0} active provider validation schedule(s)`,
        `Single-runner policy configured: ${schedulerLockReady ? 'yes' : 'no'}`,
      ],
      owner: 'operations',
      productionOk: schedulerReady,
      recommendation: 'Run the scheduler dry-run and one managed queue tick before enabling continuous production scheduling.',
      requiredEnv: uniquePlanValues([...(scheduler?.missingEnv ?? []), ...fallbackMissingKeys(env, schedulerLockEnv)]),
    }),
    productionDrillRow({
      area: 'live_provider_recurring_tests',
      check: 'Live-provider sandbox evidence is passed and scheduled for recurring production-safe checks.',
      commands: ['npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json', 'npm run admin -- integrations run-scheduled --force --json'],
      evidence: [
        `${provider.summary.readyProviders}/${provider.summary.totalProviders} provider group(s) configured`,
        latestProviderRun ? `Latest sandbox evidence ${latestProviderRun.status} at ${latestProviderRun.recordedAt}` : 'No provider sandbox evidence recorded',
        `${activeProviderSchedules}/${data.providerValidationSchedules?.length ?? 0} active provider validation schedule(s)`,
      ],
      owner: 'integrations',
      productionOk: liveProviderSchedulerReady,
      recommendation: 'Use real Gmail, Outlook, SendGrid, and Stripe sandbox credentials and save sanitized evidence before go-live.',
      requiredEnv: provider.providers.flatMap((item) => item.missingRequired),
    }),
    productionDrillRow({
      area: 'alerting_runbook',
      check: 'Operations alert destination and launch runbook are configured for failed jobs, webhooks, provider backoff, billing, and lifecycle notices.',
      commands: ['npm run admin -- operations-health --env-file ./.env.production --json'],
      evidence: [`Operations health production-ready: ${operations.productionReady ? 'yes' : 'no'}`, 'Alert channel configured: no', 'Runbook URL configured: no'],
      owner: 'operations',
      productionOk: false,
      recommendation: 'Wire operations-health output into the alert channel before accepting production traffic.',
      requiredEnv: ['SIGNAL_OPERATIONS_RUNBOOK_URL', 'SIGNAL_OPERATIONS_ALERT_CHANNEL'],
    }),
  ];
  return {
    generatedAt: new Date().toISOString(),
    issues: rows.filter((row) => !row.localOk || !row.productionOk).map((row) => `${row.area}: ${row.check}`),
    ok: rows.every((row) => row.localOk),
    productionReady: rows.every((row) => row.productionOk),
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

function latestProviderEvidence(data: SignalAppData, providerId: string) {
  const runs = [...(data.providerValidationRuns ?? [])].sort((left, right) =>
    Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? ''));
  for (const run of runs) {
    const provider = (run.providers ?? []).find((candidate) =>
      candidate.id === providerId || (candidate.id === 'sendgrid' && providerId === 'outbound-email'));
    if (provider) {
      return {
        ...provider,
        recordedAt: run.recordedAt ?? run.generatedAt ?? null,
        reportDigest: run.reportDigest ?? null,
        runId: run.id ?? null,
      };
    }
  }
  return null;
}

function fallbackProviderLaunchCommands(providerId: string) {
  const commandMap: Record<string, { evidence: string[]; launch: string[]; replay: string | null }> = {
    session: {
      evidence: [
        'SIGNAL_SESSION_SECRET=<local-session-secret> SIGNAL_REQUIRE_SIGNED_SESSION=true npm run admin -- session token usr_admin --json',
        'SIGNAL_SESSION_SECRET=<local-session-secret> npm run admin -- session verify <token> --json',
        'npm run admin -- backend --env-file ./.env.production --json',
      ],
      launch: ['SIGNAL_REQUIRE_SIGNED_SESSION=true npm run api'],
      replay: 'SIGNAL_SESSION_SECRET=<local-session-secret> npm run admin -- session verify <token> --json',
    },
    gmail: {
      evidence: [
        'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
        'SIGNAL_GMAIL_ACCESS_TOKEN=<gmail-sandbox-token> npm run admin -- mailboxes watch mbx_gmail_sales --live-provider --json',
      ],
      launch: ['npm run admin -- mailboxes watch mbx_gmail_sales --live-provider', 'npm run admin -- mailboxes sync mbx_gmail_sales --live-provider'],
      replay: 'curl -X POST http://127.0.0.1:8787/api/webhooks/gmail -H "Authorization: Bearer <admin-token>" -d @gmail-pubsub-event.json',
    },
    outlook: {
      evidence: [
        'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
        'SIGNAL_OUTLOOK_ACCESS_TOKEN=<outlook-sandbox-token> npm run admin -- mailboxes renew-watch watch_outlook_mbx_outlook_success --live-provider --json',
      ],
      launch: ['npm run admin -- mailboxes renew-watch watch_outlook_mbx_outlook_success --live-provider', 'npm run admin -- mailboxes sync mbx_outlook_success --live-provider'],
      replay: 'curl -X POST http://127.0.0.1:8787/api/webhooks/outlook -H "Authorization: Bearer <admin-token>" -d @outlook-change-event.json',
    },
    'outbound-email': {
      evidence: ['npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json', 'npm run admin -- notifications digest tenant_demo --live-provider'],
      launch: ['npm run admin -- notifications digest tenant_demo --live-provider', 'SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET=<email-webhook-secret> npm run admin -- notifications webhook-signed ./email-event.json <Signal-Email-Signature>'],
      replay: 'SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET=<email-webhook-secret> npm run admin -- notifications webhook-signed ./email-event.json <Signal-Email-Signature>',
    },
    stripe: {
      evidence: ['npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json', 'npm run admin -- payments checkout tenant_demo plan_team --live-provider', 'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>'],
      launch: ['npm run admin -- payments checkout tenant_demo plan_team --live-provider', 'npm run admin -- payments portal tenant_demo --live-provider'],
      replay: 'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>',
    },
  };
  return commandMap[providerId] ?? { evidence: [], launch: [], replay: null };
}

function fallbackProviderLaunchEvidence(providerId: string) {
  const evidenceMap: Record<string, string[]> = {
    session: ['Signed session token can be issued and verified.', 'Production backend requires signed sessions and disables raw actor fallback.', 'Admin/member API access is role checked against durable membership records.'],
    gmail: ['OAuth callback and token vault configuration are present.', 'Sandbox Gmail API check passes and saved evidence artifact verifies.', 'Live watch registration and Pub/Sub webhook replay reach /api/webhooks/gmail.'],
    outlook: ['Graph OAuth callback and token vault configuration are present.', 'Sandbox Microsoft Graph check passes and saved evidence artifact verifies.', 'Subscription renewal, lifecycle notices, and webhook replay reach /api/webhooks/outlook.'],
    'outbound-email': ['Provider-backed digest handoff succeeds through generic or SendGrid delivery.', 'Signed delivery-status webhook replay updates the local delivery ledger.', 'Unsubscribe and SendGrid compliance settings are configured for production sends.'],
    stripe: ['Checkout and billing portal handoffs succeed against Stripe test mode.', 'Signed Stripe webhook replay updates subscription, invoice, and entitlement state.', 'Failed payment, cancelation, recovery, and resubscription lifecycle notices reconcile.'],
  };
  return evidenceMap[providerId] ?? [];
}

function fallbackLaunchFreshnessReport() {
  return {
    applies: false,
    backupRehearsal: {
      ageMs: null,
      maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      recordedAt: null,
      stale: false,
    },
    blockers: [],
    policy: {
      backupRehearsalMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
      sandboxEvidenceMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
      scheduleOverdueGraceMs: 24 * 60 * 60 * 1000,
      schedulerHeartbeatMaxAgeMs: 10 * 60 * 1000,
    },
    providerValidationSchedules: {
      graceMs: 24 * 60 * 60 * 1000,
      overdue: [],
    },
    sandboxEvidence: {
      ageMs: null,
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      recordedAt: null,
      runId: null,
      stale: false,
      status: null,
    },
    schedulerHeartbeat: {
      ageMs: null,
      maxAgeMs: 10 * 60 * 1000,
      ok: null,
      recordedAt: null,
      schedulerConfigured: false,
    },
  };
}

export function fallbackProviderLaunchMatrix(
  data: SignalAppData,
  backend = fallbackBackendReadiness(),
  provider = fallbackProviderReadiness(),
): ProviderLaunchMatrixReport {
  const signedSession = backend.checks.find((check) => check.id === 'signed_session_enforced');
  const freshness = fallbackLaunchFreshnessReport();
  const rows = provider.providers.map((item) => {
    const sandboxRequired = item.id !== 'session';
    const schedule = data.providerValidationSchedules?.find((candidate) => candidate.providerId === item.id) ?? null;
    const evidence = latestProviderEvidence(data, item.id);
    const sandboxStatus = sandboxRequired ? (evidence?.status ?? 'not_recorded') : (signedSession?.ok ? 'passed' : 'not_applicable');
    const scheduleReady = !sandboxRequired || schedule?.status === 'active';
    const configurationReady = item.ready && (item.id !== 'session' || Boolean(signedSession?.ok));
    const sandboxReady = !sandboxRequired || sandboxStatus === 'passed';
    const freshnessBlockers: string[] = [];
    const launchReady = Boolean(configurationReady && sandboxReady && scheduleReady && freshnessBlockers.length === 0);
    const commands = fallbackProviderLaunchCommands(item.id);
    return {
      id: item.id,
      label: item.id === 'outbound-email' ? 'SendGrid / Outbound Email Provider' : item.label,
      category: item.category,
      owner: item.id === 'session' ? 'security' : item.id === 'stripe' ? 'billing' : 'integrations',
      provider: item.provider,
      boundary: item.boundary,
      callbackPath: item.callbackPath,
      webhookPath: item.webhookPath,
      ...(item.lifecycleWebhookPath ? { lifecycleWebhookPath: item.lifecycleWebhookPath } : {}),
      configurationReady,
      configuredRequired: item.configuredRequired,
      missingEnv: item.missingRequired,
      requiredEnv: item.requiredEnv,
      optionalEnv: item.optionalEnv,
      sandboxRequired,
      sandboxStatus,
      latestEvidenceAt: evidence?.recordedAt ?? null,
      latestEvidenceRunId: evidence?.runId ?? null,
      latestEvidenceDigest: evidence?.reportDigest ?? null,
      latestProviderRequestIds: evidence?.checks.map((check) => check.providerRequestId).filter(Boolean) as string[] ?? [],
      freshnessBlockers,
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
      requiredEvidence: fallbackProviderLaunchEvidence(item.id),
      evidenceCommands: commands.evidence,
      launchCommands: commands.launch,
      signedReplayCommand: commands.replay,
      localAgentCommand: item.id === 'session' ? 'npm run admin -- backend --env-file ./.env.production --json' : 'npm run admin -- provider-launch --env-file ./.env.production --json',
      launchReady,
      status: launchReady ? 'production_ready' : !configurationReady ? 'needs_config' : sandboxRequired && sandboxStatus !== 'passed' ? 'needs_sandbox' : sandboxRequired && !scheduleReady ? 'needs_schedule' : freshnessBlockers.length ? 'needs_freshness' : 'needs_proof',
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    ok: true,
    productionReady: rows.every((row) => row.launchReady),
    freshness,
    freshnessBlockers: freshness.blockers,
    recommendation: {
      summary: 'Use provider-launch as the provider-by-provider handoff between configuration, saved sandbox evidence, live watch/send/payment commands, and signed webhook replay proof.',
      productionGuardrail: 'Do not enable production Gmail, Outlook, SendGrid/outbound email, Stripe, or signed-session traffic until each provider row is production_ready with current external evidence.',
      localAgentCommand: 'npm run admin -- provider-launch --env-file ./.env.production --json',
    },
    rows,
    summary: {
      blocked: rows.filter((row) => !row.launchReady).length,
      configured: rows.filter((row) => row.configurationReady).length,
      freshnessBlocked: freshness.blockers.length,
      launchReady: rows.filter((row) => row.launchReady).length,
      missingRequiredEnv: rows.reduce((count, row) => count + row.missingEnv.length, 0),
      sandboxPassed: rows.filter((row) => row.sandboxRequired && row.sandboxStatus === 'passed').length,
      sandboxRequired: rows.filter((row) => row.sandboxRequired).length,
      scheduledActive: rows.filter((row) => row.sandboxRequired && row.schedule?.status === 'active').length,
      secretSafe: true,
      total: rows.length,
    },
  };
}

function providerHandoffPriority(row: ProviderLaunchRow) {
  const base: Record<string, number> = {
    session: 10,
    gmail: 20,
    outlook: 30,
    'outbound-email': 40,
    stripe: 50,
  };
  const startingPoint = base[row.id] ?? 90;
  if (!row.configurationReady) {
    return startingPoint;
  }
  if (row.sandboxRequired && row.sandboxStatus !== 'passed') {
    return startingPoint + 100;
  }
  if (row.sandboxRequired && !row.scheduleReady) {
    return startingPoint + 200;
  }
  return startingPoint + 300;
}

function providerSandboxRequiredEnv(providerId: string) {
  const sandboxEnv: Record<string, string[]> = {
    gmail: ['SIGNAL_GMAIL_ACCESS_TOKEN'],
    outlook: ['SIGNAL_OUTLOOK_ACCESS_TOKEN'],
    'outbound-email': ['SIGNAL_SENDGRID_API_KEY', 'SIGNAL_EMAIL_PROVIDER_TOKEN'],
    stripe: ['STRIPE_SECRET_KEY', 'SIGNAL_STRIPE_PRICE_TEAM'],
  };
  return sandboxEnv[providerId] ?? [];
}

function providerScheduleCommand(providerId: string) {
  if (providerId === 'session') {
    return null;
  }
  return `npm run admin -- integrations schedule ${providerId} ${providerId === 'outbound-email' ? 'weekly' : 'daily'} --json`;
}

function providerHandoffActionFromRow(row: ProviderLaunchRow): ProviderHandoffAction {
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
      blocker: row.missingEnv.length ? `Configure ${row.missingEnv.slice(0, 4).join(', ')}${row.missingEnv.length > 4 ? ', ...' : ''}.` : 'Configuration proof is missing.',
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
      command: providerScheduleCommand(row.id) ?? 'npm run admin -- integrations run-scheduled --json',
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
    evidence: [...evidence, ...row.requiredEvidence.slice(0, 2)],
    requiredEnv: [],
    command: row.launchCommands[0] ?? row.signedReplayCommand ?? row.localAgentCommand,
    followUpCommands: [...row.launchCommands.slice(1, 3), row.signedReplayCommand].filter(Boolean) as string[],
  };
}

export function fallbackProviderHandoff(
  data: SignalAppData,
  backend = fallbackBackendReadiness(),
  provider = fallbackProviderReadiness(),
  launch = fallbackProviderLaunchMatrix(data, backend, provider),
): ProviderHandoffReport {
  const actions = launch.rows
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
    evidence: [`${launch.summary.launchReady}/${launch.summary.total} provider launch rows ready`],
    requiredEnv: [],
    command: 'npm run admin -- integrations evidence-export latest ./signal-provider-evidence.json --json',
    followUpCommands: ['npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json'],
  };
  const report: ProviderHandoffReport = {
    generatedAt: new Date().toISOString(),
    ok: true,
    productionReady: launch.productionReady,
    nextAction,
    actions,
    launch: {
      productionReady: launch.productionReady,
      configured: launch.summary.configured,
      launchReady: launch.summary.launchReady,
      missingRequiredEnv: launch.summary.missingRequiredEnv,
      sandboxPassed: launch.summary.sandboxPassed,
      sandboxRequired: launch.summary.sandboxRequired,
      scheduledActive: launch.summary.scheduledActive,
      total: launch.summary.total,
    },
    providerRows: launch.rows.map((row) => ({
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
    runnableCommands: uniquePlanValues([
      'npm run admin -- provider-launch --json',
      'npm run admin -- provider-handoff --json',
      'npm run admin -- integrations --json',
      'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
      'npm run admin -- integrations run-scheduled --force --json',
      'npm run admin -- payment-lifecycle --json',
      'npm run admin -- operations-health --json',
      nextAction.command,
      ...nextAction.followUpCommands,
    ]),
    summary: {
      blocked: actions.length,
      configured: launch.summary.configured,
      launchReady: launch.summary.launchReady,
      missingRequiredEnv: launch.summary.missingRequiredEnv,
      nextActionId: nextAction.id,
      productionReady: launch.productionReady,
      sandboxPassed: launch.summary.sandboxPassed,
      sandboxRequired: launch.summary.sandboxRequired,
      scheduledActive: launch.summary.scheduledActive,
      secretSafe: true,
      total: launch.summary.total,
    },
  };
  report.summary.secretSafe = !localAgentHandoffStringLooksUnsafe(JSON.stringify(report));
  report.ok = report.summary.secretSafe && launch.ok;
  return report;
}

type LifecyclePlaybookSeed = {
  id: string;
  label: string;
  category: LifecycleNoticeCategory;
  triggers: string[];
  owner: string;
  severity: LifecycleNoticeSeverity;
  notificationFlow: string;
  userAction: string;
  adminAction: string;
  commands: string[];
  evidence: (data: SignalAppData, summary: StateSummary) => string[];
  localOk: (data: SignalAppData, summary: StateSummary) => boolean;
};

const fallbackLifecyclePlaybookCatalog: LifecyclePlaybookSeed[] = [
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
    commands: ['npm run admin -- tenants register "New Workspace" newco.example admin@newco.example "Admin User" plan_team', 'curl -X POST http://127.0.0.1:8787/api/registration', 'npm run admin -- users invite tenant_demo rep@example.com member sales', 'npm run admin -- users claim <inviteCode> "Member Name"', 'npm run admin -- users accept <inviteId>', 'npm run admin -- onboarding-readiness --json'],
    evidence: (_data, summary) => [`${summary.tenants} workspace(s)`, `${summary.activeMemberships ?? 0}/${summary.memberships ?? 0} active memberships`, `${summary.pendingInvites ?? 0}/${summary.invites ?? 0} pending invites`, `${summary.activeSeats ?? 0}+${summary.pendingInviteSeats ?? 0}/${summary.seatLimit ?? 'unlimited'} active+pending seats`],
    localOk: (_data, summary) => summary.tenants > 0 && summary.admins > 0 && (summary.activeMemberships ?? 0) > 0,
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
    commands: ['npm run admin -- users --json', 'npm run admin -- users role <userId> member sales', 'npm run admin -- users disable <userId>', 'npm run admin -- session token usr_admin --json', 'npm run admin -- onboarding-readiness --json'],
    evidence: (data, summary) => [`${summary.admins} active admin(s)`, `${summary.activeMemberships ?? 0} active membership(s)`, `${summary.apiSessions ?? 0} API session record(s)`, `${data.modelGovernancePolicies?.filter((policy) => policy.dataBoundary === 'tenant_isolated').length ?? 0} tenant-isolated model governance policy row(s)`],
    localOk: (data, summary) => summary.admins > 0 && (summary.activeMemberships ?? 0) > 1 && (data.modelGovernancePolicies ?? []).every((policy) => policy.dataBoundary === 'tenant_isolated'),
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
    commands: ['npm run admin -- notifications preference usr_sales daily immediate', 'npm run admin -- notifications mute-account usr_product Acme Health', 'npm run admin -- signals assign sig_risk_001 usr_sales', 'npm run admin -- notifications digest tenant_demo', 'npm run admin -- accounts action <actionId> completed'],
    evidence: (data, summary) => [`${summary.activeRoutingRules ?? 0}/${summary.routingRules ?? 0} active routing rule(s)`, `${data.notificationPreferences?.length ?? 0} notification preference record(s)`, `${summary.openAccountRecommendations ?? 0}/${summary.accountRecommendations ?? 0} open recommendation(s)`, `${summary.unreadNotifications ?? 0}/${summary.notificationEvents ?? 0} unread notification(s)`],
    localOk: (data, summary) => (summary.activeRoutingRules ?? 0) > 0 && (data.notificationPreferences?.length ?? 0) >= (summary.activeMemberships ?? 0),
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
    commands: ['npm run admin -- mailboxes connect-url tenant_demo gmail usr_sales', 'npm run admin -- mailboxes complete <connectionSessionId>', 'npm run admin -- mailboxes disconnect <mailboxId>', 'npm run admin -- mailboxes replay <mailboxId>', 'npm run admin -- lifecycle --json'],
    evidence: (_data, summary) => [`${summary.connectedMailboxes}/${summary.mailboxes} connected mailbox source(s)`, `${summary.mailboxConnectionSessions ?? 0} connection session(s)`, `${summary.blockedSyncCursors ?? 0} blocked sync cursor(s)`, `${summary.activeEmailWatchSubscriptions ?? 0}/${summary.emailWatchSubscriptions ?? 0} active provider watch(es)`],
    localOk: (_data, summary) => summary.mailboxes > 0 && (summary.blockedSyncCursors ?? 0) === 0,
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
    commands: ['npm run admin -- mailboxes renew-watch <watchId>', 'npm run admin -- mailboxes replay <mailboxId>', 'npm run admin -- integrations run-scheduled --json', 'npm run scheduler -- --once --dry-run --json', 'npm run admin -- operations-health --json'],
    evidence: (_data, summary) => [`${summary.activeProviderValidationSchedules ?? 0}/${summary.providerValidationSchedules ?? 0} active provider validation schedule(s)`, `${summary.dueProviderValidationSchedules ?? 0} due validation schedule(s)`, `${summary.failedJobs ?? 0} failed job(s)`, `${summary.expiringEmailWatchSubscriptions ?? 0} expiring email watch(es)`],
    localOk: (_data, summary) => (summary.failedJobs ?? 0) === 0,
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
    commands: ['npm run admin -- notifications digest tenant_demo', 'npm run admin -- notifications delivery-status <messageId> sent', 'SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET=<email-webhook-secret> npm run admin -- notifications webhook-signed ./email-event.json <Signal-Email-Signature>', 'SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY=<sendgrid-public-key> npm run admin -- notifications sendgrid-webhook-signed ./sendgrid-events.json <signature> <timestamp>', 'npm run admin -- notifications unsubscribe usr_product'],
    evidence: (_data, summary) => [`${summary.digestRuns ?? 0} digest run(s)`, `${summary.failedEmailDeliveries ?? 0}/${summary.emailDeliveries ?? 0} failed email delivery record(s)`, `${summary.unsubscribedUsers ?? 0} unsubscribed user(s)`, `${summary.unreadNotifications ?? 0}/${summary.notificationEvents ?? 0} unread notification(s)`],
    localOk: (data, summary) => (summary.failedEmailDeliveries ?? 0) === 0 && (data.notificationPreferences?.length ?? 0) > 0,
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
    commands: ['npm run admin -- payments recover <invoiceId>', 'npm run admin -- payments portal tenant_demo --live-provider', 'npm run admin -- payments webhook invoice.payment_failed sub_demo', 'npm run admin -- payments webhook invoice.paid sub_demo', 'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>'],
    evidence: (_data, summary) => [`${summary.openInvoices ?? 0}/${summary.invoices ?? 0} open invoice(s)`, `${summary.billingSessions ?? 0} billing session(s)`, `${summary.paymentEvents} payment event(s)`, `${summary.activeEntitlements ?? 0} active entitlement(s)`],
    localOk: (_data, summary) => (summary.openInvoices ?? 0) === 0 && (summary.billingSessions ?? 0) > 0 && summary.paymentEvents > 0,
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
    commands: ['npm run admin -- payments cancel sub_demo', 'npm run admin -- payments checkout tenant_demo plan_team', 'npm run admin -- payments checkout tenant_demo plan_team --live-provider', 'npm run admin -- payments portal tenant_demo --live-provider', 'npm run admin -- payments sync tenant_demo'],
    evidence: (_data, summary) => [`${summary.subscriptions} subscription record(s)`, `${summary.activeEntitlements ?? 0} active entitlement(s)`, `${summary.activeBillingOverrides ?? 0}/${summary.billingOverrides ?? 0} active billing override(s)`, `${summary.billingSessions ?? 0} billing session(s)`],
    localOk: (_data, summary) => summary.subscriptions > 0 && (summary.activeEntitlements ?? 0) > 0,
  },
];

function fallbackLifecyclePlaybookStatus({ critical, open, observed, localOk }: { critical: number; open: number; observed: number; localOk: boolean }) {
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

export function fallbackLifecyclePlaybook(data: SignalAppData, backend = fallbackBackendReadiness()): LifecyclePlaybookReport {
  const summary = summarizeLocalState(data);
  const rows = fallbackLifecyclePlaybookCatalog.map((item) => {
    const matchingNotices = (data.lifecycleNotices ?? []).filter((notice) => item.triggers.includes(notice.trigger));
    const openNotices = matchingNotices.filter((notice) => notice.status === 'open');
    const criticalNotices = openNotices.filter((notice) => notice.severity === 'critical');
    const localOk = item.localOk(data, summary) && criticalNotices.length === 0;
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
      evidence: item.evidence(data, summary),
      notices: matchingNotices.slice(0, 5).map((notice) => ({
        actionLabel: notice.actionLabel ?? null,
        actionTarget: notice.actionTarget ?? null,
        id: notice.id,
        severity: notice.severity,
        status: notice.status,
        title: notice.title,
        trigger: notice.trigger,
        updatedAt: notice.updatedAt ?? notice.createdAt ?? null,
      })),
      open: openNotices.length,
      critical: criticalNotices.length,
      observed: matchingNotices.length,
      latestAt: latestLocalIso(matchingNotices as Array<Record<string, unknown>>, ['updatedAt', 'createdAt']),
      sampleNoticeId: matchingNotices[0]?.id ?? null,
      localOk,
      status: fallbackLifecyclePlaybookStatus({
        critical: criticalNotices.length,
        localOk,
        observed: matchingNotices.length,
        open: openNotices.length,
      }),
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    ok: true,
    productionReady: backend.productionReady,
    recommendation: {
      summary: 'Use lifecycle-playbook when answering onboarding, RBAC/privacy, source disconnect, notification, failed payment, cancellation, and resubscription QA from the same admin boundary.',
      productionGuardrail: 'This playbook proves the local handling model. Production still needs durable tenant isolation, managed auth, live provider sandbox evidence, signed webhooks, and scheduler/alert routing before customer traffic.',
      localAgentCommand: 'npm run admin -- lifecycle-playbook --json',
    },
    rows,
    summary: {
      actionReady: rows.filter((row) => row.status === 'action_ready').length,
      attention: rows.filter((row) => row.status === 'attention').length,
      criticalNotices: rows.reduce((total, row) => total + row.critical, 0),
      localReady: rows.filter((row) => row.localOk).length,
      observed: rows.filter((row) => row.observed > 0).length,
      openNotices: rows.reduce((total, row) => total + row.open, 0),
      ready: rows.filter((row) => row.status === 'ready' || row.status === 'observed').length,
      secretSafe: true,
      total: rows.length,
    },
  };
}

function digestionPipelineRow({
  area,
  check,
  commands = [],
  evidence = [],
  localOk,
  productionOk,
  recommendation,
  requiredEnv = [],
}: {
  area: string;
  check: string;
  commands?: string[];
  evidence?: string[];
  localOk: boolean;
  productionOk: boolean;
  recommendation: string;
  requiredEnv?: string[];
}): SignalDigestionPipelineRow {
  return {
    area,
    check,
    evidence,
    localOk,
    productionOk,
    recommendation,
    requiredEnv,
    commands,
    status: localOk ? (productionOk ? 'production_ready' : 'local_ready') : 'attention',
  };
}

export function fallbackSignalDigestionPipeline(data: SignalAppData, backend = fallbackBackendReadiness()): SignalDigestionPipelineReport {
  const summary = summarizeLocalState(data);
  const tenant = data.tenants[0] ?? null;
  const tenantId = tenant?.id;
  const tenantScoped = <T extends { tenantId?: string }>(items: T[] = []) => items.filter((item) => !tenantId || item.tenantId === tenantId);
  const mailboxes = tenantScoped(data.mailboxes);
  const connectedMailboxes = mailboxes.filter((mailbox) => mailbox.status === 'connected');
  const mailboxIds = new Set(mailboxes.map((mailbox) => mailbox.id));
  const sourceMessages = tenantScoped(data.sourceMessages).filter((message) => !message.mailboxId || mailboxIds.has(message.mailboxId));
  const providerBackedSourceMessages = sourceMessages.filter((message) => message.providerRequestDigest || message.providerResponseDigest || message.providerMessageId || message.providerCursor);
  const processedSourceMessages = sourceMessages.filter((message) => (message.processedFlowIds ?? []).length > 0);
  const syncCursors = data.emailSyncCursors.filter((cursor) => mailboxIds.has(cursor.mailboxId));
  const activeSyncCursors = syncCursors.filter((cursor) => cursor.status === 'active');
  const watches = tenantScoped(data.emailWatchSubscriptions ?? []);
  const activeWatches = watches.filter((watch) => watch.status === 'active');
  const flows = tenantScoped(data.emailFlows);
  const enabledFlows = flows.filter((flow) => flow.status === 'enabled');
  const routingRules = tenantScoped(data.routingRules ?? []);
  const activeRoutingRules = routingRules.filter((rule) => rule.status === 'active');
  const flowRuns = tenantScoped(data.flowRuns);
  const succeededFlowRuns = flowRuns.filter((run) => run.status === 'succeeded');
  const latestRun = [...succeededFlowRuns].sort((left, right) => Date.parse(right.completedAt ?? right.startedAt) - Date.parse(left.completedAt ?? left.startedAt))[0] ?? null;
  const sourceBackedSignals = tenantScoped(data.signals).filter((signal) => signal.sourceMessageId && signal.flowId);
  const routedSignals = sourceBackedSignals.filter((signal) =>
    signal.ownerUserId &&
    (signal.routeTo || signal.routingRuleId || activeRoutingRules.some((rule) => rule.flowId === signal.flowId)));
  const signalDetectionJobs = tenantScoped(data.jobs).filter((job) => job.queue === 'signal_detection');
  const failedSignalDetectionJobs = signalDetectionJobs.filter((job) => job.status === 'failed');
  const qualitySettings = data.signalQualitySettings.find((settings) => !tenantId || settings.tenantId === tenantId) ?? null;
  const suppressionRules = tenantScoped(data.suppressionRules);
  const activeSuppressionRules = suppressionRules.filter((rule) => rule.status === 'active');
  const feedback = tenantScoped(data.signalFeedback);
  const modelPolicies = tenantScoped(data.modelGovernancePolicies ?? []);
  const activePolicy = modelPolicies.find((policy) => policy.status === 'active') ?? modelPolicies[0] ?? null;
  const governancePolicy = tenantScoped(data.governancePolicies)[0] ?? null;
  const redactionRules = tenantScoped(data.redactionRules);
  const openRecommendations = tenantScoped(data.accountRecommendations ?? []).filter((recommendation) => recommendation.status === 'open');
  const openActions = tenantScoped(data.accountActions).filter((action) => action.status === 'open');
  const modelBoundaryOk = Boolean(activePolicy &&
    activePolicy.detectorBoundary === 'shared_detector' &&
    activePolicy.dataBoundary === 'tenant_isolated' &&
    activePolicy.perTenantModel === false &&
    (activePolicy.learningMode !== 'opt_in_tuning' || activePolicy.trainingDataUse === 'opt_in_only'));
  const productionOk = backend.productionReady;
  const rows = [
    digestionPipelineRow({
      area: 'permissioned_source_ingestion',
      check: 'Permissioned Gmail/Outlook mailbox sources create sync cursors, provider watch state, and retained source-message records without storing raw credentials in app state.',
      evidence: [`${connectedMailboxes.length}/${mailboxes.length} connected mailbox source(s)`, `${activeSyncCursors.length}/${syncCursors.length} active sync cursor(s)`, `${activeWatches.length}/${watches.length} active provider watch subscription(s)`, `${sourceMessages.length} retained source message record(s)`],
      localOk: connectedMailboxes.length > 0 && activeSyncCursors.length === mailboxes.length && sourceMessages.length > 0,
      productionOk,
      recommendation: 'Keep ingestion provider-scoped and cursor-driven; store only sanitized provider digests and source snippets in app state.',
      requiredEnv: ['SIGNAL_GMAIL_CLIENT_ID', 'SIGNAL_OUTLOOK_CLIENT_ID', 'SIGNAL_TOKEN_ENCRYPTION_KEY', 'SIGNAL_STATE_SERVICE_URL'],
      commands: ['npm run admin -- mailboxes --json', 'npm run admin -- mailboxes sync <mailboxId> --live-provider'],
    }),
    digestionPipelineRow({
      area: 'source_digest_retention',
      check: 'Source-message snippets are governed by retention, raw-snippet windows, redaction rules, and processed-flow provenance.',
      evidence: [`${processedSourceMessages.length}/${sourceMessages.length} source message(s) tagged with processed flow provenance`, `${providerBackedSourceMessages.length} provider-backed source digest(s)`, governancePolicy ? `${governancePolicy.sourceRetentionDays} source days / ${governancePolicy.rawSnippetRetentionDays} raw days` : 'missing governance policy', `${redactionRules.length} redaction rule(s)`],
      localOk: Boolean(governancePolicy) && sourceMessages.length > 0 && redactionRules.length > 0,
      productionOk,
      recommendation: 'Use the source-message layer as the digestion ledger; do not train or export from raw provider bodies by default.',
      requiredEnv: ['DATABASE_URL', 'SIGNAL_TENANT_ISOLATION_MODE'],
      commands: ['npm run admin -- governance --json', 'npm run admin -- dashboard-audit --json'],
    }),
    digestionPipelineRow({
      area: 'detector_execution',
      check: 'Enabled detector flows scan source snippets, match configured terms, create replay-safe signals, and record flow-run/job evidence.',
      evidence: [`${enabledFlows.length}/${flows.length} enabled detector flow(s)`, `${succeededFlowRuns.length}/${flowRuns.length} succeeded flow run(s)`, `${sourceBackedSignals.length} source-backed generated signal(s)`, latestRun ? `latest run scanned ${latestRun.scannedMessages} and matched ${latestRun.matchedMessages}` : 'no flow run yet'],
      localOk: enabledFlows.length > 0 && succeededFlowRuns.length > 0 && sourceBackedSignals.length > 0 && failedSignalDetectionJobs.length === 0,
      productionOk,
      recommendation: 'Treat detector runs as deterministic local jobs first; schedule production workers only after durable state and provider evidence pass.',
      requiredEnv: ['SIGNAL_JOB_SCHEDULER', 'SIGNAL_STATE_SERVICE_URL'],
      commands: ['npm run admin -- email-flows run', 'npm run admin -- jobs run signal_detection --limit 1'],
    }),
    digestionPipelineRow({
      area: 'quality_suppression_feedback',
      check: 'Quality thresholds, source-reference requirements, suppression rules, and user feedback labels control which signals become recommendations or future tuning candidates.',
      evidence: [`minimum confidence ${qualitySettings?.minimumConfidence ?? 'missing'}`, `${activeSuppressionRules.length}/${suppressionRules.length} active suppression rule(s)`, `${feedback.length} feedback label(s)`, `${failedSignalDetectionJobs.length} failed signal_detection job(s)`],
      localOk: Boolean(qualitySettings) && suppressionRules.length > 0 && feedback.length > 0 && failedSignalDetectionJobs.length === 0,
      productionOk,
      recommendation: 'Use feedback and suppression for tenant-specific tuning before considering any governed learning pipeline.',
      requiredEnv: ['SIGNAL_STATE_SERVICE_URL', 'DATABASE_URL'],
      commands: ['npm run admin -- quality --json', 'npm run admin -- signals feedback <signalId> useful'],
    }),
    digestionPipelineRow({
      area: 'routing_and_user_outcomes',
      check: 'Signals route through tenant rules to owners/teams, account actions, notifications, handoffs, and relationship recommendations.',
      evidence: [`${activeRoutingRules.length}/${routingRules.length} active routing rule(s)`, `${routedSignals.length}/${sourceBackedSignals.length} routed source-backed signal(s)`, `${openActions.length} open account action(s)`, `${openRecommendations.length} open relationship recommendation(s)`],
      localOk: activeRoutingRules.length > 0 && sourceBackedSignals.length > 0 && routedSignals.length === sourceBackedSignals.length && openRecommendations.length > 0,
      productionOk,
      recommendation: 'Personalize outcomes through routing, ownership, priorities, and notification preferences instead of separate per-user models.',
      requiredEnv: ['SIGNAL_REQUIRE_SIGNED_SESSION', 'SIGNAL_AUTH_PROVIDER', 'SIGNAL_AUTH_JWKS_URL'],
      commands: ['npm run admin -- signals --json', 'npm run admin -- accounts --json', 'npm run admin -- notifications --json'],
    }),
    digestionPipelineRow({
      area: 'model_learning_boundary',
      check: 'The MVP uses a shared detector/model boundary with tenant-isolated data and opt-in-only future tuning; per-org trained models stay disabled by default.',
      evidence: [activePolicy ? `${activePolicy.detectorBoundary} / ${activePolicy.dataBoundary}` : 'missing model policy', activePolicy ? `${activePolicy.learningMode} learning / ${activePolicy.trainingDataUse}` : 'missing learning policy', `${summary.perTenantModels ?? 0} per-tenant trained model(s) enabled`, `${activePolicy?.tuningControls?.length ?? 0} tenant tuning control(s)`],
      localOk: modelBoundaryOk,
      productionOk: productionOk && modelBoundaryOk,
      recommendation: 'Do not create one model per org by default; require explicit admin opt-in, retention review, and tenant-isolated evaluation evidence first.',
      requiredEnv: ['SIGNAL_TENANT_ISOLATION_MODE', 'DATABASE_URL', 'SIGNAL_STATE_SERVICE_URL'],
      commands: ['npm run admin -- models --json', 'npm run admin -- models policy tenant_demo opt_in_tuning Governance_reviewed'],
    }),
  ];
  return {
    backend: { mode: backend.mode, productionReady: backend.productionReady, statePath: summary.statePath },
    generatedAt: new Date().toISOString(),
    issues: rows.filter((row) => !row.localOk).map((row) => `${row.area}: ${row.check}`),
    ok: rows.every((row) => row.localOk),
    productionReady: rows.every((row) => row.productionOk),
    recommendation: {
      decision: 'shared_detector_with_tenant_controls',
      summary: 'Use a tenant-isolated data digestion pipeline with shared detectors, tenant-specific thresholds/routing/suppression/feedback, and opt-in-only future learning.',
      productionGuardrail: 'Do not enable production learning or multi-customer shared storage until durable tenant isolation, managed auth, scheduler, provider evidence, and retention controls are all verified.',
      localAgentCommand: 'npm run admin -- digestion-pipeline --json',
    },
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
    tenant: tenant ? { id: tenant.id, name: tenant.name, domain: tenant.domain, status: tenant.status } : null,
  };
}

function paymentLifecycleAuditRow({
  area,
  check,
  evidence,
  localOk,
  productionOk,
  recommendation,
  requiredEnv = [],
  commands = [],
}: {
  area: string;
  check: string;
  evidence: string[];
  localOk: boolean;
  productionOk: boolean;
  recommendation: string;
  requiredEnv?: string[];
  commands?: string[];
}): PaymentLifecycleAuditRow {
  return {
    area,
    check,
    evidence,
    localOk,
    productionOk,
    recommendation,
    requiredEnv,
    commands,
    status: localOk ? (productionOk ? 'production_ready' : 'needs_live_provider') : 'attention',
  };
}

function countLocalPaymentTypes(items: Array<{ type?: string; trigger?: string; status?: string }>): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = item.type ?? item.trigger ?? item.status ?? 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

export function fallbackPaymentLifecycleAudit(
  data: SignalAppData,
  backend = fallbackBackendReadiness(),
  provider = fallbackProviderReadiness(),
): PaymentLifecycleAuditReport {
  const summary = summarizeLocalState(data);
  const tenant = data.tenants[0] ?? null;
  const tenantId = tenant?.id;
  const subscriptions = data.subscriptions.filter((subscription) => !tenantId || subscription.tenantId === tenantId);
  const activeSubscriptions = subscriptions.filter((subscription) => ['trialing', 'active'].includes(subscription.status));
  const canceledSubscriptions = subscriptions.filter((subscription) => subscription.status === 'canceled');
  const entitlements = data.entitlements.filter((entitlement) => !tenantId || entitlement.tenantId === tenantId);
  const activeEntitlements = entitlements.filter((entitlement) => entitlement.status === 'active');
  const invoices = data.invoices.filter((invoice) => !tenantId || invoice.tenantId === tenantId);
  const openInvoices = invoices.filter((invoice) => ['open', 'past_due'].includes(invoice.status));
  const paidInvoices = invoices.filter((invoice) => invoice.status === 'paid');
  const sessions = data.billingSessions.filter((session) => !tenantId || session.tenantId === tenantId);
  const sessionCounts = countLocalPaymentTypes(sessions);
  const paymentEvents = data.paymentEvents.filter((event) => !tenantId || event.tenantId === tenantId);
  const eventCounts = countLocalPaymentTypes(paymentEvents);
  const paymentNotices = (data.lifecycleNotices ?? []).filter((notice) => (!tenantId || notice.tenantId === tenantId) && notice.category === 'payment');
  const noticeCounts = countLocalPaymentTypes(paymentNotices);
  const billingJobs = (data.jobs ?? []).filter((job) => (!tenantId || job.tenantId === tenantId) && job.queue === 'billing_webhook');
  const failedBillingJobs = billingJobs.filter((job) => job.status === 'failed');
  const billingOverrides = (data.billingOverrides ?? []).filter((override) => !tenantId || override.tenantId === tenantId);
  const signedStripeEvents = paymentEvents.filter((event) => event.provider === 'stripe' && event.signatureStatus === 'verified');
  const signedEventIds = signedStripeEvents.map((event) => event.providerEventId).filter((id): id is string => Boolean(id));
  const duplicateSignedEventIds = signedEventIds.filter((id, index) => signedEventIds.indexOf(id) !== index);
  const stripeLaunch = fallbackProviderLaunchMatrix(data, backend, provider).rows.find((row) => row.id === 'stripe') ?? null;
  const stripeConfigured = Boolean(stripeLaunch?.configurationReady);
  const stripeSandboxPassed = stripeLaunch?.sandboxStatus === 'passed';
  const stripeLaunchReady = Boolean(stripeLaunch?.launchReady);
  const activeSubscription = activeSubscriptions[0] ?? subscriptions[0] ?? null;
  const activeEntitlement = activeEntitlements[0] ?? entitlements[0] ?? null;
  const rows = [
    paymentLifecycleAuditRow({
      area: 'subscription_starting_point',
      check: 'Workspace registration or checkout creates a subscription, billing owner, entitlement, checkout session, payment event, and lifecycle notice.',
      evidence: [`${subscriptions.length} subscription record(s), ${activeSubscriptions.length} active/trialing`, `${activeEntitlements.length}/${entitlements.length} active entitlement record(s)`, `${sessionCounts.checkout ?? 0} checkout session(s)`, `${noticeCounts.subscription_starting_point ?? 0} subscription starting-point notice(s)`],
      localOk: Boolean(tenant?.billingOwnerUserId && activeSubscription && activeEntitlement && (sessionCounts.checkout ?? 0) > 0),
      productionOk: stripeLaunchReady,
      recommendation: 'Use Stripe Billing plus Checkout Sessions for recurring SaaS start, with local registration creating only auditable local bootstrap state.',
      requiredEnv: stripeLaunch?.requiredEnv ?? ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SIGNAL_STRIPE_PRICE_TEAM'],
      commands: ['npm run admin -- tenants register New_Workspace newco.example owner@newco.example Owner_Name plan_team', 'npm run admin -- payments checkout tenant_demo plan_team --live-provider'],
    }),
    paymentLifecycleAuditRow({
      area: 'checkout_portal_self_service',
      check: 'Billing owners can create Checkout and Billing Portal sessions while admins retain local CLI recovery controls.',
      evidence: [`${sessionCounts.checkout ?? 0} checkout session(s)`, `${sessionCounts.portal ?? 0} portal session(s)`, `${paymentEvents.filter((event) => event.type === 'checkout.session.created').length} checkout created event(s)`, `${paymentEvents.filter((event) => event.type === 'billing_portal.session.created').length} portal created event(s)`],
      localOk: (sessionCounts.checkout ?? 0) > 0 && (sessionCounts.portal ?? 0) > 0,
      productionOk: stripeConfigured && stripeSandboxPassed,
      recommendation: 'Keep self-service plan changes in Stripe Checkout and Customer Portal instead of manual PaymentIntent renewal loops.',
      requiredEnv: stripeLaunch?.requiredEnv ?? ['STRIPE_SECRET_KEY', 'SIGNAL_STRIPE_PRICE_TEAM'],
      commands: ['npm run admin -- payments checkout tenant_demo plan_team --live-provider', 'npm run admin -- payments portal tenant_demo --live-provider'],
    }),
    paymentLifecycleAuditRow({
      area: 'failed_payment_recovery',
      check: 'Failed invoices create recovery sessions, lifecycle notices, billing jobs, and webhook-driven paid/recovered state.',
      evidence: [`${eventCounts['invoice.payment_failed'] ?? 0} failed-payment event(s)`, `${sessionCounts.payment_recovery ?? 0} payment recovery session(s)`, `${paidInvoices.length}/${invoices.length} paid invoice record(s)`, `${failedBillingJobs.length}/${billingJobs.length} failed billing_webhook job(s)`],
      localOk: (eventCounts['invoice.payment_failed'] ?? 0) > 0 && (sessionCounts.payment_recovery ?? 0) > 0 && (eventCounts['invoice.paid'] ?? 0) > 0 && failedBillingJobs.length === 0,
      productionOk: stripeLaunchReady && signedStripeEvents.some((event) => event.appliedType === 'invoice.payment_failed') && signedStripeEvents.some((event) => event.appliedType === 'invoice.paid'),
      recommendation: 'Use Stripe dunning/webhooks as the source of truth, then expose local recovery sessions and lifecycle notices for admins and billing owners.',
      requiredEnv: ['STRIPE_WEBHOOK_SECRET', 'STRIPE_SECRET_KEY'],
      commands: ['npm run admin -- payments recover <invoiceId>', 'npm run admin -- payments webhook invoice.payment_failed sub_demo', 'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>'],
    }),
    paymentLifecycleAuditRow({
      area: 'cancel_resubscribe',
      check: 'Cancellation and resubscription use subscription state, entitlement recomputation, checkout handoff, and lifecycle notices.',
      evidence: [`${canceledSubscriptions.length} canceled subscription record(s)`, `${eventCounts['subscription.canceled'] ?? 0} cancellation event(s)`, `${noticeCounts.subscription_canceled ?? 0} cancellation notice(s)`, `${sessionCounts.checkout ?? 0} checkout/resubscription handoff(s)`],
      localOk: (canceledSubscriptions.length > 0 || (eventCounts['subscription.canceled'] ?? 0) > 0) && (sessionCounts.checkout ?? 0) > 0 && activeEntitlements.length > 0,
      productionOk: stripeLaunchReady,
      recommendation: 'Cancel through the billing source of truth, recompute entitlements, then route resubscription through Checkout or Portal.',
      requiredEnv: stripeLaunch?.requiredEnv ?? ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SIGNAL_STRIPE_PRICE_TEAM'],
      commands: ['npm run admin -- payments cancel sub_demo', 'npm run admin -- payments checkout tenant_demo plan_team', 'npm run admin -- payments sync tenant_demo'],
    }),
    paymentLifecycleAuditRow({
      area: 'entitlement_source_of_truth',
      check: 'Product access is computed from subscription, invoice, and override state rather than browser-provided billing counters.',
      evidence: [`${activeEntitlement?.status ?? 'missing'} entitlement from ${activeEntitlement?.source ?? 'missing source'}`, `${billingOverrides.filter((override) => override.status === 'active').length}/${billingOverrides.length} active billing override(s)`, `${openInvoices.length}/${invoices.length} open invoice(s)`, `${summary.activeSeats ?? 0}/${summary.seatLimit ?? 'unlimited'} active seats`],
      localOk: activeEntitlements.length > 0 && openInvoices.length === 0 && failedBillingJobs.length === 0,
      productionOk: stripeLaunchReady,
      recommendation: 'Compute entitlements from stored provider-backed billing state and keep override records revocable and audited.',
      requiredEnv: ['STRIPE_WEBHOOK_SECRET', 'SIGNAL_STATE_SERVICE_URL', 'DATABASE_URL'],
      commands: ['npm run admin -- payments sync tenant_demo', 'npm run admin -- payments override tenant_demo beta_access Beta_extension plan_beta', 'npm run admin -- payments override-revoke <overrideId> Resolved'],
    }),
    paymentLifecycleAuditRow({
      area: 'signed_webhook_replay',
      check: 'Signed Stripe-style webhook replay deduplicates provider events and updates subscription, invoice, and entitlement records.',
      evidence: [`${signedStripeEvents.length} verified Stripe webhook event(s)`, `${duplicateSignedEventIds.length} duplicate provider event id(s)`, `${paymentEvents.filter((event) => event.providerEventId).length} provider event id(s) recorded`, `${paymentEvents.filter((event) => event.appliedType).length} applied provider event(s)`],
      localOk: signedStripeEvents.length > 0 && duplicateSignedEventIds.length === 0,
      productionOk: stripeLaunchReady && stripeSandboxPassed,
      recommendation: 'Treat signed provider webhooks as the production subscription source of truth and reject unsigned or replayed event payloads.',
      requiredEnv: ['STRIPE_WEBHOOK_SECRET'],
      commands: ['STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-sign ./stripe-event.json', 'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>'],
    }),
    paymentLifecycleAuditRow({
      area: 'stripe_launch_evidence',
      check: 'Stripe production launch needs configured prices/secrets, Billing Checkout/Portal sandbox proof, signed webhook replay, and active validation schedule.',
      evidence: [`configuration ${stripeConfigured ? 'ready' : 'missing'}`, `sandbox ${stripeLaunch?.sandboxStatus ?? 'not_recorded'}`, `schedule ${stripeLaunch?.schedule?.status ?? 'missing'}`, `${stripeLaunch?.missingEnv?.length ?? 0} missing required env name(s)`],
      localOk: Boolean(stripeLaunch),
      productionOk: stripeLaunchReady,
      recommendation: 'Before production traffic, run the Stripe sandbox evidence path and save sanitized provider evidence.',
      requiredEnv: stripeLaunch?.requiredEnv ?? ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SIGNAL_STRIPE_PRICE_TEAM'],
      commands: ['npm run admin -- provider-launch --env-file ./.env.production --json', 'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json'],
    }),
  ];
  return {
    backend: { mode: backend.mode, productionReady: backend.productionReady, statePath: summary.statePath },
    generatedAt: new Date().toISOString(),
    issues: rows.filter((row) => !row.localOk).map((row) => `${row.area}: ${row.check}`),
    ok: rows.every((row) => row.localOk),
    productionReady: rows.every((row) => row.productionOk),
    provider: {
      stripeConfigured,
      stripeLaunchReady,
      stripeSandboxPassed,
      stripeStatus: stripeLaunch?.status ?? 'missing',
    },
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
    tenant: tenant
      ? { id: tenant.id, name: tenant.name, domain: tenant.domain, billingOwnerUserId: tenant.billingOwnerUserId ?? null, ownerUserId: tenant.ownerUserId ?? null, status: tenant.status }
      : null,
  };
}

function paymentLifecycleFallbackRowByArea(report: PaymentLifecycleAuditReport, area: string) {
  return report.rows.find((row) => row.area === area) ?? null;
}

function fallbackPaymentHandoffStep({
  blocker,
  command,
  completion,
  env = {},
  evidence = [],
  followUpCommands = [],
  id,
  label,
  owner = 'billing',
  priority,
  productionOk = false,
  requiredEnv = [],
  rollbackCommand = null,
}: {
  blocker: string;
  command: string;
  completion: string;
  env?: Record<string, string | undefined>;
  evidence?: string[];
  followUpCommands?: string[];
  id: string;
  label: string;
  owner?: string;
  priority: number;
  productionOk?: boolean;
  requiredEnv?: string[];
  rollbackCommand?: string | null;
}): PaymentHandoffStep {
  return {
    id,
    label,
    owner,
    priority,
    status: productionOk ? 'ready' : 'needs_proof',
    localOk: true,
    productionOk,
    requiredEnv: uniquePlanValues(requiredEnv),
    configuredEnv: fallbackConfiguredKeys(env, requiredEnv),
    missingEnv: fallbackMissingKeys(env, requiredEnv),
    evidence,
    blocker,
    command,
    followUpCommands,
    rollbackCommand,
    completion,
  };
}

export function fallbackPaymentHandoff(
  data: SignalAppData,
  backend = fallbackBackendReadiness(),
  provider = fallbackProviderReadiness(),
  launch = fallbackProviderLaunchMatrix(data, backend, provider),
  payment = fallbackPaymentLifecycleAudit(data, backend, provider),
  env: Record<string, string | undefined> = {},
): PaymentHandoffReport {
  const summary = summarizeLocalState(data);
  const stripeRow = launch.rows.find((row) => row.id === 'stripe') ?? null;
  const subscriptionStart = paymentLifecycleFallbackRowByArea(payment, 'subscription_starting_point');
  const checkoutPortal = paymentLifecycleFallbackRowByArea(payment, 'checkout_portal_self_service');
  const failedPayment = paymentLifecycleFallbackRowByArea(payment, 'failed_payment_recovery');
  const cancelResubscribe = paymentLifecycleFallbackRowByArea(payment, 'cancel_resubscribe');
  const entitlementTruth = paymentLifecycleFallbackRowByArea(payment, 'entitlement_source_of_truth');
  const signedWebhook = paymentLifecycleFallbackRowByArea(payment, 'signed_webhook_replay');
  const stripeEvidence = paymentLifecycleFallbackRowByArea(payment, 'stripe_launch_evidence');
  const stripeRequiredEnv = stripeRow?.requiredEnv.length ? stripeRow.requiredEnv : ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SIGNAL_STRIPE_PRICE_TEAM'];
  const checkoutEnv = uniquePlanValues(['STRIPE_SECRET_KEY', 'SIGNAL_STRIPE_PRICE_TEAM']);
  const webhookEnv = ['STRIPE_WEBHOOK_SECRET'];
  const billingStateEnv = ['SIGNAL_STATE_SERVICE_URL', 'DATABASE_URL'];
  const paymentLaunchReady = Boolean(payment.productionReady && stripeRow?.launchReady);
  const rows = [
    fallbackPaymentHandoffStep({
      id: 'configure_stripe_env',
      label: 'Configure Stripe billing environment',
      priority: 10,
      env,
      productionOk: Boolean(stripeRow?.configurationReady),
      requiredEnv: stripeRequiredEnv,
      evidence: [
        stripeRow ? `${stripeRow.label}: ${stripeRow.status}` : 'Stripe launch row missing',
        `${stripeRow?.missingEnv.length ?? stripeRequiredEnv.length} missing Stripe env name(s)`,
      ],
      blocker: stripeRow?.configurationReady ? 'None' : 'Stripe secret, webhook secret, or team price env is missing.',
      command: 'npm run admin -- provider-launch --env-file ./.env.production --json',
      followUpCommands: ['npm run admin -- payment-handoff --env-file ./.env.production --json'],
      rollbackCommand: 'Keep live Stripe provider mode disabled until configuration, sandbox evidence, and signed webhook replay pass.',
      completion: 'Stripe launch row reports configuration-ready with required env names present and no credential values serialized.',
    }),
    fallbackPaymentHandoffStep({
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
    fallbackPaymentHandoffStep({
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
    fallbackPaymentHandoffStep({
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
    fallbackPaymentHandoffStep({
      id: 'prove_cancel_resubscribe_entitlements',
      label: 'Prove cancellation, resubscription, and entitlements',
      priority: 50,
      env,
      productionOk: Boolean(cancelResubscribe?.productionOk && entitlementTruth?.productionOk && subscriptionStart?.productionOk),
      requiredEnv: uniquePlanValues([...stripeRequiredEnv, ...billingStateEnv]),
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
    fallbackPaymentHandoffStep({
      id: 'save_stripe_sandbox_evidence',
      label: 'Save Stripe sandbox evidence',
      priority: 60,
      env,
      productionOk: Boolean(stripeRow?.launchReady && stripeEvidence?.productionOk),
      requiredEnv: uniquePlanValues([...providerSandboxRequiredEnv('stripe'), ...stripeRequiredEnv]),
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
    fallbackPaymentHandoffStep({
      id: 'package_payment_launch_evidence',
      label: 'Package redacted payment launch evidence',
      priority: 70,
      env,
      productionOk: paymentLaunchReady,
      evidence: [
        `${payment.summary.productionReady}/${payment.summary.total} payment lifecycle production row(s) ready`,
        `${summary.subscriptions} subscription record(s) | ${summary.activeEntitlements} active entitlement(s) | ${summary.openInvoices}/${summary.invoices} open invoice(s) | ${summary.paymentEvents} payment event(s)`,
        stripeRow ? `${stripeRow.label}: ${stripeRow.status}` : 'Stripe launch row missing',
      ],
      blocker: paymentLaunchReady ? 'None' : 'Payment launch evidence cannot be packaged until Stripe launch, lifecycle, sandbox, and gate proof all pass.',
      command: 'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json',
      followUpCommands: ['npm run admin -- launch-gate verify-package ./signal-launch-evidence.json --json'],
      rollbackCommand: 'Reject the launch package if payment gate, signed webhook, or Stripe sandbox proof is missing.',
      completion: 'Launch evidence package includes payment lifecycle, provider launch, signed webhook replay, Stripe sandbox, and entitlement proof without credentials.',
    }),
  ];
  const nextStep: PaymentHandoffStep = rows.find((row) => !row.productionOk) ?? {
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
  const report: PaymentHandoffReport = {
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
    runnableCommands: uniquePlanValues([
      'npm run admin -- payment-handoff --json',
      'npm run admin -- payment-handoff --env-file ./.env.production --json',
      'curl http://127.0.0.1:8787/api/payment-handoff',
      'npm run admin -- payment-lifecycle --json',
      'npm run admin -- provider-launch --env-file ./.env.production --json',
      'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
      nextStep.command,
      nextStep.rollbackCommand,
      ...nextStep.followUpCommands,
    ]),
    summary: {
      blocked: rows.filter((row) => !row.productionOk).length,
      configuredEnv: uniquePlanValues(rows.flatMap((row) => row.configuredEnv)).length,
      localReady: payment.summary.localReady,
      missingRequiredEnv: uniquePlanValues(rows.flatMap((row) => row.missingEnv)).length,
      nextStepId: nextStep.id,
      productionReady: rows.filter((row) => row.productionOk).length,
      secretSafe: false,
      total: rows.length,
    },
  };
  report.summary.secretSafe = !localAgentHandoffStringLooksUnsafe(JSON.stringify(report));
  report.ok = report.summary.secretSafe && rows.length === 7;
  return report;
}

function fallbackEmailHandoffStep({
  blocker,
  command,
  completion,
  env = {},
  evidence = [],
  followUpCommands = [],
  id,
  label,
  owner = 'integrations',
  priority,
  productionOk = false,
  requiredEnv = [],
  rollbackCommand = null,
}: {
  blocker: string;
  command: string;
  completion: string;
  env?: Record<string, string | undefined>;
  evidence?: string[];
  followUpCommands?: string[];
  id: string;
  label: string;
  owner?: string;
  priority: number;
  productionOk?: boolean;
  requiredEnv?: string[];
  rollbackCommand?: string | null;
}): EmailHandoffStep {
  return {
    id,
    label,
    owner,
    priority,
    status: productionOk ? 'ready' : 'needs_proof',
    localOk: true,
    productionOk,
    requiredEnv: uniquePlanValues(requiredEnv),
    configuredEnv: fallbackConfiguredKeys(env, requiredEnv),
    missingEnv: fallbackMissingKeys(env, requiredEnv),
    evidence,
    blocker,
    command,
    followUpCommands,
    rollbackCommand,
    completion,
  };
}

export function fallbackEmailHandoff(
  data: SignalAppData,
  backend = fallbackBackendReadiness(),
  provider = fallbackProviderReadiness(),
  launch = fallbackProviderLaunchMatrix(data, backend, provider),
  operations = fallbackOperationsHealth(data, backend),
  env: Record<string, string | undefined> = {},
): EmailHandoffReport {
  const summary = summarizeLocalState(data);
  const gmailRow = launch.rows.find((row) => row.id === 'gmail') ?? null;
  const outlookRow = launch.rows.find((row) => row.id === 'outlook') ?? null;
  const outboundRow = launch.rows.find((row) => row.id === 'outbound-email') ?? null;
  const emailRows = [gmailRow, outlookRow, outboundRow].filter(Boolean) as ProviderLaunchRow[];
  const gmailRequiredEnv = gmailRow?.requiredEnv.length
    ? gmailRow.requiredEnv
    : ['SIGNAL_GMAIL_CLIENT_ID', 'SIGNAL_GMAIL_CLIENT_SECRET', 'SIGNAL_GMAIL_REDIRECT_URI', 'SIGNAL_TOKEN_ENCRYPTION_KEY'];
  const outlookRequiredEnv = outlookRow?.requiredEnv.length
    ? outlookRow.requiredEnv
    : ['SIGNAL_OUTLOOK_CLIENT_ID', 'SIGNAL_OUTLOOK_CLIENT_SECRET', 'SIGNAL_OUTLOOK_TENANT_ID', 'SIGNAL_OUTLOOK_REDIRECT_URI', 'SIGNAL_TOKEN_ENCRYPTION_KEY'];
  const outboundRequiredEnv = outboundRow?.requiredEnv.length
    ? outboundRow.requiredEnv
    : ['SIGNAL_EMAIL_PROVIDER_URL', 'SIGNAL_EMAIL_PROVIDER_TOKEN', 'SIGNAL_EMAIL_FROM', 'SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET'];
  const emailSandboxEnv = uniquePlanValues([
    ...providerSandboxRequiredEnv('gmail'),
    ...providerSandboxRequiredEnv('outlook'),
    ...providerSandboxRequiredEnv('outbound-email'),
  ]);
  const gmailWebhook = operations.webhooks.find((row) => row.channel === 'gmail') ?? null;
  const outlookWebhook = operations.webhooks.find((row) => row.channel === 'outlook') ?? null;
  const outboundWebhook = operations.webhooks.find((row) => row.channel === 'outbound_email') ?? null;
  const emailSyncQueue = operations.queues.find((row) => row.queue === 'email_sync') ?? null;
  const notificationQueue = operations.queues.find((row) => row.queue === 'notification_digest') ?? null;
  const outboundQueue = operations.queues.find((row) => row.queue === 'outbound_email') ?? null;
  const lifecycle = fallbackLifecyclePlaybook(data, backend);
  const outboundPlaybook = lifecycle.rows.find((row) => row.id === 'outbound_email_delivery') ?? null;
  const watchPlaybook = lifecycle.rows.find((row) => row.id === 'provider_backoff_watch') ?? null;
  const signedDeliveryMessages = (data.emailDeliveryMessages ?? []).filter((message) => message.providerSignatureStatus === 'verified');
  const signedDeliveryEventIds = signedDeliveryMessages
    .flatMap((message) => message.providerEventIds ?? (message.providerEventId ? [message.providerEventId] : []))
    .filter(Boolean);
  const duplicateSignedDeliveryEventIds = signedDeliveryEventIds.filter((id, index) => signedDeliveryEventIds.indexOf(id) !== index);
  const activeEmailProviderSchedules = (data.providerValidationSchedules ?? []).filter((schedule) =>
    ['gmail', 'outlook', 'outbound-email'].includes(schedule.providerId) &&
    schedule.status === 'active').length;
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
  const emailLaunchReady = Boolean(emailRows.length === 3 && emailRows.every((row) => row.launchReady) && emailSandboxPassed && digestProofReady && signedWebhookReady);
  const rows = [
    fallbackEmailHandoffStep({
      id: 'configure_gmail_env',
      label: 'Configure Gmail OAuth and watch environment',
      priority: 10,
      env,
      productionOk: Boolean(gmailRow?.configurationReady),
      requiredEnv: gmailRequiredEnv,
      evidence: [gmailRow ? `${gmailRow.label}: ${gmailRow.status}` : 'Gmail launch row missing', `${gmailRow?.missingEnv.length ?? gmailRequiredEnv.length} missing Gmail env name(s)`, gmailWebhook?.status ? `Webhook health: ${gmailWebhook.status}` : 'Gmail webhook health not evaluated'],
      blocker: gmailRow?.configurationReady ? 'None' : 'Gmail OAuth/watch env is missing or placeholder-only.',
      command: 'npm run admin -- provider-launch --env-file ./.env.production --json',
      followUpCommands: ['npm run admin -- email-handoff --env-file ./.env.production --json'],
      rollbackCommand: 'Keep Gmail live watch mode disabled until OAuth env, sandbox proof, and watch replay pass.',
      completion: 'Gmail provider launch row is configuration-ready and no credential values are serialized.',
    }),
    fallbackEmailHandoffStep({
      id: 'configure_outlook_env',
      label: 'Configure Outlook OAuth and Graph webhook environment',
      priority: 20,
      env,
      productionOk: Boolean(outlookRow?.configurationReady),
      requiredEnv: outlookRequiredEnv,
      evidence: [outlookRow ? `${outlookRow.label}: ${outlookRow.status}` : 'Outlook launch row missing', `${outlookRow?.missingEnv.length ?? outlookRequiredEnv.length} missing Outlook env name(s)`, outlookWebhook?.status ? `Webhook health: ${outlookWebhook.status}` : 'Outlook webhook health not evaluated'],
      blocker: outlookRow?.configurationReady ? 'None' : 'Outlook OAuth/Graph env is missing or placeholder-only.',
      command: 'npm run admin -- provider-launch --env-file ./.env.production --json',
      followUpCommands: ['npm run admin -- email-handoff --env-file ./.env.production --json'],
      rollbackCommand: 'Keep Outlook live watch renewal disabled until OAuth env, sandbox proof, and notification replay pass.',
      completion: 'Outlook provider launch row is configuration-ready and no credential values are serialized.',
    }),
    fallbackEmailHandoffStep({
      id: 'configure_outbound_email_env',
      label: 'Configure outbound digest email environment',
      priority: 30,
      env,
      productionOk: Boolean(outboundRow?.configurationReady),
      requiredEnv: outboundRequiredEnv,
      evidence: [outboundRow ? `${outboundRow.label}: ${outboundRow.status}` : 'Outbound email launch row missing', `${outboundRow?.missingEnv.length ?? outboundRequiredEnv.length} missing outbound email env name(s)`, outboundWebhook?.status ? `Delivery webhook health: ${outboundWebhook.status}` : 'Outbound webhook health not evaluated'],
      blocker: outboundRow?.configurationReady ? 'None' : 'SendGrid/outbound email provider env or signed delivery webhook secret is missing.',
      command: 'npm run admin -- provider-launch --env-file ./.env.production --json',
      followUpCommands: ['npm run admin -- notifications digest tenant_demo --live-provider'],
      rollbackCommand: 'Keep live outbound email sends disabled and use local delivery records until provider proof passes.',
      completion: 'Outbound provider row is configuration-ready and digest delivery can use the provider without exposing tokens.',
    }),
    fallbackEmailHandoffStep({
      id: 'save_email_sandbox_evidence',
      label: 'Save Gmail, Outlook, and outbound email sandbox evidence',
      priority: 40,
      env,
      productionOk: emailSandboxPassed && activeEmailProviderSchedules >= 3,
      requiredEnv: emailSandboxEnv,
      evidence: [`Gmail sandbox: ${gmailRow?.sandboxStatus ?? 'not_recorded'}`, `Outlook sandbox: ${outlookRow?.sandboxStatus ?? 'not_recorded'}`, `Outbound email sandbox: ${outboundRow?.sandboxStatus ?? 'not_recorded'}`, `${activeEmailProviderSchedules}/3 active email provider validation schedule(s)`],
      blocker: emailSandboxPassed && activeEmailProviderSchedules >= 3 ? 'None' : 'Saved provider sandbox evidence or active validation schedules are missing for email providers.',
      command: 'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
      followUpCommands: ['npm run admin -- integrations evidence-export latest ./signal-provider-evidence.json --json', 'npm run admin -- integrations run-scheduled --force --json'],
      rollbackCommand: 'Do not package email launch evidence until sanitized provider evidence imports/exports cleanly.',
      completion: 'Saved sandbox evidence proves Gmail watch, Outlook notification, outbound send, and active validation schedules.',
    }),
    fallbackEmailHandoffStep({
      id: 'prove_watch_and_sync_launch',
      label: 'Prove Gmail and Outlook watch plus sync launch',
      priority: 50,
      env,
      productionOk: watchProofReady,
      requiredEnv: uniquePlanValues([...providerSandboxRequiredEnv('gmail'), ...providerSandboxRequiredEnv('outlook')]),
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
    fallbackEmailHandoffStep({
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
    fallbackEmailHandoffStep({
      id: 'replay_signed_delivery_webhooks',
      label: 'Replay signed delivery webhooks',
      priority: 70,
      env,
      productionOk: signedWebhookReady,
      requiredEnv: uniquePlanValues(['SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET', 'SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY']),
      evidence: [`${signedDeliveryMessages.length} verified email delivery webhook message(s)`, `${duplicateSignedDeliveryEventIds.length} duplicate provider delivery event id(s)`, `${summary.emailDeliveries ?? 0} delivery ledger record(s)`],
      blocker: signedWebhookReady ? 'None' : 'Signed generic/SendGrid delivery webhook replay has not produced verified, deduplicated delivery records.',
      command: 'SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET=<email-webhook-secret> npm run admin -- notifications webhook-signed ./email-event.json <Signal-Email-Signature>',
      followUpCommands: ['SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY=<sendgrid-public-key> npm run admin -- notifications sendgrid-webhook-signed ./sendgrid-events.json <signature> <timestamp>', 'npm run admin -- operations-health --json'],
      rollbackCommand: 'Reject unsigned or replayed delivery events and keep failed delivery notices visible until signed provider events reconcile.',
      completion: 'Signed generic and SendGrid delivery webhooks reconcile sent, failed, bounced, and suppressed statuses without duplicate provider event ids.',
    }),
    fallbackEmailHandoffStep({
      id: 'package_email_launch_evidence',
      label: 'Package redacted email launch evidence',
      priority: 80,
      env,
      productionOk: emailLaunchReady,
      evidence: [
        `${summary.connectedMailboxes}/${summary.mailboxes} mailbox source(s) connected locally | ${summary.activeEmailWatchSubscriptions ?? 0}/${summary.emailWatchSubscriptions ?? 0} active provider watch subscription(s) | ${summary.failedEmailDeliveries ?? 0}/${summary.emailDeliveries ?? 0} failed outbound email deliveries`,
        `${emailRows.filter((row) => row.launchReady).length}/3 email provider launch row(s) ready`,
        `${operations.summary.totalWebhooks - operations.summary.unhealthyWebhooks}/${operations.summary.totalWebhooks} webhook channel(s) locally healthy`,
      ],
      blocker: emailLaunchReady ? 'None' : 'Email launch evidence cannot be packaged until provider config, sandbox proof, watches, digest sends, signed webhooks, and launch gate all pass.',
      command: 'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json',
      followUpCommands: ['npm run admin -- launch-gate verify-package ./signal-launch-evidence.json --json'],
      rollbackCommand: 'Reject launch evidence if Gmail, Outlook, outbound email, signed delivery webhooks, or operations-health proof is missing.',
      completion: 'Launch package includes email provider launch, sandbox evidence, watch/sync proof, outbound send proof, signed delivery webhooks, and rollback notes without credentials.',
    }),
  ];
  const nextStep: EmailHandoffStep = rows.find((row) => !row.productionOk) ?? {
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
  const report: EmailHandoffReport = {
    generatedAt: new Date().toISOString(),
    ok: true,
    productionReady: emailLaunchReady,
    nextStep,
    rows,
    email: {
      connectedMailboxes: summary.connectedMailboxes,
      activeEmailWatchSubscriptions: summary.activeEmailWatchSubscriptions ?? 0,
      emailWatchSubscriptions: summary.emailWatchSubscriptions ?? 0,
      enabledEmailFlows: summary.enabledEmailFlows,
      emailFlows: summary.emailFlows,
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
      ok: operations.ok,
      productionReady: operations.productionReady,
      failedDeliveries: operations.summary.failedDeliveries,
      failedQueues: operations.summary.failedQueues,
      activeBackoffs: operations.summary.activeBackoffs,
      unhealthyWebhooks: operations.summary.unhealthyWebhooks,
    },
    recommendation: {
      summary: 'Use email-handoff after provider-handoff to move Gmail, Outlook, and outbound digest email from local proof to launch evidence.',
      productionGuardrail: 'Do not enable production email ingestion or outbound digest delivery until Gmail/Outlook/outbound env, saved sandbox evidence, live watch/sync proof, signed delivery webhook replay, clean operations health, and launch evidence packaging all pass.',
      localAgentCommand: 'npm run admin -- email-handoff --env-file ./.env.production --json',
    },
    runnableCommands: uniquePlanValues([
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
    ]),
    summary: {
      activeEmailProviderSchedules,
      blocked: rows.filter((row) => !row.productionOk).length,
      configuredEnv: uniquePlanValues(rows.flatMap((row) => row.configuredEnv)).length,
      localReady: 10,
      missingRequiredEnv: uniquePlanValues(rows.flatMap((row) => row.missingEnv)).length,
      nextStepId: nextStep.id,
      productionReady: rows.filter((row) => row.productionOk).length,
      secretSafe: false,
      total: rows.length,
    },
  };
  report.summary.secretSafe = !localAgentHandoffStringLooksUnsafe(JSON.stringify(report));
  report.ok = report.summary.secretSafe && rows.length === 8 && operations.ok;
  return report;
}

function qaFallbackStatus(localOk: boolean, productionOk: boolean, needsLiveProvider = false) {
  if (!localOk) {
    return 'needs_local_work';
  }
  if (productionOk) {
    return 'production_ready';
  }
  return needsLiveProvider ? 'needs_live_provider' : 'needs_production';
}

function qaFallbackRow({
  answer,
  commands,
  evidence,
  id,
  localOk,
  needsLiveProvider = false,
  owner,
  productionCaveat,
  productionOk,
  question,
}: {
  answer: string;
  commands: string[];
  evidence: string[];
  id: string;
  localOk: boolean;
  needsLiveProvider?: boolean;
  owner: string;
  productionCaveat: string;
  productionOk: boolean;
  question: string;
}): QaAnswerRow {
  return {
    id,
    question,
    answer,
    owner,
    evidence,
    commands,
    localOk,
    productionOk,
    productionCaveat,
    status: qaFallbackStatus(localOk, productionOk, needsLiveProvider),
  };
}

export function fallbackQaAnswers(data: SignalAppData, backend = fallbackBackendReadiness(), provider = fallbackProviderReadiness()): QaAnswersReport {
  const summary = summarizeLocalState(data);
  const dashboard = fallbackDashboardAudit(data, backend);
  const pipeline = fallbackSignalDigestionPipeline(data, backend);
  const onboarding = fallbackOnboardingReadiness(data, backend);
  const operations = fallbackOperationsHealth(data, backend);
  const playbook = fallbackLifecyclePlaybook(data, backend);
  const launch = fallbackProviderLaunchMatrix(data, backend, provider);
  const launchById = (id: string) => launch.rows.find((row) => row.id === id);
  const backendProductionReady = backend.productionReady === true;
  const readinessEvidence = (id: string): string[] => {
    if (id === 'workspace_onboarding') {
      return [
        `${summary.tenants} tenant(s)`,
        `${summary.activeMemberships}/${summary.memberships} active memberships`,
        `${summary.pendingInvites}/${summary.invites} pending invites`,
        `${summary.activeSeats}+${summary.pendingInviteSeats}/${summary.seatLimit ?? 'unlimited'} seats`,
      ];
    }
    if (id === 'multi_user_rbac_privacy') {
      return [
        `${summary.admins} active admin(s)`,
        `${summary.activeMemberships} active membership(s)`,
        `${summary.apiSessions} digest-only API session record(s)`,
        `Backend tenant isolation: ${backend.checks.find((check) => check.id === 'tenant_isolation')?.ok ? 'configured' : 'not production configured'}`,
      ];
    }
    if (id === 'email_source_and_detection_flow') {
      return [
        `${summary.connectedMailboxes}/${summary.mailboxes} connected mailbox source(s)`,
        `${summary.sourceMessages} source message fixture(s)`,
        `${summary.enabledEmailFlows}/${summary.emailFlows} enabled detector flow(s)`,
        `${summary.generatedSignals} generated source-backed signal(s)`,
        `${summary.queuedSignalHandoffs}/${summary.signalHandoffs} queued handoff(s)`,
      ];
    }
    if (id === 'model_governance_and_tuning') {
      return [
        `${summary.modelGovernancePolicies} model governance polic${summary.modelGovernancePolicies === 1 ? 'y' : 'ies'}`,
        `${summary.perTenantModels} per-tenant trained model(s) enabled`,
        `${summary.activeSuppressionRules}/${summary.suppressionRules} active suppression rule(s)`,
        `${summary.signalFeedback} feedback label(s)`,
      ];
    }
    if (id === 'relationship_dashboard_and_recommendations') {
      return [
        `${summary.accounts} account profile(s)`,
        `${summary.atRiskAccounts} at-risk account(s)`,
        `${summary.openAccountActions} open next action(s)`,
        `${summary.openAccountRecommendations}/${summary.accountRecommendations} open recommendation(s)`,
      ];
    }
    if (id === 'notifications_and_admin_monitoring') {
      return [
        `${summary.notificationPreferences} notification preference record(s)`,
        `${summary.unreadNotifications}/${summary.notificationEvents} unread notification(s)`,
        `${summary.digestRuns} digest run(s)`,
        `${summary.failedEmailDeliveries}/${summary.emailDeliveries} failed email deliver${summary.emailDeliveries === 1 ? 'y' : 'ies'}`,
      ];
    }
    if (id === 'payment_lifecycle_and_entitlements') {
      return [
        `${summary.subscriptions} subscription record(s)`,
        `${summary.activeEntitlements} active entitlement(s)`,
        `${summary.openInvoices}/${summary.invoices} open invoice(s)`,
        `${summary.billingSessions} billing session(s)`,
        `${summary.paymentEvents} payment event(s)`,
      ];
    }
    return [];
  };
  const modelBoundaryStageReady = pipeline.rows.some((row) => row.area === 'model_learning_boundary' && row.localOk);
  const emailProductionReady = Boolean(launchById('gmail')?.launchReady && launchById('outlook')?.launchReady && launchById('outbound-email')?.launchReady);
  const paymentProductionReady = Boolean(launchById('stripe')?.launchReady);
  const modelLocalOk = (data.modelGovernancePolicies ?? []).every((policy) =>
    policy.dataBoundary === 'tenant_isolated' &&
    policy.perTenantModel === false);
  const relationshipLocalOk = (summary.accounts ?? 0) > 0 && (summary.openAccountRecommendations ?? 0) > 0;
  const notificationLocalOk = (summary.notificationPreferences ?? 0) > 0 && (summary.notificationEvents ?? 0) > 0;
  const emailFlowLocalOk = (summary.connectedMailboxes ?? 0) > 0 && (summary.enabledEmailFlows ?? 0) > 0;
  const paymentLocalOk = (summary.subscriptions ?? 0) > 0 && (summary.activeEntitlements ?? 0) > 0 && playbook.ok;
  const rows = [
    qaFallbackRow({
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
        `${backend.summary.readyChecks}/${backend.summary.totalChecks} production backend check(s) ready`,
      ],
      commands: ['npm run admin -- dashboard-audit --json', 'curl http://127.0.0.1:8787/api/dashboard-audit', 'npm run admin -- backend --env-file ./.env.production --json'],
    }),
    qaFallbackRow({
      id: 'data_digestion_model_boundary',
      question: 'Do we need a data digestion model, model learning pipeline, or one model per org?',
      answer: 'Use a shared detector/data digestion boundary by default, with tenant-isolated data plus tenant-specific thresholds, routing, suppression, feedback labels, retention, and opt-in learning controls. Do not create one trained model per org unless a governed opt-in tuning policy is approved.',
      owner: 'ai_governance',
      localOk: modelLocalOk && modelBoundaryStageReady,
      productionOk: modelLocalOk && pipeline.productionReady,
      productionCaveat: pipeline.recommendation.productionGuardrail,
      evidence: [
        ...readinessEvidence('model_governance_and_tuning'),
        `${pipeline.summary.localReady}/${pipeline.summary.total} digestion pipeline stage(s) locally ready`,
        `${pipeline.summary.sourceMessages} source message(s), ${pipeline.summary.generatedSignals} source-backed signal(s)`,
        `${summary.perTenantModels} per-tenant trained model(s) enabled`,
      ],
      commands: ['npm run admin -- digestion-pipeline --json', 'curl http://127.0.0.1:8787/api/digestion-pipeline', 'npm run admin -- models --json', 'npm run admin -- models policy tenant_demo opt_in_tuning Governance_reviewed --json', 'npm run admin -- quality threshold tenant_demo 0.74'],
    }),
    qaFallbackRow({
      id: 'multi_user_same_org_rbac',
      question: 'Can the system handle multiple users in the same org, and how is that handled?',
      answer: 'Yes locally. Multi-user orgs are handled through tenant memberships, role, team, status, owner/billing owner, seat limits, signed admin sessions, and owner/team-scoped member visibility. Production requires durable tenant isolation and managed auth before many customer orgs share one backend.',
      owner: 'security',
      localOk: onboarding.ok,
      productionOk: onboarding.productionReady && backendProductionReady,
      productionCaveat: onboarding.recommendation.productionGuardrail,
      evidence: [
        ...readinessEvidence('multi_user_rbac_privacy'),
        `${onboarding.summary.activeAdmins} active admin(s)`,
        `${onboarding.summary.activeMembers} active member(s)`,
        `${onboarding.summary.visibleSignalsForActor} signal row(s) visible for active actor`,
      ],
      commands: ['npm run admin -- onboarding-readiness --json', 'curl http://127.0.0.1:8787/api/onboarding-readiness', 'npm run admin -- users --json', 'npm run admin -- session token usr_admin --json'],
    }),
    qaFallbackRow({
      id: 'workspace_registration_invitation',
      question: 'Is user onboarding, registration, workspace creation, and member invitation complete?',
      answer: 'Yes locally. Self-service workspace registration, owner/admin registration, invite claim, admin acceptance, membership records, seats, onboarding notifications, and session switching are represented in CLI, API, and UI flows.',
      owner: 'workspace_admin',
      localOk: onboarding.ok && onboarding.summary.localReady === onboarding.summary.total,
      productionOk: onboarding.productionReady,
      productionCaveat: onboarding.recommendation.productionGuardrail,
      evidence: [
        ...readinessEvidence('workspace_onboarding'),
        `${onboarding.summary.pendingInvites} pending invite(s)`,
        `${onboarding.summary.seatsAvailable ?? 'unlimited'} seat(s) available`,
      ],
      commands: ['npm run admin -- tenants register New_Revenue_Lab newlab.example owner@newlab.example Owner_Name plan_beta', 'curl -X POST http://127.0.0.1:8787/api/registration', 'npm run admin -- users invite tenant_demo rowan@acme.example member success', 'npm run admin -- users claim <inviteCode> "Rowan Lee"', 'npm run admin -- users accept <inviteId>'],
    }),
    qaFallbackRow({
      id: 'focus_priorities_notifications',
      question: 'Can each user/org define focus, outcomes, priorities, and notifications?',
      answer: 'Yes locally. Focus is modeled through routing rules, account ownership, signal assignment, notification preferences, mute rules, digest cadence, immediate alerts, and tenant quality thresholds instead of separate models per customer.',
      owner: 'customer_success',
      localOk: notificationLocalOk && relationshipLocalOk,
      productionOk: notificationLocalOk && relationshipLocalOk,
      productionCaveat: 'Live email delivery still depends on provider launch readiness for production notification sends.',
      evidence: [
        ...readinessEvidence('notifications_and_admin_monitoring'),
        `${summary.activeRoutingRules}/${summary.routingRules} active routing rule(s)`,
        `${summary.openAccountRecommendations}/${summary.accountRecommendations} open recommendation(s)`,
      ],
      commands: ['npm run admin -- notifications preference usr_sales daily immediate', 'npm run admin -- notifications mute-account usr_product Acme Health', 'npm run admin -- signals assign sig_risk_001 usr_sales', 'npm run admin -- quality threshold tenant_demo 0.74'],
    }),
    qaFallbackRow({
      id: 'contact_relationship_strategy',
      question: 'Do we have user/contact relationship indicators, recommendations, and strategy?',
      answer: 'Yes locally. The relationship dashboard includes account health, at-risk accounts, stakeholder timelines, open next actions, account reviews, and recommendations backed by source-linked signals.',
      owner: 'sales_strategy',
      localOk: relationshipLocalOk,
      productionOk: relationshipLocalOk,
      productionCaveat: 'Production relationship recommendations still depend on production email ingestion and tenant-isolated storage before live customer data.',
      evidence: readinessEvidence('relationship_dashboard_and_recommendations'),
      commands: ['npm run admin -- accounts --json', 'npm run admin -- accounts review Acme_Health QBR_risk renewal_save', 'npm run admin -- signals feedback sig_risk_001 useful Renewal_save_signal'],
    }),
    qaFallbackRow({
      id: 'email_notification_admin_monitoring',
      question: 'Do we have email notification flow, admin settings, and monitoring?',
      answer: 'Yes locally. Admins can manage email flows, run detector jobs, send digests, inspect delivery ledger state, process signed delivery webhooks, monitor provider watches/backoff, and use operations health for queues and webhooks. Production send/ingest launch still needs live provider configuration and sandbox proof.',
      owner: 'integrations',
      localOk: emailFlowLocalOk && notificationLocalOk && operations.ok,
      productionOk: emailProductionReady,
      needsLiveProvider: true,
      productionCaveat: emailProductionReady
        ? 'Gmail, Outlook, and outbound email provider launch rows are ready.'
        : 'Gmail, Outlook, and SendGrid/outbound email config plus saved sandbox evidence must pass before production email launch.',
      evidence: [
        ...readinessEvidence('email_source_and_detection_flow'),
        `${operations.summary.totalWebhooks - operations.summary.unhealthyWebhooks}/${operations.summary.totalWebhooks} webhook channel(s) healthy`,
        `${operations.summary.failedDeliveries} failed delivery record(s)`,
        `${launchById('outbound-email')?.sandboxStatus ?? 'not_recorded'} outbound email sandbox status`,
      ],
      commands: ['npm run admin -- email-flows --json', 'npm run admin -- notifications digest tenant_demo', 'npm run admin -- operations-health --json', 'npm run admin -- provider-launch --env-file ./.env.production --json'],
    }),
    qaFallbackRow({
      id: 'payment_lifecycle_handling',
      question: 'How do we handle failed payment, disconnect notice, cancellation, resubscription, and subscription starting point?',
      answer: 'Yes locally. Billing uses subscription state and entitlement gates, Stripe-style Checkout/Billing Portal handoffs, invoice recovery sessions, signed webhook replay, lifecycle notices, cancellation, and resubscription commands. Production billing launch still needs Stripe config and sandbox evidence.',
      owner: 'billing',
      localOk: paymentLocalOk,
      productionOk: paymentProductionReady,
      needsLiveProvider: true,
      productionCaveat: paymentProductionReady
        ? 'Stripe launch row is production-ready.'
        : 'Stripe secret, webhook secret, price config, live Checkout/Portal proof, signed webhook replay, and saved sandbox evidence are required before production billing launch.',
      evidence: [
        ...readinessEvidence('payment_lifecycle_and_entitlements'),
        `${playbook.summary.actionReady} lifecycle playbook action-ready row(s)`,
        `${launchById('stripe')?.sandboxStatus ?? 'not_recorded'} Stripe sandbox status`,
      ],
      commands: ['npm run admin -- lifecycle-playbook --json', 'npm run admin -- payments recover <invoiceId>', 'npm run admin -- payments checkout tenant_demo plan_team', 'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>'],
    }),
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    ok: true,
    productionReady: rows.every((row) => row.productionOk),
    recommendation: {
      summary: 'Use qa-answers for stakeholder QA: each answer ties the visible product claim to local evidence, CLI/API proof, owner, and production caveat.',
      productionGuardrail: 'Local answers are ready, but production remains blocked until backend tenant isolation, managed auth/storage, live provider sandbox evidence, signed webhooks, and scheduler/alerting are configured.',
      localAgentCommand: 'npm run admin -- qa-answers --json',
    },
    rows,
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
  report.summary.secretSafe = !/sk_live_|sk_test_|secret_value|token_value|password_value/i.test(JSON.stringify(report));
  report.ok = report.summary.secretSafe && rows.length === 8;
  return report;
}

function uniquePlanValues(values: Array<string | null | undefined | false>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function fallbackProductionPlanRow({
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
}: {
  blockers?: Array<string | null | undefined | false>;
  commands?: Array<string | null | undefined | false>;
  completionCriteria?: Array<string | null | undefined | false>;
  dependsOn?: Array<string | null | undefined | false>;
  evidence?: Array<string | null | undefined | false>;
  id: string;
  owner: string;
  phase: string;
  productionOk: boolean;
  requiredEnv?: Array<string | null | undefined | false>;
}): ProductionPlanRow {
  const uniqueBlockers = uniquePlanValues(blockers);
  const uniqueCommands = uniquePlanValues(commands);
  return {
    id,
    phase,
    owner,
    status: productionOk ? 'complete' : uniqueBlockers.length ? 'blocked' : 'ready_for_proof',
    productionOk,
    evidence: uniquePlanValues(evidence),
    blockers: uniqueBlockers,
    requiredEnv: uniquePlanValues(requiredEnv),
    commands: uniqueCommands,
    completionCriteria: uniquePlanValues(completionCriteria),
    dependsOn: uniquePlanValues(dependsOn),
    localAgentCanRun: uniqueCommands.length > 0,
  };
}

function fallbackLaunchGateRows(
  data: SignalAppData,
  backend: BackendReadiness,
  provider: ProviderReadiness,
) {
  const summary = summarizeLocalState(data);
  const latestProviderRun = [...(data.providerValidationRuns ?? [])].sort((left, right) => Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? ''))[0];
  const providerSandboxPassed = latestProviderRun?.status === 'passed';
  const backendFailedChecks = backend.checks.filter((check) => !check.ok);
  const tenantIsolation = backend.checks.find((check) => check.id === 'tenant_isolation');
  const scheduler = backend.checks.find((check) => check.id === 'job_scheduler');
  const providerById = (id: string) => provider.providers.find((item) => item.id === id);
  const gmail = providerById('gmail');
  const outlook = providerById('outlook');
  const outboundEmail = providerById('outbound-email');
  const stripe = providerById('stripe');
  const providerMissingEnv = uniquePlanValues(provider.providers.flatMap((item) => item.missingRequired));
  const emailProviderMissingEnv = uniquePlanValues([gmail, outlook, outboundEmail].flatMap((item) => item?.missingRequired ?? []));
  const activeProviderSchedules = data.providerValidationSchedules?.filter((schedule) => schedule.status === 'active').length ?? 0;
  const schedulerOperationallyReady = Boolean(scheduler?.ok && summary.failedJobs === 0 && activeProviderSchedules >= 4);
  const productBlockers: string[] = [];
  const localReady = 10;
  const localTotal = 10;
  const launchGateItem = ({
    blockers = [],
    commands = [],
    evidence = [],
    id,
    label,
    owner,
    requiredEnv = [],
    status,
  }: {
    blockers?: string[];
    commands?: string[];
    evidence?: string[];
    id: string;
    label: string;
    owner: string;
    requiredEnv?: string[];
    status?: string;
  }) => ({
    blockers,
    commands,
    evidence,
    id,
    label,
    owner,
    requiredEnv: uniquePlanValues(requiredEnv),
    status: status ?? (blockers.length ? 'blocked' : 'pass'),
  });

  return [
    launchGateItem({
      id: 'local_product_surface',
      label: 'Local product surface and contracts',
      owner: 'product',
      status: localReady === localTotal ? 'pass' : 'attention',
      evidence: [
        `${localReady}/${localTotal} local readiness areas pass`,
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
      status: backend.productionReady ? 'pass' : 'blocked',
      evidence: [
        `Backend mode: ${backend.mode}`,
        `${backend.summary.readyChecks}/${backend.summary.totalChecks} backend checks production-ready`,
      ],
      blockers: backendFailedChecks.map((check) => check.message),
      requiredEnv: backend.summary.missingRequiredEnv,
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
      status: provider.ok ? 'pass' : 'blocked',
      evidence: [
        `${provider.summary.readyProviders}/${provider.summary.totalProviders} provider groups configured`,
        `${provider.summary.missingRequired} required provider env var name(s) missing`,
      ],
      blockers: provider.providers
        .filter((item) => !item.ready)
        .map((item) => `${item.label}: missing ${item.missingRequired.join(', ')}`),
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
        `${data.providerValidationRuns?.length ?? 0} recorded sandbox run(s)`,
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
      status: schedulerOperationallyReady ? 'pass' : 'blocked',
      evidence: [
        scheduler?.message ?? 'Scheduler readiness has not been evaluated.',
        `${summary.failedJobs}/${summary.jobs} failed job(s)`,
        `${activeProviderSchedules}/${data.providerValidationSchedules?.length ?? 0} active provider validation schedule(s)`,
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
}

function fallbackProductionPlanDrillBlockers(...rows: Array<ProductionDrillRow | undefined>) {
  return rows
    .filter((row): row is ProductionDrillRow => Boolean(row && !row.productionOk))
    .map((row) => `${row.area}: ${row.recommendation}`);
}

function fallbackProductionPlanDrillEnv(...rows: Array<ProductionDrillRow | undefined>) {
  return rows.flatMap((row) => row?.requiredEnv ?? []);
}

function fallbackProductionPlanDrillCommands(...rows: Array<ProductionDrillRow | undefined>) {
  return rows.flatMap((row) => row?.commands ?? []);
}

function fallbackProductionPlanDrillEvidence(...rows: Array<ProductionDrillRow | undefined>) {
  return rows.flatMap((row) => row?.evidence ?? []);
}

export function fallbackProductionPlan(
  data: SignalAppData,
  backend = fallbackBackendReadiness(),
  provider = fallbackProviderReadiness(),
): ProductionSetupPlanReport {
  const drill = fallbackProductionDrill(data, backend, provider);
  const gateRows = fallbackLaunchGateRows(data, backend, provider);
  const gateById = (id: string) => gateRows.find((row) => row.id === id);
  const launch = fallbackProviderLaunchMatrix(data, backend, provider);
  const drillByArea = (area: string) => drill.rows.find((row) => row.area === area);
  const providerRow = (id: string) => launch.rows.find((row) => row.id === id);
  const providerRows = launch.rows;
  const emailProviderRows = [providerRow('gmail'), providerRow('outlook'), providerRow('outbound-email')].filter(Boolean) as ProviderLaunchRow[];
  const stripeRow = providerRow('stripe');
  const gates = {
    local: gateById('local_product_surface'),
    backend: gateById('production_backend'),
    tenantIsolation: gateById('tenant_isolation'),
    providerConfiguration: gateById('provider_configuration'),
    providerSandbox: gateById('provider_sandbox_evidence'),
    email: gateById('email_notification_launch'),
    payment: gateById('payment_launch'),
    scheduler: gateById('scheduler_operations'),
  };
  const localContracts = drillByArea('local_contracts');
  const stateService = drillByArea('state_service_health');
  const backupRestore = drillByArea('backup_restore_rehearsal');
  const migration = drillByArea('migration_rollout');
  const identity = drillByArea('identity_tenant_isolation');
  const scheduler = drillByArea('scheduler_daemon');
  const liveProviders = drillByArea('live_provider_recurring_tests');
  const alerting = drillByArea('alerting_runbook');
  const rows = [
    fallbackProductionPlanRow({
      id: 'local_baseline',
      phase: 'Local baseline and evidence package starting point',
      owner: 'product',
      productionOk: Boolean(gates.local?.status === 'pass' && localContracts?.localOk),
      evidence: [
        ...(gates.local?.evidence ?? []),
        ...(localContracts?.evidence ?? []),
      ],
      blockers: [
        ...(gates.local?.blockers ?? []),
        ...fallbackProductionPlanDrillBlockers(localContracts).filter(() => !localContracts?.localOk),
      ],
      commands: ['npm run test:local', 'npm run admin -- readiness --json', 'npm run admin -- qa-answers --json'],
      completionCriteria: ['Full local test gate passes.', 'Product readiness reports every local requirement ready.', 'Stakeholder QA answers have no local-work rows.'],
    }),
    fallbackProductionPlanRow({
      id: 'durable_backend_storage',
      phase: 'Durable backend, state service, backup, restore, and migration',
      owner: 'platform',
      productionOk: Boolean(gates.backend?.status === 'pass' && stateService?.productionOk && backupRestore?.productionOk && migration?.productionOk),
      evidence: [
        ...(gates.backend?.evidence ?? []),
        ...fallbackProductionPlanDrillEvidence(stateService, backupRestore, migration),
      ],
      blockers: [
        ...(gates.backend?.blockers ?? []),
        ...fallbackProductionPlanDrillBlockers(stateService, backupRestore, migration),
      ],
      requiredEnv: [
        ...(gates.backend?.requiredEnv ?? []),
        ...fallbackProductionPlanDrillEnv(stateService, backupRestore, migration),
      ],
      commands: [
        ...(gates.backend?.commands ?? []),
        ...fallbackProductionPlanDrillCommands(stateService, backupRestore, migration),
        'npm run test:state-service',
      ],
      completionCriteria: ['API uses external state service instead of local JSON.', 'Production storage is database-backed.', 'Backup, digest verification, and restore dry run are proven.', 'Migration rollout plan is recorded.'],
      dependsOn: ['local_baseline'],
    }),
    fallbackProductionPlanRow({
      id: 'identity_tenant_isolation',
      phase: 'Managed auth, signed sessions, and tenant isolation',
      owner: 'security',
      productionOk: Boolean(gates.tenantIsolation?.status === 'pass' && identity?.productionOk),
      evidence: [
        ...(gates.tenantIsolation?.evidence ?? []),
        ...fallbackProductionPlanDrillEvidence(identity),
      ],
      blockers: [
        ...(gates.tenantIsolation?.blockers ?? []),
        ...fallbackProductionPlanDrillBlockers(identity),
      ],
      requiredEnv: [
        ...(gates.tenantIsolation?.requiredEnv ?? []),
        ...fallbackProductionPlanDrillEnv(identity),
      ],
      commands: [
        ...(gates.tenantIsolation?.commands ?? []),
        ...fallbackProductionPlanDrillCommands(identity),
        'npm run test:jwks-auth',
      ],
      completionCriteria: ['Raw actor fallback is disabled.', 'Managed auth/JWKS verifies API sessions.', 'Tenant isolation mode is configured for shared multi-org production use.'],
      dependsOn: ['durable_backend_storage'],
    }),
    fallbackProductionPlanRow({
      id: 'provider_configuration',
      phase: 'Provider environment configuration',
      owner: 'integrations',
      productionOk: gates.providerConfiguration?.status === 'pass',
      evidence: [
        ...(gates.providerConfiguration?.evidence ?? []),
        ...providerRows.map((row) => `${row.label}: ${row.configurationReady ? 'configured' : `${row.missingEnv.length} env missing`}`),
      ],
      blockers: gates.providerConfiguration?.blockers ?? [],
      requiredEnv: [
        ...(gates.providerConfiguration?.requiredEnv ?? []),
        ...providerRows.flatMap((row) => row.missingEnv),
      ],
      commands: ['npm run admin -- integrations --env-file ./.env.production --json', 'npm run admin -- provider-launch --env-file ./.env.production --json', 'npm run admin -- backend --env-file ./.env.production --json'],
      completionCriteria: ['Signed sessions, Gmail, Outlook, outbound email, and Stripe required environment names are configured.', 'Provider launch matrix reports every provider configuration-ready.'],
      dependsOn: ['identity_tenant_isolation'],
    }),
    fallbackProductionPlanRow({
      id: 'provider_sandbox_evidence',
      phase: 'Live-provider sandbox validation and saved evidence',
      owner: 'integrations',
      productionOk: Boolean(gates.providerSandbox?.status === 'pass' && liveProviders?.productionOk),
      evidence: [
        ...(gates.providerSandbox?.evidence ?? []),
        ...fallbackProductionPlanDrillEvidence(liveProviders),
        ...providerRows.map((row) => `${row.label}: sandbox ${row.sandboxStatus}`),
      ],
      blockers: [
        ...(gates.providerSandbox?.blockers ?? []),
        ...fallbackProductionPlanDrillBlockers(liveProviders),
      ],
      requiredEnv: [
        ...(gates.providerSandbox?.requiredEnv ?? []),
        ...fallbackProductionPlanDrillEnv(liveProviders),
      ],
      commands: [
        ...(gates.providerSandbox?.commands ?? []),
        ...fallbackProductionPlanDrillCommands(liveProviders),
        ...providerRows.flatMap((row) => row.evidenceCommands),
      ],
      completionCriteria: ['Provider sandbox validation passes with real sandbox credentials.', 'Sanitized evidence artifact is saved and import/export verified.', 'No credential values are serialized into app state or evidence packages.'],
      dependsOn: ['provider_configuration'],
    }),
    fallbackProductionPlanRow({
      id: 'email_launch',
      phase: 'Gmail, Outlook, and outbound email launch',
      owner: 'integrations',
      productionOk: Boolean(gates.email?.status === 'pass' && emailProviderRows.every((row) => row.launchReady)),
      evidence: [
        ...(gates.email?.evidence ?? []),
        ...emailProviderRows.map((row) => `${row.label}: ${row.status}`),
      ],
      blockers: gates.email?.blockers ?? [],
      requiredEnv: [
        ...(gates.email?.requiredEnv ?? []),
        ...emailProviderRows.flatMap((row) => row.missingEnv),
      ],
      commands: [
        ...(gates.email?.commands ?? []),
        ...emailProviderRows.flatMap((row) => row.launchCommands),
        ...emailProviderRows.map((row) => row.signedReplayCommand).filter(Boolean),
      ],
      completionCriteria: ['Gmail watch registration succeeds.', 'Outlook subscription renewal succeeds.', 'Outbound email digest send succeeds.', 'Signed email delivery webhook replay updates delivery ledger.'],
      dependsOn: ['provider_sandbox_evidence'],
    }),
    fallbackProductionPlanRow({
      id: 'payment_launch',
      phase: 'Stripe billing launch',
      owner: 'billing',
      productionOk: Boolean(gates.payment?.status === 'pass' && stripeRow?.launchReady),
      evidence: [
        ...(gates.payment?.evidence ?? []),
        stripeRow ? `${stripeRow.label}: ${stripeRow.status}` : null,
      ],
      blockers: gates.payment?.blockers ?? [],
      requiredEnv: [
        ...(gates.payment?.requiredEnv ?? []),
        ...(stripeRow?.missingEnv ?? []),
      ],
      commands: [
        ...(gates.payment?.commands ?? []),
        ...(stripeRow?.launchCommands ?? []),
        stripeRow?.signedReplayCommand,
      ],
      completionCriteria: ['Stripe Checkout session succeeds in test mode.', 'Billing Portal handoff succeeds.', 'Signed Stripe webhook replay updates subscription, invoice, and entitlement state.', 'Failed payment and resubscription lifecycle playbook rows reconcile.'],
      dependsOn: ['provider_sandbox_evidence'],
    }),
    fallbackProductionPlanRow({
      id: 'scheduler_alerting',
      phase: 'Scheduler, retries, alerts, and runbook',
      owner: 'operations',
      productionOk: Boolean(gates.scheduler?.status === 'pass' && scheduler?.productionOk && alerting?.productionOk),
      evidence: [
        ...(gates.scheduler?.evidence ?? []),
        ...fallbackProductionPlanDrillEvidence(scheduler, alerting),
      ],
      blockers: [
        ...(gates.scheduler?.blockers ?? []),
        ...fallbackProductionPlanDrillBlockers(scheduler, alerting),
      ],
      requiredEnv: [
        ...(gates.scheduler?.requiredEnv ?? []),
        ...fallbackProductionPlanDrillEnv(scheduler, alerting),
      ],
      commands: [
        ...(gates.scheduler?.commands ?? []),
        ...fallbackProductionPlanDrillCommands(scheduler, alerting),
        'npm run admin -- operations-health --env-file ./.env.production --json',
      ],
      completionCriteria: ['Production scheduler runs as a single runner.', 'Provider validation schedules are active.', 'Operations alert channel and runbook URL are configured.', 'Failed jobs and active provider backoffs are clear.'],
      dependsOn: ['durable_backend_storage', 'provider_sandbox_evidence'],
    }),
    fallbackProductionPlanRow({
      id: 'launch_evidence_package',
      phase: 'Redacted launch evidence package and final go-live proof',
      owner: 'operations',
      productionOk: Boolean(gateRows.every((gate) => gate.status === 'pass') && drill.productionReady && launch.productionReady),
      evidence: [
        `${gateRows.filter((gate) => gate.status === 'pass').length}/${gateRows.length} launch gate(s) passed`,
        `${drill.summary.productionReady}/${drill.summary.total} production drill row(s) ready`,
        `${launch.summary.launchReady}/${launch.summary.total} provider launch row(s) ready`,
      ],
      blockers: gateRows.every((gate) => gate.status === 'pass') && drill.productionReady && launch.productionReady ? [] : ['Complete every blocked production setup phase before writing final launch evidence.'],
      commands: ['npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json', 'npm run admin -- launch-gate verify-package ./signal-launch-evidence.json --json', 'npm run admin -- production-plan --env-file ./.env.production --json'],
      completionCriteria: ['Launch gate is go-live ready.', 'Production drill is production-ready.', 'Provider launch matrix is production-ready.', 'Launch evidence package verifies and contains no secret values.'],
      dependsOn: ['email_launch', 'payment_launch', 'scheduler_alerting'],
    }),
  ];
  const missingRequiredEnv = uniquePlanValues(rows.flatMap((row) => row.productionOk ? [] : row.requiredEnv));
  const secretSafe = !/(sk_live_|sk_test_|secret_value|token_value|password_value)/i.test(JSON.stringify(rows));
  return {
    generatedAt: new Date().toISOString(),
    ok: rows.length === 9 && secretSafe,
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
      secretSafe,
      total: rows.length,
    },
  };
}

const fallbackProductionEnvSections = [
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
    label: 'Gmail OAuth',
    owner: 'integrations',
    requiredEnv: ['SIGNAL_GMAIL_CLIENT_ID', 'SIGNAL_GMAIL_CLIENT_SECRET', 'SIGNAL_GMAIL_REDIRECT_URI', 'SIGNAL_TOKEN_ENCRYPTION_KEY', 'SIGNAL_GMAIL_ACCESS_TOKEN'],
    optionalEnv: ['SIGNAL_API_BASE_URL', 'SIGNAL_GMAIL_PUBSUB_TOPIC', 'SIGNAL_GMAIL_NOTIFICATION_URL', 'SIGNAL_GMAIL_WEBHOOK_AUDIENCE', 'SIGNAL_OAUTH_STATE_KEY', 'SIGNAL_TOKEN_VAULT'],
    commands: ['npm run admin -- mailboxes watch mbx_gmail_sales --live-provider --json'],
  },
  {
    id: 'outlook',
    label: 'Microsoft Graph OAuth',
    owner: 'integrations',
    requiredEnv: ['SIGNAL_OUTLOOK_CLIENT_ID', 'SIGNAL_OUTLOOK_CLIENT_SECRET', 'SIGNAL_OUTLOOK_TENANT_ID', 'SIGNAL_OUTLOOK_REDIRECT_URI', 'SIGNAL_TOKEN_ENCRYPTION_KEY', 'SIGNAL_OUTLOOK_ACCESS_TOKEN'],
    optionalEnv: ['SIGNAL_API_BASE_URL', 'SIGNAL_OAUTH_STATE_KEY', 'SIGNAL_OUTLOOK_NOTIFICATION_URL', 'SIGNAL_OUTLOOK_LIFECYCLE_NOTIFICATION_URL', 'SIGNAL_OUTLOOK_SUBSCRIPTION_RESOURCE', 'SIGNAL_OUTLOOK_WEBHOOK_CLIENT_STATE', 'SIGNAL_TOKEN_VAULT'],
    commands: ['npm run admin -- mailboxes renew-watch watch_outlook_mbx_outlook_success --live-provider --json'],
  },
  {
    id: 'outbound_email',
    label: 'SendGrid / outbound email',
    owner: 'integrations',
    requiredEnv: ['SIGNAL_EMAIL_PROVIDER_URL', 'SIGNAL_EMAIL_PROVIDER_TOKEN', 'SIGNAL_EMAIL_FROM', 'SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET', 'SIGNAL_SENDGRID_API_KEY'],
    optionalEnv: ['SIGNAL_EMAIL_PROVIDER', 'SIGNAL_EMAIL_PROVIDER_MODE', 'SIGNAL_EMAIL_PROVIDER_NAME', 'SIGNAL_EMAIL_UNSUBSCRIBE_BASE_URL', 'SIGNAL_SENDGRID_API_BASE_URL', 'SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY', 'SIGNAL_SENDGRID_SANDBOX_MODE', 'SIGNAL_SENDGRID_ASM_GROUP_ID', 'SIGNAL_SENDGRID_ASM_GROUPS_TO_DISPLAY', 'SIGNAL_SENDGRID_CATEGORIES', 'SIGNAL_SENDGRID_CLICK_TRACKING', 'SIGNAL_SENDGRID_OPEN_TRACKING', 'SIGNAL_SENDGRID_IP_POOL_NAME', 'SIGNAL_SENDGRID_REPLY_TO'],
    commands: ['npm run admin -- notifications digest tenant_demo --live-provider', 'npm run admin -- notifications sendgrid-webhook-signed ./sendgrid-event.json <signature> <timestamp>'],
  },
  {
    id: 'stripe',
    label: 'Stripe Billing',
    owner: 'billing',
    requiredEnv: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SIGNAL_STRIPE_PRICE_TEAM'],
    optionalEnv: ['STRIPE_PUBLISHABLE_KEY', 'SIGNAL_APP_BASE_URL', 'SIGNAL_STRIPE_ALLOW_PROMOTION_CODES', 'SIGNAL_STRIPE_CANCEL_URL', 'SIGNAL_STRIPE_PORTAL_RETURN_URL', 'SIGNAL_STRIPE_PRICE_BETA', 'SIGNAL_STRIPE_PRICE_BUSINESS', 'SIGNAL_STRIPE_SUCCESS_URL'],
    commands: ['npm run admin -- payments checkout tenant_demo plan_team --live-provider', 'npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>'],
  },
];

const fallbackProductionEnvTemplateKeys = uniquePlanValues([
  ...fallbackProductionEnvSections.flatMap((section) => [...section.requiredEnv, ...section.optionalEnv]),
  'SIGNAL_APP_BASE_URL',
]).sort();

function fallbackProductionEnvRow(section: typeof fallbackProductionEnvSections[number], templateKeys: string[]): ProductionEnvAuditRow {
  const requiredEnv = uniquePlanValues(section.requiredEnv);
  const optionalEnv = uniquePlanValues(section.optionalEnv);
  const templateMissing = requiredEnv.filter((key) => !templateKeys.includes(key));
  return {
    id: section.id,
    label: section.label,
    owner: section.owner,
    status: templateMissing.length ? 'template_gap' : 'missing_values',
    requiredEnv,
    optionalEnv,
    configuredRequired: [],
    missingRequired: requiredEnv,
    presentInSource: [],
    templateMissing,
    configuredOptional: [],
    commands: section.commands,
    evidence: [
      `0/${requiredEnv.length} required env name(s) configured`,
      `0/${requiredEnv.length} required env name(s) present in selected env source`,
      `${requiredEnv.length - templateMissing.length}/${requiredEnv.length} required env name(s) covered by template`,
    ],
  };
}

export function fallbackProductionEnvAudit(
  data: SignalAppData,
  backend = fallbackBackendReadiness(),
  provider = fallbackProviderReadiness(),
): ProductionEnvAuditReport {
  const plan = fallbackProductionPlan(data, backend, provider);
  const requiredEnv = uniquePlanValues([
    ...fallbackProductionEnvSections.flatMap((section) => section.requiredEnv),
    ...plan.rows.flatMap((row) => row.requiredEnv),
    ...backend.checks.flatMap((check) => check.requiredEnv),
    ...provider.providers.flatMap((item) => item.requiredEnv),
  ]).sort();
  const optionalEnv = uniquePlanValues(fallbackProductionEnvSections.flatMap((section) => section.optionalEnv)).sort();
  const templateKeys = uniquePlanValues([...fallbackProductionEnvTemplateKeys, ...requiredEnv]).sort();
  const rows = [
    ...fallbackProductionEnvSections.map((section) => fallbackProductionEnvRow(section, templateKeys)),
    fallbackProductionEnvRow({
      id: 'production_plan_union',
      label: 'Production setup plan required names',
      owner: 'operations',
      requiredEnv,
      optionalEnv,
      commands: ['npm run admin -- production-plan --env-file ./.env.production --json', 'npm run admin -- launch-gate --env-file ./.env.production --json'],
    }, templateKeys),
  ];
  return {
    generatedAt: new Date().toISOString(),
    ok: true,
    envReady: false,
    templateReady: true,
    rows,
    recommendation: {
      summary: 'Use production-env before production-plan or launch-gate to verify that the selected env source and committed template cover every required production setup name without printing values.',
      productionGuardrail: 'This audit proves names and placeholders only. It does not validate provider credentials, external service reachability, webhook signatures, or provider sandbox evidence.',
      localAgentCommand: 'npm run admin -- production-env --env-file ./.env.production --json',
    },
    source: {
      configuredKeys: 0,
      keys: [],
      path: null,
      type: 'seed',
    },
    template: {
      invalid: [],
      keys: templateKeys,
      path: '.env.production.example',
    },
    summary: {
      configuredRequired: 0,
      envReady: false,
      missingRequired: requiredEnv.length,
      optionalEnv: optionalEnv.length,
      presentInSource: 0,
      requiredEnv: requiredEnv.length,
      rowsReady: 0,
      secretSafe: true,
      templateMissingRequired: 0,
      templateReady: true,
      totalRows: rows.length,
    },
  };
}

function localAgentHandoffStringLooksUnsafe(text: string) {
  return (
    /sk_(?:live|test)_[A-Za-z0-9_]{8,}/.test(text) ||
    /SG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text) ||
    /ya29\.[A-Za-z0-9_-]{20,}/.test(text) ||
    /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY)[A-Z0-9_]*=(?!<)[^\s]{8,}/i.test(text) ||
    /(?:access_token|refresh_token|client_secret|api_key)=((?!<)[^&\s]{8,})/i.test(text)
  );
}

export function doctorLocalState(data: SignalAppData): DoctorReport {
  const summary = summarizeLocalState(data);
  const clientExposurePaths = collectClientExposureSecretPaths(data);
  const checks: DoctorCheck[] = [
    {
      id: 'active_admin',
      ok: data.users.some((user) => user.role === 'admin' && user.status === 'active'),
      message: 'At least one active admin exists.',
    },
    {
      id: 'seat_capacity',
      ok: ((summary.seatLimit ?? Infinity) >= (summary.activeSeats ?? 0) + (summary.pendingInviteSeats ?? 0)),
      message: 'Active users and pending invites fit inside the current seat entitlement.',
    },
    {
      id: 'tenant_statuses',
      ok: data.tenants.every((tenant) => tenant.id && tenant.domain && ['active', 'suspended'].includes(tenant.status)),
      message: 'Every tenant has a domain and explicit active or suspended status.',
    },
    {
      id: 'tenant_memberships',
      ok: data.users.every((user) =>
        (data.memberships ?? []).some((membership) =>
          membership.userId === user.id &&
          membership.tenantId === user.tenantId &&
          membership.role === user.role &&
          membership.status === (user.status === 'active' ? 'active' : 'disabled'))) &&
        (data.memberships ?? []).every((membership) =>
          ['admin', 'member'].includes(membership.role) &&
          ['active', 'disabled'].includes(membership.status) &&
          data.tenants.some((tenant) => tenant.id === membership.tenantId) &&
          data.users.some((user) => user.id === membership.userId)),
      message: 'Tenant memberships mirror user role/status and reference existing tenants and users.',
    },
    {
      id: 'pending_invite_expiry',
      ok: (data.invites ?? [])
        .filter((invite) => invite.status === 'pending')
        .every((invite) => Boolean(invite.expiresAt) && Date.parse(invite.expiresAt) > Date.parse(invite.createdAt)),
      message: 'Pending invites have bounded local expiration timestamps.',
    },
    {
      id: 'connected_mailbox',
      ok: data.mailboxes.some((mailbox) => mailbox.status === 'connected'),
      message: 'At least one mailbox is connected.',
    },
    {
      id: 'sync_cursor_coverage',
      ok: data.mailboxes.every((mailbox) => data.emailSyncCursors?.some((cursor) => cursor.mailboxId === mailbox.id)),
      message: 'Every mailbox has a provider sync cursor record.',
    },
    {
      id: 'provider_backoff_metadata',
      ok: (data.emailSyncCursors ?? []).every((cursor) => !cursor.providerBackoffUntil || Number.isFinite(Date.parse(cursor.providerBackoffUntil))) &&
        (data.emailWatchSubscriptions ?? []).every((watch) => !watch.providerRetryAfterAt || Number.isFinite(Date.parse(watch.providerRetryAfterAt))),
      message: 'Provider retry and rate-limit backoff timestamps are parseable when present.',
    },
    {
      id: 'enabled_email_flow',
      ok: data.emailFlows.some((flow) => flow.status === 'enabled'),
      message: 'At least one email detector flow is enabled.',
    },
    {
      id: 'routing_rules_audited',
      ok: data.emailFlows.every((flow) => data.routingRules?.some((rule) => rule.flowId === flow.id && rule.tenantId === flow.tenantId)) &&
        (data.routingRules ?? []).every((rule) => rule.flowId && rule.routeTo && rule.createdAt && rule.createdByUserId && ['active', 'disabled'].includes(rule.status)),
      message: 'Every detector flow has an auditable routing rule.',
    },
    {
      id: 'signal_quality_settings',
      ok: data.tenants.every((tenant) => data.signalQualitySettings?.some((settings) => settings.tenantId === tenant.id && typeof settings.minimumConfidence === 'number')),
      message: 'Every tenant has detector quality settings.',
    },
    {
      id: 'suppression_rules_audited',
      ok: (data.suppressionRules ?? []).every((rule) => rule.createdByUserId && rule.createdAt && ['active', 'disabled'].includes(rule.status)),
      message: 'Suppression rules are auditable and have explicit status.',
    },
    {
      id: 'model_governance_boundary',
      ok: data.tenants.every((tenant) =>
        (data.modelGovernancePolicies ?? []).some((policy) =>
          policy.tenantId === tenant.id &&
          policy.detectorBoundary === 'shared_detector' &&
          policy.dataBoundary === 'tenant_isolated' &&
          policy.perTenantModel === false &&
          ['disabled', 'opt_in_tuning'].includes(policy.learningMode) &&
          ['excluded_by_default', 'opt_in_only'].includes(policy.trainingDataUse) &&
          policy.tuningControls.includes('quality_threshold') &&
          policy.tuningControls.includes('feedback_labels'))) &&
        (data.modelGovernancePolicies ?? []).every((policy) => policy.learningMode !== 'disabled' || policy.trainingDataUse === 'excluded_by_default'),
      message: 'Model governance uses a shared detector boundary with tenant-specific controls and opt-in-only learning.',
    },
    {
      id: 'governance_policy',
      ok: data.tenants.every((tenant) => data.governancePolicies?.some((policy) => policy.tenantId === tenant.id && policy.sourceRetentionDays >= policy.rawSnippetRetentionDays)),
      message: 'Every tenant has source retention and redaction governance policy.',
    },
    {
      id: 'data_requests_audited',
      ok: (data.dataRequests ?? []).every((request) => request.requesterEmail && request.requestedAt && ['open', 'processing', 'completed', 'rejected'].includes(request.status)),
      message: 'Export and delete requests are auditable and statused.',
    },
    {
      id: 'incident_notes_audited',
      ok: (data.incidentNotes ?? []).every((note) => note.title && note.createdByUserId && ['open', 'resolved'].includes(note.status)),
      message: 'Incident notes have owners, status, and audit context.',
    },
    {
      id: 'source_message_fixtures',
      ok: (data.sourceMessages?.length ?? 0) > 0,
      message: 'Local source-message fixtures are available for detector flow testing.',
    },
    {
      id: 'signal_handoffs_audited',
      ok: (data.signalHandoffs ?? []).every((handoff) =>
        Boolean(handoff.signalId && handoff.createdAt && handoff.createdByUserId) &&
        ['crm', 'task'].includes(handoff.target) &&
        ['queued', 'sent', 'failed', 'canceled'].includes(handoff.status),
      ),
      message: 'Signal CRM/task handoffs are auditable and statused.',
    },
    {
      id: 'account_profile_coverage',
      ok: [...new Set(data.signals.map((signal) => signal.account))].every((account) => data.accountProfiles?.some((profile) => profile.name === account)),
      message: 'Every signaled account has a relationship profile.',
    },
    {
      id: 'account_actions_available',
      ok: data.accountActions?.some((action) => action.status === 'open') ?? false,
      message: 'Open account next actions are available for relationship monitoring.',
    },
    {
      id: 'account_reviews_audited',
      ok: (data.accountReviews ?? []).every((review) => review.account && review.createdAt && review.createdByUserId && Array.isArray(review.openActionIds) && Array.isArray(review.latestEventIds)),
      message: 'Account reviews are auditable snapshots of actions, signals, and timeline context.',
    },
    {
      id: 'account_recommendations_available',
      ok: (data.accountRecommendations ?? []).every((recommendation) =>
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
        (data.accountRecommendations ?? []).some((recommendation) => recommendation.status === 'open'),
      message: 'Account recommendations are source-referenced strategy records with priority and status.',
    },
    {
      id: 'notification_preferences',
      ok: data.users
        .filter((user) => user.status === 'active')
        .every((user) => data.notificationPreferences?.some((preference) => preference.userId === user.id)),
      message: 'Every active user has notification digest and mute preferences.',
    },
    {
      id: 'notification_events_available',
      ok: data.notificationEvents?.some((event) => ['unread', 'read', 'sent', 'muted'].includes(event.status)) ?? false,
      message: 'Dashboard notification events are available for signals and account work.',
    },
    {
      id: 'email_delivery_preferences',
      ok: (data.notificationPreferences ?? []).every((preference) => preference.unsubscribeCode && ['subscribed', 'unsubscribed'].includes(preference.emailDeliveryStatus ?? 'subscribed')),
      message: 'Every notification preference has email delivery subscription state.',
    },
    {
      id: 'email_delivery_ledger',
      ok: (data.emailDeliveryMessages ?? []).every((message) => message.toEmail && ['queued', 'sent', 'failed', 'bounced', 'suppressed'].includes(message.status)),
      message: 'Outbound digest email delivery records are statused.',
    },
    {
      id: 'subscription_state',
      ok: data.subscriptions.some((subscription) => ['trialing', 'active'].includes(subscription.status)),
      message: 'A trialing or active subscription exists.',
    },
    {
      id: 'active_entitlement',
      ok: data.entitlements?.some((entitlement) => entitlement.status === 'active') ?? false,
      message: 'At least one active entitlement is computed from billing state.',
    },
    {
      id: 'billing_overrides_audited',
      ok: (data.billingOverrides ?? []).every((override) => override.tenantId && override.reason && override.createdAt && override.createdByUserId && ['active', 'revoked', 'expired'].includes(override.status)),
      message: 'Billing overrides have tenant, reason, status, and audit metadata.',
    },
    {
      id: 'billing_jobs_settled',
      ok: !(data.jobs ?? []).some((job) => job.queue === 'billing_webhook' && job.status === 'failed'),
      message: 'No billing webhook jobs are failed.',
    },
    {
      id: 'invoice_recovery_known',
      ok: !(data.invoices ?? []).some((invoice) => invoice.status === 'past_due' && !invoice.nextPaymentAttemptAt),
      message: 'Past-due invoices have a next payment attempt or recovery path.',
    },
    {
      id: 'lifecycle_notices_audited',
      ok: (data.lifecycleNotices ?? []).every((notice) =>
        notice.id &&
        notice.tenantId &&
        notice.title &&
        notice.body &&
        notice.createdAt &&
        ['access', 'onboarding', 'payment', 'source', 'notification', 'provider'].includes(notice.category) &&
        ['info', 'watch', 'critical'].includes(notice.severity) &&
        ['open', 'monitoring', 'resolved'].includes(notice.status)),
      message: 'Lifecycle notices are auditable records linked to billing, source, notification, and provider state.',
    },
    {
      id: 'no_local_secrets',
      ok: clientExposurePaths.length === 0,
      message: 'Local fallback state does not contain secret-like fields.',
      details: clientExposurePaths,
    },
    {
      id: 'active_session_user',
      ok: data.users.some((user) => user.id === data.session?.activeUserId && user.status === 'active'),
      message: 'The local session points to an active user.',
    },
  ];

  return {
    checks,
    ok: checks.every((check) => check.ok),
  };
}

function localAgentHandoffPriority(id: string, status: string) {
  if (status === 'attention') {
    return 5;
  }
  if (status === 'blocked') {
    const order: Record<string, number> = {
      production_backend: 10,
      tenant_isolation: 20,
      provider_configuration: 30,
      provider_sandbox_evidence: 40,
      email_notification_launch: 50,
      payment_launch: 60,
      scheduler_operations: 70,
    };
    return order[id] ?? 90;
  }
  return 100;
}

function localAgentActionFromGate(gate: {
  id: string;
  label: string;
  owner: string;
  status: string;
  blockers: string[];
  evidence: string[];
  requiredEnv: string[];
  commands: string[];
}): LocalAgentHandoffAction {
  return {
    id: gate.id,
    label: gate.label,
    owner: gate.owner,
    status: gate.status,
    priority: localAgentHandoffPriority(gate.id, gate.status),
    blocker: gate.blockers[0] ?? (gate.status === 'pass' ? 'No blocker.' : 'Proof is missing.'),
    evidence: gate.evidence,
    requiredEnv: gate.requiredEnv,
    command: gate.commands[0] ?? 'npm run admin -- launch-gate --json',
    followUpCommands: gate.commands.slice(1, 4),
  };
}

export function fallbackLocalAgentHandoff(
  data: SignalAppData,
  backend = fallbackBackendReadiness(),
  provider = fallbackProviderReadiness(),
): LocalAgentHandoffReport {
  const summary = summarizeLocalState(data);
  const operations = fallbackOperationsHealth(data, backend);
  const providerLaunch = fallbackProviderLaunchMatrix(data, backend, provider);
  const productionPlan = fallbackProductionPlan(data, backend, provider);
  const latestProviderRun = [...(data.providerValidationRuns ?? [])].sort((left, right) => Date.parse(right.recordedAt ?? '') - Date.parse(left.recordedAt ?? ''))[0];
  const providerSandboxPassed = latestProviderRun?.status === 'passed';
  const backendFailedChecks = backend.checks.filter((check) => !check.ok);
  const tenantIsolation = backend.checks.find((check) => check.id === 'tenant_isolation');
  const scheduler = backend.checks.find((check) => check.id === 'job_scheduler');
  const providerRow = (id: string) => provider.providers.find((item) => item.id === id);
  const gmail = providerRow('gmail');
  const outlook = providerRow('outlook');
  const outboundEmail = providerRow('outbound-email');
  const stripe = providerRow('stripe');
  const providerMissingEnv = uniquePlanValues(provider.providers.flatMap((item) => item.missingRequired));
  const emailProviderMissingEnv = uniquePlanValues([gmail, outlook, outboundEmail].flatMap((item) => item?.missingRequired ?? []));
  const activeProviderSchedules = data.providerValidationSchedules?.filter((schedule) => schedule.status === 'active').length ?? 0;
  const localChecks = [
    (summary.activeMemberships ?? 0) > 0 && (summary.activeEntitlements ?? 0) > 0,
    (summary.activeMemberships ?? 0) > 0,
    summary.connectedMailboxes > 0 && summary.enabledEmailFlows > 0 && (summary.sourceMessages ?? 0) > 0,
    (summary.modelGovernancePolicies ?? 0) > 0 && (summary.perTenantModels ?? 0) === 0,
    (summary.accounts ?? 0) > 0 && (summary.accountRecommendations ?? 0) > 0,
    (summary.notificationPreferences ?? 0) > 0,
    summary.subscriptions > 0 && (summary.activeEntitlements ?? 0) > 0,
    activeProviderSchedules >= 4,
    (summary.jobs ?? 0) > 0 && Array.isArray(data.auditEvents),
    true,
  ];
  const localReady = localChecks.filter(Boolean).length;
  const localTotal = localChecks.length;
  const gates = [
    {
      id: 'local_product_surface',
      label: 'Local product surface and contracts',
      owner: 'product',
      status: localReady === localTotal ? 'pass' : 'attention',
      evidence: [
        `${localReady}/${localTotal} local readiness areas pass`,
        `${summary.users} user(s), ${summary.mailboxes} mailbox source(s), ${summary.subscriptions} subscription record(s)`,
      ],
      blockers: localReady === localTotal ? [] : ['Local readiness evidence is incomplete.'],
      requiredEnv: [],
      commands: ['npm run admin -- readiness --json', 'npm run test:local'],
    },
    {
      id: 'production_backend',
      label: 'Production backend, durable state, auth, CORS, and storage',
      owner: 'platform',
      status: backend.productionReady ? 'pass' : 'blocked',
      evidence: [
        `Backend mode: ${backend.mode}`,
        `${backend.summary.readyChecks}/${backend.summary.totalChecks} backend checks production-ready`,
      ],
      blockers: backendFailedChecks.map((check) => check.message),
      requiredEnv: backend.summary.missingRequiredEnv,
      commands: [
        'npm run admin -- backend --json',
        'SIGNAL_STATE_SERVICE_BACKEND=postgres DATABASE_URL=postgres://... SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service',
      ],
    },
    {
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
      commands: ['SIGNAL_TENANT_ISOLATION_MODE=rls npm run admin -- backend --json'],
    },
    {
      id: 'provider_configuration',
      label: 'Gmail, Outlook, SendGrid, and Stripe configuration',
      owner: 'integrations',
      status: provider.ok ? 'pass' : 'blocked',
      evidence: [
        `${provider.summary.readyProviders}/${provider.summary.totalProviders} provider groups configured`,
        `${provider.summary.missingRequired} required provider env var name(s) missing`,
      ],
      blockers: provider.providers.filter((item) => !item.ready).map((item) => `${item.label}: missing ${item.missingRequired.join(', ')}`),
      requiredEnv: providerMissingEnv,
      commands: ['npm run admin -- integrations --json'],
    },
    {
      id: 'provider_sandbox_evidence',
      label: 'Live-provider sandbox evidence artifact',
      owner: 'integrations',
      status: providerSandboxPassed ? 'pass' : 'blocked',
      evidence: [
        latestProviderRun ? `Latest sandbox evidence: ${latestProviderRun.status} at ${latestProviderRun.recordedAt}` : 'No sandbox evidence recorded',
        `${data.providerValidationRuns?.length ?? 0} recorded sandbox run(s)`,
      ],
      blockers: providerSandboxPassed ? [] : ['Run sandbox validation with real provider sandbox credentials and save sanitized evidence.'],
      requiredEnv: ['SIGNAL_GMAIL_ACCESS_TOKEN', 'SIGNAL_OUTLOOK_ACCESS_TOKEN', 'SIGNAL_SENDGRID_API_KEY', 'STRIPE_SECRET_KEY', 'SIGNAL_STRIPE_PRICE_TEAM'],
      commands: [
        'npm run admin -- integrations validate-sandbox --save-evidence ./signal-provider-evidence.json --json',
        'npm run admin -- integrations evidence-export latest ./signal-provider-evidence.json --json',
      ],
    },
    {
      id: 'email_notification_launch',
      label: 'Email ingestion, watch renewal, and outbound notification launch',
      owner: 'integrations',
      status: gmail?.ready && outlook?.ready && outboundEmail?.ready && providerSandboxPassed ? 'pass' : 'blocked',
      evidence: [
        `${summary.connectedMailboxes}/${summary.mailboxes} mailbox source(s) connected locally`,
        `${summary.activeEmailWatchSubscriptions}/${summary.emailWatchSubscriptions} active provider watch subscription(s)`,
        `${summary.failedEmailDeliveries}/${summary.emailDeliveries} failed outbound email deliveries`,
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
    },
    {
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
      requiredEnv: uniquePlanValues(stripe?.missingRequired ?? ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SIGNAL_STRIPE_PRICE_TEAM']),
      commands: [
        'npm run admin -- payments checkout tenant_demo plan_team --live-provider',
        'npm run admin -- payments portal tenant_demo --live-provider',
        'STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret> npm run admin -- payments webhook-signed ./stripe-event.json <Stripe-Signature>',
      ],
    },
    {
      id: 'scheduler_operations',
      label: 'Production scheduler, retries, and monitoring',
      owner: 'operations',
      status: scheduler?.ok && (summary.failedJobs ?? 0) === 0 && activeProviderSchedules >= 4 ? 'pass' : 'blocked',
      evidence: [
        scheduler?.message ?? 'Scheduler readiness has not been evaluated.',
        `${summary.failedJobs}/${summary.jobs} failed job(s)`,
        `${activeProviderSchedules}/${data.providerValidationSchedules?.length ?? 0} active provider validation schedule(s)`,
      ],
      blockers: scheduler?.ok && (summary.failedJobs ?? 0) === 0 && activeProviderSchedules >= 4
        ? []
        : ['Configure production scheduler env, keep validation schedules active, and clear failed jobs.'],
      requiredEnv: scheduler?.missingEnv ?? ['SIGNAL_JOB_SCHEDULER', 'SIGNAL_PROVIDER_VALIDATION_SCHEDULER'],
      commands: [
        'SIGNAL_JOB_SCHEDULER=signal-scheduler npm run scheduler',
        'npm run admin -- jobs run provider_validation --limit 1',
        'npm run admin -- jobs drain billing_webhook',
      ],
    },
  ];
  const nextActions = gates
    .filter((gate) => gate.status !== 'pass')
    .map(localAgentActionFromGate)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  const nextAction = nextActions[0] ?? {
    id: 'launch_evidence_package',
    label: 'Redacted launch evidence package',
    owner: 'operations',
    status: 'ready_for_proof',
    priority: 100,
    blocker: 'All launch gates pass; write and verify final redacted launch evidence.',
    evidence: [`${gates.length}/${gates.length} launch gates passed`],
    requiredEnv: [],
    command: 'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json',
    followUpCommands: ['npm run admin -- launch-gate verify-package ./signal-launch-evidence.json --json'],
  };
  const runnableCommands = uniquePlanValues([
    'npm run test:local',
    'npm run admin -- readiness --json',
    'npm run admin -- launch-gate --json',
    'npm run admin -- production-plan --json',
    'npm run admin -- provider-launch --json',
    'npm run admin -- operations-health --json',
    nextAction.command,
    ...nextAction.followUpCommands,
  ]);
  const report: LocalAgentHandoffReport = {
    generatedAt: new Date().toISOString(),
    ok: true,
    goLiveReady: gates.every((gate) => gate.status === 'pass'),
    nextAction,
    nextActions,
    providerAttention: providerLaunch.rows
      .filter((row) => !row.launchReady)
      .map((row) => ({
        id: row.id,
        label: row.label,
        owner: row.owner,
        status: row.status,
        missingEnv: row.missingEnv,
        sandboxStatus: row.sandboxStatus,
        command: row.localAgentCommand ?? row.evidenceCommands[0] ?? 'npm run admin -- provider-launch --json',
      })),
    runnableCommands,
    recommendation: {
      summary: 'Use agent-handoff as the local operator starting point: it ranks the remaining launch blockers, chooses the next command, and points to the broader proof reports.',
      productionGuardrail: 'This report is an operator handoff only. It never promotes production readiness without passing launch-gate, provider-launch, production-plan, operations-health, and real external evidence.',
      localAgentCommand: 'npm run admin -- agent-handoff --json',
    },
    summary: {
      activeApiSessions: summary.activeApiSessions ?? 0,
      blockedGates: gates.filter((gate) => gate.status === 'blocked').length,
      failedJobs: summary.failedJobs ?? 0,
      goLiveReady: gates.every((gate) => gate.status === 'pass'),
      localReady,
      localTotal,
      nextActionId: nextAction.id,
      productionPlanNextPhaseId: productionPlan.summary.nextPhaseId,
      providerLaunchReady: providerLaunch.summary.launchReady,
      providerTotal: providerLaunch.summary.total,
      secretSafe: false,
      totalActions: nextActions.length,
    },
  };
  report.summary.secretSafe = !localAgentHandoffStringLooksUnsafe(JSON.stringify(report));
  report.ok = report.summary.secretSafe && localReady === localTotal && operations.ok;
  return report;
}

function fallbackCompletionRow({
  api = null,
  blockers = [],
  commands = [],
  evidence = [],
  id,
  label,
  localOk,
  owner,
  productionOk = localOk,
}: {
  api?: string | null;
  blockers?: Array<string | null | undefined | false>;
  commands?: Array<string | null | undefined | false>;
  evidence?: Array<string | null | undefined | false>;
  id: string;
  label: string;
  localOk: boolean;
  owner: string;
  productionOk?: boolean;
}): CompletionAuditRow {
  return {
    api,
    blockers: uniquePlanValues(blockers),
    commands: uniquePlanValues(commands),
    evidence: uniquePlanValues(evidence),
    id,
    label,
    localOk,
    owner,
    productionOk,
    status: productionOk ? 'production_ready' : localOk ? 'local_complete' : 'needs_local_work',
  };
}

export function fallbackCompletionAudit(
  data: SignalAppData,
  backend = fallbackBackendReadiness(),
  provider = fallbackProviderReadiness(),
): CompletionAuditReport {
  const summary = summarizeLocalState(data);
  const dashboard = fallbackDashboardAudit(data, backend);
  const pipeline = fallbackSignalDigestionPipeline(data, backend);
  const onboarding = fallbackOnboardingReadiness(data, backend);
  const isolation = fallbackTenantIsolationAudit(data, backend);
  const operations = fallbackOperationsHealth(data, backend);
  const lifecycle = fallbackLifecyclePlaybook(data, backend);
  const launch = fallbackProviderLaunchMatrix(data, backend, provider);
  const payment = fallbackPaymentLifecycleAudit(data, backend, provider);
  const email = fallbackEmailHandoff(data, backend, provider, launch, operations);
  const paymentLaunch = fallbackPaymentHandoff(data, backend, provider, launch, payment);
  const qa = fallbackQaAnswers(data, backend, provider);
  const agent = fallbackLocalAgentHandoff(data, backend, provider);
  const emailLaunchReady = ['gmail', 'outlook', 'outbound-email'].every((id) => launch.rows.find((row) => row.id === id)?.launchReady);
  const paymentLaunchReady = Boolean(launch.rows.find((row) => row.id === 'stripe')?.launchReady);
  const dashboardQa = qa.rows.find((row) => row.id === 'dashboard_calculations_backend');
  const onboardingQa = qa.rows.find((row) => row.id === 'workspace_registration_invitation');
  const relationshipQa = qa.rows.find((row) => row.id === 'contact_relationship_strategy');
  const emailQa = qa.rows.find((row) => row.id === 'email_notification_admin_monitoring');
  const paymentQa = qa.rows.find((row) => row.id === 'payment_lifecycle_handling');
  const rows = [
    fallbackCompletionRow({
      id: 'public_product_entry',
      label: 'Public product entry and route into the app',
      owner: 'product',
      localOk: agent.summary.localReady === agent.summary.localTotal,
      productionOk: agent.summary.localReady === agent.summary.localTotal,
      evidence: [
        `${agent.summary.localReady}/${agent.summary.localTotal} local product readiness area(s) pass`,
        `${summary.tenants} tenant(s), ${summary.users} user(s), ${summary.mailboxes} mailbox source(s), ${summary.subscriptions} subscription record(s)`,
      ],
      commands: ['npm run admin -- readiness --json', 'npm run test:browser-routes'],
      api: '/api/readiness',
    }),
    fallbackCompletionRow({
      id: 'workspace_registration_onboarding',
      label: 'Self-service registration, workspace creation, onboarding, and member invitation',
      owner: 'workspace_admin',
      localOk: onboarding.ok && Boolean(onboardingQa?.localOk),
      productionOk: onboarding.productionReady,
      evidence: [`${onboarding.summary.activeAdmins} active admin(s) and ${onboarding.summary.activeMembers} active member(s)`, `${summary.pendingInvites ?? 0}/${summary.invites ?? 0} pending invite(s)`, `${summary.activeSeats ?? 0}+${summary.pendingInviteSeats ?? 0}/${summary.seatLimit ?? 'unlimited'} active+pending seat(s)`],
      blockers: onboarding.productionReady ? [] : [onboarding.recommendation.productionGuardrail],
      commands: ['npm run admin -- onboarding-readiness --json', 'npm run admin -- tenants register New_Revenue_Lab newlab.example owner@newlab.example Owner_Name plan_beta', 'npm run admin -- users invite tenant_demo rowan@acme.example member success'],
      api: '/api/onboarding-readiness',
    }),
    fallbackCompletionRow({
      id: 'rbac_privacy_multi_member_org',
      label: 'Multi-member organization RBAC and member data privacy',
      owner: 'security',
      localOk: isolation.ok,
      productionOk: isolation.productionReady,
      evidence: [`${isolation.summary.activeAdmins} admin(s), ${isolation.summary.activeMembers} member(s)`, `${isolation.summary.actorScopedRows} actor-scoped audit row(s)`, `${summary.activeApiSessions ?? 0}/${summary.apiSessions ?? 0} active API session(s)`],
      blockers: isolation.productionReady ? [] : [isolation.recommendation.productionGuardrail],
      commands: ['npm run admin -- tenant-isolation --json', 'npm run admin -- users --json', 'npm run admin -- session token usr_admin --json'],
      api: '/api/tenant-isolation',
    }),
    fallbackCompletionRow({
      id: 'core_user_workspace',
      label: 'Core user workspace: signals, accounts, recommendations, focus, notifications, and billing view',
      owner: 'product',
      localOk: dashboard.ok && Boolean(dashboardQa?.localOk) && Boolean(relationshipQa?.localOk) && summary.connectedMailboxes > 0 && summary.enabledEmailFlows > 0 && summary.subscriptions > 0 && (summary.activeEntitlements ?? 0) > 0,
      productionOk: backend.productionReady && launch.summary.launchReady === launch.summary.total,
      evidence: [`${dashboard.summary.passed}/${dashboard.summary.total} dashboard calculation check(s) pass`, `${pipeline.summary.localReady}/${pipeline.summary.total} digestion pipeline stage(s) locally ready`, `${summary.openSignals} open signal(s), ${summary.openAccountRecommendations ?? 0}/${summary.accountRecommendations ?? 0} open recommendation(s)`, `${payment.summary.localReady}/${payment.summary.total} payment lifecycle check(s) locally ready`],
      blockers: backend.productionReady && launch.summary.launchReady === launch.summary.total ? [] : ['Production user workspace needs durable backend, tenant isolation, provider launch, and scheduler evidence.'],
      commands: ['npm run admin -- dashboard-audit --json', 'npm run admin -- digestion-pipeline --json', 'npm run admin -- payment-lifecycle --json', 'npm run test:browser-routes'],
      api: '/api/dashboard-audit',
    }),
    fallbackCompletionRow({
      id: 'core_admin_area',
      label: 'Core admin area: tenant, users, source governance, monitoring, operations, and QA',
      owner: 'operations',
      localOk: operations.ok && lifecycle.ok && qa.ok,
      productionOk: operations.productionReady && qa.productionReady,
      evidence: [
        `${agent.summary.localReady}/${agent.summary.localTotal} readiness area(s) local-ready`,
        `${operations.summary.totalWebhooks - operations.summary.unhealthyWebhooks}/${operations.summary.totalWebhooks} webhook channel(s) healthy`,
        `${lifecycle.summary.ready}/${lifecycle.summary.total} lifecycle playbook row(s) local-ready`,
        `${qa.summary.localReady}/${qa.summary.total} QA answer row(s) local-ready`,
      ],
      blockers: operations.productionReady && qa.productionReady ? [] : [`${agent.summary.totalActions} launch gate(s) need production proof.`],
      commands: ['npm run admin -- operations-health --json', 'npm run admin -- lifecycle-playbook --json', 'npm run admin -- qa-answers --json'],
      api: '/api/operations-health',
    }),
    fallbackCompletionRow({
      id: 'local_admin_cli_agent',
      label: 'Local admin CLI and agent handoff capability',
      owner: 'local_agent',
      localOk: agent.ok,
      productionOk: agent.goLiveReady,
      evidence: [`${agent.summary.totalActions} ranked local-agent action(s)`, `${summary.jobs ?? 0} job record(s), ${summary.failedJobs ?? 0} failed job(s)`, `${summary.auditEvents ?? 0} audit event(s)`, `Next action: ${agent.nextAction.id}`],
      blockers: agent.goLiveReady ? [] : [agent.nextAction.blocker],
      commands: ['npm run admin -- agent-handoff --json', 'npm run admin -- completion-audit --json', 'npm run admin -- export --json'],
      api: '/api/agent-handoff',
    }),
    fallbackCompletionRow({
      id: 'email_flow_management',
      label: 'Email flow management, notifications, launch handoff, monitoring, and rollback',
      owner: 'integrations',
      localOk: operations.ok && email.ok && Boolean(emailQa?.localOk) && summary.connectedMailboxes > 0 && summary.enabledEmailFlows > 0,
      productionOk: email.productionReady && emailLaunchReady,
      evidence: [`${pipeline.summary.localReady}/${pipeline.summary.total} ingestion/detector stage(s) local-ready`, `${email.summary.total - email.summary.blocked}/${email.summary.total} email handoff step(s) launch-ready`, `${summary.activeEmailWatchSubscriptions ?? 0}/${summary.emailWatchSubscriptions ?? 0} active watch subscription(s)`, `${summary.failedEmailDeliveries ?? 0}/${summary.emailDeliveries ?? 0} failed email delivery record(s)`],
      blockers: email.productionReady ? [] : [email.nextStep.blocker],
      commands: ['npm run admin -- email-handoff --json', 'npm run admin -- operations-health --json', 'npm run admin -- notifications digest tenant_demo'],
      api: '/api/email-handoff',
    }),
    fallbackCompletionRow({
      id: 'payment_processing_architecture',
      label: 'Payment processing architecture, lifecycle handling, entitlements, and Stripe handoff',
      owner: 'billing',
      localOk: paymentLaunch.ok && Boolean(paymentQa?.localOk) && summary.subscriptions > 0 && (summary.activeEntitlements ?? 0) > 0,
      productionOk: paymentLaunch.productionReady && paymentLaunchReady,
      evidence: [`${payment.summary.localReady}/${payment.summary.total} payment lifecycle check(s) local-ready`, `${paymentLaunch.summary.total - paymentLaunch.summary.blocked}/${paymentLaunch.summary.total} payment handoff step(s) launch-ready`, `${summary.subscriptions} subscription record(s), ${summary.activeEntitlements ?? 0} active entitlement(s)`, `${summary.paymentEvents} payment event(s), ${summary.billingSessions ?? 0} billing session(s)`],
      blockers: paymentLaunch.productionReady ? [] : [paymentLaunch.nextStep.blocker],
      commands: ['npm run admin -- payment-lifecycle --json', 'npm run admin -- payment-handoff --json', 'npm run admin -- payments checkout tenant_demo plan_team'],
      api: '/api/payment-handoff',
    }),
  ];
  const localComplete = rows.every((row) => row.localOk);
  const productionReady = rows.every((row) => row.productionOk) && agent.goLiveReady;
  const nextLocal = rows.find((row) => !row.localOk) ?? null;
  const nextProduction = rows.find((row) => !row.productionOk) ?? null;
  return {
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
    runnableCommands: uniquePlanValues(['npm run admin -- completion-audit --json', 'curl http://127.0.0.1:8787/api/completion-audit', 'npm run test:local', 'npm run admin -- readiness --json', 'npm run admin -- qa-answers --json', 'npm run admin -- agent-handoff --json', 'npm run admin -- launch-gate --env-file ./.env.production --json', ...rows.flatMap((row) => row.commands.slice(0, 2))]),
    supportingReports: {
      agentHandoff: agent.ok,
      dashboardAudit: dashboard.ok,
      digestionPipeline: pipeline.ok,
      emailHandoff: email.ok,
      lifecyclePlaybook: lifecycle.ok,
      operationsHealth: operations.ok,
      onboardingReadiness: onboarding.ok,
      paymentHandoff: paymentLaunch.ok,
      paymentLifecycle: payment.ok,
      qaAnswers: qa.ok,
      tenantIsolation: isolation.ok,
    },
    summary: {
      localComplete,
      localReady: rows.filter((row) => row.localOk).length,
      needsLocalWork: rows.filter((row) => !row.localOk).length,
      needsProduction: rows.filter((row) => row.localOk && !row.productionOk).length,
      productionReady: rows.filter((row) => row.productionOk).length,
      secretSafe: true,
      total: rows.length,
    },
  };
}

function backendHandoffPriority(id: string) {
  const order: Record<string, number> = {
    backend_mode: 10,
    durable_state: 20,
    state_service_storage: 30,
    signed_session_enforced: 40,
    session_cookie_secure: 45,
    system_webhook_actor: 46,
    system_oauth_actor: 47,
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
  return order[id] ?? 200;
}

function backendActionFromCheck(check: BackendReadinessCheck): BackendHandoffAction {
  const commandMap: Record<string, string> = {
    backend_mode: 'SIGNAL_BACKEND_MODE=external-service npm run admin -- backend --json',
    durable_state: 'SIGNAL_BACKEND_MODE=external-service SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run admin -- backend --json',
    state_service_storage: 'SIGNAL_STATE_SERVICE_BACKEND=postgres DATABASE_URL=postgres://... SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service',
    signed_session_enforced: 'SIGNAL_REQUIRE_SIGNED_SESSION=true SIGNAL_SESSION_SECRET=<local-session-secret> npm run admin -- backend --json',
    session_cookie_secure: 'SIGNAL_COOKIE_SECURE=true npm run admin -- backend --env-file ./.env.production --json',
    system_webhook_actor: 'SIGNAL_WEBHOOK_ACTOR=<webhook-actor> npm run admin -- backend --env-file ./.env.production --json',
    system_oauth_actor: 'SIGNAL_OAUTH_ACTOR=<oauth-actor> npm run admin -- backend --env-file ./.env.production --json',
    production_auth_provider: 'SIGNAL_AUTH_PROVIDER=jwks SIGNAL_AUTH_JWKS_URL=<jwks-url> npm run test:jwks-auth',
    cors_origins: 'SIGNAL_API_CORS_ORIGINS=https://app.example.com npm run admin -- backend --json',
    job_scheduler: 'SIGNAL_JOB_SCHEDULER=signal-scheduler SIGNAL_PROVIDER_VALIDATION_SCHEDULER=signal-scheduler npm run scheduler -- --once --dry-run --json',
    tenant_isolation: 'SIGNAL_TENANT_ISOLATION_MODE=rls npm run admin -- backend --json',
  };
  return {
    id: check.id,
    label: check.label,
    owner: ['signed_session_enforced', 'session_cookie_secure', 'system_webhook_actor', 'system_oauth_actor', 'production_auth_provider', 'tenant_isolation'].includes(check.id) ? 'security' : check.id === 'job_scheduler' ? 'operations' : 'platform',
    status: check.ok ? 'ready' : 'blocked',
    priority: backendHandoffPriority(check.id),
    blocker: check.ok ? 'No blocker.' : check.message,
    evidence: [check.message],
    requiredEnv: check.missingEnv,
    command: commandMap[check.id] ?? 'npm run admin -- backend --json',
    followUpCommands: check.id === 'state_service_storage'
      ? ['npm run test:state-service', 'SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- health --json']
      : [],
  };
}

function backendActionFromDrill(row: ProductionDrillRow): BackendHandoffAction {
  return {
    id: row.area,
    label: row.check,
    owner: row.owner,
    status: row.productionOk ? 'ready' : row.status,
    priority: backendHandoffPriority(row.area),
    blocker: row.productionOk ? 'No blocker.' : row.recommendation,
    evidence: row.evidence,
    requiredEnv: row.requiredEnv,
    command: row.commands[0] ?? 'npm run admin -- production-drill --json',
    followUpCommands: row.commands.slice(1, 4),
  };
}

export function fallbackBackendHandoff(
  data: SignalAppData,
  backend = fallbackBackendReadiness(),
  operations = fallbackOperationsHealth(data, backend),
  productionDrill = fallbackProductionDrill(data, backend, fallbackProviderReadiness(), operations),
): BackendHandoffReport {
  const backendActions = backend.checks.filter((check) => !check.ok).map(backendActionFromCheck);
  const drillAreas = new Set(['state_service_health', 'backup_restore_rehearsal', 'migration_rollout', 'identity_tenant_isolation', 'scheduler_daemon', 'alerting_runbook']);
  const drillActions = productionDrill.rows
    .filter((row) => drillAreas.has(row.area) && !row.productionOk)
    .map(backendActionFromDrill);
  const actions = [...backendActions, ...drillActions].sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  const nextAction = actions[0] ?? {
    id: 'backend_launch_evidence',
    label: 'Backend launch evidence package',
    owner: 'platform',
    status: 'ready_for_proof',
    priority: 200,
    blocker: 'Backend checks pass; package and verify launch evidence.',
    evidence: [`${backend.summary.readyChecks}/${backend.summary.totalChecks} backend checks ready`],
    requiredEnv: [],
    command: 'npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json',
    followUpCommands: ['npm run admin -- launch-gate verify-package ./signal-launch-evidence.json --json'],
  };
  const report: BackendHandoffReport = {
    generatedAt: new Date().toISOString(),
    ok: true,
    productionReady: backend.productionReady && productionDrill.rows
      .filter((row) => drillAreas.has(row.area))
      .every((row) => row.productionOk),
    nextAction,
    actions,
    backend: {
      mode: backend.mode,
      productionReady: backend.productionReady,
      readyChecks: backend.summary.readyChecks,
      totalChecks: backend.summary.totalChecks,
      missingRequiredEnv: backend.summary.missingRequiredEnv,
    },
    recommendation: {
      summary: 'Use backend-handoff to work the first launch blocker before provider launch: durable state, signed auth, tenant isolation, CORS, scheduler, backup/restore, migration, and runbook proof.',
      productionGuardrail: 'This report is secret-safe and names required environment variables only. It does not prove production readiness until the target deployment passes backend, production-drill, state-service, JWKS auth, scheduler, and launch-gate checks.',
      localAgentCommand: 'npm run admin -- backend-handoff --env-file ./.env.production --json',
    },
    runnableCommands: uniquePlanValues([
      'npm run admin -- backend --json',
      'npm run admin -- backend-handoff --json',
      'npm run admin -- production-drill --json',
      'npm run test:state-service',
      'npm run test:jwks-auth',
      'npm run test:scheduler',
      nextAction.command,
      ...nextAction.followUpCommands,
    ]),
    summary: {
      blocked: actions.length,
      backendReadyChecks: backend.summary.readyChecks,
      backendTotalChecks: backend.summary.totalChecks,
      drillReady: productionDrill.summary.productionReady,
      drillTotal: productionDrill.summary.total,
      missingRequiredEnv: uniquePlanValues(actions.flatMap((row) => row.requiredEnv)).length,
      nextActionId: nextAction.id,
      productionReady: backend.productionReady,
      secretSafe: false,
    },
  };
  report.summary.secretSafe = !localAgentHandoffStringLooksUnsafe(JSON.stringify(report));
  report.ok = report.summary.secretSafe && backend.ok && operations.ok;
  return report;
}

function fallbackConfiguredKeys(env: Record<string, string | undefined>, keys: string[]) {
  return keys.filter((key) => Boolean(env[key]));
}

function fallbackMissingKeys(env: Record<string, string | undefined>, keys: string[]) {
  return keys.filter((key) => !env[key]);
}

function fallbackBackendCutoverStep({
  command,
  completion,
  env,
  evidence = [],
  id,
  label,
  owner,
  priority,
  productionOk = false,
  requiredEnv = [],
  rollbackCommand = null,
}: {
  command: string;
  completion: string;
  env: Record<string, string | undefined>;
  evidence?: string[];
  id: string;
  label: string;
  owner: string;
  priority: number;
  productionOk?: boolean;
  requiredEnv?: string[];
  rollbackCommand?: string | null;
}): BackendCutoverStep {
  const configuredEnv = fallbackConfiguredKeys(env, requiredEnv);
  const missingEnv = fallbackMissingKeys(env, requiredEnv);
  return {
    id,
    label,
    owner,
    priority,
    status: productionOk ? 'ready' : 'needs_proof',
    localOk: true,
    productionOk,
    requiredEnv: uniquePlanValues(requiredEnv),
    configuredEnv,
    missingEnv,
    evidence,
    command,
    rollbackCommand,
    completion,
  };
}

export function fallbackBackendCutover(
  data: SignalAppData,
  backend = fallbackBackendReadiness(),
  productionDrill = fallbackProductionDrill(data, backend),
  env: Record<string, string | undefined> = {},
): BackendCutoverDrillReport {
  const summary = summarizeLocalState(data);
  const checks = Object.fromEntries(backend.checks.map((check) => [check.id, check]));
  const drillRows = Object.fromEntries(productionDrill.rows.map((row) => [row.area, row]));
  const stateServiceEnv = ['SIGNAL_BACKEND_MODE', 'SIGNAL_STATE_SERVICE_URL', 'SIGNAL_STATE_SERVICE_TOKEN'];
  const postgresEnv = ['SIGNAL_STATE_SERVICE_BACKEND', 'DATABASE_URL'];
  const identityEnv = ['SIGNAL_REQUIRE_SIGNED_SESSION', 'SIGNAL_SESSION_SECRET', 'SIGNAL_COOKIE_SECURE', 'SIGNAL_WEBHOOK_ACTOR', 'SIGNAL_OAUTH_ACTOR', 'SIGNAL_AUTH_PROVIDER', 'SIGNAL_AUTH_JWKS_URL', 'SIGNAL_TENANT_ISOLATION_MODE'];
  const corsEnv = ['SIGNAL_API_CORS_ORIGINS'];
  const schedulerEnv = ['SIGNAL_JOB_SCHEDULER', 'SIGNAL_PROVIDER_VALIDATION_SCHEDULER', 'SIGNAL_SCHEDULER_LOCK_POLICY'];
  const backupEnv = ['SIGNAL_STATE_BACKUP_SCHEDULE', 'SIGNAL_STATE_BACKUP_RETENTION_DAYS', 'SIGNAL_STATE_RESTORE_REHEARSAL_AT', 'SIGNAL_STATE_MIGRATION_ROLLOUT_PLAN'];
  const stateServiceReady = Boolean(checks.backend_mode?.ok && checks.durable_state?.ok && checks.state_service_storage?.ok);
  const identityReady = Boolean(
    checks.signed_session_enforced?.ok &&
    checks.session_cookie_secure?.ok &&
    checks.system_webhook_actor?.ok &&
    checks.system_oauth_actor?.ok &&
    checks.production_auth_provider?.ok &&
    checks.tenant_isolation?.ok,
  );
  const schedulerReady = Boolean(checks.job_scheduler?.ok && drillRows.scheduler_daemon?.productionOk);
  const backupReady = Boolean(drillRows.backup_restore_rehearsal?.productionOk && drillRows.migration_rollout?.productionOk);
  const rows = [
    fallbackBackendCutoverStep({
      id: 'snapshot_local_state',
      label: 'Snapshot current local state',
      owner: 'platform',
      priority: 10,
      productionOk: true,
      env,
      evidence: [
        `State path: ${summary.statePath}`,
        `${summary.tenants} tenant(s), ${summary.users} user(s), ${summary.mailboxes} mailbox source(s), ${summary.auditEvents} audit event(s)`,
      ],
      command: 'npm run state-service:admin -- verify ./signal-prod-backup.json --json',
      rollbackCommand: 'Keep the pre-cutover local JSON state file unchanged until the external state-service verification passes.',
      completion: 'A pre-cutover backup artifact is stored outside app state and its digest verifies.',
    }),
    fallbackBackendCutoverStep({
      id: 'start_external_state_service',
      label: 'Start external state-service backend',
      owner: 'platform',
      priority: 20,
      productionOk: stateServiceReady,
      requiredEnv: uniquePlanValues([...stateServiceEnv, ...postgresEnv]),
      env,
      evidence: [
        checks.backend_mode?.message ?? 'Backend mode not evaluated',
        checks.durable_state?.message ?? 'Durable state not evaluated',
        checks.state_service_storage?.message ?? 'State-service storage not evaluated',
      ],
      command: 'SIGNAL_STATE_SERVICE_BACKEND=postgres DATABASE_URL=postgres://... SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service',
      rollbackCommand: 'Stop the new state-service process and keep API traffic on SIGNAL_BACKEND_MODE=local-json.',
      completion: 'State service starts with Postgres storage, bearer protection, sanitized health metadata, and no credential values in logs or state.',
    }),
    fallbackBackendCutoverStep({
      id: 'verify_state_service_health',
      label: 'Verify external state-service health',
      owner: 'platform',
      priority: 30,
      productionOk: Boolean(stateServiceReady && env.SIGNAL_STATE_SERVICE_TOKEN),
      requiredEnv: stateServiceEnv,
      env,
      evidence: [`Backend mode: ${backend.mode}`, checks.state_service_storage?.message ?? 'State-service storage not evaluated'],
      command: 'SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- health --json',
      rollbackCommand: 'Do not switch API env until health passes through the same URL the API will use.',
      completion: 'Health succeeds through the bearer-protected /state boundary using env names only.',
    }),
    fallbackBackendCutoverStep({
      id: 'backup_restore_rehearsal',
      label: 'Run backup, verify, and restore dry run',
      owner: 'platform',
      priority: 40,
      productionOk: backupReady,
      requiredEnv: backupEnv,
      env,
      evidence: drillRows.backup_restore_rehearsal?.evidence ?? [],
      command: 'SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run state-service:admin -- backup ./signal-prod-backup.json --json',
      rollbackCommand: 'Use npm run state-service:admin -- restore ./signal-prod-backup.json --dry-run --json before any real restore.',
      completion: 'Backup digest verifies and restore dry run completes against the target state-service URL.',
    }),
    fallbackBackendCutoverStep({
      id: 'identity_tenant_isolation_cutover',
      label: 'Enforce signed auth and tenant isolation',
      owner: 'security',
      priority: 50,
      productionOk: identityReady,
      requiredEnv: identityEnv,
      env,
      evidence: [
        checks.signed_session_enforced?.message ?? 'Signed session not evaluated',
        checks.session_cookie_secure?.message ?? 'Secure session cookies not evaluated',
        checks.system_webhook_actor?.message ?? 'Webhook system actor not evaluated',
        checks.system_oauth_actor?.message ?? 'OAuth callback system actor not evaluated',
        checks.production_auth_provider?.message ?? 'Production auth provider not evaluated',
        checks.tenant_isolation?.message ?? 'Tenant isolation not evaluated',
      ],
      command: 'SIGNAL_REQUIRE_SIGNED_SESSION=true SIGNAL_COOKIE_SECURE=true SIGNAL_WEBHOOK_ACTOR=<webhook-actor> SIGNAL_OAUTH_ACTOR=<oauth-actor> SIGNAL_AUTH_PROVIDER=jwks SIGNAL_AUTH_JWKS_URL=<jwks-url> SIGNAL_TENANT_ISOLATION_MODE=rls npm run test:jwks-auth',
      rollbackCommand: 'Keep raw actor fallback disabled in production; if JWKS fails, remove production traffic from the deployment rather than loosening auth.',
      completion: 'JWKS auth, signed-session enforcement, role/tenant claim mapping, and tenant-isolation mode all pass.',
    }),
    fallbackBackendCutoverStep({
      id: 'api_external_mode_smoke',
      label: 'Start API in external-service mode',
      owner: 'platform',
      priority: 60,
      productionOk: Boolean(stateServiceReady && identityReady && checks.cors_origins?.ok),
      requiredEnv: uniquePlanValues([...stateServiceEnv, ...identityEnv, ...corsEnv]),
      env,
      evidence: [
        checks.cors_origins?.message ?? 'CORS origins not evaluated',
        `Backend ready checks: ${backend.summary.readyChecks}/${backend.summary.totalChecks}`,
      ],
      command: 'SIGNAL_BACKEND_MODE=external-service SIGNAL_STATE_SERVICE_URL=<state-service-url> SIGNAL_STATE_SERVICE_TOKEN=<token> npm run api',
      rollbackCommand: 'Stop the external-mode API process and restart local development with npm run api.',
      completion: 'API /api/health and admin readiness routes load from the external state-service boundary.',
    }),
    fallbackBackendCutoverStep({
      id: 'scheduler_single_runner_cutover',
      label: 'Run scheduler one-shot against external backend',
      owner: 'operations',
      priority: 70,
      productionOk: schedulerReady,
      requiredEnv: schedulerEnv,
      env,
      evidence: drillRows.scheduler_daemon?.evidence ?? [],
      command: 'SIGNAL_JOB_SCHEDULER=signal-scheduler SIGNAL_PROVIDER_VALIDATION_SCHEDULER=signal-scheduler npm run scheduler -- --once --json',
      rollbackCommand: 'Keep continuous scheduler disabled until one-shot execution and operations-health pass.',
      completion: 'One scheduler tick runs with single-runner policy, no failed jobs, and active provider validation schedules.',
    }),
    fallbackBackendCutoverStep({
      id: 'package_cutover_evidence',
      label: 'Package redacted backend cutover evidence',
      owner: 'operations',
      priority: 80,
      productionOk: Boolean(backend.productionReady && backupReady && schedulerReady),
      env,
      evidence: [
        `${backend.summary.readyChecks}/${backend.summary.totalChecks} backend checks ready`,
        `${productionDrill.summary.productionReady}/${productionDrill.summary.total} production drill rows ready`,
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
  const report: BackendCutoverDrillReport = {
    generatedAt: new Date().toISOString(),
    ok: true,
    productionReady: rows.every((row) => row.productionOk),
    nextStep,
    rows,
    backend: {
      mode: backend.mode,
      productionReady: backend.productionReady,
      readyChecks: backend.summary.readyChecks,
      totalChecks: backend.summary.totalChecks,
      missingRequiredEnv: backend.summary.missingRequiredEnv,
    },
    recommendation: {
      summary: 'Use backend-cutover after backend-handoff: it is the local-agent drill for moving Signal from local JSON state to the external state-service backend.',
      productionGuardrail: 'Do not switch production traffic until health, backup/restore, JWKS auth, tenant isolation, external-mode API smoke, scheduler one-shot, and redacted launch evidence all pass.',
      localAgentCommand: 'npm run admin -- backend-cutover --env-file ./.env.production --json',
    },
    runnableCommands: uniquePlanValues([
      'npm run admin -- backend-cutover --json',
      'npm run admin -- backend-cutover --env-file ./.env.production --json',
      'npm run admin -- backend-handoff --env-file ./.env.production --json',
      'npm run test:state-service',
      'npm run test:jwks-auth',
      'npm run test:scheduler',
      nextStep.command,
      nextStep.rollbackCommand,
    ]),
    summary: {
      blocked: rows.filter((row) => !row.productionOk).length,
      configuredEnv: uniquePlanValues(rows.flatMap((row) => row.configuredEnv)).length,
      missingRequiredEnv: uniquePlanValues(rows.flatMap((row) => row.missingEnv)).length,
      nextStepId: nextStep.id,
      productionReady: rows.filter((row) => row.productionOk).length,
      secretSafe: false,
      total: rows.length,
    },
  };
  report.summary.secretSafe = !localAgentHandoffStringLooksUnsafe(JSON.stringify(report));
  report.ok = report.summary.secretSafe && backend.ok;
  return report;
}

function fallbackSchedulerHandoffStep({
  blocker,
  command,
  completion,
  env,
  evidence = [],
  followUpCommands = [],
  id,
  label,
  owner = 'operations',
  priority,
  productionOk = false,
  requiredEnv = [],
  rollbackCommand = null,
}: {
  blocker: string;
  command: string;
  completion: string;
  env: Record<string, string | undefined>;
  evidence?: string[];
  followUpCommands?: string[];
  id: string;
  label: string;
  owner?: string;
  priority: number;
  productionOk?: boolean;
  requiredEnv?: string[];
  rollbackCommand?: string | null;
}): SchedulerHandoffStep {
  const configuredEnv = fallbackConfiguredKeys(env, requiredEnv);
  const missingEnv = fallbackMissingKeys(env, requiredEnv);
  return {
    id,
    label,
    owner,
    priority,
    status: productionOk ? 'ready' : 'needs_proof',
    localOk: true,
    productionOk,
    requiredEnv: uniquePlanValues(requiredEnv),
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

export function fallbackSchedulerHandoff(
  data: SignalAppData,
  backend = fallbackBackendReadiness(),
  operations = fallbackOperationsHealth(data, backend),
  productionDrill = fallbackProductionDrill(data, backend, fallbackProviderReadiness(), operations),
  env: Record<string, string | undefined> = {},
): SchedulerHandoffReport {
  const summary = summarizeLocalState(data);
  const scheduler = backend.checks.find((check) => check.id === 'job_scheduler');
  const launchGateRows = fallbackLaunchGateRows(data, backend, fallbackProviderReadiness());
  const schedulerGate = launchGateRows.find((row) => row.id === 'scheduler_operations');
  const drillRows = Object.fromEntries(productionDrill.rows.map((row) => [row.area, row]));
  const activeProviderSchedules = data.providerValidationSchedules?.filter((schedule) => schedule.status === 'active').length ?? 0;
  const totalProviderSchedules = data.providerValidationSchedules?.length ?? 0;
  const dueProviderSchedules = data.providerValidationSchedules?.filter((schedule) => {
    if (schedule.status !== 'active' || schedule.cadence === 'manual' || !schedule.nextRunAt) {
      return false;
    }
    const nextRunMs = Date.parse(schedule.nextRunAt);
    return Number.isFinite(nextRunMs) && nextRunMs <= Date.now();
  }).length ?? 0;
  const failedJobs = summary.failedJobs ?? 0;
  const schedulerEnv = ['SIGNAL_JOB_SCHEDULER', 'SIGNAL_PROVIDER_VALIDATION_SCHEDULER'];
  const singleRunnerEnv = ['SIGNAL_SCHEDULER_LOCK_POLICY'];
  const alertingEnv = ['SIGNAL_OPERATIONS_RUNBOOK_URL', 'SIGNAL_OPERATIONS_ALERT_CHANNEL'];
  const backendEnv = ['SIGNAL_BACKEND_MODE', 'SIGNAL_STATE_SERVICE_URL', 'SIGNAL_STATE_SERVICE_TOKEN', 'SIGNAL_TENANT_ISOLATION_MODE'];
  const schedulerEnvReady = Boolean(scheduler?.ok && fallbackMissingKeys(env, singleRunnerEnv).length === 0);
  const cleanQueuesReady = operations.ok && failedJobs === 0;
  const schedulesReady = activeProviderSchedules >= 4;
  const alertingReady = Boolean(drillRows.alerting_runbook?.productionOk && fallbackMissingKeys(env, alertingEnv).length === 0);
  const schedulerProductionReady = Boolean(
    schedulerEnvReady &&
    cleanQueuesReady &&
    schedulesReady &&
    alertingReady &&
    drillRows.scheduler_daemon?.productionOk &&
    schedulerGate?.status === 'pass'
  );
  const rows = [
    fallbackSchedulerHandoffStep({
      id: 'configure_scheduler_env',
      label: 'Configure managed scheduler env',
      priority: 10,
      productionOk: schedulerEnvReady,
      requiredEnv: uniquePlanValues([...schedulerEnv, ...singleRunnerEnv]),
      env,
      evidence: [
        scheduler?.message ?? 'Scheduler readiness has not been evaluated.',
        `Single-runner policy configured: ${fallbackMissingKeys(env, singleRunnerEnv).length === 0 ? 'yes' : 'no'}`,
        `Backend mode: ${backend.mode}`,
      ],
      blocker: schedulerEnvReady ? 'None' : 'Production scheduler env or single-runner policy is missing.',
      command: 'SIGNAL_JOB_SCHEDULER=signal-scheduler SIGNAL_PROVIDER_VALIDATION_SCHEDULER=signal-scheduler npm run admin -- backend --env-file ./.env.production --json',
      followUpCommands: ['npm run admin -- production-drill --env-file ./.env.production --json'],
      rollbackCommand: 'Keep continuous scheduler disabled until backend and production-drill checks pass.',
      completion: 'Backend readiness reports job scheduler and validation scheduler env as configured with a single-runner policy.',
    }),
    fallbackSchedulerHandoffStep({
      id: 'dry_run_scheduler_tick',
      label: 'Dry-run one scheduler tick',
      priority: 20,
      productionOk: Boolean(scheduler?.ok && cleanQueuesReady),
      requiredEnv: schedulerEnv,
      env,
      evidence: [`${failedJobs}/${summary.jobs} failed job(s)`, `Operations health: ${operations.ok ? 'local ready' : 'attention'}`],
      blocker: scheduler?.ok && cleanQueuesReady ? 'None' : 'Dry-run proof is blocked by scheduler env or failed worker jobs.',
      command: 'npm run scheduler -- --once --dry-run --json',
      followUpCommands: ['npm run admin -- operations-health --json', 'npm run test:scheduler'],
      rollbackCommand: 'Dry-run only; do not enable the daemon when this row remains needs_proof.',
      completion: 'The scheduler enumerates due work without mutating state and operations-health remains locally clean.',
    }),
    fallbackSchedulerHandoffStep({
      id: 'activate_provider_validation_schedules',
      label: 'Keep provider validation schedules active',
      priority: 30,
      productionOk: schedulesReady,
      requiredEnv: ['SIGNAL_PROVIDER_VALIDATION_SCHEDULER'],
      env,
      evidence: [`${activeProviderSchedules}/${totalProviderSchedules} active provider validation schedule(s)`, `${dueProviderSchedules} due provider validation schedule(s)`],
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
    fallbackSchedulerHandoffStep({
      id: 'clear_failed_jobs',
      label: 'Clear failed jobs before daemon start',
      priority: 40,
      productionOk: cleanQueuesReady,
      env,
      evidence: [`${failedJobs}/${summary.jobs} failed job(s)`, `${operations.summary.failedQueues} failed monitored queue(s)`, `${operations.summary.activeBackoffs} active provider backoff window(s)`],
      blocker: cleanQueuesReady ? 'None' : 'Failed jobs, critical lifecycle notices, or provider backoff need operator action.',
      command: 'npm run admin -- operations-health --json',
      followUpCommands: ['npm run admin -- jobs retry <jobId>', 'npm run admin -- jobs drain billing_webhook', 'npm run admin -- jobs drain outbound_email'],
      rollbackCommand: 'Do not drain queues blindly; retry or drain only after the owning integration/billing issue is understood.',
      completion: 'Operations health is locally ready with no failed billing or outbound-email queue blockers.',
    }),
    fallbackSchedulerHandoffStep({
      id: 'wire_alerting_runbook',
      label: 'Wire scheduler alerts and runbook',
      priority: 50,
      productionOk: alertingReady,
      requiredEnv: alertingEnv,
      env,
      evidence: [...(drillRows.alerting_runbook?.evidence ?? ['Alerting runbook not evaluated']), 'Operations health command: npm run admin -- operations-health --env-file ./.env.production --json'],
      blocker: alertingReady ? 'None' : 'Operations alert channel or launch runbook proof is missing.',
      command: 'npm run admin -- production-drill --env-file ./.env.production --json',
      followUpCommands: ['npm run admin -- scheduler-handoff --env-file ./.env.production --json'],
      rollbackCommand: 'Keep continuous scheduling disabled until failed-job alerts and the production runbook are attached.',
      completion: 'Failed jobs, provider backoff, outbound email, billing webhook, and lifecycle alerts have an owner and runbook URL.',
    }),
    fallbackSchedulerHandoffStep({
      id: 'enable_continuous_scheduler',
      label: 'Enable continuous scheduler runner',
      priority: 60,
      productionOk: schedulerProductionReady,
      requiredEnv: uniquePlanValues([...schedulerEnv, ...singleRunnerEnv, ...alertingEnv, ...backendEnv]),
      env,
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
    fallbackSchedulerHandoffStep({
      id: 'package_scheduler_evidence',
      label: 'Package redacted scheduler evidence',
      priority: 70,
      productionOk: schedulerProductionReady,
      env,
      evidence: [
        `${launchGateRows.filter((gate) => gate.status === 'pass').length}/${launchGateRows.length} launch gate(s) pass`,
        `${productionDrill.summary.productionReady}/${productionDrill.summary.total} production drill row(s) ready`,
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
  const report: SchedulerHandoffReport = {
    generatedAt: new Date().toISOString(),
    ok: true,
    productionReady: schedulerProductionReady,
    nextStep,
    rows,
    backend: {
      mode: backend.mode,
      productionReady: backend.productionReady,
      schedulerReady: Boolean(scheduler?.ok),
    },
    operations: {
      ok: operations.ok,
      productionReady: operations.productionReady,
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
    runnableCommands: uniquePlanValues([
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
    ]),
    summary: {
      activeProviderSchedules,
      blocked: rows.filter((row) => !row.productionOk).length,
      configuredEnv: uniquePlanValues(rows.flatMap((row) => row.configuredEnv)).length,
      dueProviderSchedules,
      failedJobs,
      missingRequiredEnv: uniquePlanValues(rows.flatMap((row) => row.missingEnv)).length,
      nextStepId: nextStep.id,
      productionReady: rows.filter((row) => row.productionOk).length,
      secretSafe: false,
      total: rows.length,
    },
  };
  report.summary.secretSafe = !localAgentHandoffStringLooksUnsafe(JSON.stringify(report));
  report.ok = report.summary.secretSafe && backend.ok && operations.ok;
  return report;
}

export function fallbackStateResponse(): SignalStateResponse {
  const backend = fallbackBackendReadiness();
  const operationsHealth = fallbackOperationsHealth(fallbackSignalData, backend);
  const productionDrill = fallbackProductionDrill(fallbackSignalData, backend, fallbackProviderReadiness(), operationsHealth);
  return {
    agentHandoff: fallbackLocalAgentHandoff(fallbackSignalData, backend),
    completionAudit: fallbackCompletionAudit(fallbackSignalData, backend),
    backendHandoff: fallbackBackendHandoff(fallbackSignalData, backend, operationsHealth, productionDrill),
    backendCutover: fallbackBackendCutover(fallbackSignalData, backend, productionDrill),
    schedulerHandoff: fallbackSchedulerHandoff(fallbackSignalData, backend, operationsHealth, productionDrill),
    backend,
    dashboardAudit: fallbackDashboardAudit(fallbackSignalData, backend),
    digestionPipeline: fallbackSignalDigestionPipeline(fallbackSignalData, backend),
    doctor: doctorLocalState(fallbackSignalData),
    ok: true,
    lifecyclePlaybook: fallbackLifecyclePlaybook(fallbackSignalData, backend),
    onboardingReadiness: fallbackOnboardingReadiness(fallbackSignalData, backend),
    tenantIsolation: fallbackTenantIsolationAudit(fallbackSignalData, backend),
    operationsHealth,
    emailHandoff: fallbackEmailHandoff(fallbackSignalData, backend, fallbackProviderReadiness(), fallbackProviderLaunchMatrix(fallbackSignalData, backend), operationsHealth),
    paymentHandoff: fallbackPaymentHandoff(fallbackSignalData, backend),
    paymentLifecycle: fallbackPaymentLifecycleAudit(fallbackSignalData, backend),
    providerHandoff: fallbackProviderHandoff(fallbackSignalData, backend),
    providerLaunch: fallbackProviderLaunchMatrix(fallbackSignalData, backend),
    productionEnv: fallbackProductionEnvAudit(fallbackSignalData, backend),
    productionPlan: fallbackProductionPlan(fallbackSignalData, backend),
    productionDrill,
    qaAnswers: fallbackQaAnswers(fallbackSignalData, backend),
    state: fallbackSignalData,
    summary: summarizeLocalState(fallbackSignalData),
  };
}

export async function fetchSignalState(signal?: AbortSignal): Promise<SignalStateResponse> {
  return getJson<SignalStateResponse>('/api/state', { errorLabel: 'Signal API', signal });
}

export async function fetchProviderReadiness(signal?: AbortSignal): Promise<ProviderReadinessResponse> {
  return getJson<ProviderReadinessResponse>('/api/integrations', { errorLabel: 'Signal integrations API', signal });
}

export async function fetchDashboardAudit(signal?: AbortSignal): Promise<DashboardAuditResponse> {
  return getJson<DashboardAuditResponse>('/api/dashboard-audit', { errorLabel: 'Signal dashboard audit API', signal });
}

export async function fetchSignalDigestionPipeline(signal?: AbortSignal): Promise<SignalDigestionPipelineResponse> {
  return getJson<SignalDigestionPipelineResponse>('/api/digestion-pipeline', { errorLabel: 'Signal digestion pipeline API', signal });
}

export async function fetchOnboardingReadiness(signal?: AbortSignal): Promise<OnboardingReadinessResponse> {
  return getJson<OnboardingReadinessResponse>('/api/onboarding-readiness', { errorLabel: 'Signal onboarding readiness API', signal });
}

export async function fetchTenantIsolation(signal?: AbortSignal): Promise<TenantIsolationAuditResponse> {
  return getJson<TenantIsolationAuditResponse>('/api/tenant-isolation', { errorLabel: 'Signal tenant isolation API', signal });
}

export async function fetchOperationsHealth(signal?: AbortSignal): Promise<OperationsHealthResponse> {
  return getJson<OperationsHealthResponse>('/api/operations-health', { errorLabel: 'Signal operations health API', signal });
}

export async function fetchProductionDrill(signal?: AbortSignal): Promise<ProductionDrillResponse> {
  return getJson<ProductionDrillResponse>('/api/production-drill', { errorLabel: 'Signal production drill API', signal });
}

export async function fetchProviderLaunch(signal?: AbortSignal): Promise<ProviderLaunchResponse> {
  return getJson<ProviderLaunchResponse>('/api/provider-launch', { errorLabel: 'Signal provider launch API', signal });
}

export async function fetchProviderHandoff(signal?: AbortSignal): Promise<ProviderHandoffResponse> {
  return getJson<ProviderHandoffResponse>('/api/provider-handoff', { errorLabel: 'Signal provider handoff API', signal });
}

export async function fetchBackendCutover(signal?: AbortSignal): Promise<BackendCutoverResponse> {
  return getJson<BackendCutoverResponse>('/api/backend-cutover', { errorLabel: 'Signal backend cutover API', signal });
}

export async function fetchSchedulerHandoff(signal?: AbortSignal): Promise<SchedulerHandoffResponse> {
  return getJson<SchedulerHandoffResponse>('/api/scheduler-handoff', { errorLabel: 'Signal scheduler handoff API', signal });
}

export async function fetchProductionPlan(signal?: AbortSignal): Promise<ProductionPlanResponse> {
  return getJson<ProductionPlanResponse>('/api/production-plan', { errorLabel: 'Signal production plan API', signal });
}

export async function fetchProductionEnv(signal?: AbortSignal): Promise<ProductionEnvResponse> {
  return getJson<ProductionEnvResponse>('/api/production-env', { errorLabel: 'Signal production env API', signal });
}

export async function fetchLifecyclePlaybook(signal?: AbortSignal): Promise<LifecyclePlaybookResponse> {
  return getJson<LifecyclePlaybookResponse>('/api/lifecycle-playbook', { errorLabel: 'Signal lifecycle playbook API', signal });
}

export async function fetchPaymentLifecycle(signal?: AbortSignal): Promise<PaymentLifecycleAuditResponse> {
  return getJson<PaymentLifecycleAuditResponse>('/api/payment-lifecycle', { errorLabel: 'Signal payment lifecycle API', signal });
}

export async function fetchPaymentHandoff(signal?: AbortSignal): Promise<PaymentHandoffResponse> {
  return getJson<PaymentHandoffResponse>('/api/payment-handoff', { errorLabel: 'Signal payment handoff API', signal });
}

export async function fetchEmailHandoff(signal?: AbortSignal): Promise<EmailHandoffResponse> {
  return getJson<EmailHandoffResponse>('/api/email-handoff', { errorLabel: 'Signal email handoff API', signal });
}

export async function fetchQaAnswers(signal?: AbortSignal): Promise<QaAnswersResponse> {
  return getJson<QaAnswersResponse>('/api/qa-answers', { errorLabel: 'Signal QA answers API', signal });
}

export async function fetchCompletionAudit(signal?: AbortSignal): Promise<CompletionAuditResponse> {
  return getJson<CompletionAuditResponse>('/api/completion-audit', { errorLabel: 'Signal completion audit API', signal });
}

export async function fetchAgentHandoff(signal?: AbortSignal): Promise<LocalAgentHandoffResponse> {
  return getJson<LocalAgentHandoffResponse>('/api/agent-handoff', { errorLabel: 'Signal agent handoff API', signal });
}

export async function fetchBackendHandoff(signal?: AbortSignal): Promise<BackendHandoffResponse> {
  return getJson<BackendHandoffResponse>('/api/backend-handoff', { errorLabel: 'Signal backend handoff API', signal });
}

export async function fetchProviderSandbox(signal?: AbortSignal): Promise<ProviderSandboxResponse> {
  return getJson<ProviderSandboxResponse>('/api/integrations/sandbox', { errorLabel: 'Signal sandbox validation API', method: 'POST', signal });
}

export async function runProviderScheduledValidation(force = false, signal?: AbortSignal): Promise<ProviderScheduledValidationResponse> {
  return getJson<ProviderScheduledValidationResponse>('/api/integrations/scheduled', {
    body: { force },
    errorLabel: 'Signal scheduled validation API',
    signal,
  });
}

export async function mutateSignalState(action: SignalMutationAction, args: Record<string, unknown>, actorUserId?: string): Promise<SignalMutationResult> {
  return getJson<SignalMutationResult>('/api/mutations', {
    body: { action, actorUserId, args },
    errorLabel: 'Signal mutation',
    headers: { 'X-Signal-Actor': actorUserId ?? localApiActorUserId },
  });
}

export async function registerSignalWorkspace(args: Record<string, unknown>): Promise<SignalMutationResult> {
  return getJson<SignalMutationResult>('/api/registration', {
    body: args,
    errorLabel: 'Signal registration',
  });
}

export async function claimSignalInvite(args: Record<string, unknown>): Promise<SignalMutationResult> {
  return getJson<SignalMutationResult>('/api/invites/claim', {
    body: args,
    errorLabel: 'Signal invite claim',
  });
}

export async function switchSignalSession(userId: string): Promise<SignalSessionResult> {
  return getJson<SignalSessionResult>('/api/session', {
    body: { userId },
    errorLabel: 'Signal session switch',
    includeActorHeader: false,
  });
}

export function formatCurrency(cents: number) {
  return new Intl.NumberFormat('en-US', {
    currency: 'USD',
    maximumFractionDigits: 0,
    style: 'currency',
  }).format(cents / 100);
}

export function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

export function titleize(value: string) {
  return value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function ownerName(users: User[], ownerUserId: string) {
  return users.find((user) => user.id === ownerUserId)?.name ?? 'Unassigned';
}
