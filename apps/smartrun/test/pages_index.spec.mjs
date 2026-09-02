// 首页页面级行为测试:静态品牌引导、宿主按键与跑步记录静默补传。
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPageModule, instantiatePage, fakeWx } from './helpers/load_page.mjs';
import { PENDING_RUNS_KEY } from '../lib/run_upload.js';
import {
  HOST_BACKSPACE_SOURCE_KEY,
  SCAN_EXIT_HINT_KEY,
} from '../lib/surface_resume.js';
import { OWNER_TRANSITION_PENDING_STORAGE_KEY } from '../lib/device_identity.js';
import {
  AIUI_CALIBRATION_BATCH_SIZE,
  PENDING_AIUI_CALIBRATION_KEY,
  appendPendingAiuiCalibrationEvents,
  readPendingAiuiCalibrationEvents,
  readPendingAiuiCalibrationEventsState,
} from '../lib/aiui_calibration.js';
import {
  QUARANTINED_AIUI_CALIBRATION_KEY,
  QUARANTINED_RUN_UPLOADS_KEY,
  readQuarantinedAiuiCalibrationEvents,
  readQuarantinedRunUploads,
} from '../lib/run_upload_records.js';

const pageDef = await loadPageModule('index');
const PRODUCT_VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

let wx;
function freshPage() {
  wx = fakeWx();
  // Public runtime is offline by default. Network-contract tests opt in with
  // an explicit non-production fixture endpoint.
  wx.store.set('coach_base_url', 'https://coach.example.test');
  globalThis.__pageWx = wx;
  delete globalThis.navigator;   // 默认无 BLE 宿主
  return instantiatePage(pageDef);
}
after(() => { delete globalThis.__pageWx; });
// 页面生命周期会并行启动身份、跑步、校准、记忆与总结任务；测试 wx 通过
// globalThis.__pageWx 动态代理。每条用例结束后先排空这些同步失败路径的
// Promise，避免上一页面的迟到任务在下一条用例换 wx 后被错误记到新 mock。
afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

const PAYLOAD = { started_at: '2026-07-08T00:00:00.000Z', duration_s: 300, distance_m: 900, source: 'aiui' };
const CALIBRATION_START_MS = Date.UTC(2026, 6, 26, 3, 0, 0);

function calibrationEvents(count, nonce = 'index') {
  const streamId = `aiui_${CALIBRATION_START_MS}_${nonce}`;
  return Array.from({ length: count }, (_unused, index) => ({
    schema_version: 1,
    source: 'aiui_glasses',
    event_id: `${streamId}.${String(index + 1).padStart(10, '0')}`,
    stream_id: streamId,
    seq: index + 1,
    captured_at_ms: CALIBRATION_START_MS + index * 1000,
    stream_started_at_ms: CALIBRATION_START_MS,
    elapsed_ms: index * 1000,
    cadence_spm: 160,
    speed_mps: 2.5,
    distance_m: index * 2.5,
    stationary: false,
    distance_source: 'imu',
    cadence_source: 'imu',
  }));
}

function seedActiveDeviceIdentity(opts = {}) {
  const publicDeviceId = opts.publicDeviceId || 'SR-TEST-ACTIVE';
  const aiuiId = opts.aiuiId || 'T7E2S9T4';
  const secret = opts.secret || 's'.repeat(48);
  const token = opts.token || 'stored-device-token';
  const ownershipEpoch = Number.isSafeInteger(opts.ownershipEpoch)
    ? opts.ownershipEpoch : 1;
  const dataNamespace = opts.dataNamespace || 'anon-test-active';
  wx.store.set('smartrun_installation_id', opts.installationId || 'inst-test-active-device');
  wx.store.set('smartrun_device_secret', secret);
  wx.store.set('smartrun_public_device_id', publicDeviceId);
  wx.store.set('smartrun_aiui_id', {
    aiuiId,
    publicDeviceId,
    ownershipEpoch,
    dataNamespace,
  });
  wx.store.set('smartrun_device_token', token);
  wx.store.set('coach_token', token);
  wx.store.set('smartrun_device_binding', {
    bound: opts.bound === true,
    ownershipEpoch,
    dataNamespace,
    updatedAtMs: 1,
  });
}

function cacheCalibrationOwner(page, opts = {}) {
  const publicDeviceId = opts.publicDeviceId || 'SR-CALIBRATION';
  const token = opts.token || 'calibration-device-token';
  const ownershipEpoch = Number.isSafeInteger(opts.ownershipEpoch)
    ? opts.ownershipEpoch : 1;
  const dataNamespace = opts.dataNamespace || 'anon-calibration';
  seedActiveDeviceIdentity({
    publicDeviceId,
    token,
    ownershipEpoch,
    dataNamespace,
    secret: opts.secret || 'c'.repeat(48),
  });
  page.deviceIdentityCache = {
    network: true,
    deviceToken: token,
    publicDeviceId,
    bound: false,
    ownershipEpoch,
    dataNamespace,
  };
  page.deviceIdentityAttempted = true;
  page.observedOwnerBinding = {
    publicDeviceId,
    bound: false,
    ownershipEpoch,
    dataNamespace,
  };
}

function seedLegacyRealm(opts = {}) {
  wx.store.set(
    'smartrun_device_id',
    opts.legacyDeviceId || 'legacy-test-device',
  );
}

test('首页不保留业务状态，也不读取或连接蓝牙', () => {
  const page = freshPage();
  let bluetoothCalls = 0;
  globalThis.navigator = {
    bluetooth: {
      getDevices() { bluetoothCalls += 1; return []; },
      scanDevices() { bluetoothCalls += 1; return []; },
      requestDevice() { bluetoothCalls += 1; return null; },
    },
  };
  page.onLoad();
  // 首页只展示入口说明；跑步总结只存在于 04 沉浸页。
  assert.deepEqual(page.data, {
    hostTarget: '_current',
    homeVersion: `v${PRODUCT_VERSION}`,
    homeSlogan: '自由开跑，智能相伴',
    enterText: '按确认键进入',
  });
  assert.equal('homeMotionClass' in page.data, false);
  assert.equal('homeLogoClass' in page.data, false);
  assert.equal('heartLabel' in page.data, false);
  assert.equal('deviceClass' in page.data, false);
  assert.equal(bluetoothCalls, 0);
});

test('首页没有视觉动效方法或视觉计时器', () => {
  const page = freshPage();
  page.onLoad();
  page.onShow();
  assert.equal(typeof page.startHomeMotion, 'undefined');
  assert.equal(typeof page.stopHomeMotion, 'undefined');
  assert.equal(page.homeSweepTimer, undefined);
  assert.equal(page.homeBurstTimer, undefined);
  assert.equal(page.homeClearTimer, undefined);
  assert.equal(page.homeLoopTimer, undefined);
});

test('首页后端请求强制 JSON 文本契约，并防御解析 ArrayBuffer', async () => {
  const page = freshPage();
  let requestOptions = null;
  wx.requestImpl = (opts) => {
    requestOptions = opts;
    const data = new TextEncoder().encode('{"ok":true}').buffer;
    opts.success({ statusCode: 200, data });
  };
  const response = await page.wxRequest({
    url: 'https://example.test/health',
    dataType: 'text', responseType: 'arraybuffer', timeout: 12000,
  });
  assert.equal(requestOptions.dataType, 'json');
  assert.equal(requestOptions.responseType, 'text');
  assert.equal(requestOptions.timeout, 12000);
  assert.deepEqual(response.data, { ok: true });
});

test('首页到达时清除上一轮宿主返回痕迹', () => {
  const page = freshPage();
  wx.store.set(HOST_BACKSPACE_SOURCE_KEY, 'run_hud');
  page.onLoad();
  assert.equal(wx.store.has(HOST_BACKSPACE_SOURCE_KEY), false);
});

test('首页 Backspace 只监听，宿主默认行为不被拦截', () => {
  const page = freshPage();
  page.onLoad();
  let prevented = false;
  page.onKeyUp({ code: 'Backspace', preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'Backspace 必须交给 AIUI 宿主继续处理');
  assert.deepEqual(wx.redirectToCalls, []);
  assert.deepEqual(wx.navigateToCalls, []);
});

test('扫描页第一下返回后：首页承接三秒标记，第二下返回直接退出', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  page.onLoad();
  t.mock.timers.tick(1);
  wx.store.set(SCAN_EXIT_HINT_KEY, String(Date.now()));
  page.onShow();
  assert.equal(page.data.enterText, '再按返回键退出');
  assert.equal(wx.store.has(SCAN_EXIT_HINT_KEY), false, '跨页标记只消费一次');
  let prevented = false;
  page.onKeyUp({ code: 'Backspace', preventDefault() { prevented = true; } });
  assert.equal(prevented, false, '第二下返回仍不拦截宿主');
  assert.equal(wx.exitMiniProgramCalls, 1);
});

test('扫描退出标记超过三秒：首页不预武装退出', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = freshPage();
  page.onLoad();
  wx.store.set(SCAN_EXIT_HINT_KEY, String(Date.now() - 3001));
  page.onShow();
  assert.equal(page.data.enterText, '按确认键进入');
  assert.equal(wx.exitMiniProgramCalls, 0);
});

test('首页单一原生按钮由宿主处理 Enter，bindtap 只打开沉浸训练菜单', () => {
  const page = freshPage();
  page.onLoad();
  let prevented = false;
  page.onKeyUp({ code: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, false, '单按钮页面必须让宿主原生激活 bindtap');
  assert.deepEqual(wx.navigateToCalls, []);
  page.openMenu(); // 模拟宿主激活真实 button 的 bindtap
  assert.deepEqual(wx.navigateToCalls, ['/pages/run_hud/index?mode=menu&inputGuard=1&fromHome=1']);
  assert.deepEqual(wx.redirectToCalls, []);
});

test('首页 GlobalHook 只进菜单，并阻止同一确认重复压栈', () => {
  const page = freshPage();
  page.onLoad();
  let prevented = false;
  page.onKeyUp({ code: 'GlobalHook', preventDefault() { prevented = true; } });
  page.openMenu(); // 模拟同一物理键随后又触发原生 button
  assert.equal(prevented, true);
  assert.deepEqual(wx.navigateToCalls, ['/pages/run_hud/index?mode=menu&inputGuard=1&fromHome=1']);
  page.onShow(); // 宿主返回首页后才解除导航锁
  page.openMenu();
  assert.deepEqual(wx.navigateToCalls, [
    '/pages/run_hud/index?mode=menu&inputGuard=1&fromHome=1',
    '/pages/run_hud/index?mode=menu&inputGuard=1&fromHome=1',
  ]);
});

test('首页忽略旧 destination 查询，唯一入口恒定进入 menu', () => {
  const page = freshPage();
  page.flushRunUploads = async () => {};
  page.onLoad({ destination: 'devices' });
  page.openMenu();
  assert.deepEqual(wx.navigateToCalls, ['/pages/run_hud/index?mode=menu&inputGuard=1&fromHome=1']);
  assert.deepEqual(wx.redirectToCalls, [], '对话根页不能被 redirectTo 替换');
});

test('首页 ArrowDown 不拦截也不直接开跑', () => {
  const page = freshPage();
  page.onLoad();
  let prevented = false;
  page.onKeyUp({ code: 'ArrowDown', preventDefault() { prevented = true; } });
  assert.equal(prevented, false, '对话流的方向键必须留给宿主');
  assert.deepEqual(wx.navigateToCalls, [], '下滑不得直接启动自由跑');
  assert.deepEqual(page.data, {
    hostTarget: '_current',
    homeVersion: `v${PRODUCT_VERSION}`,
    homeSlogan: '自由开跑，智能相伴',
    enterText: '按确认键进入',
  });
});

test('首页按 target 同步承载状态但不自动导航，切换时清除旧确认痕迹', () => {
  const page = freshPage();
  page.onLoad();
  page.lastHomeConfirmAtMs = 123;
  page.setData({ enterText: '再按返回键退出' });

  page.onTargetChanged('_blank', '_current');
  assert.equal(page.data.hostTarget, '_blank');
  assert.equal(page.data.enterText, '按确认键进入');
  assert.equal(page.lastHomeConfirmAtMs, null);
  assert.deepEqual(wx.navigateToCalls, [], 'target 变化只重排首页，不能重复压入沉浸路由');

  page.onTargetChanged('_current', '_blank');
  assert.equal(page.data.hostTarget, '_current');
  assert.deepEqual(wx.navigateToCalls, []);
});

test('补传:无 coach_app_key 仍尝试低权限设备 bootstrap；离线则队列保留', async () => {
  const page = freshPage();
  wx.store.set(PENDING_RUNS_KEY, [PAYLOAD]);
  let requests = 0;
  wx.requestImpl = (opts) => { requests += 1; opts.fail(new Error('unexpected')); };
  await page.flushRunUploads();
  assert.equal(requests, 1, '新 bootstrap 不依赖 app_key；只尝试一次设备身份请求');
  assert.equal(wx.store.get(PENDING_RUNS_KEY).length, 1, '队列保留');
});

test('补传:设备 bootstrap 换低权限 token → AIUI 专用入口上传成功 → 队列清空', async () => {
  const page = freshPage();
  wx.store.set('coach_app_key', 'shared-key');
  wx.store.set(PENDING_RUNS_KEY, [PAYLOAD]);
  const seen = [];
  wx.requestImpl = (opts) => {
    seen.push(opts.url);
    if (opts.url.endsWith('/coach/device-registration-credential')) {
      assert.deepEqual(opts.data, { app_id: 'AISmartRun' });
      opts.success({ statusCode: 200, data: {
        installation_id: 'inst-server-issued-1',
        device_credential: 'dcred_' + 'a'.repeat(40),
      } });
      return;
    }
    if (opts.url.endsWith('/coach/device-bootstrap')) {
      assert.equal('device_sn' in opts.data, false);
      assert.equal(opts.data.device_credential, 'dcred_' + 'a'.repeat(40));
      assert.equal('device_secret' in opts.data, false);
      opts.success({ statusCode: 200, data: {
        public_device_id: 'SR-1', aiui_id: 'A7B2C9D4',
        token: 'jwt-1', bound: false,
        ownership_epoch: 1, data_namespace: 'anon-sr-1',
      } });
      return;
    }
    if (opts.url.endsWith('/coach/aiui-runs')) {
      assert.equal(opts.header.Authorization, 'Bearer jwt-1');
      assert.equal(opts.data.source, 'aiui');
      assert.match(opts.data.client_run_id, /^run-/);
      opts.success({ statusCode: 200, data: { id: 88 } });
      return;
    }
    opts.fail(new Error(`unexpected url ${opts.url}`));
  };
  await page.flushRunUploads();
  assert.equal(seen.length, 3, '长期凭据签发 + 设备 bootstrap + 上传各一次');
  assert.deepEqual(seen.map((url) => url.replace(/^https:\/\/[^/]+/, '')), [
    '/api/coach-svc/coach/device-registration-credential',
    '/api/coach-svc/coach/device-bootstrap',
    '/api/coach-svc/coach/aiui-runs',
  ]);
  assert.equal(wx.store.has(PENDING_RUNS_KEY), false, '成功后清队');
});

test('已绑定设备换绑时先按 ownership_epoch 清本地用户数据，旧快照不得上传给新用户', async () => {
  const page = freshPage();
  seedActiveDeviceIdentity({
    publicDeviceId: 'SR-SWITCH',
    secret: 'q'.repeat(48),
    token: 'old-token',
    bound: true,
    ownershipEpoch: 7,
    dataNamespace: 'apk-user-old',
  });
  wx.store.set(PENDING_RUNS_KEY, [PAYLOAD]);
  wx.store.set('pending_aiui_records', [{ question: 'old q', reply: 'old r' }]);
  wx.store.set('pending_run_summary', {
    elapsedMs: 600000, distanceM: 1000, endedAtMs: Date.now(), text: '旧用户总结',
  });
  wx.store.set('local_run_memories', [{ text: '旧用户记忆', endedAtMs: Date.now() }]);
  const seen = [];
  wx.requestImpl = (opts) => {
    seen.push(opts.url);
    if (opts.url.endsWith('/coach/device-bootstrap')) {
      assert.equal(opts.data.device_secret, 'q'.repeat(48));
      opts.success({ statusCode: 200, data: {
        public_device_id: 'SR-SWITCH', token: 'new-user-token', bound: true,
        ownership_epoch: 8, data_namespace: 'apk-user-new',
      } });
      return;
    }
    opts.fail(new Error('旧用户队列不应发送'));
  };
  page.onLoad();
  await flushMicro();
  assert.equal(wx.store.has(PENDING_RUNS_KEY), false);
  assert.equal(wx.store.has('pending_aiui_records'), false);
  assert.equal(wx.store.has('pending_run_summary'), false);
  assert.equal(wx.store.has('local_run_memories'), false);
  assert.equal(seen.filter((url) => !url.endsWith('/coach/device-bootstrap')).length, 0);
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴', '归属切换不影响首页入口说明');
});

test('owner journal 无法清空时不归档旧总结/记忆、不消费提示且不发任何网络请求', async (t) => {
  const page = freshPage();
  wx.store.set(OWNER_TRANSITION_PENDING_STORAGE_KEY, {
    bound: false, ownershipEpoch: 31, dataNamespace: 'owner-next',
  });
  wx.store.set('smartrun_device_secret', 'x'.repeat(48));
  wx.store.set('smartrun_device_token', 'old-token');
  wx.store.set('smartrun_device_binding', {
    bound: true, ownershipEpoch: 30, dataNamespace: 'owner-old', updatedAtMs: 1,
  });
  wx.store.set(PENDING_RUNS_KEY, [PAYLOAD]);
  wx.store.set('pending_aiui_records', [{ question: 'old q', reply: 'old r' }]);
  wx.store.set('local_run_memories', [{ text: 'old memory' }]);
  wx.store.set('pending_run_summary', {
    elapsedMs: 600000, distanceM: 1000, endedAtMs: Date.now(), text: 'old summary',
  });
  wx.store.set('aiui_run_finished_at', String(Date.now()));
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
  const requests = [];
  wx.requestImpl = (opts) => {
    requests.push(opts.url);
    opts.fail(new Error('owner journal 未完成时不应联网'));
  };
  let llmTouched = false;
  globalThis.LanguageModel = {
    availability: async () => { llmTouched = true; return 'unavailable'; },
  };
  t.after(() => { delete globalThis.LanguageModel; });

  page.onLoad();
  await flushMicro();
  assert.equal(page.ownerDataBlocked, true);
  assert.equal(requests.length, 0, 'bootstrap、上传与远端记忆请求均必须停止');
  assert.equal(llmTouched, false);
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴');
  assert.equal(page.data.enterText, '按确认键进入');
  assert.equal(wx.store.get('pending_run_summary').text, 'old summary');
  assert.equal(typeof wx.store.get(OWNER_TRANSITION_PENDING_STORAGE_KEY), 'object');

  // 宿主 storage 恢复后，下一次中央守卫先完成重放，再恢复身份刷新资格。
  wx.removeStorageSync = baseRemove;
  wx.setStorageSync = baseSet;
  assert.equal(page.ownerDataIsAvailable(), true);
  assert.equal(page.ownerDataBlocked, false);
  assert.equal(wx.store.has(OWNER_TRANSITION_PENDING_STORAGE_KEY), false);
  assert.equal(wx.store.has('pending_run_summary'), false);
  assert.equal(page.deviceIdentityAttempted, false);
});

test('启动期必须等待归属 bootstrap：bind→unbind 跳变前不读旧总结、不武装旧退出提示', async (t) => {
  const page = freshPage();
  // 本地只留下了解绑前的旧匿名 epoch；服务端已经完成了绑定后再解绑。
  seedActiveDeviceIdentity({
    publicDeviceId: 'SR-OWNER-GAP',
    secret: 'd'.repeat(48),
    bound: false,
    ownershipEpoch: 1,
    dataNamespace: 'anon-before-bind',
  });
  wx.store.set('pending_run_summary', {
    elapsedMs: 600000, distanceM: 1000, endedAtMs: Date.now(), text: '旧用户私有总结',
  });
  wx.store.set('aiui_run_finished_at', String(Date.now() - 5000));
  let releaseBootstrap;
  let llmTouched = false;
  globalThis.LanguageModel = {
    availability: async () => { llmTouched = true; return 'unavailable'; },
  };
  t.after(() => { delete globalThis.LanguageModel; });
  wx.requestImpl = (opts) => {
    if (!opts.url.endsWith('/coach/device-bootstrap')) {
      opts.fail(new Error('旧总结不应引发其他请求'));
      return;
    }
    releaseBootstrap = () => opts.success({ statusCode: 200, data: {
      public_device_id: 'SR-OWNER-GAP', token: 'fresh-anon-token', bound: false,
      ownership_epoch: 3, data_namespace: 'anon-after-unbind',
    } });
  };

  page.onLoad();
  await flushMicro(2);
  const generationBeforeOwnerChange = page.ownerDataGeneration;
  assert.equal(typeof releaseBootstrap, 'function');
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴', 'bootstrap 未完成不得偷读旧总结');
  assert.equal(page.data.enterText, '按确认键进入', 'bootstrap 未完成不得消费并武装旧提示');
  assert.equal(wx.store.has('pending_run_summary'), true);
  assert.equal(wx.store.has('aiui_run_finished_at'), true);

  releaseBootstrap();
  await flushMicro();
  assert.equal(page.ownerDataGeneration, generationBeforeOwnerChange + 1,
    '归属跳变只能幂等地失效一代旧异步任务');
  assert.equal(wx.store.has('pending_run_summary'), false, '旧总结由归属清理消除');
  assert.equal(wx.store.has('aiui_run_finished_at'), false, '旧跑完提示由归属清理消除');
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴');
  assert.equal(page.data.enterText, '按确认键进入');
  assert.equal(llmTouched, false, '旧总结不得进入模型');
  assert.equal(wx.exitMiniProgramCalls, 0);
});

test('绑定在沉浸页完成：返回时用 marker 隔离旧 owner 后台总结，首页始终不变', async () => {
  const page = freshPage();
  seedActiveDeviceIdentity({
    publicDeviceId: 'SR-CROSS-PAGE',
    secret: 'f'.repeat(48),
    token: 'old-token',
    bound: false,
    ownershipEpoch: 1,
    dataNamespace: 'anon-home-old',
  });
  wx.store.set('run_settings', { memoryContext: false });
  wx.store.set('pending_run_summary', {
    elapsedMs: 600000, distanceM: 1000, endedAtMs: Date.now(), text: '隐藏首页的旧总结',
  });
  let bootstrapCalls = 0;
  wx.requestImpl = (opts) => {
    if (!opts.url.endsWith('/coach/device-bootstrap')) {
      opts.fail(new Error('unexpected request ' + opts.url));
      return;
    }
    bootstrapCalls += 1;
    opts.success({ statusCode: 200, data: bootstrapCalls === 1 ? {
      public_device_id: 'SR-CROSS-PAGE', token: 'old-token', bound: false,
      ownership_epoch: 1, data_namespace: 'anon-home-old',
    } : {
      public_device_id: 'SR-CROSS-PAGE', token: 'new-token', bound: false,
      ownership_epoch: 3, data_namespace: 'anon-home-new',
    } });
  };

  page.onLoad();
  await flushMicro();
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴');
  assert.deepEqual(page.observedOwnerBinding, {
    bound: false, ownershipEpoch: 1, dataNamespace: 'anon-home-old',
    publicDeviceId: 'SR-CROSS-PAGE',
  });

  // 模拟 run_hud 设置页在 Home 隐藏期已经完成了 bind→unbind 并提交新 marker。
  wx.store.set('smartrun_device_binding', {
    bound: false, ownershipEpoch: 3, dataNamespace: 'anon-home-new', updatedAtMs: 2,
  });
  wx.store.set('smartrun_device_token', 'new-token');
  wx.store.set('coach_token', 'new-token');
  const generationBeforeOwnerChange = page.ownerDataGeneration;
  page.onShow();
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴', '网络返回前首页也不得暴露旧 owner 数据');
  assert.equal(page.ownerDataGeneration, generationBeforeOwnerChange + 1);
  await flushMicro();
  assert.equal(bootstrapCalls, 2, '返回首页仍会向服务端复核最新归属');
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴');
});

test('补传:旧后端没有长期凭据签发时兼容 anon-login + /runs', async () => {
  const page = freshPage();
  seedLegacyRealm();
  wx.store.set('coach_app_key', 'shared-key');
  wx.store.set(PENDING_RUNS_KEY, [PAYLOAD]);
  const seen = [];
  wx.requestImpl = (opts) => {
    seen.push(opts.url);
    if (opts.url.endsWith('/coach/device-registration-credential')) {
      opts.success({ statusCode: 404, data: {} });
    } else if (opts.url.endsWith('/coach/anon-login')) {
      opts.success({ statusCode: 200, data: { token: 'legacy-jwt' } });
    } else if (opts.url.endsWith('/runs')) {
      assert.equal(opts.header.Authorization, 'Bearer legacy-jwt');
      opts.success({ statusCode: 200, data: { id: 89 } });
    }
  };
  await page.flushRunUploads();
  assert.deepEqual(seen.map((url) => url.replace(/^https:\/\/[^/]+/, '')), [
    '/api/coach-svc/coach/device-registration-credential',
    '/api/coach-svc/coach/anon-login',
    '/api/coach-svc/runs',
  ]);
  assert.equal(wx.store.has(PENDING_RUNS_KEY), false);
});

test('补传:已有 device token 且本次 bootstrap 离线，仍走 aiui-runs 而非旧 /runs', async () => {
  const page = freshPage();
  seedActiveDeviceIdentity({
    publicDeviceId: 'SR-CACHED',
    token: 'cached-device-jwt',
    dataNamespace: 'anon-cached',
  });
  wx.store.set(PENDING_RUNS_KEY, [PAYLOAD]);
  const seen = [];
  wx.requestImpl = (opts) => {
    seen.push(opts.url);
    if (opts.url.endsWith('/coach/device-bootstrap')) {
      opts.fail(new Error('offline'));
    } else if (opts.url.endsWith('/coach/aiui-runs')) {
      assert.equal(opts.header.Authorization, 'Bearer cached-device-jwt');
      opts.success({ statusCode: 200, data: { id: 90 } });
    } else {
      opts.fail(new Error('must not use legacy route'));
    }
  };
  await page.flushRunUploads();
  assert.equal(seen.some((url) => url.endsWith('/api/coach-svc/runs')), false);
  assert.equal(seen.some((url) => url.endsWith('/coach/aiui-runs')), true);
  assert.equal(wx.store.has(PENDING_RUNS_KEY), false);
});

test('补传:上传 401 → 清 token、保留本条及其后,下次重登再传', async () => {
  const page = freshPage();
  seedLegacyRealm({
    legacyDeviceId: 'legacy-401',
  });
  wx.store.set('coach_token', 'stale-jwt');
  wx.store.set(PENDING_RUNS_KEY, [PAYLOAD, { ...PAYLOAD, duration_s: 600 }]);
  wx.requestImpl = (opts) => {
    if (opts.url.endsWith('/coach/device-registration-credential')) {
      opts.success({ statusCode: 404, data: {} });
      return;
    }
    if (opts.url.endsWith('/runs')) { opts.success({ statusCode: 401, data: {} }); return; }
    opts.fail(new Error('unexpected'));
  };
  await page.flushRunUploads();
  assert.equal(wx.store.has('coach_token'), false, '过期 token 清掉');
  assert.equal(wx.store.get(PENDING_RUNS_KEY).length, 2, '两条都保留');
});

test('补传:device token 401 会 secret-bootstrap 一次并原位重试同 client_run_id', async () => {
  const page = freshPage();
  seedActiveDeviceIdentity({
    publicDeviceId: 'SR-REAUTH',
    secret: 'r'.repeat(48),
    bound: false,
    ownershipEpoch: 1,
    dataNamespace: 'anon-reauth',
  });
  wx.store.set(PENDING_RUNS_KEY, [PAYLOAD]);
  let bootstrapCalls = 0;
  const postedIds = [];
  wx.requestImpl = (opts) => {
    if (opts.url.endsWith('/coach/device-bootstrap')) {
      bootstrapCalls += 1;
      opts.success({ statusCode: 200, data: {
        public_device_id: 'SR-REAUTH',
        token: bootstrapCalls === 1 ? 'token-old' : 'token-new',
        bound: false, ownership_epoch: 1, data_namespace: 'anon-reauth',
      } });
      return;
    }
    if (opts.url.endsWith('/coach/aiui-runs')) {
      postedIds.push(opts.data.client_run_id);
      if (opts.header.Authorization === 'Bearer token-old') {
        opts.success({ statusCode: 401, data: {} });
      } else {
        assert.equal(opts.header.Authorization, 'Bearer token-new');
        opts.success({ statusCode: 200, data: { id: 501 } });
      }
      return;
    }
    opts.fail(new Error('unexpected'));
  };
  await page.flushRunUploads();
  assert.equal(bootstrapCalls, 2);
  assert.equal(postedIds.length, 2);
  assert.equal(postedIds[0], postedIds[1], '认证重试必须保留相同幂等键');
  assert.equal(wx.store.has(PENDING_RUNS_KEY), false);
});

test('补传:单条 422 毒丸先隔离再移出 FIFO，并继续后续记录', async () => {
  const page = freshPage();
  seedActiveDeviceIdentity({
    publicDeviceId: 'SR-POISON',
    secret: 'v'.repeat(48),
    bound: false,
    ownershipEpoch: 1,
    dataNamespace: 'anon-poison',
  });
  wx.store.set(PENDING_RUNS_KEY, [
    { ...PAYLOAD, started_at: '2026-07-08T00:00:00.000Z' },
    { ...PAYLOAD, started_at: '2026-07-08T01:00:00.000Z' },
  ]);
  let runPosts = 0;
  wx.requestImpl = (opts) => {
    if (opts.url.endsWith('/coach/device-bootstrap')) {
      opts.success({ statusCode: 200, data: {
        public_device_id: 'SR-POISON', token: 'token-ok', bound: false,
        ownership_epoch: 1, data_namespace: 'anon-poison',
      } });
      return;
    }
    if (opts.url.endsWith('/coach/aiui-runs')) {
      runPosts += 1;
      opts.success(runPosts === 1
        ? { statusCode: 422, data: { detail: 'invalid legacy payload' } }
        : { statusCode: 200, data: { id: 502 } });
      return;
    }
    opts.fail(new Error('unexpected'));
  };
  await page.flushRunUploads();
  assert.equal(runPosts, 2, '毒丸不能挡住后续正常记录');
  assert.equal(wx.store.has(PENDING_RUNS_KEY), false);
  const quarantined = readQuarantinedRunUploads(wx);
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0].status_code, 422);

  for (const statusCode of [429, 500]) {
    const retained = freshPage();
    seedActiveDeviceIdentity({
      publicDeviceId: 'SR-KEEP',
      secret: 'w'.repeat(48),
      bound: false,
      ownershipEpoch: 1,
      dataNamespace: 'anon-keep',
    });
    wx.store.set(PENDING_RUNS_KEY, [PAYLOAD]);
    wx.requestImpl = (opts) => {
      if (opts.url.endsWith('/coach/device-bootstrap')) {
        opts.success({ statusCode: 200, data: {
          public_device_id: 'SR-KEEP', token: 'token-keep', bound: false,
          ownership_epoch: 1, data_namespace: 'anon-keep',
        } });
      } else if (opts.url.endsWith('/coach/aiui-runs')) {
        opts.success({ statusCode, data: {} });
      }
    };
    await retained.flushRunUploads();
    assert.equal(wx.store.get(PENDING_RUNS_KEY).length, 1, statusCode + ' 必须保留');
  }
});

test('补传:run 409 是永久幂等冲突，隔离后继续 FIFO；隔离失败则保留毒丸', async () => {
  const page = freshPage();
  seedActiveDeviceIdentity({
    publicDeviceId: 'SR-RUN-409',
    token: 'token-run-409',
    dataNamespace: 'anon-run-409',
  });
  wx.store.set(PENDING_RUNS_KEY, [
    { ...PAYLOAD, started_at: '2026-07-08T02:00:00.000Z' },
    { ...PAYLOAD, started_at: '2026-07-08T03:00:00.000Z' },
  ]);
  let posts = 0;
  wx.requestImpl = (opts) => {
    if (opts.url.endsWith('/coach/device-bootstrap')) {
      opts.success({ statusCode: 200, data: {
        public_device_id: 'SR-RUN-409', token: 'token-run-409', bound: false,
        ownership_epoch: 1, data_namespace: 'anon-run-409',
      } });
      return;
    }
    if (opts.url.endsWith('/coach/aiui-runs')) {
      posts += 1;
      opts.success(posts === 1
        ? { statusCode: 409, data: { detail: 'client_run_id conflict' } }
        : { statusCode: 200, data: { id: 503 } });
    }
  };
  await page.flushRunUploads();
  assert.equal(posts, 2);
  assert.equal(wx.store.has(PENDING_RUNS_KEY), false);
  assert.equal(readQuarantinedRunUploads(wx)[0].status_code, 409);

  const retained = freshPage();
  seedActiveDeviceIdentity({
    publicDeviceId: 'SR-RUN-409-FAIL',
    token: 'token-run-409-fail',
    dataNamespace: 'anon-run-409-fail',
  });
  wx.store.set(PENDING_RUNS_KEY, [PAYLOAD]);
  const normalSet = wx.setStorageSync.bind(wx);
  wx.setStorageSync = (key, value) => {
    if (key !== QUARANTINED_RUN_UPLOADS_KEY) normalSet(key, value);
  };
  wx.requestImpl = (opts) => {
    if (opts.url.endsWith('/coach/device-bootstrap')) {
      opts.success({ statusCode: 200, data: {
        public_device_id: 'SR-RUN-409-FAIL', token: 'token-run-409-fail', bound: false,
        ownership_epoch: 1, data_namespace: 'anon-run-409-fail',
      } });
    } else if (opts.url.endsWith('/coach/aiui-runs')) {
      opts.success({ statusCode: 409, data: {} });
    }
  };
  await retained.flushRunUploads();
  assert.equal(wx.store.get(PENDING_RUNS_KEY).length, 1,
    '隔离未写后读确认时必须保留主 FIFO');
  assert.equal(wx.store.has(QUARANTINED_RUN_UPLOADS_KEY), false);
});

test('补传:网络失败 → 队列保留,首页不报错', async () => {
  const page = freshPage();
  wx.store.set('coach_token', 'jwt-ok');
  wx.store.set(PENDING_RUNS_KEY, [PAYLOAD]);
  // fakeWx 默认所有请求 fail(离线)
  await page.flushRunUploads();
  assert.equal(wx.store.get(PENDING_RUNS_KEY).length, 1);
});

test('宿主恢复首页只触发 onShow 时也必须补传', () => {
  const page = freshPage();
  let flushed = 0;
  page.flushRunUploads = async () => { flushed += 1; };
  page.onShow();
  assert.equal(flushed, 1, '跑完回首页(onShow)就要补传,不等下次冷启动');
});

test('补传防重入:进行中再次触发直接返回,不重复上传', async () => {
  const page = freshPage();
  wx.store.set('coach_app_key', 'shared-key');
  wx.store.set(PENDING_RUNS_KEY, [PAYLOAD]);
  let runPosts = 0;
  let releaseBootstrap;
  wx.requestImpl = (opts) => {
    if (opts.url.endsWith('/coach/device-registration-credential')) {
      opts.success({ statusCode: 200, data: {
        installation_id: 'inst-server-issued-2',
        device_credential: 'dcred_' + 'b'.repeat(40),
      } });
      return;
    }
    if (opts.url.endsWith('/coach/device-bootstrap')) {
      // 挂起 bootstrap,模拟慢网:期间再触发一次 flush
      releaseBootstrap = () => opts.success({ statusCode: 200, data: {
        public_device_id: 'SR-2', aiui_id: 'E7F2G9H4',
        token: 'jwt-2', bound: false,
        ownership_epoch: 1, data_namespace: 'anon-sr-2',
      } });
      return;
    }
    if (opts.url.endsWith('/coach/aiui-runs')) {
      runPosts += 1;
      opts.success({ statusCode: 200, data: { id: 99 } });
    }
  };
  const first = page.flushRunUploads();
  await page.flushRunUploads();   // 重入:应直接返回
  await flushMicro();
  releaseBootstrap();
  await first;
  assert.equal(runPosts, 1, '同一条记录只上传一次');
  assert.equal(wx.store.has(PENDING_RUNS_KEY), false);
});

test('首页校准补传严格按 500 条 FIFO 分批，不跳过最早事件', async () => {
  const page = freshPage();
  const events = calibrationEvents(AIUI_CALIBRATION_BATCH_SIZE + 1, 'fifo500');
  assert.ok(appendPendingAiuiCalibrationEvents(wx, events));
  cacheCalibrationOwner(page);
  const batches = [];
  wx.requestImpl = (opts) => {
    batches.push(opts.data.events);
    opts.success({
      statusCode: 200,
      data: {
        acked_event_ids: opts.data.events.map((event) => event.event_id),
        stored: opts.data.events.length,
        duplicates: 0,
        matched: 0,
      },
    });
  };

  await page.flushAiuiCalibrationUploads();

  assert.deepEqual(batches.map((batch) => batch.length), [500, 1]);
  assert.equal(batches[0][0].event_id, events[0].event_id);
  assert.equal(batches[0].at(-1).event_id, events[499].event_id);
  assert.equal(batches[1][0].event_id, events[500].event_id);
  assert.deepEqual(readPendingAiuiCalibrationEvents(wx), []);
});

test('首页校准补传只删除当前批 explicit ACK，partial/forged ACK 不误删', async () => {
  const page = freshPage();
  const events = calibrationEvents(3, 'partialack');
  assert.ok(appendPendingAiuiCalibrationEvents(wx, events));
  cacheCalibrationOwner(page);
  let requests = 0;
  wx.requestImpl = (opts) => {
    requests += 1;
    if (requests === 1) {
      opts.success({
        statusCode: 200,
        data: {
          acked_event_ids: [events[0].event_id, 'forged_event_00000001'],
          stored: 1,
          duplicates: 0,
          matched: 0,
        },
      });
      return;
    }
    opts.success({ statusCode: 503, data: {} });
  };

  await page.flushAiuiCalibrationUploads();

  assert.equal(requests, 2);
  assert.deepEqual(
    readPendingAiuiCalibrationEvents(wx).map((event) => event.event_id),
    [events[1].event_id, events[2].event_id],
  );
});

test('首页校准补传遇到网络失败或 5xx 均完整保留 durable 队列', async (t) => {
  for (const mode of ['network', '503']) {
    await t.test(mode, async () => {
      const page = freshPage();
      const events = calibrationEvents(2, 'retain' + mode);
      assert.ok(appendPendingAiuiCalibrationEvents(wx, events));
      cacheCalibrationOwner(page);
      wx.requestImpl = (opts) => {
        if (mode === 'network') opts.fail(new Error('offline'));
        else opts.success({ statusCode: 503, data: {} });
      };

      await page.flushAiuiCalibrationUploads();

      assert.deepEqual(
        readPendingAiuiCalibrationEvents(wx).map((event) => event.event_id),
        events.map((event) => event.event_id),
      );
      assert.ok(wx.store.has(PENDING_AIUI_CALIBRATION_KEY));
    });
  }
});

test('首页校准永久拒绝先隔离再移出 FIFO；隔离失败保留原事件', async () => {
  const page = freshPage();
  const [poison] = calibrationEvents(1, 'calpoison');
  assert.ok(appendPendingAiuiCalibrationEvents(wx, [poison]));
  cacheCalibrationOwner(page, {
    publicDeviceId: 'SR-CAL-POISON',
    token: 'token-cal-poison',
    dataNamespace: 'anon-cal-poison',
  });
  wx.requestImpl = (opts) => {
    opts.success({ statusCode: 409, data: { detail: 'event conflict' } });
  };
  await page.flushAiuiCalibrationUploads();
  assert.deepEqual(readPendingAiuiCalibrationEvents(wx), []);
  const quarantined = readQuarantinedAiuiCalibrationEvents(wx);
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0].event.event_id, poison.event_id);
  assert.equal(quarantined[0].status_code, 409);

  const retained = freshPage();
  const [retainedPoison] = calibrationEvents(1, 'calretain');
  assert.ok(appendPendingAiuiCalibrationEvents(wx, [retainedPoison]));
  cacheCalibrationOwner(retained, {
    publicDeviceId: 'SR-CAL-RETAIN',
    token: 'token-cal-retain',
    dataNamespace: 'anon-cal-retain',
  });
  const normalSet = wx.setStorageSync.bind(wx);
  wx.setStorageSync = (key, value) => {
    if (key !== QUARANTINED_AIUI_CALIBRATION_KEY) normalSet(key, value);
  };
  wx.requestImpl = (opts) => {
    opts.success({ statusCode: 422, data: { detail: 'invalid event' } });
  };
  await retained.flushAiuiCalibrationUploads();
  assert.deepEqual(
    readPendingAiuiCalibrationEvents(wx).map((event) => event.event_id),
    [retainedPoison.event_id],
    '隔离写后读未确认时不得 ACK/删除主队列',
  );
  assert.equal(wx.store.has(QUARANTINED_AIUI_CALIBRATION_KEY), false);
});

test('首页校准 pending 暂时不可读时不上传，也不把 unknown 当成确认空队列', async () => {
  const page = freshPage();
  const events = calibrationEvents(2, 'calreadfail');
  assert.ok(appendPendingAiuiCalibrationEvents(wx, events));
  cacheCalibrationOwner(page, {
    publicDeviceId: 'SR-CAL-READ-FAIL',
    token: 'token-cal-read-fail',
    dataNamespace: 'anon-cal-read-fail',
  });
  const normalGet = wx.getStorageSync.bind(wx);
  let failPendingRead = true;
  wx.getStorageSync = (key) => {
    if (key === PENDING_AIUI_CALIBRATION_KEY && failPendingRead) {
      failPendingRead = false;
      throw new Error('transient pending read failure');
    }
    return normalGet(key);
  };
  let posts = 0;
  wx.requestImpl = (opts) => {
    if (opts.url.endsWith('/coach/aiui-calibration/batch')) posts += 1;
    opts.fail(new Error('unexpected request'));
  };
  await page.flushAiuiCalibrationUploads();
  assert.equal(posts, 0);
  assert.equal(readPendingAiuiCalibrationEventsState(wx).ok, true);
  assert.deepEqual(
    readPendingAiuiCalibrationEvents(wx).map((event) => event.event_id),
    events.map((event) => event.event_id),
  );
});

test('navigateTo 悬空不锁死进入:导航锁 3s 自解,确认键恢复可用', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = freshPage();
  page.onLoad();   // fakeWx.navigateTo 只记录,永不回调 success/fail = 悬空
  page.openMenu();
  assert.equal(wx.navigateToCalls.length, 1);
  page.openMenu();
  assert.equal(wx.navigateToCalls.length, 1, '锁生效:同一按压不重复压栈');
  t.mock.timers.tick(3100);
  page.openMenu();
  assert.equal(wx.navigateToCalls.length, 2, '3s 自解锁:悬空一次不永久报废进入');
  // onLoad 同时启动后台身份刷新；本测试使用 fake timer，必须在切换到下一条
  // 用例的 wx mock 前把即时失败链路收敛，避免旧页面通过动态 wx Proxy
  // 读取并消费下一条用例的 owner-scoped 跑完提示。
  if (page.deviceIdentityPromise) await page.deviceIdentityPromise;
  await flushMicro();
});

test('刚跑完回首页:身份就绪后预点亮,再按一下返回即退出应用', async () => {
  const page = freshPage();
  seedActiveDeviceIdentity({
    publicDeviceId: 'SR-HOME-HINT',
    dataNamespace: 'anon-home-hint',
  });
  wx.requestImpl = (opts) => {
    if (opts.url.endsWith('/coach/device-bootstrap')) {
      opts.success({ statusCode: 200, data: {
        public_device_id: 'SR-HOME-HINT', aiui_id: 'T7E2S9T4',
        token: 'home-hint-token', bound: false,
        ownership_epoch: 1, data_namespace: 'anon-home-hint',
      } });
      return;
    }
    opts.fail(new Error('跑完提示测试不应发其他请求'));
  };
  wx.store.set('aiui_run_finished_at', String(Date.now() - 5000));
  page.onLoad();
  page.onShow();
  // 不用任意 microtask 数量猜 bootstrap 完成时点：明确等待 onLoad/onShow
  // 共享的身份 Promise，再让两个提示同步任务完成消费。
  if (page.deviceIdentityPromise) await page.deviceIdentityPromise;
  await flushMicro();
  assert.equal(page.data.enterText, '再按返回键退出', '跑完落地即预点亮退出确认');
  assert.equal(wx.store.has('aiui_run_finished_at'), false, '提示一次性消费');
  page.onKeyUp({ code: 'Backspace' });
  assert.equal(wx.exited, true, '跑完后一下返回直接退出');
  page.disarmExitPrompt();
});

test('陈旧的跑完提示(>60s)不预点亮:隔天启动不误触退出', async () => {
  const page = freshPage();
  seedActiveDeviceIdentity({
    publicDeviceId: 'SR-HOME-STALE-HINT',
    dataNamespace: 'anon-home-stale-hint',
  });
  wx.store.set('aiui_run_finished_at', String(Date.now() - 120000));
  page.onLoad();
  page.onShow();
  await flushMicro();
  assert.equal(page.data.enterText, '按确认键进入', '陈旧提示直接丢弃');
  assert.equal(wx.store.has('aiui_run_finished_at'), false);
  page.onKeyUp({ code: 'Backspace' });
  assert.notEqual(wx.exited, true, '第一按只武装,不退出');
  page.disarmExitPrompt();
});

test('首页双按返回退出:第一按亮 3s 提示,窗口内第二按 exitMiniProgram', async () => {
  const page = freshPage();
  page.onLoad();
  page.onShow();
  await flushMicro();
  page.onKeyUp({ code: 'Backspace' });
  assert.equal(page.data.enterText, '再按返回键退出', '第一按只武装并亮提示');
  assert.notEqual(wx.exited, true, '第一按绝不退出');
  page.onKeyUp({ code: 'Backspace' });
  assert.equal(wx.exited, true, '3s 内第二按必须退出应用');
  page.disarmExitPrompt();
});

test('退出提示 3s 过期复原;归来 onShow 也清残留武装', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = freshPage();
  page.onLoad();
  page.onShow();
  await flushMicro();
  page.onKeyUp({ code: 'Backspace' });
  assert.equal(page.data.enterText, '再按返回键退出');
  t.mock.timers.tick(3100);
  assert.equal(page.data.enterText, '按确认键进入', '窗口过期提示复原');
  assert.notEqual(wx.exited, true);

  page.onKeyUp({ code: 'Backspace' });   // 过期后再按 = 重新武装
  assert.notEqual(wx.exited, true, '过期后的下一按不得直接退出');
  page.onShow();                          // 窗口内的新武装归来时保留
  assert.equal(page.data.enterText, '再按返回键退出', '3s 窗口内的武装不被 onShow 扑灭');
  t.mock.timers.tick(3100);               // 窗口过期
  page.onShow();                          // 过期残留此刻才清
  assert.equal(page.data.enterText, '按确认键进入', 'onShow 清掉过期残留武装');
});

test('首页后台归档跑后待办:LLM 不可用走规则兜底且不改首页,并发 aiui-record 交给配置后端', async () => {
  const page = freshPage();
  seedActiveDeviceIdentity();
  delete globalThis.LanguageModel;
  wx.store.set('pending_run_summary', {
    elapsedMs: 30 * 60 * 1000, distanceM: 5000, avgPaceSecPerKm: 360,
    avgBpm: 150, maxBpm: 170, avgCadenceSpm: 165, endedAtMs: Date.now() - 60 * 1000,
  });
  wx.store.set('coach_token', 'jwt-abc');
  const requests = [];
  wx.request = (req) => {
    requests.push(req);
    if (req.url.includes('/coach/memory-context')) {
      req.success({ statusCode: 200, data: { memories: ['上周共跑 3 次'], profile: '晨跑爱好者' } });
      return;
    }
    req.success({ statusCode: 200, data: { ok: true } });
  };

  page.onLoad();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴', '后台归档不得改写首页口号');
  assert.equal('sloganClass' in page.data, false, '首页不再保留跑后摘要视觉状态');
  assert.equal(wx.store.has('pending_run_summary'), false, '待办一次性消费');
  const record = requests.find((r) => r.url.includes('/coach/aiui-record'));
  assert.ok(record, '总结必须经 aiui-record 交给配置后端持久化');
  assert.equal(record.data.source, 'run-summary');
  assert.ok(record.data.reply.includes('5.00公里'));
  assert.match(record.data.client_record_id, /^air-[a-z0-9]+-[0-9a-f]{8}$/,
    '稳定 AIUI 记录 id 必须发送给后端支持幂等');
  const mem = requests.find((r) => r.url.includes('/coach/memory-context'));
  assert.ok(mem, '生成前尝试检索配置后端的远端记忆');
});

test('首页只有本地记忆和云端待传记录都读回成功后才删除唯一 summary', async () => {
  const page = freshPage();
  seedActiveDeviceIdentity();
  delete globalThis.LanguageModel;
  seedPendingSummary(Date.now() - 60 * 1000);
  wx.store.set('coach_token', 'jwt-abc');
  wx.request = (req) => req.fail({ errMsg: 'offline' });
  const baseSet = wx.setStorageSync.bind(wx);
  wx.setStorageSync = (key, value) => {
    if (key === 'pending_aiui_records') return;
    baseSet(key, value);
  };

  page.onLoad();
  await flushMicro();
  assert.equal(wx.store.has('pending_run_summary'), true,
    'AIUI 待传记录静默写失败时 summary 必须保留');
  assert.equal(wx.store.get('local_run_memories').length, 1,
    '已成功落盘的本地记忆允许保留并在重试时去重');
  assert.equal(wx.store.has('pending_aiui_records'), false);

  wx.setStorageSync = baseSet;
  await page.archiveRunSummary();
  await flushMicro();
  assert.equal(wx.store.has('pending_run_summary'), false);
  assert.equal(wx.store.get('local_run_memories').length, 1);
  assert.equal(wx.store.get('pending_aiui_records').length, 1);
});

test('HUD 只成功落 summary 时，首页会恢复 run-upload 且重复归档不产生重复 ID', async () => {
  const page = freshPage();
  seedActiveDeviceIdentity();
  delete globalThis.LanguageModel;
  const endedAtMs = Date.now() - 60 * 1000;
  seedPendingSummary(endedAtMs);
  wx.store.set('coach_token', 'jwt-abc');
  wx.request = (req) => req.fail({ errMsg: 'offline' });

  page.onLoad();
  await flushMicro();
  assert.equal(wx.store.has('pending_run_summary'), false,
    '三条归档队列都确认落盘后才消费恢复依据');
  const first = wx.store.get('pending_run_uploads');
  assert.equal(first.length, 1);
  assert.match(first[0].client_run_id, /^run-/);

  seedPendingSummary(endedAtMs);
  await page.archiveRunSummary();
  await flushMicro();
  const retried = wx.store.get('pending_run_uploads');
  assert.equal(retried.length, 1, '同一 summary 重放只能保留一条 run upload');
  assert.equal(retried[0].client_run_id, first[0].client_run_id);
});

test('无待办时首页口号保持默认,不发总结相关请求', async () => {
  const page = freshPage();
  const requests = [];
  wx.request = (req) => { requests.push(req); req.success({ statusCode: 200, data: {} }); };
  page.onLoad();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴');
  assert.equal(requests.filter((r) => r.url.includes('aiui-record')).length, 0);
});

test('旧版长期记忆关闭值不再生效，配置后端检索与回写继续运行', async () => {
  const page = freshPage();
  seedActiveDeviceIdentity();
  wx.store.set('run_settings', { memoryContext: false });
  wx.store.set('coach_token', 'jwt-should-not-be-used');
  wx.store.set('pending_aiui_records', [{ question: 'old', reply: 'old' }]);
  wx.store.set('local_run_memories', [{ elapsedMs: 60000, text: 'old local memory' }]);
  seedPendingSummary(Date.now() - 60 * 1000);
  const requests = [];
  wx.request = (req) => {
    requests.push(req);
    if (req.url.includes('/coach/memory-context')) {
      req.success({ statusCode: 200, data: { memories: [], profile: '' } });
      return;
    }
    req.success({ statusCode: 200, data: { ok: true } });
  };
  page.onLoad();
  await flushMicro();
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴');
  assert.equal(requests.some((req) => req.url.includes('/memory-context')), true);
  assert.equal(requests.some((req) => req.url.includes('/aiui-record')), true);
  assert.ok(wx.store.get('local_run_memories').length >= 1);
});

test('旧版 AI 总结关闭值不再生效并继续使用大模型', async (t) => {
  const page = freshPage();
  seedActiveDeviceIdentity();
  wx.store.set('run_settings', { aiSummary: false, memoryContext: true });
  wx.store.set('coach_token', 'jwt-unused');
  seedPendingSummary(Date.now() - 60 * 1000);
  let availabilityCalls = 0;
  globalThis.LanguageModel = {
    availability: async () => { availabilityCalls += 1; return 'available'; },
    create: async () => ({
      prompt: async () => '今天节奏稳定，注意补水。',
      destroy() {},
    }),
  };
  t.after(() => { delete globalThis.LanguageModel; });
  const requests = [];
  wx.request = (req) => { requests.push(req); req.success({ statusCode: 200, data: { ok: true } }); };
  page.onLoad();
  await flushMicro();
  assert.equal(availabilityCalls, 1);
  assert.equal(requests.some((req) => req.url.includes('/memory-context')), true);
  assert.equal(wx.store.get('local_run_memories').length, 1);
  assert.equal(
    wx.store.get('local_run_memories')[0].text,
    '本次跑步5.00公里，用时30:00。注意补水和恢复。',
  );
});

test('没有后端 app key 时，下一次 AI 总结仍会读取本地历史上下文', async (t) => {
  const page = freshPage();
  seedActiveDeviceIdentity();
  wx.store.set('local_run_memories', [{
    endedAtMs: Date.now() - 86400000, elapsedMs: 25 * 60000,
    text: '上次节奏稳定，最后五分钟略快。',
  }]);
  seedPendingSummary(Date.now() - 60 * 1000);
  let seenPrompt = '';
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async () => ({
      prompt: async (prompt) => { seenPrompt = prompt; return '今天节奏更稳，继续保持。'; },
      destroy() {},
    }),
  };
  t.after(() => { delete globalThis.LanguageModel; });
  page.onLoad();
  await flushMicro();
  assert.match(seenPrompt, /上次节奏稳定/);
  assert.equal(wx.store.get('local_run_memories').length, 2, '新总结也写入本地最近记录');
});

test('首页三条后台链路共用一次匿名登录，不并发注册多个 token', async () => {
  const page = freshPage();
  seedLegacyRealm({
    legacyDeviceId: 'legacy-shared-owner',
  });
  wx.store.set('coach_app_key', 'shared-key');
  wx.store.set(PENDING_RUNS_KEY, [PAYLOAD]);
  wx.store.set('pending_aiui_records', [{ question: 'q', reply: 'r', createdAtMs: 1 }]);
  seedPendingSummary(Date.now() - 60 * 1000);
  let loginCalls = 0;
  wx.request = (req) => {
    if (req.url.endsWith('/coach/anon-login')) {
      loginCalls += 1;
      setImmediate(() => req.success({ statusCode: 200, data: { token: 'jwt-one', user_id: 7 } }));
      return;
    }
    if (req.url.includes('/memory-context')) {
      req.success({ statusCode: 200, data: { memories: [], profile: '' } });
      return;
    }
    if (req.url.endsWith('/runs')) {
      req.success({ statusCode: 200, data: { id: 91 } });
      return;
    }
    req.success({ statusCode: 200, data: { ok: true } });
  };
  page.onLoad();
  await flushMicro(16);
  assert.equal(loginCalls, 1);
  assert.equal(wx.store.get('coach_token'), 'jwt-one');
});

test('远端记忆检索返回 401 会清理过期 token，保留本地记忆兜底', async () => {
  const page = freshPage();
  seedActiveDeviceIdentity({ token: 'expired' });
  wx.store.set('coach_token', 'expired');
  seedPendingSummary(Date.now() - 60 * 1000);
  wx.request = (req) => {
    if (req.url.includes('/memory-context')) {
      req.success({ statusCode: 401, data: {} });
      return;
    }
    req.fail({ errMsg: 'offline' });
  };
  page.onLoad();
  await flushMicro();
  assert.equal(wx.store.has('coach_token'), false);
  assert.equal(wx.store.get('local_run_memories').length, 1);
});

test('AI 总结先写持久化队列，断网保留；恢复后重试成功再删除', async () => {
  const page = freshPage();
  seedActiveDeviceIdentity();
  seedPendingSummary(Date.now() - 60 * 1000);
  wx.store.set('coach_token', 'jwt-abc');
  wx.request = (req) => {
    if (req.url.includes('/memory-context')) {
      req.success({ statusCode: 200, data: { memories: [], profile: '' } });
      return;
    }
    req.fail({ errMsg: 'offline' });
  };
  page.onLoad();
  await flushMicro();
  assert.equal(wx.store.get('pending_aiui_records').length, 1, '断网后记录仍在 storage');

  wx.request = (req) => req.success({ statusCode: 200, data: { ok: true } });
  await page.flushAiuiRecords();
  assert.equal(wx.store.has('pending_aiui_records'), false, '服务恢复并确认成功后才删队列');
});

const flushMicro = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function seedPendingSummary(endedAtMs) {
  const startedAtMs = endedAtMs - 30 * 60 * 1000;
  wx.store.set('pending_run_summary', {
    elapsedMs: 30 * 60 * 1000, distanceM: 5000, avgPaceSecPerKm: 360,
    avgBpm: 150, maxBpm: 170, avgCadenceSpm: 165, startedAtMs, endedAtMs,
    heartRatePolicy: {
      schema_version: 1,
      max_hr_bpm: 200,
      source: 'user_explicit',
      issued_at_ms: startedAtMs - 60 * 1000,
      expires_at_ms: startedAtMs + 24 * 60 * 60 * 1000,
    },
  });
}

test('Tier1 LLM 可用:后台生成且不改首页,记录落库用 AI 文本,session 必 destroy', async (t) => {
  const page = freshPage();
  seedActiveDeviceIdentity();
  seedPendingSummary(Date.now() - 60 * 1000);
  wx.store.set('coach_token', 'jwt-abc');
  const requests = [];
  wx.request = (req) => {
    requests.push(req);
    if (req.url.includes('/coach/memory-context')) {
      req.success({ statusCode: 200, data: { memories: ['上周共跑 3 次'], profile: '晨跑爱好者' } });
      return;
    }
    req.success({ statusCode: 200, data: { ok: true } });
  };
  let destroyed = 0;
  let createOpts = null;
  let resolvePrompt;
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async (opts) => {
      createOpts = opts;
      return {
        prompt: () => new Promise((resolve) => { resolvePrompt = resolve; }),
        destroy() { destroyed += 1; },
      };
    },
  };
  t.after(() => { delete globalThis.LanguageModel; });

  page.onLoad();
  await flushMicro();
  assert.equal(typeof resolvePrompt, 'function', '应已进入模型 prompt');
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴');
  resolvePrompt('今天节奏稳定，注意补水和恢复。');
  await flushMicro();
  assert.equal(createOpts.initialPrompts[0].role, 'system');
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴', 'AI 结果不得改写首页');
  assert.equal(destroyed, 1, '正常返回同样要 destroy session');
  const record = requests.find((r) => r.url.includes('/coach/aiui-record'));
  assert.ok(record, 'AI 总结必须交给配置后端持久化');
  assert.ok(record.data.reply.includes('注意补水和恢复'), '落库用规则化 AI 意图而非模型原文');
  assert.ok(!record.data.reply.includes('今天节奏稳定'), '模型自由文本不得原样落库');
});

test('LLM 返回前归属已切换：迟到的旧总结不得进入记忆或上传，首页始终不变', async (t) => {
  const page = freshPage();
  seedActiveDeviceIdentity({
    publicDeviceId: 'SR-INFLIGHT',
    secret: 'e'.repeat(48),
    token: 'old-owner-token',
    bound: false,
    ownershipEpoch: 1,
    dataNamespace: 'anon-old',
  });
  seedPendingSummary(Date.now() - 60 * 1000);
  let bootstrapCalls = 0;
  let resolvePrompt;
  let destroyed = 0;
  let recordPosts = 0;
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async () => ({
      prompt: () => new Promise((resolve) => { resolvePrompt = resolve; }),
      destroy() { destroyed += 1; },
    }),
  };
  t.after(() => { delete globalThis.LanguageModel; });
  wx.requestImpl = (opts) => {
    if (opts.url.endsWith('/coach/device-bootstrap')) {
      bootstrapCalls += 1;
      opts.success({ statusCode: 200, data: bootstrapCalls === 1 ? {
        public_device_id: 'SR-INFLIGHT', token: 'old-owner-token', bound: false,
        ownership_epoch: 1, data_namespace: 'anon-old',
      } : {
        public_device_id: 'SR-INFLIGHT', token: 'new-owner-token', bound: false,
        ownership_epoch: 3, data_namespace: 'anon-new',
      } });
      return;
    }
    if (opts.url.endsWith('/coach/memory-context')) {
      opts.success({ statusCode: 200, data: { memories: [], profile: '' } });
      return;
    }
    if (opts.url.endsWith('/coach/aiui-record')) {
      recordPosts += 1;
      opts.success({ statusCode: 200, data: { ok: true } });
      return;
    }
    opts.fail(new Error('unexpected request ' + opts.url));
  };

  page.onLoad();
  await flushMicro();
  assert.equal(typeof resolvePrompt, 'function', '旧 owner 的模型请求应已在途中');
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴');

  const generationBeforeOwnerChange = page.ownerDataGeneration;
  const switched = page.refreshDeviceIdentity({
    baseUrl: 'https://owner-switch.invalid/api/coach-svc',
    clientId: 'AISmartRun',
    appKey: '',
  }, { force: true });
  await switched;
  assert.equal(page.ownerDataGeneration, generationBeforeOwnerChange + 1,
    '同一 bootstrap 的回调 + marker 复核不得重复递增');
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴');

  resolvePrompt('这是不得泄露给新 owner 的迟到总结');
  await flushMicro();
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴', '迟到结果不得影响首页');
  assert.equal(wx.store.has('local_run_memories'), false, '迟到结果不得写本地记忆');
  assert.equal(wx.store.has('pending_aiui_records'), false, '迟到结果不得入上传队列');
  assert.equal(recordPosts, 0, '迟到结果不得发往后端');
  assert.equal(destroyed, 1, '废弃旧结果后仍要释放模型 session');
  assert.equal(page.summaryRunning, false);
});

test('损坏 owner journal 自愈会失效在途旧总结，不能在清理后重新写回', async (t) => {
  const page = freshPage();
  wx.store.set('smartrun_public_device_id', 'SR-JOURNAL');
  wx.store.set('smartrun_device_secret', 'j'.repeat(48));
  wx.store.set('smartrun_device_binding', {
    bound: false, ownershipEpoch: 1, dataNamespace: 'anon-before-journal', updatedAtMs: 1,
  });
  wx.store.set('smartrun_aiui_id', {
    aiuiId: 'A7K2M9Q4', publicDeviceId: 'SR-JOURNAL',
    ownershipEpoch: 1, dataNamespace: 'anon-before-journal',
  });
  seedPendingSummary(Date.now() - 60 * 1000);
  let resolvePrompt;
  let destroyed = 0;
  let recordPosts = 0;
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async () => ({
      prompt: () => new Promise((resolve) => { resolvePrompt = resolve; }),
      destroy() { destroyed += 1; },
    }),
  };
  t.after(() => { delete globalThis.LanguageModel; });
  wx.requestImpl = (opts) => {
    if (opts.url.endsWith('/coach/device-bootstrap')) {
      opts.success({ statusCode: 200, data: {
        public_device_id: 'SR-JOURNAL', token: 'old-token', bound: false,
        ownership_epoch: 1, data_namespace: 'anon-before-journal',
      } });
      return;
    }
    if (opts.url.endsWith('/coach/memory-context')) {
      opts.success({ statusCode: 200, data: { memories: [], profile: '' } });
      return;
    }
    if (opts.url.endsWith('/coach/aiui-record')) {
      recordPosts += 1;
      opts.success({ statusCode: 200, data: { ok: true } });
      return;
    }
    opts.fail(new Error('unexpected request ' + opts.url));
  };

  page.onLoad();
  await flushMicro();
  assert.equal(typeof resolvePrompt, 'function', '旧 owner 的总结已进入模型请求');
  const generationBeforeReplay = page.ownerDataGeneration;
  wx.store.set(OWNER_TRANSITION_PENDING_STORAGE_KEY, '{broken-json');
  const baseGet = wx.getStorageSync.bind(wx);
  wx.getStorageSync = (key) => {
    if (key === OWNER_TRANSITION_PENDING_STORAGE_KEY
        && wx.store.get(key) === '{broken-json') throw new Error('bad journal value');
    return baseGet(key);
  };

  assert.equal(page.ownerDataIsAvailable(), true, '键级损坏应在保守清理后恢复数据面');
  assert.equal(page.ownerDataGeneration, generationBeforeReplay + 1,
    'destructive replay 必须立即失效旧 owner 的内存任务');
  assert.equal(wx.store.has('smartrun_aiui_id'), false, '旧公开别名必须随 journal 清理');

  resolvePrompt('这条迟到总结不得重新写入新 owner');
  await flushMicro();
  assert.equal(wx.store.has('local_run_memories'), false);
  assert.equal(wx.store.has('pending_aiui_records'), false);
  assert.equal(recordPosts, 0);
  assert.equal(destroyed, 1);
  assert.equal(page.summaryRunning, false);
});

test('LLM prompt 悬死:8s 超时后后台使用兜底,泄漏的 session 被 destroy,流程收尾', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = freshPage();
  seedActiveDeviceIdentity();
  seedPendingSummary(Date.now() - 60 * 1000);   // 无 token/appKey:跳过记忆与落库
  let destroyed = 0;
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async () => ({
      prompt: () => new Promise(() => {}),
      destroy() { destroyed += 1; },
    }),
  };
  t.after(() => { delete globalThis.LanguageModel; });

  page.onLoad();
  await flushMicro();
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴');
  t.mock.timers.tick(8001);
  await flushMicro();
  assert.equal(destroyed, 1, '超时必须 destroy 泄漏的 session');
  assert.equal(page.summaryRunning, false, '总结流程必须收尾,不锁死下次总结');
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴');
});

test('availability 桥悬死:整体限时兜底,summaryRunning 不被锁死', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = freshPage();
  seedActiveDeviceIdentity();
  seedPendingSummary(Date.now() - 60 * 1000);
  globalThis.LanguageModel = { availability: () => new Promise(() => {}) };
  t.after(() => { delete globalThis.LanguageModel; });

  page.onLoad();
  await flushMicro();
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴');
  t.mock.timers.tick(10001);
  await flushMicro();
  assert.equal(page.summaryRunning, false, 'availability 悬死也必须在限时后收尾');
});

test('待办自带 AI 文本(总结页已生成):后台直接复用落库,不再二次生成或改首页', async (t) => {
  const page = freshPage();
  seedActiveDeviceIdentity();
  const endedAtMs = Date.now() - 60 * 1000;
  seedPendingSummary(endedAtMs);
  wx.store.set('pending_run_summary', {
    ...wx.store.get('pending_run_summary'),
    text: '状态在线，恢复到位再加量。',
  });
  wx.store.set('coach_token', 'jwt-abc');
  const requests = [];
  wx.request = (req) => { requests.push(req); req.success({ statusCode: 200, data: { ok: true } }); };
  let llmTouched = false;
  globalThis.LanguageModel = { availability: async () => { llmTouched = true; return 'unavailable'; } };
  t.after(() => { delete globalThis.LanguageModel; });

  page.onLoad();
  await flushMicro();
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴');
  assert.equal(llmTouched, false, '有现成文本绝不二次生成');
  assert.equal(requests.some((r) => r.url.includes('/coach/memory-context')), false, '也不再检索记忆');
  const record = requests.find((r) => r.url.includes('/coach/aiui-record'));
  assert.ok(
    record && record.data.reply === '本次跑步5.00公里，用时30:00。注意补水和恢复。',
    '落库前仍须把总结页模型文本规则化',
  );
});

test('陈年待办(超过 12 小时)直接丢弃:不归档、不改首页、待办清空', async () => {
  const page = freshPage();
  seedActiveDeviceIdentity();
  seedPendingSummary(Date.now() - 13 * 60 * 60 * 1000);
  const requests = [];
  wx.request = (req) => { requests.push(req); req.success({ statusCode: 200, data: {} }); };
  page.onLoad();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.data.homeSlogan, '自由开跑，智能相伴');
  assert.equal(wx.store.has('pending_run_summary'), false, '陈年待办也要消费掉');
  assert.equal(requests.filter((r) => r.url.includes('aiui-record')).length, 0);
});
