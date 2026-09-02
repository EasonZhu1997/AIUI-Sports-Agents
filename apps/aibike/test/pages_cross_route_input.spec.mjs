import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadPageModule,
  instantiatePage,
  fakeWx,
} from './helpers/load_page.mjs';

const homeDef = await loadPageModule('index');
const rideDef = await loadPageModule('ride_hud');

after(() => {
  delete globalThis.__pageWx;
  delete globalThis.navigator;
  delete globalThis.Sound;
});

function bootPair() {
  const wx = fakeWx();
  globalThis.__pageWx = wx;
  delete globalThis.navigator;
  globalThis.Sound = class {
    play() {}
    stop() {}
    destroy() {}
  };
  const home = instantiatePage(homeDef);
  home.onLoad();
  const ride = instantiatePage(rideDef);
  return { wx, home, ride };
}

test('首页确认的路由尾包不能在骑行菜单里自动启动自由骑', () => {
  const { wx, home, ride } = bootPair();
  let homePrevented = false;
  home.onKeyUp({
    code: 'GlobalHook',
    preventDefault() { homePrevented = true; },
  });
  assert.equal(homePrevented, true);
  assert.deepEqual(
    wx.navigateToCalls,
    ['/pages/ride_hud/index?mode=menu&inputGuard=1&returnCard=1'],
  );

  ride.onLoad({ mode: 'menu', inputGuard: '1', returnCard: '1' });
  let tailPrevented = false;
  ride.onKeyUp({
    code: 'Enter',
    preventDefault() { tailPrevented = true; },
  });
  assert.equal(tailPrevented, true);
  assert.equal(ride.data.surfacePhase, 'menu');

  ride.menuEntryConfirmGuardUntilMs = Date.now() - 1;
  ride.surfaceEntryConfirmGuardUntilMs = Date.now() - 1;
  ride.setMenuFocus(1);
  ride.onKeyUp({ code: 'Enter', preventDefault() {} });
  assert.equal(ride.data.surfacePhase, 'warmup');
  assert.match(ride.data.warmupTitle, /肩胸|髋|股四头肌|小腿/);
  ride.surfaceEntryConfirmGuardUntilMs = Date.now() - 1;
  ride.lastSurfaceActivationAtMs = Date.now() - 1000;
  ride.skipWarmup();
  assert.equal(ride.data.surfacePhase, 'ready');

  home.onUnload();
  ride.onUnload();
});

test('方向键释放保护会隔离尾随确认，新的独立确认才激活焦点', () => {
  const { home, ride } = bootPair();
  ride.onLoad({ mode: 'menu' });

  ride.onKeyUp({ code: 'ArrowUp', preventDefault() {} });
  assert.equal(ride.menuFocusIndex, 2);
  ride.onKeyUp({ code: 'Enter', preventDefault() {} });
  assert.equal(ride.data.surfacePhase, 'menu');

  ride.surfaceEntryConfirmGuardUntilMs = Date.now() - 1;
  ride.lastSurfaceActivationAtMs = Date.now() - 1000;
  ride.onKeyUp({ code: 'Enter', preventDefault() {} });
  assert.equal(ride.data.surfacePhase, 'settings');

  home.onUnload();
  ride.onUnload();
});
