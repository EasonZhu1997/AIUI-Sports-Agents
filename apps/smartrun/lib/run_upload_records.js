// Run 结束后的 Hermes 上传回执与永久拒绝隔离区。
//
// 隐私边界：
// - 回执只保存随机 stream_id / 稳定 client_run_id、ACK/匹配计数、完成时间和
//   剩余队列数；
// - 隔离记录再次经过各自上传协议的白名单归一化；
// - token、公开/内部设备 ID、经纬度和原始传感器字段永不进入这些 key。

import { normalizeAiuiCalibrationEvent } from './aiui_calibration.js';
import { normalizeRunUploadPayload } from './run_upload.js';

export const RUN_UPLOAD_RECEIPTS_KEY = 'run_upload_receipts_v1';
export const QUARANTINED_RUN_UPLOADS_KEY = 'quarantined_run_uploads_v1';
export const QUARANTINED_AIUI_CALIBRATION_KEY =
  'quarantined_aiui_calibration_events_v1';
export const RUN_UPLOAD_RECEIPTS_MAX = 32;
export const RUN_UPLOAD_QUARANTINE_MAX = 20;

const MIN_EPOCH_MS = 946684800000;
const MAX_EPOCH_MS = 4102444800000;
const SAFE_ID_RE = /^[A-Za-z0-9._:-]{8,120}$/;

function stableJson(value) {
  try { return JSON.stringify(value); } catch (_e) { return ''; }
}

function integerInRange(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const rounded = Math.round(number);
  return Number.isSafeInteger(rounded) && rounded >= min && rounded <= max
    ? rounded : null;
}

function safeId(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return SAFE_ID_RE.test(normalized) ? normalized : '';
}

function fnv1a32(text) {
  let hash = 0x811c9dc5;
  const value = String(text || '');
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function normalizeRunUploadReceipt(value) {
  if (!value || typeof value !== 'object') return null;
  const kind = value.kind === 'run' || value.kind === 'calibration'
    ? value.kind : '';
  const receiptId = safeId(value.receipt_id);
  const completedAtMs = integerInRange(
    value.completed_at_ms,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  const ackedCount = integerInRange(value.acked_count, 1, 2000000);
  const matchedCount = integerInRange(value.matched_count, 0, 2000000);
  const remainingCount = integerInRange(value.remaining_count, 0, 2000000);
  if (!kind || !receiptId || completedAtMs === null || ackedCount === null
      || matchedCount === null || remainingCount === null) return null;

  const normalized = {
    schema_version: 1,
    kind,
    receipt_id: receiptId,
    acked_count: ackedCount,
    matched_count: Math.min(matchedCount, ackedCount),
    completed_at_ms: completedAtMs,
    remaining_count: remainingCount,
  };
  if (kind === 'run') {
    const clientRunId = safeId(value.client_run_id);
    if (!clientRunId) return null;
    normalized.client_run_id = clientRunId;
  } else {
    const streamId = safeId(value.stream_id);
    if (!streamId) return null;
    normalized.stream_id = streamId;
  }
  return normalized;
}

function normalizeReceiptList(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = {};
  for (let i = value.length - 1; i >= 0; i -= 1) {
    const receipt = normalizeRunUploadReceipt(value[i]);
    if (!receipt || seen[receipt.receipt_id]) continue;
    seen[receipt.receipt_id] = true;
    result.unshift(receipt);
  }
  return result.slice(-RUN_UPLOAD_RECEIPTS_MAX);
}

export function readRunUploadReceipts(storage) {
  if (!storage || typeof storage.getStorageSync !== 'function') return [];
  try {
    return normalizeReceiptList(storage.getStorageSync(RUN_UPLOAD_RECEIPTS_KEY));
  } catch (_e) {
    return [];
  }
}

export function writeRunUploadReceipts(storage, receipts) {
  if (!storage || typeof storage.getStorageSync !== 'function') return null;
  const clean = normalizeReceiptList(receipts);
  try {
    if (clean.length) storage.setStorageSync(RUN_UPLOAD_RECEIPTS_KEY, clean);
    else if (typeof storage.removeStorageSync === 'function') {
      storage.removeStorageSync(RUN_UPLOAD_RECEIPTS_KEY);
    } else {
      storage.setStorageSync(RUN_UPLOAD_RECEIPTS_KEY, []);
    }
    const roundTrip = readRunUploadReceipts(storage);
    return stableJson(roundTrip) === stableJson(clean) ? clean : null;
  } catch (_e) {
    return null;
  }
}

export function appendRunUploadReceipt(storage, value) {
  const receipt = normalizeRunUploadReceipt(value);
  if (!receipt) return null;
  const current = readRunUploadReceipts(storage);
  const next = current.filter((item) => item.receipt_id !== receipt.receipt_id);
  next.push(receipt);
  return writeRunUploadReceipts(storage, next);
}

export function createRunSummaryUploadReceipt(payload, options = {}) {
  const run = normalizeRunUploadPayload(payload);
  if (!run) return null;
  return normalizeRunUploadReceipt({
    schema_version: 1,
    kind: 'run',
    receipt_id: 'receipt.run.' + run.client_run_id,
    client_run_id: run.client_run_id,
    acked_count: 1,
    matched_count: 0,
    completed_at_ms: options.completedAtMs == null
      ? Date.now() : options.completedAtMs,
    remaining_count: options.remainingCount,
  });
}

export function createCalibrationUploadReceipt(events, ackedEventIds, options = {}) {
  const source = Array.isArray(events) ? events : [];
  const expected = {};
  let streamId = '';
  for (let i = 0; i < source.length; i += 1) {
    const event = normalizeAiuiCalibrationEvent(source[i]);
    if (!event) continue;
    if (!streamId) streamId = event.stream_id;
    if (event.stream_id !== streamId) return null;
    expected[event.event_id] = true;
  }
  const ids = [];
  const rawIds = Array.isArray(ackedEventIds) ? ackedEventIds : [];
  for (let i = 0; i < rawIds.length; i += 1) {
    const id = safeId(rawIds[i]);
    if (id && expected[id] && ids.indexOf(id) < 0) ids.push(id);
  }
  if (!streamId || !ids.length) return null;
  ids.sort();
  return normalizeRunUploadReceipt({
    schema_version: 1,
    kind: 'calibration',
    receipt_id: 'receipt.cal.' + fnv1a32(ids.join('|')) + '.' + String(ids.length),
    stream_id: streamId,
    acked_count: ids.length,
    matched_count: options.matchedCount,
    completed_at_ms: options.completedAtMs == null
      ? Date.now() : options.completedAtMs,
    remaining_count: options.remainingCount,
  });
}

export function summarizeRunUploadReceipts(storage, options = {}) {
  const streamId = safeId(options.streamId);
  const clientRunId = safeId(options.clientRunId);
  const receipts = readRunUploadReceipts(storage);
  let ackedCount = 0;
  let matchedCount = 0;
  let completedAtMs = 0;
  for (let i = 0; i < receipts.length; i += 1) {
    const receipt = receipts[i];
    const selected = (streamId && receipt.stream_id === streamId)
      || (clientRunId && receipt.client_run_id === clientRunId);
    if (!selected) continue;
    ackedCount += receipt.acked_count;
    matchedCount += receipt.matched_count;
    completedAtMs = Math.max(completedAtMs, receipt.completed_at_ms);
  }
  return { ackedCount, matchedCount, completedAtMs };
}

function normalizeQuarantineStatus(value, allowed) {
  const status = integerInRange(value, 400, 499);
  return status !== null && allowed.indexOf(status) >= 0 ? status : null;
}

function quarantineState(ok, entries, reason = '') {
  return Object.freeze({ ok, entries: Object.freeze(entries), reason });
}

function readQuarantineState(storage, key, normalize) {
  if (!storage || typeof storage.getStorageSync !== 'function') {
    return quarantineState(false, [], 'storage_unavailable');
  }
  try {
    const raw = storage.getStorageSync(key);
    if (raw === '' || raw === undefined || raw === null) {
      return quarantineState(true, []);
    }
    if (!Array.isArray(raw)) return quarantineState(false, [], 'quarantine_corrupt');
    if (raw.length > RUN_UPLOAD_QUARANTINE_MAX) {
      return quarantineState(false, [], 'quarantine_overflow');
    }
    const result = [];
    const seen = {};
    for (let i = 0; i < raw.length; i += 1) {
      const entry = normalize(raw[i]);
      if (!entry || seen[entry.quarantine_id]) {
        return quarantineState(false, [], 'quarantine_corrupt');
      }
      seen[entry.quarantine_id] = true;
      result.push(entry);
    }
    return quarantineState(true, result);
  } catch (_e) {
    return quarantineState(false, [], 'storage_read_failed');
  }
}

function writeQuarantine(storage, key, entries, normalize, readState) {
  if (!storage || typeof storage.getStorageSync !== 'function') return null;
  if (!Array.isArray(entries) || entries.length > RUN_UPLOAD_QUARANTINE_MAX) return null;
  const clean = [];
  const seen = {};
  for (let i = 0; i < entries.length; i += 1) {
    const entry = normalize(entries[i]);
    if (!entry || seen[entry.quarantine_id]) return null;
    seen[entry.quarantine_id] = true;
    clean.push(entry);
  }
  try {
    if (clean.length) storage.setStorageSync(key, clean);
    else if (typeof storage.removeStorageSync === 'function') storage.removeStorageSync(key);
    else storage.setStorageSync(key, []);
    const roundTrip = readState(storage);
    return roundTrip.ok && stableJson(roundTrip.entries) === stableJson(clean)
      ? clean : null;
  } catch (_e) {
    return null;
  }
}

function normalizeRunQuarantineEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const run = normalizeRunUploadPayload(value.run);
  const statusCode = normalizeQuarantineStatus(value.status_code, [400, 409, 422]);
  const quarantinedAtMs = integerInRange(
    value.quarantined_at_ms,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  if (!run || statusCode === null || quarantinedAtMs === null) return null;
  return {
    schema_version: 1,
    quarantine_id: 'quarantine.run.' + run.client_run_id,
    status_code: statusCode,
    quarantined_at_ms: quarantinedAtMs,
    run,
  };
}

function normalizeCalibrationQuarantineEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const event = normalizeAiuiCalibrationEvent(value.event);
  const statusCode = normalizeQuarantineStatus(value.status_code, [400, 409, 422]);
  const quarantinedAtMs = integerInRange(
    value.quarantined_at_ms,
    MIN_EPOCH_MS,
    MAX_EPOCH_MS,
  );
  if (!event || statusCode === null || quarantinedAtMs === null) return null;
  return {
    schema_version: 1,
    quarantine_id: 'quarantine.cal.' + event.event_id,
    status_code: statusCode,
    quarantined_at_ms: quarantinedAtMs,
    event,
  };
}

export function readQuarantinedRunUploadsState(storage) {
  return readQuarantineState(
    storage,
    QUARANTINED_RUN_UPLOADS_KEY,
    normalizeRunQuarantineEntry,
  );
}

/** 仅供展示兼容；任何移除主 FIFO / “已同步”判断必须读取 State。 */
export function readQuarantinedRunUploads(storage) {
  return readQuarantinedRunUploadsState(storage).entries;
}

export function quarantineRunUpload(storage, run, statusCode, now = Date.now()) {
  const entry = normalizeRunQuarantineEntry({
    run,
    status_code: statusCode,
    quarantined_at_ms: now,
  });
  if (!entry) return null;
  const current = readQuarantinedRunUploadsState(storage);
  if (!current.ok) return null;
  const next = current.entries.filter(
    (item) => item.quarantine_id !== entry.quarantine_id,
  );
  if (next.length >= RUN_UPLOAD_QUARANTINE_MAX) return null;
  next.push(entry);
  return writeQuarantine(
    storage,
    QUARANTINED_RUN_UPLOADS_KEY,
    next,
    normalizeRunQuarantineEntry,
    readQuarantinedRunUploadsState,
  );
}

export function readQuarantinedAiuiCalibrationEventsState(storage) {
  return readQuarantineState(
    storage,
    QUARANTINED_AIUI_CALIBRATION_KEY,
    normalizeCalibrationQuarantineEntry,
  );
}

/** 仅供展示兼容；任何移除主 FIFO / “已同步”判断必须读取 State。 */
export function readQuarantinedAiuiCalibrationEvents(storage) {
  return readQuarantinedAiuiCalibrationEventsState(storage).entries;
}

export function quarantineAiuiCalibrationEvent(
  storage,
  event,
  statusCode,
  now = Date.now(),
) {
  const entry = normalizeCalibrationQuarantineEntry({
    event,
    status_code: statusCode,
    quarantined_at_ms: now,
  });
  if (!entry) return null;
  const current = readQuarantinedAiuiCalibrationEventsState(storage);
  if (!current.ok) return null;
  const next = current.entries.filter(
    (item) => item.quarantine_id !== entry.quarantine_id,
  );
  if (next.length >= RUN_UPLOAD_QUARANTINE_MAX) return null;
  next.push(entry);
  return writeQuarantine(
    storage,
    QUARANTINED_AIUI_CALIBRATION_KEY,
    next,
    normalizeCalibrationQuarantineEntry,
    readQuarantinedAiuiCalibrationEventsState,
  );
}
