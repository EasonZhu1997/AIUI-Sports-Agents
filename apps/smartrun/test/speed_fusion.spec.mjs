import assert from 'node:assert/strict';
import test from 'node:test';

import { MotionSpeedFusion } from '../lib/speed_fusion.js';

test('RSC 高置信观测比 IMU 更快校正融合速度', () => {
  const fusion = new MotionSpeedFusion();
  fusion.observe('imu', 2.5, 0, {
    quality: 0.7,
    cadenceConfidence: 0.8,
    strideConfidence: 0.3,
  });
  const before = fusion.snapshot(0).speedMps;
  fusion.observe('rsc', 3, 1000, { quality: 1 });
  const after = fusion.snapshot(1000);
  assert.ok(after.speedMps > before);
  assert.ok(Math.abs(after.speedMps - 3) < Math.abs(before - 3));
  assert.equal(after.source, 'rsc');
});

test('GPS 抖动被平滑且精度越差权重越低', () => {
  const fusion = new MotionSpeedFusion();
  fusion.observe('imu', 3, 0, { quality: 0.8, strideConfidence: 0.7 });
  fusion.observe('gps', 4.2, 1000, { quality: 0.6, accuracyM: 18, windowSec: 5 });
  const speed = fusion.snapshot(1000).speedMps;
  assert.ok(speed > 3 && speed < 3.8);
});

test('1 秒短窗 GPS 偏快时只弱校正稳定 IMU，不把 HUD 拉成虚假高速', () => {
  const fusion = new MotionSpeedFusion();
  let now = 0;
  fusion.observe('imu', 2.41, now, {
    quality: 0.75,
    cadenceConfidence: 0.8,
    strideConfidence: 0.45,
  });
  for (let index = 1; index <= 10; index += 1) {
    now += 500;
    fusion.observe('gps', 5.73, now, {
      quality: 0.85,
      accuracyM: 5,
      windowSec: 1,
    });
    now += 500;
    fusion.observe('imu', 2.41, now, {
      quality: 0.75,
      cadenceConfidence: 0.8,
      strideConfidence: 0.45,
    });
  }
  const snapshot = fusion.snapshot(now);
  assert.ok(snapshot.speedMps >= 2.35 && snapshot.speedMps <= 3.05,
    `融合速度不应被短窗 GPS 拉快，实际 ${snapshot.speedMps}`);
});

test('高质量长窗 GPS 仍能有效纠正偏低 IMU，而不是被降权成无效', () => {
  const fusion = new MotionSpeedFusion();
  fusion.observe('imu', 2, 0, {
    quality: 0.7,
    cadenceConfidence: 0.7,
    strideConfidence: 0.3,
  });
  for (let second = 1; second <= 8; second += 1) {
    fusion.observe('gps', 3, second * 1000, {
      quality: 0.95,
      accuracyM: 3,
      windowSec: 4,
    });
  }
  const speed = fusion.snapshot(8000).speedMps;
  assert.ok(speed >= 2.7 && speed <= 3.05,
    `高质量 GPS 应把 2m/s IMU 拉近 3m/s，实际 ${speed}`);
});

test('单个速度尖峰拒绝，连续一致变化可重新锚定', () => {
  const fusion = new MotionSpeedFusion({ outlierAbsMps: 1.2 });
  fusion.observe('rsc', 2, 0, { quality: 1 });
  fusion.observe('rsc', 2.1, 1000, { quality: 1 });
  const rejected = fusion.observe('rsc', 6, 2000, { quality: 1 });
  assert.equal(rejected.outlierRejected, true);
  assert.ok(fusion.snapshot(2000).speedMps < 3);
  fusion.observe('rsc', 5.8, 2500, { quality: 1 });
  fusion.observe('rsc', 5.9, 3000, { quality: 1 });
  assert.ok(fusion.snapshot(3000).speedMps > 5.5);
});

test('静止观测立即归零且不会生成距离', () => {
  const fusion = new MotionSpeedFusion();
  fusion.observe('imu', 2.8, 0, { quality: 0.8 });
  fusion.observeStationary(500, 0.95);
  const snap = fusion.snapshot(500);
  assert.equal(snap.speedMps, 0);
  assert.equal(snap.paceSecPerKm, null);
  assert.equal('distanceM' in snap, false);
});

test('静止后的首个可信运动速度立即重锚，不产生虚假超慢配速过渡', () => {
  const fusion = new MotionSpeedFusion();
  fusion.observe('imu', 2.8, 0, {
    quality: 0.8,
    cadenceConfidence: 0.8,
    strideConfidence: 0.5,
  });
  fusion.observeStationary(500, 0.95);

  const recovered = fusion.observe('imu', 2, 1100, {
    quality: 0.8,
    cadenceConfidence: 0.8,
    strideConfidence: 0.5,
  });
  const snap = fusion.snapshot(1100);
  assert.equal(recovered.accepted, true);
  assert.equal(snap.source, 'imu');
  assert.ok(Math.abs(snap.speedMps - 2) < 1e-9);
  assert.ok(Math.abs(snap.paceSecPerKm - 500) < 1e-9);
});

test('暂停恢复后旧速度不再新鲜，需新观测重新激活', () => {
  const fusion = new MotionSpeedFusion();
  fusion.observe('rsc', 3, 0, { quality: 1 });
  assert.equal(fusion.pause(1000), true);
  assert.equal(fusion.snapshot(1000).live, false);
  assert.equal(fusion.resume(5000), true);
  assert.equal(fusion.snapshot(5000).live, false);
  fusion.observe('imu', 2.5, 5100, { quality: 0.8 });
  assert.equal(fusion.snapshot(5100).live, true);
});
