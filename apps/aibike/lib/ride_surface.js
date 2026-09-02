export const HOST_BACKSPACE_SOURCE_KEY = 'aibike_host_backspace_source';
export const RIDE_FINISHED_HINT_KEY = 'aibike_ride_finished_at';
export const SCAN_EXIT_HINT_KEY = 'aibike_scan_exit_at';

function safeSet(storage, key, value) {
  try {
    if (storage && typeof storage.setStorageSync === 'function') {
      storage.setStorageSync(key, value);
      return true;
    }
  } catch (_error) {}
  return false;
}

function safeSetAndVerify(storage, key, value) {
  if (!safeSet(storage, key, value)) return false;
  try {
    if (storage && typeof storage.getStorageSync === 'function') {
      if (storage.getStorageSync(key) === value) return true;
    }
  } catch (_error) {}
  safeRemove(storage, key);
  return false;
}

function safeRemove(storage, key) {
  try {
    if (storage && typeof storage.removeStorageSync === 'function') {
      storage.removeStorageSync(key);
    }
  } catch (_error) {}
}

export function markHostBackspaceIntent(storage, source) {
  if (!source || typeof source !== 'string') return false;
  safeSet(storage, HOST_BACKSPACE_SOURCE_KEY, source);
  return true;
}

export function beginInternalSurfaceNavigation(storage) {
  safeRemove(storage, HOST_BACKSPACE_SOURCE_KEY);
}

export function completeHomeResume(storage) {
  safeRemove(storage, HOST_BACKSPACE_SOURCE_KEY);
}

export function writeRideFinishedHint(storage, nowMs = Date.now()) {
  return safeSetAndVerify(storage, RIDE_FINISHED_HINT_KEY, String(nowMs));
}

export function clearRideFinishedHint(storage) {
  safeRemove(storage, RIDE_FINISHED_HINT_KEY);
}

export function writeScanExitHint(storage, nowMs = Date.now()) {
  safeSet(storage, SCAN_EXIT_HINT_KEY, String(nowMs));
}

function consumeFreshHint(storage, key, maxAgeMs, nowMs) {
  let raw = '';
  try {
    if (storage && typeof storage.getStorageSync === 'function') {
      raw = storage.getStorageSync(key) || '';
    }
  } catch (_error) {}
  safeRemove(storage, key);
  const writtenAtMs = Number(raw);
  return Number.isFinite(writtenAtMs)
    && writtenAtMs > 0
    && nowMs - writtenAtMs >= 0
    && nowMs - writtenAtMs <= maxAgeMs;
}

export function consumeRideFinishedHint(
  storage,
  maxAgeMs = 60000,
  nowMs = Date.now(),
) {
  return consumeFreshHint(storage, RIDE_FINISHED_HINT_KEY, maxAgeMs, nowMs);
}

export function consumeScanExitHint(
  storage,
  maxAgeMs = 3000,
  nowMs = Date.now(),
) {
  return consumeFreshHint(storage, SCAN_EXIT_HINT_KEY, maxAgeMs, nowMs);
}
