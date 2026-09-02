import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOTION_QUALITY_STATE,
  MotionQualityGate,
  ORIENTATION_DIRECTION,
  VerticalAccelerationProjector,
  normalizeQuaternion,
  rotateVectorByQuaternion,
} from '../lib/motion_quality.js';

const G = 9.80665;

function assertNear(actual, expected, tolerance = 1e-6, message = '') {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message} actual=${actual}, expected=${expected}, tolerance=${tolerance}`,
  );
}

function axisAngleQuaternion(axis, radians) {
  const norm = Math.hypot(axis[0], axis[1], axis[2]);
  const half = radians / 2;
  const scale = Math.sin(half) / norm;
  return [
    axis[0] * scale,
    axis[1] * scale,
    axis[2] * scale,
    Math.cos(half),
  ];
}

function feedQuality(gate, {
  seconds = 2,
  sampleHz = 50,
  accelAt,
  gyroAt,
  startMs = 0,
} = {}) {
  const intervalMs = 1000 / sampleHz;
  const total = Math.floor(seconds * sampleHz);
  for (let index = 0; index < total; index += 1) {
    const timestampMs = startMs + index * intervalMs;
    gate.pushAccelDynamic(accelAt(index, timestampMs), timestampMs);
    const gyro = gyroAt(index, timestampMs);
    gate.pushGyro(gyro[0], gyro[1], gyro[2], timestampMs);
  }
  return startMs + (total - 1) * intervalMs;
}

test('四元数校验并归一化 [x,y,z,w]，异常输入安全返回 null', () => {
  assert.deepEqual(normalizeQuaternion([0, 0, 0, 2]), [0, 0, 0, 1]);
  const typed = normalizeQuaternion(new Float32Array([0, 0, 1, 1]));
  assertNear(typed[2], Math.SQRT1_2);
  assertNear(typed[3], Math.SQRT1_2);

  for (const invalid of [
    null,
    [],
    [0, 0, 0, 0],
    [0, 0, Number.NaN, 1],
    ['0', 0, 0, 1],
  ]) {
    assert.equal(normalizeQuaternion(invalid), null);
  }
});

test('四元数向量旋转支持正反方向，但不把 yaw 当成真北', () => {
  const yaw90 = axisAngleQuaternion([0, 0, 1], Math.PI / 2);
  const direct = rotateVectorByQuaternion([1, 0, 0], yaw90);
  assertNear(direct[0], 0);
  assertNear(direct[1], 1);
  assertNear(direct[2], 0);

  const inverse = rotateVectorByQuaternion([1, 0, 0], yaw90, true);
  assertNear(inverse[0], 0);
  assertNear(inverse[1], -1);
  assert.equal(rotateVectorByQuaternion([1, Number.NaN, 0], yaw90), null);
});

test('自动识别 device→world 旋转方向并输出稳定垂直动态量', () => {
  const projector = new VerticalAccelerationProjector({
    minDirectionSamples: 5,
  });
  let last = null;
  const sampleHz = 50;
  for (let index = 0; index < 120; index += 1) {
    const timestampMs = index * 20;
    const tilt = 0.36 + 0.08 * Math.sin(index / 25);
    const deviceToWorld = axisAngleQuaternion([0, 1, 0], tilt);
    const worldDynamic = index < 70 ? 0 : 0.9 * Math.sin(index * 0.42);
    const worldAcceleration = [0, 0, G + worldDynamic];
    const deviceAcceleration = rotateVectorByQuaternion(
      worldAcceleration,
      deviceToWorld,
      true,
    );
    assert.equal(
      projector.pushOrientation(deviceToWorld, timestampMs),
      true,
    );
    last = projector.project(
      deviceAcceleration[0],
      deviceAcceleration[1],
      deviceAcceleration[2],
      timestampMs,
    );
  }

  assert.equal(projector.direction, ORIENTATION_DIRECTION.DEVICE_TO_WORLD);
  assert.equal(last.accepted, true);
  assert.equal(last.source, 'orientation_vertical');
  assert.equal(last.orientationFresh, true);
  assert.ok(Math.abs(last.verticalDynamicMps2) > 0.1);
  assertNear(last.worldAcceleration[0], 0, 1e-6);
  assertNear(last.worldAcceleration[1], 0, 1e-6);
});

test('自动识别 world→device 旋转方向；姿态歧义时回退模长而非盲猜', () => {
  const inverseProjector = new VerticalAccelerationProjector({
    minDirectionSamples: 5,
  });
  for (let index = 0; index < 60; index += 1) {
    const timestampMs = index * 20;
    const worldToDevice = axisAngleQuaternion(
      [1, 0, 0],
      0.3 + 0.07 * Math.sin(index / 20),
    );
    const deviceAcceleration = rotateVectorByQuaternion(
      [0, 0, G],
      worldToDevice,
    );
    inverseProjector.pushOrientation(worldToDevice, timestampMs);
    inverseProjector.project(
      deviceAcceleration[0],
      deviceAcceleration[1],
      deviceAcceleration[2],
      timestampMs,
    );
  }
  assert.equal(
    inverseProjector.direction,
    ORIENTATION_DIRECTION.WORLD_TO_DEVICE,
  );

  const ambiguous = new VerticalAccelerationProjector({
    minDirectionSamples: 3,
  });
  let output = null;
  for (let index = 0; index < 20; index += 1) {
    const timestampMs = index * 20;
    ambiguous.pushOrientation([0, 0, 0, 1], timestampMs);
    output = ambiguous.project(0, 0, G, timestampMs);
  }
  assert.equal(ambiguous.direction, ORIENTATION_DIRECTION.UNDETERMINED);
  assert.equal(output.orientationFresh, true);
  assert.equal(output.source, 'magnitude_fallback');
});

test('短窗能量区分 stationary、running 与 head_motion', () => {
  const stationary = new MotionQualityGate();
  const stationaryEnd = feedQuality(stationary, {
    accelAt: (index) => 0.025 * Math.sin(index * 0.3),
    gyroAt: (index) => [0.015 * Math.sin(index * 0.2), 0.01, 0],
  });
  const stillSnapshot = stationary.snapshot(stationaryEnd);
  assert.equal(stillSnapshot.state, MOTION_QUALITY_STATE.STATIONARY);
  assert.ok(stillSnapshot.stationaryConfidence > 0.8);

  const running = new MotionQualityGate();
  const runningEnd = feedQuality(running, {
    accelAt: (index) => 0.9 * Math.sin(index * 0.43),
    gyroAt: (index) => [0.14 * Math.sin(index * 0.31), 0.08, 0],
  });
  const runningSnapshot = running.snapshot(runningEnd);
  assert.equal(runningSnapshot.state, MOTION_QUALITY_STATE.RUNNING);
  assert.ok(runningSnapshot.runningConfidence > 0.7);
  assert.ok(runningSnapshot.artifactConfidence < 0.3);

  const headMotion = new MotionQualityGate();
  const headEnd = feedQuality(headMotion, {
    accelAt: (index) => 0.08 * Math.sin(index * 0.27),
    gyroAt: (index) => [1.3 * Math.sin(index * 0.2), 1.1, 0.4],
  });
  const headSnapshot = headMotion.snapshot(headEnd);
  assert.equal(headSnapshot.state, MOTION_QUALITY_STATE.HEAD_MOTION);
  assert.ok(headSnapshot.artifactConfidence > 0.7);
});

test('样本不足或过期时保持 uncertain，orientationFresh 独立反映新鲜度', () => {
  const gate = new MotionQualityGate({
    orientation: { orientationFreshMs: 300 },
  });
  assert.equal(gate.pushOrientation([0, 0, 0, 1], 0), true);
  gate.pushAccelDynamic(0.8, 10);
  gate.pushGyro(0, 0, 0, 10);

  const early = gate.snapshot(10);
  assert.equal(early.state, MOTION_QUALITY_STATE.UNCERTAIN);
  assert.equal(early.orientationFresh, true);

  const stale = gate.snapshot(1000);
  assert.equal(stale.state, MOTION_QUALITY_STATE.UNCERTAIN);
  assert.equal(stale.accelFresh, false);
  assert.equal(stale.gyroFresh, false);
  assert.equal(stale.orientationFresh, false);
});

test('pause/resume/reset 和异常输入均 fail-safe，模块不产生距离字段', () => {
  const gate = new MotionQualityGate();
  const invalidResults = [
    gate.pushOrientation([0, 0, 0, 0], 0),
    gate.pushAcceleration(Number.NaN, 0, G, 0),
    gate.pushAccelDynamic(undefined, 0),
    gate.pushGyro(0, Number.NaN, 0, 0),
  ];
  assert.equal(invalidResults[0], false);
  for (const result of invalidResults.slice(1)) assert.equal(result.accepted, false);

  feedQuality(gate, {
    accelAt: (index) => 0.8 * Math.sin(index * 0.4),
    gyroAt: () => [0.1, 0.1, 0],
  });
  assert.equal(gate.snapshot(1980).state, MOTION_QUALITY_STATE.RUNNING);
  assert.equal('distanceM' in gate.snapshot(1980), false);

  gate.pause();
  const paused = gate.pushAccelDynamic(1, 2100);
  assert.equal(paused.accepted, false);
  assert.equal(paused.quality.paused, true);
  assert.equal(paused.quality.state, MOTION_QUALITY_STATE.UNCERTAIN);

  gate.resume();
  const resumed = gate.snapshot(2200);
  assert.equal(resumed.paused, false);
  assert.equal(resumed.state, MOTION_QUALITY_STATE.UNCERTAIN);
  assert.equal(resumed.accelSamples, 0);

  gate.pushAccelDynamic(0.2, 2300);
  assert.equal(gate.pushAccelDynamic(0.2, 2300).accepted, false);
  assert.equal(gate.pushAccelDynamic(0.2, 2200).accepted, false);

  gate.reset();
  const reset = gate.snapshot();
  assert.equal(reset.state, MOTION_QUALITY_STATE.UNCERTAIN);
  assert.equal(reset.accelSamples, 0);
  assert.equal(reset.gyroSamples, 0);
});
