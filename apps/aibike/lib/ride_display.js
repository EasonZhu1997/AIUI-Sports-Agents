import {
  formatBpm,
  formatCadenceRpm,
  formatDistanceKm,
  formatElapsed,
  formatPowerW,
  formatSpeedKmh,
} from './ride_format.js';

export const RIDE_DISPLAY_TEXT = Object.freeze({
  speedImuWaiting: '估算中',
  recovering: '恢复中',
  cadenceWaiting: '识别中',
  distanceWaiting: '待起步',
  starting: '起步中',
  stopped: '静止',
  coasting: '滑行',
  paused: '暂停',
  heartRateWaiting: '等待',
  heartRateReconnect: '重连',
  heartRateContactLost: '未贴',
  notConnected: '未连接',
  notUsed: '未使用',
  notRecorded: '未记录',
  notFormed: '未形成',
  shortDistance: '短距离',
  notCompleted: '未完成',
});

// AIUI 0.15 的固定宽度 HUD 不能依赖浏览器文本裁剪。状态词、长距离与
// 长时长按字符数切换字号，保持紧凑底栏几何。
export function hudValueStateMod(text) {
  return /^\d+(?:[.:]\d+)*$/.test(String(text ?? ''))
    ? '' : 'ride-value-pending';
}

export function hudValueLenMod(text, prefix, midLen, smallLen) {
  const length = String(text ?? '').length;
  if (length <= midLen) return '';
  if (length <= smallLen) return `${prefix}-mid`;
  return `${prefix}-sm`;
}

export function unifiedDistanceMod(text) {
  return hudValueLenMod(text, 'v', 4, 5);
}

export function unifiedElapsedMod(text) {
  return hudValueLenMod(text, 'v', 5, 5);
}

export function glassesDistanceMod(text) {
  return hudValueLenMod(text, 'g', 4, 6);
}

export function glassesElapsedMod(text) {
  return hudValueLenMod(text, 'g', 5, 6);
}

export function buildHudMetricClassFields(display = {}) {
  return {
    speedValueStateClass: hudValueStateMod(display.speed),
    cadenceValueStateClass: hudValueStateMod(display.cadence),
    distanceValueStateClass: hudValueStateMod(display.distance),
    elapsedValueStateClass: hudValueStateMod(display.elapsed),
    heartRateValueStateClass: hudValueStateMod(display.heartRate),
    distanceMod: unifiedDistanceMod(display.distance),
    elapsedMod: unifiedElapsedMod(display.elapsed),
    gDistanceMod: glassesDistanceMod(display.distance),
    gElapsedMod: glassesElapsedMod(display.elapsed),
  };
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function validInRange(value, minimum, maximum) {
  const numeric = finite(value);
  return numeric != null && numeric >= minimum && numeric <= maximum
    ? numeric : null;
}

function positiveDisplay(value, formatter, zeroText) {
  const numeric = finite(value);
  if (!(numeric > 0)) return null;
  const text = formatter(numeric);
  return /^0(?:\.0+)?$/.test(text) ? zeroText : text;
}

function normalizedState(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

export function buildHudMetricDisplay(value = {}) {
  const speed = validInRange(value.speedKmh, 0, 150);
  const cadence = validInRange(value.cadenceRpm, 0, 250);
  const distance = validInRange(value.distanceM, 0, 100000000);
  const heartRate = validInRange(value.heartRateBpm, 1, 254);
  const power = validInRange(value.powerW, 0, 3000);
  const speedState = normalizedState(value.speedState);
  const cadenceState = normalizedState(value.cadenceState);
  const heartRateMode = normalizedState(value.heartRateMode);
  const paused = value.paused === true;
  const stationary = value.stationary === true
    || (speedState === 'explicit_zero' && !(speed > 1.5));
  const moving = value.moving === true || speed > 1.5;

  let speedText = positiveDisplay(
    speed,
    formatSpeedKmh,
    RIDE_DISPLAY_TEXT.starting,
  );
  if (!speedText) {
    if (paused) speedText = RIDE_DISPLAY_TEXT.paused;
    else if (stationary) speedText = RIDE_DISPLAY_TEXT.stopped;
    else if (speedState === 'stale') speedText = RIDE_DISPLAY_TEXT.recovering;
    else speedText = RIDE_DISPLAY_TEXT.speedImuWaiting;
  }

  let cadenceText = positiveDisplay(
    cadence,
    formatCadenceRpm,
    RIDE_DISPLAY_TEXT.starting,
  );
  if (!cadenceText) {
    if (paused) cadenceText = RIDE_DISPLAY_TEXT.paused;
    else if (cadenceState === 'explicit_zero' && moving) {
      cadenceText = RIDE_DISPLAY_TEXT.coasting;
    } else if (stationary || cadenceState === 'explicit_zero') {
      cadenceText = RIDE_DISPLAY_TEXT.stopped;
    } else if (cadenceState === 'stale') {
      cadenceText = RIDE_DISPLAY_TEXT.recovering;
    } else cadenceText = RIDE_DISPLAY_TEXT.cadenceWaiting;
  }

  const distanceText = distance > 0
    ? positiveDisplay(
      distance,
      formatDistanceKm,
      RIDE_DISPLAY_TEXT.starting,
    )
    : RIDE_DISPLAY_TEXT.distanceWaiting;

  let heartRateText = heartRate != null ? formatBpm(heartRate) : null;
  if (!heartRateText) {
    if (heartRateMode === 'contact-lost') {
      heartRateText = RIDE_DISPLAY_TEXT.heartRateContactLost;
    } else if (heartRateMode === 'reconnecting') {
      heartRateText = RIDE_DISPLAY_TEXT.heartRateReconnect;
    } else if (heartRateMode === 'waiting') {
      heartRateText = RIDE_DISPLAY_TEXT.heartRateWaiting;
    } else heartRateText = RIDE_DISPLAY_TEXT.notConnected;
  }

  let powerText = RIDE_DISPLAY_TEXT.notConnected;
  let powerChipText = '';
  if (power != null) {
    if (power > 0) {
      powerText = positiveDisplay(
        power,
        formatPowerW,
        moving ? RIDE_DISPLAY_TEXT.coasting : RIDE_DISPLAY_TEXT.stopped,
      );
      powerChipText = /^\d+$/.test(powerText)
        ? '功率 ' + powerText + 'W'
        : '功率·' + powerText;
    } else if (moving) {
      powerText = RIDE_DISPLAY_TEXT.coasting;
      powerChipText = '功率·' + RIDE_DISPLAY_TEXT.coasting;
    } else {
      powerText = RIDE_DISPLAY_TEXT.stopped;
      powerChipText = '功率·' + RIDE_DISPLAY_TEXT.stopped;
    }
  } else if (value.powerEverLive === true) {
    powerText = RIDE_DISPLAY_TEXT.notRecorded;
    powerChipText = '功率恢复中';
  }

  const elapsed = finite(value.elapsedMs);
  return {
    speed: speedText,
    cadence: cadenceText,
    distance: distanceText,
    elapsed: elapsed != null && elapsed >= 1000
      ? formatElapsed(elapsed) : '刚开始',
    heartRate: heartRateText,
    power: powerText,
    powerChipText,
    showPower: powerChipText !== '',
  };
}

export function buildSummaryMetricDisplay(summary) {
  const value = summary && typeof summary === 'object' ? summary : null;
  if (!value) {
    return {
      distance: RIDE_DISPLAY_TEXT.notCompleted,
      elapsed: RIDE_DISPLAY_TEXT.notCompleted,
      speed: RIDE_DISPLAY_TEXT.notRecorded,
      cadence: RIDE_DISPLAY_TEXT.notRecorded,
      heartRate: RIDE_DISPLAY_TEXT.notUsed,
      power: RIDE_DISPLAY_TEXT.notUsed,
    };
  }

  const sources = new Set([
    ...(Array.isArray(value.sources) ? value.sources : []),
    ...(Array.isArray(value.distanceSources) ? value.distanceSources : []),
    ...(Array.isArray(value.cadenceSources) ? value.cadenceSources : []),
  ].map((source) => String(source).toLowerCase()));
  const distance = validInRange(value.distanceM, 0, 100000000);
  const elapsed = validInRange(value.elapsedMs, 0, 31536000000);
  const speed = validInRange(value.avgSpeedKmh, 0, 150);
  const cadence = validInRange(value.avgCadenceRpm, 0, 250);
  const heartRate = validInRange(value.avgBpm, 1, 254);
  const power = validInRange(value.avgPowerW, 0, 3000);
  const heartRateConnected = value.heartRateConnected === true
    || sources.has('hrs');
  const powerConnected = value.powerConnected === true
    || sources.has('cps');

  return {
    distance: distance > 0
      ? positiveDisplay(
        distance,
        formatDistanceKm,
        RIDE_DISPLAY_TEXT.shortDistance,
      )
      : RIDE_DISPLAY_TEXT.notFormed,
    elapsed: elapsed >= 1000
      ? formatElapsed(elapsed) : RIDE_DISPLAY_TEXT.notCompleted,
    speed: speed > 0
      ? positiveDisplay(speed, formatSpeedKmh, RIDE_DISPLAY_TEXT.notRecorded)
      : RIDE_DISPLAY_TEXT.notRecorded,
    cadence: cadence > 0
      ? positiveDisplay(cadence, formatCadenceRpm, RIDE_DISPLAY_TEXT.notRecorded)
      : RIDE_DISPLAY_TEXT.notRecorded,
    heartRate: heartRate != null
      ? formatBpm(heartRate)
      : (heartRateConnected
        ? RIDE_DISPLAY_TEXT.notRecorded : RIDE_DISPLAY_TEXT.notUsed),
    power: power > 0
      ? positiveDisplay(power, formatPowerW, RIDE_DISPLAY_TEXT.notRecorded)
      : (powerConnected
        ? RIDE_DISPLAY_TEXT.notRecorded : RIDE_DISPLAY_TEXT.notUsed),
  };
}
