import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRowerSettings, saveRowerSettings, saveRowerSummary } from '../lib/local_storage.js';

test('settings and summaries require a storage round trip', () => {
  const map = new Map();
  const storage = { getStorageSync: (k) => map.get(k), setStorageSync: (k, v) => map.set(k, structuredClone(v)) };
  assert.equal(saveRowerSettings(storage, { voiceEnabled: false }), true);
  assert.equal(loadRowerSettings(storage).voiceEnabled, false);
  assert.equal(saveRowerSummary(storage, { durationSec: 60, distanceM: 200 }), true);
});
