// HUD 显示格式化：无运动证据时必须呈现占位，不用默认步频/步长伪造配速。

export const PACE_PENDING = '-:00';
export const CADENCE_PENDING = '--';
// 保留导出供旧页面 ABI 使用；estimatePaceSecPerKmFromCadence 不再把它们
// 当成“尚未运动”的数据先验。
export const DEFAULT_ESTIMATED_CADENCE_SPM = 160;
export const DEFAULT_ESTIMATED_STRIDE_M = 0.85;

export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 配速 sec/km → "M:SS"；无真实数值时显示明确占位。 */
export function formatPace(secPerKm) {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0 || secPerKm > 1800) return PACE_PENDING;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  if (s === 60) return `${m + 1}:00`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** km/h → 配速 sec/km（速度≈0 视为无配速）。 */
export function paceSecPerKmFromKmh(kmh) {
  if (!Number.isFinite(kmh) || kmh < 0.5) return null;
  return 3600 / kmh;
}

/**
 * 眼镜 HUD 的即时估算配速。
 *
 * 只在“已检测到有效步频 + 有效用户单步长度”时估算。结果按 5 秒取整
 * 并限制在 2:24–30:00/km；尚未形成运动证据时返回 null，由 HUD 显示
 * -:00。第三个参数只为兼容旧调用签名保留，绝不再充当启动先验。
 */
export function estimatePaceSecPerKmFromCadence(
  cadenceSpm,
  strideM,
  _fallbackCadenceSpm = null,
) {
  if (!Number.isFinite(cadenceSpm) || cadenceSpm < 40 || cadenceSpm > 300) return null;
  if (!Number.isFinite(strideM) || strideM < 0.2 || strideM > 2.5) return null;
  const estimate = 60000 / (cadenceSpm * strideM);
  const bounded = Math.min(1800, Math.max(144, estimate));
  return Math.round(bounded / 5) * 5;
}

export function formatCadence(cadenceSpm, ready = true) {
  if (!ready || !Number.isFinite(cadenceSpm) || cadenceSpm <= 0) return CADENCE_PENDING;
  return String(Math.round(cadenceSpm));
}

export function formatDistanceKm(meters) {
  if (!Number.isFinite(meters) || meters < 0) return '--';
  return (meters / 1000).toFixed(2);
}

export function formatBpm(bpm) {
  if (!Number.isFinite(bpm) || bpm <= 0) return '--';
  return String(Math.round(bpm));
}
