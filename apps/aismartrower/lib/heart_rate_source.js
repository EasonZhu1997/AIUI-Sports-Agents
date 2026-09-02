export const INDEPENDENT_HRS_SOURCE = 'independent_hrs';
export const FTMS_HEART_RATE_SOURCE = 'ftms';
export const MIXED_HEART_RATE_SOURCE = 'mixed';
export const PARTIAL_HEART_RATE_SOURCE = 'partial';
export const UNAVAILABLE_HEART_RATE_SOURCE = 'unavailable';

export const INDEPENDENT_HRS_FRESH_MS = 5000;
export const FTMS_HEART_RATE_FRESH_MS = 3500;
export const HEART_RATE_MIN_SUMMARY_COVERAGE_MS = 8000;
export const HEART_RATE_MIN_SUMMARY_COVERAGE_RATIO = 0.1;

// Keep the default arbitration policy protocol-shaped: HRS permits UINT16
// values, while zero is not usable live data. A product may inject a narrower
// physiology/display policy without corrupting the standards parser.
const DEFAULT_MIN_BPM = 1;
const DEFAULT_MAX_BPM = 0xffff;

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value : null;
}

function boundedBpm(value, minimum, maximum) {
  return typeof value === 'number' && Number.isFinite(value)
      && value >= minimum && value <= maximum ? value : null;
}

function percentage(numerator, denominator) {
  if (!(denominator > 0) || !(numerator > 0)) return 0;
  return Math.min(100, numerator / denominator * 100);
}

function emptyObservation() {
  return null;
}

/**
 * Chooses one heart-rate source at a time and aggregates on active time.
 *
 * The caller must call markDiscontinuity() before/after hidden or paused gaps.
 * Wall time remains the current-value freshness gate; active time owns summary
 * coverage so a paused session never earns heart-rate coverage.
 */
export class HeartRateSourceArbiter {
  constructor({
    independentFreshMs = INDEPENDENT_HRS_FRESH_MS,
    ftmsFreshMs = FTMS_HEART_RATE_FRESH_MS,
    minimumBpm = DEFAULT_MIN_BPM,
    maximumBpm = DEFAULT_MAX_BPM,
    minimumSummaryCoverageMs = HEART_RATE_MIN_SUMMARY_COVERAGE_MS,
    minimumSummaryCoverageRatio = HEART_RATE_MIN_SUMMARY_COVERAGE_RATIO,
  } = {}) {
    this.independentFreshMs = Math.max(1, Number(independentFreshMs) || 1);
    this.ftmsFreshMs = Math.max(1, Number(ftmsFreshMs) || 1);
    this.minimumBpm = Number(minimumBpm);
    this.maximumAllowedBpm = Number(maximumBpm);
    this.minimumSummaryCoverageMs = Math.max(
      0,
      Number(minimumSummaryCoverageMs) || 0,
    );
    this.minimumSummaryCoverageRatio = Math.max(
      0,
      Math.min(1, Number(minimumSummaryCoverageRatio) || 0),
    );
    if (!Number.isFinite(this.minimumBpm)
        || !Number.isFinite(this.maximumAllowedBpm)
        || this.minimumBpm > this.maximumAllowedBpm) {
      throw new RangeError('invalid heart-rate range');
    }
    this.reset();
  }

  reset() {
    this.started = false;
    this.finished = false;
    this.startedElapsedMs = 0;
    this.latestElapsedMs = 0;
    this.latestWallMs = null;
    this.lastAccruedElapsedMs = 0;
    this.independent = emptyObservation();
    this.ftms = emptyObservation();
    this.weightedBpmMs = 0;
    this.coverageMs = 0;
    this.coverageBySourceMs = {
      [INDEPENDENT_HRS_SOURCE]: 0,
      [FTMS_HEART_RATE_SOURCE]: 0,
    };
    this.maximumObservedBpm = null;
  }

  start({ elapsedMs = 0, nowMs = Date.now() } = {}) {
    const elapsed = finiteNonNegative(elapsedMs);
    const wall = finiteNonNegative(nowMs);
    if (elapsed == null || wall == null) return false;
    this.reset();
    this.started = true;
    this.startedElapsedMs = elapsed;
    this.latestElapsedMs = elapsed;
    this.lastAccruedElapsedMs = elapsed;
    this.latestWallMs = wall;
    return true;
  }

  _validAtActiveTime(observation, activeMs) {
    return !!observation
      && observation.usable === true
      && activeMs >= observation.activeAtMs
      && activeMs < observation.expiresActiveAtMs;
  }

  _selectAtActiveTime(activeMs) {
    if (this._validAtActiveTime(this.independent, activeMs)) {
      return {
        source: INDEPENDENT_HRS_SOURCE,
        observation: this.independent,
      };
    }
    if (this._validAtActiveTime(this.ftms, activeMs)) {
      return {
        source: FTMS_HEART_RATE_SOURCE,
        observation: this.ftms,
      };
    }
    return null;
  }

  _accrueTo(elapsedMs) {
    let cursor = this.lastAccruedElapsedMs;
    const end = Math.max(cursor, elapsedMs);
    let guard = 0;
    while (cursor < end && guard < 8) {
      guard += 1;
      const selected = this._selectAtActiveTime(cursor);
      if (!selected) {
        // New observations are installed only after the preceding interval is
        // accrued, so there is no known future source start in this interval.
        cursor = end;
        break;
      }
      const boundary = Math.min(
        end,
        selected.observation.expiresActiveAtMs,
      );
      if (!(boundary > cursor)) {
        cursor = end;
        break;
      }
      const durationMs = boundary - cursor;
      this.weightedBpmMs += selected.observation.bpm * durationMs;
      this.coverageMs += durationMs;
      this.coverageBySourceMs[selected.source] += durationMs;
      this.maximumObservedBpm = this.maximumObservedBpm == null
        ? selected.observation.bpm
        : Math.max(this.maximumObservedBpm, selected.observation.bpm);
      cursor = boundary;
    }
    this.lastAccruedElapsedMs = end;
  }

  _advance(nowMs, elapsedMs) {
    if (!this.started || this.finished) return null;
    const wall = finiteNonNegative(nowMs);
    const elapsed = finiteNonNegative(elapsedMs);
    if (wall == null || elapsed == null
        || elapsed < this.latestElapsedMs
        || (this.latestWallMs != null && wall < this.latestWallMs)) return null;
    this._accrueTo(elapsed);
    this.latestElapsedMs = elapsed;
    this.latestWallMs = wall;
    return { wall, elapsed };
  }

  _observation({ bpm, contactDetected, activeAtMs, wallAtMs, freshMs }) {
    const normalizedBpm = boundedBpm(
      bpm,
      this.minimumBpm,
      this.maximumAllowedBpm,
    );
    return {
      bpm: normalizedBpm,
      contactDetected,
      usable: normalizedBpm != null && contactDetected !== false,
      activeAtMs,
      wallAtMs,
      expiresActiveAtMs: activeAtMs + freshMs,
      expiresWallAtMs: wallAtMs + freshMs,
    };
  }

  acceptIndependentHrs(measurement, {
    elapsedMs = this.latestElapsedMs,
    nowMs = measurement && measurement.receivedAtMs,
  } = {}) {
    if (!measurement || measurement.valid !== true) return false;
    const advanced = this._advance(nowMs, elapsedMs);
    if (!advanced) return false;
    this.independent = this._observation({
      bpm: measurement.heartRateBpm,
      contactDetected: measurement.contactDetected,
      activeAtMs: advanced.elapsed,
      wallAtMs: advanced.wall,
      freshMs: this.independentFreshMs,
    });
    return true;
  }

  acceptFtms(record, {
    elapsedMs = this.latestElapsedMs,
    nowMs = record && record.receivedAtMs,
  } = {}) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || record.valid !== true
        || record.complete !== true
        || record.published !== true
        || !record.fields || typeof record.fields !== 'object'
        || Array.isArray(record.fields)) return false;
    const advanced = this._advance(nowMs, elapsedMs);
    if (!advanced) return false;
    const fields = record.fields;
    const bpm = boundedBpm(
      fields.heartRateBpm,
      this.minimumBpm,
      this.maximumAllowedBpm,
    );
    // Field absence in a new complete FTMS record is authoritative. Do not
    // carry an older optional bit-9 value into the new record.
    this.ftms = bpm == null ? null : this._observation({
      bpm,
      contactDetected: null,
      activeAtMs: advanced.elapsed,
      wallAtMs: advanced.wall,
      freshMs: this.ftmsFreshMs,
    });
    return true;
  }

  markDiscontinuity(
    source = 'all',
    { elapsedMs = this.latestElapsedMs, nowMs = this.latestWallMs } = {},
  ) {
    if (source !== 'all'
        && source !== INDEPENDENT_HRS_SOURCE
        && source !== FTMS_HEART_RATE_SOURCE) return false;
    const advanced = this._advance(nowMs, elapsedMs);
    if (!advanced) return false;
    if (source === 'all' || source === INDEPENDENT_HRS_SOURCE) {
      this.independent = null;
    }
    if (source === 'all' || source === FTMS_HEART_RATE_SOURCE) {
      this.ftms = null;
    }
    return true;
  }

  _currentObservation(observation, elapsedMs, wallMs) {
    return !!observation
      && observation.usable === true
      && elapsedMs >= observation.activeAtMs
      && elapsedMs <= observation.expiresActiveAtMs
      && wallMs >= observation.wallAtMs
      && wallMs <= observation.expiresWallAtMs;
  }

  _independentState(elapsedMs, wallMs) {
    const observation = this.independent;
    if (!observation) return 'unavailable';
    const activeFresh = elapsedMs >= observation.activeAtMs
      && elapsedMs <= observation.expiresActiveAtMs;
    const wallFresh = wallMs >= observation.wallAtMs
      && wallMs <= observation.expiresWallAtMs;
    if (!activeFresh || !wallFresh) return 'stale';
    if (observation.contactDetected === false) return 'contact_poor';
    return observation.usable ? 'live' : 'unusable';
  }

  snapshot({
    elapsedMs = this.latestElapsedMs,
    nowMs = this.latestWallMs == null ? Date.now() : this.latestWallMs,
  } = {}) {
    const advanced = this._advance(nowMs, elapsedMs);
    const safeElapsed = advanced ? advanced.elapsed : this.latestElapsedMs;
    const safeWall = advanced ? advanced.wall : this.latestWallMs;
    const durationMs = this.started
      ? Math.max(0, safeElapsed - this.startedElapsedMs) : 0;

    let current = null;
    if (this.started && safeWall != null
        && this._currentObservation(this.independent, safeElapsed, safeWall)) {
      current = {
        bpm: this.independent.bpm,
        source: INDEPENDENT_HRS_SOURCE,
      };
    } else if (this.started && safeWall != null
        && this._currentObservation(this.ftms, safeElapsed, safeWall)) {
      current = { bpm: this.ftms.bpm, source: FTMS_HEART_RATE_SOURCE };
    }

    const coverageRatio = durationMs > 0 ? this.coverageMs / durationMs : 0;
    const sufficient = this.coverageMs >= this.minimumSummaryCoverageMs
      && coverageRatio >= this.minimumSummaryCoverageRatio;
    const independentCoverageMs =
      this.coverageBySourceMs[INDEPENDENT_HRS_SOURCE];
    const ftmsCoverageMs = this.coverageBySourceMs[FTMS_HEART_RATE_SOURCE];
    let source;
    if (!(this.coverageMs > 0)) source = UNAVAILABLE_HEART_RATE_SOURCE;
    else if (!sufficient) source = PARTIAL_HEART_RATE_SOURCE;
    else if (independentCoverageMs > 0 && ftmsCoverageMs > 0) {
      source = MIXED_HEART_RATE_SOURCE;
    } else if (independentCoverageMs > 0) source = INDEPENDENT_HRS_SOURCE;
    else source = FTMS_HEART_RATE_SOURCE;

    return {
      heartRateBpm: current ? current.bpm : null,
      currentSource: current ? current.source : UNAVAILABLE_HEART_RATE_SOURCE,
      independentHrsState: safeWall == null
        ? 'unavailable' : this._independentState(safeElapsed, safeWall),
      externalContactPoor: safeWall != null
        && this._independentState(safeElapsed, safeWall) === 'contact_poor',
      source,
      heartRateSource: source,
      averageHeartRateBpm: sufficient && this.coverageMs > 0
        ? this.weightedBpmMs / this.coverageMs : null,
      maxHeartRateBpm: sufficient ? this.maximumObservedBpm : null,
      coverageSufficient: sufficient,
      heartRateCoverageMs: this.coverageMs,
      heartRateCoveragePct: percentage(this.coverageMs, durationMs),
      independentHrsCoverageMs: independentCoverageMs,
      ftmsHeartRateCoverageMs: ftmsCoverageMs,
      independentHrsCoveragePct: percentage(independentCoverageMs, durationMs),
      ftmsHeartRateCoveragePct: percentage(ftmsCoverageMs, durationMs),
      elapsedMs: durationMs,
    };
  }

  finish(options = {}) {
    const result = this.snapshot(options);
    this.independent = null;
    this.ftms = null;
    this.finished = true;
    return result;
  }
}
