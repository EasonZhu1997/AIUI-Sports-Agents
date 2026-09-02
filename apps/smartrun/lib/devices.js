export const HEART_DEVICE_KEY = 'heart_rate_device';

export const DEFAULT_HEART_DEVICE = Object.freeze({
  deviceId: '',
  deviceName: '',
});

const MAX_STORED_DEVICE_NAME = 40;
const MAX_DEVICE_LABEL_UNITS = 12;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function truncateLabel(value, max = MAX_STORED_DEVICE_NAME) {
  const text = cleanString(value);
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function charUnits(char) {
  return char && char.charCodeAt(0) > 0x7f ? 2 : 1;
}

function takeUnits(text, maxUnits, fromEnd = false) {
  const chars = Array.from(text);
  const selected = [];
  let units = 0;
  const indexes = fromEnd
    ? Array.from({ length: chars.length }, (_, index) => chars.length - 1 - index)
    : Array.from({ length: chars.length }, (_, index) => index);
  for (const index of indexes) {
    const next = charUnits(chars[index]);
    if (units + next > maxUnits) break;
    units += next;
    if (fromEnd) selected.unshift(chars[index]);
    else selected.push(chars[index]);
  }
  return selected.join('');
}

/** 固定画布短名称：保留品牌开头和型号结尾，避免 HRM-Pro / HRM-Dual 显示成同名。 */
export function compactDeviceName(value, maxUnits = MAX_DEVICE_LABEL_UNITS) {
  const text = cleanString(value);
  const totalUnits = Array.from(text).reduce((sum, char) => sum + charUnits(char), 0);
  if (totalUnits <= maxUnits) return text;
  const remaining = Math.max(2, maxUnits - 1);
  const headUnits = Math.ceil(remaining * 0.55);
  const tailUnits = remaining - headUnits;
  const head = takeUnits(text, headUnits).trimEnd();
  const tail = takeUnits(text, tailUnits, true).replace(/^[\s-]+/, '');
  return `${head}…${tail}`;
}

export function normalizeHeartRateDevice(value) {
  const src = value && typeof value === 'object' ? value : {};
  return {
    deviceId: cleanString(src.deviceId),
    deviceName: truncateLabel(src.deviceName || src.name || ''),
  };
}

export function readHeartRateDevice(storage) {
  if (!storage || typeof storage.getStorageSync !== 'function') return { ...DEFAULT_HEART_DEVICE };
  try {
    return normalizeHeartRateDevice(storage.getStorageSync(HEART_DEVICE_KEY));
  } catch (_e) {
    return { ...DEFAULT_HEART_DEVICE };
  }
}

export function writeHeartRateDevice(storage, device) {
  const normalized = normalizeHeartRateDevice({
    deviceId: device && (device.deviceId || device.id),
    deviceName: device && (device.deviceName || device.name),
  });
  if (!storage || typeof storage.setStorageSync !== 'function') return normalized;
  try {
    storage.setStorageSync(HEART_DEVICE_KEY, normalized);
  } catch (_e) {}
  return normalized;
}

export function clearHeartRateDevice(storage) {
  if (!storage || typeof storage.removeStorageSync !== 'function') return { ...DEFAULT_HEART_DEVICE };
  try {
    storage.removeStorageSync(HEART_DEVICE_KEY);
  } catch (_e) {}
  return { ...DEFAULT_HEART_DEVICE };
}

export function hasPreferredHeartRateDevice(value) {
  const device = normalizeHeartRateDevice(value);
  return !!(device.deviceId || device.deviceName);
}

export function heartRateDeviceLabel(value) {
  const device = normalizeHeartRateDevice(value);
  return compactDeviceName(device.deviceName) || (device.deviceId ? '已记住' : '自动选择');
}

export function deviceDisplayName(device) {
  return compactDeviceName(device && (device.name || device.deviceName || '心率设备'));
}

export function matchesHeartRateDevice(device, preferred) {
  const pref = normalizeHeartRateDevice(preferred);
  if (!pref.deviceId) return false;
  const id = cleanString(device && (device.id || device.deviceId));
  // 自动连接只认设备页配对时保存的稳定 ID。设备名只用于展示，绝不参与身份
  // 判断；否则附近另一条同型号心率带（例如两条 HRM-Pro）会被误连接。
  return !!(id && pref.deviceId === id);
}
