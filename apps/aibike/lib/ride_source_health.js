// AIBike 数据源保活决策。
//
// 该模块不读取页面、定时器或系统时钟。调用方把同一墙钟域的时间传入，
// 决策层只区分状态并给出恢复建议；实际重订阅与 UI 更新仍由
// 页面负责。AR hidden 由页面原子暂停并换代资源；本模块不清零指标或结束骑行。

export const RIDE_SOURCE_HEALTH_STATE = Object.freeze({
  WAITING: 'waiting',
  STALE: 'stale',
  FRESH: 'fresh',
  UNSUPPORTED: 'unsupported',
});

export const RIDE_SOURCE_LIFECYCLE = Object.freeze({
  ACTIVE: 'active',
  HIDDEN: 'hidden',
  SHOW: 'show',
});

export const RIDE_SOURCE_HEALTH_LIMITS = Object.freeze({
  hrsFirstPacketMs: 20000,
  hrsFreshMs: 8000,
});

const SUPPORTED_SOURCES = Object.freeze(['hrs']);

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeLifecycle(value) {
  return Object.values(RIDE_SOURCE_LIFECYCLE).includes(value)
    ? value : RIDE_SOURCE_LIFECYCLE.ACTIVE;
}

function sourceTimeoutMs(source, hasSample, options) {
  return hasSample
    ? RIDE_SOURCE_HEALTH_LIMITS.hrsFreshMs
    : RIDE_SOURCE_HEALTH_LIMITS.hrsFirstPacketMs;
}

function sourceReason(source, hasSample, healthy) {
  if (!hasSample) return healthy ? 'first-packet-wait' : 'first-packet-timeout';
  return healthy ? 'packet-fresh' : 'packet-stale';
}

function finalizeDecision(base, options) {
  const lifecycle = normalizeLifecycle(options.lifecycle);
  const sessionActive = options.sessionActive !== false;
  const hasLastValue = options.hasLastValue === true;
  const stale = base.state === RIDE_SOURCE_HEALTH_STATE.STALE;
  const recovering = lifecycle === RIDE_SOURCE_LIFECYCLE.SHOW;
  const hidden = lifecycle === RIDE_SOURCE_LIFECYCLE.HIDDEN;
  const shouldKeepLastValue = stale
    && sessionActive
    && hasLastValue
    && (hidden || recovering);
  return {
    ...base,
    lifecycle,
    shouldRestart: stale && sessionActive && !hidden,
    shouldKeepLastValue,
    shouldClearValue: stale && hasLastValue && !shouldKeepLastValue,
    // 数据源断流不得替调用方结束整场骑行。
    shouldEndSession: false,
  };
}

/**
 * 计算 HRS 当前状态与恢复动作。
 *
 * 输入时间必须属于同一单调墙钟域：
 * - startedAtMs：HRS 通知订阅成功时间；
 * - lastSampleAtMs：最后一个已接收 HRS 包；
 * - nowMs：本次决策时间；
 * - lifecycle：active、hidden 或 show；
 * - supported：运行时是否具有该数据源能力；
 * - hasLastValue：HUD 是否已有可保留的该来源显示值；
 *
 * 截止点使用闭区间：恰好 20s / 8s 时仍为 waiting/fresh，
 * 超过截止点才进入 stale，避免定时器在边界抖动时提前重建。
 */
export function decideRideSourceHealth(options = {}) {
  const source = typeof options.source === 'string'
    ? options.source.toLowerCase() : '';
  const lifecycle = normalizeLifecycle(options.lifecycle);
  if (!SUPPORTED_SOURCES.includes(source) || options.supported !== true) {
    return {
      source,
      state: RIDE_SOURCE_HEALTH_STATE.UNSUPPORTED,
      reason: SUPPORTED_SOURCES.includes(source)
        ? 'source-unsupported' : 'unknown-source',
      lifecycle,
      ageMs: null,
      timeoutMs: null,
      deadlineAtMs: null,
      shouldRestart: false,
      shouldKeepLastValue: false,
      shouldClearValue: false,
      shouldEndSession: false,
    };
  }

  if (options.sessionActive === false) {
    return {
      source,
      state: RIDE_SOURCE_HEALTH_STATE.WAITING,
      reason: 'session-inactive',
      lifecycle,
      ageMs: null,
      timeoutMs: null,
      deadlineAtMs: null,
      shouldRestart: false,
      shouldKeepLastValue: false,
      shouldClearValue: false,
      shouldEndSession: false,
    };
  }

  const nowMs = finite(options.nowMs);
  const startedAtMs = finite(options.startedAtMs);
  const lastSampleAtMs = finite(options.lastSampleAtMs);
  const hasSample = lastSampleAtMs != null;
  const hasLastValue = options.hasLastValue == null
    ? hasSample : options.hasLastValue === true;
  const timeoutMs = sourceTimeoutMs(source, hasSample, options);
  const referenceAtMs = hasSample ? lastSampleAtMs : startedAtMs;

  if (nowMs == null || referenceAtMs == null) {
    return finalizeDecision({
      source,
      state: RIDE_SOURCE_HEALTH_STATE.WAITING,
      reason: nowMs == null ? 'invalid-clock' : 'source-not-started',
      ageMs: null,
      timeoutMs,
      deadlineAtMs: null,
    }, {
      ...options,
      lifecycle,
      hasLastValue,
    });
  }

  const invalidTimeline = referenceAtMs > nowMs
    || (hasSample && startedAtMs != null && lastSampleAtMs < startedAtMs);
  if (invalidTimeline) {
    return finalizeDecision({
      source,
      state: RIDE_SOURCE_HEALTH_STATE.STALE,
      reason: 'invalid-timeline',
      ageMs: null,
      timeoutMs,
      deadlineAtMs: null,
    }, {
      ...options,
      lifecycle,
      hasLastValue,
    });
  }

  const ageMs = nowMs - referenceAtMs;
  const healthy = ageMs <= timeoutMs;
  return finalizeDecision({
    source,
    state: healthy
      ? (hasSample
        ? RIDE_SOURCE_HEALTH_STATE.FRESH
        : RIDE_SOURCE_HEALTH_STATE.WAITING)
      : RIDE_SOURCE_HEALTH_STATE.STALE,
    reason: sourceReason(source, hasSample, healthy),
    ageMs,
    timeoutMs,
    deadlineAtMs: referenceAtMs + timeoutMs,
  }, {
    ...options,
    lifecycle,
    hasLastValue,
  });
}

export function decideHrsSourceHealth(options = {}) {
  return decideRideSourceHealth({
    ...options,
    source: 'hrs',
    lastSampleAtMs: options.lastSampleAtMs ?? options.lastPacketAtMs,
  });
}
