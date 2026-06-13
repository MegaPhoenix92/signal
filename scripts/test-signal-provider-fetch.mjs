#!/usr/bin/env node

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  providerFetch,
  providerRequestMaxRetries,
  providerRequestTimeoutMs,
} from './signal-provider-fetch.mjs';

test('providerRequestTimeoutMs and providerRequestMaxRetries use defaults and env overrides', () => {
  assert.equal(providerRequestTimeoutMs({}), 30_000);
  assert.equal(providerRequestTimeoutMs({ SIGNAL_PROVIDER_REQUEST_TIMEOUT_MS: '4500' }), 4500);
  assert.equal(providerRequestMaxRetries({}), 2);
  assert.equal(providerRequestMaxRetries({ SIGNAL_PROVIDER_REQUEST_MAX_RETRIES: '1' }), 1);
});

test('providerFetch retries retryable HTTP statuses', async () => {
  const calls = [];
  const fetchImpl = async () => {
    calls.push(calls.length);
    return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } });
  };

  const response = await providerFetch('https://provider.example/retry', { method: 'POST' }, {
    env: { SIGNAL_PROVIDER_REQUEST_MAX_RETRIES: '2' },
    fetchImpl,
    timeoutMs: 1000,
  });
  assert.equal(response.status, 429);
  assert.equal(calls.length, 3);
});

test('providerFetch applies AbortSignal.timeout when caller does not pass a signal', async () => {
  let receivedSignal = null;
  const fetchImpl = async (_url, init) => {
    receivedSignal = init.signal;
    return new Response('{}', { status: 200 });
  };

  await providerFetch('https://provider.example/timeout', { method: 'GET' }, {
    fetchImpl,
    timeoutMs: 2500,
  });
  assert(receivedSignal, 'providerFetch should attach a timeout signal');
});