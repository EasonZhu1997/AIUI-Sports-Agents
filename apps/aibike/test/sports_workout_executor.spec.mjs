import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSportsWorkoutExecutor,
  finalizeSportsWorkout,
  selectSportsWorkoutTarget,
  sportsWorkoutHud,
  updateSportsWorkoutExecutor,
} from '../lib/sports_workout_executor.js';

const base = 1760000000000;
const plan = {
  workout_id: 'spw_' + 'a'.repeat(24), revision: 1, title: '节奏骑', type: 'steady',
  issued_at_ms: base - 1000, expires_at_ms: base + 3600000, stages: [
    { stage_id: 'sps_' + 'b'.repeat(24), order: 0, type: 'warmup', title: '热身',
      duration_sec: 10, target: { kind: 'cycling', cadence_min_rpm: 75, cadence_max_rpm: 90 } },
    { stage_id: 'sps_' + 'c'.repeat(24), order: 1, type: 'work', title: '稳定段',
      duration_sec: 20, target: { kind: 'cycling', power_min_w: 150, power_max_w: 180,
        cadence_min_rpm: 82, cadence_max_rpm: 95 } },
  ],
};

function snapshot(elapsedMs, { cadence = 85, power = null, powerSource = 'none', distance = 0 } = {}) {
  const live = (value, source) => value == null ? { state: 'unsupported' }
    : { state: 'live', fresh: true, held: false, value, source };
  return { elapsedMs, distanceM: distance, paused: false, metrics: {
    cadence: live(cadence, 'imu'), power: live(power, powerSource),
    heartRate: live(null, 'none'), speed: live(24, 'imu'),
  } };
}

test('executor advances stages only by active elapsed and reports progress', () => {
  const state = createSportsWorkoutExecutor(plan, base);
  updateSportsWorkoutExecutor(state, snapshot(5000, { distance: 20 }));
  assert.equal(sportsWorkoutHud(state, snapshot(5000)).remaining, '0:05');
  updateSportsWorkoutExecutor(state, snapshot(10000, { distance: 40 }));
  assert.equal(state.stageIndex, 1);
  updateSportsWorkoutExecutor(state, snapshot(30000, { power: 165, powerSource: 'cps', distance: 200 }));
  assert.equal(state.complete, true);
  const result = finalizeSportsWorkout(state);
  assert.equal(result.completion_percent, 100);
  assert.equal(result.stage_results.length, 2);
  assert.deepEqual(result.sensor_sources.sort(), ['cps', 'imu']);
  assert.ok(result.stage_results[1].metrics.avg_speed_kmh > 0);
  assert.ok(result.stage_results[1].metrics.avg_cadence_rpm > 0);
  assert.equal(result.stage_results[1].metrics.avg_power_w, 165);
  assert.doesNotMatch(JSON.stringify(result.stage_results), /target_time_sec|source_live_sec/);
});

test('power and cadence targets require committed cycling sensors; IMU falls back to effort or none', () => {
  const stage = plan.stages[1];
  assert.equal(selectSportsWorkoutTarget(stage, snapshot(0, { power: 165, powerSource: 'cps' })).kind, 'power');
  assert.equal(selectSportsWorkoutTarget(stage, snapshot(0, { power: null, cadence: 88 })).kind, 'none');
  const csc = snapshot(0, { power: null, cadence: 88 });
  csc.metrics.cadence.source = 'csc';
  assert.equal(selectSportsWorkoutTarget(stage, csc).kind, 'cadence');
  const effort = { ...stage, target: {
    ...stage.target, effort_min: 3, effort_max: 5,
  } };
  assert.equal(selectSportsWorkoutTarget(effort, snapshot(0, { cadence: 88 })).kind, 'effort');
  const powerOnly = { ...stage, target: { kind: 'cycling', power_min_w: 150, power_max_w: 180 } };
  assert.equal(selectSportsWorkoutTarget(powerOnly, snapshot(0, { power: null })).kind, 'none');
});

test('outdoor speed is recorded but never selected as a coaching target', () => {
  const speedOnly = { ...plan.stages[0], target: {
    kind: 'cycling', speed_min_kmh: 18, speed_max_kmh: 24,
  } };
  const csc = snapshot(0, { cadence: null });
  csc.metrics.speed.source = 'csc';
  assert.equal(selectSportsWorkoutTarget(speedOnly, csc).kind, 'none');
});

test('heart zone target requires server-authoritative HR policy', () => {
  const stage = { ...plan.stages[0], target: {
    kind: 'cycling', heart_zone_min: 2, heart_zone_max: 3,
  } };
  const withHeart = snapshot(0);
  withHeart.metrics.heartRate = {
    state: 'live', fresh: true, held: false, value: 140, source: 'hrs',
  };
  assert.equal(selectSportsWorkoutTarget(stage, withHeart, {
    maxHeartRateBpm: 190,
  }).kind, 'none');
  assert.equal(selectSportsWorkoutTarget(stage, withHeart, {
    maxHeartRateBpm: 190, heartRateAuthoritative: true,
  }).kind, 'heart');
});

test('ten-stage interval execution crosses work and recovery in exact frozen order', () => {
  const types = [
    'warmup', 'work', 'recovery', 'work', 'recovery',
    'work', 'recovery', 'work', 'recovery', 'cooldown',
  ];
  const intervalPlan = {
    ...plan,
    revision: 9,
    title: '四组间歇',
    type: 'interval',
    stages: types.map((type, order) => ({
      stage_id: 'sps_' + order.toString(16).repeat(24),
      order,
      type,
      title: type === 'work' ? `第${Math.ceil(order / 2)}组` : type,
      duration_sec: 30,
      target: type === 'work'
        ? { kind: 'cycling', power_min_w: 180, power_max_w: 220,
          effort_min: 6, effort_max: 8 }
        : { kind: 'cycling', cadence_min_rpm: 70, cadence_max_rpm: 90,
          effort_min: 2, effort_max: 4 },
    })),
  };
  const state = createSportsWorkoutExecutor(intervalPlan, base);
  updateSportsWorkoutExecutor(state, snapshot(0, { distance: 0 }));
  updateSportsWorkoutExecutor(state, snapshot(135000, {
    power: 200, powerSource: 'cps', distance: 900,
  }));
  assert.equal(state.stageIndex, 4,
    'one delayed callback can cross warmup/work/recovery/work into stage five');
  assert.equal(sportsWorkoutHud(state, snapshot(135000)).title, 'recovery');
  assert.deepEqual(state.stageResults.slice(0, 5).map((item) => item.duration_sec), [
    30, 30, 30, 30, 15,
  ]);

  // Paused/hidden time is already excluded by CyclingMetrics.elapsedMs.  A
  // repeated elapsed value must not advance the frozen stage ledger.
  updateSportsWorkoutExecutor(state, snapshot(135000, {
    power: 200, powerSource: 'cps', distance: 900,
  }));
  assert.equal(state.stageIndex, 4);
  assert.equal(state.stageResults[4].duration_sec, 15);

  updateSportsWorkoutExecutor(state, snapshot(300000, {
    power: 200, powerSource: 'cps', distance: 2000,
  }));
  assert.equal(state.complete, true);
  const result = finalizeSportsWorkout(state);
  assert.equal(result.completion_percent, 100);
  assert.equal(result.stage_results.length, 10);
  assert.deepEqual(
    result.stage_results.map((item) => item.stage_id),
    intervalPlan.stages.map((stage) => stage.stage_id),
  );
  assert.deepEqual(result.stage_results.map((item) => item.duration_sec), Array(10).fill(30));
  assert.equal(result.stage_results.reduce((sum, item) => sum + item.duration_sec, 0), 300);
  assert.equal(result.stage_results.reduce((sum, item) => sum + item.distance_m, 0), 2000);
  assert.deepEqual(types.slice(1, 9), [
    'work', 'recovery', 'work', 'recovery', 'work', 'recovery', 'work', 'recovery',
  ]);
});
