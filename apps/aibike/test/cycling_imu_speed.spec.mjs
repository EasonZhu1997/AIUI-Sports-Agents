import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessWalkingLikeCadence,
  CyclingImuEstimateStabilizer,
  DEFAULT_IMU_AVAILABILITY_SPEED_CAP_KMH,
  DEFAULT_IMU_HIGH_CADENCE_SPEED_CAP_KMH,
  DEFAULT_IMU_METERS_PER_CRANK,
  DEFAULT_IMU_SPEED_CAP_KMH,
  DEFAULT_IMU_WALKING_SPEED_CAP_KMH,
  estimateImuFallbackSpeedKmh,
  estimateImuSpeedKmh,
} from '../lib/cycling_imu_speed.js';

test('未校准 IMU 采用保守中低挡速度，轻踩不会直接显示 30km/h', () => {
  assert.equal(DEFAULT_IMU_METERS_PER_CRANK, 3.2);
  assert.equal(DEFAULT_IMU_SPEED_CAP_KMH, 20);
  assert.equal(DEFAULT_IMU_AVAILABILITY_SPEED_CAP_KMH, 18);
  assert.ok(Math.abs(estimateImuSpeedKmh(90) - 17.28) < 1e-9);
  assert.equal(estimateImuSpeedKmh(130), 20);
  assert.equal(estimateImuSpeedKmh(0), 0);
  assert.equal(estimateImuSpeedKmh(null), null);
});

test('未锁定 candidate 使用更低的 18km/h 粗估上限', () => {
  assert.equal(
    estimateImuSpeedKmh(130, 3.2, DEFAULT_IMU_AVAILABILITY_SPEED_CAP_KMH),
    18,
  );
});

test('显式校准模型可放宽换算上限，真实来源不受 IMU 估算上限影响', () => {
  assert.ok(Math.abs(estimateImuSpeedKmh(90, 4, 120) - 21.6) < 1e-9);
});

test('119/120rpm 模型边界不会把单窗谐波切换直接变成速度跳水', () => {
  const stabilizer = new CyclingImuEstimateStabilizer();
  const speed119 = estimateImuFallbackSpeedKmh(119, {
    estimateLevel: 'candidate',
  });
  const speed120 = estimateImuFallbackSpeedKmh(120, {
    estimateLevel: 'candidate',
  });
  assert.equal(speed119, 18);
  assert.ok(speed120 < 12);

  const baseline = stabilizer.observe(119, speed119, 0);
  const oneWindow = stabilizer.observe(120, speed120, 250);
  const backToBaseline = stabilizer.observe(119, speed119, 500);
  assert.equal(baseline.speedKmh, 18);
  assert.equal(oneWindow.speedKmh, 18, '单个阈值窗只确认，不改变输出');
  assert.equal(oneWindow.held, true);
  assert.equal(backToBaseline.speedKmh, 18);
  assert.equal(backToBaseline.held, false);
});

test('持续真实变速经连续窗确认后有界跟随，且没有新样本不会自行造数', () => {
  const stabilizer = new CyclingImuEstimateStabilizer();
  stabilizer.observe(90, 17.28, 0);
  const outputs = [];
  for (let index = 1; index <= 8; index += 1) {
    outputs.push(stabilizer.observe(120, 11.52, index * 250));
  }
  assert.equal(outputs[0].speedKmh, 17.28);
  assert.equal(outputs[1].speedKmh, 17.28);
  for (let index = 1; index < outputs.length; index += 1) {
    assert.ok(
      Math.abs(outputs[index].speedKmh - outputs[index - 1].speedKmh) <= 2.501,
      '连续确认后的任意一次追赶也不得超过累计 2.5km/h/s 预算',
    );
  }
  assert.ok(outputs.at(-1).speedKmh < 17.28);
  const frozen = outputs.at(-1).speedKmh;
  assert.equal(stabilizer.speedKmh, frozen, '无 observe 调用时状态不得自行推进');
});

test('无校准高踏频按半频保守换算，走路冲击同相时使用步行尺度', () => {
  assert.equal(DEFAULT_IMU_HIGH_CADENCE_SPEED_CAP_KMH, 15);
  assert.equal(DEFAULT_IMU_WALKING_SPEED_CAP_KMH, 8);
  assert.ok(Math.abs(
    estimateImuFallbackSpeedKmh(130, { estimateLevel: 'locked' }) - 12.48,
  ) < 1e-9);
  assert.ok(Math.abs(
    estimateImuFallbackSpeedKmh(130, {
      estimateLevel: 'locked',
      walkingLike: true,
    }) - 5.616,
  ) < 1e-9);
  assert.ok(Math.abs(
    estimateImuFallbackSpeedKmh(130, {
      calibrated: true,
      metersPerCrank: 4,
      speedLimitKmh: 120,
    }) - 20,
  ) < 1e-9);
});

test('步行判定要求连续落脚间隔与周期同相，随机道路冲击不成立', () => {
  const walking = assessWalkingLikeCadence(
    130,
    [0, 462, 924, 1386, 1848, 2310, 2772],
    2772,
  );
  assert.equal(walking.walkingLike, true);
  assert.ok(walking.confidence >= 0.8);

  const randomRoad = assessWalkingLikeCadence(
    90,
    [0, 310, 1180, 1570, 2640, 2910],
    2910,
  );
  assert.equal(randomRoad.walkingLike, false);
});
