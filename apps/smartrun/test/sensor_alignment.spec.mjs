import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCELERATION_SOURCE_UNIT,
  AccelerationUnitCalibrator,
  SensorAlignment,
  STANDARD_GRAVITY_MPS2,
  lerpVector3,
  slerpQuaternion,
} from '../lib/sensor_alignment.js';

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

function feedStatic(calibrator, magnitude, {
  samples = 50,
  intervalMs = 20,
  startMs = 0,
  noise = 0.004,
} = {}) {
  for (let index = 0; index < samples; index += 1) {
    const value = magnitude * (1 + noise * Math.sin(index * 0.37));
    calibrator.push(0, 0, value, startMs + index * intervalMs, {
      stationary: true,
    });
  }
}

test('静止约 1g 输入会锁定 g 单位并统一转换成 m/s²', () => {
  const calibrator = new AccelerationUnitCalibrator();
  feedStatic(calibrator, 1);

  const state = calibrator.snapshot();
  assert.equal(state.calibrated, true);
  assert.equal(state.sourceUnit, ACCELERATION_SOURCE_UNIT.STANDARD_GRAVITY);
  assertNear(state.scaleToMps2, STANDARD_GRAVITY_MPS2);
  const converted = calibrator.convertVector([0.1, -0.2, 1]);
  assertNear(converted[0], 0.1 * STANDARD_GRAVITY_MPS2);
  assertNear(converted[1], -0.2 * STANDARD_GRAVITY_MPS2);
  assertNear(converted[2], STANDARD_GRAVITY_MPS2);
});

test('静止约 9.80665m/s² 输入保持 m/s²，不重复缩放', () => {
  const calibrator = new AccelerationUnitCalibrator();
  feedStatic(calibrator, STANDARD_GRAVITY_MPS2);

  const state = calibrator.snapshot();
  assert.equal(state.calibrated, true);
  assert.equal(
    state.sourceUnit,
    ACCELERATION_SOURCE_UNIT.METERS_PER_SECOND_SQUARED,
  );
  assert.equal(state.scaleToMps2, 1);
  assert.deepEqual(
    calibrator.convertVector([1.2, -2.4, STANDARD_GRAVITY_MPS2]),
    [1.2, -2.4, STANDARD_GRAVITY_MPS2],
  );
});

test('未知稳定单位和动态污染窗口均 fail-safe 原样透传', () => {
  const unknown = new AccelerationUnitCalibrator();
  feedStatic(unknown, 4);
  assert.equal(unknown.snapshot().sourceUnit, ACCELERATION_SOURCE_UNIT.UNKNOWN);
  assert.equal(unknown.snapshot().scaleToMps2, 1);
  assert.deepEqual(unknown.convertVector([1, 2, 4]), [1, 2, 4]);

  const moving = new AccelerationUnitCalibrator();
  for (let index = 0; index < 60; index += 1) {
    const magnitude = 1 + 0.32 * Math.sin(index * 0.7);
    moving.push(0, 0, magnitude, index * 20);
  }
  assert.equal(moving.snapshot().calibrated, false);
  assert.equal(moving.snapshot().stable, false);

  feedStatic(moving, 1, { samples: 10, startMs: 2000 });
  moving.push(0, 0, 1, 2220, { stationary: false });
  assert.equal(moving.snapshot().sampleCount, 0);
  assert.equal(moving.snapshot().calibrated, false);
});

test('SLERP 处理四元数反号、近共线和输入边界，不推断航向', () => {
  const start = axisAngleQuaternion([0, 1, 0], 0);
  const finish = axisAngleQuaternion([0, 1, 0], Math.PI / 2);
  const halfway = slerpQuaternion(start, finish, 0.5);
  const expected = axisAngleQuaternion([0, 1, 0], Math.PI / 4);
  for (let index = 0; index < 4; index += 1) {
    assertNear(halfway[index], expected[index]);
  }

  const negated = finish.map((value) => -value);
  const shortest = slerpQuaternion(finish, negated, 0.5);
  const dot = shortest.reduce(
    (sum, value, index) => sum + value * finish[index],
    0,
  );
  assertNear(Math.abs(dot), 1);

  const near = slerpQuaternion(
    [0, 0, 0, 1],
    [0, 0, 1e-7, 1],
    0.5,
  );
  assertNear(Math.hypot(...near), 1);
  assert.equal(slerpQuaternion(start, finish, -0.1), null);
  assert.equal(slerpQuaternion([0, 0, 0, 0], finish, 0.5), null);
  assert.equal(Object.hasOwn({ quaternion: halfway }, 'heading'), false);
});

test('姿态按目标加速度时刻 SLERP，陀螺仪做线性插值', () => {
  const alignment = new SensorAlignment({
    orientationInterpolationGapMs: 100,
    gyroscopeInterpolationGapMs: 100,
  });
  const start = axisAngleQuaternion([1, 0, 0], 0);
  const finish = axisAngleQuaternion([1, 0, 0], Math.PI / 2);
  assert.equal(alignment.pushOrientation(start, 100), true);
  assert.equal(alignment.pushOrientation(finish, 180), true);
  assert.equal(alignment.pushGyroscope(0, 1, 2, 100), true);
  assert.equal(alignment.pushGyroscope(2, 3, 4, 180), true);

  const result = alignment.alignAcceleration(0, 0, 1, 140);
  assert.equal(result.accepted, true);
  assert.equal(result.orientation.mode, 'interpolated');
  assert.equal(result.gyroscope.mode, 'interpolated');
  const expected = axisAngleQuaternion([1, 0, 0], Math.PI / 4);
  for (let index = 0; index < 4; index += 1) {
    assertNear(result.orientation.value[index], expected[index]);
  }
  assert.deepEqual(result.gyroscope.value, [1, 2, 3]);
  assert.equal(Object.hasOwn(result, 'distanceM'), false);
  assert.equal(Object.hasOwn(result, 'heading'), false);
});

test('无插值包围或间隔过大时选最近样本，超过新鲜度返回 null', () => {
  const alignment = new SensorAlignment({
    orientationFreshMs: 100,
    orientationInterpolationGapMs: 40,
    gyroscopeFreshMs: 80,
    gyroscopeInterpolationGapMs: 30,
  });
  alignment.pushOrientation([0, 0, 0, 1], 100);
  alignment.pushOrientation(axisAngleQuaternion([0, 0, 1], 1), 200);
  alignment.pushGyroscope(1, 0, 0, 100);
  alignment.pushGyroscope(3, 0, 0, 200);

  const nearestOrientation = alignment.orientationAt(130);
  assert.equal(nearestOrientation.mode, 'nearest');
  assert.equal(nearestOrientation.sampleTimestampMs, 100);
  const nearestGyroscope = alignment.gyroscopeAt(170);
  assert.equal(nearestGyroscope.mode, 'nearest');
  assert.equal(nearestGyroscope.sampleTimestampMs, 200);

  assert.equal(alignment.orientationAt(301), null);
  assert.equal(alignment.gyroscopeAt(281), null);
  assert.equal(alignment.orientationAt(Number.NaN), null);
});

test('重复样本替换、传感器时间倒退清空旧纪元且不跨纪元插值', () => {
  const alignment = new SensorAlignment();
  alignment.pushOrientation([0, 0, 0, 1], 100);
  alignment.pushOrientation(axisAngleQuaternion([1, 0, 0], 0.4), 100);
  assert.equal(alignment.orientationAt(100).mode, 'nearest');
  assertNear(
    alignment.orientationAt(100).value[0],
    axisAngleQuaternion([1, 0, 0], 0.4)[0],
  );

  alignment.pushOrientation([0, 0, 0, 1], 50);
  assert.equal(alignment.orientationAt(100).sampleTimestampMs, 50);

  alignment.pushGyroscope(1, 2, 3, 200);
  alignment.pushGyroscope(4, 5, 6, 20);
  assert.deepEqual(alignment.gyroscopeAt(20).value, [4, 5, 6]);

  const first = alignment.alignAcceleration(0, 0, 1, 300);
  assert.equal(first.accepted, true);
  const reversed = alignment.alignAcceleration(0, 0, 1, 10);
  assert.equal(reversed.accepted, false);
  assert.equal(reversed.reason, 'non_monotonic_timestamp');
  assert.equal(alignment.orientationAt(10), null);
  assert.equal(alignment.gyroscopeAt(10), null);
  const newEpoch = alignment.alignAcceleration(0, 0, 1, 30);
  assert.equal(newEpoch.accepted, true);
});

test('pause 清理短时样本但保留已识别单位，reset 清除全部状态', () => {
  const alignment = new SensorAlignment();
  feedStatic(alignment.accelerationCalibrator, 1);
  assert.equal(alignment.accelerationCalibrator.snapshot().calibrated, true);
  alignment.pushOrientation([0, 0, 0, 1], 1000);
  alignment.pushGyroscope(1, 2, 3, 1000);

  alignment.pause();
  assert.equal(alignment.pushOrientation([0, 0, 0, 1], 1020), false);
  assert.equal(alignment.pushGyroscope(1, 2, 3, 1020), false);
  assert.equal(
    alignment.alignAcceleration(0, 0, 1, 1020).reason,
    'paused',
  );

  alignment.resume();
  assert.equal(alignment.orientationAt(1020), null);
  assert.equal(alignment.gyroscopeAt(1020), null);
  const resumed = alignment.alignAcceleration(0, 0, 1, 1040);
  assertNear(resumed.accelerationMps2[2], STANDARD_GRAVITY_MPS2);

  alignment.reset();
  assert.equal(
    alignment.accelerationCalibrator.snapshot().sourceUnit,
    ACCELERATION_SOURCE_UNIT.UNKNOWN,
  );
  const resetResult = alignment.alignAcceleration(0, 0, 1, 0);
  assert.deepEqual(resetResult.accelerationMps2, [0, 0, 1]);
  assert.equal(resetResult.orientation, null);
  assert.equal(resetResult.gyroscope, null);
});

test('异常值、越界插值和非单调加速度时间均安全拒绝', () => {
  const alignment = new SensorAlignment();
  assert.equal(alignment.pushOrientation([0, 0, 0, 0], 0), false);
  assert.equal(alignment.pushOrientation([0, 0, 0, 1], Number.NaN), false);
  assert.equal(alignment.pushGyroscope(0, Number.NaN, 0, 0), false);
  assert.equal(
    alignment.alignAcceleration(Number.NaN, 0, 1, 0).reason,
    'invalid',
  );
  assert.equal(
    alignment.alignAcceleration(0, 0, 1, Number.NaN).reason,
    'invalid',
  );
  assert.equal(lerpVector3([0, 0, 0], [1, 1, 1], 1.1), null);

  assert.equal(alignment.alignAcceleration(0, 0, 1, 100).accepted, true);
  assert.equal(
    alignment.alignAcceleration(0, 0, 1, 100).reason,
    'non_monotonic_timestamp',
  );
});
