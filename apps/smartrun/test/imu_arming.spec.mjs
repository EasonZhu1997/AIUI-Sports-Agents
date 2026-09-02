import test from 'node:test';
import assert from 'node:assert/strict';

import { ImuArmingGate } from '../lib/imu_arming.js';

function quality(overrides = {}) {
  return {
    accelFresh: true,
    gyroFresh: true,
    accelSamples: 16,
    gyroSamples: 16,
    stationaryConfidence: 0,
    runningConfidence: 0,
    artifactConfidence: 0,
    ...overrides,
  };
}

test('IMU 入场门等待完整静止质量窗，达到最短保护时间后才打开', () => {
  const gate = new ImuArmingGate({ startMs: 1000 });
  assert.equal(gate.observe(quality({ stationaryConfidence: 0.9 }), 1200).armed, false);
  assert.equal(gate.observe(quality({ stationaryConfidence: 0.9 }), 1699).armed, false);
  assert.equal(gate.observe(quality({ stationaryConfidence: 0.9 }), 2200).armed, true);
  assert.equal(gate.reason, 'stationary');
});

test('入场扶镜与质量未就绪不会形成可跨窗复用的静止证据', () => {
  const gate = new ImuArmingGate({ startMs: 0 });
  gate.observe(quality({ stationaryConfidence: 0.8 }), 100);
  const disturbed = gate.observe(quality({
    stationaryConfidence: 0.1,
    artifactConfidence: 0.9,
  }), 500);
  assert.equal(disturbed.armed, false);
  assert.equal(disturbed.evidenceKind, null);
  assert.equal(gate.observe(quality({ stationaryConfidence: 0.8 }), 1200).armed, false);
  assert.equal(gate.observe(quality({ stationaryConfidence: 0.8 }), 1700).armed, true);
});

test('用户立即起跑时，持续低伪动作运动证据可旁路静止要求', () => {
  const gate = new ImuArmingGate({ startMs: 0 });
  const moving = quality({
    stationaryConfidence: 0.05,
    runningConfidence: 0.82,
    artifactConfidence: 0.12,
  });
  assert.equal(gate.observe(moving, 300).armed, false);
  assert.equal(gate.observe(moving, 1199).armed, false);
  assert.equal(gate.observe(moving, 1200).armed, true);
  assert.equal(gate.reason, 'motion');
});

test('缺少陀螺仪时不会永久锁死，有限时间后进入严格模长回退', () => {
  const gate = new ImuArmingGate({ startMs: 0 });
  const accelOnly = quality({
    gyroFresh: false,
    gyroSamples: 0,
    stationaryConfidence: 0,
  });
  assert.equal(gate.observe(accelOnly, 3499).armed, false);
  assert.equal(gate.observe(accelOnly, 3500).armed, true);
  assert.equal(gate.reason, 'accel-only-timeout');
});

test('reset 会清除上一传感器代次的许可与证据', () => {
  const gate = new ImuArmingGate({
    startMs: 0,
    minArmMs: 0,
    stationaryHoldMs: 0,
  });
  assert.equal(gate.observe(quality({ stationaryConfidence: 0.9 }), 10).armed, true);
  gate.reset(1000);
  assert.equal(gate.armed, false);
  assert.equal(gate.evidenceKind, null);
  assert.equal(gate.observe(quality({ stationaryConfidence: 0.9 }), 1001).armed, true);
});
