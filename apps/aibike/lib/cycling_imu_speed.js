// 无轮速设备时，头戴 IMU 只能观测踩踏周期，不能观测实际挡位。
// 因此使用保守的固定中低挡模型并限制估算速度；真实骑行传感器仍优先。

export const DEFAULT_IMU_METERS_PER_CRANK = 3.2;
// 没有轮速时，头戴 IMU 只能看到周期，无法知道挡位。final 也只是
// “周期已锁定”，并不代表速度已经校准，因此未校准上限必须保守。
export const DEFAULT_IMU_SPEED_CAP_KMH = 20;
// 首个 fresh 周期候选优先用于“先出数”，但尚未通过 final 锁定时进一步
// 收紧，避免室内走动/轻踩一开始就顶到正式估算上限。
export const DEFAULT_IMU_AVAILABILITY_SPEED_CAP_KMH = 18;
// 周期性脚步若与 Accelerometer 冲击同相，不再冒充曲柄每圈 3.2m；仅作为
// 室内可见性测试给出步行尺度的保守运动估算。它不是骑行校准结果。
export const DEFAULT_IMU_WALKING_METERS_PER_STEP = 0.72;
export const DEFAULT_IMU_WALKING_SPEED_CAP_KMH = 8;
export const DEFAULT_IMU_WALKING_IMPACT_WINDOW_MS = 6000;
export const DEFAULT_IMU_WALKING_LATCH_MS = 4000;
export const DEFAULT_IMU_ELEVATED_CADENCE_RPM = 105;
export const DEFAULT_IMU_HIGH_CADENCE_RPM = 120;
export const DEFAULT_IMU_HIGH_CADENCE_SPEED_CAP_KMH = 15;

// 头戴 IMU 的周期窗偶尔会在基频与二次谐波之间切换。下面的稳定器只处理
// 已经通过 CyclingImuActivity 质量门的正向样本：小幅真实变化立即通过，
// 大幅跳变必须由连续窗口重复确认，再按物理可解释的斜率靠近。它不会在
// 没有新样本时自行推进，也不会把保持值写成新的传感器观测。
export class CyclingImuEstimateStabilizer {
  constructor(options = {}) {
    this.cadenceJumpRpm = Math.max(
      4,
      Number(options.cadenceJumpRpm) || 10,
    );
    this.cadenceJumpRatio = Math.max(
      0.05,
      Number(options.cadenceJumpRatio) || 0.14,
    );
    this.speedJumpKmh = Math.max(
      1,
      Number(options.speedJumpKmh) || 3,
    );
    this.confirmSamples = Math.max(
      2,
      Math.round(Number(options.confirmSamples) || 3),
    );
    this.harmonicConfirmSamples = Math.max(
      this.confirmSamples,
      Math.round(Number(options.harmonicConfirmSamples) || 4),
    );
    this.maxCadenceSlewRpmPerSec = Math.max(
      4,
      Number(options.maxCadenceSlewRpmPerSec) || 12,
    );
    this.maxSpeedSlewKmhPerSec = Math.max(
      1,
      Number(options.maxSpeedSlewKmhPerSec) || 2.5,
    );
    this.resetGapMs = Math.max(
      1000,
      Number(options.resetGapMs) || 5000,
    );
    this.reset();
  }

  reset() {
    this.cadenceRpm = null;
    this.speedKmh = null;
    this.outputAtMs = null;
    this.pending = null;
  }

  observe(cadenceRpm, speedKmh, nowMs) {
    const cadence = Number(cadenceRpm);
    const speed = Number(speedKmh);
    const now = Number(nowMs);
    if (!(cadence > 0) || !(speed > 0) || !Number.isFinite(now)) return null;

    if (!(this.cadenceRpm > 0) || !(this.speedKmh > 0)
        || !Number.isFinite(this.outputAtMs)
        || now < this.outputAtMs
        || now - this.outputAtMs > this.resetGapMs) {
      this.cadenceRpm = cadence;
      this.speedKmh = speed;
      this.outputAtMs = now;
      this.pending = null;
      return {
        cadenceRpm: cadence,
        speedKmh: speed,
        held: false,
        confirming: false,
        acceptedForLedger: true,
      };
    }

    const cadenceTolerance = Math.max(
      this.cadenceJumpRpm,
      this.cadenceRpm * this.cadenceJumpRatio,
    );
    const cadenceJump = Math.abs(cadence - this.cadenceRpm) > cadenceTolerance;
    const speedJump = Math.abs(speed - this.speedKmh) > this.speedJumpKmh;
    if (!cadenceJump && !speedJump) {
      this.cadenceRpm = cadence;
      this.speedKmh = speed;
      this.outputAtMs = now;
      this.pending = null;
      return {
        cadenceRpm: cadence,
        speedKmh: speed,
        held: false,
        confirming: false,
        acceptedForLedger: true,
      };
    }

    const pendingCadenceTolerance = Math.max(8, cadence * 0.12);
    const pendingMatches = this.pending
      && now >= this.pending.atMs
      && now - this.pending.atMs <= 1800
      && Math.abs(cadence - this.pending.cadenceRpm) <= pendingCadenceTolerance
      && Math.abs(speed - this.pending.speedKmh) <= 3;
    if (pendingMatches) {
      const count = this.pending.count + 1;
      this.pending = {
        cadenceRpm: (this.pending.cadenceRpm * (count - 1) + cadence) / count,
        speedKmh: (this.pending.speedKmh * (count - 1) + speed) / count,
        count,
        atMs: now,
      };
    } else {
      this.pending = {
        cadenceRpm: cadence,
        speedKmh: speed,
        count: 1,
        atMs: now,
      };
    }

    const cadenceRatio = this.pending.cadenceRpm / this.cadenceRpm;
    const harmonicJump = Math.abs(cadenceRatio - 2) <= 0.18
      || Math.abs(cadenceRatio - 0.5) <= 0.09;
    const required = harmonicJump
      ? this.harmonicConfirmSamples : this.confirmSamples;
    if (this.pending.count < required) {
      return {
        cadenceRpm: this.cadenceRpm,
        speedKmh: this.speedKmh,
        held: true,
        confirming: true,
        acceptedForLedger: false,
      };
    }

    const elapsedSec = Math.max(0.25, (now - this.outputAtMs) / 1000);
    const cadenceStep = this.maxCadenceSlewRpmPerSec * elapsedSec;
    const speedStep = this.maxSpeedSlewKmhPerSec * elapsedSec;
    const approach = (current, target, step) => (
      current + Math.max(-step, Math.min(step, target - current))
    );
    this.cadenceRpm = approach(
      this.cadenceRpm,
      this.pending.cadenceRpm,
      cadenceStep,
    );
    this.speedKmh = approach(
      this.speedKmh,
      this.pending.speedKmh,
      speedStep,
    );
    this.outputAtMs = now;
    const settled = Math.abs(this.cadenceRpm - this.pending.cadenceRpm) <= 0.5
      && Math.abs(this.speedKmh - this.pending.speedKmh) <= 0.1;
    if (settled) this.pending = null;
    return {
      cadenceRpm: this.cadenceRpm,
      speedKmh: this.speedKmh,
      held: !settled,
      confirming: !settled,
      acceptedForLedger: true,
    };
  }
}

export function estimateImuSpeedKmh(
  cadenceRpm,
  metersPerCrank = DEFAULT_IMU_METERS_PER_CRANK,
  speedCapKmh = DEFAULT_IMU_SPEED_CAP_KMH,
) {
  if (cadenceRpm === null || cadenceRpm === undefined || cadenceRpm === '') {
    return null;
  }
  const cadence = Number(cadenceRpm);
  const rollout = Number(metersPerCrank);
  const cap = Number(speedCapKmh);
  if (!(cadence >= 0) || !(rollout > 0) || !(cap > 0)) return null;
  if (cadence === 0) return 0;
  return Math.min(cap, cadence * rollout * 60 / 1000);
}

export function estimateImuFallbackSpeedKmh(
  cadenceRpm,
  options = {},
) {
  const profile = imuFallbackSpeedProfile(cadenceRpm, options);
  if (profile === 'calibrated') {
    return estimateImuSpeedKmh(
      cadenceRpm,
      options.metersPerCrank,
      Math.min(
        DEFAULT_IMU_SPEED_CAP_KMH,
        Number(options.speedLimitKmh) || DEFAULT_IMU_SPEED_CAP_KMH,
      ),
    );
  }
  if (profile === 'walking_like') {
    return estimateImuSpeedKmh(
      cadenceRpm,
      DEFAULT_IMU_WALKING_METERS_PER_STEP,
      DEFAULT_IMU_WALKING_SPEED_CAP_KMH,
    );
  }
  const cadence = Number(cadenceRpm);
  if (profile === 'high_cadence_harmonic') {
    // 头戴 IMU 在步行时经常把左右落脚识别成曲柄倍频。没有轮速
    // 校准时只对速度使用半频；踏频原始周期仍保留给 HUD 诊断。
    return estimateImuSpeedKmh(
      cadence / 2,
      DEFAULT_IMU_METERS_PER_CRANK,
      DEFAULT_IMU_HIGH_CADENCE_SPEED_CAP_KMH,
    );
  }
  const unverifiedCap = Number.isFinite(cadence)
      && cadence >= DEFAULT_IMU_ELEVATED_CADENCE_RPM
    ? Math.min(
      DEFAULT_IMU_AVAILABILITY_SPEED_CAP_KMH,
      options.estimateLevel === 'candidate'
        ? DEFAULT_IMU_AVAILABILITY_SPEED_CAP_KMH
        : DEFAULT_IMU_SPEED_CAP_KMH,
    )
    : (options.estimateLevel === 'candidate'
      ? DEFAULT_IMU_AVAILABILITY_SPEED_CAP_KMH
      : DEFAULT_IMU_SPEED_CAP_KMH);
  const configuredRollout = Number(options.metersPerCrank);
  return estimateImuSpeedKmh(
    cadenceRpm,
    Number.isFinite(configuredRollout) && configuredRollout > 0
      ? configuredRollout : DEFAULT_IMU_METERS_PER_CRANK,
    unverifiedCap,
  );
}

export function imuFallbackSpeedProfile(cadenceRpm, options = {}) {
  if (options.calibrated === true) return 'calibrated';
  if (options.walkingLike === true) return 'walking_like';
  const cadence = Number(cadenceRpm);
  if (Number.isFinite(cadence) && cadence >= DEFAULT_IMU_HIGH_CADENCE_RPM) {
    return 'high_cadence_harmonic';
  }
  if (Number.isFinite(cadence)
      && cadence >= DEFAULT_IMU_ELEVATED_CADENCE_RPM) {
    return 'elevated_cadence';
  }
  return options.estimateLevel === 'candidate'
    ? 'candidate' : 'cycling_unverified';
}

function median(values) {
  if (!Array.isArray(values) || !values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

// 只把“连续脚步冲击的间隔”与当前周期相位一致时标为 walking-like。
// 单个道路颠簸或随机冲击不会满足至少四次、跨 1.5 秒和多数间隔同相三门。
export function assessWalkingLikeCadence(
  cadenceRpm,
  impactTimestampsMs,
  nowMs,
) {
  const cadence = Number(cadenceRpm);
  const now = Number(nowMs);
  if (!(cadence >= 70 && cadence <= 150)
      || !Number.isFinite(now)
      || !Array.isArray(impactTimestampsMs)) {
    return { walkingLike: false, confidence: 0, matchedIntervals: 0 };
  }
  const cutoff = now - DEFAULT_IMU_WALKING_IMPACT_WINDOW_MS;
  const recent = impactTimestampsMs
    .map(Number)
    .filter((timestamp) => Number.isFinite(timestamp)
      && timestamp >= cutoff && timestamp <= now)
    .sort((left, right) => left - right)
    .filter((timestamp, index, values) => (
      index === 0 || timestamp - values[index - 1] >= 120
    ));
  if (recent.length < 4 || recent[recent.length - 1] - recent[0] < 1500) {
    return { walkingLike: false, confidence: 0, matchedIntervals: 0 };
  }
  const expectedMs = 60000 / cadence;
  const deltas = [];
  for (let index = 1; index < recent.length; index += 1) {
    const deltaMs = recent[index] - recent[index - 1];
    if (deltaMs >= 250 && deltaMs <= 1300) deltas.push(deltaMs);
  }
  if (deltas.length < 3) {
    return { walkingLike: false, confidence: 0, matchedIntervals: 0 };
  }
  const relativeError = (deltaMs) => Math.min(
    Math.abs(deltaMs - expectedMs) / expectedMs,
    Math.abs(deltaMs - expectedMs * 2) / (expectedMs * 2),
  );
  const matched = deltas.filter((deltaMs) => relativeError(deltaMs) <= 0.28);
  const matchRatio = matched.length / deltas.length;
  const centerMs = median(matched);
  const centerQuality = centerMs == null
    ? 0 : Math.max(0, 1 - relativeError(centerMs) / 0.28);
  const walkingLike = matched.length >= 3 && matchRatio >= 0.6;
  const confidence = walkingLike
    ? Math.min(0.95, 0.55 + matchRatio * 0.25 + centerQuality * 0.15)
    : 0;
  return {
    walkingLike,
    confidence,
    matchedIntervals: matched.length,
  };
}
