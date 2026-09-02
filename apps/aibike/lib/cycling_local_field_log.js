// AIBike privacy-bounded local field log.
//
// Storage layout (all writes are synchronously read back):
//   aibike_local_field_log_index_v1
//   aibike_local_field_log_chunk_v1:<ride-id>:<000..239>
//
// The small index is rewritten only for lifecycle/state changes. Derived 1 Hz
// samples use compact tuples in 30-sample chunks, so normal capture rewrites
// only the active tail instead of a multi-ride JSON document. This archive is
// independent from Hermes pending/quarantine and is never deleted on ACK.

export const CYCLING_LOCAL_FIELD_LOG_KEY =
  'aibike_local_field_log_index_v1';
export const CYCLING_LOCAL_FIELD_LOG_CHUNK_PREFIX =
  'aibike_local_field_log_chunk_v1:';
export const CYCLING_LOCAL_FIELD_LOG_SCHEMA_VERSION = 1;
export const CYCLING_LOCAL_FIELD_LOG_MAX_RIDES = 3;
export const CYCLING_LOCAL_FIELD_LOG_CHUNK_SAMPLES = 30;
export const CYCLING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RIDE = 7200;
export const CYCLING_LOCAL_FIELD_LOG_MAX_CHUNKS_PER_RIDE =
  CYCLING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RIDE
    / CYCLING_LOCAL_FIELD_LOG_CHUNK_SAMPLES;
export const CYCLING_LOCAL_FIELD_LOG_MAX_CHUNK_BYTES = 64 * 1024;
export const CYCLING_LOCAL_FIELD_LOG_MAX_TOTAL_BYTES = 1536 * 1024;
export const CYCLING_LOCAL_FIELD_LOG_MAX_LIFECYCLE_EVENTS = 96;
export const CYCLING_LOCAL_FIELD_LOG_MAX_TTS_EVENTS = 96;
export const CYCLING_LOCAL_FIELD_LOG_MAX_UPLOAD_RESULTS = 48;
export const CYCLING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS = 1000;
export const CYCLING_LOCAL_FIELD_LOG_REPLAY_MAX_LINE_BYTES = 3000;

export const CYCLING_LOCAL_FIELD_LOG_STATUS = Object.freeze({
  PERSISTED: 'persisted',
  NO_CHANGE: 'no_change',
  INVALID_INPUT: 'invalid_input',
  RIDE_NOT_FOUND: 'ride_not_found',
  RIDE_FINISHED: 'ride_finished',
  STORAGE_UNAVAILABLE: 'storage_unavailable',
  READ_FAILED: 'read_failed',
  INVALID_STORAGE: 'invalid_storage',
  PARTIAL_STORAGE: 'partial_storage',
  WRITE_FAILED: 'write_failed',
  VERIFICATION_FAILED: 'verification_failed',
  CAPACITY_EXCEEDED: 'capacity_exceeded',
  CHUNK_TOO_LARGE: 'chunk_too_large',
});

const MIN_EPOCH_MS = 946684800000;
const MAX_EPOCH_MS = 4102444800000;
const MAX_RIDE_ELAPSED_MS = 48 * 60 * 60 * 1000;
const RIDE_ID_RE = /^(?:ride|local)-[a-z0-9]{6,16}-[a-z0-9]{10,20}$/;

const RIDE_STATUSES = Object.freeze(['active', 'completed', 'aborted']);
const STORAGE_STATES = Object.freeze([
  'ok', 'capacity', 'write_failed', 'partial',
]);
const METRIC_STATES = Object.freeze([
  'live', 'explicit_zero', 'subscribed', 'stale', 'unsupported',
]);
const METRIC_SOURCES = Object.freeze([
  'hrs', 'csc', 'cps', 'ftms', 'imu', 'none',
]);
const DISTANCE_SOURCES = Object.freeze([
  'csc', 'cps', 'ftms', 'imu', 'none',
]);
const DISTANCE_MODES = Object.freeze([
  'wheel', 'total', 'speed_integration', 'cadence_model', 'none',
]);
const BLE_STATES = Object.freeze([
  'idle', 'scanning', 'connecting', 'connected', 'reconnecting',
]);
const IMU_MOTION_STATES = Object.freeze([
  'unknown', 'moving', 'stationary', 'stale',
]);
const IMU_CADENCE_STATES = Object.freeze([
  'warming', 'unknown', 'estimated', 'stationary', 'artifact', 'stale',
]);
const IMU_QUALITY_STATES = Object.freeze([
  'warming', 'trusted', 'accel_only', 'head_motion', 'touch',
  'road_impact', 'stale', 'paused', 'unavailable',
]);
const IMU_ARTIFACTS = Object.freeze([
  'none', 'head_turn', 'touch', 'road_impact',
]);
const SAMPLE_TRIGGERS = Object.freeze([
  'ticker', 'accelerometer', 'gyroscope', 'orientation', 'hrs',
  'csc', 'cps', 'ftms', 'finish', 'unknown',
]);
const ESTIMATE_LEVELS = Object.freeze([
  'none', 'candidate', 'locked', 'stationary',
]);
const SPEED_PROFILES = Object.freeze([
  'unavailable', 'calibrated', 'walking_like', 'high_cadence_harmonic',
  'elevated_cadence', 'candidate', 'cycling_unverified',
]);
const SIMPLE_GYRO_METHODS = Object.freeze([
  'none', 'spectral', 'spectral_crossing', 'spectral_harmonic',
  'low_rate_timestamp_consensus',
  'low_rate_timestamp_harmonic_consensus',
  'low_rate_timestamp_candidate',
  'low_rate_timestamp_harmonic_candidate',
  'fallback_crossing', 'fallback_autocorrelation', 'fallback_consensus',
  'spectral_consensus', 'downward_harmonic_relock', 'touch_display_hold',
]);
const SIMPLE_GYRO_ANALYSES = Object.freeze([
  'none', 'warming', 'low_energy', 'low_rate_collecting',
  'low_rate_ready', 'low_rate_candidate', 'low_rate_artifact_blocked',
  'low_rate_locked', 'low_rate_holding', 'standard_rate', 'touch_blocked',
]);
const SENSOR_DIAGNOSTIC_STATES = Object.freeze([
  'idle', 'starting', 'started', 'reading', 'low-rate', 'stalled',
  'restarting', 'error', 'start-failed', 'unavailable', 'unsupported',
  'stopped', 'paused', 'gyro-started', 'gyro-reading',
]);
const WORLD_AWARENESS_STATES = Object.freeze([
  'idle', 'unsupported', 'enabled', 'disabled', 'error',
]);
const HEAD_GESTURES = Object.freeze(['none', 'nod', 'shake']);
const LIFECYCLE_EVENTS = Object.freeze([
  'ride_started', 'hud_visible', 'hidden', 'paused', 'resumed',
  'imu_started', 'imu_stopped', 'imu_rebuild', 'imu_error',
  'ble_connected', 'ble_disconnected', 'summary_entered',
  'ride_finished', 'ride_aborted', 'page_unloaded',
]);
const LIFECYCLE_REASONS = Object.freeze([
  'user', 'host_hidden', 'host_show', 'sensor_stale', 'sensor_error',
  'recording_transition', 'summary', 'unload', 'reconnect', 'unknown',
]);
const SENSOR_KINDS = Object.freeze([
  'accelerometer', 'gyroscope', 'orientation', 'hrs', 'csc', 'cps',
  'ftms', 'bundle', 'runtime', 'none',
]);
const TTS_STATUSES = Object.freeze([
  'requested', 'started', 'finished', 'skipped', 'failed', 'cancelled',
]);
const TTS_CUES = Object.freeze([
  'ride_start', 'safety', 'stage_change', 'target_high', 'target_low',
  'source_loss', 'source_recovered', 'high_heart_rate', 'ride_finish',
  'unknown',
]);
const TTS_RESULTS = Object.freeze([
  'played', 'deduped', 'in_flight', 'empty_id', 'exception', 'hidden',
  'unloaded', 'unsupported', 'unknown',
]);
const UPLOAD_STATUSES = Object.freeze([
  'queued', 'uploading', 'acked', 'pending', 'quarantined',
  'rejected', 'deferred', 'empty',
]);
const UPLOAD_REASONS = Object.freeze([
  'auth', 'network', 'rate_limit', 'server', 'storage', 'ack',
  'budget', 'conflict', 'unavailable', 'aborted', 'unknown',
]);
const CONFLICT_CODES = Object.freeze([
  'invalid_request', 'validation', 'event_payload', 'ride_sequence',
  'ride_lifecycle', 'finish_conflict', 'event_conflict',
  'permanent_rejection',
]);

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function integerInRange(value, min, max) {
  const numeric = finite(value);
  if (numeric === null) return null;
  const rounded = Math.round(numeric);
  return Number.isSafeInteger(rounded) && rounded >= min && rounded <= max
    ? rounded : null;
}

function numberInRange(value, min, max, digits = 3) {
  const numeric = finite(value);
  if (numeric === null || numeric < min || numeric > max) return null;
  const scale = 10 ** digits;
  return Math.round(numeric * scale) / scale;
}

function enumValue(value, choices) {
  return typeof value === 'string' && choices.includes(value) ? value : null;
}

function validRideId(value) {
  return typeof value === 'string' && RIDE_ID_RE.test(value);
}

function stableJson(value) {
  try { return JSON.stringify(value); } catch (_error) { return ''; }
}

function addNumber(target, source, key, min, max, digits) {
  const value = numberInRange(source[key], min, max, digits);
  if (value !== null) target[key] = value;
}

function addInteger(target, source, key, min, max) {
  const value = integerInRange(source[key], min, max);
  if (value !== null) target[key] = value;
}

function addEnum(target, source, key, choices) {
  const value = enumValue(source[key], choices);
  if (value !== null) target[key] = value;
}

function addBoolean(target, source, key) {
  if (typeof source[key] === 'boolean') target[key] = source[key];
}

function normalizedSources(value, choices) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (let index = 0; index < value.length && result.length < 8; index += 1) {
    const item = enumValue(value[index], choices);
    if (item && !result.includes(item)) result.push(item);
  }
  return result;
}

export function cyclingLocalFieldLogUtf8Bytes(value) {
  const text = String(value == null ? '' : value);
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff
        && index + 1 < text.length
        && text.charCodeAt(index + 1) >= 0xdc00
        && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function forEachUtf8Byte(text, callback) {
  for (let index = 0; index < text.length; index += 1) {
    let codePoint = text.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff
        && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = ((codePoint - 0xd800) << 10)
          + (low - 0xdc00) + 0x10000;
        index += 1;
      }
    }
    if (codePoint < 0x80) callback(codePoint);
    else if (codePoint < 0x800) {
      callback(0xc0 | (codePoint >> 6));
      callback(0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      callback(0xe0 | (codePoint >> 12));
      callback(0x80 | ((codePoint >> 6) & 0x3f));
      callback(0x80 | (codePoint & 0x3f));
    } else {
      callback(0xf0 | (codePoint >> 18));
      callback(0x80 | ((codePoint >> 12) & 0x3f));
      callback(0x80 | ((codePoint >> 6) & 0x3f));
      callback(0x80 | (codePoint & 0x3f));
    }
  }
}

export function cyclingLocalFieldLogChecksum(value) {
  const text = String(value == null ? '' : value);
  let hash = 0x811c9dc5;
  forEachUtf8Byte(text, (byte) => {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  });
  return hash.toString(16).padStart(8, '0');
}

/** Strict whitelist: unknown/raw/location/identity fields have no output path. */
export function normalizeCyclingLocalFieldSample(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const capturedAtMs = integerInRange(
    value.captured_at_ms ?? value.capturedAtMs,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  const elapsedMs = integerInRange(
    value.elapsed_ms ?? value.elapsedMs,
    0,
    MAX_RIDE_ELAPSED_MS,
  );
  if (capturedAtMs === null || elapsedMs === null) return null;
  const source = {
    ...value,
    moving_ms: value.moving_ms ?? value.movingMs,
    distance_coverage_ms:
      value.distance_coverage_ms ?? value.distanceCoverageMs,
    distance_delta_m: value.distance_delta_m ?? value.distanceDeltaM,
    coverage_delta_ms: value.coverage_delta_ms ?? value.coverageDeltaMs,
    distance_ever_available:
      value.distance_ever_available ?? value.distanceEverAvailable,
    final_speed_kmh: value.final_speed_kmh ?? value.finalSpeedKmh,
    effective_speed_kmh:
      value.effective_speed_kmh ?? value.effectiveSpeedKmh,
    raw_speed_kmh: value.raw_speed_kmh ?? value.rawSpeedKmh,
    stabilized_speed_kmh:
      value.stabilized_speed_kmh ?? value.stabilizedSpeedKmh,
    final_cadence_rpm:
      value.final_cadence_rpm ?? value.finalCadenceRpm,
    effective_cadence_rpm:
      value.effective_cadence_rpm ?? value.effectiveCadenceRpm,
    raw_cadence_rpm: value.raw_cadence_rpm ?? value.rawCadenceRpm,
    stabilized_cadence_rpm:
      value.stabilized_cadence_rpm ?? value.stabilizedCadenceRpm,
    distance_ledger_eligible:
      value.distance_ledger_eligible ?? value.distanceLedgerEligible,
    simple_gyro_ledger_fresh:
      value.simple_gyro_ledger_fresh ?? value.simpleGyroLedgerFresh,
    simple_gyro_method:
      value.simple_gyro_method ?? value.simpleGyroCadenceMethod,
    simple_gyro_analysis:
      value.simple_gyro_analysis ?? value.simpleGyroAnalysisState,
    estimate_level: value.estimate_level ?? value.cadenceEstimateLevel,
    estimate_usable: value.estimate_usable
      ?? value.availabilityCadenceUsable ?? value.cadenceUsable,
    estimate_stabilized:
      value.estimate_stabilized ?? value.estimateStabilized,
    raw_artifact: value.raw_artifact ?? value.rawMotionArtifact,
    walking_like: value.walking_like ?? value.walkingLike,
    walking_confidence:
      value.walking_confidence ?? value.walkingLikeConfidence,
    speed_profile: value.speed_profile ?? value.speedEstimateProfile,
  };
  const sample = { captured_at_ms: capturedAtMs, elapsed_ms: elapsedMs };
  const numbers = [
    ['speed_kmh', 0, 150, 3], ['cadence_rpm', 0, 300, 2],
    ['candidate_cadence_rpm', 0, 400, 2], ['distance_m', 0, 1000000, 3],
    ['power_w', -2000, 5000, 1],
    ['final_speed_kmh', 0, 150, 3], ['effective_speed_kmh', 0, 150, 3],
    ['raw_speed_kmh', 0, 150, 3], ['stabilized_speed_kmh', 0, 150, 3],
    ['final_cadence_rpm', 0, 400, 2],
    ['effective_cadence_rpm', 0, 400, 2],
    ['raw_cadence_rpm', 0, 400, 2],
    ['stabilized_cadence_rpm', 0, 400, 2],
    ['distance_delta_m', 0, 10000, 3],
    ['imu_motion_confidence', 0, 1, 4],
    ['imu_cadence_confidence', 0, 1, 4],
    ['imu_cadence_correlation', -1, 1, 4],
    ['walking_confidence', 0, 1, 4],
    ['accelerometer_hz', 0, 200, 2],
    ['gyroscope_hz', 0, 200, 2],
    ['orientation_hz', 0, 200, 2],
  ];
  for (let index = 0; index < numbers.length; index += 1) {
    const [key, min, max, digits] = numbers[index];
    addNumber(sample, source, key, min, max, digits);
  }
  const integers = [
    ['heart_rate_bpm', 20, 240], ['moving_ms', 0, MAX_RIDE_ELAPSED_MS],
    ['distance_coverage_ms', 0, MAX_RIDE_ELAPSED_MS],
    ['coverage_delta_ms', 0, 600000], ['reconnect_count', 0, 1000],
    ['tick_gap_ms', 0, 600000], ['sensor_generation', 0, 1000000],
    ['imu_restart_count', 0, 1000], ['gyroscope_restart_count', 0, 1000],
    ['orientation_restart_count', 0, 1000],
    ['accelerometer_age_ms', 0, 600000],
    ['gyroscope_age_ms', 0, 600000],
    ['orientation_age_ms', 0, 600000],
    ['accelerometer_frames', 0, 1000000000],
    ['gyroscope_frames', 0, 1000000000],
    ['orientation_frames', 0, 1000000000],
    ['orientation_stability_age_ms', 0, 600000],
    ['head_gesture_age_ms', 0, 600000],
    ['orientation_stability_change_count', 0, 1000000],
    ['head_gesture_count', 0, 1000000],
    ['head_nod_count', 0, 1000000],
    ['head_shake_count', 0, 1000000],
  ];
  for (let index = 0; index < integers.length; index += 1) {
    const [key, min, max] = integers[index];
    addInteger(sample, source, key, min, max);
  }
  const booleans = [
    'paused', 'page_visible', 'imu_fresh', 'distance_ever_available',
    'distance_ledger_eligible', 'simple_gyro_ledger_fresh',
    'estimate_usable', 'estimate_stabilized', 'walking_like',
    'accelerometer_activated', 'gyroscope_activated',
    'orientation_activated',
    'orientation_stable',
  ];
  for (let index = 0; index < booleans.length; index += 1) {
    addBoolean(sample, source, booleans[index]);
  }
  const enums = [
    ['speed_source', METRIC_SOURCES], ['cadence_source', METRIC_SOURCES],
    ['power_source', METRIC_SOURCES], ['heart_rate_source', METRIC_SOURCES],
    ['distance_source', DISTANCE_SOURCES], ['distance_mode', DISTANCE_MODES],
    ['speed_state', METRIC_STATES], ['cadence_state', METRIC_STATES],
    ['power_state', METRIC_STATES], ['heart_rate_state', METRIC_STATES],
    ['distance_state', METRIC_STATES], ['ble_state', BLE_STATES],
    ['imu_motion_state', IMU_MOTION_STATES],
    ['imu_cadence_state', IMU_CADENCE_STATES],
    ['imu_quality_state', IMU_QUALITY_STATES],
    ['imu_artifact', IMU_ARTIFACTS], ['raw_artifact', IMU_ARTIFACTS],
    ['trigger', SAMPLE_TRIGGERS], ['estimate_level', ESTIMATE_LEVELS],
    ['speed_profile', SPEED_PROFILES],
    ['simple_gyro_method', SIMPLE_GYRO_METHODS],
    ['simple_gyro_analysis', SIMPLE_GYRO_ANALYSES],
    ['accelerometer_state', SENSOR_DIAGNOSTIC_STATES],
    ['gyroscope_state', SENSOR_DIAGNOSTIC_STATES],
    ['orientation_state', SENSOR_DIAGNOSTIC_STATES],
    ['world_awareness_state', WORLD_AWARENESS_STATES],
    ['head_gesture', HEAD_GESTURES],
  ];
  for (let index = 0; index < enums.length; index += 1) {
    addEnum(sample, source, enums[index][0], enums[index][1]);
  }
  return sample;
}

export function normalizeCyclingLocalLifecycleEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const atMs = integerInRange(
    value.at_ms ?? value.atMs,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  const event = enumValue(value.event, LIFECYCLE_EVENTS);
  if (atMs === null || !event) return null;
  const normalized = { at_ms: atMs, event };
  addInteger(normalized, {
    elapsed_ms: value.elapsed_ms ?? value.elapsedMs,
  }, 'elapsed_ms', 0, MAX_RIDE_ELAPSED_MS);
  addInteger(normalized, value, 'generation', 0, 1000000);
  addEnum(normalized, value, 'reason', LIFECYCLE_REASONS);
  addEnum(normalized, value, 'sensor', SENSOR_KINDS);
  return normalized;
}

export function normalizeCyclingLocalTtsEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const atMs = integerInRange(
    value.at_ms ?? value.atMs,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  const status = enumValue(value.status, TTS_STATUSES);
  if (atMs === null || !status) return null;
  const normalized = { at_ms: atMs, status };
  addInteger(normalized, {
    elapsed_ms: value.elapsed_ms ?? value.elapsedMs,
  }, 'elapsed_ms', 0, MAX_RIDE_ELAPSED_MS);
  addInteger(normalized, value, 'stage_index', 0, 1000);
  addInteger(normalized, value, 'in_flight_ms', 0, 30000);
  addEnum(normalized, value, 'cue', TTS_CUES);
  addEnum(normalized, value, 'result', TTS_RESULTS);
  return normalized;
}

export function normalizeCyclingLocalUploadResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const atMs = integerInRange(
    value.at_ms ?? value.atMs,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  const status = enumValue(value.status, UPLOAD_STATUSES);
  if (atMs === null || !status) return null;
  const source = {
    ...value,
    http_status: value.http_status ?? value.statusCode,
    request_count: value.request_count ?? value.requestCount,
    server_samples: value.server_samples ?? value.serverSamples,
    finish_received: value.finish_received ?? value.finishReceived,
    conflict_code: value.conflict_code ?? value.conflictCode,
  };
  const normalized = { at_ms: atMs, status };
  const integers = [
    ['http_status', 0, 599], ['acked', 0, 1000000],
    ['pending', 0, 1000000], ['quarantined', 0, 1000000],
    ['request_count', 0, 1000], ['server_samples', 0, 1000000],
  ];
  for (let index = 0; index < integers.length; index += 1) {
    addInteger(normalized, source, integers[index][0], integers[index][1], integers[index][2]);
  }
  addBoolean(normalized, source, 'finish_received');
  addEnum(normalized, source, 'reason', UPLOAD_REASONS);
  addEnum(normalized, source, 'conflict_code', CONFLICT_CODES);
  return normalized;
}

export function normalizeCyclingLocalFieldSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = {
    ...value,
    elapsed_ms: value.elapsed_ms ?? value.elapsedMs,
    moving_ms: value.moving_ms ?? value.movingMs,
    distance_m: value.distance_m ?? value.distanceM,
    distance_coverage_ms:
      value.distance_coverage_ms ?? value.distanceCoverageMs,
    avg_speed_kmh: value.avg_speed_kmh ?? value.avgSpeedKmh,
    max_speed_kmh: value.max_speed_kmh ?? value.maxSpeedKmh,
    avg_cadence_rpm: value.avg_cadence_rpm ?? value.avgCadenceRpm,
    max_cadence_rpm: value.max_cadence_rpm ?? value.maxCadenceRpm,
    avg_power_w: value.avg_power_w ?? value.avgPowerW,
    max_power_w: value.max_power_w ?? value.maxPowerW,
    avg_heart_rate_bpm: value.avg_heart_rate_bpm ?? value.avgBpm,
    max_heart_rate_bpm: value.max_heart_rate_bpm ?? value.maxBpm,
    sample_count: value.sample_count ?? value.sampleCount,
  };
  const summary = {};
  const integers = [
    ['elapsed_ms', 0, MAX_RIDE_ELAPSED_MS],
    ['moving_ms', 0, MAX_RIDE_ELAPSED_MS],
    ['distance_coverage_ms', 0, MAX_RIDE_ELAPSED_MS],
    ['avg_heart_rate_bpm', 20, 240], ['max_heart_rate_bpm', 20, 240],
    ['sample_count', 0, CYCLING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RIDE],
  ];
  for (let index = 0; index < integers.length; index += 1) {
    addInteger(summary, source, integers[index][0], integers[index][1], integers[index][2]);
  }
  const numbers = [
    ['distance_m', 0, 1000000, 3], ['avg_speed_kmh', 0, 150, 3],
    ['max_speed_kmh', 0, 150, 3], ['avg_cadence_rpm', 0, 300, 2],
    ['max_cadence_rpm', 0, 300, 2], ['avg_power_w', -2000, 5000, 1],
    ['max_power_w', -2000, 5000, 1],
  ];
  for (let index = 0; index < numbers.length; index += 1) {
    addNumber(summary, source, numbers[index][0], numbers[index][1], numbers[index][2], numbers[index][3]);
  }
  const sources = normalizedSources(value.sources, METRIC_SOURCES);
  const distanceSources = normalizedSources(
    value.distance_sources ?? value.distanceSources,
    DISTANCE_SOURCES,
  );
  const cadenceSources = normalizedSources(
    value.cadence_sources ?? value.cadenceSources,
    METRIC_SOURCES,
  );
  if (sources.length) summary.sources = sources;
  if (distanceSources.length) summary.distance_sources = distanceSources;
  if (cadenceSources.length) summary.cadence_sources = cadenceSources;
  return Object.keys(summary).length ? summary : null;
}

function normalizeSamples(values, startedAtMs, endedAtMs = null) {
  if (!Array.isArray(values)) return [];
  const candidates = [];
  for (let index = 0; index < values.length; index += 1) {
    const sample = normalizeCyclingLocalFieldSample(values[index]);
    if (!sample || sample.captured_at_ms < startedAtMs
        || (endedAtMs !== null && sample.captured_at_ms > endedAtMs)) continue;
    candidates.push(sample);
  }
  candidates.sort((left, right) => left.captured_at_ms - right.captured_at_ms);
  const result = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const previous = result[result.length - 1];
    if (previous && candidates[index].captured_at_ms - previous.captured_at_ms
        < CYCLING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS) continue;
    result.push(candidates[index]);
  }
  return result.slice(0, CYCLING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RIDE);
}

function normalizeEventList(values, normalize, startedAtMs, max) {
  if (!Array.isArray(values)) return [];
  const result = [];
  for (let index = 0; index < values.length; index += 1) {
    const event = normalize(values[index]);
    const atMs = event && (event.at_ms ?? event.captured_at_ms);
    if (!event || atMs < startedAtMs) continue;
    if (!result.some((item) => stableJson(item) === stableJson(event))) {
      result.push(event);
    }
  }
  result.sort((left, right) => left.at_ms - right.at_ms);
  return result.slice(-max);
}

export function normalizeCyclingLocalFieldRide(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rideId = typeof value.ride_id === 'string'
    ? value.ride_id : value.rideId;
  const startedAtMs = integerInRange(
    value.started_at_ms ?? value.startedAtMs,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  const status = value.status == null
    ? 'active' : enumValue(value.status, RIDE_STATUSES);
  if (!validRideId(rideId) || startedAtMs === null || !status) return null;
  let endedAtMs = integerInRange(
    value.ended_at_ms ?? value.endedAtMs,
    startedAtMs,
    MAX_EPOCH_MS,
  );
  if (status === 'active') endedAtMs = null;
  if (status !== 'active' && endedAtMs === null) return null;
  const ride = {
    ride_id: rideId,
    started_at_ms: startedAtMs,
    status,
    samples: normalizeSamples(value.samples, startedAtMs, endedAtMs),
    lifecycle: normalizeEventList(
      value.lifecycle,
      normalizeCyclingLocalLifecycleEvent,
      startedAtMs,
      CYCLING_LOCAL_FIELD_LOG_MAX_LIFECYCLE_EVENTS,
    ),
    tts: normalizeEventList(
      value.tts,
      normalizeCyclingLocalTtsEvent,
      startedAtMs,
      CYCLING_LOCAL_FIELD_LOG_MAX_TTS_EVENTS,
    ),
    uploads: normalizeEventList(
      value.uploads,
      normalizeCyclingLocalUploadResult,
      startedAtMs,
      CYCLING_LOCAL_FIELD_LOG_MAX_UPLOAD_RESULTS,
    ),
    dropped_count: integerInRange(value.dropped_count, 0, 1000000) || 0,
    storage_status: enumValue(value.storage_status, STORAGE_STATES) || 'ok',
  };
  if (endedAtMs !== null) ride.ended_at_ms = endedAtMs;
  const summary = normalizeCyclingLocalFieldSummary(value.summary);
  if (summary) ride.summary = summary;
  return ride;
}

function retainRecentWithoutDeletingActive(rides) {
  const sorted = rides.slice().sort(
    (left, right) => right.started_at_ms - left.started_at_ms,
  );
  const active = sorted.filter((ride) => ride.status === 'active');
  const completed = sorted.filter((ride) => ride.status !== 'active');
  const completedSlots = Math.max(
    0,
    CYCLING_LOCAL_FIELD_LOG_MAX_RIDES - active.length,
  );
  return [...active, ...completed.slice(0, completedSlots)].sort(
    (left, right) => right.started_at_ms - left.started_at_ms,
  );
}

export function normalizeCyclingLocalFieldStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Number(value.schema_version) !== CYCLING_LOCAL_FIELD_LOG_SCHEMA_VERSION
      || !Array.isArray(value.rides)) {
    return { schema_version: CYCLING_LOCAL_FIELD_LOG_SCHEMA_VERSION, rides: [] };
  }
  const rides = [];
  const ids = new Set();
  for (let index = 0; index < value.rides.length; index += 1) {
    const ride = normalizeCyclingLocalFieldRide(value.rides[index]);
    if (!ride || ids.has(ride.ride_id)) continue;
    ids.add(ride.ride_id);
    rides.push(ride);
  }
  return {
    schema_version: CYCLING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    rides: retainRecentWithoutDeletingActive(rides),
  };
}

// Compact tuple schema. Strings use per-field numeric enum codes; booleans use
// 0/1. Trailing nulls are removed. Position 0 is captured_at_ms - chunk base.
const SAMPLE_TUPLE_FIELDS = Object.freeze([
  ['elapsed_ms'], ['speed_kmh'], ['cadence_rpm'], ['candidate_cadence_rpm'],
  ['distance_m'], ['power_w'], ['heart_rate_bpm'], ['moving_ms'],
  ['distance_coverage_ms'], ['distance_delta_m'], ['coverage_delta_ms'],
  ['final_speed_kmh'], ['effective_speed_kmh'], ['raw_speed_kmh'],
  ['stabilized_speed_kmh'], ['final_cadence_rpm'],
  ['effective_cadence_rpm'], ['raw_cadence_rpm'],
  ['stabilized_cadence_rpm'], ['imu_motion_confidence'],
  ['imu_cadence_confidence'], ['imu_cadence_correlation'],
  ['walking_confidence'], ['reconnect_count'], ['tick_gap_ms'],
  ['sensor_generation'], ['imu_restart_count'], ['gyroscope_restart_count'],
  ['orientation_restart_count'], ['accelerometer_age_ms'],
  ['gyroscope_age_ms'], ['orientation_age_ms'], ['accelerometer_hz'],
  ['gyroscope_hz'], ['orientation_hz'], ['accelerometer_frames'],
  ['gyroscope_frames'], ['orientation_frames'],
  ['paused', null, 'boolean'], ['page_visible', null, 'boolean'],
  ['imu_fresh', null, 'boolean'],
  ['distance_ever_available', null, 'boolean'],
  ['distance_ledger_eligible', null, 'boolean'],
  ['simple_gyro_ledger_fresh', null, 'boolean'],
  ['estimate_usable', null, 'boolean'],
  ['estimate_stabilized', null, 'boolean'],
  ['walking_like', null, 'boolean'],
  ['accelerometer_activated', null, 'boolean'],
  ['gyroscope_activated', null, 'boolean'],
  ['orientation_activated', null, 'boolean'],
  ['speed_source', METRIC_SOURCES], ['cadence_source', METRIC_SOURCES],
  ['power_source', METRIC_SOURCES], ['heart_rate_source', METRIC_SOURCES],
  ['distance_source', DISTANCE_SOURCES], ['distance_mode', DISTANCE_MODES],
  ['speed_state', METRIC_STATES], ['cadence_state', METRIC_STATES],
  ['power_state', METRIC_STATES], ['heart_rate_state', METRIC_STATES],
  ['distance_state', METRIC_STATES], ['ble_state', BLE_STATES],
  ['imu_motion_state', IMU_MOTION_STATES],
  ['imu_cadence_state', IMU_CADENCE_STATES],
  ['imu_quality_state', IMU_QUALITY_STATES],
  ['imu_artifact', IMU_ARTIFACTS], ['raw_artifact', IMU_ARTIFACTS],
  ['trigger', SAMPLE_TRIGGERS], ['estimate_level', ESTIMATE_LEVELS],
  ['speed_profile', SPEED_PROFILES],
  ['simple_gyro_method', SIMPLE_GYRO_METHODS],
  ['simple_gyro_analysis', SIMPLE_GYRO_ANALYSES],
  ['accelerometer_state', SENSOR_DIAGNOSTIC_STATES],
  ['gyroscope_state', SENSOR_DIAGNOSTIC_STATES],
  ['orientation_state', SENSOR_DIAGNOSTIC_STATES],
  ['orientation_stability_age_ms'], ['head_gesture_age_ms'],
  ['orientation_stability_change_count'], ['head_gesture_count'],
  ['head_nod_count'], ['head_shake_count'],
  ['orientation_stable', null, 'boolean'],
  ['world_awareness_state', WORLD_AWARENESS_STATES],
  ['head_gesture', HEAD_GESTURES],
]);

function encodeSampleTuple(sample, baseMs) {
  const tuple = [sample.captured_at_ms - baseMs];
  for (let index = 0; index < SAMPLE_TUPLE_FIELDS.length; index += 1) {
    const [key, choices, type] = SAMPLE_TUPLE_FIELDS[index];
    const value = sample[key];
    if (value === undefined) tuple.push(null);
    else if (type === 'boolean') tuple.push(value ? 1 : 0);
    else if (choices) tuple.push(choices.indexOf(value));
    else tuple.push(value);
  }
  while (tuple.length > 1 && tuple[tuple.length - 1] === null) tuple.pop();
  return tuple;
}

function decodeSampleTuple(tuple, baseMs) {
  if (!Array.isArray(tuple)) return null;
  const offset = integerInRange(tuple[0], 0, MAX_RIDE_ELAPSED_MS);
  if (offset === null) return null;
  const value = { captured_at_ms: baseMs + offset };
  for (let index = 0; index < SAMPLE_TUPLE_FIELDS.length; index += 1) {
    const encoded = tuple[index + 1];
    if (encoded === undefined || encoded === null) continue;
    const [key, choices, type] = SAMPLE_TUPLE_FIELDS[index];
    if (type === 'boolean') {
      if (encoded !== 0 && encoded !== 1) return null;
      value[key] = encoded === 1;
    } else if (choices) {
      const enumIndex = integerInRange(encoded, 0, choices.length - 1);
      if (enumIndex === null) return null;
      value[key] = choices[enumIndex];
    } else value[key] = encoded;
  }
  return normalizeCyclingLocalFieldSample(value);
}

export function cyclingLocalFieldLogChunkKey(rideId, chunkIndex) {
  const index = integerInRange(
    chunkIndex,
    0,
    CYCLING_LOCAL_FIELD_LOG_MAX_CHUNKS_PER_RIDE - 1,
  );
  if (!validRideId(rideId) || index === null) return '';
  return CYCLING_LOCAL_FIELD_LOG_CHUNK_PREFIX
    + rideId + ':' + String(index).padStart(3, '0');
}

function buildChunk(rideId, chunkIndex, values) {
  const samples = Array.isArray(values)
    ? values.map(normalizeCyclingLocalFieldSample).filter(Boolean) : [];
  if (!validRideId(rideId) || !samples.length
      || samples.length > CYCLING_LOCAL_FIELD_LOG_CHUNK_SAMPLES) return null;
  const baseMs = samples[0].captured_at_ms;
  const core = {
    v: CYCLING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    r: rideId,
    i: chunkIndex,
    b: baseMs,
    s: samples.map((sample) => encodeSampleTuple(sample, baseMs)),
  };
  return { ...core, h: cyclingLocalFieldLogChecksum(stableJson(core)) };
}

function decodeChunk(value, rideId, chunkIndex) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Number(value.v) !== CYCLING_LOCAL_FIELD_LOG_SCHEMA_VERSION
      || value.r !== rideId || Number(value.i) !== chunkIndex
      || !Array.isArray(value.s)
      || value.s.length < 1
      || value.s.length > CYCLING_LOCAL_FIELD_LOG_CHUNK_SAMPLES) return null;
  const baseMs = integerInRange(value.b, MIN_EPOCH_MS, MAX_EPOCH_MS);
  if (baseMs === null) return null;
  const core = { v: value.v, r: value.r, i: value.i, b: value.b, s: value.s };
  if (value.h !== cyclingLocalFieldLogChecksum(stableJson(core))) return null;
  const samples = value.s.map((tuple) => decodeSampleTuple(tuple, baseMs));
  if (samples.some((sample) => !sample)) return null;
  const normalized = normalizeSamples(samples, MIN_EPOCH_MS);
  if (normalized.length !== samples.length) return null;
  return { raw: value, samples, bytes: cyclingLocalFieldLogUtf8Bytes(stableJson(value)) };
}

function normalizeRideMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rideId = typeof value.ride_id === 'string' ? value.ride_id : '';
  const startedAtMs = integerInRange(
    value.started_at_ms,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  const status = enumValue(value.status, RIDE_STATUSES);
  const sampleCount = integerInRange(
    value.sample_count,
    0,
    CYCLING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RIDE,
  );
  const chunkCount = integerInRange(
    value.chunk_count,
    0,
    CYCLING_LOCAL_FIELD_LOG_MAX_CHUNKS_PER_RIDE,
  );
  if (!validRideId(rideId) || startedAtMs === null || !status
      || sampleCount === null || chunkCount === null
      || !Array.isArray(value.chunk_bytes)
      || value.chunk_bytes.length !== chunkCount
      || (sampleCount === 0) !== (chunkCount === 0)) return null;
  if (chunkCount > 0 && (sampleCount <= (chunkCount - 1)
      * CYCLING_LOCAL_FIELD_LOG_CHUNK_SAMPLES
      || sampleCount > chunkCount * CYCLING_LOCAL_FIELD_LOG_CHUNK_SAMPLES)) {
    return null;
  }
  const chunkBytes = [];
  for (let index = 0; index < value.chunk_bytes.length; index += 1) {
    const bytes = integerInRange(
      value.chunk_bytes[index],
      1,
      CYCLING_LOCAL_FIELD_LOG_MAX_CHUNK_BYTES,
    );
    if (bytes === null) return null;
    chunkBytes.push(bytes);
  }
  let endedAtMs = integerInRange(
    value.ended_at_ms,
    startedAtMs,
    MAX_EPOCH_MS,
  );
  if (status === 'active') endedAtMs = null;
  if (status !== 'active' && endedAtMs === null) return null;
  const metadata = {
    ride_id: rideId,
    started_at_ms: startedAtMs,
    status,
    sample_count: sampleCount,
    chunk_count: chunkCount,
    chunk_bytes: chunkBytes,
    dropped_count: integerInRange(value.dropped_count, 0, 1000000) || 0,
    storage_status: enumValue(value.storage_status, STORAGE_STATES) || 'ok',
    lifecycle: normalizeEventList(
      value.lifecycle,
      normalizeCyclingLocalLifecycleEvent,
      startedAtMs,
      CYCLING_LOCAL_FIELD_LOG_MAX_LIFECYCLE_EVENTS,
    ),
    tts: normalizeEventList(
      value.tts,
      normalizeCyclingLocalTtsEvent,
      startedAtMs,
      CYCLING_LOCAL_FIELD_LOG_MAX_TTS_EVENTS,
    ),
    uploads: normalizeEventList(
      value.uploads,
      normalizeCyclingLocalUploadResult,
      startedAtMs,
      CYCLING_LOCAL_FIELD_LOG_MAX_UPLOAD_RESULTS,
    ),
  };
  if (endedAtMs !== null) metadata.ended_at_ms = endedAtMs;
  const lastSampleAtMs = integerInRange(
    value.last_sample_at_ms,
    startedAtMs,
    MAX_EPOCH_MS,
  );
  const lastElapsedMs = integerInRange(
    value.last_elapsed_ms,
    0,
    MAX_RIDE_ELAPSED_MS,
  );
  if (sampleCount > 0 && (lastSampleAtMs === null || lastElapsedMs === null)) {
    return null;
  }
  if (sampleCount > 0) {
    metadata.last_sample_at_ms = lastSampleAtMs;
    metadata.last_elapsed_ms = lastElapsedMs;
  }
  const lastDistanceM = numberInRange(value.last_distance_m, 0, 1000000, 3);
  const lastCoverageMs = integerInRange(
    value.last_distance_coverage_ms,
    0,
    MAX_RIDE_ELAPSED_MS,
  );
  if (lastDistanceM !== null) metadata.last_distance_m = lastDistanceM;
  if (lastCoverageMs !== null) {
    metadata.last_distance_coverage_ms = lastCoverageMs;
  }
  const summary = normalizeCyclingLocalFieldSummary(value.summary);
  if (summary) metadata.summary = summary;
  return metadata;
}

function cleanupEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !validRideId(value.ride_id)) return null;
  const chunkCount = integerInRange(
    value.chunk_count,
    0,
    CYCLING_LOCAL_FIELD_LOG_MAX_CHUNKS_PER_RIDE,
  );
  if (chunkCount === null || !Array.isArray(value.chunk_bytes)
      || value.chunk_bytes.length !== chunkCount) return null;
  const chunkBytes = [];
  for (let index = 0; index < value.chunk_bytes.length; index += 1) {
    const bytes = integerInRange(
      value.chunk_bytes[index],
      1,
      CYCLING_LOCAL_FIELD_LOG_MAX_CHUNK_BYTES,
    );
    if (bytes === null) return null;
    chunkBytes.push(bytes);
  }
  return {
    ride_id: value.ride_id,
    chunk_count: chunkCount,
    chunk_bytes: chunkBytes,
  };
}

function emptyIndex() {
  return {
    schema_version: CYCLING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    rides: [],
    pending_cleanup: [],
  };
}

function normalizeIndexStrict(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Number(value.schema_version) !== CYCLING_LOCAL_FIELD_LOG_SCHEMA_VERSION
      || !Array.isArray(value.rides)
      || !Array.isArray(value.pending_cleanup)) return null;
  const rides = [];
  const ids = new Set();
  for (let index = 0; index < value.rides.length; index += 1) {
    const ride = normalizeRideMetadata(value.rides[index]);
    if (!ride || ids.has(ride.ride_id)) return null;
    ids.add(ride.ride_id);
    rides.push(ride);
  }
  const pendingCleanup = [];
  for (let index = 0; index < value.pending_cleanup.length; index += 1) {
    const entry = cleanupEntry(value.pending_cleanup[index]);
    if (!entry || ids.has(entry.ride_id)
        || pendingCleanup.some((item) => item.ride_id === entry.ride_id)) {
      return null;
    }
    pendingCleanup.push(entry);
  }
  rides.sort((left, right) => right.started_at_ms - left.started_at_ms);
  return {
    schema_version: CYCLING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    rides,
    pending_cleanup: pendingCleanup,
  };
}

function readIndexResult(storage) {
  if (!storage || typeof storage.getStorageSync !== 'function') {
    return {
      ok: false,
      status: CYCLING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE,
      index: emptyIndex(),
    };
  }
  try {
    const raw = storage.getStorageSync(CYCLING_LOCAL_FIELD_LOG_KEY);
    if (raw === undefined || raw === null || raw === '') {
      return {
        ok: true,
        status: CYCLING_LOCAL_FIELD_LOG_STATUS.PERSISTED,
        index: emptyIndex(),
      };
    }
    const index = normalizeIndexStrict(raw);
    if (!index) {
      return {
        ok: false,
        status: CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE,
        index: emptyIndex(),
      };
    }
    return {
      ok: true,
      status: CYCLING_LOCAL_FIELD_LOG_STATUS.PERSISTED,
      index,
    };
  } catch (_error) {
    return {
      ok: false,
      status: CYCLING_LOCAL_FIELD_LOG_STATUS.READ_FAILED,
      index: emptyIndex(),
    };
  }
}

function mutationResult(ok, status, index, rideId = '', extra = {}) {
  return {
    ok,
    status,
    index,
    store: index,
    ride: validRideId(rideId)
      ? index.rides.find((item) => item.ride_id === rideId) || null
      : null,
    ...extra,
  };
}

function writeIndexVerified(storage, value, rideId = '') {
  if (!storage || typeof storage.getStorageSync !== 'function'
      || typeof storage.setStorageSync !== 'function') {
    return mutationResult(
      false,
      CYCLING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE,
      normalizeIndexStrict(value) || emptyIndex(),
      rideId,
    );
  }
  const normalized = normalizeIndexStrict(value);
  if (!normalized) {
    return mutationResult(
      false,
      CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      emptyIndex(),
      rideId,
    );
  }
  try {
    storage.setStorageSync(CYCLING_LOCAL_FIELD_LOG_KEY, normalized);
  } catch (_error) {
    return mutationResult(
      false,
      CYCLING_LOCAL_FIELD_LOG_STATUS.WRITE_FAILED,
      normalized,
      rideId,
    );
  }
  const roundTrip = readIndexResult(storage);
  if (!roundTrip.ok
      || stableJson(roundTrip.index) !== stableJson(normalized)) {
    return mutationResult(
      false,
      CYCLING_LOCAL_FIELD_LOG_STATUS.VERIFICATION_FAILED,
      roundTrip.index,
      rideId,
    );
  }
  return mutationResult(
    true,
    CYCLING_LOCAL_FIELD_LOG_STATUS.PERSISTED,
    roundTrip.index,
    rideId,
  );
}

function readChunkResult(storage, rideId, chunkIndex, optional = false) {
  const key = cyclingLocalFieldLogChunkKey(rideId, chunkIndex);
  if (!key || !storage || typeof storage.getStorageSync !== 'function') {
    return {
      ok: false,
      status: CYCLING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE,
      exists: false,
      chunk: null,
    };
  }
  try {
    const raw = storage.getStorageSync(key);
    if (raw === undefined || raw === null || raw === '') {
      return optional
        ? { ok: true, status: 'missing', exists: false, chunk: null }
        : {
          ok: false,
          status: CYCLING_LOCAL_FIELD_LOG_STATUS.PARTIAL_STORAGE,
          exists: false,
          chunk: null,
        };
    }
    const chunk = decodeChunk(raw, rideId, chunkIndex);
    if (!chunk) {
      return {
        ok: false,
        status: CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE,
        exists: true,
        chunk: null,
      };
    }
    return { ok: true, status: 'ok', exists: true, chunk };
  } catch (_error) {
    return {
      ok: false,
      status: CYCLING_LOCAL_FIELD_LOG_STATUS.READ_FAILED,
      exists: false,
      chunk: null,
    };
  }
}

function writeChunkVerified(storage, rideId, chunkIndex, samples) {
  const key = cyclingLocalFieldLogChunkKey(rideId, chunkIndex);
  const value = buildChunk(rideId, chunkIndex, samples);
  if (!key || !value) {
    return { ok: false, status: CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT };
  }
  const bytes = cyclingLocalFieldLogUtf8Bytes(stableJson(value));
  if (bytes > CYCLING_LOCAL_FIELD_LOG_MAX_CHUNK_BYTES) {
    return { ok: false, status: CYCLING_LOCAL_FIELD_LOG_STATUS.CHUNK_TOO_LARGE };
  }
  if (!storage || typeof storage.getStorageSync !== 'function'
      || typeof storage.setStorageSync !== 'function') {
    return { ok: false, status: CYCLING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE };
  }
  try { storage.setStorageSync(key, value); } catch (_error) {
    return { ok: false, status: CYCLING_LOCAL_FIELD_LOG_STATUS.WRITE_FAILED };
  }
  const roundTrip = readChunkResult(storage, rideId, chunkIndex);
  if (!roundTrip.ok || stableJson(roundTrip.chunk.raw) !== stableJson(value)) {
    return { ok: false, status: CYCLING_LOCAL_FIELD_LOG_STATUS.VERIFICATION_FAILED };
  }
  return { ok: true, status: CYCLING_LOCAL_FIELD_LOG_STATUS.PERSISTED, bytes, chunk: roundTrip.chunk };
}

function removeChunkVerified(storage, rideId, chunkIndex) {
  const key = cyclingLocalFieldLogChunkKey(rideId, chunkIndex);
  if (!key || !storage || typeof storage.getStorageSync !== 'function'
      || typeof storage.removeStorageSync !== 'function') return false;
  try {
    storage.removeStorageSync(key);
    const after = storage.getStorageSync(key);
    return after === undefined || after === null || after === '';
  } catch (_error) {
    return false;
  }
}

function knownStorageBytes(index) {
  let bytes = cyclingLocalFieldLogUtf8Bytes(stableJson(index));
  for (let indexPosition = 0; indexPosition < index.rides.length; indexPosition += 1) {
    bytes += index.rides[indexPosition].chunk_bytes.reduce(
      (sum, value) => sum + value,
      0,
    );
  }
  for (let indexPosition = 0;
    indexPosition < index.pending_cleanup.length; indexPosition += 1) {
    bytes += index.pending_cleanup[indexPosition].chunk_bytes.reduce(
      (sum, value) => sum + value,
      0,
    );
  }
  return bytes;
}

function stageCompletedEvictions(storage, index, rideId = '') {
  const retained = retainRecentWithoutDeletingActive(index.rides);
  const retainedIds = new Set(retained.map((ride) => ride.ride_id));
  const evicted = index.rides.filter((ride) => !retainedIds.has(ride.ride_id));
  if (!evicted.length) {
    return mutationResult(
      true,
      CYCLING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE,
      index,
      rideId,
    );
  }
  const cleanup = index.pending_cleanup.slice();
  for (let position = 0; position < evicted.length; position += 1) {
    const ride = evicted[position];
    if (ride.status === 'active') continue;
    cleanup.push({
      ride_id: ride.ride_id,
      chunk_count: ride.chunk_count,
      chunk_bytes: ride.chunk_bytes.slice(),
    });
  }
  return writeIndexVerified(storage, {
    schema_version: CYCLING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    rides: retained,
    pending_cleanup: cleanup,
  }, rideId);
}

function evictOldestCompletedForCapacity(storage, index, protectedRideId) {
  const candidates = index.rides
    .filter((ride) => ride.status !== 'active'
      && ride.ride_id !== protectedRideId)
    .sort((left, right) => left.started_at_ms - right.started_at_ms);
  if (!candidates.length) {
    return mutationResult(
      true,
      CYCLING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE,
      index,
      protectedRideId,
      { evicted: false },
    );
  }
  const victim = candidates[0];
  const written = writeIndexVerified(storage, {
    schema_version: CYCLING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    rides: index.rides.filter((ride) => ride.ride_id !== victim.ride_id),
    pending_cleanup: [
      ...index.pending_cleanup,
      {
        ride_id: victim.ride_id,
        chunk_count: victim.chunk_count,
        chunk_bytes: victim.chunk_bytes.slice(),
      },
    ],
  }, protectedRideId);
  return { ...written, evicted: written.ok, evictedRideId: victim.ride_id };
}

function runPendingCleanup(storage, index, rideId = '') {
  if (!index.pending_cleanup.length) {
    return mutationResult(
      true,
      CYCLING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE,
      index,
      rideId,
    );
  }
  const remaining = [];
  for (let entryIndex = 0;
    entryIndex < index.pending_cleanup.length; entryIndex += 1) {
    const entry = index.pending_cleanup[entryIndex];
    let removed = true;
    for (let chunkIndex = 0; chunkIndex < entry.chunk_count; chunkIndex += 1) {
      if (!removeChunkVerified(storage, entry.ride_id, chunkIndex)) {
        removed = false;
      }
    }
    if (!removed) remaining.push(entry);
  }
  if (remaining.length === index.pending_cleanup.length) {
    return mutationResult(
      false,
      CYCLING_LOCAL_FIELD_LOG_STATUS.WRITE_FAILED,
      index,
      rideId,
      { cleanupPending: remaining.length },
    );
  }
  const written = writeIndexVerified(storage, {
    ...index,
    pending_cleanup: remaining,
  }, rideId);
  return {
    ...written,
    cleanupPending: written.ok
      ? written.index.pending_cleanup.length : index.pending_cleanup.length,
  };
}

function emptyRideMetadata(rideId, startedAtMs) {
  return {
    ride_id: rideId,
    started_at_ms: startedAtMs,
    status: 'active',
    sample_count: 0,
    chunk_count: 0,
    chunk_bytes: [],
    dropped_count: 0,
    storage_status: 'ok',
    lifecycle: [{
      at_ms: startedAtMs,
      elapsed_ms: 0,
      event: 'ride_started',
      reason: 'user',
      sensor: 'runtime',
    }],
    tts: [],
    uploads: [],
  };
}

export function beginCyclingLocalFieldLog(storage, options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const rideId = source.rideId ?? source.ride_id;
  const startedAtMs = integerInRange(
    source.startedAtMs ?? source.started_at_ms,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  if (!validRideId(rideId) || startedAtMs === null) {
    return mutationResult(
      false,
      CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      emptyIndex(),
    );
  }
  const current = readIndexResult(storage);
  if (!current.ok) {
    return mutationResult(false, current.status, current.index, rideId);
  }
  const existing = current.index.rides.find((ride) => ride.ride_id === rideId);
  if (existing) {
    return mutationResult(
      existing.started_at_ms === startedAtMs,
      existing.started_at_ms === startedAtMs
        ? CYCLING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE
        : CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      current.index,
      rideId,
    );
  }
  let written = writeIndexVerified(storage, {
    ...current.index,
    rides: [emptyRideMetadata(rideId, startedAtMs), ...current.index.rides],
  }, rideId);
  if (!written.ok) return written;
  written = stageCompletedEvictions(storage, written.index, rideId);
  if (!written.ok) return written;
  const cleaned = runPendingCleanup(storage, written.index, rideId);
  if (cleaned.ok) {
    return mutationResult(
      true,
      CYCLING_LOCAL_FIELD_LOG_STATUS.PERSISTED,
      cleaned.index,
      rideId,
      { cleanupPending: cleaned.index.pending_cleanup.length },
    );
  }
  // New active metadata is already durable. Cleanup failure must not stop the
  // ride; it remains tracked in pending_cleanup and is retried later.
  return mutationResult(
    true,
    CYCLING_LOCAL_FIELD_LOG_STATUS.PERSISTED,
    written.index,
    rideId,
    { cleanupPending: written.index.pending_cleanup.length },
  );
}

function replaceRideMetadata(index, ride) {
  return {
    ...index,
    rides: index.rides.map((item) => (
      item.ride_id === ride.ride_id ? ride : item
    )),
  };
}

function metadataFromTail(metadata, chunkIndex, chunk) {
  const last = chunk.samples[chunk.samples.length - 1];
  const chunkBytes = metadata.chunk_bytes.slice(0, chunkIndex);
  chunkBytes[chunkIndex] = chunk.bytes;
  const next = {
    ...metadata,
    sample_count: chunkIndex * CYCLING_LOCAL_FIELD_LOG_CHUNK_SAMPLES
      + chunk.samples.length,
    chunk_count: chunkIndex + 1,
    chunk_bytes: chunkBytes,
    last_sample_at_ms: last.captured_at_ms,
    last_elapsed_ms: last.elapsed_ms,
    storage_status: 'ok',
  };
  if (Number.isFinite(last.distance_m)) next.last_distance_m = last.distance_m;
  else delete next.last_distance_m;
  if (Number.isFinite(last.distance_coverage_ms)) {
    next.last_distance_coverage_ms = last.distance_coverage_ms;
  } else delete next.last_distance_coverage_ms;
  return normalizeRideMetadata(next);
}

function reconcileRideTail(storage, index, rideId) {
  let metadata = index.rides.find((ride) => ride.ride_id === rideId);
  if (!metadata) {
    return mutationResult(
      false,
      CYCLING_LOCAL_FIELD_LOG_STATUS.RIDE_NOT_FOUND,
      index,
      rideId,
    );
  }
  let tail = null;
  let changed = false;
  if (metadata.chunk_count > 0) {
    const tailResult = readChunkResult(
      storage,
      rideId,
      metadata.chunk_count - 1,
    );
    if (!tailResult.ok) {
      return mutationResult(false, tailResult.status, index, rideId);
    }
    tail = tailResult.chunk;
    const reconciled = metadataFromTail(
      metadata,
      metadata.chunk_count - 1,
      tail,
    );
    if (!reconciled) {
      return mutationResult(
        false,
        CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE,
        index,
        rideId,
      );
    }
    changed = stableJson(reconciled) !== stableJson(metadata);
    metadata = reconciled;
  }
  // If a chunk write succeeded but the small index write failed, recover that
  // one unreferenced next chunk before accepting more samples.
  while (metadata.chunk_count < CYCLING_LOCAL_FIELD_LOG_MAX_CHUNKS_PER_RIDE) {
    const orphan = readChunkResult(
      storage,
      rideId,
      metadata.chunk_count,
      true,
    );
    if (!orphan.ok) {
      return mutationResult(false, orphan.status, index, rideId);
    }
    if (!orphan.exists) break;
    if (tail && tail.samples.length !== CYCLING_LOCAL_FIELD_LOG_CHUNK_SAMPLES) {
      return mutationResult(
        false,
        CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE,
        index,
        rideId,
      );
    }
    tail = orphan.chunk;
    const reconciled = metadataFromTail(
      metadata,
      metadata.chunk_count,
      tail,
    );
    if (!reconciled) {
      return mutationResult(
        false,
        CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE,
        index,
        rideId,
      );
    }
    metadata = reconciled;
    changed = true;
  }
  const nextIndex = replaceRideMetadata(index, metadata);
  if (changed) {
    const written = writeIndexVerified(storage, nextIndex, rideId);
    return { ...written, tail: written.ok ? tail : null };
  }
  return {
    ...mutationResult(
      true,
      CYCLING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE,
      nextIndex,
      rideId,
    ),
    tail,
  };
}

function computeDistanceDeltas(sample, previous) {
  const next = { ...sample };
  delete next.distance_delta_m;
  delete next.coverage_delta_ms;
  if (previous && Number.isFinite(previous.distance_m)
      && Number.isFinite(next.distance_m)
      && next.distance_m >= previous.distance_m) {
    next.distance_delta_m = numberInRange(
      next.distance_m - previous.distance_m,
      0,
      10000,
      3,
    );
  }
  if (previous && Number.isFinite(previous.distance_coverage_ms)
      && Number.isFinite(next.distance_coverage_ms)
      && next.distance_coverage_ms >= previous.distance_coverage_ms) {
    next.coverage_delta_ms = integerInRange(
      next.distance_coverage_ms - previous.distance_coverage_ms,
      0,
      600000,
    );
  }
  return normalizeCyclingLocalFieldSample(next);
}

function markDropped(storage, index, rideId, count, storageStatus, status) {
  const metadata = index.rides.find((ride) => ride.ride_id === rideId);
  if (!metadata) return mutationResult(false, status, index, rideId, { dropped: count });
  const attempted = normalizeRideMetadata({
    ...metadata,
    dropped_count: Math.min(1000000, metadata.dropped_count + count),
    storage_status: storageStatus,
  });
  const written = attempted
    ? writeIndexVerified(storage, replaceRideMetadata(index, attempted), rideId)
    : mutationResult(false, status, index, rideId);
  return mutationResult(
    false,
    status,
    written.ok ? written.index : replaceRideMetadata(index, attempted || metadata),
    rideId,
    { dropped: count, droppedPersisted: written.ok },
  );
}

function projectedIndexAfterChunk(index, rideId, chunkIndex, chunk) {
  const metadata = index.rides.find((ride) => ride.ride_id === rideId);
  if (!metadata) return null;
  const nextMetadata = metadataFromTail(metadata, chunkIndex, chunk);
  return nextMetadata ? replaceRideMetadata(index, nextMetadata) : null;
}

function projectedStorageBytes(
  index,
  rideId,
  chunkIndex,
  nextSamples,
  nextChunkBytes,
) {
  const placeholder = { samples: nextSamples, bytes: nextChunkBytes };
  const projected = projectedIndexAfterChunk(
    index,
    rideId,
    chunkIndex,
    placeholder,
  );
  if (!projected) return Number.POSITIVE_INFINITY;
  return knownStorageBytes(projected);
}

/**
 * Append a small in-memory batch. Typical callers flush every 5-10 seconds;
 * only the 30-sample active tail and the small index are rewritten.
 */
export function appendCyclingLocalFieldSamples(storage, rideId, values) {
  if (!validRideId(rideId)) {
    return mutationResult(
      false,
      CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      emptyIndex(),
    );
  }
  const incoming = (Array.isArray(values) ? values : [values])
    .map((value) => normalizeCyclingLocalFieldSample(value))
    .filter(Boolean)
    .sort((left, right) => left.captured_at_ms - right.captured_at_ms);
  if (!incoming.length) {
    const current = readIndexResult(storage);
    return mutationResult(
      false,
      CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      current.index,
      rideId,
    );
  }
  let current = readIndexResult(storage);
  if (!current.ok) return mutationResult(false, current.status, current.index, rideId);
  let metadata = current.index.rides.find((ride) => ride.ride_id === rideId);
  if (!metadata) {
    return mutationResult(
      false,
      CYCLING_LOCAL_FIELD_LOG_STATUS.RIDE_NOT_FOUND,
      current.index,
      rideId,
    );
  }
  if (metadata.status !== 'active') {
    return mutationResult(
      false,
      CYCLING_LOCAL_FIELD_LOG_STATUS.RIDE_FINISHED,
      current.index,
      rideId,
    );
  }
  const reconciled = reconcileRideTail(storage, current.index, rideId);
  if (!reconciled.ok) return reconciled;
  current = { ok: true, index: reconciled.index };
  metadata = reconciled.ride;
  let tail = reconciled.tail;
  let previous = tail && tail.samples.length
    ? tail.samples[tail.samples.length - 1] : null;
  const accepted = [];
  for (let index = 0; index < incoming.length; index += 1) {
    const sample = incoming[index];
    if (sample.captured_at_ms < metadata.started_at_ms) continue;
    const last = accepted[accepted.length - 1] || previous;
    if (last && sample.captured_at_ms - last.captured_at_ms
        < CYCLING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS) continue;
    const withDeltas = computeDistanceDeltas(sample, last);
    if (withDeltas) accepted.push(withDeltas);
  }
  if (!accepted.length) {
    return mutationResult(
      true,
      CYCLING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE,
      current.index,
      rideId,
      { appended: 0 },
    );
  }
  const capacity = CYCLING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RIDE
    - metadata.sample_count;
  const toAppend = accepted.slice(0, Math.max(0, capacity));
  const overRideLimit = accepted.length - toAppend.length;
  if (!toAppend.length) {
    return markDropped(
      storage,
      current.index,
      rideId,
      accepted.length,
      'capacity',
      CYCLING_LOCAL_FIELD_LOG_STATUS.CAPACITY_EXCEEDED,
    );
  }

  let appended = 0;
  while (appended < toAppend.length) {
    metadata = current.index.rides.find((ride) => ride.ride_id === rideId);
    const tailIndex = metadata.chunk_count > 0 ? metadata.chunk_count - 1 : 0;
    const tailSamples = tail && metadata.chunk_count > 0
      ? tail.samples.slice() : [];
    const room = CYCLING_LOCAL_FIELD_LOG_CHUNK_SAMPLES - tailSamples.length;
    const chunkIndex = room > 0 ? tailIndex : metadata.chunk_count;
    const baseSamples = room > 0 ? tailSamples : [];
    const take = Math.min(
      CYCLING_LOCAL_FIELD_LOG_CHUNK_SAMPLES - baseSamples.length,
      toAppend.length - appended,
    );
    const nextSamples = [
      ...baseSamples,
      ...toAppend.slice(appended, appended + take),
    ];
    const encoded = buildChunk(rideId, chunkIndex, nextSamples);
    if (!encoded) {
      return markDropped(
        storage,
        current.index,
        rideId,
        toAppend.length - appended + overRideLimit,
        'write_failed',
        CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      );
    }
    const nextChunkBytes = cyclingLocalFieldLogUtf8Bytes(stableJson(encoded));
    if (nextChunkBytes > CYCLING_LOCAL_FIELD_LOG_MAX_CHUNK_BYTES) {
      return markDropped(
        storage,
        current.index,
        rideId,
        toAppend.length - appended + overRideLimit,
        'capacity',
        CYCLING_LOCAL_FIELD_LOG_STATUS.CHUNK_TOO_LARGE,
      );
    }

    let projected = projectedStorageBytes(
      current.index,
      rideId,
      chunkIndex,
      nextSamples,
      nextChunkBytes,
    );
    while (projected > CYCLING_LOCAL_FIELD_LOG_MAX_TOTAL_BYTES) {
      const eviction = evictOldestCompletedForCapacity(
        storage,
        current.index,
        rideId,
      );
      if (!eviction.ok) return eviction;
      if (!eviction.evicted) {
        return markDropped(
          storage,
          current.index,
          rideId,
          toAppend.length - appended + overRideLimit,
          'capacity',
          CYCLING_LOCAL_FIELD_LOG_STATUS.CAPACITY_EXCEEDED,
        );
      }
      current = { ok: true, index: eviction.index };
      const cleanup = runPendingCleanup(storage, current.index, rideId);
      if (cleanup.ok) current = { ok: true, index: cleanup.index };
      projected = projectedStorageBytes(
        current.index,
        rideId,
        chunkIndex,
        nextSamples,
        nextChunkBytes,
      );
      if (!cleanup.ok && projected > CYCLING_LOCAL_FIELD_LOG_MAX_TOTAL_BYTES) {
        return markDropped(
          storage,
          current.index,
          rideId,
          toAppend.length - appended + overRideLimit,
          'capacity',
          CYCLING_LOCAL_FIELD_LOG_STATUS.CAPACITY_EXCEEDED,
        );
      }
    }

    const write = writeChunkVerified(
      storage,
      rideId,
      chunkIndex,
      nextSamples,
    );
    if (!write.ok) {
      return markDropped(
        storage,
        current.index,
        rideId,
        toAppend.length - appended + overRideLimit,
        'write_failed',
        write.status,
      );
    }
    const nextIndex = projectedIndexAfterChunk(
      current.index,
      rideId,
      chunkIndex,
      write.chunk,
    );
    const indexWrite = nextIndex
      ? writeIndexVerified(storage, nextIndex, rideId)
      : mutationResult(
        false,
        CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE,
        current.index,
        rideId,
      );
    if (!indexWrite.ok) {
      return mutationResult(
        false,
        indexWrite.status,
        indexWrite.index,
        rideId,
        { appended, orphanChunkRecoverable: true },
      );
    }
    current = { ok: true, index: indexWrite.index };
    tail = write.chunk;
    appended += take;
  }
  if (overRideLimit > 0) {
    const dropped = markDropped(
      storage,
      current.index,
      rideId,
      overRideLimit,
      'capacity',
      CYCLING_LOCAL_FIELD_LOG_STATUS.CAPACITY_EXCEEDED,
    );
    return { ...dropped, appended };
  }
  return mutationResult(
    true,
    CYCLING_LOCAL_FIELD_LOG_STATUS.PERSISTED,
    current.index,
    rideId,
    { appended, storageBytes: knownStorageBytes(current.index) },
  );
}

function mutateMetadata(storage, rideId, mutate) {
  if (!validRideId(rideId) || typeof mutate !== 'function') {
    return mutationResult(
      false,
      CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      emptyIndex(),
    );
  }
  const current = readIndexResult(storage);
  if (!current.ok) return mutationResult(false, current.status, current.index, rideId);
  const metadata = current.index.rides.find((ride) => ride.ride_id === rideId);
  if (!metadata) {
    return mutationResult(
      false,
      CYCLING_LOCAL_FIELD_LOG_STATUS.RIDE_NOT_FOUND,
      current.index,
      rideId,
    );
  }
  let candidate = null;
  try { candidate = normalizeRideMetadata(mutate(metadata)); } catch (_error) {}
  if (!candidate) {
    return mutationResult(
      false,
      CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      current.index,
      rideId,
    );
  }
  if (stableJson(candidate) === stableJson(metadata)) {
    return mutationResult(
      true,
      CYCLING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE,
      current.index,
      rideId,
    );
  }
  return writeIndexVerified(
    storage,
    replaceRideMetadata(current.index, candidate),
    rideId,
  );
}

export function appendCyclingLocalLifecycleEvent(storage, rideId, value) {
  const event = normalizeCyclingLocalLifecycleEvent(value);
  if (!event) {
    return mutationResult(
      false,
      CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      readIndexResult(storage).index,
      rideId,
    );
  }
  return mutateMetadata(storage, rideId, (ride) => ({
    ...ride,
    lifecycle: [...ride.lifecycle, event],
  }));
}

export function appendCyclingLocalTtsEvent(storage, rideId, value) {
  const event = normalizeCyclingLocalTtsEvent(value);
  if (!event) {
    return mutationResult(
      false,
      CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      readIndexResult(storage).index,
      rideId,
    );
  }
  return mutateMetadata(storage, rideId, (ride) => ({
    ...ride,
    tts: [...ride.tts, event],
  }));
}

export function appendCyclingLocalUploadResult(storage, rideId, value) {
  const upload = normalizeCyclingLocalUploadResult(value);
  if (!upload) {
    return mutationResult(
      false,
      CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      readIndexResult(storage).index,
      rideId,
    );
  }
  return mutateMetadata(storage, rideId, (ride) => ({
    ...ride,
    uploads: [...ride.uploads, upload],
  }));
}

export function finishCyclingLocalFieldLog(storage, rideId, options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const endedAtMs = integerInRange(
    source.endedAtMs ?? source.ended_at_ms,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  if (endedAtMs === null) {
    return mutationResult(
      false,
      CYCLING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      readIndexResult(storage).index,
      rideId,
    );
  }
  const summary = normalizeCyclingLocalFieldSummary(source.summary);
  return mutateMetadata(storage, rideId, (ride) => ({
    ...ride,
    status: source.aborted === true ? 'aborted' : 'completed',
    ended_at_ms: endedAtMs,
    storage_status: ride.storage_status === 'partial'
      ? 'partial' : ride.storage_status,
    ...(summary ? { summary } : {}),
    lifecycle: [...ride.lifecycle, {
      at_ms: endedAtMs,
      elapsed_ms: summary && summary.elapsed_ms != null
        ? summary.elapsed_ms : Math.max(0, endedAtMs - ride.started_at_ms),
      event: source.aborted === true ? 'ride_aborted' : 'ride_finished',
      reason: source.aborted === true ? 'unload' : 'summary',
      sensor: 'runtime',
    }],
  }));
}

export function readCyclingLocalFieldLogIndexResult(storage) {
  return readIndexResult(storage);
}

function expandedRideFromMetadata(metadata, samples, partial = false) {
  return normalizeCyclingLocalFieldRide({
    ride_id: metadata.ride_id,
    started_at_ms: metadata.started_at_ms,
    status: metadata.status,
    ended_at_ms: metadata.ended_at_ms,
    samples,
    lifecycle: metadata.lifecycle,
    tts: metadata.tts,
    uploads: metadata.uploads,
    summary: metadata.summary,
    dropped_count: metadata.dropped_count,
    storage_status: partial ? 'partial' : metadata.storage_status,
  });
}

/** Assemble chunked storage only for diagnostics/export, never on each tick. */
export function readCyclingLocalFieldLogsResult(storage) {
  const indexResult = readIndexResult(storage);
  if (!indexResult.ok) {
    return {
      ok: false,
      status: indexResult.status,
      store: { schema_version: CYCLING_LOCAL_FIELD_LOG_SCHEMA_VERSION, rides: [] },
      index: indexResult.index,
    };
  }
  const rides = [];
  let partial = false;
  for (let ridePosition = 0;
    ridePosition < indexResult.index.rides.length; ridePosition += 1) {
    const metadata = indexResult.index.rides[ridePosition];
    const samples = [];
    let ridePartial = false;
    for (let chunkIndex = 0;
      chunkIndex < metadata.chunk_count; chunkIndex += 1) {
      const chunkResult = readChunkResult(
        storage,
        metadata.ride_id,
        chunkIndex,
      );
      if (!chunkResult.ok) {
        ridePartial = true;
        partial = true;
        break;
      }
      samples.push(...chunkResult.chunk.samples);
    }
    if (samples.length !== metadata.sample_count) {
      ridePartial = true;
      partial = true;
    }
    const ride = expandedRideFromMetadata(metadata, samples, ridePartial);
    if (ride) rides.push(ride);
  }
  return {
    ok: !partial,
    status: partial
      ? CYCLING_LOCAL_FIELD_LOG_STATUS.PARTIAL_STORAGE
      : CYCLING_LOCAL_FIELD_LOG_STATUS.PERSISTED,
    store: {
      schema_version: CYCLING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
      rides,
    },
    index: indexResult.index,
    storageBytes: knownStorageBytes(indexResult.index),
  };
}

export function readCyclingLocalFieldLogs(storage) {
  return readCyclingLocalFieldLogsResult(storage).store;
}

export function readCyclingLocalFieldLog(storage, rideId) {
  if (!validRideId(rideId)) return null;
  const indexResult = readIndexResult(storage);
  if (!indexResult.ok) return null;
  const metadata = indexResult.index.rides.find(
    (ride) => ride.ride_id === rideId,
  );
  if (!metadata) return null;
  const samples = [];
  let partial = false;
  for (let chunkIndex = 0;
    chunkIndex < metadata.chunk_count; chunkIndex += 1) {
    const chunkResult = readChunkResult(storage, rideId, chunkIndex);
    if (!chunkResult.ok) {
      partial = true;
      break;
    }
    samples.push(...chunkResult.chunk.samples);
  }
  if (samples.length !== metadata.sample_count) partial = true;
  return expandedRideFromMetadata(metadata, samples, partial);
}

export function readLatestCyclingLocalFieldLog(storage) {
  const indexResult = readIndexResult(storage);
  if (!indexResult.ok || !indexResult.index.rides.length) return null;
  return readCyclingLocalFieldLog(
    storage,
    indexResult.index.rides[0].ride_id,
  );
}

function average(values, digits = 2) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (!numbers.length) return null;
  const scale = 10 ** digits;
  return Math.round(
    numbers.reduce((sum, value) => sum + value, 0)
      / numbers.length * scale,
  ) / scale;
}

/** Pure, small latest-ride digest suitable for one status line or test UI. */
export function buildLatestCyclingLocalFieldLogDigest(value) {
  const store = normalizeCyclingLocalFieldStore(value);
  const ride = store.rides[0];
  if (!ride) return null;
  const samples = ride.samples;
  const first = samples[0] || null;
  const last = samples[samples.length - 1] || null;
  const countTrue = (key) => samples.reduce(
    (count, sample) => count + (sample[key] === true ? 1 : 0),
    0,
  );
  const sum = (key) => Math.round(samples.reduce(
    (total, sample) => total + (Number.isFinite(sample[key]) ? sample[key] : 0),
    0,
  ) * 1000) / 1000;
  const lastUpload = ride.uploads[ride.uploads.length - 1] || null;
  const lastTts = ride.tts[ride.tts.length - 1] || null;
  const digest = {
    schema_version: CYCLING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    ride_id: ride.ride_id,
    status: ride.status,
    started_at_ms: ride.started_at_ms,
    sample_count: samples.length,
    dropped_count: ride.dropped_count,
    storage_status: ride.storage_status,
    lifecycle_count: ride.lifecycle.length,
    tts_count: ride.tts.length,
    upload_result_count: ride.uploads.length,
    distance_ledger_eligible_samples: countTrue('distance_ledger_eligible'),
    simple_gyro_ledger_fresh_samples: countTrue('simple_gyro_ledger_fresh'),
    estimate_usable_samples: countTrue('estimate_usable'),
    estimate_stabilized_samples: countTrue('estimate_stabilized'),
    walking_like_samples: countTrue('walking_like'),
    distance_delta_m: sum('distance_delta_m'),
    coverage_delta_ms: Math.round(sum('coverage_delta_ms')),
    avg_accelerometer_hz: average(samples.map((sample) => sample.accelerometer_hz)),
    avg_gyroscope_hz: average(samples.map((sample) => sample.gyroscope_hz)),
    avg_orientation_hz: average(samples.map((sample) => sample.orientation_hz)),
    max_imu_restart_count: samples.reduce(
      (maximum, sample) => Math.max(maximum, sample.imu_restart_count || 0),
      0,
    ),
    max_gyroscope_restart_count: samples.reduce(
      (maximum, sample) => Math.max(maximum, sample.gyroscope_restart_count || 0),
      0,
    ),
    ...(ride.ended_at_ms != null ? { ended_at_ms: ride.ended_at_ms } : {}),
    ...(first ? {
      first_sample_at_ms: first.captured_at_ms,
      first_distance_m: Number.isFinite(first.distance_m) ? first.distance_m : null,
    } : {}),
    ...(last ? {
      last_sample_at_ms: last.captured_at_ms,
      last_elapsed_ms: last.elapsed_ms,
      last_distance_m: Number.isFinite(last.distance_m) ? last.distance_m : null,
      last_distance_coverage_ms: Number.isFinite(last.distance_coverage_ms)
        ? last.distance_coverage_ms : null,
      last_speed_kmh: Number.isFinite(last.speed_kmh) ? last.speed_kmh : null,
      last_cadence_rpm: Number.isFinite(last.cadence_rpm)
        ? last.cadence_rpm : null,
      last_simple_gyro_method: last.simple_gyro_method || 'none',
      last_simple_gyro_analysis: last.simple_gyro_analysis || 'none',
      last_raw_artifact: last.raw_artifact || 'none',
    } : {}),
    ...(lastUpload ? { last_upload: lastUpload } : {}),
    ...(lastTts ? {
      last_tts: {
        at_ms: lastTts.at_ms,
        status: lastTts.status,
        ...(lastTts.cue ? { cue: lastTts.cue } : {}),
        ...(lastTts.result ? { result: lastTts.result } : {}),
      },
    } : {}),
  };
  digest.checksum = cyclingLocalFieldLogChecksum(stableJson(digest));
  return digest;
}

function replayLine(kind, value) {
  return 'AIBIKE_LOCAL_LOG|' + kind + '|' + stableJson(value);
}

/**
 * Pure ADB/logcat replay protocol. Concatenate parsed CHUNK.data in part order,
 * then verify BEGIN/END checksum. No line exceeds 3 KB.
 */
export function buildCyclingLocalFieldLogReplayLines(value) {
  const ride = normalizeCyclingLocalFieldRide(value);
  if (!ride) return [];
  const payload = stableJson({
    schema_version: CYCLING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    ride,
  });
  if (!payload) return [];
  const fragments = [];
  const maxFragmentCharacters = 1100;
  for (let offset = 0; offset < payload.length;
    offset += maxFragmentCharacters) {
    fragments.push(payload.slice(offset, offset + maxFragmentCharacters));
  }
  const checksum = cyclingLocalFieldLogChecksum(payload);
  const common = {
    ride_id: ride.ride_id,
    parts: fragments.length,
    bytes: cyclingLocalFieldLogUtf8Bytes(payload),
    checksum,
  };
  const lines = [replayLine('BEGIN', common)];
  for (let index = 0; index < fragments.length; index += 1) {
    lines.push(replayLine('CHUNK', {
      ride_id: ride.ride_id,
      part: index + 1,
      parts: fragments.length,
      data: fragments[index],
    }));
  }
  lines.push(replayLine('END', common));
  return lines.every((line) => (
    cyclingLocalFieldLogUtf8Bytes(line)
      < CYCLING_LOCAL_FIELD_LOG_REPLAY_MAX_LINE_BYTES
  )) ? lines : [];
}
