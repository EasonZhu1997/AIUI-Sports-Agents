import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIUI_CALIBRATION_BATCH_SIZE,
  AIUI_CALIBRATION_MAX_EVENTS,
  AIUI_CALIBRATION_PATH,
  PENDING_AIUI_CALIBRATION_KEY,
  appendPendingAiuiCalibrationEvents,
  buildAiuiCalibrationRequest,
  captureAiuiCalibrationEvent,
  createAiuiCalibrationStream,
  isPermanentAiuiCalibrationRejection,
  normalizeAiuiCalibrationEvent,
  parseAiuiCalibrationResponse,
  readPendingAiuiCalibrationEvents,
  readPendingAiuiCalibrationEventsState,
  removePendingAiuiCalibrationEvents,
} from '../lib/aiui_calibration.js';
import { DEFAULT_BASE_URL } from '../lib/coach_api.js';

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

function event(seq = 1, extra = {}) {
  return {
    schema_version: 1,
    source: 'aiui_glasses',
    event_id: `aiui_${START}_test.${String(seq).padStart(10, '0')}`,
    stream_id: `aiui_${START}_test`,
    seq,
    captured_at_ms: START + seq * 1000,
    stream_started_at_ms: START,
    elapsed_ms: seq * 1000,
    cadence_spm: 168,
    distance_m: seq * 2.5,
    ...extra,
  };
}

test('AIUI calibration event uses a strict derived-metric whitelist', () => {
  const normalized = normalizeAiuiCalibrationEvent(event(1, {
    candidate_cadence_spm: 170.123,
    speed_mps: 3.123456,
    pace_sec_per_km: 320.12,
    steps_total: 4,
    accepted_steps: 4,
    candidate_steps: 5,
    rejected_steps: 1,
    gps_accuracy_m: 6.2,
    gps_segment_distance_m: 2.3,
    gps_segment_speed_mps: 2.1,
    motion_quality: 0.91234,
    artifact_confidence: 0.08,
    gyro_rms: 0.12345,
    stationary: false,
    distance_source: 'gps',
    cadence_source: 'imu',
    rejection_reason: 'cadence_disagreement',
    latitude: 31.2,
    longitude: 121.4,
    raw_acceleration: [1, 2, 3],
    device_id: 'secret',
  }));
  assert.equal(normalized.speed_mps, 3.1235);
  assert.equal(normalized.motion_quality, 0.9123);
  assert.equal('distance_source' in normalized, false);
  assert.equal(normalized.cadence_source, 'imu');
  assert.equal('latitude' in normalized, false);
  assert.equal('longitude' in normalized, false);
  assert.equal('gps_accuracy_m' in normalized, false);
  assert.equal('gps_segment_distance_m' in normalized, false);
  assert.equal('gps_segment_speed_mps' in normalized, false);
  assert.equal('raw_acceleration' in normalized, false);
  assert.equal('device_id' in normalized, false);
});

test('stream creates stable independent IDs and samples at no more than 1 Hz', () => {
  const stream = createAiuiCalibrationStream(START, { nonce: 'test' });
  const first = captureAiuiCalibrationEvent(stream, {
    elapsed_ms: 1000,
    cadence_spm: 160,
  }, { capturedAtMs: START + 1000 });
  const tooSoon = captureAiuiCalibrationEvent(stream, {
    elapsed_ms: 1500,
  }, { capturedAtMs: START + 1500 });
  const second = captureAiuiCalibrationEvent(stream, {
    elapsed_ms: 2000,
    cadence_spm: 162,
  }, { capturedAtMs: START + 2000 });
  assert.equal(first.seq, 1);
  assert.equal(tooSoon, null);
  assert.equal(second.seq, 2);
  assert.equal(first.stream_id, second.stream_id);
  assert.match(first.event_id, /\.0000000001$/);
  assert.equal(first.captured_at_ms, START + 1000, 'cross-device alignment uses epoch ms');
});

test('persistent calibration queue appends and ACKs against the latest storage', () => {
  const s = storage();
  assert.equal(appendPendingAiuiCalibrationEvents(s, [event(1)]).length, 1);
  const inFlight = readPendingAiuiCalibrationEvents(s).slice(0, 1);
  appendPendingAiuiCalibrationEvents(s, [event(2)]);
  const remaining = removePendingAiuiCalibrationEvents(
    s,
    inFlight.map((item) => item.event_id),
  );
  assert.deepEqual(remaining.map((item) => item.seq), [2]);
  assert.equal(s.map.get(PENDING_AIUI_CALIBRATION_KEY)[0].seq, 2);
});

test('queue write and ACK require storage round-trip confirmation', () => {
  const silentWrite = storage();
  silentWrite.setStorageSync = () => {};
  assert.equal(appendPendingAiuiCalibrationEvents(silentWrite, [event(1)]), null);

  const silentAck = storage();
  appendPendingAiuiCalibrationEvents(silentAck, [event(1)]);
  silentAck.removeStorageSync = () => {};
  assert.equal(removePendingAiuiCalibrationEvents(
    silentAck,
    [event(1).event_id],
  ), null);
  assert.equal(readPendingAiuiCalibrationEvents(silentAck).length, 1);
});

test('queue read failure or damaged value fails closed without overwriting old events', () => {
  const s = storage();
  assert.equal(appendPendingAiuiCalibrationEvents(s, [event(1)]).length, 1);
  const normalGet = s.getStorageSync.bind(s);
  let throwOnce = true;
  s.getStorageSync = (key) => {
    if (key === PENDING_AIUI_CALIBRATION_KEY && throwOnce) {
      throwOnce = false;
      throw new Error('transient read failure');
    }
    return normalGet(key);
  };
  assert.equal(appendPendingAiuiCalibrationEvents(s, [event(2)]), null);
  assert.deepEqual(
    readPendingAiuiCalibrationEvents(s).map((item) => item.seq),
    [1],
    'append 读错不得把旧队列覆盖成仅有新事件',
  );

  throwOnce = true;
  assert.equal(removePendingAiuiCalibrationEvents(s, [event(1).event_id]), null);
  assert.deepEqual(
    readPendingAiuiCalibrationEvents(s).map((item) => item.seq),
    [1],
    'ACK 读错不得把未确认旧队列清空',
  );

  const damaged = storage();
  damaged.map.set(PENDING_AIUI_CALIBRATION_KEY, { corrupted: true });
  assert.equal(readPendingAiuiCalibrationEventsState(damaged).ok, false);
  assert.equal(appendPendingAiuiCalibrationEvents(damaged, [event(2)]), null);
  assert.deepEqual(
    damaged.map.get(PENDING_AIUI_CALIBRATION_KEY),
    { corrupted: true },
    '未知损坏值保留给恢复/诊断，不能静默覆盖',
  );
});

test('pending calibration 数组含无效、重复或溢出记录时整队 fail closed', () => {
  const invalid = storage();
  const invalidRaw = [event(1), { schema_version: 1, broken: true }];
  invalid.map.set(PENDING_AIUI_CALIBRATION_KEY, invalidRaw);
  assert.deepEqual(readPendingAiuiCalibrationEvents(invalid), []);
  assert.equal(readPendingAiuiCalibrationEventsState(invalid).ok, false);
  assert.equal(removePendingAiuiCalibrationEvents(
    invalid,
    [event(1).event_id],
  ), null);
  assert.deepEqual(invalid.map.get(PENDING_AIUI_CALIBRATION_KEY), invalidRaw);

  const duplicate = storage();
  duplicate.map.set(PENDING_AIUI_CALIBRATION_KEY, [event(1), { ...event(1) }]);
  assert.equal(readPendingAiuiCalibrationEventsState(duplicate).ok, false);

  const duplicateSeq = storage();
  duplicateSeq.map.set(PENDING_AIUI_CALIBRATION_KEY, [
    event(1),
    event(1, { event_id: `aiui_${START}_test.duplicate0001` }),
  ]);
  assert.equal(readPendingAiuiCalibrationEventsState(duplicateSeq).ok, false);

  const overflow = storage();
  overflow.map.set(
    PENDING_AIUI_CALIBRATION_KEY,
    Array.from({ length: AIUI_CALIBRATION_MAX_EVENTS + 1 }, (_unused, index) => (
      event(index + 1)
    )),
  );
  const overflowState = readPendingAiuiCalibrationEventsState(overflow);
  assert.equal(overflowState.ok, false);
  assert.equal(overflowState.reason, 'queue_overflow');
});

test('calibration request uses device-scoped endpoint and bounded batch', () => {
  assert.equal(
    AIUI_CALIBRATION_BATCH_SIZE,
    500,
    '总结上传批次应对齐后端单批 500 条上限，减少网络往返',
  );
  const events = [];
  for (let seq = 1; seq <= AIUI_CALIBRATION_BATCH_SIZE + 3; seq += 1) {
    events.push(event(seq));
  }
  const request = buildAiuiCalibrationRequest({
    token: 'device-token',
    events,
  });
  assert.equal(request.url, DEFAULT_BASE_URL + AIUI_CALIBRATION_PATH);
  assert.equal(request.url, AIUI_CALIBRATION_PATH);
  assert.equal(request.method, 'POST');
  assert.equal(request.header.Authorization, 'Bearer device-token');
  assert.equal(request.responseType, 'text');
  assert.equal(request.data.events.length, AIUI_CALIBRATION_BATCH_SIZE);
  assert.equal(request.data.events[0].seq, 1);
  assert.equal(request.data.events.at(-1).seq, AIUI_CALIBRATION_BATCH_SIZE);
});

test('only explicit server ACKs remove calibration events', () => {
  const expected = [event(1), event(2)];
  const parsed = parseAiuiCalibrationResponse({
    statusCode: 200,
    data: {
      acked_event_ids: [expected[0].event_id, 'other.event.00000001'],
      stored: 1,
      duplicates: 0,
      matched: 1,
    },
  }, expected);
  assert.deepEqual(parsed.ackedEventIds, [expected[0].event_id]);
  assert.equal(parsed.matched, 1);
  assert.equal(parseAiuiCalibrationResponse({
    statusCode: 200,
    data: { acked_event_ids: [] },
  }, expected), null);
  assert.equal(parseAiuiCalibrationResponse({
    statusCode: 401,
    data: { acked_event_ids: [expected[0].event_id] },
  }, expected), null);
});

test('400/409/422 are permanent calibration conflicts; transient failures retain data', () => {
  assert.equal(isPermanentAiuiCalibrationRejection(400), true);
  assert.equal(isPermanentAiuiCalibrationRejection(409), true);
  assert.equal(isPermanentAiuiCalibrationRejection(422), true);
  assert.equal(isPermanentAiuiCalibrationRejection(401), false);
  assert.equal(isPermanentAiuiCalibrationRejection(429), false);
  assert.equal(isPermanentAiuiCalibrationRejection(500), false);
  assert.equal(readPendingAiuiCalibrationEvents(null).length, 0);
});
