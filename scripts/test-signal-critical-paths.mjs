#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bootstrapState,
  issueSessionToken,
  registerTenantWorkspace,
} from './signal-state.mjs';
import { parseSignedEmailWebhook, signEmailWebhookPayload, signSendGridWebhookPayload, verifySendGridWebhookSignature } from './signal-email-provider.mjs';
import { signStripeWebhookPayload } from './signal-payment-provider.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => {
        if (!port) {
          reject(new Error('Failed to allocate a local test port.'));
          return;
        }
        resolve(port);
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseJsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    sleep(2000),
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

async function startApi({
  emailWebhookSecret,
  port,
  sendGridPublicKey,
  sessionSecret,
  statePath,
  stripeWebhookSecret,
}) {
  const apiBaseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'signal-api.mjs')], {
    cwd: rootDir,
    env: {
      ...process.env,
      SIGNAL_ADMIN_STATE: statePath,
      SIGNAL_API_HOST: '127.0.0.1',
      SIGNAL_API_PORT: String(port),
      SIGNAL_EMAIL_STATUS_WEBHOOK_SECRET: emailWebhookSecret,
      SIGNAL_REQUIRE_SIGNED_SESSION: 'true',
      SIGNAL_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: sendGridPublicKey,
      SIGNAL_SESSION_SECRET: sessionSecret,
      SIGNAL_WEBHOOK_ACTOR: 'usr_admin',
      STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Signal API exited before critical-path test startup.\n${output}`);
    }
    try {
      const response = await fetch(`${apiBaseUrl}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        return { apiBaseUrl, child, output: () => output };
      }
    } catch {
      // Keep polling until the API binds the requested port.
    }
    await sleep(100);
  }
  throw new Error(`Signal API did not start on ${apiBaseUrl}.\n${output}`);
}

async function requestApi(apiBaseUrl, pathname, { body, headers = {}, method = 'GET', token } = {}) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    method,
  });
  return {
    payload: await parseJsonResponse(response),
    status: response.status,
  };
}

test('HTTP API scopes tenant B state away from tenant A users and blocks cross-tenant mutations', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-critical-tenant-http-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const sessionSecret = 'signal_critical_tenant_secret_32chars!';
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const tenantB = await registerTenantWorkspace({
    adminEmail: 'owner@beta-critical.example',
    adminName: 'Beta Critical Owner',
    domain: 'beta-critical.example',
    name: 'Beta Critical Labs',
    planId: 'plan_team',
  }, { statePath });
  const tenantBToken = (await issueSessionToken(tenantB.actor.id, {
    actorUserId: tenantB.actor.id,
    env: { SIGNAL_SESSION_SECRET: sessionSecret },
    statePath,
    ttlSeconds: 900,
  })).details.token;

  api = await startApi({
    emailWebhookSecret: 'email_critical_webhook_secret',
    port,
    sendGridPublicKey: crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'pem', type: 'spki' }),
    sessionSecret,
    statePath,
    stripeWebhookSecret: 'stripe_critical_webhook_secret',
  });

  const scopedState = await requestApi(api.apiBaseUrl, '/api/state', { token: tenantBToken });
  assert.equal(scopedState.status, 200);
  assert(!scopedState.payload.state.users.some((user) => user.id === 'usr_sales'), 'tenant B actor must not receive tenant A users in scoped API state');
  assert(!scopedState.payload.state.users.some((user) => user.tenantId === 'tenant_demo'), 'tenant B actor must not receive tenant A membership users in scoped API state');
  assert.equal(scopedState.payload.state.tenants.length, 1);
  assert.equal(scopedState.payload.state.tenants[0].id, tenantB.details.tenantId);

  const crossTenantRoleChange = await requestApi(api.apiBaseUrl, '/api/mutations', {
    body: {
      action: 'users.role',
      args: {
        role: 'admin',
        userId: 'usr_sales',
      },
    },
    method: 'POST',
    token: tenantBToken,
  });
  assert.equal(crossTenantRoleChange.status, 403);
  assert.equal(crossTenantRoleChange.payload.code, 'FORBIDDEN');
});

test('signed Stripe webhook replay with the same provider event id is a no-op duplicate', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-critical-stripe-dup-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const sessionSecret = 'signal_critical_stripe_secret_32chars!';
  const stripeWebhookSecret = 'signal_critical_stripe_webhook_secret';
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  api = await startApi({
    emailWebhookSecret: 'email_critical_webhook_secret',
    port,
    sendGridPublicKey: crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'pem', type: 'spki' }),
    sessionSecret,
    statePath,
    stripeWebhookSecret,
  });

  const eventBody = JSON.stringify({
    id: 'evt_critical_path_duplicate',
    type: 'invoice.payment_failed',
    livemode: false,
    data: {
      object: {
        id: 'in_critical_duplicate',
        object: 'invoice',
        amount_due: 4900,
        customer: 'cus_critical_duplicate',
        subscription: 'sub_demo',
      },
    },
  });
  const signature = signStripeWebhookPayload(eventBody, stripeWebhookSecret);

  async function postStripe(body, sig) {
    const response = await fetch(`${api.apiBaseUrl}/api/webhooks/stripe`, {
      body,
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': sig,
      },
      method: 'POST',
    });
    return {
      payload: await parseJsonResponse(response),
      status: response.status,
    };
  }

  const first = await postStripe(eventBody, signature);
  assert.equal(first.status, 200);
  assert.equal(first.payload.details.providerEventId, 'evt_critical_path_duplicate');
  assert.notEqual(first.payload.details.duplicate, true);

  const stateAfterFirst = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const paymentEventsAfterFirst = (stateAfterFirst.paymentEvents ?? []).filter((event) => event.providerEventId === 'evt_critical_path_duplicate');
  const subscriptionStatusAfterFirst = stateAfterFirst.subscriptions.find((item) => item.id === 'sub_demo')?.status;

  const second = await postStripe(eventBody, signature);
  assert.equal(second.status, 200);
  assert.equal(second.payload.details.duplicate, true);
  assert.equal(second.payload.details.status, 'duplicate');

  const stateAfterSecond = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const paymentEventsAfterSecond = (stateAfterSecond.paymentEvents ?? []).filter((event) => event.providerEventId === 'evt_critical_path_duplicate');
  assert.equal(paymentEventsAfterSecond.length, paymentEventsAfterFirst.length, 'duplicate Stripe webhook must not append another provider event record');
  assert.equal(
    stateAfterSecond.subscriptions.find((item) => item.id === 'sub_demo')?.status,
    subscriptionStatusAfterFirst,
    'duplicate Stripe webhook must not mutate subscription state',
  );
});

test('signed webhook verifiers reject tampered Stripe, email, and SendGrid signatures at the HTTP boundary', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-critical-webhook-sig-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const sessionSecret = 'signal_critical_webhook_secret_32chars!';
  const emailWebhookSecret = 'signal_critical_email_webhook_secret';
  const stripeWebhookSecret = 'signal_critical_stripe_webhook_secret';
  const sendGridKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sendGridPublicKey = sendGridKeyPair.publicKey.export({ format: 'pem', type: 'spki' });
  const port = await freePort();
  let api = null;

  t.after(async () => {
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  const adminToken = (await issueSessionToken('usr_admin', {
    actorUserId: 'usr_admin',
    env: { SIGNAL_SESSION_SECRET: sessionSecret },
    statePath,
    ttlSeconds: 900,
  })).details.token;

  api = await startApi({
    emailWebhookSecret,
    port,
    sendGridPublicKey,
    sessionSecret,
    statePath,
    stripeWebhookSecret,
  });

  const stripeBody = JSON.stringify({
    id: 'evt_critical_tampered_stripe',
    type: 'invoice.payment_failed',
    livemode: false,
    data: {
      object: {
        id: 'in_critical_tampered',
        object: 'invoice',
        subscription: 'sub_demo',
      },
    },
  });
  const tamperedStripe = await fetch(`${api.apiBaseUrl}/api/webhooks/stripe`, {
    body: stripeBody,
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': signStripeWebhookPayload(stripeBody, 'whsec_wrong_secret_value'),
    },
    method: 'POST',
  });
  assert.equal(tamperedStripe.status, 400);
  assert.equal((await parseJsonResponse(tamperedStripe)).code, 'PAYMENT_WEBHOOK_SIGNATURE_INVALID');

  const digest = await requestApi(api.apiBaseUrl, '/api/mutations', {
    body: {
      action: 'notifications.digest-run',
      args: { tenantId: 'tenant_demo' },
    },
    method: 'POST',
    token: adminToken,
  });
  assert.equal(digest.status, 200);
  const deliveryMessageId = digest.payload.details.deliveryMessageIds[0];
  assert(deliveryMessageId, 'digest run should create an outbound delivery record');

  const emailBody = JSON.stringify({
    id: 'evt_critical_tampered_email',
    messageId: deliveryMessageId,
    provider: 'critical_mail',
    reason: 'Tampered signature test',
    status: 'bounced',
  });
  const tamperedEmail = await fetch(`${api.apiBaseUrl}/api/webhooks/email`, {
    body: emailBody,
    headers: {
      'Content-Type': 'application/json',
      'Signal-Email-Signature': signEmailWebhookPayload(emailBody, 'wrong_email_webhook_secret'),
    },
    method: 'POST',
  });
  assert.equal(tamperedEmail.status, 401);
  assert.equal((await parseJsonResponse(tamperedEmail)).code, 'EMAIL_WEBHOOK_SIGNATURE_INVALID');

  const sendGridBody = JSON.stringify([
    {
      event: 'delivered',
      sg_event_id: 'sg_critical_tampered',
      sg_message_id: 'sg_critical_message',
      signal_message_id: deliveryMessageId,
    },
  ]);
  const sendGridSigned = signSendGridWebhookPayload(sendGridBody, sendGridKeyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const tamperedSendGrid = await fetch(`${api.apiBaseUrl}/api/webhooks/email`, {
    body: `${sendGridBody.slice(0, -1)} }`,
    headers: {
      'Content-Type': 'application/json',
      'X-Twilio-Email-Event-Webhook-Signature': sendGridSigned.signatureHeader,
      'X-Twilio-Email-Event-Webhook-Timestamp': sendGridSigned.timestampHeader,
    },
    method: 'POST',
  });
  assert.equal(tamperedSendGrid.status, 401);
  assert.equal((await parseJsonResponse(tamperedSendGrid)).code, 'EMAIL_WEBHOOK_SIGNATURE_INVALID');
});

test('email webhook verification rejects future-dated signatures', () => {
  const body = JSON.stringify({ id: 'evt_future_email', messageId: 'msg_future', status: 'sent' });
  const secret = 'email_future_timestamp_secret';
  const futureTimestamp = Math.floor(Date.now() / 1000) + 120;
  const signature = signEmailWebhookPayload(body, secret, { timestamp: futureTimestamp });

  assert.throws(
    () => parseSignedEmailWebhook(body, signature, secret),
    (error) => error.code === 'EMAIL_WEBHOOK_SIGNATURE_EXPIRED',
  );
});

test('SendGrid webhook verification rejects future-dated signatures', () => {
  const body = JSON.stringify([{ event: 'delivered', sg_event_id: 'sg_future' }]);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const futureTimestamp = Math.floor(Date.now() / 1000) + 120;
  const signed = signSendGridWebhookPayload(body, privateKey.export({ format: 'pem', type: 'pkcs8' }), { timestamp: futureTimestamp });

  assert.throws(
    () => verifySendGridWebhookSignature(body, signed.signatureHeader, signed.timestampHeader, publicKey.export({ format: 'pem', type: 'spki' })),
    (error) => error.code === 'EMAIL_WEBHOOK_SIGNATURE_EXPIRED',
  );
});