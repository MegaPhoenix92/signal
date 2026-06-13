#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bootstrapState,
} from './signal-state.mjs';

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

async function stopProcess(child) {
  if (!child) {
    return;
  }
  const closeStreams = () => {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
  };
  if (child.exitCode !== null) {
    closeStreams();
    return;
  }
  const kill = (signal) => {
    try {
      if (child.pid && process.platform !== 'win32') {
        process.kill(-child.pid, signal);
        return;
      }
    } catch {
      // Fall back to killing only the direct child below.
    }
    child.kill(signal);
  };
  kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    sleep(2000),
  ]);
  if (child.exitCode === null) {
    kill('SIGKILL');
    await Promise.race([
      new Promise((resolve) => child.once('close', resolve)),
      sleep(2000),
    ]);
  }
  closeStreams();
}

async function waitForHttp(url, output, label, { attempts = 80 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the local service binds.
    }
    await sleep(100);
  }
  throw new Error(`${label} did not become ready at ${url}.\n${output()}`);
}

function processOutputCollector(child) {
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    output += chunk.toString();
  });
  return () => output;
}

async function startApi({ apiPort, statePath }) {
  const child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'signal-api.mjs')], {
    cwd: rootDir,
    env: {
      ...process.env,
      SIGNAL_ADMIN_STATE: statePath,
      SIGNAL_ALLOW_LOCAL_ACTOR: 'true',
      SIGNAL_API_HOST: '127.0.0.1',
      SIGNAL_API_PORT: String(apiPort),
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = processOutputCollector(child);
  await waitForHttp(`http://127.0.0.1:${apiPort}/api/health`, output, 'Signal API');
  return { child, output };
}

async function startVite({ apiPort, webPort }) {
  const child = spawn(process.execPath, [path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
    cwd: rootDir,
    env: {
      ...process.env,
      VITE_SIGNAL_API_URL: `http://127.0.0.1:${apiPort}`,
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = processOutputCollector(child);
  await waitForHttp(`http://127.0.0.1:${webPort}/`, output, 'Vite web app');
  return { child, output };
}

async function resolveChromeExecutable() {
  if (process.env.SIGNAL_CHROME_BIN) {
    try {
      await fs.access(process.env.SIGNAL_CHROME_BIN, fs.constants.X_OK);
      return process.env.SIGNAL_CHROME_BIN;
    } catch {
      throw new Error(`SIGNAL_CHROME_BIN is set but not executable: ${process.env.SIGNAL_CHROME_BIN}`);
    }
  }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next common local browser path.
    }
  }
  return null;
}

async function startChrome({ cdpPort, executable, profileDir }) {
  const args = [
    '--headless=new',
    '--disable-background-networking',
    '--disable-crash-reporter',
    '--disable-extensions',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-default-browser-check',
    '--no-first-run',
    '--remote-allow-origins=*',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ];
  if (process.env.SIGNAL_CHROME_NO_SANDBOX === 'true') {
    args.splice(1, 0, '--no-sandbox');
  }
  const child = spawn(executable, args, {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = processOutputCollector(child);
  await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, output, 'Headless Chrome CDP', { attempts: 250 });
  return { child, output };
}

class CdpClient {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.events = [];
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          reject(new Error(`${message.error.message}: ${message.error.data ?? ''}`));
        } else {
          resolve(message.result);
        }
        return;
      }
      if (message.method) {
        this.events.push(message);
        this.waiters = this.waiters.filter((waiter) => {
          if (waiter.method === message.method && waiter.predicate(message.params ?? {})) {
            clearTimeout(waiter.timer);
            waiter.resolve(message.params ?? {});
            return false;
          }
          return true;
        });
      }
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  waitForEvent(method, predicate = () => true, timeoutMs = 10000) {
    const existing = this.events.find((event) => event.method === method && predicate(event.params ?? {}));
    if (existing) {
      return Promise.resolve(existing.params ?? {});
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      this.waiters.push({ method, predicate, resolve, timer });
    });
  }

  async close() {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      return;
    }
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
    }
    this.waiters = [];
    if (this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) {
      this.ws.close();
    }
    await Promise.race([
      new Promise((resolve) => this.ws.addEventListener('close', resolve, { once: true })),
      sleep(1000),
    ]);
  }

  clearEvents() {
    this.events = [];
  }
}

async function openCdpPage({ cdpPort }) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
  assert.equal(response.status, 200);
  const target = await response.json();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  return client;
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? 'Runtime.evaluate failed');
  }
  return result.result?.value;
}

async function waitForText(client, expectedText, timeoutMs = 10000) {
  const start = Date.now();
  let lastSnapshot = null;
  const normalizedExpected = String(expectedText).toLowerCase();
  while (Date.now() - start < timeoutMs) {
    const text = await evaluate(client, 'document.body.innerText');
    lastSnapshot = await evaluate(client, `(() => ({
      readyState: document.readyState,
      text: document.body.innerText.slice(0, 500),
      title: document.title,
      url: window.location.href
    }))()`);
    if (String(text).toLowerCase().includes(normalizedExpected)) {
      return text;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for browser text: ${expectedText}\n${JSON.stringify(lastSnapshot, null, 2)}`);
}

async function navigate(client, url, expectedText) {
  client.clearEvents();
  const navigation = await client.send('Page.navigate', { url });
  if (navigation.errorText) {
    throw new Error(`Browser navigation failed: ${navigation.errorText}`);
  }
  if (navigation.loaderId) {
    await client.waitForEvent('Page.loadEventFired', () => true, 10000);
  }
  const text = await waitForText(client, expectedText);
  const snapshot = await evaluate(client, `(() => ({
    errorOverlay: Boolean(document.querySelector('vite-error-overlay')) || document.body.innerText.includes('Internal server error'),
    hash: window.location.hash,
    headingCount: document.querySelectorAll('h1').length,
    navText: document.querySelector('nav')?.innerText ?? '',
    title: document.title,
    url: window.location.href
  }))()`);
  return { snapshot, text };
}

function assertTextIncludes(text, expected, message) {
  assert(String(text).toLowerCase().includes(String(expected).toLowerCase()), message ?? `Expected browser text to include ${expected}`);
}

test('Signal browser routes render public, registration, workspace, and admin app areas', async (t) => {
  const chromeExecutable = await resolveChromeExecutable();
  if (!chromeExecutable) {
    t.skip('No Chrome-compatible browser found. Set SIGNAL_CHROME_BIN to run browser route tests.');
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-browser-routes-'));
  const statePath = path.join(tempDir, 'signal-state.json');
  const profileDir = path.join(tempDir, 'chrome-profile');
  const apiPort = await freePort();
  const webPort = await freePort();
  const cdpPort = await freePort();
  let api = null;
  let web = null;
  let chrome = null;
  let client = null;

  t.after(async () => {
    await client?.close();
    await stopProcess(chrome?.child);
    await stopProcess(web?.child);
    await stopProcess(api?.child);
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  await bootstrapState({ force: true, statePath });
  api = await startApi({ apiPort, statePath });
  web = await startVite({ apiPort, webPort });
  chrome = await startChrome({ cdpPort, executable: chromeExecutable, profileDir });
  client = await openCdpPage({ cdpPort });

  const baseUrl = `http://127.0.0.1:${webPort}/`;
  const publicRoute = await navigate(client, `${baseUrl}#top`, 'Permissioned inbox intelligence');
  assert.equal(publicRoute.snapshot.hash, '#top');
  assert.equal(publicRoute.snapshot.title, 'Signal - Inbox Intelligence for Sales and Product Teams');
  assert.equal(publicRoute.snapshot.errorOverlay, false);
  assertTextIncludes(publicRoute.text, 'Create workspace', 'public route should expose the registration CTA');
  assertTextIncludes(publicRoute.text, 'Gmail + Outlook', 'public route should describe supported inbox sources');

  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const mobileNav = await evaluate(client, `(async () => {
    const button = document.querySelector('.mobile-nav-toggle');
    if (!button) {
      throw new Error('Mobile navigation toggle missing');
    }
    button.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const panel = document.querySelector('#mobile-nav-menu');
    const open = {
      ariaExpanded: button.getAttribute('aria-expanded'),
      buttonDisplay: getComputedStyle(button).display,
      hidden: panel?.hidden,
      text: panel?.innerText ?? '',
    };
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      open,
      closedExpanded: button.getAttribute('aria-expanded'),
      closedHidden: panel?.hidden,
    };
  })()`);
  assert.notEqual(mobileNav.open.buttonDisplay, 'none', 'mobile navigation toggle should be visible at narrow widths');
  assert.equal(mobileNav.open.ariaExpanded, 'true', 'mobile navigation should report expanded after toggle');
  assert.equal(mobileNav.open.hidden, false, 'mobile navigation panel should open from hamburger');
  assertTextIncludes(mobileNav.open.text, 'Admin', 'mobile navigation should include app area links');
  assert.equal(mobileNav.closedExpanded, 'false', 'Escape should close the mobile navigation');
  assert.equal(mobileNav.closedHidden, true, 'Escape should hide the mobile navigation panel');
  await client.send('Emulation.clearDeviceMetricsOverride');

  const registerRoute = await navigate(client, `${baseUrl}#register`, 'Create the workspace before the dashboard.');
  assert.equal(registerRoute.snapshot.hash, '#register');
  assert.equal(registerRoute.snapshot.errorOverlay, false);
  assertTextIncludes(registerRoute.text, 'Workspace registration', 'registration route should render workspace creation');
  assertTextIncludes(registerRoute.text, 'Self-service registration', 'registration route should describe self-service workspace creation');
  assertTextIncludes(registerRoute.text, 'Member invitation', 'registration route should render member invitation');
  assertTextIncludes(registerRoute.text, 'Invite acceptance', 'registration route should render invite acceptance');
  assertTextIncludes(registerRoute.text, 'Claim invite', 'registration route should expose self-service invite claim');
  assertTextIncludes(registerRoute.text, 'Claim code', 'registration route should render claim code input');
  assertTextIncludes(registerRoute.text, 'Complete auth', 'registration route should expose local mailbox auth completion');
  assertTextIncludes(registerRoute.text, 'Complete onboarding', 'registration route should expose onboarding completion action');
  assertTextIncludes(registerRoute.text, 'RBAC and privacy proof', 'registration route should render membership privacy evidence');
  assertTextIncludes(registerRoute.text, 'Onboarding and org decision', 'registration route should render multi-member org decision evidence');
  assertTextIncludes(registerRoute.text, 'support multi member orgs', 'registration route should recommend the multi-member workspace model');
  assertTextIncludes(registerRoute.text, 'onboarding-readiness --json', 'registration route should expose onboarding readiness CLI command');
  assertTextIncludes(registerRoute.text, '/api/onboarding-readiness', 'registration route should expose onboarding readiness API command');
  assertTextIncludes(registerRoute.text, 'tenants register', 'registration route should expose self-service workspace CLI command');
  assertTextIncludes(registerRoute.text, 'tenants complete-onboarding', 'registration route should expose onboarding completion CLI command');
  assertTextIncludes(registerRoute.text, 'tenants.onboarding-complete', 'registration route should expose onboarding completion mutation action');
  assertTextIncludes(registerRoute.text, '/api/registration', 'registration route should expose public workspace registration API command');
  assertTextIncludes(registerRoute.text, 'tenants create', 'registration route should keep admin-created workspace CLI command');
  assertTextIncludes(registerRoute.text, 'users invite', 'registration route should expose invite CLI command');
  assertTextIncludes(registerRoute.text, 'users claim', 'registration route should expose invite claim CLI command');
  assertTextIncludes(registerRoute.text, 'users accept', 'registration route should keep admin invite acceptance CLI command');

  const workspaceRoute = await navigate(client, `${baseUrl}#workspace`, 'Revenue signals for Acme Revenue Lab.');
  assert.equal(workspaceRoute.snapshot.hash, '#workspace');
  assert.equal(workspaceRoute.snapshot.errorOverlay, false);
  assertTextIncludes(workspaceRoute.text, 'Signal queue', 'workspace route should render the user signal queue');
  assertTextIncludes(workspaceRoute.text, 'Mailbox sources', 'workspace route should render source status cards');
  assertTextIncludes(workspaceRoute.text, 'Sync source', 'workspace route should expose source self-service controls');
  assertTextIncludes(workspaceRoute.text, 'Notification center', 'workspace route should render notification controls');
  assertTextIncludes(workspaceRoute.text, 'Account reviews', 'workspace route should render account review controls');
  assertTextIncludes(workspaceRoute.text, 'Strategy recommendations', 'workspace route should render account strategy recommendations');
  assertTextIncludes(workspaceRoute.text, 'CRM handoff', 'workspace route should expose signal CRM handoff controls');
  assertTextIncludes(workspaceRoute.text, 'Billing and usage', 'workspace route should render user billing controls');
  assertTextIncludes(workspaceRoute.text, 'Lifecycle notices', 'workspace route should render lifecycle notice monitoring');
  assertTextIncludes(workspaceRoute.text, 'Dashboard QA', 'workspace route should render state-backed dashboard QA');
  assertTextIncludes(workspaceRoute.text, 'Membership seats', 'workspace QA should expose membership-backed seat calculations');
  assertTextIncludes(workspaceRoute.text, 'Multi-member workspace', 'workspace QA should expose the selected organization model');
  assertTextIncludes(workspaceRoute.text, 'Onboarding readiness', 'workspace QA should expose onboarding readiness counts');
  assertTextIncludes(workspaceRoute.text, 'Invite member', 'workspace route should expose onboarding invitation action for admin sessions');

  const adminRoute = await navigate(client, `${baseUrl}#admin`, 'Manage users, email flows, and payments locally.');
  assert.equal(adminRoute.snapshot.hash, '#admin');
  assert.equal(adminRoute.snapshot.errorOverlay, false);
  assertTextIncludes(adminRoute.text, 'Readiness checks', 'admin overview should render readiness checks');
  assertTextIncludes(adminRoute.text, 'Admin console', 'admin route should render the admin console heading');

  const adminOverviewRoute = await navigate(client, `${baseUrl}#admin/overview`, 'Readiness checks');
  assert.equal(adminOverviewRoute.snapshot.hash, '#admin/overview');
  assertTextIncludes(adminOverviewRoute.text, 'Admin console', 'admin overview deep link should render overview tab content');

  const adminOpsRoute = await navigate(client, `${baseUrl}#admin/ops`, 'Webhook and rate-limit health');
  assert.equal(adminOpsRoute.snapshot.hash, '#admin/ops');
  assertTextIncludes(adminOpsRoute.text, 'API session registry', 'admin operations deep link should render operations tab content');

  const adminPaymentsRoute = await navigate(client, `${baseUrl}#admin/payments`, 'Billing overrides');
  assert.equal(adminPaymentsRoute.snapshot.hash, '#admin/payments');
  assertTextIncludes(adminPaymentsRoute.text, 'Payment lifecycle audit', 'admin payments deep link should render payments tab content');

  await evaluate(client, 'history.back()');
  const backText = await waitForText(client, 'Webhook and rate-limit health');
  const backHash = await evaluate(client, 'window.location.hash');
  assert.equal(backHash, '#admin/ops');
  assertTextIncludes(backText, 'API session registry', 'admin back button should restore operations tab');

  const unknownAdminRoute = await navigate(client, `${baseUrl}#admin/not-a-tab`, 'Readiness checks');
  assert.equal(unknownAdminRoute.snapshot.hash, '#admin/not-a-tab');
  assertTextIncludes(unknownAdminRoute.text, 'Admin console', 'unknown admin tab should fall back to overview content');

  await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.innerText.includes('Users'));
    if (!button) {
      throw new Error('Users tab button missing');
    }
    button.click();
  })()`);
  const adminUsersText = await waitForText(client, 'Tenant workspace');
  assertTextIncludes(adminUsersText, 'Suspend tenant', 'admin users section should expose tenant suspension controls');
  assertTextIncludes(adminUsersText, 'Create workspace', 'admin users section should expose workspace registration controls');
  assertTextIncludes(adminUsersText, 'Membership privacy boundary', 'admin users section should expose tenant membership RBAC evidence');
  assertTextIncludes(adminUsersText, 'Onboarding, RBAC, and privacy readiness', 'admin users section should expose onboarding readiness report');
  assertTextIncludes(adminUsersText, 'Data access', 'admin users section should expose role data access matrix');
  assertTextIncludes(adminUsersText, 'tenant membership the RBAC and privacy control plane', 'admin users section should state the multi-member org decision');
  assertTextIncludes(adminUsersText, 'onboarding-readiness --json', 'admin users section should expose onboarding readiness CLI command');
  assertTextIncludes(adminUsersText, 'tenants status', 'admin users section should expose local tenant CLI commands');
  await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.innerText.includes('Email flows'));
    if (!button) {
      throw new Error('Email flows tab button missing');
    }
    button.click();
  })()`);
  const adminEmailText = await waitForText(client, 'Detector and routing rules');
  assertTextIncludes(adminEmailText, 'Email launch handoff', 'admin email section should expose email launch handoff');
  assertTextIncludes(adminEmailText, 'email-handoff --json', 'admin email section should expose email handoff CLI command');
  assertTextIncludes(adminEmailText, 'email-handoff --env-file', 'admin email section should expose email handoff env-file command');
  assertTextIncludes(adminEmailText, '/api/email-handoff', 'admin email section should expose email handoff API command');
  assertTextIncludes(adminEmailText, 'Next email step', 'admin email section should explain the next email launch step');
  assertTextIncludes(adminEmailText, 'notifications webhook-signed', 'admin email section should expose signed email delivery webhook replay');
  assertTextIncludes(adminEmailText, 'Founder', 'admin email section should expose founder routing controls');
  assertTextIncludes(adminEmailText, 'Model governance', 'admin email section should expose model governance controls');
  assertTextIncludes(adminEmailText, 'Digestion pipeline audit', 'admin email section should expose digestion pipeline audit');
  assertTextIncludes(adminEmailText, 'digestion-pipeline --json', 'admin email section should expose digestion pipeline CLI command');
  assertTextIncludes(adminEmailText, '/api/digestion-pipeline', 'admin email section should expose digestion pipeline API command');
  assertTextIncludes(adminEmailText, 'No per-org trained model', 'admin email section should expose per-org model default in pipeline audit');
  assertTextIncludes(adminEmailText, 'Shared detector/model boundary', 'admin email section should state shared detector boundary');
  assertTextIncludes(adminEmailText, 'No separately trained per-org model', 'admin email section should state per-org model default');
  assertTextIncludes(adminEmailText, 'models --json', 'admin email section should expose model governance CLI command');
  assertTextIncludes(adminEmailText, 'models policy', 'admin email section should expose model governance policy command');
  assertTextIncludes(adminEmailText, 'email-flows route', 'admin email section should expose routing-rule CLI commands');
  assertTextIncludes(adminEmailText, 'signals handoff', 'admin email section should expose signal handoff CLI commands');
  await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.innerText.includes('Operations'));
    if (!button) {
      throw new Error('Operations tab button missing');
    }
    button.click();
  })()`);
  const adminOpsText = await waitForText(client, 'API session registry');
  assertTextIncludes(adminOpsText, 'Local agent handoff', 'admin operations should expose local-agent handoff');
  assertTextIncludes(adminOpsText, 'agent-handoff --json', 'admin operations should expose agent-handoff CLI command');
  assertTextIncludes(adminOpsText, 'agent-handoff --env-file', 'admin operations should expose agent-handoff env-file preflight command');
  assertTextIncludes(adminOpsText, '/api/agent-handoff', 'admin operations should expose agent-handoff API command');
  assertTextIncludes(adminOpsText, 'Next action', 'admin operations should explain the next local-agent action');
  assertTextIncludes(adminOpsText, 'Production backend, durable state, auth, CORS, and storage', 'admin operations should rank the production backend as the next launch action');
  assertTextIncludes(adminOpsText, 'Completion audit', 'admin operations should expose completion audit');
  assertTextIncludes(adminOpsText, 'completion-audit --json', 'admin operations should expose completion audit CLI command');
  assertTextIncludes(adminOpsText, 'completion-audit --env-file', 'admin operations should expose completion audit env-file command');
  assertTextIncludes(adminOpsText, '/api/completion-audit', 'admin operations should expose completion audit API command');
  assertTextIncludes(adminOpsText, 'The local SaaS slice covers public entry', 'admin operations should summarize local completion scope');
  assertTextIncludes(adminOpsText, 'Do not treat local completion as production launch readiness', 'admin operations should keep production launch proof separate');
  assertTextIncludes(adminOpsText, 'Product readiness audit', 'admin operations should expose product readiness audit');
  assertTextIncludes(adminOpsText, 'readiness --json', 'admin operations should expose readiness CLI command');
  assertTextIncludes(adminOpsText, '/api/readiness', 'admin operations should expose readiness API command');
  assertTextIncludes(adminOpsText, 'Production still needs live provider evidence', 'admin operations should call out production readiness gaps');
  assertTextIncludes(adminOpsText, 'Stakeholder QA answers', 'admin operations should expose stakeholder QA answers');
  assertTextIncludes(adminOpsText, 'qa-answers --json', 'admin operations should expose QA answers CLI command');
  assertTextIncludes(adminOpsText, '/api/qa-answers', 'admin operations should expose QA answers API command');
  assertTextIncludes(adminOpsText, 'Do dashboard display calculations match the DB/backend connection?', 'admin operations should answer dashboard and backend QA');
  assertTextIncludes(adminOpsText, 'Do we need a data digestion model', 'admin operations should answer model governance QA');
  assertTextIncludes(adminOpsText, 'How do we handle failed payment', 'admin operations should answer payment lifecycle QA');
  assertTextIncludes(adminOpsText, 'Onboarding and RBAC readiness', 'admin operations should expose onboarding readiness audit');
  assertTextIncludes(adminOpsText, '/api/onboarding-readiness', 'admin operations should expose onboarding readiness API command');
  assertTextIncludes(adminOpsText, 'Tenant isolation remains a production backend blocker', 'admin operations should call out tenant-isolation guardrail');
  assertTextIncludes(adminOpsText, 'Tenant isolation audit', 'admin operations should expose tenant isolation audit');
  assertTextIncludes(adminOpsText, 'tenant-isolation --json', 'admin operations should expose tenant isolation CLI command');
  assertTextIncludes(adminOpsText, '/api/tenant-isolation', 'admin operations should expose tenant isolation API command');
  assertTextIncludes(adminOpsText, 'Production tenant isolation still needs', 'admin operations should show production tenant-isolation caveat');
  assertTextIncludes(adminOpsText, 'Actor-scoped visibility', 'admin operations should explain actor-scoped visibility');
  assertTextIncludes(adminOpsText, 'Dashboard calculation audit', 'admin operations should expose dashboard calculation audit');
  assertTextIncludes(adminOpsText, 'dashboard-audit --json', 'admin operations should expose dashboard audit CLI command');
  assertTextIncludes(adminOpsText, '/api/dashboard-audit', 'admin operations should expose dashboard audit API command');
  assertTextIncludes(adminOpsText, 'actor-scoped', 'admin operations should explain actor-scoped dashboard rows');
  assertTextIncludes(adminOpsText, 'Webhook and rate-limit health', 'admin operations should expose operations health audit');
  assertTextIncludes(adminOpsText, 'operations-health --json', 'admin operations should expose operations health CLI command');
  assertTextIncludes(adminOpsText, '/api/operations-health', 'admin operations should expose operations health API command');
  assertTextIncludes(adminOpsText, 'No active provider backoff', 'admin operations should show provider backoff state');
  assertTextIncludes(adminOpsText, 'billing_webhook', 'admin operations should expose billing webhook worker queue');
  assertTextIncludes(adminOpsText, 'outbound_email', 'admin operations should expose outbound email worker queue');
  assertTextIncludes(adminOpsText, 'managed scheduler/observability', 'admin operations should call out production monitoring guardrail');
  assertTextIncludes(adminOpsText, 'Production launch gate', 'admin operations should expose production launch gate');
  assertTextIncludes(adminOpsText, 'launch-gate --json', 'admin operations should expose launch-gate CLI command');
  assertTextIncludes(adminOpsText, 'launch-gate --env-file', 'admin operations should expose env-file launch preflight');
  assertTextIncludes(adminOpsText, 'launch-gate package', 'admin operations should expose launch evidence package command');
  assertTextIncludes(adminOpsText, 'verify-package', 'admin operations should expose launch package verification command');
  assertTextIncludes(adminOpsText, '/api/launch-gate', 'admin operations should expose launch-gate API command');
  assertTextIncludes(adminOpsText, 'Go-live is blocked', 'admin operations should call out go-live blockers');
  assertTextIncludes(adminOpsText, 'Production env audit', 'admin operations should expose production env audit');
  assertTextIncludes(adminOpsText, 'production-env --json', 'admin operations should expose production env CLI command');
  assertTextIncludes(adminOpsText, '/api/production-env', 'admin operations should expose production env API command');
  assertTextIncludes(adminOpsText, '.env.production.example covers every required production setup name', 'admin operations should expose env template coverage');
  assertTextIncludes(adminOpsText, 'required production env value', 'admin operations should expose missing production env value count');
  assertTextIncludes(adminOpsText, 'Production setup plan', 'admin operations should expose production setup plan');
  assertTextIncludes(adminOpsText, 'production-plan --json', 'admin operations should expose production plan CLI command');
  assertTextIncludes(adminOpsText, '/api/production-plan', 'admin operations should expose production plan API command');
  assertTextIncludes(adminOpsText, 'Durable backend, state service, backup, restore, and migration', 'admin operations should expose durable backend setup phase');
  assertTextIncludes(adminOpsText, 'Next phase', 'admin operations should expose the next production setup phase');
  assertTextIncludes(adminOpsText, 'Production operations drill', 'admin operations should expose production operations drill');
  assertTextIncludes(adminOpsText, 'production-drill --json', 'admin operations should expose production drill CLI command');
  assertTextIncludes(adminOpsText, '/api/production-drill', 'admin operations should expose production drill API command');
  assertTextIncludes(adminOpsText, 'Backup policy', 'admin operations should expose backup policy drill');
  assertTextIncludes(adminOpsText, 'restore ./signal-prod-backup.json --dry-run', 'admin operations should expose restore rehearsal command');
  assertTextIncludes(adminOpsText, 'SIGNAL_OPERATIONS_RUNBOOK_URL', 'admin operations should expose operations runbook proof requirement');
  assertTextIncludes(adminOpsText, 'Backend boundary', 'admin operations should expose backend boundary readiness');
  assertTextIncludes(adminOpsText, 'backend --json', 'admin operations should expose backend readiness CLI commands');
  assertTextIncludes(adminOpsText, 'Production backend handoff', 'admin operations should expose backend handoff');
  assertTextIncludes(adminOpsText, 'backend-handoff --json', 'admin operations should expose backend handoff CLI command');
  assertTextIncludes(adminOpsText, 'backend-handoff --env-file', 'admin operations should expose backend handoff env-file preflight');
  assertTextIncludes(adminOpsText, '/api/backend-handoff', 'admin operations should expose backend handoff API command');
  assertTextIncludes(adminOpsText, 'Next backend action', 'admin operations should explain the next backend action');
  assertTextIncludes(adminOpsText, 'Backend cutover drill', 'admin operations should expose backend cutover drill');
  assertTextIncludes(adminOpsText, 'backend-cutover --json', 'admin operations should expose backend cutover CLI command');
  assertTextIncludes(adminOpsText, 'backend-cutover --env-file', 'admin operations should expose backend cutover env-file preflight');
  assertTextIncludes(adminOpsText, '/api/backend-cutover', 'admin operations should expose backend cutover API command');
  assertTextIncludes(adminOpsText, 'Next cutover step', 'admin operations should explain the next backend cutover step');
  assertTextIncludes(adminOpsText, 'SIGNAL_BACKEND_MODE=external-service', 'admin operations should name the backend mode launch command');
  assertTextIncludes(adminOpsText, 'state-service:admin -- backup', 'admin operations should expose state-service backup CLI commands');
  assertTextIncludes(adminOpsText, 'state-service:admin -- restore', 'admin operations should expose state-service restore CLI commands');
  assertTextIncludes(adminOpsText, 'Scheduler operations handoff', 'admin operations should expose scheduler operations handoff');
  assertTextIncludes(adminOpsText, 'scheduler-handoff --json', 'admin operations should expose scheduler handoff CLI command');
  assertTextIncludes(adminOpsText, 'scheduler-handoff --env-file', 'admin operations should expose scheduler handoff env-file preflight');
  assertTextIncludes(adminOpsText, '/api/scheduler-handoff', 'admin operations should expose scheduler handoff API command');
  assertTextIncludes(adminOpsText, 'Next scheduler step', 'admin operations should explain the next scheduler handoff step');
  assertTextIncludes(adminOpsText, 'SIGNAL_JOB_SCHEDULER=signal-scheduler', 'admin operations should name the scheduler daemon launch command');
  assertTextIncludes(adminOpsText, 'No registered API sessions', 'admin operations should expose API session registry state');
  assertTextIncludes(adminOpsText, 'Run handoffs', 'admin operations should expose signal handoff job execution');
  assertTextIncludes(adminOpsText, 'Run validation scheduler', 'admin operations should expose provider validation scheduler execution');
  assertTextIncludes(adminOpsText, 'provider_validation', 'admin operations should expose provider validation worker queue');
  assertTextIncludes(adminOpsText, 'npm run scheduler', 'admin operations should expose scheduler daemon commands');
  assertTextIncludes(adminOpsText, 'jobs run signal_handoff', 'admin operations should expose handoff worker CLI commands');
  await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.innerText.includes('Integrations'));
    if (!button) {
      throw new Error('Integrations tab button missing');
    }
    button.click();
  })()`);
  const adminIntegrationsText = await waitForText(client, 'Provider sandbox validation');
  assertTextIncludes(adminIntegrationsText, 'Provider launch matrix', 'admin integrations should expose provider launch matrix');
  assertTextIncludes(adminIntegrationsText, 'provider-launch --json', 'admin integrations should expose provider launch CLI command');
  assertTextIncludes(adminIntegrationsText, '/api/provider-launch', 'admin integrations should expose provider launch API command');
  assertTextIncludes(adminIntegrationsText, 'Provider handoff', 'admin integrations should expose provider handoff action ranking');
  assertTextIncludes(adminIntegrationsText, 'provider-handoff --json', 'admin integrations should expose provider handoff CLI command');
  assertTextIncludes(adminIntegrationsText, 'provider-handoff --env-file', 'admin integrations should expose provider handoff production env preflight command');
  assertTextIncludes(adminIntegrationsText, '/api/provider-handoff', 'admin integrations should expose provider handoff API command');
  assertTextIncludes(adminIntegrationsText, 'Next provider action', 'admin integrations should expose the next provider handoff action');
  assertTextIncludes(adminIntegrationsText, 'SendGrid / Outbound Email Provider', 'admin integrations should map outbound email launch to SendGrid proof');
  assertTextIncludes(adminIntegrationsText, 'payments webhook-signed', 'admin integrations should expose Stripe signed webhook replay command');
  assertTextIncludes(adminIntegrationsText, 'Provider validation schedule', 'admin integrations should expose scheduled provider validation');
  assertTextIncludes(adminIntegrationsText, 'Run due', 'admin integrations should expose due provider validation execution');
  assertTextIncludes(adminIntegrationsText, 'Run all now', 'admin integrations should expose forced provider validation execution');
  assertTextIncludes(adminIntegrationsText, 'integrations run-scheduled', 'admin integrations should expose scheduled validation CLI commands');
  assertTextIncludes(adminIntegrationsText, 'integrations schedule', 'admin integrations should expose provider validation schedule CLI commands');
  assertTextIncludes(adminIntegrationsText, 'integrations evidence-export', 'admin integrations should expose provider evidence export CLI commands');
  assertTextIncludes(adminIntegrationsText, 'integrations evidence-import', 'admin integrations should expose provider evidence import CLI commands');
  assertTextIncludes(adminIntegrationsText, '--save-evidence', 'admin integrations should expose sandbox evidence save CLI commands');
  assertTextIncludes(adminIntegrationsText, 'Validate sandbox', 'admin integrations should expose on-demand provider sandbox validation');
  assertTextIncludes(adminIntegrationsText, 'SIGNAL_GMAIL_ACCESS_TOKEN', 'admin integrations should name missing sandbox inputs without values');
  assertTextIncludes(adminIntegrationsText, 'No recorded runs', 'admin integrations should expose provider sandbox validation evidence state');
  await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.innerText.includes('Payments'));
    if (!button) {
      throw new Error('Payments tab button missing');
    }
    button.click();
  })()`);
  const adminPaymentsText = await waitForText(client, 'Billing overrides');
  assertTextIncludes(adminPaymentsText, 'Support credit', 'admin payments should expose support credit override controls');
  assertTextIncludes(adminPaymentsText, 'Lifecycle notices', 'admin payments should expose lifecycle notice monitoring');
  assertTextIncludes(adminPaymentsText, 'Payment lifecycle audit', 'admin payments should expose payment lifecycle audit');
  assertTextIncludes(adminPaymentsText, 'payment-lifecycle --json', 'admin payments should expose payment lifecycle CLI command');
  assertTextIncludes(adminPaymentsText, '/api/payment-lifecycle', 'admin payments should expose payment lifecycle API command');
  assertTextIncludes(adminPaymentsText, 'Subscription start, Checkout/Portal, failed payment recovery', 'admin payments should summarize payment lifecycle audit coverage');
  assertTextIncludes(adminPaymentsText, 'Signed Webhook Replay', 'admin payments should expose signed webhook replay audit row');
  assertTextIncludes(adminPaymentsText, 'Payment launch handoff', 'admin payments should expose payment launch handoff');
  assertTextIncludes(adminPaymentsText, 'payment-handoff --json', 'admin payments should expose payment handoff CLI command');
  assertTextIncludes(adminPaymentsText, 'payment-handoff --env-file', 'admin payments should expose payment handoff env-file preflight command');
  assertTextIncludes(adminPaymentsText, '/api/payment-handoff', 'admin payments should expose payment handoff API command');
  assertTextIncludes(adminPaymentsText, 'Next payment step', 'admin payments should explain the next payment launch step');
  assertTextIncludes(adminPaymentsText, 'payments webhook-signed', 'admin payments should expose signed Stripe webhook launch command');
  assertTextIncludes(adminPaymentsText, 'Lifecycle playbook', 'admin payments should expose lifecycle playbook monitoring');
  assertTextIncludes(adminPaymentsText, 'lifecycle-playbook --json', 'admin payments should expose lifecycle playbook CLI command');
  assertTextIncludes(adminPaymentsText, '/api/lifecycle-playbook', 'admin payments should expose lifecycle playbook API command');
  assertTextIncludes(adminPaymentsText, 'Failed payment, dunning, and recovery session handling', 'admin payments should explain failed payment recovery handling');
  assertTextIncludes(adminPaymentsText, 'Multi-member org, RBAC, and member data privacy', 'admin payments should explain multi-member privacy handling');
  assertTextIncludes(adminPaymentsText, 'payments recover', 'admin payments should expose payment recovery command');
  assertTextIncludes(adminPaymentsText, 'payments override', 'admin payments should expose billing override CLI commands');

  const runtimeProblems = client.events
    .filter((event) =>
      event.method === 'Runtime.exceptionThrown' ||
      (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error'))
    .map((event) => event.params?.exceptionDetails?.text ?? event.params?.entry?.text ?? event.method);
  assert.deepEqual(runtimeProblems, []);
});
