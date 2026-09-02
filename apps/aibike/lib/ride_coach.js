// AIBike 本地骑行教练规则。
//
// 设计边界：
// - 不调用网络、天气或模型服务，也不把规则文案称为 AI。
// - 实时播报只读取 CyclingMetrics.snapshot() 中 state === 'live' 的新鲜指标。
// - held、stale、unsupported、explicit_zero 与尚未确认的估算候选都不能进入播报。
// - 所有状态由调用方显式传回，函数不会修改入参，便于页面生命周期重建和单测。

import {
  MIN_DISTANCE_DISPLAY_M,
  formatDistanceKm,
  formatElapsed,
  formatSpeedKmh,
} from './ride_format.js';

export const RIDE_COACH_LIMITS = Object.freeze({
  globalCueIntervalMs: 60000,
  elapsedMilestoneMs: 5 * 60000,
  distanceMilestoneM: 5000,
  cadenceDeviationHoldMs: 15000,
  cadenceRepeatMs: 5 * 60000,
  cadenceLowRpm: 60,
  cadenceLowExitRpm: 65,
  cadenceHighRpm: 110,
  cadenceHighExitRpm: 105,
});

const METRIC_FRESH_MS = Object.freeze({
  speed: 5000,
  cadence: 8000,
  heartRate: 8000,
});

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function nonNegative(value) {
  const numeric = finite(value);
  return numeric != null && numeric >= 0 ? numeric : null;
}

function positive(value) {
  const numeric = finite(value);
  return numeric != null && numeric > 0 ? numeric : null;
}

function atLeast(value, minimum) {
  const numeric = positive(value);
  return numeric != null && numeric >= minimum ? numeric : null;
}

function booleanCapability(source, keys) {
  for (let index = 0; index < keys.length; index += 1) {
    const value = source[keys[index]];
    if (value === true || value === false) return value;
  }
  return null;
}

function anyTrueCapability(source, keys) {
  for (let index = 0; index < keys.length; index += 1) {
    if (source[keys[index]] === true) return true;
  }
  return false;
}

/**
 * 生成骑前的本地准备文案。
 *
 * capabilities 支持以下布尔字段：
 * imuReady、heartRateConnected，以及 cyclingSensorConnected/
 * cscConnected/cpsConnected/ftmsConnected。
 * 没有明确 true/false 的能力不会被推断为“已就绪”或“不可用”。
 */
export function buildPreRideBrief(lastSummary, capabilities) {
  const summary = lastSummary && typeof lastSummary === 'object'
    ? lastSummary : {};
  const caps = capabilities && typeof capabilities === 'object'
    ? capabilities : {};

  let previous = '';
  const previousDistanceM = positive(summary.distanceM);
  const previousElapsedMs = positive(summary.elapsedMs);
  if (previousDistanceM != null) {
    previous = previousDistanceM < MIN_DISTANCE_DISPLAY_M
      ? '上次骑行距离很短；'
      : `上次骑行 ${formatDistanceKm(previousDistanceM)} 公里；`;
  } else if (previousElapsedMs != null) {
    previous = `上次骑行 ${formatElapsed(previousElapsedMs)}；`;
  }

  const imuReady = booleanCapability(caps, ['imuReady']);
  const heartRateConnected = anyTrueCapability(
    caps,
    ['heartRateConnected', 'hrsConnected'],
  );
  const cyclingSensorConnected = anyTrueCapability(
    caps,
    [
      'cyclingSensorConnected',
      'cscConnected',
      'cpsConnected',
      'ftmsConnected',
    ],
  );

  const status = [];
  if (cyclingSensorConnected) status.push('骑行传感器已连接');
  else if (imuReady === true) status.push('眼镜可辅助估算踏频');

  if (heartRateConnected) status.push('心率已连接');
  if (!status.length) status.push('先确认眼镜传感器与设备');

  const action = !cyclingSensorConnected
    ? '速度与距离将由眼镜 IMU 保守估算。'
    : '起步后注意路况。';
  return `${previous}${status.join('，')}，${action}`;
}

function normalizedCoachState(value) {
  const source = value && typeof value === 'object' ? value : {};
  const cadenceBand = ['unknown', 'normal', 'low', 'high']
    .includes(source.cadenceBand)
    ? source.cadenceBand : 'unknown';
  const lastCadenceCueBand = ['low', 'high']
    .includes(source.lastCadenceCueBand)
    ? source.lastCadenceCueBand : null;
  return {
    elapsedMilestone: Math.max(
      0,
      Math.floor(nonNegative(source.elapsedMilestone) ?? 0),
    ),
    distanceMilestone: Math.max(
      0,
      Math.floor(nonNegative(source.distanceMilestone) ?? 0),
    ),
    cadenceBand,
    cadenceBandSinceMs: nonNegative(source.cadenceBandSinceMs),
    lastCueAtMs: nonNegative(source.lastCueAtMs),
    lastCadenceCueAtMs: nonNegative(source.lastCadenceCueAtMs),
    lastCadenceCueBand,
  };
}

function metricCandidateFlag(metric) {
  const candidateText = [
    metric.state,
    metric.status,
    metric.quality,
    metric.mode,
    metric.source,
  ].some((value) => (
    typeof value === 'string' && value.toLowerCase().includes('candidate')
  ));
  return candidateText
    || metric.candidate === true
    || metric.isCandidate === true
    || metric.estimatedCandidate === true
    || metric.final === false;
}

function liveMetric(snapshot, name, nowMs) {
  const metrics = snapshot && snapshot.metrics;
  const metric = metrics && metrics[name];
  if (!metric || typeof metric !== 'object'
      || metric.state !== 'live'
      || metric.held === true
      || metric.isHeld === true
      || metric.fresh === false
      || metricCandidateFlag(metric)) {
    return null;
  }

  const value = positive(metric.value);
  if (value == null) return null;
  if (name === 'speed' && value < 0.5) return null;
  if (name === 'cadence' && value < 1) return null;
  if (name === 'heartRate' && value < 20) return null;
  if (name === 'speed' && value > 150) return null;
  if (name === 'cadence' && value > 250) return null;
  if (name === 'heartRate' && (value < 20 || value > 240)) return null;

  const maxAgeMs = METRIC_FRESH_MS[name];
  const explicitAgeMs = nonNegative(metric.ageMs);
  const observedAtMs = nonNegative(metric.atMs);
  const expiresAtMs = nonNegative(metric.expiresAtMs);
  let fresh = false;
  if (explicitAgeMs != null) {
    fresh = explicitAgeMs <= maxAgeMs;
  } else if (observedAtMs != null && nowMs >= observedAtMs) {
    fresh = nowMs - observedAtMs <= maxAgeMs;
  } else if (expiresAtMs != null) {
    fresh = nowMs <= expiresAtMs;
  } else {
    fresh = metric.fresh === true;
  }
  if (!fresh || (expiresAtMs != null && nowMs > expiresAtMs)) return null;
  return value;
}

function cadenceBandFor(value, previousBand) {
  if (value == null) return 'unknown';
  if (previousBand === 'low' && value < RIDE_COACH_LIMITS.cadenceLowExitRpm) {
    return 'low';
  }
  if (previousBand === 'high' && value > RIDE_COACH_LIMITS.cadenceHighExitRpm) {
    return 'high';
  }
  if (value < RIDE_COACH_LIMITS.cadenceLowRpm) return 'low';
  if (value > RIDE_COACH_LIMITS.cadenceHighRpm) return 'high';
  return 'normal';
}

function milestoneMetricText(metrics, preference) {
  for (let index = 0; index < preference.length; index += 1) {
    const name = preference[index];
    const value = metrics[name];
    if (value == null) continue;
    if (name === 'speed') return `速度 ${formatSpeedKmh(value)}`;
    if (name === 'cadence') return `踏频 ${Math.round(value)}`;
    if (name === 'heartRate') return `心率 ${Math.round(value)}`;
  }
  return '';
}

/**
 * 生成下一条骑中提示。
 *
 * snapshot 直接接 CyclingMetrics.snapshot()。cue 为短中文字符串或 null；
 * state 必须由调用方保存并传入下一拍。累计时长/距离只触发每 5 分钟或
 * 每 5 公里的边沿事件；所有播报全局至少间隔 60 秒。
 */
export function nextRideCoachCue(state, snapshot, now) {
  const previous = normalizedCoachState(state);
  const nowMs = nonNegative(now);
  if (nowMs == null || !snapshot || typeof snapshot !== 'object') {
    return { state: previous, cue: null };
  }

  // 遇到时钟回拨时丢弃未来冷却点，避免后续一直无法播报。
  const next = {
    ...previous,
    lastCueAtMs: previous.lastCueAtMs != null
      && previous.lastCueAtMs <= nowMs ? previous.lastCueAtMs : null,
    lastCadenceCueAtMs: previous.lastCadenceCueAtMs != null
      && previous.lastCadenceCueAtMs <= nowMs
      ? previous.lastCadenceCueAtMs : null,
  };

  const elapsedMs = nonNegative(snapshot.elapsedMs) ?? 0;
  const distanceM = nonNegative(snapshot.distanceM) ?? 0;
  const elapsedMilestone = Math.floor(
    elapsedMs / RIDE_COACH_LIMITS.elapsedMilestoneMs,
  );
  const distanceMilestone = Math.floor(
    distanceM / RIDE_COACH_LIMITS.distanceMilestoneM,
  );
  const elapsedDue = elapsedMilestone >= 1
    && elapsedMilestone > next.elapsedMilestone;
  const distanceDue = distanceMilestone >= 1
    && distanceMilestone > next.distanceMilestone;
  next.elapsedMilestone = Math.max(next.elapsedMilestone, elapsedMilestone);
  next.distanceMilestone = Math.max(next.distanceMilestone, distanceMilestone);

  const live = {
    speed: liveMetric(snapshot, 'speed', nowMs),
    cadence: liveMetric(snapshot, 'cadence', nowMs),
    heartRate: liveMetric(snapshot, 'heartRate', nowMs),
  };
  const cadenceBand = cadenceBandFor(live.cadence, next.cadenceBand);
  if (cadenceBand !== next.cadenceBand
      || next.cadenceBandSinceMs == null
      || next.cadenceBandSinceMs > nowMs) {
    next.cadenceBand = cadenceBand;
    next.cadenceBandSinceMs = nowMs;
  }

  const cadenceHeldLongEnough = (cadenceBand === 'low' || cadenceBand === 'high')
    && nowMs - next.cadenceBandSinceMs
      >= RIDE_COACH_LIMITS.cadenceDeviationHoldMs;
  const cadenceRepeatReady = next.lastCadenceCueAtMs == null
    || next.lastCadenceCueBand !== cadenceBand
    || nowMs - next.lastCadenceCueAtMs
      >= RIDE_COACH_LIMITS.cadenceRepeatMs;
  const cadenceDue = cadenceHeldLongEnough && cadenceRepeatReady;

  // 暂停时只消费已经跨过的里程碑，避免恢复后补播旧状态。
  if (snapshot.paused === true) return { state: next, cue: null };

  const globalReady = next.lastCueAtMs == null
    || nowMs - next.lastCueAtMs >= RIDE_COACH_LIMITS.globalCueIntervalMs;
  if (!globalReady) return { state: next, cue: null };

  let cue = null;
  if (cadenceDue) {
    cue = cadenceBand === 'low'
      ? `踏频 ${Math.round(live.cadence)}，偏低，试着减档。`
      : `踏频 ${Math.round(live.cadence)}，偏高，放松踩踏。`;
    next.lastCadenceCueAtMs = nowMs;
    next.lastCadenceCueBand = cadenceBand;
  } else if (distanceDue) {
    const metricText = milestoneMetricText(
      live,
      ['speed', 'cadence', 'heartRate'],
    );
    cue = `已骑 ${distanceMilestone * 5} 公里`
      + (metricText ? `，${metricText}。` : '，保持节奏。');
  } else if (elapsedDue) {
    const metricText = milestoneMetricText(
      live,
      ['cadence', 'heartRate', 'speed'],
    );
    cue = `骑行 ${elapsedMilestone * 5} 分钟`
      + (metricText ? `，${metricText}。` : '，注意路况。');
  }

  if (cue) next.lastCueAtMs = nowMs;
  return { state: next, cue };
}

function normalizedSources(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.toLowerCase());
}

function postRideSourceNote(summary) {
  const allSources = normalizedSources(summary.sources);
  const distanceSources = normalizedSources(summary.distanceSources);
  const cadenceSources = normalizedSources(summary.cadenceSources);
  const hasImu = [...allSources, ...distanceSources, ...cadenceSources]
    .some((source) => source === 'imu' || source === 'imuestimate');
  if (hasImu) return '本地规则；踏频或距离含眼镜 IMU 估算。';
  return '本地规则；仅依据本次聚合数据。';
}

/**
 * 生成结构化骑后建议。只解释本场聚合结果，不诊断、不比较不存在的历史数据。
 */
export function buildPostRideAdvice(summary) {
  const value = summary && typeof summary === 'object' ? summary : {};
  const elapsedMs = positive(value.elapsedMs);
  const distanceM = atLeast(value.distanceM, 5);
  const avgSpeedKmh = atLeast(value.avgSpeedKmh, 0.05);
  const avgCadenceRpm = atLeast(value.avgCadenceRpm, 0.5);
  const avgPowerW = atLeast(value.avgPowerW, 0.5);
  const avgBpm = atLeast(value.avgBpm, 20);
  const sourceNote = postRideSourceNote(value);

  if (elapsedMs == null && distanceM == null
      && avgCadenceRpm == null && avgPowerW == null && avgBpm == null) {
    return {
      headline: '骑行建议',
      detail: '有效聚合数据不足，先确认眼镜传感器与设备。',
      sourceNote,
    };
  }

  if (avgCadenceRpm != null && avgCadenceRpm < 70) {
    return {
      headline: '尝试轻档稳踩',
      detail: `平均踏频 ${Math.round(avgCadenceRpm)}，下次可适当减档。`,
      sourceNote,
    };
  }
  if (avgCadenceRpm != null && avgCadenceRpm > 105) {
    return {
      headline: '放松踩踏动作',
      detail: `平均踏频 ${Math.round(avgCadenceRpm)}，下次注意圆顺发力。`,
      sourceNote,
    };
  }
  if (avgCadenceRpm != null) {
    return {
      headline: '踏频处于常用区间',
      detail: `平均踏频 ${Math.round(avgCadenceRpm)}，下次先保持相近时长。`,
      sourceNote,
    };
  }
  if (avgPowerW != null) {
    return {
      headline: '保留功率基线',
      detail: `平均功率 ${Math.round(avgPowerW)} 瓦，下次可同路线对比。`,
      sourceNote,
    };
  }
  if (avgBpm != null) {
    return {
      headline: '做好骑后恢复',
      detail: `平均心率 ${Math.round(avgBpm)}，骑后补水并逐步放松。`,
      sourceNote,
    };
  }
  if (distanceM != null && distanceM > 0) {
    const speedText = avgSpeedKmh != null
      ? `，均速 ${formatSpeedKmh(avgSpeedKmh)}` : '';
    return {
      headline: '完成本次骑行',
      detail: `本次 ${formatDistanceKm(distanceM)} 公里${speedText}，下次保持相近时长。`,
      sourceNote,
    };
  }
  return {
    headline: '完成本次骑行',
    detail: `本次骑行 ${formatElapsed(elapsedMs ?? 0)}，结束后逐步放松。`,
    sourceNote,
  };
}
