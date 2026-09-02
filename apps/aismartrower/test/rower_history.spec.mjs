import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROWER_HISTORY_KEY,
  loadRowerHistory,
  normalizeRowerSummary,
  readRowerHistoryResult,
  saveRowerHistorySummary,
} from '../lib/rower_history.js';
import { buildRowerSummary } from '../lib/rower_summary.js';

function fakeStorage() {
  const values = new Map();
  return {
    values,
    getStorageSync(key) {
      return values.get(key);
    },
    setStorageSync(key, value) {
      values.set(key, value);
    },
  };
}

function summary(sessionId, overrides = {}) {
  return buildRowerSummary({
    sessionId,
    startedAtMs: 1000,
    finishedAtMs: 61_000,
    elapsedMs: 60_000,
    distanceM: 500,
    distanceEvidence: 'measured',
    strokeCount: 100,
    averageSplitSecPer500m: 150,
    averageStrokeRateSpm: 24,
    maxStrokeRateSpm: 28,
    averagePowerW: 120,
    maxPowerW: 180,
    ftmsCoveragePct: 80,
    distanceCoveragePct: 80,
    strokeCountCoveragePct: 80,
    strokeRateCoveragePct: 80,
    splitCoveragePct: 80,
    powerCoveragePct: 80,
    minuteSplitSeries: [{ minute: 1, value: 150 }],
    ...overrides,
  });
}

test('stores a canonical schema-v1 envelope newest-first without duplicates', () => {
  const storage = fakeStorage();
  assert.equal(saveRowerHistorySummary(storage, summary('row-a')), true);
  assert.equal(saveRowerHistorySummary(storage, summary('row-b')), true);
  assert.equal(saveRowerHistorySummary(storage, summary('row-a', {
    distanceM: 550,
  })), true);
  const history = loadRowerHistory(storage);
  assert.deepEqual(history.map((item) => item.sessionId), ['row-a', 'row-b']);
  assert.equal(history[0].distanceM, 550);
  assert.deepEqual(storage.values.get(ROWER_HISTORY_KEY), {
    schemaVersion: 1,
    summaries: history,
  });
  assert.deepEqual(readRowerHistoryResult(storage), {
    ok: true,
    format: 'v1',
    history,
  });
});

test('save allowlists aggregates and never persists raw packets or device identity', () => {
  const storage = fakeStorage();
  const unsafe = {
    ...summary('privacy'),
    rawPacket: [1, 2, 3],
    deviceId: 'secret-id',
    deviceName: 'private-rower',
    featureBits: { machine: 123 },
  };
  assert.equal(saveRowerHistorySummary(storage, unsafe), true);
  const serialized = JSON.stringify(storage.values.get(ROWER_HISTORY_KEY));
  assert.doesNotMatch(
    serialized,
    /rawPacket|deviceId|deviceName|featureBits|secret-id|private-rower/,
  );
});

test('persists aggregate heart-rate source without peripheral identity', () => {
  const storage = fakeStorage();
  const withHrs = summary('heart-source', {
    averageHeartRateBpm: 130,
    maxHeartRateBpm: 145,
    heartRateCoveragePct: 75,
    independentHrsCoveragePct: 50,
    ftmsHeartRateCoveragePct: 25,
    heartRateSource: 'mixed',
    sensorSources: ['ftms', 'independent_hrs'],
    deviceName: 'never-persist-this',
  });
  assert.equal(saveRowerHistorySummary(storage, withHrs), true);
  const stored = loadRowerHistory(storage)[0];
  assert.equal(stored.heartRateSource, 'mixed');
  assert.deepEqual(stored.sensorSources, ['ftms', 'independent_hrs']);
  assert.doesNotMatch(JSON.stringify(stored), /never-persist-this/);
});

test('rejects contradictory heart-rate source evidence', () => {
  const external = summary('contradictory-heart', {
    averageHeartRateBpm: 130,
    maxHeartRateBpm: 145,
    heartRateCoveragePct: 75,
    independentHrsCoveragePct: 75,
    heartRateSource: 'independent_hrs',
  });
  assert.equal(normalizeRowerSummary({
    ...external,
    sensorSources: ['ftms'],
  }), null);
  assert.equal(normalizeRowerSummary({
    ...external,
    independentHrsCoveragePct: 0,
  }), null);
});

test('a corrupt or noncanonical baseline is fail-closed and never overwritten', () => {
  const storage = fakeStorage();
  const corrupt = {
    schemaVersion: 1,
    summaries: [{ ...summary('bad-baseline'), deviceName: 'leaked' }],
  };
  storage.setStorageSync(ROWER_HISTORY_KEY, corrupt);
  assert.equal(readRowerHistoryResult(storage).ok, false);
  assert.equal(saveRowerHistorySummary(storage, summary('new-record')), false);
  assert.deepEqual(storage.values.get(ROWER_HISTORY_KEY), corrupt);
  assert.deepEqual(loadRowerHistory(storage), []);
});

test('save verifies the complete envelope after write', () => {
  let persisted;
  const storage = {
    getStorageSync() {
      return persisted;
    },
    setStorageSync(_key, value) {
      persisted = {
        schemaVersion: value.schemaVersion,
        summaries: value.summaries.map((item) => ({
          ...item,
          powerCoveragePct: 0,
        })),
      };
    },
  };
  assert.equal(saveRowerHistorySummary(storage, summary('mutated-readback')), false);

  const dropped = {
    getStorageSync() {
      return undefined;
    },
    setStorageSync() {},
  };
  assert.equal(saveRowerHistorySummary(dropped, summary('dropped-readback')), false);
});

test('normalizer rejects contradictory distance evidence and source', () => {
  const measured = summary('evidence');
  assert.equal(normalizeRowerSummary({
    ...measured,
    distanceEvidence: 'unavailable',
  }), null);
  assert.equal(normalizeRowerSummary({
    ...measured,
    distanceSource: 'unavailable',
  }), null);
  assert.equal(normalizeRowerSummary({
    ...measured,
    mode: 'rowing_indoor',
  }), null);
});

test('history is capped at twenty canonical rower summaries', () => {
  const storage = fakeStorage();
  for (let index = 0; index < 25; index += 1) {
    assert.equal(saveRowerHistorySummary(
      storage,
      summary(`row-${index}`, { finishedAtMs: 61_000 + index }),
    ), true);
  }
  const history = loadRowerHistory(storage);
  assert.equal(history.length, 20);
  assert.equal(history[0].sessionId, 'row-24');
  assert.equal(history.at(-1).sessionId, 'row-5');
});

test('read failures and unknown formats remain distinct from an empty history', () => {
  assert.deepEqual(readRowerHistoryResult(fakeStorage()), {
    ok: true,
    format: 'empty',
    history: [],
  });
  const throwing = {
    getStorageSync() {
      throw new Error('private provider detail');
    },
  };
  assert.deepEqual(readRowerHistoryResult(throwing), {
    ok: false,
    format: 'error',
    history: [],
    reason: 'history_read_failed',
  });
});
