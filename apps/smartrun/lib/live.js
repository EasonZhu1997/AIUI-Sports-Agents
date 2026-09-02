// 实时快照桥:run_hud 每拍把真实运动快照写进 wx storage,coach 页读同一份。
// 目的:教练不再用假 demoSnapshot(心率156/3.2km),而是看用户"此刻真实数据"
//   —— 没在跑时读到 null → summarizeSnapshot 给「暂无运动数据」,兜底也不编数。
// 快照带写入时间戳 ts:读取时超过 TTL(10s)视为过期返回 null,防止 HUD 停止刷新
//   (息屏/切页/异常退出残留)后教练把旧数据当"此刻"。
// 纯逻辑 normalizeSnapshot 可单测;storage 包装接受注入的 storage 对象便于测试。

import { compactDeviceName } from './devices.js';

export const LIVE_SNAPSHOT_KEY = 'run_snapshot';
export const LIVE_SNAPSHOT_TTL_MS = 10000;

const NUM_FIELDS = [
  'bpm', 'zone', 'paceSecPerKm', 'cadenceSpm', 'distanceM', 'elapsedMs',
];
const HEART_RATE_POLICY_SOURCES = new Set([
  'user_explicit', 'garmin_profile', 'age_estimate', 'conservative_default',
]);

/** 只保留有限数值、短设备名和 paused/stationary 标志;无任何有效数值 → null。 */
export function normalizeSnapshot(s) {
  if (!s || typeof s !== 'object') return null;
  const out = {};
  let hasNum = false;
  for (const k of NUM_FIELDS) {
    if (Number.isFinite(s[k])) { out[k] = s[k]; hasNum = true; }
  }
  if (!hasNum) return null;
  if (typeof s.heartDeviceName === 'string' && s.heartDeviceName.trim()) {
    out.heartDeviceName = compactDeviceName(s.heartDeviceName);
  }
  const maxHrBpm = Number(s.heartRateMaxHrBpm);
  if (Number.isInteger(maxHrBpm) && maxHrBpm >= 120 && maxHrBpm <= 230
      && typeof s.heartRatePolicySource === 'string'
      && HEART_RATE_POLICY_SOURCES.has(s.heartRatePolicySource)) {
    out.heartRateMaxHrBpm = maxHrBpm;
    out.heartRatePolicySource = s.heartRatePolicySource;
  }
  out.paused = !!s.paused;
  if (s.stationary) out.stationary = true;
  return out;
}

/** 写实时快照(带时间戳);无有效数据则清掉(避免留下过期数据)。storage=wx。失败静默。 */
export function writeLiveSnapshot(storage, snap, nowMs = Date.now()) {
  if (!storage) return;
  const n = normalizeSnapshot(snap);
  try {
    if (n) storage.setStorageSync(LIVE_SNAPSHOT_KEY, { ...n, ts: nowMs });
    else storage.removeStorageSync(LIVE_SNAPSHOT_KEY);
  } catch (_e) { /* storage 不可用不影响主流程 */ }
}

/**
 * 读实时快照 → 归一化对象或 null。storage=wx。失败/无数据/过期 → null。
 * 无 ts(旧格式)一律视为过期:宁可「暂无运动数据」也不编造"此刻"。
 */
export function readLiveSnapshot(storage, nowMs = Date.now()) {
  if (!storage) return null;
  try {
    const raw = storage.getStorageSync(LIVE_SNAPSHOT_KEY);
    if (!raw || typeof raw !== 'object') return null;
    if (!Number.isFinite(raw.ts) || nowMs - raw.ts > LIVE_SNAPSHOT_TTL_MS) return null;
    return normalizeSnapshot(raw);
  } catch (_e) { return null; }
}

/** 结束跑步时清掉,避免教练拿上一段的旧数据当"此刻"。 */
export function clearLiveSnapshot(storage) {
  if (!storage) return;
  try { storage.removeStorageSync(LIVE_SNAPSHOT_KEY); } catch (_e) {}
}
