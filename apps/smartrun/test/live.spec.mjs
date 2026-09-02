import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSnapshot, writeLiveSnapshot, readLiveSnapshot, clearLiveSnapshot,
  LIVE_SNAPSHOT_KEY, LIVE_SNAPSHOT_TTL_MS,
} from '../lib/live.js';

// 假 wx storage:同步 get/set/remove,可注入。
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    store: m,
    setStorageSync(k, v) { m.set(k, v); },
    getStorageSync(k) { return m.has(k) ? m.get(k) : ''; },
    removeStorageSync(k) { m.delete(k); },
  };
}

test('normalizeSnapshot：只留有限数值 + paused/stationary；无数值 → null', () => {
  assert.equal(normalizeSnapshot(null), null);
  assert.equal(normalizeSnapshot({}), null);
  assert.equal(normalizeSnapshot({ paused: true }), null);          // 只有标志无数值 → null
  assert.equal(normalizeSnapshot({ bpm: NaN, distanceM: undefined }), null);
  const n = normalizeSnapshot({
    bpm: 156, zone: 4, paceSecPerKm: 342, cadenceSpm: 178,
    distanceM: 3200, elapsedMs: 1140000, heartDeviceName: 'Garmin HRM-Pro Plus',
    heartRateMaxHrBpm: 198, heartRatePolicySource: 'garmin_profile',
    paused: false, stationary: true, junk: 'x',
  });
  assert.deepEqual(n, {
    bpm: 156, zone: 4, paceSecPerKm: 342, cadenceSpm: 178,
    distanceM: 3200, elapsedMs: 1140000, heartDeviceName: 'Garmin…Plus',
    heartRateMaxHrBpm: 198, heartRatePolicySource: 'garmin_profile',
    paused: false, stationary: true,
  });
  assert.equal('junk' in n, false);
});

test('normalizeSnapshot：室内原地无配速(null)也算有效(有步数/时长)', () => {
  const n = normalizeSnapshot({ cadenceSpm: 180, elapsedMs: 60000, paceSecPerKm: null, stationary: true });
  assert.deepEqual(n, { cadenceSpm: 180, elapsedMs: 60000, paused: false, stationary: true });
});

test('实时快照只接受成对且在 120–230 范围内的最大心率策略字段', () => {
  assert.deepEqual(normalizeSnapshot({
    bpm: 150,
    heartRateMaxHrBpm: 119,
    heartRatePolicySource: 'user_explicit',
  }), { bpm: 150, paused: false });
  assert.deepEqual(normalizeSnapshot({
    bpm: 150,
    heartRateMaxHrBpm: 190,
    heartRatePolicySource: 'unknown',
  }), { bpm: 150, paused: false });
});

test('write→read 往返；write 无效数据会清掉旧值', () => {
  const st = fakeStorage();
  writeLiveSnapshot(st, { bpm: 150, elapsedMs: 1000 });
  assert.deepEqual(readLiveSnapshot(st), { bpm: 150, elapsedMs: 1000, paused: false });
  // 写一份无效快照 → 清掉(不残留过期数据)
  writeLiveSnapshot(st, {});
  assert.equal(readLiveSnapshot(st), null);
  assert.equal(st.store.has(LIVE_SNAPSHOT_KEY), false);
});

test('clearLiveSnapshot 清除;读空 storage → null', () => {
  const st = fakeStorage();
  writeLiveSnapshot(st, { distanceM: 500 });
  clearLiveSnapshot(st);
  assert.equal(readLiveSnapshot(st), null);
});

test('快照 TTL:10s 内可读,过期/无 ts 的旧格式 → null(教练不拿旧数据当此刻)', () => {
  const st = fakeStorage();
  const t0 = 1000000;
  writeLiveSnapshot(st, { bpm: 150, elapsedMs: 60000 }, t0);
  // TTL 内:可读
  assert.deepEqual(
    readLiveSnapshot(st, t0 + LIVE_SNAPSHOT_TTL_MS),
    { bpm: 150, elapsedMs: 60000, paused: false },
  );
  // 刚过期:null(HUD 停止刷新、异常退出残留都会走到这)
  assert.equal(readLiveSnapshot(st, t0 + LIVE_SNAPSHOT_TTL_MS + 1), null);
  // 旧格式(无 ts)一律视为过期
  st.setStorageSync(LIVE_SNAPSHOT_KEY, { bpm: 150, elapsedMs: 60000, paused: false });
  assert.equal(readLiveSnapshot(st, t0), null);
});

test('storage 抛异常 / 缺失 → 静默 null,不崩', () => {
  const boom = {
    setStorageSync() { throw new Error('quota'); },
    getStorageSync() { throw new Error('io'); },
    removeStorageSync() { throw new Error('io'); },
  };
  assert.doesNotThrow(() => writeLiveSnapshot(boom, { bpm: 100 }));
  assert.equal(readLiveSnapshot(boom), null);
  assert.doesNotThrow(() => clearLiveSnapshot(boom));
  assert.equal(readLiveSnapshot(null), null);
  assert.doesNotThrow(() => writeLiveSnapshot(null, { bpm: 1 }));
});
