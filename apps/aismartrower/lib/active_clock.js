function timestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export class ActiveClock {
  constructor() { this.reset(); }

  reset() {
    this.state = 'idle';
    this.startedAtMs = null;
    this.activeStartedAtMs = null;
    this.accruedMs = 0;
    this.finishedAtMs = null;
  }

  start(nowMs = Date.now()) {
    const now = timestamp(nowMs);
    if (now == null || this.state !== 'idle') return false;
    this.state = 'active';
    this.startedAtMs = now;
    this.activeStartedAtMs = now;
    return true;
  }

  pause(nowMs = Date.now()) {
    const now = timestamp(nowMs);
    if (now == null || this.state !== 'active'
        || now < this.activeStartedAtMs) return false;
    this.accruedMs += now - this.activeStartedAtMs;
    this.activeStartedAtMs = null;
    this.state = 'paused';
    return true;
  }

  resume(nowMs = Date.now()) {
    const now = timestamp(nowMs);
    if (now == null || this.state !== 'paused') return false;
    this.activeStartedAtMs = now;
    this.state = 'active';
    return true;
  }

  finish(nowMs = Date.now()) {
    const now = timestamp(nowMs);
    if (now == null || (this.state !== 'active' && this.state !== 'paused')) {
      return false;
    }
    if (this.state === 'active' && !this.pause(now)) return false;
    this.state = 'finished';
    this.finishedAtMs = now;
    return true;
  }

  elapsedMs(nowMs = Date.now()) {
    const now = timestamp(nowMs);
    if (now == null || this.state === 'idle') return 0;
    if (this.state !== 'active') return this.accruedMs;
    if (now < this.activeStartedAtMs) return this.accruedMs;
    return this.accruedMs + now - this.activeStartedAtMs;
  }

  snapshot(nowMs = Date.now()) {
    return {
      state: this.state,
      startedAtMs: this.startedAtMs,
      finishedAtMs: this.finishedAtMs,
      elapsedMs: this.elapsedMs(nowMs),
    };
  }
}
