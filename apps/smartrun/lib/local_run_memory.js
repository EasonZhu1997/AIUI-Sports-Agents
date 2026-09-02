// Small, app-local running memory for AIUI.
//
// The records intentionally contain only aggregate run summaries. They can be
// used as prompt context while the remote memory backend is unavailable, and
// remain bounded so a long-lived glasses installation cannot grow storage
// without limit.

export const LOCAL_RUN_MEMORIES_KEY = 'local_run_memories';
export const LOCAL_RUN_MEMORIES_MAX = 5;

const DEFAULT_CONTEXT_ITEMS = 3;
const DEFAULT_CONTEXT_CHARS = 240;
const MAX_SUMMARY_CHARS = 160;

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function compactText(value, max = MAX_SUMMARY_CHARS) {
  return typeof value === 'string'
    ? value.replace(/[\r\n\[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

function firstText(source, keys) {
  for (const key of keys) {
    const text = compactText(source[key]);
    if (text) return text;
  }
  return '';
}

function firstPositive(source, keys) {
  for (const key of keys) {
    const value = finitePositive(source[key]);
    if (value > 0) return value;
  }
  return 0;
}

function parseTime(value) {
  const direct = finitePositive(value);
  if (direct > 0) return Math.round(direct);
  if (typeof value !== 'string' || !value.trim()) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizedMode(value) {
  const mode = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (['garmin-virtual', 'virtual', 'virtual-run'].includes(mode)) return 'garmin_virtual';
  return ['slow', 'slow-jog', 'super-slow', 'superslow'].includes(mode) ? 'slow' : 'free';
}

/**
 * Normalize current AIUI summaries and common snake_case / bilingual fields.
 * Unknown properties are discarded so storage remains compact and predictable.
 */
export function normalizeLocalRunMemory(value, fallbackEndedAtMs = 0) {
  const src = value && typeof value === 'object' ? value : {};
  const textZh = firstText(src, [
    'textZh', 'text_zh', 'summaryZh', 'summary_zh', 'aiSummaryZh', 'ai_summary_zh',
  ]);
  const textEn = firstText(src, [
    'textEn', 'text_en', 'summaryEn', 'summary_en', 'aiSummaryEn', 'ai_summary_en',
  ]);
  const text = firstText(src, [
    'text', 'summary', 'summaryText', 'summary_text', 'aiSummary', 'ai_summary',
    'reply', 'review',
  ]);
  const elapsedMs = firstPositive(src, ['elapsedMs', 'durationMs', 'duration_ms'])
    || firstPositive(src, ['duration_s', 'durationSec', 'durationSeconds']) * 1000;
  const endedAtMs = parseTime(src.endedAtMs)
    || parseTime(src.endMs)
    || parseTime(src.ended_at)
    || parseTime(src.endedAt)
    || parseTime(fallbackEndedAtMs);
  const record = {
    mode: normalizedMode(src.mode || src.workoutType || src.workout_type),
    endedAtMs,
    elapsedMs: Math.round(elapsedMs),
  };

  if (text) record.text = text;
  if (textZh) record.textZh = textZh;
  if (textEn) record.textEn = textEn;

  const metrics = [
    ['distanceM', firstPositive(src, ['distanceM', 'distance_m'])],
    ['avgPaceSecPerKm', firstPositive(src, ['avgPaceSecPerKm', 'avg_pace_s'])],
    ['avgBpm', firstPositive(src, ['avgBpm', 'avg_hr'])],
    ['avgCadenceSpm', firstPositive(src, ['avgCadenceSpm', 'cadence_avg'])],
    ['steps', firstPositive(src, ['steps', 'stepCount', 'step_count'])],
  ];
  for (const [key, metric] of metrics) {
    if (metric > 0) record[key] = Math.round(metric * 100) / 100;
  }

  // A completed run needs either elapsed time or a human-readable summary.
  if (!(record.elapsedMs > 0) && !record.text && !record.textZh && !record.textEn) return null;
  return record;
}

function memoryIdentity(record) {
  return [
    record.endedAtMs || 0,
    record.mode,
    record.elapsedMs || 0,
    record.text || record.textZh || record.textEn || '',
  ].join('|');
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  const byIdentity = new Map();
  for (const item of value) {
    const normalized = normalizeLocalRunMemory(item);
    if (normalized) byIdentity.set(memoryIdentity(normalized), normalized);
  }
  return Array.from(byIdentity.values())
    .sort((a, b) => (a.endedAtMs || 0) - (b.endedAtMs || 0))
    .slice(-LOCAL_RUN_MEMORIES_MAX);
}

function memoryState(ok, items, reason = '') {
  return Object.freeze({ ok, items: Object.freeze(items), reason });
}

function missingStorageValue(value) {
  // wx.getStorageSync() uses an empty string for a missing key on some hosts.
  return value === '' || value === undefined || value === null;
}

/**
 * Stateful durable read used before every mutation. It deliberately separates
 * a verified empty key from an unreadable/corrupt value so a later enqueue can
 * never overwrite evidence it failed to inspect.
 */
export function readLocalRunMemoriesState(storage) {
  if (!storage || typeof storage.getStorageSync !== 'function') {
    return memoryState(false, [], 'storage_unavailable');
  }
  let raw;
  try {
    raw = storage.getStorageSync(LOCAL_RUN_MEMORIES_KEY);
  } catch (_e) {
    return memoryState(false, [], 'storage_read_failed');
  }
  if (missingStorageValue(raw)) return memoryState(true, [], 'empty');
  if (!Array.isArray(raw)) return memoryState(false, [], 'memory_corrupt');
  if (raw.length > LOCAL_RUN_MEMORIES_MAX) {
    return memoryState(false, [], 'memory_overflow');
  }
  const normalized = raw.map((item) => normalizeLocalRunMemory(item));
  if (normalized.some((item) => !item)) {
    return memoryState(false, [], 'memory_corrupt');
  }
  const identities = new Set(normalized.map(memoryIdentity));
  if (identities.size !== normalized.length) {
    return memoryState(false, [], 'memory_duplicate');
  }
  return memoryState(true, normalizeList(normalized), 'verified');
}

/** Display-only compatibility view. Storage failures still degrade to []. */
export function read(storage) {
  return readLocalRunMemoriesState(storage).items;
}

/** Add one completed summary, deduplicate it, and keep only the newest five. */
export function enqueue(storage, value, nowMs = Date.now()) {
  const state = readLocalRunMemoriesState(storage);
  if (!state.ok) return null;
  const record = normalizeLocalRunMemory(value, nowMs);
  const current = state.items;
  if (!record) return current;
  const next = normalizeList([...current, record]);
  try {
    if (storage && typeof storage.setStorageSync === 'function'
        && typeof storage.getStorageSync === 'function') {
      storage.setStorageSync(LOCAL_RUN_MEMORIES_KEY, next);
      const roundTrip = readLocalRunMemoriesState(storage);
      return roundTrip.ok && JSON.stringify(roundTrip.items) === JSON.stringify(next)
        ? next : null;
    }
  } catch (_e) {
    return null;
  }
  return null;
}

/** Remove all local summaries. Storage failures are intentionally non-fatal. */
export function clear(storage) {
  try {
    if (storage && typeof storage.removeStorageSync === 'function') {
      storage.removeStorageSync(LOCAL_RUN_MEMORIES_KEY);
    }
  } catch (_e) {}
  return [];
}

function summaryForLanguage(record, language) {
  const lang = String(language || '').toLowerCase();
  if (lang.startsWith('en')) return record.textEn || record.text || record.textZh || '';
  if (lang.startsWith('zh')) return record.textZh || record.text || record.textEn || '';
  return record.text || record.textZh || record.textEn || '';
}

function metricFallback(record) {
  const parts = [record.mode === 'slow'
    ? 'slow-jog'
    : (record.mode === 'garmin_virtual' ? 'garmin-virtual-run' : 'free-run')];
  if (record.elapsedMs > 0) parts.push(Math.max(1, Math.round(record.elapsedMs / 60000)) + 'min');
  if (record.distanceM > 0) parts.push((record.distanceM / 1000).toFixed(2) + 'km');
  if (record.steps > 0) parts.push(Math.round(record.steps) + 'steps');
  if (record.avgBpm > 0) parts.push('HR' + Math.round(record.avgBpm));
  if (record.avgCadenceSpm > 0) parts.push('cadence' + Math.round(record.avgCadenceSpm));
  return parts.join(' ');
}

/**
 * Build a short, recent-first prompt fragment.
 * `source` can be the array returned by read() or a wx-like storage object.
 */
export function buildContext(source, options = {}) {
  const records = Array.isArray(source) ? normalizeList(source) : read(source);
  const requestedItems = Math.round(Number(options.maxItems));
  const maxItems = Number.isFinite(requestedItems) && requestedItems > 0
    ? Math.min(requestedItems, LOCAL_RUN_MEMORIES_MAX) : DEFAULT_CONTEXT_ITEMS;
  const requestedChars = Math.round(Number(options.maxChars));
  const maxChars = Number.isFinite(requestedChars) && requestedChars > 0
    ? requestedChars : DEFAULT_CONTEXT_CHARS;
  const recent = records.slice(-maxItems).reverse();
  const parts = recent
    .map((record) => summaryForLanguage(record, options.language || options.lang)
      || metricFallback(record))
    .filter(Boolean);
  if (!parts.length) return '';
  return parts.join(' | ').slice(0, maxChars).trim();
}

// Descriptive aliases are convenient at call sites while the short names keep
// the module's read/enqueue/clear/buildContext contract explicit.
export const readLocalRunMemories = read;
export const enqueueLocalRunMemory = enqueue;
export const clearLocalRunMemories = clear;
export const buildLocalRunMemoryContext = buildContext;
