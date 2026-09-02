import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginInternalSurfaceNavigation,
  clearRideFinishedHint,
  completeHomeResume,
  consumeRideFinishedHint,
  consumeScanExitHint,
  markHostBackspaceIntent,
  RIDE_FINISHED_HINT_KEY,
  writeRideFinishedHint,
  writeScanExitHint,
} from '../lib/ride_surface.js';

function memoryStorage() {
  const values = new Map();
  return {
    getStorageSync(key) { return values.get(key); },
    setStorageSync(key, value) { values.set(key, value); },
    removeStorageSync(key) { values.delete(key); },
  };
}

test('ride surface keeps scan back handoff fresh and one-shot', () => {
  const storage = memoryStorage();
  writeScanExitHint(storage, 1000);
  assert.equal(consumeScanExitHint(storage, 3000, 3999), true);
  assert.equal(consumeScanExitHint(storage, 3000, 3999), false);
});

test('ride-finished and navigation hints never carry device identity', () => {
  const storage = memoryStorage();
  assert.equal(markHostBackspaceIntent(storage, 'ride-hud'), true);
  beginInternalSurfaceNavigation(storage);
  completeHomeResume(storage);
  assert.equal(writeRideFinishedHint(storage, 5000), true);
  assert.equal(consumeRideFinishedHint(storage, 60000, 10000), true);
  assert.equal(writeRideFinishedHint(storage, 6000), true);
  clearRideFinishedHint(storage);
  assert.equal(consumeRideFinishedHint(storage, 60000, 10000), false);
});

test('ride-finished hint fails closed unless storage write is read back exactly', () => {
  const throwing = memoryStorage();
  throwing.setStorageSync = () => { throw new Error('quota'); };
  assert.equal(writeRideFinishedHint(throwing, 5000), false);

  const silent = memoryStorage();
  silent.setStorageSync = () => {};
  assert.equal(writeRideFinishedHint(silent, 5000), false);
  assert.equal(silent.getStorageSync(RIDE_FINISHED_HINT_KEY), undefined);

  const unreadable = memoryStorage();
  unreadable.getStorageSync = () => { throw new Error('read failed'); };
  assert.equal(writeRideFinishedHint(unreadable, 5000), false);
});
