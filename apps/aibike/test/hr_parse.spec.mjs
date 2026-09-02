import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartRateMeasurement } from '../lib/hr.js';

test('ESP32 模拟器最简包：flags=0x00, uint8 bpm', () => {
  const r = parseHeartRateMeasurement([0x00, 72]);
  assert.equal(r.bpm, 72);
  assert.equal(r.sensorContact, 'unsupported');
  assert.equal(r.energyExpendedKj, null);
  assert.deepEqual(r.rrIntervalsMs, []);
});

test('16-bit bpm：flags bit0=1', () => {
  const r = parseHeartRateMeasurement([0x01, 0x2c, 0x01]); // 300
  assert.equal(r.bpm, 300);
});

test('传感器接触位：支持且贴合 / 支持未贴合', () => {
  assert.equal(parseHeartRateMeasurement([0b0110, 65]).sensorContact, 'contact');
  assert.equal(parseHeartRateMeasurement([0b0100, 65]).sensorContact, 'no-contact');
});

test('Garmin 广播风格：接触位 + RR 间期（1024 tick = 1000ms）', () => {
  // flags = 0b10110: contact(11) + RR present(bit4)
  const r = parseHeartRateMeasurement([0x16, 150, 0x00, 0x04, 0x00, 0x02]);
  assert.equal(r.bpm, 150);
  assert.equal(r.sensorContact, 'contact');
  assert.deepEqual(r.rrIntervalsMs, [1000, 500]);
});

test('Energy Expended 在 RR 之前占 2 字节', () => {
  // flags = 0x18: EE(bit3) + RR(bit4)
  const r = parseHeartRateMeasurement([0x18, 120, 0x64, 0x00, 0x00, 0x04]);
  assert.equal(r.bpm, 120);
  assert.equal(r.energyExpendedKj, 100);
  assert.deepEqual(r.rrIntervalsMs, [1000]);
});

test('残包/空包返回 null，不抛异常', () => {
  assert.equal(parseHeartRateMeasurement([]), null);
  assert.equal(parseHeartRateMeasurement([0x00]), null);
  assert.equal(parseHeartRateMeasurement([0x01, 0x50]), null);       // 声称 16bit 只给 1 字节
  assert.equal(parseHeartRateMeasurement([0x08, 120, 0x64]), null);  // 声称 EE 只给 1 字节
  assert.equal(parseHeartRateMeasurement(null), null);
});
