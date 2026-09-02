// AIUI 当前版的 Backspace 过渡协议：页面只监听并同步记录意图，
// 不 preventDefault、不在按键回调里竞争路由；宿主随后完成默认返回。

export const HOST_BACKSPACE_SOURCE_KEY = 'aiui_host_backspace_source';

function safeSet(storage, key, value) {
  try { if (storage) storage.setStorageSync(key, value); } catch (_e) {}
}

function safeRemove(storage, key) {
  try { if (storage) storage.removeStorageSync(key); } catch (_e) {}
}

export function markHostBackspaceIntent(storage, source) {
  if (!source || typeof source !== 'string') return false;
  safeSet(storage, HOST_BACKSPACE_SOURCE_KEY, source);
  return true;
}

/** 作者控制的首页→沉浸页导航，清掉上一轮宿主返回痕迹。 */
export function beginInternalSurfaceNavigation(storage) {
  safeRemove(storage, HOST_BACKSPACE_SOURCE_KEY);
}

/** 首页真正到达后清理一次性返回痕迹。 */
export function completeHomeResume(storage) {
  safeRemove(storage, HOST_BACKSPACE_SOURCE_KEY);
}

// 跑步刚结束的一次性提示:跑完按返回落到首页时,首页预点亮"再按返回键退出",
// 用户再按一下即可离开应用(跑完到退出共两下返回)。
export const RUN_FINISHED_HINT_KEY = 'aiui_run_finished_at';

export function writeRunFinishedHint(storage, now = Date.now()) {
  try { storage.setStorageSync(RUN_FINISHED_HINT_KEY, String(now)); } catch (_e) {}
}

/** 读取并消费跑完提示;只认新鲜记录(防止被杀后隔天启动误点亮退出)。 */
export function consumeRunFinishedHint(storage, maxAgeMs = 60000, now = Date.now()) {
  let raw = '';
  try { raw = storage.getStorageSync(RUN_FINISHED_HINT_KEY) || ''; } catch (_e) {}
  safeRemove(storage, RUN_FINISHED_HINT_KEY);
  const at = Number(raw);
  return Number.isFinite(at) && at > 0 && now - at >= 0 && now - at <= maxAgeMs;
}

// 02 扫描页的“连续按两次返回键退出”跨页握手。第一下 Backspace 必须交给
// 宿主完成默认返回，因此只把一个极短的一次性标记交给 448x150 首页；首页恢复
// 后立即预武装现有的第二次返回退出提示。它不携带任何用户或设备信息。
export const SCAN_EXIT_HINT_KEY = 'aiui_scan_exit_at';

export function writeScanExitHint(storage, now = Date.now()) {
  try { storage.setStorageSync(SCAN_EXIT_HINT_KEY, String(now)); } catch (_e) {}
}

export function consumeScanExitHint(storage, maxAgeMs = 3000, now = Date.now()) {
  let raw = '';
  try { raw = storage.getStorageSync(SCAN_EXIT_HINT_KEY) || ''; } catch (_e) {}
  safeRemove(storage, SCAN_EXIT_HINT_KEY);
  const at = Number(raw);
  return Number.isFinite(at) && at > 0 && now - at >= 0 && now - at <= maxAgeMs;
}
