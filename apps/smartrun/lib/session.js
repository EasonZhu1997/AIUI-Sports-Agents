// 跑步会话聚合器：由 BLE/传感器事件喂数据，1s 定时器取快照给 setData。
// 距离累加钳速 0..25 km/h（沿用 FunpizzaSmartRun 审计修复 a567775 的口径，
// 防异常速度值冲爆距离）。纯逻辑、无 I/O，眼镜端与测试共用。

const MAX_SPEED_KMH = 25;
const MAX_SPEED_GAP_MS = 3000;

export class RunSession {
  constructor(nowMs = 0) {
    this.startMs = nowMs;
    this.lastSpeedMs = null;     // 上一次速度样本时间
    this.lastSpeedKmh = null;
    this.distanceM = 0;
    this.lastBpm = null;
    this.lastCadence = null;
    this.paused = false;
    this.pausedAccumMs = 0;
    this.pauseStartMs = null;
    // 全程累计(跑后摘要/上传用):心率均值/峰值、步频均值(只计运动中样本)
    this.bpmSum = 0;
    this.bpmCount = 0;
    this.bpmMax = null;
    this.cadenceSum = 0;
    this.cadenceCount = 0;
  }

  /**
   * 兼容旧调用的速度积分。新运动管线优先由 MotionMetrics 驱动距离；这里仍保证
   * 异常/断流不会在下一包恢复时跨空档补出幽灵距离，并用梯形积分降低变速误差。
   */
  onSpeed(kmh, nowMs) {
    if (this.paused) return;
    if (!Number.isFinite(nowMs)) return;
    if (!Number.isFinite(kmh) || kmh < 0 || kmh > MAX_SPEED_KMH) {
      this.lastSpeedMs = nowMs;
      this.lastSpeedKmh = null;
      return;
    }
    if (this.lastSpeedMs != null && this.lastSpeedKmh != null && nowMs > this.lastSpeedMs) {
      const gapMs = nowMs - this.lastSpeedMs;
      if (gapMs <= MAX_SPEED_GAP_MS) {
        const dtH = gapMs / 3600000;
        this.distanceM += ((this.lastSpeedKmh + kmh) * 0.5) * 1000 * dtH;
      }
    }
    this.lastSpeedMs = nowMs;
    this.lastSpeedKmh = kmh;
  }

  onHeartRate(bpm) {
    if (!(Number.isFinite(bpm) && bpm > 0 && bpm < 255)) return;
    this.lastBpm = bpm;
    if (!this.paused) {
      this.bpmSum += bpm;
      this.bpmCount += 1;
      if (this.bpmMax == null || bpm > this.bpmMax) this.bpmMax = bpm;
    }
  }

  onCadence(spm) {
    if (!(Number.isFinite(spm) && spm >= 0 && spm < 512)) return;
    this.lastCadence = spm;
    // 均值只计运动中(>0)样本:站着等灯不摊薄步频
    if (!this.paused && spm > 0) {
      this.cadenceSum += spm;
      this.cadenceCount += 1;
    }
  }

  /** 全程平均心率;无样本返回 null。 */
  avgBpm() {
    return this.bpmCount > 0 ? Math.round(this.bpmSum / this.bpmCount) : null;
  }

  /** 全程最高心率;无样本返回 null。 */
  maxBpm() {
    return this.bpmMax;
  }

  /** 全程平均步频(只计运动中样本);无样本返回 null。 */
  avgCadenceSpm() {
    return this.cadenceCount > 0 ? Math.round(this.cadenceSum / this.cadenceCount) : null;
  }

  pause(nowMs) {
    if (this.paused) return;
    this.paused = true;
    this.pauseStartMs = nowMs;
    this.lastSpeedMs = null;   // 恢复后第一帧不跨暂停段累距离
    this.lastSpeedKmh = null;
  }

  resume(nowMs) {
    if (!this.paused) return;
    this.paused = false;
    this.pausedAccumMs += nowMs - this.pauseStartMs;
    this.pauseStartMs = null;
  }

  /** 运动净时长（去除暂停段），ms。 */
  elapsedMs(nowMs) {
    const pausedNow = this.paused ? nowMs - this.pauseStartMs : 0;
    return Math.max(0, nowMs - this.startMs - this.pausedAccumMs - pausedNow);
  }

  /** 全程平均配速 sec/km；距离太短（<10m）返回 null。 */
  avgPaceSecPerKm(nowMs) {
    if (this.distanceM < 10) return null;
    return this.elapsedMs(nowMs) / 1000 / (this.distanceM / 1000);
  }

  /** 每秒 setData 用的快照。 */
  snapshot(nowMs) {
    return {
      elapsedMs: this.elapsedMs(nowMs),
      distanceM: this.distanceM,
      bpm: this.lastBpm,
      cadenceSpm: this.lastCadence,
      avgPaceSecPerKm: this.avgPaceSecPerKm(nowMs),
      paused: this.paused,
    };
  }
}
