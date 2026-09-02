// 骑行统一指标聚合器。
//
// 数据边界：
// - CSC/CPS 的曲柄事件直接给踏频，不复用 Running Speed and Cadence 的脚步语义。
// - CSC/CPS/FTMS 实测值始终优先。
// - FTMS、CSC、CPS 各自维护 freshness 与重连基线；来源切换先重锚。
// - 无外设时，眼镜 IMU 只在稳定周期门通过后提供“估算”踏频；速度和
//   距离使用本机配置的固定每曲柄圈模型，不能冒充轮速实测。

import {
  crankCadenceRpm,
  parseCscMeasurement,
  parseCyclingPower,
  wheelDeltaMetrics,
} from './cycling.js';
import { parseIndoorBikeData } from './ftms.js';
import {
  CyclingImuEstimateStabilizer,
  DEFAULT_IMU_METERS_PER_CRANK,
  estimateImuFallbackSpeedKmh,
} from './cycling_imu_speed.js';

export const CYCLING_METRIC_STATES = Object.freeze({
  UNSUPPORTED: 'unsupported',
  SUBSCRIBED: 'subscribed',
  LIVE: 'live',
  EXPLICIT_ZERO: 'explicit_zero',
  STALE: 'stale',
});

export const CYCLING_SOURCE_PRIORITY = Object.freeze({
  speed: Object.freeze(['csc', 'cps', 'ftms', 'imu']),
  cadence: Object.freeze(['cps', 'csc', 'ftms', 'imu']),
  power: Object.freeze(['cps', 'ftms']),
  heartRate: Object.freeze(['hrs', 'ftms']),
  distance: Object.freeze([
    'cscWheel',
    'cpsWheel',
    'ftmsTotal',
    'ftmsSpeed',
    'imuEstimate',
  ]),
});

const BLE_SOURCES = new Set(['hrs', 'csc', 'cps', 'ftms']);
const ALL_SOURCES = Object.freeze(['hrs', 'csc', 'cps', 'ftms', 'imu']);
const METRIC_NAMES = ['speed', 'cadence', 'power', 'heartRate'];
// Hermes 派生样本表明真实骑行中的头戴周期置信度会反复落入 0.55–0.80；
// 同场 Garmin FIT 只证明位移连续，因没有踏频字段，不能用于标定该置信度。
// 距离账本进入仍要求连续强证据；确认后只要同一强候选通道仍 fresh、moving
// 且无伪动作，就用较低维持门避免正常低谷反复清空距离锚。
const IMU_DISTANCE_CANDIDATE_ENTER_CONFIDENCE = 0.68;
const IMU_DISTANCE_CANDIDATE_MAINTAIN_CONFIDENCE = 0.55;
const IMU_DISTANCE_CANDIDATE_CONFIRM_SAMPLES = 3;
const IMU_DISTANCE_CANDIDATE_CONFIRM_SPAN_MS = 1500;

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function validWheelCircumference(value) {
  return Number.isFinite(value) && value >= 500 && value <= 4000;
}

function metricRecord(mode = 'direct') {
  return {
    value: null,
    atMs: null,
    observedAtMs: null,
    holdMs: null,
    ever: false,
    mode,
  };
}

function sourceRecord() {
  return {
    subscribed: false,
    everSubscribed: false,
    subscribedAtMs: null,
    lastPacketMs: null,
    speed: metricRecord(),
    cadence: metricRecord(),
    power: metricRecord(),
    heartRate: metricRecord(),
    wheelPrev: null,
    wheelResetCandidate: null,
    crankPrev: null,
    crankResetCandidate: null,
  };
}

function distanceInput(source, mode) {
  return {
    source,
    mode,
    availableAtMs: null,
    anchor: null,
    anchorAtMs: null,
    stallCount: 0,
    fieldMissingCount: 0,
    speedFallbackActive: false,
    pendingSpeedDistanceM: 0,
    resetCandidate: null,
    pendingSegments: [],
  };
}

function averageTracker(startMs, includeValue) {
  return {
    sumValueMs: 0,
    durationMs: 0,
    current: null,
    lastMs: startMs,
    includeValue,
  };
}

function movementTracker(startMs) {
  return {
    movingMs: 0,
    current: null,
    lastMs: startMs,
  };
}

function copyCounter(value, eventField) {
  if (!value) return null;
  return {
    revolutions: value.revolutions,
    [eventField]: value[eventField],
  };
}

function eventChanged(previous, current, eventField) {
  return previous.revolutions !== current.revolutions
    || previous[eventField] !== current[eventField];
}

function normalizeParsed(value, parser, shapeKey) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, shapeKey)) {
    return value;
  }
  return parser(value);
}

function fixedImuRolloutState(metersPerCrank, nowMs = 0) {
  return {
    calibrationState: 'fixed',
    confidence: 0,
    locked: false,
    metersPerCrank,
    learnedMetersPerCrank: null,
    acceptedWindowCount: 0,
    likelyWalk: false,
    suppressImu: false,
    indoorUnverified: true,
    rawLikelyWalk: false,
    rawSuppressImu: false,
    physicalCyclingEvidence: false,
    atMs: nowMs,
  };
}

export class CyclingMetrics {
  constructor(options = {}) {
    this.startMs = finite(options.startMs, 0);
    // 构造参数仍沿用原公开名称；内部改用 Limit 后缀，避免和总结峰值同名。
    this.speedLimitKmh = Math.max(10, finite(options.maxSpeedKmh, 120));
    this.cadenceLimitRpm = Math.max(30, finite(options.maxCadenceRpm, 250));
    this.minPowerW = finite(options.minPowerW, -2000);
    this.powerLimitW = Math.max(this.minPowerW, finite(options.maxPowerW, 5000));
    this.metricStaleMs = Math.max(500, finite(options.metricStaleMs, 3000));
    this.packetStaleMs = Math.max(this.metricStaleMs, finite(options.packetStaleMs, 8000));
    this.coastMs = Math.max(500, finite(options.coastMs, 3000));
    // 低踏频与低轮速的合法相邻事件可能天然超过固定 3 秒。事件值至少保留
    // 1.5 个最近周期，但最多 8 秒；直接字段仍使用普通 freshness。
    this.eventHoldMaxMs = Math.max(
      this.coastMs,
      finite(options.eventHoldMaxMs, 8000),
    );
    this.heartRateStaleMs = Math.max(1000, finite(options.heartRateStaleMs, 8000));
    this.imuStaleMs = Math.max(250, finite(options.imuStaleMs, 1500));
    this.maxDistanceGapMs = Math.max(1000, finite(options.maxDistanceGapMs, 8000));
    // AR 录屏掉帧后，IMU 恢复首帧只重锚，不能补算无传感器证据的区间。
    this.imuDistanceMaxGapMs = Math.max(
      500,
      Math.min(
        this.maxDistanceGapMs,
        finite(options.imuDistanceMaxGapMs, 1800),
      ),
    );
    this.ftmsTotalStallSamples = Math.max(
      2,
      Math.min(3, Math.round(finite(options.ftmsTotalStallSamples, 2))),
    );
    this.movingSpeedThresholdKmh = Math.max(
      0,
      finite(options.movingSpeedThresholdKmh, 1.5),
    );
    this.movingPowerThresholdW = Math.max(0, finite(options.movingPowerThresholdW, 5));
    this.wheelCircumferenceMm = validWheelCircumference(options.wheelCircumferenceMm)
      ? options.wheelCircumferenceMm
      : null;
    this.imuMetersPerCrank = Number.isFinite(options.imuMetersPerCrank)
      && options.imuMetersPerCrank >= 2
      && options.imuMetersPerCrank <= 12
      ? options.imuMetersPerCrank
      : DEFAULT_IMU_METERS_PER_CRANK;
    this.rolloutState = fixedImuRolloutState(
      this.imuMetersPerCrank,
      this.startMs,
    );

    this.sources = {
      hrs: sourceRecord(),
      csc: sourceRecord(),
      cps: sourceRecord(),
      ftms: sourceRecord(),
      imu: sourceRecord(),
    };
    this.distanceInputs = {
      cscWheel: distanceInput('csc', 'wheel'),
      cpsWheel: distanceInput('cps', 'wheel'),
      ftmsTotal: distanceInput('ftms', 'total'),
      ftmsSpeed: distanceInput('ftms', 'speed_integration'),
      imuEstimate: distanceInput('imu', 'cadence_model'),
    };

    this.distanceM = 0;
    this.distanceEverAvailable = false;
    this.activeDistanceSource = null;
    // 结束时某个来源可能已经 stale。总结必须保留曾参与聚合的来源，
    // 否则 IMU 覆盖段会被误写成实测值。
    this.summarySourcesUsed = new Set();
    this.metricSourcesUsed = {
      speed: new Set(),
      cadence: new Set(),
      power: new Set(),
      heartRate: new Set(),
    };
    // 距离的估算标记不能由当前瞬时 source 推断：结束前 IMU 可能已
    // stale，也可能已被真实轮速抢占。单独保留实际写入距离账本的来源。
    this.distanceSourcesUsed = new Set();
    // 距离均速必须使用“已计入距离实际覆盖的运动时长”，不能使用 UI 收包后
    // 向前延长的 freshness/movement 窗口。后者会漏掉首个轮事件段，并在低速
    // 长周期下把短途均速放大。
    this.distanceCoverageMs = 0;
    this.distanceCoverageEndMs = null;
    this.distanceCoverageIntervals = [];
    // 全局区间用于跨来源去重；逐输入区间保留归属，使 CSC/CPS 同一计数器
    // 因 BLE 批量回调而映射到重叠 arrival wall time 时，合法轮事件仍能全量
    // 入账。不同输入（例如 CSC 与 FTMS）之间仍按墙钟覆盖去重。
    this.distanceCoverageByKey = Object.fromEntries(
      Object.keys(this.distanceInputs).map((key) => [key, []]),
    );

    this.paused = false;
    this.pauseStartMs = null;
    this.pausedAccumMs = 0;

    this.cadenceAverage = averageTracker(this.startMs, (value) => value > 0);
    this.powerAverage = averageTracker(this.startMs, (value) => Number.isFinite(value));
    this.movement = movementTracker(this.startMs);
    // 心率平均采用“被当前来源仲裁选中的有效通知样本算术平均”。它不按 UI
    // snapshot 次数加权，也不会为 stale 窗口补样本；暂停中的通知完全不计。
    this.heartRateSampleSum = 0;
    this.heartRateSampleCount = 0;
    this.peakBpm = null;
    this.peakSpeedKmh = null;
    this.peakCadenceRpm = null;
    this.peakPowerW = null;
    this.imuAssist = null;
    this.imuEstimateStabilizer = new CyclingImuEstimateStabilizer();
    this.imuDistanceCandidateGate = {
      count: 0,
      firstAtMs: null,
      lastAtMs: null,
      confirmed: false,
    };
  }

  setWheelCircumferenceMm(value, nowMs) {
    const disabling = value == null;
    if (!disabling && !validWheelCircumference(value)) return false;
    const at = finite(nowMs, this.startMs);
    this._beforeUpdate(at);
    this.wheelCircumferenceMm = disabling ? null : value;

    for (const sourceName of ['csc', 'cps']) {
      const source = this.sources[sourceName];
      source.wheelPrev = null;
      const oldEver = source.speed.ever;
      source.speed = metricRecord('event');
      source.speed.ever = oldEver;
    }
    this._clearDistanceInput('cscWheel');
    this._clearDistanceInput('cpsWheel');
    if (this.activeDistanceSource === 'cscWheel' || this.activeDistanceSource === 'cpsWheel') {
      this.activeDistanceSource = null;
    }
    this._afterUpdate(at);
    return true;
  }

  markSourceSubscribed(sourceName, nowMs) {
    if (!BLE_SOURCES.has(sourceName) || !Number.isFinite(nowMs)) return false;
    this._beforeUpdate(nowMs);
    const source = this.sources[sourceName];
    this._resetSourceRuntime(sourceName, true);
    source.subscribed = true;
    source.everSubscribed = true;
    source.subscribedAtMs = nowMs;
    this._afterUpdate(nowMs);
    return true;
  }

  markSourceDisconnected(sourceName, nowMs) {
    if (!BLE_SOURCES.has(sourceName) || !Number.isFinite(nowMs)) return false;
    this._beforeUpdate(nowMs);
    const source = this.sources[sourceName];
    source.subscribed = false;
    source.lastPacketMs = null;
    source.subscribedAtMs = null;
    source.wheelPrev = null;
    source.crankPrev = null;
    for (const metricName of METRIC_NAMES) {
      const oldEver = source[metricName].ever;
      source[metricName] = metricRecord();
      source[metricName].ever = oldEver;
    }
    this._clearSourceDistanceInputs(sourceName);
    this._afterUpdate(nowMs);
    return true;
  }

  disconnectAll(nowMs) {
    if (!Number.isFinite(nowMs)) return false;
    this._beforeUpdate(nowMs);
    for (const sourceName of BLE_SOURCES) {
      const source = this.sources[sourceName];
      source.subscribed = false;
      source.lastPacketMs = null;
      source.subscribedAtMs = null;
      source.wheelPrev = null;
      source.crankPrev = null;
      for (const metricName of METRIC_NAMES) {
        const oldEver = source[metricName].ever;
        source[metricName] = metricRecord();
        source[metricName].ever = oldEver;
      }
      this._clearSourceDistanceInputs(sourceName);
    }
    this.activeDistanceSource = null;
    this._afterUpdate(nowMs);
    return true;
  }

  onHeartRate(bpm, nowMs) {
    if (!Number.isFinite(nowMs)) return false;
    if (!(Number.isFinite(bpm) && bpm > 0 && bpm < 255)) return false;
    if (this._sourcePacketWouldGoBack('hrs', nowMs)) return false;
    this._beforeUpdate(nowMs);
    this._touchSource('hrs', nowMs);
    if (!this.paused) this._setMetric('hrs', 'heartRate', bpm, nowMs, 'direct');
    this._afterUpdate(nowMs);
    if (!this.paused) this._recordHeartRateSample('hrs', bpm, nowMs);
    return true;
  }

  onHeartRateContactLost(nowMs) {
    if (!Number.isFinite(nowMs)) return false;
    if (this._sourcePacketWouldGoBack('hrs', nowMs)) return false;
    this._beforeUpdate(nowMs);
    this._touchSource('hrs', nowMs);
    this._invalidateMetric('hrs', 'heartRate');
    this._afterUpdate(nowMs);
    return true;
  }

  onCsc(value, nowMs) {
    if (!Number.isFinite(nowMs)) return false;
    const measurement = normalizeParsed(value, parseCscMeasurement, 'crank');
    if (!measurement) return false;
    if (this._sourcePacketWouldGoBack('csc', nowMs)) return false;

    this._beforeUpdate(nowMs);
    this._touchSource('csc', nowMs);
    if (!this.paused) {
      if (measurement.crank) this._handleCrank('csc', measurement.crank, nowMs);
      if (measurement.wheel) {
        this._handleWheel(
          'csc',
          'cscWheel',
          measurement.wheel,
          'lastEventTime1024',
          1024,
          nowMs,
        );
      }
    }
    this._afterUpdate(nowMs);
    return true;
  }

  onCyclingPower(value, nowMs) {
    if (!Number.isFinite(nowMs)) return false;
    const measurement = normalizeParsed(value, parseCyclingPower, 'powerW');
    if (!measurement) return false;
    if (this._sourcePacketWouldGoBack('cps', nowMs)) return false;

    this._beforeUpdate(nowMs);
    this._touchSource('cps', nowMs);
    if (!this.paused) {
      if (Number.isFinite(measurement.powerW)
        && measurement.powerW >= this.minPowerW
        && measurement.powerW <= this.powerLimitW) {
        this._setMetric('cps', 'power', measurement.powerW, nowMs, 'direct');
      } else {
        this._invalidateMetric('cps', 'power');
      }
      if (measurement.crank) this._handleCrank('cps', measurement.crank, nowMs);
      if (measurement.wheel) {
        this._handleWheel(
          'cps',
          'cpsWheel',
          measurement.wheel,
          'lastEventTime2048',
          2048,
          nowMs,
        );
      }
    }
    this._afterUpdate(nowMs);
    return true;
  }

  onFtms(value, nowMs) {
    if (!Number.isFinite(nowMs)) return false;
    const measurement = normalizeParsed(value, parseIndoorBikeData, 'speedKmh');
    if (!measurement) return false;
    if (this._sourcePacketWouldGoBack('ftms', nowMs)) return false;

    this._beforeUpdate(nowMs);
    this._touchSource('ftms', nowMs);
    let acceptedHeartRateBpm = null;
    let acceptedSpeedKmh = null;
    let speedSegmentDistanceM = null;
    if (!this.paused) {
      if (measurement.speedKmh != null) {
        if (Number.isFinite(measurement.speedKmh)
          && measurement.speedKmh >= 0
          && measurement.speedKmh <= this.speedLimitKmh) {
          this._setMetric('ftms', 'speed', measurement.speedKmh, nowMs, 'direct');
          acceptedSpeedKmh = measurement.speedKmh;
          speedSegmentDistanceM = this._handleFtmsSpeed(
            measurement.speedKmh,
            nowMs,
          );
        } else {
          this._invalidateMetric('ftms', 'speed');
          this._clearDistanceInput('ftmsSpeed');
        }
      }
      if (measurement.cadenceRpm != null) {
        if (Number.isFinite(measurement.cadenceRpm)
          && measurement.cadenceRpm >= 0
          && measurement.cadenceRpm <= this.cadenceLimitRpm) {
          this._setMetric('ftms', 'cadence', measurement.cadenceRpm, nowMs, 'direct');
        } else {
          this._invalidateMetric('ftms', 'cadence');
        }
      }
      if (measurement.powerW != null) {
        if (Number.isFinite(measurement.powerW)
          && measurement.powerW >= this.minPowerW
          && measurement.powerW <= this.powerLimitW) {
          this._setMetric('ftms', 'power', measurement.powerW, nowMs, 'direct');
        } else {
          this._invalidateMetric('ftms', 'power');
        }
      }
      if (measurement.heartRateBpm != null) {
        if (Number.isFinite(measurement.heartRateBpm)
          && measurement.heartRateBpm > 0
          && measurement.heartRateBpm < 255) {
          this._setMetric('ftms', 'heartRate', measurement.heartRateBpm, nowMs, 'direct');
          acceptedHeartRateBpm = measurement.heartRateBpm;
        } else {
          this._invalidateMetric('ftms', 'heartRate');
        }
      }
      if (Number.isFinite(measurement.totalDistanceM) && measurement.totalDistanceM >= 0) {
        this._handleFtmsTotal(measurement.totalDistanceM, nowMs, {
          speedKmh: acceptedSpeedKmh,
          speedSegmentDistanceM,
        });
      } else if (acceptedSpeedKmh != null) {
        this._handleFtmsTotalMissing(
          nowMs,
          acceptedSpeedKmh,
          speedSegmentDistanceM,
        );
      }
    }
    this._afterUpdate(nowMs);
    if (acceptedHeartRateBpm != null) {
      this._recordHeartRateSample('ftms', acceptedHeartRateBpm, nowMs);
    }
    return true;
  }

  /**
   * 接收 CyclingImuActivity.snapshot()。fresh candidate 可先点亮踏频/速度，
   * 但距离账本另设更严格的连续确认门；确认前只显示、不回填里程。
   */
  onImuActivity(activity, nowMs) {
    if (!activity || typeof activity !== 'object' || !Number.isFinite(nowMs)) return false;
    if (this._sourcePacketWouldGoBack('imu', nowMs)) return false;
    this._beforeUpdate(nowMs);
    const previousImuAssist = this.imuAssist;
    const allowedStates = new Set(['unknown', 'moving', 'stationary', 'stale']);
    const motionState = allowedStates.has(activity.motionState)
      ? activity.motionState
      : 'unknown';
    const cadenceConfidence = Number.isFinite(activity.effectiveCadenceConfidence)
      ? Math.max(0, Math.min(1, activity.effectiveCadenceConfidence))
      : Number.isFinite(activity.cadenceConfidence)
        ? Math.max(0, Math.min(1, activity.cadenceConfidence))
      : 0;
    const candidateCadenceRpm = Number.isFinite(activity.candidateCadenceRpm)
      ? activity.candidateCadenceRpm : null;
    const finalCadenceRpm = Number.isFinite(activity.finalCadenceRpm)
      ? activity.finalCadenceRpm : null;
    const effectiveCadenceRpm = Number.isFinite(activity.effectiveCadenceRpm)
      ? activity.effectiveCadenceRpm : finalCadenceRpm;
    const cadenceEstimateLevel = typeof activity.cadenceEstimateLevel === 'string'
      ? activity.cadenceEstimateLevel
      : (finalCadenceRpm > 0 ? 'locked' : 'none');
    const cadenceUsable = activity.cadenceUsable === true
      || (activity.cadenceUsable == null && finalCadenceRpm > 0);
    const availabilityCadenceUsable = activity.availabilityCadenceUsable === true
      || (activity.availabilityCadenceUsable == null
        && cadenceEstimateLevel === 'candidate'
        && effectiveCadenceRpm > 0
        && cadenceConfidence >= 0.55);
    const cadenceState = typeof activity.cadenceState === 'string'
      ? activity.cadenceState : 'unknown';
    const motionArtifact = typeof activity.motionArtifact === 'string'
      ? activity.motionArtifact : 'none';
    const motionQualityState = typeof activity.motionQualityState === 'string'
      ? activity.motionQualityState : 'unavailable';
    this.rolloutState = this._effectiveRolloutSnapshot(nowMs);
    const effectiveMetersPerCrank = this.rolloutState.metersPerCrank;
    const speedModelAvailable = Number.isFinite(activity.estimatedSpeedKmh)
      || Number.isFinite(activity.metersPerCrank);
    const estimateCadenceRpm = finalCadenceRpm > 0
      ? finalCadenceRpm : effectiveCadenceRpm;
    const availabilityEstimate = !(finalCadenceRpm > 0)
      && availabilityCadenceUsable;
    const estimatedSpeedKmh = estimateCadenceRpm > 0 && speedModelAvailable
      ? estimateImuFallbackSpeedKmh(
        estimateCadenceRpm,
        {
          walkingLike: activity.walkingLike === true,
          estimateLevel: availabilityEstimate
            ? 'candidate' : cadenceEstimateLevel,
          calibrated: false,
          metersPerCrank: availabilityEstimate
            ? DEFAULT_IMU_METERS_PER_CRANK : effectiveMetersPerCrank,
          speedLimitKmh: this.speedLimitKmh,
        },
      )
      : null;
    this.imuAssist = {
      motionState,
      confidence: Number.isFinite(activity.confidence)
        ? Math.max(0, Math.min(1, activity.confidence))
        : 0,
      fresh: Boolean(activity.fresh),
      autoPauseSuggested: Boolean(activity.autoPauseSuggested),
      autoResumeSuggested: Boolean(activity.autoResumeSuggested),
      cadenceState,
      motionArtifact,
      motionQualityState,
      cadenceConfidence,
      candidateCadenceRpm,
      finalCadenceRpm,
      effectiveCadenceRpm,
      cadenceEstimateLevel,
      cadenceSensorSource: typeof activity.cadenceSensorSource === 'string'
        ? activity.cadenceSensorSource : 'none',
      cadenceUsable,
      availabilityCadenceUsable,
      simpleGyroLedgerFresh: activity.simpleGyroLedgerFresh === true,
      simpleGyroCadenceMethod: typeof activity.simpleGyroCadenceMethod === 'string'
        ? activity.simpleGyroCadenceMethod : 'none',
      simpleGyroAnalysisState: typeof activity.simpleGyroAnalysisState === 'string'
        ? activity.simpleGyroAnalysisState : 'none',
      rawMotionArtifact: typeof activity.rawMotionArtifact === 'string'
        ? activity.rawMotionArtifact : motionArtifact,
      availabilityEstimateActive: availabilityEstimate,
      estimatedSpeedKmh,
      walkingLike: activity.walkingLike === true,
      walkingLikeConfidence: Number.isFinite(activity.walkingLikeConfidence)
        ? Math.max(0, Math.min(1, activity.walkingLikeConfidence)) : 0,
      speedEstimateProfile: typeof activity.speedEstimateProfile === 'string'
        ? activity.speedEstimateProfile : 'cycling_unverified',
      cadenceCorrelation: Number.isFinite(activity.cadenceCorrelation)
        ? activity.cadenceCorrelation : null,
      metersPerCrank: effectiveMetersPerCrank,
      configuredMetersPerCrank: Number.isFinite(activity.metersPerCrank)
        ? activity.metersPerCrank : this.imuMetersPerCrank,
      rolloutCalibrationState: this.rolloutState.calibrationState,
      rolloutConfidence: this.rolloutState.confidence,
      rolloutLocked: this.rolloutState.locked,
      rolloutAcceptedWindowCount: this.rolloutState.acceptedWindowCount,
      rolloutLearnedMetersPerCrank:
        this.rolloutState.learnedMetersPerCrank,
      likelyWalk: this.rolloutState.likelyWalk,
      suppressImu: this.rolloutState.suppressImu,
      indoorUnverified: this.rolloutState.indoorUnverified,
      accelerationUnit: activity.accelerationUnit || 'unknown',
      accelerationCalibrated: activity.accelerationCalibrated === true,
      atMs: nowMs,
    };

    const source = this.sources.imu;
    if (!source.subscribed) {
      source.subscribed = true;
      source.everSubscribed = true;
      source.subscribedAtMs = nowMs;
    }
    source.lastPacketMs = nowMs;

    const candidateEstimate = availabilityEstimate
      && activity.fresh === true
      && cadenceConfidence >= 0.55
      && estimateCadenceRpm <= this.cadenceLimitRpm
      && motionArtifact !== 'touch';
    const imuDistanceInput = this.distanceInputs.imuEstimate;
    const softArtifact = motionArtifact === 'head_turn'
      || motionArtifact === 'road_impact';
    const anchorAgeMs = imuDistanceInput.anchorAtMs == null
      ? null : nowMs - imuDistanceInput.anchorAtMs;
    const hasBoundedDistanceAnchor = imuDistanceInput.anchor != null
      && Number.isFinite(anchorAgeMs)
      && anchorAgeMs > 0
      && anchorAgeMs <= this.imuDistanceMaxGapMs;
    const previousSimpleGyroLedgerFresh = previousImuAssist
      && previousImuAssist.fresh === true
      && previousImuAssist.simpleGyroLedgerFresh === true
      && Number.isFinite(previousImuAssist.atMs)
      && nowMs >= previousImuAssist.atMs
      && nowMs - previousImuAssist.atMs <= this.imuDistanceMaxGapMs;
    const hasFreshSimpleGyroLedger = activity.simpleGyroLedgerFresh === true
      || previousSimpleGyroLedgerFresh;
    const softArtifactCanBridge = !this.paused
      && softArtifact
      && activity.fresh === true
      && motionState === 'moving'
      && hasBoundedDistanceAnchor
      && (hasFreshSimpleGyroLedger
        || this.imuDistanceCandidateGate.confirmed === true);
    const stationary = !this.paused
      && activity.fresh === true
      && motionState === 'stationary'
      && cadenceState === 'stationary';

    if (stationary) {
      // 明确静止是硬边界：绝不能用上一帧速度到 0 的梯形面积补出停车距离。
      // 当前帧只发布 explicit zero，同时立刻清除旧锚；重新运动的首帧重锚。
      this.imuEstimateStabilizer.reset();
      this._resetImuDistanceCandidateGate();
      if (source.cadence.ever) {
        this._setMetric('imu', 'cadence', 0, nowMs, 'direct');
        this._setMetric('imu', 'speed', 0, nowMs, 'direct');
      } else {
        this._invalidateMetric('imu', 'cadence');
        this._invalidateMetric('imu', 'speed');
      }
      this._clearImuDistanceInput(nowMs);
      this._afterUpdate(nowMs);
      return true;
    }

    if (softArtifactCanBridge) {
      // 已经形成可信账本后，转头/路面冲击通常只是短暂遮挡，并不等同于
      // 停车。当前污染帧不写指标、不推进距离，只暂时撤销 source 可用性并
      // 保留有界锚。若 1.8 秒内恢复，下一可信帧可桥接这一个短段；超时则
      // _handleImuSpeed 只重锚。首次 candidate 的 0.68 + 3 窗/1.5 秒门不变。
      this._invalidateMetric('imu', 'cadence');
      this._invalidateMetric('imu', 'speed');
      this.imuAssist.distanceLedgerEligible = false;
      this._suspendImuDistanceInput(nowMs);
      this._afterUpdate(nowMs);
      return true;
    }

    if (motionArtifact !== 'none' && !candidateEstimate) {
      // touch、长软干扰或没有既有可信账本的污染帧都是硬中断。只有上面的
      // 有界 soft bridge 可以保留锚；其他情况恢复首帧一律只重锚。
      this._invalidateMetric('imu', 'cadence');
      this._invalidateMetric('imu', 'speed');
      this._resetImuDistanceCandidateGate();
      if (motionArtifact === 'touch') {
        this.imuEstimateStabilizer.reset();
      }
      this._clearImuDistanceInput(nowMs);
      this._afterUpdate(nowMs);
      return true;
    }

    const estimated = !this.paused
      && activity.fresh === true
      && (candidateEstimate || (
        motionState === 'moving'
        && cadenceConfidence >= 0.58
        && cadenceUsable
        && finalCadenceRpm > 0
      ))
      && estimateCadenceRpm > 0
      && estimateCadenceRpm <= this.cadenceLimitRpm
      && estimatedSpeedKmh > 0
      && estimatedSpeedKmh <= this.speedLimitKmh;
    if (estimated) {
      const mode = candidateEstimate ? 'candidate_estimate' : 'direct';
      const candidateWasConfirmed = candidateEstimate
        && this.imuDistanceCandidateGate.confirmed === true;
      const candidateAnchorWasContinuous = candidateEstimate
        && this.distanceInputs.imuEstimate.anchor != null
        && this.distanceInputs.imuEstimate.anchorAtMs != null
        && nowMs > this.distanceInputs.imuEstimate.anchorAtMs
        && nowMs - this.distanceInputs.imuEstimate.anchorAtMs
          <= this.imuDistanceMaxGapMs;
      const distanceLedgerEligible = candidateEstimate
        ? this._observeImuDistanceCandidate(
          cadenceConfidence >= IMU_DISTANCE_CANDIDATE_ENTER_CONFIDENCE
            && motionState === 'moving'
            && motionArtifact === 'none',
          cadenceConfidence >= IMU_DISTANCE_CANDIDATE_MAINTAIN_CONFIDENCE
            && motionState === 'moving'
            && motionArtifact === 'none',
          nowMs,
        )
        : true;
      if (!candidateEstimate) this._resetImuDistanceCandidateGate();
      this.imuAssist.distanceLedgerEligible = distanceLedgerEligible;
      const stabilized = this.imuEstimateStabilizer.observe(
        estimateCadenceRpm,
        estimatedSpeedKmh,
        nowMs,
      );
      if (stabilized) {
        this.imuAssist.rawEstimatedCadenceRpm = estimateCadenceRpm;
        this.imuAssist.rawEstimatedSpeedKmh = estimatedSpeedKmh;
        this.imuAssist.stabilizedCadenceRpm = stabilized.cadenceRpm;
        this.imuAssist.stabilizedSpeedKmh = stabilized.speedKmh;
        this.imuAssist.estimateStabilized = stabilized.held === true;
        if (stabilized.acceptedForLedger === true) {
          this.imuAssist.estimatedSpeedKmh = stabilized.speedKmh;
          this._setMetric('imu', 'cadence', stabilized.cadenceRpm, nowMs, mode);
          this._setMetric('imu', 'speed', stabilized.speedKmh, nowMs, mode);
          if (distanceLedgerEligible) {
            // 从未确认/掉门状态重新进入时，本帧只建立新距离基线；只有已在
            // 连续账本内维持的 candidate 才能积分到当前帧。
            if (candidateEstimate
                && (!candidateWasConfirmed || !candidateAnchorWasContinuous)) {
              this._clearDistanceInput('imuEstimate');
            }
            this._handleImuSpeed(stabilized.speedKmh, nowMs);
          } else {
            // candidate 可见不等于可结算。证据掉出维持门后立即切断距离锚；
            // 再次确认的首帧只建立新基线，绝不回填展示期或低置信空档。
            this._clearDistanceInput('imuEstimate');
            if (this.activeDistanceSource === 'imuEstimate') {
              this.activeDistanceSource = null;
            }
            this._selectDistanceSource(nowMs);
          }
        }
      }
    } else {
      // stale、unknown、低置信或 cadence 不可用都不能沿用旧锚。这里不把
      // 不可信帧解释成 0，只切断距离连续性；下一次可信运动首帧重新建立锚。
      this._resetImuDistanceCandidateGate();
      this._clearImuDistanceInput(nowMs);
    }
    this._afterUpdate(nowMs);
    return true;
  }

  /**
   * 传感器实例重建会产生一个没有周期证据的短空档。显式切断 IMU 距离锚，
   * 使恢复首帧只建立新基线；即使重启快于 imuDistanceMaxGapMs，也不能把
   * 空档按旧速度补成幽灵里程。HUD 的最近可信显示不在指标层，因此不受影响。
   */
  markImuDiscontinuity(nowMs) {
    if (!Number.isFinite(nowMs)) return false;
    this._beforeUpdate(nowMs);
    // 句柄/时间纪元切换后不让旧 pending 跳变候选影响新一代样本。
    this.imuEstimateStabilizer.reset();
    this._resetImuDistanceCandidateGate();
    this._clearDistanceInput('imuEstimate');
    if (this.activeDistanceSource === 'imuEstimate') {
      this.activeDistanceSource = null;
    }
    this._selectDistanceSource(nowMs);
    this._afterUpdate(nowMs);
    return true;
  }

  pause(nowMs) {
    if (this.paused || !Number.isFinite(nowMs)) return false;
    this._beforeUpdate(nowMs);
    this._finalizePendingDistanceSegments();
    this.paused = true;
    this.pauseStartMs = nowMs;
    this.cadenceAverage.current = null;
    this.powerAverage.current = null;
    this.movement.current = null;
    this._resetImuDistanceCandidateGate();
    this._resetAllAnchors();
    this._afterUpdate(nowMs);
    return true;
  }

  resume(nowMs) {
    if (!this.paused || !Number.isFinite(nowMs) || nowMs < this.pauseStartMs) return false;
    this._beforeUpdate(nowMs);
    this.pausedAccumMs += nowMs - this.pauseStartMs;
    this.pauseStartMs = null;
    this.paused = false;

    // 暂停期间通知可能仍在到达；恢复必须等待新包重新建立所有计数器基线。
    for (const sourceName of ALL_SOURCES) {
      const source = this.sources[sourceName];
      source.lastPacketMs = null;
      source.subscribedAtMs = source.subscribed ? nowMs : null;
      source.wheelPrev = null;
      source.crankPrev = null;
      for (const metricName of METRIC_NAMES) {
        const oldEver = source[metricName].ever;
        source[metricName] = metricRecord();
        source[metricName].ever = oldEver;
      }
    }
    this._resetAllAnchors();
    this._resetImuDistanceCandidateGate();
    this._afterUpdate(nowMs);
    return true;
  }

  /**
   * 显式结束前结算所有来源已经形成、但因更高优先级来源 fresh 而暂存的段。
   * 按固定优先级提交且只写入未覆盖墙钟区间，多次调用保持幂等。
   */
  finalizeDistance(nowMs) {
    if (!Number.isFinite(nowMs)) return false;
    this._beforeUpdate(nowMs);
    this._finalizePendingDistanceSegments();
    this._afterUpdate(nowMs);
    return true;
  }

  elapsedMs(nowMs) {
    if (!Number.isFinite(nowMs)) return 0;
    const pausedNow = this.paused ? Math.max(0, nowMs - this.pauseStartMs) : 0;
    return Math.max(0, nowMs - this.startMs - this.pausedAccumMs - pausedNow);
  }

  snapshot(nowMs) {
    const at = Number.isFinite(nowMs) ? nowMs : this.startMs;
    this._beforeUpdate(at);
    this._afterUpdate(at);
    this._selectDistanceSource(at);

    const speed = this._selectMetric('speed', at);
    const cadence = this._selectMetric('cadence', at);
    const power = this._selectMetric('power', at);
    const heartRate = this._selectMetric('heartRate', at);
    const movingMs = this.movement.movingMs;
    const elapsedMs = this.elapsedMs(at);
    const distance = this._distanceSnapshot(at);
    this.rolloutState = this._effectiveRolloutSnapshot(at);
    const liveValue = (metric) => (
      metric.state === CYCLING_METRIC_STATES.LIVE
        || metric.state === CYCLING_METRIC_STATES.EXPLICIT_ZERO
        ? metric.value
        : null
    );

    return {
      elapsedMs,
      movingMs,
      distanceM: this.distanceM,
      distanceEverAvailable: this.distanceEverAvailable,
      distanceCoverageMs: this.distanceCoverageMs,
      distanceState: distance.state,
      distanceSource: distance.source,
      distanceMode: distance.mode,
      summarySourcesUsed: [...this.summarySourcesUsed],
      distanceSourcesUsed: [...this.distanceSourcesUsed],
      metricSourcesUsed: {
        speed: [...this.metricSourcesUsed.speed],
        cadence: [...this.metricSourcesUsed.cadence],
        power: [...this.metricSourcesUsed.power],
        heartRate: [...this.metricSourcesUsed.heartRate],
      },
      speedKmh: liveValue(speed),
      cadenceRpm: liveValue(cadence),
      powerW: liveValue(power),
      heartRateBpm: liveValue(heartRate),
      avgSpeedKmh: this.distanceEverAvailable && this.distanceCoverageMs > 0
        ? this.distanceM / this.distanceCoverageMs * 3600000 / 1000
        : null,
      elapsedAvgSpeedKmh: this.distanceEverAvailable && elapsedMs > 0
        ? this.distanceM / elapsedMs * 3600000 / 1000
        : null,
      avgCadenceRpm: this.cadenceAverage.durationMs > 0
        ? this.cadenceAverage.sumValueMs / this.cadenceAverage.durationMs
        : null,
      avgPowerW: this.powerAverage.durationMs > 0
        ? this.powerAverage.sumValueMs / this.powerAverage.durationMs
        : null,
      avgBpm: this.heartRateSampleCount > 0
        ? this.heartRateSampleSum / this.heartRateSampleCount
        : null,
      maxBpm: this.peakBpm,
      maxSpeedKmh: this.peakSpeedKmh,
      maxCadenceRpm: this.peakCadenceRpm,
      maxPowerW: this.peakPowerW,
      heartRateAverageMode: 'selected_valid_samples',
      paused: this.paused,
      wheelCircumferenceMm: this.wheelCircumferenceMm,
      metrics: { speed, cadence, power, heartRate },
      sources: this._sourceSnapshots(at),
      rollout: this.rolloutState,
      imuAssist: this._imuSnapshot(at),
    };
  }

  _touchSource(sourceName, nowMs) {
    const source = this.sources[sourceName];
    if (!source.subscribed) {
      this._resetSourceRuntime(sourceName, true);
      source.subscribed = true;
      source.everSubscribed = true;
      source.subscribedAtMs = nowMs;
    }
    source.lastPacketMs = nowMs;
  }

  _sourcePacketWouldGoBack(sourceName, nowMs) {
    const source = this.sources[sourceName];
    return source.lastPacketMs != null && nowMs < source.lastPacketMs;
  }

  _hasLivePhysicalCyclingEvidence(nowMs) {
    for (const sourceName of ['csc', 'cps', 'ftms']) {
      for (const metricName of ['speed', 'cadence', 'power']) {
        const status = this._metricStatus(sourceName, metricName, nowMs);
        if ((status.state === CYCLING_METRIC_STATES.LIVE
            || status.state === CYCLING_METRIC_STATES.EXPLICIT_ZERO)
            && Number(status.value) > 0) {
          return true;
        }
      }
    }
    return false;
  }

  _effectiveRolloutSnapshot(nowMs) {
    const physicalCyclingEvidence = this._hasLivePhysicalCyclingEvidence(nowMs);
    return {
      ...fixedImuRolloutState(this.imuMetersPerCrank, nowMs),
      physicalCyclingEvidence,
    };
  }

  _eventHoldMs(periodMs) {
    if (!(Number.isFinite(periodMs) && periodMs > 0)) return this.coastMs;
    return Math.max(
      this.coastMs,
      Math.min(this.eventHoldMaxMs, periodMs * 1.5),
    );
  }

  _setMetric(sourceName, metricName, value, nowMs, mode, holdMs = null) {
    const record = this.sources[sourceName][metricName];
    record.value = value;
    record.atMs = nowMs;
    record.observedAtMs = nowMs;
    record.holdMs = Number.isFinite(holdMs) ? holdMs : null;
    record.ever = true;
    record.mode = mode;
  }

  _invalidateMetric(sourceName, metricName) {
    const record = this.sources[sourceName][metricName];
    const oldEver = record.ever;
    this.sources[sourceName][metricName] = metricRecord(record.mode);
    this.sources[sourceName][metricName].ever = oldEver;
  }

  _handleCrank(sourceName, crank, nowMs) {
    const source = this.sources[sourceName];
    const current = copyCounter(crank, 'lastEventTime1024');
    if (!current
      || !Number.isInteger(current.revolutions)
      || !Number.isInteger(current.lastEventTime1024)) return;
    source.cadence.observedAtMs = nowMs;

    if (source.crankPrev) {
      const changed = eventChanged(source.crankPrev, current, 'lastEventTime1024');
      let rpm = crankCadenceRpm(source.crankPrev, current, {
        maxCadenceRpm: this.cadenceLimitRpm,
      });
      if (rpm == null && changed) {
        const candidate = source.crankResetCandidate;
        if (candidate && candidate.second) {
          const resetRpm = crankCadenceRpm(candidate.second, current, {
            maxCadenceRpm: this.cadenceLimitRpm,
          });
          if (resetRpm != null
              && current.revolutions < source.crankPrev.revolutions) {
            // 第三个仍位于新低序列、且能从第二个候选正常推进的包，才确认复位。
            // 确认包只作为新锚，避免把 reset 边界附近的未知段写进平均值。
            source.crankPrev = current;
            source.crankResetCandidate = null;
            this._invalidateMetric(sourceName, 'cadence');
            return;
          } else if (current.revolutions >= source.crankPrev.revolutions) {
            // 回到旧锚后的包若仍不合法，按正向毛刺/长间隔重锚。
            source.crankPrev = current;
            source.crankResetCandidate = null;
            this._invalidateMetric(sourceName, 'cadence');
            return;
          } else {
            source.crankResetCandidate = {
              first: current,
              firstAtMs: nowMs,
              second: null,
              secondAtMs: null,
            };
            this._invalidateMetric(sourceName, 'cadence');
            return;
          }
        } else if (candidate && candidate.first) {
          const secondRpm = crankCadenceRpm(candidate.first, current, {
            maxCadenceRpm: this.cadenceLimitRpm,
          });
          if (secondRpm != null
              && current.revolutions < source.crankPrev.revolutions) {
            // 两个连续低值仍可能只是 BLE 缓冲重放；保留旧锚并等待第三包判别。
            candidate.second = current;
            candidate.secondAtMs = nowMs;
            this._invalidateMetric(sourceName, 'cadence');
            return;
          }
          if (current.revolutions >= source.crankPrev.revolutions) {
            source.crankPrev = current;
            source.crankResetCandidate = null;
            this._invalidateMetric(sourceName, 'cadence');
            return;
          }
          source.crankResetCandidate = {
            first: current,
            firstAtMs: nowMs,
            second: null,
            secondAtMs: null,
          };
          this._invalidateMetric(sourceName, 'cadence');
          return;
        } else if (current.revolutions < source.crankPrev.revolutions) {
          source.crankResetCandidate = {
            first: current,
            firstAtMs: nowMs,
            second: null,
            secondAtMs: null,
          };
          this._invalidateMetric(sourceName, 'cadence');
          return;
        } else {
          // 正向长间隔或毛刺只重锚；下一对正常事件即可恢复。
          source.crankPrev = current;
          source.crankResetCandidate = null;
          this._invalidateMetric(sourceName, 'cadence');
          return;
        }
      }
      if (rpm != null) {
        this._setMetric(
          sourceName,
          'cadence',
          rpm,
          nowMs,
          'event',
          this._eventHoldMs(60000 / rpm),
        );
        source.crankResetCandidate = null;
      }
    }
    source.crankPrev = current;
    source.crankResetCandidate = null;
  }

  _handleWheel(sourceName, distanceKey, wheel, eventField, eventTimeHz, nowMs) {
    const source = this.sources[sourceName];
    const current = copyCounter(wheel, eventField);
    if (!current
      || !Number.isInteger(current.revolutions)
      || !Number.isInteger(current[eventField])) return;
    source.speed.observedAtMs = nowMs;

    let acceptedDelta = null;
    let segmentStartAtMs = null;
    const input = this.distanceInputs[distanceKey];
    if (source.wheelPrev && this.wheelCircumferenceMm != null) {
      const changed = eventChanged(source.wheelPrev, current, eventField);
      const delta = wheelDeltaMetrics(source.wheelPrev, current, {
        wheelCircumferenceMm: this.wheelCircumferenceMm,
        eventTimeHz,
        maxSpeedKmh: this.speedLimitKmh,
        maxGapSec: this.maxDistanceGapMs / 1000,
      });
      if (delta) {
        acceptedDelta = delta;
        segmentStartAtMs = nowMs - delta.elapsedSec * 1000;
        source.wheelResetCandidate = null;
      } else if (changed) {
        const candidate = source.wheelResetCandidate;
        if (candidate && candidate.second) {
          const resetDelta = wheelDeltaMetrics(candidate.second, current, {
            wheelCircumferenceMm: this.wheelCircumferenceMm,
            eventTimeHz,
            maxSpeedKmh: this.speedLimitKmh,
            maxGapSec: this.maxDistanceGapMs / 1000,
          });
          if (resetDelta
              && current.revolutions < source.wheelPrev.revolutions) {
            // 第三个低值包确认 reset，但确认包本身只重锚；第四包才恢复计距。
            source.wheelPrev = current;
            source.wheelResetCandidate = null;
            this._invalidateMetric(sourceName, 'speed');
            input.anchor = current;
            input.anchorAtMs = nowMs;
            input.availableAtMs = null;
            const previousActive = this.activeDistanceSource;
            const selected = this._selectDistanceSource(nowMs);
            if (!selected && previousActive === distanceKey) {
              this.activeDistanceSource = distanceKey;
            }
            return;
          } else if (current.revolutions >= source.wheelPrev.revolutions) {
            // 回到旧锚但本段仍不合法：按长停车/正向毛刺重锚。
            source.wheelPrev = current;
            source.wheelResetCandidate = null;
            this._invalidateMetric(sourceName, 'speed');
            input.anchor = current;
            input.anchorAtMs = nowMs;
            input.availableAtMs = null;
            const previousActive = this.activeDistanceSource;
            const selected = this._selectDistanceSource(nowMs);
            if (!selected && previousActive === distanceKey) {
              this.activeDistanceSource = distanceKey;
            }
            return;
          } else {
            source.wheelResetCandidate = {
              first: current,
              firstAtMs: nowMs,
              second: null,
              secondAtMs: null,
            };
            this._invalidateMetric(sourceName, 'speed');
            input.availableAtMs = null;
            const previousActive = this.activeDistanceSource;
            const selected = this._selectDistanceSource(nowMs);
            if (!selected && previousActive === distanceKey) {
              this.activeDistanceSource = distanceKey;
            }
            return;
          }
        } else if (candidate && candidate.first) {
          const secondDelta = wheelDeltaMetrics(candidate.first, current, {
            wheelCircumferenceMm: this.wheelCircumferenceMm,
            eventTimeHz,
            maxSpeedKmh: this.speedLimitKmh,
            maxGapSec: this.maxDistanceGapMs / 1000,
          });
          if (secondDelta
              && current.revolutions < source.wheelPrev.revolutions) {
            // 两个连续低值仍不足以证明 reset；第三包会优先尝试旧锚。
            candidate.second = current;
            candidate.secondAtMs = nowMs;
            this._invalidateMetric(sourceName, 'speed');
            input.availableAtMs = null;
            const previousActive = this.activeDistanceSource;
            const selected = this._selectDistanceSource(nowMs);
            if (!selected && previousActive === distanceKey) {
              this.activeDistanceSource = distanceKey;
            }
            return;
          }
          if (current.revolutions >= source.wheelPrev.revolutions) {
            source.wheelPrev = current;
            source.wheelResetCandidate = null;
            this._invalidateMetric(sourceName, 'speed');
            input.anchor = current;
            input.anchorAtMs = nowMs;
            input.availableAtMs = null;
            const previousActive = this.activeDistanceSource;
            const selected = this._selectDistanceSource(nowMs);
            if (!selected && previousActive === distanceKey) {
              this.activeDistanceSource = distanceKey;
            }
            return;
          }
          source.wheelResetCandidate = {
            first: current,
            firstAtMs: nowMs,
            second: null,
            secondAtMs: null,
          };
          this._invalidateMetric(sourceName, 'speed');
          input.availableAtMs = null;
          const previousActive = this.activeDistanceSource;
          const selected = this._selectDistanceSource(nowMs);
          if (!selected && previousActive === distanceKey) {
            this.activeDistanceSource = distanceKey;
          }
          return;
        } else if (current.revolutions < source.wheelPrev.revolutions) {
          // BLE 到达顺序不是事件顺序。第一个回退包只隔离，绝不覆盖旧锚。
          source.wheelResetCandidate = {
            first: current,
            firstAtMs: nowMs,
            second: null,
            secondAtMs: null,
          };
          this._invalidateMetric(sourceName, 'speed');
          input.availableAtMs = null;
          const previousActive = this.activeDistanceSource;
          const selected = this._selectDistanceSource(nowMs);
          if (!selected && previousActive === distanceKey) {
            this.activeDistanceSource = distanceKey;
          }
          return;
        } else {
          // 停车过久后的正向事件不能被误当成计数器复位。当前包只重锚，
          // 下一轮事件即可恢复速度和距离。
          source.wheelPrev = current;
          source.wheelResetCandidate = null;
          this._invalidateMetric(sourceName, 'speed');
          input.anchor = current;
          input.anchorAtMs = nowMs;
          input.availableAtMs = null;
          const previousActive = this.activeDistanceSource;
          const selected = this._selectDistanceSource(nowMs);
          if (!selected && previousActive === distanceKey) {
            this.activeDistanceSource = distanceKey;
          }
          return;
        }
      }
    }
    source.wheelPrev = current;
    source.wheelResetCandidate = null;

    if (this.wheelCircumferenceMm == null) return;
    if (!acceptedDelta) {
      input.anchor = current;
      input.anchorAtMs = nowMs;
      return;
    }
    const wheelPeriodMs = acceptedDelta.speedKmh > 0
      ? (this.wheelCircumferenceMm / 1000)
        / (acceptedDelta.speedKmh / 3.6) * 1000
      : null;
    this._setMetric(
      sourceName,
      'speed',
      acceptedDelta.speedKmh,
      nowMs,
      'event',
      this._eventHoldMs(wheelPeriodMs),
    );
    input.anchor = current;
    input.anchorAtMs = nowMs;
    input.availableAtMs = nowMs;
    this._selectDistanceSource(nowMs);
    this.distanceEverAvailable = true;
    this._queueDistanceSegment(
      distanceKey,
      acceptedDelta.distanceM,
      acceptedDelta.elapsedSec * 1000,
      segmentStartAtMs,
      nowMs,
    );
  }

  _handleFtmsTotal(totalDistanceM, nowMs, speedEvidence = {}) {
    const key = 'ftmsTotal';
    const input = this.distanceInputs[key];
    input.availableAtMs = nowMs;
    const speedSegmentDistanceM = Number(speedEvidence.speedSegmentDistanceM);
    input.fieldMissingCount = 0;
    const classified = this._classifyFtmsTotal(input, totalDistanceM, nowMs);

    if (input.speedFallbackActive) {
      if (classified.kind === 'pending' || classified.kind === 'same') {
        // 冻结或 reset/replay 尚未判明时，速度积分仍是唯一账本。
        this._selectDistanceSource(nowMs);
        return;
      }
      // 累计字段恢复、真 reset 或异常新基线的判定包一律只重锚。当前收包前
      // 的 FTMS speed 段已入账，不能再补累计差。
      input.speedFallbackActive = false;
      input.stallCount = 0;
      input.fieldMissingCount = 0;
      input.pendingSpeedDistanceM = 0;
      input.resetCandidate = null;
      input.anchor = totalDistanceM;
      input.anchorAtMs = nowMs;
      this.distanceEverAvailable = true;
      this._selectDistanceSource(nowMs);
      return;
    }

    if (classified.kind === 'baseline') {
      input.anchor = totalDistanceM;
      input.anchorAtMs = nowMs;
      input.stallCount = 0;
      input.fieldMissingCount = 0;
      input.pendingSpeedDistanceM = 0;
      input.resetCandidate = null;
      this.distanceEverAvailable = true;
      this._selectDistanceSource(nowMs);
      return;
    }

    if (classified.kind === 'pending') {
      input.stallCount = 0;
      input.pendingSpeedDistanceM = 0;
      this._selectDistanceSource(nowMs);
      return;
    }

    if (classified.kind === 'reset' || classified.kind === 'reanchor') {
      // 第三个连续低值才能确认 reset；确认包仍只重锚，不补未知边界段。
      input.anchor = totalDistanceM;
      input.anchorAtMs = nowMs;
      input.stallCount = 0;
      input.pendingSpeedDistanceM = 0;
      this.distanceEverAvailable = true;
      this._selectDistanceSource(nowMs);
      return;
    }

    if (classified.kind === 'forward') {
      input.anchor = totalDistanceM;
      input.anchorAtMs = nowMs;
      input.stallCount = 0;
      input.pendingSpeedDistanceM = 0;
      this.distanceEverAvailable = true;
      this._selectDistanceSource(nowMs);
      this._queueDistanceSegment(
        key,
        classified.segment.distanceM,
        classified.segment.durationMs,
        classified.segment.startMs,
        classified.segment.endMs,
      );
      return;
    }

    // same：累计字段冻结，但 FTMS speed 仍持续形成 standby segments。
    // 不推进累计锚点的时间：若下一包恢复增长，它覆盖的是最后一次真实累计
    // 变化以来的整段时间，均速分母不能被一次冻结通知截短。
    input.stallCount += 1;
    if (Number.isFinite(speedSegmentDistanceM) && speedSegmentDistanceM > 0) {
      input.pendingSpeedDistanceM += speedSegmentDistanceM;
    }
    if (input.stallCount < this.ftmsTotalStallSamples
        || !(input.pendingSpeedDistanceM > 0)) return;

    // 连续冻结达到门槛后切换 owner；ftmsSpeed 的待提交段会按全局覆盖区间
    // 自动裁掉已由累计距离或更高优先级来源覆盖的部分。
    input.pendingSpeedDistanceM = 0;
    input.speedFallbackActive = true;
    this.distanceEverAvailable = true;
    this._selectDistanceSource(nowMs);
  }

  _handleFtmsTotalMissing(nowMs, _speedKmh, speedSegmentDistanceM) {
    const input = this.distanceInputs.ftmsTotal;
    if (input.anchor == null || input.speedFallbackActive) return;
    input.fieldMissingCount += 1;
    if (Number.isFinite(speedSegmentDistanceM) && speedSegmentDistanceM > 0) {
      input.pendingSpeedDistanceM += speedSegmentDistanceM;
    }
    if (input.fieldMissingCount < this.ftmsTotalStallSamples
        || !(input.pendingSpeedDistanceM > 0)) return;

    // 部分 FTMS 只在首包携带 Total Distance。切换后由 segment ledger
    // 补入尚未被累计值或高优先级来源覆盖的速度区间。
    input.pendingSpeedDistanceM = 0;
    input.speedFallbackActive = true;
    this.distanceEverAvailable = true;
    this._selectDistanceSource(nowMs);
  }

  _handleFtmsSpeed(speedKmh, nowMs) {
    const key = 'ftmsSpeed';
    const input = this.distanceInputs[key];
    input.availableAtMs = nowMs;
    this._selectDistanceSource(nowMs);

    if (input.anchor == null) {
      input.anchor = speedKmh;
      input.anchorAtMs = nowMs;
      if (this.activeDistanceSource === key) this.distanceEverAvailable = true;
      return null;
    }
    const dtMs = nowMs - input.anchorAtMs;
    const previousSpeedKmh = input.anchor;
    input.anchor = speedKmh;
    input.anchorAtMs = nowMs;
    if (!(dtMs > 0) || dtMs > this.maxDistanceGapMs) return null;
    const distanceM = (previousSpeedKmh + speedKmh) * 0.5
      * (dtMs / 3600000) * 1000;
    this._queueDistanceSegment(key, distanceM, dtMs, nowMs - dtMs, nowMs);
    if (distanceM > 0) this.distanceEverAvailable = true;
    return distanceM;
  }

  _handleImuSpeed(speedKmh, nowMs) {
    const key = 'imuEstimate';
    const input = this.distanceInputs[key];
    input.availableAtMs = nowMs;
    this._selectDistanceSource(nowMs);

    if (input.anchor == null) {
      input.anchor = speedKmh;
      input.anchorAtMs = nowMs;
      if (this.activeDistanceSource === key) this.distanceEverAvailable = true;
      return null;
    }
    const dtMs = nowMs - input.anchorAtMs;
    const previousSpeedKmh = input.anchor;
    input.anchor = speedKmh;
    input.anchorAtMs = nowMs;
    if (!(dtMs > 0) || dtMs > this.imuDistanceMaxGapMs) return null;
    const distanceM = (previousSpeedKmh + speedKmh) * 0.5
      * (dtMs / 3600000) * 1000;
    this._queueDistanceSegment(key, distanceM, dtMs, nowMs - dtMs, nowMs);
    if (distanceM > 0) this.distanceEverAvailable = true;
    return distanceM;
  }

  _resetImuDistanceCandidateGate() {
    this.imuDistanceCandidateGate = {
      count: 0,
      firstAtMs: null,
      lastAtMs: null,
      confirmed: false,
    };
  }

  _observeImuDistanceCandidate(entryStrong, maintainStrong, nowMs) {
    const gate = this.imuDistanceCandidateGate;
    const accepted = gate.confirmed ? maintainStrong : entryStrong;
    if (!accepted
        || !Number.isFinite(nowMs)
        || (gate.lastAtMs != null
          && (nowMs <= gate.lastAtMs || nowMs - gate.lastAtMs > this.imuDistanceMaxGapMs))) {
      this._resetImuDistanceCandidateGate();
      if (!entryStrong || !maintainStrong || !Number.isFinite(nowMs)) return false;
    }
    const current = this.imuDistanceCandidateGate;
    if (current.firstAtMs == null) current.firstAtMs = nowMs;
    current.lastAtMs = nowMs;
    current.count += 1;
    if (current.count >= IMU_DISTANCE_CANDIDATE_CONFIRM_SAMPLES
        && nowMs - current.firstAtMs >= IMU_DISTANCE_CANDIDATE_CONFIRM_SPAN_MS) {
      current.confirmed = true;
    }
    return current.confirmed;
  }

  _plausibleFtmsSegment(fromValue, fromAtMs, toValue, toAtMs) {
    const durationMs = toAtMs - fromAtMs;
    const distanceM = toValue - fromValue;
    if (!(durationMs > 0)
        || durationMs > this.maxDistanceGapMs
        || !(distanceM > 0)) return null;
    const maxPlausibleDistanceM = Math.max(
      10,
      this.speedLimitKmh / 3.6 * (durationMs / 1000) * 2 + 2,
    );
    if (distanceM > maxPlausibleDistanceM) return null;
    return {
      distanceM,
      durationMs,
      startMs: fromAtMs,
      endMs: toAtMs,
    };
  }

  _classifyFtmsTotal(input, totalDistanceM, nowMs) {
    if (input.anchor == null || input.anchorAtMs == null) {
      return { kind: 'baseline' };
    }
    const fromConfirmed = this._plausibleFtmsSegment(
      input.anchor,
      input.anchorAtMs,
      totalDistanceM,
      nowMs,
    );
    const candidate = input.resetCandidate;
    if (candidate) {
      // 第三包若能从旧锚正常推进，前两个低值就是缓存重放；旧锚优先。
      if (fromConfirmed) {
        input.resetCandidate = null;
        return { kind: 'forward', segment: fromConfirmed };
      }
      if (totalDistanceM >= input.anchor) {
        input.resetCandidate = null;
        return {
          kind: totalDistanceM === input.anchor ? 'same' : 'reanchor',
        };
      }
      if (candidate.second) {
        const fromCandidateTail = this._plausibleFtmsSegment(
          candidate.second.value,
          candidate.second.atMs,
          totalDistanceM,
          nowMs,
        );
        if (fromCandidateTail) {
          input.resetCandidate = null;
          return { kind: 'reset' };
        }
        input.resetCandidate = {
          first: { value: totalDistanceM, atMs: nowMs },
          second: null,
        };
        return { kind: 'pending' };
      }
      const fromCandidateHead = this._plausibleFtmsSegment(
        candidate.first.value,
        candidate.first.atMs,
        totalDistanceM,
        nowMs,
      );
      if (fromCandidateHead) {
        candidate.second = { value: totalDistanceM, atMs: nowMs };
        return { kind: 'pending' };
      }
      input.resetCandidate = {
        first: { value: totalDistanceM, atMs: nowMs },
        second: null,
      };
      return { kind: 'pending' };
    }

    if (totalDistanceM < input.anchor) {
      input.resetCandidate = {
        first: { value: totalDistanceM, atMs: nowMs },
        second: null,
      };
      return { kind: 'pending' };
    }
    if (totalDistanceM === input.anchor) return { kind: 'same' };
    if (fromConfirmed) return { kind: 'forward', segment: fromConfirmed };
    return { kind: 'reanchor' };
  }

  _distanceUncoveredWallMs(startMs, endMs, intervals = this.distanceCoverageIntervals) {
    if (!(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs)) {
      return 0;
    }
    let uncoveredMs = endMs - startMs;
    for (const interval of intervals) {
      if (interval.endMs <= startMs) continue;
      if (interval.startMs >= endMs) break;
      const overlapStart = Math.max(startMs, interval.startMs);
      const overlapEnd = Math.min(endMs, interval.endMs);
      if (overlapEnd > overlapStart) uncoveredMs -= overlapEnd - overlapStart;
    }
    return Math.max(0, uncoveredMs);
  }

  _mergeDistanceCoverage(startMs, endMs) {
    this.distanceCoverageIntervals = this._mergeCoverageIntervals(
      this.distanceCoverageIntervals,
      startMs,
      endMs,
    );
    this.distanceCoverageEndMs = this.distanceCoverageEndMs == null
      ? endMs : Math.max(this.distanceCoverageEndMs, endMs);
  }

  _mergeCoverageIntervals(intervals, startMs, endMs) {
    const merged = [];
    let nextStart = startMs;
    let nextEnd = endMs;
    let inserted = false;
    for (const interval of intervals) {
      if (interval.endMs < nextStart) {
        merged.push(interval);
      } else if (nextEnd < interval.startMs) {
        if (!inserted) {
          merged.push({ startMs: nextStart, endMs: nextEnd });
          inserted = true;
        }
        merged.push(interval);
      } else {
        nextStart = Math.min(nextStart, interval.startMs);
        nextEnd = Math.max(nextEnd, interval.endMs);
      }
    }
    if (!inserted) merged.push({ startMs: nextStart, endMs: nextEnd });
    return merged;
  }

  _distanceCoverageExcludingKey(key) {
    let merged = [];
    for (const [otherKey, intervals] of Object.entries(this.distanceCoverageByKey)) {
      if (otherKey === key) continue;
      for (const interval of intervals) {
        merged = this._mergeCoverageIntervals(
          merged,
          interval.startMs,
          interval.endMs,
        );
      }
    }
    return merged;
  }

  _queueDistanceSegment(key, distanceM, durationMs, startMs, endMs) {
    if (!(Number.isFinite(distanceM) && distanceM > 0)
        || !(Number.isFinite(durationMs) && durationMs > 0)
        || !(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs)) {
      return;
    }
    const input = this.distanceInputs[key];
    input.pendingSegments.push({
      distanceM,
      durationMs,
      startMs,
      endMs,
    });
    input.pendingSegments = input.pendingSegments.filter((segment) => (
      key === 'cscWheel' || key === 'cpsWheel'
        || this._distanceUncoveredWallMs(segment.startMs, segment.endMs) > 0
    ));
    if (this.activeDistanceSource === key) this._flushDistanceSegments(key);
  }

  _flushDistanceSegments(key) {
    const input = this.distanceInputs[key];
    const pending = input.pendingSegments
      .slice()
      .sort((a, b) => a.endMs - b.endMs || a.startMs - b.startMs);
    input.pendingSegments = [];
    for (const segment of pending) {
      const wallMs = segment.endMs - segment.startMs;
      const sameCounterWheelSource = key === 'cscWheel' || key === 'cpsWheel';
      const ownIntervals = this.distanceCoverageByKey[key];
      const globallyUncoveredWallMs = this._distanceUncoveredWallMs(
        segment.startMs,
        segment.endMs,
      );
      // 同一个轮转计数器的每个合法 revolution delta 本身就是不可重复的
      // protocol segment。BLE 批量到达只会扭曲 arrival wall 映射，不能按
      // 重叠比例删掉后续轮数；但其他来源已覆盖、且并非本输入自身覆盖的时间
      // 仍必须扣除，防止 CSC/CPS/FTMS 跨来源重复。
      const uncoveredWallMs = sameCounterWheelSource
        ? this._distanceUncoveredWallMs(
          segment.startMs,
          segment.endMs,
          this._distanceCoverageExcludingKey(key),
        )
        : globallyUncoveredWallMs;
      if (!(uncoveredWallMs > 0) || !(wallMs > 0)) continue;
      const uncoveredRatio = Math.min(1, uncoveredWallMs / wallMs);
      this.distanceM += segment.distanceM * uncoveredRatio;
      this.distanceCoverageMs += segment.durationMs * uncoveredRatio;
      this.distanceEverAvailable = true;
      this.summarySourcesUsed.add(input.source);
      this.distanceSourcesUsed.add(input.source);
      this._mergeDistanceCoverage(segment.startMs, segment.endMs);
      this.distanceCoverageByKey[key] = this._mergeCoverageIntervals(
        ownIntervals,
        segment.startMs,
        segment.endMs,
      );
    }
    // 高优先级覆盖推进后，及时丢掉所有 standby 中已完全覆盖的段。
    for (const [otherKey, otherInput] of Object.entries(this.distanceInputs)) {
      if (otherKey === key || otherInput.pendingSegments.length === 0) continue;
      if (otherKey !== 'cscWheel' && otherKey !== 'cpsWheel') {
        otherInput.pendingSegments = otherInput.pendingSegments.filter(
          (segment) => this._distanceUncoveredWallMs(segment.startMs, segment.endMs) > 0,
        );
      }
    }
  }

  _finalizePendingDistanceSegments() {
    for (const key of CYCLING_SOURCE_PRIORITY.distance) {
      this._flushDistanceSegments(key);
    }
  }

  _selectDistanceSource(nowMs) {
    let selected = null;
    for (const key of CYCLING_SOURCE_PRIORITY.distance) {
      if (this._distanceInputFresh(key, nowMs)) {
        selected = key;
        break;
      }
    }
    this.activeDistanceSource = selected;
    if (selected) this._flushDistanceSegments(selected);
    return selected;
  }

  _distanceInputFresh(key, nowMs) {
    const input = this.distanceInputs[key];
    const source = this.sources[input.source];
    const freshnessMs = key === 'imuEstimate'
      ? this.metricStaleMs : this.packetStaleMs;
    const eventDistanceHasValidSpeed = key !== 'cscWheel' && key !== 'cpsWheel'
      ? true
      : source.speed.atMs != null
        && nowMs >= source.speed.atMs
        && nowMs - source.speed.atMs <= this.packetStaleMs;
    return source.subscribed
      && eventDistanceHasValidSpeed
      && !(key === 'ftmsTotal' && input.speedFallbackActive)
      && input.availableAtMs != null
      && nowMs >= input.availableAtMs
      && nowMs - input.availableAtMs <= freshnessMs;
  }

  _distanceSnapshot(nowMs) {
    const key = this.activeDistanceSource;
    if (key && this._distanceInputFresh(key, nowMs)) {
      const input = this.distanceInputs[key];
      return {
        state: CYCLING_METRIC_STATES.LIVE,
        source: input.source,
        mode: input.mode,
      };
    }
    if (this.distanceEverAvailable) {
      return {
        state: CYCLING_METRIC_STATES.STALE,
        source: key ? this.distanceInputs[key].source : null,
        mode: key ? this.distanceInputs[key].mode : null,
      };
    }
    const anySubscribed = Object.values(this.distanceInputs)
      .some((input) => this.sources[input.source].subscribed);
    return {
      state: anySubscribed
        ? CYCLING_METRIC_STATES.SUBSCRIBED
        : CYCLING_METRIC_STATES.UNSUPPORTED,
      source: null,
      mode: null,
    };
  }

  _metricStatus(sourceName, metricName, nowMs) {
    const source = this.sources[sourceName];
    const record = source[metricName];
    if (!source.subscribed) {
      return {
        value: null,
        state: record.ever || source.everSubscribed
          ? CYCLING_METRIC_STATES.STALE
          : CYCLING_METRIC_STATES.UNSUPPORTED,
        source: sourceName,
        ageMs: record.atMs == null ? null : Math.max(0, nowMs - record.atMs),
        expiresAtMs: null,
      };
    }

    const subscribedAgeMs = source.subscribedAtMs == null
      ? 0
      : Math.max(0, nowMs - source.subscribedAtMs);
    if (source.lastPacketMs == null) {
      return {
        value: null,
        state: subscribedAgeMs > this.packetStaleMs
          ? CYCLING_METRIC_STATES.STALE
          : CYCLING_METRIC_STATES.SUBSCRIBED,
        source: sourceName,
        ageMs: null,
        expiresAtMs: null,
      };
    }

    const packetAgeMs = Math.max(0, nowMs - source.lastPacketMs);
    if (packetAgeMs > this.packetStaleMs || record.atMs == null) {
      return {
        value: null,
        state: packetAgeMs > this.packetStaleMs || record.ever
          ? CYCLING_METRIC_STATES.STALE
          : CYCLING_METRIC_STATES.SUBSCRIBED,
        source: sourceName,
        ageMs: record.atMs == null ? null : Math.max(0, nowMs - record.atMs),
        expiresAtMs: null,
      };
    }

    const ageMs = Math.max(0, nowMs - record.atMs);
    if (record.mode === 'event' && (metricName === 'speed' || metricName === 'cadence')) {
      const eventHoldMs = Number.isFinite(record.holdMs)
        ? record.holdMs : this.coastMs;
      if (ageMs > this.packetStaleMs) {
        return {
          value: null,
          state: CYCLING_METRIC_STATES.STALE,
          source: sourceName,
          ageMs,
          expiresAtMs: null,
        };
      }
      if (ageMs >= eventHoldMs) {
        if (record.observedAtMs == null
            || source.lastPacketMs > record.observedAtMs) {
          // 来源的最新包未携带这个事件字段（例如 CPS 只发功率）。
          // 缺字段不是明确零值，必须让仍新鲜的低优先级骑行传感器接管。
          return {
            value: null,
            state: CYCLING_METRIC_STATES.STALE,
            source: sourceName,
            ageMs,
            expiresAtMs: null,
          };
        }
        return {
          value: 0,
          state: CYCLING_METRIC_STATES.EXPLICIT_ZERO,
          source: sourceName,
          ageMs,
          expiresAtMs: record.atMs + this.packetStaleMs,
        };
      }
      return {
        value: record.value,
        state: record.value === 0
          ? CYCLING_METRIC_STATES.EXPLICIT_ZERO
          : CYCLING_METRIC_STATES.LIVE,
        source: sourceName,
        ageMs,
        expiresAtMs: record.atMs + eventHoldMs,
      };
    }

    const staleAfterMs = metricName === 'heartRate'
      ? this.heartRateStaleMs : this.metricStaleMs;
    if (ageMs > staleAfterMs) {
      return {
        value: null,
        state: CYCLING_METRIC_STATES.STALE,
        source: sourceName,
        ageMs,
        expiresAtMs: null,
      };
    }
    return {
      value: record.value,
      state: record.value === 0
        ? CYCLING_METRIC_STATES.EXPLICIT_ZERO
        : CYCLING_METRIC_STATES.LIVE,
      source: sourceName,
      ageMs,
      expiresAtMs: record.atMs + staleAfterMs,
    };
  }

  _selectMetric(metricName, nowMs) {
    const priority = CYCLING_SOURCE_PRIORITY[metricName];
    const statuses = priority.map((sourceName) => (
      this._metricStatus(sourceName, metricName, nowMs)
    ));
    for (const status of statuses) {
      if (status.state === CYCLING_METRIC_STATES.LIVE
        || status.state === CYCLING_METRIC_STATES.EXPLICIT_ZERO) return status;
    }
    for (const wantedState of [
      CYCLING_METRIC_STATES.STALE,
      CYCLING_METRIC_STATES.SUBSCRIBED,
      CYCLING_METRIC_STATES.UNSUPPORTED,
    ]) {
      const status = statuses.find((candidate) => candidate.state === wantedState);
      if (status) return status;
    }
    return {
      value: null,
      state: CYCLING_METRIC_STATES.UNSUPPORTED,
      source: null,
      ageMs: null,
      expiresAtMs: null,
    };
  }

  _beforeUpdate(nowMs) {
    this._advanceAverage(this.cadenceAverage, nowMs);
    this._advanceAverage(this.powerAverage, nowMs);
    this._advanceMovement(nowMs);
  }

  _afterUpdate(nowMs) {
    const cadence = this._selectMetric('cadence', nowMs);
    const power = this._selectMetric('power', nowMs);
    this._rememberMetricSource(cadence, 'cadence');
    this._rememberMetricSource(power, 'power');
    this._setAverageCurrent(this.cadenceAverage, cadence, nowMs);
    this._setAverageCurrent(this.powerAverage, power, nowMs);
    this._setMovementCurrent(nowMs);
    this._updatePeaks(nowMs);
  }

  _rememberMetricSource(metric, metricName = null) {
    if (!metric || !metric.source) return;
    if (metric.state === CYCLING_METRIC_STATES.LIVE
      || metric.state === CYCLING_METRIC_STATES.EXPLICIT_ZERO) {
      this.summarySourcesUsed.add(metric.source);
      if (metricName && this.metricSourcesUsed[metricName]) {
        this.metricSourcesUsed[metricName].add(metric.source);
      }
    }
  }

  _recordHeartRateSample(sourceName, bpm, nowMs) {
    const selected = this._selectMetric('heartRate', nowMs);
    if (selected.state !== CYCLING_METRIC_STATES.LIVE
      || selected.source !== sourceName
      || selected.value !== bpm) return;
    this.summarySourcesUsed.add(sourceName);
    this.metricSourcesUsed.heartRate.add(sourceName);
    this.heartRateSampleSum += bpm;
    this.heartRateSampleCount += 1;
    if (this.peakBpm == null || bpm > this.peakBpm) this.peakBpm = bpm;
  }

  _updatePeaks(nowMs) {
    if (this.paused) return;
    const candidates = [
      ['speed', 'peakSpeedKmh'],
      ['cadence', 'peakCadenceRpm'],
      ['power', 'peakPowerW'],
    ];
    for (const [metricName, peakName] of candidates) {
      const selected = this._selectMetric(metricName, nowMs);
      if (selected.state !== CYCLING_METRIC_STATES.LIVE
        && selected.state !== CYCLING_METRIC_STATES.EXPLICIT_ZERO) continue;
      if (!(Number.isFinite(selected.value) && selected.value >= 0)) continue;
      this.summarySourcesUsed.add(selected.source);
      this.metricSourcesUsed[metricName].add(selected.source);
      if (this[peakName] == null || selected.value > this[peakName]) {
        this[peakName] = selected.value;
      }
    }
  }

  _advanceAverage(tracker, nowMs) {
    if (nowMs <= tracker.lastMs) return;
    if (!this.paused && tracker.current) {
      const endMs = Math.min(nowMs, tracker.current.expiresAtMs);
      if (endMs > tracker.lastMs && tracker.includeValue(tracker.current.value)) {
        const dtMs = endMs - tracker.lastMs;
        tracker.sumValueMs += tracker.current.value * dtMs;
        tracker.durationMs += dtMs;
      }
    }
    tracker.lastMs = nowMs;
  }

  _setAverageCurrent(tracker, metric, nowMs) {
    const usable = !this.paused
      && (metric.state === CYCLING_METRIC_STATES.LIVE
        || metric.state === CYCLING_METRIC_STATES.EXPLICIT_ZERO)
      && Number.isFinite(metric.value)
      && Number.isFinite(metric.expiresAtMs)
      && metric.expiresAtMs > nowMs;
    tracker.current = usable
      ? {
        value: metric.value,
        source: metric.source,
        expiresAtMs: metric.expiresAtMs,
      }
      : null;
    tracker.lastMs = nowMs;
  }

  _advanceMovement(nowMs) {
    if (nowMs <= this.movement.lastMs) return;
    if (!this.paused && this.movement.current) {
      const endMs = Math.min(nowMs, this.movement.current.expiresAtMs);
      if (endMs > this.movement.lastMs) {
        this.movement.movingMs += endMs - this.movement.lastMs;
      }
    }
    this.movement.lastMs = nowMs;
  }

  _setMovementCurrent(nowMs) {
    if (this.paused) {
      this.movement.current = null;
      this.movement.lastMs = nowMs;
      return;
    }
    const candidates = [
      this._selectMetric('speed', nowMs),
      this._selectMetric('cadence', nowMs),
      this._selectMetric('power', nowMs),
    ];
    const expiries = [];
    for (const metric of candidates) {
      if (metric.state !== CYCLING_METRIC_STATES.LIVE
        && metric.state !== CYCLING_METRIC_STATES.EXPLICIT_ZERO) continue;
      const positive = (metric === candidates[0] && metric.value > this.movingSpeedThresholdKmh)
        || (metric === candidates[1] && metric.value > 0)
        || (metric === candidates[2] && metric.value > this.movingPowerThresholdW);
      if (positive && Number.isFinite(metric.expiresAtMs)) expiries.push(metric.expiresAtMs);
    }
    this.movement.current = expiries.length > 0
      ? { expiresAtMs: Math.max(...expiries) }
      : null;
    this.movement.lastMs = nowMs;
  }

  _sourceSnapshots(nowMs) {
    const out = {};
    for (const sourceName of ALL_SOURCES) {
      const source = this.sources[sourceName];
      let state = CYCLING_METRIC_STATES.UNSUPPORTED;
      let packetAgeMs = null;
      if (source.subscribed) {
        const sourceStaleMs = this.packetStaleMs;
        if (source.lastPacketMs == null) {
          const age = source.subscribedAtMs == null ? 0 : nowMs - source.subscribedAtMs;
          state = age > sourceStaleMs
            ? CYCLING_METRIC_STATES.STALE
            : CYCLING_METRIC_STATES.SUBSCRIBED;
        } else {
          packetAgeMs = Math.max(0, nowMs - source.lastPacketMs);
          state = packetAgeMs > sourceStaleMs
            ? CYCLING_METRIC_STATES.STALE
            : CYCLING_METRIC_STATES.LIVE;
        }
      } else if (source.everSubscribed) {
        state = CYCLING_METRIC_STATES.STALE;
      }
      out[sourceName] = {
        subscribed: source.subscribed,
        state,
        packetAgeMs,
      };
    }
    return out;
  }

  _imuSnapshot(nowMs) {
    if (!this.imuAssist) return null;
    const ageMs = Math.max(0, nowMs - this.imuAssist.atMs);
    const fresh = this.imuAssist.fresh && ageMs <= this.imuStaleMs;
    const rollout = this.rolloutState
      || this._effectiveRolloutSnapshot(nowMs);
    const effectiveCadenceRpm = fresh
      ? this.imuAssist.effectiveCadenceRpm : null;
    return {
      motionState: fresh ? this.imuAssist.motionState : 'stale',
      confidence: fresh ? this.imuAssist.confidence : 0,
      fresh,
      autoPauseSuggested: fresh && this.imuAssist.autoPauseSuggested,
      autoResumeSuggested: fresh && this.imuAssist.autoResumeSuggested,
      cadenceState: fresh ? this.imuAssist.cadenceState : 'stale',
      motionArtifact: fresh ? this.imuAssist.motionArtifact : 'none',
      motionQualityState: fresh
        ? this.imuAssist.motionQualityState : 'unavailable',
      cadenceConfidence: fresh ? this.imuAssist.cadenceConfidence : 0,
      candidateCadenceRpm: fresh ? this.imuAssist.candidateCadenceRpm : null,
      finalCadenceRpm: fresh ? this.imuAssist.finalCadenceRpm : null,
      effectiveCadenceRpm,
      cadenceEstimateLevel: fresh
        ? this.imuAssist.cadenceEstimateLevel : 'none',
      cadenceSensorSource: fresh
        ? this.imuAssist.cadenceSensorSource : 'none',
      cadenceUsable: fresh && this.imuAssist.cadenceUsable,
      availabilityCadenceUsable:
        fresh && this.imuAssist.availabilityCadenceUsable,
      availabilityEstimateActive:
        fresh && this.imuAssist.availabilityEstimateActive,
      estimatedSpeedKmh: fresh && effectiveCadenceRpm > 0
        ? estimateImuFallbackSpeedKmh(
          effectiveCadenceRpm,
          {
            walkingLike: this.imuAssist.walkingLike === true,
            estimateLevel: this.imuAssist.availabilityEstimateActive
              ? 'candidate' : this.imuAssist.cadenceEstimateLevel,
            calibrated: false,
            metersPerCrank: this.imuAssist.availabilityEstimateActive
              ? DEFAULT_IMU_METERS_PER_CRANK : rollout.metersPerCrank,
            speedLimitKmh: this.speedLimitKmh,
          },
        )
        : null,
      rawEstimatedCadenceRpm: fresh
        ? this.imuAssist.rawEstimatedCadenceRpm : null,
      rawEstimatedSpeedKmh: fresh
        ? this.imuAssist.rawEstimatedSpeedKmh : null,
      stabilizedCadenceRpm: fresh
        ? this.imuAssist.stabilizedCadenceRpm : null,
      stabilizedSpeedKmh: fresh
        ? this.imuAssist.stabilizedSpeedKmh : null,
      estimateStabilized: fresh
        && this.imuAssist.estimateStabilized === true,
      distanceLedgerEligible: fresh
        && this.imuAssist.distanceLedgerEligible === true,
      simpleGyroLedgerFresh: fresh
        && this.imuAssist.simpleGyroLedgerFresh === true,
      simpleGyroCadenceMethod: fresh
        ? this.imuAssist.simpleGyroCadenceMethod : 'none',
      simpleGyroAnalysisState: fresh
        ? this.imuAssist.simpleGyroAnalysisState : 'none',
      rawMotionArtifact: fresh
        ? this.imuAssist.rawMotionArtifact : 'none',
      walkingLike: fresh && this.imuAssist.walkingLike === true,
      walkingLikeConfidence: fresh
        ? this.imuAssist.walkingLikeConfidence : 0,
      speedEstimateProfile: fresh
        ? this.imuAssist.speedEstimateProfile : 'unavailable',
      cadenceCorrelation: fresh ? this.imuAssist.cadenceCorrelation : null,
      metersPerCrank: rollout.metersPerCrank,
      configuredMetersPerCrank: this.imuAssist.configuredMetersPerCrank,
      rolloutCalibrationState: rollout.calibrationState,
      rolloutConfidence: rollout.confidence,
      rolloutLocked: rollout.locked,
      rolloutAcceptedWindowCount: rollout.acceptedWindowCount,
      rolloutLearnedMetersPerCrank: rollout.learnedMetersPerCrank,
      likelyWalk: rollout.likelyWalk,
      suppressImu: rollout.suppressImu,
      indoorUnverified: rollout.indoorUnverified,
      accelerationUnit: this.imuAssist.accelerationUnit,
      accelerationCalibrated: this.imuAssist.accelerationCalibrated,
      ageMs,
    };
  }

  _resetSourceRuntime(sourceName, clearMetrics) {
    const source = this.sources[sourceName];
    source.lastPacketMs = null;
    source.wheelPrev = null;
    source.wheelResetCandidate = null;
    source.crankPrev = null;
    source.crankResetCandidate = null;
    if (clearMetrics) {
      for (const metricName of METRIC_NAMES) source[metricName] = metricRecord();
    }
    this._clearSourceDistanceInputs(sourceName);
  }

  _clearSourceDistanceInputs(sourceName) {
    for (const [key, input] of Object.entries(this.distanceInputs)) {
      if (input.source === sourceName) this._clearDistanceInput(key);
    }
    if (this.activeDistanceSource
      && this.distanceInputs[this.activeDistanceSource].source === sourceName) {
      this.activeDistanceSource = null;
    }
  }

  _clearDistanceInput(key) {
    const input = this.distanceInputs[key];
    input.availableAtMs = null;
    input.anchor = null;
    input.anchorAtMs = null;
    input.stallCount = 0;
    input.fieldMissingCount = 0;
    input.speedFallbackActive = false;
    input.pendingSpeedDistanceM = 0;
    input.resetCandidate = null;
    input.pendingSegments = [];
  }

  _suspendImuDistanceInput(nowMs) {
    const input = this.distanceInputs.imuEstimate;
    input.availableAtMs = null;
    if (this.activeDistanceSource === 'imuEstimate') {
      this.activeDistanceSource = null;
    }
    this._selectDistanceSource(nowMs);
  }

  _clearImuDistanceInput(nowMs) {
    this._clearDistanceInput('imuEstimate');
    if (this.activeDistanceSource === 'imuEstimate') {
      this.activeDistanceSource = null;
    }
    this._selectDistanceSource(nowMs);
  }

  _resetAllAnchors() {
    for (const source of Object.values(this.sources)) {
      source.wheelPrev = null;
      source.wheelResetCandidate = null;
      source.crankPrev = null;
      source.crankResetCandidate = null;
    }
    for (const key of Object.keys(this.distanceInputs)) this._clearDistanceInput(key);
    this.activeDistanceSource = null;
  }
}
