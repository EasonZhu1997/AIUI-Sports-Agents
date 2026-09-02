// SmartRun 一维速度融合（纯逻辑、无 AIUI/DOM 依赖）。
//
// 这不是“把每个传感器的距离再加一遍”。MotionMetrics 仍是唯一距离账本；
// 本模块只用不同置信度的 RSC / GPS / IMU 速度观测维护一个连续、低抖动的
// HUD 速度状态。暂停、断流与静止都不会跨空档积分，也不会伪造运动距离。

const DEFAULT_SOURCE_STD_MPS = Object.freeze({
  rsc: 0.18,
  gps: 0.65,
  imu: 0.9,
});

const DEFAULT_SOURCE_FRESH_MS = Object.freeze({
  rsc: 2800,
  gps: 5500,
  imu: 3200,
  stationary: 1800,
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finiteInRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function sourceName(value) {
  const source = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(DEFAULT_SOURCE_STD_MPS, source)
    ? source : null;
}

function observationStdMps(source, metadata = {}) {
  const quality = clamp(Number(metadata.quality) || 0.5, 0.05, 1);
  let std = DEFAULT_SOURCE_STD_MPS[source];
  if (source === 'gps') {
    const accuracyM = Number(metadata.accuracyM);
    const windowSec = Number(metadata.windowSec);
    if (accuracyM > 0 && windowSec > 0) {
      // GPS 位置误差经短窗口差分后会被放大成速度误差。旧公式把任何
      // 1–4 秒窗口都按 4 秒处理，5m 精度/1Hz 的坏点仍获得过高权重。
      // 按真实窗口估计并提高误差系数，让短窗 GPS 只做弱校正。
      std = Math.max(std, accuracyM / Math.max(1, windowSec) * 0.7);
    }
  } else if (source === 'imu') {
    const strideConfidence = clamp(
      Number(metadata.strideConfidence) || 0,
      0,
      1,
    );
    const cadenceConfidence = clamp(
      Number(metadata.cadenceConfidence) || quality,
      0,
      1,
    );
    std *= 1.35 - 0.55 * strideConfidence;
    std *= 1.25 - 0.35 * cadenceConfidence;
  }
  return clamp(std / Math.sqrt(quality), 0.08, 6);
}

export class MotionSpeedFusion {
  constructor(options = {}) {
    this.maxSpeedMps = options.maxSpeedMps ?? 25 / 3.6;
    this.processStdMpsPerSqrtSec = options.processStdMpsPerSqrtSec ?? 0.48;
    this.maxPredictionGapMs = options.maxPredictionGapMs ?? 3000;
    this.outlierSigma = options.outlierSigma ?? 4;
    this.outlierAbsMps = options.outlierAbsMps ?? 2.2;
    this.outlierConfirmSamples = options.outlierConfirmSamples ?? 3;
    this.stepConsistencyMps = options.stepConsistencyMps ?? 0.8;
    this.sourceFreshMs = {
      ...DEFAULT_SOURCE_FRESH_MS,
      ...(options.sourceFreshMs || {}),
    };
    if (!(this.maxSpeedMps > 0)
        || !(this.processStdMpsPerSqrtSec > 0)
        || !(this.maxPredictionGapMs > 0)
        || !(this.outlierSigma >= 2)
        || !(this.outlierAbsMps > 0)
        || !(this.outlierConfirmSamples >= 2)) {
      throw new RangeError('invalid speed fusion options');
    }
    this.reset();
  }

  reset(nowMs = null) {
    this.speedMps = null;
    this.variance = null;
    this.lastStateMs = Number.isFinite(nowMs) ? nowMs : null;
    this.lastObservationMs = null;
    this.lastObservationSource = 'none';
    this.paused = false;
    this.rejectedSamples = 0;
    this.pendingDirection = 0;
    this.pendingSamples = [];
    this.pendingAtMs = null;
  }

  pause(nowMs) {
    if (this.paused || !Number.isFinite(nowMs)) return false;
    this.paused = true;
    this.lastStateMs = nowMs;
    this._clearPending();
    return true;
  }

  resume(nowMs) {
    if (!this.paused || !Number.isFinite(nowMs)) return false;
    this.paused = false;
    this.lastStateMs = nowMs;
    // 隐藏前的速度不能冒充恢复后的当前速度；保留统计状态但先判为不新鲜。
    this.lastObservationMs = null;
    this.lastObservationSource = 'none';
    this._clearPending();
    return true;
  }

  observe(sourceValue, speedValue, tValue, metadata = {}) {
    const source = sourceName(sourceValue);
    const speedMps = Number(speedValue);
    const tMs = Number(tValue);
    if (!source
        || !finiteInRange(speedMps, 0, this.maxSpeedMps)
        || !Number.isFinite(tMs)
        || this.paused) {
      return this._result(false, false);
    }
    if (this.lastStateMs != null && tMs < this.lastStateMs) {
      return this._result(false, false);
    }

    this._predict(tMs);
    const stdMps = observationStdMps(source, metadata);
    const obsVariance = stdMps * stdMps;

    // 高置信静止会把速度与方差同时压到接近 0。若下一条真实运动仍走普通
    // Kalman 更新，过小的先验方差会让 2m/s 左右的正常起步被拖成十几到
    // 二十多分钟配速。首个正的非静止来源就是新的运动片段锚点：立即采用，
    // 距离仍由 MotionMetrics 独立记账，不会因此补算静止区间。
    if (this.lastObservationSource === 'stationary' && speedMps > 0) {
      this.speedMps = speedMps;
      this.variance = obsVariance;
      this.lastStateMs = tMs;
      this.lastObservationMs = tMs;
      this.lastObservationSource = source;
      this._clearPending();
      return this._result(true, false);
    }

    if (this.speedMps == null || this.variance == null
        || this.lastObservationMs == null
        || tMs - this.lastObservationMs > this.maxPredictionGapMs) {
      this.speedMps = speedMps;
      this.variance = obsVariance;
      this.lastStateMs = tMs;
      this.lastObservationMs = tMs;
      this.lastObservationSource = source;
      this._clearPending();
      return this._result(true, false);
    }

    const residual = speedMps - this.speedMps;
    const innovationStd = Math.sqrt(Math.max(1e-6, this.variance + obsVariance));
    const outlierLimit = Math.max(
      this.outlierAbsMps,
      this.outlierSigma * innovationStd,
    );
    if (Math.abs(residual) > outlierLimit) {
      const direction = residual > 0 ? 1 : -1;
      const confirmed = this._confirmStep(speedMps, direction, tMs);
      if (confirmed == null) {
        this.rejectedSamples += 1;
        return this._result(false, true);
      }
      this.speedMps = confirmed;
      this.variance = obsVariance;
    } else {
      this._clearPending();
      const gain = this.variance / (this.variance + obsVariance);
      this.speedMps = clamp(
        this.speedMps + gain * residual,
        0,
        this.maxSpeedMps,
      );
      this.variance = Math.max(1e-6, (1 - gain) * this.variance);
    }
    this.lastStateMs = tMs;
    this.lastObservationMs = tMs;
    this.lastObservationSource = source;
    return this._result(true, false);
  }

  observeStationary(tMs, confidence = 1) {
    const nowMs = Number(tMs);
    if (!Number.isFinite(nowMs) || this.paused) return this._result(false, false);
    if (this.lastStateMs != null && nowMs < this.lastStateMs) {
      return this._result(false, false);
    }
    const quality = clamp(Number(confidence) || 0, 0, 1);
    this._predict(nowMs);
    if (quality >= 0.8 || this.speedMps == null) {
      this.speedMps = 0;
      this.variance = 0.01;
    } else {
      const obsVariance = Math.max(0.015, 0.2 * (1 - quality));
      const priorVariance = this.variance == null ? 1 : this.variance;
      const gain = priorVariance / (priorVariance + obsVariance);
      this.speedMps = Math.max(0, (this.speedMps || 0) * (1 - gain));
      this.variance = Math.max(1e-6, (1 - gain) * priorVariance);
    }
    this.lastStateMs = nowMs;
    this.lastObservationMs = nowMs;
    this.lastObservationSource = 'stationary';
    this._clearPending();
    return this._result(true, false);
  }

  snapshot(nowMs) {
    const now = Number(nowMs);
    const source = this.lastObservationSource;
    const freshForMs = this.sourceFreshMs[source] || 0;
    const live = !this.paused
      && this.speedMps != null
      && this.lastObservationMs != null
      && Number.isFinite(now)
      && now - this.lastObservationMs >= 0
      && now - this.lastObservationMs <= freshForMs;
    const variance = this.variance == null ? null : this.variance;
    const confidence = live && variance != null
      ? clamp(1 / (1 + Math.sqrt(variance)), 0, 1)
      : 0;
    return {
      live,
      speedMps: live ? this.speedMps : null,
      paceSecPerKm: live && this.speedMps > 0.3 ? 1000 / this.speedMps : null,
      source: live ? source : 'none',
      confidence,
      variance,
      lastObservationMs: this.lastObservationMs,
      rejectedSamples: this.rejectedSamples,
      paused: this.paused,
    };
  }

  _predict(tMs) {
    if (this.lastStateMs == null) {
      this.lastStateMs = tMs;
      return;
    }
    const dtMs = tMs - this.lastStateMs;
    if (!(dtMs > 0)) return;
    const dtSec = Math.min(dtMs, this.maxPredictionGapMs) / 1000;
    if (this.variance != null) {
      const processVariance = this.processStdMpsPerSqrtSec
        * this.processStdMpsPerSqrtSec * dtSec;
      this.variance += processVariance;
    }
    this.lastStateMs = tMs;
  }

  _confirmStep(value, direction, tMs) {
    const withinGap = this.pendingAtMs != null
      && tMs > this.pendingAtMs
      && tMs - this.pendingAtMs <= this.maxPredictionGapMs;
    const sameDirection = this.pendingDirection === direction;
    const centre = this.pendingSamples.length
      ? this.pendingSamples.reduce((sum, sample) => sum + sample, 0)
        / this.pendingSamples.length
      : null;
    const consistent = withinGap && sameDirection && centre != null
      && Math.abs(value - centre) <= this.stepConsistencyMps;
    if (!consistent) {
      this.pendingDirection = direction;
      this.pendingSamples = [value];
    } else {
      this.pendingSamples.push(value);
    }
    this.pendingAtMs = tMs;
    if (this.pendingSamples.length < this.outlierConfirmSamples) return null;
    const sorted = this.pendingSamples.slice().sort((a, b) => a - b);
    const confirmed = sorted[Math.floor(sorted.length / 2)];
    this._clearPending();
    return confirmed;
  }

  _clearPending() {
    this.pendingDirection = 0;
    this.pendingSamples = [];
    this.pendingAtMs = null;
  }

  _result(accepted, outlierRejected) {
    return {
      accepted,
      outlierRejected,
      speedMps: this.speedMps,
      source: this.lastObservationSource,
    };
  }
}
