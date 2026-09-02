// AIUI 已生成文本的持久化回写队列。
// 新版 AIUI 的 wx storage 会跨页面和重启保留 JSON 数据；因此后端暂时离线、
// token 过期或 app key 尚未 provision 时，跑后总结不再静默丢失。

export const PENDING_AIUI_RECORDS_KEY = 'pending_aiui_records';
export const PENDING_AIUI_RECORDS_MAX = 5;

function compact(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
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

export function normalizeAiuiRecord(value) {
  const src = value && typeof value === 'object' ? value : {};
  const question = compact(src.question, 200);
  const reply = compact(src.reply, 500);
  if (!question || !reply) return null;
  const record = {
    question,
    reply,
    source: compact(src.source || 'run-summary', 64) || 'run-summary',
  };
  const id = compact(src.id, 80);
  if (id) record.id = id;
  const createdAtMs = Number(src.createdAtMs);
  if (Number.isFinite(createdAtMs) && createdAtMs > 0) record.createdAtMs = createdAtMs;
  return record;
}

function newRecordId(record, fallbackNowMs = Date.now()) {
  const createdAtMs = record && record.createdAtMs;
  const time = Number.isFinite(Number(createdAtMs)) && Number(createdAtMs) > 0
    ? Math.round(Number(createdAtMs)) : Math.max(0, Math.round(Number(fallbackNowMs)) || 0);
  const stableText = [
    record && record.question,
    record && record.reply,
    record && record.source,
    time,
  ].join('|');
  return 'air-' + time.toString(36) + '-' + fnv1a32(stableText);
}

function queueState(ok, items, reason = '') {
  return Object.freeze({ ok, items: Object.freeze(items), reason });
}

function missingStorageValue(value) {
  // wx.getStorageSync() uses an empty string for a missing key on some hosts.
  return value === '' || value === undefined || value === null;
}

function uniqueLegacyId(record, usedIds, index) {
  const base = newRecordId(record, 0);
  if (!usedIds.has(base)) return base;
  // Preserve two distinct legacy entries even when their pre-ID payloads are
  // identical. The ordinal is deterministic for the same persisted array.
  return (base + '-' + String(index + 1)).slice(0, 80);
}

/**
 * Read durable records without treating an unreadable/corrupt value as an
 * authoritative empty queue. Mutating and sync-state callers must use this
 * form; readPendingAiuiRecords remains the display-only array API.
 */
export function readPendingAiuiRecordsState(storage) {
  if (!storage || typeof storage.getStorageSync !== 'function') {
    return queueState(false, [], 'storage_unavailable');
  }
  let raw;
  try {
    raw = storage.getStorageSync(PENDING_AIUI_RECORDS_KEY);
  } catch (_e) {
    return queueState(false, [], 'storage_read_failed');
  }
  if (missingStorageValue(raw)) return queueState(true, [], 'empty');
  if (!Array.isArray(raw)) return queueState(false, [], 'queue_corrupt');
  if (raw.length > PENDING_AIUI_RECORDS_MAX) {
    return queueState(false, [], 'queue_overflow');
  }

  const clean = [];
  const usedIds = new Set();
  for (let i = 0; i < raw.length; i += 1) {
    const normalized = normalizeAiuiRecord(raw[i]);
    if (!normalized) return queueState(false, [], 'queue_corrupt');
    const hadId = !!normalized.id;
    const id = hadId ? normalized.id : uniqueLegacyId(normalized, usedIds, i);
    if (usedIds.has(id)) return queueState(false, [], 'duplicate_id');
    usedIds.add(id);
    clean.push(hadId ? normalized : { ...normalized, id });
  }

  // Persist the stable ID migration only when it can be read back exactly.
  // A no-op/quota failure leaves the legacy evidence untouched and reports an
  // unknown state so enqueue/ACK cannot overwrite it.
  if (JSON.stringify(clean) !== JSON.stringify(raw)) {
    if (typeof storage.setStorageSync !== 'function') {
      return queueState(false, [], 'migration_write_unavailable');
    }
    try {
      storage.setStorageSync(PENDING_AIUI_RECORDS_KEY, clean);
      const roundTrip = storage.getStorageSync(PENDING_AIUI_RECORDS_KEY);
      if (JSON.stringify(roundTrip) !== JSON.stringify(clean)) {
        return queueState(false, [], 'migration_readback_failed');
      }
    } catch (_e) {
      return queueState(false, [], 'migration_write_failed');
    }
  }
  return queueState(true, clean, 'verified');
}

/** Display-only compatibility view. Mutating callers use the stateful form. */
export function readPendingAiuiRecords(storage) {
  return readPendingAiuiRecordsState(storage).items;
}

export function writePendingAiuiRecords(storage, list) {
  if (!Array.isArray(list) || list.length > PENDING_AIUI_RECORDS_MAX) return null;
  const before = readPendingAiuiRecordsState(storage);
  if (!before.ok) return null;
  const clean = [];
  const usedIds = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const normalized = normalizeAiuiRecord(list[i]);
    if (!normalized) return null;
    const id = normalized.id || uniqueLegacyId(normalized, usedIds, i);
    if (usedIds.has(id)) return null;
    usedIds.add(id);
    clean.push(normalized.id ? normalized : { ...normalized, id });
  }
  try {
    if (clean.length && typeof storage.setStorageSync === 'function') {
      storage.setStorageSync(PENDING_AIUI_RECORDS_KEY, clean);
    } else if (!clean.length && typeof storage.removeStorageSync === 'function') {
      storage.removeStorageSync(PENDING_AIUI_RECORDS_KEY);
    } else {
      return null;
    }
    const roundTrip = readPendingAiuiRecordsState(storage);
    return roundTrip.ok && JSON.stringify(roundTrip.items) === JSON.stringify(clean)
      ? clean : null;
  } catch (_e) {
    return null;
  }
}

export function enqueueAiuiRecord(storage, value) {
  const state = readPendingAiuiRecordsState(storage);
  if (!state.ok) return null;
  const normalized = normalizeAiuiRecord(value);
  const current = state.items;
  if (!normalized) return current;
  const record = normalized.id
    ? normalized : { ...normalized, id: newRecordId(normalized) };
  const withoutSameId = current.filter((item) => item.id !== record.id);
  const next = [...withoutSameId, record].slice(-PENDING_AIUI_RECORDS_MAX);
  return writePendingAiuiRecords(storage, next);
}

/**
 * Remove one acknowledged item from a freshly-read queue.
 * Re-reading is intentional: a summary can be enqueued while a network request
 * is in flight, and writing an old snapshot would otherwise erase the new item.
 */
export function removePendingAiuiRecord(storage, value) {
  const state = readPendingAiuiRecordsState(storage);
  if (!state.ok) return null;
  const target = normalizeAiuiRecord(value);
  const current = state.items;
  if (!target || !current.length) return current;
  let index = -1;
  if (target.id) index = current.findIndex((item) => item.id === target.id);
  if (index < 0) {
    index = current.findIndex((item) => item.question === target.question
      && item.reply === target.reply
      && item.source === target.source
      && Number(item.createdAtMs || 0) === Number(target.createdAtMs || 0));
  }
  if (index < 0) return current;
  const next = [...current.slice(0, index), ...current.slice(index + 1)];
  return writePendingAiuiRecords(storage, next);
}

export function clearPendingAiuiRecords(storage) {
  return writePendingAiuiRecords(storage, []);
}
