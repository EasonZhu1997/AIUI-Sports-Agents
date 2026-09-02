import {
  averageSpeedKmh,
  formatCadenceRpm,
  formatDistanceKm,
  formatElapsed,
  formatPowerW,
  formatSpeedKmh,
} from './ride_format.js';

export const LAST_RIDE_SUMMARY_KEY = 'aibike_last_ride_summary_v1';
export const RIDE_SUMMARY_MAX_CHARS = 52;

const ALLOWED_SUMMARY_SOURCES = Object.freeze([
  'hrs',
  'csc',
  'cps',
  'ftms',
  'imu',
  'cadence_model',
]);

function nonNegative(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function positive(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function atLeast(value, minimum) {
  const numeric = positive(value);
  return numeric != null && numeric >= minimum ? numeric : null;
}

function normalizedSources(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (let index = 0; index < value.length && result.length < 8; index += 1) {
    const source = typeof value[index] === 'string'
      ? value[index].trim().toLowerCase() : '';
    if (ALLOWED_SUMMARY_SOURCES.includes(source)
        && !result.includes(source)) {
      result.push(source);
    }
  }
  return result;
}

export function normalizeRideSummary(value) {
  const source = value && typeof value === 'object' ? value : {};
  const elapsedMs = positive(source.elapsedMs);
  if (elapsedMs == null) return null;

  const distanceM = nonNegative(source.distanceM) ?? 0;
  const movingMs = nonNegative(source.movingMs) ?? elapsedMs;
  const summary = {
    elapsedMs,
    movingMs: Math.min(elapsedMs, movingMs),
    distanceM,
    avgSpeedKmh: positive(source.avgSpeedKmh)
      ?? averageSpeedKmh(distanceM, movingMs),
    maxSpeedKmh: positive(source.maxSpeedKmh),
    avgCadenceRpm: positive(source.avgCadenceRpm),
    maxCadenceRpm: positive(source.maxCadenceRpm),
    avgBpm: positive(source.avgBpm),
    maxBpm: positive(source.maxBpm),
    avgPowerW: positive(source.avgPowerW),
    maxPowerW: positive(source.maxPowerW),
    endedAtMs: positive(source.endedAtMs) ?? Date.now(),
  };

  const sources = normalizedSources(source.sources);
  const distanceSources = normalizedSources(source.distanceSources);
  const cadenceSources = normalizedSources(source.cadenceSources);
  if (sources.length) summary.sources = sources;
  if (distanceSources.length) summary.distanceSources = distanceSources;
  if (cadenceSources.length) summary.cadenceSources = cadenceSources;
  return summary;
}

export function writeLastRideSummary(storage, value) {
  const summary = normalizeRideSummary(value);
  if (!summary
      || !storage
      || typeof storage.setStorageSync !== 'function'
      || typeof storage.getStorageSync !== 'function') return null;
  try {
    storage.setStorageSync(LAST_RIDE_SUMMARY_KEY, summary);
    const roundTrip = readLastRideSummary(storage);
    return roundTrip
      && JSON.stringify(roundTrip) === JSON.stringify(summary)
      ? roundTrip : null;
  } catch (_error) {
    return null;
  }
}

export function readLastRideSummary(storage) {
  if (!storage || typeof storage.getStorageSync !== 'function') return null;
  try {
    return normalizeRideSummary(storage.getStorageSync(LAST_RIDE_SUMMARY_KEY));
  } catch (_error) {
    return null;
  }
}

export function clearLastRideSummary(storage) {
  try {
    if (storage && typeof storage.removeStorageSync === 'function') {
      storage.removeStorageSync(LAST_RIDE_SUMMARY_KEY);
    }
  } catch (_error) {}
}

export function formatRideStats(value) {
  const summary = normalizeRideSummary(value);
  if (!summary) return '';
  const parts = [
    `骑行 ${formatElapsed(summary.elapsedMs)}`,
    summary.distanceM >= 5
      ? `距离 ${formatDistanceKm(summary.distanceM)} 公里`
      : (summary.distanceM > 0 ? '距离很短' : '距离未形成'),
  ];
  if (atLeast(summary.avgSpeedKmh, 0.05) != null) {
    parts.push(`均速 ${formatSpeedKmh(summary.avgSpeedKmh)} 公里/时`);
  }
  if (atLeast(summary.avgCadenceRpm, 0.5) != null) {
    parts.push(`平均踏频 ${formatCadenceRpm(summary.avgCadenceRpm)} RPM`);
  }
  if (atLeast(summary.avgPowerW, 0.5) != null) {
    parts.push(`平均功率 ${formatPowerW(summary.avgPowerW)} W`);
  }
  if (atLeast(summary.avgBpm, 20) != null) {
    parts.push(`平均心率 ${Math.round(summary.avgBpm)}`);
  }
  return parts.join('，');
}

export function fallbackRideSummary(value) {
  const summary = normalizeRideSummary(value);
  if (!summary) return '';
  let advice = '数据源不足，本次以计时为主。';
  if (atLeast(summary.avgPowerW, 0.5) != null) {
    advice = '功率输出稳定，注意补水与恢复。';
  } else if (summary.avgCadenceRpm != null) {
    if (summary.avgCadenceRpm < 70) advice = '踏频偏低，可适当减档。';
    else if (summary.avgCadenceRpm > 105) advice = '踏频较高，保持动作放松。';
    else advice = '踏频处于常用耐力区间。';
  } else if (summary.avgBpm != null) {
    advice = summary.avgBpm >= 160
      ? '心率偏高，下一段注意降强度。'
      : '心率节奏平稳。';
  }
  const headline = summary.distanceM >= 5
    ? `本次骑行 ${formatDistanceKm(summary.distanceM)} 公里`
      + (atLeast(summary.avgSpeedKmh, 0.05) != null
        ? `，均速 ${formatSpeedKmh(summary.avgSpeedKmh)}` : '')
    : `本次骑行 ${formatElapsed(summary.elapsedMs)}`;
  const sourceList = Array.isArray(summary.sources) ? summary.sources : [];
  const distanceSourceList = Array.isArray(summary.distanceSources)
    ? summary.distanceSources : sourceList;
  const cadenceSourceList = Array.isArray(summary.cadenceSources)
    ? summary.cadenceSources : sourceList;
  const hasImuEstimate = distanceSourceList.includes('imu')
    || cadenceSourceList.includes('imu')
    || distanceSourceList.includes('cadence_model')
    || cadenceSourceList.includes('cadence_model');
  const estimateNote = hasImuEstimate
    ? '眼镜IMU估算，换挡与滑行可能少计。' : '';
  return compactRideSummary(`${headline}。${advice}${estimateNote}`);
}

export function compactRideSummary(text, maxChars = RIDE_SUMMARY_MAX_CHARS) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}
