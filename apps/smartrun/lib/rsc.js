// Running Speed & Cadence 0x1814 —— RSC Measurement (0x2A53)。
// 覆盖足垫（Stryd 等）与手表 RSC 广播；ESP32 模拟器扩展 profile 之一。

import { toBytes, u16le, u32le } from './bytes.js';

const MAX_PLAUSIBLE_TOTAL_CADENCE_SPM = 300;

/**
 * Bluetooth RSCS defines the cadence byte as the number of ground contacts per
 * minute made by the foot carrying the sensor. Running UIs conventionally show
 * both feet, so a standards-compliant value is doubled (the same conversion
 * used by Runsight for Garmin).
 *
 * A few non-compliant bridges already send total steps/min. If doubling would
 * exceed a plausible 300 spm, keep the raw value instead of displaying an
 * impossible number. Zero remains an immediate stop signal.
 */
export function normalizeRscCadence(cadenceFootfallsPerMin) {
  if (!Number.isInteger(cadenceFootfallsPerMin)
      || cadenceFootfallsPerMin < 0 || cadenceFootfallsPerMin > 0xff) return null;
  if (cadenceFootfallsPerMin === 0) return 0;
  const doubled = cadenceFootfallsPerMin * 2;
  return doubled <= MAX_PLAUSIBLE_TOTAL_CADENCE_SPM
    ? doubled
    : cadenceFootfallsPerMin;
}

/**
 * flags(uint8): bit0 = 步幅存在(uint16, 0.01m)；bit1 = 累计距离存在(uint32, 0.1m)；
 *               bit2 = 1 跑步 / 0 步行。
 * 必有字段：Instantaneous Speed uint16 (1/256 m/s) + Instantaneous Cadence uint8
 * （佩戴传感器一侧的落地次数/分）。cadenceSpm 是转换后的双脚总步频；
 * cadenceFootfallsPerMin 保留 0x2A53 原始值供诊断。
 * @returns {null | {speedMps:number, speedKmh:number, cadenceSpm:number,
 *                   cadenceFootfallsPerMin:number, cadenceWasDoubled:boolean,
 *                   strideLengthM:number|null, totalDistanceM:number|null, running:boolean}}
 */
export function parseRscMeasurement(value) {
  const bytes = toBytes(value);
  if (!bytes || bytes.length < 4) return null;

  const flags = bytes[0];
  let off = 1;

  const speedMps = u16le(bytes, off) / 256;
  off += 2;
  const cadenceFootfallsPerMin = bytes[off];
  const cadenceSpm = normalizeRscCadence(cadenceFootfallsPerMin);
  off += 1;

  let strideLengthM = null;
  if ((flags & 0x01) !== 0) {
    if (bytes.length < off + 2) return null;
    strideLengthM = u16le(bytes, off) / 100;
    off += 2;
  }

  let totalDistanceM = null;
  if ((flags & 0x02) !== 0) {
    if (bytes.length < off + 4) return null;
    totalDistanceM = u32le(bytes, off) / 10;
    off += 4;
  }

  return {
    speedMps,
    speedKmh: speedMps * 3.6,
    cadenceSpm,
    cadenceFootfallsPerMin,
    cadenceWasDoubled: cadenceFootfallsPerMin > 0
      && cadenceSpm === cadenceFootfallsPerMin * 2,
    strideLengthM,
    totalDistanceM,
    running: (flags & 0x04) !== 0,
  };
}
