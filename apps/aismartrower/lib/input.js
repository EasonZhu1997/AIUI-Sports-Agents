const DIRECTION_REPEAT_DEDUPE_MS = 220;
const DIRECTION_ALIAS_DEDUPE_MS = 600;

export const SURFACE_DIRECTION_RELEASE_MS = 600;
export const SURFACE_ACTION_DEDUPE_MS = 600;
export const SURFACE_ENTRY_MS = 700;
export const SUMMARY_ENTRY_MS = 600;

function durationOrDefault(value, fallback) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration : fallback;
}

export function directionDelta(code) {
  if (code === 'ArrowDown' || code === 'ArrowRight') return 1;
  if (code === 'ArrowUp' || code === 'ArrowLeft') return -1;
  return 0;
}

export class DirectionDeduper {
  constructor() {
    this.reset();
  }

  reset() {
    this.lastCode = null;
    this.lastDelta = 0;
    this.lastAtMs = null;
    this.lastPhase = null;
  }

  claim(code, phase, nowMs = Date.now()) {
    const delta = directionDelta(code);
    if (!delta) return { handled: false, accepted: false, delta: 0 };
    const gapMs = this.lastAtMs == null
      ? Number.POSITIVE_INFINITY : nowMs - this.lastAtMs;
    const sameSemantic = this.lastPhase === phase
      && this.lastDelta === delta
      && gapMs >= 0;
    const duplicate = sameSemantic && (
      (this.lastCode === code && gapMs < DIRECTION_REPEAT_DEDUPE_MS)
      || (this.lastCode !== code && gapMs < DIRECTION_ALIAS_DEDUPE_MS)
    );
    if (!duplicate) {
      this.lastCode = code;
      this.lastDelta = delta;
      this.lastAtMs = nowMs;
      this.lastPhase = phase;
    }
    return { handled: true, accepted: !duplicate, delta };
  }
}

// keyup / GlobalHook / bindtap can all be emitted for one physical gesture.
// This gate keeps that gesture transactional across channels without owning any
// page state machine. Multi-press surfaces such as HUD finish confirmation can
// opt out of cross-channel dedupe and keep their own confirmation semantics.
export class SurfaceActionGate {
  constructor({
    now = Date.now,
    directionReleaseMs = SURFACE_DIRECTION_RELEASE_MS,
    actionDedupeMs = SURFACE_ACTION_DEDUPE_MS,
    surfaceEntryMs = SURFACE_ENTRY_MS,
    summaryEntryMs = SUMMARY_ENTRY_MS,
  } = {}) {
    this.now = typeof now === 'function' ? now : Date.now;
    this.directionReleaseMs = durationOrDefault(
      directionReleaseMs, SURFACE_DIRECTION_RELEASE_MS,
    );
    this.actionDedupeMs = durationOrDefault(actionDedupeMs, SURFACE_ACTION_DEDUPE_MS);
    this.surfaceEntryMs = durationOrDefault(surfaceEntryMs, SURFACE_ENTRY_MS);
    this.summaryEntryMs = durationOrDefault(summaryEntryMs, SUMMARY_ENTRY_MS);
    this.reset();
  }

  reset() {
    this.guardUntilMs = null;
    this.lastActionAtMs = null;
    this.lastActionId = null;
  }

  resolveNow(nowMs) {
    const timestamp = Number(nowMs);
    if (Number.isFinite(timestamp)) return timestamp;
    const injected = Number(this.now());
    return Number.isFinite(injected) ? injected : Date.now();
  }

  clearActionDedupe() {
    this.lastActionAtMs = null;
    this.lastActionId = null;
  }

  markDirectionRelease(nowMs = this.now()) {
    const now = this.resolveNow(nowMs);
    this.guardUntilMs = now + this.directionReleaseMs;
    this.clearActionDedupe();
    return this.guardUntilMs;
  }

  markSurfaceEntry(nowMs = this.now()) {
    const now = this.resolveNow(nowMs);
    this.guardUntilMs = now + this.surfaceEntryMs;
    this.clearActionDedupe();
    return this.guardUntilMs;
  }

  markSummaryEntry(nowMs = this.now()) {
    const now = this.resolveNow(nowMs);
    this.guardUntilMs = now + this.summaryEntryMs;
    this.clearActionDedupe();
    return this.guardUntilMs;
  }

  canClaim(actionId, nowMs = this.now(), options = {}) {
    const now = this.resolveNow(nowMs);
    if (this.guardUntilMs != null) {
      if (now < this.guardUntilMs) return false;
      this.guardUntilMs = null;
    }

    const crossChannelDedupe = !options || options.crossChannelDedupe !== false;
    if (!crossChannelDedupe) return true;

    if (this.lastActionAtMs != null) {
      const gapMs = now - this.lastActionAtMs;
      if (gapMs >= 0 && gapMs < this.actionDedupeMs) return false;
    }

    this.lastActionAtMs = now;
    this.lastActionId = actionId == null ? null : String(actionId);
    return true;
  }
}
