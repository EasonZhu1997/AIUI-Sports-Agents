import { selectSportsWorkoutTarget } from './sports_workout_executor.js';

export const SPORTS_COACH_LIMITS = Object.freeze({
  targetHoldMs: 15000,
  globalCooldownMs: 75000,
  sourceLossHoldMs: 15000,
});

function normalized(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    stageIndex: Number.isSafeInteger(source.stageIndex) ? source.stageIndex : -1,
    outsideSinceMs: Number.isFinite(source.outsideSinceMs) ? source.outsideSinceMs : null,
    unavailableSinceMs: Number.isFinite(source.unavailableSinceMs)
      ? source.unavailableSinceMs : null,
    sourceLossAnnounced: source.sourceLossAnnounced === true,
    targetKind: typeof source.targetKind === 'string' ? source.targetKind : '',
    degradedSinceMs: Number.isFinite(source.degradedSinceMs)
      ? source.degradedSinceMs : null,
    lastCueAtMs: Number.isFinite(source.lastCueAtMs) ? source.lastCueAtMs : null,
  };
}

export function nextSportsCoachCue(state, executor, snapshot, options = {}) {
  const next = normalized(state);
  const now = Number(options.now == null ? Date.now() : options.now);
  if (!executor || !snapshot || !Number.isFinite(now) || snapshot.paused === true) {
    return { state: next, cue: null, reason: '' };
  }
  const globalReady = next.lastCueAtMs == null
    || now - next.lastCueAtMs >= SPORTS_COACH_LIMITS.globalCooldownMs;
  const stage = executor.plan.stages[executor.stageIndex];
  if (!stage) return { state: next, cue: null, reason: '' };

  if (next.stageIndex !== executor.stageIndex) {
    next.stageIndex = executor.stageIndex;
    next.outsideSinceMs = null;
    next.unavailableSinceMs = null;
    next.degradedSinceMs = null;
    next.targetKind = selectSportsWorkoutTarget(stage, snapshot, {
      maxHeartRateBpm: options.maxHeartRateBpm,
      heartRateAuthoritative: options.heartRateAuthoritative === true,
    }).kind;
    // Each stage owns one source-loss edge. A continuous `none` state must not
    // re-arm itself simply because the global cooldown has elapsed.
    next.sourceLossAnnounced = false;
    if (next.targetKind === 'none') next.unavailableSinceMs = now;
    if (globalReady) {
      next.lastCueAtMs = now;
      return { state: next, cue: `进入${stage.title}，${stage.cue || '保持稳定节奏'}。`, reason: 'stage' };
    }
  }

  const highHeart = snapshot.metrics && snapshot.metrics.heartRate;
  const maxHeartRate = Number(options.maxHeartRateBpm);
  if (highHeart && highHeart.state === 'live' && highHeart.fresh !== false
      && options.heartRateAuthoritative === true
      && Number.isFinite(maxHeartRate) && maxHeartRate >= 120 && maxHeartRate <= 230
      && Number(highHeart.value) >= maxHeartRate * 0.95 && globalReady) {
    next.lastCueAtMs = now;
    return { state: next, cue: '心率较高，请减小强度，感觉不适立即停车。', reason: 'safety' };
  }

  const target = selectSportsWorkoutTarget(stage, snapshot, {
    maxHeartRateBpm: options.maxHeartRateBpm,
    heartRateAuthoritative: options.heartRateAuthoritative === true,
  });
  // An effort-only fallback is an explicit, executable instruction but has no
  // trusted sensor value.  Show it on the HUD and avoid pretending that the
  // glasses measured adherence or repeatedly announcing source loss.
  if (target.kind === 'effort') {
    next.targetKind = 'effort';
    next.outsideSinceMs = null;
    next.unavailableSinceMs = null;
    next.sourceLossAnnounced = false;
    next.degradedSinceMs = null;
    return { state: next, cue: null, reason: '' };
  }
  if (target.kind === 'none') {
    next.outsideSinceMs = null;
    if (next.unavailableSinceMs == null) next.unavailableSinceMs = now;
    if (!next.sourceLossAnnounced
        && globalReady
        && now - next.unavailableSinceMs >= SPORTS_COACH_LIMITS.sourceLossHoldMs) {
      next.lastCueAtMs = now;
      next.targetKind = 'none';
      next.sourceLossAnnounced = true;
      return { state: next, cue: '目标数据暂不可用，按体感轻松骑，注意路况。', reason: 'source' };
    }
    return { state: next, cue: null, reason: '' };
  }
  next.unavailableSinceMs = null;
  // Only a real executable target recovery (or a new stage above) may re-arm
  // a future source-loss announcement.
  next.sourceLossAnnounced = false;
  const rank = { power: 4, cadence: 3, heart: 2, effort: 1, none: 0 };
  if (next.targetKind && next.targetKind !== 'none'
      && target.kind !== next.targetKind
      && rank[target.kind] < rank[next.targetKind]) {
    if (next.degradedSinceMs == null) next.degradedSinceMs = now;
    if (now - next.degradedSinceMs < SPORTS_COACH_LIMITS.sourceLossHoldMs
        || !globalReady) {
      return { state: next, cue: null, reason: '' };
    }
    const oldLabel = next.targetKind === 'power' ? '功率'
      : next.targetKind === 'cadence' ? '踏频'
        : next.targetKind === 'heart' ? '心率区间' : '速度';
    const nextLabel = target.kind === 'power' ? '功率'
      : target.kind === 'cadence' ? '踏频'
        : target.kind === 'heart' ? '心率区间' : '体感';
    next.targetKind = target.kind;
    next.degradedSinceMs = null;
    next.lastCueAtMs = now;
    return {
      state: next,
      cue: `${oldLabel}数据中断，改用${nextLabel}目标。`,
      reason: 'degraded',
    };
  }
  next.targetKind = target.kind;
  next.degradedSinceMs = null;
  const outside = target.value != null
    && (target.value < target.min || target.value > target.max);
  if (!outside) {
    next.outsideSinceMs = null;
    return { state: next, cue: null, reason: '' };
  }
  if (next.outsideSinceMs == null) next.outsideSinceMs = now;
  if (!globalReady || now - next.outsideSinceMs < SPORTS_COACH_LIMITS.targetHoldMs) {
    return { state: next, cue: null, reason: '' };
  }
  next.lastCueAtMs = now;
  next.outsideSinceMs = now;
  const low = target.value < target.min;
  const label = target.kind === 'power' ? '功率'
    : target.kind === 'cadence' ? '踏频'
      : target.kind === 'heart' ? '心率区间' : '速度';
  return {
    state: next,
    cue: `${label}${low ? '偏低，平稳提高一点' : '偏高，稍微放松一点'}。`,
    reason: 'target',
  };
}
