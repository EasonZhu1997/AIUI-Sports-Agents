import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCyclingPower } from '../lib/cycling.js';

test('最简功率包：flags=0，仅瞬时功率 250W', () => {
  const r = parseCyclingPower([0x00, 0x00, 0xfa, 0x00]);
  assert.equal(r.powerW, 250);
  assert.equal(r.wheel, null);
  assert.equal(r.crank, null);
});

test('负功率（倒踩/校准）sint16', () => {
  const r = parseCyclingPower([0x00, 0x00, 0xf6, 0xff]);
  assert.equal(r.powerW, -10);
});

test('带踏板平衡 + 累计扭矩偏移后再读曲柄数据', () => {
  // flags = 0x0025: balance(bit0) + torque(bit2) + crank(bit5)
  const r = parseCyclingPower([
    0x25, 0x00,
    0x2c, 0x01,        // power 300W
    50,                // balance
    0x10, 0x00,        // torque
    0x0a, 0x00, 0x00, 0x04, // crank: 10 revs, t=1024
  ]);
  assert.equal(r.powerW, 300);
  assert.equal(r.crank.revolutions, 10);
  assert.equal(r.crank.lastEventTime1024, 1024);
});

test('带车轮数据（骑行台风格）', () => {
  // flags = 0x0010: wheel present
  const r = parseCyclingPower([
    0x10, 0x00,
    0xc8, 0x00,                        // 200W
    0xe8, 0x03, 0x00, 0x00, 0x00, 0x10, // wheel 1000 revs, t=4096(1/2048s)
  ]);
  assert.equal(r.powerW, 200);
  assert.equal(r.wheel.revolutions, 1000);
  assert.equal(r.wheel.lastEventTime2048, 4096);
});

test('残包 → null', () => {
  assert.equal(parseCyclingPower([0x00, 0x00, 0xfa]), null);
  assert.equal(parseCyclingPower([0x20, 0x00, 0xc8, 0x00, 0x01]), null); // 声称曲柄缺字节
  assert.equal(parseCyclingPower([0x01, 0x00, 0xc8, 0x00]), null); // 声称踏板平衡缺字节
  assert.equal(parseCyclingPower([0x04, 0x00, 0xc8, 0x00, 0x01]), null); // 累计扭矩残包
  assert.equal(parseCyclingPower([0x40, 0x00, 0xc8, 0x00]), null); // 极值力矩尾字段残包
});

test('不展示的 CPS 可选尾字段也必须完整，完整包仍保留核心功率', () => {
  // flags: Extreme Force(bit6) + Accumulated Energy(bit11)
  const full = parseCyclingPower([
    0x40, 0x08,
    0xfa, 0x00,
    0x10, 0x00, 0xf0, 0xff,
    0x34, 0x12,
  ]);
  assert.equal(full.powerW, 250);
  assert.equal(full.flags, 0x0840);
  assert.equal(parseCyclingPower([
    0x40, 0x08,
    0xfa, 0x00,
    0x10, 0x00, 0xf0, 0xff,
    0x34,
  ]), null);
});
