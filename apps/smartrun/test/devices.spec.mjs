import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HEART_DEVICE,
  HEART_DEVICE_KEY,
  clearHeartRateDevice,
  compactDeviceName,
  deviceDisplayName,
  heartRateDeviceLabel,
  matchesHeartRateDevice,
  normalizeHeartRateDevice,
  readHeartRateDevice,
  writeHeartRateDevice,
} from '../lib/devices.js';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getStorageSync(key) { return map.get(key); },
    setStorageSync(key, value) { map.set(key, value); },
    removeStorageSync(key) { map.delete(key); },
  };
}

test('heart-rate device preference normalizes and labels compactly', () => {
  assert.deepEqual(normalizeHeartRateDevice(null), DEFAULT_HEART_DEVICE);
  assert.deepEqual(normalizeHeartRateDevice({
    deviceId: 'dev-1',
    deviceName: 'Garmin HRM-Pro Plus',
  }), {
    deviceId: 'dev-1',
    deviceName: 'Garmin HRM-Pro Plus',
  });
  assert.equal(heartRateDeviceLabel({ deviceName: 'Polar H10' }), 'Polar H10');
  assert.equal(heartRateDeviceLabel({ deviceId: 'abc' }), '已记住');
  assert.equal(heartRateDeviceLabel(null), '自动选择');
  assert.equal(deviceDisplayName({ name: 'COROS Heart Rate Monitor' }), 'COROS H…itor');
  assert.equal(compactDeviceName('Garmin HRM-Pro Plus'), 'Garmin…Plus');
  assert.equal(compactDeviceName('Garmin HRM-Dual'), 'Garmin…Dual');
});

test('heart-rate device preference roundtrips and clears through storage', () => {
  const storage = fakeStorage();
  const saved = writeHeartRateDevice(storage, { id: 'hr-1', name: 'Polar H10' });
  assert.deepEqual(saved, { deviceId: 'hr-1', deviceName: 'Polar H10' });
  assert.deepEqual(readHeartRateDevice(storage), saved);
  assert.deepEqual(clearHeartRateDevice(storage), DEFAULT_HEART_DEVICE);
  assert.equal(storage.getStorageSync(HEART_DEVICE_KEY), undefined);
});

test('preferred heart-rate matching requires the exact stable device id', () => {
  assert.equal(matchesHeartRateDevice({ id: 'x' }, null), false);
  assert.equal(matchesHeartRateDevice({ id: 'hr-1', name: 'A' }, { deviceId: 'hr-1' }), true);
  assert.equal(matchesHeartRateDevice({ id: 'hr-2', name: 'Polar H10' }, { deviceName: 'Polar H10' }), false);
  assert.equal(matchesHeartRateDevice({ id: 'hr-2', name: 'Other' }, { deviceId: 'hr-1' }), false);
  assert.equal(
    matchesHeartRateDevice(
      { id: 'neighbor-2', name: 'Garmin HRM' },
      { deviceId: 'mine-1', deviceName: 'Garmin HRM' },
    ),
    false,
    '两台同型号设备都有 ID 时不得退回名称匹配',
  );
  assert.equal(
    matchesHeartRateDevice(
      { name: 'Garmin HRM' },
      { deviceId: 'mine-1', deviceName: 'Garmin HRM' },
    ),
    false,
    '候选没有 ID 时即使同名也不得自动连接',
  );
});
