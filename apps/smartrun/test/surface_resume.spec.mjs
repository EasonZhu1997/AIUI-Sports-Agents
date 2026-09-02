import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_BACKSPACE_SOURCE_KEY,
  SCAN_EXIT_HINT_KEY,
  beginInternalSurfaceNavigation,
  completeHomeResume,
  consumeScanExitHint,
  markHostBackspaceIntent,
  writeScanExitHint,
} from '../lib/surface_resume.js';
import { fakeWx } from './helpers/load_page.mjs';

test('沉浸页 Backspace 只记录宿主返回意图，不发起应用路由', () => {
  const wx = fakeWx();
  assert.equal(markHostBackspaceIntent(wx, 'run_hud'), true);
  assert.equal(wx.store.get(HOST_BACKSPACE_SOURCE_KEY), 'run_hud');
  assert.deepEqual(wx.navigateToCalls, []);
  assert.deepEqual(wx.redirectToCalls, []);
});

test('内部进入沉浸页和首页恢复都会清理上一轮返回痕迹', () => {
  const wx = fakeWx();
  markHostBackspaceIntent(wx, 'run_hud');
  beginInternalSurfaceNavigation(wx, 'run_hud');
  assert.equal(wx.store.has(HOST_BACKSPACE_SOURCE_KEY), false);
  markHostBackspaceIntent(wx, 'run_hud');
  completeHomeResume(wx);
  assert.equal(wx.store.has(HOST_BACKSPACE_SOURCE_KEY), false);
});

test('扫描退出标记只消费一次且只在三秒窗口内有效', () => {
  const wx = fakeWx();
  writeScanExitHint(wx, 1000);
  assert.equal(wx.store.get(SCAN_EXIT_HINT_KEY), '1000');
  assert.equal(consumeScanExitHint(wx, 3000, 3999), true);
  assert.equal(wx.store.has(SCAN_EXIT_HINT_KEY), false);
  assert.equal(consumeScanExitHint(wx, 3000, 3999), false, '一次性标记不可重复消费');

  writeScanExitHint(wx, 1000);
  assert.equal(consumeScanExitHint(wx, 3000, 4001), false, '过期标记不得预武装退出');
  assert.equal(wx.store.has(SCAN_EXIT_HINT_KEY), false);
});
