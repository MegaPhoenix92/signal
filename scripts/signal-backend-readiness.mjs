import {
  isLoopbackApiHost,
  sessionCookieSecure,
} from './signal-api-auth.mjs';

const backendModes = ['local-json', 'production-node', 'external-service'];
const productionAuthProviders = ['managed', 'jwks', 'session'];
const stateServiceBackendModes = ['file', 'postgres'];
const tenantIsolationModes = ['rls', 'policy'];

function configuredEnv(env, keys) {
  return keys.filter((key) => Boolean(env[key]));
}

function missingEnv(env, keys) {
  return keys.filter((key) => !env[key]);
}

function oneOfEnvLabel(keys) {
  return keys.join(' or ');
}

function missingOneOfEnv(env, keys) {
  return configuredEnv(env, keys).length ? [] : [oneOfEnvLabel(keys)];
}

function configuredCorsOrigins(env) {
  return (env.SIGNAL_API_CORS_ORIGINS ?? env.SIGNAL_API_CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isLoopbackOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

function productionModeEnabled(env) {
  return env.NODE_ENV === 'production'
    || env.SIGNAL_BACKEND_MODE === 'production-node'
    || env.SIGNAL_BACKEND_MODE === 'external-service'
    || env.SIGNAL_RUNTIME_ENV === 'production';
}

function productionApiBootChecksRequired(env) {
  const mode = backendModes.includes(env.SIGNAL_BACKEND_MODE) ? env.SIGNAL_BACKEND_MODE : 'local-json';
  return mode !== 'local-json' || !isLoopbackApiHost(env.SIGNAL_API_HOST ?? '127.0.0.1');
}

function configuredCookieSecureEnv(env) {
  if (env.SIGNAL_COOKIE_SECURE === 'true') {
    return ['SIGNAL_COOKIE_SECURE'];
  }
  if (/^https:\/\//i.test(env.SIGNAL_APP_BASE_URL ?? '')) {
    return ['SIGNAL_APP_BASE_URL'];
  }
  return [];
}

function check({
  id,
  label,
  ok,
  localOk = true,
  message,
  requiredEnv = [],
  configured = [],
  missing = [],
  details = {},
}) {
  return {
    id,
    label,
    ok,
    localOk,
    message,
    configuredEnv: configured,
    missingEnv: missing,
    requiredEnv,
    details,
  };
}

export function backendReadiness({ env = process.env, statePath } = {}) {
  const mode = backendModes.includes(env.SIGNAL_BACKEND_MODE) ? env.SIGNAL_BACKEND_MODE : 'local-json';
  const durableStorageEnv = ['DATABASE_URL', 'SIGNAL_STATE_SERVICE_URL'];
  const authProviderEnv = ['SIGNAL_AUTH_PROVIDER', 'SIGNAL_AUTH_JWKS_URL'];
  const schedulerEnv = ['SIGNAL_JOB_SCHEDULER', 'SIGNAL_PROVIDER_VALIDATION_SCHEDULER'];
  const stateServiceDatabaseEnv = ['DATABASE_URL', 'SIGNAL_STATE_SERVICE_DATABASE_URL'];
  const stateServiceStorageEnv = ['SIGNAL_STATE_SERVICE_BACKEND', ...stateServiceDatabaseEnv];
  const tenantIsolationEnv = ['SIGNAL_TENANT_ISOLATION_MODE'];
  const corsOrigins = configuredCorsOrigins(env);
  const durableStorageConfigured = configuredEnv(env, durableStorageEnv);
  const schedulerConfigured = configuredEnv(env, schedulerEnv);
  const stateServiceBackend = env.SIGNAL_STATE_SERVICE_BACKEND;
  const stateServiceDatabaseConfigured = configuredEnv(env, stateServiceDatabaseEnv);
  const authProvider = env.SIGNAL_AUTH_PROVIDER;
  const tenantIsolationMode = env.SIGNAL_TENANT_ISOLATION_MODE;
  const stateServiceRlsEnabled = env.SIGNAL_STATE_SERVICE_RLS === 'true' || env.SIGNAL_STATE_SERVICE_ENABLE_RLS === 'true';
  const signedSessionRequired = env.SIGNAL_REQUIRE_SIGNED_SESSION === 'true';
  const apiBootChecksRequired = productionApiBootChecksRequired(env);
  const cookieSecureReady = sessionCookieSecure(env);
  const localActorProductionBlocked = !(env.SIGNAL_ALLOW_LOCAL_ACTOR === 'true' && productionModeEnabled(env));
  const corsProductionReady = corsOrigins.length > 0 && !corsOrigins.includes('*') && corsOrigins.every((origin) => !isLoopbackOrigin(origin));
  const externalStateService = mode === 'external-service';
  const stateServiceStorageReady = externalStateService
    ? stateServiceBackend === 'postgres' && stateServiceDatabaseConfigured.length > 0
    : mode === 'production-node';
  const tenantIsolationReady = tenantIsolationMode === 'policy'
    || (tenantIsolationMode === 'rls' && stateServiceBackend === 'postgres' && stateServiceRlsEnabled && stateServiceDatabaseConfigured.length > 0);

  const checks = [
    check({
      id: 'backend_mode',
      label: 'Backend mode',
      ok: mode !== 'local-json',
      message: mode === 'local-json'
        ? 'Local JSON state is active for development; production needs a durable backend mode.'
        : `Backend mode ${mode} is configured.`,
      requiredEnv: ['SIGNAL_BACKEND_MODE'],
      configured: env.SIGNAL_BACKEND_MODE ? ['SIGNAL_BACKEND_MODE'] : [],
      missing: env.SIGNAL_BACKEND_MODE ? [] : ['SIGNAL_BACKEND_MODE'],
      details: {
        mode,
        statePath: mode === 'local-json' ? statePath ?? null : null,
      },
    }),
    check({
      id: 'durable_state',
      label: 'Durable state boundary',
      ok: durableStorageConfigured.length > 0,
      message: durableStorageConfigured.length
        ? 'Durable state backend is configured by environment variable name.'
        : 'Production state storage is not configured.',
      requiredEnv: durableStorageEnv,
      configured: durableStorageConfigured,
      missing: durableStorageConfigured.length ? [] : missingEnv(env, durableStorageEnv),
    }),
    check({
      id: 'state_service_storage',
      label: 'State-service storage',
      ok: stateServiceStorageReady,
      message: externalStateService
        ? (stateServiceStorageReady
          ? 'External state service is configured for database-backed storage.'
          : 'External state service should use postgres storage before production.')
        : (mode === 'production-node'
          ? 'Production-node mode uses the application database boundary.'
          : 'State-service storage is not active in local JSON mode.'),
      requiredEnv: externalStateService ? stateServiceStorageEnv : [],
      configured: externalStateService
        ? [
          ...(stateServiceBackend ? ['SIGNAL_STATE_SERVICE_BACKEND'] : []),
          ...stateServiceDatabaseConfigured,
        ]
        : [],
      missing: externalStateService
        ? [
          ...(stateServiceBackend ? [] : ['SIGNAL_STATE_SERVICE_BACKEND']),
          ...missingOneOfEnv(env, stateServiceDatabaseEnv),
        ]
        : [],
      details: {
        backend: stateServiceBackendModes.includes(stateServiceBackend) ? stateServiceBackend : null,
      },
    }),
    check({
      id: 'signed_session_enforced',
      label: 'Signed session enforcement',
      ok: signedSessionRequired && Boolean(env.SIGNAL_SESSION_SECRET),
      message: signedSessionRequired && env.SIGNAL_SESSION_SECRET
        ? 'Signed-session enforcement is enabled for API actor resolution.'
        : 'Production API mode must disable raw actor fallback and require signed sessions.',
      requiredEnv: ['SIGNAL_REQUIRE_SIGNED_SESSION', 'SIGNAL_SESSION_SECRET'],
      configured: configuredEnv(env, ['SIGNAL_REQUIRE_SIGNED_SESSION', 'SIGNAL_SESSION_SECRET']),
      missing: missingEnv(env, ['SIGNAL_REQUIRE_SIGNED_SESSION', 'SIGNAL_SESSION_SECRET']),
    }),
    check({
      id: 'session_cookie_secure',
      label: 'Secure session cookies',
      ok: !apiBootChecksRequired || !signedSessionRequired || cookieSecureReady,
      message: !apiBootChecksRequired || !signedSessionRequired
        ? 'Secure session cookies are only required for non-loopback signed-session API boot.'
        : (cookieSecureReady
          ? 'Signed-session cookies are marked secure for non-loopback API boot.'
          : 'Non-loopback signed-session mode requires SIGNAL_COOKIE_SECURE=true or an HTTPS SIGNAL_APP_BASE_URL.'),
      requiredEnv: apiBootChecksRequired && signedSessionRequired
        ? ['SIGNAL_COOKIE_SECURE', 'SIGNAL_APP_BASE_URL']
        : [],
      configured: configuredCookieSecureEnv(env),
      missing: apiBootChecksRequired && signedSessionRequired && !cookieSecureReady
        ? ['SIGNAL_COOKIE_SECURE']
        : [],
    }),
    check({
      id: 'system_webhook_actor',
      label: 'Webhook system actor',
      ok: !apiBootChecksRequired || Boolean(env.SIGNAL_WEBHOOK_ACTOR),
      message: !apiBootChecksRequired
        ? 'Webhook system actor is only required for non-loopback API boot.'
        : (env.SIGNAL_WEBHOOK_ACTOR
          ? 'Webhook mutations use a configured system actor on non-loopback hosts.'
          : 'Non-loopback hosts require SIGNAL_WEBHOOK_ACTOR for webhook mutations.'),
      requiredEnv: apiBootChecksRequired ? ['SIGNAL_WEBHOOK_ACTOR'] : [],
      configured: env.SIGNAL_WEBHOOK_ACTOR ? ['SIGNAL_WEBHOOK_ACTOR'] : [],
      missing: apiBootChecksRequired && !env.SIGNAL_WEBHOOK_ACTOR ? ['SIGNAL_WEBHOOK_ACTOR'] : [],
    }),
    check({
      id: 'system_oauth_actor',
      label: 'OAuth callback system actor',
      ok: !apiBootChecksRequired || Boolean(env.SIGNAL_OAUTH_ACTOR),
      message: !apiBootChecksRequired
        ? 'OAuth callback system actor is only required for non-loopback API boot.'
        : (env.SIGNAL_OAUTH_ACTOR
          ? 'OAuth callback mutations use a configured system actor on non-loopback hosts.'
          : 'Non-loopback hosts require SIGNAL_OAUTH_ACTOR for OAuth callback mutations.'),
      requiredEnv: apiBootChecksRequired ? ['SIGNAL_OAUTH_ACTOR'] : [],
      configured: env.SIGNAL_OAUTH_ACTOR ? ['SIGNAL_OAUTH_ACTOR'] : [],
      missing: apiBootChecksRequired && !env.SIGNAL_OAUTH_ACTOR ? ['SIGNAL_OAUTH_ACTOR'] : [],
    }),
    check({
      id: 'local_actor_disabled',
      label: 'Local actor production block',
      ok: localActorProductionBlocked,
      message: localActorProductionBlocked
        ? 'Local actor impersonation is disabled for production mode.'
        : 'SIGNAL_ALLOW_LOCAL_ACTOR must not be enabled in production mode.',
      configured: env.SIGNAL_ALLOW_LOCAL_ACTOR ? ['SIGNAL_ALLOW_LOCAL_ACTOR'] : [],
      details: {
        productionMode: productionModeEnabled(env),
      },
    }),
    check({
      id: 'production_auth_provider',
      label: 'Production auth provider',
      ok: productionAuthProviders.includes(authProvider) && (authProvider !== 'jwks' || Boolean(env.SIGNAL_AUTH_JWKS_URL)),
      message: productionAuthProviders.includes(authProvider)
        ? 'Production auth provider boundary is declared.'
        : 'Production auth provider is not declared.',
      requiredEnv: authProviderEnv,
      configured: configuredEnv(env, authProviderEnv),
      missing: missingEnv(env, authProviderEnv),
      details: {
        provider: productionAuthProviders.includes(authProvider) ? authProvider : null,
      },
    }),
    check({
      id: 'cors_origins',
      label: 'Production CORS origins',
      ok: corsProductionReady,
      message: corsProductionReady
        ? 'CORS is restricted to configured non-loopback origins.'
        : 'Production CORS needs explicit non-wildcard, non-loopback origins.',
      requiredEnv: ['SIGNAL_API_CORS_ORIGINS'],
      configured: corsOrigins.length ? ['SIGNAL_API_CORS_ORIGINS'] : [],
      missing: corsOrigins.length ? [] : ['SIGNAL_API_CORS_ORIGINS'],
      details: {
        originCount: corsOrigins.length,
        wildcard: corsOrigins.includes('*'),
        loopbackOrigins: corsOrigins.filter((origin) => isLoopbackOrigin(origin)).length,
      },
    }),
    check({
      id: 'job_scheduler',
      label: 'Production job scheduler',
      ok: schedulerConfigured.length > 0,
      message: schedulerConfigured.length
        ? 'Production job scheduler boundary is configured by environment variable name.'
        : 'Production scheduler is not configured for provider validation, sync, digest, and billing jobs.',
      requiredEnv: schedulerEnv,
      configured: schedulerConfigured,
      missing: missingEnv(env, schedulerEnv),
    }),
    check({
      id: 'tenant_isolation',
      label: 'Tenant isolation',
      ok: tenantIsolationReady,
      message: tenantIsolationReady
        ? (tenantIsolationMode === 'rls'
          ? 'Postgres RLS mode is configured; the state service creates and verifies service-role pg_policies on monolithic state tables at startup.'
          : 'Tenant isolation policy mode is declared for multi-org enforcement.')
        : (tenantIsolationMode === 'rls'
          ? 'RLS mode requires postgres state-service storage plus SIGNAL_STATE_SERVICE_RLS=true so startup verifies service-role pg_policies on monolithic state tables.'
          : 'Production multi-org support needs durable tenant isolation such as RLS or policy enforcement.'),
      requiredEnv: tenantIsolationMode === 'rls'
        ? ['SIGNAL_TENANT_ISOLATION_MODE', 'SIGNAL_STATE_SERVICE_BACKEND', 'SIGNAL_STATE_SERVICE_RLS', ...stateServiceDatabaseEnv]
        : tenantIsolationEnv,
      configured: [
        ...configuredEnv(env, tenantIsolationEnv),
        ...(stateServiceBackend ? ['SIGNAL_STATE_SERVICE_BACKEND'] : []),
        ...(stateServiceRlsEnabled ? ['SIGNAL_STATE_SERVICE_RLS'] : []),
        ...stateServiceDatabaseConfigured,
      ],
      missing: tenantIsolationMode === 'rls'
        ? [
          ...(stateServiceBackend === 'postgres' ? [] : ['SIGNAL_STATE_SERVICE_BACKEND']),
          ...(stateServiceRlsEnabled ? [] : ['SIGNAL_STATE_SERVICE_RLS']),
          ...missingOneOfEnv(env, stateServiceDatabaseEnv),
        ]
        : missingEnv(env, tenantIsolationEnv),
      details: {
        mode: tenantIsolationModes.includes(tenantIsolationMode) ? tenantIsolationMode : null,
        rlsCatalogVerifiedOnStartup: tenantIsolationMode === 'rls' ? stateServiceRlsEnabled : null,
        stateServiceBackend: stateServiceBackendModes.includes(stateServiceBackend) ? stateServiceBackend : null,
      },
    }),
  ];

  return {
    ok: checks.every((item) => item.localOk),
    productionReady: checks.every((item) => item.ok),
    localOnly: mode === 'local-json',
    mode,
    checks,
    summary: {
      readyChecks: checks.filter((item) => item.ok).length,
      totalChecks: checks.length,
      missingRequiredEnv: [...new Set(checks.flatMap((item) => item.missingEnv))],
    },
  };
}
