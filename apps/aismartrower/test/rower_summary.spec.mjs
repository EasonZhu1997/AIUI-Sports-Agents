import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRowerChart,
  buildRowerHistoryTrend,
  buildRowerLocalReview,
  buildRowerSummary,
} from '../lib/rower_summary.js';

test('builds a pure aggregate summary and drops live, raw and device fields', () => {
  const summary = buildRowerSummary({
    sessionId: 'indoor-a',
    startedAtMs: 1000,
    finishedAtMs: 61_000,
    elapsedMs: 60_000,
    distanceM: 500,
    distanceEvidence: 'measured',
    strokeCount: 120,
    averageSplitSecPer500m: 150,
    averageStrokeRateSpm: 24,
    maxStrokeRateSpm: 28,
    averagePowerW: 120,
    maxPowerW: 180,
    averageHeartRateBpm: 130,
    maxHeartRateBpm: 145,
    ftmsCoveragePct: 90,
    distanceCoveragePct: 90,
    strokeCountCoveragePct: 80,
    strokeRateCoveragePct: 80,
    splitCoveragePct: 75,
    powerCoveragePct: 70,
    heartRateCoveragePct: 60,
    heartRateSource: 'mixed',
    independentHrsCoveragePct: 35,
    ftmsHeartRateCoveragePct: 25,
    minuteSplitSeries: [{ minute: 1, value: 150 }],
    fresh: true,
    current: { powerW: 999 },
    rawPacket: [1, 2, 3],
    deviceId: 'private-id',
    deviceName: 'private-name',
  });
  assert.equal(summary.mode, 'indoor_rower');
  assert.equal(summary.distanceSource, 'ftms_total_distance');
  assert.equal(summary.averageSplitSecPer500m, 150);
  assert.equal(summary.averagePowerW, 120);
  assert.equal(summary.heartRateSource, 'mixed');
  assert.equal(summary.independentHrsCoveragePct, 35);
  assert.equal(summary.ftmsHeartRateCoveragePct, 25);
  assert.deepEqual(summary.sensorSources, ['ftms', 'independent_hrs']);
  for (const forbidden of [
    'fresh', 'current', 'rawPacket', 'deviceId', 'deviceName',
  ]) {
    assert.equal(Object.hasOwn(summary, forbidden), false);
  }
  assert.doesNotMatch(JSON.stringify(summary), /private-id|private-name/);
});

test('keeps FTMS and independent HRS evidence separate', () => {
  const embedded = buildRowerSummary({
    sessionId: 'embedded-heart',
    finishedAtMs: 60_000,
    elapsedMs: 60_000,
    averageHeartRateBpm: 130,
    maxHeartRateBpm: 145,
    heartRateCoveragePct: 80,
    ftmsHeartRateCoveragePct: 80,
    heartRateSource: 'ftms',
  });
  assert.equal(embedded.ftmsCoveragePct, 0);
  assert.equal(embedded.heartRateSource, 'ftms');
  assert.deepEqual(embedded.sensorSources, ['ftms']);

  const external = buildRowerSummary({
    sessionId: 'external-heart',
    finishedAtMs: 60_000,
    elapsedMs: 60_000,
    averageHeartRateBpm: 132,
    maxHeartRateBpm: 146,
    heartRateCoveragePct: 75,
    independentHrsCoveragePct: 75,
    heartRateSource: 'independent_hrs',
  });
  assert.equal(external.ftmsCoveragePct, 0);
  assert.equal(external.heartRateSource, 'independent_hrs');
  assert.deepEqual(external.sensorSources, ['ftms', 'independent_hrs']);

  const partial = buildRowerSummary({
    sessionId: 'partial-heart',
    finishedAtMs: 60_000,
    elapsedMs: 60_000,
    heartRateCoveragePct: 5,
    independentHrsCoveragePct: 5,
    heartRateSource: 'unavailable',
  });
  assert.equal(partial.heartRateSource, 'partial');
});

test('derives unavailable, stationary and measured distance evidence safely', () => {
  const unavailable = buildRowerSummary({
    sessionId: 'unavailable',
    finishedAtMs: 1000,
    elapsedMs: 1000,
  });
  assert.equal(unavailable.distanceEvidence, 'unavailable');
  assert.equal(unavailable.distanceSource, 'unavailable');

  const stationary = buildRowerSummary({
    sessionId: 'stationary',
    finishedAtMs: 1000,
    elapsedMs: 1000,
    distanceEvidence: 'stationary',
    distanceM: 0,
  });
  assert.equal(stationary.distanceEvidence, 'stationary');
  assert.equal(stationary.distanceSource, 'ftms_total_distance');

  const measured = buildRowerSummary({
    sessionId: 'measured',
    finishedAtMs: 1000,
    elapsedMs: 1000,
    distanceEvidence: 'unavailable',
    distanceM: 1,
  });
  assert.equal(measured.distanceEvidence, 'measured');
  assert.equal(measured.distanceSource, 'ftms_total_distance');
});

test('does not publish aggregate values without corresponding field coverage', () => {
  const summary = buildRowerSummary({
    sessionId: 'coverage-gates',
    finishedAtMs: 60_000,
    elapsedMs: 60_000,
    averageSplitSecPer500m: 150,
    averageStrokeRateSpm: 24,
    maxStrokeRateSpm: 30,
    averagePowerW: 120,
    maxPowerW: 180,
    averageHeartRateBpm: 130,
    maxHeartRateBpm: 150,
    minuteSplitSeries: [{ minute: 1, value: 150 }],
  });
  assert.equal(summary.averageSplitSecPer500m, null);
  assert.equal(summary.averageStrokeRateSpm, null);
  assert.equal(summary.maxStrokeRateSpm, null);
  assert.equal(summary.averagePowerW, null);
  assert.equal(summary.maxPowerW, null);
  assert.equal(summary.averageHeartRateBpm, null);
  assert.equal(summary.maxHeartRateBpm, null);
  assert.deepEqual(summary.minuteSplitSeries, []);
});

test('chart returns the 480 summary patch and keeps twelve points', () => {
  const points = Array.from({ length: 15 }, (_, index) => ({
    minute: index + 1,
    value: 150 + index,
  }));
  const chart = buildRowerChart(points);
  assert.equal(chart.showSummaryChart, true);
  assert.equal(chart.summaryChartTitle, '每分钟 500m 配速');
  assert.equal(chart.summaryChartUnit, '秒/500m');
  assert.equal(chart.summaryChartData.length, 12);
  assert.equal(chart.summaryChartData[0].minute, 4);
  assert.deepEqual(chart.summaryChartXAxis, { minimum: 4, maximum: 15 });
  assert.ok(chart.summaryChartYAxis.maximum > chart.summaryChartYAxis.minimum);

  const empty = buildRowerChart([]);
  assert.equal(empty.showSummaryChart, false);
  assert.equal(empty.summaryChartEmptyText, '有效分钟配速未形成');
});

test('local review is deterministic, bounded and FTMS-scoped', () => {
  const weak = buildRowerLocalReview({
    distanceEvidence: 'measured',
    ftmsCoveragePct: 20,
  });
  assert.match(weak.detail, /覆盖有限/);
  assert.equal(weak.sourceNote, '本地规则 · FTMS 聚合');
  assert.ok(weak.detail.length <= 42);
  assert.doesNotMatch(weak.detail + weak.sourceNote, /AI|设备名|原始包/);
});

test('history trend compares only recent measured high-coverage rower sessions', () => {
  const finishedAtMs = 10 * 24 * 60 * 60 * 1000;
  const history = [150, 150, 140, 138].map((split, index) => ({
    sessionId: `rower-${index}`,
    mode: 'indoor_rower',
    finishedAtMs: finishedAtMs - (3 - index) * 1000,
    distanceEvidence: 'measured',
    averageSplitSecPer500m: split,
    ftmsCoveragePct: 80,
  }));
  history.push({
    sessionId: 'other-record',
    mode: 'other',
    finishedAtMs,
    distanceEvidence: 'measured',
    averageSplitSecPer500m: 1,
    ftmsCoveragePct: 100,
  });
  const current = { sessionId: 'current', finishedAtMs };
  assert.match(
    buildRowerHistoryTrend(history, current, 'saved'),
    /4场.*配速较前段快/,
  );
  assert.match(
    buildRowerHistoryTrend(history, current, 'pending'),
    /本次待保存/,
  );
  assert.match(
    buildRowerHistoryTrend(history, current, 'failed'),
    /本次未计入/,
  );
});
