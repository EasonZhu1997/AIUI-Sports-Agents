// .ink 页面脚本加载器:把 <script setup> 提取成可 import 的 ESM 模块,
// 用注入的 wx/宿主 mock 驱动页面生命周期(onLoad/onHide/onShow/onKeyUp/tick),
// 让"onShow 恢复传感器""心率断连回退""应用内回撤"这类页面级行为有可执行测试,
// 而不是只靠正则断言源码里出现过某个字符串。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_DIR = path.join(ROOT, 'test', '.pages-build');
let loadSequence = 0;

/**
 * 提取 pages/<name>/index.ink 的 <script setup> 并转成 ESM 模块。
 * - `import wx from 'wx'` 重写为读取 globalThis.__pageWx(测试注入 mock);
 * - `import { Sound } from 'audio'` 重写为构造时读取 globalThis.Sound，允许每个测试换桩;
 * - 相对 lib 导入落在 test/.pages-build/ 下仍解析到仓库 lib/(../../lib)。
 * 返回模块的 default 导出(页面定义对象)。
 */
export async function loadPageModule(pageName) {
  const inkPath = path.join(ROOT, 'pages', pageName, 'index.ink');
  const text = fs.readFileSync(inkPath, 'utf8');
  const match = text.match(/<script setup>\s*([\s\S]*?)<\/script>/);
  if (!match) throw new Error(`${pageName}: no <script setup> block`);
  let src = match[1];
  // wx 用 Proxy 转发到 globalThis.__pageWx:模块只 import 一次,
  // 但每个测试可换新的 fakeWx;方法绑定回真实 mock,保证 this 正确。
  src = src.replace(
    /import\s+wx\s+from\s+'wx';/,
    `const wx = new Proxy({}, {
  get(_t, p) {
    const target = globalThis.__pageWx;
    if (!target) return undefined;
    const v = target[p];
    return typeof v === 'function' ? v.bind(target) : v;
  },
  has(_t, p) { return globalThis.__pageWx ? p in globalThis.__pageWx : false; },
});`,
  );
  // 官方 audio 模块只存在于 AIUI 宿主。这里不能在模块加载时捕获一次
  // globalThis.Sound，否则同一 spec 中后续测试切换/清理 FakeSound 不会生效。
  src = src.replace(
    /import\s*\{\s*Sound\s*\}\s*from\s*['"]audio['"]\s*;/,
    `function Sound(...args) {
  const SoundCtor = globalThis.Sound;
  if (typeof SoundCtor !== 'function') throw new TypeError('globalThis.Sound is unavailable');
  return Reflect.construct(SoundCtor, args);
}`,
  );
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  // node:test 默认并行运行 spec。跨路由测试会与页面单测同时加载同一页面，
  // 固定文件名会发生 truncate/write 竞态；进程号和序号让每次提取拥有独立模块。
  loadSequence += 1;
  const outPath = path.join(BUILD_DIR, `${pageName}.${process.pid}.${loadSequence}.page.mjs`);
  fs.writeFileSync(outPath, src);
  const mod = await import(`${pathToFileURL(outPath).href}?v=${Date.now()}`);
  return mod.default;
}

/**
 * 从页面定义生成一个独立实例。hostFields 用于在 onLoad 前注入
 * AIUI 宿主保留字段/方法（例如 orientationSensor 与 enableWorldAwareness）。
 */
export function instantiatePage(pageDef, hostFields = {}) {
  const page = { ...pageDef, ...hostFields, data: { ...pageDef.data } };
  page.setData = function setData(patch) { Object.assign(this.data, patch); };
  return page;
}

/** 假 wx:同步 storage + 路由调用计数 + speech/request 桩。 */
export function fakeWx() {
  const store = new Map();
  const cloneStorageValue = (value) => value === undefined
    ? undefined : JSON.parse(JSON.stringify(value));
  const w = {
    store,
    navigateBackCalls: 0,
    exitMiniProgramCalls: 0,
    navigateToCalls: [],
    redirectToCalls: [],
    ttsSpoken: [],
    requestImpl: null,   // 测试可注入;默认所有请求立刻 fail(离线)
    // 对齐 AIUI v0.14 同步 storage：缺键返回 undefined；对象按 JSON
    // 序列化/反序列化，不把同一个引用直接交还页面。
    getStorageSync(k) { return store.has(k) ? cloneStorageValue(store.get(k)) : undefined; },
    getStorage(opts) {
      const key = opts && opts.key;
      if (store.has(key)) {
        if (opts && typeof opts.success === 'function') {
          opts.success({ data: cloneStorageValue(store.get(key)) });
        }
        return;
      }
      if (opts && typeof opts.fail === 'function') opts.fail({ errMsg: 'Key not found' });
    },
    setStorageSync(k, v) { store.set(k, cloneStorageValue(v)); },
    removeStorageSync(k) { store.delete(k); },
    navigateBack() { this.navigateBackCalls += 1; },
    navigateTo(opts) { this.navigateToCalls.push(opts && opts.url); },
    redirectTo(opts) {
      const url = opts && opts.url;
      this.redirectToCalls.push(url);
      this.navigateToCalls.push(url);
    },
    exitMiniProgram() {
      this.exitMiniProgramCalls += 1;
      this.exited = true;
    },
    speech: {
      playTTS(text) { /* 由下方绑定回真实 mock,记录到 ttsSpoken */ },
    },
    request(opts) {
      if (this.requestImpl) { this.requestImpl(opts); return; }
      if (opts && typeof opts.fail === 'function') opts.fail(new Error('offline'));
    },
  };
  w.speech.playTTS = (text) => { w.ttsSpoken.push(String(text)); };
  return w;
}

/** 假加速度计:记录实例,可手动喂 reading。 */
export class FakeAccelerometer {
  static instances = [];
  constructor() {
    FakeAccelerometer.instances.push(this);
    this.listeners = {};
    this.started = false;
    this.stopped = false;
    this.x = 0; this.y = 0; this.z = 9.8;
    // 省略时保持旧测试的墙钟回退路径；需要验证 Generic Sensor 时间基准时，
    // emitReading 的第四个参数可显式注入宿主 timestamp。
    this.timestamp = undefined;
  }
  addEventListener(type, cb) { (this.listeners[type] ||= []).push(cb); }
  start() { this.started = true; }
  stop() { this.stopped = true; }
  emitReading(x, y, z, timestamp = undefined) {
    this.x = x; this.y = y; this.z = z;
    this.timestamp = timestamp;
    for (const cb of this.listeners.reading || []) cb();
  }
  emitError(error = new Error('accelerometer error')) {
    for (const cb of this.listeners.error || []) cb(error);
  }
  static reset() { FakeAccelerometer.instances = []; }
}

/** AIUI 0.15 假陀螺仪：只用于验证能力探测与生命周期。 */
export class FakeGyroscope {
  static instances = [];
  constructor() {
    FakeGyroscope.instances.push(this);
    this.listeners = {};
    this.started = false;
    this.stopped = false;
    this.x = 0; this.y = 0; this.z = 0;
    this.timestamp = undefined;
  }
  addEventListener(type, cb) { (this.listeners[type] ||= []).push(cb); }
  start() { this.started = true; }
  stop() { this.stopped = true; }
  emitReading(x, y, z, timestamp = undefined) {
    this.x = x; this.y = y; this.z = z; this.timestamp = timestamp;
    for (const cb of this.listeners.reading || []) cb();
  }
  emitError(error = new Error('gyroscope error')) {
    for (const cb of this.listeners.error || []) cb(error);
  }
  static reset() { FakeGyroscope.instances = []; }
}

/** AIUI 0.15 假绝对姿态传感器，四元数顺序与官方 sample 相同：[x,y,z,w]。 */
export class FakeAbsoluteOrientationSensor {
  static instances = [];
  constructor() {
    FakeAbsoluteOrientationSensor.instances.push(this);
    this.listeners = {};
    this.started = false;
    this.stopped = false;
    this.quaternion = [0, 0, 0, 1];
    this.timestamp = undefined;
  }
  addEventListener(type, cb) { (this.listeners[type] ||= []).push(cb); }
  removeEventListener(type, cb) {
    this.listeners[type] = cb
      ? (this.listeners[type] || []).filter((listener) => listener !== cb)
      : [];
  }
  start() {
    this.startCalls = (this.startCalls || 0) + 1;
    this.started = true;
  }
  stop() {
    this.stopCalls = (this.stopCalls || 0) + 1;
    this.stopped = true;
  }
  emitReading(quaternion, timestamp = undefined) {
    this.quaternion = quaternion;
    this.timestamp = timestamp;
    for (const cb of this.listeners.reading || []) cb();
  }
  emitError(error = new Error('orientation error')) {
    for (const cb of this.listeners.error || []) cb(error);
  }
  static reset() { FakeAbsoluteOrientationSensor.instances = []; }
}

const BT_BASE_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const HR_SERVICE_UUID = `0000180d${BT_BASE_SUFFIX}`;
const HR_MEASUREMENT_UUID = `00002a37${BT_BASE_SUFFIX}`;
const RSC_SERVICE_UUID = `00001814${BT_BASE_SUFFIX}`;
const RSC_MEASUREMENT_UUID = `00002a53${BT_BASE_SUFFIX}`;

function normalizedUuid(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function isUuid(value, aliases) {
  return aliases.includes(normalizedUuid(value));
}

function missingGattMember(kind, uuid) {
  const error = new Error(`${kind} not found: ${String(uuid)}`);
  error.name = 'NotFoundError';
  return error;
}

function fakeNotifyCharacteristic(uuid) {
  return {
    uuid,
    listeners: {},
    value: null,
    startNotificationsCalls: 0,
    stopNotificationsCalls: 0,
    addEventListener(type, cb) { (this.listeners[type] ||= []).push(cb); },
    removeEventListener(type, cb) {
      this.listeners[type] = cb
        ? (this.listeners[type] || []).filter((listener) => listener !== cb)
        : [];
    },
    async startNotifications() { this.startNotificationsCalls += 1; return this; },
    async stopNotifications() { this.stopNotificationsCalls += 1; return this; },
    emitValue(value) {
      this.value = value instanceof Uint8Array ? value : new Uint8Array(value);
      for (const cb of this.listeners.characteristicvaluechanged || []) cb();
    },
  };
}

function fakeGattDevice({ id, name, server }) {
  const device = {
    id,
    name,
    listeners: {},
    addEventListener(type, cb) { (this.listeners[type] ||= []).push(cb); },
    removeEventListener(type, cb) {
      this.listeners[type] = (this.listeners[type] || []).filter((listener) => listener !== cb);
    },
    gatt: {
      connected: false,
      connectCalls: 0,
      disconnectCalls: 0,
      async connect() {
        this.connectCalls += 1;
        this.connected = true;
        return server;
      },
      disconnect() {
        this.disconnectCalls += 1;
        if (!this.connected) return;
        this.connected = false;
        for (const cb of [...(device.listeners.gattserverdisconnected || [])]) cb();
      },
    },
  };
  return device;
}

/**
 * 假 BLE 心率设备：只暴露标准 HRS 0x180D/0x2A37。
 * 可选 RSC 探测必须明确失败，防止测试替身把 HR characteristic 误当 0x2A53。
 */
export function fakeHrDevice(name = 'FakeHR') {
  const char = fakeNotifyCharacteristic(HR_MEASUREMENT_UUID);
  char.notify = function notify(bpm) {
    this.emitValue([0x00, bpm]);   // flags=0x00, uint8 bpm
  };

  const service = {
    async getCharacteristic(uuid) {
      if (isUuid(uuid, ['heart_rate_measurement', '2a37', HR_MEASUREMENT_UUID])) return char;
      throw missingGattMember('characteristic', uuid);
    },
  };
  const server = {
    getPrimaryServiceCalls: [],
    async getPrimaryService(uuid) {
      this.getPrimaryServiceCalls.push(uuid);
      if (isUuid(uuid, ['heart_rate', '180d', HR_SERVICE_UUID])) return service;
      throw missingGattMember('service', uuid);
    },
  };
  const device = fakeGattDevice({ id: 'fake-hr-1', name, server });
  return { device, char, hrChar: char, server };
}

/**
 * 假 HR+RSC 设备：同一 GATT 上暴露彼此独立的 2A37 与 2A53 characteristic。
 * rscChar.notify() 可接收原始字节，或标准 RSC 字段对象。对象中的
 * cadenceSpm 表示 UI 双脚总步频；cadenceFootfallsPerMin 可显式指定
 * 0x2A53 原始的单脚落地次数/分。
 */
export function fakeHrRscDevice(name = 'Fake HR+RSC') {
  const hrChar = fakeNotifyCharacteristic(HR_MEASUREMENT_UUID);
  hrChar.notify = function notify(bpm) {
    this.emitValue([0x00, bpm]);
  };

  const rscChar = fakeNotifyCharacteristic(RSC_MEASUREMENT_UUID);
  rscChar.notify = function notify(value = {}) {
    if (value instanceof Uint8Array || Array.isArray(value)) {
      this.emitValue(value);
      return;
    }
    const speedMps = Number.isFinite(value.speedMps) ? value.speedMps : 0;
    const cadenceFootfallsPerMin = Number.isFinite(value.cadenceFootfallsPerMin)
      ? value.cadenceFootfallsPerMin
      : (Number.isFinite(value.cadenceSpm) ? value.cadenceSpm / 2 : 0);
    const hasStride = Number.isFinite(value.strideLengthM);
    const hasDistance = Number.isFinite(value.totalDistanceM);
    let flags = value.running === true ? 0x04 : 0;
    if (hasStride) flags |= 0x01;
    if (hasDistance) flags |= 0x02;
    const speedRaw = Math.max(0, Math.min(0xffff, Math.round(speedMps * 256)));
    const bytes = [
      flags,
      speedRaw & 0xff,
      (speedRaw >>> 8) & 0xff,
      Math.max(0, Math.min(0xff, Math.round(cadenceFootfallsPerMin))),
    ];
    if (hasStride) {
      const strideRaw = Math.max(0, Math.min(0xffff, Math.round(value.strideLengthM * 100)));
      bytes.push(strideRaw & 0xff, (strideRaw >>> 8) & 0xff);
    }
    if (hasDistance) {
      const distanceRaw = Math.max(0, Math.min(0xffffffff, Math.round(value.totalDistanceM * 10)));
      bytes.push(
        distanceRaw & 0xff,
        (distanceRaw >>> 8) & 0xff,
        (distanceRaw >>> 16) & 0xff,
        (distanceRaw >>> 24) & 0xff,
      );
    }
    this.emitValue(bytes);
  };

  const hrService = {
    async getCharacteristic(uuid) {
      if (isUuid(uuid, ['heart_rate_measurement', '2a37', HR_MEASUREMENT_UUID])) return hrChar;
      throw missingGattMember('characteristic', uuid);
    },
  };
  const rscService = {
    async getCharacteristic(uuid) {
      if (isUuid(uuid, ['rsc_measurement', '2a53', RSC_MEASUREMENT_UUID])) return rscChar;
      throw missingGattMember('characteristic', uuid);
    },
  };
  const server = {
    getPrimaryServiceCalls: [],
    async getPrimaryService(uuid) {
      this.getPrimaryServiceCalls.push(uuid);
      if (isUuid(uuid, ['heart_rate', '180d', HR_SERVICE_UUID])) return hrService;
      if (isUuid(uuid, ['running_speed_and_cadence', '1814', RSC_SERVICE_UUID])) return rscService;
      throw missingGattMember('service', uuid);
    },
  };
  const device = fakeGattDevice({ id: 'fake-hr-rsc-1', name, server });
  return { device, char: hrChar, hrChar, rscChar, server };
}
