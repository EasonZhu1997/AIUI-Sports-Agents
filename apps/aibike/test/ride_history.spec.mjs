import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendRideHistory,
  appendRideHistorySummary,
  buildRideTrendText,
  buildSevenDayRideTrend,
  formatRideTrendText,
  isRideHistoryPersisted,
  normalizeRideHistory,
  normalizeRideHistoryEntry,
  persistRideHistorySummary,
  readRideHistory,
  RIDE_HISTORY_KEY,
  RIDE_HISTORY_MAX_ENTRIES,
  RIDE_HISTORY_PERSIST_STATUS,
  RIDE_HISTORY_SCHEMA_VERSION,
  writeRideHistory,
} from '../lib/ride_history.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 31, 0, 0, 0);

function ride(daysAgo, overrides = {}) {
  return {
    endedAtMs: NOW - daysAgo * DAY_MS,
    elapsedMs: 60 * 60 * 1000,
    movingMs: 55 * 60 * 1000,
    distanceM: 20000,
    avgSpeedKmh: 22,
    avgCadenceRpm: 86,
    avgBpm: 142,
    sources: ['gps', 'imu', 'hrs'],
    distanceSources: ['gps'],
    cadenceSources: ['imu'],
    ...overrides,
  };
}

function memoryStorage(initial) {
  const values = new Map();
  if (initial !== undefined) values.set(RIDE_HISTORY_KEY, initial);
  return {
    getStorageSync(key) { return values.get(key); },
    setStorageSync(key, value) { values.set(key, value); },
    value() { return values.get(RIDE_HISTORY_KEY); },
  };
}

test('历史条目使用严格聚合白名单，原始坐标与设备身份无存储入口', () => {
  const entry = normalizeRideHistoryEntry({
    ...ride(0),
    latitude: 31.2304,
    longitude: 121.4737,
    track: [{ latitude: 31, longitude: 121 }],
    rawImu: [{ x: 1, y: 2, z: 3 }],
    deviceId: 'garmin-private-id',
    deviceName: 'Garmin Edge',
    publicId: 'aiui-user',
    testRideId: 'ride-secret',
    sources: ['gps', 'imu', 'Garmin Edge', 'unknown'],
  });
  assert.equal(entry.distanceM, 20000);
  assert.deepEqual(entry.sources, ['imu']);
  const serialized = JSON.stringify(entry);
  for (const forbidden of [
    'latitude',
    'longitude',
    'track',
    'rawImu',
    'deviceId',
    'deviceName',
    'publicId',
    'testRideId',
    'garmin-private-id',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'));
  }
});

test('无日期或无有效时长的骑行不会进入历史', () => {
  assert.equal(normalizeRideHistoryEntry({ elapsedMs: 1000 }), null);
  assert.equal(normalizeRideHistoryEntry({
    endedAtMs: NOW,
    elapsedMs: 0,
  }), null);
});

test('版本化历史按最新在前去重，并严格保留最近 20 场', () => {
  let history = normalizeRideHistory(null);
  for (let index = 24; index >= 0; index -= 1) {
    history = appendRideHistory(history, ride(index / 10, {
      distanceM: 1000 + index,
    }));
  }
  assert.equal(history.schemaVersion, RIDE_HISTORY_SCHEMA_VERSION);
  assert.equal(history.rides.length, RIDE_HISTORY_MAX_ENTRIES);
  for (let index = 1; index < history.rides.length; index += 1) {
    assert.ok(history.rides[index - 1].endedAtMs > history.rides[index].endedAtMs);
  }

  const latestAt = history.rides[0].endedAtMs;
  const replaced = appendRideHistory(history, {
    ...history.rides[0],
    endedAtMs: latestAt,
    distanceM: 33333,
  });
  assert.equal(replaced.rides.length, RIDE_HISTORY_MAX_ENTRIES);
  assert.equal(replaced.rides[0].distanceM, 33333);
});

test('未知 schema 安全清空，裸数组可以迁移到 v1 envelope', () => {
  assert.deepEqual(normalizeRideHistory({
    schemaVersion: 99,
    rides: [ride(0)],
  }), {
    schemaVersion: RIDE_HISTORY_SCHEMA_VERSION,
    rides: [],
  });
  const migrated = normalizeRideHistory([ride(0)]);
  assert.equal(migrated.schemaVersion, RIDE_HISTORY_SCHEMA_VERSION);
  assert.equal(migrated.rides.length, 1);
});

test('读写辅助只持久化归一化后的版本化聚合历史', () => {
  const storage = memoryStorage();
  const written = appendRideHistorySummary(storage, {
    ...ride(0),
    deviceId: 'must-not-persist',
    coordinates: [1, 2],
  });
  assert.deepEqual(readRideHistory(storage), written);
  assert.equal(isRideHistoryPersisted(storage, written), true);
  assert.equal(storage.value().schemaVersion, RIDE_HISTORY_SCHEMA_VERSION);
  assert.doesNotMatch(JSON.stringify(storage.value()), /device|coordinate/i);

  const rewritten = writeRideHistory(storage, {
    schemaVersion: 1,
    rides: [ride(1), { endedAtMs: NOW, elapsedMs: 0 }],
  });
  assert.equal(rewritten.rides.length, 1);
});

test('事务式保存只有写后回读一致才报告 persisted', () => {
  const storage = memoryStorage();
  const result = persistRideHistorySummary(storage, {
    ...ride(0),
    latitude: 31.2304,
    longitude: 121.4737,
    deviceId: 'must-not-persist',
  });
  assert.equal(result.status, RIDE_HISTORY_PERSIST_STATUS.PERSISTED);
  assert.equal(result.persisted, true);
  assert.equal(result.changed, true);
  assert.equal(result.history.rides.length, 1);
  assert.deepEqual(result.history, result.attemptedHistory);
  assert.equal(isRideHistoryPersisted(storage, result.history), true);
  assert.doesNotMatch(
    JSON.stringify(storage.value()),
    /latitude|longitude|deviceId|must-not-persist/i,
  );
});

test('事务式保存读取失败时绝不写回覆盖未知旧历史', () => {
  let setCalls = 0;
  const storage = {
    getStorageSync() { throw new Error('transient read failure'); },
    setStorageSync() { setCalls += 1; },
  };
  const result = persistRideHistorySummary(storage, ride(0));
  assert.equal(result.status, RIDE_HISTORY_PERSIST_STATUS.READ_FAILED);
  assert.equal(result.persisted, false);
  assert.equal(result.history, null);
  assert.equal(result.attemptedHistory.rides.length, 1);
  assert.equal(setCalls, 0);

  // 旧接口仍返回 envelope，但同样不得在读取失败后触发写入。
  const legacy = appendRideHistorySummary(storage, ride(0));
  assert.equal(legacy.rides.length, 1);
  assert.equal(setCalls, 0);
});

test('事务式保存区分写入异常与静默写入失败', () => {
  const current = normalizeRideHistory([ride(1)]);
  const throwing = {
    getStorageSync() { return current; },
    setStorageSync() { throw new Error('quota exceeded'); },
  };
  const writeFailed = persistRideHistorySummary(throwing, ride(0));
  assert.equal(writeFailed.status, RIDE_HISTORY_PERSIST_STATUS.WRITE_FAILED);
  assert.equal(writeFailed.persisted, false);
  assert.deepEqual(writeFailed.history, current);
  assert.equal(writeFailed.attemptedHistory.rides.length, 2);

  const silent = {
    getStorageSync() { return current; },
    setStorageSync() {},
  };
  const verificationFailed = persistRideHistorySummary(silent, ride(0));
  assert.equal(
    verificationFailed.status,
    RIDE_HISTORY_PERSIST_STATUS.VERIFICATION_FAILED,
  );
  assert.equal(verificationFailed.persisted, false);
  assert.deepEqual(verificationFailed.history, current);
  assert.equal(verificationFailed.attemptedHistory.rides.length, 2);
});

test('无效 summary 不读写存储，也绝不报告已计入', () => {
  let getCalls = 0;
  let setCalls = 0;
  const storage = {
    getStorageSync() {
      getCalls += 1;
      return normalizeRideHistory([ride(1)]);
    },
    setStorageSync() { setCalls += 1; },
  };
  const result = persistRideHistorySummary(storage, {
    endedAtMs: NOW,
    elapsedMs: 0,
  });
  assert.equal(result.status, RIDE_HISTORY_PERSIST_STATUS.INVALID_SUMMARY);
  assert.equal(result.persisted, false);
  assert.equal(result.history, null);
  assert.equal(result.attemptedHistory, null);
  assert.equal(getCalls, 0);
  assert.equal(setCalls, 0);
});

test('存储接口缺失或抛错时返回安全空历史', () => {
  assert.equal(readRideHistory(null).rides.length, 0);
  const broken = {
    getStorageSync() { throw new Error('read failed'); },
    setStorageSync() { throw new Error('write failed'); },
  };
  assert.equal(readRideHistory(broken).rides.length, 0);
  const written = writeRideHistory(broken, [ride(0)]);
  assert.equal(written.rides.length, 1);
  assert.equal(isRideHistoryPersisted(broken, written), false);
});

test('7 天窗口排除旧记录和未来记录，并保留可证实总量', () => {
  const history = normalizeRideHistory([
    ride(0, { distanceM: 10000 }),
    ride(3, { distanceM: 20000 }),
    ride(8, { distanceM: 90000 }),
    {
      ...ride(0),
      endedAtMs: NOW + 1000,
      distanceM: 70000,
    },
  ]);
  const trend = buildSevenDayRideTrend(history, NOW);
  assert.equal(trend.rideCount, 2);
  assert.equal(trend.totalDistanceM, 30000);
  assert.equal(trend.status, 'insufficient');
  assert.equal(trend.reason, 'comparable_samples');
});

test('样本不足时诚实返回，不生成提升或下降结论', () => {
  const history = normalizeRideHistory([
    ride(0, { avgSpeedKmh: 30 }),
    ride(2, { avgSpeedKmh: 20 }),
    ride(4, { avgSpeedKmh: 25 }),
  ]);
  const trend = buildSevenDayRideTrend(history, NOW);
  assert.equal(trend.status, 'insufficient');
  assert.equal(trend.comparison, null);
  const text = formatRideTrendText(trend);
  assert.match(text, /近7天 3 次/);
  assert.match(text, /样本不足/);
  assert.doesNotMatch(text, /提升|下降|较前期高|较前期低/);
});

test('近七天极短累计距离使用语义状态而不是 0.00 公里', () => {
  const history = normalizeRideHistory([
    ride(0, { distanceM: 2, avgSpeedKmh: null }),
  ]);
  const text = formatRideTrendText(buildSevenDayRideTrend(history, NOW));
  assert.match(text, /近7天 1 次 \/ 距离很短/);
  assert.doesNotMatch(text, /0\.00/);
});

test('至少 4 场可比均速后才描述前后期变化', () => {
  const history = normalizeRideHistory([
    ride(6, { avgSpeedKmh: 20, distanceM: 10000 }),
    ride(4, { avgSpeedKmh: 20, distanceM: 10000 }),
    ride(2, { avgSpeedKmh: 22, distanceM: 10000 }),
    ride(0, { avgSpeedKmh: 22, distanceM: 10000 }),
  ]);
  const trend = buildSevenDayRideTrend(history, NOW);
  assert.equal(trend.status, 'ready');
  assert.equal(trend.comparison.metric, 'speed');
  assert.equal(trend.comparison.direction, 'up');
  assert.equal(trend.comparison.changePct, 10);
  assert.equal(
    formatRideTrendText(trend),
    '近7天 4 次 / 40.00 公里，近期均速较前期高 10%。',
  );
});

test('历史达到 20 场上限时，7 天文案明确只基于最近 20 场', () => {
  let history = normalizeRideHistory(null);
  for (let index = 0; index < 25; index += 1) {
    history = appendRideHistory(history, {
      ...ride(index / 24),
      distanceM: 1000,
    });
  }
  const trend = buildSevenDayRideTrend(history, NOW);
  assert.equal(history.rides.length, RIDE_HISTORY_MAX_ENTRIES);
  assert.equal(trend.historyAtCapacity, true);
  assert.equal(trend.rideCount, RIDE_HISTORY_MAX_ENTRIES);
  assert.match(
    formatRideTrendText(trend),
    /^最近20场中，近7天 20 次 \/ 20\.00 公里，/,
  );
});

test('均速不足时可描述踏频变化，但不称训练提升', () => {
  const history = normalizeRideHistory([
    ride(6, { avgSpeedKmh: null, avgCadenceRpm: 80 }),
    ride(4, { avgSpeedKmh: null, avgCadenceRpm: 80 }),
    ride(2, { avgSpeedKmh: null, avgCadenceRpm: 84 }),
    ride(0, { avgSpeedKmh: null, avgCadenceRpm: 84 }),
  ]);
  const trend = buildSevenDayRideTrend(history, NOW);
  assert.equal(trend.status, 'ready');
  assert.equal(trend.comparison.metric, 'cadence');
  assert.equal(trend.comparison.changePct, 5);
  const text = formatRideTrendText(trend);
  assert.match(text, /平均踏频较前期高 5%/);
  assert.doesNotMatch(text, /提升|更好|进步/);
});

test('3% 内按基本持平表达，骑后文本只增加本次已计入', () => {
  const history = normalizeRideHistory([
    ride(6, { avgSpeedKmh: 20 }),
    ride(4, { avgSpeedKmh: 20 }),
    ride(2, { avgSpeedKmh: 20.4 }),
    ride(0, { avgSpeedKmh: 20.4 }),
  ]);
  const trend = buildSevenDayRideTrend(history, NOW);
  assert.equal(trend.comparison.direction, 'steady');
  const pre = formatRideTrendText(trend, 'pre');
  const post = formatRideTrendText(trend, 'post');
  assert.match(pre, /均速与前期基本持平/);
  assert.equal(post, `本次已计入。${pre}`);
  assert.equal(buildRideTrendText(history, NOW, 'post'), post);
});

test('无记录和无效当前时间均返回明确占位', () => {
  const empty = buildSevenDayRideTrend(null, NOW);
  assert.equal(empty.status, 'insufficient');
  assert.equal(empty.reason, 'no_rides');
  assert.equal(formatRideTrendText(empty), '近7天暂无骑行记录。');

  const invalid = buildSevenDayRideTrend([ride(0)], NaN);
  assert.equal(invalid.reason, 'invalid_now');
  assert.match(formatRideTrendText(invalid), /暂无骑行记录/);
});

test('纯函数不会修改冻结的历史输入', () => {
  const frozenRide = Object.freeze(ride(1));
  const history = Object.freeze({
    schemaVersion: 1,
    rides: Object.freeze([frozenRide]),
  });
  const appended = appendRideHistory(history, ride(0));
  assert.equal(appended.rides.length, 2);
  assert.equal(history.rides.length, 1);
});
