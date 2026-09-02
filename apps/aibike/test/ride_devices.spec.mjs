import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactRideDeviceName,
  matchesRideDevice,
  normalizeRideDevice,
  readRideDevice,
  rideDeviceDisplayName,
  writeRideDevice,
} from '../lib/ride_devices.js';

function memoryStorage() {
  const values = new Map();
  return {
    getStorageSync(key) { return values.get(key); },
    setStorageSync(key, value) { values.set(key, value); },
  };
}

test('ride device keeps only successfully subscribed standard services', () => {
  assert.deepEqual(normalizeRideDevice({
    id: 'sensor-1',
    name: 'Garmin HR + CSC',
    services: ['hrs', 'csc', 'csc', 'unsupported'],
  }), {
    deviceId: 'sensor-1',
    deviceName: 'Garmin HR + CSC',
    services: ['hrs', 'csc'],
  });
});

test('ride device identity uses stable ID, never a matching display name', () => {
  const preferred = normalizeRideDevice({ id: 'one', name: '相同型号' });
  assert.equal(matchesRideDevice({ id: 'one', name: '别名' }, preferred), true);
  assert.equal(matchesRideDevice({ id: 'two', name: '相同型号' }, preferred), false);
});

test('ride device storage and compact wearable label', () => {
  const storage = memoryStorage();
  const stored = writeRideDevice(storage, {
    id: 'bike-2',
    name: 'Garmin Cycling Sensor Professional',
    services: ['hrs', 'csc'],
  });
  assert.deepEqual(readRideDevice(storage), stored);
  assert.ok(compactRideDeviceName(stored.deviceName).includes('…'));
  assert.equal(rideDeviceDisplayName({ name: '迈金 S3+' }), '迈金 S3+');
});
