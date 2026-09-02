import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SensorTimestampNormalizer, StepDetector } from '../lib/imu.js';

const G = 9.80665;

// 合成一段跑步加速度:合幅值 = G + A·sin(2π f t),每个正弦周期 = 一步。
// 以 sampleHz 采样喂进检测器,返回检测器。
function feedRunning(det, { cadenceSpm, seconds, amplitude = 4, sampleHz = 50, t0 = 0 }) {
  const f = cadenceSpm / 60;                 // 步/秒
  const dt = 1000 / sampleHz;
  const n = Math.round(seconds * sampleHz);
  for (let i = 0; i < n; i++) {
    const tMs = t0 + i * dt;
    const mag = G + amplitude * Math.sin(2 * Math.PI * f * (tMs / 1000));
    // 把幅值放到单轴(z),x/y=0 → sqrt(0+0+z²)=|z|=mag(mag>0 恒成立)
    det.push(0, 0, mag, tMs);
  }
  return t0 + n * dt;
}

function feedHeadRun(det, {
  cadenceSpm,
  seconds,
  amplitude = 0.7,
  sampleHz = 50,
  t0 = 0,
  cadenceAt = null,
  suppressAt = null,
}) {
  const dt = 1000 / sampleHz;
  const n = Math.round(seconds * sampleHz);
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const tMs = t0 + i * dt;
    const currentCadence = cadenceAt ? cadenceAt(tMs, i) : cadenceSpm;
    phase += 2 * Math.PI * (currentCadence / 60) / sampleHz;
    const suppressed = suppressAt ? suppressAt(tMs, i) : false;
    const dynamic = suppressed ? 0 : amplitude * Math.sin(phase);
    const deterministicNoise = 0.08 * Math.sin(i * 12.9898)
      + 0.04 * Math.sin(i * 0.731);
    const slowBias = 0.12 * Math.sin(tMs / 7000);
    const magnitude = G + dynamic + deterministicNoise + slowBias;
    // 缓慢改变重力方向，验证向量模长不会因佩戴角度变化而造步或丢步。
    const pitch = 0.3 * Math.sin(tMs / 5000);
    const roll = 0.25 * Math.cos(tMs / 6000);
    const ux = Math.sin(pitch);
    const uy = Math.sin(roll) * Math.cos(pitch);
    const uz = Math.cos(roll) * Math.cos(pitch);
    det.push(ux * magnitude, uy * magnitude, uz * magnitude, tMs);
  }
  return t0 + n * dt;
}

function feedImpulse(det, tMs, amplitude = 3) {
  det.push(0, 0, G + amplitude, tMs);
  det.push(0, 0, G, tMs + 20);
  det.push(0, 0, G - 0.2, tMs + 40);
}

test('静止(无振动)→ 0 步、步频 0', () => {
  const det = new StepDetector();
  for (let i = 0; i < 250; i++) det.push(0, 0, G, i * 20); // 5s 恒定重力
  assert.equal(det.steps, 0);
  assert.equal(det.cadenceSpm(), 0);
  assert.equal(det.push(0, 0, G, 5020).cadenceReady, false);
});

test('172 spm 跑 20s → 步数≈57、步频≈172', () => {
  const det = new StepDetector();
  const end = feedRunning(det, { cadenceSpm: 172, seconds: 20 });
  // 20s @172spm ≈ 57.3 步,允许起步/收尾各差 2
  assert.ok(det.steps >= 54 && det.steps <= 59, `steps=${det.steps}`);
  const cad = det.cadenceSpm(end);
  assert.ok(cad >= 164 && cad <= 180, `cadence=${cad}`);
  assert.ok(det.isRunning(end), 'isRunning 应为 true');
});

test('较弱的头戴跑动峰值仍能形成稳定步频，普通静止噪声不造步', () => {
  const weakRun = new StepDetector();
  const end = feedHeadRun(weakRun, {
    cadenceSpm: 172,
    seconds: 20,
    amplitude: 0.65,
  });
  assert.ok(weakRun.steps >= 52 && weakRun.steps <= 57, `weak steps=${weakRun.steps}`);
  assert.ok(weakRun.cadenceSpm(end) >= 164 && weakRun.cadenceSpm(end) <= 180);

  const quiet = new StepDetector();
  for (let i = 0; i < 1000; i += 1) {
    const noise = 0.25 * Math.sin(i * 0.37);
    quiet.push(0, 0, G + noise, i * 20);
  }
  assert.equal(quiet.steps, 0);
  assert.equal(quiet.cadenceSpm(), 0);
});

test('走路 110 spm → 识别为「走」(isRunning=false)', () => {
  const det = new StepDetector();
  const end = feedRunning(det, { cadenceSpm: 110, seconds: 15, amplitude: 2.5 });
  const cad = det.cadenceSpm(end);
  assert.ok(cad >= 100 && cad <= 122, `cadence=${cad}`);
  assert.equal(det.isRunning(end), false);
});

test('启动周期确认 + 不应期：孤立峰不计步，100ms 回弹不重复计步', () => {
  const det = new StepDetector({ minStepMs: 260 });
  for (let t = 0; t <= 500; t += 20) det.push(0, 0, G, t);
  feedImpulse(det, 600);
  assert.equal(det.steps, 0, '单次碰触不是跑步证据');
  feedImpulse(det, 950);
  feedImpulse(det, 1050); // 与上一峰只差 100ms，必须忽略。
  feedImpulse(det, 1300);
  assert.equal(det.steps, 1, '第三个一致周期确认节奏，只提交当前一步');
  assert.ok(det.cadenceSpm(1400) >= 164 && det.cadenceSpm(1400) <= 180);
  feedImpulse(det, 1650);
  assert.equal(det.steps, 2);
});

test('短暂漏检保持最近步频，真正停止超过 3.5 秒后归 0', () => {
  const det = new StepDetector();
  const end = feedRunning(det, { cadenceSpm: 172, seconds: 10 });
  assert.ok(det.cadenceSpm(end) > 0, '刚跑完应有步频');
  assert.ok(det.cadenceSpm(end + 3000) > 0, '3 秒弱信号不应立刻把跑动步频打成 0');
  assert.equal(det.cadenceSpm(end + 4000), 0);
});

test('周期一致性抑制非跑步头部碰触，不用三个离散峰拼出假步频', () => {
  const det = new StepDetector();
  for (let t = 0; t <= 500; t += 20) det.push(0, 0, G, t);
  for (const t of [600, 700, 1100, 2000, 2300, 3100]) feedImpulse(det, t);
  assert.equal(det.steps, 0);
  assert.equal(det.cadenceSpm(3200), 0);
});

test('真实变速由连续新周期确认：150spm 平滑切换到 190spm', () => {
  const det = new StepDetector();
  let end = feedHeadRun(det, { cadenceSpm: 150, seconds: 10 });
  assert.ok(det.cadenceSpm(end) >= 145 && det.cadenceSpm(end) <= 155);
  end = feedHeadRun(det, {
    cadenceSpm: 190,
    seconds: 10,
    t0: end,
  });
  assert.ok(det.cadenceSpm(end) >= 184 && det.cadenceSpm(end) <= 196);
  assert.ok(det.steps >= 47 && det.steps <= 54, `transition steps=${det.steps}`);
});

test('单次漏峰不把步频减半，恢复后仍保持约 172spm', () => {
  const baseline = new StepDetector();
  const baselineEnd = feedHeadRun(baseline, { cadenceSpm: 172, seconds: 20 });
  const missed = new StepDetector();
  const missedEnd = feedHeadRun(missed, {
    cadenceSpm: 172,
    seconds: 20,
    suppressAt: (tMs) => tMs >= 7000 && tMs < 7380,
  });
  assert.ok(missed.cadenceSpm(missedEnd) >= 164 && missed.cadenceSpm(missedEnd) <= 180);
  assert.ok(
    baseline.steps - missed.steps >= 0 && baseline.steps - missed.steps <= 2,
    `baseline=${baseline.steps}, missed=${missed.steps}`,
  );
  assert.ok(baseline.cadenceSpm(baselineEnd) >= 164);
});

test('二次谐波不会把走路步频错误翻倍', () => {
  const det = new StepDetector();
  const cadenceSpm = 100;
  const sampleHz = 50;
  let phase = 0;
  for (let i = 0; i < 20 * sampleHz; i += 1) {
    phase += 2 * Math.PI * (cadenceSpm / 60) / sampleHz;
    const dynamic = 0.8 * Math.sin(phase) + 0.72 * Math.sin(2 * phase + 0.3);
    det.push(0, 0, G + dynamic, i * (1000 / sampleHz));
  }
  assert.ok(det.cadenceSpm(20000) >= 96 && det.cadenceSpm(20000) <= 104);
  assert.ok(det.steps >= 28 && det.steps <= 32);
});

test('停步后 evidence-ready 清空，重新起跑需重新确认周期', () => {
  const det = new StepDetector();
  let end = feedHeadRun(det, { cadenceSpm: 172, seconds: 6 });
  const beforeStopSteps = det.steps;
  assert.equal(det.push(0, 0, G, end + 100).cadenceReady, true);
  for (let t = end; t <= end + 3600; t += 20) det.push(0, 0, G, t);
  assert.equal(det.cadenceSpm(end + 3600), 0);
  assert.equal(det.push(0, 0, G, end + 3620).cadenceReady, false);
  end = feedHeadRun(det, {
    cadenceSpm: 172,
    seconds: 5,
    t0: end + 3640,
  });
  assert.ok(det.steps > beforeStopSteps);
  assert.ok(det.cadenceSpm(end) >= 164);
});

test('传感器时间戳归一化兼容 null、重复值以及秒/微秒/纳秒单位', () => {
  const variants = [
    ['null', () => null],
    ['constant', () => 0],
    ['seconds', (ms) => ms / 1000],
    ['milliseconds', (ms) => ms],
    ['microseconds', (ms) => ms * 1000],
    ['nanoseconds', (ms) => ms * 1000000],
  ];
  for (const [name, rawAt] of variants) {
    const clock = new SensorTimestampNormalizer({ frequency: 50 });
    const samples = [];
    for (let i = 0; i < 20; i += 1) {
      samples.push(clock.normalize(rawAt(i * 20), 100000 + i * 20));
    }
    for (let i = 1; i < samples.length; i += 1) {
      const delta = samples[i] - samples[i - 1];
      assert.ok(delta >= 19 && delta <= 21, `${name} delta=${delta}`);
    }
  }
});

test('时间戳倒退不会清累计步数，归一化时间轴保持单调并自动恢复', () => {
  const clock = new SensorTimestampNormalizer({ frequency: 50 });
  const raw = [0, 20, 40, 10, 30, 50];
  const normalized = raw.map((value, index) => (
    clock.normalize(value, 5000 + index * 20)
  ));
  for (let i = 1; i < normalized.length; i += 1) {
    assert.ok(normalized[i] > normalized[i - 1]);
  }
});

test('姿态投影后的垂直动态复用同一套计步与步频账本', () => {
  const det = new StepDetector({ strideM: 0.8 });
  let now = 0;
  for (let index = 0; index < 420; index += 1) {
    now += 20;
    const dynamic = 1.05 * Math.sin(2 * Math.PI * 3 * now / 1000);
    det.pushProjectedDynamic(dynamic, now);
  }
  const cadence = det.cadenceSpm(now);
  assert.ok(det.steps > 8, 'projected vertical signal should establish steps');
  assert.ok(cadence >= 160 && cadence <= 200, `unexpected cadence ${cadence}`);
  assert.equal(det.distanceM(), det.steps * det.strideM);
});

test('估算距离 = 步数 × 步长', () => {
  const det = new StepDetector({ strideM: 0.8 });
  feedRunning(det, { cadenceSpm: 172, seconds: 20 });
  assert.equal(det.distanceM(), det.steps * 0.8);
  assert.ok(det.distanceM() > 0);
});

test('非法输入(NaN/undefined)不崩、不计步', () => {
  const det = new StepDetector();
  const r1 = det.push(NaN, 0, 0, 0);
  const r2 = det.push(0, 0, G, undefined);
  assert.equal(r1.steps, 0);
  assert.equal(r2.steps, 0);
  assert.equal(det.steps, 0);
});

test('reset 清零', () => {
  const det = new StepDetector();
  feedRunning(det, { cadenceSpm: 172, seconds: 5 });
  assert.ok(det.steps > 0);
  det.reset();
  assert.equal(det.steps, 0);
  assert.equal(det.cadenceSpm(), 0);
  assert.equal(det.distanceM(), 0);
});
