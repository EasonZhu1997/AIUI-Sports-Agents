// 眼镜 IMU 先输出“头部仍在运动/已长时间静止”，并在多轴周期、采样质量和
// 连续稳定门都通过后给出明确标记的踏频/固定 rollout 速度估算。它不能观测
// 真实曲柄相位、换挡、滑行轮速或车辆位移，因此绝不输出功率或距离。

const DEFAULT_GRAVITY_TAU_MS = 750;
const DEFAULT_SCORE_TAU_MS = 300;
const DEFAULT_MOTION_THRESHOLD = 0.18;
const DEFAULT_STILL_THRESHOLD = 0.07;
const DEFAULT_MOVING_CONFIRM_MS = 600;
const DEFAULT_STATIONARY_CONFIRM_MS = 1500;
const DEFAULT_AUTO_PAUSE_AFTER_MS = 5000;
const DEFAULT_AUTO_RESUME_AFTER_MS = 800;
const DEFAULT_STALE_MS = 1500;
const DEFAULT_SAMPLE_HZ = 25;
const DEFAULT_CADENCE_WINDOW_MS = 12000;
const DEFAULT_CADENCE_ANALYSIS_INTERVAL_MS = 1000;
// Dense Generic Sensor windows may contain hundreds of entries. Keep one
// second of bounded slack and compact them in a batch instead of shifting and
// re-indexing the whole array for every raw callback.
const DEFAULT_SAMPLE_WINDOW_COMPACTION_SLACK_MS = 1000;
const DEFAULT_ACCEL_CALIBRATION_ANALYSIS_INTERVAL_MS = 200;
// 最少 2.2 秒与三周期门已经限制分析跨度；12 帧可让 AIUI 0.15 的
// 5.5–6Hz 真机流在 1 秒分析节流下仍于约 3–5 秒形成连续候选。
const DEFAULT_CADENCE_MIN_SAMPLES = 12;
const DEFAULT_MIN_CADENCE_RPM = 24;
const DEFAULT_MAX_CADENCE_RPM = 150;
const DEFAULT_MIN_CADENCE_CYCLES = 3;
// 旧链路 500ms 分析时用三窗（首尾约 1 秒）确认；整窗降到 1000ms 后两窗
// 已提供相同确认时长，避免为了凑固定次数把强周期拖出 5 秒。
const DEFAULT_CADENCE_STABLE_WINDOWS = 2;
const DEFAULT_CADENCE_MIN_CONFIDENCE = 0.68;
const DEFAULT_CADENCE_MIN_CORRELATION = 0.68;
const DEFAULT_CADENCE_MIN_AMPLITUDE_MPS2 = 0.02;
// AIUI Craft 0.15 的 frequency 只是 best-effort。20Hz 是已经在真机成功
// 出数的请求值；算法仍完全按 reading 的真实 timestamp/实测 Hz 计算。
const DEFAULT_GYROSCOPE_SAMPLE_HZ = 20;
const DEFAULT_CADENCE_MIN_AMPLITUDE_GYRO_RADS = 0.012;
const DEFAULT_CADENCE_CANDIDATE_MAX_AGE_MS = 3000;
const DEFAULT_PROVISIONAL_CADENCE_HOLD_MS = 8000;
const DEFAULT_SIMPLE_GYRO_WINDOW_MS = 4500;
const DEFAULT_SIMPLE_GYRO_MIN_SPAN_MS = 2200;
const DEFAULT_SIMPLE_GYRO_MIN_SAMPLES = 12;
const DEFAULT_SIMPLE_GYRO_MIN_RMS = 0.0025;
const DEFAULT_SIMPLE_GYRO_ANALYSIS_INTERVAL_MS = 1000;
// 真机骑行会连续被质量门标为 road_impact/head_turn。保持窗口恢复到曾经
// 成功出数版本的 6 秒；touch 和明确 stationary 仍会立即清除，不会盲目续算。
const DEFAULT_SIMPLE_GYRO_HOLD_MS = 6000;
const DEFAULT_SIMPLE_GYRO_CANDIDATE_HOLD_MS = 1600;
// HUD 候选只需短时保鲜；重锁证据必须跨过至少两个 1Hz 分析窗，因此单独
// 保留约 3.5 秒。不能复用 candidate hold，否则三窗/跨窗证据天然不可达。
const DEFAULT_SIMPLE_GYRO_RELOCK_HISTORY_MS = 3500;
// 历史可信高频锁只为“倍频向基频”纠错保留一个有界授权窗。它比 HUD
// freshness 长，足以覆盖低帧率整窗换频；静止、touch、会话 reset 会清零。
const DEFAULT_SIMPLE_GYRO_DOWNWARD_RELOCK_ANCHOR_MS = 15000;
const DEFAULT_SIMPLE_GYRO_CONFIRM_INTERVAL_MS = 350;
const DEFAULT_SIMPLE_GYRO_CANDIDATE_CONFIDENCE = 0.6;
const DEFAULT_SIMPLE_GYRO_FINAL_CONFIDENCE = 0.65;
const DEFAULT_SIMPLE_GYRO_FALLBACK_DELAY_MS = 2800;
const DEFAULT_SIMPLE_GYRO_FALLBACK_CONFIRM_MS = 500;
const DEFAULT_SIMPLE_GYRO_FALLBACK_CONFIDENCE = 0.58;
const DEFAULT_SIMPLE_GYRO_FALLBACK_FINAL_CONFIDENCE = 0.62;
const DEFAULT_SIMPLE_GYRO_EMA_TAU_MS = 800;
const DEFAULT_SIMPLE_GYRO_LEDGER_HOLD_MS = 1800;
const DEFAULT_SIMPLE_GYRO_TOUCH_DISPLAY_HOLD_MS = 1800;
const DEFAULT_SIMPLE_GYRO_MIN_RPM = 45;
const DEFAULT_SIMPLE_GYRO_MAX_RPM = 130;
// AR 录屏时 AIUI 0.15 的 Gyroscope 回调常降到个位数或十余帧。这个范围
// 必须按 reading 的真实 timestamp 识别，不能按构造器请求的 frequency 猜测。
const DEFAULT_LOW_RATE_GYRO_MIN_HZ = 5.25;
const DEFAULT_LOW_RATE_GYRO_MAX_HZ = 14.75;
const DEFAULT_LOW_RATE_GYRO_MIN_SPAN_MS = 3000;
const DEFAULT_LOW_RATE_GYRO_MIN_SAMPLES = 18;
const DEFAULT_METERS_PER_CRANK = DEFAULT_IMU_METERS_PER_CRANK;
const DEFAULT_MIN_EFFECTIVE_SAMPLE_HZ = 5;
const DEFAULT_MAX_EFFECTIVE_SAMPLE_HZ = 60;
const STANDARD_GRAVITY_MPS2 = 9.80665;
const SENSOR_TIMESTAMP_SCALES_TO_MS = [1, 1000, 0.001, 0.000001];

export const ACCELERATION_SOURCE_UNIT = Object.freeze({
  UNKNOWN: 'unknown',
  STANDARD_GRAVITY: 'g',
  METERS_PER_SECOND_SQUARED: 'm/s2',
});

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function vectorLength(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

function trimTimedSamplesInPlace(samples, cutoffMs) {
  if (!Array.isArray(samples) || !samples.length
      || !Number.isFinite(cutoffMs)
      || samples[0].timestampMs >= cutoffMs) return 0;
  let keepFrom = 0;
  while (keepFrom < samples.length
      && samples[keepFrom].timestampMs < cutoffMs) {
    keepFrom += 1;
  }
  if (keepFrom > 0) samples.splice(0, keepFrom);
  return keepFrom;
}

// 整窗频谱/自相关前只做一次无分配的近期能量检查。Welford 方差会去掉
// Gyroscope 的静态偏置；静止或低能量帧因此不会反复进入排序、重采样和
// 多 lag 扫描。真正的周期门仍使用完整窗口，不靠这个快速门直接出数。
function recentMaxAxisRms(samples, nowMs, windowMs) {
  if (!Array.isArray(samples) || samples.length < 4
      || !Number.isFinite(nowMs) || !(windowMs > 0)) return 0;
  const cutoff = nowMs - windowMs;
  let count = 0;
  let meanX = 0;
  let meanY = 0;
  let meanZ = 0;
  let momentX = 0;
  let momentY = 0;
  let momentZ = 0;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index];
    if (!sample || sample.timestampMs < cutoff) break;
    if (!Number.isFinite(sample.x)
        || !Number.isFinite(sample.y)
        || !Number.isFinite(sample.z)) continue;
    count += 1;
    const deltaX = sample.x - meanX;
    const deltaY = sample.y - meanY;
    const deltaZ = sample.z - meanZ;
    meanX += deltaX / count;
    meanY += deltaY / count;
    meanZ += deltaZ / count;
    momentX += deltaX * (sample.x - meanX);
    momentY += deltaY * (sample.y - meanY);
    momentZ += deltaZ * (sample.z - meanZ);
  }
  if (count < 4) return 0;
  return Math.sqrt(Math.max(momentX, momentY, momentZ, 0) / count);
}

function finiteSensorTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizedAutocorrelation(values, lag) {
  const count = values.length - lag;
  if (!(lag > 0) || count < 8) return null;
  let leftMean = 0;
  let rightMean = 0;
  for (let index = 0; index < count; index += 1) {
    leftMean += values[index];
    rightMean += values[index + lag];
  }
  leftMean /= count;
  rightMean /= count;

  let covariance = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let index = 0; index < count; index += 1) {
    const left = values[index] - leftMean;
    const right = values[index + lag] - rightMean;
    covariance += left * right;
    leftEnergy += left * left;
    rightEnergy += right * right;
  }
  const denominator = Math.sqrt(leftEnergy * rightEnergy);
  return denominator > 1e-9 ? covariance / denominator : null;
}

function robustAxis(values) {
  if (!values.length) return null;
  const center = median(values);
  const absoluteDeviations = values.map((value) => Math.abs(value - center));
  const mad = median(absoluteDeviations) || 0;
  const limit = Math.max(0.03, mad * 4.5);
  const clipped = values.map((value) => clamp(value, center - limit, center + limit));
  const mean = clipped.reduce((sum, value) => sum + value, 0) / clipped.length;
  const centered = clipped.map((value) => value - mean);
  const rms = Math.sqrt(
    centered.reduce((sum, value) => sum + value * value, 0) / centered.length,
  );
  return { values: centered, rms };
}

function robustDetrendedAxis(values, timestampsMs) {
  const robust = robustAxis(values);
  if (!robust || robust.values.length !== timestampsMs.length) return null;
  const centerAt = (timestampsMs[0] + timestampsMs[timestampsMs.length - 1]) / 2;
  const timeSeconds = timestampsMs.map((timestampMs) => (
    (timestampMs - centerAt) / 1000
  ));
  let timeEnergy = 0;
  let timeValue = 0;
  for (let index = 0; index < robust.values.length; index += 1) {
    timeEnergy += timeSeconds[index] * timeSeconds[index];
    timeValue += timeSeconds[index] * robust.values[index];
  }
  const slope = timeEnergy > 1e-9 ? timeValue / timeEnergy : 0;
  const detrended = robust.values.map(
    (value, index) => value - slope * timeSeconds[index],
  );
  const mean = detrended.reduce((sum, value) => sum + value, 0)
    / detrended.length;
  const centered = detrended.map((value) => value - mean);
  const rms = Math.sqrt(
    centered.reduce((sum, value) => sum + value * value, 0)
      / centered.length,
  );
  return { values: centered, rms };
}

function resampleSimpleGyroscopeWindow(samples, targetHz) {
  if (!samples.length || !(targetHz > 0)) return [];
  const firstAt = samples[0].timestampMs;
  const lastAt = samples[samples.length - 1].timestampMs;
  const intervalMs = 1000 / targetHz;
  const output = [];
  let rightIndex = 1;
  for (let timestampMs = firstAt;
    timestampMs <= lastAt + intervalMs * 0.2;
    timestampMs += intervalMs) {
    while (rightIndex < samples.length - 1
        && samples[rightIndex].timestampMs < timestampMs) {
      rightIndex += 1;
    }
    const right = samples[rightIndex];
    const left = samples[Math.max(0, rightIndex - 1)];
    if (!left || !right) break;
    const spanMs = right.timestampMs - left.timestampMs;
    const ratio = spanMs > 0
      ? clamp((timestampMs - left.timestampMs) / spanMs, 0, 1)
      : 0;
    output.push({
      timestampMs,
      x: left.x + (right.x - left.x) * ratio,
      y: left.y + (right.y - left.y) * ratio,
      z: left.z + (right.z - left.z) * ratio,
    });
  }
  return output;
}

function principalAxisProjection(axes) {
  if (!axes.length || !axes[0].values.length) return null;
  const length = axes[0].values.length;
  const covariance = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const available = axes.slice(0, 3);
  while (available.length < 3) {
    available.push({
      values: Array.from({ length }, () => 0),
      rms: 0,
    });
  }
  for (let row = 0; row < 3; row += 1) {
    for (let column = row; column < 3; column += 1) {
      let sum = 0;
      for (let index = 0; index < length; index += 1) {
        sum += available[row].values[index] * available[column].values[index];
      }
      covariance[row][column] = sum / length;
      covariance[column][row] = covariance[row][column];
    }
  }
  let vector = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const next = covariance.map((row) => (
      row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2]
    ));
    const norm = Math.hypot(...next);
    if (!(norm > 1e-9)) break;
    vector = next.map((value) => value / norm);
  }
  const values = Array.from({ length }, (_, index) => (
    available[0].values[index] * vector[0]
      + available[1].values[index] * vector[1]
      + available[2].values[index] * vector[2]
  ));
  const rms = Math.sqrt(
    values.reduce((sum, value) => sum + value * value, 0) / values.length,
  );
  const trace = covariance[0][0] + covariance[1][1] + covariance[2][2];
  const eigenvalue = vector.reduce((sum, value, row) => (
    sum + value * (
      covariance[row][0] * vector[0]
        + covariance[row][1] * vector[1]
        + covariance[row][2] * vector[2]
    )
  ), 0);
  return {
    values,
    rms,
    dominance: trace > 1e-9 ? clamp(eigenvalue / trace, 0, 1) : 0,
  };
}

function sinusoidFitPower(values, timestampsMs, rpm) {
  if (!values.length || values.length !== timestampsMs.length || !(rpm > 0)) {
    return 0;
  }
  const firstAt = timestampsMs[0];
  const angularFrequency = 2 * Math.PI * rpm / 60;
  let weightSum = 0;
  let weightedMean = 0;
  for (let index = 0; index < values.length; index += 1) {
    const weight = values.length > 1
      ? 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (values.length - 1))
      : 1;
    weightSum += weight;
    weightedMean += weight * values[index];
  }
  if (!(weightSum > 0)) return 0;
  weightedMean /= weightSum;

  let ss = 0;
  let cc = 0;
  let sc = 0;
  let ys = 0;
  let yc = 0;
  let energy = 0;
  for (let index = 0; index < values.length; index += 1) {
    const seconds = (timestampsMs[index] - firstAt) / 1000;
    const sine = Math.sin(angularFrequency * seconds);
    const cosine = Math.cos(angularFrequency * seconds);
    const weight = values.length > 1
      ? 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (values.length - 1))
      : 1;
    const value = values[index] - weightedMean;
    ss += weight * sine * sine;
    cc += weight * cosine * cosine;
    sc += weight * sine * cosine;
    ys += weight * value * sine;
    yc += weight * value * cosine;
    energy += weight * value * value;
  }
  const determinant = ss * cc - sc * sc;
  if (!(determinant > 1e-9) || !(energy > 1e-9)) return 0;
  const sineAmplitude = (ys * cc - yc * sc) / determinant;
  const cosineAmplitude = (yc * ss - ys * sc) / determinant;
  const explained = sineAmplitude * ys + cosineAmplitude * yc;
  return clamp(explained / energy, 0, 1);
}

function combinedSpectralPower(axes, timestampsMs, rpm) {
  const active = axes.filter((axis) => axis && axis.rms > 1e-9);
  if (!active.length) return 0;
  const totalEnergy = active.reduce(
    (sum, axis) => sum + axis.rms * axis.rms,
    0,
  );
  const powers = active.map((axis) => ({
    power: sinusoidFitPower(axis.values, timestampsMs, rpm),
    weight: axis.rms * axis.rms / Math.max(totalEnergy, 1e-9),
  }));
  const weighted = powers.reduce(
    (sum, item) => sum + item.power * item.weight,
    0,
  );
  const strongest = Math.max(...powers.map((item) => item.power));
  return clamp(weighted * 0.72 + strongest * 0.28, 0, 1);
}

function fractionalAutocorrelation(values, lag) {
  if (!(lag > 0) || values.length < 10) return null;
  const maxIndex = Math.floor(values.length - 1 - lag);
  if (maxIndex < 7) return null;
  const count = maxIndex + 1;
  let leftMean = 0;
  let rightMean = 0;
  const rightValues = [];
  for (let index = 0; index < count; index += 1) {
    const target = index + lag;
    const lower = Math.floor(target);
    const upper = Math.min(values.length - 1, lower + 1);
    const alpha = target - lower;
    const right = values[lower] + (values[upper] - values[lower]) * alpha;
    rightValues.push(right);
    leftMean += values[index];
    rightMean += right;
  }
  leftMean /= count;
  rightMean /= count;
  let covariance = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let index = 0; index < count; index += 1) {
    const left = values[index] - leftMean;
    const right = rightValues[index] - rightMean;
    covariance += left * right;
    leftEnergy += left * left;
    rightEnergy += right * right;
  }
  const denominator = Math.sqrt(leftEnergy * rightEnergy);
  return denominator > 1e-9 ? covariance / denominator : null;
}

function interpolatedCrossingCadence(values, timestampsMs, options) {
  if (values.length < 8 || values.length !== timestampsMs.length) return null;
  const rms = Math.sqrt(
    values.reduce((sum, value) => sum + value * value, 0) / values.length,
  );
  const hysteresis = Math.max(options.minRms * 0.32, rms * 0.1);
  const crossings = [];
  let armed = false;
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const value = values[index];
    if (value <= -hysteresis) armed = true;
    if (armed && previous < hysteresis && value >= hysteresis) {
      const span = value - previous;
      const alpha = Math.abs(span) > 1e-9
        ? clamp((hysteresis - previous) / span, 0, 1)
        : 1;
      crossings.push(
        timestampsMs[index - 1]
          + (timestampsMs[index] - timestampsMs[index - 1]) * alpha,
      );
      armed = false;
    }
  }
  const minPeriodMs = 60000 / options.maxRpm;
  const maxPeriodMs = 60000 / options.minRpm;
  const intervals = [];
  for (let index = 1; index < crossings.length; index += 1) {
    const intervalMs = crossings[index] - crossings[index - 1];
    if (intervalMs >= minPeriodMs && intervalMs <= maxPeriodMs) {
      intervals.push(intervalMs);
    }
  }
  if (intervals.length < 2) return null;
  const periodMs = median(intervals);
  const spread = median(
    intervals.map((value) => Math.abs(value - periodMs)),
  ) || 0;
  const rpm = 60000 / periodMs;
  if (!(rpm >= options.minRpm && rpm <= options.maxRpm)) return null;
  return {
    rpm,
    consistency: clamp(1 - (spread / periodMs) / 0.36, 0, 1),
    intervalCount: intervals.length,
  };
}

function nearestHarmonic(value, reference, minRpm, maxRpm) {
  if (!(value > 0) || !(reference > 0)) return value;
  const candidates = [value, value / 2, value * 2]
    .filter((candidate) => candidate >= minRpm && candidate <= maxRpm);
  candidates.sort((left, right) => (
    Math.abs(Math.log(left / reference))
      - Math.abs(Math.log(right / reference))
  ));
  return candidates[0] ?? value;
}

function measuredGyroscopeSampleHz(samples) {
  const deltas = positiveTimestampDeltas(samples);
  const center = median(deltas);
  if (!(center > 0)) return null;
  // 偶发丢帧会产生 2x/3x 间隔，但不应把真实 8Hz 误判成 4Hz。只用中心
  // 附近的间隔估计设备当前回调率，周期计算本身仍保留每个真实 timestamp。
  const inliers = deltas.filter(
    (deltaMs) => deltaMs >= center * 0.45 && deltaMs <= center * 2.4,
  );
  const intervalMs = median(inliers.length ? inliers : deltas);
  return intervalMs > 0 ? 1000 / intervalMs : null;
}

/**
 * AIUI 0.15 低帧率 Gyroscope 专用踏频估算。
 *
 * 仅当实测 timestamp 表明回调约为 6–14Hz 时启用。它不套用计步峰值：
 * 直接在不均匀的真实时间轴上拟合骑行踏频范围内的连续正弦频率，并要求前后
 * 半窗、分数 lag 自相关和插值过零相互印证。宽松候选可以用于诊断，但只有
 * 完整时域共识才带 finalEligible，首次锁定不会被 ACF 单独绕过。
 */
export function estimateLowRateGyroscopeCadence(samplesInput, options = {}) {
  if (!Array.isArray(samplesInput)) return null;
  const minSampleHz = finite(
    options.minSampleHz,
    DEFAULT_LOW_RATE_GYRO_MIN_HZ,
  );
  const maxSampleHz = Math.max(
    minSampleHz + 1,
    finite(options.maxSampleHz, DEFAULT_LOW_RATE_GYRO_MAX_HZ),
  );
  const minSpanMs = Math.max(
    2600,
    finite(options.minSpanMs, DEFAULT_LOW_RATE_GYRO_MIN_SPAN_MS),
  );
  const minSamples = Math.max(
    16,
    Math.round(finite(options.minSamples, DEFAULT_LOW_RATE_GYRO_MIN_SAMPLES)),
  );
  const windowMs = Math.max(
    minSpanMs,
    finite(options.windowMs, DEFAULT_SIMPLE_GYRO_WINDOW_MS),
  );
  const minRms = Math.max(
    0.001,
    finite(options.minRms, DEFAULT_SIMPLE_GYRO_MIN_RMS),
  );
  const minRpm = clamp(
    finite(options.minRpm, DEFAULT_SIMPLE_GYRO_MIN_RPM),
    30,
    80,
  );
  const maxRpm = Math.max(
    minRpm + 20,
    finite(options.maxRpm, DEFAULT_SIMPLE_GYRO_MAX_RPM),
  );
  const sortedSamples = samplesInput
    .filter((sample) => sample
      && [sample.timestampMs, sample.x, sample.y, sample.z]
        .every(Number.isFinite))
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const finiteSamples = [];
  for (const sample of sortedSamples) {
    const previous = finiteSamples[finiteSamples.length - 1];
    if (previous && sample.timestampMs === previous.timestampMs) {
      finiteSamples[finiteSamples.length - 1] = sample;
    } else {
      finiteSamples.push(sample);
    }
  }
  if (finiteSamples.length < minSamples) return null;
  const lastAt = finiteSamples[finiteSamples.length - 1].timestampMs;
  let samples = finiteSamples.filter(
    (sample) => sample.timestampMs >= lastAt - windowMs,
  );
  if (samples.length < minSamples) return null;

  let effectiveSampleHz = measuredGyroscopeSampleHz(samples);
  if (!(effectiveSampleHz >= minSampleHz && effectiveSampleHz <= maxSampleHz)) {
    return null;
  }
  let deltas = positiveTimestampDeltas(samples);
  let medianIntervalMs = median(deltas);
  if (!(medianIntervalMs > 0)) return null;
  // 录屏 bridge 的短抖动和一次丢帧保留；接近一秒的真实断流必须重新起窗，
  // 防止把断流前后两个无关动作拼成周期。
  const continuousGapMs = Math.max(850, medianIntervalMs * 4.5);
  let continuousStart = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].timestampMs - samples[index - 1].timestampMs
        > continuousGapMs) {
      continuousStart = index;
    }
  }
  if (continuousStart > 0) samples = samples.slice(continuousStart);
  if (samples.length < minSamples) return null;
  effectiveSampleHz = measuredGyroscopeSampleHz(samples);
  if (!(effectiveSampleHz >= minSampleHz && effectiveSampleHz <= maxSampleHz)) {
    return null;
  }
  deltas = positiveTimestampDeltas(samples);
  medianIntervalMs = median(deltas);
  const firstAt = samples[0].timestampMs;
  const spanMs = samples[samples.length - 1].timestampMs - firstAt;
  if (!(medianIntervalMs > 0) || spanMs < minSpanMs) return null;
  const expectedIntervals = spanMs / medianIntervalMs;
  const coverage = clamp(
    deltas.length / Math.max(1, expectedIntervals),
    0,
    1,
  );
  if (coverage < 0.58) return null;

  const timestampsMs = samples.map((sample) => sample.timestampMs);
  const axes = ['x', 'y', 'z']
    .map((key) => ({
      key,
      ...robustDetrendedAxis(
        samples.map((sample) => sample[key]),
        timestampsMs,
      ),
    }))
    .filter((axis) => axis && axis.rms >= minRms)
    .sort((left, right) => right.rms - left.rms);
  if (!axes.length) return null;
  const principal = principalAxisProjection(axes);
  if (!principal || principal.rms < minRms) return null;

  // 直接用真实毫秒拟合，不把 6–14Hz 样本先量化到整数 lag。
  const evaluated = new Map();
  const powerAt = (rpm) => {
    const bounded = clamp(rpm, minRpm, maxRpm);
    const key = bounded.toFixed(3);
    if (!evaluated.has(key)) {
      evaluated.set(key, combinedSpectralPower(axes, timestampsMs, bounded));
    }
    return evaluated.get(key);
  };
  let best = null;
  for (let rpm = minRpm; rpm <= maxRpm + 1e-6; rpm += 1) {
    const score = powerAt(rpm);
    if (!best || score > best.score) best = { rpm, score };
  }
  if (!best) return null;
  const coarseRpm = best.rpm;
  for (let rpm = Math.max(minRpm, coarseRpm - 3);
    rpm <= Math.min(maxRpm, coarseRpm + 3) + 1e-6;
    rpm += 0.1) {
    const score = powerAt(rpm);
    if (score > best.score) best = { rpm, score };
  }
  if (best.score < 0.34) return null;

  const uniformSamples = resampleSimpleGyroscopeWindow(
    samples,
    effectiveSampleHz,
  );
  const uniformTimestampsMs = uniformSamples.map(
    (sample) => sample.timestampMs,
  );
  const uniformAxes = ['x', 'y', 'z']
    .map((key) => robustDetrendedAxis(
      uniformSamples.map((sample) => sample[key]),
      uniformTimestampsMs,
    ))
    .filter((axis) => axis && axis.rms >= minRms);
  const uniformPrincipal = principalAxisProjection(uniformAxes);
  const principalAutocorrelation = (rpm) => uniformPrincipal
    ? fractionalAutocorrelation(
      uniformPrincipal.values,
      effectiveSampleHz * 60 / rpm,
    )
    : null;
  let selectedRpm = best.rpm;
  let selectedPower = best.score;
  let harmonicCorrected = false;
  let harmonicHalfPowerRatio = 0;
  const halfRpm = best.rpm / 2;
  if (halfRpm >= minRpm) {
    const halfPower = powerAt(halfRpm);
    harmonicHalfPowerRatio = halfPower / Math.max(best.score, 1e-9);
    const bestCorrelation = principalAutocorrelation(best.rpm);
    const halfCorrelation = principalAutocorrelation(halfRpm);
    const halfCycles = spanMs * halfRpm / 60000;
    if (harmonicHalfPowerRatio >= 0.06
        && Number.isFinite(halfCorrelation)
        && (!Number.isFinite(bestCorrelation)
          || halfCorrelation >= bestCorrelation - 0.12)
        && halfCycles >= 2) {
      selectedRpm = halfRpm;
      selectedPower = Math.max(halfPower, best.score * 0.72);
      harmonicCorrected = true;
    }
  }
  const periodicCorrelation = uniformPrincipal
    ? principalAutocorrelation(selectedRpm) : null;
  if (!Number.isFinite(periodicCorrelation) || periodicCorrelation < 0.22) {
    return null;
  }

  const crossing = interpolatedCrossingCadence(
    principal.values,
    timestampsMs,
    { minRms, minRpm, maxRpm },
  );
  const crossingRpm = crossing
    ? nearestHarmonic(crossing.rpm, selectedRpm, minRpm, maxRpm)
    : null;
  const crossingAgreement = crossingRpm != null
    ? clamp(
      1 - Math.abs(crossingRpm - selectedRpm)
        / Math.max(7, selectedRpm * 0.12),
      0,
      1,
    )
    : 0;

  const splitAtMs = firstAt + spanMs / 2;
  const earlyIndexes = [];
  const lateIndexes = [];
  for (let index = 0; index < timestampsMs.length; index += 1) {
    if (timestampsMs[index] <= splitAtMs + medianIntervalMs) {
      earlyIndexes.push(index);
    }
    if (timestampsMs[index] >= splitAtMs - medianIntervalMs) {
      lateIndexes.push(index);
    }
  }
  const splitPeak = (indexes) => {
    if (indexes.length < 8) return null;
    const splitTimes = indexes.map((index) => timestampsMs[index]);
    let peak = null;
    for (let rpm = minRpm; rpm <= maxRpm + 1e-6; rpm += 1) {
      const score = sinusoidFitPower(
        indexes.map((index) => principal.values[index]),
        splitTimes,
        rpm,
      );
      if (!peak || score > peak.score) peak = { rpm, score };
    }
    return peak;
  };
  const earlyPeak = splitPeak(earlyIndexes);
  const latePeak = splitPeak(lateIndexes);
  if (!earlyPeak || !latePeak) return null;
  const earlyRpm = nearestHarmonic(
    earlyPeak.rpm,
    selectedRpm,
    minRpm,
    maxRpm,
  );
  const lateRpm = nearestHarmonic(
    latePeak.rpm,
    selectedRpm,
    minRpm,
    maxRpm,
  );
  const splitToleranceRpm = Math.max(9, selectedRpm * 0.12);
  const earlyAgreement = clamp(
    1 - Math.abs(earlyRpm - selectedRpm) / splitToleranceRpm,
    0,
    1,
  );
  const lateAgreement = clamp(
    1 - Math.abs(lateRpm - selectedRpm) / splitToleranceRpm,
    0,
    1,
  );
  const splitAgreement = Math.min(earlyAgreement, lateAgreement);

  const sideExclusionRpm = Math.max(12, best.rpm * 0.15);
  const sidePowers = [...evaluated.entries()]
    .map(([rpm, score]) => ({ rpm: Number(rpm), score }))
    .filter((item) => Math.abs(item.rpm - best.rpm) >= sideExclusionRpm);
  const sidePower = sidePowers.length
    ? Math.max(...sidePowers.map((item) => item.score))
    : 0;
  const prominence = clamp(
    (best.score - sidePower) / Math.max(best.score, 1e-9),
    0,
    1,
  );
  const observedCycles = spanMs * selectedRpm / 60000;
  const cycleQuality = clamp((observedCycles - 2) / 2, 0, 1);
  const splitPower = Math.min(earlyPeak.score, latePeak.score);
  const confidence = clamp(
    selectedPower * 0.25
      + Math.max(0, periodicCorrelation) * 0.2
      + coverage * 0.12
      + splitAgreement * 0.15
      + splitPower * 0.1
      + crossingAgreement * 0.08
      + (crossing ? crossing.consistency : 0) * 0.05
      + prominence * 0.03
      + cycleQuality * 0.02,
    0,
    0.97,
  );
  if (confidence < 0.56) return null;

  const finalEligible = best.score >= 0.46
    && periodicCorrelation >= 0.48
    && splitPower >= 0.42
    && splitAgreement >= 0.42
    && prominence >= 0.08
    && observedCycles >= 2.5
    && crossing != null
    && crossing.intervalCount >= 2
    && crossing.consistency >= 0.52
    && crossingAgreement >= 0.48;
  return {
    rpm: selectedRpm,
    confidence,
    correlation: periodicCorrelation,
    coverage,
    effectiveSampleHz,
    source: 'gyroscope_simple',
    method: harmonicCorrected
      ? (finalEligible
        ? 'low_rate_timestamp_harmonic_consensus'
        : 'low_rate_timestamp_harmonic_candidate')
      : (finalEligible
        ? 'low_rate_timestamp_consensus'
        : 'low_rate_timestamp_candidate'),
    analysisState: finalEligible
      ? 'low_rate_ready'
      : 'low_rate_candidate',
    spectralPower: best.score,
    spectralProminence: prominence,
    harmonicHalfPowerRatio,
    splitAgreement,
    splitPower,
    crossingAgreement,
    observedCycles,
    finalEligible,
    evidenceAtMs: crossing && crossing.intervalCount >= 2
      ? samples[samples.length - 1].timestampMs : lastAt,
  };
}

/**
 * 简化的陀螺仪踏频估算。
 *
 * 它只回答一个问题：最近约 2.2–4.5 秒的角速度里，是否存在骑行踏频范围内
 * 的重复周期。先按真实时间切断长空档并重采样，再以稳健去趋势、PCA 主轴、
 * 时间域正弦拟合、分数 lag 自相关和插值过零共同估计。这里不依赖
 * Accelerometer 才能显示，但不会再让单个整数 lag 或最强单轴直接决定踏频。
 */
export function estimateSimpleGyroscopeCadence(samplesInput, options = {}) {
  if (!Array.isArray(samplesInput)) return null;
  const windowMs = Math.max(
    DEFAULT_SIMPLE_GYRO_MIN_SPAN_MS,
    finite(options.windowMs, DEFAULT_SIMPLE_GYRO_WINDOW_MS),
  );
  const minSpanMs = Math.max(
    1500,
    finite(options.minSpanMs, DEFAULT_SIMPLE_GYRO_MIN_SPAN_MS),
  );
  const minSamples = Math.max(
    8,
    Math.round(finite(options.minSamples, DEFAULT_SIMPLE_GYRO_MIN_SAMPLES)),
  );
  const minRms = Math.max(
    0.001,
    finite(options.minRms, DEFAULT_SIMPLE_GYRO_MIN_RMS),
  );
  const minRpm = clamp(
    finite(options.minRpm, DEFAULT_SIMPLE_GYRO_MIN_RPM),
    30,
    80,
  );
  const maxRpm = Math.max(
    minRpm + 20,
    finite(options.maxRpm, DEFAULT_SIMPLE_GYRO_MAX_RPM),
  );
  const sortedSamples = samplesInput
    .filter((sample) => sample
      && [sample.timestampMs, sample.x, sample.y, sample.z]
        .every(Number.isFinite))
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const finiteSamples = [];
  for (const sample of sortedSamples) {
    const previous = finiteSamples[finiteSamples.length - 1];
    if (previous && sample.timestampMs === previous.timestampMs) {
      finiteSamples[finiteSamples.length - 1] = sample;
    } else {
      finiteSamples.push(sample);
    }
  }
  if (finiteSamples.length < minSamples) return null;
  const lastAt = finiteSamples[finiteSamples.length - 1].timestampMs;
  const cutoff = lastAt - windowMs;
  let samples = finiteSamples.filter((sample) => sample.timestampMs >= cutoff);
  if (samples.length < minSamples) return null;

  let deltas = positiveTimestampDeltas(samples);
  let medianIntervalMs = median(deltas);
  if (!(medianIntervalMs > 0)) return null;
  // AR 录屏会让 bridge 偶发停顿数百毫秒。短停顿保留同一分析窗，
  // 超过 1.2 秒才重新起窗；所有周期仍按真实 timestamp 计算。
  const continuousGapMs = Math.max(1200, medianIntervalMs * 8);
  let continuousStart = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].timestampMs - samples[index - 1].timestampMs
        > continuousGapMs) {
      continuousStart = index;
    }
  }
  if (continuousStart > 0) samples = samples.slice(continuousStart);
  if (samples.length < minSamples) return null;
  deltas = positiveTimestampDeltas(samples);
  medianIntervalMs = median(deltas);
  if (!(medianIntervalMs > 0)) return null;
  const spanMs = samples[samples.length - 1].timestampMs - samples[0].timestampMs;
  if (spanMs < minSpanMs) return null;

  const effectiveSampleHz = 1000 / medianIntervalMs;
  if (effectiveSampleHz < 4 || effectiveSampleHz > 80) return null;
  const expectedIntervals = spanMs / medianIntervalMs;
  const coverage = clamp(
    deltas.length / Math.max(1, expectedIntervals),
    0,
    1,
  );
  if (coverage < 0.5) return null;

  const recentCutoff = lastAt - Math.max(700, medianIntervalMs * 4);
  const recentSamples = samples.filter(
    (sample) => sample.timestampMs >= recentCutoff,
  );
  const recentRms = ['x', 'y', 'z'].reduce((strongest, key) => {
    const axis = robustAxis(recentSamples.map((sample) => sample[key]));
    return Math.max(strongest, axis ? axis.rms : 0);
  }, 0);
  if (recentRms < minRms * 0.75) return null;

  const analysisSampleHz = Math.min(30, effectiveSampleHz);
  const uniformSamples = resampleSimpleGyroscopeWindow(
    samples,
    analysisSampleHz,
  );
  if (uniformSamples.length < minSamples) return null;
  const timestampsMs = uniformSamples.map((sample) => sample.timestampMs);
  const axes = ['x', 'y', 'z']
    .map((key) => ({
      key,
      ...robustDetrendedAxis(
        uniformSamples.map((sample) => sample[key]),
        timestampsMs,
      ),
    }))
    .filter((axis) => axis && axis.rms >= minRms)
    .sort((left, right) => right.rms - left.rms);
  if (!axes.length) return null;
  const principal = principalAxisProjection(axes);
  if (!principal || principal.rms < minRms) return null;

  const maxSpectralRpm = Math.min(
    maxRpm,
    analysisSampleHz * 30 * 0.94,
  );
  if (maxSpectralRpm < minRpm) return null;
  const evaluated = new Map();
  const powerAt = (rpm) => {
    const bounded = clamp(rpm, minRpm, maxSpectralRpm);
    const key = bounded.toFixed(3);
    if (!evaluated.has(key)) {
      evaluated.set(
        key,
        combinedSpectralPower(axes, timestampsMs, bounded),
      );
    }
    return evaluated.get(key);
  };
  let best = null;
  for (let rpm = minRpm; rpm <= maxSpectralRpm + 1e-6; rpm += 2) {
    const score = powerAt(rpm);
    if (!best || score > best.score) best = { rpm, score };
  }
  if (!best) return null;
  const coarseBest = best;
  for (let rpm = Math.max(minRpm, coarseBest.rpm - 4);
    rpm <= Math.min(maxSpectralRpm, coarseBest.rpm + 4) + 1e-6;
    rpm += 0.25) {
    const score = powerAt(rpm);
    if (score > best.score) best = { rpm, score };
  }
  if (best.score < 0.28) return null;

  const principalAutocorrelation = (rpm) => fractionalAutocorrelation(
    principal.values,
    analysisSampleHz * 60 / rpm,
  );
  let selectedRpm = best.rpm;
  let selectedPower = best.score;
  let harmonicCorrected = false;
  let harmonicHalfPowerRatio = 0;
  const halfRpm = best.rpm / 2;
  if (halfRpm >= minRpm) {
    const halfPower = powerAt(halfRpm);
    harmonicHalfPowerRatio = halfPower / Math.max(best.score, 1e-9);
    const bestCorrelation = principalAutocorrelation(best.rpm);
    const halfCorrelation = principalAutocorrelation(halfRpm);
    const halfCycles = spanMs * halfRpm / 60000;
    if (harmonicHalfPowerRatio >= 0.06
        && Number.isFinite(halfCorrelation)
        && (!Number.isFinite(bestCorrelation)
          || halfCorrelation >= bestCorrelation - 0.12)
        && halfCycles >= 2) {
      selectedRpm = halfRpm;
      selectedPower = Math.max(halfPower, best.score * 0.72);
      harmonicCorrected = true;
    }
  }

  const correlation = principalAutocorrelation(selectedRpm);
  if (!Number.isFinite(correlation) || correlation < 0.12) return null;
  const crossing = interpolatedCrossingCadence(
    principal.values,
    timestampsMs,
    { minRms, minRpm, maxRpm },
  );
  let crossingRpm = crossing
    ? nearestHarmonic(crossing.rpm, selectedRpm, minRpm, maxRpm)
    : null;
  const crossingAgreement = crossingRpm != null
    ? clamp(1 - Math.abs(crossingRpm - selectedRpm)
      / Math.max(4, selectedRpm * 0.16), 0, 1)
    : 0;
  if (crossingRpm != null && crossingAgreement >= 0.45) {
    const crossingWeight = 0.18 * crossingAgreement;
    selectedRpm = selectedRpm * (1 - crossingWeight)
      + crossingRpm * crossingWeight;
  }

  const otherPowers = [...evaluated.entries()]
    .map(([key, score]) => ({ rpm: Number(key), score }))
    .filter((item) => Math.abs(item.rpm - best.rpm) >= 7);
  const sidePower = otherPowers.length
    ? Math.max(...otherPowers.map((item) => item.score))
    : 0;
  const prominence = clamp(
    (best.score - sidePower) / Math.max(best.score, 1e-9),
    0,
    1,
  );
  const amplitudeQuality = clamp(
    principal.rms / Math.max(minRms, 0.012),
    0,
    1,
  );
  const observedCycles = spanMs * selectedRpm / 60000;
  const cycleQuality = clamp((observedCycles - 1.5) / 2.5, 0, 1);
  const periodicity = clamp(
    selectedPower * 0.68 + Math.max(0, correlation) * 0.32,
    0,
    1,
  );
  const previousRpm = Number(options.previousRpm);
  const crossWindowStability = previousRpm > 0
    ? clamp(1 - Math.abs(Math.log(selectedRpm / previousRpm)) / 0.18, 0, 1)
    : 0.55;
  const methodAgreement = crossing
    ? crossingAgreement
    : clamp(Math.max(0, correlation), 0, 1);
  const confidence = clamp(
    periodicity * 0.25
      + prominence * 0.2
      + coverage * 0.15
      + cycleQuality * 0.15
      + methodAgreement * 0.15
      + crossWindowStability * 0.1
      + amplitudeQuality * 0.02
      + principal.dominance * 0.03,
    0,
    0.98,
  );
  if (confidence < 0.55) return null;
  return {
    rpm: selectedRpm,
    confidence,
    correlation,
    coverage,
    effectiveSampleHz,
    source: 'gyroscope_simple',
    method: harmonicCorrected
      ? 'spectral_harmonic'
      : (crossingAgreement >= 0.45 ? 'spectral_crossing' : 'spectral'),
    spectralPower: best.score,
    spectralProminence: prominence,
    harmonicHalfPowerRatio,
    observedCycles,
    axisDominance: principal.dominance,
  };
}

/**
 * 二级陀螺仪周期估算。
 *
 * 严格频谱/PCA 通道优先；只有连续窗口已经超过约 2.8 秒却仍没有严格候选时，
 * 才使用曾在 v0.1.11/v0.1.12 真机出数的迟滞过零与自相关方法。这里仍要求
 * 最小幅度、采样覆盖、至少两个完整周期和跨窗确认，避免把一次转头或随机
 * 道路冲击直接写进速度与里程。
 */
export function estimateFallbackGyroscopeCadence(samplesInput, options = {}) {
  if (!Array.isArray(samplesInput)) return null;
  const windowMs = Math.max(
    DEFAULT_SIMPLE_GYRO_FALLBACK_DELAY_MS,
    finite(options.windowMs, DEFAULT_SIMPLE_GYRO_WINDOW_MS),
  );
  const minSpanMs = Math.max(
    DEFAULT_SIMPLE_GYRO_FALLBACK_DELAY_MS,
    finite(options.minSpanMs, DEFAULT_SIMPLE_GYRO_FALLBACK_DELAY_MS),
  );
  const minSamples = Math.max(
    8,
    Math.round(finite(options.minSamples, DEFAULT_SIMPLE_GYRO_MIN_SAMPLES)),
  );
  const minRms = Math.max(
    0.001,
    finite(options.minRms, DEFAULT_SIMPLE_GYRO_MIN_RMS),
  );
  const minRpm = clamp(
    finite(options.minRpm, DEFAULT_SIMPLE_GYRO_MIN_RPM),
    30,
    80,
  );
  const maxRpm = Math.max(
    minRpm + 20,
    finite(options.maxRpm, DEFAULT_SIMPLE_GYRO_MAX_RPM),
  );
  const sortedSamples = samplesInput
    .filter((sample) => sample
      && [sample.timestampMs, sample.x, sample.y, sample.z]
        .every(Number.isFinite))
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const finiteSamples = [];
  for (const sample of sortedSamples) {
    const previous = finiteSamples[finiteSamples.length - 1];
    if (previous && sample.timestampMs === previous.timestampMs) {
      finiteSamples[finiteSamples.length - 1] = sample;
    } else {
      finiteSamples.push(sample);
    }
  }
  if (finiteSamples.length < minSamples) return null;
  const lastAt = finiteSamples[finiteSamples.length - 1].timestampMs;
  const cutoff = lastAt - windowMs;
  let samples = finiteSamples.filter((sample) => sample.timestampMs >= cutoff);
  if (samples.length < minSamples) return null;

  let deltas = positiveTimestampDeltas(samples);
  let medianIntervalMs = median(deltas);
  if (!(medianIntervalMs > 0)) return null;
  // 与严格通道一致：容忍录屏造成的短 bridge 空洞，长空洞仍切窗。
  const continuousGapMs = Math.max(1200, medianIntervalMs * 8);
  let continuousStart = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].timestampMs - samples[index - 1].timestampMs
        > continuousGapMs) {
      continuousStart = index;
    }
  }
  if (continuousStart > 0) samples = samples.slice(continuousStart);
  if (samples.length < minSamples) return null;
  deltas = positiveTimestampDeltas(samples);
  medianIntervalMs = median(deltas);
  if (!(medianIntervalMs > 0)) return null;
  const spanMs = samples[samples.length - 1].timestampMs
    - samples[0].timestampMs;
  if (spanMs < minSpanMs) return null;

  const effectiveSampleHz = 1000 / medianIntervalMs;
  if (effectiveSampleHz < 4 || effectiveSampleHz > 80) return null;
  const expectedIntervals = spanMs / medianIntervalMs;
  const coverage = clamp(
    deltas.length / Math.max(1, expectedIntervals),
    0,
    1,
  );
  if (coverage < 0.5) return null;

  const recentCutoff = lastAt - Math.max(700, medianIntervalMs * 4);
  const recentSamples = samples.filter(
    (sample) => sample.timestampMs >= recentCutoff,
  );
  const recentRms = ['x', 'y', 'z'].reduce((strongestRms, key) => {
    const axis = robustAxis(recentSamples.map((sample) => sample[key]));
    return Math.max(strongestRms, axis ? axis.rms : 0);
  }, 0);
  if (recentRms < minRms * 0.75) return null;

  const timestampsMs = samples.map((sample) => sample.timestampMs);
  const axes = ['x', 'y', 'z']
    .map((key) => ({
      key,
      ...robustDetrendedAxis(
        samples.map((sample) => sample[key]),
        timestampsMs,
      ),
    }))
    .filter((axis) => axis && axis.rms >= minRms)
    .sort((left, right) => right.rms - left.rms);
  if (!axes.length) return null;
  const strongest = axes[0];
  const smoothed = strongest.values.map((value, index, values) => {
    const previous = values[Math.max(0, index - 1)];
    const next = values[Math.min(values.length - 1, index + 1)];
    return (previous + value * 2 + next) / 4;
  });
  const previousRpm = Number(options.previousRpm);
  const resolveHarmonic = (rpm) => (
    previousRpm > 0
      ? nearestHarmonic(rpm, previousRpm, minRpm, maxRpm)
      : rpm
  );

  const hysteresis = Math.max(minRms * 0.45, strongest.rms * 0.18);
  const crossings = [];
  let armed = false;
  for (let index = 0; index < smoothed.length; index += 1) {
    const value = smoothed[index];
    if (value <= -hysteresis) armed = true;
    if (armed && value >= hysteresis) {
      crossings.push(samples[index].timestampMs);
      armed = false;
    }
  }
  const minPeriodMs = 60000 / maxRpm;
  const maxPeriodMs = 60000 / minRpm;
  const crossingIntervals = [];
  let lastValidCrossingAtMs = null;
  for (let index = 1; index < crossings.length; index += 1) {
    const intervalMs = crossings[index] - crossings[index - 1];
    if (intervalMs >= minPeriodMs && intervalMs <= maxPeriodMs) {
      crossingIntervals.push(intervalMs);
      lastValidCrossingAtMs = crossings[index];
    }
  }
  if (crossingIntervals.length >= 3) {
    const rawPeriodMs = median(crossingIntervals);
    const spread = median(
      crossingIntervals.map((value) => Math.abs(value - rawPeriodMs)),
    ) || 0;
    const spreadRatio = spread / rawPeriodMs;
    const rpm = resolveHarmonic(60000 / rawPeriodMs);
    const correlationLag = Math.max(
      2,
      Math.round(60000 / rpm / medianIntervalMs),
    );
    const periodicCorrelation = normalizedAutocorrelation(
      strongest.values,
      correlationLag,
    );
    if (spreadRatio <= 0.22
        && Number.isFinite(periodicCorrelation)
        && periodicCorrelation >= 0.5
        && rpm >= minRpm && rpm <= maxRpm) {
      const consistency = clamp(1 - spreadRatio / 0.22, 0, 1);
      const amplitudeQuality = clamp(
        strongest.rms / Math.max(minRms, 0.012),
        0,
        1,
      );
      return {
        rpm,
        confidence: clamp(
          0.58
            + consistency * 0.14
            + Math.max(0, periodicCorrelation) * 0.12
            + coverage * 0.12
            + amplitudeQuality * 0.08,
          0,
          0.94,
        ),
        correlation: periodicCorrelation,
        coverage,
        effectiveSampleHz,
        source: 'gyroscope_simple',
        method: 'fallback_crossing',
        observedCycles: spanMs * rpm / 60000,
        finalEligible: true,
        evidenceAtMs: lastValidCrossingAtMs,
        intervalCount: crossingIntervals.length,
      };
    }
  }

  const minLag = Math.max(2, Math.floor(effectiveSampleHz * 60 / maxRpm));
  const maxLag = Math.min(
    Math.ceil(effectiveSampleHz * 60 / minRpm),
    Math.floor((samples.length - 1) / 2),
  );
  if (maxLag < minLag) return null;
  const scores = [];
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const correlations = axes
      .map((axis) => normalizedAutocorrelation(axis.values, lag))
      .filter(Number.isFinite);
    if (!correlations.length) continue;
    scores.push({ lag, score: Math.max(...correlations) });
  }
  if (!scores.length) return null;
  const bestScore = Math.max(...scores.map((item) => item.score));
  if (bestScore < 0.25) return null;
  const eligible = scores.filter(
    (item) => item.score >= Math.max(0.25, bestScore - 0.08),
  );
  let selected = null;
  if (previousRpm > 0) {
    selected = eligible
      .map((item) => ({
        ...item,
        rpm: resolveHarmonic(effectiveSampleHz * 60 / item.lag),
      }))
      .sort((left, right) => (
        Math.abs(Math.log(left.rpm / previousRpm))
          - Math.abs(Math.log(right.rpm / previousRpm))
          || right.score - left.score
      ))[0];
  } else {
    selected = eligible.sort(
      (left, right) => right.score - left.score || right.lag - left.lag,
    )[0];
  }
  if (!selected) return null;
  const rpm = selected.rpm
    ?? resolveHarmonic(effectiveSampleHz * 60 / selected.lag);
  if (!(rpm >= minRpm && rpm <= maxRpm)) return null;
  const observedCycles = spanMs * rpm / 60000;
  if (observedCycles < 2) return null;
  const amplitudeQuality = clamp(
    strongest.rms / Math.max(minRms, 0.012),
    0,
    1,
  );
  return {
    rpm,
    confidence: clamp(
      0.52
        + Math.max(0, selected.score) * 0.28
        + coverage * 0.14
        + amplitudeQuality * 0.06,
      0,
      0.9,
    ),
    correlation: selected.score,
    coverage,
    effectiveSampleHz,
    source: 'gyroscope_simple',
    method: 'fallback_autocorrelation',
    observedCycles,
    finalEligible: false,
    evidenceAtMs: lastAt,
  };
}

function positiveTimestampDeltas(samples) {
  const deltas = [];
  for (let index = 1; index < samples.length; index += 1) {
    const deltaMs = samples[index].timestampMs - samples[index - 1].timestampMs;
    if (Number.isFinite(deltaMs) && deltaMs > 0) deltas.push(deltaMs);
  }
  return deltas;
}

/**
 * 自相关要求等间距样本，而 AIUI 的 frequency 只是 best-effort。先按真实时间戳
 * 估计回调率，再把最近一段连续数据线性重采样到不高于目标分析频率的均匀时间轴。
 * 这样 5.5–60Hz 的宿主回调、轻微抖动和少量丢帧不会因为“请求了 25Hz”被硬拒绝。
 */
function resampleCadenceWindow(samples, options) {
  if (!Array.isArray(samples)
      || samples.length < DEFAULT_CADENCE_MIN_SAMPLES) return null;
  let working = samples;
  let deltas = positiveTimestampDeltas(working);
  let medianIntervalMs = median(deltas);
  if (!(medianIntervalMs > 0)) return null;

  // 450ms 左右的道路冲击隔离不能在 5.5–12Hz 下抹掉整个踏频历史；
  // coverage 门仍会限制缺帧比例。只有接近一秒以上的 bridge/页面停流
  // 才切断连续片段，生命周期长空档仍绝不插值。
  const maxContinuousGapMs = Math.max(1000, medianIntervalMs * 6);
  let continuousStart = 0;
  for (let index = 1; index < working.length; index += 1) {
    if (working[index].timestampMs - working[index - 1].timestampMs
        > maxContinuousGapMs) {
      continuousStart = index;
    }
  }
  if (continuousStart > 0) working = working.slice(continuousStart);
  if (working.length < DEFAULT_CADENCE_MIN_SAMPLES) return null;

  deltas = positiveTimestampDeltas(working);
  medianIntervalMs = median(deltas);
  if (!(medianIntervalMs > 0)) return null;
  const effectiveSampleHz = 1000 / medianIntervalMs;
  if (effectiveSampleHz < options.minEffectiveSampleHz - 1e-6
      || effectiveSampleHz > options.maxEffectiveSampleHz + 1e-6) {
    return null;
  }

  const firstAt = working[0].timestampMs;
  const lastAt = working[working.length - 1].timestampMs;
  const spanMs = lastAt - firstAt;
  if (!(spanMs >= 2200)) return null;
  const expectedIntervals = spanMs / medianIntervalMs;
  const coverage = clamp(
    deltas.length / Math.max(1, expectedIntervals),
    0,
    1,
  );
  if (coverage < 0.72) return null;

  const absoluteTimingDeviations = deltas.map(
    (deltaMs) => Math.abs(deltaMs - medianIntervalMs),
  );
  const timingJitterRatio = (median(absoluteTimingDeviations) || 0)
    / medianIntervalMs;
  const timingQuality = clamp(1 - timingJitterRatio / 0.75, 0, 1);
  const analysisSampleHz = clamp(
    Math.min(
      effectiveSampleHz,
      Math.max(DEFAULT_SAMPLE_HZ, options.requestedSampleHz),
    ),
    options.minEffectiveSampleHz,
    options.maxEffectiveSampleHz,
  );
  const intervalMs = 1000 / analysisSampleHz;
  const uniform = [];
  let rightIndex = 1;
  for (let timestampMs = firstAt;
    timestampMs <= lastAt + intervalMs * 0.25;
    timestampMs += intervalMs) {
    while (rightIndex < working.length - 1
        && working[rightIndex].timestampMs < timestampMs) {
      rightIndex += 1;
    }
    const right = working[rightIndex];
    const left = working[Math.max(0, rightIndex - 1)];
    if (!left || !right) break;
    const sourceSpanMs = right.timestampMs - left.timestampMs;
    const ratio = sourceSpanMs > 0
      ? clamp((timestampMs - left.timestampMs) / sourceSpanMs, 0, 1)
      : 0;
    uniform.push({
      timestampMs,
      x: left.x + (right.x - left.x) * ratio,
      y: left.y + (right.y - left.y) * ratio,
      z: left.z + (right.z - left.z) * ratio,
    });
  }
  if (uniform.length < DEFAULT_CADENCE_MIN_SAMPLES) return null;
  return {
    samples: uniform,
    sampleHz: analysisSampleHz,
    effectiveSampleHz,
    coverage,
    timingQuality,
  };
}

/**
 * 将 AIUI Generic Sensor 的原始时间轴映射到单调毫秒轴。
 *
 * 不同宿主可能透传秒、毫秒、微秒、纳秒、空值、重复值或重启后的新纪元。
 * frequency 只是 best-effort，因此只用于原始时间不可用时的安全步进。
 */
export class SensorTimestampNormalizer {
  constructor(options = {}) {
    const frequency = Number(options.frequency);
    this.expectedIntervalMs = Number.isFinite(frequency) && frequency > 0
      ? 1000 / frequency : 20;
    this.maxCandidateIntervalMs = options.maxCandidateIntervalMs ?? 2000;
    this.maxClockSkewMs = options.maxClockSkewMs ?? 180;
    this.minMonotonicStepMs = options.minMonotonicStepMs ?? 0.001;
    this.reset();
  }

  reset() {
    this.lastRawTimestamp = null;
    this.lastWallMs = null;
    this.lastSampleMs = null;
    this.rawScaleToMs = null;
  }

  normalize(rawTimestamp, wallNowMs = Date.now()) {
    const raw = finiteSensorTimestamp(rawTimestamp);
    const wallNumber = Number(wallNowMs);
    const wall = Number.isFinite(wallNumber)
      ? wallNumber
      : (this.lastWallMs == null
        ? 0
        : this.lastWallMs + this.expectedIntervalMs);

    if (this.lastSampleMs == null) {
      this.lastRawTimestamp = raw;
      this.lastWallMs = wall;
      this.lastSampleMs = wall;
      return wall;
    }

    const wallDeltaMs = wall - this.lastWallMs;
    let sensorDeltaMs = null;
    if (raw != null && this.lastRawTimestamp != null && raw > this.lastRawTimestamp) {
      const rawDelta = raw - this.lastRawTimestamp;
      const targetDeltaMs = wallDeltaMs > 0
        && wallDeltaMs <= this.maxCandidateIntervalMs
        ? wallDeltaMs : this.expectedIntervalMs;
      let best = null;
      for (const scale of SENSOR_TIMESTAMP_SCALES_TO_MS) {
        const candidateMs = rawDelta * scale;
        if (!(candidateMs >= 1 && candidateMs <= this.maxCandidateIntervalMs)) continue;
        const score = Math.abs(Math.log(candidateMs / targetDeltaMs));
        if (!best || score < best.score) best = { candidateMs, scale, score };
      }
      if (best) {
        sensorDeltaMs = best.candidateMs;
        this.rawScaleToMs = best.scale;
      }
    }

    let nextSampleMs;
    if (wallDeltaMs > this.maxCandidateIntervalMs) {
      // 页面真正隐藏或桥长时间停顿时回到接收墙钟，不能补造一串 25Hz 样本。
      nextSampleMs = wall;
    } else if (sensorDeltaMs == null) {
      // AIUI 0.15 的旧 bridge 可能不提供原始 timestamp，并把同一批 reading
      // 在一个 Date.now() 毫秒内连续派发。此时若贴着接收墙钟，几十帧会被
      // 压成 0.001ms 间隔，周期窗会误判为 >60Hz 而永久没有 candidate。
      //
      // 无原始时间时，以 frequency hint 补同批帧；一旦墙钟自然走到虚拟轴
      // 前方，就直接贴回墙钟。普通 5–12Hz 逐帧回调仍使用真实到达间隔，
      // 批量回调也保留可分析的严格单调时间，不对加速度做积分。
      nextSampleMs = Math.max(
        this.lastSampleMs + this.expectedIntervalMs,
        wall,
      );
    } else {
      nextSampleMs = this.lastSampleMs + sensorDeltaMs;
      if (wall > this.lastSampleMs
          && wall - nextSampleMs > this.maxClockSkewMs) {
        nextSampleMs = wall;
      }
    }
    if (!(nextSampleMs > this.lastSampleMs)) {
      nextSampleMs = this.lastSampleMs + this.minMonotonicStepMs;
    }

    this.lastRawTimestamp = raw;
    this.lastWallMs = wall;
    this.lastSampleMs = nextSampleMs;
    return nextSampleMs;
  }
}

/**
 * 用稳健模长窗口识别宿主的 g / m/s² 加速度单位。
 *
 * 未识别前 scale=1 原样透传；只有中心值接近 1g 或标准重力时才锁定单位，
 * 因此不会把任意稳定的未知数值误缩放。
 */
export class AccelerationUnitCalibrator {
  constructor(options = {}) {
    this.windowMs = options.windowMs ?? 1200;
    this.minWindowMs = options.minWindowMs ?? 700;
    // 低至 5.5Hz 的眼镜回调在 1.2 秒窗口内只有约 7 帧；单位校准必须
    // 按覆盖时间而不是 25Hz 假设取样，否则 g 输入会永久停在 unknown。
    this.minSamples = options.minSamples ?? 6;
    this.maxRelativeDeviation = options.maxRelativeDeviation ?? 0.28;
    this.maxRelativeRange = options.maxRelativeRange ?? 0.9;
    this.gTolerance = options.gTolerance ?? 0.22;
    this.mps2ToleranceRatio = options.mps2ToleranceRatio ?? 0.22;
    this.analysisIntervalMs = clamp(
      finite(
        options.analysisIntervalMs,
        DEFAULT_ACCEL_CALIBRATION_ANALYSIS_INTERVAL_MS,
      ),
      125,
      250,
    );
    this.reset();
  }

  reset() {
    this.sourceUnit = ACCELERATION_SOURCE_UNIT.UNKNOWN;
    this.scaleToMps2 = 1;
    this.samples = [];
    this.lastTimestampMs = null;
    this.lastAnalysisMs = null;
    this.lastWindowStable = false;
    this.lastMedianMagnitude = null;
  }

  clearTransient() {
    this.samples = [];
    this.lastTimestampMs = null;
    this.lastAnalysisMs = null;
    this.lastWindowStable = false;
    this.lastMedianMagnitude = null;
  }

  push(x, y, z, timestampMs) {
    if (![x, y, z, timestampMs].every(Number.isFinite)) return false;
    if (this.lastTimestampMs != null && timestampMs < this.lastTimestampMs) {
      this.clearTransient();
    } else if (this.lastTimestampMs != null && timestampMs === this.lastTimestampMs) {
      if (this.samples.length) this.samples.pop();
    }
    this.lastTimestampMs = timestampMs;

    const magnitude = vectorLength(x, y, z);
    if (!(magnitude > 0)) return false;
    this.samples.push({ timestampMs, magnitude });
    const cutoff = timestampMs - this.windowMs;
    if (this.samples[0].timestampMs
        < cutoff - this.analysisIntervalMs) {
      trimTimedSamplesInPlace(this.samples, cutoff);
    }
    if (this.sourceUnit === ACCELERATION_SOURCE_UNIT.UNKNOWN
        && (this.lastAnalysisMs == null
          || timestampMs - this.lastAnalysisMs >= this.analysisIntervalMs)) {
      this.lastAnalysisMs = timestampMs;
      // Calibration is a full-window median/sort pass, so give it the exact
      // configured window even though raw ingestion keeps bounded trim slack.
      trimTimedSamplesInPlace(this.samples, cutoff);
      this._tryCalibrate();
    }
    return true;
  }

  convertVector(vector) {
    if (!Array.isArray(vector) || vector.length < 3) return null;
    const finiteVector = vector.slice(0, 3).map(Number);
    if (!finiteVector.every(Number.isFinite)) return null;
    return finiteVector.map((entry) => entry * this.scaleToMps2);
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

  _tryCalibrate() {
    if (this.samples.length < this.minSamples) return;
    const spanMs = this.samples[this.samples.length - 1].timestampMs
      - this.samples[0].timestampMs;
    if (spanMs < this.minWindowMs) return;

    const magnitudes = this.samples.map((sample) => sample.magnitude);
    const center = median(magnitudes);
    if (!(center > 0)) return;
    const squaredDeviation = magnitudes.reduce(
      (sum, value) => sum + (value - center) ** 2,
      0,
    ) / magnitudes.length;
    const relativeDeviation = Math.sqrt(squaredDeviation) / center;
    const relativeRange = (Math.max(...magnitudes) - Math.min(...magnitudes)) / center;
    this.lastMedianMagnitude = center;
    this.lastWindowStable = relativeDeviation <= this.maxRelativeDeviation
      && relativeRange <= this.maxRelativeRange;
    if (!this.lastWindowStable) return;

    if (Math.abs(center - 1) <= this.gTolerance) {
      this.sourceUnit = ACCELERATION_SOURCE_UNIT.STANDARD_GRAVITY;
      this.scaleToMps2 = STANDARD_GRAVITY_MPS2;
    } else if (Math.abs(center - STANDARD_GRAVITY_MPS2)
        <= STANDARD_GRAVITY_MPS2 * this.mps2ToleranceRatio) {
      this.sourceUnit = ACCELERATION_SOURCE_UNIT.METERS_PER_SECOND_SQUARED;
      this.scaleToMps2 = 1;
    }
  }
}

export class CyclingImuActivity {
  constructor(options = {}) {
    this.sampleHz = Math.max(10, finite(
      options.sampleHz ?? options.frequency,
      DEFAULT_SAMPLE_HZ,
    ));
    this.gravityTauMs = Math.max(100, finite(options.gravityTauMs, DEFAULT_GRAVITY_TAU_MS));
    this.scoreTauMs = Math.max(50, finite(options.scoreTauMs, DEFAULT_SCORE_TAU_MS));
    this.motionThreshold = Math.max(0.01, finite(options.motionThreshold, DEFAULT_MOTION_THRESHOLD));
    this.stillThreshold = clamp(
      finite(options.stillThreshold, DEFAULT_STILL_THRESHOLD),
      0,
      this.motionThreshold * 0.95,
    );
    this.movingConfirmMs = Math.max(0, finite(options.movingConfirmMs, DEFAULT_MOVING_CONFIRM_MS));
    this.stationaryConfirmMs = Math.max(
      0,
      finite(options.stationaryConfirmMs, DEFAULT_STATIONARY_CONFIRM_MS),
    );
    this.autoPauseAfterMs = Math.max(
      this.stationaryConfirmMs,
      finite(options.autoPauseAfterMs, DEFAULT_AUTO_PAUSE_AFTER_MS),
    );
    this.autoResumeAfterMs = Math.max(
      this.movingConfirmMs,
      finite(options.autoResumeAfterMs, DEFAULT_AUTO_RESUME_AFTER_MS),
    );
    this.staleMs = Math.max(250, finite(options.staleMs, DEFAULT_STALE_MS));
    this.cadenceWindowMs = Math.max(
      4000,
      finite(options.cadenceWindowMs, DEFAULT_CADENCE_WINDOW_MS),
    );
    this.cadenceAnalysisIntervalMs = Math.max(
      1000,
      finite(
        options.cadenceAnalysisIntervalMs,
        DEFAULT_CADENCE_ANALYSIS_INTERVAL_MS,
      ),
    );
    this.minCadenceRpm = clamp(
      finite(options.minCadenceRpm, DEFAULT_MIN_CADENCE_RPM),
      15,
      80,
    );
    this.maxCadenceRpm = Math.max(
      this.minCadenceRpm + 10,
      finite(options.maxCadenceRpm, DEFAULT_MAX_CADENCE_RPM),
    );
    this.minCadenceCycles = Math.max(
      2,
      Math.round(finite(options.minCadenceCycles, DEFAULT_MIN_CADENCE_CYCLES)),
    );
    this.cadenceStableWindows = Math.max(
      2,
      Math.round(finite(
        options.cadenceStableWindows,
        DEFAULT_CADENCE_STABLE_WINDOWS,
      )),
    );
    this.cadenceMinConfidence = clamp(
      finite(options.cadenceMinConfidence, DEFAULT_CADENCE_MIN_CONFIDENCE),
      0.5,
      0.95,
    );
    this.cadenceCandidateMaxAgeMs = Math.max(
      this.cadenceAnalysisIntervalMs * this.cadenceStableWindows,
      finite(
        options.cadenceCandidateMaxAgeMs,
        DEFAULT_CADENCE_CANDIDATE_MAX_AGE_MS,
      ),
    );
    this.cadenceMinCorrelation = clamp(
      finite(options.cadenceMinCorrelation, DEFAULT_CADENCE_MIN_CORRELATION),
      0.3,
      0.9,
    );
    this.cadenceMinAmplitudeMps2 = Math.max(
      0.01,
      finite(
        options.cadenceMinAmplitudeMps2,
        DEFAULT_CADENCE_MIN_AMPLITUDE_MPS2,
      ),
    );
    this.gyroscopeSampleHz = Math.max(5, finite(
      options.gyroscopeSampleHz,
      DEFAULT_GYROSCOPE_SAMPLE_HZ,
    ));
    this.cadenceMinAmplitudeGyroRadS = Math.max(
      0.004,
      finite(
        options.cadenceMinAmplitudeGyroRadS,
        DEFAULT_CADENCE_MIN_AMPLITUDE_GYRO_RADS,
      ),
    );
    this.provisionalCadenceHoldMs = Math.max(
      3000,
      finite(
        options.provisionalCadenceHoldMs,
        DEFAULT_PROVISIONAL_CADENCE_HOLD_MS,
      ),
    );
    this.simpleGyroWindowMs = Math.max(
      DEFAULT_SIMPLE_GYRO_MIN_SPAN_MS,
      finite(options.simpleGyroWindowMs, DEFAULT_SIMPLE_GYRO_WINDOW_MS),
    );
    this.simpleGyroMinSpanMs = Math.max(
      1500,
      finite(options.simpleGyroMinSpanMs, DEFAULT_SIMPLE_GYRO_MIN_SPAN_MS),
    );
    this.simpleGyroMinSamples = Math.max(
      8,
      Math.round(finite(
        options.simpleGyroMinSamples,
        DEFAULT_SIMPLE_GYRO_MIN_SAMPLES,
      )),
    );
    this.simpleGyroMinRms = Math.max(
      0.001,
      finite(options.simpleGyroMinRms, DEFAULT_SIMPLE_GYRO_MIN_RMS),
    );
    this.simpleGyroAnalysisIntervalMs = Math.max(
      1000,
      finite(
        options.simpleGyroAnalysisIntervalMs,
        DEFAULT_SIMPLE_GYRO_ANALYSIS_INTERVAL_MS,
      ),
    );
    this.simpleGyroHoldMs = Math.max(
      1200,
      finite(options.simpleGyroHoldMs, DEFAULT_SIMPLE_GYRO_HOLD_MS),
    );
    this.simpleGyroCandidateHoldMs = Math.max(
      900,
      finite(
        options.simpleGyroCandidateHoldMs,
        DEFAULT_SIMPLE_GYRO_CANDIDATE_HOLD_MS,
      ),
    );
    this.simpleGyroRelockHistoryMs = Math.max(
      2800,
      finite(
        options.simpleGyroRelockHistoryMs,
        DEFAULT_SIMPLE_GYRO_RELOCK_HISTORY_MS,
      ),
    );
    this.simpleGyroDownwardRelockAnchorMs = Math.max(
      this.simpleGyroHoldMs,
      finite(
        options.simpleGyroDownwardRelockAnchorMs,
        DEFAULT_SIMPLE_GYRO_DOWNWARD_RELOCK_ANCHOR_MS,
      ),
    );
    this.simpleGyroConfirmIntervalMs = Math.max(
      250,
      finite(
        options.simpleGyroConfirmIntervalMs,
        DEFAULT_SIMPLE_GYRO_CONFIRM_INTERVAL_MS,
      ),
    );
    this.simpleGyroFinalConfidence = clamp(
      finite(
        options.simpleGyroFinalConfidence,
        DEFAULT_SIMPLE_GYRO_FINAL_CONFIDENCE,
      ),
      0.55,
      0.9,
    );
    this.simpleGyroCandidateConfidence = clamp(
      finite(
        options.simpleGyroCandidateConfidence,
        DEFAULT_SIMPLE_GYRO_CANDIDATE_CONFIDENCE,
      ),
      0.55,
      this.simpleGyroFinalConfidence,
    );
    this.simpleGyroFallbackDelayMs = Math.max(
      this.simpleGyroMinSpanMs,
      finite(
        options.simpleGyroFallbackDelayMs,
        DEFAULT_SIMPLE_GYRO_FALLBACK_DELAY_MS,
      ),
    );
    this.simpleGyroFallbackConfirmMs = Math.max(
      this.simpleGyroConfirmIntervalMs,
      finite(
        options.simpleGyroFallbackConfirmMs,
        DEFAULT_SIMPLE_GYRO_FALLBACK_CONFIRM_MS,
      ),
    );
    this.simpleGyroFallbackConfidence = clamp(
      finite(
        options.simpleGyroFallbackConfidence,
        DEFAULT_SIMPLE_GYRO_FALLBACK_CONFIDENCE,
      ),
      0.55,
      this.simpleGyroFinalConfidence,
    );
    this.simpleGyroFallbackFinalConfidence = clamp(
      finite(
        options.simpleGyroFallbackFinalConfidence,
        DEFAULT_SIMPLE_GYRO_FALLBACK_FINAL_CONFIDENCE,
      ),
      this.simpleGyroFallbackConfidence,
      this.simpleGyroFinalConfidence,
    );
    this.simpleGyroEmaTauMs = Math.max(
      250,
      finite(options.simpleGyroEmaTauMs, DEFAULT_SIMPLE_GYRO_EMA_TAU_MS),
    );
    this.simpleGyroLedgerHoldMs = Math.max(
      1000,
      Math.min(
        this.simpleGyroHoldMs,
        finite(
          options.simpleGyroLedgerHoldMs,
          DEFAULT_SIMPLE_GYRO_LEDGER_HOLD_MS,
        ),
      ),
    );
    this.simpleGyroTouchDisplayHoldMs = Math.max(
      500,
      finite(
        options.simpleGyroTouchDisplayHoldMs,
        DEFAULT_SIMPLE_GYRO_TOUCH_DISPLAY_HOLD_MS,
      ),
    );
    this.simpleGyroMinRpm = clamp(
      finite(options.simpleGyroMinRpm, DEFAULT_SIMPLE_GYRO_MIN_RPM),
      30,
      80,
    );
    this.simpleGyroMaxRpm = Math.min(
      this.maxCadenceRpm,
      Math.max(
        this.simpleGyroMinRpm + 20,
        finite(options.simpleGyroMaxRpm, DEFAULT_SIMPLE_GYRO_MAX_RPM),
      ),
    );
    this.minEffectiveSampleHz = clamp(
      finite(options.minEffectiveSampleHz, DEFAULT_MIN_EFFECTIVE_SAMPLE_HZ),
      4,
      30,
    );
    this.maxEffectiveSampleHz = Math.max(
      this.minEffectiveSampleHz + 1,
      finite(options.maxEffectiveSampleHz, DEFAULT_MAX_EFFECTIVE_SAMPLE_HZ),
    );
    this.metersPerCrank = clamp(
      finite(options.metersPerCrank, DEFAULT_METERS_PER_CRANK),
      0.5,
      15,
    );
    this.sensorClock = new SensorTimestampNormalizer({
      frequency: this.sampleHz,
    });
    this.gyroscopeClock = new SensorTimestampNormalizer({
      frequency: this.gyroscopeSampleHz,
    });
    this.accelerationCalibrator = new AccelerationUnitCalibrator(
      options.accelerationCalibration,
    );
    this.motionQualityGate = options.motionQualityGate
      && typeof options.motionQualityGate.pushAcceleration === 'function'
      ? options.motionQualityGate : null;
    this.accelerationScaleToMps2 = 1;
    this.reset(finite(options.startMs, 0));
  }

  reset(nowMs = 0) {
    this.sensorClock.reset();
    this.gyroscopeClock.reset();
    this.accelerationCalibrator.reset();
    if (this.motionQualityGate
        && typeof this.motionQualityGate.reset === 'function') {
      this.motionQualityGate.reset();
    }
    this.accelerationScaleToMps2 = 1;
    this._resetActivity(nowMs, false);
  }

  _resetActivity(nowMs, preserveSessionPaused = true) {
    const wasPaused = preserveSessionPaused ? this.sessionPaused === true : false;
    this.gravity = null;
    this.motionScore = 0;
    this.motionState = 'unknown';
    this.stateSinceMs = Number.isFinite(nowMs) ? nowMs : 0;
    this.lastReceivedAtMs = null;
    this.lastSampleMs = null;
    this.lastAccelerationSampleMs = null;
    this.lastAccelerationReceivedAtMs = null;
    this.lastGyroscopeSampleMs = null;
    this.lastGyroscopeReceivedAtMs = null;
    this.gyroscopeMotionScore = 0;
    this.gyroscopeStillEvidenceSinceMs = null;
    this.motionEvidenceSinceMs = null;
    this.stillEvidenceSinceMs = null;
    this.sessionPaused = wasPaused;
    this.cadenceSamples = [];
    this.gyroscopeCadenceSamples = [];
    this.simpleGyroscopeSamples = [];
    this.simpleGyroCadenceRpm = null;
    this.simpleGyroCadenceConfidence = 0;
    this.simpleGyroCadenceCorrelation = null;
    this.simpleGyroCadenceAtMs = null;
    this.simpleGyroCadenceReceivedAtMs = null;
    this.simpleGyroLedgerAtMs = null;
    this.simpleGyroLedgerReceivedAtMs = null;
    this.simpleGyroCadenceMethod = 'none';
    this.simpleGyroTrustedFinalRpm = null;
    this.simpleGyroTrustedFinalAtMs = null;
    this.simpleGyroCandidateRpm = null;
    this.simpleGyroCandidateConfidence = 0;
    this.simpleGyroCandidateCorrelation = null;
    this.simpleGyroCandidateAtMs = null;
    this.simpleGyroCandidateReceivedAtMs = null;
    this.simpleGyroCandidateMethod = 'none';
    this.simpleGyroCandidateHistory = [];
    this.simpleGyroLastAnalysisMs = null;
    this.simpleGyroEffectiveSampleHz = null;
    this.simpleGyroAnalysisState = 'warming';
    this.simpleGyroTouchDisplayRpm = null;
    this.simpleGyroTouchDisplayConfidence = 0;
    this.simpleGyroTouchDisplayCorrelation = null;
    this.simpleGyroTouchDisplayUntilReceivedAtMs = null;
    this.cadenceCandidates = [];
    this.lastCadenceAnalysisMs = null;
    this.lastCadenceAnalysisMsBySource = {
      accelerometer: null,
      gyroscope: null,
    };
    this.lastCadenceAnalysisSource = 'none';
    this.candidateCadenceRpm = null;
    this.finalCadenceRpm = null;
    this.cadenceConfidence = 0;
    this.cadenceCorrelation = null;
    this.cadenceState = 'warming';
    this.lastCadenceEvidenceMs = null;
    this.provisionalCadenceRpm = null;
    this.provisionalCadenceConfidence = 0;
    this.provisionalCadenceAtMs = null;
    this.provisionalCadenceSource = 'none';
    this.cadenceSensorSource = 'none';
    this.lastMotionQuality = null;
    this.walkingImpactTimestampsMs = [];
    this.walkingLikeUntilMs = null;
    this.walkingLikeConfidence = 0;
  }

  /**
   * 输入眼镜三轴加速度，单位应为 m/s²。nowMs 必须是单调毫秒时间；
   * 也可放在 sample.timestampMs。无效/倒退样本返回 false。
   */
  onSample(sample, nowMs = null, motionQuality = null, receivedAtMs = null) {
    if (!sample || typeof sample !== 'object') return false;
    const x = Number(sample.x);
    const y = Number(sample.y);
    const z = Number(sample.z);
    const at = Number.isFinite(nowMs) ? nowMs : Number(sample.timestampMs);
    if (![x, y, z, at].every(Number.isFinite)) return false;
    if (this.lastAccelerationSampleMs != null
        && at <= this.lastAccelerationSampleMs) return false;
    const receivedAt = Number.isFinite(receivedAtMs) ? receivedAtMs : at;
    this.lastAccelerationReceivedAtMs = receivedAt;
    if (this.lastReceivedAtMs == null || receivedAt >= this.lastReceivedAtMs) {
      this.lastReceivedAtMs = receivedAt;
    }
    this.lastMotionQuality = motionQuality && typeof motionQuality === 'object'
      ? motionQuality : null;
    if (this.lastMotionQuality
        && this.lastMotionQuality.roadImpactTriggered === true) {
      this.walkingImpactTimestampsMs.push(at);
      const impactCutoff = at - DEFAULT_IMU_WALKING_IMPACT_WINDOW_MS;
      this._trimTimedValues(this.walkingImpactTimestampsMs, impactCutoff);
    }

    if (this.gravity == null) {
      this.gravity = { x, y, z };
      this.lastAccelerationSampleMs = at;
      this.lastSampleMs = this.lastSampleMs == null
        ? at : Math.max(this.lastSampleMs, at);
      this.motionScore = 0;
      this.stillEvidenceSinceMs = at;
      return true;
    }

    const rawDtMs = at - this.lastAccelerationSampleMs;
    const dtMs = clamp(rawDtMs, 5, 250);
    const gravityAlpha = 1 - Math.exp(-dtMs / this.gravityTauMs);
    this.gravity.x += (x - this.gravity.x) * gravityAlpha;
    this.gravity.y += (y - this.gravity.y) * gravityAlpha;
    this.gravity.z += (z - this.gravity.z) * gravityAlpha;

    const dynamicX = x - this.gravity.x;
    const dynamicY = y - this.gravity.y;
    const dynamicZ = z - this.gravity.z;
    const dynamicMagnitude = vectorLength(dynamicX, dynamicY, dynamicZ);
    this.lastAccelerationSampleMs = at;
    this.lastSampleMs = this.lastSampleMs == null
      ? at : Math.max(this.lastSampleMs, at);
    const artifact = this.lastMotionQuality
      && typeof this.lastMotionQuality.artifact === 'string'
      ? this.lastMotionQuality.artifact : 'none';
    if (artifact !== 'none') {
      // 伪动作样本可更新重力方向，避免恢复首帧产生巨大边沿，但不得进入
      // 通用运动分数或暂停/恢复证据，否则扶镜也可能被当作恢复骑行。
      this.motionEvidenceSinceMs = null;
      this.stillEvidenceSinceMs = null;
      if (artifact === 'touch') {
        this._holdSimpleGyroDisplayOnTouch(receivedAt);
        this._clearSimpleGyroCadence(true, true);
      }
      if (artifact === 'road_impact'
          && this.lastMotionQuality.roadImpactTriggered !== true) {
        // road_impact 的 hold 帧本身通常已恢复为正常加速度。保留这些低频
        // 样本，真正触发冲击的那一帧仍排除，避免每次颠簸制造 450–700ms
        // 空洞并破坏整个 12 秒自相关窗。
        this._recordCadenceSample(at, dynamicX, dynamicY, dynamicZ);
      }
      this._rejectCadenceArtifact(at, artifact, 'accelerometer');
      return true;
    }
    const scoreAlpha = 1 - Math.exp(-dtMs / this.scoreTauMs);
    this.motionScore += (dynamicMagnitude - this.motionScore) * scoreAlpha;
    const wasStationary = this.motionState === 'stationary';
    this._updateEvidence(at);
    if (wasStationary && this.motionState === 'moving') {
      // 静止窗中重新积累的零能量样本不能替新运动凑周期跨度。只清派生
      // 分析窗/候选，保留刚刚建立的 moving 证据，再从当前真实帧起收集。
      this.cadenceSamples = [];
      this.gyroscopeCadenceSamples = [];
      // 这个分支说明刚从明确 stationary 起步，旧场景的高频锁不能再授权
      // 新运动走半频捷径；新段必须重新形成自己的可信 final。
      this._clearSimpleGyroCadence(true, true);
      this._clearCadenceEstimate('warming', { clearProvisional: true });
    }
    this._recordCadenceSample(at, dynamicX, dynamicY, dynamicZ);
    this._updateCadenceEstimate(at, 'accelerometer');
    return true;
  }

  _recordCadenceSample(timestampMs, x, y, z) {
    this.cadenceSamples.push({ timestampMs, x, y, z });
    const cutoff = timestampMs - this.cadenceWindowMs;
    if (this.cadenceSamples[0].timestampMs
        < cutoff - DEFAULT_SAMPLE_WINDOW_COMPACTION_SLACK_MS) {
      this._trimTimedSamples(this.cadenceSamples, cutoff);
    }
  }

  _trimTimedValues(values, cutoffMs) {
    if (!Array.isArray(values) || !values.length) return 0;
    let keepFrom = 0;
    while (keepFrom < values.length && values[keepFrom] < cutoffMs) {
      keepFrom += 1;
    }
    if (keepFrom > 0) values.splice(0, keepFrom);
    return keepFrom;
  }

  _recordGyroscopeCadenceSample(timestampMs, x, y, z) {
    this.gyroscopeCadenceSamples.push({ timestampMs, x, y, z });
    const cutoff = timestampMs - this.cadenceWindowMs;
    if (this.gyroscopeCadenceSamples[0].timestampMs
        < cutoff - DEFAULT_SAMPLE_WINDOW_COMPACTION_SLACK_MS) {
      this._trimTimedSamples(this.gyroscopeCadenceSamples, cutoff);
    }
  }

  _recordSimpleGyroscopeSample(timestampMs, x, y, z) {
    this.simpleGyroscopeSamples.push({ timestampMs, x, y, z });
    const cutoff = timestampMs - this.simpleGyroWindowMs;
    if (this.simpleGyroscopeSamples[0].timestampMs
        < cutoff - DEFAULT_SAMPLE_WINDOW_COMPACTION_SLACK_MS) {
      this._trimTimedSamples(this.simpleGyroscopeSamples, cutoff);
    }
  }

  _trimTimedSamples(samples, cutoffMs) {
    return trimTimedSamplesInPlace(samples, cutoffMs);
  }

  _holdSimpleGyroDisplayOnTouch(receivedAtMs) {
    const displayRpm = this.simpleGyroCadenceRpm > 0
      ? this.simpleGyroCadenceRpm : this.simpleGyroCandidateRpm;
    if (!(displayRpm > 0) || !Number.isFinite(receivedAtMs)) return;
    this.simpleGyroTouchDisplayRpm = displayRpm;
    this.simpleGyroTouchDisplayConfidence = this.simpleGyroCadenceRpm > 0
      ? this.simpleGyroCadenceConfidence
      : this.simpleGyroCandidateConfidence;
    this.simpleGyroTouchDisplayCorrelation = this.simpleGyroCadenceRpm > 0
      ? this.simpleGyroCadenceCorrelation
      : this.simpleGyroCandidateCorrelation;
    this.simpleGyroTouchDisplayUntilReceivedAtMs = receivedAtMs
      + this.simpleGyroTouchDisplayHoldMs;
  }

  _clearSimpleGyroCadence(clearSamples = false, clearTrustedFinal = false) {
    if (clearSamples) this.simpleGyroscopeSamples = [];
    this.simpleGyroCadenceRpm = null;
    this.simpleGyroCadenceConfidence = 0;
    this.simpleGyroCadenceCorrelation = null;
    this.simpleGyroCadenceAtMs = null;
    this.simpleGyroCadenceReceivedAtMs = null;
    this.simpleGyroLedgerAtMs = null;
    this.simpleGyroLedgerReceivedAtMs = null;
    this.simpleGyroCadenceMethod = 'none';
    if (clearTrustedFinal) {
      this.simpleGyroTrustedFinalRpm = null;
      this.simpleGyroTrustedFinalAtMs = null;
    }
    this.simpleGyroCandidateRpm = null;
    this.simpleGyroCandidateConfidence = 0;
    this.simpleGyroCandidateCorrelation = null;
    this.simpleGyroCandidateAtMs = null;
    this.simpleGyroCandidateReceivedAtMs = null;
    this.simpleGyroCandidateMethod = 'none';
    this.simpleGyroCandidateHistory = [];
    if (clearSamples) this.simpleGyroEffectiveSampleHz = null;
    this.simpleGyroAnalysisState = 'warming';
  }

  _simpleGyroRelockCandidates(nextRpm, allowFinalRewrite = true) {
    // 首次锁定仍必须走严格频谱或 finalEligible crossing。只有本场已经
    // 形成过可信 final，才允许用跨 strict/fallback 的重复候选恢复锁定。
    // 这处理真机路面噪声让两条估算通道来回切换、但候选节奏持续一致的情况；
    // fallback_autocorrelation 单独出现时仍不能凭三窗制造首次骑行数据。
    const previousLockedRpm = Number(this.simpleGyroCadenceRpm);
    if (allowFinalRewrite !== true
        || !(previousLockedRpm > 0)
        || !(nextRpm > 0)) return null;

    const tolerance = Math.max(7, nextRpm * 0.1);
    const candidates = this.simpleGyroCandidateHistory.filter((candidate) => (
      candidate
      && Number.isFinite(candidate.rpm)
      && Number.isFinite(candidate.atMs)
      && Number.isFinite(candidate.evidenceAtMs)
      && candidate.relockEligible !== false
      && Number(candidate.confidence) >= this.simpleGyroFallbackConfidence
      && Number(candidate.correlation) >= 0.5
      && Math.abs(candidate.rpm - nextRpm) <= tolerance
    ));
    if (candidates.length < 3) return null;

    const evidenceCandidates = [];
    let lastEvidenceAtMs = null;
    for (const candidate of candidates) {
      if (lastEvidenceAtMs != null
          && candidate.evidenceAtMs <= lastEvidenceAtMs) continue;
      evidenceCandidates.push(candidate);
      lastEvidenceAtMs = candidate.evidenceAtMs;
    }
    if (evidenceCandidates.length < 3) return null;

    const first = evidenceCandidates[0];
    const last = evidenceCandidates[evidenceCandidates.length - 1];
    if (last.atMs - first.atMs < 700) return null;
    const center = median(evidenceCandidates.map((candidate) => candidate.rpm));
    if (!(center > 0)) return null;
    const centerTolerance = Math.max(7, center * 0.1);
    if (!evidenceCandidates.every(
      (candidate) => Math.abs(candidate.rpm - center) <= centerTolerance,
    )) return null;

    // 已锁定后的变速可以重新收敛，但宽松 ACF 不能从旧频率跳到完全无关的
    // 伪周期。25% 足以覆盖实测 71.91 -> 88.83rpm，同时挡住明显半频/倍频。
    if (Math.abs(center - previousLockedRpm)
        > Math.max(10, previousLockedRpm * 0.25)) return null;
    return evidenceCandidates;
  }

  _simpleGyroDownwardHarmonicRelockCandidates(nextRpm, nowMs = null) {
    // 眼镜的头部周期偶尔会先锁到踩踏基频的二倍。只允许从明确高频向
    // 45–100rpm 的半频纠错；低频向高频的反向倍频永远不能走这条捷径。
    const currentLockedRpm = Number(this.simpleGyroCadenceRpm);
    const historicalLockedRpm = Number(this.simpleGyroTrustedFinalRpm);
    const historicalAnchorFresh = Number.isFinite(nowMs)
      && Number.isFinite(this.simpleGyroTrustedFinalAtMs)
      && nowMs >= this.simpleGyroTrustedFinalAtMs
      && nowMs - this.simpleGyroTrustedFinalAtMs
        <= this.simpleGyroDownwardRelockAnchorMs;
    const previousLockedRpm = historicalAnchorFresh
      ? (currentLockedRpm >= 110 ? currentLockedRpm : historicalLockedRpm)
      : null;
    if (!(previousLockedRpm >= 110)
        || !(nextRpm >= 45 && nextRpm <= 100)) return null;
    const nextRatio = nextRpm / previousLockedRpm;
    if (nextRatio < 0.45 || nextRatio > 0.62) return null;

    const tolerance = Math.max(6, nextRpm * 0.08);
    const candidates = this.simpleGyroCandidateHistory.filter((candidate) => (
      candidate
      && Number.isFinite(candidate.rpm)
      && Number.isFinite(candidate.atMs)
      && Number.isFinite(candidate.evidenceAtMs)
      && candidate.finalEligible === true
      && candidate.method !== 'fallback_autocorrelation'
      && candidate.artifact !== 'touch'
      && Number(candidate.correlation) >= 0.55
      && Math.abs(candidate.rpm - nextRpm) <= tolerance
      && candidate.rpm / previousLockedRpm >= 0.45
      && candidate.rpm / previousLockedRpm <= 0.62
    ));
    if (candidates.length < 2) return null;

    const evidenceCandidates = [];
    let lastEvidenceAtMs = null;
    for (const candidate of candidates) {
      if (lastEvidenceAtMs != null
          && candidate.evidenceAtMs <= lastEvidenceAtMs) continue;
      evidenceCandidates.push(candidate);
      lastEvidenceAtMs = candidate.evidenceAtMs;
    }
    if (evidenceCandidates.length < 2) return null;
    const first = evidenceCandidates[0];
    const last = evidenceCandidates[evidenceCandidates.length - 1];
    if (last.atMs - first.atMs < 700) return null;
    const averageConfidence = evidenceCandidates.reduce(
      (sum, candidate) => sum + Number(candidate.confidence || 0),
      0,
    ) / evidenceCandidates.length;
    if (averageConfidence < 0.65) return null;
    return evidenceCandidates;
  }

  _updateSimpleGyroCadence(
    nowMs,
    receivedAtMs = nowMs,
    {
      allowFinalRewrite = true,
      allowLowRateFinal = true,
      downwardRelockEvidenceOnly = false,
      artifact = 'none',
    } = {},
  ) {
    if (this.simpleGyroLastAnalysisMs != null
        && nowMs - this.simpleGyroLastAnalysisMs
          < this.simpleGyroAnalysisIntervalMs) {
      return null;
    }
    const simpleCutoff = nowMs - this.simpleGyroWindowMs;
    if (this.simpleGyroscopeSamples.length
        && this.simpleGyroscopeSamples[0].timestampMs < simpleCutoff) {
      this._trimTimedSamples(this.simpleGyroscopeSamples, simpleCutoff);
    }
    const simpleSamples = this.simpleGyroscopeSamples;
    const simpleSpanMs = simpleSamples.length > 1
      ? simpleSamples[simpleSamples.length - 1].timestampMs
        - simpleSamples[0].timestampMs
      : 0;
    if (simpleSamples.length < this.simpleGyroMinSamples
        || simpleSpanMs < this.simpleGyroMinSpanMs) {
      this.simpleGyroAnalysisState = 'warming';
      return null;
    }
    this.simpleGyroLastAnalysisMs = nowMs;
    const simpleEnergyWindowMs = Math.min(
      this.simpleGyroWindowMs,
      Math.max(1400, 60000 / this.simpleGyroMinRpm),
    );
    const simpleRecentRms = recentMaxAxisRms(
      simpleSamples,
      nowMs,
      simpleEnergyWindowMs,
    );
    if (simpleRecentRms < this.simpleGyroMinRms * 0.6) {
      this.simpleGyroEffectiveSampleHz = null;
      this.simpleGyroAnalysisState = 'low_energy';
      return null;
    }
    const previousRpm = this.simpleGyroCadenceRpm
      ?? this.simpleGyroCandidateRpm;
    const effectiveSampleHz = measuredGyroscopeSampleHz(
      this.simpleGyroscopeSamples,
    );
    this.simpleGyroEffectiveSampleHz = effectiveSampleHz;
    const lowRateActive = effectiveSampleHz != null
      && effectiveSampleHz >= DEFAULT_LOW_RATE_GYRO_MIN_HZ
      && effectiveSampleHz <= DEFAULT_LOW_RATE_GYRO_MAX_HZ;
    this.simpleGyroAnalysisState = lowRateActive
      ? (allowLowRateFinal ? 'low_rate_collecting' : 'low_rate_artifact_blocked')
      : (effectiveSampleHz == null ? 'warming' : 'standard_rate');
    const lowRateEstimate = lowRateActive
      ? estimateLowRateGyroscopeCadence(
        this.simpleGyroscopeSamples,
        {
          windowMs: this.simpleGyroWindowMs,
          minSpanMs: Math.max(
            this.simpleGyroMinSpanMs,
            DEFAULT_LOW_RATE_GYRO_MIN_SPAN_MS,
          ),
          minSamples: Math.max(
            this.simpleGyroMinSamples,
            DEFAULT_LOW_RATE_GYRO_MIN_SAMPLES,
          ),
          minRms: this.simpleGyroMinRms,
          minRpm: this.simpleGyroMinRpm,
          maxRpm: this.simpleGyroMaxRpm,
          previousRpm,
        },
      )
      : null;
    // 专用低帧率估算一旦已有完整结果，本轮最终就会优先使用它；不再
    // 重复执行随后必被丢弃的严格频谱整窗，降低 AR/低帧率回调的主线程占用。
    const strictEstimate = lowRateEstimate == null
      ? estimateSimpleGyroscopeCadence(
        this.simpleGyroscopeSamples,
        {
          windowMs: this.simpleGyroWindowMs,
          minSpanMs: this.simpleGyroMinSpanMs,
          minSamples: this.simpleGyroMinSamples,
          minRms: this.simpleGyroMinRms,
          minRpm: this.simpleGyroMinRpm,
          maxRpm: this.simpleGyroMaxRpm,
          previousRpm,
        },
      )
      : null;
    let estimate = lowRateEstimate ?? strictEstimate;
    const lowRate = lowRateEstimate != null;
    let fallback = false;
    if (!lowRate && (!strictEstimate
        || strictEstimate.confidence < this.simpleGyroCandidateConfidence)) {
      const fallbackEstimate = estimateFallbackGyroscopeCadence(
        this.simpleGyroscopeSamples,
        {
          windowMs: this.simpleGyroWindowMs,
          minSpanMs: this.simpleGyroFallbackDelayMs,
          minSamples: this.simpleGyroMinSamples,
          minRms: this.simpleGyroMinRms,
          minRpm: this.simpleGyroMinRpm,
          maxRpm: this.simpleGyroMaxRpm,
          previousRpm,
        },
      );
      if (fallbackEstimate
          && fallbackEstimate.confidence
            >= this.simpleGyroFallbackConfidence) {
        estimate = fallbackEstimate;
        fallback = true;
      }
    }
    if (!estimate) return null;
    if (lowRateActive && (allowLowRateFinal !== true || !lowRate)) {
      // 低帧率下单次转头或宽松 ACF 更容易占满短窗。在专用时间域共识
      // 准备好之前，现有 strict/fallback 仍可给诊断候选，但不得创建或重锁
      // final；这样首次锁定只能由专用通道的完整证据链打开。
      estimate = {
        ...estimate,
        finalEligible: false,
        relockEligible: false,
      };
    }
    if (lowRate) {
      this.simpleGyroAnalysisState = estimate.finalEligible === true
        ? 'low_rate_ready'
        : (allowLowRateFinal
          ? 'low_rate_candidate' : 'low_rate_artifact_blocked');
    }
    const candidateConfidence = fallback
      ? this.simpleGyroFallbackConfidence
      : this.simpleGyroCandidateConfidence;
    if (estimate.confidence < candidateConfidence) {
      return estimate;
    }

    const nextRpm = clamp(
      estimate.rpm,
      this.simpleGyroMinRpm,
      this.simpleGyroMaxRpm,
    );
    this.simpleGyroCandidateRpm = nextRpm;
    this.simpleGyroCandidateConfidence = estimate.confidence;
    this.simpleGyroCandidateCorrelation = estimate.correlation;
    this.simpleGyroCandidateAtMs = nowMs;
    this.simpleGyroCandidateReceivedAtMs = receivedAtMs;
    this.simpleGyroCandidateMethod = estimate.method;
    this.simpleGyroTouchDisplayRpm = null;
    this.simpleGyroTouchDisplayConfidence = 0;
    this.simpleGyroTouchDisplayCorrelation = null;
    this.simpleGyroTouchDisplayUntilReceivedAtMs = null;
    const estimateFinalEligible = estimate.finalEligible !== false;
    const evidenceAtMs = Number.isFinite(estimate.evidenceAtMs)
      ? estimate.evidenceAtMs : nowMs;
    this.simpleGyroCandidateHistory.push({
      rpm: nextRpm,
      confidence: estimate.confidence,
      correlation: estimate.correlation,
      atMs: nowMs,
      receivedAtMs,
      method: estimate.method,
      fallback,
      finalEligible: estimateFinalEligible,
      relockEligible: estimate.relockEligible !== false,
      evidenceAtMs,
      artifact,
    });
    const historyCutoff = nowMs - this.simpleGyroRelockHistoryMs;
    this.simpleGyroCandidateHistory = this.simpleGyroCandidateHistory
      .filter((candidate) => candidate.atMs >= historyCutoff)
      .slice(-7);

    const previousFresh = this.simpleGyroCadenceRpm > 0
      && this.simpleGyroCadenceAtMs != null
      && nowMs >= this.simpleGyroCadenceAtMs
      && nowMs - this.simpleGyroCadenceAtMs <= this.simpleGyroHoldMs;

    const toleranceFor = (rpm) => (
      fallback ? Math.max(6, rpm * 0.08) : Math.max(4, rpm * 0.06)
    );
    const closeToFinal = previousFresh
      && Math.abs(nextRpm - this.simpleGyroCadenceRpm)
        <= toleranceFor(this.simpleGyroCadenceRpm);
    const matchingHistory = this.simpleGyroCandidateHistory.filter(
      (candidate) => (
        candidate.atMs >= nowMs - this.simpleGyroCandidateHoldMs
        && candidate.fallback === fallback
        &&
        Math.abs(candidate.rpm - nextRpm) <= toleranceFor(nextRpm)
      ),
    );
    const confirmIntervalMs = fallback
      ? this.simpleGyroFallbackConfirmMs
      : this.simpleGyroConfirmIntervalMs;
    const confirmingCandidate = matchingHistory
      .slice(0, -1)
      .reverse()
      .find((candidate) => (
        nowMs - candidate.atMs >= confirmIntervalMs
        && candidate.finalEligible === true
        && estimateFinalEligible
        && evidenceAtMs > candidate.evidenceAtMs
      ));
    const confirmationConfidence = confirmingCandidate
      ? (confirmingCandidate.confidence + estimate.confidence) / 2
      : 0;
    const finalConfidence = fallback
      ? this.simpleGyroFallbackFinalConfidence
      : this.simpleGyroFinalConfidence;
    const newlyConfirmed = downwardRelockEvidenceOnly !== true
      && confirmingCandidate
      && confirmationConfidence >= finalConfidence;
    const downwardHarmonicCandidates =
      this._simpleGyroDownwardHarmonicRelockCandidates(nextRpm, nowMs);
    const relockCandidates = downwardHarmonicCandidates
      ?? (downwardRelockEvidenceOnly === true
        ? null
        : this._simpleGyroRelockCandidates(nextRpm, allowFinalRewrite));
    const downwardHarmonicRelock = Array.isArray(downwardHarmonicCandidates)
      && downwardHarmonicCandidates.length >= 2;
    const relockConfirmed = downwardHarmonicRelock
      || (Array.isArray(relockCandidates) && relockCandidates.length >= 3);

    if (!previousFresh && !newlyConfirmed && !relockConfirmed) {
      // 第一窗只作为候选给 HUD 诊断；严格通道至少相隔 350ms，二级通道
      // 至少相隔 500ms 且一致后，才允许进入速度、距离和总结账本。
      return estimate;
    }
    if (!estimateFinalEligible && !relockConfirmed) {
      // 宽松 ACF 或被伪动作阻断的低帧率估算只负责 HUD/日志候选，不得进入
      // 距离账本；首次锁定必须来自可独立复核且出现新周期的时间域证据。
      return estimate;
    }
    if (previousFresh && !closeToFinal && !newlyConfirmed
        && !relockConfirmed) {
      // 已锁定后遇到大幅跳变，先保留旧值。真实变速会在第二个一致新窗
      // 后接管；单次转头、冲击或半频/倍频候选不能改写正在积分的踏频。
      return estimate;
    }
    if (previousFresh && !allowFinalRewrite && !closeToFinal
        && !downwardHarmonicRelock) {
      // soft artifact 可以证明原踏频仍在，但绝不能用转头或道路冲击形成的
      // 新频率替换已经锁定的值。
      return estimate;
    }
    if (previousFresh && fallback && !closeToFinal) {
      const elapsedSeconds = Math.max(
        0.5,
        (nowMs - this.simpleGyroCadenceAtMs) / 1000,
      );
      if (Math.abs(nextRpm - this.simpleGyroCadenceRpm)
          > 12 * elapsedSeconds) {
        return estimate;
      }
    }

    const stableCandidates = relockConfirmed
      ? relockCandidates.slice(-3)
      : matchingHistory.slice(-3);
    const stableCenter = median(
      stableCandidates.map((candidate) => candidate.rpm),
    );
    if (previousFresh && !allowFinalRewrite && !downwardHarmonicRelock) {
      // 只刷新已锁定值的周期证据与账本时钟。
    } else if (previousFresh && closeToFinal) {
      const updateDeltaMs = Math.max(
        this.simpleGyroAnalysisIntervalMs,
        nowMs - this.simpleGyroCadenceAtMs,
      );
      const alpha = 1 - Math.exp(-updateDeltaMs / this.simpleGyroEmaTauMs);
      this.simpleGyroCadenceRpm += (
        stableCenter - this.simpleGyroCadenceRpm
      ) * alpha;
    } else {
      this.simpleGyroCadenceRpm = stableCenter;
    }
    this.simpleGyroCadenceRpm = clamp(
      this.simpleGyroCadenceRpm,
      this.simpleGyroMinRpm,
      this.simpleGyroMaxRpm,
    );
    this.simpleGyroCadenceConfidence = stableCandidates.reduce(
      (sum, candidate) => sum + candidate.confidence,
      0,
    ) / stableCandidates.length;
    this.simpleGyroCadenceCorrelation = stableCandidates.reduce(
      (sum, candidate) => sum + Math.max(0, candidate.correlation || 0),
      0,
    ) / stableCandidates.length;
    this.simpleGyroCadenceAtMs = nowMs;
    this.simpleGyroCadenceReceivedAtMs = receivedAtMs;
    this.simpleGyroLedgerAtMs = nowMs;
    this.simpleGyroLedgerReceivedAtMs = receivedAtMs;
    this.simpleGyroCadenceMethod = downwardHarmonicRelock
      ? 'downward_harmonic_relock'
      : (stableCandidates.every(
      (candidate) => candidate.method === stableCandidates[0].method,
    )
      ? stableCandidates[0].method
      : (fallback ? 'fallback_consensus' : 'spectral_consensus'));
    if (this.simpleGyroCadenceRpm > 0) {
      this.simpleGyroTrustedFinalRpm = this.simpleGyroCadenceRpm;
      this.simpleGyroTrustedFinalAtMs = nowMs;
    }
    if (lowRate || stableCandidates.some(
      (candidate) => candidate.method.startsWith('low_rate_'),
    )) {
      this.simpleGyroAnalysisState = 'low_rate_locked';
    }
    this.motionState = 'moving';
    this.stateSinceMs = nowMs;
    this.motionEvidenceSinceMs = nowMs;
    this.stillEvidenceSinceMs = null;
    return estimate;
  }

  _rescaleAccelerationState(scaleRatio) {
    if (!(Number.isFinite(scaleRatio) && scaleRatio > 0)
        || Math.abs(scaleRatio - 1) < 1e-9) return;
    if (this.gravity) {
      this.gravity.x *= scaleRatio;
      this.gravity.y *= scaleRatio;
      this.gravity.z *= scaleRatio;
    }
    this.motionScore *= scaleRatio;
    this.cadenceSamples = this.cadenceSamples.map((sample) => ({
      ...sample,
      x: sample.x * scaleRatio,
      y: sample.y * scaleRatio,
      z: sample.z * scaleRatio,
    }));
  }

  _cadenceLagScores(axes, minLag, maxLag) {
    const scores = [];
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      const correlations = axes
        .map((axis) => normalizedAutocorrelation(axis.values, lag))
        .filter(Number.isFinite)
        .sort((left, right) => right - left);
      if (!correlations.length) {
        scores.push({ lag, score: -1, support: 0 });
        continue;
      }
      const positive = correlations.filter((value) => value > 0);
      const best = correlations[0];
      const positiveMean = positive.length
        ? positive.reduce((sum, value) => sum + value, 0) / positive.length
        : 0;
      const support = correlations.filter((value) => value >= 0.35).length;
      const score = best * 0.7
        + positiveMean * 0.2
        + Math.min(1, support / 2) * 0.1;
      scores.push({ lag, score, support });
    }
    return scores;
  }

  _estimateCadenceFromSamples(samplesInput, options = {}) {
    const requestedSampleHz = finite(options.requestedSampleHz, this.sampleHz);
    const amplitudeFloor = Math.max(
      0.001,
      finite(options.amplitudeFloor, this.cadenceMinAmplitudeMps2),
    );
    const cadenceWindow = resampleCadenceWindow(samplesInput, {
      requestedSampleHz,
      minEffectiveSampleHz: this.minEffectiveSampleHz,
      maxEffectiveSampleHz: this.maxEffectiveSampleHz,
    });
    if (!cadenceWindow) return null;
    const samples = cadenceWindow.samples;
    const actualHz = cadenceWindow.sampleHz;
    const coverage = cadenceWindow.coverage;

    const axes = ['x', 'y', 'z']
      .map((key) => robustAxis(samples.map((sample) => sample[key])))
      .filter((axis) => axis && axis.rms >= amplitudeFloor);
    if (!axes.length) return null;

    const minLag = Math.max(2, Math.floor(actualHz * 60 / this.maxCadenceRpm));
    const maxLagByRpm = Math.ceil(actualHz * 60 / this.minCadenceRpm);
    const maxLagByCycles = Math.floor((samples.length - 1) / this.minCadenceCycles);
    const maxLag = Math.min(maxLagByRpm, maxLagByCycles);
    if (maxLag <= minLag + 2) return null;

    const scores = this._cadenceLagScores(axes, minLag, maxLag);
    const peaks = scores.filter((item, index) => {
      const previous = scores[index - 1];
      const next = scores[index + 1];
      return item.score >= this.cadenceMinCorrelation
        && (!previous || item.score >= previous.score)
        && (!next || item.score >= next.score);
    });
    if (!peaks.length) return null;

    const bestScore = Math.max(...peaks.map((item) => item.score));
    // 低采样率下真实曲柄周期通常落在分数 lag 之间，整数 lag 的一次周期
    // 峰会比三次周期峰低约 0.1–0.2。放宽候选集合后仍优先最短可信周期，
    // 后续连续窗稳定门继续阻止随机短峰和倍频跳变。
    const harmonicScoreTolerance = actualHz <= 6.5
      ? 0.25
      : (actualHz <= 12 ? 0.2 : 0.08);
    const eligible = peaks.filter(
      (item) => item.score >= bestScore - harmonicScoreTolerance,
    );
    const previousCadence = this.finalCadenceRpm
      ?? (this.cadenceCandidates.length
        ? this.cadenceCandidates[this.cadenceCandidates.length - 1].rpm
        : null);
    let selected;
    if (Number.isFinite(previousCadence) && actualHz > 6.5) {
      selected = eligible.slice().sort((left, right) => {
        const leftRpm = actualHz * 60 / left.lag;
        const rightRpm = actualHz * 60 / right.lag;
        const leftDistance = Math.abs(Math.log(leftRpm / previousCadence));
        const rightDistance = Math.abs(Math.log(rightRpm / previousCadence));
        return leftDistance - rightDistance || right.score - left.score;
      })[0];
    } else {
      // 自相关在一个周期、两个周期、三个周期处都会产生峰。首次锁定选择
      // 最短的可信周期；5.5–6Hz 时整数 lag 太粗，半频峰可能先锁住，
      // 因此低频窗也重新选择最短可信周期。连续稳定门仍会挡掉随机短峰。
      selected = eligible.slice().sort(
        (left, right) => left.lag - right.lag || right.score - left.score,
      )[0];
    }

    const selectedIndex = scores.findIndex((item) => item.lag === selected.lag);
    const previousScore = scores[selectedIndex - 1];
    const nextScore = scores[selectedIndex + 1];
    let refinedLag = selected.lag;
    if (previousScore && nextScore) {
      const denominator = previousScore.score
        - 2 * selected.score
        + nextScore.score;
      if (Math.abs(denominator) > 1e-6) {
        const offset = clamp(
          0.5 * (previousScore.score - nextScore.score) / denominator,
          -0.5,
          0.5,
        );
        refinedLag += offset;
      }
    }
    const rpm = actualHz * 60 / refinedLag;
    if (!(rpm >= this.minCadenceRpm && rpm <= this.maxCadenceRpm)) return null;

    // 头戴式踩踏周期在低频宿主上常只稳定投影到一个轴。单轴仍必须通过
    // 振幅、自相关、三周期和跨窗稳定门，但不再因缺少第二轴被先验否决。
    const axisAgreement = axes.length === 1
      ? 0.75 : Math.min(1, selected.support / 2);
    const rateQuality = cadenceWindow.timingQuality;
    const confidence = clamp(
      selected.score * 0.55
        + coverage * 0.2
        + axisAgreement * 0.15
        + rateQuality * 0.1,
      0,
      1,
    );
    return {
      rpm,
      confidence,
      correlation: selected.score,
      coverage,
      sampleHz: actualHz,
      effectiveSampleHz: cadenceWindow.effectiveSampleHz,
      source: options.source || 'accelerometer',
    };
  }

  _estimateCadence() {
    const acceleration = this._estimateCadenceFromSamples(this.cadenceSamples, {
      requestedSampleHz: this.sampleHz,
      amplitudeFloor: this.cadenceMinAmplitudeMps2,
      source: 'accelerometer',
    });
    const gyroscope = this._estimateCadenceFromSamples(
      this.gyroscopeCadenceSamples,
      {
        requestedSampleHz: this.gyroscopeSampleHz,
        amplitudeFloor: this.cadenceMinAmplitudeGyroRadS,
        source: 'gyroscope',
      },
    );
    if (!acceleration) return gyroscope;
    if (!gyroscope) return acceleration;

    const center = (acceleration.rpm + gyroscope.rpm) / 2;
    const agreementRpm = Math.abs(acceleration.rpm - gyroscope.rpm);
    const agreementLimit = Math.max(6, center * 0.1);
    if (agreementRpm <= agreementLimit) {
      const accelerationWeight = Math.max(0.01, acceleration.confidence);
      const gyroscopeWeight = Math.max(0.01, gyroscope.confidence);
      const weight = accelerationWeight + gyroscopeWeight;
      return {
        rpm: (
          acceleration.rpm * accelerationWeight
          + gyroscope.rpm * gyroscopeWeight
        ) / weight,
        confidence: clamp(
          (acceleration.confidence + gyroscope.confidence) / 2 + 0.08,
          0,
          1,
        ),
        correlation: (
          acceleration.correlation + gyroscope.correlation
        ) / 2,
        coverage: Math.min(acceleration.coverage, gyroscope.coverage),
        sampleHz: Math.max(acceleration.sampleHz, gyroscope.sampleHz),
        effectiveSampleHz: Math.max(
          acceleration.effectiveSampleHz,
          gyroscope.effectiveSampleHz,
        ),
        source: 'fused',
      };
    }

    // 两路短时不一致时保留更可信的一路，但降低置信度；跨窗稳定门会继续
    // 阻止道路颠簸或一次转头造成的倍频跳变。
    const selected = acceleration.confidence * acceleration.correlation
      >= gyroscope.confidence * gyroscope.correlation
      ? acceleration : gyroscope;
    return {
      ...selected,
      confidence: clamp(selected.confidence - 0.08, 0, 1),
    };
  }

  _hasCadenceAnalysisEnergy(nowMs) {
    const energyWindowMs = Math.min(this.cadenceWindowMs, 1800);
    const accelerationRms = recentMaxAxisRms(
      this.cadenceSamples,
      nowMs,
      energyWindowMs,
    );
    if (accelerationRms >= this.cadenceMinAmplitudeMps2 * 0.6) return true;
    const gyroscopeRms = recentMaxAxisRms(
      this.gyroscopeCadenceSamples,
      nowMs,
      energyWindowMs,
    );
    return gyroscopeRms >= this.cadenceMinAmplitudeGyroRadS * 0.6;
  }

  _cadenceInputsReadyForAnalysis() {
    const ready = (samples) => samples.length >= DEFAULT_CADENCE_MIN_SAMPLES
      && samples[samples.length - 1].timestampMs
        - samples[0].timestampMs >= 2800;
    return ready(this.cadenceSamples)
      || ready(this.gyroscopeCadenceSamples);
  }

  _setStationaryCadence() {
    this._clearSimpleGyroCadence(true, true);
    // 已确认静止的零能量历史不能帮助下一段运动提前满足 2.8 秒整窗门。
    // 原始回调仍逐帧接收；新运动会从下一帧重新积累并由周期门自行唤醒。
    this.cadenceSamples = [];
    this.gyroscopeCadenceSamples = [];
    this.simpleGyroTouchDisplayRpm = null;
    this.simpleGyroTouchDisplayConfidence = 0;
    this.simpleGyroTouchDisplayCorrelation = null;
    this.simpleGyroTouchDisplayUntilReceivedAtMs = null;
    this.cadenceCandidates = [];
    this.candidateCadenceRpm = 0;
    this.finalCadenceRpm = 0;
    this.cadenceConfidence = 1;
    this.cadenceCorrelation = 1;
    this.cadenceState = 'stationary';
    this.lastCadenceEvidenceMs = null;
    this.provisionalCadenceRpm = 0;
    this.provisionalCadenceConfidence = 1;
    this.provisionalCadenceAtMs = null;
    this.provisionalCadenceSource = 'stationary';
    this.cadenceSensorSource = 'stationary';
  }

  _pruneCadenceCandidates(nowMs) {
    const candidates = this.cadenceCandidates;
    if (!candidates.length) return 0;
    let writeIndex = 0;
    for (let readIndex = 0; readIndex < candidates.length; readIndex += 1) {
      const item = candidates[readIndex];
      if (!item || !Number.isFinite(item.atMs)
          || nowMs < item.atMs
          || nowMs - item.atMs > this.cadenceCandidateMaxAgeMs) continue;
      candidates[writeIndex] = item;
      writeIndex += 1;
    }
    const removed = candidates.length - writeIndex;
    candidates.length = writeIndex;
    return removed;
  }

  _clearCadenceEstimate(state = 'unknown', options = {}) {
    const preserveCandidates = options.preserveCandidates === true;
    if (!preserveCandidates) this.cadenceCandidates = [];
    const latest = preserveCandidates && this.cadenceCandidates.length
      ? this.cadenceCandidates[this.cadenceCandidates.length - 1]
      : null;
    this.candidateCadenceRpm = latest ? latest.rpm : null;
    this.finalCadenceRpm = null;
    this.cadenceConfidence = 0;
    this.cadenceCorrelation = null;
    this.cadenceState = state;
    this.lastCadenceEvidenceMs = null;
    if (options.clearProvisional === true) {
      this.provisionalCadenceRpm = null;
      this.provisionalCadenceConfidence = 0;
      this.provisionalCadenceAtMs = null;
      this.provisionalCadenceSource = 'none';
      this.cadenceSensorSource = 'none';
    }
  }

  _rejectCadenceArtifact(
    nowMs,
    artifact,
    triggerSource = this.lastCadenceAnalysisSource,
  ) {
    // 骑行时颠簸和短时转头非常常见。它们只冻结新证据，不能像旧实现那样
    // 每一帧都清空已经形成的候选/final；否则粗糙路面会永久显示未知。
    // 扶镜触碰仍视为硬中断，因为它会直接给镜架施加非骑行周期。
    if (artifact === 'touch') {
      this._clearCadenceEstimate('artifact', {
        preserveCandidates: false,
        clearProvisional: true,
      });
      this.lastCadenceAnalysisMs = nowMs;
      this.lastCadenceAnalysisSource = triggerSource;
      if (this.lastCadenceAnalysisMsBySource
          && Object.prototype.hasOwnProperty.call(
            this.lastCadenceAnalysisMsBySource,
            triggerSource,
          )) {
        this.lastCadenceAnalysisMsBySource[triggerSource] = nowMs;
      }
      return;
    }
    if (this.finalCadenceRpm > 0) {
      this.cadenceState = 'artifact';
      return;
    }
    if (this.cadenceCandidates.length > 0) {
      const latest = this.cadenceCandidates[this.cadenceCandidates.length - 1];
      this.candidateCadenceRpm = latest.rpm;
      this.cadenceConfidence = latest.confidence;
      this.cadenceState = 'artifact';
    }
  }

  _updateCadenceEstimate(nowMs, triggerSource = 'accelerometer') {
    if (!this._cadenceInputsReadyForAnalysis()) return;
    const analysisSource = triggerSource === 'gyroscope'
      ? 'gyroscope' : 'accelerometer';
    const lastSourceAnalysisMs = this.lastCadenceAnalysisMsBySource[
      analysisSource
    ];
    // 独立 Generic Sensor 时间轴必须独立节流；某一路无 timestamp 的批量
    // 虚拟轴可以领先墙钟，但不能饿死另一条刚恢复的传感器。
    if (lastSourceAnalysisMs != null
        && nowMs - lastSourceAnalysisMs < this.cadenceAnalysisIntervalMs) {
      return;
    }
    // 三路 Generic Sensor 有各自的归一化时间轴。绝对差在同一节流窗内时
    // 视为同一批回调，只允许第一路触发昂贵融合；较早时间轴若相差很大则
    // 仍可接管，保留传感器重建/新纪元后的恢复能力。
    if (this.lastCadenceAnalysisMs != null
        && Math.abs(nowMs - this.lastCadenceAnalysisMs)
          < this.cadenceAnalysisIntervalMs) {
      return;
    }
    // Raw ingestion keeps at most one second of bounded slack. Immediately
    // before any expensive fusion pass, restore the exact configured windows.
    const cadenceCutoff = nowMs - this.cadenceWindowMs;
    if (this.cadenceSamples.length
        && this.cadenceSamples[0].timestampMs < cadenceCutoff) {
      this._trimTimedSamples(this.cadenceSamples, cadenceCutoff);
    }
    if (this.gyroscopeCadenceSamples.length
        && this.gyroscopeCadenceSamples[0].timestampMs < cadenceCutoff) {
      this._trimTimedSamples(this.gyroscopeCadenceSamples, cadenceCutoff);
    }
    if (!this._cadenceInputsReadyForAnalysis()) return;
    // Candidate expiry is likewise an analysis-rate operation. The default
    // gate holds only two entries, so prune in place without filter allocation.
    this._pruneCadenceCandidates(nowMs);
    this.lastCadenceAnalysisMsBySource[analysisSource] = nowMs;
    this.lastCadenceAnalysisMs = nowMs;
    this.lastCadenceAnalysisSource = analysisSource;
    if (!this._hasCadenceAnalysisEnergy(nowMs)) {
      const preserveCandidates = this.cadenceCandidates.length > 0;
      if (this.motionState === 'stationary' && !preserveCandidates) {
        if (this.cadenceState !== 'stationary') this._setStationaryCadence();
        return;
      }
      const warming = this.cadenceSamples.length < DEFAULT_CADENCE_MIN_SAMPLES
        || (this.cadenceSamples.length > 1
          && nowMs - this.cadenceSamples[0].timestampMs < 2200);
      this._clearCadenceEstimate(warming ? 'warming' : 'unknown', {
        preserveCandidates,
      });
      return;
    }
    const estimate = this._estimateCadence();
    if (!estimate || estimate.confidence < this.cadenceMinConfidence) {
      const preserveCandidates = this.cadenceCandidates.length > 0;
      if (this.motionState === 'stationary' && !preserveCandidates) {
        if (this.cadenceState !== 'stationary') this._setStationaryCadence();
        return;
      }
      if (this.finalCadenceRpm > 0
          && this.lastCadenceEvidenceMs != null
          && nowMs - this.lastCadenceEvidenceMs <= Math.max(
            2500,
            this.cadenceAnalysisIntervalMs * 3,
          )) {
        this.cadenceState = 'estimated';
        return;
      }
      const warming = this.cadenceSamples.length < DEFAULT_CADENCE_MIN_SAMPLES
        || (this.cadenceSamples.length > 1
          && nowMs - this.cadenceSamples[0].timestampMs < 2200);
      // 一个低频/抖动分析窗丢失时撤销 final，停止指标积分，但保留最近
      // 候选供后续窗完成连续时间稳定门；超过 age 后自动清空。
      this._clearCadenceEstimate(warming ? 'warming' : 'unknown', {
        preserveCandidates,
      });
      return;
    }

    const candidate = {
      rpm: estimate.rpm,
      confidence: estimate.confidence,
      atMs: nowMs,
      source: estimate.source,
    };
    this.candidateCadenceRpm = estimate.rpm;
    this.cadenceConfidence = estimate.confidence;
    this.cadenceCorrelation = estimate.correlation;
    this.provisionalCadenceRpm = estimate.rpm;
    this.provisionalCadenceConfidence = estimate.confidence;
    this.provisionalCadenceAtMs = nowMs;
    this.provisionalCadenceSource = estimate.source;
    this.cadenceCandidates.push(candidate);
    const excessCandidates = this.cadenceCandidates.length
      - this.cadenceStableWindows;
    if (excessCandidates > 0) {
      this.cadenceCandidates.splice(0, excessCandidates);
    }

    if (this.cadenceCandidates.length < this.cadenceStableWindows) {
      this.finalCadenceRpm = null;
      this.cadenceState = 'warming';
      return;
    }

    const values = this.cadenceCandidates.map((item) => item.rpm);
    const center = median(values);
    const tolerance = Math.max(4, center * 0.1);
    const stable = values.every((value) => Math.abs(value - center) <= tolerance);
    if (!stable) {
      this.finalCadenceRpm = null;
      this.cadenceState = 'warming';
      return;
    }
    this.finalCadenceRpm = center;
    this.cadenceConfidence = this.cadenceCandidates.reduce(
      (sum, item) => sum + item.confidence,
      0,
    ) / this.cadenceCandidates.length;
    this.cadenceState = 'estimated';
    this.lastCadenceEvidenceMs = nowMs;
    const candidateSources = new Set(
      this.cadenceCandidates.map((item) => item.source).filter(Boolean),
    );
    this.cadenceSensorSource = candidateSources.size === 1
      ? [...candidateSources][0] : 'fused';
    // 稳定的多周期证据比通用“动态量 > 0.18m/s²”门更贴近头戴骑行场景。
    // 弱但高度周期的踩踏波形可自行确认运动；随机道路冲击仍须先通过自相关、
    // 振幅、置信度和连续窗口四重门。
    if (this.motionState !== 'moving') {
      this.motionState = 'moving';
      this.stateSinceMs = this.cadenceCandidates[0].atMs;
    }
    this.motionEvidenceSinceMs = this.cadenceCandidates[0].atMs;
    this.stillEvidenceSinceMs = null;
  }

  /**
   * AIUI Accelerometer reading 事件的便捷入口。返回可直接交给
   * CyclingMetrics.onImuActivity() 的活动快照；无效样本返回 null。
   */
  onReading(sample, nowMs = null) {
    if (!sample || typeof sample !== 'object') return null;
    const x = Number(sample.x);
    const y = Number(sample.y);
    const z = Number(sample.z);
    if (![x, y, z].every(Number.isFinite)) return null;
    const receivedAt = Number.isFinite(nowMs) ? nowMs : Date.now();
    const rawTimestamp = sample.timestamp ?? sample.timestampMs;
    const at = this.sensorClock.normalize(rawTimestamp, receivedAt);
    this.accelerationCalibrator.push(x, y, z, at);
    const scaleToMps2 = this.accelerationCalibrator.scaleToMps2;
    const accelerationX = x * scaleToMps2;
    const accelerationY = y * scaleToMps2;
    const accelerationZ = z * scaleToMps2;

    if (scaleToMps2 !== this.accelerationScaleToMps2) {
      const previousScaleToMps2 = this.accelerationScaleToMps2;
      this.accelerationScaleToMps2 = scaleToMps2;
      // 单位从 unknown 切换为 g 时，把已有重力、运动分数和周期窗原位
      // 换算到 m/s²；不能清空已覆盖的前一秒，否则低频眼镜无法在约 5 秒
      // 内形成 final。频率和相位不受常数比例换算影响。
      this._rescaleAccelerationState(
        scaleToMps2 / previousScaleToMps2,
      );
      if (this.motionQualityGate
          && typeof this.motionQualityGate.reset === 'function') {
        this.motionQualityGate.reset();
      }
    }
    const qualityResult = this.motionQualityGate
      ? this.motionQualityGate.pushAcceleration(
        accelerationX,
        accelerationY,
        accelerationZ,
        at,
      )
      : null;
    const motionQuality = qualityResult && qualityResult.quality
      && typeof qualityResult.quality === 'object'
      ? qualityResult.quality : null;
    if (!this.onSample({
      x: accelerationX,
      y: accelerationY,
      z: accelerationZ,
      timestampMs: at,
    }, at, motionQuality, receivedAt)) return null;
    return this.snapshot(at, receivedAt);
  }

  /**
   * 输入已经归一化到 rad/s 的陀螺仪样本。陀螺仪既参与转头/触碰质量门，
   * 也作为头戴骑行周期的第二路正向证据；没有 Accelerometer 回调时仍可
   * 形成明确标记的低优先级踏频估算。
   */
  onGyroscopeSample(
    sample,
    nowMs = null,
    motionQuality = null,
    receivedAtMs = null,
  ) {
    if (!sample || typeof sample !== 'object') return null;
    const x = Number(sample.x);
    const y = Number(sample.y);
    const z = Number(sample.z);
    const at = Number.isFinite(nowMs) ? nowMs : Number(sample.timestampMs);
    if (![x, y, z, at].every(Number.isFinite)) return null;
    if (this.lastGyroscopeSampleMs != null
        && at <= this.lastGyroscopeSampleMs) return null;
    const receivedAt = Number.isFinite(receivedAtMs) ? receivedAtMs : at;
    const previousAt = this.lastGyroscopeSampleMs;
    this.lastGyroscopeSampleMs = at;
    this.lastGyroscopeReceivedAtMs = receivedAt;
    this.lastSampleMs = this.lastSampleMs == null
      ? at : Math.max(this.lastSampleMs, at);
    if (this.lastReceivedAtMs == null || receivedAt >= this.lastReceivedAtMs) {
      this.lastReceivedAtMs = receivedAt;
    }
    this.lastMotionQuality = motionQuality && typeof motionQuality === 'object'
      ? motionQuality : this.lastMotionQuality;

    const magnitude = vectorLength(x, y, z);
    const gyroStillThreshold = Math.max(
      0.001,
      this.simpleGyroMinRms * 0.65,
    );
    const dtMs = previousAt == null ? 0 : clamp(at - previousAt, 5, 250);
    if (previousAt == null) {
      this.gyroscopeMotionScore = magnitude;
      this.gyroscopeStillEvidenceSinceMs = magnitude <= gyroStillThreshold
        ? at : null;
    } else {
      const alpha = 1 - Math.exp(-dtMs / this.scoreTauMs);
      this.gyroscopeMotionScore += (
        magnitude - this.gyroscopeMotionScore
      ) * alpha;
      if (this.gyroscopeMotionScore <= gyroStillThreshold) {
        if (this.gyroscopeStillEvidenceSinceMs == null) {
          this.gyroscopeStillEvidenceSinceMs = at;
        }
      } else {
        this.gyroscopeStillEvidenceSinceMs = null;
      }
    }

    const artifact = this.lastMotionQuality
      && typeof this.lastMotionQuality.artifact === 'string'
      ? this.lastMotionQuality.artifact : 'none';
    if (artifact === 'touch') {
      this._holdSimpleGyroDisplayOnTouch(receivedAt);
      this._clearSimpleGyroCadence(true, true);
      this.simpleGyroAnalysisState = 'touch_blocked';
      this._rejectCadenceArtifact(at, artifact, 'gyroscope');
      return this.snapshot(at, receivedAt);
    }

    const simpleGyroAlreadyFresh = this.simpleGyroCadenceRpm > 0
      && this.simpleGyroCadenceAtMs != null
      && at >= this.simpleGyroCadenceAtMs
      && at - this.simpleGyroCadenceAtMs <= this.simpleGyroHoldMs;
    const downwardRelockAnchorFresh = this.simpleGyroTrustedFinalRpm >= 110
      && this.simpleGyroTrustedFinalAtMs != null
      && at >= this.simpleGyroTrustedFinalAtMs
      && at - this.simpleGyroTrustedFinalAtMs
        <= this.simpleGyroDownwardRelockAnchorMs;
    // 恢复 v0.1.11/v0.1.12 真机可见通道的顺序：除 touch 外，初次锁定前
    // soft artifact 也必须进入独立短窗。骑行路面会让通用质量门长时间报
    // road_impact/head_turn；若在这里提前 return，窗口会一直只有零散干净帧，
    // 即使传感器与上传都正常，踏频、速度、里程也永远无法形成。
    this._recordSimpleGyroscopeSample(at, x, y, z);
    this._updateSimpleGyroCadence(at, receivedAt, {
      allowFinalRewrite: artifact === 'none' || !simpleGyroAlreadyFresh,
      // 已有可信 simple final 后，road_impact/head_turn 仍可提供专用低帧率
      // finalEligible 周期证据；只有满足向下半频的严格跨窗门才允许改写。
      allowLowRateFinal: artifact === 'none'
        || simpleGyroAlreadyFresh
        || downwardRelockAnchorFresh,
      downwardRelockEvidenceOnly: artifact !== 'none'
        && !simpleGyroAlreadyFresh
        && downwardRelockAnchorFresh,
      artifact,
    });
    if (artifact !== 'none') {
      // 复杂 Accel/Gyro 融合窗继续冻结，避免转头或冲击改写其候选；独立
      // 简易通道仍必须自行通过周期、频谱、谐波和跨窗门，不能凭 artifact
      // 标签直接造数。
      this._rejectCadenceArtifact(at, artifact, 'gyroscope');
      return this.snapshot(at, receivedAt);
    }

    this._recordGyroscopeCadenceSample(at, x, y, z);
    const accelerationFresh = this.lastAccelerationReceivedAtMs != null
      && receivedAt >= this.lastAccelerationReceivedAtMs
      && receivedAt - this.lastAccelerationReceivedAtMs <= this.staleMs;
    // Accelerometer 有新鲜回调时由它作为唯一分析触发器，Gyroscope 只向
    // 同一估算窗补正向证据；主路暂时无帧时再由 Gyroscope 接管触发。
    // 这样不会因两路交错回调把同一时间窗重复计成多个稳定候选。
    if (!accelerationFresh) {
      this._updateCadenceEstimate(at, 'gyroscope');
    }

    const gyroStillConfirmMs = (this.simpleGyroCadenceRpm > 0
        || this.finalCadenceRpm > 0)
      ? Math.min(this.stationaryConfirmMs, 800)
      : this.stationaryConfirmMs;
    const gyroStillConfirmed = this.gyroscopeStillEvidenceSinceMs != null
      && at >= this.gyroscopeStillEvidenceSinceMs
      && at - this.gyroscopeStillEvidenceSinceMs >= gyroStillConfirmMs;
    if (!accelerationFresh && gyroStillConfirmed) {
      // Clearing hundreds of samples is a state transition, not a per-frame
      // stationary maintenance operation. Gyro-only idle streams can otherwise
      // invoke this branch at the raw 50Hz callback rate forever. A live low-
      // energy stream is stronger evidence than the 6-second AR dropout hold.
      if (this.motionState !== 'stationary') {
        this.motionState = 'stationary';
        this.stateSinceMs = this.gyroscopeStillEvidenceSinceMs;
        this.motionEvidenceSinceMs = null;
        this.stillEvidenceSinceMs = this.gyroscopeStillEvidenceSinceMs;
        this._setStationaryCadence();
      }
    } else if (!accelerationFresh && this.finalCadenceRpm > 0) {
      this.motionState = 'moving';
      this.motionEvidenceSinceMs = this.lastCadenceEvidenceMs ?? at;
      this.stillEvidenceSinceMs = null;
    }
    return this.snapshot(at, receivedAt);
  }

  onGyroscopeReading(sample, nowMs = null) {
    if (!sample || typeof sample !== 'object') return null;
    const x = Number(sample.x);
    const y = Number(sample.y);
    const z = Number(sample.z);
    if (![x, y, z].every(Number.isFinite)) return null;
    const receivedAt = Number.isFinite(nowMs) ? nowMs : Date.now();
    const rawTimestamp = sample.timestamp ?? sample.timestampMs;
    const at = this.gyroscopeClock.normalize(rawTimestamp, receivedAt);
    const qualityResult = this.motionQualityGate
      ? this.motionQualityGate.pushGyro(x, y, z, at)
      : null;
    const motionQuality = qualityResult && qualityResult.quality
      && typeof qualityResult.quality === 'object'
      ? qualityResult.quality : null;
    return this.onGyroscopeSample(
      { x, y, z, timestampMs: at },
      at,
      motionQuality,
      receivedAt,
    );
  }

  _updateEvidence(nowMs) {
    const simpleGyroFresh = this.simpleGyroCadenceRpm > 0
      && this.simpleGyroCadenceAtMs != null
      && nowMs >= this.simpleGyroCadenceAtMs
      && nowMs - this.simpleGyroCadenceAtMs <= this.simpleGyroHoldMs;
    const gyroStillConfirmMs = (this.simpleGyroCadenceRpm > 0
        || this.finalCadenceRpm > 0)
      ? Math.min(this.stationaryConfirmMs, 800)
      : this.stationaryConfirmMs;
    const currentGyroStillConfirmed = this.gyroscopeStillEvidenceSinceMs != null
      && nowMs >= this.gyroscopeStillEvidenceSinceMs
      && nowMs - this.gyroscopeStillEvidenceSinceMs
        >= gyroStillConfirmMs;
    // 6 秒 simple hold 只保护“宿主没有继续派帧”的录屏断流。若陀螺仪
    // 仍持续回调且已经确认低能量静止，旧周期不得反过来阻止静止状态。
    const periodicMotionFresh = !currentGyroStillConfirmed && (simpleGyroFresh
      || (this.finalCadenceRpm > 0
        && this.lastCadenceEvidenceMs != null
        && nowMs - this.lastCadenceEvidenceMs
          <= Math.max(this.staleMs, this.cadenceAnalysisIntervalMs * 3)));
    if (periodicMotionFresh) {
      if (this.motionState !== 'moving') {
        this.motionState = 'moving';
        this.stateSinceMs = simpleGyroFresh
          ? this.simpleGyroCadenceAtMs : this.lastCadenceEvidenceMs;
      }
      this.motionEvidenceSinceMs = simpleGyroFresh
        ? this.simpleGyroCadenceAtMs : this.lastCadenceEvidenceMs;
      this.stillEvidenceSinceMs = null;
      return;
    }
    if (this.motionScore >= this.motionThreshold) {
      if (this.motionEvidenceSinceMs == null) this.motionEvidenceSinceMs = nowMs;
      this.stillEvidenceSinceMs = null;
      if (nowMs - this.motionEvidenceSinceMs >= this.movingConfirmMs) {
        if (this.motionState !== 'moving') {
          this.motionState = 'moving';
          this.stateSinceMs = this.motionEvidenceSinceMs;
        }
      }
      return;
    }

    if (this.motionScore <= this.stillThreshold) {
      if (this.stillEvidenceSinceMs == null) this.stillEvidenceSinceMs = nowMs;
      this.motionEvidenceSinceMs = null;
      if (nowMs - this.stillEvidenceSinceMs >= this.stationaryConfirmMs) {
        if (this.motionState !== 'stationary') {
          this.motionState = 'stationary';
          this.stateSinceMs = this.stillEvidenceSinceMs;
        }
      }
      return;
    }

    // 阈值中间带只保留已确认状态，不累计新的确认时长，避免道路单次冲击抖动。
    this.motionEvidenceSinceMs = null;
    this.stillEvidenceSinceMs = null;
  }

  /**
   * 页面确认执行暂停/恢复后告知分类器。分类器只给建议，不直接改会话状态。
   */
  setSessionPaused(paused) {
    this.sessionPaused = Boolean(paused);
  }

  snapshot(nowMs, receivedNowMs = null) {
    const requestedAt = Number.isFinite(nowMs)
      ? nowMs
      : (this.lastSampleMs == null ? this.stateSinceMs : this.lastSampleMs);
    // 有原始 sensor timestamp 的批量帧可能暂时领先 Date.now()。状态机继续
    // 使用传感器单调轴；freshness 只看最后一次真实回调的接收墙钟。
    const at = this.lastSampleMs != null && requestedAt < this.lastSampleMs
      ? this.lastSampleMs : requestedAt;
    const receivedAt = Number.isFinite(receivedNowMs)
      ? receivedNowMs
      : (Number.isFinite(nowMs)
        ? nowMs
        : (this.lastReceivedAtMs == null ? at : this.lastReceivedAtMs));
    const fresh = this.lastReceivedAtMs != null
      && receivedAt >= this.lastReceivedAtMs
      && receivedAt - this.lastReceivedAtMs <= this.staleMs;
    const simpleGyroFresh = fresh
      && this.simpleGyroCadenceRpm > 0
      && this.simpleGyroCadenceReceivedAtMs != null
      && receivedAt >= this.simpleGyroCadenceReceivedAtMs
      && receivedAt - this.simpleGyroCadenceReceivedAtMs
        <= this.simpleGyroHoldMs;
    // HUD 保持只看最后锁定值的年龄，不依赖全局 1.5 秒 sensor fresh。
    // cadenceUsable/ledger 仍在下方使用 fresh + 1.8 秒新证据，因此录屏
    // 掉帧期间数字不闪零，但距离严格冻结。
    const simpleGyroDisplayFresh = this.simpleGyroCadenceRpm > 0
      && this.simpleGyroCadenceReceivedAtMs != null
      && receivedAt >= this.simpleGyroCadenceReceivedAtMs
      && receivedAt - this.simpleGyroCadenceReceivedAtMs
        <= this.simpleGyroHoldMs;
    const simpleGyroLedgerFresh = fresh
      && this.simpleGyroLedgerReceivedAtMs != null
      && receivedAt >= this.simpleGyroLedgerReceivedAtMs
      && receivedAt - this.simpleGyroLedgerReceivedAtMs
        <= this.simpleGyroLedgerHoldMs;
    const simpleGyroCandidateFresh = fresh
      && this.simpleGyroCandidateRpm > 0
      && this.simpleGyroCandidateReceivedAtMs != null
      && receivedAt >= this.simpleGyroCandidateReceivedAtMs
      && receivedAt - this.simpleGyroCandidateReceivedAtMs
        <= this.simpleGyroCandidateHoldMs;
    const touchDisplayFresh = fresh
      && this.simpleGyroTouchDisplayRpm > 0
      && this.simpleGyroTouchDisplayUntilReceivedAtMs != null
      && receivedAt <= this.simpleGyroTouchDisplayUntilReceivedAtMs;
    const visibleCandidateFresh = simpleGyroCandidateFresh
      || touchDisplayFresh;
    const rawMotionArtifact = this.lastMotionQuality
      ? this.lastMotionQuality.artifact : 'none';
    const complexCadenceHoldFresh = fresh
      && this.finalCadenceRpm > 0
      && this.lastCadenceEvidenceMs != null
      && at >= this.lastCadenceEvidenceMs
      && at - this.lastCadenceEvidenceMs <= this.simpleGyroHoldMs;
    const softArtifactCadenceHold = rawMotionArtifact !== 'none'
      && rawMotionArtifact !== 'touch'
      && (simpleGyroFresh || complexCadenceHoldFresh);
    const state = simpleGyroFresh
      ? 'moving'
      : (fresh
      ? this.motionState
      : (this.lastSampleMs == null ? 'unknown' : 'stale'));

    let confidence = 0;
    if (fresh && state === 'moving') {
      confidence = clamp(
        (this.motionScore - this.stillThreshold)
          / Math.max(0.001, this.motionThreshold - this.stillThreshold),
        0,
        1,
      );
    } else if (fresh && state === 'stationary') {
      confidence = clamp(
        1 - this.motionScore / Math.max(0.001, this.motionThreshold),
        0,
        1,
      );
    }
    if (simpleGyroFresh) {
      confidence = Math.max(confidence, this.simpleGyroCadenceConfidence);
    }

    const autoPauseSuggested = fresh
      && !this.sessionPaused
      && this.stillEvidenceSinceMs != null
      && at - this.stillEvidenceSinceMs >= this.autoPauseAfterMs;
    const autoResumeSuggested = fresh
      && this.sessionPaused
      && this.motionEvidenceSinceMs != null
      && at - this.motionEvidenceSinceMs >= this.autoResumeAfterMs;
    const cadenceState = simpleGyroDisplayFresh
      ? (fresh ? 'estimated' : 'holding')
      : (softArtifactCadenceHold
        ? 'estimated'
      : (fresh && this.finalCadenceRpm > 0
        ? this.cadenceState
        : (visibleCandidateFresh
          ? 'warming'
          : (fresh
          ? this.cadenceState
          : (this.lastSampleMs == null ? 'warming' : 'stale')))));
    const candidateCadenceRpm = simpleGyroDisplayFresh
      ? this.simpleGyroCadenceRpm
      : (simpleGyroCandidateFresh
        ? this.simpleGyroCandidateRpm
        : (touchDisplayFresh
          ? this.simpleGyroTouchDisplayRpm
          : (fresh ? this.candidateCadenceRpm : null)));
    const finalCadenceRpm = simpleGyroDisplayFresh
      ? this.simpleGyroCadenceRpm
      : (fresh ? this.finalCadenceRpm : null);
    const cadenceConfidence = simpleGyroDisplayFresh
      ? this.simpleGyroCadenceConfidence
      : (simpleGyroCandidateFresh
        ? this.simpleGyroCandidateConfidence
        : (touchDisplayFresh
          ? this.simpleGyroTouchDisplayConfidence
          : (fresh ? this.cadenceConfidence : 0)));
    const provisionalFresh = fresh
      && this.provisionalCadenceRpm > 0
      && this.provisionalCadenceAtMs != null
      && at - this.provisionalCadenceAtMs <= this.provisionalCadenceHoldMs;
    const effectiveCadenceRpm = finalCadenceRpm > 0
      ? finalCadenceRpm
      : (simpleGyroCandidateFresh
        ? this.simpleGyroCandidateRpm
        : (touchDisplayFresh
          ? this.simpleGyroTouchDisplayRpm
          : (provisionalFresh ? this.provisionalCadenceRpm
            : (finalCadenceRpm === 0 ? 0 : null))));
    const effectiveCadenceConfidence = finalCadenceRpm > 0
      ? cadenceConfidence
      : (simpleGyroCandidateFresh
        ? this.simpleGyroCandidateConfidence
        : (touchDisplayFresh
          ? this.simpleGyroTouchDisplayConfidence
          : (provisionalFresh
            ? this.provisionalCadenceConfidence : cadenceConfidence)));
    const cadenceEstimateLevel = finalCadenceRpm > 0
      ? 'locked'
      : (visibleCandidateFresh || provisionalFresh ? 'candidate'
        : (effectiveCadenceRpm === 0 ? 'stationary' : 'none'));
    const walkingAssessment = assessWalkingLikeCadence(
      effectiveCadenceRpm,
      this.walkingImpactTimestampsMs,
      at,
    );
    if (walkingAssessment.walkingLike
        && rawMotionArtifact !== 'touch') {
      this.walkingLikeUntilMs = at + DEFAULT_IMU_WALKING_LATCH_MS;
      this.walkingLikeConfidence = walkingAssessment.confidence;
    }
    const walkingLike = effectiveCadenceRpm > 0
      && this.walkingLikeUntilMs != null
      && at <= this.walkingLikeUntilMs;
    if (!walkingLike && this.walkingLikeUntilMs != null
        && at > this.walkingLikeUntilMs) {
      this.walkingLikeUntilMs = null;
      this.walkingLikeConfidence = 0;
    }
    // HUD 最多保持 6 秒；速度/里程账本只认最近 1.8 秒内重新通过周期门的
    // ledger 证据。这样颠簸不会让界面立刻归零，也不会无限积分冻结值。
    const motionArtifact = (
      (simpleGyroFresh && simpleGyroLedgerFresh)
      || complexCadenceHoldFresh
    )
      && rawMotionArtifact !== 'touch'
      ? 'none' : rawMotionArtifact;
    const cadenceUsable = fresh
      && finalCadenceRpm > 0
      && (!simpleGyroFresh || simpleGyroLedgerFresh)
      && motionArtifact === 'none';
    const simpleCandidateMethod = simpleGyroCandidateFresh
      ? this.simpleGyroCandidateMethod : '';
    const strongSimpleCandidate = !simpleGyroCandidateFresh || [
      'spectral',
      'spectral_crossing',
      'spectral_harmonic',
      'low_rate_timestamp_consensus',
      'low_rate_timestamp_harmonic_consensus',
      'fallback_crossing',
    ].includes(simpleCandidateMethod);
    // 强 candidate 已通过周期/振幅/采样率门，不再等待 final 才给用户看数。
    // 宽松 fallback_autocorrelation 仍只留诊断，避免随机白噪声入账。
    // touch 与明确静止立即撤销，防止扶镜动作继续累计。
    const availabilityCadenceUsable = fresh
      && effectiveCadenceRpm > 0
      && effectiveCadenceConfidence >= 0.55
      && cadenceEstimateLevel === 'candidate'
      && strongSimpleCandidate
      && motionArtifact !== 'touch';
    const speedCadenceRpm = finalCadenceRpm > 0
      ? finalCadenceRpm
      : (availabilityCadenceUsable
        ? effectiveCadenceRpm : (finalCadenceRpm === 0 ? 0 : null));
    const estimatedSpeedKmh = estimateImuFallbackSpeedKmh(
      speedCadenceRpm,
      {
        walkingLike,
        estimateLevel: cadenceEstimateLevel,
        metersPerCrank: cadenceEstimateLevel === 'candidate'
          ? DEFAULT_IMU_METERS_PER_CRANK : this.metersPerCrank,
      },
    );

    return {
      motionState: state,
      motionScore: this.motionScore,
      confidence,
      fresh,
      lastSampleMs: this.lastSampleMs,
      lastReceivedAtMs: this.lastReceivedAtMs,
      autoPauseSuggested,
      autoResumeSuggested,
      accelerationUnit: this.accelerationCalibrator.sourceUnit,
      accelerationScaleToMps2: this.accelerationCalibrator.scaleToMps2,
      accelerationCalibrated:
        this.accelerationCalibrator.sourceUnit !== ACCELERATION_SOURCE_UNIT.UNKNOWN,
      sensorTimestampScaleToMs: this.sensorClock.rawScaleToMs,
      candidateCadenceRpm,
      finalCadenceRpm,
      effectiveCadenceRpm,
      cadenceConfidence,
      effectiveCadenceConfidence,
      cadenceCorrelation: simpleGyroFresh
        ? this.simpleGyroCadenceCorrelation
        : (fresh ? this.cadenceCorrelation : null),
      cadenceState,
      cadenceEstimateLevel,
      cadenceSensorSource: simpleGyroDisplayFresh
        ? (fresh ? 'gyroscope_simple' : 'gyroscope_simple_hold')
        : (finalCadenceRpm > 0
          ? this.cadenceSensorSource
          : (simpleGyroCandidateFresh
            ? 'gyroscope_simple_candidate'
            : (touchDisplayFresh
              ? 'gyroscope_touch_hold'
              : (provisionalFresh ? this.provisionalCadenceSource : 'none')))),
      cadenceUsable,
      availabilityCadenceUsable,
      estimatedSpeedKmh,
      walkingLike,
      walkingLikeConfidence: walkingLike ? this.walkingLikeConfidence : 0,
      speedEstimateProfile: imuFallbackSpeedProfile(
        speedCadenceRpm,
        {
          walkingLike,
          estimateLevel: cadenceEstimateLevel,
          metersPerCrank: cadenceEstimateLevel === 'candidate'
            ? DEFAULT_IMU_METERS_PER_CRANK : this.metersPerCrank,
        },
      ),
      gyroscopeFresh: this.lastGyroscopeReceivedAtMs != null
        && receivedAt >= this.lastGyroscopeReceivedAtMs
        && receivedAt - this.lastGyroscopeReceivedAtMs <= this.staleMs,
      gyroscopeSampleCount: this.gyroscopeCadenceSamples.length,
      simpleGyroscopeSampleCount: this.simpleGyroscopeSamples.length,
      simpleGyroCadenceFresh: simpleGyroFresh,
      simpleGyroDisplayFresh,
      simpleGyroDisplayHolding: simpleGyroDisplayFresh && !simpleGyroFresh,
      simpleGyroLedgerFresh,
      simpleGyroCandidateFresh: visibleCandidateFresh,
      simpleGyroEffectiveSampleHz: this.simpleGyroEffectiveSampleHz,
      simpleGyroAnalysisState: simpleGyroDisplayFresh
        && this.simpleGyroCadenceMethod.startsWith('low_rate_')
        ? (fresh ? 'low_rate_locked' : 'low_rate_holding')
        : this.simpleGyroAnalysisState,
      simpleGyroCadenceMethod: simpleGyroFresh
        ? this.simpleGyroCadenceMethod
        : (simpleGyroCandidateFresh
          ? this.simpleGyroCandidateMethod
          : (touchDisplayFresh ? 'touch_display_hold' : 'none')),
      gyroscopeTimestampScaleToMs: this.gyroscopeClock.rawScaleToMs,
      metersPerCrank: this.metersPerCrank,
      motionQualityState: this.lastMotionQuality
        ? this.lastMotionQuality.state : 'unavailable',
      motionQualityReason: this.lastMotionQuality
        ? this.lastMotionQuality.reason : 'not-configured',
      motionQualityScore: this.lastMotionQuality
        && Number.isFinite(this.lastMotionQuality.quality)
        ? this.lastMotionQuality.quality : 0,
      motionArtifact,
      rawMotionArtifact,
      headMotionKnown: this.lastMotionQuality
        ? this.lastMotionQuality.headMotionKnown === true : false,
      cadenceEvidenceAllowed: this.lastMotionQuality
        ? this.lastMotionQuality.allowCadenceEvidence === true : null,
    };
  }
}

// 页面早期接线使用了 Classifier 命名；保留同一实现的兼容导出，避免形成两套
// IMU 算法。估算踏频/速度仍由同一快照明确标注，绝不输出功率或距离。
export const CyclingImuClassifier = CyclingImuActivity;
import {
  assessWalkingLikeCadence,
  DEFAULT_IMU_METERS_PER_CRANK,
  DEFAULT_IMU_WALKING_IMPACT_WINDOW_MS,
  DEFAULT_IMU_WALKING_LATCH_MS,
  estimateImuFallbackSpeedKmh,
  imuFallbackSpeedProfile,
} from './cycling_imu_speed.js';
