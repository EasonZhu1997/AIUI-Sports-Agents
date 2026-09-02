import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHudMetricDisplay,
  buildSummaryMetricDisplay,
} from '../lib/ride_display.js';

test('骑行首屏用可理解状态取代裸零值和横线', () => {
  assert.deepEqual(buildHudMetricDisplay({
    speedKmh: null,
    cadenceRpm: null,
    distanceM: 0,
    elapsedMs: 0,
    heartRateBpm: null,
    powerW: null,
    heartRateMode: 'waiting',
  }), {
    speed: '估算中',
    cadence: '识别中',
    distance: '待起步',
    elapsed: '刚开始',
    heartRate: '等待',
    power: '未连接',
    powerChipText: '',
    showPower: false,
  });
});

test('实时正数保持数字格式和正确单位', () => {
  const display = buildHudMetricDisplay({
    speedKmh: 24.26,
    cadenceRpm: 88.6,
    distanceM: 12345,
    elapsedMs: 62000,
    heartRateBpm: 151,
    powerW: 249.6,
    speedState: 'live',
    cadenceState: 'live',
    moving: true,
    powerEverLive: true,
  });
  assert.equal(display.speed, '24.3');
  assert.equal(display.cadence, '89');
  assert.equal(display.distance, '12.35');
  assert.equal(display.elapsed, '01:02');
  assert.equal(display.heartRate, '151');
  assert.equal(display.powerChipText, '功率 250W');
});

test('明确静止和滑行状态不会看起来像读数故障', () => {
  const stopped = buildHudMetricDisplay({
    speedKmh: 0,
    cadenceRpm: 0,
    distanceM: 860,
    elapsedMs: 30000,
    speedState: 'explicit_zero',
    cadenceState: 'explicit_zero',
    stationary: true,
  });
  assert.equal(stopped.speed, '静止');
  assert.equal(stopped.cadence, '静止');
  assert.equal(stopped.distance, '0.86');

  const coasting = buildHudMetricDisplay({
    speedKmh: 22,
    cadenceRpm: 0,
    distanceM: 1000,
    elapsedMs: 60000,
    speedState: 'live',
    cadenceState: 'explicit_zero',
    moving: true,
    powerW: 0,
    powerEverLive: true,
  });
  assert.equal(coasting.speed, '22.0');
  assert.equal(coasting.cadence, '滑行');
  assert.equal(coasting.powerChipText, '功率·滑行');

  const subWatt = buildHudMetricDisplay({
    speedKmh: 20,
    cadenceRpm: 0,
    powerW: 0.4,
    moving: true,
    powerEverLive: true,
  });
  assert.equal(subWatt.power, '滑行');
  assert.equal(subWatt.powerChipText, '功率·滑行');
  assert.doesNotMatch(subWatt.powerChipText, /\b0W\b/);
});

test('IMU 等待、心率未贴和重连都使用语义状态', () => {
  const waiting = buildHudMetricDisplay({
    speedKmh: null,
    cadenceRpm: null,
    distanceM: 600,
    heartRateMode: 'contact-lost',
  });
  assert.equal(waiting.speed, '估算中');
  assert.equal(waiting.heartRate, '未贴');

  const reconnecting = buildHudMetricDisplay({
    heartRateMode: 'reconnecting',
  });
  assert.equal(reconnecting.heartRate, '重连');
});

test('极短距离不显示为 0.00', () => {
  assert.equal(buildHudMetricDisplay({ distanceM: 2 }).distance, '起步中');
  assert.equal(buildHudMetricDisplay({ distanceM: 6 }).distance, '0.01');
  assert.equal(buildSummaryMetricDisplay({
    elapsedMs: 5000,
    distanceM: 2,
  }).distance, '短距离');
});

test('总结页把未形成和未连接与真实数值分开', () => {
  const empty = buildSummaryMetricDisplay({
    elapsedMs: 60000,
    distanceM: 0,
    avgSpeedKmh: null,
    avgCadenceRpm: null,
    avgBpm: null,
    avgPowerW: null,
    sources: ['imu'],
  });
  assert.deepEqual(empty, {
    distance: '未形成',
    elapsed: '01:00',
    speed: '未记录',
    cadence: '未记录',
    heartRate: '未使用',
    power: '未使用',
  });

  const connectedButEmpty = buildSummaryMetricDisplay({
    elapsedMs: 60000,
    distanceM: 100,
    sources: ['hrs', 'cps'],
  });
  assert.equal(connectedButEmpty.heartRate, '未记录');
  assert.equal(connectedButEmpty.power, '未记录');

  const subWatt = buildSummaryMetricDisplay({
    elapsedMs: 60000,
    distanceM: 100,
    avgPowerW: 0.4,
    powerConnected: true,
  });
  assert.equal(subWatt.power, '未记录');
});

test('完整总结继续显示数字', () => {
  const display = buildSummaryMetricDisplay({
    elapsedMs: 3600000,
    distanceM: 20840,
    avgSpeedKmh: 22.4,
    avgCadenceRpm: 86,
    avgBpm: 144,
    avgPowerW: 205,
    sources: ['gps', 'imu', 'hrs', 'cps'],
  });
  assert.deepEqual(display, {
    distance: '20.84',
    elapsed: '1:00:00',
    speed: '22.4',
    cadence: '86',
    heartRate: '144',
    power: '205',
  });
});
