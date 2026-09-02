// AIUI 0.15 尝鲜版个人化步长模型（纯逻辑、无传感器/DOM/storage 依赖）。
//
// 设计边界：
// - 用户设置的单步长度始终是安全先验，模型没有可信样本时直接回退先验；
// - 慢跑、常规跑、快跑分桶学习，避免把不同步频下的步幅混为一谈；
// - 只接收调用方已经通过运动/定位质量门的 RSC 或 GPS 窗口；
// - GPS 必须有两个相互一致的窗口才形成一次学习，单个差定位不能污染模型；
// - 持久化数据只包含派生步长和置信度，不包含位置、轨迹或传感器原始值。

export const ADAPTIVE_STRIDE_VERSION = 2;
export const ADAPTIVE_STRIDE_STORAGE_KEY = 'smartrun_adaptive_stride_v2';
export const ADAPTIVE_STRIDE_LEGACY_STORAGE_KEYS = Object.freeze([
  'smartrun_adaptive_stride_v1',
]);

export const STRIDE_SOURCE = Object.freeze({
  RSC: 'rsc',
  GPS: 'gps',
});

export const CADENCE_BUCKET = Object.freeze({
  SLOW: 'slow',
  NORMAL: 'normal',
  FAST: 'fast',
});

const BUCKET_NAMES = Object.freeze([
  CADENCE_BUCKET.SLOW,
  CADENCE_BUCKET.NORMAL,
  CADENCE_BUCKET.FAST,
]);

const DEFAULT_STEP_LENGTH_M = 0.85;
const DEFAULT_MIN_STRIDE_M = 0.35;
const DEFAULT_MAX_STRIDE_M = 1.8;
const DEFAULT_MIN_CADENCE_SPM = 60;
const DEFAULT_MAX_CADENCE_SPM = 260;
const MAX_SERIALIZED_LENGTH = 16384;
const MAX_RECENT_SAMPLES = 7;

function finiteInRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeOwnerMarker(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f]/.test(value)) {
    return null;
  }
  return value;
}

function normalizeSource(source) {
  switch (source) {
    case STRIDE_SOURCE.RSC:
    case 'rsc_speed':
    case 'rsc_total_distance':
      return STRIDE_SOURCE.RSC;
    case STRIDE_SOURCE.GPS:
    case 'gps_path':
      return STRIDE_SOURCE.GPS;
    default:
      return null;
  }
}

function newBin() {
  return {
    emaM: null,
    effectiveSamples: 0,
    acceptedWindows: 0,
    recentM: [],
    lastSource: null,
  };
}

function newBins() {
  return {
    [CADENCE_BUCKET.SLOW]: newBin(),
    [CADENCE_BUCKET.NORMAL]: newBin(),
    [CADENCE_BUCKET.FAST]: newBin(),
  };
}

/**
 * 将双脚总步频分成三个学习区间。
 *
 * 边界 intentionally 保持宽松：60–149 为慢跑，150–179 为常规跑，
 * 180–260 为快跑。无效步频返回 null，不让节拍器默认值形成学习证据。
 */
export function cadenceBucketFor(cadenceSpm) {
  if (!finiteInRange(cadenceSpm, DEFAULT_MIN_CADENCE_SPM, DEFAULT_MAX_CADENCE_SPM)) {
    return null;
  }
  if (cadenceSpm < 150) return CADENCE_BUCKET.SLOW;
  if (cadenceSpm < 180) return CADENCE_BUCKET.NORMAL;
  return CADENCE_BUCKET.FAST;
}

/**
 * 纯眼镜 IMU 的保守单步长度。
 *
 * 用户设置值是跑步时的人工先验；没有可信 RSC/GPS 个性化样本时，不能把
 * 1.25m 之类的跑步步长原样套到 80–120spm 的室内慢走，否则每个已确认
 * 落步都会系统性高估距离与配速。这里仅约束 IMU fallback，RSC/GPS 距离
 * 账本及已形成高置信个性化结果保持原优先级。
 */
export function effectiveImuStepLengthM(
  configuredStepLengthM,
  cadenceSpm,
  estimate = null,
) {
  const configured = finiteInRange(
    Number(configuredStepLengthM),
    DEFAULT_MIN_STRIDE_M,
    DEFAULT_MAX_STRIDE_M,
  )
    ? Number(configuredStepLengthM)
    : DEFAULT_STEP_LENGTH_M;
  const cadence = Number(cadenceSpm);
  let cadenceCapM = 0.70;
  if (Number.isFinite(cadence) && cadence >= 110) cadenceCapM = 0.78;
  if (Number.isFinite(cadence) && cadence >= 130) cadenceCapM = 0.90;
  if (Number.isFinite(cadence) && cadence >= 160) cadenceCapM = 1.05;
  if (Number.isFinite(cadence) && cadence >= 180) cadenceCapM = 1.20;

  const learnedStepLengthM = Number(estimate && estimate.stepLengthM);
  const learnedConfidence = Number(estimate && estimate.confidence);
  if (estimate && estimate.learned === true
      && finiteInRange(
        learnedStepLengthM,
        DEFAULT_MIN_STRIDE_M,
        DEFAULT_MAX_STRIDE_M,
      )
      && Number.isFinite(learnedConfidence)
      && learnedConfidence >= 0.60) {
    return learnedStepLengthM;
  }
  return Math.min(configured, cadenceCapM);
}

function hasTrustedQualityGate(window) {
  return window?.trusted === true
    || window?.qualityGate === true
    || window?.quality?.trusted === true;
}

function qualityScoreFor(window) {
  const raw = Number(window?.qualityScore ?? window?.quality?.score ?? 1);
  return Number.isFinite(raw) ? clamp(raw, 0, 1) : 0;
}

function safeParsePayload(payload) {
  if (typeof payload === 'string') {
    if (payload.length === 0 || payload.length > MAX_SERIALIZED_LENGTH) return null;
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : null;
}

export class AdaptiveStrideModel {
  constructor(options = {}) {
    this.minStrideM = finiteInRange(options.minStrideM, 0.2, 1)
      ? options.minStrideM
      : DEFAULT_MIN_STRIDE_M;
    this.maxStrideM = finiteInRange(options.maxStrideM, 1, 2.5)
      && options.maxStrideM > this.minStrideM
      ? options.maxStrideM
      : DEFAULT_MAX_STRIDE_M;
    this.manualStepLengthM = finiteInRange(
      options.manualStepLengthM,
      this.minStrideM,
      this.maxStrideM,
    )
      ? options.manualStepLengthM
      : DEFAULT_STEP_LENGTH_M;
    this.ownerMarker = normalizeOwnerMarker(options.ownerMarker);

    this.rscAlpha = finiteInRange(options.rscAlpha, 0.02, 0.5)
      ? options.rscAlpha
      : 0.22;
    this.gpsAlpha = finiteInRange(options.gpsAlpha, 0.02, 0.35)
      ? options.gpsAlpha
      : 0.12;
    this.maxSampleDeltaM = finiteInRange(options.maxSampleDeltaM, 0.05, 0.6)
      ? options.maxSampleDeltaM
      : 0.24;
    // 个人化只能在用户明确设置的单步长度附近微调。旧模型允许多个被 GPS
    // 漂移污染的窗口把 EMA 推到 1.8m，170spm 会被误算成约 3:18/km。
    // v2 同时废弃旧缓存，并把最终输出限制在人工先验 ±0.24m。
    this.maxPersonalizationDeltaM = finiteInRange(
      options.maxPersonalizationDeltaM,
      0.08,
      0.5,
    )
      ? options.maxPersonalizationDeltaM
      : 0.24;
    this.confidenceScale = finiteInRange(options.confidenceScale, 1, 30)
      ? options.confidenceScale
      : 6;

    this.minRscSteps = options.minRscSteps ?? 20;
    this.minRscDistanceM = options.minRscDistanceM ?? 12;
    this.minRscDurationMs = options.minRscDurationMs ?? 8000;
    this.minGpsSteps = options.minGpsSteps ?? 36;
    this.minGpsDistanceM = options.minGpsDistanceM ?? 25;
    this.minGpsDurationMs = options.minGpsDurationMs ?? 15000;
    this.maxGpsAccuracyM = options.maxGpsAccuracyM ?? 20;

    this.bins = newBins();
    this.pendingGps = {
      [CADENCE_BUCKET.SLOW]: null,
      [CADENCE_BUCKET.NORMAL]: null,
      [CADENCE_BUCKET.FAST]: null,
    };
    this.restoreStatus = 'fresh';
  }

  /**
   * 返回当前步频下的个人化单步长度。
   *
   * confidence 是 0–1 的样本置信度；模型输出会按该置信度与人工先验混合，
   * 因而少量样本不会突然大幅改动距离。
   */
  estimate(cadenceSpm) {
    const bucket = cadenceBucketFor(cadenceSpm);
    if (!bucket) {
      return {
        stepLengthM: this.manualStepLengthM,
        bucket: null,
        confidence: 0,
        sampleCount: 0,
        learned: false,
        source: 'manual',
      };
    }

    const state = this.bins[bucket];
    if (!finiteInRange(state.emaM, this.minStrideM, this.maxStrideM)
        || state.effectiveSamples <= 0) {
      return {
        stepLengthM: this.manualStepLengthM,
        bucket,
        confidence: 0,
        sampleCount: 0,
        learned: false,
        source: 'manual',
      };
    }

    const confidence = clamp(
      1 - Math.exp(-state.effectiveSamples / this.confidenceScale),
      0,
      0.98,
    );
    const personalizedMinM = Math.max(
      this.minStrideM,
      this.manualStepLengthM - this.maxPersonalizationDeltaM,
    );
    const personalizedMaxM = Math.min(
      this.maxStrideM,
      this.manualStepLengthM + this.maxPersonalizationDeltaM,
    );
    const stepLengthM = clamp(
      this.manualStepLengthM * (1 - confidence) + state.emaM * confidence,
      personalizedMinM,
      personalizedMaxM,
    );
    return {
      stepLengthM,
      bucket,
      confidence,
      sampleCount: state.acceptedWindows,
      learned: true,
      source: state.lastSource || 'manual',
    };
  }

  /**
   * 学习一个调用方已质量门控的运动窗口。
   *
   * 输入字段：
   * - cadenceSpm / steps / distanceM / durationMs
   * - source: rsc、rsc_speed、rsc_total_distance、gps 或 gps_path
   * - trusted=true（也接受 qualityGate=true 或 quality.trusted=true）
   * - qualityScore 可选，0–1
   * - gpsAccuracyM 可选；提供时必须不大于 maxGpsAccuracyM
   */
  observeWindow(window = {}) {
    const reject = (reason, extra = {}) => ({
      accepted: false,
      pending: false,
      reason,
      ...extra,
    });

    const source = normalizeSource(window.source);
    if (!source) return reject('source_untrusted');
    if (!hasTrustedQualityGate(window)) return reject('quality_gate_failed');

    const qualityScore = qualityScoreFor(window);
    if (!(qualityScore > 0)) return reject('quality_score_invalid');

    const cadenceSpm = Number(window.cadenceSpm);
    const bucket = cadenceBucketFor(cadenceSpm);
    if (!bucket) return reject('cadence_invalid');

    const steps = Number(window.steps);
    const distanceM = Number(window.distanceM);
    const durationMs = Number(
      window.durationMs
      ?? (Number.isFinite(window.durationSec) ? window.durationSec * 1000 : NaN),
    );
    if (!(Number.isFinite(steps) && steps > 0)
        || !(Number.isFinite(distanceM) && distanceM > 0)
        || !(Number.isFinite(durationMs) && durationMs > 0)) {
      return reject('window_invalid', { bucket });
    }

    const minSteps = source === STRIDE_SOURCE.RSC ? this.minRscSteps : this.minGpsSteps;
    const minDistanceM = source === STRIDE_SOURCE.RSC
      ? this.minRscDistanceM
      : this.minGpsDistanceM;
    const minDurationMs = source === STRIDE_SOURCE.RSC
      ? this.minRscDurationMs
      : this.minGpsDurationMs;
    if (steps < minSteps || distanceM < minDistanceM || durationMs < minDurationMs) {
      return reject('window_too_short', { bucket });
    }

    const derivedCadenceSpm = steps * 60000 / durationMs;
    const cadenceToleranceSpm = Math.max(12, cadenceSpm * 0.1);
    if (Math.abs(derivedCadenceSpm - cadenceSpm) > cadenceToleranceSpm) {
      return reject('cadence_mismatch', { bucket });
    }

    if (source === STRIDE_SOURCE.GPS
        && Number.isFinite(window.gpsAccuracyM)
        && window.gpsAccuracyM > this.maxGpsAccuracyM) {
      return reject('gps_accuracy_low', { bucket });
    }

    const observedStrideM = distanceM / steps;
    if (!finiteInRange(observedStrideM, this.minStrideM, this.maxStrideM)) {
      return reject('stride_out_of_bounds', { bucket, observedStrideM });
    }
    const state = this.bins[bucket];
    if (this._isRobustOutlier(state, observedStrideM)) {
      return reject('stride_outlier', { bucket, observedStrideM });
    }
    const personalizationMinM = Math.max(
      this.minStrideM,
      this.manualStepLengthM - this.maxPersonalizationDeltaM,
    );
    const personalizationMaxM = Math.min(
      this.maxStrideM,
      this.manualStepLengthM + this.maxPersonalizationDeltaM,
    );
    if (!finiteInRange(
      observedStrideM,
      personalizationMinM,
      personalizationMaxM,
    )) {
      return reject('personalization_out_of_bounds', {
        bucket,
        observedStrideM,
      });
    }

    if (source === STRIDE_SOURCE.GPS) {
      const pending = this.pendingGps[bucket];
      const pairToleranceM = Math.max(0.1, observedStrideM * 0.12);
      if (!pending) {
        this.pendingGps[bucket] = { strideM: observedStrideM, qualityScore };
        return reject('gps_confirmation_pending', {
          pending: true,
          bucket,
          observedStrideM,
        });
      }
      if (Math.abs(pending.strideM - observedStrideM) > pairToleranceM) {
        this.pendingGps[bucket] = { strideM: observedStrideM, qualityScore };
        return reject('gps_confirmation_replaced', {
          pending: true,
          bucket,
          observedStrideM,
        });
      }

      const combinedStrideM = (pending.strideM + observedStrideM) / 2;
      const combinedQuality = Math.min(pending.qualityScore, qualityScore);
      this.pendingGps[bucket] = null;
      return this._applyObservation(
        bucket,
        combinedStrideM,
        source,
        combinedQuality,
        1,
      );
    }

    return this._applyObservation(bucket, observedStrideM, source, qualityScore, 1);
  }

  _isRobustOutlier(state, strideM) {
    if (state.recentM.length < 3) return false;
    const centre = median(state.recentM);
    const deviations = state.recentM.map((value) => Math.abs(value - centre));
    const mad = median(deviations) ?? 0;
    const toleranceM = Math.max(0.12, centre * 0.16, mad * 3.5);
    return Math.abs(strideM - centre) > toleranceM;
  }

  _applyObservation(bucket, strideM, source, qualityScore, sampleWeight) {
    const state = this.bins[bucket];
    const previousBase = finiteInRange(state.emaM, this.minStrideM, this.maxStrideM)
      ? state.emaM
      : this.manualStepLengthM;
    const boundedSampleM = clamp(
      strideM,
      previousBase - this.maxSampleDeltaM,
      previousBase + this.maxSampleDeltaM,
    );
    const baseAlpha = source === STRIDE_SOURCE.RSC ? this.rscAlpha : this.gpsAlpha;
    const alpha = clamp(baseAlpha * qualityScore, 0.02, baseAlpha);

    state.emaM = clamp(
      previousBase + alpha * (boundedSampleM - previousBase),
      this.minStrideM,
      this.maxStrideM,
    );
    state.effectiveSamples = clamp(
      state.effectiveSamples + sampleWeight * qualityScore,
      0,
      1000,
    );
    state.acceptedWindows = Math.min(1000000, state.acceptedWindows + 1);
    state.recentM.push(strideM);
    if (state.recentM.length > MAX_RECENT_SAMPLES) state.recentM.shift();
    state.lastSource = source;

    return {
      accepted: true,
      pending: false,
      reason: 'accepted',
      bucket,
      observedStrideM: strideM,
      boundedSampleM,
      estimate: this.estimate(
        bucket === CADENCE_BUCKET.SLOW
          ? 140
          : bucket === CADENCE_BUCKET.NORMAL ? 165 : 190,
      ),
    };
  }

  /**
   * 生成可写入 wx storage 的小型派生模型；不包含 GPS 坐标或原始传感器值。
   */
  serialize() {
    const bins = {};
    BUCKET_NAMES.forEach((name) => {
      const state = this.bins[name];
      bins[name] = {
        emaM: state.emaM,
        effectiveSamples: state.effectiveSamples,
        acceptedWindows: state.acceptedWindows,
        recentM: state.recentM.slice(-MAX_RECENT_SAMPLES),
        lastSource: state.lastSource,
      };
    });
    return {
      version: ADAPTIVE_STRIDE_VERSION,
      ownerMarker: this.ownerMarker,
      manualStepLengthM: this.manualStepLengthM,
      bins,
    };
  }

  /**
   * 从 storage 对象或 JSON 字符串恢复。版本、owner marker 或任一关键字段
   * 异常时 fail closed，返回只含人工先验的新模型。
   */
  static restore(payload, options = {}) {
    const raw = safeParsePayload(payload);
    const fresh = new AdaptiveStrideModel(options);
    if (!raw) {
      fresh.restoreStatus = 'fresh_invalid';
      return fresh;
    }
    if (raw.version !== ADAPTIVE_STRIDE_VERSION) {
      fresh.restoreStatus = 'fresh_version_mismatch';
      return fresh;
    }

    const persistedOwner = normalizeOwnerMarker(raw.ownerMarker);
    const requestedOwner = Object.prototype.hasOwnProperty.call(options, 'ownerMarker')
      ? normalizeOwnerMarker(options.ownerMarker)
      : persistedOwner;
    if (persistedOwner !== requestedOwner) {
      fresh.restoreStatus = 'fresh_owner_mismatch';
      return fresh;
    }

    const manualStepLengthM = finiteInRange(
      options.manualStepLengthM,
      fresh.minStrideM,
      fresh.maxStrideM,
    )
      ? options.manualStepLengthM
      : raw.manualStepLengthM;
    if (!finiteInRange(manualStepLengthM, fresh.minStrideM, fresh.maxStrideM)
        || !raw.bins
        || typeof raw.bins !== 'object'
        || Array.isArray(raw.bins)) {
      fresh.restoreStatus = 'fresh_invalid';
      return fresh;
    }

    const restoredBins = newBins();
    const personalizedMinM = Math.max(
      fresh.minStrideM,
      manualStepLengthM - fresh.maxPersonalizationDeltaM,
    );
    const personalizedMaxM = Math.min(
      fresh.maxStrideM,
      manualStepLengthM + fresh.maxPersonalizationDeltaM,
    );
    for (const name of BUCKET_NAMES) {
      const value = raw.bins[name];
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fresh.restoreStatus = 'fresh_invalid';
        return fresh;
      }
      const emaM = value.emaM;
      const effectiveSamples = value.effectiveSamples;
      const acceptedWindows = value.acceptedWindows;
      const recentM = value.recentM;
      const lastSource = normalizeSource(value.lastSource);
      if (!finiteInRange(emaM, fresh.minStrideM, fresh.maxStrideM)
          || !finiteInRange(effectiveSamples, 0, 1000)
          || !Number.isInteger(acceptedWindows)
          || acceptedWindows < 0
          || acceptedWindows > 1000000
          || !Array.isArray(recentM)
          || recentM.length > MAX_RECENT_SAMPLES
          || recentM.some((sample) => !finiteInRange(
            sample,
            fresh.minStrideM,
            fresh.maxStrideM,
          ))
          || (emaM != null && !finiteInRange(
            emaM,
            personalizedMinM,
            personalizedMaxM,
          ))
          || recentM.some((sample) => !finiteInRange(
            sample,
            personalizedMinM,
            personalizedMaxM,
          ))
          || (value.lastSource != null && !lastSource)) {
        // 从未学习的空桶允许 emaM=null。
        const emptyBin = emaM == null
          && effectiveSamples === 0
          && acceptedWindows === 0
          && Array.isArray(recentM)
          && recentM.length === 0
          && value.lastSource == null;
        if (!emptyBin) {
          fresh.restoreStatus = 'fresh_invalid';
          return fresh;
        }
      }
      if (emaM != null) {
        restoredBins[name] = {
          emaM,
          effectiveSamples,
          acceptedWindows,
          recentM: recentM.slice(),
          lastSource,
        };
      }
    }

    fresh.manualStepLengthM = manualStepLengthM;
    fresh.ownerMarker = requestedOwner;
    fresh.bins = restoredBins;
    fresh.restoreStatus = 'restored';
    return fresh;
  }
}
