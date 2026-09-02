// SmartRun Super Coach V2 plan contract.
//
// The parser is deliberately a whitelist: an LLM or a legacy prose plan may
// describe a workout, but only a server-issued schema-v2 plan with explicit,
// bounded stages is executable on the glasses.

import { DEFAULT_BASE_URL, normalizeBaseUrl } from './coach_api.js';
import { normalizeWxJsonResponse } from './wx_json.js';
import { normalizeHeartRatePolicy } from './heart_rate_policy.js';

export const CURRENT_WORKOUT_PATH = '/api/coach-svc/coach/aiui-workouts/current';
export const WORKOUT_SCHEMA_VERSION = 2;
export const WORKOUT_MAX_FUTURE_SKEW_MS = 60_000;
export const WORKOUT_MAX_REMAINING_TTL_MS = 36 * 60 * 60 * 1000;

const PLAN_TYPES = new Set([
  'free', 'easy', 'slow_jog', 'recovery', 'steady', 'tempo', 'interval', 'long',
]);
const EXECUTABLE_PLAN_STATUSES = new Set(['planned', 'accepted']);
const TERMINAL_PLAN_STATUSES = new Set(['skipped', 'completed', 'partial']);
const STAGE_TYPES = new Set(['warmup', 'work', 'recovery', 'cooldown', 'free']);

// These identifiers are persisted and compared across Hermes, Android and
// AIUI. Keep their grammar exact instead of accepting generic opaque strings:
// otherwise a damaged cache entry can become executable on the glasses but be
// impossible for Hermes to acknowledge later.
export const WORKOUT_ID_RE = /^wrk_[0-9a-f]{24}$/;
export const PLAN_ID_RE = /^plan_[1-9][0-9]{0,18}$/;
export const PLAN_SESSION_ID_RE = /^ps_[0-9a-f]{24}$/;
export const WORKOUT_STAGE_ID_RE = /^stg_[0-9a-f]{24}$/;

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteInteger(value, min, max, { nullable = true } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)
      || value < min || value > max) return undefined;
  return value;
}

function boundedString(value, min, max, pattern = null) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) return '';
  if (pattern && !pattern.test(normalized)) return '';
  return normalized;
}

function exactOpaqueOwnerString(value, min, max) {
  if (typeof value !== 'string' || value !== value.trim()) return '';
  if (value.length < min || value.length > max) return '';
  return /^[A-Za-z0-9._:-]+$/.test(value) ? value : '';
}

function exactIdentifier(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : '';
}

function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1) return '';
  const canonical = new Date(0);
  canonical.setUTCHours(0, 0, 0, 0);
  canonical.setUTCFullYear(year, month - 1, day);
  return canonical.getUTCFullYear() === year
    && canonical.getUTCMonth() === month - 1
    && canonical.getUTCDate() === day
    ? value : '';
}

export function normalizeWorkoutOwner(value) {
  if (!isObject(value)) return null;
  const ownershipEpoch = finiteInteger(
    value.ownershipEpoch ?? value.ownership_epoch,
    1,
    1_000_000_000,
    { nullable: false },
  );
  const dataNamespace = exactOpaqueOwnerString(
    value.dataNamespace ?? value.data_namespace,
    1,
    240,
  );
  const publicDeviceId = exactOpaqueOwnerString(
    value.publicDeviceId ?? value.public_device_id,
    1,
    160,
  );
  if (ownershipEpoch === undefined || !dataNamespace || !publicDeviceId) return null;
  return { ownershipEpoch, dataNamespace, publicDeviceId };
}

export function sameWorkoutOwner(left, right) {
  const a = normalizeWorkoutOwner(left);
  const b = normalizeWorkoutOwner(right);
  return !!a && !!b
    && a.ownershipEpoch === b.ownershipEpoch
    && a.dataNamespace === b.dataNamespace
    && a.publicDeviceId === b.publicDeviceId;
}

function workoutPrescriptionCore(plan) {
  if (!isObject(plan) || plan.schema_version !== WORKOUT_SCHEMA_VERSION) return null;
  return {
    schema_version: plan.schema_version,
    workout_id: plan.workout_id,
    plan_id: plan.plan_id,
    plan_session_id: plan.plan_session_id,
    revision: plan.revision,
    type: plan.type,
    title: plan.title,
    scheduled_date: plan.scheduled_date,
    target: plan.target,
    stages: plan.stages,
    ownership_epoch: plan.ownership_epoch,
    data_namespace: plan.data_namespace,
  };
}

/**
 * Compare the immutable prescription carried by two already-normalized plans.
 * Status and freshness timestamps belong to the current-workout envelope and
 * may legitimately advance between menu display and the launch-time GET. The
 * prescription IDs, revision, owner marker, targets and ordered stages may not.
 */
export function sameWorkoutPrescription(left, right) {
  const a = workoutPrescriptionCore(left);
  const b = workoutPrescriptionCore(right);
  if (!a || !b) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_error) {
    return false;
  }
}

function normalizeTargets(source, { stage = false } = {}) {
  if (!isObject(source)) return null;
  const fields = {
    duration_sec: finiteInteger(source.duration_sec, stage ? 10 : 60, 86_400),
    distance_m: finiteInteger(source.distance_m, stage ? 20 : 100, 200_000),
    pace_min_sec_per_km: finiteInteger(source.pace_min_sec_per_km, 120, 3_600),
    pace_max_sec_per_km: finiteInteger(source.pace_max_sec_per_km, 120, 3_600),
    heart_zone_min: finiteInteger(source.heart_zone_min, 1, 5),
    heart_zone_max: finiteInteger(source.heart_zone_max, 1, 5),
    cadence_min_spm: finiteInteger(source.cadence_min_spm, 40, 300),
    cadence_max_spm: finiteInteger(source.cadence_max_spm, 40, 300),
  };
  if (Object.values(fields).some((value) => value === undefined)) return null;
  if (fields.pace_min_sec_per_km !== null && fields.pace_max_sec_per_km !== null
      && fields.pace_min_sec_per_km > fields.pace_max_sec_per_km) return null;
  if (fields.heart_zone_min !== null && fields.heart_zone_max !== null
      && fields.heart_zone_min > fields.heart_zone_max) return null;
  if (fields.cadence_min_spm !== null && fields.cadence_max_spm !== null
      && fields.cadence_min_spm > fields.cadence_max_spm) return null;
  return fields;
}

export function normalizeWorkoutStage(raw, expectedOrder) {
  if (!isObject(raw)) return null;
  const stageId = exactIdentifier(raw.stage_id, WORKOUT_STAGE_ID_RE);
  const order = finiteInteger(raw.order, 0, 255, { nullable: false });
  const type = boundedString(raw.type, 1, 20);
  const title = boundedString(raw.title, 1, 80);
  const targets = normalizeTargets(raw, { stage: true });
  if (!stageId || order === undefined || order !== expectedOrder
      || !STAGE_TYPES.has(type) || !title || !targets) return null;
  if (targets.duration_sec === null && targets.distance_m === null) return null;
  return Object.freeze({
    stage_id: stageId,
    order,
    type,
    title,
    ...targets,
  });
}

export function normalizeWorkoutPlan(raw, expectedOwner, options = {}) {
  if (!isObject(raw)) return null;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  if (raw.schema_version !== WORKOUT_SCHEMA_VERSION) return null;
  const workoutId = exactIdentifier(raw.workout_id, WORKOUT_ID_RE);
  const planId = exactIdentifier(raw.plan_id, PLAN_ID_RE);
  const planSessionId = exactIdentifier(raw.plan_session_id, PLAN_SESSION_ID_RE);
  const revision = finiteInteger(raw.revision, 1, 1_000_000_000, { nullable: false });
  const type = boundedString(raw.type, 1, 20);
  const title = boundedString(raw.title, 1, 80);
  const scheduledDate = isoDate(raw.scheduled_date);
  const status = boundedString(raw.status, 1, 20);
  const target = normalizeTargets(raw.target);
  const issuedAtMs = finiteInteger(raw.issued_at_ms, 0, Number.MAX_SAFE_INTEGER, {
    nullable: false,
  });
  const expiresAtMs = finiteInteger(raw.expires_at_ms, 1, Number.MAX_SAFE_INTEGER, {
    nullable: false,
  });
  const owner = normalizeWorkoutOwner({
    ownership_epoch: raw.ownership_epoch,
    data_namespace: raw.data_namespace,
    public_device_id: expectedOwner && (
      expectedOwner.publicDeviceId ?? expectedOwner.public_device_id
    ),
  });
  if (!workoutId || !planId || !planSessionId || revision === undefined
      || !PLAN_TYPES.has(type) || !title || !scheduledDate
      || !EXECUTABLE_PLAN_STATUSES.has(status) || !target
      || issuedAtMs === undefined || expiresAtMs === undefined
      || issuedAtMs > nowMs + WORKOUT_MAX_FUTURE_SKEW_MS
      || expiresAtMs <= nowMs || expiresAtMs <= issuedAtMs
      || expiresAtMs - nowMs > WORKOUT_MAX_REMAINING_TTL_MS || !owner
      || !sameWorkoutOwner(owner, expectedOwner)) return null;
  if (!Array.isArray(raw.stages) || raw.stages.length < 1 || raw.stages.length > 64) return null;
  const stages = raw.stages.map((stage, index) => normalizeWorkoutStage(stage, index));
  if (stages.some((stage) => !stage)) return null;
  if (new Set(stages.map((stage) => stage.stage_id)).size !== stages.length) return null;
  return Object.freeze({
    schema_version: WORKOUT_SCHEMA_VERSION,
    workout_id: workoutId,
    plan_id: planId,
    plan_session_id: planSessionId,
    revision,
    type,
    title,
    scheduled_date: scheduledDate,
    status,
    target: Object.freeze(target),
    stages: Object.freeze(stages),
    issued_at_ms: issuedAtMs,
    expires_at_ms: expiresAtMs,
    ownership_epoch: owner.ownershipEpoch,
    data_namespace: owner.dataNamespace,
  });
}

function legacySuggestion(raw) {
  if (!isObject(raw) || raw.schema_version !== 1) return null;
  const title = boundedString(raw.title, 1, 80);
  const type = boundedString(raw.type, 1, 20);
  if (!title || !PLAN_TYPES.has(type)) return null;
  return Object.freeze({ schema_version: 1, title, type, executable: false });
}

export function parseCurrentWorkoutResponse(response, expectedOwner, options = {}) {
  const normalizedResponse = normalizeWxJsonResponse(response);
  if (!normalizedResponse || normalizedResponse.statusCode !== 200
      || !isObject(normalizedResponse.data)) return null;
  const body = normalizedResponse.data;
  const responseOwner = normalizeWorkoutOwner(body);
  if (!responseOwner || !sameWorkoutOwner(responseOwner, expectedOwner)) return null;
  const heartRatePolicy = body.heart_rate_policy == null
    ? null : normalizeHeartRatePolicy(body.heart_rate_policy, options);
  if (body.available === false && body.plan == null) {
    return Object.freeze({
      available: false,
      executable: false,
      owner: responseOwner,
      heartRatePolicy,
    });
  }
  if (body.available !== true || !isObject(body.plan)) return null;
  if (body.plan.schema_version === WORKOUT_SCHEMA_VERSION
      && TERMINAL_PLAN_STATUSES.has(body.plan.status)) {
    return Object.freeze({
      available: false,
      executable: false,
      owner: responseOwner,
      heartRatePolicy,
    });
  }
  const plan = normalizeWorkoutPlan(body.plan, responseOwner, options);
  if (plan) {
    return Object.freeze({
      available: true,
      executable: true,
      plan,
      owner: responseOwner,
      heartRatePolicy,
    });
  }
  const suggestion = legacySuggestion(body.plan);
  if (suggestion) {
    return Object.freeze({
      available: false,
      executable: false,
      legacySuggestion: suggestion,
      owner: responseOwner,
      heartRatePolicy,
    });
  }
  return null;
}

export function buildCurrentWorkoutRequest({
  token,
  baseUrl = DEFAULT_BASE_URL,
  timeout = 12_000,
} = {}) {
  const safeToken = boundedString(token, 8, 4096);
  if (!safeToken) return null;
  return {
    url: normalizeBaseUrl(baseUrl) + CURRENT_WORKOUT_PATH,
    method: 'GET',
    header: {
      Authorization: 'Bearer ' + safeToken,
      Accept: 'application/json',
      'Cache-Control': 'no-store',
    },
    dataType: 'json',
    responseType: 'text',
    timeout: Math.max(1000, Math.min(30_000, Number(timeout) || 12_000)),
  };
}
