import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FTMS_HEART_RATE_SOURCE,
  HeartRateSourceArbiter,
  INDEPENDENT_HRS_SOURCE,
  MIXED_HEART_RATE_SOURCE,
  PARTIAL_HEART_RATE_SOURCE,
  UNAVAILABLE_HEART_RATE_SOURCE,
} from '../lib/heart_rate_source.js';

function hrs(heartRateBpm, receivedAtMs, contactDetected = true) {
  return {
    valid: true,
    usable: heartRateBpm > 0 && contactDetected !== false,
    heartRateBpm,
    contactDetected,
    receivedAtMs,
  };
}

function ftms(heartRateBpm, receivedAtMs) {
  const fields = {};
  if (heartRateBpm !== undefined) fields.heartRateBpm = heartRateBpm;
  return {
    valid: true,
    complete: true,
    published: true,
    fields,
    receivedAtMs,
  };
}

test('independent HRS wins while usable; poor contact immediately falls back to fresh FTMS', () => {
  const source = new HeartRateSourceArbiter();
  assert.equal(source.start({ elapsedMs: 0, nowMs: 0 }), true);
  assert.equal(source.acceptFtms(ftms(100, 0), { elapsedMs: 0 }), true);
  assert.equal(source.acceptIndependentHrs(hrs(150, 1000), {
    elapsedMs: 1000,
  }), true);

  let snapshot = source.snapshot({ elapsedMs: 2000, nowMs: 2000 });
  assert.equal(snapshot.heartRateBpm, 150);
  assert.equal(snapshot.currentSource, INDEPENDENT_HRS_SOURCE);

  assert.equal(source.acceptIndependentHrs(hrs(151, 2000, false), {
    elapsedMs: 2000,
  }), true);
  snapshot = source.snapshot({ elapsedMs: 2000, nowMs: 2000 });
  assert.equal(snapshot.heartRateBpm, 100);
  assert.equal(snapshot.currentSource, FTMS_HEART_RATE_SOURCE);
  assert.equal(snapshot.independentHrsState, 'contact_poor');
  assert.equal(snapshot.externalContactPoor, true);
});

test('stale independent HRS falls back to a newer FTMS observation, then both expire', () => {
  const source = new HeartRateSourceArbiter();
  source.start({ elapsedMs: 0, nowMs: 0 });
  source.acceptFtms(ftms(90, 0), { elapsedMs: 0 });
  source.acceptIndependentHrs(hrs(140, 0), { elapsedMs: 0 });
  source.acceptFtms(ftms(92, 3000), { elapsedMs: 3000 });

  let snapshot = source.snapshot({ elapsedMs: 5001, nowMs: 5001 });
  assert.equal(snapshot.heartRateBpm, 92);
  assert.equal(snapshot.currentSource, FTMS_HEART_RATE_SOURCE);
  assert.equal(snapshot.independentHrsState, 'stale');

  snapshot = source.snapshot({ elapsedMs: 6501, nowMs: 6501 });
  assert.equal(snapshot.heartRateBpm, null);
  assert.equal(snapshot.currentSource, UNAVAILABLE_HEART_RATE_SOURCE);
});

test('overlapping FTMS and HRS are counted once with HRS priority', () => {
  const source = new HeartRateSourceArbiter();
  source.start({ elapsedMs: 0, nowMs: 0 });
  source.acceptFtms(ftms(100, 0), { elapsedMs: 0 });
  source.acceptIndependentHrs(hrs(150, 0), { elapsedMs: 0 });
  source.snapshot({ elapsedMs: 4000, nowMs: 4000 });
  source.acceptIndependentHrs(hrs(150, 4000), { elapsedMs: 4000 });

  const snapshot = source.snapshot({ elapsedMs: 8000, nowMs: 8000 });
  assert.equal(snapshot.heartRateCoverageMs, 8000);
  assert.equal(snapshot.independentHrsCoverageMs, 8000);
  assert.equal(snapshot.ftmsHeartRateCoverageMs, 0);
  assert.equal(snapshot.averageHeartRateBpm, 150);
  assert.equal(snapshot.maxHeartRateBpm, 150);
  assert.equal(snapshot.source, INDEPENDENT_HRS_SOURCE);
  assert.equal(snapshot.coverageSufficient, true);
});

test('non-overlapping accepted sources produce a mixed, time-weighted summary', () => {
  const source = new HeartRateSourceArbiter();
  source.start({ elapsedMs: 0, nowMs: 0 });
  source.acceptFtms(ftms(100, 0), { elapsedMs: 0 });
  source.snapshot({ elapsedMs: 2000, nowMs: 2000 });
  source.acceptIndependentHrs(hrs(140, 2000), { elapsedMs: 2000 });
  source.snapshot({ elapsedMs: 7000, nowMs: 7000 });
  source.acceptFtms(ftms(110, 7000), { elapsedMs: 7000 });

  const snapshot = source.snapshot({ elapsedMs: 9000, nowMs: 9000 });
  assert.equal(snapshot.heartRateCoverageMs, 9000);
  assert.equal(snapshot.independentHrsCoverageMs, 5000);
  assert.equal(snapshot.ftmsHeartRateCoverageMs, 4000);
  assert.ok(Math.abs(snapshot.averageHeartRateBpm - (1120 / 9)) < 1e-9);
  assert.equal(snapshot.maxHeartRateBpm, 140);
  assert.equal(snapshot.source, MIXED_HEART_RATE_SOURCE);
});

test('summary stays unavailable with no coverage and partial below the double gate', () => {
  const empty = new HeartRateSourceArbiter();
  empty.start({ elapsedMs: 0, nowMs: 0 });
  let snapshot = empty.snapshot({ elapsedMs: 9000, nowMs: 9000 });
  assert.equal(snapshot.source, UNAVAILABLE_HEART_RATE_SOURCE);
  assert.equal(snapshot.averageHeartRateBpm, null);

  const partial = new HeartRateSourceArbiter();
  partial.start({ elapsedMs: 0, nowMs: 0 });
  partial.acceptIndependentHrs(hrs(120, 0), { elapsedMs: 0 });
  snapshot = partial.snapshot({ elapsedMs: 4000, nowMs: 4000 });
  assert.equal(snapshot.source, PARTIAL_HEART_RATE_SOURCE);
  assert.equal(snapshot.heartRateCoverageMs, 4000);
  assert.equal(snapshot.averageHeartRateBpm, null);
  assert.equal(snapshot.maxHeartRateBpm, null);
});

test('discontinuity closes coverage and never credits a hidden active-time gap', () => {
  const source = new HeartRateSourceArbiter();
  source.start({ elapsedMs: 0, nowMs: 0 });
  source.acceptIndependentHrs(hrs(120, 0), { elapsedMs: 0 });
  source.markDiscontinuity('all', { elapsedMs: 2000, nowMs: 2000 });
  source.snapshot({ elapsedMs: 10000, nowMs: 10000 });
  source.acceptIndependentHrs(hrs(130, 10000), { elapsedMs: 10000 });

  const snapshot = source.snapshot({ elapsedMs: 18000, nowMs: 18000 });
  assert.equal(snapshot.heartRateCoverageMs, 7000);
  assert.equal(snapshot.source, PARTIAL_HEART_RATE_SOURCE);
  assert.equal(snapshot.averageHeartRateBpm, null);
});

test('a complete FTMS record without optional heart rate clears the prior FTMS value', () => {
  const source = new HeartRateSourceArbiter();
  source.start({ elapsedMs: 0, nowMs: 0 });
  source.acceptFtms(ftms(101, 0), { elapsedMs: 0 });
  assert.equal(
    source.snapshot({ elapsedMs: 1000, nowMs: 1000 }).heartRateBpm,
    101,
  );
  assert.equal(source.acceptFtms(ftms(undefined, 1000), {
    elapsedMs: 1000,
  }), true);
  assert.equal(
    source.snapshot({ elapsedMs: 1000, nowMs: 1000 }).heartRateBpm,
    null,
  );
});

test('incomplete FTMS records and regressive clocks cannot mutate arbitration', () => {
  const source = new HeartRateSourceArbiter();
  source.start({ elapsedMs: 1000, nowMs: 1000 });
  assert.equal(source.acceptFtms({
    valid: true,
    complete: false,
    published: false,
    fields: { heartRateBpm: 180 },
    receivedAtMs: 1100,
  }, { elapsedMs: 1100 }), false);
  assert.equal(source.acceptIndependentHrs(hrs(300, 1200), {
    elapsedMs: 1200,
  }), true);
  assert.equal(source.acceptIndependentHrs(hrs(100, 1199), {
    elapsedMs: 1199,
  }), false);
  const snapshot = source.snapshot({ elapsedMs: 1200, nowMs: 1200 });
  assert.equal(snapshot.heartRateBpm, 300);
  assert.equal(snapshot.currentSource, INDEPENDENT_HRS_SOURCE);
});

test('strict numeric inputs and finish prevent post-session mutation', () => {
  const source = new HeartRateSourceArbiter();
  assert.equal(source.start({ elapsedMs: '0', nowMs: 0 }), false);
  assert.equal(source.start({ elapsedMs: 0, nowMs: 0 }), true);
  assert.equal(source.acceptIndependentHrs({
    valid: true,
    usable: true,
    heartRateBpm: '120',
    contactDetected: true,
    receivedAtMs: 0,
  }, { elapsedMs: 0 }), true);
  assert.equal(
    source.snapshot({ elapsedMs: 1000, nowMs: 1000 }).heartRateBpm,
    null,
  );
  assert.equal(source.acceptIndependentHrs(hrs(120, 1000), {
    elapsedMs: 1000,
  }), true);
  source.acceptIndependentHrs(hrs(120, 5000), { elapsedMs: 5000 });
  const final = source.finish({ elapsedMs: 9000, nowMs: 9000 });
  assert.equal(final.heartRateCoverageMs, 8000);
  assert.equal(final.source, INDEPENDENT_HRS_SOURCE);
  assert.equal(source.acceptIndependentHrs(hrs(180, 10000), {
    elapsedMs: 10000,
  }), false);
  assert.equal(
    source.snapshot({ elapsedMs: 10000, nowMs: 10000 }).heartRateCoverageMs,
    8000,
  );
});
