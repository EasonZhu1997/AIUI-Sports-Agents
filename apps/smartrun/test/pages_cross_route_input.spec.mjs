// 首页与沉浸页共享同一次真机物理按压时的跨路由回归测试。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadPageModule, instantiatePage, fakeWx } from './helpers/load_page.mjs';

const homeDef = await loadPageModule('index');
const runDef = await loadPageModule('run_hud');

after(() => { delete globalThis.__pageWx; });

test('GlobalHook 打开菜单后尾随 Enter 不得自动确认自由跑', () => {
  const wx = fakeWx();
  globalThis.__pageWx = wx;
  delete globalThis.navigator;
  const home = instantiatePage(homeDef);
  home.onLoad();

  let homePrevented = false;
  home.onKeyUp({ code: 'GlobalHook', preventDefault() { homePrevented = true; } });
  assert.equal(homePrevented, true);
  assert.deepEqual(wx.navigateToCalls, ['/pages/run_hud/index?mode=menu&inputGuard=1&fromHome=1']);

  const run = instantiatePage(runDef);
  run.onLoad({ mode: 'menu', inputGuard: '1', fromHome: '1' });
  let tailPrevented = false;
  run.onKeyUp({ code: 'Enter', preventDefault() { tailPrevented = true; } });
  assert.equal(tailPrevented, true);
  assert.equal(run.data.surfacePhase, 'menu');
  assert.equal(run.menuFocusIndex, 0);

  // 保护期后，新的独立确认只可进入设备搜索；不得跨过配置与热身直达 HUD。
  run.menuEntryConfirmGuardUntilMs = Date.now() - 1;
  run.onKeyUp({ code: 'Enter', preventDefault() {} });
  assert.equal(run.data.surfacePhase, 'ready');
  assert.equal(run.data.primaryLabel, '开始搜索');

  if (home.navPendingTimer) clearTimeout(home.navPendingTimer);
  try { run.onUnload(); } catch (_e) {}
});

test('原生 Enter bindtap 打开菜单后尾随 GlobalHook 与新页 bindtap 均被隔离', () => {
  const wx = fakeWx();
  globalThis.__pageWx = wx;
  delete globalThis.navigator;
  const home = instantiatePage(homeDef);
  home.onLoad();

  let homePrevented = false;
  home.onKeyUp({ code: 'Enter', preventDefault() { homePrevented = true; } });
  assert.equal(homePrevented, false, 'Enter 应交给首页原生按钮');
  home.openMenu(); // 宿主随后派发 bindtap
  assert.deepEqual(wx.navigateToCalls, ['/pages/run_hud/index?mode=menu&inputGuard=1&fromHome=1']);

  const run = instantiatePage(runDef);
  run.onLoad({ mode: 'menu', inputGuard: '1', fromHome: '1' });
  let tailPrevented = false;
  run.onKeyUp({ code: 'GlobalHook', preventDefault() { tailPrevented = true; } });
  assert.equal(tailPrevented, true, '新页必须同步拦截上一手势的 GlobalHook 尾包');
  assert.equal(run.openFreeMode(), false, '同次 TouchEnd 也不能绕过菜单入场保护');
  assert.equal(run.data.surfacePhase, 'menu');

  if (home.navPendingTimer) clearTimeout(home.navPendingTimer);
  try { run.onUnload(); } catch (_e) {}
});
