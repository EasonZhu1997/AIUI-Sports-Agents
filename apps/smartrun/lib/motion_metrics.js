// 跑步运动指标聚合器（纯逻辑、无 AIUI/DOM 依赖）。
//
// 设计目标：
// - 没有 RSC/GPS 时，距离只由 StepDetector 已确认的落步事件推进；
// - 有标准 RSC 时，累计距离优先于速度积分；其后才是 GPS 路径与 IMU 估算；
// - RSC 持续上报 0 时不压住眼镜确认的新落步，静止且无 IMU 运动时仍保持 0；
// - 配速使用 8~12 秒距离窗口，不把一次 UI 刷新当作一次积分；
// - RSC 速度先做稳健异常过滤，再做 EMA，断流、暂停和恢复均不跨空档积分。
//
// 本模块刻意不修改 RunSession 的旧 API。页面可先并行喂入本聚合器，验证后再把
// distanceM / cadenceSpm / paceSecPerKm / source 字段接到 HUD。

const DEFAULT_MAX_SPEED_MPS = 25 / 3.6;
const RSC_ZERO_SPEED_CADENCE_IMU_EVIDENCE_MS = 1500;

export const MOTION_SOURCE = Object.freeze({
  NONE: 'none',
  IMU_STEP: 'imu_step',
  GPS_PATH: 'gps_path',
  RSC_SPEED: 'rsc_speed',
  RSC_TOTAL_DISTANCE: 'rsc_total_distance',
  HYBRID: 'hybrid',
});

export const CADENCE_SOURCE = Object.freeze({
  NONE: 'none',
  IMU: 'imu',
  RSC: 'rsc',
});

function finiteInRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function combineSource(left, right) {
  if (!left || left === MOTION_SOURCE.NONE) return right || MOTION_SOURCE.NONE;
  if (!right || right === MOTION_SOURCE.NONE) return left;
  return left === right ? left : MOTION_SOURCE.HYBRID;
}

/**
 * 聚合 RSC、过滤后的 GPS 路径距离与眼镜 IMU 运动指标。
 *
 * 所有时间戳必须使用同一毫秒时间基准。推荐传入 Accelerometer.timestamp 经页面
 * 归一化后的值；无法取得时才回退 Date.now()。
 */
export class MotionMetrics {
  constructor(options = {}) {
    if (Number.isFinite(options)) options = { startMs: options };

    this.startMs = options.startMs ?? 0;
    this.stepLengthM = options.stepLengthM ?? 0.85;
    this.distanceEnabled = options.distanceEnabled ?? options.trackDistance ?? true;
    this.paceWindowMs = options.paceWindowMs ?? 10000;
    this.minPaceWindowMs = options.minPaceWindowMs ?? 8000;
    this.minPaceDistanceM = options.minPaceDistanceM ?? 8;
    this.minPaceSpeedMps = options.minPaceSpeedMps ?? 0.3;
    this.maxSpeedMps = options.maxSpeedMps ?? DEFAULT_MAX_SPEED_MPS;
    this.rscFreshMs = options.rscFreshMs ?? 2500;
    this.gpsFreshMs = options.gpsFreshMs ?? 5000;
    this.imuFreshMs = options.imuFreshMs ?? 2500;
    this.rscIntegrationGapMs = options.rscIntegrationGapMs ?? 3000;
    this.rscTotalGraceMs = options.rscTotalGraceMs ?? 2500;
    this.rscTotalStallSamples = options.rscTotalStallSamples ?? 2;
    this.totalDistanceJumpToleranceM = options.totalDistanceJumpToleranceM ?? 2;
    this.speedMedianWindow = options.speedMedianWindow ?? 5;
    this.speedEmaAlpha = options.speedEmaAlpha ?? 0.35;
    this.speedOutlierAbsMps = options.speedOutlierAbsMps ?? 2;
    this.speedOutlierRatio = options.speedOutlierRatio ?? 0.65;
    this.speedStepConfirmSamples = options.speedStepConfirmSamples ?? 3;
    this.speedStepConsistencyAbsMps = options.speedStepConsistencyAbsMps ?? 0.75;
    this.speedStepConsistencyRatio = options.speedStepConsistencyRatio ?? 0.2;
    this.cadenceWindow = options.cadenceWindow ?? 12;
    this.minImuCadenceIntervals = options.minImuCadenceIntervals ?? 3;
    this.minImuStepIntervalMs = options.minImuStepIntervalMs ?? 220;
    this.maxImuStepIntervalMs = options.maxImuStepIntervalMs ?? 1500;
    this.imuCadenceResetGapMs = options.imuCadenceResetGapMs ?? 4000;
    // 总配速只作为停步后的稳健兜底。超过 30:00/km 通常意味着距离证据
    // 太少或传感器异常，不把这种数值直接展示给用户。
    this.maxEstimatedPaceSecPerKm = options.maxEstimatedPaceSecPerKm ?? 1800;

    if (!finiteInRange(this.stepLengthM, 0.2, 2.5)) {
      throw new RangeError('stepLengthM must be between 0.2 and 2.5 metres');
    }
    if (!(this.paceWindowMs >= 8000 && this.paceWindowMs <= 12000)) {
      throw new RangeError('paceWindowMs must be between 8000 and 12000 ms');
    }
    if (!(this.minPaceWindowMs > 0 && this.minPaceWindowMs <= this.paceWindowMs)) {
      throw new RangeError('minPaceWindowMs must be within paceWindowMs');
    }
    if (!(Number.isInteger(this.rscTotalStallSamples)
        && this.rscTotalStallSamples >= 2
        && this.rscTotalStallSamples <= 3)) {
      throw new RangeError('rscTotalStallSamples must be 2 or 3');
    }
    if (!(Number.isInteger(this.minImuCadenceIntervals)
        && this.minImuCadenceIntervals >= 2
        && this.minImuCadenceIntervals <= this.cadenceWindow)) {
      throw new RangeError('minImuCadenceIntervals must be within cadenceWindow');
    }
    if (!(this.imuCadenceResetGapMs > this.maxImuStepIntervalMs)) {
      throw new RangeError('imuCadenceResetGapMs must exceed maxImuStepIntervalMs');
    }

    this.distanceM = 0;
    this.acceptedSteps = 0;
    this.paused = false;
    this.pauseStartMs = null;
    this.pausedAccumMs = 0;

    this.lastAcceptedStepMs = null;
    this.imuStepTimes = [];
    this.imuCadenceSpm = 0;
    this.imuCadenceReady = false;
    // 跑后平均步频必须来自真实 accepted-step 间隔，而不是 1Hz HUD 恰好
    // 采到的瞬时值。只累计规范步间隔；停步/暂停的长空档不会摊薄均值。
    this.imuCadenceIntervalTotalMs = 0;
    this.imuCadenceIntervalCount = 0;
    this.imuOverridesZeroRsc = false;
    this.lastImuCadenceMs = null;
    this.lastImuDistanceMs = null;

    this.rscConnected = false;
    this.lastRscSeenMs = null;
    // 只有正速度或可信的累计距离正增量才算“RSC 正在提供跑速”。
    // 订阅成功、首个累计距离基线以及持续的 0 值都不能点亮配速接入状态。
    this.lastRscMotionMs = null;
    this.rscCadenceSpm = null;
    this.lastRscCadenceMs = null;
    this.rscStrideLengthM = null;
    this.rscCadenceSum = 0;
    this.rscCadenceCount = 0;
    this.rscPaceConfirmed = false;
    this.lastRscPaceAtMs = null;
    this.lastRscPaceSpeedMps = null;
    this.rscPaceSource = MOTION_SOURCE.NONE;

    this.rawRscSpeeds = [];
    this.filteredRscSpeedMps = null;
    this.lastSpeedFilterMs = null;
    this.lastIntegratedRscSpeedMps = null;
    this.lastIntegratedRscSpeedMs = null;
    this.rejectedRscSpeedSamples = 0;
    this.pendingRscSpeedDirection = 0;
    this.pendingRscSpeedSamples = [];
    this.pendingRscSpeedMs = null;

    this.rscTotalObserved = false;
    this.lastRscTotalM = null;
    this.lastRscTotalMs = null;
    this.pendingRscTotalJumpSamples = 0;
    this.rscTotalStallCount = 0;
    this.rscTotalSpeedFallbackActive = false;
    this.rscTotalPendingSpeedDistanceM = 0;
    this.lastRscTotalMotionMs = null;
    this.rscTotalReanchorNeeded = true;
    this.usedRscSpeedSinceTotal = false;
    this.usedImuSinceRsc = false;

    // GPS 只接收 GpsPathTracker 已过滤后的单调累计距离；本聚合器不接触、
    // 保存或上传坐标。任一更高优先级/兜底来源用过距离后，GPS 恢复首包
    // 必须重锚，避免把同一段运动重复计入。
    this.lastGpsSeenMs = null;
    this.lastGpsMotionMs = null;
    this.lastGpsTotalM = null;
    this.lastGpsTotalMs = null;
    this.gpsAccuracyM = null;
    this.gpsReanchorNeeded = true;

    this.lastDistanceSource = MOTION_SOURCE.NONE;
    this.distancePoints = [{ t: 0, d: 0, source: MOTION_SOURCE.NONE }];
    this.movementStartActiveMs = null;
    this.lastMovementActiveMs = null;
    // 首个纯 IMU accepted step 已经代表一个完整步距，但当刻尚不知道该步
    // 对应的时间区间。先记住它的 active-time 锚点，等下一条合法步间隔到来
    // 后向前回锚一个间隔；这样距离仍严格等于 confirmed steps × step length，
    // 总配速也不会把首步距离除以少一个步间隔。RSC/GPS 一旦提供正运动证据，
    // 会取消这条仅属于纯 IMU 起跑段的待回锚。
    this.pendingInitialImuMovementActiveMs = null;
  }

  /** 更新 IMU 兜底使用的“单步长度”，只影响后续确认的步。 */
  setStepLengthM(stepLengthM) {
    if (!finiteInRange(stepLengthM, 0.2, 2.5)) return false;
    this.stepLengthM = stepLengthM;
    return true;
  }

  /**
   * 喂入 StepDetector 返回 stepped=true 的一次落步。
   * RSC 运动数据新鲜时仍记录 IMU 步数/步频，但不重复累加距离。
   */
  onAcceptedStep(nowMs, cadenceSpm = null) {
    if (!Number.isFinite(nowMs) || nowMs < this.startMs || this.paused) return false;
    if (this.lastAcceptedStepMs != null && nowMs <= this.lastAcceptedStepMs) return false;
    if (this.lastAcceptedStepMs != null
        && nowMs - this.lastAcceptedStepMs < this.minImuStepIntervalMs) {
      return false;
    }

    const gapMs = this.lastAcceptedStepMs == null ? null : nowMs - this.lastAcceptedStepMs;
    if (gapMs != null
        && gapMs >= this.minImuStepIntervalMs
        && gapMs <= this.maxImuStepIntervalMs) {
      this._backfillInitialImuMovementInterval(gapMs);
    }
    this.lastAcceptedStepMs = nowMs;
    this.acceptedSteps += 1;
    if (gapMs != null
        && gapMs >= this.minImuStepIntervalMs
        && gapMs <= this.maxImuStepIntervalMs) {
      this.imuCadenceIntervalTotalMs += gapMs;
      this.imuCadenceIntervalCount += 1;
    }
    if (gapMs != null && gapMs > this.imuCadenceResetGapMs) {
      // 停步/长漏包后的第一步是新的节奏锚点，不能与上一段拼出虚假低步频。
      this.imuStepTimes = [];
      this.imuCadenceSpm = 0;
      this.imuCadenceReady = false;
      this.imuOverridesZeroRsc = false;
    }
    this.imuStepTimes.push(nowMs);
    if (this.imuStepTimes.length > this.cadenceWindow + 1) this.imuStepTimes.shift();

    // cadenceSpm 是上游单通道峰值检测器的候选节奏，只能用于仲裁周期证据。
    // 最终 HUD 步频必须按已经真正提交的 accepted step 时间间隔计算，否则
    // 检测器把一次 2× 漏峰间隔归一化后，会得到 200spm 候选值但实际只
    // 提交 100spm 的落步，造成步频和距离/配速互相矛盾。
    this.imuCadenceSpm = this._deriveImuCadence();
    if (this.imuCadenceSpm > 0) this.imuCadenceReady = true;
    if (this.imuCadenceSpm > 0 && this.rscConnected && this.rscCadenceSpm === 0) {
      this.imuOverridesZeroRsc = true;
    }
    this.lastImuCadenceMs = nowMs;

    if (!this.distanceEnabled) return true;
    if (this._isRscMotionFresh(nowMs) || this._isGpsMotionFresh(nowMs)) return true;

    const startsPureImuMovement = this.movementStartActiveMs == null;
    this._addDistance(this.stepLengthM, nowMs, MOTION_SOURCE.IMU_STEP);
    if (startsPureImuMovement && this.movementStartActiveMs != null) {
      this.pendingInitialImuMovementActiveMs = this.movementStartActiveMs;
    }
    this.lastImuDistanceMs = nowMs;
    // 断流期间已由 IMU 补距：RSC 恢复时必须先重新锚定，避免累计距离补包重复计算。
    this.usedImuSinceRsc = true;
    this.rscTotalReanchorNeeded = true;
    this.lastIntegratedRscSpeedMps = null;
    this.lastIntegratedRscSpeedMs = null;
    this.gpsReanchorNeeded = true;
    return true;
  }

  /**
   * 喂入 GpsPathTracker 的内存态累计距离。
   *
   * GPS 位于 RSC 之后、IMU 之前：RSC 新鲜时只跟随基线；GPS 新鲜时
   * onAcceptedStep 仍计步/步频但不重复累距；GPS 断流后 IMU 立即接管。
   */
  onGpsPathMeasurement(measurement, nowMs) {
    const emptyResult = {
      accepted: false,
      distanceAddedM: 0,
      distanceSource: MOTION_SOURCE.NONE,
      reanchored: false,
    };
    const totalDistanceM = Number(measurement?.totalDistanceM);
    if (!Number.isFinite(nowMs)
        || nowMs < this.startMs
        || !Number.isFinite(totalDistanceM)
        || totalDistanceM < 0
        || (this.lastGpsSeenMs != null && nowMs < this.lastGpsSeenMs)) {
      return emptyResult;
    }

    this.lastGpsSeenMs = nowMs;
    if (Number.isFinite(measurement?.accuracyM) && measurement.accuracyM >= 0) {
      this.gpsAccuracyM = measurement.accuracyM;
    }

    const hasPositiveSegment = measurement?.live === true
      && Number.isFinite(measurement?.deltaDistanceM)
      && measurement.deltaDistanceM > 0;
    if (hasPositiveSegment) this.lastGpsMotionMs = nowMs;

    if (this.paused) {
      this.lastGpsTotalM = totalDistanceM;
      this.lastGpsTotalMs = nowMs;
      this.gpsReanchorNeeded = true;
      return { ...emptyResult, accepted: true, reanchored: true };
    }

    const rscFresh = this._isRscMotionFresh(nowMs);
    const mustReanchor = this.gpsReanchorNeeded
      || this.lastGpsTotalM == null
      || this.lastGpsTotalMs == null
      || rscFresh;

    if (mustReanchor) {
      this.lastGpsTotalM = totalDistanceM;
      this.lastGpsTotalMs = nowMs;
      // 只在 RSC 不再占优时完成切源；RSC 仍新鲜则保持棘轮，待其断流后
      // 再跳过一个 GPS 段，彻底消除两源交界处的重叠。
      this.gpsReanchorNeeded = rscFresh;
      return { ...emptyResult, accepted: true, reanchored: true };
    }

    if (nowMs <= this.lastGpsTotalMs) return emptyResult;
    const segmentStartMs = this.lastGpsTotalMs;
    const deltaM = totalDistanceM - this.lastGpsTotalM;
    const dtSec = (nowMs - this.lastGpsTotalMs) / 1000;
    const maxPlausibleDeltaM = this.maxSpeedMps * dtSec
      + this.totalDistanceJumpToleranceM;

    this.lastGpsTotalM = totalDistanceM;
    this.lastGpsTotalMs = nowMs;
    if (deltaM < 0 || deltaM > maxPlausibleDeltaM) {
      this.gpsReanchorNeeded = true;
      return { ...emptyResult, accepted: true, reanchored: true };
    }
    if (!(deltaM > 0)) return { ...emptyResult, accepted: true };

    if (this.movementStartActiveMs == null) {
      // 当前 delta 覆盖上一条 GPS 总量锚点到本包之间的完整线段。若等到
      // _addDistance(nowMs) 才建立运动起点，首段距离会进入分母、首段时间却
      // 被漏掉，GPS-only 总配速会系统性偏快。暂停/断流已通过 mustReanchor
      // 分支切断，因此这里只需使用本段真实起点。
      this._markMovement(segmentStartMs);
    }
    const distanceAddedM = this._addDistance(deltaM, nowMs, MOTION_SOURCE.GPS_PATH);
    if (distanceAddedM > 0) {
      // GPS 已经覆盖本段运动。之后 RSC 首包和累计距离首包都只重锚，
      // 不能补回 GPS 已记过的同一段。
      this.usedImuSinceRsc = true;
      this.rscTotalReanchorNeeded = true;
      this.lastIntegratedRscSpeedMps = null;
      this.lastIntegratedRscSpeedMs = null;
    }
    return {
      accepted: true,
      distanceAddedM,
      distanceSource: distanceAddedM > 0
        ? MOTION_SOURCE.GPS_PATH
        : MOTION_SOURCE.NONE,
      reanchored: false,
    };
  }

  /** 持续定位停止/断流：立即允许 IMU 兜底，下次 GPS 首段只重锚。 */
  onGpsDisconnected(nowMs) {
    if (Number.isFinite(nowMs)) this.lastGpsSeenMs = nowMs;
    this.lastGpsMotionMs = null;
    this.gpsReanchorNeeded = true;
  }

  /** 可选：当 StepDetector 已自行得出停步/步频时更新显示，不推进距离。 */
  onImuCadence(cadenceSpm, nowMs) {
    const cadenceValid = cadenceSpm === 0 || finiteInRange(cadenceSpm, 40, 260);
    if (!cadenceValid || !Number.isFinite(nowMs) || this.paused) {
      return false;
    }
    // 一旦 accepted-step 时间窗已经形成正式步频，上游 StepDetector 的候选
    // cadence 只能继续参与活动仲裁，不能反向覆盖最终值。低频宿主的候选值
    // 很容易落在 150/160/180spm 的回调网格上；若在每帧写回，会把已经由
    // 真实落步间隔推导出的步频系统性抬高或压低，并同步污染 IMU 配速。
    if (cadenceSpm > 0
        && this.imuCadenceReady
        && this._deriveImuCadence() > 0) {
      return false;
    }
    // StepDetector 尚未形成过有效节奏时，0 只是“还算不出来”，不是可信停步。
    // 不让这个占位值抢走仍在正常上报的 RSC cadence。
    if (cadenceSpm === 0 && !this.imuCadenceReady) return false;
    if (cadenceSpm > 0) {
      this.imuCadenceSpm = cadenceSpm;
      this.imuCadenceReady = true;
      if (this.rscConnected && this.rscCadenceSpm === 0) {
        this.imuOverridesZeroRsc = true;
      }
    } else {
      // DualStepArbiter 会在两个已确认落步之间持续返回 0。这个 0 只表示
      // 当前帧没有形成新的周期，不是用户已经停步；过早覆盖会让 1Hz HUD
      // 恰好采到空帧并把已经形成的有效步频重新显示成 “--”。
      if (this.lastAcceptedStepMs != null
          && nowMs - this.lastAcceptedStepMs <= this.maxImuStepIntervalMs) {
        return false;
      }
      this.imuCadenceSpm = 0;
      this.imuOverridesZeroRsc = false;
      if (this.lastAcceptedStepMs != null
          && nowMs - this.lastAcceptedStepMs > this.maxImuStepIntervalMs) {
        // StepDetector 超时后的 0 表示“当前没有可用周期”，不是应长期显示的
        // 数值步频。保留累计步数，但恢复未就绪占位语义。
        this.imuCadenceReady = false;
      }
    }
    this.lastImuCadenceMs = nowMs;
    return true;
  }

  /**
   * 喂入 parseRscMeasurement() 的结果。
   * @returns {{accepted:boolean, speedAccepted:boolean, incoherentSpeed:boolean,
   *            outlierRejected:boolean, distanceAddedM:number, distanceSource:string}}
   */
  onRscMeasurement(measurement, nowMs = measurement?.timestampMs) {
    const emptyResult = {
      accepted: false,
      speedAccepted: false,
      incoherentSpeed: false,
      outlierRejected: false,
      distanceAddedM: 0,
      distanceSource: MOTION_SOURCE.NONE,
    };
    if (!measurement || !Number.isFinite(nowMs) || nowMs < this.startMs) return emptyResult;
    if (this.lastRscSeenMs != null && nowMs < this.lastRscSeenMs) return emptyResult;

    const speedValid = finiteInRange(measurement.speedMps, 0, this.maxSpeedMps);
    const cadenceValid = finiteInRange(measurement.cadenceSpm, 0, 300);
    const totalValid = Number.isFinite(measurement.totalDistanceM)
      && measurement.totalDistanceM >= 0;
    const totalChangedAfterSpeedFallback = totalValid
      && this.usedRscSpeedSinceTotal
      && this.lastRscTotalM != null
      && measurement.totalDistanceM !== this.lastRscTotalM;
    const totalNeedsReanchor = this.rscTotalReanchorNeeded
      || totalChangedAfterSpeedFallback
      || this.usedImuSinceRsc
      || this.lastRscTotalM == null
      || this.lastRscTotalMs == null;
    const totalDeltaM = totalValid && this.lastRscTotalM != null
      ? measurement.totalDistanceM - this.lastRscTotalM : null;
    const totalDeltaDtSec = totalValid && this.lastRscTotalMs != null
      ? (nowMs - this.lastRscTotalMs) / 1000 : null;
    const plausiblePositiveTotalDelta = !totalNeedsReanchor
      && Number.isFinite(totalDeltaM) && totalDeltaM > 0
      && Number.isFinite(totalDeltaDtSec) && totalDeltaDtSec > 0
      && totalDeltaM <= this.maxSpeedMps * totalDeltaDtSec
        + this.totalDistanceJumpToleranceM;
    const recentImuAcceptedStep = this.lastAcceptedStepMs != null
      && nowMs - this.lastAcceptedStepMs >= 0
      && nowMs - this.lastAcceptedStepMs
        <= RSC_ZERO_SPEED_CADENCE_IMU_EVIDENCE_MS;
    // 部分桥会在已经停下后继续重复最后一条正 cadence，同时 speed 固定在
    // 0–0.1m/s 的量化/抖动区间。
    // 这种包仍证明 RSC 链路活着，但不能无限刷新“当前步频”。只有同包已有
    // 可信累计距离正增量，或眼镜在最近 1.5 秒确认过真实落步，才把 0 速正
    // cadence 当作运动证据。该门是产品语义校验，不是 Bluetooth SIG 规则。
    const zeroSpeedPositiveCadence = cadenceValid && measurement.cadenceSpm > 0
      && speedValid && measurement.speedMps <= 0.1;
    const zeroSpeedCadenceHasMotionEvidence = plausiblePositiveTotalDelta
      || recentImuAcceptedStep;
    // 单个“速度仍明显大于 0、步频却突然为 0”的 RSC 包自相矛盾。
    // 不提交这条 0；下面会让旧设备步频立即失效，_currentCadence 自然回退 IMU。
    const cadenceCoherent = cadenceValid
      && (measurement.cadenceSpm > 0 || !speedValid || measurement.speedMps <= 0.1)
      && (!zeroSpeedPositiveCadence || zeroSpeedCadenceHasMotionEvidence);
    // 0x2A53 的即时速度与即时步频是同一包里的基础字段。正速度配零步频
    // 是相互矛盾的瞬时状态，常见于设备进入/退出运动模式时的旧速度尾包。
    // 旧版只保护了 HUD 步频，却仍让该速度点亮 3–4 分配速；现在正速度
    // 必须同时具备正步频，明确的 0/0 停止包仍然正常进入停止链。
    const speedCadenceCoherent = speedValid
      && (measurement.speedMps === 0
        || (cadenceCoherent && measurement.cadenceSpm > 0));
    const strideValid = finiteInRange(measurement.strideLengthM, 0.2, 2.5);
    if (!speedValid && !cadenceValid && !totalValid && !strideValid) return emptyResult;

    this.rscConnected = true;
    this.lastRscSeenMs = nowMs;
    if (cadenceCoherent) {
      this.rscCadenceSpm = measurement.cadenceSpm;
      this.lastRscCadenceMs = nowMs;
      if (!this.paused && measurement.cadenceSpm > 0) {
        this.imuOverridesZeroRsc = false;
        this.rscCadenceSum += measurement.cadenceSpm;
        this.rscCadenceCount += 1;
      }
    }
    if (strideValid) this.rscStrideLengthM = measurement.strideLengthM;

    if (speedValid && measurement.speedMps > 0 && !speedCadenceCoherent) {
      // 不让矛盾尾包延长旧 RSC 配速的新鲜度；HRS/GATT 生命周期保持不变，
      // 后续合法的正速度+正步频包仍可立即重新接管。
      this.lastRscMotionMs = null;
      this.lastRscCadenceMs = null;
      this.rscCadenceSpm = null;
      this.rscPaceConfirmed = false;
      this.lastRscPaceAtMs = null;
      this.lastRscPaceSpeedMps = null;
      this.rscPaceSource = MOTION_SOURCE.NONE;
      this.filteredRscSpeedMps = null;
      this.rawRscSpeeds = [];
      this._clearPendingRscSpeedStep();
      this.lastSpeedFilterMs = null;
      this.lastIntegratedRscSpeedMps = null;
      this.lastIntegratedRscSpeedMs = null;
    }

    const filtered = speedCadenceCoherent
      ? this._filterRscSpeed(measurement.speedMps, nowMs)
      : { accepted: false, outlierRejected: false, value: this.filteredRscSpeedMps };
    if (filtered.outlierRejected) this.rejectedRscSpeedSamples += 1;
    if (filtered.accepted && filtered.value > 0) {
      this.lastRscMotionMs = nowMs;
      this.gpsReanchorNeeded = true;
      if (!this.paused) {
        this.pendingInitialImuMovementActiveMs = null;
        this._markMovement(nowMs);
      }
      this._confirmRscPace(filtered.value, nowMs, MOTION_SOURCE.RSC_SPEED);
    } else if (filtered.accepted && filtered.value === 0) {
      // 明确的 0 速度是停止边沿，不得继续压住此后真实发生的 IMU 落步。
      // GATT/订阅是否仍存活由 rscConnected / lastRscSeenMs 单独表达。
      this.lastRscMotionMs = null;
      this.lastRscPaceAtMs = null;
      this.lastRscPaceSpeedMps = null;
    }

    if (this.paused) {
      // 暂停期间只更新最近值与累计距离锚点；恢复后第一帧不会跨暂停段积分。
      if (totalValid) {
        this.rscTotalObserved = true;
        this.lastRscTotalM = measurement.totalDistanceM;
        this.lastRscTotalMs = nowMs;
      }
      this.rscTotalReanchorNeeded = true;
      this.lastIntegratedRscSpeedMps = null;
      this.lastIntegratedRscSpeedMs = null;
      return {
        ...emptyResult,
        accepted: true,
        speedAccepted: filtered.accepted,
        incoherentSpeed: speedValid
          && measurement.speedMps > 0
          && !speedCadenceCoherent,
        outlierRejected: filtered.outlierRejected,
      };
    }

    let distanceAddedM = 0;
    let distanceSource = MOTION_SOURCE.NONE;

    if (totalValid) {
      this.rscTotalObserved = true;
      const mustReanchor = totalNeedsReanchor;

      if (!mustReanchor && nowMs > this.lastRscTotalMs) {
        const deltaM = measurement.totalDistanceM - this.lastRscTotalM;
        const dtSec = (nowMs - this.lastRscTotalMs) / 1000;
        const maxPlausibleDeltaM = this.maxSpeedMps * dtSec
          + this.totalDistanceJumpToleranceM;

        if (deltaM > 0 && deltaM <= maxPlausibleDeltaM) {
          if (this.movementStartActiveMs == null) {
            // 累计距离只能证明运动发生在相邻两包之间。长间隔时最多回看
            // 一个积分窗口，避免把开跑前长时间等待误算成运动时间。
            const segmentStartMs = nowMs - Math.min(
              nowMs - this.lastRscTotalMs,
              this.rscIntegrationGapMs,
            );
            this._markMovement(segmentStartMs);
          }
          distanceAddedM = this._addDistance(
            deltaM,
            nowMs,
            MOTION_SOURCE.RSC_TOTAL_DISTANCE,
          );
          if (distanceAddedM > 0) {
            distanceSource = MOTION_SOURCE.RSC_TOTAL_DISTANCE;
            this.lastRscMotionMs = nowMs;
            this.lastRscTotalMotionMs = nowMs;
            this.gpsReanchorNeeded = true;
            // RSC 规范允许累计距离存在而即时速度不可用。此时用本次可信
            // 增量推导即时速度，只用于接入状态/即时配速，不替代滚动配速。
            if (!(filtered.accepted && filtered.value > 0) && dtSec > 0) {
              this._confirmRscPace(
                distanceAddedM / dtSec,
                nowMs,
                MOTION_SOURCE.RSC_TOTAL_DISTANCE,
              );
            }
          }
          this.lastRscTotalM = measurement.totalDistanceM;
          this.lastRscTotalMs = nowMs;
          this.pendingRscTotalJumpSamples = 0;
          this.rscTotalStallCount = 0;
          this.rscTotalSpeedFallbackActive = false;
          this.rscTotalPendingSpeedDistanceM = 0;
          this.usedRscSpeedSinceTotal = false;
          this.lastIntegratedRscSpeedMps = filtered.accepted ? filtered.value : null;
          this.lastIntegratedRscSpeedMs = filtered.accepted ? nowMs : null;
        } else if (deltaM === 0) {
          this.rscTotalStallCount += 1;
          if (filtered.accepted
              && this.lastIntegratedRscSpeedMps != null
              && this.lastIntegratedRscSpeedMs != null
              && nowMs > this.lastIntegratedRscSpeedMs
              && nowMs - this.lastIntegratedRscSpeedMs <= this._rscGapLimitMs()) {
            const speedDtSec = (nowMs - this.lastIntegratedRscSpeedMs) / 1000;
            this.rscTotalPendingSpeedDistanceM += (
              this.lastIntegratedRscSpeedMps + filtered.value
            ) * 0.5 * speedDtSec;
          }
          this.lastIntegratedRscSpeedMps = filtered.accepted ? filtered.value : null;
          this.lastIntegratedRscSpeedMs = filtered.accepted ? nowMs : null;

          if (this.rscTotalStallCount >= this.rscTotalStallSamples
              && this.rscTotalPendingSpeedDistanceM > 0) {
            distanceAddedM = this._addDistance(
              this.rscTotalPendingSpeedDistanceM,
              nowMs,
              MOTION_SOURCE.RSC_SPEED,
            );
            this.rscTotalPendingSpeedDistanceM = 0;
            if (distanceAddedM > 0) {
              distanceSource = MOTION_SOURCE.RSC_SPEED;
              this.rscTotalSpeedFallbackActive = true;
              this.usedRscSpeedSinceTotal = true;
              this.gpsReanchorNeeded = true;
            }
          }
          this.pendingRscTotalJumpSamples = 0;
        } else if (deltaM < 0) {
          // 设备累计距离重置或回绕，只重建基线，不产生负距离。
          this.lastRscTotalM = measurement.totalDistanceM;
          this.lastRscTotalMs = nowMs;
          this.pendingRscTotalJumpSamples = 0;
          this.rscTotalStallCount = 0;
          this.rscTotalSpeedFallbackActive = false;
          this.rscTotalPendingSpeedDistanceM = 0;
          this.usedRscSpeedSinceTotal = false;
          this.lastIntegratedRscSpeedMps = filtered.accepted ? filtered.value : null;
          this.lastIntegratedRscSpeedMs = filtered.accepted ? nowMs : null;
        } else {
          // 持续的正偏移通常是设备重启、模式切换或累计值换了命名空间。
          // 前两包仍等待旧基线恢复；第三包只重锚而不把整段偏移吞入本次距离。
          this.pendingRscTotalJumpSamples += 1;
          this.rscTotalStallCount = 0;
          this.rscTotalPendingSpeedDistanceM = 0;
          if (this.pendingRscTotalJumpSamples >= 3) {
            this.lastRscTotalM = measurement.totalDistanceM;
            this.lastRscTotalMs = nowMs;
            this.pendingRscTotalJumpSamples = 0;
          }
        }
        // 单次过大正跳变不移动旧基线；下一帧正常值仍可从最后可信值恢复。
      } else {
        this.lastRscTotalM = measurement.totalDistanceM;
        this.lastRscTotalMs = nowMs;
        this.pendingRscTotalJumpSamples = 0;
        this.rscTotalStallCount = 0;
        this.rscTotalSpeedFallbackActive = false;
        this.rscTotalPendingSpeedDistanceM = 0;
        this.usedRscSpeedSinceTotal = false;
        this.lastIntegratedRscSpeedMps = filtered.accepted ? filtered.value : null;
        this.lastIntegratedRscSpeedMs = filtered.accepted ? nowMs : null;
      }

      this.rscTotalReanchorNeeded = false;
      this.usedImuSinceRsc = false;
    } else if (filtered.accepted) {
      const totalStillFresh = !this.rscTotalSpeedFallbackActive
        && this.rscTotalObserved
        && this.lastRscTotalMs != null
        && nowMs - this.lastRscTotalMs <= this.rscTotalGraceMs;

      if (!totalStillFresh
        && this.lastIntegratedRscSpeedMps != null
        && this.lastIntegratedRscSpeedMs != null
        && nowMs > this.lastIntegratedRscSpeedMs
        && nowMs - this.lastIntegratedRscSpeedMs <= this._rscGapLimitMs()) {
        const dtSec = (nowMs - this.lastIntegratedRscSpeedMs) / 1000;
        const deltaM = (this.lastIntegratedRscSpeedMps + filtered.value) * 0.5 * dtSec;
        distanceAddedM = this._addDistance(deltaM, nowMs, MOTION_SOURCE.RSC_SPEED);
        if (distanceAddedM > 0) {
          distanceSource = MOTION_SOURCE.RSC_SPEED;
          this.gpsReanchorNeeded = true;
        }
        if (this.rscTotalObserved) this.usedRscSpeedSinceTotal = true;
      }

      this.lastIntegratedRscSpeedMps = filtered.value;
      this.lastIntegratedRscSpeedMs = nowMs;
      // 持续的 0 速度不能抹去 IMU 已经补距的事实，否则稍后恢复的
      // RSC 累计距离可能把同一段运动再次计入。
      if (filtered.value > 0) this.usedImuSinceRsc = false;
    }

    return {
      accepted: true,
      speedAccepted: filtered.accepted,
      incoherentSpeed: speedValid
        && measurement.speedMps > 0
        && !speedCadenceCoherent,
      outlierRejected: filtered.outlierRejected,
      distanceAddedM,
      distanceSource,
    };
  }

  /** GATT 断开：立刻允许 IMU 补位，并封死跨断流积分。 */
  onRscDisconnected(nowMs) {
    if (Number.isFinite(nowMs)) this.lastRscSeenMs = nowMs;
    this.rscConnected = false;
    this.lastRscMotionMs = null;
    this.lastRscCadenceMs = null;
    this.imuOverridesZeroRsc = false;
    this.filteredRscSpeedMps = null;
    this.rawRscSpeeds = [];
    this._clearPendingRscSpeedStep();
    this.lastSpeedFilterMs = null;
    this.lastIntegratedRscSpeedMps = null;
    this.lastIntegratedRscSpeedMs = null;
    this.rscPaceConfirmed = false;
    this.lastRscPaceAtMs = null;
    this.lastRscPaceSpeedMps = null;
    this.rscPaceSource = MOTION_SOURCE.NONE;
    this.rscTotalReanchorNeeded = true;
    this.pendingRscTotalJumpSamples = 0;
    this.rscTotalStallCount = 0;
    this.rscTotalSpeedFallbackActive = false;
    this.rscTotalPendingSpeedDistanceM = 0;
    this.lastRscTotalMotionMs = null;
    this.usedRscSpeedSinceTotal = false;
  }

  pause(nowMs) {
    if (this.paused || !Number.isFinite(nowMs)) return false;
    this.paused = true;
    this.pauseStartMs = nowMs;
    this._resetRscIntegrationAnchors();
    this._resetGpsIntegrationAnchors(nowMs);
    return true;
  }

  resume(nowMs) {
    if (!this.paused || !Number.isFinite(nowMs) || nowMs < this.pauseStartMs) return false;
    this.pausedAccumMs += nowMs - this.pauseStartMs;
    this.pauseStartMs = null;
    this.paused = false;
    this._resetRscIntegrationAnchors();
    this._resetGpsIntegrationAnchors(nowMs);
    // 暂停前/暂停中收到的 RSC 包属于上一代可见会话。恢复后先允许 IMU
    // 立即补位；只有恢复后的首个新 RSC 包才能重新取得运动/步频优先级。
    // 以恢复时刻作为新代次下界，恢复后迟到的暂停期旧包仍会被乱序门拒绝。
    this.lastRscSeenMs = nowMs;
    this.lastRscMotionMs = null;
    this.lastRscCadenceMs = null;
    this.rscCadenceSpm = null;
    // 暂停前的 IMU 节奏同样不能在快速恢复时冒充当前读数；步数与累计距离保留，
    // 步频窗口从恢复后的新落步重新建立。
    this.imuStepTimes = [];
    // 恢复后的第一步只建立新节奏锚点。否则短暂停的墙钟空档若仍小于
    // maxImuStepIntervalMs，会被误算进跑后平均步频。
    this.lastAcceptedStepMs = null;
    this.imuCadenceSpm = 0;
    this.imuCadenceReady = false;
    this.imuOverridesZeroRsc = false;
    this.lastImuCadenceMs = null;
    this.lastImuDistanceMs = null;
    return true;
  }

  /** 运动净时长（不含暂停），ms。 */
  elapsedMs(nowMs) {
    if (!Number.isFinite(nowMs)) return 0;
    const pausedNow = this.paused ? Math.max(0, nowMs - this.pauseStartMs) : 0;
    return Math.max(0, nowMs - this.startMs - this.pausedAccumMs - pausedNow);
  }

  /**
   * 估算全程配速：从首次可信运动到最后一次距离/正速度证据。
   * 停下后分子与分母同时冻结，因此不会随着 HUD 计时继续走而越来越离谱；
   * 显式暂停仍由 active time 自然排除。
   */
  avgPaceSecPerKm(_nowMs) {
    if (!this.distanceEnabled || this.distanceM < 10
        || this.movementStartActiveMs == null
        || this.lastMovementActiveMs == null) return null;
    const movementSpanMs = this.lastMovementActiveMs - this.movementStartActiveMs;
    if (movementSpanMs < this.minPaceWindowMs) return null;
    const paceSecPerKm = movementSpanMs / 1000 / (this.distanceM / 1000);
    const minEstimatedPaceSecPerKm = 1000 / this.maxSpeedMps;
    return finiteInRange(
      paceSecPerKm,
      minEstimatedPaceSecPerKm,
      this.maxEstimatedPaceSecPerKm,
    ) ? paceSecPerKm : null;
  }

  /**
   * 跑后平均步频。
   *
   * 标准 RSC 正步频优先；否则按所有已正式提交的 IMU 落步有效间隔计算。
   * 至少形成与实时步频相同数量的间隔证据后才返回数字，避免一两次碰触
   * 在短跑总结里被包装成平均步频。
   */
  avgCadenceSpm() {
    if (this.rscCadenceCount > 0) {
      const cadence = this.rscCadenceSum / this.rscCadenceCount;
      return finiteInRange(cadence, 40, 300) ? Math.round(cadence) : null;
    }
    if (this.imuCadenceIntervalCount < this.minImuCadenceIntervals
        || !(this.imuCadenceIntervalTotalMs > 0)) return null;
    const cadence = 60000 * this.imuCadenceIntervalCount
      / this.imuCadenceIntervalTotalMs;
    return finiteInRange(cadence, 40, 260) ? Math.round(cadence) : null;
  }

  /** 当前 8~12 秒滚动窗口配速。 */
  rollingPaceSecPerKm(nowMs) {
    return this._rollingPace(nowMs)?.paceSecPerKm ?? null;
  }

  snapshot(nowMs) {
    const elapsedMs = this.elapsedMs(nowMs);
    const rolling = this.paused ? null : this._rollingPace(nowMs);
    const cadence = this._currentCadence(nowMs);
    const rscFresh = this._isRscMotionFresh(nowMs);
    const gpsFresh = this._isGpsMotionFresh(nowMs);
    const paceSecPerKm = rolling?.paceSecPerKm ?? null;
    const rscPaceReady = this.rscConnected && this.rscPaceConfirmed;
    const rscPaceLive = !this.paused
      && rscPaceReady
      && this.lastRscPaceAtMs != null
      && nowMs - this.lastRscPaceAtMs >= 0
      && nowMs - this.lastRscPaceAtMs <= this.rscFreshMs;
    const rscInstantPaceSecPerKm = rscPaceLive
      && finiteInRange(this.lastRscPaceSpeedMps, this.minPaceSpeedMps, this.maxSpeedMps)
      ? 1000 / this.lastRscPaceSpeedMps
      : null;
    const instantPaceSecPerKm = rscInstantPaceSecPerKm ?? paceSecPerKm;

    return {
      elapsedMs,
      distanceEnabled: this.distanceEnabled,
      distanceM: this.distanceM,
      steps: this.acceptedSteps,
      cadenceSpm: cadence.value,
      cadenceSource: cadence.source,
      cadenceReady: cadence.ready,
      avgCadenceSpm: this.avgCadenceSpm(),
      paceSecPerKm,
      instantPaceSecPerKm,
      instantPaceSource: rscInstantPaceSecPerKm == null
        ? (rolling?.source ?? MOTION_SOURCE.NONE)
        : this.rscPaceSource,
      avgPaceSecPerKm: this.avgPaceSecPerKm(nowMs),
      speedMps: paceSecPerKm == null ? null : 1000 / paceSecPerKm,
      distanceSource: this.lastDistanceSource,
      paceSource: rolling?.source ?? MOTION_SOURCE.NONE,
      activeMotionSource: this._activeMotionSource(nowMs),
      rscFresh,
      gpsFresh,
      gpsAccuracyM: this.gpsAccuracyM,
      rscConnected: this.rscConnected,
      rscSpeedMps: rscFresh ? this.filteredRscSpeedMps : null,
      rscPaceReady,
      rscPaceLive,
      rscPaceSource: rscPaceReady ? this.rscPaceSource : MOTION_SOURCE.NONE,
      rscInstantPaceSecPerKm,
      rscStrideLengthM: this.rscStrideLengthM,
      rejectedRscSpeedSamples: this.rejectedRscSpeedSamples,
      paused: this.paused,
    };
  }

  _deriveImuCadence() {
    if (this.imuStepTimes.length < this.minImuCadenceIntervals + 1) return 0;
    const intervals = [];
    for (let i = 1; i < this.imuStepTimes.length; i += 1) {
      const intervalMs = this.imuStepTimes[i] - this.imuStepTimes[i - 1];
      if (intervalMs >= this.minImuStepIntervalMs
          && intervalMs <= this.maxImuStepIntervalMs) {
        intervals.push(intervalMs);
      }
    }
    if (intervals.length < this.minImuCadenceIntervals) return 0;
    const middle = median(intervals);
    if (!(middle > 0)) return 0;
    const cadenceSpm = Math.round(60000 / middle);
    return finiteInRange(cadenceSpm, 40, 260) ? cadenceSpm : 0;
  }

  _filterRscSpeed(rawSpeedMps, nowMs) {
    const previousFilterMs = this.lastSpeedFilterMs;
    if (rawSpeedMps === 0) {
      this.rawRscSpeeds = [0];
      this.filteredRscSpeedMps = 0;
      this.lastSpeedFilterMs = nowMs;
      this._clearPendingRscSpeedStep();
      return { accepted: true, outlierRejected: false, value: 0 };
    }

    // 新鲜度是所有速度状态的硬边界。即使调用方把 integrationGap 配得更大，
    // 过滤器和积分器也不得跨越一个已被判定为断流的区间。
    const filterStale = previousFilterMs == null
      || nowMs - previousFilterMs > this._rscGapLimitMs();
    if (filterStale) {
      this.rawRscSpeeds = [rawSpeedMps];
      this.filteredRscSpeedMps = rawSpeedMps;
      this.lastSpeedFilterMs = nowMs;
      this._clearPendingRscSpeedStep();
      return { accepted: true, outlierRejected: false, value: rawSpeedMps };
    }

    const movingHistory = this.rawRscSpeeds.filter((value) => value > 0);
    if (movingHistory.length >= 3) {
      const centre = median(movingHistory);
      const deviations = movingHistory.map((value) => Math.abs(value - centre));
      const mad = median(deviations) ?? 0;
      const robustLimit = Math.max(
        this.speedOutlierAbsMps,
        centre * this.speedOutlierRatio,
        3 * 1.4826 * mad,
      );
      if (Math.abs(rawSpeedMps - centre) > robustLimit) {
        const direction = rawSpeedMps > centre ? 1 : -1;
        const confirmed = this._confirmRscSpeedStep(rawSpeedMps, direction, nowMs);
        if (confirmed != null) {
          return {
            accepted: true,
            outlierRejected: false,
            value: confirmed,
          };
        }
        return {
          accepted: false,
          outlierRejected: true,
          value: this.filteredRscSpeedMps,
        };
      }
    }

    this._clearPendingRscSpeedStep();
    this.rawRscSpeeds.push(rawSpeedMps);
    if (this.rawRscSpeeds.length > this.speedMedianWindow) this.rawRscSpeeds.shift();

    if (this.filteredRscSpeedMps == null || this.filteredRscSpeedMps === 0) {
      this.filteredRscSpeedMps = rawSpeedMps;
    } else {
      this.filteredRscSpeedMps += this.speedEmaAlpha
        * (rawSpeedMps - this.filteredRscSpeedMps);
    }
    this.lastSpeedFilterMs = nowMs;
    return {
      accepted: true,
      outlierRejected: false,
      value: this.filteredRscSpeedMps,
    };
  }

  /**
   * Hampel 门外的速度不一定是坏点，也可能是用户真实阶跃加/减速。
   * 连续同方向且彼此接近的 3 个候选会以其中位数重新锚定；方向变化、间隔过期
   * 或候选自身离散都会重开证据链，因此单个尖峰仍然被拒绝。
   */
  _confirmRscSpeedStep(rawSpeedMps, direction, nowMs) {
    const gapOk = this.pendingRscSpeedMs != null
      && nowMs > this.pendingRscSpeedMs
      && nowMs - this.pendingRscSpeedMs <= this._rscGapLimitMs();
    const sameDirection = direction === this.pendingRscSpeedDirection;
    let consistent = false;

    if (gapOk && sameDirection && this.pendingRscSpeedSamples.length > 0) {
      const candidateCentre = median(this.pendingRscSpeedSamples);
      const consistencyLimit = Math.max(
        this.speedStepConsistencyAbsMps,
        Math.abs(candidateCentre) * this.speedStepConsistencyRatio,
      );
      consistent = Math.abs(rawSpeedMps - candidateCentre) <= consistencyLimit;
    }

    if (!consistent) {
      this.pendingRscSpeedDirection = direction;
      this.pendingRscSpeedSamples = [rawSpeedMps];
    } else {
      this.pendingRscSpeedSamples.push(rawSpeedMps);
    }
    this.pendingRscSpeedMs = nowMs;

    if (this.pendingRscSpeedSamples.length < this.speedStepConfirmSamples) return null;

    const confirmed = median(this.pendingRscSpeedSamples);
    this.rawRscSpeeds = this.pendingRscSpeedSamples
      .slice(-this.speedMedianWindow);
    this.filteredRscSpeedMps = confirmed;
    this.lastSpeedFilterMs = nowMs;
    this._clearPendingRscSpeedStep();
    return confirmed;
  }

  _clearPendingRscSpeedStep() {
    this.pendingRscSpeedDirection = 0;
    this.pendingRscSpeedSamples = [];
    this.pendingRscSpeedMs = null;
  }

  _rscGapLimitMs() {
    return Math.min(this.rscFreshMs, this.rscIntegrationGapMs);
  }

  _isRscMotionFresh(nowMs) {
    return this.rscConnected
      && Number.isFinite(nowMs)
      && this.lastRscMotionMs != null
      && nowMs - this.lastRscMotionMs >= 0
      && nowMs - this.lastRscMotionMs <= this.rscFreshMs;
  }

  _isGpsMotionFresh(nowMs) {
    return Number.isFinite(nowMs)
      && this.lastGpsMotionMs != null
      && nowMs - this.lastGpsMotionMs >= 0
      && nowMs - this.lastGpsMotionMs <= this.gpsFreshMs;
  }

  _isImuFresh(nowMs) {
    return Number.isFinite(nowMs)
      && this.lastImuCadenceMs != null
      && nowMs - this.lastImuCadenceMs >= 0
      && nowMs - this.lastImuCadenceMs <= this.imuFreshMs;
  }

  _currentCadence(nowMs) {
    const rscFresh = this.rscConnected
      && this.lastRscCadenceMs != null
      && nowMs - this.lastRscCadenceMs >= 0
      && nowMs - this.lastRscCadenceMs <= this.rscFreshMs;
    // 0x2A53 是设备直接测得的标准跑步步频；正值新鲜时作为主来源。
    // parseRscMeasurement 已把“传感器脚落地次数/分”转换为双脚总步频，
    // 因此这里不再重复乘 2。设备持续上报 0、但眼镜检测到真实落步时，
    // 0 不能压住正的 IMU 步频；没有新 IMU 运动时仍保留可信的静止 0。
    const imuFresh = !this.paused && this.imuCadenceReady && this._isImuFresh(nowMs);
    if (!this.paused && rscFresh && this.rscCadenceSpm > 0) {
      return { value: this.rscCadenceSpm, source: CADENCE_SOURCE.RSC, ready: true };
    }
    if (imuFresh && this.imuCadenceSpm > 0
        && (!rscFresh || this.imuOverridesZeroRsc)) {
      return { value: this.imuCadenceSpm, source: CADENCE_SOURCE.IMU, ready: true };
    }
    if (!this.paused && rscFresh) {
      return { value: 0, source: CADENCE_SOURCE.RSC, ready: true };
    }
    if (imuFresh) return { value: 0, source: CADENCE_SOURCE.IMU, ready: true };
    return { value: 0, source: CADENCE_SOURCE.NONE, ready: false };
  }

  _confirmRscPace(speedMps, nowMs, source) {
    if (!(Number.isFinite(speedMps) && speedMps > 0)
        || !Number.isFinite(nowMs)
        || (source !== MOTION_SOURCE.RSC_SPEED
          && source !== MOTION_SOURCE.RSC_TOTAL_DISTANCE)) {
      return false;
    }
    this.rscPaceConfirmed = true;
    this.lastRscPaceAtMs = nowMs;
    this.lastRscPaceSpeedMps = speedMps <= this.maxSpeedMps ? speedMps : null;
    this.rscPaceSource = source;
    return true;
  }

  _activeMotionSource(nowMs) {
    if (this.paused || !this.distanceEnabled) return MOTION_SOURCE.NONE;
    if (this._isRscMotionFresh(nowMs)) {
      const totalFresh = !this.rscTotalSpeedFallbackActive
        && this.lastRscTotalMotionMs != null
        && nowMs - this.lastRscTotalMotionMs >= 0
        && nowMs - this.lastRscTotalMotionMs <= this.rscTotalGraceMs;
      return totalFresh ? MOTION_SOURCE.RSC_TOTAL_DISTANCE : MOTION_SOURCE.RSC_SPEED;
    }
    if (this._isGpsMotionFresh(nowMs)) return MOTION_SOURCE.GPS_PATH;
    if (this.lastImuDistanceMs != null
      && nowMs - this.lastImuDistanceMs >= 0
      && nowMs - this.lastImuDistanceMs <= this.imuFreshMs) {
      return MOTION_SOURCE.IMU_STEP;
    }
    return MOTION_SOURCE.NONE;
  }

  _markMovement(nowMs) {
    if (this.paused || !Number.isFinite(nowMs)) return false;
    const activeMs = this.elapsedMs(nowMs);
    if (this.movementStartActiveMs == null) {
      // 从第一条可信运动证据起算，不使用相对页面启动时间的二元宽限。
      // 这样用户无论立即起跑还是准备数秒后起跑，口径都连续且一致。
      this.movementStartActiveMs = activeMs;
    }
    if (activeMs < this.movementStartActiveMs) return false;
    if (this.lastMovementActiveMs == null || activeMs >= this.lastMovementActiveMs) {
      this.lastMovementActiveMs = activeMs;
    }
    return true;
  }

  _backfillInitialImuMovementInterval(intervalMs) {
    const firstActiveMs = this.pendingInitialImuMovementActiveMs;
    if (!Number.isFinite(firstActiveMs)
        || !Number.isFinite(intervalMs)
        || intervalMs < this.minImuStepIntervalMs
        || intervalMs > this.maxImuStepIntervalMs) return false;
    // 单次消费：后续步间隔只更新 cadence，不得反复向会话开始方向移动起点。
    this.pendingInitialImuMovementActiveMs = null;
    // 外部来源若已经建立或改写了运动起点，不能再用后到的 IMU 间隔回写它。
    if (this.movementStartActiveMs !== firstActiveMs) return false;
    this.movementStartActiveMs = Math.max(0, firstActiveMs - intervalMs);
    return true;
  }

  _addDistance(deltaM, nowMs, source) {
    if (!this.distanceEnabled || !(Number.isFinite(deltaM) && deltaM > 0)) return 0;
    if (source !== MOTION_SOURCE.IMU_STEP) {
      this.pendingInitialImuMovementActiveMs = null;
    }
    this.distanceM += deltaM;
    this.lastDistanceSource = source;
    this._markMovement(nowMs);
    this._recordDistance(this.elapsedMs(nowMs), source);
    return deltaM;
  }

  _recordDistance(activeMs, source) {
    const last = this.distancePoints[this.distancePoints.length - 1];
    if (last && last.t === activeMs) {
      last.d = this.distanceM;
      last.source = combineSource(last.source, source);
    } else {
      this.distancePoints.push({ t: activeMs, d: this.distanceM, source });
    }

    // 只保留滚动窗口前的一个锚点，长跑时内存不会随总步数无限增长。
    const cutoff = activeMs - this.paceWindowMs - 2000;
    while (this.distancePoints.length > 2 && this.distancePoints[1].t < cutoff) {
      this.distancePoints.shift();
    }
  }

  _distanceAt(activeMs) {
    const points = this.distancePoints;
    if (!points.length) return this.distanceM;
    if (activeMs <= points[0].t) return points[0].d;
    const last = points[points.length - 1];
    if (activeMs >= last.t) return last.d;

    for (let i = 1; i < points.length; i += 1) {
      const right = points[i];
      if (right.t < activeMs) continue;
      const left = points[i - 1];
      if (right.t === left.t) return right.d;
      const ratio = (activeMs - left.t) / (right.t - left.t);
      return left.d + (right.d - left.d) * ratio;
    }
    return last.d;
  }

  _rollingPace(nowMs) {
    if (!this.distanceEnabled || this.paused) return null;
    const activeSource = this._activeMotionSource(nowMs);
    if (activeSource === MOTION_SOURCE.NONE) return null;
    // 停止是边沿事件，不应被 10 秒窗口拖延。RSC 明确上报 0 速度时立即清空配速；
    // 后续 0 样本也不会再累计“尾巴距离”。
    if ((activeSource === MOTION_SOURCE.RSC_SPEED
      || activeSource === MOTION_SOURCE.RSC_TOTAL_DISTANCE)
      && this.filteredRscSpeedMps === 0) {
      return null;
    }
    const activeNow = this.elapsedMs(nowMs);
    if (activeNow < this.minPaceWindowMs) return null;
    const windowStart = Math.max(0, activeNow - this.paceWindowMs);
    const durationMs = activeNow - windowStart;
    if (durationMs < this.minPaceWindowMs) return null;

    const startDistanceM = this._distanceAt(windowStart);
    const deltaM = this.distanceM - startDistanceM;
    if (deltaM < this.minPaceDistanceM) return null;

    const speedMps = deltaM / (durationMs / 1000);
    if (!finiteInRange(speedMps, this.minPaceSpeedMps, this.maxSpeedMps)) return null;

    let source = MOTION_SOURCE.NONE;
    for (const point of this.distancePoints) {
      if (point.t > windowStart && point.t <= activeNow) {
        source = combineSource(source, point.source);
      }
    }
    return {
      paceSecPerKm: 1000 / speedMps,
      speedMps,
      source,
      windowMs: durationMs,
      distanceM: deltaM,
    };
  }

  _resetRscIntegrationAnchors() {
    this.rawRscSpeeds = [];
    this._clearPendingRscSpeedStep();
    this.filteredRscSpeedMps = null;
    this.lastSpeedFilterMs = null;
    this.lastIntegratedRscSpeedMps = null;
    this.lastIntegratedRscSpeedMs = null;
    this.rscTotalReanchorNeeded = true;
    this.pendingRscTotalJumpSamples = 0;
    this.rscTotalStallCount = 0;
    this.rscTotalSpeedFallbackActive = false;
    this.rscTotalPendingSpeedDistanceM = 0;
    this.lastRscTotalMotionMs = null;
    this.usedRscSpeedSinceTotal = false;
    this.usedImuSinceRsc = false;
  }

  _resetGpsIntegrationAnchors(nowMs) {
    this.lastGpsMotionMs = null;
    if (Number.isFinite(nowMs)) this.lastGpsSeenMs = nowMs;
    this.gpsReanchorNeeded = true;
  }
}
