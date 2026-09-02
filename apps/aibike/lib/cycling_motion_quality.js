// 骑行专用 IMU 运动质量门（纯逻辑，无页面、设备或网络依赖）。
//
// 本门只负责质量判定：Accelerometer 提供冲击/触碰证据，Gyroscope 与
// AbsoluteOrientationSensor 提供转头旁证。上层踏频估算器可另外把
// Gyroscope 当作正向周期输入。调用方应分别把各传感器时间戳归一到同一
// 单调毫秒墙钟，不需要把异步回调强行拼成同一帧。缺少或过期的可选
// 传感器只会降低质量，不会永久否决已经确认的稳定踩踏。
//
// 本模块只对容易污染踏频窗口的运动给出短时 veto：
// - 持续转头；
// - 扶眼镜/触碰造成的角速度与加速度联合尖峰；
// - 单次道路冲击。
//
// 它不检测踏频，不输出速度、距离或功率，也不改变真实 CSC/CPS/FTMS 优先级。

const EPSILON = 1e-9;

export const CYCLING_MOTION_QUALITY_STATE = Object.freeze({
  WARMING: 'warming',
  TRUSTED: 'trusted',
  ACCEL_ONLY: 'accel_only',
  HEAD_MOTION: 'head_motion',
  TOUCH: 'touch',
  ROAD_IMPACT: 'road_impact',
  STALE: 'stale',
  PAUSED: 'paused',
});

export const CYCLING_MOTION_ARTIFACT = Object.freeze({
  NONE: 'none',
  HEAD_TURN: 'head_turn',
  TOUCH: 'touch',
  ROAD_IMPACT: 'road_impact',
});

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function finiteVector3(x, y, z) {
  return [x, y, z].every(Number.isFinite);
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function coverageMs(samples) {
  if (samples.length < 2) return 0;
  return samples[samples.length - 1].timestampMs - samples[0].timestampMs;
}

function normalizeQuaternion(value) {
  if (!value || typeof value.length !== 'number' || value.length < 4) {
    return null;
  }
  const quaternion = [
    Number(value[0]),
    Number(value[1]),
    Number(value[2]),
    Number(value[3]),
  ];
  if (!quaternion.every(Number.isFinite)) return null;
  const norm = Math.hypot(...quaternion);
  if (!(norm > EPSILON)) return null;
  return quaternion.map((entry) => entry / norm);
}

// q 与 -q 表示同一姿态，因此用 |dot| 计算最短旋转角。
function quaternionAngularDistance(left, right) {
  const dot = Math.abs(
    left[0] * right[0]
      + left[1] * right[1]
      + left[2] * right[2]
      + left[3] * right[3],
  );
  return 2 * Math.acos(Math.max(-1, Math.min(1, dot)));
}

function timingStats(samples) {
  const deltas = [];
  for (let index = 1; index < samples.length; index += 1) {
    const deltaMs = samples[index].timestampMs - samples[index - 1].timestampMs;
    if (deltaMs > 0 && Number.isFinite(deltaMs)) deltas.push(deltaMs);
  }
  const intervalMs = median(deltas);
  if (!(intervalMs > 0)) {
    return {
      sampleRateHz: null,
      timingQuality: 0,
    };
  }
  const deviations = deltas.map((deltaMs) => Math.abs(deltaMs - intervalMs));
  const jitterRatio = (median(deviations) || 0) / intervalMs;
  return {
    sampleRateHz: 1000 / intervalMs,
    // AIUI frequency 是 best-effort；允许明显抖动，但不会把乱序当成好数据。
    timingQuality: clamp01(1 - jitterRatio / 0.8),
  };
}

function result(accepted, quality) {
  return { accepted, quality };
}

export class CyclingMotionQualityGate {
  constructor(options = {}) {
    this.windowMs = options.windowMs ?? 1600;
    this.angularWindowMs = options.angularWindowMs ?? 500;
    this.accelFreshMs = options.accelFreshMs ?? 500;
    this.optionalFreshMs = options.optionalFreshMs ?? 400;
    this.associationMs = options.associationMs ?? 220;
    this.resetGapMs = options.resetGapMs ?? 2000;
    // 角运动整窗和 Accelerometer timing 中值只需 5–10Hz；原始三路
    // Generic Sensor 回调仍逐帧接收、记录并立即处理 touch/impact 尖峰。
    this.analysisIntervalMs = Math.max(100, options.analysisIntervalMs ?? 125);

    // 5.5Hz 时 6 个样本覆盖约 909ms；仍由时间覆盖而非固定样本数控制。
    this.minAccelSamples = options.minAccelSamples ?? 6;
    this.minAccelCoverageMs = options.minAccelCoverageMs ?? 600;
    this.minOptionalSamples = options.minOptionalSamples ?? 4;
    this.minOptionalCoverageMs = options.minOptionalCoverageMs ?? 120;
    this.minSampleRateHz = options.minSampleRateHz ?? 5;
    this.maxSampleRateHz = options.maxSampleRateHz ?? 65;

    this.gravityTimeConstantMs = options.gravityTimeConstantMs ?? 850;
    this.impactDynamicMps2 = options.impactDynamicMps2 ?? 3.2;
    this.impactJerkMps3 = options.impactJerkMps3 ?? 38;
    this.impactJerkFloorMps2 = options.impactJerkFloorMps2 ?? 1.6;
    this.impactHoldMs = options.impactHoldMs ?? 450;

    this.headAngularSpeedRadS = options.headAngularSpeedRadS ?? 0.8;
    this.headNetAngleRad = options.headNetAngleRad ?? 0.28;
    this.headMinCoverageMs = options.headMinCoverageMs ?? 180;
    this.headHoldMs = options.headHoldMs ?? 550;
    this.touchAngularSpeedRadS = options.touchAngularSpeedRadS ?? 2.4;
    this.touchHoldMs = options.touchHoldMs ?? 750;
    this.reset();
  }

  reset() {
    this.paused = false;
    this.gravity = null;
    this.lastDynamic = null;
    this.lastAccelMs = null;
    this.lastGyroMs = null;
    this.lastOrientationMs = null;
    this.lastOrientation = null;
    this.accelTimingCache = null;
    this.accelTimingDirty = false;
    this.lastAccelTimingAnalysisMs = null;
    this.lastHeadMotionAnalysisMs = null;
    this.accelSamples = [];
    this.gyroSamples = [];
    this.orientationSamples = [];
    this.recentAccelArtifactMs = null;
    this.recentAngularSpikeMs = null;
    this.headMotionUntilMs = null;
    this.touchUntilMs = null;
    this.impactUntilMs = null;
  }

  pause() {
    this.paused = true;
    this._clearTransient();
  }

  resume() {
    this.paused = false;
    this._clearTransient();
  }

  dropGyro(nowMs = this._latestTimestamp()) {
    this.gyroSamples = [];
    this.lastGyroMs = null;
    this._clearAngularHolds();
    if (Number.isFinite(nowMs)) {
      this._prune(nowMs);
      this._refreshHeadMotionIfDue(nowMs, true);
    }
    return this.snapshot(nowMs, { maintained: true });
  }

  dropOrientation(nowMs = this._latestTimestamp()) {
    this.orientationSamples = [];
    this.lastOrientationMs = null;
    this.lastOrientation = null;
    this._clearAngularHolds();
    if (Number.isFinite(nowMs)) {
      this._prune(nowMs);
      this._refreshHeadMotionIfDue(nowMs, true);
    }
    return this.snapshot(nowMs, { maintained: true });
  }

  /**
   * 输入已经换算为 m/s² 的 AIUI Accelerometer 三轴值。
   */
  pushAcceleration(x, y, z, timestampMs) {
    if (this.paused
        || !finiteVector3(x, y, z)
        || !Number.isFinite(timestampMs)
        || (this.lastAccelMs != null && timestampMs <= this.lastAccelMs)) {
      return result(false, this.snapshot(timestampMs));
    }

    const previousAt = this.lastAccelMs;
    const gapMs = previousAt == null ? null : timestampMs - previousAt;
    if (gapMs != null && gapMs > this.resetGapMs) {
      this.gravity = null;
      this.lastDynamic = null;
      this.accelSamples = [];
      this.accelTimingCache = null;
      this.accelTimingDirty = false;
      this.lastAccelTimingAnalysisMs = null;
    }

    if (this.gravity == null) {
      this.gravity = { x, y, z };
      this.lastDynamic = { x: 0, y: 0, z: 0 };
      this.lastAccelMs = timestampMs;
      this.accelSamples.push({
        timestampMs,
        dynamicMagnitude: 0,
        jerkMps3: 0,
      });
      this.accelTimingCache = null;
      this.accelTimingDirty = true;
      this._prune(timestampMs);
      return result(true, this.snapshot(timestampMs));
    }

    const dynamic = {
      x: x - this.gravity.x,
      y: y - this.gravity.y,
      z: z - this.gravity.z,
    };
    const dynamicMagnitude = Math.hypot(dynamic.x, dynamic.y, dynamic.z);
    const dtMs = Math.max(1, gapMs);
    const jerkMps3 = this.lastDynamic
      ? Math.hypot(
        dynamic.x - this.lastDynamic.x,
        dynamic.y - this.lastDynamic.y,
        dynamic.z - this.lastDynamic.z,
      ) * 1000 / dtMs
      : 0;

    const gravityAlpha = clamp01(
      1 - Math.exp(-dtMs / this.gravityTimeConstantMs),
    );
    this.gravity.x += (x - this.gravity.x) * gravityAlpha;
    this.gravity.y += (y - this.gravity.y) * gravityAlpha;
    this.gravity.z += (z - this.gravity.z) * gravityAlpha;
    this.lastDynamic = dynamic;
    this.lastAccelMs = timestampMs;
    this.accelSamples.push({
      timestampMs,
      dynamicMagnitude,
      jerkMps3,
    });
    this.accelTimingDirty = true;

    const impact = dynamicMagnitude >= this.impactDynamicMps2
      || (dynamicMagnitude >= this.impactJerkFloorMps2
        && jerkMps3 >= this.impactJerkMps3);
    if (impact) {
      this.recentAccelArtifactMs = timestampMs;
      if (this._hasNearbyAngularSpike(timestampMs)) {
        this.touchUntilMs = Math.max(
          this.touchUntilMs ?? -Infinity,
          timestampMs + this.touchHoldMs,
        );
      } else {
        this.impactUntilMs = Math.max(
          this.impactUntilMs ?? -Infinity,
          timestampMs + this.impactHoldMs,
        );
      }
    }

    this._prune(timestampMs);
    this._refreshHeadMotionIfDue(timestampMs);
    return result(true, this.snapshot(timestampMs, { maintained: true }));
  }

  /**
   * 输入 rad/s。Gyroscope 的时间轴可与 Accelerometer 错开，但应落在同一
   * 已归一化单调毫秒墙钟附近。
   */
  pushGyro(x, y, z, timestampMs) {
    if (this.paused
        || !finiteVector3(x, y, z)
        || !Number.isFinite(timestampMs)
        || (this.lastGyroMs != null && timestampMs <= this.lastGyroMs)) {
      return result(false, this.snapshot(timestampMs));
    }
    if (this.lastGyroMs != null
        && timestampMs - this.lastGyroMs > this.resetGapMs) {
      this.gyroSamples = [];
    }
    const magnitude = Math.hypot(x, y, z);
    this.lastGyroMs = timestampMs;
    this.gyroSamples.push({ timestampMs, x, y, z, magnitude });
    if (magnitude >= this.touchAngularSpeedRadS) {
      this._recordAngularSpike(timestampMs);
    }
    this._prune(timestampMs);
    this._refreshHeadMotionIfDue(timestampMs);
    return result(true, this.snapshot(timestampMs, { maintained: true }));
  }

  /**
   * 输入 AIUI AbsoluteOrientationSensor 的 [x,y,z,w]。
   * 只使用相邻姿态差，不假定 device→world/world→device 方向或真北。
   */
  pushOrientation(quaternion, timestampMs) {
    const normalized = normalizeQuaternion(quaternion);
    if (this.paused
        || !normalized
        || !Number.isFinite(timestampMs)
        || (this.lastOrientationMs != null
          && timestampMs <= this.lastOrientationMs)) {
      return result(false, this.snapshot(timestampMs));
    }

    if (this.lastOrientationMs != null
        && timestampMs - this.lastOrientationMs > this.resetGapMs) {
      this.orientationSamples = [];
      this.lastOrientation = null;
    }

    let angularSpeedRadS = 0;
    if (this.lastOrientation && this.lastOrientationMs != null) {
      const deltaMs = timestampMs - this.lastOrientationMs;
      const angleRad = quaternionAngularDistance(
        this.lastOrientation,
        normalized,
      );
      angularSpeedRadS = angleRad * 1000 / deltaMs;
      if (angularSpeedRadS >= this.touchAngularSpeedRadS) {
        this._recordAngularSpike(timestampMs);
      }
    }

    this.lastOrientation = normalized;
    this.lastOrientationMs = timestampMs;
    this.orientationSamples.push({
      timestampMs,
      quaternion: normalized,
      angularSpeedRadS,
    });
    this._prune(timestampMs);
    this._refreshHeadMotionIfDue(timestampMs);
    return result(true, this.snapshot(timestampMs, { maintained: true }));
  }

  snapshot(nowMs = this._latestTimestamp(), options = {}) {
    const now = Number.isFinite(nowMs) ? nowMs : this._latestTimestamp();
    if (this.paused) return this._emptySnapshot(CYCLING_MOTION_QUALITY_STATE.PAUSED);
    if (!Number.isFinite(now)) {
      return this._emptySnapshot(CYCLING_MOTION_QUALITY_STATE.WARMING);
    }

    if (options.maintained !== true) {
      this._prune(now);
      this._refreshHeadMotionIfDue(now);
    }

    const accelFresh = this._fresh(this.lastAccelMs, now, this.accelFreshMs);
    const gyroFresh = this._fresh(this.lastGyroMs, now, this.optionalFreshMs);
    const orientationFresh = this._fresh(
      this.lastOrientationMs,
      now,
      this.optionalFreshMs,
    );
    const gyroCoverageMs = coverageMs(this.gyroSamples);
    const orientationCoverageMs = coverageMs(this.orientationSamples);
    const gyroReady = gyroFresh
      && this.gyroSamples.length >= this.minOptionalSamples
      && gyroCoverageMs >= this.minOptionalCoverageMs;
    const orientationReady = orientationFresh
      && this.orientationSamples.length >= this.minOptionalSamples
      && orientationCoverageMs >= this.minOptionalCoverageMs;
    const accelCoverageMs = coverageMs(this.accelSamples);
    // Accelerometer timing belongs to the accelerometer clock. Other sensor
    // callbacks can be ahead (or behind) by hundreds of milliseconds, so using
    // the snapshot timestamp here would let interleaved axes repeatedly rewind
    // the throttle and re-run the full timing-window analysis.
    const accelTimingAtMs = Number.isFinite(this.lastAccelMs)
      ? this.lastAccelMs
      : null;
    const timingDue = this.lastAccelTimingAnalysisMs == null
      || (accelTimingAtMs != null
        && accelTimingAtMs - this.lastAccelTimingAnalysisMs
          >= this.analysisIntervalMs);
    if (this.accelTimingCache == null
        || (this.accelTimingDirty && timingDue)) {
      this.accelTimingCache = timingStats(this.accelSamples);
      this.accelTimingDirty = false;
      if (accelTimingAtMs != null) {
        this.lastAccelTimingAnalysisMs = this.lastAccelTimingAnalysisMs == null
          ? accelTimingAtMs
          : Math.max(this.lastAccelTimingAnalysisMs, accelTimingAtMs);
      }
    }
    const timing = this.accelTimingCache;
    const sampleRateOk = Number.isFinite(timing.sampleRateHz)
      && timing.sampleRateHz >= this.minSampleRateHz
      && timing.sampleRateHz <= this.maxSampleRateHz;
    const accelReady = accelFresh
      && this.accelSamples.length >= this.minAccelSamples
      && accelCoverageMs >= this.minAccelCoverageMs
      && sampleRateOk;

    const touch = this._activeUntil(this.touchUntilMs, now);
    const roadImpact = this._activeUntil(this.impactUntilMs, now);
    const headMotion = touch
      || this._activeUntil(this.headMotionUntilMs, now);

    let state;
    let artifact = CYCLING_MOTION_ARTIFACT.NONE;
    let reason;
    if (!accelFresh && this.lastAccelMs != null) {
      state = CYCLING_MOTION_QUALITY_STATE.STALE;
      reason = 'accelerometer_stale';
    } else if (touch) {
      state = CYCLING_MOTION_QUALITY_STATE.TOUCH;
      artifact = CYCLING_MOTION_ARTIFACT.TOUCH;
      reason = 'accel_angular_spike';
    } else if (roadImpact) {
      state = CYCLING_MOTION_QUALITY_STATE.ROAD_IMPACT;
      artifact = CYCLING_MOTION_ARTIFACT.ROAD_IMPACT;
      reason = 'transient_acceleration';
    } else if (headMotion) {
      state = CYCLING_MOTION_QUALITY_STATE.HEAD_MOTION;
      artifact = CYCLING_MOTION_ARTIFACT.HEAD_TURN;
      reason = 'sustained_rotation';
    } else if (!accelReady) {
      state = CYCLING_MOTION_QUALITY_STATE.WARMING;
      reason = sampleRateOk || timing.sampleRateHz == null
        ? 'accelerometer_warming'
        : 'accelerometer_rate_out_of_range';
    } else if (!gyroReady && !orientationReady) {
      state = CYCLING_MOTION_QUALITY_STATE.ACCEL_ONLY;
      reason = 'optional_motion_sensors_unavailable';
    } else {
      state = CYCLING_MOTION_QUALITY_STATE.TRUSTED;
      reason = 'clear';
    }

    const coverageQuality = clamp01(
      accelCoverageMs / Math.max(1, this.minAccelCoverageMs),
    );
    const optionalCount = Number(gyroReady) + Number(orientationReady);
    const optionalBonus = optionalCount * 0.08;
    const qualityCap = optionalCount === 0 ? 0.68
      : optionalCount === 1 ? 0.84 : 0.94;
    let quality = accelReady
      ? Math.min(
        qualityCap,
        0.56
          + 0.14 * timing.timingQuality
          + 0.08 * coverageQuality
          + optionalBonus,
      )
      : 0;
    if (state === CYCLING_MOTION_QUALITY_STATE.HEAD_MOTION) quality = 0.1;
    if (state === CYCLING_MOTION_QUALITY_STATE.ROAD_IMPACT) quality = 0.12;
    if (state === CYCLING_MOTION_QUALITY_STATE.TOUCH) quality = 0;
    if (state === CYCLING_MOTION_QUALITY_STATE.STALE
        || state === CYCLING_MOTION_QUALITY_STATE.WARMING) {
      quality = 0;
    }

    const allowCadenceEvidence = accelReady
      && artifact === CYCLING_MOTION_ARTIFACT.NONE
      && quality >= 0.55;
    return {
      state,
      artifact,
      reason,
      quality: clamp01(quality),
      allowCadenceEvidence,
      roadImpactTriggered: roadImpact
        && this.recentAccelArtifactMs === now,
      headMotion,
      headMotionKnown: gyroReady || orientationReady,
      accelFresh,
      gyroFresh,
      orientationFresh,
      gyroReady,
      orientationReady,
      accelSamples: this.accelSamples.length,
      gyroSamples: this.gyroSamples.length,
      orientationSamples: this.orientationSamples.length,
      accelCoverageMs,
      gyroCoverageMs,
      orientationCoverageMs,
      accelSampleRateHz: timing.sampleRateHz,
      timingQuality: timing.timingQuality,
      paused: false,
    };
  }

  _recordAngularSpike(timestampMs) {
    this.recentAngularSpikeMs = timestampMs;
    if (this.recentAccelArtifactMs != null
        && Math.abs(timestampMs - this.recentAccelArtifactMs)
          <= this.associationMs) {
      this.touchUntilMs = Math.max(
        this.touchUntilMs ?? -Infinity,
        timestampMs + this.touchHoldMs,
      );
    }
  }

  _clearAngularHolds() {
    this.recentAngularSpikeMs = null;
    this.headMotionUntilMs = null;
    this.touchUntilMs = null;
  }

  _hasNearbyAngularSpike(timestampMs) {
    return this.recentAngularSpikeMs != null
      && Math.abs(timestampMs - this.recentAngularSpikeMs)
        <= this.associationMs;
  }

  _refreshHeadMotion(nowMs) {
    if (!Number.isFinite(nowMs)) return;
    const cutoff = nowMs - this.angularWindowMs;
    const gyro = this.gyroSamples.filter(
      (sample) => sample.timestampMs >= cutoff && sample.timestampMs <= nowMs,
    );
    const orientation = this.orientationSamples.filter(
      (sample) => sample.timestampMs >= cutoff && sample.timestampMs <= nowMs,
    );

    let gyroTurn = false;
    let gyroReadyForTurn = false;
    if (gyro.length >= 2 && coverageMs(gyro) >= this.headMinCoverageMs) {
      let integratedX = 0;
      let integratedY = 0;
      let integratedZ = 0;
      let pathAngle = 0;
      for (let index = 1; index < gyro.length; index += 1) {
        const previous = gyro[index - 1];
        const current = gyro[index];
        const dtSeconds = (current.timestampMs - previous.timestampMs) / 1000;
        integratedX += (previous.x + current.x) * 0.5 * dtSeconds;
        integratedY += (previous.y + current.y) * 0.5 * dtSeconds;
        integratedZ += (previous.z + current.z) * 0.5 * dtSeconds;
        pathAngle += (previous.magnitude + current.magnitude) * 0.5 * dtSeconds;
      }
      const netAngle = Math.hypot(integratedX, integratedY, integratedZ);
      const angularSpeed = median(gyro.map((sample) => sample.magnitude)) || 0;
      const directionalRatio = pathAngle > EPSILON ? netAngle / pathAngle : 0;
      gyroReadyForTurn = true;
      gyroTurn = netAngle >= Math.max(this.headNetAngleRad, 0.35)
        && directionalRatio >= 0.72
        && angularSpeed >= this.headAngularSpeedRadS;
    }

    let orientationTurn = false;
    let orientationReadyForTurn = false;
    if (orientation.length >= 2
        && coverageMs(orientation) >= this.headMinCoverageMs) {
      const netAngle = quaternionAngularDistance(
        orientation[0].quaternion,
        orientation[orientation.length - 1].quaternion,
      );
      let pathAngle = 0;
      for (let index = 1; index < orientation.length; index += 1) {
        pathAngle += quaternionAngularDistance(
          orientation[index - 1].quaternion,
          orientation[index].quaternion,
        );
      }
      const angularSpeed = median(
        orientation
          .slice(1)
          .map((sample) => sample.angularSpeedRadS),
      ) || 0;
      const directionalRatio = pathAngle > EPSILON ? netAngle / pathAngle : 0;
      orientationReadyForTurn = true;
      orientationTurn = netAngle >= Math.max(this.headNetAngleRad, 0.35)
        && directionalRatio >= 0.72
        && angularSpeed >= this.headAngularSpeedRadS;
    }

    // 单次角速度尖峰只能和邻近加速度冲击共同判定为 touch，不能再单独把
    // 周期摆动判为转头。两路角传感器都就绪时要求共同确认同向持续旋转。
    const sustainedTurn = gyroReadyForTurn && orientationReadyForTurn
      ? gyroTurn && orientationTurn
      : gyroTurn || orientationTurn;
    if (sustainedTurn) {
      this.headMotionUntilMs = Math.max(
        this.headMotionUntilMs ?? -Infinity,
        nowMs + this.headHoldMs,
      );
    }
  }

  _refreshHeadMotionIfDue(nowMs, force = false) {
    if (!Number.isFinite(nowMs)) return;
    // Use one monotonic high-water mark across every sensor clock. A lagging
    // axis must not rewind the analysis timestamp and defeat throttling.
    const analysisAtMs = this.lastHeadMotionAnalysisMs == null
      ? nowMs
      : Math.max(this.lastHeadMotionAnalysisMs, nowMs);
    if (!force && this.lastHeadMotionAnalysisMs != null
        && analysisAtMs - this.lastHeadMotionAnalysisMs
          < this.analysisIntervalMs) return;
    this.lastHeadMotionAnalysisMs = analysisAtMs;
    this._refreshHeadMotion(analysisAtMs);
  }

  _prune(nowMs) {
    // Each Generic Sensor owns a monotonic clock. A gyro callback may lead an
    // accel/orientation callback, so prune every stream from its own latest
    // timestamp instead of deleting lagging-axis samples with the caller's now.
    const accelCutoff = Number.isFinite(this.lastAccelMs)
      ? this.lastAccelMs - this.windowMs
      : null;
    const angularRetentionMs = Math.max(
      this.windowMs,
      this.angularWindowMs + this.optionalFreshMs,
    );
    const gyroCutoff = Number.isFinite(this.lastGyroMs)
      ? this.lastGyroMs - angularRetentionMs
      : null;
    const orientationCutoff = Number.isFinite(this.lastOrientationMs)
      ? this.lastOrientationMs - angularRetentionMs
      : null;
    let accelPruned = false;
    while (accelCutoff != null && this.accelSamples.length
        && this.accelSamples[0].timestampMs < accelCutoff) {
      this.accelSamples.shift();
      accelPruned = true;
    }
    if (accelPruned) this.accelTimingDirty = true;
    while (gyroCutoff != null && this.gyroSamples.length
        && this.gyroSamples[0].timestampMs < gyroCutoff) {
      this.gyroSamples.shift();
    }
    while (orientationCutoff != null && this.orientationSamples.length
        && this.orientationSamples[0].timestampMs < orientationCutoff) {
      this.orientationSamples.shift();
    }
  }

  _fresh(lastMs, nowMs, freshnessMs) {
    return lastMs != null
      // 各 Generic Sensor 独立归一化后仍可能有很小回调/墙钟偏移；
      // associationMs 内视为同一时间邻域，但不接受真正跨段的未来样本。
      && lastMs - nowMs <= this.associationMs
      && nowMs - lastMs <= freshnessMs;
  }

  _activeUntil(untilMs, nowMs) {
    return Number.isFinite(untilMs) && nowMs <= untilMs;
  }

  _latestTimestamp() {
    const timestamps = [
      this.lastAccelMs,
      this.lastGyroMs,
      this.lastOrientationMs,
    ].filter(Number.isFinite);
    return timestamps.length ? Math.max(...timestamps) : null;
  }

  _clearTransient() {
    this.gravity = null;
    this.lastDynamic = null;
    this.lastAccelMs = null;
    this.lastGyroMs = null;
    this.lastOrientationMs = null;
    this.lastOrientation = null;
    this.accelTimingCache = null;
    this.accelTimingDirty = false;
    this.lastAccelTimingAnalysisMs = null;
    this.lastHeadMotionAnalysisMs = null;
    this.accelSamples = [];
    this.gyroSamples = [];
    this.orientationSamples = [];
    this.recentAccelArtifactMs = null;
    this.recentAngularSpikeMs = null;
    this.headMotionUntilMs = null;
    this.touchUntilMs = null;
    this.impactUntilMs = null;
  }

  _emptySnapshot(state) {
    return {
      state,
      artifact: CYCLING_MOTION_ARTIFACT.NONE,
      reason: state === CYCLING_MOTION_QUALITY_STATE.PAUSED
        ? 'paused' : 'accelerometer_warming',
      quality: 0,
      allowCadenceEvidence: false,
      headMotion: false,
      headMotionKnown: false,
      accelFresh: false,
      gyroFresh: false,
      orientationFresh: false,
      gyroReady: false,
      orientationReady: false,
      accelSamples: 0,
      gyroSamples: 0,
      orientationSamples: 0,
      accelCoverageMs: 0,
      gyroCoverageMs: 0,
      orientationCoverageMs: 0,
      accelSampleRateHz: null,
      timingQuality: 0,
      paused: state === CYCLING_MOTION_QUALITY_STATE.PAUSED,
    };
  }
}
