// Pure staged-workout executor. It consumes the existing monotonic SmartRun
// distance ledger; it never integrates GPS/RSC/IMU by itself and therefore
// cannot become a second distance system.

import {
  normalizeWorkoutOwner,
  normalizeWorkoutPlan,
  sameWorkoutOwner,
} from './workout_contract.js';

const EXECUTION_STATUSES = new Set(['running', 'paused', 'plan_complete', 'finished']);
const OUTCOME_STATUSES = new Set(['completed', 'partial', 'aborted']);
const STAGE_RESULT_STATUSES = new Set(['completed', 'partial', 'skipped']);
const ID_RE = /^[A-Za-z0-9._:-]{8,80}$/;

function finite(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= min && value <= max ? value : null;
}

function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hashText(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function createWorkoutExecutionId(plan, nowMs = Date.now(), nonce = '') {
  const source = String(plan && plan.workout_id || '') + ':'
    + String(plan && plan.revision || '') + ':' + String(nowMs) + ':' + String(nonce);
  return 'exec-' + Math.max(0, Math.trunc(nowMs)).toString(36) + '-' + hashText(source);
}

function emptyStageMetrics() {
  return {
    hr_sum: 0,
    hr_count: 0,
    cadence_sum: 0,
    cadence_count: 0,
  };
}

function normalizeMetricSums(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const result = {
    hr_sum: finite(raw.hr_sum, 0, 100_000_000),
    hr_count: integer(raw.hr_count, 0, 1_000_000),
    cadence_sum: finite(raw.cadence_sum, 0, 100_000_000),
    cadence_count: integer(raw.cadence_count, 0, 1_000_000),
  };
  return Object.values(result).some((value) => value === null) ? null : result;
}

function normalizeStageResult(raw, allowedStageIds) {
  if (!raw || typeof raw !== 'object' || !allowedStageIds.has(raw.stage_id)
      || !STAGE_RESULT_STATUSES.has(raw.status)) return null;
  const duration = integer(raw.duration_s, 0, 86_400);
  const distance = integer(raw.distance_m, 0, 200_000);
  if (duration === null || distance === null) return null;
  if (raw.status === 'skipped') {
    return {
      stage_id: raw.stage_id,
      status: 'skipped',
      duration_s: 0,
      distance_m: 0,
    };
  }
  const result = {
    stage_id: raw.stage_id,
    status: raw.status,
    duration_s: duration,
    distance_m: distance,
  };
  for (const [key, min, max] of [
    ['avg_pace_s', 1, 3_600],
    ['avg_hr', 20, 240],
    ['cadence_avg', 1, 300],
  ]) {
    if (raw[key] == null) continue;
    const value = integer(raw[key], min, max);
    if (value === null) return null;
    result[key] = value;
  }
  return result;
}

export function createWorkoutExecution(plan, owner, options = {}) {
  const normalizedOwner = normalizeWorkoutOwner(owner);
  const nowMs = finite(options.nowMs ?? Date.now(), 0);
  const normalizedPlan = normalizedOwner && nowMs !== null
    ? normalizeWorkoutPlan(plan, normalizedOwner, { nowMs }) : null;
  const suppliedId = typeof options.clientExecutionId === 'string'
    ? options.clientExecutionId.trim() : '';
  const clientExecutionId = ID_RE.test(suppliedId)
    ? suppliedId
    : createWorkoutExecutionId(normalizedPlan, nowMs ?? Date.now(), options.nonce);
  if (!normalizedOwner || !normalizedPlan || nowMs === null) return null;
  const initialDistanceM = finite(options.initialDistanceM, 0, 10_000_000);
  return {
    schema_version: 1,
    client_execution_id: clientExecutionId,
    owner: normalizedOwner,
    plan: clone(normalizedPlan),
    status: 'running',
    outcome: null,
    stage_index: 0,
    stage_results: [],
    started_at_ms: nowMs,
    ended_at_ms: null,
    active_elapsed_ms: 0,
    stage_elapsed_ms: 0,
    stage_distance_m: 0,
    last_event_at_ms: nowMs,
    active_anchor_ms: nowMs,
    distance_anchor_m: initialDistanceM,
    distance_ledger_id: 'motion-ledger-v1',
    stage_metrics: emptyStageMetrics(),
    pause_reason: '',
    final_prompt_pending: false,
  };
}

export function normalizeWorkoutExecution(raw, expectedOwner) {
  if (!raw || typeof raw !== 'object' || raw.schema_version !== 1) return null;
  const owner = normalizeWorkoutOwner(expectedOwner);
  if (!owner || !sameWorkoutOwner(raw.owner, owner)) return null;
  // Active snapshots remain immutable even if the plan expires while a long
  // run crosses midnight. Validate it at its own issuance boundary, not now.
  const rawPlan = raw.plan;
  const validationNow = rawPlan && Number.isFinite(rawPlan.issued_at_ms)
    ? rawPlan.issued_at_ms : 0;
  const plan = normalizeWorkoutPlan(rawPlan, owner, { nowMs: validationNow });
  if (!plan || !ID_RE.test(String(raw.client_execution_id || ''))
      || !EXECUTION_STATUSES.has(raw.status)) return null;
  const stageIndex = integer(raw.stage_index, 0, plan.stages.length - 1);
  const startedAtMs = integer(raw.started_at_ms, 0);
  const activeElapsedMs = finite(raw.active_elapsed_ms, 0, 7 * 86_400_000);
  const stageElapsedMs = finite(raw.stage_elapsed_ms, 0, 7 * 86_400_000);
  const stageDistanceM = finite(raw.stage_distance_m, 0, 1_000_000);
  const lastEventAtMs = integer(raw.last_event_at_ms, 0);
  const stageMetrics = normalizeMetricSums(raw.stage_metrics);
  if (stageIndex === null || startedAtMs === null || activeElapsedMs === null
      || stageElapsedMs === null || stageDistanceM === null
      || lastEventAtMs === null || !stageMetrics) return null;
  const allowedStageIds = new Set(plan.stages.map((stage) => stage.stage_id));
  if (!Array.isArray(raw.stage_results) || raw.stage_results.length > plan.stages.length) return null;
  const stageResults = raw.stage_results.map((result) => normalizeStageResult(result, allowedStageIds));
  if (stageResults.some((result) => !result)
      || new Set(stageResults.map((result) => result.stage_id)).size !== stageResults.length) return null;
  const activeAnchorMs = raw.active_anchor_ms == null
    ? null : integer(raw.active_anchor_ms, 0);
  const distanceAnchorM = raw.distance_anchor_m == null
    ? null : finite(raw.distance_anchor_m, 0, 10_000_000);
  const endedAtMs = raw.ended_at_ms == null ? null : integer(raw.ended_at_ms, startedAtMs);
  if (activeAnchorMs === null && raw.active_anchor_ms != null) return null;
  if (distanceAnchorM === null && raw.distance_anchor_m != null) return null;
  if (endedAtMs === null && raw.ended_at_ms != null) return null;
  const outcome = raw.outcome == null ? null : String(raw.outcome);
  if (outcome !== null && !OUTCOME_STATUSES.has(outcome)) return null;
  return {
    schema_version: 1,
    client_execution_id: raw.client_execution_id,
    owner,
    plan: clone(plan),
    status: raw.status,
    outcome,
    stage_index: stageIndex,
    stage_results: stageResults,
    started_at_ms: startedAtMs,
    ended_at_ms: endedAtMs,
    active_elapsed_ms: activeElapsedMs,
    stage_elapsed_ms: stageElapsedMs,
    stage_distance_m: stageDistanceM,
    last_event_at_ms: lastEventAtMs,
    active_anchor_ms: activeAnchorMs,
    distance_anchor_m: distanceAnchorM,
    distance_ledger_id: typeof raw.distance_ledger_id === 'string'
      ? raw.distance_ledger_id.slice(0, 80) : 'motion-ledger-v1',
    stage_metrics: stageMetrics,
    pause_reason: typeof raw.pause_reason === 'string' ? raw.pause_reason.slice(0, 32) : '',
    final_prompt_pending: raw.final_prompt_pending === true,
  };
}

export function restoreWorkoutExecution(raw, expectedOwner, nowMs = Date.now()) {
  const state = normalizeWorkoutExecution(raw, expectedOwner);
  const now = finite(nowMs, 0);
  if (!state || now === null || state.status === 'finished') return state;
  // Process-dead time is never active exercise time. The user deliberately
  // resumes through the existing start flow, which sends a resume event.
  state.status = state.status === 'plan_complete' ? 'plan_complete' : 'paused';
  state.active_anchor_ms = null;
  state.distance_anchor_m = null;
  state.last_event_at_ms = Math.max(state.last_event_at_ms, now);
  state.pause_reason = 'restart';
  return state;
}

function addMetricSample(state, event) {
  const bpm = finite(event.bpm, 20, 240);
  if (bpm !== null) {
    state.stage_metrics.hr_sum += bpm;
    state.stage_metrics.hr_count += 1;
  }
  const cadence = finite(event.cadenceSpm, 1, 300);
  if (cadence !== null) {
    state.stage_metrics.cadence_sum += cadence;
    state.stage_metrics.cadence_count += 1;
  }
}

function advanceClock(state, nowMs) {
  if (state.status !== 'running' || state.active_anchor_ms == null) return;
  const delta = Math.max(0, nowMs - state.active_anchor_ms);
  state.active_elapsed_ms += delta;
  state.stage_elapsed_ms += delta;
  state.active_anchor_ms = nowMs;
}

function stageResult(state, status) {
  if (status === 'skipped') {
    return {
      stage_id: state.plan.stages[state.stage_index].stage_id,
      status: 'skipped',
      duration_s: 0,
      distance_m: 0,
    };
  }
  const durationS = Math.max(0, Math.round(state.stage_elapsed_ms / 1000));
  const distanceM = Math.max(0, Math.round(state.stage_distance_m));
  const result = {
    stage_id: state.plan.stages[state.stage_index].stage_id,
    status,
    duration_s: Math.min(86_400, durationS),
    distance_m: Math.min(200_000, distanceM),
  };
  if (durationS > 0 && distanceM > 0) {
    result.avg_pace_s = Math.max(1, Math.min(3_600,
      Math.round(durationS / (distanceM / 1000))));
  }
  if (state.stage_metrics.hr_count > 0) {
    result.avg_hr = Math.max(20, Math.min(240,
      Math.round(state.stage_metrics.hr_sum / state.stage_metrics.hr_count)));
  }
  if (state.stage_metrics.cadence_count > 0) {
    result.cadence_avg = Math.max(1, Math.min(300,
      Math.round(state.stage_metrics.cadence_sum / state.stage_metrics.cadence_count)));
  }
  return result;
}

function maybeCompleteStage(state) {
  if (state.status !== 'running') return;
  const stage = state.plan.stages[state.stage_index];
  const durationReached = stage.duration_sec !== null
    && state.stage_elapsed_ms >= stage.duration_sec * 1000;
  const distanceReached = stage.distance_m !== null
    && state.stage_distance_m >= stage.distance_m;
  if (!durationReached && !distanceReached) return;
  state.stage_results.push(stageResult(state, 'completed'));
  if (state.stage_index >= state.plan.stages.length - 1) {
    state.status = 'plan_complete';
    state.final_prompt_pending = true;
    state.active_anchor_ms = null;
    state.distance_anchor_m = null;
    return;
  }
  state.stage_index += 1;
  state.stage_elapsed_ms = 0;
  state.stage_distance_m = 0;
  state.stage_metrics = emptyStageMetrics();
  state.distance_anchor_m = null;
  state.active_anchor_ms = state.last_event_at_ms;
}

export function advanceWorkoutExecution(rawState, event) {
  if (!rawState || !event || typeof event !== 'object') return rawState;
  const state = clone(rawState);
  if (state.status === 'finished') return state;
  const nowMs = integer(event.nowMs, 0);
  if (nowMs === null || nowMs < state.last_event_at_ms) return state;
  advanceClock(state, nowMs);
  state.last_event_at_ms = nowMs;

  switch (event.type) {
    case 'tick':
      if (state.status === 'running') addMetricSample(state, event);
      break;
    case 'distance': {
      if (state.status !== 'running') break;
      const distanceM = finite(event.distanceM, 0, 10_000_000);
      const ledgerId = typeof event.ledgerId === 'string'
        ? event.ledgerId.slice(0, 80) : 'motion-ledger-v1';
      if (distanceM === null) break;
      if (event.reanchor === true || ledgerId !== state.distance_ledger_id
          || state.distance_anchor_m == null || distanceM < state.distance_anchor_m) {
        state.distance_anchor_m = distanceM;
        state.distance_ledger_id = ledgerId;
        break;
      }
      const delta = distanceM - state.distance_anchor_m;
      // The upstream ledger is authoritative. This generous final sanity gate
      // only rejects a corrupt counter jump; it does not infer speed or source.
      if (delta > 1000) {
        state.distance_anchor_m = distanceM;
        break;
      }
      state.stage_distance_m += delta;
      state.distance_anchor_m = distanceM;
      break;
    }
    case 'source_change':
      state.distance_anchor_m = null;
      if (typeof event.ledgerId === 'string') {
        state.distance_ledger_id = event.ledgerId.slice(0, 80);
      }
      break;
    case 'pause':
    case 'hide':
      if (state.status === 'running') state.status = 'paused';
      state.active_anchor_ms = null;
      state.distance_anchor_m = null;
      state.pause_reason = event.type;
      break;
    case 'resume':
    case 'show':
      if (state.status === 'paused') {
        state.status = 'running';
        state.active_anchor_ms = nowMs;
        state.distance_anchor_m = null;
        state.pause_reason = '';
      }
      break;
    default:
      return rawState;
  }
  maybeCompleteStage(state);
  return state;
}

export function finishWorkoutExecution(rawState, nowMs = Date.now()) {
  const state = clone(rawState);
  if (!state || state.status === 'finished') return state;
  const now = integer(nowMs, 0);
  if (now === null || now < state.last_event_at_ms) return state;
  advanceClock(state, now);
  state.last_event_at_ms = now;
  const wasComplete = state.status === 'plan_complete';
  if (!wasComplete) {
    const hasProgress = state.stage_elapsed_ms > 0 || state.stage_distance_m > 0;
    const outcome = state.stage_results.length || hasProgress ? 'partial' : 'aborted';
    state.stage_results.push(stageResult(state, hasProgress ? 'partial' : 'skipped'));
    state.outcome = outcome;
  } else {
    state.outcome = 'completed';
  }
  state.status = 'finished';
  state.ended_at_ms = now;
  state.active_anchor_ms = null;
  state.distance_anchor_m = null;
  state.final_prompt_pending = wasComplete;
  return state;
}

export function workoutProgressView(state) {
  if (!state || !state.plan || !Array.isArray(state.plan.stages)) return null;
  const stage = state.plan.stages[state.stage_index];
  if (!stage) return null;
  const durationRatio = stage.duration_sec === null ? 0
    : state.stage_elapsed_ms / (stage.duration_sec * 1000);
  const distanceRatio = stage.distance_m === null ? 0
    : state.stage_distance_m / stage.distance_m;
  const progress = Math.max(durationRatio, distanceRatio);
  const percent = Math.max(0, Math.min(100, Math.floor(progress * 100)));
  let detail = percent + '%';
  if (stage.duration_sec !== null) {
    const remaining = Math.max(0, stage.duration_sec - Math.floor(state.stage_elapsed_ms / 1000));
    detail = Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0');
  } else if (stage.distance_m !== null) {
    detail = Math.max(0, Math.ceil(stage.distance_m - state.stage_distance_m)) + 'm';
  }
  return {
    planTitle: state.plan.title,
    stageTitle: stage.title,
    stageType: stage.type,
    stageNumber: state.stage_index + 1,
    stageCount: state.plan.stages.length,
    percent,
    detail,
    planComplete: state.status === 'plan_complete' || state.outcome === 'completed',
    finalPromptPending: state.final_prompt_pending === true,
  };
}
