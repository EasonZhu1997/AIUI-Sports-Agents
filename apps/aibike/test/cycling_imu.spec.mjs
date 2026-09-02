import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCELERATION_SOURCE_UNIT,
  AccelerationUnitCalibrator,
  CyclingImuActivity,
  CyclingImuClassifier,
  SensorTimestampNormalizer,
  estimateFallbackGyroscopeCadence,
  estimateLowRateGyroscopeCadence,
  estimateSimpleGyroscopeCadence,
} from '../lib/cycling_imu.js';
import {
  CyclingMotionQualityGate,
} from '../lib/cycling_motion_quality.js';

function feedStill(imu, fromMs, toMs, stepMs = 50) {
  for (let at = fromMs; at <= toMs; at += stepMs) {
    imu.onSample({ x: 0, y: 0, z: 9.81 }, at);
  }
}

function feedMotion(imu, fromMs, toMs, stepMs = 50) {
  let sign = 1;
  for (let at = fromMs; at <= toMs; at += stepMs) {
    imu.onSample({ x: sign * 0.8, y: 0.25 * sign, z: 9.81 }, at);
    sign *= -1;
  }
}

function feedCadence(
  imu,
  rpm,
  fromMs,
  toMs,
  {
    stepMs = 40,
    amplitude = 0.9,
    secondHarmonic = 0,
  } = {},
) {
  for (let at = fromMs; at <= toMs; at += stepMs) {
    const phase = 2 * Math.PI * rpm * at / 60000;
    imu.onSample({
      x: amplitude * Math.sin(phase)
        + secondHarmonic * Math.sin(phase * 2 + 0.4),
      y: amplitude * 0.55 * Math.cos(phase + 0.2),
      z: 9.80665 + amplitude * 0.25 * Math.sin(phase + 0.7),
    }, at);
  }
}

function yawQuaternion(radians) {
  return [0, 0, Math.sin(radians / 2), Math.cos(radians / 2)];
}

function gyroscopeStressSamples({
  hz,
  rpm,
  phase = 0,
  durationMs = 4500,
  secondHarmonic = 0,
  rotateRad = 0,
}) {
  const samples = [];
  let at = 0;
  let index = 0;
  while (at <= durationMs) {
    at += 1000 / hz * (1 + 0.18 * Math.sin(index * 1.713 + phase));
    index += 1;
    if (index % 13 === 0 || index % 17 === 0) continue;
    const cycle = 2 * Math.PI * rpm * at / 60000 + phase;
    const periodic = Math.sin(cycle)
      + secondHarmonic * Math.sin(cycle * 2 + 0.37);
    const rotation = rotateRad * at / durationMs;
    const cosine = Math.cos(rotation);
    const sine = Math.sin(rotation);
    samples.push({
      timestampMs: at,
      x: 0.075 * periodic * cosine
        - 0.035 * Math.cos(cycle) * sine
        + 0.001 * Math.sin(index * 2.31),
      y: 0.075 * periodic * sine
        + 0.035 * Math.cos(cycle) * cosine
        + 0.001 * Math.cos(index * 1.19),
      z: 0.022 * Math.sin(cycle + 0.6)
        + 0.001 * Math.sin(index * 0.73),
    });
  }
  return samples;
}

function lowRateGyroscopeSamples({
  hz,
  rpm,
  durationMs = 5200,
  jitter = true,
}) {
  const jitterPattern = jitter
    ? [-0.16, 0.11, -0.08, 0.18, -0.04, 0.07]
    : [0];
  const samples = [];
  let at = 0;
  let index = 0;
  while (at <= durationMs) {
    const phase = 2 * Math.PI * rpm * at / 60000;
    samples.push({
      timestampMs: at,
      x: 0.07 * Math.sin(phase) + 0.002 * Math.sin(index * 1.7),
      y: 0.035 * Math.cos(phase + 0.2),
      z: 0.018 * Math.sin(phase + 0.6),
    });
    at += 1000 / hz * (1 + jitterPattern[index % jitterPattern.length])
      + (jitter && index > 0 && index % 17 === 0 ? 1000 / hz : 0);
    index += 1;
  }
  return samples;
}

function feedCadenceReadings(
  imu,
  gate,
  rpm,
  fromMs,
  toMs,
  {
    stepMs = 40,
    gyroZ = 0.03,
    yaw = 0,
  } = {},
) {
  let snapshot = null;
  for (let at = fromMs; at <= toMs; at += stepMs) {
    const phase = 2 * Math.PI * rpm * at / 60000;
    if (gate) {
      gate.pushGyro(0.02 * Math.sin(phase), 0.01, gyroZ, at + 8);
      gate.pushOrientation(yawQuaternion(yaw), at + 4);
    }
    snapshot = imu.onReading({
      x: 0.9 * Math.sin(phase),
      y: 0.5 * Math.cos(phase + 0.2),
      z: 9.80665 + 0.2 * Math.sin(phase + 0.7),
      timestamp: at,
    }, at);
  }
  return snapshot;
}

test('长时间静止只给自动暂停建议，不直接控制会话', () => {
  const imu = new CyclingImuActivity({ startMs: 0 });
  feedStill(imu, 0, 6000);
  const snap = imu.snapshot(6000);
  assert.equal(snap.motionState, 'stationary');
  assert.equal(snap.fresh, true);
  assert.equal(snap.autoPauseSuggested, true);
  assert.equal(snap.autoResumeSuggested, false);
  assert.equal(snap.candidateCadenceRpm, 0);
  assert.equal(snap.finalCadenceRpm, 0);
  assert.equal(snap.cadenceState, 'stationary');
  assert.equal(snap.estimatedSpeedKmh, 0);
});

test('已暂停后持续头部运动给自动恢复建议', () => {
  const imu = new CyclingImuActivity({ startMs: 0 });
  feedStill(imu, 0, 2000);
  imu.setSessionPaused(true);
  feedMotion(imu, 2050, 4000);
  const snap = imu.snapshot(4000);
  assert.equal(snap.motionState, 'moving');
  assert.equal(snap.autoPauseSuggested, false);
  assert.equal(snap.autoResumeSuggested, true);
});

test('IMU 断流变 stale，倒退/重复时间和非法样本被拒绝', () => {
  const imu = new CyclingImuActivity({ startMs: 0, staleMs: 1000 });
  assert.equal(imu.onSample({ x: 0, y: 0, z: 9.81 }, 100), true);
  assert.equal(imu.onSample({ x: 0, y: 0, z: 9.81 }, 100), false);
  assert.equal(imu.onSample({ x: 0, y: 0, z: 9.81 }, 99), false);
  assert.equal(imu.onSample({ x: NaN, y: 0, z: 9.81 }, 200), false);
  assert.equal(imu.snapshot(1200).motionState, 'stale');
  assert.equal(imu.snapshot(1200).autoPauseSuggested, false);
  assert.equal(imu.snapshot(1200).cadenceState, 'stale');
  assert.equal(imu.snapshot(1200).finalCadenceRpm, null);
  assert.equal(imu.snapshot(1200).estimatedSpeedKmh, null);
});

test('活动快照只增加明确标记的估算字段，仍不冒充真实指标或功率', () => {
  const imu = new CyclingImuActivity({ startMs: 0 });
  feedMotion(imu, 0, 1500);
  const snap = imu.snapshot(1500);
  for (const forbidden of ['cadenceRpm', 'speedKmh', 'distanceM', 'powerW']) {
    assert.equal(Object.prototype.hasOwnProperty.call(snap, forbidden), false);
  }
  for (const estimated of [
    'candidateCadenceRpm',
    'finalCadenceRpm',
    'cadenceConfidence',
    'cadenceState',
    'estimatedSpeedKmh',
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(snap, estimated), true);
  }
});

test('25Hz 多轴稳定周期通过连续门后输出估算踏频与默认 rollout 速度', () => {
  const imu = new CyclingImuActivity({ startMs: 0, sampleHz: 25 });
  feedCadence(imu, 90, 0, 9000);
  const snap = imu.snapshot(9000);
  assert.equal(snap.motionState, 'moving');
  assert.equal(snap.cadenceState, 'estimated');
  assert.ok(Math.abs(snap.candidateCadenceRpm - 90) < 2);
  assert.ok(Math.abs(snap.finalCadenceRpm - 90) < 2);
  assert.ok(snap.cadenceConfidence >= 0.75);
  assert.ok(Math.abs(snap.estimatedSpeedKmh - 17.28) < 0.8);
  assert.equal(Object.prototype.hasOwnProperty.call(snap, 'powerW'), false);
});

test('AIUI best-effort 回调在 5.5–60Hz 均按真实时间轴形成踏频', () => {
  for (const effectiveHz of [5.5, 6, 8, 10, 12, 20, 25, 40, 50, 60]) {
    const imu = new CyclingImuActivity({ startMs: 0, sampleHz: 25 });
    feedCadence(imu, 90, 0, 12000, {
      stepMs: 1000 / effectiveHz,
    });
    const snap = imu.snapshot(imu.lastSampleMs);
    assert.equal(
      snap.cadenceState,
      'estimated',
      `${effectiveHz}Hz 不应被请求的 25Hz 硬门拒绝`,
    );
    assert.ok(
      Math.abs(snap.finalCadenceRpm - 90) < 3,
      `${effectiveHz}Hz 实际 ${snap.finalCadenceRpm}`,
    );
  }
});

test('5.5–12Hz 弱单轴踩踏周期仍可形成 final，不依赖夸张三轴振幅', () => {
  for (const effectiveHz of [5.5, 6, 8, 10, 12]) {
    const imu = new CyclingImuActivity({ startMs: 0, sampleHz: 25 });
    const stepMs = 1000 / effectiveHz;
    for (let at = 0; at <= 16000; at += stepMs) {
      const phase = 2 * Math.PI * 88 * at / 60000;
      imu.onSample({
        x: 0.05 * Math.sin(phase),
        y: 0,
        z: 9.80665,
      }, at);
    }
    const snapshot = imu.snapshot(imu.lastSampleMs);
    assert.equal(
      snapshot.cadenceState,
      'estimated',
      `${effectiveHz}Hz 弱单轴周期不应永久停在 stationary/unknown`,
    );
    assert.ok(
      Math.abs(snapshot.finalCadenceRpm - 88) < 4,
      `${effectiveHz}Hz 实际 ${snapshot.finalCadenceRpm}`,
    );
  }
});

test('5.5–12Hz 弱单轴在抖动和偶发丢帧下仍按真实时间锁定', () => {
  const jitter = [-0.18, 0.12, -0.07, 0.2, -0.1, 0.04];
  for (const effectiveHz of [5.5, 6, 8, 10, 12]) {
    const imu = new CyclingImuActivity({ startMs: 0, sampleHz: 25 });
    const baseStepMs = 1000 / effectiveHz;
    let at = 0;
    let index = 0;
    while (at <= 20000) {
      const phase = 2 * Math.PI * 88 * at / 60000;
      imu.onSample({
        x: 0.05 * Math.sin(phase),
        y: 0,
        z: 9.80665,
      }, at);
      at += baseStepMs * (1 + jitter[index % jitter.length])
        + (index > 0 && index % 19 === 0 ? baseStepMs : 0);
      index += 1;
    }
    const snapshot = imu.snapshot(imu.lastSampleMs);
    assert.equal(snapshot.cadenceState, 'estimated', `${effectiveHz}Hz jitter`);
    assert.ok(Math.abs(snapshot.finalCadenceRpm - 88) < 5);
  }
});

test('低频 g 与 m/s² 抖动丢帧输入都在 5 秒内形成连续时间门 final', () => {
  const jitter = [-0.18, 0.12, -0.07, 0.2, -0.1, 0.04];
  for (const unit of [
    ACCELERATION_SOURCE_UNIT.STANDARD_GRAVITY,
    ACCELERATION_SOURCE_UNIT.METERS_PER_SECOND_SQUARED,
  ]) {
    for (const effectiveHz of [5.5, 6, 8, 10, 12]) {
      const gate = new CyclingMotionQualityGate({ minSampleRateHz: 5 });
      const imu = new CyclingImuActivity({
        startMs: 0,
        sampleHz: 25,
        minEffectiveSampleHz: 5,
        cadenceAnalysisIntervalMs: 500,
        motionQualityGate: gate,
        accelerationCalibration: {
          windowMs: 1200,
          minWindowMs: 700,
          minSamples: 6,
        },
      });
      const baseStepMs = 1000 / effectiveHz;
      const scale = unit === ACCELERATION_SOURCE_UNIT.STANDARD_GRAVITY
        ? 1 / 9.80665 : 1;
      let at = 0;
      let index = 0;
      let firstFinal = null;
      while (at <= 5000 && firstFinal == null) {
        const phase = 2 * Math.PI * 88 * at / 60000;
        const snapshot = imu.onReading({
          x: 0.05 * scale * Math.sin(phase),
          y: 0,
          z: 9.80665 * scale,
          timestamp: 10 + at / 1000,
        }, at);
        if (snapshot?.finalCadenceRpm > 0) {
          firstFinal = { at, snapshot };
        }
        at += baseStepMs * (1 + jitter[index % jitter.length])
          + (index > 0 && index % 19 === 0 ? baseStepMs : 0);
        index += 1;
      }

      assert.notEqual(
        firstFinal,
        null,
        `${unit} ${effectiveHz}Hz 应在 5 秒内形成 final`,
      );
      assert.ok(firstFinal.at <= 5000, `${unit} ${effectiveHz}Hz=${firstFinal.at}ms`);
      assert.ok(
        Math.abs(firstFinal.snapshot.finalCadenceRpm - 88) < 5,
        `${unit} ${effectiveHz}Hz 实际 ${firstFinal.snapshot.finalCadenceRpm}`,
      );
      assert.equal(imu.cadenceCandidates.length, 2);
      assert.equal(firstFinal.snapshot.accelerationUnit, unit);
    }
  }
});

test('批量 reading 的 sensor 时间可领先墙钟，但 freshness 只按真实接收墙钟', () => {
  const imu = new CyclingImuActivity({ startMs: 1000, sampleHz: 25 });
  let wallNow = 1000;
  let snapshot = null;
  for (let index = 0; index <= 100; index += 1) {
    if (index > 0 && index % 25 === 0) wallNow += 5;
    const sensorAt = index * 125;
    const phase = 2 * Math.PI * 90 * sensorAt / 60000;
    snapshot = imu.onReading({
      x: 0.07 * Math.sin(phase),
      y: 0,
      z: 9.80665,
      timestamp: sensorAt,
    }, wallNow);
  }
  assert.equal(snapshot.fresh, true);
  assert.equal(imu.snapshot(wallNow).fresh, true);
  assert.equal(imu.snapshot(wallNow + 1600).fresh, false);
});

test('低于通用活动阈值的连续高置信周期可自行确认 moving 与 final', () => {
  const imu = new CyclingImuActivity({ startMs: 0, sampleHz: 25 });
  feedCadence(imu, 90, 0, 12000, {
    amplitude: 0.06,
  });
  const snap = imu.snapshot(12000);
  assert.ok(
    snap.motionScore < 0.18,
    `该用例必须覆盖通用活动阈值以下的弱头戴波形，实际 ${snap.motionScore}`,
  );
  assert.equal(snap.motionState, 'moving');
  assert.equal(snap.cadenceState, 'estimated');
  assert.ok(Math.abs(snap.finalCadenceRpm - 90) < 3);
  assert.ok(snap.cadenceConfidence >= 0.75);
});

test('不均匀 AIUI 回调先按时间戳重采样再做自相关', () => {
  const imu = new CyclingImuActivity({ startMs: 0, sampleHz: 25 });
  const jitterPatternMs = [-13, 8, -4, 15, -9, 3, 11, -6];
  let at = 0;
  let index = 0;
  while (at <= 12000) {
    const phase = 2 * Math.PI * 90 * at / 60000;
    imu.onSample({
      x: 0.4 * Math.sin(phase),
      y: 0.22 * Math.cos(phase + 0.2),
      z: 9.80665 + 0.1 * Math.sin(phase + 0.7),
    }, at);
    at += 40 + jitterPatternMs[index % jitterPatternMs.length];
    index += 1;
  }
  const snap = imu.snapshot(imu.lastSampleMs);
  assert.equal(snap.motionState, 'moving');
  assert.equal(snap.cadenceState, 'estimated');
  assert.ok(Math.abs(snap.finalCadenceRpm - 90) < 4);
});

test('metersPerCrank 可配置，首个强候选先给粗估速度但仍不冒充 final', () => {
  const imu = new CyclingImuActivity({
    startMs: 0,
    sampleHz: 25,
    metersPerCrank: 6.2,
  });
  feedCadence(imu, 80, 0, 3000);
  const warming = imu.snapshot(3000);
  assert.ok(Number.isFinite(warming.candidateCadenceRpm));
  assert.equal(warming.finalCadenceRpm, null);
  assert.equal(warming.cadenceState, 'warming');
  assert.equal(warming.cadenceEstimateLevel, 'candidate');
  assert.ok(warming.effectiveCadenceRpm > 0);
  assert.ok(warming.estimatedSpeedKmh > 15
    && warming.estimatedSpeedKmh < 15.6);
  assert.equal(warming.cadenceUsable, false);
  assert.equal(warming.availabilityCadenceUsable, true);

  feedCadence(imu, 80, 3040, 7000);
  const stable = imu.snapshot(7000);
  assert.equal(stable.cadenceState, 'estimated');
  assert.equal(stable.cadenceEstimateLevel, 'locked');
  assert.equal(stable.cadenceUsable, true);
  assert.equal(stable.availabilityCadenceUsable, false);
  assert.ok(Math.abs(stable.finalCadenceRpm - 80) < 2);
  assert.equal(stable.estimatedSpeedKmh, 20);
});

test('历史稳定值与多轴基频共同阻止强二次谐波造成倍频跳变', () => {
  const imu = new CyclingImuActivity({ startMs: 0, sampleHz: 25 });
  feedCadence(imu, 60, 0, 5000, { secondHarmonic: 0.1 });
  assert.ok(Math.abs(imu.snapshot(5000).finalCadenceRpm - 60) < 2);

  feedCadence(imu, 60, 5040, 12000, { secondHarmonic: 0.75 });
  const snap = imu.snapshot(12000);
  assert.equal(snap.cadenceState, 'estimated');
  assert.ok(Math.abs(snap.candidateCadenceRpm - 60) < 3);
  assert.ok(Math.abs(snap.finalCadenceRpm - 60) < 3);
});

test('非周期道路冲击即使被判为运动也保持低置信未知', () => {
  const imu = new CyclingImuActivity({ startMs: 0, sampleHz: 25 });
  let seed = 123456;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let index = 0; index <= 250; index += 1) {
    const impulse = random() < 0.06 ? (random() - 0.5) * 4 : 0;
    imu.onSample({
      x: (random() - 0.5) * 0.8 + impulse,
      y: (random() - 0.5) * 0.7
        + (random() < 0.04 ? (random() - 0.5) * 3 : 0),
      z: 9.80665 + (random() - 0.5) * 0.5,
    }, index * 40);
  }
  const snap = imu.snapshot(10000);
  assert.equal(snap.motionState, 'moving');
  assert.equal(snap.candidateCadenceRpm, null);
  assert.equal(snap.finalCadenceRpm, null);
  assert.equal(snap.cadenceConfidence, 0);
  assert.equal(snap.cadenceState, 'unknown');
  assert.equal(snap.estimatedSpeedKmh, null);
});

test('页面兼容接口 CyclingImuClassifier.onReading 直接返回活动快照', () => {
  const imu = new CyclingImuClassifier({ startMs: 0, sampleHz: 25 });
  const first = imu.onReading({ x: 0, y: 0, z: 9.81, timestamp: 123 }, 100);
  assert.equal(first.motionState, 'unknown');
  assert.equal(first.fresh, true);
  assert.equal(imu.onReading({ x: NaN, y: 0, z: 9.81 }, 150), null);
});

test('持续转头冻结新证据但保留骑行中已锁定踏频，恢复后继续更新', () => {
  const gate = new CyclingMotionQualityGate();
  const imu = new CyclingImuActivity({
    startMs: 0,
    sampleHz: 25,
    motionQualityGate: gate,
  });
  const stable = feedCadenceReadings(imu, gate, 90, 0, 9000);
  assert.equal(stable.cadenceState, 'estimated');
  assert.ok(Math.abs(stable.finalCadenceRpm - 90) < 2);
  assert.equal(stable.motionQualityState, 'trusted');

  let turning = null;
  for (let at = 9040; at <= 9600; at += 40) {
    const progress = (at - 9040) / 560;
    const phase = 2 * Math.PI * 90 * at / 60000;
    gate.pushGyro(0, 0, 1.45, at + 8);
    gate.pushOrientation(yawQuaternion(progress * 0.62), at + 4);
    turning = imu.onReading({
      x: 0.9 * Math.sin(phase),
      y: 0.5 * Math.cos(phase),
      z: 9.80665,
      timestamp: at,
    }, at);
  }
  assert.equal(turning.cadenceState, 'estimated');
  assert.ok(Math.abs(turning.finalCadenceRpm - 90) < 3);
  assert.ok(Math.abs(turning.effectiveCadenceRpm - 90) < 3);
  assert.equal(turning.cadenceUsable, true);
  assert.equal(turning.motionQualityState, 'head_motion');
  assert.equal(turning.rawMotionArtifact, 'head_turn');
  assert.equal(turning.motionArtifact, 'none');

  const earlyRecovery = feedCadenceReadings(
    imu,
    gate,
    90,
    10600,
    11600,
    { yaw: 0.62 },
  );
  assert.ok(Math.abs(earlyRecovery.finalCadenceRpm - 90) < 3);

  const recovered = feedCadenceReadings(
    imu,
    gate,
    90,
    11640,
    16000,
    { yaw: 0.62 },
  );
  assert.equal(recovered.motionQualityState, 'trusted');
  assert.equal(recovered.cadenceState, 'estimated');
  assert.ok(Math.abs(recovered.finalCadenceRpm - 90) < 3);
});

test('Gyroscope 简易整窗按 1Hz 分析并在约 3–5 秒形成踏频和速度估算', () => {
  const imu = new CyclingImuActivity({
    startMs: 0,
    gyroscopeSampleHz: 20,
  });
  let snapshot = null;
  let firstLockedAtMs = null;
  const analysisTimes = [];
  let lastAnalysisMs = null;
  for (let at = 0; at <= 6500; at += 50) {
    const phase = 2 * Math.PI * 90 * at / 60000;
    snapshot = imu.onGyroscopeReading({
      x: 0.08 * Math.sin(phase),
      y: 0.04 * Math.cos(phase),
      z: 0.02 * Math.sin(phase + 0.4),
      timestamp: at,
    }, at);
    if (firstLockedAtMs == null && snapshot.finalCadenceRpm > 0) {
      firstLockedAtMs = at;
    }
    if (imu.simpleGyroLastAnalysisMs !== lastAnalysisMs) {
      lastAnalysisMs = imu.simpleGyroLastAnalysisMs;
      analysisTimes.push(lastAnalysisMs);
    }
  }
  assert.equal(imu.simpleGyroAnalysisIntervalMs, 1000);
  assert.ok(analysisTimes.slice(1).every(
    (at, index) => at - analysisTimes[index] >= 1000,
  ));
  assert.ok(firstLockedAtMs != null
    && firstLockedAtMs >= 3000 && firstLockedAtMs <= 5000);
  assert.equal(snapshot.motionState, 'moving');
  assert.equal(snapshot.cadenceSensorSource, 'gyroscope_simple');
  assert.equal(snapshot.simpleGyroCadenceFresh, true);
  assert.ok(Math.abs(snapshot.finalCadenceRpm - 90) < 3);
  assert.ok(Math.abs(snapshot.estimatedSpeedKmh - 17.28) < 1);
});

test('6–14Hz 专用 Gyroscope 通道只按实测 timestamp 启用', () => {
  for (const hz of [6, 8, 10, 12, 14]) {
    const estimate = estimateLowRateGyroscopeCadence(
      lowRateGyroscopeSamples({ hz, rpm: 88 }),
    );
    assert.ok(estimate, `${hz}Hz 应进入低帧率时间域通道`);
    assert.equal(estimate.method, 'low_rate_timestamp_consensus');
    assert.equal(estimate.analysisState, 'low_rate_ready');
    assert.equal(estimate.finalEligible, true);
    assert.ok(estimate.effectiveSampleHz >= 5.25);
    assert.ok(estimate.effectiveSampleHz <= 14.75);
    assert.ok(Math.abs(estimate.rpm - 88) < 3, `${hz}Hz=${estimate.rpm}rpm`);
  }

  assert.equal(estimateLowRateGyroscopeCadence(
    lowRateGyroscopeSamples({ hz: 5, rpm: 88, jitter: false }),
  ), null);
  assert.equal(estimateLowRateGyroscopeCadence(
    lowRateGyroscopeSamples({ hz: 15, rpm: 88, jitter: false }),
  ), null);
});

test('6–14Hz 稳定周期在约 5 秒内形成 final 并暴露低帧率诊断状态', () => {
  const trusted = {
    state: 'trusted',
    artifact: 'none',
    quality: 0.9,
    allowCadenceEvidence: true,
  };
  for (const hz of [6, 8, 10, 12, 14]) {
    const imu = new CyclingImuActivity({
      startMs: 0,
      gyroscopeSampleHz: 20,
    });
    let firstFinalAtMs = null;
    let snapshot = null;
    for (const sample of lowRateGyroscopeSamples({ hz, rpm: 88 })) {
      snapshot = imu.onGyroscopeSample(
        sample,
        sample.timestampMs,
        trusted,
        sample.timestampMs,
      );
      if (firstFinalAtMs == null && snapshot.finalCadenceRpm > 0) {
        firstFinalAtMs = sample.timestampMs;
      }
    }
    assert.ok(
      firstFinalAtMs != null && firstFinalAtMs <= 5000,
      `${hz}Hz 首次 final=${firstFinalAtMs}`,
    );
    assert.ok(Math.abs(snapshot.finalCadenceRpm - 88) < 3);
    assert.equal(snapshot.cadenceUsable, true);
    assert.equal(snapshot.simpleGyroCadenceMethod, 'low_rate_timestamp_consensus');
    assert.equal(snapshot.simpleGyroAnalysisState, 'low_rate_locked');
    assert.ok(snapshot.simpleGyroEffectiveSampleHz >= 5.25);
    assert.ok(snapshot.simpleGyroEffectiveSampleHz <= 14.75);
  }
});

test('6–14Hz 强二次谐波选择真实半频，不把 55rpm 稳定锁成 110rpm', () => {
  for (const hz of [6, 8, 10, 12, 14]) {
    const samples = [];
    for (let at = 0; at <= 6000; at += 1000 / hz) {
      const phase = 2 * Math.PI * 55 * at / 60000;
      samples.push({
        timestampMs: at,
        x: 0.025 * Math.sin(phase) + 0.09 * Math.sin(phase * 2 + 0.3),
        y: 0.012 * Math.cos(phase + 0.2)
          + 0.045 * Math.cos(phase * 2 + 0.5),
        z: 0.008 * Math.sin(phase + 0.6)
          + 0.025 * Math.sin(phase * 2 + 0.8),
      });
    }
    const estimate = estimateLowRateGyroscopeCadence(samples, {
      minRpm: 45,
      maxRpm: 130,
      minSpanMs: 3000,
      minSamples: 18,
    });
    assert.ok(estimate, `${hz}Hz 应形成低帧率估算`);
    assert.ok(Math.abs(estimate.rpm - 55) < 2, `${hz}Hz=${estimate.rpm}`);
    assert.equal(estimate.finalEligible, true);
    assert.equal(estimate.method, 'low_rate_timestamp_harmonic_consensus');
  }
});

test('低帧率随机晃动、转头与触碰都不能制造 final', () => {
  const trusted = {
    state: 'trusted',
    artifact: 'none',
    quality: 0.9,
    allowCadenceEvidence: true,
  };
  for (const hz of [6, 10, 14]) {
    for (let trial = 1; trial <= 24; trial += 1) {
      const imu = new CyclingImuActivity({ startMs: 0 });
      let seed = trial * 7919 + hz * 101;
      const random = () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed / 4294967296 - 0.5;
      };
      let producedFinal = false;
      for (let at = 0; at <= 5200; at += 1000 / hz) {
        const snapshot = imu.onGyroscopeSample({
          timestampMs: at,
          x: random() * 0.12,
          y: random() * 0.12,
          z: random() * 0.12,
        }, at, trusted, at);
        producedFinal ||= snapshot.finalCadenceRpm > 0;
      }
      assert.equal(producedFinal, false, `${hz}Hz random trial=${trial}`);
    }
  }

  const headTurn = new CyclingImuActivity({ startMs: 0 });
  const headTurnArtifact = {
    state: 'head_motion',
    artifact: 'head_turn',
    quality: 0.2,
    allowCadenceEvidence: false,
  };
  let headTurnSnapshot = null;
  let headTurnFinal = false;
  for (const sample of lowRateGyroscopeSamples({ hz: 10, rpm: 88 })) {
    headTurnSnapshot = headTurn.onGyroscopeSample(
      sample,
      sample.timestampMs,
      headTurnArtifact,
      sample.timestampMs,
    );
    headTurnFinal ||= headTurnSnapshot.finalCadenceRpm > 0;
  }
  assert.equal(headTurnFinal, false);
  assert.equal(headTurnSnapshot.simpleGyroAnalysisState, 'low_rate_artifact_blocked');
  assert.equal(headTurnSnapshot.cadenceUsable, false);

  const touch = new CyclingImuActivity({ startMs: 0 });
  const touchArtifact = {
    state: 'artifact',
    artifact: 'touch',
    quality: 0,
    allowCadenceEvidence: false,
  };
  let touchSnapshot = null;
  let touchFinal = false;
  for (const sample of lowRateGyroscopeSamples({ hz: 10, rpm: 88 })) {
    touchSnapshot = touch.onGyroscopeSample(
      sample,
      sample.timestampMs,
      touchArtifact,
      sample.timestampMs,
    );
    touchFinal ||= touchSnapshot.finalCadenceRpm > 0;
  }
  assert.equal(touchFinal, false);
  assert.equal(touchSnapshot.simpleGyroAnalysisState, 'touch_blocked');
  assert.equal(touchSnapshot.cadenceUsable, false);
});

test('AR 录屏短时无回调保留已锁定数字，但不把保持值标成可积分', () => {
  const imu = new CyclingImuActivity({
    startMs: 0,
    gyroscopeSampleHz: 20,
  });
  let snapshot = null;
  for (let at = 0; at <= 4000; at += 50) {
    const phase = 2 * Math.PI * 90 * at / 60000;
    snapshot = imu.onGyroscopeReading({
      x: 0.08 * Math.sin(phase),
      y: 0.04 * Math.cos(phase),
      z: 0.02 * Math.sin(phase + 0.4),
      timestamp: at,
    }, at);
  }
  assert.ok(snapshot.finalCadenceRpm > 0);

  const held = imu.snapshot(6500, 6500);
  assert.equal(held.fresh, false);
  assert.equal(held.simpleGyroDisplayHolding, true);
  assert.ok(held.finalCadenceRpm > 0);
  assert.ok(held.estimatedSpeedKmh > 0);
  assert.equal(held.cadenceUsable, false);
  assert.equal(held.simpleGyroLedgerFresh, false);

  const expired = imu.snapshot(10001, 10001);
  assert.equal(expired.simpleGyroDisplayFresh, false);
  assert.equal(expired.finalCadenceRpm, null);
  assert.equal(expired.estimatedSpeedKmh, null);
});

test('简易 Gyroscope 通道拒绝同幅度非周期随机晃动', () => {
  const samples = [];
  let seed = 123456789;
  for (let at = 0; at <= 5000; at += 50) {
    const values = [];
    for (let axis = 0; axis < 3; axis += 1) {
      seed = (1664525 * seed + 1013904223) >>> 0;
      values.push((seed / 4294967296 - 0.5) * 0.04);
    }
    samples.push({
      timestampMs: at,
      x: values[0],
      y: values[1],
      z: values[2],
    });
  }
  assert.equal(estimateSimpleGyroscopeCadence(samples), null);
});

test('严格频谱拒绝畸变波形时，受约束 crossing 回退仍在 5 秒内形成三项证据', () => {
  const samples = [];
  const imu = new CyclingImuActivity({
    startMs: 0,
    gyroscopeSampleHz: 20,
  });
  const artifact = {
    state: 'road_impact',
    artifact: 'road_impact',
    quality: 0.2,
    allowCadenceEvidence: false,
  };
  let firstCandidateAtMs = null;
  let firstFinalAtMs = null;
  let snapshot = null;
  for (let at = 0; at <= 5000; at += 50) {
    const cycle = 88 * at / 60000;
    const distorted = 0.05 * (
      Math.sin(2 * Math.PI * cycle)
      + 1.8 * Math.sin(6 * Math.PI * cycle + 0.2)
    );
    const sample = {
      timestampMs: at,
      x: distorted,
      y: distorted * 0.35,
      z: 0,
    };
    samples.push(sample);
    snapshot = imu.onGyroscopeSample(sample, at, artifact, at);
    if (firstCandidateAtMs == null && snapshot.effectiveCadenceRpm > 0) {
      firstCandidateAtMs = at;
    }
    if (firstFinalAtMs == null && snapshot.finalCadenceRpm > 0) {
      firstFinalAtMs = at;
    }
  }

  const firstWindow = samples.filter((sample) => sample.timestampMs <= 4500);
  assert.equal(estimateSimpleGyroscopeCadence(firstWindow), null);
  const fallback = estimateFallbackGyroscopeCadence(firstWindow);
  assert.ok(fallback);
  assert.equal(fallback.method, 'fallback_crossing');
  assert.equal(fallback.finalEligible, true);
  assert.ok(firstCandidateAtMs != null && firstCandidateAtMs <= 4000);
  assert.ok(firstFinalAtMs != null && firstFinalAtMs <= 5000);
  assert.ok(Math.abs(snapshot.finalCadenceRpm - 88) < 5);
  assert.equal(snapshot.cadenceUsable, true);
  assert.equal(snapshot.simpleGyroLedgerFresh, true);
});

test('已锁定后跨 strict/fallback 的三候选共识可从真机频率跳变重新锁定', () => {
  const imu = new CyclingImuActivity({
    startMs: 0,
    gyroscopeSampleHz: 20,
  });
  // 对应 Hermes 实测：旧 final 71.91rpm 已过 6 秒，之后宽松 ACF 持续
  // 给出约 88.83rpm，下一次 trusted 严格窗应复用这些跨方法证据重锁。
  imu.simpleGyroCadenceRpm = 71.91;
  imu.simpleGyroCadenceConfidence = 0.8;
  imu.simpleGyroCadenceCorrelation = 0.7;
  imu.simpleGyroCadenceAtMs = 0;
  imu.simpleGyroCadenceReceivedAtMs = 0;
  imu.simpleGyroLedgerAtMs = 0;
  imu.simpleGyroLedgerReceivedAtMs = 0;
  for (let at = 6300; at < 10800; at += 50) {
    const phase = 2 * Math.PI * 88.83 * at / 60000;
    imu.simpleGyroscopeSamples.push({
      timestampMs: at,
      x: 0.08 * Math.sin(phase),
      y: 0.04 * Math.cos(phase),
      z: 0.02 * Math.sin(phase + 0.4),
    });
  }
  imu.simpleGyroCandidateHistory = [
    {
      rpm: 88.83,
      confidence: 0.72,
      correlation: 0.7,
      atMs: 10000,
      receivedAtMs: 10000,
      method: 'fallback_autocorrelation',
      fallback: true,
      finalEligible: false,
      evidenceAtMs: 10000,
    },
    {
      rpm: 88.7,
      confidence: 0.73,
      correlation: 0.72,
      atMs: 10400,
      receivedAtMs: 10400,
      method: 'fallback_autocorrelation',
      fallback: true,
      finalEligible: false,
      evidenceAtMs: 10400,
    },
  ];
  imu.simpleGyroLastAnalysisMs = null;
  const at = 10800;
  const phase = 2 * Math.PI * 88.83 * at / 60000;
  const snapshot = imu.onGyroscopeSample({
    timestampMs: at,
    x: 0.08 * Math.sin(phase),
    y: 0.04 * Math.cos(phase),
    z: 0.02 * Math.sin(phase + 0.4),
  }, at, {
    state: 'trusted',
    artifact: 'none',
    quality: 0.9,
    allowCadenceEvidence: true,
  }, at);

  assert.equal(snapshot.fresh, true);
  assert.equal(snapshot.cadenceUsable, true);
  assert.equal(snapshot.cadenceState, 'estimated');
  assert.ok(Math.abs(snapshot.finalCadenceRpm - 88.83) < 2);
  assert.equal(imu.simpleGyroCandidateHistory.some(
    (candidate) => candidate.fallback === true,
  ), true);
  assert.equal(imu.simpleGyroCandidateHistory.some(
    (candidate) => candidate.fallback === false,
  ), true);
});

test('首次全 fallback ACF 三候选仍不能制造 final，跳变候选也不能重锁', () => {
  const firstLock = new CyclingImuActivity({ startMs: 0 });
  firstLock.simpleGyroCandidateHistory = [0, 400, 800].map((atMs) => ({
    rpm: 88.8,
    confidence: 0.72,
    correlation: 0.7,
    atMs,
    receivedAtMs: atMs,
    method: 'fallback_autocorrelation',
    fallback: true,
    finalEligible: false,
    evidenceAtMs: atMs,
  }));
  assert.equal(firstLock._simpleGyroRelockCandidates(88.8, true), null);
  assert.equal(firstLock.snapshot(800, 800).finalCadenceRpm, null);

  const relock = new CyclingImuActivity({ startMs: 0 });
  relock.simpleGyroCadenceRpm = 72;
  relock.simpleGyroCandidateHistory = [
    { rpm: 60, atMs: 0 },
    { rpm: 89, atMs: 400 },
    { rpm: 97, atMs: 800 },
  ].map((candidate) => ({
    ...candidate,
    confidence: 0.72,
    correlation: 0.7,
    receivedAtMs: candidate.atMs,
    method: 'fallback_autocorrelation',
    fallback: true,
    finalEligible: false,
    evidenceAtMs: candidate.atMs,
  }));
  assert.equal(relock._simpleGyroRelockCandidates(89, true), null);
});

test('131rpm 倍频锁定后在 soft artifact 下可由持续 74rpm 基频证据向下重锁', () => {
  const imu = new CyclingImuActivity({
    startMs: 0,
    gyroscopeSampleHz: 20,
    simpleGyroMaxRpm: 140,
  });
  const quality = (artifact) => ({
    state: artifact === 'none'
      ? 'trusted' : (artifact === 'head_turn' ? 'head_motion' : 'road_impact'),
    artifact,
    quality: artifact === 'none' ? 0.9 : 0.2,
    allowCadenceEvidence: artifact === 'none',
  });
  const sampleAt = (at, rpm) => {
    const phase = 2 * Math.PI * rpm * at / 60000;
    return {
      timestampMs: at,
      x: 0.07 * Math.sin(phase),
      y: 0.035 * Math.cos(phase + 0.2),
      z: 0.018 * Math.sin(phase + 0.6),
    };
  };

  let snapshot = null;
  for (let at = 0; at <= 6500; at += 100) {
    snapshot = imu.onGyroscopeSample(
      sampleAt(at, 131), at, quality('none'), at,
    );
  }
  assert.ok(Math.abs(snapshot.finalCadenceRpm - 131) < 2);

  let relockedAtMs = null;
  for (let at = 6600; at <= 14000; at += 100) {
    const artifact = Math.floor((at - 6600) / 1000) % 2
      ? 'head_turn' : 'road_impact';
    snapshot = imu.onGyroscopeSample(
      sampleAt(at, 74), at, quality(artifact), at,
    );
    if (relockedAtMs == null
        && Math.abs((snapshot.finalCadenceRpm ?? 0) - 74) < 3) {
      relockedAtMs = at;
    }
  }

  assert.ok(relockedAtMs != null && relockedAtMs <= 12500);
  assert.ok(Math.abs(snapshot.finalCadenceRpm - 74) < 3);
  assert.equal(snapshot.cadenceUsable, true);
  assert.equal(imu.simpleGyroCandidateHistory.some(
    (candidate) => candidate.artifact === 'road_impact'
      && candidate.finalEligible === true,
  ), true);
  assert.equal(imu.simpleGyroCandidateHistory.some(
    (candidate) => candidate.artifact === 'head_turn'
      && candidate.finalEligible === true,
  ), true);
});

test('6–14Hz 矩阵在旧锁 freshness 过期后仍可由本场可信锚 131→74 向下重锁', () => {
  const quality = (artifact) => ({
    state: artifact === 'none'
      ? 'trusted' : (artifact === 'head_turn' ? 'head_motion' : 'road_impact'),
    artifact,
    quality: artifact === 'none' ? 0.9 : 0.2,
    allowCadenceEvidence: artifact === 'none',
  });
  const sampleAt = (at, rpm) => {
    const phase = 2 * Math.PI * rpm * at / 60000;
    return {
      timestampMs: at,
      x: 0.07 * Math.sin(phase),
      y: 0.035 * Math.cos(phase + 0.2),
      z: 0.018 * Math.sin(phase + 0.6),
    };
  };

  for (const hz of [6, 8, 10, 12, 14]) {
    const imu = new CyclingImuActivity({
      startMs: 0,
      gyroscopeSampleHz: 20,
      simpleGyroMaxRpm: 140,
    });
    let at = 0;
    let snapshot = null;
    while (at <= 7000) {
      snapshot = imu.onGyroscopeSample(
        sampleAt(at, 131), at, quality('none'), at,
      );
      at += 1000 / hz;
    }
    assert.ok(
      Math.abs((snapshot.finalCadenceRpm ?? 0) - 131) < 3,
      `${hz}Hz 应先形成可信高频锁`,
    );

    let relockedAtMs = null;
    while (at <= 18000) {
      const artifact = Math.floor((at - 7000) / 1000) % 2
        ? 'head_turn' : 'road_impact';
      snapshot = imu.onGyroscopeSample(
        sampleAt(at, 74), at, quality(artifact), at,
      );
      if (relockedAtMs == null
          && Math.abs((snapshot.finalCadenceRpm ?? 0) - 74) < 3) {
        relockedAtMs = at;
      }
      at += 1000 / hz;
    }
    assert.ok(
      relockedAtMs != null && relockedAtMs <= 14000,
      `${hz}Hz 应在有界窗口向下重锁，实际=${relockedAtMs}`,
    );
    assert.ok(Math.abs(snapshot.finalCadenceRpm - 74) < 3);
    assert.equal(snapshot.cadenceUsable, true);
  }
});

test('明确静止清空本场高频锚，后续 soft artifact 不得借旧资格重锁', () => {
  const imu = new CyclingImuActivity({
    startMs: 0,
    gyroscopeSampleHz: 20,
    simpleGyroMaxRpm: 140,
  });
  const trusted = {
    state: 'trusted',
    artifact: 'none',
    quality: 0.9,
    allowCadenceEvidence: true,
  };
  const artifact = {
    state: 'road_impact',
    artifact: 'road_impact',
    quality: 0.2,
    allowCadenceEvidence: false,
  };
  const sampleAt = (at, rpm, amplitude = 0.07) => {
    const phase = 2 * Math.PI * rpm * at / 60000;
    return {
      timestampMs: at,
      x: amplitude * Math.sin(phase),
      y: amplitude * 0.5 * Math.cos(phase + 0.2),
      z: amplitude * 0.25 * Math.sin(phase + 0.6),
    };
  };

  let snapshot = null;
  for (let at = 0; at <= 7000; at += 100) {
    snapshot = imu.onGyroscopeSample(sampleAt(at, 131), at, trusted, at);
  }
  assert.ok(Math.abs(snapshot.finalCadenceRpm - 131) < 3);
  assert.ok(imu.simpleGyroTrustedFinalRpm >= 110);

  for (let at = 7100; at <= 10000; at += 100) {
    snapshot = imu.onGyroscopeSample(
      sampleAt(at, 74, 0), at, trusted, at,
    );
  }
  assert.equal(snapshot.cadenceState, 'stationary');
  assert.equal(imu.simpleGyroTrustedFinalRpm, null);
  assert.equal(imu.simpleGyroTrustedFinalAtMs, null);

  for (let at = 10100; at <= 19000; at += 100) {
    snapshot = imu.onGyroscopeSample(sampleAt(at, 74), at, artifact, at);
  }
  assert.ok(!(snapshot.finalCadenceRpm > 0));
  assert.equal(snapshot.cadenceUsable, false);
});

test('向下谐波重锁拒绝反向倍频、弱相关和 fallback_autocorrelation', () => {
  const candidate = (overrides = {}) => ({
    rpm: 74,
    confidence: 0.76,
    correlation: 0.7,
    atMs: 2000,
    receivedAtMs: 2000,
    method: 'low_rate_timestamp_consensus',
    fallback: false,
    finalEligible: true,
    relockEligible: true,
    evidenceAtMs: 2000,
    artifact: 'road_impact',
    ...overrides,
  });

  const downward = new CyclingImuActivity({
    startMs: 0,
    simpleGyroMaxRpm: 140,
  });
  downward.simpleGyroCadenceRpm = 131;
  downward.simpleGyroTrustedFinalRpm = 131;
  downward.simpleGyroTrustedFinalAtMs = 1000;
  downward.simpleGyroCandidateHistory = [
    candidate({ atMs: 2000, evidenceAtMs: 1950 }),
    candidate({ atMs: 3000, evidenceAtMs: 2950, artifact: 'head_turn' }),
  ];
  assert.equal(
    downward._simpleGyroDownwardHarmonicRelockCandidates(74, 3000)?.length,
    2,
  );

  const upward = new CyclingImuActivity({
    startMs: 0,
    simpleGyroMaxRpm: 140,
  });
  upward.simpleGyroCadenceRpm = 74;
  upward.simpleGyroTrustedFinalRpm = 74;
  upward.simpleGyroTrustedFinalAtMs = 1000;
  upward.simpleGyroCandidateHistory = [
    candidate({ rpm: 131, atMs: 2000, evidenceAtMs: 1950 }),
    candidate({ rpm: 131, atMs: 3000, evidenceAtMs: 2950 }),
  ];
  assert.equal(upward._simpleGyroDownwardHarmonicRelockCandidates(131, 3000), null);

  downward.simpleGyroCandidateHistory = [
    candidate({ atMs: 2000, evidenceAtMs: 1950, correlation: 0.54 }),
    candidate({ atMs: 3000, evidenceAtMs: 2950, correlation: 0.54 }),
  ];
  assert.equal(downward._simpleGyroDownwardHarmonicRelockCandidates(74, 3000), null);

  downward.simpleGyroCandidateHistory = [
    candidate({
      atMs: 2000,
      evidenceAtMs: 1950,
      method: 'fallback_autocorrelation',
    }),
    candidate({
      atMs: 3000,
      evidenceAtMs: 2950,
      method: 'fallback_autocorrelation',
    }),
  ];
  assert.equal(downward._simpleGyroDownwardHarmonicRelockCandidates(74, 3000), null);
});

test('soft artifact 下的多组白噪声可有诊断候选，但不得进入距离 final', () => {
  const artifact = {
    state: 'road_impact',
    artifact: 'road_impact',
    quality: 0.2,
    allowCadenceEvidence: false,
  };
  for (let trial = 1; trial <= 32; trial += 1) {
    const imu = new CyclingImuActivity({
      startMs: 0,
      gyroscopeSampleHz: 20,
    });
    let seed = trial * 7919;
    const random = () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed / 4294967296 - 0.5;
    };
    let snapshot = null;
    for (let at = 0; at <= 6000; at += 50) {
      snapshot = imu.onGyroscopeSample({
        timestampMs: at,
        x: random() * 0.08,
        y: random() * 0.08,
        z: random() * 0.08,
      }, at, artifact, at);
    }
    assert.ok(
      !(snapshot.finalCadenceRpm > 0),
      `trial ${trial} 不得把随机摇晃写进里程 final`,
    );
    assert.equal(snapshot.cadenceUsable, false);
  }
});

test('简易 Gyroscope 在 8–60Hz 抖动丢帧矩阵中不再出现半频或倍频', () => {
  for (const hz of [8, 10, 12, 20, 60]) {
    for (const rpm of [45, 60, 90, 125]) {
      for (const phase of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        const estimate = estimateSimpleGyroscopeCadence(
          gyroscopeStressSamples({ hz, rpm, phase }),
        );
        assert.ok(estimate, `${hz}Hz ${rpm}rpm phase=${phase} 应有估算`);
        const tolerance = hz <= 10 ? 5 : 3;
        assert.ok(
          Math.abs(estimate.rpm - rpm) <= tolerance,
          `${hz}Hz ${rpm}rpm 实际=${estimate.rpm}`,
        );
        assert.ok(estimate.confidence < 0.99);
      }
    }
  }
});

test('PCA 主轴与显式谐波规则可处理眼镜慢转轴和强二次谐波', () => {
  for (const hz of [8, 20, 60]) {
    const rotated = estimateSimpleGyroscopeCadence(
      gyroscopeStressSamples({
        hz,
        rpm: 88,
        phase: Math.PI / 3,
        rotateRad: 1,
      }),
    );
    assert.ok(rotated);
    assert.ok(Math.abs(rotated.rpm - 88) <= (hz === 8 ? 5 : 3));

    const harmonic = estimateSimpleGyroscopeCadence(
      gyroscopeStressSamples({
        hz,
        rpm: 55,
        phase: Math.PI / 4,
        secondHarmonic: 1.45,
      }),
    );
    assert.ok(harmonic);
    assert.ok(Math.abs(harmonic.rpm - 55) <= (hz === 8 ? 5 : 3));

    const pureHigh = estimateSimpleGyroscopeCadence(
      gyroscopeStressSamples({
        hz,
        rpm: 110,
        phase: Math.PI / 4,
      }),
    );
    assert.ok(pureHigh);
    assert.ok(Math.abs(pureHigh.rpm - 110) <= (hz === 8 ? 5 : 3));
  }
});

test('真机持续 soft artifact 仍可先建锁，锁定后转头与冲击不改写踏频', () => {
  const pollutedOnly = new CyclingImuActivity({
    startMs: 0,
    gyroscopeSampleHz: 20,
  });
  for (let at = 0; at <= 3500; at += 50) {
    const phase = 2 * Math.PI * 88 * at / 60000;
    pollutedOnly.onGyroscopeSample({
      x: 0.03 * Math.sin(phase),
      y: 0.015 * Math.cos(phase),
      z: 0.008 * Math.sin(phase + 0.4),
      timestampMs: at,
    }, at, {
      state: 'head_motion',
      artifact: 'head_turn',
      quality: 0.2,
      allowCadenceEvidence: false,
    }, at);
  }
  const artifactLocked = pollutedOnly.snapshot(3500);
  assert.equal(artifactLocked.simpleGyroCadenceFresh, true);
  assert.equal(artifactLocked.cadenceUsable, true);
  assert.equal(artifactLocked.motionArtifact, 'none');
  assert.ok(Math.abs(artifactLocked.finalCadenceRpm - 88) < 3);

  const imu = new CyclingImuActivity({
    startMs: 0,
    gyroscopeSampleHz: 20,
  });
  let snapshot = null;
  for (let at = 0; at <= 3500; at += 50) {
    const phase = 2 * Math.PI * 88 * at / 60000;
    snapshot = imu.onGyroscopeSample({
      x: 0.03 * Math.sin(phase),
      y: 0.015 * Math.cos(phase),
      z: 0.008 * Math.sin(phase + 0.4),
      timestampMs: at,
    }, at, {
      state: 'trusted',
      artifact: 'none',
      quality: 0.9,
      allowCadenceEvidence: true,
    }, at);
  }
  const lockedRpm = snapshot.finalCadenceRpm;
  const softArtifacts = ['road_impact', 'head_turn'];
  for (let at = 3550; at <= 4550; at += 50) {
    const phase = 2 * Math.PI * 120 * at / 60000;
    const artifact = softArtifacts[Math.floor((at - 3550) / 500) % 2];
    snapshot = imu.onGyroscopeSample({
      x: 0.9 * Math.sin(phase),
      y: 0.6 * Math.cos(phase),
      z: 0.5 * Math.sin(phase + 0.4),
      timestampMs: at,
    }, at, {
      state: artifact === 'head_turn' ? 'head_motion' : 'road_impact',
      artifact,
      quality: 0.2,
      allowCadenceEvidence: false,
    }, at);
  }
  assert.equal(snapshot.simpleGyroCadenceFresh, true);
  assert.equal(snapshot.cadenceSensorSource, 'gyroscope_simple');
  assert.equal(snapshot.motionArtifact, 'none');
  assert.ok(Math.abs(snapshot.finalCadenceRpm - lockedRpm) < 0.1);
  assert.equal(snapshot.cadenceUsable, true);

  snapshot = imu.onGyroscopeSample({
    x: 1.2,
    y: 0.8,
    z: 1.5,
    timestampMs: 4600,
  }, 4600, {
    state: 'touch',
    artifact: 'touch',
    quality: 0,
    allowCadenceEvidence: false,
  }, 4600);
  assert.equal(snapshot.simpleGyroCadenceFresh, false);
  assert.equal(snapshot.motionArtifact, 'touch');
  assert.equal(snapshot.cadenceUsable, false);
});

test('Gyroscope artifact 不进入周期窗，未来时间轴也不阻塞恢复的 Accelerometer', () => {
  const imu = new CyclingImuActivity({
    startMs: 0,
    sampleHz: 25,
    gyroscopeSampleHz: 20,
  });
  const touch = {
    state: 'touch',
    artifact: 'touch',
    quality: 0,
    allowCadenceEvidence: false,
  };
  imu.onGyroscopeSample({
    x: 1.2,
    y: 0.8,
    z: 1.5,
    timestampMs: 20000,
  }, 20000, touch, 0);
  assert.equal(imu.gyroscopeCadenceSamples.length, 0);
  assert.equal(imu.lastCadenceAnalysisSource, 'gyroscope');
  assert.equal(imu.lastCadenceAnalysisMsBySource.gyroscope, 20000);
  assert.equal(imu.lastCadenceAnalysisMsBySource.accelerometer, null);

  for (let at = 0; at <= 6500; at += 40) {
    const phase = 2 * Math.PI * 90 * at / 60000;
    imu.onSample({
      x: 0.9 * Math.sin(phase),
      y: 0.5 * Math.cos(phase + 0.2),
      z: 9.80665 + 0.2 * Math.sin(phase + 0.7),
    }, at, null, at + 10);
  }
  const snapshot = imu.snapshot(6510, 6510);
  assert.equal(imu.lastCadenceAnalysisSource, 'accelerometer');
  assert.ok(imu.lastCadenceAnalysisMsBySource.accelerometer < 20000);
  assert.equal(snapshot.cadenceState, 'estimated');
  assert.ok(Math.abs(snapshot.finalCadenceRpm - 90) < 3);
});

test('复杂融合至少 1000ms 才重算，且同刻 Accelerometer/Gyroscope 只触发一次', () => {
  const imu = new CyclingImuActivity({
    startMs: 0,
    cadenceAnalysisIntervalMs: 500,
  });
  assert.equal(imu.cadenceAnalysisIntervalMs, 1000);
  imu._cadenceInputsReadyForAnalysis = () => true;
  imu._hasCadenceAnalysisEnergy = () => true;
  let analysisCalls = 0;
  imu._estimateCadence = () => {
    analysisCalls += 1;
    return null;
  };
  imu._updateCadenceEstimate(1000, 'accelerometer');
  imu._updateCadenceEstimate(1020, 'gyroscope');
  imu._updateCadenceEstimate(1500, 'accelerometer');
  imu._updateCadenceEstimate(1520, 'gyroscope');
  assert.equal(analysisCalls, 1);
  imu._updateCadenceEstimate(2000, 'gyroscope');
  imu._updateCadenceEstimate(2020, 'accelerometer');
  assert.equal(analysisCalls, 2);
  imu._updateCadenceEstimate(1500, 'accelerometer');
  imu._updateCadenceEstimate(1520, 'gyroscope');
  assert.equal(analysisCalls, 2);

  const skewed = new CyclingImuActivity({ startMs: 0 });
  skewed._cadenceInputsReadyForAnalysis = () => true;
  skewed._hasCadenceAnalysisEnergy = () => true;
  let skewedCalls = 0;
  skewed._estimateCadence = () => {
    skewedCalls += 1;
    return null;
  };
  skewed._updateCadenceEstimate(20000, 'gyroscope');
  skewed._updateCadenceEstimate(1000, 'accelerometer');
  assert.equal(skewedCalls, 2);
});

test('静止/低能量在昂贵整窗前快速返回', () => {
  const imu = new CyclingImuActivity({
    startMs: 0,
    cadenceAnalysisIntervalMs: 500,
  });
  let fusionCalls = 0;
  imu._estimateCadence = () => {
    fusionCalls += 1;
    return null;
  };
  feedStill(imu, 0, 6000);
  assert.equal(fusionCalls, 0);
  assert.equal(imu.snapshot(6000).motionState, 'stationary');

  const gyro = new CyclingImuActivity({
    startMs: 0,
    stationaryConfirmMs: 100000,
  });
  for (let at = 0; at <= 5000; at += 50) {
    gyro.onGyroscopeSample({
      x: 0.01,
      y: -0.006,
      z: 0.004,
      timestampMs: at,
    }, at, null, at);
  }
  assert.equal(gyro.simpleGyroAnalysisState, 'low_energy');
  assert.ok(gyro.simpleGyroLastAnalysisMs >= 4000
    && gyro.simpleGyroLastAnalysisMs <= 5000);
  assert.equal(gyro.snapshot(5000).finalCadenceRpm, null);
});

test('Gyroscope-only 确认静止后只在状态边沿清理一次', () => {
  const imu = new CyclingImuActivity({ startMs: 0 });
  const setStationary = imu._setStationaryCadence.bind(imu);
  let stationarySetCalls = 0;
  imu._setStationaryCadence = (...args) => {
    stationarySetCalls += 1;
    return setStationary(...args);
  };

  for (let at = 0; at <= 10000; at += 20) {
    imu.onGyroscopeSample({
      x: 0,
      y: 0,
      z: 0,
      timestampMs: at,
    }, at, null, at);
  }

  assert.equal(imu.snapshot(10000).motionState, 'stationary');
  assert.equal(imu.snapshot(10000).finalCadenceRpm, 0);
  assert.equal(stationarySetCalls, 1);
});

test('Gyroscope 静止清窗后遇到强周期仍可在 5 秒内重新唤醒', () => {
  const imu = new CyclingImuActivity({ startMs: 0 });
  for (let at = 0; at <= 3000; at += 50) {
    imu.onGyroscopeSample({
      x: 0,
      y: 0,
      z: 0,
      timestampMs: at,
    }, at, null, at);
  }
  assert.equal(imu.snapshot(3000).motionState, 'stationary');
  assert.equal(imu.snapshot(3000).finalCadenceRpm, 0);

  let firstLockedAtMs = null;
  let snapshot = null;
  for (let at = 3050; at <= 8050; at += 50) {
    const phase = 2 * Math.PI * 90 * (at - 3050) / 60000;
    snapshot = imu.onGyroscopeSample({
      x: 0.08 * Math.sin(phase),
      y: 0.04 * Math.cos(phase),
      z: 0.02 * Math.sin(phase + 0.4),
      timestampMs: at,
    }, at, null, at);
    if (firstLockedAtMs == null && snapshot.finalCadenceRpm > 0) {
      firstLockedAtMs = at;
    }
  }
  assert.ok(firstLockedAtMs != null && firstLockedAtMs - 3050 <= 5000);
  assert.equal(snapshot.motionState, 'moving');
  assert.equal(snapshot.cadenceSensorSource, 'gyroscope_simple');
  assert.ok(Math.abs(snapshot.finalCadenceRpm - 90) < 3);
});

test('已锁定踏频后持续低能量回调确认静止，立即撤销 6 秒旧值保持', () => {
  const imu = new CyclingImuActivity({ startMs: 0 });
  let snapshot = null;
  for (let at = 0; at <= 5000; at += 20) {
    const phase = 2 * Math.PI * 90 * at / 60000;
    snapshot = imu.onGyroscopeSample({
      x: 0.08 * Math.sin(phase),
      y: 0.04 * Math.cos(phase),
      z: 0.02 * Math.sin(phase + 0.4),
      timestampMs: at,
    }, at, null, at);
  }
  assert.ok(snapshot.finalCadenceRpm > 0);
  assert.equal(snapshot.motionState, 'moving');

  for (let at = 5020; at <= 7500; at += 20) {
    snapshot = imu.onGyroscopeSample({
      x: 0,
      y: 0,
      z: 0,
      timestampMs: at,
    }, at, null, at);
  }
  assert.equal(snapshot.motionState, 'stationary');
  assert.equal(snapshot.cadenceState, 'stationary');
  assert.equal(snapshot.finalCadenceRpm, 0);
  assert.equal(snapshot.estimatedSpeedKmh, 0);
  assert.equal(snapshot.simpleGyroDisplayFresh, false);
});

test('低频稳定踩踏遇到周期性道路冲击不会每帧清空整条候选链', () => {
  const gate = new CyclingMotionQualityGate();
  const imu = new CyclingImuActivity({
    startMs: 0,
    sampleHz: 25,
    motionQualityGate: gate,
  });
  const stepMs = 125;
  let sawFinal = false;
  let preservedDuringImpact = false;
  let lastSnapshot = null;
  for (let at = 0; at <= 30000; at += stepMs) {
    const phase = 2 * Math.PI * 90 * at / 60000;
    const roadImpact = at >= 6000 && (at - 6000) % 3000 === 0;
    lastSnapshot = imu.onReading({
      x: 0.07 * Math.sin(phase) + (roadImpact ? 4 : 0),
      y: 0,
      z: 9.80665,
      timestamp: at,
    }, at);
    if (lastSnapshot.finalCadenceRpm > 0) sawFinal = true;
    if (lastSnapshot.rawMotionArtifact === 'road_impact'
        && imu.cadenceCandidates.length > 0) {
      preservedDuringImpact = true;
    }
  }
  assert.equal(sawFinal, true);
  assert.equal(preservedDuringImpact, true);
  assert.notEqual(lastSnapshot.motionArtifact, 'touch');
  assert.notEqual(lastSnapshot.motionArtifact, 'head_turn');
});

test('5.5Hz 静止仍只输出 stationary 零值，不生成正踏频', () => {
  const imu = new CyclingImuActivity({ startMs: 0, sampleHz: 25 });
  const stepMs = 1000 / 5.5;
  let snapshot = null;
  for (let at = 0; at <= 16000; at += stepMs) {
    snapshot = imu.onReading({
      x: 0,
      y: 0,
      z: 9.80665,
      timestamp: at,
    }, at);
  }
  assert.equal(snapshot.motionState, 'stationary');
  assert.equal(snapshot.cadenceState, 'stationary');
  assert.equal(snapshot.finalCadenceRpm, 0);
  assert.equal(snapshot.estimatedSpeedKmh, 0);
});

test('artifact 加速度只更新重力锚，不污染 moving 或自动恢复证据', () => {
  const imu = new CyclingImuActivity({ startMs: 0, sampleHz: 25 });
  imu.setSessionPaused(true);
  imu.onSample({ x: 0, y: 0, z: 9.80665 }, 0);
  const quality = {
    state: 'touch',
    artifact: 'touch',
    quality: 0,
    allowCadenceEvidence: false,
    headMotionKnown: true,
  };
  for (let at = 40; at <= 1200; at += 40) {
    const sign = at % 80 === 0 ? 1 : -1;
    imu.onSample({
      x: sign * 5,
      y: sign * 3,
      z: 9.80665,
    }, at, quality);
  }
  const snapshot = imu.snapshot(1200);
  assert.equal(snapshot.motionState, 'unknown');
  assert.equal(snapshot.motionScore, 0);
  assert.equal(snapshot.autoResumeSuggested, false);
  assert.equal(snapshot.cadenceState, 'artifact');
});

test('质量门缺少或失去辅助传感器时仍允许 Accelerometer-only 踏频', () => {
  const gate = new CyclingMotionQualityGate();
  const imu = new CyclingImuActivity({
    startMs: 0,
    sampleHz: 25,
    motionQualityGate: gate,
  });
  let snapshot = null;
  for (let at = 0; at <= 12000; at += 40) {
    const phase = 2 * Math.PI * 84 * at / 60000;
    snapshot = imu.onReading({
      x: 0.7 * Math.sin(phase),
      y: 0.35 * Math.cos(phase + 0.2),
      z: 9.80665 + 0.16 * Math.sin(phase + 0.7),
      timestamp: at,
    }, at);
  }
  assert.equal(snapshot.motionQualityState, 'accel_only');
  assert.equal(snapshot.cadenceEvidenceAllowed, true);
  assert.equal(snapshot.cadenceState, 'estimated');
  assert.ok(Math.abs(snapshot.finalCadenceRpm - 84) < 3);
});

test('AIUI 0.15 传感器秒/毫秒/微秒/纳秒时间戳都归一为单调毫秒', () => {
  const cases = [
    { start: 10, delta: 0.04, expectedScale: 1000 },
    { start: 10000, delta: 40, expectedScale: 1 },
    { start: 10000000, delta: 40000, expectedScale: 0.001 },
    { start: 10000000000, delta: 40000000, expectedScale: 0.000001 },
  ];
  for (const item of cases) {
    const clock = new SensorTimestampNormalizer({ frequency: 25 });
    const first = clock.normalize(item.start, 1000);
    const second = clock.normalize(item.start + item.delta, 1040);
    assert.ok(Math.abs(second - first - 40) < 0.001);
    assert.equal(clock.rawScaleToMs, item.expectedScale);
  }

  const fallback = new SensorTimestampNormalizer({ frequency: 25 });
  const values = [
    fallback.normalize(null, 1000),
    fallback.normalize(null, 1000),
    fallback.normalize(5, 1040),
    fallback.normalize(4, 1040),
  ];
  assert.deepEqual(values, [1000, 1040, 1080, 1120]);
  assert.equal(fallback.normalize(5, 5000), 5000, '真实长空档应重新贴合接收墙钟');

  const batched = new SensorTimestampNormalizer({ frequency: 25 });
  const batchedValues = [];
  for (let index = 0; index < 30; index += 1) {
    batchedValues.push(batched.normalize(null, 1000));
  }
  assert.ok(
    batchedValues.every((value, index) => (
      index === 0 || value > batchedValues[index - 1]
    )),
    '批量帧仍须严格单调',
  );
  assert.ok(
    Math.abs(
      batchedValues[batchedValues.length - 1]
        - batchedValues[0] - 1160,
    ) < 0.01,
    '无 timestamp 的同毫秒批量帧仍须保留 frequency hint 的分析跨度',
  );
  const caughtUp = batched.normalize(null, 1300);
  assert.equal(caughtUp, 2200);

  const timestampedBatch = new SensorTimestampNormalizer({ frequency: 25 });
  const timestampedValues = [];
  for (let index = 0; index < 30; index += 1) {
    timestampedValues.push(timestampedBatch.normalize(10 + index * 0.04, 1000));
  }
  assert.ok(
    Math.abs(
      timestampedValues[timestampedValues.length - 1]
        - timestampedValues[0] - 1160,
    ) < 0.01,
    '原始时间戳有效时必须保留批量送达前的真实采样跨度',
  );
});

test('无 timestamp 的 AIUI 批量 reading 仍可在约 5 秒形成踏频', () => {
  const imu = new CyclingImuActivity({
    startMs: 0,
    sampleHz: 25,
    cadenceAnalysisIntervalMs: 500,
  });
  const rpm = 90;
  let snapshot = null;
  for (let second = 0; second < 6; second += 1) {
    const wallNow = second * 1000;
    for (let frame = 0; frame < 25; frame += 1) {
      const sampleAt = second * 1000 + frame * 40;
      const phase = 2 * Math.PI * rpm * sampleAt / 60000;
      snapshot = imu.onReading({
        x: 0.7 * Math.sin(phase),
        y: 0.35 * Math.cos(phase + 0.2),
        z: 9.80665 + 0.16 * Math.sin(phase + 0.7),
      }, wallNow);
    }
  }
  assert.equal(snapshot.fresh, true);
  assert.equal(snapshot.cadenceState, 'estimated');
  assert.ok(Math.abs(snapshot.finalCadenceRpm - rpm) < 3);
});

test('无 timestamp 的批量随机晃动仍不能伪造踏频', () => {
  const imu = new CyclingImuActivity({
    startMs: 0,
    sampleHz: 25,
    cadenceAnalysisIntervalMs: 500,
  });
  let seed = 0x13579bdf;
  let snapshot = null;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff - 0.5) * 2;
  };
  for (let second = 0; second < 8; second += 1) {
    const wallNow = second * 1000;
    for (let frame = 0; frame < 25; frame += 1) {
      snapshot = imu.onReading({
        x: noise() * 0.9,
        y: noise() * 0.7,
        z: 9.80665 + noise() * 0.5,
      }, wallNow);
    }
  }
  assert.equal(snapshot.fresh, true);
  assert.equal(snapshot.finalCadenceRpm, null);
  assert.notEqual(snapshot.cadenceState, 'estimated');
});

test('加速度单位只识别约 1g 或 9.80665m/s²，未知稳定值安全透传', () => {
  const calibrate = (magnitude) => {
    const calibrator = new AccelerationUnitCalibrator();
    for (let index = 0; index < 24; index += 1) {
      calibrator.push(0, 0, magnitude, index * 50);
    }
    return calibrator;
  };

  const g = calibrate(1);
  assert.equal(g.snapshot().sourceUnit, ACCELERATION_SOURCE_UNIT.STANDARD_GRAVITY);
  assert.ok(Math.abs(g.convertVector([0, 0, 1])[2] - 9.80665) < 1e-6);

  const mps2 = calibrate(9.80665);
  assert.equal(
    mps2.snapshot().sourceUnit,
    ACCELERATION_SOURCE_UNIT.METERS_PER_SECOND_SQUARED,
  );
  assert.equal(mps2.convertVector([0, 0, 9.80665])[2], 9.80665);

  const unknown = calibrate(4);
  assert.equal(unknown.snapshot().sourceUnit, ACCELERATION_SOURCE_UNIT.UNKNOWN);
  assert.deepEqual(unknown.convertVector([1, 2, 4]), [1, 2, 4]);
});

test('未知加速度单位整窗校准节流到 5Hz，真实重力单位仍在原时间门内锁定', () => {
  const unknown = new AccelerationUnitCalibrator();
  const tryUnknown = unknown._tryCalibrate.bind(unknown);
  let unknownAnalysisCalls = 0;
  unknown._tryCalibrate = () => {
    unknownAnalysisCalls += 1;
    return tryUnknown();
  };
  for (let at = 0; at <= 10000; at += 20) {
    unknown.push(0, 0, 4, at);
  }
  assert.equal(unknown.sourceUnit, ACCELERATION_SOURCE_UNIT.UNKNOWN);
  assert.ok(unknownAnalysisCalls >= 49 && unknownAnalysisCalls <= 51,
    `${unknownAnalysisCalls} calibration analyses / 10s`);

  for (const [magnitude, expectedUnit] of [
    [1, ACCELERATION_SOURCE_UNIT.STANDARD_GRAVITY],
    [9.80665, ACCELERATION_SOURCE_UNIT.METERS_PER_SECOND_SQUARED],
  ]) {
    const calibrator = new AccelerationUnitCalibrator();
    let lockedAtMs = null;
    for (let at = 0; at <= 1200; at += 20) {
      calibrator.push(0, 0, magnitude, at);
      if (lockedAtMs == null
          && calibrator.sourceUnit !== ACCELERATION_SOURCE_UNIT.UNKNOWN) {
        lockedAtMs = at;
      }
    }
    assert.equal(calibrator.sourceUnit, expectedUnit);
    assert.ok(lockedAtMs >= 700 && lockedAtMs <= 900,
      `${expectedUnit} locked at ${String(lockedAtMs)}ms`);
  }
});

test('同一骑行头部振动以 g 或 m/s² 输入得到一致活动判断', () => {
  const inG = new CyclingImuActivity({ startMs: 0, sampleHz: 25 });
  const inMps2 = new CyclingImuActivity({ startMs: 0, sampleHz: 25 });
  let gSnapshot = null;
  let mpsSnapshot = null;

  for (let index = 0; index < 90; index += 1) {
    const moving = index >= 35;
    const direction = index % 2 ? 1 : -1;
    const xG = moving ? direction * 0.12 : 0;
    const wall = 100000 + index * 40;
    gSnapshot = inG.onReading({
      x: xG,
      y: moving ? 0.03 * direction : 0,
      z: 1,
      timestamp: 20 + index * 0.04,
    }, wall);
    mpsSnapshot = inMps2.onReading({
      x: xG * 9.80665,
      y: (moving ? 0.03 * direction : 0) * 9.80665,
      z: 9.80665,
      timestamp: 1000000 + index * 40000,
    }, wall);
  }

  assert.equal(gSnapshot.accelerationUnit, ACCELERATION_SOURCE_UNIT.STANDARD_GRAVITY);
  assert.equal(
    mpsSnapshot.accelerationUnit,
    ACCELERATION_SOURCE_UNIT.METERS_PER_SECOND_SQUARED,
  );
  assert.equal(gSnapshot.motionState, 'moving');
  assert.equal(mpsSnapshot.motionState, 'moving');
  assert.ok(Math.abs(gSnapshot.motionScore - mpsSnapshot.motionScore) < 0.03);
});
