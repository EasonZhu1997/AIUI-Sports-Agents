import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBatteryLevel, parseSensorLocation } from '../lib/hr.js';

test('Battery Level 0x2A19：0-100 有效，越界无效', () => {
  assert.equal(parseBatteryLevel([100]), 100);
  assert.equal(parseBatteryLevel([0]), 0);
  assert.equal(parseBatteryLevel([73]), 73);
  assert.equal(parseBatteryLevel([101]), null);
  assert.equal(parseBatteryLevel([]), null);
});

test('Body Sensor Location 0x2A38：部位映射', () => {
  assert.equal(parseSensorLocation([1]), 'Chest');   // 胸带
  assert.equal(parseSensorLocation([2]), 'Wrist');   // Chronos/Fenix 腕式
  assert.equal(parseSensorLocation([0]), 'Other');
  assert.equal(parseSensorLocation([6]), 'Foot');
  assert.equal(parseSensorLocation([200]), 'Reserved');
  assert.equal(parseSensorLocation([]), null);
});
