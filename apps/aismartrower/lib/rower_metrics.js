export const ROWER_LIVE_WINDOW_MS = 3500;
export const ROWER_MAX_MINUTE_POINTS = 30;
export const ROWER_MAX_DISTANCE_RATE_MPS = 12;
export const ROWER_MAX_STROKE_RATE_SPM = 127.5;

// Compatibility constants retained for reviewed API consumers.
export const INDOOR_ROWER_LIVE_WINDOW_MS = ROWER_LIVE_WINDOW_MS;
export const INDOOR_ROWER_MAX_MINUTE_POINTS = ROWER_MAX_MINUTE_POINTS;
export const INDOOR_ROWER_MAX_DISTANCE_RATE_MPS = ROWER_MAX_DISTANCE_RATE_MPS;
export const INDOOR_ROWER_MAX_STROKE_RATE_SPM = ROWER_MAX_STROKE_RATE_SPM;

const MAX_TOTAL_DISTANCE_M = 0xffffff;
const MAX_STROKE_COUNT = 0xffff;
const MINUTE_MS = 60_000;
const PARTIAL_MINUTE_MS = 30_000;
const MIN_BUCKET_COVERAGE_PCT = 50;

const FIELD_NAMES = Object.freeze([
  'distance',
  'strokeCount',
  'strokeRate',
  'split',
  'power',
  'heartRate',
]);

function finiteInRange(value, minimum, maximum) {
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value : null;
}

function validElapsed(value) {
  return finiteInRange(value, 0, Number.MAX_SAFE_INTEGER);
}

function emptyFields() {
  return {
    totalDistanceM: null,
    strokeCount: null,
    strokeRateSpm: null,
    splitSecPer500m: null,
    powerW: null,
    heartRateBpm: null,
  };
}

function emptyCoverage() {
  return {
    distance: 0,
    strokeCount: 0,
    strokeRate: 0,
    split: 0,
    power: 0,
    heartRate: 0,
  };
}

function normalizeFields(fields) {
  const source = fields && typeof fields === 'object' && !Array.isArray(fields)
    ? fields : {};
  return {
    totalDistanceM: finiteInRange(
      source.totalDistanceM,
      0,
      MAX_TOTAL_DISTANCE_M,
    ),
    strokeCount: Number.isInteger(source.strokeCount)
      ? finiteInRange(source.strokeCount, 0, MAX_STROKE_COUNT) : null,
    strokeRateSpm: finiteInRange(source.strokeRateSpm, 0, 127.5),
    splitSecPer500m: finiteInRange(
      source.instantaneousPaceSecPer500m,
      1,
      3600,
    ),
    powerW: finiteInRange(source.instantaneousPowerW, -1000, 3000),
    heartRateBpm: finiteInRange(source.heartRateBpm, 20, 240),
  };
}

function hasUsableField(fields) {
  return fields.totalDistanceM != null
    || fields.strokeCount != null
    || fields.strokeRateSpm != null
    || fields.splitSecPer500m != null
    || fields.powerW != null
    || fields.heartRateBpm != null;
}

function hasAnyTelemetry(fields) {
  return fields.strokeRateSpm != null
    || fields.splitSecPer500m != null
    || fields.powerW != null
    || fields.heartRateBpm != null
    || fields.totalDistanceM != null
    || fields.strokeCount != null;
}

function roundedPercent(coveredMs, elapsedMs) {
  if (!(elapsedMs > 0) || !(coveredMs > 0)) return 0;
  return Math.min(100, coveredMs / elapsedMs * 100);
}

function nullableAverage(weighted, coverageMs) {
  return coverageMs > 0 ? weighted / coverageMs : null;
}

/**
 * Aggregates standard FTMS Rower Data on the caller's active-time axis.
 * Wall time is used only for freshness and to reject gaps. Device identity,
 * raw GATT bytes and any other non-aggregate input never enter snapshots.
 */
export class IndoorRowerMetrics {
  constructor({ liveWindowMs = ROWER_LIVE_WINDOW_MS } = {}) {
    const normalizedWindow = finiteInRange(liveWindowMs, 1, 60_000);
    if (normalizedWindow == null) {
      throw new RangeError('liveWindowMs must be a finite positive number');
    }
    this.liveWindowMs = normalizedWindow;
    this.reset();
  }

  reset() {
    this.started = false;
    this.startedElapsedMs = 0;
    this.latestElapsedMs = 0;
    this.lastRecordAtMs = null;
    this.lastRecordElapsedMs = null;
    this.lastFields = emptyFields();
    this.currentFields = emptyFields();

    this.distanceM = 0;
    this.distanceObserved = false;
    this.distanceAnchorM = null;
    this.distanceAnchorAtMs = null;
    this.distanceAnchorElapsedMs = null;

    this.strokeCount = 0;
    this.strokeCountObserved = false;
    this.strokeCountAnchor = null;
    this.strokeCountAnchorAtMs = null;
    this.strokeCountAnchorElapsedMs = null;

    this.weighted = {
      strokeRate: 0,
      split: 0,
      power: 0,
      heartRate: 0,
    };
    this.coverageMs = emptyCoverage();
    this.ftmsCoverageMs = 0;
    this.maximums = {
      strokeRate: null,
      power: null,
      heartRate: null,
    };
    this.minuteSplitBuckets = new Map();
  }

  start({ elapsedMs = 0, totalDistanceM = null, strokeCount = null } = {}) {
    const normalizedElapsed = validElapsed(elapsedMs);
    if (normalizedElapsed == null) return false;
    const distance = totalDistanceM == null
      ? null : finiteInRange(totalDistanceM, 0, MAX_TOTAL_DISTANCE_M);
    const strokes = strokeCount == null || !Number.isInteger(strokeCount)
      ? null : finiteInRange(strokeCount, 0, MAX_STROKE_COUNT);
    if (totalDistanceM != null && distance == null) return false;
    if (strokeCount != null && strokes == null) return false;

    this.reset();
    this.started = true;
    this.startedElapsedMs = normalizedElapsed;
    this.latestElapsedMs = normalizedElapsed;
    if (distance != null) this.distanceAnchorM = distance;
    if (strokes != null) this.strokeCountAnchor = strokes;
    return true;
  }

  markDiscontinuity() {
    if (!this.started) return false;
    this.lastRecordAtMs = null;
    this.lastRecordElapsedMs = null;
    this.lastFields = emptyFields();
    this.currentFields = emptyFields();
    this.distanceAnchorM = null;
    this.distanceAnchorAtMs = null;
    this.distanceAnchorElapsedMs = null;
    this.strokeCountAnchor = null;
    this.strokeCountAnchorAtMs = null;
    this.strokeCountAnchorElapsedMs = null;
    return true;
  }

  _continuousGap(nowMs, elapsedMs, previousAtMs, previousElapsedMs) {
    if (previousAtMs == null || previousElapsedMs == null) return null;
    const wallGapMs = nowMs - previousAtMs;
    const activeGapMs = elapsedMs - previousElapsedMs;
    if (!(wallGapMs > 0) || wallGapMs > this.liveWindowMs
        || !(activeGapMs > 0) || activeGapMs > this.liveWindowMs) return null;
    return activeGapMs;
  }

  _addMinuteSplit(startElapsedMs, endElapsedMs, value) {
    let cursor = Math.max(this.startedElapsedMs, startElapsedMs);
    const end = Math.max(cursor, endElapsedMs);
    while (cursor < end) {
      const relativeCursor = cursor - this.startedElapsedMs;
      const minuteIndex = Math.floor(relativeCursor / MINUTE_MS);
      const boundary = this.startedElapsedMs + (minuteIndex + 1) * MINUTE_MS;
      const chunkEnd = Math.min(end, boundary);
      const durationMs = chunkEnd - cursor;
      const bucket = this.minuteSplitBuckets.get(minuteIndex)
        || { weighted: 0, coverageMs: 0 };
      bucket.weighted += value * durationMs;
      bucket.coverageMs += durationMs;
      this.minuteSplitBuckets.set(minuteIndex, bucket);
      cursor = chunkEnd;
    }

    const newestIndex = Math.floor(
      Math.max(0, endElapsedMs - this.startedElapsedMs) / MINUTE_MS,
    );
    const oldestKept = Math.max(0, newestIndex - ROWER_MAX_MINUTE_POINTS);
    for (const index of this.minuteSplitBuckets.keys()) {
      if (index < oldestKept) this.minuteSplitBuckets.delete(index);
    }
  }

  _creditInterval(startElapsedMs, endElapsedMs, fields) {
    const durationMs = endElapsedMs - startElapsedMs;
    if (!(durationMs > 0)) return;
    if (hasAnyTelemetry(fields)) this.ftmsCoverageMs += durationMs;

    if (fields.totalDistanceM != null) this.coverageMs.distance += durationMs;
    if (fields.strokeCount != null) this.coverageMs.strokeCount += durationMs;
    if (fields.strokeRateSpm != null) {
      this.weighted.strokeRate += fields.strokeRateSpm * durationMs;
      this.coverageMs.strokeRate += durationMs;
    }
    if (fields.splitSecPer500m != null) {
      this.weighted.split += fields.splitSecPer500m * durationMs;
      this.coverageMs.split += durationMs;
      this._addMinuteSplit(startElapsedMs, endElapsedMs, fields.splitSecPer500m);
    }
    if (fields.powerW != null) {
      this.weighted.power += fields.powerW * durationMs;
      this.coverageMs.power += durationMs;
    }
    if (fields.heartRateBpm != null) {
      this.weighted.heartRate += fields.heartRateBpm * durationMs;
      this.coverageMs.heartRate += durationMs;
    }
  }

  _acceptDistance(value, nowMs, elapsedMs) {
    if (value == null) return;
    this.distanceObserved = true;
    const gapMs = this._continuousGap(
      nowMs,
      elapsedMs,
      this.distanceAnchorAtMs,
      this.distanceAnchorElapsedMs,
    );
    if (this.distanceAnchorM != null && gapMs != null) {
      const deltaM = value - this.distanceAnchorM;
      // Total Distance is integer metres. Keep one metre of quantization
      // tolerance, but treat larger-than-physical jumps as a new anchor.
      const maximumDeltaM = 1
        + gapMs / 1000 * ROWER_MAX_DISTANCE_RATE_MPS;
      if (deltaM >= 0 && deltaM <= maximumDeltaM) this.distanceM += deltaM;
    }
    this.distanceAnchorM = value;
    this.distanceAnchorAtMs = nowMs;
    this.distanceAnchorElapsedMs = elapsedMs;
  }

  _acceptStrokeCount(value, nowMs, elapsedMs) {
    if (value == null) return;
    this.strokeCountObserved = true;
    const gapMs = this._continuousGap(
      nowMs,
      elapsedMs,
      this.strokeCountAnchorAtMs,
      this.strokeCountAnchorElapsedMs,
    );
    if (this.strokeCountAnchor != null && gapMs != null) {
      const delta = value - this.strokeCountAnchor;
      // The encoded instantaneous stroke-rate ceiling is 127.5 spm. Allow
      // one whole-stroke quantization step and reanchor any larger jump.
      const maximumDelta = 1
        + gapMs / 60_000 * ROWER_MAX_STROKE_RATE_SPM;
      if (delta >= 0 && delta <= maximumDelta) this.strokeCount += delta;
    }
    this.strokeCountAnchor = value;
    this.strokeCountAnchorAtMs = nowMs;
    this.strokeCountAnchorElapsedMs = elapsedMs;
  }

  accept(record, { elapsedMs } = {}) {
    if (!this.started
        || !record
        || record.valid !== true
        || record.complete !== true
        || !record.fields
        || typeof record.fields !== 'object'
        || Array.isArray(record.fields)
        || !Number.isFinite(record.receivedAtMs)) return false;
    const normalizedElapsed = validElapsed(elapsedMs);
    if (normalizedElapsed == null || normalizedElapsed < this.startedElapsedMs) {
      return false;
    }
    if (normalizedElapsed < this.latestElapsedMs
        || (this.lastRecordAtMs != null && record.receivedAtMs < this.lastRecordAtMs)) {
      return false;
    }
    const fields = normalizeFields(record.fields);
    if (!hasUsableField(fields)) return false;

    const nowMs = record.receivedAtMs;
    const intervalMs = this._continuousGap(
      nowMs,
      normalizedElapsed,
      this.lastRecordAtMs,
      this.lastRecordElapsedMs,
    );
    if (intervalMs != null) {
      this._creditInterval(
        this.lastRecordElapsedMs,
        normalizedElapsed,
        this.lastFields,
      );
    }

    this._acceptDistance(fields.totalDistanceM, nowMs, normalizedElapsed);
    this._acceptStrokeCount(fields.strokeCount, nowMs, normalizedElapsed);

    if (fields.strokeRateSpm != null) {
      this.maximums.strokeRate = Math.max(
        this.maximums.strokeRate ?? fields.strokeRateSpm,
        fields.strokeRateSpm,
      );
    }
    if (fields.powerW != null) {
      this.maximums.power = Math.max(
        this.maximums.power ?? fields.powerW,
        fields.powerW,
      );
    }
    if (fields.heartRateBpm != null) {
      this.maximums.heartRate = Math.max(
        this.maximums.heartRate ?? fields.heartRateBpm,
        fields.heartRateBpm,
      );
    }

    this.latestElapsedMs = Math.max(this.latestElapsedMs, normalizedElapsed);
    this.lastRecordAtMs = nowMs;
    this.lastRecordElapsedMs = normalizedElapsed;
    this.lastFields = fields;
    this.currentFields = fields;
    return true;
  }

  _minuteSplitSeries(elapsedMs) {
    const durationMs = Math.max(0, elapsedMs - this.startedElapsedMs);
    const result = [];
    const sorted = [...this.minuteSplitBuckets.entries()]
      .sort((left, right) => left[0] - right[0]);
    for (const [minuteIndex, bucket] of sorted) {
      const bucketStartMs = minuteIndex * MINUTE_MS;
      const availableMs = Math.min(
        MINUTE_MS,
        Math.max(0, durationMs - bucketStartMs),
      );
      if (availableMs < MINUTE_MS && availableMs < PARTIAL_MINUTE_MS) continue;
      if (!(bucket.coverageMs > 0)
          || bucket.coverageMs / availableMs * 100 < MIN_BUCKET_COVERAGE_PCT) {
        continue;
      }
      result.push({
        minute: minuteIndex + 1,
        value: bucket.weighted / bucket.coverageMs,
      });
    }
    return result.slice(-ROWER_MAX_MINUTE_POINTS);
  }

  snapshot({ elapsedMs = this.latestElapsedMs, nowMs = Date.now() } = {}) {
    const normalizedElapsed = validElapsed(elapsedMs);
    const safeElapsed = normalizedElapsed == null
      ? this.latestElapsedMs : Math.max(this.startedElapsedMs, normalizedElapsed);
    const durationMs = this.started
      ? Math.max(0, safeElapsed - this.startedElapsedMs) : 0;
    const fresh = this.started
      && Number.isFinite(nowMs)
      && this.lastRecordAtMs != null
      && nowMs >= this.lastRecordAtMs
      && nowMs - this.lastRecordAtMs <= this.liveWindowMs;
    const current = fresh ? {
      splitSecPer500m: this.currentFields.splitSecPer500m,
      strokeRateSpm: this.currentFields.strokeRateSpm,
      powerW: this.currentFields.powerW,
      heartRateBpm: this.currentFields.heartRateBpm,
    } : null;
    const distanceEvidence = this.distanceM > 0
      ? 'measured' : (this.distanceObserved ? 'stationary' : 'unavailable');
    const fieldCoverageMs = emptyCoverage();
    const fieldCoveragePct = emptyCoverage();
    FIELD_NAMES.forEach((name) => {
      fieldCoverageMs[name] = this.coverageMs[name];
      fieldCoveragePct[name] = roundedPercent(
        this.coverageMs[name],
        durationMs,
      );
    });

    return {
      elapsedMs: durationMs,
      fresh,
      current,
      currentSplitSecPer500m: current ? current.splitSecPer500m : null,
      currentStrokeRateSpm: current ? current.strokeRateSpm : null,
      currentPowerW: current ? current.powerW : null,
      currentHeartRateBpm: current ? current.heartRateBpm : null,
      distanceEvidence,
      distanceSource: distanceEvidence === 'unavailable'
        ? 'unavailable' : 'ftms_total_distance',
      distanceM: this.distanceM,
      strokeCount: this.strokeCount,
      averageSplitSecPer500m: nullableAverage(
        this.weighted.split,
        this.coverageMs.split,
      ),
      averageStrokeRateSpm: nullableAverage(
        this.weighted.strokeRate,
        this.coverageMs.strokeRate,
      ),
      maxStrokeRateSpm: this.maximums.strokeRate,
      averagePowerW: nullableAverage(
        this.weighted.power,
        this.coverageMs.power,
      ),
      maxPowerW: this.maximums.power,
      averageHeartRateBpm: nullableAverage(
        this.weighted.heartRate,
        this.coverageMs.heartRate,
      ),
      maxHeartRateBpm: this.maximums.heartRate,
      ftmsCoverageMs: this.ftmsCoverageMs,
      ftmsCoveragePct: roundedPercent(this.ftmsCoverageMs, durationMs),
      fieldCoverageMs,
      fieldCoveragePct,
      distanceCoveragePct: fieldCoveragePct.distance,
      strokeCountCoveragePct: fieldCoveragePct.strokeCount,
      strokeRateCoveragePct: fieldCoveragePct.strokeRate,
      splitCoveragePct: fieldCoveragePct.split,
      powerCoveragePct: fieldCoveragePct.power,
      heartRateCoveragePct: fieldCoveragePct.heartRate,
      minuteSplitSeries: this._minuteSplitSeries(safeElapsed),
    };
  }
}

function withLegacySnapshotNames(snapshot) {
  return {
    ...snapshot,
    splitSecPer500m: snapshot.averageSplitSecPer500m,
    avgStrokeRateSpm: snapshot.averageStrokeRateSpm,
    avgPowerW: snapshot.averagePowerW,
    avgHeartRateBpm: snapshot.averageHeartRateBpm,
  };
}

/**
 * Product-named adapter. Object arguments expose the strong active-time API.
 * Numeric arguments preserve the existing 480-page call shape until that
 * page is migrated to pass its explicit active timer.
 */
export class RowerMetrics extends IndoorRowerMetrics {
  constructor(options = {}) {
    super(options);
    this.legacyWallStartedAtMs = null;
  }

  reset() {
    super.reset();
    this.legacyWallStartedAtMs = null;
  }

  start(input = {}, distanceAnchorM = null) {
    if (Number.isFinite(input)) {
      const started = super.start({ elapsedMs: 0, totalDistanceM: distanceAnchorM });
      if (started) this.legacyWallStartedAtMs = input;
      return started;
    }
    this.legacyWallStartedAtMs = null;
    return super.start(input);
  }

  accept(record, options) {
    if (options && typeof options === 'object' && !Array.isArray(options)) {
      return super.accept(record, options);
    }
    if (this.legacyWallStartedAtMs == null
        || !record || !Number.isFinite(record.receivedAtMs)) return false;
    return super.accept(record, {
      elapsedMs: Math.max(0, record.receivedAtMs - this.legacyWallStartedAtMs),
    });
  }

  snapshot(input = {}) {
    if (Number.isFinite(input)) {
      return withLegacySnapshotNames(super.snapshot({
        elapsedMs: this.legacyWallStartedAtMs == null
          ? this.latestElapsedMs : Math.max(0, input - this.legacyWallStartedAtMs),
        nowMs: input,
      }));
    }
    return withLegacySnapshotNames(super.snapshot(input));
  }
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000 || 0));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function formatSplit(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--';
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}
