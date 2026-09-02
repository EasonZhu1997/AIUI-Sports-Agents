import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_RUN_MEMORIES_KEY,
  LOCAL_RUN_MEMORIES_MAX,
  buildContext,
  clear,
  enqueue,
  normalizeLocalRunMemory,
  read,
  readLocalRunMemoriesState,
} from '../lib/local_run_memory.js';

function fakeStorage(initial) {
  const map = new Map();
  if (initial !== undefined) map.set(LOCAL_RUN_MEMORIES_KEY, initial);
  return {
    map,
    getStorageSync(key) { return map.get(key); },
    setStorageSync(key, value) { map.set(key, value); },
    removeStorageSync(key) { map.delete(key); },
  };
}

test('normalizes current, snake_case and bilingual summary fields', () => {
  assert.deepEqual(normalizeLocalRunMemory({
    workout_type: 'slow_jog',
    ended_at: '2026-07-17T01:02:03.000Z',
    duration_s: 600,
    distance_m: 1200,
    avg_hr: 132,
    cadence_avg: 178,
    step_count: 1800,
    summary_zh: ' 节奏稳定，继续保持。 ',
    summary_en: ' Steady rhythm. Keep going. ',
  }), {
    mode: 'slow',
    endedAtMs: Date.parse('2026-07-17T01:02:03.000Z'),
    elapsedMs: 600000,
    textZh: '节奏稳定，继续保持。',
    textEn: 'Steady rhythm. Keep going.',
    distanceM: 1200,
    avgBpm: 132,
    avgCadenceSpm: 178,
    steps: 1800,
  });
});

test('enqueue deduplicates records and keeps the five most recent by completion time', () => {
  const storage = fakeStorage();
  for (let i = 1; i <= 7; i += 1) {
    enqueue(storage, { endedAtMs: i * 1000, elapsedMs: 60000, text: `run ${i}` }, i * 1000);
  }
  enqueue(storage, { endedAtMs: 7000, elapsedMs: 60000, text: 'run 7' }, 8000);
  const memories = read(storage);
  assert.equal(memories.length, LOCAL_RUN_MEMORIES_MAX);
  assert.deepEqual(memories.map((item) => item.text), ['run 3', 'run 4', 'run 5', 'run 6', 'run 7']);
});

test('missing, damaged and throwing storage degrade safely', () => {
  assert.deepEqual(read(null), []);
  assert.deepEqual(read(fakeStorage('damaged')), []);
  const throwing = {
    getStorageSync() { throw new Error('read failed'); },
    setStorageSync() { throw new Error('write failed'); },
    removeStorageSync() { throw new Error('remove failed'); },
  };
  assert.deepEqual(read(throwing), []);
  assert.equal(enqueue(throwing, { elapsedMs: 1000, text: 'kept in memory' }, 100), null);
  assert.deepEqual(clear(throwing), []);
});

test('corrupt or unreadable memory is unknown and enqueue never overwrites old evidence', () => {
  const corrupt = fakeStorage('damaged-evidence');
  assert.deepEqual(read(corrupt), []);
  assert.equal(readLocalRunMemoriesState(corrupt).reason, 'memory_corrupt');
  assert.equal(enqueue(
    corrupt, { elapsedMs: 1000, text: 'must not replace old' }, 100,
  ), null);
  assert.equal(corrupt.map.get(LOCAL_RUN_MEMORIES_KEY), 'damaged-evidence');

  const unreadable = fakeStorage([{ elapsedMs: 1000, text: 'old evidence' }]);
  const old = unreadable.map.get(LOCAL_RUN_MEMORIES_KEY);
  unreadable.getStorageSync = () => { throw new Error('temporary read failure'); };
  assert.equal(readLocalRunMemoriesState(unreadable).reason, 'storage_read_failed');
  assert.equal(enqueue(
    unreadable, { elapsedMs: 1000, text: 'must not replace old' }, 100,
  ), null);
  assert.deepEqual(unreadable.map.get(LOCAL_RUN_MEMORIES_KEY), old);
});

test('enqueue 只有写后读回一致才成功，throw 与静默 no-op 都返回 null', () => {
  const throwing = fakeStorage();
  throwing.setStorageSync = () => { throw new Error('quota'); };
  assert.equal(enqueue(throwing, { elapsedMs: 1000, text: 'throwing' }, 100), null);

  const silent = fakeStorage();
  silent.setStorageSync = () => {};
  assert.equal(enqueue(silent, { elapsedMs: 1000, text: 'silent' }, 100), null);
  assert.deepEqual(read(silent), []);
});

test('clear removes the persistent key', () => {
  const storage = fakeStorage();
  enqueue(storage, { elapsedMs: 1000, text: 'one run' }, 100);
  assert.equal(storage.map.has(LOCAL_RUN_MEMORIES_KEY), true);
  assert.deepEqual(clear(storage), []);
  assert.equal(storage.map.has(LOCAL_RUN_MEMORIES_KEY), false);
});

test('buildContext chooses the requested language and orders recent runs first', () => {
  const records = [
    { endedAtMs: 100, elapsedMs: 60000, textZh: '第一跑', textEn: 'first run' },
    { endedAtMs: 200, elapsedMs: 60000, textZh: '第二跑', textEn: 'second run' },
    { endedAtMs: 300, elapsedMs: 60000, textZh: '第三跑', textEn: 'third run' },
  ];
  assert.equal(buildContext(records, { language: 'zh-CN', maxItems: 2 }), '第三跑 | 第二跑');
  assert.equal(buildContext(records, { language: 'en-US', maxItems: 2 }), 'third run | second run');
});

test('buildContext accepts storage, bounds output and falls back to aggregate metrics', () => {
  const storage = fakeStorage();
  enqueue(storage, {
    mode: 'slow', endedAtMs: 100, elapsedMs: 20 * 60000,
    steps: 3200, avgBpm: 128, avgCadenceSpm: 176,
  }, 100);
  assert.equal(buildContext(storage), 'slow-jog 20min 3200steps HR128 cadence176');
  assert.equal(buildContext([
    { endedAtMs: 200, elapsedMs: 1000, text: 'abcdefghijklmnopqrstuvwxyz' },
  ], { maxChars: 10 }), 'abcdefghij');
});

test('室内跑在本地记忆中保留模式身份并复用跑步指标', () => {
  const record = normalizeLocalRunMemory({
    mode: 'garmin_virtual', endedAtMs: 200, elapsedMs: 600000,
    distanceM: 1500, avgCadenceSpm: 170,
  });
  assert.equal(record.mode, 'garmin_virtual');
  assert.equal(
    buildContext([record]),
    'garmin-virtual-run 10min 1.50km cadence170',
  );
});

test('invalid non-summary values are ignored', () => {
  const storage = fakeStorage();
  assert.equal(normalizeLocalRunMemory(null), null);
  assert.equal(normalizeLocalRunMemory({ mode: 'free' }), null);
  assert.deepEqual(enqueue(storage, { mode: 'free' }, 0), []);
  assert.equal(buildContext([]), '');
});
