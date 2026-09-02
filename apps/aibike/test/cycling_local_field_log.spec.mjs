import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendCyclingLocalFieldSamples,
  appendCyclingLocalLifecycleEvent,
  appendCyclingLocalTtsEvent,
  appendCyclingLocalUploadResult,
  beginCyclingLocalFieldLog,
  buildCyclingLocalFieldLogReplayLines,
  buildLatestCyclingLocalFieldLogDigest,
  CYCLING_LOCAL_FIELD_LOG_CHUNK_PREFIX,
  CYCLING_LOCAL_FIELD_LOG_CHUNK_SAMPLES,
  CYCLING_LOCAL_FIELD_LOG_KEY,
  CYCLING_LOCAL_FIELD_LOG_MAX_RIDES,
  CYCLING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RIDE,
  CYCLING_LOCAL_FIELD_LOG_MAX_TOTAL_BYTES,
  CYCLING_LOCAL_FIELD_LOG_REPLAY_MAX_LINE_BYTES,
  CYCLING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
  CYCLING_LOCAL_FIELD_LOG_STATUS,
  cyclingLocalFieldLogChecksum,
  cyclingLocalFieldLogChunkKey,
  cyclingLocalFieldLogUtf8Bytes,
  finishCyclingLocalFieldLog,
  normalizeCyclingLocalFieldSample,
  normalizeCyclingLocalLifecycleEvent,
  normalizeCyclingLocalTtsEvent,
  normalizeCyclingLocalUploadResult,
  readCyclingLocalFieldLog,
  readCyclingLocalFieldLogIndexResult,
  readCyclingLocalFieldLogsResult,
  readLatestCyclingLocalFieldLog,
} from '../lib/cycling_local_field_log.js';
import {
  appendPendingCyclingUploadEvents,
  captureCyclingUploadSample,
  createCyclingUploadSession,
  removePendingCyclingUploadEvents,
} from '../lib/cycling_upload.js';

const START = Date.UTC(2026, 7, 14, 6, 0, 0);

function rideId(index = 0) {
  return 'ride-abcdef-' + String(index).padStart(10, '0');
}

function sample(second, overrides = {}) {
  return {
    captured_at_ms: START + second * 1000,
    elapsed_ms: second * 1000,
    moving_ms: second * 900,
    distance_coverage_ms: second * 1000,
    speed_kmh: 18.125,
    cadence_rpm: 82,
    candidate_cadence_rpm: 83,
    distance_m: second * 5,
    heart_rate_bpm: 138,
    final_speed_kmh: 18.125,
    effective_speed_kmh: 18.25,
    raw_speed_kmh: 19.2,
    stabilized_speed_kmh: 18.25,
    final_cadence_rpm: 82,
    effective_cadence_rpm: 83,
    raw_cadence_rpm: 88,
    stabilized_cadence_rpm: 83,
    imu_motion_confidence: 0.81,
    imu_cadence_confidence: 0.76,
    imu_cadence_correlation: 0.62,
    walking_confidence: 0.05,
    speed_source: 'imu',
    cadence_source: 'imu',
    distance_source: 'imu',
    distance_mode: 'cadence_model',
    speed_state: 'live',
    cadence_state: 'live',
    distance_state: 'live',
    ble_state: 'idle',
    imu_motion_state: 'moving',
    imu_cadence_state: 'estimated',
    imu_quality_state: 'trusted',
    imu_artifact: 'none',
    raw_artifact: 'none',
    imu_fresh: true,
    distance_ever_available: true,
    distance_ledger_eligible: true,
    simple_gyro_ledger_fresh: true,
    simple_gyro_method: 'low_rate_timestamp_consensus',
    simple_gyro_analysis: 'low_rate_locked',
    estimate_level: 'locked',
    estimate_usable: true,
    estimate_stabilized: true,
    walking_like: false,
    speed_profile: 'cycling_unverified',
    reconnect_count: 1,
    imu_restart_count: 2,
    gyroscope_restart_count: 1,
    orientation_restart_count: 0,
    accelerometer_age_ms: 40,
    gyroscope_age_ms: 44,
    orientation_age_ms: 80,
    accelerometer_hz: 10.1,
    gyroscope_hz: 9.8,
    orientation_hz: 8.2,
    accelerometer_frames: 300 + second,
    gyroscope_frames: 200 + second,
    orientation_frames: 100 + second,
    accelerometer_activated: true,
    gyroscope_activated: true,
    orientation_activated: true,
    accelerometer_state: 'reading',
    gyroscope_state: 'reading',
    orientation_state: 'reading',
    world_awareness_state: 'enabled',
    orientation_stable: false,
    orientation_stability_age_ms: 120,
    orientation_stability_change_count: 4,
    head_gesture: 'nod',
    head_gesture_age_ms: 240,
    head_gesture_count: 3,
    head_nod_count: 2,
    head_shake_count: 1,
    sensor_generation: 3,
    trigger: 'gyroscope',
    ...overrides,
  };
}

function memoryStorage() {
  const values = new Map();
  const writes = [];
  const removes = [];
  return {
    getStorageSync(key) {
      const value = values.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    setStorageSync(key, value) {
      writes.push(key);
      values.set(key, structuredClone(value));
    },
    removeStorageSync(key) {
      removes.push(key);
      values.delete(key);
    },
    keys() { return [...values.keys()]; },
    raw(key) { return values.get(key); },
    writes() { return writes.slice(); },
    removes() { return removes.slice(); },
    clearAudit() { writes.length = 0; removes.length = 0; },
  };
}

test('扩展派生样本白名单完整，GPS、token、设备身份与原始轴没有存储入口', () => {
  const normalized = normalizeCyclingLocalFieldSample(sample(1, {
    latitude: 31.2304,
    longitude: 121.4737,
    gps: { speed: 20 },
    path: [{ lat: 31, lon: 121 }],
    token: 'secret-token',
    authorization: 'Bearer secret',
    device_id: 'private-glasses-id',
    deviceName: 'Garmin private',
    account_id: 'private-account',
    raw_imu: [{ x: 1, y: 2, z: 3 }],
    accelerometer: { x: 1, y: 2, z: 3 },
    gyroscope: [1, 2, 3],
    quaternion: [0, 0, 0, 1],
    stabilityThreshold: { stableWindowMs: 1000, maxDriftRad: 0.1 },
    rawHeadGestureEvent: { gesture: 'nod', detail: 'secret' },
  }));
  assert.equal(normalized.distance_coverage_ms, 1000);
  assert.equal(normalized.final_cadence_rpm, 82);
  assert.equal(normalized.raw_speed_kmh, 19.2);
  assert.equal(normalized.simple_gyro_ledger_fresh, true);
  assert.equal(normalized.accelerometer_state, 'reading');
  assert.equal(normalized.world_awareness_state, 'enabled');
  assert.equal(normalized.orientation_stable, false);
  assert.equal(normalized.head_gesture, 'nod');
  assert.equal(normalized.head_nod_count, 2);
  const serialized = JSON.stringify(normalized);
  for (const forbidden of [
    'latitude', 'longitude', 'gps', 'path', 'token', 'authorization',
    'device', 'account', 'raw_imu', 'secret', 'Garmin', 'private',
    'quaternion', 'stabilityThreshold', 'rawHeadGestureEvent',
  ]) assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'));
});

test('标准采样率分析状态会保留，便于区分 6–14Hz 低帧率旁路', () => {
  const normalized = normalizeCyclingLocalFieldSample(sample(2, {
    simple_gyro_analysis: 'standard_rate',
  }));
  assert.equal(normalized.simple_gyro_analysis, 'standard_rate');
});

test('v0.3.76 短 tuple 不含 0.16 尾字段时仍可完整读取旧派生指标', () => {
  const storage = memoryStorage();
  const id = rideId(76);
  beginCyclingLocalFieldLog(storage, { rideId: id, startedAtMs: START });
  appendCyclingLocalFieldSamples(storage, id, [sample(1, {
    orientation_stability_age_ms: undefined,
    head_gesture_age_ms: undefined,
    orientation_stability_change_count: undefined,
    head_gesture_count: undefined,
    head_nod_count: undefined,
    head_shake_count: undefined,
    orientation_stable: undefined,
    world_awareness_state: undefined,
    head_gesture: undefined,
  })]);
  const raw = storage.raw(cyclingLocalFieldLogChunkKey(id, 0));
  assert.ok(raw.s[0].length > 1);
  const restored = readCyclingLocalFieldLog(storage, id).samples[0];
  assert.equal(restored.cadence_rpm, 82);
  assert.equal(restored.distance_m, 5);
  assert.equal(restored.orientation_state, 'reading');
  assert.equal(restored.world_awareness_state, undefined);
  assert.equal(restored.head_gesture, undefined);
});

test('生命周期、TTS 和上传只记有限代码，不保存文案、错误原文或 utterance ID', () => {
  const lifecycle = normalizeCyclingLocalLifecycleEvent({
    atMs: START + 1000,
    elapsedMs: 1000,
    event: 'imu_rebuild',
    reason: 'recording_transition',
    sensor: 'bundle',
    detail: 'raw failure secret',
  });
  const tts = normalizeCyclingLocalTtsEvent({
    atMs: START + 2000,
    status: 'skipped',
    cue: 'source_loss',
    result: 'deduped',
    text: '未成功 secret',
    utteranceId: 'private-id',
  });
  const upload = normalizeCyclingLocalUploadResult({
    atMs: START + 3000,
    status: 'quarantined',
    statusCode: 409,
    conflictCode: 'ride_lifecycle',
    server_error: 'belongs to another lifecycle secret',
  });
  assert.equal(lifecycle.reason, 'recording_transition');
  assert.equal(tts.result, 'deduped');
  assert.equal(upload.conflict_code, 'ride_lifecycle');
  assert.doesNotMatch(
    JSON.stringify({ lifecycle, tts, upload }),
    /raw failure|未成功|utterance|private|belongs to|secret/i,
  );
});

test('65 个样本形成 30/30/5 三片，随后只重写 active tail 和小索引', () => {
  const storage = memoryStorage();
  const id = rideId(1);
  assert.equal(beginCyclingLocalFieldLog(storage, {
    rideId: id,
    startedAtMs: START,
  }).ok, true);
  const first = appendCyclingLocalFieldSamples(
    storage,
    id,
    Array.from({ length: 65 }, (_unused, index) => sample(index + 1)),
  );
  assert.equal(first.ok, true);
  assert.equal(first.ride.sample_count, 65);
  assert.equal(first.ride.chunk_count, 3);
  assert.equal(first.ride.chunk_bytes.length, 3);
  for (const bytes of first.ride.chunk_bytes) assert.ok(bytes < 64 * 1024);

  storage.clearAudit();
  const second = appendCyclingLocalFieldSamples(
    storage,
    id,
    Array.from({ length: 5 }, (_unused, index) => sample(66 + index)),
  );
  assert.equal(second.ok, true);
  assert.equal(second.ride.sample_count, 70);
  const chunkWrites = storage.writes().filter(
    (key) => key.startsWith(CYCLING_LOCAL_FIELD_LOG_CHUNK_PREFIX),
  );
  assert.deepEqual(chunkWrites, [cyclingLocalFieldLogChunkKey(id, 2)]);
  assert.ok(storage.writes().includes(CYCLING_LOCAL_FIELD_LOG_KEY));
  assert.equal(
    storage.writes().some((key) => key === cyclingLocalFieldLogChunkKey(id, 0)
      || key === cyclingLocalFieldLogChunkKey(id, 1)),
    false,
  );

  const read = readCyclingLocalFieldLogsResult(storage);
  assert.equal(read.ok, true);
  assert.equal(read.store.rides[0].samples.length, 70);
  assert.equal(read.store.rides[0].samples[69].captured_at_ms, START + 70000);
  assert.equal(read.store.rides[0].samples[69].world_awareness_state, 'enabled');
  assert.equal(read.store.rides[0].samples[69].orientation_stable, false);
  assert.equal(read.store.rides[0].samples[69].head_gesture, 'nod');
});

test('append 根据相邻持久样本计算距离与 coverage 增量，重锚倒退不制造增量', () => {
  const storage = memoryStorage();
  const id = rideId(2);
  beginCyclingLocalFieldLog(storage, { rideId: id, startedAtMs: START });
  appendCyclingLocalFieldSamples(storage, id, [
    sample(1, { distance_m: 10, distance_coverage_ms: 1000 }),
    sample(2, { distance_m: 15.25, distance_coverage_ms: 2000 }),
    sample(3, { distance_m: 2, distance_coverage_ms: 0 }),
  ]);
  const stored = readCyclingLocalFieldLog(storage, id).samples;
  assert.equal(stored[0].distance_delta_m, undefined);
  assert.equal(stored[1].distance_delta_m, 5.25);
  assert.equal(stored[1].coverage_delta_ms, 1000);
  assert.equal(stored[2].distance_delta_m, undefined);
  assert.equal(stored[2].coverage_delta_ms, undefined);
});

test('ACK 只清 Hermes pending，本地分片和 ACK 结果继续保留', () => {
  const storage = memoryStorage();
  const session = createCyclingUploadSession(START, { random: () => 0.2 });
  const id = session.testRideId;
  beginCyclingLocalFieldLog(storage, { rideId: id, startedAtMs: START });
  const uploadEvent = captureCyclingUploadSample(session, sample(1), {
    capturedAtMs: START + 1000,
  });
  appendPendingCyclingUploadEvents(storage, [uploadEvent]);
  appendCyclingLocalFieldSamples(storage, id, [sample(1)]);
  appendCyclingLocalUploadResult(storage, id, {
    atMs: START + 2000,
    status: 'acked',
    statusCode: 200,
    acked: 1,
    pending: 0,
    finishReceived: false,
  });
  assert.deepEqual(
    removePendingCyclingUploadEvents(storage, [uploadEvent.event_id]),
    [],
  );
  const retained = readCyclingLocalFieldLog(storage, id);
  assert.equal(retained.samples.length, 1);
  assert.equal(retained.uploads.at(-1).status, 'acked');
  assert.ok(storage.raw(cyclingLocalFieldLogChunkKey(id, 0)));
});

test('最近三场按整场保留，第 4 场只淘汰最旧 completed 及其分片', () => {
  const storage = memoryStorage();
  for (let index = 0; index < CYCLING_LOCAL_FIELD_LOG_MAX_RIDES; index += 1) {
    const startedAtMs = START + index * 100000;
    const id = rideId(index);
    beginCyclingLocalFieldLog(storage, { rideId: id, startedAtMs });
    appendCyclingLocalFieldSamples(storage, id, [{
      ...sample(1),
      captured_at_ms: startedAtMs + 1000,
    }]);
    finishCyclingLocalFieldLog(storage, id, {
      endedAtMs: startedAtMs + 2000,
      summary: { elapsedMs: 2000, distanceM: 5 },
    });
  }
  assert.ok(storage.raw(cyclingLocalFieldLogChunkKey(rideId(0), 0)));
  const fourthStart = START + 400000;
  const fourth = beginCyclingLocalFieldLog(storage, {
    rideId: rideId(4),
    startedAtMs: fourthStart,
  });
  assert.equal(fourth.ok, true);
  const index = readCyclingLocalFieldLogIndexResult(storage).index;
  assert.deepEqual(
    index.rides.map((ride) => ride.ride_id),
    [rideId(4), rideId(2), rideId(1)],
  );
  assert.equal(storage.raw(cyclingLocalFieldLogChunkKey(rideId(0), 0)), undefined);
  assert.ok(storage.removes().includes(cyclingLocalFieldLogChunkKey(rideId(0), 0)));
});

test('active 场永不因最近三场门被删除', () => {
  const storage = memoryStorage();
  for (let index = 0; index < 4; index += 1) {
    beginCyclingLocalFieldLog(storage, {
      rideId: rideId(20 + index),
      startedAtMs: START + index * 100000,
    });
  }
  const index = readCyclingLocalFieldLogIndexResult(storage).index;
  assert.equal(index.rides.length, 4);
  assert.equal(index.rides.every((ride) => ride.status === 'active'), true);
});

test('每场 7200 样本与总字节均有硬门，无法写入时 dropped_count 可见', () => {
  const storage = memoryStorage();
  const id = rideId(30);
  beginCyclingLocalFieldLog(storage, { rideId: id, startedAtMs: START });
  const values = Array.from(
    { length: CYCLING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RIDE + 1 },
    (_unused, index) => sample(index + 1),
  );
  const result = appendCyclingLocalFieldSamples(storage, id, values);
  const metadata = readCyclingLocalFieldLogIndexResult(storage).index.rides[0];
  assert.ok(metadata.sample_count <= CYCLING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RIDE);
  assert.ok(metadata.dropped_count >= 1);
  assert.equal(result.ok, false);
  assert.equal(result.status, CYCLING_LOCAL_FIELD_LOG_STATUS.CAPACITY_EXCEEDED);
  const assembled = readCyclingLocalFieldLogsResult(storage);
  assert.ok(assembled.storageBytes <= CYCLING_LOCAL_FIELD_LOG_MAX_TOTAL_BYTES);
});

test('读、写和静默写失败都不抛出、不覆盖未知索引', () => {
  let writes = 0;
  const readBroken = {
    getStorageSync() { throw new Error('read failed'); },
    setStorageSync() { writes += 1; },
  };
  const readFailure = beginCyclingLocalFieldLog(readBroken, {
    rideId: rideId(40), startedAtMs: START,
  });
  assert.equal(readFailure.ok, false);
  assert.equal(readFailure.status, CYCLING_LOCAL_FIELD_LOG_STATUS.READ_FAILED);
  assert.equal(writes, 0);

  const writeBroken = {
    getStorageSync() { return undefined; },
    setStorageSync() { throw new Error('quota'); },
  };
  assert.doesNotThrow(() => beginCyclingLocalFieldLog(writeBroken, {
    rideId: rideId(41), startedAtMs: START,
  }));
  assert.equal(beginCyclingLocalFieldLog(writeBroken, {
    rideId: rideId(41), startedAtMs: START,
  }).status, CYCLING_LOCAL_FIELD_LOG_STATUS.WRITE_FAILED);

  const silent = {
    getStorageSync() { return undefined; },
    setStorageSync() {},
  };
  assert.equal(beginCyclingLocalFieldLog(silent, {
    rideId: rideId(42), startedAtMs: START,
  }).status, CYCLING_LOCAL_FIELD_LOG_STATUS.VERIFICATION_FAILED);
});

test('损坏分片显式返回 partial，绝不把缺失日志伪装成完整', () => {
  const storage = memoryStorage();
  const id = rideId(50);
  beginCyclingLocalFieldLog(storage, { rideId: id, startedAtMs: START });
  appendCyclingLocalFieldSamples(storage, id, [sample(1), sample(2)]);
  storage.setStorageSync(cyclingLocalFieldLogChunkKey(id, 0), {
    v: 1, r: id, i: 0, b: START, s: [], h: 'bad',
  });
  const read = readCyclingLocalFieldLogsResult(storage);
  assert.equal(read.ok, false);
  assert.equal(read.status, CYCLING_LOCAL_FIELD_LOG_STATUS.PARTIAL_STORAGE);
  assert.equal(read.store.rides[0].storage_status, 'partial');
});

test('latest digest 汇总距离账本、传感器、TTS 和上传结果且保持隐私边界', () => {
  const storage = memoryStorage();
  const id = rideId(60);
  beginCyclingLocalFieldLog(storage, { rideId: id, startedAtMs: START });
  appendCyclingLocalFieldSamples(storage, id, [sample(1), sample(2)]);
  appendCyclingLocalTtsEvent(storage, id, {
    atMs: START + 2500,
    status: 'skipped', cue: 'source_loss', result: 'deduped',
    text: 'secret text',
  });
  appendCyclingLocalLifecycleEvent(storage, id, {
    atMs: START + 2600,
    event: 'imu_rebuild', reason: 'recording_transition', sensor: 'bundle',
  });
  appendCyclingLocalUploadResult(storage, id, {
    atMs: START + 3000, status: 'pending', reason: 'network', pending: 3,
  });
  const digest = buildLatestCyclingLocalFieldLogDigest(
    readCyclingLocalFieldLogsResult(storage).store,
  );
  assert.equal(digest.sample_count, 2);
  assert.equal(digest.distance_delta_m, 5);
  assert.equal(digest.coverage_delta_ms, 1000);
  assert.equal(digest.simple_gyro_ledger_fresh_samples, 2);
  assert.equal(digest.last_tts.result, 'deduped');
  assert.equal(digest.last_upload.reason, 'network');
  assert.match(digest.checksum, /^[a-f0-9]{8}$/);
  assert.doesNotMatch(JSON.stringify(digest), /secret|token|device|latitude/i);
});

test('ADB replay 用 BEGIN/CHUNK/END 可重组并校验，且每行严格小于 3KB', () => {
  const storage = memoryStorage();
  const id = rideId(70);
  beginCyclingLocalFieldLog(storage, { rideId: id, startedAtMs: START });
  appendCyclingLocalFieldSamples(
    storage,
    id,
    Array.from({ length: 65 }, (_unused, index) => sample(index + 1, {
      token: 'must-not-appear',
      device_id: 'must-not-appear',
      latitude: 31.2,
      raw_imu: [{ x: 1 }],
    })),
  );
  const ride = readCyclingLocalFieldLog(storage, id);
  const lines = buildCyclingLocalFieldLogReplayLines(ride);
  assert.ok(lines.length > 3);
  assert.match(lines[0], /^AIBIKE_LOCAL_LOG\|BEGIN\|/);
  assert.match(lines.at(-1), /^AIBIKE_LOCAL_LOG\|END\|/);
  for (const line of lines) {
    assert.ok(cyclingLocalFieldLogUtf8Bytes(line)
      < CYCLING_LOCAL_FIELD_LOG_REPLAY_MAX_LINE_BYTES);
    assert.doesNotMatch(line, /must-not-appear|latitude|raw_imu|device_id|token/i);
  }
  const parse = (line) => JSON.parse(line.split('|').slice(2).join('|'));
  const begin = parse(lines[0]);
  const chunks = lines.slice(1, -1).map(parse).sort((a, b) => a.part - b.part);
  const payload = chunks.map((chunk) => chunk.data).join('');
  const end = parse(lines.at(-1));
  assert.equal(chunks.length, begin.parts);
  assert.equal(cyclingLocalFieldLogUtf8Bytes(payload), begin.bytes);
  assert.equal(cyclingLocalFieldLogChecksum(payload), begin.checksum);
  assert.equal(end.checksum, begin.checksum);
  const rebuilt = JSON.parse(payload);
  assert.equal(rebuilt.ride.ride_id, id);
  assert.equal(rebuilt.ride.samples.length, 65);
});

test('读取最新场只访问该场分片，不在页面启动时组装另外两场', () => {
  const base = memoryStorage();
  for (let index = 1; index <= 3; index += 1) {
    const id = rideId(index);
    assert.equal(beginCyclingLocalFieldLog(base, {
      rideId: id,
      startedAtMs: START + index * 100000,
    }).ok, true);
    assert.equal(appendCyclingLocalFieldSamples(base, id, [
      sample(index, {
        captured_at_ms: START + index * 100000 + 1000,
      }),
    ]).ok, true);
    assert.equal(finishCyclingLocalFieldLog(base, id, {
      endedAtMs: START + index * 100000 + 2000,
    }).ok, true);
  }
  const reads = [];
  const storage = {
    ...base,
    getStorageSync(key) {
      reads.push(key);
      return base.getStorageSync(key);
    },
  };
  const latest = readLatestCyclingLocalFieldLog(storage);
  assert.equal(latest.ride_id, rideId(3));
  assert.ok(reads.some((key) => key.includes(rideId(3))));
  assert.equal(reads.some((key) => key.includes(rideId(1))), false);
  assert.equal(reads.some((key) => key.includes(rideId(2))), false);
});

test('索引与每个分片的每次写入都经过同步读回', () => {
  const storage = memoryStorage();
  const id = rideId(80);
  beginCyclingLocalFieldLog(storage, { rideId: id, startedAtMs: START });
  appendCyclingLocalFieldSamples(storage, id, [sample(1)]);
  const rawIndex = storage.raw(CYCLING_LOCAL_FIELD_LOG_KEY);
  assert.equal(rawIndex.schema_version, CYCLING_LOCAL_FIELD_LOG_SCHEMA_VERSION);
  assert.equal(rawIndex.rides[0].sample_count, 1);
  const rawChunk = storage.raw(cyclingLocalFieldLogChunkKey(id, 0));
  assert.match(rawChunk.h, /^[a-f0-9]{8}$/);
  assert.equal(
    rawChunk.h,
    cyclingLocalFieldLogChecksum(JSON.stringify({
      v: rawChunk.v,
      r: rawChunk.r,
      i: rawChunk.i,
      b: rawChunk.b,
      s: rawChunk.s,
    })),
  );
});
