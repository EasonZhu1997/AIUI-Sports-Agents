// 骑行两件套：CSC 0x1816 (0x2A5B) 与 Cycling Power 0x1818 (0x2A63)。
// 本文件只做协议解析与单段轮/曲柄计算；跨来源累计、freshness 与重连重锚
// 由 cycling_metrics.js 统一负责。

import { toBytes, u16le, u32le, s16le } from './bytes.js';

const UINT16_MOD = 0x10000;
const DEFAULT_MAX_CADENCE_RPM = 250;
const DEFAULT_MAX_SPEED_KMH = 120;

function isUint(value, max) {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

function uint16Delta(previous, current) {
  return (current - previous + UINT16_MOD) % UINT16_MOD;
}

/**
 * CSC Measurement (0x2A5B)。
 * flags(uint8): bit0 = 车轮圈数存在(uint32 累计 + uint16 事件时间 1/1024s)；
 *               bit1 = 曲柄圈数存在(uint16 累计 + uint16 事件时间 1/1024s)。
 */
export function parseCscMeasurement(value) {
  const bytes = toBytes(value);
  if (!bytes || bytes.length < 1) return null;

  const flags = bytes[0];
  if ((flags & 0x03) === 0) return null;

  let off = 1;
  const out = { flags, wheel: null, crank: null };

  if ((flags & 0x01) !== 0) {
    if (bytes.length < off + 6) return null;
    out.wheel = { revolutions: u32le(bytes, off), lastEventTime1024: u16le(bytes, off + 4) };
    off += 6;
  }
  if ((flags & 0x02) !== 0) {
    if (bytes.length < off + 4) return null;
    out.crank = { revolutions: u16le(bytes, off), lastEventTime1024: u16le(bytes, off + 2) };
    off += 4;
  }
  return out;
}

/**
 * 由两次曲柄读数算踏频 rpm（处理 uint16 圈数与 1/1024s 时间戳的回绕）。
 * 时间未推进（同一包重发）或结果超合理上限返回 null。
 */
export function crankCadenceRpm(prev, curr, options = {}) {
  if (!prev || !curr) return null;
  if (!isUint(prev.revolutions, 0xffff) || !isUint(curr.revolutions, 0xffff)) return null;
  if (!isUint(prev.lastEventTime1024, 0xffff) || !isUint(curr.lastEventTime1024, 0xffff)) return null;

  const maxCadenceRpm = Number.isFinite(options.maxCadenceRpm)
    ? options.maxCadenceRpm
    : DEFAULT_MAX_CADENCE_RPM;
  const revs = uint16Delta(prev.revolutions, curr.revolutions);
  const dt1024 = uint16Delta(prev.lastEventTime1024, curr.lastEventTime1024);
  if (dt1024 === 0) return null;
  const rpm = (revs * 60 * 1024) / dt1024;
  if (!Number.isFinite(rpm) || rpm < 0 || rpm > maxCadenceRpm) return null;
  return rpm;
}

/**
 * 两次轮累计读数计算本段轮速与距离。
 *
 * CSC 的时间基准为 1/1024s，Cycling Power 轮事件为 1/2048s。uint16
 * 事件时间允许回绕；累计轮转数回退视为传感器复位/倒转并返回 null，
 * 调用方须以当前包重新锚定，不能把回退按 uint32 回绕补算。
 */
export function wheelDeltaMetrics(prev, curr, options = {}) {
  if (!prev || !curr) return null;
  const wheelCircumferenceMm = options.wheelCircumferenceMm;
  const eventTimeHz = options.eventTimeHz === 2048 ? 2048 : 1024;
  const eventTimeField = eventTimeHz === 2048 ? 'lastEventTime2048' : 'lastEventTime1024';
  const maxSpeedKmh = Number.isFinite(options.maxSpeedKmh)
    ? options.maxSpeedKmh
    : DEFAULT_MAX_SPEED_KMH;
  const maxGapSec = Number.isFinite(options.maxGapSec) ? options.maxGapSec : 8;

  if (!(Number.isFinite(wheelCircumferenceMm)
    && wheelCircumferenceMm >= 500
    && wheelCircumferenceMm <= 4000)) return null;
  if (!isUint(prev.revolutions, 0xffffffff) || !isUint(curr.revolutions, 0xffffffff)) return null;
  if (!isUint(prev[eventTimeField], 0xffff) || !isUint(curr[eventTimeField], 0xffff)) return null;

  const dtTicks = uint16Delta(prev[eventTimeField], curr[eventTimeField]);
  const revolutionDelta = curr.revolutions - prev.revolutions;
  if (dtTicks === 0 || revolutionDelta < 0) return null;

  const elapsedSec = dtTicks / eventTimeHz;
  if (!(elapsedSec > 0) || elapsedSec > maxGapSec) return null;

  const distanceM = revolutionDelta * wheelCircumferenceMm / 1000;
  const speedKmh = distanceM / elapsedSec * 3.6;
  if (!Number.isFinite(speedKmh) || speedKmh < 0 || speedKmh > maxSpeedKmh) return null;

  return {
    revolutionDelta,
    elapsedSec,
    distanceM,
    speedKmh,
  };
}

/**
 * Cycling Power Measurement (0x2A63)。
 * flags(uint16) 后紧跟必有的 Instantaneous Power (sint16, W)；
 * 可选字段按 flags 顺序：bit0 踏板平衡(uint8)、bit2 累计扭矩(uint16)、
 * bit4 车轮圈数(uint32+uint16 1/2048s)、bit5 曲柄圈数(uint16+uint16 1/1024s)。
 */
export function parseCyclingPower(value) {
  const bytes = toBytes(value);
  if (!bytes || bytes.length < 4) return null;

  const flags = u16le(bytes, 0);
  let off = 2;
  const need = (n) => bytes.length >= off + n;
  const powerW = s16le(bytes, off);
  off += 2;

  if ((flags & 0x0001) !== 0) { if (!need(1)) return null; off += 1; } // Pedal Power Balance
  if ((flags & 0x0004) !== 0) { if (!need(2)) return null; off += 2; } // Accumulated Torque

  let wheel = null;
  if ((flags & 0x0010) !== 0) {
    if (!need(6)) return null;
    wheel = { revolutions: u32le(bytes, off), lastEventTime2048: u16le(bytes, off + 4) };
    off += 6;
  }
  let crank = null;
  if ((flags & 0x0020) !== 0) {
    if (!need(4)) return null;
    crank = { revolutions: u16le(bytes, off), lastEventTime1024: u16le(bytes, off + 2) };
    off += 4;
  }

  // 后续字段当前 HUD 不展示，但 flags 声明后仍必须完整存在；否则不能把残包
  // 当作有效功率通知推进 freshness。
  if ((flags & 0x0040) !== 0) { if (!need(4)) return null; off += 4; } // Extreme Force
  if ((flags & 0x0080) !== 0) { if (!need(4)) return null; off += 4; } // Extreme Torque
  if ((flags & 0x0100) !== 0) { if (!need(3)) return null; off += 3; } // Extreme Angles
  if ((flags & 0x0200) !== 0) { if (!need(2)) return null; off += 2; } // Top Dead Spot
  if ((flags & 0x0400) !== 0) { if (!need(2)) return null; off += 2; } // Bottom Dead Spot
  if ((flags & 0x0800) !== 0) { if (!need(2)) return null; off += 2; } // Accumulated Energy

  return { flags, powerW, wheel, crank };
}
