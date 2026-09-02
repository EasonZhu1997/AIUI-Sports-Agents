// FTMS 0x1826：骑行版只接收 Indoor Bike Data 0x2AD2。
// 字段顺序按 Bluetooth SIG FTMS v1.0 flags 位序逐个校验、跳过或提取。

import { toBytes, u8, u16le, u24le, s16le } from './bytes.js';

/**
 * Indoor Bike Data (0x2AD2)。flags 为 uint16：
 * bit0 More Data（为 0 时有 Inst Speed uint16 0.01km/h）· bit1 Avg Speed
 * bit2 Inst Cadence(uint16, 0.5rpm) · bit3 Avg Cadence · bit4 Total Distance(uint24)
 * bit5 Resistance(sint16) · bit6 Inst Power(sint16 W) · bit7 Avg Power
 * bit8 Energy 组 · bit9 HR(uint8) · bit10 MET · bit11 Elapsed(uint16) · bit12 Remaining
 */
export function parseIndoorBikeData(value) {
  const bytes = toBytes(value);
  if (!bytes || bytes.length < 2) return null;

  const flags = u16le(bytes, 0);
  let off = 2;
  const need = (n) => bytes.length >= off + n;
  const out = {
    flags,
    hasMoreData: (flags & 0x0001) !== 0,
    speedKmh: null,
    averageSpeedKmh: null,
    cadenceRpm: null,
    averageCadenceRpm: null,
    totalDistanceM: null,
    resistanceLevel: null,
    powerW: null,
    averagePowerW: null,
    totalEnergyKcal: null,
    energyPerHourKcal: null,
    energyPerMinuteKcal: null,
    heartRateBpm: null,
    metabolicEquivalent: null,
    elapsedSec: null,
    remainingSec: null,
  };

  if ((flags & 0x0001) === 0) {
    if (!need(2)) return null;
    out.speedKmh = u16le(bytes, off) / 100;
    off += 2;
  }
  if ((flags & 0x0002) !== 0) {
    if (!need(2)) return null;
    out.averageSpeedKmh = u16le(bytes, off) / 100;
    off += 2;
  }
  if ((flags & 0x0004) !== 0) {
    if (!need(2)) return null;
    out.cadenceRpm = u16le(bytes, off) / 2;
    off += 2;
  }
  if ((flags & 0x0008) !== 0) {
    if (!need(2)) return null;
    out.averageCadenceRpm = u16le(bytes, off) / 2;
    off += 2;
  }
  if ((flags & 0x0010) !== 0) {
    if (!need(3)) return null;
    out.totalDistanceM = u24le(bytes, off);
    off += 3;
  }
  if ((flags & 0x0020) !== 0) {
    if (!need(2)) return null;
    out.resistanceLevel = s16le(bytes, off);
    off += 2;
  }
  if ((flags & 0x0040) !== 0) {
    if (!need(2)) return null;
    out.powerW = s16le(bytes, off);
    off += 2;
  }
  if ((flags & 0x0080) !== 0) {
    if (!need(2)) return null;
    out.averagePowerW = s16le(bytes, off);
    off += 2;
  }
  if ((flags & 0x0100) !== 0) {
    if (!need(5)) return null;
    out.totalEnergyKcal = u16le(bytes, off);
    out.energyPerHourKcal = u16le(bytes, off + 2);
    out.energyPerMinuteKcal = u8(bytes, off + 4);
    off += 5;
  }
  if ((flags & 0x0200) !== 0) {
    if (!need(1)) return null;
    out.heartRateBpm = u8(bytes, off);
    off += 1;
  }
  if ((flags & 0x0400) !== 0) {
    if (!need(1)) return null;
    out.metabolicEquivalent = u8(bytes, off) / 10;
    off += 1;
  }
  if ((flags & 0x0800) !== 0) {
    if (!need(2)) return null;
    out.elapsedSec = u16le(bytes, off);
    off += 2;
  }
  if ((flags & 0x1000) !== 0) {
    if (!need(2)) return null;
    out.remainingSec = u16le(bytes, off);
    off += 2;
  }

  return out;
}
