// 跑步记录上传:眼镜跑完把汇总指标写进 AIUI 专用入口(source="aiui"),
// 未绑定设备使用低权限 device token，绑定后同一设备命名空间切换到 APK 用户。
// 新契约:POST /coach/aiui-runs + 稳定 client_run_id；旧 /runs 仅作显式 app_key 回退。
// 口径:只传汇总指标(时长/距离/均配/心率/步频),不传定位或轨迹。
// best-effort:退出跑步先入有界待传队列(FIFO)，总结页立即尝试发送，首页
// onLoad/onShow 继续静默补传；bootstrap/网络不可用时始终保留同一 client_run_id。

import { normalizeBaseUrl, DEFAULT_BASE_URL } from './coach_api.js';

export const RUN_UPLOAD_PATH = '/api/coach-svc/runs';
// 新设备 token 仅能访问 AIUI 专用入口；旧 anon-login token 继续兼容 /runs。
export const AIUI_RUN_UPLOAD_PATH = '/api/coach-svc/coach/aiui-runs';
export const PENDING_RUNS_KEY = 'pending_run_uploads';
// Keep enough offline headroom for a commercial user while refusing to evict
// the only durable copy of an older, unacknowledged run.  Reaching the bound is
// a storage failure for the new item, never permission to drop FIFO evidence.
export const PENDING_RUNS_MAX = 32;

// 上传门槛:太短的误进误出不值得成为一条"跑步记录"(也别去污染后端聚合)。
const MIN_ELAPSED_MS = 60000;
const MIN_DISTANCE_M = 100;

function stablePayloadText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const keys = Object.keys(payload).filter((key) => key !== 'client_run_id').sort();
  let out = '';
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    let value = '';
    try { value = JSON.stringify(payload[key]); } catch (_e) { value = ''; }
    out += key + ':' + value + '|';
  }
  return out;
}

function fnv1a32(text) {
  let hash = 0x811c9dc5;
  const value = String(text || '');
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function validClientRunId(value) {
  return typeof value === 'string'
    && value.length >= 8 && value.length <= 80
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

/**
 * 给一场本地跑步生成稳定幂等键。相同 payload 在崩溃/重启后的重试仍得到同一 ID，
 * 而不是每次请求重新随机，从而让后端安全返回同一 run。
 */
export function createClientRunId(payload) {
  if (payload && validClientRunId(payload.client_run_id)) return payload.client_run_id;
  const startedAtMs = Date.parse(payload && payload.started_at);
  const startPart = Number.isFinite(startedAtMs) && startedAtMs > 0
    ? Math.round(startedAtMs).toString(36) : 'unknown';
  return 'run-' + startPart + '-' + fnv1a32(stablePayloadText(payload));
}

export function ensureClientRunId(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const clientRunId = createClientRunId(payload);
  return payload.client_run_id === clientRunId
    ? payload : { ...payload, client_run_id: clientRunId };
}

function boundedInt(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function canonicalIso(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  try { return new Date(ms).toISOString(); } catch (_e) { return ''; }
}

/**
 * 将升级前/损坏队列收敛到 aiui-runs 的严格白名单和边界，剥离 points/GPS/raw 等字段。
 * 无法恢复 started_at/duration 的记录返回 null，避免它永久堵住后续 FIFO。
 */
export function normalizeRunUploadPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const startedAt = canonicalIso(payload.started_at);
  if (!startedAt) return null;
  let endedAt = canonicalIso(payload.ended_at);
  if (endedAt && Date.parse(endedAt) < Date.parse(startedAt)) endedAt = '';
  let duration = boundedInt(payload.duration_s, 1, 86400);
  if (duration === null && endedAt) {
    duration = boundedInt((Date.parse(endedAt) - Date.parse(startedAt)) / 1000, 1, 86400);
  }
  if (duration === null) return null;

  const distance = boundedInt(payload.distance_m, 0, 500000);
  const normalized = {
    started_at: startedAt,
    duration_s: duration,
    distance_m: distance === null ? 0 : distance,
    source: 'aiui',
    workout_type: payload.workout_type === 'slow_jog' ? 'slow_jog' : 'free',
  };
  if (endedAt) normalized.ended_at = endedAt;
  const pace = boundedInt(payload.avg_pace_s, 60, 7200);
  const avgHr = boundedInt(payload.avg_hr, 20, 240);
  let maxHr = boundedInt(payload.max_hr, 20, 240);
  const cadence = boundedInt(payload.cadence_avg, 0, 300);
  if (pace !== null) normalized.avg_pace_s = pace;
  if (avgHr !== null) normalized.avg_hr = avgHr;
  if (maxHr !== null) {
    if (avgHr !== null && maxHr < avgHr) maxHr = avgHr;
    normalized.max_hr = maxHr;
  }
  if (cadence !== null) normalized.cadence_avg = cadence;
  normalized.client_run_id = validClientRunId(payload.client_run_id)
    ? payload.client_run_id : createClientRunId(normalized);
  return normalized;
}

export function isPermanentRunUploadRejection(statusCode) {
  const status = Number(statusCode);
  // 后端只会在同一 client_run_id 已存在不同载荷（或唯一约束冲突）时返回
  // 409；同载荷幂等重试返回 200。因此原样重试 409 永远不会自行恢复，必须
  // 与 400/422 一样先隔离证据，再从主 FIFO 移除毒丸。
  return status === 400 || status === 409 || status === 422;
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

/**
 * 由会话终值构建上传 payload;不够门槛(时长<60s 且距离<100m)返回 null。
 * 形状对齐后端 RunIn:started_at 必填 ISO,其余可空。
 */
export function buildRunUploadPayload(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  if (!Number.isFinite(s.startMs) || s.startMs <= 0) return null;
  const elapsedMs = Number.isFinite(s.elapsedMs) && s.elapsedMs > 0 ? s.elapsedMs : 0;
  const distanceM = Number.isFinite(s.distanceM) && s.distanceM > 0 ? s.distanceM : 0;
  if (elapsedMs < MIN_ELAPSED_MS && distanceM < MIN_DISTANCE_M) return null;

  const payload = {
    started_at: toIso(s.startMs),
    duration_s: Math.round(elapsedMs / 1000),
    distance_m: Math.round(distanceM),
    source: 'aiui',
    // 当前服务契约只有 free / slow_jog；虚拟跑在本地总结与记忆中保留
    // garmin_virtual 身份，上传时暂按 free 兼容，避免服务端 422 丢记录。
    workout_type: s.mode === 'slow' || s.mode === 'slow_jog' ? 'slow_jog' : 'free',
  };
  if (Number.isFinite(s.endMs) && s.endMs >= s.startMs) payload.ended_at = toIso(s.endMs);
  if (Number.isFinite(s.avgPaceSecPerKm) && s.avgPaceSecPerKm > 0) {
    payload.avg_pace_s = Math.round(s.avgPaceSecPerKm);
  }
  if (Number.isFinite(s.avgBpm) && s.avgBpm > 0) payload.avg_hr = Math.round(s.avgBpm);
  if (Number.isFinite(s.maxBpm) && s.maxBpm > 0) payload.max_hr = Math.round(s.maxBpm);
  if (Number.isFinite(s.avgCadenceSpm) && s.avgCadenceSpm > 0) {
    payload.cadence_avg = Math.round(s.avgCadenceSpm);
  }
  return payload;
}

/** 构造上传请求(不发送)。 */
export function buildRunUploadRequest(opts = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL, token, payload,
    path = opts.deviceToken === true ? AIUI_RUN_UPLOAD_PATH : RUN_UPLOAD_PATH,
  } = opts;
  const isAiuiDevicePath = path === AIUI_RUN_UPLOAD_PATH;
  let requestPayload = isAiuiDevicePath ? normalizeRunUploadPayload(payload) : payload;
  // 旧 /runs 的 RunIn 不认识新字段；兼容回退时只在网络副本删除，本地队列仍保留 ID。
  if (!isAiuiDevicePath && requestPayload && requestPayload.client_run_id) {
    requestPayload = { ...requestPayload };
    delete requestPayload.client_run_id;
  }
  const header = { 'Content-Type': 'application/json' };
  if (token) header.Authorization = `Bearer ${token}`;
  return {
    url: normalizeBaseUrl(baseUrl) + path,
    method: 'POST',
    header,
    dataType: 'json',
    responseType: 'text',
    data: requestPayload,
  };
}

/** 解析上传响应 → 后端 run id;失败返回 null。 */
export function parseRunUploadResponse(resp) {
  if (!resp || resp.statusCode !== 200 || !resp.data) return null;
  const id = resp.data.id;
  return Number.isFinite(id) && id > 0 ? id : null;
}

function pendingQueueState(ok, items, reason = '') {
  return Object.freeze({ ok, items: Object.freeze(items), reason });
}

/**
 * Read the durable run FIFO without collapsing an unreadable/corrupt value to
 * an authoritative empty queue.  Callers that decide whether it is safe to
 * overwrite, ACK, or show "synced" must use this stateful form.
 */
export function readPendingRunUploadsState(storage) {
  if (!storage || typeof storage.getStorageSync !== 'function') {
    return pendingQueueState(false, [], 'storage_unavailable');
  }
  try {
    const raw = storage.getStorageSync(PENDING_RUNS_KEY);
    if (raw === '' || raw === undefined || raw === null) {
      return pendingQueueState(true, []);
    }
    if (!Array.isArray(raw)) return pendingQueueState(false, [], 'queue_corrupt');
    if (raw.length > PENDING_RUNS_MAX) {
      return pendingQueueState(false, [], 'queue_overflow');
    }
    const clean = [];
    const ids = new Set();
    for (let i = 0; i < raw.length; i += 1) {
      const normalized = normalizeRunUploadPayload(raw[i]);
      if (!normalized || ids.has(normalized.client_run_id)) {
        return pendingQueueState(false, [], 'queue_corrupt');
      }
      ids.add(normalized.client_run_id);
      clean.push(normalized);
    }
    // 就地升级旧队列：ID 写回后，后续每次网络重试都携带同一 client_run_id。
    const migrated = JSON.stringify(clean) !== JSON.stringify(raw);
    if (migrated) {
      if (clean.length) storage.setStorageSync(PENDING_RUNS_KEY, clean);
      else storage.removeStorageSync(PENDING_RUNS_KEY);
      const roundTrip = storage.getStorageSync(PENDING_RUNS_KEY);
      if (JSON.stringify(roundTrip || []) !== JSON.stringify(clean)) {
        return pendingQueueState(false, [], 'migration_readback_failed');
      }
    }
    return pendingQueueState(true, clean);
  } catch (_e) {
    return pendingQueueState(false, [], 'storage_read_failed');
  }
}

/** Display-only compatibility view. Mutating/sync-state callers use State. */
export function readPendingRunUploads(storage) {
  return readPendingRunUploadsState(storage).items;
}

/** 写待传队列;空数组直接清 key。失败静默。 */
export function writePendingRunUploads(storage, list) {
  if (!storage || typeof storage.getStorageSync !== 'function') return null;
  try {
    if (!Array.isArray(list) || list.length > PENDING_RUNS_MAX) return null;
    const clean = [];
    const ids = new Set();
    for (let i = 0; i < list.length; i += 1) {
      const normalized = normalizeRunUploadPayload(list[i]);
      if (!normalized || ids.has(normalized.client_run_id)) return null;
      ids.add(normalized.client_run_id);
      clean.push(normalized);
    }
    if (clean.length) storage.setStorageSync(PENDING_RUNS_KEY, clean);
    else storage.removeStorageSync(PENDING_RUNS_KEY);
    const roundTrip = readPendingRunUploadsState(storage);
    return roundTrip.ok && JSON.stringify(roundTrip.items) === JSON.stringify(clean)
      ? clean : null;
  } catch (_e) {
    return null;
  }
}

/** 入队一条待传记录。损坏/读取失败/队列已满时 fail closed。 */
export function enqueueRunUpload(storage, payload) {
  const state = readPendingRunUploadsState(storage);
  if (!state.ok) return null;
  const list = state.items;
  if (!payload) return list;
  const queued = normalizeRunUploadPayload(payload);
  if (!queued) return list;
  const existingIndex = list.findIndex(
    (item) => item.client_run_id === queued.client_run_id,
  );
  let next;
  if (existingIndex >= 0) {
    next = list.slice();
    next[existingIndex] = queued;
  } else {
    if (list.length >= PENDING_RUNS_MAX) return null;
    next = [...list, queued];
  }
  return writePendingRunUploads(storage, next);
}

/**
 * Remove one successfully uploaded payload from the latest persisted queue.
 * This avoids overwriting a run enqueued while the upload request was pending.
 */
export function removePendingRunUpload(storage, payload) {
  const state = readPendingRunUploadsState(storage);
  if (!state.ok) return null;
  const list = state.items;
  if (!payload || !list.length) return list;
  const normalizedTarget = normalizeRunUploadPayload(payload);
  let target = '';
  try { target = JSON.stringify(normalizedTarget); } catch (_e) { return list; }
  const index = list.findIndex((item) => {
    try { return JSON.stringify(item) === target; } catch (_e) { return false; }
  });
  if (index < 0) return list;
  const next = [...list.slice(0, index), ...list.slice(index + 1)];
  return writePendingRunUploads(storage, next);
}
