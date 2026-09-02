import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCyclingSportsMetrics,
  buildSportsOutboxRequest,
  enqueueSportsOutbox,
  flushSportsOutbox,
  readSportsOutbox,
} from '../lib/sports_outbox.js';

const identity = {
  app_id: 'aibike', token: 't'.repeat(64), public_device_id: 'bike_public_001',
  ownership_epoch: 2, data_namespace: 'bike_owner_namespace_002',
};
function storage() {
  const values = new Map();
  return { getStorageSync(k) { return values.get(k); },
    setStorageSync(k, v) { values.set(k, JSON.parse(JSON.stringify(v))); } };
}
function event(kind = 'activity') {
  return { kind, owner: identity, client_execution_id: 'bike-execution-0001',
    status: 'completed', started_at_ms: 1760000000000, ended_at_ms: 1760000060000,
    duration_sec: 60, distance_m: 300, metrics: buildCyclingSportsMetrics({
      avgSpeedKmh: 18, maxSpeedKmh: 22, avgCadenceRpm: 86, movingMs: 58000,
    }), ...(kind === 'completion' ? { workout_id: 'spw_' + 'a'.repeat(24), revision: 1,
      stage_results: [{ stage_id: 'sps_' + 'b'.repeat(24), status: 'completed',
        duration_sec: 60, distance_m: 300, metrics: { target_time_sec: 60,
          target_in_range_sec: 50, source_live_sec: 60 } }] } : {}) };
}

test('outbox is owner isolated and never exposes forbidden raw/location fields', () => {
  const local = storage();
  assert.ok(enqueueSportsOutbox(local, event(), identity));
  assert.equal(readSportsOutbox(local, identity).length, 1);
  const request = buildSportsOutboxRequest(event(), identity);
  assert.equal(request.header['Accept-Language'], 'zh-CN');
  const serialized = JSON.stringify(request.data);
  assert.doesNotMatch(serialized, /latitude|longitude|raw|ble|device_id/i);
  assert.match(request.url, /aiui-sports\/activities$/);
  assert.equal(readSportsOutbox(local, { ...identity, ownership_epoch: 3 }).length, 0);
});

test('overall source coverage and sensor sources use the fixed Hermes cycling whitelist', () => {
  const metrics = buildCyclingSportsMetrics({
    avgSpeedKmh: 18, movingMs: 58000,
    sources: ['hrs', 'csc', 'cadence_model', 'unknown', 'hrs'],
  }, { source_coverage: { hrs: 80, csc: 95, imu: 42, unknown: 100 } });
  assert.deepEqual(metrics.source_coverage, { hrs: 80, csc: 95, imu: 42 });
  assert.deepEqual(metrics.sensor_sources, ['hrs', 'csc', 'imu']);
  assert.doesNotMatch(JSON.stringify(metrics),
    /latitude|longitude|raw|ble|device_id|stroke|moving_time_sec/);
});

test('activity and completion payloads match the strict Sports v1 status and field contract', () => {
  const activityRequest = buildSportsOutboxRequest(event('activity'), identity);
  assert.deepEqual(Object.keys(activityRequest.data).sort(), [
    'client_execution_id', 'distance_m', 'duration_sec', 'ended_at_ms',
    'metrics', 'started_at_ms', 'status',
  ]);
  assert.equal(activityRequest.data.status, 'completed');
  assert.equal('moving_time_sec' in activityRequest.data.metrics, false);

  const partial = event('completion');
  partial.status = 'partial';
  const completionRequest = buildSportsOutboxRequest(partial, identity);
  assert.deepEqual(Object.keys(completionRequest.data).sort(), [
    'client_execution_id', 'distance_m', 'duration_sec', 'ended_at_ms', 'metrics',
    'revision', 'stage_results', 'started_at_ms', 'status',
  ]);
  assert.equal(completionRequest.data.status, 'partial');
  assert.equal(buildSportsOutboxRequest({ ...event('activity'), status: 'stopped' }, identity), null);
  assert.equal(buildSportsOutboxRequest({ ...event('completion'), status: 'stopped' }, identity), null);
});

test('completion 阶段只发送 Hermes 允许的速度和心率聚合字段', () => {
  const completion = event('completion');
  completion.stage_results[0].metrics = {
    avg_speed_kmh: 21.4,
    avg_heart_rate_bpm: 142,
    target_time_sec: 60,
    target_in_range_sec: 50,
    source_live_sec: 60,
  };
  const request = buildSportsOutboxRequest(completion, identity);
  assert.deepEqual(request.data.stage_results[0].metrics, {
    avg_speed_kmh: 21.4,
    avg_heart_rate_bpm: 142,
  });
  assert.doesNotMatch(JSON.stringify(request.data), /target_time_sec|target_in_range_sec|source_live_sec/);
});

test('only accepted=true ACK deletes; 409 and network errors retain', async () => {
  for (const response of [
    { statusCode: 409, data: { accepted: false } },
    { statusCode: 200, data: { accepted: false } },
  ]) {
    const local = storage();
    enqueueSportsOutbox(local, event(), identity);
    const result = await flushSportsOutbox({ storage: local, identity,
      async request() { return response; } });
    assert.equal(result.acked, 0);
    assert.equal(readSportsOutbox(local, identity).length, 1);
  }
});

test('accepted completion ACK removes event and returns review', async () => {
  const local = storage();
  enqueueSportsOutbox(local, event('completion'), identity);
  const result = await flushSportsOutbox({ storage: local, identity,
    async request(options) {
      assert.match(options.url, /workouts\/spw_[a-f0-9]{24}\/complete$/);
      return { statusCode: 200, data: { accepted: true, duplicate: false,
        activity_id: 'spa_' + 'c'.repeat(24), review: { headline: '完成训练', detail: '节奏稳定' } } };
    } });
  assert.equal(result.acked, 1);
  assert.equal(result.review.headline, '完成训练');
  assert.equal(readSportsOutbox(local, identity).length, 0);
});
