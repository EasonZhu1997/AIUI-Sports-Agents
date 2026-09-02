// AIBike client for Hermes' owner-scoped Sport Agent session contract.
// The page keeps high-frequency sensing, safety and stage timing local.  This
// module only prepares bounded requests, validates owner echoes, and persists
// an ACK-only outbox for lifecycle-safe retries after the ride.

import { normalizeWxJsonResponse } from './wx_json.js';
import { normalizeSportsBaseUrl, sportsOwnerMarker } from './sports_identity.js';
import { normalizeSportsWorkoutPlan } from './sports_workout.js';

export const SPORT_AGENT_BASE_PATH = '/api/coach-svc/coach/sport-agent';
// This literal is replaced only inside the isolated EN/JA AIX staging trees.
// Keeping locale in the signed session contract prevents a localized package
// from accepting free-form coach copy generated for another language.
export const SPORT_AGENT_LOCALE = 'zh-CN';
export const SPORT_AGENT_CONTEXT_VERSION = 2;
export const SPORT_AGENT_OUTBOX_KEY = 'aibike_sport_agent_outbox_v1';
export const SPORT_AGENT_OUTBOX_MAX = 300;
export const SPORT_AGENT_DEBRIEF_CACHE_KEY = 'aibike_sport_agent_debrief_v2';
export const SPORT_AGENT_PRESTART_KEY = 'aibike_sport_agent_prestart_v2';
export const SPORT_AGENT_ACTIVE_KEY = 'aibike_sport_agent_active_v2';

const SESSION_ID_RE = /^sas_[a-f0-9]{24}$/;
const BRIEFING_ID_RE = /^sab_[a-f0-9]{24}$/;
const DEBRIEF_ID_RE = /^sad_[a-f0-9]{24}$/;
const WORKOUT_ID_RE = /^spw_[a-f0-9]{24}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{8,100}$/;
const MODES = ['free', 'recovery', 'endurance', 'planned'];
const EVENT_KINDS = ['snapshot', 'stage_change', 'pause', 'resume', 'safety'];
const STATUS = ['completed', 'partial', 'aborted'];
const HR_SOURCES = ['user_explicit', 'garmin_profile', 'age_estimate', 'conservative_default'];
const SENSOR_SOURCES = ['hrs', 'csc', 'cps', 'ftms', 'gps', 'imu'];
const READINESS_STATUSES = ['clear', 'high_load', 'blocked', 'unknown'];
const READINESS_REASONS = ['no_recent_readiness', 'recent_high_load', 'unresolved_pain'];
const READINESS_SOURCES = ['apk_history', 'history_only'];
const ITERATION_BASES = [
  'starter', 'hold', 'small_progression', 'recovery_protection',
  'technique_reset', 'interval_ready',
];
const ITERATION_REASONS = [
  'first_rides', 'consistent_completion', 'recent_partial', 'recent_abort',
  'recent_safety_event', 'recovery_load', 'sensor_coverage_low',
  'interval_evidence_ready',
];
const EXECUTION_SOURCES = ['prescription', 'capability_fallback', 'readiness_reduction'];
const EXECUTION_FALLBACKS = ['none', 'cadence', 'heart_rate', 'effort'];
const NEXT_DIRECTIONS = ['recover', 'hold', 'progress', 'technique'];
const NEXT_MODES = ['recovery', 'endurance', 'steady', 'interval', 'technique'];
const NEXT_REASONS = [
  'completed_as_planned', 'partial_completion', 'aborted_session', 'safety_event',
  'recovery_load', 'sensor_coverage_low', 'consistent_completion',
  'interval_evidence_ready',
];
const CONFIDENCE = ['low', 'medium', 'high'];
const DATA_COVERAGE = ['insufficient', 'limited', 'good'];
const MEMORY_STATUSES = ['pending', 'complete', 'skipped_no_consent', 'failed'];
const DEBRIEF_STATUSES = ['local_ready', 'ai_ready', 'pending', 'failed'];
const CAPABILITY_HASH_RE = /^[0-9a-f]{64}$/;

function text(value, max = 120) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function wireText(value, max = 120, options = {}) {
  if (typeof value !== 'string' || value.length > max) return null;
  if (options.canonical !== false && value !== value.trim()) return null;
  if (options.nonempty === true && value.length === 0) return null;
  return value;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value, min, max, digits = 3) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

// Hermes v2 response models are strict JSON contracts.  Keep these helpers
// separate from the tolerant local/outbox normalizers above: persisted client
// evidence may be migrated, but a server string/bool must never be coerced into
// a safety-relevant number.
function wireFinite(value, min, max, digits = 3) {
  if (typeof value !== 'number' || !Number.isFinite(value)
      || value < min || value > max) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function wireInt(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= min && value <= max ? value : null;
}

function int(value, min, max) {
  const number = finite(value, min, max, 0);
  return number == null ? null : Math.round(number);
}

function dataOf(response) {
  const normalized = normalizeWxJsonResponse(response);
  return normalized && normalized.data && typeof normalized.data === 'object'
    ? normalized.data : null;
}

function ownerMatches(value, identity) {
  const expected = sportsOwnerMarker(identity);
  if (!expected || !value || typeof value !== 'object') return false;
  return value.public_device_id === expected.public_device_id
    && typeof value.ownership_epoch === 'number'
    && Number.isInteger(value.ownership_epoch)
    && value.ownership_epoch === expected.ownership_epoch
    && value.data_namespace === expected.data_namespace;
}

function stringArray(value, allowed, max = 16) {
  if (!Array.isArray(value) || value.length > max) return null;
  const result = [];
  for (const raw of value) {
    const item = wireText(raw, 48, { nonempty: true });
    if (!allowed.includes(item) || result.includes(item)) return null;
    result.push(item);
  }
  return result;
}

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

export function normalizeSportAgentCapabilities(value) {
  const keys = ['heart_rate', 'pace', 'cadence', 'speed', 'power'];
  if (!exactKeys(value, keys)) return null;
  const result = {};
  for (const key of keys) {
    if (typeof value[key] !== 'boolean') return null;
    result[key] = value[key];
  }
  return result;
}

export function sportAgentCapabilitiesFromOptions(options = {}) {
  return {
    heart_rate: options.heartRate === true,
    pace: false,
    cadence: options.cadence === true,
    speed: options.speed === true,
    power: options.power === true,
  };
}

export function sportAgentCapabilitiesSignature(value) {
  const normalized = normalizeSportAgentCapabilities(value);
  return normalized ? JSON.stringify(normalized) : '';
}

function normalizeReadiness(value) {
  if (!exactKeys(value, [
    'schema_version', 'status', 'reason_codes', 'source', 'launch_allowed',
  ]) || value.schema_version !== 1) return null;
  const status = wireText(value.status, 24, { nonempty: true });
  const source = wireText(value.source, 24, { nonempty: true });
  const reasons = stringArray(value.reason_codes, READINESS_REASONS, 3);
  if (!READINESS_STATUSES.includes(status) || !READINESS_SOURCES.includes(source)
      || !reasons || typeof value.launch_allowed !== 'boolean') return null;
  if (status === 'blocked' && value.launch_allowed !== false) return null;
  return {
    schema_version: 1,
    status,
    reason_codes: reasons,
    source,
    launch_allowed: value.launch_allowed,
  };
}

function normalizeIteration(value) {
  if (!exactKeys(value, [
    'schema_version', 'strategy_version', 'recent_sessions', 'completed',
    'partial', 'aborted', 'safety_events', 'completion_rate_pct', 'plan_basis',
    'evidence_confidence', 'data_coverage', 'reason_codes',
  ]) || value.schema_version !== 1
      || value.strategy_version !== 2) return null;
  const result = {};
  for (const key of ['recent_sessions', 'completed', 'partial', 'aborted']) {
    const parsed = wireInt(value[key], 0, 20);
    if (parsed == null) return null;
    result[key] = parsed;
  }
  const safetyEvents = wireInt(value.safety_events, 0, 100);
  const completionRate = wireInt(value.completion_rate_pct, 0, 100);
  const planBasis = wireText(value.plan_basis, 32, { nonempty: true });
  const evidenceConfidence = wireText(value.evidence_confidence, 16, { nonempty: true });
  const dataCoverage = wireText(value.data_coverage, 16, { nonempty: true });
  const reasons = stringArray(value.reason_codes, ITERATION_REASONS, 8);
  if (safetyEvents == null || completionRate == null || !ITERATION_BASES.includes(planBasis)
      || !CONFIDENCE.includes(evidenceConfidence) || !DATA_COVERAGE.includes(dataCoverage)
      || !reasons || result.completed + result.partial + result.aborted !== result.recent_sessions) {
    return null;
  }
  return {
    schema_version: 1,
    strategy_version: 2,
    ...result,
    safety_events: safetyEvents,
    completion_rate_pct: completionRate,
    plan_basis: planBasis,
    evidence_confidence: evidenceConfidence,
    data_coverage: dataCoverage,
    reason_codes: reasons,
  };
}

function normalizeExecutionTarget(value) {
  if (!exactKeys(value, ['kind'], [
    'effort_min', 'effort_max',
    'heart_zone_min', 'heart_zone_max', 'cadence_min_rpm', 'cadence_max_rpm',
    'power_min_w', 'power_max_w',
  ]) || value.kind !== 'cycling') return null;
  const result = { kind: 'cycling' };
  for (const [lowKey, highKey, min, max] of [
    ['heart_zone_min', 'heart_zone_max', 1, 5],
    ['cadence_min_rpm', 'cadence_max_rpm', 20, 240],
    ['power_min_w', 'power_max_w', 0, 2500],
    ['effort_min', 'effort_max', 1, 10],
  ]) {
    const hasEither = value[lowKey] != null || value[highKey] != null;
    if (!hasEither) continue;
    const low = wireFinite(value[lowKey], min, max);
    const high = wireFinite(value[highKey], min, max);
    if (low == null || high == null || low > high) return null;
    result[lowKey] = low;
    result[highKey] = high;
  }
  if (!Object.prototype.hasOwnProperty.call(result, 'effort_min')
      || !Object.prototype.hasOwnProperty.call(result, 'effort_max')) return null;
  return Object.keys(result).length > 1 ? result : null;
}

function normalizeExecutionStages(value) {
  // Free rides intentionally have no remote stage prescription.  A planned
  // ride is checked separately and must still contain one executable stage.
  if (!Array.isArray(value) || value.length > 32) return null;
  const seen = new Set();
  const result = [];
  for (const raw of value) {
    const stageId = wireText(raw && raw.stage_id, 40, { nonempty: true });
    const durationS = wireInt(raw && raw.duration_s, 30, 7200);
    const target = normalizeExecutionTarget(raw && raw.target);
    const source = wireText(raw && raw.source, 32, { nonempty: true });
    const fallback = wireText(raw && raw.fallback, 24, { nonempty: true });
    if (!exactKeys(raw, ['stage_id', 'duration_s', 'target', 'source', 'fallback'])
        || !/^sps_[a-f0-9]{24}$/.test(stageId) || seen.has(stageId)
        || durationS == null || !target || !EXECUTION_SOURCES.includes(source)
        || !EXECUTION_FALLBACKS.includes(fallback)) return null;
    seen.add(stageId);
    result.push({ stage_id: stageId, duration_s: durationS, target, source, fallback });
  }
  return result;
}

export function buildSportAgentExecutionPlan(plan, session) {
  const normalized = normalizeSportsWorkoutPlan(plan);
  const execution = session && Array.isArray(session.execution_stages)
    ? session.execution_stages : null;
  if (!normalized || !execution || execution.length !== normalized.stages.length
      || !session.readiness || session.readiness.launch_allowed !== true) return null;
  const byId = new Map(execution.map((stage) => [stage.stage_id, stage]));
  const stages = normalized.stages.map((stage) => {
    const executable = byId.get(stage.stage_id);
    return executable ? {
      ...stage,
      duration_sec: executable.duration_s,
      target: executable.target,
      execution_source: executable.source,
      execution_fallback: executable.fallback,
    } : null;
  });
  return stages.some((stage) => !stage) ? null : { ...normalized, stages };
}

function request(identity, path, data, options = {}, method = 'POST') {
  if (!identity || !identity.token) return null;
  return {
    url: normalizeSportsBaseUrl(options.baseUrl) + SPORT_AGENT_BASE_PATH + path,
    method,
    header: {
      Authorization: 'Bearer ' + identity.token,
      'Content-Type': 'application/json',
      'Accept-Language': SPORT_AGENT_LOCALE,
      ...(method === 'GET' ? { 'Cache-Control': 'no-store' } : {}),
    },
    ...(data == null ? {} : { data }),
    dataType: 'json',
    responseType: 'text',
    timeout: Number(options.timeout) || 12000,
  };
}

export function normalizeSportAgentHeartRatePolicy(value) {
  if (!exactKeys(value, [
    'schema_version', 'max_hr_bpm', 'source', 'issued_at_ms', 'expires_at_ms',
  ]) || value.schema_version !== 1) return null;
  const maximum = wireInt(value.max_hr_bpm, 120, 230);
  const issuedAt = wireInt(value.issued_at_ms, 0, 4102444800000);
  const expiresAt = wireInt(value.expires_at_ms, 1, 4102444800000);
  const source = wireText(value.source, 32, { nonempty: true });
  if (maximum == null || issuedAt == null || expiresAt == null || expiresAt <= issuedAt
      || !HR_SOURCES.includes(source)) return null;
  return {
    schema_version: 1,
    max_hr_bpm: maximum,
    source,
    issued_at_ms: issuedAt,
    expires_at_ms: expiresAt,
    authoritative: source === 'user_explicit' || source === 'garmin_profile',
  };
}

function normalizePolicy(value) {
  if (!exactKeys(value, [
    'schema_version', 'snapshot_max_age_ms', 'normal_cue_cooldown_s',
    'repeat_cue_cooldown_s', 'safety_cue_cooldown_s', 'minimum_evidence_s',
  ]) || value.schema_version !== 1) return null;
  const result = {};
  for (const key of [
    'snapshot_max_age_ms', 'normal_cue_cooldown_s', 'repeat_cue_cooldown_s',
    'safety_cue_cooldown_s', 'minimum_evidence_s',
  ]) {
    const parsed = wireInt(value[key], 0, 86400 * 1000);
    if (parsed == null) return null;
    result[key] = parsed;
  }
  return { schema_version: 1, ...result };
}

export function buildSportAgentBriefingRequest(identity, options = {}) {
  const mode = MODES.includes(options.mode) ? options.mode : 'free';
  const workoutId = text(options.workoutId, 40);
  return request(identity, '/briefing', {
    schema_version: 1,
    context_version: SPORT_AGENT_CONTEXT_VERSION,
    sport: 'cycling',
    mode,
    locale: SPORT_AGENT_LOCALE,
    capabilities: sportAgentCapabilitiesFromOptions(options),
    ...(WORKOUT_ID_RE.test(workoutId) ? { workout_id: workoutId } : {}),
  }, options);
}

export function parseSportAgentBriefingResponse(response, identity) {
  if (!response || response.statusCode !== 200) return null;
  const data = dataOf(response);
  const mode = wireText(data && data.mode, 24, { nonempty: true });
  const title = wireText(data && data.title, 80);
  const rationale = wireText(data && data.rationale, 180);
  const heartRatePolicy = normalizeSportAgentHeartRatePolicy(data && data.heart_rate_policy);
  const supervisionPolicy = normalizePolicy(data && data.supervision_policy);
  const capabilities = normalizeSportAgentCapabilities(data && data.capabilities);
  const capabilityHash = text(data && data.capability_hash, 64);
  const readiness = normalizeReadiness(data && data.readiness);
  const iteration = normalizeIteration(data && data.iteration);
  const executionStages = normalizeExecutionStages(data && data.execution_stages);
  if (!exactKeys(data, [
    'schema_version', 'briefing_id', 'sport', 'mode', 'locale', 'title',
    'rationale', 'prescription', 'supervision_policy', 'heart_rate_policy',
    'ownership_epoch', 'data_namespace', 'public_device_id', 'context_version',
    'capabilities', 'capability_hash', 'readiness', 'iteration', 'execution_stages',
  ]) || data.schema_version !== 1
      || data.context_version !== SPORT_AGENT_CONTEXT_VERSION
      || data.sport !== 'cycling'
      || !BRIEFING_ID_RE.test(wireText(data.briefing_id, 40, { nonempty: true }) || '')
      || !MODES.includes(mode) || title == null || rationale == null
      || data.locale !== SPORT_AGENT_LOCALE
      || !ownerMatches(data, identity) || !heartRatePolicy || !supervisionPolicy
      || !capabilities || !CAPABILITY_HASH_RE.test(capabilityHash)
      || !readiness || !iteration || !executionStages
      || !plainObject(data.prescription)) return null;
  return {
    schema_version: 1,
    context_version: SPORT_AGENT_CONTEXT_VERSION,
    briefing_id: data.briefing_id,
    sport: 'cycling',
    mode,
    locale: SPORT_AGENT_LOCALE,
    title,
    rationale,
    prescription: data.prescription,
    capabilities,
    capability_hash: capabilityHash,
    readiness,
    iteration,
    execution_stages: executionStages,
    supervision_policy: supervisionPolicy,
    heart_rate_policy: heartRatePolicy,
    ...sportsOwnerMarker(identity),
  };
}

export function buildSportAgentSessionRequest(identity, briefing, clientSessionId, options = {}) {
  const id = text(clientSessionId, 100);
  if (!briefing || !BRIEFING_ID_RE.test(briefing.briefing_id) || !CLIENT_ID_RE.test(id)) return null;
  const workoutId = text(options.workoutId, 40);
  return request(identity, '/sessions', {
    schema_version: 1,
    context_version: SPORT_AGENT_CONTEXT_VERSION,
    sport: 'cycling',
    mode: briefing.mode,
    locale: SPORT_AGENT_LOCALE,
    client_session_id: id,
    briefing_id: briefing.briefing_id,
    capabilities: briefing.capabilities,
    capability_hash: briefing.capability_hash,
    ...(WORKOUT_ID_RE.test(workoutId) ? { workout_id: workoutId } : {}),
  }, options);
}

export function parseSportAgentSessionResponse(response, identity, expected = {}) {
  if (!response || response.statusCode !== 200) return null;
  const data = dataOf(response);
  const heartRatePolicy = normalizeSportAgentHeartRatePolicy(data && data.heart_rate_policy);
  const supervisionPolicy = normalizePolicy(data && data.supervision_policy);
  const capabilities = normalizeSportAgentCapabilities(data && data.capabilities);
  const capabilityHash = text(data && data.capability_hash, 64);
  const readiness = normalizeReadiness(data && data.readiness);
  const iteration = normalizeIteration(data && data.iteration);
  const executionStages = normalizeExecutionStages(data && data.execution_stages);
  const mode = wireText(data && data.mode, 24, { nonempty: true });
  const workoutPresent = Object.prototype.hasOwnProperty.call(data || {}, 'workout_id');
  const workoutId = workoutPresent && data.workout_id !== null
    ? wireText(data.workout_id, 40, { nonempty: true }) : null;
  if (!exactKeys(data, [
    'schema_version', 'session_id', 'client_session_id', 'briefing_id',
    'duplicate', 'sport', 'mode', 'locale', 'prescription',
    'supervision_policy', 'heart_rate_policy', 'ownership_epoch',
    'data_namespace', 'public_device_id', 'context_version', 'capabilities',
    'capability_hash', 'readiness', 'iteration', 'execution_stages',
  ], ['workout_id']) || data.schema_version !== 1
      || data.context_version !== SPORT_AGENT_CONTEXT_VERSION
      || data.sport !== 'cycling'
      || !SESSION_ID_RE.test(wireText(data.session_id, 40, { nonempty: true }) || '')
      || data.client_session_id !== expected.clientSessionId
      || data.briefing_id !== expected.briefingId
      || (workoutPresent && data.workout_id !== null && !WORKOUT_ID_RE.test(workoutId || ''))
      || (expected.workoutId || null) !== workoutId
      || data.locale !== SPORT_AGENT_LOCALE
      || !MODES.includes(mode)
      || (expected.mode && mode !== expected.mode)
      || typeof data.duplicate !== 'boolean'
      || !capabilities || !CAPABILITY_HASH_RE.test(capabilityHash)
      || capabilityHash !== expected.capabilityHash
      || sportAgentCapabilitiesSignature(capabilities)
        !== sportAgentCapabilitiesSignature(expected.capabilities)
      || !ownerMatches(data, identity) || !heartRatePolicy || !supervisionPolicy
      || !readiness || !iteration || !executionStages
      || !plainObject(data.prescription)) return null;
  return {
    schema_version: 1,
    context_version: SPORT_AGENT_CONTEXT_VERSION,
    session_id: data.session_id,
    client_session_id: data.client_session_id,
    briefing_id: data.briefing_id,
    workout_id: workoutId,
    duplicate: data.duplicate === true,
    sport: 'cycling',
    mode,
    locale: SPORT_AGENT_LOCALE,
    prescription: data.prescription,
    capabilities,
    capability_hash: capabilityHash,
    readiness,
    iteration,
    execution_stages: executionStages,
    supervision_policy: supervisionPolicy,
    heart_rate_policy: heartRatePolicy,
    ...sportsOwnerMarker(identity),
  };
}

function removeStorageKey(storage, key) {
  if (!storage) return false;
  try {
    if (typeof storage.removeStorageSync === 'function') storage.removeStorageSync(key);
    else if (typeof storage.setStorageSync === 'function') storage.setStorageSync(key, null);
    else return false;
    return !storage.getStorageSync(key);
  } catch (_error) { return false; }
}

function normalizeSportAgentPrestart(value, identity) {
  if (!value || typeof value !== 'object' || Number(value.schema_version) !== 1
      || !ownerMatches(value.owner, identity)) return null;
  const mode = text(value.mode, 24);
  const workoutId = text(value.workout_id, 40);
  const revision = value.workout_revision == null
    ? null : int(value.workout_revision, 1, 1000000);
  const clientSessionId = text(value.client_session_id, 100);
  const storedBriefing = value.briefing && {
    ...value.briefing,
    heart_rate_policy: value.briefing.heart_rate_policy && {
      ...value.briefing.heart_rate_policy,
    },
  };
  if (storedBriefing && storedBriefing.heart_rate_policy) {
    delete storedBriefing.heart_rate_policy.authoritative;
  }
  const briefing = parseSportAgentBriefingResponse({
    statusCode: 200, data: storedBriefing,
  }, identity);
  const expectedRequest = briefing && buildSportAgentSessionRequest(
    identity,
    briefing,
    clientSessionId,
    { workoutId },
  );
  const requestBody = value.session_request_body;
  if (!MODES.includes(mode) || !CLIENT_ID_RE.test(clientSessionId)
      || !briefing || briefing.mode !== mode || !expectedRequest
      || !requestBody || JSON.stringify(requestBody) !== JSON.stringify(expectedRequest.data)
      || sportAgentCapabilitiesSignature(briefing.capabilities)
        !== text(value.capability_signature, 200)
      || (workoutId && !WORKOUT_ID_RE.test(workoutId))
      || (!workoutId && revision != null)
      || (workoutId && (!normalizeSportsWorkoutPlan(briefing.prescription)
        || normalizeSportsWorkoutPlan(briefing.prescription).workout_id !== workoutId
        || normalizeSportsWorkoutPlan(briefing.prescription).revision !== revision))) return null;
  const storedSession = value.session && {
    ...value.session,
    heart_rate_policy: value.session.heart_rate_policy && {
      ...value.session.heart_rate_policy,
    },
  };
  if (storedSession && storedSession.heart_rate_policy) {
    delete storedSession.heart_rate_policy.authoritative;
  }
  const session = value.session ? parseSportAgentSessionResponse({
    statusCode: 200, data: storedSession,
  }, identity, {
    clientSessionId,
    briefingId: briefing.briefing_id,
    workoutId: workoutId || null,
    mode,
    capabilities: briefing.capabilities,
    capabilityHash: briefing.capability_hash,
  }) : null;
  if (value.state === 'session_ready' && !session) return null;
  if (!['request_ready', 'session_ready'].includes(value.state)) return null;
  return {
    schema_version: 1,
    state: value.state,
    owner: sportsOwnerMarker(identity),
    mode,
    workout_id: workoutId || null,
    workout_revision: revision,
    client_session_id: clientSessionId,
    capability_signature: sportAgentCapabilitiesSignature(briefing.capabilities),
    briefing,
    session_request_body: expectedRequest.data,
    ...(session ? { session } : {}),
  };
}

export function readSportAgentPrestart(storage, identity) {
  try {
    return storage && typeof storage.getStorageSync === 'function'
      ? normalizeSportAgentPrestart(storage.getStorageSync(SPORT_AGENT_PRESTART_KEY), identity)
      : null;
  } catch (_error) { return null; }
}

export function recoverSportAgentPlannedPrestart(storage, identity) {
  const journal = readSportAgentPrestart(storage, identity);
  if (!journal || journal.mode !== 'planned' || !journal.workout_id) return null;
  const plan = normalizeSportsWorkoutPlan(journal.briefing.prescription);
  return plan && plan.workout_id === journal.workout_id
    && plan.revision === journal.workout_revision
    ? { journal, plan } : null;
}

export function writeSportAgentPrestart(storage, value, identity) {
  const normalized = normalizeSportAgentPrestart(value, identity);
  if (!normalized || !storage || typeof storage.setStorageSync !== 'function') return null;
  try {
    storage.setStorageSync(SPORT_AGENT_PRESTART_KEY, normalized);
    const readback = readSportAgentPrestart(storage, identity);
    return JSON.stringify(readback) === JSON.stringify(normalized) ? readback : null;
  } catch (_error) { return null; }
}

export function reconcileSportAgentHandshakeOwner(storage, identity) {
  const expected = sportsOwnerMarker(identity);
  if (!storage || !expected || typeof storage.getStorageSync !== 'function') return false;
  let changed = false;
  for (const key of [SPORT_AGENT_PRESTART_KEY, SPORT_AGENT_ACTIVE_KEY]) {
    try {
      const raw = storage.getStorageSync(key);
      if (raw && JSON.stringify(raw.owner) !== JSON.stringify(expected)) {
        changed = removeStorageKey(storage, key) || changed;
      }
    } catch (_error) {}
  }
  return changed;
}

function claimedResponse(value, identity) {
  return value ? { ...value, ...sportsOwnerMarker(identity) } : value;
}

function restoreSportAgentHandshakeSnapshot(storage, snapshot) {
  if (!storage || !snapshot) return false;
  try {
    for (const [key, value] of [
      [SPORT_AGENT_PRESTART_KEY, snapshot.prestart],
      [SPORT_AGENT_ACTIVE_KEY, snapshot.active],
    ]) {
      if (value == null) {
        if (!removeStorageKey(storage, key) && storage.getStorageSync(key)) return false;
      } else {
        storage.setStorageSync(key, value);
      }
    }
    const restored = JSON.stringify(storage.getStorageSync(SPORT_AGENT_PRESTART_KEY) ?? null)
        === JSON.stringify(snapshot.prestart ?? null)
      && JSON.stringify(storage.getStorageSync(SPORT_AGENT_ACTIVE_KEY) ?? null)
        === JSON.stringify(snapshot.active ?? null);
    if (restored) return true;
    removeStorageKey(storage, SPORT_AGENT_PRESTART_KEY);
    removeStorageKey(storage, SPORT_AGENT_ACTIVE_KEY);
    return false;
  } catch (_error) {
    // A half-migrated new-owner handshake is more dangerous than losing a
    // recoverable old-owner draft.  If rollback itself fails, remove both
    // authority records so the next planned launch fails closed.
    removeStorageKey(storage, SPORT_AGENT_PRESTART_KEY);
    removeStorageKey(storage, SPORT_AGENT_ACTIVE_KEY);
    return false;
  }
}

function sameMigratedPrestart(before, after) {
  return !!before && !!after
    && after.client_session_id === before.client_session_id
    && after.session && before.session
    && after.session.session_id === before.session.session_id
    && JSON.stringify(after.session_request_body)
      === JSON.stringify(before.session_request_body)
    && after.capability_signature === before.capability_signature
    && after.workout_id === before.workout_id
    && after.workout_revision === before.workout_revision;
}

function sameMigratedActive(before, after) {
  return !!before && !!after
    && after.session_id === before.session_id
    && after.client_session_id === before.client_session_id
    && after.capability_signature === before.capability_signature
    && after.workout_id === before.workout_id
    && after.workout_revision === before.workout_revision
    && JSON.stringify(after.execution_plan || null)
      === JSON.stringify(before.execution_plan || null)
    && after.completion_queued === before.completion_queued
    && after.client_completion_id === before.client_completion_id
    && after.client_activity_id === before.client_activity_id;
}

export function migrateSportAgentHandshakeForAnonymousClaim(
  storage,
  previousIdentity,
  currentIdentity,
) {
  if (!storage || typeof storage.getStorageSync !== 'function'
      || typeof storage.setStorageSync !== 'function'
      || !isExactAnonymousClaim(previousIdentity, currentIdentity)) return null;
  const snapshot = {
    prestart: storage.getStorageSync(SPORT_AGENT_PRESTART_KEY) ?? null,
    active: storage.getStorageSync(SPORT_AGENT_ACTIVE_KEY) ?? null,
  };
  const previousPrestart = readSportAgentPrestart(storage, previousIdentity);
  const previousActive = readSportAgentActive(storage, previousIdentity);
  let nextPrestart = null;
  let nextActive = null;
  if (previousPrestart) {
    // A request_ready journal has no committed server session.  Its old
    // briefing/owner hash is not portable across a claim, so it must be
    // discarded as part of the same transaction.  Only a server-committed
    // session_ready record is eligible for the verified claim migration.
    if (previousPrestart.state === 'session_ready' && previousPrestart.session) {
      nextPrestart = normalizeSportAgentPrestart({
        ...previousPrestart,
        owner: sportsOwnerMarker(currentIdentity),
        briefing: claimedResponse(previousPrestart.briefing, currentIdentity),
        session: claimedResponse(previousPrestart.session, currentIdentity),
      }, currentIdentity);
      if (!sameMigratedPrestart(previousPrestart, nextPrestart)) return null;
    }
  }
  if (previousActive) {
    nextActive = {
      ...previousActive,
      owner: sportsOwnerMarker(currentIdentity),
      session: claimedResponse(previousActive.session, currentIdentity),
    };
  }
  try {
    if (nextPrestart) storage.setStorageSync(SPORT_AGENT_PRESTART_KEY, nextPrestart);
    else if (previousPrestart && !removeStorageKey(storage, SPORT_AGENT_PRESTART_KEY)) {
      throw new Error('prestart removal failed');
    }
    if (nextActive) storage.setStorageSync(SPORT_AGENT_ACTIVE_KEY, nextActive);

    const prestartReadback = nextPrestart
      ? readSportAgentPrestart(storage, currentIdentity) : null;
    const activeReadback = nextActive
      ? readSportAgentActive(storage, currentIdentity) : null;
    if ((nextPrestart && !sameMigratedPrestart(previousPrestart, prestartReadback))
        || (nextActive && !sameMigratedActive(previousActive, activeReadback))) {
      throw new Error('anonymous claim handshake readback failed');
    }
    return { prestart: prestartReadback, active: activeReadback };
  } catch (_error) {
    restoreSportAgentHandshakeSnapshot(storage, snapshot);
    return null;
  }
}

export function activateSportAgentPrestart(storage, identity, session, options = {}) {
  const journal = readSportAgentPrestart(storage, identity);
  if (!journal || journal.state !== 'session_ready' || !journal.session
      || !session || journal.session.session_id !== session.session_id) return null;
  const active = {
    schema_version: 1,
    owner: sportsOwnerMarker(identity),
    client_session_id: journal.client_session_id,
    session_id: journal.session.session_id,
    workout_id: journal.workout_id,
    workout_revision: journal.workout_revision,
    capability_signature: journal.capability_signature,
    started_at_ms: int(options.startedAtMs, 0, 4102444800000),
    session: journal.session,
    ...(journal.workout_id ? {
      execution_plan: buildSportAgentExecutionPlan(
        journal.briefing.prescription,
        journal.session,
      ),
    } : {}),
  };
  if (active.started_at_ms == null
      || (journal.workout_id && !active.execution_plan) || !storage
      || typeof storage.setStorageSync !== 'function') return null;
  try {
    storage.setStorageSync(SPORT_AGENT_ACTIVE_KEY, active);
    const readback = storage.getStorageSync(SPORT_AGENT_ACTIVE_KEY);
    if (JSON.stringify(readback) !== JSON.stringify(active)) return null;
    if (!removeStorageKey(storage, SPORT_AGENT_PRESTART_KEY)) return null;
    return active;
  } catch (_error) { return null; }
}

export function clearSportAgentActive(storage, identity, sessionId) {
  try {
    const value = storage && storage.getStorageSync(SPORT_AGENT_ACTIVE_KEY);
    if (!value || !ownerMatches(value.owner, identity)
        || value.session_id !== sessionId) return false;
    return removeStorageKey(storage, SPORT_AGENT_ACTIVE_KEY);
  } catch (_error) { return false; }
}

export function reconcileSportAgentActiveCompletion(storage, identity) {
  const active = readSportAgentActive(storage, identity);
  if (!active || active.completion_queued !== true) return active;
  if (completionOutboxItem(
    storage,
    identity,
    active.session_id,
    active.client_completion_id,
  )) return active;
  const cached = readSportAgentDebriefCache(storage, identity);
  if (!cached || cached.session_id !== active.session_id
      || cached.client_completion_id !== active.client_completion_id
      || cached.client_activity_id !== active.client_activity_id) return active;
  return clearSportAgentActive(storage, identity, active.session_id)
    ? null : active;
}

function completionOutboxItem(storage, identity, sessionId, completionId) {
  return readSportAgentOutbox(storage, identity).find((item) => (
    item.kind === 'complete'
    && item.session_id === sessionId
    && item.client_completion_id === completionId
  )) || null;
}

export function markSportAgentCompletionQueued(storage, identity, completion) {
  const normalized = normalizeSportAgentOutboxItem(completion);
  const active = readSportAgentActive(storage, identity);
  if (!normalized || normalized.kind !== 'complete' || !active
      || normalized.session_id !== active.session_id
      || !completionOutboxItem(
        storage,
        identity,
        normalized.session_id,
        normalized.client_completion_id,
      )) return null;
  const next = {
    ...active,
    completion_queued: true,
    client_completion_id: normalized.client_completion_id,
    client_activity_id: normalized.client_activity_id,
  };
  try {
    storage.setStorageSync(SPORT_AGENT_ACTIVE_KEY, next);
    const readback = readSportAgentActive(storage, identity);
    return readback
      && readback.session_id === active.session_id
      && readback.completion_queued === true
      && readback.client_completion_id === normalized.client_completion_id
      ? readback : null;
  } catch (_error) { return null; }
}

export function readSportAgentActive(storage, identity) {
  try {
    const value = storage && storage.getStorageSync(SPORT_AGENT_ACTIVE_KEY);
    if (!value || !exactKeys(value, [
      'schema_version', 'owner', 'client_session_id', 'session_id', 'workout_id',
      'workout_revision', 'capability_signature', 'started_at_ms', 'session',
    ], [
      'execution_plan', 'completion_queued', 'client_completion_id',
      'client_activity_id',
    ]) || value.schema_version !== 1 || !ownerMatches(value.owner, identity)
        || !CLIENT_ID_RE.test(text(value.client_session_id, 100))
        || !SESSION_ID_RE.test(text(value.session_id, 40))
        || wireInt(value.started_at_ms, 0, 4102444800000) == null) return null;
    const storedSession = {
      ...value.session,
      heart_rate_policy: value.session && value.session.heart_rate_policy
        ? { ...value.session.heart_rate_policy } : null,
    };
    if (storedSession.heart_rate_policy) delete storedSession.heart_rate_policy.authoritative;
    const session = parseSportAgentSessionResponse({
      statusCode: 200, data: storedSession,
    }, identity, {
      clientSessionId: value.client_session_id,
      briefingId: value.session && value.session.briefing_id,
      workoutId: value.workout_id || null,
      mode: value.session && value.session.mode,
      capabilities: value.session && value.session.capabilities,
      capabilityHash: value.session && value.session.capability_hash,
    });
    if (!session || session.session_id !== value.session_id) return null;
    if (value.workout_id) {
      const plan = normalizeSportsWorkoutPlan(value.execution_plan);
      if (!plan || plan.workout_id !== value.workout_id
          || plan.revision !== value.workout_revision) return null;
    } else if (value.execution_plan != null) return null;
    const completionQueued = value.completion_queued === true;
    if (value.completion_queued != null && typeof value.completion_queued !== 'boolean') {
      return null;
    }
    if (completionQueued) {
      if (!CLIENT_ID_RE.test(text(value.client_completion_id, 100))
          || !CLIENT_ID_RE.test(text(value.client_activity_id, 100))) return null;
    } else if (value.client_completion_id != null || value.client_activity_id != null) {
      return null;
    }
    return {
      ...value,
      session,
      ...(completionQueued ? {
        completion_queued: true,
        client_completion_id: value.client_completion_id,
        client_activity_id: value.client_activity_id,
      } : {}),
    };
  } catch (_error) { return null; }
}

export function abortRecoveredSportAgent(storage, identity, options = {}) {
  const active = readSportAgentActive(storage, identity);
  if (!active) return null;
  if (active.completion_queued === true) {
    return completionOutboxItem(
      storage,
      identity,
      active.session_id,
      active.client_completion_id,
    );
  }
  const endedAtMs = wireInt(options.endedAtMs, 946684800000, 4102444800000)
    ?? active.started_at_ms;
  const clientActivityId = text(options.clientActivityId, 100)
    || (active.client_session_id + '.recovered');
  const completion = {
    kind: 'complete',
    owner: sportsOwnerMarker(identity),
    session_id: active.session_id,
    client_completion_id: active.client_session_id + '.aborted',
    client_activity_id: clientActivityId,
    status: 'aborted',
    started_at_ms: active.started_at_ms,
    ended_at_ms: Math.max(active.started_at_ms, endedAtMs),
    duration_s: 0,
    summary: { sensor_sources: [] },
    ...(active.workout_id && active.execution_plan ? {
      workout_revision: active.workout_revision,
      stage_results: active.execution_plan.stages.map((stage) => ({
        stage_id: stage.stage_id,
        status: 'skipped',
        duration_s: 0,
        distance_m: 0,
        metrics: {},
      })),
    } : {}),
  };
  const queued = enqueueSportAgentItem(storage, completion, identity);
  if (!queued || !queued.some((item) => item.kind === 'complete'
      && item.client_completion_id === completion.client_completion_id)) return null;
  return markSportAgentCompletionQueued(storage, identity, completion)
    ? completion : null;
}

export async function prepareSportAgentSession(options = {}) {
  const {
    identity,
    request: perform,
    mode = 'free',
    workoutId = '',
    clientSessionId,
  } = options;
  const storage = options.storage;
  if (!identity || !storage || typeof perform !== 'function'
      || !CLIENT_ID_RE.test(clientSessionId || '')) {
    return null;
  }
  reconcileSportAgentHandshakeOwner(storage, identity);
  const requestedRevision = options.workoutRevision == null
    ? null : Number(options.workoutRevision);
  const existing = readSportAgentPrestart(storage, identity);
  if (existing) {
    const sameIntent = existing.mode === mode
      && (existing.workout_id || '') === workoutId
      && existing.workout_revision === requestedRevision;
    if (!sameIntent) return null;
    if (existing.state === 'session_ready' && existing.session) {
      return { briefing: existing.briefing, session: existing.session, recovered: true };
    }
    let replayResponse = null;
    try {
      replayResponse = await perform(request(identity, '/sessions', {
        ...existing.session_request_body,
      }, options));
    } catch (_error) {}
    const replayed = parseSportAgentSessionResponse(replayResponse, identity, {
      clientSessionId: existing.client_session_id,
      briefingId: existing.briefing.briefing_id,
      workoutId: existing.workout_id,
      mode: existing.mode,
      capabilities: existing.briefing.capabilities,
      capabilityHash: existing.briefing.capability_hash,
    });
    if (!replayed) return null;
    const storedReplay = writeSportAgentPrestart(storage, {
      ...existing, state: 'session_ready', session: replayed,
    }, identity);
    return storedReplay ? {
      briefing: storedReplay.briefing,
      session: storedReplay.session,
      recovered: true,
    } : null;
  }
  let briefingResponse = null;
  try {
    briefingResponse = await perform(buildSportAgentBriefingRequest(identity, {
      ...options,
      mode,
      workoutId,
    }));
  } catch (_error) {}
  const briefing = parseSportAgentBriefingResponse(briefingResponse, identity);
  if (!briefing) return null;
  let plannedPrescription = null;
  if (WORKOUT_ID_RE.test(workoutId)) {
    plannedPrescription = normalizeSportsWorkoutPlan(briefing.prescription);
    if (!plannedPrescription || plannedPrescription.workout_id !== workoutId
        || (options.workoutRevision != null
          && plannedPrescription.revision !== Number(options.workoutRevision))
        || briefing.readiness.launch_allowed !== true
        || !briefing.execution_stages.length) return null;
  }
  const sessionRequest = buildSportAgentSessionRequest(
    identity,
    briefing,
    clientSessionId,
    { ...options, workoutId },
  );
  const requestReady = writeSportAgentPrestart(storage, {
    schema_version: 1,
    state: 'request_ready',
    owner: sportsOwnerMarker(identity),
    mode: briefing.mode,
    workout_id: WORKOUT_ID_RE.test(workoutId) ? workoutId : null,
    workout_revision: WORKOUT_ID_RE.test(workoutId) ? requestedRevision : null,
    client_session_id: clientSessionId,
    capability_signature: sportAgentCapabilitiesSignature(briefing.capabilities),
    briefing,
    session_request_body: sessionRequest.data,
  }, identity);
  if (!requestReady) return null;
  let sessionResponse = null;
  try { sessionResponse = await perform(sessionRequest); } catch (_error) {}
  const session = parseSportAgentSessionResponse(sessionResponse, identity, {
    clientSessionId,
    briefingId: briefing.briefing_id,
    workoutId: WORKOUT_ID_RE.test(workoutId) ? workoutId : null,
    mode: briefing.mode,
    capabilities: briefing.capabilities,
    capabilityHash: briefing.capability_hash,
  });
  if (session && plannedPrescription) {
    const sessionPrescription = normalizeSportsWorkoutPlan(session.prescription);
    if (!sessionPrescription
        || JSON.stringify(sessionPrescription) !== JSON.stringify(plannedPrescription)
        || session.readiness.launch_allowed !== true
        || !buildSportAgentExecutionPlan(plannedPrescription, session)) return null;
  }
  if (!session) return null;
  const sessionReady = writeSportAgentPrestart(storage, {
    ...requestReady, state: 'session_ready', session,
  }, identity);
  return sessionReady ? { briefing: sessionReady.briefing, session: sessionReady.session } : null;
}

function isExactAnonymousClaim(previousIdentity, currentIdentity) {
  const previous = sportsOwnerMarker(previousIdentity);
  const current = sportsOwnerMarker(currentIdentity);
  const transition = currentIdentity && currentIdentity.ownership_transition;
  return !!previous && !!current
    && previous.public_device_id === current.public_device_id
    && transition && transition.kind === 'anonymous_claim'
    && transition.previous_ownership_epoch === previous.ownership_epoch
    && transition.previous_data_namespace === previous.data_namespace
    && transition.current_ownership_epoch === current.ownership_epoch
    && transition.current_data_namespace === current.data_namespace;
}

function normalizeEventMetrics(value) {
  const source = value && typeof value === 'object' ? value : {};
  const result = {};
  for (const [key, min, max] of [
    ['speed_kmh', 0, 150], ['cadence_rpm', 0, 300], ['distance_m', 0, 1000000],
    ['power_w', -2000, 5000], ['heart_rate_bpm', 20, 240],
  ]) {
    const parsed = finite(source[key], min, max);
    if (parsed != null) result[key] = key === 'heart_rate_bpm' ? Math.round(parsed) : parsed;
  }
  if (['unknown', 'moving', 'stationary', 'paused'].includes(source.motion_state)) {
    result.motion_state = source.motion_state;
  }
  if (['unknown', 'low', 'medium', 'high'].includes(source.metric_quality)) {
    result.metric_quality = source.metric_quality;
  }
  return result;
}

function normalizeStageMetrics(value) {
  const source = value && typeof value === 'object' ? value : {};
  const result = {};
  for (const [key, min, max] of [
    ['avg_speed_kmh', 0, 150], ['avg_heart_rate_bpm', 20, 240],
    ['avg_cadence_rpm', 0, 300], ['avg_power_w', -2000, 5000],
  ]) {
    const parsed = finite(source[key], min, max);
    if (parsed != null) {
      result[key] = key === 'avg_heart_rate_bpm' ? Math.round(parsed) : parsed;
    }
  }
  return result;
}

function normalizeAggregateStageResult(value) {
  if (!value || typeof value !== 'object') return null;
  const stageId = text(value.stage_id, 40);
  const status = text(value.status, 16);
  const durationS = int(value.duration_s, 0, 43200);
  const distanceM = finite(value.distance_m, 0, 1000000);
  if (!/^(?:sps|stg)_[a-f0-9]{24}$/.test(stageId)
      || !['completed', 'partial', 'skipped'].includes(status)
      || durationS == null || distanceM == null
      || (status === 'skipped' && (durationS !== 0 || distanceM !== 0))) return null;
  return {
    stage_id: stageId,
    status,
    duration_s: durationS,
    distance_m: distanceM,
    metrics: normalizeStageMetrics(value.metrics),
  };
}

export function normalizeSportAgentOutboxItem(value) {
  if (!value || typeof value !== 'object' || !['event', 'complete'].includes(value.kind)) return null;
  const owner = sportsOwnerMarker(value.owner);
  const sessionId = text(value.session_id, 40);
  if (!owner || !SESSION_ID_RE.test(sessionId)) return null;
  if (value.kind === 'event') {
    const clientEventId = text(value.client_event_id, 100);
    const seq = int(value.seq, 1, 2147483647);
    const capturedAtMs = int(value.captured_at_ms, 946684800000, 4102444800000);
    const elapsedS = int(value.elapsed_s, 0, 172800);
    const eventKind = text(value.event_kind, 20);
    if (!CLIENT_ID_RE.test(clientEventId) || seq == null || capturedAtMs == null
        || elapsedS == null || !EVENT_KINDS.includes(eventKind)) return null;
    return {
      kind: 'event', owner, session_id: sessionId, client_event_id: clientEventId,
      seq, event_kind: eventKind, captured_at_ms: capturedAtMs, elapsed_s: elapsedS,
      ...(text(value.stage_id, 40) ? { stage_id: text(value.stage_id, 40) } : {}),
      metrics: normalizeEventMetrics(value.metrics),
    };
  }
  const clientCompletionId = text(value.client_completion_id, 100);
  const clientActivityId = text(value.client_activity_id, 100);
  const startedAtMs = int(value.started_at_ms, 946684800000, 4102444800000);
  const endedAtMs = int(value.ended_at_ms, 946684800000, 4102444800000);
  const durationS = int(value.duration_s, 0, 172800);
  const status = text(value.status, 16);
  if (!CLIENT_ID_RE.test(clientCompletionId) || !CLIENT_ID_RE.test(clientActivityId)
      || startedAtMs == null || endedAtMs == null || endedAtMs < startedAtMs
      || durationS == null || !STATUS.includes(status)) return null;
  const summary = normalizeAggregateSummary(value.summary);
  const workoutRevision = int(value.workout_revision, 1, 1000000000);
  const rawStages = Array.isArray(value.stage_results) ? value.stage_results : null;
  const stageResults = rawStages ? rawStages.map(normalizeAggregateStageResult) : null;
  const hasWorkoutFields = value.workout_revision != null || value.stage_results != null;
  if (hasWorkoutFields && (workoutRevision == null || !stageResults || !stageResults.length
      || stageResults.some((stage) => !stage)
      || new Set(stageResults.map((stage) => stage.stage_id)).size !== stageResults.length
      || stageResults.reduce((sum, stage) => sum + stage.duration_s, 0)
        > durationS + 2 * stageResults.length
      || (status === 'completed'
        && stageResults.some((stage) => stage.status !== 'completed')))) return null;
  return {
    kind: 'complete', owner, session_id: sessionId,
    client_completion_id: clientCompletionId,
    client_activity_id: clientActivityId,
    status, started_at_ms: startedAtMs, ended_at_ms: endedAtMs,
    duration_s: durationS, summary,
    ...(hasWorkoutFields ? {
      workout_revision: workoutRevision,
      stage_results: stageResults,
    } : {}),
  };
}

export function readSportAgentOutbox(storage, identity) {
  try {
    const raw = storage && typeof storage.getStorageSync === 'function'
      ? storage.getStorageSync(SPORT_AGENT_OUTBOX_KEY) : [];
    const owner = sportsOwnerMarker(identity);
    return Array.isArray(raw) ? raw.map(normalizeSportAgentOutboxItem).filter(
      (item) => item && JSON.stringify(item.owner) === JSON.stringify(owner),
    ).slice(0, SPORT_AGENT_OUTBOX_MAX) : [];
  } catch (_error) {
    return [];
  }
}

export function writeSportAgentOutbox(storage, items, identity) {
  if (!storage || typeof storage.setStorageSync !== 'function') return null;
  const owner = sportsOwnerMarker(identity);
  const normalized = Array.isArray(items) ? items.map(normalizeSportAgentOutboxItem).filter(
    (item) => item && JSON.stringify(item.owner) === JSON.stringify(owner),
  ).slice(0, SPORT_AGENT_OUTBOX_MAX) : [];
  try {
    storage.setStorageSync(SPORT_AGENT_OUTBOX_KEY, normalized);
    const readback = readSportAgentOutbox(storage, identity);
    return JSON.stringify(readback) === JSON.stringify(normalized) ? readback : null;
  } catch (_error) {
    return null;
  }
}

export function migrateSportAgentOutboxForAnonymousClaim(
  storage,
  previousIdentity,
  currentIdentity,
) {
  if (!storage || !isExactAnonymousClaim(previousIdentity, currentIdentity)) return null;
  const previousItems = readSportAgentOutbox(storage, previousIdentity);
  if (!previousItems.length) return [];
  const migrated = previousItems.map((item) => ({
    ...item,
    owner: sportsOwnerMarker(currentIdentity),
  }));
  return writeSportAgentOutbox(storage, migrated, currentIdentity);
}

export function enqueueSportAgentItem(storage, item, identity) {
  const normalized = normalizeSportAgentOutboxItem(item);
  if (!normalized || JSON.stringify(normalized.owner)
      !== JSON.stringify(sportsOwnerMarker(identity))) return null;
  const key = normalized.kind === 'event'
    ? normalized.client_event_id : normalized.client_completion_id;
  const items = readSportAgentOutbox(storage, identity).filter((entry) => (
    entry.kind !== normalized.kind
    || (entry.kind === 'event' ? entry.client_event_id : entry.client_completion_id) !== key
  ));
  if (items.length >= SPORT_AGENT_OUTBOX_MAX) return null;
  items.push(normalized);
  return writeSportAgentOutbox(storage, items, identity);
}

export function buildSportAgentItemRequest(item, identity, options = {}) {
  const normalized = normalizeSportAgentOutboxItem(item);
  if (!normalized || JSON.stringify(normalized.owner)
      !== JSON.stringify(sportsOwnerMarker(identity))) return null;
  const payload = { ...normalized };
  delete payload.kind;
  delete payload.owner;
  // session_id is a durable local routing field and already appears in the
  // resource URL. Hermes EventIn/AggregateCompletionIn forbid extra fields.
  delete payload.session_id;
  const suffix = normalized.kind === 'event' ? '/events' : '/complete';
  return request(identity, '/sessions/' + normalized.session_id + suffix, {
    schema_version: 1,
    ...payload,
  }, options);
}

function parseAck(response, item, identity) {
  if (!response || response.statusCode !== 200) return null;
  const data = dataOf(response);
  const exact = item.kind === 'event'
    ? exactKeys(data, [
      'schema_version', 'session_id', 'client_event_id', 'seq', 'locale',
      'public_device_id', 'ownership_epoch', 'data_namespace', 'duplicate',
      'decision',
    ])
    : exactKeys(data, [
      'schema_version', 'debrief_id', 'session_id', 'locale',
      'client_completion_id', 'client_run_id', 'client_activity_id', 'duplicate',
      'status', 'canonical_summary', 'review', 'next_training', 'memory_status',
      'public_device_id', 'ownership_epoch', 'data_namespace',
    ]);
  if (!exact || data.schema_version !== 1
      || data.locale !== SPORT_AGENT_LOCALE
      || data.session_id !== item.session_id || typeof data.duplicate !== 'boolean') return null;
  if (item.kind === 'event') {
    return ownerMatches(data, identity)
      && data.client_event_id === item.client_event_id
      && wireInt(data.seq, 1, 2147483647) === item.seq
      && plainObject(data.decision)
      ? { kind: 'event', decision: data.decision } : null;
  }
  const debrief = normalizeSportAgentDebrief(data, identity, {
    sessionId: item.session_id,
    clientCompletionId: item.client_completion_id,
    clientActivityId: item.client_activity_id,
  });
  return debrief
    && data.client_completion_id === item.client_completion_id
    && data.client_activity_id === item.client_activity_id
    ? { kind: 'complete', debrief } : null;
}

function normalizeNextTraining(value) {
  if (!exactKeys(value, [
    'schema_version', 'strategy_version', 'direction', 'recommended_mode',
    'duration_sec', 'reason_codes', 'confidence', 'evidence_count', 'message',
  ]) || value.schema_version !== 2 || value.strategy_version !== 2) return null;
  const direction = wireText(value.direction, 16, { nonempty: true });
  const recommendedMode = wireText(value.recommended_mode, 24, { nonempty: true });
  const durationS = wireInt(value.duration_sec, 600, 3600);
  const reasons = stringArray(value.reason_codes, NEXT_REASONS, 8);
  const confidence = wireText(value.confidence, 16, { nonempty: true });
  const evidenceCount = wireInt(value.evidence_count, 0, 20);
  const message = wireText(value.message, 240, { nonempty: true });
  if (!NEXT_DIRECTIONS.includes(direction) || !NEXT_MODES.includes(recommendedMode)
      || durationS == null || !reasons || !CONFIDENCE.includes(confidence)
      || evidenceCount == null || !message) return null;
  return {
    schema_version: 2,
    strategy_version: 2,
    direction,
    recommended_mode: recommendedMode,
    duration_sec: durationS,
    reason_codes: reasons,
    confidence,
    evidence_count: evidenceCount,
    message,
  };
}

export function normalizeSportAgentDebrief(value, identity, expected = {}) {
  const completionId = wireText(value && value.client_completion_id, 100, { nonempty: true });
  const rawRunId = value && value.client_run_id;
  const rawActivityId = value && value.client_activity_id;
  const runIdValid = rawRunId === null
    || (typeof rawRunId === 'string' && CLIENT_ID_RE.test(rawRunId));
  const activityIdValid = rawActivityId === null
    || (typeof rawActivityId === 'string' && CLIENT_ID_RE.test(rawActivityId));
  const reviewRequired = [
    'schema_version', 'headline', 'detail', 'focus', 'load_direction',
    'next_training', 'evidence',
  ];
  const review = plainObject(value && value.review) && exactKeys(
    value.review, reviewRequired, ['ai_review'],
  ) ? value.review : null;
  const reviewText = review ? {
    headline: wireText(review.headline, 240),
    detail: wireText(review.detail, 1000),
    focus: wireText(review.focus, 1000),
    load_direction: wireText(review.load_direction, 32, { nonempty: true }),
    ...(Object.prototype.hasOwnProperty.call(review, 'ai_review') ? {
      ai_review: wireText(review.ai_review, 2000, { nonempty: true }),
    } : {}),
  } : null;
  if (!exactKeys(value, [
    'schema_version', 'debrief_id', 'session_id', 'locale',
    'client_completion_id', 'client_run_id', 'client_activity_id', 'duplicate',
    'status', 'canonical_summary', 'review', 'next_training', 'memory_status',
    'public_device_id', 'ownership_epoch', 'data_namespace',
  ]) || value.schema_version !== 1
      || !DEBRIEF_ID_RE.test(text(value.debrief_id, 40))
      || !SESSION_ID_RE.test(text(value.session_id, 40))
      || value.locale !== SPORT_AGENT_LOCALE || !ownerMatches(value, identity)
      || !DEBRIEF_STATUSES.includes(wireText(value.status, 16, { nonempty: true }))
      || !MEMORY_STATUSES.includes(wireText(value.memory_status, 32, { nonempty: true }))
      || typeof value.duplicate !== 'boolean'
      || !CLIENT_ID_RE.test(completionId || '')
      || !runIdValid || !activityIdValid
      || !plainObject(value.canonical_summary) || !review || !reviewText
      || Object.values(reviewText).some((item) => item == null)
      || wireInt(review.schema_version, 1, 1) !== 1
      || !plainObject(review.next_training) || !plainObject(review.evidence)) return null;
  const nextTraining = normalizeNextTraining(value.next_training);
  if (!nextTraining) return null;
  if (expected.sessionId && value.session_id !== expected.sessionId) return null;
  if (expected.clientCompletionId
      && value.client_completion_id !== expected.clientCompletionId) return null;
  if (expected.clientActivityId
      && value.client_activity_id !== expected.clientActivityId) return null;
  return {
    schema_version: 1,
    debrief_id: value.debrief_id,
    session_id: value.session_id,
    locale: SPORT_AGENT_LOCALE,
    client_completion_id: completionId,
    client_run_id: rawRunId,
    client_activity_id: rawActivityId,
    duplicate: value.duplicate === true,
    status: value.status,
    memory_status: value.memory_status,
    canonical_summary: value.canonical_summary,
    review: {
      schema_version: 1,
      ...reviewText,
      next_training: review.next_training,
      evidence: review.evidence,
    },
    next_training: nextTraining,
    ...sportsOwnerMarker(identity),
  };
}

export function buildSportAgentDebriefRequest(identity, sessionId, options = {}) {
  if (!SESSION_ID_RE.test(text(sessionId, 40))) return null;
  return request(identity, '/sessions/' + sessionId + '/debrief', null, options, 'GET');
}

export function parseSportAgentDebriefResponse(response, identity, expected = {}) {
  return response && response.statusCode === 200
    ? normalizeSportAgentDebrief(dataOf(response), identity, expected) : null;
}

export function readSportAgentDebriefCache(storage, identity) {
  try {
    const raw = storage && typeof storage.getStorageSync === 'function'
      ? storage.getStorageSync(SPORT_AGENT_DEBRIEF_CACHE_KEY) : null;
    return normalizeSportAgentDebrief(raw, identity);
  } catch (_error) { return null; }
}

export function writeSportAgentDebriefCache(storage, value, identity) {
  const normalized = normalizeSportAgentDebrief(value, identity);
  if (!normalized || !storage || typeof storage.setStorageSync !== 'function') return null;
  try {
    storage.setStorageSync(SPORT_AGENT_DEBRIEF_CACHE_KEY, normalized);
    const readback = readSportAgentDebriefCache(storage, identity);
    return JSON.stringify(readback) === JSON.stringify(normalized) ? readback : null;
  } catch (_error) { return null; }
}

export function migrateSportAgentDebriefForAnonymousClaim(
  storage,
  previousIdentity,
  currentIdentity,
) {
  if (!isExactAnonymousClaim(previousIdentity, currentIdentity)) return null;
  const previous = readSportAgentDebriefCache(storage, previousIdentity);
  if (!previous) return null;
  return writeSportAgentDebriefCache(storage, {
    ...previous,
    ...sportsOwnerMarker(currentIdentity),
  }, currentIdentity);
}

export async function refreshSportAgentDebrief(options = {}) {
  const { storage, identity, request: perform, sessionId } = options;
  if (!storage || !identity || typeof perform !== 'function') return null;
  let response = null;
  try { response = await perform(buildSportAgentDebriefRequest(identity, sessionId, options)); }
  catch (_error) {}
  if (Number(response && response.statusCode) === 401
      && options.refreshIdentity && options.authRefreshUsed !== true) {
    let refreshed = null;
    try { refreshed = await options.refreshIdentity(); } catch (_error) {}
    if (refreshed && JSON.stringify(sportsOwnerMarker(refreshed))
        === JSON.stringify(sportsOwnerMarker(identity))) {
      return refreshSportAgentDebrief({
        ...options,
        identity: refreshed,
        authRefreshUsed: true,
      });
    }
    return null;
  }
  const parsed = parseSportAgentDebriefResponse(response, identity, {
    sessionId,
    clientCompletionId: options.clientCompletionId,
    clientActivityId: options.clientActivityId,
  });
  return parsed ? writeSportAgentDebriefCache(storage, parsed, identity) : null;
}

export async function flushSportAgentOutbox(options = {}) {
  const { storage, identity, request: perform } = options;
  if (!storage || !identity || typeof perform !== 'function') {
    return { status: 'pending', acked: 0, pending: 0, debrief: null };
  }
  // A previous exact completion ACK may already have durably populated the
  // debrief cache while the final active-marker removal was interrupted.
  // Reconcile that proof before reading the outbox so a restart cannot remain
  // permanently blocked after the server has already accepted completion.
  reconcileSportAgentActiveCompletion(storage, identity);
  let acked = 0;
  let debrief = null;
  const items = readSportAgentOutbox(storage, identity);
  for (const item of items) {
    const requestOptions = buildSportAgentItemRequest(item, identity, options);
    if (!requestOptions) break;
    let response = null;
    try { response = await perform(requestOptions); } catch (_error) {}
    if (Number(response && response.statusCode) === 401
        && options.refreshIdentity && options.authRefreshUsed !== true) {
      const refreshed = await options.refreshIdentity();
      if (refreshed && JSON.stringify(sportsOwnerMarker(refreshed))
          === JSON.stringify(sportsOwnerMarker(identity))) {
        return flushSportAgentOutbox({ ...options, identity: refreshed, authRefreshUsed: true });
      }
    }
    const parsed = parseAck(response, item, identity);
    if (!parsed) return {
      status: 'pending', acked, pending: items.length - acked,
      statusCode: Number(response && response.statusCode) || 0, debrief,
    };
    // A completion ACK is not durable until its deterministic review, memory
    // state and next-session strategy have survived an owner-bound readback.
    // Keeping the completion in the outbox on cache failure makes the same
    // idempotent complete safe to retry after a crash or storage hiccup.
    if (parsed.debrief
        && !writeSportAgentDebriefCache(storage, parsed.debrief, identity)) {
      return {
        status: 'pending', acked, pending: items.length - acked,
        statusCode: Number(response && response.statusCode) || 0, debrief,
      };
    }
    const remaining = readSportAgentOutbox(storage, identity).filter((entry) => (
      entry.kind !== item.kind
      || (entry.kind === 'event' ? entry.client_event_id : entry.client_completion_id)
        !== (item.kind === 'event' ? item.client_event_id : item.client_completion_id)
    ));
    if (!writeSportAgentOutbox(storage, remaining, identity)) {
      return { status: 'pending', acked, pending: remaining.length + 1, debrief };
    }
    if (parsed.debrief) {
      // Release the owner-bound active session only after three pieces of
      // evidence are durable: strict Hermes debrief ACK, debrief-cache
      // readback, and removal of the matching completion from the outbox.
      // If this final storage write is interrupted, the cache reconciliation
      // above retries it on the next foreground flush.
      reconcileSportAgentActiveCompletion(storage, identity);
    }
    acked += 1;
    if (parsed.debrief) debrief = parsed.debrief;
  }
  return {
    status: 'acked', acked,
    pending: readSportAgentOutbox(storage, identity).length,
    debrief,
  };
}

export function createSportAgentClientId(prefix, now = Date.now(), random = Math.random) {
  const suffix = Math.floor(Math.abs(Number(random()) || 0) * 0x100000000)
    .toString(36).padStart(7, '0').slice(0, 7);
  return `${prefix}-${Math.floor(Number(now)).toString(36)}-${suffix}`;
}

export function buildSportAgentRideSummary(summary, options = {}) {
  const value = summary && typeof summary === 'object' ? summary : {};
  const result = {};
  for (const [source, target, min, max] of [
    ['distanceM', 'distance_m', 0, 1000000],
    ['avgBpm', 'avg_heart_rate_bpm', 20, 240],
    ['maxBpm', 'max_heart_rate_bpm', 20, 240],
    ['avgSpeedKmh', 'avg_speed_kmh', 0, 150],
    ['maxSpeedKmh', 'max_speed_kmh', 0, 200],
    ['avgCadenceRpm', 'avg_cadence_rpm', 0, 300],
    ['maxCadenceRpm', 'max_cadence_rpm', 0, 400],
    ['avgPowerW', 'avg_power_w', -2000, 5000],
    ['maxPowerW', 'max_power_w', -2000, 6000],
    ['gpsCoveragePct', 'gps_coverage_pct', 0, 100],
    ['heartRateCoveragePct', 'heart_rate_coverage_pct', 0, 100],
  ]) {
    const parsed = finite(value[source], min, max);
    if (parsed != null) {
      result[target] = target.endsWith('_heart_rate_bpm') ? Math.round(parsed) : parsed;
    }
  }
  const samples = int(value.heartRateSamples, 0, 1000000);
  if (samples != null) result.heart_rate_samples = samples;
  const rawCoverage = options.sourceCoverage && typeof options.sourceCoverage === 'object'
    ? options.sourceCoverage
    : (value.sourceCoverage && typeof value.sourceCoverage === 'object'
      ? value.sourceCoverage : {});
  const sourceCoverage = {};
  for (const source of SENSOR_SOURCES) {
    const parsed = finite(rawCoverage[source], 0, 100);
    if (parsed != null) sourceCoverage[source] = parsed;
  }
  if (Object.keys(sourceCoverage).length) result.source_coverage = sourceCoverage;
  const sensors = [];
  const candidates = [
    ...(Array.isArray(options.sensorSources) ? options.sensorSources : []),
    ...(Array.isArray(value.sources) ? value.sources : []),
    ...(Array.isArray(value.distanceSources) ? value.distanceSources : []),
    ...(Array.isArray(value.cadenceSources) ? value.cadenceSources : []),
  ];
  for (const candidate of candidates) {
    const source = candidate === 'cadence_model' ? 'imu' : candidate;
    if (SENSOR_SOURCES.includes(source) && !sensors.includes(source)) sensors.push(source);
  }
  if (sensors.length) result.sensor_sources = sensors;
  return normalizeAggregateSummary(result);
}

function normalizeAggregateSummary(value) {
  const source = value && typeof value === 'object' ? value : {};
  const result = {};
  for (const [key, min, max] of [
    ['distance_m', 0, 1000000],
    ['avg_heart_rate_bpm', 20, 240], ['max_heart_rate_bpm', 20, 240],
    ['avg_speed_kmh', 0, 150], ['max_speed_kmh', 0, 200],
    ['avg_cadence_rpm', 0, 300], ['max_cadence_rpm', 0, 400],
    ['avg_power_w', -2000, 5000], ['max_power_w', -2000, 6000],
    ['gps_coverage_pct', 0, 100], ['heart_rate_coverage_pct', 0, 100],
  ]) {
    const parsed = finite(source[key], min, max);
    if (parsed != null) {
      result[key] = key.endsWith('_heart_rate_bpm') ? Math.round(parsed) : parsed;
    }
  }
  const samples = int(source.heart_rate_samples, 0, 1000000);
  if (samples != null) result.heart_rate_samples = samples;
  const coverage = {};
  const rawCoverage = source.source_coverage && typeof source.source_coverage === 'object'
    ? source.source_coverage : {};
  for (const name of SENSOR_SOURCES) {
    const parsed = finite(rawCoverage[name], 0, 100);
    if (parsed != null) coverage[name] = parsed;
  }
  if (Object.keys(coverage).length) result.source_coverage = coverage;
  if (Array.isArray(source.sensor_sources)) {
    const sensors = [];
    for (const name of source.sensor_sources) {
      if (SENSOR_SOURCES.includes(name) && !sensors.includes(name)) sensors.push(name);
    }
    if (sensors.length) result.sensor_sources = sensors;
  }
  return result;
}

function liveMetric(snapshot, name) {
  const item = snapshot && snapshot.metrics && snapshot.metrics[name];
  if (!item || item.state !== 'live' || item.fresh === false || item.held === true) return null;
  return item.value;
}

export function buildSportAgentEventMetrics(snapshot) {
  const result = {};
  for (const [name, key, min, max] of [
    ['speed', 'speed_kmh', 0, 150], ['cadence', 'cadence_rpm', 0, 300],
    ['power', 'power_w', -2000, 5000], ['heartRate', 'heart_rate_bpm', 20, 240],
  ]) {
    const parsed = finite(liveMetric(snapshot, name), min, max);
    if (parsed != null) result[key] = key === 'heart_rate_bpm' ? Math.round(parsed) : parsed;
  }
  const distance = finite(snapshot && snapshot.distanceM, 0, 1000000);
  if (distance != null) result.distance_m = distance;
  result.motion_state = snapshot && snapshot.paused === true
    ? 'paused' : (result.speed_kmh > 0 || result.cadence_rpm > 0 ? 'moving' : 'stationary');
  const liveCount = ['speed_kmh', 'cadence_rpm', 'power_w', 'heart_rate_bpm']
    .filter((key) => result[key] != null).length;
  result.metric_quality = liveCount >= 2 ? 'high' : liveCount === 1 ? 'medium' : 'unknown';
  return result;
}
