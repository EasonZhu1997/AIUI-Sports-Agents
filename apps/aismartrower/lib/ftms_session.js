import {
  FTMS_FEATURE_UUID,
  FTMS_ROWER_DATA_UUID,
  FTMS_SERVICE_UUID,
  ROWER_LIVE_WINDOW_MS,
  RowerRecordAssembler,
  hasMandatoryRowerTelemetry,
  isRowerRecordLive,
  parseFitnessMachineFeature,
  toFtmsBytes,
  validateRowerRecordAgainstFeature,
} from './ftms_rower.js';

export const FTMS_OPERATION_TIMEOUT_MS = 8000;
export const FTMS_CLEANUP_TIMEOUT_MS = 800;
export const FTMS_FIRST_PACKET_SILENT_MS = 10000;

function sessionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function hasProperty(characteristic, name) {
  return !!(characteristic && characteristic.properties
    && characteristic.properties[name] === true);
}

export class FtmsRowerSession {
  constructor({
    onState = () => {},
    onRecord = () => {},
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    operationTimeoutMs = FTMS_OPERATION_TIMEOUT_MS,
    cleanupTimeoutMs = FTMS_CLEANUP_TIMEOUT_MS,
    firstPacketSilentMs = FTMS_FIRST_PACKET_SILENT_MS,
    liveWindowMs = ROWER_LIVE_WINDOW_MS,
  } = {}) {
    this.onState = onState;
    this.onRecord = onRecord;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.operationTimeoutMs = operationTimeoutMs;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    this.firstPacketSilentMs = firstPacketSilentMs;
    this.liveWindowMs = liveWindowMs;

    this.generation = 0;
    this.scanIntentGeneration = 0;
    this.connectionIntentGeneration = 0;
    this.ended = true;
    this.status = 'idle';
    this.scan = null;
    this.scanListener = null;
    this.selectedDevice = null;
    this.selectedByUser = false;
    this.connectingDevice = null;
    this.gatt = null;
    this.disconnectListener = null;
    this.rowerCharacteristic = null;
    this.rowerListener = null;
    this.notificationsStarted = false;
    this.assembler = new RowerRecordAssembler();
    this.feature = null;
    this.subscribedAtMs = null;
    this.firstValidAtMs = null;
    this.lastValidAtMs = null;
    this.cleanupPromise = null;
  }

  active(generation) {
    return this.ended !== true && this.generation === generation;
  }

  emitState(stage, extra = {}) {
    try {
      this.onState({ stage, generation: this.generation, ...extra });
    } catch (_error) {}
  }

  _bluetooth() {
    return globalThis.navigator && globalThis.navigator.bluetooth;
  }

  _withTimeout(factory, timeoutMs, timeoutCode, failureCode) {
    const duration = Math.max(1, Number(timeoutMs) || 1);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = this.setTimer(() => {
        if (settled) return;
        settled = true;
        reject(sessionError(timeoutCode));
      }, duration);
      Promise.resolve()
        .then(factory)
        .then((value) => {
          if (settled) return;
          settled = true;
          this.clearTimer(timer);
          resolve(value);
        }, (error) => {
          if (settled) return;
          settled = true;
          this.clearTimer(timer);
          reject(error && error.code ? error : sessionError(failureCode));
        });
    });
  }

  _assertActive(generation) {
    if (!this.active(generation)) throw sessionError('STALE_OPERATION');
  }

  _invalidateAttempt(generation, reason = 'invalidated') {
    if (this.generation !== generation) return false;
    this.ended = true;
    this.status = this.selectedByUser ? 'disconnected' : 'idle';
    ++this.generation;
    this.assembler.reset(reason);
    this._stopScanSync({ emit: false });
    return true;
  }

  async _awaitCleanup() {
    const pending = this.cleanupPromise;
    if (!pending) return;
    try { await pending; } catch (_error) {}
  }

  _stopScanSync({ emit = true } = {}) {
    const scan = this.scan;
    const listener = this.scanListener;
    this.scan = null;
    this.scanListener = null;
    if (!scan) return false;
    try {
      if (typeof scan.offDeviceFound === 'function') scan.offDeviceFound(listener);
    } catch (_error) {}
    try { if (typeof scan.stop === 'function') scan.stop(); } catch (_error) {}
    if (emit) this.emitState('SCAN_STOPPED');
    return true;
  }

  _lateScanOwnedByCurrentAttempt(scan) {
    return this.ended !== true && this.status === 'scanning' && this.scan === scan;
  }

  stopScan(reason = 'user') {
    this.scanIntentGeneration += 1;
    const wasScanning = this.ended !== true && this.status === 'scanning';
    const stopped = this._stopScanSync({ emit: false });
    if (!stopped && !wasScanning) return false;
    this.ended = true;
    this.status = this.selectedByUser ? 'disconnected' : 'idle';
    ++this.generation;
    this.assembler.reset(reason);
    this.emitState('SCAN_STOPPED', { reason });
    return true;
  }

  async beginScan(onCandidate = () => {}) {
    const scanIntent = ++this.scanIntentGeneration;
    this.connectionIntentGeneration += 1;
    await this._cleanupConnection('scan_replace', { preserveSelected: false });
    if (scanIntent !== this.scanIntentGeneration) {
      throw sessionError('STALE_OPERATION');
    }
    this.ended = false;
    this.status = 'scanning';
    const generation = ++this.generation;
    const bluetooth = this._bluetooth();
    if (!bluetooth || typeof bluetooth.getAvailability !== 'function'
        || typeof bluetooth.scanDevices !== 'function') {
      this._invalidateAttempt(generation, 'bluetooth_unavailable');
      this.emitState('BLE_UNAVAILABLE');
      throw sessionError('BLE_UNAVAILABLE');
    }

    let available;
    try {
      available = await this._withTimeout(
        () => bluetooth.getAvailability(),
        this.operationTimeoutMs,
        'BLE_AVAILABILITY_TIMEOUT',
        'BLE_AVAILABILITY_FAILED',
      );
    } catch (error) {
      this._invalidateAttempt(generation, 'availability_failure');
      this.emitState('BLE_UNAVAILABLE', {
        reason: error && error.code ? error.code : 'BLE_AVAILABILITY_FAILED',
      });
      throw error;
    }
    this._assertActive(generation);
    if (available !== true) {
      this._invalidateAttempt(generation, 'availability_unavailable');
      this.emitState('BLE_UNAVAILABLE');
      throw sessionError('BLE_UNAVAILABLE');
    }

    let scan;
    try {
      const scanPromise = Promise.resolve().then(() => bluetooth.scanDevices({
        filters: [{ services: [FTMS_SERVICE_UUID] }],
      }));
      scanPromise.then((lateScan) => {
        if (this.active(generation) || !lateScan
            || this._lateScanOwnedByCurrentAttempt(lateScan)) return;
        try { if (typeof lateScan.stop === 'function') lateScan.stop(); } catch (_error) {}
      }, () => {});
      scan = await this._withTimeout(
        () => scanPromise,
        this.operationTimeoutMs,
        'SCAN_TIMEOUT',
        'SCAN_FAILED',
      );
      this._assertActive(generation);
    } catch (error) {
      this._invalidateAttempt(generation, 'scan_failure');
      this.emitState('SCAN_FAILED', { reason: error.code || 'SCAN_FAILED' });
      throw error;
    }

    const listener = (event) => {
      if (!this.active(generation) || this.scan !== scan) return;
      const device = event && (event.device || event);
      if (!device || !device.gatt) return;
      // Candidate discovery is never connection or liveness. The owning page
      // must present the candidate and call connect() from a user selection.
      this.emitState('DEVICE_FOUND');
      try { onCandidate(device, generation); } catch (_error) {}
    };
    this.scan = scan;
    this.scanListener = listener;
    if (!scan || typeof scan.onDeviceFound !== 'function') {
      this._stopScanSync({ emit: false });
      this._invalidateAttempt(generation, 'scan_callback_unavailable');
      this.emitState('SCAN_FAILED', { reason: 'SCAN_CALLBACK_UNAVAILABLE' });
      throw sessionError('SCAN_CALLBACK_UNAVAILABLE');
    }
    try {
      scan.onDeviceFound(listener);
    } catch (_error) {
      this._invalidateAttempt(generation, 'scan_listener_failed');
      this.emitState('SCAN_FAILED', { reason: 'SCAN_LISTENER_FAILED' });
      throw sessionError('SCAN_LISTENER_FAILED');
    }
    this.emitState('SCAN_STARTED');
    return generation;
  }

  async connect(device, { userAuthorized = false } = {}) {
    if (userAuthorized !== true) throw sessionError('USER_SELECTION_REQUIRED');
    this.scanIntentGeneration += 1;
    const connectionIntent = ++this.connectionIntentGeneration;
    await this._awaitCleanup();
    if (connectionIntent !== this.connectionIntentGeneration) {
      throw sessionError('STALE_OPERATION');
    }
    if (!device || !device.gatt || typeof device.gatt.connect !== 'function') {
      throw sessionError('INVALID_DEVICE');
    }
    if (this.gatt || this.rowerCharacteristic) throw sessionError('CONNECTION_ALREADY_OWNED');

    this._stopScanSync();
    return this._connectSelected(device, false);
  }

  async reconnect(device) {
    this.scanIntentGeneration += 1;
    const connectionIntent = ++this.connectionIntentGeneration;
    await this._awaitCleanup();
    if (connectionIntent !== this.connectionIntentGeneration) {
      throw sessionError('STALE_OPERATION');
    }
    if (!device || this.selectedByUser !== true || device !== this.selectedDevice) {
      throw sessionError('RECONNECT_TARGET_MISMATCH');
    }
    if (this.gatt || this.rowerCharacteristic) throw sessionError('CONNECTION_ALREADY_OWNED');
    return this._connectSelected(device, true);
  }

  _lateGattOwnedByCurrentAttempt(device, gatt) {
    return this.ended !== true
      && (this.connectingDevice === device || this.selectedDevice === device)
      && this.gatt === gatt;
  }

  _lateCharacteristicOwnedByCurrentAttempt(characteristic) {
    return this.ended !== true && this.rowerCharacteristic === characteristic;
  }

  async _connectSelected(device, reconnecting) {
    this.ended = false;
    this.status = 'connecting';
    this.connectingDevice = device;
    const generation = ++this.generation;
    this.assembler.reset(reconnecting ? 'reconnect' : 'connect');
    this.feature = null;
    this.subscribedAtMs = null;
    this.firstValidAtMs = null;
    this.lastValidAtMs = null;
    this.emitState(reconnecting ? 'GATT_RECONNECTING' : 'GATT_CONNECTING');

    let connectPromise;
    try {
      connectPromise = Promise.resolve().then(() => device.gatt.connect());
      // A native connect may resolve after our timeout. Never let that late
      // server survive an invalidated attempt.
      connectPromise.then((lateGatt) => {
        if (this.active(generation) || !lateGatt
            || this._lateGattOwnedByCurrentAttempt(device, lateGatt)) return;
        try { Promise.resolve(lateGatt.disconnect()).catch(() => {}); } catch (_error) {}
      }, () => {});
      const gatt = await this._withTimeout(
        () => connectPromise,
        this.operationTimeoutMs,
        'GATT_CONNECT_TIMEOUT',
        'GATT_CONNECT_FAILED',
      );
      this._assertActive(generation);
      if (!gatt || typeof gatt.getPrimaryService !== 'function') {
        throw sessionError('GATT_SERVER_INVALID');
      }
      this.gatt = gatt;
      this.status = 'validating';
      this.emitState('GATT_CONNECTED');

      const disconnectListener = () => this._onDisconnected(device, generation);
      this.disconnectListener = disconnectListener;
      if (typeof device.addEventListener === 'function') {
        device.addEventListener('gattserverdisconnected', disconnectListener);
      }

      const service = await this._withTimeout(
        () => gatt.getPrimaryService(FTMS_SERVICE_UUID),
        this.operationTimeoutMs,
        'SERVICE_TIMEOUT',
        'SERVICE_MISSING',
      );
      this._assertActive(generation);
      if (!service || typeof service.getCharacteristic !== 'function') {
        throw sessionError('SERVICE_INVALID');
      }
      this.emitState('SERVICE_FOUND');

      const featureCharacteristic = await this._withTimeout(
        () => service.getCharacteristic(FTMS_FEATURE_UUID),
        this.operationTimeoutMs,
        'FEATURE_CHARACTERISTIC_TIMEOUT',
        'FEATURE_MISSING',
      );
      this._assertActive(generation);
      if (!hasProperty(featureCharacteristic, 'read')
          || typeof featureCharacteristic.readValue !== 'function') {
        throw sessionError('FEATURE_NOT_READABLE');
      }
      const featureBytes = await this._withTimeout(
        () => featureCharacteristic.readValue(),
        this.operationTimeoutMs,
        'FEATURE_READ_TIMEOUT',
        'FEATURE_READ_FAILED',
      );
      this._assertActive(generation);
      const feature = parseFitnessMachineFeature(featureBytes);
      if (!feature.valid) throw sessionError('FEATURE_INVALID');
      this.feature = feature;
      this.emitState('FEATURE_READ');

      const rower = await this._withTimeout(
        () => service.getCharacteristic(FTMS_ROWER_DATA_UUID),
        this.operationTimeoutMs,
        'ROWER_CHARACTERISTIC_TIMEOUT',
        'ROWER_DATA_MISSING',
      );
      this._assertActive(generation);
      // Rower Data is Notify in FTMS 1.0.1. An indicate-only characteristic
      // with this UUID is not accepted as a conforming required stream.
      if (!hasProperty(rower, 'notify')
          || typeof rower.startNotifications !== 'function') {
        throw sessionError('ROWER_DATA_NOT_NOTIFIABLE');
      }

      const listener = (event) => {
        if (!this.active(generation) || this.rowerCharacteristic !== rower) return;
        const receivedAtMs = this.now();
        // Some native stacks deliver the first notification before the
        // startNotifications() Promise settles. The packet itself proves the
        // subscription is active, so publish SUBSCRIBED before LIVE and never
        // let the later Promise resolution move the state backwards.
        if (this.subscribedAtMs == null) {
          this.notificationsStarted = true;
          this.subscribedAtMs = receivedAtMs;
          this.status = 'subscribed_silent';
          this.emitState('SUBSCRIBED');
        }
        const source = event && event.target && event.target.value != null
          ? event.target.value
          : (event && event.value != null ? event.value : rower.value);
        const parsed = this.assembler.push(toFtmsBytes(source), {
          generation,
          nowMs: receivedAtMs,
        });
        if (!parsed.valid) {
          this.emitState('PACKET_INVALID', { reason: parsed.errors[0] || 'PACKET_INVALID' });
          return;
        }
        if (!parsed.published) return;
        if (!hasMandatoryRowerTelemetry(parsed)) {
          this.emitState('PACKET_INVALID', { reason: 'MANDATORY_TELEMETRY_MISSING' });
          return;
        }
        const validation = validateRowerRecordAgainstFeature(parsed, this.feature);
        if (!validation.valid) {
          this.emitState('PACKET_INVALID', {
            reason: validation.errors[0] || 'DATASET_INVALID',
          });
          return;
        }
        const publishedAtMs = parsed.receivedAtMs;
        if (this.firstValidAtMs == null) {
          this.firstValidAtMs = publishedAtMs;
          this.emitState('FIRST_VALID_PACKET');
        }
        this.lastValidAtMs = publishedAtMs;
        this.status = 'live';
        this.emitState('STREAM_LIVE');
        try { this.onRecord(parsed); } catch (_error) {}
      };
      rower.addEventListener('characteristicvaluechanged', listener);
      this.rowerCharacteristic = rower;
      this.rowerListener = listener;

      const notificationPromise = Promise.resolve().then(() => rower.startNotifications());
      notificationPromise.then(() => {
        if ((this.active(generation) && this.rowerCharacteristic === rower)
            || this._lateCharacteristicOwnedByCurrentAttempt(rower)) return;
        try { Promise.resolve(rower.stopNotifications()).catch(() => {}); } catch (_error) {}
      }, () => {});
      await this._withTimeout(
        () => notificationPromise,
        this.operationTimeoutMs,
        'SUBSCRIBE_TIMEOUT',
        'SUBSCRIBE_FAILED',
      );
      this._assertActive(generation);
      this.notificationsStarted = true;
      if (this.subscribedAtMs == null) {
        this.subscribedAtMs = this.now();
        this.status = 'subscribed_silent';
        this.emitState('SUBSCRIBED');
      } else if (this.firstValidAtMs != null) {
        this.status = 'live';
      }
      if (!reconnecting) {
        this.selectedDevice = device;
        this.selectedByUser = true;
      }
      if (this.connectingDevice === device) this.connectingDevice = null;
      return {
        generation,
        reconnecting,
        feature: { ...feature },
        subscribedAtMs: this.subscribedAtMs,
      };
    } catch (error) {
      const reason = error && error.code ? error.code : 'GATT_SETUP_FAILED';
      if (this.active(generation)) {
        await this._cleanupConnection('connect_failure', { preserveSelected: reconnecting });
        this.emitState('CONNECT_FAILED', { reason });
      }
      throw sessionError(reason);
    }
  }

  _onDisconnected(device, generation) {
    if (!this.active(generation)
        || (device !== this.selectedDevice && device !== this.connectingDevice)) return;
    // A physical disconnect invalidates every pending service/characteristic
    // await from this connection before any of them can publish more state.
    this.ended = true;
    ++this.generation;
    this.assembler.reset('disconnect');
    if (this.rowerCharacteristic && this.rowerListener) {
      try {
        this.rowerCharacteristic.removeEventListener(
          'characteristicvaluechanged',
          this.rowerListener,
        );
      } catch (_error) {}
    }
    if (this.disconnectListener && typeof device.removeEventListener === 'function') {
      try {
        device.removeEventListener('gattserverdisconnected', this.disconnectListener);
      } catch (_error) {}
    }
    this.gatt = null;
    if (this.connectingDevice === device) this.connectingDevice = null;
    this.disconnectListener = null;
    this.rowerCharacteristic = null;
    this.rowerListener = null;
    this.notificationsStarted = false;
    this.feature = null;
    this.subscribedAtMs = null;
    this.firstValidAtMs = null;
    this.lastValidAtMs = null;
    this.status = 'disconnected';
    // Keep the explicitly selected in-memory object so the page may call the
    // bounded reconnect(device) entry. No scan or device picker is invoked.
    this.emitState('GATT_DISCONNECTED');
  }

  streamState(nowMs = this.now()) {
    if (this.status === 'idle' || this.status === 'disconnected') return this.status;
    if (this.ended) return this.selectedByUser ? 'disconnected' : 'idle';
    if (this.status === 'scanning' || this.status === 'connecting'
        || this.status === 'validating') return this.status;
    if (this.status === 'subscribed_silent') {
      return nowMs - this.subscribedAtMs > this.firstPacketSilentMs
        ? 'silent' : 'subscribed_silent';
    }
    if (this.status === 'live') {
      return isRowerRecordLive(this.lastValidAtMs, nowMs, this.liveWindowMs)
        ? 'live' : 'stale';
    }
    return this.selectedByUser ? 'disconnected' : 'idle';
  }

  async _settleWithin(factory, timeoutMs) {
    try {
      await this._withTimeout(
        factory,
        Math.max(1, timeoutMs),
        'CLEANUP_STEP_TIMEOUT',
        'CLEANUP_STEP_FAILED',
      );
      return true;
    } catch (_error) {
      return false;
    }
  }

  async _cleanupConnection(reason, { preserveSelected = false } = {}) {
    if (this.cleanupPromise) {
      if (!preserveSelected) {
        this.selectedDevice = null;
        this.selectedByUser = false;
        this.status = 'idle';
      }
      this.connectingDevice = null;
      return this.cleanupPromise;
    }
    this.ended = true;
    ++this.generation;
    this.status = preserveSelected ? 'disconnected' : 'idle';
    this._stopScanSync({ emit: false });
    this.assembler.reset(reason);

    const device = this.connectingDevice || this.selectedDevice;
    const disconnectListener = this.disconnectListener;
    const rower = this.rowerCharacteristic;
    const rowerListener = this.rowerListener;
    const gatt = this.gatt;
    const notificationWasStarted = this.notificationsStarted;

    this.gatt = null;
    this.connectingDevice = null;
    this.disconnectListener = null;
    this.rowerCharacteristic = null;
    this.rowerListener = null;
    this.notificationsStarted = false;
    this.feature = null;
    this.subscribedAtMs = null;
    this.firstValidAtMs = null;
    this.lastValidAtMs = null;
    if (!preserveSelected) {
      this.selectedDevice = null;
      this.selectedByUser = false;
    }

    if (rower && rowerListener) {
      try { rower.removeEventListener('characteristicvaluechanged', rowerListener); } catch (_error) {}
    }
    if (device && disconnectListener && typeof device.removeEventListener === 'function') {
      try { device.removeEventListener('gattserverdisconnected', disconnectListener); } catch (_error) {}
    }

    const totalBudget = Math.max(2, Number(this.cleanupTimeoutMs) || 2);
    const stopBudget = rower && notificationWasStarted
      ? Math.max(1, Math.floor(totalBudget / 2)) : 0;
    const disconnectBudget = Math.max(1, totalBudget - stopBudget);

    this.cleanupPromise = (async () => {
      let clean = true;
      if (stopBudget > 0 && typeof rower.stopNotifications === 'function') {
        clean = await this._settleWithin(() => rower.stopNotifications(), stopBudget) && clean;
      }
      if (gatt && gatt.connected !== false && typeof gatt.disconnect === 'function') {
        clean = await this._settleWithin(() => gatt.disconnect(), disconnectBudget) && clean;
      }
      this.emitState('CLEANUP_FINISHED', { reason, bounded: true, clean });
      return clean;
    })().finally(() => {
      this.cleanupPromise = null;
    });
    return this.cleanupPromise;
  }

  cleanup(reason = 'end') {
    this.scanIntentGeneration += 1;
    this.connectionIntentGeneration += 1;
    return this._cleanupConnection(reason, { preserveSelected: false });
  }

  suspend(reason = 'suspend') {
    this.scanIntentGeneration += 1;
    this.connectionIntentGeneration += 1;
    return this._cleanupConnection(reason, { preserveSelected: true });
  }
}
