import {
  ROWER_DISTANCE_SOURCE,
  ROWER_MODE,
  ROWER_SUMMARY_SCHEMA_VERSION,
  buildRowerSummary,
} from './rower_summary.js';

// This key is intentionally distinct from the legacy unversioned array key.
export const ROWER_HISTORY_KEY = 'aismartrower_indoor_history_v1';
export const ROWER_HISTORY_SCHEMA_VERSION = 1;
export const ROWER_MAX_HISTORY = 20;

const OPTIONAL_NUMERIC_BOUNDS = Object.freeze({
  averageSplitSecPer500m: [1, 0xfffe],
  averageStrokeRateSpm: [0, 127.5],
  maxStrokeRateSpm: [0, 127.5],
  averagePowerW: [-1000, 3000],
  maxPowerW: [-1000, 3000],
  averageHeartRateBpm: [20, 240],
  maxHeartRateBpm: [20, 240],
});

const COVERAGE_FIELDS = Object.freeze([
  'ftmsCoveragePct',
  'distanceCoveragePct',
  'strokeCountCoveragePct',
  'strokeRateCoveragePct',
  'splitCoveragePct',
  'powerCoveragePct',
  'heartRateCoveragePct',
  'independentHrsCoveragePct',
  'ftmsHeartRateCoveragePct',
]);

const HEART_RATE_SOURCES = new Set([
  'independent_hrs',
  'ftms',
  'mixed',
  'partial',
  'unavailable',
]);

function nonNegativeFinite(value) {
  return Number.isFinite(value)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER;
}

function deepEqualJson(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)
        || left.length !== right.length) return false;
    return left.every((item, index) => deepEqualJson(item, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length
      || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => deepEqualJson(left[key], right[key]));
}

function validMinuteSeries(value) {
  if (value == null) return true;
  if (!Array.isArray(value) || value.length > 30) return false;
  let previousMinute = 0;
  for (const point of value) {
    if (!point || typeof point !== 'object' || Array.isArray(point)
        || Object.keys(point).sort().join(',') !== 'minute,value'
        || !Number.isInteger(point.minute) || point.minute <= previousMinute
        || !Number.isFinite(point.value)
        || point.value < 1 || point.value > 0xfffe) return false;
    previousMinute = point.minute;
  }
  return true;
}

function validOptionalNumbers(value) {
  return Object.keys(OPTIONAL_NUMERIC_BOUNDS).every((name) => {
    if (value[name] == null) return true;
    const [minimum, maximum] = OPTIONAL_NUMERIC_BOUNDS[name];
    return Number.isFinite(value[name])
      && value[name] >= minimum
      && value[name] <= maximum;
  });
}

function validCoverage(value) {
  return COVERAGE_FIELDS.every((name) => (
    value[name] == null
    || (Number.isFinite(value[name]) && value[name] >= 0 && value[name] <= 100)
  ));
}

/**
 * Canonicalizes only allowlisted aggregate fields. Unknown input, including
 * raw packets and device identity, is omitted from the returned summary.
 */
export function normalizeRowerSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schemaVersion !== ROWER_SUMMARY_SCHEMA_VERSION
      || value.mode !== ROWER_MODE
      || typeof value.sessionId !== 'string' || !value.sessionId.trim()
      || !nonNegativeFinite(value.startedAtMs)
      || !nonNegativeFinite(value.finishedAtMs)
      || !nonNegativeFinite(value.elapsedMs)
      || !nonNegativeFinite(value.distanceM)
      || !Number.isSafeInteger(value.strokeCount) || value.strokeCount < 0
      || value.finishedAtMs < value.startedAtMs
      || !validOptionalNumbers(value)
      || !validCoverage(value)
      || !validMinuteSeries(value.minuteSplitSeries)) return null;

  if (value.distanceEvidence != null
      && value.distanceEvidence !== 'unavailable'
      && value.distanceEvidence !== 'stationary'
      && value.distanceEvidence !== 'measured') return null;
  if (value.heartRateSource != null
      && !HEART_RATE_SOURCES.has(value.heartRateSource)) return null;
  if (value.sensorSources != null
      && (!Array.isArray(value.sensorSources)
        || (value.sensorSources.join(',') !== 'ftms'
          && value.sensorSources.join(',') !== 'ftms,independent_hrs'))) return null;

  const normalized = buildRowerSummary(value);
  if (value.sensorSources != null
      && value.sensorSources.join(',') !== normalized.sensorSources.join(',')) return null;
  if (value.heartRateSource != null
      && value.heartRateSource !== normalized.heartRateSource) return null;
  if (value.distanceEvidence != null
      && value.distanceEvidence !== normalized.distanceEvidence) return null;
  if (value.distanceSource != null
      && value.distanceSource !== normalized.distanceSource) return null;
  if (normalized.distanceEvidence === 'unavailable'
      && normalized.distanceSource !== 'unavailable') return null;
  if (normalized.distanceEvidence !== 'unavailable'
      && normalized.distanceSource !== ROWER_DISTANCE_SOURCE) return null;
  if (normalized.ftmsCoveragePct < Math.max(
    normalized.distanceCoveragePct,
    normalized.strokeCountCoveragePct,
    normalized.strokeRateCoveragePct,
    normalized.splitCoveragePct,
    normalized.powerCoveragePct,
  )) return null;
  if (normalized.independentHrsCoveragePct > normalized.heartRateCoveragePct
      || normalized.ftmsHeartRateCoveragePct > normalized.heartRateCoveragePct) {
    return null;
  }
  const hasIndependentHrs = normalized.independentHrsCoveragePct > 0;
  if (hasIndependentHrs
      !== normalized.sensorSources.includes('independent_hrs')) return null;
  if (normalized.heartRateCoveragePct === 0
      && normalized.heartRateSource !== 'unavailable') return null;
  if (normalized.heartRateCoveragePct > 0
      && normalized.heartRateSource === 'unavailable') return null;
  if (normalized.heartRateSource === 'independent_hrs'
      && normalized.independentHrsCoveragePct <= 0) return null;
  if (normalized.heartRateSource === 'ftms'
      && normalized.ftmsHeartRateCoveragePct <= 0) return null;
  if (normalized.heartRateSource === 'mixed'
      && (normalized.independentHrsCoveragePct <= 0
        || normalized.ftmsHeartRateCoveragePct <= 0)) return null;
  if ((normalized.splitCoveragePct > 0)
      !== (normalized.averageSplitSecPer500m != null)) return null;
  if ((normalized.strokeRateCoveragePct > 0)
      !== (normalized.averageStrokeRateSpm != null
        && normalized.maxStrokeRateSpm != null)) return null;
  if ((normalized.powerCoveragePct > 0)
      !== (normalized.averagePowerW != null && normalized.maxPowerW != null)) {
    return null;
  }
  if ((normalized.heartRateCoveragePct > 0)
      !== (normalized.averageHeartRateBpm != null
        && normalized.maxHeartRateBpm != null)) return null;
  if (normalized.maxStrokeRateSpm != null
      && normalized.maxStrokeRateSpm < normalized.averageStrokeRateSpm) return null;
  if (normalized.maxPowerW != null
      && normalized.maxPowerW < normalized.averagePowerW) return null;
  if (normalized.maxHeartRateBpm != null
      && normalized.maxHeartRateBpm < normalized.averageHeartRateBpm) return null;
  return normalized;
}

function corrupt(reason) {
  return {
    ok: false,
    format: 'corrupt',
    history: [],
    reason,
  };
}

function normalizeItems(value) {
  if (!Array.isArray(value) || value.length > ROWER_MAX_HISTORY) return null;
  const normalized = [];
  const sessionIds = new Set();
  for (const item of value) {
    const summary = normalizeRowerSummary(item);
    if (!summary
        || sessionIds.has(summary.sessionId)
        || !deepEqualJson(item, summary)) return null;
    sessionIds.add(summary.sessionId);
    normalized.push(summary);
  }
  return normalized;
}

export function readRowerHistoryResult(storage) {
  try {
    const value = storage.getStorageSync(ROWER_HISTORY_KEY);
    if (value == null) {
      return { ok: true, format: 'empty', history: [] };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.schemaVersion !== ROWER_HISTORY_SCHEMA_VERSION
        || !Array.isArray(value.summaries)) {
      return corrupt('unknown_history_format');
    }
    const history = normalizeItems(value.summaries);
    if (!history) return corrupt('invalid_history');
    const canonical = {
      schemaVersion: ROWER_HISTORY_SCHEMA_VERSION,
      summaries: history,
    };
    if (!deepEqualJson(value, canonical)) {
      return corrupt('noncanonical_history');
    }
    return { ok: true, format: 'v1', history };
  } catch (_error) {
    return {
      ok: false,
      format: 'error',
      history: [],
      reason: 'history_read_failed',
    };
  }
}

export function loadRowerHistory(storage) {
  const result = readRowerHistoryResult(storage);
  return result.ok ? result.history : [];
}

export function saveRowerHistorySummary(storage, summary) {
  const normalized = normalizeRowerSummary(summary);
  if (!normalized) return false;
  const baseline = readRowerHistoryResult(storage);
  if (!baseline.ok) return false;
  try {
    const envelope = {
      schemaVersion: ROWER_HISTORY_SCHEMA_VERSION,
      summaries: [
        normalized,
        ...baseline.history.filter(
          (item) => item.sessionId !== normalized.sessionId,
        ),
      ].slice(0, ROWER_MAX_HISTORY),
    };
    const expectedEnvelope = JSON.parse(JSON.stringify(envelope));
    storage.setStorageSync(ROWER_HISTORY_KEY, envelope);
    const persisted = storage.getStorageSync(ROWER_HISTORY_KEY);
    return deepEqualJson(persisted, expectedEnvelope);
  } catch (_error) {
    return false;
  }
}

// Compatibility aliases retained for reviewed implementation vocabulary.
export const INDOOR_ROWER_HISTORY_KEY = ROWER_HISTORY_KEY;
export const INDOOR_ROWER_HISTORY_SCHEMA_VERSION = ROWER_HISTORY_SCHEMA_VERSION;
export const INDOOR_ROWER_MAX_HISTORY = ROWER_MAX_HISTORY;
export const normalizeIndoorRowerSummary = normalizeRowerSummary;
export const readIndoorRowerHistoryResult = readRowerHistoryResult;
export const loadIndoorRowerHistory = loadRowerHistory;
export const saveIndoorRowerSummary = saveRowerHistorySummary;
