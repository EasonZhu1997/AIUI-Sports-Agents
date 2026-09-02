import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CyclingMetrics,
  CYCLING_METRIC_STATES,
} from '../lib/cycling_metrics.js';
import { CyclingImuActivity } from '../lib/cycling_imu.js';

function csc({ wheel = null, crank = null } = {}) {
  return { flags: (wheel ? 1 : 0) | (crank ? 2 : 0), wheel, crank };
}

function cps({ powerW = 0, wheel = null, crank = null } = {}) {
  return { flags: (wheel ? 0x10 : 0) | (crank ? 0x20 : 0), powerW, wheel, crank };
}

function ftms(fields = {}) {
  return {
    flags: 0,
    hasMoreData: false,
    speedKmh: null,
    cadenceRpm: null,
    totalDistanceM: null,
    powerW: null,
    heartRateBpm: null,
    ...fields,
  };
}

test('没有确认轮周时，CSC wheel 不生成速度或距离', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.onCsc(csc({
    wheel: { revolutions: 100, lastEventTime1024: 0 },
  }), 0);
  metrics.onCsc(csc({
    wheel: { revolutions: 101, lastEventTime1024: 1024 },
  }), 1000);
  const snap = metrics.snapshot(2000);
  assert.equal(snap.speedKmh, null);
  assert.equal(snap.distanceM, 0);
  assert.equal(snap.distanceState, CYCLING_METRIC_STATES.SUBSCRIBED);
});

test('CSC 轮周、曲柄给出速度/距离/踏频和时间加权平均', () => {
  const metrics = new CyclingMetrics({ startMs: 0, wheelCircumferenceMm: 2000 });
  metrics.onCsc(csc({
    wheel: { revolutions: 100, lastEventTime1024: 0 },
    crank: { revolutions: 10, lastEventTime1024: 0 },
  }), 0);
  metrics.onCsc(csc({
    wheel: { revolutions: 101, lastEventTime1024: 1024 },
    crank: { revolutions: 11, lastEventTime1024: 768 },
  }), 1000);

  const snap = metrics.snapshot(2000);
  assert.ok(Math.abs(snap.speedKmh - 7.2) < 1e-9);
  assert.ok(Math.abs(snap.cadenceRpm - 80) < 1e-9);
  assert.ok(Math.abs(snap.distanceM - 2) < 1e-9);
  assert.equal(snap.movingMs, 1000);
  assert.ok(Math.abs(snap.avgSpeedKmh - 7.2) < 1e-9);
  assert.ok(Math.abs(snap.avgCadenceRpm - 80) < 1e-9);
});

test('踏频来源 CPS > CSC > FTMS，断开高优先级后回退', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.onFtms(ftms({ cadenceRpm: 90 }), 0);
  metrics.onCsc(csc({
    crank: { revolutions: 10, lastEventTime1024: 0 },
  }), 100);
  metrics.onCsc(csc({
    crank: { revolutions: 11, lastEventTime1024: 768 },
  }), 1100);
  metrics.onCyclingPower(cps({
    powerW: 200,
    crank: { revolutions: 20, lastEventTime1024: 0 },
  }), 1200);
  metrics.onCyclingPower(cps({
    powerW: 200,
    crank: { revolutions: 21, lastEventTime1024: 683 },
  }), 2200);
  assert.equal(metrics.snapshot(2200).metrics.cadence.source, 'cps');

  metrics.markSourceDisconnected('cps', 2300);
  const fallback = metrics.snapshot(2300);
  assert.equal(fallback.metrics.cadence.source, 'csc');
  assert.ok(Math.abs(fallback.cadenceRpm - 80) < 1e-9);
});

test('CSC 重复事件先推断 explicit zero，通知也断流后变 stale', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.onCsc(csc({
    crank: { revolutions: 10, lastEventTime1024: 0 },
  }), 0);
  metrics.onCsc(csc({
    crank: { revolutions: 11, lastEventTime1024: 768 },
  }), 1000);
  metrics.onCsc(csc({
    crank: { revolutions: 11, lastEventTime1024: 768 },
  }), 3500);

  const coast = metrics.snapshot(4100);
  assert.equal(coast.cadenceRpm, 0);
  assert.equal(coast.metrics.cadence.state, CYCLING_METRIC_STATES.EXPLICIT_ZERO);
  const stale = metrics.snapshot(12000);
  assert.equal(stale.cadenceRpm, null);
  assert.equal(stale.metrics.cadence.state, CYCLING_METRIC_STATES.STALE);
});

test('FTMS 明确零值与 stale 分开，订阅但无包也不算 live', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.markSourceSubscribed('csc', 0);
  assert.equal(metrics.snapshot(1000).sources.csc.state, CYCLING_METRIC_STATES.SUBSCRIBED);
  assert.equal(metrics.snapshot(9000).sources.csc.state, CYCLING_METRIC_STATES.STALE);

  metrics.onFtms(ftms({ speedKmh: 0, cadenceRpm: 0, powerW: 0 }), 10000);
  const stopped = metrics.snapshot(10000);
  assert.equal(stopped.metrics.speed.state, CYCLING_METRIC_STATES.EXPLICIT_ZERO);
  assert.equal(stopped.metrics.cadence.state, CYCLING_METRIC_STATES.EXPLICIT_ZERO);
  assert.equal(stopped.metrics.power.state, CYCLING_METRIC_STATES.EXPLICIT_ZERO);
  assert.equal(metrics.snapshot(13501).metrics.speed.state, CYCLING_METRIC_STATES.STALE);
});

test('距离来源切换先重锚，不把各来源累计值相加两次', () => {
  const metrics = new CyclingMetrics({ startMs: 0, wheelCircumferenceMm: 2000 });
  metrics.onCsc(csc({
    wheel: { revolutions: 100, lastEventTime1024: 0 },
  }), 0);
  metrics.onCsc(csc({
    wheel: { revolutions: 101, lastEventTime1024: 1024 },
  }), 1000);
  assert.equal(metrics.snapshot(1000).distanceM, 2);

  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 100 }), 1000);
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 110 }), 9001);
  assert.equal(metrics.snapshot(9001).distanceM, 2, '切到 FTMS 首包只重锚');
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 115 }), 10001);
  assert.equal(metrics.snapshot(10001).distanceM, 7);

  metrics.markSourceDisconnected('csc', 10500);
  metrics.markSourceSubscribed('csc', 11000);
  metrics.onCsc(csc({
    wheel: { revolutions: 200, lastEventTime1024: 0 },
  }), 11000);
  assert.equal(metrics.snapshot(11000).distanceM, 7, 'CSC 重连首包仍只重锚');
  metrics.onCsc(csc({
    wheel: { revolutions: 201, lastEventTime1024: 1024 },
  }), 12000);
  assert.equal(metrics.snapshot(12000).distanceM, 9);
});

test('FTMS 总距离复位和巨大跳变都重锚，后续正常增量可恢复', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 1000 }), 0);
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 1005 }), 1000);
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 500 }), 2000);
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 505 }), 3000);
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 10000 }), 4000);
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 10005 }), 5000);
  assert.equal(
    metrics.snapshot(5000).distanceM,
    10,
    '两包新低值只确认复位并重锚，不冒险计入可能重放的旧数据',
  );
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 10010 }), 6000);
  assert.equal(metrics.snapshot(6000).distanceM, 15);
});

test('骑行中修改轮周只影响后续新基线，不补算旧计数器差值', () => {
  const metrics = new CyclingMetrics({ startMs: 0, wheelCircumferenceMm: 2000 });
  metrics.onCsc(csc({
    wheel: { revolutions: 10, lastEventTime1024: 0 },
  }), 0);
  metrics.onCsc(csc({
    wheel: { revolutions: 11, lastEventTime1024: 1024 },
  }), 1000);
  assert.equal(metrics.snapshot(1000).distanceM, 2);

  assert.equal(metrics.setWheelCircumferenceMm(2100, 1500), true);
  metrics.onCsc(csc({
    wheel: { revolutions: 20, lastEventTime1024: 2048 },
  }), 2000);
  assert.equal(metrics.snapshot(2000).distanceM, 2, '换轮周后的首包只重锚');
  metrics.onCsc(csc({
    wheel: { revolutions: 21, lastEventTime1024: 3072 },
  }), 3000);
  assert.ok(Math.abs(metrics.snapshot(3000).distanceM - 4.1) < 1e-9);
  assert.equal(metrics.setWheelCircumferenceMm(100, 3100), false);
});

test('暂停/恢复与重连都重新锚定，时长和移动时间不跨暂停补算', () => {
  const metrics = new CyclingMetrics({ startMs: 0, wheelCircumferenceMm: 2000 });
  metrics.onCsc(csc({
    wheel: { revolutions: 10, lastEventTime1024: 0 },
  }), 0);
  metrics.onCsc(csc({
    wheel: { revolutions: 11, lastEventTime1024: 1024 },
  }), 1000);
  metrics.pause(2000);
  metrics.onCsc(csc({
    wheel: { revolutions: 100, lastEventTime1024: 10000 },
  }), 5000);
  metrics.resume(10000);
  metrics.onCsc(csc({
    wheel: { revolutions: 100, lastEventTime1024: 10000 },
  }), 11000);
  metrics.onCsc(csc({
    wheel: { revolutions: 101, lastEventTime1024: 11024 },
  }), 12000);
  const snap = metrics.snapshot(13000);
  assert.equal(snap.distanceM, 4);
  assert.equal(snap.elapsedMs, 5000);
  assert.equal(snap.movingMs, 2000);
});

test('功率零值计入时间加权平均，断流区间不编造功率', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.onCyclingPower(cps({ powerW: 200 }), 0);
  metrics.onCyclingPower(cps({ powerW: 300 }), 1000);
  metrics.onCyclingPower(cps({ powerW: 0 }), 2000);
  const snap = metrics.snapshot(3000);
  assert.equal(snap.powerW, 0);
  assert.equal(snap.metrics.power.state, CYCLING_METRIC_STATES.EXPLICIT_ZERO);
  assert.ok(Math.abs(snap.avgPowerW - (500 / 3)) < 1e-9);
  assert.equal(snap.movingMs, 2000);
  assert.ok(
    Math.abs(metrics.snapshot(7000).avgPowerW - 100) < 1e-9,
    '明确零功率在 freshness 窗口内继续计入，窗口后的断流不再扩展分母',
  );
});

test('专业总结：心率样本平均、心率/速度/踏频/功率峰值只计有效非暂停数据', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.onFtms(ftms({ speedKmh: 25, cadenceRpm: 90, powerW: 250 }), 0);
  metrics.onHeartRate(140, 0);
  metrics.onFtms(ftms({ speedKmh: 30, cadenceRpm: 95, powerW: 300 }), 1000);
  metrics.onHeartRate(160, 1000);

  metrics.pause(2000);
  metrics.onFtms(ftms({
    speedKmh: 100,
    cadenceRpm: 200,
    powerW: 1000,
    heartRateBpm: 220,
  }), 2500);
  metrics.onHeartRate(200, 2600);
  metrics.resume(3000);

  metrics.onFtms(ftms({ speedKmh: 28, cadenceRpm: 92, powerW: 280 }), 4000);
  metrics.onHeartRate(150, 4000);
  const live = metrics.snapshot(4000);
  assert.equal(live.avgBpm, 150);
  assert.equal(live.maxBpm, 160);
  assert.equal(live.maxSpeedKmh, 30);
  assert.equal(live.maxCadenceRpm, 95);
  assert.equal(live.maxPowerW, 300);
  assert.equal(live.heartRateAverageMode, 'selected_valid_samples');

  const stale = metrics.snapshot(20000);
  assert.equal(stale.heartRateBpm, null);
  assert.equal(stale.powerW, null);
  assert.equal(stale.avgBpm, 150, 'UI snapshot 与断流不能重复添加心率样本');
  assert.equal(stale.maxBpm, 160);
  assert.equal(stale.maxSpeedKmh, 30);
  assert.equal(stale.maxCadenceRpm, 95);
  assert.equal(stale.maxPowerW, 300);
});

test('心率平均只计通知到达时被来源仲裁选中的样本', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.onFtms(ftms({ heartRateBpm: 170 }), 0);
  metrics.onHeartRate(160, 100);
  metrics.onFtms(ftms({ heartRateBpm: 200 }), 200);
  const snap = metrics.snapshot(300);
  assert.equal(snap.heartRateBpm, 160, '新鲜 HRS 优先于 FTMS 内嵌心率');
  assert.equal(snap.avgBpm, 165, 'FTMS 170 与 HRS 160 各计一次，低优先级 200 不计');
  assert.equal(snap.maxBpm, 170);
});

test('超过专业合理上限的指标与负功率不进入总结峰值', () => {
  const metrics = new CyclingMetrics({
    startMs: 0,
    maxSpeedKmh: 120,
    maxCadenceRpm: 250,
    maxPowerW: 5000,
  });
  metrics.onFtms(ftms({ speedKmh: 121, cadenceRpm: 251, powerW: 5001 }), 0);
  metrics.onCyclingPower(cps({ powerW: -10 }), 1000);
  const snap = metrics.snapshot(1000);
  assert.equal(snap.maxSpeedKmh, null);
  assert.equal(snap.maxCadenceRpm, null);
  assert.equal(snap.maxPowerW, null);
});

test('高置信 IMU 踏频以保守估算源生成速度和部分里程', () => {
  const metrics = new CyclingMetrics({ startMs: 0, imuMetersPerCrank: 5.5 });
  const activity = {
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: 'estimated',
    cadenceConfidence: 0.88,
    candidateCadenceRpm: 80.5,
    finalCadenceRpm: 80,
    estimatedSpeedKmh: 26.4,
    autoPauseSuggested: false,
    autoResumeSuggested: true,
  };
  metrics.onImuActivity(activity, 1000);
  metrics.onImuActivity(activity, 2000);
  const snap = metrics.snapshot(2000);
  assert.equal(snap.metrics.speed.source, 'imu');
  assert.equal(snap.metrics.cadence.source, 'imu');
  assert.equal(snap.speedKmh, 20);
  assert.equal(snap.cadenceRpm, 80);
  assert.ok(Math.abs(snap.distanceM - (20 / 3.6)) < 1e-9);
  assert.equal(snap.distanceMode, 'cadence_model');
  assert.deepEqual(snap.summarySourcesUsed, ['imu']);
  assert.equal(snap.imuAssist.autoResumeSuggested, true);
});

test('室内步行样周期保留可见踏频但使用步行尺度，静止后立即归零并停止计距', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  const walkingLike = {
    motionState: 'moving',
    confidence: 0.94,
    fresh: true,
    cadenceState: 'estimated',
    cadenceConfidence: 0.94,
    candidateCadenceRpm: 130,
    finalCadenceRpm: 130,
    effectiveCadenceRpm: 130,
    cadenceEstimateLevel: 'locked',
    cadenceUsable: true,
    availabilityCadenceUsable: false,
    estimatedSpeedKmh: 5.616,
    metersPerCrank: 3.2,
    motionArtifact: 'none',
    walkingLike: true,
    walkingLikeConfidence: 0.9,
    speedEstimateProfile: 'walking_like',
  };
  metrics.onImuActivity(walkingLike, 1000);
  metrics.onImuActivity(walkingLike, 2000);
  const moving = metrics.snapshot(2000);
  assert.equal(moving.cadenceRpm, 130);
  assert.ok(Math.abs(moving.speedKmh - 5.616) < 1e-9);
  assert.ok(Math.abs(moving.distanceM - 1.56) < 1e-9);
  assert.equal(moving.imuAssist.walkingLike, true);
  assert.equal(moving.imuAssist.speedEstimateProfile, 'walking_like');

  metrics.onImuActivity({
    ...walkingLike,
    motionState: 'stationary',
    confidence: 1,
    cadenceState: 'stationary',
    candidateCadenceRpm: 0,
    finalCadenceRpm: 0,
    effectiveCadenceRpm: 0,
    cadenceEstimateLevel: 'stationary',
    cadenceUsable: false,
    estimatedSpeedKmh: 0,
    walkingLike: false,
    walkingLikeConfidence: 0,
    speedEstimateProfile: 'cycling_unverified',
  }, 3000);
  const distanceAtStop = metrics.snapshot(3000).distanceM;
  const stopped = metrics.snapshot(4000);
  assert.equal(stopped.speedKmh, 0);
  assert.equal(stopped.cadenceRpm, 0);
  assert.equal(stopped.distanceM, distanceAtStop);
});

test('无 GPS 的 130rpm 倍频不会再把 IMU 速度和距离按 20km/h 积分', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  const highCadence = {
    motionState: 'moving',
    confidence: 0.94,
    fresh: true,
    cadenceState: 'estimated',
    cadenceConfidence: 0.94,
    candidateCadenceRpm: 130,
    finalCadenceRpm: 130,
    effectiveCadenceRpm: 130,
    cadenceEstimateLevel: 'locked',
    cadenceUsable: true,
    estimatedSpeedKmh: 20,
    metersPerCrank: 3.2,
    motionArtifact: 'none',
    walkingLike: false,
  };
  metrics.onImuActivity(highCadence, 1000);
  metrics.onImuActivity(highCadence, 2000);
  const snapshot = metrics.snapshot(2000);
  assert.equal(snapshot.cadenceRpm, 130);
  assert.ok(Math.abs(snapshot.speedKmh - 12.48) < 1e-9);
  assert.ok(Math.abs(snapshot.distanceM - (12.48 / 3.6)) < 1e-9);
});

test('AR 录屏断流期间冻结距离，恢复首帧只重锚不补算空档', () => {
  const metrics = new CyclingMetrics({
    startMs: 0,
    imuMetersPerCrank: 3.2,
    imuDistanceMaxGapMs: 1800,
  });
  const activity = {
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: 'estimated',
    cadenceConfidence: 0.9,
    candidateCadenceRpm: 90,
    finalCadenceRpm: 90,
    cadenceUsable: true,
    estimatedSpeedKmh: 17.28,
    metersPerCrank: 3.2,
    motionArtifact: 'none',
  };
  metrics.onImuActivity(activity, 1000);
  metrics.onImuActivity(activity, 2000);
  const beforeGap = metrics.snapshot(2000);
  const distanceBeforeGap = beforeGap.distanceM;
  const coverageBeforeGap = beforeGap.distanceCoverageMs;
  assert.ok(distanceBeforeGap > 0);

  assert.equal(metrics.snapshot(4500).distanceM, distanceBeforeGap);
  metrics.onImuActivity(activity, 5000);
  let recovered = metrics.snapshot(5000);
  assert.equal(recovered.distanceM, distanceBeforeGap);
  assert.equal(recovered.distanceCoverageMs, coverageBeforeGap);

  metrics.onImuActivity(activity, 5500);
  recovered = metrics.snapshot(5500);
  assert.ok(recovered.distanceM > distanceBeforeGap);
  assert.ok(Math.abs(
    recovered.distanceM - distanceBeforeGap - 17.28 / 3.6 * 0.5,
  ) < 1e-9);
});

test('Gyroscope 快速重建即使短于 1.8 秒也切断 IMU 距离锚', () => {
  const metrics = new CyclingMetrics({
    startMs: 0,
    imuMetersPerCrank: 3.2,
    imuDistanceMaxGapMs: 1800,
  });
  const activity = {
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: 'estimated',
    cadenceConfidence: 0.9,
    candidateCadenceRpm: 90,
    finalCadenceRpm: 90,
    cadenceUsable: true,
    estimatedSpeedKmh: 17.28,
    metersPerCrank: 3.2,
    motionArtifact: 'none',
  };
  metrics.onImuActivity(activity, 1000);
  metrics.onImuActivity(activity, 1500);
  const beforeRestart = metrics.snapshot(1500);
  assert.ok(beforeRestart.distanceM > 0);

  assert.equal(metrics.markImuDiscontinuity(1600), true);
  metrics.onImuActivity(activity, 2800);
  let recovered = metrics.snapshot(2800);
  assert.equal(recovered.distanceM, beforeRestart.distanceM);
  assert.equal(recovered.distanceCoverageMs, beforeRestart.distanceCoverageMs);

  metrics.onImuActivity(activity, 3300);
  recovered = metrics.snapshot(3300);
  assert.ok(recovered.distanceM > beforeRestart.distanceM);
});

test('复现 Hermes 多数 road_impact/head_turn 场次仍在 5 秒内显示三项并可从 touch 恢复', () => {
  const metrics = new CyclingMetrics({ startMs: 0, imuMetersPerCrank: 5.5 });
  const imu = new CyclingImuActivity({
    startMs: 0,
    gyroscopeSampleHz: 20,
    metersPerCrank: 5.5,
  });
  let firstVisibleAtMs = null;
  let recoveredAfterTouchAtMs = null;
  for (let at = 0; at <= 12000; at += 50) {
    const phase = 2 * Math.PI * 88 * at / 60000;
    const touch = at === 5000;
    const clean = at % 1000 === 0;
    const headTurn = !touch && !clean && at % 500 === 0;
    const artifact = touch
      ? 'touch' : (clean ? 'none' : (headTurn ? 'head_turn' : 'road_impact'));
    const snapshot = imu.onGyroscopeSample({
      x: touch ? 1.2 : 0.08 * Math.sin(phase),
      y: touch ? 0.8 : 0.04 * Math.cos(phase),
      z: touch ? 1.5 : 0.02 * Math.sin(phase + 0.4),
      timestampMs: at,
    }, at, {
      state: artifact === 'none'
        ? 'trusted' : (artifact === 'head_turn' ? 'head_motion' : artifact),
      artifact,
      quality: artifact === 'none' ? 0.9 : 0.2,
      allowCadenceEvidence: artifact === 'none',
    }, at);
    metrics.onImuActivity(snapshot, at);
    const live = metrics.snapshot(at);
    if (firstVisibleAtMs == null && live.cadenceRpm > 0
        && live.speedKmh > 0 && live.distanceM > 0) {
      firstVisibleAtMs = at;
    }
    if (at > 5000 && recoveredAfterTouchAtMs == null
        && live.cadenceRpm > 0 && live.speedKmh > 0) {
      recoveredAfterTouchAtMs = at;
    }
  }
  const final = metrics.snapshot(12000);
  assert.ok(firstVisibleAtMs != null && firstVisibleAtMs <= 5000);
  assert.ok(recoveredAfterTouchAtMs != null && recoveredAfterTouchAtMs <= 10000);
  assert.ok(Math.abs(final.cadenceRpm - 88) < 3);
  assert.ok(final.speedKmh > 0);
  assert.ok(final.distanceM > 0);
  assert.equal(final.metrics.cadence.source, 'imu');
  assert.equal(final.distanceSource, 'imu');
});

test('IMU 固定每转距离不依赖定位校准且速度仍封顶 20km/h', () => {
  const metrics = new CyclingMetrics({
    startMs: 0,
    imuMetersPerCrank: 3.2,
  });
  const imu = {
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: 'estimated',
    cadenceConfidence: 0.9,
    effectiveCadenceConfidence: 0.9,
    candidateCadenceRpm: 90,
    finalCadenceRpm: 90,
    effectiveCadenceRpm: 90,
    cadenceUsable: true,
    estimatedSpeedKmh: 17.28,
    metersPerCrank: 3.2,
    motionArtifact: 'none',
  };
  for (let atMs = 0; atMs <= 6000; atMs += 500) {
    metrics.onImuActivity(imu, atMs);
  }
  const snapshot = metrics.snapshot(6000);
  assert.equal(snapshot.rollout.calibrationState, 'fixed');
  assert.equal(snapshot.rollout.locked, false);
  assert.equal(snapshot.rollout.metersPerCrank, 3.2);
  assert.equal(snapshot.rollout.acceptedWindowCount, 0);
  assert.equal(snapshot.metrics.speed.source, 'imu');
  assert.ok(snapshot.speedKmh > 0 && snapshot.speedKmh <= 20);
  assert.equal(snapshot.imuAssist.metersPerCrank, 3.2);
  assert.equal(snapshot.imuAssist.rolloutCalibrationState, 'fixed');
});

test('固定 IMU 模型不设步行硬门，真实 CSC 仍立即优先', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  const imu = {
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: 'estimated',
    cadenceConfidence: 0.9,
    effectiveCadenceConfidence: 0.9,
    candidateCadenceRpm: 100,
    finalCadenceRpm: 100,
    effectiveCadenceRpm: 100,
    cadenceUsable: true,
    estimatedSpeedKmh: 33,
    metersPerCrank: 5.5,
    motionArtifact: 'none',
  };
  metrics.onImuActivity(imu, 1000);
  let snapshot = metrics.snapshot(1000);
  assert.equal(snapshot.rollout.likelyWalk, false);
  assert.equal(snapshot.rollout.rawSuppressImu, false);
  assert.equal(snapshot.rollout.suppressImu, false);
  assert.ok(snapshot.speedKmh > 0);
  assert.ok(snapshot.cadenceRpm > 0);

  metrics.onCsc({
    flags: 2,
    wheel: null,
    crank: { revolutions: 100, lastEventTime1024: 0 },
  }, 2000);
  metrics.onCsc({
    flags: 2,
    wheel: null,
    crank: { revolutions: 101, lastEventTime1024: 614 },
  }, 3000);
  metrics.onImuActivity(imu, 3500);
  snapshot = metrics.snapshot(3500);
  assert.equal(snapshot.rollout.rawLikelyWalk, false);
  assert.equal(snapshot.rollout.physicalCyclingEvidence, true);
  assert.equal(snapshot.rollout.suppressImu, false);
  assert.equal(snapshot.metrics.cadence.source, 'csc');
  assert.ok(snapshot.cadenceRpm > 0);
});

test('IMU 转头只保留分类器 HUD 值并冻结指标、均值与距离', () => {
  const metrics = new CyclingMetrics({ startMs: 0, imuMetersPerCrank: 5.5 });
  const estimated = {
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: 'estimated',
    cadenceConfidence: 0.9,
    candidateCadenceRpm: 90,
    finalCadenceRpm: 90,
    estimatedSpeedKmh: 29.7,
    motionArtifact: 'none',
    motionQualityState: 'trusted',
  };
  metrics.onImuActivity(estimated, 1000);
  metrics.onImuActivity(estimated, 2000);
  const beforeArtifact = metrics.snapshot(2000).distanceM;
  assert.ok(beforeArtifact > 0);

  metrics.onImuActivity({
    ...estimated,
    cadenceState: 'artifact',
    cadenceConfidence: 0,
    candidateCadenceRpm: 90,
    finalCadenceRpm: 90,
    effectiveCadenceRpm: 90,
    effectiveCadenceConfidence: 0.9,
    cadenceUsable: true,
    estimatedSpeedKmh: 29.7,
    motionArtifact: 'head_turn',
    motionQualityState: 'head_motion',
  }, 3000);
  const filtered = metrics.snapshot(3000);
  assert.equal(filtered.speedKmh, null);
  assert.equal(filtered.cadenceRpm, null);
  assert.equal(filtered.distanceM, beforeArtifact);
  assert.equal(filtered.distanceSource, null);
  assert.equal(filtered.imuAssist.motionArtifact, 'head_turn');
  assert.equal(filtered.imuAssist.effectiveCadenceRpm, 90);
  const movingAtFilter = filtered.movingMs;

  metrics.onImuActivity({
    ...estimated,
    cadenceState: 'artifact',
    finalCadenceRpm: 90,
    effectiveCadenceRpm: 90,
    effectiveCadenceConfidence: 0.9,
    cadenceUsable: true,
    motionArtifact: 'head_turn',
    motionQualityState: 'head_motion',
  }, 5000);
  const held = metrics.snapshot(6000);
  assert.equal(held.distanceM, beforeArtifact);
  assert.equal(held.movingMs, movingAtFilter);

  metrics.onImuActivity(estimated, 7000);
  assert.equal(
    metrics.snapshot(7000).distanceM,
    beforeArtifact,
    '恢复首帧只能重锚',
  );
  metrics.onImuActivity(estimated, 8000);
  const recovered = metrics.snapshot(8000);
  assert.ok(Math.abs(recovered.distanceM - beforeArtifact - (20 / 3.6)) < 1e-9);
  assert.equal(recovered.metrics.speed.source, 'imu');
  assert.equal(recovered.imuAssist.motionArtifact, 'none');
});

test('高置信 provisional 立即显示踏频/速度，但距离需三窗且跨度 1.5 秒确认后才开锚', () => {
  const metrics = new CyclingMetrics({ startMs: 0, imuMetersPerCrank: 5.5 });
  metrics.onImuActivity({
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: 'warming',
    cadenceConfidence: 0.82,
    effectiveCadenceConfidence: 0.82,
    candidateCadenceRpm: 88,
    finalCadenceRpm: null,
    effectiveCadenceRpm: 88,
    cadenceEstimateLevel: 'candidate',
    cadenceUsable: true,
    estimatedSpeedKmh: 29.04,
    motionArtifact: 'none',
  }, 1000);
  metrics.onImuActivity({
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: 'warming',
    cadenceConfidence: 0.84,
    effectiveCadenceConfidence: 0.84,
    candidateCadenceRpm: 89,
    finalCadenceRpm: null,
    effectiveCadenceRpm: 89,
    cadenceEstimateLevel: 'candidate',
    cadenceUsable: true,
    estimatedSpeedKmh: 29.37,
    motionArtifact: 'none',
  }, 2000);
  const snapshot = metrics.snapshot(2000);
  assert.ok(Math.abs(snapshot.speedKmh - 17.088) < 1e-9);
  assert.equal(snapshot.cadenceRpm, 89);
  assert.equal(snapshot.distanceM, 0);
  assert.equal(snapshot.distanceMode, null);
  assert.ok(snapshot.movingMs > 0);
  assert.ok(snapshot.avgCadenceRpm > 0);
  assert.ok(snapshot.maxSpeedKmh > 16.8 && snapshot.maxSpeedKmh < 17.1);
  assert.equal(snapshot.maxCadenceRpm, 89);
  assert.deepEqual(snapshot.summarySourcesUsed, ['imu']);
  assert.deepEqual(snapshot.distanceSourcesUsed, []);
  assert.deepEqual(snapshot.metricSourcesUsed.speed, ['imu']);
  assert.deepEqual(snapshot.metricSourcesUsed.cadence, ['imu']);
  assert.equal(snapshot.imuAssist.effectiveCadenceRpm, 89);
  assert.equal(snapshot.imuAssist.availabilityEstimateActive, true);

  const candidate = (rpm, confidence = 0.84) => ({
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: 'warming',
    cadenceConfidence: confidence,
    effectiveCadenceConfidence: confidence,
    candidateCadenceRpm: rpm,
    finalCadenceRpm: null,
    effectiveCadenceRpm: rpm,
    cadenceEstimateLevel: 'candidate',
    cadenceUsable: true,
    estimatedSpeedKmh: rpm * 0.33,
    motionArtifact: 'none',
  });
  metrics.onImuActivity(candidate(89), 2500);
  assert.equal(metrics.snapshot(2500).distanceM, 0, '确认窗口只开距离锚，不回填');
  metrics.onImuActivity(candidate(89), 3500);
  assert.ok(metrics.snapshot(3500).distanceM > 0, '确认后的新鲜区间才允许入账');
});

test('Hermes 置信分布采用进入与维持迟滞，确认后正常低谷不再反复清空距离锚', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  const candidate = (confidence, rpm = 72) => ({
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: 'warming',
    cadenceConfidence: confidence,
    effectiveCadenceConfidence: confidence,
    candidateCadenceRpm: rpm,
    finalCadenceRpm: null,
    effectiveCadenceRpm: rpm,
    cadenceEstimateLevel: 'candidate',
    cadenceSensorSource: 'gyroscope_simple_candidate',
    cadenceUsable: false,
    availabilityCadenceUsable: true,
    estimatedSpeedKmh: 13.824,
    metersPerCrank: 3.2,
    motionArtifact: 'none',
    simpleGyroLedgerFresh: false,
    simpleGyroCadenceMethod: 'low_rate_timestamp_consensus',
  });

  metrics.onImuActivity(candidate(0.69), 0);
  metrics.onImuActivity(candidate(0.70), 750);
  metrics.onImuActivity(candidate(0.69), 1500);
  let snapshot = metrics.snapshot(1500);
  assert.equal(snapshot.distanceM, 0, '确认窗只建立距离锚');
  assert.equal(snapshot.imuAssist.distanceLedgerEligible, true);

  metrics.onImuActivity(candidate(0.57, 73), 2500);
  snapshot = metrics.snapshot(2500);
  assert.ok(snapshot.distanceM > 3 && snapshot.distanceM < 5);
  assert.equal(snapshot.distanceState, CYCLING_METRIC_STATES.LIVE);
  assert.equal(snapshot.imuAssist.distanceLedgerEligible, true);

  const beforeWeak = snapshot.distanceM;
  metrics.onImuActivity(candidate(0.5, 73), 3000);
  snapshot = metrics.snapshot(3000);
  assert.equal(snapshot.distanceM, beforeWeak);
  assert.equal(snapshot.imuAssist.distanceLedgerEligible, false);

  metrics.onImuActivity(candidate(0.70, 73), 3250);
  metrics.onImuActivity(candidate(0.70, 73), 4000);
  metrics.onImuActivity(candidate(0.70, 73), 4750);
  snapshot = metrics.snapshot(4750);
  assert.equal(snapshot.distanceM, beforeWeak, '重新确认帧只开新锚，不补低置信空档');
  metrics.onImuActivity(candidate(0.70, 73), 5750);
  assert.ok(metrics.snapshot(5750).distanceM > snapshot.distanceM, '确认后的新鲜区间继续累计');
});

test('没有可信 ledger 的 soft artifact、touch 与低置信空档恢复首帧都只重锚', () => {
  const metrics = new CyclingMetrics({ startMs: 0, imuDistanceMaxGapMs: 1800 });
  const locked = (motionArtifact = 'none') => ({
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: motionArtifact === 'none' ? 'estimated' : 'artifact',
    cadenceConfidence: 0.9,
    effectiveCadenceConfidence: 0.9,
    candidateCadenceRpm: 75,
    finalCadenceRpm: motionArtifact === 'none' ? 75 : null,
    effectiveCadenceRpm: 75,
    cadenceEstimateLevel: motionArtifact === 'none' ? 'locked' : 'none',
    cadenceUsable: motionArtifact === 'none',
    estimatedSpeedKmh: 14.4,
    metersPerCrank: 3.2,
    motionArtifact,
  });

  metrics.onImuActivity(locked(), 0);
  metrics.onImuActivity(locked(), 1000);
  const beforeArtifact = metrics.snapshot(1000).distanceM;
  metrics.onImuActivity(locked('road_impact'), 1400);
  metrics.onImuActivity(locked(), 1800);
  const afterSoftArtifact = metrics.snapshot(1800).distanceM;
  assert.equal(afterSoftArtifact, beforeArtifact, '800ms soft artifact 也不补无证据空档');

  metrics.onImuActivity(locked('touch'), 2200);
  metrics.onImuActivity(locked(), 2600);
  assert.equal(metrics.snapshot(2600).distanceM, afterSoftArtifact, 'touch 恢复首帧只重锚');
  metrics.onImuActivity(locked('head_turn'), 3000);
  metrics.onImuActivity(locked(), 5000);
  assert.equal(metrics.snapshot(5000).distanceM, afterSoftArtifact, '长 soft artifact 同样不补空档');

});

test('已有 fresh simple gyro ledger 时，短 road_impact 保留有界锚并桥接恢复段', () => {
  const metrics = new CyclingMetrics({ startMs: 0, imuDistanceMaxGapMs: 1800 });
  const locked = (overrides = {}) => ({
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: 'estimated',
    cadenceConfidence: 0.9,
    effectiveCadenceConfidence: 0.9,
    candidateCadenceRpm: 75,
    finalCadenceRpm: 75,
    effectiveCadenceRpm: 75,
    cadenceEstimateLevel: 'locked',
    cadenceUsable: true,
    estimatedSpeedKmh: 14.4,
    metersPerCrank: 3.2,
    motionArtifact: 'none',
    simpleGyroLedgerFresh: true,
    ...overrides,
  });

  metrics.onImuActivity(locked(), 0);
  metrics.onImuActivity(locked(), 1000);
  const before = metrics.snapshot(1000);
  metrics.onImuActivity(locked({
    cadenceState: 'artifact',
    cadenceUsable: false,
    motionArtifact: 'road_impact',
  }), 1400);
  const during = metrics.snapshot(1400);
  assert.equal(during.distanceM, before.distanceM, '污染帧本身不推进距离');
  assert.equal(during.distanceSource, null, '污染帧不能冒充 live 距离源');

  metrics.onImuActivity(locked(), 1800);
  const recovered = metrics.snapshot(1800);
  assert.ok(Math.abs(recovered.distanceM - before.distanceM - 3.2) < 1e-9);
  assert.equal(recovered.distanceCoverageMs, before.distanceCoverageMs + 800);
});

test('已确认 candidate 时，短 head_turn 可桥接但不会降低首次进入硬门', () => {
  const metrics = new CyclingMetrics({ startMs: 0, imuDistanceMaxGapMs: 1800 });
  const candidate = (motionArtifact = 'none') => ({
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: motionArtifact === 'none' ? 'warming' : 'artifact',
    cadenceConfidence: 0.72,
    effectiveCadenceConfidence: 0.72,
    candidateCadenceRpm: 75,
    finalCadenceRpm: null,
    effectiveCadenceRpm: 75,
    cadenceEstimateLevel: 'candidate',
    cadenceUsable: false,
    availabilityCadenceUsable: true,
    estimatedSpeedKmh: 14.4,
    metersPerCrank: 3.2,
    motionArtifact,
    simpleGyroLedgerFresh: false,
  });

  metrics.onImuActivity(candidate(), 0);
  metrics.onImuActivity(candidate(), 750);
  metrics.onImuActivity(candidate(), 1500);
  assert.equal(metrics.snapshot(1500).distanceM, 0, '0.68 + 三窗/1.5 秒只开锚');
  metrics.onImuActivity(candidate(), 2000);
  const before = metrics.snapshot(2000);
  assert.ok(before.distanceM > 0);

  metrics.onImuActivity(candidate('head_turn'), 2300);
  assert.equal(metrics.snapshot(2300).distanceM, before.distanceM);
  metrics.onImuActivity(candidate(), 2800);
  const recovered = metrics.snapshot(2800);
  assert.ok(Math.abs(recovered.distanceM - before.distanceM - 3.2) < 1e-9);
});

test('soft artifact 超过 1.8 秒后恢复首帧只重锚，下一帧才继续计距', () => {
  const metrics = new CyclingMetrics({ startMs: 0, imuDistanceMaxGapMs: 1800 });
  const locked = (motionArtifact = 'none') => ({
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: motionArtifact === 'none' ? 'estimated' : 'artifact',
    cadenceConfidence: 0.9,
    effectiveCadenceConfidence: 0.9,
    candidateCadenceRpm: 75,
    finalCadenceRpm: 75,
    effectiveCadenceRpm: 75,
    cadenceEstimateLevel: 'locked',
    cadenceUsable: motionArtifact === 'none',
    estimatedSpeedKmh: 14.4,
    metersPerCrank: 3.2,
    motionArtifact,
    simpleGyroLedgerFresh: true,
  });

  metrics.onImuActivity(locked(), 0);
  metrics.onImuActivity(locked(), 1000);
  const before = metrics.snapshot(1000);
  metrics.onImuActivity(locked('road_impact'), 1400);
  metrics.onImuActivity(locked(), 3000);
  let recovered = metrics.snapshot(3000);
  assert.equal(recovered.distanceM, before.distanceM);
  assert.equal(recovered.distanceCoverageMs, before.distanceCoverageMs);
  metrics.onImuActivity(locked(), 3500);
  recovered = metrics.snapshot(3500);
  assert.ok(Math.abs(recovered.distanceM - before.distanceM - 2) < 1e-9);
});

test('touch、明确静止、stale 与低可信帧都立即清锚且不制造停车距离', () => {
  const locked = (overrides = {}) => ({
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: 'estimated',
    cadenceConfidence: 0.9,
    effectiveCadenceConfidence: 0.9,
    candidateCadenceRpm: 75,
    finalCadenceRpm: 75,
    effectiveCadenceRpm: 75,
    cadenceEstimateLevel: 'locked',
    cadenceUsable: true,
    estimatedSpeedKmh: 14.4,
    metersPerCrank: 3.2,
    motionArtifact: 'none',
    simpleGyroLedgerFresh: true,
    ...overrides,
  });
  const hardInterrupts = [
    ['touch', locked({ cadenceState: 'artifact', cadenceUsable: false, motionArtifact: 'touch' })],
    ['stationary', locked({
      motionState: 'stationary',
      cadenceState: 'stationary',
      candidateCadenceRpm: 0,
      finalCadenceRpm: 0,
      effectiveCadenceRpm: 0,
      cadenceEstimateLevel: 'stationary',
      cadenceUsable: false,
      estimatedSpeedKmh: 0,
      simpleGyroLedgerFresh: false,
    })],
    ['stale', locked({ fresh: false, simpleGyroLedgerFresh: false })],
    ['low-confidence', locked({
      cadenceConfidence: 0.4,
      effectiveCadenceConfidence: 0.4,
      finalCadenceRpm: null,
      cadenceEstimateLevel: 'none',
      cadenceUsable: false,
      availabilityCadenceUsable: false,
      simpleGyroLedgerFresh: false,
    })],
  ];

  for (const [label, interrupted] of hardInterrupts) {
    const metrics = new CyclingMetrics({ startMs: 0, imuDistanceMaxGapMs: 1800 });
    metrics.onImuActivity(locked(), 0);
    metrics.onImuActivity(locked(), 1000);
    const before = metrics.snapshot(1000);
    metrics.onImuActivity(interrupted, 1400);
    const during = metrics.snapshot(1400);
    assert.equal(during.distanceM, before.distanceM, `${label} 不应生成中断距离`);
    assert.equal(during.distanceCoverageMs, before.distanceCoverageMs, `${label} 不增覆盖`);
    metrics.onImuActivity(locked(), 1800);
    assert.equal(metrics.snapshot(1800).distanceM, before.distanceM, `${label} 恢复首帧只重锚`);
    metrics.onImuActivity(locked(), 2300);
    assert.ok(metrics.snapshot(2300).distanceM > before.distanceM, `${label} 后续可信帧恢复`);
  }
});

test('IMU 单窗跳变不写入速度、峰值或距离，持续变速才按每秒上限跟随', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  const activity = (rpm) => ({
    motionState: 'moving',
    confidence: 0.95,
    fresh: true,
    cadenceState: 'estimated',
    cadenceConfidence: 0.95,
    effectiveCadenceConfidence: 0.95,
    candidateCadenceRpm: rpm,
    finalCadenceRpm: rpm,
    effectiveCadenceRpm: rpm,
    cadenceEstimateLevel: 'locked',
    cadenceUsable: true,
    estimatedSpeedKmh: 1,
    metersPerCrank: 3.2,
    motionArtifact: 'none',
  });
  metrics.onImuActivity(activity(90), 0);
  metrics.onImuActivity(activity(90), 500);
  metrics.onImuActivity(activity(90), 1000);
  const stable = metrics.snapshot(1000);

  metrics.onImuActivity(activity(125), 1250);
  const oneSpike = metrics.snapshot(1250);
  assert.equal(oneSpike.cadenceRpm, stable.cadenceRpm);
  assert.equal(oneSpike.speedKmh, stable.speedKmh);
  assert.equal(oneSpike.distanceM, stable.distanceM);
  assert.equal(oneSpike.maxCadenceRpm, stable.maxCadenceRpm);
  assert.equal(oneSpike.maxSpeedKmh, stable.maxSpeedKmh);
  assert.equal(oneSpike.imuAssist.estimateStabilized, true);

  metrics.onImuActivity(activity(90), 1500);
  const recovered = metrics.snapshot(1500);
  assert.equal(recovered.cadenceRpm, 90);
  assert.equal(recovered.speedKmh, stable.speedKmh);

  metrics.onImuActivity(activity(125), 1750);
  metrics.onImuActivity(activity(125), 2000);
  metrics.onImuActivity(activity(125), 2250);
  const confirmed = metrics.snapshot(2250);
  assert.ok(confirmed.cadenceRpm > 90 && confirmed.cadenceRpm < 125);
  assert.ok(Math.abs(confirmed.speedKmh - recovered.speedKmh) <= 2.501);
  assert.ok(confirmed.maxCadenceRpm < 125, '滤波前 raw 值不能进入峰值');
});

test('10Hz 录屏 soft artifact 在 5 秒内显示踏频/速度，但持续 artifact 不计里程', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  const imu = new CyclingImuActivity({
    startMs: 0,
    gyroscopeSampleHz: 10,
  });
  const headTurn = {
    state: 'head_motion',
    artifact: 'head_turn',
    quality: 0.2,
    allowCadenceEvidence: false,
  };
  let activity = null;
  for (let atMs = 0; atMs <= 5000; atMs += 100) {
    const phase = 2 * Math.PI * 88 * atMs / 60000;
    activity = imu.onGyroscopeSample({
      x: 0.08 * Math.sin(phase),
      y: 0.04 * Math.cos(phase),
      z: 0.02 * Math.sin(phase + 0.4),
      timestampMs: atMs,
    }, atMs, headTurn, atMs);
    metrics.onImuActivity(activity, atMs);
  }
  const snapshot = metrics.snapshot(5000);
  assert.equal(activity.finalCadenceRpm, null);
  assert.equal(activity.cadenceEstimateLevel, 'candidate');
  assert.equal(activity.availabilityCadenceUsable, true);
  assert.match(activity.simpleGyroCadenceMethod, /low_rate_timestamp_consensus/);
  assert.ok(Math.abs(snapshot.cadenceRpm - 88) < 3);
  assert.ok(snapshot.speedKmh > 0 && snapshot.speedKmh <= 18);
  assert.ok(snapshot.distanceM >= 0);
  assert.equal(snapshot.metrics.cadence.source, 'imu');
  assert.equal(snapshot.metrics.speed.source, 'imu');
  if (snapshot.distanceM === 0) assert.equal(snapshot.distanceSource, null);

  assert.equal(snapshot.distanceM, 0, '持续 artifact 只可见，不得进入距离账本');
});

test('先静止再进入 10Hz soft artifact，5 秒内覆盖旧零态但不计里程', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  const imu = new CyclingImuActivity({
    startMs: 0,
    gyroscopeSampleHz: 10,
  });
  let activity = null;
  for (let atMs = 0; atMs <= 2500; atMs += 100) {
    activity = imu.onGyroscopeSample({
      x: 0,
      y: 0,
      z: 0,
      timestampMs: atMs,
    }, atMs, null, atMs);
    metrics.onImuActivity(activity, atMs);
  }
  assert.equal(activity.motionState, 'stationary');
  assert.equal(activity.finalCadenceRpm, 0);

  const headTurn = {
    state: 'head_motion',
    artifact: 'head_turn',
    quality: 0.2,
    allowCadenceEvidence: false,
  };
  for (let atMs = 2600; atMs <= 7600; atMs += 100) {
    const phase = 2 * Math.PI * 88 * (atMs - 2600) / 60000;
    activity = imu.onGyroscopeSample({
      x: 0.08 * Math.sin(phase),
      y: 0.04 * Math.cos(phase),
      z: 0.02 * Math.sin(phase + 0.4),
      timestampMs: atMs,
    }, atMs, headTurn, atMs);
    metrics.onImuActivity(activity, atMs);
  }
  const snapshot = metrics.snapshot(7600);
  assert.equal(activity.cadenceEstimateLevel, 'candidate');
  assert.equal(activity.availabilityCadenceUsable, true);
  assert.ok(Math.abs(snapshot.cadenceRpm - 88) < 3);
  assert.ok(snapshot.speedKmh > 0 && snapshot.speedKmh <= 18);
  assert.ok(snapshot.distanceM >= 0);

  assert.equal(snapshot.distanceM, 0, '静止后的持续 artifact 仍不得进入距离账本');
});

test('CSC/CPS 合法轮事件批量到达时，同一计数源的 protocol delta 不按 arrival 重叠少算', () => {
  for (const source of ['csc', 'cps']) {
    const metrics = new CyclingMetrics({ startMs: 0, wheelCircumferenceMm: 2000 });
    const send = source === 'csc'
      ? (revolutions, event, nowMs) => metrics.onCsc(csc({
        wheel: { revolutions, lastEventTime1024: event },
      }), nowMs)
      : (revolutions, event, nowMs) => metrics.onCyclingPower(cps({
        wheel: { revolutions, lastEventTime2048: event },
      }), nowMs);
    const hz = source === 'csc' ? 1024 : 2048;
    send(100, 0, 0);
    send(101, hz, 3000);
    send(102, hz * 2, 3010);
    send(103, hz * 3, 3020);
    const snapshot = metrics.snapshot(3020);
    assert.ok(Math.abs(snapshot.distanceM - 6) < 1e-9, `${source} 应完整计入三圈`);
    assert.equal(snapshot.distanceCoverageMs, 3000);
  }
});

test('暂停与显式结束会按优先级结算 standby 未覆盖段，且重复 finalize 幂等', () => {
  const build = () => {
    const metrics = new CyclingMetrics({ startMs: 0, wheelCircumferenceMm: 2000 });
    metrics.onCsc(csc({
      wheel: { revolutions: 100, lastEventTime1024: 0 },
    }), 0);
    metrics.onFtms(ftms({ speedKmh: 18 }), 0);
    metrics.onCsc(csc({
      wheel: { revolutions: 101, lastEventTime1024: 1024 },
    }), 1000);
    for (let second = 1; second <= 4; second += 1) {
      metrics.onFtms(ftms({ speedKmh: 18 }), second * 1000);
    }
    return metrics;
  };

  const paused = build();
  assert.equal(paused.snapshot(4000).distanceM, 2);
  assert.equal(paused.pause(4000), true);
  assert.equal(paused.snapshot(4000).distanceM, 17, 'CSC 覆盖首秒，FTMS 补后三秒');

  const finished = build();
  assert.equal(finished.finalizeDistance(4000), true);
  const once = finished.snapshot(4000).distanceM;
  assert.equal(once, 17);
  assert.equal(finished.finalizeDistance(4000), true);
  assert.equal(finished.snapshot(4000).distanceM, once);
});

test('宽松 ACF 候选即使高置信也只留诊断，不进入三项账本', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.onImuActivity({
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: 'warming',
    cadenceConfidence: 0.9,
    effectiveCadenceConfidence: 0.9,
    candidateCadenceRpm: 96,
    finalCadenceRpm: null,
    effectiveCadenceRpm: 96,
    cadenceEstimateLevel: 'candidate',
    cadenceSensorSource: 'gyroscope_simple_candidate',
    availabilityCadenceUsable: false,
    metersPerCrank: 3.2,
    motionArtifact: 'road_impact',
  }, 1000);
  const snapshot = metrics.snapshot(1000);
  assert.equal(snapshot.speedKmh, null);
  assert.equal(snapshot.cadenceRpm, null);
  assert.equal(snapshot.distanceM, 0);
  assert.equal(snapshot.imuAssist.candidateCadenceRpm, 96);
});

test('head_turn 与 road_impact 连续污染都严格冻结 IMU 聚合账本', () => {
  for (const [motionArtifact, motionQualityState] of [
    ['head_turn', 'head_motion'],
    ['road_impact', 'road_impact'],
  ]) {
    const metrics = new CyclingMetrics({ startMs: 0, imuMetersPerCrank: 5.5 });
    const trusted = {
      motionState: 'moving',
      confidence: 0.9,
      fresh: true,
      cadenceState: 'estimated',
      cadenceConfidence: 0.9,
      effectiveCadenceConfidence: 0.9,
      candidateCadenceRpm: 90,
      finalCadenceRpm: 90,
      effectiveCadenceRpm: 90,
      cadenceUsable: true,
      estimatedSpeedKmh: 29.7,
      motionArtifact: 'none',
      motionQualityState: 'trusted',
    };
    metrics.onImuActivity(trusted, 1000);
    metrics.onImuActivity(trusted, 2000);
    const polluted = {
      ...trusted,
      cadenceState: 'artifact',
      candidateCadenceRpm: 120,
      finalCadenceRpm: 120,
      effectiveCadenceRpm: 120,
      estimatedSpeedKmh: 39.6,
      cadenceUsable: false,
      motionArtifact,
      motionQualityState,
    };
    metrics.onImuActivity(polluted, 3000);
    const first = metrics.snapshot(3000);
    const frozen = {
      distanceM: first.distanceM,
      distanceCoverageMs: first.distanceCoverageMs,
      cadenceAverageDurationMs: metrics.cadenceAverage.durationMs,
      movingMs: first.movingMs,
      avgCadenceRpm: first.avgCadenceRpm,
      maxCadenceRpm: first.maxCadenceRpm,
      maxSpeedKmh: first.maxSpeedKmh,
    };
    metrics.onImuActivity(polluted, 5000);
    const second = metrics.snapshot(5000);
    assert.deepEqual({
      distanceM: second.distanceM,
      distanceCoverageMs: second.distanceCoverageMs,
      cadenceAverageDurationMs: metrics.cadenceAverage.durationMs,
      movingMs: second.movingMs,
      avgCadenceRpm: second.avgCadenceRpm,
      maxCadenceRpm: second.maxCadenceRpm,
      maxSpeedKmh: second.maxSpeedKmh,
    }, frozen, motionArtifact);
  }
});

test('IMU 数值过期后总结来源仍保留估算证据', () => {
  const metrics = new CyclingMetrics({ startMs: 0, metricStaleMs: 1000 });
  const activity = {
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: 'estimated',
    cadenceConfidence: 0.9,
    candidateCadenceRpm: 80,
    finalCadenceRpm: 80,
    estimatedSpeedKmh: 26.4,
  };
  metrics.onImuActivity(activity, 1000);
  metrics.onImuActivity(activity, 2000);
  const snap = metrics.snapshot(5000);
  assert.equal(snap.speedKmh, null);
  assert.equal(snap.distanceSource, null);
  assert.ok(snap.distanceM > 0);
  assert.deepEqual(snap.summarySourcesUsed, ['imu']);
});

test('低置信 IMU 候选只留诊断，不生成骑行数值', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.onImuActivity({
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: 'degraded',
    cadenceConfidence: 0.5,
    candidateCadenceRpm: 83,
    finalCadenceRpm: null,
    estimatedSpeedKmh: null,
  }, 1000);
  const snap = metrics.snapshot(1000);
  assert.equal(snap.speedKmh, null);
  assert.equal(snap.cadenceRpm, null);
  assert.equal(snap.distanceM, 0);
  assert.equal(snap.imuAssist.candidateCadenceRpm, 83);
});

test('真实 CSC 速度和踏频立即抢占 IMU 估算', () => {
  const metrics = new CyclingMetrics({
    startMs: 0,
    wheelCircumferenceMm: 2000,
    imuMetersPerCrank: 5.5,
  });
  metrics.onImuActivity({
    motionState: 'moving',
    confidence: 1,
    fresh: true,
    cadenceState: 'estimated',
    cadenceConfidence: 0.9,
    candidateCadenceRpm: 80,
    finalCadenceRpm: 80,
    estimatedSpeedKmh: 26.4,
  }, 1000);
  metrics.onCsc(csc({
    wheel: { revolutions: 10, lastEventTime1024: 0 },
    crank: { revolutions: 10, lastEventTime1024: 0 },
  }), 1100);
  metrics.onCsc(csc({
    wheel: { revolutions: 11, lastEventTime1024: 512 },
    crank: { revolutions: 11, lastEventTime1024: 768 },
  }), 2100);
  const snap = metrics.snapshot(2100);
  assert.equal(snap.metrics.speed.source, 'csc');
  assert.equal(snap.metrics.cadence.source, 'csc');
  assert.ok(Math.abs(snap.speedKmh - 14.4) < 1e-9);
  assert.ok(Math.abs(snap.cadenceRpm - 80) < 1e-9);
});

test('指标聚合器不再暴露定位入口，FTMS 实测速度立即抢占 IMU', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  const imu = {
    motionState: 'moving',
    confidence: 0.9,
    fresh: true,
    cadenceState: 'estimated',
    cadenceConfidence: 0.9,
    candidateCadenceRpm: 80,
    finalCadenceRpm: 80,
    estimatedSpeedKmh: 26.4,
  };
  metrics.onImuActivity(imu, 1000);
  assert.equal(metrics.snapshot(1000).metrics.speed.source, 'imu');
  assert.equal(metrics.onGpsActivity, undefined);
  assert.equal(metrics.snapshot(1000).sources.gps, undefined);
  metrics.onFtms(ftms({ speedKmh: 24 }), 2100);
  const ble = metrics.snapshot(2100);
  assert.equal(ble.metrics.speed.source, 'ftms');
  assert.equal(ble.speedKmh, 24);
});

test('乱序 CSC 包被拒绝且不能污染下一帧轮转距离锚点', () => {
  const metrics = new CyclingMetrics({
    startMs: 0,
    wheelCircumferenceMm: 2105,
  });
  metrics.onCsc(csc({
    wheel: { revolutions: 100, lastEventTime1024: 0 },
  }), 0);
  metrics.onCsc(csc({
    wheel: { revolutions: 101, lastEventTime1024: 1024 },
  }), 1000);
  assert.equal(metrics.onCsc(csc({
    wheel: { revolutions: 100, lastEventTime1024: 0 },
  }), 500), false);
  metrics.onCsc(csc({
    wheel: { revolutions: 102, lastEventTime1024: 2048 },
  }), 2000);
  assert.ok(Math.abs(metrics.snapshot(2000).distanceM - 4.21) < 1e-9);
});

test('真实迟到的旧 CSC 包即使到达时间更晚也不能多算一圈', () => {
  const metrics = new CyclingMetrics({
    startMs: 0,
    wheelCircumferenceMm: 2105,
  });
  metrics.onCsc(csc({
    wheel: { revolutions: 100, lastEventTime1024: 0 },
  }), 0);
  metrics.onCsc(csc({
    wheel: { revolutions: 101, lastEventTime1024: 1024 },
  }), 1000);
  assert.equal(metrics.onCsc(csc({
    wheel: { revolutions: 100, lastEventTime1024: 0 },
  }), 1500), true);
  metrics.onCsc(csc({
    wheel: { revolutions: 102, lastEventTime1024: 2048 },
  }), 2000);
  assert.ok(Math.abs(metrics.snapshot(2000).distanceM - 4.21) < 1e-9);
});

test('连续两个迟到 CSC 缓存包由第三包判为 replay，保留旧锚且不重复计圈', () => {
  const metrics = new CyclingMetrics({
    startMs: 0,
    wheelCircumferenceMm: 2105,
  });
  for (const [revolutions, lastEventTime1024, nowMs] of [
    [100, 0, 0],
    [101, 1024, 1000],
    [102, 2048, 2000],
    [100, 0, 3000],
    [101, 1024, 4000],
    [103, 3072, 5000],
  ]) {
    metrics.onCsc(csc({
      wheel: { revolutions, lastEventTime1024 },
    }), nowMs);
  }
  const snapshot = metrics.snapshot(5000);
  assert.ok(Math.abs(snapshot.distanceM - 6.315) < 1e-9);
  assert.equal(snapshot.distanceCoverageMs, 3000);
  assert.ok(Math.abs(snapshot.avgSpeedKmh - 7.578) < 1e-9);
});

test('CSC 连续三个新低包才确认真实 reset，确认包重锚、第四包恢复计距', () => {
  const metrics = new CyclingMetrics({
    startMs: 0,
    wheelCircumferenceMm: 2105,
  });
  for (const [revolutions, lastEventTime1024, nowMs] of [
    [1000, 0, 0],
    [1001, 1024, 1000],
    [10, 0, 2000],
    [11, 1024, 3000],
    [12, 2048, 4000],
  ]) {
    metrics.onCsc(csc({
      wheel: { revolutions, lastEventTime1024 },
    }), nowMs);
  }
  const confirmed = metrics.snapshot(4000);
  assert.ok(Math.abs(confirmed.distanceM - 2.105) < 1e-9);
  assert.equal(confirmed.speedKmh, null);

  metrics.onCsc(csc({
    wheel: { revolutions: 13, lastEventTime1024: 3072 },
  }), 5000);
  const recovered = metrics.snapshot(5000);
  assert.ok(Math.abs(recovered.distanceM - 4.21) < 1e-9);
  assert.ok(Math.abs(recovered.speedKmh - 7.578) < 1e-9);
});

test('CSC 曲柄同样用第三包区分双旧包 replay 与真实 reset', () => {
  const replay = new CyclingMetrics({ startMs: 0 });
  for (const [revolutions, lastEventTime1024, nowMs] of [
    [100, 0, 0],
    [101, 768, 1000],
    [10, 0, 2000],
    [11, 768, 3000],
    [102, 1536, 4000],
  ]) {
    replay.onCsc(csc({
      crank: { revolutions, lastEventTime1024 },
    }), nowMs);
  }
  assert.ok(Math.abs(replay.snapshot(4000).cadenceRpm - 80) < 1e-9);

  const reset = new CyclingMetrics({ startMs: 0 });
  for (const [revolutions, lastEventTime1024, nowMs] of [
    [100, 0, 0],
    [101, 768, 1000],
    [10, 0, 2000],
    [11, 768, 3000],
    [12, 1536, 4000],
  ]) {
    reset.onCsc(csc({
      crank: { revolutions, lastEventTime1024 },
    }), nowMs);
  }
  assert.equal(reset.snapshot(4000).cadenceRpm, null);
  reset.onCsc(csc({
    crank: { revolutions: 13, lastEventTime1024: 2304 },
  }), 5000);
  assert.ok(Math.abs(reset.snapshot(5000).cadenceRpm - 80) < 1e-9);
});

test('真实迟到的旧 FTMS 累计值不污染已确认锚点', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.onFtms(ftms({ totalDistanceM: 100 }), 0);
  metrics.onFtms(ftms({ totalDistanceM: 105 }), 1000);
  metrics.onFtms(ftms({ totalDistanceM: 100 }), 1500);
  metrics.onFtms(ftms({ totalDistanceM: 110 }), 2000);
  assert.equal(metrics.snapshot(2000).distanceM, 10);
});

test('连续两个迟到 FTMS 累计值由第三包判为 replay，不误确认 reset', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  for (const [totalDistanceM, nowMs] of [
    [100, 0],
    [105, 1000],
    [90, 2000],
    [95, 3000],
    [110, 4000],
  ]) {
    metrics.onFtms(ftms({ totalDistanceM }), nowMs);
  }
  assert.equal(metrics.snapshot(4000).distanceM, 10);
});

test('FTMS 连续三个新低值才确认真实 reset，第四包恢复累计距离', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  for (const [totalDistanceM, nowMs] of [
    [1000, 0],
    [1005, 1000],
    [500, 2000],
    [505, 3000],
    [510, 4000],
  ]) {
    metrics.onFtms(ftms({ totalDistanceM }), nowMs);
  }
  assert.equal(metrics.snapshot(4000).distanceM, 5);
  metrics.onFtms(ftms({ totalDistanceM: 515 }), 5000);
  assert.equal(metrics.snapshot(5000).distanceM, 10);
});

test('15 RPM 与约 2 km/h 的合法事件周期不会被固定 3 秒误判停车', () => {
  const cadence = new CyclingMetrics({ startMs: 0 });
  cadence.onCsc(csc({
    crank: { revolutions: 10, lastEventTime1024: 0 },
  }), 0);
  cadence.onCsc(csc({
    crank: { revolutions: 11, lastEventTime1024: 4096 },
  }), 4000);
  assert.equal(cadence.snapshot(7100).cadenceRpm, 15);
  assert.equal(cadence.snapshot(7100).metrics.cadence.state, CYCLING_METRIC_STATES.LIVE);

  const speed = new CyclingMetrics({
    startMs: 0,
    wheelCircumferenceMm: 2105,
  });
  speed.onCsc(csc({
    wheel: { revolutions: 100, lastEventTime1024: 0 },
  }), 0);
  speed.onCsc(csc({
    wheel: { revolutions: 101, lastEventTime1024: 3880 },
  }), 3789);
  const lowSpeed = speed.snapshot(7000);
  assert.ok(Math.abs(lowSpeed.speedKmh - 2) < 0.01);
  assert.equal(lowSpeed.metrics.speed.state, CYCLING_METRIC_STATES.LIVE);
});

test('CSC 恒速首段立即进入距离覆盖时长，连续事件均速不随收包相位膨胀', () => {
  const metrics = new CyclingMetrics({
    startMs: 0,
    wheelCircumferenceMm: 2000,
  });
  for (let second = 0; second <= 4; second += 1) {
    metrics.onCsc(csc({
      wheel: {
        revolutions: 100 + second,
        lastEventTime1024: second * 1024,
      },
    }), second * 1000);
    if (second > 0) {
      const snapshot = metrics.snapshot(second * 1000);
      assert.equal(snapshot.distanceCoverageMs, second * 1000);
      assert.ok(Math.abs(snapshot.avgSpeedKmh - 7.2) < 1e-9);
    }
  }
});

test('低于 moving 阈值的合法轮速仍用真实事件周期计算均速', () => {
  const metrics = new CyclingMetrics({
    startMs: 0,
    wheelCircumferenceMm: 2000,
  });
  metrics.onCsc(csc({
    wheel: { revolutions: 100, lastEventTime1024: 0 },
  }), 0);
  metrics.onCsc(csc({
    wheel: { revolutions: 101, lastEventTime1024: 7200 },
  }), 7031.25);
  const snapshot = metrics.snapshot(7031.25);
  assert.equal(snapshot.movingMs, 0, '状态阈值不应伪造 moving time');
  assert.equal(snapshot.distanceCoverageMs, 7031.25);
  assert.ok(Math.abs(snapshot.avgSpeedKmh - 1.024) < 1e-9);
});

test('停车超过 8 秒后首轮只重锚，第二轮立即恢复速度与距离', () => {
  const metrics = new CyclingMetrics({
    startMs: 0,
    wheelCircumferenceMm: 2105,
  });
  metrics.onCsc(csc({
    wheel: { revolutions: 100, lastEventTime1024: 0 },
  }), 0);
  metrics.onCsc(csc({
    wheel: { revolutions: 101, lastEventTime1024: 1024 },
  }), 1000);
  metrics.onCsc(csc({
    wheel: { revolutions: 102, lastEventTime1024: 10240 },
  }), 10000);
  metrics.onCsc(csc({
    wheel: { revolutions: 103, lastEventTime1024: 11264 },
  }), 11000);
  const recovered = metrics.snapshot(11000);
  assert.ok(Math.abs(recovered.speedKmh - 7.578) < 0.001);
  assert.ok(Math.abs(recovered.distanceM - 4.21) < 1e-9);
});

test('FTMS 只在首包携带累计距离时，两包后无缝切到速度积分', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 100 }), 0);
  for (let second = 1; second <= 10; second += 1) {
    metrics.onFtms(ftms({ speedKmh: 20 }), second * 1000);
  }
  const snapshot = metrics.snapshot(10000);
  assert.ok(Math.abs(snapshot.distanceM - (20 / 3.6 * 10)) < 1e-9);
  assert.equal(snapshot.distanceMode, 'speed_integration');
});

test('FTMS 累计值只冻结一包后恢复，距离覆盖时长保留完整区间', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.onFtms(ftms({ speedKmh: 18, totalDistanceM: 100 }), 0);
  metrics.onFtms(ftms({ speedKmh: 18, totalDistanceM: 100 }), 1000);
  metrics.onFtms(ftms({ speedKmh: 18, totalDistanceM: 110 }), 2000);
  const recovered = metrics.snapshot(2000);
  assert.equal(recovered.distanceM, 10);
  assert.equal(recovered.distanceCoverageMs, 2000);
  assert.ok(Math.abs(recovered.avgSpeedKmh - 18) < 1e-9);
});

test('FTMS 速度积分期间的单个迟到旧累计值不能切回并重复记账', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 100 }), 0);
  metrics.onFtms(ftms({ speedKmh: 20 }), 1000);
  metrics.onFtms(ftms({ speedKmh: 20 }), 2000);
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 90 }), 3000);
  assert.equal(metrics.snapshot(3000).distanceMode, 'speed_integration');
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 122.222 }), 4000);
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 127.778 }), 5000);
  const snapshot = metrics.snapshot(5000);
  assert.ok(Math.abs(snapshot.distanceM - (20 / 3.6 * 5)) < 0.001);
  assert.equal(snapshot.distanceMode, 'total');
});

test('FTMS 速度积分期间两个迟到累计值不误切回，第三包回原序列后无重复', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 100 }), 0);
  metrics.onFtms(ftms({ speedKmh: 20 }), 1000);
  metrics.onFtms(ftms({ speedKmh: 20 }), 2000);
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 90 }), 3000);
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 95 }), 4000);
  assert.equal(metrics.snapshot(4000).distanceMode, 'speed_integration');

  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 127.778 }), 5000);
  assert.equal(metrics.snapshot(5000).distanceMode, 'total');
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 133.334 }), 6000);
  const recovered = metrics.snapshot(6000);
  assert.ok(Math.abs(recovered.distanceM - (20 / 3.6 * 5 + 5.556)) < 0.001);
});

test('CSC 静默时持续维护 FTMS standby，过 freshness 后只补未覆盖距离', () => {
  const metrics = new CyclingMetrics({
    startMs: 0,
    wheelCircumferenceMm: 2000,
  });
  metrics.onCsc(csc({
    wheel: { revolutions: 100, lastEventTime1024: 0 },
  }), 0);
  metrics.onFtms(ftms({ speedKmh: 18, totalDistanceM: 100 }), 0);
  metrics.onCsc(csc({
    wheel: { revolutions: 101, lastEventTime1024: 1024 },
  }), 1000);
  for (let second = 1; second <= 11; second += 1) {
    metrics.onFtms(ftms({
      speedKmh: 18,
      totalDistanceM: 100 + second * 5,
    }), second * 1000);
  }
  const takeover = metrics.snapshot(11000);
  assert.equal(takeover.distanceSource, 'ftms');
  assert.equal(takeover.distanceMode, 'total');
  assert.equal(takeover.distanceM, 52, '首秒由高优先 CSC 计 2m，后 10 秒由 FTMS 补 50m');
  assert.equal(takeover.distanceCoverageMs, 11000);
  assert.ok(Math.abs(takeover.avgSpeedKmh - (52 / 11 * 3.6)) < 1e-9);
});

test('无效 CSC wheel 不会压住仍有效的 FTMS 距离', () => {
  const metrics = new CyclingMetrics({
    startMs: 0,
    wheelCircumferenceMm: 2105,
  });
  metrics.onFtms(ftms({ speedKmh: 18, totalDistanceM: 100 }), 0);
  metrics.onFtms(ftms({ speedKmh: 18, totalDistanceM: 105 }), 1000);
  metrics.onCsc(csc({
    wheel: { revolutions: 100, lastEventTime1024: 0 },
  }), 1100);
  metrics.onCsc(csc({
    wheel: { revolutions: 101, lastEventTime1024: 1 },
  }), 1200);
  const snapshot = metrics.snapshot(1200);
  assert.equal(snapshot.distanceSource, 'ftms');
  assert.equal(snapshot.distanceMode, 'total');
  assert.equal(snapshot.distanceM, 5);
});

test('HRS 明确未贴合时立即撤销心率，不让无接触值进入现场指标', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.onHeartRate(150, 0);
  assert.equal(metrics.snapshot(0).heartRateBpm, 150);
  metrics.onHeartRateContactLost(1000);
  const lost = metrics.snapshot(1000);
  assert.equal(lost.heartRateBpm, null);
  assert.equal(lost.metrics.heartRate.state, CYCLING_METRIC_STATES.STALE);
});

test('累计距离来源断流后仍保留已确认历史与可用标记', () => {
  const metrics = new CyclingMetrics({
    startMs: 0,
    wheelCircumferenceMm: 2105,
  });
  metrics.onCsc(csc({
    wheel: { revolutions: 100, lastEventTime1024: 0 },
  }), 0);
  metrics.onCsc(csc({
    wheel: { revolutions: 101, lastEventTime1024: 1024 },
  }), 1000);
  const stale = metrics.snapshot(10000);
  assert.equal(stale.distanceEverAvailable, true);
  assert.ok(Math.abs(stale.distanceM - 2.105) < 1e-9);
  assert.equal(stale.distanceState, CYCLING_METRIC_STATES.STALE);
});

test('FTMS 累计距离冻结两包后回退速度积分，恢复首包只重锚', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 100 }), 0);
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 100 }), 1000);
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 100 }), 2000);

  const fallback = metrics.snapshot(2000);
  assert.ok(Math.abs(fallback.distanceM - (20 / 3.6 * 2)) < 1e-9);
  assert.equal(fallback.distanceMode, 'speed_integration');

  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 116.667 }), 3000);
  assert.ok(
    Math.abs(metrics.snapshot(3000).distanceM - (20 / 3.6 * 3)) < 1e-9,
    '累计恢复首包只能切回并重锚，不能重复补入累计差',
  );
  metrics.onFtms(ftms({ speedKmh: 20, totalDistanceM: 122.223 }), 4000);
  const recovered = metrics.snapshot(4000);
  assert.ok(Math.abs(recovered.distanceM - (20 / 3.6 * 3 + 5.556)) < 0.001);
  assert.equal(recovered.distanceMode, 'total');
});

test('CPS 最新包缺少曲柄字段时，旧踏频不会以零值压住新鲜 CSC', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.onCsc(csc({
    crank: { revolutions: 10, lastEventTime1024: 0 },
  }), 0);
  metrics.onCsc(csc({
    crank: { revolutions: 11, lastEventTime1024: 768 },
  }), 1000);
  metrics.onCyclingPower(cps({
    powerW: 200,
    crank: { revolutions: 20, lastEventTime1024: 0 },
  }), 1100);
  metrics.onCyclingPower(cps({
    powerW: 210,
    crank: { revolutions: 21, lastEventTime1024: 768 },
  }), 2100);

  metrics.onCsc(csc({
    crank: { revolutions: 12, lastEventTime1024: 1536 },
  }), 5000);
  metrics.onCyclingPower(cps({ powerW: 220 }), 5200);
  const snapshot = metrics.snapshot(5200);
  assert.equal(snapshot.metrics.cadence.source, 'csc');
  assert.ok(Math.abs(snapshot.cadenceRpm - 80) < 1e-9);
});

test('只有真实踏频、没有任何距离来源时平均速度保持未知', () => {
  const metrics = new CyclingMetrics({ startMs: 0 });
  metrics.onCsc(csc({
    crank: { revolutions: 10, lastEventTime1024: 0 },
  }), 0);
  metrics.onCsc(csc({
    crank: { revolutions: 11, lastEventTime1024: 768 },
  }), 1000);
  const snapshot = metrics.snapshot(2000);
  assert.ok(snapshot.movingMs > 0);
  assert.equal(snapshot.distanceM, 0);
  assert.equal(snapshot.avgSpeedKmh, null);
  assert.equal(snapshot.elapsedAvgSpeedKmh, null);
});
