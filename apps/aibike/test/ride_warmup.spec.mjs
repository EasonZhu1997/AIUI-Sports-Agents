import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RIDE_GUIDE_KIND,
  RIDE_RECOVERY_OVERVIEW_COPY,
  RIDE_RECOVERY_STEPS,
  RIDE_RECOVERY_TOTAL_SECONDS,
  RIDE_WARMUP_STEPS,
  RIDE_WARMUP_TOTAL_SECONDS,
  getRideGuideRhythmTtsCue,
  getRideGuideStep,
  getRideGuideTtsCue,
  getRideWarmupStep,
  normalizeRideWarmupStepIndex,
  warmupSecondsRemaining,
} from '../lib/ride_warmup.js';

test('骑前拉伸流程包含四个动作并有 80 秒总时长', () => {
  assert.equal(RIDE_WARMUP_STEPS.length, 4);
  assert.equal(RIDE_WARMUP_TOTAL_SECONDS, 80);
  assert.ok(RIDE_WARMUP_STEPS.every((step) => step.seconds === 20));
  assert.ok(RIDE_WARMUP_STEPS.every((step) => step.title && step.instruction));
  assert.deepEqual(
    RIDE_WARMUP_STEPS.map((step) => step.figure),
    ['chest', 'hip', 'quad', 'calf'],
  );
  for (const step of RIDE_WARMUP_STEPS) {
    assert.equal(step.asset, '');
    assert.equal(step.imagePath, '');
  }
});

test('骑后放松使用独立四步语义和程序化文字引导', () => {
  assert.equal(RIDE_RECOVERY_STEPS.length, 4);
  assert.equal(RIDE_RECOVERY_TOTAL_SECONDS, 60);
  assert.equal(RIDE_RECOVERY_OVERVIEW_COPY, '4项 · 每项15秒 · 共1分钟');
  assert.deepEqual(
    RIDE_RECOVERY_STEPS.map((step) => step.title),
    ['小腿放松', '大腿前侧', '髋部放松', '肩胸舒展'],
  );
  assert.ok(RIDE_RECOVERY_STEPS.every((step) => Object.isFrozen(step)));
  assert.ok(RIDE_RECOVERY_STEPS.every((step) => step.durationSec === 15));
  assert.ok(RIDE_RECOVERY_STEPS.every((step) => step.safetyNote === '疼痛就停'));
  for (const step of RIDE_RECOVERY_STEPS) {
    assert.equal(step.asset, '');
    assert.equal(step.imagePath, '');
  }
  assert.equal(getRideGuideStep(RIDE_GUIDE_KIND.RECOVERY, -1), null);
  assert.equal(getRideGuideStep(RIDE_GUIDE_KIND.RECOVERY, '0'), null);
  assert.equal(getRideGuideStep(RIDE_GUIDE_KIND.RECOVERY, 4), null);
  assert.match(
    getRideGuideTtsCue(RIDE_GUIDE_KIND.RECOVERY, 0, { includeIntro: true }),
    /四个动作.*第一项/s,
  );
  assert.equal(getRideGuideRhythmTtsCue(RIDE_GUIDE_KIND.RECOVERY, 0, 7), '换边。');
  assert.equal(getRideGuideRhythmTtsCue(RIDE_GUIDE_KIND.RECOVERY, 3, 7), '');
  assert.equal(getRideGuideRhythmTtsCue(RIDE_GUIDE_KIND.RECOVERY, 2, 3), '三。二。一。');
});

test('拉伸动作索引和倒计时边界安全归一', () => {
  assert.equal(normalizeRideWarmupStepIndex(-2), 0);
  assert.equal(normalizeRideWarmupStepIndex(99), 3);
  assert.equal(getRideWarmupStep(2).figure, 'quad');
  assert.equal(warmupSecondsRemaining(getRideWarmupStep(0), 19500), 20);
  assert.equal(warmupSecondsRemaining(getRideWarmupStep(0), 1000), 1);
  assert.equal(warmupSecondsRemaining(getRideWarmupStep(0), -1), 0);
});
