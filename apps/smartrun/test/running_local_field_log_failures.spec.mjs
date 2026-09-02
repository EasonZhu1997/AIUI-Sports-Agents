import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RUNNING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS,
  RUNNING_LOCAL_FIELD_LOG_CHUNK_PREFIX,
  RUNNING_LOCAL_FIELD_LOG_CHUNK_SAMPLES,
  RUNNING_LOCAL_FIELD_LOG_KEY,
  RUNNING_LOCAL_FIELD_LOG_MAX_CHUNK_BYTES,
  RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
  RUNNING_LOCAL_FIELD_LOG_STATUS,
  appendRunningLocalFieldEvent,
  appendRunningLocalFieldSamples,
  beginRunningLocalFieldLog,
  buildLatestRunningLocalFieldLogDigest,
  buildRunningLocalFieldLogReplayLines,
  clearRunningLocalFieldLogs,
  createRunningLocalFieldLogId,
  finishRunningLocalFieldLog,
  normalizeRunningLocalFieldEvent,
  normalizeRunningLocalFieldRun,
  normalizeRunningLocalFieldSample,
  normalizeRunningLocalFieldStore,
  normalizeRunningLocalFieldSummary,
  readLatestRunningLocalFieldLog,
  readRunningLocalFieldLog,
  readRunningLocalFieldLogIndexResult,
  readRunningLocalFieldLogs,
  readRunningLocalFieldLogsResult,
  recoverActiveRunningLocalFieldLogs,
  runningLocalFieldLogChecksum,
  runningLocalFieldLogChunkKey,
  runningLocalFieldLogUtf8Bytes,
} from '../lib/running_local_field_log.js';

const START = 1787000000000;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function storageHarness(entries = []) {
  const values = new Map(entries.map(([key, value]) => [key, clone(value)]));
  const counts = {
    get: new Map(),
    set: new Map(),
    remove: new Map(),
  };
  const throws = {
    get: new Map(),
    set: new Map(),
    remove: new Map(),
  };
  const silentSets = new Set();
  const silentRemoves = new Set();

  function increment(operation, key) {
    const next = (counts[operation].get(key) || 0) + 1;
    counts[operation].set(key, next);
    return next;
  }

  function shouldThrow(operation, key, call) {
    return throws[operation].get(key)?.has(call)
      || throws[operation].get('*')?.has(call);
  }

  const storage = {
    getStorageSync(key) {
      const call = increment('get', key);
      if (shouldThrow('get', key, call)) throw new Error('get failed');
      return clone(values.get(key));
    },
    setStorageSync(key, value) {
      const call = increment('set', key);
      if (shouldThrow('set', key, call)) throw new Error('set failed');
      if (!silentSets.has(key)) values.set(key, clone(value));
    },
    removeStorageSync(key) {
      const call = increment('remove', key);
      if (shouldThrow('remove', key, call)) throw new Error('remove failed');
      if (!silentRemoves.has(key)) values.delete(key);
    },
    raw(key) { return clone(values.get(key)); },
    put(key, value) { values.set(key, clone(value)); },
    delete(key) { values.delete(key); },
    entries() { return [...values.entries()].map(([key, value]) => [key, clone(value)]); },
    count(operation, key) { return counts[operation].get(key) || 0; },
    throwOn(operation, key, call) {
      if (!throws[operation].has(key)) throws[operation].set(key, new Set());
      throws[operation].get(key).add(call);
    },
    throwNext(operation, key, offset = 1) {
      storage.throwOn(operation, key, storage.count(operation, key) + offset);
    },
    silentSet(key) { silentSets.add(key); },
    silentRemove(key) { silentRemoves.add(key); },
  };
  return storage;
}

function runId(offset = 0, nonce = 'failurecase') {
  return createRunningLocalFieldLogId(START + offset, nonce + offset);
}

function sample(index, overrides = {}) {
  return {
    captured_at_ms: START + index * RUNNING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS,
    elapsed_ms: index * RUNNING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS,
    bpm: 143,
    cadence_spm: 172,
    candidate_cadence_spm: 174,
    speed_mps: 3.2,
    pace_sec_per_km: 312.5,
    distance_m: index * 16,
    steps_total: index * 14,
    motion_quality: 0.88,
    artifact_confidence: 0.05,
    gyro_rms: 0.14,
    stationary: false,
    distance_source: 'imu',
    cadence_source: 'imu',
    rsc_live: false,
    hr_live: true,
    ble_state: 'connected',
    page_visible: true,
    paused: false,
    accel_age_ms: 30,
    sensor_generation: 2,
    trigger: 'ticker',
    ...overrides,
  };
}

function chunkKey(id, index = 0) {
  return runningLocalFieldLogChunkKey(id, index);
}

function rehashChunk(value) {
  const core = {
    v: value.v,
    r: value.r,
    i: value.i,
    b: value.b,
    s: value.s,
  };
  return { ...core, h: runningLocalFieldLogChecksum(JSON.stringify(core)) };
}

function populatedStorage(offset = 1, values = [sample(1)]) {
  const storage = storageHarness();
  const id = runId(offset);
  assert.equal(beginRunningLocalFieldLog(storage, {
    runId: id,
    startedAtMs: START,
  }).ok, true);
  assert.equal(appendRunningLocalFieldSamples(storage, id, values).ok, true);
  return { storage, id };
}

function activeMetadata(id, startedAtMs = START) {
  return {
    run_id: id,
    started_at_ms: startedAtMs,
    status: 'active',
    sample_count: 0,
    chunk_count: 0,
    chunk_bytes: [],
    dropped_count: 0,
    storage_status: 'ok',
    events: [],
  };
}

test('UTF-8、checksum、ID 与严格 normalizer 覆盖异常字符和边界输入', () => {
  assert.equal(runningLocalFieldLogUtf8Bytes('A¢中😀\ud800'), 13);
  assert.equal(runningLocalFieldLogChecksum(null), '811c9dc5');
  assert.notEqual(runningLocalFieldLogChecksum('é'), runningLocalFieldLogChecksum('中'));
  assert.match(createRunningLocalFieldLogId(START, '***'),
    /^run-[a-z0-9]{8,16}-[a-z0-9]{6,20}$/);
  assert.equal(createRunningLocalFieldLogId(START, 'ABC-123').includes('abc123'), true);
  assert.equal(createRunningLocalFieldLogId(START - 999999999999, 'abcdef'), '');
  assert.equal(runningLocalFieldLogChunkKey(runId(1), 999), '');

  assert.equal(normalizeRunningLocalFieldSample('bad'), null);
  assert.equal(normalizeRunningLocalFieldSample({
    captured_at_ms: START,
    elapsed_ms: 0,
    bpm: Infinity,
    speed_mps: -1,
  }).bpm, undefined);
  const rounded = normalizeRunningLocalFieldSample(sample(1, {
    bpm: 142.6,
    stationary: true,
    distance_source: 'rsc_speed',
    cadence_source: 'rsc',
    ble_state: 'reconnecting',
    trigger: 'finish',
  }));
  assert.equal(rounded.bpm, 143);
  assert.equal(rounded.distance_source, 'rsc_speed');

  assert.equal(normalizeRunningLocalFieldEvent([]), null);
  assert.equal(normalizeRunningLocalFieldEvent({
    at_ms: START,
    kind: 'ble',
    name: 'lowercase',
  }), null);
  assert.deepEqual(normalizeRunningLocalFieldEvent({
    at_ms: START,
    kind: 'storage',
    name: 'WRITE_FAILED',
    reason: 'safe.reason:1',
    generation: 4,
  }), {
    at_ms: START,
    kind: 'storage',
    name: 'WRITE_FAILED',
    generation: 4,
    reason: 'safe.reason:1',
  });
  assert.equal(normalizeRunningLocalFieldSummary([]), null);
  assert.equal(normalizeRunningLocalFieldSummary({ distance_m: -1 }), null);

  assert.equal(normalizeRunningLocalFieldRun([]), null);
  assert.equal(normalizeRunningLocalFieldRun({
    run_id: 'bad',
    started_at_ms: START,
  }), null);
  assert.equal(normalizeRunningLocalFieldRun({
    run_id: runId(2),
    started_at_ms: START,
    status: 'invalid',
  }), null);
  const active = normalizeRunningLocalFieldRun({
    run_id: runId(3),
    started_at_ms: START,
    ended_at_ms: START + 1,
    samples: [],
    events: [],
  });
  assert.equal(active.status, 'active');
  assert.equal(active.ended_at_ms, undefined);
});

test('store normalizer 丢弃坏项与重复项，但不会误删 active 场', () => {
  const completed = (offset) => ({
    run_id: runId(offset),
    started_at_ms: START + offset * 1000,
    ended_at_ms: START + offset * 1000 + 100,
    status: 'completed',
    samples: [],
    events: [],
  });
  const active = (offset) => ({
    run_id: runId(offset),
    started_at_ms: START + offset * 1000,
    status: 'active',
    samples: [],
    events: [],
  });
  const normalized = normalizeRunningLocalFieldStore({
    schema_version: RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    runs: [completed(1), active(4), active(3), active(2), completed(1), null],
  });
  assert.deepEqual(normalized.runs.map((run) => run.run_id), [
    runId(4), runId(3), runId(2),
  ]);
  assert.deepEqual(normalizeRunningLocalFieldStore({ schema_version: 2, runs: [] }), {
    schema_version: RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    runs: [],
  });
});

test('malformed index 与 read throw 都返回精确状态而不抛异常', () => {
  assert.equal(readRunningLocalFieldLogIndexResult(null).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE);
  const throwing = storageHarness();
  throwing.throwNext('get', RUNNING_LOCAL_FIELD_LOG_KEY);
  assert.equal(readRunningLocalFieldLogIndexResult(throwing).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.READ_FAILED);

  const baseRun = activeMetadata(runId(10));
  const malformed = [
    42,
    { schema_version: 2, runs: [], pending_cleanup: [] },
    { schema_version: 1, runs: 'bad', pending_cleanup: [] },
    { schema_version: 1, runs: [], pending_cleanup: 'bad' },
    { schema_version: 1, runs: [baseRun, baseRun], pending_cleanup: [] },
    { schema_version: 1, runs: [{ ...baseRun, sample_count: 1 }], pending_cleanup: [] },
    {
      schema_version: 1,
      runs: [{
        ...baseRun,
        sample_count: 60,
        chunk_count: 2,
        chunk_bytes: [10, 10],
        last_sample_at_ms: START + 5000,
        last_elapsed_ms: 5000,
      }],
      pending_cleanup: [],
    },
    {
      schema_version: 1,
      runs: [{
        ...baseRun,
        sample_count: 121,
        chunk_count: 2,
        chunk_bytes: [10, 10],
        last_sample_at_ms: START + 5000,
        last_elapsed_ms: 5000,
      }],
      pending_cleanup: [],
    },
    {
      schema_version: 1,
      runs: [{
        ...baseRun,
        sample_count: 1,
        chunk_count: 1,
        chunk_bytes: [0],
        last_sample_at_ms: START + 5000,
        last_elapsed_ms: 5000,
      }],
      pending_cleanup: [],
    },
    {
      schema_version: 1,
      runs: [baseRun],
      pending_cleanup: [{ run_id: baseRun.run_id, chunk_count: 0, chunk_bytes: [] }],
    },
    {
      schema_version: 1,
      runs: [],
      pending_cleanup: [
        { run_id: runId(11), chunk_count: 0, chunk_bytes: [] },
        { run_id: runId(11), chunk_count: 0, chunk_bytes: [] },
      ],
    },
  ];
  for (const raw of malformed) {
    const storage = storageHarness([[RUNNING_LOCAL_FIELD_LOG_KEY, raw]]);
    assert.equal(readRunningLocalFieldLogIndexResult(storage).status,
      RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE);
    assert.equal(readRunningLocalFieldLogsResult(storage).ok, false);
  }
});

test('begin 覆盖读取、写入、静默写入、幂等和冲突分支', () => {
  const id = runId(20);
  const getOnly = { getStorageSync() { return undefined; } };
  assert.equal(beginRunningLocalFieldLog(getOnly, {
    runId: id,
    startedAtMs: START,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE);

  const readFailure = storageHarness();
  readFailure.throwNext('get', RUNNING_LOCAL_FIELD_LOG_KEY);
  assert.equal(beginRunningLocalFieldLog(readFailure, {
    runId: id,
    startedAtMs: START,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.READ_FAILED);

  const writeFailure = storageHarness();
  writeFailure.throwNext('set', RUNNING_LOCAL_FIELD_LOG_KEY);
  assert.equal(beginRunningLocalFieldLog(writeFailure, {
    runId: id,
    startedAtMs: START,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.WRITE_FAILED);

  const silent = storageHarness();
  silent.silentSet(RUNNING_LOCAL_FIELD_LOG_KEY);
  assert.equal(beginRunningLocalFieldLog(silent, {
    runId: id,
    startedAtMs: START,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.VERIFICATION_FAILED);

  const good = storageHarness();
  assert.equal(beginRunningLocalFieldLog(good, {
    runId: id,
    startedAtMs: START,
  }).ok, true);
  assert.equal(beginRunningLocalFieldLog(good, {
    runId: id,
    startedAtMs: START,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE);
  assert.equal(beginRunningLocalFieldLog(good, {
    runId: id,
    startedAtMs: START + 1,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT);
  assert.equal(beginRunningLocalFieldLog(good, null).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT);
});

test('损坏、缺失和读取失败的 chunk 都安全降级为 partial', () => {
  const original = populatedStorage(30);
  const key = chunkKey(original.id);
  const valid = original.storage.raw(key);
  const corruptions = [
    () => null,
    (raw) => ({ ...raw, v: 2 }),
    (raw) => ({ ...raw, r: runId(999) }),
    (raw) => ({ ...raw, i: 1 }),
    (raw) => ({ ...raw, s: [] }),
    (raw) => ({ ...raw, b: 0 }),
    (raw) => ({ ...raw, h: '00000000' }),
    (raw) => rehashChunk({ ...raw, s: ['not-a-tuple'] }),
    (raw) => rehashChunk({ ...raw, s: [[-1, ...raw.s[0].slice(1)]] }),
    (raw) => {
      const tuple = raw.s[0].slice();
      tuple[12] = 2;
      return rehashChunk({ ...raw, s: [tuple] });
    },
    (raw) => {
      const tuple = raw.s[0].slice();
      tuple[13] = 99;
      return rehashChunk({ ...raw, s: [tuple] });
    },
    (raw) => rehashChunk({ ...raw, s: [raw.s[0], raw.s[0]] }),
  ];
  for (const corrupt of corruptions) {
    const storage = storageHarness(original.storage.entries());
    const value = corrupt(clone(valid));
    if (value === null) storage.delete(key);
    else storage.put(key, value);
    const all = readRunningLocalFieldLogsResult(storage);
    assert.equal(all.ok, false);
    assert.equal(all.status, RUNNING_LOCAL_FIELD_LOG_STATUS.PARTIAL_STORAGE);
    const single = readRunningLocalFieldLog(storage, original.id);
    assert.equal(single.storage_status, 'partial');
  }

  const throwing = storageHarness(original.storage.entries());
  throwing.throwNext('get', key);
  assert.equal(readRunningLocalFieldLogsResult(throwing).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.PARTIAL_STORAGE);
});

test('append 对坏输入、未知/已结束 run、时间窗和缺失派生字段给出确定结果', () => {
  assert.equal(appendRunningLocalFieldSamples(storageHarness(), 'bad', sample(1)).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT);
  const empty = storageHarness();
  assert.equal(appendRunningLocalFieldSamples(empty, runId(40), { bad: true }).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT);
  assert.equal(appendRunningLocalFieldSamples(empty, runId(40), sample(1)).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.RUN_NOT_FOUND);

  const { storage, id } = populatedStorage(41, [sample(1, {
    distance_m: undefined,
    steps_total: undefined,
  })]);
  assert.equal(readRunningLocalFieldLog(storage, id).samples[0].distance_m, undefined);
  assert.equal(appendRunningLocalFieldSamples(storage, id, sample(1, {
    captured_at_ms: START + 6000,
  })).status, RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE);
  assert.equal(finishRunningLocalFieldLog(storage, id, {
    endedAtMs: START + 10000,
  }).ok, true);
  assert.equal(appendRunningLocalFieldSamples(storage, id, sample(3)).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.RUN_FINISHED);

  const readFailure = storageHarness();
  readFailure.throwNext('get', RUNNING_LOCAL_FIELD_LOG_KEY);
  assert.equal(appendRunningLocalFieldSamples(readFailure, runId(42), sample(1)).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.READ_FAILED);
});

test('chunk 写 throw、静默 no-op 和缺少 set 均持久化 dropped 状态且不抛', () => {
  for (const mode of ['throw', 'silent', 'missing-set']) {
    const storage = storageHarness();
    const id = runId(50 + mode.length, mode.replace('-', '') + 'failure');
    assert.equal(beginRunningLocalFieldLog(storage, { runId: id, startedAtMs: START }).ok,
      true);
    const key = chunkKey(id);
    if (mode === 'throw') storage.throwNext('set', key);
    if (mode === 'silent') storage.silentSet(key);
    if (mode === 'missing-set') storage.setStorageSync = undefined;
    const result = appendRunningLocalFieldSamples(storage, id, sample(1));
    assert.equal(result.ok, false);
    assert.ok([
      RUNNING_LOCAL_FIELD_LOG_STATUS.WRITE_FAILED,
      RUNNING_LOCAL_FIELD_LOG_STATUS.VERIFICATION_FAILED,
      RUNNING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE,
    ].includes(result.status));
    assert.equal(result.dropped, 1);
  }
});

test('orphan chunk 损坏和 tail 缺失会阻止后续 append 而不破坏 index', () => {
  const missing = populatedStorage(60);
  missing.storage.delete(chunkKey(missing.id));
  assert.equal(appendRunningLocalFieldSamples(missing.storage, missing.id, sample(2)).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.PARTIAL_STORAGE);

  const corrupt = storageHarness();
  const id = runId(61);
  beginRunningLocalFieldLog(corrupt, { runId: id, startedAtMs: START });
  corrupt.put(chunkKey(id), { broken: true });
  assert.equal(appendRunningLocalFieldSamples(corrupt, id, sample(1)).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE);

  const readThrow = storageHarness();
  const throwId = runId(62);
  beginRunningLocalFieldLog(readThrow, { runId: throwId, startedAtMs: START });
  readThrow.throwNext('get', chunkKey(throwId));
  assert.equal(appendRunningLocalFieldSamples(readThrow, throwId, sample(1)).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.READ_FAILED);
});

test('容量投影会驱逐旧完成场，并在清理失败时保留可重试条目', () => {
  const storage = storageHarness();
  const activeId = runId(70);
  const oldId = runId(69);
  beginRunningLocalFieldLog(storage, { runId: activeId, startedAtMs: START });
  const index = storage.raw(RUNNING_LOCAL_FIELD_LOG_KEY);
  index.runs.push({
    run_id: oldId,
    started_at_ms: START - 60000,
    ended_at_ms: START - 50000,
    status: 'completed',
    sample_count: 32 * RUNNING_LOCAL_FIELD_LOG_CHUNK_SAMPLES,
    chunk_count: 32,
    chunk_bytes: Array(32).fill(RUNNING_LOCAL_FIELD_LOG_MAX_CHUNK_BYTES),
    last_sample_at_ms: START - 50001,
    last_elapsed_ms: 9999,
    dropped_count: 0,
    storage_status: 'ok',
    events: [],
  });
  storage.put(RUNNING_LOCAL_FIELD_LOG_KEY, index);
  const appended = appendRunningLocalFieldSamples(storage, activeId, sample(1));
  assert.equal(appended.ok, true);
  assert.equal(appended.index.runs.some((run) => run.run_id === oldId), false);
  assert.equal(appended.index.pending_cleanup.length, 0);

  const pendingStorage = storageHarness();
  const staleId = runId(71);
  const staleKey = chunkKey(staleId);
  pendingStorage.put(RUNNING_LOCAL_FIELD_LOG_KEY, {
    schema_version: 1,
    runs: [],
    pending_cleanup: [{ run_id: staleId, chunk_count: 1, chunk_bytes: [10] }],
  });
  pendingStorage.put(staleKey, { stale: true });
  pendingStorage.silentRemove(staleKey);
  const freshId = runId(72);
  const begun = beginRunningLocalFieldLog(pendingStorage, {
    runId: freshId,
    startedAtMs: START + 72,
  });
  assert.equal(begun.ok, true, 'active metadata remains durable despite cleanup failure');
  assert.equal(begun.cleanupPending, 1);
});

test('event 与 finish 覆盖 invalid、not-found、no-change 和写失败', () => {
  const storage = storageHarness();
  const id = runId(80);
  assert.equal(appendRunningLocalFieldEvent(storage, id, { bad: true }).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT);
  assert.equal(appendRunningLocalFieldEvent(storage, id, {
    at_ms: START,
    kind: 'ble',
    name: 'CONNECTED',
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.RUN_NOT_FOUND);
  assert.equal(finishRunningLocalFieldLog(storage, id, {}).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT);
  assert.equal(finishRunningLocalFieldLog(storage, id, {
    endedAtMs: START + 1,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.RUN_NOT_FOUND);

  beginRunningLocalFieldLog(storage, { runId: id, startedAtMs: START });
  const event = {
    at_ms: START + 1000,
    kind: 'ble',
    name: 'CONNECTED',
  };
  assert.equal(appendRunningLocalFieldEvent(storage, id, event).ok, true);
  assert.equal(appendRunningLocalFieldEvent(storage, id, event).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE);
  assert.equal(finishRunningLocalFieldLog(storage, id, {
    endedAtMs: START - 1,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT);
  assert.equal(finishRunningLocalFieldLog(storage, id, {
    endedAtMs: START + 5000,
    summary: { elapsed_ms: 5000, sample_count: 0 },
  }).ok, true);
  assert.equal(finishRunningLocalFieldLog(storage, id, {
    endedAtMs: START + 5000,
    summary: { elapsed_ms: 5000, sample_count: 0 },
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE);

  const failing = storageHarness();
  const failId = runId(81);
  beginRunningLocalFieldLog(failing, { runId: failId, startedAtMs: START });
  failing.throwNext('set', RUNNING_LOCAL_FIELD_LOG_KEY);
  assert.equal(appendRunningLocalFieldEvent(failing, failId, event).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.WRITE_FAILED);
});

test('read helpers、digest 与多分片 replay 对空值和完整 store 都稳定', () => {
  const empty = storageHarness();
  assert.equal(readRunningLocalFieldLog(empty, 'bad'), null);
  assert.equal(readRunningLocalFieldLog(empty, runId(90)), null);
  assert.equal(readLatestRunningLocalFieldLog(empty), null);
  assert.deepEqual(readRunningLocalFieldLogs(empty), {
    schema_version: RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    runs: [],
  });
  assert.equal(buildLatestRunningLocalFieldLogDigest(null), null);
  assert.deepEqual(buildRunningLocalFieldLogReplayLines(null), []);

  const values = Array.from({ length: 30 }, (_, index) => sample(index + 1));
  const { storage, id } = populatedStorage(91, values);
  finishRunningLocalFieldLog(storage, id, { endedAtMs: START + 160000 });
  const store = readRunningLocalFieldLogs(storage);
  const digest = buildLatestRunningLocalFieldLogDigest(store);
  assert.equal(digest.run_id, id);
  assert.equal(digest.sample_count, 30);
  assert.ok(buildRunningLocalFieldLogReplayLines(store.runs[0]).length > 3);

  const broken = storageHarness(storage.entries());
  broken.throwNext('get', RUNNING_LOCAL_FIELD_LOG_KEY);
  assert.equal(readLatestRunningLocalFieldLog(broken), null);
});

test('recover 覆盖参数错误、读取失败、空场、部分失败和最终读失败', () => {
  assert.equal(recoverActiveRunningLocalFieldLogs(storageHarness(), {
    endedAtMs: 0,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT);
  const readFailure = storageHarness();
  readFailure.throwNext('get', RUNNING_LOCAL_FIELD_LOG_KEY);
  assert.equal(recoverActiveRunningLocalFieldLogs(readFailure, {
    endedAtMs: START,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.READ_FAILED);
  const empty = recoverActiveRunningLocalFieldLogs(storageHarness(), {
    endedAtMs: START,
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.status, RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE);
  assert.equal(empty.recovered, 0);

  const finishFailure = storageHarness();
  const failId = runId(100);
  beginRunningLocalFieldLog(finishFailure, { runId: failId, startedAtMs: START });
  finishFailure.throwOn(
    'set',
    RUNNING_LOCAL_FIELD_LOG_KEY,
    finishFailure.count('set', RUNNING_LOCAL_FIELD_LOG_KEY) + 2,
  );
  const failed = recoverActiveRunningLocalFieldLogs(finishFailure, {
    endedAtMs: START + 10000,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.recovered, 0);
  assert.equal(failed.status, RUNNING_LOCAL_FIELD_LOG_STATUS.WRITE_FAILED);

  const finalReadFailure = storageHarness();
  const finalId = runId(101);
  beginRunningLocalFieldLog(finalReadFailure, { runId: finalId, startedAtMs: START });
  finalReadFailure.throwOn(
    'get',
    RUNNING_LOCAL_FIELD_LOG_KEY,
    finalReadFailure.count('get', RUNNING_LOCAL_FIELD_LOG_KEY) + 6,
  );
  const recovered = recoverActiveRunningLocalFieldLogs(finalReadFailure, {
    endedAtMs: START + 10000,
  });
  assert.equal(recovered.recovered, 1);
  assert.equal(recovered.ok, false);
});

test('clear 对 remove 缺失、throw、no-op、chunk 失败和验证读取失败均有明确状态', () => {
  assert.equal(clearRunningLocalFieldLogs(null).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE);
  assert.equal(clearRunningLocalFieldLogs({ getStorageSync() { return undefined; } }).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE);

  const indexThrow = populatedStorage(110);
  indexThrow.storage.throwNext('remove', RUNNING_LOCAL_FIELD_LOG_KEY);
  assert.equal(clearRunningLocalFieldLogs(indexThrow.storage).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.WRITE_FAILED);

  const indexNoOp = populatedStorage(111);
  indexNoOp.storage.silentRemove(RUNNING_LOCAL_FIELD_LOG_KEY);
  assert.equal(clearRunningLocalFieldLogs(indexNoOp.storage).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.VERIFICATION_FAILED);

  const chunkThrow = populatedStorage(112);
  chunkThrow.storage.throwNext('remove', chunkKey(chunkThrow.id));
  assert.equal(clearRunningLocalFieldLogs(chunkThrow.storage).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.VERIFICATION_FAILED);

  const chunkNoOp = populatedStorage(113);
  chunkNoOp.storage.silentRemove(chunkKey(chunkNoOp.id));
  assert.equal(clearRunningLocalFieldLogs(chunkNoOp.storage).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.VERIFICATION_FAILED);

  const verifyThrow = populatedStorage(114);
  verifyThrow.storage.throwOn(
    'get',
    RUNNING_LOCAL_FIELD_LOG_KEY,
    verifyThrow.storage.count('get', RUNNING_LOCAL_FIELD_LOG_KEY) + 2,
  );
  assert.equal(clearRunningLocalFieldLogs(verifyThrow.storage).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.VERIFICATION_FAILED);

  const malformed = storageHarness([[RUNNING_LOCAL_FIELD_LOG_KEY, { broken: true }]]);
  assert.equal(clearRunningLocalFieldLogs(malformed).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE);
});

test('clear 也会遍历 pending cleanup 的 chunk', () => {
  const storage = storageHarness();
  const staleId = runId(120);
  storage.put(RUNNING_LOCAL_FIELD_LOG_KEY, {
    schema_version: 1,
    runs: [],
    pending_cleanup: [{ run_id: staleId, chunk_count: 1, chunk_bytes: [10] }],
  });
  storage.put(chunkKey(staleId), { stale: true });
  const result = clearRunningLocalFieldLogs(storage);
  assert.equal(result.ok, true);
  assert.equal(result.clearedRuns, 0);
  assert.equal(storage.raw(chunkKey(staleId)), undefined);
});
