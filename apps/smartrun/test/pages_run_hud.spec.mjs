// 跑步 HUD 页面级行为测试:提取 .ink 脚本 + mock 宿主,驱动真实生命周期。
// 覆盖主动确认门禁、真实 BPM 成功态、无心率降级、断连/过期、息屏暂停和宿主返回清理。
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadPageModule, instantiatePage, fakeWx, FakeAccelerometer,
  FakeAbsoluteOrientationSensor, FakeGyroscope, fakeHrDevice, fakeHrRscDevice,
} from './helpers/load_page.mjs';
import { LIVE_SNAPSHOT_KEY } from '../lib/live.js';
import {
  HOST_BACKSPACE_SOURCE_KEY,
  SCAN_EXIT_HINT_KEY,
} from '../lib/surface_resume.js';
import {
  DEVICE_BINDING_STORAGE_KEY,
  DEVICE_CREDENTIAL_STORAGE_KEY,
  DEVICE_TOKEN_STORAGE_KEY,
  IDENTITY_EVER_ACTIVATED_STORAGE_KEY,
  IDENTITY_EVER_ACTIVATED_VALUE,
  INSTALLATION_ID_STORAGE_KEY,
  OWNER_TRANSITION_PENDING_STORAGE_KEY,
  PREIDENTITY_OWNER_STORAGE_KEY,
  PREIDENTITY_OWNER_VALUE,
  PUBLIC_DEVICE_ID_STORAGE_KEY,
} from '../lib/device_identity.js';
import { MOTION_SOURCE, MotionMetrics } from '../lib/motion_metrics.js';
import {
  ADAPTIVE_STRIDE_STORAGE_KEY,
  ADAPTIVE_STRIDE_LEGACY_STORAGE_KEYS,
} from '../lib/adaptive_stride.js';
import { formatPace } from '../lib/format.js';
import {
  enqueueLocalRunMemory,
  readLocalRunMemories,
} from '../lib/local_run_memory.js';
import {
  RUN_SUMMARY_PENDING_KEY,
  readPendingRunSummary,
  writePendingRunSummary,
} from '../lib/run_summary.js';
import {
  HEART_RATE_POLICY_STORAGE_KEY,
  writeHeartRatePolicy,
} from '../lib/heart_rate_policy.js';
import {
  AIUI_CALIBRATION_MAX_EVENTS,
  PENDING_AIUI_CALIBRATION_KEY,
  appendPendingAiuiCalibrationEvents,
  captureAiuiCalibrationEvent,
  createAiuiCalibrationStream,
  readPendingAiuiCalibrationEvents,
} from '../lib/aiui_calibration.js';
import {
  RUNNING_LOCAL_FIELD_LOG_CHUNK_PREFIX,
  RUNNING_LOCAL_FIELD_LOG_KEY,
  beginRunningLocalFieldLog,
  createRunningLocalFieldLogId,
  finishRunningLocalFieldLog,
  readLatestRunningLocalFieldLog,
  readRunningLocalFieldLog,
  readRunningLocalFieldLogIndexResult,
} from '../lib/running_local_field_log.js';
import {
  PENDING_RUNS_KEY,
  enqueueRunUpload,
  readPendingRunUploads,
} from '../lib/run_upload.js';
import {
  QUARANTINED_RUN_UPLOADS_KEY,
  QUARANTINED_AIUI_CALIBRATION_KEY,
  RUN_UPLOAD_RECEIPTS_KEY,
  quarantineRunUpload,
  readQuarantinedAiuiCalibrationEvents,
  readRunUploadReceipts,
} from '../lib/run_upload_records.js';
import {
  buildWorkoutCompletion,
  enqueueWorkoutCompletion,
  readPendingWorkoutCompletions,
  readQuarantinedWorkoutCompletions,
  WORKOUT_COMPLETION_QUARANTINE_KEY,
  WORKOUT_COMPLETION_QUARANTINE_STATE_KEY,
  WORKOUT_COMPLETION_QUEUE_KEY,
  WORKOUT_COMPLETION_QUEUE_STATE_KEY,
} from '../lib/workout_completion.js';
import {
  createWorkoutExecution,
  finishWorkoutExecution,
} from '../lib/workout_executor.js';
import {
  readCachedWorkout,
  writeWorkoutExecutionCheckpoint,
  writeCachedWorkout,
  WORKOUT_EXECUTION_CACHE_KEY,
  WORKOUT_EXECUTION_STATE_KEY,
} from '../lib/workout_cache.js';

const pageDef = await loadPageModule('run_hud');
const runHudSource = readFileSync(new URL('../pages/run_hud/index.ink', import.meta.url), 'utf8');

test('当前真机链不申请定位，也不保留天气或 GPS 运行入口', () => {
  assert.doesNotMatch(
    runHudSource,
    /navigator\.geolocation|getCurrentPosition|watchPosition|createGeolocationWatch|GpsPathTracker|onGpsPathMeasurement|startRunGeolocationWatch|stopRunGeolocationWatch/,
  );
  assert.doesNotMatch(runHudSource, /lib\/weather\.js|refreshHudWeather|device-weather/);
  assert.match(runHudSource, /function formatHudClock\(/);
});

test('生产页面不再引用 Sport Agent runtime，canonical 上传链保持独立', () => {
  assert.doesNotMatch(
    runHudSource,
    /(?:sport_agent\.js|SportAgent|sportAgent|SPORT_AGENT)/,
  );
  const coordinator = runHudSource.match(
    /startSummaryHermesUploads\(localSaved, options = \{\}\) \{[\s\S]*?\n  \},/,
  )?.[0] || '';
  assert.match(coordinator, /this\.flushRunUploads\(\)/);
  assert.match(coordinator, /this\.flushAiuiCalibrationUploads\(\)/);
  assert.match(coordinator, /this\.flushWorkoutCompletions\(\)/);
  assert.doesNotMatch(coordinator, /briefing|debrief|session|decision/i);
});

test('本地心率配速鼓励与跑后本地模型总结仍在', () => {
  assert.match(runHudSource,
    /import \{ nextProactiveCue \} from '\.\.\/\.\.\/lib\/coach\.js';/);
  assert.match(runHudSource, /const cue = nextProactiveCue\(this\.prevCue, cur\);/);
  assert.match(runHudSource, /this\.playCueTts\(proactiveCue,/);
  assert.match(runHudSource, /async generateSummaryAiText\(summary\)/);
  assert.match(runHudSource, /LanguageModel\.create\(\{/);
  assert.match(runHudSource, /fallbackRunSummary\(summary\)/);
  assert.match(runHudSource, /buildLocalRunMemoryContext\(wx,/);
  assert.doesNotMatch(runHudSource, /buildRunSummaryPrompt\(summary, ''\)/);
});

let wx;
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

function freshPage({
  withAccel = true,
  withMotion15 = false,
  hostFields = {},
} = {}) {
  wx = fakeWx();
  // Public runtime is offline by default. Network-contract tests opt in with
  // an explicit non-production fixture endpoint.
  wx.store.set('coach_base_url', 'https://coach.example.test');
  globalThis.__pageWx = wx;
  FakeAccelerometer.reset();
  FakeGyroscope.reset();
  FakeAbsoluteOrientationSensor.reset();
  if (withAccel) globalThis.Accelerometer = FakeAccelerometer;
  else delete globalThis.Accelerometer;
  if (withMotion15) {
    globalThis.Gyroscope = FakeGyroscope;
    globalThis.AbsoluteOrientationSensor = FakeAbsoluteOrientationSensor;
  } else {
    delete globalThis.Gyroscope;
    delete globalThis.AbsoluteOrientationSensor;
  }
  delete globalThis.navigator;
  delete globalThis.Sound;
  const page = instantiatePage(pageDef, hostFields);
  // Historical page tests exercise the explicit free-run deep link and used
  // onLoad() as shorthand before immersive-first launch existed. Preserve that
  // shorthand inside the harness; tests for the real app root pass `{}` and
  // therefore verify the new no-query -> menu contract.
  const loadPage = page.onLoad.bind(page);
  page.onLoad = (query) => loadPage(query === undefined ? { mode: 'free' } : query);
  // Track every page, including tests that bypass boot(). Summary finalizers and
  // LanguageModel timers must not leak into the next test's global host mocks.
  pagesToClean.push(page);
  return page;
}

const pagesToClean = [];
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));
const waitWorkoutDurableStorage = async (page) => {
  assert.equal(await page.workoutDurableStoragePromise, true);
  assert.equal(page.workoutDurableStorageReady, true);
};

function chooseSummaryAfterRecovery(page) {
  page.cancelRecoveryCountdown();
  page.recoveryIndex = 3;
  page.recoveryGuideCompleted = true;
  page.recoveryCompletionFocusIndex = 0;
  page.setData({
    surfacePhase: 'recovery',
    recoveryChoiceVisible: true,
    recoverySummaryClass: 'recovery-choice-focused',
    recoveryExitClass: '',
  });
  return page.showSummaryAfterRecovery();
}

test('应用根路由无参数时直接进入480x352菜单，兼容卡来源保留返回首页文案', () => {
  const direct = freshPage();
  direct.onLoad({});
  assert.equal(direct.data.surfacePhase, 'menu');
  assert.equal(direct.data.menuNavigationHint, '前后划选择 · 单击确认 · 返回键退出');

  const fallback = freshPage();
  fallback.onLoad({ mode: 'menu', fromHome: '1', inputGuard: '1' });
  assert.equal(fallback.data.surfacePhase, 'menu');
  assert.equal(
    fallback.data.menuNavigationHint,
    '前后划选择 · 单击确认 · 返回键回首页',
  );
  assert.ok(fallback.menuEntryConfirmGuardUntilMs > Date.now());
});

test('沉浸首屏同步归档上一场后才允许新跑检查点，迟到身份维护不消费新场', async () => {
  const page = freshPage();
  ensureTestRunOwner();
  const previousEndedAtMs = Date.now() - 1000;
  assert.ok(writePendingRunSummary(wx, {
    mode: 'free',
    startedAtMs: previousEndedAtMs - 70_000,
    endedAtMs: previousEndedAtMs,
    elapsedMs: 70_000,
    distanceM: 200,
    avgPaceSecPerKm: 350,
    avgBpm: 132,
    maxBpm: 145,
    avgCadenceSpm: 168,
  }));
  let resolveIdentity;
  page.refreshDeviceIdentity = () => new Promise((resolve) => {
    resolveIdentity = resolve;
  });

  page.onLoad({});
  assert.equal(readPendingRunSummary(wx), null,
    'onLoad 同步消费旧单槽，不能等待网络身份');
  assert.equal(page.immersiveStartupSummaryGuardActive, false);
  assert.equal(readLocalRunMemories(wx).length, 1);

  page.setData({ surfacePhase: 'hud' });
  page.startRun();
  page.stopTicker();
  page.tick();
  const current = readPendingRunSummary(wx);
  assert.ok(current);
  assert.equal(current.startedAtMs, page.session.startMs);

  page.deviceIdentityCache = testOwnerIdentity('token-immersive-late');
  resolveIdentity(page.deviceIdentityCache);
  await flushAsync();
  await flushAsync();
  const afterLateMaintenance = readPendingRunSummary(wx);
  assert.ok(afterLateMaintenance, '迟到维护不得消费已经属于新场的检查点');
  assert.equal(afterLateMaintenance.startedAtMs, page.session.startMs);
  assert.equal(readLocalRunMemories(wx).length, 1, '只归档上一场一次');
});

test('上一场总结读取异常时阻止新跑覆盖，存储恢复后可重试开跑', () => {
  const page = freshPage();
  ensureTestRunOwner();
  const previous = {
    mode: 'free',
    startedAtMs: Date.now() - 71_000,
    endedAtMs: Date.now() - 1000,
    elapsedMs: 70_000,
    distanceM: 180,
  };
  assert.ok(writePendingRunSummary(wx, previous));
  const originalGet = wx.getStorageSync.bind(wx);
  let failPendingRead = true;
  wx.getStorageSync = (key) => {
    if (failPendingRead && key === RUN_SUMMARY_PENDING_KEY) {
      throw new Error('transient storage read failure');
    }
    return originalGet(key);
  };

  page.onLoad({ mode: 'free' });
  assert.equal(page.immersiveStartupSummaryGuardActive, true);
  assert.throws(() => page.startRun(), /startup-summary-archive-read_failed/);
  assert.equal(!!page.session, false, '归档未确认时不得创建新会话');
  assert.equal(wx.store.get(RUN_SUMMARY_PENDING_KEY).startedAtMs, previous.startedAtMs);

  failPendingRead = false;
  assert.doesNotThrow(() => page.startRun());
  assert.equal(page.data.running, true);
  assert.equal(page.immersiveStartupSummaryGuardActive, false);
});

function fixtureHexId(prefix, seed) {
  return prefix + Number(seed).toString(16).padStart(24, '0');
}

const workoutFixtureId = (seed) => fixtureHexId('wrk_', seed);
const planSessionFixtureId = (seed) => fixtureHexId('ps_', seed);
const stageFixtureId = (seed) => fixtureHexId('stg_', seed);
const planFixtureId = (seed) => 'plan_' + String(seed);

function strictWorkoutFixture(seed, nowMs = Date.now(), overrides = {}) {
  const target = {
    duration_sec: 600,
    distance_m: null,
    pace_min_sec_per_km: null,
    pace_max_sec_per_km: null,
    heart_zone_min: 2,
    heart_zone_max: 3,
    cadence_min_spm: null,
    cadence_max_spm: null,
  };
  return {
    schema_version: 2,
    workout_id: workoutFixtureId(seed),
    plan_id: planFixtureId(seed),
    plan_session_id: planSessionFixtureId(seed),
    revision: 1,
    type: 'easy',
    title: '今日轻松跑',
    scheduled_date: new Date(nowMs).toISOString().slice(0, 10),
    status: 'planned',
    target,
    stages: [{
      stage_id: stageFixtureId(seed),
      order: 0,
      type: 'work',
      title: '轻松跑',
      ...target,
    }],
    issued_at_ms: nowMs - 1000,
    expires_at_ms: nowMs + 2 * 60 * 60 * 1000,
    ownership_epoch: 1,
    data_namespace: 'test-owner-default',
    ...overrides,
  };
}

function currentWorkoutEnvelope(plan, overrides = {}) {
  return {
    statusCode: 200,
    data: JSON.stringify({
      available: true,
      plan,
      ownership_epoch: 1,
      data_namespace: 'test-owner-default',
      public_device_id: 'test-device-default',
      ...overrides,
    }),
  };
}

// 直接调用页面方法代表一次新的用户手势时，显式结束上一手势的跨通道窗口。
// 同一次实体按压的 keyup + bindtap 回归测试不会调用这个辅助函数。
function releaseSurfaceGesture(page) {
  page.lastSurfaceActivationAtMs = Date.now() - 1000;
  page.surfaceEntryConfirmGuardUntilMs = Date.now() - 1;
}

function releaseDirectionGesture(page) {
  page.lastSurfaceDirectionAtMs = Date.now() - 1000;
}

// 与三次确认交互本身无关的总结/存储用例，用该辅助函数明确提交三次“独立”
// HUD 确认。专门的输入时序测试仍使用 fake timers 验证真实 600ms/3s 边界。
function finishHudWithThreeIndependentConfirms(page) {
  page.hudEnteredAtMs = Date.now() - 1200;
  for (let index = 0; index < 3; index += 1) {
    if (page.lastConfirmKeyMs != null) page.lastConfirmKeyMs = Date.now() - 600;
    page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  }
  return page.data.surfacePhase === 'recovery';
}

function prepareBindingPage() {
  const page = freshPage();
  page.refreshDeviceIdentity = async () => null;
  page.onLoad({ mode: 'settings' });
  page.setData({ surfacePhase: 'binding' });
  page.bindingEnteredAtMs = Date.now() - 1000;
  page.surfaceEntryConfirmGuardUntilMs = Date.now() - 1;
  page.setBindingFocus(0);
  releaseSurfaceGesture(page);
  return page;
}

function seedCompletedRunningLocalFieldLog(storage, nonce = 'bindingexport') {
  const startedAtMs = Date.UTC(2026, 7, 17, 5, 0, 0);
  const runId = createRunningLocalFieldLogId(startedAtMs, nonce);
  assert.match(runId, /^run-/);
  assert.equal(beginRunningLocalFieldLog(storage, {
    runId,
    startedAtMs,
  }).ok, true);
  assert.equal(finishRunningLocalFieldLog(storage, runId, {
    endedAtMs: startedAtMs + 60000,
    summary: {
      elapsed_ms: 60000,
      distance_m: 150,
      avg_pace_sec_per_km: 400,
      avg_cadence_spm: 170,
      avg_bpm: 140,
      max_bpm: 150,
      steps: 100,
      sample_count: 0,
    },
  }).ok, true);
  return runId;
}

function ensureTestRunOwner() {
  if (!wx.store.has(PUBLIC_DEVICE_ID_STORAGE_KEY)) {
    wx.store.set(PUBLIC_DEVICE_ID_STORAGE_KEY, 'test-device-default');
  }
  if (!wx.store.has(DEVICE_BINDING_STORAGE_KEY)) {
    wx.store.set(DEVICE_BINDING_STORAGE_KEY, {
      bound: false,
      ownershipEpoch: 1,
      dataNamespace: 'test-owner-default',
    });
  }
}

function testOwnerIdentity(token, overrides = {}) {
  return {
    network: true,
    deviceToken: token,
    publicDeviceId: 'test-device-default',
    bound: false,
    ownershipEpoch: 1,
    dataNamespace: 'test-owner-default',
    ...overrides,
  };
}

function cacheTestOwnerIdentity(page, token, overrides = {}) {
  ensureTestRunOwner();
  wx.store.set(DEVICE_TOKEN_STORAGE_KEY, token);
  page.deviceIdentityCache = testOwnerIdentity(token, overrides);
  return page.deviceIdentityCache;
}

function makeInteractive(page) {
  ensureTestRunOwner();
  page.onShow();
  page.onReady();
  // 手动启动模型:扫描只由"开始搜索"手势触发(官方样例的真机验证路径)。
  page.onScanTap();
  releaseSurfaceGesture(page);
  return page;
}

function boot(opts) {
  const page = freshPage(opts);
  page.onLoad();
  pagesToClean.push(page);
  return page;
}

function makeRunning(page) {
  ensureTestRunOwner();
  page.onShow();
  page.entrySequenceStarted = true;
  page.entrySequenceCompleted = true;
  page.bleConnectionRequested = true;
  page.setData({ surfacePhase: 'hud' });
  page.startRun();
  return page;
}

function bootRunning(opts) {
  return makeRunning(boot(opts));
}

// 旧页面能力测试关心的是武装完成后的计步、时间戳与 RSC 回退行为，
// 不应把 1.2–3.5s 入场保护窗重复算进每一条波形。只有专门的入场门测试
// 使用真实 ImuArmingGate；其余测试可显式从“已武装”状态开始。
function bypassImuArming(page) {
  page.imuArmingGate = {
    observe() {
      return { armed: true, reason: 'test-bypass', elapsedMs: 0 };
    },
    reset() {},
  };
  page.imuArmingLogged = true;
  return page;
}

function calibrationEvents(count, {
  startedAtMs = Date.UTC(2026, 6, 26, 3, 0, 0),
  nonce = 'pagetest',
} = {}) {
  const stream = createAiuiCalibrationStream(startedAtMs, { nonce });
  const events = [];
  for (let i = 0; i < count; i += 1) {
    events.push(captureAiuiCalibrationEvent(stream, {
      elapsed_ms: i * 1000,
      cadence_spm: 120 + i,
      speed_mps: 1.25,
      pace_sec_per_km: 800,
      distance_m: i * 1.25,
      steps_total: i,
      accepted_steps: i,
      candidate_steps: i + 1,
      rejected_steps: 1,
      stationary: false,
      distance_source: 'imu',
      cadence_source: 'imu',
    }, { capturedAtMs: startedAtMs + i * 1000 }));
  }
  return events;
}

after(() => {
  for (const page of pagesToClean) {
    try { page.onUnload(); } catch (_e) {}
  }
  delete globalThis.Sound;
});

// 页面 onLoad 会并行初始化 owner storage、身份和菜单。测试 wx 通过
// globalThis.__pageWx 动态代理；每条用例结束后先排空这些 Promise，避免上一
// 页面迟到的 owner 校验在下一条用例换 wx 后误清新 mock 的总结待办。
afterEach(async () => {
  const stalePages = [...new Set(pagesToClean.splice(0))];
  for (const page of stalePages) {
    try { page.onUnload(); } catch (_e) {}
  }
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  delete globalThis.LanguageModel;
});


test('起跑尚无稳定步频时配速与步频显示明确占位，不伪造 160spm', () => {
  const page = boot();
  assert.equal(page.data.pace, '-:00');
  assert.equal(page.data.cadence, '--');
  assert.equal(page.data.paceStateClass, '');
});

test('AIUI 实验流严格按 1Hz 持久化派生指标，队列不含坐标或原始传感器', () => {
  const page = bootRunning();
  page.stopTicker();
  const startedAtMs = Date.UTC(2026, 6, 26, 4, 0, 0);
  page.calibrationStream = createAiuiCalibrationStream(startedAtMs, {
    nonce: 'pagepersist',
  });
  page.calibrationCaptureBuffer = [];

  const makeMotion = (index) => ({
    elapsedMs: index * 1000,
    cadenceReady: true,
    cadenceSpm: 128 + index,
    cadenceSource: 'imu',
    speedMps: 1.4,
    distanceM: index * 1.4,
    activeMotionSource: MOTION_SOURCE.IMU_STEP,
    distanceSource: MOTION_SOURCE.IMU_STEP,
  });
  const captureAt = (offsetMs, index) => {
    const atMs = startedAtMs + offsetMs;
    page.motionMetrics.acceptedSteps = 20 + index;
    page.motionDiagnostics.candidateSteps = 22 + index;
    page.lastCalibrationDiagnostics = {
      atMs,
      candidateCadenceSpm: 132,
      motionQuality: 0.91,
      artifactConfidence: 0.08,
      gyroRms: 0.03,
      stationary: false,
      rejectionReason: 'accepted',
      // 即使诊断对象未来携带原始值，实验事件也只能取上面的白名单字段。
      rawAccelerometer: { x: 1, y: 2, z: 3 },
    };
    page.lastCalibrationGpsSegment = {
      atMs,
      accuracyM: 8,
      distanceM: 1.4,
      speedMps: 1.4,
      latitude: 31.2304,
      longitude: 121.4737,
    };
    return page.captureAiuiCalibrationSnapshot(atMs, makeMotion(index));
  };

  assert.ok(captureAt(0, 0));
  assert.equal(captureAt(999, 1), null, '不足 1 秒不得形成第二条实验事件');
  assert.ok(captureAt(1000, 1));
  assert.ok(captureAt(2000, 2));
  assert.ok(captureAt(3000, 3));
  assert.ok(captureAt(4000, 4), '第 5 条触发写后读回的持久化');

  const pending = readPendingAiuiCalibrationEvents(wx);
  assert.equal(pending.length, 5);
  assert.deepEqual(
    pending.map((event) => event.captured_at_ms),
    [0, 1000, 2000, 3000, 4000].map((delta) => startedAtMs + delta),
  );
  for (const event of pending) {
    assert.equal(event.source, 'aiui_glasses');
    assert.equal(event.distance_source, 'imu');
    assert.equal(event.cadence_source, 'imu');
    assert.equal('latitude' in event, false);
    assert.equal('longitude' in event, false);
    assert.equal('rawAccelerometer' in event, false);
    assert.doesNotMatch(
      JSON.stringify(event),
      /latitude|longitude|rawAccelerometer|rawGyroscope/,
    );
    assert.equal(JSON.stringify(event).includes(PREIDENTITY_OWNER_STORAGE_KEY), false);
    assert.equal(JSON.stringify(event).includes(PREIDENTITY_OWNER_VALUE), false);
  }
});

test('校准队列饱和后降为 30 秒采样，未饱和仍为 1Hz 且总结强制帧不丢', () => {
  const page = freshPage();
  const historical = calibrationEvents(AIUI_CALIBRATION_MAX_EVENTS, {
    nonce: 'marathonsaturated',
  });
  wx.store.set(PENDING_AIUI_CALIBRATION_KEY, historical);
  page.onLoad();
  makeRunning(page);
  page.stopTicker();
  assert.equal(page.calibrationQueueSaturated, true);

  const startedAtMs = Date.UTC(2026, 7, 16, 1, 0, 0);
  page.calibrationStream = createAiuiCalibrationStream(startedAtMs, {
    nonce: 'saturatedpage',
  });
  page.calibrationCaptureBuffer = [];
  const motion = {
    elapsedMs: 0,
    cadenceReady: true,
    cadenceSpm: 168,
    cadenceSource: 'imu',
    speedMps: 2.5,
    distanceM: 0,
    activeMotionSource: MOTION_SOURCE.IMU_STEP,
    distanceSource: MOTION_SOURCE.IMU_STEP,
  };
  assert.ok(page.captureAiuiCalibrationSnapshot(startedAtMs, motion));
  assert.equal(
    page.captureAiuiCalibrationSnapshot(startedAtMs + 1000, motion),
    null,
  );
  assert.equal(
    page.captureAiuiCalibrationSnapshot(startedAtMs + 29999, motion),
    null,
  );
  assert.ok(page.captureAiuiCalibrationSnapshot(startedAtMs + 30000, motion));
  assert.ok(page.captureAiuiCalibrationSnapshot(
    startedAtMs + 30001,
    motion,
    { force: true, deferPersist: true },
  ), '总结/卸载强制帧必须绕过 30 秒门');
  assert.equal(page.calibrationCaptureBuffer.length, 3);
});

test('马拉松本地现场日志每 5 秒采样，并在总结后继续记录 BLE 清理与真实退出', async (t) => {
  let clock = Date.UTC(2026, 7, 16, 0, 0, 0);
  const originalNow = Date.now;
  Date.now = () => clock;
  t.after(() => { Date.now = originalNow; });
  const page = bootRunning();
  page.stopTicker();
  const runId = page.localFieldLogRunId;
  assert.match(runId, /^run-/);
  page.lastCalibrationDiagnostics = {
    atMs: clock,
    candidateCadenceSpm: 170,
    motionQuality: 0.9,
    artifactConfidence: 0.05,
    gyroRms: 0.03,
    stationary: false,
  };
  const motion = (elapsedMs, distanceM) => ({
    elapsedMs,
    cadenceReady: true,
    cadenceSpm: 168,
    cadenceSource: 'imu',
    speedMps: 2.5,
    avgPaceSecPerKm: 400,
    distanceM,
    activeMotionSource: MOTION_SOURCE.IMU_STEP,
    distanceSource: MOTION_SOURCE.IMU_STEP,
    rscFresh: false,
    rscPaceLive: false,
  });
  clock += 5000;
  assert.equal(page.captureRunningLocalFieldSample(
    clock, motion(5000, 12.5), 'ticker'), true);
  assert.equal(readRunningLocalFieldLog(wx, runId).samples.length, 0);
  clock += 5000;
  assert.equal(page.captureRunningLocalFieldSample(
    clock, motion(10000, 25), 'ticker'), true);
  assert.equal(readRunningLocalFieldLog(wx, runId).samples.length, 2,
    '两帧最多只在内存停留 10 秒');
  clock += 5000;
  assert.equal(page.finishRunToSummary(), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  cacheTestOwnerIdentity(page, 'field-log-terminal-token');
  assert.equal(page.closeAgentFromSummary('summary-backspace'), true);
  await flushAsync(); await flushAsync();
  let run = readRunningLocalFieldLog(wx, runId);
  assert.equal(run.status, 'completed');
  assert.ok(run.samples.length >= 3);
  assert.ok(run.events.some((event) => event.name === 'SUMMARY_ENTERED'));
  assert.ok(run.events.some((event) => event.name === 'RUN_FINISHED'));
  assert.ok(run.events.some((event) => event.name === 'BLE_TEARDOWN'));
  assert.ok(run.events.some((event) => event.name === 'AGENT_EXIT_REQUEST'));
  assert.ok(run.events.some((event) => event.name === 'AGENT_EXIT_DISPATCH'));
  const names = run.events.map((event) => event.name);
  assert.ok(names.indexOf('SUMMARY_ENTERED') < names.indexOf('RUN_FINISHED'));
  assert.ok(names.indexOf('RUN_FINISHED') < names.indexOf('BLE_TEARDOWN'));
  assert.ok(names.indexOf('BLE_TEARDOWN') < names.indexOf('AGENT_EXIT_REQUEST'));
  assert.ok(names.indexOf('AGENT_EXIT_REQUEST') < names.indexOf('AGENT_EXIT_DISPATCH'));
  assert.ok(run.summary);
  page.onUnload();
  run = readRunningLocalFieldLog(wx, runId);
  assert.ok(run.events.some((event) => event.name === 'PAGE_UNLOADED'));
});

test('现场日志记录 hide/show 与 BLE token，但不保存设备详情或稳定 ID', (t) => {
  let clock = Date.UTC(2026, 7, 16, 0, 30, 0);
  const originalNow = Date.now;
  Date.now = () => clock;
  t.after(() => { Date.now = originalNow; });
  const page = bootRunning();
  page.stopTicker();
  const runId = page.localFieldLogRunId;
  page.bleDebug(
    'RSC_FIRST_PACKET',
    'name="fenix 8" id="AA:BB:CC:DD" raw=private-packet',
  );
  clock += 5000;
  page.onHide();
  clock += 5000;
  page.onShow();
  clock += 5000;
  assert.equal(page.finishRunToSummary(), true);
  const run = readRunningLocalFieldLog(wx, runId);
  assert.ok(run.events.some((event) => event.name === 'PAGE_HIDDEN'));
  assert.ok(run.events.some((event) => event.name === 'PAGE_SHOWN'));
  assert.ok(run.events.some((event) => event.name === 'RSC_FIRST_PACKET'));
  assert.doesNotMatch(
    JSON.stringify(run),
    /fenix 8|AA:BB:CC:DD|private-packet/,
  );
});

test('BLE 控制台日志不输出设备身份，并把原生错误压缩为白名单类别', (t) => {
  const page = freshPage();
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));

  page.logBleDevice(
    'DEVICE_FOUND',
    { name: 'fenix 8 private', id: 'DEVICE-STABLE-ID-EXAMPLE' },
    3,
    7,
  );
  assert.ok(logs.some((line) => line.includes(
    '[SmartRun BLE] DEVICE_FOUND candidate=redacted count=3 raw=7',
  )));
  assert.doesNotMatch(logs.join('\n'), /fenix 8 private|DEVICE-STABLE-ID-EXAMPLE/);

  assert.equal(page.bleErrorText({
    name: 'NotAllowedError',
    message: 'permission denied for DEVICE-STABLE-ID-EXAMPLE',
  }), 'permission');
  assert.equal(page.bleErrorText(new Error('operation timed out for private-device-id')), 'timeout');
  assert.equal(page.bleErrorText(new Error('opaque private-device-id')), 'other');
  page.bleDebug('GATT_ERROR', 'reason=' + page.bleErrorText(
    new Error('opaque DEVICE-STABLE-ID-EXAMPLE'),
  ));
  assert.doesNotMatch(logs.join('\n'), /private-device-id|DEVICE-STABLE-ID-EXAMPLE/);
  assert.match(runHudSource, /this\.bleDebug\('GATT_ERROR', 'reason=' \+ reason\)/);
  assert.doesNotMatch(runHudSource, /bleDebug\('GATT_ERROR',[^\n]*device\.id/);
});

test('全马 RSC 重试事件每类五分钟限写，并在总结前补存窗口内最新状态', (t) => {
  let clock = Date.UTC(2026, 7, 16, 2, 0, 0);
  const originalNow = Date.now;
  Date.now = () => clock;
  t.after(() => { Date.now = originalNow; });
  const page = bootRunning();
  page.stopTicker();
  const runId = page.localFieldLogRunId;
  const baseSetStorageSync = wx.setStorageSync.bind(wx);
  let indexWrites = 0;
  wx.setStorageSync = (key, value) => {
    if (key === RUNNING_LOCAL_FIELD_LOG_KEY) indexWrites += 1;
    return baseSetStorageSync(key, value);
  };
  t.after(() => { wx.setStorageSync = baseSetStorageSync; });

  const noisyNames = ['RSC_UNAVAILABLE', 'RSC_FEATURE', 'RSC_PACKET_INVALID'];
  const firstAtMs = {};
  const lastAtMs = {};
  for (let index = 0; index < 3600; index += 1) {
    const name = noisyNames[index % noisyNames.length];
    if (firstAtMs[name] == null) firstAtMs[name] = clock;
    lastAtMs[name] = clock;
    assert.equal(page.recordRunningLocalFieldEvent('ble', name, {
      atMs: clock,
      reason: 'retry',
    }), true);
    clock += 5000;
  }
  assert.ok(indexWrites <= 180,
    `5 小时 RSC 循环不得变成 3600 次同步 index 写，实际 ${indexWrites}`);
  assert.equal(page.flushRunningLocalFieldNoisyEvents(), true);
  assert.ok(indexWrites <= 183);

  const run = readRunningLocalFieldLog(wx, runId);
  for (const name of noisyNames) {
    const retries = run.events.filter((event) => event.name === name);
    assert.ok(retries.length >= 2 && retries.length <= 61);
    assert.equal(retries[0].at_ms, firstAtMs[name],
      `${name} 首个里程碑必须立即保存`);
    assert.equal(retries.at(-1).at_ms, lastAtMs[name],
      `${name} 必须在 hide/summary 前补存窗口内最后一次状态`);
  }
});

test('下次进入菜单把遗留 active 日志恢复为 aborted，仅留下恢复摘要证据', (t) => {
  let clock = Date.UTC(2026, 7, 16, 1, 0, 0);
  const originalNow = Date.now;
  Date.now = () => clock;
  t.after(() => { Date.now = originalNow; });
  const first = bootRunning();
  first.stopTicker();
  const runId = first.localFieldLogRunId;
  clock += 5000;
  first.captureRunningLocalFieldSample(
    clock,
    first.motionMetrics.snapshot(clock),
    'ticker',
    true,
  );
  first.flushRunningLocalFieldLogBuffer();
  // 模拟进程被杀：不调用旧实例 onUnload，让下一代页面负责恢复 active。
  first.localFieldLogRunId = '';
  first.stopAccel();
  clock += 5000;
  const recovered = instantiatePage(pageDef);
  pagesToClean.push(recovered);
  recovered.onLoad({ mode: 'menu', localLogReplay: '0' });
  const run = readRunningLocalFieldLog(wx, runId);
  assert.equal(run.status, 'aborted');
  assert.ok(run.events.some((event) => event.name === 'RECOVERED_ABORT'));
  assert.ok(run.events.some((event) => event.name === 'RUN_ABORTED'));
  assert.equal(
    readRunningLocalFieldLogIndexResult(wx).index.runs
      .some((item) => item.status === 'active'),
    false,
  );
});

test('现场日志 storage 故障不阻塞 HUD、总结或退出路径', () => {
  const page = freshPage();
  const baseSetStorageSync = wx.setStorageSync.bind(wx);
  wx.setStorageSync = (key, value) => {
    if (key === RUNNING_LOCAL_FIELD_LOG_KEY
        || String(key).startsWith(RUNNING_LOCAL_FIELD_LOG_CHUNK_PREFIX)) {
      throw new Error('local log storage unavailable');
    }
    return baseSetStorageSync(key, value);
  };
  page.onLoad();
  makeRunning(page);
  page.stopTicker();
  assert.equal(page.data.running, true);
  assert.doesNotThrow(() => page.bleDebug('RSC_FIRST_PACKET', 'secret-details'));
  assert.equal(page.finishRunToSummary(), true);
  assert.equal(page.data.surfacePhase, 'summary');
  assert.ok(page.localFieldLogWriteFailures > 0);
  assert.doesNotThrow(() => page.onUnload());
  wx.setStorageSync = baseSetStorageSync;
});

test('现场日志默认不输出 ADB 回放，只有 localLogReplay=1 才在非跑中分批输出', () => {
  assert.match(runHudSource, /latest\.status === 'completed'/);
  assert.match(runHudSource, /options\.afterCompleted === true/);
  assert.match(
    runHudSource,
    /localFieldLogReplayEnabled = String\(query\.localLogReplay \|\| ''\) === '1'/,
  );
  assert.match(runHudSource, /this\.data\.running === true/);
  assert.match(runHudSource, /offset \+ LOCAL_FIELD_LOG_REPLAY_BATCH_LINES/);
  assert.match(runHudSource, /LOCAL_FIELD_LOG_REPLAY_YIELD_MS/);
  assert.match(runHudSource, /console\.log\('\[SmartRun LocalLog\] ' \+ lines\[offset\]\)/);

  const defaultPage = freshPage();
  defaultPage.onLoad({ mode: 'menu' });
  assert.equal(defaultPage.localFieldLogReplayEnabled, false);

  const explicitPage = freshPage();
  explicitPage.onLoad({ mode: 'menu', localLogReplay: '1' });
  assert.equal(explicitPage.localFieldLogReplayEnabled, true);

  const disabledPage = freshPage();
  disabledPage.onLoad({ mode: 'menu', localLogReplay: '0' });
  assert.equal(disabledPage.localFieldLogReplayEnabled, false);
});

test('跑中校准只本地采样，进入总结后才按大批次上传', async () => {
  const page = bootRunning();
  page.stopTicker();
  cacheTestOwnerIdentity(page, 'summary-only-calibration-token');
  const startedAtMs = Date.now() - 30000;
  page.calibrationStream = createAiuiCalibrationStream(startedAtMs, {
    nonce: 'summaryonly',
  });
  page.calibrationCaptureBuffer = [];
  const requests = [];
  wx.requestImpl = (opts) => {
    requests.push(opts);
    if (opts.url.endsWith('/api/coach-svc/coach/aiui-calibration/batch')) {
      const ids = opts.data.events.map((event) => event.event_id);
      opts.success({
        statusCode: 200,
        data: JSON.stringify({
          acked_event_ids: ids,
          stored: ids.length,
          duplicates: 0,
          matched: ids.length,
        }),
      });
      return;
    }
    opts.fail(new Error('offline non-calibration request'));
  };
  for (let index = 0; index < 25; index += 1) {
    const capturedAtMs = startedAtMs + index * 1000;
    assert.ok(page.captureAiuiCalibrationSnapshot(capturedAtMs, {
      elapsedMs: index * 1000,
      cadenceReady: true,
      cadenceSpm: 130,
      cadenceSource: 'imu',
      speedMps: 1.5,
      distanceM: index * 1.5,
      activeMotionSource: MOTION_SOURCE.IMU_STEP,
      distanceSource: MOTION_SOURCE.IMU_STEP,
    }));
  }

  assert.equal(readPendingAiuiCalibrationEvents(wx).length, 25);
  page.onHide();
  page.onShow();
  await flushAsync();
  assert.equal(
    requests.filter(
      (request) => request.url.endsWith('/api/coach-svc/coach/aiui-calibration/batch'),
    ).length,
    0,
    '跑中即使超过旧版 20 条阈值也不得产生校准网络请求',
  );

  assert.equal(page.finishRunToSummary(), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushAsync();

  const calibrationRequests = requests.filter(
    (request) => request.url.endsWith('/api/coach-svc/coach/aiui-calibration/batch'),
  );
  assert.equal(calibrationRequests.length, 1);
  assert.ok(calibrationRequests[0].data.events.length >= 25);
  assert.ok(calibrationRequests[0].data.events.length <= 500);
  assert.deepEqual(readPendingAiuiCalibrationEvents(wx), []);
});

test('校准样本以新鲜 RSC 运动覆盖 IMU 静止，并禁止 speed=0 与正配速矛盾共存', () => {
  const page = bootRunning();
  page.stopTicker();
  const now = Date.now();
  const baseMotion = {
    elapsedMs: 5000,
    cadenceReady: true,
    cadenceSpm: 180,
    cadenceSource: 'rsc',
    speedMps: 3,
    distanceM: 15,
    activeMotionSource: MOTION_SOURCE.RSC_SPEED,
    distanceSource: MOTION_SOURCE.RSC_SPEED,
  };

  page.calibrationStream = createAiuiCalibrationStream(now - 1000, {
    nonce: 'rscmotion',
  });
  page.lastCalibrationDiagnostics = {
    atMs: now,
    candidateCadenceSpm: 0,
    motionQuality: 0,
    artifactConfidence: 0,
    gyroRms: 0,
    stationary: true,
    rejectionReason: 'imu-stationary',
  };
  const external = page.captureAiuiCalibrationSnapshot(now, {
    ...baseMotion,
    rscFresh: true,
    rscPaceLive: true,
    rscSpeedMps: 3,
  }, {
    algorithmSpeedMps: 3,
    algorithmPaceSecPerKm: 1000 / 3,
  });
  assert.equal(external.stationary, false,
    'RSC 正速度+正步频是权威外部运动证据，不能被眼镜静止诊断覆盖');
  assert.equal(external.speed_mps, 3);
  assert.equal(external.cadence_spm, 180);
  assert.ok(Math.abs(external.pace_sec_per_km - 333.33) < 0.01);

  page.calibrationStream = createAiuiCalibrationStream(now - 1000, {
    nonce: 'truestill',
  });
  const stationary = page.captureAiuiCalibrationSnapshot(now, {
    ...baseMotion,
    cadenceSource: 'imu',
    rscFresh: false,
    rscPaceLive: false,
    rscSpeedMps: 0,
  }, {
    algorithmSpeedMps: 3,
    algorithmPaceSecPerKm: 1000 / 3,
  });
  assert.equal(stationary.stationary, true);
  assert.equal(stationary.speed_mps, 0);
  assert.equal(stationary.cadence_spm, 0);
  assert.equal('pace_sec_per_km' in stationary, false,
    '真正静止时不得上传 speed=0 + 正配速的矛盾帧');
});

test('AIUI 实验上传只用 scoped device token，且仅删除后端 explicit ACK 的事件', async () => {
  const page = boot();
  const events = calibrationEvents(2, { nonce: 'explicitack' });
  assert.ok(appendPendingAiuiCalibrationEvents(wx, events));
  cacheTestOwnerIdentity(page, 'scoped-aiui-device-token');
  const requests = [];
  wx.requestImpl = (opts) => {
    requests.push(opts);
    if (requests.length === 1) {
      opts.success({
        statusCode: 200,
        data: JSON.stringify({
          acked_event_ids: [events[0].event_id, 'forged_event_00000001'],
          stored: 1,
          duplicates: 0,
          matched: 1,
        }),
      });
      return;
    }
    opts.fail(new Error('offline after partial ack'));
  };

  await page.flushAiuiCalibrationUploads();

  assert.equal(requests.length, 2, '首批部分 ACK 后只重试仍在最新队列中的事件');
  assert.match(requests[0].url, /\/api\/coach-svc\/coach\/aiui-calibration\/batch$/);
  assert.equal(
    requests[0].header.Authorization,
    'Bearer scoped-aiui-device-token',
  );
  assert.equal('latitude' in requests[0].data.events[0], false);
  assert.deepEqual(
    readPendingAiuiCalibrationEvents(wx).map((event) => event.event_id),
    [events[1].event_id],
    '伪造 ACK 与网络失败事件必须保留，不能用请求前快照覆盖队列',
  );
  const receipts = readRunUploadReceipts(wx);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].stream_id, events[0].stream_id);
  assert.equal(receipts[0].acked_count, 1);
  assert.equal(receipts[0].matched_count, 1);
  assert.equal(receipts[0].remaining_count, 1);
});

test('AIUI 实验上传遇到 401 owner transition 后不把旧队列换新 token 重放', async () => {
  const page = boot();
  const oldEvents = calibrationEvents(2, { nonce: 'oldowner' });
  const newEvents = calibrationEvents(1, {
    startedAtMs: Date.UTC(2026, 6, 26, 5, 0, 0),
    nonce: 'newowner',
  });
  assert.ok(appendPendingAiuiCalibrationEvents(wx, oldEvents));
  cacheTestOwnerIdentity(page, 'old-owner-device-token');
  page.refreshDeviceIdentity = async () => {
    // 模拟 bootstrap 检测到 ownership marker 变化并完成 owner-scoped 隔离；
    // 新 owner 在网络往返期间产生的新事件留给新一轮 uploader，旧 uploader
    // 必须在 generation 变化后停止，不能跨 owner 继续工作。
    wx.removeStorageSync(PENDING_AIUI_CALIBRATION_KEY);
    page.handleCalibrationOwnerDataCleared();
    assert.ok(appendPendingAiuiCalibrationEvents(wx, newEvents));
    return {
      network: true,
      deviceToken: 'new-owner-device-token',
    };
  };
  const requests = [];
  wx.requestImpl = (opts) => {
    requests.push(opts);
    if (requests.length === 1) {
      opts.success({ statusCode: 401, data: '{}' });
      return;
    }
    opts.success({
      statusCode: 200,
      data: JSON.stringify({
        acked_event_ids: [newEvents[0].event_id],
        stored: 1,
        duplicates: 0,
        matched: 1,
      }),
    });
  };

  await page.flushAiuiCalibrationUploads();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].header.Authorization, 'Bearer old-owner-device-token');
  assert.deepEqual(
    requests[0].data.events.map((event) => event.event_id),
    oldEvents.map((event) => event.event_id),
  );
  assert.deepEqual(
    readPendingAiuiCalibrationEvents(wx).map((event) => event.event_id),
    [newEvents[0].event_id],
    'owner transition 后新队列由下一轮 uploader 使用，旧 uploader 不跨代处理',
  );
  assert.equal(page.calibrationStream, null);
  assert.deepEqual(page.calibrationCaptureBuffer, []);
});

test('菜单后台 uploader 在外部页面完整提交 B 后停止，旧 A 响应不读删 B 队列或清 B token', async (t) => {
  for (const statusCode of [200, 401]) {
    await t.test(String(statusCode), async () => {
      const page = boot();
      const oldEvents = calibrationEvents(1, {
        nonce: 'external_owner_a_' + String(statusCode),
      });
      const newEvents = calibrationEvents(1, {
        startedAtMs: Date.UTC(2026, 6, 26, 6, statusCode === 200 ? 0 : 1, 0),
        nonce: 'external_owner_b_' + String(statusCode),
      });
      assert.ok(appendPendingAiuiCalibrationEvents(wx, oldEvents));
      cacheTestOwnerIdentity(page, 'owner-a-token');
      let resolveRequest;
      const requests = [];
      page.deviceWxRequest = (request) => {
        requests.push(request);
        return new Promise((resolve) => { resolveRequest = resolve; });
      };

      const upload = page.flushAiuiCalibrationUploads();
      await flushAsync();
      assert.equal(requests.length, 1);
      assert.deepEqual(
        requests[0].data.events.map((event) => event.event_id),
        oldEvents.map((event) => event.event_id),
      );
      assert.equal(page.runOwnerGeneration || 0, 0);

      // 模拟 index/绑定页已把 B 身份、token 与 B 队列完整提交，journal 也已清除。
      // 旧页面没有收到 callback，必须靠 durable marker 精确复核才能发现。
      wx.store.set(PUBLIC_DEVICE_ID_STORAGE_KEY, 'device-owner-b');
      wx.store.set(DEVICE_BINDING_STORAGE_KEY, {
        bound: true,
        ownershipEpoch: 9,
        dataNamespace: 'owner-b',
      });
      wx.store.delete(OWNER_TRANSITION_PENDING_STORAGE_KEY);
      wx.store.set(DEVICE_TOKEN_STORAGE_KEY, 'owner-b-token');
      wx.store.set(PENDING_AIUI_CALIBRATION_KEY, newEvents);

      resolveRequest(statusCode === 401
        ? { statusCode: 401, data: '{}' }
        : {
          statusCode: 200,
          data: JSON.stringify({
            acked_event_ids: oldEvents.map((event) => event.event_id),
            stored: oldEvents.length,
            duplicates: 0,
            matched: oldEvents.length,
          }),
        });
      await upload;

      assert.equal(requests.length, 1, '旧 A uploader 不得继续读取并发送 B 队列');
      assert.deepEqual(
        readPendingAiuiCalibrationEvents(wx).map((event) => event.event_id),
        newEvents.map((event) => event.event_id),
        '旧 A ACK 不得删除 B 已提交队列',
      );
      assert.equal(
        wx.store.get(DEVICE_TOKEN_STORAGE_KEY),
        'owner-b-token',
        '旧 A 401 不得清除 B token',
      );
      assert.equal(page.runOwnerGeneration || 0, 0,
        '测试不依赖同一页面人为 bump run generation');
    });
  }
});

test('旧 owner 上传迟到结束不得释放新 owner flight 或重复发送新队列', async () => {
  const page = boot();
  const oldEvents = calibrationEvents(1, {
    nonce: 'flight_owner_a',
  });
  const newEvents = calibrationEvents(1, {
    startedAtMs: Date.UTC(2026, 6, 26, 6, 30, 0),
    nonce: 'flight_owner_b',
  });
  assert.ok(appendPendingAiuiCalibrationEvents(wx, oldEvents));
  cacheTestOwnerIdentity(page, 'owner-a-token');

  let resolveOwnerA;
  let resolveOwnerB;
  const requests = [];
  page.deviceWxRequest = (request) => {
    requests.push(request);
    return new Promise((resolve) => {
      if (request.header.Authorization === 'Bearer owner-a-token') {
        resolveOwnerA = resolve;
      } else {
        resolveOwnerB = resolve;
      }
    });
  };

  const uploadOwnerA = page.flushAiuiCalibrationUploads();
  await flushAsync();
  assert.equal(requests.length, 1);

  // 外部页面已完成 owner 切换。旧 A flight 仍悬空，但内部 generation 已换代，
  // 因而 B 可以开始；A 的 finally 之后只能释放 A 自己的 token。
  page.handleCalibrationOwnerDataCleared();
  wx.removeStorageSync(PENDING_AIUI_CALIBRATION_KEY);
  wx.store.set(PUBLIC_DEVICE_ID_STORAGE_KEY, 'device-owner-b');
  wx.store.set(DEVICE_BINDING_STORAGE_KEY, {
    bound: true,
    ownershipEpoch: 9,
    dataNamespace: 'owner-b',
  });
  wx.store.set(DEVICE_TOKEN_STORAGE_KEY, 'owner-b-token');
  assert.ok(appendPendingAiuiCalibrationEvents(wx, newEvents));
  cacheTestOwnerIdentity(page, 'owner-b-token', {
    publicDeviceId: 'device-owner-b',
    bound: true,
    ownershipEpoch: 9,
    dataNamespace: 'owner-b',
  });

  const uploadOwnerB = page.flushAiuiCalibrationUploads();
  await flushAsync();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].header.Authorization, 'Bearer owner-b-token');

  resolveOwnerA({
    statusCode: 200,
    data: JSON.stringify({
      acked_event_ids: oldEvents.map((event) => event.event_id),
      stored: 1,
      duplicates: 0,
      matched: 1,
    }),
  });
  await uploadOwnerA;

  await page.flushAiuiCalibrationUploads();
  assert.equal(
    requests.length,
    2,
    'A finally 不得清掉 B flight；B 未返回前第三次 flush 不能重复发送',
  );

  resolveOwnerB({
    statusCode: 200,
    data: JSON.stringify({
      acked_event_ids: newEvents.map((event) => event.event_id),
      stored: 1,
      duplicates: 0,
      matched: 1,
    }),
  });
  await uploadOwnerB;
  assert.deepEqual(readPendingAiuiCalibrationEvents(wx), []);
  assert.equal(page.calibrationFlushFlight, null);
});

test('开跑 pin 会清掉外部 owner 的缓存 token，flush 仍二次校验 cache marker', async () => {
  const page = boot();
  cacheTestOwnerIdentity(page, 'owner-a-token');
  wx.store.set(PUBLIC_DEVICE_ID_STORAGE_KEY, 'device-owner-b');
  wx.store.set(DEVICE_BINDING_STORAGE_KEY, {
    bound: true,
    ownershipEpoch: 12,
    dataNamespace: 'owner-b-twelve',
  });
  wx.store.set(DEVICE_TOKEN_STORAGE_KEY, 'owner-b-token');

  makeRunning(page);
  page.stopTicker();
  assert.deepEqual(page.runOwnerContext, {
    publicDeviceId: 'device-owner-b',
    bound: true,
    ownershipEpoch: 12,
    dataNamespace: 'owner-b-twelve',
  });
  assert.equal(page.deviceIdentityCache, null,
    'startRun 不得保留 A owner 的 scoped token cache');

  const events = calibrationEvents(1, { nonce: 'pinned_owner_b' });
  assert.ok(appendPendingAiuiCalibrationEvents(wx, events));
  const requests = [];
  page.deviceWxRequest = async (request) => {
    requests.push(request);
    return {
      statusCode: 200,
      data: JSON.stringify({
        acked_event_ids: events.map((event) => event.event_id),
        stored: 1,
        duplicates: 0,
        matched: 1,
      }),
    };
  };

  page.deviceIdentityCache = testOwnerIdentity('owner-a-token');
  await page.flushAiuiCalibrationUploads();
  assert.equal(requests.length, 0, 'flush 的第二道 marker 门不得发送 stale A token');

  page.deviceIdentityCache = testOwnerIdentity('owner-b-token', {
    publicDeviceId: 'device-owner-b',
    bound: true,
    ownershipEpoch: 12,
    dataNamespace: 'owner-b-twelve',
  });
  await page.flushAiuiCalibrationUploads();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].header.Authorization, 'Bearer owner-b-token');
});

test('AIUI 实验上传用前缀二分隔离 409 单条冲突，不连带丢弃正常事件', async () => {
  const page = boot();
  const events = calibrationEvents(3, { nonce: 'conflict409' });
  const conflictId = events[1].event_id;
  assert.ok(appendPendingAiuiCalibrationEvents(wx, events));
  cacheTestOwnerIdentity(page, 'scoped-aiui-device-token');
  const requestedIds = [];
  wx.requestImpl = (opts) => {
    const ids = opts.data.events.map((event) => event.event_id);
    requestedIds.push(ids);
    if (ids.includes(conflictId)) {
      opts.success({ statusCode: 409, data: '{}' });
      return;
    }
    opts.success({
      statusCode: 200,
      data: JSON.stringify({
        acked_event_ids: ids,
        stored: ids.length,
        duplicates: 0,
        matched: ids.length,
      }),
    });
  };

  await page.flushAiuiCalibrationUploads();

  assert.deepEqual(readPendingAiuiCalibrationEvents(wx), []);
  const quarantined = readQuarantinedAiuiCalibrationEvents(wx);
  assert.equal(quarantined.length, 1,
    '单条永久冲突必须先写后读回隔离区，再移出主上传队列');
  assert.equal(quarantined[0].event.event_id, conflictId);
  assert.equal(quarantined[0].status_code, 409);
  const quarantineText = JSON.stringify(
    wx.store.get(QUARANTINED_AIUI_CALIBRATION_KEY),
  );
  for (const forbidden of [
    'token', 'device_id', 'latitude', 'longitude', 'rawAccelerometer',
  ]) assert.equal(quarantineText.includes(forbidden), false, forbidden);
  assert.deepEqual(
    requestedIds,
    [
      [events[0].event_id, events[1].event_id, events[2].event_id],
      [events[0].event_id],
      [events[1].event_id, events[2].event_id],
      [events[1].event_id],
      [events[2].event_id],
    ],
    '冲突批次必须先缩小前缀；只有单条 409 才可丢弃',
  );
});

test('AIUI 实验 pending 暂时不可读时总结上传 fail closed，不发请求也不覆盖队列', async () => {
  const page = boot();
  const events = calibrationEvents(2, { nonce: 'summaryreadfail' });
  assert.ok(appendPendingAiuiCalibrationEvents(wx, events));
  cacheTestOwnerIdentity(page, 'summary-read-fail-token');
  const normalGet = wx.getStorageSync.bind(wx);
  let throwOnce = true;
  wx.getStorageSync = (key) => {
    if (key === PENDING_AIUI_CALIBRATION_KEY && throwOnce) {
      throwOnce = false;
      throw new Error('transient calibration queue read failure');
    }
    return normalGet(key);
  };
  let requests = 0;
  page.deviceWxRequest = async () => {
    requests += 1;
    return { statusCode: 200, data: '{}' };
  };

  await page.flushAiuiCalibrationUploads();

  assert.equal(requests, 0);
  assert.deepEqual(
    readPendingAiuiCalibrationEvents(wx).map((event) => event.event_id),
    events.map((event) => event.event_id),
    'unknown 读取不能被解释为空队列或覆盖 durable FIFO',
  );
});

test('AIUI 实验样本在隐藏和总结后立即退出前均完成写后读回', () => {
  const hiddenPage = bootRunning();
  hiddenPage.stopTicker();
  const hiddenStartedAtMs = Date.now() - 2000;
  hiddenPage.calibrationStream = createAiuiCalibrationStream(hiddenStartedAtMs, {
    nonce: 'hidepersist',
  });
  assert.ok(hiddenPage.captureAiuiCalibrationSnapshot(
    hiddenStartedAtMs + 1000,
    hiddenPage.motionMetrics.snapshot(hiddenStartedAtMs + 1000),
  ));
  assert.equal(readPendingAiuiCalibrationEvents(wx).length, 0);

  hiddenPage.onHide();

  const hiddenEvents = readPendingAiuiCalibrationEvents(wx);
  assert.ok(hiddenEvents.length >= 1, '隐藏必须把内存实验样本同步持久化');
  assert.equal(hiddenPage.calibrationCaptureBuffer.length, 0);

  const summaryPage = freshPage();
  summaryPage.onLoad();
  makeRunning(summaryPage);
  summaryPage.stopTicker();
  const summaryStartedAtMs = Date.now() - 3000;
  summaryPage.session.startMs = summaryStartedAtMs;
  summaryPage.calibrationStream = createAiuiCalibrationStream(summaryStartedAtMs, {
    nonce: 'summaryexit',
  });
  assert.ok(summaryPage.captureAiuiCalibrationSnapshot(
    summaryStartedAtMs + 1000,
    summaryPage.motionMetrics.snapshot(summaryStartedAtMs + 1000),
  ));
  assert.equal(readPendingAiuiCalibrationEvents(wx).length, 0);
  let summaryFlushes = 0;
  let runSummaryFlushes = 0;
  summaryPage.flushAiuiCalibrationUploads = () => {
    summaryFlushes += 1;
    return Promise.resolve();
  };
  summaryPage.flushRunUploads = () => {
    runSummaryFlushes += 1;
    return Promise.resolve();
  };
  cacheTestOwnerIdentity(summaryPage, 'summary-immediate-exit-token');

  assert.equal(summaryPage.finishRunToSummary(), true);
  assert.ok(summaryPage.calibrationCaptureBuffer.length >= 2,
    '总结退出前内存必须同时保留周期样本和强制终点帧');
  assert.equal(summaryPage.closeAgentFromSummary('summary-backspace'), true);
  assert.equal(summaryFlushes, 1,
    '总结首帧后立即退出也必须先启动一次校准批量上传');
  assert.equal(runSummaryFlushes, 1,
    '跑步汇总与校准日志必须由同一个总结页协调器统一启动');

  const summaryEvents = readPendingAiuiCalibrationEvents(wx);
  assert.ok(summaryEvents.length >= 2,
    '总结最终帧和此前内存样本必须在退出位武装前同步落盘，实际 '
      + String(summaryEvents.length));
  assert.equal(summaryPage.calibrationCaptureBuffer.length, 0);
  summaryPage.onUnload();
});

test('RSC 正速度配零步频的尾包不得让静坐 HUD 显示 3–4 分配速', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const page = boot();
  page.pendingRscMeasurement = {
    speedMps: 5,
    cadenceSpm: 0,
    totalDistanceM: null,
  };
  makeRunning(page);
  page.stopTicker();

  page.tick();
  assert.equal(page.data.pace, '-:00');
  assert.equal(page.data.cadence, '--');
  assert.equal(page.data.paceConnected, false);
  assert.equal(page.motionMetrics.snapshot(Date.now()).activeMotionSource, 'none');

  // 即使融合层曾残留一个旧速度，缺少当前正步频时 HUD 也不能复活它。
  page.speedFusion.observe('rsc', 5, Date.now(), { quality: 1 });
  page.lastCrediblePaceSec = 200;
  page.lastCrediblePaceAtMs = Date.now();
  page.lastDisplayedPaceSec = 200;
  t.mock.timers.tick(11000);
  page.tick();
  assert.equal(page.data.pace, '-:00');
  assert.equal(page.data.cadence, '--');
});

test('HUD 顶栏只显示本地时间且不发起天气网络请求', () => {
  const page = bootRunning();
  let requestCount = 0;
  wx.requestImpl = () => { requestCount += 1; };
  page.tick();
  assert.match(page.data.hudEnvironment, /^\d{2}:\d{2}$/);
  assert.equal(requestCount, 0);
  assert.equal(page.data.running, true);
});
test('超慢跑复用搜索与 HUD，并严格关闭 RSC、距离和配速账本', () => {
  const slow = freshPage();
  slow.onLoad({ mode: 'slow' });
  pagesToClean.push(slow);
  assert.equal(slow.data.surfacePhase, 'ready');
  assert.equal(slow.data.runMode, 'slow');
  assert.equal(slow.data.searchChip, '超慢跑');
  assert.match(slow.data.searchText, /原地小步/);
  assert.equal(typeof slow.openSlowMode, 'function');
  assert.equal(typeof slow.startSlowRun, 'undefined', '超慢跑不另建易误触的准备页');
  assert.equal(slow.probeOptionalRsc({ gatt: {} }), false,
    '原地跑只允许 HRS 心率，不能接入设备速度造成虚假距离');

  makeRunning(slow);
  slow.stopTicker();
  assert.equal(slow.motionMetrics.distanceEnabled, false);
  const base = Date.now();
  for (let index = 1; index <= 5; index += 1) {
    slow.motionMetrics.onAcceptedStep(base + index * 400, 150);
  }
  const motion = slow.motionMetrics.snapshot(base + 2000);
  assert.equal(motion.cadenceSource, 'imu');
  assert.equal(motion.distanceM, 0, '原地落步只形成步数和步频，不生成位移');
  assert.equal(motion.avgPaceSecPerKm, null);

  const settings = freshPage();
  settings.onLoad({ mode: 'settings' });
  pagesToClean.push(settings);
  assert.equal(settings.data.surfacePhase, 'settings');
  settings.onKeyUp({ code: 'Backspace', preventDefault() {} });
  assert.equal(settings.data.surfacePhase, 'menu');
});

test('超慢跑仍可扫描并订阅 HRS 心率，但绝不探测同设备 RSC', async () => {
  const page = freshPage();
  const host = scanHost();
  const { device, hrChar, rscChar, server } = fakeHrRscDevice('fenix 8');
  page.onLoad({ mode: 'slow' });
  pagesToClean.push(page);
  makeInteractive(page);
  await flushAsync();
  assert.equal(host.scanCalls, 1, '超慢跑必须复用标准 HRS 扫描入口');
  host.onDeviceFound({ device });

  const connected = await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });
  assert.equal(connected, true);
  assert.equal(page.data.bleState, 'connected');
  assert.equal(hrChar.startNotificationsCalls, 1);
  assert.equal(rscChar.startNotificationsCalls, 0,
    '超慢跑只接心率，不能让设备 RSC 改写原地运动指标');
  assert.deepEqual(server.getPrimaryServiceCalls, ['heart_rate']);

  hrChar.notify(112);
  page.onConnectTap();
  page.stopTicker();
  page.tick();
  assert.equal(page.data.bpm, '112');
  assert.equal(page.motionMetrics.distanceEnabled, false);
});

test('设备与设置逐项循环并立即持久化，只有当前项拥有焦点框', () => {
  const page = freshPage();
  page.onLoad({ mode: 'settings' });
  pagesToClean.push(page);
  const previousStride = page.runSettings.strideM;
  page.onSettingTap({ currentTarget: { dataset: { setting: 'stride', index: 0 } } });
  assert.notEqual(page.runSettings.strideM, previousStride);
  assert.match(page.data.settingStrideClass, /setting-row-focused/);
  assert.doesNotMatch(page.data.settingHeartRateClass, /setting-row-focused/);
  assert.equal([
    page.data.settingStrideClass, page.data.settingHeartRateClass,
    page.data.settingVoiceCueClass, page.data.settingMetronomeClass,
    page.data.settingGuideQuickExitClass, page.data.settingBindingClass,
    page.data.settingBackClass,
  ].filter((className) => className === 'setting-row-focused').length, 1,
  '设置页任何时刻只能有一个焦点 modifier');
  assert.equal(wx.store.get('run_settings').strideM, page.runSettings.strideM);

  releaseSurfaceGesture(page);
  page.onSettingTap({ currentTarget: { dataset: { setting: 'heart', index: 5 } } });
  assert.equal(page.data.settingHeartRate, '关');
  assert.equal(wx.store.get('run_settings').autoHeartRate, false);
  assert.equal(page.data.settingsSaveState, '已保存');
});

test('指导快速结束默认关闭，明确开启后持久化并提示整段指导静音', () => {
  const page = freshPage();
  page.onLoad({ mode: 'settings' });
  pagesToClean.push(page);
  assert.equal(page.runSettings.guideQuickExit, false);
  assert.equal(page.data.settingGuideQuickExit, '关');

  releaseSurfaceGesture(page);
  assert.equal(page.onSettingTap({
    currentTarget: { dataset: { setting: 'guide', index: 3 } },
  }), true);
  assert.equal(page.runSettings.guideQuickExit, true);
  assert.equal(wx.store.get('run_settings').guideQuickExit, true);
  assert.equal(page.data.settingGuideQuickExit, '开');
  assert.equal(page.data.settingsSaveState, '快速结束已开启 · 指导静音');
  assert.match(page.data.settingGuideQuickExitClass, /setting-row-focused/);

  releaseSurfaceGesture(page);
  assert.equal(page.onSettingTap({
    currentTarget: { dataset: { setting: 'guide', index: 3 } },
  }), true);
  assert.equal(page.runSettings.guideQuickExit, false);
  assert.equal(wx.store.get('run_settings').guideQuickExit, false);
  assert.equal(page.data.settingGuideQuickExit, '关');
});

test('设置页只由明确返回按钮回到训练菜单，并隔离同一按压的尾包', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  page.onLoad({ mode: 'settings' });
  pagesToClean.push(page);
  const previousStride = page.runSettings.strideM;

  page.setSettingFocus(0);
  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  t.mock.timers.tick(120);
  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  t.mock.timers.tick(479);
  assert.equal(page.runSettings.strideM, previousStride,
    '600ms 滑动/轻拍判别完成前不得抢先激活设置项');
  t.mock.timers.tick(1);
  assert.equal(page.data.surfacePhase, 'settings',
    '设置页双击只按一次普通确认处理，绝不能承担返回动作');
  assert.notEqual(page.runSettings.strideM, previousStride);

  releaseSurfaceGesture(page);
  assert.equal(page.onSettingTap({
    currentTarget: { dataset: { setting: 'back', index: 6 } },
  }), true);
  assert.equal(page.data.surfacePhase, 'menu');
  assert.equal(page.openFreeMode(), false,
    '返回按钮的尾随确认不得回到菜单后立即误开自由跑');
  page.menuEntryConfirmGuardUntilMs = Date.now() - 1;
  assert.equal(page.openFreeMode(), true, '下一次独立确认仍可正常进入自由跑');
});

test('功能菜单方向移动后只有当前入口拥有单一焦点 modifier', () => {
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  const focusedCount = () => [
    page.data.menuTodayClass, page.data.menuFreeClass,
    page.data.menuSlowClass, page.data.menuVirtualClass,
    page.data.menuTrainingClass, page.data.menuSettingsClass,
  ].filter((className) => className === 'feature-focused').length;
  assert.equal(focusedCount(), 1);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.data.menuSlowClass, 'feature-focused');
  assert.equal(focusedCount(), 1);
  releaseDirectionGesture(page);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.data.menuVirtualClass, 'feature-focused');
  releaseDirectionGesture(page);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.data.menuTrainingClass, 'feature-focused');
  releaseDirectionGesture(page);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.data.menuSettingsClass, 'feature-focused');
  releaseDirectionGesture(page);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.data.menuFreeClass, 'feature-focused', '无计划五个入口循环回到自由跑');
  assert.equal(focusedCount(), 1);

  page.todayWorkoutPlan = { title: '今日训练' };
  page.setData({ todayWorkoutAvailable: true });
  page.setMenuFocus(0);
  assert.equal(page.data.menuTodayClass, 'feature-focused');
  page.setMenuFocus(5);
  assert.equal(page.data.menuSettingsClass, 'feature-focused');
  page.setMenuFocus(6);
  assert.equal(page.data.menuTodayClass, 'feature-focused', '有计划六个入口闭环');
});

test('五个固定入口与可选今日训练共用单个静态导航容器', () => {
  const navStart = runHudSource.indexOf(
    '<view class="feature-nav" role="navigation">',
  );
  const trainingStart = runHudSource.indexOf('<view class="training-screen"', navStart);
  assert.ok(navStart >= 0 && trainingStart > navStart);
  const menuMarkup = runHudSource.slice(navStart, trainingStart);
  assert.equal((menuMarkup.match(/role="navigation"/g) || []).length, 1,
    '今日训练异步出现时不能重建整个宿主 navigation');
  assert.equal((menuMarkup.match(/bindfocus="onMenuFocus"/g) || []).length, 6);
  assert.equal((menuMarkup.match(/<button\b/g) || []).length, 6);
  assert.match(menuMarkup,
    /bindtap="openTodayWorkout"[\s\S]*ink:if="\{\{ todayWorkoutAvailable \}\}"/);
  for (const field of [
    'menuTodayTabIndex', 'menuFreeTabIndex', 'menuSlowTabIndex',
    'menuVirtualTabIndex', 'menuTrainingTabIndex', 'menuSettingsTabIndex',
  ]) {
    assert.match(menuMarkup, new RegExp('(?:tabindex|data-index)="\\{\\{ ' + field + ' \\}\\}"'));
  }
  assert.match(menuMarkup, /超慢跑/);
  assert.match(menuMarkup, /openSlowMode/);
  assert.match(menuMarkup, /训练计划/);
  assert.match(menuMarkup, /openTrainingMode/);

  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  assert.equal(page.onMenuFocus({
    currentTarget: { dataset: { index: 1 } },
  }), true);
  assert.equal(page.menuFocusIndex, 1);
  assert.equal(page.data.surfacePhase, 'menu', '宿主焦点只能同步选中框，不能激活入口');

  page.onKeyUp({ code: 'ArrowUp', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 0);
  assert.equal(page.onMenuFocus({
    currentTarget: { dataset: { index: 1 } },
  }), false, '方向释放期内迟到的宿主旧焦点不得覆盖页面焦点');
  assert.equal(page.menuFocusIndex, 0);
  releaseDirectionGesture(page);
  assert.equal(page.onMenuFocus({
    currentTarget: { dataset: { index: 1 } },
  }), true, '释放期结束后允许宿主焦点重新同步');
  assert.equal(page.menuFocusIndex, 1);
});

test('训练选择按轻松、LSD、法特莱克、间歇、返回五项循环', () => {
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  page.setMenuFocus(3);
  assert.equal(page.data.menuTrainingClass, 'feature-focused');
  assert.equal(page.openTrainingMode(), true);
  assert.equal(page.data.surfacePhase, 'training');

  const classes = [
    'trainingEasyClass',
    'trainingLongClass',
    'trainingFartlekClass',
    'trainingIntervalClass',
    'trainingBackClass',
  ];
  const focused = (field) => assert.equal(page.data[field], 'training-option-focused');
  focused(classes[0]);
  for (let index = 1; index < classes.length; index += 1) {
    releaseDirectionGesture(page);
    page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
    focused(classes[index]);
    assert.equal(classes.filter(
      (field) => page.data[field] === 'training-option-focused',
    ).length, 1);
  }
  releaseDirectionGesture(page);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  focused(classes[0]);
  releaseDirectionGesture(page);
  page.onKeyUp({ code: 'ArrowUp', preventDefault() {} });
  focused(classes[4]);
});

test('本地训练无设备 owner 也能生成计划并建立执行状态', () => {
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  assert.equal(wx.store.has(PUBLIC_DEVICE_ID_STORAGE_KEY), false);
  assert.equal(wx.store.has(DEVICE_BINDING_STORAGE_KEY), false);

  page.setMenuFocus(3);
  assert.equal(page.openTrainingMode(), true);
  releaseSurfaceGesture(page);
  assert.equal(page.onTrainingTap({
    currentTarget: { dataset: { preset: 'easy', index: 0 } },
  }), true);
  assert.equal(page.data.surfacePhase, 'ready');
  assert.equal(page.data.primaryLabel, '开始搜索');
  assert.equal(page.runMode, 'free');
  assert.equal(page.activeLocalTrainingPresetId, 'easy');
  assert.equal(page.activeWorkoutPlan.type, 'easy');
  assert.equal(page.activeWorkoutPlan.data_namespace, 'local:manual-training');

  const execution = page.prepareWorkoutExecution(Date.now(), 0);
  assert.ok(execution);
  assert.equal(execution.owner.publicDeviceId, 'LOCAL-TRAINING');
  assert.equal(execution.plan.type, 'easy');
});

test('本地训练完成只保留普通跑步事实，不冒充 Hermes 计划完成', async () => {
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  await waitWorkoutDurableStorage(page);

  page.setMenuFocus(3);
  assert.equal(page.openTrainingMode(), true);
  releaseSurfaceGesture(page);
  assert.equal(page.onTrainingTap({
    currentTarget: { dataset: { preset: 'easy', index: 0 } },
  }), true);

  const startedAtMs = Date.now();
  const execution = page.prepareWorkoutExecution(startedAtMs, 0);
  assert.ok(execution);
  page.completedWorkoutExecution = finishWorkoutExecution(execution, startedAtMs + 10_000);

  assert.equal(page.queueWorkoutCompletion({
    elapsedMs: 10_000,
    distanceM: 120,
    avgPaceSecPerKm: 500,
    avgCadenceSpm: 168,
  }), true);
  assert.equal(page.workoutCompletionQueued, true);
  assert.deepEqual(
    wx.store.get(WORKOUT_COMPLETION_QUEUE_KEY),
    [],
    '本地模板不得进入服务端签发计划的 completion 队列',
  );
});

test('checkpoint 只允许完整计划身份一致时恢复，ID 复用不串 revision 会话', () => {
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  const owner = cacheTestOwnerIdentity(page, 'device-plan-checkpoint-token');
  const now = Date.now();
  const empty = {
    pace_min_sec_per_km: null, pace_max_sec_per_km: null,
    heart_zone_min: null, heart_zone_max: null,
    cadence_min_spm: null, cadence_max_spm: null,
  };
  const planA = {
    schema_version: 2, workout_id: workoutFixtureId(1), plan_id: planFixtureId(101),
    plan_session_id: planSessionFixtureId(101), revision: 7, type: 'easy', title: '旧会话',
    scheduled_date: new Date(now).toISOString().slice(0, 10), status: 'planned',
    target: { duration_sec: 600, distance_m: null, ...empty },
    stages: [{
      stage_id: stageFixtureId(101), order: 0, type: 'work', title: '旧阶段',
      duration_sec: 600, distance_m: null, ...empty,
    }],
    issued_at_ms: now - 1000, expires_at_ms: now + 86_400_000,
    ownership_epoch: 1, data_namespace: 'test-owner-default',
  };
  const oldExecution = createWorkoutExecution(planA, owner, {
    nowMs: now, clientExecutionId: 'exec-checkpoint-old',
  });
  assert.equal(writeWorkoutExecutionCheckpoint(wx, oldExecution, owner), true);

  const planB = {
    ...planA,
    plan_id: planFixtureId(102),
    plan_session_id: planSessionFixtureId(102),
    title: '新会话',
    stages: [{ ...planA.stages[0], stage_id: stageFixtureId(102), title: '新阶段' }],
  };
  page.activeWorkoutPlan = planB;
  page.runOwnerContext = page.ownerContextFromIdentity(owner);
  const execution = page.prepareWorkoutExecution(now + 5_000, 0);
  assert.ok(execution);
  assert.equal(execution.plan.plan_id, planFixtureId(102));
  assert.equal(execution.plan.plan_session_id, planSessionFixtureId(102));
  assert.notEqual(execution.client_execution_id, 'exec-checkpoint-old');
});

test('checkpoint 瞬时读取失败保留旧执行并回到下一步，不降级成自由跑', () => {
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  const owner = cacheTestOwnerIdentity(page, 'device-plan-checkpoint-retry');
  const now = Date.now();
  const empty = {
    pace_min_sec_per_km: null, pace_max_sec_per_km: null,
    heart_zone_min: null, heart_zone_max: null,
    cadence_min_spm: null, cadence_max_spm: null,
  };
  const plan = {
    schema_version: 2, workout_id: workoutFixtureId(2), plan_id: planFixtureId(201),
    plan_session_id: planSessionFixtureId(201), revision: 1, type: 'easy', title: '今日轻松跑',
    scheduled_date: new Date(now).toISOString().slice(0, 10), status: 'planned',
    target: { duration_sec: 600, distance_m: null, ...empty },
    stages: [{
      stage_id: stageFixtureId(201), order: 0, type: 'work', title: '轻松跑',
      duration_sec: 600, distance_m: null, ...empty,
    }],
    issued_at_ms: now - 1000, expires_at_ms: now + 86_400_000,
    ownership_epoch: 1, data_namespace: 'test-owner-default',
  };
  const oldExecution = createWorkoutExecution(plan, owner, {
    nowMs: now, clientExecutionId: 'exec-checkpoint-preserved',
  });
  assert.equal(writeWorkoutExecutionCheckpoint(wx, oldExecution, owner), true);
  page.activeWorkoutPlan = plan;
  page.activeLocalTrainingPresetId = '';
  page.runMode = 'free';
  page.setData({ surfacePhase: 'ready' });

  const getStorageSync = wx.getStorageSync.bind(wx);
  let failOnce = true;
  wx.getStorageSync = (key) => {
    if (key === 'smartrun_workout_execution_v1' && failOnce) {
      failOnce = false;
      throw new Error('transient checkpoint read');
    }
    return getStorageSync(key);
  };
  assert.equal(page.finishEntry(page.surfaceGeneration), false);
  assert.equal(page.data.surfacePhase, 'ready');
  assert.equal(page.data.running, false);
  assert.equal(page.data.primaryLabel, '下一步');
  assert.equal(page.data.searchChip, '请重试');
  assert.equal(page.activeWorkoutPlan.workout_id, plan.workout_id);
  assert.equal(
    wx.store.get('smartrun_workout_execution_v1').execution.client_execution_id,
    'exec-checkpoint-preserved',
  );
});

test('checkpoint 静默写入失败不得进入 HUD，保留旧执行并回到下一步', async () => {
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  await waitWorkoutDurableStorage(page);
  const owner = cacheTestOwnerIdentity(page, 'device-plan-checkpoint-write');
  const now = Date.now() - 5_000;
  const empty = {
    pace_min_sec_per_km: null, pace_max_sec_per_km: null,
    heart_zone_min: null, heart_zone_max: null,
    cadence_min_spm: null, cadence_max_spm: null,
  };
  const plan = {
    schema_version: 2, workout_id: workoutFixtureId(3),
    plan_id: planFixtureId(301), plan_session_id: planSessionFixtureId(301),
    revision: 1, type: 'easy', title: '今日轻松跑',
    scheduled_date: new Date(now).toISOString().slice(0, 10), status: 'planned',
    target: { duration_sec: 600, distance_m: null, ...empty },
    stages: [{
      stage_id: stageFixtureId(301), order: 0, type: 'work', title: '轻松跑',
      duration_sec: 600, distance_m: null, ...empty,
    }],
    issued_at_ms: now - 1000, expires_at_ms: now + 86_400_000,
    ownership_epoch: 1, data_namespace: 'test-owner-default',
  };
  const oldExecution = createWorkoutExecution(plan, owner, {
    nowMs: now, clientExecutionId: 'exec-checkpoint-write-old',
  });
  assert.equal(writeWorkoutExecutionCheckpoint(wx, oldExecution, owner), true);
  page.activeWorkoutPlan = plan;
  page.activeLocalTrainingPresetId = '';
  page.runMode = 'free';
  page.setData({ surfacePhase: 'ready' });

  const setStorageSync = wx.setStorageSync.bind(wx);
  wx.setStorageSync = (key, value) => {
    if (key === 'smartrun_workout_execution_v1') return;
    setStorageSync(key, value);
  };

  assert.equal(page.finishEntry(page.surfaceGeneration), false);
  assert.equal(page.data.surfacePhase, 'ready');
  assert.equal(page.data.running, false);
  assert.equal(page.data.primaryLabel, '下一步');
  assert.equal(page.data.searchChip, '请重试');
  assert.equal(page.activeWorkoutPlan.workout_id, plan.workout_id);
  assert.equal(page.workoutExecution, null);
  assert.equal(
    wx.store.get('smartrun_workout_execution_v1').execution.client_execution_id,
    'exec-checkpoint-write-old',
  );
});

test('今日训练异步插入或移除保持用户所选模式，并取消已待定的确认', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  page.menuFocusTouched = true;
  page.setMenuFocus(1);
  assert.equal(page.data.menuSlowClass, 'feature-focused');

  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  assert.ok(page.pendingSurfaceGlobalHookTimer);
  page.applyTodayWorkoutPlan({
    title: '一段可能很长的今日训练名称',
    target: { duration_sec: 1800 },
    stages: [{ stage_id: 'warmup' }, { stage_id: 'run' }],
  });
  assert.equal(page.pendingSurfaceGlobalHookTimer, null);
  assert.equal(page.menuFocusIndex, 2);
  assert.equal(page.data.menuSlowClass, 'feature-focused');
  assert.equal(page.data.todayWorkoutTitle, '今日训练');
  t.mock.timers.tick(600);
  assert.equal(page.data.surfacePhase, 'menu');

  page.applyTodayWorkoutPlan(null);
  assert.equal(page.menuFocusIndex, 1);
  assert.equal(page.data.menuSlowClass, 'feature-focused');
});

test('菜单用 bootstrap owner 拉取 v2 今日训练，离线缓存后走既有搜索/HUD且最终阶段不自动结束', async () => {
  const page = freshPage();
  // 本测试只验证 current-workout；隔离 onLoad 自动身份 bootstrap，避免它的
  // 离线回包与手工注入 owner 并发覆盖菜单状态。
  page.refreshDeviceIdentity = async () => null;
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  await waitWorkoutDurableStorage(page);
  const identity = cacheTestOwnerIdentity(page, 'device-plan-token-0001');
  const now = Date.now();
  const target = {
    duration_sec: 60,
    distance_m: null,
    pace_min_sec_per_km: null,
    pace_max_sec_per_km: null,
    heart_zone_min: 2,
    heart_zone_max: 3,
    cadence_min_spm: null,
    cadence_max_spm: null,
  };
  const workoutPlan = {
    schema_version: 2,
    workout_id: workoutFixtureId(4),
    plan_id: planFixtureId(401),
    plan_session_id: planSessionFixtureId(401),
    revision: 5,
    type: 'easy',
    title: '今日轻松跑',
    scheduled_date: new Date(now).toISOString().slice(0, 10),
    status: 'planned',
    target,
    stages: [{
      stage_id: stageFixtureId(401), order: 0, type: 'work', title: '轻松跑',
      ...target,
    }],
    issued_at_ms: now - 1000,
    expires_at_ms: now + 86_400_000,
    ownership_epoch: 1,
    data_namespace: 'test-owner-default',
  };
  const heartRatePolicy = {
    schema_version: 1,
    max_hr_bpm: 200,
    source: 'garmin_profile',
    issued_at_ms: now - 1000,
    expires_at_ms: now + 86_400_000,
  };
  let requestedUrl = '';
  wx.requestImpl = (options) => {
    requestedUrl = options.url;
    options.success({
      statusCode: 200,
      data: JSON.stringify({
        available: true,
        plan: workoutPlan,
        ownership_epoch: 1,
        data_namespace: 'test-owner-default',
        public_device_id: 'test-device-default',
        heart_rate_policy: heartRatePolicy,
      }),
    });
  };
  await page.loadTodayWorkoutForMenu(identity);
  assert.match(requestedUrl, /\/api\/coach-svc\/coach\/aiui-workouts\/current$/);
  assert.equal(page.data.todayWorkoutAvailable, true);
  assert.equal(page.data.menuTodayClass, 'feature-focused');
  assert.equal(page.todayWorkoutPlan.revision, 5);
  assert.deepEqual(page.currentHeartRatePolicy, heartRatePolicy);
  assert.equal(
    wx.store.get(HEART_RATE_POLICY_STORAGE_KEY).owner.data_namespace,
    'test-owner-default',
  );

  releaseSurfaceGesture(page);
  assert.equal(page.openTodayWorkout(), true);
  const launchFlight = page.todayWorkoutLaunchPromise;
  assert.ok(launchFlight);
  assert.equal(page.data.surfacePhase, 'menu', '缓存只能展示，JIT 成功前不得进入搜索页');
  assert.equal(page.data.todayWorkoutDetail, '正在确认训练安全…');
  assert.equal(await launchFlight, true);
  assert.equal(page.data.surfacePhase, 'ready');
  assert.equal(page.data.primaryLabel, '开始搜索');
  assert.equal(page.activeWorkoutPlan.workout_id, workoutFixtureId(4));
  page.setData({ surfacePhase: 'hud' });
  page.startRun();
  page.stopTicker();
  assert.deepEqual(page.frozenHeartRatePolicy, heartRatePolicy);
  page.currentHeartRatePolicy = {
    ...heartRatePolicy,
    max_hr_bpm: 220,
  };
  assert.equal(page.runHeartRateZone(180), 5,
    '跑中继续使用开跑时冻结的 200bpm 策略，不热切到 220bpm');
  assert.equal(page.data.workoutActive, true);
  const startedAt = page.workoutExecution.started_at_ms;
  const fields = page.advanceWorkoutClock(startedAt + 60_000, {});
  assert.equal(page.workoutExecution.status, 'plan_complete');
  assert.equal(fields.hudHint, '训练完成 · 三按确认结束');
  assert.equal(page.data.running, true, '阶段完成只能提示，仍由已有双确认结束整场');

  // 网络断开后同 owner 的未过期缓存仍能恢复计划，不需要 runOwnerContext pin。
  const cachedEntries = Array.from(wx.store.entries()).map(([key, value]) => [
    key, JSON.parse(JSON.stringify(value)),
  ]);
  const second = freshPage();
  pagesToClean.push(second);
  for (const [key, value] of cachedEntries) wx.store.set(key, value);
  second.pageVisible = true;
  second.setData({ surfacePhase: 'menu' });
  second.deviceIdentityCache = testOwnerIdentity('device-plan-token-0001');
  await second.loadTodayWorkoutForMenu(second.deviceIdentityCache);
  assert.equal(second.data.todayWorkoutAvailable, true);
  assert.equal(second.todayWorkoutPlan.workout_id, workoutFixtureId(4));
});

test('用户快速离开菜单后迟到的同 owner 心率策略仍可落地，并只在开跑时冻结', async () => {
  const page = freshPage();
  page.refreshDeviceIdentity = async () => null;
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  await waitWorkoutDurableStorage(page);
  const identity = cacheTestOwnerIdentity(page, 'policy-race-token-0001');
  page.deviceIdentityCache = identity;
  page.pageVisible = true;

  let resolveCurrentWorkout;
  page.deviceWxRequest = () => new Promise((resolve) => {
    resolveCurrentWorkout = resolve;
  });
  const requestFlight = page.loadTodayWorkoutForMenu(identity);
  assert.equal(typeof resolveCurrentWorkout, 'function');

  page.setData({ surfacePhase: 'ready' });
  const now = Date.now();
  const policy = {
    schema_version: 1,
    max_hr_bpm: 200,
    source: 'garmin_profile',
    issued_at_ms: now - 1000,
    expires_at_ms: now + 60_000,
  };
  resolveCurrentWorkout(currentWorkoutEnvelope(null, {
    available: false,
    heart_rate_policy: policy,
  }));
  assert.equal(await requestFlight, null);
  assert.deepEqual(page.currentHeartRatePolicy, policy,
    '页面已进入搜索/热身时，可信策略仍须写入当前 owner 缓存');
  assert.equal(
    wx.store.get(HEART_RATE_POLICY_STORAGE_KEY).policy.max_hr_bpm,
    200,
  );

  makeRunning(page);
  page.stopTicker();
  assert.deepEqual(page.frozenHeartRatePolicy, policy);
  assert.equal(page.runHeartRateZone(160), 4,
    '开跑时冻结的 Garmin 档案策略必须恢复五级区间显示');

  page.currentHeartRatePolicy = { ...policy, max_hr_bpm: 220 };
  assert.equal(page.runHeartRateZone(160), 4,
    'HUD 后迟到的新策略不得热切换本场已冻结区间');
});

test('今日训练 JIT 对网络、unavailable、owner 与处方漂移全部 fail closed', async () => {
  const page = freshPage();
  page.refreshDeviceIdentity = async () => null;
  page.refreshWorkoutMenuState = async () => null;
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  await waitWorkoutDurableStorage(page);
  const identity = cacheTestOwnerIdentity(page, 'device-jit-token-0001');
  const now = Date.now();
  const displayed = strictWorkoutFixture(81, now);
  assert.equal(writeCachedWorkout(wx, displayed, identity, { nowMs: now }), true);
  page.applyTodayWorkoutPlan(displayed);

  let responseMode = 'network';
  wx.requestImpl = (options) => {
    if (responseMode === 'network') {
      options.fail({ errMsg: 'request:fail network unavailable' });
      return;
    }
    if (responseMode === 'unavailable') {
      options.success(currentWorkoutEnvelope(null, { available: false }));
      return;
    }
    if (responseMode === 'owner-mismatch') {
      options.success(currentWorkoutEnvelope(displayed, {
        ownership_epoch: 2,
        data_namespace: 'test-owner-other',
      }));
      return;
    }
    options.success(currentWorkoutEnvelope(responseMode));
  };

  releaseSurfaceGesture(page);
  assert.equal(page.openTodayWorkout(), true);
  let flight = page.todayWorkoutLaunchPromise;
  assert.equal(await flight, false);
  assert.equal(page.data.surfacePhase, 'menu');
  assert.equal(page.activeWorkoutPlan, null);
  assert.equal(page.data.todayWorkoutDetail, '需要联网确认，请重试');
  assert.equal(readCachedWorkout(wx, identity, { nowMs: Date.now() }).workout_id,
    displayed.workout_id, '网络失败只阻止开跑，不销毁仍可展示的缓存');

  responseMode = 'owner-mismatch';
  releaseSurfaceGesture(page);
  assert.equal(page.openTodayWorkout(), true);
  flight = page.todayWorkoutLaunchPromise;
  assert.equal(await flight, false);
  assert.equal(page.data.surfacePhase, 'menu');
  assert.equal(page.data.todayWorkoutDetail, '训练校验失败，请重试');

  responseMode = 'unavailable';
  releaseSurfaceGesture(page);
  assert.equal(page.openTodayWorkout(), true);
  flight = page.todayWorkoutLaunchPromise;
  assert.equal(await flight, false);
  assert.equal(page.data.surfacePhase, 'menu');
  assert.equal(page.data.todayWorkoutDetail, '今日训练暂不可开始');
  assert.equal(readCachedWorkout(wx, identity, { nowMs: Date.now() }), null,
    '同 owner 明确 unavailable 后旧缓存不得继续成为下次离线授权');

  const changed = {
    ...displayed,
    revision: displayed.revision + 1,
    target: { ...displayed.target, duration_sec: 720 },
    stages: [{ ...displayed.stages[0], duration_sec: 720 }],
    issued_at_ms: now,
    expires_at_ms: now + 3 * 60 * 60 * 1000,
  };
  responseMode = changed;
  releaseSurfaceGesture(page);
  assert.equal(page.openTodayWorkout(), true);
  flight = page.todayWorkoutLaunchPromise;
  assert.equal(await flight, false);
  assert.equal(page.data.surfacePhase, 'menu');
  assert.equal(page.activeWorkoutPlan, null);
  assert.equal(page.todayWorkoutPlan.revision, changed.revision);
  assert.equal(page.data.todayWorkoutDetail, '训练已更新，请再次确认');

  releaseSurfaceGesture(page);
  assert.equal(page.openTodayWorkout(), true);
  flight = page.todayWorkoutLaunchPromise;
  assert.equal(await flight, true, '用户再次确认同一份最新处方后才可开跑');
  assert.equal(page.data.surfacePhase, 'ready');
  assert.equal(page.data.primaryLabel, '开始搜索');
  assert.equal(page.activeWorkoutPlan.revision, changed.revision);
});

test('今日训练 JIT 迟到回包在焦点移开又返回后仍不能激活', async () => {
  const page = freshPage();
  page.refreshDeviceIdentity = async () => null;
  page.refreshWorkoutMenuState = async () => null;
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  await waitWorkoutDurableStorage(page);
  const identity = cacheTestOwnerIdentity(page, 'device-jit-token-0002');
  const plan = strictWorkoutFixture(82, Date.now());
  assert.equal(writeCachedWorkout(wx, plan, identity), true);
  page.applyTodayWorkoutPlan(plan);
  let pendingRequest = null;
  wx.requestImpl = (options) => { pendingRequest = options; };

  releaseSurfaceGesture(page);
  assert.equal(page.openTodayWorkout(), true);
  const flight = page.todayWorkoutLaunchPromise;
  assert.ok(flight);
  assert.equal(page.data.todayWorkoutDetail, '正在确认训练安全…');

  releaseDirectionGesture(page);
  assert.equal(page.handleSurfaceDirection('ArrowDown', Date.now(), 'test'), true);
  assert.equal(page.data.menuFreeClass, 'feature-focused');
  page.setMenuFocus(0);
  assert.equal(page.data.menuTodayClass, 'feature-focused');
  pendingRequest.success(currentWorkoutEnvelope(plan));
  assert.equal(await flight, false);
  assert.equal(page.data.surfacePhase, 'menu');
  assert.equal(page.activeWorkoutPlan, null);
  assert.equal(page.data.todayWorkoutDetail, page.todayWorkoutDetail(plan));
});

test('onLoad 用异步精确键初始化训练 checkpoint、完成队列与隔离队列镜像', async () => {
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  await waitWorkoutDurableStorage(page);

  assert.deepEqual(wx.store.get('pending_workout_completions_v2'), []);
  assert.deepEqual(
    wx.store.get('pending_workout_completions_state_v1').committed_value,
    [],
  );
  assert.deepEqual(wx.store.get('quarantined_workout_completions_v1'), []);
  assert.deepEqual(
    wx.store.get('quarantined_workout_completions_state_v1').committed_value,
    [],
  );
  assert.deepEqual(wx.store.get('smartrun_workout_execution_v1'), {
    __smartrun_workout_execution_empty_v1__: true,
  });
  assert.deepEqual(
    wx.store.get('smartrun_workout_execution_state_v1').committed_value,
    { __smartrun_workout_execution_empty_v1__: true },
  );
});

test('Hermes conservative_default 只在当前页面代次生效，并清除旧的持久策略', () => {
  const page = freshPage();
  pagesToClean.push(page);
  page.onLoad();
  const now = Date.now();
  const owner = {
    publicDeviceId: 'test-device-default',
    ownershipEpoch: 1,
    dataNamespace: 'test-owner-default',
  };
  assert.equal(writeHeartRatePolicy(wx, {
    schema_version: 1,
    max_hr_bpm: 190,
    source: 'user_explicit',
    issued_at_ms: now - 1000,
    expires_at_ms: now + 60_000,
  }, owner, { nowMs: now }), true);

  const fallback = {
    schema_version: 1,
    max_hr_bpm: 180,
    source: 'conservative_default',
    issued_at_ms: now - 1000,
    expires_at_ms: now + 60_000,
  };
  assert.deepEqual(page.applyHeartRatePolicy(fallback, owner, now), fallback);
  assert.deepEqual(page.currentHeartRatePolicy, fallback);
  assert.equal(wx.store.has(HEART_RATE_POLICY_STORAGE_KEY), false,
    '通用默认不得在下次离线启动时复活为个人值');
});

test('conservative_default 清理失败显式诊断，当前页面仍只采用 session fallback', () => {
  const page = freshPage();
  pagesToClean.push(page);
  const now = Date.now();
  const owner = {
    publicDeviceId: 'test-device-default',
    ownershipEpoch: 1,
    dataNamespace: 'test-owner-default',
  };
  const oldTrusted = {
    schema_version: 1,
    max_hr_bpm: 200,
    source: 'user_explicit',
    issued_at_ms: now - 1000,
    expires_at_ms: now + 60_000,
  };
  const fallback = {
    schema_version: 1,
    max_hr_bpm: 180,
    source: 'conservative_default',
    issued_at_ms: now - 1000,
    expires_at_ms: now + 60_000,
  };
  assert.equal(writeHeartRatePolicy(wx, oldTrusted, owner, { nowMs: now }), true);
  const originalSet = wx.setStorageSync.bind(wx);
  const originalRemove = wx.removeStorageSync.bind(wx);
  const originalLog = console.log;
  const logs = [];
  wx.setStorageSync = (key, value) => {
    if (key === HEART_RATE_POLICY_STORAGE_KEY) return;
    originalSet(key, value);
  };
  wx.removeStorageSync = (key) => {
    if (key === HEART_RATE_POLICY_STORAGE_KEY) return;
    originalRemove(key);
  };
  console.log = (...args) => { logs.push(args.join(' ')); };
  try {
    assert.deepEqual(page.applyHeartRatePolicy(fallback, owner, now), fallback);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(page.currentHeartRatePolicy, fallback);
  assert.deepEqual(page.heartRatePolicyForOwner(owner, now), fallback,
    '清理失败也不得把 durable 旧 trusted 值重新装入当前页面');
  assert.ok(logs.some((line) => line.includes(
    'CACHE_CLEAR_FAILED source=conservative_default',
  )));
});

test('完成队列或隔离镜像 unknown 时隐藏今日训练但保留缓存，总结页保持待保存', async () => {
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  await waitWorkoutDurableStorage(page);
  const identity = cacheTestOwnerIdentity(page, 'device-plan-storage-unknown');
  const now = Date.now();
  const empty = {
    pace_min_sec_per_km: null, pace_max_sec_per_km: null,
    heart_zone_min: null, heart_zone_max: null,
    cadence_min_spm: null, cadence_max_spm: null,
  };
  const plan = {
    schema_version: 2,
    workout_id: workoutFixtureId(450),
    plan_id: planFixtureId(450),
    plan_session_id: planSessionFixtureId(450),
    revision: 1,
    type: 'easy',
    title: '待恢复训练',
    scheduled_date: new Date(now).toISOString().slice(0, 10),
    status: 'planned',
    target: { duration_sec: 600, distance_m: null, ...empty },
    stages: [{
      stage_id: stageFixtureId(450), order: 0, type: 'work', title: '轻松跑',
      duration_sec: 600, distance_m: null, ...empty,
    }],
    issued_at_ms: now - 1000,
    expires_at_ms: now + 86_400_000,
    ownership_epoch: 1,
    data_namespace: 'test-owner-default',
  };
  assert.equal(writeCachedWorkout(wx, plan, identity, { nowMs: now }), true);

  const pendingMirror = wx.store.get('pending_workout_completions_state_v1');
  wx.store.set('pending_workout_completions_state_v1', {
    ...pendingMirror,
    value_digest: 'corrupt-pending',
  });
  assert.deepEqual(page.workoutPlanVisibilityState(plan.workout_id, identity), {
    hidden: true,
    readable: false,
  });
  wx.store.set('pending_workout_completions_state_v1', pendingMirror);

  const quarantineMirror = wx.store.get('quarantined_workout_completions_state_v1');
  wx.store.set('quarantined_workout_completions_state_v1', {
    ...quarantineMirror,
    value_digest: 'corrupt-quarantine',
  });
  assert.deepEqual(page.workoutPlanVisibilityState(plan.workout_id, identity), {
    hidden: true,
    readable: false,
  });
  const hidden = await page.loadTodayWorkoutForMenu({ ...identity, deviceToken: '' });
  assert.equal(hidden, null);
  assert.equal(page.data.todayWorkoutAvailable, false);
  assert.ok(readCachedWorkout(wx, identity, { nowMs: now }),
    'unknown 只能临时隐藏，不能删除唯一可恢复计划缓存');

  page.completedWorkoutExecution = {
    client_execution_id: 'exec-storage-unknown-01',
    owner: identity,
  };
  assert.equal(page.summaryHermesPending(), true,
    'unknown 必须保持总结退出门为待保存，不能伪装成已 ACK');
});

test('已完成 JIT 授权的今日超慢跑进入 IMU-only，普通计划进入自由跑策略', () => {
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  const basePlan = {
    schema_version: 2,
    workout_id: workoutFixtureId(5),
    plan_id: planFixtureId(501),
    plan_session_id: planSessionFixtureId(501),
    revision: 2,
    type: 'slow_jog',
    title: '今日超慢跑',
    scheduled_date: new Date().toISOString().slice(0, 10),
    status: 'planned',
    target: { duration_sec: 600 },
    stages: [{ stage_id: stageFixtureId(501), duration_sec: 600 }],
  };
  page.applyTodayWorkoutPlan(basePlan);
  assert.equal(page.openAuthorizedTodayWorkout(basePlan), true);
  assert.equal(page.runMode, 'slow');
  assert.equal(page.data.runMode, 'slow');
  assert.equal(page.isSlowJogMode(), true);

  page.showFeatureMenu();
  page.applyTodayWorkoutPlan({ ...basePlan, type: 'easy' });
  assert.equal(page.openAuthorizedTodayWorkout({ ...basePlan, type: 'easy' }), true);
  assert.equal(page.runMode, 'free');
  assert.equal(page.isSlowJogMode(), false);

  page.showFeatureMenu();
  page.applyTodayWorkoutPlan({ ...basePlan, type: 'rest' });
  assert.equal(page.openAuthorizedTodayWorkout({ ...basePlan, type: 'rest' }), false,
    '未知或不可执行类型不能降级成自由跑');
  assert.equal(page.data.surfacePhase, 'menu');
});

test('菜单阶段用 scoped token 补传 workout completion，非 2xx 显式 ACK 不删队列', async () => {
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  await waitWorkoutDurableStorage(page);
  const identity = cacheTestOwnerIdentity(page, 'device-plan-token-0002');
  const now = Date.now();
  const empty = {
    pace_min_sec_per_km: null, pace_max_sec_per_km: null,
    heart_zone_min: null, heart_zone_max: null,
    cadence_min_spm: null, cadence_max_spm: null,
  };
  const plan = {
    schema_version: 2, workout_id: workoutFixtureId(6), plan_id: planFixtureId(601),
    plan_session_id: planSessionFixtureId(601), revision: 3, type: 'easy', title: '轻松跑',
    scheduled_date: new Date(now).toISOString().slice(0, 10), status: 'planned',
    target: { duration_sec: 60, distance_m: null, ...empty },
    stages: [{
      stage_id: stageFixtureId(601), order: 0, type: 'work', title: '轻松跑',
      duration_sec: 60, distance_m: null, ...empty,
    }],
    issued_at_ms: now - 1000, expires_at_ms: now + 86_400_000,
    ownership_epoch: 1, data_namespace: 'test-owner-default',
  };
  let execution = createWorkoutExecution(plan, identity, {
    nowMs: now, clientExecutionId: 'exec-menu-ack-01',
  });
  execution = finishWorkoutExecution(execution, now + 10_000);
  const payload = buildWorkoutCompletion({ execution });
  assert.ok(enqueueWorkoutCompletion(wx, payload, identity, {
    allowedStageIds: [stageFixtureId(601)],
  }));

  wx.requestImpl = (options) => options.success({ statusCode: 429, data: '{}' });
  assert.equal(await page.flushWorkoutCompletions(), false);
  assert.equal(readPendingWorkoutCompletions(wx, identity).length, 1);

  wx.requestImpl = (options) => options.success({
    statusCode: 200,
    data: JSON.stringify({
      accepted: true, execution_id: 'wex-menu-ack-01', duplicate: true,
      next_plan_refresh_required: true,
    }),
  });
  // onLoad 的离线 bootstrap 与本测试手工注入身份是两个异步来源；第二轮
  // 显式恢复同一 scoped identity，测试补传逻辑本身而不是 mock 的竞态。
  page.deviceIdentityCache = identity;
  assert.equal(await page.flushWorkoutCompletions(), true);
  assert.equal(readPendingWorkoutCompletions(wx, identity).length, 0);
});

test('workout completion 401 只刷新一次同 owner token 后重试', async () => {
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  await waitWorkoutDurableStorage(page);
  const identity = cacheTestOwnerIdentity(page, 'device-plan-token-old');
  const now = Date.now();
  const empty = {
    pace_min_sec_per_km: null, pace_max_sec_per_km: null,
    heart_zone_min: null, heart_zone_max: null,
    cadence_min_spm: null, cadence_max_spm: null,
  };
  const plan = {
    schema_version: 2, workout_id: workoutFixtureId(7), plan_id: planFixtureId(701),
    plan_session_id: planSessionFixtureId(701), revision: 1, type: 'easy', title: '轻松跑',
    scheduled_date: new Date(now).toISOString().slice(0, 10), status: 'planned',
    target: { duration_sec: 60, distance_m: null, ...empty },
    stages: [{
      stage_id: stageFixtureId(701), order: 0, type: 'work', title: '轻松跑',
      duration_sec: 60, distance_m: null, ...empty,
    }],
    issued_at_ms: now - 1000, expires_at_ms: now + 86_400_000,
    ownership_epoch: 1, data_namespace: 'test-owner-default',
  };
  let execution = createWorkoutExecution(plan, identity, {
    nowMs: now, clientExecutionId: 'exec-auth-retry-01',
  });
  execution = finishWorkoutExecution(execution, now + 10_000);
  const payload = buildWorkoutCompletion({ execution });
  assert.ok(enqueueWorkoutCompletion(wx, payload, identity, {
    allowedStageIds: [stageFixtureId(701)],
  }));

  const authHeaders = [];
  wx.requestImpl = (options) => {
    authHeaders.push(options.header.Authorization);
    if (authHeaders.length === 1) {
      options.success({ statusCode: 401, data: '{}' });
      return;
    }
    options.success({
      statusCode: 200,
      data: JSON.stringify({ accepted: true, execution_id: 'wex-auth-retry-01' }),
    });
  };
  page.refreshDeviceIdentity = async () => {
    const refreshed = testOwnerIdentity('device-plan-token-new');
    wx.store.set(DEVICE_TOKEN_STORAGE_KEY, refreshed.deviceToken);
    page.deviceIdentityCache = refreshed;
    return refreshed;
  };
  assert.equal(await page.flushWorkoutCompletions(), true);
  assert.deepEqual(authHeaders, [
    'Bearer device-plan-token-old',
    'Bearer device-plan-token-new',
  ]);
  assert.equal(readPendingWorkoutCompletions(wx, identity).length, 0);
});

test('workout completion 永久拒绝隔离后继续发送 FIFO，429 仍保留', async () => {
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  await waitWorkoutDurableStorage(page);
  const identity = cacheTestOwnerIdentity(page, 'device-plan-token-quarantine');
  const now = Date.now();
  const empty = {
    pace_min_sec_per_km: null, pace_max_sec_per_km: null,
    heart_zone_min: null, heart_zone_max: null,
    cadence_min_spm: null, cadence_max_spm: null,
  };
  const makePayload = (suffix) => {
    const fixtureSeed = suffix === 'first' ? 801 : 802;
    const plan = {
      schema_version: 2, workout_id: workoutFixtureId(fixtureSeed),
      plan_id: planFixtureId(fixtureSeed),
      plan_session_id: planSessionFixtureId(fixtureSeed),
      revision: 1, type: 'easy', title: '轻松跑',
      scheduled_date: new Date(now).toISOString().slice(0, 10), status: 'planned',
      target: { duration_sec: 60, distance_m: null, ...empty },
      stages: [{
        stage_id: stageFixtureId(fixtureSeed), order: 0, type: 'work', title: '轻松跑',
        duration_sec: 60, distance_m: null, ...empty,
      }],
      issued_at_ms: now - 1000, expires_at_ms: now + 86_400_000,
      ownership_epoch: 1, data_namespace: 'test-owner-default',
    };
    let execution = createWorkoutExecution(plan, identity, {
      nowMs: now, clientExecutionId: 'exec-quarantine-' + suffix,
    });
    execution = finishWorkoutExecution(execution, now + 10_000);
    return { plan, payload: buildWorkoutCompletion({ execution }) };
  };
  const first = makePayload('first');
  const second = makePayload('second');
  assert.ok(enqueueWorkoutCompletion(wx, first.payload, identity, {
    allowedStageIds: [first.plan.stages[0].stage_id],
  }));
  assert.ok(enqueueWorkoutCompletion(wx, second.payload, identity, {
    allowedStageIds: [second.plan.stages[0].stage_id],
  }));

  wx.requestImpl = (options) => {
    if (options.data.client_execution_id === 'exec-quarantine-first') {
      options.success({ statusCode: 409, data: '{}' });
      return;
    }
    options.success({
      statusCode: 200,
      data: JSON.stringify({ accepted: true, execution_id: 'wex-quarantine-second' }),
    });
  };
  assert.equal(await page.flushWorkoutCompletions(), true);
  assert.equal(readPendingWorkoutCompletions(wx, identity).length, 0);
  const quarantined = readQuarantinedWorkoutCompletions(wx, identity);
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0].item.client_execution_id, 'exec-quarantine-first');
  assert.equal(quarantined[0].status_code, 409);
  assert.equal(page.workoutPlanMustStayHidden(first.plan.workout_id, identity), true,
    '永久拒绝已隔离后不能让同一训练重新出现在今日训练菜单');
  assert.equal(readQuarantinedWorkoutCompletions(
    wx,
    testOwnerIdentity('other-token', { ownershipEpoch: 2, dataNamespace: 'other' }),
  ).length, 0);
});

test('完成回执丢失后重开菜单：先 ACK 再拉 current，旧 planned 回包不得复活按钮', async () => {
  const first = freshPage();
  first.onLoad({ mode: 'free' });
  pagesToClean.push(first);
  await waitWorkoutDurableStorage(first);
  const identity = cacheTestOwnerIdentity(first, 'device-plan-token-race');
  const now = Date.now();
  const empty = {
    pace_min_sec_per_km: null, pace_max_sec_per_km: null,
    heart_zone_min: null, heart_zone_max: null,
    cadence_min_spm: null, cadence_max_spm: null,
  };
  const plan = {
    schema_version: 2, workout_id: workoutFixtureId(9), plan_id: planFixtureId(901),
    plan_session_id: planSessionFixtureId(901), revision: 4, type: 'easy', title: '今日轻松跑',
    scheduled_date: new Date(now).toISOString().slice(0, 10), status: 'planned',
    target: { duration_sec: 60, distance_m: null, ...empty },
    stages: [{
      stage_id: stageFixtureId(901), order: 0, type: 'work', title: '轻松跑',
      duration_sec: 60, distance_m: null, ...empty,
    }],
    issued_at_ms: now - 1000, expires_at_ms: now + 86_400_000,
    ownership_epoch: 1, data_namespace: 'test-owner-default',
  };
  assert.equal(writeCachedWorkout(wx, plan, identity, { nowMs: now }), true);
  let execution = createWorkoutExecution(plan, identity, {
    nowMs: now, clientExecutionId: 'exec-menu-race-01',
  });
  execution = finishWorkoutExecution(execution, now + 10_000);
  const payload = buildWorkoutCompletion({ execution });
  assert.ok(enqueueWorkoutCompletion(wx, payload, identity, {
    allowedStageIds: [stageFixtureId(901)],
  }));

  // 第一次已在服务端完成但回执丢失：本地仍保留 durable 待办。
  wx.requestImpl = (options) => options.fail(new Error('response lost'));
  assert.equal(await first.flushWorkoutCompletions(), false);
  assert.equal(readPendingWorkoutCompletions(wx, identity).length, 1);
  const persisted = Array.from(wx.store.entries()).map(([key, value]) => [
    key, JSON.parse(JSON.stringify(value)),
  ]);

  const reopened = freshPage();
  pagesToClean.push(reopened);
  for (const [key, value] of persisted) wx.store.set(key, value);
  reopened.onLoad({ mode: 'free' });
  await waitWorkoutDurableStorage(reopened);
  reopened.setData({ surfacePhase: 'menu' });
  reopened.pageVisible = true;
  const reopenedIdentity = cacheTestOwnerIdentity(reopened, 'device-plan-token-race');
  let currentRequestedAfterAck = false;
  wx.requestImpl = (options) => {
    if (options.url.endsWith('/complete')) {
      options.success({
        statusCode: 200,
        data: JSON.stringify({
          accepted: true, execution_id: 'wex-menu-race-01', duplicate: true,
          next_plan_refresh_required: true,
        }),
      });
      return;
    }
    currentRequestedAfterAck = readPendingWorkoutCompletions(wx, reopenedIdentity).length === 0;
    // 即便服务器 current 视图短暂返回旧 planned，本页 ACK 墓碑也要压住它。
    options.success({
      statusCode: 200,
      data: JSON.stringify({
        available: true, plan,
        ownership_epoch: 1,
        data_namespace: 'test-owner-default',
        public_device_id: 'test-device-default',
      }),
    });
  };
  await reopened.refreshWorkoutMenuState(reopenedIdentity);
  assert.equal(currentRequestedAfterAck, true, '必须先精确 ACK 队列再请求 current');
  assert.equal(readPendingWorkoutCompletions(wx, reopenedIdentity).length, 0);
  assert.equal(reopened.data.todayWorkoutAvailable, false);
  assert.equal(reopened.todayWorkoutPlan, null);
  assert.equal(readCachedWorkout(wx, reopenedIdentity, { nowMs: now }), null);
});

test('室内跑复用搜索与 HUD，并在 RSC 不可用时保留 IMU', () => {
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);

  assert.equal(page.openGarminVirtualMode(), true);
  assert.equal(page.runMode, 'garmin_virtual');
  assert.equal(page.data.surfacePhase, 'ready');
  assert.equal(page.data.primaryLabel, '开始搜索');
  assert.match(page.data.searchText, /Garmin.*START/);
  assert.equal(page.data.searchChip, '室内跑');

  makeRunning(page);
  page.stopTicker();
  assert.equal(page.data.runMode, 'garmin_virtual');
  assert.ok(page.motionMetrics, 'RSC 不可用时仍需保留眼镜 IMU 指标链');
});

test('室内跑按有效 RSC 能力接管，缺失或断流后自动回退眼镜 IMU', () => {
  const page = freshPage();
  page.onLoad({ mode: 'garmin_virtual' });
  pagesToClean.push(page);
  makeRunning(page);
  page.stopTicker();

  const metrics = page.motionMetrics;
  const base = Date.now();
  for (let index = 1; index <= 5; index += 1) {
    metrics.onAcceptedStep(base + index * 400, 150);
  }
  const imuOnly = metrics.snapshot(base + 2000);
  assert.equal(imuOnly.cadenceSource, 'imu',
    '没有真实 RSC 数据时，室内跑必须直接使用眼镜步频');
  assert.equal(imuOnly.activeMotionSource, MOTION_SOURCE.IMU_STEP);
  const imuDistanceM = imuOnly.distanceM;

  const rscAtMs = base + 2100;
  metrics.onRscMeasurement({ speedMps: 3, cadenceSpm: 180 }, rscAtMs);
  const rscLive = metrics.snapshot(rscAtMs);
  assert.equal(rscLive.cadenceSource, 'rsc',
    'Garmin 或兼容设备实际发送合法 RSC 后才允许设备步频接管');
  assert.equal(rscLive.activeMotionSource, MOTION_SOURCE.RSC_SPEED);
  assert.equal(rscLive.rscPaceLive, true);

  metrics.onAcceptedStep(base + 2500, 180);
  assert.equal(metrics.distanceM, imuDistanceM,
    'RSC 新鲜时眼镜仍可计步，但不得与设备距离重复累计');

  for (const atMs of [5701, 6101, 6501, 6901, 7301]) {
    metrics.onAcceptedStep(base + atMs, 150);
  }
  const imuFallback = metrics.snapshot(base + 7301);
  assert.equal(imuFallback.rscPaceLive, false);
  assert.equal(imuFallback.cadenceSource, 'imu',
    'RSC 超过新鲜度后必须自动回到眼镜 IMU，而不是卡在设备状态');
  assert.equal(imuFallback.activeMotionSource, MOTION_SOURCE.IMU_STEP);
  assert.ok(imuFallback.distanceM > imuDistanceM,
    '设备断流后的真实眼镜落步必须继续增加距离');
});

test('室内跑不会把搜索页过期的 Garmin RSC 尾包伪装成开跑新数据', () => {
  const page = freshPage();
  page.onLoad({ mode: 'garmin_virtual' });
  pagesToClean.push(page);

  page.pendingRscMeasurement = {
    speedMps: 3,
    cadenceSpm: 180,
    totalDistanceM: null,
  };
  page.lastRscAtMs = Date.now() - 2501;
  page.rscLive = false;

  makeRunning(page);
  page.stopTicker();
  assert.equal(page.pendingRscMeasurement, null,
    '开跑前已经过期的最后一包必须被丢弃');
  assert.equal(page.motionMetrics.snapshot(Date.now()).rscPaceLive, false);

  const base = Date.now();
  for (let index = 1; index <= 5; index += 1) {
    page.motionMetrics.onAcceptedStep(base + index * 400, 150);
  }
  const fallback = page.motionMetrics.snapshot(base + 2000);
  assert.equal(fallback.cadenceSource, 'imu');
  assert.equal(fallback.activeMotionSource, MOTION_SOURCE.IMU_STEP,
    '没有新鲜 Garmin RSC 时第一段真实运动应直接由眼镜 IMU 计算');
});

test('设置与搜索页同样拒绝方向释放期的迟到宿主焦点', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

  const settings = freshPage();
  settings.onLoad({ mode: 'settings' });
  pagesToClean.push(settings);
  settings.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(settings.settingFocusIndex, 1);
  assert.equal(settings.onSettingFocus({
    currentTarget: { dataset: { index: 0 } },
  }), false, '设置页不得被滑动前的宿主焦点拉回');
  assert.equal(settings.settingFocusIndex, 1);
  t.mock.timers.tick(600);
  assert.equal(settings.onSettingFocus({
    currentTarget: { dataset: { index: 0 } },
  }), true);

  const search = freshPage();
  search.onLoad();
  pagesToClean.push(search);
  search.discoveredDeviceOrder = ['hr-1'];
  search.discoveredDeviceRefs = {
    'hr-1': {
      device: { id: 'hr-1', name: 'Heart Rate' },
      deviceName: 'Heart Rate',
      deviceMeta: 'ID hr-1',
      status: '',
    },
  };
  search.setSearchFocus(0);
  search.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(search.searchFocusIndex, 1);
  assert.equal(search.onSearchFocus({
    currentTarget: { dataset: { focusIndex: 0 } },
  }), false, '搜索页不得被滑动前的主按钮焦点拉回');
  assert.equal(search.searchFocusIndex, 1);
  t.mock.timers.tick(600);
  assert.equal(search.onSearchFocus({
    currentTarget: { dataset: { focusIndex: 0 } },
  }), true);
});

test('同一次滑动的方向别名只移动一步，下一次独立滑动才继续循环', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);

  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  t.mock.timers.tick(20);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  t.mock.timers.tick(20);
  page.onKeyUp({ code: 'ArrowRight', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 1, '前划的两个方向别名只能切到超慢跑一次');
  assert.equal(page.data.surfacePhase, 'menu', '方向手势不得激活按钮');
  assert.equal(page.openFreeMode(), false, '方向手势释放尾包不得误进自由跑');

  t.mock.timers.tick(601);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 2, '下一次独立前划从超慢跑切到室内跑');
  t.mock.timers.tick(601);
  page.onKeyUp({ code: 'ArrowUp', preventDefault() {} });
  t.mock.timers.tick(20);
  page.onKeyUp({ code: 'ArrowLeft', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 1, '后划别名同样只回到超慢跑一步');
});

test('方向只在 keyup 提交，宿主在按下与抬起之间重建焦点也只移动一次', () => {
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);

  page.onKeyDown({ code: 'ArrowDown' });
  assert.equal(page.menuFocusIndex, 0, 'keydown 只做诊断，不得提前改变页面焦点');
  page.onHostBlur();
  page.onHostFocus();

  let prevented = false;
  page.onKeyUp({ code: 'ArrowDown', preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'keyup 仍须拦截宿主默认滚动/焦点迁移');
  assert.equal(page.menuFocusIndex, 1,
    'keydown→blur→focus→keyup 的一次物理滑动必须只切到超慢跑一次');
});

test('keyup-only 宿主仍可前后划，焦点会话切换不清方向去重历史', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);

  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 1, 'keyup-only 宿主保留兼容兜底');
  page.onHostBlur();
  page.onHostFocus();
  t.mock.timers.tick(20);
  page.onKeyUp({ code: 'ArrowRight', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 1,
    '同一滑动的迟到方向别名不得因宿主焦点切换而跳过超慢跑');
});

test('GlobalHook 后宿主 blur/focus 不清尾包门，迟到 bindtap/TouchEnd 不激活旧焦点', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);

  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  assert.ok(page.pendingSurfaceGlobalHookTimer, 'GlobalHook 先进入 600ms 轻触/滑动判别窗');
  const guardedUntil = page.surfaceEntryConfirmGuardUntilMs;
  page.onHostBlur();
  page.onHostFocus();

  assert.equal(page.pendingSurfaceGlobalHookTimer, null, '焦点重建会取消尚未判定的轻触');
  assert.equal(page.surfaceEntryConfirmGuardUntilMs, guardedUntil,
    '取消轻触时仍须保留原 GlobalHook 建立的尾包门');
  assert.equal(page.openFreeMode(), false, '迟到 bindtap 不得激活旧的自由跑焦点');
  assert.equal(page.openSettingsMode(), false, '迟到 TouchEnd 不得改激活另一按钮');
  assert.equal(page.data.surfacePhase, 'menu');

  t.mock.timers.tick(641);
  assert.equal(page.openFreeMode(), true, '保护窗之后的独立点按仍正常工作');
  assert.equal(page.data.surfacePhase, 'ready');
  assert.equal(page.data.primaryLabel, '开始搜索');
});

test('AIUI 0.16.1 宿主失焦暂停扫描重试预算，focus 不自动重开搜索', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  const host = scanHost({ failScan: 'host temporarily busy' });
  page.onLoad();
  page.onShow();
  page.onReady();
  page.onScanTap();
  await flushAsync();
  assert.equal(host.scanCalls, 1);
  assert.ok(page.scanRetryTimer);
  assert.equal(page.scanRetryCount, 0,
    '重试预算只在真正发起原生调用时消耗');

  page.onHostBlur();
  assert.equal(page.hostFocused, false);
  assert.equal(page.scanRetryTimer, null);
  t.mock.timers.tick(60000);
  await flushAsync();
  assert.equal(host.scanCalls, 1, 'blur 期不得发起新的 scanDevices');
  assert.equal(page.scanRetryCount, 0, 'blur 期不消耗扫描重试预算');

  page.onHostFocus();
  assert.equal(page.hostFocused, true);
  t.mock.timers.tick(60000);
  await flushAsync();
  assert.equal(host.scanCalls, 1,
    'focus 只恢复已建立链路，绝不自动重开用户搜索');
});

test('AIUI 0.16.1 blur 保留健康 HRS/RSC GATT，focus 恢复单路通知与静默诊断', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const { device, hrChar, rscChar } = fakeHrRscDevice('fenix 8');
  page.onLoad();
  makeRunning(page);
  page.stopTicker();
  assert.equal(await page.connectSelected(device), true);
  if (page.rscProbePromise) await page.rscProbePromise;
  hrChar.notify(126);
  rscChar.notify({ speedMps: 2.8, cadenceSpm: 176, running: true });
  page.hrDegradedByRsc = true;
  page.scheduleHrNotificationRecovery(1000);
  assert.ok(page.hrNotifyRecoveryTimer);
  assert.ok(page.rscSilentTimer);
  const hrStartsBeforeBlur = hrChar.startNotificationsCalls;
  const rscStopsBeforeBlur = rscChar.stopNotificationsCalls;

  page.onHostBlur();
  assert.equal(page.data.bleState, 'connected');
  assert.equal(device.gatt.connected, true);
  assert.equal(device.gatt.disconnectCalls, 0);
  assert.equal(page.hrNotifyRecoveryTimer, null);
  assert.equal(page.rscSilentTimer, null);
  t.mock.timers.tick(10000);
  await flushAsync(); await flushAsync();
  assert.equal(hrChar.startNotificationsCalls, hrStartsBeforeBlur,
    'blur 期不发新的 HRS startNotifications');
  assert.equal(rscChar.stopNotificationsCalls, rscStopsBeforeBlur,
    'blur 期不因静默计时器退役健康 GATT 上的 RSC');
  assert.equal(page.hrNotifyRecoveryCount, 0, 'blur 期不消耗 HRS 恢复预算');

  // 通知数据可在 blur 期更新健康性，但不得由此启动新的原生调用。
  rscChar.notify({ speedMps: 2.8, cadenceSpm: 176, running: true });
  hrChar.notify(127);
  // 保持 HRS 新鲜，单独模拟宿主仍要求重新武装 CCCD；这样后续
  // RSC 静默退役的断言不会被“HR/RSC 同时过期”的正常统一断链干扰。
  page.hrDegradedByRsc = true;
  assert.equal(page.rscSilentTimer, null);
  page.onHostFocus();
  assert.ok(page.hrNotifyRecoveryTimer, 'focus 后恢复已需要的 HRS 单路恢复');
  assert.ok(page.rscSilentTimer, 'focus 后以最新合法 2A53 包重新武装静默诊断');

  t.mock.timers.tick(1000);
  await flushAsync(); await flushAsync();
  assert.equal(hrChar.startNotificationsCalls, hrStartsBeforeBlur + 1);
  assert.equal(page.hrNotifyRecoveryCount, 1);
  assert.equal(device.gatt.disconnectCalls, 0);

  t.mock.timers.tick(1600);
  await flushAsync(); await flushAsync();
  assert.ok(rscChar.stopNotificationsCalls > rscStopsBeforeBlur,
    'focus 后 RSC 真的持续静默才会独立退役 2A53');
  assert.equal(device.gatt.disconnectCalls, 0,
    'RSC 静默退役仍不能拆共享 HRS/GATT');
});

test('AIUI 0.16.1 blur 不消耗 HUD 重连预算，focus 后只恢复已保留目标', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const { device } = fakeHrDevice('fenix 8');
  let connectCalls = 0;
  const originalConnect = device.gatt.connect.bind(device.gatt);
  device.gatt.connect = async () => {
    connectCalls += 1;
    return originalConnect();
  };
  page.onLoad();
  makeRunning(page);
  page.stopTicker();
  page.reconnectDevice = device;
  page.setData({ bleState: 'idle' });

  page.onHostBlur();
  assert.equal(page.scheduleHudReconnect(device), false);
  assert.equal(page.hudReconnectTimer, null);
  t.mock.timers.tick(10000);
  assert.equal(connectCalls, 0);
  assert.equal(page.hudReconnectCount, 0);
  assert.equal(page.reconnectDevice, device);

  page.onHostFocus();
  assert.ok(page.hudReconnectTimer);
  t.mock.timers.tick(4100);
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(connectCalls, 1);
  assert.equal(page.hudReconnectCount, 1);
  assert.equal(page.data.bleState, 'connected');
});

test('方向重复按键收敛 220ms，迟到方向别名在 600ms 内仍只算一次滑动', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const aliasDelayMs of [250, 400, 599]) {
    const page = freshPage();
    page.onLoad({ mode: 'menu' });
    pagesToClean.push(page);
    page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
    t.mock.timers.tick(aliasDelayMs);
    page.onKeyUp({ code: 'ArrowRight', preventDefault() {} });
    assert.equal(
      page.menuFocusIndex,
      1,
      `Down→Right 间隔 ${aliasDelayMs}ms 仍属于一次前划，不能跳过超慢跑`,
    );
  }

  const repeated = freshPage();
  repeated.onLoad({ mode: 'menu' });
  pagesToClean.push(repeated);
  repeated.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  t.mock.timers.tick(20);
  repeated.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(repeated.menuFocusIndex, 1, '220ms 内同键重复只移动一次');
  t.mock.timers.tick(201);
  repeated.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(repeated.menuFocusIndex, 2, '距已接受方向超过 220ms 的同键可作为下一次滑动');
});

test('220ms 内相反方向是用户纠正动作，不应被同向别名去重吞掉', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);

  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 1);
  t.mock.timers.tick(20);
  page.onKeyUp({ code: 'ArrowUp', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 0, '相反语义应立即循环回自由跑');
});

test('首页确认入场会隔离所有尾随确认；方向选择吞掉 600ms 内释放尾包', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const page = freshPage();
  page.onLoad({ mode: 'menu', inputGuard: '1' });
  pagesToClean.push(page);
  let prevented = false;
  page.onKeyUp({ code: 'Enter', preventDefault() { prevented = true; } });
  page.onKeyUp({ code: 'GlobalHook', preventDefault() { prevented = true; } });
  assert.equal(prevented, true, '尾随确认仍须阻止宿主默认激活');
  assert.equal(page.data.surfacePhase, 'menu');
  assert.equal(page.lastSurfaceConfirmKeyMs, null, '上一页尾包不得污染本页去重时间戳');

  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 1);
  assert.equal(page.menuEntryConfirmGuardUntilMs, null);
  t.mock.timers.tick(601);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 2);
  t.mock.timers.tick(601);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 3);
  t.mock.timers.tick(601);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 4);
  t.mock.timers.tick(200);
  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  assert.equal(page.data.surfacePhase, 'menu', '200ms 内的确认尾包不得立即选中');
  assert.equal(page.openSettingsMode(), false, '方向释放期的 TouchEnd/bindtap 必须被保护吞掉');
  t.mock.timers.tick(401);
  page.onKeyUp({ code: 'NumpadEnter', preventDefault() {} });
  assert.equal(page.data.surfacePhase, 'settings', '完整方向手势保护后的独立确认应进入设置');

  const touched = freshPage();
  touched.onLoad({ mode: 'menu', inputGuard: '1' });
  pagesToClean.push(touched);
  assert.equal(touched.openSettingsMode(), false, 'TouchEnd/bindtap 尾包也必须被入场保护吞掉');
  assert.equal(touched.data.surfacePhase, 'menu');
  touched.menuEntryConfirmGuardUntilMs = Date.now() - 1;
  assert.equal(touched.openSettingsMode(), true);
  assert.equal(touched.data.surfacePhase, 'settings', '保护期后的独立触摸仍正常生效');
});

test('GlobalHook 先于前后划到达时只移动焦点，不会抢先进入自由跑', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);

  let prevented = 0;
  page.onKeyUp({ code: 'GlobalHook', preventDefault() { prevented += 1; } });
  assert.equal(page.data.surfacePhase, 'menu', '提前 GlobalHook 只进入待判定状态');
  assert.equal(page.openFreeMode(), false, '待判定期间宿主旧焦点 bindtap 必须被吞掉');

  t.mock.timers.tick(500);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() { prevented += 1; } });
  assert.equal(page.menuFocusIndex, 1, '方向码延迟 500ms 仍应向前划到超慢跑');
  assert.equal(page.data.surfacePhase, 'menu');
  t.mock.timers.tick(100);
  assert.equal(page.data.surfacePhase, 'menu', '已取消的 GlobalHook 定时确认不得复活');
  assert.equal(page.openFreeMode(), false, '方向手势尾包不得激活自由跑');

  page.onKeyUp({ code: 'GlobalHook', preventDefault() { prevented += 1; } });
  page.onKeyUp({ code: 'ArrowUp', preventDefault() { prevented += 1; } });
  assert.equal(page.menuFocusIndex, 0, '向后划回到自由跑');
  t.mock.timers.tick(601);
  page.onKeyUp({ code: 'ArrowRight', preventDefault() { prevented += 1; } });
  assert.equal(page.menuFocusIndex, 1, '向右与向前划语义一致');
  t.mock.timers.tick(601);
  page.onKeyUp({ code: 'ArrowLeft', preventDefault() { prevented += 1; } });
  assert.equal(page.menuFocusIndex, 0, '向左与向后划语义一致');
  assert.equal(prevented, 6);
});

test('多目标页独立 GlobalHook 延迟确认当前页面焦点，并在离页时清理', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  page.setMenuFocus(4);

  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  t.mock.timers.tick(599);
  assert.equal(page.data.surfacePhase, 'menu');
  t.mock.timers.tick(1);
  assert.equal(page.data.surfacePhase, 'settings', '独立轻拍才确认设置焦点');

  releaseSurfaceGesture(page);
  page.onKeyUp({ code: 'Backspace', preventDefault() {} });
  assert.equal(page.data.surfacePhase, 'menu');
  page.setMenuFocus(4);
  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  page.onHide();
  t.mock.timers.tick(600);
  assert.equal(page.data.surfacePhase, 'menu', '隐藏后迟到定时器不得复活页面动作');
});

test('首页确认入场保护到期后，首次确认只进入自由跑设备搜索', () => {
  const page = freshPage();
  page.onLoad({ mode: 'menu', inputGuard: '1' });
  pagesToClean.push(page);
  page.menuEntryConfirmGuardUntilMs = Date.now() - 1;
  page.onKeyUp({ code: 'Enter', preventDefault() {} });
  assert.equal(page.data.surfacePhase, 'ready');
  assert.equal(page.data.primaryLabel, '开始搜索');
  assert.equal(page.runMode, 'free');
});

test('AI 总结与长期记忆处理始终开启且不进入设置焦点，说明行保持不可交互', () => {
  const page = freshPage();
  wx.store.set('run_settings', {
    strideM: 0.85,
    autoHeartRate: true,
    voiceCue: true,
    aiSummary: false,
    memoryContext: false,
  });
  page.onLoad({ mode: 'settings' });
  pagesToClean.push(page);
  assert.equal(page.runSettings.aiSummary, true, '旧关闭值在加载时迁移为始终开启');
  assert.equal(page.runSettings.memoryContext, true, '旧关闭值在加载时迁移为始终开启');
  assert.equal(wx.store.get('run_settings').aiSummary, true);
  assert.equal(wx.store.get('run_settings').memoryContext, true);

  releaseSurfaceGesture(page);
  assert.equal(page.onSettingTap({
    currentTarget: { dataset: { setting: 'summary', index: 3 } },
  }), false, 'AI 总结不再是可切换设置');
  releaseSurfaceGesture(page);
  assert.equal(page.onSettingTap({
    currentTarget: { dataset: { setting: 'memory', index: 4 } },
  }), false, '长期记忆说明行不响应设置激活');
  assert.equal(page.runSettings.aiSummary, true);
  assert.equal(page.runSettings.memoryContext, true);

  const settingsMarkup = runHudSource.match(
    /<view class="settings-list"[\s\S]*?<\/view>\s*<text class="settings-foot">/,
  );
  assert.ok(settingsMarkup, '设置列表模板存在');
  assert.equal((settingsMarkup[0].match(/<button\b/g) || []).length, 7,
    '设置页包含六个设置按钮和一个明确返回按钮');
  assert.match(settingsMarkup[0], /长期记忆/);
  assert.match(settingsMarkup[0], /需配置后端/);
  assert.doesNotMatch(settingsMarkup[0], /EverMind/);
});

test('节拍器设置按关闭→160→170→180→关闭循环，逐项持久化并即时试听', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  FakeSound.instances = [];
  globalThis.Sound = FakeSound;
  wx.store.set('run_settings', {
    strideM: 0.85,
    autoHeartRate: true,
    voiceCue: true,
    aiSummary: true,
    memoryContext: true,
    metronomeBpm: 0,
  });
  page.onLoad({ mode: 'settings' });
  assert.equal(page.data.settingMetronome, '关闭');

  const cycle = [160, 170, 180, 0];
  const expectedSources = {
    160: '../../assets/audio/metro_0468_bar_160.wav',
    170: '../../assets/audio/metro_0468_bar_170.wav',
    180: '../../assets/audio/metro_0468_bar_180.wav',
  };
  let previousSound = null;
  for (const bpm of cycle) {
    releaseSurfaceGesture(page);
    assert.equal(page.onSettingTap({
      currentTarget: { dataset: { setting: 'metronome', index: 2 } },
    }), true);
    assert.equal(page.runSettings.metronomeBpm, bpm);
    assert.equal(wx.store.get('run_settings').metronomeBpm, bpm);
    assert.equal(page.data.settingMetronome, bpm > 0 ? `${bpm} BPM` : '关闭');
    assert.equal(page.settingFocusIndex, 2);
    assert.match(page.data.settingMetronomeClass, /setting-row-focused/);
    const sound = FakeSound.instances.at(-1);
    assert.ok(sound, '首次开启时创建本地节拍音');
    if (bpm > 0) {
      assert.equal(sound.src, expectedSources[bpm]);
      assert.ok(sound.playCalls >= 1, `${bpm} BPM 应立即试听`);
      if (previousSound) {
        assert.equal(previousSound.destroyCalls, 1,
          '切换 BPM 必须释放旧速率音轨，不能按新间隔播放旧小节');
      }
      previousSound = sound;
    } else {
      assert.ok(sound.stopCalls >= 1, '切回关闭立即停止试听');
    }
  }
  assert.equal(FakeSound.instances.length, 3, '三个非关闭档各创建一条对应四拍音轨');
});

test('节拍器试听只在本次档位确认后播放；Arrow、原生 focus 或 tap 离开都立即停止', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  FakeSound.instances = [];
  globalThis.Sound = FakeSound;
  wx.store.set('run_settings', {
    strideM: 0.85,
    autoHeartRate: true,
    voiceCue: true,
    aiSummary: true,
    memoryContext: true,
    metronomeBpm: 0,
  });
  page.onLoad({ mode: 'settings' });

  const confirmMetronome = (expectedBpm) => {
    releaseSurfaceGesture(page);
    assert.equal(page.onSettingTap({
      currentTarget: { dataset: { setting: 'metronome', index: 2 } },
    }), true);
    assert.equal(wx.store.get('run_settings').metronomeBpm, expectedBpm);
  };

  confirmMetronome(160);
  let sound = FakeSound.instances.at(-1);
  assert.equal(sound.src, '../../assets/audio/metro_0468_bar_160.wav');
  assert.ok(sound.playCalls >= 1);

  // 宿主原生焦点事件离开：停止试听，但不能把已选档位改回关闭。
  const stopsBeforeFocus = sound.stopCalls;
  page.onSettingFocus({ currentTarget: { dataset: { index: 1 } } });
  assert.ok(sound.stopCalls > stopsBeforeFocus, 'focus 离开节拍器必须立即停止');
  assert.equal(wx.store.get('run_settings').metronomeBpm, 160);
  const playsBeforeFocusReturn = sound.playCalls;
  page.onSettingFocus({ currentTarget: { dataset: { index: 2 } } });
  assert.equal(sound.playCalls, playsBeforeFocusReturn,
    '焦点回到节拍器只显示已保存档位，不自动重播');

  // 再次确认才切到下一档并试听；随后点按其他设置也必须停止。
  confirmMetronome(170);
  assert.equal(sound.destroyCalls, 1, '切换档位释放 160 BPM 音轨');
  sound = FakeSound.instances.at(-1);
  assert.equal(sound.src, '../../assets/audio/metro_0468_bar_170.wav');
  assert.ok(sound.playCalls >= 1);
  const stopsBeforeTap = sound.stopCalls;
  releaseSurfaceGesture(page);
  assert.equal(page.onSettingTap({
    currentTarget: { dataset: { setting: 'voice', index: 1 } },
  }), true);
  assert.ok(sound.stopCalls > stopsBeforeTap, 'tap 其他设置项必须立即停止试听');
  assert.equal(wx.store.get('run_settings').metronomeBpm, 170,
    '离开焦点不改变已保存 BPM');

  const playsBeforeTapReturn = sound.playCalls;
  page.onSettingFocus({ currentTarget: { dataset: { index: 2 } } });
  assert.equal(sound.playCalls, playsBeforeTapReturn,
    'tap 离开后重新聚焦也不能自动试听');
  const playsBeforeThirdConfirm = sound.playCalls;
  confirmMetronome(180);
  assert.equal(sound.destroyCalls, 1, '切换档位释放 170 BPM 音轨');
  sound = FakeSound.instances.at(-1);
  assert.equal(sound.src, '../../assets/audio/metro_0468_bar_180.wav');
  assert.ok(sound.playCalls >= 1);
  assert.ok(playsBeforeThirdConfirm >= 1);

  // 触摸板/方向键路径同样停止；方向返回 index2 仍不自动播放。
  const stopsBeforeArrow = sound.stopCalls;
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.settingFocusIndex, 3);
  assert.ok(sound.stopCalls > stopsBeforeArrow, 'Arrow 离开节拍器必须立即停止');
  assert.equal(wx.store.get('run_settings').metronomeBpm, 180);
  const playsBeforeArrowReturn = sound.playCalls;
  releaseDirectionGesture(page);
  page.onKeyUp({ code: 'ArrowUp', preventDefault() {} });
  assert.equal(page.settingFocusIndex, 2);
  assert.equal(sound.playCalls, playsBeforeArrowReturn,
    'Arrow 返回节拍器不得自动重播');
});

test('跑中节拍器持有音频焦点时跳过非安全 TTS；停拍和总结仍可播报', () => {
  FakeSound.instances = [];
  const page = freshPage();
  pagesToClean.push(page);
  globalThis.Sound = FakeSound;
  wx.store.set('run_settings', {
    strideM: 0.85,
    autoHeartRate: true,
    voiceCue: true,
    aiSummary: true,
    memoryContext: true,
    metronomeBpm: 170,
  });
  page.onLoad();
  makeRunning(page);
  page.stopTicker();

  assert.equal(page.metronome.running, true);
  const beforeFocusedCue = wx.ttsSpoken.length;
  page.speakCue('保持节奏');
  assert.equal(page.data.coachLine, '保持节奏', '提示文字仍应正常上屏');
  assert.equal(wx.ttsSpoken.length, beforeFocusedCue,
    '跑中节拍器播放时不得让非必要 TTS 抢音频焦点');

  page.stopMetronomePlayback();
  assert.equal(page.playCueTts('语音恢复'), true);
  assert.equal(wx.ttsSpoken.at(-1), '语音恢复');

  assert.equal(page.startRunMetronome(), true);
  page.setData({ surfacePhase: 'summary' });
  assert.equal(page.playCueTts('总结播报'), true,
    '总结阶段不属于跑中节拍音频焦点，应允许播报');
  assert.equal(wx.ttsSpoken.at(-1), '总结播报');
});

test('Z5 提示先可见再抢占节拍音频，播报后只恢复同一 Metronome 实例', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  FakeSound.instances = [];
  const page = freshPage();
  t.after(() => page.onUnload());
  globalThis.Sound = FakeSound;
  wx.store.set('run_settings', {
    strideM: 0.85,
    autoHeartRate: true,
    voiceCue: true,
    aiSummary: true,
    memoryContext: true,
    metronomeBpm: 170,
  });
  page.onLoad();
  makeRunning(page);
  page.stopTicker();
  const metronome = page.metronome;
  const sound = FakeSound.instances[0];
  assert.ok(metronome && sound);
  assert.equal(metronome.running, true);

  page.setData({ bleState: 'connected' });
  page.lastHrAtMs = Date.now();
  page.session.onHeartRate(190);
  page.frozenHeartRatePolicy = {
    schema_version: 1,
    max_hr_bpm: 190,
    source: 'user_explicit',
    issued_at_ms: Date.now() - 1000,
    expires_at_ms: Date.now() + 60_000,
  };
  page.prevCue = {
    zone: 4,
    elapsedMs: 0,
    distanceM: 0,
    cadenceSpm: 0,
    paceSecPerKm: null,
    heartRateMaxHrBpm: 190,
    heartRatePolicySource: 'user_explicit',
  };
  page.tick();

  assert.equal(page.data.safetyHudHint, '心率 Z5 · 请降速');
  assert.match(runHudSource, /ink:if="\{\{ safetyHudHint \}\}">\{\{ safetyHudHint \}\}/,
    'Z5 文案必须绑定可见 HUD 位');
  assert.equal(wx.ttsSpoken.at(-1), '心率 Z5 了，降速深呼吸。');
  assert.equal(metronome.running, false, '安全语音窗先暂停节拍');
  assert.equal(page.safetyMetronomeResumePending, true);
  assert.equal(FakeSound.instances.length, 1);

  const playsBeforeResume = sound.playCalls;
  t.mock.timers.tick(6000);
  assert.equal(page.metronome, metronome, '恢复必须复用原 Metronome');
  assert.equal(FakeSound.instances.length, 1, '不得重建第二个 Sound 实例');
  assert.equal(metronome.running, true);
  assert.ok(sound.playCalls > playsBeforeResume);

  page.playCueTts('还在 Z5，先降下来。', { safety: true });
  assert.equal(metronome.running, false);
  page.onHide();
  t.mock.timers.tick(6000);
  assert.equal(metronome.running, false,
    '隐藏已终止安全恢复代次，迟到 timer 不得复活节拍');
});

test('阶段训练心率高风险优先于配速和步频提示', () => {
  const page = freshPage();
  pagesToClean.push(page);
  page.workoutExecution = {
    status: 'running',
    stage_index: 0,
    plan: {
      stages: [{
        pace_min_sec_per_km: 360,
        pace_max_sec_per_km: 420,
        heart_zone_min: 2,
        heart_zone_max: 3,
        cadence_min_spm: 170,
        cadence_max_spm: 185,
      }],
    },
  };
  page.frozenHeartRatePolicy = {
    schema_version: 1,
    max_hr_bpm: 190,
    source: 'user_explicit',
    issued_at_ms: Date.now() - 1000,
    expires_at_ms: Date.now() + 60_000,
  };

  assert.equal(page.workoutIntensityHint({
    bpm: 190,
    heartZone: 5,
    paceSec: 390,
    cadenceSpm: 178,
  }), '心率过高 · 请降速');
  assert.equal(page.workoutIntensityHint({
    bpm: 170,
    heartZone: 4,
    paceSec: 390,
    cadenceSpm: 178,
  }), '心率偏高');
  assert.equal(page.workoutIntensityHint({
    bpm: 135,
    heartZone: 2,
    paceSec: 330,
    cadenceSpm: 178,
  }), '配速偏快', '心率在目标内后才评估配速');
});

test('缺失策略不点区间；估算策略点亮中性区间但不输出积极强度建议', () => {
  const page = freshPage();
  pagesToClean.push(page);
  page.workoutExecution = {
    status: 'running',
    stage_index: 0,
    plan: {
      stages: [{
        pace_min_sec_per_km: null,
        pace_max_sec_per_km: null,
        heart_zone_min: 2,
        heart_zone_max: 3,
        cadence_min_spm: null,
        cadence_max_spm: null,
      }],
    },
  };

  page.frozenHeartRatePolicy = null;
  assert.equal(page.hudModeFields({ connected: true }).modeLabel, '心率记录');
  assert.equal(page.runHeartRateZone(150), 0);
  assert.equal(page.workoutIntensityHint({ bpm: 150, heartZone: 0 }), '');
  assert.equal(
    page.workoutIntensityHint({ bpm: 170, heartZone: 0 }),
    '心率偏高 · 请降速',
  );

  page.frozenHeartRatePolicy = {
    schema_version: 1,
    max_hr_bpm: 200,
    source: 'age_estimate',
    issued_at_ms: Date.now() - 1000,
    expires_at_ms: Date.now() + 60_000,
  };
  assert.equal(page.hudModeFields({ connected: true }).modeLabel, '估算区间',
    '年龄估算复用既有状态 chip 明示来源，不新增 480x352 HUD 元素');
  assert.equal(page.runHeartRateZone(150), 3,
    '年龄估算可点亮中性五区，150/200 应位于 Z3');
  assert.equal(page.workoutIntensityHint({
    bpm: 150,
    heartZone: page.runHeartRateZone(150),
  }), '');
  assert.equal(
    page.workoutIntensityHint({
      bpm: 170,
      heartZone: page.runHeartRateZone(170),
    }),
    '心率偏高 · 请降速',
  );

  page.frozenHeartRatePolicy = {
    schema_version: 1,
    max_hr_bpm: 180,
    source: 'conservative_default',
    issued_at_ms: Date.now() - 1000,
    expires_at_ms: Date.now() + 60_000,
  };
  assert.equal(page.hudModeFields({ connected: true }).modeLabel, '估算区间',
    '通用默认值必须明确标为估算区间，不伪装成可信个体策略');
  page.frozenHeartRatePolicy = {
    ...page.frozenHeartRatePolicy,
    max_hr_bpm: 190,
    source: 'user_explicit',
  };
  assert.equal(page.hudModeFields({ connected: true }).modeLabel, '心率接入');
  assert.match(runHudSource,
    /class="mode-chip" ink:if="\{\{ showHeartRate \}\}">\{\{ modeLabel \}\}<\/text>/,
    '状态 chip 使用既有 modeLabel，不增加 HUD 行或交互目标');
});

test('设备搜索配置后进入跑前热身，四项归零自动且仅一次启动 HUD', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  let scanCalls = 0;
  globalThis.navigator = {
    bluetooth: {
      async scanDevices() {
        scanCalls += 1;
        return { onDeviceFound() {}, async stop() {} };
      },
    },
  };
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  ensureTestRunOwner();
  const startRun = page.startRun.bind(page);
  let startRunCalls = 0;
  page.startRun = () => {
    startRunCalls += 1;
    return startRun();
  };

  assert.equal(page.openFreeMode(), true);
  t.mock.timers.tick(0);
  assert.equal(page.data.surfacePhase, 'ready');
  assert.equal(page.data.primaryLabel, '开始搜索');
  assert.equal(page.data.running, false);
  assert.equal(scanCalls, 0, '进入 02 不能自动扫描');

  releaseSurfaceGesture(page);
  assert.equal(page.onConnectTap(), true, '设备配置完成后下一步进入热身');
  t.mock.timers.tick(0);
  assert.equal(page.data.surfacePhase, 'pre_run');
  assert.equal(page.timedGuideKind, 'pre_run');
  assert.equal(page.data.recoveryHeading, '跑前热身');
  assert.equal(page.data.recoveryOverview, '4项 · 每项15秒 · 共1分钟');
  assert.equal(page.data.recoveryCountdown, '15');
  assert.equal(page.recoveryIndex, 0);
  assert.equal(page.data.recoveryImage, '../../assets/warmup/march.gif');
  assert.equal(page.data.running, false);
  assert.equal(scanCalls, 0, '热身期不得重新启动附近扫描');
  assert.ok(wx.ttsSpoken.some((line) => line.includes('跑前热身共四个动作')));

  t.mock.timers.tick(15_000);
  assert.equal(page.recoveryIndex, 1);
  assert.equal(page.data.recoveryCountdown, '15');
  assert.equal(page.data.recoveryImage, '../../assets/warmup/calf-raise.gif');
  t.mock.timers.tick(15_000);
  assert.equal(page.recoveryIndex, 2);
  assert.equal(page.data.recoveryImage, '../../assets/warmup/butt-kick.gif');
  t.mock.timers.tick(15_000);
  assert.equal(page.recoveryIndex, 3);
  assert.equal(page.data.recoveryImage, '../../assets/warmup/lateral-shift.gif');
  t.mock.timers.tick(15_000);
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.data.running, true);
  assert.equal(page.entrySequenceCompleted, true);
  assert.equal(page.timedGuideKind, null);
  assert.equal(page.recoveryCountdownActive, false);
  assert.equal(startRunCalls, 1, '归零只能创建一次跑步会话');
  assert.equal(scanCalls, 0);
  t.mock.timers.tick(1000);
  assert.equal(startRunCalls, 1, '归零后的迟到 tick 不得重复开跑');
  assert.equal(scanCalls, 0, '热身完成进入 HUD 也不能复活附近扫描');
  page.onHide();
});

test('跑前热身末秒手动开跑与归零 tick 竞态仅启动一次', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  ensureTestRunOwner();
  page.runSettings = { ...page.runSettings, guideQuickExit: true };

  const startRun = page.startRun.bind(page);
  let startRunCalls = 0;
  page.startRun = () => {
    startRunCalls += 1;
    return startRun();
  };

  assert.equal(page.openFreeMode(), true);
  releaseSurfaceGesture(page);
  assert.equal(page.onConnectTap(), true);
  t.mock.timers.tick(0);
  t.mock.timers.tick(15_000);
  t.mock.timers.tick(15_000);
  t.mock.timers.tick(15_000);
  t.mock.timers.tick(14_750);
  assert.equal(page.data.surfacePhase, 'pre_run');
  assert.equal(page.recoveryIndex, 3);
  assert.equal(page.data.recoveryCountdown, '1');

  releaseSurfaceGesture(page);
  assert.equal(page.onRecoveryTap(), true, '最后一秒仍允许用户立即开跑');
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.data.running, true);
  assert.equal(startRunCalls, 1);

  t.mock.timers.tick(1000);
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(startRunCalls, 1, '已被手动开跑取消的归零 tick 不得再启动');
  page.onHide();
});

test('跑前热身自动开跑失败停在完成态，由用户确认重试且不自旋', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  ensureTestRunOwner();

  const startRun = page.startRun.bind(page);
  let startRunCalls = 0;
  page.startRun = () => {
    startRunCalls += 1;
    if (startRunCalls === 1) throw new Error('test start failure');
    return startRun();
  };

  assert.equal(page.openFreeMode(), true);
  releaseSurfaceGesture(page);
  assert.equal(page.onConnectTap(), true);
  t.mock.timers.tick(0);
  t.mock.timers.tick(15_000);
  t.mock.timers.tick(15_000);
  t.mock.timers.tick(15_000);
  t.mock.timers.tick(15_000);

  assert.equal(startRunCalls, 1);
  assert.equal(page.data.surfacePhase, 'pre_run');
  assert.equal(page.data.running, false);
  assert.equal(page.entrySequenceCompleted, false);
  assert.equal(page.recoveryGuideCompleted, true);
  assert.equal(page.data.recoveryCountdown, '完成');
  assert.equal(page.data.recoveryAutoHint, '训练记录读取失败 · 请再次确认');
  assert.equal(page.data.recoveryActionLabel, '重试开跑');

  t.mock.timers.tick(5000);
  assert.equal(startRunCalls, 1, '失败后不得无限自动重试');
  releaseSurfaceGesture(page);
  assert.equal(page.onRecoveryTap(), true);
  assert.equal(startRunCalls, 2);
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.data.running, true);
  page.onHide();
});

test('跑前热身隐藏时暂停、恢复后续计，Back 从首项回设备搜索', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);

  assert.equal(page.openFreeMode(), true);
  releaseSurfaceGesture(page);
  assert.equal(page.onConnectTap(), true);
  t.mock.timers.tick(0);
  t.mock.timers.tick(5_000);
  const remainingAtHide = page.recoveryCountdownRemainingSec;
  const spokenAtHide = wx.ttsSpoken.length;
  page.onHide();
  assert.ok(remainingAtHide >= 9 && remainingAtHide <= 10);
  t.mock.timers.tick(30_000);
  assert.equal(page.recoveryIndex, 0);
  assert.equal(page.recoveryCountdownRemainingSec, remainingAtHide);
  assert.equal(wx.ttsSpoken.length, spokenAtHide);

  page.onShow();
  assert.equal(page.recoveryCountdownActive, true);
  t.mock.timers.tick(remainingAtHide * 1000);
  assert.equal(page.recoveryIndex, 1, '恢复后从保留秒数续计');

  releaseSurfaceGesture(page);
  assert.equal(page.onRecoveryBack(), true);
  assert.equal(page.data.surfacePhase, 'pre_run');
  assert.equal(page.recoveryIndex, 0, '非首项 Back 先回上一项');
  let prevented = false;
  page.onKeyUp({ code: 'Backspace', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(page.data.surfacePhase, 'ready');
  assert.equal(page.data.primaryLabel, '下一步');
  assert.match(page.data.scanDiagnostic, /设备配置已保留/);
  assert.equal(page.timedGuideKind, null);
  assert.equal(page.recoveryCountdownActive, false);
  const spokenAfterBack = wx.ttsSpoken.length;
  t.mock.timers.tick(30_000);
  assert.equal(wx.ttsSpoken.length, spokenAfterBack, '返回搜索后不得派发迟到 TTS');
});

test('跑前热身末项隐藏暂停，恢复倒计时归零后自动开跑', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  ensureTestRunOwner();

  const startRun = page.startRun.bind(page);
  let startRunCalls = 0;
  page.startRun = () => {
    startRunCalls += 1;
    return startRun();
  };

  assert.equal(page.openFreeMode(), true);
  releaseSurfaceGesture(page);
  assert.equal(page.onConnectTap(), true);
  t.mock.timers.tick(0);
  t.mock.timers.tick(15_000);
  t.mock.timers.tick(15_000);
  t.mock.timers.tick(15_000);
  t.mock.timers.tick(5_000);
  assert.equal(page.recoveryIndex, 3);
  assert.equal(page.data.recoveryCountdown, '10');

  page.onHide();
  const remainingAtHide = page.recoveryCountdownRemainingSec;
  assert.equal(remainingAtHide, 10);
  t.mock.timers.tick(30_000);
  assert.equal(page.data.surfacePhase, 'pre_run');
  assert.equal(page.recoveryCountdownRemainingSec, remainingAtHide);
  assert.equal(startRunCalls, 0, '隐藏期间不得偷跑倒计时或开跑');

  page.onShow();
  assert.equal(page.recoveryCountdownActive, true);
  t.mock.timers.tick(remainingAtHide * 1000);
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.data.running, true);
  assert.equal(startRunCalls, 1);
  t.mock.timers.tick(1000);
  assert.equal(startRunCalls, 1);
  page.onHide();
});

test('跑后恢复入场只播一条四项总览加第一项，自动换步播序号，隐藏会取消未发出的语音', async () => {
  const page = boot();
  page.summaryEnteredAtMs = Date.now();
  page.setData({ surfacePhase: 'summary' });

  assert.equal(page.startRecoveryGuide(), true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(page.data.recoveryOverview, '4项 · 每项15秒 · 共1分钟');
  assert.equal(wx.ttsSpoken.length, 1);
  assert.match(wx.ttsSpoken[0], /四个动作/);
  assert.match(wx.ttsSpoken[0], /第一项/);
  assert.match(wx.ttsSpoken[0], /十五秒/);

  releaseSurfaceGesture(page);
  assert.equal(page.onRecoveryTap(), false,
    '默认关闭快速结束时，单击不应跳过当前动作');
  assert.equal(page.advanceRecoveryStep({ automatic: true }), true);
  await new Promise((resolve) => setTimeout(resolve, 370));
  assert.equal(wx.ttsSpoken.length, 2);
  assert.match(wx.ttsSpoken[1], /第二项/);
  assert.doesNotMatch(wx.ttsSpoken[1], /四个动作/);

  releaseSurfaceGesture(page);
  assert.equal(page.advanceRecoveryStep({ automatic: true }), true);
  page.onHide();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(wx.ttsSpoken.length, 2,
    '页面隐藏后，尚未派发的第三项语音必须被生命周期代次取消');
});

test('指导快速结束开启时整段指导不派发系统 TTS，单击直达放松完成选择', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = boot();
  page.runSettings = { ...page.runSettings, guideQuickExit: true };
  page.summaryEnteredAtMs = Date.now();
  page.setData({ surfacePhase: 'summary' });

  assert.equal(page.startRecoveryGuide(), true);
  t.mock.timers.tick(1000);
  assert.equal(page.data.guideQuickExitEnabled, true);
  assert.equal(page.data.recoveryActionLabel, '快速完成');
  assert.equal(wx.ttsSpoken.length, 0,
    '允许任意时刻快速离开时不得派发无法取消的 TTS');

  releaseSurfaceGesture(page);
  assert.equal(page.onRecoveryTap(), true);
  assert.equal(page.recoveryGuideCompleted, true);
  assert.equal(page.data.recoveryChoiceVisible, true);
  assert.equal(page.data.surfacePhase, 'recovery');
  t.mock.timers.tick(1000);
  assert.equal(wx.ttsSpoken.length, 0, '快速完成后不得追播上一页语音');
});

test('跑后恢复按绝对时间倒计时自动换四项，换边只播一次且末三秒不派发无法取消的 TTS', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = boot();
  page.summaryEnteredAtMs = Date.now();
  page.setData({ surfacePhase: 'summary' });

  assert.equal(page.startRecoveryGuide(), true);
  t.mock.timers.tick(0);
  assert.equal(page.data.recoveryCountdown, '15');
  assert.equal(page.recoveryIndex, 0);

  t.mock.timers.tick(12000);
  assert.equal(page.data.recoveryCountdown, '3');
  assert.equal(wx.ttsSpoken.filter((line) => line.includes('三。二。一。')).length, 0);

  t.mock.timers.tick(3000);
  assert.equal(page.recoveryIndex, 1);
  assert.equal(page.data.recoveryCountdown, '15');
  t.mock.timers.tick(8000);
  assert.equal(wx.ttsSpoken.filter((line) => line.includes('换边')).length, 1);
  t.mock.timers.tick(7000);
  assert.equal(page.recoveryIndex, 2);
  t.mock.timers.tick(15000);
  assert.equal(page.recoveryIndex, 3);
  t.mock.timers.tick(15000);
  assert.equal(page.recoveryGuideCompleted, true);
  assert.equal(page.data.recoveryCountdown, '完成');
  assert.equal(page.data.recoveryAutoHint, '放松完成 · 请选择下一步');
  assert.equal(page.data.recoveryChoiceVisible, true);
  assert.equal(page.data.surfacePhase, 'recovery', '完成后等待用户确认，不突然关闭智能体');
  t.mock.timers.tick(250);
  assert.ok(wx.ttsSpoken.some((line) => line.includes('放松完成')));
  page.onHide();
});

test('放松完成二选一可前后循环，拒绝滑动后的迟到焦点并分别进入总结或退出', () => {
  const summaryPage = boot();
  summaryPage.summaryEnteredAtMs = Date.now();
  summaryPage.setData({ surfacePhase: 'summary' });
  assert.equal(summaryPage.startRecoveryGuide(), true);
  summaryPage.cancelRecoveryCountdown();
  summaryPage.recoveryIndex = 3;
  assert.equal(summaryPage.finishRecoveryCountdown(), true);
  summaryPage.surfaceEntryConfirmGuardUntilMs = Date.now() - 1;

  const swipeAt = Date.now();
  assert.equal(summaryPage.handleSurfaceDirection('ArrowDown', swipeAt, 'keyup'), true);
  assert.equal(summaryPage.recoveryCompletionFocusIndex, 1);
  assert.equal(summaryPage.data.recoveryExitClass, 'recovery-choice-focused');
  assert.equal(summaryPage.onRecoveryChoiceFocus({
    currentTarget: { dataset: { index: 0 } },
  }), false, '同一次滑动后的宿主迟到焦点不得弹回第一项');
  assert.equal(summaryPage.recoveryCompletionFocusIndex, 1);

  releaseDirectionGesture(summaryPage);
  assert.equal(summaryPage.handleSurfaceDirection('ArrowDown', Date.now(), 'keyup'), true);
  assert.equal(summaryPage.recoveryCompletionFocusIndex, 0, '两项应循环回查看总结');
  summaryPage.surfaceEntryConfirmGuardUntilMs = Date.now() - 1;
  summaryPage.lastSurfaceActivationAtMs = Date.now() - 1000;
  assert.equal(summaryPage.activateRecoveryCompletionFocused(), true);
  assert.equal(summaryPage.data.surfacePhase, 'summary');

  const exitPage = boot();
  exitPage.summaryEnteredAtMs = Date.now();
  exitPage.setData({ surfacePhase: 'summary' });
  assert.equal(exitPage.startRecoveryGuide(), true);
  exitPage.cancelRecoveryCountdown();
  exitPage.recoveryIndex = 3;
  assert.equal(exitPage.finishRecoveryCountdown(), true);
  exitPage.recoveryCompletionFocusIndex = 1;
  let exitReason = '';
  exitPage.closeAgentFromSummary = (reason) => {
    exitReason = reason;
    return true;
  };
  assert.equal(exitPage.activateRecoveryCompletionFocused(), true);
  assert.equal(exitReason, 'recovery-skip-summary');
});

test('总结页向前滑与日志上传 flight 解耦，可立即重新进入放松', () => {
  const page = boot();
  page.summaryEnteredAtMs = Date.now() - 1000;
  page.setData({ surfacePhase: 'summary' });
  page.summaryHermesFlight = new Promise(() => {});
  let prevented = false;
  page.onKeyUp({
    code: 'ArrowDown',
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(page.data.surfacePhase, 'recovery');
  assert.equal(page.recoveryIndex, 0);
  assert.equal(page.recoveryCountdownActive, true);
});

test('跑后恢复隐藏时暂停倒计时，恢复后续计且隐藏期间不切页不播音', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = boot();
  page.summaryEnteredAtMs = Date.now();
  page.setData({ surfacePhase: 'summary' });
  page.startRecoveryGuide();
  t.mock.timers.tick(0);
  t.mock.timers.tick(5000);
  const spokenBeforeHide = wx.ttsSpoken.length;

  page.onHide();
  const remainingAtHide = page.recoveryCountdownRemainingSec;
  assert.ok(remainingAtHide >= 9 && remainingAtHide <= 10);
  t.mock.timers.tick(30000);
  assert.equal(page.recoveryIndex, 0);
  assert.equal(page.recoveryCountdownRemainingSec, remainingAtHide);
  assert.equal(wx.ttsSpoken.length, spokenBeforeHide);

  page.onShow();
  assert.equal(page.recoveryCountdownActive, true);
  t.mock.timers.tick(remainingAtHide * 1000);
  assert.equal(page.recoveryIndex, 1);
  page.onHide();
});

test('节拍器随自由跑可见生命周期播放，隐藏停止、恢复续播、总结退出与卸载清理', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  FakeSound.instances = [];
  const page = freshPage();
  t.after(() => page.onUnload());
  globalThis.Sound = FakeSound;
  wx.store.set('run_settings', {
    strideM: 0.85,
    autoHeartRate: true,
    voiceCue: true,
    aiSummary: true,
    memoryContext: true,
    metronomeBpm: 170,
  });
  page.onLoad();
  makeRunning(page);
  page.stopTicker();

  const sound = FakeSound.instances[0];
  assert.ok(sound);
  assert.equal(sound.src, '../../assets/audio/metro_0468_bar_170.wav');
  assert.ok(sound.playCalls >= 1, '开跑立即播放已选节拍');
  const activityStoppedAt = runHudSource.indexOf(
    '} else if (activity.justDeactivated) {',
  );
  const activityStoppedEnd = runHudSource.indexOf(
    'const diagnostics = this.motionDiagnostics;',
    activityStoppedAt,
  );
  assert.ok(activityStoppedAt > 0 && activityStoppedEnd > activityStoppedAt);
  assert.doesNotMatch(
    runHudSource.slice(activityStoppedAt, activityStoppedEnd),
    /stopMetronomePlayback/,
    '短暂停步或活动门波动不能主动切断整场节拍器',
  );
  const beforeHideStops = sound.stopCalls;
  page.onHide();
  assert.ok(sound.stopCalls > beforeHideStops, '隐藏立即停止节拍');
  const beforeResumePlays = sound.playCalls;
  page.onShow();
  page.stopTicker();
  assert.ok(sound.playCalls > beforeResumePlays, '仍在跑步时恢复可见即续播');

  page.finishRunToSummary();
  assert.equal(page.data.surfacePhase, 'summary', '必须先提交总结首帧');
  assert.equal(sound.destroyCalls, 0, '首帧前不得触碰可能变慢的原生音频桥');
  t.mock.timers.tick(0);
  assert.equal(sound.destroyCalls, 1, '总结首帧后立即释放音频资源');
  page.closeAgentFromSummary();
  assert.equal(sound.destroyCalls, 1, '总结退出清理幂等且不重建音频');

  const unloadPage = freshPage();
  globalThis.Sound = FakeSound;
  wx.store.set('run_settings', {
    strideM: 0.85,
    autoHeartRate: true,
    voiceCue: true,
    aiSummary: true,
    memoryContext: true,
    metronomeBpm: 180,
  });
  unloadPage.onLoad();
  makeRunning(unloadPage);
  unloadPage.stopTicker();
  const unloadSound = FakeSound.instances.at(-1);
  assert.equal(unloadSound.src, '../../assets/audio/metro_0468_bar_180.wav');
  assert.ok(unloadSound.playCalls >= 1);
  unloadPage.onUnload();
  assert.equal(unloadSound.destroyCalls, 1, '直接卸载也必须释放音频资源');
});

test('真机 setData 状态镜像迟到时仍由同步 RunSession 启动和恢复节拍器', () => {
  const page = freshPage();
  pagesToClean.push(page);
  FakeSound.instances = [];
  globalThis.Sound = FakeSound;
  wx.store.set('run_settings', {
    strideM: 0.85,
    autoHeartRate: true,
    voiceCue: true,
    aiSummary: true,
    memoryContext: true,
    metronomeBpm: 180,
  });
  page.onLoad();
  page.onShow();

  // finishEntry 已提交 HUD setData，但真实宿主可在下一拍才更新 data 镜像。
  page.data.surfacePhase = 'ready';
  page.startRun();
  page.stopTicker();
  const sound = FakeSound.instances[0];
  assert.ok(sound);
  assert.equal(sound.src, '../../assets/audio/metro_0468_bar_180.wav');
  assert.ok(sound.playCalls >= 1,
    '不能因 surfacePhase/running 尚未回写而静默跳过开跑节拍');

  page.stopMetronomePlayback();
  const playsBeforeResume = sound.playCalls;
  page.session.pause(Date.now());
  page.data.paused = true;
  page.session.resume(Date.now());
  assert.equal(page.startRunMetronome(), true,
    '恢复后的同步 session 状态应优先于迟到的 paused UI 镜像');
  assert.ok(sound.playCalls > playsBeforeResume);
});

test('同一实体手势即使落到不同设置按钮，keyup 与 bindtap 也只能激活一次', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  page.onLoad({ mode: 'settings' });
  pagesToClean.push(page);
  const originalStride = page.runSettings.strideM;

  page.setSettingFocus(5);
  let prevented = false;
  page.onKeyUp({ code: 'GlobalHook', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(page.data.settingHeartRate, '开', 'GlobalHook 判别窗口内不得抢先激活');
  assert.equal(page.onSettingTap({
    currentTarget: { dataset: { setting: 'stride', index: 0 } },
  }), false, '宿主焦点落到另一个按钮时，尾随 bindtap 仍须被整手势门吞掉');
  assert.equal(page.runSettings.strideM, originalStride);
  t.mock.timers.tick(599);
  assert.equal(page.data.settingHeartRate, '开', '600ms 判别窗结束前不得抢先激活');
  t.mock.timers.tick(1);
  assert.equal(page.data.settingHeartRate, '关', '独立轻拍到期后激活页面自管焦点');

  releaseSurfaceGesture(page);
  assert.equal(page.onSettingTap({
    currentTarget: { dataset: { setting: 'stride', index: 0 } },
  }), true, '下一次独立手势仍可激活另一个按钮');
  assert.notEqual(page.runSettings.strideM, originalStride);
});

test('沉浸菜单与设置用完整确认键集合激活页面焦点，400ms 内重复键码去重', () => {
  const page = freshPage();
  page.onLoad({ mode: 'menu' });
  pagesToClean.push(page);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 1);
  releaseDirectionGesture(page);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 2);
  releaseDirectionGesture(page);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 3);
  releaseDirectionGesture(page);
  page.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(page.menuFocusIndex, 4);
  page.surfaceEntryConfirmGuardUntilMs = Date.now() - 1;
  let prevented = false;
  page.onKeyUp({ code: 'NumpadEnter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(page.data.surfacePhase, 'settings');

  const settings = freshPage();
  settings.onLoad({ mode: 'settings' });
  pagesToClean.push(settings);
  settings.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(settings.settingFocusIndex, 1);
  settings.surfaceEntryConfirmGuardUntilMs = Date.now() - 1;
  settings.onKeyUp({ code: 'Space', preventDefault() {} });
  assert.equal(settings.data.settingVoiceCue, '关');
  settings.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  assert.equal(settings.data.settingVoiceCue, '关', '同一物理确认的尾随键码不得二次切换');
  settings.setSettingFocus(6);
  assert.match(settings.data.settingBackClass, /setting-row-focused/);
  assert.doesNotMatch(settings.data.settingMetronomeClass, /setting-row-focused/);
  settings.onKeyUp({ code: 'ArrowDown', preventDefault() {} });
  assert.equal(settings.settingFocusIndex, 0, '六个设置项加返回按钮应从末项回到首项');
  settings.surfaceEntryConfirmGuardUntilMs = Date.now() - 1;
  releaseSurfaceGesture(settings);
  assert.equal(settings.onSettingTap({
    currentTarget: { dataset: { setting: 'binding', index: 4 } },
  }), true, '绑定目标必须进入明确授权页面');
  assert.equal(settings.data.surfacePhase, 'binding');
  let bindingBackPrevented = false;
  settings.onKeyUp({ code: 'Backspace', preventDefault() { bindingBackPrevented = true; } });
  assert.equal(bindingBackPrevented, true);
  assert.equal(settings.data.surfacePhase, 'settings');
  assert.equal(settings.settingFocusIndex, 4);
});

test('绑定页始终显示当前 AIUI ID，刷新操作只刷新服务器绑定状态', async () => {
  const page = freshPage();
  wx.store.set('smartrun_device_secret', 's'.repeat(48));
  wx.store.set('smartrun_installation_id', 'inst-existing-glasses-01');
  wx.store.set('smartrun_public_device_id', 'SR-GLASSES-01');
  wx.store.set('smartrun_aiui_id', {
    aiuiId: 'A7K2M9Q4', publicDeviceId: 'SR-GLASSES-01',
    ownershipEpoch: 1, dataNamespace: 'anon-glasses-01',
  });
  wx.store.set('smartrun_device_binding', {
    bound: false, ownershipEpoch: 1,
    dataNamespace: 'anon-glasses-01', updatedAtMs: 1,
  });
  let bound = false;
  let bootstrapCalls = 0;
  const requestedUrls = [];
  wx.requestImpl = (opts) => {
    requestedUrls.push(opts.url);
    if (opts.url.endsWith('/coach/device-bootstrap')) {
      bootstrapCalls += 1;
      assert.equal(opts.dataType, 'json');
      assert.equal(opts.responseType, 'text');
      assert.ok(opts.timeout >= 10000, '身份请求应容纳手机代理与冷 TLS');
      assert.equal('device_sn' in opts.data, false, '原始 SN 不得进入请求');
      assert.equal(opts.data.device_secret, 's'.repeat(48));
      opts.success({ statusCode: 200, data: {
        public_device_id: 'SR-GLASSES-01', aiui_id: 'A7K2M9Q4',
        token: bound ? 'device-jwt-2' : 'device-jwt-1', bound,
        agent_instance_id: 'agent-smr-01', agent_alias: 'Morning Runner',
        ownership_epoch: bound ? 2 : 1,
        data_namespace: bound ? 'user-42' : 'anon-glasses-01',
      } });
    } else {
      opts.fail(new Error('unexpected endpoint'));
    }
  };
  page.onLoad({ mode: 'settings' });
  pagesToClean.push(page);
  await flushAsync();
  assert.equal(page.data.surfacePhase, 'settings');
  assert.equal(page.data.settingBinding, '未绑定');
  assert.equal(page.onSettingTap({
    currentTarget: { dataset: { setting: 'binding', index: 3 } },
  }), true);
  assert.equal(page.data.surfacePhase, 'binding');
  await flushAsync();
  assert.equal(page.data.bindingAiuiId, 'A7K2 M9Q4');
  assert.equal(page.data.bindingChip, '未绑定');
  assert.equal(page.data.bindingState, '尚未绑定智能体');
  assert.equal(page.data.bindingDetail, '可在已登录 APK 输入此 ID 绑定');
  assert.equal(page.data.bindingActionLabel, '刷新状态');
  assert.equal(await page.onBindingActionTap(), false, '入场确认的尾随事件不得顺带发起第二次刷新');
  page.bindingEnteredAtMs -= 401;
  page.surfaceEntryConfirmGuardUntilMs = Date.now() - 1;
  releaseSurfaceGesture(page);

  assert.equal(await page.onBindingActionTap(), true);
  assert.ok(bootstrapCalls >= 3,
    '进入设置、进入绑定页与用户刷新均通过 bootstrap 取当前状态');
  assert.equal(requestedUrls.some((url) => url.includes('device-pair-code')), false,
    '永久 AIUI ID 契约不得请求有效期 pair-code');
  assert.equal(wx.store.get('smartrun_aiui_id').aiuiId, 'A7K2M9Q4');
  assert.equal(wx.store.get('smartrun_device_token'), 'device-jwt-1');
  assert.equal(wx.store.get('coach_token'), 'device-jwt-1');
  assert.equal('effectiveUserId' in wx.store.get('smartrun_device_binding'), false);

  // No local binding deadline: the current server-issued ID remains the visible locator.
  bound = true;
  page.lastSurfaceActivationAtMs = Date.now() - 601;
  assert.equal(await page.onBindingActionTap(), true, '绑定后确认刷新服务器状态');
  assert.equal(page.data.bindingChip, '已绑定');
  assert.equal(page.data.settingBinding, '已绑定');
  assert.match(page.data.bindingDetail, /Morning Runner/);
  assert.equal(wx.store.get('smartrun_device_token'), 'device-jwt-2');
  assert.equal(wx.store.get('smartrun_device_binding').ownershipEpoch, 2);
});

test('绑定页两项焦点前后循环且稳定确认只执行当前项', () => {
  const page = prepareBindingPage();
  let refreshCalls = 0;
  let exportCalls = 0;
  page.onBindingActionTap = () => { refreshCalls += 1; return true; };
  page.onBindingExportTap = () => { exportCalls += 1; return true; };

  assert.equal(page.bindingFocusIndex, 0);
  assert.equal(page.data.bindingRefreshClass, 'binding-action-focused');
  assert.equal(page.data.bindingExportClass, '');

  let prevented = false;
  page.onKeyUp({ code: 'ArrowDown', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(page.bindingFocusIndex, 1);
  assert.equal(page.data.bindingRefreshClass, '');
  assert.equal(page.data.bindingExportClass, 'binding-action-focused');

  releaseDirectionGesture(page);
  page.onKeyUp({ code: 'ArrowRight', preventDefault() {} });
  assert.equal(page.bindingFocusIndex, 0, '向前划必须从导出循环回刷新');
  assert.equal(page.data.bindingRefreshClass, 'binding-action-focused');
  assert.equal(page.data.bindingExportClass, '');

  releaseDirectionGesture(page);
  page.onKeyUp({ code: 'ArrowUp', preventDefault() {} });
  assert.equal(page.bindingFocusIndex, 1, '向后划必须从刷新循环回导出');
  assert.equal(page.data.bindingRefreshClass, '');
  assert.equal(page.data.bindingExportClass, 'binding-action-focused');

  page.surfaceEntryConfirmGuardUntilMs = Date.now() - 1;
  page.lastSurfaceConfirmKeyMs = null;
  prevented = false;
  page.onKeyUp({ code: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true, '双目标绑定页的稳定确认必须由页面接管');
  assert.equal(exportCalls, 1);
  assert.equal(refreshCalls, 0);

  page.setBindingFocus(0);
  page.surfaceEntryConfirmGuardUntilMs = Date.now() - 1;
  page.lastSurfaceConfirmKeyMs = null;
  prevented = false;
  page.onKeyUp({ code: 'Space', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(refreshCalls, 1);
  assert.equal(exportCalls, 1);
});

test('绑定页无现场日志时给出明确状态且不进入回放', () => {
  const page = prepareBindingPage();
  page.setBindingFocus(1);
  assert.equal(page.onBindingExportTap(), false);
  assert.equal(page.bindingExportPending, false);
  assert.equal(page.localFieldLogReplayTimer, null);
  assert.equal(page.data.bindingChip, '无日志');
  assert.equal(page.data.bindingState, '暂无可导出的跑步日志');
  assert.equal(page.data.bindingExportLabel, '暂无现场日志');
});

test('绑定页导出完整现场日志并在 BEGIN/CHUNK/END 后完成回调', async () => {
  const page = prepareBindingPage();
  seedCompletedRunningLocalFieldLog(wx);
  page.setBindingFocus(1);
  releaseSurfaceGesture(page);

  const replayLines = [];
  const originalLog = console.log;
  console.log = (...args) => {
    const line = args.map(String).join(' ');
    if (line.includes('SMARTRUN_LOCAL_LOG|')) replayLines.push(line);
  };
  try {
    assert.equal(page.onBindingExportTap(), true);
    assert.equal(page.bindingExportPending, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    console.log = originalLog;
  }

  assert.ok(replayLines.some((line) => line.includes('SMARTRUN_LOCAL_LOG|BEGIN|')));
  assert.ok(replayLines.some((line) => line.includes('SMARTRUN_LOCAL_LOG|CHUNK|')));
  assert.ok(replayLines.some((line) => line.includes('SMARTRUN_LOCAL_LOG|END|')));
  assert.equal(page.bindingExportPending, false,
    'END 后 onComplete 必须解除导出 single-flight');
  assert.equal(page.data.bindingChip, '已导出');
  assert.equal(page.data.bindingState, '现场日志导出完成');
  assert.equal(page.data.bindingExportLabel, '再次导出');
});

test('绑定页离开或隐藏时取消现场日志回放且不输出迟到 END', async () => {
  const originalLog = console.log;
  const replayLines = [];
  console.log = (...args) => {
    const line = args.map(String).join(' ');
    if (line.includes('SMARTRUN_LOCAL_LOG|')) replayLines.push(line);
  };
  try {
    const leaving = prepareBindingPage();
    seedCompletedRunningLocalFieldLog(wx, 'bindingleave');
    leaving.setBindingFocus(1);
    releaseSurfaceGesture(leaving);
    assert.equal(leaving.onBindingExportTap(), true);
    assert.equal(leaving.showSettingsFromBinding(), true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(leaving.data.surfacePhase, 'settings');
    assert.equal(leaving.bindingExportPending, false);
    assert.equal(leaving.localFieldLogReplayTimer, null);
    assert.equal(replayLines.some((line) => line.includes('|END|')), false,
      '离开绑定页必须取消尚未开始的回放');

    replayLines.length = 0;
    const hidden = prepareBindingPage();
    seedCompletedRunningLocalFieldLog(wx, 'bindinghide');
    hidden.setBindingFocus(1);
    releaseSurfaceGesture(hidden);
    assert.equal(hidden.onBindingExportTap(), true);
    hidden.onHide();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(hidden.bindingExportPending, false);
    assert.equal(hidden.localFieldLogReplayTimer, null);
    assert.equal(hidden.data.bindingChip, '已暂停');
    assert.equal(hidden.data.bindingState, '现场日志导出已暂停');
    assert.equal(hidden.data.bindingExportLabel, '重新导出');
    assert.equal(replayLines.some((line) => line.includes('|END|')), false,
      '页面隐藏必须取消尚未开始的回放');
  } finally {
    console.log = originalLog;
  }
});

test('绑定页区分真正存储不可用与身份事务未完成', () => {
  const page = freshPage();
  page.onLoad({ mode: 'settings' });
  pagesToClean.push(page);

  page.syncDeviceIdentityData({
    credentialPersistenceFailed: true,
    persistenceFailureReason: 'secret_missing',
  });
  assert.equal(page.data.bindingChip, '待重试');
  assert.equal(page.data.bindingState, '安全身份尚未建立');
  assert.doesNotMatch(page.data.bindingState + page.data.bindingDetail, /存储异常|存储暂不可用/);

  page.syncDeviceIdentityData({
    credentialStorageUnavailable: true,
    credentialRecoveryRequired: true,
    persistenceFailureReason: 'storage_unavailable',
  });
  assert.equal(page.data.bindingChip, '存储异常');
  assert.equal(page.data.bindingState, '本地存储暂不可用');
  assert.equal(page.data.bindingActionLabel, '重试',
    '存储不可用优先级高于凭据恢复，不能诱导执行身份轮换');

  page.syncDeviceIdentityData({ networkDiagnostic: 'timeout' });
  assert.equal(page.data.bindingChip, '连接超时');
  assert.match(page.data.bindingDetail, /手机联网.*Rokid App/);

  page.syncDeviceIdentityData({ networkDiagnostic: 'domain' });
  assert.equal(page.data.bindingChip, '域名配置');

  page.syncDeviceIdentityData({ networkDiagnostic: 'network' });
  assert.equal(page.data.bindingChip, '网络异常');

  page.syncDeviceIdentityData({ networkDiagnostic: 'response' });
  assert.equal(page.data.bindingChip, '响应异常');
});

test('存储重试恢复后必须另按一次确认，不能用同一次点击直接重建身份', async () => {
  const page = freshPage();
  page.onLoad({ mode: 'settings' });
  pagesToClean.push(page);
  page.setData({ surfacePhase: 'binding' });
  page.syncDeviceIdentityData({
    credentialStorageUnavailable: true,
    credentialRecoveryRequired: true,
  });
  page.bindingEnteredAtMs = Date.now() - 1000;
  page.surfaceEntryConfirmGuardUntilMs = Date.now() - 1;

  const recoveryIdentity = {
    credentialRecoveryRequired: true,
    credentialStorageUnavailable: false,
  };
  page.refreshDeviceIdentity = async () => recoveryIdentity;
  let recoverCalls = 0;
  page.recoverDeviceIdentityFromBinding = async () => {
    recoverCalls += 1;
    return true;
  };

  assert.equal(await page.onBindingActionTap(), false,
    '第一次“重试”只允许展示新的恢复确认状态');
  assert.equal(recoverCalls, 0);
  assert.equal(page.data.bindingChip, '需恢复');
  assert.equal(page.data.bindingActionLabel, '确认重建本地身份');

  releaseSurfaceGesture(page);
  assert.equal(await page.onBindingActionTap(), true,
    '第二次独立确认才授权创建 fresh anonymous identity');
  assert.equal(recoverCalls, 1);
});

test('bindtap 是唯一激活通道：下一步点击直接进 HUD，重复点击幂等', () => {
  const page = freshPage();
  page.onLoad();
  makeInteractive(page);
  assert.equal(page.onConnectTap(), true, '下一步 bindtap 直接进 HUD');
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.onConnectTap(), false, '重复点击幂等');
  page.onUnload();
});

test('02 原生下一步按钮点击与硬件确认共用同一入口', () => {
  const page = boot();
  makeInteractive(page);
  const started = page.onConnectTap();
  assert.equal(started, true);
  assert.equal(page.data.surfacePhase, 'hud', '无 BLE 宿主应直接进入单眼镜 HUD');
  assert.equal(page.data.running, true);
  assert.equal(page.onConnectTap(), false, '进入 HUD 后重复点击必须幂等');
});



test('伪造 connected 状态不能让 pending BPM 通过下一步门禁', () => {
  const page = boot();
  makeInteractive(page);
  page.pendingEntryBpm = 166;
  page.lastHrAtMs = Date.now();
  page.setData({ bleState: 'connected' });

  page.onConnectTap();
  assert.equal(page.data.showHeartRate, false);
  assert.equal(page.session.lastBpm, null);
  assert.equal(page.pendingEntryBpm, null);
});












test('页面在 onReady 兜底触发前隐藏，不得从后台开始扫描', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  let starts = 0;
  page.autoConnectBle = async () => { starts += 1; };

  page.onLoad();
  page.onShow();
  page.onHide();
  t.mock.timers.tick(1000);
  await flushAsync();
  assert.equal(starts, 0);
  assert.equal(page.bleReadyFallbackTimer, null);
});



test('缺少 getAvailability 不再阻断扫描：只要求 scanDevices 存在(样例形态)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  let scans = 0;
  globalThis.navigator = {
    bluetooth: {
      async scanDevices() {
        scans += 1;
        return { onDeviceFound() {}, async stop() {} };
      },
    },
  };
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  assert.equal(scans, 1, 'scanDevices 存在即可扫描,不做任何预探测');
  page.onConnectTap();
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.data.running, true);
});

test('扫描前绝不调用 getAvailability(官方样例形态:多余桥往返可能致败)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  let scans = 0;
  globalThis.navigator = {
    bluetooth: {
      getAvailability() { throw new Error('scan path must never pre-probe availability'); },
      async scanDevices() {
        scans += 1;
        return { onDeviceFound() {}, async stop() {} };
      },
    },
  };
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  assert.equal(scans, 1, 'getAvailability 绝不被调用,scanDevices 直接发起');
  assert.equal(page.data.searchChip, '搜索中');
});







test('首次无首选设备时在 02 interactive 后启动真机已验证的心率过滤扫描', async () => {
  const page = freshPage();
  let getDevicesCalls = 0;
  let scanCalls = 0;
  let onDeviceFound;
  globalThis.navigator = {
    bluetooth: {
      async getAvailability() { return true; },
      async getDevices() { getDevicesCalls += 1; return []; },
      async scanDevices(options) {
        scanCalls += 1;
        assert.deepEqual(options, {
          filters: [{ services: ['heart_rate'] }],
        });
        return {
          onDeviceFound(callback) { onDeviceFound = callback; },
          async stop() {},
        };
      },
    },
  };
  page.onLoad();
  assert.equal(scanCalls, 0, 'onLoad 不能扫描');
  makeInteractive(page);
  await flushAsync();
  assert.equal(getDevicesCalls, 0);
  assert.equal(scanCalls, 1);
  assert.equal(typeof onDeviceFound, 'function');
  page.onUnload();
});

test('已有首选设备时不等待可能悬空的 getDevices，直接开始附近扫描', async () => {
  const page = freshPage();
  wx.store.set('heart_rate_device', { deviceId: 'garmin-1', deviceName: 'fenix 8' });
  let getDevicesCalls = 0;
  let scanCalls = 0;
  globalThis.navigator = {
    bluetooth: {
      async getAvailability() { return true; },
      getDevices() {
        getDevicesCalls += 1;
        return new Promise(() => {});
      },
      async scanDevices(options) {
        scanCalls += 1;
        assert.deepEqual(options, { filters: [{ services: ['heart_rate'] }] });
        return { onDeviceFound() {}, async stop() {} };
      },
    },
  };

  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  assert.equal(getDevicesCalls, 0, '授权缓存不得阻塞真实附近扫描');
  assert.equal(scanCalls, 1);
  assert.equal(page.data.scanDiagnostic, '等待附近设备广播');
  page.onUnload();
});




test('Craft 缺少 navigator/bluetooth/scanDevices 时首次点按开放下一步，第二次原生 bindtap 进 HUD', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const scenarios = [
    ['navigator 缺失', null],
    ['bluetooth 缺失', {}],
    ['scanDevices 缺失', { bluetooth: {} }],
  ];

  for (const [label, navigatorValue] of scenarios) {
    const page = freshPage();
    t.after(() => page.onUnload());
    if (navigatorValue == null) delete globalThis.navigator;
    else globalThis.navigator = navigatorValue;

    page.onLoad();
    await page.onScanTap(); // Craft 的第一次原生 button bindtap

    assert.equal(page.data.bleState, 'idle', label);
    assert.equal(page.data.searchChip, '未搜索', label);
    assert.equal(page.data.searchText, '当前无法搜索蓝牙设备', label);
    assert.equal(page.data.scanDiagnostic, '单击“下一步”使用眼镜估算', label);
    assert.equal(page.data.primaryLabel, '下一步', label);
    assert.equal(page.scanAttempted, true, label + ': 首次点按已完成能力探测');
    assert.equal(page.data.surfacePhase, 'ready', label + ': 首次点按不得直接起跑');
    assert.equal(page.data.running, false, label + ': 首次点按不得直接起跑');

    releaseSurfaceGesture(page);
    assert.equal(page.onScanTap(), true, label + ': 第二次独立 bindtap 应解释为下一步');
    assert.equal(page.data.surfacePhase, 'hud', label);
    assert.equal(page.data.running, true, label);
  }

  assert.ok(logs.some((line) => line.includes(
    '[SmartRun BLE] AVAILABILITY_FAILED reason=api-missing',
  )));
});

test('scanDevices 启动失败只记录脱敏错误类别并显示扫描失败', async (t) => {
  const page = freshPage();
  t.after(() => page.onUnload());
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  globalThis.navigator = {
    bluetooth: {
      async getAvailability() { return true; },
      async scanDevices(options) {
        assert.deepEqual(options, { filters: [{ services: ['heart_rate'] }] });
        throw new Error('bridge rejected scan');
      },
    },
  };

  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  await flushAsync();

  assert.ok(logs.some((line) => line.includes(
    '[SmartRun BLE] SCAN_START_FAILED reason=other',
  )));
  assert.doesNotMatch(logs.join('\n'), /bridge rejected scan/);
  assert.equal(page.data.bleState, 'idle');
  assert.equal(page.data.searchChip, '搜索失败');
  assert.equal(page.data.scanDiagnostic, '单击“下一步”继续');
  assert.notEqual(page.data.scanDiagnostic, '等待附近设备广播');
});

test('02 全量扫描把普通广播与心率候选都列出，按稳定 ID 去重并通过 setData 同步', async (t) => {
  const page = freshPage();
  t.after(() => page.onUnload());
  let onDeviceFound;
  const setDataPatches = [];
  const originalSetData = page.setData.bind(page);
  page.setData = (patch) => {
    setDataPatches.push(patch);
    originalSetData(patch);
  };
  globalThis.navigator = {
    bluetooth: {
      async getAvailability() { return true; },
      async scanDevices() {
        return {
          onDeviceFound(callback) { onDeviceFound = callback; },
          async stop() {},
        };
      },
    },
  };

  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  onDeviceFound({ device: { id: 'macbook-a', name: 'MacBook Test Broadcast' } });
  onDeviceFound({ device: { id: 'hr-b', name: 'Polar H10' } });
  onDeviceFound({ device: { id: 'macbook-a', name: '同一普通广播的重复包' } });
  onDeviceFound({ device: { id: 'unknown-c', name: null } });
  const unnamedLabel = page.data.discoveredDevices.find(
    (item) => item.deviceId === 'unknown-c',
  ).deviceName;
  onDeviceFound({ device: { id: 'unknown-c', name: null } });

  assert.deepEqual(page.data.discoveredDevices.map((item) => item.deviceId), [
    'macbook-a', 'hr-b', 'unknown-c',
  ]);
  assert.ok(page.data.discoveredDevices[0].deviceName,
    '同一 ID 的重复广播不得制造第二项，最新有效名称仍可用于展示');
  assert.ok(unnamedLabel,
    '宿主没有提供 name 时仍须给出非空、稳定的显示名');
  assert.equal(page.data.discoveredDevices[2].deviceName, unnamedLabel,
    '无名设备的稳定显示名不能随重复广播变化');
  assert.equal(page.data.discoveredDeviceCount, 3);
  assert.equal(page.data.hasDiscoveredDevices, true);

  const discoveryPatches = setDataPatches.filter((patch) => 'discoveredDevices' in patch);
  assert.ok(discoveryPatches.length >= 3, '三个新 ID 应分别触发列表 setData');
  for (const patch of discoveryPatches) {
    assert.ok(Array.isArray(patch.discoveredDevices));
    assert.equal(patch.discoveredDeviceCount, patch.discoveredDevices.length);
    assert.equal(patch.hasDiscoveredDevices, patch.discoveredDevices.length > 0);
  }
});

test('扫描发现心率设备后自动发起同一条 HRS/GATT 连接链，下一步仍由用户确认', async (t) => {
  const page = freshPage();
  t.after(() => page.onUnload());
  const { device } = fakeHrDevice('自动连接心率带');
  const host = scanHost();

  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await flushAsync();
  await new Promise((resolve) => setTimeout(resolve, 1300));
  await flushAsync();

  assert.equal(device.gatt.connectCalls, 1, '发现候选后应自动发起连接');
  assert.equal(page.data.surfacePhase, 'connecting', '自动连接不得跳过 02');
  assert.equal(page.data.bleState, 'connected', 'HRS notify 成功后应显示已连接');
  assert.equal(page.data.primaryLabel, '下一步', '仍需用户确认才能进入热身');
  assert.equal(page.hrCharacteristic.startNotificationsCalls, 1);
});

test('全量扫描进行中隐藏页面会立即停止并取消候选验证', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  const { device } = fakeHrDevice('Nearby HR Strap');
  let onDeviceFound;
  let scanStops = 0;
  let connects = 0;
  const originalConnect = device.gatt.connect.bind(device.gatt);
  device.gatt.connect = async () => {
    connects += 1;
    return originalConnect();
  };
  globalThis.navigator = {
    bluetooth: {
      async getAvailability() { return true; },
      async scanDevices() {
        return {
          onDeviceFound(callback) { onDeviceFound = callback; },
          async stop() { scanStops += 1; },
        };
      },
    },
  };

  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  onDeviceFound({ device });
  assert.equal(page.data.bleState, 'scanning');
  assert.equal(page.data.discoveredDeviceCount, 1);

  page.onHide();
  assert.equal(scanStops, 1, 'InkView 隐藏时必须停止当前 scan session');
  assert.equal(page.data.bleState, 'idle');
  assert.deepEqual(page.data.discoveredDevices, []);
  t.mock.timers.tick(10000);
  await flushAsync();
  assert.equal(connects, 0, '旧扫描的候选不能在隐藏后继续发起 GATT 验证');
});

test('搜索页隐藏后的旧 GATT 清理完成前，新连接必须等待，不能被迟到 disconnect 拆掉', async () => {
  const page = freshPage();
  const { device, hrChar, rscChar, server } = fakeHrRscDevice('Resume HR');
  page.onLoad({ mode: 'free' });
  page.onShow();
  page.setData({ surfacePhase: 'ready', bleState: 'connected' });
  device.gatt.connected = true;
  page.hrCharacteristic = hrChar;
  page.hrListener = () => {};
  page.rscCharacteristic = rscChar;
  page.rscListener = () => {};
  page.bleDevice = device;
  page.bleServer = server;

  const order = [];
  let releaseOldHr;
  const originalHrStop = hrChar.stopNotifications.bind(hrChar);
  hrChar.stopNotifications = () => {
    hrChar.stopNotificationsCalls += 1;
    order.push('old-hr-stop');
    return new Promise((resolve) => {
      releaseOldHr = () => {
        order.push('old-hr-stopped');
        resolve(hrChar);
      };
    });
  };
  rscChar.stopNotifications = async () => {
    rscChar.stopNotificationsCalls += 1;
    order.push('old-rsc-stop');
    return rscChar;
  };
  const originalDisconnect = device.gatt.disconnect.bind(device.gatt);
  device.gatt.disconnect = () => {
    order.push('old-disconnect');
    return originalDisconnect();
  };
  const originalConnect = device.gatt.connect.bind(device.gatt);
  device.gatt.connect = async () => {
    order.push('new-connect');
    return originalConnect();
  };

  page.onHide();
  const oldCleanup = page.bleCleanupPromise;
  assert.ok(oldCleanup, '隐藏页必须保存旧 GATT 清理 Promise');
  assert.equal(hrChar.stopNotificationsCalls, 1);
  page.onShow();
  const reconnect = page.connectSelected(device);
  await flushAsync();
  assert.equal(device.gatt.connectCalls, 0,
    '旧 stopNotifications 未完成前不能发起同设备的新 connect');

  releaseOldHr();
  assert.equal(await reconnect, true);
  hrChar.stopNotifications = originalHrStop;
  assert.ok(order.indexOf('old-disconnect') > order.indexOf('old-rsc-stop'));
  assert.ok(order.indexOf('new-connect') > order.indexOf('old-disconnect'),
    '新连接必须排在旧通知和旧 GATT 全部清理之后');
  assert.equal(device.gatt.connected, true, '迟到的旧 disconnect 不得拆掉新连接');

  if (page.rscProbePromise) await page.rscProbePromise;
  await page.beginTerminalBleCleanup();
});







test('息屏自动暂停:onHide 暂停记录,onShow 恢复 ticker 与 IMU', () => {
  const page = bootRunning();
  page.tick();
  assert.equal(page.session.paused, false);
  page.onHide();
  assert.equal(page.session.paused, true);
  assert.equal(page.data.paused, true);
  assert.equal(page.timer, null);
  assert.equal(page.accel, null);
  page.onShow();
  assert.equal(page.session.paused, false);
  assert.ok(page.timer);
  assert.ok(page.accel);
});

test('息屏恢复后旧 Accelerometer 的迟到 reading/error 不会污染或关闭新实例', () => {
  const page = bootRunning();
  const firstAccel = FakeAccelerometer.instances[0];
  page.onHide();
  page.onShow();
  const resumedAccel = page.accel;
  assert.ok(resumedAccel);
  assert.notEqual(resumedAccel, firstAccel);
  const lastAccelAt = page.lastAccelAt;
  firstAccel.emitReading(0, 0, 20, 999999999999);
  firstAccel.emitError();
  assert.equal(page.accel, resumedAccel);
  assert.equal(page.imuOk, true);
  assert.equal(page.lastAccelAt, lastAccelAt);
});

test('AIUI 0.15 姿态与陀螺仪按能力启用，改善垂直计步且随页面生命周期清理', () => {
  const page = bootRunning({ withMotion15: true });
  const accel = FakeAccelerometer.instances[0];
  const gyro = FakeGyroscope.instances[0];
  const orientation = FakeAbsoluteOrientationSensor.instances[0];
  assert.equal(gyro.started, true);
  assert.equal(orientation.started, true);

  const theta = 0.42;
  const quaternion = [0, Math.sin(theta / 2), 0, Math.cos(theta / 2)];
  const originalNow = Date.now;
  let now = originalNow();
  try {
    for (let index = 0; index < 420; index += 1) {
      now += 20;
      Date.now = () => now;
      const dynamic = 1.1 * Math.sin(2 * Math.PI * 3 * index / 50);
      const magnitude = 9.80665 + dynamic;
      orientation.emitReading(quaternion, index * 20);
      gyro.emitReading(0.08, 0.05, 0.03, index * 20);
      accel.emitReading(
        -Math.sin(theta) * magnitude,
        0,
        Math.cos(theta) * magnitude,
        index * 20,
      );
    }
  } finally {
    Date.now = originalNow;
  }
  assert.equal(page.orientationProjectionLogged, true);
  assert.ok(page.motionMetrics.acceptedSteps > 8);
  assert.ok(page.motionQuality.snapshot(page.lastAccelSensorAt).runningConfidence > 0.5);

  page.onHide();
  assert.equal(gyro.stopped, true);
  assert.equal(orientation.stopped, true);
  page.onShow();
  assert.notEqual(page.gyro, gyro);
  assert.notEqual(page.motionOrientationSensor, orientation);
});

test('AIUI 0.16.1 复用宿主姿态源，World Awareness 回调只记影子诊断', () => {
  const runtimeOrientation = new FakeAbsoluteOrientationSensor();
  const enableCalls = [];
  let disableCalls = 0;
  const page = freshPage({
    withMotion15: true,
    hostFields: {
      orientationSensor: runtimeOrientation,
      enableWorldAwareness(options) {
        enableCalls.push(options);
      },
      disableWorldAwareness() {
        disableCalls += 1;
      },
    },
  });
  page.onLoad();
  makeRunning(page);
  page.stopTicker();

  assert.deepEqual(enableCalls, [{ mode: 'normal' }]);
  assert.equal(page.orientationSensor, runtimeOrientation,
    '宿主保留字段必须原样保留');
  assert.equal(page.motionOrientationBoundSensor, runtimeOrientation);
  assert.equal(page.motionOrientationRuntimeOwned, true);
  assert.equal(page.motionOrientationSensor, null,
    '复用宿主实例时不得再构造手动姿态源');
  assert.equal(runtimeOrientation.startCalls || 0, 0,
    '宿主实例的 start 也归 World Awareness 所有');
  assert.equal((runtimeOrientation.listeners.reading || []).length, 1);

  const before = page.motionMetrics.snapshot(Date.now());
  const beforeCadence = page.data.cadence;
  runtimeOrientation.emitReading([0, 0, 0, 1], 20);
  page.onOrientationStabilityChange({ stable: true });
  page.onHeadGesture({ gesture: 'nod' });
  const after = page.motionMetrics.snapshot(Date.now());
  assert.equal(page.worldAwarenessDiagnostics.orientationStable, true);
  assert.equal(page.worldAwarenessDiagnostics.lastHeadGesture, 'nod');
  assert.equal(after.distanceM, before.distanceM,
    'World Awareness 影子回调不得改距离账本');
  assert.equal(after.cadenceSpm, before.cadenceSpm,
    'World Awareness 影子回调不得改步频');
  assert.equal(page.data.cadence, beforeCadence);

  page.onHide();
  assert.equal(disableCalls, 1,
    '隐藏时应通过官方 API 关闭本页已启用的 World Awareness');
  assert.equal(page.worldAwarenessEnabled, false);
  assert.equal(page.worldAwarenessEnableAttempted, false);
  assert.equal(runtimeOrientation.stopCalls || 0, 0,
    '隐藏时不能 stop 宿主拥有的姿态源');
  assert.equal((runtimeOrientation.listeners.reading || []).length, 0,
    '仅摘掉 SmartRun 自己的 reading listener');
  assert.equal((runtimeOrientation.listeners.error || []).length, 0);
  assert.equal(page.orientationSensor, runtimeOrientation);

  page.onShow();
  assert.deepEqual(enableCalls, [{ mode: 'normal' }, { mode: 'normal' }],
    '恢复运动生命周期应重新启用 World Awareness');
  assert.equal(page.motionOrientationBoundSensor, runtimeOrientation);
  assert.equal(runtimeOrientation.startCalls || 0, 0);
  assert.equal((runtimeOrientation.listeners.reading || []).length, 1,
    '恢复运动生命周期后只重绑一个 SmartRun listener');
});

test('AIUI 0.16.1 宿主姿态源报错时回退手动传感器，仍不停宿主实例', () => {
  const runtimeOrientation = new FakeAbsoluteOrientationSensor();
  const page = freshPage({
    withMotion15: true,
    hostFields: {
      orientationSensor: runtimeOrientation,
      enableWorldAwareness() {},
    },
  });
  page.onLoad();
  makeRunning(page);
  page.stopTicker();

  runtimeOrientation.emitError();
  const manualOrientation = page.motionOrientationSensor;
  assert.ok(manualOrientation);
  assert.notEqual(manualOrientation, runtimeOrientation);
  assert.equal(manualOrientation.started, true);
  assert.equal(page.motionOrientationBoundSensor, manualOrientation);
  assert.equal(page.motionOrientationRuntimeOwned, false);
  assert.equal(runtimeOrientation.stopCalls || 0, 0);
  assert.equal(page.orientationSensor, runtimeOrientation,
    '宿主字段不能因 error 被清空');

  page.onHide();
  assert.equal(manualOrientation.stopped, true,
    '只停 SmartRun 自建的 0.15 回退实例');
  assert.equal(runtimeOrientation.stopCalls || 0, 0);
});

test('enableWorldAwareness 不可用或抛错时保留 0.15 AbsoluteOrientationSensor 回退', () => {
  const page = freshPage({
    withMotion15: true,
    hostFields: {
      enableWorldAwareness() {
        throw new Error('world awareness unavailable');
      },
    },
  });
  page.onLoad();
  makeRunning(page);
  page.stopTicker();
  assert.equal(page.worldAwarenessEnabled, false);
  assert.ok(page.motionOrientationSensor);
  assert.equal(page.motionOrientationSensor.started, true);
  assert.equal(page.motionOrientationRuntimeOwned, false);
});

test('AIUI 0.16.1 disableWorldAwareness Promise 拒绝时安全降级并允许再启用', async () => {
  const runtimeOrientation = new FakeAbsoluteOrientationSensor();
  let enableCalls = 0;
  let disableCalls = 0;
  const page = freshPage({
    withMotion15: true,
    hostFields: {
      orientationSensor: runtimeOrientation,
      enableWorldAwareness() {
        enableCalls += 1;
        return Promise.resolve();
      },
      disableWorldAwareness() {
        disableCalls += 1;
        return Promise.reject(new Error('disable rejected'));
      },
    },
  });
  page.onLoad();
  makeRunning(page);
  page.stopTicker();
  assert.equal(enableCalls, 1);

  assert.doesNotThrow(() => page.onHide());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(disableCalls, 1);
  assert.equal(page.worldAwarenessEnabled, false);
  assert.equal(page.worldAwarenessEnableAttempted, false);
  assert.equal(runtimeOrientation.stopCalls || 0, 0);

  page.onShow();
  assert.equal(enableCalls, 2,
    'disable 拒绝不得毒化下一次 enable');
  assert.equal(page.motionOrientationBoundSensor, runtimeOrientation);
  assert.equal(runtimeOrientation.stopCalls || 0, 0);
  page.onHide();
  await Promise.resolve();
});

test('AIUI 0.15 无 World Awareness disable API 时 stop/hide 不报错', () => {
  const page = bootRunning({ withMotion15: true });
  const manualOrientation = page.motionOrientationSensor;
  assert.ok(manualOrientation);
  assert.equal(typeof page.disableWorldAwareness, 'undefined');
  assert.doesNotThrow(() => page.onHide());
  assert.equal(manualOrientation.stopped, true);
  assert.equal(page.worldAwarenessEnabled, false);
  assert.equal(page.worldAwarenessEnableAttempted, false);
});

test('AIUI 0.15 入场余振不进距离账本，静稳武装后真实运动可恢复步频', () => {
  const page = bootRunning({ withMotion15: true });
  page.stopTicker();
  const accel = FakeAccelerometer.instances[0];
  const gyro = FakeGyroscope.instances[0];
  const orientation = FakeAbsoluteOrientationSensor.instances[0];
  const quaternion = [0, 0, 0, 1];
  const sampleIntervalMs = 20;
  const startedAt = Date.now();
  const originalNow = Date.now;
  let elapsedMs = 0;
  try {
    // 模拟用户确认开跑、扶正眼镜和按键释放产生的短时大幅余振。
    // 即使峰值足以触发两个 StepDetector，入场门打开前也不能形成一步。
    for (; elapsedMs < 800; elapsedMs += sampleIntervalMs) {
      Date.now = () => startedAt + elapsedMs;
      const phase = 2 * Math.PI * 3 * (elapsedMs / 1000);
      orientation.emitReading(quaternion, elapsedMs);
      gyro.emitReading(
        1.2 * Math.sin(phase),
        0.8 * Math.cos(phase),
        0.5 * Math.sin(phase * 0.7),
        elapsedMs,
      );
      accel.emitReading(0, 0, 9.80665 + 2.2 * Math.sin(phase), elapsedMs);
    }
    assert.equal(page.imuArmingLogged, false);
    assert.equal(page.motionDiagnostics.acceptedSteps, 0);
    assert.equal(page.motionMetrics.distanceM, 0);

    // 随后静止建立单位、姿态和质量基线；即使走到 fallback 上限，开门帧
    // 也会先清检测器候选并返回，因此此前余振不能延迟泄漏。
    for (; elapsedMs < 4600; elapsedMs += sampleIntervalMs) {
      Date.now = () => startedAt + elapsedMs;
      orientation.emitReading(quaternion, elapsedMs);
      gyro.emitReading(0.01, 0.01, 0.01, elapsedMs);
      accel.emitReading(0, 0, 9.80665, elapsedMs);
    }
    assert.equal(page.imuArmingLogged, true);
    assert.equal(page.motionDiagnostics.acceptedSteps, 0);
    assert.equal(page.motionMetrics.distanceM, 0);

    // 武装后再喂真实、低角速度的 172spm 垂直周期，页面必须恢复正常计步。
    const movementStartedAt = elapsedMs;
    for (; elapsedMs < movementStartedAt + 10000; elapsedMs += sampleIntervalMs) {
      Date.now = () => startedAt + elapsedMs;
      const phase = 2 * Math.PI * (172 / 60)
        * ((elapsedMs - movementStartedAt) / 1000);
      orientation.emitReading(quaternion, elapsedMs);
      gyro.emitReading(0.04, 0.03, 0.02, elapsedMs);
      accel.emitReading(0, 0, 9.80665 + 1.1 * Math.sin(phase), elapsedMs);
    }
    Date.now = () => startedAt + elapsedMs;
    page.tick();
  } finally {
    Date.now = originalNow;
  }

  const cadence = Number(page.data.cadence);
  assert.ok(cadence >= 160 && cadence <= 185, `武装后步频实际为 ${page.data.cadence}`);
  assert.ok(page.motionDiagnostics.acceptedSteps >= 20);
  assert.ok(page.motionMetrics.distanceM > 0);
});

test('AIUI 0.15 弱投影漏峰时由稳定模长节奏接管，HUD 不再一直显示 --', () => {
  const page = bootRunning({ withMotion15: true });
  bypassImuArming(page);
  const accel = FakeAccelerometer.instances[0];
  const gyro = FakeGyroscope.instances[0];
  const orientation = FakeAbsoluteOrientationSensor.instances[0];
  const sampleHz = 50;
  const cadenceSpm = 172;
  const theta = 0.42;
  const quaternion = [0, Math.sin(theta / 2), 0, Math.cos(theta / 2)];
  const startedAt = Date.now();
  const originalNow = Date.now;
  let elapsedMs = 0;
  try {
    for (let index = 0; index < sampleHz * 20; index += 1) {
      elapsedMs = index * (1000 / sampleHz);
      Date.now = () => startedAt + elapsedMs;
      const dynamic = 0.3
        * Math.sin(2 * Math.PI * (cadenceSpm / 60) * (elapsedMs / 1000));
      const magnitude = 9.80665 + dynamic;
      orientation.emitReading(quaternion, elapsedMs);
      gyro.emitReading(0.04, 0.03, 0.02, elapsedMs);
      accel.emitReading(
        -Math.sin(theta) * magnitude,
        0,
        Math.cos(theta) * magnitude,
        elapsedMs,
      );
    }
    Date.now = () => startedAt + elapsedMs;
    page.tick();
  } finally {
    Date.now = originalNow;
  }

  const cadence = Number(page.data.cadence);
  assert.ok(cadence >= 160 && cadence <= 185, `弱信号步频实际为 ${page.data.cadence}`);
  assert.ok(page.motionDiagnostics.projectedSteps >= 45);
  assert.ok(page.motionDiagnostics.acceptedSteps >= 45);
  assert.ok(page.motionMetrics.distanceM > 0);
});

test('静坐投影倍频未经活动门确认时不写入步数、距离或 HUD 棘轮', () => {
  const page = bootRunning();
  bypassImuArming(page);
  page.stopTicker();
  page.imuActivityGate.reset();
  const accel = FakeAccelerometer.instances[0];
  page.dualStepArbiter.observe = () => ({
    stepped: true,
    channel: 'projected',
    reason: 'projected_primary',
    strictEvidence: false,
    cadenceReady: true,
    cadenceSpm: 108,
    candidateCadenceSpm: 228,
  });

  for (let index = 0; index < 8; index += 1) {
    accel.emitReading(0, 0, 9.80665, 1000 + index * 278);
  }

  assert.equal(page.motionMetrics.acceptedSteps, 0);
  assert.equal(page.motionMetrics.distanceM, 0);
  assert.equal(page.cadenceEverReady, false);
  assert.equal(page.motionDiagnostics.acceptedSteps, 0);
  assert.equal(page.motionDiagnostics.candidateSteps, 8);
});

test('传感器事件只用 accepted-step 间隔锁定 HUD，候选 cadence 不得抢先显示', () => {
  const page = bootRunning();
  bypassImuArming(page);
  page.stopTicker();
  const accel = FakeAccelerometer.instances[0];
  page.dualStepArbiter.observe = ({ timestampMs }) => ({
    stepped: true,
    stepAtMs: timestampMs,
    channel: 'magnitude',
    reason: 'test-accepted',
    strictEvidence: true,
    cadenceReady: true,
    cadenceSpm: 200,
    candidateCadenceSpm: 200,
  });
  page.imuActivityGate = {
    observe() {
      return {
        active: true,
        justActivated: false,
        justDeactivated: false,
        submitStep: true,
        cadenceReady: true,
        cadenceSpm: 200,
        reason: 'test-confirmed',
      };
    },
    pause() {},
    reset() {},
  };

  const startedAt = Date.now();
  const originalNow = Date.now;
  try {
    for (const offsetMs of [1000, 1600, 2200]) {
      Date.now = () => startedAt + offsetMs;
      accel.emitReading(0, 0, 9.80665, offsetMs);
      assert.equal(page.cadenceEverReady, false,
        '不足三个 accepted 间隔时，200spm 候选不得抢先锁定 HUD');
    }
    Date.now = () => startedAt + 2800;
    accel.emitReading(0, 0, 9.80665, 2800);
  } finally {
    Date.now = originalNow;
  }
  assert.equal(page.cadenceEverReady, true,
    'accepted-step 正式窗口形成后，事件回调应同步锁住显示棘轮');
  assert.equal(page.data.cadence, '100',
    '四个 600ms accepted step 的终态必须是 100spm，而不是上游 200spm 候选');
});

test('HUD 双入口共用 500ms 限频门，录屏计时器饥饿时事件可恢复且离页后不复活', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const page = bootRunning();
  page.stopTicker();
  const originalTick = page.tick.bind(page);
  let tickCalls = 0;
  page.tick = () => {
    tickCalls += 1;
    return originalTick();
  };

  assert.equal(page.requestRunTick('rsc'), true);
  assert.equal(tickCalls, 1);
  assert.equal(page.requestRunTick('imu'), false, '同一批高频事件不得重复跨桥刷新');
  t.mock.timers.tick(499);
  assert.equal(page.requestRunTick('gps'), false);
  t.mock.timers.tick(1);
  assert.equal(page.requestRunTick('gps'), true);
  assert.equal(tickCalls, 2);

  page.pageVisible = false;
  t.mock.timers.tick(5000);
  assert.equal(page.requestRunTick('rsc'), false, '隐藏后的迟到 notify 不得复活 HUD');
  assert.equal(tickCalls, 2);

  page.pageVisible = true;
  assert.equal(page.finishRunToSummary(), true);
  t.mock.timers.tick(5000);
  assert.equal(page.requestRunTick('rsc'), false, '总结页后的迟到 notify 不得刷新已封存 HUD');
  assert.equal(tickCalls, 2);
});

test('2Hz 事件刷新 HUD 时，RunSession 平均步频仍按约 1Hz 等时采样', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const page = bootRunning();
  page.stopTicker();
  page.updateMotionSourceSelection = () => {};
  let cadenceSpm = 120;
  page.motionMetrics.snapshot = () => ({
    cadenceReady: true,
    cadenceSpm,
    distanceM: 0,
    activeMotionSource: MOTION_SOURCE.IMU_STEP,
    distanceSource: MOTION_SOURCE.IMU_STEP,
    instantPaceSecPerKm: null,
    paceSecPerKm: null,
    rscInstantPaceSecPerKm: null,
    avgPaceSecPerKm: null,
    rscPaceLive: false,
    rscSpeedMps: 0,
  });

  assert.equal(page.requestRunTick('imu'), true);
  assert.equal(page.session.cadenceCount, 1);
  assert.equal(page.session.avgCadenceSpm(), 120);

  t.mock.timers.tick(500);
  cadenceSpm = 240;
  assert.equal(page.requestRunTick('rsc'), true, '500ms 后允许第二次 HUD 跨桥刷新');
  assert.equal(page.data.cadence, '240', '第二次事件应即时更新 HUD');
  assert.equal(page.session.cadenceCount, 1,
    '同一秒内更密集的事件不能额外进入 RunSession 平均值');

  t.mock.timers.tick(500);
  cadenceSpm = 180;
  assert.equal(page.requestRunTick('gps'), true);
  assert.equal(page.session.cadenceCount, 2);
  assert.equal(page.session.avgCadenceSpm(), 150,
    '平均值应只包含 t=0 的 120 与 t=1s 的 180，而不是按 2Hz 回调次数加权');
});

test('HUD_STATUS 诊断同时打印 MotionMetrics 真值与最终显示值', () => {
  assert.match(runHudSource, /\[SmartRun Motion\] HUD_STATUS/);
  assert.match(runHudSource, /metricCadence=/);
  assert.match(runHudSource, /metricReady=/);
  assert.match(runHudSource, /displayCadence=/);
  assert.match(runHudSource, /displayEverReady=/);
});

test('开跑稳定提示至少保持 5 秒且等待可信数据，消失后本场不因停步重现', () => {
  const waitingPage = bootRunning();
  waitingPage.stopTicker();
  assert.equal(waitingPage.data.runWarmupHint, '请稳定跑约 5 秒');
  const waitingStartMs = waitingPage.session.startMs;
  const originalNow = Date.now;
  try {
    Date.now = () => waitingStartMs + 10000;
    waitingPage.tick();
  } finally {
    Date.now = originalNow;
  }
  assert.equal(
    waitingPage.data.runWarmupHint,
    '请稳定跑约 5 秒',
    '只有时间经过、但没有可信步频和配速时不得假装预热完成',
  );

  const page = bootRunning();
  page.stopTicker();
  const startMs = page.session.startMs;
  for (let offsetMs = 1000; offsetMs <= 5680; offsetMs += 360) {
    page.motionMetrics.onAcceptedStep(startMs + offsetMs, 220);
  }
  page.runWarmupMotionAtMs = startMs + 1000;
  try {
    Date.now = () => startMs + 5999;
    page.tick();
    assert.equal(page.data.runWarmupHint, '请稳定跑约 5 秒');

    Date.now = () => startMs + 6000;
    page.tick();
    assert.equal(page.data.runWarmupHint, '',
      '稳定运动满 5 秒且步频、配速都可用后应自动消失');

    Date.now = () => startMs + 10000;
    page.tick();
    assert.equal(page.data.runWarmupHint, '',
      '停步或传感器短时断流后不得重新显示本场起跑提示');
  } finally {
    Date.now = originalNow;
  }
});

test('AIUI 0.15 跑动伴随持续高角速度且有严格模长证据时，仍能恢复真实步频', () => {
  const page = bootRunning({ withMotion15: true });
  bypassImuArming(page);
  const accel = FakeAccelerometer.instances[0];
  const gyro = FakeGyroscope.instances[0];
  const orientation = FakeAbsoluteOrientationSensor.instances[0];
  const sampleHz = 50;
  const cadenceSpm = 172;
  const theta = 0.42;
  const quaternion = [0, Math.sin(theta / 2), 0, Math.cos(theta / 2)];
  const startedAt = Date.now();
  const originalNow = Date.now;
  let elapsedMs = 0;
  try {
    for (let index = 0; index < sampleHz * 20; index += 1) {
      elapsedMs = index * (1000 / sampleHz);
      Date.now = () => startedAt + elapsedMs;
      const phase = 2 * Math.PI * (cadenceSpm / 60) * (elapsedMs / 1000);
      // 高角速度时灵敏投影不能凭自己解锁；真实跑动必须同时给出足以跨过
      // 默认模长门限的物理落步证据，让每个提交步都由两通道一致确认。
      const magnitude = 9.80665 + 1.1 * Math.sin(phase);
      orientation.emitReading(quaternion, elapsedMs);
      gyro.emitReading(
        0.95 * Math.sin(phase + 0.2),
        0.42 * Math.cos(phase),
        0.24 * Math.sin(phase * 0.7),
        elapsedMs,
      );
      accel.emitReading(
        -Math.sin(theta) * magnitude,
        0,
        Math.cos(theta) * magnitude,
        elapsedMs,
      );
    }
    Date.now = () => startedAt + elapsedMs;
    page.tick();
  } finally {
    Date.now = originalNow;
  }

  const cadence = Number(page.data.cadence);
  assert.ok(cadence >= 160 && cadence <= 185, `高角速度跑动步频实际为 ${page.data.cadence}`);
  assert.ok(page.motionDiagnostics.projectedSteps >= 45);
  assert.ok(page.motionDiagnostics.acceptedSteps >= 35);
});

test('AIUI 0.15 姿态不可用时，陀螺仪只拦孤立动作而不锁死周期模长步频', () => {
  const page = bootRunning({ withMotion15: true });
  bypassImuArming(page);
  const accel = FakeAccelerometer.instances[0];
  const gyro = FakeGyroscope.instances[0];
  const orientation = FakeAbsoluteOrientationSensor.instances[0];
  orientation.emitError();
  assert.equal(page.motionOrientationSensor, null);

  const sampleHz = 50;
  const cadenceSpm = 168;
  const startedAt = Date.now();
  const originalNow = Date.now;
  let elapsedMs = 0;
  try {
    for (let index = 0; index < sampleHz * 20; index += 1) {
      elapsedMs = index * (1000 / sampleHz);
      Date.now = () => startedAt + elapsedMs;
      const phase = 2 * Math.PI * (cadenceSpm / 60) * (elapsedMs / 1000);
      gyro.emitReading(
        0.9 * Math.sin(phase + 0.25),
        0.35 * Math.cos(phase),
        0.2 * Math.sin(phase * 0.7),
        elapsedMs,
      );
      // 无姿态且高角速度时，灵敏模长同样要和默认模长的严格峰值逐步一致。
      accel.emitReading(0, 0, 9.80665 + 1.1 * Math.sin(phase), elapsedMs);
    }
    Date.now = () => startedAt + elapsedMs;
    page.tick();
  } finally {
    Date.now = originalNow;
  }

  const cadence = Number(page.data.cadence);
  assert.ok(cadence >= 155 && cadence <= 180, `无姿态回退步频实际为 ${page.data.cadence}`);
  assert.ok(page.motionDiagnostics.projectedSteps >= 40);
  assert.ok(page.motionDiagnostics.acceptedSteps >= 30);
});

test('历史偏快配速过期后由当前 IMU 节奏重算，不长期黏在 HUD', () => {
  const page = bootRunning();
  const originalNow = Date.now;
  const startMs = page.motionMetrics.startMs;
  const now = startMs + 2500;
  try {
    page.lastCrediblePaceSec = 180;
    page.lastCrediblePaceAtMs = now - 6000;
    page.lastDisplayedPaceSec = 180;
    page.motionMetrics.onAcceptedStep(startMs + 1000, 170);
    page.motionMetrics.onAcceptedStep(startMs + 1400, 170);
    page.motionMetrics.onAcceptedStep(startMs + 1800, 170);
    page.motionMetrics.onAcceptedStep(startMs + 2200, 170);
    Date.now = () => now;
    page.tick();
  } finally {
    Date.now = originalNow;
  }
  assert.notEqual(page.data.pace, '3:00');
  assert.match(page.data.pace, /^[5-9]:\d{2}$/);
});

test('110spm 走路只按当前步频和安全步长估算，不显示 3–4 分跑步配速', () => {
  const page = bootRunning();
  const originalNow = Date.now;
  const startMs = page.motionMetrics.startMs;
  try {
    page.motionMetrics.onAcceptedStep(startMs + 1000, 110);
    page.motionMetrics.onAcceptedStep(startMs + 1545, 110);
    page.motionMetrics.onAcceptedStep(startMs + 2091, 110);
    page.motionMetrics.onAcceptedStep(startMs + 2636, 110);
    Date.now = () => startMs + 3000;
    page.tick();
  } finally {
    Date.now = originalNow;
  }
  const [minutes, seconds] = page.data.pace.split(':').map(Number);
  assert.equal(page.data.cadence, '110');
  assert.ok(minutes * 60 + seconds >= 480,
    `110spm 走路不应显示快跑配速，实际为 ${page.data.pace}`);
});

test('本场总配速形成后优先上屏，RSC 瞬时尖峰不得把 8 分跑显示成 4 分', () => {
  const page = bootRunning();
  page.stopTicker();
  page.updateMotionSourceSelection = () => {};
  page.motionMetrics.snapshot = () => ({
    elapsedMs: 60000,
    distanceM: 125,
    cadenceReady: true,
    cadenceSpm: 168,
    cadenceSource: 'rsc',
    avgCadenceSpm: 168,
    paceSecPerKm: 480,
    instantPaceSecPerKm: 240,
    avgPaceSecPerKm: 480,
    rscInstantPaceSecPerKm: 240,
    rscPaceLive: true,
    rscPaceReady: true,
    rscSpeedMps: 1000 / 240,
    rscFresh: true,
    gpsFresh: false,
    activeMotionSource: MOTION_SOURCE.RSC_SPEED,
    distanceSource: MOTION_SOURCE.RSC_SPEED,
    paused: false,
  });
  page.speedFusion.snapshot = () => ({
    live: true,
    paceSecPerKm: 240,
    speedMps: 1000 / 240,
    source: 'rsc',
  });

  page.tick();

  assert.equal(page.data.pace, '8:00',
    '8 秒/10 米后的 HUD 应采用距离总账形成的本场配速，而不是 RSC 短时尖峰');
  const captured = page.calibrationCaptureBuffer.at(-1);
  assert.ok(captured, '校准流应记录本次 HUD 算法输出');
  assert.equal(captured.pace_sec_per_km, 480);
  assert.ok(Math.abs(captured.speed_mps - (1000 / 480)) < 0.0001,
    '后台校准值必须与用户实际看到的稳健配速一致');
});

test('历史 1.25m 人工步长在纯 IMU 慢走时统一受 0.78m 上限约束', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const page = freshPage();
  wx.store.set('run_settings', { strideM: 1.25 });
  page.onLoad();
  pagesToClean.push(page);
  makeRunning(page);
  page.stopTicker();
  page.stopAccel();

  for (let index = 0; index < 24; index += 1) {
    t.mock.timers.tick(500);
    const stride = page.applyAdaptiveStride(120);
    assert.equal(stride.stepLengthM, 0.78);
    page.motionMetrics.onAcceptedStep(Date.now(), 120);
  }
  page.tick();

  assert.ok(Math.abs(page.motionMetrics.distanceM - 18.72) < 0.001);
  assert.equal(page.activeStepLengthM, 0.78);
  assert.equal(page.data.cadence, '120');
  const [minutes, seconds] = page.data.pace.split(':').map(Number);
  assert.ok(minutes * 60 + seconds >= 600,
    `1.25m 历史值不得让 120spm 慢走显示快于 10:00/km，实际为 ${page.data.pace}`);
});

test('当前步频只短暂保持 3.5 秒，长停步回占位且总结仍保留平均', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const page = bootRunning();
  page.stopTicker();
  for (let index = 0; index < 16; index += 1) {
    t.mock.timers.tick(531);
    page.motionMetrics.onAcceptedStep(Date.now(), 113);
  }
  page.tick();
  assert.notEqual(page.data.pace, '-:00');
  assert.equal(page.data.cadence, '113');
  assert.ok(Number.isFinite(page.motionMetrics.snapshot(Date.now()).avgPaceSecPerKm));
  assert.equal(page.session.avgCadenceSpm(), 113);

  t.mock.timers.tick(3000);
  page.tick();
  assert.equal(page.data.cadence, '113', '相邻落步与 1Hz HUD 空档内短暂保持最后可信值');

  t.mock.timers.tick(501);
  page.tick();
  assert.match(page.data.pace, /^\d+:\d{2}$/,
    '本场已形成可信运动后，停步或空帧不得让 HUD 配速重新显示 -:00');
  assert.equal(page.data.cadence, '--',
    '超过 3.5 秒没有新落步必须显示当前停步，不能回退全程平均而锁死 113');
  assert.equal(page.session.avgCadenceSpm(), 113,
    '实时占位不影响跑后总结保留的全程平均步频');
  assert.ok(Number.isFinite(page.motionMetrics.snapshot(Date.now()).avgPaceSecPerKm),
    '总结仍保留同一份全程平均配速');

  for (let index = 0; index < 14; index += 1) {
    t.mock.timers.tick(400);
    page.motionMetrics.onAcceptedStep(Date.now(), 150);
  }
  page.tick();
  assert.equal(page.data.cadence, '150', '恢复运动后应由新落步窗口更新，不复活旧 113');
});

test('步长 v2 初次落盘后清理旧 v1 缓存，回滚包不能复活污染模型', () => {
  const page = boot();
  const legacyKey = ADAPTIVE_STRIDE_LEGACY_STORAGE_KEYS[0];
  wx.store.set(legacyKey, {
    version: 1,
    bins: { normal: { emaM: 1.5 } },
  });
  wx.store.set(DEVICE_BINDING_STORAGE_KEY, {
    bound: false,
    ownershipEpoch: 3,
    dataNamespace: 'owner-three',
  });
  makeRunning(page);

  const current = wx.store.get(ADAPTIVE_STRIDE_STORAGE_KEY);
  assert.equal(current.version, 2);
  assert.equal(current.ownerMarker, '3:owner-three');
  assert.equal(wx.store.has(legacyKey), false);
});



test('跑步中 Backspace 只拦截返回并清空确认进度，三次独立确认才进放松', async () => {
  const page = bootRunning();
  page.tick();
  assert.ok(wx.store.has(LIVE_SNAPSHOT_KEY));
  page.endArmedAtMs = Date.now();
  page.hudEndConfirmCount = 2;
  page.lastConfirmKeyMs = Date.now();
  let prevented = false;
  page.onKeyUp({ code: 'Backspace', preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'HUD Backspace 必须替代宿主的默认弹栈');
  assert.deepEqual(wx.redirectToCalls, []);
  assert.deepEqual(wx.navigateToCalls, []);
  assert.equal(wx.navigateBackCalls, 0);
  assert.equal(wx.store.has(HOST_BACKSPACE_SOURCE_KEY), false,
    'HUD Backspace 不得伪装成宿主返首页意图');
  assert.equal(page.data.surfacePhase, 'hud', 'Backspace 绝不得绕过三次确认');
  assert.equal(page.data.running, true);
  assert.equal(page.endArmedAtMs, null);
  assert.equal(page.hudEndConfirmCount, 0);
  assert.equal(page.lastConfirmKeyMs, null);
  assert.equal(page.data.hudHint, '请按确认键3次结束');
  assert.equal(finishHudWithThreeIndependentConfirms(page), true);
  assert.equal(page.data.running, false);
  assert.equal(wx.store.has(LIVE_SNAPSHOT_KEY), true, '首帧提交不等待同步 storage 清理');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(wx.store.has(LIVE_SNAPSHOT_KEY), false);
  page.onHide();
  assert.equal(page.data.surfacePhase, 'recovery', '隐藏生命周期不得撤下跑后放松页');
  assert.equal(wx.store.has(LIVE_SNAPSHOT_KEY), false);
});

test('02 与功能菜单 Backspace 仍交由宿主默认返回', () => {
  for (const mode of ['free', 'menu']) {
    const page = freshPage();
    pagesToClean.push(page);
    page.onLoad({ mode });
    const initialPhase = page.data.surfacePhase;
    let prevented = false;
    page.onKeyUp({ code: 'Backspace', preventDefault() { prevented = true; } });
    assert.equal(prevented, false, mode + ' 不得拦截宿主返回');
    assert.equal(page.data.surfacePhase, initialPhase);
    assert.equal(wx.store.get(HOST_BACKSPACE_SOURCE_KEY), 'run_hud');
    assert.equal(
      wx.store.has(SCAN_EXIT_HINT_KEY),
      mode === 'free',
      '只有 02 搜索页第一下返回才把首页预武装为第二下退出',
    );
  }
});

test('02 Backspace 与紧随其后的 onUnload 复用同一条 terminal BLE 清理链', async () => {
  const page = freshPage();
  const { device, hrChar, rscChar, server } = fakeHrRscDevice('Back HR');
  page.onLoad({ mode: 'free' });
  page.onShow();
  page.setData({ surfacePhase: 'ready', bleState: 'connected' });
  device.gatt.connected = true;
  page.hrCharacteristic = hrChar;
  page.hrListener = () => {};
  page.rscCharacteristic = rscChar;
  page.rscListener = () => {};
  page.bleDevice = device;
  page.bleServer = server;

  let releaseHr;
  hrChar.stopNotifications = () => {
    hrChar.stopNotificationsCalls += 1;
    return new Promise((resolve) => { releaseHr = () => resolve(hrChar); });
  };

  page.onKeyUp({ code: 'Backspace' });
  const terminalCleanup = page.terminalBleCleanupPromise;
  assert.ok(terminalCleanup, '非总结 Backspace 必须立刻保存 terminal cleanup');
  assert.equal(page.bleCleanupPromise, terminalCleanup);
  assert.equal(hrChar.stopNotificationsCalls, 1);

  page.onUnload();
  assert.equal(page.terminalBleCleanupPromise, terminalCleanup,
    'onUnload 必须复用 Backspace 已捕获全部资源的同一清理链');
  assert.equal(hrChar.stopNotificationsCalls, 1, '不得重复停止 HR notify');

  releaseHr();
  await terminalCleanup;
  assert.equal(hrChar.stopNotificationsCalls, 1);
  assert.equal(rscChar.stopNotificationsCalls, 1, 'RSC notify 也只停止一次');
  assert.equal(device.gatt.disconnectCalls, 1, '共享 GATT 最终只断开一次');
});

test('IMU 看门狗:可见跑步页停流后按退避重建，首包到达即恢复', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const page = bootRunning();
  page.stopTicker();
  const firstAccel = FakeAccelerometer.instances[0];
  assert.equal(page.imuOk, true);
  page.lastAccelAt -= 11000;
  page.tick();
  assert.equal(page.imuOk, false);
  assert.equal(page.data.sourceMain, '仅计时');
  assert.equal(page.data.coachLine, '眼镜传感器恢复中');
  assert.equal(firstAccel.stopped, true);
  assert.ok(page.imuRecoveryDueAtMs > Date.now());

  t.mock.timers.tick(1499);
  page.tick();
  assert.equal(FakeAccelerometer.instances.length, 1);
  t.mock.timers.tick(1);
  page.tick();
  assert.equal(FakeAccelerometer.instances.length, 2);
  assert.equal(page.imuOk, true);

  const recovered = FakeAccelerometer.instances[1];
  recovered.emitReading(0, 0, 9.8);
  assert.equal(page.imuRecoveryAttempts, 0);
  assert.equal(page.imuRecoveryDueAtMs, null);
  assert.equal(page.data.coachLine, '');
  assert.equal(page.data.sourceMain, '眼镜估算');
});

test('录屏/系统浮层结束的重复 onShow 会重建超过 3 秒无读数的旧实例', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const page = bootRunning();
  page.stopTicker();
  const firstAccel = FakeAccelerometer.instances[0];
  page.lastAccelAt -= 4000;

  page.onShow();

  assert.equal(firstAccel.stopped, true);
  assert.equal(FakeAccelerometer.instances.length, 2);
  assert.equal(page.imuOk, true);
  assert.equal(page.imuAwaitingFirstReading, true);
});

test('加速度计 error 只在可见 HUD 排重试，隐藏后不得后台复活', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const page = bootRunning();
  page.stopTicker();
  const firstAccel = FakeAccelerometer.instances[0];
  firstAccel.emitError();
  assert.equal(page.imuOk, false);
  assert.ok(page.imuRecoveryDueAtMs > Date.now());

  page.onHide();
  assert.equal(page.imuRecoveryDueAtMs, null);
  t.mock.timers.tick(20000);
  page.tick();
  assert.equal(FakeAccelerometer.instances.length, 1);
});

test('无 Accelerometer 宿主:开跑后降级仅计时,不崩', () => {
  const page = bootRunning({ withAccel: false });
  assert.equal(page.imuOk, false);
  assert.equal(page.data.sourceMain, '仅计时');
  assert.equal(page.imuRecoveryDueAtMs, null);
  page.tick();
  assert.match(page.data.elapsed, /^\d{2}:\d{2}$/);
});

test('IMU 计步喂真数据:模拟步伐后步频/距离/配速出数', () => {
  const page = bootRunning();
  bypassImuArming(page);
  const accel = FakeAccelerometer.instances[0];
  const stepMs = 353;
  let now = Date.now();
  const origNow = Date.now;
  try {
    for (let index = 0; index < 30; index += 1) {
      Date.now = () => now;
      accel.emitReading(0, 0, 12.5);
      now += stepMs / 2;
      Date.now = () => now;
      accel.emitReading(0, 0, 8.5);
      now += stepMs / 2;
    }
    Date.now = () => now;
    page.tick();
  } finally {
    Date.now = origNow;
  }
  const cadence = Number(page.data.cadence);
  assert.ok(cadence >= 150 && cadence <= 190, `步频应接近 170,实际 ${page.data.cadence}`);
  assert.notEqual(page.data.pace, '正在计算');
});

test('眼镜 IMU 在 null、重复和非毫秒 timestamp 下仍能稳定显示步频', () => {
  const variants = [
    ['null', () => null],
    ['constant', () => 0],
    ['seconds', (elapsedMs) => elapsedMs / 1000],
    ['microseconds', (elapsedMs) => elapsedMs * 1000],
    ['nanoseconds', (elapsedMs) => elapsedMs * 1000000],
  ];

  for (const [name, rawTimestamp] of variants) {
    const page = bootRunning();
    bypassImuArming(page);
    const accel = FakeAccelerometer.instances[0];
    const stepMs = 353;
    const startedAt = Date.now();
    let elapsedMs = 0;
    const origNow = Date.now;
    try {
      for (let index = 0; index < 30; index += 1) {
        Date.now = () => startedAt + elapsedMs;
        accel.emitReading(0, 0, 12.5, rawTimestamp(elapsedMs));
        elapsedMs += stepMs / 2;
        Date.now = () => startedAt + elapsedMs;
        accel.emitReading(0, 0, 8.5, rawTimestamp(elapsedMs));
        elapsedMs += stepMs / 2;
      }
      Date.now = () => startedAt + elapsedMs;
      page.tick();
    } finally {
      Date.now = origNow;
    }
    const cadence = Number(page.data.cadence);
    assert.ok(
      cadence >= 150 && cadence <= 190,
      `${name} timestamp 不应让眼镜估算步频归零，实际 ${page.data.cadence}`,
    );
    assert.ok(page.motionMetrics.distanceM > 0);
  }
});

test('AIUI 0.15 若加速度以 1g 为单位，立即起跑也会校准后稳定计步', () => {
  const page = bootRunning();
  const accel = FakeAccelerometer.instances[0];
  const sampleHz = 50;
  const cadenceSpm = 172;
  const startedAt = Date.now();
  const origNow = Date.now;
  let elapsedMs = 0;
  try {
    for (let index = 0; index < sampleHz * 12; index += 1) {
      elapsedMs = index * (1000 / sampleHz);
      Date.now = () => startedAt + elapsedMs;
      const stepWave = 0.16
        * Math.sin(2 * Math.PI * (cadenceSpm / 60) * (elapsedMs / 1000));
      accel.emitReading(0, 0, 1 + stepWave, elapsedMs);
    }
    Date.now = () => startedAt + elapsedMs;
    page.tick();
  } finally {
    Date.now = origNow;
  }
  const calibration = page.sensorAlignment.accelerationCalibrator.snapshot();
  assert.equal(calibration.sourceUnit, 'g');
  assert.ok(Number(page.data.cadence) >= 160 && Number(page.data.cadence) <= 185);
  assert.ok(page.motionMetrics.distanceM > 0);
});

test('录屏把回调降到 10Hz 时仍能识别 1g，采样恢复后无需切页即可出步频', () => {
  const page = bootRunning();
  const accel = FakeAccelerometer.instances[0];
  const cadenceSpm = 168;
  const startedAt = Date.now();
  const origNow = Date.now;
  let elapsedMs = 0;
  try {
    // 先模拟录屏负载下的 10Hz best-effort 回调。这个阶段只要求单位不再
    // 永久 unknown；低采样率下不强迫算法承诺精确实时步频。
    for (let index = 0; index < 10 * 5; index += 1) {
      elapsedMs = index * 100;
      Date.now = () => startedAt + elapsedMs;
      const wave = 0.15
        * Math.sin(2 * Math.PI * (cadenceSpm / 60) * (elapsedMs / 1000));
      accel.emitReading(0, 0, 1 + wave, elapsedMs);
    }
    assert.equal(
      page.sensorAlignment.accelerationCalibrator.snapshot().sourceUnit,
      'g',
    );

    // 录屏结束后宿主恢复 50Hz；不触发 onHide/onShow、不重建页面，也应由
    // 同一 sensor generation 自然完成活动确认并形成 HUD 步频。
    const restoredAtMs = elapsedMs + 20;
    for (let index = 0; index < 50 * 10; index += 1) {
      elapsedMs = restoredAtMs + index * 20;
      Date.now = () => startedAt + elapsedMs;
      const wave = 0.15
        * Math.sin(2 * Math.PI * (cadenceSpm / 60) * (elapsedMs / 1000));
      accel.emitReading(0, 0, 1 + wave, elapsedMs);
    }
    Date.now = () => startedAt + elapsedMs;
    page.tick();
  } finally {
    Date.now = origNow;
  }

  assert.ok(
    Number(page.data.cadence) >= 155 && Number(page.data.cadence) <= 185,
    `采样恢复后步频不应继续卡在占位，实际 ${page.data.cadence}`,
  );
  assert.ok(page.motionMetrics.distanceM > 0);
});

test('录屏持续把 Generic Sensor 降到 8/10/12Hz，纯 IMU 30 秒仍形成步数、步频、距离和总结', () => {
  for (const sampleHz of [8, 10, 12]) {
    const page = bootRunning({ withMotion15: true });
    page.stopTicker();
    const accel = FakeAccelerometer.instances.at(-1);
    const gyro = FakeGyroscope.instances.at(-1);
    const orientation = FakeAbsoluteOrientationSensor.instances.at(-1);
    const startedAt = Date.now();
    const originalNow = Date.now;
    const sampleIntervalMs = 1000 / sampleHz;
    let elapsedMs = 0;
    try {
      // 先用同一低回调率建立单位/静止基线，再喂录屏负载下较弱的真实
      // 168spm 头戴波形。0.05g 在旧链路中会因采样相位而长期 --。
      for (; elapsedMs < 3000; elapsedMs += sampleIntervalMs) {
        Date.now = () => startedAt + elapsedMs;
        orientation.emitReading([0, 0, 0, 1], elapsedMs);
        gyro.emitReading(0.005, 0.004, 0.003, elapsedMs);
        accel.emitReading(0, 0, 1, elapsedMs);
      }
      const movementStartedAt = elapsedMs;
      for (; elapsedMs < movementStartedAt + 10000;
        elapsedMs += sampleIntervalMs) {
        Date.now = () => startedAt + elapsedMs;
        const phase = 2 * Math.PI * (168 / 60)
          * ((elapsedMs - movementStartedAt) / 1000);
        orientation.emitReading([0, 0, 0, 1], elapsedMs);
        gyro.emitReading(0.04, 0.03, 0.02, elapsedMs);
        accel.emitReading(
          0,
          0,
          1 + 0.05 * Math.sin(phase),
          elapsedMs,
        );
      }
      const acceptedAfterWarmup = page.motionMetrics.acceptedSteps;
      for (; elapsedMs < movementStartedAt + 30000;
        elapsedMs += sampleIntervalMs) {
        Date.now = () => startedAt + elapsedMs;
        const phase = 2 * Math.PI * (168 / 60)
          * ((elapsedMs - movementStartedAt) / 1000);
        orientation.emitReading([0, 0, 0, 1], elapsedMs);
        gyro.emitReading(0.04, 0.03, 0.02, elapsedMs);
        accel.emitReading(
          0,
          0,
          1 + 0.05 * Math.sin(phase),
          elapsedMs,
        );
      }
      Date.now = () => startedAt + elapsedMs;
      page.tick();
      const steadyAcceptedSteps = page.motionMetrics.acceptedSteps
        - acceptedAfterWarmup;
      assert.ok(
        page.motionMetrics.acceptedSteps >= 45,
        `${sampleHz}Hz 应形成 acceptedSteps，实际 ${page.motionMetrics.acceptedSteps}`,
      );
      assert.ok(
        steadyAcceptedSteps >= 52 && steadyAcceptedSteps <= 60,
        `${sampleHz}Hz 稳态 20 秒应接近真实 56 步，实际 ${steadyAcceptedSteps}`,
      );
      assert.ok(
        Number(page.data.cadence) >= 158
          && Number(page.data.cadence) <= 178,
        `${sampleHz}Hz 真值 168spm 不应被回调网格量化，实际 ${page.data.cadence}`,
      );
      assert.ok(
        page.motionMetrics.distanceM >= 25,
        `${sampleHz}Hz 应形成正距离，实际 ${page.motionMetrics.distanceM}`,
      );
      assert.ok(
        page.motionDiagnostics.lowRateSteps >= 40,
        `${sampleHz}Hz 应由低频安全链补足稳定节奏`,
      );
      assert.notEqual(page.data.pace, '-:00');
      const [paceMinutes, paceSeconds] = page.data.pace.split(':').map(Number);
      const actualPaceSec = paceMinutes * 60 + paceSeconds;
      const expectedPaceSec = 60000
        / (168 * Number(page.activeStepLengthM || 0.85));
      assert.ok(
        Math.abs(actualPaceSec - expectedPaceSec)
          <= Math.max(5, expectedPaceSec * 0.08),
        `${sampleHz}Hz 纯 IMU 配速应跟随终态步频，实际 ${actualPaceSec}s，预期 ${expectedPaceSec}s`,
      );

      assert.equal(page.finishRunToSummary(), true);
      assert.match(page.data.sumPace, /^\d+:\d{2}$/);
      assert.match(page.data.sumStat, /^\d+$/);
      assert.ok(
        Number(page.data.sumStat) >= 158
          && Number(page.data.sumStat) <= 178,
        `${sampleHz}Hz 总结平均步频应接近 168spm，实际 ${page.data.sumStat}`,
      );
      assert.ok(Number(page.data.sumDist) > 0);
    } finally {
      Date.now = originalNow;
    }
  }
});

test('8/10/12Hz 静坐低幅漂移不会因低频补偿生成 accepted step', () => {
  for (const sampleHz of [8, 10, 12]) {
    const page = bootRunning({ withMotion15: true });
    page.stopTicker();
    const accel = FakeAccelerometer.instances.at(-1);
    const gyro = FakeGyroscope.instances.at(-1);
    const orientation = FakeAbsoluteOrientationSensor.instances.at(-1);
    const startedAt = Date.now();
    const originalNow = Date.now;
    const sampleIntervalMs = 1000 / sampleHz;
    let elapsedMs = 0;
    try {
      for (; elapsedMs < 30000; elapsedMs += sampleIntervalMs) {
        Date.now = () => startedAt + elapsedMs;
        const drift = 0.014 * Math.sin(2 * Math.PI * 0.7 * elapsedMs / 1000)
          + 0.003 * Math.sin(elapsedMs * 0.017);
        orientation.emitReading([0, 0, 0, 1], elapsedMs);
        gyro.emitReading(0.004, 0.003, 0.002, elapsedMs);
        accel.emitReading(0, 0, 1 + drift, elapsedMs);
      }
      Date.now = () => startedAt + elapsedMs;
      page.tick();
    } finally {
      Date.now = originalNow;
    }
    assert.equal(
      page.motionMetrics.acceptedSteps,
      0,
      `${sampleHz}Hz 静坐不得被低频检测器误计`,
    );
    assert.equal(page.motionMetrics.distanceM, 0);
    assert.equal(page.data.cadence, '--');
    assert.equal(page.cadenceEverReady, false);
  }
});

test('8/10/12Hz 低频纯 IMU 短停顿不补步，恢复后重新确认节奏并继续累计', () => {
  for (const sampleHz of [8, 10, 12]) {
    const page = bootRunning({ withMotion15: true });
    page.stopTicker();
    const accel = FakeAccelerometer.instances.at(-1);
    const gyro = FakeGyroscope.instances.at(-1);
    const orientation = FakeAbsoluteOrientationSensor.instances.at(-1);
    const startedAt = Date.now();
    const originalNow = Date.now;
    const sampleIntervalMs = 1000 / sampleHz;
    let elapsedMs = 0;
    const emit = (moving, movementBaseMs) => {
      Date.now = () => startedAt + elapsedMs;
      const phase = 2 * Math.PI * (168 / 60)
        * ((elapsedMs - movementBaseMs) / 1000);
      orientation.emitReading([0, 0, 0, 1], elapsedMs);
      gyro.emitReading(
        moving ? 0.04 : 0.005,
        moving ? 0.03 : 0.004,
        moving ? 0.02 : 0.003,
        elapsedMs,
      );
      accel.emitReading(
        0,
        0,
        moving ? 1 + 0.05 * Math.sin(phase) : 1,
        elapsedMs,
      );
      elapsedMs += sampleIntervalMs;
    };
    try {
      for (let index = 0; index < sampleHz * 3; index += 1) {
        emit(false, 0);
      }
      const firstMovementAt = elapsedMs;
      for (let index = 0; index < sampleHz * 12; index += 1) {
        emit(true, firstMovementAt);
      }
      const beforePause = page.motionMetrics.acceptedSteps;
      // 三点局部峰天然延迟一个真实回调确认，停顿首 500ms 最多允许把
      // 最后一枚运动峰提交一次；进入稳定停顿后绝不能继续补步。
      for (let index = 0; index < Math.ceil(sampleHz * 0.5); index += 1) {
        emit(false, 0);
      }
      const pauseBoundary = page.motionMetrics.acceptedSteps;
      for (let index = 0; index < Math.ceil(sampleHz * 2); index += 1) {
        emit(false, 0);
      }
      const afterPause = page.motionMetrics.acceptedSteps;
      const secondMovementAt = elapsedMs;
      for (let index = 0; index < sampleHz * 12; index += 1) {
        emit(true, secondMovementAt);
      }
      Date.now = () => startedAt + elapsedMs;
      page.tick();

      assert.ok(beforePause >= 20, `${sampleHz}Hz 首段应完成活动确认`);
      assert.ok(
        pauseBoundary <= beforePause + 1,
        `${sampleHz}Hz 停顿边界最多确认最后一个真实峰`,
      );
      assert.equal(
        afterPause,
        pauseBoundary,
        `${sampleHz}Hz 稳定停顿期间不得补造步数`,
      );
      assert.ok(
        page.motionMetrics.acceptedSteps >= afterPause + 20,
        `${sampleHz}Hz 恢复后应重新确认并继续累计`,
      );
      assert.match(page.data.cadence, /^\d+$/);
      assert.notEqual(page.data.pace, '-:00');
    } finally {
      Date.now = originalNow;
    }
  }
});

test('眼镜弱振幅跑动叠加姿态漂移与 null timestamp 时仍能形成步频，静止噪声不造步', () => {
  const page = bootRunning();
  const accel = FakeAccelerometer.instances[0];
  const sampleHz = 50;
  const cadenceSpm = 172;
  const startedAt = Date.now();
  const origNow = Date.now;
  let elapsedMs = 0;
  try {
    for (let index = 0; index < sampleHz * 20; index += 1) {
      elapsedMs = index * (1000 / sampleHz);
      Date.now = () => startedAt + elapsedMs;
      const cadenceWave = Math.sin(2 * Math.PI * (cadenceSpm / 60) * (elapsedMs / 1000));
      const postureDrift = 0.35 * Math.sin(2 * Math.PI * 0.08 * (elapsedMs / 1000));
      accel.emitReading(0, 0, 9.80665 + postureDrift + cadenceWave, null);
    }
    Date.now = () => startedAt + elapsedMs;
    page.tick();
  } finally {
    Date.now = origNow;
  }
  assert.ok(Number(page.data.cadence) >= 160, `弱振幅步频实际为 ${page.data.cadence}`);
  assert.ok(page.motionMetrics.distanceM > 0);

  const quietPage = bootRunning();
  const quietAccel = FakeAccelerometer.instances.at(-1);
  const quietStartedAt = Date.now();
  const quietNow = Date.now;
  try {
    for (let index = 0; index < sampleHz * 10; index += 1) {
      const at = index * (1000 / sampleHz);
      Date.now = () => quietStartedAt + at;
      quietAccel.emitReading(0, 0, 9.80665 + 0.25 * Math.sin(index * 0.37), null);
    }
  } finally {
    Date.now = quietNow;
  }
  assert.equal(quietPage.stepDet.steps, 0);
});

test('检测到起跑后停下持续显示本场总配速，当前步频长停后恢复占位', () => {
  const page = bootRunning();
  const startMs = page.motionMetrics.startMs;
  const origNow = Date.now;
  try {
    for (let step = 1; step <= 20; step += 1) {
      page.motionMetrics.onAcceptedStep(startMs + step * 500, 120);
    }
    Date.now = () => startMs + 10000;
    page.tick();
    assert.match(page.data.pace, /^\d{1,2}:\d{2}$/);

    Date.now = () => startMs + 30000;
    page.tick();
    const stoppedPace = page.data.pace;
    assert.match(stoppedPace, /^\d+:\d{2}$/,
      '已经形成过有效节奏后，停步 HUD 应显示本场总配速而不是 -:00');
    assert.equal(page.data.cadence, '--',
      '长时间停步应显示当前状态，不能用全程平均锁存旧步频');
    assert.notEqual(stoppedPace, '等待运动');
    assert.notEqual(page.data.paceStateClass, 'run-value-pending');
    assert.equal(page.data.paceConnected, false);
    assert.equal(
      wx.store.get(LIVE_SNAPSHOT_KEY).paceSecPerKm,
      undefined,
      '停步估算总配速只供 HUD/总结，不得冒充教练读取的当前配速',
    );

    Date.now = () => startMs + 10 * 60 * 1000;
    page.tick();
    assert.equal(page.data.pace, stoppedPace, '停步等待不得复活陈旧实时配速');
    assert.ok(Number.isFinite(page.motionMetrics.snapshot(Date.now()).avgPaceSecPerKm),
      '全程平均配速仍应保留给跑后总结');
  } finally {
    Date.now = origNow;
  }
});

test('三次确认进放松后异步写跑步摘要与待传队列且幂等;ready 误进误出不入队', async () => {
  const waiting = boot();
  waiting.onKeyUp({ code: 'Backspace' });
  assert.equal(wx.store.has('pending_run_uploads'), false);

  const page = bootRunning();
  page.session.startMs = Date.now() - 300000;
  assert.equal(finishHudWithThreeIndependentConfirms(page), true);
  assert.equal(page.data.surfacePhase, 'recovery');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const queue = wx.store.get('pending_run_uploads');
  assert.equal(queue.length, 1);
  assert.equal(queue[0].source, 'aiui');
  assert.ok(queue[0].duration_s >= 299 && queue[0].duration_s <= 301);
  page.onUnload();
  assert.equal(wx.store.get('pending_run_uploads').length, 1);
});

test('总结页 finalizer 直接上传本场汇总，不要求再次打开首页', async () => {
  const page = bootRunning();
  page.stopTicker();
  page.session.startMs = Date.now() - 300000;
  // 本例只验证汇总上传状态；校准上传在独立用例覆盖。
  page.calibrationStream = null;
  page.calibrationCaptureBuffer = [];
  cacheTestOwnerIdentity(page, 'summary-direct-run-token');
  const requests = [];
  wx.requestImpl = (opts) => {
    requests.push(opts);
    if (opts.url.endsWith('/coach/aiui-runs')) {
      opts.success({
        statusCode: 200,
        data: JSON.stringify({ id: 901, source: 'aiui' }),
      });
      return;
    }
    opts.fail(new Error('unexpected request'));
  };

  assert.equal(page.finishRunToSummary(), true);
  assert.equal(page.data.summaryUploadText, '日志整理中',
    '总结首帧尚未跨 storage 桥时不能提前宣称已保存');
  assert.equal(page.data.sumAiState, '本地总结',
    'Hermes 状态必须独立于本地/AI 点评状态');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushAsync();

  const runRequests = requests.filter(
    (request) => request.url.endsWith('/coach/aiui-runs'),
  );
  assert.equal(runRequests.length, 1);
  assert.equal(
    runRequests[0].header.Authorization,
    'Bearer summary-direct-run-token',
  );
  assert.equal(runRequests[0].data.source, 'aiui');
  assert.match(runRequests[0].data.client_run_id, /^run-/);
  assert.deepEqual(readPendingRunUploads(wx), [],
    '后端明确返回 run id 后才从本地 durable 队列 ACK 删除');
  assert.equal(page.data.summaryUploadText, 'Hermes 已上传 · 1条');
  assert.equal(page.data.sumAiState, '本地总结',
    '上传成功不得把 AI 点评 chip 改写成网络状态');
  const receipts = readRunUploadReceipts(wx);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].client_run_id, runRequests[0].data.client_run_id);
  assert.equal(receipts[0].acked_count, 1);
  assert.equal(receipts[0].matched_count, 0);
  assert.equal(receipts[0].remaining_count, 0);
  const serialized = JSON.stringify(wx.store.get(RUN_UPLOAD_RECEIPTS_KEY));
  for (const forbidden of [
    'token', 'device_id', 'public_device_id', 'latitude', 'longitude',
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test('总结页缺少缓存 token 时先 bootstrap 长期身份，再统一启动三条补传链', async () => {
  const page = freshPage();
  page.onLoad();
  pagesToClean.push(page);
  ensureTestRunOwner();
  page.summaryEnteredAtMs = Date.now();
  page.setData({ surfacePhase: 'summary' });
  page.deviceIdentityCache = null;
  let refreshCalls = 0;
  let runFlushes = 0;
  let calibrationFlushes = 0;
  let workoutFlushes = 0;
  page.refreshDeviceIdentity = async () => {
    refreshCalls += 1;
    return cacheTestOwnerIdentity(page, 'summary-cold-bootstrap-token');
  };
  page.flushRunUploads = () => { runFlushes += 1; return Promise.resolve(true); };
  page.flushAiuiCalibrationUploads = () => {
    calibrationFlushes += 1;
    return Promise.resolve(true);
  };
  page.flushWorkoutCompletions = () => {
    workoutFlushes += 1;
    return Promise.resolve(true);
  };

  assert.equal(await page.startSummaryHermesUploads(true), true);
  assert.equal(refreshCalls, 1);
  assert.equal(runFlushes, 1);
  assert.equal(calibrationFlushes, 1);
  assert.equal(workoutFlushes, 1);
});

test('永久拒绝进入隔离区后不再假装待补传，而是明确显示部分需诊断', () => {
  const page = freshPage();
  page.onLoad();
  pagesToClean.push(page);
  ensureTestRunOwner();
  const queued = enqueueRunUpload(wx, {
    started_at: new Date(Date.now() - 60_000).toISOString(),
    ended_at: new Date().toISOString(),
    duration_s: 60,
    distance_m: 100,
    source: 'aiui',
  });
  assert.ok(queued && queued.length === 1);
  const run = queued[0];
  assert.ok(quarantineRunUpload(wx, run, 422));
  wx.removeStorageSync(PENDING_RUNS_KEY);
  page.summaryClientRunId = run.client_run_id;
  page.summaryEnteredAtMs = Date.now();
  page.setData({ surfacePhase: 'summary' });

  assert.equal(page.summaryHermesPending(), false);
  assert.equal(page.summaryHermesNeedsDiagnostic(), true);
  page.refreshSummaryHermesState(false);
  assert.equal(page.data.summaryUploadText, '日志已保存 · 部分需诊断');
  assert.ok(Array.isArray(wx.store.get(QUARANTINED_RUN_UPLOADS_KEY)));
});

test('总结页 pending/quarantine storage unknown 时不假同步', () => {
  const page = freshPage();
  page.onLoad();
  pagesToClean.push(page);
  ensureTestRunOwner();
  page.summaryClientRunId = 'run-summary-storage-unknown-0001';
  page.summaryCalibrationStreamId = 'aiui_summary_storage_unknown_0001';
  page.summaryEnteredAtMs = Date.now();
  page.setData({ surfacePhase: 'summary' });

  wx.store.set(PENDING_AIUI_CALIBRATION_KEY, { corrupted: true });
  assert.equal(page.summaryHermesPending(), true,
    'pending unknown 必须保持待补传，不能解释为空队列');
  page.refreshSummaryHermesState(false);
  assert.equal(page.data.summaryUploadText, '日志已保存 · 待补传');

  wx.removeStorageSync(PENDING_AIUI_CALIBRATION_KEY);
  wx.store.set(QUARANTINED_RUN_UPLOADS_KEY, { corrupted: true });
  wx.store.set(QUARANTINED_AIUI_CALIBRATION_KEY, { corrupted: true });
  assert.equal(page.summaryHermesPending(), false);
  assert.equal(page.summaryHermesNeedsDiagnostic(), true,
    '隔离区 unknown 必须显示诊断态，不能宣称 Hermes 已同步');
  page.refreshSummaryHermesState(false);
  assert.equal(page.data.summaryUploadText, '日志已保存 · 部分需诊断');
});

test('总结页独立显示上传中；网络失败后保留同一队列并显示待补传', async () => {
  const page = bootRunning();
  page.stopTicker();
  page.session.startMs = Date.now() - 300000;
  page.calibrationStream = null;
  page.calibrationCaptureBuffer = [];
  cacheTestOwnerIdentity(page, 'summary-pending-run-token');
  let settleRequest;
  page.deviceWxRequest = () => new Promise((resolve) => {
    settleRequest = resolve;
  });

  assert.equal(page.finishRunToSummary(), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushAsync();
  assert.equal(page.data.summaryUploadText, '日志已保存 · 上传中');
  assert.equal(page.data.sumAiState, '本地总结');
  assert.match(runHudSource, /\{\{\s*summaryUploadText\s*\}\}/,
    '结束页必须渲染独立上传字段，不能复用 sumAiState');

  const flight = page.summaryHermesFlight;
  settleRequest({ statusCode: 0, data: '', errMsg: 'network offline' });
  await flight;
  assert.equal(page.data.summaryUploadText, '日志已保存 · 待补传');
  assert.equal(readPendingRunUploads(wx).length, 1,
    '无服务端 run id 时原幂等记录必须留在 durable FIFO');
  assert.equal(readRunUploadReceipts(wx).length, 0,
    '网络失败不能伪造 Hermes 成功回执');
});

test('沉浸页跑步上传 single-flight，401 后只 bootstrap 一次并原位重试同一幂等键', async () => {
  const page = bootRunning();
  page.stopTicker();
  page.session.startMs = Date.now() - 300000;
  cacheTestOwnerIdentity(page, 'summary-old-run-token');
  assert.equal(page.queueRunForUpload(), true);
  const queued = readPendingRunUploads(wx);
  assert.equal(queued.length, 1);

  let refreshCalls = 0;
  page.refreshDeviceIdentity = async () => {
    refreshCalls += 1;
    wx.store.set(DEVICE_TOKEN_STORAGE_KEY, 'summary-new-run-token');
    const identity = testOwnerIdentity('summary-new-run-token');
    page.deviceIdentityCache = identity;
    return identity;
  };
  const postedIds = [];
  wx.requestImpl = (opts) => {
    if (!opts.url.endsWith('/coach/aiui-runs')) {
      opts.fail(new Error('unexpected request'));
      return;
    }
    postedIds.push(opts.data.client_run_id);
    if (opts.header.Authorization === 'Bearer summary-old-run-token') {
      opts.success({ statusCode: 401, data: '{}' });
    } else {
      assert.equal(
        opts.header.Authorization,
        'Bearer summary-new-run-token',
      );
      opts.success({ statusCode: 200, data: JSON.stringify({ id: 902 }) });
    }
  };

  const first = page.flushRunUploads();
  const duplicate = page.flushRunUploads();
  assert.equal(duplicate, first, '同一 owner 的并发总结上传必须复用一个 flight');
  assert.equal(await first, true);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(postedIds, [
    queued[0].client_run_id,
    queued[0].client_run_id,
  ]);
  assert.equal(wx.store.has(PENDING_RUNS_KEY), false);
});

test('沉浸页跑步上传 Promise 拒绝会安全收敛并保留 durable FIFO', async () => {
  const page = boot();
  ensureTestRunOwner();
  cacheTestOwnerIdentity(page, 'summary-reject-run-token');
  const item = {
    started_at: new Date(Date.now() - 300000).toISOString(),
    ended_at: new Date().toISOString(),
    duration_s: 300,
    distance_m: 700,
    source: 'aiui',
  };
  assert.ok(enqueueRunUpload(wx, item));
  page.deviceWxRequest = async () => {
    throw new Error('future host promise rejection');
  };

  assert.equal(await page.flushRunUploads(), false);
  assert.equal(readPendingRunUploads(wx).length, 1);
  assert.equal(page.runUploadFlushFlight, null,
    '拒绝后的 flight 必须释放，但不能形成未处理 rejection 或假 ACK');
});

test('旧 owner 跑步上传的 200/401 迟到都不能 ACK 新 owner 队列或清新 token', async (t) => {
  for (const statusCode of [200, 401]) {
    await t.test(String(statusCode), async () => {
      const page = boot();
      ensureTestRunOwner();
      cacheTestOwnerIdentity(page, 'run-owner-a-token');
      const ownerA = {
        started_at: new Date(Date.now() - 300000).toISOString(),
        ended_at: new Date().toISOString(),
        duration_s: 300,
        distance_m: 700,
        source: 'aiui',
        client_run_id: 'run-owner-a-0001',
      };
      assert.ok(enqueueRunUpload(wx, ownerA));
      let resolveOwnerA;
      page.deviceWxRequest = () => new Promise((resolve) => {
        resolveOwnerA = resolve;
      });

      const uploadOwnerA = page.flushRunUploads();
      await flushAsync();

      const ownerB = {
        ...ownerA,
        started_at: new Date(Date.now() - 120000).toISOString(),
        ended_at: new Date().toISOString(),
        duration_s: 120,
        distance_m: 260,
        client_run_id: 'run-owner-b-0001',
      };
      wx.store.set(PUBLIC_DEVICE_ID_STORAGE_KEY, 'device-owner-b');
      wx.store.set(DEVICE_BINDING_STORAGE_KEY, {
        bound: true,
        ownershipEpoch: 9,
        dataNamespace: 'owner-b',
      });
      wx.store.set(DEVICE_TOKEN_STORAGE_KEY, 'run-owner-b-token');
      wx.store.set(PENDING_RUNS_KEY, [ownerB]);

      resolveOwnerA(statusCode === 401
        ? { statusCode: 401, data: '{}' }
        : { statusCode: 200, data: JSON.stringify({ id: 903 }) });
      assert.equal(await uploadOwnerA, false);

      assert.deepEqual(
        readPendingRunUploads(wx).map((item) => item.client_run_id),
        ['run-owner-b-0001'],
      );
      assert.equal(wx.store.get(DEVICE_TOKEN_STORAGE_KEY), 'run-owner-b-token');
    });
  }
});

test('跑后队列静默写失败不置 runUploadQueued，恢复后可用同一会话重试', () => {
  const page = bootRunning();
  page.session.startMs = Date.now() - 300000;
  const baseSet = wx.setStorageSync.bind(wx);
  wx.setStorageSync = (key, value) => {
    if (key === 'pending_run_uploads') return;
    baseSet(key, value);
  };
  page.queueRunForUpload();
  assert.equal(page.runUploadQueued, false, '上传队列未读回前不得置幂等棘轮');
  assert.equal(wx.store.has('pending_run_uploads'), false);
  assert.ok(wx.store.get('pending_run_summary'), '独立总结待办仍可先成功落盘');

  wx.setStorageSync = baseSet;
  page.queueRunForUpload();
  assert.equal(page.runUploadQueued, true);
  assert.equal(wx.store.get('pending_run_uploads').length, 1);
});

test('owner journal 未完成时 HUD 不写快照、总结、跑完提示或上传队列', () => {
  const page = bootRunning();
  page.session.startMs = Date.now() - 300000;
  wx.store.set(OWNER_TRANSITION_PENDING_STORAGE_KEY, {
    bound: false, ownershipEpoch: 6, dataNamespace: 'owner-next',
  });
  wx.store.set('pending_run_summary', { text: 'old private summary' });
  const baseRemove = wx.removeStorageSync.bind(wx);
  const baseSet = wx.setStorageSync.bind(wx);
  wx.removeStorageSync = (key) => {
    if (key === 'pending_run_summary') return;
    baseRemove(key);
  };
  wx.setStorageSync = (key, value) => {
    if (key === 'pending_run_summary' && value === '') return;
    baseSet(key, value);
  };

  finishHudWithThreeIndependentConfirms(page);
  assert.equal(wx.store.has('pending_run_uploads'), false);
  assert.equal(wx.store.get('pending_run_summary').text, 'old private summary',
    '未知归属下不得用本场总结覆盖旧 owner 数据');
  assert.equal(wx.store.has('aiui_run_finished_at'), false);
  assert.equal(wx.store.has(LIVE_SNAPSHOT_KEY), false);
  assert.equal(typeof wx.store.get(OWNER_TRANSITION_PENDING_STORAGE_KEY), 'object');

  wx.removeStorageSync = baseRemove;
  wx.setStorageSync = baseSet;
});

test('总结退出遇到瞬时 storage 失败会先重试，确认整场本地队列后才关闭', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = bootRunning();
  t.after(() => page.onUnload());
  page.stopTicker();
  page.session.startMs = Date.now() - 300000;
  const originalPersist = page.persistAiuiCalibrationBuffer.bind(page);
  let persistAttempts = 0;
  page.persistAiuiCalibrationBuffer = () => {
    persistAttempts += 1;
    if (persistAttempts <= 2) return false;
    return originalPersist();
  };
  let calibrationFlushes = 0;
  page.flushAiuiCalibrationUploads = () => {
    calibrationFlushes += 1;
    return Promise.resolve(true);
  };

  assert.equal(page.finishRunToSummary(), true);
  if (page.summaryFinalizeTimer) clearTimeout(page.summaryFinalizeTimer);
  page.summaryFinalizeTimer = null;
  assert.ok(page.calibrationCaptureBuffer.length >= 1);
  assert.equal(page.closeAgentFromSummary('summary-backspace'), true);
  assert.equal(wx.exitMiniProgramCalls, 0,
    '首次 storage 未确认时不得提前退出');
  assert.equal(page.data.summaryExitText, '正在保存，请稍候');

  t.mock.timers.tick(120);
  await flushAsync();
  await flushAsync();

  assert.ok(persistAttempts >= 3);
  assert.deepEqual(page.calibrationCaptureBuffer, []);
  assert.equal(calibrationFlushes, 1);
  assert.equal(wx.exitMiniProgramCalls, 1,
    '写后读回成功后可立即完成既有清理并退出');
});

test('总结 storage 持续失败时保留内存样本和页面，下一次返回可重试成功', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = bootRunning();
  t.after(() => page.onUnload());
  page.stopTicker();
  page.session.startMs = Date.now() - 300000;
  const originalPersist = page.persistAiuiCalibrationBuffer.bind(page);
  page.persistAiuiCalibrationBuffer = () => false;
  page.flushAiuiCalibrationUploads = () => Promise.resolve(true);

  assert.equal(page.finishRunToSummary(), true);
  if (page.summaryFinalizeTimer) clearTimeout(page.summaryFinalizeTimer);
  page.summaryFinalizeTimer = null;
  const bufferedCount = page.calibrationCaptureBuffer.length;
  assert.ok(bufferedCount >= 1);
  assert.equal(page.closeAgentFromSummary('summary-backspace'), true);

  for (let retry = 0; retry < 4; retry += 1) {
    t.mock.timers.tick(120);
    await flushAsync();
  }
  await flushAsync();

  assert.equal(wx.exitMiniProgramCalls, 0);
  assert.equal(page.agentExitRequested, false);
  assert.equal(page.backspaceHandled, false);
  assert.equal(page.pageVisible, true);
  assert.equal(page.calibrationCaptureBuffer.length, bufferedCount,
    'storage 不可用不得清空本场内存采样');
  assert.equal(page.data.summaryExitText, '保存失败，请再按返回重试');

  page.persistAiuiCalibrationBuffer = originalPersist;
  assert.equal(page.closeAgentFromSummary('summary-backspace'), true);
  await flushAsync();
  await flushAsync();
  assert.deepEqual(page.calibrationCaptureBuffer, []);
  assert.equal(wx.exitMiniProgramCalls, 1);
});

test('全新安装首次离线跑步使用本地待归属域，首次服务器身份接管后记录仍保留', () => {
  const page = boot();
  page.entrySequenceStarted = true;
  page.entrySequenceCompleted = true;
  page.bleConnectionRequested = true;
  page.setData({ surfacePhase: 'hud' });
  page.startRun();
  page.stopTicker();

  assert.deepEqual(page.runOwnerContext, { kind: 'preidentity' });
  assert.equal(
    wx.store.get(PREIDENTITY_OWNER_STORAGE_KEY),
    PREIDENTITY_OWNER_VALUE,
  );
  page.session.startMs = Date.now() - 300000;
  assert.equal(page.queueRunForUpload(), true);
  assert.ok(wx.store.get('pending_run_summary'));
  assert.equal(wx.store.get('pending_run_uploads').length, 1);
  const queuedPrivateData = JSON.stringify({
    summary: wx.store.get('pending_run_summary'),
    uploads: wx.store.get('pending_run_uploads'),
  });
  assert.equal(queuedPrivateData.includes(PREIDENTITY_OWNER_STORAGE_KEY), false);
  assert.equal(queuedPrivateData.includes(PREIDENTITY_OWNER_VALUE), false,
    '本地 sentinel 绝不能进入待上传 payload');

  // 模拟首次联网 bootstrap 完整提交匿名 owner。既没有旧 public identity，
  // 也没有旧用户 proof，因此待归属记录安全归入第一位服务器 owner。
  wx.store.set(PUBLIC_DEVICE_ID_STORAGE_KEY, 'device-first-server-owner');
  wx.store.set(DEVICE_BINDING_STORAGE_KEY, {
    bound: false,
    ownershipEpoch: 1,
    dataNamespace: 'anon-first-server-owner',
  });
  wx.store.set(
    IDENTITY_EVER_ACTIVATED_STORAGE_KEY,
    IDENTITY_EVER_ACTIVATED_VALUE,
  );
  wx.store.delete(PREIDENTITY_OWNER_STORAGE_KEY);
  assert.equal(page.ownerScopedRunWriteAllowed(), true);
  assert.deepEqual(page.runOwnerContext, {
    publicDeviceId: 'device-first-server-owner',
    bound: false,
    ownershipEpoch: 1,
    dataNamespace: 'anon-first-server-owner',
  });
  assert.ok(wx.store.get('pending_run_summary'));
  assert.equal(wx.store.get('pending_run_uploads').length, 1);
});

test('缺少 preidentity marker 但存在孤儿私有数据时 fail closed', () => {
  const page = boot();
  const orphan = [{ client_run_id: 'run-orphan-private' }];
  wx.store.set('pending_run_uploads', orphan);
  page.entrySequenceStarted = true;
  page.entrySequenceCompleted = true;
  page.bleConnectionRequested = true;
  page.setData({ surfacePhase: 'hud' });
  page.startRun();
  page.stopTicker();

  assert.equal(page.runOwnerContext, null);
  assert.equal(wx.store.has(PREIDENTITY_OWNER_STORAGE_KEY), false);
  assert.deepEqual(wx.store.get('pending_run_uploads'), orphan,
    '未知归属私有数据只封闭，不能擅自归属或删除');
  page.session.startMs = Date.now() - 300000;
  assert.equal(page.queueRunForUpload(), false);
  assert.deepEqual(wx.store.get('pending_run_uploads'), orphan);
});

test('身份曾激活后即使 active 键丢失也不可回退到 preidentity', () => {
  const page = boot();
  wx.store.set(
    IDENTITY_EVER_ACTIVATED_STORAGE_KEY,
    IDENTITY_EVER_ACTIVATED_VALUE,
  );
  page.entrySequenceStarted = true;
  page.entrySequenceCompleted = true;
  page.bleConnectionRequested = true;
  page.setData({ surfacePhase: 'hud' });
  page.startRun();
  page.stopTicker();

  assert.equal(page.runOwnerContext, null);
  assert.equal(wx.store.has(PREIDENTITY_OWNER_STORAGE_KEY), false);
  page.session.startMs = Date.now() - 300000;
  assert.equal(page.queueRunForUpload(), false);
  assert.equal(wx.store.has('pending_run_summary'), false);
});

test('残缺旧身份不能伪装成全新安装待归属域', () => {
  const page = boot();
  wx.store.set(PUBLIC_DEVICE_ID_STORAGE_KEY, 'stale-public-without-binding');
  page.entrySequenceStarted = true;
  page.entrySequenceCompleted = true;
  page.bleConnectionRequested = true;
  page.setData({ surfacePhase: 'hud' });
  page.startRun();
  page.stopTicker();

  assert.equal(page.runOwnerContext, null);
  assert.equal(wx.store.has(PREIDENTITY_OWNER_STORAGE_KEY), false);
  page.session.startMs = Date.now() - 300000;
  assert.equal(page.queueRunForUpload(), false);
  assert.equal(wx.store.has('pending_run_summary'), false);
  assert.equal(wx.store.has('pending_run_uploads'), false);
});

test('只剩长期二件套的残缺身份也不能创建待归属域', () => {
  const page = boot();
  wx.store.set(INSTALLATION_ID_STORAGE_KEY, 'inst_' + 'z'.repeat(28));
  wx.store.set(DEVICE_CREDENTIAL_STORAGE_KEY, 'dcred_' + 'z'.repeat(40));
  page.entrySequenceStarted = true;
  page.entrySequenceCompleted = true;
  page.bleConnectionRequested = true;
  page.setData({ surfacePhase: 'hud' });
  page.startRun();
  page.stopTicker();

  assert.equal(page.runOwnerContext, null);
  assert.equal(wx.store.has(PREIDENTITY_OWNER_STORAGE_KEY), false);
  page.session.startMs = Date.now() - 300000;
  assert.equal(page.queueRunForUpload(), false);
  assert.equal(wx.store.has('pending_run_summary'), false);
});

test('另一页面完成 destructive owner transition 后，旧运行页所有收场路径都不写入或清除新 owner 数据', async (t) => {
  const actions = [
    ['tick', (page) => page.tick()],
    ['onHide', (page) => page.onHide()],
    ['finishRunForHostBack', (page) => page.finishRunForHostBack()],
    ['queueRunForUpload', (page) => page.queueRunForUpload()],
    ['onUnload', (page) => page.onUnload()],
  ];
  for (const [name, act] of actions) {
    await t.test(name, async () => {
      const page = bootRunning();
      page.stopTicker();
      const setDataPatches = [];
      const originalSetData = page.setData.bind(page);
      page.setData = (patch) => {
        setDataPatches.push(patch);
        originalSetData(patch);
      };
      page.session.startMs = Date.now() - 300000;
      page.calibrationCaptureBuffer = calibrationEvents(1, {
        nonce: 'oldowner' + name.toLowerCase(),
      });
      assert.deepEqual(page.runOwnerContext, {
        publicDeviceId: 'test-device-default',
        bound: false,
        ownershipEpoch: 1,
        dataNamespace: 'test-owner-default',
      });

      // 模拟另一路由已完整提交 B；没有 pending journal，旧页只能通过本场 pin
      // 与当前 marker 的不一致发现这次切换。
      wx.store.set(PUBLIC_DEVICE_ID_STORAGE_KEY, 'device-owner-b');
      wx.store.set(DEVICE_BINDING_STORAGE_KEY, {
        bound: true,
        ownershipEpoch: 9,
        dataNamespace: 'owner-b',
      });
      wx.store.delete(OWNER_TRANSITION_PENDING_STORAGE_KEY);
      const sentinels = {
        [LIVE_SNAPSHOT_KEY]: { owner: 'B', updatedAtMs: 123 },
        pending_run_summary: {
          mode: 'free', startedAtMs: 1, elapsedMs: 2000, endedAtMs: 2001,
        },
        pending_run_uploads: [{
          started_at: '2026-07-26T00:00:00.000Z',
          duration_s: 120,
          distance_m: 200,
          source: 'aiui',
          workout_type: 'free',
          client_run_id: 'run-owner-b-0001',
        }],
        [PENDING_AIUI_CALIBRATION_KEY]: [{ event_id: 'owner_b_event' }],
        smartrun_hud_weather_v1: {
          owner: 'B', summary: '晴 20°', fetchedAtMs: Date.now(),
        },
        [ADAPTIVE_STRIDE_STORAGE_KEY]: {
          version: 2, ownerMarker: '9:owner-b', bins: {},
        },
        aiui_run_finished_at: 888,
        aiui_host_backspace_source: { owner: 'B' },
      };
      for (const [key, value] of Object.entries(sentinels)) wx.store.set(key, value);

      act(page);
      await flushAsync();

      for (const [key, value] of Object.entries(sentinels)) {
        assert.deepEqual(wx.store.get(key), value, `${name} 不得改写 B 的 ${key}`);
      }
      assert.equal(page.runOwnerInvalidated, true);
      assert.equal(page.session, null);
      assert.equal(page.data.surfacePhase, 'menu');
      assert.deepEqual(page.calibrationCaptureBuffer, []);
      if (name === 'tick') {
        const menuPatchAt = setDataPatches.findIndex(
          (patch) => patch && patch.surfacePhase === 'menu',
        );
        assert.ok(menuPatchAt >= 0);
        assert.equal(
          setDataPatches.slice(menuPatchAt + 1).some(
            (patch) => patch && ('pace' in patch || 'cadence' in patch
              || 'hudEnvironment' in patch),
          ),
          false,
          'owner mismatch 切回菜单后，本拍不得继续提交任何 HUD patch',
        );
      }
    });
  }
});

test('有服务器 ownership_transition 证明的首次 claim 保留匿名历史并推进本场 pin', () => {
  const page = boot();
  wx.store.set(PUBLIC_DEVICE_ID_STORAGE_KEY, 'device-claim-1');
  wx.store.set(DEVICE_BINDING_STORAGE_KEY, {
    bound: false,
    ownershipEpoch: 7,
    dataNamespace: 'anonymous-seven',
  });
  makeRunning(page);
  page.stopTicker();
  page.session.startMs = Date.now() - 300000;
  wx.store.set('pending_run_uploads', [{
    started_at: '2026-07-26T00:00:00.000Z',
    duration_s: 120,
    distance_m: 200,
    source: 'aiui',
    workout_type: 'free',
    client_run_id: 'run-anonymous-0001',
  }]);

  wx.store.set(DEVICE_BINDING_STORAGE_KEY, {
    bound: true,
    ownershipEpoch: 8,
    dataNamespace: 'claimed-eight',
  });
  assert.equal(page.reconcileRunOwnerContext('identity-refresh', {
    kind: 'anonymous_claim',
    previousOwnershipEpoch: 7,
    previousDataNamespace: 'anonymous-seven',
    currentOwnershipEpoch: 8,
    currentDataNamespace: 'claimed-eight',
  }), true, '仅服务器精确回显的匿名 claim 证明可以迁移本场 owner pin');
  page.tick();

  assert.equal(page.runOwnerInvalidated, false);
  assert.ok(page.session, '首次 claim 不能中断正在进行的匿名跑步');
  assert.equal(page.data.surfacePhase, 'hud');
  assert.deepEqual(page.runOwnerContext, {
    publicDeviceId: 'device-claim-1',
    bound: true,
    ownershipEpoch: 8,
    dataNamespace: 'claimed-eight',
  });
  assert.equal(page.adaptiveStrideModel.ownerMarker, '8:claimed-eight');
  assert.equal(page.persistAdaptiveStrideModel(), true);
  assert.equal(
    wx.store.get(ADAPTIVE_STRIDE_STORAGE_KEY).ownerMarker,
    '8:claimed-eight',
  );
  assert.equal(page.queueRunForUpload(), true);
  const uploads = wx.store.get('pending_run_uploads');
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].client_run_id, 'run-anonymous-0001',
    '匿名历史在正常首次绑定时必须连续保留');
});

test('owner 清理后同一沉浸页立即重建 workout durable 镜像，无需重开页面', async () => {
  const page = boot();
  await waitWorkoutDurableStorage(page);
  const previousPromise = page.workoutDurableStoragePromise;
  for (const key of [
    WORKOUT_COMPLETION_QUEUE_KEY,
    WORKOUT_COMPLETION_QUEUE_STATE_KEY,
    WORKOUT_COMPLETION_QUARANTINE_KEY,
    WORKOUT_COMPLETION_QUARANTINE_STATE_KEY,
    WORKOUT_EXECUTION_CACHE_KEY,
    WORKOUT_EXECUTION_STATE_KEY,
  ]) wx.store.delete(key);

  page.handleRunOwnerDataCleared('test-same-page-clear');
  assert.notEqual(page.workoutDurableStoragePromise, previousPromise);
  assert.equal(page.workoutDurableStorageReady, false);
  await waitWorkoutDurableStorage(page);
  assert.deepEqual(wx.store.get(WORKOUT_COMPLETION_QUEUE_KEY), []);
  assert.deepEqual(wx.store.get(WORKOUT_COMPLETION_QUARANTINE_KEY), []);
  assert.deepEqual(wx.store.get(WORKOUT_EXECUTION_CACHE_KEY), {
    __smartrun_workout_execution_empty_v1__: true,
  });
});

test('菜单态 owner 清理会同步撤销旧今日训练与待确认动作，不留跨 owner 启动窗口', async () => {
  const page = boot();
  await waitWorkoutDurableStorage(page);
  page.setData({ surfacePhase: 'menu' });
  const stalePlan = {
    schema_version: 2,
    workout_id: workoutFixtureId(54),
    plan_id: planFixtureId(5401),
    plan_session_id: planSessionFixtureId(5401),
    revision: 1,
    type: 'easy',
    title: 'Former owner workout',
    target: { duration_sec: 600 },
    stages: [{ stage_id: stageFixtureId(5401), duration_sec: 600 }],
  };
  page.applyTodayWorkoutPlan(stalePlan);
  page.activeWorkoutPlan = stalePlan;
  page.workoutExecution = { status: 'prepared' };
  page.completedWorkoutExecution = { status: 'finished' };
  page.workoutCompletionQueued = true;
  page.menuEntryConfirmGuardUntilMs = null;
  page.surfaceEntryConfirmGuardUntilMs = null;
  assert.equal(page.deferSurfaceGlobalHook(Date.now()), true);
  assert.ok(page.pendingSurfaceGlobalHookTimer);
  assert.equal(page.data.todayWorkoutAvailable, true);

  page.handleRunOwnerDataCleared('test-menu-owner-clear');
  assert.equal(page.todayWorkoutPlan, null);
  assert.equal(page.activeWorkoutPlan, null);
  assert.equal(page.workoutExecution, null);
  assert.equal(page.completedWorkoutExecution, null);
  assert.equal(page.workoutCompletionQueued, false);
  assert.equal(page.data.todayWorkoutAvailable, false);
  assert.equal(page.pendingSurfaceGlobalHookTimer, null);
  assert.equal(page.openTodayWorkout(), false);
});

test('owner 清理替换初始化代次时，菜单等待最新 promise 并自动恢复今日训练', async () => {
  const page = boot();
  await waitWorkoutDurableStorage(page);
  ensureTestRunOwner();
  const identity = testOwnerIdentity('owner-storage-refresh-token');
  page.deviceIdentityCache = identity;
  page.setData({ surfacePhase: 'menu' });
  const now = Date.now();
  const target = {
    duration_sec: 600,
    distance_m: null,
    pace_min_sec_per_km: null,
    pace_max_sec_per_km: null,
    heart_zone_min: null,
    heart_zone_max: null,
    cadence_min_spm: null,
    cadence_max_spm: null,
  };
  assert.equal(writeCachedWorkout(wx, {
    schema_version: 2,
    workout_id: workoutFixtureId(55),
    plan_id: planFixtureId(5501),
    plan_session_id: planSessionFixtureId(5501),
    revision: 1,
    type: 'easy',
    title: 'Storage refresh run',
    scheduled_date: new Date(now).toISOString().slice(0, 10),
    status: 'planned',
    target,
    stages: [{
      ...target,
      stage_id: stageFixtureId(5501),
      order: 0,
      type: 'work',
      title: 'Run',
    }],
    issued_at_ms: now - 1000,
    expires_at_ms: now + 86_400_000,
    ownership_epoch: 1,
    data_namespace: 'test-owner-default',
  }, identity, { nowMs: now }), true);

  for (const key of [
    WORKOUT_COMPLETION_QUEUE_KEY,
    WORKOUT_COMPLETION_QUEUE_STATE_KEY,
    WORKOUT_COMPLETION_QUARANTINE_KEY,
    WORKOUT_COMPLETION_QUARANTINE_STATE_KEY,
    WORKOUT_EXECUTION_CACHE_KEY,
    WORKOUT_EXECUTION_STATE_KEY,
  ]) wx.store.delete(key);
  const pendingReads = [];
  const getStorage = wx.getStorage.bind(wx);
  wx.getStorage = (options) => {
    if (options && [
      WORKOUT_COMPLETION_QUEUE_KEY,
      WORKOUT_COMPLETION_QUEUE_STATE_KEY,
      WORKOUT_COMPLETION_QUARANTINE_KEY,
      WORKOUT_COMPLETION_QUARANTINE_STATE_KEY,
      WORKOUT_EXECUTION_CACHE_KEY,
      WORKOUT_EXECUTION_STATE_KEY,
    ].includes(options.key)) {
      pendingReads.push(options);
      return;
    }
    getStorage(options);
  };
  page.flushWorkoutCompletions = async () => {};
  page.deviceWxRequest = async () => null;
  page.handleRunOwnerDataCleared('test-delayed-owner-storage');
  page.deviceIdentityCache = identity;
  const refresh = page.refreshWorkoutMenuState(identity);
  await flushAsync();
  assert.equal(page.data.todayWorkoutAvailable, false);
  assert.equal(pendingReads.length, 6);
  for (const options of pendingReads) {
    options.fail?.({ errMsg: 'Key not found' });
    options.complete?.();
  }
  assert.equal((await refresh).workout_id, workoutFixtureId(55));
  await flushAsync();
  assert.equal(page.workoutDurableStorageReady, true);
  assert.equal(page.data.todayWorkoutAvailable, true);
  assert.equal(page.todayWorkoutPlan.workout_id, workoutFixtureId(55));
});

test('已失效运行再次收到 owner clear 仍会启动新的 durable 初始化代次', async () => {
  const page = bootRunning();
  page.stopTicker();
  page.handleRunOwnerDataCleared('test-first-owner-clear');
  assert.equal(page.runOwnerInvalidated, true);
  await waitWorkoutDurableStorage(page);
  const firstPromise = page.workoutDurableStoragePromise;
  for (const key of [
    WORKOUT_COMPLETION_QUEUE_KEY,
    WORKOUT_COMPLETION_QUEUE_STATE_KEY,
    WORKOUT_COMPLETION_QUARANTINE_KEY,
    WORKOUT_COMPLETION_QUARANTINE_STATE_KEY,
    WORKOUT_EXECUTION_CACHE_KEY,
    WORKOUT_EXECUTION_STATE_KEY,
  ]) wx.store.delete(key);
  page.handleRunOwnerDataCleared('test-second-owner-clear');
  assert.notEqual(page.workoutDurableStoragePromise, firstPromise);
  await waitWorkoutDurableStorage(page);
  assert.deepEqual(wx.store.get(WORKOUT_COMPLETION_QUEUE_KEY), []);
  assert.deepEqual(wx.store.get(WORKOUT_EXECUTION_CACHE_KEY), {
    __smartrun_workout_execution_empty_v1__: true,
  });
});

test('owner storage 暂时不可读时仅 fail closed，恢复后同一会话可继续持久化', () => {
  const page = bootRunning();
  page.stopTicker();
  page.calibrationCaptureBuffer = calibrationEvents(1, { nonce: 'storageunknown' });
  wx.store.delete(LIVE_SNAPSHOT_KEY);
  wx.store.delete('pending_run_summary');
  wx.store.delete(PENDING_AIUI_CALIBRATION_KEY);
  const originalGet = wx.getStorageSync.bind(wx);
  wx.getStorageSync = (key) => {
    if (key === DEVICE_BINDING_STORAGE_KEY) throw new Error('temporary storage failure');
    return originalGet(key);
  };

  page.tick();
  page.onHide();

  assert.equal(page.runOwnerInvalidated, false);
  assert.ok(page.session, '临时 storage 故障不能销毁运行内存');
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(wx.store.has(LIVE_SNAPSHOT_KEY), false);
  assert.equal(wx.store.has('pending_run_summary'), false);
  assert.equal(wx.store.has(PENDING_AIUI_CALIBRATION_KEY), false);
  assert.equal(page.calibrationCaptureBuffer.length, 1,
    '写入不可证明时保留内存校准样本供恢复后重试');

  wx.getStorageSync = originalGet;
  page.onShow();
  page.tick();
  assert.ok(wx.store.get(LIVE_SNAPSHOT_KEY), 'storage 恢复后同一 pin 可继续写实时快照');
  assert.equal(page.persistAiuiCalibrationBuffer(), true);
  assert.ok(readPendingAiuiCalibrationEvents(wx).length >= 1,
    '恢复后的 1Hz 新样本可与故障期保留样本一起落盘');
});

test('旧 owner 的总结 LLM 迟到完成时不覆盖新 owner', async () => {
  const llmPage = bootRunning();
  llmPage.stopTicker();
  llmPage.summaryEnteredAtMs = Date.now();
  llmPage.setData({ surfacePhase: 'summary', sumAiText: '本地总结' });
  let resolveLlm;
  llmPage.askSummaryLlm = () => new Promise((resolve) => { resolveLlm = resolve; });
  const summary = {
    mode: 'free',
    startedAtMs: Date.now() - 60000,
    elapsedMs: 60000,
    distanceM: 100,
    endedAtMs: Date.now(),
  };
  const llmPromise = llmPage.generateSummaryAiText(summary);
  await flushAsync();
  wx.store.set(PUBLIC_DEVICE_ID_STORAGE_KEY, 'llm-owner-b');
  wx.store.set(DEVICE_BINDING_STORAGE_KEY, {
    bound: true,
    ownershipEpoch: 30,
    dataNamespace: 'llm-b',
  });
  const summarySentinel = {
    mode: 'free',
    startedAtMs: 1,
    elapsedMs: 1000,
    endedAtMs: 1001,
    text: 'B 的总结',
  };
  wx.store.set('pending_run_summary', summarySentinel);
  resolveLlm('A 的迟到点评');
  await llmPromise;
  assert.deepEqual(wx.store.get('pending_run_summary'), summarySentinel);
  assert.notEqual(llmPage.data.sumAiText, 'A 的迟到点评');
  assert.equal(llmPage.runOwnerInvalidated, true);
  assert.equal(llmPage.data.surfacePhase, 'menu');
});

test('总结首帧后的旧 finalizer 遇到跨 owner 切换时不复活待办或删除 B 快照', async () => {
  const page = bootRunning();
  page.stopTicker();
  page.session.startMs = Date.now() - 65000;
  assert.equal(page.finishRunToSummary(), true);

  wx.store.set(PUBLIC_DEVICE_ID_STORAGE_KEY, 'summary-owner-b');
  wx.store.set(DEVICE_BINDING_STORAGE_KEY, {
    bound: true,
    ownershipEpoch: 40,
    dataNamespace: 'summary-b',
  });
  const pendingSentinel = {
    mode: 'free', startedAtMs: 1, elapsedMs: 1000, endedAtMs: 1001, text: 'B',
  };
  const liveSentinel = { owner: 'B', updatedAtMs: 1 };
  wx.store.set('pending_run_summary', pendingSentinel);
  wx.store.set(LIVE_SNAPSHOT_KEY, liveSentinel);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(wx.store.get('pending_run_summary'), pendingSentinel);
  assert.deepEqual(wx.store.get(LIVE_SNAPSHOT_KEY), liveSentinel);
  assert.equal(page.runOwnerInvalidated, true);
  assert.equal(page.data.surfacePhase, 'menu');
});

// ═══ 官方样例同构契约:一次连续扫描 + 点设备行连接(本机唯一验证链路) ═══

function scanHost(overrides = {}) {
  const state = { scanCalls: 0, optionsSeen: [], stops: 0, onDeviceFound: null };
  globalThis.navigator = {
    bluetooth: {
      getAvailability() { throw new Error('scan path must never pre-probe availability'); },
      async scanDevices(options) {
        state.scanCalls += 1;
        state.optionsSeen.push(options);
        if (overrides.failScan) throw new Error(overrides.failScan);
        return {
          onDeviceFound(cb) { state.onDeviceFound = cb; },
          async stop() { state.stops += 1; },
        };
      },
    },
  };
  return state;
}

function advanceWithLiveRsc(t, rscChar, totalMs, packet = {
  speedMps: 3,
  cadenceSpm: 180,
  running: true,
}) {
  let remainingMs = totalMs;
  while (remainingMs > 2000) {
    t.mock.timers.tick(2000);
    rscChar.notify(packet);
    remainingMs -= 2000;
  }
  if (remainingMs > 0) t.mock.timers.tick(remainingMs);
  rscChar.notify(packet);
}

test('生命周期不自动扫描；点开始搜索直接 scanDevices(无预探测),再点即下一步开跑', async () => {
  const page = freshPage();
  const host = scanHost();
  page.onLoad();
  page.onShow();
  page.onReady();
  await flushAsync();
  assert.equal(host.scanCalls, 0, '生命周期回调不得自动扫描');

  page.onScanTap();
  await flushAsync();
  assert.equal(host.scanCalls, 1, '手势直接发起 scanDevices,途中零桥往返');
  assert.equal(page.data.searchChip, '搜索中');
  assert.equal(page.data.surfacePhase, 'connecting');
  assert.equal(page.data.scanDiagnostic, '等待附近设备广播');

  page.lastSurfaceActivationAtMs = Date.now() - 601; // 模拟用户松手后再次独立点按
  page.onScanTap();
  await flushAsync();
  assert.equal(page.data.surfacePhase, 'hud', '扫描已启动后主按钮即"下一步":再点直接开跑');
  assert.equal(page.data.running, true);
  assert.equal(host.stops, 1, '进入 HUD 必须立即停止附近扫描');
  assert.equal(page.scanSession, null);
  assert.equal(page.data.hudHint, '', '正常 HUD 不再常驻扫描/结束说明');
  page.onUnload();
});

test('扫描参数是每次新建的 hr-filter 字面量,绝不复用共享/冻结对象', async () => {
  const page = freshPage();
  const host = scanHost();
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  page.onHide();             // 退出 02 重置
  page.onShow();
  page.onScanTap();          // 再次开扫
  await flushAsync();
  assert.equal(host.scanCalls, 2);
  for (const options of host.optionsSeen) {
    assert.deepEqual(options, { filters: [{ services: ['heart_rate'] }] });
    assert.equal(Object.isFrozen(options), false, '冻结对象过桥可能被宿主拒绝');
  }
  assert.notEqual(host.optionsSeen[0], host.optionsSeen[1], '每次调用必须是新对象');
  page.onUnload();
});

test('scanDevices 抛错:类别上信标,后台自动重试;再点主按钮直接无心率开跑', async () => {
  const page = freshPage();
  const host = scanHost({ failScan: 'host rejected scan' });
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  assert.equal(page.data.searchChip, '搜索失败');
  assert.equal(page.data.searchText, '搜索失败，可使用眼镜估算');
  assert.equal(page.data.primaryLabel, '下一步', '扫描失败不堵路:按钮保持下一步');
  assert.equal(page.data.scanDiagnostic, '单击“下一步”继续');
  assert.ok(page.data.keyBeacon.includes('E:other'), '只允许脱敏错误类别上信标');
  assert.doesNotMatch(page.data.keyBeacon, /host rejected scan/);
  assert.ok(page.scanRetryTimer, '扫描启动失败后应先存在有界重试');

  page.lastSurfaceActivationAtMs = Date.now() - 601; // 新的“下一步”手势
  page.onScanTap();
  await flushAsync();
  assert.equal(page.data.surfacePhase, 'hud', '扫描失败后点按 = 直接无心率开跑');
  assert.equal(page.data.running, true);
  assert.equal(page.data.showHeartRate, false);
  assert.equal(page.scanRetryTimer, null, 'Next 必须同步取消失败退避，不把重试带进 HUD');
  assert.equal(page.data.hudHint, '', '扫描失败进入 HUD 后也不常驻操作说明');
  page.onUnload();
});

test('HUD 确认键三次结束:先进入放松，再选择总结并关闭智能体', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  page.onLoad();
  makeInteractive(page);
  page.onConnectTap();   // 无 BLE 宿主 → 眼镜模式 HUD
  assert.equal(page.data.surfacePhase, 'hud');
  t.mock.timers.tick(65000);

  const dispatchHudConfirm = () => {
    let prevented = false;
    page.onKeyUp({ code: 'GlobalHook', preventDefault() { prevented = true; } });
    // 模拟真实宿主：只要页面没拦截 keyup，就继续执行默认返回。
    if (!prevented) wx.navigateBack();
    return prevented;
  };

  assert.equal(dispatchHudConfirm(), true, '第一次确认的页面反馈也必须替代宿主默认动作');
  assert.equal(page.data.surfacePhase, 'hud', '第一次确认只武装,不结束');
  assert.equal(page.data.running, true);
  assert.equal(page.data.hudHint, '再按2次结束', '第一次必须显示剩余两次');
  t.mock.timers.tick(600);
  assert.equal(dispatchHudConfirm(), true, '第二次确认也必须阻止宿主弹栈');
  assert.equal(page.data.surfacePhase, 'hud', '第二次仍不能结束');
  assert.equal(page.data.running, true);
  assert.equal(page.data.hudHint, '再按1次结束', '第二次必须显示剩余一次');
  t.mock.timers.tick(600);
  assert.equal(dispatchHudConfirm(), true, '第三次确认切放松时必须阻止宿主弹栈');
  assert.equal(page.data.surfacePhase, 'recovery', '3 秒窗口内第三次确认 → 跑后放松');
  assert.equal(wx.navigateBackCalls, 0, '宿主默认行为不得让放松页瞬间回首页');
  assert.equal(page.data.running, false);
  assert.ok(page.data.sumElapsed.startsWith('01:0'), '总结页显示用时: ' + page.data.sumElapsed);
  assert.ok(page.data.sumAiText.includes('公里'), '第一帧直接显示本地总结: ' + page.data.sumAiText);
  assert.equal(page.data.sumAiState, '本地总结');
  t.mock.timers.tick(0);
  await flushAsync();
  const pending = wx.store.get('pending_run_summary');
  assert.ok(pending && pending.elapsedMs >= 65000, '总结待办已写盘');

  assert.equal(chooseSummaryAfterRecovery(page), true);
  assert.equal(page.data.surfacePhase, 'summary');

  t.mock.timers.tick(1000);
  let prevented = false;
  page.onKeyUp({ code: 'GlobalHook', preventDefault() { prevented = true; } });
  assert.equal(prevented, true, '总结页确认键必须成为页面替代动作');
  assert.equal(page.data.summaryExitText, '再按确认键退出');
  t.mock.timers.tick(100);
  page.onKeyUp({ code: 'Enter', preventDefault() {} });
  assert.equal(wx.exitMiniProgramCalls, 0, '同一次物理按压的键码别名不能算第二次确认');
  t.mock.timers.tick(500);
  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  await flushAsync(); await flushAsync();
  assert.equal(wx.exitMiniProgramCalls, 1, '总结页第二次独立确认关闭整个智能体');
  assert.equal(wx.store.has(HOST_BACKSPACE_SOURCE_KEY), false, '总结退出不再伪装成宿主返首页');
  assert.deepEqual(wx.navigateToCalls, []);
  assert.equal(wx.navigateBackCalls, 0);
});

test('短跑在下一次 1Hz tick 前结束也用 accepted-step 间隔生成总结步频和配速', () => {
  const page = bootRunning();
  page.stopTicker();
  const startMs = Date.now() - 5000;
  page.session.startMs = startMs;
  page.motionMetrics = new MotionMetrics({
    startMs,
    stepLengthM: 0.7,
  });
  for (const timestampMs of [
    startMs + 1000,
    startMs + 1600,
    startMs + 2200,
    startMs + 2800,
  ]) {
    page.motionMetrics.onAcceptedStep(timestampMs, 200);
  }

  assert.equal(page.session.avgCadenceSpm(), null,
    '复现结束前 ticker 尚未采到平均步频的竞态');
  assert.equal(page.motionMetrics.snapshot(Date.now()).avgPaceSecPerKm, null,
    '短跑尚未满足 8 秒/10 米账本配速门');
  assert.equal(page.finishRunToSummary(), true);
  assert.equal(page.data.sumStatLabel, '平均步频');
  assert.equal(page.data.sumStat, '100');
  assert.notEqual(page.data.sumPace, '--');
  assert.equal(page.pendingSummarySnapshot.avgCadenceSpm, 100);
  assert.ok(page.pendingSummarySnapshot.avgPaceSecPerKm > 0);
});

test('混合 RSC/IMU 跑的总结优先统一会话均值，不被一条 RSC 包锁死', () => {
  const page = bootRunning();
  page.stopTicker();
  const startMs = Date.now() - 30000;
  page.session.startMs = startMs;
  for (let index = 0; index < 10; index += 1) page.session.onCadence(100);
  page.motionMetrics = new MotionMetrics({ startMs, stepLengthM: 0.7 });
  for (let index = 0; index <= 30; index += 1) {
    page.motionMetrics.onAcceptedStep(startMs + 1000 + index * 600, 100);
  }
  page.motionMetrics.onRscMeasurement({
    speedMps: 3,
    cadenceSpm: 180,
  }, Date.now());
  assert.equal(page.motionMetrics.snapshot(Date.now()).avgCadenceSpm, 180,
    '复现 MotionMetrics 单包 RSC 聚合会覆盖 IMU 的边界');
  assert.equal(page.finishRunToSummary(), true);
  assert.equal(page.pendingSummarySnapshot.avgCadenceSpm, 100);
  assert.equal(page.data.sumStat, '100');
});

test('短 RSC 跑总结优先设备即时速度，不用眼镜步长反推配速', () => {
  const page = bootRunning();
  page.stopTicker();
  const now = Date.now();
  page.session.startMs = now - 3000;
  page.motionMetrics = new MotionMetrics({
    startMs: now - 3000,
    stepLengthM: 0.7,
  });
  page.motionMetrics.onRscMeasurement({
    speedMps: 1.5,
    cadenceSpm: 180,
  }, now - 100);
  const motion = page.motionMetrics.snapshot(now);
  assert.equal(motion.avgPaceSecPerKm, null);
  assert.ok(Math.abs(motion.rscInstantPaceSecPerKm - (1000 / 1.5)) < 0.01);
  assert.equal(page.finishRunToSummary(), true);
  assert.ok(
    Math.abs(page.pendingSummarySnapshot.avgPaceSecPerKm - (1000 / 1.5)) < 0.01,
  );
  assert.equal(page.data.sumPace, '11:07');
});

test('连接心率的总结卡仍固定显示平均步频，心率保留在完整总结数据', () => {
  const page = bootRunning();
  page.stopTicker();
  const startMs = Date.now() - 10000;
  page.session.startMs = startMs;
  page.session.onHeartRate(150);
  page.session.onHeartRate(160);
  page.motionMetrics = new MotionMetrics({ startMs, stepLengthM: 0.7 });
  for (const timestampMs of [
    startMs + 1000,
    startMs + 1600,
    startMs + 2200,
    startMs + 2800,
  ]) {
    page.motionMetrics.onAcceptedStep(timestampMs, 100);
  }
  assert.equal(page.finishRunToSummary(), true);
  assert.equal(page.data.sumStatLabel, '平均步频');
  assert.equal(page.data.sumStat, '100');
  assert.equal(page.pendingSummarySnapshot.avgBpm, 155);
  assert.equal(page.pendingSummarySnapshot.maxBpm, 160);
});

test('停步后结束仍保留真实总结平均值，纯 HUD 粘滞值不能伪造总结', () => {
  const page = bootRunning();
  page.stopTicker();
  const startMs = Date.now() - 30000;
  page.session.startMs = startMs;
  page.motionMetrics = new MotionMetrics({
    startMs,
    stepLengthM: 0.7,
  });
  for (const timestampMs of [
    startMs + 1000,
    startMs + 1600,
    startMs + 2200,
    startMs + 2800,
  ]) {
    page.motionMetrics.onAcceptedStep(timestampMs, 180);
  }
  assert.equal(page.finishRunToSummary(), true);
  assert.equal(page.data.sumStat, '100');
  assert.notEqual(page.data.sumPace, '--');

  const stickyOnly = bootRunning();
  stickyOnly.stopTicker();
  stickyOnly.cadenceEverReady = true;
  stickyOnly.paceEverReady = true;
  stickyOnly.lastDisplayedCadenceSpm = 120;
  stickyOnly.lastDisplayedPaceSec = 600;
  assert.equal(stickyOnly.finishRunToSummary(), true);
  assert.equal(stickyOnly.data.sumStat, '--',
    '没有 accepted-step/RSC 证据时不能把 HUD 显示棘轮冒充平均步频');
  assert.equal(stickyOnly.data.sumPace, '--',
    '没有真实运动账本时不能把最后显示配速冒充平均配速');
});

test('总结页关闭:先等待心率通知停止和 GATT 断开,再 exitMiniProgram', async () => {
  const page = boot();
  const { device, char } = fakeHrDevice('fenix 8');
  const order = [];
  let releaseNotifications;
  char.stopNotifications = () => new Promise((resolve) => {
    order.push('stop-notifications');
    releaseNotifications = () => { order.push('notifications-stopped'); resolve(char); };
  });
  const originalDisconnect = device.gatt.disconnect.bind(device.gatt);
  device.gatt.connected = true;
  device.gatt.disconnect = async () => {
    order.push('disconnect');
    originalDisconnect();
    order.push('disconnected');
  };
  wx.exitMiniProgram = () => {
    wx.exitMiniProgramCalls += 1;
    wx.exited = true;
    order.push('exit');
  };
  page.hrCharacteristic = char;
  page.hrListener = () => {};
  page.bleDevice = device;
  page.setData({ surfacePhase: 'summary', bleState: 'connected' });

  let prevented = false;
  page.onKeyUp({ code: 'Backspace', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(wx.exitMiniProgramCalls, 0, '清理 Promise 未完成前不提前退出');
  assert.deepEqual(order, ['stop-notifications'], '清理必须先等 notify 停止，不与 disconnect 并发');
  releaseNotifications();
  await flushAsync(); await flushAsync();
  assert.equal(wx.exitMiniProgramCalls, 1);
  assert.deepEqual(order, [
    'stop-notifications', 'notifications-stopped', 'disconnect', 'disconnected', 'exit',
  ]);
  assert.ok(order.indexOf('exit') > order.indexOf('notifications-stopped'), '退出必须在蓝牙清理 settle 之后');
});

test('总结页关闭:蓝牙清理桥悬空时 800ms 有界兜底,且只退出一次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  page.onLoad();
  const { device, char } = fakeHrDevice('fenix 8');
  char.stopNotifications = () => new Promise(() => {});
  device.gatt.connected = true;
  device.gatt.disconnect = () => new Promise(() => {});
  page.hrCharacteristic = char;
  page.hrListener = () => {};
  page.bleDevice = device;
  page.setData({ surfacePhase: 'summary', bleState: 'connected' });

  page.onKeyUp({ code: 'Backspace', preventDefault() {} });
  t.mock.timers.tick(799);
  await flushAsync();
  assert.equal(wx.exitMiniProgramCalls, 0);
  t.mock.timers.tick(1);
  await flushAsync();
  assert.equal(wx.exitMiniProgramCalls, 1, '宿主桥悬空不得把智能体卡死');
  t.mock.timers.tick(5000);
  assert.equal(wx.exitMiniProgramCalls, 1, '兜底定时器与正常清理不得双重退出');
});

test('总结页关闭会等当前跑步上传，但网络悬空仍由 800ms 兜底且保留队列', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = bootRunning();
  t.after(() => page.onUnload());
  page.stopTicker();
  page.session.startMs = Date.now() - 300000;
  cacheTestOwnerIdentity(page, 'summary-exit-pending-token');
  assert.equal(page.queueRunForUpload(), true);
  page.deviceWxRequest = () => new Promise(() => {});
  page.summaryEnteredAtMs = Date.now();
  page.setData({ surfacePhase: 'summary', running: false });

  assert.equal(page.closeAgentFromSummary('summary-backspace'), true);
  await flushAsync();
  assert.equal(wx.exitMiniProgramCalls, 0,
    'BLE 已清完但汇总上传仍在 flight 时，不应在硬上限前提前关闭');
  t.mock.timers.tick(799);
  await flushAsync();
  assert.equal(wx.exitMiniProgramCalls, 0);
  t.mock.timers.tick(1);
  await flushAsync();
  assert.equal(wx.exitMiniProgramCalls, 1, '网络不得把智能体永久卡在总结页');
  assert.equal(readPendingRunUploads(wx).length, 1,
    '未收到后端 run id 时必须保留 durable 队列供首页重试');
});

test('总结页真实 GlobalHook 双击可退出，入场结束手势尾包仍被隔离', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  page.onLoad();
  page.setData({
    surfacePhase: 'summary',
    sumAiText: '本地总结已同步显示',
    sumAiState: '本地总结',
  });
  page.summaryEnteredAtMs = Date.now();

  const tap = () => page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  tap();
  t.mock.timers.tick(140);
  tap();
  assert.equal(wx.exitMiniProgramCalls, 0, '总结入场 600ms 内的结束手势尾包不能误退出');
  assert.equal(page.summaryTouchTapAtMs, null, '入场尾包不能污染下一次真实双击');

  t.mock.timers.tick(461);
  tap();
  assert.equal(page.data.summaryExitText, '再按确认键退出');
  t.mock.timers.tick(140);
  tap();
  await flushAsync(); await flushAsync();

  assert.equal(wx.exitMiniProgramCalls, 1, '90–420ms 的两次独立触摸应直接关闭智能体');
  assert.equal(page.agentExitRequested, true);
  assert.match(runHudSource, /SUMMARY_DOUBLE_TAP_WINDOW_MS = 420/);
  assert.match(runHudSource, /SUMMARY_DOUBLE_TAP_MIN_GAP_MS = 90/);
  assert.match(runHudSource, /closeAgentFromSummary\('summary-double-tap'\)/);
});

test('总结 setData 镜像迟到时 Back 仍按同步内部相位立即退出', () => {
  const page = freshPage();
  page.onLoad();
  makeRunning(page);
  page.stopTicker();
  const commitSetData = page.setData;
  page.setData = function delayedSummarySurface(patch) {
    const next = { ...(patch || {}) };
    if (next.surfacePhase === 'summary') delete next.surfacePhase;
    commitSetData.call(this, next);
  };

  assert.equal(page.finishRunToSummary(), true);
  assert.equal(page.data.surfacePhase, 'hud', '模拟真机尚未回写 summary UI 镜像');
  assert.equal(page.isSummaryPhase(), true, '同步内部相位必须立即成为输入路由真相');
  let prevented = false;
  page.onKeyUp({ code: 'Backspace', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(page.agentExitRequested, true);
  page.onUnload();
});

test('总结首帧后立即退出也会先保存冻结总结，不被 onUnload 取消', () => {
  const page = freshPage();
  page.onLoad();
  makeRunning(page);
  page.stopTicker();
  page.session.startMs = Date.now() - 65000;
  wx.store.delete('pending_run_summary');
  wx.store.delete('pending_run_uploads');

  assert.equal(page.finishRunToSummary(), true);
  const frozen = { ...page.pendingSummarySnapshot };
  assert.equal(wx.store.has('pending_run_summary'), false,
    '首帧提交时仍不应同步触碰 storage');

  // 模拟用户看到总结后立即返回；若退出分支重新读取活动 session，
  // 这里的人为漂移会把总结错误拉长到十分钟。
  page.session.startMs = Date.now() - 10 * 60 * 1000;
  assert.equal(page.closeAgentFromSummary('summary-backspace'), true);
  page.onUnload();

  const pending = wx.store.get('pending_run_summary');
  assert.ok(pending, '立即退出也必须保留本场总结待办');
  assert.equal(pending.startedAtMs, frozen.startedAtMs, '退出必须使用冻结起跑时间');
  assert.equal(pending.elapsedMs, frozen.elapsedMs, '退出必须使用总结首帧的冻结时长');
  assert.equal(pending.endedAtMs, frozen.endedAtMs, '退出必须使用冻结结束时间');
  const uploads = wx.store.get('pending_run_uploads');
  assert.equal(Date.parse(uploads[0].started_at), frozen.startedAtMs,
    '跑步上传与总结必须共享同一冻结起跑时间');
  assert.equal(page.runUploadQueued, true, '退出前已同步完成幂等入队');
});

test('总结 setData 镜像迟到时真实 GlobalHook 双击仍可退出', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  page.onLoad();
  makeRunning(page);
  page.stopTicker();
  const commitSetData = page.setData;
  page.setData = function delayedSummarySurface(patch) {
    const next = { ...(patch || {}) };
    if (next.surfacePhase === 'summary') delete next.surfacePhase;
    commitSetData.call(this, next);
  };

  assert.equal(page.finishRunToSummary(), true);
  assert.equal(page.data.surfacePhase, 'hud');
  page.summaryEnteredAtMs = Date.now() - 700;
  const tap = () => page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  tap();
  t.mock.timers.tick(140);
  tap();
  await flushAsync(); await flushAsync();
  assert.equal(page.agentExitRequested, true);
  assert.equal(wx.exitMiniProgramCalls, 1);
});

test('HUD 三次确认边界:600ms 才独立，双击/别名不累加，3s 过期重置', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  page.onLoad();
  makeInteractive(page);
  page.onConnectTap();
  // 入场宽限:进入 HUD 的确认手势尾随 keyup 不得武装结束
  page.onKeyUp({ code: 'GlobalHook' });
  assert.equal(page.data.hudHint, '', '入场宽限期内不武装且不显示常驻说明');
  t.mock.timers.tick(30000);

  page.onKeyUp({ code: 'GlobalHook' });
  assert.equal(page.data.hudHint, '再按2次结束');
  t.mock.timers.tick(100);
  page.onKeyUp({ code: 'Enter' });
  t.mock.timers.tick(320);
  page.onKeyUp({ code: 'GlobalHook' });
  assert.equal(page.hudEndConfirmCount, 1,
    '100ms 键码别名与 420ms 触摸双击都只能算第一次');
  assert.equal(page.data.surfacePhase, 'hud');

  t.mock.timers.tick(180);
  page.onKeyUp({ code: 'GlobalHook' });
  assert.equal(page.hudEndConfirmCount, 2, '600ms 边界必须接受为第二次独立确认');
  assert.equal(page.data.hudHint, '再按1次结束');

  t.mock.timers.tick(4000);          // 窗口过期(tick 清除完整三段进度)
  assert.equal(page.data.hudHint, '', '窗口过期后清空临时反馈');
  assert.equal(page.hudEndConfirmCount, 0);
  page.onKeyUp({ code: 'GlobalHook' });
  assert.equal(page.data.hudHint, '再按2次结束', '窗口过期后只重新记第一次');
  t.mock.timers.tick(600);
  page.onKeyUp({ code: 'GlobalHook' });
  assert.equal(page.data.surfacePhase, 'hud', '重新记的第二次仍不得结束');
  t.mock.timers.tick(600);
  page.onKeyUp({ code: 'GlobalHook' });
  assert.equal(page.data.surfacePhase, 'recovery', '重新形成第三次确认才进入放松');
});

test('HUD 三确认进度在 hide、新会话、相位结束与 unload 都会清零', () => {
  const hidden = bootRunning();
  hidden.onHudConfirmKey();
  assert.equal(hidden.hudEndConfirmCount, 1);
  hidden.onHide();
  assert.equal(hidden.hudEndConfirmCount, 0);
  assert.equal(hidden.endArmedAtMs, null);
  assert.equal(hidden.lastConfirmKeyMs, null);
  assert.equal(hidden.data.hudHint, '');

  const started = freshPage();
  started.onLoad();
  ensureTestRunOwner();
  started.onShow();
  started.endArmedAtMs = Date.now();
  started.hudEndConfirmCount = 2;
  started.lastConfirmKeyMs = Date.now();
  started.setData({ surfacePhase: 'hud', hudHint: '再按1次结束' });
  started.startRun();
  assert.equal(started.hudEndConfirmCount, 0, '新会话不继承旧的两次确认');
  assert.equal(started.data.hudHint, '');

  started.onHudConfirmKey();
  assert.equal(started.hudEndConfirmCount, 1);
  assert.equal(started.finishRunToSummary(), true);
  assert.equal(started.hudEndConfirmCount, 0, '离开 HUD 必须清掉进度');

  const unloaded = bootRunning();
  unloaded.onHudConfirmKey();
  assert.equal(unloaded.hudEndConfirmCount, 1);
  unloaded.onUnload();
  assert.equal(unloaded.hudEndConfirmCount, 0);
  assert.equal(unloaded.endArmedAtMs, null);
  assert.equal(unloaded.lastConfirmKeyMs, null);
});

test('总结页 AI 点评原位升级并把文本写回待办;隐藏不回退 02', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  t.after(() => { page.onUnload(); delete globalThis.LanguageModel; });
  let destroyed = 0;
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async () => ({
      prompt: async () => '配速稳住了，跑得漂亮，注意补水。',
      destroy() { destroyed += 1; },
    }),
  };
  page.onLoad();
  makeInteractive(page);
  page.onConnectTap();
  t.mock.timers.tick(70000);
  page.onKeyUp({ code: 'GlobalHook' });
  t.mock.timers.tick(600);
  page.onKeyUp({ code: 'GlobalHook' });
  t.mock.timers.tick(600);
  page.onKeyUp({ code: 'GlobalHook' });
  assert.equal(page.data.surfacePhase, 'recovery');
  assert.equal(chooseSummaryAfterRecovery(page), true);
  assert.equal(page.data.surfacePhase, 'summary');
  assert.equal(page.data.sumAiState, '本地总结');
  assert.ok(page.data.sumAiText.includes('公里'), 'AI 未就绪时本地总结已完整可读');
  t.mock.timers.tick(0);
  t.mock.timers.tick(80);
  await flushAsync(); await flushAsync(); await flushAsync(); await flushAsync();
  assert.ok(page.data.sumAiText.includes('注意补水和恢复'), 'AI 点评按 allowlist 原位升级: ' + page.data.sumAiText);
  assert.ok(!page.data.sumAiText.includes('配速稳住了'), '模型自由文本不得原样展示');
  assert.equal(page.data.sumAiState, 'AI 点评');
  assert.ok(wx.ttsSpoken.some((line) => line.includes('注意补水和恢复')), '只播报规则化安全文本');
  assert.equal(destroyed, 1, 'session 用完必须 destroy');
  const pending = wx.store.get('pending_run_summary');
  assert.ok(pending.text && pending.text.includes('注意补水和恢复'), '规则化 AI 文本随待办带回首页复用');
  assert.ok(!pending.text.includes('配速稳住了'), '待办不得保存模型原文');

  page.onHide();
  assert.equal(page.data.surfacePhase, 'summary', '隐藏/恢复不把总结页重置回 02');
});

test('沉浸总结 LanguageModel 同步注入当前 owner 的最近本地跑步历史', async (t) => {
  const page = freshPage();
  t.after(() => { page.onUnload(); delete globalThis.LanguageModel; });
  ensureTestRunOwner();
  page.onLoad({ mode: 'free' });
  assert.ok(enqueueLocalRunMemory(wx, {
    mode: 'free',
    endedAtMs: Date.now() - 60_000,
    elapsedMs: 30 * 60 * 1000,
    distanceM: 5000,
    text: '上次稳定完成五公里',
  }));
  let capturedPrompt = '';
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async () => ({
      prompt: async (prompt) => {
        capturedPrompt = String(prompt || '');
        return '完成本次训练。';
      },
      destroy() {},
    }),
  };
  page.summaryEnteredAtMs = Date.now();
  page.setData({ surfacePhase: 'summary' });
  await page.generateSummaryAiText({
    mode: 'free',
    startedAtMs: Date.now() - 10 * 60 * 1000,
    endedAtMs: Date.now(),
    elapsedMs: 10 * 60 * 1000,
    distanceM: 2000,
    avgPaceSecPerKm: 300,
    avgCadenceSpm: 170,
  });
  assert.match(capturedPrompt, /上次稳定完成五公里/);
});

test('总结 AI 永不返回时本地内容仍同步可读，双确认可退出并销毁活动模型', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  t.after(() => { page.onUnload(); delete globalThis.LanguageModel; });
  let destroyed = 0;
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async () => ({
      prompt: () => new Promise(() => {}),
      destroy() { destroyed += 1; },
    }),
  };
  page.onLoad();
  makeInteractive(page);
  page.onConnectTap();
  t.mock.timers.tick(65000);
  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  t.mock.timers.tick(600);
  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  t.mock.timers.tick(600);
  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });

  assert.equal(page.data.surfacePhase, 'recovery');
  assert.equal(chooseSummaryAfterRecovery(page), true);
  assert.equal(page.data.surfacePhase, 'summary');
  assert.ok(page.data.sumAiText.includes('公里'), '模型桥之前本地总结已经完整显示');
  assert.equal(page.data.sumAiState, '本地总结');
  t.mock.timers.tick(0);
  t.mock.timers.tick(80);
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.ok(page.summaryLlmSession, '活动模型已被跟踪，退出时才能确定销毁');

  t.mock.timers.tick(520);
  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  assert.equal(page.data.summaryExitText, '再按确认键退出');
  t.mock.timers.tick(500);
  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  await flushAsync(); await flushAsync();
  assert.equal(wx.exitMiniProgramCalls, 1, '模型悬空不得阻塞总结页退出');
  assert.equal(destroyed, 1, '退出必须立即 destroy 活动 LanguageModel session');
});

test('总结 AI 取消与迟到 prompt 兑现竞态只销毁同一 session 一次', async (t) => {
  const page = freshPage();
  t.after(() => { page.onUnload(); delete globalThis.LanguageModel; });
  let resolvePrompt;
  let destroyed = 0;
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async () => ({
      prompt: () => new Promise((resolve) => { resolvePrompt = resolve; }),
      destroy() { destroyed += 1; },
    }),
  };
  const summary = {
    mode: 'free',
    startedAtMs: Date.now() - 60000,
    elapsedMs: 60000,
    distanceM: 100,
    endedAtMs: Date.now(),
  };
  page.summaryLlmGeneration = 1;
  const flight = page.askSummaryLlm(summary, '', 1);
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.ok(page.summaryLlmSession, 'prompt 悬空时必须跟踪本次 session 记录');

  page.cancelSummaryLlm();
  assert.equal(destroyed, 1, '取消路径立即销毁一次');
  resolvePrompt('迟到点评');
  await flight;
  assert.equal(destroyed, 1, '迟到 finally 不得重复销毁同一 session');
});

test('总结 AI 在 availability/create 窗口保持 single-flight', async (t) => {
  const page = freshPage();
  t.after(() => { page.onUnload(); delete globalThis.LanguageModel; });
  let releaseAvailability;
  let createCalls = 0;
  let destroyed = 0;
  globalThis.LanguageModel = {
    availability: () => new Promise((resolve) => { releaseAvailability = resolve; }),
    create: async () => {
      createCalls += 1;
      return {
        prompt: async () => '注意补水和恢复。',
        destroy() { destroyed += 1; },
      };
    },
  };
  page.data.surfacePhase = 'summary';
  page.pageVisible = false;
  page.ownerScopedRunWriteAllowed = () => true;
  const summary = {
    mode: 'free',
    startedAtMs: Date.now() - 60000,
    elapsedMs: 60000,
    distanceM: 100,
    endedAtMs: Date.now(),
  };

  const first = page.generateSummaryAiText(summary);
  const duplicate = page.generateSummaryAiText(summary);
  await flushAsync();
  assert.equal(createCalls, 0, '首个 availability 未完成时第二次调用必须被挡住');
  releaseAvailability('available');
  await Promise.all([first, duplicate]);
  assert.equal(createCalls, 1, '同一总结只允许创建一个 LanguageModel session');
  assert.equal(destroyed, 1, 'single-flight session 用完只销毁一次');
  assert.equal(page.summaryLlmFlightGeneration, null, 'flight 完成后释放代次占位');
});

test('结束到总结页后,迟到兑现的连接不得复活 BLE(断开并放弃提交)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  const host = scanHost();
  const { device } = fakeHrDevice('fenix 8');
  let releaseConnect = null;
  let disconnects = 0;
  const gatt = device.gatt;
  const origConnect = gatt.connect.bind(gatt);
  gatt.connect = () => new Promise((resolve) => { releaseConnect = () => resolve(origConnect()); });
  const origDisconnect = gatt.disconnect.bind(gatt);
  gatt.disconnect = () => { disconnects += 1; return origDisconnect(); };

  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  page.onConnectTap();   // 智能下一步:自动连接在途(gatt.connect 挂起)
  assert.equal(page.data.surfacePhase, 'hud');
  await flushAsync(); await flushAsync();
  assert.equal(typeof releaseConnect, 'function', '连接应已发起并挂起');

  t.mock.timers.tick(30000);
  page.onKeyUp({ code: 'GlobalHook' });
  t.mock.timers.tick(600);
  page.onKeyUp({ code: 'GlobalHook' });
  t.mock.timers.tick(600);
  page.onKeyUp({ code: 'GlobalHook' });
  assert.equal(page.data.surfacePhase, 'recovery');
  assert.equal(page.data.bleState, 'idle', '收场时连接状态一并清零');

  releaseConnect();   // 连接此刻才兑现:提交门必须拒绝并断开
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(page.hrCharacteristic, null, '迟到连接不得提交特征值');
  assert.equal(page.data.bleState, 'idle', '总结页不得凭空变回 connected');
  assert.ok(disconnects >= 1, '迟到连接必须被主动断开,不留泄漏');
});

test('总结退出后 scanDevices 才兑现:立即 stop,不挂监听也不复活扫描状态', async () => {
  const page = freshPage();
  let resolveScan;
  let stops = 0;
  let listeners = 0;
  globalThis.navigator = {
    bluetooth: {
      scanDevices() {
        return new Promise((resolve) => { resolveScan = resolve; });
      },
    },
  };
  page.onLoad();
  page.onShow();
  page.onReady();
  page.onScanTap();
  await flushAsync();
  assert.equal(typeof resolveScan, 'function', '原生扫描 Promise 已在途');

  page.onConnectTap();
  assert.equal(page.data.surfacePhase, 'hud');
  page.finishRunToSummary();
  page.onKeyUp({ code: 'Backspace', preventDefault() {} });
  resolveScan({
    onDeviceFound() { listeners += 1; },
    stop() { stops += 1; },
  });
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(stops, 1, '迟到 scan 必须立即停止');
  assert.equal(listeners, 0, '过期 scan 不得再挂 devicefound');
  assert.equal(page.scanSession, null);
  assert.equal(page.data.bleState, 'idle');
  assert.equal(wx.exitMiniProgramCalls, 1);
  page.onUnload();
});

test('页面卸载后 scanDevices 才兑现:立即 stop,不挂监听也不创建重试', async () => {
  const page = freshPage();
  let resolveScan;
  let stops = 0;
  let listeners = 0;
  globalThis.navigator = {
    bluetooth: {
      scanDevices() {
        return new Promise((resolve) => { resolveScan = resolve; });
      },
    },
  };
  page.onLoad();
  page.onShow();
  page.onReady();
  page.onScanTap();
  await flushAsync();
  assert.equal(typeof resolveScan, 'function');

  page.onUnload();
  resolveScan({
    onDeviceFound() { listeners += 1; },
    stop() { stops += 1; },
  });
  await flushAsync(); await flushAsync();
  assert.equal(stops, 1, '卸载后迟到扫描必须立即停止');
  assert.equal(listeners, 0, '卸载后的扫描不得挂监听');
  assert.equal(page.scanSession, null);
  assert.equal(page.scanRetryTimer, null, '卸载后不得重建扫描重试');
  assert.equal(page.bleTerminated, true);
});

test('页面卸载后在途 GATT 才失败:不更新 UI、不创建重连并归还设备', async () => {
  const page = freshPage();
  const { device } = fakeHrDevice('fenix 8');
  let rejectConnect;
  let disconnects = 0;
  device.gatt.connect = () => new Promise((_resolve, reject) => { rejectConnect = reject; });
  const originalDisconnect = device.gatt.disconnect.bind(device.gatt);
  device.gatt.disconnect = () => {
    disconnects += 1;
    return originalDisconnect();
  };
  page.onLoad();
  page.onShow();
  page.setData({ surfacePhase: 'connecting' });
  const connecting = page.connectSelected(device);
  await flushAsync();
  assert.equal(typeof rejectConnect, 'function');

  page.onUnload();
  rejectConnect(new Error('late native bridge failure'));
  assert.equal(await connecting, false);
  await flushAsync();
  assert.equal(page.hudReconnectTimer, null, '卸载后迟到失败不得创建重连');
  assert.equal(page.reconnectDevice, null);
  assert.equal(page.hrCharacteristic, null);
  assert.ok(disconnects >= 1, '迟到失败也要归还可能占用的 GATT 设备');
});

test('总结收场时 startNotifications 在途:迟到心率包无副作用,兑现后停订阅并断开', async () => {
  const page = freshPage();
  const { device, char } = fakeHrDevice('fenix 8');
  let releaseNotifications;
  let disconnects = 0;
  char.startNotifications = () => new Promise((resolve) => {
    char.startNotificationsCalls += 1;
    releaseNotifications = resolve;
  });
  const originalDisconnect = device.gatt.disconnect.bind(device.gatt);
  device.gatt.disconnect = () => {
    disconnects += 1;
    return originalDisconnect();
  };
  page.onLoad();
  page.onShow();
  page.setData({ surfacePhase: 'connecting' });
  const connecting = page.connectSelected(device);
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(typeof releaseNotifications, 'function', '心率订阅 Promise 已在途');

  page.setData({ surfacePhase: 'hud' });
  page.startRun();
  page.finishRunToSummary();
  char.notify(188); // listener 已挂但尝试代次已失效
  assert.equal(page.lastHrAtMs, null, '退出后迟到通知不得复活心率时间戳');
  assert.equal(page.session.lastBpm, null, '退出后迟到通知不得写入跑步会话');
  assert.equal(page.hrWatchdogTimer, null, '退出后不得重挂心率看门狗');

  releaseNotifications(char);
  await connecting;
  await flushAsync(); await flushAsync();
  assert.equal(page.hrCharacteristic, null);
  assert.equal((char.listeners.characteristicvaluechanged || []).length, 0, '迟到尝试的监听必须摘除');
  assert.ok(char.stopNotificationsCalls >= 1, '迟到订阅必须显式停止');
  assert.ok(disconnects >= 1, '迟到 GATT 必须显式断开');
  page.onUnload();
});

test('总结页入场用 Rokid 本地 TTS 播报总结文本', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  page.onLoad();
  makeInteractive(page);
  page.onConnectTap();
  t.mock.timers.tick(65000);
  page.onKeyUp({ code: 'GlobalHook' });
  t.mock.timers.tick(600);
  page.onKeyUp({ code: 'GlobalHook' });
  t.mock.timers.tick(600);
  page.onKeyUp({ code: 'GlobalHook' });
  assert.equal(page.data.surfacePhase, 'recovery');
  assert.equal(chooseSummaryAfterRecovery(page), true);
  assert.equal(page.data.surfacePhase, 'summary');
  t.mock.timers.tick(0);
  t.mock.timers.tick(80);
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.ok(wx.ttsSpoken.some((line) => line.includes('公里')), 'TTS 必须播报最终总结: ' + JSON.stringify(wx.ttsSpoken));
});

test('首包宽限 20s:订阅后首包慢不会被 8s 看门狗误杀;真超时后 02 自动重连', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  const host = scanHost();
  const { device, char } = fakeHrDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({ currentTarget: { attributes: { 'data-id': device.id } } });
  assert.equal(page.data.bleState, 'connected');

  t.mock.timers.tick(9000);   // 旧 8s 窗口:首包未到不得误杀
  await flushAsync();
  assert.equal(page.data.bleState, 'connected', '首包宽限期内不许断链');

  char.notify(98);            // 首包 9 秒才到:连接照常存活
  t.mock.timers.tick(5000);
  await flushAsync();
  assert.equal(page.data.bleState, 'connected', '有包之后 8s 新鲜度照常');

  t.mock.timers.tick(9000);   // 停止发包 >8s:此时才判断连
  await flushAsync();
  assert.ok(page.data.keyBeacon.includes('DP:wd'), '断因必须上信标: ' + page.data.keyBeacon);
  assert.equal(page.data.searchText, '自动重连中', '02 断连不再死等用户');

  t.mock.timers.tick(4100);   // 02 自动重连同一设备
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(page.data.bleState, 'connected', '02 页也自动重连恢复');
});

test('重开扫描失败:按 1.2/2.5/5s 梯次自动重试,退避用尽不再重试', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  const host = scanHost({ failScan: 'host busy tearing down' });
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  assert.equal(host.scanCalls, 1);

  const ladder = [[1300, 2], [2600, 3], [5100, 4], [5100, 5], [8100, 6], [8100, 7]];
  for (const [ms, calls] of ladder) {
    t.mock.timers.tick(ms);
    await flushAsync();
    assert.equal(host.scanCalls, calls, `梯次退避第 ${calls - 1} 次自动重试`);
  }
  t.mock.timers.tick(60000);
  await flushAsync();
  assert.equal(host.scanCalls, 7, '约 30s 预算用尽后不再打扰宿主');
  assert.equal(page.data.primaryLabel, '下一步', '始终不堵路');
});

test('连接桥悬空:10s 整链超时解锁,自动重连接管;预算耗尽才落回眼镜', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  const host = scanHost();
  const { device } = fakeHrDevice('fenix 8');
  let connectCalls = 0;
  device.gatt.connect = () => { connectCalls += 1; return new Promise(() => {}); }; // 永远悬空
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  page.onConnectTap();
  await flushAsync(); await flushAsync();
  assert.equal(connectCalls, 1);
  assert.equal(page.data.showHeartRate, false, '无数据不冒充心率版面(数据驱动)');

  t.mock.timers.tick(10100);   // 整链 JS 侧等待上限
  await flushAsync(); await flushAsync();
  assert.equal(page.data.bleState, 'idle', '悬空桥不再把 connecting 卡成永久卡死');
  assert.equal(page.autoConnectPending, false, 'pending 必须随尝试落定而清除');
  assert.equal(page.data.showHeartRate, false, '始终无数据:版面保持眼镜,不横跳');

  t.mock.timers.tick(4100);    // 第一次自动重连
  await flushAsync(); await flushAsync();
  assert.equal(connectCalls, 2, '自动重连再次发起连接');

  // 连续悬空直到 5 次预算打光:此刻才允许落回眼镜版面
  for (let i = 0; i < 6; i += 1) {
    t.mock.timers.tick(10100);
    await flushAsync(); await flushAsync();
    t.mock.timers.tick(4100);
    await flushAsync(); await flushAsync();
  }
  assert.equal(page.data.showHeartRate, false, '预算耗尽才真正落回眼镜');
  assert.equal(page.reconnectDevice, null, '放弃后清空重连目标');
});

test('息屏杀不死掉线重连:onShow 重排,恢复后心率原位回归', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  const host = scanHost();
  const { device, char } = fakeHrDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({ currentTarget: { attributes: { 'data-id': device.id } } });
  char.notify(120);
  page.onConnectTap();
  assert.equal(page.data.surfacePhase, 'hud');

  device.gatt.disconnect();          // 掉线 → 4s 重连排定
  assert.ok(page.hudReconnectTimer, '掉线后重连排定');
  page.onHide();                     // 息屏清定时器
  assert.equal(page.hudReconnectTimer, null, 'onHide 清掉定时器');
  page.onShow();                     // 亮屏必须重排,不许永久哑火
  assert.ok(page.hudReconnectTimer, 'onShow 必须重排重连');

  t.mock.timers.tick(4100);
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(page.data.bleState, 'connected', '亮屏后自动重连恢复');
  char.notify(118);
  page.tick();
  assert.equal(page.data.bpm, '118', '心率原位回归');
});

test('入场自动连接失败不再单发放弃:4s 自动重试成功,心率原位补上', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  const host = scanHost();
  const { device, char } = fakeHrDevice('fenix 8');
  let failsLeft = 1;
  const origConnect = device.gatt.connect.bind(device.gatt);
  device.gatt.connect = () => {
    if (failsLeft > 0) { failsLeft -= 1; return Promise.reject(new Error('host busy tearing down')); }
    return origConnect();
  };
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  page.onConnectTap();
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(page.data.bleState, 'idle', '首次入场连接失败');
  assert.equal(page.data.showHeartRate, false, '无数据保持眼镜版面(数据驱动,零横跳)');

  t.mock.timers.tick(4100);
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(page.data.bleState, 'connected', '4s 自动重试成功');
  char.notify(121);
  page.tick();
  assert.equal(page.data.bpm, '121');
  assert.equal(page.data.showHeartRate, true, '数据回流即心率版面');
});

test('进入跑步页立即停扫省电:迟到广播不再接入,版面跟随入场状态', async () => {
  const page = freshPage();
  const host = scanHost();
  const { device } = fakeHrDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  page.onConnectTap();   // 一台都没扫到:眼镜模式入场
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.data.showHeartRate, false);
  await flushAsync();
  assert.ok(host.stops >= 1, '进入跑步页必须停止扫描(省电)');
  assert.equal(page.scanSession, null, '扫描会话已释放');

  host.onDeviceFound({ device });   // 宿主迟到派发的广播:一律丢弃
  await flushAsync(); await flushAsync();
  assert.equal(page.data.bleState, 'idle', '停扫后不再接入任何迟到设备');
  assert.equal(page.data.showHeartRate, false, '版面跟随入场状态,不再变化');
  page.onUnload();
});

test('跑过一场三次确认进放松，不写首页退出提示;02 直接退出也不写', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  page.onLoad();
  makeInteractive(page);
  page.onConnectTap();
  t.mock.timers.tick(30000);
  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  t.mock.timers.tick(600);
  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  t.mock.timers.tick(600);
  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  assert.equal(page.data.surfacePhase, 'recovery');
  assert.equal(wx.store.has('aiui_run_finished_at'), false,
    '总结页会直接关闭智能体，不得再预点亮首页退出');

  const idlePage = freshPage();          // 02 待机直接退出:不算跑完
  idlePage.onLoad();
  idlePage.onKeyUp({ code: 'Backspace' });
  assert.equal(wx.store.has('aiui_run_finished_at'), false, '没跑过不许预点亮退出');
  idlePage.onUnload();
});

test('Backspace 退出后,扫描重试定时器不得在僵尸实例上复活扫描', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  const host = scanHost({ failScan: 'host busy' });
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  assert.equal(host.scanCalls, 1);
  page.onKeyUp({ code: 'Backspace' });   // 宿主随后弹出该页
  t.mock.timers.tick(20000);
  await flushAsync();
  assert.equal(host.scanCalls, 1, '退出后的重试定时器必须哑火');
});

test('实例复用防毒化:onLoad 复位 backspaceHandled/runUploadQueued 棘轮位', () => {
  const page = freshPage();
  page.backspaceHandled = true;
  page.runUploadQueued = true;
  page.onLoad();
  assert.equal(page.backspaceHandled, false, '第二场跑步不许被上一场的返回位毒化');
  assert.equal(page.runUploadQueued, false, '第二场的总结/上传不许被上一场吞掉');
  page.onUnload();
});

test('跑中每 15s 写总结检查点:进程被杀也能在下次启动出总结', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  page.onLoad();
  makeRunning(page);

  t.mock.timers.tick(20000);
  const pending = wx.store.get('pending_run_summary');
  assert.ok(pending, '跑中必须周期性落总结检查点');
  assert.ok(pending.elapsedMs >= 15000, '检查点跟得上跑步进度: ' + pending.elapsedMs);

  // 正常结束:最终快照覆盖检查点。
  t.mock.timers.tick(5000);
  page.finishRunForHostBack();
  const finalPending = wx.store.get('pending_run_summary');
  assert.ok(finalPending.elapsedMs >= 24000, '正常结束用最终快照覆盖: ' + finalPending.elapsedMs);
});

test('跑中检查点静默写失败不推进 15s 棘轮，storage 恢复后下一 tick 立即重试', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  page.onLoad();
  const baseSet = wx.setStorageSync.bind(wx);
  wx.setStorageSync = (key, value) => {
    if (key === 'pending_run_summary') return;
    baseSet(key, value);
  };
  makeRunning(page);
  t.mock.timers.tick(1000);
  assert.equal(page.lastSummaryCheckpointMs, null);
  assert.equal(wx.store.has('pending_run_summary'), false);

  wx.setStorageSync = baseSet;
  page.tick();
  assert.ok(Number.isFinite(page.lastSummaryCheckpointMs));
  assert.ok(wx.store.get('pending_run_summary'));
});

test('跑步中掉线:自动对同一设备重连,恢复后心率原位回归', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  const host = scanHost();
  const { device, char } = fakeHrDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({ currentTarget: { attributes: { 'data-id': device.id } } });
  char.notify(120);
  page.onConnectTap();
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.data.showHeartRate, true);

  // 宿主侧断连:进入自动重连;重连在途版面保持心率态(bpm 置空),不横跳眼镜版面
  device.gatt.disconnect();
  assert.equal(page.data.bleState, 'idle');
  assert.equal(page.data.coachLine, '心率重连中');
  assert.equal(page.data.showHeartRate, true, '重连已排定:心率版面稳住不横跳');
  assert.equal(page.data.bpm, '', '掉线期间心率数字必须置空');

  t.mock.timers.tick(4100);
  await flushAsync();
  await flushAsync();
  await flushAsync();
  assert.equal(page.data.bleState, 'connected', '4s 后自动重连同一设备');
  char.notify(124);
  page.tick();
  assert.equal(page.data.bpm, '124', '重连成功心率原位回归');
  assert.equal(page.data.showHeartRate, true);
  assert.equal(page.data.running, true, '全程跑步不中断');
});

test('devicefound:按稳定 ID 去重上屏,原始次数照计,统计随事件更新', async () => {
  const page = freshPage();
  const host = scanHost();
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device: { id: 'garmin-1', name: 'fenix 8' } });
  host.onDeviceFound({ device: { id: 'garmin-1', name: 'fenix 8' } });
  host.onDeviceFound({ device: { id: 'mac-2', name: 'SmartRun Mac HR' } });
  assert.deepEqual(page.data.discoveredDevices.map((d) => d.deviceId), ['garmin-1', 'mac-2']);
  assert.equal(page.data.discoveredDeviceCount, 2);
  assert.equal(page.data.scanProgressText, '已发现 2 台');
  assert.equal(page.rawAdvertisementCount, 3, '原始广播次数仍保留给诊断日志');
  assert.equal(page.data.scanDiagnostic, '已发现 2 台设备');
  page.onUnload();
});

test('点设备行:停扫描后按样例链路连接(connect→180D→2A37→listener→notify),成功即记住', async () => {
  const page = freshPage();
  const host = scanHost();
  const { device, char } = fakeHrDevice('fenix 8');
  const order = [];
  const origConnect = device.gatt.connect.bind(device.gatt);
  device.gatt.connect = async () => { order.push('connect'); return origConnect(); };
  const origStart = char.startNotifications.bind(char);
  char.startNotifications = async () => { order.push('notify'); return origStart(); };
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({ currentTarget: { attributes: { 'data-id': device.id } } });
  assert.equal(host.stops, 1, '连接前必须停止扫描');
  assert.deepEqual(order, ['connect', 'notify']);
  assert.equal(page.data.bleState, 'connected');
  assert.equal(
    page.data.discoveredDevices.find((d) => d.deviceId === device.id).status,
    '已连接',
  );
  assert.deepEqual(wx.store.get('heart_rate_device'), {
    deviceId: device.id, deviceName: 'fenix 8',
  }, '手动点选 = 显式配对,订阅成功后记住');

  char.notify(96);
  assert.equal(page.data.searchChip, '已连接');
  page.onConnectTap();
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.data.bpm, '96', '入场携带新鲜 BPM 直接显示心率 HUD');
  page.onUnload();
});

test('HR-only 设备缺少可选 RSC 时仍保持心率连接，且不会把 2A37 重复当成 2A53', async () => {
  const page = freshPage();
  const host = scanHost();
  const { device, char, server } = fakeHrDevice('Polar H10');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });

  const connected = await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });
  if (page.rscProbePromise) await page.rscProbePromise;

  assert.equal(connected, true, 'RSC 缺失不能反向判定 HR 连接失败');
  assert.equal(page.data.bleState, 'connected');
  assert.equal(device.gatt.connected, true);
  assert.equal(device.gatt.disconnectCalls, 0, '可选 RSC 探测失败不能拆掉共享 GATT');
  assert.equal(char.startNotificationsCalls, 1,
    'HR characteristic 只能订阅一次，不能被 RSC 探测重复使用');
  assert.equal((char.listeners.characteristicvaluechanged || []).length, 1);
  assert.equal(page.rscCharacteristic, null);
  assert.deepEqual(server.getPrimaryServiceCalls, [
    'heart_rate',
    '00001814-0000-1000-8000-00805f9b34fb',
  ]);

  char.notify(108);
  page.onConnectTap();
  page.tick();
  assert.equal(page.data.bpm, '108', '可选增强缺失时标准 HR notify 仍正常驱动 HUD');
  assert.equal(page.data.paceConnected, false, '只有 HR 不能冒充设备配速已接入');
  assert.equal(page.data.motionSourceHint, '眼镜估算');
  page.onUnload();
});

test('RSC 原生探测悬空会有界超时，保持 HRS 并在 HUD 稍后重试成功', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const page = freshPage();
  t.after(() => page.onUnload());
  const host = scanHost();
  const {
    device, hrChar, rscChar,
  } = fakeHrRscDevice('fenix 8');
  let resolveFirstRscStart;
  rscChar.startNotifications = function startNotifications() {
    this.startNotificationsCalls += 1;
    if (this.startNotificationsCalls === 1) {
      return new Promise((resolve) => {
        resolveFirstRscStart = () => resolve(this);
      });
    }
    return Promise.resolve(this);
  };

  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  const connected = await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });

  assert.equal(connected, true);
  assert.equal(page.data.bleState, 'connected');
  assert.ok(page.rscProbePromise, '可选 RSC 桥仍在等待时必须可诊断');
  assert.equal(hrChar.startNotificationsCalls, 1);
  assert.equal(device.gatt.disconnectCalls, 0);

  t.mock.timers.tick(8000);
  await flushAsync();
  await flushAsync();
  assert.equal(page.rscProbePromise, null, 'RSC 等待上限后释放 JS 探测位');
  assert.ok(page.rscProbeRetryAtMs > Date.now());
  assert.equal(page.data.bleState, 'connected', 'RSC 超时不能拆掉 HRS 状态');
  assert.equal(device.gatt.disconnectCalls, 0);
  assert.equal((hrChar.listeners.characteristicvaluechanged || []).length, 1);
  assert.equal((rscChar.listeners.characteristicvaluechanged || []).length, 0,
    '超时的旧代次必须立刻摘掉自己的 RSC listener');
  assert.ok(logs.some((line) => line.includes(
    '[SmartRun BLE] RSC_PROBE_TIMEOUT afterMs=8000 retryInMs=5000',
  )));

  hrChar.notify(122);
  page.onConnectTap();
  page.stopTicker();
  page.tick();
  assert.equal(page.data.bpm, '122', 'RSC 超时期间心率继续正常显示');

  t.mock.timers.tick(5000);
  page.tick();
  await flushAsync();
  const retryPromise = page.rscProbePromise;
  if (retryPromise) await retryPromise;
  await flushAsync();

  assert.equal(rscChar.startNotificationsCalls, 2);
  assert.equal(page.rscCharacteristic, rscChar);
  assert.equal((rscChar.listeners.characteristicvaluechanged || []).length, 1);
  assert.equal(page.data.bleState, 'connected');
  assert.equal(device.gatt.disconnectCalls, 0);
  assert.ok(logs.some((line) => line.includes(
    '[SmartRun BLE] RSC_PROBE_RETRY source=hud-tick',
  )));

  resolveFirstRscStart();
  await flushAsync();
  await flushAsync();
  assert.equal(rscChar.stopNotificationsCalls, 0,
    '旧 startNotifications 迟到兑现不得停止新代次正在使用的通知');
  assert.equal(page.rscCharacteristic, rscChar);
  assert.equal((rscChar.listeners.characteristicvaluechanged || []).length, 1);
});

test('室内跑 RSC 普通桥接失败后保留 HRS，并在 HUD 到期重试', async () => {
  const page = freshPage();
  const host = scanHost();
  const { device, hrChar, rscChar } = fakeHrRscDevice('fenix 8');
  let rscAttempts = 0;
  rscChar.startNotifications = async function startNotifications() {
    this.startNotificationsCalls += 1;
    rscAttempts += 1;
    if (rscAttempts === 1) throw new Error('temporary RSC bridge failure');
    return this;
  };

  page.onLoad({ mode: 'garmin_virtual' });
  pagesToClean.push(page);
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  const connected = await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });
  if (page.rscProbePromise) await page.rscProbePromise;

  assert.equal(connected, true);
  assert.equal(page.data.bleState, 'connected');
  assert.equal(hrChar.startNotificationsCalls, 1);
  assert.equal(rscChar.startNotificationsCalls, 1);
  assert.ok(page.rscProbeRetryAtMs > Date.now(),
    '非超时 RSC 失败也要安排独立重试，不能永久停在 IMU 回退');
  assert.equal(device.gatt.disconnectCalls, 0, 'RSC 失败不得拆共享 HRS/GATT');

  page.onConnectTap();
  page.stopTicker();
  page.rscProbeRetryAtMs = Date.now() - 1;
  page.tick();
  await flushAsync();
  if (page.rscProbePromise) await page.rscProbePromise;
  assert.equal(rscChar.startNotificationsCalls, 2);
  assert.equal(page.rscCharacteristic, rscChar);
  assert.equal(page.data.bleState, 'connected');
});

test('RSC 诊断严格区分服务、订阅、非法包、首个合法包与后续静默', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const page = freshPage();
  t.after(() => page.onUnload());
  const host = scanHost();
  const { device, hrChar, rscChar } = fakeHrRscDevice('fenix 8');
  page.onLoad({ mode: 'garmin_virtual' });
  assert.equal(page.data.searchChip, '室内跑');
  assert.match(page.data.searchText, /Garmin.*START/);
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });

  const connected = await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });
  if (page.rscProbePromise) await page.rscProbePromise;
  if (page.rscFeatureProbePromise) await page.rscFeatureProbePromise;

  assert.equal(connected, true);
  assert.equal(page.rscLive, false,
    '2A53 订阅成功不能在首个合法包之前冒充实时接入');
  assert.equal(page.lastRscAtMs, null);
  assert.ok(Number.isFinite(page.rscSubscribedAtMs));
  assert.ok(logs.some((line) => line.includes(
    '[SmartRun BLE] RSC_SERVICE_FOUND service=1814',
  )));
  assert.ok(logs.some((line) => line.includes(
    '[SmartRun BLE] RSC_SUBSCRIBED service=1814 characteristic=2a53',
  )));
  assert.ok(!logs.some((line) => line.includes('RSC_FIRST_PACKET')));

  rscChar.notify([0x00, 0x01, 0x02]);
  assert.equal(page.rscInvalidPacketCount, 1);
  assert.equal(page.rscLive, false,
    '无法解析的 2A53 通知不能更新 live 或 freshness');
  assert.equal(page.lastRscAtMs, null);
  assert.ok(logs.some((line) => line.includes(
    '[SmartRun BLE] RSC_PACKET_INVALID length=3 count=1',
  )));

  t.mock.timers.tick(2501);
  await flushAsync(); await flushAsync();
  assert.ok(logs.some((line) => line.includes(
    '[SmartRun BLE] RSC_SILENT since=subscription ageMs=2501'
      + ' validPackets=0 invalidPackets=1',
  )), '订阅成功但从未收到合法包时必须输出独立静默诊断');
  assert.equal(page.rscCharacteristic, null, '静默订阅必须独立退役旧 2A53');
  assert.equal((rscChar.listeners.characteristicvaluechanged || []).length, 0);
  assert.equal(rscChar.stopNotificationsCalls, 1);
  assert.ok(page.rscProbeRetryAtMs > Date.now(), '静默后必须排定 5 秒重探');
  assert.equal((hrChar.listeners.characteristicvaluechanged || []).length, 1,
    'RSC 静默不得摘除 2A37 listener');
  assert.equal(device.gatt.disconnectCalls, 0, 'RSC 静默不得断开共享 GATT');

  t.mock.timers.tick(5000);
  page.onShow();
  await flushAsync();
  if (page.rscProbePromise) await page.rscProbePromise;
  assert.equal(rscChar.startNotificationsCalls, 2, '到期后应在同一 GATT 上重探 2A53');
  assert.equal((rscChar.listeners.characteristicvaluechanged || []).length, 1);
  t.mock.timers.tick(1000);
  rscChar.notify({ speedMps: 3, cadenceSpm: 180, running: true });
  assert.equal(page.rscPacketCount, 1);
  assert.equal(page.rscLive, true);
  assert.equal(page.lastRscAtMs, Date.now());
  assert.equal(page.data.searchText, '室内跑配速与步频已接入');
  assert.equal(page.data.searchChip, '配速接入');
  assert.ok(logs.some((line) => line.includes(
    '[SmartRun BLE] RSC_FIRST_PACKET afterMs=1000 flags=0x04',
  )));

  t.mock.timers.tick(2501);
  await flushAsync(); await flushAsync();
  assert.equal(page.rscLive, false,
    '合法数据超过 RSC freshness 后诊断 live 必须关闭');
  assert.ok(logs.some((line) => line.includes(
    '[SmartRun BLE] RSC_SILENT since=last-packet ageMs=2501'
      + ' validPackets=1 invalidPackets=0',
  )));
  assert.equal(page.rscCharacteristic, null);
  assert.equal(rscChar.stopNotificationsCalls, 2);
  assert.equal((hrChar.listeners.characteristicvaluechanged || []).length, 1);
  assert.equal(device.gatt.disconnectCalls, 0);
});

test('HRS+RSC 静默仅回收 2A53，IMU 补距后重探首包重锚、次包继续增长', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const host = scanHost();
  const {
    device, hrChar, rscChar,
  } = fakeHrRscDevice('fenix 8');

  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });
  if (page.rscProbePromise) await page.rscProbePromise;
  hrChar.notify(128);
  page.onConnectTap();
  page.stopTicker();

  rscChar.notify({
    speedMps: 2, cadenceSpm: 170, totalDistanceM: 100, running: true,
  });
  t.mock.timers.tick(1000);
  rscChar.notify({
    speedMps: 2, cadenceSpm: 170, totalDistanceM: 102, running: true,
  });
  const beforeSilenceM = page.motionMetrics.snapshot(Date.now()).distanceM;
  assert.ok(beforeSilenceM >= 1.99 && beforeSilenceM <= 2.01,
    `RSC 第二包应形成 2m 增量，实际 ${beforeSilenceM}`);
  assert.equal(page.motionMetrics.snapshot(Date.now()).rscConnected, true);

  t.mock.timers.tick(2501);
  await flushAsync(); await flushAsync();
  assert.equal(page.rscCharacteristic, null, 'RSC 静默后旧 characteristic 必须释放');
  assert.equal((rscChar.listeners.characteristicvaluechanged || []).length, 0);
  assert.equal(page.motionMetrics.snapshot(Date.now()).rscConnected, false,
    '静默必须同步通知 MotionMetrics 释放 RSC 账本');
  assert.equal((hrChar.listeners.characteristicvaluechanged || []).length, 1,
    'HRS listener 必须跨 RSC 恢复保留');
  assert.equal(device.gatt.disconnectCalls, 0);

  t.mock.timers.tick(500);
  page.motionMetrics.onAcceptedStep(Date.now(), 120);
  t.mock.timers.tick(500);
  page.motionMetrics.onAcceptedStep(Date.now(), 120);
  const afterImuGapM = page.motionMetrics.snapshot(Date.now()).distanceM;
  assert.ok(afterImuGapM > beforeSilenceM,
    'RSC 静默后 IMU 必须立即补距，不能让距离停止增长');
  hrChar.notify(129);

  t.mock.timers.tick(4000);
  page.tick();
  await flushAsync();
  if (page.rscProbePromise) await page.rscProbePromise;
  assert.equal(rscChar.startNotificationsCalls, 2, '5 秒到期后重探同一 2A53');
  assert.equal((rscChar.listeners.characteristicvaluechanged || []).length, 1);
  const beforeReanchorM = page.motionMetrics.snapshot(Date.now()).distanceM;

  rscChar.notify({
    speedMps: 2, cadenceSpm: 170, totalDistanceM: 107, running: true,
  });
  assert.equal(page.motionMetrics.snapshot(Date.now()).distanceM, beforeReanchorM,
    '重连首个累计距离包只建立新锚点，不能回灌 IMU 已补的断流段');
  t.mock.timers.tick(1000);
  rscChar.notify({
    speedMps: 2, cadenceSpm: 170, totalDistanceM: 109, running: true,
  });
  const afterSecondPacketM = page.motionMetrics.snapshot(Date.now()).distanceM;
  assert.ok(Math.abs(afterSecondPacketM - beforeReanchorM - 2) < 0.01,
    '重探第二包应从新锚点继续增加 2m');
  assert.equal((hrChar.listeners.characteristicvaluechanged || []).length, 1);
  assert.equal(device.gatt.disconnectCalls, 0);
  page.onUnload();
});

test('共享 GATT 整体掉线后 IMU 补距，同设备重连首个 RSC 包重锚、次包续增', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const host = scanHost();
  const { device, hrChar, rscChar } = fakeHrRscDevice('fenix 8');

  page.onLoad({ mode: 'garmin_virtual' });
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  assert.equal(await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  }), true);
  if (page.rscProbePromise) await page.rscProbePromise;
  hrChar.notify(126);
  page.onConnectTap();
  page.stopTicker();

  rscChar.notify({
    speedMps: 2, cadenceSpm: 170, totalDistanceM: 100, running: true,
  });
  t.mock.timers.tick(1000);
  rscChar.notify({
    speedMps: 2, cadenceSpm: 170, totalDistanceM: 102, running: true,
  });
  const beforeDropM = page.motionMetrics.snapshot(Date.now()).distanceM;
  assert.ok(Math.abs(beforeDropM - 2) < 0.01);

  // 模拟整条共享 GATT 从设备侧断开；HRS/RSC 都应退役，但跑步账本继续。
  device.gatt.disconnect();
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(page.data.bleState, 'idle');
  assert.equal(page.motionMetrics.snapshot(Date.now()).rscConnected, false);
  assert.equal((hrChar.listeners.characteristicvaluechanged || []).length, 0);
  assert.equal((rscChar.listeners.characteristicvaluechanged || []).length, 0);
  assert.ok(page.hudReconnectTimer, '掉线后必须无感排定同设备重连');

  t.mock.timers.tick(500);
  page.motionMetrics.onAcceptedStep(Date.now(), 120);
  t.mock.timers.tick(500);
  page.motionMetrics.onAcceptedStep(Date.now(), 120);
  const afterImuGapM = page.motionMetrics.snapshot(Date.now()).distanceM;
  assert.ok(afterImuGapM > beforeDropM,
    '共享 GATT 断流后 IMU 必须接管并补距，距离不能永久冻结');

  // 掉线发生在 t=1s，4s 重连到期为 t=5s；前面已推进 1s。
  t.mock.timers.tick(3000);
  await flushAsync(); await flushAsync(); await flushAsync();
  if (page.rscProbePromise) await page.rscProbePromise;
  assert.equal(device.gatt.connectCalls, 2, '应只对同一设备建立一条新 GATT');
  assert.equal(hrChar.startNotificationsCalls, 2);
  assert.equal(rscChar.startNotificationsCalls, 2);
  assert.equal((hrChar.listeners.characteristicvaluechanged || []).length, 1);
  assert.equal((rscChar.listeners.characteristicvaluechanged || []).length, 1);
  hrChar.notify(129);

  const beforeReanchorM = page.motionMetrics.snapshot(Date.now()).distanceM;
  rscChar.notify({
    speedMps: 2, cadenceSpm: 170, totalDistanceM: 110, running: true,
  });
  assert.equal(page.motionMetrics.snapshot(Date.now()).distanceM, beforeReanchorM,
    'GATT 重连首个累计距离包只能重锚，不能回灌断流期间的设备累计值');
  t.mock.timers.tick(1000);
  rscChar.notify({
    speedMps: 2, cadenceSpm: 170, totalDistanceM: 112, running: true,
  });
  assert.ok(Math.abs(
    page.motionMetrics.snapshot(Date.now()).distanceM - beforeReanchorM - 2,
  ) < 0.01, '重连第二包必须从新锚点继续增加 2m');
  assert.equal(page.data.bleState, 'connected');
  assert.equal(page.data.bpm, '129');
  page.onUnload();
});

test('隐藏跨过 RSC 新鲜期后恢复会重武装静默诊断，只重探 2A53 并连续计距', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const host = scanHost();
  const { device, hrChar, rscChar } = fakeHrRscDevice('fenix 8');
  page.onLoad({ mode: 'garmin_virtual' });
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });
  if (page.rscProbePromise) await page.rscProbePromise;
  hrChar.notify(126);
  page.onConnectTap();
  page.stopTicker();

  rscChar.notify({
    speedMps: 2, cadenceSpm: 170, totalDistanceM: 100, running: true,
  });
  t.mock.timers.tick(1000);
  rscChar.notify({
    speedMps: 2, cadenceSpm: 170, totalDistanceM: 102, running: true,
  });
  const beforeHideM = page.motionMetrics.snapshot(Date.now()).distanceM;
  assert.ok(beforeHideM >= 1.99 && beforeHideM <= 2.01);

  page.onHide();
  t.mock.timers.tick(3000);
  await flushAsync();
  assert.equal(page.rscSilentTimer, null,
    '隐藏期到点的 timer 必须哑火，不能在后台操作 GATT');
  assert.equal(page.rscCharacteristic, rscChar);
  assert.equal(rscChar.stopNotificationsCalls, 0);

  page.onShow();
  assert.ok(page.rscSilentTimer != null,
    '恢复可见时必须重新按旧 freshness 锚点武装静默诊断');
  t.mock.timers.tick(1);
  await flushAsync(); await flushAsync();
  assert.equal(page.rscCharacteristic, null);
  assert.equal(rscChar.stopNotificationsCalls, 1,
    '已过期 2A53 只在恢复可见后独立退役');
  assert.equal((hrChar.listeners.characteristicvaluechanged || []).length, 1,
    'HRS listener 必须跨隐藏和 RSC 重探保留');
  assert.equal(device.gatt.disconnectCalls, 0,
    'RSC 恢复不得拆掉共享 GATT');

  t.mock.timers.tick(5000);
  page.tick();
  await flushAsync();
  if (page.rscProbePromise) await page.rscProbePromise;
  assert.equal(rscChar.startNotificationsCalls, 2);
  const beforeReanchorM = page.motionMetrics.snapshot(Date.now()).distanceM;
  rscChar.notify({
    speedMps: 2, cadenceSpm: 170, totalDistanceM: 108, running: true,
  });
  assert.equal(page.motionMetrics.snapshot(Date.now()).distanceM, beforeReanchorM,
    '重探首个累计距离包只重锚，不回灌隐藏段');
  t.mock.timers.tick(1000);
  rscChar.notify({
    speedMps: 2, cadenceSpm: 170, totalDistanceM: 110, running: true,
  });
  assert.ok(Math.abs(
    page.motionMetrics.snapshot(Date.now()).distanceM - beforeReanchorM - 2,
  ) < 0.01, '重探第二包必须继续增加 2m');
  assert.equal((hrChar.listeners.characteristicvaluechanged || []).length, 1);
  assert.equal(device.gatt.disconnectCalls, 0);
  page.onUnload();
});

test('RSC startNotifications 跨隐藏迟到兑现不得提交旧 listener，恢复后只建一条新探测', async () => {
  const page = freshPage();
  const host = scanHost();
  const { device, hrChar, rscChar } = fakeHrRscDevice('fenix 8');
  let releaseFirstNotifications;
  rscChar.startNotificationsCalls = 0;
  rscChar.startNotifications = () => {
    rscChar.startNotificationsCalls += 1;
    if (rscChar.startNotificationsCalls === 1) {
      return new Promise((resolve) => { releaseFirstNotifications = resolve; });
    }
    return Promise.resolve(rscChar);
  };

  page.onLoad({ mode: 'garmin_virtual' });
  pagesToClean.push(page);
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  assert.equal(await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  }), true);
  assert.equal(typeof releaseFirstNotifications, 'function');
  assert.ok(page.rscProbePromise);
  assert.equal(page.rscCharacteristic, null);
  assert.equal((rscChar.listeners.characteristicvaluechanged || []).length, 1);
  hrChar.notify(124);
  page.onConnectTap();
  assert.notEqual(page.data.surfacePhase, 'ready');

  const staleProbe = page.rscProbePromise;
  page.onHide();
  const invalidatedGeneration = page.rscProbeGeneration;
  page.onShow();
  releaseFirstNotifications(rscChar);
  await staleProbe;
  await flushAsync(); await flushAsync(); await flushAsync();
  if (page.rscProbePromise) await page.rscProbePromise;

  assert.ok(page.rscProbeGeneration > invalidatedGeneration,
    '恢复后必须建立全新 RSC generation');
  assert.equal(rscChar.startNotificationsCalls, 2,
    '旧桥收尾后只允许一次可见态重探');
  assert.equal(page.rscCharacteristic, rscChar);
  assert.equal((rscChar.listeners.characteristicvaluechanged || []).length, 1,
    '旧 listener 必须先摘除，不能与新 listener 叠加');
  assert.equal((hrChar.listeners.characteristicvaluechanged || []).length, 1);
  assert.equal(device.gatt.disconnectCalls, 0,
    'RSC 探测代次切换不得拆共享 HRS/GATT');
});

test('teardown 后旧 RSC startNotifications 迟到不得停止新代复用的同一 2A53', async () => {
  const page = freshPage();
  const host = scanHost();
  const {
    device, hrChar, rscChar, server,
  } = fakeHrRscDevice('fenix 8');
  let releaseFirstNotifications;
  rscChar.startNotifications = function startNotifications() {
    this.startNotificationsCalls += 1;
    if (this.startNotificationsCalls === 1) {
      return new Promise((resolve) => { releaseFirstNotifications = resolve; });
    }
    return Promise.resolve(this);
  };

  page.onLoad({ mode: 'garmin_virtual' });
  pagesToClean.push(page);
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  assert.equal(await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  }), true);
  const staleProbe = page.rscProbePromise;
  assert.ok(staleProbe);
  assert.equal(typeof releaseFirstNotifications, 'function');

  await page.teardownBle();
  assert.equal(page.rscProbePromise, null,
    'teardown 必须先释放旧探测槽位，允许下一代连接继续');

  // 模拟同一 Garmin 在下一代 GATT 连接中返回同一 JS characteristic 实例。
  // 这是部分原生桥的真实行为，也是旧 Promise 最容易误停新通知的边界。
  device.gatt.connected = true;
  page.bleDevice = device;
  page.bleServer = server;
  page.hrCharacteristic = hrChar;
  page.setData({ bleState: 'connected' });
  assert.equal(page.probeOptionalRsc(device, server), true);
  if (page.rscProbePromise) await page.rscProbePromise;
  assert.equal(page.rscCharacteristic, rscChar);
  assert.equal((rscChar.listeners.characteristicvaluechanged || []).length, 2,
    '旧原生 Promise 兑现前其 listener 尚待异步自清理');
  const stopCallsAfterNewCommit = rscChar.stopNotificationsCalls;

  releaseFirstNotifications(rscChar);
  await staleProbe;
  await flushAsync(); await flushAsync();

  assert.equal(rscChar.stopNotificationsCalls, stopCallsAfterNewCommit,
    '旧代迟到只能摘自己的 listener，不能 stop 新代复用的 2A53');
  assert.equal(page.rscCharacteristic, rscChar);
  assert.equal((rscChar.listeners.characteristicvaluechanged || []).length, 1);
  assert.equal(device.gatt.connected, true);
});

test('2A54 能力位在 2A53 已订阅后 best-effort 读取，读取结果不改变共享 HRS/RSC', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const page = freshPage();
  t.after(() => page.onUnload());
  const host = scanHost();
  const {
    device, hrChar, rscChar, server,
  } = fakeHrRscDevice('fenix 8');
  const originalGetPrimaryService = server.getPrimaryService.bind(server);
  let featureReadCalls = 0;
  server.getPrimaryService = async (uuid) => {
    const service = await originalGetPrimaryService(uuid);
    if (!String(uuid).toLowerCase().includes('1814')) return service;
    const originalGetCharacteristic = service.getCharacteristic.bind(service);
    return {
      async getCharacteristic(characteristicUuid) {
        if (String(characteristicUuid).toLowerCase().includes('2a54')) {
          return {
            async readValue() {
              featureReadCalls += 1;
              return [0x07, 0x00];
            },
          };
        }
        return originalGetCharacteristic(characteristicUuid);
      },
    };
  };

  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  const connected = await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });
  if (page.rscProbePromise) await page.rscProbePromise;
  if (page.rscFeatureProbePromise) await page.rscFeatureProbePromise;
  await flushAsync();

  assert.equal(connected, true);
  assert.equal(featureReadCalls, 1);
  assert.equal(page.rscFeatureFlags, 0x0007);
  assert.equal(page.data.bleState, 'connected');
  assert.equal(device.gatt.connected, true);
  assert.equal(device.gatt.disconnectCalls, 0);
  assert.equal(hrChar.startNotificationsCalls, 1);
  assert.equal(rscChar.startNotificationsCalls, 1);
  assert.ok(logs.some((line) => line.includes(
    '[SmartRun BLE] RSC_FEATURE flags=0x0007'
      + ' stride=true totalDistance=true walkingOrRunning=true',
  )));
});

test('迟到的 2A54 读取在 BLE 收场后不得复活 RSC 能力状态', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const page = freshPage();
  t.after(() => page.onUnload());
  const host = scanHost();
  const { device, server } = fakeHrRscDevice('fenix 8');
  const originalGetPrimaryService = server.getPrimaryService.bind(server);
  let resolveFeatureRead;
  server.getPrimaryService = async (uuid) => {
    const service = await originalGetPrimaryService(uuid);
    if (!String(uuid).toLowerCase().includes('1814')) return service;
    const originalGetCharacteristic = service.getCharacteristic.bind(service);
    return {
      async getCharacteristic(characteristicUuid) {
        if (String(characteristicUuid).toLowerCase().includes('2a54')) {
          return {
            readValue() {
              return new Promise((resolve) => { resolveFeatureRead = resolve; });
            },
          };
        }
        return originalGetCharacteristic(characteristicUuid);
      },
    };
  };

  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });
  if (page.rscProbePromise) await page.rscProbePromise;
  const lateFeatureProbe = page.rscFeatureProbePromise;
  assert.ok(lateFeatureProbe);
  assert.equal(typeof resolveFeatureRead, 'function');

  await page.teardownBle({ terminal: true });
  resolveFeatureRead([0x07, 0x00]);
  await lateFeatureProbe;

  assert.equal(page.rscFeatureFlags, null);
  assert.equal(page.rscLive, false);
  assert.equal(page.rscSubscribedAtMs, null);
  assert.equal(page.rscSilentTimer, null);
  assert.ok(!logs.some((line) => line.includes('[SmartRun BLE] RSC_FEATURE flags=')),
    '旧 generation 的迟到 2A54 结果不得写回或输出成功诊断');
});

test('HR+RSC 双服务使用独立通知，2A53 驱动步频/距离/配速并在收场时全部清理', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const host = scanHost();
  const {
    device, hrChar, rscChar, server,
  } = fakeHrRscDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });

  const connected = await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });
  if (page.rscProbePromise) await page.rscProbePromise;
  assert.equal(connected, true);
  assert.equal(page.rscCharacteristic, rscChar);
  assert.notEqual(hrChar, rscChar, 'HR 与 RSC 必须拥有独立 characteristic');
  assert.equal(hrChar.startNotificationsCalls, 1);
  assert.equal(rscChar.startNotificationsCalls, 1);
  assert.deepEqual(server.getPrimaryServiceCalls, [
    'heart_rate',
    '00001814-0000-1000-8000-00805f9b34fb',
  ]);

  hrChar.notify(112);
  page.onConnectTap();
  page.stopTicker();
  assert.equal(page.data.surfacePhase, 'hud');

  // 3m/s 连续 12 秒；第一包建立 RSC 累计距离基线，后续每秒增加 3m。
  for (let second = 1; second <= 12; second += 1) {
    t.mock.timers.tick(1000);
    rscChar.notify({
      speedMps: 3,
      cadenceSpm: 180,
      totalDistanceM: second * 3,
      running: true,
    });
    if (second === 1) {
      assert.equal(page.data.paceConnected, true,
        '未手动调用 tick，首个合法正速度事件也应点亮设备配速接入');
      assert.equal(page.data.pace, '5:33', '首个合法 RSC 正速度应直接显示即时配速');
      const fused = page.speedFusion.snapshot(Date.now());
      assert.equal(fused.source, 'rsc',
        '首个合法 RSC 速度应立即成为显示来源');
      assert.ok(Math.abs(fused.speedMps - 3) < 0.01);
    }
  }

  assert.equal(page.data.cadence, '180', 'IMU 尚无落步时应采用新鲜 RSC 步频');
  assert.equal(page.data.pace, '5:33', '滚动窗口应由 RSC 累计距离生成约 5:33/km');
  assert.equal(page.data.distVal, '0.03', 'RSC 累计距离增量必须进入跑步距离');
  assert.ok(page.motionMetrics.distanceM >= 32.9 && page.motionMetrics.distanceM <= 33.1);
  assert.equal(page.motionMetrics.acceptedSteps, 0,
    'RSC-only 场景不得伪造眼镜 IMU acceptedSteps');
  assert.ok(page.adaptiveStrideModel.estimate(180).sampleCount >= 1,
    '累计距离 RSC 应以 2A53 cadence×dt 独立形成步长学习窗口');

  await page.teardownBle({ terminal: true });
  assert.equal(hrChar.stopNotificationsCalls, 1, '收场必须停止 HR notify');
  assert.equal(rscChar.stopNotificationsCalls, 1, '收场必须停止 RSC notify');
  assert.equal((hrChar.listeners.characteristicvaluechanged || []).length, 0);
  assert.equal((rscChar.listeners.characteristicvaluechanged || []).length, 0);
  assert.equal(device.gatt.disconnectCalls, 1, '双服务共用的 GATT 只能断开一次');
  assert.equal(page.rscSubscribedAtMs, null);
  assert.equal(page.lastRscAtMs, null);
  assert.equal(page.rscLive, false);
  assert.equal(page.rscSilentTimer, null);
  page.onUnload();
});

test('RSC 速度积分用 2A53 cadence×dt 学习且不依赖 IMU，零值/断流/暂停/重连均重置', (t) => {
  const originalDateNow = Date.now;
  let clock = 1_750_200_000_000;
  Date.now = () => clock;
  const page = bootRunning();
  page.stopTicker();
  t.after(() => {
    try { page.onUnload(); } catch (_e) {}
    Date.now = originalDateNow;
  });

  const windows = [];
  page.adaptiveStrideModel.observeWindow = (window) => {
    windows.push({ ...window });
    return { accepted: false, reason: 'test-capture' };
  };
  const positiveMeasurement = { speedMps: 3, cadenceSpm: 180 };
  const positiveResult = (distanceAddedM, distanceSource = MOTION_SOURCE.RSC_SPEED) => ({
    accepted: true,
    speedAccepted: true,
    incoherentSpeed: false,
    outlierRejected: false,
    distanceAddedM,
    distanceSource,
  });

  // 首包只建 cadence 锚点；随后 8 秒恰好形成 24 步、24 米。
  page.motionMetrics.acceptedSteps = 700;
  page.observeRscStrideCalibration(
    positiveMeasurement,
    positiveResult(0, MOTION_SOURCE.NONE),
    clock,
  );
  for (let second = 1; second <= 8; second += 1) {
    clock += 1000;
    // 人为制造完全不相关的 IMU 计数，RSC 学习结果不应随之改变。
    page.motionMetrics.acceptedSteps += 47 + second;
    page.observeRscStrideCalibration(
      positiveMeasurement,
      positiveResult(3),
      clock,
    );
  }
  assert.equal(windows.length, 1);
  assert.ok(Math.abs(windows[0].steps - 24) < 0.0001);
  assert.equal(windows[0].durationMs, 8000);
  assert.ok(Math.abs(windows[0].cadenceSpm - 180) < 0.0001);
  assert.equal(windows[0].distanceM, 24);
  assert.equal(windows[0].source, MOTION_SOURCE.RSC_SPEED);

  clock += 1000;
  page.observeRscStrideCalibration(positiveMeasurement, positiveResult(3), clock);
  assert.ok(page.strideCalibration.rsc.steps > 0);
  clock += 1000;
  page.observeRscStrideCalibration(
    { speedMps: 0, cadenceSpm: 0 },
    {
      accepted: true,
      speedAccepted: true,
      incoherentSpeed: false,
      outlierRejected: false,
      distanceAddedM: 0,
      distanceSource: MOTION_SOURCE.NONE,
    },
    clock,
  );
  assert.equal(page.strideCalibration.rsc, null, '明确 0 cadence 必须清学习窗口');

  clock += 1000;
  page.observeRscStrideCalibration(
    positiveMeasurement,
    positiveResult(0, MOTION_SOURCE.NONE),
    clock,
  );
  clock += 2501;
  page.observeRscStrideCalibration(positiveMeasurement, positiveResult(3), clock);
  assert.equal(page.strideCalibration.rsc.steps, 0, '超过 RSC freshness 后首包只重建锚点');
  assert.equal(page.strideCalibration.rsc.distanceM, 0,
    '断流恢复首包的距离不能跨代进入学习');

  clock += 1000;
  page.observeRscStrideCalibration(positiveMeasurement, positiveResult(3), clock);
  assert.ok(page.strideCalibration.rsc.steps > 0);
  page.motionMetrics.pause(clock + 1);
  page.observeRscStrideCalibration(
    positiveMeasurement,
    positiveResult(3),
    clock + 2,
  );
  assert.equal(page.strideCalibration.rsc, null, '暂停中的迟到 RSC 包必须清学习窗口');
  page.motionMetrics.resume(clock + 3);

  page.observeRscStrideCalibration(
    positiveMeasurement,
    positiveResult(0, MOTION_SOURCE.NONE),
    clock + 4,
  );
  assert.ok(page.strideCalibration.rsc);
  page.teardownBle();
  assert.equal(page.strideCalibration.rsc, null, 'GATT 重连代次必须从新 cadence 锚点开始');
});

test('合法 RSC 运动后出现零步频尾包时清空设备源，但 HUD 保留本场可信数字', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const host = scanHost();
  const { device, hrChar, rscChar } = fakeHrRscDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({ currentTarget: { attributes: { 'data-id': device.id } } });
  if (page.rscProbePromise) await page.rscProbePromise;
  hrChar.notify(118);
  page.onConnectTap();
  page.stopTicker();

  rscChar.notify({ speedMps: 5, cadenceSpm: 180, running: true });
  page.tick();
  assert.equal(page.data.pace, '3:20');
  assert.equal(page.data.cadence, '180');
  assert.equal(page.speedFusion.snapshot(Date.now()).source, 'rsc');

  t.mock.timers.tick(100);
  rscChar.notify({ speedMps: 5, cadenceSpm: 0, running: false });
  page.tick();
  assert.match(page.data.pace, /^\d+:\d{2}$/,
    '矛盾尾包应撤销设备实时源，但已开始运动后 HUD 必须显示本场安全数值');
  assert.match(page.data.cadence, /^\d+$/,
    '矛盾尾包应撤销设备实时源，但已开始运动后 HUD 不得退回 -- 或 -');
  assert.equal(page.data.paceConnected, false);
  assert.equal(page.speedFusion.snapshot(Date.now()).source, 'none');
  assert.equal(page.motionMetrics.snapshot(Date.now()).activeMotionSource, 'none');
});

test('RSC 持续上报 0 时不压住眼镜落步，页面回退 IMU 步频/距离/配速且不亮配速接入', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const host = scanHost();
  const { device, hrChar, rscChar } = fakeHrRscDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({ currentTarget: { attributes: { 'data-id': device.id } } });
  if (page.rscProbePromise) await page.rscProbePromise;
  hrChar.notify(118);
  page.onConnectTap();
  page.stopTicker();
  bypassImuArming(page);

  rscChar.notify({ speedMps: 0, cadenceSpm: 0, running: false });
  page.tick();
  assert.equal(page.data.paceConnected, false);
  assert.equal(page.data.cadence, '--');

  const accel = FakeAccelerometer.instances[0];
  for (let index = 0; index < 30; index += 1) {
    accel.emitReading(0, 0, 12.5);
    t.mock.timers.tick(176);
    accel.emitReading(0, 0, 8.5);
    t.mock.timers.tick(177);
  }
  page.tick();

  assert.ok(Number(page.data.cadence) >= 150, '设备 0 步频时应采用眼镜检测到的真实节奏');
  assert.notEqual(page.data.pace, '正在计算', 'IMU 足量运动后应给出眼镜估算配速');
  assert.ok(Number(page.data.distVal) > 0, 'RSC 0 速度不能阻止 IMU 补距');
  assert.equal(page.data.paceConnected, false, '0 速度/0 步频不能点亮设备配速接入');
  assert.equal(page.data.motionSourceHint, '眼镜估算');
  page.onUnload();
});

test('HR 超过 8s 但 RSC 仍新鲜时保留共享 GATT，新 HR 包到达后原位恢复', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const host = scanHost();
  const { device, hrChar, rscChar } = fakeHrRscDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });
  if (page.rscProbePromise) await page.rscProbePromise;

  hrChar.notify(126);
  page.onConnectTap();
  page.stopTicker();
  page.tick();
  assert.equal(page.data.bpm, '126');

  // HR 在 t=0 后不再发包；t=7s 刷新一次 RSC，使 8.001s HR watchdog 到期时
  // RSC 年龄仅 1.001s，仍处于 2.5s freshness 窗口。
  advanceWithLiveRsc(t, rscChar, 7000);
  t.mock.timers.tick(1001);
  page.tick();

  assert.equal(page.data.bleState, 'connected', 'HR stale 不得把 RSC 活链降为 idle');
  assert.equal(device.gatt.connected, true);
  assert.equal(device.gatt.disconnectCalls, 0, 'RSC 新鲜时不得断开共享 GATT');
  assert.equal(page.data.bpm, '', 'HR stale 后必须清空旧 BPM，不能展示冻结值');
  assert.equal(page.hrDegradedByRsc, true);

  hrChar.notify(132);
  page.tick();
  assert.equal(page.data.bleState, 'connected');
  assert.equal(device.gatt.disconnectCalls, 0);
  assert.equal(page.data.bpm, '132', '新 HR notify 应在同一 HUD 原位恢复');
  assert.equal(page.hrDegradedByRsc, false);

  await page.teardownBle({ terminal: true });
  page.onUnload();
});

test('HR 静默但 RSC 仍新鲜时有界重新武装 2A37，仅合法首包确认恢复', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const host = scanHost();
  const { device, hrChar, rscChar } = fakeHrRscDevice('fenix 8');
  const recoveryCallOrder = [];
  const originalHrStart = hrChar.startNotifications.bind(hrChar);
  const originalHrStop = hrChar.stopNotifications.bind(hrChar);
  hrChar.startNotifications = function startNotifications() {
    if (this.startNotificationsCalls >= 1) recoveryCallOrder.push('start');
    return originalHrStart();
  };
  hrChar.stopNotifications = function stopNotifications() {
    if (this.startNotificationsCalls >= 1) recoveryCallOrder.push('stop');
    return originalHrStop();
  };
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });
  if (page.rscProbePromise) await page.rscProbePromise;
  const originalRscListener = page.rscListener;

  hrChar.notify(126);
  page.onConnectTap();
  page.stopTicker();
  advanceWithLiveRsc(t, rscChar, 7000);
  t.mock.timers.tick(1001);
  page.tick();
  assert.equal(page.hrDegradedByRsc, true);
  assert.equal(page.data.bpm, '');

  t.mock.timers.tick(1000);
  await flushAsync(); await flushAsync();
  assert.equal(hrChar.startNotificationsCalls, 2,
    '共享 GATT 上只重新武装 HRS notification');
  assert.deepEqual(recoveryCallOrder, ['stop', 'start'],
    '静默恢复必须只对 2A37 执行有界 stop→start，而不是幂等 start no-op');
  assert.equal(rscChar.startNotificationsCalls, 1, 'RSC 订阅不得重建');
  assert.equal(page.rscListener, originalRscListener, 'RSC listener 不得替换');
  assert.equal(device.gatt.disconnectCalls, 0, 'RSC fresh 时不得拆共享 GATT');
  assert.equal(page.hrNotifyRecoveryCount, 1);
  assert.equal(page.data.bpm, '', 'startNotifications resolve 不得冒充心率恢复');

  hrChar.emitValue([0x00, 0]);
  assert.equal(page.hrNotifyRecoveryCount, 1, '无效包不得清恢复预算');
  assert.equal(page.data.bpm, '');
  hrChar.notify(132);
  page.tick();
  assert.equal(page.data.bpm, '132');
  assert.equal(page.hrDegradedByRsc, false);
  assert.equal(page.hrNotifyRecoveryCount, 0, '仅合法首包重置预算');
  assert.equal(page.hrNotifyRecoveryTimer, null);
  assert.equal(device.gatt.disconnectCalls, 0);
  page.onUnload();
});

test('HRS 重新武装失败时保留 RSC/GATT 并有界排下次重试', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const host = scanHost();
  const { device, hrChar, rscChar } = fakeHrRscDevice('fenix 8');
  const originalStart = hrChar.startNotifications.bind(hrChar);
  let rejectRecovery = true;
  hrChar.startNotifications = async function startNotifications() {
    if (this.startNotificationsCalls >= 1 && rejectRecovery) {
      rejectRecovery = false;
      this.startNotificationsCalls += 1;
      throw new Error('notify bridge rejected');
    }
    return originalStart();
  };
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });
  if (page.rscProbePromise) await page.rscProbePromise;
  hrChar.notify(124);
  page.onConnectTap();
  page.stopTicker();

  advanceWithLiveRsc(t, rscChar, 7000);
  t.mock.timers.tick(1001);
  page.tick();
  t.mock.timers.tick(1000);
  await flushAsync(); await flushAsync();

  assert.equal(hrChar.startNotificationsCalls, 2);
  assert.equal(page.hrNotifyRecoveryCount, 1);
  assert.ok(page.hrNotifyRecoveryTimer, '失败后应有界排定下次尝试');
  assert.equal(page.data.bleState, 'connected');
  assert.equal(page.data.bpm, '');
  assert.equal(rscChar.startNotificationsCalls, 1);
  assert.equal(device.gatt.disconnectCalls, 0);
  page.onUnload();
});

test('HRS 重新武装悬空会有界超时，总结 teardown 后迟到 Promise 不得复活通知', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const host = scanHost();
  const { device, hrChar, rscChar } = fakeHrRscDevice('fenix 8');
  const originalStart = hrChar.startNotifications.bind(hrChar);
  let resolveLateStart = null;
  hrChar.startNotifications = function startNotifications() {
    if (this.startNotificationsCalls === 0) return originalStart();
    this.startNotificationsCalls += 1;
    return new Promise((resolve) => {
      resolveLateStart = () => resolve(this);
    });
  };
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });
  if (page.rscProbePromise) await page.rscProbePromise;
  hrChar.notify(122);
  page.onConnectTap();
  page.stopTicker();

  advanceWithLiveRsc(t, rscChar, 7000);
  t.mock.timers.tick(1001);
  page.tick();
  t.mock.timers.tick(1000);
  await flushAsync();
  assert.equal(hrChar.startNotificationsCalls, 2);
  assert.ok(resolveLateStart);

  // 超时窗内继续刷新 RSC，排除共享 GATT 已断开的情况。
  // 首个 RSC 包的 2.5s 新鲜窗已经过去约 2s；先在剩余 500ms 内补包，
  // 再每 2s 刷新，确保 HRS 5s 恢复超时到点时共享 RSC 始终有效。
  t.mock.timers.tick(400);
  rscChar.notify({ speedMps: 3, cadenceSpm: 180, running: true });
  t.mock.timers.tick(2000);
  rscChar.notify({ speedMps: 3, cadenceSpm: 180, running: true });
  t.mock.timers.tick(2000);
  rscChar.notify({ speedMps: 3, cadenceSpm: 180, running: true });
  t.mock.timers.tick(599);
  rscChar.notify({ speedMps: 3, cadenceSpm: 180, running: true });
  t.mock.timers.tick(2);
  await flushAsync();
  assert.equal(page.hrNotifyRecoveryCount, 1);
  assert.ok(page.hrNotifyRecoveryFlight, '超时后保留原生 single-flight，禁止叠加桥调用');
  assert.equal(page.scheduleHrNotificationRecovery(), false,
    '原生 startNotifications 仍悬空时不得启动第二条恢复链');
  assert.equal(hrChar.startNotificationsCalls, 2, '原请求未 settle 前不发第三次 startNotifications');

  assert.equal(page.finishRunToSummary(), true);
  const summaryPhase = page.data.surfacePhase;
  t.mock.timers.tick(0); // 运行 summary 首帧后的唯一 terminal BLE finalizer。
  await flushAsync(); await flushAsync();
  const stopsBeforeLate = hrChar.stopNotificationsCalls;
  assert.equal(stopsBeforeLate, 2,
    '一次恢复 stop 加一次 terminal teardown stop，不能提前重复清理');
  resolveLateStart();
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(page.data.surfacePhase, summaryPhase, '迟到 Promise 不得退出总结相位');
  assert.equal(page.data.bleState, 'idle');
  assert.equal(page.hrCharacteristic, null);
  assert.equal(hrChar.stopNotificationsCalls, stopsBeforeLate,
    'terminal teardown 已接管 characteristic，迟到 Promise 不得重复 stop');
  page.onUnload();
});

test('HRS 恢复原生调用跨 hide→show 保持 single-flight，settle 后才由新代次续试', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const host = scanHost();
  const { device, hrChar, rscChar } = fakeHrRscDevice('fenix 8');
  const originalStart = hrChar.startNotifications.bind(hrChar);
  let resolveHiddenStart = null;
  hrChar.startNotifications = function startNotifications() {
    if (this.startNotificationsCalls === 0) return originalStart();
    if (this.startNotificationsCalls === 1) {
      this.startNotificationsCalls += 1;
      return new Promise((resolve) => {
        resolveHiddenStart = () => resolve(this);
      });
    }
    return originalStart();
  };
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });
  if (page.rscProbePromise) await page.rscProbePromise;
  hrChar.notify(121);
  page.onConnectTap();
  page.stopTicker();
  advanceWithLiveRsc(t, rscChar, 7000);
  t.mock.timers.tick(1001);
  page.tick();
  t.mock.timers.tick(1000);
  await flushAsync(); await flushAsync();
  assert.equal(hrChar.startNotificationsCalls, 2);
  assert.ok(resolveHiddenStart);
  const hiddenFlight = page.hrNotifyRecoveryFlight;

  page.onHide();
  assert.equal(page.hrNotifyRecoveryFlight, hiddenFlight,
    '隐藏只能换代次，不能丢掉仍悬空的原生 single-flight');
  page.onShow();
  assert.equal(hrChar.startNotificationsCalls, 2,
    '恢复可见时旧 Promise 未 settle，不能叠加第二次原生 start');
  rscChar.notify({ speedMps: 3, cadenceSpm: 180, running: true });
  resolveHiddenStart();
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(page.hrNotifyRecoveryFlight, null);
  assert.ok(page.hrNotifyRecoveryTimer,
    '旧代次 settle 后，页面可见且 RSC fresh 时才排新代次');

  t.mock.timers.tick(2000);
  rscChar.notify({ speedMps: 3, cadenceSpm: 180, running: true });
  t.mock.timers.tick(1999);
  rscChar.notify({ speedMps: 3, cadenceSpm: 180, running: true });
  t.mock.timers.tick(1);
  await flushAsync(); await flushAsync();
  assert.equal(hrChar.startNotificationsCalls, 3,
    '新代次应在旧原生调用结算后且只启动一次');
  page.onUnload();
});

test('HRS 恢复定时器在隐藏期失效，不从非交互 InkView 发起原生订阅', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const host = scanHost();
  const { device, hrChar, rscChar } = fakeHrRscDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });
  if (page.rscProbePromise) await page.rscProbePromise;
  hrChar.notify(120);
  page.onConnectTap();
  page.stopTicker();
  advanceWithLiveRsc(t, rscChar, 7000);
  t.mock.timers.tick(1001);
  page.tick();
  assert.ok(page.hrNotifyRecoveryTimer);

  page.onHide();
  assert.equal(page.hrNotifyRecoveryTimer, null);
  t.mock.timers.tick(2000);
  await flushAsync();
  assert.equal(hrChar.startNotificationsCalls, 1,
    '隐藏期不得调用第二次 startNotifications');
  page.onUnload();
});

test('connecting 阶段掉线时从 connectingDevice 保留自动重连目标', () => {
  const page = freshPage();
  const { device } = fakeHrDevice('fenix 8');
  page.onLoad();
  page.onShow();
  page.setData({ surfacePhase: 'hud', bleState: 'connecting' });
  page.startRun();
  page.bleDevice = null;
  page.connectingDevice = device;
  page.reconnectDevice = null;

  page.onBleDropped('', 'evt');
  assert.equal(page.data.bleState, 'idle');
  assert.equal(page.reconnectDevice, device);
  assert.ok(page.hudReconnectTimer);
  page.onUnload();
});

test('02 未开跑时 HR stale/RSC fresh 会复用 watchdog 守到 RSC 到期，再断开共享 GATT', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  const host = scanHost();
  const { device, hrChar, rscChar } = fakeHrRscDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });
  if (page.rscProbePromise) await page.rscProbePromise;

  hrChar.notify(124);
  assert.equal(page.data.surfacePhase, 'connecting');
  assert.equal(page.timer, undefined, '02 尚未开跑，不存在 1Hz ticker 兜底');

  advanceWithLiveRsc(t, rscChar, 7000);
  t.mock.timers.tick(1001); // HR 8s + 1ms：RSC 仅 1.001s，必须保活

  assert.equal(page.data.bleState, 'connected');
  assert.equal(device.gatt.disconnectCalls, 0);
  assert.equal(page.hrDegradedByRsc, true);
  assert.ok(page.hrWatchdogTimer, '保活后仍须用同一 watchdog 安排 RSC 到期复核');

  t.mock.timers.tick(1499);
  assert.equal(device.gatt.disconnectCalls, 0, 'RSC freshness 边界内不能提前断开');
  t.mock.timers.tick(1); // lastRsc + 2500ms + 1ms
  assert.equal(page.data.bleState, 'idle', 'HR/RSC 两路均 stale 后走 onBleDropped');
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(device.gatt.connected, false);
  assert.equal(device.gatt.disconnectCalls, 1);
  assert.equal(page.hrWatchdogTimer, null);
  page.onUnload();
});

test('02 HR-stale/RSC-fresh 等待期收到新 HR，会取消旧 RSC 截止点并重置 8s watchdog', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  const host = scanHost();
  const { device, hrChar, rscChar } = fakeHrRscDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });
  if (page.rscProbePromise) await page.rscProbePromise;

  hrChar.notify(120);
  advanceWithLiveRsc(t, rscChar, 7000);
  t.mock.timers.tick(1001);
  assert.equal(page.hrDegradedByRsc, true);
  const rscDeadlineTimer = page.hrWatchdogTimer;

  t.mock.timers.tick(499);
  hrChar.notify(136);
  assert.equal(page.hrDegradedByRsc, false, '新 HR 包必须退出 RSC 保活降级态');
  assert.ok(page.hrWatchdogTimer);
  assert.notEqual(page.hrWatchdogTimer, rscDeadlineTimer,
    '新 HR 包必须替换旧的 RSC freshness 截止 timer');

  // 穿过旧 RSC 截止点仍保持连接，证明 timer 已按新 HR 的 8 秒窗口重置。
  t.mock.timers.tick(1001);
  assert.equal(page.data.surfacePhase, 'connecting');
  assert.equal(page.data.bleState, 'connected');
  assert.equal(device.gatt.disconnectCalls, 0);

  t.mock.timers.tick(7000); // 新 HR + 8s + 1ms，且 RSC 早已 stale
  assert.equal(page.data.bleState, 'idle');
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(device.gatt.disconnectCalls, 1);
  page.onUnload();
});

test('候选缺少 heart_rate 服务:标记可重试并回 idle,可再点其他设备', async () => {
  const page = freshPage();
  const host = scanHost();
  const bad = {
    id: 'not-hr', name: 'MacBook',
    gatt: {
      connected: false,
      async connect() {
        this.connected = true;
        return { async getPrimaryService() { throw new Error('service not found'); } };
      },
      disconnect() { this.connected = false; },
    },
  };
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device: bad });
  await page.selectDevice({ currentTarget: { attributes: { 'data-id': 'not-hr' } } });
  assert.equal(page.data.bleState, 'idle');
  assert.equal(page.data.searchChip, '可重试');
  assert.equal(page.data.searchText, '自动重连中', '失败后走自动重连,不死等用户');
  assert.ok(page.hudReconnectTimer, '重连定时器已排定');
  assert.equal(
    page.data.discoveredDevices.find((d) => d.deviceId === 'not-hr').status,
    '可重试',
  );
  assert.ok(page.data.keyBeacon.includes('EC:'), '连接失败原因上信标');
  page.onUnload();
});

test('gattserverdisconnected → 静默回眼镜;02 阶段显示已断开,可重扫', async () => {
  const page = freshPage();
  const host = scanHost();
  const { device, char } = fakeHrDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({ currentTarget: { attributes: { 'data-id': device.id } } });
  char.notify(90);
  assert.equal(page.data.bleState, 'connected');
  device.gatt.disconnect();
  assert.equal(page.data.bleState, 'idle');
  assert.equal(page.data.searchChip, '已断开');
  assert.equal(page.data.bpm, '');
  page.onUnload();
});

test('下一步任何时候可用且幂等;无 BLE 宿主也直接进单眼镜 HUD', async () => {
  const page = freshPage();
  globalThis.navigator = { bluetooth: {} };
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  assert.equal(page.data.searchChip, '未搜索');
  assert.equal(page.onConnectTap(), true);
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.data.running, true);
  assert.equal(page.data.showHeartRate, false);
  assert.equal(page.onConnectTap(), false, '重复点击幂等');
  page.onUnload();
});

test('扫描中隐藏:停扫描并回到点击开始搜索;恢复后由手势重新发起', async () => {
  const page = freshPage();
  const host = scanHost();
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  assert.equal(host.scanCalls, 1);
  page.onHide();
  assert.equal(page.data.surfacePhase, 'ready');
  assert.equal(page.data.searchChip, '未搜索');
  assert.equal(page.data.searchText, '单击开始搜索心率设备');
  page.onShow();
  await flushAsync();
  assert.equal(host.scanCalls, 1, '恢复可见不自动扫描');
  page.onScanTap();
  await flushAsync();
  assert.equal(host.scanCalls, 2, '手势重新发起');
  page.onUnload();
});

test('HUD 内 8s 无新包:看门狗静默回眼镜,跑步不中断', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  const host = scanHost();
  const { device, char } = fakeHrDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({ currentTarget: { attributes: { 'data-id': device.id } } });
  char.notify(100);
  page.onConnectTap();
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.data.bpm, '100');
  t.mock.timers.tick(9000);
  assert.equal(page.data.bleState, 'idle', '8s 无新包必须回收连接');
  assert.equal(page.data.running, true, '跑步不中断');
  assert.equal(page.data.showHeartRate, true, '15s 保持窗口内版面稳住');
  assert.equal(page.data.bpm, '', '断链后不许显示冻结心率');
  assert.ok(page.hudReconnectTimer || page.reconnectDevice, '重连已排定');

  // 单向棘轮:数据到过就锁心率版面,设备真消失也只置空数字,绝不中途降级
  page.teardownBle();   // 掐掉后续重连成功路径,模拟设备真消失
  page.reconnectDevice = null;
  t.mock.timers.tick(8000);   // 距最后一包 >15s
  page.tick();
  assert.equal(page.data.showHeartRate, true, '棘轮锁定:断了也不降级回眼镜');
  assert.equal(page.data.bpm, '', '数字保持置空,不显示冻结值');
});

test('02 搜索页四键循环主按钮与动态候选，只有当前焦点显示边框', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  const host = scanHost();
  const { device } = fakeHrDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  assert.equal(page.searchFocusIndex, 0);
  assert.match(page.data.searchPrimaryClass, /search-target-focused/);
  assert.doesNotMatch(page.data.discoveredDevices[0].deviceFocusClass, /device-row-focused/);

  let prevented = 0;
  const key = (code) => page.onKeyUp({ code, preventDefault() { prevented += 1; } });
  key('ArrowDown');
  assert.equal(page.searchFocusIndex, 1);
  assert.doesNotMatch(page.data.searchPrimaryClass, /search-target-focused/);
  assert.match(page.data.discoveredDevices[0].deviceFocusClass, /device-row-focused/);
  assert.equal([
    page.data.searchPrimaryClass,
    ...page.data.discoveredDevices.map((item) => item.deviceFocusClass),
  ].filter((className) => /(?:search-target|device-row)-focused/.test(className)).length, 1);

  releaseDirectionGesture(page);
  key('ArrowDown');
  assert.equal(page.searchFocusIndex, 0, '末个候选向下回到主按钮');
  releaseDirectionGesture(page);
  key('ArrowUp');
  assert.equal(page.searchFocusIndex, 1, '主按钮向上回到末个候选');

  let activationCount = 0;
  let activatedId = '';
  page.selectDevice = (event) => {
    activationCount += 1;
    activatedId = event.currentTarget.dataset.id;
    return true;
  };
  page.surfaceEntryConfirmGuardUntilMs = Date.now() - 1;
  key('GlobalHook');
  key('Enter');
  t.mock.timers.tick(599);
  assert.equal(activationCount, 0, '600ms 滑动/轻拍判别完成前不得激活候选');
  t.mock.timers.tick(1);
  await flushAsync();
  assert.equal(activationCount, 1, '同一物理确认的尾随键码在 400ms 内去重');
  assert.equal(activatedId, device.id);
  assert.equal(prevented, 5, '方向与确认键均提供替代行为并拦截宿主默认动作');
  page.onUnload();
});

test('02 超过四台设备时焦点驱动四行可视窗口，循环与激活仍使用完整候选索引', async () => {
  const page = freshPage();
  const host = scanHost();
  page.onLoad();
  makeInteractive(page);
  await flushAsync();

  const devices = Array.from({ length: 7 }, (_, index) => ({
    id: 'nearby-hr-' + String(index + 1),
    name: 'Heart Device ' + String(index + 1),
  }));
  for (const device of devices) host.onDeviceFound({ device });

  assert.equal(page.data.discoveredDeviceCount, 7);
  assert.deepEqual(
    page.data.discoveredDevices.map((item) => item.deviceId),
    devices.slice(0, 4).map((device) => device.id),
  );
  assert.equal(page.data.discoveredDeviceRange, '1–4 / 7');

  page.setSearchFocus(5);
  assert.equal(page.searchFocusIndex, 5);
  assert.deepEqual(
    page.data.discoveredDevices.map((item) => item.deviceId),
    devices.slice(4, 7).map((device) => device.id),
  );
  assert.equal(page.data.discoveredDeviceRange, '5–7 / 7');
  assert.equal(
    page.data.discoveredDevices.filter(
      (item) => /device-row-focused/.test(item.deviceFocusClass),
    ).length,
    1,
    '当前完整索引对应的设备必须在可视窗口内且只有一个焦点框',
  );

  page.setSearchFocus(7);
  assert.equal(page.setSearchFocus(8), 0, '末台设备向前继续循环回主按钮');
  assert.deepEqual(
    page.data.discoveredDevices.map((item) => item.deviceId),
    devices.slice(0, 4).map((device) => device.id),
    '主按钮重新显示首个候选窗口',
  );
  assert.equal(page.setSearchFocus(-1), 7, '主按钮向后循环到最后一台');
  assert.equal(page.data.discoveredDevices.at(-1).deviceId, devices[6].id);

  let activatedId = '';
  page.selectDevice = (event) => {
    activatedId = event.currentTarget.dataset.id;
    return true;
  };
  assert.equal(page.activateSearchFocused(), true);
  assert.equal(activatedId, devices[6].id,
    '确认必须按完整候选索引激活末台设备，不能误用窗口内局部索引');
  page.onUnload();
});

test('02 主按钮的 Enter/NumpadEnter/Space 只走宿主原生 bindtap', async () => {
  for (const code of ['Enter', 'NumpadEnter', 'Space']) {
    const page = freshPage();
    let scans = 0;
    globalThis.navigator = {
      bluetooth: {
        async scanDevices() {
          scans += 1;
          return { onDeviceFound() {}, async stop() {} };
        },
      },
    };
    page.onLoad();
    let prevented = false;
    page.onKeyUp({ code, preventDefault() { prevented = true; } });
    await flushAsync();
    assert.equal(prevented, false, `${code} 不得拦截原生 button 激活`);
    assert.equal(scans, 0, `${code} keyup 只是宿主通知，不得手动重复搜索`);

    await page.onScanTap(); // 宿主在 keyup 后派发的原生 bindtap
    assert.equal(scans, 1, `${code} 后续 bindtap 应复用 onScanTap`);
    assert.equal(page.data.primaryLabel, '下一步');
    page.onUnload();
  }
});

test('02 主按钮 GlobalHook 由页面延迟判定，并吞掉同手势 bindtap', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  let scans = 0;
  globalThis.navigator = {
    bluetooth: {
      async scanDevices() {
        scans += 1;
        return { onDeviceFound() {}, async stop() {} };
      },
    },
  };
  page.onLoad();
  let prevented = false;
  page.onKeyUp({ code: 'GlobalHook', preventDefault() { prevented = true; } });
  assert.equal(page.onScanTap(), false, '同手势 TouchEnd/bindtap 不得连续解释为下一步');
  assert.equal(scans, 0, '600ms 滑动/轻拍判别期内不抢先启动搜索');
  t.mock.timers.tick(599);
  assert.equal(scans, 0, '判别窗最后 1ms 仍不得启动搜索');
  t.mock.timers.tick(1);
  await flushAsync();
  assert.equal(prevented, true, 'GlobalHook 必须拦截并提供页面替代动作');
  assert.equal(scans, 1);
  assert.equal(page.data.primaryLabel, '下一步');
  assert.equal(page.data.surfacePhase, 'connecting');
  assert.equal(page.data.running, false);
  page.onUnload();
});

test('02 同一次 GlobalHook keyup 与 bindtap 只能开始搜索，不能连续解释成下一步', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  let scans = 0;
  globalThis.navigator = {
    bluetooth: {
      async scanDevices() {
        scans += 1;
        return { onDeviceFound() {}, async stop() {} };
      },
    },
  };
  page.onLoad();
  pagesToClean.push(page);
  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  assert.equal(page.scanAttempted, false, 'GlobalHook 先等待滑动/轻拍判别');
  assert.equal(page.onScanTap(), false, '同次 TouchEnd/bindtap 必须被跨通道去重');
  t.mock.timers.tick(599);
  assert.equal(page.scanAttempted, false, '600ms 判别窗结束前不得占用搜索语义');
  t.mock.timers.tick(1);
  assert.equal(page.scanAttempted, true, '判定为独立轻拍后在异步扫描前同步占用语义门');
  await flushAsync();
  assert.equal(scans, 1);
  assert.equal(page.data.surfacePhase, 'connecting');
  assert.equal(page.data.running, false, '第一次手势只能搜索，绝不能直接开跑');

  page.lastSurfaceActivationAtMs = Date.now() - 601;
  assert.equal(page.onScanTap(), true, '保护期后的新手势才是下一步');
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.data.running, true);
});

test('02 GlobalHook 抖动不会误退出，单击等待窗口结束后只激活一次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  let scans = 0;
  globalThis.navigator = {
    bluetooth: {
      async scanDevices() {
        scans += 1;
        return { onDeviceFound() {}, async stop() {} };
      },
    },
  };
  page.onLoad();
  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  t.mock.timers.tick(40);
  page.onKeyUp({ code: 'GlobalHook', preventDefault() {} });
  assert.equal(wx.exitMiniProgramCalls, 0, '90ms 内重复 GlobalHook 视为宿主抖动');
  assert.equal(scans, 0);
  t.mock.timers.tick(559);
  assert.equal(scans, 0, '600ms 判别窗结束前不得启动搜索');
  t.mock.timers.tick(1);
  await flushAsync();
  assert.equal(scans, 1, '第一次真实单击只在 600ms 窗口结束后提交一次');
  assert.equal(page.data.primaryLabel, '下一步');
  assert.equal(wx.exitMiniProgramCalls, 0);
  page.onUnload();
});

test('02 双击先取消待定单击，再清理扫描并关闭智能体', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  let scans = 0;
  globalThis.navigator = {
    bluetooth: {
      async scanDevices() {
        scans += 1;
        return { onDeviceFound() {}, async stop() {} };
      },
    },
  };
  page.onLoad();
  let prevented = 0;
  const tap = () => page.onKeyUp({
    code: 'GlobalHook',
    preventDefault() { prevented += 1; },
  });
  tap();
  assert.equal(page.onScanTap(), false, '第一击的尾随 bindtap 必须被吞掉');
  t.mock.timers.tick(140);
  tap();
  assert.equal(page.backspaceHandled, true, '第二击同步封死迟到扫描任务');
  assert.equal(page.agentExitRequested, true);
  assert.equal(page.onScanTap(), false, '退出后的 bindtap 不得复活“开始搜索/下一步”');
  await flushAsync();
  await flushAsync();
  assert.equal(scans, 0, '双击退出前不得提交第一击');
  assert.equal(wx.exitMiniProgramCalls, 1);
  assert.equal(prevented, 2);
  page.onUnload();
});

test('02 底部提示按启动来源区分退出智能体与返回兼容卡', () => {
  const page = boot();
  assert.equal(page.data.scanKeyGuide, '前后划选择 · 单击执行');
  assert.equal(page.data.scanExitGuide, '返回键退出 · 双击退出智能体');
  const fallback = freshPage();
  fallback.onLoad({ mode: 'free', fromHome: '1' });
  assert.equal(fallback.data.scanExitGuide, '返回键回首页 · 双击退出智能体');
  assert.match(runHudSource, /SEARCH_DOUBLE_TAP_WINDOW_MS = 420/);
  assert.match(runHudSource, /SEARCH_DOUBLE_TAP_MIN_GAP_MS = 90/);
  assert.match(runHudSource, /closeAgentFromSummary\('search-double-tap'\)/);
});

test('智能下一步:已扫到设备未点选,自动连最优候选并在 HUD 原位补心率', async () => {
  const page = freshPage();
  const host = scanHost();
  const { device, char } = fakeHrDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  assert.equal(page.data.discoveredDeviceCount, 1);

  // 不点设备行,直接下一步:立即进 HUD,后台自动连接
  page.onConnectTap();
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.data.running, true);
  await flushAsync();
  await flushAsync();
  await flushAsync();
  assert.equal(host.stops, 1, '自动连接前先停扫描');
  assert.equal(page.data.bleState, 'connected', '自动连上列表里的设备');
  char.notify(102);
  page.tick();
  assert.equal(page.data.bpm, '102', 'HUD 内通知到达即原位补心率');
  assert.equal(page.data.showHeartRate, true);
  page.onUnload();
});

test('智能下一步优先记住的设备;一台都没扫到则纯眼镜模式', async () => {
  const page = freshPage();
  const host = scanHost();
  const { device: mine } = fakeHrDevice('我的心率带');
  mine.id = 'mine-1';
  const { device: neighbor } = fakeHrDevice('邻居设备');
  neighbor.id = 'neighbor-1';
  let mineConnects = 0;
  const origMine = mine.gatt.connect.bind(mine.gatt);
  mine.gatt.connect = async () => { mineConnects += 1; return origMine(); };
  wx.store.set('heart_rate_device', { deviceId: 'mine-1', deviceName: '我的心率带' });

  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device: neighbor });
  host.onDeviceFound({ device: mine });
  page.onConnectTap();
  await flushAsync();
  await flushAsync();
  await flushAsync();
  assert.equal(mineConnects, 1, '记住的设备排在自动连接第一位');
  assert.equal(neighbor.gatt.connected, false);
  page.onUnload();
});

test('首选稳定 ID 迟到时邻近 HRS 只上屏，不得抢占共享 GATT', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const host = scanHost();
  const { device: mine } = fakeHrDevice('我的心率带');
  mine.id = 'mine-1';
  const { device: neighbor } = fakeHrDevice('邻居心率带');
  neighbor.id = 'neighbor-1';
  wx.store.set('heart_rate_device', {
    deviceId: 'mine-1',
    deviceName: '我的心率带',
  });

  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device: neighbor });
  t.mock.timers.tick(5000);
  await flushAsync(); await flushAsync();
  assert.equal(neighbor.gatt.connectCalls, 0,
    '有首选稳定 ID 时，先到的其他 HRS 经过任意等待仍不得自动连接');
  assert.equal(page.data.discoveredDeviceCount, 1, '邻近设备仍应保留在候选列表');
  assert.equal(page.data.bleState, 'scanning');

  host.onDeviceFound({ device: mine });
  t.mock.timers.tick(0);
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(mine.gatt.connectCalls, 1, '首选稳定 ID 到达后才提交连接');
  assert.equal(neighbor.gatt.connectCalls, 0);
  assert.equal(page.data.bleState, 'connected');
  assert.equal(page.data.surfacePhase, 'connecting', '自动连接不得替用户开始跑步');
  page.onUnload();
});

test('自动首选连接与手动点选竞态时手选胜出，旧设备 GATT 必须清理', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const { device: mine, char: mineChar, server: mineServer } = fakeHrDevice('我的心率带');
  mine.id = 'mine-1';
  const { device: neighbor, char: neighborChar } = fakeHrDevice('邻居心率带');
  neighbor.id = 'neighbor-1';
  let onDeviceFound = null;
  let releaseMineConnect = null;
  mine.gatt.connect = function connect() {
    this.connectCalls += 1;
    this.connected = true;
    return new Promise((resolve) => { releaseMineConnect = () => resolve(mineServer); });
  };
  globalThis.navigator = {
    bluetooth: {
      async scanDevices() {
        return {
          onDeviceFound(callback) { onDeviceFound = callback; },
          stop() {}, // 同步 stop 进入 250ms 真机原生收尾窗
        };
      },
    },
  };
  wx.store.set('heart_rate_device', {
    deviceId: 'mine-1',
    deviceName: '我的心率带',
  });

  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  onDeviceFound({ device: neighbor });
  onDeviceFound({ device: mine });
  t.mock.timers.tick(0);
  await flushAsync();
  assert.equal(page.autoConnectPending, true);
  assert.equal(mine.gatt.connectCalls, 0, '原生停扫收尾窗内尚未发起自动 GATT');

  t.mock.timers.tick(250);
  await flushAsync();
  assert.equal(mine.gatt.connectCalls, 1);
  assert.equal(page.data.bleState, 'connecting');
  assert.equal(typeof releaseMineConnect, 'function');

  releaseSurfaceGesture(page);
  assert.equal(await page.selectDevice({
    currentTarget: { attributes: { 'data-id': neighbor.id } },
  }), true, '明确手选必须替换仍悬空的自动首选');
  assert.equal(neighbor.gatt.connectCalls, 1);
  assert.equal(page.bleDevice, neighbor);
  assert.equal(page.selectedDeviceKey, neighbor.id);
  assert.equal((neighborChar.listeners.characteristicvaluechanged || []).length, 1);

  releaseMineConnect();
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(mine.gatt.disconnectCalls, 1,
    '旧自动尝试迟到兑现时必须归还不同设备的 GATT');
  assert.equal(mine.gatt.connected, false);
  assert.equal(mineChar.startNotificationsCalls, 0,
    '旧尝试在 connect 后的代次门即停止，不能再订阅 HRS');
  assert.equal((mineChar.listeners.characteristicvaluechanged || []).length, 0);
  assert.equal(page.bleDevice, neighbor);
  assert.equal(page.data.bleState, 'connected');
  assert.equal(page.autoConnectPending, false);
  assert.deepEqual(wx.store.get('heart_rate_device'), {
    deviceId: 'neighbor-1',
    deviceName: '邻居心率带',
  });
  page.onUnload();
});

test('宿主 gatt 不暴露 connected 属性时,已连接+新鲜 BPM 仍直接以心率模式入场', async () => {
  const page = freshPage();
  const host = scanHost();
  const { device, char } = fakeHrDevice('fenix 8');
  delete device.gatt.connected;                       // 真机宿主形态:属性缺失
  device.gatt.connect = async function connect() {
    return { getPrimaryService: async () => ({ getCharacteristic: async () => char }) };
  };
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({ currentTarget: { attributes: { 'data-id': device.id } } });
  char.notify(95);
  page.onConnectTap();
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.data.showHeartRate, true, '连接在手时必须直接心率入场,不许先眼镜模式再跳变');
  assert.equal(page.data.bpm, '95');
  page.onUnload();
});

test('纯眼镜 HUD 显示步频/配速降级来源，不渲染虚假的设备配速状态', () => {
  const page = bootRunning();
  page.tick();
  assert.equal(page.data.showHeartRate, false);
  assert.equal(page.data.paceConnected, false);
  assert.equal(page.data.motionSourceHint, '眼镜估算');
  assert.equal(page.data.dot1, 'dot', '无心率时保留区间状态但全部熄灭');
  assert.equal(page.data.dot5, 'dot');
});

test('扫描启动失败自动补一次重试(退出后立即重进的宿主拆除窗口)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const page = freshPage();
  t.after(() => page.onUnload());
  let scans = 0;
  globalThis.navigator = {
    bluetooth: {
      async scanDevices() {
        scans += 1;
        if (scans === 1) throw new Error('previous session tearing down');
        return { onDeviceFound() {}, async stop() {} };
      },
    },
  };
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  assert.equal(scans, 1);
  assert.equal(page.data.searchChip, '搜索失败');
  t.mock.timers.tick(1300);
  await flushAsync();
  await flushAsync();
  assert.equal(scans, 2, '1.2s 后必须自动重试一次');
  assert.equal(page.data.searchChip, '搜索中', '重试成功即恢复搜索');
});

test('版面纯数据驱动:首包未到先眼镜版面,数据到达原位换心率;已有数据直接心率', async () => {
  const page = freshPage();
  const host = scanHost();
  const { device, char } = fakeHrDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({ currentTarget: { attributes: { 'data-id': device.id } } });
  assert.equal(page.data.bleState, 'connected');
  // 不等首包直接下一步:没有数据就不冒充有心率
  page.onConnectTap();
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.data.showHeartRate, false, '无数据先眼镜版面,诚实不冒充');
  char.notify(118);
  page.tick();
  assert.equal(page.data.showHeartRate, true, '数据到达 1s 内原位换心率版面');
  assert.equal(page.data.bpm, '118');
  page.onUnload();
});

test('02 已有心率数据在流:下一步直接心率版面、数字与区间灯同步入场', async () => {
  const page = freshPage();
  const host = scanHost();
  const { device, char } = fakeHrDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  const now = Date.now();
  assert.equal(writeHeartRatePolicy(wx, {
    schema_version: 1,
    max_hr_bpm: 190,
    source: 'user_explicit',
    issued_at_ms: now - 1000,
    expires_at_ms: now + 60_000,
  }, {
    publicDeviceId: 'test-device-default',
    ownershipEpoch: 1,
    dataNamespace: 'test-owner-default',
  }, { nowMs: now }), true);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({ currentTarget: { attributes: { 'data-id': device.id } } });
  char.notify(152);   // 数据已在流，用户明确 maxHR=190 时为 Z4
  page.onConnectTap();
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.data.showHeartRate, true, '有数据直接心率版面');
  assert.equal(page.data.bpm, '152', '数字随入场直接带上');
  assert.equal(page.data.dot5, 'dot');
  assert.equal(page.data.dot4, 'dot dot-on');
  assert.equal(page.data.dot1, 'dot dot-on');
  page.onUnload();
});

test('主按钮变身:扫描启动即变"下一步",有设备自动连接直达跑步页', async () => {
  const page = freshPage();
  const host = scanHost();
  const { device, char } = fakeHrDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  assert.equal(page.data.primaryLabel, '下一步', '扫描一启动主按钮就变身,无设备也可直接开跑');
  host.onDeviceFound({ device });
  // 点主按钮 = 智能下一步:自动连接 + 进跑步页
  page.lastSurfaceActivationAtMs = Date.now() - 601;
  page.onScanTap();
  assert.equal(page.data.surfacePhase, 'hud');
  await flushAsync();
  await flushAsync();
  await flushAsync();
  assert.equal(page.data.bleState, 'connected', '变身后的主按钮触发自动连接');
  char.notify(105);
  page.tick();
  assert.equal(page.data.bpm, '105');
  page.onUnload();
});

test('三次确认结束后写入跑后总结待办,供下次前台代次后台归档', async () => {
  const page = freshPage();
  const host = scanHost();
  const { device, char } = fakeHrDevice('fenix 8');
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  host.onDeviceFound({ device });
  await page.selectDevice({ currentTarget: { attributes: { 'data-id': device.id } } });
  char.notify(150);
  page.onConnectTap();
  // 凑够上传门槛:直接驱动会话数据
  page.session.onSpeed(10, Date.now());
  page.session.distanceM = 1200;
  page.session.startMs = Date.now() - 10 * 60 * 1000;
  finishHudWithThreeIndependentConfirms(page);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pending = wx.store.get('pending_run_summary');
  assert.ok(pending, '三次确认结束跑步必须写入总结待办');
  assert.ok(pending.elapsedMs > 0);
  assert.equal(Math.round(pending.avgBpm), 150);
  page.onUnload();
});

test('AIUI 同步 stop 会给原生扫描短暂收尾，之后才发起 GATT 连接', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  const { device } = fakeHrDevice('fenix 8');
  let onDeviceFound = null;
  let stoppedAt = null;
  let connectedAt = null;
  let connectCalls = 0;
  const originalConnect = device.gatt.connect.bind(device.gatt);
  device.gatt.connect = async () => {
    connectCalls += 1;
    connectedAt = Date.now();
    return originalConnect();
  };
  globalThis.navigator = {
    bluetooth: {
      async scanDevices() {
        return {
          onDeviceFound(callback) { onDeviceFound = callback; },
          stop() { stoppedAt = Date.now(); }, // 真机 API：JS 边界同步，原生异步
        };
      },
    },
  };

  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  onDeviceFound({ device });
  const selecting = page.selectDevice({
    currentTarget: { attributes: { 'data-id': device.id } },
  });
  await flushAsync();
  assert.equal(connectCalls, 0, '原生停扫窗口内不得立即 connect');
  t.mock.timers.tick(249);
  await flushAsync();
  assert.equal(connectCalls, 0);
  t.mock.timers.tick(1);
  await selecting;
  assert.equal(connectCalls, 1);
  assert.ok(connectedAt - stoppedAt >= 250, `stop/connect 间隔过短: ${connectedAt - stoppedAt}ms`);
  page.onUnload();
});

test('智能入场在原生停扫窗口内息屏，亮屏后仍会连接原候选', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const { device } = fakeHrDevice('fenix 8');
  let onDeviceFound = null;
  let connectCalls = 0;
  const originalConnect = device.gatt.connect.bind(device.gatt);
  device.gatt.connect = async () => { connectCalls += 1; return originalConnect(); };
  globalThis.navigator = {
    bluetooth: {
      async scanDevices() {
        return {
          onDeviceFound(callback) { onDeviceFound = callback; },
          stop() {}, // 同步 JS stop，触发 250ms 原生 settle guard
        };
      },
    },
  };
  page.onLoad();
  makeInteractive(page);
  await flushAsync();
  onDeviceFound({ device });

  page.onConnectTap();
  assert.equal(page.data.surfacePhase, 'hud');
  assert.equal(page.reconnectDevice, device, '停扫等待前候选已持有');
  page.onHide();
  t.mock.timers.tick(250);
  await flushAsync(); await flushAsync();
  assert.equal(connectCalls, 0, '隐藏期不发起 GATT');

  page.onShow();
  assert.ok(page.hudReconnectTimer);
  t.mock.timers.tick(4100);
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(connectCalls, 1);
  assert.equal(page.data.bleState, 'connected');
  page.onUnload();
});

test('GATT 失败后 disconnect Promise 悬空也会有界解锁并排定重试', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  const { device, char } = fakeHrDevice('fenix 8');
  char.startNotifications = async () => { throw new Error('notify bridge rejected'); };
  let disconnectCalls = 0;
  device.gatt.disconnect = () => {
    disconnectCalls += 1;
    return new Promise(() => {}); // 模拟真机原生清理桥悬空
  };
  page.onLoad();
  page.onShow();
  page.setData({ surfacePhase: 'hud' });
  page.startRun();
  let settled = false;
  const connecting = page.connectSelected(device).then((value) => {
    settled = true;
    return value;
  });
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(settled, false, '清理还在有界等待');
  t.mock.timers.tick(601);
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(await connecting, false);
  assert.equal(disconnectCalls, 1);
  assert.equal(page.data.bleState, 'idle', '悬空清理不能把界面卡在 connecting');
  assert.ok(page.hudReconnectTimer, '失败后仍须进入自动重试');
  page.onUnload();
});

test('HUD 后台连接期间短暂 onHide/onShow 会保留目标并重连', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const { device, server } = fakeHrDevice('fenix 8');
  let resolveFirst = null;
  let connectCalls = 0;
  const originalConnect = device.gatt.connect.bind(device.gatt);
  device.gatt.connect = () => {
    connectCalls += 1;
    if (connectCalls === 1) {
      return new Promise((resolve) => { resolveFirst = resolve; });
    }
    return originalConnect();
  };
  page.onLoad();
  page.onShow();
  page.setData({ surfacePhase: 'hud' });
  page.startRun();
  const first = page.connectSelected(device);
  await flushAsync();
  assert.equal(page.data.bleState, 'connecting');

  page.onHide();
  assert.equal(page.reconnectDevice, device, '隐藏前要保留在途目标');
  assert.equal(page.data.bleState, 'idle');
  page.onShow();
  assert.ok(page.hudReconnectTimer, '恢复交互后必须重排');
  t.mock.timers.tick(4100);
  await flushAsync(); await flushAsync(); await flushAsync();
  assert.equal(connectCalls, 2);
  assert.equal(page.data.bleState, 'connected', '新尝试已接管连接');

  resolveFirst(server); // 旧宿主请求迟到兑现，不得拆新链路
  assert.equal(await first, false);
  await flushAsync();
  assert.equal(page.data.bleState, 'connected');
  assert.equal(device.gatt.connected, true);
  page.onUnload();
});

test('订阅成功但永远无心率首包时，5 次重连预算不会被假成功反复清零', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const page = freshPage();
  const { device } = fakeHrDevice('fenix 8');
  page.onLoad();
  page.onShow();
  page.setData({ surfacePhase: 'hud' });
  page.startRun();
  assert.equal(await page.connectSelected(device), true);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    t.mock.timers.tick(20001);
    await flushAsync(); await flushAsync();
    assert.equal(page.data.bleState, 'idle');
    t.mock.timers.tick(4100);
    await flushAsync(); await flushAsync(); await flushAsync();
    assert.equal(page.data.bleState, 'connected', `第 ${attempt} 次重连已订阅`);
    assert.equal(page.hudReconnectCount, attempt, '无有效首包不得清预算');
  }

  t.mock.timers.tick(20001);
  await flushAsync(); await flushAsync();
  assert.equal(page.data.bleState, 'idle');
  assert.equal(page.hudReconnectCount, 5);
  assert.equal(page.reconnectDevice, null, '预算用尽后停止无限重连');
  assert.equal(page.hudReconnectTimer, null);
  page.onUnload();
});
