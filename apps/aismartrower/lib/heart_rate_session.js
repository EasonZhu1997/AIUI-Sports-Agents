import {
  HEART_RATE_MEASUREMENT_UUID,
  HEART_RATE_SERVICE_UUID,
  parseHeartRateMeasurement,
} from './hr.js';

export const HEART_RATE_OPERATION_TIMEOUT_MS = 8000;
export const HEART_RATE_CLEANUP_TIMEOUT_MS = 800;
export const HEART_RATE_FIRST_PACKET_SILENT_MS = 10000;
export const HEART_RATE_LIVE_WINDOW_MS = 5000;

function sessionError(code) {
  const error = new Error(code);
  error.code = code;
  error.isHeartRateSessionError = true;
  return error;
}

function hasProperty(characteristic, name) {
  return !!(characteristic && characteristic.properties
    && characteristic.properties[name] === true);
}

/**
 * One explicitly selected standard HRS peripheral.
 *
 * This object intentionally owns no FTMS resources. A dual-device page must
 * keep its rower and HRS sessions separate and coordinate only their setup
 * order and final cleanup.
 */
export class HeartRateSession {
  constructor({
    onState = () => {},
    onMeasurement = () => {},
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    operationTimeoutMs = HEART_RATE_OPERATION_TIMEOUT_MS,
    cleanupTimeoutMs = HEART_RATE_CLEANUP_TIMEOUT_MS,
    firstPacketSilentMs = HEART_RATE_FIRST_PACKET_SILENT_MS,
    liveWindowMs = HEART_RATE_LIVE_WINDOW_MS,
  } = {}) {
    this.onState = onState;
    this.onMeasurement = onMeasurement;
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
    this.status = 'disconnected';
    this.scan = null;
    this.scanListener = null;
    this.selectedDevice = null;
    this.selectedByUser = false;
    this.connectionDevice = null;
    this.gatt = null;
    this.disconnectListener = null;
    this.characteristic = null;
    this.measurementListener = null;
    this.notificationsStarted = false;
    this.subscribedAtMs = null;
    this.firstValidAtMs = null;
    this.lastValidAtMs = null;
    this.lastUsableAtMs = null;
    this.lastMeasurement = null;
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
          reject(error && error.isHeartRateSessionError === true
            ? error : sessionError(failureCode));
        });
    });
  }

  _assertActive(generation) {
    if (!this.active(generation)) throw sessionError('STALE_OPERATION');
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
    this.status = 'disconnected';
    ++this.generation;
    this.emitState('SCAN_STOPPED', { reason });
    return true;
  }

  _invalidateAttempt(generation, reason) {
    if (generation !== this.generation) return false;
    this.ended = true;
    this.status = 'disconnected';
    ++this.generation;
    this._stopScanSync({ emit: false });
    this.emitState('ATTEMPT_INVALIDATED', { reason });
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
        filters: [{ services: [HEART_RATE_SERVICE_UUID] }],
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
      this.emitState('SCAN_FAILED', {
        reason: error && error.code ? error.code : 'SCAN_FAILED',
      });
      throw error;
    }

    if (!scan || typeof scan.onDeviceFound !== 'function') {
      try { if (scan && typeof scan.stop === 'function') scan.stop(); } catch (_error) {}
      this._invalidateAttempt(generation, 'scan_callback_unavailable');
      this.emitState('SCAN_FAILED', { reason: 'SCAN_CALLBACK_UNAVAILABLE' });
      throw sessionError('SCAN_CALLBACK_UNAVAILABLE');
    }
    const listener = (event) => {
      if (!this.active(generation) || this.scan !== scan) return;
      const device = event && (event.device || event);
      if (!device || !device.gatt) return;
      this.emitState('DEVICE_FOUND');
      try { onCandidate(device, generation); } catch (_error) {}
    };
    this.scan = scan;
    this.scanListener = listener;
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
    if (this.gatt || this.characteristic || this.connectionDevice) {
      throw sessionError('CONNECTION_ALREADY_OWNED');
    }
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
    if (this.gatt || this.characteristic || this.connectionDevice) {
      throw sessionError('CONNECTION_ALREADY_OWNED');
    }
    return this._connectSelected(device, true);
  }

  _lateGattOwnedByCurrentAttempt(device, gatt) {
    return this.ended !== true
      && this.connectionDevice === device
      && this.gatt === gatt;
  }

  _lateCharacteristicOwnedByCurrentAttempt(characteristic) {
    return this.ended !== true && this.characteristic === characteristic;
  }

  async _connectSelected(device, reconnecting) {
    this.ended = false;
    this.status = 'connecting';
    const generation = ++this.generation;
    this.connectionDevice = device;
    this.gatt = null;
    this.disconnectListener = null;
    this.characteristic = null;
    this.measurementListener = null;
    this.notificationsStarted = false;
    this.subscribedAtMs = null;
    this.firstValidAtMs = null;
    this.lastValidAtMs = null;
    this.lastUsableAtMs = null;
    this.lastMeasurement = null;
    this.emitState(reconnecting ? 'GATT_RECONNECTING' : 'GATT_CONNECTING');

    try {
      let lateDisconnectIssued = false;
      const disconnectLateGatt = (lateGatt) => {
        if (!lateGatt || lateDisconnectIssued) return;
        lateDisconnectIssued = true;
        try {
          Promise.resolve(lateGatt.disconnect()).catch(() => {});
        } catch (_error) {}
      };
      const connectPromise = Promise.resolve().then(() => device.gatt.connect());
      connectPromise.then((lateGatt) => {
        if (this.active(generation) || !lateGatt
            || this._lateGattOwnedByCurrentAttempt(device, lateGatt)) return;
        disconnectLateGatt(lateGatt);
      }, () => {});
      const gatt = await this._withTimeout(
        () => connectPromise,
        this.operationTimeoutMs,
        'GATT_CONNECT_TIMEOUT',
        'GATT_CONNECT_FAILED',
      );
      if (!this.active(generation)) {
        disconnectLateGatt(gatt);
        throw sessionError('STALE_OPERATION');
      }
      this._assertActive(generation);
      if (!gatt || typeof gatt.getPrimaryService !== 'function') {
        throw sessionError('GATT_SERVER_INVALID');
      }
      this.gatt = gatt;
      this.emitState('GATT_CONNECTED');

      const disconnectListener = () => this._onDisconnected(device, generation);
      this.disconnectListener = disconnectListener;
      if (typeof device.addEventListener === 'function') {
        try {
          device.addEventListener('gattserverdisconnected', disconnectListener);
        } catch (_error) {
          throw sessionError('DISCONNECT_LISTENER_FAILED');
        }
      }

      const service = await this._withTimeout(
        () => gatt.getPrimaryService(HEART_RATE_SERVICE_UUID),
        this.operationTimeoutMs,
        'SERVICE_TIMEOUT',
        'SERVICE_MISSING',
      );
      this._assertActive(generation);
      if (!service || typeof service.getCharacteristic !== 'function') {
        throw sessionError('SERVICE_INVALID');
      }
      this.emitState('SERVICE_FOUND');

      const characteristic = await this._withTimeout(
        () => service.getCharacteristic(HEART_RATE_MEASUREMENT_UUID),
        this.operationTimeoutMs,
        'MEASUREMENT_CHARACTERISTIC_TIMEOUT',
        'MEASUREMENT_MISSING',
      );
      this._assertActive(generation);
      if (!hasProperty(characteristic, 'notify')
          || typeof characteristic.startNotifications !== 'function') {
        throw sessionError('MEASUREMENT_NOT_NOTIFIABLE');
      }
      if (typeof characteristic.addEventListener !== 'function'
          || typeof characteristic.removeEventListener !== 'function') {
        throw sessionError('MEASUREMENT_EVENT_API_MISSING');
      }

      const listener = (event) => {
        if (!this.active(generation) || this.characteristic !== characteristic) return;
        const receivedAtMs = this.now();
        // A real notification can precede resolution of startNotifications().
        // Preserve monotonic SUBSCRIBED -> FIRST_VALID_PACKET -> LIVE ordering.
        if (this.subscribedAtMs == null) {
          this.notificationsStarted = true;
          this.subscribedAtMs = receivedAtMs;
          this.status = 'subscribed';
          this.emitState('SUBSCRIBED');
        }
        const source = event && event.target && event.target.value != null
          ? event.target.value
          : (event && event.value != null ? event.value : characteristic.value);
        const parsed = parseHeartRateMeasurement(source);
        if (!parsed.valid) {
          this.emitState('PACKET_INVALID', {
            reason: parsed.errors[0] || 'PACKET_INVALID',
          });
          return;
        }
        const measurement = { ...parsed, receivedAtMs, generation };
        if (this.firstValidAtMs == null) {
          this.firstValidAtMs = receivedAtMs;
          this.emitState('FIRST_VALID_PACKET');
        }
        this.lastValidAtMs = receivedAtMs;
        this.lastMeasurement = measurement;
        if (parsed.contactDetected === false) {
          this.lastUsableAtMs = null;
          this.status = 'contact_poor';
          this.emitState('CONTACT_POOR');
        } else if (parsed.usable) {
          this.lastUsableAtMs = receivedAtMs;
          this.status = 'live';
          this.emitState('STREAM_LIVE');
        } else {
          this.lastUsableAtMs = null;
          this.status = 'unusable';
          this.emitState('STREAM_UNUSABLE');
        }
        try { this.onMeasurement(measurement); } catch (_error) {}
      };
      this.characteristic = characteristic;
      this.measurementListener = listener;
      try {
        characteristic.addEventListener('characteristicvaluechanged', listener);
      } catch (_error) {
        throw sessionError('MEASUREMENT_LISTENER_FAILED');
      }

      const notificationPromise = Promise.resolve()
        .then(() => characteristic.startNotifications());
      notificationPromise.then(() => {
        if (this.active(generation)
            || this._lateCharacteristicOwnedByCurrentAttempt(characteristic)) return;
        try {
          Promise.resolve(characteristic.stopNotifications()).catch(() => {});
        } catch (_error) {}
      }, () => {});
      await this._withTimeout(
        () => notificationPromise,
        this.operationTimeoutMs,
        'SUBSCRIBE_TIMEOUT',
        'SUBSCRIBE_FAILED',
      );
      if (!this.active(generation)) {
        try {
          Promise.resolve(characteristic.stopNotifications()).catch(() => {});
        } catch (_error) {}
        throw sessionError('STALE_OPERATION');
      }
      this._assertActive(generation);
      this.notificationsStarted = true;
      if (this.subscribedAtMs == null) {
        this.subscribedAtMs = this.now();
        this.status = 'subscribed';
        this.emitState('SUBSCRIBED');
      }

      // Initial selection is committed only after the required GATT path is
      // subscribed. Reconnect keeps the prior explicitly selected object.
      if (!reconnecting) {
        this.selectedDevice = device;
        this.selectedByUser = true;
      }
      if (this.firstValidAtMs != null) {
        this.status = this.lastMeasurement.contactDetected === false
          ? 'contact_poor'
          : (this.lastMeasurement.usable ? 'live' : 'unusable');
      }
      return {
        generation,
        reconnecting,
        subscribedAtMs: this.subscribedAtMs,
      };
    } catch (error) {
      const reason = error && error.code ? error.code : 'GATT_SETUP_FAILED';
      if (this.active(generation)) {
        await this._cleanupConnection('connect_failure', {
          preserveSelected: reconnecting,
        });
        this.emitState('CONNECT_FAILED', { reason });
      }
      throw sessionError(reason);
    }
  }

  _onDisconnected(device, generation) {
    if (!this.active(generation) || device !== this.connectionDevice) return false;
    // Invalidate every in-flight service/characteristic await synchronously.
    this.ended = true;
    ++this.generation;
    const characteristic = this.characteristic;
    const listener = this.measurementListener;
    const disconnectListener = this.disconnectListener;
    if (characteristic && listener) {
      try {
        characteristic.removeEventListener('characteristicvaluechanged', listener);
      } catch (_error) {}
    }
    if (disconnectListener && typeof device.removeEventListener === 'function') {
      try {
        device.removeEventListener('gattserverdisconnected', disconnectListener);
      } catch (_error) {}
    }
    this.connectionDevice = null;
    this.gatt = null;
    this.disconnectListener = null;
    this.characteristic = null;
    this.measurementListener = null;
    this.notificationsStarted = false;
    this.subscribedAtMs = null;
    this.firstValidAtMs = null;
    this.lastValidAtMs = null;
    this.lastUsableAtMs = null;
    this.lastMeasurement = null;
    this.status = 'disconnected';
    // selectedDevice remains only when the initial explicit selection had
    // already committed, enabling same-object bounded reconnect by the page.
    this.emitState('GATT_DISCONNECTED');
    return true;
  }

  // AIUI currently documents characteristic events but not a
  // gattserverdisconnected event on BluetoothDevice. A page/bridge with a
  // separately verified disconnect signal may feed it through this fenced
  // seam; unsupported hosts must not claim automatic physical-disconnect
  // detection merely because the simulated DOM event path passes tests.
  handlePhysicalDisconnect(device = this.connectionDevice) {
    return this._onDisconnected(device, this.generation);
  }

  streamState(nowMs = this.now()) {
    const now = Number(nowMs);
    if (this.ended || this.status === 'disconnected') return 'disconnected';
    if (this.subscribedAtMs == null) {
      return this.status === 'scanning' ? 'scanning' : 'connecting';
    }
    if (this.firstValidAtMs == null) {
      return now - this.subscribedAtMs > this.firstPacketSilentMs
        ? 'silent' : 'subscribed_silent';
    }
    if (!Number.isFinite(now) || now < this.lastValidAtMs
        || now - this.lastValidAtMs > this.liveWindowMs) return 'stale';
    if (this.lastMeasurement && this.lastMeasurement.contactDetected === false) {
      return 'contact_poor';
    }
    return this.lastMeasurement && this.lastMeasurement.usable
      ? 'live' : 'unusable';
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
      }
      return this.cleanupPromise;
    }

    this.ended = true;
    ++this.generation;
    this.status = 'disconnected';
    this._stopScanSync({ emit: false });

    const device = this.connectionDevice;
    const gatt = this.gatt;
    const disconnectListener = this.disconnectListener;
    const characteristic = this.characteristic;
    const listener = this.measurementListener;
    const notificationWasStarted = this.notificationsStarted;

    this.connectionDevice = null;
    this.gatt = null;
    this.disconnectListener = null;
    this.characteristic = null;
    this.measurementListener = null;
    this.notificationsStarted = false;
    this.subscribedAtMs = null;
    this.firstValidAtMs = null;
    this.lastValidAtMs = null;
    this.lastUsableAtMs = null;
    this.lastMeasurement = null;
    if (!preserveSelected) {
      this.selectedDevice = null;
      this.selectedByUser = false;
    }

    if (characteristic && listener) {
      try {
        characteristic.removeEventListener('characteristicvaluechanged', listener);
      } catch (_error) {}
    }
    if (device && disconnectListener && typeof device.removeEventListener === 'function') {
      try {
        device.removeEventListener('gattserverdisconnected', disconnectListener);
      } catch (_error) {}
    }

    const totalBudget = Math.max(2, Number(this.cleanupTimeoutMs) || 2);
    const stopBudget = characteristic && notificationWasStarted
      ? Math.max(1, Math.floor(totalBudget / 2)) : 0;
    const disconnectBudget = Math.max(1, totalBudget - stopBudget);
    this.cleanupPromise = (async () => {
      let clean = true;
      if (stopBudget > 0 && typeof characteristic.stopNotifications === 'function') {
        clean = await this._settleWithin(
          () => characteristic.stopNotifications(),
          stopBudget,
        ) && clean;
      }
      if (gatt && gatt.connected !== false && typeof gatt.disconnect === 'function') {
        clean = await this._settleWithin(
          () => gatt.disconnect(),
          disconnectBudget,
        ) && clean;
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
