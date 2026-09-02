import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CYCLING_UPLOAD_BATCH_SIZE,
  CYCLING_UPLOAD_DEFAULT_BASE_URL,
  CYCLING_UPLOAD_MAX_EVENTS,
  CYCLING_UPLOAD_MAX_QUARANTINED_EVENTS,
  CYCLING_UPLOAD_PATH,
  PENDING_CYCLING_UPLOAD_KEY,
  QUARANTINED_CYCLING_UPLOAD_KEY,
  appendPendingCyclingUploadEvents,
  buildCyclingUploadRequest,
  captureCyclingUploadFinish,
  captureCyclingUploadSample,
  classifyCyclingUploadRejection,
  createCyclingUploadSession,
  isPermanentCyclingUploadRejection,
  isolateCyclingPoisonEvent,
  normalizeCyclingUploadEvent,
  parseCyclingUploadResponse,
  quarantineCyclingUploadEvent,
  quarantineCyclingUploadEvents,
  readPendingCyclingUploadEvents,
  readPendingCyclingUploadEventsResult,
  readQuarantinedCyclingUploadEvents,
  removePendingCyclingUploadEvents,
  selectCyclingUploadBatch,
  writePendingCyclingUploadEvents,
} from '../lib/cycling_upload.js';

const START = 1785050000000;

function storage() {
  const map = new Map();
  return {
    map,
    getStorageSync(key) { return map.get(key); },
    setStorageSync(key, value) { map.set(key, value); },
    removeStorageSync(key) { map.delete(key); },
  };
}

function session() {
  return createCyclingUploadSession(START, { random: () => 0.25 });
}

function events(count, options = {}) {
  const stream = session();
  const result = [];
  for (let index = 1; index <= count; index += 1) {
    result.push(captureCyclingUploadSample(stream, {
      speed_kmh: 24 + index / 100,
      cadence_rpm: 88,
      distance_m: index * 6.5,
      speed_source: 'gps',
      cadence_source: 'imu',
      speed_state: 'live',
      cadence_state: 'live',
    }, {
      capturedAtMs: START + index * 1000,
      force: options.force === true,
    }));
  }
  return result;
}

test('短期 test_ride_id 随机生成且不依赖绑定身份', () => {
  const first = createCyclingUploadSession(START, { random: () => 0.1 });
  const second = createCyclingUploadSession(START, { random: () => 0.2 });
  assert.match(first.testRideId, /^ride-[a-z0-9]{6,10}-[a-z0-9]{10,16}$/);
  assert.notEqual(first.testRideId, second.testRideId);
  assert.deepEqual(Object.keys(first), [
    'testRideId',
    'startedAtMs',
    'nextSeq',
    'lastCapturedAtMs',
    'finished',
  ]);
});

test('1 Hz 样本只保留派生指标和质量白名单', () => {
  const stream = session();
  const first = captureCyclingUploadSample(stream, {
    speed_kmh: 23.45678,
    cadence_rpm: 87.654,
    candidate_cadence_rpm: 89.123,
    distance_m: 12.34567,
    heart_rate_bpm: 142,
    power_w: 201.26,
    speed_source: 'imu',
    cadence_source: 'imu',
    distance_source: 'imu',
    distance_mode: 'cadence_model',
    heart_rate_source: 'hrs',
    speed_state: 'live',
    cadence_state: 'live',
    distance_state: 'live',
    ble_state: 'connected',
    reconnect_count: 2,
    imu_motion_state: 'moving',
    imu_cadence_state: 'estimated',
    imu_quality_state: 'trusted',
    imu_artifact: 'none',
    imu_fresh: true,
    gps_quality: 0.91234,
    gps_accuracy_m: 6.25,
    latitude: 31.2,
    longitude: 121.4,
    coordinates: [121.4, 31.2],
    raw_acceleration: [1, 2, 3],
    raw_imu: { x: 1, y: 2, z: 3 },
    raw_ble: [1, 2, 3],
    ble_device_id: 'AA:BB:CC:DD',
    device_name: 'Garmin Secret',
    glasses_serial: 'SERIAL',
    device_id: 'device-secret',
    aiui_id: 'public-id',
    account: 'rider@example.com',
    token: 'credential-secret',
    Authorization: 'Bearer credential-secret',
  }, { capturedAtMs: START + 1000 });
  const tooSoon = captureCyclingUploadSample(
    stream,
    { cadence_rpm: 90 },
    { capturedAtMs: START + 1500 },
  );
  const second = captureCyclingUploadSample(
    stream,
    { cadence_rpm: 90 },
    { capturedAtMs: START + 2000 },
  );

  assert.equal(first.seq, 1);
  assert.equal(tooSoon, null);
  assert.equal(second.seq, 2);
  assert.equal(first.speed_kmh, 23.457);
  assert.equal(first.cadence_rpm, 87.65);
  assert.equal(first.candidate_cadence_rpm, 89.12);
  assert.equal(first.gps_quality, undefined);
  assert.equal(first.gps_accuracy_m, undefined);
  assert.equal(first.test_mode, true);
  const encoded = JSON.stringify(first);
  for (const secret of [
    'latitude', 'longitude', 'coordinates', 'raw_acceleration', 'raw_imu',
    'raw_ble', 'ble_device_id', 'device_name', 'glasses_serial', 'device_id',
    'aiui_id', 'account', 'credential-secret', 'Garmin Secret',
  ]) {
    assert.equal(encoded.includes(secret), false, `must strip ${secret}`);
  }
});

test('IMU 历史保持或非新鲜状态不上传 candidate 且不改 canonical 指标', () => {
  const staleCases = [
    { imu_cadence_state: 'holding', imu_fresh: true },
    { imu_cadence_state: 'display_only', imu_fresh: true },
    { imu_cadence_state: 'estimated', imu_fresh: false },
  ];
  for (const stale of staleCases) {
    const sample = captureCyclingUploadSample(session(), {
      speed_kmh: 23.5,
      cadence_rpm: 86,
      candidate_cadence_rpm: 91,
      distance_m: 123.456,
      speed_state: 'live',
      cadence_state: 'live',
      speed_source: 'gps',
      cadence_source: 'imu',
      distance_source: 'gps',
      distance_mode: 'gps_path',
      ...stale,
    }, { capturedAtMs: START + 1000 });

    assert.equal('candidate_cadence_rpm' in sample, false);
    assert.equal(sample.speed_kmh, 23.5);
    assert.equal(sample.cadence_rpm, 86);
    assert.equal(sample.distance_m, 123.456);
  }

  const live = captureCyclingUploadSample(session(), {
    cadence_rpm: 86,
    candidate_cadence_rpm: 91,
    cadence_state: 'live',
    cadence_source: 'imu',
    imu_cadence_state: 'estimated',
    imu_fresh: true,
  }, { capturedAtMs: START + 1000 });
  assert.equal(live.candidate_cadence_rpm, 91);
  assert.equal(live.imu_cadence_state, 'estimated');
  assert.equal(live.imu_fresh, true);
});

test('finish 事件只保留聚合摘要并且每场只生成一次', () => {
  const stream = session();
  captureCyclingUploadSample(
    stream,
    { speed_kmh: 20 },
    { capturedAtMs: START + 1000 },
  );
  const finish = captureCyclingUploadFinish(stream, {
    endedAtMs: START + 60000,
    elapsedMs: 55000,
    movingMs: 60000,
    distanceM: 420,
    avgSpeedKmh: 27.49,
    maxSpeedKmh: 41.234,
    avgCadenceRpm: 88.125,
    maxCadenceRpm: 112,
    avgBpm: 145,
    maxBpm: 171,
    avgPowerW: 212,
    maxPowerW: 520,
    sampleCount: 55,
    sources: ['gps', 'imu', 'hrs', 'bad-source'],
    distanceSources: ['gps', 'imu', 'bad-source'],
    cadenceSources: ['imu', 'csc', 'bad-source'],
    track: [{ latitude: 31.2, longitude: 121.4 }],
    raw_imu: [1, 2, 3],
    device_name: 'Private Sensor',
    token: 'secret',
  });
  assert.equal(finish.event_type, 'finish');
  assert.equal(finish.elapsed_ms, 55000);
  assert.equal(finish.moving_ms, 55000, 'moving duration is bounded by elapsed');
  assert.equal(finish.avg_speed_kmh, 27.49);
  assert.deepEqual(finish.sources, ['imu', 'hrs']);
  assert.deepEqual(finish.distance_sources, ['imu']);
  assert.deepEqual(finish.cadence_sources, ['imu', 'csc']);
  assert.equal('track' in finish, false);
  assert.equal('raw_imu' in finish, false);
  assert.equal('device_name' in finish, false);
  assert.equal('token' in finish, false);
  assert.equal(
    captureCyclingUploadFinish(stream, {}, { capturedAtMs: START + 61000 }),
    null,
  );
});

test('归一化拒绝伪造 ID、不合法事件类型和越界指标', () => {
  const [sample] = events(1);
  assert.equal(normalizeCyclingUploadEvent({
    ...sample,
    event_id: 'other-event-id',
  }), null);
  assert.equal(normalizeCyclingUploadEvent({
    ...sample,
    event_type: 'location',
  }), null);
  const bounded = normalizeCyclingUploadEvent({
    ...sample,
    speed_kmh: 999,
    cadence_rpm: -1,
    heart_rate_bpm: 500,
    power_w: 99999,
  });
  assert.equal('speed_kmh' in bounded, false);
  assert.equal('cadence_rpm' in bounded, false);
  assert.equal('heart_rate_bpm' in bounded, false);
  assert.equal('power_w' in bounded, false);
});

test('持久队列有上限、去重，并以写后读回确认成功', () => {
  const s = storage();
  const all = events(CYCLING_UPLOAD_MAX_EVENTS + 3, { force: true });
  const queued = appendPendingCyclingUploadEvents(s, [
    all[0],
    ...all,
    { ...all[1], latitude: 31.2, raw_ble: [1] },
  ]);
  assert.equal(queued.length, CYCLING_UPLOAD_MAX_EVENTS);
  assert.equal(queued[0].seq, 4);
  assert.equal(
    JSON.stringify(s.map.get(PENDING_CYCLING_UPLOAD_KEY)).includes('latitude'),
    false,
  );

  const silentWrite = storage();
  silentWrite.setStorageSync = () => {};
  assert.equal(
    appendPendingCyclingUploadEvents(silentWrite, [all[0]]),
    null,
  );
});

test('pending 读取异常显式失败，append/remove/write 均不覆盖旧队列', () => {
  const s = storage();
  const batch = events(2);
  s.map.set(PENDING_CYCLING_UPLOAD_KEY, [batch[0]]);
  let writes = 0;
  s.getStorageSync = () => { throw new Error('temporary read failure'); };
  s.setStorageSync = () => { writes += 1; };
  s.removeStorageSync = () => { writes += 1; };

  const read = readPendingCyclingUploadEventsResult(s);
  assert.equal(read.ok, false);
  assert.equal(read.status, 'read_failed');
  assert.deepEqual(read.events, []);
  assert.deepEqual(
    readPendingCyclingUploadEvents(s),
    [],
    'legacy array reader remains compatible',
  );
  assert.equal(appendPendingCyclingUploadEvents(s, [batch[1]]), null);
  assert.equal(removePendingCyclingUploadEvents(s, []), null);
  assert.equal(
    removePendingCyclingUploadEvents(s, [batch[0].event_id]),
    null,
  );
  assert.equal(writePendingCyclingUploadEvents(s, []), null);
  assert.equal(writes, 0, 'unknown old queue must not be set or removed');
  assert.deepEqual(s.map.get(PENDING_CYCLING_UPLOAD_KEY), [batch[0]]);
});

test('pending 写后读回异常不能把清空操作报告为成功', () => {
  const s = storage();
  const [event] = events(1);
  s.map.set(PENDING_CYCLING_UPLOAD_KEY, [event]);
  let reads = 0;
  const originalGet = s.getStorageSync;
  s.getStorageSync = (key) => {
    reads += 1;
    if (reads > 1) throw new Error('readback failure');
    return originalGet.call(s, key);
  };
  assert.equal(writePendingCyclingUploadEvents(s, []), null);
});

test('只删除明确 ACK，且基于网络往返后的最新 storage', () => {
  const s = storage();
  const batch = events(3);
  appendPendingCyclingUploadEvents(s, batch.slice(0, 2));
  const inFlight = readPendingCyclingUploadEvents(s).slice(0, 2);
  appendPendingCyclingUploadEvents(s, [batch[2]]);

  assert.deepEqual(
    removePendingCyclingUploadEvents(s, []),
    batch,
    '没有 acked_event_ids 时不得删除',
  );
  const remaining = removePendingCyclingUploadEvents(
    s,
    [inFlight[0].event_id, 'not-in-queue'],
  );
  assert.deepEqual(remaining.map((item) => item.seq), [2, 3]);

  const silentAck = storage();
  appendPendingCyclingUploadEvents(silentAck, [batch[0]]);
  silentAck.removeStorageSync = () => {};
  assert.equal(
    removePendingCyclingUploadEvents(silentAck, [batch[0].event_id]),
    null,
  );
  assert.equal(readPendingCyclingUploadEvents(silentAck).length, 1);
});

test('请求使用独立 Hermes 骑行测试入口、有限批次且凭据不进 data', () => {
  const all = events(CYCLING_UPLOAD_BATCH_SIZE + 3);
  const request = buildCyclingUploadRequest({
    token: 'scoped-device-token',
    baseUrl: CYCLING_UPLOAD_DEFAULT_BASE_URL + '/',
    events: all,
  });
  assert.equal(
    request.url,
    CYCLING_UPLOAD_DEFAULT_BASE_URL + CYCLING_UPLOAD_PATH,
  );
  assert.equal(request.method, 'POST');
  assert.equal(request.header.Authorization, 'Bearer scoped-device-token');
  assert.equal(request.data.test_mode, true);
  assert.equal(request.data.events.length, CYCLING_UPLOAD_BATCH_SIZE);
  assert.equal(request.timeout, 12000);
  assert.equal(request.data.events[0].seq, 1, 'FIFO sends oldest pending sample');
  assert.equal(JSON.stringify(request.data).includes('scoped-device-token'), false);
});

test('响应仅接受请求内明确 acked_event_ids', () => {
  const batch = events(2);
  const parsed = parseCyclingUploadResponse({
    statusCode: 200,
    data: JSON.stringify({
      acked_event_ids: [batch[0].event_id, batch[0].event_id, 'other.event.1'],
      stored: 1,
      duplicates: 0,
    }),
  }, batch);
  assert.deepEqual(parsed.ackedEventIds, [batch[0].event_id]);
  assert.equal(parsed.stored, 1);
  assert.deepEqual(parsed.organizedRides, []);
  assert.equal(parseCyclingUploadResponse({
    statusCode: 200,
    data: { stored: 2 },
  }, batch), null);
  assert.equal(parseCyclingUploadResponse({
    statusCode: 200,
    data: { acked_event_ids: [] },
  }, batch), null);
  assert.equal(parseCyclingUploadResponse({
    statusCode: 401,
    data: { acked_event_ids: [batch[0].event_id] },
  }, batch), null);
});

test('ACK 兼容 AIUI 0.15 的 ArrayBuffer 与 TypedArray 响应', () => {
  const batch = events(2);
  const payload = JSON.stringify({
    acked_event_ids: batch.map((event) => event.event_id),
    stored: 2,
    duplicates: 0,
  });
  const bytes = new TextEncoder().encode(payload);
  for (const data of [bytes.buffer, bytes]) {
    const parsed = parseCyclingUploadResponse({ statusCode: 200, data }, batch);
    assert.deepEqual(
      parsed.ackedEventIds,
      batch.map((event) => event.event_id),
    );
    assert.equal(parsed.stored, 2);
  }
});

test('上传批次按单场骑行分组并优先本次刚结束的骑行', () => {
  const older = events(3);
  const newerStream = createCyclingUploadSession(
    START + 10000,
    { random: () => 0.6 },
  );
  const newer = [1, 2].map((seq) => captureCyclingUploadSample(
    newerStream,
    { cadence_rpm: 82, cadence_source: 'imu', cadence_state: 'live' },
    { capturedAtMs: START + 10000 + seq * 1000 },
  ));
  const queue = [...older, ...newer];
  assert.deepEqual(
    selectCyclingUploadBatch(queue).map((event) => event.event_id),
    older.map((event) => event.event_id),
  );
  assert.deepEqual(
    selectCyclingUploadBatch(
      queue,
      newer[0].test_ride_id,
    ).map((event) => event.event_id),
    newer.map((event) => event.event_id),
  );
});

test('AIUI 字节型永久拒绝只映射为有限诊断码，不持久化服务端原文', () => {
  const payload = new TextEncoder().encode(JSON.stringify({
    detail: 'test_ride_id belongs to another lifecycle',
  }));
  assert.deepEqual(classifyCyclingUploadRejection({
    statusCode: 409,
    data: payload.buffer,
  }), {
    statusCode: 409,
    conflictCode: 'ride_lifecycle',
  });
  assert.deepEqual(classifyCyclingUploadRejection({
    statusCode: 422,
    data: { detail: 'private server detail' },
  }), {
    statusCode: 422,
    conflictCode: 'validation',
  });
});

test('整场生命周期冲突可原子隔离并完整保留有限诊断码', () => {
  const s = storage();
  const batch = events(5);
  appendPendingCyclingUploadEvents(s, batch);
  const quarantined = quarantineCyclingUploadEvents(
    s,
    batch,
    409,
    'ride_lifecycle',
    START + 9000,
  );
  assert.equal(quarantined.quarantined.length, batch.length);
  assert.equal(readPendingCyclingUploadEvents(s).length, 0);
  assert.deepEqual(
    readQuarantinedCyclingUploadEvents(s).map((record) => record.conflict_code),
    Array(batch.length).fill('ride_lifecycle'),
  );
});

test('永久拒绝事件先落隐私隔离区，读回确认后才让后续队列继续', () => {
  const s = storage();
  const batch = events(2);
  appendPendingCyclingUploadEvents(s, batch);
  const quarantined = quarantineCyclingUploadEvent(
    s,
    { ...batch[0], latitude: 31.2, raw_ble: [1, 2] },
    422,
    START + 5000,
  );
  assert.equal(quarantined.quarantined.event.event_id, batch[0].event_id);
  assert.deepEqual(
    readPendingCyclingUploadEvents(s).map((item) => item.event_id),
    [batch[1].event_id],
  );
  assert.equal(readQuarantinedCyclingUploadEvents(s).length, 1);
  assert.equal(
    JSON.stringify(s.map.get(QUARANTINED_CYCLING_UPLOAD_KEY))
      .includes('latitude'),
    false,
  );

  const many = events(CYCLING_UPLOAD_MAX_QUARANTINED_EVENTS + 2, {
    force: true,
  });
  for (let index = 0; index < many.length; index += 1) {
    appendPendingCyclingUploadEvents(s, [many[index]]);
    quarantineCyclingUploadEvent(s, many[index], 400, START + 6000 + index);
  }
  assert.equal(
    readQuarantinedCyclingUploadEvents(s).length,
    CYCLING_UPLOAD_MAX_QUARANTINED_EVENTS,
  );
});

test('隔离前任一旧队列读取失败时不写隔离区也不改 pending', () => {
  const s = storage();
  const batch = events(2);
  s.map.set(PENDING_CYCLING_UPLOAD_KEY, batch);
  let writes = 0;
  const originalGet = s.getStorageSync;
  s.getStorageSync = (key) => {
    if (key === PENDING_CYCLING_UPLOAD_KEY) {
      throw new Error('pending read failure');
    }
    return originalGet.call(s, key);
  };
  s.setStorageSync = () => { writes += 1; };
  s.removeStorageSync = () => { writes += 1; };

  assert.equal(
    quarantineCyclingUploadEvent(s, batch[0], 422, START + 5000),
    null,
  );
  assert.equal(writes, 0);
  assert.equal(s.map.has(QUARANTINED_CYCLING_UPLOAD_KEY), false);
  assert.deepEqual(s.map.get(PENDING_CYCLING_UPLOAD_KEY), batch);
});

test('瞬时失败完整保留；400/409/422 可纯逻辑二分到单条毒丸', () => {
  const batch = events(3);
  for (const status of [undefined, 0, 401, 429, 500, 503]) {
    assert.equal(isPermanentCyclingUploadRejection(status), false);
    assert.deepEqual(isolateCyclingPoisonEvent(status, batch), {
      action: 'retain',
      retryBatches: [],
      poisonEvent: null,
    });
  }
  for (const status of [400, 409, 422]) {
    assert.equal(isPermanentCyclingUploadRejection(status), true);
    const split = isolateCyclingPoisonEvent(status, batch);
    assert.equal(split.action, 'split');
    assert.deepEqual(split.retryBatches.map((part) => part.length), [2, 1]);
    const isolated = isolateCyclingPoisonEvent(status, split.retryBatches[1]);
    assert.equal(isolated.action, 'quarantine');
    assert.equal(isolated.poisonEvent.event_id, batch[2].event_id);
  }
});
