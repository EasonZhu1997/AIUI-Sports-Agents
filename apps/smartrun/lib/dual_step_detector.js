// AIUI 0.15 双通道落步仲裁（纯逻辑、无传感器/页面依赖）。
//
// VerticalAccelerationProjector 与原始加速度模长各自继续使用已经验证的
// StepDetector。本模块只仲裁两个检测结果，最终仍只向 MotionMetrics 提交
// 一次落步，避免形成第二套步数或距离账本。
//
// 正常跑动时优先姿态投影通道；姿态不可用时退回灵敏模长通道。陀螺仪只
// 拦截转头/扶眼镜动作，不参与速度或距离积分。真机静坐数据证明，周期性的
// 扶镜动作也可能同时骗过单个敏感通道和严格模长通道。因此高角速度时每个
// 落步都必须由两通道在短窗内一致确认；一次一致不能许可后续单通道峰值。

const DEFAULT_AGREEMENT_WINDOW_MS = 180;
const DEFAULT_STEP_DEDUPE_MS = 220;
const DEFAULT_CADENCE_HOLD_MS = 2600;
const DEFAULT_FINAL_CADENCE_WINDOW = 12;
const DEFAULT_FINAL_CADENCE_MIN_INTERVALS = 3;
const DEFAULT_FINAL_CADENCE_MAX_INTERVAL_MS = 1500;
const DEFAULT_FINAL_CADENCE_RESET_GAP_MS = 4000;
const DEFAULT_MIN_SENSITIVE_GYRO_RMS = 0.002;
const DEFAULT_MAX_SENSITIVE_GYRO_RMS = 0.28;

function finiteCadence(result) {
  const cadence = Number(result && result.cadenceSpm);
  return result && result.cadenceReady === true
    && Number.isFinite(cadence) && cadence >= 40 && cadence <= 260
    ? cadence : null;
}

function finiteStepAtMs(result, fallbackMs) {
  const value = Number(result && result.stepAtMs);
  return Number.isFinite(value) && value <= fallbackMs
    ? value : fallbackMs;
}

function qualityNumber(quality, key) {
  const value = Number(quality && quality[key]);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function cadenceAgreement(left, right) {
  if (!(Number.isFinite(left) && Number.isFinite(right))) return false;
  return Math.abs(left - right) <= Math.max(14, Math.min(left, right) * 0.12);
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export class DualStepArbiter {
  constructor(options = {}) {
    this.agreementWindowMs = options.agreementWindowMs
      ?? DEFAULT_AGREEMENT_WINDOW_MS;
    this.stepDedupeMs = options.stepDedupeMs ?? DEFAULT_STEP_DEDUPE_MS;
    this.cadenceHoldMs = options.cadenceHoldMs ?? DEFAULT_CADENCE_HOLD_MS;
    this.finalCadenceWindow = options.finalCadenceWindow
      ?? DEFAULT_FINAL_CADENCE_WINDOW;
    this.finalCadenceMinIntervals = options.finalCadenceMinIntervals
      ?? DEFAULT_FINAL_CADENCE_MIN_INTERVALS;
    this.finalCadenceMaxIntervalMs = options.finalCadenceMaxIntervalMs
      ?? DEFAULT_FINAL_CADENCE_MAX_INTERVAL_MS;
    this.finalCadenceResetGapMs = options.finalCadenceResetGapMs
      ?? DEFAULT_FINAL_CADENCE_RESET_GAP_MS;
    this.minSensitiveGyroRms = options.minSensitiveGyroRms
      ?? DEFAULT_MIN_SENSITIVE_GYRO_RMS;
    this.maxSensitiveGyroRms = options.maxSensitiveGyroRms
      ?? DEFAULT_MAX_SENSITIVE_GYRO_RMS;
    if (!(this.agreementWindowMs > 0)
        || !(this.stepDedupeMs > 0)
        || !(this.cadenceHoldMs >= 0)
        || !(Number.isInteger(this.finalCadenceWindow)
          && this.finalCadenceWindow >= 3)
        || !(Number.isInteger(this.finalCadenceMinIntervals)
          && this.finalCadenceMinIntervals >= 2
          && this.finalCadenceMinIntervals <= this.finalCadenceWindow)
        || !(this.finalCadenceMaxIntervalMs > this.stepDedupeMs)
        || !(this.finalCadenceResetGapMs > this.finalCadenceMaxIntervalMs)
        || !(this.minSensitiveGyroRms >= 0
          && this.minSensitiveGyroRms < this.maxSensitiveGyroRms)
        || !(this.maxSensitiveGyroRms > 0)) {
      throw new RangeError('invalid dual step arbiter options');
    }
    this.reset();
  }

  reset() {
    this.paused = false;
    this.lastObservedMs = null;
    this.lastAcceptedMs = null;
    this.pendingProjectedMs = null;
    this.pendingMagnitudeMs = null;
    this.lastTrustedCadenceSpm = 0;
    this.lastTrustedCadenceMs = null;
    this.lastCandidateCadenceSpm = 0;
    this.finalAcceptedTimes = [];
    this.acceptedSteps = 0;
  }

  pause() {
    this.paused = true;
    this._clearPending();
    this._resetFinalCadence();
  }

  resume() {
    this.paused = false;
    this.lastObservedMs = null;
    this._clearPending();
    this._resetFinalCadence();
  }

  /**
   * @param {{
   *   timestampMs:number,
   *   projectedResult?:object,
   *   magnitudeResult?:object,
   *   projectedUsable?:boolean,
   *   quality?:object
   * }} input
   */
  observe(input = {}) {
    const timestampMs = Number(input.timestampMs);
    const idle = (reason = 'invalid') => this._result(false, 'none', reason, timestampMs);
    if (this.paused || !Number.isFinite(timestampMs)) return idle(this.paused ? 'paused' : 'invalid');
    if (this.lastObservedMs != null && timestampMs <= this.lastObservedMs) {
      this._resetFinalCadence();
      return idle('out_of_order');
    }
    this.lastObservedMs = timestampMs;
    this._expirePending(timestampMs);

    const projected = input.projectedResult || {};
    const magnitude = input.magnitudeResult || {};
    const projectedStepped = projected.stepped === true;
    const magnitudeStepped = magnitude.stepped === true;
    const projectedStepAtMs = projectedStepped
      ? finiteStepAtMs(projected, timestampMs) : null;
    const magnitudeStepAtMs = magnitudeStepped
      ? finiteStepAtMs(magnitude, timestampMs) : null;
    if (projectedStepped) this.pendingProjectedMs = projectedStepAtMs;
    if (magnitudeStepped) this.pendingMagnitudeMs = magnitudeStepAtMs;

    const projectedCadence = finiteCadence(projected);
    const magnitudeCadence = finiteCadence(magnitude);
    const quality = input.quality || {};
    const artifactConfidence = qualityNumber(quality, 'artifactConfidence');
    const stationaryConfidence = qualityNumber(quality, 'stationaryConfidence');
    const gyroRms = Number(quality.gyroRms);
    const highAngularMotion = quality.gyroFresh === true
      && Number.isFinite(gyroRms)
      && gyroRms >= this.maxSensitiveGyroRms;
    const requireAgreement = quality.state === 'head_motion'
      || artifactConfidence >= 0.55
      || highAngularMotion;
    const projectedUsable = input.projectedUsable === true;

    // 姿态投影通道为了适配头戴弱振动使用了更灵敏的参数；明确的稳定静止
    // 仍然优先于任一单通道峰值，避免周期性轻触在桌面状态被误记为落步。
    if (quality.state === 'stationary' && stationaryConfidence >= 0.68) {
      this._clearPending();
      return this._result(false, 'none', 'stationary', timestampMs);
    }

    if (requireAgreement) {
      // 高角速度下不允许任何单通道凭自身周期接管。必须对当前一步逐次验证
      // 两通道的时间和步频一致；合法 agreement 只提交这一落步，不形成
      // 可被后续扶镜峰复用的“通行证”。
      if (this._pendingChannelsAgree()
          && cadenceAgreement(projectedCadence, magnitudeCadence)) {
        const cadence = this._trustedCadence(
          projectedCadence,
          magnitudeCadence,
          true,
        );
        const agreedStepAtMs = Math.round(
          (this.pendingProjectedMs + this.pendingMagnitudeMs) / 2,
        );
        this._clearPending();
        return this._commit(
          agreedStepAtMs,
          cadence,
          'agreement',
          'head_motion_agreement',
          true,
        );
      }
      if (this._pendingChannelsAgree()) {
        this._clearPending();
        return this._result(
          false,
          'none',
          'cadence_disagreement',
          timestampMs,
        );
      }
      return this._result(
        false,
        'none',
        projectedUsable ? 'awaiting_agreement' : 'angular_motion_without_agreement',
        timestampMs,
      );
    }

    // 姿态投影/raw-magnitude-sensitive 都是低阈值敏感通道。真机坐姿转头、
    // 扶镜与姿态滞后会让它们产生大量周期性伪峰；只有陀螺仪明确安静，
    // 或当前帧严格模长同时触发时，敏感通道才可提交。
    if (projectedUsable && projectedStepped) {
      const strictAgreement = magnitudeStepped
        && cadenceAgreement(projectedCadence, magnitudeCadence);
      if (!strictAgreement
          && !this._canUseSensitiveChannel(quality)) {
        return this._result(
          false,
          'none',
          'sensitive_without_quiet_gyro',
          timestampMs,
        );
      }
      const cadence = this._trustedCadence(
        projectedCadence,
        magnitudeCadence,
        magnitudeStepped,
      );
      this._clearPending();
      return this._commit(
        projectedStepAtMs,
        cadence,
        'projected',
        'projected_primary',
        strictAgreement,
      );
    }
    if (!projectedUsable && (projectedStepped || magnitudeStepped)) {
      // 姿态不可用时 projectedResult 承载低阈值 raw magnitude。严格模长
      // 同帧出现时始终优先；只有敏感通道单独出现才检查许可。
      const strictMagnitude = magnitudeStepped;
      const useSensitiveMagnitude = !strictMagnitude && projectedStepped;
      if (useSensitiveMagnitude
          && !this._canUseSensitiveChannel(quality)) {
        return this._result(
          false,
          'none',
          'sensitive_without_quiet_gyro',
          timestampMs,
        );
      }
      const cadence = this._trustedCadence(
        useSensitiveMagnitude ? projectedCadence : magnitudeCadence,
        useSensitiveMagnitude ? magnitudeCadence : projectedCadence,
        useSensitiveMagnitude ? magnitudeStepped : projectedStepped,
      );
      this._clearPending();
      return this._commit(
        strictMagnitude ? magnitudeStepAtMs : projectedStepAtMs,
        cadence,
        useSensitiveMagnitude ? 'magnitude_sensitive' : 'magnitude',
        useSensitiveMagnitude
          ? 'sensitive_magnitude_fallback'
          : 'magnitude_fallback',
        strictMagnitude,
      );
    }

    // 投影通道偶发漏峰时，优先使用两路一致结果。若姿态虽然存在、投影却
    // 尚未形成节奏，模长通道自己的周期一致性已经是独立强证据；低伪动作
    // 下允许它接管，不能再要求由同一条偏弱投影计算出的 runningConfidence
    // 来证明自己，否则会形成“投影弱→置信度低→模长永远不能接管”的死锁。
    if (projectedUsable && magnitudeStepped && magnitudeCadence != null) {
      const cadenceConsistent = projectedCadence != null
        && cadenceAgreement(projectedCadence, magnitudeCadence);
      const periodicMagnitudeFallback = projectedCadence == null
        && artifactConfidence < 0.45
        && stationaryConfidence < 0.68;
      if (cadenceConsistent || periodicMagnitudeFallback) {
        const cadence = cadenceConsistent
          ? Math.round((projectedCadence + magnitudeCadence) / 2)
          : magnitudeCadence;
        this._clearPending();
        return this._commit(
          magnitudeStepAtMs,
          cadence,
          'magnitude',
          cadenceConsistent
            ? 'magnitude_recovery'
            : 'magnitude_periodic_fallback',
          true,
        );
      }
    }

    return this._result(false, 'none', 'no_step', timestampMs);
  }

  _pendingChannelsAgree() {
    return this.pendingProjectedMs != null
      && this.pendingMagnitudeMs != null
      && Math.abs(this.pendingProjectedMs - this.pendingMagnitudeMs)
        <= this.agreementWindowMs;
  }

  _expirePending(nowMs) {
    if (this.pendingProjectedMs != null
        && nowMs - this.pendingProjectedMs > this.agreementWindowMs) {
      this.pendingProjectedMs = null;
    }
    if (this.pendingMagnitudeMs != null
        && nowMs - this.pendingMagnitudeMs > this.agreementWindowMs) {
      this.pendingMagnitudeMs = null;
    }
  }

  _clearPending() {
    this.pendingProjectedMs = null;
    this.pendingMagnitudeMs = null;
  }

  _canUseSensitiveChannel(quality) {
    const gyroRms = Number(quality && quality.gyroRms);
    return quality && quality.gyroFresh === true
      && Number.isFinite(gyroRms)
      // 部分 AIUI 0.15 尝鲜宿主会持续回传全零 Gyroscope。fresh 只能证明
      // 回调在到达，不能证明陀螺仪真的可用；全零值不得被解释成“可靠安静”
      // 并为灵敏投影通道授予单通道计步许可。
      && gyroRms >= this.minSensitiveGyroRms
      && gyroRms < this.maxSensitiveGyroRms;
  }

  _trustedCadence(primary, secondary, secondaryStepped) {
    if (primary != null && secondary != null
        && secondaryStepped && cadenceAgreement(primary, secondary)) {
      return Math.round((primary + secondary) / 2);
    }
    return primary ?? secondary ?? 0;
  }

  _commit(timestampMs, cadenceSpm, channel, reason, strictEvidence = false) {
    if (this.lastAcceptedMs != null
        && timestampMs - this.lastAcceptedMs < this.stepDedupeMs) {
      return this._result(false, 'none', 'deduped', timestampMs);
    }
    this.lastAcceptedMs = timestampMs;
    this.acceptedSteps += 1;
    if (Number.isFinite(cadenceSpm) && cadenceSpm >= 40 && cadenceSpm <= 260) {
      this.lastCandidateCadenceSpm = cadenceSpm;
    }
    const previousAcceptedMs = this.finalAcceptedTimes.length > 0
      ? this.finalAcceptedTimes[this.finalAcceptedTimes.length - 1]
      : null;
    if (previousAcceptedMs != null
        && timestampMs - previousAcceptedMs > this.finalCadenceResetGapMs) {
      this._resetFinalCadence();
    }
    this.finalAcceptedTimes.push(timestampMs);
    if (this.finalAcceptedTimes.length > this.finalCadenceWindow + 1) {
      this.finalAcceptedTimes.shift();
    }
    const finalCadenceSpm = this._deriveFinalCadence();
    if (finalCadenceSpm > 0) {
      this.lastTrustedCadenceSpm = finalCadenceSpm;
      this.lastTrustedCadenceMs = timestampMs;
    }
    return this._result(
      true,
      channel,
      reason,
      timestampMs,
      strictEvidence === true,
    );
  }

  _deriveFinalCadence() {
    if (this.finalAcceptedTimes.length < this.finalCadenceMinIntervals + 1) {
      return 0;
    }
    const intervals = [];
    for (let index = 1; index < this.finalAcceptedTimes.length; index += 1) {
      const intervalMs = this.finalAcceptedTimes[index]
        - this.finalAcceptedTimes[index - 1];
      if (intervalMs >= this.stepDedupeMs
          && intervalMs <= this.finalCadenceMaxIntervalMs) {
        intervals.push(intervalMs);
      }
    }
    if (intervals.length < this.finalCadenceMinIntervals) return 0;
    const middle = median(intervals);
    if (!(middle > 0)) return 0;
    const cadenceSpm = Math.round(60000 / middle);
    return cadenceSpm >= 40 && cadenceSpm <= 260 ? cadenceSpm : 0;
  }

  _resetFinalCadence() {
    this.finalAcceptedTimes = [];
    this.lastTrustedCadenceSpm = 0;
    this.lastTrustedCadenceMs = null;
  }

  _result(stepped, channel, reason, timestampMs, strictEvidence = false) {
    const cadenceFresh = this.lastTrustedCadenceMs != null
      && Number.isFinite(timestampMs)
      && timestampMs >= this.lastTrustedCadenceMs
      && timestampMs - this.lastTrustedCadenceMs <= this.cadenceHoldMs;
    return {
      stepped,
      stepAtMs: stepped === true && Number.isFinite(timestampMs)
        ? timestampMs : null,
      channel,
      reason,
      steps: this.acceptedSteps,
      cadenceSpm: cadenceFresh ? this.lastTrustedCadenceSpm : 0,
      cadenceReady: cadenceFresh && this.lastTrustedCadenceSpm > 0,
      candidateCadenceSpm: this.lastCandidateCadenceSpm,
      // 严格模长或两通道一致是独立于灵敏投影的物理证据。页面的每段
      // 运动确认门用它区分真实起步与静坐时的周期性投影伪峰。
      strictEvidence: stepped === true && strictEvidence === true,
      pendingAgreement: this.pendingProjectedMs != null
        || this.pendingMagnitudeMs != null,
    };
  }
}
