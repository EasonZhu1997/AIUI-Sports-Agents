#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BLE_SOURCES = new Set(['hrs', 'csc', 'cps', 'ftms']);
const SPEED_SOURCES = new Set(['csc', 'cps', 'ftms', 'gps', 'imu']);
const CADENCE_SOURCES = new Set(['csc', 'cps', 'ftms', 'imu']);
const DISTANCE_MODES = new Set([
  'wheel',
  'total',
  'speed_integration',
  'gps_path',
  'cadence_model',
]);
const ESTIMATED_DISTANCE_MODES = new Set(['gps_path', 'cadence_model']);

const SOURCE_LABELS = Object.freeze({
  hrs: 'HRS 实测',
  csc: 'CSC 实测',
  cps: 'CPS 实测',
  ftms: 'FTMS 实测',
  gps: 'GPS 估算',
  imu: '眼镜 IMU 估算',
  none: '无来源',
});

const DISTANCE_LABELS = Object.freeze({
  wheel: '轮转实测',
  total: 'FTMS 累计实测',
  speed_integration: 'FTMS 速度积分',
  gps_path: 'GPS 路径估算',
  cadence_model: 'IMU 固定挡位部分估算',
  none: '无来源',
});

const COORDINATE_PATTERNS = Object.freeze([
  ['latitude', /\blatitude\b/i],
  ['longitude', /\blongitude\b/i],
  ['lat', /(?:^|[\s{},\[\(])["']?lat["']?\s*[:=]/i],
  ['lng', /(?:^|[\s{},\[\(])["']?lng["']?\s*[:=]/i],
  ['lon', /(?:^|[\s{},\[\(])["']?lon["']?\s*[:=]/i],
  ['coords', /(?:^|[\s{},\[\(])["']?(?:coords?|coordinates?)["']?\s*[:=]/i],
  ['经纬度', /经纬度/],
  ['经度', /经度/],
  ['纬度', /纬度/],
  ['坐标', /坐标/],
]);

function splitLines(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function finiteNumber(value) {
  if (value == null || value === '' || value === '-') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function eventValue(details, key) {
  const match = String(details || '').match(
    new RegExp('(?:^|\\s)' + key + '=([^\\s]+)'),
  );
  return match ? match[1] : null;
}

function parseSlashValue(details, key, names) {
  const raw = eventValue(details, key);
  if (!raw) return null;
  const parts = raw.split('/');
  if (parts.length < names.length) return null;
  return Object.fromEntries(names.map((name, index) => [name, parts[index]]));
}

function parseMetric(details, name) {
  const value = parseSlashValue(details, name, ['source', 'state', 'ageMs']);
  if (!value) return null;
  return {
    source: value.source,
    state: value.state,
    ageMs: finiteNumber(value.ageMs),
  };
}

function parseHudStatus(details, lineNumber) {
  const distance = parseSlashValue(details, 'distance', ['meters', 'mode', 'state']);
  const imu = parseSlashValue(details, 'imu', ['motionState', 'fresh']);
  const imuCadence = parseSlashValue(
    details,
    'imuCadence',
    ['candidateRpm', 'finalRpm', 'confidence', 'state'],
  );
  const imuRuntime = parseSlashValue(
    details,
    'imuRuntime',
    ['state', 'observedHz', 'readingCount'],
  );
  const imuQuality = parseSlashValue(
    details,
    'imuQuality',
    ['state', 'artifact', 'quality'],
  );
  const gyro = parseSlashValue(
    details,
    'gyro',
    ['state', 'ageMs', 'readingCount'],
  );
  const orientation = parseSlashValue(
    details,
    'orientation',
    ['state', 'ageMs', 'readingCount'],
  );
  const gps = parseSlashValue(
    details,
    'gps',
    ['state', 'reason', 'accuracyM', 'quality', 'accepted', 'rejected'],
  );
  return {
    lineNumber,
    speed: parseMetric(details, 'speed'),
    cadence: parseMetric(details, 'cadence'),
    power: parseMetric(details, 'power'),
    heartRate: parseMetric(details, 'heartRate'),
    distance: distance ? {
      meters: finiteNumber(distance.meters),
      mode: distance.mode,
      state: distance.state,
    } : null,
    bleState: eventValue(details, 'ble'),
    imu: imu ? {
      motionState: imu.motionState,
      fresh: imu.fresh === 'true',
    } : null,
    imuCadence: imuCadence ? {
      candidateRpm: finiteNumber(imuCadence.candidateRpm),
      finalRpm: finiteNumber(imuCadence.finalRpm),
      confidence: finiteNumber(imuCadence.confidence),
      state: imuCadence.state,
    } : null,
    imuRuntime: imuRuntime ? {
      state: imuRuntime.state,
      observedHz: finiteNumber(imuRuntime.observedHz),
      readingCount: finiteNumber(imuRuntime.readingCount),
    } : null,
    imuQuality: imuQuality ? {
      state: imuQuality.state,
      artifact: imuQuality.artifact,
      quality: finiteNumber(imuQuality.quality),
    } : null,
    gyro: gyro ? {
      state: gyro.state,
      ageMs: finiteNumber(gyro.ageMs),
      readingCount: finiteNumber(gyro.readingCount),
    } : null,
    orientation: orientation ? {
      state: orientation.state,
      ageMs: finiteNumber(orientation.ageMs),
      readingCount: finiteNumber(orientation.readingCount),
    } : null,
    gps: gps ? {
      state: gps.state,
      reason: gps.reason,
      accuracyM: finiteNumber(gps.accuracyM),
      quality: finiteNumber(gps.quality),
      accepted: finiteNumber(gps.accepted),
      rejected: finiteNumber(gps.rejected),
    } : null,
  };
}

function detectCoordinateLeaks(lines) {
  const leaks = [];
  lines.forEach((line, index) => {
    for (const [key, pattern] of COORDINATE_PATTERNS) {
      if (pattern.test(line)) {
        leaks.push({ lineNumber: index + 1, key });
      }
    }
  });
  return leaks;
}

function sourceNeedsBlePacket(source) {
  return BLE_SOURCES.has(source);
}

function isMetricLive(metric, sources) {
  return metric != null
    && metric.state === 'live'
    && sources.has(metric.source);
}

function classifyCompleteSnapshot(snapshot, packetSources, runtime) {
  if (!snapshot
      || !isMetricLive(snapshot.speed, SPEED_SOURCES)
      || !isMetricLive(snapshot.cadence, CADENCE_SOURCES)
      || !snapshot.distance
      || snapshot.distance.state !== 'live'
      || !(snapshot.distance.meters > 0)
      || !DISTANCE_MODES.has(snapshot.distance.mode)) {
    return null;
  }

  const liveMetricSources = [snapshot.speed.source, snapshot.cadence.source];
  if (liveMetricSources.some(
    (source) => sourceNeedsBlePacket(source) && !packetSources.has(source),
  )) {
    return null;
  }

  const usesImu = liveMetricSources.includes('imu')
    || snapshot.distance.mode === 'cadence_model';
  if (usesImu) {
    const cadence = snapshot.imuCadence;
    const validFinalCadence = cadence
      && cadence.finalRpm > 0
      && cadence.confidence != null
      && cadence.confidence >= 0.65;
    const validRuntimeRate = runtime.imuRates.some((rate) => rate >= 7.5)
      || (snapshot.imuRuntime && snapshot.imuRuntime.observedHz >= 7.5);
    if (!validFinalCadence
        || runtime.imuStarted === 0
        || runtime.imuFirstReading === 0
        || !validRuntimeRate
        || (snapshot.imuQuality
          && snapshot.imuQuality.artifact !== 'none')
        || runtime.imuRestartExhausted > 0) {
      return null;
    }
  }

  const usesGps = snapshot.speed.source === 'gps'
    || snapshot.distance.mode === 'gps_path';
  if (usesGps) {
    if (runtime.gpsWatchStarted === 0
        || !snapshot.gps
        || snapshot.gps.state !== 'live'
        || runtime.gpsRestartExhausted > 0) {
      return null;
    }
  }

  const estimated = ESTIMATED_DISTANCE_MODES.has(snapshot.distance.mode)
    || liveMetricSources.some((source) => source === 'gps' || source === 'imu');
  const sensorless = snapshot.cadence.source === 'imu'
    && ['gps', 'imu'].includes(snapshot.speed.source)
    && ESTIMATED_DISTANCE_MODES.has(snapshot.distance.mode);
  return {
    kind: sensorless ? 'sensorless' : (estimated ? 'mixed' : 'measured'),
    estimated,
  };
}

function uniqueNumbers(values) {
  return [...new Set(values.filter(Number.isFinite))].sort((a, b) => a - b);
}

function lastOf(values) {
  return values.length ? values[values.length - 1] : null;
}

export function analyzeFieldLog(text) {
  const lines = splitLines(text);
  const coordinateLeaks = detectCoordinateLeaks(lines);
  const hudSnapshots = [];
  const packetSources = new Set();
  const subscribedSources = new Set();
  const bleEvents = [];
  const runtime = {
    imuStarted: 0,
    imuFirstReading: 0,
    imuRates: [],
    imuLowRates: [],
    imuStalls: [],
    imuRestarts: [],
    imuRestartExhausted: 0,
    imuUnavailable: 0,
    imuErrors: 0,
    gyroStarted: 0,
    gyroFirstReading: 0,
    gyroUnavailable: 0,
    gyroErrors: 0,
    orientationStarted: 0,
    orientationFirstReading: 0,
    orientationUnavailable: 0,
    orientationErrors: 0,
    gpsWatchStarted: 0,
    gpsWatchStopped: 0,
    gpsStalls: [],
    gpsRestarts: [],
    gpsRestartExhausted: 0,
    gpsUnavailable: 0,
    gpsErrors: [],
  };
  let relevantLines = 0;

  lines.forEach((line, index) => {
    const match = line.match(/\[AIBike (BLE|GPS|IMU|HUD)\]\s+(\S+)(?:\s+(.*))?/);
    if (!match) return;
    relevantLines += 1;
    const [, tag, event, details = ''] = match;
    const lineNumber = index + 1;

    if (tag === 'HUD' && event === 'STATUS') {
      hudSnapshots.push(parseHudStatus(details, lineNumber));
      return;
    }

    if (tag === 'BLE') {
      bleEvents.push({ event, lineNumber });
      if (event === 'PACKET') {
        const source = eventValue(details, 'source');
        if (source) packetSources.add(source);
      } else if (event === 'GATT_CONNECTED') {
        const sources = eventValue(details, 'sources');
        if (sources) {
          sources.split(',').filter(Boolean).forEach((source) => {
            subscribedSources.add(source);
          });
        }
      }
      return;
    }

    if (tag === 'IMU') {
      if (event === 'ACCEL_STARTED') runtime.imuStarted += 1;
      else if (event === 'ACCEL_FIRST_READING') runtime.imuFirstReading += 1;
      else if (event === 'ACCEL_RATE') {
        const rate = finiteNumber(eventValue(details, 'hz'));
        if (rate != null) runtime.imuRates.push(rate);
      } else if (event === 'ACCEL_LOW_RATE') {
        const rate = finiteNumber(eventValue(details, 'hz'));
        if (rate != null) runtime.imuLowRates.push(rate);
      } else if (event === 'ACCEL_STALLED') {
        runtime.imuStalls.push(eventValue(details, 'reason') || 'unknown');
      } else if (event === 'ACCEL_RESTART') {
        runtime.imuRestarts.push({
          attempt: finiteNumber(eventValue(details, 'attempt')),
          reason: eventValue(details, 'reason') || 'unknown',
        });
      } else if (event === 'ACCEL_RESTART_EXHAUSTED') {
        runtime.imuRestartExhausted += 1;
      } else if (event === 'ACCEL_UNAVAILABLE') {
        runtime.imuUnavailable += 1;
      } else if (event === 'ACCEL_ERROR' || event === 'ACCEL_START_FAILED') {
        runtime.imuErrors += 1;
      } else if (event === 'GYRO_STARTED') {
        runtime.gyroStarted += 1;
      } else if (event === 'GYRO_FIRST_READING') {
        runtime.gyroFirstReading += 1;
      } else if (event === 'GYRO_UNAVAILABLE') {
        runtime.gyroUnavailable += 1;
      } else if (event === 'GYRO_ERROR') {
        runtime.gyroErrors += 1;
      } else if (event === 'ORIENTATION_STARTED') {
        runtime.orientationStarted += 1;
      } else if (event === 'ORIENTATION_FIRST_READING') {
        runtime.orientationFirstReading += 1;
      } else if (event === 'ORIENTATION_UNAVAILABLE') {
        runtime.orientationUnavailable += 1;
      } else if (event === 'ORIENTATION_ERROR') {
        runtime.orientationErrors += 1;
      }
      return;
    }

    if (tag === 'GPS') {
      if (event === 'WATCH_STARTED') runtime.gpsWatchStarted += 1;
      else if (event === 'WATCH_STOPPED') runtime.gpsWatchStopped += 1;
      else if (event === 'WATCH_STALLED') {
        runtime.gpsStalls.push(eventValue(details, 'reason') || 'unknown');
      } else if (event === 'WATCH_RESTART') {
        runtime.gpsRestarts.push({
          attempt: finiteNumber(eventValue(details, 'attempt')),
          reason: eventValue(details, 'reason') || 'unknown',
        });
      } else if (event === 'WATCH_RESTART_EXHAUSTED') {
        runtime.gpsRestartExhausted += 1;
      } else if (event === 'UNAVAILABLE') {
        runtime.gpsUnavailable += 1;
      } else if (event === 'ERROR') {
        runtime.gpsErrors.push(eventValue(details, 'code') || '-');
      }
    }
  });

  runtime.imuRates = uniqueNumbers(runtime.imuRates);
  runtime.imuLowRates = uniqueNumbers(runtime.imuLowRates);
  const completeSnapshots = hudSnapshots
    .map((snapshot) => ({
      snapshot,
      classification: classifyCompleteSnapshot(snapshot, packetSources, runtime),
    }))
    .filter((entry) => entry.classification != null);
  const selected = lastOf(completeSnapshots)
    || (hudSnapshots.length
      ? { snapshot: lastOf(hudSnapshots), classification: null }
      : null);

  const missing = [];
  if (relevantLines === 0) {
    missing.push('未发现 AIBike IMU/GPS/BLE/HUD 日志');
  }
  if (hudSnapshots.length === 0) {
    missing.push('未发现 [AIBike HUD] STATUS');
  } else if (completeSnapshots.length === 0) {
    missing.push('未发现同一条 HUD STATUS 中完整且可验证的速度、踏频、正里程链路');
  }
  if (coordinateLeaks.length > 0) {
    missing.push('检测到原始坐标键，必须先修复隐私泄漏');
  }

  const status = missing.length === 0 ? 'PASS' : 'INCOMPLETE';
  const gpsSnapshots = hudSnapshots.filter((snapshot) => snapshot.gps);
  const finalCadenceSnapshots = hudSnapshots.filter(
    (snapshot) => snapshot.imuCadence && snapshot.imuCadence.finalRpm > 0,
  );
  const acceptedValues = gpsSnapshots
    .map((snapshot) => snapshot.gps.accepted)
    .filter(Number.isFinite);
  const rejectedValues = gpsSnapshots
    .map((snapshot) => snapshot.gps.rejected)
    .filter(Number.isFinite);

  return {
    status,
    totalLines: lines.length,
    relevantLines,
    coordinateLeaks,
    missing,
    hud: {
      count: hudSnapshots.length,
      snapshots: hudSnapshots,
      completeCount: completeSnapshots.length,
      selected: selected ? selected.snapshot : null,
      classification: selected ? selected.classification : null,
    },
    imu: {
      started: runtime.imuStarted,
      firstReading: runtime.imuFirstReading,
      ratesHz: runtime.imuRates,
      lowRatesHz: runtime.imuLowRates,
      stalls: runtime.imuStalls,
      restarts: runtime.imuRestarts,
      restartExhausted: runtime.imuRestartExhausted,
      unavailable: runtime.imuUnavailable,
      errors: runtime.imuErrors,
      gyro: {
        started: runtime.gyroStarted,
        firstReading: runtime.gyroFirstReading,
        unavailable: runtime.gyroUnavailable,
        errors: runtime.gyroErrors,
      },
      orientation: {
        started: runtime.orientationStarted,
        firstReading: runtime.orientationFirstReading,
        unavailable: runtime.orientationUnavailable,
        errors: runtime.orientationErrors,
      },
      finalCadenceCount: finalCadenceSnapshots.length,
      latestFinalCadence: finalCadenceSnapshots.length
        ? lastOf(finalCadenceSnapshots).imuCadence
        : null,
    },
    gps: {
      watchStarted: runtime.gpsWatchStarted,
      watchStopped: runtime.gpsWatchStopped,
      stalls: runtime.gpsStalls,
      restarts: runtime.gpsRestarts,
      restartExhausted: runtime.gpsRestartExhausted,
      unavailable: runtime.gpsUnavailable,
      errors: runtime.gpsErrors,
      states: [...new Set(gpsSnapshots.map((snapshot) => snapshot.gps.state))],
      maxAcceptedSegments: acceptedValues.length ? Math.max(...acceptedValues) : 0,
      maxRejectedPositions: rejectedValues.length ? Math.max(...rejectedValues) : 0,
    },
    ble: {
      packetSources: [...packetSources].sort(),
      subscribedSources: [...subscribedSources].sort(),
      eventCount: bleEvents.length,
    },
  };
}

function formatNumber(value, digits = 1) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : '--';
}

function sourceLabel(source) {
  return SOURCE_LABELS[source] || String(source || '无来源');
}

function distanceLabel(mode) {
  return DISTANCE_LABELS[mode] || String(mode || '无来源');
}

function formatRange(values, suffix) {
  if (!values.length) return '无';
  const min = values[0];
  const max = values[values.length - 1];
  return min === max
    ? `${formatNumber(min)}${suffix}`
    : `${formatNumber(min)}–${formatNumber(max)}${suffix}`;
}

function joinOrNone(values) {
  return values.length ? values.join('、') : '无';
}

export function formatFieldLogReport(result) {
  const lines = [];
  const classification = result.hud.classification;
  const conclusion = classification && classification.kind === 'sensorless'
    ? '无外设 GPS/眼镜 IMU 后备链已形成'
    : classification && classification.kind === 'measured'
      ? '真实骑行传感器指标链已形成'
      : classification
        ? '混合来源指标链已形成'
        : '日志证据尚未形成完整指标链';

  lines.push('AIBike Craft Console 现场日志分析');
  lines.push(`结论: ${result.status} — ${conclusion}`);
  lines.push(
    `日志: ${result.totalLines} 行，AIBike 诊断 ${result.relevantLines} 行，`
      + `HUD STATUS ${result.hud.count} 条`,
  );
  if (result.coordinateLeaks.length === 0) {
    lines.push('隐私: PASS — 未发现 latitude/longitude/经纬度/坐标键');
  } else {
    const safeHits = result.coordinateLeaks
      .map((leak) => `第${leak.lineNumber}行(${leak.key})`);
    lines.push(`隐私: FAIL — ${joinOrNone(safeHits)}；为避免二次泄漏，不回显原日志内容`);
  }

  const snapshot = result.hud.selected;
  if (snapshot) {
    const cadence = snapshot.imuCadence;
    lines.push('指标证据:');
    lines.push(
      `- 踏频: ${sourceLabel(snapshot.cadence && snapshot.cadence.source)}`
        + ` / ${(snapshot.cadence && snapshot.cadence.state) || 'unknown'}`
        + (snapshot.cadence && snapshot.cadence.source === 'imu' && cadence
          ? `；final=${formatNumber(cadence.finalRpm, 0)} rpm，`
            + `confidence=${formatNumber(cadence.confidence, 2)}`
          : ''),
    );
    lines.push(
      `- 速度: ${sourceLabel(snapshot.speed && snapshot.speed.source)}`
        + ` / ${(snapshot.speed && snapshot.speed.state) || 'unknown'}`,
    );
    lines.push(
      `- 里程: ${distanceLabel(snapshot.distance && snapshot.distance.mode)}`
        + ` / ${(snapshot.distance && snapshot.distance.state) || 'unknown'}`
        + `；${formatNumber(snapshot.distance && snapshot.distance.meters, 2)} m`,
    );
  } else {
    lines.push('指标证据: 无 HUD STATUS 可解析');
  }

  lines.push('IMU 运行证据:');
  lines.push(
    `- 启动 ${result.imu.started} 次，首帧 ${result.imu.firstReading} 次，`
      + `采样率 ${formatRange(result.imu.ratesHz, 'Hz')}`,
  );
  lines.push(
    `- finalCadence 状态 ${result.imu.finalCadenceCount} 条，`
      + `断流 ${result.imu.stalls.length} 次，重启 ${result.imu.restarts.length} 次，`
      + `耗尽 ${result.imu.restartExhausted} 次`,
  );
  if (result.imu.lowRatesHz.length) {
    lines.push(`- 低采样率: ${formatRange(result.imu.lowRatesHz, 'Hz')}`);
  }
  lines.push(
    `- Gyroscope 启动/首帧 ${result.imu.gyro.started}/`
      + `${result.imu.gyro.firstReading}，不可用/错误 `
      + `${result.imu.gyro.unavailable}/${result.imu.gyro.errors}`,
  );
  lines.push(
    `- AbsoluteOrientation 启动/首帧 ${result.imu.orientation.started}/`
      + `${result.imu.orientation.firstReading}，不可用/错误 `
      + `${result.imu.orientation.unavailable}/${result.imu.orientation.errors}`,
  );
  if (snapshot && snapshot.imuQuality) {
    lines.push(
      `- 质量门: ${snapshot.imuQuality.state}/`
        + `${snapshot.imuQuality.artifact}，quality=`
        + `${formatNumber(snapshot.imuQuality.quality, 2)}`,
    );
  }

  lines.push('GPS 运行证据:');
  lines.push(
    `- watch 启动 ${result.gps.watchStarted} 次，停止 ${result.gps.watchStopped} 次，`
      + `状态 ${joinOrNone(result.gps.states)}`,
  );
  lines.push(
    `- 接受路径段最多 ${result.gps.maxAcceptedSegments}，`
      + `拒绝位置最多 ${result.gps.maxRejectedPositions}，`
      + `断流 ${result.gps.stalls.length} 次，重启 ${result.gps.restarts.length} 次，`
      + `耗尽 ${result.gps.restartExhausted} 次`,
  );
  if (result.gps.errors.length || result.gps.unavailable) {
    lines.push(
      `- 定位错误码 ${joinOrNone(result.gps.errors)}，`
        + `不可用 ${result.gps.unavailable} 次`,
    );
  }

  lines.push('BLE 来源:');
  lines.push(
    `- 实收通知: ${joinOrNone(result.ble.packetSources.map(sourceLabel))}；`
      + `订阅声明: ${joinOrNone(result.ble.subscribedSources.map(sourceLabel))}`,
  );

  if (result.missing.length) {
    lines.push('待补证据:');
    result.missing.forEach((item) => lines.push(`- ${item}`));
  } else {
    lines.push('待补证据: 无日志级缺口；仍需对照 HUD/总结照片和真实路线精度。');
  }
  lines.push('说明: PASS 只代表日志门通过，不替代 Craft/InkView、真机操作和户外精度验收。');
  return lines.join('\n');
}

function printUsage() {
  console.error('用法: node tools/analyze_field_log.mjs /绝对路径/aibike-console.log');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const inputPath = process.argv[2];
  if (!inputPath || process.argv.length > 3) {
    printUsage();
    process.exitCode = 1;
  } else {
    try {
      const text = fs.readFileSync(path.resolve(inputPath), 'utf8');
      const result = analyzeFieldLog(text);
      console.log(formatFieldLogReport(result));
      process.exitCode = result.status === 'PASS' ? 0 : 2;
    } catch (error) {
      console.error(`读取日志失败: ${error && error.message ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
