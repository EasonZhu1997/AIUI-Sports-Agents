import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadPageModule,
  instantiatePage,
  fakeWx,
  FakeAccelerometer,
  FakeAbsoluteOrientationSensor,
  FakeGyroscope,
} from './helpers/load_page.mjs';
import {
  BIKE_SETTINGS_KEY,
  writeBikeSettings,
} from '../lib/bike_settings.js';
import {
  readRideDevice,
} from '../lib/ride_devices.js';
import {
  LAST_RIDE_SUMMARY_KEY,
} from '../lib/ride_summary.js';
import {
  RIDE_HISTORY_KEY,
} from '../lib/ride_history.js';
import {
  RIDE_FINISHED_HINT_KEY,
  SCAN_EXIT_HINT_KEY,
} from '../lib/ride_surface.js';
import {
  CYCLING_UPLOAD_PATH,
  PENDING_CYCLING_UPLOAD_KEY,
} from '../lib/cycling_upload.js';
import {
  CYCLING_UPLOAD_BOOTSTRAP_PATH,
  CYCLING_UPLOAD_CREDENTIAL_KEY,
  CYCLING_UPLOAD_CREDENTIAL_PATH,
  CYCLING_UPLOAD_TOKEN_KEY,
} from '../lib/cycling_upload_auth.js';
import {
  CYCLING_LOCAL_FIELD_LOG_CHUNK_PREFIX,
  CYCLING_LOCAL_FIELD_LOG_KEY,
  readCyclingLocalFieldLog,
  readCyclingLocalFieldLogIndexResult,
} from '../lib/cycling_local_field_log.js';
import {
  SPORT_AGENT_DEBRIEF_CACHE_KEY,
  SPORT_AGENT_OUTBOX_KEY,
  buildSportAgentItemRequest,
  buildSportAgentEventMetrics,
  prepareSportAgentSession,
  readSportAgentActive,
  readSportAgentOutbox,
} from '../lib/sport_agent.js';
import {
  buildSportsOutboxRequest,
  enqueueSportsOutbox,
  readSportsOutbox,
} from '../lib/sports_outbox.js';
import { writeSportsIdentity } from '../lib/sports_identity.js';

const TEST_SPORTS_IDENTITY = Object.freeze({
  token: 't'.repeat(64),
  public_device_id: 'aibike-device-test',
  ownership_epoch: 1,
  data_namespace: 'aibike.owner.test',
});

const source = readFileSync(
  new URL('../pages/ride_hud/index.ink', import.meta.url),
  'utf8',
);
const pageDef = await loadPageModule('ride_hud');

let wx;
const pages = [];

class FakeSound {
  static instances = [];

  constructor(src) {
    this.src = src;
    this.volume = 1;
    this.playCalls = 0;
    this.stopCalls = 0;
    this.destroyCalls = 0;
    FakeSound.instances.push(this);
  }

  play() { this.playCalls += 1; }
  stop() { this.stopCalls += 1; }
  destroy() { this.destroyCalls += 1; }
}

function freshPage(query = {}, options = {}) {
  wx = fakeWx();
  globalThis.__pageWx = wx;
  globalThis.Sound = FakeSound;
  FakeSound.instances = [];
  FakeAccelerometer.reset();
  FakeGyroscope.reset();
  FakeAbsoluteOrientationSensor.reset();
  if (Object.prototype.hasOwnProperty.call(options, 'accelerometerCtor')) {
    globalThis.Accelerometer = options.accelerometerCtor;
  } else if (options.accelerometer) {
    globalThis.Accelerometer = FakeAccelerometer;
  } else {
    delete globalThis.Accelerometer;
  }
  if (options.gyroscope) globalThis.Gyroscope = FakeGyroscope;
  else delete globalThis.Gyroscope;
  if (options.orientation) {
    globalThis.AbsoluteOrientationSensor = FakeAbsoluteOrientationSensor;
  } else {
    delete globalThis.AbsoluteOrientationSensor;
  }
  if (Object.prototype.hasOwnProperty.call(options, 'navigator')) {
    Object.defineProperty(globalThis, 'navigator', {
      value: options.navigator,
      writable: true,
      configurable: true,
    });
  } else {
    delete globalThis.navigator;
  }
  const page = instantiatePage(pageDef);
  if (options.worldAwareness) {
    const harness = options.worldAwareness;
    harness.enableCalls = 0;
    harness.disableCalls = 0;
    harness.sensors = [];
    page.enableWorldAwareness = function enableWorldAwareness() {
      harness.enableCalls += 1;
      if (harness.enableThrows) throw new Error('world awareness unavailable');
      if (harness.missingSensor) return;
      const sensor = new FakeAbsoluteOrientationSensor({ frequency: 30 });
      if (harness.missingRemoveEventListener) {
        sensor.removeEventListener = undefined;
      }
      sensor.start();
      harness.sensors.push(sensor);
      this.orientationSensor = sensor;
    };
    page.disableWorldAwareness = function disableWorldAwareness() {
      harness.disableCalls += 1;
      if (harness.disableThrows) throw new Error('world awareness stop failed');
      const sensor = this.orientationSensor;
      if (sensor && typeof sensor.stop === 'function') sensor.stop();
    };
  }
  page.onLoad(query);
  pages.push(page);
  return page;
}

function releaseGesture(page) {
  page.menuEntryConfirmGuardUntilMs = Date.now() - 1;
  page.surfaceEntryConfirmGuardUntilMs = Date.now() - 1;
  page.lastSurfaceActivationAtMs = Date.now() - 1000;
}

function enableTestNetwork(page) {
  page.rideSettings = {
    ...page.rideSettings,
    networkSyncEnabled: true,
    networkBaseUrl: 'https://hermes.test',
  };
  return page;
}

async function prepareDurableSportAgent(page, options = {}) {
  const identity = writeSportsIdentity(wx, TEST_SPORTS_IDENTITY);
  const plan = options.plan || null;
  const planned = Boolean(plan && plan.workout_id);
  const mode = planned ? 'planned' : 'free';
  const workoutId = planned ? plan.workout_id : '';
  const clientSessionId = options.clientSessionId
    || (planned ? 'bike-session-page-planned-001' : 'bike-session-page-free-001');
  const capabilities = {
    heart_rate: options.heartRate === true,
    pace: false,
    cadence: options.cadence === true,
    speed: options.speed === true,
    power: options.power === true,
  };
  const owner = {
    public_device_id: identity.public_device_id,
    ownership_epoch: identity.ownership_epoch,
    data_namespace: identity.data_namespace,
  };
  const readiness = {
    schema_version: 1,
    status: options.readinessStatus || 'clear',
    reason_codes: options.readinessStatus === 'high_load' ? ['recent_high_load'] : [],
    source: 'history_only',
    launch_allowed: options.launchAllowed !== false,
  };
  const iteration = {
    schema_version: 1, strategy_version: 2, recent_sessions: 0,
    completed: 0, partial: 0, aborted: 0, safety_events: 0,
    completion_rate_pct: 0, plan_basis: 'starter',
    evidence_confidence: 'low', data_coverage: 'insufficient',
    reason_codes: ['first_rides'],
  };
  const supervision = {
    schema_version: 1, snapshot_max_age_ms: 15000,
    normal_cue_cooldown_s: 75, repeat_cue_cooldown_s: 180,
    safety_cue_cooldown_s: 20, minimum_evidence_s: 12,
  };
  const heartPolicy = {
    schema_version: 1, max_hr_bpm: 180, source: 'conservative_default',
    issued_at_ms: Date.now() - 1000, expires_at_ms: Date.now() + 3600000,
  };
  const executionStages = planned ? plan.stages.map((stage) => ({
    stage_id: stage.stage_id,
    duration_s: options.executionDurationS || stage.duration_sec,
    target: { kind: 'cycling', effort_min: 3, effort_max: 5 },
    source: options.executionDurationS && options.executionDurationS !== stage.duration_sec
      ? 'readiness_reduction' : 'capability_fallback',
    fallback: 'effort',
  })) : [];
  const shared = {
    schema_version: 1, context_version: 2, sport: 'cycling', mode,
    locale: 'zh-CN', prescription: plan || {}, capabilities,
    capability_hash: 'e'.repeat(64), readiness, iteration,
    execution_stages: executionStages, supervision_policy: supervision,
    heart_rate_policy: heartPolicy, ...owner,
  };
  const briefingId = 'sab_' + 'b'.repeat(24);
  const prepared = await prepareSportAgentSession({
    storage: wx,
    identity,
    mode,
    workoutId,
    workoutRevision: planned ? plan.revision : undefined,
    clientSessionId,
    heartRate: options.heartRate === true,
    cadence: options.cadence === true,
    speed: options.speed === true,
    power: options.power === true,
    async request(requestOptions) {
      if (/\/briefing$/.test(requestOptions.url)) return {
        statusCode: 200,
        data: {
          ...shared, briefing_id: briefingId,
          title: planned ? plan.title : '自由骑',
          rationale: planned ? plan.rationale : '稳定记录本次自由骑。',
        },
      };
      return {
        statusCode: 200,
        data: {
          ...shared, session_id: 'sas_' + 'c'.repeat(24),
          client_session_id: clientSessionId, briefing_id: briefingId,
          ...(planned ? { workout_id: workoutId } : {}), duplicate: false,
        },
      };
    },
  });
  assert.ok(prepared, '真实 Sport Agent fixture 必须先持久化 session_ready');
  page.sportsIdentity = identity;
  page.pendingSportsPlan = plan;
  page.pendingSportAgent = {
    identity, mode, workoutId, clientSessionId,
    briefing: prepared.briefing, session: prepared.session,
  };
  return prepared;
}

function sportAgentDebriefAck(completion, overrides = {}) {
  const nextTraining = {
    schema_version: 2, strategy_version: 2, direction: 'hold',
    recommended_mode: 'endurance', duration_sec: 1200,
    reason_codes: ['partial_completion'], confidence: 'medium',
    evidence_count: 1, message: '下次保持稳定踩踏。',
  };
  return {
    schema_version: 1, debrief_id: 'sad_' + 'd'.repeat(24),
    session_id: completion.session_id, locale: 'zh-CN',
    client_completion_id: completion.client_completion_id,
    client_activity_id: completion.client_activity_id,
    client_run_id: null, duplicate: false,
    status: 'local_ready', memory_status: 'skipped_no_consent',
    canonical_summary: completion.summary,
    review: {
      schema_version: 1, headline: '本地总结已完成', detail: '本次骑行已经整理。',
      focus: '下次保持均匀踩踏。', load_direction: 'hold',
      next_training: nextTraining,
      evidence: { canonical: true, duration_s: completion.duration_s },
    },
    next_training: nextTraining,
    public_device_id: TEST_SPORTS_IDENTITY.public_device_id,
    ownership_epoch: TEST_SPORTS_IDENTITY.ownership_epoch,
    data_namespace: TEST_SPORTS_IDENTITY.data_namespace,
    ...overrides,
  };
}

function yawQuaternion(radians) {
  return [0, 0, Math.sin(radians / 2), Math.cos(radians / 2)];
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function assertPositiveDisplay(value) {
  assert.doesNotMatch(value, /\u2248/u);
  assert.ok(Number(value) > 0, `应显示正数，实际为 ${String(value)}`);
}

function fakeGeolocation() {
  let nextWatchId = 1;
  return {
    watchCalls: [],
    clearCalls: [],
    watchPosition(onPosition, onError, options) {
      const id = nextWatchId;
      nextWatchId += 1;
      this.watchCalls.push({
        id,
        onPosition,
        onError,
        options: { ...options },
      });
      return id;
    },
    clearWatch(id) {
      this.clearCalls.push(id);
    },
    emit(callIndex, {
      latitude,
      longitude,
      accuracy = 2,
      timestamp,
    }) {
      const call = this.watchCalls[callIndex];
      if (!call) throw new Error(`missing geolocation watch ${callIndex}`);
      call.onPosition({
        coords: { latitude, longitude, accuracy },
        timestamp,
      });
    },
    emitError(callIndex, code) {
      const call = this.watchCalls[callIndex];
      if (!call) throw new Error(`missing geolocation watch ${callIndex}`);
      call.onError({ code });
    },
  };
}

function fakeWeatherGeolocation() {
  const geolocation = fakeGeolocation();
  geolocation.currentCalls = [];
  geolocation.getCurrentPosition = function getCurrentPosition(
    onPosition,
    onError,
    options,
  ) {
    this.currentCalls.push({
      onPosition,
      onError,
      options: { ...options },
    });
  };
  geolocation.resolveCurrent = function resolveCurrent(callIndex, {
    latitude,
    longitude,
    accuracy = 8,
    timestamp = Date.now(),
  }) {
    const call = this.currentCalls[callIndex];
    if (!call) throw new Error(`missing current geolocation ${callIndex}`);
    call.onPosition({
      coords: { latitude, longitude, accuracy },
      timestamp,
    });
  };
  geolocation.rejectCurrent = function rejectCurrent(callIndex, code) {
    const call = this.currentCalls[callIndex];
    if (!call) throw new Error(`missing current geolocation ${callIndex}`);
    call.onError({ code });
  };
  return geolocation;
}

function flakyRestartGeolocation(failureMode) {
  let nextWatchId = 1;
  let callCount = 0;
  return {
    watchCalls: [],
    clearCalls: [],
    watchPosition(onPosition, onError, options) {
      callCount += 1;
      const call = {
        id: null,
        onPosition,
        onError,
        options: { ...options },
      };
      this.watchCalls.push(call);
      if (callCount === 2) {
        if (failureMode === 'throw') throw new Error('bridge restart failed');
        return null;
      }
      const id = nextWatchId;
      nextWatchId += 1;
      call.id = id;
      return id;
    },
    clearWatch(id) {
      this.clearCalls.push(id);
    },
  };
}

function fakeCharacteristic() {
  const listeners = new Set();
  return {
    listeners,
    value: null,
    startCalls: 0,
    stopCalls: 0,
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
    async startNotifications() { this.startCalls += 1; },
    async stopNotifications() { this.stopCalls += 1; },
    emit(value) {
      this.value = value;
      for (const listener of [...listeners]) listener({ target: this });
    },
  };
}

function cscOnlyServer(characteristic = fakeCharacteristic()) {
  return {
    characteristic,
    connected: true,
    disconnectCalls: 0,
    async getPrimaryService(uuid) {
      if (!String(uuid).includes('1816')) throw new Error('unsupported');
      return {
        async getCharacteristic(uuidValue) {
          if (!String(uuidValue).includes('2a5b')) throw new Error('unsupported');
          return characteristic;
        },
      };
    },
    async disconnect() {
      this.disconnectCalls += 1;
      this.connected = false;
    },
  };
}

function hrsOnlyServer(characteristic = fakeCharacteristic()) {
  return {
    characteristic,
    connected: true,
    disconnectCalls: 0,
    async getPrimaryService(uuid) {
      if (!String(uuid).includes('180d')) throw new Error('unsupported');
      return {
        async getCharacteristic(uuidValue) {
          if (!String(uuidValue).includes('2a37')) throw new Error('unsupported');
          return characteristic;
        },
      };
    },
    async disconnect() {
      this.disconnectCalls += 1;
      this.connected = false;
    },
  };
}

after(() => {
  for (const page of pages) {
    try { page.onUnload(); } catch (_error) {}
  }
  delete globalThis.__pageWx;
  delete globalThis.Sound;
  delete globalThis.Accelerometer;
  delete globalThis.Gyroscope;
  delete globalThis.AbsoluteOrientationSensor;
  delete globalThis.navigator;
});

test('页面是 AIBike AI 骑行，中文可见内容不含跑步或 ID 绑定', () => {
  assert.match(source, /"navigationBarTitleText": "AIBike AI 骑行"/);
  assert.match(source, />AI 骑行</);
  assert.match(source, /自由骑行，智能相伴/);
  assert.match(source, /踏频 rpm/);
  assert.match(source, /class="bike-logo"/);
  assert.match(source, /class="bike-logo-text">AB<\/text>/);
  assert.doesNotMatch(source, /aibike-cyclist-48|assets\/warmup|\.gif\b/i);
  assert.doesNotMatch(source, /\u2248/u);
  assert.doesNotMatch(
    source,
    /device_identity|coach_api|run_upload|run_summary|surface_resume|RSC|1814|2a53|绑定|跑步|步频|自由跑/i,
  );
});

test('用户指标槽不再硬编码裸零、横线或工程帧数', () => {
  assert.doesNotMatch(
    source,
    /(?:speed|cadence|distance|heartRate|power|sumSpeed|sumCadence|sumDistance|sumHeartRate|sumPower):\s*['"](?:--|0|0\.0|0\.00)['"]/,
  );
  assert.doesNotMatch(source, /IMU 0帧|A\d+\/G\d+帧/);
  assert.match(source, /估算中/);
  assert.match(source, /识别中/);
  assert.match(source, /待起步/);
});

test('设备连接页不泄漏 keydown 或生命周期诊断标记', () => {
  for (const marker of ['keyBeacon', 'markBeacon', 'beacon-hint']) {
    assert.ok(!source.includes(marker), `生产页不应包含 ${marker}`);
  }
  assert.doesNotMatch(source, /markBeacon\(['"](?:L|R|S|KD)['"]\)/);

  const page = freshPage();
  page.recordDiscoveredDevice({ id: 'sensor-1', name: 'Bike Sensor' });
  const visibleBefore = JSON.stringify(page.data);
  page.onKeyDown({ code: 'ArrowDown' });
  assert.equal(JSON.stringify(page.data), visibleBefore, 'keydown 不得写入可见状态');

  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.searchFocusIndex, 1, 'keyup 仍应正常移动设备焦点');
  assert.ok(!Object.prototype.hasOwnProperty.call(page.data, 'keyBeacon'));
  page.onUnload();
});

test('防御性 IMU 小数候选不会舍入成 0rpm 给用户', () => {
  const page = freshPage();
  page.imuDiagnosticState = 'running';
  page.imuReadingCount = 1;
  page.gyroscopeReadingCount = 1;
  page.imuObservedHz = 20;
  const status = page.formatRideImuStatus({
    candidateCadenceRpm: 0.4,
    simpleGyroCadenceFresh: true,
    accelerationCalibrated: true,
  });
  assert.doesNotMatch(status, /0rpm/);
  page.onUnload();
});

test('总结页缩短折线图并为建议、趋势和来源保留足够高度', () => {
  assert.match(source, /\.summary-chart-card\s*\{[^}]*height:\s*64px/s);
  assert.match(source, /\.summary-chart\s*\{[^}]*height:\s*34px/s);
  assert.match(source, /\.summary-advice\s*\{[^}]*height:\s*98px/s);
  assert.match(source, /class="summary-chart"[\s\S]*height="34"/);
});

test('只订阅标准骑行服务：HRS、CSC、Cycling Power 与 FTMS', () => {
  for (const uuid of ['180d', '2a37', '1816', '2a5b', '1818', '2a63', '1826', '2ad2']) {
    assert.match(source.toLowerCase(), new RegExp(uuid));
  }
  assert.doesNotMatch(source.toLowerCase(), /1814|2a53/);
  assert.match(source, /onCsc/);
  assert.match(source, /onCyclingPower/);
  assert.match(source, /onFtms/);
});

test('菜单、设置、搜索、HUD 与总结保留完整硬件焦点生命周期', () => {
  const page = freshPage({ mode: 'menu' });
  assert.equal(page.data.surfacePhase, 'menu');
  assert.equal(page.data.menuHasWorkout, false);
  assert.equal(page.menuFocusIndex, 1);

  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 2);
  releaseGesture(page);
  page.onKeyUp({ code: 'Enter', preventDefault() {} });
  assert.equal(page.data.surfacePhase, 'settings');

  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.settingFocusIndex, 1);
  let prevented = false;
  page.onKeyUp({
    code: 'Backspace',
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(page.data.surfacePhase, 'menu');
});

test('进入自由骑前先展示拉伸动作，完成或跳过后才进入设备准备页', () => {
  const page = freshPage({ mode: 'menu' });
  releaseGesture(page);
  assert.equal(page.openFreeRideMode(), true);
  assert.equal(page.data.surfacePhase, 'warmup');
  assert.equal(page.data.warmupTitle, '肩胸打开');
  assert.equal(page.data.warmupRemaining, '准备');
  assert.equal(page.data.warmupImage, '');
  assert.match(source, /class="warmup-figure"/);
  assert.match(source, /class="warmup-figure-label">跟随文字动作<\/text>/);
  assert.match(
    source,
    /<view class="warmup-nav" role="navigation">[\s\S]*class="warmup-primary[\s\S]*class="warmup-skip/,
  );
  assert.doesNotMatch(source, /class="stretch-figure|class="figure-(?:head|torso|arm|leg|floor)/);

  releaseGesture(page);
  assert.equal(page.onWarmupPrimaryTap(), true);
  assert.equal(page.warmupStarted, true);
  const firstStepEnd = page.warmupStepEndsAtMs;
  page.tickWarmupRoutine(firstStepEnd + 1);
  assert.equal(page.warmupStepIndex, 1);
  assert.equal(page.data.warmupTitle, '髋屈肌伸展');
  assert.equal(page.data.warmupImage, '');

  releaseGesture(page);
  assert.equal(page.skipWarmup(), true);
  assert.equal(page.data.surfacePhase, 'ready');
  page.onUnload();
});

test('骑前拉伸确认后按绝对时间自动切四项，末项归零只进入一次设备准备', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage({ mode: 'menu' });
  t.after(() => page.onUnload());
  releaseGesture(page);
  assert.equal(page.openFreeRideMode(), true);
  assert.equal(page.data.warmupOverview, '4项 · 每项20秒 · 共80秒');
  let preparationCalls = 0;
  const enterRidePreparation = page.enterRidePreparation.bind(page);
  page.enterRidePreparation = (...args) => {
    preparationCalls += 1;
    return enterRidePreparation(...args);
  };
  releaseGesture(page);
  assert.equal(page.onWarmupPrimaryTap(), true);
  t.mock.timers.tick(0);
  assert.match(wx.ttsSpoken[0], /四个动作.*第一项/s);

  for (const expected of [1, 2, 3]) {
    t.mock.timers.tick(20_000);
    assert.equal(page.warmupStepIndex, expected);
    assert.equal(page.data.surfacePhase, 'warmup');
  }
  t.mock.timers.tick(20_000);
  assert.equal(page.data.surfacePhase, 'ready');
  assert.equal(preparationCalls, 1);
  assert.equal(page.warmupTimer, null);
  t.mock.timers.tick(2_000);
  assert.equal(page.data.surfacePhase, 'ready', '迟到 tick 不得重复切页');
  assert.equal(preparationCalls, 1, '手动尾包与迟到 tick 不得重复进入准备');
});

test('骑前拉伸隐藏时暂停，恢复后从保留秒数继续且不播迟到语音', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage({ mode: 'menu' });
  t.after(() => page.onUnload());
  releaseGesture(page);
  page.openFreeRideMode();
  releaseGesture(page);
  page.onWarmupPrimaryTap();
  t.mock.timers.tick(5_000);
  const spokenAtHide = wx.ttsSpoken.length;
  page.onHide();
  const remainingAtHide = page.warmupRemainingSeconds;
  assert.ok(remainingAtHide >= 14 && remainingAtHide <= 15);
  t.mock.timers.tick(30_000);
  assert.equal(page.warmupStepIndex, 0);
  assert.equal(page.warmupRemainingSeconds, remainingAtHide);
  assert.equal(wx.ttsSpoken.length, spokenAtHide);

  page.onShow();
  assert.equal(page.warmupPausedByHide, false);
  t.mock.timers.tick(remainingAtHide * 1000);
  assert.equal(page.warmupStepIndex, 1);
});

test('骑前跳过按钮可由方向和确认键触达，骑后放松由总结前划进入', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage({ mode: 'menu' });
  t.after(() => page.onUnload());
  releaseGesture(page);
  page.openFreeRideMode();
  releaseGesture(page);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.guideFocusIndex, 1);
  releaseGesture(page);
  page.onKeyUp({ code: 'Enter', preventDefault() {} });
  assert.equal(page.data.surfacePhase, 'ready');

  page.summaryEnteredAtMs = Date.now() - 1000;
  page.summaryPersistenceConfirmed = true;
  page.setData({ surfacePhase: 'summary' });
  page.onKeyUp({ code: 'ArrowRight', preventDefault() {} });
  assert.equal(page.data.surfacePhase, 'recovery');
  assert.equal(page.data.warmupHeading, '骑后放松');
  assert.equal(page.data.warmupOverview, '4项 · 每项15秒 · 共1分钟');
});

test('骑前真机 GlobalHook→方向只移动焦点，独立稳定确认可立即跳过', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const confirmCode of ['Enter', 'NumpadEnter', 'Space']) {
    const page = freshPage({ mode: 'menu' });
    page.setMenuFocus(1);
    page.onKeyUp({ code: 'Enter', preventDefault() {} });
    assert.equal(page.data.surfacePhase, 'warmup');
    t.mock.timers.tick(701);

    page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
    assert.ok(page.pendingSurfaceGlobalHookTimer);
    page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
    assert.equal(page.guideFocusIndex, 1);
    assert.equal(page.warmupStarted, false, '方向手势不得先触发主动作');
    assert.equal(page.pendingSurfaceGlobalHookTimer, null, '方向码应取消待定轻触');

    page.onKeyUp({ code: confirmCode, preventDefault() {} });
    assert.equal(
      page.data.surfacePhase,
      'ready',
      confirmCode + ' 应作为下一次独立确认立即执行跳过',
    );
    t.mock.timers.tick(650);
    assert.equal(page.data.surfacePhase, 'ready', '已取消的 GlobalHook 不得迟到触发');
    page.onUnload();
  }
});

test('骑前同一次物理确认的 GlobalHook 与 Enter 尾包只执行一次', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage({ mode: 'menu' });
  t.after(() => page.onUnload());
  page.setMenuFocus(1);
  page.onKeyUp({ code: 'Enter', preventDefault() {} });
  assert.equal(page.data.surfacePhase, 'warmup');
  t.mock.timers.tick(701);

  let primaryCalls = 0;
  const onWarmupPrimaryTap = page.onWarmupPrimaryTap.bind(page);
  page.onWarmupPrimaryTap = (...args) => {
    primaryCalls += 1;
    return onWarmupPrimaryTap(...args);
  };

  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  assert.equal(page.warmupStarted, false, 'GlobalHook 先等待方向判别');
  page.onKeyUp({ code: 'Enter', preventDefault() {} });
  assert.equal(page.warmupStarted, true);
  assert.equal(page.warmupStepIndex, 0, '确认别名尾包不得直接跳到第二项');
  assert.equal(primaryCalls, 1);
  t.mock.timers.tick(650);
  assert.equal(primaryCalls, 1, '被 Enter 接管后待定 GlobalHook 不得再次执行');
});

test('自动换步后排队的 350ms 动作语音在隐藏时被 generation fence 取消', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage({ mode: 'menu' });
  t.after(() => page.onUnload());
  releaseGesture(page);
  page.openFreeRideMode();
  releaseGesture(page);
  page.onWarmupPrimaryTap();
  t.mock.timers.tick(0);
  const spokenBeforeStepChange = wx.ttsSpoken.length;

  t.mock.timers.tick(20_000);
  assert.equal(page.warmupStepIndex, 1);
  page.onHide();
  t.mock.timers.tick(1_000);
  assert.equal(wx.ttsSpoken.length, spokenBeforeStepChange);
});

test('骑后放松自动完成后停留等待确认，Back 可逐项并返回总结', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  page.summaryEnteredAtMs = Date.now() - 1000;
  page.summaryPersistenceConfirmed = true;
  page.setData({ surfacePhase: 'summary' });
  assert.equal(page.startRecoveryGuide(), true);
  t.mock.timers.tick(15_000);
  assert.equal(page.warmupStepIndex, 1);
  assert.equal(page.onRideGuideBack(), true);
  assert.equal(page.warmupStepIndex, 0);
  assert.equal(page.onRideGuideBack(), true);
  assert.equal(page.data.surfacePhase, 'summary');

  assert.equal(page.startRecoveryGuide(), true);
  for (let index = 0; index < 4; index += 1) t.mock.timers.tick(15_000);
  assert.equal(page.data.surfacePhase, 'recovery');
  assert.equal(page.warmupCompleted, true);
  assert.equal(page.data.warmupRemaining, '完成');
  assert.match(page.data.warmupStatus, /确认退出/);
  assert.equal(page.agentExitRequested, false, '放松归零不能自动关闭');
  assert.equal(page.onWarmupPrimaryTap(), true);
  assert.equal(page.agentExitRequested, true);
});

test('进入骑后放松会撤销旧的待退出意图，并阻止总结 AI 在动画中重启', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  page.summaryEnteredAtMs = Date.now() - 1000;
  page.summaryPersistenceConfirmed = false;
  page.summaryExitPending = true;
  page.pendingSummaryExitSource = 'summary-backspace';
  page.setData({ surfacePhase: 'summary' });

  assert.equal(page.startRecoveryGuide(), true);
  assert.equal(page.summaryExitPending, false);
  assert.equal(page.pendingSummaryExitSource, '');
  assert.equal(page.startSummaryAiAdvice({ elapsedSec: 120 }, { sourceNote: '' }), false);
  assert.equal(page.summaryAiStartTimer, null);
});

test('骑后最后一项手动确认先进入完成态，必须再独立确认才退出', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  page.summaryEnteredAtMs = Date.now() - 1000;
  page.summaryPersistenceConfirmed = true;
  page.setData({ surfacePhase: 'summary' });
  page.startRecoveryGuide();
  for (let index = 0; index < 3; index += 1) t.mock.timers.tick(15_000);
  assert.equal(page.warmupStepIndex, 3);

  releaseGesture(page);
  assert.equal(page.onWarmupPrimaryTap(), true);
  assert.equal(page.warmupCompleted, true);
  assert.equal(page.agentExitRequested, false);
  releaseGesture(page);
  assert.equal(page.onWarmupPrimaryTap(), true);
  assert.equal(page.agentExitRequested, true);
});

test('骑行主 HUD 恢复为 SmartRun 同结构的单一底部紧凑布局', () => {
  const templateStart = source.indexOf('    <view class="hud-wrap"');
  const templateEnd = source.indexOf('</page>', templateStart);
  const cssStart = source.indexOf('.hud-wrap {');
  const cssEnd = source.indexOf('</style>', cssStart);
  assert.ok(templateStart >= 0 && templateEnd > templateStart);
  assert.ok(cssStart >= 0 && cssEnd > cssStart);

  const template = source.slice(templateStart, templateEnd);
  assert.equal((template.match(/class="ride-screen"/g) || []).length, 1);
  assert.match(template, /class="unified-grid" ink:if="\{\{ showHeartRate \}\}"/);
  assert.match(template, /class="glasses-grid" ink:if="\{\{ !showHeartRate \}\}"/);
  assert.match(template, /\{\{\s*heartRate\s*\}\}/);
  assert.match(template, /\{\{\s*cadence\s*\}\}/);
  assert.match(template, /\{\{\s*distance\s*\}\}/);
  assert.match(template, /\{\{\s*elapsed\s*\}\}/);
  assert.match(template, /\{\{\s*speed\s*\}\}/);
  assert.equal((template.match(/class="\{\{\s*dot[1-5]\s*\}\}"/g) || []).length, 5);
  assert.doesNotMatch(template, /data-layout-id|hudSkin|hud-layout-(?:aero|atelier|tempo|horizon|noir)/);

  const css = source.slice(cssStart, cssEnd);
  assert.match(css, /\.ride-screen\s*\{[\s\S]*?justify-content:\s*flex-end;[\s\S]*?height:\s*348px;/);
  assert.match(css, /\.hud-top\s*\{[\s\S]*?height:\s*26px;/);
  assert.match(css, /\.unified-grid,[\s\S]*?height:\s*76px;/);
  assert.match(css, /\.unified-grid\s*\{[\s\S]*?grid-template-columns:\s*14px 68px 60px 80px 94px 115px;/);
  assert.match(css, /\.glasses-grid\s*\{[\s\S]*?grid-template-columns:\s*84px 92px 116px 149px;/);
  assert.doesNotMatch(css, /@keyframes|animation\s*:|(?:linear|radial)-gradient|box-shadow\s*:|filter\s*:/i);
});

test('设置包含骑行参数与本地诊断回放，不存在绑定或 HUD 皮肤入口', () => {
  const page = freshPage({ mode: 'settings' });
  assert.equal((source.match(/class="setting-row /g) || []).length, 8);
  assert.match(source, />轮周</);
  assert.match(source, />心率设备</);
  assert.match(source, />最大心率</);
  assert.match(source, />FTP</);
  assert.match(source, />骑行目标</);
  assert.match(source, />语音提示</);
  assert.match(source, />踏频提示</);
  assert.match(source, />本地诊断</);
  assert.doesNotMatch(source, />HUD 皮肤</);

  releaseGesture(page);
  const beforeWheel = page.rideSettings.wheelCircumferenceMm;
  assert.equal(page.onSettingTap({
    currentTarget: { dataset: { setting: 'wheel', index: 0 } },
  }), true);
  assert.notEqual(page.rideSettings.wheelCircumferenceMm, beforeWheel);
  assert.ok(wx.store.has(BIKE_SETTINGS_KEY));

  releaseGesture(page);
  assert.equal(page.onSettingTap({
    currentTarget: { dataset: { setting: 'cadence', index: 6 } },
  }), true);
  assert.equal(page.rideSettings.cadenceToneRpm, 80);
  assert.match(page.data.settingsSaveState, /试听 80 RPM/);
  assert.ok(FakeSound.instances[0].playCalls >= 1);
  assert.match(FakeSound.instances[0].src, /metro_0468_bar_80\.wav$/);
  assert.equal(page.cadenceTone.beatsPerPlayback, 4);
  releaseGesture(page);
  assert.equal(page.onSettingTap({
    currentTarget: { dataset: { setting: 'cadence', index: 6 } },
  }), true);
  assert.equal(page.rideSettings.cadenceToneRpm, 90);
  assert.equal(FakeSound.instances.length, 2);
  assert.match(FakeSound.instances[1].src, /metro_0468_bar_90\.wav$/);

});

test('关闭独立心率搜索后仍搜索 CSC、功率计和骑行台', async () => {
  const page = freshPage();
  page.rideSettings = writeBikeSettings(wx, {
    ...page.rideSettings,
    autoHeartRate: false,
  });
  let scanOptions = null;
  globalThis.navigator = {
    bluetooth: {
      async scanDevices(options) {
        scanOptions = options;
        return {
          onDeviceFound() {},
          offDeviceFound() {},
          stop() {},
        };
      },
    },
  };

  assert.equal(await page.startDiscovery(), true);
  const services = scanOptions.filters.flatMap((filter) => filter.services);
  assert.equal(services.some((uuid) => uuid.includes('180d')), false);
  assert.equal(services.some((uuid) => uuid.includes('1816')), true);
  assert.equal(services.some((uuid) => uuid.includes('1818')), true);
  assert.equal(services.some((uuid) => uuid.includes('1826')), true);
  page.stopScan();
});

test('骑中 TTS 暂停踏频节拍并在短句后有界恢复，隐藏会取消恢复', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  page.rideSettings = writeBikeSettings(wx, {
    ...page.rideSettings,
    cadenceToneRpm: 80,
    voiceCue: true,
  });
  assert.equal(page.startRide(), true);
  const sound = FakeSound.instances[0];
  assert.ok(sound);
  assert.ok(sound.stopCalls >= 1, '开始语音前应先停节拍');
  assert.notEqual(page.ttsCadenceResumeTimer, null);
  const beforeResume = sound.playCalls;
  t.mock.timers.tick(5000);
  assert.ok(sound.playCalls > beforeResume, '短句结束预算后应恢复节拍');

  page.speakCue('继续稳定踩踏。');
  assert.notEqual(page.ttsCadenceResumeTimer, null);
  page.onHide();
  assert.equal(page.ttsCadenceResumeTimer, null);
  page.onUnload();
});

test('AIUI 0.15 TTS 返回空串时立即恢复踏频节拍', () => {
  const page = freshPage();
  page.rideSettings = writeBikeSettings(wx, {
    ...page.rideSettings,
    cadenceToneRpm: 80,
    voiceCue: true,
  });
  assert.equal(page.startRide(), true);
  page.clearTtsRuntime({ resetDedupe: true });
  page.stopCadenceCue();
  assert.equal(page.startRideCadenceCue(), true);
  const sound = page.cadenceTone._sound;
  const playCalls = sound.playCalls;
  wx.speech.playTTS = () => '';
  assert.equal(page.speakCue('保持踏频。'), false);
  assert.equal(page.ttsCadenceResumeTimer, null);
  assert.equal(page.ttsInFlightTimer, null);
  assert.equal(page.ttsInFlightUntilMs, null);
  assert.equal(page.ttsLastAcceptedText, '');
  assert.ok(sound.playCalls > playCalls, '创建 TTS 失败后应同步恢复节拍');
  page.onUnload();
});

test('AIUI 0.15 TTS uses a bounded flight and same-text dedupe', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  page.rideSettings = writeBikeSettings(wx, {
    ...page.rideSettings,
    cadenceToneRpm: 0,
    voiceCue: true,
  });

  assert.equal(page.speakCue('保持踏频。'), true);
  assert.equal(page.speakCue('保持踏频。'), false);
  assert.equal(page.speakCue('注意路况。'), false, 'different text must not overlap a flight');
  assert.equal(wx.ttsSpoken.length, 1);
  assert.notEqual(page.ttsInFlightTimer, null);

  t.mock.timers.tick(5000);
  assert.equal(page.ttsInFlightTimer, null, 'short cue flight floor is 5 seconds');
  assert.equal(page.speakCue('保持踏频。'), false, 'same text still passes dedupe after flight');
  t.mock.timers.tick(3000);
  assert.equal(page.speakCue('保持踏频。'), true);
  assert.equal(wx.ttsSpoken.length, 2);

  page.onHide();
  assert.equal(page.ttsInFlightTimer, null, 'hide clears TTS flight timer');
  assert.equal(page.ttsInFlightUntilMs, null);
  page.onUnload();
});

test('AIUI 0.15 long TTS flight is capped at 8 seconds', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  page.rideSettings = writeBikeSettings(wx, {
    ...page.rideSettings,
    cadenceToneRpm: 0,
    voiceCue: true,
  });
  assert.equal(page.speakCue(
    '安全骑行。'.repeat(20),
  ), true);
  t.mock.timers.tick(7999);
  assert.notEqual(page.ttsInFlightTimer, null);
  t.mock.timers.tick(1);
  assert.equal(page.ttsInFlightTimer, null);
  page.onUnload();
});

test('骑行开始只启动 BLE、IMU 与 ticker，不创建持续定位 watch', async () => {
  const geolocation = fakeGeolocation();
  const page = freshPage({}, {
    navigator: { geolocation },
  });
  assert.equal(geolocation.watchCalls.length, 0);

  assert.equal(page.onScanTap(), true);
  assert.equal(page.data.primaryLabel, '下一步');
  assert.equal(geolocation.watchCalls.length, 0);

  releaseGesture(page);
  assert.equal(page.onScanTap(), true);
  assert.equal(await page.sportAgentStartFlight, true);
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.rideSessionActive, true);
  assert.equal(geolocation.watchCalls.length, 0);
  assert.equal(page.rideGeolocationWatch, undefined);
  page.onUnload();
});

test('页面不提供定位或天气入口，环境栏只显示本地时间', () => {
  const page = freshPage();
  assert.match(page.data.hudEnvironment, /^\d{2}:\d{2}$/);
  assert.equal(page.refreshHudWeather, undefined);
  assert.equal(page.requestHudWeatherGeolocation, undefined);
  assert.doesNotMatch(source, /navigator\.geolocation|wx\.getLocation|天气|Weather/);
  page.onUnload();
});

test('下一步完成 JIT 后启动，AR hide 停止旧 IMU，show 用新 generation 恢复', async (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1000000,
  });
  const geolocation = fakeGeolocation();
  const page = freshPage({}, {
    accelerometer: true,
    gyroscope: true,
    navigator: { geolocation },
  });
  page.scanAttempted = true;

  assert.equal(await page.proceedToHud(), true);
  const metrics = page.metrics;
  const accelerometer = page.accelerometer;
  const gyroscope = page.gyroscope;
  const classifier = page.imuClassifier;
  const generation = page.imuGeneration;
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.rideSessionActive, true);
  assert.ok(metrics);
  assert.ok(accelerometer);
  assert.ok(gyroscope);
  assert.ok(page.tickTimer);
  assert.equal(geolocation.watchCalls.length, 0);

  page.onHide();
  assert.equal(page.metrics, metrics);
  assert.equal(page.metrics.paused, true);
  assert.equal(accelerometer.stopped, true);
  assert.equal(gyroscope.stopped, true);
  assert.equal(page.accelerometer == null, true);
  assert.equal(page.gyroscope == null, true);
  assert.equal(page.imuClassifier, null);
  assert.equal(page.tickTimer, null);

  page.onShow();
  assert.equal(page.metrics, metrics);
  assert.equal(page.metrics.paused, false);
  assert.ok(page.accelerometer);
  assert.ok(page.gyroscope);
  assert.notEqual(page.accelerometer, accelerometer);
  assert.notEqual(page.gyroscope, gyroscope);
  assert.notEqual(page.imuClassifier, classifier);
  assert.ok(page.imuGeneration > generation);
  assert.ok(page.tickTimer);
  assert.equal(geolocation.watchCalls.length, 0);

  const resumedAccelerometer = page.accelerometer;
  const resumedGyroscope = page.gyroscope;
  const resumedGeneration = page.imuGeneration;
  const resumedTicker = page.tickTimer;
  page.onShow();
  assert.equal(page.accelerometer, resumedAccelerometer);
  assert.equal(page.gyroscope, resumedGyroscope);
  assert.equal(page.imuGeneration, resumedGeneration);
  assert.equal(page.tickTimer, resumedTicker, '重复 onShow 不得重建 ticker');
  page.onUnload();
});

test('hide 30 秒冻结净时长，show 新句柄首帧不补距离', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1050000,
  });
  const page = freshPage({}, {
    accelerometer: true,
    gyroscope: true,
    orientation: true,
  });
  page.rideSettings = {
    ...page.rideSettings,
    voiceCue: false,
    cadenceToneRpm: 0,
  };
  assert.equal(page.startRide(), true);
  const oldGeneration = page.imuGeneration;
  const oldAccelerometer = page.accelerometer;
  const oldGyroscope = page.gyroscope;

  t.mock.timers.tick(2000);
  const beforeHideElapsedMs = page.metrics.snapshot(Date.now()).elapsedMs;
  page.onHide();
  const pausedElapsedMs = page.metrics.snapshot(Date.now()).elapsedMs;
  assert.equal(pausedElapsedMs, beforeHideElapsedMs);
  assert.equal(page.metrics.paused, true);
  assert.equal(oldAccelerometer.stopped, true);
  assert.equal(oldGyroscope.stopped, true);
  assert.equal(page.accelerometer, null);
  assert.equal(page.gyroscope, null);

  oldAccelerometer.emitEventReading(0, 0, 9.80665, Date.now());
  oldGyroscope.emitEventReading(0.01, 0.02, 0.03, Date.now());
  assert.equal(page.imuReadingCount, 0, '隐藏后旧 Accel 迟到帧必须拒绝');
  assert.equal(page.gyroscopeReadingCount, 0, '隐藏后旧 Gyro 迟到帧必须拒绝');

  t.mock.timers.tick(30000);
  assert.equal(
    page.metrics.snapshot(Date.now()).elapsedMs,
    pausedElapsedMs,
    '隐藏 30 秒不能补算进骑行时长',
  );

  page.onShow();
  assert.equal(page.metrics.paused, false);
  assert.ok(page.imuGeneration > oldGeneration);
  assert.ok(page.accelerometer);
  assert.ok(page.gyroscope);
  assert.notEqual(page.accelerometer, oldAccelerometer);
  assert.notEqual(page.gyroscope, oldGyroscope);
  assert.equal(page.metrics.snapshot(Date.now()).elapsedMs, pausedElapsedMs);

  const distanceBeforeFirstFrame = page.metrics.snapshot(Date.now()).distanceM;
  page.accelerometer.emitEventReading(0, 0, 9.80665, Date.now());
  page.gyroscope.emitEventReading(0.01, 0.02, 0.03, Date.now());
  assert.equal(page.imuReadingCount, 1);
  assert.equal(page.gyroscopeReadingCount, 1);
  assert.equal(
    page.metrics.snapshot(Date.now()).distanceM,
    distanceBeforeFirstFrame,
    '恢复后首帧只重建基线，不补积分隐藏空档',
  );
  page.onUnload();
});

test('AR show 立即新建 Gyroscope，稳定周期约 5 秒恢复三项', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1080000,
  });
  const page = freshPage({}, { gyroscope: true });
  page.rideSettings = {
    ...page.rideSettings,
    voiceCue: false,
    cadenceToneRpm: 0,
  };
  assert.equal(page.startRide(), true);
  const oldGeneration = page.imuGeneration;
  const oldGyroscope = page.gyroscope;
  page.onHide();
  assert.equal(oldGyroscope.stopped, true);
  assert.equal(page.gyroscope, null);
  page.onShow();
  assert.ok(page.imuGeneration > oldGeneration);
  assert.notEqual(page.gyroscope, oldGyroscope);
  const recoveredGyroscope = page.gyroscope;
  assert.ok(recoveredGyroscope);

  const rpm = 90;
  for (let index = 0; index <= 100; index += 1) {
    t.mock.timers.tick(50);
    const atMs = index * 50;
    const phase = 2 * Math.PI * rpm * atMs / 60000;
    recoveredGyroscope.emitEventReading(
      0.08 * Math.sin(phase),
      0.04 * Math.cos(phase),
      0.02 * Math.sin(phase + 0.4),
      95 + index * 0.05,
    );
  }
  assertPositiveDisplay(page.data.cadence);
  assertPositiveDisplay(page.data.speed);
  assertPositiveDisplay(page.data.distance);
  page.onUnload();
});

test('室内下一步完成 JIT 后启动 IMU 且骑中不请求定位', async (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1100000,
  });
  const geolocation = fakeGeolocation();
  const page = freshPage({}, {
    gyroscope: true,
    navigator: { geolocation },
  });
  page.scanAttempted = true;

  assert.equal(await page.proceedToHud(), true);
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.data.riding, true);
  assert.equal(page.rideSessionActive, true);
  assert.ok(page.gyroscope);
  assert.ok(page.tickTimer);
  assert.equal(geolocation.watchCalls.length, 0);
  assert.equal(page.rideStartTimer, null);
  page.onUnload();
});

test('计划骑最终 JIT 失败时 fail closed 留在准备页且不启动传感器', async () => {
  const page = freshPage({}, { accelerometer: true, gyroscope: true });
  page.pendingSportsPlan = {
    workout_id: 'spw_' + 'a'.repeat(24), revision: 1,
    title: '今日耐力骑', type: 'endurance', scheduled_date: '2026-08-13',
    source: 'adaptive', rationale: '稳定积累',
    issued_at_ms: Date.now() - 1000, expires_at_ms: Date.now() + 3600000,
    safety_notes: [], stages: [{
      stage_id: 'sps_' + 'b'.repeat(24), order: 0, type: 'work',
      title: '稳定段', duration_sec: 600, cue: '保持稳定踩踏',
      target: { kind: 'cycling', effort_min: 3, effort_max: 5 },
    }],
  };
  let starts = 0;
  page.prepareCurrentSportAgent = async () => null;
  page.startRide = () => { starts += 1; return true; };
  assert.equal(await page.proceedToHud(), false);
  assert.equal(page.data.surfacePhase, 'ready');
  assert.equal(page.rideSessionActive, false);
  assert.equal(starts, 0);
  assert.equal(page.accelerometer == null, true);
  assert.equal(page.gyroscope == null, true);
  assert.equal(page.tickTimer == null, true);
  assert.match(page.data.searchText, /未通过在线安全确认/);
});

test('自由骑最终 JIT 失败时明确降级并只启动一次本地安全模式', async () => {
  const page = freshPage();
  page.prepareCurrentSportAgent = async () => null;
  const originalStart = page.startRide.bind(page);
  const optionsSeen = [];
  page.startRide = (options) => {
    optionsSeen.push(options);
    return originalStart(options);
  };
  assert.equal(await page.proceedToHud(), true);
  assert.equal(page.rideSessionActive, true);
  assert.equal(optionsSeen.length, 1);
  assert.equal(optionsSeen[0].localSafeMode, true);
  assert.match(page.data.cyclingSourceText, /本地安全模式/);
  page.onUnload();
});

test('最终 JIT 能力只冻结已提交 BLE 通知，IMU 不授权踏频或速度处方', async () => {
  const page = freshPage({}, { accelerometer: true, gyroscope: true });
  assert.deepEqual(page.sportAgentCapabilities(), {
    heartRate: false, cadence: false, speed: false, power: false,
  });
  page.notificationResources = [
    { active: true, committed: true, source: 'csc' },
    { active: true, committed: false, source: 'cps' },
    { active: false, committed: true, source: 'hrs' },
  ];
  let frozen = null;
  page.prepareCurrentSportAgent = async (options) => {
    frozen = options.capabilities;
    return null;
  };
  assert.equal(await page.proceedToHud(), true);
  assert.deepEqual(frozen, {
    heartRate: false, cadence: true, speed: true, power: false,
  });
  page.onUnload();
});

test('真实 v2 fixture 用最终 BLE 能力只建立一次 briefing 与 session 并冻结缩短阶段', async () => {
  const page = freshPage({}, { accelerometer: true, gyroscope: true });
  enableTestNetwork(page);
  page.sportsIdentity = writeSportsIdentity(wx, TEST_SPORTS_IDENTITY);
  const rawPlan = {
    workout_id: 'spw_' + 'a'.repeat(24), revision: 7,
    title: '今日耐力骑', type: 'endurance', scheduled_date: '2026-08-13',
    source: 'adaptive', rationale: '根据近期负荷缩短执行',
    issued_at_ms: Date.now() - 1000, expires_at_ms: Date.now() + 3600000,
    safety_notes: [], stages: [{
      stage_id: 'sps_' + 'b'.repeat(24), order: 0, type: 'work',
      title: '稳定段', duration_sec: 600, cue: '保持稳定踩踏',
      target: { kind: 'cycling', cadence_min_rpm: 80, cadence_max_rpm: 95 },
    }],
  };
  page.pendingSportsPlan = structuredClone(rawPlan);
  page.notificationResources = [{
    active: true, committed: true, source: 'csc',
  }];
  const calls = [];
  const briefingId = 'sab_' + 'b'.repeat(24);
  const sessionId = 'sas_' + 'c'.repeat(24);
  const capabilityHash = 'e'.repeat(64);
  const readiness = {
    schema_version: 1, status: 'high_load',
    reason_codes: ['recent_high_load'], source: 'history_only', launch_allowed: true,
  };
  const iteration = {
    schema_version: 1, strategy_version: 2, recent_sessions: 2,
    completed: 1, partial: 1, aborted: 0, safety_events: 0,
    completion_rate_pct: 50, plan_basis: 'recovery_protection',
    evidence_confidence: 'medium', data_coverage: 'limited',
    reason_codes: ['recent_partial'],
  };
  const executionStages = [{
    stage_id: rawPlan.stages[0].stage_id, duration_s: 480,
    target: {
      kind: 'cycling', cadence_min_rpm: 78, cadence_max_rpm: 90,
      effort_min: 3, effort_max: 5,
    },
    source: 'readiness_reduction', fallback: 'cadence',
  }];
  const supervision = {
    schema_version: 1, snapshot_max_age_ms: 15000,
    normal_cue_cooldown_s: 75, repeat_cue_cooldown_s: 180,
    safety_cue_cooldown_s: 20, minimum_evidence_s: 12,
  };
  const heartPolicy = {
    schema_version: 1, max_hr_bpm: 180, source: 'conservative_default',
    issued_at_ms: Date.now() - 1000, expires_at_ms: Date.now() + 3600000,
  };
  wx.requestImpl = (options) => {
    calls.push(options);
    const shared = {
      schema_version: 1, context_version: 2, sport: 'cycling', mode: 'planned',
      locale: 'zh-CN', prescription: rawPlan,
      capabilities: {
        heart_rate: false, pace: false, cadence: true, speed: true, power: false,
      },
      capability_hash: capabilityHash, readiness, iteration,
      execution_stages: executionStages, supervision_policy: supervision,
      heart_rate_policy: heartPolicy,
      public_device_id: TEST_SPORTS_IDENTITY.public_device_id,
      ownership_epoch: TEST_SPORTS_IDENTITY.ownership_epoch,
      data_namespace: TEST_SPORTS_IDENTITY.data_namespace,
    };
    if (/\/briefing$/.test(options.url)) {
      options.success({ statusCode: 200, data: {
        ...shared, briefing_id: briefingId, title: '今日耐力骑',
        rationale: '近期负荷较高，本场缩短两分钟。',
      } });
      return;
    }
    if (/\/sessions$/.test(options.url)) {
      options.success({ statusCode: 200, data: {
        ...shared, session_id: sessionId,
        client_session_id: options.data.client_session_id,
        briefing_id: briefingId, workout_id: rawPlan.workout_id, duplicate: false,
      } });
      return;
    }
    options.fail(new Error('unexpected request'));
  };
  assert.equal(await page.proceedToHud(), true);
  assert.equal(page.rideSessionActive, true);
  assert.deepEqual(calls.map((call) => call.url.split('/').at(-1)), [
    'briefing', 'sessions',
  ]);
  assert.deepEqual(calls[0].data.capabilities, {
    heart_rate: false, pace: false, cadence: true, speed: true, power: false,
  });
  assert.deepEqual(calls[1].data.capabilities, calls[0].data.capabilities);
  assert.equal(page.activeSportsPlan.stages[0].duration_sec, 480);
  assert.equal(page.activeSportsPlan.stages[0].execution_source, 'readiness_reduction');
  assert.equal(rawPlan.stages[0].duration_sec, 600, '原计划不可被缩短执行快照改写');
  const callCountAtHud = calls.length;
  page.tick(Date.now() + 1000);
  assert.equal(calls.length, callCountAtHud, '骑中事件只写本地，不能继续联网');
  page.onUnload();
});

test('活动骑行硬门在 wx.request 前阻止所有 Hermes 网络', async () => {
  const page = freshPage();
  enableTestNetwork(page);
  let networkCalls = 0;
  wx.request = () => { networkCalls += 1; };
  assert.equal(page.startRide({ localSafeMode: true }), true);
  const result = await page.requestCyclingHermes({
    url: 'https://hermes.invalid/api/coach-svc/coach/sport-agent/briefing',
    method: 'POST',
  });
  assert.equal(result.statusCode, 0);
  assert.equal(networkCalls, 0);
  page.onUnload();
});

test('公开默认配置在 wx.request 前拒绝 Hermes 网络', async () => {
  const page = freshPage();
  let networkCalls = 0;
  wx.request = () => { networkCalls += 1; };
  const result = await page.requestCyclingHermes({
    url: '/api/coach-svc/coach/device-bootstrap',
    method: 'POST',
  });
  assert.equal(result.errMsg, 'offline policy');
  assert.equal(networkCalls, 0);
  page.onUnload();
});

test('hide/show 后迟到的旧扫描不能覆盖新扫描或继续发现设备', async () => {
  const page = freshPage();
  const firstScanRequest = deferred();
  const secondScanRequest = deferred();
  const requests = [firstScanRequest, secondScanRequest];
  globalThis.navigator = {
    bluetooth: {
      scanDevices() {
        return requests.shift().promise;
      },
    },
  };
  const firstScan = {
    stopped: false,
    listener: null,
    onDeviceFound(listener) { this.listener = listener; },
    offDeviceFound() {},
    stop() { this.stopped = true; },
  };
  const secondScan = {
    stopped: false,
    listener: null,
    onDeviceFound(listener) { this.listener = listener; },
    offDeviceFound() {},
    stop() { this.stopped = true; },
  };

  const firstStart = page.startDiscovery();
  page.onHide();
  page.onShow();
  const secondStart = page.startDiscovery();
  secondScanRequest.resolve(secondScan);
  assert.equal(await secondStart, true);
  assert.equal(page.scanSession, secondScan);

  firstScanRequest.resolve(firstScan);
  assert.equal(await firstStart, false);
  assert.equal(firstScan.stopped, true);
  assert.equal(page.scanSession, secondScan);

  page.onHide();
  secondScan.listener?.({ device: { id: 'stale-device', name: 'stale' } });
  assert.equal(page.discoveredDeviceOrder.includes('stale-device'), false);
});

test('真实扫描在 hide/show 后自动恢复，不停留在假的扫描中文案', async () => {
  const page = freshPage();
  const scans = [0, 1].map(() => ({
    stopped: false,
    onDeviceFound() {},
    offDeviceFound() {},
    stop() { this.stopped = true; },
  }));
  let scanCalls = 0;
  globalThis.navigator = {
    bluetooth: {
      async scanDevices() {
        const scan = scans[scanCalls];
        scanCalls += 1;
        return scan;
      },
    },
  };
  page.scanAttempted = true;
  assert.equal(await page.startDiscovery(), true);
  assert.equal(page.scanSession, scans[0]);

  page.onHide();
  assert.equal(scans[0].stopped, true);
  assert.equal(page.scanResumePending, true);
  page.onShow();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(scanCalls, 2);
  assert.equal(page.scanSession, scans[1]);
  assert.equal(page.data.scanProgressText, '扫描中');
  assert.equal(page.scanResumePending, false);
});

test('JIT 启动完成后卸载会清理 IMU、ticker 与音频且不复活', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const geolocation = fakeGeolocation();
  const page = freshPage({}, {
    accelerometer: true,
    gyroscope: true,
    navigator: { geolocation },
  });
  assert.equal(await page.proceedToHud(), true);
  const accelerometer = page.accelerometer;
  const gyroscope = page.gyroscope;
  assert.ok(accelerometer);
  assert.ok(gyroscope);
  assert.ok(page.tickTimer);
  assert.equal(geolocation.watchCalls.length, 0);

  page.onUnload();
  t.mock.timers.tick(300);
  assert.equal(page.tickTimer, null);
  assert.equal(page.cadenceTone, null);
  assert.equal(page.accelerometer, null);
  assert.equal(page.gyroscope, null);
  assert.equal(page.rideGeolocationWatch, undefined);
  assert.equal(accelerometer.stopped, true);
  assert.equal(gyroscope.stopped, true);
  assert.deepEqual(geolocation.clearCalls, []);
});

test('完整骑行 HUD 共用不可绕过的 500ms 门，旧 force 参数也不能抢帧', () => {
  const page = freshPage();
  assert.equal(page.startRide(), true);
  page.stopTicker();
  let ticks = 0;
  page.tick = () => {
    ticks += 1;
    return { elapsedMs: 0 };
  };
  page.lastRideTickAtMs = 1000;

  assert.equal(
    page.requestRideTick('imu', 1200, { force: true }),
    false,
  );
  assert.equal(ticks, 0);
  assert.equal(page.requestRideTick('imu', 1500), true);
  assert.equal(ticks, 1);
  page.onUnload();
});

test('ticker 被录屏压制时，合法 Gyroscope 帧仍逐秒推进真实时长且不造三项', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 200000,
  });
  const page = freshPage({}, { gyroscope: true });
  assert.equal(page.startRide(), true);
  page.stopTicker();
  page.imuClassifier.onGyroscopeReading = () => null;
  const elapsedFrames = [];
  const originalSetData = page.setData.bind(page);
  page.setData = (patch) => {
    originalSetData(patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'elapsed')) {
      elapsedFrames.push(patch.elapsed);
    }
  };
  const gyroscope = page.gyroscope;
  for (let index = 1; index <= 65; index += 1) {
    t.mock.timers.tick(100);
    gyroscope.emitEventReading(
      0.001 * (index % 3),
      0.001 * (index % 5),
      0.001 * (index % 7),
      30 + index * 0.1,
    );
  }
  const secondFrames = [...new Set(
    elapsedFrames.filter((value) => /^00:0[1-6]$/.test(value)),
  )];
  assert.deepEqual(secondFrames, [
    '00:01', '00:02', '00:03', '00:04', '00:05', '00:06',
  ]);
  assert.equal(page.gyroscopeReadingCount, 65);
  assert.doesNotMatch(String(page.data.speed), /^(?:0|0\.0|--)$/);
  assert.doesNotMatch(String(page.data.cadence), /^(?:0|--)$/);
  assert.equal(page.metrics.snapshot(Date.now()).distanceM, 0);
  page.onUnload();
});

test('Gyroscope 健康时 Accel 不重复触发帧 tick，Gyro 停流时才救活', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 210000,
  });
  const page = freshPage({}, { accelerometer: true, gyroscope: true });
  assert.equal(page.startRide(), true);
  page.stopTicker();
  page.imuClassifier.onReading = () => null;
  page.imuClassifier.onGyroscopeReading = () => null;
  const sources = [];
  const requestRideTick = page.requestRideTick.bind(page);
  page.requestRideTick = (sourceName, ...args) => {
    sources.push(sourceName);
    return requestRideTick(sourceName, ...args);
  };

  page.gyroscope.emitEventReading(0.01, 0.02, 0.03, 1);
  sources.length = 0;
  t.mock.timers.tick(100);
  page.accelerometer.emitEventReading(0.1, 0.2, 9.8, 1.1);
  assert.equal(sources.includes('imu-frame'), false);

  page.gyroscopeLastReadingAtMs = Date.now() - 10001;
  page.gyroscopeStartedAtMs = page.gyroscopeLastReadingAtMs;
  t.mock.timers.tick(100);
  page.accelerometer.emitEventReading(0.1, 0.2, 9.8, 1.2);
  assert.equal(sources.includes('imu-frame'), true);
  page.onUnload();
});

test('onUnload 后旧 IMU 迟到帧被对象与 generation fence 拒绝', () => {
  const page = freshPage({}, { accelerometer: true, gyroscope: true });
  assert.equal(page.startRide(), true);
  const oldAccelerometer = page.accelerometer;
  const oldGyroscope = page.gyroscope;
  const oldGeneration = page.imuGeneration;
  page.onUnload();
  assert.ok(page.imuGeneration > oldGeneration);
  assert.equal(page.imuClassifier, null);
  oldAccelerometer.emitEventReading(0.1, 0.2, 9.8, 1);
  oldGyroscope.emitEventReading(0.01, 0.02, 0.03, 1);
  assert.equal(page.imuReadingCount, 0);
  assert.equal(page.gyroscopeReadingCount, 0);
  assert.equal(page.imuClassifier, null);
});

test('原始 IMU 帧逐帧分类，metrics/signature 约 4Hz 且静止最多延迟 250ms', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
  const page = freshPage({}, { gyroscope: true });
  assert.equal(page.startRide(), true);
  page.stopTicker();
  page.tick = () => ({ elapsedMs: 0 });
  const gyroscope = FakeGyroscope.instances[0];
  let rawClassifierCalls = 0;
  let motionState = 'moving';
  page.imuClassifier.onGyroscopeReading = () => {
    rawClassifierCalls += 1;
    const stationary = motionState === 'stationary';
    return {
      motionState,
      confidence: 0.95,
      fresh: true,
      cadenceState: stationary ? 'stationary' : 'estimated',
      cadenceEstimateLevel: stationary ? 'stationary' : 'locked',
      cadenceSensorSource: 'gyroscope_simple',
      cadenceUsable: !stationary,
      availabilityCadenceUsable: false,
      candidateCadenceRpm: stationary ? 0 : 90,
      finalCadenceRpm: stationary ? 0 : 90,
      effectiveCadenceRpm: stationary ? 0 : 90,
      effectiveCadenceConfidence: 0.95,
      motionArtifact: 'none',
    };
  };
  let signatureCalls = 0;
  const originalSignature = page.imuMetricsActivitySignature.bind(page);
  page.imuMetricsActivitySignature = (activity) => {
    signatureCalls += 1;
    return originalSignature(activity);
  };
  const forwarded = [];
  page.metrics.onImuActivity = (activity, atMs) => {
    forwarded.push({
      state: activity.motionState,
      atMs,
      deliveredAtMs: Date.now(),
    });
    return true;
  };

  for (let index = 0; index < 18; index += 1) {
    t.mock.timers.tick(50);
    gyroscope.emitEventReading(0.08, 0.04, 0.02, 20 + index * 0.05);
  }
  assert.equal(rawClassifierCalls, 18);
  assert.ok(forwarded.length <= 4, `900ms 稳态只应转发约 4Hz，实际 ${forwarded.length}`);
  assert.equal(signatureCalls, forwarded.length);
  assert.ok(signatureCalls <= 5,
    `900ms 高频帧不应逐帧构造 signature，实际 ${signatureCalls}`);

  motionState = 'stationary';
  t.mock.timers.tick(50);
  gyroscope.emitEventReading(0, 0, 0, 20.9);
  assert.equal(rawClassifierCalls, 19);
  assert.notEqual(forwarded.at(-1).state, 'stationary');

  const stationaryReceivedAtMs = Date.now();
  t.mock.timers.tick(250);
  assert.equal(forwarded.at(-1).state, 'stationary');
  assert.ok(
    forwarded.at(-1).deliveredAtMs - stationaryReceivedAtMs <= 250,
    '静止语义必须由最新快照合并器在 250ms 内转发',
  );
  assert.equal(signatureCalls, forwarded.length);
  page.onUnload();
});

test('HUD 重复快照不 setData，变化时只提交绑定差量且不刷新 paused/power', () => {
  const page = freshPage();
  assert.equal(page.startRide(), true);
  page.stopTicker();
  let elapsedMs = 1000;
  page.metrics = {
    paused: false,
    snapshot: () => ({
      elapsedMs,
      movingMs: 0,
      distanceM: 0,
      distanceEverAvailable: false,
      distanceState: 'unsupported',
      distanceSource: 'none',
      paused: false,
      metrics: {
        speed: { value: null, state: 'unsupported', source: 'csc' },
        cadence: { value: null, state: 'unsupported', source: 'csc' },
        heartRate: { value: null, state: 'unsupported', source: 'hrs' },
        power: { value: null, state: 'unsupported', source: 'cps' },
      },
      rollout: { suppressImu: false, metersPerCrank: 3.2 },
      imuAssist: { fresh: false, suppressImu: false, metersPerCrank: 3.2 },
    }),
  };
  const patches = [];
  const originalSetData = page.setData.bind(page);
  page.setData = (patch) => {
    patches.push({ ...patch });
    originalSetData(patch);
  };

  page.updateHudFromMetrics(1000);
  patches.length = 0;
  page.updateHudFromMetrics(1000);
  assert.equal(patches.length, 0, '完全相同的 HUD 快照不应触发 setData');

  elapsedMs = 2000;
  page.updateHudFromMetrics(2000);
  assert.equal(patches.length, 1);
  assert.deepEqual(Object.keys(patches[0]), ['elapsed']);
  assert.equal(Object.hasOwn(patches[0], 'paused'), false);
  assert.equal(Object.hasOwn(patches[0], 'power'), false);
  page.onUnload();
});

test('待返回的扫描在 HUD 收尾窗内到达也必须立即丢弃并停止', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = freshPage();
  const scanRequest = deferred();
  globalThis.navigator = {
    bluetooth: {
      scanDevices() { return scanRequest.promise; },
    },
  };
  const scan = {
    stopped: false,
    onDeviceFound() {},
    offDeviceFound() {},
    stop() { this.stopped = true; },
  };

  const discovery = page.startDiscovery();
  assert.equal(await page.proceedToHud(), true);
  scanRequest.resolve(scan);
  assert.equal(await discovery, false);
  assert.equal(scan.stopped, true);
  assert.equal(page.scanSession, null);

  t.mock.timers.tick(300);
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.data.riding, true);
  assert.equal(page.scanSession, null);
});

test('无标准骑行通知时，非周期 IMU 不伪造骑行值且核心栏说明正在准备', () => {
  const page = freshPage({}, { accelerometer: true });
  assert.equal(page.startRide(), true);
  assert.equal(page.data.riding, true);
  assert.equal(page.data.speed, '估算中');
  assert.equal(page.data.cadence, '识别中');
  assert.equal(page.data.distance, '待起步');

  const sensor = FakeAccelerometer.instances[0];
  for (let i = 0; i < 20; i += 1) {
    sensor.emitReading(i % 2 ? 1.5 : -1.5, 0.2, 9.7);
  }
  page.updateHudFromMetrics(Date.now());
  assert.doesNotMatch(page.data.speed, /^(?:0(?:\.0+)?|--)$/);
  assert.doesNotMatch(page.data.cadence, /^(?:0|--)$/);
  assert.equal(page.data.distance, '待起步');
  const nonPeriodic = page.metrics.snapshot(Date.now());
  assert.notEqual(nonPeriodic.metrics.speed.state, 'live');
  assert.notEqual(nonPeriodic.metrics.cadence.state, 'live');
  assert.equal(page.imuClassifier.snapshot(Date.now()).effectiveCadenceRpm, null);
  assert.match(page.data.cyclingSourceText, /加速度已就绪|踏频识别中/);
});

test('权威正速度优先于头部静止，明确零踏频显示为滑行', () => {
  const page = freshPage();
  page.startRide();
  const now = Date.now();
  page.metrics = {
    snapshot() {
      return {
        elapsedMs: 5000,
        movingMs: 5000,
        distanceM: 50,
        distanceEverAvailable: true,
        distanceState: 'live',
        distanceSource: 'gps',
        metrics: {
          speed: { value: 22, state: 'live', source: 'gps' },
          cadence: { value: 0, state: 'explicit_zero', source: 'imu' },
          power: { value: null, state: 'unsupported', source: 'cps' },
          heartRate: { value: null, state: 'unsupported', source: 'hrs' },
        },
        rollout: { suppressImu: false, metersPerCrank: 3.2 },
        imuAssist: { fresh: true, suppressImu: false, metersPerCrank: 3.2 },
      };
    },
  };
  page.imuClassifier = {
    snapshot() {
      return {
        fresh: true,
        motionState: 'stationary',
        confidence: 0.98,
        cadenceState: 'stationary',
        cadenceConfidence: 1,
        effectiveCadenceRpm: 0,
        finalCadenceRpm: 0,
        motionArtifact: 'none',
      };
    },
  };

  page.updateHudFromMetrics(now);
  assert.equal(page.data.speed, '22.0');
  assert.equal(page.data.cadence, '滑行');
  assert.equal(page.data.distance, '0.05');
  assert.match(page.data.cyclingSourceText, /滑行中/);
});

test('无外设时稳定踩踏周期显示踏频、速度和里程，并用文字标记估算来源', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage({}, { accelerometer: true });
  assert.equal(page.startRide(), true);
  const sensor = FakeAccelerometer.instances[0];
  const rpm = 90;
  for (let index = 0; index <= 250; index += 1) {
    t.mock.timers.tick(40);
    const atMs = index * 40;
    const phase = 2 * Math.PI * rpm * atMs / 60000;
    sensor.emitReading(
      0.9 * Math.sin(phase),
      0.5 * Math.cos(phase + 0.2),
      9.80665 + 0.2 * Math.sin(phase + 0.7),
      10 + index * 0.04,
    );
  }
  page.updateHudFromMetrics(Date.now());
  assertPositiveDisplay(page.data.speed);
  assertPositiveDisplay(page.data.cadence);
  assertPositiveDisplay(page.data.distance);
  assert.match(page.data.cyclingSourceText, /IMU 估算/);
  t.mock.timers.tick(4000);
  assert.equal(page.finishRideToSummary(), true);
  assert.equal(wx.store.has(LAST_RIDE_SUMMARY_KEY), false);
  t.mock.timers.tick(1);
  const summary = wx.store.get(LAST_RIDE_SUMMARY_KEY);
  assert.ok(summary.sources.includes('imu'));
  assertPositiveDisplay(page.data.sumDistance);
  assertPositiveDisplay(page.data.sumCadence);
  assert.match(page.data.sumSourceNote, /眼镜 IMU/);
  assert.equal(page.data.sumAdviceTitle, '踏频处于常用区间');
  page.onUnload();
});

test('眼镜 8Hz 弱单轴抖动丢帧仍能点亮踏频、速度和里程估算', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage({}, { accelerometer: true });
  assert.equal(page.startRide(), true);
  const sensor = FakeAccelerometer.instances[0];
  const rpm = 88;
  const jitterMs = [-22, 15, -9, 25, -12, 5];
  let atMs = 0;
  let index = 0;
  while (atMs <= 22000) {
    const stepMs = 125 + jitterMs[index % jitterMs.length]
      + (index > 0 && index % 19 === 0 ? 125 : 0);
    t.mock.timers.tick(stepMs);
    atMs += stepMs;
    const phase = 2 * Math.PI * rpm * atMs / 60000;
    sensor.emitReading(
      0.05 * Math.sin(phase),
      0,
      9.80665,
      10 + atMs / 1000,
    );
    index += 1;
  }
  page.updateHudFromMetrics(Date.now());
  assert.ok(page.imuObservedHz >= 5);
  assert.equal(page.imuDiagnosticState, 'reading');
  assertPositiveDisplay(page.data.cadence);
  assertPositiveDisplay(page.data.speed);
  assert.ok(Number(page.data.speed) <= 20, '未校准 IMU 速度不得轻易跳到 30km/h');
  assertPositiveDisplay(page.data.distance);
  assert.match(page.data.cyclingSourceText, /IMU 估算/);
  page.onUnload();
});

test('AIUI 0.15 页面级 8Hz Gyroscope 在 5 秒内点亮踏频/速度，7 秒内累计距离', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 450000,
  });
  const page = freshPage({}, { gyroscope: true });
  assert.equal(page.startRide(), true);
  assert.equal(page.accelerometer, null);
  const gyroscope = FakeGyroscope.instances[0];
  assert.ok(gyroscope);

  const rpm = 90;
  let firstVisibleAtMs = null;
  let firstDistanceAtMs = null;
  for (let index = 0; index <= 56; index += 1) {
    if (index > 0) t.mock.timers.tick(125);
    const atMs = index * 125;
    const phase = 2 * Math.PI * rpm * atMs / 60000;
    gyroscope.emitEventReading(
      0.08 * Math.sin(phase),
      0.04 * Math.cos(phase),
      0.02 * Math.sin(phase + 0.4),
      30 + atMs / 1000,
    );
    page.updateHudFromMetrics(Date.now());
    if (firstVisibleAtMs == null
        && Number(page.data.cadence) > 0
        && Number(page.data.speed) > 0) {
      firstVisibleAtMs = atMs;
    }
    if (firstDistanceAtMs == null && Number(page.data.distance) > 0) {
      firstDistanceAtMs = atMs;
    }
  }

  const activity = page.imuClassifier.snapshot(Date.now());
  assert.ok(firstVisibleAtMs != null && firstVisibleAtMs <= 5000,
    `8Hz 陀螺仪应在 5 秒内出数，实际 ${String(firstVisibleAtMs)}`);
  assert.ok(firstDistanceAtMs != null && firstDistanceAtMs <= 7000,
    `8Hz 陀螺仪应在连续确认后 7 秒内计距，实际 ${String(firstDistanceAtMs)}`);
  assert.ok(page.gyroscopeObservedHz >= 7.5 && page.gyroscopeObservedHz <= 8.5);
  assert.match(activity.simpleGyroCadenceMethod, /low_rate_timestamp_consensus/);
  assert.match(activity.simpleGyroAnalysisState, /low_rate_locked/);
  assertPositiveDisplay(page.data.cadence);
  assertPositiveDisplay(page.data.speed);
  assertPositiveDisplay(page.data.distance);
  assert.match(page.data.cyclingSourceText, /陀螺仪估算|IMU 估算/);
  page.onUnload();
});

test('AR 低帧率持续 soft artifact 时 5 秒内显示踏频/速度，但不写入距离', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 475000,
  });
  const page = freshPage({}, { gyroscope: true });
  assert.equal(page.startRide(), true);
  const imu = page.imuClassifier;
  const startedAtMs = Date.now();
  const headTurn = {
    state: 'head_motion',
    artifact: 'head_turn',
    quality: 0.2,
    allowCadenceEvidence: false,
  };
  let activity = null;
  let snapshot = null;
  let firstVisibleAtMs = null;
  for (let index = 0; index <= 50; index += 1) {
    if (index > 0) t.mock.timers.tick(100);
    const offsetMs = index * 100;
    const now = startedAtMs + offsetMs;
    const phase = 2 * Math.PI * 88 * offsetMs / 60000;
    activity = imu.onGyroscopeSample({
      x: 0.08 * Math.sin(phase),
      y: 0.04 * Math.cos(phase),
      z: 0.02 * Math.sin(phase + 0.4),
      timestampMs: now,
    }, now, headTurn, now);
    page.metrics.onImuActivity(activity, now);
    snapshot = page.updateHudFromMetrics(now);
    if (firstVisibleAtMs == null
        && Number(page.data.cadence) > 0
        && Number(page.data.speed) > 0) {
      firstVisibleAtMs = offsetMs;
    }
  }

  assert.equal(activity.finalCadenceRpm, null);
  assert.equal(activity.availabilityCadenceUsable, true);
  assert.ok(firstVisibleAtMs != null && firstVisibleAtMs <= 5000);
  assertPositiveDisplay(page.data.cadence);
  assertPositiveDisplay(page.data.speed);
  assert.equal(snapshot.distanceM, 0);
  assert.equal(snapshot.distanceEverAvailable, false);
  assert.match(page.data.cyclingSourceText, /陀螺仪粗估/);

  const sample = page.buildCyclingTestSample(snapshot, Date.now());
  assert.ok(sample.cadence_rpm > 0);
  assert.ok(sample.speed_kmh > 0);
  assert.equal(sample.distance_m, null);
  assert.ok(sample.candidate_cadence_rpm > 0);
  assert.equal(sample.cadence_source, 'imu');
  assert.equal(sample.speed_source, 'imu');
  assert.equal(sample.distance_source, 'none');
  assert.equal(sample.distance_mode, 'none');

  assert.equal(page.finishRideToSummary(), true);
  t.mock.timers.tick(1);
  const summary = wx.store.get(LAST_RIDE_SUMMARY_KEY);
  assert.ok(summary.sources.includes('imu'));
  assert.equal(summary.distanceM, 0, '本地归一化保留兼容零值，但页面语义仍为未形成');
  assertPositiveDisplay(page.data.sumCadence);
  assert.equal(page.data.sumDistance, '未形成');
  assert.match(page.data.sumSourceNote, /眼镜 IMU/);
  page.onUnload();
});

test('hide 暂停后冻结本场值，show 新 IMU 保持显示且明确静止覆盖旧值', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 500000,
  });
  const page = freshPage({}, { gyroscope: true });
  assert.equal(page.startRide(), true);
  const gyroscope = FakeGyroscope.instances[0];
  const rpm = 90;
  // 4Hz metrics 快照需要在首次锁定后再有一个真实样本才能建立距离锚；
  // 多留半秒仍在 3–5 秒产品门内，且不靠伪造空档积分。
  for (let index = 0; index <= 90; index += 1) {
    t.mock.timers.tick(50);
    const atMs = index * 50;
    const phase = 2 * Math.PI * rpm * atMs / 60000;
    gyroscope.emitEventReading(
      0.08 * Math.sin(phase),
      0.04 * Math.cos(phase),
      0.02 * Math.sin(phase + 0.4),
      40 + index * 0.05,
    );
  }
  // 排空最后一个真实 IMU 快照的 250ms 合并边界，再记录后台保持基线。
  t.mock.timers.tick(250);
  page.updateHudFromMetrics(Date.now());
  const before = {
    cadence: page.data.cadence,
    speed: page.data.speed,
    distance: page.data.distance,
    distanceM: page.metrics.snapshot(Date.now()).distanceM,
    elapsedMs: page.metrics.snapshot(Date.now()).elapsedMs,
    sourceText: page.data.cyclingSourceText,
  };
  assertPositiveDisplay(before.cadence);
  assertPositiveDisplay(before.speed);
  assertPositiveDisplay(before.distance);
  assert.ok(Number(before.speed) <= 20);

  page.onHide();
  assert.equal(page.metrics.paused, true);
  assert.equal(page.gyroscope, null);
  assert.equal(gyroscope.stopped, true);
  t.mock.timers.tick(30000);
  const hiddenSnapshot = page.metrics.snapshot(Date.now());
  assert.equal(hiddenSnapshot.elapsedMs, before.elapsedMs);
  assert.equal(hiddenSnapshot.distanceM, before.distanceM);
  assert.equal(page.data.cadence, before.cadence);
  assert.equal(page.data.speed, before.speed);
  assert.equal(page.data.distance, before.distance);
  assert.equal(page.data.cyclingSourceText, before.sourceText);
  assert.doesNotMatch(page.data.cyclingSourceText, /后台保持|录屏保持/);
  page.onShow();
  assert.equal(page.metrics.paused, false);
  assert.ok(page.gyroscope);
  assert.notEqual(page.gyroscope, gyroscope);
  page.updateHudFromMetrics(Date.now());
  assert.equal(page.data.cadence, before.cadence);
  assert.equal(page.data.speed, before.speed);
  assert.equal(page.data.distance, before.distance);
  assert.equal(page.metrics.snapshot(Date.now()).distanceM, before.distanceM);
  assert.match(page.data.cyclingSourceText, /后台保持·本场均值/);
  assert.doesNotMatch(page.data.cyclingSourceText, /录屏保持/);

  const stationaryWarmup = {
    motionState: 'stationary',
    confidence: 0.95,
    fresh: true,
    cadenceState: 'stationary',
    cadenceConfidence: 1,
    candidateCadenceRpm: 0,
    finalCadenceRpm: 0,
    effectiveCadenceRpm: 0,
    estimatedSpeedKmh: null,
  };
  page.metrics.onImuActivity(stationaryWarmup, Date.now());
  page.updateHudFromMetrics(Date.now());
  assert.equal(page.data.cadence, '静止');
  assert.equal(page.data.speed, '静止');
  assert.match(page.data.cyclingSourceText, /当前静止/);
  assert.equal(page.metrics.snapshot(Date.now()).distanceM, before.distanceM);
  const uploadSample = page.buildCyclingTestSample(
    page.metrics.snapshot(Date.now()),
    Date.now(),
  );
  assert.equal(uploadSample.speed_kmh, 0);
  assert.equal(uploadSample.cadence_rpm, 0);
  assert.notEqual(uploadSample.speed_kmh, Number(before.speed));
  assert.notEqual(uploadSample.cadence_rpm, Number(before.cadence));
  assert.equal(uploadSample.distance_m, before.distanceM);
  page.onUnload();
});


test('HUD 显示棘轮优先使用当前可信值，再考虑本场均值和上次值', () => {
  const page = freshPage();
  page.startRide();
  page.stopTicker();
  const now = Date.now();
  const snapshot = {
    elapsedMs: 60000,
    movingMs: 50000,
    distanceM: 400,
    distanceEverAvailable: true,
    distanceState: 'live',
    distanceSource: 'gps',
    avgSpeedKmh: 18.4,
    avgCadenceRpm: 82,
    metrics: {
      speed: { value: 24, state: 'live', source: 'gps' },
      cadence: { value: 91, state: 'live', source: 'csc' },
      power: { value: null, state: 'unsupported', source: 'cps' },
      heartRate: { value: null, state: 'unsupported', source: 'hrs' },
    },
    rollout: { suppressImu: false, metersPerCrank: 3.2 },
    imuAssist: { fresh: false, suppressImu: false, metersPerCrank: 3.2 },
  };
  page.metrics = { paused: false, snapshot: () => snapshot };
  page.imuClassifier = {
    snapshot: () => ({
      fresh: false,
      motionState: 'stale',
      confidence: 0,
      effectiveCadenceRpm: null,
      finalCadenceRpm: null,
      motionArtifact: 'none',
    }),
  };
  page.lastLockedImuHudEstimate = {
    speedKmh: 13.5,
    cadenceRpm: 70,
    speedSource: 'imu',
    cadenceSource: 'imu',
    atMs: now - 1000,
  };

  page.updateHudFromMetrics(now);
  assert.equal(page.data.speed, '24.0');
  assert.equal(page.data.cadence, '91');
  assert.equal(page.data.distance, '0.40');
  assert.doesNotMatch(page.data.cyclingSourceText, /录屏保持/);
  page.onUnload();
});

test('分类器高置信候选不能绕过 CyclingMetrics 账本直接成为 HUD 数字', () => {
  const page = freshPage();
  page.startRide();
  page.stopTicker();
  const now = Date.now();
  const snapshot = {
    elapsedMs: 3000,
    movingMs: 0,
    distanceM: 0,
    distanceEverAvailable: false,
    distanceState: 'unsupported',
    distanceSource: null,
    avgSpeedKmh: null,
    avgCadenceRpm: null,
    metrics: {
      speed: { value: null, state: 'unsupported', source: 'imu' },
      cadence: { value: null, state: 'unsupported', source: 'imu' },
      power: { value: null, state: 'unsupported', source: 'cps' },
      heartRate: { value: null, state: 'unsupported', source: 'hrs' },
    },
    rollout: { suppressImu: false, metersPerCrank: 3.2 },
    imuAssist: { fresh: true, suppressImu: false, metersPerCrank: 3.2 },
  };
  page.metrics = { paused: false, snapshot: () => snapshot };
  page.imuClassifier = {
    snapshot: () => ({
      fresh: true,
      motionState: 'moving',
      confidence: 0.99,
      cadenceState: 'warming',
      cadenceEstimateLevel: 'candidate',
      cadenceSensorSource: 'gyroscope_simple',
      cadenceUsable: false,
      availabilityCadenceUsable: false,
      candidateCadenceRpm: 110,
      effectiveCadenceRpm: 110,
      effectiveCadenceConfidence: 0.99,
      finalCadenceRpm: null,
      motionArtifact: 'none',
    }),
  };
  page.lastLockedImuHudEstimate = null;
  page.updateHudFromMetrics(now);
  assert.equal(page.data.speed, '估算中');
  assert.equal(page.data.cadence, '识别中');
  assert.equal(page.data.distance, '待起步');
  assert.match(page.data.cyclingSourceText, /候选|稳定踩踏/);
  page.onUnload();
});

test('断流 HUD 使用本场真实均值，但不回写 metrics、距离或 Hermes 样本', () => {
  const page = freshPage();
  page.startRide();
  page.stopTicker();
  const now = Date.now();
  const snapshot = {
    elapsedMs: 120000,
    movingMs: 100000,
    distanceM: 500,
    distanceEverAvailable: true,
    distanceState: 'stale',
    distanceSource: 'gps',
    avgSpeedKmh: 18.4,
    avgCadenceRpm: 82,
    metrics: {
      speed: { value: 29, state: 'stale', source: 'gps' },
      cadence: { value: 97, state: 'stale', source: 'imu' },
      power: { value: null, state: 'unsupported', source: 'cps' },
      heartRate: { value: null, state: 'unsupported', source: 'hrs' },
    },
    rollout: { suppressImu: false, metersPerCrank: 3.2 },
    imuAssist: { fresh: false, suppressImu: false, metersPerCrank: 3.2 },
  };
  const snapshotBefore = structuredClone(snapshot);
  page.metrics = { paused: false, snapshot: () => snapshot };
  page.imuClassifier = {
    snapshot: () => ({
      fresh: false,
      motionState: 'stale',
      confidence: 0,
      effectiveCadenceRpm: null,
      finalCadenceRpm: null,
      motionArtifact: 'none',
    }),
  };
  page.lastLockedImuHudEstimate = {
    speedKmh: 13.5,
    cadenceRpm: 70,
    speedSource: 'imu',
    cadenceSource: 'imu',
    atMs: now - 1000,
  };

  page.updateHudFromMetrics(now);
  assert.equal(page.data.speed, '18.4');
  assert.equal(page.data.cadence, '82');
  assert.equal(page.data.distance, '0.50');
  assert.match(page.data.cyclingSourceText, /本场均值/);
  assert.doesNotMatch(page.data.cyclingSourceText, /录屏保持/);
  assert.deepEqual(snapshot, snapshotBefore);
  const uploadSample = page.buildCyclingTestSample(snapshot, now);
  assert.equal(uploadSample.speed_kmh, null);
  assert.equal(uploadSample.cadence_rpm, null);
  assert.equal(uploadSample.distance_m, 500);
  page.onUnload();
});

test('只有 HUD 上次值时可继续显示，但不能伪造总结或 Hermes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  page.startRide();
  page.stopTicker();
  page.cyclingUploadSession = null;
  const now = Date.now();
  const snapshot = {
    elapsedMs: 60000,
    movingMs: 0,
    distanceM: 321,
    distanceEverAvailable: true,
    distanceState: 'stale',
    distanceSource: 'gps',
    avgSpeedKmh: null,
    avgCadenceRpm: null,
    metrics: {
      speed: { value: 22, state: 'stale', source: 'gps' },
      cadence: { value: 88, state: 'stale', source: 'imu' },
      power: { value: null, state: 'unsupported', source: 'cps' },
      heartRate: { value: null, state: 'unsupported', source: 'hrs' },
    },
    rollout: { suppressImu: false, metersPerCrank: 3.2 },
    imuAssist: { fresh: false, suppressImu: false, metersPerCrank: 3.2 },
    summarySourcesUsed: [],
    distanceSourcesUsed: ['gps'],
    metricSourcesUsed: { cadence: [] },
  };
  page.metrics = { paused: false, snapshot: () => snapshot };
  page.imuClassifier = {
    snapshot: () => ({
      fresh: false,
      motionState: 'stale',
      confidence: 0,
      effectiveCadenceRpm: null,
      finalCadenceRpm: null,
      motionArtifact: 'none',
    }),
  };
  page.lastLockedImuHudEstimate = {
    speedKmh: 14.2,
    cadenceRpm: 78,
    speedSource: 'imu',
    cadenceSource: 'imu',
    atMs: now - 1000,
  };

  page.updateHudFromMetrics(now);
  assert.equal(page.data.speed, '14.2');
  assert.equal(page.data.cadence, '78');
  assert.equal(page.data.distance, '0.32');
  assert.match(page.data.cyclingSourceText, /上次值/);
  assert.doesNotMatch(page.data.cyclingSourceText, /录屏保持/);
  const uploadSample = page.buildCyclingTestSample(snapshot, now);
  assert.equal(uploadSample.speed_kmh, null);
  assert.equal(uploadSample.cadence_rpm, null);
  assert.equal(uploadSample.distance_m, 321);

  assert.equal(page.finishRideToSummary(), true);
  assert.equal(page.data.sumSpeed, '未记录');
  assert.equal(page.data.sumCadence, '未记录');
  assert.equal(page.pendingRideSummaryCommit.summary.avgSpeedKmh, null);
  assert.equal(page.pendingRideSummaryCommit.summary.avgCadenceRpm, null);
  assert.equal(page.pendingRideSummaryCommit.summary.distanceM, 321);
  page.onUnload();
});

test('explicit_zero 与高置信静止会撤销两级保持，直到新的实时正值出现', () => {
  const page = freshPage();
  page.startRide();
  page.stopTicker();
  const now = Date.now();
  let phase = 'stale';
  const metricsForPhase = () => {
    if (phase === 'explicit-zero') {
      return {
        speed: { value: 0, state: 'explicit_zero', source: 'imu' },
        cadence: { value: 0, state: 'explicit_zero', source: 'imu' },
      };
    }
    if (phase === 'live') {
      return {
        speed: { value: 20, state: 'live', source: 'gps' },
        cadence: { value: 90, state: 'live', source: 'csc' },
      };
    }
    return {
      speed: { value: 20, state: 'stale', source: 'gps' },
      cadence: { value: 90, state: 'stale', source: 'csc' },
    };
  };
  const snapshot = () => ({
    elapsedMs: 60000,
    movingMs: 50000,
    distanceM: 400,
    distanceEverAvailable: true,
    distanceState: 'stale',
    distanceSource: 'gps',
    avgSpeedKmh: 18.4,
    avgCadenceRpm: 82,
    metrics: {
      ...metricsForPhase(),
      power: { value: null, state: 'unsupported', source: 'cps' },
      heartRate: { value: null, state: 'unsupported', source: 'hrs' },
    },
    rollout: { suppressImu: false, metersPerCrank: 3.2 },
    imuAssist: { fresh: phase === 'stationary', suppressImu: false },
  });
  page.metrics = { paused: false, snapshot };
  page.imuClassifier = {
    snapshot: () => (phase === 'stationary'
      ? {
        fresh: true,
        motionState: 'stationary',
        confidence: 0.98,
        effectiveCadenceRpm: 0,
        finalCadenceRpm: 0,
        motionArtifact: 'none',
      }
      : {
        fresh: false,
        motionState: 'stale',
        confidence: 0,
        effectiveCadenceRpm: 99,
        finalCadenceRpm: 99,
        simpleGyroDisplayFresh: true,
        motionArtifact: 'none',
      }),
  };
  page.lastLockedImuHudEstimate = {
    speedKmh: 14.2,
    cadenceRpm: 78,
    speedSource: 'imu',
    cadenceSource: 'imu',
    atMs: now - 1000,
  };

  page.updateHudFromMetrics(now);
  assert.equal(page.data.speed, '18.4');
  assert.equal(page.data.cadence, '82');

  phase = 'explicit-zero';
  page.updateHudFromMetrics(now + 1000);
  assert.equal(page.data.speed, '静止');
  assert.equal(page.data.cadence, '静止');
  assert.equal(page.rideHudSpeedHoldRevoked, true);
  assert.equal(page.rideHudCadenceHoldRevoked, true);
  assert.equal(page.lastLockedImuHudEstimate, null);

  phase = 'stale';
  page.updateHudFromMetrics(now + 2000);
  assert.equal(page.data.speed, '恢复中');
  assert.equal(page.data.cadence, '恢复中');
  assert.doesNotMatch(page.data.cyclingSourceText, /录屏保持/);

  phase = 'live';
  page.updateHudFromMetrics(now + 3000);
  assert.equal(page.data.speed, '20.0');
  assert.equal(page.data.cadence, '90');
  assert.equal(page.rideHudSpeedHoldRevoked, false);
  assert.equal(page.rideHudCadenceHoldRevoked, false);

  phase = 'stationary';
  page.updateHudFromMetrics(now + 4000);
  assert.equal(page.data.speed, '静止');
  assert.equal(page.data.cadence, '静止');
  phase = 'stale';
  page.updateHudFromMetrics(now + 5000);
  assert.equal(page.data.speed, '恢复中');
  assert.equal(page.data.cadence, '恢复中');
  assert.doesNotMatch(page.data.cyclingSourceText, /录屏保持/);
  page.onUnload();
});

test('AR 只补发重复 onShow 时，3 秒停流会立即重建 IMU 并重放 HUD', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 800000,
  });
  const page = freshPage({}, { gyroscope: true });
  assert.equal(page.startRide(), true);
  const firstGyroscope = FakeGyroscope.instances[0];
  assert.ok(firstGyroscope);
  t.mock.timers.tick(3100);
  page.onShow();
  assert.equal(FakeGyroscope.instances.length, 2);
  assert.equal(firstGyroscope.stopped, true);
  assert.equal(page.gyroscope, FakeGyroscope.instances[1]);
  page.onUnload();
});

test('眼镜低频 g 输入约 5 秒显示踏频和速度，随后里程开始增长', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage({}, { accelerometer: true });
  assert.equal(page.startRide(), true);
  const sensor = FakeAccelerometer.instances[0];
  const rpm = 88;
  const jitterMs = [-18, 12, -7, 20, -10, 4];
  let atMs = 0;
  let index = 0;
  let visibleAtMs = null;
  while (atMs <= 6500) {
    const stepMs = 182 + jitterMs[index % jitterMs.length]
      + (index > 0 && index % 19 === 0 ? 182 : 0);
    t.mock.timers.tick(stepMs);
    atMs += stepMs;
    const phase = 2 * Math.PI * rpm * atMs / 60000;
    sensor.emitReading(
      0.05 / 9.80665 * Math.sin(phase),
      0,
      1,
      10 + atMs / 1000,
    );
    if (visibleAtMs == null
        && Number(page.data.cadence) > 0
        && Number(page.data.speed) > 0) {
      visibleAtMs = atMs;
    }
    index += 1;
  }
  assert.notEqual(visibleAtMs, null);
  assert.ok(visibleAtMs <= 5300, `实际首次显示 ${visibleAtMs}ms`);
  assertPositiveDisplay(page.data.distance);
  assert.equal(
    page.imuClassifier.snapshot(Date.now()).accelerationUnit,
    'g',
  );
  page.onUnload();
});

test('骑中定位链完全禁用，IMU 与 BLE 仍可独立更新 HUD', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 2400000,
  });
  const geolocation = fakeGeolocation();
  const page = freshPage({}, {
    gyroscope: true,
    navigator: { geolocation },
  });
  assert.equal(page.startRide(), true);
  assert.equal(geolocation.watchCalls.length, 0);
  assert.equal(typeof page.authorizeRideGps, 'undefined');
  assert.equal(typeof page.startRideGps, 'undefined');
  assert.equal(typeof page.handleRideGpsPosition, 'undefined');
  assert.ok(page.gyroscope);
  assert.ok(page.tickTimer);
  page.onUnload();
});

test('AIUI 0.15 setData 镜像异步时四拍提示仍会首启并在 hide/show 后恢复', () => {
  const page = freshPage();
  page.rideSettings = {
    ...page.rideSettings,
    cadenceToneRpm: 80,
  };
  page.setData = () => {};

  assert.equal(page.startRide(), true);
  const tone = page.cadenceTone;
  assert.ok(tone);
  assert.ok(tone._sound.playCalls >= 1);

  const beforeResume = tone._sound.playCalls;
  page.onHide();
  assert.equal(
    page.metrics.paused,
    true,
    '活动会话应依赖同步 session 真值暂停，不能依赖迟到的 surfacePhase 镜像',
  );
  assert.equal(page.tickTimer, null);
  page.onShow();
  assert.equal(page.metrics.paused, false);
  assert.ok(tone._sound.playCalls > beforeResume);
});

test('setData 尚未镜像 HUD 时 hide 仍暂停，show 后 HRS 与新 Gyroscope 恢复', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 900000,
  });
  const page = freshPage({}, { gyroscope: true });
  page.rideSettings = {
    ...page.rideSettings,
    voiceCue: false,
    cadenceToneRpm: 0,
  };
  const patches = [];
  page.setData = (patch) => {
    patches.push({ ...patch });
  };

  assert.equal(page.startRide(), true);
  assert.notEqual(page.data.surfacePhase, 'hud', '模拟宿主尚未镜像 setData');
  const oldGyroscope = FakeGyroscope.instances[0];
  const oldGeneration = page.imuGeneration;
  page.onHide();
  assert.equal(page.metrics.paused, true);
  assert.equal(oldGyroscope.stopped, true);
  assert.equal(page.gyroscope, null);
  assert.equal(
    page.onSourceMeasurement(
      'hrs',
      new Uint8Array([0x00, 128]),
      Date.now(),
      { backgroundRide: true },
    ),
    false,
  );
  assert.equal(page.metrics.snapshot(Date.now()).avgBpm, null);

  oldGyroscope.emitEventReading(0.08, 0.04, 0.02, 80);
  assert.equal(page.gyroscopeReadingCount, 0);

  page.onShow();
  assert.equal(page.metrics.paused, false);
  assert.ok(page.imuGeneration > oldGeneration);
  const gyroscope = page.gyroscope;
  assert.ok(gyroscope);
  assert.notEqual(gyroscope, oldGyroscope);
  assert.equal(
    page.onSourceMeasurement('hrs', new Uint8Array([0x00, 128]), Date.now()),
    true,
  );
  assert.equal(page.metrics.snapshot(Date.now()).avgBpm, 128);

  const rpm = 90;
  for (let index = 0; index <= 100; index += 1) {
    t.mock.timers.tick(50);
    const atMs = index * 50;
    const phase = 2 * Math.PI * rpm * atMs / 60000;
    gyroscope.emitEventReading(
      0.08 * Math.sin(phase),
      0.04 * Math.cos(phase),
      0.02 * Math.sin(phase + 0.4),
      80 + index * 0.05,
    );
  }
  const latestPatch = Object.assign({}, ...patches);
  assert.equal(latestPatch.heartRate, '128');
  assertPositiveDisplay(latestPatch.cadence);
  assertPositiveDisplay(latestPatch.speed);
  assertPositiveDisplay(latestPatch.distance);
  page.onUnload();
});

test('setData 尚未镜像总结时 onUnload 仍持久化 pending summary', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1760000000000,
  });
  const page = freshPage();
  page.rideSettings = {
    ...page.rideSettings,
    voiceCue: false,
    cadenceToneRpm: 0,
  };
  page.setData = () => {};
  assert.equal(page.startRide(), true);
  t.mock.timers.tick(1000);
  assert.equal(page.finishRideToSummary(), true);
  assert.equal(page.isSummaryPhase(), true);
  assert.notEqual(page.data.surfacePhase, 'summary', '模拟宿主尚未镜像 setData');

  page.onUnload();
  assert.equal(page.summaryPersistenceConfirmed, true);
  assert.ok(wx.getStorageSync(LAST_RIDE_SUMMARY_KEY));
});

test('AIUI 0.15 保留单一手工方向传感器且不占用 0.16 页面属性', () => {
  const page = freshPage({}, {
    accelerometer: true,
    gyroscope: true,
    orientation: true,
  });
  assert.equal(page.startRide(), true);
  assert.equal(FakeAbsoluteOrientationSensor.instances.length, 1);
  const orientation = FakeAbsoluteOrientationSensor.instances[0];
  assert.equal(page.rideOrientationSensor, orientation);
  assert.equal(page.rideOrientationSensorOwned, true);
  assert.equal(
    Array.isArray(orientation.listeners.orientationstabilitychange),
    false,
  );
  assert.equal(page.orientationSensor, undefined);
  assert.equal(orientation.startCalls, 1);
  assert.equal(page.worldAwarenessDiagnostics.state, 'unsupported');
  page.onUnload();
  assert.equal(orientation.stopCalls, 1);
});

test('AIUI 0.16 复用 World Awareness 方向传感器且事件只写诊断', () => {
  const worldAwareness = {};
  const page = freshPage({}, {
    accelerometer: true,
    gyroscope: true,
    orientation: true,
    worldAwareness,
  });
  assert.equal(page.startRide(), true);
  assert.equal(worldAwareness.enableCalls, 1);
  assert.equal(FakeAbsoluteOrientationSensor.instances.length, 1);
  const orientation = worldAwareness.sensors[0];
  assert.equal(page.orientationSensor, orientation);
  assert.equal(page.rideOrientationSensor, orientation);
  assert.equal(page.rideOrientationSensorOwned, false);
  assert.equal(
    orientation.listeners.orientationstabilitychange.length,
    1,
  );
  assert.equal(orientation.startCalls, 1, 'host 启动一次，页面不得再次 start');

  const fixedNow = Date.now();
  const before = page.metrics.snapshot(fixedNow);
  let tickCalls = 0;
  page.requestRideTick = () => { tickCalls += 1; return true; };
  const ttsBefore = wx.ttsSpoken.length;
  orientation.emitActivate();
  page.onHeadGesture({ gesture: 'nod', quaternion: [1, 2, 3, 4] });
  page.onHeadGesture({ gesture: 'invalid' });
  orientation.emitStability(false);
  const after = page.metrics.snapshot(fixedNow);
  assert.equal(after.distanceM, before.distanceM);
  assert.deepEqual(after.metrics.speed, before.metrics.speed);
  assert.deepEqual(after.metrics.cadence, before.metrics.cadence);
  assert.equal(tickCalls, 0);
  assert.equal(wx.ttsSpoken.length, ttsBefore);
  assert.equal(wx.navigateToCalls.length, 0);

  const sample = page.buildCyclingLocalFieldSample(
    after,
    fixedNow + 1000,
    'timer',
  );
  assert.equal(sample.world_awareness_state, 'enabled');
  assert.equal(sample.head_gesture, 'nod');
  assert.equal(sample.head_nod_count, 1);
  assert.equal(sample.head_shake_count, 0);
  assert.equal(sample.orientation_stable, false);
  assert.equal(sample.orientation_stability_change_count, 1);
  assert.equal(JSON.stringify(sample).includes('quaternion'), false);

  page.onUnload();
  assert.equal(worldAwareness.disableCalls, 1);
  assert.equal(orientation.stopCalls, 1,
    'host disable 负责 stop，业务页面不得重复停止 managed sensor');
  assert.equal(page.orientationSensor, orientation,
    '业务页面不得清空宿主保留属性');
});

test('AIUI 0.16 hide/show 每代只建一个 managed sensor 并拒绝旧事件', () => {
  const worldAwareness = {};
  const page = freshPage({}, {
    accelerometer: true,
    gyroscope: true,
    worldAwareness,
  });
  assert.equal(page.startRide(), true);
  const first = worldAwareness.sensors[0];
  first.emitActivate();
  first.emitStability(true);
  assert.equal(page.worldAwarenessDiagnostics.orientationStable, true);
  page.onHide();
  assert.equal(worldAwareness.disableCalls, 1);
  assert.equal(page.rideOrientationSensor, null);
  assert.equal((first.listeners.reading || []).length, 0);
  assert.equal((first.listeners.orientationstabilitychange || []).length, 0);

  const countBeforeLateEvent = page.worldAwarenessDiagnostics
    .stabilityChangeCount;
  first.emitStability(false);
  assert.equal(page.worldAwarenessDiagnostics.stabilityChangeCount,
    countBeforeLateEvent);

  page.onShow();
  assert.equal(worldAwareness.enableCalls, 2);
  assert.equal(worldAwareness.sensors.length, 2);
  assert.notEqual(page.rideOrientationSensor, first);
  assert.equal(page.rideOrientationSensor, worldAwareness.sensors[1]);
  const gestureCountBeforeActivation = page.worldAwarenessDiagnostics
    .gestureCount;
  page.onHeadGesture({ gesture: 'nod' });
  assert.equal(page.worldAwarenessDiagnostics.gestureCount,
    gestureCountBeforeActivation,
    '新一代 orientation 激活前拒绝无法归属的页面级迟到事件');
  worldAwareness.sensors[1].emitActivate();
  page.onHeadGesture({ gesture: 'nod' });
  assert.equal(page.worldAwarenessDiagnostics.gestureCount,
    gestureCountBeforeActivation + 1);
  page.onUnload();
  assert.equal(worldAwareness.disableCalls, 2);
});

test('AIUI 0.16 enable 异常或缺 managed sensor 时绝不补建第二实例', () => {
  for (const worldAwareness of [
    { enableThrows: true },
    { missingSensor: true },
    { missingRemoveEventListener: true },
  ]) {
    const page = freshPage({}, {
      accelerometer: true,
      gyroscope: true,
      orientation: true,
      worldAwareness,
    });
    assert.equal(page.startRide(), true);
    assert.equal(
      FakeAbsoluteOrientationSensor.instances.length,
      worldAwareness.missingRemoveEventListener ? 1 : 0,
      '允许宿主创建待清理实例，但页面绝不补建第二实例',
    );
    assert.equal(page.rideOrientationSensor, null);
    assert.ok(page.accelerometer);
    assert.ok(page.gyroscope);
    assert.ok(['error', 'disabled'].includes(
      page.worldAwarenessDiagnostics.state,
    ));
    page.onUnload();
  }
});

test('AIUI 0.16 disable 失败时清理锁阻止下一代重复 enable', () => {
  const worldAwareness = { disableThrows: true };
  const page = freshPage({}, {
    accelerometer: true,
    gyroscope: true,
    orientation: true,
    worldAwareness,
  });
  assert.equal(page.startRide(), true);
  assert.equal(worldAwareness.enableCalls, 1);
  page.onHide();
  assert.equal(page.worldAwarenessDiagnostics.cleanupPending, true);
  page.onShow();
  assert.equal(worldAwareness.enableCalls, 1,
    '旧会话未确认清理前不得创建下一代 managed sensor');
  assert.equal(page.rideOrientationSensor, null);
  assert.equal(page.worldAwarenessDiagnostics.cleanupPending, true);
  worldAwareness.disableThrows = false;
  page.onHide();
  page.onShow();
  assert.equal(worldAwareness.enableCalls, 2,
    '明确清理成功后才允许下一代重新 enable');
  page.onUnload();
});

test('AIUI 0.15 页面使用传感器时间戳并隔离隐藏前旧 IMU 回调', () => {
  const page = freshPage({}, { accelerometer: true });
  assert.equal(page.startRide(), true);
  const firstSensor = FakeAccelerometer.instances[0];
  for (let index = 0; index < 28; index += 1) {
    firstSensor.emitReading(0, 0, 1, 10 + index * 0.04);
  }
  assert.equal(page.imuClassifier.snapshot().accelerationUnit, 'g');
  assert.equal(page.imuClassifier.snapshot().accelerationCalibrated, true);
  assert.match(source, /\n\s*timestamp,\n/);
  assert.match(source, /eventReading\.timestamp/);
  assert.doesNotMatch(source, /timestampMs:\s*now/);

  page.stopRideImu();
  assert.equal(page.startRideImu(), true);
  const secondSensor = FakeAccelerometer.instances[1];
  const secondClassifier = page.imuClassifier;
  assert.equal(secondClassifier.lastSampleMs, null);

  firstSensor.emitReading(2, 0, 1, 20);
  firstSensor.emitError();
  assert.equal(page.accelerometer, secondSensor);
  assert.equal(page.imuClassifier, secondClassifier);
  assert.equal(secondClassifier.lastSampleMs, null);

  secondSensor.emitReading(0, 0, 9.80665, 1000);
  assert.notEqual(secondClassifier.lastSampleMs, null);
});

test('AIUI 0.15 Accelerometer event-only reading 也可进入估算链路', () => {
  const page = freshPage({}, { accelerometer: true });
  assert.equal(page.startRide(), true);
  const sensor = FakeAccelerometer.instances[0];
  sensor.x = Number.NaN;
  sensor.y = Number.NaN;
  sensor.z = Number.NaN;
  sensor.timestamp = Number.NaN;
  sensor.emitEventReading(0, 0, 9.80665, 1000);
  assert.equal(page.imuReadingCount, 1);
  assert.notEqual(page.imuClassifier.lastSampleMs, null);
  page.updateHudFromMetrics(Date.now());
  assert.match(page.data.cyclingSourceText, /加速度已就绪/);
  page.onUnload();
});

test('没有 Accelerometer API 时 Gyroscope event-only 约 2.5 秒点亮三项估算', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 300000,
  });
  const page = freshPage({}, {
    gyroscope: true,
    orientation: true,
  });
  assert.equal(page.startRide(), true);
  assert.equal(page.accelerometer, null);
  assert.equal(page.imuDiagnosticState, 'gyro-started');
  const gyroscope = FakeGyroscope.instances[0];
  const orientation = FakeAbsoluteOrientationSensor.instances[0];
  gyroscope.x = Number.NaN;
  gyroscope.y = Number.NaN;
  gyroscope.z = Number.NaN;
  gyroscope.timestamp = Number.NaN;
  orientation.quaternion = null;
  orientation.timestamp = Number.NaN;

  const rpm = 90;
  let firstVisibleAtMs = null;
  for (let index = 0; index <= 130; index += 1) {
    t.mock.timers.tick(50);
    const atMs = index * 50;
    const phase = 2 * Math.PI * rpm * atMs / 60000;
    orientation.emitEventReading([0, 0, 0, 1], 40 + index * 0.05);
    gyroscope.emitEventReading(
      0.08 * Math.sin(phase),
      0.04 * Math.cos(phase),
      0.02 * Math.sin(phase + 0.4),
      40 + index * 0.05,
    );
    page.updateHudFromMetrics(Date.now());
    if (firstVisibleAtMs == null && Number(page.data.cadence) > 0) {
      firstVisibleAtMs = atMs;
    }
  }

  const activity = page.imuClassifier.snapshot(Date.now());
  assert.ok(firstVisibleAtMs != null && firstVisibleAtMs <= 3000);
  assert.equal(activity.cadenceSensorSource, 'gyroscope_simple');
  assert.match(activity.cadenceSensorSource, /gyroscope|fused/);
  assert.ok(Math.abs(activity.effectiveCadenceRpm - rpm) < 3);
  assertPositiveDisplay(page.data.cadence);
  assertPositiveDisplay(page.data.speed);
  assertPositiveDisplay(page.data.distance);
  assert.match(page.data.cyclingSourceText, /估算/);
  assert.ok(page.gyroscopeReadingCount > 100);
  assert.ok(page.orientationReadingCount > 100);
  assert.equal(page.imuRestartTimer, null);
  page.onUnload();
});

test('AR 开启前尚未锁定时 hidden 拒绝旧回调，show 后新 Gyroscope 5 秒内显示三项', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 320000,
  });
  const page = freshPage({}, { gyroscope: true });
  assert.equal(page.startRide(), true);
  const oldGyroscope = FakeGyroscope.instances[0];
  const oldGeneration = page.imuGeneration;
  page.onHide();
  assert.equal(page.metrics.paused, true);
  assert.equal(oldGyroscope.stopped, true);
  assert.equal(page.gyroscope, null);

  const rpm = 90;
  for (let index = 0; index <= 100; index += 1) {
    t.mock.timers.tick(50);
    const atMs = index * 50;
    const phase = 2 * Math.PI * rpm * atMs / 60000;
    oldGyroscope.emitEventReading(
      0.08 * Math.sin(phase),
      0.04 * Math.cos(phase),
      0.02 * Math.sin(phase + 0.4),
      80 + index * 0.05,
    );
  }
  assert.equal(page.gyroscopeReadingCount, 0);
  assert.equal(Number(page.data.cadence) > 0, false);
  assert.equal(Number(page.data.speed) > 0, false);

  page.onShow();
  assert.equal(page.metrics.paused, false);
  assert.ok(page.imuGeneration > oldGeneration);
  const gyroscope = page.gyroscope;
  assert.ok(gyroscope);
  assert.notEqual(gyroscope, oldGyroscope);
  for (let index = 0; index <= 100; index += 1) {
    t.mock.timers.tick(50);
    const atMs = index * 50;
    const phase = 2 * Math.PI * rpm * atMs / 60000;
    gyroscope.emitEventReading(
      0.08 * Math.sin(phase),
      0.04 * Math.cos(phase),
      0.02 * Math.sin(phase + 0.4),
      90 + index * 0.05,
    );
  }
  assertPositiveDisplay(page.data.cadence);
  assertPositiveDisplay(page.data.speed);
  assertPositiveDisplay(page.data.distance);
  assert.equal(page.gyroscope, gyroscope);
  page.onUnload();
});

test('健康 Accelerometer 不掩盖零帧 Gyroscope，30 秒只独立有界重试 gyro', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 340000,
  });
  const page = freshPage({}, {
    accelerometer: true,
    gyroscope: true,
  });
  assert.equal(page.startRide(), true);
  const accelerometer = FakeAccelerometer.instances[0];
  const classifier = page.imuClassifier;
  const generation = page.imuGeneration;
  for (let index = 0; index < 750; index += 1) {
    t.mock.timers.tick(40);
    const phase = 2 * Math.PI * 86 * (index * 40) / 60000;
    accelerometer.emitReading(
      0.7 * Math.sin(phase),
      0.35 * Math.cos(phase),
      9.80665 + 0.15 * Math.sin(phase + 0.6),
      100 + index * 0.04,
    );
  }
  assert.equal(FakeAccelerometer.instances.length, 1);
  assert.equal(page.accelerometer, accelerometer);
  assert.equal(page.imuClassifier, classifier);
  assert.equal(page.imuGeneration, generation);
  assert.ok(FakeGyroscope.instances.length >= 2);
  assert.ok(FakeGyroscope.instances.length <= 6, 'gyro 重试必须指数退避且有界');
  page.onUnload();
});

test('Accelerometer 构造或启动失败时保留同代 Gyroscope 后备', () => {
  class ConstructorFailureAccelerometer {
    constructor() {
      throw new Error('constructor failed');
    }
  }
  class StartFailureAccelerometer {
    constructor() {
      this.listeners = {};
      this.stopped = false;
    }

    addEventListener(type, callback) {
      (this.listeners[type] ||= []).push(callback);
    }

    start() {
      throw new Error('start failed');
    }

    stop() {
      this.stopped = true;
    }
  }

  for (const AccelerometerCtor of [
    ConstructorFailureAccelerometer,
    StartFailureAccelerometer,
  ]) {
    const page = freshPage({}, {
      accelerometerCtor: AccelerometerCtor,
      gyroscope: true,
    });
    assert.equal(page.startRide(), true);
    assert.equal(page.accelerometer, null);
    assert.ok(page.gyroscope);
    assert.equal(page.imuDiagnosticState, 'gyro-started');
    assert.equal(page.imuRestartTimer, null);
    page.onUnload();
  }
});

test('Craft 0.15 传感器桥连续启动失败时超过三次仍按上限退避恢复', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 275000,
  });
  class CountingFailureAccelerometer {
    static attempts = 0;

    constructor() {
      CountingFailureAccelerometer.attempts += 1;
      throw new Error('bridge unavailable');
    }
  }
  const page = freshPage({}, {
    accelerometerCtor: CountingFailureAccelerometer,
  });
  assert.equal(page.startRide(), true);
  assert.equal(CountingFailureAccelerometer.attempts, 1);
  for (let attempt = 2; attempt <= 4; attempt += 1) {
    t.mock.timers.tick(1200);
    assert.equal(CountingFailureAccelerometer.attempts, attempt);
  }
  assert.equal(page.imuDiagnosticState, 'restarting');
  t.mock.timers.tick(2399);
  assert.equal(CountingFailureAccelerometer.attempts, 4);
  t.mock.timers.tick(1);
  assert.equal(CountingFailureAccelerometer.attempts, 5);
  assert.notEqual(page.imuDiagnosticState, 'failed');
  page.onUnload();
});

test('Accelerometer 运行错误原子重建完整 IMU bundle，旧 Gyroscope 不得续写', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 280000,
  });
  const page = freshPage({}, {
    accelerometer: true,
    gyroscope: true,
  });
  assert.equal(page.startRide(), true);
  const generation = page.imuGeneration;
  const accelerometer = FakeAccelerometer.instances[0];
  const gyroscope = FakeGyroscope.instances[0];
  accelerometer.emitError();
  assert.ok(page.imuGeneration > generation);
  assert.equal(page.accelerometer, null);
  assert.equal(page.gyroscope, null);
  assert.equal(accelerometer.stopped, true);
  assert.equal(gyroscope.stopped, true);
  assert.notEqual(page.imuRestartTimer, null);

  gyroscope.emitEventReading(0, 0, 3, 999);
  assert.equal(page.gyroscopeReadingCount, 0);
  t.mock.timers.tick(1200);
  assert.ok(page.accelerometer);
  assert.ok(page.gyroscope);
  assert.notEqual(page.accelerometer, accelerometer);
  assert.notEqual(page.gyroscope, gyroscope);
  assert.equal(page.imuRestartTimer, null);
  page.onUnload();
});

test('AIUI 0.15 三传感器按独立时间轴接入，简易陀螺仪在转头中仍保持三项估算', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 250000,
  });
  const page = freshPage({}, {
    accelerometer: true,
    gyroscope: true,
    orientation: true,
  });
  assert.equal(page.startRide(), true);
  const accelerometer = FakeAccelerometer.instances[0];
  const gyroscope = FakeGyroscope.instances[0];
  const orientation = FakeAbsoluteOrientationSensor.instances[0];
  const generation = page.imuGeneration;
  assert.equal(accelerometer.options.frequency, 50);
  assert.equal(gyroscope.options.frequency, 50);
  assert.equal(orientation.options.frequency, 30);
  accelerometer.emitActivate();
  gyroscope.emitActivate();
  assert.equal(page.accelerometerActivated, true);
  assert.equal(page.gyroscopeActivated, true);

  const rpm = 90;
  for (let index = 0; index <= 250; index += 1) {
    t.mock.timers.tick(40);
    const atMs = index * 40;
    const phase = 2 * Math.PI * rpm * atMs / 60000;
    gyroscope.emitReading(0.02 * Math.sin(phase), 0.01, 0.02, 20 + index * 0.04);
    orientation.emitReading([0, 0, 0, 1], 20000 + index * 40);
    accelerometer.emitReading(
      0.9 * Math.sin(phase),
      0.5 * Math.cos(phase + 0.2),
      9.80665 + 0.2 * Math.sin(phase + 0.7),
      20000000 + index * 40000,
    );
  }
  let activity = page.imuClassifier.snapshot(Date.now());
  assert.equal(activity.motionQualityState, 'trusted');
  assert.equal(activity.cadenceState, 'estimated');
  assert.ok(Math.abs(activity.finalCadenceRpm - rpm) < 3);
  const distanceBeforeTurn = page.metrics.snapshot(Date.now()).distanceM;
  assert.equal(page.gyroscopeDiagnosticState, 'reading');
  assert.equal(page.orientationDiagnosticState, 'reading');
  // 模拟 AR 录屏把 50Hz 请求限流到约 25Hz：权限/activate 仍成功，
  // 实际频率可由诊断读出，且降频后仍必须在 5 秒内形成三项估算。
  assert.ok(page.gyroscopeObservedHz > 24);
  assert.ok(page.gyroscopeObservedHz < 26);

  for (let index = 1; index <= 15; index += 1) {
    t.mock.timers.tick(40);
    const atMs = (250 + index) * 40;
    const phase = 2 * Math.PI * rpm * atMs / 60000;
    gyroscope.emitReading(0, 0, 1.45, 30 + index * 0.04);
    orientation.emitReading(
      yawQuaternion(index / 15 * 0.62),
      30000 + index * 40,
    );
    accelerometer.emitReading(
      0.9 * Math.sin(phase),
      0.5 * Math.cos(phase + 0.2),
      9.80665,
      30000000 + index * 40000,
    );
  }
  activity = page.imuClassifier.snapshot(Date.now());
  assert.equal(activity.cadenceState, 'estimated');
  assert.ok(Math.abs(activity.finalCadenceRpm - rpm) < 3);
  assert.ok(Math.abs(activity.effectiveCadenceRpm - rpm) < 3);
  assert.equal(activity.cadenceUsable, true);
  assert.match(activity.cadenceSensorSource, /gyroscope|fused/);
  assert.equal(activity.rawMotionArtifact, 'head_turn');
  assert.equal(activity.motionArtifact, 'none');
  assert.equal(activity.motionQualityState, 'head_motion');
  const filteredMetrics = page.metrics.snapshot(Date.now());
  assert.ok(filteredMetrics.speedKmh > 0);
  assert.ok(filteredMetrics.cadenceRpm > 0);
  page.updateHudFromMetrics(Date.now());
  assertPositiveDisplay(page.data.speed);
  assertPositiveDisplay(page.data.cadence);
  assert.match(page.data.cyclingSourceText, /估算/);
  const distanceAtFilter = page.metrics.snapshot(Date.now()).distanceM;
  assert.ok(distanceAtFilter >= distanceBeforeTurn);
  t.mock.timers.tick(1000);
  page.metrics.onImuActivity(activity, Date.now());
  page.updateHudFromMetrics(Date.now());
  assert.ok(page.metrics.snapshot(Date.now()).distanceM > distanceAtFilter);
  assertPositiveDisplay(page.data.speed);
  assertPositiveDisplay(page.data.cadence);
  assert.equal(page.imuGeneration, generation);
  assert.equal(page.accelerometer, accelerometer);
  assert.equal(page.imuRestartTimer, null);
  page.onUnload();
});

test('辅助 IMU error 独立重试，AR hide/show 释放整束并新 generation 重建', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 350000,
  });
  const page = freshPage({}, {
    accelerometer: true,
    gyroscope: true,
    orientation: true,
  });
  page.startRide();
  const firstAccelerometer = FakeAccelerometer.instances[0];
  const firstGyroscope = FakeGyroscope.instances[0];
  const firstOrientation = FakeAbsoluteOrientationSensor.instances[0];
  const generation = page.imuGeneration;

  firstGyroscope.emitError();
  firstOrientation.emitError();
  assert.equal(page.gyroscopeDiagnosticState, 'restarting');
  assert.equal(page.orientationDiagnosticState, 'error');
  assert.equal(page.imuGeneration, generation);
  assert.equal(page.accelerometer, firstAccelerometer);
  assert.equal(page.imuRestartTimer, null);
  assert.notEqual(page.gyroscopeRestartTimer, null);

  for (let index = 0; index <= 300; index += 1) {
    t.mock.timers.tick(40);
    const atMs = index * 40;
    const phase = 2 * Math.PI * 84 * atMs / 60000;
    firstAccelerometer.emitReading(
      0.75 * Math.sin(phase),
      0.4 * Math.cos(phase + 0.2),
      9.80665 + 0.16 * Math.sin(phase + 0.7),
      index * 0.04,
    );
  }
  const fallback = page.imuClassifier.snapshot(Date.now());
  assert.equal(fallback.motionQualityState, 'accel_only');
  assert.equal(fallback.cadenceState, 'estimated');

  const activeGate = page.imuMotionQuality;
  const activeGyroscope = page.gyroscope;
  const accelerometerCount = FakeAccelerometer.instances.length;
  page.onHide();
  assert.equal(firstAccelerometer.stopped, true);
  assert.equal(firstGyroscope.stopped, true);
  assert.equal(firstOrientation.stopped, true);
  assert.equal(page.metrics.paused, true);
  assert.equal(page.accelerometer, null);
  assert.equal(page.gyroscope, null);
  if (activeGyroscope) assert.equal(activeGyroscope.stopped, true);
  assert.equal(page.rideOrientationSensor, null);
  page.onShow();
  const resumedGate = page.imuMotionQuality;
  assert.notEqual(resumedGate, activeGate);
  assert.ok(page.imuGeneration > generation);
  assert.equal(page.metrics.paused, false);
  assert.equal(FakeAccelerometer.instances.length, accelerometerCount + 1);
  assert.ok(FakeGyroscope.instances.length >= 2);
  assert.notEqual(page.accelerometer, firstAccelerometer);
  assert.notEqual(page.gyroscope, activeGyroscope);

  firstGyroscope.emitReading(0, 0, 3, 999);
  firstOrientation.emitReading(yawQuaternion(1), 999);
  assert.equal(page.imuMotionQuality, resumedGate);
  assert.equal(resumedGate.gyroSamples.length, 0);
  assert.equal(resumedGate.orientationSamples.length, 0);
  page.onUnload();
});

test('Accelerometer 无有效首帧 5 秒后有界重建，NaN 回调不能伪装健康', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 300000,
  });
  const page = freshPage({}, { accelerometer: true });
  assert.equal(page.startRide(), true);
  const firstSensor = FakeAccelerometer.instances[0];
  firstSensor.emitReading(Number.NaN, 0, 9.8, 1);
  firstSensor.emitReading(null, null, null, 2);
  assert.equal(page.imuReadingCount, 0);

  t.mock.timers.tick(5000);
  assert.equal(firstSensor.stopped, true);
  assert.equal(page.imuDiagnosticState, 'restarting');
  t.mock.timers.tick(1200);
  assert.equal(FakeAccelerometer.instances.length, 2);
  assert.equal(page.accelerometer, FakeAccelerometer.instances[1]);
  page.onUnload();
});

test('Accelerometer 首帧后断流 10 秒重建，sensor error 也走同一有界恢复', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 400000,
  });
  const page = freshPage({}, { accelerometer: true });
  assert.equal(page.startRide(), true);
  const firstSensor = FakeAccelerometer.instances[0];
  firstSensor.emitReading(0, 0, 9.80665, 1);

  t.mock.timers.tick(10000);
  assert.equal(firstSensor.stopped, true);
  t.mock.timers.tick(1200);
  const secondSensor = FakeAccelerometer.instances[1];
  assert.equal(page.accelerometer, secondSensor);
  secondSensor.emitError();
  assert.equal(secondSensor.stopped, true);
  t.mock.timers.tick(1200);
  assert.equal(FakeAccelerometer.instances.length, 3);
  assert.equal(page.accelerometer, FakeAccelerometer.instances[2]);
  page.onUnload();
});

test('Accelerometer 持续低于可识别频率时不会无限等待未知踏频', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 450000,
  });
  const page = freshPage({}, { accelerometer: true });
  page.startRide();
  const slowSensor = FakeAccelerometer.instances[0];
  for (let index = 0; index < 21; index += 1) {
    t.mock.timers.tick(250);
    slowSensor.emitReading(0.1, 0, 9.8, 1 + index * 0.25);
  }
  assert.equal(slowSensor.stopped, true);
  assert.equal(page.imuDiagnosticState, 'restarting');
  t.mock.timers.tick(1200);
  assert.equal(FakeAccelerometer.instances.length, 2);
  page.onUnload();
});

test('接近 8Hz 的轻微丢帧仍属于可分析频率且不误重启', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 475000,
  });
  const page = freshPage({}, { accelerometer: true });
  page.startRide();
  const sensor = FakeAccelerometer.instances[0];
  for (let index = 0; index <= 38; index += 1) {
    t.mock.timers.tick(135);
    sensor.emitReading(0.1, 0, 9.8, 1 + index * 0.135);
  }
  assert.equal(sensor.stopped, false);
  assert.equal(page.accelerometer, sensor);
  assert.equal(page.imuRestartTimer, null);
  assert.equal(page.imuLowRateWindowCount, 0);

  for (let index = 1; index <= 126; index += 1) {
    t.mock.timers.tick(40);
    sensor.emitReading(0.1, 0, 9.8, 10 + index * 0.04);
  }
  assert.equal(sensor.stopped, false);
  assert.equal(page.imuLowRateWindowCount, 0);
  assert.equal(page.imuDiagnosticState, 'reading');
  page.onUnload();
});

test('AR hide 取消 IMU 重建，show 换新句柄；总结会阻止复活', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 500000,
  });
  const hiddenPage = freshPage({}, { accelerometer: true });
  hiddenPage.startRide();
  const hiddenSensor = FakeAccelerometer.instances[0];
  hiddenSensor.emitError();
  assert.notEqual(hiddenPage.imuRestartTimer, null);
  hiddenPage.onHide();
  t.mock.timers.tick(5000);
  assert.equal(FakeAccelerometer.instances.length, 1);
  assert.equal(hiddenPage.accelerometer, null);
  assert.equal(hiddenPage.imuRestartTimer, null);
  assert.equal(hiddenPage.metrics.paused, true);
  hiddenPage.onShow();
  assert.equal(FakeAccelerometer.instances.length, 2);
  assert.equal(hiddenPage.accelerometer, FakeAccelerometer.instances[1]);
  assert.equal(hiddenPage.metrics.paused, false);
  hiddenPage.onUnload();

  const summaryPage = freshPage({}, { accelerometer: true });
  summaryPage.startRide();
  const summarySensor = FakeAccelerometer.instances[0];
  summarySensor.emitError();
  assert.equal(summaryPage.finishRideToSummary(), true);
  t.mock.timers.tick(5000);
  assert.equal(FakeAccelerometer.instances.length, 1);
  summaryPage.onUnload();
});

test('GlobalHook 后 300ms 到达的方向只移动焦点，不误激活菜单', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage({ mode: 'menu' });
  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  t.mock.timers.tick(300);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 2);
  assert.equal(page.data.surfacePhase, 'menu');
  t.mock.timers.tick(400);
  assert.equal(page.data.surfacePhase, 'menu');
});

test('搜索页 GlobalHook 后 599ms 到达的方向仍只移动焦点', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  page.recordDiscoveredDevice({ id: 'sensor-1', name: 'Bike Sensor' });
  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  t.mock.timers.tick(599);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.searchFocusIndex, 1);
  assert.equal(page.scanAttempted, false);
  assert.equal(page.data.surfacePhase, 'ready');
  t.mock.timers.tick(1);
  assert.equal(page.scanAttempted, false);
});

test('方向同义别名在 600ms 内只移动一次，同键与反向仍保持可操作', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage({ mode: 'menu' });
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  t.mock.timers.tick(599);
  page.onKeyUp({ code: 'ArrowRight', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 2, 'Down→Right 属于同一次前划');

  t.mock.timers.tick(1);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 1, '同键超过 220ms 可作为下一次独立滑动');
  page.onKeyUp({ code: 'ArrowUp', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 2, '反向修正不受同向去重窗影响');
});

test('方向只在 keyup 提交，焦点重建和迟到 bindfocus 不会重复移动', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage({ mode: 'menu' });
  page.onKeyDown({ code: 'ArrowDown' });
  assert.equal(page.menuFocusIndex, 1);
  page.onHostBlur();
  page.onHostFocus();

  let prevented = false;
  page.onKeyUp({
    code: 'ArrowDown',
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(page.menuFocusIndex, 2);
  assert.equal(page.onMenuFocus({
    currentTarget: { dataset: { index: 1 } },
  }), false);
  assert.equal(page.menuFocusIndex, 2);

  t.mock.timers.tick(600);
  assert.equal(page.onMenuFocus({
    currentTarget: { dataset: { index: 1 } },
  }), true);
  assert.equal(page.menuFocusIndex, 1);
});

test('CSC 两帧才显示真实轮速、踏频和距离；HRS 只提供心率', () => {
  const page = freshPage();
  page.startRide();
  const started = page.metrics.startMs;
  page.metrics.onCsc({
    flags: 3,
    wheel: { revolutions: 100, lastEventTime1024: 0 },
    crank: { revolutions: 10, lastEventTime1024: 0 },
  }, started);
  page.metrics.onCsc({
    flags: 3,
    wheel: { revolutions: 101, lastEventTime1024: 1024 },
    crank: { revolutions: 11, lastEventTime1024: 768 },
  }, started + 1000);
  page.updateHudFromMetrics(started + 2000);
  assert.equal(page.data.speed, '7.6');
  assert.equal(page.data.cadence, '80');
  assert.notEqual(page.data.distance, '--');

  page.onSourceMeasurement('hrs', new Uint8Array([0x00, 128]), started + 2100);
  assert.equal(page.data.heartRate, '128');
  assert.equal(page.data.showHeartRate, true);
  assert.equal(page.data.cadence, '80', '心率包不能改写踏频');
});

test('AR hidden 暂停 HRS 聚合，show 后同一通知资源恢复', async () => {
  const characteristic = fakeCharacteristic();
  const server = hrsOnlyServer(characteristic);
  const device = {
    id: 'garmin-hrs-ar',
    name: 'Garmin HRS',
    gatt: {
      async connect() { return server; },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const page = freshPage();
  assert.equal(await page.connectSelected(device), true);
  assert.equal(page.startRide(), true);
  assert.equal(page.data.showHeartRate, true);
  assert.equal(page.data.heartRateStatus, '心率等待');

  characteristic.emit(new Uint8Array([0x00, 120]));
  assert.equal(page.data.heartRate, '120');
  assert.equal(page.data.heartRateStatus, '心率实时');
  assert.equal(page.metrics.snapshot(Date.now()).avgBpm, 120);

  page.onHide();
  characteristic.emit(new Uint8Array([0x00, 121]));
  assert.equal(page.data.heartRate, '120');
  assert.equal(page.data.heartRateStatus, '心率实时');
  assert.equal(
    page.metrics.snapshot(Date.now()).avgBpm,
    120,
    'hidden 暂停阶段不能把迟到 HRS 包写入聚合',
  );

  page.onShow();
  assert.equal(page.data.heartRate, '120');
  characteristic.emit(new Uint8Array([0x00, 122]));
  assert.equal(page.data.heartRate, '122');
  assert.equal(page.metrics.snapshot(Date.now()).avgBpm, 121);
});

test('可见 HUD stopTicker 后连续 HRS 包经 500ms 门推进完整 HUD 与 elapsed', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1000000,
  });
  const page = freshPage();
  page.rideSettings = {
    ...page.rideSettings,
    voiceCue: false,
    cadenceToneRpm: 0,
  };
  assert.equal(page.startRide(), true);
  page.subscribedSources = { ...page.subscribedSources, hrs: true };
  page.heartRateExpected = true;
  page.stopTicker();

  const originalTick = page.tick.bind(page);
  const fullHudTickAtMs = [];
  page.tick = (atMs) => {
    fullHudTickAtMs.push(atMs);
    return originalTick(atMs);
  };

  t.mock.timers.tick(1000);
  assert.equal(
    page.onSourceMeasurement('hrs', new Uint8Array([0x00, 120]), Date.now()),
    true,
  );
  assert.equal(page.data.heartRate, '120');
  assert.equal(page.data.elapsed, '00:01');
  assert.equal(fullHudTickAtMs.length, 1);

  t.mock.timers.tick(500);
  assert.equal(
    page.onSourceMeasurement('hrs', new Uint8Array([0x00, 121]), Date.now()),
    true,
  );
  assert.equal(fullHudTickAtMs.length, 2);

  t.mock.timers.tick(500);
  assert.equal(
    page.onSourceMeasurement('hrs', new Uint8Array([0x00, 122]), Date.now()),
    true,
  );
  assert.equal(page.data.heartRate, '122');
  assert.equal(page.data.elapsed, '00:02');
  assert.equal(fullHudTickAtMs.length, 3);
  page.onUnload();
});

test('HRS 首包20秒与续包8秒保活在 hidden 不重启，onShow 请求恢复', () => {
  const page = freshPage();
  page.startRide();
  const now = Date.now();
  page.subscribedSources = { hrs: true };
  page.notificationResources = [{
    source: 'hrs',
    active: true,
    committed: true,
  }];
  page.bleServer = { connected: true };
  page.heartRateExpected = true;
  page.heartRateEverLive = true;
  page.heartRateSubscribedAtMs = now - 30000;
  page.lastHrsPacketAtMs = now - 9001;
  page.lastHeartRateDisplayAtMs = now - 9001;
  page.lastHeartRateDisplayBpm = 142;
  let recoveryCalls = 0;
  page.restartBleForStaleSource = () => {
    recoveryCalls += 1;
    return true;
  };

  const hidden = page.evaluateRideSourceHealth(now, 'hidden');
  assert.equal(hidden.hrs.state, 'stale');
  assert.equal(hidden.hrs.shouldKeepLastValue, true);
  assert.equal(recoveryCalls, 0);

  const shown = page.evaluateRideSourceHealth(now, 'show');
  assert.equal(shown.hrs.state, 'stale');
  assert.equal(shown.hrs.shouldRestart, true);
  assert.equal(recoveryCalls, 1);
  assert.equal(page.data.heartRateStatus, '心率恢复');
  page.onUnload();
});

test('HRS notification 恢复撞上 AR hide 时不在 hidden 调 startNotifications', async () => {
  const stopFlight = deferred();
  const characteristic = fakeCharacteristic();
  characteristic.stopNotifications = function stopNotifications() {
    this.stopCalls += 1;
    return stopFlight.promise;
  };
  const server = hrsOnlyServer(characteristic);
  const device = {
    id: 'hrs-hide-recovery',
    name: 'Garmin HRS',
    gatt: { async connect() { return server; } },
    addEventListener() {},
    removeEventListener() {},
  };
  const page = freshPage();
  assert.equal(await page.connectSelected(device), true);
  assert.equal(page.startRide(), true);
  const resource = page.notificationResources.find((item) => item.source === 'hrs');
  assert.ok(resource);
  assert.equal(characteristic.startCalls, 1);
  assert.equal(page.restartHrsNotification(resource), true);
  await Promise.resolve();
  assert.equal(characteristic.stopCalls, 1);

  page.onHide();
  stopFlight.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(characteristic.startCalls, 1);
  assert.equal(resource.active, true);
  assert.equal(page.hrsRecoveryPending, true);

  let fullRecoveryCalls = 0;
  page.restartBleForStaleSource = (_source, _now, options) => {
    if (options && options.forceFull === true) fullRecoveryCalls += 1;
    return true;
  };
  page.onShow();
  assert.equal(fullRecoveryCalls, 1);
  assert.equal(page.hrsRecoveryPending, false);
  page.onUnload();
});

test('FTMS 不带可选心率时持续骑行不会误触发 HRS 重连，后到心率可动态显示', () => {
  const page = freshPage();
  page.startRide();
  const now = Date.now();
  page.subscribedSources = { ftms: true };
  page.notificationResources = [{
    source: 'ftms',
    active: true,
    committed: true,
  }];
  page.bleServer = { connected: true };
  let recoveryCalls = 0;
  page.restartBleForStaleSource = () => {
    recoveryCalls += 1;
    return true;
  };

  for (let second = 1; second <= 60; second += 1) {
    assert.equal(page.onSourceMeasurement('ftms', {
      speedKmh: 24,
      cadenceRpm: 88,
      powerW: null,
      heartRateBpm: null,
      totalDistanceM: second * 6,
    }, now + second * 1000), true);
  }
  const health = page.evaluateRideSourceHealth(now + 60000, 'active');
  assert.equal(health.hrs.state, 'unsupported');
  assert.equal(recoveryCalls, 0);
  assert.equal(page.data.showHeartRate, false);

  assert.equal(page.onSourceMeasurement('ftms', {
    speedKmh: 24,
    cadenceRpm: 88,
    powerW: null,
    heartRateBpm: 137,
    totalDistanceM: 366,
  }, now + 61000), true);
  assert.equal(page.data.heartRate, '137');
  assert.equal(page.data.heartRateStatus, '心率实时');
});

test('HRS 未贴合包也推进包时钟，连续收到时不得误判通知停流', () => {
  const page = freshPage();
  page.startRide();
  const started = page.metrics.startMs;
  page.subscribedSources = { hrs: true };
  page.notificationResources = [{
    source: 'hrs',
    active: true,
    committed: true,
  }];
  page.bleServer = { connected: true };
  page.heartRateExpected = true;
  page.heartRateSubscribedAtMs = started;
  let recoveryCalls = 0;
  page.restartBleForStaleSource = () => {
    recoveryCalls += 1;
    return true;
  };

  for (let second = 1; second <= 30; second += 1) {
    assert.equal(
      page.onSourceMeasurement(
        'hrs',
        new Uint8Array([0b0100, 0]),
        started + second * 1000,
      ),
      true,
    );
  }
  const health = page.evaluateRideSourceHealth(started + 30001, 'active');
  assert.equal(health.hrs.state, 'fresh');
  assert.equal(recoveryCalls, 0);
  assert.equal(page.data.heartRateStatus, '心率未贴合');
});

test('AR 恢复首帧保留最后可信心率并明确标记恢复中', () => {
  const page = freshPage();
  page.startRide();
  const now = Date.now();
  page.heartRateExpected = true;
  page.heartRateEverLive = true;
  page.lastHeartRateDisplayBpm = 142;
  page.lastHeartRateDisplayAtMs = now - 12000;
  page.updateHudFromMetrics(now);
  assert.equal(page.data.heartRate, '142');
  assert.equal(page.data.heartRateStatus, '心率恢复中');
});

test('HRS 停流优先只重启该通知，不断开仍健康的 CSC', async () => {
  const page = freshPage();
  page.startRide();
  const hrs = fakeCharacteristic();
  const csc = fakeCharacteristic();
  const server = {
    connected: true,
    disconnectCalls: 0,
    async disconnect() {
      this.disconnectCalls += 1;
      this.connected = false;
    },
  };
  const device = { id: 'combined-sensor' };
  const hrsResource = {
    source: 'hrs',
    active: true,
    committed: true,
    characteristic: hrs,
    listener() {},
    server,
    device,
  };
  const cscResource = {
    source: 'csc',
    active: true,
    committed: true,
    characteristic: csc,
    listener() {},
    server,
    device,
  };
  page.connectedDevice = device;
  page.reconnectDevice = device;
  page.bleServer = server;
  page.notificationResources = [hrsResource, cscResource];
  page.notificationOwnerResources = [hrsResource, cscResource];
  page.subscribedSources = { hrs: true, csc: true };
  page.heartRateSubscribedAtMs = Date.now() - 30000;

  assert.equal(page.restartBleForStaleSource('hrs', Date.now()), true);
  await page.bleSourceRecoveryFlight;
  assert.equal(hrs.stopCalls, 1);
  assert.equal(hrs.startCalls, 1);
  assert.equal(server.disconnectCalls, 0);
  assert.equal(cscResource.active, true);
  assert.ok(page.notificationResources.includes(cscResource));
  assert.equal(page.subscribedSources.csc, true);
});

test('骑中教练只用 live 新鲜指标做 5 分钟限频播报', () => {
  const page = freshPage();
  assert.equal(page.startRide(), true);
  page.clearTtsRuntime({ resetDedupe: true });
  const cue = page.updateRideCoach({
    elapsedMs: 300000,
    distanceM: 3200,
    paused: false,
    metrics: {
      speed: { value: 23.4, state: 'live', source: 'gps', ageMs: 500 },
      cadence: { value: 86, state: 'live', source: 'imu', ageMs: 500 },
      heartRate: { value: 142, state: 'stale', source: 'hrs', ageMs: 9000 },
    },
  }, 300000);
  assert.match(cue, /骑行 5 分钟/);
  assert.match(cue, /踏频 86/);
  assert.doesNotMatch(cue, /心率 142/);
  assert.equal(wx.ttsSpoken.at(-1), cue);
});

test('连接成功只记住本地 BLE 服务，不产生账号或公开身份绑定', async () => {
  const page = freshPage();
  const characteristic = {
    addEventListener() {},
    removeEventListener() {},
    async startNotifications() {},
    async stopNotifications() {},
  };
  const server = {
    async getPrimaryService(uuid) {
      if (!String(uuid).includes('1816')) throw new Error('unsupported');
      return {
        async getCharacteristic(uuid) {
          if (!String(uuid).includes('2a5b')) throw new Error('unsupported');
          return characteristic;
        },
      };
    },
    async disconnect() {},
  };
  const device = {
    id: 'bike-sensor-1',
    name: 'Garmin Bike Sensor',
    gatt: { async connect() { return server; } },
    addEventListener() {},
    removeEventListener() {},
  };

  assert.equal(await page.connectSelected(device), true);
  const remembered = readRideDevice(wx);
  assert.equal(remembered.deviceId, 'bike-sensor-1');
  assert.deepEqual(remembered.services, ['csc']);
  assert.equal([...wx.store.keys()].some((key) => /identity|binding|owner|token/i.test(key)), false);
});

test('hide/show 后显式选择可抢占自动恢复，旧连接迟到不得覆盖新设备', async () => {
  const page = freshPage();
  const firstConnect = deferred();
  const secondConnect = deferred();
  const firstServer = cscOnlyServer();
  const secondServer = cscOnlyServer();
  const firstDevice = {
    id: 'old-device',
    name: 'Old',
    gatt: { connect() { return firstConnect.promise; } },
    addEventListener() {},
    removeEventListener() {},
  };
  const secondDevice = {
    id: 'new-device',
    name: 'New',
    gatt: { connect() { return secondConnect.promise; } },
    addEventListener() {},
    removeEventListener() {},
  };

  const oldAttempt = page.connectSelected(firstDevice);
  page.onHide();
  page.onShow();
  assert.notEqual(page.searchConnectResumeTimer, null);
  const newAttempt = page.connectSelected(secondDevice);
  assert.equal(page.searchConnectResumeTimer, null);
  secondConnect.resolve(secondServer);
  assert.equal(await newAttempt, true);
  firstConnect.resolve(firstServer);
  assert.equal(await oldAttempt, false);

  assert.equal(page.connectedDevice, secondDevice);
  assert.equal(page.bleServer, secondServer);
  assert.equal(firstServer.characteristic.startCalls, 0);
  assert.equal(firstServer.disconnectCalls, 1);
  assert.equal(secondServer.disconnectCalls, 0);
});

test('替换连接先原子提交新资源，旧通知慢停遇 hide/show 也不留下空连接', async () => {
  const page = freshPage();
  const oldStop = deferred();
  const oldCharacteristic = fakeCharacteristic();
  oldCharacteristic.stopNotifications = function stopNotifications() {
    this.stopCalls += 1;
    return oldStop.promise;
  };
  const oldServer = cscOnlyServer(oldCharacteristic);
  const newServer = cscOnlyServer();
  const oldDevice = {
    id: 'atomic-old',
    name: 'Atomic Old',
    gatt: { async connect() { return oldServer; } },
    addEventListener() {},
    removeEventListener() {},
  };
  const newDevice = {
    id: 'atomic-new',
    name: 'Atomic New',
    gatt: { async connect() { return newServer; } },
    addEventListener() {},
    removeEventListener() {},
  };

  assert.equal(await page.connectSelected(oldDevice), true);
  page.startRide();
  assert.equal(await page.connectSelected(newDevice), true);
  assert.equal(oldCharacteristic.stopCalls, 1);
  assert.equal(page.connectedDevice, newDevice);
  assert.equal(page.bleServer, newServer);
  assert.equal(page.notificationResources.length, 1);

  page.onHide();
  page.onShow();
  assert.equal(page.connectedDevice, newDevice);
  assert.equal(page.bleServer, newServer);
  assert.equal(newServer.characteristic.listeners.size, 1);
  assert.equal(page.reconnectTimer, null);

  oldStop.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(oldServer.disconnectCalls, 1);
  assert.equal(newServer.disconnectCalls, 0);
});

test('A→B→A 快速切回会等待 A 的旧 stop，之后重新 start 且不误断当前 A', async () => {
  const page = freshPage();
  const oldStop = deferred();
  const aCharacteristic = fakeCharacteristic();
  aCharacteristic.stopNotifications = function stopNotifications() {
    this.stopCalls += 1;
    return oldStop.promise;
  };
  const aServer = cscOnlyServer(aCharacteristic);
  const bServer = cscOnlyServer();
  const deviceA = {
    id: 'switch-a',
    name: 'Switch A',
    gatt: { async connect() { aServer.connected = true; return aServer; } },
    addEventListener() {},
    removeEventListener() {},
  };
  const deviceB = {
    id: 'switch-b',
    name: 'Switch B',
    gatt: { async connect() { return bServer; } },
    addEventListener() {},
    removeEventListener() {},
  };

  assert.equal(await page.connectSelected(deviceA), true);
  assert.equal(await page.connectSelected(deviceB), true);
  const backToA = page.connectSelected(deviceA);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aCharacteristic.startCalls, 1, '旧 stop 未结束前不能重启通知');

  oldStop.resolve();
  assert.equal(await backToA, true);
  assert.equal(page.bleServer, aServer);
  assert.equal(aServer.connected, true);
  assert.equal(aServer.disconnectCalls, 0);
  assert.equal(aCharacteristic.startCalls, 2);
  assert.equal(aCharacteristic.listeners.size, 1);
});

test('旧 stop 永久悬空会由 server disconnect 作废，下一次重连可恢复订阅', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = freshPage();
  const neverStops = deferred();
  const aCharacteristic = fakeCharacteristic();
  aCharacteristic.stopNotifications = function stopNotifications() {
    this.stopCalls += 1;
    return this.stopCalls === 1 ? neverStops.promise : Promise.resolve();
  };
  const aServer = cscOnlyServer(aCharacteristic);
  const bServer = cscOnlyServer();
  const deviceA = {
    id: 'hung-stop-a',
    name: 'Hung Stop A',
    gatt: { async connect() { aServer.connected = true; return aServer; } },
    addEventListener() {},
    removeEventListener() {},
  };
  const deviceB = {
    id: 'hung-stop-b',
    name: 'Hung Stop B',
    gatt: { async connect() { return bServer; } },
    addEventListener() {},
    removeEventListener() {},
  };

  assert.equal(await page.connectSelected(deviceA), true);
  assert.equal(await page.connectSelected(deviceB), true);
  const unsafeBack = page.connectSelected(deviceA);
  await Promise.resolve();
  t.mock.timers.tick(601);
  assert.equal(await unsafeBack, false, '被旧 disconnect 穿过的尝试必须失败关闭');
  assert.equal(aServer.disconnectCalls, 1);
  assert.equal(page.pendingNotificationStop(aCharacteristic), null);

  assert.equal(await page.connectSelected(deviceA), true);
  assert.equal(page.bleServer, aServer);
  assert.equal(aServer.connected, true);
  assert.ok(aCharacteristic.startCalls >= 2);
});

test('旧 stop reject 视为屏障结束，重新连接仍以 startNotifications 自证', async () => {
  const page = freshPage();
  const aCharacteristic = fakeCharacteristic();
  aCharacteristic.stopNotifications = function stopNotifications() {
    this.stopCalls += 1;
    return this.stopCalls === 1
      ? Promise.reject(new Error('old stop rejected'))
      : Promise.resolve();
  };
  const aServer = cscOnlyServer(aCharacteristic);
  const bServer = cscOnlyServer();
  const deviceA = {
    id: 'reject-stop-a',
    name: 'Reject Stop A',
    gatt: { async connect() { aServer.connected = true; return aServer; } },
    addEventListener() {},
    removeEventListener() {},
  };
  const deviceB = {
    id: 'reject-stop-b',
    name: 'Reject Stop B',
    gatt: { async connect() { return bServer; } },
    addEventListener() {},
    removeEventListener() {},
  };

  assert.equal(await page.connectSelected(deviceA), true);
  assert.equal(await page.connectSelected(deviceB), true);
  assert.equal(await page.connectSelected(deviceA), true);
  assert.equal(page.bleServer, aServer);
  assert.equal(aServer.connected, true);
  assert.equal(aCharacteristic.startCalls, 2);
});

test('同设备旧 startNotifications 迟到不得停掉新连接的共享通知', async () => {
  const page = freshPage();
  const starts = [];
  const listeners = new Set();
  const characteristic = {
    stopCalls: 0,
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
    startNotifications() {
      const pending = deferred();
      starts.push(pending);
      return pending.promise;
    },
    async stopNotifications() { this.stopCalls += 1; },
  };
  const server = cscOnlyServer(characteristic);
  const device = {
    id: 'shared-device',
    name: 'Shared',
    gatt: { async connect() { return server; } },
    addEventListener() {},
    removeEventListener() {},
  };

  const oldAttempt = page.connectSelected(device);
  while (starts.length < 1) await new Promise((resolve) => setImmediate(resolve));
  page.onHide();
  page.onShow();
  const replacementAttempt = page.connectSelected(device);
  while (starts.length < 2) await new Promise((resolve) => setImmediate(resolve));

  starts[1].resolve(characteristic);
  assert.equal(await replacementAttempt, true);
  assert.equal(page.hasHealthyBleConnection(device), true);
  starts[0].resolve(characteristic);
  assert.equal(await oldAttempt, false);
  assert.equal(page.bleServer, server);
  assert.equal(server.connected, true);
  assert.equal(characteristic.stopCalls, 0);
  assert.equal(listeners.size, 1);
});

test('同设备旧连接超时迟到且替代连接失败时，旧 GATT 必须回收', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = freshPage();
  const oldConnect = deferred();
  const replacementConnect = deferred();
  const requests = [oldConnect, replacementConnect];
  const oldServer = cscOnlyServer();
  const device = {
    id: 'timeout-device',
    name: 'Timeout',
    gatt: { connect() { return requests.shift().promise; } },
    addEventListener() {},
    removeEventListener() {},
  };

  const oldAttempt = page.connectSelected(device);
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(10001);
  assert.equal(await oldAttempt, false);

  const replacementAttempt = page.connectSelected(device);
  await Promise.resolve();
  oldConnect.resolve(oldServer);
  await Promise.resolve();
  replacementConnect.reject(new Error('replacement rejected'));
  assert.equal(await replacementAttempt, false);
  assert.equal(oldServer.disconnectCalls, 1);
  assert.equal(page.bleServer, null);
  assert.equal(page.deferredBleServers.length, 0);
});

test('搜索连接在隐藏期失效后 onShow 延迟自动恢复，不停留在假的连接中', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = freshPage();
  const oldConnect = deferred();
  const resumedConnect = deferred();
  const requests = [oldConnect, resumedConnect];
  const oldServer = cscOnlyServer();
  const staleServer = cscOnlyServer();
  const device = {
    id: 'resume-target',
    name: 'Resume Target',
    gatt: { connect() { return requests.shift().promise; } },
    addEventListener() {},
    removeEventListener() {},
  };

  const oldAttempt = page.connectSelected(device);
  await Promise.resolve();
  page.onHide();
  page.onShow();
  assert.notEqual(page.searchConnectResumeTimer, null);
  assert.equal(page.connecting, false);
  t.mock.timers.tick(181);
  assert.equal(page.connecting, true);
  assert.equal(page.data.searchChip, '连接中');

  resumedConnect.resolve(staleServer);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.hasHealthyBleConnection(device), true);
  assert.equal(page.data.surfacePhase, 'ready');
  assert.equal(page.reconnectTimer, null);

  oldConnect.resolve(oldServer);
  assert.equal(await oldAttempt, false);
  assert.equal(oldServer.disconnectCalls, 1);
  assert.equal(page.bleServer, staleServer);
});

test('GATT 断连只对并发调用去重，同一 server 重连后可再次断开', async () => {
  const page = freshPage();
  const firstDisconnect = deferred();
  const server = {
    disconnectCalls: 0,
    disconnect() {
      this.disconnectCalls += 1;
      return this.disconnectCalls === 1
        ? firstDisconnect.promise
        : Promise.resolve();
    },
  };

  const first = page.disconnectBleServer(server);
  const duplicate = page.disconnectBleServer(server);
  assert.equal(server.disconnectCalls, 1);
  firstDisconnect.resolve();
  await Promise.all([first, duplicate]);
  await Promise.resolve();

  await page.disconnectBleServer(server);
  assert.equal(server.disconnectCalls, 2);
});

test('AR hidden 拒绝迟到通知，show 后新 CSC 包重建基线；HRS 未贴合立即撤销', async () => {
  const page = freshPage();
  page.startRide();
  const started = page.metrics.startMs;
  page.onSourceMeasurement('hrs', new Uint8Array([0x06, 150]), started + 100);
  assert.equal(page.data.heartRate, '150');
  page.onSourceMeasurement('hrs', new Uint8Array([0x04, 200]), started + 200);
  assert.equal(page.data.heartRate, '未贴');
  assert.equal(page.metrics.snapshot(started + 200).avgBpm, 150);

  const beforePacketMs = page.metrics.sources.csc.lastPacketMs;
  page.onHide();
  assert.equal(page.onSourceMeasurement('csc', {
    flags: 3,
    wheel: { revolutions: 100, lastEventTime1024: 0 },
    crank: { revolutions: 10, lastEventTime1024: 0 },
  }, started + 300, { backgroundRide: true }), false);
  assert.equal(page.metrics.sources.csc.lastPacketMs, beforePacketMs);
  assert.equal(page.onSourceMeasurement('csc', {
    flags: 3,
    wheel: { revolutions: 101, lastEventTime1024: 1024 },
    crank: { revolutions: 11, lastEventTime1024: 768 },
  }, started + 1300, { backgroundRide: true }), false);
  const hiddenSnapshot = page.metrics.snapshot(started + 1300);
  assert.notEqual(hiddenSnapshot.metrics.speed.state, 'live');
  assert.notEqual(hiddenSnapshot.metrics.cadence.state, 'live');

  page.onShow();
  assert.equal(page.onSourceMeasurement('csc', {
    flags: 3,
    wheel: { revolutions: 100, lastEventTime1024: 0 },
    crank: { revolutions: 10, lastEventTime1024: 0 },
  }, started + 1400), true);
  assert.equal(page.onSourceMeasurement('csc', {
    flags: 3,
    wheel: { revolutions: 101, lastEventTime1024: 1024 },
    crank: { revolutions: 11, lastEventTime1024: 768 },
  }, started + 2400), true);
  const resumedSnapshot = page.metrics.snapshot(started + 2400);
  assert.equal(resumedSnapshot.metrics.speed.state, 'live');
  assert.equal(resumedSnapshot.metrics.cadence.state, 'live');
});

test('隐藏时掉线会延后重连，恢复可见后重新排队', async () => {
  const page = freshPage();
  const server = cscOnlyServer();
  const listeners = new Set();
  const device = {
    id: 'reconnect-device',
    name: 'Reconnect',
    gatt: { async connect() { return server; } },
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
  };
  assert.equal(await page.connectSelected(device), true);
  page.startRide();
  page.onHide();
  page.onGattDropped(device, server);
  assert.equal(page.reconnectDeferred, true);
  assert.equal(page.reconnectTimer, null);
  page.onShow();
  assert.notEqual(page.reconnectTimer, null);
  assert.equal(page.reconnectDeferred, false);
  assert.equal(listeners.size, 0, '掉线监听应同步解除，不能跨重连叠加');
  page.clearReconnectTimer();
});

test('连续掉线重连不会叠加 GATT 或 characteristic 监听', async () => {
  const page = freshPage();
  const firstServer = cscOnlyServer();
  const secondServer = cscOnlyServer();
  const servers = [firstServer, secondServer];
  const dropListeners = new Set();
  let addCalls = 0;
  let removeCalls = 0;
  const device = {
    id: 'repeat-reconnect',
    name: 'Repeat',
    gatt: { async connect() { return servers.shift(); } },
    addEventListener(_type, listener) {
      addCalls += 1;
      dropListeners.add(listener);
    },
    removeEventListener(_type, listener) {
      removeCalls += 1;
      dropListeners.delete(listener);
    },
  };
  assert.equal(await page.connectSelected(device), true);
  assert.equal(dropListeners.size, 1);
  assert.equal(firstServer.characteristic.listeners.size, 1);

  page.onGattDropped(device, firstServer);
  assert.equal(dropListeners.size, 0);
  assert.equal(firstServer.characteristic.listeners.size, 0);
  assert.equal(await page.connectSelected(device, { reconnect: true }), true);
  assert.equal(dropListeners.size, 1);
  assert.equal(secondServer.characteristic.listeners.size, 1);
  assert.equal(addCalls, 2);
  assert.equal(removeCalls, 1);
});

test('旧重连迟到失败不得覆盖较新成功连接或再排第三次连接', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = freshPage();
  const firstConnect = deferred();
  const staleServer = cscOnlyServer();
  const healthyServer = cscOnlyServer();
  let connectCalls = 0;
  const device = {
    id: 'reconnect-generation',
    name: 'Reconnect Generation',
    gatt: {
      connect() {
        connectCalls += 1;
        if (connectCalls === 1) return firstConnect.promise;
        return Promise.resolve(healthyServer);
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  page.reconnectDevice = device;
  page.startRide();
  t.mock.timers.tick(4000);
  await Promise.resolve();
  assert.equal(connectCalls, 1);

  page.onHide();
  page.onShow();
  t.mock.timers.tick(4000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connectCalls, 2);
  assert.equal(page.bleServer, healthyServer);
  assert.equal(page.reconnectTimer, null);

  firstConnect.resolve(staleServer);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(staleServer.disconnectCalls, 1);
  assert.equal(page.bleServer, healthyServer);
  assert.equal(page.hasHealthyBleConnection(device), true);
  assert.equal(page.reconnectTimer, null);
  assert.equal(connectCalls, 2);
});

test('骑后首帧显示六项聚合与7天历史，端侧模型成功后原位升级建议', async (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: Date.UTC(2026, 6, 31, 8, 0, 0),
  });
  let destroyed = 0;
  globalThis.LanguageModel = {
    async availability() { return 'available'; },
    async create() {
      return {
        async prompt() {
          return '保持轻档稳踩，下次先延续相近时长。';
        },
        destroy() { destroyed += 1; },
      };
    },
  };
  t.after(() => { delete globalThis.LanguageModel; });
  const page = freshPage();
  page.startRide();
  page.cyclingUploadSession = null;
  page.metrics = {
    snapshot() {
      return {
        elapsedMs: 45 * 60000,
        movingMs: 42 * 60000,
        distanceM: 18000,
        distanceEverAvailable: true,
        distanceSource: 'gps',
        avgSpeedKmh: 25.7,
        maxSpeedKmh: 34,
        avgCadenceRpm: 86,
        maxCadenceRpm: 101,
        avgBpm: 145,
        maxBpm: 168,
        avgPowerW: 210,
        maxPowerW: 420,
        metrics: {
          speed: { value: 25, state: 'live', source: 'gps' },
          cadence: { value: 86, state: 'live', source: 'imu' },
          heartRate: { value: 145, state: 'live', source: 'hrs' },
          power: { value: 210, state: 'live', source: 'cps' },
        },
        summarySourcesUsed: ['gps', 'imu', 'hrs', 'cps'],
        distanceSourcesUsed: ['gps'],
        metricSourcesUsed: { cadence: ['imu'] },
      };
    },
  };

  assert.equal(page.finishRideToSummary(), true);
  assert.equal(page.data.surfacePhase, 'summary');
  assert.equal(page.data.sumHeartRate, '145');
  assert.equal(page.data.sumPower, '210');
  assert.equal(wx.store.has(RIDE_HISTORY_KEY), false);
  assert.equal(page.data.sumTrend, '近7天暂无骑行记录。');
  t.mock.timers.tick(1);
  assert.match(page.data.sumTrend, /本次已计入/);
  const history = wx.store.get(RIDE_HISTORY_KEY);
  assert.equal(history.rides.length, 1);
  assert.doesNotMatch(JSON.stringify(history), /latitude|longitude|deviceId/i);
  assert.notEqual(page.data.sumAdviceTitle, 'AI 骑后建议');

  t.mock.timers.tick(80);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.data.sumAdviceTitle, 'AI 骑后建议');
  assert.match(page.data.sumReview, /保持轻档稳踩/);
  assert.equal(destroyed, 1);
  page.onUnload();
});

test('首次 storage 读取为空后，下一次 onShow 会恢复本地总结与历史', () => {
  const page = freshPage();
  const endedAtMs = Date.UTC(2026, 6, 31, 7, 0, 0);
  wx.store.set(LAST_RIDE_SUMMARY_KEY, {
    endedAtMs,
    elapsedMs: 1800000,
    movingMs: 1700000,
    distanceM: 9000,
    avgSpeedKmh: 19,
    avgCadenceRpm: 84,
    sources: ['imu'],
  });
  wx.store.set(RIDE_HISTORY_KEY, {
    schemaVersion: 1,
    rides: [{
      endedAtMs,
      elapsedMs: 1800000,
      movingMs: 1700000,
      distanceM: 9000,
      avgSpeedKmh: 19,
      avgCadenceRpm: 84,
      sources: ['imu'],
    }],
  });
  assert.equal(page.lastRideSummary, null);
  assert.equal(page.rideHistory.rides.length, 0);
  page.onShow();
  assert.equal(page.lastRideSummary.distanceM, 9000);
  assert.equal(page.rideHistory.rides.length, 1);
  assert.match(page.data.preRideBrief, /上次骑行/);
  page.onUnload();
});

test('历史写后读回失败时不宣称本次已计入，重复结束也只提交一次', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  page.startRide();
  page.cyclingUploadSession = null;
  const setStorage = wx.setStorageSync.bind(wx);
  wx.setStorageSync = (key, value) => {
    if (key === RIDE_HISTORY_KEY) return;
    setStorage(key, value);
  };
  page.metrics = {
    snapshot() {
      return {
        elapsedMs: 60000,
        movingMs: 55000,
        distanceM: 300,
        distanceEverAvailable: true,
        distanceSource: 'imu',
        avgSpeedKmh: 18,
        avgCadenceRpm: 82,
        metrics: {},
        summarySourcesUsed: ['imu'],
        distanceSourcesUsed: ['imu'],
        metricSourcesUsed: { cadence: ['imu'] },
      };
    },
  };

  assert.equal(page.finishRideToSummary(), true);
  assert.equal(page.data.sumTrend, '近7天暂无骑行记录。');
  t.mock.timers.tick(1);
  assert.match(page.data.sumTrend, /本次历史未保存/);
  assert.doesNotMatch(page.data.sumTrend, /本次已计入/);
  page.data.surfacePhase = 'hud';
  assert.equal(page.finishRideToSummary(), false);
  assert.equal(wx.store.has(RIDE_HISTORY_KEY), false);
});

test('累计距离断流后结束仍写入总结，瞬时速度显示本场真实均值', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  page.startRide();
  const now = Date.now();
  page.metrics = new page.metrics.constructor({
    startMs: now - 12000,
    wheelCircumferenceMm: page.rideSettings.wheelCircumferenceMm,
  });
  page.metrics.onCsc({
    flags: 1,
    wheel: { revolutions: 100, lastEventTime1024: 0 },
    crank: null,
  }, now - 10000);
  page.metrics.onCsc({
    flags: 1,
    wheel: { revolutions: 101, lastEventTime1024: 1024 },
    crank: null,
  }, now - 9000);
  page.updateHudFromMetrics(now);
  assert.notEqual(page.data.distance, '--');
  const heldSnapshot = page.metrics.snapshot(now);
  assert.equal(page.data.speed, Number(heldSnapshot.avgSpeedKmh).toFixed(1));
  assert.equal(heldSnapshot.metrics.speed.state, 'stale');
  assert.match(page.data.cyclingSourceText, /本场均值/);
  assert.doesNotMatch(page.data.cyclingSourceText, /录屏保持/);

  assert.equal(page.finishRideToSummary(), true);
  t.mock.timers.tick(1);
  const summary = wx.store.get(LAST_RIDE_SUMMARY_KEY);
  assert.ok(summary.distanceM > 2 && summary.distanceM < 2.2);
  assert.notEqual(page.data.sumDistance, '--');
});

test('结束骑行先结算 standby 距离，再读取最终 snapshot', () => {
  const page = freshPage();
  page.startRide();
  page.cyclingUploadSession = null;
  const calls = [];
  page.metrics = {
    finalizeDistance(nowMs) {
      assert.ok(Number.isFinite(nowMs));
      calls.push('finalize');
      return true;
    },
    snapshot(nowMs) {
      assert.ok(Number.isFinite(nowMs));
      calls.push('snapshot');
      return {
        elapsedMs: 1000,
        movingMs: 1000,
        distanceM: 5,
        distanceEverAvailable: true,
        avgSpeedKmh: 18,
        metrics: {},
        summarySourcesUsed: ['ftms'],
        distanceSourcesUsed: ['ftms'],
        metricSourcesUsed: { cadence: [] },
      };
    },
  };
  assert.equal(page.finishRideToSummary(), true);
  assert.deepEqual(calls, ['finalize', 'snapshot']);
  assert.equal(page.data.sumDistance, '0.01');
});

test('进入总结先提交首帧，原生通知停止和断连延后一任务执行', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = freshPage();
  page.startRide();
  const characteristic = fakeCharacteristic();
  const server = cscOnlyServer(characteristic);
  const resource = {
    characteristic,
    listener() {},
    source: 'csc',
    active: true,
    committed: true,
  };
  characteristic.addEventListener('characteristicvaluechanged', resource.listener);
  page.notificationResources = [resource];
  page.notificationOwnerResources = [resource];
  page.connectedDevice = { id: 'summary-device' };
  page.reconnectDevice = page.connectedDevice;
  page.bleServer = server;
  page.subscribedSources = { csc: true };

  assert.equal(page.finishRideToSummary(), true);
  assert.equal(page.data.surfacePhase, 'summary');
  assert.equal(characteristic.stopCalls, 0);
  assert.equal(server.disconnectCalls, 0);
  assert.equal(resource.active, false);

  t.mock.timers.tick(1);
  await page.terminalBleCleanupPromise;
  assert.equal(characteristic.stopCalls, 1);
  assert.equal(server.disconnectCalls, 1);
});

test('总结首帧严格早于 storage，snapshot 异常也能进入可退出总结', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  page.startRide();
  page.cyclingUploadSession = null;
  const operations = [];
  const originalSetData = page.setData.bind(page);
  const originalGet = wx.getStorageSync.bind(wx);
  const originalSet = wx.setStorageSync.bind(wx);
  page.setData = (patch) => {
    if (patch && patch.surfacePhase === 'summary') operations.push('summary-frame');
    originalSetData(patch);
  };
  wx.getStorageSync = (key) => {
    operations.push(`get:${key}`);
    return originalGet(key);
  };
  wx.setStorageSync = (key, value) => {
    operations.push(`set:${key}`);
    originalSet(key, value);
  };
  page.metrics = {
    snapshot() {
      return {
        elapsedMs: 60000,
        movingMs: 55000,
        distanceM: 300,
        distanceEverAvailable: true,
        avgSpeedKmh: 19.6,
        metrics: {},
        summarySourcesUsed: ['imu'],
        distanceSourcesUsed: ['imu'],
        metricSourcesUsed: { cadence: ['imu'] },
      };
    },
  };
  assert.equal(page.finishRideToSummary(), true);
  assert.deepEqual(operations, ['summary-frame']);
  t.mock.timers.tick(1);
  assert.ok(operations.some((item) => item.startsWith('set:')));

  const throwingPage = freshPage();
  throwingPage.startRide();
  throwingPage.metrics = {
    snapshot() { throw new Error('snapshot bridge failed'); },
  };
  assert.equal(throwingPage.finishRideToSummary(), true);
  assert.equal(throwingPage.data.surfacePhase, 'summary');
  assert.equal(throwingPage.data.sumDistance, '未完成');
  assert.equal(throwingPage.data.sumElapsed, '未完成');
  throwingPage.onUnload();
});

test('总结保存失败会阻止退出，后续写后读回成功才退出', async (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1785200000000,
  });
  const page = freshPage();
  page.startRide();
  page.cyclingUploadSession = null;
  page.metrics.startMs -= 5000;
  const originalSet = wx.setStorageSync.bind(wx);
  let storageReady = false;
  wx.setStorageSync = (key, value) => {
    if (!storageReady) throw new Error('storage busy');
    originalSet(key, value);
  };
  assert.equal(page.finishRideToSummary(), true);
  t.mock.timers.tick(1);
  assert.equal(page.summaryPersistenceConfirmed, false);
  assert.equal(page.closeAgent('summary-backspace'), false);
  assert.equal(wx.exitMiniProgramCalls, 0);
  assert.equal(page.summaryExitPending, true);

  storageReady = true;
  t.mock.timers.tick(120);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(page.agentExitRequested, true);
  t.mock.timers.tick(1);
  await page.terminalBleCleanupPromise;
  await Promise.resolve();
  assert.equal(page.summaryPersistenceConfirmed, true);
  assert.equal(wx.exitMiniProgramCalls, 1);
});

test('HUD Backspace 同一物理尾包只进入总结，不会立即退出', async (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1785300000000,
  });
  const page = freshPage();
  page.startRide();
  page.metrics.startMs -= 3000;
  const event = { code: 'Backspace', preventDefault() {} };
  page.onKeyUp(event);
  assert.equal(page.data.surfacePhase, 'summary');
  page.onKeyUp(event);
  assert.equal(page.agentExitRequested, false);
  assert.equal(wx.exitMiniProgramCalls, 0);

  t.mock.timers.tick(600);
  page.onKeyUp(event);
  await Promise.resolve();
  t.mock.timers.tick(1);
  await page.terminalBleCleanupPromise;
  await Promise.resolve();
  assert.equal(page.agentExitRequested, true);
  assert.equal(wx.exitMiniProgramCalls, 1);
});

test('HUD 同步会话优先于迟到 ready 镜像，双 GlobalHook 只进入总结', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1785310000000,
  });
  const page = freshPage();
  const committedSetData = page.setData.bind(page);
  page.setData = (patch) => {
    const next = { ...(patch || {}) };
    if (next.surfacePhase === 'hud' || next.surfacePhase === 'summary') {
      delete next.surfacePhase;
    }
    committedSetData(next);
  };
  assert.equal(page.startRide(), true);
  assert.equal(page.data.surfacePhase, 'ready', '模拟 AIUI 0.15 尚未镜像 HUD');
  page.hudEnteredAtMs = Date.now() - 2000;
  const prevented = [];
  const tap = () => {
    let currentPrevented = false;
    page.onKeyUp({
      code: 'GlobalHook',
      preventDefault() { currentPrevented = true; },
    });
    prevented.push(currentPrevented);
  };

  tap();
  assert.equal(page.data.hudHint, '再按一次结束');
  assert.equal(page.pendingSurfaceGlobalHookTimer, null,
    '活动会话不能把 GlobalHook 送进 ready 的搜索双击计时器');
  t.mock.timers.tick(140);
  tap();

  assert.deepEqual(prevented, [true, true],
    '每个 HUD GlobalHook keyup 都必须替代宿主默认动作');
  assert.equal(page.finishRideCommitted, true);
  assert.equal(page.isSummaryPhase(), true, '第二击必须同步完成结束并进入总结相位');
  assert.equal(wx.exitMiniProgramCalls, 0, '绝不能命中 search-double-tap 退出');
  assert.equal(page.agentExitRequested, false);
  assert.match(source, /HUD_DOUBLE_TAP_WINDOW_MS = 420/);
  assert.match(source, /HUD_DOUBLE_TAP_MIN_GAP_MS = 90/);
  page.onUnload();
});

test('HUD 确认别名只算一击，独立第二击结束并隔离总结尾包', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1785320000000,
  });
  const page = freshPage();
  page.startRide();
  page.hudEnteredAtMs = Date.now() - 2000;
  const prevented = [];
  const key = (code) => {
    let currentPrevented = false;
    page.onKeyUp({
      code,
      preventDefault() { currentPrevented = true; },
    });
    prevented.push({ code, prevented: currentPrevented });
  };

  key('GlobalHook');
  t.mock.timers.tick(100);
  key('Enter');
  assert.equal(page.data.surfacePhase, 'hud', 'GlobalHook→Enter 尾随别名不能结束骑行');
  t.mock.timers.tick(500);
  key('NumpadEnter');
  assert.equal(page.data.surfacePhase, 'summary', '下一次独立确认应进入总结');
  assert.deepEqual(prevented.map((entry) => entry.prevented), [true, true, true]);

  key('GlobalHook');
  t.mock.timers.tick(140);
  key('GlobalHook');
  assert.equal(page.agentExitRequested, false, '总结入场 600ms 内尾包不得立即退出');
  assert.equal(page.summaryTouchTapAtMs, null, '入场尾包不得污染总结真实双击');
  assert.equal(wx.exitMiniProgramCalls, 0);
  page.onUnload();
});

test('总结页真实 GlobalHook 双击使用独立 90–420ms 窗口', async (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1785330000000,
  });
  const page = freshPage();
  page.startRide();
  page.metrics.startMs -= 5000;
  assert.equal(page.finishRideToSummary(), true);
  t.mock.timers.tick(1);
  await Promise.resolve();
  page.summaryEnteredAtMs = Date.now() - 700;
  const prevented = [];
  const tap = () => {
    let currentPrevented = false;
    page.onKeyUp({
      code: 'GlobalHook',
      preventDefault() { currentPrevented = true; },
    });
    prevented.push(currentPrevented);
  };

  tap();
  t.mock.timers.tick(50);
  tap();
  assert.equal(page.agentExitRequested, false, '90ms 内重复是宿主抖动，不是双击');
  t.mock.timers.tick(3000);
  tap();
  t.mock.timers.tick(140);
  tap();
  await Promise.resolve();
  t.mock.timers.tick(1);
  await page.terminalBleCleanupPromise;
  await Promise.resolve();

  assert.deepEqual(prevented, [true, true, true, true]);
  assert.equal(page.agentExitRequested, true);
  assert.equal(wx.exitMiniProgramCalls, 1, '真实双击应关闭智能体');
  assert.match(source, /SUMMARY_DOUBLE_TAP_WINDOW_MS = 420/);
  assert.match(source, /SUMMARY_DOUBLE_TAP_MIN_GAP_MS = 90/);
  assert.match(source, /closeAgent\('summary-double-tap'\)/);
});

test('首页进入的骑行在总结保存后只退回对话流小卡，直达沉浸页仍保留应用退出', async (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1785335000000,
  });
  const page = freshPage({ mode: 'menu', returnCard: '1' });
  page.summaryEnteredAtMs = Date.now() - 1000;
  page.summaryPersistenceConfirmed = true;
  page.setData({ surfacePhase: 'summary' });

  assert.equal(page.closeAgent('summary-backspace'), true);
  t.mock.timers.tick(1);
  await page.terminalBleCleanupPromise;
  await Promise.resolve();

  assert.equal(page.agentExitDestination, 'home');
  assert.equal(wx.navigateBackCalls, 1);
  assert.equal(wx.exitMiniProgramCalls, 0);
  assert.ok(wx.store.has(RIDE_FINISHED_HINT_KEY));

  const directPage = freshPage({ mode: 'menu' });
  directPage.summaryEnteredAtMs = Date.now() - 1000;
  directPage.summaryPersistenceConfirmed = true;
  directPage.setData({ surfacePhase: 'summary' });
  assert.equal(directPage.closeAgent('summary-backspace'), true);
  t.mock.timers.tick(1);
  await directPage.terminalBleCleanupPromise;
  await Promise.resolve();
  assert.equal(directPage.agentExitDestination, 'app');
  assert.equal(wx.navigateBackCalls, 0);
  assert.equal(wx.exitMiniProgramCalls, 1);

  const fallbackPage = freshPage({ mode: 'menu', returnCard: '1' });
  wx.navigateBack = () => { throw new Error('router stack unavailable'); };
  fallbackPage.summaryEnteredAtMs = Date.now() - 1000;
  fallbackPage.summaryPersistenceConfirmed = true;
  fallbackPage.setData({ surfacePhase: 'summary' });
  assert.equal(fallbackPage.closeAgent('summary-backspace'), true);
  t.mock.timers.tick(1);
  await fallbackPage.terminalBleCleanupPromise;
  await Promise.resolve();
  assert.equal(wx.exitMiniProgramCalls, 1, '回卡路由同步失败时必须安全退出应用');
  assert.equal(wx.store.has(RIDE_FINISHED_HINT_KEY), false,
    'navigateBack 失败后不能留下会污染下次启动的完成标记');

  const storageFailurePage = freshPage({ mode: 'menu', returnCard: '1' });
  const originalSetStorageSync = wx.setStorageSync.bind(wx);
  wx.setStorageSync = (key, value) => {
    if (key === RIDE_FINISHED_HINT_KEY) throw new Error('storage quota');
    originalSetStorageSync(key, value);
  };
  storageFailurePage.summaryEnteredAtMs = Date.now() - 1000;
  storageFailurePage.summaryPersistenceConfirmed = true;
  storageFailurePage.setData({ surfacePhase: 'summary' });
  assert.equal(storageFailurePage.closeAgent('summary-backspace'), true);
  t.mock.timers.tick(1);
  await storageFailurePage.terminalBleCleanupPromise;
  await Promise.resolve();
  assert.equal(wx.navigateBackCalls, 0,
    '完成标记没有写后读回时不能冒险返回没有防尾击门的小卡');
  assert.equal(wx.exitMiniProgramCalls, 1,
    '完成标记存储失败时必须保留总结并安全退出应用');

  const directExitFailurePage = freshPage({ mode: 'menu' });
  let unverifiedFinishCalls = 0;
  directExitFailurePage.finish = () => { unverifiedFinishCalls += 1; };
  wx.exitMiniProgram = () => { throw new Error('host exit unavailable'); };
  directExitFailurePage.summaryEnteredAtMs = Date.now() - 1000;
  directExitFailurePage.summaryPersistenceConfirmed = true;
  directExitFailurePage.setData({ surfacePhase: 'summary' });
  assert.equal(directExitFailurePage.closeAgent('summary-backspace'), true);
  t.mock.timers.tick(1);
  await directExitFailurePage.terminalBleCleanupPromise;
  await Promise.resolve();
  assert.equal(unverifiedFinishCalls, 0, '不得调用未列入 AIUI 合约的 page.finish');
  assert.equal(directExitFailurePage.agentExitDispatched, false);
  assert.equal(directExitFailurePage.agentExitRequested, false,
    '正式退出能力异常时应允许用户再次尝试，不伪造已退出状态');
  assert.doesNotMatch(source, /this\.finish\(\)/);
});

test('总结 setData 镜像迟到时真实 GlobalHook 双击仍按同步相位退出', async (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1785340000000,
  });
  const page = freshPage();
  page.startRide();
  page.metrics.startMs -= 5000;
  const committedSetData = page.setData.bind(page);
  page.setData = (patch) => {
    const next = { ...(patch || {}) };
    if (next.surfacePhase === 'summary') delete next.surfacePhase;
    committedSetData(next);
  };

  assert.equal(page.finishRideToSummary(), true);
  assert.equal(page.data.surfacePhase, 'hud', '模拟总结首帧相位尚未被宿主镜像');
  assert.equal(page.isSummaryPhase(), true, '同步 summaryEnteredAtMs 必须成为路由真相');
  t.mock.timers.tick(1);
  await Promise.resolve();
  page.summaryEnteredAtMs = Date.now() - 700;
  const prevented = [];
  const tap = () => {
    let currentPrevented = false;
    page.onKeyUp({
      code: 'GlobalHook',
      preventDefault() { currentPrevented = true; },
    });
    prevented.push(currentPrevented);
  };

  tap();
  t.mock.timers.tick(140);
  tap();
  await Promise.resolve();
  t.mock.timers.tick(1);
  await page.terminalBleCleanupPromise;
  await Promise.resolve();

  assert.deepEqual(prevented, [true, true]);
  assert.equal(page.agentExitRequested, true);
  assert.equal(wx.exitMiniProgramCalls, 1);
});

test('HUD 双确认先显示再保存上传 Hermes，成功整理后 Backspace 退出', async (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1785100000000,
  });
  const page = freshPage();
  enableTestNetwork(page);
  const requestCalls = [];
  wx.requestImpl = (options) => {
    requestCalls.push(options.url);
    if (options.url.endsWith(CYCLING_UPLOAD_CREDENTIAL_PATH)) {
      options.success({
        statusCode: 200,
        data: {
          installation_id: 'aibike-test-installation',
          device_credential: 'c'.repeat(64),
        },
      });
      return;
    }
    if (options.url.endsWith(CYCLING_UPLOAD_BOOTSTRAP_PATH)) {
      options.success({
        statusCode: 200,
        data: TEST_SPORTS_IDENTITY,
      });
      return;
    }
    if (options.url.endsWith(CYCLING_UPLOAD_PATH)) {
      const events = options.data.events;
      options.success({
        statusCode: 200,
        data: {
          acked_event_ids: events.map((event) => event.event_id),
          stored: events.length,
          duplicates: 0,
          organized_rides: [{
            test_ride_id: events[0].test_ride_id,
            samples: events.filter(
              (event) => event.event_type === 'sample',
            ).length,
            finish_received: events.some(
              (event) => event.event_type === 'finish',
            ),
            started_at_ms: events[0].ride_started_at_ms,
            ended_at_ms: events[events.length - 1].captured_at_ms,
          }],
        },
      });
      return;
    }
    options.fail({ errMsg: 'unexpected request' });
  };
  page.startRide();
  await page.cyclingUploadAuthFlight;
  page.metrics.startMs -= 5000;
  page.hudEnteredAtMs = Date.now() - 2000;

  assert.equal(page.onHudConfirmKey(), false);
  assert.equal(page.data.hudHint, '再按一次结束');
  page.lastConfirmKeyMs = Date.now() - 500;
  assert.equal(page.onHudConfirmKey(), true);
  assert.equal(page.data.surfacePhase, 'summary');
  assert.equal(page.data.riding, false);
  assert.equal(wx.store.has(LAST_RIDE_SUMMARY_KEY), false);
  t.mock.timers.tick(1);
  assert.ok(wx.store.has(LAST_RIDE_SUMMARY_KEY));
  assert.ok(wx.store.has(PENDING_CYCLING_UPLOAD_KEY));
  const uploadFlight = page.cyclingUploadFlight;
  await uploadFlight;
  assert.equal(wx.store.has(PENDING_CYCLING_UPLOAD_KEY), false);
  assert.match(page.data.summaryUploadText, /^测试日志已上传/);
  assert.deepEqual(
    requestCalls.map((url) => (
      url.endsWith(CYCLING_UPLOAD_CREDENTIAL_PATH) ? 'credential'
        : url.endsWith(CYCLING_UPLOAD_BOOTSTRAP_PATH) ? 'bootstrap'
          : url.endsWith(CYCLING_UPLOAD_PATH) ? 'upload'
            : 'other'
    )),
    ['credential', 'bootstrap', 'upload'],
  );
  assert.match(
    JSON.stringify([...wx.store.values()]),
    /aibike-device-test|aibike\.owner\.test/,
  );

  t.mock.timers.tick(600);
  let prevented = false;
  page.onKeyUp({
    code: 'Backspace',
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  await page.terminalBleCleanupPromise;
  await Promise.resolve();
  assert.equal(wx.exitMiniProgramCalls, 1);
  assert.deepEqual(wx.exitMiniProgramArgs, [{}]);
});

test('设备准备页 best-effort 预热上传鉴权，进入骑行后不发网络', async () => {
  const page = freshPage();
  enableTestNetwork(page);
  const calls = [];
  wx.requestImpl = (options) => {
    calls.push(options.url);
    if (options.url.endsWith(CYCLING_UPLOAD_CREDENTIAL_PATH)) {
      options.success({
        statusCode: 200,
        data: {
          installation_id: 'aibike-prewarm-installation',
          device_credential: 'c'.repeat(64),
        },
      });
      return;
    }
    if (options.url.endsWith(CYCLING_UPLOAD_BOOTSTRAP_PATH)) {
      options.success({ statusCode: 200, data: TEST_SPORTS_IDENTITY });
      return;
    }
    options.fail({ errMsg: 'unexpected request' });
  };

  page.onShow();
  const prewarmFlight = page.cyclingUploadAuthFlight;
  assert.ok(prewarmFlight);
  assert.equal(await prewarmFlight, true);
  assert.deepEqual(calls.map((url) => (
    url.endsWith(CYCLING_UPLOAD_CREDENTIAL_PATH) ? 'credential'
      : url.endsWith(CYCLING_UPLOAD_BOOTSTRAP_PATH) ? 'bootstrap'
        : 'other'
  )), ['credential', 'bootstrap']);

  assert.equal(page.startRide(), true);
  const callsBeforeRideShow = calls.length;
  page.onShow();
  await Promise.resolve();
  assert.equal(calls.length, callsBeforeRideShow, '活动骑行 onShow 不得联网');
  page.onUnload();
});

test('开始骑行会中止未完成的鉴权预热且不阻塞 HUD', async () => {
  const page = freshPage();
  enableTestNetwork(page);
  let requestCount = 0;
  wx.requestImpl = () => { requestCount += 1; };
  page.onShow();
  const prewarmFlight = page.cyclingUploadAuthFlight;
  assert.ok(prewarmFlight);
  assert.equal(requestCount, 1);
  assert.equal(page.startRide(), true);
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(await prewarmFlight, false);
  assert.equal(requestCount, 1, '骑行开始后不得继续 bootstrap');
  page.onUnload();
});

test('骑行中只本地采样不请求 Hermes，正常结束落下 finish 后才上传', async (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1785100000000,
  });
  const page = freshPage();
  enableTestNetwork(page);
  const uploads = [];
  wx.requestImpl = (options) => {
    if (options.url.endsWith(CYCLING_UPLOAD_CREDENTIAL_PATH)) {
      options.success({
        statusCode: 200,
        data: {
          installation_id: 'aibike-finish-installation',
          device_credential: 'c'.repeat(64),
        },
      });
      return;
    }
    if (options.url.endsWith(CYCLING_UPLOAD_BOOTSTRAP_PATH)) {
      options.success({
        statusCode: 200,
        data: TEST_SPORTS_IDENTITY,
      });
      return;
    }
    if (options.url.endsWith(CYCLING_UPLOAD_PATH)) {
      const events = options.data.events;
      uploads.push(events.map((event) => ({ ...event })));
      options.success({
        statusCode: 200,
        data: {
          acked_event_ids: events.map((event) => event.event_id),
          stored: events.length,
          duplicates: 0,
          organized_rides: [{
            test_ride_id: events[0].test_ride_id,
            samples: events.filter(
              (event) => event.event_type === 'sample',
            ).length,
            finish_received: events.some(
              (event) => event.event_type === 'finish',
            ),
            started_at_ms: events[0].ride_started_at_ms,
            ended_at_ms: events[events.length - 1].captured_at_ms,
          }],
        },
      });
      return;
    }
    options.fail({ errMsg: 'unexpected request' });
  };
  assert.equal(page.startRide(), true);
  page.stopTicker();
  await page.cyclingUploadAuthFlight;
  for (let second = 0; second < 10; second += 1) {
    t.mock.timers.tick(1000);
    page.tick();
  }
  assert.equal(page.cyclingUploadSampleCount, 10);
  await Promise.resolve();
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.rideSessionActive, true);
  assert.equal(uploads.length, 0, '骑行进行中不得发起 live Hermes 请求');
  assert.equal(page.cyclingUploadFlight, null);
  assert.ok(wx.store.has(PENDING_CYCLING_UPLOAD_KEY), '骑中样本只落本地队列');
  const deferredUpload = await page.flushCyclingTestUploads();
  assert.equal(deferredUpload.status, 'deferred');
  assert.equal(uploads.length, 0, '显式误调用也必须被活动会话硬门拒绝');

  assert.equal(page.finishRideToSummary(), true);
  assert.equal(page.data.surfacePhase, 'summary');
  assert.equal(page.rideSessionActive, false);
  t.mock.timers.tick(1);
  const finishFlight = page.cyclingUploadFlight;
  assert.ok(finishFlight, '正常结束持久化 finish 后应启动上传');
  await finishFlight;

  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].some((event) => event.event_type === 'sample'));
  assert.equal(
    uploads[0].filter((event) => event.event_type === 'finish').length,
    1,
  );
  assert.equal(
    uploads[0][uploads[0].length - 1].event_type,
    'finish',
    'Hermes 收到的完整骑行必须以 finish 收尾',
  );
  assert.ok(uploads[0].every(
    (event) => event.test_ride_id === uploads[0][0].test_ride_id,
  ));
  assert.equal(wx.store.has(PENDING_CYCLING_UPLOAD_KEY), false);
  assert.match(page.data.summaryUploadText, /^测试日志已上传/);
});

test('结束上传遇到已有 flight 时复用 ACK 结果，不把成功总结误写成待补传', async () => {
  const page = freshPage();
  const rideId = 'ride-ms2ag7b4-239e02983e1e42';
  page.setData({
    surfacePhase: 'summary',
    summaryUploadText: '日志已保存 · 上传中',
  });
  page.cyclingUploadFlight = Promise.resolve({
    status: 'uploaded',
    acked: 11,
    quarantined: 0,
    pending: 0,
    organizedRides: [{
      test_ride_id: rideId,
      samples: 10,
      finish_received: true,
    }],
  });
  const result = await page.flushCyclingTestUploads({
    updateSummary: true,
    rideId,
  });
  assert.equal(result.status, 'uploaded');
  assert.equal(page.data.summaryUploadText, '测试日志已上传 · 10 个采样');
  page.cyclingUploadFlight = null;
  page.onUnload();
});

test('Hermes 离线时结束页立即可见，样本与 finish 留在本地等待补传', async (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1785400000000,
  });
  const page = freshPage();
  page.startRide();
  await page.cyclingUploadAuthFlight;
  page.metrics.startMs -= 4000;
  assert.equal(page.finishRideToSummary(), true);
  assert.equal(wx.store.has(PENDING_CYCLING_UPLOAD_KEY), false);
  t.mock.timers.tick(1);
  const uploadFlight = page.cyclingUploadFlight;
  await uploadFlight;
  const pending = wx.store.get(PENDING_CYCLING_UPLOAD_KEY);
  assert.ok(Array.isArray(pending));
  assert.ok(pending.some((event) => event.event_type === 'sample'));
  assert.ok(pending.some((event) => event.event_type === 'finish'));
  assert.equal(page.data.summaryUploadText, '日志已保存 · 待补传');
  assert.equal(
    JSON.stringify(pending).includes('latitude'),
    false,
  );
});

test('共享 Sport Agent 骑中只落有序派生快照，骑后再追加真实聚合距离', async () => {
  const page = freshPage();
  await prepareDurableSportAgent(page, {
    clientSessionId: 'bike-session-client-001',
  });
  assert.equal(page.startRide(), true);
  assert.notEqual(readSportAgentActive(wx, page.sportsIdentity).completion_queued, true);
  page.sportsStartedAtMs = Date.now() - 60000;
  const snapshot = {
    elapsedMs: 60000,
    movingMs: 54000,
    distanceM: 321.5,
    distanceEverAvailable: true,
    avgSpeedKmh: 21.4,
    maxSpeedKmh: 29.8,
    avgCadenceRpm: 84,
    maxCadenceRpm: 96,
    avgBpm: 141,
    maxBpm: 166,
    avgPowerW: 178,
    maxPowerW: 260,
    summarySourcesUsed: ['csc', 'hrs'],
    distanceSourcesUsed: ['csc'],
    metricSourcesUsed: { cadence: ['csc'] },
    metrics: {
      speed: { state: 'live', fresh: true, held: false, value: 21.4 },
      cadence: { state: 'live', fresh: true, held: false, value: 84 },
      power: { state: 'live', fresh: true, held: false, value: 178 },
      heartRate: { state: 'live', fresh: true, held: false, value: 141 },
    },
  };
  page.metrics.snapshot = () => snapshot;
  page.metrics.finalizeDistance = () => true;
  assert.equal(page.finishRideToSummary(), true);
  assert.equal(page.persistRideSummaryCommit(), true);
  const outbox = readSportAgentOutbox(wx, TEST_SPORTS_IDENTITY);
  assert.deepEqual(outbox.map((item) => item.kind), ['event', 'complete']);
  assert.equal(outbox[0].seq, 1);
  assert.equal(outbox[0].metrics.heart_zone, undefined);
  assert.equal(JSON.stringify(outbox).includes('latitude'), false);
  assert.equal(JSON.stringify(outbox).includes('rawImu'), false);
  assert.equal(outbox[1].summary.distance_m, 321.5);
  assert.equal(wx.store.has(SPORT_AGENT_OUTBOX_KEY), true);
  const active = readSportAgentActive(wx, page.sportsIdentity);
  assert.equal(active.completion_queued, true,
    '正常完赛入队后必须保留 active 直到严格 debrief ACK');
  assert.equal(
    buildSportAgentEventMetrics(snapshot).heart_rate_bpm,
    141,
  );
});

test('深度 Sport Agent 与 legacy 完成链互斥并提交冻结阶段聚合契约', async () => {
  const page = freshPage();
  const plan = {
    workout_id: 'spw_' + 'a'.repeat(24),
    revision: 1,
    title: '今日耐力骑',
    type: 'endurance',
    scheduled_date: '2026-08-13',
    source: 'adaptive',
    rationale: '稳定完成有氧积累',
    issued_at_ms: Date.now() - 1000,
    expires_at_ms: Date.now() + 3600000,
    safety_notes: [],
    stages: [{
      stage_id: 'sps_' + 'b'.repeat(24), order: 0, type: 'work',
      title: '稳定踩踏', duration_sec: 600, cue: '保持顺畅呼吸',
      target: { kind: 'cycling', cadence_min_rpm: 80, cadence_max_rpm: 95 },
    }],
  };
  await prepareDurableSportAgent(page, {
    plan,
    clientSessionId: 'bike-session-client-002',
    readinessStatus: 'high_load',
    executionDurationS: 480,
  });
  assert.equal(page.startRide(), true);
  assert.equal(page.activeSportsPlan.stages[0].duration_sec, 480);
  assert.equal(page.activeSportsPlan.stages[0].execution_source, 'readiness_reduction');
  assert.equal(page.activeSportsPlan.stages[0].target.effort_max, 5);
  const snapshot = {
    elapsedMs: 60000, movingMs: 54000, distanceM: 321.5,
    distanceEverAvailable: true, avgSpeedKmh: 21.4, maxSpeedKmh: 29.8,
    avgCadenceRpm: 84, maxCadenceRpm: 96, avgBpm: 141, maxBpm: 166,
    avgPowerW: 178, maxPowerW: 260, summarySourcesUsed: ['csc', 'hrs'],
    distanceSourcesUsed: ['csc'], metricSourcesUsed: { cadence: ['csc'] },
    metrics: {
      speed: { state: 'live', fresh: true, held: false, value: 21.4, source: 'csc' },
      cadence: { state: 'live', fresh: true, held: false, value: 84, source: 'csc' },
      power: { state: 'live', fresh: true, held: false, value: 178, source: 'cps' },
      heartRate: { state: 'live', fresh: true, held: false, value: 141, source: 'hrs' },
    },
  };
  page.metrics.snapshot = () => snapshot;
  page.metrics.finalizeDistance = () => true;
  page.updateRideCoach(snapshot, Date.now());
  assert.equal(page.finishRideToSummary(), true);
  assert.equal(page.persistRideSummaryCommit(), true);

  const fixedOutbox = readSportsOutbox(wx, TEST_SPORTS_IDENTITY);
  assert.equal(fixedOutbox.length, 0);
  const deepCompletion = readSportAgentOutbox(wx, TEST_SPORTS_IDENTITY).at(-1);
  assert.equal(deepCompletion.kind, 'complete');
  assert.equal(deepCompletion.status, 'partial');
  assert.equal(deepCompletion.workout_revision, 1);
  assert.equal(deepCompletion.stage_results.length, 1);
  assert.equal(deepCompletion.stage_results[0].duration_s, 60);
  assert.equal(Object.hasOwn(deepCompletion.stage_results[0], 'duration_sec'), false);
  assert.equal(deepCompletion.summary.distance_m, 321.5);
  assert.equal(deepCompletion.summary.max_cadence_rpm, 96);
  assert.equal(deepCompletion.summary.max_power_w, 260);
  assert.deepEqual(deepCompletion.summary.sensor_sources.sort(), ['cps', 'csc', 'hrs']);
  const deepRequest = buildSportAgentItemRequest(
    deepCompletion,
    page.sportsIdentity,
  );
  assert.ok(deepRequest);
  assert.doesNotMatch(JSON.stringify(deepRequest.data),
    /moving_time_sec|stopped|latitude|longitude|raw|ble|device_id/i);
});

test('严格完赛 ACK 后立即移除恢复入口并允许下一场使用新 session', async () => {
  const page = freshPage({ mode: 'menu' });
  enableTestNetwork(page);
  await prepareDurableSportAgent(page, {
    clientSessionId: 'bike-session-page-ack-001',
  });
  assert.equal(page.startRide(), true);
  const snapshot = {
    elapsedMs: 60000, movingMs: 54000, distanceM: 300,
    distanceEverAvailable: true, avgSpeedKmh: 20, maxSpeedKmh: 25,
    avgCadenceRpm: 82, maxCadenceRpm: 94,
    avgBpm: null, maxBpm: null, avgPowerW: null, maxPowerW: null,
    summarySourcesUsed: ['imu'], distanceSourcesUsed: ['cadence_model'],
    metricSourcesUsed: { cadence: ['imu'] },
    metrics: {
      speed: { state: 'live', fresh: true, held: false, value: 20, source: 'imu' },
      cadence: { state: 'live', fresh: true, held: false, value: 82, source: 'imu' },
      power: { state: 'unsupported', fresh: false, held: false, value: null },
      heartRate: { state: 'unsupported', fresh: false, held: false, value: null },
    },
  };
  page.metrics.snapshot = () => snapshot;
  page.metrics.finalizeDistance = () => true;
  assert.equal(page.finishRideToSummary(), true);
  assert.equal(page.persistRideSummaryCommit(), true);
  const completion = readSportAgentOutbox(wx, page.sportsIdentity)
    .find((item) => item.kind === 'complete');
  assert.ok(completion);
  page.setData({ surfacePhase: 'menu' });
  page.syncSportsWorkoutMenu();
  assert.equal(page.data.menuHasWorkout, true);
  assert.equal(page.data.workoutPlanTitle, '上次总结待同步');

  wx.requestImpl = (requestOptions) => {
    if (/\/events$/.test(requestOptions.url)) {
      requestOptions.success({ statusCode: 200, data: {
        schema_version: 1, session_id: completion.session_id,
        client_event_id: requestOptions.data.client_event_id,
        seq: requestOptions.data.seq, locale: 'zh-CN', duplicate: false,
        decision: { speak: false },
        public_device_id: TEST_SPORTS_IDENTITY.public_device_id,
        ownership_epoch: TEST_SPORTS_IDENTITY.ownership_epoch,
        data_namespace: TEST_SPORTS_IDENTITY.data_namespace,
      } });
      return;
    }
    if (/\/complete$/.test(requestOptions.url)) {
      requestOptions.success({
        statusCode: 200,
        data: sportAgentDebriefAck(completion),
      });
      return;
    }
    requestOptions.fail(new Error('unexpected request'));
  };
  const result = await page.flushSportAgentSessionOutbox({ updateSummary: false });
  assert.equal(result.status, 'acked');
  assert.equal(readSportAgentActive(wx, page.sportsIdentity), null);
  assert.equal(page.blockingSportAgentActive, null);
  assert.equal(page.data.menuHasWorkout, false);
  assert.equal(page.menuFocusIndex, 1);
  assert.equal(page.startRide({ localSafeMode: true }), true,
    'ACK 释放旧 session 后下一场必须可启动且不得复用旧会话');
  page.onUnload();
});

test('未授权长期记忆的本地总结是终态，不创建 debrief GET 或轮询计时器', () => {
  const page = freshPage();
  page.sportsIdentity = writeSportsIdentity(wx, TEST_SPORTS_IDENTITY);
  page.summaryEnteredAtMs = Date.now() - 1000;
  page.setData({ surfacePhase: 'summary' });
  const requests = [];
  wx.requestImpl = (options) => requests.push(options);
  const terminal = {
    schema_version: 1,
    debrief_id: 'sad_' + 'd'.repeat(24),
    session_id: 'sas_' + 'c'.repeat(24),
    locale: 'zh-CN',
    client_completion_id: 'bike-complete-no-consent-001',
    client_activity_id: 'bike-activity-no-consent-001',
    client_run_id: null,
    duplicate: false,
    status: 'local_ready',
    memory_status: 'skipped_no_consent',
    canonical_summary: { distance_m: 300 },
    review: {
      headline: '本地总结已完成',
      detail: '本次骑行已经整理。',
      focus: '下次保持均匀踩踏。',
      load_direction: 'hold',
    },
    next_training: null,
    public_device_id: TEST_SPORTS_IDENTITY.public_device_id,
    ownership_epoch: TEST_SPORTS_IDENTITY.ownership_epoch,
    data_namespace: TEST_SPORTS_IDENTITY.data_namespace,
  };
  wx.setStorageSync(SPORT_AGENT_DEBRIEF_CACHE_KEY, terminal);
  assert.equal(page.scheduleSportAgentDebriefPoll(terminal), false);
  assert.equal(page.sportAgentDebriefPollTimer, null);
  assert.equal(page.sportAgentDebriefPollCount, 0);
  assert.equal(requests.filter((item) => /\/debrief$/.test(item.url || '')).length, 0);
  assert.match(page.data.sumSourceNote, /长期记忆未启用/);
});

test('页面隐藏会中止今日训练请求，旧回调不能覆盖恢复后的新菜单 lifecycle', async () => {
  const page = freshPage({ mode: 'menu' });
  enableTestNetwork(page);
  page.sportsIdentity = writeSportsIdentity(wx, TEST_SPORTS_IDENTITY);
  const pending = [];
  let abortCalls = 0;
  wx.request = (options) => {
    pending.push(options);
    return { abort() { abortCalls += 1; } };
  };
  const oldFlight = page.refreshTodayWorkout({ jit: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 1);
  page.onHide();
  assert.equal(abortCalls, 1);
  await oldFlight;
  const hiddenCopy = page.data.workoutSyncText;

  page.onShow();
  const newFlight = page.refreshTodayWorkout({ jit: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[1].success({ statusCode: 200, data: {
    schema_version: 1, available: false, sport: 'cycling',
    discipline: 'outdoor_cycling',
    public_device_id: TEST_SPORTS_IDENTITY.public_device_id,
    ownership_epoch: TEST_SPORTS_IDENTITY.ownership_epoch,
    data_namespace: TEST_SPORTS_IDENTITY.data_namespace,
  } });
  await newFlight;
  const resumedCopy = page.data.workoutSyncText;
  assert.equal(page.sportsWorkoutEnvelope.available, false);

  pending[0].success({ statusCode: 200, data: {
    schema_version: 1, available: true, sport: 'cycling',
    discipline: 'outdoor_cycling',
    public_device_id: TEST_SPORTS_IDENTITY.public_device_id,
    ownership_epoch: TEST_SPORTS_IDENTITY.ownership_epoch,
    data_namespace: TEST_SPORTS_IDENTITY.data_namespace,
    plan: {
      workout_id: 'spw_' + 'd'.repeat(24), revision: 1, title: '迟到计划',
      type: 'endurance', scheduled_date: '2026-08-13', source: 'adaptive',
      rationale: '不应覆盖', issued_at_ms: Date.now() - 1000,
      expires_at_ms: Date.now() + 3600000, safety_notes: [], stages: [{
        stage_id: 'sps_' + 'e'.repeat(24), order: 0, type: 'work', title: '迟到阶段',
        duration_sec: 600, cue: '不应显示', target: {
          kind: 'cycling', cadence_min_rpm: 80, cadence_max_rpm: 95,
        },
      }],
    },
  } });
  await Promise.resolve();
  assert.equal(page.data.workoutSyncText, resumedCopy);
  assert.equal(hiddenCopy, '正在同步');
  assert.equal(resumedCopy, '同步今日训练');
  assert.equal(page.sportsWorkoutEnvelope.available, false);
});

test('页面卸载会中止总结上传，迟到 ACK 不改 UI 且不误删 durable outbox', async () => {
  const page = freshPage();
  enableTestNetwork(page);
  page.sportsIdentity = writeSportsIdentity(wx, TEST_SPORTS_IDENTITY);
  page.setData({ surfacePhase: 'summary', summaryUploadText: '总结本地已保存' });
  const queued = enqueueSportsOutbox(wx, {
    kind: 'activity', owner: TEST_SPORTS_IDENTITY,
    client_execution_id: 'bike-lifecycle-activity-001', status: 'completed',
    started_at_ms: Date.now() - 60000, ended_at_ms: Date.now(),
    duration_sec: 60, distance_m: 320,
    metrics: { avg_speed_kmh: 19.2, sensor_sources: ['csc'] },
  }, TEST_SPORTS_IDENTITY);
  assert.equal(queued.length, 1);
  let pending = null;
  let abortCalls = 0;
  wx.request = (options) => {
    pending = options;
    return { abort() { abortCalls += 1; } };
  };
  const flight = page.flushSportsActivityOutbox({ updateSummary: true });
  await Promise.resolve();
  assert.ok(pending);
  page.onUnload();
  const copyAfterUnload = page.data.summaryUploadText;
  assert.equal(abortCalls, 1);
  await flight;
  pending.success({ statusCode: 200, data: {
    accepted: true, duplicate: false, activity_id: 'spa_' + 'f'.repeat(24),
    review: { headline: '迟到点评', detail: '不应显示', next_focus: '不应显示' },
  } });
  await Promise.resolve();
  assert.equal(page.data.summaryUploadText, copyAfterUnload);
  assert.equal(page.data.sumAdviceTitle === '迟到点评', false);
  assert.equal(readSportsOutbox(wx, TEST_SPORTS_IDENTITY).length, 1);
  assert.equal(page.requestCyclingHermes({ url: 'https://example.invalid' })
    instanceof Promise, true);
});

test('宿主退出同步触发 onUnload 时只派发一次退出', () => {
  const page = freshPage();
  let calls = 0;
  wx.exitMiniProgram = () => {
    calls += 1;
    page.onUnload();
  };
  page.agentExitRequested = true;
  assert.equal(page.dispatchAgentExit(), true);
  assert.equal(calls, 1);
  assert.equal(page.agentExitDispatched, true);
  assert.equal(page.agentExitDispatching, false);
});

test('搜索页 Backspace 写入本地返回提示但不拦截宿主返回', () => {
  const page = freshPage();
  let prevented = false;
  page.onKeyUp({
    code: 'Backspace',
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, false);
  assert.ok(wx.store.has(SCAN_EXIT_HINT_KEY));
});

test('本地场日志与 Hermes 共用 ride id，1Hz 派生样本跨 hide/show 后独立完成', (t) => {
  let clock = 1787000000000;
  const originalNow = Date.now;
  Date.now = () => clock;
  t.after(() => { Date.now = originalNow; });
  const page = freshPage({}, {
    accelerometer: true,
    gyroscope: true,
    orientation: true,
  });
  t.after(() => page.onUnload());
  assert.equal(page.startRide({ localSafeMode: true }), true);
  const rideId = page.cyclingUploadSession.testRideId;
  assert.equal(page.localFieldLogRideId, rideId);

  const snapshotAt = (elapsedMs, distanceM) => ({
    elapsedMs,
    movingMs: elapsedMs,
    distanceM,
    distanceEverAvailable: true,
    distanceCoverageMs: elapsedMs,
    distanceState: 'live',
    distanceSource: 'imu',
    distanceMode: 'cadence_model',
    paused: false,
    metrics: {
      speed: { value: 12.4, source: 'imu', state: 'live' },
      cadence: { value: 82, source: 'imu', state: 'live' },
      power: { value: null, source: 'none', state: 'unsupported' },
      heartRate: { value: 126, source: 'hrs', state: 'live' },
    },
    imuAssist: {
      fresh: true,
      motionState: 'moving',
      confidence: 0.84,
      cadenceState: 'estimated',
      cadenceConfidence: 0.81,
      cadenceCorrelation: 0.76,
      candidateCadenceRpm: 83,
      finalCadenceRpm: 82,
      effectiveCadenceRpm: 82,
      rawEstimatedCadenceRpm: 85,
      estimatedSpeedKmh: 12.4,
      rawEstimatedSpeedKmh: 12.9,
      stabilizedCadenceRpm: 82,
      stabilizedSpeedKmh: 12.4,
      cadenceEstimateLevel: 'locked',
      cadenceUsable: true,
      availabilityCadenceUsable: true,
      estimateStabilized: true,
      distanceLedgerEligible: true,
      simpleGyroLedgerFresh: true,
      simpleGyroCadenceMethod: 'low_rate_timestamp_consensus',
      simpleGyroAnalysisState: 'low_rate_locked',
      motionQualityState: 'trusted',
      motionArtifact: 'none',
      rawMotionArtifact: 'none',
      walkingLike: false,
      walkingLikeConfidence: 0.04,
      speedEstimateProfile: 'cycling_unverified',
    },
  });
  page.imuReadingCount = 45;
  page.gyroscopeReadingCount = 42;
  page.orientationReadingCount = 30;
  page.imuObservedHz = 12;
  page.gyroscopeObservedHz = 11;
  page.orientationObservedHz = 8;
  page.accelerometerActivated = true;
  page.gyroscopeActivated = true;
  page.orientationActivated = true;
  for (let second = 1; second <= 3; second += 1) {
    clock += 1000;
    assert.equal(page.captureCyclingLocalFieldSample(
      snapshotAt(second * 1000, second * 3.4),
      clock,
      'imu',
    ), true);
  }
  assert.ok([...wx.store.keys()].some(
    (key) => key.startsWith(CYCLING_LOCAL_FIELD_LOG_CHUNK_PREFIX + rideId),
  ));

  page.onHide();
  clock += 5000;
  page.onShow();
  clock += 1000;
  assert.equal(page.finishRideToSummary(), true);
  assert.equal(page.persistRideSummaryCommit(), true);
  const ride = readCyclingLocalFieldLog(wx, rideId);
  assert.equal(ride.status, 'completed');
  assert.ok(ride.samples.length >= 3);
  assert.equal(ride.samples[0].simple_gyro_ledger_fresh, true);
  assert.equal(ride.samples[0].distance_ledger_eligible, true);
  assert.equal(ride.samples[0].orientation_hz, 8);
  assert.equal(ride.samples[0].sensor_generation, 1);
  assert.ok(ride.lifecycle.some((item) => item.event === 'paused'));
  assert.ok(ride.lifecycle.some((item) => item.event === 'imu_stopped'));
  assert.ok(ride.lifecycle.some((item) => item.event === 'resumed'));
  assert.ok(ride.lifecycle.some((item) => item.event === 'imu_rebuild'));
  assert.equal(JSON.stringify(ride.tts).includes('开始骑行'), false,
    'TTS 本地诊断只能保存 cue/status，不得保存播报原文');
});

test('下次 onLoad 会把遗留 active 场恢复为 aborted，且不伪造总结入口', (t) => {
  let clock = 1787100000000;
  const originalNow = Date.now;
  Date.now = () => clock;
  t.after(() => { Date.now = originalNow; });
  const first = freshPage();
  assert.equal(first.startRide({ localSafeMode: true }), true);
  const rideId = first.localFieldLogRideId;
  first.stopTicker();
  first.stopRideImu();
  first.rideSessionActive = false;
  first.localFieldLogRideId = '';

  clock += 8000;
  const recovered = instantiatePage(pageDef);
  recovered.onLoad({ mode: 'menu' });
  pages.push(recovered);
  const ride = readCyclingLocalFieldLog(wx, rideId);
  assert.equal(ride.status, 'aborted');
  assert.ok(ride.lifecycle.some((item) => item.event === 'page_unloaded'));
  assert.ok(ride.lifecycle.some((item) => item.event === 'ride_aborted'));
  assert.equal(ride.lifecycle.some((item) => item.event === 'summary_entered'), false);
  assert.equal(readCyclingLocalFieldLogIndexResult(wx).index.rides
    .some((item) => item.status === 'active'), false);
});

test('本地诊断 storage 失败不阻塞 HUD、总结首帧或既有退出门', (t) => {
  let clock = 1787200000000;
  const originalNow = Date.now;
  Date.now = () => clock;
  t.after(() => { Date.now = originalNow; });
  const page = freshPage();
  t.after(() => page.onUnload());
  const baseSetStorageSync = wx.setStorageSync.bind(wx);
  wx.setStorageSync = (key, value) => {
    if (key === CYCLING_LOCAL_FIELD_LOG_KEY
        || String(key).startsWith(CYCLING_LOCAL_FIELD_LOG_CHUNK_PREFIX)) {
      throw new Error('local field log unavailable');
    }
    return baseSetStorageSync(key, value);
  };
  page.rideSettings.voiceCue = false;
  assert.equal(page.startRide({ localSafeMode: true }), true);
  assert.equal(page.data.surfacePhase, 'hud');
  clock += 2000;
  assert.equal(page.finishRideToSummary(), true);
  assert.equal(page.data.surfacePhase, 'summary');
  assert.equal(page.persistRideSummaryCommit(), true,
    '本地诊断是旁路证据，不得阻塞正式 summary/history/outbox 门');
  assert.equal(page.summaryPersistenceConfirmed, true);
  assert.ok(page.localFieldLogWriteFailures > 0);
});

test('公开设置页不允许把本地诊断回放到日志', () => {
  assert.match(source, /data-setting="local-log" data-index="7"/);
  assert.doesNotMatch(source, /buildCyclingLocalFieldLogReplayLines/);
  assert.doesNotMatch(source, /buildLatestCyclingLocalFieldLogDigest/);
  assert.doesNotMatch(source, /localLogReplay/);
  const page = freshPage({ mode: 'menu' });
  assert.equal(page.startCyclingLocalFieldLogReplay(), false);
  assert.equal(page.replayCyclingLocalFieldLog({ samples: [1] }), false);
  page.onUnload();
});
