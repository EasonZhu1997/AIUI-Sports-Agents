import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCscMeasurement,
  crankCadenceRpm,
  wheelDeltaMetrics,
} from '../lib/cycling.js';

test('CSC：仅曲柄（迈金 S3+ 踏频模式）', () => {
  const r = parseCscMeasurement([0x02, 0x10, 0x00, 0x00, 0x04]);
  assert.equal(r.wheel, null);
  assert.equal(r.crank.revolutions, 16);
  assert.equal(r.crank.lastEventTime1024, 1024);
});

test('CSC：车轮 + 曲柄全字段', () => {
  const r = parseCscMeasurement([
    0x03,
    0xe8, 0x03, 0x00, 0x00, 0x00, 0x08,  // wheel: 1000 revs, t=2048
    0x64, 0x00, 0x00, 0x04,              // crank: 100 revs, t=1024
  ]);
  assert.equal(r.wheel.revolutions, 1000);
  assert.equal(r.wheel.lastEventTime1024, 2048);
  assert.equal(r.crank.revolutions, 100);
});

test('两帧算踏频：2 圈 / 1.28s = 93.75 rpm', () => {
  const prev = { revolutions: 100, lastEventTime1024: 0 };
  const curr = { revolutions: 102, lastEventTime1024: 1311 }; // 1311/1024 约为 1.28s
  const rpm = crankCadenceRpm(prev, curr);
  assert.ok(Math.abs(rpm - 93.75) < 0.15);
});

test('踏频回绕：uint16 圈数与时间戳都回绕仍算对', () => {
  const prev = { revolutions: 0xffff, lastEventTime1024: 0xfc00 };
  const curr = { revolutions: 0x0001, lastEventTime1024: 0x0000 }; // +2圈 / 1s
  const rpm = crankCadenceRpm(prev, curr);
  assert.ok(Math.abs(rpm - 120) < 1e-9);
});

test('时间未推进（重发帧）→ null；残包 → null', () => {
  const same = { revolutions: 5, lastEventTime1024: 100 };
  assert.equal(crankCadenceRpm(same, { ...same }), null);
  assert.equal(parseCscMeasurement([0x01, 0x00, 0x00]), null);
  assert.equal(parseCscMeasurement([0x00]), null, 'CSC flags 必须至少有轮或曲柄');
  assert.equal(parseCscMeasurement([]), null);
});

test('踏频异常上限被拒绝，不把计数器跳变显示成专业踏频', () => {
  const prev = { revolutions: 10, lastEventTime1024: 0 };
  const curr = { revolutions: 20, lastEventTime1024: 1024 };
  assert.equal(crankCadenceRpm(prev, curr), null);
  assert.equal(crankCadenceRpm(prev, curr, { maxCadenceRpm: 700 }), 600);
});

test('轮速：轮周 + 事件时间；支持时间回绕', () => {
  const normal = wheelDeltaMetrics(
    { revolutions: 100, lastEventTime1024: 0 },
    { revolutions: 101, lastEventTime1024: 1024 },
    { wheelCircumferenceMm: 2105, eventTimeHz: 1024 },
  );
  assert.ok(Math.abs(normal.distanceM - 2.105) < 1e-9);
  assert.ok(Math.abs(normal.speedKmh - 7.578) < 1e-9);

  const wrapped = wheelDeltaMetrics(
    { revolutions: 101, lastEventTime1024: 0xfc00 },
    { revolutions: 102, lastEventTime1024: 0x0000 },
    { wheelCircumferenceMm: 2105, eventTimeHz: 1024 },
  );
  assert.ok(Math.abs(wrapped.speedKmh - 7.578) < 1e-9);

  const cpsClock = wheelDeltaMetrics(
    { revolutions: 100, lastEventTime2048: 0 },
    { revolutions: 101, lastEventTime2048: 2048 },
    { wheelCircumferenceMm: 2105, eventTimeHz: 2048 },
  );
  assert.ok(Math.abs(cpsClock.speedKmh - 7.578) < 1e-9);
});

test('轮转数回退、无轮周与超速跳变都只允许调用方重锚', () => {
  assert.equal(wheelDeltaMetrics(
    { revolutions: 10, lastEventTime1024: 0 },
    { revolutions: 9, lastEventTime1024: 1024 },
    { wheelCircumferenceMm: 2105 },
  ), null);
  assert.equal(wheelDeltaMetrics(
    { revolutions: 10, lastEventTime1024: 0 },
    { revolutions: 11, lastEventTime1024: 1024 },
    {},
  ), null);
  assert.equal(wheelDeltaMetrics(
    { revolutions: 10, lastEventTime1024: 0 },
    { revolutions: 30, lastEventTime1024: 1024 },
    { wheelCircumferenceMm: 2105, maxSpeedKmh: 120 },
  ), null);
});
