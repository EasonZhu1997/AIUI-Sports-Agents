// AIBike 本地聚合骑行历史。
//
// 隐私边界：
// - 只保存完成骑行后的聚合统计与有限来源枚举；
// - 经纬度、轨迹、原始 IMU/BLE、设备名称/ID、账号与测试 ride id 均无入口；
// - 趋势只描述本地样本，不把不同路线间的速度变化称为训练提升。

import {
  MIN_DISTANCE_DISPLAY_M,
  formatDistanceKm,
} from './ride_format.js';

export const RIDE_HISTORY_KEY = 'aibike_ride_history_v1';
export const RIDE_HISTORY_SCHEMA_VERSION = 1;
export const RIDE_HISTORY_MAX_ENTRIES = 20;
export const RIDE_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const RIDE_HISTORY_MIN_TREND_SAMPLES = 4;
export const RIDE_HISTORY_PERSIST_STATUS = Object.freeze({
  PERSISTED: 'persisted',
  INVALID_SUMMARY: 'invalid_summary',
  READ_FAILED: 'read_failed',
  WRITE_FAILED: 'write_failed',
  VERIFICATION_FAILED: 'verification_failed',
});

const MIN_EPOCH_MS = 946684800000;   // 2000-01-01
const MAX_EPOCH_MS = 4102444800000;  // 2100-01-01
const MAX_RIDE_ELAPSED_MS = 48 * 60 * 60 * 1000;
const ALLOWED_SOURCES = Object.freeze([
  'hrs',
  'csc',
  'cps',
  'ftms',
  'imu',
]);

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function numberInRange(value, min, max) {
  const numeric = finite(value);
  return numeric != null && numeric >= min && numeric <= max
    ? numeric : null;
}

function positiveInRange(value, min, max) {
  const numeric = numberInRange(value, min, max);
  return numeric != null && numeric > 0 ? numeric : null;
}

function normalizedSources(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (let index = 0; index < value.length && result.length < 6; index += 1) {
    const source = typeof value[index] === 'string'
      ? value[index].trim().toLowerCase() : '';
    if (ALLOWED_SOURCES.includes(source) && !result.includes(source)) {
      result.push(source);
    }
  }
  return result;
}

/**
 * 严格聚合条目白名单。endedAtMs 与 elapsedMs 缺失时拒绝该场，
 * 避免无法归属日期的记录污染 7 天窗口。
 */
export function normalizeRideHistoryEntry(value) {
  const source = value && typeof value === 'object' ? value : {};
  const endedAtMs = numberInRange(source.endedAtMs, MIN_EPOCH_MS, MAX_EPOCH_MS);
  const elapsedMs = positiveInRange(
    source.elapsedMs,
    1,
    MAX_RIDE_ELAPSED_MS,
  );
  if (endedAtMs == null || elapsedMs == null) return null;

  const movingMs = numberInRange(
    source.movingMs,
    0,
    elapsedMs,
  ) ?? elapsedMs;
  const distanceM = numberInRange(source.distanceM, 0, 1000000) ?? 0;
  const entry = {
    endedAtMs: Math.round(endedAtMs),
    elapsedMs: Math.round(elapsedMs),
    movingMs: Math.round(movingMs),
    distanceM: Number(distanceM.toFixed(3)),
  };

  const optionalNumbers = [
    ['avgSpeedKmh', 0.01, 150, 3],
    ['maxSpeedKmh', 0.01, 150, 3],
    ['avgCadenceRpm', 0.01, 300, 2],
    ['maxCadenceRpm', 0.01, 300, 2],
    ['avgBpm', 20, 240, 1],
    ['maxBpm', 20, 240, 1],
    ['avgPowerW', 0.01, 5000, 1],
    ['maxPowerW', 0.01, 5000, 1],
  ];
  for (let index = 0; index < optionalNumbers.length; index += 1) {
    const [key, min, max, digits] = optionalNumbers[index];
    const numeric = numberInRange(source[key], min, max);
    if (numeric != null) entry[key] = Number(numeric.toFixed(digits));
  }

  const sources = normalizedSources(source.sources);
  const distanceSources = normalizedSources(source.distanceSources);
  const cadenceSources = normalizedSources(source.cadenceSources);
  if (sources.length) entry.sources = sources;
  if (distanceSources.length) entry.distanceSources = distanceSources;
  if (cadenceSources.length) entry.cadenceSources = cadenceSources;
  return entry;
}

function emptyHistory() {
  return {
    schemaVersion: RIDE_HISTORY_SCHEMA_VERSION,
    rides: [],
  };
}

/**
 * 归一化版本化存储。支持原型阶段的裸数组一次性迁移；
 * 未知对象版本安全返回空历史，不能猜测未来 schema。
 */
export function normalizeRideHistory(value) {
  let rides = null;
  if (Array.isArray(value)) {
    rides = value;
  } else if (value && typeof value === 'object'
      && Number(value.schemaVersion) === RIDE_HISTORY_SCHEMA_VERSION
      && Array.isArray(value.rides)) {
    rides = value.rides;
  }
  if (!rides) return emptyHistory();

  const normalized = [];
  const endedAtSeen = new Set();
  for (let index = 0; index < rides.length; index += 1) {
    const entry = normalizeRideHistoryEntry(rides[index]);
    if (!entry || endedAtSeen.has(entry.endedAtMs)) continue;
    endedAtSeen.add(entry.endedAtMs);
    normalized.push(entry);
  }
  normalized.sort((left, right) => right.endedAtMs - left.endedAtMs);
  return {
    schemaVersion: RIDE_HISTORY_SCHEMA_VERSION,
    rides: normalized.slice(0, RIDE_HISTORY_MAX_ENTRIES),
  };
}

/** 纯函数：追加或替换同一结束时间的聚合摘要，结果按最新在前保存。 */
export function appendRideHistory(history, summary) {
  const current = normalizeRideHistory(history);
  const entry = normalizeRideHistoryEntry(summary);
  if (!entry) return current;
  return normalizeRideHistory({
    schemaVersion: RIDE_HISTORY_SCHEMA_VERSION,
    rides: [
      entry,
      ...current.rides.filter((ride) => ride.endedAtMs !== entry.endedAtMs),
    ],
  });
}

export function readRideHistory(storage) {
  if (!storage || typeof storage.getStorageSync !== 'function') {
    return emptyHistory();
  }
  try {
    return normalizeRideHistory(storage.getStorageSync(RIDE_HISTORY_KEY));
  } catch (_error) {
    return emptyHistory();
  }
}

export function writeRideHistory(storage, history) {
  const normalized = normalizeRideHistory(history);
  try {
    if (storage && typeof storage.setStorageSync === 'function') {
      storage.setStorageSync(RIDE_HISTORY_KEY, normalized);
    }
  } catch (_error) {}
  return normalized;
}

function historiesEqual(left, right) {
  return JSON.stringify(normalizeRideHistory(left))
    === JSON.stringify(normalizeRideHistory(right));
}

function readRideHistoryResult(storage) {
  if (!storage || typeof storage.getStorageSync !== 'function') {
    return { ok: false, history: null };
  }
  try {
    return {
      ok: true,
      history: normalizeRideHistory(storage.getStorageSync(RIDE_HISTORY_KEY)),
    };
  } catch (_error) {
    return { ok: false, history: null };
  }
}

export function isRideHistoryPersisted(storage, history) {
  const readResult = readRideHistoryResult(storage);
  return readResult.ok && historiesEqual(readResult.history, history);
}

/**
 * 事务式保存骑行摘要。
 *
 * 只有 persisted=true 才代表已通过写后回读验证，页面才可显示
 * “本次已计入”。读取失败时绝不写回，避免把未知旧历史覆盖成单场记录。
 * history 始终是最后一次已确认的存储内容；attemptedHistory 仅供旧调用方
 * 保持返回值兼容，不能据此宣称持久化成功。
 */
export function persistRideHistorySummary(storage, summary) {
  const entry = normalizeRideHistoryEntry(summary);
  if (!entry) {
    return {
      status: RIDE_HISTORY_PERSIST_STATUS.INVALID_SUMMARY,
      persisted: false,
      changed: false,
      history: null,
      attemptedHistory: null,
    };
  }

  const readResult = readRideHistoryResult(storage);
  if (!readResult.ok) {
    return {
      status: RIDE_HISTORY_PERSIST_STATUS.READ_FAILED,
      persisted: false,
      changed: false,
      history: null,
      attemptedHistory: appendRideHistory(emptyHistory(), entry),
    };
  }

  const current = readResult.history;
  const next = appendRideHistory(current, entry);
  const changed = !historiesEqual(current, next);
  if (!storage || typeof storage.setStorageSync !== 'function') {
    return {
      status: RIDE_HISTORY_PERSIST_STATUS.WRITE_FAILED,
      persisted: false,
      changed,
      history: current,
      attemptedHistory: next,
    };
  }

  try {
    storage.setStorageSync(RIDE_HISTORY_KEY, next);
  } catch (_error) {
    return {
      status: RIDE_HISTORY_PERSIST_STATUS.WRITE_FAILED,
      persisted: false,
      changed,
      history: current,
      attemptedHistory: next,
    };
  }

  const verification = readRideHistoryResult(storage);
  if (!verification.ok || !historiesEqual(verification.history, next)) {
    return {
      status: RIDE_HISTORY_PERSIST_STATUS.VERIFICATION_FAILED,
      persisted: false,
      changed,
      history: verification.ok ? verification.history : current,
      attemptedHistory: next,
    };
  }
  return {
    status: RIDE_HISTORY_PERSIST_STATUS.PERSISTED,
    persisted: true,
    changed,
    history: verification.history,
    attemptedHistory: next,
  };
}

/**
 * 旧接口兼容层：仍返回安全历史 envelope。
 *
 * 新页面必须改用 persistRideHistorySummary 的 persisted/status 判断是否
 * 可以显示“本次已计入”。失败时这里可返回尝试结果，但不会在读取失败后
 * 覆盖存储。
 */
export function appendRideHistorySummary(storage, summary) {
  const result = persistRideHistorySummary(storage, summary);
  if (result.persisted && result.history) return result.history;
  if (result.attemptedHistory) return result.attemptedHistory;
  if (result.history) return result.history;
  return readRideHistory(storage);
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rounded(value, digits) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function metricComparison(rides, key, metric) {
  const values = rides
    .map((ride) => finite(ride[key]))
    .filter((value) => value != null && value > 0);
  if (values.length < RIDE_HISTORY_MIN_TREND_SAMPLES) return null;

  const split = Math.floor(values.length / 2);
  const earlier = values.slice(0, split);
  const recent = values.slice(split);
  if (earlier.length < 2 || recent.length < 2) return null;
  const earlierAverage = mean(earlier);
  const recentAverage = mean(recent);
  if (!(earlierAverage > 0) || !(recentAverage > 0)) return null;

  const changePct = (recentAverage - earlierAverage) / earlierAverage * 100;
  return {
    metric,
    sampleCount: values.length,
    earlierAverage: rounded(earlierAverage, metric === 'speed' ? 2 : 1),
    recentAverage: rounded(recentAverage, metric === 'speed' ? 2 : 1),
    changePct: rounded(changePct, 1),
    direction: Math.abs(changePct) <= 3
      ? 'steady' : (changePct > 0 ? 'up' : 'down'),
  };
}

/**
 * 计算滚动 7 天趋势。
 *
 * 至少 4 个可比均速样本才给速度趋势；不足时可退到至少 4 个踏频样本。
 * 两者都不足时 status 始终为 insufficient，只返回可证实的次数与总量。
 */
export function buildSevenDayRideTrend(history, nowMs) {
  const now = numberInRange(nowMs, MIN_EPOCH_MS, MAX_EPOCH_MS);
  if (now == null) {
    return {
      status: 'insufficient',
      reason: 'invalid_now',
      windowDays: 7,
      rideCount: 0,
      totalDistanceM: 0,
      totalElapsedMs: 0,
      historyAtCapacity: false,
      comparison: null,
    };
  }

  const windowStartMs = now - RIDE_HISTORY_WINDOW_MS;
  const normalizedHistory = normalizeRideHistory(history);
  const historyAtCapacity =
    normalizedHistory.rides.length >= RIDE_HISTORY_MAX_ENTRIES;
  const rides = normalizedHistory.rides
    .filter((ride) => ride.endedAtMs >= windowStartMs && ride.endedAtMs <= now)
    .sort((left, right) => left.endedAtMs - right.endedAtMs);
  const totalDistanceM = rides.reduce((sum, ride) => sum + ride.distanceM, 0);
  const totalElapsedMs = rides.reduce((sum, ride) => sum + ride.elapsedMs, 0);
  const speedValues = rides
    .map((ride) => finite(ride.avgSpeedKmh))
    .filter((value) => value != null && value > 0);
  const cadenceValues = rides
    .map((ride) => finite(ride.avgCadenceRpm))
    .filter((value) => value != null && value > 0);
  const comparison = metricComparison(rides, 'avgSpeedKmh', 'speed')
    || metricComparison(rides, 'avgCadenceRpm', 'cadence');

  return {
    status: comparison ? 'ready' : 'insufficient',
    reason: comparison
      ? null : (rides.length ? 'comparable_samples' : 'no_rides'),
    windowDays: 7,
    windowStartMs,
    windowEndMs: now,
    rideCount: rides.length,
    totalDistanceM: rounded(totalDistanceM, 3),
    totalElapsedMs: Math.round(totalElapsedMs),
    historyAtCapacity,
    averageSpeedKmh: rounded(mean(speedValues), 2),
    averageCadenceRpm: rounded(mean(cadenceValues), 1),
    comparableSpeedCount: speedValues.length,
    comparableCadenceCount: cadenceValues.length,
    comparison,
  };
}

function trendStatsText(trend) {
  const count = Math.max(0, Math.round(finite(trend.rideCount) ?? 0));
  const distanceM = numberInRange(trend.totalDistanceM, 0, 1000000);
  const prefix = trend.historyAtCapacity === true
    ? `最近${RIDE_HISTORY_MAX_ENTRIES}场中，近7天`
    : '近7天';
  if (distanceM != null && distanceM > 0) {
    if (distanceM < MIN_DISTANCE_DISPLAY_M) {
      return `${prefix} ${count} 次 / 距离很短`;
    }
    return `${prefix} ${count} 次 / ${formatDistanceKm(distanceM)} 公里`;
  }
  return `${prefix} ${count} 次`;
}

function changeText(comparison) {
  if (!comparison || typeof comparison !== 'object') return '';
  const label = comparison.metric === 'cadence' ? '平均踏频' : '均速';
  if (comparison.direction === 'steady') {
    return `近期${label}与前期基本持平。`;
  }
  const changePct = Math.abs(finite(comparison.changePct) ?? 0);
  const pct = String(Number(changePct.toFixed(1)));
  return comparison.direction === 'up'
    ? `近期${label}较前期高 ${pct}%。`
    : `近期${label}较前期低 ${pct}%。`;
}

/**
 * 供骑前/骑后共用的短中文文案。phase='post' 只增加“本次已计入”，
 * 不改变同一份趋势事实。
 */
export function formatRideTrendText(trend, phase = 'pre') {
  const value = trend && typeof trend === 'object' ? trend : null;
  const postPrefix = phase === 'post' ? '本次已计入。' : '';
  if (!value) return `${postPrefix}近7天趋势暂不可用。`;
  if (value.status !== 'ready' || !value.comparison) {
    if (!(Number(value.rideCount) > 0)) {
      return `${postPrefix}近7天暂无骑行记录。`;
    }
    return `${postPrefix}${trendStatsText(value)}，趋势样本不足。`;
  }
  return `${postPrefix}${trendStatsText(value)}，${changeText(value.comparison)}`;
}

export function buildRideTrendText(history, nowMs, phase = 'pre') {
  return formatRideTrendText(
    buildSevenDayRideTrend(history, nowMs),
    phase,
  );
}
