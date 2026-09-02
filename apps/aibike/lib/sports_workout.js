// Hermes cycling workout contract. Parsing is deliberately strict: a cached
// card may be shown, but only a fresh, owner-matched online envelope can start.

import { normalizeWxJsonResponse } from './wx_json.js';
import {
  SPORTS_ACCEPT_LANGUAGE,
  normalizeSportsBaseUrl,
  sportsOwnerMarker,
} from './sports_identity.js';

export const SPORTS_CURRENT_WORKOUT_PATH =
  '/api/coach-svc/coach/aiui-sports/workouts/current';
export const SPORTS_WORKOUT_CACHE_KEY = 'aibike_sports_workout_cache_v1';

const ID_RE = /^(?:spw|sps)_[a-f0-9]{24}$/;
const TYPES = ['recovery', 'endurance', 'steady', 'interval', 'technique'];
const STAGES = ['warmup', 'work', 'recovery', 'cooldown'];
const SPORTS_SOURCE_LANGUAGE = 'zh-CN';
const PLAN_TYPE_TITLES = Object.freeze({
  recovery: '今日恢复骑',
  endurance: '今日耐力骑',
  steady: '今日稳态骑',
  interval: '今日间歇骑',
  technique: '今日技术训练',
});
const STAGE_TYPE_TITLES = Object.freeze({
  warmup: '热身',
  work: '主训练',
  recovery: '恢复',
  cooldown: '放松',
});
const STAGE_TYPE_CUES = Object.freeze({
  warmup: '轻档稳定热身',
  work: '按目标平稳踩踏',
  recovery: '降低强度主动恢复',
  cooldown: '逐步放松踩踏',
});

function text(value, max = 80) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function finite(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function range(source, minKey, maxKey, min, max) {
  const low = finite(source && source[minKey], min, max);
  const high = finite(source && source[maxKey], min, max);
  return low != null && high != null && low <= high ? [low, high] : null;
}

function normalizeTarget(value) {
  if (!value || typeof value !== 'object' || value.kind !== 'cycling') return null;
  const target = { kind: 'cycling' };
  for (const [name, keys, min, max] of [
    ['heart', ['heart_zone_min', 'heart_zone_max'], 1, 5],
    ['cadence', ['cadence_min_rpm', 'cadence_max_rpm'], 20, 240],
    ['power', ['power_min_w', 'power_max_w'], 1, 2500],
    ['speed', ['speed_min_kmh', 'speed_max_kmh'], 0.5, 150],
    ['effort', ['effort_min', 'effort_max'], 1, 10],
  ]) {
    const parsed = range(value, keys[0], keys[1], min, max);
    if (parsed) {
      target[keys[0]] = parsed[0];
      target[keys[1]] = parsed[1];
    }
  }
  return Object.keys(target).length > 1 ? target : null;
}

function normalizeStage(value, index) {
  if (!value || typeof value !== 'object' || !ID_RE.test(text(value.stage_id, 40))) {
    return null;
  }
  const order = Number(value.order);
  const durationSec = finite(value.duration_sec, 5, 21600);
  const type = text(value.type, 20);
  const target = normalizeTarget(value.target);
  // Hermes SportPlan declares a contiguous zero-based order.  The stage_id is
  // the durable identity; order is only the deterministic execution position.
  if (!Number.isSafeInteger(order) || order !== index || durationSec == null
      || !STAGES.includes(type) || !target) return null;
  return {
    stage_id: text(value.stage_id, 40),
    order,
    type,
    title: SPORTS_ACCEPT_LANGUAGE === SPORTS_SOURCE_LANGUAGE
      ? (text(value.title, 28) || '骑行阶段')
      : STAGE_TYPE_TITLES[type],
    duration_sec: Math.round(durationSec),
    cue: SPORTS_ACCEPT_LANGUAGE === SPORTS_SOURCE_LANGUAGE
      ? text(value.cue, 64) : STAGE_TYPE_CUES[type],
    target,
  };
}

export function normalizeSportsWorkoutPlan(value) {
  if (!value || typeof value !== 'object') return null;
  const workoutId = text(value.workout_id, 40);
  const revision = Number(value.revision);
  const type = text(value.type, 20);
  const issuedAtMs = finite(value.issued_at_ms, 946684800000, 4102444800000);
  const expiresAtMs = finite(value.expires_at_ms, 946684800000, 4102444800000);
  const rawStages = Array.isArray(value.stages) ? value.stages : [];
  const stages = rawStages.slice(0, 20).map(normalizeStage);
  if (!ID_RE.test(workoutId) || !Number.isSafeInteger(revision) || revision < 1
      || !TYPES.includes(type) || issuedAtMs == null || expiresAtMs == null
      || expiresAtMs <= issuedAtMs || !rawStages.length
      || stages.length !== rawStages.length || stages.some((stage) => !stage)) return null;
  return {
    workout_id: workoutId,
    revision,
    title: SPORTS_ACCEPT_LANGUAGE === SPORTS_SOURCE_LANGUAGE
      ? (text(value.title, 40) || '今日训练') : PLAN_TYPE_TITLES[type],
    type,
    scheduled_date: text(value.scheduled_date, 10),
    source: ['starter', 'adaptive'].includes(value.source) ? value.source : 'starter',
    rationale: SPORTS_ACCEPT_LANGUAGE === SPORTS_SOURCE_LANGUAGE
      ? text(value.rationale, 96) : '',
    issued_at_ms: Math.round(issuedAtMs),
    expires_at_ms: Math.round(expiresAtMs),
    safety_notes: SPORTS_ACCEPT_LANGUAGE === SPORTS_SOURCE_LANGUAGE
      && Array.isArray(value.safety_notes)
      ? value.safety_notes.map((item) => text(item, 48)).filter(Boolean).slice(0, 5) : [],
    stages,
  };
}

export function normalizeSportsWorkoutEnvelope(value, identity, now = Date.now()) {
  if (!value || typeof value !== 'object' || Number(value.schema_version) !== 1
      || value.sport !== 'cycling' || value.discipline !== 'outdoor_cycling') return null;
  const expected = sportsOwnerMarker(identity);
  const actual = {
    public_device_id: text(value.public_device_id, 160),
    ownership_epoch: Number(value.ownership_epoch),
    data_namespace: text(value.data_namespace, 200),
  };
  if (!expected || JSON.stringify(actual) !== JSON.stringify(expected)) return null;
  if (value.available !== true) return {
    schema_version: 1,
    available: false,
    sport: 'cycling',
    discipline: 'outdoor_cycling',
    ...actual,
    plan: null,
    fresh: true,
  };
  const plan = normalizeSportsWorkoutPlan(value.plan);
  if (!plan) return null;
  return {
    schema_version: 1,
    available: true,
    sport: 'cycling',
    discipline: 'outdoor_cycling',
    ...actual,
    plan,
    fresh: Number(now) >= plan.issued_at_ms && Number(now) < plan.expires_at_ms,
  };
}

export function parseSportsCurrentWorkoutResponse(response, identity, now) {
  if (Number(response && response.statusCode) !== 200) return null;
  const normalized = normalizeWxJsonResponse(response);
  return normalizeSportsWorkoutEnvelope(normalized && normalized.data, identity, now);
}

export function buildSportsCurrentWorkoutRequest(identity, options = {}) {
  const marker = sportsOwnerMarker(identity);
  if (!marker || !identity.token) return null;
  return {
    url: normalizeSportsBaseUrl(options.baseUrl) + SPORTS_CURRENT_WORKOUT_PATH,
    method: 'GET',
    header: {
      Authorization: 'Bearer ' + identity.token,
      'Cache-Control': 'no-store',
      'Accept-Language': SPORTS_ACCEPT_LANGUAGE,
    },
    dataType: 'json',
    responseType: 'text',
    timeout: Number(options.timeout) || 10000,
  };
}

export function readSportsWorkoutCache(storage, identity, now = Date.now()) {
  try {
    const raw = storage && typeof storage.getStorageSync === 'function'
      ? storage.getStorageSync(SPORTS_WORKOUT_CACHE_KEY) : null;
    return normalizeSportsWorkoutEnvelope(raw, identity, now);
  } catch (_error) {
    return null;
  }
}

export function writeSportsWorkoutCache(storage, envelope, identity, now = Date.now()) {
  const normalized = normalizeSportsWorkoutEnvelope(envelope, identity, now);
  if (!normalized || !storage || typeof storage.setStorageSync !== 'function') return null;
  try {
    storage.setStorageSync(SPORTS_WORKOUT_CACHE_KEY, normalized);
    const readback = readSportsWorkoutCache(storage, identity, now);
    return JSON.stringify(readback) === JSON.stringify(normalized) ? readback : null;
  } catch (_error) {
    return null;
  }
}

export async function refreshSportsWorkout(options = {}) {
  const requestOptions = buildSportsCurrentWorkoutRequest(options.identity, options);
  if (!requestOptions || typeof options.request !== 'function') {
    return { ready: false, reason: 'identity', envelope: null };
  }
  let response = null;
  try { response = await options.request(requestOptions); } catch (_error) {}
  const envelope = parseSportsCurrentWorkoutResponse(
    response,
    options.identity,
    options.now == null ? Date.now() : options.now,
  );
  if (!envelope) return {
    ready: false,
    reason: 'network',
    statusCode: Number(response && response.statusCode) || 0,
    envelope: null,
  };
  const stored = writeSportsWorkoutCache(
    options.storage,
    envelope,
    options.identity,
    options.now == null ? Date.now() : options.now,
  );
  return stored ? { ready: true, envelope: stored } : {
    ready: false,
    reason: 'storage',
    envelope: null,
  };
}

export function formatSportsWorkoutTarget(target, available = {}) {
  if (!target) return '按体感轻松骑';
  if ((available.power === true)
      && target.power_min_w != null) {
    return `${Math.round(target.power_min_w)}–${Math.round(target.power_max_w)} W`;
  }
  if (available.cadence === true
      && target.cadence_min_rpm != null) {
    return `${Math.round(target.cadence_min_rpm)}–${Math.round(target.cadence_max_rpm)} rpm`;
  }
  if (available.heartRate === true && target.heart_zone_min != null) {
    return `心率 Z${target.heart_zone_min}–Z${target.heart_zone_max}`;
  }
  if (target.effort_min != null) {
    return `体感 ${Math.round(target.effort_min)}–${Math.round(target.effort_max)} / 10`;
  }
  return '按体感轻松骑';
}
