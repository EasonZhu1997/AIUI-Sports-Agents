import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunSession } from '../lib/session.js';

test('距离累加：10 km/h 跑 1s ≈ 2.78m', () => {
  const s = new RunSession(0);
  s.onSpeed(10, 1000);
  s.onSpeed(10, 2000);
  assert.ok(Math.abs(s.distanceM - 10000 / 3600) < 0.01);
});

test('钳速：异常/断流样本重置积分锚点，不在恢复包回填幽灵距离', () => {
  const s = new RunSession(0);
  s.onSpeed(10, 1000);
  s.onSpeed(180, 2000);   // GPS 漂移级异常
  s.onSpeed(-5, 3000);
  s.onSpeed(NaN, 4000);
  s.onSpeed(10, 5000);    // 恢复首包只建立新锚点
  assert.equal(s.distanceM, 0);
  s.onSpeed(10, 6000);
  assert.ok(Math.abs(s.distanceM - 10000 / 3600) < 0.01);
});

test('暂停：时长剔除暂停段，暂停中速度样本不计，恢复后首帧不跨段累距', () => {
  const s = new RunSession(0);
  s.onSpeed(12, 1000);
  s.onSpeed(12, 2000);
  const d1 = s.distanceM;
  s.pause(3000);
  s.onSpeed(12, 4000);            // 暂停中，忽略
  s.resume(10000);                // 暂停 7s
  s.onSpeed(12, 11000);           // 恢复后首帧只建锚点
  assert.equal(s.distanceM, d1);
  s.onSpeed(12, 12000);           // 这才累 1s
  assert.ok(s.distanceM > d1);
  assert.equal(s.elapsedMs(12000), 12000 - 7000);
});

test('平均配速：1km/300s = 300 sec/km；距离<10m 返回 null', () => {
  const s = new RunSession(0);
  assert.equal(s.avgPaceSecPerKm(5000), null);
  s.distanceM = 1000;
  assert.equal(s.avgPaceSecPerKm(300000), 300);
});

test('心率/步频过滤非法值，快照字段齐全', () => {
  const s = new RunSession(0);
  s.onHeartRate(158);
  s.onHeartRate(0);      // 忽略
  s.onHeartRate(999);    // 忽略
  s.onCadence(178);
  s.onCadence(-1);       // 忽略
  const snap = s.snapshot(60000);
  assert.equal(snap.bpm, 158);
  assert.equal(snap.cadenceSpm, 178);
  assert.equal(snap.elapsedMs, 60000);
  assert.equal(snap.paused, false);
});

test('全程累计：均值/峰值心率、均值步频(只计运动中样本)', () => {
  const s = new RunSession(0);
  s.onHeartRate(140);
  s.onHeartRate(160);
  s.onHeartRate(150);
  s.onCadence(170);
  s.onCadence(0);        // 静止样本不摊薄均值
  s.onCadence(180);
  assert.equal(s.avgBpm(), 150);
  assert.equal(s.maxBpm(), 160);
  assert.equal(s.avgCadenceSpm(), 175);
  // 暂停中样本不计入累计(但仍更新瞬时值)
  s.pause(10000);
  s.onHeartRate(200);
  s.onCadence(190);
  assert.equal(s.avgBpm(), 150);
  assert.equal(s.maxBpm(), 160);
  assert.equal(s.avgCadenceSpm(), 175);
  assert.equal(s.snapshot(11000).bpm, 200, '瞬时值照常更新');
});

test('全程累计：无样本时返回 null,不编数', () => {
  const s = new RunSession(0);
  assert.equal(s.avgBpm(), null);
  assert.equal(s.maxBpm(), null);
  assert.equal(s.avgCadenceSpm(), null);
});
