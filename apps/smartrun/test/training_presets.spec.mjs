import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTrainingPreset,
  TRAINING_PRESET_IDS,
} from '../lib/training_presets.js';
import { normalizeWorkoutPlan } from '../lib/workout_contract.js';

const NOW = Date.parse('2026-08-07T10:00:00.000Z');
const OWNER = {
  ownership_epoch: 8,
  data_namespace: 'owner:8:manual-training',
  public_device_id: 'SR-MANUAL-0001',
};

const EXPECTED = {
  easy: {
    title: '轻松跑',
    durations: [300, 1200, 300],
    types: ['warmup', 'work', 'cooldown'],
  },
  long: {
    title: 'LSD长距离跑',
    durations: [300, 2400, 300],
    types: ['warmup', 'work', 'cooldown'],
  },
  fartlek: {
    title: '法特莱克跑',
    durations: [480, ...Array.from({ length: 6 }, () => [60, 120]).flat(), 300],
    types: ['warmup', ...Array.from({ length: 6 }, () => ['work', 'recovery']).flat(), 'cooldown'],
  },
  interval: {
    title: '间歇跑',
    durations: [600, ...Array.from({ length: 4 }, () => [120, 120]).flat(), 480],
    types: ['warmup', ...Array.from({ length: 4 }, () => ['work', 'recovery']).flat(), 'cooldown'],
  },
};

test('四种手动训练均生成可执行 schema-v2 计划', () => {
  assert.deepEqual(TRAINING_PRESET_IDS, ['easy', 'long', 'fartlek', 'interval']);
  for (const presetId of TRAINING_PRESET_IDS) {
    const plan = buildTrainingPreset(presetId, OWNER, NOW);
    assert.ok(plan, presetId);
    assert.deepEqual(normalizeWorkoutPlan(plan, OWNER, { nowMs: NOW }), plan);
    assert.equal(plan.schema_version, 2);
    assert.equal(plan.type, presetId === 'fartlek' ? 'interval' : presetId);
    assert.equal(plan.title, EXPECTED[presetId].title);
    assert.equal(plan.status, 'accepted');
    assert.equal(plan.scheduled_date, '2026-08-07');
    assert.equal(plan.ownership_epoch, OWNER.ownership_epoch);
    assert.equal(plan.data_namespace, OWNER.data_namespace);
    assert.equal(plan.expires_at_ms - plan.issued_at_ms, 24 * 60 * 60 * 1000);
    assert.ok(plan.stages.length <= 64);
    assert.ok(plan.title.length >= 1 && plan.title.length <= 80);
    assert.match(plan.workout_id, /^wrk_[0-9a-f]{24}$/);
    assert.match(plan.plan_id, /^plan_[1-9][0-9]{0,18}$/);
    assert.match(plan.plan_session_id, /^ps_[0-9a-f]{24}$/);
  }
});

test('阶段顺序与时长精确，所有阶段只以时长作完成边界', () => {
  for (const presetId of TRAINING_PRESET_IDS) {
    const plan = buildTrainingPreset(presetId, OWNER, NOW);
    const expected = EXPECTED[presetId];
    assert.deepEqual(plan.stages.map((value) => value.duration_sec), expected.durations);
    assert.deepEqual(plan.stages.map((value) => value.type), expected.types);
    assert.equal(plan.target.duration_sec,
      expected.durations.reduce((sum, duration) => sum + duration, 0));
    for (const [index, value] of plan.stages.entries()) {
      assert.equal(value.order, index);
      assert.equal(value.distance_m, null);
      assert.equal(value.pace_min_sec_per_km, null);
      assert.equal(value.pace_max_sec_per_km, null);
      assert.equal(value.cadence_min_spm, null);
      assert.equal(value.cadence_max_spm, null);
      assert.ok(value.duration_sec >= 10 && value.duration_sec <= 86_400);
      assert.ok(value.heart_zone_min >= 1 && value.heart_zone_max <= 5);
      assert.ok(value.title.length >= 1 && value.title.length <= 80);
      assert.match(value.stage_id, /^stg_[0-9a-f]{24}$/);
    }
  }
});

test('同一次调用可重现 ID，不同模板、时刻与阶段不冲突', () => {
  const first = buildTrainingPreset('fartlek', OWNER, NOW);
  const repeat = buildTrainingPreset('fartlek', OWNER, NOW);
  const later = buildTrainingPreset('fartlek', OWNER, NOW + 1);
  assert.deepEqual(repeat, first);
  assert.notEqual(later.workout_id, first.workout_id);

  const allPlanIds = [];
  for (const presetId of TRAINING_PRESET_IDS) {
    const plan = buildTrainingPreset(presetId, OWNER, NOW);
    const ids = [plan.workout_id, plan.plan_id, plan.plan_session_id,
      ...plan.stages.map((value) => value.stage_id)];
    assert.equal(new Set(ids).size, ids.length);
    allPlanIds.push(plan.workout_id, plan.plan_id, plan.plan_session_id);
  }
  assert.equal(new Set(allPlanIds).size, allPlanIds.length);
});

test('非法模板、owner 或时刻 fail closed，输入 owner 支持归一化', () => {
  const camelOwner = {
    ownershipEpoch: OWNER.ownership_epoch,
    dataNamespace: OWNER.data_namespace,
    publicDeviceId: OWNER.public_device_id,
  };
  assert.deepEqual(
    buildTrainingPreset('easy', camelOwner, NOW),
    buildTrainingPreset('easy', OWNER, NOW),
  );
  assert.equal(buildTrainingPreset('unknown', OWNER, NOW), null);
  assert.equal(buildTrainingPreset('easy', {}, NOW), null);
  assert.equal(buildTrainingPreset('easy', OWNER, Number.NaN), null);
  assert.equal(buildTrainingPreset('easy', OWNER, NOW + 0.5), null);
});
