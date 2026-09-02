// AIUI 教练后端对接:纯逻辑构造请求 / 解析响应,便于单测;
// 真正的 wx.request 网络调用在 coach 页里(带 token 与超时/降级)。
// 主链路:官方 AIUI LanguageModel(DeepSeek)生成回答;后端以低权限设备 token
// 负责匿名/绑定所有权、EverMind 记忆检索，以及保存 AIUI 已生成的一问一答。
// 姊妹 APK 项目仍兼容 /coach/chat:由后端 DeepSeek 生成并双写 EverMind。

import { summarizeSnapshot } from './coach.js';

// 自建教练后端默认关闭。只有用户或开发者显式写入 HTTPS coach_base_url 后，
// 页面请求包装器才允许访问该地址。AIUI LanguageModel 是宿主管理的独立网络链，
// 不受此 key 控制；仓库不内置教练后端的生产地址或密钥。
export const DEFAULT_BASE_URL = '';
export const CHAT_PATH = '/api/coach-svc/coach/chat';
export const AIUI_RECORD_PATH = '/api/coach-svc/coach/aiui-record';
export const COACH_BASE_URL_STORAGE_KEY = 'coach_base_url';
export const COACH_CLIENT_ID_STORAGE_KEY = 'coach_client_id';
// 仅用于旧 anon-login/受控迁移的可选 app key。新版 device-bootstrap 不依赖它，
// 更不能把共享 key 当作旧用户历史的所有权证明。
export const COACH_APP_KEY_STORAGE_KEY = 'coach_app_key';
// 教练页与首页补传共用的当前 token；新版通常保存 scoped device JWT。
// 旧 user JWT 在设备身份模块的独立有界 key 中暂存，迁移 marker 成功前不覆盖。
export const COACH_TOKEN_STORAGE_KEY = 'coach_token';
export const DEFAULT_COACH_CLIENT_ID = 'AISmartRun';

export function normalizeBaseUrl(baseUrl) {
  const v = String(baseUrl || '').trim().replace(/\/+$/, '');
  return /^https:\/\//i.test(v) ? v : '';
}

function readStorageString(wxModule, key) {
  try {
    if (!wxModule || typeof wxModule.getStorageSync !== 'function') return '';
    const value = wxModule.getStorageSync(key);
    return typeof value === 'string' ? value.trim() : '';
  } catch (_e) {
    return '';
  }
}

export function resolveCoachBackendConfig(wxModule, opts = {}) {
  const baseUrl = normalizeBaseUrl(
    opts.baseUrl || readStorageString(wxModule, COACH_BASE_URL_STORAGE_KEY) || DEFAULT_BASE_URL,
  );
  const clientId = String(
    opts.clientId || readStorageString(wxModule, COACH_CLIENT_ID_STORAGE_KEY) || DEFAULT_COACH_CLIENT_ID,
  ).trim() || DEFAULT_COACH_CLIENT_ID;
  const appKey = String(
    opts.appKey || readStorageString(wxModule, COACH_APP_KEY_STORAGE_KEY) || '',
  ).trim();
  return {
    baseUrl,
    clientId,
    appKey,
    memoryEnabled: Boolean(baseUrl) && opts.memoryEnabled !== false,
  };
}

/** 把实时快照压成前缀,连同问题拼成 message;无有效数据则只发问题。 */
export function buildCoachMessage(question, snapshot) {
  const q = String(question || '').trim();
  const ctx = summarizeSnapshot(snapshot);
  return ctx && ctx !== '暂无运动数据' ? `[实时 ${ctx}] ${q}` : q;
}

/**
 * 构造 APK 兼容 /coach/chat 请求(不发送)。AIUI 主流程不走这里生成回答;
 * 姊妹 APK 项目仍可用该端点让后端 DeepSeek 生成并写入 EverMind。
 */
export function buildChatRequest(opts = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL, path = CHAT_PATH, token, question, snapshot,
  } = opts;
  const header = { 'Content-Type': 'application/json' };
  if (token) header.Authorization = `Bearer ${token}`;
  return {
    url: normalizeBaseUrl(baseUrl) + path,
    method: 'POST',
    header,
    dataType: 'json',
    responseType: 'text',
    data: { message: buildCoachMessage(question, snapshot) },
  };
}

/**
 * 解析 APK 兼容 /coach/chat 响应 → 教练回复字符串;非 200 / 无有效 reply 返回 null。
 * resp 形状对齐 wx.request 回调:{ statusCode, data:{ reply, fallback, ... } }。
 */
export function parseChatResponse(resp) {
  if (!resp || resp.statusCode !== 200) return null;
  const d = resp.data;
  const reply = d && typeof d.reply === 'string' ? d.reply.trim() : '';
  return reply || null;
}

/** 构造 AIUI 官方模型已生成结果的后台记录请求(不发送)。 */
export function buildAiuiRecordRequest(opts = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL, path = AIUI_RECORD_PATH,
    token, question, reply, snapshot, source = 'aiui-language-model', recordId,
  } = opts;
  const header = { 'Content-Type': 'application/json' };
  if (token) header.Authorization = `Bearer ${token}`;
  const data = {
    message: buildCoachMessage(question, snapshot),
    reply: String(reply || '').trim(),
    source: String(source || 'aiui-language-model'),
  };
  const clientRecordId = String(recordId || '').trim();
  if (/^[A-Za-z0-9._:-]{8,80}$/.test(clientRecordId)) {
    data.client_record_id = clientRecordId;
  }
  return {
    url: normalizeBaseUrl(baseUrl) + path,
    method: 'POST',
    header,
    dataType: 'json',
    responseType: 'text',
    data,
  };
}

/** 解析 AIUI 记录响应;成功返回 true,失败返回 false。 */
export function parseAiuiRecordResponse(resp) {
  return !!(resp && resp.statusCode === 200 && resp.data && resp.data.ok === true);
}

// ── 旧版本兼容:匿名直登 ─────────────────────────────────────
// 新版身份主链在 device_identity.js。这里仅保留已部署旧后端的显式 app_key 回退；
// 不能用于新设备所有权、APK 绑定或跨用户历史迁移。
export const ANON_LOGIN_PATH = '/api/coach-svc/coach/anon-login';

/** 构造匿名直登请求(不发送)。 */
export function buildAnonLoginRequest(opts = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL, path = ANON_LOGIN_PATH,
    appKey, clientId = DEFAULT_COACH_CLIENT_ID, deviceId,
  } = opts;
  const appId = String(clientId || DEFAULT_COACH_CLIENT_ID).trim() || DEFAULT_COACH_CLIENT_ID;
  const data = { app_id: appId, device_id: deviceId };
  if (appKey) data.app_key = String(appKey).trim();
  return {
    url: normalizeBaseUrl(baseUrl) + path,
    method: 'POST',
    header: { 'Content-Type': 'application/json' },
    dataType: 'json',
    responseType: 'text',
    data,
  };
}

/** 解析匿名直登响应 → JWT 字符串;非 200 / 无 token 返回 null(降级到设备端 LLM)。 */
export function parseAnonLoginResponse(resp) {
  if (!resp || resp.statusCode !== 200) return null;
  const d = resp.data;
  const token = d && typeof d.token === 'string' ? d.token.trim() : '';
  return token || null;
}

// ── 记忆增强(省 token 方案) ──────────────────────────────────
// 本端点只从后端"检索记忆"(不跑 LLM),把用户历史记忆+画像注入
// AIUI 官方 LanguageModel prompt。best-effort,取不到不影响主流程。
export const MEMORY_CONTEXT_PATH = '/api/coach-svc/coach/memory-context';
const MEMORY_CONTEXT_ITEMS_MAX = 5;
const MEMORY_SNIPPET_MAX = 80;
const MEMORY_PROFILE_MAX = 120;

// 记忆内容来自仓库外后端，进入任何 AIUI prompt 前先去换行/方括号并限长，
// 防止跨行指令、闭合框架或超长上下文直接污染固定跑后总结提示词。
function sanitizeSnippet(value, max) {
  return String(value ?? '').replace(/[\r\n\[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 构造记忆检索请求(不发送)。 */
export function buildMemoryContextRequest(opts = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL, path = MEMORY_CONTEXT_PATH, token, query,
  } = opts;
  const header = { 'Content-Type': 'application/json' };
  if (token) header.Authorization = `Bearer ${token}`;
  return {
    url: normalizeBaseUrl(baseUrl) + path,
    method: 'POST',
    header,
    dataType: 'json',
    responseType: 'text',
    data: { query: String(query || '') },
  };
}

/** 解析记忆检索响应 → { memories:[], profile:'' };非 200 返回 null。 */
export function parseMemoryContext(resp) {
  if (!resp || resp.statusCode !== 200 || !resp.data) return null;
  const d = resp.data;
  return {
    memories: Array.isArray(d.memories)
      ? d.memories.filter((item) => typeof item === 'string')
        .map((item) => sanitizeSnippet(item, MEMORY_SNIPPET_MAX))
        .filter(Boolean)
        .slice(0, MEMORY_CONTEXT_ITEMS_MAX)
      : [],
    profile: typeof d.profile === 'string'
      ? sanitizeSnippet(d.profile, MEMORY_PROFILE_MAX)
      : '',
  };
}

/** 把记忆 + 画像 + 实时快照拼进用户问题,喂给眼镜内置模型(有记忆则个性化,没有也能答)。 */
export function buildAugmentedQuestion(question, snapshot, memCtx) {
  const q = String(question || '').trim();
  const parts = [];
  if (memCtx && Array.isArray(memCtx.memories) && memCtx.memories.length) {
    const snippets = memCtx.memories.slice(0, MEMORY_CONTEXT_ITEMS_MAX)
      .map((m) => sanitizeSnippet(m, MEMORY_SNIPPET_MAX))
      .filter((m) => m.length > 0);
    if (snippets.length) parts.push(`[关于我: ${snippets.join('; ')}]`);
  }
  if (memCtx && memCtx.profile) {
    parts.push(`[画像: ${sanitizeSnippet(memCtx.profile, MEMORY_PROFILE_MAX)}]`);
  }
  const ctx = summarizeSnapshot(snapshot);
  if (ctx && ctx !== '暂无运动数据') parts.push(`[实时: ${ctx}]`);
  return parts.length ? `${parts.join(' ')} ${q}` : q;
}
