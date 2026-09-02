// 跑步场景 BLE 兼容回归测试
// ----------------------------------------------------------------------------
// 断言字节 = ESP32-S3(S3A3.3) 模拟器【真机抓包】发出的原始数据（sim_watch v2）。
// 只覆盖跑步相关 profile：心率 HRS / 跑步步频·配速 RSC (footpod)。
// 目的：锁死"真表各种真实心率/步频格式来了，眼镜端解析器都能正确读"。
// 骑行与 FTMS 不属于本公开跑步快照范围。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartRateMeasurement } from '../lib/hr.js';
import { parseRscMeasurement } from '../lib/rsc.js';

const B = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));

// ---- 心率 0x2A37：真表 6 种 flag 变体（真机抓包）----
test('HRS 心率变体：8位/16位/接触位/能量/RR/全字段 —— 眼镜端全部正确解析', () => {
  // flags=0x00 8位
  assert.equal(parseHeartRateMeasurement(B('005b')).bpm, 0x5b); // 91
  // flags=0x01 16位心率（部分表用 uint16）
  assert.equal(parseHeartRateMeasurement(B('018900')).bpm, 0x0089); // 137
  // flags=0x06 传感器接触位（贴合）
  {
    const r = parseHeartRateMeasurement(B('06aa'));
    assert.equal(r.bpm, 0xaa); // 170
    assert.equal(r.sensorContact, 'contact');
  }
  // flags=0x08 能量消耗字段
  {
    const r = parseHeartRateMeasurement(B('089a7200'));
    assert.equal(r.bpm, 0x9a); // 154
    assert.equal(r.energyExpendedKj, 0x0072); // 114
  }
  // flags=0x10 RR 间期（HRV，Polar H10 等会带）
  {
    const r = parseHeartRateMeasurement(B('106c3802'));
    assert.equal(r.bpm, 0x6c); // 108
    assert.equal(r.rrIntervalsMs.length, 1);
    assert.equal(r.rrIntervalsMs[0], Math.round((0x0238 / 1024) * 1000)); // 555
  }
  // flags=0x1f 全字段（16位+接触+能量+RR）一起
  {
    const r = parseHeartRateMeasurement(B('1f42004500a203'));
    assert.equal(r.bpm, 0x0042); // 66
    assert.equal(r.sensorContact, 'contact');
    assert.equal(r.energyExpendedKj, 0x0045); // 69
    assert.equal(r.rrIntervalsMs[0], Math.round((0x03a2 / 1024) * 1000)); // 908
  }
});

// ---- 跑步 RSC 0x2A53：footpod 3 种 flag 变体（真机抓包）----
test('RSC 跑步步频/配速变体：basic / +步幅+距离 / running —— 眼镜端全部正确解析', () => {
  // flags=0x00 仅速度+步频
  {
    const r = parseRscMeasurement(B('00cf02a6'));
    assert.equal(r.cadenceSpm, 0xa6); // 166
    assert.ok(Math.abs(r.speedMps - 0x02cf / 256) < 1e-6); // 2.808 m/s
    assert.equal(r.strideLengthM, null);
    assert.equal(r.running, false);
  }
  // flags=0x03 带瞬时步幅 + 总距离
  {
    const r = parseRscMeasurement(B('03c402a65a005b020000'));
    assert.equal(r.cadenceSpm, 0xa6);
    assert.equal(r.strideLengthM, 0.9); // 90cm
    assert.equal(r.totalDistanceM, 60.3);
  }
  // flags=0x04 走/跑标志=跑
  {
    const r = parseRscMeasurement(B('041803ab'));
    assert.equal(r.cadenceSpm, 0xab); // 171
    assert.equal(r.running, true);
  }
});
