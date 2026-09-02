import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RUNNING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS,
  RUNNING_LOCAL_FIELD_LOG_MAX_CHUNK_BYTES,
  RUNNING_LOCAL_FIELD_LOG_MAX_CHUNKS_PER_RUN,
  RUNNING_LOCAL_FIELD_LOG_MAX_EVENTS,
  RUNNING_LOCAL_FIELD_LOG_CHUNK_PREFIX,
  RUNNING_LOCAL_FIELD_LOG_CHUNK_SAMPLES,
  RUNNING_LOCAL_FIELD_LOG_KEY,
  RUNNING_LOCAL_FIELD_LOG_MAX_RUNS,
  RUNNING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RUN,
  RUNNING_LOCAL_FIELD_LOG_MAX_TOTAL_BYTES,
  RUNNING_LOCAL_FIELD_LOG_REPLAY_MAX_LINE_BYTES,
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

function memoryStorage() {
  const values = new Map();
  const writes = [];
  const removes = [];
  let failIndexWrites = 0;
  const silent = new Set();
  const silentRemoves = new Set();
  const getFailures = new Map();
  const setFailures = new Map();
  const removeFailures = new Map();
  const shouldFail = (failures, key) => {
    const exact = failures.get(key) || 0;
    const wildcard = failures.get('*') || 0;
    const match = exact > 0 ? key : wildcard > 0 ? '*' : '';
    if (!match) return false;
    failures.set(match, failures.get(match) - 1);
    return true;
  };
  return {
    getStorageSync(key) {
      if (shouldFail(getFailures, key)) throw new Error('read failed');
      return clone(values.get(key));
    },
    setStorageSync(key, value) {
      writes.push(key);
      if (key === RUNNING_LOCAL_FIELD_LOG_KEY && failIndexWrites > 0) {
        failIndexWrites -= 1;
        throw new Error('index write failed');
      }
      if (shouldFail(setFailures, key)) throw new Error('write failed');
      if (!silent.has(key)) values.set(key, clone(value));
    },
    removeStorageSync(key) {
      removes.push(key);
      if (shouldFail(removeFailures, key)) throw new Error('remove failed');
      if (!silentRemoves.has(key)) values.delete(key);
    },
    raw(key) { return clone(values.get(key)); },
    put(key, value) { values.set(key, clone(value)); },
    keys() { return [...values.keys()]; },
    writes() { return writes.slice(); },
    removes() { return removes.slice(); },
    failNextIndexWrite() { failIndexWrites += 1; },
    silence(key) { silent.add(key); },
    silenceRemove(key) { silentRemoves.add(key); },
    failNextGet(key = '*', times = 1) {
      getFailures.set(key, (getFailures.get(key) || 0) + times);
    },
    failNextSet(key = '*', times = 1) {
      setFailures.set(key, (setFailures.get(key) || 0) + times);
    },
    failNextRemove(key = '*', times = 1) {
      removeFailures.set(key, (removeFailures.get(key) || 0) + times);
    },
  };
}

function runId(offset = 0) {
  return createRunningLocalFieldLogId(START + offset, 'field' + String(offset).padStart(6, '0'));
}

function sample(index, overrides = {}) {
  return {
    captured_at_ms: START + index * RUNNING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS,
    elapsed_ms: index * RUNNING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS,
    bpm: 142,
    cadence_spm: 174,
    candidate_cadence_spm: 176,
    speed_mps: 3.1,
    pace_sec_per_km: 322.58,
    distance_m: index * 15.5,
    steps_total: index * 15,
    motion_quality: 0.91,
    artifact_confidence: 0.03,
    gyro_rms: 0.12,
    stationary: false,
    distance_source: 'imu',
    cadence_source: 'imu',
    rsc_live: false,
    hr_live: true,
    ble_state: 'connected',
    page_visible: true,
    paused: false,
    accel_age_ms: 45,
    sensor_generation: 1,
    trigger: 'ticker',
    ...overrides,
  };
}

function rehashChunk(raw) {
  const core = {
    v: raw.v,
    r: raw.r,
    i: raw.i,
    b: raw.b,
    s: raw.s,
  };
  return { ...core, h: runningLocalFieldLogChecksum(JSON.stringify(core)) };
}

function inflateFinishedRunForCapacity(storage, id, chunkCount = 32) {
  const index = storage.raw(RUNNING_LOCAL_FIELD_LOG_KEY);
  const run = index.runs.find((item) => item.run_id === id);
  run.sample_count = chunkCount * RUNNING_LOCAL_FIELD_LOG_CHUNK_SAMPLES;
  run.chunk_count = chunkCount;
  run.chunk_bytes = Array(chunkCount).fill(RUNNING_LOCAL_FIELD_LOG_MAX_CHUNK_BYTES);
  run.last_sample_at_ms = run.started_at_ms + run.sample_count * 5000;
  run.last_elapsed_ms = run.sample_count * 5000;
  storage.put(RUNNING_LOCAL_FIELD_LOG_KEY, index);
}

test('UTF-8、ID、样本、事件、摘要和整场归一化覆盖全部安全边界', () => {
  assert.equal(runningLocalFieldLogUtf8Bytes(null), 0);
  assert.equal(runningLocalFieldLogUtf8Bytes('A¢中😀'), 10);
  assert.equal(
    runningLocalFieldLogUtf8Bytes('\ud800'),
    3,
    '孤立代理项也按三字节安全计量',
  );
  assert.equal(runningLocalFieldLogChecksum('A¢中😀').length, 8);
  assert.notEqual(runningLocalFieldLogChecksum('A¢中😀'), runningLocalFieldLogChecksum('A'));
  assert.equal(createRunningLocalFieldLogId(0, 'bad'), '');
  assert.match(createRunningLocalFieldLogId(START), /^run-[a-z0-9]+-[a-z0-9]{6,20}$/);
  assert.equal(runningLocalFieldLogChunkKey('bad', 0), '');
  assert.equal(runningLocalFieldLogChunkKey(runId(0), -1), '');
  assert.match(runningLocalFieldLogChunkKey(runId(0), 0), /:000$/);

  assert.equal(normalizeRunningLocalFieldSample(null), null);
  assert.equal(normalizeRunningLocalFieldSample([]), null);
  assert.equal(normalizeRunningLocalFieldSample({
    captured_at_ms: START,
    elapsed_ms: -1,
  }), null);
  const bounded = normalizeRunningLocalFieldSample(sample(1, {
    bpm: 999,
    cadence_spm: -1,
    stationary: 'false',
    distance_source: 'gps',
    cadence_source: 'watch',
    ble_state: 'broken',
    trigger: 'timer',
  }));
  assert.equal(bounded.bpm, undefined);
  assert.equal(bounded.cadence_spm, undefined);
  assert.equal(bounded.stationary, undefined);
  assert.equal(bounded.distance_source, undefined);

  assert.equal(normalizeRunningLocalFieldEvent(null), null);
  assert.equal(normalizeRunningLocalFieldEvent({
    at_ms: START,
    kind: 'private',
    name: 'bad name',
  }), null);
  assert.deepEqual(normalizeRunningLocalFieldEvent({
    at_ms: START,
    elapsed_ms: 1,
    generation: 2,
    kind: 'imu',
    name: 'MOTION_READY',
    reason: 'unsafe reason with spaces',
  }), {
    at_ms: START,
    elapsed_ms: 1,
    generation: 2,
    kind: 'imu',
    name: 'MOTION_READY',
  });
  assert.equal(normalizeRunningLocalFieldSummary(null), null);
  assert.equal(normalizeRunningLocalFieldSummary({ avg_bpm: 999 }), null);
  assert.deepEqual(normalizeRunningLocalFieldSummary({
    elapsed_ms: 10000,
    distance_m: 31.2349,
    avg_cadence_spm: 173.456,
    unknown: 'discard',
  }), {
    elapsed_ms: 10000,
    distance_m: 31.235,
    avg_cadence_spm: 173.46,
  });

  assert.equal(normalizeRunningLocalFieldRun(null), null);
  assert.equal(normalizeRunningLocalFieldRun({
    run_id: runId(1),
    started_at_ms: START,
    status: 'completed',
  }), null);
  const normalizedRun = normalizeRunningLocalFieldRun({
    runId: runId(2),
    startedAtMs: START,
    endedAtMs: START + 20000,
    status: 'completed',
    samples: [
      sample(2),
      sample(1),
      sample(1, { captured_at_ms: START + 6000 }),
      sample(3, { captured_at_ms: START + 25000 }),
      { ...sample(0), captured_at_ms: START - 1 },
    ],
    events: [
      { at_ms: START + 2, kind: 'ble', name: 'CONNECTED' },
      { at_ms: START + 1, kind: 'ble', name: 'SCANNING' },
      { at_ms: START + 1, kind: 'ble', name: 'SCANNING' },
      { at_ms: START - 1, kind: 'ble', name: 'TOO_EARLY' },
    ],
    dropped_count: -1,
    storage_status: 'unknown',
  });
  assert.equal(normalizedRun.samples.length, 2);
  assert.deepEqual(normalizedRun.events.map((event) => event.name), [
    'SCANNING', 'CONNECTED',
  ]);
  assert.equal(normalizedRun.dropped_count, 0);
  assert.equal(normalizedRun.storage_status, 'ok');
});

test('整场 store 归一化会剥离损坏项、重复 ID 并只保留最近完成场', () => {
  const blankCases = [null, [], {}, { schema_version: 2, runs: [] }];
  for (const value of blankCases) {
    assert.deepEqual(normalizeRunningLocalFieldStore(value), {
      schema_version: RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
      runs: [],
    });
  }
  const completed = (offset) => ({
    run_id: runId(offset),
    started_at_ms: START + offset * 60000,
    ended_at_ms: START + offset * 60000 + 10000,
    status: 'completed',
    samples: [],
    events: [],
  });
  const store = normalizeRunningLocalFieldStore({
    schema_version: RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    runs: [
      completed(1), completed(3), completed(2), completed(3), { broken: true },
    ],
  });
  assert.deepEqual(store.runs.map((run) => run.run_id), [runId(3), runId(2)]);
});

test('运行样本严格剥离位置、原始传感器、身份、凭据和文案', () => {
  const normalized = normalizeRunningLocalFieldSample(sample(1, {
    latitude: 31.2,
    longitude: 121.4,
    gps: { speed: 3 },
    raw_imu: [{ x: 1, y: 2, z: 3 }],
    accelerometer: { x: 1, y: 2, z: 3 },
    gyroscope: [1, 2, 3],
    token: 'secret-token',
    device_id: 'private-device',
    account_id: 'private-account',
    text: 'spoken words',
  }));
  assert.equal(normalized.cadence_spm, 174);
  const serialized = JSON.stringify(normalized);
  for (const forbidden of [
    'latitude', 'longitude', 'gps', 'raw_imu', 'accelerometer',
    'gyroscope', 'token', 'device', 'account', 'spoken', 'secret',
  ]) assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'));

  const event = normalizeRunningLocalFieldEvent({
    at_ms: START + 1000,
    elapsed_ms: 1000,
    kind: 'ble',
    name: 'HR_RECONNECTED',
    reason: 'watchdog',
    error: 'raw native error',
    deviceName: 'Private Garmin',
    text: 'speak this',
  });
  assert.deepEqual(event, {
    at_ms: START + 1000,
    elapsed_ms: 1000,
    kind: 'ble',
    name: 'HR_RECONNECTED',
    reason: 'watchdog',
  });
});

test('5秒采样、60点分片、写后读回和时间窗 no-op 均成立', () => {
  const storage = memoryStorage();
  const id = runId(1);
  assert.equal(beginRunningLocalFieldLog(storage, {
    runId: id,
    startedAtMs: START,
  }).ok, true);
  const values = Array.from({ length: 65 }, (_, index) => sample(index + 1));
  const appended = appendRunningLocalFieldSamples(storage, id, values);
  assert.equal(appended.ok, true);
  assert.equal(appended.appended, 65);
  const metadata = readRunningLocalFieldLogIndexResult(storage).index.runs[0];
  assert.equal(metadata.chunk_count, 2);
  assert.equal(metadata.sample_count, 65);
  const chunks = storage.keys().filter(
    (key) => key.startsWith(RUNNING_LOCAL_FIELD_LOG_CHUNK_PREFIX + id),
  );
  assert.equal(chunks.length, 2);
  assert.equal(storage.raw(chunks[0]).s.length, RUNNING_LOCAL_FIELD_LOG_CHUNK_SAMPLES);
  const duplicate = appendRunningLocalFieldSamples(storage, id, sample(65, {
    captured_at_ms: sample(65).captured_at_ms + 1000,
  }));
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.status, RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE);
  assert.equal(duplicate.appended, 0);
  assert.ok(storage.writes().includes(RUNNING_LOCAL_FIELD_LOG_KEY));
});

test('chunk 已写而 index 失败时，下次 append 会恢复 orphan tail', () => {
  const storage = memoryStorage();
  const id = runId(2);
  beginRunningLocalFieldLog(storage, { runId: id, startedAtMs: START });
  storage.failNextIndexWrite();
  const first = appendRunningLocalFieldSamples(storage, id, sample(1));
  assert.equal(first.ok, false);
  assert.equal(first.orphanChunkRecoverable, true);
  assert.ok(storage.keys().some(
    (key) => key.startsWith(RUNNING_LOCAL_FIELD_LOG_CHUNK_PREFIX + id),
  ));
  const second = appendRunningLocalFieldSamples(storage, id, sample(2));
  assert.equal(second.ok, true);
  const restored = readRunningLocalFieldLog(storage, id);
  assert.equal(restored.samples.length, 2);
  assert.equal(restored.samples[0].elapsed_ms, 5000);
  assert.equal(restored.samples[1].elapsed_ms, 10000);
});

test('8小时和12小时马拉松档案均完整保留且不超过2MiB', () => {
  const eightHourStorage = memoryStorage();
  const eightHourId = runId(8);
  beginRunningLocalFieldLog(eightHourStorage, {
    runId: eightHourId,
    startedAtMs: START,
  });
  const eightHourCount = 8 * 60 * 60 * 1000
    / RUNNING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS;
  const eightHour = appendRunningLocalFieldSamples(
    eightHourStorage,
    eightHourId,
    Array.from({ length: eightHourCount }, (_, index) => sample(index + 1, {
      bpm: undefined,
      candidate_cadence_spm: undefined,
      artifact_confidence: undefined,
      gyro_rms: undefined,
      accel_age_ms: undefined,
    })),
  );
  assert.equal(eightHour.ok, true);
  assert.equal(eightHour.appended, eightHourCount);
  assert.equal(readRunningLocalFieldLog(eightHourStorage, eightHourId).samples.length,
    eightHourCount);
  assert.ok(readRunningLocalFieldLogsResult(eightHourStorage).storageBytes
    <= RUNNING_LOCAL_FIELD_LOG_MAX_TOTAL_BYTES);

  const twelveHourStorage = memoryStorage();
  const twelveHourId = runId(12);
  beginRunningLocalFieldLog(twelveHourStorage, {
    runId: twelveHourId,
    startedAtMs: START,
  });
  const twelveHour = appendRunningLocalFieldSamples(
    twelveHourStorage,
    twelveHourId,
    Array.from(
      { length: RUNNING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RUN - 1 },
      (_, index) => sample(index + 1),
    ),
  );
  assert.equal(twelveHour.ok, true);
  assert.equal(
    twelveHour.appended,
    RUNNING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RUN - 1,
  );
  const overflow = appendRunningLocalFieldSamples(
    twelveHourStorage,
    twelveHourId,
    [
      sample(RUNNING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RUN),
      sample(RUNNING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RUN + 1),
    ],
  );
  assert.equal(overflow.ok, false);
  assert.equal(overflow.status, RUNNING_LOCAL_FIELD_LOG_STATUS.CAPACITY_EXCEEDED);
  assert.equal(overflow.appended, 1);
  const assembled = readRunningLocalFieldLogsResult(twelveHourStorage);
  assert.equal(assembled.store.runs[0].samples.length,
    RUNNING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RUN);
  assert.ok(assembled.storageBytes <= RUNNING_LOCAL_FIELD_LOG_MAX_TOTAL_BYTES);
  assert.equal(readRunningLocalFieldLogIndexResult(twelveHourStorage)
    .index.runs[0].dropped_count, 1);
});

test('最多保留两场且永不为了新场删除 active 场', () => {
  const storage = memoryStorage();
  for (let index = 0; index < RUNNING_LOCAL_FIELD_LOG_MAX_RUNS + 1; index += 1) {
    const startedAtMs = START + index * 60000;
    const id = createRunningLocalFieldLogId(startedAtMs, 'retain' + index + 'xxxxxx');
    beginRunningLocalFieldLog(storage, { runId: id, startedAtMs });
    appendRunningLocalFieldSamples(storage, id, {
      ...sample(1),
      captured_at_ms: startedAtMs + 5000,
    });
    finishRunningLocalFieldLog(storage, id, { endedAtMs: startedAtMs + 10000 });
  }
  const index = readRunningLocalFieldLogIndexResult(storage).index;
  assert.equal(index.runs.length, RUNNING_LOCAL_FIELD_LOG_MAX_RUNS);
  assert.ok(index.runs.every((run) => run.status === 'completed'));

  const activeId = createRunningLocalFieldLogId(START + 999000, 'activekeeper');
  beginRunningLocalFieldLog(storage, { runId: activeId, startedAtMs: START + 999000 });
  const anotherId = createRunningLocalFieldLogId(START + 1000000, 'secondactive');
  beginRunningLocalFieldLog(storage, { runId: anotherId, startedAtMs: START + 1000000 });
  const after = readRunningLocalFieldLogIndexResult(storage).index;
  assert.ok(after.runs.some((run) => run.run_id === activeId && run.status === 'active'));
  assert.ok(after.runs.some((run) => run.run_id === anotherId && run.status === 'active'));
  const thirdActiveId = createRunningLocalFieldLogId(
    START + 1001000,
    'thirdactive',
  );
  const blocked = beginRunningLocalFieldLog(storage, {
    runId: thirdActiveId,
    startedAtMs: START + 1001000,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, RUNNING_LOCAL_FIELD_LOG_STATUS.CAPACITY_EXCEEDED);
  assert.equal(readRunningLocalFieldLogIndexResult(storage).index.runs.length, 2);
});

test('索引读取、首次写入、幂等 begin 和损坏索引均返回明确状态', () => {
  assert.equal(
    readRunningLocalFieldLogIndexResult(null).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE,
  );
  const readBroken = {
    getStorageSync() { throw new Error('read failed'); },
    setStorageSync() { throw new Error('must not write'); },
  };
  assert.equal(
    readRunningLocalFieldLogIndexResult(readBroken).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.READ_FAILED,
  );

  const corrupt = memoryStorage();
  corrupt.put(RUNNING_LOCAL_FIELD_LOG_KEY, { schema_version: 1, runs: [] });
  assert.equal(
    readRunningLocalFieldLogIndexResult(corrupt).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE,
  );

  const getOnly = { getStorageSync() { return undefined; } };
  assert.equal(beginRunningLocalFieldLog(getOnly, {
    runId: runId(100), startedAtMs: START,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE);

  const writeBroken = memoryStorage();
  writeBroken.failNextSet(RUNNING_LOCAL_FIELD_LOG_KEY);
  assert.equal(beginRunningLocalFieldLog(writeBroken, {
    runId: runId(101), startedAtMs: START,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.WRITE_FAILED);

  const storage = memoryStorage();
  const id = runId(102);
  assert.equal(beginRunningLocalFieldLog(storage, {
    runId: id, startedAtMs: START,
  }).ok, true);
  assert.equal(beginRunningLocalFieldLog(storage, {
    runId: id, startedAtMs: START,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE);
  assert.equal(beginRunningLocalFieldLog(storage, {
    runId: id, startedAtMs: START + 1,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT);
  assert.equal(beginRunningLocalFieldLog(storage, null).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT);
});

test('严格索引会拒绝分片计数、尾样本与 cleanup 关系损坏', () => {
  const makeValid = () => {
    const storage = memoryStorage();
    const id = runId(110);
    beginRunningLocalFieldLog(storage, { runId: id, startedAtMs: START });
    appendRunningLocalFieldSamples(storage, id, sample(1));
    return { storage, id, index: storage.raw(RUNNING_LOCAL_FIELD_LOG_KEY) };
  };

  {
    const { storage, index } = makeValid();
    index.runs[0].chunk_count = 2;
    index.runs[0].chunk_bytes.push(1);
    storage.put(RUNNING_LOCAL_FIELD_LOG_KEY, index);
    assert.equal(readRunningLocalFieldLogIndexResult(storage).status,
      RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE);
  }
  {
    const { storage, index } = makeValid();
    delete index.runs[0].last_sample_at_ms;
    storage.put(RUNNING_LOCAL_FIELD_LOG_KEY, index);
    assert.equal(readRunningLocalFieldLogIndexResult(storage).status,
      RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE);
  }
  {
    const { storage, id, index } = makeValid();
    index.pending_cleanup = [{
      run_id: id,
      chunk_count: 1,
      chunk_bytes: [index.runs[0].chunk_bytes[0]],
    }];
    storage.put(RUNNING_LOCAL_FIELD_LOG_KEY, index);
    assert.equal(readRunningLocalFieldLogIndexResult(storage).status,
      RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE);
  }
});

test('append 的非法输入、缺场、已结束场与索引读取失败均安全返回', () => {
  const storage = memoryStorage();
  const id = runId(120);
  assert.equal(appendRunningLocalFieldSamples(storage, 'bad', sample(1)).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT);
  assert.equal(appendRunningLocalFieldSamples(storage, id, null).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT);
  assert.equal(appendRunningLocalFieldSamples(storage, id, sample(1)).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.RUN_NOT_FOUND);

  beginRunningLocalFieldLog(storage, { runId: id, startedAtMs: START });
  finishRunningLocalFieldLog(storage, id, { endedAtMs: START + 1000 });
  assert.equal(appendRunningLocalFieldSamples(storage, id, sample(1)).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.RUN_FINISHED);

  const readBroken = memoryStorage();
  readBroken.failNextGet(RUNNING_LOCAL_FIELD_LOG_KEY);
  assert.equal(appendRunningLocalFieldSamples(readBroken, runId(121), sample(1)).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.READ_FAILED);
});

test('缺失、损坏、读异常和非法 orphan 分片不会伪装成可继续日志', () => {
  const missing = memoryStorage();
  const missingId = runId(130);
  beginRunningLocalFieldLog(missing, { runId: missingId, startedAtMs: START });
  appendRunningLocalFieldSamples(missing, missingId, sample(1));
  missing.removeStorageSync(runningLocalFieldLogChunkKey(missingId, 0));
  assert.equal(appendRunningLocalFieldSamples(missing, missingId, sample(2)).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.PARTIAL_STORAGE);

  const corrupt = memoryStorage();
  const corruptId = runId(131);
  beginRunningLocalFieldLog(corrupt, { runId: corruptId, startedAtMs: START });
  appendRunningLocalFieldSamples(corrupt, corruptId, sample(1));
  const corruptKey = runningLocalFieldLogChunkKey(corruptId, 0);
  corrupt.put(corruptKey, { ...corrupt.raw(corruptKey), h: '00000000' });
  assert.equal(appendRunningLocalFieldSamples(corrupt, corruptId, sample(2)).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE);

  const readBroken = memoryStorage();
  const readBrokenId = runId(132);
  beginRunningLocalFieldLog(readBroken, {
    runId: readBrokenId, startedAtMs: START,
  });
  appendRunningLocalFieldSamples(readBroken, readBrokenId, sample(1));
  readBroken.failNextGet(runningLocalFieldLogChunkKey(readBrokenId, 0));
  assert.equal(appendRunningLocalFieldSamples(
    readBroken, readBrokenId, sample(2),
  ).status, RUNNING_LOCAL_FIELD_LOG_STATUS.READ_FAILED);

  const emptyTailReadBroken = memoryStorage();
  const emptyId = runId(133);
  beginRunningLocalFieldLog(emptyTailReadBroken, {
    runId: emptyId, startedAtMs: START,
  });
  emptyTailReadBroken.failNextGet(runningLocalFieldLogChunkKey(emptyId, 0));
  assert.equal(appendRunningLocalFieldSamples(
    emptyTailReadBroken, emptyId, sample(1),
  ).status, RUNNING_LOCAL_FIELD_LOG_STATUS.READ_FAILED);

  const beforeStart = memoryStorage();
  const beforeId = runId(134);
  beginRunningLocalFieldLog(beforeStart, { runId: beforeId, startedAtMs: START });
  appendRunningLocalFieldSamples(beforeStart, beforeId, sample(1));
  const beforeKey = runningLocalFieldLogChunkKey(beforeId, 0);
  const raw = beforeStart.raw(beforeKey);
  raw.b = START - 5000;
  beforeStart.put(beforeKey, rehashChunk(raw));
  assert.equal(appendRunningLocalFieldSamples(beforeStart, beforeId, sample(2)).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE);

  const partialTail = memoryStorage();
  const partialId = runId(135);
  beginRunningLocalFieldLog(partialTail, { runId: partialId, startedAtMs: START });
  appendRunningLocalFieldSamples(partialTail, partialId, sample(1));
  const firstKey = runningLocalFieldLogChunkKey(partialId, 0);
  const orphan = partialTail.raw(firstKey);
  orphan.i = 1;
  orphan.b = START + 10000;
  partialTail.put(runningLocalFieldLogChunkKey(partialId, 1), rehashChunk(orphan));
  assert.equal(appendRunningLocalFieldSamples(partialTail, partialId, sample(2)).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE);
});

test('分片写异常、静默写和缺少写 API 都会记 dropped 且不抛出', () => {
  const writeBroken = memoryStorage();
  const writeId = runId(140);
  beginRunningLocalFieldLog(writeBroken, { runId: writeId, startedAtMs: START });
  writeBroken.failNextSet(runningLocalFieldLogChunkKey(writeId, 0));
  const failed = appendRunningLocalFieldSamples(writeBroken, writeId, sample(1));
  assert.equal(failed.status, RUNNING_LOCAL_FIELD_LOG_STATUS.WRITE_FAILED);
  assert.equal(failed.dropped, 1);

  const silent = memoryStorage();
  const silentId = runId(141);
  beginRunningLocalFieldLog(silent, { runId: silentId, startedAtMs: START });
  silent.silence(runningLocalFieldLogChunkKey(silentId, 0));
  assert.equal(appendRunningLocalFieldSamples(silent, silentId, sample(1)).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.VERIFICATION_FAILED);

  const base = memoryStorage();
  const unavailableId = runId(142);
  beginRunningLocalFieldLog(base, { runId: unavailableId, startedAtMs: START });
  const noWriter = {
    getStorageSync: base.getStorageSync,
    removeStorageSync: base.removeStorageSync,
  };
  assert.equal(appendRunningLocalFieldSamples(
    noWriter, unavailableId, sample(1),
  ).status, RUNNING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE);
});

test('总容量会先淘汰旧完成场并清理；清理失败则保留证据并拒绝新样本', () => {
  const makeCapacityPair = (offset) => {
    const storage = memoryStorage();
    const victimId = runId(offset);
    const activeId = runId(offset + 1);
    beginRunningLocalFieldLog(storage, { runId: victimId, startedAtMs: START });
    appendRunningLocalFieldSamples(storage, victimId, sample(1));
    finishRunningLocalFieldLog(storage, victimId, { endedAtMs: START + 10000 });
    beginRunningLocalFieldLog(storage, {
      runId: activeId,
      startedAtMs: START + 100000,
    });
    inflateFinishedRunForCapacity(storage, victimId);
    return { storage, victimId, activeId };
  };

  const successful = makeCapacityPair(150);
  const appended = appendRunningLocalFieldSamples(successful.storage, successful.activeId, {
    ...sample(1), captured_at_ms: START + 105000,
  });
  assert.equal(appended.ok, true);
  assert.equal(appended.appended, 1);
  assert.equal(readRunningLocalFieldLogIndexResult(successful.storage)
    .index.runs.some((run) => run.run_id === successful.victimId), false);

  const blocked = makeCapacityPair(160);
  blocked.storage.failNextRemove('*', RUNNING_LOCAL_FIELD_LOG_MAX_CHUNKS_PER_RUN);
  const rejected = appendRunningLocalFieldSamples(blocked.storage, blocked.activeId, {
    ...sample(1), captured_at_ms: START + 105000,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, RUNNING_LOCAL_FIELD_LOG_STATUS.CAPACITY_EXCEEDED);
  assert.equal(rejected.droppedPersisted, true);
  assert.equal(readRunningLocalFieldLogIndexResult(blocked.storage)
    .index.pending_cleanup.length, 1);
});

test('新场元数据已提交时，旧分片延迟清理失败不会阻止开始记录', () => {
  const storage = memoryStorage();
  for (let index = 0; index < 2; index += 1) {
    const id = runId(170 + index);
    const startedAtMs = START + index * 60000;
    beginRunningLocalFieldLog(storage, { runId: id, startedAtMs });
    appendRunningLocalFieldSamples(storage, id, {
      ...sample(1), captured_at_ms: startedAtMs + 5000,
    });
    finishRunningLocalFieldLog(storage, id, { endedAtMs: startedAtMs + 10000 });
  }
  storage.failNextRemove('*');
  const next = beginRunningLocalFieldLog(storage, {
    runId: runId(172),
    startedAtMs: START + 120000,
  });
  assert.equal(next.ok, true);
  assert.equal(next.cleanupPending, 1);
  assert.equal(next.index.pending_cleanup.length, 1);
});

test('遗留 active 场恢复为 aborted 并保留最后已知摘要', () => {
  const storage = memoryStorage();
  const id = runId(20);
  beginRunningLocalFieldLog(storage, { runId: id, startedAtMs: START });
  appendRunningLocalFieldSamples(storage, id, [sample(1), sample(2)]);
  const recovered = recoverActiveRunningLocalFieldLogs(storage, {
    endedAtMs: START + 20000,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered, 1);
  assert.deepEqual(recovered.runIds, [id]);
  const run = readRunningLocalFieldLog(storage, id);
  assert.equal(run.status, 'aborted');
  assert.equal(run.summary.distance_m, sample(2).distance_m);
  assert.equal(run.summary.steps, sample(2).steps_total);
  assert.ok(run.events.some((event) => event.name === 'RECOVERED_ABORT'));
  assert.ok(run.events.some((event) => event.name === 'RUN_ABORTED'));
});

test('上传 ACK 事件不删除本地档案，digest 与 replay 保持可校验', () => {
  const storage = memoryStorage();
  const id = runId(30);
  beginRunningLocalFieldLog(storage, { runId: id, startedAtMs: START });
  appendRunningLocalFieldSamples(storage, id, [sample(1), sample(2)]);
  appendRunningLocalFieldEvent(storage, id, {
    at_ms: START + 11000,
    elapsed_ms: 11000,
    kind: 'upload',
    name: 'SUMMARY_ACKED',
    reason: 'server_ack',
  });
  finishRunningLocalFieldLog(storage, id, {
    endedAtMs: START + 12000,
    summary: {
      elapsed_ms: 12000,
      distance_m: 31,
      avg_pace_sec_per_km: 323,
      avg_cadence_spm: 174,
      avg_bpm: 142,
      max_bpm: 151,
      steps: 30,
      sample_count: 2,
    },
  });
  const run = readLatestRunningLocalFieldLog(storage);
  assert.equal(run.samples.length, 2);
  assert.ok(run.events.some((event) => event.name === 'SUMMARY_ACKED'));
  const digest = buildLatestRunningLocalFieldLogDigest(run);
  assert.equal(digest.run_id, id);
  assert.equal(digest.sample_count, 2);
  assert.match(digest.checksum, /^[0-9a-f]{8}$/);
  const lines = buildRunningLocalFieldLogReplayLines(run);
  assert.ok(lines.length >= 3);
  assert.ok(lines.every((line) => runningLocalFieldLogUtf8Bytes(line)
    < RUNNING_LOCAL_FIELD_LOG_REPLAY_MAX_LINE_BYTES));
});

test('长跑重复 RSC 事件满环后仍保留首个里程碑与最近故障时间线', () => {
  const noiseNames = [
    'RSC_PROBE_RETRY',
    'RSC_UNAVAILABLE',
    'RSC_SERVICE_FOUND',
    'RSC_SILENT',
  ];
  const events = [{
    at_ms: START,
    elapsed_ms: 0,
    kind: 'lifecycle',
    name: 'RUN_STARTED',
    reason: 'user',
  }];
  for (let index = 0; index < 1200; index += 1) {
    events.push({
      at_ms: START + 1000 + index * 5000,
      elapsed_ms: 1000 + index * 5000,
      kind: 'ble',
      name: noiseNames[index % noiseNames.length],
      reason: 'retry',
    });
  }
  events.push(
    {
      at_ms: START + 7000000,
      elapsed_ms: 7000000,
      kind: 'lifecycle',
      name: 'SUMMARY_ENTERED',
      reason: 'summary',
    },
    {
      at_ms: START + 7000001,
      elapsed_ms: 7000001,
      kind: 'lifecycle',
      name: 'RUN_FINISHED',
      reason: 'summary',
    },
    {
      at_ms: START + 7000002,
      elapsed_ms: 7000002,
      kind: 'ble',
      name: 'BLE_TEARDOWN',
      reason: 'terminal',
    },
    {
      at_ms: START + 7000003,
      elapsed_ms: 7000003,
      kind: 'ble',
      name: 'AGENT_EXIT_REQUEST',
      reason: 'summary',
    },
  );
  const run = normalizeRunningLocalFieldRun({
    run_id: runId(31),
    started_at_ms: START,
    status: 'completed',
    ended_at_ms: START + 7000003,
    events,
  });

  assert.equal(run.events.length, RUNNING_LOCAL_FIELD_LOG_MAX_EVENTS);
  assert.equal(run.events[0].name, 'RUN_STARTED');
  for (let index = 0; index < noiseNames.length; index += 1) {
    const first = run.events.find((event) => event.name === noiseNames[index]);
    assert.equal(first.at_ms, START + 1000 + index * 5000,
      `${noiseNames[index]} 首次里程碑必须跨长跑事件风暴保留`);
    const latestExpected = [...events].reverse()
      .find((event) => event.name === noiseNames[index]);
    assert.ok(run.events.some((event) => event.name === noiseNames[index]
      && event.at_ms === latestExpected.at_ms),
    `${noiseNames[index]} 最近一次故障也必须保留`);
  }
  for (const name of [
    'SUMMARY_ENTERED', 'RUN_FINISHED', 'BLE_TEARDOWN', 'AGENT_EXIT_REQUEST',
  ]) {
    assert.ok(run.events.some((event) => event.name === name), `${name} 必须保留`);
  }
});

test('事件与结束 API 覆盖非法、缺场、重复、读失败和结束后追加保护', () => {
  const storage = memoryStorage();
  const id = runId(180);
  assert.equal(appendRunningLocalFieldEvent(storage, id, {
    at_ms: START,
    kind: 'bad',
    name: 'bad name',
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT);
  const event = {
    at_ms: START + 1000,
    elapsed_ms: 1000,
    kind: 'ble',
    name: 'HR_CONNECTED',
    reason: 'notify',
  };
  assert.equal(appendRunningLocalFieldEvent(storage, id, event).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.RUN_NOT_FOUND);

  beginRunningLocalFieldLog(storage, { runId: id, startedAtMs: START });
  assert.equal(appendRunningLocalFieldEvent(storage, id, event).ok, true);
  assert.equal(appendRunningLocalFieldEvent(storage, id, event).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE);
  assert.equal(finishRunningLocalFieldLog(storage, id, {
    endedAtMs: START - 1,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT);
  assert.equal(finishRunningLocalFieldLog(storage, id, {}).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT);
  assert.equal(finishRunningLocalFieldLog(storage, id, {
    endedAtMs: START + 2000,
  }).ok, true);
  assert.equal(appendRunningLocalFieldSamples(storage, id, sample(1)).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.RUN_FINISHED);
  assert.equal(finishRunningLocalFieldLog(storage, id, {
    endedAtMs: START + 2000,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE);

  const readBroken = memoryStorage();
  readBroken.failNextGet(RUNNING_LOCAL_FIELD_LOG_KEY);
  assert.equal(appendRunningLocalFieldEvent(readBroken, runId(181), event).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.READ_FAILED);
});

test('损坏 tuple、枚举、校验和及重复时间戳均作为 partial 暴露', () => {
  const makeChunk = () => {
    const storage = memoryStorage();
    const id = runId(190);
    beginRunningLocalFieldLog(storage, { runId: id, startedAtMs: START });
    appendRunningLocalFieldSamples(storage, id, [sample(1), sample(2)]);
    const key = runningLocalFieldLogChunkKey(id, 0);
    return { storage, id, key, raw: storage.raw(key) };
  };
  const mutations = [
    (raw) => ({ ...raw, h: 'bad' }),
    (raw) => rehashChunk({ ...raw, b: 0 }),
    (raw) => {
      raw.s[0][0] = -1;
      return rehashChunk(raw);
    },
    (raw) => {
      raw.s[0][12] = 2;
      return rehashChunk(raw);
    },
    (raw) => {
      raw.s[0][13] = 99;
      return rehashChunk(raw);
    },
    (raw) => {
      raw.s[1][0] = raw.s[0][0];
      return rehashChunk(raw);
    },
  ];
  for (const mutate of mutations) {
    const fixture = makeChunk();
    fixture.storage.put(fixture.key, mutate(fixture.raw));
    const result = readRunningLocalFieldLogsResult(fixture.storage);
    assert.equal(result.ok, false);
    assert.equal(result.status, RUNNING_LOCAL_FIELD_LOG_STATUS.PARTIAL_STORAGE);
    assert.equal(result.store.runs[0].storage_status, 'partial');
  }
});

test('读取单场、全部、latest 与 digest 在空、缺片和损坏索引时保持显式语义', () => {
  assert.equal(readRunningLocalFieldLog(null, runId(200)), null);
  assert.equal(readRunningLocalFieldLog(memoryStorage(), 'bad'), null);
  assert.equal(readRunningLocalFieldLog(memoryStorage(), runId(200)), null);
  assert.equal(readLatestRunningLocalFieldLog(memoryStorage()), null);
  assert.equal(buildLatestRunningLocalFieldLogDigest(null), null);
  assert.deepEqual(buildRunningLocalFieldLogReplayLines(null), []);

  const invalid = memoryStorage();
  invalid.put(RUNNING_LOCAL_FIELD_LOG_KEY, { broken: true });
  const invalidRead = readRunningLocalFieldLogsResult(invalid);
  assert.equal(invalidRead.ok, false);
  assert.equal(invalidRead.status, RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE);

  const storage = memoryStorage();
  const id = runId(201);
  beginRunningLocalFieldLog(storage, { runId: id, startedAtMs: START });
  appendRunningLocalFieldSamples(storage, id, [sample(1), sample(2)]);
  storage.removeStorageSync(runningLocalFieldLogChunkKey(id, 0));
  const partialAll = readRunningLocalFieldLogsResult(storage);
  assert.equal(partialAll.status, RUNNING_LOCAL_FIELD_LOG_STATUS.PARTIAL_STORAGE);
  assert.equal(partialAll.store.runs[0].samples.length, 0);
  assert.equal(readRunningLocalFieldLogs(storage).runs[0].storage_status, 'partial');
  assert.equal(readRunningLocalFieldLog(storage, id).storage_status, 'partial');

  const emptyRun = normalizeRunningLocalFieldRun({
    run_id: runId(202),
    started_at_ms: START,
    status: 'active',
    samples: [],
    events: [],
  });
  const digest = buildLatestRunningLocalFieldLogDigest({
    schema_version: RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    runs: [emptyRun],
  });
  assert.equal(digest.sample_count, 0);
  assert.equal(digest.avg_cadence_spm, null);
});

test('active 恢复覆盖非法时间、读失败、无 active 和落盘失败', () => {
  assert.equal(recoverActiveRunningLocalFieldLogs(memoryStorage(), {
    endedAtMs: 0,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT);
  const readBroken = memoryStorage();
  readBroken.failNextGet(RUNNING_LOCAL_FIELD_LOG_KEY);
  assert.equal(recoverActiveRunningLocalFieldLogs(readBroken, {
    endedAtMs: START,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.READ_FAILED);
  const empty = recoverActiveRunningLocalFieldLogs(memoryStorage(), {
    endedAtMs: START,
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.status, RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE);

  const writeBroken = memoryStorage();
  const id = runId(210);
  beginRunningLocalFieldLog(writeBroken, { runId: id, startedAtMs: START });
  writeBroken.failNextSet(RUNNING_LOCAL_FIELD_LOG_KEY, 2);
  const failed = recoverActiveRunningLocalFieldLogs(writeBroken, {
    endedAtMs: START + 10000,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.recovered, 0);
});

test('clear 对读失败、缺少 remove、分片/索引删除失败和静默删除均可诊断', () => {
  assert.equal(clearRunningLocalFieldLogs(null).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE);

  const base = memoryStorage();
  const id = runId(220);
  beginRunningLocalFieldLog(base, { runId: id, startedAtMs: START });
  appendRunningLocalFieldSamples(base, id, sample(1));
  assert.equal(clearRunningLocalFieldLogs({
    getStorageSync: base.getStorageSync,
  }).status, RUNNING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE);

  const chunkFailure = memoryStorage();
  const chunkId = runId(221);
  beginRunningLocalFieldLog(chunkFailure, { runId: chunkId, startedAtMs: START });
  appendRunningLocalFieldSamples(chunkFailure, chunkId, sample(1));
  chunkFailure.failNextRemove(runningLocalFieldLogChunkKey(chunkId, 0));
  assert.equal(clearRunningLocalFieldLogs(chunkFailure).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.VERIFICATION_FAILED);

  const indexFailure = memoryStorage();
  beginRunningLocalFieldLog(indexFailure, {
    runId: runId(222), startedAtMs: START,
  });
  indexFailure.failNextRemove(RUNNING_LOCAL_FIELD_LOG_KEY);
  assert.equal(clearRunningLocalFieldLogs(indexFailure).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.WRITE_FAILED);

  const silent = memoryStorage();
  beginRunningLocalFieldLog(silent, {
    runId: runId(223), startedAtMs: START,
  });
  silent.silenceRemove(RUNNING_LOCAL_FIELD_LOG_KEY);
  assert.equal(clearRunningLocalFieldLogs(silent).status,
    RUNNING_LOCAL_FIELD_LOG_STATUS.VERIFICATION_FAILED);
});

test('读写失败不抛，静默写失败被读回校验发现，clear 有明确返回', () => {
  assert.doesNotThrow(() => beginRunningLocalFieldLog(null, {}));
  assert.equal(beginRunningLocalFieldLog(null, {}).ok, false);

  const storage = memoryStorage();
  storage.silence(RUNNING_LOCAL_FIELD_LOG_KEY);
  const id = runId(40);
  const silent = beginRunningLocalFieldLog(storage, {
    runId: id,
    startedAtMs: START,
  });
  assert.equal(silent.ok, false);
  assert.equal(silent.status, RUNNING_LOCAL_FIELD_LOG_STATUS.VERIFICATION_FAILED);

  const valid = memoryStorage();
  beginRunningLocalFieldLog(valid, { runId: id, startedAtMs: START });
  appendRunningLocalFieldSamples(valid, id, sample(1));
  const cleared = clearRunningLocalFieldLogs(valid);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.clearedRuns, 1);
  assert.equal(readRunningLocalFieldLogIndexResult(valid).index.runs.length, 0);
  assert.equal(valid.keys().some(
    (key) => key.startsWith(RUNNING_LOCAL_FIELD_LOG_CHUNK_PREFIX),
  ), false);
});
