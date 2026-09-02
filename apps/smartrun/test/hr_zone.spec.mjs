import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hrZone } from '../lib/hr.js';

test('五区边界（maxHr=190）：50/60/70/80/90% 分界', () => {
  assert.equal(hrZone(60, 190), 1);   // 静息段属于 zone1——五区模型没有 zone0
  assert.equal(hrZone(95, 190), 1);   // 50%
  assert.equal(hrZone(113, 190), 1);  // 59.5%
  assert.equal(hrZone(114, 190), 2);  // 60%
  assert.equal(hrZone(132, 190), 2);  // 69.5%
  assert.equal(hrZone(133, 190), 3);  // 70%
  assert.equal(hrZone(152, 190), 4);  // 80%
  assert.equal(hrZone(171, 190), 5);  // 90%
  assert.equal(hrZone(190, 190), 5);
});

test('无效输入 → zone 0（HUD 点阵全暗）', () => {
  assert.equal(hrZone(0), 0);
  assert.equal(hrZone(-5), 0);
  assert.equal(hrZone(NaN), 0);
  assert.equal(hrZone(150, 0), 0);
  assert.equal(hrZone(150, NaN), 0);
});

test('默认 maxHr=190', () => {
  assert.equal(hrZone(171), 5);
  assert.equal(hrZone(120), 2);
});
