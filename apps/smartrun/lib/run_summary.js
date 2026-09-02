// 跑后 AI 总结 —— 纯函数层,可单测:
//   run_hud 结束跑步时写入待办;下次前台代次在后台走 Tier1 AIUI LanguageModel
//   (可注入配置后端的记忆上下文)生成 ≤40 字中文总结,失败由规则兜底;
//   最终文本经 aiui-record 交给配置后端持久化，但不再改写首页 UI。
import { formatDistanceKm, formatElapsed, formatPace } from './format.js';
import {
  heartRatePolicyConfidence,
  isConservativeHighHeartRate,
  normalizeHeartRatePolicy,
} from './heart_rate_policy.js';

export const RUN_SUMMARY_PENDING_KEY = 'pending_run_summary';
export const RUN_SUMMARY_QUESTION = '本次跑步总结';
export const RUN_SUMMARY_MAX_CHARS = 40;

const SUMMARY_HR_MIN_BPM = 30;
const SUMMARY_HR_MAX_BPM = 240;
const MODEL_TEXT_ALLOWED_RE = /^[\u3400-\u9fff\uf900-\ufaffA-Za-z0-9\s，。！？、；：,.!?:;%％/＋+\-—（）()]+$/;
const MODEL_TEXT_UNSAFE_RE = /(https?:\/\/|www\.|诊断|确诊|疾病|病症|心脏病|心律失常|冠心病|心肌|高血压|低血压|药物|吃药|停药|治疗|医生|就医|提速|加速|冲刺|再快|更快|放心.{0,4}跑|保证|一定能|必然|无需恢复|不用休息|忽略.{0,8}(规则|指令|提示)|系统提示|开发者指令|prompt)/i;
const MODEL_TEXT_HEART_RATE_CLAIM_RE = /(心率|心跳|bpm|z[1-5]|区间|强度|有氧|无氧|乳酸|燃脂)/i;
const MODEL_INTENT_ALLOWLIST = Object.freeze([
  Object.freeze({
    id: 'recovery',
    pattern: /(补水|恢复|休息|放松|拉伸)/,
    copy: '注意补水和恢复。',
  }),
  Object.freeze({
    id: 'steady',
    pattern: /(稳定|节奏|步频|配速|保持)/,
    copy: '保持稳定节奏。',
  }),
  Object.freeze({
    id: 'complete',
    pattern: /(完成|坚持|继续|不错|很好|加油|漂亮)/,
    copy: '完成本次训练。',
  }),
]);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizedBpm(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value !== 'number' && typeof value !== 'string') return -1;
  const bpm = Number(value);
  // Preserve malformed values as an explicit fail-closed sentinel. Collapsing
  // them to zero would make a damaged HR field indistinguishable from no HR.
  return Number.isFinite(bpm) ? bpm : -1;
}

function normalizeMinuteSeries(value, mode) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (let i = 0; i < value.length && result.length < 30; i += 1) {
    const item = value[i] && typeof value[i] === 'object' ? value[i] : {};
    const minute = Math.round(Number(item.minute));
    const metric = Number(item.value);
    if (!(minute > 0) || !Number.isFinite(metric) || metric <= 0) continue;
    result.push({
      minute,
      value: mode === 'slow' ? Math.round(metric) : Math.round(metric),
    });
  }
  return result;
}

export function normalizeRunSummary(value) {
  const src = value && typeof value === 'object' ? value : {};
  const rawMode = String(src.mode || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  const mode = rawMode === 'slow'
    ? 'slow'
    : (['garmin-virtual', 'virtual', 'virtual-run'].includes(rawMode)
      ? 'garmin_virtual' : 'free');
  const summary = {
    mode,
    startedAtMs: num(src.startedAtMs || src.startMs),
    elapsedMs: num(src.elapsedMs),
    distanceM: num(src.distanceM),
    avgPaceSecPerKm: num(src.avgPaceSecPerKm),
    avgBpm: normalizedBpm(src.avgBpm),
    maxBpm: normalizedBpm(src.maxBpm),
    avgCadenceSpm: num(src.avgCadenceSpm),
    steps: num(src.steps),
    endedAtMs: num(src.endedAtMs),
    minuteSeries: normalizeMinuteSeries(src.minuteSeries, mode),
  };
  const rawPolicy = src.heartRatePolicy || src.heart_rate_policy;
  if (rawPolicy) {
    // HeartRatePolicy is frozen when the run starts. Validate it at that same
    // instant so a legitimate policy does not become retroactively invalid
    // merely because the summary is archived after its expiry time.
    const policyAtMs = summary.startedAtMs || summary.endedAtMs || Date.now();
    const heartRatePolicy = normalizeHeartRatePolicy(rawPolicy, { nowMs: policyAtMs });
    if (heartRatePolicy) summary.heartRatePolicy = { ...heartRatePolicy };
  }
  // 与跑步补传同一道门槛思想:没有正时长的记录不值得总结。
  if (summary.elapsedMs <= 0) return null;
  // 总结页生成的文本可随待办交给后台归档；消费端仍会重新经过安全门。
  const text = typeof src.text === 'string' ? src.text.trim().slice(0, 120) : '';
  if (text) summary.text = text;
  return summary;
}

export function writePendingRunSummary(storage, value) {
  const summary = normalizeRunSummary(value);
  if (!summary || !storage || typeof storage.setStorageSync !== 'function') return null;
  try {
    storage.setStorageSync(RUN_SUMMARY_PENDING_KEY, summary);
    const roundTrip = normalizeRunSummary(storage.getStorageSync(RUN_SUMMARY_PENDING_KEY));
    return JSON.stringify(roundTrip) === JSON.stringify(summary) ? summary : null;
  } catch (_e) {
    return null;
  }
}

export function readPendingRunSummary(storage) {
  const state = readPendingRunSummaryState(storage);
  return state.ok ? state.summary : null;
}

/**
 * Read the single crash-recovery summary without collapsing storage failure or
 * corruption into an ordinary empty slot. Callers that may write a new run
 * must use this stateful form so a transient read failure cannot overwrite the
 * only recoverable summary from the previous run.
 */
export function readPendingRunSummaryState(storage) {
  if (!storage || typeof storage.getStorageSync !== 'function') {
    return Object.freeze({ ok: false, status: 'storage_unavailable', summary: null });
  }
  try {
    const raw = storage.getStorageSync(RUN_SUMMARY_PENDING_KEY);
    if (raw === undefined || raw === null || raw === '') {
      return Object.freeze({ ok: true, status: 'empty', summary: null });
    }
    const summary = normalizeRunSummary(raw);
    if (!summary) {
      return Object.freeze({ ok: false, status: 'corrupt', summary: null });
    }
    return Object.freeze({ ok: true, status: 'ready', summary });
  } catch (_e) {
    return Object.freeze({ ok: false, status: 'read_failed', summary: null });
  }
}

export function clearPendingRunSummary(storage) {
  if (!storage || typeof storage.removeStorageSync !== 'function'
      || typeof storage.getStorageSync !== 'function') return false;
  try {
    storage.removeStorageSync(RUN_SUMMARY_PENDING_KEY);
    const raw = storage.getStorageSync(RUN_SUMMARY_PENDING_KEY);
    return raw === undefined || raw === null || raw === '';
  } catch (_e) {
    return false;
  }
}

/** 数据一句话:给 LLM 的事实输入,也是兜底文案的骨架。 */
export function formatRunStats(value) {
  const summary = normalizeRunSummary(value);
  if (!summary) return '';
  const parts = summary.mode === 'slow'
    ? [
      '超慢跑步数 ' + Math.round(summary.steps),
      '用时 ' + formatElapsed(summary.elapsedMs),
    ]
    : [
      '距离 ' + formatDistanceKm(summary.distanceM) + ' 公里',
      '用时 ' + formatElapsed(summary.elapsedMs),
    ];
  if (summary.mode !== 'slow' && summary.avgPaceSecPerKm > 0) {
    parts.push('平均配速 ' + formatPace(summary.avgPaceSecPerKm));
  }
  const heartRate = runSummaryHeartRateSafety(summary);
  if (heartRate.valid && summary.avgBpm > 0) {
    parts.push('平均心率 ' + Math.round(summary.avgBpm)
      + (summary.maxBpm > 0 ? '(最高 ' + Math.round(summary.maxBpm) + ')' : ''));
  }
  if (summary.avgCadenceSpm > 0) parts.push('平均步频 ' + Math.round(summary.avgCadenceSpm));
  return parts.join('，');
}

export function buildRunSummaryPrompt(value, memoryContext = '') {
  const summary = normalizeRunSummary(value);
  const stats = formatRunStats(summary);
  const memory = String(memoryContext || '').trim();
  const heartRate = runSummaryHeartRateSafety(summary);
  let heartRateRule = '本次没有可用心率，不得猜测心率或个体强度。';
  if (heartRate.hasHeartRate && !heartRate.valid) {
    heartRateRule = '本次心率字段异常，不得解释心率或个体强度。';
  } else if (heartRate.hasHeartRate && heartRate.confidence !== 'trusted') {
    heartRateRule = '本次没有可信个人最大心率，只能复述 BPM，不得评价强度合适或建议提速。';
  } else if (heartRate.hasHeartRate && heartRate.high) {
    heartRateRule = '本次心率达到保守高值，只能中性复述事实，不得给积极强度结论或建议提速。';
  } else if (heartRate.hasHeartRate) {
    heartRateRule = '最大心率来自用户明确设置或 Garmin 档案；仍不得作医疗诊断或建议提速。';
  }
  return '请用不超过 ' + RUN_SUMMARY_MAX_CHARS + ' 个字的中文总结这次跑步,'
    + '只描述给出的事实，可给恢复或稳定节奏提示，不用列表、不用表情。'
    + '不得作医疗诊断，不得承诺或建议提速。\n'
    + '心率规则:' + heartRateRule + '\n'
    + '本次数据:' + stats
    + (memory ? '\n跑者历史:' + memory : '');
}

function plausibleBpm(value) {
  const bpm = Number(value);
  return bpm === 0 || (Number.isFinite(bpm)
    && bpm >= SUMMARY_HR_MIN_BPM && bpm <= SUMMARY_HR_MAX_BPM);
}

/**
 * Heart-rate safety facts used by both prompt construction and the output
 * gate. The observed max BPM is never treated as a personal maximum.
 */
export function runSummaryHeartRateSafety(value) {
  const summary = normalizeRunSummary(value);
  if (!summary) {
    return Object.freeze({
      valid: false,
      hasHeartRate: false,
      confidence: 'missing',
      high: false,
      reason: 'summary_invalid',
    });
  }
  const avgBpm = Number(summary.avgBpm) || 0;
  const maxBpm = Number(summary.maxBpm) || 0;
  const hasHeartRate = avgBpm > 0 || maxBpm > 0;
  const valid = plausibleBpm(avgBpm)
    && plausibleBpm(maxBpm)
    && !(avgBpm > 0 && maxBpm > 0 && maxBpm < avgBpm);
  const policy = summary.heartRatePolicy || null;
  const confidence = heartRatePolicyConfidence(policy);
  const highBpm = maxBpm > 0 ? maxBpm : avgBpm;
  const high = valid && hasHeartRate
    ? isConservativeHighHeartRate(highBpm, policy) : false;
  let reason = 'heart_rate_absent';
  if (!valid) reason = 'heart_rate_invalid';
  else if (hasHeartRate && confidence !== 'trusted') reason = 'heart_rate_untrusted';
  else if (hasHeartRate && high) reason = 'heart_rate_high';
  else if (hasHeartRate) reason = 'heart_rate_trusted';
  return Object.freeze({ valid, hasHeartRate, confidence, high, reason });
}

function factualRunSummary(summary, includeHeartRate = true) {
  if (!summary) return '';
  let text = summary.mode === 'slow'
    ? '本次超慢跑' + Math.round(summary.steps) + '步，用时'
      + formatElapsed(summary.elapsedMs) + '。'
    : '本次跑步' + formatDistanceKm(summary.distanceM) + '公里，用时'
      + formatElapsed(summary.elapsedMs) + '。';
  const heartRate = runSummaryHeartRateSafety(summary);
  if (includeHeartRate && heartRate.valid && heartRate.hasHeartRate) {
    if (summary.avgBpm > 0) text += '平均心率' + Math.round(summary.avgBpm);
    if (summary.maxBpm > 0) {
      text += (summary.avgBpm > 0 ? '，' : '') + '最高' + Math.round(summary.maxBpm);
    }
    text += '。';
  }
  return compactRunSummaryText(text, RUN_SUMMARY_MAX_CHARS);
}

/** Tier2 规则兜底:只复述本场事实，不从固定最大心率推导强度。 */
export function fallbackRunSummary(value) {
  return factualRunSummary(normalizeRunSummary(value));
}

function normalizeModelText(value) {
  const raw = String(value || '');
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return '';
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact || compact.length > 120 || !MODEL_TEXT_ALLOWED_RE.test(compact)) return '';
  return compact;
}

function allowedModelIntent(candidate) {
  for (const intent of MODEL_INTENT_ALLOWLIST) {
    if (intent.pattern.test(candidate)) return intent;
  }
  return null;
}

/**
 * Pure post-generation gate. Model prose is never rendered verbatim: a safe
 * candidate may select one allowlisted coaching intent, which is then rewritten
 * around locally computed facts. Any untrusted/abnormal HR or unsafe wording
 * falls back to the neutral factual summary.
 */
export function finalizeRunSummaryText(value, modelText = '') {
  const summary = normalizeRunSummary(value);
  const fallback = factualRunSummary(summary);
  if (!summary) {
    return Object.freeze({ text: '', usedModel: false, reason: 'summary_invalid' });
  }
  const heartRate = runSummaryHeartRateSafety(summary);
  if (!heartRate.valid) {
    return Object.freeze({ text: fallback, usedModel: false, reason: 'heart_rate_invalid' });
  }
  if (heartRate.hasHeartRate && heartRate.confidence !== 'trusted') {
    return Object.freeze({ text: fallback, usedModel: false, reason: 'heart_rate_untrusted' });
  }
  if (heartRate.hasHeartRate && heartRate.high) {
    return Object.freeze({ text: fallback, usedModel: false, reason: 'heart_rate_high' });
  }
  const candidate = normalizeModelText(modelText);
  if (!candidate) {
    return Object.freeze({ text: fallback, usedModel: false, reason: 'model_text_invalid' });
  }
  if (MODEL_TEXT_UNSAFE_RE.test(candidate)
      || MODEL_TEXT_HEART_RATE_CLAIM_RE.test(candidate)) {
    return Object.freeze({ text: fallback, usedModel: false, reason: 'model_text_unsafe' });
  }
  const intent = allowedModelIntent(candidate);
  if (!intent) {
    return Object.freeze({ text: fallback, usedModel: false, reason: 'model_intent_unapproved' });
  }
  const text = compactRunSummaryText(
    factualRunSummary(summary, false) + intent.copy,
    RUN_SUMMARY_MAX_CHARS,
  );
  return Object.freeze({
    text,
    usedModel: true,
    reason: 'model_intent_' + intent.id,
  });
}

/** 总结页与持久化记录共用的有界纯文本。 */
export function compactRunSummaryText(text, maxChars = 40) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, Math.max(1, maxChars - 1)) + '…';
}
