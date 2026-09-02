import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBytes, u16le, u24le, u32le, s16le, sfloat16le } from '../lib/bytes.js';

test('toBytes 接受 number[] 与 array-like，拒绝越界字节', () => {
  assert.deepEqual(toBytes([1, 2, 255]), [1, 2, 255]);
  assert.deepEqual(toBytes(new Uint8Array([9, 8])), [9, 8]);
  assert.equal(toBytes([1, 256]), null);
  assert.equal(toBytes([1, -1]), null);
  assert.deepEqual(toBytes(null), []);
});

test('小端整数读取', () => {
  assert.equal(u16le([0x2c, 0x01], 0), 300);
  assert.equal(u24le([0x40, 0x42, 0x0f], 0), 999_999 + 1);
  assert.equal(u32le([0xff, 0xff, 0xff, 0xff], 0), 4294967295);
  assert.equal(s16le([0xff, 0xff], 0), -1);
  assert.equal(s16le([0x9c, 0xff], 0), -100);
  assert.equal(s16le([0x64, 0x00], 0), 100);
});

test('SFLOAT：普通值与指数', () => {
  // 980 * 10^-1 = 98.0 → mantissa=980(0x3D4), exponent=-1(0xF) → 0xF3D4
  assert.equal(sfloat16le([0xd4, 0xf3], 0), 98.0);
  // 72 * 10^0 = 72 → 0x0048
  assert.equal(sfloat16le([0x48, 0x00], 0), 72);
});

test('SFLOAT：特殊值 NaN/NRes/±INF 均为非有限', () => {
  assert.ok(Number.isNaN(sfloat16le([0xff, 0x07], 0)));   // NaN
  assert.ok(!Number.isFinite(sfloat16le([0x00, 0x08], 0))); // NRes
  assert.ok(!Number.isFinite(sfloat16le([0xfe, 0x07], 0))); // +INF
  assert.ok(!Number.isFinite(sfloat16le([0x02, 0x08], 0))); // -INF
});
