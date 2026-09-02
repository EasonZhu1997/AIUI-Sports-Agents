import test from 'node:test';
import assert from 'node:assert/strict';

import { ImuActivityGate } from '../lib/imu_activity_gate.js';

function candidate({
  cadenceSpm = 0,
  candidateCadenceSpm = 0,
  cadenceReady = cadenceSpm > 0,
  strictEvidence = false,
  reason = 'test',
} = {}) {
  return {
    stepped: true,
    cadenceReady,
    cadenceSpm,
    candidateCadenceSpm,
    strictEvidence,
    reason,
  };
}

test('静坐投影倍频不进入正式运动账本', () => {
  const gate = new ImuActivityGate();
  const traces = [
    candidate({ candidateCadenceSpm: 228 }),
    candidate({ candidateCadenceSpm: 228 }),
    candidate({ candidateCadenceSpm: 228 }),
    candidate({ cadenceSpm: 108, candidateCadenceSpm: 228 }),
    candidate({ cadenceSpm: 108, candidateCadenceSpm: 228 }),
  ];
  traces.forEach((result, index) => {
    const state = gate.observe({
      timestampMs: 1000 + index * 278,
      result,
      quality: { state: 'uncertain', stationaryConfidence: 0 },
    });
    assert.equal(state.active, false);
    assert.equal(state.submitStep, false);
  });
});

test('真机静坐启动的 239spm 匹配倍频即使 gyro 非零也不得激活', () => {
  const gate = new ImuActivityGate();
  for (let index = 0; index < 8; index += 1) {
    const state = gate.observe({
      timestampMs: 1000 + index * 251,
      result: candidate({
        cadenceSpm: 239,
        candidateCadenceSpm: 239,
      }),
      quality: {
        state: 'uncertain',
        runningConfidence: 0.2,
        artifactConfidence: 0,
        stationaryConfidence: 0,
        gyroFresh: true,
        gyroRms: 0.119,
      },
    });
    assert.equal(state.active, false);
    assert.equal(state.submitStep, false);
  }
});

test('uncertain 严格峰不能用折半 final 绕过高倍频候选门', () => {
  const gate = new ImuActivityGate();
  for (let index = 0; index < 8; index += 1) {
    const state = gate.observe({
      timestampMs: 1000 + index * 526,
      result: candidate({
        cadenceSpm: 114,
        candidateCadenceSpm: 220,
        strictEvidence: true,
      }),
      quality: {
        state: 'uncertain',
        runningConfidence: 0.5,
        artifactConfidence: 0.05,
        stationaryConfidence: 0.05,
        gyroFresh: true,
        gyroRms: 0.12,
      },
    });
    assert.equal(state.active, false);
    assert.equal(state.submitStep, false);
    assert.equal(state.strictEvidenceCount, 0);
    assert.equal(state.stableCadenceCount, 0);
  }
});

test('uncertain 的 strict magnitude 不激活，只有连续一致节奏可走稳定门', () => {
  const gate = new ImuActivityGate();
  for (let index = 0; index < 3; index += 1) {
    const state = gate.observe({
      timestampMs: 1000 + index * 667,
      result: candidate({
        cadenceSpm: 90,
        candidateCadenceSpm: 90,
        strictEvidence: true,
      }),
      quality: {
        state: 'uncertain',
        runningConfidence: 0.45,
        artifactConfidence: 0.05,
        stationaryConfidence: 0.05,
        gyroFresh: true,
        gyroRms: 0.12,
      },
    });
    assert.equal(state.active, false, '前三次不能借 strict_evidence 提前开门');
    assert.equal(state.strictEvidenceCount, 0);
  }
  const activated = gate.observe({
    timestampMs: 3001,
    result: candidate({
      cadenceSpm: 90,
      candidateCadenceSpm: 90,
      strictEvidence: true,
    }),
    quality: {
      state: 'uncertain',
      runningConfidence: 0.45,
      artifactConfidence: 0.05,
      stationaryConfidence: 0.05,
      gyroFresh: true,
      gyroRms: 0.12,
    },
  });
  assert.equal(activated.active, true);
  assert.equal(activated.reason, 'stable_projected_cadence');
});

test('running 慢走即使宿主新鲜 gyro 恒为零，仍可由三个严格证据激活', () => {
  const gate = new ImuActivityGate();
  let snapshot = null;
  for (const timestampMs of [1000, 1750, 2500]) {
    snapshot = gate.observe({
      timestampMs,
      quality: {
        state: 'running',
        runningConfidence: 0.8,
        stationaryConfidence: 0.05,
        artifactConfidence: 0.05,
        gyroFresh: true,
        gyroRms: 0,
      },
      result: {
        stepped: true,
        strictEvidence: true,
        cadenceReady: true,
        cadenceSpm: 80,
        candidateCadenceSpm: 80,
      },
    });
  }
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.reason, 'strict_evidence');
});

test('极慢 uncertain 节奏四步仍可通过稳定门，不被证据间隔清空', () => {
  const gate = new ImuActivityGate();
  let snapshot = null;
  for (const timestampMs of [1000, 2250, 3500, 4750]) {
    snapshot = gate.observe({
      timestampMs,
      quality: {
        state: 'uncertain',
        runningConfidence: 0.3,
        stationaryConfidence: 0.2,
        artifactConfidence: 0.1,
        gyroFresh: true,
        gyroRms: 0.02,
      },
      result: {
        stepped: true,
        strictEvidence: false,
        cadenceReady: true,
        cadenceSpm: 48,
        candidateCadenceSpm: 48,
      },
    });
  }
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.reason, 'stable_projected_cadence');
});

test('三个连续严格证据可确认真实运动，确认前候选步不回放', () => {
  const gate = new ImuActivityGate();
  const first = gate.observe({
    timestampMs: 1000,
    result: candidate({ strictEvidence: true, candidateCadenceSpm: 90 }),
    quality: {
      state: 'running',
      runningConfidence: 0.8,
      artifactConfidence: 0.1,
    },
  });
  assert.equal(first.active, false);
  assert.equal(first.submitStep, false);

  const second = gate.observe({
    timestampMs: 1667,
    result: candidate({
      cadenceSpm: 90,
      candidateCadenceSpm: 180,
      strictEvidence: true,
    }),
    quality: {
      state: 'running',
      runningConfidence: 0.8,
      artifactConfidence: 0.1,
    },
  });
  assert.equal(second.active, false);
  assert.equal(second.submitStep, false);

  const third = gate.observe({
    timestampMs: 2334,
    result: candidate({
      cadenceSpm: 90,
      candidateCadenceSpm: 90,
      strictEvidence: true,
    }),
    quality: {
      state: 'running',
      runningConfidence: 0.8,
      artifactConfidence: 0.1,
    },
  });
  assert.equal(third.active, true);
  assert.equal(third.justActivated, true);
  assert.equal(third.reason, 'strict_evidence');
  assert.equal(third.submitStep, true);
});

test('弱投影慢走可由连续一致的最终步频确认', () => {
  const gate = new ImuActivityGate();
  const times = [1000, 1667, 2334, 3001, 3668, 4335, 5002];
  let state = null;
  times.forEach((timestampMs, index) => {
    state = gate.observe({
      timestampMs,
      result: candidate({
        cadenceSpm: index >= 3 ? 90 : 0,
        candidateCadenceSpm: 90,
        cadenceReady: index >= 3,
      }),
      quality: {
        state: 'running',
        runningConfidence: 0.72,
        artifactConfidence: 0.1,
      },
    });
  });
  assert.equal(state.active, true);
  assert.equal(state.reason, 'stable_projected_cadence');
  assert.equal(state.submitStep, true);
});

test('匹配步频证据被静止或超时隔开时不得误认为连续运动', () => {
  const gate = new ImuActivityGate();
  const matching = candidate({
    cadenceSpm: 100,
    candidateCadenceSpm: 100,
  });
  const movingQuality = {
    state: 'running',
    runningConfidence: 0.75,
    artifactConfidence: 0.1,
  };
  gate.observe({ timestampMs: 1000, result: matching, quality: movingQuality });
  gate.observe({ timestampMs: 1600, result: matching, quality: movingQuality });
  gate.observe({
    timestampMs: 2000,
    result: {},
    quality: { state: 'stationary', stationaryConfidence: 0.9 },
  });
  gate.observe({ timestampMs: 2600, result: matching, quality: movingQuality });
  const afterStationary = gate.observe({
    timestampMs: 3200,
    result: matching,
    quality: movingQuality,
  });
  assert.equal(afterStationary.active, false);

  const afterGap = gate.observe({
    timestampMs: 5201,
    result: matching,
    quality: movingQuality,
  });
  assert.equal(afterGap.active, false);
  assert.equal(afterGap.stableCadenceCount, 1);
});

test('连续静止后重新进入探测态，但不会伪造提交步', () => {
  const gate = new ImuActivityGate({ stationaryHoldMs: 1400 });
  gate.confirmExternal(1000, 'rsc_motion');
  assert.equal(gate.observe({
    timestampMs: 2000,
    result: {},
    quality: { state: 'stationary', stationaryConfidence: 0.72 },
  }).active, true);
  const stopped = gate.observe({
    timestampMs: 3400,
    result: {},
    quality: { state: 'stationary', stationaryConfidence: 0.72 },
  });
  assert.equal(stopped.active, false);
  assert.equal(stopped.justDeactivated, true);

  const noise = gate.observe({
    timestampMs: 3800,
    result: candidate({ cadenceSpm: 108, candidateCadenceSpm: 228 }),
    quality: { state: 'uncertain', stationaryConfidence: 0 },
  });
  assert.equal(noise.submitStep, false);
});

test('停步后全零 gyro 的严格伪峰不得重新激活活动门', () => {
  const gate = new ImuActivityGate({ stationaryHoldMs: 1400 });
  gate.confirmExternal(1000, 'walk');
  gate.observe({
    timestampMs: 2000,
    result: {},
    quality: { state: 'stationary', stationaryConfidence: 0.9 },
  });
  assert.equal(gate.observe({
    timestampMs: 3400,
    result: {},
    quality: { state: 'stationary', stationaryConfidence: 0.9 },
  }).justDeactivated, true);

  for (let index = 0; index < 8; index += 1) {
    const state = gate.observe({
      timestampMs: 3800 + index * 500,
      result: candidate({
        cadenceSpm: 120,
        candidateCadenceSpm: 120,
        strictEvidence: true,
      }),
      quality: {
        state: 'uncertain',
        runningConfidence: 0.3,
        artifactConfidence: 0,
        stationaryConfidence: 0.1,
        gyroFresh: true,
        gyroRms: 0,
      },
    });
    assert.equal(state.active, false);
    assert.equal(state.submitStep, false);
  }
});

test('活动门已打开时仍拒绝 uncertain 折半倍频，持续无合格证据后回到探测态', () => {
  const gate = new ImuActivityGate({ evidenceGapMs: 1800 });
  gate.confirmExternal(1000, 'walk');

  const foldedNoise = gate.observe({
    timestampMs: 1200,
    result: candidate({
      cadenceSpm: 110,
      candidateCadenceSpm: 230,
    }),
    quality: {
      state: 'uncertain',
      runningConfidence: 0.25,
      artifactConfidence: 0.1,
      stationaryConfidence: 0.2,
      gyroFresh: true,
      gyroRms: 0.05,
    },
  });
  assert.equal(foldedNoise.active, true, '单个坏候选只被拒绝，不立刻抖动活动状态');
  assert.equal(foldedNoise.submitStep, false);
  assert.equal(foldedNoise.cadenceReady, false);

  const lost = gate.observe({
    timestampMs: 3000,
    result: {},
    quality: {
      state: 'uncertain',
      runningConfidence: 0.2,
      artifactConfidence: 0.1,
      stationaryConfidence: 0.2,
      gyroFresh: true,
      gyroRms: 0.05,
    },
  });
  assert.equal(lost.active, false);
  assert.equal(lost.justDeactivated, true);
  assert.equal(lost.reason, 'active_evidence_lost');

  const stillNoise = gate.observe({
    timestampMs: 3300,
    result: candidate({
      cadenceSpm: 110,
      candidateCadenceSpm: 230,
    }),
    quality: {
      state: 'uncertain',
      runningConfidence: 0.25,
      artifactConfidence: 0.1,
      stationaryConfidence: 0.2,
    },
  });
  assert.equal(stillNoise.active, false);
  assert.equal(stillNoise.submitStep, false);
});

test('活动态继续接受 running、逐步头动 agreement 与一致 uncertain 节奏', () => {
  const gate = new ImuActivityGate();
  gate.confirmExternal(1000, 'walk');

  const running = gate.observe({
    timestampMs: 1600,
    result: candidate({
      cadenceSpm: 100,
      candidateCadenceSpm: 100,
      strictEvidence: true,
    }),
    quality: {
      state: 'running',
      runningConfidence: 0.8,
      artifactConfidence: 0.1,
      stationaryConfidence: 0.05,
    },
  });
  assert.equal(running.submitStep, true);

  const headMotion = gate.observe({
    timestampMs: 2200,
    result: candidate({
      cadenceSpm: 100,
      candidateCadenceSpm: 100,
      reason: 'head_motion_agreement',
    }),
    quality: {
      state: 'head_motion',
      runningConfidence: 0.2,
      artifactConfidence: 0.9,
      stationaryConfidence: 0.05,
      gyroFresh: true,
      gyroRms: 0.6,
    },
  });
  assert.equal(headMotion.submitStep, true);

  const uncertain = gate.observe({
    timestampMs: 2800,
    result: candidate({
      cadenceSpm: 100,
      candidateCadenceSpm: 100,
    }),
    quality: {
      state: 'uncertain',
      runningConfidence: 0.35,
      artifactConfidence: 0.1,
      stationaryConfidence: 0.1,
      gyroFresh: true,
      gyroRms: 0.04,
    },
  });
  assert.equal(uncertain.submitStep, true);
  assert.equal(uncertain.cadenceReady, true);
});

test('外部 RSC 正运动确认幂等，不会每包重复触发启动动作', () => {
  const gate = new ImuActivityGate();
  assert.equal(gate.confirmExternal(1000, 'rsc_motion').justActivated, true);
  const repeated = gate.confirmExternal(1500, 'rsc_motion');
  assert.equal(repeated.active, true);
  assert.equal(repeated.justActivated, false);
});
