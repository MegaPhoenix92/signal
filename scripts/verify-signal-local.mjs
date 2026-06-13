#!/usr/bin/env node

import { verifySignalLocal } from './verify-signal-local-core.mjs';

await verifySignalLocal();
console.log('Signal local verification passed');
