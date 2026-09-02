import test from 'node:test';
import assert from 'node:assert/strict';

import { DualStepArbiter } from '../lib/dual_step_detector.js';

function step(cadenceSpm = 170) {
  return { stepped: true, cadenceReady: true, cadenceSpm };
}

function idle(cadenceSpm = 170) {
  return { stepped: false, cadenceReady: cadenceSpm > 0, cadenceSpm };
}

test('正常跑动优先姿态投影通道；两通道同帧只提交一步', () => {
  const arbiter = new DualStepArbiter();
  const result = arbiter.observe({
    timestampMs: 1000,
    projectedResult: step(170),
    magnitudeResult: step(172),
    projectedUsable: true,
    quality: { state: 'running', runningConfidence: 0.9 },
  });
  assert.equal(result.stepped, true);
  assert.equal(result.channel, 'projected');
  assert.equal(result.steps, 1);
  assert.equal(result.cadenceReady, false);
  assert.equal(result.cadenceSpm, 0);
  assert.equal(result.candidateCadenceSpm, 171);
});

test('姿态不可用时直接使用模长通道，且不伪造默认步频', () => {
  const arbiter = new DualStepArbiter();
  const first = arbiter.observe({
    timestampMs: 1000,
    projectedResult: idle(0),
    magnitudeResult: { stepped: true, cadenceReady: false, cadenceSpm: 0 },
    projectedUsable: false,
  });
  assert.equal(first.stepped, true);
  assert.equal(first.channel, 'magnitude');
  assert.equal(first.cadenceReady, false);
  assert.equal(first.cadenceSpm, 0);
});

test('fresh 但持续全零的陀螺仪不得授权灵敏投影单通道计步', () => {
  const arbiter = new DualStepArbiter();
  const result = arbiter.observe({
    timestampMs: 1000,
    projectedResult: step(120),
    magnitudeResult: idle(0),
    projectedUsable: true,
    quality: {
      state: 'uncertain',
      stationaryConfidence: 0.1,
      artifactConfidence: 0,
      gyroFresh: true,
      gyroRms: 0,
    },
  });
  assert.equal(result.stepped, false);
  assert.equal(result.reason, 'sensitive_without_quiet_gyro');
  assert.equal(result.steps, 0);
});

test('头部伪动作要求双通道短窗一致，单通道峰值不会计步', () => {
  const arbiter = new DualStepArbiter({ agreementWindowMs: 180 });
  const projected = arbiter.observe({
    timestampMs: 1000,
    projectedResult: step(168),
    magnitudeResult: idle(168),
    projectedUsable: true,
    quality: { state: 'head_motion', artifactConfidence: 0.9 },
  });
  assert.equal(projected.stepped, false);
  assert.equal(projected.pendingAgreement, true);

  const agreed = arbiter.observe({
    timestampMs: 1120,
    projectedResult: idle(168),
    magnitudeResult: step(170),
    projectedUsable: true,
    quality: { state: 'head_motion', artifactConfidence: 0.8 },
  });
  assert.equal(agreed.stepped, true);
  assert.equal(agreed.channel, 'agreement');
  assert.equal(agreed.steps, 1);

  const expired = arbiter.observe({
    timestampMs: 1500,
    projectedResult: idle(168),
    magnitudeResult: step(170),
    projectedUsable: true,
    quality: { state: 'head_motion', artifactConfidence: 0.8 },
  });
  assert.equal(expired.stepped, false);
  assert.equal(expired.steps, 1);
});

test('姿态不可用且高角速度时，每一步仍需灵敏与严格模长短窗一致', () => {
  const arbiter = new DualStepArbiter();
  const agreed = arbiter.observe({
    timestampMs: 1000,
    projectedResult: step(170),
    magnitudeResult: step(170),
    projectedUsable: false,
    quality: {
      state: 'head_motion',
      artifactConfidence: 0.9,
      gyroFresh: true,
      gyroRms: 0.8,
    },
  });
  assert.equal(agreed.stepped, true);
  assert.equal(agreed.channel, 'agreement');
  assert.equal(agreed.steps, 1);

  const singleChannel = arbiter.observe({
    timestampMs: 1353,
    projectedResult: step(171),
    magnitudeResult: idle(0),
    projectedUsable: false,
    quality: {
      state: 'head_motion',
      artifactConfidence: 0.9,
      gyroFresh: true,
      gyroRms: 0.8,
    },
  });
  assert.equal(singleChannel.stepped, false);
  assert.equal(singleChannel.channel, 'none');
  assert.equal(singleChannel.reason, 'angular_motion_without_agreement');
  assert.equal(singleChannel.steps, 1);
});

test('投影偶发漏峰时仅在双路步频一致或高置信跑动下允许模长补位', () => {
  const arbiter = new DualStepArbiter();
  const recovered = arbiter.observe({
    timestampMs: 1000,
    projectedResult: idle(168),
    magnitudeResult: step(172),
    projectedUsable: true,
    quality: { state: 'running', runningConfidence: 0.8, artifactConfidence: 0.1 },
  });
  assert.equal(recovered.stepped, true);
  assert.equal(recovered.reason, 'magnitude_recovery');

  const rejected = arbiter.observe({
    timestampMs: 1400,
    projectedResult: idle(120),
    magnitudeResult: step(190),
    projectedUsable: true,
    quality: { state: 'uncertain', runningConfidence: 0.2, artifactConfidence: 0.2 },
  });
  assert.equal(rejected.stepped, false);
});

test('姿态存在但投影弱时，低伪动作下稳定模长节奏可直接接管', () => {
  const arbiter = new DualStepArbiter();
  let result = null;
  for (let index = 0; index < 8; index += 1) {
    result = arbiter.observe({
      timestampMs: 1000 + index * 353,
      projectedUsable: true,
      projectedResult: {
        stepped: false,
        cadenceReady: false,
        cadenceSpm: 0,
      },
      magnitudeResult: {
        stepped: true,
        cadenceReady: true,
        cadenceSpm: 170,
      },
      quality: {
        state: 'uncertain',
        artifactConfidence: 0.2,
        stationaryConfidence: 0.2,
      },
    });
    assert.equal(result.stepped, true);
  }
  assert.equal(result.channel, 'magnitude');
  assert.equal(result.reason, 'magnitude_periodic_fallback');
  assert.equal(result.cadenceSpm, 170);
});

test('明确静止始终拒绝；高角速度下单通道周期始终不得接管', () => {
  const stationary = new DualStepArbiter();
  const stationaryResult = stationary.observe({
    timestampMs: 1000,
    projectedUsable: true,
    projectedResult: { stepped: false, cadenceReady: false, cadenceSpm: 0 },
    magnitudeResult: { stepped: true, cadenceReady: true, cadenceSpm: 170 },
    quality: {
      state: 'stationary',
      artifactConfidence: 0.1,
      stationaryConfidence: 0.9,
    },
  });
  assert.equal(stationaryResult.stepped, false);
  assert.equal(stationaryResult.reason, 'stationary');

  const artifact = new DualStepArbiter();
  const artifactResult = artifact.observe({
    timestampMs: 1000,
    projectedUsable: true,
    projectedResult: { stepped: false, cadenceReady: false, cadenceSpm: 0 },
    magnitudeResult: { stepped: true, cadenceReady: true, cadenceSpm: 170 },
    quality: {
      state: 'head_motion',
      artifactConfidence: 0.8,
      stationaryConfidence: 0.1,
    },
  });
  assert.equal(artifactResult.stepped, false);
  assert.equal(artifactResult.reason, 'awaiting_agreement');

  const periodicResult = artifact.observe({
    timestampMs: 1353,
    projectedUsable: true,
    projectedResult: { stepped: false, cadenceReady: false, cadenceSpm: 0 },
    magnitudeResult: { stepped: true, cadenceReady: true, cadenceSpm: 171 },
    quality: {
      state: 'head_motion',
      artifactConfidence: 0.8,
      stationaryConfidence: 0.1,
    },
  });
  assert.equal(periodicResult.stepped, false);
  assert.equal(periodicResult.reason, 'awaiting_agreement');
  assert.equal(periodicResult.channel, 'none');
  assert.equal(periodicResult.steps, 0);
});

test('高角速度投影单通道不能再靠自身周期解锁，避免坐姿转头被累计为距离', () => {
  const arbiter = new DualStepArbiter();
  const first = arbiter.observe({
    timestampMs: 1000,
    projectedUsable: true,
    projectedResult: step(172),
    magnitudeResult: idle(0),
    quality: {
      state: 'head_motion',
      artifactConfidence: 0.82,
      stationaryConfidence: 0.05,
    },
  });
  assert.equal(first.stepped, false);
  assert.equal(first.reason, 'awaiting_agreement');

  const second = arbiter.observe({
    timestampMs: 1349,
    projectedUsable: true,
    projectedResult: step(172),
    magnitudeResult: idle(0),
    quality: {
      state: 'head_motion',
      artifactConfidence: 0.84,
      stationaryConfidence: 0.04,
    },
  });
  assert.equal(second.stepped, false);
  assert.equal(second.channel, 'none');
  assert.equal(second.reason, 'awaiting_agreement');
  assert.equal(second.cadenceReady, false);
  assert.equal(second.cadenceSpm, 0);
  assert.equal(second.steps, 0);
});

test('低角速度慢走允许敏感投影形成数值步频，不重新退化为长期 --', () => {
  const arbiter = new DualStepArbiter();
  let result = null;
  for (let index = 0; index < 5; index += 1) {
    result = arbiter.observe({
      timestampMs: 1000 + index * 600,
      projectedUsable: true,
      projectedResult: step(100),
      magnitudeResult: idle(0),
      quality: {
        state: 'uncertain',
        artifactConfidence: 0.15,
        stationaryConfidence: 0.2,
        gyroFresh: true,
        gyroRms: 0.12,
      },
    });
    assert.equal(result.stepped, true);
  }
  assert.equal(result.cadenceReady, true);
  assert.equal(result.cadenceSpm, 100);
});

test('即使质量状态误判 running，高角速度仍要求逐步双通道一致', () => {
  const arbiter = new DualStepArbiter();
  for (let index = 0; index < 300; index += 1) {
    const result = arbiter.observe({
      timestampMs: 1000 + index * 400,
      projectedUsable: true,
      projectedResult: idle(0),
      magnitudeResult: step(150),
      quality: {
        state: 'running',
        runningConfidence: 0.8,
        artifactConfidence: 0.2,
        gyroFresh: true,
        gyroRms: 0.65,
      },
    });
    assert.equal(result.stepped, false);
  }
  assert.equal(arbiter.acceptedSteps, 0);
});

test('高角速度双通道时间或步频不一致时不得形成落步', () => {
  const arbiter = new DualStepArbiter({ agreementWindowMs: 180 });
  const projected = arbiter.observe({
    timestampMs: 1000,
    projectedUsable: true,
    projectedResult: step(100),
    magnitudeResult: idle(0),
    quality: {
      state: 'head_motion',
      artifactConfidence: 0.8,
      gyroFresh: true,
      gyroRms: 0.7,
    },
  });
  assert.equal(projected.stepped, false);

  const cadenceMismatch = arbiter.observe({
    timestampMs: 1120,
    projectedUsable: true,
    projectedResult: idle(100),
    magnitudeResult: step(180),
    quality: {
      state: 'head_motion',
      artifactConfidence: 0.8,
      gyroFresh: true,
      gyroRms: 0.7,
    },
  });
  assert.equal(cadenceMismatch.stepped, false);
  assert.equal(cadenceMismatch.reason, 'cadence_disagreement');

  const lateMagnitude = arbiter.observe({
    timestampMs: 1500,
    projectedUsable: true,
    projectedResult: step(100),
    magnitudeResult: idle(0),
    quality: {
      state: 'head_motion',
      artifactConfidence: 0.8,
      gyroFresh: true,
      gyroRms: 0.7,
    },
  });
  assert.equal(lateMagnitude.stepped, false);
  const expired = arbiter.observe({
    timestampMs: 1701,
    projectedUsable: true,
    projectedResult: idle(100),
    magnitudeResult: step(100),
    quality: {
      state: 'head_motion',
      artifactConfidence: 0.8,
      gyroFresh: true,
      gyroRms: 0.7,
    },
  });
  assert.equal(expired.stepped, false);
  assert.equal(expired.steps, 0);
});

test('旧宿主缺少 gyro 时拒绝敏感通道，但保留严格模长回退', () => {
  const sensitiveOnly = new DualStepArbiter().observe({
    timestampMs: 1000,
    projectedUsable: true,
    projectedResult: step(100),
    magnitudeResult: idle(0),
    quality: {
      state: 'uncertain',
      artifactConfidence: 0.1,
      stationaryConfidence: 0.1,
      gyroFresh: false,
    },
  });
  assert.equal(sensitiveOnly.stepped, false);
  assert.equal(sensitiveOnly.reason, 'sensitive_without_quiet_gyro');

  const strict = new DualStepArbiter().observe({
    timestampMs: 1000,
    projectedUsable: false,
    projectedResult: idle(0),
    magnitudeResult: step(100),
    quality: {
      state: 'uncertain',
      artifactConfidence: 0.1,
      stationaryConfidence: 0.1,
      gyroFresh: false,
    },
  });
  assert.equal(strict.stepped, true);
  assert.equal(strict.channel, 'magnitude');
});

test('一次合法 agreement 不许可后续高角速度投影单通道峰值', () => {
  const arbiter = new DualStepArbiter();
  const agreed = arbiter.observe({
    timestampMs: 1000,
    projectedUsable: true,
    projectedResult: step(100),
    magnitudeResult: step(100),
    quality: {
      state: 'head_motion',
      artifactConfidence: 0.8,
      stationaryConfidence: 0.05,
      gyroFresh: true,
      gyroRms: 0.6,
    },
  });
  assert.equal(agreed.stepped, true);
  assert.equal(agreed.channel, 'agreement');

  const firstSingle = arbiter.observe({
    timestampMs: 1600,
    projectedUsable: true,
    projectedResult: step(100),
    magnitudeResult: idle(0),
    quality: {
      state: 'head_motion',
      artifactConfidence: 0.8,
      stationaryConfidence: 0.05,
      gyroFresh: true,
      gyroRms: 0.6,
    },
  });
  assert.equal(firstSingle.stepped, false);
  assert.equal(firstSingle.reason, 'awaiting_agreement');

  const secondSingle = arbiter.observe({
    timestampMs: 2200,
    projectedUsable: true,
    projectedResult: step(100),
    magnitudeResult: idle(0),
    quality: {
      state: 'head_motion',
      artifactConfidence: 0.8,
      stationaryConfidence: 0.05,
      gyroFresh: true,
      gyroRms: 0.6,
    },
  });
  assert.equal(secondSingle.stepped, false);
  assert.equal(secondSingle.reason, 'awaiting_agreement');
  assert.equal(secondSingle.steps, 1);
});

test('高角速度孤立触碰没有第二个周期证据，不会计步或伪造步频', () => {
  const arbiter = new DualStepArbiter();
  const first = arbiter.observe({
    timestampMs: 1000,
    projectedUsable: true,
    projectedResult: step(170),
    magnitudeResult: idle(0),
    quality: { state: 'head_motion', artifactConfidence: 0.95 },
  });
  assert.equal(first.stepped, false);

  const expired = arbiter.observe({
    timestampMs: 2000,
    projectedUsable: true,
    projectedResult: idle(0),
    magnitudeResult: idle(0),
    quality: { state: 'head_motion', artifactConfidence: 0.95 },
  });
  assert.equal(expired.stepped, false);
  assert.equal(expired.steps, 0);
  assert.equal(expired.cadenceReady, false);
});

test('落步去重、乱序、暂停恢复与步频保鲜均安全', () => {
  const arbiter = new DualStepArbiter({ stepDedupeMs: 220, cadenceHoldMs: 500 });
  assert.equal(arbiter.observe({
    timestampMs: 1000,
    magnitudeResult: step(180),
    projectedUsable: false,
  }).stepped, true);
  assert.equal(arbiter.observe({
    timestampMs: 1100,
    magnitudeResult: step(180),
    projectedUsable: false,
  }).reason, 'deduped');
  assert.equal(arbiter.observe({
    timestampMs: 900,
    magnitudeResult: step(180),
    projectedUsable: false,
  }).reason, 'out_of_order');
  assert.equal(arbiter.observe({
    timestampMs: 1600,
    magnitudeResult: idle(0),
    projectedUsable: false,
  }).cadenceReady, false);

  arbiter.pause();
  assert.equal(arbiter.observe({
    timestampMs: 1700,
    magnitudeResult: step(180),
    projectedUsable: false,
  }).reason, 'paused');
  arbiter.resume();
  assert.equal(arbiter.observe({
    timestampMs: 1800,
    magnitudeResult: step(180),
    projectedUsable: false,
  }).stepped, true);
  assert.equal(arbiter.acceptedSteps, 2);
});

test('上游候选 200spm 但最终每 600ms 只 accepted 一步时，HUD 步频按最终落步得出 100spm', () => {
  const arbiter = new DualStepArbiter();
  const results = [1000, 1600, 2200, 2800].map((timestampMs) => (
    arbiter.observe({
      timestampMs,
      magnitudeResult: step(200),
      projectedUsable: false,
      quality: { state: 'running', artifactConfidence: 0.1 },
    })
  ));

  for (const result of results.slice(0, 3)) {
    assert.equal(result.stepped, true);
    assert.equal(result.cadenceReady, false, '至少需要 4 个最终 accepted step');
    assert.equal(result.cadenceSpm, 0);
    assert.equal(result.candidateCadenceSpm, 200);
  }
  const ready = results[3];
  assert.equal(ready.steps, 4);
  assert.equal(ready.cadenceReady, true);
  assert.equal(ready.cadenceSpm, 100);
  assert.notEqual(ready.cadenceSpm, ready.candidateCadenceSpm);
});

test('长间隔和暂停恢复都会清除最终步频窗口，必须重新累计 4 个 accepted step', () => {
  const arbiter = new DualStepArbiter();
  const accept = (timestampMs) => arbiter.observe({
    timestampMs,
    magnitudeResult: step(200),
    projectedUsable: false,
    quality: { state: 'running', artifactConfidence: 0.1 },
  });

  [1000, 1600, 2200].forEach((timestampMs) => {
    assert.equal(accept(timestampMs).cadenceReady, false);
  });
  assert.equal(accept(2800).cadenceSpm, 100);

  assert.equal(accept(8001).cadenceReady, false, '长间隔后的第一步只建立新锚点');
  assert.equal(accept(8601).cadenceReady, false);
  assert.equal(accept(9201).cadenceReady, false);
  assert.equal(accept(9801).cadenceSpm, 100);

  arbiter.pause();
  assert.equal(arbiter.observe({
    timestampMs: 10401,
    magnitudeResult: step(200),
    projectedUsable: false,
  }).reason, 'paused');
  arbiter.resume();

  assert.equal(accept(11001).cadenceReady, false, '恢复后的第一步只建立新锚点');
  assert.equal(accept(11601).cadenceReady, false);
  assert.equal(accept(12201).cadenceReady, false);
  const rebuilt = accept(12801);
  assert.equal(rebuilt.cadenceReady, true);
  assert.equal(rebuilt.cadenceSpm, 100);
});

test('稳定 90spm 中夹入少量约 180spm 短间隔，不会让最终步频短时倍频到 170+', () => {
  const arbiter = new DualStepArbiter();
  const accept = (timestampMs) => arbiter.observe({
    timestampMs,
    magnitudeResult: step(180),
    projectedUsable: false,
    quality: { state: 'running', artifactConfidence: 0.1 },
  });
  let timestampMs = 1000;
  let stable = accept(timestampMs);
  for (let index = 0; index < 8; index += 1) {
    timestampMs += 667;
    stable = accept(timestampMs);
  }
  assert.equal(stable.cadenceSpm, 90);

  let afterBurst = null;
  for (let index = 0; index < 4; index += 1) {
    timestampMs += 333;
    afterBurst = accept(timestampMs);
  }
  assert.equal(afterBurst.cadenceReady, true);
  assert.ok(afterBurst.cadenceSpm >= 85 && afterBurst.cadenceSpm < 170,
    `少量二次谐波不应把最终步频翻倍，实际为 ${afterBurst.cadenceSpm}`);
});
