import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunUploadPayload, buildRunUploadRequest, parseRunUploadResponse,
  readPendingRunUploads, readPendingRunUploadsState,
  writePendingRunUploads, enqueueRunUpload,
  removePendingRunUpload, createClientRunId, ensureClientRunId,
  normalizeRunUploadPayload, isPermanentRunUploadRejection,
  RUN_UPLOAD_PATH, AIUI_RUN_UPLOAD_PATH, PENDING_RUNS_KEY, PENDING_RUNS_MAX,
} from '../lib/run_upload.js';
import { DEFAULT_BASE_URL } from '../lib/coach_api.js';

function fakeStorage() {
  const store = new Map();
  return {
    store,
    getStorageSync(k) { return store.has(k) ? store.get(k) : ''; },
    setStorageSync(k, v) { store.set(k, v); },
    removeStorageSync(k) { store.delete(k); },
  };
}

const START = 1751900000000;

test('buildRunUploadPayload：门槛以下(时长<60s 且距离<100m)返回 null,不制造垃圾记录', () => {
  assert.equal(buildRunUploadPayload({ startMs: START, elapsedMs: 30000, distanceM: 50 }), null);
  assert.equal(buildRunUploadPayload({ startMs: 0, elapsedMs: 999999, distanceM: 5000 }), null);
  assert.equal(buildRunUploadPayload(null), null);
});

test('上传确认从最新队列移除，不覆盖请求期间新入队的跑步', () => {
  const s = fakeStorage();
  const first = { started_at: '2026-07-17T00:00:00.000Z', duration_s: 60 };
  const second = { started_at: '2026-07-17T00:10:00.000Z', duration_s: 90 };
  enqueueRunUpload(s, first);
  enqueueRunUpload(s, second);
  const remaining = removePendingRunUpload(s, first);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].started_at, second.started_at);
  assert.match(remaining[0].client_run_id, /^run-/);
});

test('client_run_id 在本地入队时生成，旧队列迁移与重试始终保持同一值', () => {
  const s = fakeStorage();
  const payload = {
    started_at: '2026-07-17T00:00:00.000Z', duration_s: 60,
    distance_m: 123, source: 'aiui', workout_type: 'free',
  };
  const id = createClientRunId(payload);
  assert.match(id, /^run-[a-z0-9]+-[0-9a-f]{8}$/);
  assert.equal(id.length >= 8 && id.length <= 80, true);
  assert.equal(ensureClientRunId(payload).client_run_id, id);

  s.setStorageSync(PENDING_RUNS_KEY, [payload]); // 模拟升级前队列
  const firstRead = readPendingRunUploads(s);
  const secondRead = readPendingRunUploads(s);
  assert.equal(firstRead[0].client_run_id, id);
  assert.equal(secondRead[0].client_run_id, id);
  assert.equal(s.store.get(PENDING_RUNS_KEY)[0].client_run_id, id, '迁移后写回 storage');

  const preserved = ensureClientRunId({ ...payload, client_run_id: 'run-fixed-1234' });
  assert.equal(preserved.client_run_id, 'run-fixed-1234');
});

test('buildRunUploadPayload：正常跑步 → RunIn 形状,source=aiui,数值取整', () => {
  const p = buildRunUploadPayload({
    startMs: START, endMs: START + 1805000, elapsedMs: 1800000, distanceM: 5023.7,
    avgPaceSecPerKm: 358.4, avgBpm: 152.6, maxBpm: 171, avgCadenceSpm: 168.2,
  });
  assert.equal(p.started_at, new Date(START).toISOString());
  assert.equal(p.ended_at, new Date(START + 1805000).toISOString());
  assert.equal(p.duration_s, 1800);
  assert.equal(p.distance_m, 5024);
  assert.equal(p.avg_pace_s, 358);
  assert.equal(p.avg_hr, 153);
  assert.equal(p.max_hr, 171);
  assert.equal(p.cadence_avg, 168);
  assert.equal(p.source, 'aiui');
  assert.equal(p.workout_type, 'free');
});

test('buildRunUploadPayload：超慢跑保留 workout_type，不再误记成自由跑', () => {
  const p = buildRunUploadPayload({
    mode: 'slow', startMs: START, elapsedMs: 20 * 60000, distanceM: 1800,
  });
  assert.equal(p.workout_type, 'slow_jog');
});

test('buildRunUploadPayload：室内跑在旧服务契约中按 free 兼容上传', () => {
  const p = buildRunUploadPayload({
    mode: 'garmin_virtual', startMs: START, elapsedMs: 20 * 60000, distanceM: 1800,
  });
  assert.equal(p.workout_type, 'free');
});

test('buildRunUploadPayload：眼镜无心率 → 心率字段整体缺席,不发 0/null', () => {
  const p = buildRunUploadPayload({ startMs: START, elapsedMs: 600000, distanceM: 1500 });
  assert.ok(!('avg_hr' in p) && !('max_hr' in p) && !('cadence_avg' in p) && !('avg_pace_s' in p));
  assert.equal(p.duration_s, 600);
});

test('buildRunUploadRequest：公网路径 /api/coach-svc/runs + Bearer', () => {
  const req = buildRunUploadRequest({
    token: 't9', payload: { source: 'aiui', client_run_id: 'run-fixed-1234' },
  });
  assert.equal(req.url, `${DEFAULT_BASE_URL}${RUN_UPLOAD_PATH}`);
  assert.equal(req.url, RUN_UPLOAD_PATH);
  assert.equal(req.method, 'POST');
  assert.equal(req.header.Authorization, 'Bearer t9');
  assert.equal(req.dataType, 'json');
  assert.equal(req.responseType, 'text');
  assert.equal('client_run_id' in req.data, false, '旧 RunIn 兼容路径不得携带新字段');
});

test('buildRunUploadRequest：device token 只走 AIUI 专用上传入口', () => {
  const req = buildRunUploadRequest({
    token: 'device-token', payload: {
      started_at: '2026-07-17T00:00:00.000Z', duration_s: 60, source: 'aiui',
    }, deviceToken: true,
  });
  assert.equal(req.url, `${DEFAULT_BASE_URL}${AIUI_RUN_UPLOAD_PATH}`);
  assert.equal(req.url, AIUI_RUN_UPLOAD_PATH);
  assert.equal(req.header.Authorization, 'Bearer device-token');
  assert.match(req.data.client_run_id, /^run-/);
});

test('aiui-runs payload 白名单化并钳制服务边界，剥离 GPS/raw/points', () => {
  const normalized = normalizeRunUploadPayload({
    started_at: '2026-07-17T08:00:00+08:00',
    ended_at: '2026-07-17T07:59:00+08:00',
    duration_s: 999999,
    distance_m: -9,
    avg_pace_s: 1,
    avg_hr: 260,
    max_hr: 30,
    cadence_avg: 999,
    workout_type: 'unknown',
    source: 'forged',
    points: [{ lat: 1 }], gps: 'x', raw: { secret: true },
  });
  assert.equal(normalized.started_at, '2026-07-17T00:00:00.000Z');
  assert.equal('ended_at' in normalized, false, '早于开始的结束时间直接省略');
  assert.equal(normalized.duration_s, 86400);
  assert.equal(normalized.distance_m, 0);
  assert.equal(normalized.avg_pace_s, 60);
  assert.equal(normalized.avg_hr, 240);
  assert.equal(normalized.max_hr, 240, 'max 不得小于 avg');
  assert.equal(normalized.cadence_avg, 300);
  assert.equal(normalized.workout_type, 'free');
  assert.equal(normalized.source, 'aiui');
  assert.equal('points' in normalized || 'gps' in normalized || 'raw' in normalized, false);
  assert.equal(normalizeRunUploadPayload({ started_at: 'bad', duration_s: 60 }), null);
  assert.equal(isPermanentRunUploadRejection(400), true);
  assert.equal(isPermanentRunUploadRejection(409), true);
  assert.equal(isPermanentRunUploadRejection(422), true);
  assert.equal(isPermanentRunUploadRejection(401), false);
  assert.equal(isPermanentRunUploadRejection(429), false);
});

test('parseRunUploadResponse：200+id → id;401/无 id/空 → null', () => {
  assert.equal(parseRunUploadResponse({ statusCode: 200, data: { id: 42, source: 'aiui' } }), 42);
  assert.equal(parseRunUploadResponse({ statusCode: 401, data: { id: 42 } }), null);
  assert.equal(parseRunUploadResponse({ statusCode: 200, data: {} }), null);
  assert.equal(parseRunUploadResponse(null), null);
});

test('待传队列：队列已满或 storage 损坏都 fail closed，不丢旧证据', () => {
  const s = fakeStorage();
  for (let i = 1; i <= PENDING_RUNS_MAX; i += 1) assert.ok(enqueueRunUpload(s, {
    started_at: new Date(START + i * 60000).toISOString(),
    duration_s: 60, distance_m: i, n: i,
  }));
  const q = readPendingRunUploads(s);
  assert.equal(q.length, PENDING_RUNS_MAX);
  assert.equal(q[0].distance_m, 1);
  assert.equal(q[PENDING_RUNS_MAX - 1].distance_m, PENDING_RUNS_MAX);
  assert.equal(enqueueRunUpload(s, {
    started_at: new Date(START + (PENDING_RUNS_MAX + 1) * 60000).toISOString(),
    duration_s: 60, distance_m: PENDING_RUNS_MAX + 1,
  }), null, '队列已满必须拒绝新写入，不淘汰未 ACK 旧跑步');
  assert.equal(readPendingRunUploads(s)[0].distance_m, 1);
  writePendingRunUploads(s, []);
  assert.equal(s.store.has(PENDING_RUNS_KEY), false);
  // 损坏数据
  s.setStorageSync(PENDING_RUNS_KEY, 'garbage');
  assert.deepEqual(readPendingRunUploads(s), []);
  assert.equal(readPendingRunUploadsState(s).ok, false);
  assert.equal(enqueueRunUpload(s, {
    started_at: new Date(START).toISOString(), duration_s: 60,
  }), null);
  assert.equal(s.store.get(PENDING_RUNS_KEY), 'garbage', '损坏原值不得被空队列覆盖');
  assert.deepEqual(readPendingRunUploads(null), []);
  assert.equal(readPendingRunUploadsState(null).ok, false);
});

test('队列数组中的无效或重复记录不会被静默删除', () => {
  const s = fakeStorage();
  const valid = normalizeRunUploadPayload({
    started_at: '2026-07-17T00:00:00.000Z', duration_s: 60, distance_m: 100,
  });
  const invalidRaw = [valid, { started_at: 'bad', duration_s: 60 }];
  s.setStorageSync(PENDING_RUNS_KEY, invalidRaw);
  assert.equal(readPendingRunUploadsState(s).ok, false);
  assert.deepEqual(s.store.get(PENDING_RUNS_KEY), invalidRaw);

  s.setStorageSync(PENDING_RUNS_KEY, [valid, { ...valid }]);
  assert.equal(readPendingRunUploadsState(s).ok, false);
  assert.equal(s.store.get(PENDING_RUNS_KEY).length, 2);
});

test('待传跑步写入与 ACK 必须写后读回，静默 no-op 不置成功', () => {
  const payload = {
    started_at: '2026-07-17T00:00:00.000Z', duration_s: 60, distance_m: 100,
  };
  const enqueueSilent = fakeStorage();
  enqueueSilent.setStorageSync = () => {};
  assert.equal(enqueueRunUpload(enqueueSilent, payload), null);
  assert.deepEqual(readPendingRunUploads(enqueueSilent), []);

  const ackSilent = fakeStorage();
  const first = enqueueRunUpload(ackSilent, payload)[0];
  ackSilent.removeStorageSync = () => {};
  assert.equal(removePendingRunUpload(ackSilent, first), null);
  assert.equal(readPendingRunUploads(ackSilent).length, 1,
    '远端已确认但本地删除未落盘时保留同一 client_run_id 重试');

  const throwing = fakeStorage();
  throwing.setStorageSync = () => { throw new Error('quota'); };
  assert.equal(enqueueRunUpload(throwing, payload), null);
});

test('写成功但首次读回失败后重试按 client_run_id 去重，不产生本地重复跑步', () => {
  const s = fakeStorage();
  const payload = {
    started_at: '2026-07-17T00:00:00.000Z', duration_s: 60, distance_m: 100,
  };
  const baseGet = s.getStorageSync.bind(s);
  let reads = 0;
  s.getStorageSync = (key) => {
    reads += 1;
    if (reads === 2) throw new Error('transient readback failure');
    return baseGet(key);
  };
  assert.equal(enqueueRunUpload(s, payload), null);
  assert.equal(s.store.get(PENDING_RUNS_KEY).length, 1, '第一次物理写入其实已经发生');

  const retried = enqueueRunUpload(s, payload);
  assert.equal(retried.length, 1);
  assert.equal(retried[0].client_run_id, s.store.get(PENDING_RUNS_KEY)[0].client_run_id);
});
