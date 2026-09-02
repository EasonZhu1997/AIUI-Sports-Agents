// AIUI 0.15 IMU 入场静稳门（纯逻辑、无页面与传感器 API 依赖）。
//
// 用户确认“下一步”与佩戴/扶正眼镜会留下短时余振。传感器仍需立即启动，
// 以便完成单位、姿态和静止基线识别；但在质量窗形成前不能把这些峰值送入
// StepDetector。门打开后调用方应重置两个检测器和 DualStepArbiter，再从
// 下一帧开始形成本场步频。

const DEFAULT_MIN_ARM_MS = 1200;
const DEFAULT_STATIONARY_HOLD_MS = 500;
const DEFAULT_MOTION_HOLD_MS = 800;
const DEFAULT_FALLBACK_ARM_MS = 3500;

function finiteNonNegative(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

export class ImuArmingGate {
  constructor(options = {}) {
    this.minArmMs = finiteNonNegative(options.minArmMs, DEFAULT_MIN_ARM_MS);
    this.stationaryHoldMs = finiteNonNegative(
      options.stationaryHoldMs,
      DEFAULT_STATIONARY_HOLD_MS,
    );
    this.motionHoldMs = finiteNonNegative(
      options.motionHoldMs,
      DEFAULT_MOTION_HOLD_MS,
    );
    this.fallbackArmMs = finiteNonNegative(
      options.fallbackArmMs,
      DEFAULT_FALLBACK_ARM_MS,
    );
    if (this.fallbackArmMs < this.minArmMs) {
      throw new RangeError('fallbackArmMs must not be shorter than minArmMs');
    }
    this.reset(options.startMs);
  }

  reset(startMs = null) {
    this.startMs = Number.isFinite(startMs) ? startMs : null;
    this.evidenceKind = null;
    this.evidenceSinceMs = null;
    this.armed = false;
    this.reason = 'waiting';
  }

  observe(quality = {}, nowMs) {
    if (!Number.isFinite(nowMs)) return this.snapshot();
    if (this.startMs == null || nowMs < this.startMs) this.reset(nowMs);
    if (this.armed) return this.snapshot(nowMs);

    const elapsedMs = nowMs - this.startMs;
    const accelReady = quality.accelFresh === true
      && Number(quality.accelSamples) >= 8;
    const gyroReady = quality.gyroFresh === true
      && Number(quality.gyroSamples) >= 8;
    const stationaryConfidence = clamp01(quality.stationaryConfidence);
    const runningConfidence = clamp01(quality.runningConfidence);
    const artifactConfidence = clamp01(quality.artifactConfidence);

    let evidenceKind = null;
    let holdMs = 0;
    if (accelReady && gyroReady && stationaryConfidence >= 0.58) {
      evidenceKind = 'stationary';
      holdMs = this.stationaryHoldMs;
    } else if (accelReady
        && runningConfidence >= 0.58
        && artifactConfidence < 0.48) {
      // 用户确认后立即起跑时不强迫静止；持续、低伪动作的运动质量同样可开门。
      evidenceKind = 'motion';
      holdMs = this.motionHoldMs;
    }

    if (evidenceKind !== this.evidenceKind) {
      this.evidenceKind = evidenceKind;
      this.evidenceSinceMs = evidenceKind ? nowMs : null;
    }

    const heldMs = this.evidenceSinceMs == null
      ? 0 : Math.max(0, nowMs - this.evidenceSinceMs);
    if (elapsedMs >= this.minArmMs
        && evidenceKind
        && heldMs >= holdMs) {
      this.armed = true;
      this.reason = evidenceKind;
      return this.snapshot(nowMs);
    }

    // 旧宿主可能没有 Gyroscope。只要加速度质量窗已形成，有限兜底仍会
    // 开门；调用方后续的严格模长通道继续负责防伪步，不会永久降级仅计时。
    if (elapsedMs >= this.fallbackArmMs && accelReady) {
      this.armed = true;
      this.reason = gyroReady ? 'quality-timeout' : 'accel-only-timeout';
    }
    return this.snapshot(nowMs);
  }

  snapshot(nowMs = this.startMs) {
    const elapsedMs = Number.isFinite(nowMs) && this.startMs != null
      ? Math.max(0, nowMs - this.startMs) : 0;
    return {
      armed: this.armed,
      reason: this.reason,
      elapsedMs,
      evidenceKind: this.evidenceKind,
      evidenceHeldMs: Number.isFinite(nowMs) && this.evidenceSinceMs != null
        ? Math.max(0, nowMs - this.evidenceSinceMs) : 0,
    };
  }
}
