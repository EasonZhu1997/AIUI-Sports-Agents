export const ROWER_SUMMARY_SCHEMA_VERSION = 1;
export const ROWER_MODE = 'indoor_rower';
export const ROWER_DISTANCE_SOURCE = 'ftms_total_distance';
export const ROWER_SUMMARY_MAX_MINUTE_POINTS = 30;
export const ROWER_SUMMARY_CHART_POINTS = 12;

const COVERAGE_FIELDS = Object.freeze([
  'distanceCoveragePct',
  'strokeCountCoveragePct',
  'strokeRateCoveragePct',
  'splitCoveragePct',
  'powerCoveragePct',
  'heartRateCoveragePct',
]);

const HEART_RATE_SOURCES = new Set([
  'independent_hrs',
  'ftms',
  'mixed',
  'partial',
  'unavailable',
]);

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function bounded(value, minimum, maximum, fallback = 0) {
  return Math.max(minimum, Math.min(maximum, finite(value, fallback)));
}

function nullableBounded(value, minimum, maximum) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(minimum, Math.min(maximum, value));
}

function randomSessionId(nowMs) {
  const random = Math.floor(Math.random() * 0x1000000)
    .toString(16)
    .padStart(6, '0');
  return `rower-${Math.floor(nowMs).toString(36)}-${random}`;
}

function coverageInput(source, flatName, nestedName) {
  if (Number.isFinite(source[flatName])) return source[flatName];
  const nested = source.fieldCoveragePct;
  return nested && typeof nested === 'object' && Number.isFinite(nested[nestedName])
    ? nested[nestedName] : 0;
}

export function normalizeRowerMinuteSplitSeries(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  let previousMinute = 0;
  for (const point of value) {
    if (!point || typeof point !== 'object' || Array.isArray(point)
        || !Number.isInteger(point.minute) || point.minute <= previousMinute
        || !Number.isFinite(point.value)
        || point.value < 1 || point.value > 0xfffe) continue;
    result.push({ minute: point.minute, value: point.value });
    previousMinute = point.minute;
  }
  return result.slice(-ROWER_SUMMARY_MAX_MINUTE_POINTS);
}

/**
 * Builds an allowlisted aggregate summary. Unknown input keys, including raw
 * packets, GATT objects, device names and identifiers, are intentionally lost.
 */
export function buildRowerSummary(input = {}) {
  const finishedAtMs = Math.max(0, finite(input.finishedAtMs, Date.now()));
  const startedAtMs = Math.max(0, finite(input.startedAtMs));
  const elapsedMs = Math.max(0, finite(input.elapsedMs));
  const distanceM = Math.max(0, finite(input.distanceM));
  const distanceCoveragePct = bounded(
    coverageInput(input, 'distanceCoveragePct', 'distance'),
    0,
    100,
  );
  const strokeCountCoveragePct = bounded(
    coverageInput(input, 'strokeCountCoveragePct', 'strokeCount'),
    0,
    100,
  );
  const strokeRateCoveragePct = bounded(
    coverageInput(input, 'strokeRateCoveragePct', 'strokeRate'),
    0,
    100,
  );
  const splitCoveragePct = bounded(
    coverageInput(input, 'splitCoveragePct', 'split'),
    0,
    100,
  );
  const powerCoveragePct = bounded(
    coverageInput(input, 'powerCoveragePct', 'power'),
    0,
    100,
  );
  const heartRateCoveragePct = bounded(
    coverageInput(input, 'heartRateCoveragePct', 'heartRate'),
    0,
    100,
  );
  const independentHrsCoveragePct = bounded(
    input.independentHrsCoveragePct,
    0,
    heartRateCoveragePct,
  );
  const ftmsHeartRateCoveragePct = bounded(
    input.ftmsHeartRateCoveragePct,
    0,
    heartRateCoveragePct,
  );
  const fieldCoverageValues = [
    distanceCoveragePct,
    strokeCountCoveragePct,
    strokeRateCoveragePct,
    splitCoveragePct,
    powerCoveragePct,
  ];
  const ftmsCoveragePct = Math.max(
    ...fieldCoverageValues,
    bounded(input.ftmsCoveragePct, 0, 100),
  );
  const distanceEvidence = distanceM > 0
    ? 'measured'
    : (input.distanceEvidence === 'stationary' ? 'stationary' : 'unavailable');

  const averageSplitSecPer500m = splitCoveragePct > 0
    ? nullableBounded(input.averageSplitSecPer500m, 1, 0xfffe) : null;
  const averageStrokeRateSpm = strokeRateCoveragePct > 0
    ? nullableBounded(input.averageStrokeRateSpm, 0, 127.5) : null;
  const maxStrokeRateSpm = strokeRateCoveragePct > 0
    ? nullableBounded(input.maxStrokeRateSpm, 0, 127.5) : null;
  const averagePowerW = powerCoveragePct > 0
    ? nullableBounded(input.averagePowerW, -1000, 3000) : null;
  const maxPowerW = powerCoveragePct > 0
    ? nullableBounded(input.maxPowerW, -1000, 3000) : null;
  const averageHeartRateBpm = heartRateCoveragePct > 0
    ? nullableBounded(input.averageHeartRateBpm, 20, 240) : null;
  const maxHeartRateBpm = heartRateCoveragePct > 0
    ? nullableBounded(input.maxHeartRateBpm, 20, 240) : null;
  const minuteSplitSeries = splitCoveragePct > 0
    ? normalizeRowerMinuteSplitSeries(input.minuteSplitSeries) : [];
  let heartRateSource = HEART_RATE_SOURCES.has(input.heartRateSource)
    ? input.heartRateSource : 'partial';
  if (heartRateCoveragePct <= 0) heartRateSource = 'unavailable';
  else if (heartRateSource === 'unavailable') heartRateSource = 'partial';
  if (heartRateSource === 'independent_hrs'
      && independentHrsCoveragePct <= 0) heartRateSource = 'partial';
  if (heartRateSource === 'ftms'
      && ftmsHeartRateCoveragePct <= 0) heartRateSource = 'partial';
  if (heartRateSource === 'mixed'
      && (independentHrsCoveragePct <= 0
        || ftmsHeartRateCoveragePct <= 0)) heartRateSource = 'partial';
  const sensorSources = independentHrsCoveragePct > 0
    ? ['ftms', 'independent_hrs'] : ['ftms'];

  return {
    schemaVersion: ROWER_SUMMARY_SCHEMA_VERSION,
    sessionId: typeof input.sessionId === 'string' && input.sessionId.trim()
      ? input.sessionId.trim() : randomSessionId(finishedAtMs),
    mode: ROWER_MODE,
    startedAtMs,
    finishedAtMs,
    elapsedMs,
    distanceEvidence,
    distanceSource: distanceEvidence === 'unavailable'
      ? 'unavailable' : ROWER_DISTANCE_SOURCE,
    distanceM,
    strokeCount: Math.max(0, Math.floor(finite(input.strokeCount))),
    averageSplitSecPer500m,
    averageStrokeRateSpm,
    maxStrokeRateSpm,
    averagePowerW,
    maxPowerW,
    averageHeartRateBpm,
    maxHeartRateBpm,
    ftmsCoveragePct,
    distanceCoveragePct,
    strokeCountCoveragePct,
    strokeRateCoveragePct,
    splitCoveragePct,
    powerCoveragePct,
    heartRateCoveragePct,
    heartRateSource,
    independentHrsCoveragePct,
    ftmsHeartRateCoveragePct,
    minuteSplitSeries,
    sensorSources,
  };
}

export function buildRowerChart(source = {}) {
  const series = Array.isArray(source) ? source : source.minuteSplitSeries;
  const data = normalizeRowerMinuteSplitSeries(series)
    .slice(-ROWER_SUMMARY_CHART_POINTS);
  const values = data.map((point) => point.value);
  const firstMinute = data.length ? data[0].minute : 1;
  const lastMinute = data.length ? data[data.length - 1].minute : 2;
  const minimumValue = values.length ? Math.min(...values) : 120;
  const maximumValue = values.length ? Math.max(...values) : 360;
  const yMinimum = Math.max(0, Math.floor((minimumValue - 30) / 10) * 10);
  const yMaximum = Math.max(
    yMinimum + 10,
    Math.ceil((maximumValue + 30) / 10) * 10,
  );
  return {
    showSummaryChart: data.length > 0,
    summaryChartTitle: '每分钟 500m 配速',
    summaryChartUnit: '秒/500m',
    summaryChartData: data,
    summaryChartEmptyText: '有效分钟配速未形成',
    summaryChartYAxis: { minimum: yMinimum, maximum: yMaximum },
    summaryChartXAxis: {
      minimum: firstMinute,
      maximum: Math.max(lastMinute, firstMinute + 1),
    },
  };
}

function compactText(value, maxChars = 42) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function average(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function buildRowerLocalReview(source = {}) {
  let detail;
  if (source.distanceEvidence === 'unavailable') {
    detail = '划船机未提供可用距离，本次仅保留已验证的聚合指标。';
  } else if (source.distanceEvidence === 'stationary') {
    detail = '划船机数据已覆盖，但本次没有确认到距离增长。';
  } else if (bounded(source.ftmsCoveragePct, 0, 100) >= 50) {
    detail = '划船机数据覆盖稳定，可结合平均配速、桨频与功率复盘。';
  } else {
    detail = '本次已记录距离，但划船机数据覆盖有限，请谨慎参考缺失字段。';
  }
  return {
    detail: compactText(detail),
    sourceNote: '本地规则 · FTMS 聚合',
  };
}

export function buildRowerReview(source = {}) {
  return buildRowerLocalReview(source);
}

const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function buildRowerHistoryTrend(
  history,
  currentSummary,
  persistenceState = 'pending',
) {
  const current = currentSummary && typeof currentSummary === 'object'
    ? currentSummary : {};
  const referenceMs = Number.isFinite(current.finishedAtMs)
    && current.finishedAtMs >= 0 ? current.finishedAtMs : Date.now();
  const currentSessionId = typeof current.sessionId === 'string'
    ? current.sessionId : '';
  const records = Array.isArray(history) ? history : [];
  const bySession = new Map();
  records.forEach((item, index) => {
    if (!item || typeof item !== 'object' || item.mode !== ROWER_MODE) return;
    if (persistenceState !== 'saved'
        && currentSessionId && item.sessionId === currentSessionId) return;
    if (!Number.isFinite(item.finishedAtMs)
        || item.finishedAtMs > referenceMs
        || item.finishedAtMs < referenceMs - HISTORY_WINDOW_MS
        || item.distanceEvidence !== 'measured'
        || !Number.isFinite(item.averageSplitSecPer500m)
        || item.averageSplitSecPer500m <= 0
        || !Number.isFinite(item.ftmsCoveragePct)
        || item.ftmsCoveragePct < 50) return;
    const key = typeof item.sessionId === 'string' && item.sessionId
      ? item.sessionId : `record-${index}`;
    bySession.set(key, item);
  });
  const comparable = [...bySession.values()]
    .sort((left, right) => left.finishedAtMs - right.finishedAtMs);
  const count = comparable.length;
  if (persistenceState === 'pending') {
    return `近7天训练${count}场 · 本次待保存`;
  }
  if (persistenceState === 'failed') {
    return `近7天训练${count}场 · 本次未计入`;
  }
  if (count < 4) return `近7天训练${count}场 · 满4场显示配速趋势`;
  const midpoint = Math.floor(count / 2);
  const first = average(comparable.slice(0, midpoint)
    .map((item) => item.averageSplitSecPer500m));
  const latest = average(comparable.slice(midpoint)
    .map((item) => item.averageSplitSecPer500m));
  const change = first > 0 ? (latest - first) / first : 0;
  const band = change < -0.03
    ? '配速较前段快' : (change > 0.03 ? '配速较前段慢' : '配速基本持平');
  return compactText(`近7天训练${count}场 · ${band}`);
}

export function hasOnlyRowerSummaryCoverageFields(value) {
  return COVERAGE_FIELDS.every((name) => Number.isFinite(value && value[name]));
}

// Compatibility aliases retained for reviewed API consumers.
export const INDOOR_ROWER_SUMMARY_SCHEMA_VERSION = ROWER_SUMMARY_SCHEMA_VERSION;
export const INDOOR_ROWER_MODE = ROWER_MODE;
export const INDOOR_ROWER_DISTANCE_SOURCE = ROWER_DISTANCE_SOURCE;
export const INDOOR_ROWER_MAX_MINUTE_POINTS = ROWER_SUMMARY_MAX_MINUTE_POINTS;
export const INDOOR_ROWER_CHART_POINTS = ROWER_SUMMARY_CHART_POINTS;
export const normalizeIndoorRowerMinuteSplitSeries = normalizeRowerMinuteSplitSeries;
export const buildIndoorRowerSummary = buildRowerSummary;
export const buildIndoorRowerChart = buildRowerChart;
export const buildIndoorRowerLocalReview = buildRowerLocalReview;
export const buildIndoorRowerReview = buildRowerReview;
export const buildIndoorRowerHistoryTrend = buildRowerHistoryTrend;
export const hasOnlyIndoorRowerSummaryCoverageFields = hasOnlyRowerSummaryCoverageFields;
