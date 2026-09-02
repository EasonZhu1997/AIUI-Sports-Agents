import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPostRideAdvice,
  buildPreRideBrief,
  nextRideCoachCue,
  RIDE_COACH_LIMITS,
} from '../lib/ride_coach.js';

function metric(value, overrides = {}) {
  return {
    value,
    state: 'live',
    source: 'csc',
    ageMs: 250,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    elapsedMs: 0,
    distanceM: 0,
    paused: false,
    metrics: {
      speed: metric(24.3),
      cadence: metric(88),
      heartRate: metric(142, { source: 'hrs' }),
    },
    ...overrides,
  };
}

test('骑前文案只陈述本地历史与明确就绪能力', () => {
  const text = buildPreRideBrief(
    { elapsedMs: 1800000, distanceM: 12340 },
    {
      imuReady: true,
      heartRateConnected: true,
    },
  );
  assert.match(text, /上次骑行 12\.34 公里/);
  assert.match(text, /眼镜可辅助估算踏频/);
  assert.match(text, /速度与距离将由眼镜 IMU 保守估算/);
  assert.match(text, /心率已连接/);
  assert.doesNotMatch(text, /天气|温度|AI|智能生成/);
});

test('骑前极短历史不舍入成 0.00 公里', () => {
  const text = buildPreRideBrief(
    { elapsedMs: 35000, distanceM: 2 },
    { imuReady: true },
  );
  assert.match(text, /上次骑行距离很短/);
  assert.doesNotMatch(text, /0\.00/);
});

test('骑前能力未知时要求确认，不虚构就绪状态', () => {
  const unknown = buildPreRideBrief(null, null);
  assert.match(unknown, /先确认眼镜传感器与设备/);
  assert.doesNotMatch(unknown, /已就绪|已连接/);

  const imuOnly = buildPreRideBrief(null, {
    imuReady: true,
  });
  assert.match(imuOnly, /眼镜可辅助估算踏频/);
  assert.match(imuOnly, /速度与距离将由眼镜 IMU 保守估算/);
});

test('5 分钟提示只带入 live 且新鲜的踏频', () => {
  const now = 300000;
  const result = nextRideCoachCue(null, snapshot({
    elapsedMs: now,
    metrics: {
      speed: metric(25, { state: 'stale' }),
      cadence: metric(87),
      heartRate: metric(145, { held: true }),
    },
  }), now);
  assert.match(result.cue, /骑行 5 分钟/);
  assert.match(result.cue, /踏频 87/);
  assert.doesNotMatch(result.cue, /25|145|速度|心率/);
});

test('5 公里提示每个边沿只播一次，并遵守全局 60 秒限频', () => {
  const first = nextRideCoachCue(null, snapshot({
    elapsedMs: 240000,
    distanceM: 5001,
  }), 240000);
  assert.match(first.cue, /已骑 5 公里/);
  assert.match(first.cue, /速度 24\.3/);

  const duplicate = nextRideCoachCue(first.state, snapshot({
    elapsedMs: 241000,
    distanceM: 5200,
  }), 241000);
  assert.equal(duplicate.cue, null);

  // 跨 10 公里但仍在全局冷却内：消费里程碑，不延迟补播旧提示。
  const blocked = nextRideCoachCue(duplicate.state, snapshot({
    elapsedMs: 250000,
    distanceM: 10020,
  }), 250000);
  assert.equal(blocked.cue, null);
  assert.equal(blocked.state.distanceMilestone, 2);

  const noCatchUp = nextRideCoachCue(blocked.state, snapshot({
    elapsedMs: 280000,
    distanceM: 10100,
  }), 301000);
  assert.equal(noCatchUp.cue, null);
});

test('held/stale/unsupported/估算候选绝不作为实时指标播报', () => {
  const cases = [
    { state: 'held' },
    { state: 'stale' },
    { state: 'unsupported' },
    { held: true },
    { candidate: true },
    { estimatedCandidate: true },
    { final: false },
    { quality: 'candidate' },
    { source: 'imu_candidate' },
    { state: 'live', ageMs: 9000 },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const result = nextRideCoachCue(null, snapshot({
      elapsedMs: 300000,
      metrics: {
        speed: metric(31, cases[index]),
        cadence: metric(119, cases[index]),
        heartRate: metric(188, cases[index]),
      },
    }), 300000);
    assert.match(result.cue, /骑行 5 分钟/);
    assert.doesNotMatch(
      result.cue,
      /31|119|188|速度|踏频|心率/,
      `case ${index} 不得进入实时播报`,
    );
  }
});

test('明显低踏频必须连续 15 秒后提示，且同类 5 分钟限频', () => {
  const low = snapshot({
    elapsedMs: 120000,
    distanceM: 1200,
    metrics: {
      speed: metric(18),
      cadence: metric(55, { source: 'imu' }),
      heartRate: metric(130, { source: 'hrs' }),
    },
  });
  const started = nextRideCoachCue(null, low, 120000);
  assert.equal(started.cue, null);
  assert.equal(started.state.cadenceBand, 'low');

  const tooSoon = nextRideCoachCue(started.state, {
    ...low,
    elapsedMs: 134000,
  }, 134000);
  assert.equal(tooSoon.cue, null);

  const held = nextRideCoachCue(tooSoon.state, {
    ...low,
    elapsedMs: 135000,
  }, 135000);
  assert.match(held.cue, /踏频 55，偏低/);
  assert.match(held.cue, /减档/);

  const oneMinuteLater = nextRideCoachCue(held.state, {
    ...low,
    elapsedMs: 195000,
  }, 195000);
  assert.equal(oneMinuteLater.cue, null);

  const repeat = nextRideCoachCue(oneMinuteLater.state, {
    ...low,
    elapsedMs: 435000,
  }, 435000);
  assert.match(repeat.cue, /偏低/);
});

test('踏频恢复正常会重置持续偏离计时，高踏频使用独立提示', () => {
  const lowStart = nextRideCoachCue(null, snapshot({
    metrics: { cadence: metric(58), speed: null, heartRate: null },
  }), 1000);
  const normal = nextRideCoachCue(lowStart.state, snapshot({
    metrics: { cadence: metric(80), speed: null, heartRate: null },
  }), 10000);
  assert.equal(normal.state.cadenceBand, 'normal');

  const highStart = nextRideCoachCue(normal.state, snapshot({
    metrics: { cadence: metric(115), speed: null, heartRate: null },
  }), 20000);
  const highHeld = nextRideCoachCue(highStart.state, snapshot({
    metrics: { cadence: metric(115), speed: null, heartRate: null },
  }), 35000);
  assert.match(highHeld.cue, /踏频 115，偏高/);
  assert.match(highHeld.cue, /放松踩踏/);
});

test('暂停态不播报且不在恢复后补播暂停期间里程碑', () => {
  const paused = nextRideCoachCue(null, snapshot({
    elapsedMs: 300000,
    distanceM: 5000,
    paused: true,
  }), 300000);
  assert.equal(paused.cue, null);
  assert.equal(paused.state.elapsedMilestone, 1);
  assert.equal(paused.state.distanceMilestone, 1);

  const resumed = nextRideCoachCue(paused.state, snapshot({
    elapsedMs: 301000,
    distanceM: 5010,
  }), 301000);
  assert.equal(resumed.cue, null);
});

test('nextRideCoachCue 是纯函数，不修改调用方 state', () => {
  const state = Object.freeze({
    elapsedMilestone: 0,
    distanceMilestone: 0,
    cadenceBand: 'normal',
  });
  const result = nextRideCoachCue(state, snapshot({
    elapsedMs: 300000,
  }), 300000);
  assert.notEqual(result.state, state);
  assert.deepEqual(state, {
    elapsedMilestone: 0,
    distanceMilestone: 0,
    cadenceBand: 'normal',
  });
  assert.equal(
    RIDE_COACH_LIMITS.globalCueIntervalMs,
    60000,
  );
});

test('骑后建议按聚合踏频给可执行建议，并明确估算来源', () => {
  const advice = buildPostRideAdvice({
    elapsedMs: 1800000,
    distanceM: 12000,
    avgSpeedKmh: 24,
    avgCadenceRpm: 64,
    sources: ['imu'],
    distanceSources: ['imu'],
    cadenceSources: ['imu'],
  });
  assert.equal(advice.headline, '尝试轻档稳踩');
  assert.match(advice.detail, /平均踏频 64/);
  assert.match(advice.detail, /减档/);
  assert.match(advice.sourceNote, /本地规则/);
  assert.match(advice.sourceNote, /眼镜 IMU 估算/);
  assert.doesNotMatch(
    Object.values(advice).join(''),
    /AI|智能生成|天气/,
  );
});

test('骑后数据不足时不编造表现或训练结论', () => {
  const advice = buildPostRideAdvice(null);
  assert.deepEqual(Object.keys(advice), ['headline', 'detail', 'sourceNote']);
  assert.equal(advice.headline, '骑行建议');
  assert.match(advice.detail, /数据不足/);
  assert.doesNotMatch(
    Object.values(advice).join(''),
    /提升|下降|高强度|间歇|AI|天气/,
  );
});

test('骑后建议与语音跳过会舍入成零的极小值', () => {
  const advice = buildPostRideAdvice({
    elapsedMs: 60000,
    distanceM: 0.4,
    avgSpeedKmh: 0.04,
    avgCadenceRpm: 0.4,
    avgPowerW: 0.4,
    avgBpm: 0.4,
  });
  const adviceText = Object.values(advice).join(' ');
  assert.doesNotMatch(adviceText, /0\.00|0\.0|平均踏频 0|平均功率 0|平均心率 0/);
  assert.match(advice.detail, /骑行 01:00/);

  const cue = nextRideCoachCue(null, snapshot({
    elapsedMs: 300000,
    metrics: {
      speed: metric(0.04),
      cadence: metric(0.4),
      heartRate: metric(0.4),
    },
  }), 300000).cue;
  assert.match(cue, /骑行 5 分钟/);
  assert.doesNotMatch(cue, /速度 0|踏频 0|心率 0/);
});
