// IMU 计步：用眼镜自带加速度计(W3C Accelerometer)算步数/步频/估算距离,
//   让「没有任何蓝牙设备」的用户也能拿到真实运动数据。
// 纯逻辑、无 AIUI/DOM 依赖,可单测。算法:合加速度幅值 → 慢速重力基线
//   → 短时平滑动态量 → 自适应噪声/峰值门限 → 峰谷迟滞 → 节奏一致性判定。
// 单次碰触不会立即成为一步；连续周期成立后才进入跟踪态。跟踪态允许一次漏峰，
// 也允许用两次一致的新周期确认真实变速，避免固定阈值在头戴弱信号下频繁归零。
// 与 BLE 心率/RSC 并行:有 RSC 步频/速度就用真源,没有就用本模块兜底。

const G = 9.80665;
const SENSOR_TIMESTAMP_SCALES_TO_MS = [1, 1000, 0.001, 0.000001];

function finiteSensorTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * 把宿主传感器时间轴归一化为与 Date.now() 对齐的单调毫秒时间。
 *
 * AIUI 的 frequency 只是 best-effort；不同宿主还可能给出 null、重复值，
 * 或把底层秒/微秒/纳秒时间戳直接透传。不能把 Number(null)=0 或原始纳秒
 * 直接交给 StepDetector，否则节奏历史会每帧重置或被算成 0 spm。
 */
export class SensorTimestampNormalizer {
  constructor(opts = {}) {
    const frequency = Number(opts.frequency);
    this.expectedIntervalMs = Number.isFinite(frequency) && frequency > 0
      ? 1000 / frequency : 20;
    this.maxCandidateIntervalMs = opts.maxCandidateIntervalMs ?? 2000;
    this.maxClockSkewMs = opts.maxClockSkewMs ?? 500;
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
    const wall = Number.isFinite(Number(wallNowMs))
      ? Number(wallNowMs)
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
    // 传感器/页面真实停顿应反映在时间轴中，不能用一个 20ms 假样本跨过去。
    if (wallDeltaMs > this.maxCandidateIntervalMs) {
      nextSampleMs = wall;
    } else {
      const fallbackDeltaMs = wallDeltaMs > 0
        ? wallDeltaMs : this.expectedIntervalMs;
      nextSampleMs = this.lastSampleMs + (sensorDeltaMs ?? fallbackDeltaMs);
      // 原始单位识别异常时及时回到墙钟附近，避免“未来几小时”的 IMU 样本
      // 让 MotionMetrics freshness 永久失败。
      if (wall > this.lastSampleMs
          && Math.abs(nextSampleMs - wall) > this.maxClockSkewMs) {
        nextSampleMs = wall;
      }
    }
    if (!(nextSampleMs > this.lastSampleMs)) {
      nextSampleMs = this.lastSampleMs + Math.max(1, this.expectedIntervalMs);
    }

    this.lastRawTimestamp = raw;
    this.lastWallMs = wall;
    this.lastSampleMs = nextSampleMs;
    return nextSampleMs;
  }
}

export class StepDetector {
  constructor(opts = {}) {
    // 生理边界约 48–250 spm。低于/高于边界的波形只作为扰动，不进入节奏。
    this.minStepMs = opts.minStepMs ?? 240;
    this.maxStepIntervalMs = opts.maxStepIntervalMs ?? 1250;
    // 跑动短暂漏峰时保持上一节奏；超过 3.2 秒则明确回到未就绪。
    this.maxStepMs = opts.maxStepMs ?? 3200;

    // 模长通道默认以 0.35m/s² 为头戴弱振动下限；经过姿态去噪的垂直投影
    // 通道可由调用方使用更低阈值。最终门限仍会随静止噪声和已确认峰值
    // 上升，因此不是一个对所有用户固定不变的检测阈值。
    this.threshold = opts.threshold ?? 0.35;
    this.maxThreshold = opts.maxThreshold ?? 2.8;
    this.noiseMultiplier = opts.noiseMultiplier ?? 3.2;
    this.noiseOffset = opts.noiseOffset ?? 0.08;
    this.signalThresholdRatio = opts.signalThresholdRatio ?? 0.28;
    this.releaseRatio = opts.releaseRatio ?? 0.25;

    // 用真实采样间隔换算 EMA；不同 AIUI 宿主即使达不到请求的 50Hz，
    // 重力分量、短时平滑和噪声估计仍保持近似一致的时间常数。
    this.baselineAlpha = opts.baselineAlpha ?? 0.02;
    this.baselineTimeConstantMs = opts.baselineTimeConstantMs ?? 950;
    this.smoothingTimeConstantMs = opts.smoothingTimeConstantMs ?? 45;
    this.noiseTimeConstantMs = opts.noiseTimeConstantMs ?? 1800;
    this.calibrationMs = opts.calibrationMs ?? 400;

    this.strideM = opts.strideM ?? 0.75;
    this.cadenceWindow = opts.cadenceWindow ?? 8;
    this.periodToleranceRatio = opts.periodToleranceRatio ?? 0.38;
    this.periodToleranceMs = opts.periodToleranceMs ?? 110;
    this.transitionConfirmSamples = opts.transitionConfirmSamples ?? 2;

    this.steps = 0;
    this._resetSignalState();
  }

  /**
   * 喂一帧原始加速度 (x,y,z 单位 m/s², tMs 毫秒时间戳)。
   * 返回 { stepped, steps, cadenceSpm }。
   */
  push(x, y, z, tMs) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(tMs)) {
      return this._state(false, this.lastPushMs);
    }
    // 传感器实例在息屏恢复后可能重置 timestamp。时间倒退时只重置节奏历史，
    // 累计步数保留；否则负间隔会把步频污染到下一场有效采样。
    if (this.lastPushMs != null && tMs <= this.lastPushMs) this.resetTiming();
    const sampleDtMs = this.lastPushMs == null ? null : tMs - this.lastPushMs;
    this.lastPushMs = tMs;
    const mag = Math.sqrt(x * x + y * y + z * z);
    if (!Number.isFinite(mag)) return this._state(false, this.lastPushMs);
    if (this.calibrationStartedMs == null) this.calibrationStartedMs = tMs;

    // 向量模长先消除眼镜姿态；慢速低通只吸收重力、佩戴角度与传感器偏置。
    const timedAlpha = sampleDtMs != null && sampleDtMs > 0 && sampleDtMs < 500
      ? 1 - Math.exp(-sampleDtMs / this.baselineTimeConstantMs)
      : this.baselineAlpha;
    this.baseline += timedAlpha * (mag - this.baseline);
    const rawDynamic = mag - this.baseline;
    const smoothAlpha = sampleDtMs != null && sampleDtMs > 0 && sampleDtMs < 500
      ? 1 - Math.exp(-sampleDtMs / this.smoothingTimeConstantMs)
      : 0.45;
    this.filteredDynamic += smoothAlpha * (rawDynamic - this.filteredDynamic);

    const calibrating = tMs - this.calibrationStartedMs < this.calibrationMs;
    this._updateNoiseEstimate(Math.abs(this.filteredDynamic), sampleDtMs, calibrating);
    const upTh = this._adaptiveThreshold();
    const downTh = Math.max(0.06, upTh * this.releaseRatio);

    // 真正停步后清掉旧节奏，但累计步数保留。下一次运动需要重新用连续周期确认。
    if (!this.armed && this.lastRhythmCandidateMs != null
        && tMs - this.lastRhythmCandidateMs > this.maxStepMs) {
      this._resetRhythm();
    }

    let stepped = false;
    if (!calibrating) {
      if (!this.armed) {
        if (this.filteredDynamic >= upTh && rawDynamic >= upTh * 0.65) {
          this.armed = true;
          this.peakValue = this.filteredDynamic;
          this.peakRawValue = rawDynamic;
          this.peakAtMs = tMs;
        }
      } else {
        if (this.filteredDynamic > this.peakValue) {
          this.peakValue = this.filteredDynamic;
          this.peakAtMs = tMs;
        }
        if (rawDynamic > this.peakRawValue) this.peakRawValue = rawDynamic;

        const peakExpired = this.peakAtMs != null && tMs - this.peakAtMs > 600;
        const released = rawDynamic <= downTh || this.filteredDynamic <= downTh;
        if (released || peakExpired) {
          const peakAtMs = this.peakAtMs;
          const prominence = this.peakValue - Math.min(rawDynamic, this.filteredDynamic);
          const strongEnough = !peakExpired
            && this.peakValue >= upTh
            && prominence >= Math.max(this.threshold * 0.8, upTh * 0.7);
          this.armed = false;
          this.peakValue = 0;
          this.peakRawValue = 0;
          this.peakAtMs = null;
          if (strongEnough) stepped = this._onRhythmCandidate(peakAtMs, prominence);
        }
      }
    }
    return this._state(stepped, tMs);
  }

  /**
   * 喂入已经按 AbsoluteOrientationSensor 投影到重力轴、并去除重力基线的
   * 垂直动态加速度。内部仍复用同一套自适应阈值与节奏确认，因此不会形成
   * 第二套步数账本；姿态数据不可用时调用方继续使用 push(x,y,z,tMs)。
   *
   * 用 G + dynamic 构造等价的一轴加速度只是为了复用已经充分回归的检测链，
   * 不做加速度积分，也不把四元数 yaw 当作行进方向。
   */
  pushProjectedDynamic(dynamicMps2, tMs) {
    if (!Number.isFinite(dynamicMps2) || !Number.isFinite(tMs)) {
      return this._state(false, this.lastPushMs);
    }
    const boundedDynamic = Math.min(G * 2, Math.max(-G * 0.95, dynamicMps2));
    return this.push(0, 0, G + boundedDynamic, tMs);
  }

  /**
   * 当前步频 spm：最近有效周期的稳健中位数。
   * 初始单峰/双峰尚未形成周期时返回 0，但 _state.cadenceReady=false；
   * 停止超过 maxStepMs 后同样回到未就绪，页面可据此显示 “--”。
   */
  cadenceSpm(nowMs = this.lastPushMs) {
    if (!this.rhythmEstablished || this.periodsMs.length < 2) return 0;
    if (nowMs != null && this.lastRhythmCandidateMs != null
        && nowMs - this.lastRhythmCandidateMs > this.maxStepMs) return 0;
    const period = robustMedian(this.periodsMs);
    if (!(period >= this.minStepMs && period <= this.maxStepIntervalMs)) return 0;
    return Math.round(60000 / period);
  }

  /** 估算距离(m) = 步数 × 步长。 */
  distanceM() {
    return this.steps * this.strideM;
  }

  /** 走/跑判定:步频 ≥ 140 spm 视为跑步。 */
  isRunning(nowMs = this.lastPushMs) {
    return this.cadenceSpm(nowMs) >= 140;
  }

  reset() {
    this.steps = 0;
    this.resetTiming();
  }

  /** 清采样/步频历史但保留累计步数，供暂停恢复或传感器时间轴换代。 */
  resetTiming() {
    this._resetSignalState();
  }

  _state(stepped, tMs) {
    const cadenceSpm = this.cadenceSpm(tMs);
    return {
      stepped,
      // release callback 往往晚于真实峰值，低采样率时可相差 70–170ms。
      // 调用方必须用物理峰时刻做跨通道仲裁与最终落步间隔；tMs 只代表
      // 当前样本到达时间，不能用来量化步频。
      stepAtMs: stepped && Number.isFinite(this.lastStepMs)
        ? this.lastStepMs : null,
      steps: this.steps,
      cadenceSpm,
      cadenceReady: cadenceSpm > 0,
      threshold: this._adaptiveThreshold(),
      dynamic: this.filteredDynamic,
    };
  }

  _adaptiveThreshold() {
    const noiseThreshold = this.noiseAbsEma * this.noiseMultiplier + this.noiseOffset;
    const signalThreshold = this.signalPeakEma > 0
      ? this.signalPeakEma * this.signalThresholdRatio : 0;
    return Math.min(
      this.maxThreshold,
      Math.max(this.threshold, noiseThreshold, signalThreshold),
    );
  }

  _updateNoiseEstimate(absDynamic, sampleDtMs, calibrating) {
    if (!Number.isFinite(absDynamic)) return;
    const threshold = this._adaptiveThreshold();
    // 噪声只从门限下半区学习。若把步态波形的上升/下降沿也当成噪声，
    // 门限会在持续跑动中正反馈抬高，最终把真实弱峰全部吞掉。
    if (!calibrating && (this.armed || absDynamic >= threshold * 0.5)) return;
    const alpha = sampleDtMs != null && sampleDtMs > 0 && sampleDtMs < 500
      ? 1 - Math.exp(-sampleDtMs / this.noiseTimeConstantMs)
      : 0.01;
    const clipped = Math.min(absDynamic, threshold * 0.5);
    this.noiseAbsEma += alpha * (clipped - this.noiseAbsEma);
  }

  _onRhythmCandidate(candidateMs, prominence) {
    if (!Number.isFinite(candidateMs)) return false;
    if (this.lastRhythmCandidateMs == null) {
      this.lastRhythmCandidateMs = candidateMs;
      return false;
    }

    const intervalMs = candidateMs - this.lastRhythmCandidateMs;
    if (intervalMs < this.minStepMs) return false;

    if (!this.rhythmEstablished) {
      if (intervalMs > this.maxStepIntervalMs) {
        this.lastRhythmCandidateMs = candidateMs;
        this.startupPeriodsMs = [];
        return false;
      }
      this.lastRhythmCandidateMs = candidateMs;
      this.startupPeriodsMs.push(intervalMs);
      if (this.startupPeriodsMs.length > 2) this.startupPeriodsMs.shift();
      if (this.startupPeriodsMs.length < 2) return false;

      const first = this.startupPeriodsMs[0];
      const second = this.startupPeriodsMs[1];
      if (!this._periodsConsistent(first, second)) {
        this.startupPeriodsMs = [second];
        return false;
      }
      this.rhythmEstablished = true;
      this.periodsMs = [first, second];
      this.startupPeriodsMs = [];
      return this._commitStep(candidateMs, prominence);
    }

    this.lastRhythmCandidateMs = candidateMs;
    const expectedMs = robustMedian(this.periodsMs);
    let normalizedPeriodMs = intervalMs;
    let periodAccepted = this._periodsConsistent(intervalMs, expectedMs);

    // 一次峰值太弱而漏检时，下一峰通常落在约 2×/3× 周期。只恢复节奏，
    // 不凭空补计缺失步，保证页面与聚合器的步数/距离保持单调一致。
    if (!periodAccepted && expectedMs > 0) {
      const multiple = Math.round(intervalMs / expectedMs);
      if (multiple >= 2 && multiple <= 3) {
        const recovered = intervalMs / multiple;
        if (this._periodsConsistent(recovered, expectedMs)) {
          normalizedPeriodMs = recovered;
          periodAccepted = true;
        }
      }
    }

    if (!periodAccepted) {
      // 单个突发周期先不计步；两次相近的新周期才认作真实加速/减速。
      const previous = this.transitionPeriodsMs[this.transitionPeriodsMs.length - 1];
      if (previous != null && this._periodsConsistent(intervalMs, previous)) {
        this.transitionPeriodsMs.push(intervalMs);
      } else {
        this.transitionPeriodsMs = [intervalMs];
      }
      if (this.transitionPeriodsMs.length < this.transitionConfirmSamples) return false;
      this.periodsMs = this.transitionPeriodsMs.slice(-this.cadenceWindow);
      this.transitionPeriodsMs = [];
      return this._commitStep(candidateMs, prominence);
    }

    this.transitionPeriodsMs = [];
    this.periodsMs.push(normalizedPeriodMs);
    if (this.periodsMs.length > this.cadenceWindow) this.periodsMs.shift();
    return this._commitStep(candidateMs, prominence);
  }

  _periodsConsistent(leftMs, rightMs) {
    if (!(Number.isFinite(leftMs) && Number.isFinite(rightMs) && rightMs > 0)) return false;
    const toleranceMs = Math.max(
      this.periodToleranceMs,
      rightMs * this.periodToleranceRatio,
    );
    return Math.abs(leftMs - rightMs) <= toleranceMs;
  }

  _commitStep(candidateMs, prominence) {
    this.steps += 1;
    this.lastStepMs = candidateMs;
    this.stepTimes.push(candidateMs);
    if (this.stepTimes.length > this.cadenceWindow + 1) this.stepTimes.shift();
    if (Number.isFinite(prominence) && prominence > 0) {
      this.signalPeakEma = this.signalPeakEma > 0
        ? this.signalPeakEma + 0.18 * (prominence - this.signalPeakEma)
        : prominence;
    }
    return true;
  }

  _resetRhythm() {
    this.lastStepMs = null;
    this.lastRhythmCandidateMs = null;
    this.rhythmEstablished = false;
    this.startupPeriodsMs = [];
    this.transitionPeriodsMs = [];
    this.periodsMs = [];
    this.stepTimes = [];
    this.signalPeakEma = 0;
  }

  _resetSignalState() {
    this.baseline = G;
    this.filteredDynamic = 0;
    this.noiseAbsEma = 0.06;
    this.signalPeakEma = 0;
    this.armed = false;
    this.peakValue = 0;
    this.peakRawValue = 0;
    this.peakAtMs = null;
    this.calibrationStartedMs = null;
    this.lastPushMs = null;
    this._resetRhythm();
  }
}

function robustMedian(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const centre = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  if (sorted.length < 4) return centre;
  const deviations = sorted.map((value) => Math.abs(value - centre));
  const devSorted = deviations.slice().sort((a, b) => a - b);
  const mad = devSorted[Math.floor(devSorted.length / 2)];
  const tolerance = Math.max(80, mad * 3);
  const inliers = sorted.filter((value) => Math.abs(value - centre) <= tolerance);
  if (!inliers.length) return centre;
  const mid = Math.floor(inliers.length / 2);
  return inliers.length % 2
    ? inliers[mid]
    : (inliers[mid - 1] + inliers[mid]) / 2;
}
