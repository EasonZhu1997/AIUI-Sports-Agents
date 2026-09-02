// AIUI 0.15 运动质量门（纯逻辑、无页面/设备 API 依赖）。
//
// 作用边界：
// - 校验 AbsoluteOrientationSensor 的 [x, y, z, w] 四元数；
// - 自动判断宿主四元数旋转方向，把设备加速度投影到重力轴；
// - 结合短窗加速度/陀螺仪能量，区分静止、跑动、头部伪动作和不确定；
// - 只输出质量与运动证据，绝不积分速度、距离或路线。
//
// 调用方应先用 SensorTimestampNormalizer 把各传感器时间戳统一为单调毫秒。

const EPSILON = 1e-9;

export const MOTION_QUALITY_STATE = Object.freeze({
  STATIONARY: 'stationary',
  RUNNING: 'running',
  HEAD_MOTION: 'head_motion',
  UNCERTAIN: 'uncertain',
});

export const ORIENTATION_DIRECTION = Object.freeze({
  DEVICE_TO_WORLD: 'device_to_world',
  WORLD_TO_DEVICE: 'world_to_device',
  UNDETERMINED: 'undetermined',
});

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function smoothStep(value, low, high) {
  if (!Number.isFinite(value)) return 0;
  if (!(high > low)) return value >= high ? 1 : 0;
  const x = clamp01((value - low) / (high - low));
  return x * x * (3 - 2 * x);
}

function finiteVector3(value) {
  if (!value || typeof value.length !== 'number' || value.length < 3) return null;
  const vector = [value[0], value[1], value[2]];
  return vector.every((entry) => Number.isFinite(entry)) ? vector : null;
}

function emaAlpha(deltaMs, timeConstantMs, fallback = 0.2) {
  if (!(deltaMs > 0) || !(timeConstantMs > 0)) return fallback;
  return clamp01(1 - Math.exp(-deltaMs / timeConstantMs));
}

function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample.valueSquared;
  return Math.sqrt(sum / samples.length);
}

/**
 * 校验并归一化 AIUI AbsoluteOrientationSensor 的 [x, y, z, w] 四元数。
 * 非数组型、非有限值、近零长度一律返回 null；不抛异常。
 */
export function normalizeQuaternion(quaternion) {
  if (!quaternion || typeof quaternion.length !== 'number' || quaternion.length < 4) {
    return null;
  }
  const normalized = [
    quaternion[0],
    quaternion[1],
    quaternion[2],
    quaternion[3],
  ];
  if (!normalized.every((value) => Number.isFinite(value))) return null;
  const norm = Math.hypot(
    normalized[0],
    normalized[1],
    normalized[2],
    normalized[3],
  );
  if (!Number.isFinite(norm) || norm < EPSILON) return null;
  return normalized.map((value) => value / norm);
}

/**
 * 用 [x, y, z, w] 四元数旋转三维向量。
 *
 * inverse=false 表示 q * v * conjugate(q)；inverse=true 表示反向旋转。
 * 本函数不声明世界坐标的真北方向，只执行数学旋转。
 */
export function rotateVectorByQuaternion(vector, quaternion, inverse = false) {
  const v = finiteVector3(vector);
  const q = normalizeQuaternion(quaternion);
  if (!v || !q) return null;

  let [qx, qy, qz, qw] = q;
  if (inverse) {
    qx = -qx;
    qy = -qy;
    qz = -qz;
  }

  // v' = v + 2w(q.xyz × v) + 2(q.xyz × (q.xyz × v))
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  const result = [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
  return result.every((value) => Number.isFinite(value)) ? result : null;
}

/**
 * 把设备加速度投影到稳定重力轴。
 *
 * AIUI 目前只确认四元数顺序，不把其旋转方向写进公开契约。因此同时评估
 * q 与 conjugate(q)：哪一条长期能把重力更稳定地落在世界 Z 轴，就采用哪一条。
 * 无法可靠判定、姿态过期或姿态输入异常时，安全回退到加速度模长动态量。
 */
export class VerticalAccelerationProjector {
  constructor(options = {}) {
    this.orientationFreshMs = options.orientationFreshMs ?? 350;
    this.directionScoreTimeConstantMs =
      options.directionScoreTimeConstantMs ?? 700;
    this.gravityTimeConstantMs = options.gravityTimeConstantMs ?? 900;
    this.dynamicTimeConstantMs = options.dynamicTimeConstantMs ?? 55;
    this.minDirectionSamples = options.minDirectionSamples ?? 6;
    this.directionMargin = options.directionMargin ?? 0.08;
    this.directionSwitchMargin = options.directionSwitchMargin ?? 0.16;
    this.maxVerticalError = options.maxVerticalError ?? 0.38;
    this.maxProjectionGapMs = options.maxProjectionGapMs ?? 1000;
    this.reset();
  }

  reset() {
    this.paused = false;
    this.lastOrientation = null;
    this.lastOrientationMs = null;
    this.lastAccelerationMs = null;
    this.direction = ORIENTATION_DIRECTION.UNDETERMINED;
    this.directionCandidates = {
      [ORIENTATION_DIRECTION.DEVICE_TO_WORLD]: {
        error: null,
        samples: 0,
      },
      [ORIENTATION_DIRECTION.WORLD_TO_DEVICE]: {
        error: null,
        samples: 0,
      },
    };
    this.gravityMagnitude = null;
    this.gravityVertical = null;
    this.smoothedDynamic = 0;
    this.lastSource = 'none';
  }

  pause() {
    this.paused = true;
    this._resetTransientProjection();
  }

  resume() {
    this.paused = false;
    this.lastOrientation = null;
    this.lastOrientationMs = null;
    this._resetTransientProjection();
  }

  pushOrientation(quaternion, timestampMs) {
    if (this.paused || !Number.isFinite(timestampMs)) return false;
    if (this.lastOrientationMs != null && timestampMs <= this.lastOrientationMs) {
      return false;
    }
    const normalized = normalizeQuaternion(quaternion);
    if (!normalized) return false;
    this.lastOrientation = normalized;
    this.lastOrientationMs = timestampMs;
    return true;
  }

  isOrientationFresh(nowMs) {
    return !this.paused
      && Number.isFinite(nowMs)
      && this.lastOrientationMs != null
      && nowMs >= this.lastOrientationMs
      && nowMs - this.lastOrientationMs <= this.orientationFreshMs;
  }

  project(x, y, z, timestampMs) {
    const invalid = () => ({
      accepted: false,
      verticalDynamicMps2: null,
      rawDynamicMps2: null,
      worldAcceleration: null,
      source: this.lastSource,
      direction: this.direction,
      orientationFresh: this.isOrientationFresh(timestampMs),
    });
    if (this.paused || ![x, y, z, timestampMs].every(Number.isFinite)) {
      return invalid();
    }
    if (this.lastAccelerationMs != null && timestampMs <= this.lastAccelerationMs) {
      return invalid();
    }

    const acceleration = [x, y, z];
    const magnitude = Math.hypot(x, y, z);
    if (!Number.isFinite(magnitude)) return invalid();
    const deltaMs = this.lastAccelerationMs == null
      ? null : timestampMs - this.lastAccelerationMs;
    if (deltaMs != null && deltaMs > this.maxProjectionGapMs) {
      this._resetTransientProjection();
    }
    this.lastAccelerationMs = timestampMs;

    const magnitudeAlpha = emaAlpha(deltaMs, this.gravityTimeConstantMs, 1);
    if (this.gravityMagnitude == null) this.gravityMagnitude = magnitude;
    const fallbackRawDynamic = magnitude - this.gravityMagnitude;
    this.gravityMagnitude += magnitudeAlpha * fallbackRawDynamic;

    const orientationFresh = this.isOrientationFresh(timestampMs);
    let worldAcceleration = null;
    if (orientationFresh) {
      const direct = rotateVectorByQuaternion(
        acceleration,
        this.lastOrientation,
        false,
      );
      const inverse = rotateVectorByQuaternion(
        acceleration,
        this.lastOrientation,
        true,
      );
      if (direct && inverse && magnitude > EPSILON) {
        this._updateDirectionCandidate(
          ORIENTATION_DIRECTION.DEVICE_TO_WORLD,
          direct,
          magnitude,
          deltaMs,
        );
        this._updateDirectionCandidate(
          ORIENTATION_DIRECTION.WORLD_TO_DEVICE,
          inverse,
          magnitude,
          deltaMs,
        );
        this._updateSelectedDirection();
        if (this.direction === ORIENTATION_DIRECTION.DEVICE_TO_WORLD) {
          worldAcceleration = direct;
        } else if (this.direction === ORIENTATION_DIRECTION.WORLD_TO_DEVICE) {
          worldAcceleration = inverse;
        }
      }
    }

    let rawDynamic = fallbackRawDynamic;
    let source = 'magnitude_fallback';
    if (worldAcceleration) {
      const vertical = worldAcceleration[2];
      if (this.gravityVertical == null) this.gravityVertical = vertical;
      const deltaVertical = vertical - this.gravityVertical;
      const gravityAlpha = emaAlpha(deltaMs, this.gravityTimeConstantMs, 1);
      this.gravityVertical += gravityAlpha * deltaVertical;
      // 正负坐标约定可能不同；相对当前重力方向统一动态量符号。
      const gravitySign = this.gravityVertical < 0 ? -1 : 1;
      rawDynamic = deltaVertical * gravitySign;
      source = 'orientation_vertical';
    } else {
      this.gravityVertical = null;
    }

    const dynamicAlpha = emaAlpha(deltaMs, this.dynamicTimeConstantMs, 0.45);
    this.smoothedDynamic += dynamicAlpha * (rawDynamic - this.smoothedDynamic);
    this.lastSource = source;
    return {
      accepted: true,
      verticalDynamicMps2: this.smoothedDynamic,
      rawDynamicMps2: rawDynamic,
      worldAcceleration,
      source,
      direction: this.direction,
      orientationFresh,
    };
  }

  _resetTransientProjection() {
    this.lastAccelerationMs = null;
    this.gravityMagnitude = null;
    this.gravityVertical = null;
    this.smoothedDynamic = 0;
    this.lastSource = 'none';
  }

  _updateDirectionCandidate(direction, worldVector, magnitude, deltaMs) {
    const candidate = this.directionCandidates[direction];
    const horizontal = Math.hypot(worldVector[0], worldVector[1]);
    const verticalError = clamp01(horizontal / Math.max(magnitude, EPSILON));
    const alpha = emaAlpha(
      deltaMs,
      this.directionScoreTimeConstantMs,
      candidate.samples === 0 ? 1 : 0.2,
    );
    candidate.error = candidate.error == null
      ? verticalError
      : candidate.error + alpha * (verticalError - candidate.error);
    candidate.samples += 1;
  }

  _updateSelectedDirection() {
    const direct = this.directionCandidates[ORIENTATION_DIRECTION.DEVICE_TO_WORLD];
    const inverse = this.directionCandidates[ORIENTATION_DIRECTION.WORLD_TO_DEVICE];
    if (direct.samples < this.minDirectionSamples
        || inverse.samples < this.minDirectionSamples
        || direct.error == null
        || inverse.error == null) {
      return;
    }

    const bestDirection = direct.error <= inverse.error
      ? ORIENTATION_DIRECTION.DEVICE_TO_WORLD
      : ORIENTATION_DIRECTION.WORLD_TO_DEVICE;
    const best = this.directionCandidates[bestDirection];
    const otherDirection = bestDirection === ORIENTATION_DIRECTION.DEVICE_TO_WORLD
      ? ORIENTATION_DIRECTION.WORLD_TO_DEVICE
      : ORIENTATION_DIRECTION.DEVICE_TO_WORLD;
    const other = this.directionCandidates[otherDirection];

    if (this.direction === ORIENTATION_DIRECTION.UNDETERMINED) {
      if (best.error <= this.maxVerticalError
          && other.error - best.error >= this.directionMargin) {
        this.direction = bestDirection;
        this.gravityVertical = null;
        this.smoothedDynamic = 0;
      }
      return;
    }

    const current = this.directionCandidates[this.direction];
    if (bestDirection !== this.direction
        && best.error <= this.maxVerticalError
        && current.error - best.error >= this.directionSwitchMargin) {
      this.direction = bestDirection;
      this.gravityVertical = null;
      this.smoothedDynamic = 0;
    }
  }
}

/**
 * 短窗运动质量门。
 *
 * pushAcceleration 可直接使用 VerticalAccelerationProjector 的垂直动态量；
 * 已有独立 IMU 动态量时也可调用 pushAccelDynamic。输出状态只是对下游计步/GPS
 * 的置信度提示，调用方仍需保留原计步器和 RSC/GPS 的独立安全边界。
 */
export class MotionQualityGate {
  constructor(options = {}) {
    this.windowMs = options.windowMs ?? 1200;
    this.freshMs = options.freshMs ?? 500;
    this.minSamples = options.minSamples ?? 8;
    this.minCoverageMs = options.minCoverageMs ?? 280;

    this.stationaryAccelLow = options.stationaryAccelLow ?? 0.08;
    this.stationaryAccelHigh = options.stationaryAccelHigh ?? 0.22;
    this.stationaryGyroLow = options.stationaryGyroLow ?? 0.08;
    this.stationaryGyroHigh = options.stationaryGyroHigh ?? 0.28;
    this.runningAccelLow = options.runningAccelLow ?? 0.28;
    this.runningAccelHigh = options.runningAccelHigh ?? 0.65;
    this.headGyroLow = options.headGyroLow ?? 0.35;
    this.headGyroHigh = options.headGyroHigh ?? 1.1;

    this.projector = options.projector instanceof VerticalAccelerationProjector
      ? options.projector
      : new VerticalAccelerationProjector(options.orientation);
    this.reset();
  }

  reset() {
    this.paused = false;
    this.accelSamples = [];
    this.gyroSamples = [];
    this.lastAccelMs = null;
    this.lastGyroMs = null;
    this.projector.reset();
  }

  pause() {
    this.paused = true;
    this._clearWindows();
    this.projector.pause();
  }

  resume() {
    this.paused = false;
    this._clearWindows();
    this.projector.resume();
  }

  pushOrientation(quaternion, timestampMs) {
    return this.projector.pushOrientation(quaternion, timestampMs);
  }

  pushAcceleration(x, y, z, timestampMs) {
    if (this.paused) return this._result(false, timestampMs, null);
    const projection = this.projector.project(x, y, z, timestampMs);
    if (!projection.accepted
        || !Number.isFinite(projection.verticalDynamicMps2)
        || !this._appendSample('accel', projection.verticalDynamicMps2, timestampMs)) {
      return this._result(false, timestampMs, projection);
    }
    return this._result(true, timestampMs, projection);
  }

  pushAccelDynamic(dynamicMps2, timestampMs) {
    if (this.paused
        || !this._appendSample('accel', dynamicMps2, timestampMs)) {
      return this._result(false, timestampMs, null);
    }
    return this._result(true, timestampMs, null);
  }

  pushGyro(x, y, z, timestampMs) {
    if (this.paused || ![x, y, z].every(Number.isFinite)) {
      return this._result(false, timestampMs, null);
    }
    const magnitude = Math.hypot(x, y, z);
    if (!this._appendSample('gyro', magnitude, timestampMs)) {
      return this._result(false, timestampMs, null);
    }
    return this._result(true, timestampMs, null);
  }

  snapshot(nowMs = this._latestTimestamp()) {
    const now = Number.isFinite(nowMs) ? nowMs : this._latestTimestamp();
    if (this.paused || !Number.isFinite(now)) {
      return this._emptySnapshot(this.paused);
    }
    this._prune(now);

    const accelFresh = this.lastAccelMs != null
      && now >= this.lastAccelMs
      && now - this.lastAccelMs <= this.freshMs;
    const gyroFresh = this.lastGyroMs != null
      && now >= this.lastGyroMs
      && now - this.lastGyroMs <= this.freshMs;
    const accelCoverage = this._coverage(this.accelSamples);
    const gyroCoverage = this._coverage(this.gyroSamples);
    const accelReady = accelFresh
      && this.accelSamples.length >= this.minSamples
      && accelCoverage >= this.minCoverageMs;
    const gyroReady = gyroFresh
      && this.gyroSamples.length >= this.minSamples
      && gyroCoverage >= this.minCoverageMs;
    const accelRms = rms(this.accelSamples);
    const gyroRms = rms(this.gyroSamples);

    const accelStill = 1 - smoothStep(
      accelRms,
      this.stationaryAccelLow,
      this.stationaryAccelHigh,
    );
    const gyroStill = gyroReady
      ? 1 - smoothStep(
        gyroRms,
        this.stationaryGyroLow,
        this.stationaryGyroHigh,
      )
      : 0.72;
    const coverageConfidence = clamp01(
      accelCoverage / Math.max(this.minCoverageMs, 1),
    );
    const stationaryConfidence = accelReady
      ? clamp01(accelStill * gyroStill * coverageConfidence)
      : 0;

    const accelMotion = smoothStep(
      accelRms,
      this.runningAccelLow,
      this.runningAccelHigh,
    );
    const gyroMotion = gyroReady
      ? smoothStep(gyroRms, this.headGyroLow, this.headGyroHigh)
      : 0;
    const gyroDominance = clamp01(gyroMotion - accelMotion * 0.62);
    const artifactConfidence = gyroReady
      ? clamp01(Math.max(
        gyroMotion * (1 - 0.58 * accelMotion),
        gyroDominance,
      ))
      : 0;
    const runningConfidence = accelReady
      ? clamp01(accelMotion * (1 - 0.82 * artifactConfidence))
      : 0;

    let state = MOTION_QUALITY_STATE.UNCERTAIN;
    if (stationaryConfidence >= 0.68) {
      state = MOTION_QUALITY_STATE.STATIONARY;
    } else if (gyroReady && artifactConfidence >= 0.65) {
      state = MOTION_QUALITY_STATE.HEAD_MOTION;
    } else if (runningConfidence >= 0.6) {
      state = MOTION_QUALITY_STATE.RUNNING;
    }

    return {
      state,
      stationaryConfidence,
      artifactConfidence,
      runningConfidence,
      accelRms,
      gyroRms,
      accelFresh,
      gyroFresh,
      orientationFresh: this.projector.isOrientationFresh(now),
      orientationDirection: this.projector.direction,
      accelSamples: this.accelSamples.length,
      gyroSamples: this.gyroSamples.length,
      paused: false,
    };
  }

  _result(accepted, timestampMs, projection) {
    return {
      accepted,
      projection,
      quality: this.snapshot(
        Number.isFinite(timestampMs) ? timestampMs : this._latestTimestamp(),
      ),
    };
  }

  _appendSample(kind, value, timestampMs) {
    if (!Number.isFinite(value) || !Number.isFinite(timestampMs)) return false;
    const lastKey = kind === 'accel' ? 'lastAccelMs' : 'lastGyroMs';
    if (this[lastKey] != null && timestampMs <= this[lastKey]) return false;
    this[lastKey] = timestampMs;
    const target = kind === 'accel' ? this.accelSamples : this.gyroSamples;
    target.push({ timestampMs, valueSquared: value * value });
    this._prune(timestampMs);
    return true;
  }

  _prune(nowMs) {
    const cutoff = nowMs - this.windowMs;
    while (this.accelSamples.length
        && this.accelSamples[0].timestampMs < cutoff) {
      this.accelSamples.shift();
    }
    while (this.gyroSamples.length
        && this.gyroSamples[0].timestampMs < cutoff) {
      this.gyroSamples.shift();
    }
  }

  _coverage(samples) {
    if (samples.length < 2) return 0;
    return samples[samples.length - 1].timestampMs - samples[0].timestampMs;
  }

  _latestTimestamp() {
    const candidates = [
      this.lastAccelMs,
      this.lastGyroMs,
      this.projector.lastOrientationMs,
    ].filter(Number.isFinite);
    return candidates.length ? Math.max(...candidates) : null;
  }

  _clearWindows() {
    this.accelSamples = [];
    this.gyroSamples = [];
    this.lastAccelMs = null;
    this.lastGyroMs = null;
  }

  _emptySnapshot(paused) {
    return {
      state: MOTION_QUALITY_STATE.UNCERTAIN,
      stationaryConfidence: 0,
      artifactConfidence: 0,
      runningConfidence: 0,
      accelRms: 0,
      gyroRms: 0,
      accelFresh: false,
      gyroFresh: false,
      orientationFresh: false,
      orientationDirection: this.projector.direction,
      accelSamples: 0,
      gyroSamples: 0,
      paused: !!paused,
    };
  }
}
