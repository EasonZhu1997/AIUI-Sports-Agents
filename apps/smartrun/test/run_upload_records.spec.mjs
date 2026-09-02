import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUARANTINED_AIUI_CALIBRATION_KEY,
  QUARANTINED_RUN_UPLOADS_KEY,
  RUN_UPLOAD_RECEIPTS_KEY,
  RUN_UPLOAD_QUARANTINE_MAX,
  appendRunUploadReceipt,
  createCalibrationUploadReceipt,
  createRunSummaryUploadReceipt,
  quarantineAiuiCalibrationEvent,
  quarantineRunUpload,
  readQuarantinedAiuiCalibrationEvents,
  readQuarantinedAiuiCalibrationEventsState,
  readQuarantinedRunUploads,
  readQuarantinedRunUploadsState,
  readRunUploadReceipts,
  summarizeRunUploadReceipts,
} from '../lib/run_upload_records.js';
import {
  captureAiuiCalibrationEvent,
  createAiuiCalibrationStream,
} from '../lib/aiui_calibration.js';

function storage() {
  const map = new Map();
  return {
    map,
    getStorageSync(key) { return map.get(key); },
    setStorageSync(key, value) { map.set(key, value); },
    removeStorageSync(key) { map.delete(key); },
  };
}

function runPayload(overrides = {}) {
  return {
    started_at: '2026-07-26T01:00:00.000Z',
    ended_at: '2026-07-26T01:05:00.000Z',
    duration_s: 300,
    distance_m: 800,
    avg_pace_s: 375,
    source: 'aiui',
    workout_type: 'free',
    client_run_id: 'run-scientific-receipt-0001',
    ...overrides,
  };
}

function calibrationEvent() {
  const startedAtMs = Date.UTC(2026, 6, 26, 1, 0, 0);
  const stream = createAiuiCalibrationStream(startedAtMs, {
    nonce: 'receipt',
  });
  return captureAiuiCalibrationEvent(stream, {
    elapsed_ms: 1000,
    cadence_spm: 168,
    speed_mps: 2.4,
    distance_m: 2.4,
    distance_source: 'imu',
    cadence_source: 'imu',
    latitude: 31.2,
    rawAccelerometer: { x: 1, y: 2, z: 3 },
    token: 'must-not-persist',
  }, { capturedAtMs: startedAtMs + 1000 });
}

test('上传回执只保存科学计数与随机流/幂等跑步 ID，且同一 ACK 幂等覆盖', () => {
  const s = storage();
  const event = calibrationEvent();
  const calibrationReceipt = createCalibrationUploadReceipt(
    [event],
    [event.event_id],
    {
      matchedCount: 1,
      completedAtMs: Date.UTC(2026, 6, 26, 1, 5, 1),
      remainingCount: 3,
    },
  );
  const runReceipt = createRunSummaryUploadReceipt(runPayload(), {
    completedAtMs: Date.UTC(2026, 6, 26, 1, 5, 2),
    remainingCount: 0,
  });
  assert.ok(appendRunUploadReceipt(s, calibrationReceipt));
  assert.ok(appendRunUploadReceipt(s, runReceipt));
  assert.ok(appendRunUploadReceipt(s, calibrationReceipt));

  const receipts = readRunUploadReceipts(s);
  assert.equal(receipts.length, 2);
  assert.deepEqual(
    summarizeRunUploadReceipts(s, {
      streamId: event.stream_id,
      clientRunId: runPayload().client_run_id,
    }),
    {
      ackedCount: 2,
      matchedCount: 1,
      completedAtMs: Date.UTC(2026, 6, 26, 1, 5, 2),
    },
  );
  const serialized = JSON.stringify(s.map.get(RUN_UPLOAD_RECEIPTS_KEY));
  for (const forbidden of [
    'token', 'device_id', 'public_device_id', 'latitude', 'longitude',
    'rawAccelerometer',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('永久拒绝先写后读回到有界白名单隔离区，再由调用方决定移出主队列', () => {
  const s = storage();
  const event = calibrationEvent();
  const dirtyRun = runPayload({
    latitude: 31.2,
    longitude: 121.4,
    points: [{ lat: 31.2, lng: 121.4 }],
    token: 'secret',
    device_id: 'private-device',
  });
  assert.ok(quarantineRunUpload(
    s,
    dirtyRun,
    409,
    Date.UTC(2026, 6, 26, 1, 5, 3),
  ));
  assert.ok(quarantineAiuiCalibrationEvent(
    s,
    {
      ...event,
      latitude: 31.2,
      rawGyroscope: { x: 1 },
      token: 'secret',
    },
    409,
    Date.UTC(2026, 6, 26, 1, 5, 4),
  ));

  assert.equal(readQuarantinedRunUploads(s).length, 1);
  assert.equal(readQuarantinedRunUploads(s)[0].status_code, 409);
  assert.equal(readQuarantinedAiuiCalibrationEvents(s).length, 1);
  const serialized = JSON.stringify({
    run: s.map.get(QUARANTINED_RUN_UPLOADS_KEY),
    calibration: s.map.get(QUARANTINED_AIUI_CALIBRATION_KEY),
  });
  for (const forbidden of [
    'token', 'device_id', 'latitude', 'longitude', 'points',
    'rawGyroscope', 'rawAccelerometer',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('隔离区读取失败或损坏时 fail closed，不覆盖既有证据', () => {
  const s = storage();
  const firstRun = runPayload({ client_run_id: 'run-quarantine-old-0001' });
  const secondRun = runPayload({ client_run_id: 'run-quarantine-new-0002' });
  const now = Date.UTC(2026, 6, 26, 2, 0, 0);
  assert.ok(quarantineRunUpload(s, firstRun, 422, now));
  const durableBefore = JSON.stringify(s.map.get(QUARANTINED_RUN_UPLOADS_KEY));
  const normalGet = s.getStorageSync.bind(s);
  let throwOnce = true;
  s.getStorageSync = (key) => {
    if (key === QUARANTINED_RUN_UPLOADS_KEY && throwOnce) {
      throwOnce = false;
      throw new Error('transient quarantine read failure');
    }
    return normalGet(key);
  };
  assert.equal(quarantineRunUpload(s, secondRun, 409, now + 1000), null);
  assert.equal(
    JSON.stringify(s.map.get(QUARANTINED_RUN_UPLOADS_KEY)),
    durableBefore,
    '瞬时读错不能把旧隔离证据覆盖成只有新条目',
  );
  assert.deepEqual(
    readQuarantinedRunUploads(s).map((entry) => entry.run.client_run_id),
    [firstRun.client_run_id],
  );

  const corrupt = storage();
  const corruptRaw = [{ not: 'a valid quarantine entry' }];
  corrupt.map.set(QUARANTINED_AIUI_CALIBRATION_KEY, corruptRaw);
  assert.equal(readQuarantinedAiuiCalibrationEventsState(corrupt).ok, false);
  assert.equal(quarantineAiuiCalibrationEvent(
    corrupt,
    calibrationEvent(),
    409,
    now,
  ), null);
  assert.deepEqual(corrupt.map.get(QUARANTINED_AIUI_CALIBRATION_KEY), corruptRaw);
});

test('隔离区状态区分确认空与不可读，满额时保留主 FIFO 等待诊断', () => {
  assert.equal(readQuarantinedRunUploadsState(storage()).ok, true);
  assert.equal(readQuarantinedRunUploadsState(null).ok, false);
  assert.equal(readQuarantinedAiuiCalibrationEventsState(null).ok, false);

  const s = storage();
  const now = Date.UTC(2026, 6, 26, 2, 30, 0);
  for (let i = 0; i < RUN_UPLOAD_QUARANTINE_MAX; i += 1) {
    assert.ok(quarantineRunUpload(s, runPayload({
      client_run_id: 'run-quarantine-cap-' + String(i).padStart(4, '0'),
    }), 422, now + i));
  }
  assert.equal(quarantineRunUpload(s, runPayload({
    client_run_id: 'run-quarantine-overflow-9999',
  }), 409, now + RUN_UPLOAD_QUARANTINE_MAX), null);
  assert.equal(readQuarantinedRunUploads(s).length, RUN_UPLOAD_QUARANTINE_MAX);
});
