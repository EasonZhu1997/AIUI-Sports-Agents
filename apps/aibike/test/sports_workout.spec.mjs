import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSportsCurrentWorkoutRequest,
  parseSportsCurrentWorkoutResponse,
  readSportsWorkoutCache,
  refreshSportsWorkout,
} from '../lib/sports_workout.js';

const now = 1760000000000;
const identity = {
  app_id: 'aibike', token: 't'.repeat(64), public_device_id: 'bike_public_001',
  ownership_epoch: 2, data_namespace: 'bike_owner_namespace_002',
};
const plan = {
  workout_id: 'spw_' + 'a'.repeat(24), revision: 3, title: '耐力基础骑',
  type: 'endurance', scheduled_date: '2026-08-13', source: 'adaptive',
  rationale: '稳定完成有氧积累', issued_at_ms: now - 1000,
  expires_at_ms: now + 3600000, safety_notes: ['注意路况'], stages: [{
    stage_id: 'sps_' + 'b'.repeat(24), order: 0, type: 'work', title: '稳定踩踏',
    duration_sec: 600, cue: '保持顺畅呼吸', target: {
      kind: 'cycling', power_min_w: 150, power_max_w: 180,
      cadence_min_rpm: 80, cadence_max_rpm: 95,
    },
  }],
};
const envelope = {
  schema_version: 1, available: true, sport: 'cycling',
  discipline: 'outdoor_cycling', public_device_id: identity.public_device_id,
  ownership_epoch: identity.ownership_epoch, data_namespace: identity.data_namespace, plan,
};

function storage() {
  const values = new Map();
  return {
    getStorageSync(key) { return values.get(key); },
    setStorageSync(key, value) { values.set(key, JSON.parse(JSON.stringify(value))); },
  };
}

test('current workout uses authenticated no-store GET and strict owner envelope', () => {
  const request = buildSportsCurrentWorkoutRequest(identity);
  assert.equal(request.method, 'GET');
  assert.equal(request.header['Cache-Control'], 'no-store');
  assert.equal(request.header['Accept-Language'], 'zh-CN');
  assert.match(request.url, /aiui-sports\/workouts\/current$/);
  assert.equal(parseSportsCurrentWorkoutResponse({ statusCode: 200, data: envelope }, identity, now).fresh, true);
  assert.equal(parseSportsCurrentWorkoutResponse({
    statusCode: 200, data: { ...envelope, ownership_epoch: 3 },
  }, identity, now), null);
});

test('JIT refresh must succeed online and read back cache before authorizing plan', async () => {
  const local = storage();
  const result = await refreshSportsWorkout({
    storage: local, identity, now,
    async request() { return { statusCode: 200, data: envelope }; },
  });
  assert.equal(result.ready, true);
  assert.equal(result.envelope.plan.title, '耐力基础骑');
  assert.equal(readSportsWorkoutCache(local, identity, now).available, true);
  const offline = await refreshSportsWorkout({
    storage: local, identity, now,
    async request() { throw new Error('offline'); },
  });
  assert.equal(offline.ready, false);
  assert.equal(offline.envelope, null, 'cached plan cannot authorize a start');
});

test('power range may coexist with explicit cadence fallback, invalid stage fails closed', () => {
  assert.ok(parseSportsCurrentWorkoutResponse({ statusCode: 200, data: envelope }, identity, now));
  const bad = structuredClone(envelope);
  bad.plan.stages[0].target = { kind: 'cycling', power_min_w: 150, power_max_w: 180 };
  assert.ok(parseSportsCurrentWorkoutResponse({ statusCode: 200, data: bad }, identity, now),
    'power-only plan is valid but cannot claim a fallback');
  bad.plan.stages[0].duration_sec = 0;
  assert.equal(parseSportsCurrentWorkoutResponse({ statusCode: 200, data: bad }, identity, now), null);
  const cadenceOverflow = structuredClone(envelope);
  cadenceOverflow.plan.stages[0].target = {
    kind: 'cycling', cadence_min_rpm: 80, cadence_max_rpm: 241,
  };
  assert.equal(parseSportsCurrentWorkoutResponse(
    { statusCode: 200, data: cadenceOverflow }, identity, now,
  ), null, 'current plan cadence ceiling matches Sport Agent v2 at 240 rpm');
});
