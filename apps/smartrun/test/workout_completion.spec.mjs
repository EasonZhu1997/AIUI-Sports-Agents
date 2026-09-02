import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkoutCompletion,
  buildWorkoutCompletionRequest,
  enqueueWorkoutCompletion,
  initializeWorkoutCompletionStorage,
  isPermanentWorkoutCompletionRejection,
  normalizeWorkoutCompletion,
  parseWorkoutCompletionResponse,
  readPendingWorkoutCompletions,
  readPendingWorkoutCompletionsState,
  readQuarantinedWorkoutCompletions,
  readQuarantinedWorkoutCompletionsState,
  quarantineWorkoutCompletion,
  removePendingWorkoutCompletion,
  WORKOUT_COMPLETION_QUARANTINE_KEY,
  WORKOUT_COMPLETION_QUARANTINE_STATE_KEY,
  WORKOUT_COMPLETION_QUEUE_KEY,
  WORKOUT_COMPLETION_QUEUE_STATE_KEY,
} from '../lib/workout_completion.js';
import { createWorkoutExecution, finishWorkoutExecution } from '../lib/workout_executor.js';
import { OWNER_SCOPED_STORAGE_KEYS } from '../lib/device_identity.js';

const START = Date.parse('2026-08-07T10:00:00.000Z');
const OWNER = { ownershipEpoch: 9, dataNamespace: 'ns-nine', publicDeviceId: 'SR-COMP-1' };
const WORKOUT_ID = 'wrk_777777777777777777777777';
const PLAN_ID = 'plan_33001';
const PLAN_SESSION_ID = 'ps_888888888888888888888888';
const STAGE_ID = 'stg_999999999999999999999999';

function plan() {
  const empty = {
    pace_min_sec_per_km: null, pace_max_sec_per_km: null,
    heart_zone_min: null, heart_zone_max: null,
    cadence_min_spm: null, cadence_max_spm: null,
  };
  return {
    schema_version: 2, workout_id: WORKOUT_ID, plan_id: PLAN_ID,
    plan_session_id: PLAN_SESSION_ID, revision: 33, type: 'easy', title: '轻松跑',
    scheduled_date: '2026-08-07', status: 'planned',
    target: { duration_sec: 60, distance_m: null, ...empty },
    stages: [{
      stage_id: STAGE_ID, order: 0, type: 'work', title: '轻松跑',
      duration_sec: 60, distance_m: null, ...empty,
    }],
    issued_at_ms: START - 1000, expires_at_ms: START + 86_400_000,
    ownership_epoch: OWNER.ownershipEpoch, data_namespace: OWNER.dataNamespace,
  };
}

function completedExecution() {
  let state = createWorkoutExecution(plan(), OWNER, {
    nowMs: START, clientExecutionId: 'exec-complete-01',
  });
  state.active_elapsed_ms = 60_000;
  state.stage_elapsed_ms = 60_000;
  state.stage_distance_m = 200;
  state.stage_results = [{
    stage_id: STAGE_ID, status: 'completed', duration_s: 60,
    distance_m: 200, avg_pace_s: 300, avg_hr: 145, cadence_avg: 168,
  }];
  state.status = 'plan_complete';
  state.final_prompt_pending = true;
  return finishWorkoutExecution(state, START + 60_000);
}

function storage() {
  const map = new Map();
  const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  return {
    map,
    getStorageSync(k) { return map.has(k) ? copy(map.get(k)) : undefined; },
    getStorage({ key, success, fail, complete }) {
      if (map.has(key)) success?.({ data: copy(map.get(key)) });
      else fail?.({ errMsg: 'Key not found' });
      complete?.();
    },
    setStorageSync(k, v) { map.set(k, copy(v)); },
    removeStorageSync(k) { map.delete(k); },
  };
}

test('完成 payload 关联 workout/revision/client_run_id 且严格剥离原始隐私字段', () => {
  const payload = buildWorkoutCompletion({
    execution: completedExecution(),
    clientRunId: 'run-linked-0001',
    summary: {
      duration_s: 60, distance_m: 200, avg_pace_s: 300,
      avg_hr: 145, max_hr: 170, cadence_avg: 168,
      gps: [{ latitude: 1 }], accelerometer: [1, 2], gyroscope: [3],
      route: 'secret', audio: 'secret', device_credential: 'secret',
    },
  });
  assert.equal(payload.workout_id, WORKOUT_ID);
  assert.equal(payload.plan_session_id, PLAN_SESSION_ID);
  assert.equal(payload.revision, 33);
  assert.equal(payload.client_run_id, 'run-linked-0001');
  const encoded = JSON.stringify(payload);
  for (const forbidden of [
    'latitude', 'accelerometer', 'gyroscope', 'route', 'audio', 'credential',
    'rpe', 'pain', 'training_context',
  ]) {
    assert.equal(encoded.includes(forbidden), false);
  }
  const withLegacyRpe = normalizeWorkoutCompletion({
    ...payload,
    allowed_stage_ids: [STAGE_ID],
    rpe: 6,
  });
  assert.ok(withLegacyRpe, 'old local queue input remains readable during upgrade');
  assert.equal('rpe' in withLegacyRpe, false,
    'new AIX normalization strips legacy RPE instead of sending it');
  assert.equal('rpe' in buildWorkoutCompletionRequest({
    token: 'device-token-1234',
    payload: { ...payload, rpe: 6 },
  }).data, false);
});

test('completion 与 durable FIFO 拒绝所有非 canonical 跨端 ID', () => {
  const payload = buildWorkoutCompletion({ execution: completedExecution() });
  assert.ok(payload);
  const withAllowedIds = {
    ...payload,
    allowed_stage_ids: [STAGE_ID],
  };
  for (const invalidWorkoutId of [
    'wrk_complete_01',
    'wrk_77777777777777777777777G',
    'wrk_77777777777777777777777',
  ]) {
    assert.equal(normalizeWorkoutCompletion({
      ...withAllowedIds,
      workout_id: invalidWorkoutId,
    }), null, invalidWorkoutId);
  }
  for (const invalidSessionId of [
    'ps_complete_01',
    'ps_88888888888888888888888G',
    'ps_88888888888888888888888',
  ]) {
    assert.equal(normalizeWorkoutCompletion({
      ...withAllowedIds,
      plan_session_id: invalidSessionId,
    }), null, invalidSessionId);
  }
  assert.equal(normalizeWorkoutCompletion({
    ...withAllowedIds,
    allowed_stage_ids: [STAGE_ID, 'stg_complete_01'],
  }), null, '一个合法 stage 混入一个非 canonical stage 也必须整体拒绝');

  const s = storage();
  assert.equal(enqueueWorkoutCompletion(s, payload, OWNER, {
    allowedStageIds: [STAGE_ID, 'stg_complete_01'],
  }), null);
  assert.equal(s.map.has(WORKOUT_COMPLETION_QUEUE_KEY), false);

  assert.equal(enqueueWorkoutCompletion(s, payload, OWNER).length, 1);
  const corrupted = s.map.get(WORKOUT_COMPLETION_QUEUE_KEY);
  corrupted[0].payload.workout_id = 'wrk_complete_01';
  s.map.set(WORKOUT_COMPLETION_QUEUE_KEY, corrupted);
  s.map.delete(WORKOUT_COMPLETION_QUEUE_STATE_KEY);
  const state = readPendingWorkoutCompletionsState(s, OWNER);
  assert.equal(state.ok, false);
  assert.equal(state.reason, 'storage_value_invalid');
  assert.equal(enqueueWorkoutCompletion(s, {
    ...payload,
    client_execution_id: 'exec-complete-new',
    client_run_id: 'run-complete-new',
  }, OWNER), null, '损坏记录必须 fail closed，不能被过滤后重新写入');
  assert.equal(s.map.get(WORKOUT_COMPLETION_QUEUE_KEY)[0].payload.workout_id,
    'wrk_complete_01');
});

test('completion 先写后读持久化，同 client_execution_id 幂等且冲突不覆盖', () => {
  const s = storage();
  const payload = buildWorkoutCompletion({ execution: completedExecution() });
  assert.equal(enqueueWorkoutCompletion(s, payload, OWNER).length, 1);
  assert.equal(enqueueWorkoutCompletion(s, payload, OWNER).length, 1);
  assert.equal(enqueueWorkoutCompletion(s, { ...payload, distance_m: 201 }, OWNER), null);
  assert.equal(readPendingWorkoutCompletions(s, OWNER).length, 1);
  assert.equal(readPendingWorkoutCompletions(s, { ...OWNER, ownershipEpoch: 10 }).length, 0);
  assert.equal(OWNER_SCOPED_STORAGE_KEYS.includes(WORKOUT_COMPLETION_QUEUE_KEY), true);
  assert.equal(OWNER_SCOPED_STORAGE_KEYS.includes(WORKOUT_COMPLETION_QUARANTINE_KEY), true);
});

test('只有显式成功 receipt 才精确 ACK；401/409/422/429/5xx 都不算成功', () => {
  const s = storage();
  const payload = buildWorkoutCompletion({ execution: completedExecution() });
  enqueueWorkoutCompletion(s, payload, OWNER);
  for (const statusCode of [0, 401, 409, 422, 429, 500, 503]) {
    assert.equal(parseWorkoutCompletionResponse({
      statusCode, data: { accepted: true, execution_id: 'wex-1' },
    }), null);
    assert.equal(readPendingWorkoutCompletions(s, OWNER).length, 1);
  }
  const receipt = parseWorkoutCompletionResponse({
    statusCode: 200,
    data: {
      accepted: true, execution_id: 'wex-server-1', duplicate: true,
      next_plan_refresh_required: true,
    },
  });
  assert.deepEqual(receipt, {
    executionId: 'wex-server-1', duplicate: true, nextPlanRefreshRequired: true,
  });
  assert.deepEqual(parseWorkoutCompletionResponse({
    statusCode: 200,
    data: JSON.stringify({ accepted: true, execution_id: 'wex-text-1' }),
  }), {
    executionId: 'wex-text-1', duplicate: false, nextPlanRefreshRequired: false,
  });
  const item = readPendingWorkoutCompletions(s, OWNER)[0];
  assert.deepEqual(removePendingWorkoutCompletion(s, item, OWNER), []);
});

test('completed/partial 整场至少 1 秒，aborted 整场可 0 秒但阶段必须 skipped', () => {
  const completed = buildWorkoutCompletion({ execution: completedExecution() });
  assert.equal(buildWorkoutCompletion({
    execution: { ...completedExecution(), active_elapsed_ms: 0 },
    summary: { duration_s: 0, distance_m: 0 },
  }).duration_s, 1, '本地 builder 不得生成后端必拒的 0 秒 partial/completed');
  const aborted = completedExecution();
  aborted.outcome = 'aborted';
  aborted.active_elapsed_ms = 0;
  aborted.started_at_ms = START;
  aborted.ended_at_ms = START;
  aborted.stage_results = [{
    stage_id: STAGE_ID, status: 'skipped', duration_s: 0, distance_m: 0,
  }];
  assert.equal(buildWorkoutCompletion({
    execution: aborted,
    summary: { duration_s: 0, distance_m: 0 },
  }).duration_s, 0);
  assert.equal(buildWorkoutCompletion({
    execution: {
      ...aborted,
      stage_results: [{
        stage_id: STAGE_ID, status: 'aborted', duration_s: 0, distance_m: 0,
      }],
    },
  }), null, '阶段级 aborted 必须 fail closed');
  assert.ok(completed);
});

test('请求使用 device Bearer 与 text/json；内部 plan_session_id 不扩展服务端契约', () => {
  const payload = buildWorkoutCompletion({ execution: completedExecution() });
  const request = buildWorkoutCompletionRequest({ token: 'device-token-1234', payload });
  assert.equal(request.method, 'POST');
  assert.equal(request.url.endsWith('/' + WORKOUT_ID + '/complete'), true);
  assert.equal(request.header.Authorization, 'Bearer device-token-1234');
  assert.equal(request.responseType, 'text');
  assert.equal(request.dataType, 'json');
  assert.equal('workout_id' in request.data, false);
  assert.equal('plan_session_id' in request.data, false);
});

test('storage silent no-op 不能假装完成已持久化或 ACK', () => {
  const payload = buildWorkoutCompletion({ execution: completedExecution() });
  const silent = storage();
  silent.setStorageSync = () => {};
  assert.equal(enqueueWorkoutCompletion(silent, payload, OWNER), null);

  const ackSilent = storage();
  enqueueWorkoutCompletion(ackSilent, payload, OWNER);
  const item = readPendingWorkoutCompletions(ackSilent, OWNER)[0];
  const setStorageSync = ackSilent.setStorageSync.bind(ackSilent);
  ackSilent.setStorageSync = (key, value) => {
    if (key !== WORKOUT_COMPLETION_QUEUE_KEY) setStorageSync(key, value);
  };
  assert.equal(removePendingWorkoutCompletion(ackSilent, item, OWNER), null);
  assert.equal(readPendingWorkoutCompletions(ackSilent, OWNER).length, 1);

  const removeNoop = storage();
  enqueueWorkoutCompletion(removeNoop, payload, OWNER);
  removeNoop.removeStorageSync = () => {};
  const removeNoopItem = readPendingWorkoutCompletions(removeNoop, OWNER)[0];
  assert.deepEqual(removePendingWorkoutCompletion(removeNoop, removeNoopItem, OWNER), []);
  assert.deepEqual(readPendingWorkoutCompletions(removeNoop, OWNER), [],
    'ACK 使用 verified empty state，不依赖可能静默 no-op 的 removeStorageSync');
});

test('completion mutation 遇到瞬时读取异常时停止覆盖既有 FIFO', () => {
  const s = storage();
  const first = buildWorkoutCompletion({ execution: completedExecution() });
  const second = {
    ...first,
    client_execution_id: 'exec-complete-02',
    client_run_id: 'run-complete-02',
  };
  assert.equal(enqueueWorkoutCompletion(s, first, OWNER).length, 1);
  const getStorageSync = s.getStorageSync.bind(s);
  let failOnce = true;
  s.getStorageSync = (key) => {
    if (key === WORKOUT_COMPLETION_QUEUE_KEY && failOnce) {
      failOnce = false;
      throw new Error('transient read failure');
    }
    return getStorageSync(key);
  };
  assert.equal(enqueueWorkoutCompletion(s, second, OWNER), null);
  assert.deepEqual(readPendingWorkoutCompletions(s, OWNER).map(
    (item) => item.client_execution_id,
  ), ['exec-complete-01']);
});

test('completion mutation 二次读取恢复单次 silent empty，且损坏记录不被清洗覆盖', () => {
  const s = storage();
  const first = buildWorkoutCompletion({ execution: completedExecution() });
  const second = {
    ...first,
    client_execution_id: 'exec-complete-02',
    client_run_id: 'run-complete-02',
  };
  assert.equal(enqueueWorkoutCompletion(s, first, OWNER).length, 1);
  const getStorageSync = s.getStorageSync.bind(s);
  let hideOnce = true;
  s.getStorageSync = (key) => {
    if (key === WORKOUT_COMPLETION_QUEUE_KEY && hideOnce) {
      hideOnce = false;
      return undefined;
    }
    return getStorageSync(key);
  };
  assert.equal(enqueueWorkoutCompletion(s, second, OWNER).length, 2);

  const corrupted = s.map.get(WORKOUT_COMPLETION_QUEUE_KEY);
  corrupted.push({ invalid: true });
  s.map.set(WORKOUT_COMPLETION_QUEUE_KEY, corrupted);
  const third = {
    ...first,
    client_execution_id: 'exec-complete-03',
    client_run_id: 'run-complete-03',
  };
  assert.equal(enqueueWorkoutCompletion(s, third, OWNER), null);
  assert.equal(s.map.get(WORKOUT_COMPLETION_QUEUE_KEY).length, 3,
    '损坏证据必须原样保留，不能过滤后覆盖');
});

test('目标键持续 silent undefined 时由专属镜像恢复 FIFO，不误判首次空队列', () => {
  const s = storage();
  const first = buildWorkoutCompletion({ execution: completedExecution() });
  const second = {
    ...first,
    client_execution_id: 'exec-complete-02',
    client_run_id: 'run-complete-02',
  };
  assert.equal(enqueueWorkoutCompletion(s, first, OWNER).length, 1);
  assert.equal(s.map.has(WORKOUT_COMPLETION_QUEUE_STATE_KEY), true);
  const getStorageSync = s.getStorageSync.bind(s);
  s.getStorageSync = (key) => key === WORKOUT_COMPLETION_QUEUE_KEY
    ? undefined : getStorageSync(key);

  const visible = readPendingWorkoutCompletionsState(s, OWNER);
  assert.equal(visible.ok, true);
  assert.deepEqual(visible.items.map((item) => item.client_execution_id), [
    'exec-complete-01',
  ]);
  assert.equal(enqueueWorkoutCompletion(s, second, OWNER), null,
    '目标键不可验证写回时必须保留镜像证据，不能覆盖成只有新记录');
  assert.deepEqual(s.map.get(WORKOUT_COMPLETION_QUEUE_KEY).map(
    (item) => item.client_execution_id,
  ), ['exec-complete-01'],
    '写前发现目标键不可验证就必须停止，不能制造半写事务');
  assert.deepEqual(readPendingWorkoutCompletions(s, OWNER).map(
    (item) => item.client_execution_id,
  ), ['exec-complete-01'],
    '公开读取保守返回最后一次完整提交的镜像，不复活半写事务');
});

test('未建镜像的 legacy 目标静默读取时用 async 精确键读取迁移，不覆盖旧 FIFO', async () => {
  const s = storage();
  const first = buildWorkoutCompletion({ execution: completedExecution() });
  const seed = storage();
  assert.equal(enqueueWorkoutCompletion(seed, first, OWNER).length, 1);
  s.map.set(WORKOUT_COMPLETION_QUEUE_KEY, seed.map.get(WORKOUT_COMPLETION_QUEUE_KEY));
  const getStorageSync = s.getStorageSync.bind(s);
  s.getStorageSync = (key) => key === WORKOUT_COMPLETION_QUEUE_KEY
    ? undefined : getStorageSync(key);

  assert.equal(await initializeWorkoutCompletionStorage(s), true);
  assert.equal(s.map.has(WORKOUT_COMPLETION_QUEUE_STATE_KEY), true);
  assert.deepEqual(readPendingWorkoutCompletions(s, OWNER).map(
    (item) => item.client_execution_id,
  ), ['exec-complete-01']);
});

test('有效镜像且目标键精确缺失时初始化恢复 FIFO，后续 ACK 与追加仍可提交', async () => {
  const s = storage();
  const first = buildWorkoutCompletion({ execution: completedExecution() });
  const second = {
    ...first,
    client_execution_id: 'exec-complete-02',
    client_run_id: 'run-complete-02',
  };
  assert.equal(enqueueWorkoutCompletion(s, first, OWNER).length, 1);
  const firstItem = readPendingWorkoutCompletions(s, OWNER)[0];
  assert.equal(quarantineWorkoutCompletion(s, firstItem, 409, {
    nowMs: START + 90_000,
  }), true);
  s.map.delete(WORKOUT_COMPLETION_QUEUE_KEY);
  s.map.delete(WORKOUT_COMPLETION_QUARANTINE_KEY);

  assert.equal(await initializeWorkoutCompletionStorage(s), true);
  assert.equal(s.map.get(WORKOUT_COMPLETION_QUEUE_KEY).length, 1);
  assert.equal(s.map.get(WORKOUT_COMPLETION_QUARANTINE_KEY).length, 1);
  assert.equal(removePendingWorkoutCompletion(s, firstItem.payload, OWNER).length, 0);
  assert.equal(enqueueWorkoutCompletion(s, second, OWNER).length, 1);
  assert.deepEqual(readPendingWorkoutCompletions(s, OWNER).map(
    (item) => item.client_execution_id,
  ), ['exec-complete-02']);
});

test('pending/quarantine 镜像损坏或读取异常公开为 unknown，不折叠成空数组', () => {
  const s = storage();
  const payload = buildWorkoutCompletion({ execution: completedExecution() });
  assert.equal(enqueueWorkoutCompletion(s, payload, OWNER).length, 1);
  const item = readPendingWorkoutCompletions(s, OWNER)[0];
  assert.equal(quarantineWorkoutCompletion(s, item, 409, {
    nowMs: START + 90_000,
  }), true);

  s.map.set(WORKOUT_COMPLETION_QUEUE_STATE_KEY, { malformed: true });
  const pendingState = readPendingWorkoutCompletionsState(s, OWNER);
  assert.equal(pendingState.ok, false);
  assert.equal(pendingState.reason, 'storage_state_invalid');
  assert.equal(readPendingWorkoutCompletions(s, OWNER), null);

  const getStorageSync = s.getStorageSync.bind(s);
  s.getStorageSync = (key) => {
    if (key === WORKOUT_COMPLETION_QUARANTINE_KEY) throw new Error('read failed');
    return getStorageSync(key);
  };
  const quarantineState = readQuarantinedWorkoutCompletionsState(s, OWNER);
  assert.equal(quarantineState.ok, false);
  assert.equal(quarantineState.reason, 'storage_read_failed');
  assert.equal(readQuarantinedWorkoutCompletions(s, OWNER), null);
  assert.equal(s.map.has(WORKOUT_COMPLETION_QUARANTINE_STATE_KEY), true);
});

test('quarantine mutation 遇到读取异常时不覆盖既有隔离证据', () => {
  const s = storage();
  const first = buildWorkoutCompletion({ execution: completedExecution() });
  const second = {
    ...first,
    client_execution_id: 'exec-complete-02',
    client_run_id: 'run-complete-02',
  };
  enqueueWorkoutCompletion(s, first, OWNER);
  enqueueWorkoutCompletion(s, second, OWNER);
  const items = readPendingWorkoutCompletions(s, OWNER);
  assert.equal(quarantineWorkoutCompletion(s, items[0], 409, {
    nowMs: START + 90_000,
  }), true);
  const getStorageSync = s.getStorageSync.bind(s);
  let failOnce = true;
  s.getStorageSync = (key) => {
    if (key === WORKOUT_COMPLETION_QUARANTINE_KEY && failOnce) {
      failOnce = false;
      throw new Error('transient quarantine read failure');
    }
    return getStorageSync(key);
  };
  assert.equal(quarantineWorkoutCompletion(s, items[1], 422, {
    nowMs: START + 91_000,
  }), false);
  assert.deepEqual(readQuarantinedWorkoutCompletions(s, OWNER).map(
    (entry) => entry.item.client_execution_id,
  ), ['exec-complete-01']);
});

test('400/409/422 永久拒绝先写后读隔离，owner 不串且写失败不准 ACK', () => {
  for (const statusCode of [400, 409, 422]) {
    assert.equal(isPermanentWorkoutCompletionRejection(statusCode), true);
  }
  for (const statusCode of [0, 401, 429, 500, 503]) {
    assert.equal(isPermanentWorkoutCompletionRejection(statusCode), false);
  }

  const s = storage();
  const payload = buildWorkoutCompletion({ execution: completedExecution() });
  enqueueWorkoutCompletion(s, payload, OWNER);
  const item = readPendingWorkoutCompletions(s, OWNER)[0];
  assert.equal(quarantineWorkoutCompletion(s, item, 409, { nowMs: START + 90_000 }), true);
  const quarantined = readQuarantinedWorkoutCompletions(s, OWNER);
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0].item.client_execution_id, 'exec-complete-01');
  assert.equal(quarantined[0].status_code, 409);
  assert.equal(quarantined[0].quarantined_at_ms, START + 90_000);
  assert.equal(readQuarantinedWorkoutCompletions(
    s,
    { ...OWNER, ownershipEpoch: 10 },
  ).length, 0);
  assert.deepEqual(removePendingWorkoutCompletion(s, item, OWNER), []);

  const silent = storage();
  enqueueWorkoutCompletion(silent, payload, OWNER);
  const silentItem = readPendingWorkoutCompletions(silent, OWNER)[0];
  const setStorageSync = silent.setStorageSync;
  silent.setStorageSync = (key, value) => {
    if (key !== WORKOUT_COMPLETION_QUARANTINE_KEY) setStorageSync(key, value);
  };
  assert.equal(quarantineWorkoutCompletion(silent, silentItem, 422), false);
  assert.equal(readPendingWorkoutCompletions(silent, OWNER).length, 1);
  assert.equal(readQuarantinedWorkoutCompletions(silent, OWNER), null,
    '隔离区初始化写入不可验证时必须公开 unknown，不能假装为空');
});
