export class PendingConfirm {
  constructor({ delayMs = 600, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.delayMs = delayMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
  }

  schedule(callback) {
    if (this.timer != null || typeof callback !== 'function') return false;
    this.timer = this.setTimer(() => {
      this.timer = null;
      callback();
    }, this.delayMs);
    return true;
  }

  cancel() {
    if (this.timer == null) return false;
    this.clearTimer(this.timer);
    this.timer = null;
    return true;
  }
}
