#!/usr/bin/env node

import { spawn } from 'node:child_process';

const children = [
  {
    name: 'api',
    command: process.execPath,
    args: ['scripts/signal-api.mjs'],
  },
  {
    name: 'web',
    command: 'npm',
    args: ['run', 'dev', '--', '--port', process.env.SIGNAL_WEB_PORT ?? '5173'],
  },
];

const running = children.map(({ name, command, args }) => {
  const child = spawn(command, args, {
    env: {
      ...process.env,
      SIGNAL_ALLOW_LOCAL_ACTOR: process.env.SIGNAL_ALLOW_LOCAL_ACTOR ?? 'true',
      SIGNAL_OAUTH_STATE_KEY: process.env.SIGNAL_OAUTH_STATE_KEY ?? 'signal-local-oauth-state-key',
      VITE_SIGNAL_API_URL: process.env.VITE_SIGNAL_API_URL ?? 'http://127.0.0.1:8787',
    },
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`[${name}] exited with code ${code}`);
      shutdown();
    }
  });
  return child;
});

function shutdown() {
  for (const child of running) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
}

process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});
