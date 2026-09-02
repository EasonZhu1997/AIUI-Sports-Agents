import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fallbackRideSummary,
  formatRideStats,
  normalizeRideSummary,
  readLastRideSummary,
  writeLastRideSummary,
} from '../lib/ride_summary.js';

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getStorageSync(key) { return values.get(key); },
    setStorageSync(key, value) { values.set(key, value); },
  };
}

test('ride summary rejects a zero-duration phantom activity', () => {
  assert.equal(normalizeRideSummary({ elapsedMs: 0, distanceM: 1000 }), null);
});

test('ride summary derives average speed from moving time', () => {
  const summary = normalizeRideSummary({
    elapsedMs: 1800000,
    movingMs: 1200000,
    distanceM: 10000,
    avgCadenceRpm: 88,
    maxCadenceRpm: 104,
    avgPowerW: 210,
  });
  assert.equal(summary.avgSpeedKmh, 30);
  assert.equal(summary.maxCadenceRpm, 104);
  assert.match(formatRideStats(summary), /均速 30\.0 公里\/时/);
  assert.match(formatRideStats(summary), /平均踏频 88 RPM/);
  assert.match(fallbackRideSummary(summary), /功率输出稳定/);
});

test('ride summary remains useful for Garmin heart-rate-only mode', () => {
  const summary = normalizeRideSummary({
    elapsedMs: 600000,
    distanceM: 0,
    avgBpm: 148,
  });
  assert.equal(summary.avgSpeedKmh, null);
  assert.match(fallbackRideSummary(summary), /心率节奏平稳/);
});

test('ride summary text never rounds tiny values into bug-like zeros', () => {
  const summary = normalizeRideSummary({
    elapsedMs: 60000,
    distanceM: 0.4,
    avgSpeedKmh: 0.04,
    avgCadenceRpm: 0.4,
    avgPowerW: 0.4,
  });
  const stats = formatRideStats(summary);
  const fallback = fallbackRideSummary(summary);
  assert.match(stats, /距离很短/);
  assert.doesNotMatch(stats, /0\.00|0\.0|平均踏频 0|平均功率 0/);
  assert.doesNotMatch(fallback, /0\.00|0\.0|平均踏频 0|平均功率 0/);
});

test('IMU 估算来源在本地总结中保持明确标记', () => {
  const summary = normalizeRideSummary({
    elapsedMs: 600000,
    movingMs: 540000,
    distanceM: 4200,
    avgSpeedKmh: 28,
    avgCadenceRpm: 88,
    sources: ['gps', 'imu'],
  });
  assert.deepEqual(summary.sources, ['imu']);
  assert.match(fallbackRideSummary(summary), /眼镜IMU估算/);
});

test('ride summary 来源仅接受有限枚举并拒绝设备名与 ID', () => {
  const summary = normalizeRideSummary({
    elapsedMs: 600000,
    sources: [
      ' GPS ',
      'imu',
      'Garmin Edge 540',
      'AA:BB:CC:DD',
      'cadence_model',
      'GPS',
    ],
    distanceSources: ['csc', 'gps', 'device-123456', 'cadence_model'],
    cadenceSources: ['IMU', 'cps', 'RSC-Private-Name'],
  });
  assert.deepEqual(summary.sources, ['imu', 'cadence_model']);
  assert.deepEqual(
    summary.distanceSources,
    ['csc', 'cadence_model'],
  );
  assert.deepEqual(summary.cadenceSources, ['imu', 'cps']);
  const encoded = JSON.stringify(summary);
  for (const privateValue of [
    'Garmin Edge 540',
    'AA:BB:CC:DD',
    'device-123456',
    'RSC-Private-Name',
  ]) {
    assert.equal(encoded.includes(privateValue), false);
  }
});

test('ride summary stores only normalized aggregate data', () => {
  const storage = memoryStorage();
  const stored = writeLastRideSummary(storage, {
    elapsedMs: 60000,
    movingMs: 60000,
    distanceM: 500,
    track: [{ latitude: 1, longitude: 2 }],
  });
  assert.equal('track' in stored, false);
  assert.deepEqual(readLastRideSummary(storage), stored);
});

test('ride summary 只有写后读回完全一致才返回成功', () => {
  const value = {
    elapsedMs: 60000,
    movingMs: 50000,
    distanceM: 500,
    sources: ['gps', 'Garmin Private'],
  };
  assert.equal(writeLastRideSummary(null, value), null);
  assert.equal(writeLastRideSummary({ setStorageSync() {} }, value), null);

  const silent = {
    getStorageSync() { return undefined; },
    setStorageSync() {},
  };
  assert.equal(writeLastRideSummary(silent, value), null);

  const mismatched = {
    getStorageSync() {
      return { ...value, distanceM: 1 };
    },
    setStorageSync() {},
  };
  assert.equal(writeLastRideSummary(mismatched, value), null);

  const throwing = {
    getStorageSync() { throw new Error('read failed'); },
    setStorageSync() {},
  };
  assert.equal(writeLastRideSummary(throwing, value), null);
});
