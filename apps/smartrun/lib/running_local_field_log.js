// SmartRun privacy-bounded local field archive.
//
// Storage layout (every write is synchronously read back):
//   smartrun_local_field_log_index_v1
//   smartrun_local_field_log_chunk_v1:<run-id>:<000..143>
//
// This archive is independent from calibration/run upload queues. Server ACKs
// never delete it. Only derived metrics are accepted; coordinates, raw sensor
// axes, device/account identifiers, credentials and spoken text have no output
// path.

export const RUNNING_LOCAL_FIELD_LOG_KEY =
  'smartrun_local_field_log_index_v1';
export const RUNNING_LOCAL_FIELD_LOG_CHUNK_PREFIX =
  'smartrun_local_field_log_chunk_v1:';
export const RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION = 1;
export const RUNNING_LOCAL_FIELD_LOG_MAX_RUNS = 2;
export const RUNNING_LOCAL_FIELD_LOG_CHUNK_SAMPLES = 60;
export const RUNNING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RUN = 8640;
export const RUNNING_LOCAL_FIELD_LOG_MAX_CHUNKS_PER_RUN =
  RUNNING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RUN
    / RUNNING_LOCAL_FIELD_LOG_CHUNK_SAMPLES;
export const RUNNING_LOCAL_FIELD_LOG_MAX_CHUNK_BYTES = 64 * 1024;
export const RUNNING_LOCAL_FIELD_LOG_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const RUNNING_LOCAL_FIELD_LOG_MAX_EVENTS = 256;
export const RUNNING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS = 5000;
export const RUNNING_LOCAL_FIELD_LOG_REPLAY_MAX_LINE_BYTES = 3000;

export const RUNNING_LOCAL_FIELD_LOG_STATUS = Object.freeze({
  PERSISTED: 'persisted',
  NO_CHANGE: 'no_change',
  INVALID_INPUT: 'invalid_input',
  RUN_NOT_FOUND: 'run_not_found',
  RUN_FINISHED: 'run_finished',
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
const MAX_RUN_ELAPSED_MS = 48 * 60 * 60 * 1000;
const RUN_ID_RE = /^run-[a-z0-9]{8,16}-[a-z0-9]{6,20}$/;
const SAFE_TOKEN_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const EVENT_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

const RUN_STATUSES = Object.freeze(['active', 'completed', 'aborted']);
const STORAGE_STATES = Object.freeze(['ok', 'capacity', 'write_failed', 'partial']);
const DISTANCE_SOURCES = Object.freeze([
  'rsc_distance', 'rsc_speed', 'imu', 'none',
]);
const CADENCE_SOURCES = Object.freeze(['rsc', 'imu', 'none']);
const BLE_STATES = Object.freeze([
  'idle', 'scanning', 'connecting', 'connected', 'reconnecting',
]);
const SAMPLE_TRIGGERS = Object.freeze([
  'ticker', 'finish', 'hide', 'show', 'hrs', 'rsc', 'imu', 'unknown',
]);
const EVENT_KINDS = Object.freeze([
  'lifecycle', 'ble', 'imu', 'source', 'storage', 'audio', 'upload',
]);

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerInRange(value, min, max) {
  const number = finite(value);
  if (number === null) return null;
  const rounded = Math.round(number);
  return Number.isSafeInteger(rounded) && rounded >= min && rounded <= max
    ? rounded : null;
}

function numberInRange(value, min, max, digits = 3) {
  const number = finite(value);
  if (number === null || number < min || number > max) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

function enumValue(value, choices) {
  return typeof value === 'string' && choices.includes(value) ? value : null;
}

function validRunId(value) {
  return typeof value === 'string' && RUN_ID_RE.test(value);
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

function addBoolean(target, source, key) {
  if (typeof source[key] === 'boolean') target[key] = source[key];
}

function addEnum(target, source, key, choices) {
  const value = enumValue(source[key], choices);
  if (value !== null) target[key] = value;
}

export function runningLocalFieldLogUtf8Bytes(value) {
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

export function runningLocalFieldLogChecksum(value) {
  const text = String(value == null ? '' : value);
  let hash = 0x811c9dc5;
  forEachUtf8Byte(text, (byte) => {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  });
  return hash.toString(16).padStart(8, '0');
}

export function createRunningLocalFieldLogId(
  startedAtMs = Date.now(),
  nonce = '',
) {
  const started = integerInRange(startedAtMs, MIN_EPOCH_MS, MAX_EPOCH_MS);
  if (started === null) return '';
  let suffix = String(nonce || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    .slice(0, 20);
  if (suffix.length < 6) {
    suffix = (
      Math.floor(Math.random() * 0xffffffff).toString(36)
      + started.toString(36)
    ).slice(0, 12).padEnd(6, '0');
  }
  const id = 'run-' + started.toString(36) + '-' + suffix;
  return validRunId(id) ? id : '';
}

/** Strict whitelist; unknown/raw/location/identity fields are discarded. */
export function normalizeRunningLocalFieldSample(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const capturedAtMs = integerInRange(
    value.captured_at_ms,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  const elapsedMs = integerInRange(
    value.elapsed_ms,
    0,
    MAX_RUN_ELAPSED_MS,
  );
  if (capturedAtMs === null || elapsedMs === null) return null;
  const sample = { captured_at_ms: capturedAtMs, elapsed_ms: elapsedMs };
  const numbers = [
    ['cadence_spm', 0, 300, 2],
    ['candidate_cadence_spm', 0, 400, 2],
    ['speed_mps', 0, 20, 4],
    ['pace_sec_per_km', 60, 3600, 2],
    ['distance_m', 0, 500000, 3],
    ['motion_quality', 0, 1, 4],
    ['artifact_confidence', 0, 1, 4],
    ['gyro_rms', 0, 100, 4],
  ];
  for (let index = 0; index < numbers.length; index += 1) {
    addNumber(sample, value, ...numbers[index]);
  }
  const integers = [
    ['bpm', 20, 240],
    ['steps_total', 0, 2000000],
    ['accel_age_ms', 0, 600000],
    ['sensor_generation', 0, 1000000],
  ];
  for (let index = 0; index < integers.length; index += 1) {
    addInteger(sample, value, ...integers[index]);
  }
  for (const key of [
    'stationary', 'rsc_live', 'hr_live', 'page_visible', 'paused',
  ]) addBoolean(sample, value, key);
  addEnum(sample, value, 'distance_source', DISTANCE_SOURCES);
  addEnum(sample, value, 'cadence_source', CADENCE_SOURCES);
  addEnum(sample, value, 'ble_state', BLE_STATES);
  addEnum(sample, value, 'trigger', SAMPLE_TRIGGERS);
  return sample;
}

export function normalizeRunningLocalFieldEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const atMs = integerInRange(value.at_ms, MIN_EPOCH_MS, MAX_EPOCH_MS);
  const kind = enumValue(value.kind, EVENT_KINDS);
  const name = typeof value.name === 'string' && EVENT_NAME_RE.test(value.name)
    ? value.name : '';
  if (atMs === null || !kind || !name) return null;
  const event = { at_ms: atMs, kind, name };
  addInteger(event, value, 'elapsed_ms', 0, MAX_RUN_ELAPSED_MS);
  addInteger(event, value, 'generation', 0, 1000000);
  if (typeof value.reason === 'string' && SAFE_TOKEN_RE.test(value.reason)) {
    event.reason = value.reason;
  }
  return event;
}

export function normalizeRunningLocalFieldSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const summary = {};
  const integers = [
    ['elapsed_ms', 0, MAX_RUN_ELAPSED_MS],
    ['avg_bpm', 20, 240],
    ['max_bpm', 20, 240],
    ['steps', 0, 2000000],
    ['sample_count', 0, RUNNING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RUN],
  ];
  for (let index = 0; index < integers.length; index += 1) {
    addInteger(summary, value, ...integers[index]);
  }
  const numbers = [
    ['distance_m', 0, 500000, 3],
    ['avg_pace_sec_per_km', 60, 3600, 2],
    ['avg_cadence_spm', 0, 300, 2],
  ];
  for (let index = 0; index < numbers.length; index += 1) {
    addNumber(summary, value, ...numbers[index]);
  }
  return Object.keys(summary).length ? summary : null;
}

function normalizeEventList(values, startedAtMs) {
  if (!Array.isArray(values)) return [];
  const result = [];
  for (let index = 0; index < values.length; index += 1) {
    const event = normalizeRunningLocalFieldEvent(values[index]);
    if (!event || event.at_ms < startedAtMs) continue;
    if (!result.some((item) => stableJson(item) === stableJson(event))) {
      result.push(event);
    }
  }
  result.sort((left, right) => left.at_ms - right.at_ms);
  if (result.length <= RUNNING_LOCAL_FIELD_LOG_MAX_EVENTS) return result;

  // 长距离中 RSC 无数据时可能持续产生 retry/unavailable 循环。纯尾部 ring
  // 会在几十分钟后把 RUN_STARTED、首个 BLE/RSC/IMU/source 里程碑静默淘汰，
  // 使 12 小时样本仍在却无法还原“最初如何接入”。固定保留每种事件的首条，
  // 其余容量留给最近时间线；既不扩大 owner index，也保留故障尾部现场。
  const firstByType = new Map();
  for (let index = 0; index < result.length; index += 1) {
    const event = result[index];
    const key = event.kind + ':' + event.name;
    if (!firstByType.has(key)) firstByType.set(key, event);
  }
  const retained = [...firstByType.values()]
    .slice(0, RUNNING_LOCAL_FIELD_LOG_MAX_EVENTS);
  const selected = new Set(retained);
  for (let index = result.length - 1;
    index >= 0 && retained.length < RUNNING_LOCAL_FIELD_LOG_MAX_EVENTS;
    index -= 1) {
    if (selected.has(result[index])) continue;
    selected.add(result[index]);
    retained.push(result[index]);
  }
  retained.sort((left, right) => left.at_ms - right.at_ms);
  return retained;
}

function normalizeSamples(values, startedAtMs, endedAtMs = null) {
  if (!Array.isArray(values)) return [];
  const candidates = [];
  for (let index = 0; index < values.length; index += 1) {
    const sample = normalizeRunningLocalFieldSample(values[index]);
    if (!sample || sample.captured_at_ms < startedAtMs
        || (endedAtMs !== null && sample.captured_at_ms > endedAtMs)) continue;
    candidates.push(sample);
  }
  candidates.sort((left, right) => left.captured_at_ms - right.captured_at_ms);
  const result = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const previous = result[result.length - 1];
    if (previous && candidates[index].captured_at_ms - previous.captured_at_ms
        < RUNNING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS) continue;
    result.push(candidates[index]);
  }
  return result.slice(0, RUNNING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RUN);
}

export function normalizeRunningLocalFieldRun(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const runId = typeof value.run_id === 'string' ? value.run_id : value.runId;
  const startedAtMs = integerInRange(
    value.started_at_ms ?? value.startedAtMs,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  const status = value.status == null
    ? 'active' : enumValue(value.status, RUN_STATUSES);
  if (!validRunId(runId) || startedAtMs === null || !status) return null;
  let endedAtMs = integerInRange(
    value.ended_at_ms ?? value.endedAtMs,
    startedAtMs,
    MAX_EPOCH_MS,
  );
  if (status === 'active') endedAtMs = null;
  if (status !== 'active' && endedAtMs === null) return null;
  const run = {
    run_id: runId,
    started_at_ms: startedAtMs,
    status,
    samples: normalizeSamples(value.samples, startedAtMs, endedAtMs),
    events: normalizeEventList(value.events, startedAtMs),
    dropped_count: integerInRange(value.dropped_count, 0, 1000000) || 0,
    storage_status: enumValue(value.storage_status, STORAGE_STATES) || 'ok',
  };
  if (endedAtMs !== null) run.ended_at_ms = endedAtMs;
  const summary = normalizeRunningLocalFieldSummary(value.summary);
  if (summary) run.summary = summary;
  return run;
}

function retainRecentWithoutDeletingActive(runs) {
  const sorted = runs.slice().sort(
    (left, right) => right.started_at_ms - left.started_at_ms,
  );
  const active = sorted.filter((run) => run.status === 'active');
  const finished = sorted.filter((run) => run.status !== 'active');
  const finishedSlots = Math.max(
    0,
    RUNNING_LOCAL_FIELD_LOG_MAX_RUNS - active.length,
  );
  return [...active, ...finished.slice(0, finishedSlots)].sort(
    (left, right) => right.started_at_ms - left.started_at_ms,
  );
}

export function normalizeRunningLocalFieldStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Number(value.schema_version) !== RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION
      || !Array.isArray(value.runs)) {
    return { schema_version: RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION, runs: [] };
  }
  const runs = [];
  const ids = new Set();
  for (let index = 0; index < value.runs.length; index += 1) {
    const run = normalizeRunningLocalFieldRun(value.runs[index]);
    if (!run || ids.has(run.run_id)) continue;
    ids.add(run.run_id);
    runs.push(run);
  }
  return {
    schema_version: RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    runs: retainRecentWithoutDeletingActive(runs),
  };
}

// Tuple position 0 is captured_at_ms - chunk base. Enum strings use numeric
// codes and booleans use 0/1; trailing nulls are removed.
const SAMPLE_TUPLE_FIELDS = Object.freeze([
  ['elapsed_ms'], ['bpm'], ['cadence_spm'], ['candidate_cadence_spm'],
  ['speed_mps'], ['pace_sec_per_km'], ['distance_m'], ['steps_total'],
  ['motion_quality'], ['artifact_confidence'], ['gyro_rms'],
  ['stationary', null, 'boolean'],
  ['distance_source', DISTANCE_SOURCES],
  ['cadence_source', CADENCE_SOURCES],
  ['rsc_live', null, 'boolean'], ['hr_live', null, 'boolean'],
  ['ble_state', BLE_STATES],
  ['page_visible', null, 'boolean'], ['paused', null, 'boolean'],
  ['accel_age_ms'], ['sensor_generation'], ['trigger', SAMPLE_TRIGGERS],
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
  const offset = integerInRange(tuple[0], 0, MAX_RUN_ELAPSED_MS);
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
  return normalizeRunningLocalFieldSample(value);
}

export function runningLocalFieldLogChunkKey(runId, chunkIndex) {
  const index = integerInRange(
    chunkIndex,
    0,
    RUNNING_LOCAL_FIELD_LOG_MAX_CHUNKS_PER_RUN - 1,
  );
  if (!validRunId(runId) || index === null) return '';
  return RUNNING_LOCAL_FIELD_LOG_CHUNK_PREFIX
    + runId + ':' + String(index).padStart(3, '0');
}

function buildChunk(runId, chunkIndex, values) {
  const samples = Array.isArray(values)
    ? values.map(normalizeRunningLocalFieldSample).filter(Boolean) : [];
  if (!validRunId(runId) || !samples.length
      || samples.length > RUNNING_LOCAL_FIELD_LOG_CHUNK_SAMPLES) return null;
  const baseMs = samples[0].captured_at_ms;
  const core = {
    v: RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    r: runId,
    i: chunkIndex,
    b: baseMs,
    s: samples.map((sample) => encodeSampleTuple(sample, baseMs)),
  };
  return { ...core, h: runningLocalFieldLogChecksum(stableJson(core)) };
}

function decodeChunk(value, runId, chunkIndex) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Number(value.v) !== RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION
      || value.r !== runId || Number(value.i) !== chunkIndex
      || !Array.isArray(value.s) || value.s.length < 1
      || value.s.length > RUNNING_LOCAL_FIELD_LOG_CHUNK_SAMPLES) return null;
  const baseMs = integerInRange(value.b, MIN_EPOCH_MS, MAX_EPOCH_MS);
  if (baseMs === null) return null;
  const core = { v: value.v, r: value.r, i: value.i, b: value.b, s: value.s };
  if (value.h !== runningLocalFieldLogChecksum(stableJson(core))) return null;
  const samples = value.s.map((tuple) => decodeSampleTuple(tuple, baseMs));
  if (samples.some((sample) => !sample)) return null;
  const normalized = normalizeSamples(samples, MIN_EPOCH_MS);
  if (normalized.length !== samples.length) return null;
  return {
    raw: value,
    samples,
    bytes: runningLocalFieldLogUtf8Bytes(stableJson(value)),
  };
}

function normalizeRunMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const runId = typeof value.run_id === 'string' ? value.run_id : '';
  const startedAtMs = integerInRange(
    value.started_at_ms,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  const status = enumValue(value.status, RUN_STATUSES);
  const sampleCount = integerInRange(
    value.sample_count,
    0,
    RUNNING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RUN,
  );
  const chunkCount = integerInRange(
    value.chunk_count,
    0,
    RUNNING_LOCAL_FIELD_LOG_MAX_CHUNKS_PER_RUN,
  );
  if (!validRunId(runId) || startedAtMs === null || !status
      || sampleCount === null || chunkCount === null
      || !Array.isArray(value.chunk_bytes)
      || value.chunk_bytes.length !== chunkCount
      || (sampleCount === 0) !== (chunkCount === 0)) return null;
  if (chunkCount > 0 && (sampleCount <= (chunkCount - 1)
      * RUNNING_LOCAL_FIELD_LOG_CHUNK_SAMPLES
      || sampleCount > chunkCount * RUNNING_LOCAL_FIELD_LOG_CHUNK_SAMPLES)) {
    return null;
  }
  const chunkBytes = [];
  for (let index = 0; index < value.chunk_bytes.length; index += 1) {
    const bytes = integerInRange(
      value.chunk_bytes[index],
      1,
      RUNNING_LOCAL_FIELD_LOG_MAX_CHUNK_BYTES,
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
    run_id: runId,
    started_at_ms: startedAtMs,
    status,
    sample_count: sampleCount,
    chunk_count: chunkCount,
    chunk_bytes: chunkBytes,
    dropped_count: integerInRange(value.dropped_count, 0, 1000000) || 0,
    storage_status: enumValue(value.storage_status, STORAGE_STATES) || 'ok',
    events: normalizeEventList(value.events, startedAtMs),
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
    MAX_RUN_ELAPSED_MS,
  );
  if (sampleCount > 0 && (lastSampleAtMs === null || lastElapsedMs === null)) {
    return null;
  }
  if (sampleCount > 0) {
    metadata.last_sample_at_ms = lastSampleAtMs;
    metadata.last_elapsed_ms = lastElapsedMs;
  }
  const lastDistanceM = numberInRange(value.last_distance_m, 0, 500000, 3);
  const lastSteps = integerInRange(value.last_steps_total, 0, 2000000);
  if (lastDistanceM !== null) metadata.last_distance_m = lastDistanceM;
  if (lastSteps !== null) metadata.last_steps_total = lastSteps;
  const summary = normalizeRunningLocalFieldSummary(value.summary);
  if (summary) metadata.summary = summary;
  return metadata;
}

function cleanupEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !validRunId(value.run_id)) return null;
  const chunkCount = integerInRange(
    value.chunk_count,
    0,
    RUNNING_LOCAL_FIELD_LOG_MAX_CHUNKS_PER_RUN,
  );
  if (chunkCount === null || !Array.isArray(value.chunk_bytes)
      || value.chunk_bytes.length !== chunkCount) return null;
  const chunkBytes = [];
  for (let index = 0; index < value.chunk_bytes.length; index += 1) {
    const bytes = integerInRange(
      value.chunk_bytes[index],
      1,
      RUNNING_LOCAL_FIELD_LOG_MAX_CHUNK_BYTES,
    );
    if (bytes === null) return null;
    chunkBytes.push(bytes);
  }
  return {
    run_id: value.run_id,
    chunk_count: chunkCount,
    chunk_bytes: chunkBytes,
  };
}

function emptyIndex() {
  return {
    schema_version: RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    runs: [],
    pending_cleanup: [],
  };
}

function normalizeIndexStrict(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Number(value.schema_version) !== RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION
      || !Array.isArray(value.runs)
      || !Array.isArray(value.pending_cleanup)) return null;
  const runs = [];
  const ids = new Set();
  for (let index = 0; index < value.runs.length; index += 1) {
    const run = normalizeRunMetadata(value.runs[index]);
    if (!run || ids.has(run.run_id)) return null;
    ids.add(run.run_id);
    runs.push(run);
  }
  const pendingCleanup = [];
  for (let index = 0; index < value.pending_cleanup.length; index += 1) {
    const entry = cleanupEntry(value.pending_cleanup[index]);
    if (!entry || ids.has(entry.run_id)
        || pendingCleanup.some((item) => item.run_id === entry.run_id)) {
      return null;
    }
    pendingCleanup.push(entry);
  }
  runs.sort((left, right) => right.started_at_ms - left.started_at_ms);
  return {
    schema_version: RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    runs,
    pending_cleanup: pendingCleanup,
  };
}

function readIndexResult(storage) {
  if (!storage || typeof storage.getStorageSync !== 'function') {
    return {
      ok: false,
      status: RUNNING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE,
      index: emptyIndex(),
    };
  }
  try {
    const raw = storage.getStorageSync(RUNNING_LOCAL_FIELD_LOG_KEY);
    if (raw === undefined || raw === null || raw === '') {
      return {
        ok: true,
        status: RUNNING_LOCAL_FIELD_LOG_STATUS.PERSISTED,
        index: emptyIndex(),
      };
    }
    const index = normalizeIndexStrict(raw);
    if (!index) {
      return {
        ok: false,
        status: RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE,
        index: emptyIndex(),
      };
    }
    return {
      ok: true,
      status: RUNNING_LOCAL_FIELD_LOG_STATUS.PERSISTED,
      index,
    };
  } catch (_error) {
    return {
      ok: false,
      status: RUNNING_LOCAL_FIELD_LOG_STATUS.READ_FAILED,
      index: emptyIndex(),
    };
  }
}

function mutationResult(ok, status, index, runId = '', extra = {}) {
  return {
    ok,
    status,
    index,
    store: index,
    run: validRunId(runId)
      ? index.runs.find((item) => item.run_id === runId) || null
      : null,
    ...extra,
  };
}

function writeIndexVerified(storage, value, runId = '') {
  if (!storage || typeof storage.getStorageSync !== 'function'
      || typeof storage.setStorageSync !== 'function') {
    return mutationResult(
      false,
      RUNNING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE,
      normalizeIndexStrict(value) || emptyIndex(),
      runId,
    );
  }
  const normalized = normalizeIndexStrict(value);
  if (!normalized) {
    return mutationResult(
      false,
      RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      emptyIndex(),
      runId,
    );
  }
  try { storage.setStorageSync(RUNNING_LOCAL_FIELD_LOG_KEY, normalized); } catch (_error) {
    return mutationResult(
      false,
      RUNNING_LOCAL_FIELD_LOG_STATUS.WRITE_FAILED,
      normalized,
      runId,
    );
  }
  const roundTrip = readIndexResult(storage);
  if (!roundTrip.ok
      || stableJson(roundTrip.index) !== stableJson(normalized)) {
    return mutationResult(
      false,
      RUNNING_LOCAL_FIELD_LOG_STATUS.VERIFICATION_FAILED,
      roundTrip.index,
      runId,
    );
  }
  return mutationResult(
    true,
    RUNNING_LOCAL_FIELD_LOG_STATUS.PERSISTED,
    roundTrip.index,
    runId,
  );
}

function readChunkResult(storage, runId, chunkIndex, optional = false) {
  const key = runningLocalFieldLogChunkKey(runId, chunkIndex);
  if (!key || !storage || typeof storage.getStorageSync !== 'function') {
    return {
      ok: false,
      status: RUNNING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE,
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
          status: RUNNING_LOCAL_FIELD_LOG_STATUS.PARTIAL_STORAGE,
          exists: false,
          chunk: null,
        };
    }
    const chunk = decodeChunk(raw, runId, chunkIndex);
    if (!chunk) {
      return {
        ok: false,
        status: RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE,
        exists: true,
        chunk: null,
      };
    }
    return { ok: true, status: 'ok', exists: true, chunk };
  } catch (_error) {
    return {
      ok: false,
      status: RUNNING_LOCAL_FIELD_LOG_STATUS.READ_FAILED,
      exists: false,
      chunk: null,
    };
  }
}

function writeChunkVerified(storage, runId, chunkIndex, samples) {
  const key = runningLocalFieldLogChunkKey(runId, chunkIndex);
  const value = buildChunk(runId, chunkIndex, samples);
  if (!key || !value) {
    return { ok: false, status: RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT };
  }
  const bytes = runningLocalFieldLogUtf8Bytes(stableJson(value));
  if (bytes > RUNNING_LOCAL_FIELD_LOG_MAX_CHUNK_BYTES) {
    return { ok: false, status: RUNNING_LOCAL_FIELD_LOG_STATUS.CHUNK_TOO_LARGE };
  }
  if (!storage || typeof storage.getStorageSync !== 'function'
      || typeof storage.setStorageSync !== 'function') {
    return { ok: false, status: RUNNING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE };
  }
  try { storage.setStorageSync(key, value); } catch (_error) {
    return { ok: false, status: RUNNING_LOCAL_FIELD_LOG_STATUS.WRITE_FAILED };
  }
  const roundTrip = readChunkResult(storage, runId, chunkIndex);
  if (!roundTrip.ok || stableJson(roundTrip.chunk.raw) !== stableJson(value)) {
    return { ok: false, status: RUNNING_LOCAL_FIELD_LOG_STATUS.VERIFICATION_FAILED };
  }
  return {
    ok: true,
    status: RUNNING_LOCAL_FIELD_LOG_STATUS.PERSISTED,
    bytes,
    chunk: roundTrip.chunk,
  };
}

function removeChunkVerified(storage, runId, chunkIndex) {
  const key = runningLocalFieldLogChunkKey(runId, chunkIndex);
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
  let bytes = runningLocalFieldLogUtf8Bytes(stableJson(index));
  for (const run of index.runs) {
    bytes += run.chunk_bytes.reduce((sum, value) => sum + value, 0);
  }
  for (const entry of index.pending_cleanup) {
    bytes += entry.chunk_bytes.reduce((sum, value) => sum + value, 0);
  }
  return bytes;
}

function runPendingCleanup(storage, index, runId = '') {
  if (!index.pending_cleanup.length) {
    return mutationResult(
      true,
      RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE,
      index,
      runId,
    );
  }
  const remaining = [];
  for (const entry of index.pending_cleanup) {
    let removed = true;
    for (let chunkIndex = 0; chunkIndex < entry.chunk_count; chunkIndex += 1) {
      if (!removeChunkVerified(storage, entry.run_id, chunkIndex)) removed = false;
    }
    if (!removed) remaining.push(entry);
  }
  if (remaining.length === index.pending_cleanup.length) {
    return mutationResult(
      false,
      RUNNING_LOCAL_FIELD_LOG_STATUS.WRITE_FAILED,
      index,
      runId,
      { cleanupPending: remaining.length },
    );
  }
  const written = writeIndexVerified(storage, {
    ...index,
    pending_cleanup: remaining,
  }, runId);
  return {
    ...written,
    cleanupPending: written.ok
      ? written.index.pending_cleanup.length : index.pending_cleanup.length,
  };
}

function evictOldestFinished(storage, index, protectedRunId) {
  const candidates = index.runs
    .filter((run) => run.status !== 'active' && run.run_id !== protectedRunId)
    .sort((left, right) => left.started_at_ms - right.started_at_ms);
  if (!candidates.length) {
    return {
      ...mutationResult(
        true,
        RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE,
        index,
        protectedRunId,
      ),
      evicted: false,
    };
  }
  const victim = candidates[0];
  const written = writeIndexVerified(storage, {
    schema_version: RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    runs: index.runs.filter((run) => run.run_id !== victim.run_id),
    pending_cleanup: [
      ...index.pending_cleanup,
      {
        run_id: victim.run_id,
        chunk_count: victim.chunk_count,
        chunk_bytes: victim.chunk_bytes.slice(),
      },
    ],
  }, protectedRunId);
  return {
    ...written,
    evicted: written.ok,
    evictedRunId: victim.run_id,
  };
}

function stageFinishedEvictions(storage, index, runId = '') {
  const retained = retainRecentWithoutDeletingActive(index.runs);
  const retainedIds = new Set(retained.map((run) => run.run_id));
  const evicted = index.runs.filter((run) => !retainedIds.has(run.run_id));
  if (!evicted.length) {
    return mutationResult(
      true,
      RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE,
      index,
      runId,
    );
  }
  return writeIndexVerified(storage, {
    schema_version: RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    runs: retained,
    pending_cleanup: [
      ...index.pending_cleanup,
      ...evicted.filter((run) => run.status !== 'active').map((run) => ({
        run_id: run.run_id,
        chunk_count: run.chunk_count,
        chunk_bytes: run.chunk_bytes.slice(),
      })),
    ],
  }, runId);
}

function emptyRunMetadata(runId, startedAtMs) {
  return {
    run_id: runId,
    started_at_ms: startedAtMs,
    status: 'active',
    sample_count: 0,
    chunk_count: 0,
    chunk_bytes: [],
    dropped_count: 0,
    storage_status: 'ok',
    events: [{
      at_ms: startedAtMs,
      elapsed_ms: 0,
      kind: 'lifecycle',
      name: 'RUN_STARTED',
      reason: 'user',
      generation: 0,
    }],
  };
}

export function beginRunningLocalFieldLog(storage, options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const runId = source.runId ?? source.run_id;
  const startedAtMs = integerInRange(
    source.startedAtMs ?? source.started_at_ms,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  if (!validRunId(runId) || startedAtMs === null) {
    return mutationResult(
      false,
      RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      emptyIndex(),
    );
  }
  const current = readIndexResult(storage);
  if (!current.ok) {
    return mutationResult(false, current.status, current.index, runId);
  }
  const existing = current.index.runs.find((run) => run.run_id === runId);
  if (existing) {
    const same = existing.started_at_ms === startedAtMs;
    return mutationResult(
      same,
      same ? RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE
        : RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      current.index,
      runId,
    );
  }
  if (current.index.runs.filter((run) => run.status === 'active').length
      >= RUNNING_LOCAL_FIELD_LOG_MAX_RUNS) {
    return mutationResult(
      false,
      RUNNING_LOCAL_FIELD_LOG_STATUS.CAPACITY_EXCEEDED,
      current.index,
      runId,
    );
  }
  let written = writeIndexVerified(storage, {
    ...current.index,
    runs: [emptyRunMetadata(runId, startedAtMs), ...current.index.runs],
  }, runId);
  if (!written.ok) return written;
  written = stageFinishedEvictions(storage, written.index, runId);
  if (!written.ok) return written;
  const cleaned = runPendingCleanup(storage, written.index, runId);
  if (cleaned.ok) {
    return mutationResult(
      true,
      RUNNING_LOCAL_FIELD_LOG_STATUS.PERSISTED,
      cleaned.index,
      runId,
      { cleanupPending: cleaned.index.pending_cleanup.length },
    );
  }
  // Active metadata is already durable; deferred cleanup must not stop a run.
  return mutationResult(
    true,
    RUNNING_LOCAL_FIELD_LOG_STATUS.PERSISTED,
    written.index,
    runId,
    { cleanupPending: written.index.pending_cleanup.length },
  );
}

function replaceRunMetadata(index, run) {
  return {
    ...index,
    runs: index.runs.map((item) => item.run_id === run.run_id ? run : item),
  };
}

function metadataFromTail(metadata, chunkIndex, chunk) {
  const last = chunk.samples[chunk.samples.length - 1];
  const chunkBytes = metadata.chunk_bytes.slice(0, chunkIndex);
  chunkBytes[chunkIndex] = chunk.bytes;
  const next = {
    ...metadata,
    sample_count: chunkIndex * RUNNING_LOCAL_FIELD_LOG_CHUNK_SAMPLES
      + chunk.samples.length,
    chunk_count: chunkIndex + 1,
    chunk_bytes: chunkBytes,
    last_sample_at_ms: last.captured_at_ms,
    last_elapsed_ms: last.elapsed_ms,
    storage_status: 'ok',
  };
  if (Number.isFinite(last.distance_m)) next.last_distance_m = last.distance_m;
  else delete next.last_distance_m;
  if (Number.isFinite(last.steps_total)) next.last_steps_total = last.steps_total;
  else delete next.last_steps_total;
  return normalizeRunMetadata(next);
}

function reconcileRunTail(storage, index, runId) {
  let metadata = index.runs.find((run) => run.run_id === runId);
  if (!metadata) {
    return mutationResult(
      false,
      RUNNING_LOCAL_FIELD_LOG_STATUS.RUN_NOT_FOUND,
      index,
      runId,
    );
  }
  let tail = null;
  let changed = false;
  if (metadata.chunk_count > 0) {
    const tailResult = readChunkResult(
      storage,
      runId,
      metadata.chunk_count - 1,
    );
    if (!tailResult.ok) {
      return mutationResult(false, tailResult.status, index, runId);
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
        RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE,
        index,
        runId,
      );
    }
    changed = stableJson(reconciled) !== stableJson(metadata);
    metadata = reconciled;
  }
  // Recover chunks that were verified before their small-index update failed.
  while (metadata.chunk_count < RUNNING_LOCAL_FIELD_LOG_MAX_CHUNKS_PER_RUN) {
    const orphan = readChunkResult(
      storage,
      runId,
      metadata.chunk_count,
      true,
    );
    if (!orphan.ok) {
      return mutationResult(false, orphan.status, index, runId);
    }
    if (!orphan.exists) break;
    if (tail && tail.samples.length !== RUNNING_LOCAL_FIELD_LOG_CHUNK_SAMPLES) {
      return mutationResult(
        false,
        RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE,
        index,
        runId,
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
        RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE,
        index,
        runId,
      );
    }
    metadata = reconciled;
    changed = true;
  }
  const nextIndex = replaceRunMetadata(index, metadata);
  if (changed) {
    const written = writeIndexVerified(storage, nextIndex, runId);
    return { ...written, tail: written.ok ? tail : null };
  }
  return {
    ...mutationResult(
      true,
      RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE,
      nextIndex,
      runId,
    ),
    tail,
  };
}

function markDropped(storage, index, runId, count, storageStatus, status) {
  const metadata = index.runs.find((run) => run.run_id === runId);
  if (!metadata) {
    return mutationResult(false, status, index, runId, { dropped: count });
  }
  const attempted = normalizeRunMetadata({
    ...metadata,
    dropped_count: Math.min(1000000, metadata.dropped_count + count),
    storage_status: storageStatus,
  });
  const written = attempted
    ? writeIndexVerified(storage, replaceRunMetadata(index, attempted), runId)
    : mutationResult(false, status, index, runId);
  return mutationResult(
    false,
    status,
    written.ok ? written.index : replaceRunMetadata(index, attempted || metadata),
    runId,
    { dropped: count, droppedPersisted: written.ok },
  );
}

function projectedIndexAfterChunk(index, runId, chunkIndex, chunk) {
  const metadata = index.runs.find((run) => run.run_id === runId);
  if (!metadata) return null;
  const nextMetadata = metadataFromTail(metadata, chunkIndex, chunk);
  return nextMetadata ? replaceRunMetadata(index, nextMetadata) : null;
}

function projectedStorageBytes(
  index,
  runId,
  chunkIndex,
  nextSamples,
  nextChunkBytes,
) {
  const projected = projectedIndexAfterChunk(
    index,
    runId,
    chunkIndex,
    { samples: nextSamples, bytes: nextChunkBytes },
  );
  return projected ? knownStorageBytes(projected) : Number.POSITIVE_INFINITY;
}

export function appendRunningLocalFieldSamples(storage, runId, values) {
  if (!validRunId(runId)) {
    return mutationResult(
      false,
      RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      emptyIndex(),
    );
  }
  const incoming = (Array.isArray(values) ? values : [values])
    .map(normalizeRunningLocalFieldSample)
    .filter(Boolean)
    .sort((left, right) => left.captured_at_ms - right.captured_at_ms);
  if (!incoming.length) {
    const current = readIndexResult(storage);
    return mutationResult(
      false,
      RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      current.index,
      runId,
    );
  }
  let current = readIndexResult(storage);
  if (!current.ok) {
    return mutationResult(false, current.status, current.index, runId);
  }
  let metadata = current.index.runs.find((run) => run.run_id === runId);
  if (!metadata) {
    return mutationResult(
      false,
      RUNNING_LOCAL_FIELD_LOG_STATUS.RUN_NOT_FOUND,
      current.index,
      runId,
    );
  }
  if (metadata.status !== 'active') {
    return mutationResult(
      false,
      RUNNING_LOCAL_FIELD_LOG_STATUS.RUN_FINISHED,
      current.index,
      runId,
    );
  }
  const reconciled = reconcileRunTail(storage, current.index, runId);
  if (!reconciled.ok) return reconciled;
  current = { ok: true, index: reconciled.index };
  metadata = reconciled.run;
  let tail = reconciled.tail;
  const previous = tail && tail.samples.length
    ? tail.samples[tail.samples.length - 1] : null;
  const accepted = [];
  for (let index = 0; index < incoming.length; index += 1) {
    const sample = incoming[index];
    if (sample.captured_at_ms < metadata.started_at_ms) continue;
    const last = accepted[accepted.length - 1] || previous;
    if (last && sample.captured_at_ms - last.captured_at_ms
        < RUNNING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS) continue;
    accepted.push(sample);
  }
  if (!accepted.length) {
    return mutationResult(
      true,
      RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE,
      current.index,
      runId,
      { appended: 0 },
    );
  }
  const capacity = RUNNING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RUN
    - metadata.sample_count;
  const toAppend = accepted.slice(0, Math.max(0, capacity));
  const overRunLimit = accepted.length - toAppend.length;
  if (!toAppend.length) {
    return markDropped(
      storage,
      current.index,
      runId,
      accepted.length,
      'capacity',
      RUNNING_LOCAL_FIELD_LOG_STATUS.CAPACITY_EXCEEDED,
    );
  }

  let appended = 0;
  while (appended < toAppend.length) {
    metadata = current.index.runs.find((run) => run.run_id === runId);
    const tailIndex = metadata.chunk_count > 0 ? metadata.chunk_count - 1 : 0;
    const tailSamples = tail && metadata.chunk_count > 0
      ? tail.samples.slice() : [];
    const room = RUNNING_LOCAL_FIELD_LOG_CHUNK_SAMPLES - tailSamples.length;
    const chunkIndex = room > 0 ? tailIndex : metadata.chunk_count;
    const baseSamples = room > 0 ? tailSamples : [];
    const take = Math.min(
      RUNNING_LOCAL_FIELD_LOG_CHUNK_SAMPLES - baseSamples.length,
      toAppend.length - appended,
    );
    const nextSamples = [
      ...baseSamples,
      ...toAppend.slice(appended, appended + take),
    ];
    const encoded = buildChunk(runId, chunkIndex, nextSamples);
    if (!encoded) {
      return markDropped(
        storage,
        current.index,
        runId,
        toAppend.length - appended + overRunLimit,
        'write_failed',
        RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      );
    }
    const nextChunkBytes = runningLocalFieldLogUtf8Bytes(stableJson(encoded));
    if (nextChunkBytes > RUNNING_LOCAL_FIELD_LOG_MAX_CHUNK_BYTES) {
      return markDropped(
        storage,
        current.index,
        runId,
        toAppend.length - appended + overRunLimit,
        'capacity',
        RUNNING_LOCAL_FIELD_LOG_STATUS.CHUNK_TOO_LARGE,
      );
    }
    let projected = projectedStorageBytes(
      current.index,
      runId,
      chunkIndex,
      nextSamples,
      nextChunkBytes,
    );
    while (projected > RUNNING_LOCAL_FIELD_LOG_MAX_TOTAL_BYTES) {
      const eviction = evictOldestFinished(storage, current.index, runId);
      if (!eviction.ok) return eviction;
      if (!eviction.evicted) {
        return markDropped(
          storage,
          current.index,
          runId,
          toAppend.length - appended + overRunLimit,
          'capacity',
          RUNNING_LOCAL_FIELD_LOG_STATUS.CAPACITY_EXCEEDED,
        );
      }
      current = { ok: true, index: eviction.index };
      const cleanup = runPendingCleanup(storage, current.index, runId);
      if (cleanup.ok) current = { ok: true, index: cleanup.index };
      projected = projectedStorageBytes(
        current.index,
        runId,
        chunkIndex,
        nextSamples,
        nextChunkBytes,
      );
      if (!cleanup.ok && projected > RUNNING_LOCAL_FIELD_LOG_MAX_TOTAL_BYTES) {
        return markDropped(
          storage,
          current.index,
          runId,
          toAppend.length - appended + overRunLimit,
          'capacity',
          RUNNING_LOCAL_FIELD_LOG_STATUS.CAPACITY_EXCEEDED,
        );
      }
    }
    const write = writeChunkVerified(
      storage,
      runId,
      chunkIndex,
      nextSamples,
    );
    if (!write.ok) {
      return markDropped(
        storage,
        current.index,
        runId,
        toAppend.length - appended + overRunLimit,
        'write_failed',
        write.status,
      );
    }
    const nextIndex = projectedIndexAfterChunk(
      current.index,
      runId,
      chunkIndex,
      write.chunk,
    );
    const indexWrite = nextIndex
      ? writeIndexVerified(storage, nextIndex, runId)
      : mutationResult(
        false,
        RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_STORAGE,
        current.index,
        runId,
      );
    if (!indexWrite.ok) {
      return mutationResult(
        false,
        indexWrite.status,
        indexWrite.index,
        runId,
        { appended, orphanChunkRecoverable: true },
      );
    }
    current = { ok: true, index: indexWrite.index };
    tail = write.chunk;
    appended += take;
  }
  if (overRunLimit > 0) {
    const dropped = markDropped(
      storage,
      current.index,
      runId,
      overRunLimit,
      'capacity',
      RUNNING_LOCAL_FIELD_LOG_STATUS.CAPACITY_EXCEEDED,
    );
    return { ...dropped, appended };
  }
  return mutationResult(
    true,
    RUNNING_LOCAL_FIELD_LOG_STATUS.PERSISTED,
    current.index,
    runId,
    { appended, storageBytes: knownStorageBytes(current.index) },
  );
}

function mutateMetadata(storage, runId, mutate) {
  if (!validRunId(runId) || typeof mutate !== 'function') {
    return mutationResult(
      false,
      RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      emptyIndex(),
    );
  }
  const current = readIndexResult(storage);
  if (!current.ok) {
    return mutationResult(false, current.status, current.index, runId);
  }
  const metadata = current.index.runs.find((run) => run.run_id === runId);
  if (!metadata) {
    return mutationResult(
      false,
      RUNNING_LOCAL_FIELD_LOG_STATUS.RUN_NOT_FOUND,
      current.index,
      runId,
    );
  }
  let candidate = null;
  try { candidate = normalizeRunMetadata(mutate(metadata)); } catch (_error) {}
  if (!candidate) {
    return mutationResult(
      false,
      RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      current.index,
      runId,
    );
  }
  if (stableJson(candidate) === stableJson(metadata)) {
    return mutationResult(
      true,
      RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE,
      current.index,
      runId,
    );
  }
  return writeIndexVerified(
    storage,
    replaceRunMetadata(current.index, candidate),
    runId,
  );
}

export function appendRunningLocalFieldEvent(storage, runId, value) {
  const event = normalizeRunningLocalFieldEvent(value);
  if (!event) {
    return mutationResult(
      false,
      RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      readIndexResult(storage).index,
      runId,
    );
  }
  return mutateMetadata(storage, runId, (run) => ({
    ...run,
    events: [...run.events, event],
  }));
}

export function finishRunningLocalFieldLog(storage, runId, options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const endedAtMs = integerInRange(
    source.endedAtMs ?? source.ended_at_ms,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  if (endedAtMs === null) {
    return mutationResult(
      false,
      RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT,
      readIndexResult(storage).index,
      runId,
    );
  }
  const summary = normalizeRunningLocalFieldSummary(source.summary);
  return mutateMetadata(storage, runId, (run) => ({
    ...run,
    status: source.aborted === true ? 'aborted' : 'completed',
    ended_at_ms: endedAtMs,
    ...(summary ? { summary } : {}),
    events: [...run.events, {
      at_ms: endedAtMs,
      elapsed_ms: summary && summary.elapsed_ms != null
        ? summary.elapsed_ms : Math.max(0, endedAtMs - run.started_at_ms),
      kind: 'lifecycle',
      name: source.aborted === true ? 'RUN_ABORTED' : 'RUN_FINISHED',
      reason: source.aborted === true ? 'unload' : 'summary',
    }],
  }));
}

export function readRunningLocalFieldLogIndexResult(storage) {
  return readIndexResult(storage);
}

function expandedRunFromMetadata(metadata, samples, partial = false) {
  return normalizeRunningLocalFieldRun({
    run_id: metadata.run_id,
    started_at_ms: metadata.started_at_ms,
    status: metadata.status,
    ended_at_ms: metadata.ended_at_ms,
    samples,
    events: metadata.events,
    summary: metadata.summary,
    dropped_count: metadata.dropped_count,
    storage_status: partial ? 'partial' : metadata.storage_status,
  });
}

export function readRunningLocalFieldLogsResult(storage) {
  const indexResult = readIndexResult(storage);
  if (!indexResult.ok) {
    return {
      ok: false,
      status: indexResult.status,
      store: { schema_version: RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION, runs: [] },
      index: indexResult.index,
    };
  }
  const runs = [];
  let partial = false;
  for (const metadata of indexResult.index.runs) {
    const samples = [];
    let runPartial = false;
    for (let chunkIndex = 0;
      chunkIndex < metadata.chunk_count; chunkIndex += 1) {
      const chunk = readChunkResult(storage, metadata.run_id, chunkIndex);
      if (!chunk.ok) {
        partial = true;
        runPartial = true;
        break;
      }
      samples.push(...chunk.chunk.samples);
    }
    if (samples.length !== metadata.sample_count) {
      partial = true;
      runPartial = true;
    }
    const run = expandedRunFromMetadata(metadata, samples, runPartial);
    if (run) runs.push(run);
  }
  return {
    ok: !partial,
    status: partial ? RUNNING_LOCAL_FIELD_LOG_STATUS.PARTIAL_STORAGE
      : RUNNING_LOCAL_FIELD_LOG_STATUS.PERSISTED,
    store: {
      schema_version: RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
      runs,
    },
    index: indexResult.index,
    storageBytes: knownStorageBytes(indexResult.index),
  };
}

export function readRunningLocalFieldLogs(storage) {
  return readRunningLocalFieldLogsResult(storage).store;
}

export function readRunningLocalFieldLog(storage, runId) {
  if (!validRunId(runId)) return null;
  const indexResult = readIndexResult(storage);
  if (!indexResult.ok) return null;
  const metadata = indexResult.index.runs.find((run) => run.run_id === runId);
  if (!metadata) return null;
  const samples = [];
  let partial = false;
  for (let chunkIndex = 0;
    chunkIndex < metadata.chunk_count; chunkIndex += 1) {
    const chunk = readChunkResult(storage, runId, chunkIndex);
    if (!chunk.ok) {
      partial = true;
      break;
    }
    samples.push(...chunk.chunk.samples);
  }
  if (samples.length !== metadata.sample_count) partial = true;
  return expandedRunFromMetadata(metadata, samples, partial);
}

export function readLatestRunningLocalFieldLog(storage) {
  const indexResult = readIndexResult(storage);
  if (!indexResult.ok || !indexResult.index.runs.length) return null;
  return readRunningLocalFieldLog(storage, indexResult.index.runs[0].run_id);
}

function average(values, digits = 2) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (!numbers.length) return null;
  const scale = 10 ** digits;
  return Math.round(
    numbers.reduce((sum, value) => sum + value, 0) / numbers.length * scale,
  ) / scale;
}

export function buildLatestRunningLocalFieldLogDigest(value) {
  let run = null;
  if (value && typeof value === 'object' && validRunId(value.run_id)) {
    run = normalizeRunningLocalFieldRun(value);
  } else {
    const store = normalizeRunningLocalFieldStore(value);
    run = store.runs[0] || null;
  }
  if (!run) return null;
  const samples = run.samples;
  const first = samples[0] || null;
  const last = samples[samples.length - 1] || null;
  const countTrue = (key) => samples.reduce(
    (count, sample) => count + (sample[key] === true ? 1 : 0),
    0,
  );
  const digest = {
    schema_version: RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    run_id: run.run_id,
    status: run.status,
    started_at_ms: run.started_at_ms,
    sample_count: samples.length,
    event_count: run.events.length,
    dropped_count: run.dropped_count,
    storage_status: run.storage_status,
    rsc_live_samples: countTrue('rsc_live'),
    hr_live_samples: countTrue('hr_live'),
    stationary_samples: countTrue('stationary'),
    avg_motion_quality: average(samples.map((sample) => sample.motion_quality), 4),
    avg_cadence_spm: average(samples.map((sample) => sample.cadence_spm), 2),
    avg_bpm: average(samples.map((sample) => sample.bpm), 1),
    ...(run.ended_at_ms != null ? { ended_at_ms: run.ended_at_ms } : {}),
    ...(first ? { first_sample_at_ms: first.captured_at_ms } : {}),
    ...(last ? {
      last_sample_at_ms: last.captured_at_ms,
      last_elapsed_ms: last.elapsed_ms,
      last_distance_m: Number.isFinite(last.distance_m) ? last.distance_m : null,
      last_steps_total: Number.isFinite(last.steps_total) ? last.steps_total : null,
      last_cadence_spm: Number.isFinite(last.cadence_spm)
        ? last.cadence_spm : null,
      last_pace_sec_per_km: Number.isFinite(last.pace_sec_per_km)
        ? last.pace_sec_per_km : null,
      last_distance_source: last.distance_source || 'none',
      last_cadence_source: last.cadence_source || 'none',
    } : {}),
  };
  digest.checksum = runningLocalFieldLogChecksum(stableJson(digest));
  return digest;
}

function replayLine(kind, value) {
  return 'SMARTRUN_LOCAL_LOG|' + kind + '|' + stableJson(value);
}

export function buildRunningLocalFieldLogReplayLines(value) {
  const run = normalizeRunningLocalFieldRun(value);
  if (!run) return [];
  const payload = stableJson({
    schema_version: RUNNING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
    run,
  });
  if (!payload) return [];
  const fragments = [];
  const maxFragmentCharacters = 1100;
  for (let offset = 0; offset < payload.length;
    offset += maxFragmentCharacters) {
    fragments.push(payload.slice(offset, offset + maxFragmentCharacters));
  }
  const checksum = runningLocalFieldLogChecksum(payload);
  const common = {
    run_id: run.run_id,
    parts: fragments.length,
    bytes: runningLocalFieldLogUtf8Bytes(payload),
    checksum,
  };
  const lines = [replayLine('BEGIN', common)];
  for (let index = 0; index < fragments.length; index += 1) {
    lines.push(replayLine('CHUNK', {
      run_id: run.run_id,
      part: index + 1,
      parts: fragments.length,
      data: fragments[index],
    }));
  }
  lines.push(replayLine('END', common));
  return lines.every((line) => (
    runningLocalFieldLogUtf8Bytes(line)
      < RUNNING_LOCAL_FIELD_LOG_REPLAY_MAX_LINE_BYTES
  )) ? lines : [];
}

export function recoverActiveRunningLocalFieldLogs(storage, options = {}) {
  const now = integerInRange(
    options.endedAtMs ?? options.ended_at_ms ?? Date.now(),
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  const current = readIndexResult(storage);
  if (!current.ok || now === null) {
    return {
      ok: false,
      status: now === null ? RUNNING_LOCAL_FIELD_LOG_STATUS.INVALID_INPUT
        : current.status,
      recovered: 0,
      runIds: [],
      index: current.index,
    };
  }
  const active = current.index.runs.filter((run) => run.status === 'active');
  const runIds = [];
  let lastStatus = RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE;
  for (const run of active) {
    const endedAtMs = Math.max(run.started_at_ms, now);
    appendRunningLocalFieldEvent(storage, run.run_id, {
      at_ms: endedAtMs,
      elapsed_ms: Number(run.last_elapsed_ms) || 0,
      kind: 'lifecycle',
      name: 'RECOVERED_ABORT',
      reason: 'previous_unload',
    });
    const result = finishRunningLocalFieldLog(storage, run.run_id, {
      endedAtMs,
      aborted: true,
      summary: {
        elapsed_ms: Number(run.last_elapsed_ms) || 0,
        distance_m: Number.isFinite(run.last_distance_m)
          ? run.last_distance_m : undefined,
        steps: Number.isFinite(run.last_steps_total)
          ? run.last_steps_total : undefined,
        sample_count: Number(run.sample_count) || 0,
      },
    });
    lastStatus = result.status;
    if (result.ok) runIds.push(run.run_id);
  }
  const after = readIndexResult(storage);
  return {
    ok: after.ok && runIds.length === active.length,
    status: active.length ? lastStatus : RUNNING_LOCAL_FIELD_LOG_STATUS.NO_CHANGE,
    recovered: runIds.length,
    runIds,
    index: after.index,
  };
}

export function clearRunningLocalFieldLogs(storage) {
  const current = readIndexResult(storage);
  if (!current.ok) {
    return {
      ok: false,
      status: current.status,
      clearedRuns: 0,
      index: current.index,
    };
  }
  if (!storage || typeof storage.removeStorageSync !== 'function'
      || typeof storage.getStorageSync !== 'function') {
    return {
      ok: false,
      status: RUNNING_LOCAL_FIELD_LOG_STATUS.STORAGE_UNAVAILABLE,
      clearedRuns: 0,
      index: current.index,
    };
  }
  const entries = [
    ...current.index.runs.map((run) => ({
      run_id: run.run_id,
      chunk_count: run.chunk_count,
    })),
    ...current.index.pending_cleanup.map((entry) => ({
      run_id: entry.run_id,
      chunk_count: entry.chunk_count,
    })),
  ];
  let chunksCleared = true;
  for (const entry of entries) {
    for (let chunkIndex = 0; chunkIndex < entry.chunk_count; chunkIndex += 1) {
      if (!removeChunkVerified(storage, entry.run_id, chunkIndex)) {
        chunksCleared = false;
      }
    }
  }
  try {
    storage.removeStorageSync(RUNNING_LOCAL_FIELD_LOG_KEY);
  } catch (_error) {
    return {
      ok: false,
      status: RUNNING_LOCAL_FIELD_LOG_STATUS.WRITE_FAILED,
      clearedRuns: 0,
      index: current.index,
    };
  }
  let indexCleared = false;
  try {
    const after = storage.getStorageSync(RUNNING_LOCAL_FIELD_LOG_KEY);
    indexCleared = after === undefined || after === null || after === '';
  } catch (_error) {}
  return {
    ok: chunksCleared && indexCleared,
    status: chunksCleared && indexCleared
      ? RUNNING_LOCAL_FIELD_LOG_STATUS.PERSISTED
      : RUNNING_LOCAL_FIELD_LOG_STATUS.VERIFICATION_FAILED,
    clearedRuns: chunksCleared && indexCleared ? current.index.runs.length : 0,
    index: chunksCleared && indexCleared ? emptyIndex() : current.index,
  };
}
