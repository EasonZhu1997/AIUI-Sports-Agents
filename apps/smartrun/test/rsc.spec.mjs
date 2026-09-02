import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRscCadence, parseRscMeasurement } from '../lib/rsc.js';

test('最简 RSC：速度 + 单脚落地频率（3 m/s，90/min → 180 spm，跑步）', () => {
  const r = parseRscMeasurement([0x04, 0x00, 0x03, 90]);
  assert.equal(r.speedMps, 3);
  assert.ok(Math.abs(r.speedKmh - 10.8) < 1e-9);
  assert.equal(r.cadenceSpm, 180);
  assert.equal(r.cadenceFootfallsPerMin, 90);
  assert.equal(r.cadenceWasDoubled, true);
  assert.equal(r.running, true);
  assert.equal(r.strideLengthM, null);
  assert.equal(r.totalDistanceM, null);
});

test('带步幅 + 累计距离（Stryd 风格全字段）', () => {
  // flags=0x07: 89 次单脚落地/分 + 步幅(120cm) + 距离(12345×0.1m) + 跑步
  const r = parseRscMeasurement([0x07, 0x00, 0x03, 89, 0x78, 0x00, 0x39, 0x30, 0x00, 0x00]);
  assert.equal(r.strideLengthM, 1.2);
  assert.equal(r.totalDistanceM, 1234.5);
  assert.equal(r.cadenceSpm, 178);
});

test('步行位为 0', () => {
  const r = parseRscMeasurement([0x00, 0x80, 0x01, 55]); // 1.5 m/s, 110 spm
  assert.equal(r.running, false);
  assert.equal(r.speedMps, 1.5);
  assert.equal(r.cadenceSpm, 110);
});

test('非标准桥若已发送双脚总步频，超出 300 的翻倍结果会安全保留原值', () => {
  const r = parseRscMeasurement([0x04, 0x00, 0x03, 166]);
  assert.equal(r.cadenceFootfallsPerMin, 166);
  assert.equal(r.cadenceSpm, 166);
  assert.equal(r.cadenceWasDoubled, false);
  assert.equal(normalizeRscCadence(0), 0);
  assert.equal(parseRscMeasurement([0x00, 0x00, 0x00, 0]).cadenceWasDoubled, false);
  assert.equal(normalizeRscCadence(-1), null);
  assert.equal(normalizeRscCadence(256), null);
});

test('残包返回 null', () => {
  assert.equal(parseRscMeasurement([0x01, 0x00, 0x03, 180]), null);      // 声称有步幅但缺字节
  assert.equal(parseRscMeasurement([0x02, 0x00, 0x03, 180, 0x01]), null); // 声称有距离但缺字节
  assert.equal(parseRscMeasurement([0x00, 0x00]), null);
});
