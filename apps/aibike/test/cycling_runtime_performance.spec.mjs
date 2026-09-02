import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CyclingImuActivity } from '../lib/cycling_imu.js';
import { CyclingMetrics } from '../lib/cycling_metrics.js';
import { CyclingMotionQualityGate } from '../lib/cycling_motion_quality.js';

const G = 9.80665;
const ACCEL_HZ = 50;
const GYRO_HZ = 50;
const ORIENTATION_HZ = 30;
const STILL_MS = 30000;
const PEDALLING_MS = 8000;
const TARGET_RPM = 88;

function yawQuaternion(radians) {
  return [0, 0, Math.sin(radians / 2), Math.cos(radians / 2)];
}

function deterministicNoise(index, channel) {
  const value = Math.sin(
    (index + 1) * (12.9898 + channel * 7.233),
  ) * 43758.5453123;
  return (value - Math.floor(value)) * 2 - 1;
}

function sensorEvents(fromMs, toMs) {
  const events = [];
  for (const [kind, hz, order] of [
    ['orientation', ORIENTATION_HZ, 0],
    ['gyroscope', GYRO_HZ, 1],
    ['acceleration', ACCEL_HZ, 2],
  ]) {
    const intervalMs = 1000 / hz;
    const sampleCount = Math.floor((toMs - fromMs) / intervalMs + 1e-9);
    for (let index = 0; index <= sampleCount; index += 1) {
      events.push({
        kind,
        order,
        index,
        atMs: fromMs + index * intervalMs,
      });
    }
  }
  return events.sort((left, right) => (
    left.atMs - right.atMs || left.order - right.order
  ));
}

function instrumentRuntime(imu, qualityGate) {
  const counts = {
    simpleGyroscopeAnalyses: 0,
    fusedCadenceAnalyses: 0,
    motionQualityWindowRefreshes: 0,
  };

  const updateSimpleGyro = imu._updateSimpleGyroCadence.bind(imu);
  imu._updateSimpleGyroCadence = (...args) => {
    const previousAnalysisAtMs = imu.simpleGyroLastAnalysisMs;
    const output = updateSimpleGyro(...args);
    if (imu.simpleGyroLastAnalysisMs !== previousAnalysisAtMs) {
      counts.simpleGyroscopeAnalyses += 1;
    }
    return output;
  };

  const estimateCadence = imu._estimateCadence.bind(imu);
  imu._estimateCadence = (...args) => {
    counts.fusedCadenceAnalyses += 1;
    return estimateCadence(...args);
  };

  const refreshHeadMotion = qualityGate._refreshHeadMotion.bind(qualityGate);
  qualityGate._refreshHeadMotion = (...args) => {
    counts.motionQualityWindowRefreshes += 1;
    return refreshHeadMotion(...args);
  };

  return counts;
}

function createRuntime() {
  const qualityGate = new CyclingMotionQualityGate({
    minSampleRateHz: 5,
  });
  const imu = new CyclingImuActivity({
    startMs: 0,
    sampleHz: ACCEL_HZ,
    gyroscopeSampleHz: GYRO_HZ,
    minEffectiveSampleHz: 5,
    motionQualityGate: qualityGate,
    accelerationCalibration: {
      windowMs: 1200,
      minWindowMs: 700,
      minSamples: 6,
    },
  });
  const metrics = new CyclingMetrics({ startMs: 0 });
  const counts = instrumentRuntime(imu, qualityGate);
  return { qualityGate, imu, metrics, counts };
}

function replay(runtime, {
  fromMs,
  toMs,
  pedalling = false,
  rpm = TARGET_RPM,
  onActivity = null,
}) {
  for (const event of sensorEvents(fromMs, toMs)) {
    const relativeAtMs = event.atMs - fromMs;
    const phase = 2 * Math.PI * rpm * relativeAtMs / 60000;
    let activity = null;

    if (event.kind === 'orientation') {
      const yaw = pedalling
        ? 0.012 * Math.sin(phase)
        : 0.00008 * deterministicNoise(event.index, 0);
      runtime.qualityGate.pushOrientation(
        yawQuaternion(yaw),
        event.atMs,
      );
      continue;
    }

    if (event.kind === 'gyroscope') {
      const x = pedalling
        ? 0.08 * Math.sin(phase)
          + 0.0003 * deterministicNoise(event.index, 1)
        : 0.00035 * deterministicNoise(event.index, 1);
      const y = pedalling
        ? 0.04 * Math.cos(phase + 0.2)
          + 0.00025 * deterministicNoise(event.index, 2)
        : 0.00035 * deterministicNoise(event.index, 2);
      const z = pedalling
        ? 0.02 * Math.sin(phase + 0.6)
          + 0.0002 * deterministicNoise(event.index, 3)
        : 0.00035 * deterministicNoise(event.index, 3);
      activity = runtime.imu.onGyroscopeReading({
        x,
        y,
        z,
        timestamp: event.atMs,
      }, event.atMs);
    } else {
      const x = pedalling
        ? 0.72 * Math.sin(phase)
          + 0.004 * deterministicNoise(event.index, 4)
        : 0.004 * deterministicNoise(event.index, 4);
      const y = pedalling
        ? 0.34 * Math.cos(phase + 0.2)
          + 0.004 * deterministicNoise(event.index, 5)
        : 0.004 * deterministicNoise(event.index, 5);
      const z = pedalling
        ? G + 0.16 * Math.sin(phase + 0.7)
          + 0.004 * deterministicNoise(event.index, 6)
        : G + 0.004 * deterministicNoise(event.index, 6);
      activity = runtime.imu.onReading({
        x,
        y,
        z,
        timestamp: event.atMs,
      }, event.atMs);
    }

    if (!activity) continue;
    runtime.metrics.onImuActivity(activity, event.atMs);
    if (typeof onActivity === 'function') {
      onActivity(activity, runtime.metrics.snapshot(event.atMs), event.atMs);
    }
  }
}

function assertRateBudget(actual, durationMs, maxHz, label) {
  const maximum = Math.floor(durationMs / 1000 * maxHz) + 1;
  assert.ok(
    actual <= maximum,
    `${label}: ${actual} 次 / ${(durationMs / 1000).toFixed(1)}s，预算 <= ${maximum}`,
  );
}

test('50/50/30Hz 静止 30 秒不造三项，周期恢复约 3–5 秒出数并持续计距', () => {
  const runtime = createRuntime();
  let falseStillMetricAtMs = null;
  replay(runtime, {
    fromMs: 0,
    toMs: STILL_MS,
    onActivity(activity, metrics, atMs) {
      if (falseStillMetricAtMs == null && (
        activity.effectiveCadenceRpm > 0
        || activity.estimatedSpeedKmh > 0
        || metrics.cadenceRpm > 0
        || metrics.speedKmh > 0
        || metrics.distanceM > 0
      )) {
        falseStillMetricAtMs = atMs;
      }
    },
  });

  const stillActivity = runtime.imu.snapshot(STILL_MS, STILL_MS);
  const stillMetrics = runtime.metrics.snapshot(STILL_MS);
  assert.equal(
    falseStillMetricAtMs,
    null,
    `静止回放中途不应短暂产生三项，首次异常 ${String(falseStillMetricAtMs)}ms`,
  );
  assert.equal(stillActivity.motionState, 'stationary');
  assert.ok(!(stillActivity.effectiveCadenceRpm > 0));
  assert.ok(!(stillActivity.estimatedSpeedKmh > 0));
  assert.ok(!(stillMetrics.cadenceRpm > 0));
  assert.ok(!(stillMetrics.speedKmh > 0));
  assert.equal(stillMetrics.distanceM, 0);

  let firstCandidateAtMs = null;
  let firstThreeMetricsAtMs = null;
  let firstThreeMetricsDistanceM = null;
  const tailSnapshots = [];
  replay(runtime, {
    fromMs: STILL_MS + 20,
    toMs: STILL_MS + 20 + PEDALLING_MS,
    pedalling: true,
    onActivity(activity, metrics, atMs) {
      if (firstCandidateAtMs == null
          && activity.cadenceEstimateLevel === 'candidate'
          && activity.effectiveCadenceRpm > 0) {
        firstCandidateAtMs = atMs;
      }
      if (firstThreeMetricsAtMs == null
          && metrics.cadenceRpm > 0
          && metrics.speedKmh > 0
          && metrics.distanceM > 0) {
        firstThreeMetricsAtMs = atMs;
        firstThreeMetricsDistanceM = metrics.distanceM;
      }
      if (atMs >= STILL_MS + 20 + PEDALLING_MS - 2000
          && eventNearWholeSecond(atMs)) {
        tailSnapshots.push(metrics);
      }
    },
  });

  const candidateDelayMs = firstCandidateAtMs == null
    ? null : firstCandidateAtMs - (STILL_MS + 20);
  assert.ok(
    candidateDelayMs != null
      && candidateDelayMs >= 2200
      && candidateDelayMs <= 5200,
    `candidate 应约 3–5 秒出现，实际 ${String(candidateDelayMs)}ms`,
  );
  assert.ok(
    firstThreeMetricsAtMs != null
      && firstThreeMetricsAtMs - (STILL_MS + 20) <= 5500,
    `踏频/速度/距离应在约 5 秒内共同可用，实际 ${String(firstThreeMetricsAtMs)}`,
  );

  const final = runtime.metrics.snapshot(STILL_MS + 20 + PEDALLING_MS);
  assert.ok(Math.abs(final.cadenceRpm - TARGET_RPM) < 5);
  assert.ok(final.speedKmh > 0 && final.speedKmh <= 20);
  assert.ok(final.distanceM > firstThreeMetricsDistanceM + 5);
  assert.ok(tailSnapshots.length >= 2);
  for (const snapshot of tailSnapshots) {
    assert.ok(snapshot.cadenceRpm > 0);
    assert.ok(snapshot.speedKmh > 0);
  }
});

test('50/50/30Hz 运行时昂贵分析遵守按模拟时间计算的调用预算', () => {
  const runtime = createRuntime();
  const durationMs = STILL_MS + PEDALLING_MS;
  replay(runtime, {
    fromMs: 0,
    toMs: STILL_MS,
  });
  replay(runtime, {
    fromMs: STILL_MS + 20,
    toMs: STILL_MS + 20 + PEDALLING_MS,
    pedalling: true,
  });

  assert.ok(runtime.counts.simpleGyroscopeAnalyses > 0);
  assert.ok(runtime.counts.fusedCadenceAnalyses > 0);
  assert.ok(runtime.counts.motionQualityWindowRefreshes > 0);
  assertRateBudget(
    runtime.counts.simpleGyroscopeAnalyses,
    durationMs,
    1.2,
    'simple gyroscope analysis',
  );
  assertRateBudget(
    runtime.counts.fusedCadenceAnalyses,
    durationMs,
    1,
    'accelerometer/gyroscope fused analysis',
  );
  assertRateBudget(
    runtime.counts.motionQualityWindowRefreshes,
    durationMs,
    10,
    'motion-quality window refresh',
  );
});

test('候选清理只随 1Hz 融合分析运行，不随 50Hz 原始帧运行', () => {
  const imu = new CyclingImuActivity({ startMs: 0 });
  imu._cadenceInputsReadyForAnalysis = () => true;
  imu._hasCadenceAnalysisEnergy = () => true;
  imu._estimateCadence = () => null;
  const pruneCandidates = imu._pruneCadenceCandidates.bind(imu);
  let pruneCalls = 0;
  imu._pruneCadenceCandidates = (...args) => {
    pruneCalls += 1;
    return pruneCandidates(...args);
  };

  for (let at = 0; at <= 10000; at += 20) {
    imu._updateCadenceEstimate(at, 'accelerometer');
  }

  assert.ok(pruneCalls >= 10 && pruneCalls <= 11,
    `${pruneCalls} candidate prunes / 10s`);
});

test('三条 dense 窗用低频批量裁剪，持续 artifact 仍有界且不逐帧 shift', () => {
  const imu = new CyclingImuActivity({
    startMs: 0,
    sampleHz: 50,
    gyroscopeSampleHz: 50,
    stationaryConfirmMs: 100000,
  });
  let shiftCalls = 0;
  for (const samples of [
    imu.cadenceSamples,
    imu.gyroscopeCadenceSamples,
    imu.simpleGyroscopeSamples,
  ]) {
    const shift = samples.shift;
    samples.shift = function instrumentedShift(...args) {
      shiftCalls += 1;
      return shift.apply(this, args);
    };
  }

  const trimTimedSamples = imu._trimTimedSamples.bind(imu);
  let compactionCalls = 0;
  imu._trimTimedSamples = (...args) => {
    compactionCalls += 1;
    return trimTimedSamples(...args);
  };

  const roadImpact = {
    state: 'road_impact',
    artifact: 'road_impact',
    roadImpactTriggered: false,
  };
  const clean = { state: 'trusted', artifact: 'none' };
  for (let at = 0; at <= 30000; at += 20) {
    imu.onSample({ x: 0, y: 0, z: G }, at, roadImpact, at);
    imu.onGyroscopeSample({
      x: 0,
      y: 0,
      z: 0,
      timestampMs: at,
    }, at, clean, at);
  }

  const complexBound = Math.ceil((imu.cadenceWindowMs + 1000) / 20) + 2;
  const simpleBound = Math.ceil((imu.simpleGyroWindowMs + 1000) / 20) + 2;
  assert.ok(imu.cadenceSamples.length <= complexBound,
    `${imu.cadenceSamples.length} accel cadence samples`);
  assert.ok(imu.gyroscopeCadenceSamples.length <= complexBound,
    `${imu.gyroscopeCadenceSamples.length} gyro cadence samples`);
  assert.ok(imu.simpleGyroscopeSamples.length <= simpleBound,
    `${imu.simpleGyroscopeSamples.length} simple gyro samples`);
  assert.ok(
    imu.cadenceSamples[0].timestampMs
      >= 30000 - imu.cadenceWindowMs - 1020,
  );
  assert.ok(
    imu.gyroscopeCadenceSamples[0].timestampMs
      >= 30000 - imu.cadenceWindowMs - 1020,
  );
  // The 1Hz simple-gyro analysis forces its heavy window to the exact cutoff.
  assert.ok(
    imu.simpleGyroscopeSamples[0].timestampMs
      >= imu.simpleGyroLastAnalysisMs - imu.simpleGyroWindowMs,
  );
  assert.equal(shiftCalls, 0);
  assert.ok(compactionCalls > 0 && compactionCalls <= 90,
    `${compactionCalls} batch compactions / 30s`);
});

function eventNearWholeSecond(atMs) {
  return Math.abs(atMs / 1000 - Math.round(atMs / 1000)) < 1e-9;
}
