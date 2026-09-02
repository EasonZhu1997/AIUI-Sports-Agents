import test from 'node:test';
import assert from 'node:assert/strict';
import { createSportsWorkoutExecutor } from '../lib/sports_workout_executor.js';
import { nextSportsCoachCue } from '../lib/sports_coach.js';

const base = 1760000000000;
const plan = { workout_id: 'spw_' + 'a'.repeat(24), revision: 1, title: '训练',
  type: 'steady', issued_at_ms: base - 1, expires_at_ms: base + 999999, stages: [{
    stage_id: 'sps_' + 'b'.repeat(24), order: 0, type: 'work', title: '稳定段',
    duration_sec: 600, cue: '保持节奏', target: { kind: 'cycling', cadence_min_rpm: 80,
      cadence_max_rpm: 90 },
  }] };
const snapshot = (cadence = 60, bpm = null) => ({ paused: false, metrics: {
  cadence: { state: 'live', fresh: true, value: cadence, source: 'csc' },
  speed: { state: 'live', fresh: true, value: 20, source: 'csc' },
  power: { state: 'unsupported' },
  heartRate: bpm == null ? { state: 'unsupported' }
    : { state: 'live', fresh: true, value: bpm, source: 'hrs' },
} });

test('coach announces stage then requires 15s held deviation and 75s cooldown', () => {
  const executor = createSportsWorkoutExecutor(plan, base);
  let result = nextSportsCoachCue(null, executor, snapshot(), { now: base, maxHeartRateBpm: 190 });
  assert.equal(result.reason, 'stage');
  result = nextSportsCoachCue(result.state, executor, snapshot(), { now: base + 61000, maxHeartRateBpm: 190 });
  assert.equal(result.cue, null);
  result = nextSportsCoachCue(result.state, executor, snapshot(), { now: base + 76000, maxHeartRateBpm: 190 });
  assert.equal(result.reason, 'target');
});

test('server-authoritative high heart rate gets conservative safety cue without model inference', () => {
  const executor = createSportsWorkoutExecutor(plan, base);
  const seeded = { stageIndex: 0, lastCueAtMs: base - 76000 };
  const result = nextSportsCoachCue(seeded, executor, snapshot(85, 182), {
    now: base, maxHeartRateBpm: 190, heartRateAuthoritative: true,
  });
  assert.equal(result.reason, 'safety');
  assert.match(result.cue, /减小强度/);
});

test('local max heart-rate setting cannot authorize relative safety', () => {
  const executor = createSportsWorkoutExecutor(plan, base);
  const seeded = { stageIndex: 0, lastCueAtMs: base - 76000 };
  const result = nextSportsCoachCue(seeded, executor, snapshot(85, 182), {
    now: base, maxHeartRateBpm: 190,
  });
  assert.notEqual(result.reason, 'safety');
});

test('coach announces a sustained power-to-cadence degradation without fabricating power', () => {
  const fallbackPlan = structuredClone(plan);
  fallbackPlan.stages[0].target.power_min_w = 150;
  fallbackPlan.stages[0].target.power_max_w = 180;
  const executor = createSportsWorkoutExecutor(fallbackPlan, base);
  const powerSnapshot = snapshot(85);
  powerSnapshot.metrics.power = {
    state: 'live', fresh: true, value: 165, source: 'cps',
  };
  let result = nextSportsCoachCue(null, executor, powerSnapshot, { now: base });
  assert.equal(result.reason, 'stage');
  result = nextSportsCoachCue(result.state, executor, snapshot(85), { now: base + 61000 });
  assert.equal(result.cue, null);
  result = nextSportsCoachCue(result.state, executor, snapshot(85), { now: base + 76000 });
  assert.equal(result.reason, 'degraded');
  assert.match(result.cue, /功率数据中断.*踏频/);
});

test('continuous source loss is announced once and only valid recovery re-arms it', () => {
  const executor = createSportsWorkoutExecutor(plan, base);
  const unavailable = snapshot();
  unavailable.metrics.cadence = {
    state: 'stale', fresh: false, value: null, source: 'csc',
  };
  let result = nextSportsCoachCue(null, executor, unavailable, { now: base });
  assert.equal(result.reason, 'stage');

  result = nextSportsCoachCue(result.state, executor, unavailable, { now: base + 76000 });
  assert.equal(result.reason, 'source');
  assert.equal(result.state.sourceLossAnnounced, true);

  result = nextSportsCoachCue(result.state, executor, unavailable, { now: base + 160000 });
  assert.equal(result.cue, null, 'continuous none must not repeat after another cooldown');

  result = nextSportsCoachCue(result.state, executor, snapshot(85), { now: base + 161000 });
  assert.equal(result.cue, null);
  assert.equal(result.state.sourceLossAnnounced, false);

  result = nextSportsCoachCue(result.state, executor, unavailable, { now: base + 162000 });
  assert.equal(result.cue, null);
  result = nextSportsCoachCue(result.state, executor, unavailable, { now: base + 177000 });
  assert.equal(result.reason, 'source', 'a later valid-to-none edge may announce once');
});
