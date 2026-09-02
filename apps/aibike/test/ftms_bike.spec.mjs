import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIndoorBikeData } from '../lib/ftms.js';

test('Thinkrider 常见帧：速度 + 踏频 + 功率', () => {
  // flags = 0x0044: Inst Cadence(bit2) + Inst Power(bit6)
  const r = parseIndoorBikeData([
    0x44, 0x00,
    0xc4, 0x09,  // 25.0 km/h
    0xb4, 0x00,  // cadence 180×0.5 = 90 rpm
    0xfa, 0x00,  // 250 W
  ]);
  assert.equal(r.speedKmh, 25);
  assert.equal(r.cadenceRpm, 90);
  assert.equal(r.powerW, 250);
});

test('带累计距离与心率', () => {
  // flags = 0x0210: Total Distance(bit4) + HR(bit9)
  const r = parseIndoorBikeData([
    0x10, 0x02,
    0xd0, 0x07,        // 20.0 km/h
    0x10, 0x27, 0x00,  // 10000 m
    155,               // HR
  ]);
  assert.equal(r.speedKmh, 20);
  assert.equal(r.totalDistanceM, 10000);
  assert.equal(r.heartRateBpm, 155);
});

test('More Data=1 无速度，跳过阻力位读功率', () => {
  // flags = 0x0061: MoreData(bit0) + Resistance(bit5) + Power(bit6)
  const r = parseIndoorBikeData([0x61, 0x00, 0x05, 0x00, 0x96, 0x00]);
  assert.equal(r.speedKmh, null);
  assert.equal(r.powerW, 150);
});

test('残包 → null', () => {
  assert.equal(parseIndoorBikeData([0x44]), null);
  assert.equal(parseIndoorBikeData([0x44, 0x00, 0xc4, 0x09, 0xb4]), null);
});

test('明确的零速度/踏频/功率保留为 0，不与缺字段混淆', () => {
  const r = parseIndoorBikeData([
    0x44, 0x00,
    0x00, 0x00,
    0x00, 0x00,
    0x00, 0x00,
  ]);
  assert.equal(r.speedKmh, 0);
  assert.equal(r.cadenceRpm, 0);
  assert.equal(r.powerW, 0);
});

test('完整解析平均值、能量、MET、经过/剩余时间', () => {
  // avg speed(bit1), avg cadence(bit3), avg power(bit7), energy(bit8),
  // MET(bit10), elapsed(bit11), remaining(bit12)
  const r = parseIndoorBikeData([
    0x8a, 0x1d,
    0xc4, 0x09,       // instant speed 25.00
    0x60, 0x09,       // avg speed 24.00
    0xb4, 0x00,       // avg cadence 90
    0xc8, 0x00,       // avg power 200
    0x2c, 0x01,       // total energy 300
    0x58, 0x02,       // 600 kcal/h
    10,               // 10 kcal/min
    85,               // MET 8.5
    0x58, 0x02,       // elapsed 600s
    0x2c, 0x01,       // remaining 300s
  ]);
  assert.equal(r.averageSpeedKmh, 24);
  assert.equal(r.averageCadenceRpm, 90);
  assert.equal(r.averagePowerW, 200);
  assert.equal(r.totalEnergyKcal, 300);
  assert.equal(r.metabolicEquivalent, 8.5);
  assert.equal(r.elapsedSec, 600);
  assert.equal(r.remainingSec, 300);
});

test('FTMS 尾部 flags 声明字段缺失时拒绝残包', () => {
  // More Data + Remaining Time，只有 1 字节 remaining
  assert.equal(parseIndoorBikeData([0x01, 0x10, 0x2c]), null);
});
