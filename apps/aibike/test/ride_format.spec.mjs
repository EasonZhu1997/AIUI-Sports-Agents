import test from 'node:test';
import assert from 'node:assert/strict';
import {
  averageSpeedKmh,
  formatBpm,
  formatCadenceRpm,
  formatDistanceKm,
  formatElapsed,
  formatPowerW,
  formatSpeedKmh,
} from '../lib/ride_format.js';

test('ride format keeps unknown metrics explicit without bug-like dashes', () => {
  assert.equal(formatSpeedKmh(null), '未记录');
  assert.equal(formatCadenceRpm(undefined), '未记录');
  assert.equal(formatPowerW(-1), '未记录');
  assert.equal(formatBpm(0), '未记录');
  assert.equal(formatBpm(0, '等待'), '等待');
});

test('ride format uses cycling units', () => {
  assert.equal(formatElapsed(3723000), '1:02:03');
  assert.equal(formatSpeedKmh(27.34), '27.3');
  assert.equal(formatDistanceKm(12345), '12.35');
  assert.equal(formatCadenceRpm(89.7), '90');
  assert.equal(formatPowerW(248.6), '249');
  assert.equal(formatBpm(151.4), '151');
  assert.equal(averageSpeedKmh(10000, 1200000), 30);
});
