// 字节工具：AIUI 的 characteristicvaluechanged 给的 value 是 number[]（官方
// heart_rate 样例用 Array.from(value) 处理），所有解析器统一按 array-like 输入。
// 多字节字段一律小端（Bluetooth SIG GATT 规范）。

export function toBytes(value) {
  const bytes = Array.from(value || []);
  for (const b of bytes) {
    if (!Number.isInteger(b) || b < 0 || b > 255) return null;
  }
  return bytes;
}

export function u8(bytes, off) {
  return bytes[off];
}

export function u16le(bytes, off) {
  return bytes[off] | (bytes[off + 1] << 8);
}

export function u24le(bytes, off) {
  return bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16);
}

export function u32le(bytes, off) {
  // >>> 0 避免 bit31 置位时变负数
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

export function s16le(bytes, off) {
  const v = u16le(bytes, off);
  return v >= 0x8000 ? v - 0x10000 : v;
}

// IEEE-11073 16-bit SFLOAT（PLX 血氧/脉率用）：
// 高 4 位有符号指数，低 12 位有符号尾数；特殊值 NaN/NRes/±INF。
export const SFLOAT_NAN = Symbol('SFLOAT_NAN');

export function sfloat16le(bytes, off) {
  const raw = u16le(bytes, off);
  const special = raw & 0x0fff;
  if (special === 0x07ff || special === 0x0800 || special === 0x07fe || special === 0x0802) {
    // NaN / NRes / +INF / -INF —— 对运动 App 全部按"无效读数"处理
    if ((raw & 0xf000) === 0 || special === 0x07ff) return NaN;
  }
  let exponent = raw >> 12;
  if (exponent >= 8) exponent -= 16;
  let mantissa = raw & 0x0fff;
  if (mantissa >= 0x0800) mantissa -= 0x1000;
  if (mantissa === 0x07ff || mantissa === -0x0800 || mantissa === 0x07fe || mantissa === -0x07fe) {
    return NaN;
  }
  return mantissa * Math.pow(10, exponent);
}
