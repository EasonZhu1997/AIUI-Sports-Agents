import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROWER_LIVE_WINDOW_MS,
  IndoorRowerMetrics,
  RowerMetrics,
  formatDuration,
  formatSplit,
} from '../lib/rower_metrics.js';

function rowerRecord(receivedAtMs, fields, extra = {}) {
  return {
    valid: true,
    complete: true,
    published: true,
    receivedAtMs,
    fields,
    ...extra,
  };
}

test('uses the active-time axis for averages, coverage and cumulative ledgers', () => {
  const metrics = new IndoorRowerMetrics();
  assert.equal(metrics.start({
    elapsedMs: 0,
    totalDistanceM: 100,
    strokeCount: 10,
  }), true);
  assert.equal(metrics.accept(rowerRecord(1000, {
    totalDistanceM: 100,
    strokeCount: 10,
    strokeRateSpm: 24,
    instantaneousPaceSecPer500m: 150,
    instantaneousPowerW: 120,
    heartRateBpm: 130,
  }), { elapsedMs: 0 }), true);
  assert.equal(metrics.accept(rowerRecord(2000, {
    totalDistanceM: 112,
    strokeCount: 11,
    strokeRateSpm: 26,
    instantaneousPaceSecPer500m: 160,
    instantaneousPowerW: 140,
    heartRateBpm: 140,
  }), { elapsedMs: 1000 }), true);

  const snapshot = metrics.snapshot({ elapsedMs: 1000, nowMs: 2000 });
  assert.equal(snapshot.fresh, true);
  assert.deepEqual(snapshot.current, {
    splitSecPer500m: 160,
    strokeRateSpm: 26,
    powerW: 140,
    heartRateBpm: 140,
  });
  assert.equal(snapshot.distanceEvidence, 'measured');
  assert.equal(snapshot.distanceM, 12);
  assert.equal(snapshot.strokeCount, 1);
  assert.equal(snapshot.averageSplitSecPer500m, 150);
  assert.equal(snapshot.averageStrokeRateSpm, 24);
  assert.equal(snapshot.averagePowerW, 120);
  assert.equal(snapshot.averageHeartRateBpm, 130);
  assert.equal(snapshot.maxStrokeRateSpm, 26);
  assert.equal(snapshot.maxPowerW, 140);
  assert.equal(snapshot.maxHeartRateBpm, 140);
  assert.equal(snapshot.ftmsCoveragePct, 100);
  assert.deepEqual(snapshot.fieldCoveragePct, {
    distance: 100,
    strokeCount: 100,
    strokeRate: 100,
    split: 100,
    power: 100,
    heartRate: 100,
  });
});

test('does not bridge distance or field coverage across a 3.5 second outage', () => {
  const metrics = new IndoorRowerMetrics();
  metrics.start({ elapsedMs: 0 });
  metrics.accept(rowerRecord(0, {
    totalDistanceM: 100,
    strokeRateSpm: 20,
  }), { elapsedMs: 0 });
  metrics.accept(rowerRecord(ROWER_LIVE_WINDOW_MS + 1, {
    totalDistanceM: 140,
    strokeRateSpm: 30,
  }), { elapsedMs: 1000 });

  let snapshot = metrics.snapshot({ elapsedMs: 1000, nowMs: 3501 });
  assert.equal(snapshot.distanceM, 0);
  assert.equal(snapshot.distanceEvidence, 'stationary');
  assert.equal(snapshot.strokeRateCoveragePct, 0);
  assert.equal(snapshot.averageStrokeRateSpm, null);

  metrics.accept(rowerRecord(4501, {
    totalDistanceM: 145,
    strokeRateSpm: 32,
  }), { elapsedMs: 2000 });
  snapshot = metrics.snapshot({ elapsedMs: 2000, nowMs: 4501 });
  assert.equal(snapshot.distanceM, 5);
  assert.equal(snapshot.averageStrokeRateSpm, 30);
  assert.equal(snapshot.strokeRateCoveragePct, 50);
});

test('paused active time cannot accrue metres even when wall callbacks continue', () => {
  const metrics = new IndoorRowerMetrics();
  metrics.start({ elapsedMs: 0 });
  metrics.accept(rowerRecord(1000, { totalDistanceM: 10 }), { elapsedMs: 0 });
  metrics.accept(rowerRecord(2000, { totalDistanceM: 20 }), { elapsedMs: 0 });
  metrics.accept(rowerRecord(3000, { totalDistanceM: 22 }), { elapsedMs: 1000 });
  const snapshot = metrics.snapshot({ elapsedMs: 1000, nowMs: 3000 });
  assert.equal(snapshot.distanceM, 2);
  assert.equal(snapshot.elapsedMs, 1000);
});

test('an explicit discontinuity reanchors counters and clears current freshness', () => {
  const metrics = new IndoorRowerMetrics();
  metrics.start({ elapsedMs: 0 });
  metrics.accept(rowerRecord(0, {
    totalDistanceM: 0,
    strokeCount: 0,
    instantaneousPaceSecPer500m: 150,
  }), { elapsedMs: 0 });
  metrics.accept(rowerRecord(1000, {
    totalDistanceM: 10,
    strokeCount: 2,
    instantaneousPaceSecPer500m: 150,
  }), { elapsedMs: 1000 });
  assert.equal(metrics.markDiscontinuity(), true);
  assert.equal(metrics.snapshot({ elapsedMs: 1000, nowMs: 1000 }).fresh, false);

  metrics.accept(rowerRecord(10_000, {
    totalDistanceM: 80,
    strokeCount: 40,
  }), { elapsedMs: 1000 });
  metrics.accept(rowerRecord(11_000, {
    totalDistanceM: 85,
    strokeCount: 41,
  }), { elapsedMs: 2000 });
  const snapshot = metrics.snapshot({ elapsedMs: 2000, nowMs: 11_000 });
  assert.equal(snapshot.distanceM, 15);
  assert.equal(snapshot.strokeCount, 3);
});

test('counter rollbacks and implausible live jumps only reanchor cumulative ledgers', () => {
  const metrics = new IndoorRowerMetrics();
  metrics.start({ elapsedMs: 0 });
  metrics.accept(rowerRecord(0, {
    totalDistanceM: 100,
    strokeCount: 10,
  }), { elapsedMs: 0 });
  metrics.accept(rowerRecord(1000, {
    totalDistanceM: 120,
    strokeCount: 20,
  }), { elapsedMs: 1000 });
  metrics.accept(rowerRecord(2000, {
    totalDistanceM: 122,
    strokeCount: 21,
  }), { elapsedMs: 2000 });
  metrics.accept(rowerRecord(3000, {
    totalDistanceM: 2,
    strokeCount: 1,
  }), { elapsedMs: 3000 });
  metrics.accept(rowerRecord(4000, {
    totalDistanceM: 5,
    strokeCount: 3,
  }), { elapsedMs: 4000 });

  const snapshot = metrics.snapshot({ elapsedMs: 4000, nowMs: 4000 });
  assert.equal(snapshot.distanceM, 5);
  assert.equal(snapshot.strokeCount, 3);
  assert.equal(snapshot.distanceEvidence, 'measured');
});

test('distance evidence distinguishes unavailable, stationary and measured', () => {
  const unavailable = new IndoorRowerMetrics();
  unavailable.start({ elapsedMs: 0 });
  unavailable.accept(rowerRecord(1000, { strokeRateSpm: 20 }), { elapsedMs: 0 });
  assert.equal(
    unavailable.snapshot({ elapsedMs: 0, nowMs: 1000 }).distanceEvidence,
    'unavailable',
  );

  const stationary = new IndoorRowerMetrics();
  stationary.start({ elapsedMs: 0, totalDistanceM: 500 });
  assert.equal(
    stationary.snapshot({ elapsedMs: 1000, nowMs: 1000 }).distanceEvidence,
    'unavailable',
  );

  stationary.accept(rowerRecord(1000, { totalDistanceM: 500 }), { elapsedMs: 0 });
  assert.equal(
    stationary.snapshot({ elapsedMs: 0, nowMs: 1000 }).distanceEvidence,
    'stationary',
  );
  stationary.accept(rowerRecord(2000, { totalDistanceM: 501 }), { elapsedMs: 1000 });
  assert.equal(
    stationary.snapshot({ elapsedMs: 1000, nowMs: 2000 }).distanceEvidence,
    'measured',
  );
});

test('rejects wall-time and active-time regressions without moving anchors', () => {
  const metrics = new IndoorRowerMetrics();
  metrics.start({ elapsedMs: 0 });
  assert.equal(metrics.accept(rowerRecord(1000, {
    totalDistanceM: 100,
    strokeCount: 10,
    instantaneousPowerW: 100,
  }), { elapsedMs: 0 }), true);
  assert.equal(metrics.accept(rowerRecord(2000, {
    totalDistanceM: 105,
    strokeCount: 11,
    instantaneousPowerW: 200,
  }), { elapsedMs: 1000 }), true);
  assert.equal(metrics.accept(rowerRecord(1500, {
    totalDistanceM: 500,
    strokeCount: 500,
    instantaneousPowerW: 300,
  }), { elapsedMs: 1500 }), false);
  assert.equal(metrics.accept(rowerRecord(2500, {
    totalDistanceM: 500,
    strokeCount: 500,
    instantaneousPowerW: 300,
  }), { elapsedMs: 500 }), false);
  assert.equal(metrics.accept(rowerRecord(3000, {
    totalDistanceM: 108,
    strokeCount: 12,
    instantaneousPowerW: 200,
  }), { elapsedMs: 2000 }), true);

  const snapshot = metrics.snapshot({ elapsedMs: 2000, nowMs: 3000 });
  assert.equal(snapshot.distanceM, 8);
  assert.equal(snapshot.strokeCount, 2);
  assert.equal(snapshot.averagePowerW, 150);
  assert.equal(snapshot.powerCoveragePct, 100);
});

test('freshness expires without replaying the latest FTMS packet', () => {
  const metrics = new IndoorRowerMetrics();
  metrics.start({ elapsedMs: 0 });
  metrics.accept(rowerRecord(1000, { strokeRateSpm: 24 }), { elapsedMs: 0 });
  assert.equal(metrics.snapshot({ elapsedMs: 3500, nowMs: 4500 }).fresh, true);
  const stale = metrics.snapshot({ elapsedMs: 3501, nowMs: 4501 });
  assert.equal(stale.fresh, false);
  assert.equal(stale.current, null);
  assert.equal(stale.currentStrokeRateSpm, null);
  assert.equal(stale.strokeRateCoveragePct, 0);
});

test('field coverage remains independent when optional FTMS fields disappear', () => {
  const metrics = new IndoorRowerMetrics();
  metrics.start({ elapsedMs: 0 });
  metrics.accept(rowerRecord(0, {
    totalDistanceM: 0,
    strokeCount: 0,
    strokeRateSpm: 20,
    instantaneousPaceSecPer500m: 150,
    instantaneousPowerW: -20,
    heartRateBpm: 120,
  }), { elapsedMs: 0 });
  metrics.accept(rowerRecord(1000, {
    strokeRateSpm: 30,
  }), { elapsedMs: 1000 });
  metrics.accept(rowerRecord(2000, {
    strokeRateSpm: 40,
  }), { elapsedMs: 2000 });
  const snapshot = metrics.snapshot({ elapsedMs: 2000, nowMs: 2000 });
  assert.equal(snapshot.strokeRateCoveragePct, 100);
  assert.equal(snapshot.distanceCoveragePct, 50);
  assert.equal(snapshot.strokeCountCoveragePct, 50);
  assert.equal(snapshot.splitCoveragePct, 50);
  assert.equal(snapshot.powerCoveragePct, 50);
  assert.equal(snapshot.heartRateCoveragePct, 50);
  assert.equal(snapshot.averageStrokeRateSpm, 25);
  assert.equal(snapshot.averagePowerW, -20);
});

test('minute split points require real active-time coverage', () => {
  const metrics = new IndoorRowerMetrics();
  metrics.start({ elapsedMs: 0 });
  for (let elapsedMs = 0; elapsedMs <= 60_000; elapsedMs += 1000) {
    metrics.accept(rowerRecord(elapsedMs, {
      totalDistanceM: elapsedMs / 1000,
      instantaneousPaceSecPer500m: 120,
    }), { elapsedMs });
  }
  assert.deepEqual(
    metrics.snapshot({ elapsedMs: 60_000, nowMs: 60_000 }).minuteSplitSeries,
    [{ minute: 1, value: 120 }],
  );

  const weak = new IndoorRowerMetrics();
  weak.start({ elapsedMs: 0 });
  weak.accept(rowerRecord(0, { instantaneousPaceSecPer500m: 120 }), {
    elapsedMs: 0,
  });
  weak.accept(rowerRecord(1000, { instantaneousPaceSecPer500m: 120 }), {
    elapsedMs: 1000,
  });
  assert.deepEqual(
    weak.snapshot({ elapsedMs: 60_000, nowMs: 60_000 }).minuteSplitSeries,
    [],
  );
});

test('rejects incomplete records and never exposes raw or device identity', () => {
  const metrics = new IndoorRowerMetrics();
  metrics.start({ elapsedMs: 0 });
  assert.equal(metrics.accept({
    valid: true,
    complete: false,
    receivedAtMs: 0,
    fields: { totalDistanceM: 10 },
  }, { elapsedMs: 0 }), false);
  assert.equal(metrics.accept(rowerRecord(0, {
    strokeRateSpm: 24,
  }, {
    rawPacket: [1, 2, 3],
    deviceId: 'secret-id',
    deviceName: 'private-name',
  }), { elapsedMs: 0 }), true);
  const serialized = JSON.stringify(metrics.snapshot({ elapsedMs: 0, nowMs: 0 }));
  assert.doesNotMatch(serialized, /secret-id|private-name|rawPacket|deviceId|deviceName/);
});

test('480-page adapter keeps numeric calls and formatting exports while using strong ledgers', () => {
  const metrics = new RowerMetrics();
  assert.equal(metrics.start(10_000, 100), true);
  assert.equal(metrics.accept(rowerRecord(10_000, {
    totalDistanceM: 100,
    strokeCount: 10,
    strokeRateSpm: 24,
    instantaneousPaceSecPer500m: 150,
  })), true);
  assert.equal(metrics.accept(rowerRecord(11_000, {
    totalDistanceM: 105,
    strokeCount: 11,
    strokeRateSpm: 26,
    instantaneousPaceSecPer500m: 160,
  })), true);
  const snapshot = metrics.snapshot(11_000);
  assert.equal(snapshot.distanceM, 5);
  assert.equal(snapshot.avgStrokeRateSpm, 24);
  assert.equal(snapshot.splitSecPer500m, 150);
  assert.equal(formatDuration(61_000), '01:01');
  assert.equal(formatSplit(150), '2:30');
  assert.equal(formatSplit(null), '--:--');
});
