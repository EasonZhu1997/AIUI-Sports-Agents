// 每段 IMU 运动确认门（纯逻辑、无页面与传感器依赖）。
//
// DualStepArbiter 的灵敏投影通道负责不漏掉头戴设备上的弱慢走，但真机
// 静坐初期也可能出现周期性投影伪峰。这里把“候选落步”和正式距离账本
// 隔开：先观察一小段节奏，确认存在严格模长证据，或确认候选步频与最终
// accepted-step 步频连续一致，才允许本段运动进入 MotionMetrics。

const DEFAULT_STATIONARY_HOLD_MS = 1400;
const DEFAULT_STRICT_WINDOW_MS = 3000;
const DEFAULT_EVIDENCE_GAP_MS = 1800;
const DEFAULT_MIN_STRICT_EVIDENCE = 3;
const DEFAULT_STABLE_CADENCE_STEPS = 4;
const DEFAULT_MIN_RUNNING_CONFIDENCE = 0.58;
const DEFAULT_MAX_ARTIFACT_CONFIDENCE = 0.48;
const DEFAULT_MIN_USABLE_GYRO_RMS = 0.002;
const DEFAULT_MAX_UNCERTAIN_CADENCE_SPM = 210;

function finiteCadence(value) {
  const cadence = Number(value);
  return Number.isFinite(cadence) && cadence >= 40 && cadence <= 260
    ? cadence : null;
}

function cadenceAgreement(left, right) {
  if (!(Number.isFinite(left) && Number.isFinite(right))) return false;
  return Math.abs(left - right) <= Math.max(14, Math.min(left, right) * 0.12);
}

export class ImuActivityGate {
  constructor(options = {}) {
    this.stationaryHoldMs = options.stationaryHoldMs
      ?? DEFAULT_STATIONARY_HOLD_MS;
    this.strictWindowMs = options.strictWindowMs
      ?? DEFAULT_STRICT_WINDOW_MS;
    this.evidenceGapMs = options.evidenceGapMs
      ?? DEFAULT_EVIDENCE_GAP_MS;
    this.minStrictEvidence = options.minStrictEvidence
      ?? DEFAULT_MIN_STRICT_EVIDENCE;
    this.stableCadenceSteps = options.stableCadenceSteps
      ?? DEFAULT_STABLE_CADENCE_STEPS;
    this.minRunningConfidence = options.minRunningConfidence
      ?? DEFAULT_MIN_RUNNING_CONFIDENCE;
    this.maxArtifactConfidence = options.maxArtifactConfidence
      ?? DEFAULT_MAX_ARTIFACT_CONFIDENCE;
    if (!(this.stationaryHoldMs >= 500)
        || !(this.strictWindowMs > this.stationaryHoldMs)
        || !(this.evidenceGapMs > 0
          && this.evidenceGapMs <= this.strictWindowMs)
        || !(Number.isInteger(this.minStrictEvidence)
          && this.minStrictEvidence >= 1)
        || !(Number.isInteger(this.stableCadenceSteps)
          && this.stableCadenceSteps >= 1)
        || !(this.minRunningConfidence > 0
          && this.minRunningConfidence <= 1)
        || !(this.maxArtifactConfidence >= 0
          && this.maxArtifactConfidence < 1)) {
      throw new RangeError('invalid IMU activity gate options');
    }
    this.reset();
  }

  reset(timestampMs = null) {
    this.active = false;
    this.stationarySinceMs = null;
    this.strictEvidenceTimes = [];
    this.stableCadenceCount = 0;
    this.lastEvidenceMs = null;
    this.activeUnqualifiedSinceMs = null;
    this.lastObservedMs = Number.isFinite(timestampMs) ? timestampMs : null;
    this.activationReason = null;
  }

  pause() {
    this.reset();
  }

  confirmExternal(timestampMs, reason = 'external_motion') {
    if (!Number.isFinite(Number(timestampMs))) return this.snapshot();
    const wasActive = this.active;
    this.active = true;
    this.stationarySinceMs = null;
    this.strictEvidenceTimes = [];
    this.stableCadenceCount = 0;
    this.lastEvidenceMs = null;
    this.activeUnqualifiedSinceMs = null;
    this.lastObservedMs = Number(timestampMs);
    this.activationReason = String(reason || 'external_motion');
    return this.snapshot({
      justActivated: !wasActive,
      reason: this.activationReason,
    });
  }

  observe(input = {}) {
    const timestampMs = Number(input.timestampMs);
    const result = input.result || {};
    const quality = input.quality || {};
    if (!Number.isFinite(timestampMs)
        || (this.lastObservedMs != null && timestampMs <= this.lastObservedMs)) {
      return this.snapshot({ reason: 'invalid' });
    }
    this.lastObservedMs = timestampMs;

    const stationaryConfidence = Number(quality.stationaryConfidence);
    const runningConfidence = Number(quality.runningConfidence);
    const artifactConfidence = Number(quality.artifactConfidence);
    const gyroRms = Number(quality.gyroRms);
    const sustainedMotionQuality = Number.isFinite(runningConfidence)
      && runningConfidence >= this.minRunningConfidence
      && (!Number.isFinite(artifactConfidence)
        || artifactConfidence < this.maxArtifactConfidence)
      && (!Number.isFinite(stationaryConfidence)
        || stationaryConfidence < 0.55);
    const finalCadence = result.cadenceReady === true
      ? finiteCadence(result.cadenceSpm) : null;
    const candidateCadence = finiteCadence(result.candidateCadenceSpm);
    const gyroUsable = quality.gyroFresh !== true
      || (Number.isFinite(gyroRms)
        && gyroRms >= DEFAULT_MIN_USABLE_GYRO_RMS);
    // uncertain 状态不能借折半后的 final cadence 绕过高倍频候选，也不能只靠
    // 一次 strict 峰维持已经打开的活动门。候选与最终 cadence 必须同时存在、
    // 彼此一致且不高于常见坐姿 2x 倍频区。
    const uncertainRhythmicEvidence = result.stepped === true
      && quality.state === 'uncertain'
      && gyroUsable
      && Number.isFinite(candidateCadence)
      && candidateCadence <= DEFAULT_MAX_UNCERTAIN_CADENCE_SPM
      && cadenceAgreement(finalCadence, candidateCadence)
      && (!Number.isFinite(artifactConfidence)
        || artifactConfidence < this.maxArtifactConfidence)
      && (!Number.isFinite(stationaryConfidence)
        || stationaryConfidence < 0.55);
    const headMotionAgreement = result.stepped === true
      && result.reason === 'head_motion_agreement';
    const activeObservationQualified = sustainedMotionQuality
      || headMotionAgreement
      || uncertainRhythmicEvidence;
    const clearlyStationary = quality.state === 'stationary'
      && Number.isFinite(stationaryConfidence)
      && stationaryConfidence >= 0.68;
    if (clearlyStationary) {
      if (!this.active) this._clearActivationEvidence();
      if (this.stationarySinceMs == null) this.stationarySinceMs = timestampMs;
      if (this.active
          && timestampMs - this.stationarySinceMs >= this.stationaryHoldMs) {
        this.active = false;
        this._clearActivationEvidence();
        this.activeUnqualifiedSinceMs = null;
        this.activationReason = null;
        return this.snapshot({
          justDeactivated: true,
          reason: 'stationary_hold',
        });
      }
    } else {
      this.stationarySinceMs = null;
    }

    if (!this.active && this.lastEvidenceMs != null
        && timestampMs - this.lastEvidenceMs > this.evidenceGapMs) {
      this._clearActivationEvidence();
    }
    this.strictEvidenceTimes = this.strictEvidenceTimes.filter(
      (timeMs) => timestampMs - timeMs <= this.strictWindowMs,
    );

    if (result.stepped === true) {
      // 弱慢走在头戴设备上可能达不到 runningConfidence，但连续节奏仍是
      // 有效证据。只在非静止、低伪动作、非退化 gyro（或旧宿主无 gyro）
      // 且原始候选未落入常见 2x 倍频区时采用。final cadence 可能把
      // 220–240spm 的坐姿倍频折成 110–120spm，不能用折半后的值绕过门。
      // final 已形成时还必须与候选一致，uncertain 只能靠连续稳定节奏开门，
      // 不能再借一次 strict magnitude 峰直接取得整段计步资格。
      const strictActivationQuality = sustainedMotionQuality
        || headMotionAgreement;
      const stableActivationQuality = sustainedMotionQuality
        || uncertainRhythmicEvidence;
      if (result.strictEvidence === true
          && strictActivationQuality) {
        this.strictEvidenceTimes.push(timestampMs);
      } else if (result.strictEvidence === true) {
        this.strictEvidenceTimes = [];
      }
      if (stableActivationQuality
          && cadenceAgreement(finalCadence, candidateCadence)) {
        this.stableCadenceCount += 1;
      } else {
        this.stableCadenceCount = 0;
      }
      this.lastEvidenceMs = timestampMs;
    }

    // 活动门打开后也必须逐帧保留运动质量约束。invalid 候选永不提交；若一整
    // 个最慢合法步间隔之后仍没有 running、逐步双通道 agreement 或稳定
    // uncertain cadence 证据，则回到探测态。这样走动后坐下产生的 220–240spm
    // 周期伪峰不会借用上一段已经取得的 active 资格继续增加步数和距离。
    if (this.active) {
      if (activeObservationQualified) {
        this.activeUnqualifiedSinceMs = null;
      } else if (this.activeUnqualifiedSinceMs == null) {
        this.activeUnqualifiedSinceMs = timestampMs;
      }
      if (this.activeUnqualifiedSinceMs != null
          && timestampMs - this.activeUnqualifiedSinceMs >= this.evidenceGapMs) {
        this.active = false;
        this._clearActivationEvidence();
        this.activeUnqualifiedSinceMs = null;
        this.activationReason = null;
        return this.snapshot({
          justDeactivated: true,
          reason: 'active_evidence_lost',
        });
      }
      return this.snapshot({
        submitStep: result.stepped === true && activeObservationQualified,
        cadenceReady: result.cadenceReady === true && activeObservationQualified,
        cadenceSpm: activeObservationQualified ? (finalCadence || 0) : 0,
        reason: this.activationReason || 'active',
      });
    }

    let justActivated = false;
    let reason = 'probing';
    if (this.strictEvidenceTimes.length >= this.minStrictEvidence) {
      this.active = true;
      justActivated = true;
      reason = 'strict_evidence';
    } else if (this.stableCadenceCount >= this.stableCadenceSteps) {
      this.active = true;
      justActivated = true;
      reason = 'stable_projected_cadence';
    }
    if (justActivated) {
      this.activationReason = reason;
      this.stationarySinceMs = null;
      this.activeUnqualifiedSinceMs = null;
    }

    return this.snapshot({
      justActivated,
      submitStep: this.active
        && result.stepped === true
        && activeObservationQualified,
      cadenceReady: this.active
        && result.cadenceReady === true
        && activeObservationQualified,
      cadenceSpm: this.active && activeObservationQualified
        ? (finalCadence || 0) : 0,
      reason,
    });
  }

  snapshot(extra = {}) {
    return {
      active: this.active,
      justActivated: false,
      justDeactivated: false,
      submitStep: false,
      cadenceReady: false,
      cadenceSpm: 0,
      reason: this.active ? (this.activationReason || 'active') : 'probing',
      strictEvidenceCount: this.strictEvidenceTimes.length,
      stableCadenceCount: this.stableCadenceCount,
      ...extra,
    };
  }

  _clearActivationEvidence() {
    this.strictEvidenceTimes = [];
    this.stableCadenceCount = 0;
    this.lastEvidenceMs = null;
  }
}
