import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CYCLING_MOTION_ARTIFACT,
  CYCLING_MOTION_QUALITY_STATE,
  CyclingMotionQualityGate,
} from '../lib/cycling_motion_quality.js';

const G = 9.80665;

function yawQuaternion(radians) {
  return [0, 0, Math.sin(radians / 2), Math.cos(radians / 2)];
}

function feedPedalling(gate, {
  fromMs = 0,
  toMs = 1800,
  sampleHz = 25,
  rpm = 90,
  gyro = false,
  orientation = false,
  sensorOffsetMs = 0,
} = {}) {
  const intervalMs = 1000 / sampleHz;
  for (let at = fromMs; at <= toMs + 1e-6; at += intervalMs) {
    const phase = 2 * Math.PI * rpm * at / 60000;
    if (gyro) {
      gate.pushGyro(
        0.07 * Math.sin(phase),
        0.04 * Math.cos(phase),
        0.02,
        at + sensorOffsetMs,
      );
    }
    if (orientation) {
      gate.pushOrientation(
        yawQuaternion(0.015 * Math.sin(phase)),
        at + sensorOffsetMs * 0.5,
      );
    }
    gate.pushAcceleration(
      0.65 * Math.sin(phase),
      0.32 * Math.cos(phase + 0.2),
      G + 0.16 * Math.sin(phase + 0.7),
      at,
    );
  }
}

test('Accelerometer-only 在 8Hz 稳定后降级放行，不把缺少可选能力变成永久阻断', () => {
  const gate = new CyclingMotionQualityGate();
  feedPedalling(gate, { sampleHz: 8, toMs: 2200 });
  const quality = gate.snapshot(2200);

  assert.equal(quality.state, CYCLING_MOTION_QUALITY_STATE.ACCEL_ONLY);
  assert.equal(quality.reason, 'optional_motion_sensors_unavailable');
  assert.equal(quality.allowCadenceEvidence, true);
  assert.equal(quality.headMotion, false);
  assert.equal(quality.headMotionKnown, false);
  assert.ok(quality.quality >= 0.55 && quality.quality <= 0.68);
  assert.ok(Math.abs(quality.accelSampleRateHz - 8) < 0.01);
});

test('8–60Hz 都按时间覆盖而非固定样本数通过，异步可选时间轴无需同帧', () => {
  for (const sampleHz of [8, 12, 25, 60]) {
    const gate = new CyclingMotionQualityGate();
    feedPedalling(gate, {
      sampleHz,
      toMs: 2200,
      gyro: true,
      orientation: true,
      sensorOffsetMs: 35,
    });
    const quality = gate.snapshot(2200 + 35);
    assert.equal(
      quality.state,
      CYCLING_MOTION_QUALITY_STATE.TRUSTED,
      `${sampleHz}Hz 应形成可信质量门`,
    );
    assert.equal(quality.allowCadenceEvidence, true);
    assert.equal(quality.gyroFresh, true);
    assert.equal(quality.orientationFresh, true);
    assert.ok(quality.quality >= 0.8);
  }
});

test('持续转头由 gyro/orientation 的净转角识别，周期头部小摆动不会被简单 RMS 误杀', () => {
  const gate = new CyclingMotionQualityGate();
  feedPedalling(gate, {
    toMs: 1600,
    gyro: true,
    orientation: true,
  });
  assert.equal(gate.snapshot(1600).allowCadenceEvidence, true);

  for (let at = 1640; at <= 2040; at += 40) {
    const progress = (at - 1640) / 400;
    gate.pushGyro(0, 0, 1.45, at + 18);
    gate.pushOrientation(yawQuaternion(progress * 0.58), at + 9);
    const phase = 2 * Math.PI * 90 * at / 60000;
    gate.pushAcceleration(
      0.6 * Math.sin(phase),
      0.3 * Math.cos(phase),
      G,
      at,
    );
  }
  const turning = gate.snapshot(2058);
  assert.equal(turning.state, CYCLING_MOTION_QUALITY_STATE.HEAD_MOTION);
  assert.equal(turning.artifact, CYCLING_MOTION_ARTIFACT.HEAD_TURN);
  assert.equal(turning.headMotion, true);
  assert.equal(turning.allowCadenceEvidence, false);

  feedPedalling(gate, {
    fromMs: 2640,
    toMs: 4200,
    gyro: true,
    orientation: true,
  });
  const recovered = gate.snapshot(4200);
  assert.equal(recovered.state, CYCLING_MOTION_QUALITY_STATE.TRUSTED);
  assert.equal(recovered.headMotion, false);
  assert.equal(recovered.allowCadenceEvidence, true);
});

test('扶眼镜/触碰的角速度与加速度联合尖峰触发 touch veto，随后自动恢复', () => {
  const gate = new CyclingMotionQualityGate();
  feedPedalling(gate, {
    toMs: 1800,
    gyro: true,
    orientation: true,
  });

  gate.pushGyro(3.4, 0.4, 0.2, 1840);
  gate.pushAcceleration(4.8, 0.2, G, 1855);
  const touched = gate.snapshot(1855);
  assert.equal(touched.state, CYCLING_MOTION_QUALITY_STATE.TOUCH);
  assert.equal(touched.artifact, CYCLING_MOTION_ARTIFACT.TOUCH);
  assert.equal(touched.headMotion, true);
  assert.equal(touched.quality, 0);
  assert.equal(touched.allowCadenceEvidence, false);

  feedPedalling(gate, {
    fromMs: 2640,
    toMs: 4200,
    gyro: true,
    orientation: true,
  });
  const recovered = gate.snapshot(4200);
  assert.equal(recovered.artifact, CYCLING_MOTION_ARTIFACT.NONE);
  assert.equal(recovered.allowCadenceEvidence, true);
});

test('单次道路冲击只短时阻断，不误报 headMotion，也不污染后续稳定踩踏', () => {
  const gate = new CyclingMotionQualityGate();
  feedPedalling(gate, { toMs: 1800 });

  gate.pushAcceleration(4.5, 0, G, 1840);
  const impact = gate.snapshot(1840);
  assert.equal(impact.state, CYCLING_MOTION_QUALITY_STATE.ROAD_IMPACT);
  assert.equal(impact.artifact, CYCLING_MOTION_ARTIFACT.ROAD_IMPACT);
  assert.equal(impact.headMotion, false);
  assert.equal(impact.allowCadenceEvidence, false);

  feedPedalling(gate, { fromMs: 2360, toMs: 3900 });
  const recovered = gate.snapshot(3900);
  assert.equal(recovered.state, CYCLING_MOTION_QUALITY_STATE.ACCEL_ONLY);
  assert.equal(recovered.artifact, CYCLING_MOTION_ARTIFACT.NONE);
  assert.equal(recovered.allowCadenceEvidence, true);
});

test('过期、无效与各自乱序的 gyro/orientation 安全降级，不能毒化 Accelerometer', () => {
  const gate = new CyclingMotionQualityGate();
  assert.equal(gate.pushGyro(0.1, 0, 0, 10).accepted, true);
  assert.equal(gate.pushOrientation([0, 0, 0, 1], 15).accepted, true);
  assert.equal(gate.pushGyro(Number.NaN, 0, 0, 20).accepted, false);
  assert.equal(gate.pushGyro(0.1, 0, 0, 10).accepted, false);
  assert.equal(gate.pushOrientation([0, 0, 0, 0], 25).accepted, false);
  assert.equal(gate.pushOrientation([0, 0, 0, 1], 14).accepted, false);

  feedPedalling(gate, { fromMs: 40, toMs: 2200, sampleHz: 12 });
  const quality = gate.snapshot(2200);
  assert.equal(quality.gyroFresh, false);
  assert.equal(quality.orientationFresh, false);
  assert.equal(quality.state, CYCLING_MOTION_QUALITY_STATE.ACCEL_ONLY);
  assert.equal(quality.allowCadenceEvidence, true);

  const stale = gate.snapshot(3000);
  assert.equal(stale.state, CYCLING_MOTION_QUALITY_STATE.STALE);
  assert.equal(stale.allowCadenceEvidence, false);
});

test('单帧辅助样本不能把 accel_only 冒充 trusted，drop 后旧 hold 立即失效', () => {
  const gate = new CyclingMotionQualityGate();
  feedPedalling(gate, { toMs: 2200 });
  gate.pushGyro(0.02, 0.01, 0, 2210);
  gate.pushOrientation([0, 0, 0, 1], 2215);
  const oneFrame = gate.snapshot(2215);
  assert.equal(oneFrame.gyroFresh, true);
  assert.equal(oneFrame.orientationFresh, true);
  assert.equal(oneFrame.gyroReady, false);
  assert.equal(oneFrame.orientationReady, false);
  assert.equal(oneFrame.state, CYCLING_MOTION_QUALITY_STATE.ACCEL_ONLY);

  for (let at = 2250; at <= 2600; at += 50) {
    gate.pushGyro(0.02, 0.01, 0, at);
    gate.pushOrientation([0, 0, 0, 1], at + 5);
    gate.pushAcceleration(0.4, 0.2, G, at + 10);
  }
  assert.equal(gate.snapshot(2610).state, CYCLING_MOTION_QUALITY_STATE.TRUSTED);

  gate.pushGyro(3.2, 0, 0, 2640);
  gate.pushAcceleration(4.8, 0, G, 2650);
  assert.equal(gate.snapshot(2650).artifact, CYCLING_MOTION_ARTIFACT.TOUCH);
  gate.dropGyro(2650);
  gate.dropOrientation(2650);
  const dropped = gate.snapshot(2650);
  assert.equal(dropped.gyroFresh, false);
  assert.equal(dropped.orientationFresh, false);
  assert.equal(dropped.headMotion, false);
  assert.equal(dropped.artifact, CYCLING_MOTION_ARTIFACT.NONE);
  assert.equal(dropped.state, CYCLING_MOTION_QUALITY_STATE.ACCEL_ONLY);
});

test('四元数符号翻转表示同一姿态，不应制造虚假转头', () => {
  const gate = new CyclingMotionQualityGate();
  for (let at = 0, index = 0; at <= 1800; at += 40, index += 1) {
    const sign = index % 2 ? -1 : 1;
    gate.pushOrientation([0, 0, 0, sign], at + 5);
    gate.pushGyro(0.02, 0.01, 0, at + 10);
    gate.pushAcceleration(
      0.5 * Math.sin(at / 120),
      0.2 * Math.cos(at / 120),
      G,
      at,
    );
  }
  const quality = gate.snapshot(1810);
  assert.equal(quality.headMotion, false);
  assert.equal(quality.state, CYCLING_MOTION_QUALITY_STATE.TRUSTED);
  assert.equal(quality.allowCadenceEvidence, true);
});

test('pause/resume 清空短时 veto，且质量门不产生速度/里程/功率字段', () => {
  const gate = new CyclingMotionQualityGate();
  feedPedalling(gate, { toMs: 1800 });
  gate.pushAcceleration(5, 0, G, 1840);
  assert.equal(gate.snapshot(1840).allowCadenceEvidence, false);

  gate.pause();
  const paused = gate.snapshot(1900);
  assert.equal(paused.state, CYCLING_MOTION_QUALITY_STATE.PAUSED);
  assert.equal(paused.paused, true);

  gate.resume();
  feedPedalling(gate, { fromMs: 2000, toMs: 3800 });
  const resumed = gate.snapshot(3800);
  assert.equal(resumed.allowCadenceEvidence, true);
  for (const forbidden of [
    'cadenceRpm',
    'speedKmh',
    'distanceM',
    'powerW',
  ]) {
    assert.equal(Object.hasOwn(resumed, forbidden), false);
  }
});

test('三路原始回调逐帧保留，但角运动整窗统一节流到 5–10Hz', () => {
  const gate = new CyclingMotionQualityGate();
  const refresh = gate._refreshHeadMotion.bind(gate);
  let refreshCalls = 0;
  gate._refreshHeadMotion = (nowMs) => {
    refreshCalls += 1;
    return refresh(nowMs);
  };

  let accepted = 0;
  for (let at = 0; at <= 1000; at += 20) {
    accepted += Number(gate.pushGyro(0.02, 0.01, 0, at + 4).accepted);
    accepted += Number(gate.pushOrientation([0, 0, 0, 1], at + 8).accepted);
    accepted += Number(gate.pushAcceleration(0.2, 0, G, at).accepted);
  }

  assert.equal(accepted, 153);
  assert.ok(refreshCalls >= 5 && refreshCalls <= 10, `${refreshCalls}Hz`);
});

test('相差 500ms 的双路 50Hz 时钟不会回退整窗节流', () => {
  const gate = new CyclingMotionQualityGate({
    analysisIntervalMs: 125,
    windowMs: 400,
  });
  const refresh = gate._refreshHeadMotion.bind(gate);
  let refreshCalls = 0;
  gate._refreshHeadMotion = (nowMs) => {
    refreshCalls += 1;
    return refresh(nowMs);
  };

  const accelTimingAnalyses = [];
  let previousAccelTimingMs = gate.lastAccelTimingAnalysisMs;
  const recordAccelTimingAnalysis = () => {
    if (gate.lastAccelTimingAnalysisMs !== previousAccelTimingMs) {
      accelTimingAnalyses.push(gate.lastAccelTimingAnalysisMs);
      previousAccelTimingMs = gate.lastAccelTimingAnalysisMs;
    }
  };

  // Gyro deliberately leads by 500 ms and arrives before its matching accel.
  // The lagging callback must not rewind the shared analysis high-water mark.
  for (let at = 0; at <= 1000; at += 20) {
    gate.pushGyro(0.02, 0.01, 0, at + 500);
    recordAccelTimingAnalysis();
    gate.pushAcceleration(0.2, 0, G, at);
    recordAccelTimingAnalysis();
  }

  assert.ok(refreshCalls >= 5 && refreshCalls <= 10, `${refreshCalls}Hz`);
  assert.ok(
    accelTimingAnalyses.length >= 5 && accelTimingAnalyses.length <= 10,
    `${accelTimingAnalyses.length} accel timing analyses`,
  );
  assert.ok(accelTimingAnalyses.every((at, index) => (
    index === 0 || at - accelTimingAnalyses[index - 1] >= 125
  )), `accelerometer timing analysis rewound: ${accelTimingAnalyses.join(', ')}`);
  assert.ok(accelTimingAnalyses.every((at) => at >= 0 && at <= 1000),
    `accelerometer timing used another sensor clock: ${accelTimingAnalyses.join(', ')}`);
  assert.equal(gate.accelSamples[0].timestampMs, 600);
  assert.equal(gate.accelSamples.length, 21);
  assert.equal(gate.gyroSamples[0].timestampMs, 600);
  assert.equal(gate.gyroSamples.at(-1).timestampMs, 1500);
});
