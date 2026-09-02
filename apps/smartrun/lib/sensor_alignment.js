// AIUI 0.15 多传感器时间对齐与加速度单位校准（纯逻辑）。
//
// 边界：
// - 识别静止窗口中的约 1g 或约 9.80665m/s²，并统一换算为 m/s²；
// - 在加速度时间点对齐短时 AbsoluteOrientationSensor 四元数与 Gyroscope；
// - 四元数只做时间插值，不声明真北、航向或跑动方向；
// - 本模块不积分速度、距离或路线。

const EPSILON = 1e-9;

export const STANDARD_GRAVITY_MPS2 = 9.80665;

export const ACCELERATION_SOURCE_UNIT = Object.freeze({
  UNKNOWN: 'unknown',
  STANDARD_GRAVITY: 'g',
  METERS_PER_SECOND_SQUARED: 'm/s2',
});

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function finiteVector3(value) {
  if (!value || typeof value.length !== 'number' || value.length < 3) return null;
  const vector = [Number(value[0]), Number(value[1]), Number(value[2])];
  return vector.every(Number.isFinite) ? vector : null;
}

function normalizeQuaternion(quaternion) {
  if (!quaternion || typeof quaternion.length !== 'number'
      || quaternion.length < 4) {
    return null;
  }
  const value = [
    Number(quaternion[0]),
    Number(quaternion[1]),
    Number(quaternion[2]),
    Number(quaternion[3]),
  ];
  if (!value.every(Number.isFinite)) return null;
  const norm = Math.hypot(value[0], value[1], value[2], value[3]);
  if (!Number.isFinite(norm) || norm < EPSILON) return null;
  return value.map((entry) => entry / norm);
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * AIUI AbsoluteOrientationSensor 使用 [x,y,z,w]。
 *
 * SLERP 始终走最短四元数弧；近共线时切换为归一化线性插值，避免
 * sin(theta) 接近 0 时数值放大。alpha 只接受闭区间 [0,1]。
 */
export function slerpQuaternion(from, to, alpha) {
  const first = normalizeQuaternion(from);
  let second = normalizeQuaternion(to);
  if (!first || !second || !Number.isFinite(alpha)
      || alpha < 0 || alpha > 1) {
    return null;
  }
  if (alpha === 0) return first.slice();
  if (alpha === 1) return second.slice();

  let dot = first[0] * second[0]
    + first[1] * second[1]
    + first[2] * second[2]
    + first[3] * second[3];

  // q 与 -q 表示同一旋转；翻转后取最短弧，也能稳定处理反号等价输入。
  if (dot < 0) {
    second = second.map((entry) => -entry);
    dot = -dot;
  }
  dot = clamp(dot, -1, 1);

  if (dot > 0.9995) {
    return normalizeQuaternion(first.map(
      (entry, index) => entry + alpha * (second[index] - entry),
    ));
  }

  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  if (Math.abs(sinTheta) < EPSILON) return first.slice();
  const firstWeight = Math.sin((1 - alpha) * theta) / sinTheta;
  const secondWeight = Math.sin(alpha * theta) / sinTheta;
  return normalizeQuaternion(first.map(
    (entry, index) => firstWeight * entry + secondWeight * second[index],
  ));
}

export function lerpVector3(from, to, alpha) {
  const first = finiteVector3(from);
  const second = finiteVector3(to);
  if (!first || !second || !Number.isFinite(alpha)
      || alpha < 0 || alpha > 1) {
    return null;
  }
  return first.map(
    (entry, index) => entry + alpha * (second[index] - entry),
  );
}

/**
 * 从静止的加速度模长窗口识别宿主单位。
 *
 * 未知输入永远使用 scale=1 原样透传；不会把约 4m/s² 等未知稳定值误缩放。
 * stationary=false 可由上层质量门显式终止一个被运动污染的候选窗口；
 * 未提供 hint 时仍会用窗口离散度做保守判断。
 */
export class AccelerationUnitCalibrator {
  constructor(options = {}) {
    this.windowMs = options.windowMs ?? 1200;
    this.minWindowMs = options.minWindowMs ?? 700;
    this.minSamples = options.minSamples ?? 16;
    this.maxRelativeDeviation = options.maxRelativeDeviation ?? 0.045;
    this.maxRelativeRange = options.maxRelativeRange ?? 0.18;
    this.gTolerance = options.gTolerance ?? 0.22;
    this.mps2ToleranceRatio = options.mps2ToleranceRatio ?? 0.22;
    this.reset();
  }

  reset() {
    this.paused = false;
    this.sourceUnit = ACCELERATION_SOURCE_UNIT.UNKNOWN;
    this.scaleToMps2 = 1;
    this.samples = [];
    this.lastTimestampMs = null;
    this.lastWindowStable = false;
    this.lastMedianMagnitude = null;
  }

  pause() {
    this.paused = true;
    this._clearWindow();
  }

  resume() {
    this.paused = false;
    this._clearWindow();
  }

  clearTransient() {
    this._clearWindow();
  }

  push(x, y, z, timestampMs, options = {}) {
    const vector = finiteVector3([x, y, z]);
    if (this.paused || !vector || !Number.isFinite(timestampMs)) return false;

    if (this.lastTimestampMs != null && timestampMs < this.lastTimestampMs) {
      // 新时间纪元不能与旧窗口混用；已识别单位可保留。
      this._clearWindow();
    } else if (this.lastTimestampMs != null
        && timestampMs === this.lastTimestampMs) {
      // 同时刻重复回调只替换最后一帧，避免人为提高静止样本权重。
      if (this.samples.length) this.samples.pop();
    }
    this.lastTimestampMs = timestampMs;

    if (options.stationary === false) {
      this._clearWindow();
      this.lastTimestampMs = timestampMs;
      return true;
    }

    const magnitude = Math.hypot(vector[0], vector[1], vector[2]);
    if (!Number.isFinite(magnitude) || magnitude < EPSILON) return false;
    this.samples.push({ timestampMs, magnitude });
    const cutoff = timestampMs - this.windowMs;
    while (this.samples.length && this.samples[0].timestampMs < cutoff) {
      this.samples.shift();
    }

    if (this.sourceUnit === ACCELERATION_SOURCE_UNIT.UNKNOWN) {
      this._tryCalibrate();
    }
    return true;
  }

  convertVector(vector) {
    const finite = finiteVector3(vector);
    if (!finite) return null;
    return finite.map((entry) => entry * this.scaleToMps2);
  }

  snapshot() {
    const spanMs = this.samples.length > 1
      ? this.samples[this.samples.length - 1].timestampMs
        - this.samples[0].timestampMs
      : 0;
    return {
      calibrated: this.sourceUnit !== ACCELERATION_SOURCE_UNIT.UNKNOWN,
      sourceUnit: this.sourceUnit,
      scaleToMps2: this.scaleToMps2,
      sampleCount: this.samples.length,
      windowSpanMs: spanMs,
      stable: this.lastWindowStable,
      medianMagnitude: this.lastMedianMagnitude,
    };
  }

  _clearWindow() {
    this.samples = [];
    this.lastTimestampMs = null;
    this.lastWindowStable = false;
    this.lastMedianMagnitude = null;
  }

  _tryCalibrate() {
    if (this.samples.length < this.minSamples) return;
    const spanMs = this.samples[this.samples.length - 1].timestampMs
      - this.samples[0].timestampMs;
    if (spanMs < this.minWindowMs) return;

    const magnitudes = this.samples.map((sample) => sample.magnitude);
    const center = median(magnitudes);
    if (!(center > EPSILON)) return;
    const squaredDeviation = magnitudes.reduce(
      (sum, value) => sum + (value - center) ** 2,
      0,
    ) / magnitudes.length;
    const relativeDeviation = Math.sqrt(squaredDeviation) / center;
    const range = Math.max(...magnitudes) - Math.min(...magnitudes);
    const relativeRange = range / center;

    this.lastMedianMagnitude = center;
    this.lastWindowStable = relativeDeviation <= this.maxRelativeDeviation
      && relativeRange <= this.maxRelativeRange;
    if (!this.lastWindowStable) return;

    if (Math.abs(center - 1) <= this.gTolerance) {
      this.sourceUnit = ACCELERATION_SOURCE_UNIT.STANDARD_GRAVITY;
      this.scaleToMps2 = STANDARD_GRAVITY_MPS2;
      return;
    }
    if (Math.abs(center - STANDARD_GRAVITY_MPS2)
        <= STANDARD_GRAVITY_MPS2 * this.mps2ToleranceRatio) {
      this.sourceUnit =
        ACCELERATION_SOURCE_UNIT.METERS_PER_SECOND_SQUARED;
      this.scaleToMps2 = 1;
    }
  }
}

class TimedSampleBuffer {
  constructor(options) {
    this.historyMs = options.historyMs;
    this.freshMs = options.freshMs;
    this.maxInterpolationGapMs = options.maxInterpolationGapMs;
    this.maxSamples = options.maxSamples;
    this.normalizeValue = options.normalizeValue;
    this.interpolateValue = options.interpolateValue;
    this.samples = [];
  }

  clear() {
    this.samples = [];
  }

  push(value, timestampMs) {
    const normalized = this.normalizeValue(value);
    if (!normalized || !Number.isFinite(timestampMs)) return false;
    const last = this.samples[this.samples.length - 1];
    if (last && timestampMs < last.timestampMs) {
      // 传感器时钟回绕：从新纪元重新开始，禁止跨纪元插值。
      this.clear();
    } else if (last && timestampMs === last.timestampMs) {
      this.samples[this.samples.length - 1] = {
        timestampMs,
        value: normalized,
      };
      return true;
    }

    this.samples.push({ timestampMs, value: normalized });
    const cutoff = timestampMs - this.historyMs;
    while (this.samples.length && this.samples[0].timestampMs < cutoff) {
      this.samples.shift();
    }
    while (this.samples.length > this.maxSamples) this.samples.shift();
    return true;
  }

  sampleAt(timestampMs) {
    if (!Number.isFinite(timestampMs) || !this.samples.length) return null;

    let upperIndex = 0;
    while (upperIndex < this.samples.length
        && this.samples[upperIndex].timestampMs < timestampMs) {
      upperIndex += 1;
    }

    const after = this.samples[upperIndex] ?? null;
    const before = upperIndex > 0 ? this.samples[upperIndex - 1] : null;
    if (after && after.timestampMs === timestampMs) {
      return this._nearestResult(after, timestampMs);
    }

    if (before && after) {
      const spanMs = after.timestampMs - before.timestampMs;
      const beforeDeltaMs = timestampMs - before.timestampMs;
      const afterDeltaMs = after.timestampMs - timestampMs;
      if (spanMs > 0
          && spanMs <= this.maxInterpolationGapMs
          && beforeDeltaMs <= this.freshMs
          && afterDeltaMs <= this.freshMs) {
        const alpha = beforeDeltaMs / spanMs;
        const value = this.interpolateValue(
          before.value,
          after.value,
          alpha,
        );
        if (value) {
          return {
            value,
            mode: 'interpolated',
            nearestSampleDeltaMs: Math.min(beforeDeltaMs, afterDeltaMs),
            beforeTimestampMs: before.timestampMs,
            afterTimestampMs: after.timestampMs,
          };
        }
      }
    }

    let nearest = null;
    if (before && after) {
      nearest = timestampMs - before.timestampMs
        <= after.timestampMs - timestampMs ? before : after;
    } else {
      nearest = before ?? after;
    }
    if (!nearest
        || Math.abs(timestampMs - nearest.timestampMs) > this.freshMs) {
      return null;
    }
    return this._nearestResult(nearest, timestampMs);
  }

  _nearestResult(sample, timestampMs) {
    return {
      value: sample.value.slice(),
      mode: 'nearest',
      nearestSampleDeltaMs: Math.abs(timestampMs - sample.timestampMs),
      sampleTimestampMs: sample.timestampMs,
    };
  }
}

/**
 * 短时多传感器对齐器。
 *
 * 调用顺序不要求严格同步：姿态和陀螺仪先后进入短缓冲；加速度到达时调用
 * alignAcceleration()，按它的单调毫秒时间点读取插值或最近样本。
 */
export class SensorAlignment {
  constructor(options = {}) {
    const historyMs = options.historyMs ?? 1000;
    const maxSamples = options.maxSamples ?? 96;
    this.orientationBuffer = new TimedSampleBuffer({
      historyMs,
      maxSamples,
      freshMs: options.orientationFreshMs ?? 300,
      maxInterpolationGapMs: options.orientationInterpolationGapMs ?? 180,
      normalizeValue: normalizeQuaternion,
      interpolateValue: slerpQuaternion,
    });
    this.gyroscopeBuffer = new TimedSampleBuffer({
      historyMs,
      maxSamples,
      freshMs: options.gyroscopeFreshMs ?? 180,
      maxInterpolationGapMs: options.gyroscopeInterpolationGapMs ?? 120,
      normalizeValue: finiteVector3,
      interpolateValue: lerpVector3,
    });
    this.accelerationCalibrator = new AccelerationUnitCalibrator(
      options.acceleration,
    );
    this.paused = false;
    this.lastAccelerationMs = null;
  }

  reset() {
    this.paused = false;
    this.orientationBuffer.clear();
    this.gyroscopeBuffer.clear();
    this.accelerationCalibrator.reset();
    this.lastAccelerationMs = null;
  }

  pause() {
    this.paused = true;
    this.orientationBuffer.clear();
    this.gyroscopeBuffer.clear();
    this.accelerationCalibrator.pause();
    this.lastAccelerationMs = null;
  }

  resume() {
    this.orientationBuffer.clear();
    this.gyroscopeBuffer.clear();
    this.accelerationCalibrator.resume();
    this.lastAccelerationMs = null;
    this.paused = false;
  }

  pushOrientation(quaternion, timestampMs) {
    if (this.paused) return false;
    return this.orientationBuffer.push(quaternion, timestampMs);
  }

  pushGyroscope(x, y, z, timestampMs) {
    if (this.paused) return false;
    return this.gyroscopeBuffer.push([x, y, z], timestampMs);
  }

  orientationAt(timestampMs) {
    if (this.paused) return null;
    return this.orientationBuffer.sampleAt(timestampMs);
  }

  gyroscopeAt(timestampMs) {
    if (this.paused) return null;
    return this.gyroscopeBuffer.sampleAt(timestampMs);
  }

  alignAcceleration(x, y, z, timestampMs, options = {}) {
    const rejected = (reason) => ({
      accepted: false,
      reason,
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
      accelerationMps2: null,
      accelerationCalibration: this.accelerationCalibrator.snapshot(),
      orientation: null,
      gyroscope: null,
    });
    if (this.paused) return rejected('paused');
    const vector = finiteVector3([x, y, z]);
    if (!vector || !Number.isFinite(timestampMs)) return rejected('invalid');

    if (this.lastAccelerationMs != null
        && timestampMs <= this.lastAccelerationMs) {
      // 加速度是对齐目标时钟；倒退或重复时清空所有短时样本，拒绝该帧。
      // 下一帧从干净的新纪元继续，避免把旧姿态插到新会话。
      this.orientationBuffer.clear();
      this.gyroscopeBuffer.clear();
      this.accelerationCalibrator.clearTransient();
      this.lastAccelerationMs = null;
      return rejected('non_monotonic_timestamp');
    }
    this.lastAccelerationMs = timestampMs;

    this.accelerationCalibrator.push(
      vector[0],
      vector[1],
      vector[2],
      timestampMs,
      { stationary: options.stationary },
    );
    const accelerationMps2 =
      this.accelerationCalibrator.convertVector(vector);
    return {
      accepted: true,
      reason: null,
      timestampMs,
      accelerationMps2,
      accelerationCalibration: this.accelerationCalibrator.snapshot(),
      orientation: this.orientationAt(timestampMs),
      gyroscope: this.gyroscopeAt(timestampMs),
    };
  }
}
