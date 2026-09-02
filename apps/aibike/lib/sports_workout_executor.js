import { formatSportsWorkoutTarget, normalizeSportsWorkoutPlan } from './sports_workout.js';

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function metric(snapshot, name) {
  const item = snapshot && snapshot.metrics && snapshot.metrics[name];
  if (!item || item.state !== 'live' || item.fresh === false || item.held === true) return null;
  return finite(item.value);
}

function normalizedSensorSource(source) {
  if (['hrs', 'csc', 'cps', 'ftms', 'gps', 'imu'].includes(source)) return source;
  return source === 'cadence_model' ? 'imu' : '';
}

function liveSensorSources(snapshot) {
  const result = [];
  const metrics = snapshot && snapshot.metrics && typeof snapshot.metrics === 'object'
    ? snapshot.metrics : {};
  for (const item of Object.values(metrics)) {
    if (!item || item.state !== 'live' || item.fresh === false || item.held === true) continue;
    const source = normalizedSensorSource(item.source);
    if (source && !result.includes(source)) result.push(source);
  }
  return result;
}

export function availableSportsTargets(snapshot) {
  const power = metric(snapshot, 'power');
  const cadence = metric(snapshot, 'cadence');
  const heart = metric(snapshot, 'heartRate');
  const speed = metric(snapshot, 'speed');
  return {
    power: power != null && ['cps', 'ftms'].includes(snapshot.metrics.power.source),
    // Only committed cycling sensor data may authorize a frozen cadence
    // prescription. IMU cadence remains useful for local HUD/recording but is
    // not safe enough to judge server-directed target adherence.
    cadence: cadence != null
      && ['csc', 'cps', 'ftms'].includes(snapshot.metrics.cadence.source),
    imuCadence: cadence != null && snapshot.metrics.cadence.source === 'imu',
    heartRate: heart != null,
    speed: speed != null,
  };
}

function heartZone(bpm, maxHeartRateBpm) {
  const value = finite(bpm);
  const maximum = finite(maxHeartRateBpm);
  if (value == null || maximum == null || maximum < 120 || maximum > 230) return null;
  const ratio = value / maximum;
  if (ratio < 0.6) return 1;
  if (ratio < 0.7) return 2;
  if (ratio < 0.8) return 3;
  if (ratio < 0.9) return 4;
  return 5;
}

export function selectSportsWorkoutTarget(stage, snapshot, options = {}) {
  const available = availableSportsTargets(snapshot);
  const target = stage && stage.target;
  if (!target) return { kind: 'none', available, label: '按体感轻松骑' };
  if (available.power && target.power_min_w != null) return {
    kind: 'power', value: metric(snapshot, 'power'), min: target.power_min_w,
    max: target.power_max_w, available, label: formatSportsWorkoutTarget(target, available),
  };
  if (available.cadence && target.cadence_min_rpm != null) return {
    kind: 'cadence', value: metric(snapshot, 'cadence'), min: target.cadence_min_rpm,
    max: target.cadence_max_rpm, available, label: formatSportsWorkoutTarget(target, available),
  };
  // Zone targets are affirmative coaching. They may only use the maximum HR
  // frozen by Hermes with authoritative provenance, never the local picker or
  // an age/default estimate.
  if (options.heartRateAuthoritative === true
      && available.heartRate && target.heart_zone_min != null) return {
    kind: 'heart', value: heartZone(
      metric(snapshot, 'heartRate'),
      options.maxHeartRateBpm,
    ), min: target.heart_zone_min,
    max: target.heart_zone_max, available, label: formatSportsWorkoutTarget(target, available),
  };
  // Outdoor speed remains a recorded metric, never an instruction to
  // accelerate: slope, wind and traffic make it unsafe as a fallback target.
  if (target.effort_min != null) return {
    kind: 'effort', value: null, min: target.effort_min,
    max: target.effort_max, available,
    label: `体感 ${Math.round(target.effort_min)}–${Math.round(target.effort_max)} / 10`,
  };
  return { kind: 'none', value: null, available, label: '目标数据暂不可用' };
}

export function createSportsWorkoutExecutor(plan, startedAtMs = Date.now()) {
  const normalized = normalizeSportsWorkoutPlan(plan);
  if (!normalized) return null;
  return {
    plan: normalized,
    maxHeartRateBpm: null,
    heartRateAuthoritative: false,
    startedAtMs: Number(startedAtMs),
    stageIndex: 0,
    lastElapsedMs: 0,
    targetHoldMs: 0,
    stageResults: normalized.stages.map((stage) => ({
      stage_id: stage.stage_id,
      duration_sec: 0,
      distance_m: 0,
      target_live_sec: 0,
      target_in_range_sec: 0,
      source_live_sec: 0,
      speed_value_sec: 0,
      speed_live_sec: 0,
      cadence_value_sec: 0,
      cadence_live_sec: 0,
      power_value_sec: 0,
      power_live_sec: 0,
      heart_value_sec: 0,
      heart_live_sec: 0,
    })),
    lastDistanceM: null,
    sourceLiveMs: {},
    complete: false,
  };
}

export function updateSportsWorkoutExecutor(state, snapshot, options = {}) {
  if (!state || state.complete || !snapshot) return state;
  const elapsedMs = Math.max(0, finite(snapshot.elapsedMs) || 0);
  // CyclingMetrics.elapsedMs 已排除暂停/隐藏时间，因此宿主 ticker 延迟时也
  // 应按真实有效时长追进，不能用回调间隔上限吞掉训练阶段时间。
  const deltaMs = Math.max(0, elapsedMs - state.lastElapsedMs);
  state.lastElapsedMs = elapsedMs;
  const distance = finite(snapshot.distanceM);
  const distanceDelta = distance != null && state.lastDistanceM != null
    && distance >= state.lastDistanceM ? distance - state.lastDistanceM : 0;
  for (const source of liveSensorSources(snapshot)) {
    state.sourceLiveMs[source] = (Number(state.sourceLiveMs[source]) || 0) + deltaMs;
  }
  let remainingMs = deltaMs;
  while (remainingMs > 0 && !state.complete) {
    const stage = state.plan.stages[state.stageIndex];
    const result = state.stageResults[state.stageIndex];
    const stageRemainingMs = stage.duration_sec * 1000 - result.duration_sec * 1000;
    const consumeMs = Math.min(remainingMs, Math.max(0, stageRemainingMs));
    const target = selectSportsWorkoutTarget(stage, snapshot, {
      maxHeartRateBpm: options.maxHeartRateBpm || state.maxHeartRateBpm,
      heartRateAuthoritative: options.heartRateAuthoritative === true
        || state.heartRateAuthoritative === true,
    });
    const consumeSec = consumeMs / 1000;
    result.duration_sec += consumeSec;
    if (deltaMs > 0 && distanceDelta > 0) {
      result.distance_m += distanceDelta * consumeMs / deltaMs;
    }
    const speed = metric(snapshot, 'speed');
    const cadence = metric(snapshot, 'cadence');
    const power = metric(snapshot, 'power');
    const heart = metric(snapshot, 'heartRate');
    if (speed != null) {
      result.speed_value_sec += speed * consumeSec;
      result.speed_live_sec += consumeSec;
    }
    if (heart != null) {
      result.heart_value_sec += heart * consumeSec;
      result.heart_live_sec += consumeSec;
    }
    if (cadence != null) {
      result.cadence_value_sec += cadence * consumeSec;
      result.cadence_live_sec += consumeSec;
    }
    if (power != null) {
      result.power_value_sec += power * consumeSec;
      result.power_live_sec += consumeSec;
    }
    if (target.kind !== 'none' && target.value != null) {
      result.source_live_sec += consumeMs / 1000;
      result.target_live_sec += consumeMs / 1000;
      if (target.value != null && target.value >= target.min && target.value <= target.max) {
        result.target_in_range_sec += consumeMs / 1000;
      }
    }
    remainingMs -= consumeMs;
    if (result.duration_sec * 1000 + 1 >= stage.duration_sec * 1000) {
      if (state.stageIndex >= state.plan.stages.length - 1) state.complete = true;
      else state.stageIndex += 1;
    }
    if (consumeMs <= 0 && !state.complete) state.stageIndex += 1;
  }
  if (distance != null) state.lastDistanceM = distance;
  return state;
}

export function sportsWorkoutHud(state, snapshot, options = {}) {
  if (!state) return { visible: false, title: '', remaining: '', target: '' };
  const stage = state.plan.stages[Math.min(state.stageIndex, state.plan.stages.length - 1)];
  const result = state.stageResults[Math.min(state.stageIndex, state.stageResults.length - 1)];
  const remainingSec = Math.max(0, Math.ceil(stage.duration_sec - result.duration_sec));
  const minutes = Math.floor(remainingSec / 60);
  const seconds = String(remainingSec % 60).padStart(2, '0');
  return {
    visible: true,
    title: stage.title,
    remaining: `${minutes}:${seconds}`,
    target: selectSportsWorkoutTarget(stage, snapshot, {
      maxHeartRateBpm: options.maxHeartRateBpm || state.maxHeartRateBpm,
      heartRateAuthoritative: options.heartRateAuthoritative === true
        || state.heartRateAuthoritative === true,
    }).label,
  };
}

export function finalizeSportsWorkout(state) {
  if (!state) return null;
  const totalSec = state.stageResults.reduce((sum, item) => sum + item.duration_sec, 0);
  const prescribedSec = state.plan.stages.reduce((sum, item) => sum + item.duration_sec, 0);
  const liveSec = state.stageResults.reduce((sum, item) => sum + item.target_live_sec, 0);
  const inRangeSec = state.stageResults.reduce((sum, item) => sum + item.target_in_range_sec, 0);
  const sourceCoverage = {};
  for (const [source, durationMs] of Object.entries(state.sourceLiveMs || {})) {
    if (totalSec > 0 && Number(durationMs) > 0) {
      sourceCoverage[source] = Math.min(100, Math.round(Number(durationMs) / 1000 / totalSec * 100));
    }
  }
  return {
    workout_id: state.plan.workout_id,
    revision: state.plan.revision,
    completion_percent: prescribedSec > 0 ? Math.min(100, Math.round(totalSec / prescribedSec * 100)) : 0,
    target_percent: liveSec > 0 ? Math.round(inRangeSec / liveSec * 100) : null,
    source_coverage_percent: totalSec > 0 ? Math.round(liveSec / totalSec * 100) : 0,
    source_coverage: sourceCoverage,
    sensor_sources: Object.keys(sourceCoverage),
    stage_results: state.stageResults.map((item, index) => {
      const metrics = {};
      if (item.speed_live_sec > 0) {
        metrics.avg_speed_kmh = Number(
          (item.speed_value_sec / item.speed_live_sec).toFixed(3),
        );
      }
      if (item.heart_live_sec > 0) {
        metrics.avg_heart_rate_bpm = Number(
          (item.heart_value_sec / item.heart_live_sec).toFixed(3),
        );
      }
      if (item.cadence_live_sec > 0) {
        metrics.avg_cadence_rpm = Number(
          (item.cadence_value_sec / item.cadence_live_sec).toFixed(3),
        );
      }
      if (item.power_live_sec > 0) {
        metrics.avg_power_w = Number(
          (item.power_value_sec / item.power_live_sec).toFixed(3),
        );
      }
      return {
        stage_id: item.stage_id,
        status: item.duration_sec + 0.5 >= state.plan.stages[index].duration_sec
          ? 'completed' : 'partial',
        duration_sec: Math.round(item.duration_sec),
        distance_m: Math.max(0, Number(item.distance_m.toFixed(1))),
        metrics,
      };
    }),
  };
}
