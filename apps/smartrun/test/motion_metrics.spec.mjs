import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CADENCE_SOURCE,
  MOTION_SOURCE,
  MotionMetrics,
} from '../lib/motion_metrics.js';

function assertNear(actual, expected, tolerance = 1e-6, message = '') {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message} actual=${actual}, expected=${expected}, tolerance=${tolerance}`,
  );
}

test('启动时没有步频或配速证据：cadenceReady=false 且所有配速为 null', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  const snapshot = metrics.snapshot(1000);
  assert.equal(snapshot.cadenceSpm, 0);
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.NONE);
  assert.equal(snapshot.cadenceReady, false);
  assert.equal(snapshot.paceSecPerKm, null);
  assert.equal(snapshot.instantPaceSecPerKm, null);
  assert.equal(snapshot.avgPaceSecPerKm, null);
});

test('IMU：每个 accepted step 精确推进单步距离，并生成 10 秒滚动配速', () => {
  const metrics = new MotionMetrics({ startMs: 0, stepLengthM: 1 });
  for (let second = 1; second <= 10; second += 1) {
    metrics.onAcceptedStep(second * 1000);
  }

  const snapshot = metrics.snapshot(10000);
  assert.equal(snapshot.steps, 10);
  assert.equal(snapshot.distanceM, 10);
  assertNear(snapshot.paceSecPerKm, 1000);
  assert.equal(snapshot.distanceSource, MOTION_SOURCE.IMU_STEP);
  assert.equal(snapshot.paceSource, MOTION_SOURCE.IMU_STEP);
  assert.equal(snapshot.activeMotionSource, MOTION_SOURCE.IMU_STEP);
});

test('IMU 防御门：220ms 内的重复落步被拒绝，长停顿后不拼出虚假低步频', () => {
  const metrics = new MotionMetrics({ startMs: 0, stepLengthM: 1 });
  assert.equal(metrics.onAcceptedStep(1000, 170), true);
  assert.equal(metrics.onAcceptedStep(1100, 170), false);
  assert.equal(metrics.snapshot(1100).steps, 1);
  assert.equal(metrics.snapshot(1100).distanceM, 1);

  assert.equal(metrics.onAcceptedStep(1400, 170), true);
  assert.equal(metrics.snapshot(1400).cadenceReady, false);
  assert.equal(metrics.onAcceptedStep(1800, 170), true);
  assert.equal(metrics.snapshot(1800).cadenceReady, false);
  assert.equal(metrics.onAcceptedStep(2200, 170), true);
  assert.equal(metrics.snapshot(2200).cadenceReady, true);
  assert.equal(metrics.onAcceptedStep(7000), true);
  const afterGap = metrics.snapshot(7000);
  assert.equal(afterGap.steps, 5);
  assert.equal(afterGap.cadenceSpm, 0, '长停顿后的第一步只是新节奏锚点');
  assert.equal(afterGap.cadenceReady, false);
});

test('MotionMetrics 忽略上游错误候选步频，按最终 accepted 间隔计算', () => {
  const metrics = new MotionMetrics({ startMs: 0, stepLengthM: 1 });
  for (const timestampMs of [1000, 1600, 2200]) {
    assert.equal(metrics.onAcceptedStep(timestampMs, 200), true);
    const warmingUp = metrics.snapshot(timestampMs);
    assert.equal(warmingUp.cadenceReady, false);
    assert.equal(warmingUp.cadenceSpm, 0);
  }

  assert.equal(metrics.onAcceptedStep(2800, 200), true);
  const snapshot = metrics.snapshot(2800);
  assert.equal(snapshot.steps, 4);
  assert.equal(snapshot.cadenceReady, true);
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.IMU);
  assert.equal(snapshot.cadenceSpm, 100);
  assert.notEqual(snapshot.cadenceSpm, 200);

  assert.equal(
    metrics.onImuCadence(115, 3000),
    false,
    '正式 accepted-step 步频形成后，候选值不得再覆盖终态',
  );
  const afterCandidate = metrics.snapshot(3000);
  assert.equal(afterCandidate.cadenceSpm, 100);
  assert.equal(afterCandidate.avgCadenceSpm, 100);
});

test('跑后平均步频由全部 accepted-step 有效间隔累计，停步后仍保留', () => {
  const metrics = new MotionMetrics({ startMs: 0, stepLengthM: 0.7 });
  for (const timestampMs of [1000, 1600, 2200, 2800]) {
    metrics.onAcceptedStep(timestampMs, 200);
  }
  assert.equal(metrics.snapshot(2800).avgCadenceSpm, 100);
  assert.equal(metrics.snapshot(30000).avgCadenceSpm, 100,
    '当前步频过期不应抹掉本场真实平均步频');

  metrics.onAcceptedStep(30000, 200);
  assert.equal(metrics.snapshot(30000).avgCadenceSpm, 100,
    '停步长空档只重锚，不能摊薄跑后平均步频');
});

test('不足三个 accepted-step 间隔时不伪造跑后平均步频', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  metrics.onAcceptedStep(1000, 120);
  metrics.onAcceptedStep(1500, 120);
  metrics.onAcceptedStep(2000, 120);
  assert.equal(metrics.snapshot(2000).avgCadenceSpm, null);
});

test('标准 RSC 正步频可独立提供跑后平均值', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  metrics.onRscMeasurement({ speedMps: 2, cadenceSpm: 166 }, 1000);
  metrics.onRscMeasurement({ speedMps: 2, cadenceSpm: 170 }, 2000);
  assert.equal(metrics.snapshot(2000).avgCadenceSpm, 168);
});

test('暂停期 RSC 不进入跑后平均步频', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  metrics.onRscMeasurement({ speedMps: 1, cadenceSpm: 100 }, 1000);
  metrics.pause(1500);
  for (let timestampMs = 1600; timestampMs <= 2600; timestampMs += 100) {
    metrics.onRscMeasurement({ speedMps: 2, cadenceSpm: 200 }, timestampMs);
  }
  assert.equal(metrics.snapshot(2600).avgCadenceSpm, 100);
});

test('暂停恢复后的第一步只重建锚点，不把暂停墙钟计入平均步频', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  for (const timestampMs of [1000, 1600, 2200, 2800]) {
    metrics.onAcceptedStep(timestampMs, 100);
  }
  assert.equal(metrics.snapshot(2800).avgCadenceSpm, 100);
  metrics.pause(3000);
  metrics.resume(3500);
  metrics.onAcceptedStep(4100, 100);
  metrics.onAcceptedStep(4700, 100);
  assert.equal(metrics.snapshot(4700).avgCadenceSpm, 100);
});

test('MotionMetrics 稳健窗口抵抗少量二次谐波，不把稳定 90spm 短时翻倍', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  let timestampMs = 1000;
  metrics.onAcceptedStep(timestampMs, 180);
  for (let index = 0; index < 8; index += 1) {
    timestampMs += 667;
    metrics.onAcceptedStep(timestampMs, 180);
  }
  assert.equal(metrics.snapshot(timestampMs).cadenceSpm, 90);

  for (let index = 0; index < 4; index += 1) {
    timestampMs += 333;
    metrics.onAcceptedStep(timestampMs, 180);
  }
  const snapshot = metrics.snapshot(timestampMs);
  assert.equal(snapshot.cadenceReady, true);
  assert.ok(snapshot.cadenceSpm >= 85 && snapshot.cadenceSpm < 170,
    `少量二次谐波不应把 HUD 步频翻倍，实际为 ${snapshot.cadenceSpm}`);
});

test('滚动配速不足 8 秒不显示；停步满一个窗口后归空', () => {
  const metrics = new MotionMetrics({ startMs: 0, stepLengthM: 1 });
  for (let second = 1; second <= 10; second += 1) {
    metrics.onAcceptedStep(second * 1000);
    if (second === 7) assert.equal(metrics.rollingPaceSecPerKm(7000), null);
  }
  assertNear(metrics.rollingPaceSecPerKm(10000), 1000);
  assert.equal(metrics.rollingPaceSecPerKm(20000), null);
});

test('纯 IMU 首步距离与首个步间隔成对：10/20/100 步总配速均不随长度偏快', () => {
  for (const stepCount of [10, 20, 100]) {
    const metrics = new MotionMetrics({ startMs: 0, stepLengthM: 1 });
    for (let second = 1; second <= stepCount; second += 1) {
      metrics.onAcceptedStep(second * 1000);
    }
    const snapshot = metrics.snapshot(stepCount * 1000);
    assert.equal(snapshot.steps, stepCount);
    assert.equal(snapshot.distanceM, stepCount);
    assertNear(
      snapshot.avgPaceSecPerKm,
      1000,
      1e-6,
      `${stepCount} 步都应按 ${stepCount}m/${stepCount}s 计算`,
    );
    assertNear(snapshot.paceSecPerKm, 1000);
  }
});

test('停步后滚动配速归空，但估算总配速冻结且不会随等待时间变慢', () => {
  const metrics = new MotionMetrics({ startMs: 0, stepLengthM: 1 });
  for (let second = 1; second <= 10; second += 1) {
    metrics.onAcceptedStep(second * 1000);
  }

  const atStop = metrics.snapshot(10000);
  assertNear(atStop.avgPaceSecPerKm, 1000);
  const afterOneMinute = metrics.snapshot(70000);
  assert.equal(afterOneMinute.paceSecPerKm, null, '停步后不冒充实时滚动配速');
  assertNear(afterOneMinute.avgPaceSecPerKm, 1000);
  const afterTenMinutes = metrics.snapshot(610000);
  assertNear(
    afterTenMinutes.avgPaceSecPerKm,
    atStop.avgPaceSecPerKm,
    1e-6,
    '最终静止等待不应继续拖慢估算总配速',
  );
});

test('晚起跑不把准备等待算入估算总配速，异常慢值不直接上屏', () => {
  const metrics = new MotionMetrics({ startMs: 0, stepLengthM: 1 });
  for (let second = 10; second <= 19; second += 1) {
    metrics.onAcceptedStep(second * 1000);
  }
  assertNear(metrics.snapshot(19000).avgPaceSecPerKm, 1000);
  assertNear(metrics.snapshot(90000).avgPaceSecPerKm, 1000);
  assert.equal(metrics.movementStartActiveMs, 9000,
    '晚起跑只回锚一个真实步间隔，不吞入开跑前等待');

  const implausiblySlow = new MotionMetrics({ startMs: 0, stepLengthM: 1 });
  implausiblySlow.onAcceptedStep(10000);
  for (let step = 2; step <= 10; step += 1) {
    implausiblySlow.onAcceptedStep(10000 + step * 3000);
  }
  assert.equal(
    implausiblySlow.snapshot(40000).avgPaceSecPerKm,
    null,
    '超过 30:00/km 的稀疏证据不应被包装成可信总配速',
  );
});

test('估算总配速不在页面启动 3 秒处出现计算断崖', () => {
  const estimateFrom = (firstStepMs) => {
    const metrics = new MotionMetrics({ startMs: 0, stepLengthM: 1 });
    for (let step = 0; step < 10; step += 1) {
      metrics.onAcceptedStep(firstStepMs + step * 1000);
    }
    return metrics.snapshot(firstStepMs + 9000).avgPaceSecPerKm;
  };

  assertNear(estimateFrom(3000), 1000);
  assertNear(estimateFrom(3001), 1000);
});

test('纯 IMU 首步回锚不得跨写已接管的 RSC/GPS 运动起点', () => {
  const rscMixed = new MotionMetrics({ startMs: 0, stepLengthM: 1 });
  rscMixed.onAcceptedStep(1000);
  assert.equal(rscMixed.movementStartActiveMs, 1000);
  rscMixed.onRscMeasurement({ speedMps: 2, cadenceSpm: 180 }, 1500);
  rscMixed.onAcceptedStep(2000); // RSC 新鲜：只计步，不重复计距
  rscMixed.onRscDisconnected(2100);
  rscMixed.onAcceptedStep(2500);
  assert.equal(rscMixed.movementStartActiveMs, 1000,
    'RSC 正运动已经接管后，后到 IMU 间隔不得回写全程起点');

  const gpsMixed = new MotionMetrics({ startMs: 0, stepLengthM: 1 });
  gpsMixed.onAcceptedStep(1000);
  gpsMixed.onGpsPathMeasurement({
    totalDistanceM: 0,
    deltaDistanceM: 0,
    live: false,
  }, 1200);
  gpsMixed.onGpsPathMeasurement({
    totalDistanceM: 3,
    deltaDistanceM: 3,
    live: true,
  }, 2200);
  gpsMixed.onGpsDisconnected(2300);
  gpsMixed.onAcceptedStep(2700);
  gpsMixed.onAcceptedStep(3200);
  assert.equal(gpsMixed.movementStartActiveMs, 1000,
    'GPS 正线段已经接管后，IMU 恢复不能重新回锚全程起点');
});

test('RSC 正速度停下后估算总配速冻结，长时间等待不继续变慢', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  for (let second = 0; second <= 10; second += 1) {
    metrics.onRscMeasurement({
      speedMps: 3,
      cadenceSpm: 180,
      totalDistanceM: null,
    }, second * 1000);
  }
  metrics.onRscMeasurement({
    speedMps: 0,
    cadenceSpm: 0,
    totalDistanceM: null,
  }, 11000);

  const atStop = metrics.snapshot(12000);
  assert.ok(Number.isFinite(atStop.avgPaceSecPerKm));
  assert.equal(atStop.paceSecPerKm, null);
  assertNear(
    metrics.snapshot(10 * 60 * 1000).avgPaceSecPerKm,
    atStop.avgPaceSecPerKm,
    1e-6,
  );
});

test('RSC 速度新鲜时优先：IMU 仍计步但不会重复累距', () => {
  const metrics = new MotionMetrics({ startMs: 0, stepLengthM: 1 });
  for (let second = 0; second <= 10; second += 1) {
    const now = second * 1000;
    if (second > 0) metrics.onAcceptedStep(now - 100);
    metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, now);
  }

  const snapshot = metrics.snapshot(10000);
  assert.equal(snapshot.steps, 10);
  assertNear(snapshot.distanceM, 30, 1e-6);
  assertNear(snapshot.paceSecPerKm, 1000 / 3, 0.5);
  assert.equal(snapshot.distanceSource, MOTION_SOURCE.RSC_SPEED);
  assert.equal(snapshot.paceSource, MOTION_SOURCE.RSC_SPEED);
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.RSC);
});

test('RSC 累计距离优先于速度积分，并以首包为基线', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  metrics.onRscMeasurement({
    speedMps: 3,
    cadenceSpm: 178,
    strideLengthM: 1.12,
    totalDistanceM: 1000,
  }, 0);
  for (let second = 1; second <= 10; second += 1) {
    metrics.onRscMeasurement({
      speedMps: 3,
      cadenceSpm: 178,
      totalDistanceM: 1000 + second * 3,
    }, second * 1000);
  }

  const snapshot = metrics.snapshot(10000);
  assertNear(snapshot.distanceM, 30);
  assertNear(snapshot.paceSecPerKm, 1000 / 3);
  assert.equal(snapshot.distanceSource, MOTION_SOURCE.RSC_TOTAL_DISTANCE);
  assert.equal(snapshot.paceSource, MOTION_SOURCE.RSC_TOTAL_DISTANCE);
  assert.equal(snapshot.rscStrideLengthM, 1.12);
});

test('RSC 累计距离冻结两包后回退速度积分，恢复累计值首包只重锚', () => {
  const metrics = new MotionMetrics({
    startMs: 0,
    rscTotalStallSamples: 2,
  });
  metrics.onRscMeasurement({
    speedMps: 3,
    cadenceSpm: 180,
    totalDistanceM: 100,
  }, 0);
  metrics.onRscMeasurement({
    speedMps: 3,
    cadenceSpm: 180,
    totalDistanceM: 103,
  }, 1000);

  const firstFrozen = metrics.onRscMeasurement({
    speedMps: 3,
    cadenceSpm: 180,
    totalDistanceM: 103,
  }, 2000);
  assert.equal(firstFrozen.distanceAddedM, 0);

  const fallback = metrics.onRscMeasurement({
    speedMps: 3,
    cadenceSpm: 180,
    totalDistanceM: 103,
  }, 3000);
  assertNear(fallback.distanceAddedM, 6);
  assert.equal(fallback.distanceSource, MOTION_SOURCE.RSC_SPEED);
  assertNear(metrics.distanceM, 9);
  assert.equal(
    metrics.snapshot(3000).activeMotionSource,
    MOTION_SOURCE.RSC_SPEED,
  );

  const continuedFallback = metrics.onRscMeasurement({
    speedMps: 3,
    cadenceSpm: 180,
    totalDistanceM: 103,
  }, 4000);
  assertNear(continuedFallback.distanceAddedM, 3);
  assertNear(metrics.distanceM, 12);

  const recoveredBaseline = metrics.onRscMeasurement({
    speedMps: 3,
    cadenceSpm: 180,
    totalDistanceM: 112,
  }, 5000);
  assert.equal(recoveredBaseline.distanceAddedM, 0);
  assertNear(metrics.distanceM, 12, 1e-6, '恢复累计值不得补算速度已经覆盖的区间');

  const recoveredDelta = metrics.onRscMeasurement({
    speedMps: 3,
    cadenceSpm: 180,
    totalDistanceM: 115,
  }, 6000);
  assertNear(recoveredDelta.distanceAddedM, 3);
  assert.equal(recoveredDelta.distanceSource, MOTION_SOURCE.RSC_TOTAL_DISTANCE);
  assertNear(metrics.distanceM, 15);
});

test('稳健速度过滤：单个 RSC 尖峰被拒绝，下一帧可沿可信速度恢复积分', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 0);
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 1000);
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 2000);
  const spike = metrics.onRscMeasurement({ speedMps: 6.5, cadenceSpm: 180 }, 3000);
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 4000);

  assert.equal(spike.speedAccepted, false);
  assert.equal(spike.outlierRejected, true);
  assert.equal(metrics.rejectedRscSpeedSamples, 1);
  assertNear(metrics.distanceM, 12);
  assertNear(metrics.filteredRscSpeedMps, 3);
});

test('稳健速度过滤：连续同方向异常在 3 个一致样本后确认为真实加速并重锚', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 0);
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 1000);
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 2000);

  const first = metrics.onRscMeasurement({ speedMps: 5.5, cadenceSpm: 180 }, 2500);
  const second = metrics.onRscMeasurement({ speedMps: 6, cadenceSpm: 180 }, 3000);
  const third = metrics.onRscMeasurement({ speedMps: 6.5, cadenceSpm: 180 }, 3500);

  assert.equal(first.speedAccepted, false);
  assert.equal(second.speedAccepted, false);
  assert.equal(third.speedAccepted, true);
  assert.equal(third.outlierRejected, false);
  assert.equal(metrics.rejectedRscSpeedSamples, 2);
  assertNear(metrics.filteredRscSpeedMps, 6, 1e-6, '以连续候选中位数重锚');

  const before = metrics.distanceM;
  metrics.onRscMeasurement({ speedMps: 6.2, cadenceSpm: 180 }, 4500);
  assert.ok(metrics.distanceM > before, '重锚后持续高速样本正常积分，不会永久拒绝');
});

test('RSC 速度积分绝不跨越 freshMs：2.5–3.0s 回包只重锚，不补幽灵距离', () => {
  const metrics = new MotionMetrics({
    startMs: 0,
    rscFreshMs: 2500,
    rscIntegrationGapMs: 3000,
  });
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 0);
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 2700);
  assert.equal(metrics.distanceM, 0, '2700ms 已超过新鲜度，只允许建立新锚点');

  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 3700);
  assertNear(metrics.distanceM, 3, 1e-6, '新锚后的 1 秒可以正常积分');
});

test('EMA 平滑正常速度变化，但 0 速度立即生效，不拖出尾巴距离', () => {
  const metrics = new MotionMetrics({ startMs: 0, speedEmaAlpha: 0.5 });
  metrics.onRscMeasurement({ speedMps: 2, cadenceSpm: 160 }, 0);
  metrics.onRscMeasurement({ speedMps: 4, cadenceSpm: 170 }, 1000);
  assertNear(metrics.filteredRscSpeedMps, 3);
  metrics.onRscMeasurement({ speedMps: 0, cadenceSpm: 0 }, 2000);
  assert.equal(metrics.filteredRscSpeedMps, 0);
  assertNear(metrics.distanceM, 4); // (2+3)/2 + (3+0)/2
  metrics.onRscMeasurement({ speedMps: 0, cadenceSpm: 0 }, 3000);
  assertNear(metrics.distanceM, 4, 1e-6, '停下后的后续 0 速度不产生尾巴距离');
});

test('RSC 连续跑满窗口后上报 0 速度，配速立即清空而不是等待窗口衰减', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  for (let second = 0; second <= 10; second += 1) {
    metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, second * 1000);
  }
  assertNear(metrics.snapshot(10000).paceSecPerKm, 1000 / 3);
  const beforeStop = metrics.distanceM;
  metrics.onRscMeasurement({ speedMps: 0, cadenceSpm: 0 }, 11000);
  assert.equal(metrics.snapshot(11000).paceSecPerKm, null);
  metrics.onRscMeasurement({ speedMps: 0, cadenceSpm: 0 }, 12000);
  assert.equal(metrics.distanceM, beforeStop + 1.5, '只保留从 3m/s 到 0 的一次梯形减速距离');
});

test('RSC 正速度首包立即提供即时配速，但滚动配速仍等待完整时间窗口', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 0);

  let snapshot = metrics.snapshot(100);
  assert.equal(snapshot.paceSecPerKm, null, '滚动配速仍需至少 8 秒证据');
  assertNear(snapshot.instantPaceSecPerKm, 1000 / 3);
  assertNear(snapshot.rscInstantPaceSecPerKm, 1000 / 3);
  assert.equal(snapshot.instantPaceSource, MOTION_SOURCE.RSC_SPEED);
  assert.equal(snapshot.rscPaceReady, true);
  assert.equal(snapshot.rscPaceLive, true);
  assert.equal(snapshot.rscPaceSource, MOTION_SOURCE.RSC_SPEED);

  metrics.onRscMeasurement({ speedMps: 0, cadenceSpm: 0 }, 200);
  snapshot = metrics.snapshot(200);
  assert.equal(snapshot.rscPaceReady, true, '已验证设备能力在本次连接内保留');
  assert.equal(snapshot.rscPaceLive, false, '明确停步不能继续显示旧即时配速');
  assert.equal(snapshot.instantPaceSecPerKm, null);
});

test('RSC 配速接入必须等到正速度或累计距离正增量，订阅/零值/距离基线均不点亮', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  metrics.onRscMeasurement({ speedMps: 0, cadenceSpm: 0, totalDistanceM: 100 }, 0);
  let snapshot = metrics.snapshot(0);
  assert.equal(snapshot.rscConnected, true);
  assert.equal(snapshot.rscPaceReady, false);
  assert.equal(snapshot.rscPaceLive, false);

  metrics.onRscMeasurement({ speedMps: 0, cadenceSpm: 0, totalDistanceM: 101 }, 1000);
  snapshot = metrics.snapshot(1000);
  assert.equal(snapshot.rscPaceReady, true);
  assert.equal(snapshot.rscPaceLive, true);
  assert.equal(snapshot.rscPaceSource, MOTION_SOURCE.RSC_TOTAL_DISTANCE);
  assertNear(snapshot.rscInstantPaceSecPerKm, 1000);
  assertNear(snapshot.instantPaceSecPerKm, 1000);

  metrics.onRscDisconnected(1100);
  snapshot = metrics.snapshot(1100);
  assert.equal(snapshot.rscPaceReady, false, 'GATT 断开后等待新连接再次提供正向证据');
  assert.equal(snapshot.rscPaceLive, false);
});

test('RSC 断流后 IMU 立即补位；累计距离恢复时先重锚，避免重复补距', () => {
  const metrics = new MotionMetrics({ startMs: 0, stepLengthM: 1 });
  metrics.onRscMeasurement({ speedMps: 2, cadenceSpm: 170, totalDistanceM: 100 }, 0);
  metrics.onRscMeasurement({ speedMps: 2, cadenceSpm: 170, totalDistanceM: 102 }, 1000);
  assert.equal(metrics.distanceM, 2);

  metrics.onRscDisconnected(1100);
  metrics.onAcceptedStep(1200);
  metrics.onAcceptedStep(1700);
  assert.equal(metrics.distanceM, 4);

  // 恢复首包中的 5m 增量可能包含 IMU 已补的距离，只重锚不重复增加。
  metrics.onRscMeasurement({ speedMps: 2, cadenceSpm: 170, totalDistanceM: 107 }, 2000);
  assert.equal(metrics.distanceM, 4);
  metrics.onRscMeasurement({ speedMps: 2, cadenceSpm: 170, totalDistanceM: 109 }, 3000);
  assert.equal(metrics.distanceM, 6);
});

test('RSC 自然超时后 IMU 接管；RSC 回来时不跨断流时间做速度积分', () => {
  const metrics = new MotionMetrics({ startMs: 0, stepLengthM: 1, rscFreshMs: 2000 });
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 0);
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 1000);
  metrics.onAcceptedStep(2000); // RSC 仍新鲜，忽略距离
  metrics.onAcceptedStep(4000); // 已超时，IMU 加 1m
  const beforeReconnect = metrics.distanceM;
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 8000);
  assert.equal(metrics.distanceM, beforeReconnect, '恢复首帧只建速度锚点');
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 9000);
  assertNear(metrics.distanceM, beforeReconnect + 3);
});

test('GPS 路径位于 RSC 与 IMU 之间：接入后抑制 IMU 重复距离，断流后立即回退', () => {
  const metrics = new MotionMetrics({
    startMs: 0,
    stepLengthM: 1,
    gpsFreshMs: 2500,
  });

  metrics.onAcceptedStep(500);
  const baseline = metrics.onGpsPathMeasurement({
    totalDistanceM: 0,
    deltaDistanceM: 0,
    accuracyM: 6,
    live: false,
  }, 1000);
  assert.equal(baseline.reanchored, true);

  // 第一段和已经由 IMU 记录的运动区间可能重叠，只重锚；它同时证明 GPS 已活跃。
  const firstSegment = metrics.onGpsPathMeasurement({
    totalDistanceM: 3,
    deltaDistanceM: 3,
    accuracyM: 6,
    live: true,
  }, 2000);
  assert.equal(firstSegment.distanceAddedM, 3);
  assert.equal(metrics.snapshot(2000).activeMotionSource, MOTION_SOURCE.GPS_PATH);

  metrics.onAcceptedStep(2300);
  assert.equal(metrics.distanceM, 4, 'GPS 新鲜时步数继续累计，但不重复加 IMU 距离');

  metrics.onGpsPathMeasurement({
    totalDistanceM: 6,
    deltaDistanceM: 3,
    accuracyM: 5,
    live: true,
  }, 3000);
  assert.equal(metrics.distanceM, 7);
  assert.equal(metrics.snapshot(3000).gpsFresh, true);
  assert.equal(metrics.snapshot(3000).gpsAccuracyM, 5);

  metrics.onGpsDisconnected(3100);
  metrics.onAcceptedStep(3500);
  assert.equal(metrics.distanceM, 8, 'GPS 停止后下一步立即由 IMU 兜底');
  assert.equal(metrics.snapshot(3500).activeMotionSource, MOTION_SOURCE.IMU_STEP);

  metrics.onGpsPathMeasurement({
    totalDistanceM: 9,
    deltaDistanceM: 3,
    accuracyM: 5,
    live: true,
  }, 4000);
  assert.equal(metrics.distanceM, 8, 'GPS 恢复首段可能覆盖 IMU 已补距离，只重锚');
  metrics.onGpsPathMeasurement({
    totalDistanceM: 12,
    deltaDistanceM: 3,
    accuracyM: 5,
    live: true,
  }, 5000);
  assert.equal(metrics.distanceM, 11);
});

test('GPS-only 首个正线段把段起点计入总配速，不因漏掉首段时间而偏快', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  metrics.onGpsPathMeasurement({
    totalDistanceM: 0,
    deltaDistanceM: 0,
    live: false,
  }, 1000);

  for (let second = 2; second <= 10; second += 1) {
    metrics.onGpsPathMeasurement({
      totalDistanceM: (second - 1) * 3,
      deltaDistanceM: 3,
      live: true,
    }, second * 1000);
  }

  const snapshot = metrics.snapshot(10000);
  assert.equal(snapshot.distanceM, 27);
  assertNear(snapshot.avgPaceSecPerKm, 1000 / 3);
});

test('RSC 永远优先于 GPS；RSC 断流后 GPS 首段重锚再接管', () => {
  const metrics = new MotionMetrics({ startMs: 0, gpsFreshMs: 5000 });
  metrics.onGpsPathMeasurement({
    totalDistanceM: 0,
    deltaDistanceM: 0,
    accuracyM: 8,
    live: false,
  }, 0);
  metrics.onGpsPathMeasurement({
    totalDistanceM: 3,
    deltaDistanceM: 3,
    accuracyM: 8,
    live: true,
  }, 1000);
  assert.equal(metrics.distanceM, 3);

  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 1500);
  metrics.onGpsPathMeasurement({
    totalDistanceM: 6,
    deltaDistanceM: 3,
    accuracyM: 8,
    live: true,
  }, 2000);
  assert.equal(metrics.distanceM, 3, 'RSC 新鲜时 GPS 只更新基线');
  assert.equal(metrics.snapshot(2000).activeMotionSource, MOTION_SOURCE.RSC_SPEED);

  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 2500);
  assertNear(metrics.distanceM, 6);
  metrics.onRscDisconnected(2600);
  metrics.onGpsPathMeasurement({
    totalDistanceM: 9,
    deltaDistanceM: 3,
    accuracyM: 7,
    live: true,
  }, 3000);
  assertNear(metrics.distanceM, 6, 1e-6, 'RSC→GPS 的第一段只重锚');
  metrics.onGpsPathMeasurement({
    totalDistanceM: 12,
    deltaDistanceM: 3,
    accuracyM: 7,
    live: true,
  }, 4000);
  assertNear(metrics.distanceM, 9);
  assert.equal(metrics.snapshot(4000).activeMotionSource, MOTION_SOURCE.GPS_PATH);
});

test('GPS 暂停/恢复与累计值异常都只重建基线，不跨空档制造距离', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  metrics.onGpsPathMeasurement({
    totalDistanceM: 0,
    deltaDistanceM: 0,
    live: false,
  }, 0);
  metrics.onGpsPathMeasurement({
    totalDistanceM: 3,
    deltaDistanceM: 3,
    live: true,
  }, 1000);
  assert.equal(metrics.distanceM, 3);

  metrics.pause(1500);
  metrics.onGpsPathMeasurement({
    totalDistanceM: 30,
    deltaDistanceM: 27,
    live: true,
  }, 5000);
  metrics.resume(10000);
  metrics.onGpsPathMeasurement({
    totalDistanceM: 33,
    deltaDistanceM: 3,
    live: true,
  }, 11000);
  assert.equal(metrics.distanceM, 3);
  metrics.onGpsPathMeasurement({
    totalDistanceM: 36,
    deltaDistanceM: 3,
    live: true,
  }, 12000);
  assert.equal(metrics.distanceM, 6);

  metrics.onGpsPathMeasurement({
    totalDistanceM: 500,
    deltaDistanceM: 464,
    live: true,
  }, 13000);
  assert.equal(metrics.distanceM, 6, '异常累计跳变不能写入距离');
});

test('暂停/恢复：暂停段不计时、不计步、不跨暂停积分', () => {
  const metrics = new MotionMetrics({ startMs: 0, stepLengthM: 1 });
  for (let second = 1; second <= 5; second += 1) metrics.onAcceptedStep(second * 1000);
  metrics.pause(5000);
  assert.equal(metrics.onAcceptedStep(8000), false);
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 9000);
  metrics.resume(15000);
  for (let second = 16; second <= 20; second += 1) metrics.onAcceptedStep(second * 1000);

  const snapshot = metrics.snapshot(20000);
  assert.equal(snapshot.elapsedMs, 10000);
  assert.equal(snapshot.steps, 10);
  assert.equal(snapshot.distanceM, 10);
  assertNear(snapshot.paceSecPerKm, 1000);
  assert.equal(snapshot.paused, false);
});

test('恢复会清除暂停前/暂停中 RSC 新鲜度：首个 IMU step 补距，新 RSC 包才重新生效', () => {
  const metrics = new MotionMetrics({ startMs: 0, stepLengthM: 1 });
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 900);
  metrics.pause(1000);
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 9900);
  metrics.resume(10000);
  let snapshot = metrics.snapshot(10000);
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.NONE,
    '快速恢复也不显示暂停前的 IMU/RSC 步频');

  const latePausedPacket = metrics.onRscMeasurement(
    { speedMps: 3, cadenceSpm: 180 },
    9950,
  );
  assert.equal(latePausedPacket.accepted, false,
    '恢复后迟到的暂停期旧包不能重新点亮 RSC freshness');

  assert.equal(metrics.onAcceptedStep(10100), true);
  assert.equal(metrics.distanceM, 1,
    '暂停中刚收到的 RSC 不得压掉恢复后的首个 IMU 落步');
  snapshot = metrics.snapshot(10100);
  assert.equal(snapshot.rscFresh, false);
  assert.equal(snapshot.activeMotionSource, MOTION_SOURCE.IMU_STEP);

  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 10200);
  snapshot = metrics.snapshot(10200);
  assert.equal(snapshot.rscFresh, true);
  assert.equal(snapshot.cadenceSpm, 180);
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.RSC);
  metrics.onAcceptedStep(10300);
  assert.equal(metrics.distanceM, 1, '恢复后的新 RSC 包重新生效，后续 IMU 不重复累距');
});

test('RSC 累计距离负跳变重建基线，巨大正跳变被忽略且不污染后续', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180, totalDistanceM: 100 }, 0);
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180, totalDistanceM: 103 }, 1000);
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180, totalDistanceM: 999 }, 2000);
  assert.equal(metrics.distanceM, 3, '巨大正跳变不累加');
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180, totalDistanceM: 106 }, 3000);
  assert.equal(metrics.distanceM, 6, '从最后可信基线恢复');

  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180, totalDistanceM: 10 }, 4000);
  assert.equal(metrics.distanceM, 6, '设备距离重置不产生负距');
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180, totalDistanceM: 13 }, 5000);
  assert.equal(metrics.distanceM, 9);
});

test('RSC 累计距离持续正偏移只重锚，不会等待阈值变大后吞入整段跳变', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180, totalDistanceM: 100 }, 0);
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180, totalDistanceM: 103 }, 1000);
  assert.equal(metrics.distanceM, 3);

  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180, totalDistanceM: 1000 }, 2000);
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180, totalDistanceM: 1003 }, 3000);
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180, totalDistanceM: 1006 }, 4000);
  assert.equal(metrics.distanceM, 3, '第三个持续异常包只建立新基线');

  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180, totalDistanceM: 1009 }, 5000);
  assert.equal(metrics.distanceM, 6, '新基线后的正常增量继续计入');
});

test('步频来源：新鲜 RSC 优先，RSC 过期后由眼镜 IMU 兜底', () => {
  const metrics = new MotionMetrics({ startMs: 0, stepLengthM: 1 });
  metrics.onAcceptedStep(1000);
  metrics.onAcceptedStep(1500); // 120 spm
  metrics.onRscMeasurement({ speedMps: 2, cadenceSpm: 180 }, 1600);
  let snapshot = metrics.snapshot(1700);
  assert.equal(snapshot.cadenceSpm, 180);
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.RSC);
  assert.equal(snapshot.cadenceReady, true);

  metrics.onImuCadence(124, 4200);
  snapshot = metrics.snapshot(4201);
  assert.equal(snapshot.cadenceSpm, 124, 'RSC 过期后恢复使用眼镜 IMU');
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.IMU);
  assert.equal(snapshot.cadenceReady, true);
});

test('IMU cadence=0：未形成节奏时不遮蔽 RSC', () => {
  const waiting = new MotionMetrics({ startMs: 0 });
  waiting.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 0);
  assert.equal(waiting.onImuCadence(0, 100), false,
    '尚未形成有效节奏的 0 只是未就绪，不标记 IMU ready');
  const snapshot = waiting.snapshot(100);
  assert.equal(snapshot.cadenceSpm, 180);
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.RSC);
});

test('IMU 已形成 90spm 后，落步间的 0 空帧保持数值；超过停步阈值才归零并撤销 ready', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  for (const timestampMs of [1000, 1667, 2333, 3000]) {
    metrics.onAcceptedStep(timestampMs, 180);
  }
  let snapshot = metrics.snapshot(3000);
  assert.equal(snapshot.cadenceSpm, 90);
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.IMU);
  assert.equal(snapshot.cadenceReady, true);

  metrics.onImuCadence(0, 3200);
  snapshot = metrics.snapshot(3200);
  assert.equal(snapshot.cadenceSpm, 90,
    '两次真实落步之间的检测器 0 只是瞬时空帧，不能把 HUD 清零');
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.IMU);
  assert.equal(snapshot.cadenceReady, true);

  metrics.onImuCadence(0, 4601);
  snapshot = metrics.snapshot(4601);
  assert.equal(snapshot.cadenceSpm, 0);
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.NONE);
  assert.equal(snapshot.cadenceReady, false,
    '超过停步阈值后必须撤销 ready，HUD 才能从数值切换为停步符号');
});

test('IMU 已归零但新鲜 RSC 仍有正步频时，RSC 防止传感器静默造成假停步', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  metrics.onImuCadence(172, 0);
  metrics.onImuCadence(0, 100);
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 100);

  const snapshot = metrics.snapshot(150);
  assert.equal(snapshot.cadenceSpm, 180);
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.RSC);
});

test('RSC 单包速度为正但 cadence=0 时不误清步频，真实停步包才归零', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  metrics.onImuCadence(172, 0);
  const contradictory = metrics.onRscMeasurement(
    { speedMps: 3, cadenceSpm: 0 },
    100,
  );
  let snapshot = metrics.snapshot(150);
  assert.equal(snapshot.cadenceSpm, 172);
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.IMU);
  assert.equal(contradictory.speedAccepted, false,
    '正速度配零步频是矛盾尾包，不能点亮设备配速');
  assert.equal(contradictory.incoherentSpeed, true);
  assert.equal(snapshot.rscPaceLive, false);
  assert.equal(snapshot.rscInstantPaceSecPerKm, null);
  assert.notEqual(snapshot.activeMotionSource, MOTION_SOURCE.RSC_SPEED);

  metrics.onRscMeasurement({ speedMps: 0, cadenceSpm: 0 }, 200);
  snapshot = metrics.snapshot(250);
  assert.equal(snapshot.cadenceSpm, 0);
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.RSC);
});

test('RSC 持续 0 速正步频没有运动证据时不刷新 freshness 或跑后平均', () => {
  const metrics = new MotionMetrics({ startMs: 0 });
  metrics.onRscMeasurement({ speedMps: 2, cadenceSpm: 113 }, 0);
  assert.equal(metrics.snapshot(0).cadenceSpm, 113);

  for (const [timestampMs, speedMps] of [
    [1000, 0], [2000, 0], [3000, 0], [4000, 0.01],
  ]) {
    const result = metrics.onRscMeasurement(
      { speedMps, cadenceSpm: 113 },
      timestampMs,
    );
    assert.equal(result.accepted, true, '包仍用于确认 RSC 链路存活');
  }

  const snapshot = metrics.snapshot(4000);
  assert.equal(snapshot.rscConnected, true);
  assert.equal(snapshot.cadenceReady, false,
    '0–0.1m/s 停步抖动尾值不得把旧 113spm 无限续鲜');
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.NONE);
  assert.equal(snapshot.avgCadenceSpm, 113,
    '被拒的尾值不得继续污染跑后平均，只保留首个真实运动样本');
});

test('RSC 0 速正步频仅在可信累计距离增量或 1.5s 内 IMU 落步时有效', () => {
  const withTotal = new MotionMetrics({ startMs: 0 });
  withTotal.onRscMeasurement({
    speedMps: 0, cadenceSpm: 0, totalDistanceM: 100,
  }, 0);
  withTotal.onRscMeasurement({
    speedMps: 0, cadenceSpm: 113, totalDistanceM: 101,
  }, 1000);
  let snapshot = withTotal.snapshot(1000);
  assert.equal(snapshot.cadenceSpm, 113,
    '通过现有跳变上限的累计距离正增量可以证明正在运动');
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.RSC);

  const withImu = new MotionMetrics({ startMs: 0 });
  withImu.onAcceptedStep(1000);
  withImu.onRscMeasurement({ speedMps: 0, cadenceSpm: 113 }, 2500);
  snapshot = withImu.snapshot(2500);
  assert.equal(snapshot.cadenceSpm, 113, '1.5s 边界内的 IMU 落步允许 RSC cadence');
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.RSC);

  withImu.onRscMeasurement({ speedMps: 0, cadenceSpm: 119 }, 4001);
  snapshot = withImu.snapshot(4001);
  assert.equal(snapshot.cadenceSpm, 113,
    '超过 1.5s 的旧 IMU 落步不能让新的 0 速尾值续鲜');
  assert.equal(withImu.lastRscCadenceMs, 2500);
});

test('RSC 持续上报 cadence/speed=0 时，新 IMU 落步接管步频与距离', () => {
  const metrics = new MotionMetrics({ startMs: 0, stepLengthM: 1 });
  metrics.onRscMeasurement({ speedMps: 0, cadenceSpm: 0 }, 0);
  let snapshot = metrics.snapshot(50);
  assert.equal(snapshot.cadenceSpm, 0, '没有眼镜运动证据时保留真实静止');
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.RSC);
  assert.equal(snapshot.activeMotionSource, MOTION_SOURCE.NONE);

  metrics.onAcceptedStep(100, 172);
  metrics.onRscMeasurement({ speedMps: 0, cadenceSpm: 0 }, 200);
  metrics.onAcceptedStep(500, 174);
  metrics.onAcceptedStep(900, 174);
  metrics.onAcceptedStep(1300, 174);
  snapshot = metrics.snapshot(1350);
  assert.equal(snapshot.cadenceSpm, 150);
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.IMU);
  assert.equal(snapshot.distanceM, 4, 'RSC 零值不能压住 IMU 已确认落步的距离');
  assert.equal(snapshot.activeMotionSource, MOTION_SOURCE.IMU_STEP);
  assert.equal(snapshot.rscPaceReady, false);

  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, 1400);
  snapshot = metrics.snapshot(1450);
  assert.equal(snapshot.cadenceSpm, 180, '设备恢复正步频后重新取得优先级');
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.RSC);

  metrics.onRscMeasurement({ speedMps: 0, cadenceSpm: 0 }, 1550);
  metrics.onImuCadence(0, 1600);
  snapshot = metrics.snapshot(1600);
  assert.equal(snapshot.cadenceSpm, 0, '眼镜也确认停步后恢复为静止 0');
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.RSC);
});

test('超慢跑 trackDistance=false：保留步数/步频，但不生成水平距离或配速', () => {
  const metrics = new MotionMetrics({
    startMs: 0,
    stepLengthM: 1,
    trackDistance: false,
  });
  for (let second = 1; second <= 10; second += 1) {
    metrics.onAcceptedStep(second * 1000, 180);
    metrics.onRscMeasurement({
      speedMps: 3,
      cadenceSpm: 180,
      totalDistanceM: 100 + second * 3,
    }, second * 1000);
  }

  const snapshot = metrics.snapshot(10000);
  assert.equal(snapshot.steps, 10);
  assert.equal(snapshot.cadenceSpm, 180);
  assert.equal(snapshot.cadenceSource, CADENCE_SOURCE.RSC);
  assert.equal(snapshot.distanceEnabled, false);
  assert.equal(snapshot.distanceM, 0);
  assert.equal(snapshot.paceSecPerKm, null);
  assert.equal(snapshot.avgPaceSecPerKm, null);
  assert.equal(snapshot.distanceSource, MOTION_SOURCE.NONE);
  assert.equal(snapshot.activeMotionSource, MOTION_SOURCE.NONE);
});

test('输入防护：非法配置、乱序步和越界速度不会污染距离', () => {
  assert.throws(() => new MotionMetrics({ paceWindowMs: 7000 }), RangeError);
  assert.throws(() => new MotionMetrics({ stepLengthM: 5 }), RangeError);

  const metrics = new MotionMetrics({ startMs: 1000, stepLengthM: 1 });
  assert.equal(metrics.onAcceptedStep(900), false);
  assert.equal(metrics.onAcceptedStep(1100), true);
  assert.equal(metrics.onAcceptedStep(1100), false);
  const invalid = metrics.onRscMeasurement({ speedMps: 50, cadenceSpm: 999 }, 1200);
  assert.equal(invalid.accepted, false);
  assert.equal(metrics.distanceM, 1);
  assert.equal(metrics.setStepLengthM(0.1), false);
  assert.equal(metrics.setStepLengthM(0.9), true);
});
