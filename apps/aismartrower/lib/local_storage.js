export const ROWER_SETTINGS_KEY = 'aismartrower_settings_v1';
export const ROWER_HISTORY_KEY = 'aismartrower_history_v1';

export const DEFAULT_SETTINGS = Object.freeze({ voiceEnabled: true, cooldownEnabled: true });

export function loadRowerSettings(storage) {
  try {
    const raw = storage.getStorageSync(ROWER_SETTINGS_KEY) || {};
    return { voiceEnabled: raw.voiceEnabled !== false, cooldownEnabled: raw.cooldownEnabled !== false };
  } catch (_error) { return { ...DEFAULT_SETTINGS }; }
}

export function saveRowerSettings(storage, settings) {
  const value = { voiceEnabled: settings.voiceEnabled !== false, cooldownEnabled: settings.cooldownEnabled !== false };
  try {
    storage.setStorageSync(ROWER_SETTINGS_KEY, value);
    return JSON.stringify(storage.getStorageSync(ROWER_SETTINGS_KEY)) === JSON.stringify(value);
  } catch (_error) { return false; }
}

export function saveRowerSummary(storage, summary) {
  if (!summary || typeof summary !== 'object') return false;
  const safe = {
    schemaVersion: 1,
    finishedAtMs: Number(summary.finishedAtMs) || Date.now(),
    durationSec: Math.max(0, Math.round(Number(summary.durationSec) || 0)),
    distanceM: Math.max(0, Math.round(Number(summary.distanceM) || 0)),
    splitSecPer500m: Number.isFinite(summary.splitSecPer500m) ? summary.splitSecPer500m : null,
    avgStrokeRateSpm: Number.isFinite(summary.avgStrokeRateSpm) ? summary.avgStrokeRateSpm : null,
    avgPowerW: Number.isFinite(summary.avgPowerW) ? summary.avgPowerW : null,
    avgHeartRateBpm: Number.isFinite(summary.avgHeartRateBpm) ? summary.avgHeartRateBpm : null,
  };
  try {
    const current = storage.getStorageSync(ROWER_HISTORY_KEY);
    const list = Array.isArray(current) ? current : [];
    const next = [...list, safe].slice(-10);
    storage.setStorageSync(ROWER_HISTORY_KEY, next);
    return JSON.stringify(storage.getStorageSync(ROWER_HISTORY_KEY)) === JSON.stringify(next);
  } catch (_error) { return false; }
}
