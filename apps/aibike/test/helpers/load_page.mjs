// Extract an AIUI single-file page into a temporary ESM module so lifecycle,
// focus, sensor and navigation behavior can be tested with local host mocks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_DIR = path.join(ROOT, 'test', '.pages-build');
let loadSequence = 0;

export async function loadPageModule(pageName) {
  const inkPath = path.join(ROOT, 'pages', pageName, 'index.ink');
  const text = fs.readFileSync(inkPath, 'utf8');
  const match = text.match(/<script setup>\s*([\s\S]*?)<\/script>/);
  if (!match) throw new Error(`${pageName}: no <script setup> block`);

  let src = match[1];
  src = src.replace(
    /import\s+wx\s+from\s+'wx';/,
    `const wx = new Proxy({}, {
  get(_target, property) {
    const host = globalThis.__pageWx;
    if (!host) return undefined;
    const value = host[property];
    return typeof value === 'function' ? value.bind(host) : value;
  },
  has(_target, property) {
    return globalThis.__pageWx ? property in globalThis.__pageWx : false;
  },
});`,
  );
  src = src.replace(
    /import\s*\{\s*Sound\s*\}\s*from\s*['"]audio['"]\s*;/,
    `function Sound(...args) {
  const SoundCtor = globalThis.Sound;
  if (typeof SoundCtor !== 'function') {
    throw new TypeError('globalThis.Sound is unavailable');
  }
  return Reflect.construct(SoundCtor, args);
}`,
  );
  src = src.replace(
    /import\s*\{\s*LanguageModel\s*\}\s*from\s*['"]language-model['"]\s*;/,
    `const LanguageModel = new Proxy({}, {
  get(_target, property) {
    const host = globalThis.LanguageModel;
    const value = host && host[property];
    return typeof value === 'function' ? value.bind(host) : value;
  },
});`,
  );

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  loadSequence += 1;
  const outPath = path.join(
    BUILD_DIR,
    `${pageName}.${process.pid}.${loadSequence}.page.mjs`,
  );
  fs.writeFileSync(outPath, src);
  const module = await import(`${pathToFileURL(outPath).href}?v=${Date.now()}`);
  return module.default;
}

export function instantiatePage(pageDefinition) {
  const page = { ...pageDefinition, data: { ...pageDefinition.data } };
  page.setData = function setData(patch) {
    Object.assign(this.data, patch);
  };
  return page;
}

export function fakeWx() {
  const store = new Map();
  const cloneStorageValue = (value) => (
    value === undefined ? undefined : JSON.parse(JSON.stringify(value))
  );
  const host = {
    store,
    navigateBackCalls: 0,
    exitMiniProgramCalls: 0,
    exitMiniProgramArgs: [],
    navigateToCalls: [],
    redirectToCalls: [],
    ttsSpoken: [],
    requestImpl: null,
    getStorageSync(key) {
      return store.has(key) ? cloneStorageValue(store.get(key)) : undefined;
    },
    setStorageSync(key, value) {
      store.set(key, cloneStorageValue(value));
    },
    removeStorageSync(key) {
      store.delete(key);
    },
    navigateBack() {
      this.navigateBackCalls += 1;
    },
    navigateTo(options) {
      this.navigateToCalls.push(options && options.url);
    },
    redirectTo(options) {
      const url = options && options.url;
      this.redirectToCalls.push(url);
      this.navigateToCalls.push(url);
    },
    exitMiniProgram(options) {
      this.exitMiniProgramCalls += 1;
      this.exitMiniProgramArgs.push(options);
      this.exited = true;
    },
    speech: {
      playTTS() {},
    },
    request(options) {
      if (this.requestImpl) {
        this.requestImpl(options);
        return;
      }
      if (options && typeof options.fail === 'function') {
        options.fail(new Error('offline'));
      }
    },
  };
  host.speech.playTTS = (text) => {
    host.ttsSpoken.push(String(text));
    return `tts-${host.ttsSpoken.length}`;
  };
  return host;
}

export class FakeAccelerometer {
  static instances = [];

  constructor(options = {}) {
    FakeAccelerometer.instances.push(this);
    this.options = { ...options };
    this.listeners = {};
    this.started = false;
    this.stopped = false;
    this.x = 0;
    this.y = 0;
    this.z = 9.8;
    this.timestamp = undefined;
  }

  addEventListener(type, callback) {
    (this.listeners[type] ||= []).push(callback);
  }

  removeEventListener(type, callback) {
    const listeners = this.listeners[type] || [];
    this.listeners[type] = listeners.filter((item) => item !== callback);
  }

  start() {
    this.started = true;
  }

  emitActivate(sessionId = 'test-accelerometer-session') {
    this.activated = true;
    for (const callback of this.listeners.activate || []) {
      callback({ sessionId });
    }
  }

  stop() {
    this.stopped = true;
  }

  emitReading(x, y, z, timestamp = undefined) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.timestamp = timestamp;
    for (const callback of this.listeners.reading || []) callback();
  }

  emitEventReading(x, y, z, timestamp = undefined) {
    for (const callback of this.listeners.reading || []) {
      callback({ x, y, z, timestamp });
    }
  }

  emitError(error = new Error('accelerometer error')) {
    for (const callback of this.listeners.error || []) callback(error);
  }

  static reset() {
    FakeAccelerometer.instances = [];
  }
}

export class FakeGyroscope {
  static instances = [];

  constructor(options = {}) {
    FakeGyroscope.instances.push(this);
    this.options = { ...options };
    this.listeners = {};
    this.started = false;
    this.stopped = false;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.timestamp = undefined;
  }

  addEventListener(type, callback) {
    (this.listeners[type] ||= []).push(callback);
  }

  start() {
    this.started = true;
  }

  emitActivate(sessionId = 'test-gyroscope-session') {
    this.activated = true;
    for (const callback of this.listeners.activate || []) {
      callback({ sessionId });
    }
  }

  stop() {
    this.stopped = true;
  }

  emitReading(x, y, z, timestamp = undefined) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.timestamp = timestamp;
    for (const callback of this.listeners.reading || []) callback();
  }

  emitEventReading(x, y, z, timestamp = undefined) {
    for (const callback of this.listeners.reading || []) {
      callback({ x, y, z, timestamp });
    }
  }

  emitError(error = new Error('gyroscope error')) {
    for (const callback of this.listeners.error || []) callback(error);
  }

  static reset() {
    FakeGyroscope.instances = [];
  }
}

export class FakeAbsoluteOrientationSensor {
  static instances = [];

  constructor(options = {}) {
    FakeAbsoluteOrientationSensor.instances.push(this);
    this.options = { ...options };
    this.listeners = {};
    this.started = false;
    this.stopped = false;
    this.startCalls = 0;
    this.stopCalls = 0;
    this.quaternion = [0, 0, 0, 1];
    this.timestamp = undefined;
    this.stable = null;
  }

  addEventListener(type, callback) {
    (this.listeners[type] ||= []).push(callback);
  }

  removeEventListener(type, callback) {
    const listeners = this.listeners[type] || [];
    this.listeners[type] = listeners.filter((item) => item !== callback);
  }

  start() {
    this.started = true;
    this.startCalls += 1;
  }

  emitActivate(sessionId = 'test-orientation-session') {
    this.activated = true;
    for (const callback of this.listeners.activate || []) {
      callback({ sessionId });
    }
  }

  stop() {
    this.stopped = true;
    this.stopCalls += 1;
  }

  emitReading(quaternion, timestamp = undefined) {
    this.quaternion = quaternion;
    this.timestamp = timestamp;
    for (const callback of this.listeners.reading || []) callback();
  }

  emitEventReading(quaternion, timestamp = undefined) {
    const values = Array.from(quaternion || []);
    for (const callback of this.listeners.reading || []) {
      callback({
        quaternion: values,
        x: values[0],
        y: values[1],
        z: values[2],
        w: values[3],
        timestamp,
      });
    }
  }

  emitError(error = new Error('orientation error')) {
    for (const callback of this.listeners.error || []) callback(error);
  }

  emitStability(stable) {
    this.stable = stable === true;
    for (const callback of this.listeners.orientationstabilitychange || []) {
      callback({ stable: this.stable });
    }
  }

  static reset() {
    FakeAbsoluteOrientationSensor.instances = [];
  }
}
