// Heart Rate Service 0x180D 解析 + 心率区间。
// 覆盖 4 台真机：ESP32 模拟器（flags=0x00 uint8）、Chronos 重刷固件、
// Garmin Fenix 8 广播（可能带 RR/接触位）、以及任何 HRP 标准设备。

import { toBytes, u16le } from './bytes.js';

/**
 * 解析 Heart Rate Measurement (0x2A37)。
 * flags: bit0 = HR 16bit；bit1-2 = 传感器接触（10=支持未检出 11=支持且贴合）；
 *        bit3 = Energy Expended 存在(uint16 kJ)；bit4 = RR-Interval 存在(N×uint16, 1/1024s)。
 * @returns {null | {bpm:number, sensorContact:'unsupported'|'no-contact'|'contact',
 *                   energyExpendedKj:number|null, rrIntervalsMs:number[]}}
 */
export function parseHeartRateMeasurement(value) {
  const bytes = toBytes(value);
  if (!bytes || bytes.length < 2) return null;

  const flags = bytes[0];
  const is16 = (flags & 0x01) !== 0;
  let off = 1;

  let bpm;
  if (is16) {
    if (bytes.length < 3) return null;
    bpm = u16le(bytes, off);
    off += 2;
  } else {
    bpm = bytes[off];
    off += 1;
  }

  const contactBits = (flags >> 1) & 0x03;
  const sensorContact =
    contactBits === 0b11 ? 'contact' : contactBits === 0b10 ? 'no-contact' : 'unsupported';

  let energyExpendedKj = null;
  if ((flags & 0x08) !== 0) {
    if (bytes.length < off + 2) return null;
    energyExpendedKj = u16le(bytes, off);
    off += 2;
  }

  const rrIntervalsMs = [];
  if ((flags & 0x10) !== 0) {
    while (off + 1 < bytes.length) {
      rrIntervalsMs.push(Math.round((u16le(bytes, off) / 1024) * 1000));
      off += 2;
    }
  }

  return { bpm, sensorContact, energyExpendedKj, rrIntervalsMs };
}

const SENSOR_LOCATIONS = ['Other', 'Chest', 'Wrist', 'Finger', 'Hand', 'Ear Lobe', 'Foot'];

/** Body Sensor Location (0x2A38)：单字节 → 佩戴部位。 */
export function parseSensorLocation(value) {
  const bytes = toBytes(value);
  if (!bytes || bytes.length < 1) return null;
  return SENSOR_LOCATIONS[bytes[0]] ?? 'Reserved';
}

/** Battery Level (0x2A19)：单字节 0-100，越界视为无效。 */
export function parseBatteryLevel(value) {
  const bytes = toBytes(value);
  if (!bytes || bytes.length < 1) return null;
  const pct = bytes[0];
  return pct >= 0 && pct <= 100 ? pct : null;
}

/**
 * 心率区间 0-5（50/60/70/80/90% maxHr 边界，采用通用五区骑行口径）。
 * <50%（静息心率段）返回 0：站着不动不点亮区间灯，保住 Z1=开始热身的语义。
 * bpm 无效或 maxHr 非法时返回 0（HUD 点阵全暗）。
 * 已知限制：maxHr 默认 190（隐含 30 岁口径），年龄/自定义最大心率设置列入 P1。
 */
export function hrZone(bpm, maxHr = 190) {
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(maxHr) || maxHr <= 0) return 0;
  // 标准五区模型没有 zone0:静息段属于 zone1;返回 0 仅表示"无有效心率"。
  const pct = bpm / maxHr;
  if (pct < 0.6) return 1;
  if (pct < 0.7) return 2;
  if (pct < 0.8) return 3;
  if (pct < 0.9) return 4;
  return 5;
}
