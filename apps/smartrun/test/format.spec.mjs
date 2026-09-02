import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CADENCE_PENDING,
  estimatePaceSecPerKmFromCadence,
  formatCadence, formatElapsed, formatPace, paceSecPerKmFromKmh,
  formatDistanceKm, formatBpm,
  PACE_PENDING,
} from '../lib/format.js';

test('时长：mm:ss 与跨小时 h:mm:ss', () => {
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(65000), '01:05');
  assert.equal(formatElapsed(3661000), '1:01:01');
  assert.equal(formatElapsed(-1), '00:00');
  assert.equal(formatElapsed(NaN), '00:00');
});

test('配速：sec/km → M:SS，四舍五入进位不出现 5:60', () => {
  assert.equal(formatPace(330), '5:30');
  assert.equal(formatPace(359.6), '6:00');
  assert.equal(formatPace(0), PACE_PENDING);
  assert.equal(formatPace(1500), '25:00'); // 慢配速也出数(≤30:00/km)
  assert.equal(formatPace(1900), PACE_PENDING);   // 慢于 30:00/km 时继续获取有效跑步值
  assert.equal(formatPace(null), PACE_PENDING);
});

test('km/h → sec/km；接近 0 视为无配速', () => {
  assert.equal(paceSecPerKmFromKmh(12), 300);
  assert.equal(paceSecPerKmFromKmh(0.3), null);
  assert.equal(paceSecPerKmFromKmh(NaN), null);
});

test('HUD 无运动证据时显示占位，不再用默认 160spm 伪造启动配速', () => {
  assert.equal(estimatePaceSecPerKmFromCadence(0, 0.85, 160), null);
  assert.equal(estimatePaceSecPerKmFromCadence(null, 0.85, 180), null);
  assert.equal(formatPace(null), '-:00');
  assert.equal(formatCadence(0, false), CADENCE_PENDING);
  assert.equal(formatCadence(null), CADENCE_PENDING);
});

test('有效步频与步长形成有界显示估算，但不接受损坏输入', () => {
  assert.equal(estimatePaceSecPerKmFromCadence(180, 1), 335);
  assert.equal(estimatePaceSecPerKmFromCadence(999, 0.85, 160), null);
  assert.equal(estimatePaceSecPerKmFromCadence(180, 0, 160), null);
  assert.equal(estimatePaceSecPerKmFromCadence(300, 2.5), 145);
  assert.equal(estimatePaceSecPerKmFromCadence(40, 0.2), 1800);
  assert.equal(formatCadence(171.6), '172');
  assert.equal(formatCadence(300), '300');
});

test('距离与心率占位', () => {
  assert.equal(formatDistanceKm(5230), '5.23');
  assert.equal(formatDistanceKm(0), '0.00');
  assert.equal(formatDistanceKm(NaN), '--');
  assert.equal(formatBpm(155.4), '155');
  assert.equal(formatBpm(0), '--');
  assert.equal(formatBpm(null), '--');
});
