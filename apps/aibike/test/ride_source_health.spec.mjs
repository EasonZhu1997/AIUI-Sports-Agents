import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideHrsSourceHealth,
  decideRideSourceHealth,
  RIDE_SOURCE_HEALTH_LIMITS,
  RIDE_SOURCE_HEALTH_STATE,
} from '../lib/ride_source_health.js';

test('HRS 首包在 20 秒闭区间等待，超过边界才 stale 并请求重订阅', () => {
  const atBoundary = decideHrsSourceHealth({
    supported: true,
    startedAtMs: 1000,
    nowMs: 21000,
  });
  assert.equal(atBoundary.state, RIDE_SOURCE_HEALTH_STATE.WAITING);
  assert.equal(atBoundary.reason, 'first-packet-wait');
  assert.equal(atBoundary.timeoutMs, RIDE_SOURCE_HEALTH_LIMITS.hrsFirstPacketMs);
  assert.equal(atBoundary.shouldRestart, false);

  const expired = decideHrsSourceHealth({
    supported: true,
    startedAtMs: 1000,
    nowMs: 21001,
  });
  assert.equal(expired.state, RIDE_SOURCE_HEALTH_STATE.STALE);
  assert.equal(expired.reason, 'first-packet-timeout');
  assert.equal(expired.shouldRestart, true);
  assert.equal(expired.shouldEndSession, false);
});

test('HRS 续包 8 秒内 fresh，超过 8 秒进入 stale', () => {
  const fresh = decideHrsSourceHealth({
    supported: true,
    startedAtMs: 1000,
    lastPacketAtMs: 5000,
    nowMs: 13000,
  });
  assert.equal(fresh.state, RIDE_SOURCE_HEALTH_STATE.FRESH);
  assert.equal(fresh.reason, 'packet-fresh');
  assert.equal(fresh.ageMs, 8000);

  const stale = decideHrsSourceHealth({
    supported: true,
    startedAtMs: 1000,
    lastPacketAtMs: 5000,
    nowMs: 13001,
    hasLastValue: true,
  });
  assert.equal(stale.state, RIDE_SOURCE_HEALTH_STATE.STALE);
  assert.equal(stale.reason, 'packet-stale');
  assert.equal(stale.shouldRestart, true);
  assert.equal(stale.shouldClearValue, true);
});

test('AR hidden 断流不重启、不清零、不结束，onShow 保值并请求恢复', () => {
  const hidden = decideHrsSourceHealth({
    supported: true,
    startedAtMs: 1000,
    lastPacketAtMs: 2000,
    nowMs: 12001,
    lifecycle: 'hidden',
    hasLastValue: true,
  });
  assert.equal(hidden.state, RIDE_SOURCE_HEALTH_STATE.STALE);
  assert.equal(hidden.shouldRestart, false);
  assert.equal(hidden.shouldKeepLastValue, true);
  assert.equal(hidden.shouldClearValue, false);
  assert.equal(hidden.shouldEndSession, false);

  const shown = decideHrsSourceHealth({
    supported: true,
    startedAtMs: 1000,
    lastPacketAtMs: 2000,
    nowMs: 12001,
    lifecycle: 'show',
    hasLastValue: true,
  });
  assert.equal(shown.shouldRestart, true);
  assert.equal(shown.shouldKeepLastValue, true);
});

test('未知来源、未启动、非活动会话与错误时间轴均安全失败', () => {
  const unknown = decideRideSourceHealth({
    source: 'gps',
    supported: true,
    nowMs: 1000,
  });
  assert.equal(unknown.state, RIDE_SOURCE_HEALTH_STATE.UNSUPPORTED);
  assert.equal(unknown.reason, 'unknown-source');

  const notStarted = decideHrsSourceHealth({ supported: true, nowMs: 1000 });
  assert.equal(notStarted.state, RIDE_SOURCE_HEALTH_STATE.WAITING);
  assert.equal(notStarted.reason, 'source-not-started');

  const inactive = decideHrsSourceHealth({
    supported: true,
    sessionActive: false,
    startedAtMs: 1000,
    nowMs: 30000,
  });
  assert.equal(inactive.reason, 'session-inactive');

  const futurePacket = decideHrsSourceHealth({
    supported: true,
    startedAtMs: 1000,
    lastPacketAtMs: 4000,
    nowMs: 3000,
  });
  assert.equal(futurePacket.state, RIDE_SOURCE_HEALTH_STATE.STALE);
  assert.equal(futurePacket.reason, 'invalid-timeline');
});
