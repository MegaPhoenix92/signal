import crypto from 'node:crypto';
import {
  providerFetch,
} from './signal-provider-fetch.mjs';

export const SENDGRID_MAIL_SEND_URL = 'https://api.sendgrid.com/v3/mail/send';
export const SENDGRID_WEBHOOK_TOLERANCE_SECONDS = 300;

export class EmailProviderError extends Error {
  constructor(message, { code = 'EMAIL_PROVIDER_ERROR', status = 400, details = {} } = {}) {
    super(message);
    this.name = 'EmailProviderError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function sha256Digest(value, length = 24) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, length);
}

function requireString(value, label) {
  if (!value || typeof value !== 'string') {
    throw new EmailProviderError(`${label} is required.`, {
      code: 'EMAIL_PROVIDER_CONFIG_MISSING',
      status: 412,
      details: { label },
    });
  }
  return value;
}

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalInteger(value, label) {
  const configured = optionalString(value);
  if (!configured) {
    return null;
  }
  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new EmailProviderError(`${label} must be a positive integer.`, {
      code: 'EMAIL_PROVIDER_CONFIG_INVALID',
      status: 412,
      details: { label },
    });
  }
  return parsed;
}

function optionalIntegerList(value, label) {
  const configured = optionalString(value);
  if (!configured) {
    return [];
  }
  return configured
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => optionalInteger(item, label));
}

function optionalBoolean(value, label) {
  const configured = optionalString(value);
  if (!configured) {
    return null;
  }
  if (configured === 'true') {
    return true;
  }
  if (configured === 'false') {
    return false;
  }
  throw new EmailProviderError(`${label} must be true or false.`, {
    code: 'EMAIL_PROVIDER_CONFIG_INVALID',
    status: 412,
    details: { label },
  });
}

function configuredProviderMode({ env = process.env, liveEmailProvider = false, emailProviderMode } = {}) {
  const mode = emailProviderMode ?? env.SIGNAL_EMAIL_PROVIDER_MODE;
  if (liveEmailProvider || mode === 'live') {
    return 'live';
  }
  return 'local';
}

function configuredProviderKind(env = process.env) {
  const configured = (env.SIGNAL_EMAIL_PROVIDER ?? env.SIGNAL_EMAIL_PROVIDER_NAME ?? '').trim().toLowerCase();
  if (configured === 'sendgrid' || configured === 'twilio-sendgrid') {
    return 'sendgrid';
  }
  return 'generic';
}

function unsubscribeUrl(message, env = process.env) {
  const baseUrl = env.SIGNAL_EMAIL_UNSUBSCRIBE_BASE_URL ?? env.SIGNAL_APP_BASE_URL;
  if (!baseUrl) {
    return `signal://unsubscribe/${message.unsubscribeCode}`;
  }
  return `${baseUrl.replace(/\/$/, '')}/api/email/unsubscribe/${encodeURIComponent(message.unsubscribeCode)}`;
}

function parseAddress(value) {
  const address = requireString(value, 'email address').trim();
  const match = address.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    const name = match[1].trim().replace(/^"|"$/g, '');
    return {
      email: match[2].trim(),
      ...(name ? { name } : {}),
    };
  }
  return { email: address };
}

function deliveryPayload(message, env = process.env) {
  return {
    from: env.SIGNAL_EMAIL_FROM,
    headers: {
      'X-Signal-Delivery-Id': message.id,
      'X-Signal-Tenant-Id': message.tenantId,
      'X-Signal-Unsubscribe-Code': message.unsubscribeCode,
    },
    html: [
      `<p>${message.subject}</p>`,
      '<ul>',
      ...(message.notificationIds ?? []).map((id) => `<li>${id}</li>`),
      '</ul>',
      `<p><a href="${unsubscribeUrl(message, env)}">Unsubscribe</a></p>`,
    ].join(''),
    metadata: {
      digestRunId: message.digestRunId ?? null,
      messageId: message.id,
      notificationIds: message.notificationIds ?? [],
      tenantId: message.tenantId,
      userId: message.userId,
    },
    subject: message.subject,
    tags: ['signal_digest', message.tenantId],
    text: [
      message.subject,
      '',
      `Notifications: ${(message.notificationIds ?? []).join(', ') || 'none'}`,
      `Unsubscribe: ${unsubscribeUrl(message, env)}`,
    ].join('\n'),
    to: message.toEmail,
  };
}

function sendGridCustomArgs(message) {
  return {
    signal_digest_run_id: message.digestRunId ?? '',
    signal_message_id: message.id,
    signal_tenant_id: message.tenantId,
    signal_unsubscribe_code: message.unsubscribeCode,
    signal_user_id: message.userId,
  };
}

function sendGridCategories(env = process.env) {
  const configured = optionalString(env.SIGNAL_SENDGRID_CATEGORIES)
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
  const categories = [...new Set(['signal_digest', ...configured])];
  if (categories.length > 10) {
    throw new EmailProviderError('SIGNAL_SENDGRID_CATEGORIES can define at most 9 extra categories.', {
      code: 'EMAIL_PROVIDER_CONFIG_INVALID',
      status: 412,
      details: { label: 'SIGNAL_SENDGRID_CATEGORIES', maxCategories: 10 },
    });
  }
  return categories;
}

function sendGridAsm(env = process.env) {
  const groupId = optionalInteger(env.SIGNAL_SENDGRID_ASM_GROUP_ID, 'SIGNAL_SENDGRID_ASM_GROUP_ID');
  const groupsToDisplay = optionalIntegerList(env.SIGNAL_SENDGRID_ASM_GROUPS_TO_DISPLAY, 'SIGNAL_SENDGRID_ASM_GROUPS_TO_DISPLAY');
  if (!groupId && groupsToDisplay.length > 0) {
    throw new EmailProviderError('SIGNAL_SENDGRID_ASM_GROUP_ID is required when groups to display are configured.', {
      code: 'EMAIL_PROVIDER_CONFIG_INVALID',
      status: 412,
      details: { requiredEnv: 'SIGNAL_SENDGRID_ASM_GROUP_ID' },
    });
  }
  if (!groupId) {
    return null;
  }
  return {
    group_id: groupId,
    ...(groupsToDisplay.length > 0 ? { groups_to_display: groupsToDisplay } : {}),
  };
}

function sendGridTrackingSettings(env = process.env) {
  const clickTracking = optionalBoolean(env.SIGNAL_SENDGRID_CLICK_TRACKING, 'SIGNAL_SENDGRID_CLICK_TRACKING');
  const openTracking = optionalBoolean(env.SIGNAL_SENDGRID_OPEN_TRACKING, 'SIGNAL_SENDGRID_OPEN_TRACKING');
  const settings = {};
  if (clickTracking !== null) {
    settings.click_tracking = { enable: clickTracking };
  }
  if (openTracking !== null) {
    settings.open_tracking = { enable: openTracking };
  }
  return Object.keys(settings).length > 0 ? settings : null;
}

function sendGridDeliveryPayload(message, env = process.env) {
  const customArgs = sendGridCustomArgs(message);
  const unsubscribe = unsubscribeUrl(message, env);
  const oneClickUnsubscribe = unsubscribe.startsWith('http://') || unsubscribe.startsWith('https://');
  const payload = {
    categories: sendGridCategories(env),
    content: [
      {
        type: 'text/plain',
        value: [
          message.subject,
          '',
          `Notifications: ${(message.notificationIds ?? []).join(', ') || 'none'}`,
          `Unsubscribe: ${unsubscribe}`,
        ].join('\n'),
      },
      {
        type: 'text/html',
        value: [
          `<p>${message.subject}</p>`,
          '<ul>',
          ...(message.notificationIds ?? []).map((id) => `<li>${id}</li>`),
          '</ul>',
          `<p><a href="${unsubscribe}">Unsubscribe</a></p>`,
        ].join(''),
      },
    ],
    custom_args: customArgs,
    from: parseAddress(env.SIGNAL_EMAIL_FROM),
    personalizations: [
      {
        custom_args: customArgs,
        headers: {
          'List-Unsubscribe': `<${unsubscribe}>`,
          ...(oneClickUnsubscribe ? { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}),
          'X-Signal-Delivery-Id': message.id,
          'X-Signal-Tenant-Id': message.tenantId,
          'X-Signal-Unsubscribe-Code': message.unsubscribeCode,
        },
        subject: message.subject,
        to: [parseAddress(message.toEmail)],
      },
    ],
    subject: message.subject,
  };

  const asm = sendGridAsm(env);
  if (asm) {
    payload.asm = asm;
  }
  const ipPoolName = optionalString(env.SIGNAL_SENDGRID_IP_POOL_NAME);
  if (ipPoolName) {
    payload.ip_pool_name = ipPoolName;
  }
  const replyTo = optionalString(env.SIGNAL_SENDGRID_REPLY_TO);
  if (replyTo) {
    payload.reply_to = parseAddress(replyTo);
  }
  const trackingSettings = sendGridTrackingSettings(env);
  if (trackingSettings) {
    payload.tracking_settings = trackingSettings;
  }
  if (env.SIGNAL_SENDGRID_SANDBOX_MODE === 'true') {
    payload.mail_settings = {
      sandbox_mode: { enable: true },
    };
  }

  return payload;
}

function normalizeProviderResponse(payload, message, { headers, providerKind = 'generic' } = {}) {
  const sendGridMessageId = providerKind === 'sendgrid'
    ? headers?.get?.('x-message-id') ?? headers?.get?.('X-Message-Id') ?? null
    : null;
  const providerMessageId = sendGridMessageId ?? payload?.id ?? payload?.messageId ?? payload?.providerMessageId ?? `provider_${message.id}`;
  return {
    providerMessageId: String(providerMessageId),
    providerResponseDigest: sha256Digest(JSON.stringify(payload ?? {})),
  };
}

function sendGridEndpoint(env = process.env) {
  const explicit = optionalString(env.SIGNAL_EMAIL_PROVIDER_URL);
  if (explicit) {
    return explicit;
  }
  const baseUrl = optionalString(env.SIGNAL_SENDGRID_API_BASE_URL);
  if (baseUrl) {
    return `${baseUrl.replace(/\/+$/, '')}/v3/mail/send`;
  }
  return SENDGRID_MAIL_SEND_URL;
}

function sendGridApiKey(env = process.env) {
  return requireString(env.SIGNAL_SENDGRID_API_KEY ?? env.SIGNAL_EMAIL_PROVIDER_TOKEN, 'SIGNAL_SENDGRID_API_KEY or SIGNAL_EMAIL_PROVIDER_TOKEN');
}

export async function deliverEmailMessage(message, {
  emailProviderMode,
  env = process.env,
  fetchImpl = globalThis.fetch,
  liveEmailProvider = false,
} = {}) {
  const providerMode = configuredProviderMode({ emailProviderMode, env, liveEmailProvider });

  if (providerMode !== 'live') {
    return {
      acceptedAt: nowIso(),
      provider: 'local_email',
      providerMessageId: `local_${message.id}`,
      providerMode: 'local',
      providerRequestDigest: sha256Digest(JSON.stringify({ messageId: message.id, to: message.toEmail })),
      status: 'sent',
    };
  }

  const providerKind = configuredProviderKind(env);
  const endpoint = providerKind === 'sendgrid'
    ? sendGridEndpoint(env)
    : requireString(env.SIGNAL_EMAIL_PROVIDER_URL, 'SIGNAL_EMAIL_PROVIDER_URL');
  const token = providerKind === 'sendgrid'
    ? sendGridApiKey(env)
    : requireString(env.SIGNAL_EMAIL_PROVIDER_TOKEN, 'SIGNAL_EMAIL_PROVIDER_TOKEN');
  requireString(env.SIGNAL_EMAIL_FROM, 'SIGNAL_EMAIL_FROM');
  if (typeof fetchImpl !== 'function') {
    throw new EmailProviderError('A fetch implementation is required for live email delivery.', {
      code: 'EMAIL_PROVIDER_FETCH_MISSING',
      status: 500,
    });
  }

  const payload = providerKind === 'sendgrid'
    ? sendGridDeliveryPayload(message, env)
    : deliveryPayload(message, env);
  const rawBody = JSON.stringify(payload);
  const response = await providerFetch(endpoint, {
    body: rawBody,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `signal-email-${message.id}`,
    },
    method: 'POST',
  }, { env, fetchImpl });
  const responseText = await response.text();
  let responsePayload = null;
  if (responseText) {
    try {
      responsePayload = JSON.parse(responseText);
    } catch {
      responsePayload = { body: responseText };
    }
  }
  if (!response.ok) {
    throw new EmailProviderError(`Email provider returned ${response.status}.`, {
      code: 'EMAIL_PROVIDER_DELIVERY_FAILED',
      status: 502,
      details: {
        providerStatus: response.status,
        responseDigest: sha256Digest(responseText),
      },
    });
  }
  const normalized = normalizeProviderResponse(responsePayload, message, { headers: response.headers, providerKind });
  return {
    acceptedAt: nowIso(),
    provider: providerKind === 'sendgrid' ? 'sendgrid' : env.SIGNAL_EMAIL_PROVIDER_NAME ?? 'generic_http_email',
    providerMode: 'live',
    providerRequestDigest: sha256Digest(rawBody),
    providerStatus: providerKind === 'sendgrid' ? 'accepted' : responsePayload?.status,
    status: 'sent',
    ...normalized,
  };
}

function parseSignatureHeader(signatureHeader) {
  const parts = String(signatureHeader ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const parsed = Object.fromEntries(parts.map((part) => {
    const [key, ...valueParts] = part.split('=');
    return [key, valueParts.join('=')];
  }));
  const timestamp = Number(parsed.t);
  const digest = parsed.v1;
  if (!Number.isFinite(timestamp)) {
    throw new EmailProviderError('Email webhook signature is missing a valid timestamp.', {
      code: 'EMAIL_WEBHOOK_SIGNATURE_INVALID',
      status: 401,
    });
  }
  if (!digest) {
    throw new EmailProviderError('Email webhook signature is missing a v1 digest.', {
      code: 'EMAIL_WEBHOOK_SIGNATURE_INVALID',
      status: 401,
    });
  }
  return { digest, timestamp };
}

export function signEmailWebhookPayload(rawBody, endpointSecret, { timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const body = requireString(rawBody, 'raw webhook body');
  const secret = requireString(endpointSecret, 'email webhook endpoint secret');
  const signedPayload = `${timestamp}.${body}`;
  const digest = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

export function parseSignedEmailWebhook(rawBody, signatureHeader, endpointSecret, { toleranceSeconds = 300 } = {}) {
  const body = requireString(rawBody, 'raw webhook body');
  const secret = requireString(endpointSecret, 'email webhook endpoint secret');
  const { digest, timestamp } = parseSignatureHeader(signatureHeader);
  const age = Math.floor(Date.now() / 1000) - timestamp;
  if (age > toleranceSeconds || age < 0) {
    throw new EmailProviderError('Email webhook signature timestamp is outside the allowed tolerance.', {
      code: 'EMAIL_WEBHOOK_SIGNATURE_EXPIRED',
      status: 401,
      details: { age, toleranceSeconds },
    });
  }
  const expected = signEmailWebhookPayload(body, secret, { timestamp }).split('v1=')[1];
  if (!/^[a-f0-9]{64}$/i.test(digest) || !/^[a-f0-9]{64}$/i.test(expected)) {
    throw new EmailProviderError('Email webhook signature verification failed.', {
      code: 'EMAIL_WEBHOOK_SIGNATURE_INVALID',
      status: 401,
    });
  }
  const expectedBuffer = Buffer.from(expected, 'hex');
  const digestBuffer = Buffer.from(digest, 'hex');
  if (expectedBuffer.length !== digestBuffer.length) {
    throw new EmailProviderError('Email webhook signature verification failed.', {
      code: 'EMAIL_WEBHOOK_SIGNATURE_INVALID',
      status: 401,
    });
  }
  if (!crypto.timingSafeEqual(expectedBuffer, digestBuffer)) {
    throw new EmailProviderError('Email webhook signature verification failed.', {
      code: 'EMAIL_WEBHOOK_SIGNATURE_INVALID',
      status: 401,
    });
  }
  return parseEmailWebhookPayload(JSON.parse(body), {
    signatureStatus: 'verified',
    signatureTimestamp: timestamp,
    signatureVerifiedAt: nowIso(),
  });
}

function normalizePublicKey(publicKey) {
  const key = requireString(publicKey, 'SendGrid webhook public key').trim();
  if (key.includes('BEGIN PUBLIC KEY')) {
    return key;
  }
  const compact = key.replace(/\s+/g, '');
  const wrapped = compact.match(/.{1,64}/g)?.join('\n') ?? compact;
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
}

export function signSendGridWebhookPayload(rawBody, privateKey, { timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const body = requireString(rawBody, 'raw webhook body');
  const key = requireString(privateKey, 'SendGrid webhook private key');
  const signer = crypto.createSign('sha256');
  signer.update(`${timestamp}${body}`, 'utf8');
  signer.end();
  return {
    signatureHeader: signer.sign(key, 'base64'),
    timestampHeader: String(timestamp),
  };
}

export function verifySendGridWebhookSignature(rawBody, signatureHeader, timestampHeader, publicKey, { nowMs = Date.now(), toleranceSeconds = SENDGRID_WEBHOOK_TOLERANCE_SECONDS } = {}) {
  const body = requireString(rawBody, 'raw webhook body');
  const signature = requireString(signatureHeader, 'X-Twilio-Email-Event-Webhook-Signature');
  const timestamp = Number(requireString(timestampHeader, 'X-Twilio-Email-Event-Webhook-Timestamp'));
  if (!Number.isFinite(timestamp)) {
    throw new EmailProviderError('SendGrid webhook signature is missing a valid timestamp.', {
      code: 'EMAIL_WEBHOOK_SIGNATURE_INVALID',
      status: 401,
    });
  }
  const ageSeconds = Math.floor(nowMs / 1000) - timestamp;
  if (ageSeconds > toleranceSeconds || ageSeconds < 0) {
    throw new EmailProviderError('SendGrid webhook signature timestamp is outside the allowed tolerance.', {
      code: 'EMAIL_WEBHOOK_SIGNATURE_EXPIRED',
      status: 401,
      details: { ageSeconds, toleranceSeconds, timestamp },
    });
  }
  const verifier = crypto.createVerify('sha256');
  verifier.update(`${timestamp}${body}`, 'utf8');
  verifier.end();
  const ok = verifier.verify(normalizePublicKey(publicKey), signature, 'base64');
  if (!ok) {
    throw new EmailProviderError('SendGrid webhook signature verification failed.', {
      code: 'EMAIL_WEBHOOK_SIGNATURE_INVALID',
      status: 401,
    });
  }
  return {
    signatureStatus: 'verified',
    signatureTimestamp: timestamp,
    signatureVerifiedAt: new Date(nowMs).toISOString(),
  };
}

export function parseSignedSendGridWebhook(rawBody, signatureHeader, timestampHeader, publicKey, options = {}) {
  const body = requireString(rawBody, 'raw webhook body');
  const verification = verifySendGridWebhookSignature(body, signatureHeader, timestampHeader, publicKey, options);
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new EmailProviderError('SendGrid webhook body is not valid JSON.', {
      code: 'EMAIL_WEBHOOK_JSON_INVALID',
      status: 400,
    });
  }
  return parseEmailWebhookPayload(payload, verification);
}

function customArg(payload, key) {
  return payload.custom_args?.[key] ?? payload[key] ?? payload.metadata?.[key] ?? null;
}

function parseEmailWebhookEvent(payload, verification = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new EmailProviderError('Email webhook payload must be a JSON object.', {
      code: 'EMAIL_WEBHOOK_PAYLOAD_INVALID',
      status: 400,
    });
  }
  const providerStatus = payload.status ?? payload.event ?? payload.type;
  const statusMap = {
    accepted: 'sent',
    bounce: 'bounced',
    bounced: 'bounced',
    click: 'sent',
    complained: 'suppressed',
    deferred: 'queued',
    delivered: 'sent',
    delivery_failed: 'failed',
    dropped: 'failed',
    failed: 'failed',
    group_unsubscribe: 'suppressed',
    open: 'sent',
    processed: 'sent',
    sent: 'sent',
    spam_complaint: 'suppressed',
    spamreport: 'suppressed',
    suppressed: 'suppressed',
    unsubscribe: 'suppressed',
    unsubscribed: 'suppressed',
  };
  const localStatus = statusMap[providerStatus];
  if (!localStatus) {
    throw new EmailProviderError(`Unsupported email webhook status: ${providerStatus}`, {
      code: 'EMAIL_WEBHOOK_STATUS_UNSUPPORTED',
      status: 400,
      details: { providerStatus },
    });
  }
  const providerName = payload.provider ?? payload.providerName ?? (payload.sg_message_id || payload.sg_event_id ? 'sendgrid' : null);
  return {
    messageId: payload.messageId ?? payload.deliveryMessageId ?? customArg(payload, 'messageId') ?? customArg(payload, 'signal_message_id') ?? null,
    providerEventId: payload.id ?? payload.eventId ?? payload.providerEventId ?? payload.sg_event_id ?? null,
    providerMessageId: payload.providerMessageId ?? payload.message?.id ?? payload.emailId ?? payload.sg_message_id ?? null,
    providerName,
    providerStatus,
    reason: payload.reason ?? payload.error ?? payload.description ?? payload.response ?? payload.reason ?? null,
    signatureStatus: verification.signatureStatus ?? payload.signatureStatus ?? null,
    signatureTimestamp: verification.signatureTimestamp ?? payload.signatureTimestamp ?? null,
    signatureVerifiedAt: verification.signatureVerifiedAt ?? payload.signatureVerifiedAt ?? null,
    status: localStatus,
    unsubscribeCode: payload.unsubscribeCode ?? customArg(payload, 'unsubscribeCode') ?? customArg(payload, 'signal_unsubscribe_code') ?? null,
  };
}

export function parseEmailWebhookPayload(payload, verification = {}) {
  if (Array.isArray(payload)) {
    return payload.map((event) => parseEmailWebhookEvent(event, verification));
  }
  return parseEmailWebhookEvent(payload, verification);
}
