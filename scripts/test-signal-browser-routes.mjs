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

async function waitForHttp(url, output, label, { attempts = 80, initialDelayMs = 100, maxDelayMs = 500 } = {}) {
  let delayMs = initialDelayMs;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the local service binds.
    }
    await sleep(delayMs);
    delayMs = Math.min(maxDelayMs, Math.round(delayMs * 1.25));
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

async function addContextTenantFixture(statePath) {
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.tenants.push({
    id: 'tenant_context',
    name: 'Beta Context Lab',
    domain: 'beta.example',
    status: 'active',
    planId: 'plan_beta',
    ownerUserId: 'usr_context_admin',
    billingOwnerUserId: 'usr_context_admin',
    registrationStatus: 'active',
    createdAt: '2026-06-13T00:00:00.000Z',
    createdByUserId: 'usr_admin',
  });
  state.users.push({
    id: 'usr_context_admin',
    tenantId: 'tenant_context',
    name: 'Blake Rivers',
    email: 'blake@beta.example',
    role: 'admin',
    status: 'active',
  });
  state.memberships.push({
    id: 'mem_tenant_context_usr_context_admin',
    tenantId: 'tenant_context',
    userId: 'usr_context_admin',
    role: 'admin',
    team: 'ops',
    status: 'active',
    createdAt: '2026-06-13T00:00:00.000Z',
    createdByUserId: 'usr_admin',
  });
  state.entitlements.push({
    id: 'ent_tenant_context',
    tenantId: 'tenant_context',
    subscriptionId: 'sub_tenant_context',
    source: 'manual_entitlement',
    status: 'active',
    seatLimit: 3,
    mailboxLimit: 2,
    signalLimit: 250,
    retentionDays: 21,
    adminControls: true,
    updatedAt: '2026-06-13T00:00:00.000Z',
  });
  state.governancePolicies.push({
    id: 'gov_tenant_context',
    tenantId: 'tenant_context',
    sourceRetentionDays: 21,
    rawSnippetRetentionDays: 5,
    exportWindowDays: 14,
    deletionReview: 'manual',
    redactionMode: 'strict',
    updatedAt: '2026-06-13T00:00:00.000Z',
    updatedByUserId: 'usr_admin',
  });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
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

function buildChromeArgs({ cdpPort, profileDir }) {
  const args = [
    '--headless=new',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-crash-reporter',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-features=DBus',
    '--disable-gpu',
    '--disable-renderer-backgrounding',
    '--disable-software-rasterizer',
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
  return args;
}

async function startChrome({ cdpPort, executable, profileDir }) {
  let lastError = null;
  let lastOutput = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const attemptProfileDir = attempt === 0 ? profileDir : path.join(profileDir, `retry-${attempt}`);
    await fs.mkdir(attemptProfileDir, { recursive: true });
    const child = spawn(executable, buildChromeArgs({ cdpPort, profileDir: attemptProfileDir }), {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = processOutputCollector(child);
    try {
      await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, output, 'Headless Chrome CDP', { attempts: 250 });
      return { child, output };
    } catch (error) {
      lastError = error;
      lastOutput = output();
      await stopProcess(child);
      if (attempt < 2) {
        await sleep(250 * (attempt + 1));
      }
    }
  }
  const detail = lastOutput ? `\n${lastOutput}` : '';
  throw new Error(`${lastError?.message ?? 'Headless Chrome CDP did not become ready.'}${detail}`);
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

async function assertMobileNav(client, { activationHash, activationLabel, expectedLinks, label, panelSelector, rootSelector }) {
  const nav = await evaluate(client, `(async () => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    if (!root) {
      throw new Error(${JSON.stringify(`${label} root missing`)});
    }
    const button = root.querySelector('.mobile-nav-toggle');
    const panel = document.querySelector(${JSON.stringify(panelSelector)});
    if (!button) {
      throw new Error(${JSON.stringify(`${label} mobile navigation toggle missing`)});
    }
    if (!panel) {
      throw new Error(${JSON.stringify(`${label} mobile navigation panel missing`)});
    }
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const initial = {
      ariaExpanded: button.getAttribute('aria-expanded'),
      hidden: panel.hidden,
    };
    button.click();
    await frame();
    const open = {
      ariaExpanded: button.getAttribute('aria-expanded'),
      buttonDisplay: getComputedStyle(button).display,
      hidden: panel.hidden,
      panelDisplay: getComputedStyle(panel).display,
      text: panel.innerText,
    };
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await frame();
    return {
      closedExpanded: button.getAttribute('aria-expanded'),
      closedHidden: panel.hidden,
      focusReturned: document.activeElement === button,
      initial,
      open,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      viewportWidth: document.documentElement.clientWidth,
    };
  })()`);
  assert.equal(nav.initial.ariaExpanded, 'false', `${label} mobile navigation should start collapsed`);
  assert.equal(nav.initial.hidden, true, `${label} mobile navigation panel should start hidden`);
  assert.notEqual(nav.open.buttonDisplay, 'none', `${label} mobile navigation toggle should be visible at narrow widths`);
  assert.equal(nav.open.panelDisplay, 'grid', `${label} mobile navigation panel should use the shared grid panel layout`);
  assert.equal(nav.open.ariaExpanded, 'true', `${label} mobile navigation should report expanded after toggle`);
  assert.equal(nav.open.hidden, false, `${label} mobile navigation panel should open from hamburger`);
  for (const expectedLink of expectedLinks) {
    assertTextIncludes(nav.open.text, expectedLink, `${label} mobile navigation should include ${expectedLink}`);
  }
  assert.equal(nav.closedExpanded, 'false', `${label} Escape should collapse the mobile navigation`);
  assert.equal(nav.closedHidden, true, `${label} Escape should hide the mobile navigation panel`);
  assert.equal(nav.focusReturned, true, `${label} Escape should return focus to the mobile navigation toggle`);
  assert.ok(nav.scrollWidth <= nav.viewportWidth, `${label} should not horizontally overflow at 390px (${nav.scrollWidth}px > ${nav.viewportWidth}px)`);

  if (!activationLabel || !activationHash) {
    return;
  }

  const activation = await evaluate(client, `(async () => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    const button = root?.querySelector('.mobile-nav-toggle');
    const panel = document.querySelector(${JSON.stringify(panelSelector)});
    if (!button || !panel) {
      throw new Error(${JSON.stringify(`${label} mobile navigation unavailable before activation`)});
    }
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    button.click();
    await frame();
    const link = [...panel.querySelectorAll('a')].find((candidate) => candidate.textContent.trim() === ${JSON.stringify(activationLabel)});
    if (!link) {
      throw new Error(${JSON.stringify(`${label} activation link missing`)});
    }
    link.click();
    await frame();
    return {
      hash: window.location.hash,
      text: document.body.innerText,
    };
  })()`);
  assert.equal(activation.hash, activationHash, `${label} ${activationLabel} mobile navigation link should update the hash`);
  assert.ok(activation.text.length > 0, `${label} mobile navigation activation should leave rendered app content`);
}

test('Signal browser routes render public, registration, workspace, and admin app areas', async (t) => {
  const chromeExecutable = await resolveChromeExecutable();
  if (!chromeExecutable) {
    if (process.env.CI || process.env.SIGNAL_CHROME_BIN) {
      assert.fail('Chrome-compatible browser is required when CI or SIGNAL_CHROME_BIN is set.');
    }
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
  await addContextTenantFixture(statePath);
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
  await assertMobileNav(client, {
    expectedLinks: ['Signals', 'Workflow', 'Security', 'Register', 'Workspace', 'Admin'],
    label: 'public route',
    panelSelector: '#mobile-nav-menu',
    rootSelector: '.site-nav',
  });

  const productMobileRoutes = [
    {
      activationHash: '#workspace',
      activationLabel: 'Workspace',
      expectedText: 'Create the workspace before the dashboard.',
      hash: '#register',
      label: 'registration route',
    },
    {
      activationHash: '#admin',
      activationLabel: 'Admin',
      expectedText: 'Revenue signals for Acme Revenue Lab.',
      hash: '#workspace',
      label: 'workspace route',
    },
    {
      activationHash: '#register',
      activationLabel: 'Register',
      expectedText: 'Manage users, email flows, and payments locally.',
      hash: '#admin',
      label: 'admin route',
    },
  ];
  for (const route of productMobileRoutes) {
    await navigate(client, `${baseUrl}${route.hash}`, route.expectedText);
    await assertMobileNav(client, {
      activationHash: route.activationHash,
      activationLabel: route.activationLabel,
      expectedLinks: ['Register', 'Workspace', 'Admin', 'Public'],
      label: route.label,
      panelSelector: '#product-mobile-nav-menu',
      rootSelector: '.product-header',
    });
  }
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
  assertTextIncludes(workspaceRoute.text, 'Digestion pipeline', 'workspace route should render pipeline visualization');
  assertTextIncludes(workspaceRoute.text, 'Signals by type', 'workspace route should render signal type visualization');
  assertTextIncludes(workspaceRoute.text, 'Account health bands', 'workspace route should render account health visualization');
  assertTextIncludes(workspaceRoute.text, 'Command', 'workspace route should expose the command palette affordance');
  await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.innerText.includes('Command'));
    if (!button) {
      throw new Error('Command palette button missing');
    }
    button.click();
  })()`);
  const commandPaletteText = await waitForText(client, 'Dashboard audit');
  assertTextIncludes(commandPaletteText, 'Open admin dashboard', 'command palette should expose admin navigation');
  assertTextIncludes(commandPaletteText, 'Run provider validation job', 'command palette should expose local CLI commands');
  await evaluate(client, `(() => {
    const backdrop = document.querySelector('.command-palette-backdrop');
    if (!backdrop) {
      throw new Error('Command palette backdrop missing');
    }
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  })()`);

  const adminRoute = await navigate(client, `${baseUrl}#admin`, 'Manage users, email flows, and payments locally.');
  assert.equal(adminRoute.snapshot.hash, '#admin');
  assert.equal(adminRoute.snapshot.errorOverlay, false);
  assertTextIncludes(adminRoute.text, 'Readiness checks', 'admin dashboard should render readiness checks');
  assertTextIncludes(adminRoute.text, 'Launch gate go/no-go', 'admin dashboard should render launch gate go/no-go banner');
  assertTextIncludes(adminRoute.text, 'Dashboard calculation audit', 'admin dashboard should render dashboard audit summary');
  assertTextIncludes(adminRoute.text, 'Signal volume', 'admin dashboard should render signal volume visualization');
  assertTextIncludes(adminRoute.text, 'Account health bands', 'admin dashboard should render account health visualization');
  assertTextIncludes(adminRoute.text, 'Admin console', 'admin route should render the admin console heading');
  const adminContextDefault = await evaluate(client, `(() => {
    const selector = document.querySelector('#signal-admin-context-tenant-select');
    if (!selector) {
      throw new Error('Admin context tenant selector missing');
    }
    return {
      optionText: [...selector.options].map((option) => option.textContent).join(' | '),
      value: selector.value,
    };
  })()`);
  assert.equal(adminContextDefault.value, 'tenant_demo', 'admin context tenant should default to the acting admin tenant');
  assertTextIncludes(adminContextDefault.optionText, 'Beta Context Lab', 'admin context tenant selector should include all tenants');

  const adminOverviewRoute = await navigate(client, `${baseUrl}#admin/overview`, 'Dashboard calculation audit');
  assert.equal(adminOverviewRoute.snapshot.hash, '#admin/dashboard');
  assertTextIncludes(adminOverviewRoute.text, 'dashboard-audit --json', 'legacy admin overview deep link should render dashboard tab content');

  const adminOpsRoute = await navigate(client, `${baseUrl}#admin/ops`, 'Production launch gate');
  assert.equal(adminOpsRoute.snapshot.hash, '#admin/launch');
  assertTextIncludes(adminOpsRoute.text, 'Provider launch matrix', 'legacy admin operations deep link should render launch readiness content');

  const adminPaymentsRoute = await navigate(client, `${baseUrl}#admin/payments`, 'Billing overrides');
  assert.equal(adminPaymentsRoute.snapshot.hash, '#admin/billing');
  assertTextIncludes(adminPaymentsRoute.text, 'Payment lifecycle audit', 'legacy admin payments deep link should render billing tab content');

  await evaluate(client, 'history.back()');
  const backText = await waitForText(client, 'Production launch gate');
  const backHash = await evaluate(client, 'window.location.hash');
  assert.equal(backHash, '#admin/launch');
  assertTextIncludes(backText, 'Provider launch matrix', 'admin back button should restore launch readiness tab');

  const unknownAdminRoute = await navigate(client, `${baseUrl}#admin/not-a-tab`, 'Readiness checks');
  assert.equal(unknownAdminRoute.snapshot.hash, '#admin/dashboard');
  assertTextIncludes(unknownAdminRoute.text, 'Admin console', 'unknown admin tab should fall back to dashboard content');

  const adminUsersRoute = await navigate(client, `${baseUrl}#admin/users`, 'Tenant workspace');
  assert.equal(adminUsersRoute.snapshot.hash, '#admin/organization/users');
  assertTextIncludes(adminUsersRoute.text, 'Tenant operator view', 'legacy admin users deep link should render organization tab content');

  const adminSignalsRoute = await navigate(client, `${baseUrl}#admin/platform/signals`, 'Signals operator');
  assert.equal(adminSignalsRoute.snapshot.hash, '#admin/platform/signals');
  assertTextIncludes(adminSignalsRoute.text, 'Assign', 'admin signals operator should expose a signal assign affordance');
  assertTextIncludes(adminSignalsRoute.text, 'signals assign', 'admin signals operator should expose CLI parity for signal assignment');
  assertTextIncludes(adminSignalsRoute.text, 'signals feedback', 'admin signals operator should expose CLI parity for signal feedback');

  const adminAccountsRoute = await navigate(client, `${baseUrl}#admin/platform/accounts`, 'Accounts operator');
  assert.equal(adminAccountsRoute.snapshot.hash, '#admin/platform/accounts');
  assertTextIncludes(adminAccountsRoute.text, 'Add review note', 'admin accounts operator should expose account review affordance');
  assertTextIncludes(adminAccountsRoute.text, 'accounts review', 'admin accounts operator should expose CLI parity for account review');
  assertTextIncludes(adminAccountsRoute.text, 'Mark done', 'admin accounts operator should expose account action completion affordance');

  await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.innerText.includes('Organization'));
    if (!button) {
      throw new Error('Organization tab button missing');
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
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.innerText.includes('Platform'));
    if (!button) {
      throw new Error('Platform tab button missing');
    }
    button.click();
  })()`);
  const adminPlatformText = await waitForText(client, 'API session registry');
  assertTextIncludes(adminPlatformText, 'Retention and redaction', 'admin platform should retain governance policy panels');
  assertTextIncludes(adminPlatformText, 'Export, delete, and incidents', 'admin platform should retain data request and incident panels');
  assertTextIncludes(adminPlatformText, 'Production backend handoff', 'admin platform should expose backend handoff');
  assertTextIncludes(adminPlatformText, 'backend-handoff --json', 'admin platform should expose backend handoff CLI command');
  assertTextIncludes(adminPlatformText, '/api/backend-handoff', 'admin platform should expose backend handoff API command');
  assertTextIncludes(adminPlatformText, 'Scheduler operations handoff', 'admin platform should expose scheduler operations handoff');
  assertTextIncludes(adminPlatformText, 'scheduler-handoff --json', 'admin platform should expose scheduler handoff CLI command');
  assertTextIncludes(adminPlatformText, '/api/scheduler-handoff', 'admin platform should expose scheduler handoff API command');
  assertTextIncludes(adminPlatformText, 'Onboarding and RBAC readiness', 'admin platform should expose onboarding readiness audit');
  assertTextIncludes(adminPlatformText, '/api/onboarding-readiness', 'admin platform should expose onboarding readiness API command');
  assertTextIncludes(adminPlatformText, 'Tenant isolation audit', 'admin platform should expose tenant isolation audit');
  assertTextIncludes(adminPlatformText, 'tenant-isolation --json', 'admin platform should expose tenant isolation CLI command');
  assertTextIncludes(adminPlatformText, 'Webhook and rate-limit health', 'admin platform should expose operations health audit');
  assertTextIncludes(adminPlatformText, 'operations-health --json', 'admin platform should expose operations health CLI command');
  assertTextIncludes(adminPlatformText, 'No active provider backoff', 'admin platform should show provider backoff state');
  assertTextIncludes(adminPlatformText, 'billing_webhook', 'admin platform should expose billing webhook worker queue');
  assertTextIncludes(adminPlatformText, 'outbound_email', 'admin platform should expose outbound email worker queue');
  assertTextIncludes(adminPlatformText, 'Operational jobs', 'admin platform should expose worker queue controls');
  assertTextIncludes(adminPlatformText, 'Run handoffs', 'admin platform should expose signal handoff job execution');
  assertTextIncludes(adminPlatformText, 'Run validation scheduler', 'admin platform should expose provider validation scheduler execution');
  assertTextIncludes(adminPlatformText, 'Provider operations', 'admin platform should expose provider operations summary');
  assertTextIncludes(adminPlatformText, 'Backend boundary', 'admin platform should expose backend boundary readiness');
  assertTextIncludes(adminPlatformText, 'backend --json', 'admin platform should expose backend readiness CLI commands');
  assertTextIncludes(adminPlatformText, 'No registered API sessions', 'admin platform should expose API session registry state');
  assertTextIncludes(adminPlatformText, 'Digest operations', 'admin platform should expose outbound email digest operations');

  await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.innerText.includes('Launch readiness'));
    if (!button) {
      throw new Error('Launch readiness tab button missing');
    }
    button.click();
  })()`);
  const adminLaunchText = await waitForText(client, 'Production launch gate');
  assertTextIncludes(adminLaunchText, 'Local agent handoff', 'admin launch should expose local-agent handoff');
  assertTextIncludes(adminLaunchText, 'agent-handoff --json', 'admin launch should expose agent-handoff CLI command');
  assertTextIncludes(adminLaunchText, 'Next action', 'admin launch should explain the next local-agent action');
  assertTextIncludes(adminLaunchText, 'Provider launch matrix', 'admin launch should expose provider launch matrix');
  assertTextIncludes(adminLaunchText, 'provider-launch --json', 'admin launch should expose provider launch CLI command');
  assertTextIncludes(adminLaunchText, '/api/provider-launch', 'admin launch should expose provider launch API command');
  assertTextIncludes(adminLaunchText, 'Completion audit', 'admin launch should expose completion audit');
  assertTextIncludes(adminLaunchText, 'completion-audit --json', 'admin launch should expose completion audit CLI command');
  assertTextIncludes(adminLaunchText, '/api/completion-audit', 'admin launch should expose completion audit API command');
  assertTextIncludes(adminLaunchText, 'Product readiness audit', 'admin launch should expose product readiness audit');
  assertTextIncludes(adminLaunchText, 'readiness --json', 'admin launch should expose readiness CLI command');
  assertTextIncludes(adminLaunchText, '/api/readiness', 'admin launch should expose readiness API command');
  assertTextIncludes(adminLaunchText, 'Stakeholder QA answers', 'admin launch should expose stakeholder QA answers');
  assertTextIncludes(adminLaunchText, 'qa-answers --json', 'admin launch should expose QA answers CLI command');
  assertTextIncludes(adminLaunchText, '/api/qa-answers', 'admin launch should expose QA answers API command');
  assertTextIncludes(adminLaunchText, 'Backend cutover drill', 'admin launch should expose backend cutover drill');
  assertTextIncludes(adminLaunchText, 'backend-cutover --json', 'admin launch should expose backend cutover CLI command');
  assertTextIncludes(adminLaunchText, 'SIGNAL_BACKEND_MODE=external-service', 'admin launch should name the backend mode launch command');
  assertTextIncludes(adminLaunchText, 'launch-gate --json', 'admin launch should expose launch-gate CLI command');
  assertTextIncludes(adminLaunchText, 'launch-gate package', 'admin launch should expose launch evidence package command');
  assertTextIncludes(adminLaunchText, 'verify-package', 'admin launch should expose launch package verification command');
  assertTextIncludes(adminLaunchText, 'Production env audit', 'admin launch should expose production env audit');
  assertTextIncludes(adminLaunchText, 'production-env --json', 'admin launch should expose production env CLI command');
  assertTextIncludes(adminLaunchText, 'Production setup plan', 'admin launch should expose production setup plan');
  assertTextIncludes(adminLaunchText, 'production-plan --json', 'admin launch should expose production plan CLI command');
  assertTextIncludes(adminLaunchText, 'Production operations drill', 'admin launch should expose production operations drill');
  assertTextIncludes(adminLaunchText, 'production-drill --json', 'admin launch should expose production drill CLI command');
  assertTextIncludes(adminLaunchText, 'restore ./signal-prod-backup.json --dry-run', 'admin launch should expose restore rehearsal command');

  const adminAria = await evaluate(client, `(() => {
    const selectedTab = document.querySelector('[role="tab"][aria-selected="true"]');
    const controlledPanel = selectedTab ? document.getElementById(selectedTab.getAttribute('aria-controls')) : null;
    return {
      controlsPanel: Boolean(controlledPanel),
      panelLabelledBy: controlledPanel?.getAttribute('aria-labelledby') ?? '',
      selectedId: selectedTab?.id ?? '',
      selectedTabIndex: selectedTab?.getAttribute('tabindex') ?? '',
      tabCount: document.querySelectorAll('[role="tab"]').length,
      tabPanelCount: document.querySelectorAll('[role="tabpanel"]').length,
      vertical: document.querySelector('[role="tablist"]')?.getAttribute('aria-orientation') ?? '',
    };
  })()`);
  assert.equal(adminAria.selectedTabIndex, '0');
  assert.equal(adminAria.controlsPanel, true);
  assert.equal(adminAria.panelLabelledBy, adminAria.selectedId);
  assert.equal(adminAria.tabCount, 9);
  assert.equal(adminAria.tabPanelCount, 9);
  assert.equal(adminAria.vertical, 'vertical');
  await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.innerText.includes('Integrations'));
    if (!button) {
      throw new Error('Integrations tab button missing');
    }
    button.click();
  })()`);
  const adminIntegrationsText = await waitForText(client, 'Provider sandbox validation');
  assertTextIncludes(adminIntegrationsText, 'Provider readiness', 'admin integrations should expose provider readiness');
  assertTextIncludes(adminIntegrationsText, 'Live integration boundaries', 'admin integrations should expose live integration boundaries');
  assertTextIncludes(adminIntegrationsText, 'Provider handoff', 'admin integrations should expose provider handoff action ranking');
  assertTextIncludes(adminIntegrationsText, 'provider-handoff --json', 'admin integrations should expose provider handoff CLI command');
  assertTextIncludes(adminIntegrationsText, 'provider-handoff --env-file', 'admin integrations should expose provider handoff production env preflight command');
  assertTextIncludes(adminIntegrationsText, '/api/provider-handoff', 'admin integrations should expose provider handoff API command');
  assertTextIncludes(adminIntegrationsText, 'Next provider action', 'admin integrations should expose the next provider handoff action');
  assertTextIncludes(adminIntegrationsText, 'SendGrid / Outbound Email Provider', 'admin integrations should map outbound email launch to SendGrid proof');
  assertTextIncludes(adminIntegrationsText, 'Provider validation schedule', 'admin integrations should expose scheduled provider validation');
  assertTextIncludes(adminIntegrationsText, 'Run due', 'admin integrations should expose due provider validation execution');
  assertTextIncludes(adminIntegrationsText, 'Run all now', 'admin integrations should expose forced provider validation execution');
  assertTextIncludes(adminIntegrationsText, 'integrations run-scheduled', 'admin integrations should expose scheduled validation CLI commands');
  assertTextIncludes(adminIntegrationsText, 'integrations refresh-evidence', 'admin integrations should expose explicit evidence refresh CLI commands');
  assertTextIncludes(adminIntegrationsText, 'integrations schedule', 'admin integrations should expose provider validation schedule CLI commands');
  assertTextIncludes(adminIntegrationsText, 'integrations evidence-export', 'admin integrations should expose provider evidence export CLI commands');
  assertTextIncludes(adminIntegrationsText, 'integrations evidence-import', 'admin integrations should expose provider evidence import CLI commands');
  assertTextIncludes(adminIntegrationsText, '--save-evidence', 'admin integrations should expose sandbox evidence save CLI commands');
  assertTextIncludes(adminIntegrationsText, 'Validate sandbox', 'admin integrations should expose on-demand provider sandbox validation');
  assertTextIncludes(adminIntegrationsText, 'SIGNAL_GMAIL_ACCESS_TOKEN', 'admin integrations should name missing sandbox inputs without values');
  assertTextIncludes(adminIntegrationsText, 'No recorded runs', 'admin integrations should expose provider sandbox validation evidence state');
  await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.innerText.includes('Billing'));
    if (!button) {
      throw new Error('Billing tab button missing');
    }
    button.click();
  })()`);
  const adminBillingText = await waitForText(client, 'Billing overrides');
  assertTextIncludes(adminBillingText, 'Support credit', 'admin billing should expose support credit override controls');
  assertTextIncludes(adminBillingText, 'Lifecycle notices', 'admin billing should expose lifecycle notice monitoring');
  assertTextIncludes(adminBillingText, 'Payment lifecycle audit', 'admin billing should expose payment lifecycle audit');
  assertTextIncludes(adminBillingText, 'payment-lifecycle --json', 'admin billing should expose payment lifecycle CLI command');
  assertTextIncludes(adminBillingText, '/api/payment-lifecycle', 'admin billing should expose payment lifecycle API command');
  assertTextIncludes(adminBillingText, 'Subscription start, Checkout/Portal, failed payment recovery', 'admin billing should summarize payment lifecycle audit coverage');
  assertTextIncludes(adminBillingText, 'Signed Webhook Replay', 'admin billing should expose signed webhook replay audit row');
  assertTextIncludes(adminBillingText, 'Payment launch handoff', 'admin billing should expose payment launch handoff');
  assertTextIncludes(adminBillingText, 'payment-handoff --json', 'admin billing should expose payment handoff CLI command');
  assertTextIncludes(adminBillingText, 'payment-handoff --env-file', 'admin billing should expose payment handoff env-file preflight command');
  assertTextIncludes(adminBillingText, '/api/payment-handoff', 'admin billing should expose payment handoff API command');
  assertTextIncludes(adminBillingText, 'Next payment step', 'admin billing should explain the next payment launch step');
  assertTextIncludes(adminBillingText, 'payments webhook-signed', 'admin billing should expose signed Stripe webhook launch command');
  assertTextIncludes(adminBillingText, 'Lifecycle playbook', 'admin billing should expose lifecycle playbook monitoring');
  assertTextIncludes(adminBillingText, 'lifecycle-playbook --json', 'admin billing should expose lifecycle playbook CLI command');
  assertTextIncludes(adminBillingText, '/api/lifecycle-playbook', 'admin billing should expose lifecycle playbook API command');
  assertTextIncludes(adminBillingText, 'Failed payment, dunning, and recovery session handling', 'admin billing should explain failed payment recovery handling');
  assertTextIncludes(adminBillingText, 'Multi-member org, RBAC, and member data privacy', 'admin billing should explain multi-member privacy handling');
  assertTextIncludes(adminBillingText, 'payments recover', 'admin billing should expose payment recovery command');
  assertTextIncludes(adminBillingText, 'payments override', 'admin billing should expose billing override CLI commands');

  const switchedContext = await evaluate(client, `(async () => {
    const selector = document.querySelector('#signal-admin-context-tenant-select');
    if (!selector) {
      throw new Error('Admin context tenant selector missing before switch');
    }
    selector.value = 'tenant_context';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      hash: window.location.hash,
      storage: window.sessionStorage.getItem('signal.admin.contextTenantId'),
      text: document.body.innerText,
      value: selector.value,
    };
  })()`);
  assert.equal(switchedContext.value, 'tenant_context');
  assert.equal(switchedContext.storage, 'tenant_context', 'admin context tenant switch should persist in sessionStorage');
  assert.match(switchedContext.hash, /[?&]tenant=tenant_context/, 'admin context tenant switch should update the hash query');
  assertTextIncludes(switchedContext.text, 'beta.example', 'admin billing panel should update to the selected context tenant without switching actor');

  const contextEmailRoute = await navigate(client, `${baseUrl}#admin/email?tenant=tenant_context`, 'No mailbox sources for this tenant.');
  assert.equal(contextEmailRoute.snapshot.hash, '#admin/email?tenant=tenant_context');
  assertTextIncludes(contextEmailRoute.text, 'No mailbox sources for this tenant.', 'admin email panel should scope mailbox rows to the context tenant');

  const contextGovernanceRoute = await navigate(client, `${baseUrl}#admin/platform/governance?tenant=tenant_context`, '21 day source retention');
  assert.equal(contextGovernanceRoute.snapshot.hash, '#admin/platform/governance?tenant=tenant_context');
  assertTextIncludes(contextGovernanceRoute.text, '21 day source retention', 'admin governance panel should scope policy rows to the context tenant');

  const runtimeProblems = client.events
    .filter((event) =>
      event.method === 'Runtime.exceptionThrown' ||
      (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error'))
    .map((event) => event.params?.exceptionDetails?.text ?? event.params?.entry?.text ?? event.method);
  assert.deepEqual(runtimeProblems, []);
});
