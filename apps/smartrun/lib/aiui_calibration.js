// AIUI 跑步算法实验数据队列。
//
// AIUI 与 APK/Garmin 各自维护独立 stream；服务端按同一设备所有权生命周期和
// captured_at_ms 的邻近时间做配对。这里因此只使用 Date.now() 墙钟作为跨设备
// 对齐时间，绝不把 Generic Sensor 的单调 timestamp 当作 captured_at_ms。
//
// 隐私边界：严格白名单只允许派生运动指标与质量诊断；经纬度、原始加速度、
// 原始陀螺仪、设备号和认证信息都不会进入事件或 storage。

import { normalizeBaseUrl, DEFAULT_BASE_URL } from './coach_api.js';

export const AIUI_CALIBRATION_PATH =
  '/api/coach-svc/coach/aiui-calibration/batch';
export const PENDING_AIUI_CALIBRATION_KEY =
  'pending_aiui_calibration_events';
// 后端当前单批上限为 500。跑中只做 1Hz 本地采样与持久化，进入总结页后才
// 使用这个上限批量补传，避免把一场跑步拆成大量周期网络请求。
export const AIUI_CALIBRATION_BATCH_SIZE = 500;
export const AIUI_CALIBRATION_MAX_EVENTS = 1800;
export const AIUI_CALIBRATION_CAPTURE_INTERVAL_MS = 1000;

const MIN_EPOCH_MS = 946684800000;   // 2000-01-01
const MAX_EPOCH_MS = 4102444800000;  // 2100-01-01
const EVENT_ID_RE = /^[A-Za-z0-9._:-]{8,120}$/;
const REASON_RE = /^[A-Za-z0-9_.:-]{1,48}$/;
const DISTANCE_SOURCES = Object.freeze([
  'rsc_distance', 'rsc_speed', 'imu', 'none',
]);
const CADENCE_SOURCES = Object.freeze(['rsc', 'imu', 'none']);

function integerInRange(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const rounded = Math.round(number);
  return Number.isSafeInteger(rounded) && rounded >= min && rounded <= max
    ? rounded : null;
}

function numberInRange(value, min, max, digits = 3) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

function enumValue(value, choices) {
  return typeof value === 'string' && choices.indexOf(value) >= 0
    ? value : null;
}

function safeReason(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 48);
  return REASON_RE.test(normalized) ? normalized : '';
}

function stableJson(value) {
  try { return JSON.stringify(value); } catch (_e) { return ''; }
}

function validId(value) {
  return typeof value === 'string' && EVENT_ID_RE.test(value);
}

/**
 * 收敛成后端 AiuiEvent 的严格白名单。未知字段会被剥离，因此即使调用方
 * 意外把 position/raw sensor 对象传进来，也不会出现在请求或持久化队列。
 */
export function normalizeAiuiCalibrationEvent(value) {
  if (!value || typeof value !== 'object') return null;
  const eventId = typeof value.event_id === 'string' ? value.event_id.trim() : '';
  const streamId = typeof value.stream_id === 'string' ? value.stream_id.trim() : '';
  const seq = integerInRange(value.seq, 1, Number.MAX_SAFE_INTEGER);
  const capturedAtMs = integerInRange(value.captured_at_ms, MIN_EPOCH_MS, MAX_EPOCH_MS);
  const streamStartedAtMs = integerInRange(
    value.stream_started_at_ms,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  const elapsedMs = integerInRange(value.elapsed_ms, 0, 172800000);
  if (Number(value.schema_version) !== 1
      || value.source !== 'aiui_glasses'
      || !validId(eventId)
      || !validId(streamId)
      || seq === null
      || capturedAtMs === null
      || streamStartedAtMs === null
      || elapsedMs === null) return null;

  const normalized = {
    schema_version: 1,
    source: 'aiui_glasses',
    event_id: eventId,
    stream_id: streamId,
    seq,
    captured_at_ms: capturedAtMs,
    stream_started_at_ms: streamStartedAtMs,
    elapsed_ms: elapsedMs,
  };
  const numericFields = [
    ['cadence_spm', 0, 300, 2],
    ['candidate_cadence_spm', 0, 400, 2],
    ['speed_mps', 0, 20, 4],
    ['pace_sec_per_km', 60, 3600, 2],
    ['distance_m', 0, 500000, 3],
    ['motion_quality', 0, 1, 4],
    ['artifact_confidence', 0, 1, 4],
    ['gyro_rms', 0, 100, 4],
  ];
  for (let i = 0; i < numericFields.length; i += 1) {
    const [key, min, max, digits] = numericFields[i];
    const number = numberInRange(value[key], min, max, digits);
    if (number !== null) normalized[key] = number;
  }
  const integerFields = [
    ['steps_total', 0, 2000000],
    ['accepted_steps', 0, 2000000],
    ['candidate_steps', 0, 2000000],
    ['rejected_steps', 0, 2000000],
  ];
  for (let i = 0; i < integerFields.length; i += 1) {
    const [key, min, max] = integerFields[i];
    const number = integerInRange(value[key], min, max);
    if (number !== null) normalized[key] = number;
  }
  if (typeof value.stationary === 'boolean') normalized.stationary = value.stationary;
  const distanceSource = enumValue(value.distance_source, DISTANCE_SOURCES);
  const cadenceSource = enumValue(value.cadence_source, CADENCE_SOURCES);
  const reason = safeReason(value.rejection_reason);
  if (distanceSource) normalized.distance_source = distanceSource;
  if (cadenceSource) normalized.cadence_source = cadenceSource;
  if (reason) normalized.rejection_reason = reason;
  return normalized;
}

function normalizeQueue(raw, maxEvents = AIUI_CALIBRATION_MAX_EVENTS) {
  if (!Array.isArray(raw)) return [];
  const result = [];
  const eventIds = {};
  const streamSequences = {};
  for (let i = 0; i < raw.length; i += 1) {
    const event = normalizeAiuiCalibrationEvent(raw[i]);
    if (!event || eventIds[event.event_id]) continue;
    const streamSeq = event.stream_id + ':' + event.seq;
    if (streamSequences[streamSeq]) continue;
    eventIds[event.event_id] = true;
    streamSequences[streamSeq] = true;
    result.push(event);
  }
  return result.slice(-Math.max(1, maxEvents));
}

export function readPendingAiuiCalibrationEvents(storage) {
  return readPendingAiuiCalibrationEventsState(storage).events;
}

/**
 * 必须区分“确认是空队列”和“这次无法读取”。兼容读取函数继续保持 [] 的
 * 展示接口；上传、append、ACK 与“已同步”判断必须读取这个状态接口。
 * 原始数组中任一无效/重复/溢出记录都让整次读取 fail closed，绝不能静默
 * 丢掉一部分证据后再以较小数组覆盖 durable FIFO。
 */
export function readPendingAiuiCalibrationEventsState(storage) {
  if (!storage || typeof storage.getStorageSync !== 'function') {
    return Object.freeze({ ok: false, events: Object.freeze([]), reason: 'storage_unavailable' });
  }
  try {
    const raw = storage.getStorageSync(PENDING_AIUI_CALIBRATION_KEY);
    if (raw === '' || raw === undefined || raw === null) {
      return Object.freeze({ ok: true, events: Object.freeze([]), reason: '' });
    }
    if (!Array.isArray(raw)) {
      return Object.freeze({ ok: false, events: Object.freeze([]), reason: 'queue_corrupt' });
    }
    if (raw.length > AIUI_CALIBRATION_MAX_EVENTS) {
      return Object.freeze({ ok: false, events: Object.freeze([]), reason: 'queue_overflow' });
    }
    const clean = [];
    const eventIds = {};
    const streamSequences = {};
    for (let i = 0; i < raw.length; i += 1) {
      const event = normalizeAiuiCalibrationEvent(raw[i]);
      if (!event || eventIds[event.event_id]) {
        return Object.freeze({ ok: false, events: Object.freeze([]), reason: 'queue_corrupt' });
      }
      const streamSeq = event.stream_id + ':' + event.seq;
      if (streamSequences[streamSeq]) {
        return Object.freeze({ ok: false, events: Object.freeze([]), reason: 'queue_corrupt' });
      }
      eventIds[event.event_id] = true;
      streamSequences[streamSeq] = true;
      clean.push(event);
    }
    return Object.freeze({ ok: true, events: Object.freeze(clean), reason: '' });
  } catch (_e) {
    return Object.freeze({ ok: false, events: Object.freeze([]), reason: 'storage_read_failed' });
  }
}

export function writePendingAiuiCalibrationEvents(storage, events) {
  if (!storage || typeof storage.getStorageSync !== 'function') return null;
  const clean = normalizeQueue(events);
  try {
    if (clean.length) {
      storage.setStorageSync(PENDING_AIUI_CALIBRATION_KEY, clean);
    } else if (typeof storage.removeStorageSync === 'function') {
      storage.removeStorageSync(PENDING_AIUI_CALIBRATION_KEY);
    } else {
      storage.setStorageSync(PENDING_AIUI_CALIBRATION_KEY, []);
    }
    const roundTrip = readPendingAiuiCalibrationEventsState(storage);
    return roundTrip.ok && stableJson(roundTrip.events) === stableJson(clean)
      ? clean : null;
  } catch (_e) {
    return null;
  }
}

/**
 * 把内存小批次追加到最新 storage，网络往返期间新产生的事件不会被旧快照覆盖。
 */
export function appendPendingAiuiCalibrationEvents(storage, events) {
  const incoming = normalizeQueue(events);
  const current = readPendingAiuiCalibrationEventsState(storage);
  if (!current.ok) return null;
  if (!incoming.length) return current.events;
  return writePendingAiuiCalibrationEvents(
    storage,
    [...current.events, ...incoming],
  );
}

export function removePendingAiuiCalibrationEvents(storage, eventIds) {
  const ids = {};
  const source = Array.isArray(eventIds) ? eventIds : [];
  for (let i = 0; i < source.length; i += 1) {
    if (validId(source[i])) ids[source[i]] = true;
  }
  const current = readPendingAiuiCalibrationEventsState(storage);
  if (!current.ok) return null;
  if (!Object.keys(ids).length) return current.events;
  return writePendingAiuiCalibrationEvents(
    storage,
    current.events.filter((event) => !ids[event.event_id]),
  );
}

function streamNonce(value) {
  const source = String(value || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  if (source) return source;
  return Math.floor(Math.random() * 0xffffffff).toString(36).padStart(6, '0');
}

export function createAiuiCalibrationStream(startedAtMs = Date.now(), options = {}) {
  const started = integerInRange(startedAtMs, MIN_EPOCH_MS, MAX_EPOCH_MS);
  if (started === null) return null;
  const streamId = 'aiui_' + started + '_' + streamNonce(options.nonce);
  if (!validId(streamId)) return null;
  return {
    streamId,
    startedAtMs: started,
    nextSeq: 1,
    lastCapturedAtMs: null,
  };
}

/**
 * 构建 1Hz AIUI 派生指标样本。stream 会在成功构建后推进稳定 seq；
 * force 仅用于总结前补最后一帧，普通采样仍严格限频。
 */
export function captureAiuiCalibrationEvent(stream, sample = {}, options = {}) {
  if (!stream || !validId(stream.streamId)) return null;
  const capturedAtMs = integerInRange(
    options.capturedAtMs == null ? Date.now() : options.capturedAtMs,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  if (capturedAtMs === null) return null;
  if (options.force !== true
      && stream.lastCapturedAtMs != null
      && capturedAtMs - stream.lastCapturedAtMs < AIUI_CALIBRATION_CAPTURE_INTERVAL_MS) {
    return null;
  }
  const seq = integerInRange(stream.nextSeq, 1, Number.MAX_SAFE_INTEGER);
  if (seq === null) return null;
  const event = normalizeAiuiCalibrationEvent({
    ...sample,
    schema_version: 1,
    source: 'aiui_glasses',
    event_id: stream.streamId + '.' + String(seq).padStart(10, '0'),
    stream_id: stream.streamId,
    seq,
    captured_at_ms: capturedAtMs,
    stream_started_at_ms: stream.startedAtMs,
    elapsed_ms: sample.elapsed_ms == null
      ? Math.max(0, capturedAtMs - stream.startedAtMs)
      : sample.elapsed_ms,
  });
  if (!event) return null;
  stream.nextSeq = seq + 1;
  stream.lastCapturedAtMs = capturedAtMs;
  return event;
}

export function buildAiuiCalibrationRequest(opts = {}) {
  // 请求按 durable FIFO 顺序取最早 500 条。normalizeQueue 的通用队列上限
  // 会保留“最近 N 条”，不能直接用批次上限，否则调用方传 503 条时会静默
  // 丢掉最早 3 条。
  const events = normalizeQueue(opts.events, AIUI_CALIBRATION_MAX_EVENTS)
    .slice(0, AIUI_CALIBRATION_BATCH_SIZE);
  const header = { 'Content-Type': 'application/json' };
  if (opts.token) header.Authorization = 'Bearer ' + opts.token;
  return {
    url: normalizeBaseUrl(opts.baseUrl || DEFAULT_BASE_URL)
      + (opts.path || AIUI_CALIBRATION_PATH),
    method: 'POST',
    header,
    dataType: 'json',
    responseType: 'text',
    timeout: Number(opts.timeout) > 0 ? Number(opts.timeout) : 5000,
    data: { events },
  };
}

function responseData(response) {
  if (!response) return null;
  if (response.data && typeof response.data === 'object') return response.data;
  if (typeof response.data !== 'string') return null;
  try {
    const parsed = JSON.parse(response.data);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_e) {
    return null;
  }
}

export function parseAiuiCalibrationResponse(response, expectedEvents = []) {
  if (!response || Number(response.statusCode) !== 200) return null;
  const data = responseData(response);
  if (!data || !Array.isArray(data.acked_event_ids)) return null;
  const expected = {};
  const normalizedExpected = normalizeQueue(expectedEvents, AIUI_CALIBRATION_BATCH_SIZE);
  for (let i = 0; i < normalizedExpected.length; i += 1) {
    expected[normalizedExpected[i].event_id] = true;
  }
  const ackedEventIds = [];
  for (let i = 0; i < data.acked_event_ids.length; i += 1) {
    const eventId = data.acked_event_ids[i];
    if (validId(eventId)
        && (!normalizedExpected.length || expected[eventId])
        && ackedEventIds.indexOf(eventId) < 0) {
      ackedEventIds.push(eventId);
    }
  }
  if (!ackedEventIds.length) return null;
  return {
    ackedEventIds,
    stored: integerInRange(data.stored, 0, AIUI_CALIBRATION_BATCH_SIZE) || 0,
    duplicates: integerInRange(data.duplicates, 0, AIUI_CALIBRATION_BATCH_SIZE) || 0,
    matched: integerInRange(data.matched, 0, AIUI_CALIBRATION_BATCH_SIZE) || 0,
  };
}

export function isPermanentAiuiCalibrationRejection(statusCode) {
  const status = Number(statusCode);
  // 409 由后端用于稳定 event_id 载荷变化或同一 stream/seq 冲突；
  // 原样重试永远不会恢复，必须像 400/422 一样隔离出单条毒丸。
  return status === 400 || status === 409 || status === 422;
}
