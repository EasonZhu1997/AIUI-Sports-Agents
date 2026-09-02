export const RIDE_DEVICE_KEY = 'aibike_sensor_device_v1';

export const RIDE_SERVICES = Object.freeze([
  'hrs',
  'csc',
  'cps',
  'ftms',
]);

const MAX_NAME_CHARS = 40;
const MAX_LABEL_UNITS = 12;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeServices(value) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(RIDE_SERVICES);
  return [...new Set(value.map(clean).filter((item) => allowed.has(item)))];
}

export function normalizeRideDevice(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    deviceId: clean(source.deviceId || source.id),
    deviceName: clean(source.deviceName || source.name).slice(0, MAX_NAME_CHARS),
    services: normalizeServices(source.services),
  };
}

export function readRideDevice(storage) {
  if (!storage || typeof storage.getStorageSync !== 'function') {
    return normalizeRideDevice(null);
  }
  try {
    return normalizeRideDevice(storage.getStorageSync(RIDE_DEVICE_KEY));
  } catch (_error) {
    return normalizeRideDevice(null);
  }
}

export function writeRideDevice(storage, device) {
  const normalized = normalizeRideDevice(device);
  if (!storage || typeof storage.setStorageSync !== 'function') return normalized;
  try {
    storage.setStorageSync(RIDE_DEVICE_KEY, normalized);
  } catch (_error) {}
  return normalized;
}

export function clearRideDevice(storage) {
  try {
    if (storage && typeof storage.removeStorageSync === 'function') {
      storage.removeStorageSync(RIDE_DEVICE_KEY);
    }
  } catch (_error) {}
  return normalizeRideDevice(null);
}

export function matchesRideDevice(device, preferred) {
  const candidateId = clean(device && (device.id || device.deviceId));
  const stored = normalizeRideDevice(preferred);
  return !!(candidateId && stored.deviceId && candidateId === stored.deviceId);
}

function charUnits(character) {
  return character && character.charCodeAt(0) > 0x7f ? 2 : 1;
}

function takeUnits(value, maxUnits, fromEnd = false) {
  const characters = Array.from(value);
  const indexes = fromEnd
    ? characters.map((_item, index) => characters.length - 1 - index)
    : characters.map((_item, index) => index);
  const selected = [];
  let used = 0;
  for (const index of indexes) {
    const units = charUnits(characters[index]);
    if (used + units > maxUnits) break;
    used += units;
    if (fromEnd) selected.unshift(characters[index]);
    else selected.push(characters[index]);
  }
  return selected.join('');
}

export function compactRideDeviceName(value, maxUnits = MAX_LABEL_UNITS) {
  const text = clean(value);
  const units = Array.from(text).reduce((sum, character) => sum + charUnits(character), 0);
  if (units <= maxUnits) return text;
  const remaining = Math.max(2, maxUnits - 1);
  const headUnits = Math.ceil(remaining * 0.55);
  const tailUnits = remaining - headUnits;
  const head = takeUnits(text, headUnits).trimEnd();
  const tail = takeUnits(text, tailUnits, true).replace(/^[\s-]+/, '');
  return `${head}…${tail}`;
}

export function rideDeviceDisplayName(device) {
  return compactRideDeviceName(
    device && (device.name || device.deviceName || '骑行传感器'),
  );
}
