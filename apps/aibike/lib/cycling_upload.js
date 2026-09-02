// AIBike 户外测试数据上传协议（纯逻辑，无 wx 直接依赖）。
//
// - 每场骑行只使用随机、短期 test_ride_id，不读取或绑定任何公开 AIUI ID；
// - 运行样本最多 1 Hz，只允许派生骑行指标与质量状态；
// - finish 事件只允许聚合摘要；
// - 经纬度/轨迹、原始 IMU、原始 BLE、设备标识/名称和凭据没有任何白名单入口；
// - storage 与 request 均由页面注入，便于 AIUI wx 运行时和 Node 单测共用。

import { normalizeWxJsonResponse } from './wx_json.js';
import { normalizeHttpsBaseUrl } from './network_policy.js';

export const CYCLING_UPLOAD_DEFAULT_BASE_URL = '';
export const CYCLING_UPLOAD_PATH =
  '/api/coach-svc/coach/aiui-cycling-calibration/batch';
export const PENDING_CYCLING_UPLOAD_KEY =
  'pending_aibike_cycling_upload_events_v1';
export const QUARANTINED_CYCLING_UPLOAD_KEY =
  'quarantined_aibike_cycling_upload_events_v1';
export const CYCLING_UPLOAD_SCHEMA_VERSION = 1;
export const CYCLING_UPLOAD_BATCH_SIZE = 60;
export const CYCLING_UPLOAD_MAX_EVENTS = 1800;
// A lifecycle conflict can reject a complete 30 minute field ride at once.
// Keep the same bounded capacity as the pending queue so a whole rejected ride
// survives locally instead of retaining only its last few seconds.
export const CYCLING_UPLOAD_MAX_QUARANTINED_EVENTS = CYCLING_UPLOAD_MAX_EVENTS;
export const CYCLING_UPLOAD_CAPTURE_INTERVAL_MS = 1000;

const MIN_EPOCH_MS = 946684800000;   // 2000-01-01
const MAX_EPOCH_MS = 4102444800000;  // 2100-01-01
const MAX_RIDE_ELAPSED_MS = 172800000;
const MAX_RIDE_SAMPLES = MAX_RIDE_ELAPSED_MS / 1000;
const EVENT_ID_RE = /^[A-Za-z0-9._:-]{8,120}$/;
const TEST_RIDE_ID_RE = /^ride-[a-z0-9]{6,10}-[a-z0-9]{10,16}$/;

const EVENT_TYPES = Object.freeze(['sample', 'finish']);
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
const CYCLING_UPLOAD_CONFLICT_CODES = Object.freeze([
  'invalid_request',
  'validation',
  'event_payload',
  'ride_sequence',
  'ride_lifecycle',
  'finish_conflict',
  'event_conflict',
  'permanent_rejection',
]);

function integerInRange(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.round(numeric);
  return Number.isSafeInteger(rounded) && rounded >= min && rounded <= max
    ? rounded : null;
}

function numberInRange(value, min, max, digits = 3) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) return null;
  const scale = 10 ** digits;
  return Math.round(numeric * scale) / scale;
}

function enumValue(value, choices) {
  return typeof value === 'string' && choices.indexOf(value) >= 0
    ? value : null;
}

function uniqueEnums(value, choices, max = 8) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (let index = 0; index < value.length && result.length < max; index += 1) {
    const item = enumValue(value[index], choices);
    if (item && result.indexOf(item) < 0) result.push(item);
  }
  return result;
}

function stableJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return '';
  }
}

function validEventId(value) {
  return typeof value === 'string' && EVENT_ID_RE.test(value);
}

function validTestRideId(value) {
  return typeof value === 'string' && TEST_RIDE_ID_RE.test(value);
}

function normalizeBaseUrl(value) {
  return normalizeHttpsBaseUrl(value);
}

function nextRandomUint32(random) {
  let value;
  try {
    value = Number(random());
  } catch (_error) {
    value = Math.random();
  }
  if (!Number.isFinite(value)) value = Math.random();
  const fraction = Math.abs(value % 1);
  return Math.floor(fraction * 0x100000000) >>> 0;
}

function randomNonce(options = {}) {
  // AIUI 0.15 支持 crypto.randomUUID；缺失时才回退到 Math.random。
  // random 注入只用于可重复单测，不接受外部字符串，避免误把设备 ID 当 nonce。
  if (typeof options.random !== 'function') {
    try {
      if (typeof crypto !== 'undefined'
          && crypto
          && typeof crypto.randomUUID === 'function') {
        const uuid = crypto.randomUUID().replace(/[^a-f0-9]/gi, '').toLowerCase();
        if (uuid.length >= 14) return uuid.slice(0, 14);
      }
    } catch (_error) {}
  }
  const random = typeof options.random === 'function'
    ? options.random : Math.random;
  return (
    nextRandomUint32(random).toString(36).padStart(7, '0')
    + nextRandomUint32(random).toString(36).padStart(7, '0')
  ).slice(0, 14);
}

export function createCyclingTestRideId(startedAtMs = Date.now(), options = {}) {
  const started = integerInRange(startedAtMs, MIN_EPOCH_MS, MAX_EPOCH_MS);
  if (started === null) return '';
  const value = 'ride-' + started.toString(36) + '-' + randomNonce(options);
  return validTestRideId(value) ? value : '';
}

export function createCyclingUploadSession(startedAtMs = Date.now(), options = {}) {
  const started = integerInRange(startedAtMs, MIN_EPOCH_MS, MAX_EPOCH_MS);
  if (started === null) return null;
  const testRideId = createCyclingTestRideId(started, options);
  if (!testRideId) return null;
  return {
    testRideId,
    startedAtMs: started,
    nextSeq: 1,
    lastCapturedAtMs: null,
    finished: false,
  };
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
  if (value) target[key] = value;
}

function normalizeCommonEvent(value) {
  if (!value || typeof value !== 'object') return null;
  const eventType = enumValue(value.event_type, EVENT_TYPES);
  const eventId = typeof value.event_id === 'string'
    ? value.event_id.trim() : '';
  const testRideId = typeof value.test_ride_id === 'string'
    ? value.test_ride_id.trim() : '';
  const seq = integerInRange(value.seq, 1, Number.MAX_SAFE_INTEGER);
  const capturedAtMs = integerInRange(
    value.captured_at_ms,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  const rideStartedAtMs = integerInRange(
    value.ride_started_at_ms,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  const elapsedMs = integerInRange(
    value.elapsed_ms,
    0,
    MAX_RIDE_ELAPSED_MS,
  );
  if (Number(value.schema_version) !== CYCLING_UPLOAD_SCHEMA_VERSION
      || value.source !== 'aiui_glasses'
      || value.test_mode !== true
      || !eventType
      || !validEventId(eventId)
      || !validTestRideId(testRideId)
      || seq === null
      || capturedAtMs === null
      || rideStartedAtMs === null
      || capturedAtMs < rideStartedAtMs
      || elapsedMs === null
      || eventId !== testRideId + '.' + String(seq).padStart(10, '0')) {
    return null;
  }
  return {
    schema_version: CYCLING_UPLOAD_SCHEMA_VERSION,
    source: 'aiui_glasses',
    test_mode: true,
    event_type: eventType,
    event_id: eventId,
    test_ride_id: testRideId,
    seq,
    captured_at_ms: capturedAtMs,
    ride_started_at_ms: rideStartedAtMs,
    elapsed_ms: elapsedMs,
  };
}

function normalizeSampleFields(normalized, value) {
  addNumber(normalized, value, 'speed_kmh', 0, 150, 3);
  addNumber(normalized, value, 'cadence_rpm', 0, 300, 2);
  // `candidateCadenceRpm` can deliberately outlive fresh IMU evidence so the
  // HUD does not flash during an AR-recording callback gap.  That display-only
  // hold must never become a telemetry candidate after the state is sanitized.
  const candidateIsFreshEvidence = value.imu_fresh !== false
    && value.imu_cadence_state !== 'holding'
    && value.imu_cadence_state !== 'display_only';
  if (candidateIsFreshEvidence) {
    addNumber(normalized, value, 'candidate_cadence_rpm', 0, 400, 2);
  }
  addNumber(normalized, value, 'distance_m', 0, 1000000, 3);
  addNumber(normalized, value, 'power_w', -2000, 5000, 1);
  addInteger(normalized, value, 'heart_rate_bpm', 20, 240);
  addNumber(normalized, value, 'imu_motion_confidence', 0, 1, 4);
  addNumber(normalized, value, 'imu_cadence_confidence', 0, 1, 4);
  addNumber(normalized, value, 'imu_cadence_correlation', -1, 1, 4);
  addInteger(normalized, value, 'reconnect_count', 0, 1000);

  addEnum(normalized, value, 'speed_source', METRIC_SOURCES);
  addEnum(normalized, value, 'cadence_source', METRIC_SOURCES);
  addEnum(normalized, value, 'power_source', METRIC_SOURCES);
  addEnum(normalized, value, 'heart_rate_source', METRIC_SOURCES);
  addEnum(normalized, value, 'distance_source', DISTANCE_SOURCES);
  addEnum(normalized, value, 'distance_mode', DISTANCE_MODES);
  addEnum(normalized, value, 'speed_state', METRIC_STATES);
  addEnum(normalized, value, 'cadence_state', METRIC_STATES);
  addEnum(normalized, value, 'power_state', METRIC_STATES);
  addEnum(normalized, value, 'heart_rate_state', METRIC_STATES);
  addEnum(normalized, value, 'distance_state', METRIC_STATES);
  addEnum(normalized, value, 'ble_state', BLE_STATES);
  addEnum(normalized, value, 'imu_motion_state', IMU_MOTION_STATES);
  addEnum(normalized, value, 'imu_cadence_state', IMU_CADENCE_STATES);
  addEnum(normalized, value, 'imu_quality_state', IMU_QUALITY_STATES);
  addEnum(normalized, value, 'imu_artifact', IMU_ARTIFACTS);
  if (typeof value.paused === 'boolean') normalized.paused = value.paused;
  if (typeof value.imu_fresh === 'boolean') normalized.imu_fresh = value.imu_fresh;
  return normalized;
}

function normalizeFinishFields(normalized, value) {
  addInteger(normalized, value, 'moving_ms', 0, MAX_RIDE_ELAPSED_MS);
  if (normalized.moving_ms != null && normalized.moving_ms > normalized.elapsed_ms) {
    normalized.moving_ms = normalized.elapsed_ms;
  }
  addNumber(normalized, value, 'distance_m', 0, 1000000, 3);
  addNumber(normalized, value, 'avg_speed_kmh', 0, 150, 3);
  addNumber(normalized, value, 'max_speed_kmh', 0, 150, 3);
  addNumber(normalized, value, 'avg_cadence_rpm', 0, 300, 2);
  addNumber(normalized, value, 'max_cadence_rpm', 0, 300, 2);
  addNumber(normalized, value, 'avg_power_w', -2000, 5000, 1);
  addNumber(normalized, value, 'max_power_w', -2000, 5000, 1);
  addInteger(normalized, value, 'avg_heart_rate_bpm', 20, 240);
  addInteger(normalized, value, 'max_heart_rate_bpm', 20, 240);
  addInteger(
    normalized,
    value,
    'sample_count',
    0,
    MAX_RIDE_SAMPLES,
  );
  const sources = uniqueEnums(value.sources, METRIC_SOURCES);
  const distanceSources = uniqueEnums(value.distance_sources, DISTANCE_SOURCES);
  const cadenceSources = uniqueEnums(value.cadence_sources, METRIC_SOURCES);
  if (sources.length) normalized.sources = sources;
  if (distanceSources.length) normalized.distance_sources = distanceSources;
  if (cadenceSources.length) normalized.cadence_sources = cadenceSources;
  return normalized;
}

/**
 * 严格事件白名单。任何未知字段（包括 position、raw_*、device_*、token）
 * 都会在进入 storage 或网络请求前被剥离。
 */
export function normalizeCyclingUploadEvent(value) {
  const normalized = normalizeCommonEvent(value);
  if (!normalized) return null;
  return normalized.event_type === 'sample'
    ? normalizeSampleFields(normalized, value)
    : normalizeFinishFields(normalized, value);
}

function createSessionEvent(session, eventType, fields, capturedAtMs) {
  if (!session
      || !validTestRideId(session.testRideId)
      || session.finished === true) return null;
  const seq = integerInRange(session.nextSeq, 1, Number.MAX_SAFE_INTEGER);
  const captured = integerInRange(capturedAtMs, MIN_EPOCH_MS, MAX_EPOCH_MS);
  if (seq === null || captured === null || captured < session.startedAtMs) return null;
  const event = normalizeCyclingUploadEvent({
    ...(fields && typeof fields === 'object' ? fields : {}),
    schema_version: CYCLING_UPLOAD_SCHEMA_VERSION,
    source: 'aiui_glasses',
    test_mode: true,
    event_type: eventType,
    event_id: session.testRideId + '.' + String(seq).padStart(10, '0'),
    test_ride_id: session.testRideId,
    seq,
    captured_at_ms: captured,
    ride_started_at_ms: session.startedAtMs,
    elapsed_ms: fields && fields.elapsed_ms != null
      ? fields.elapsed_ms
      : Math.max(0, captured - session.startedAtMs),
  });
  if (!event) return null;
  session.nextSeq = seq + 1;
  session.lastCapturedAtMs = captured;
  return event;
}

/** 构建不超过 1 Hz 的派生样本；force 仅供结束前补最后一帧。 */
export function captureCyclingUploadSample(session, sample = {}, options = {}) {
  const capturedAtMs = integerInRange(
    options.capturedAtMs == null ? Date.now() : options.capturedAtMs,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  if (capturedAtMs === null) return null;
  if (options.force !== true
      && session
      && session.lastCapturedAtMs != null
      && capturedAtMs - session.lastCapturedAtMs
        < CYCLING_UPLOAD_CAPTURE_INTERVAL_MS) {
    return null;
  }
  return createSessionEvent(session, 'sample', sample, capturedAtMs);
}

/** 构建一场骑行唯一的 finish 聚合摘要。 */
export function captureCyclingUploadFinish(session, summary = {}, options = {}) {
  const summaryEndMs = summary && summary.endedAtMs;
  const capturedAtMs = options.capturedAtMs == null
    ? (Number.isFinite(Number(summaryEndMs)) ? Number(summaryEndMs) : Date.now())
    : options.capturedAtMs;
  const event = createSessionEvent(session, 'finish', {
    elapsed_ms: summary.elapsed_ms ?? summary.elapsedMs,
    moving_ms: summary.moving_ms ?? summary.movingMs,
    distance_m: summary.distance_m ?? summary.distanceM,
    avg_speed_kmh: summary.avg_speed_kmh ?? summary.avgSpeedKmh,
    max_speed_kmh: summary.max_speed_kmh ?? summary.maxSpeedKmh,
    avg_cadence_rpm: summary.avg_cadence_rpm ?? summary.avgCadenceRpm,
    max_cadence_rpm: summary.max_cadence_rpm ?? summary.maxCadenceRpm,
    avg_power_w: summary.avg_power_w ?? summary.avgPowerW,
    max_power_w: summary.max_power_w ?? summary.maxPowerW,
    avg_heart_rate_bpm:
      summary.avg_heart_rate_bpm ?? summary.avgBpm,
    max_heart_rate_bpm:
      summary.max_heart_rate_bpm ?? summary.maxBpm,
    sample_count: summary.sample_count ?? summary.sampleCount,
    sources: summary.sources,
    distance_sources: summary.distance_sources ?? summary.distanceSources,
    cadence_sources: summary.cadence_sources ?? summary.cadenceSources,
  }, capturedAtMs);
  if (event) session.finished = true;
  return event;
}

function normalizeQueue(raw, maxEvents = CYCLING_UPLOAD_MAX_EVENTS) {
  if (!Array.isArray(raw)) return [];
  const events = [];
  const eventIds = {};
  const rideSequences = {};
  for (let index = 0; index < raw.length; index += 1) {
    const event = normalizeCyclingUploadEvent(raw[index]);
    if (!event || eventIds[event.event_id]) continue;
    const rideSequence = event.test_ride_id + ':' + event.seq;
    if (rideSequences[rideSequence]) continue;
    eventIds[event.event_id] = true;
    rideSequences[rideSequence] = true;
    events.push(event);
  }
  return events.slice(-Math.max(1, maxEvents));
}

export function readPendingCyclingUploadEventsResult(storage) {
  if (!storage || typeof storage.getStorageSync !== 'function') {
    return { ok: false, status: 'unavailable', events: [] };
  }
  try {
    const raw = storage.getStorageSync(PENDING_CYCLING_UPLOAD_KEY);
    if (raw === undefined || raw === null || raw === '') {
      return { ok: true, status: 'ok', events: [] };
    }
    if (!Array.isArray(raw)) {
      return { ok: false, status: 'invalid', events: [] };
    }
    return { ok: true, status: 'ok', events: normalizeQueue(raw) };
  } catch (_error) {
    return { ok: false, status: 'read_failed', events: [] };
  }
}

/**
 * 兼容旧调用方的数组接口。需要在读取后修改队列的代码必须使用上面的
 * result 接口，避免把读取失败误判成真实空队列。
 */
export function readPendingCyclingUploadEvents(storage) {
  return readPendingCyclingUploadEventsResult(storage).events;
}

/**
 * Never mix independent rides in one HTTP transaction. A permanent conflict
 * rolls the whole server transaction back, so ride-aligned batches prevent an
 * old lifecycle from rejecting a newly finished field test. The just-finished
 * ride may be prioritized without reordering events inside that ride.
 */
export function selectCyclingUploadBatch(events, priorityRideId = '') {
  const queue = normalizeQueue(events);
  if (!queue.length) return [];
  const preferred = validTestRideId(priorityRideId)
    && queue.some((event) => event.test_ride_id === priorityRideId)
    ? priorityRideId : queue[0].test_ride_id;
  return queue.filter(
    (event) => event.test_ride_id === preferred,
  ).slice(0, CYCLING_UPLOAD_BATCH_SIZE);
}

export function writePendingCyclingUploadEvents(storage, events) {
  if (!storage
      || typeof storage.getStorageSync !== 'function'
      || typeof storage.setStorageSync !== 'function') return null;
  const clean = normalizeQueue(events);
  try {
    // 即使调用方提供完整替换值，也先确认现有队列可读。读取异常时不允许
    // set/remove 覆盖未知的旧值。
    if (!readPendingCyclingUploadEventsResult(storage).ok) return null;
    if (clean.length) {
      storage.setStorageSync(PENDING_CYCLING_UPLOAD_KEY, clean);
    } else if (typeof storage.removeStorageSync === 'function') {
      storage.removeStorageSync(PENDING_CYCLING_UPLOAD_KEY);
    } else {
      storage.setStorageSync(PENDING_CYCLING_UPLOAD_KEY, []);
    }
    const roundTrip = readPendingCyclingUploadEventsResult(storage);
    return roundTrip.ok
      && stableJson(roundTrip.events) === stableJson(clean) ? clean : null;
  } catch (_error) {
    return null;
  }
}

/**
 * 追加到最新 storage，避免上传往返期间产生的新样本被旧快照覆盖。
 */
export function appendPendingCyclingUploadEvents(storage, events) {
  const incoming = normalizeQueue(events);
  const current = readPendingCyclingUploadEventsResult(storage);
  if (!current.ok) return null;
  if (!incoming.length) return current.events;
  return writePendingCyclingUploadEvents(
    storage,
    [...current.events, ...incoming],
  );
}

/**
 * 只按服务端明确返回的 acked_event_ids 删除；调用方不得根据 HTTP 2xx、
 * stored 数量或请求完成本身推断 ACK。
 */
export function removePendingCyclingUploadEvents(storage, ackedEventIds) {
  const ids = {};
  const source = Array.isArray(ackedEventIds) ? ackedEventIds : [];
  for (let index = 0; index < source.length; index += 1) {
    if (validEventId(source[index])) ids[source[index]] = true;
  }
  const current = readPendingCyclingUploadEventsResult(storage);
  if (!current.ok) return null;
  if (!Object.keys(ids).length) return current.events;
  return writePendingCyclingUploadEvents(
    storage,
    current.events.filter((event) => !ids[event.event_id]),
  );
}

function normalizeQuarantineRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const event = normalizeCyclingUploadEvent(value.event);
  const statusCode = integerInRange(value.status_code, 400, 599);
  const quarantinedAtMs = integerInRange(
    value.quarantined_at_ms,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  if (!event || statusCode === null || quarantinedAtMs === null) return null;
  const conflictCode = enumValue(
    value.conflict_code,
    CYCLING_UPLOAD_CONFLICT_CODES,
  ) || 'permanent_rejection';
  return {
    event,
    status_code: statusCode,
    conflict_code: conflictCode,
    quarantined_at_ms: quarantinedAtMs,
  };
}

function readQuarantinedCyclingUploadEventsResult(storage) {
  if (!storage || typeof storage.getStorageSync !== 'function') {
    return { ok: false, records: [] };
  }
  try {
    const raw = storage.getStorageSync(QUARANTINED_CYCLING_UPLOAD_KEY);
    if (raw === undefined || raw === null || raw === '') {
      return { ok: true, records: [] };
    }
    if (!Array.isArray(raw)) return { ok: false, records: [] };
    const records = [];
    const ids = {};
    for (let index = 0; index < raw.length; index += 1) {
      const record = normalizeQuarantineRecord(raw[index]);
      if (!record || ids[record.event.event_id]) continue;
      ids[record.event.event_id] = true;
      records.push(record);
    }
    return {
      ok: true,
      records: records.slice(-CYCLING_UPLOAD_MAX_QUARANTINED_EVENTS),
    };
  } catch (_error) {
    return { ok: false, records: [] };
  }
}

export function readQuarantinedCyclingUploadEvents(storage) {
  return readQuarantinedCyclingUploadEventsResult(storage).records;
}

/**
 * Atomically records a bounded group before removing it from pending. This is
 * used for server-declared ride-wide lifecycle conflicts; recursively
 * splitting every 1 Hz sample would otherwise exhaust the request budget and
 * starve newer rides. Unknown response text is never persisted.
 */
export function quarantineCyclingUploadEvents(
  storage,
  values,
  statusCode,
  conflictCode = 'permanent_rejection',
  quarantinedAtMs = Date.now(),
) {
  const events = normalizeQueue(values);
  const normalizedCode = enumValue(conflictCode, CYCLING_UPLOAD_CONFLICT_CODES)
    || 'permanent_rejection';
  const normalizedStatus = integerInRange(statusCode, 400, 599);
  const normalizedAtMs = integerInRange(
    quarantinedAtMs,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  if (!events.length || normalizedStatus === null || normalizedAtMs === null
      || !storage || typeof storage.getStorageSync !== 'function'
      || typeof storage.setStorageSync !== 'function') return null;
  try {
    const quarantineRead = readQuarantinedCyclingUploadEventsResult(storage);
    const pendingRead = readPendingCyclingUploadEventsResult(storage);
    if (!quarantineRead.ok || !pendingRead.ok) return null;
    const ids = {};
    for (let index = 0; index < events.length; index += 1) {
      ids[events[index].event_id] = true;
    }
    const incoming = events.map((event) => normalizeQuarantineRecord({
      event,
      status_code: normalizedStatus,
      conflict_code: normalizedCode,
      quarantined_at_ms: normalizedAtMs,
    }));
    const previous = quarantineRead.records.filter(
      (record) => !ids[record.event.event_id],
    );
    const previousCapacity = Math.max(
      0,
      CYCLING_UPLOAD_MAX_QUARANTINED_EVENTS - incoming.length,
    );
    const retainedPrevious = previousCapacity > 0
      ? previous.slice(-previousCapacity) : [];
    // Incoming records are always retained in full. If the bounded store is
    // full, discard the oldest prior quarantine records instead of silently
    // removing freshly rejected pending events without a durable copy.
    const next = [...retainedPrevious, ...incoming];
    storage.setStorageSync(QUARANTINED_CYCLING_UPLOAD_KEY, next);
    const roundTrip = readQuarantinedCyclingUploadEventsResult(storage);
    if (!roundTrip.ok || !events.every((event) => roundTrip.records.some(
      (record) => record.event.event_id === event.event_id
        && record.conflict_code === normalizedCode,
    ))) return null;
    const remaining = writePendingCyclingUploadEvents(
      storage,
      pendingRead.events.filter((event) => !ids[event.event_id]),
    );
    return remaining === null ? null : {
      quarantined: incoming,
      pending: remaining,
    };
  } catch (_error) {
    return null;
  }
}

/**
 * 单条永久拒绝事件先写入隐私白名单隔离区，读回确认后才移出待上传队列。
 * 隔离不等同服务端 ACK；它只避免一条异常数据永久阻塞后续完整骑行记录。
 */
export function quarantineCyclingUploadEvent(
  storage,
  value,
  statusCode,
  quarantinedAtMs = Date.now(),
) {
  const result = quarantineCyclingUploadEvents(
    storage,
    [value],
    statusCode,
    'permanent_rejection',
    quarantinedAtMs,
  );
  return result ? {
    quarantined: result.quarantined[0],
    pending: result.pending,
  } : null;
}

export function buildCyclingUploadRequest(options = {}) {
  const events = normalizeQueue(
    options.events,
    CYCLING_UPLOAD_MAX_EVENTS,
  ).slice(0, CYCLING_UPLOAD_BATCH_SIZE);
  const header = { 'Content-Type': 'application/json' };
  const token = typeof options.token === 'string' ? options.token.trim() : '';
  if (token) header.Authorization = 'Bearer ' + token;
  return {
    url: normalizeBaseUrl(options.baseUrl)
      + (options.path || CYCLING_UPLOAD_PATH),
    method: 'POST',
    header,
    dataType: 'json',
    responseType: 'text',
    timeout: Number(options.timeout) > 0 ? Number(options.timeout) : 12000,
    data: {
      schema_version: CYCLING_UPLOAD_SCHEMA_VERSION,
      test_mode: true,
      events,
    },
  };
}

function responseData(response) {
  const normalized = normalizeWxJsonResponse(response);
  if (!normalized || !normalized.data
      || typeof normalized.data !== 'object'
      || Array.isArray(normalized.data)) return null;
  return normalized.data;
}

/** Map only known server details to bounded diagnostic codes. */
export function classifyCyclingUploadRejection(response) {
  const statusCode = integerInRange(
    response && response.statusCode,
    400,
    599,
  );
  if (statusCode === null) return null;
  const data = responseData(response);
  const detail = data && typeof data.detail === 'string'
    ? data.detail.trim() : '';
  const known = {
    'event_id reused with different payload': 'event_payload',
    'test_ride_id and seq reused in one batch': 'ride_sequence',
    'test_ride_id belongs to another lifecycle': 'ride_lifecycle',
    'ride already has a different finish event': 'finish_conflict',
    'cycling event conflict': 'event_conflict',
  };
  return {
    statusCode,
    conflictCode: known[detail]
      || (statusCode === 422 ? 'validation'
        : statusCode === 400 ? 'invalid_request' : 'permanent_rejection'),
  };
}

export function parseCyclingUploadResponse(response, expectedEvents = []) {
  if (!response || Number(response.statusCode) !== 200) return null;
  const data = responseData(response);
  if (!data || !Array.isArray(data.acked_event_ids)) return null;
  const expected = {};
  const normalizedExpected = normalizeQueue(
    expectedEvents,
    CYCLING_UPLOAD_MAX_EVENTS,
  ).slice(0, CYCLING_UPLOAD_BATCH_SIZE);
  for (let index = 0; index < normalizedExpected.length; index += 1) {
    expected[normalizedExpected[index].event_id] = true;
  }
  const ackedEventIds = [];
  for (let index = 0; index < data.acked_event_ids.length; index += 1) {
    const eventId = data.acked_event_ids[index];
    if (validEventId(eventId)
        && expected[eventId]
        && ackedEventIds.indexOf(eventId) < 0) {
      ackedEventIds.push(eventId);
    }
  }
  if (!ackedEventIds.length) return null;
  const expectedRideIds = {};
  for (let index = 0; index < normalizedExpected.length; index += 1) {
    expectedRideIds[normalizedExpected[index].test_ride_id] = true;
  }
  const organizedRides = [];
  const rawRides = Array.isArray(data.organized_rides)
    ? data.organized_rides : [];
  for (let index = 0; index < rawRides.length; index += 1) {
    const ride = rawRides[index];
    const testRideId = ride && typeof ride.test_ride_id === 'string'
      ? ride.test_ride_id : '';
    if (!expectedRideIds[testRideId]) continue;
    const samples = integerInRange(ride.samples, 0, MAX_RIDE_SAMPLES);
    const startedAtMs = integerInRange(
      ride.started_at_ms,
      MIN_EPOCH_MS,
      MAX_EPOCH_MS,
    );
    const endedAtMs = ride.ended_at_ms == null
      ? null
      : integerInRange(ride.ended_at_ms, MIN_EPOCH_MS, MAX_EPOCH_MS);
    organizedRides.push({
      test_ride_id: testRideId,
      samples: samples === null ? 0 : samples,
      finish_received: ride.finish_received === true,
      started_at_ms: startedAtMs,
      ended_at_ms: endedAtMs,
    });
  }
  return {
    ackedEventIds,
    stored: integerInRange(data.stored, 0, CYCLING_UPLOAD_BATCH_SIZE) || 0,
    duplicates:
      integerInRange(data.duplicates, 0, CYCLING_UPLOAD_BATCH_SIZE) || 0,
    organizedRides,
  };
}

export function isPermanentCyclingUploadRejection(statusCode) {
  const status = Number(statusCode);
  return status === 400 || status === 409 || status === 422;
}

/**
 * 纯逻辑毒丸隔离计划，不改 storage：
 * - 网络失败/401/429/5xx：retain，原队列完整保留；
 * - 400/409/422 且批次>1：split，调用方可二分重试；
 * - 400/409/422 且批次=1：quarantine，已定位单条毒丸，但仍不在这里删除。
 */
export function isolateCyclingPoisonEvent(statusCode, events) {
  const batch = normalizeQueue(
    events,
    CYCLING_UPLOAD_MAX_EVENTS,
  ).slice(0, CYCLING_UPLOAD_BATCH_SIZE);
  if (!isPermanentCyclingUploadRejection(statusCode)) {
    return {
      action: 'retain',
      retryBatches: [],
      poisonEvent: null,
    };
  }
  if (!batch.length) {
    return {
      action: 'empty',
      retryBatches: [],
      poisonEvent: null,
    };
  }
  if (batch.length === 1) {
    return {
      action: 'quarantine',
      retryBatches: [],
      poisonEvent: batch[0],
    };
  }
  const middle = Math.ceil(batch.length / 2);
  return {
    action: 'split',
    retryBatches: [batch.slice(0, middle), batch.slice(middle)],
    poisonEvent: null,
  };
}
