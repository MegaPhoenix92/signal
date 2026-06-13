#!/usr/bin/env node

import test from 'node:test';
import { verifySignalLocal } from './verify-signal-local-core.mjs';

test('Signal local verification harness', async () => {
  await verifySignalLocal();
});