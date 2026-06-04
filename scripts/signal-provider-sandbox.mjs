import crypto from 'node:crypto';
import { SENDGRID_MAIL_SEND_URL } from './signal-email-provider.mjs';
import { STRIPE_API_BASE_URL, STRIPE_API_VERSION } from './signal-payment-provider.mjs';

const GMAIL_PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const OUTLOOK_PROFILE_URL = 'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName';

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function digest(value, length = 24) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, length);
}

function baseUrlFromSendGridMailUrl(env = process.env) {
  const configured = optionalString(env.SIGNAL_SENDGRID_API_BASE_URL);
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  return SENDGRID_MAIL_SEND_URL.replace(/\/mail\/send$/, '');
}

function stripeBaseUrl(env = process.env) {
  return (env.STRIPE_API_BASE_URL ?? STRIPE_API_BASE_URL).replace(/\/+$/, '');
}

function requestDigest({ endpoint, method = 'GET', provider }) {
  return digest(JSON.stringify({ endpoint, method, provider }));
}

async function parseResponseJson(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { parseError: true };
  }
}

function errorDetails(payload = {}) {
  const error = payload.error ?? payload.errors?.[0] ?? {};
  return {
    providerErrorCode: error.code ?? error.error_code ?? null,
    providerErrorType: error.type ?? error.error ?? null,
  };
}

function blockedProvider({ id, label, category, missingRequired, checks = [] }) {
  const providerChecks = [
    ...checks,
    {
      id: `${id}_credentials`,
      status: 'blocked',
      message: `${label} sandbox validation requires ${missingRequired.join(', ')}.`,
    },
  ];
  return {
    id,
    label,
    category,
    status: providerStatus(providerChecks),
    missingRequired,
    checks: providerChecks,
  };
}

async function fetchCheck({ endpoint, fetchImpl, headers, id, message, provider, timeoutMs }) {
  const method = 'GET';
  const request = {
    endpoint,
    method,
    provider,
    requestDigest: requestDigest({ endpoint, method, provider }),
  };
  try {
    const response = await fetchImpl(endpoint, {
      headers,
      method,
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    const payload = await parseResponseJson(response);
    const ok = response.ok;
    return {
      ...request,
      id,
      message: ok ? message : `${message} failed with provider status ${response.status}.`,
      providerRequestId: response.headers?.get?.('x-request-id') ?? response.headers?.get?.('request-id') ?? response.headers?.get?.('stripe-request-id') ?? null,
      status: ok ? 'passed' : 'failed',
      statusCode: response.status,
      ...(!ok ? errorDetails(payload) : {}),
      ...(ok && payload.id ? { objectId: String(payload.id) } : {}),
      ...(ok && payload.historyId ? { objectId: `history:${payload.historyId}` } : {}),
    };
  } catch (error) {
    return {
      ...request,
      id,
      message: error instanceof Error ? error.message : String(error),
      status: 'failed',
    };
  }
}

function providerStatus(checks) {
  if (checks.some((check) => check.status === 'failed')) {
    return 'failed';
  }
  if (checks.some((check) => check.status === 'blocked')) {
    return 'blocked';
  }
  return 'passed';
}

async function validateGmail({ env, fetchImpl, timeoutMs }) {
  const accessToken = optionalString(env.SIGNAL_GMAIL_ACCESS_TOKEN) ?? optionalString(env.SIGNAL_PROVIDER_ACCESS_TOKEN);
  if (!accessToken) {
    return blockedProvider({
      category: 'email',
      id: 'gmail',
      label: 'Gmail',
      missingRequired: ['SIGNAL_GMAIL_ACCESS_TOKEN'],
    });
  }
  const checks = [
    await fetchCheck({
      endpoint: GMAIL_PROFILE_URL,
      fetchImpl,
      headers: { Authorization: `Bearer ${accessToken}` },
      id: 'gmail_profile',
      message: 'Gmail profile endpoint accepted the sandbox access token.',
      provider: 'gmail',
      timeoutMs,
    }),
  ];
  return {
    category: 'email',
    checks,
    id: 'gmail',
    label: 'Gmail',
    missingRequired: [],
    status: providerStatus(checks),
  };
}

async function validateOutlook({ env, fetchImpl, timeoutMs }) {
  const accessToken = optionalString(env.SIGNAL_OUTLOOK_ACCESS_TOKEN) ?? optionalString(env.SIGNAL_PROVIDER_ACCESS_TOKEN);
  if (!accessToken) {
    return blockedProvider({
      category: 'email',
      id: 'outlook',
      label: 'Outlook',
      missingRequired: ['SIGNAL_OUTLOOK_ACCESS_TOKEN'],
    });
  }
  const checks = [
    await fetchCheck({
      endpoint: OUTLOOK_PROFILE_URL,
      fetchImpl,
      headers: { Authorization: `Bearer ${accessToken}` },
      id: 'outlook_profile',
      message: 'Microsoft Graph profile endpoint accepted the sandbox access token.',
      provider: 'outlook',
      timeoutMs,
    }),
  ];
  return {
    category: 'email',
    checks,
    id: 'outlook',
    label: 'Outlook',
    missingRequired: [],
    status: providerStatus(checks),
  };
}

async function validateSendGrid({ env, fetchImpl, timeoutMs }) {
  const apiKey = optionalString(env.SIGNAL_SENDGRID_API_KEY) ?? optionalString(env.SIGNAL_EMAIL_PROVIDER_TOKEN);
  if (!apiKey) {
    return blockedProvider({
      category: 'email',
      id: 'sendgrid',
      label: 'SendGrid',
      missingRequired: ['SIGNAL_SENDGRID_API_KEY'],
    });
  }
  const endpoint = `${baseUrlFromSendGridMailUrl(env)}/user/profile`;
  const checks = [
    await fetchCheck({
      endpoint,
      fetchImpl,
      headers: { Authorization: `Bearer ${apiKey}` },
      id: 'sendgrid_profile',
      message: 'SendGrid profile endpoint accepted the sandbox API key.',
      provider: 'sendgrid',
      timeoutMs,
    }),
  ];
  return {
    category: 'email',
    checks,
    id: 'sendgrid',
    label: 'SendGrid',
    missingRequired: [],
    status: providerStatus(checks),
  };
}

async function validateStripe({ env, fetchImpl, timeoutMs }) {
  const secretKey = optionalString(env.STRIPE_SECRET_KEY);
  const priceId = optionalString(env.SIGNAL_STRIPE_PRICE_TEAM);
  const missingRequired = [
    ...(secretKey ? [] : ['STRIPE_SECRET_KEY']),
    ...(priceId ? [] : ['SIGNAL_STRIPE_PRICE_TEAM']),
  ];
  if (missingRequired.length > 0) {
    return blockedProvider({
      category: 'payment',
      checks: secretKey && !secretKey.startsWith('sk_test_')
        ? [{ id: 'stripe_test_key', message: 'Stripe sandbox validation requires a test secret key prefix.', status: 'failed' }]
        : [],
      id: 'stripe',
      label: 'Stripe',
      missingRequired,
    });
  }
  if (!secretKey.startsWith('sk_test_')) {
    return {
      category: 'payment',
      checks: [{ id: 'stripe_test_key', message: 'Stripe sandbox validation requires STRIPE_SECRET_KEY to start with sk_test_.', status: 'failed' }],
      id: 'stripe',
      label: 'Stripe',
      missingRequired: [],
      status: 'failed',
    };
  }
  const checks = [
    await fetchCheck({
      endpoint: `${stripeBaseUrl(env)}/account`,
      fetchImpl,
      headers: { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': STRIPE_API_VERSION },
      id: 'stripe_account',
      message: 'Stripe account endpoint accepted the sandbox secret key.',
      provider: 'stripe',
      timeoutMs,
    }),
    await fetchCheck({
      endpoint: `${stripeBaseUrl(env)}/prices/${encodeURIComponent(priceId)}`,
      fetchImpl,
      headers: { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': STRIPE_API_VERSION },
      id: 'stripe_team_price',
      message: 'Stripe team price is reachable in the sandbox account.',
      provider: 'stripe',
      timeoutMs,
    }),
  ];
  return {
    category: 'payment',
    checks,
    id: 'stripe',
    label: 'Stripe',
    missingRequired: [],
    status: providerStatus(checks),
  };
}

export async function validateProviderSandbox({ env = process.env, fetchImpl = fetch, timeoutMs = Number(env.SIGNAL_PROVIDER_SANDBOX_TIMEOUT_MS ?? 5000) } = {}) {
  const providers = await Promise.all([
    validateGmail({ env, fetchImpl, timeoutMs }),
    validateOutlook({ env, fetchImpl, timeoutMs }),
    validateSendGrid({ env, fetchImpl, timeoutMs }),
    validateStripe({ env, fetchImpl, timeoutMs }),
  ]);
  const summary = {
    blocked: providers.filter((provider) => provider.status === 'blocked').length,
    failed: providers.filter((provider) => provider.status === 'failed').length,
    passed: providers.filter((provider) => provider.status === 'passed').length,
    total: providers.length,
  };
  return {
    generatedAt: new Date().toISOString(),
    ok: summary.failed === 0 && summary.blocked === 0,
    providers,
    summary,
  };
}
