import assert from 'node:assert/strict';
import test from 'node:test';
import { HeartRateSession } from '../lib/heart_rate_session.js';
import {
  HEART_RATE_MEASUREMENT_UUID,
  HEART_RATE_SERVICE_UUID,
} from '../lib/hr.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function createCharacteristic({
  properties = { notify: true },
  start = null,
  stop = null,
} = {}) {
  const listeners = new Set();
  const characteristic = {
    value: null,
    properties,
    startCount: 0,
    stopCount: 0,
    startNotifications() {
      this.startCount += 1;
      if (start) return start(this);
      return Promise.resolve(this);
    },
    stopNotifications() {
      this.stopCount += 1;
      if (stop) return stop(this);
      return Promise.resolve(this);
    },
    addEventListener(name, listener) {
      if (name === 'characteristicvaluechanged') listeners.add(listener);
    },
    removeEventListener(name, listener) {
      if (name === 'characteristicvaluechanged') listeners.delete(listener);
    },
    emit(value) {
      this.value = value;
      for (const listener of [...listeners]) {
        listener({ target: { value } });
      }
    },
    listenerCount() { return listeners.size; },
  };
  return characteristic;
}

function createFixture({ characteristic = createCharacteristic(), service = null } = {}) {
  const resolvedService = service || {
    async getCharacteristic(uuid) {
      assert.equal(uuid, HEART_RATE_MEASUREMENT_UUID);
      return characteristic;
    },
  };
  const deviceListeners = new Set();
  const gatt = {
    connected: false,
    connectCount: 0,
    disconnectCount: 0,
    async connect() {
      this.connectCount += 1;
      this.connected = true;
      return this;
    },
    async disconnect() {
      this.disconnectCount += 1;
      this.connected = false;
    },
    async getPrimaryService(uuid) {
      assert.equal(uuid, HEART_RATE_SERVICE_UUID);
      return resolvedService;
    },
  };
  const device = {
    id: 'opaque-hrs-object',
    name: 'Heart Strap',
    gatt,
    addEventListener(name, listener) {
      if (name === 'gattserverdisconnected') deviceListeners.add(listener);
    },
    removeEventListener(name, listener) {
      if (name === 'gattserverdisconnected') deviceListeners.delete(listener);
    },
    emitDisconnect() {
      gatt.connected = false;
      for (const listener of [...deviceListeners]) listener();
    },
    disconnectListenerCount() { return deviceListeners.size; },
  };
  return { characteristic, service: resolvedService, device, gatt };
}

async function withBluetooth(bluetooth, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { bluetooth },
  });
  try {
    return await callback();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  }
}

test('scan is explicit, service-filtered and candidate selection is a separate action', async () => {
  const found = [];
  const scanListeners = new Set();
  const scan = {
    stopped: false,
    onDeviceFound(listener) { scanListeners.add(listener); },
    offDeviceFound(listener) { scanListeners.delete(listener); },
    stop() { this.stopped = true; },
    emit(device) {
      for (const listener of [...scanListeners]) listener({ device });
    },
  };
  const fixture = createFixture();
  await withBluetooth({
    async getAvailability() { return true; },
    async scanDevices(options) {
      assert.deepEqual(options, {
        filters: [{ services: [HEART_RATE_SERVICE_UUID] }],
      });
      return scan;
    },
  }, async () => {
    const session = new HeartRateSession();
    await session.beginScan((device) => found.push(device));
    scan.emit(fixture.device);
    assert.deepEqual(found, [fixture.device]);
    assert.equal(session.selectedDevice, null);
    assert.equal(session.stopScan('selection_ready'), true);
    scan.emit(createFixture().device);
    assert.deepEqual(found, [fixture.device]);
    await assert.rejects(
      () => session.connect(fixture.device),
      /USER_SELECTION_REQUIRED/,
    );
    await session.connect(fixture.device, { userAuthorized: true });
    assert.equal(scan.stopped, true);
    assert.equal(session.selectedDevice, fixture.device);
    await session.cleanup('test');
  });
});

test('subscription is not liveness; first legal measurement starts a five-second window', async () => {
  let now = 1000;
  const states = [];
  const measurements = [];
  const { device, characteristic } = createFixture();
  const session = new HeartRateSession({
    now: () => now,
    onState: (state) => states.push(state.stage),
    onMeasurement: (measurement) => measurements.push(measurement),
  });
  await session.connect(device, { userAuthorized: true });
  assert.equal(session.streamState(now), 'subscribed_silent');
  characteristic.emit([0x01, 0x48]);
  assert.equal(session.streamState(now), 'subscribed_silent');
  characteristic.emit([0x00, 72]);
  assert.equal(session.streamState(now), 'live');
  assert.equal(measurements.length, 1);
  assert.deepEqual(
    states.filter((stage) => ['SUBSCRIBED', 'FIRST_VALID_PACKET', 'STREAM_LIVE'].includes(stage)),
    ['SUBSCRIBED', 'FIRST_VALID_PACKET', 'STREAM_LIVE'],
  );
  now += 5000;
  assert.equal(session.streamState(now), 'live');
  now += 1;
  assert.equal(session.streamState(now), 'stale');
  await session.cleanup('test');
});

test('early notification preserves monotonic milestones before subscribe promise settles', async () => {
  let now = 2000;
  const startGate = deferred();
  const characteristic = createCharacteristic({
    start: () => startGate.promise,
  });
  const { device } = createFixture({ characteristic });
  const states = [];
  const session = new HeartRateSession({
    now: () => now,
    onState: (state) => states.push(state.stage),
  });
  const connecting = session.connect(device, { userAuthorized: true });
  await waitFor(() => characteristic.listenerCount() === 1);
  characteristic.emit([0x00, 81]);
  assert.equal(session.streamState(now), 'live');
  startGate.resolve(characteristic);
  await connecting;
  assert.equal(session.streamState(now), 'live');
  assert.deepEqual(
    states.filter((stage) => ['SUBSCRIBED', 'FIRST_VALID_PACKET', 'STREAM_LIVE'].includes(stage)),
    ['SUBSCRIBED', 'FIRST_VALID_PACKET', 'STREAM_LIVE'],
  );
  await session.cleanup('test');
});

test('poor contact is a legal packet but never a usable live value', async () => {
  const measurements = [];
  const { device, characteristic } = createFixture();
  const session = new HeartRateSession({
    onMeasurement: (measurement) => measurements.push(measurement),
  });
  await session.connect(device, { userAuthorized: true });
  characteristic.emit([0x04, 76]);
  assert.equal(session.streamState(), 'contact_poor');
  assert.equal(session.firstValidAtMs != null, true);
  assert.equal(session.lastUsableAtMs, null);
  assert.equal(measurements[0].contactDetected, false);
  await session.cleanup('test');
});

test('initial identity commits only after required service and Notify validation', async () => {
  const characteristic = createCharacteristic({ properties: { notify: false } });
  const { device, gatt } = createFixture({ characteristic });
  const session = new HeartRateSession();
  await assert.rejects(
    () => session.connect(device, { userAuthorized: true }),
    /MEASUREMENT_NOT_NOTIFIABLE/,
  );
  assert.equal(session.selectedDevice, null);
  assert.equal(session.selectedByUser, false);
  assert.equal(gatt.connected, false);
});

test('physical disconnect during setup invalidates late characteristic completion', async () => {
  const characteristicGate = deferred();
  const characteristic = createCharacteristic();
  const service = {
    getCharacteristic() { return characteristicGate.promise; },
  };
  const { device } = createFixture({ characteristic, service });
  const session = new HeartRateSession();
  const connecting = session.connect(device, { userAuthorized: true });
  await waitFor(() => device.disconnectListenerCount() === 1);
  device.emitDisconnect();
  characteristicGate.resolve(characteristic);
  await assert.rejects(() => connecting, /STALE_OPERATION/);
  assert.equal(characteristic.listenerCount(), 0);
  assert.equal(session.selectedDevice, null);
  assert.equal(session.streamState(), 'disconnected');
});

test('a connect result arriving after cancellation is disconnected and cannot commit identity', async () => {
  const connectGate = deferred();
  const fixture = createFixture();
  fixture.gatt.connect = function connect() {
    this.connectCount += 1;
    return connectGate.promise;
  };
  const session = new HeartRateSession();
  const connecting = session.connect(fixture.device, { userAuthorized: true });
  await waitFor(() => fixture.gatt.connectCount === 1);
  await session.cleanup('cancel_setup');
  connectGate.resolve(fixture.gatt);
  await assert.rejects(() => connecting, /STALE_OPERATION/);
  await waitFor(() => fixture.gatt.disconnectCount === 1);
  assert.equal(session.selectedDevice, null);
  assert.equal(session.connectionDevice, null);
});

test('suspend preserves only the explicitly selected object for reconnect', async () => {
  const fixture = createFixture();
  const other = createFixture().device;
  const session = new HeartRateSession();
  await session.connect(fixture.device, { userAuthorized: true });
  await session.suspend('hidden');
  assert.equal(session.selectedDevice, fixture.device);
  assert.equal(session.selectedByUser, true);
  await assert.rejects(() => session.reconnect(other), /RECONNECT_TARGET_MISMATCH/);
  await session.reconnect(fixture.device);
  assert.equal(fixture.gatt.connectCount, 2);
  await session.cleanup('end');
  assert.equal(session.selectedDevice, null);
});

test('a failed reconnect keeps the same in-memory target without starting a scan', async () => {
  const fixture = createFixture();
  const session = new HeartRateSession();
  await session.connect(fixture.device, { userAuthorized: true });
  await session.suspend('hidden');
  fixture.characteristic.properties.notify = false;
  await assert.rejects(
    () => session.reconnect(fixture.device),
    /MEASUREMENT_NOT_NOTIFIABLE/,
  );
  assert.equal(session.selectedDevice, fixture.device);
  assert.equal(session.selectedByUser, true);
  assert.equal(fixture.gatt.connected, false);
  await session.cleanup('end');
});

test('unexpected disconnect retains the committed target but drops all live resources', async () => {
  const { device, characteristic } = createFixture();
  const states = [];
  const session = new HeartRateSession({
    onState: (state) => states.push(state.stage),
  });
  await session.connect(device, { userAuthorized: true });
  characteristic.emit([0x00, 70]);
  assert.equal(session.handlePhysicalDisconnect(device), true);
  assert.equal(session.handlePhysicalDisconnect(device), false);
  assert.equal(session.selectedDevice, device);
  assert.equal(session.connectionDevice, null);
  assert.equal(characteristic.listenerCount(), 0);
  assert.equal(device.disconnectListenerCount(), 0);
  assert.equal(session.streamState(), 'disconnected');
  assert.equal(states.at(-1), 'GATT_DISCONNECTED');
  await session.reconnect(device);
  await session.cleanup('end');
});

test('cleanup is bounded, idempotent and invalidates notifications synchronously', async () => {
  const never = new Promise(() => {});
  const characteristic = createCharacteristic({ stop: () => never });
  const { device, gatt } = createFixture({ characteristic });
  gatt.disconnect = async function disconnect() {
    this.disconnectCount += 1;
    return never;
  };
  const session = new HeartRateSession({ cleanupTimeoutMs: 20 });
  await session.connect(device, { userAuthorized: true });
  const startedAt = Date.now();
  const first = session.cleanup('exit');
  const second = session.cleanup('again');
  assert.equal(characteristic.listenerCount(), 0);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.ok(Date.now() - startedAt < 250);
  assert.equal(characteristic.stopCount, 1);
  assert.equal(gatt.disconnectCount, 1);
  assert.equal(session.streamState(), 'disconnected');
  assert.equal(session.selectedDevice, null);
});

test('a scan that resolves after timeout is stopped and cannot publish candidates', async () => {
  const scanGate = deferred();
  const listeners = new Set();
  const scan = {
    stopped: false,
    onDeviceFound(listener) { listeners.add(listener); },
    offDeviceFound(listener) { listeners.delete(listener); },
    stop() { this.stopped = true; },
  };
  await withBluetooth({
    async getAvailability() { return true; },
    scanDevices() { return scanGate.promise; },
  }, async () => {
    const session = new HeartRateSession({ operationTimeoutMs: 10 });
    await assert.rejects(() => session.beginScan(), /SCAN_TIMEOUT/);
    scanGate.resolve(scan);
    await waitFor(() => scan.stopped === true);
    assert.equal(scan.stopped, true);
    assert.equal(listeners.size, 0);
  });
});

test('a late old scan result cannot stop a newer same-object scan', async () => {
  const firstScan = deferred();
  let scanCalls = 0;
  let stopCalls = 0;
  const scan = {
    onDeviceFound() {},
    offDeviceFound() {},
    stop() { stopCalls += 1; },
  };
  await withBluetooth({
    async getAvailability() { return true; },
    scanDevices() {
      scanCalls += 1;
      return scanCalls === 1 ? firstScan.promise : Promise.resolve(scan);
    },
  }, async () => {
    const session = new HeartRateSession({ operationTimeoutMs: 8 });
    await assert.rejects(() => session.beginScan(() => {}), /SCAN_TIMEOUT/);
    await session.beginScan(() => {});
    assert.equal(session.streamState(), 'scanning');
    firstScan.resolve(scan);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stopCalls, 0);
    assert.equal(session.scan, scan);
    assert.equal(session.streamState(), 'scanning');
    await session.cleanup('test');
    assert.equal(stopCalls, 1);
  });
});

test('suspend invalidates a scan intent waiting behind an existing cleanup', async () => {
  const cleanupGate = deferred();
  let scanCalls = 0;
  await withBluetooth({
    async getAvailability() { return true; },
    async scanDevices() {
      scanCalls += 1;
      return { onDeviceFound() {}, offDeviceFound() {}, stop() {} };
    },
  }, async () => {
    const session = new HeartRateSession({ cleanupTimeoutMs: 5000 });
    const oldGatt = {
      connected: true,
      disconnect() { return cleanupGate.promise; },
    };
    session.gatt = oldGatt;
    session.connectionDevice = { gatt: oldGatt };
    const resetting = session.cleanup('reset');
    const scanning = session.beginScan(() => {});
    const hiding = session.suspend('hidden');
    cleanupGate.resolve();
    await Promise.all([resetting, hiding]);
    await assert.rejects(() => scanning, /STALE_OPERATION/);
    assert.equal(scanCalls, 0);
    assert.equal(session.scan, null);
    assert.equal(session.streamState(), 'disconnected');
  });
});

test('a second suspend invalidates reconnect waiting behind the first suspend', async () => {
  const cleanupGate = deferred();
  const { device, gatt } = createFixture();
  const session = new HeartRateSession({ cleanupTimeoutMs: 5000 });
  session.selectedDevice = device;
  session.selectedByUser = true;
  session.connectionDevice = device;
  session.gatt = gatt;
  gatt.connected = true;
  gatt.disconnect = () => cleanupGate.promise;

  const firstHide = session.suspend('hidden_1');
  const reconnecting = session.reconnect(device);
  const secondHide = session.suspend('hidden_2');
  cleanupGate.resolve();

  await Promise.all([firstHide, secondHide]);
  await assert.rejects(() => reconnecting, /STALE_OPERATION/);
  assert.equal(gatt.connectCount, 0);
  assert.equal(session.gatt, null);
  assert.equal(session.streamState(), 'disconnected');
});

test('stopScan also cancels a native scan that has not resolved yet', async () => {
  const scanGate = deferred();
  let scanCalls = 0;
  const scan = {
    stopped: false,
    onDeviceFound() {},
    offDeviceFound() {},
    stop() { this.stopped = true; },
  };
  await withBluetooth({
    async getAvailability() { return true; },
    scanDevices() {
      scanCalls += 1;
      return scanGate.promise;
    },
  }, async () => {
    const session = new HeartRateSession();
    const scanning = session.beginScan();
    await waitFor(() => scanCalls === 1);
    assert.equal(session.stopScan('page_leave'), true);
    scanGate.resolve(scan);
    await assert.rejects(() => scanning, /STALE_OPERATION/);
    await waitFor(() => scan.stopped === true);
    assert.equal(session.streamState(), 'disconnected');
  });
});
