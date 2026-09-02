import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  FTMS_FEATURE_UUID,
  FTMS_ROWER_DATA_UUID,
  FTMS_SERVICE_UUID,
} from '../lib/ftms_rower.js';
import { FtmsRowerSession } from '../lib/ftms_session.js';

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

function characteristic({
  value = [],
  properties = {},
  startNotifications,
  stopNotifications,
} = {}) {
  const listeners = new Set();
  return {
    value,
    properties,
    async readValue() { return this.value; },
    async startNotifications() {
      if (startNotifications) return startNotifications();
      return this;
    },
    async stopNotifications() {
      if (stopNotifications) return stopNotifications();
      return this;
    },
    addEventListener(name, listener) {
      if (name === 'characteristicvaluechanged') listeners.add(listener);
    },
    removeEventListener(name, listener) {
      if (name === 'characteristicvaluechanged') listeners.delete(listener);
    },
    emit(next) {
      this.value = next;
      for (const listener of [...listeners]) listener({ target: this });
    },
    listenerCount() { return listeners.size; },
  };
}

function harness(options = {}) {
  const feature = characteristic({
    value: options.featureValue || [0xa6, 0x7e, 0, 0, 0, 0, 0, 0],
    properties: { read: options.featureReadable !== false },
  });
  const rower = characteristic({
    properties: options.rowerProperties || { notify: true },
    startNotifications: options.startNotifications,
    stopNotifications: options.stopNotifications,
  });
  const service = {
    async getCharacteristic(uuid) {
      if (uuid === FTMS_FEATURE_UUID) return feature;
      if (uuid === FTMS_ROWER_DATA_UUID) return rower;
      throw new Error('missing characteristic');
    },
  };
  let connectCount = 0;
  let disconnectCount = 0;
  const deviceListeners = new Map();
  const gatt = {
    connected: false,
    async connect() {
      connectCount += 1;
      if (options.connectNever === true) return new Promise(() => {});
      this.connected = true;
      return this;
    },
    async disconnect() {
      disconnectCount += 1;
      if (options.disconnectNever === true) return new Promise(() => {});
      this.connected = false;
    },
    async getPrimaryService(uuid) {
      assert.equal(uuid, FTMS_SERVICE_UUID);
      if (options.serviceNever === true) return new Promise(() => {});
      return service;
    },
  };
  const device = {
    id: 'opaque-rower-id',
    name: 'Private Rower Name',
    gatt,
    addEventListener(name, listener) { deviceListeners.set(name, listener); },
    removeEventListener(name, listener) {
      if (deviceListeners.get(name) === listener) deviceListeners.delete(name);
    },
    emitDisconnect() {
      gatt.connected = false;
      const listener = deviceListeners.get('gattserverdisconnected');
      if (listener) listener({ target: device });
    },
  };
  let scanCount = 0;
  let scanStopCount = 0;
  let foundListener = null;
  const scan = {
    onDeviceFound(listener) { foundListener = listener; },
    offDeviceFound(listener) { if (foundListener === listener) foundListener = null; },
    stop() { scanStopCount += 1; },
  };
  const bluetooth = {
    async getAvailability() { return options.available !== false; },
    async scanDevices(request) {
      scanCount += 1;
      assert.deepEqual(request, { filters: [{ services: [FTMS_SERVICE_UUID] }] });
      return scan;
    },
  };
  return {
    bluetooth,
    device,
    feature,
    rower,
    gatt,
    emitCandidate() { if (foundListener) foundListener({ device }); },
    get scanCount() { return scanCount; },
    get scanStopCount() { return scanStopCount; },
    get connectCount() { return connectCount; },
    get disconnectCount() { return disconnectCount; },
    get disconnectListenerCount() { return deviceListeners.size; },
  };
}

test('scan only reports candidates and never connects automatically', async () => {
  const env = harness();
  await withBluetooth(env.bluetooth, async () => {
    const candidates = [];
    const states = [];
    const session = new FtmsRowerSession({ onState: (state) => states.push(state.stage) });
    await session.beginScan((device) => candidates.push(device));
    assert.equal(env.scanCount, 1);
    assert.equal(env.connectCount, 0);
    env.emitCandidate();
    assert.deepEqual(candidates, [env.device]);
    assert.equal(env.connectCount, 0);
    assert.ok(states.includes('DEVICE_FOUND'));
    assert.equal(session.streamState(), 'scanning');
    await session.cleanup('test');
    assert.equal(env.scanStopCount, 1);
  });
});

test('streamState exposes the fixed idle-to-live validation chain', async () => {
  const connectGate = deferred();
  const subscriptionGate = deferred();
  let connectStarted = false;
  let subscriptionStarted = false;
  const env = harness({
    startNotifications() {
      subscriptionStarted = true;
      return subscriptionGate.promise;
    },
  });
  env.gatt.connect = function connect() {
    connectStarted = true;
    return connectGate.promise;
  };
  await withBluetooth(env.bluetooth, async () => {
    let now = 1000;
    const session = new FtmsRowerSession({
      now: () => now,
      operationTimeoutMs: 1000,
    });
    const observed = [session.streamState(now)];

    await session.beginScan(() => {});
    observed.push(session.streamState(now));
    const connecting = session.connect(env.device, { userAuthorized: true });
    await waitFor(() => connectStarted);
    observed.push(session.streamState(now));

    env.gatt.connected = true;
    connectGate.resolve(env.gatt);
    await waitFor(() => subscriptionStarted);
    observed.push(session.streamState(now));

    subscriptionGate.resolve(env.rower);
    await connecting;
    observed.push(session.streamState(now));
    env.rower.emit([0x00, 0x00, 48, 1, 0]);
    observed.push(session.streamState(now));
    now += 3501;
    observed.push(session.streamState(now));
    await session.cleanup('terminal');
    observed.push(session.streamState(now));

    assert.deepEqual(observed, [
      'idle',
      'scanning',
      'connecting',
      'validating',
      'subscribed_silent',
      'live',
      'stale',
      'idle',
    ]);
  });
});

test('connect requires an explicit user-authorized device selection', async () => {
  const env = harness();
  const session = new FtmsRowerSession();
  await assert.rejects(() => session.connect(env.device), /USER_SELECTION_REQUIRED/);
  await session.cleanup('test');
});

test('initial device ownership is committed atomically only after setup succeeds', async () => {
  const subscription = deferred();
  let subscriptionStarted = false;
  const env = harness({
    startNotifications() {
      subscriptionStarted = true;
      return subscription.promise;
    },
  });
  await withBluetooth(env.bluetooth, async () => {
    const session = new FtmsRowerSession({ operationTimeoutMs: 1000 });
    const connecting = session.connect(env.device, { userAuthorized: true });
    await waitFor(() => subscriptionStarted);
    assert.equal(session.selectedDevice, null);
    assert.equal(session.selectedByUser, false);
    assert.equal(session.connectingDevice, env.device);

    subscription.resolve(env.rower);
    await connecting;
    assert.equal(session.selectedDevice, env.device);
    assert.equal(session.selectedByUser, true);
    assert.equal(session.connectingDevice, null);
    await session.cleanup('test');
  });
});

test('SUBSCRIBED is silent until a complete mandatory final record arrives', async () => {
  const env = harness();
  await withBluetooth(env.bluetooth, async () => {
    const states = [];
    const records = [];
    let now = 1000;
    const session = new FtmsRowerSession({
      onState: (state) => states.push(state.stage),
      onRecord: (record) => records.push(record),
      now: () => now,
    });
    await session.beginScan(() => {});
    await session.connect(env.device, { userAuthorized: true });
    assert.equal(session.streamState(now), 'subscribed_silent');
    assert.ok(states.includes('SUBSCRIBED'));
    assert.equal(states.includes('FIRST_VALID_PACKET'), false);

    env.rower.emit([0x05, 0x00, 10, 0, 0]);
    assert.equal(session.streamState(now), 'subscribed_silent');
    assert.equal(records.length, 0);
    now += 100;
    env.rower.emit([0x00, 0x00, 48, 2, 0]);
    assert.equal(records.length, 1);
    assert.equal(records[0].fields.strokeRateSpm, 24);
    assert.equal(records[0].fields.strokeCount, 2);
    assert.equal(records[0].fields.totalDistanceM, 10);
    assert.equal(session.streamState(now), 'live');
    assert.ok(states.includes('FIRST_VALID_PACKET'));
    now += 3501;
    assert.equal(session.streamState(now), 'stale');
    await session.cleanup('test');
  });
});

test('an optional field without its Feature bit cannot establish liveness', async () => {
  const env = harness({ featureValue: [0, 0, 0, 0, 0, 0, 0, 0] });
  await withBluetooth(env.bluetooth, async () => {
    const states = [];
    const records = [];
    const session = new FtmsRowerSession({
      onState: (state) => states.push(state),
      onRecord: (record) => records.push(record),
      now: () => 1000,
    });
    await session.connect(env.device, { userAuthorized: true });
    env.rower.emit([0x05, 0x00, 10, 0, 0]);
    env.rower.emit([0x00, 0x00, 48, 2, 0]);
    assert.equal(records.length, 0);
    assert.equal(session.streamState(1000), 'subscribed_silent');
    assert.ok(states.some((state) => state.stage === 'PACKET_INVALID'
      && state.reason === 'FEATURE_MISSING_totalDistanceM'));

    env.rower.emit([0x00, 0x00, 48, 3, 0]);
    assert.equal(records.length, 1);
    assert.equal(session.streamState(1000), 'live');
    await session.cleanup('test');
  });
});

test('an out-of-range appeared field rejects the whole data set and does not refresh live', async () => {
  const env = harness();
  await withBluetooth(env.bluetooth, async () => {
    let now = 1000;
    const states = [];
    const records = [];
    const session = new FtmsRowerSession({
      onState: (state) => states.push(state),
      onRecord: (record) => records.push(record),
      now: () => now,
    });
    await session.connect(env.device, { userAuthorized: true });
    env.rower.emit([0x00, 0x00, 48, 1, 0]);
    assert.equal(records.length, 1);
    assert.equal(session.lastValidAtMs, 1000);

    now = 2000;
    env.rower.emit([
      0x28, 0x02,
      48, 2, 0,
      0xff, 0xff,
      0xff, 0x7f,
      0xff,
    ]);
    assert.equal(records.length, 1);
    assert.equal(session.lastValidAtMs, 1000);
    assert.ok(states.some((state) => state.stage === 'PACKET_INVALID'
      && state.reason === 'FIELD_RANGE_instantaneousPaceSecPer500m'));
    now = 4501;
    assert.equal(session.streamState(now), 'stale');
    await session.cleanup('test');
  });
});

test('a notification stream without its first record becomes distinctly silent', async () => {
  const env = harness();
  await withBluetooth(env.bluetooth, async () => {
    let now = 1000;
    const session = new FtmsRowerSession({ now: () => now, firstPacketSilentMs: 10000 });
    await session.beginScan(() => {});
    await session.connect(env.device, { userAuthorized: true });
    now = 11000;
    assert.equal(session.streamState(now), 'subscribed_silent');
    now = 11001;
    assert.equal(session.streamState(now), 'silent');
    await session.cleanup('test');
  });
});

test('an early notification publishes SUBSCRIBED before LIVE without state rollback', async () => {
  const env = harness();
  env.rower.startNotifications = async function startNotificationsWithPacket() {
    this.emit([0x00, 0x00, 48, 2, 0]);
    return this;
  };
  await withBluetooth(env.bluetooth, async () => {
    const states = [];
    const session = new FtmsRowerSession({
      onState: (state) => states.push(state.stage),
      now: () => 1000,
    });
    await session.beginScan(() => {});
    await session.connect(env.device, { userAuthorized: true });
    assert.equal(session.streamState(1000), 'live');
    assert.ok(states.indexOf('SUBSCRIBED') < states.indexOf('FIRST_VALID_PACKET'));
    assert.ok(states.indexOf('FIRST_VALID_PACKET') < states.indexOf('STREAM_LIVE'));
    assert.equal(states.filter((stage) => stage === 'SUBSCRIBED').length, 1);
    await session.cleanup('test');
  });
});

test('Rower Data strictly requires Notify and rejects indicate-only', async () => {
  const env = harness({ rowerProperties: { indicate: true } });
  await withBluetooth(env.bluetooth, async () => {
    const session = new FtmsRowerSession({ cleanupTimeoutMs: 10 });
    await session.beginScan(() => {});
    await assert.rejects(
      () => session.connect(env.device, { userAuthorized: true }),
      /ROWER_DATA_NOT_NOTIFIABLE/,
    );
    assert.equal(session.streamState(), 'idle');
    assert.equal(session.selectedDevice, null);
    assert.equal(session.selectedByUser, false);
    assert.equal(session.connectingDevice, null);
    await assert.rejects(() => session.reconnect(env.device), /RECONNECT_TARGET_MISMATCH/);
    await session.cleanup('test');
  });
});

test('a native operation cannot block the connection attempt forever', async () => {
  const env = harness({ connectNever: true });
  await withBluetooth(env.bluetooth, async () => {
    const session = new FtmsRowerSession({
      operationTimeoutMs: 8,
      cleanupTimeoutMs: 8,
    });
    const startedAt = Date.now();
    await assert.rejects(
      () => session.connect(env.device, { userAuthorized: true }),
      /GATT_CONNECT_TIMEOUT/,
    );
    assert.ok(Date.now() - startedAt < 150, 'connection timeout exceeded its bound');
    assert.equal(session.streamState(), 'idle');
    await session.cleanup('test');
  });
});

test('a late old GATT result cannot disconnect a newer same-object reconnect', async () => {
  const env = harness();
  const firstConnect = deferred();
  let connectCalls = 0;
  env.gatt.connect = function connect() {
    connectCalls += 1;
    if (connectCalls === 1) return firstConnect.promise;
    this.connected = true;
    return Promise.resolve(this);
  };
  await withBluetooth(env.bluetooth, async () => {
    const session = new FtmsRowerSession({ operationTimeoutMs: 8, cleanupTimeoutMs: 20 });
    session.selectedDevice = env.device;
    session.selectedByUser = true;
    await assert.rejects(() => session.reconnect(env.device), /GATT_CONNECT_TIMEOUT/);
    await session.reconnect(env.device);
    assert.equal(session.streamState(), 'subscribed_silent');
    assert.equal(env.gatt.connected, true);

    firstConnect.resolve(env.gatt);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(env.disconnectCount, 0);
    assert.equal(env.gatt.connected, true);
    assert.equal(session.streamState(), 'subscribed_silent');
    await session.cleanup('test');
  });
});

test('a late old notification result cannot stop a newer same-characteristic subscription', async () => {
  const env = harness();
  const firstSubscription = deferred();
  let startCalls = 0;
  let stopCalls = 0;
  env.rower.startNotifications = function startNotifications() {
    startCalls += 1;
    if (startCalls === 1) return firstSubscription.promise;
    return Promise.resolve(this);
  };
  env.rower.stopNotifications = function stopNotifications() {
    stopCalls += 1;
    return Promise.resolve(this);
  };
  await withBluetooth(env.bluetooth, async () => {
    const session = new FtmsRowerSession({ operationTimeoutMs: 8, cleanupTimeoutMs: 20 });
    session.selectedDevice = env.device;
    session.selectedByUser = true;
    await assert.rejects(() => session.reconnect(env.device), /SUBSCRIBE_TIMEOUT/);
    await session.reconnect(env.device);
    assert.equal(session.streamState(), 'subscribed_silent');
    assert.equal(stopCalls, 0);

    firstSubscription.resolve(env.rower);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stopCalls, 0);
    assert.equal(session.streamState(), 'subscribed_silent');
    await session.cleanup('test');
    assert.equal(stopCalls, 1);
  });
});

test('disconnect clears liveness and reconnect uses only the same selected object', async () => {
  const env = harness();
  await withBluetooth(env.bluetooth, async () => {
    const states = [];
    let now = 1000;
    const session = new FtmsRowerSession({
      onState: (state) => states.push(state.stage),
      now: () => now,
    });
    await session.beginScan(() => {});
    await session.connect(env.device, { userAuthorized: true });
    env.rower.emit([0x00, 0x00, 44, 3, 0]);
    assert.equal(session.streamState(now), 'live');

    env.device.emitDisconnect();
    assert.equal(session.streamState(now), 'disconnected');
    assert.ok(states.includes('GATT_DISCONNECTED'));
    assert.equal(env.rower.listenerCount(), 0);

    await assert.rejects(
      () => session.reconnect({ id: env.device.id, gatt: env.gatt }),
      /RECONNECT_TARGET_MISMATCH/,
    );
    const scansBeforeReconnect = env.scanCount;
    await session.reconnect(env.device);
    assert.equal(env.connectCount, 2);
    assert.equal(env.scanCount, scansBeforeReconnect);
    assert.equal(session.streamState(now), 'subscribed_silent');
    now += 100;
    env.rower.emit([0x00, 0x00, 46, 4, 0]);
    assert.equal(session.streamState(now), 'live');
    assert.ok(states.includes('GATT_RECONNECTING'));
    await session.cleanup('test');
  });
});

test('a disconnect during setup invalidates the pending connection generation', async () => {
  const env = harness();
  let resolveService;
  env.gatt.getPrimaryService = () => new Promise((resolve) => {
    resolveService = resolve;
  });
  await withBluetooth(env.bluetooth, async () => {
    const states = [];
    const session = new FtmsRowerSession({
      onState: (state) => states.push(state.stage),
      operationTimeoutMs: 1000,
    });
    const pending = session.connect(env.device, { userAuthorized: true });
    while (typeof resolveService !== 'function') await Promise.resolve();
    env.device.emitDisconnect();
    resolveService({
      async getCharacteristic() {
        throw new Error('stale setup must not continue');
      },
    });
    await assert.rejects(() => pending, /STALE_OPERATION/);
    assert.equal(session.streamState(), 'disconnected');
    assert.equal(states.includes('SERVICE_FOUND'), false);
    assert.equal(states.includes('SUBSCRIBED'), false);
    await session.cleanup('test');
  });
});

test('suspend closes transport but preserves only the explicitly selected reconnect target', async () => {
  const env = harness();
  await withBluetooth(env.bluetooth, async () => {
    const session = new FtmsRowerSession({ cleanupTimeoutMs: 20 });
    await session.beginScan(() => {});
    await session.connect(env.device, { userAuthorized: true });
    assert.equal(await session.suspend('hidden'), true);
    assert.equal(session.selectedDevice, env.device);
    assert.equal(session.streamState(), 'disconnected');
    await session.reconnect(env.device);
    assert.equal(env.connectCount, 2);
    await session.cleanup('test');
    assert.equal(session.selectedDevice, null);
    await assert.rejects(() => session.reconnect(env.device), /RECONNECT_TARGET_MISMATCH/);
  });
});

test('reconnect waits for an in-flight suspend before opening the same device again', async () => {
  const env = harness();
  await withBluetooth(env.bluetooth, async () => {
    const session = new FtmsRowerSession({ cleanupTimeoutMs: 1000 });
    await session.beginScan(() => {});
    await session.connect(env.device, { userAuthorized: true });
    let releaseStop;
    env.rower.stopNotifications = () => new Promise((resolve) => {
      releaseStop = resolve;
    });
    const suspending = session.suspend('hidden');
    const reconnecting = session.reconnect(env.device);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(env.connectCount, 1);
    releaseStop(env.rower);
    assert.equal(await suspending, true);
    await reconnecting;
    assert.equal(env.connectCount, 2);
    assert.equal(env.gatt.connected, true);
    assert.equal(session.streamState(), 'subscribed_silent');
    env.rower.stopNotifications = () => Promise.resolve(env.rower);
    await session.cleanup('test');
  });
});

test('a timed-out late scan is invalidated and stopped when it eventually resolves', async () => {
  let resolveScan;
  let stopCount = 0;
  const lateScan = {
    onDeviceFound() {},
    stop() { stopCount += 1; },
  };
  const bluetooth = {
    async getAvailability() { return true; },
    scanDevices() {
      return new Promise((resolve) => { resolveScan = resolve; });
    },
  };
  await withBluetooth(bluetooth, async () => {
    const session = new FtmsRowerSession({ operationTimeoutMs: 8 });
    await assert.rejects(() => session.beginScan(() => {}), /SCAN_TIMEOUT/);
    assert.equal(session.streamState(), 'idle');
    resolveScan(lateScan);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stopCount, 1);
    await session.cleanup('test');
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
    const session = new FtmsRowerSession({ operationTimeoutMs: 8 });
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

test('stopScan cancels an unresolved native FTMS scan without committing a device', async () => {
  const scanGate = deferred();
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
      return scanGate.promise;
    },
  }, async () => {
    const session = new FtmsRowerSession();
    const scanning = session.beginScan(() => {});
    await waitFor(() => scanCalls === 1);
    assert.equal(session.stopScan('page_leave'), true);
    scanGate.resolve(scan);
    await assert.rejects(() => scanning, /STALE_OPERATION/);
    await waitFor(() => stopCalls === 1);
    assert.equal(session.scan, null);
    assert.equal(session.selectedDevice, null);
    assert.equal(session.streamState(), 'idle');
  });
});

test('a rejected FTMS scan listener is stopped and cannot remain owned', async () => {
  let stopCalls = 0;
  const scan = {
    onDeviceFound() { throw new Error('listener rejected'); },
    offDeviceFound() {},
    stop() { stopCalls += 1; },
  };
  await withBluetooth({
    async getAvailability() { return true; },
    async scanDevices() { return scan; },
  }, async () => {
    const session = new FtmsRowerSession();
    await assert.rejects(() => session.beginScan(() => {}), /SCAN_LISTENER_FAILED/);
    assert.equal(stopCalls, 1);
    assert.equal(session.scan, null);
    assert.equal(session.streamState(), 'idle');
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
    const session = new FtmsRowerSession({ cleanupTimeoutMs: 5000 });
    session.gatt = {
      connected: true,
      disconnect() { return cleanupGate.promise; },
    };
    const resetting = session.cleanup('reset');
    const scanning = session.beginScan(() => {});
    const hiding = session.suspend('hidden');
    cleanupGate.resolve();
    await Promise.all([resetting, hiding]);
    await assert.rejects(() => scanning, /STALE_OPERATION/);
    assert.equal(scanCalls, 0);
    assert.equal(session.scan, null);
    assert.equal(session.streamState(), 'idle');
  });
});

test('a second suspend invalidates reconnect waiting behind the first suspend', async () => {
  const cleanupGate = deferred();
  const env = harness();
  await withBluetooth(env.bluetooth, async () => {
    const session = new FtmsRowerSession({ cleanupTimeoutMs: 5000 });
    session.selectedDevice = env.device;
    session.selectedByUser = true;
    session.gatt = env.gatt;
    env.gatt.connected = true;
    env.gatt.disconnect = () => cleanupGate.promise;

    const firstHide = session.suspend('hidden_1');
    const reconnecting = session.reconnect(env.device);
    const secondHide = session.suspend('hidden_2');
    cleanupGate.resolve();

    await Promise.all([firstHide, secondHide]);
    await assert.rejects(() => reconnecting, /STALE_OPERATION/);
    assert.equal(env.connectCount, 0);
    assert.equal(session.gatt, null);
    assert.equal(session.streamState(), 'disconnected');
  });
});

test('cleanup is bounded, removes listeners and blocks late packets', async () => {
  const env = harness();
  await withBluetooth(env.bluetooth, async () => {
    const records = [];
    const session = new FtmsRowerSession({
      onRecord: (record) => records.push(record),
      cleanupTimeoutMs: 20,
    });
    await session.beginScan(() => {});
    await session.connect(env.device, { userAuthorized: true });
    env.rower.stopNotifications = () => new Promise(() => {});
    env.gatt.disconnect = () => new Promise(() => {});

    const startedAt = Date.now();
    const clean = await session.cleanup('hidden');
    assert.equal(clean, false);
    assert.ok(Date.now() - startedAt < 150, 'cleanup exceeded its total budget');
    assert.equal(env.rower.listenerCount(), 0);
    assert.equal(env.disconnectListenerCount, 0);
    env.rower.emit([0x00, 0x00, 48, 5, 0]);
    assert.equal(records.length, 0);
    assert.equal(session.streamState(), 'idle');
    await session.cleanup('again');
  });
});

test('runtime source contains no physical-control or private bridge path', async () => {
  const source = await fs.readFile(
    new URL('../lib/ftms_session.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /2ad9|control point|writeValue|UnitySendMessage|AndroidJavaObject|sendCommand|\bMAC\b/i,
  );
  assert.doesNotMatch(source, /requestDevice|getDevices/);
});
