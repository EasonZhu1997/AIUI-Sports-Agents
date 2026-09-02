// AI 跑步教练领域逻辑 —— 纯函数，无 AIUI/wx/DOM 依赖，可单测。
//   buildCoachSystemPrompt: 把实时跑步数据注入 LLM system prompt（这是本产品
//     相对 Runsight/HuBu 纯数据显示器的差异化：教练"看得见"你的当前状态）。
//   fallbackCoachReply: LLM/网络不可用时的确定性兜底回答（镜像 FunpizzaSmartRun
//     chat_fallback 思路——跑步中绝不把用户晾在"出错了"上，规则化也要给一句有用的话）。
// snapshot 形状对齐 RunSession.snapshot() + HUD 已算好的 zone/paceSecPerKm。

import { formatElapsed, formatPace, formatDistanceKm, PACE_PENDING } from './format.js';
import {
  heartRatePolicyConfidence,
  isConservativeHighHeartRate,
} from './heart_rate_policy.js';

// 眼镜上的话必须极短:用户在跑步,没时间听长句。回复≤15个汉字硬约束。
const PERSONA =
  '你是 AISmartRun 的 AI 跑步教练，正通过 AI 眼镜陪用户跑步。' +
  '回答必须是一句话、不超过15个汉字、口语化、可直接朗读，不用列表和表情。' +
  '没有心率数据时不得猜心率，可按配速、步频和体感建议。' +
  '不诊断疾病、不给医疗建议；心率明显偏高时优先提醒降速和呼吸。' +
  '只有用户明确设置或 Garmin 档案提供最大心率时才能建议提速；' +
  '年龄估算、保守默认或缺失策略只能中性描述，偏高时建议降速。';

function snapshotHeartRatePolicy(s) {
  const maxHrBpm = Number(s && s.heartRateMaxHrBpm);
  if (!s || typeof s !== 'object' || !Number.isInteger(maxHrBpm)
      || maxHrBpm < 120 || maxHrBpm > 230) {
    return null;
  }
  return {
    max_hr_bpm: maxHrBpm,
    source: typeof s.heartRatePolicySource === 'string'
      ? s.heartRatePolicySource : '',
  };
}

function snapshotHeartRateConfidence(s) {
  return heartRatePolicyConfidence(snapshotHeartRatePolicy(s));
}

function snapshotHeartRateHigh(s) {
  const snap = s && typeof s === 'object' ? s : {};
  if (Number(snap.zone) >= 5) return true;
  return isConservativeHighHeartRate(Number(snap.bpm), snapshotHeartRatePolicy(snap));
}

/** 把 snapshot 压成一行人类可读的状态串，供 prompt 注入与兜底复用。 */
export function summarizeSnapshot(s) {
  if (!s || typeof s !== 'object') return '暂无运动数据';
  const parts = [];
  if (Number.isFinite(s.bpm) && s.bpm > 0) {
    const confidence = snapshotHeartRateConfidence(s);
    const zone = Number(s.zone) > 0 ? Number(s.zone) : 0;
    const zoneCopy = zone > 0 && confidence === 'trusted'
      ? `(Z${zone})`
      : (zone > 0 && confidence === 'estimated' ? `(估算Z${zone})` : '');
    parts.push(`心率 ${Math.round(s.bpm)}${zoneCopy}`);
  }
  if (Number.isFinite(s.paceSecPerKm) && s.paceSecPerKm > 0) {
    const p = formatPace(s.paceSecPerKm);
    if (p !== PACE_PENDING) parts.push(`配速 ${p}/km`);
  }
  if (Number.isFinite(s.cadenceSpm) && s.cadenceSpm > 0) {
    parts.push(`步频 ${Math.round(s.cadenceSpm)}`);
  }
  if (Number.isFinite(s.distanceM) && s.distanceM > 0) {
    parts.push(`距离 ${formatDistanceKm(s.distanceM)}km`);
  }
  if (Number.isFinite(s.elapsedMs) && s.elapsedMs > 0) {
    parts.push(`时长 ${formatElapsed(s.elapsedMs)}`);
  }
  if (s.paused) parts.push('已暂停');
  return parts.length ? parts.join('，') : '暂无运动数据';
}

/** LLM system prompt = 人设 + 实时数据快照。 */
export function buildCoachSystemPrompt(s) {
  const confidence = snapshotHeartRateConfidence(s);
  const policyCopy = confidence === 'trusted'
    ? '最大心率来源已确认，可按区间给建议。'
    : (confidence === 'estimated'
      ? '心率区间仅为估算，禁止建议提速。'
      : '没有个人最大心率策略，只显示 BPM，禁止推断区间或建议提速。');
  return `${PERSONA}\n心率策略：${policyCopy}\n当前实时数据：${summarizeSnapshot(s)}。`;
}

/**
 * 只含人设的 system prompt:LLM 会话跨轮复用,实时数据每轮由
 * buildAugmentedQuestion 注入问题,避免会话创建瞬间的快照被"冻结"成全程事实。
 */
export function buildCoachPersonaPrompt() {
  return PERSONA;
}

// 教练回复消毒上限:一句话口径,给"15 汉字"目标留一点标点/数字余量。
const REPLY_MAX_CHARS = 42;

/**
 * LLM 输出后置消毒:prompt 约束(≤15字/无列表/无 markdown)对模型只是请求,
 * 这里做确定性兜底——去 markdown 符号与换行、压空白、超长截到句读。
 * 返回 '' 表示没有可用内容(调用方应走规则兜底)。
 */
export function sanitizeCoachReply(text, maxChars = REPLY_MAX_CHARS) {
  let t = String(text || '');
  t = t.replace(/```[\s\S]*?```/g, ' ');            // 代码块整体丢弃
  t = t.replace(/[*#`>_~|]+/g, ' ');                // markdown 标记
  t = t.replace(/^\s*[-•·]\s+/gm, ' ');             // 列表符
  t = t.replace(/\s+/g, ' ').trim();                // 换行/多空白 → 单空格
  if (!t) return '';
  if (t.length <= maxChars) return t;
  const head = t.slice(0, maxChars);
  // 优先在句读处截断,保住一句完整话;找不到就硬截。
  const cut = Math.max(
    head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
    head.lastIndexOf('，'), head.lastIndexOf('.'), head.lastIndexOf('!'),
  );
  return cut >= 8 ? head.slice(0, cut + 1) : head;
}

/**
 * 主动语音提示:比较上一拍与当前快照,决定教练是否该「主动开口」(TTS),
 * 不用等用户问。纯函数,眼镜端定时器每拍调用一次;返回一句话或 null。
 * 优先级:进 Z5 安全降速 > Z5 持续每分钟重复 > 整公里配速播报 > 每 5 分钟基础鼓励 > 进 Z4 提醒。
 *
 * Rokid Agent Framework 过渡期内，跑中只保留确定性的心率/配速播报与
 * 简短鼓励；不把步频等其他指标包装成在线 Agent 建议。
 * snapshot 形状:{ distanceM, elapsedMs, zone, cadenceSpm, paceSecPerKm }。
 */
export function nextProactiveCue(prev, cur) {
  if (!cur || typeof cur !== 'object') return null;
  const pz = prev && Number.isFinite(prev.zone) ? prev.zone : 0;
  const cz = Number.isFinite(cur.zone) ? cur.zone : 0;
  const confidence = snapshotHeartRateConfidence(cur);
  const currentHigh = snapshotHeartRateHigh(cur);
  const previousHigh = snapshotHeartRateHigh(prev);

  // 1) 安全优先:刚进 Z5 无条件提醒降速(≤15字)
  if (currentHigh && !previousHigh) {
    return cz >= 5 && confidence === 'trusted'
      ? '心率 Z5 了，降速深呼吸。'
      : '心率偏高，先降速。';
  }

  // 1b) 持续停留 Z5:每满 1 分钟重复提醒(边沿触发一次不够,安全提示要跟人)
  if (currentHigh && previousHigh) {
    const pMin = prev && Number.isFinite(prev.elapsedMs) ? Math.floor(prev.elapsedMs / 60000) : 0;
    const cMin = Number.isFinite(cur.elapsedMs) ? Math.floor(cur.elapsedMs / 60000) : 0;
    if (cMin > pMin) {
      return cz >= 5 && confidence === 'trusted'
        ? '还在 Z5，先降下来。'
        : '心率仍偏高，先降速。';
    }
  }

  // 2) 整公里里程碑
  const pd = prev && Number.isFinite(prev.distanceM) ? prev.distanceM : 0;
  const cd = Number.isFinite(cur.distanceM) ? cur.distanceM : 0;
  if (cd >= 1000 && Math.floor(cd / 1000) > Math.floor(pd / 1000)) {
    const km = Math.floor(cd / 1000);
    const p = Number.isFinite(cur.paceSecPerKm) && cur.paceSecPerKm > 0
      ? formatPace(cur.paceSecPerKm) : PACE_PENDING;
    return p !== PACE_PENDING
      ? `第 ${km} 公里，配速 ${p}。`
      : `${km} 公里了，继续。`;
  }

  // 3) 每 5 分钟：优先把新鲜 BPM 与可信配速一起读出；缺一路时仍保留
  // 对应数值或基础鼓励。run_hud 只会把通过新鲜度门的 bpm 放进 cur。
  const pm = prev && Number.isFinite(prev.elapsedMs) ? Math.floor(prev.elapsedMs / 300000) : 0;
  const cm = Number.isFinite(cur.elapsedMs) ? Math.floor(cur.elapsedMs / 300000) : 0;
  if (cm >= 1 && cm > pm) {
    const pace = Number.isFinite(cur.paceSecPerKm) && cur.paceSecPerKm > 0
      ? formatPace(cur.paceSecPerKm) : PACE_PENDING;
    const bpm = Number.isFinite(cur.bpm) && cur.bpm > 0
      ? Math.round(cur.bpm) : 0;
    if (bpm > 0 && pace !== PACE_PENDING) return `心率${bpm}，配速${pace}。`;
    if (bpm > 0) return `心率${bpm}，保持节奏。`;
    return pace !== PACE_PENDING
      ? `${cm * 5}分钟，配速${pace}。`
      : `${cm * 5}分钟了，保持节奏。`;
  }

  // 4) 刚进 Z4:提醒别再猛加
  if (confidence === 'trusted' && cz === 4 && pz < 4) {
    return '到 Z4 了，别再加速。';
  }

  return null;
}

/** 粗分用户问题意图，仅用于兜底回答选择模板。 */
export function classifyIntent(question) {
  const t = String(question || '');
  if (/配速|速度|快|慢|提速|加速|降速/.test(t)) return 'pace';
  if (/心率|心跳|bpm|区间|zone/i.test(t)) return 'hr';
  if (/距离|多远|公里|千米|km/i.test(t)) return 'distance';
  if (/多久|时间|多长|跑了多少时间|还要跑/.test(t)) return 'time';
  return 'general';
}

function hasMotionData(snap) {
  return (Number.isFinite(snap.paceSecPerKm) && snap.paceSecPerKm > 0) ||
    (Number.isFinite(snap.cadenceSpm) && snap.cadenceSpm > 0) ||
    (Number.isFinite(snap.distanceM) && snap.distanceM > 0);
}

/**
 * 确定性兜底教练回答：LLM 不可用/超时时调用。
 * 安全优先——zone>=5 无条件提醒降速，覆盖任何问题意图。
 */
export function fallbackCoachReply(s, question) {
  const snap = s && typeof s === 'object' ? s : {};
  const zone = Number.isFinite(snap.zone) ? snap.zone : 0;
  const confidence = snapshotHeartRateConfidence(snap);

  if (snapshotHeartRateHigh(snap)) {
    return zone >= 5 && confidence === 'trusted'
      ? '心率 Z5 了，降速深呼吸。'
      : '心率偏高，先降速。';
  }

  switch (classifyIntent(question)) {
    case 'pace': {
      const p = Number.isFinite(snap.paceSecPerKm) && snap.paceSecPerKm > 0
        ? formatPace(snap.paceSecPerKm) : PACE_PENDING;
      if (p !== PACE_PENDING) {
        if (confidence === 'trusted' && zone >= 4) return `配速 ${p}，稍收一点。`;
        return `配速 ${p}，保持稳定。`;
      }
      return '先匀速跑两分钟再看。';
    }
    case 'hr':
      if (Number.isFinite(snap.bpm) && snap.bpm > 0) {
        if (confidence === 'trusted' && zone > 0) {
          return `心率 ${Math.round(snap.bpm)} Z${zone}，${zone >= 4 ? '偏高' : '稳定'}。`;
        }
        if (confidence === 'estimated' && zone > 0) {
          return `心率 ${Math.round(snap.bpm)}，区间仅估算。`;
        }
        return `心率 ${Math.round(snap.bpm)}，正在记录。`;
      }
      return '当前无心率数据。';
    case 'distance':
      if (Number.isFinite(snap.distanceM) && snap.distanceM > 0) {
        return `已跑 ${formatDistanceKm(snap.distanceM)} 公里，加油。`;
      }
      return '刚起步，慢慢来。';
    case 'time':
      if (Number.isFinite(snap.elapsedMs) && snap.elapsedMs > 0) {
        return `已跑 ${formatElapsed(snap.elapsedMs)}，稳住。`;
      }
      return '刚开始，进状态。';
    default:
      if (confidence === 'trusted' && zone >= 4) return '心率偏高，放慢些。';
      if (confidence === 'trusted' && zone > 0 && zone <= 2) return '很轻松，可稳提速。';
      if (!hasMotionData(snap)) return '先稳跑，找节奏。';
      return '数据记录中，保持稳定。';
  }
}
