import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCurrentWorkoutRequest,
  normalizeWorkoutPlan,
  parseCurrentWorkoutResponse,
  sameWorkoutPrescription,
  CURRENT_WORKOUT_PATH,
} from '../lib/workout_contract.js';
import {
  clearCachedWorkout,
  readCachedWorkout,
  writeCachedWorkout,
  WORKOUT_PLAN_CACHE_KEY,
} from '../lib/workout_cache.js';
import { OWNER_SCOPED_STORAGE_KEYS } from '../lib/device_identity.js';

const NOW = Date.parse('2026-08-07T10:00:00.000Z');
const OWNER = {
  ownershipEpoch: 4,
  dataNamespace: 'owner:4:test',
  publicDeviceId: 'SR-PLAN-0001',
};

function plan(overrides = {}) {
  return {
    schema_version: 2,
    workout_id: 'wrk_0123456789abcdef01234567',
    plan_id: 'plan_123',
    plan_session_id: 'ps_89abcdef0123456789abcdef',
    revision: 12,
    type: 'easy',
    title: '轻松跑',
    scheduled_date: '2026-08-07',
    status: 'planned',
    target: {
      duration_sec: 1800,
      distance_m: null,
      pace_min_sec_per_km: null,
      pace_max_sec_per_km: null,
      heart_zone_min: 2,
      heart_zone_max: 3,
      cadence_min_spm: null,
      cadence_max_spm: null,
    },
    stages: [{
      stage_id: 'stg_abcdef0123456789abcdef01', order: 0, type: 'work', title: '轻松跑',
      duration_sec: 1800, distance_m: null,
      pace_min_sec_per_km: null, pace_max_sec_per_km: null,
      heart_zone_min: 2, heart_zone_max: 3,
      cadence_min_spm: null, cadence_max_spm: null,
    }],
    issued_at_ms: NOW - 10_000,
    expires_at_ms: NOW + 86_400_000,
    ownership_epoch: OWNER.ownershipEpoch,
    data_namespace: OWNER.dataNamespace,
    ...overrides,
  };
}

function response(value = plan(), owner = OWNER) {
  return {
    statusCode: 200,
    data: {
      available: true,
      plan: value,
      ownership_epoch: owner.ownershipEpoch,
      data_namespace: owner.dataNamespace,
      public_device_id: owner.publicDeviceId,
    },
  };
}

function storage() {
  const map = new Map();
  const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  return {
    map,
    getStorageSync(key) { return map.has(key) ? copy(map.get(key)) : undefined; },
    setStorageSync(key, value) { map.set(key, copy(value)); },
    removeStorageSync(key) { map.delete(key); },
  };
}

test('schema v2 严格白名单解析；未知版本、跨 owner 与过期计划 fail closed', () => {
  const parsed = parseCurrentWorkoutResponse(response(), OWNER, { nowMs: NOW });
  assert.equal(parsed.available, true);
  assert.equal(parsed.plan.stages.length, 1);
  assert.equal(Object.isFrozen(parsed.plan), true);
  assert.equal(normalizeWorkoutPlan(plan({ schema_version: 3 }), OWNER, { nowMs: NOW }), null);
  assert.equal(normalizeWorkoutPlan(plan({ expires_at_ms: NOW }), OWNER, { nowMs: NOW }), null);
  assert.equal(parseCurrentWorkoutResponse(response(plan(), {
    ...OWNER, dataNamespace: 'another-owner',
  }), OWNER, { nowMs: NOW }), null);
  for (const status of ['skipped', 'completed', 'partial']) {
    assert.equal(normalizeWorkoutPlan(plan({ status }), OWNER, { nowMs: NOW }), null);
    assert.equal(
      parseCurrentWorkoutResponse(response(plan({ status })), OWNER, { nowMs: NOW }).executable,
      false,
    );
  }
  const textResponse = response();
  textResponse.data = JSON.stringify(textResponse.data);
  assert.equal(parseCurrentWorkoutResponse(textResponse, OWNER, { nowMs: NOW }).available, true);
});

test('current-workout 顶层心率策略独立解析，缺失或损坏不阻断计划', () => {
  const validPolicy = {
    schema_version: 1,
    max_hr_bpm: 198,
    source: 'garmin_profile',
    issued_at_ms: NOW - 1000,
    expires_at_ms: NOW + 60_000,
  };
  const validResponse = response();
  validResponse.data.heart_rate_policy = validPolicy;
  const parsed = parseCurrentWorkoutResponse(validResponse, OWNER, { nowMs: NOW });
  assert.deepEqual(parsed.heartRatePolicy, validPolicy);

  const invalidResponse = response();
  invalidResponse.data.heart_rate_policy = { ...validPolicy, max_hr_bpm: 119 };
  const invalid = parseCurrentWorkoutResponse(invalidResponse, OWNER, { nowMs: NOW });
  assert.equal(invalid.executable, true);
  assert.equal(invalid.heartRatePolicy, null);

  for (const invalidPolicy of [
    { ...validPolicy, trusted: true },
    {
      ...validPolicy,
      issued_at_ms: NOW + 60_001,
      expires_at_ms: NOW + 120_000,
    },
    {
      ...validPolicy,
      expires_at_ms: validPolicy.issued_at_ms + 7 * 24 * 60 * 60 * 1000 + 1,
    },
  ]) {
    const policyFailureResponse = response();
    policyFailureResponse.data.heart_rate_policy = invalidPolicy;
    const policyFailure = parseCurrentWorkoutResponse(policyFailureResponse, OWNER, {
      nowMs: NOW,
    });
    assert.equal(policyFailure.executable, true, '心率策略失败不得阻断有效训练计划');
    assert.equal(policyFailure.heartRatePolicy, null);
  }
});

test('无今日计划时仍可取得顶层心率策略', () => {
  const heartRatePolicy = {
    schema_version: 1,
    max_hr_bpm: 188,
    source: 'age_estimate',
    issued_at_ms: NOW - 1000,
    expires_at_ms: NOW + 60_000,
  };
  const parsed = parseCurrentWorkoutResponse({
    statusCode: 200,
    data: {
      available: false,
      plan: null,
      ownership_epoch: OWNER.ownershipEpoch,
      data_namespace: OWNER.dataNamespace,
      public_device_id: OWNER.publicDeviceId,
      heart_rate_policy: heartRatePolicy,
    },
  }, OWNER, { nowMs: NOW });
  assert.equal(parsed.available, false);
  assert.deepEqual(parsed.heartRatePolicy, heartRatePolicy);
});

test('跨端 ID 必须严格采用 Hermes/Android canonical grammar', () => {
  assert.ok(normalizeWorkoutPlan(plan({ plan_id: 'plan_1' }), OWNER, { nowMs: NOW }));
  assert.ok(normalizeWorkoutPlan(
    plan({ plan_id: 'plan_9999999999999999999' }),
    OWNER,
    { nowMs: NOW },
  ));
  for (const workoutId of [
    'wrk_today_0001',
    'wrk_0123456789ABCDEF01234567',
    'wrk_0123456789abcdef0123456',
    'wrk_0123456789abcdef012345678',
    ' wrk_0123456789abcdef01234567 ',
  ]) {
    assert.equal(
      normalizeWorkoutPlan(plan({ workout_id: workoutId }), OWNER, { nowMs: NOW }),
      null,
      workoutId,
    );
  }
  for (const planId of [
    'plan_0',
    'plan_01',
    'plan_complete',
    'plan_12345678901234567890',
    ' plan_123 ',
  ]) {
    assert.equal(
      normalizeWorkoutPlan(plan({ plan_id: planId }), OWNER, { nowMs: NOW }),
      null,
      planId,
    );
  }
  for (const planSessionId of [
    'ps_today_0001',
    'ps_89ABCDEF0123456789abcdef',
    'ps_89abcdef0123456789abcde',
    ' ps_89abcdef0123456789abcdef ',
  ]) {
    assert.equal(
      normalizeWorkoutPlan(
        plan({ plan_session_id: planSessionId }),
        OWNER,
        { nowMs: NOW },
      ),
      null,
      planSessionId,
    );
  }
  for (const stageId of [
    'stg_work_0001',
    'stg_ABCDEF0123456789abcdef01',
    'stg_abcdef0123456789abcdef0',
    ' stg_abcdef0123456789abcdef01 ',
  ]) {
    assert.equal(normalizeWorkoutPlan(plan({
      stages: [{ ...plan().stages[0], stage_id: stageId }],
    }), OWNER, { nowMs: NOW }), null, stageId);
  }
});

test('服务端 slow_jog 保留为可执行类型，未知运动类型仍 fail closed', () => {
  const slowJog = normalizeWorkoutPlan(plan({
    type: 'slow_jog',
    title: '超慢跑',
  }), OWNER, { nowMs: NOW });
  assert.equal(slowJog.type, 'slow_jog');
  for (const type of ['free', 'easy', 'recovery', 'steady', 'tempo', 'interval', 'long']) {
    assert.equal(normalizeWorkoutPlan(plan({ type }), OWNER, { nowMs: NOW }).type, type);
  }
  assert.equal(normalizeWorkoutPlan(plan({ type: 'rest' }), OWNER, { nowMs: NOW }), null);
  for (const legacyAlias of ['stationary', 'threshold', 'intervals', 'fartlek', 'lsd']) {
    assert.equal(
      normalizeWorkoutPlan(plan({ type: legacyAlias }), OWNER, { nowMs: NOW }),
      null,
      legacyAlias + ' 必须由 Hermes 规范化后再下发',
    );
  }
  assert.equal(normalizeWorkoutPlan(plan({ type: 'mystery_run' }), OWNER, { nowMs: NOW }), null);
});

test('阶段必须连续、唯一、有明确完成边界且数字不隐式强转', () => {
  assert.equal(normalizeWorkoutPlan(plan({
    stages: [{ ...plan().stages[0], order: 1 }],
  }), OWNER, { nowMs: NOW }), null);
  assert.equal(normalizeWorkoutPlan(plan({
    stages: [{ ...plan().stages[0], duration_sec: '1800' }],
  }), OWNER, { nowMs: NOW }), null);
  assert.equal(normalizeWorkoutPlan(plan({
    stages: [{ ...plan().stages[0], duration_sec: null, distance_m: null }],
  }), OWNER, { nowMs: NOW }), null);
  assert.equal(normalizeWorkoutPlan(plan({
    stages: [plan().stages[0], { ...plan().stages[0], order: 1 }],
  }), OWNER, { nowMs: NOW }), null, 'stage_id 注入/重复不得通过');
  assert.equal(normalizeWorkoutPlan(plan({
    stages: [{ ...plan().stages[0], cadence_min_spm: 39 }],
  }), OWNER, { nowMs: NOW }), null);
});

test('聚合目标与间歇阶段使用不同下界：30 秒可执行，5 秒/10 米 fail closed', () => {
  const thirtySecondStage = {
    ...plan().stages[0],
    duration_sec: 30,
    distance_m: null,
  };
  assert.equal(normalizeWorkoutPlan(plan({
    stages: [thirtySecondStage],
  }), OWNER, { nowMs: NOW }).stages[0].duration_sec, 30);
  assert.equal(normalizeWorkoutPlan(plan({
    stages: [{ ...thirtySecondStage, duration_sec: 5 }],
  }), OWNER, { nowMs: NOW }), null);
  assert.equal(normalizeWorkoutPlan(plan({
    stages: [{ ...thirtySecondStage, duration_sec: null, distance_m: 10 }],
  }), OWNER, { nowMs: NOW }), null);
  assert.equal(normalizeWorkoutPlan(plan({
    target: { ...plan().target, duration_sec: 30 },
    stages: [thirtySecondStage],
  }), OWNER, { nowMs: NOW }), null, '整体训练仍至少 60 秒');
});

test('legacy schema v1 只能成为建议，绝不把 prose 或 aggregate 变成可执行阶段', () => {
  const legacy = parseCurrentWorkoutResponse(response({
    schema_version: 1,
    workout_id: 'wrk_fedcba9876543210fedcba98',
    title: '8x400m',
    type: 'interval',
    target: { duration_sec: 1800 },
    stages: [],
  }), OWNER, { nowMs: NOW });
  assert.equal(legacy.available, false);
  assert.equal(legacy.executable, false);
  assert.deepEqual(legacy.legacySuggestion, {
    schema_version: 1, title: '8x400m', type: 'interval', executable: false,
  });
});

test('current-workout 请求显式 text/json、Bearer、no-store 与公网路径', () => {
  const request = buildCurrentWorkoutRequest({ token: 'device-token-1234' });
  assert.equal(request.url.endsWith(CURRENT_WORKOUT_PATH), true);
  assert.equal(request.method, 'GET');
  assert.equal(request.responseType, 'text');
  assert.equal(request.dataType, 'json');
  assert.equal(request.header.Authorization, 'Bearer device-token-1234');
  assert.equal(request.header['Cache-Control'], 'no-store');
});

test('JIT 开跑只接受同一 owner/revision/处方内容，允许状态与 freshness 前进', () => {
  const displayed = normalizeWorkoutPlan(plan(), OWNER, { nowMs: NOW });
  const refreshed = normalizeWorkoutPlan(plan({
    status: 'accepted',
    issued_at_ms: NOW - 1000,
    expires_at_ms: NOW + 2 * 60 * 60 * 1000,
  }), OWNER, { nowMs: NOW });
  assert.equal(sameWorkoutPrescription(displayed, refreshed), true);
  assert.equal(sameWorkoutPrescription(displayed, {
    ...refreshed,
    revision: refreshed.revision + 1,
  }), false);
  assert.equal(sameWorkoutPrescription(displayed, {
    ...refreshed,
    data_namespace: 'owner:5:changed',
  }), false);
  assert.equal(sameWorkoutPrescription(displayed, {
    ...refreshed,
    stages: [{ ...refreshed.stages[0], duration_sec: 1790 }],
  }), false, '同 revision 偷换阶段目标也必须 fail closed');
});

test('计划缓存写后读回、owner/expiry/corruption 失效且归入 owner 清理集合', () => {
  const s = storage();
  assert.equal(writeCachedWorkout(s, plan(), OWNER, { nowMs: NOW }), true);
  assert.equal(readCachedWorkout(s, OWNER, { nowMs: NOW }).revision, 12);
  assert.equal(readCachedWorkout(s, { ...OWNER, ownershipEpoch: 5 }, { nowMs: NOW }), null);
  assert.equal(s.map.has(WORKOUT_PLAN_CACHE_KEY), false, '跨 owner 缓存立即清理');

  writeCachedWorkout(s, plan(), OWNER, { nowMs: NOW });
  assert.equal(readCachedWorkout(s, OWNER, { nowMs: NOW + 86_400_000 }), null);
  s.setStorageSync(WORKOUT_PLAN_CACHE_KEY, { schema_version: 1, plan: 'bad' });
  assert.equal(readCachedWorkout(s, OWNER, { nowMs: NOW }), null);
  assert.equal(clearCachedWorkout(s), true);
  assert.equal(OWNER_SCOPED_STORAGE_KEYS.includes(WORKOUT_PLAN_CACHE_KEY), true);
});

test('缓存 silent no-op 不得被误判成功', () => {
  const s = storage();
  s.setStorageSync = () => {};
  assert.equal(writeCachedWorkout(s, plan(), OWNER, { nowMs: NOW }), false);
});
