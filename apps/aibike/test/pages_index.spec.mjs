import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadPageModule,
  instantiatePage,
  fakeWx,
} from './helpers/load_page.mjs';
import { LAST_RIDE_SUMMARY_KEY } from '../lib/ride_summary.js';
import {
  RIDE_FINISHED_HINT_KEY,
  SCAN_EXIT_HINT_KEY,
} from '../lib/ride_surface.js';

const source = readFileSync(
  new URL('../pages/index/index.ink', import.meta.url),
  'utf8',
);
const pageDef = await loadPageModule('index');

function cssPixelWidth(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(block, `missing CSS selector ${selector}`);
  const width = block[1].match(/\bwidth:\s*(\d+)px;/);
  assert.ok(width, `${selector} must declare a pixel width`);
  return Number(width[1]);
}

let wx;
function freshPage() {
  wx = fakeWx();
  globalThis.__pageWx = wx;
  delete globalThis.navigator;
  const page = instantiatePage(pageDef);
  page.onLoad();
  return page;
}

after(() => {
  delete globalThis.__pageWx;
  delete globalThis.navigator;
});

test('首页只展示 AIBike 骑行入口，不带旧身份、后端或上传依赖', () => {
  assert.match(source, /AIBike/);
  assert.match(source, /homeVersion:\s*'v0\.3\.80'/);
  assert.match(source, /自由骑行，智能相伴/);
  assert.match(source, /class="bike-logo"/);
  assert.match(source, /class="bike-logo-text">AB<\/text>/);
  assert.doesNotMatch(source, /aibike-cyclist-48|<image\b/i);
  assert.match(source, /from '\.\.\/\.\.\/lib\/ride_surface\.js'/);
  assert.doesNotMatch(
    source,
    /device_identity|coach_api|run_upload|run_summary|surface_resume|绑定|跑步|步频|RSC|2a53/i,
  );
});

test('首页显示 v0.3.80，品牌左右版本槽等宽', () => {
  const page = freshPage();
  assert.equal(page.data.homeVersion, 'v0.3.80');
  assert.match(source, /class="home-version-spacer"/);
  assert.match(source, /class="home-version">\{\{\s*homeVersion\s*\}\}<\/text>/);
  assert.equal(cssPixelWidth('.home-version-spacer'), 64);
  assert.equal(
    cssPixelWidth('.home-version-spacer'),
    cssPixelWidth('.home-version'),
  );
  page.onUnload();
});

test('首页是 448x150 单按钮原生焦点面板，加载时不访问蓝牙', () => {
  let bluetoothCalls = 0;
  const page = freshPage();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      bluetooth: {
        scanDevices() { bluetoothCalls += 1; },
        getDevices() { bluetoothCalls += 1; },
      },
    },
  });
  page.onLoad();
  page.onShow();
  assert.deepEqual(page.data, {
    homeVersion: 'v0.3.80',
    homeSlogan: '自由骑行，智能相伴',
    enterText: '按确认键进入',
  });
  assert.equal(bluetoothCalls, 0);
  assert.match(source, /width:\s*448px/);
  assert.match(source, /height:\s*150px/);
  assert.equal((source.match(/<button\b/g) || []).length, 1);
  delete globalThis.navigator;
  page.onUnload();
});

test('原生 Enter 交给唯一按钮，bindtap 只进入骑行菜单', () => {
  const page = freshPage();
  let prevented = false;
  page.onKeyUp({
    code: 'Enter',
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, false);
  assert.deepEqual(wx.navigateToCalls, []);

  assert.equal(page.openMenu(), true);
  assert.deepEqual(
    wx.navigateToCalls,
    ['/pages/ride_hud/index?mode=menu&inputGuard=1&returnCard=1'],
  );
  assert.equal(page.openMenu(), false, '同一实体确认不能重复压栈');
  page.onUnload();
});

test('GlobalHook 拦截别名并进入菜单，返回首页后才解除导航锁', () => {
  const page = freshPage();
  let prevented = false;
  page.onKeyUp({
    code: 'GlobalHook',
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.deepEqual(
    wx.navigateToCalls,
    ['/pages/ride_hud/index?mode=menu&inputGuard=1&returnCard=1'],
  );
  page.openMenu();
  assert.equal(wx.navigateToCalls.length, 1);

  page.onShow();
  assert.equal(page.openMenu(), true);
  assert.equal(wx.navigateToCalls.length, 2);
  page.onUnload();
});

test('骑行完成返回首页后，小卡读取已持久化总结并提供再次骑行入口', () => {
  const page = freshPage();
  wx.store.set(LAST_RIDE_SUMMARY_KEY, {
    elapsedMs: 125000,
    movingMs: 120000,
    distanceM: 1250,
    avgSpeedKmh: 12.5,
    endedAtMs: Date.now(),
  });
  wx.store.set(RIDE_FINISHED_HINT_KEY, String(Date.now()));

  page.onShow();

  assert.equal(page.data.homeSlogan, '最近骑行 02:05 · 1.25 km');
  assert.equal(page.data.enterText, '再次骑行');
  assert.equal(wx.store.has(RIDE_FINISHED_HINT_KEY), false, '完成标记必须一次性消费');
  assert.equal(page.openMenu(), false, '回卡尾随触摸在 800ms 内不得重新压入沉浸页');
  page.homeEntryGuardUntilMs = Date.now() - 1;
  assert.equal(page.openMenu(), true);
  assert.deepEqual(
    wx.navigateToCalls,
    ['/pages/ride_hud/index?mode=menu&inputGuard=1&returnCard=1'],
  );
  page.onUnload();
});

test('扫描页返回标记会预武装首页；第二次 Backspace 退出应用', () => {
  const page = freshPage();
  const exitOptions = [];
  wx.exitMiniProgram = (options) => {
    wx.exitMiniProgramCalls += 1;
    exitOptions.push(options);
  };
  wx.store.set(SCAN_EXIT_HINT_KEY, String(Date.now()));
  page.onShow();
  assert.equal(page.data.enterText, '再按返回键退出');
  assert.equal(wx.store.has(SCAN_EXIT_HINT_KEY), false);

  let prevented = false;
  page.onKeyUp({
    code: 'Backspace',
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, false, '首页 Backspace 保留宿主默认行为');
  assert.equal(wx.exitMiniProgramCalls, 1);
  assert.deepEqual(exitOptions, [{}]);
  assert.match(source, /wx\.exitMiniProgram\s*\(\s*\{\s*\}\s*\)/);
  page.onUnload();
});
