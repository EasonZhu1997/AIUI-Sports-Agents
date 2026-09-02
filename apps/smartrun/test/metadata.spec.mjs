import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_FILES = ['pages/index/index.ink', 'pages/run_hud/index.ink'];
const DELETED_ROUTES = ['bluetooth', 'settings', 'coach', 'hr_card'];
const CURRENT_RELEASE_DOCS = [
  'README.md',
  'docs/AISmartRun_PRD.md',
  'docs/AISmartRun_PRD_EN.md',
  'docs/LOCAL_RELEASE_SCORECARD.md',
  'docs/AIUI_RELEASE_WORKFLOW.md',
  'docs/ALPHA_TEST_MATRIX.md',
  'docs/PUBLIC_BETA_READINESS.md',
  'docs/PROJECT_STRUCTURE.md',
  'docs/QUALITY_95_AUDIT.md',
  'release/README.md',
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readDef(rel) {
  const source = read(rel);
  const match = source.match(/<script[^>]*\bdef\b[^>]*>\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(match, `${rel} must contain script def metadata`);
  return JSON.parse(match[1]);
}

function cssBlock(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...source.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`, 'g'))];
  assert.ok(matches.length, `missing CSS selector ${selector}`);
  return matches[matches.length - 1][1];
}

function stripJsComments(source) {
  return String(source || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function inspectPcmWav(buffer) {
  assert.ok(buffer.length >= 44, 'WAV must include a complete RIFF header');
  assert.equal(buffer.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(buffer.subarray(8, 12).toString('ascii'), 'WAVE');
  let format = null;
  let dataBytes = null;
  let dataStart = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const chunkId = buffer.subarray(offset, offset + 4).toString('ascii');
    const chunkBytes = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    assert.ok(bodyStart + chunkBytes <= buffer.length, `truncated WAV chunk: ${chunkId}`);
    if (chunkId === 'fmt ' && chunkBytes >= 16) {
      format = {
        pcmFormat: buffer.readUInt16LE(bodyStart),
        channels: buffer.readUInt16LE(bodyStart + 2),
        sampleRate: buffer.readUInt32LE(bodyStart + 4),
        byteRate: buffer.readUInt32LE(bodyStart + 8),
        bitsPerSample: buffer.readUInt16LE(bodyStart + 14),
      };
    } else if (chunkId === 'data') {
      dataBytes = chunkBytes;
      dataStart = bodyStart;
    }
    offset = bodyStart + chunkBytes + (chunkBytes % 2);
  }
  assert.ok(format, 'WAV must include a PCM fmt chunk');
  assert.ok(dataBytes != null, 'WAV must include a data chunk');
  assert.ok(format.byteRate > 0, 'WAV byte rate must be positive');
  let firstAudibleMs = null;
  if (format.pcmFormat === 1 && format.bitsPerSample === 16 && format.channels > 0) {
    const frameBytes = format.channels * 2;
    const frameCount = Math.floor(dataBytes / frameBytes);
    for (let frame = 0; frame < frameCount; frame += 1) {
      let peak = 0;
      for (let channel = 0; channel < format.channels; channel += 1) {
        peak = Math.max(
          peak,
          Math.abs(buffer.readInt16LE(dataStart + frame * frameBytes + channel * 2)),
        );
      }
      if (peak > 100) {
        firstAudibleMs = frame * 1000 / format.sampleRate;
        break;
      }
    }
  }
  return {
    ...format,
    dataBytes,
    durationMs: dataBytes * 1000 / format.byteRate,
    firstAudibleMs,
  };
}

function methodBody(source, methodName) {
  const escaped = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Accept one level of nested parentheses in default parameters such as
  // `now = Date.now()` while still keeping the method search bounded.
  const signature = new RegExp(
    `(?:^|\\n)\\s*(?:async\\s+)?${escaped}\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*\\{`,
    'm',
  );
  const match = signature.exec(source);
  assert.ok(match, `missing method ${methodName}`);
  const open = source.indexOf('{', match.index + match[0].lastIndexOf('{'));
  let depth = 0;
  let quote = '';
  let escapedChar = false;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escapedChar) { escapedChar = false; continue; }
      if (ch === '\\') { escapedChar = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  assert.fail(`unterminated method ${methodName}`);
}

function exactCanvas(rel, selector, width, height) {
  const block = cssBlock(read(rel), selector);
  assert.match(block, new RegExp(`width:\\s*${width}px\\s*;`));
  assert.match(block, new RegExp(`height:\\s*${height}px\\s*;`));
  assert.match(block, /box-sizing:\s*border-box\s*;/);
}

test('应用只注册两个技术路由，训练选择、设置、搜索、HUD、总结与恢复都收敛在沉浸路由', () => {
  const app = JSON.parse(read('app.json'));
  assert.deepEqual(app.pages, ['pages/run_hud/index', 'pages/index/index']);
  assert.equal(app.engine, '>=0.15.0, <0.17.0');
  assert.equal(app.window.navigationBarTitleText, '跑步教练');
  const pageDirs = fs.readdirSync(path.join(ROOT, 'pages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(pageDirs, ['index', 'run_hud']);
  for (const route of DELETED_ROUTES) {
    assert.equal(fs.existsSync(path.join(ROOT, 'pages', route)), false, `${route} page must be deleted`);
  }
});

test('生产生命周期日志只输出有界事件名，不序列化 App 实例', () => {
  const source = read('app.js');
  assert.doesNotMatch(source, /console\.log\([^)]*,\s*this\s*\)/);
  assert.match(source, /\[SmartRun\] APP_LAUNCH/);
  assert.match(source, /\[SmartRun\] APP_SHOW/);
  assert.match(source, /\[SmartRun\] APP_HIDE/);
});

test('沉浸路由排第一并由 Reader 派生 _blank，01 保留为 title-only 兼容回退', () => {
  const home = readDef('pages/index/index.ink');
  const run = readDef('pages/run_hud/index.ink');
  assert.equal(home.navigationBarTitleText, '跑步教练');
  assert.deepEqual(Object.keys(home), ['navigationBarTitleText']);
  assert.deepEqual(Object.keys(run), ['navigationBarTitleText']);
  assert.equal(run.navigationBarTitleText, '跑步教练');
});

test('双画布尺寸固定：首页按 target 在 448x150 与 480x352 间自适应，沉浸业务面为 480x352', () => {
  exactCanvas('pages/index/index.ink', '.home-card', 448, 150);
  const homeSource = read('pages/index/index.ink');
  const homeWrap = cssBlock(homeSource, '.home-wrap');
  assert.match(homeWrap, /width:\s*448px\s*;/);
  assert.match(homeWrap, /height:\s*150px\s*;/);
  assert.match(homeWrap, /justify-content:\s*flex-end\s*;/);
  assert.match(homeWrap, /position:\s*fixed\s*;/);
  assert.match(homeWrap, /bottom:\s*0\s*;/);
  assert.match(homeWrap, /left:\s*0\s*;/);
  assert.match(homeWrap, /right:\s*0\s*;/);
  assert.match(homeSource,
    /@media\s*\(target:\s*_current\)\s*\{[\s\S]*?\.home-wrap\s*\{[\s\S]*?width:\s*448px;[\s\S]*?height:\s*150px;/);
  assert.match(homeSource,
    /@media\s*\(target:\s*_blank\)\s*\{[\s\S]*?\.home-wrap\s*\{[\s\S]*?width:\s*480px;[\s\S]*?height:\s*352px;[\s\S]*?\.home-card\s*\{[\s\S]*?width:\s*448px;[\s\S]*?height:\s*352px;/);
  assert.match(homeSource,
    /onTargetChanged\(target, previousTarget\)[\s\S]*?target === '_blank'[\s\S]*?this\.setData\(\{ hostTarget \}\)/,
    '首页脚本必须同步 target，但不得依赖像素猜测承载态');
  exactCanvas('pages/run_hud/index.ink', '.immersive-root', 480, 352);
  assert.match(read('pages/run_hud/index.ink'), /<page>\s*<view class="immersive-root">/);
  exactCanvas('pages/run_hud/index.ink', '.hud', 480, 352);
  // 02 已改为官方样例同构的流式根容器(min-height 保底,真机记忆:显式 352px 防黑屏)
  const runContainer = cssBlock(read('pages/run_hud/index.ink'), '.container');
  assert.match(runContainer, /min-height:\s*352px\s*;/);
  assert.match(runContainer, /flex-direction:\s*column\s*;/);
  const immersiveGroup = read('pages/run_hud/index.ink').match(
    /\.feature-menu,\s*\.settings-screen\s*\{([\s\S]*?)\}/,
  )[1];
  assert.match(immersiveGroup, /width:\s*480px\s*;/);
  assert.match(immersiveGroup, /height:\s*352px\s*;/);
  assert.match(immersiveGroup, /box-sizing:\s*border-box\s*;/);
  for (const selector of ['.hud-wrap', '.hud']) {
    exactCanvas('pages/run_hud/index.ink', selector, 480, 352);
  }
  for (const selector of ['.training-screen', '.recovery-wrap']) {
    exactCanvas('pages/run_hud/index.ink', selector, 480, 352);
  }
});

test('根面使用普通 view，消除 AIUI Card 内建 12px padding 与右侧裁切', () => {
  const home = read('pages/index/index.ink');
  const run = read('pages/run_hud/index.ink');
  assert.match(home, /<view class="home-card" role="navigation">/);
  assert.doesNotMatch(home, /<card\b/);
  assert.match(run, /<view class="hud">/);
  assert.doesNotMatch(run, /class="hud" role=/);
  assert.doesNotMatch(run, /<card\b/);
  for (const [source, selector] of [[home, '.home-card'], [run, '.hud']]) {
    const block = cssBlock(source, selector);
    assert.match(block, /margin:\s*0\s*;/);
    assert.match(block, /padding:\s*0\s*;/);
    assert.match(block, /overflow:\s*hidden\s*;/);
    assert.doesNotMatch(block, /\bborder\s*:/, `${selector} must not draw an outer canvas border`);
  }
});

test('设置有六个配置项和明确返回按钮，快速结束位于节拍器与绑定之间', () => {
  const source = read('pages/run_hud/index.ink');
  const identity = read('lib/device_identity.js');
  const settings = read('lib/settings.js');
  const indexes = [...source.matchAll(/class="setting-row \{\{ setting[A-Za-z]+Class \}\}" tabindex="(\d)"/g)]
    .map((match) => Number(match[1]));
  assert.deepEqual(indexes, [0, 1, 2, 3, 4, 5]);
  assert.match(source, /surfacePhase:\s*'binding'/);
  assert.match(source, /class="setting-row \{\{ settingMetronomeClass \}\}" tabindex="2" data-setting="metronome" data-index="2"/);
  assert.match(source, /class="setting-row \{\{ settingGuideQuickExitClass \}\}" tabindex="3" data-setting="guide" data-index="3"/);
  assert.match(source, /class="setting-row \{\{ settingBindingClass \}\}" tabindex="4" data-setting="binding" data-index="4"/);
  assert.match(source, /class="setting-row \{\{ settingHeartRateClass \}\}" tabindex="5" data-setting="heart" data-index="5"/);
  assert.match(source, /class="settings-back \{\{ settingBackClass \}\}" tabindex="6" data-setting="back" data-index="6"/);
  assert.match(source, /<text class="setting-name">节拍器<\/text>/);
  assert.match(source, /<view class="setting-info">\s*<text class="setting-name">AI 大模型<\/text><text class="setting-value">记忆使用 EverMind<\/text>\s*<\/view>/);
  assert.doesNotMatch(source, /<button[^>]*data-setting="(?:summary|memory)"|settingAiSummaryClass|settingMemoryClass/);
  assert.doesNotMatch(source, /key === '(?:summary|memory)'/,
    'AI 跑后总结与 EverMind 记忆必须是固定能力，不能再由设置交互关闭');
  assert.match(source, /<view class="binding-screen" ink:if="\{\{ surfacePhase === 'binding' \}\}">/);
  assert.match(source, /<text class="binding-label">AIUI ID<\/text>/);
  assert.match(source,
    /<button class="binding-action \{\{ bindingRefreshClass \}\}" tabindex="0" data-action="refresh" data-index="0" bindfocus="onBindingFocus" bindtap="onBindingTap">/);
  assert.match(source,
    /<button class="binding-action binding-action-export \{\{ bindingExportClass \}\}" tabindex="1" data-action="export" data-index="1" bindfocus="onBindingFocus" bindtap="onBindingTap">/);
  assert.match(source, /前后划选择 · 单击执行 · 返回键回设置/);
  assert.match(source, /可在已登录 APK 输入此 ID 绑定/);
  assert.match(source, /刷新状态/);
  assert.match(source, /导出现场日志/);

  const bindingActionStyle = cssBlock(source, '.binding-action');
  const bindingFocusedStyle = cssBlock(source, '.binding-action-focused');
  assert.doesNotMatch(bindingActionStyle, /\boutline(?:-[a-z-]+)?\s*:/,
    '未选中的绑定操作不得声明焦点框');
  assert.match(bindingFocusedStyle, /outline-width:\s*2px;/);
  assert.match(bindingFocusedStyle, /outline-style:\s*solid;/);
  assert.match(bindingFocusedStyle, /outline-color:\s*var\(--color-primary/);
  assert.match(bindingFocusedStyle, /outline-offset:\s*-2px;/);

  const openBody = source.slice(
    source.indexOf('  openDevicePairing() {'),
    source.indexOf('  showSettingsFromBinding() {'),
  );
  const recoveryBody = source.slice(
    source.indexOf('  async recoverDeviceIdentityFromBinding('),
    source.indexOf('  async onBindingActionTap() {'),
  );
  const actionBody = methodBody(source, 'onBindingActionTap');
  const exportBody = methodBody(source, 'onBindingExportTap');
  const replayBody = methodBody(source, 'replayRunningLocalFieldLog');
  const bindingReturnBody = methodBody(source, 'showSettingsFromBinding');
  const hideBody = methodBody(source, 'onHide');
  assert.doesNotMatch(openBody, /recoverFreshAnonymousDeviceIdentity/,
    '进入绑定页只读身份，不得把同一次确认当作凭据恢复');
  assert.doesNotMatch(source,
    /buildDevicePairCodeRequest|parseDevicePairCodeResponse|expires_in_s|expiresInS|bindingWindow/,
    '永久当前 AIUI ID 不得保留 pair-code、有效期或本地 window 状态');
  assert.match(actionBody, /refreshDeviceIdentity/);
  assert.match(exportBody,
    /readLatestRunningLocalFieldLog[\s\S]*暂无可导出的跑步日志[\s\S]*replayRunningLocalFieldLog[\s\S]*onComplete/,
    '导出项必须读取最新日志、处理无日志并只在完整回放后完成');
  assert.match(replayBody, /typeof options\.onComplete === 'function'[\s\S]*options\.onComplete\(\)/);
  assert.match(bindingReturnBody, /cancelRunningLocalFieldLogReplay\(\)/,
    '离开绑定页必须取消 ADB 回放');
  assert.match(hideBody,
    /bindingExportWasPending[\s\S]*cancelRunningLocalFieldLogReplay\(\)[\s\S]*现场日志导出已暂停/,
    '页面隐藏必须取消回放并把导出恢复为可重试状态');
  assert.match(recoveryBody, /recoverFreshAnonymousDeviceIdentity[\s\S]*userConfirmed:\s*true/);
  assert.match(identity, /opts\.userConfirmed !== true/);
  assert.match(identity, /userConfirmationRequired:\s*true/);
  assert.match(source, /bootstrapDeviceIdentity/,
    '后台匿名身份与 owner 隔离链路仍需保留');

  const normalizeMatch = settings.match(/export function normalizeRunSettings\(value\) \{([\s\S]*?)\n\}/);
  assert.ok(normalizeMatch, 'lib/settings.js must keep normalizeRunSettings');
  const normalizeBody = normalizeMatch[1];
  assert.match(settings, /memoryContext:\s*true/);
  assert.match(settings, /aiSummary:\s*true/);
  assert.match(normalizeBody, /memoryContext:\s*true/);
  assert.match(normalizeBody, /aiSummary:\s*true/);
  assert.doesNotMatch(normalizeBody, /src\.(?:memoryContext|aiSummary)/,
    '旧 storage 中的 false 也必须被归一化回 true');
  const settingFocusBody = methodBody(source, 'setSettingFocus');
  assert.match(source, /const SETTINGS_FOCUS_COUNT = 7;/);
  assert.match(settingFocusBody, /raw % SETTINGS_FOCUS_COUNT/);
  assert.match(methodBody(source, 'setMenuFocus'),
    /const count = this\.todayWorkoutPlan \? MENU_FOCUS_COUNT \+ 1 : MENU_FOCUS_COUNT;[\s\S]*raw % count/);
  assert.match(methodBody(source, 'claimSurfaceDirection'),
    /lastSurfaceDirectionPhase === phase[\s\S]*lastSurfaceDirectionDelta === delta[\s\S]*DIRECTION_REPEAT_DEDUPE_MS[\s\S]*DIRECTION_ALIAS_DEDUPE_MS/);
  assert.equal(
    (
      source.slice(source.indexOf('<view class="feature-nav" role="navigation">'),
        source.indexOf('<view class="settings-screen"'))
        .match(/bindfocus="onMenuFocus"/g) || []
    ).length,
    6,
    '五个固定入口加可选今日训练都必须同步新版宿主焦点，并拒绝迟到回写',
  );
  assert.match(methodBody(source, 'onMenuFocus'), /shouldAcceptHostFocus/);
  assert.match(source,
    /const keys = \[[\s\S]*'stride', 'voice', 'metronome', 'guide', 'binding', 'heart', 'back',[\s\S]*\];/);
  const settingTapBody = stripJsComments(methodBody(source, 'onSettingTap'));
  assert.match(settingTapBody,
    /key\s*===\s*'back'[\s\S]*showFeatureMenu\(\)[\s\S]*menuEntryConfirmGuardUntilMs\s*=\s*Date\.now\(\)\s*\+\s*SURFACE_ENTRY_CONFIRM_GRACE_MS/,
    '设置返回必须回到训练菜单并武装确认尾包保护');
  assert.match(source,
    /claimMenuActivation[\s\S]{0,400}isMenuEntryInputGuarded\(now\)/,
    '训练菜单激活必须消费设置返回后的确认尾包保护');
});

test('设置保持六个 40px 交互行与一个 24px 说明行，并在页头提供可聚焦返回按钮', () => {
  const source = read('pages/run_hud/index.ink');
  const settingsListStart = source.indexOf('<view class="settings-list" role="navigation">');
  const settingsFootStart = source.indexOf('<text class="settings-foot">', settingsListStart);
  assert.ok(settingsListStart >= 0 && settingsFootStart > settingsListStart,
    '设置列表与页脚模板必须存在且顺序稳定');
  const settingsMarkup = source.slice(settingsListStart, settingsFootStart);
  const passiveRow = settingsMarkup.match(/<view class="setting-info"([^>]*)>/);

  assert.equal((settingsMarkup.match(/<button\b/g) || []).length, 7,
    '设置页必须包含六个配置按钮和一个返回按钮');
  assert.equal((settingsMarkup.match(/class="setting-row /g) || []).length, 6,
    '设置页必须保持六个 40px 配置行');
  assert.equal((settingsMarkup.match(/class="setting-info"/g) || []).length, 1,
    '设置页必须只有一个 AI / EverMind 被动说明行');
  assert.match(settingsMarkup,
    /data-setting="stride"[\s\S]*data-setting="voice"[\s\S]*data-setting="metronome"[\s\S]*data-setting="guide"[\s\S]*data-setting="binding"[\s\S]*class="setting-info"[\s\S]*data-setting="heart"[\s\S]*data-setting="back"/,
    '视觉顺序必须为步长、语音、节拍器、指导快速结束、绑定、EverMind 信息、心率及返回');
  assert.ok(passiveRow, 'AI / EverMind 必须使用被动 view');
  assert.doesNotMatch(passiveRow[1], /\b(?:tabindex|role|bindfocus|bindtap)\s*=/,
    '被动 AI / EverMind 行不能注册焦点或点击事件');

  const screenRule = cssBlock(source, '.settings-screen');
  const topRule = cssBlock(source, '.settings-top');
  const listRule = cssBlock(source, '.settings-list');
  const rowRule = cssBlock(source, '.setting-row');
  const infoRule = cssBlock(source, '.setting-info');
  const footRule = cssBlock(source, '.settings-foot');
  const focusedRule = cssBlock(source, '.setting-row.setting-row-focused');
  const backRule = cssBlock(source, '.settings-back');
  const backFocusedRule = cssBlock(source, '.settings-back.setting-row-focused');

  assert.match(screenRule, /padding:\s*12px 14px\s*;/);
  assert.match(topRule, /height:\s*36px\s*;/);
  assert.match(listRule, /height:\s*264px\s*;/);
  assert.match(listRule, /margin:\s*2px 0 0\s*;/);
  assert.match(rowRule, /height:\s*40px\s*;/);
  assert.match(infoRule, /height:\s*24px\s*;/);
  assert.match(backRule, /position:\s*absolute\s*;/);
  assert.match(backRule, /height:\s*32px\s*;/);
  assert.equal(264, 6 * 40 + 24,
    'settings-list 高度必须恰好容纳六个交互行与一个说明行');
  assert.match(footRule, /height:\s*24px\s*;/);
  assert.match(footRule, /margin:\s*2px 0 0\s*;/);
  assert.match(footRule, /line-height:\s*24px\s*;/);
  assert.equal(12 + 36 + 2 + 264 + 2 + 24 + 12, 352,
    '设置页纵向尺寸总和必须恰好落在 480x352 画布内');

  assert.doesNotMatch(rowRule, /\boutline(?:-[a-z-]+)?\s*:/,
    '未聚焦交互行不能常驻焦点框');
  assert.doesNotMatch(infoRule, /\boutline(?:-[a-z-]+)?\s*:/,
    '被动 AI / EverMind 行不能绘制焦点框');
  assert.match(focusedRule, /outline-width:\s*2px\s*;/,
    '只有交互行的 focused modifier 可以绘制焦点框');
  assert.match(backFocusedRule, /outline-width:\s*2px\s*;/);
  assert.match(backFocusedRule, /outline-offset:\s*-2px\s*;/);
  assert.doesNotMatch(
    source.slice(source.indexOf('<style>')),
    /\.setting-info[^,{]*(?:focus|focused)[^{]*\{/,
    '被动 AI / EverMind 行不能拥有可聚焦样式 selector',
  );
});

test('节拍器使用随包 WAV 与 Sound，并覆盖试听、跑步、隐藏、总结和卸载生命周期', () => {
  const source = read('pages/run_hud/index.ink');
  const metronome = read('lib/metronome.js');
  const audio = fs.readFileSync(path.join(ROOT, 'assets/audio/metro_0468.wav'));
  const wav = inspectPcmWav(audio);
  const barWavs = [
    [160, 1225.011],
    [170, 1158.821],
    [180, 1100.000],
  ].map(([bpm, expectedDurationMs]) => {
    const rel = `assets/audio/metro_0468_bar_${bpm}.wav`;
    const bytes = fs.readFileSync(path.join(ROOT, rel));
    return { bpm, expectedDurationMs, rel, bytes, wav: inspectPcmWav(bytes) };
  });
  const settingFocusBody = stripJsComments(methodBody(source, 'setSettingFocus'));
  const settingFocusHandlerBody = stripJsComments(methodBody(source, 'onSettingFocus'));
  const settingTapBody = stripJsComments(methodBody(source, 'onSettingTap'));

  assert.equal(wav.pcmFormat, 1);
  assert.equal(wav.channels, 2, 'metronome WAV must be stereo for the glasses Sound bridge');
  assert.equal(wav.sampleRate, 44100);
  assert.equal(wav.bitsPerSample, 16);
  assert.ok(wav.durationMs >= 175 && wav.durationMs <= 200,
    `metronome WAV duration must be 175-200ms, got ${wav.durationMs}ms`);
  assert.ok(wav.firstAudibleMs != null && wav.firstAudibleMs <= 12,
    `metronome audible transient must begin within 12ms, got ${wav.firstAudibleMs}ms`);
  assert.ok(audio.length > 1000, 'metronome WAV must contain real audio data');
  for (const bar of barWavs) {
    assert.equal(bar.wav.pcmFormat, 1);
    assert.equal(bar.wav.channels, 2, `${bar.bpm} BPM bar must remain stereo`);
    assert.equal(bar.wav.sampleRate, 44100);
    assert.equal(bar.wav.bitsPerSample, 16);
    assert.ok(Math.abs(bar.wav.durationMs - bar.expectedDurationMs) <= 2,
      `${bar.bpm} BPM bar duration drifted: ${bar.wav.durationMs}ms`);
    assert.ok(bar.wav.durationMs >= 1098 && bar.wav.durationMs <= 1227,
      `${bar.bpm} BPM bar must use the 100ms tail-trimmed runtime click`);
    assert.ok(bar.wav.firstAudibleMs != null && bar.wav.firstAudibleMs <= 12,
      `${bar.bpm} BPM bar must begin audibly within 12ms`);
    assert.ok(bar.bytes.length > 1000, `${bar.rel} must contain real audio data`);
    assert.match(source, new RegExp(
      `${bar.bpm}: '\\.\\.\\/\\.\\.\\/assets\\/audio\\/metro_0468_bar_${bar.bpm}\\.wav'`,
    ));
  }
  assert.match(source, /import \{ Sound \} from 'audio';/);
  assert.match(source, /import \{ Metronome \} from '\.\.\/\.\.\/lib\/metronome\.js';/);
  assert.match(source, /const METRONOME_BEATS_PER_PLAYBACK = 4;/);
  assert.match(methodBody(source, 'ensureMetronome'),
    /new Metronome\([\s\S]*SoundCtor:\s*Sound[\s\S]*src:\s*audioSrc[\s\S]*beatsPerPlayback:\s*METRONOME_BEATS_PER_PLAYBACK/);
  assert.match(methodBody(source, 'startRun'), /startRunMetronome\(\)/);
  assert.match(methodBody(source, 'onShow'), /startRunMetronome\(\)/);
  assert.match(methodBody(source, 'onHide'), /stopMetronomePlayback\(\)/);
  assert.match(methodBody(source, 'openDevicePairing'), /stopMetronomePlayback\(\)/);
  for (const name of ['onUnload', 'finalizeRunAfterSummaryCommit', 'closeAgentFromSummary']) {
    assert.match(methodBody(source, name), /stopMetronomePlayback\(\{ destroy: true \}\)/,
      `${name} must destroy the Sound-backed metronome`);
  }
  assert.match(methodBody(source, 'finishRunToSummary'),
    /setData\([\s\S]*summaryFinalizeTimer\s*=\s*setTimeout/,
    'summary must render before it crosses the native Sound cleanup bridge');
  assert.match(methodBody(source, 'stopMetronomePlayback'),
    /metronome\.stop\(\)[\s\S]*options\.destroy === true[\s\S]*metronome\.destroy\(\)/);

  assert.match(settingFocusBody, /next\s*!==\s*2[\s\S]*stopMetronomePlayback\(\)/,
    '焦点离开第 3 项节拍器后必须立即停止试听');
  for (const [name, body] of [
    ['setSettingFocus', settingFocusBody],
    ['onSettingFocus', settingFocusHandlerBody],
  ]) {
    assert.doesNotMatch(body, /startMetronomePreview|startRunMetronome|ensureMetronome/,
      `${name} must not auto-start the metronome when focus enters or returns to index 2`);
    assert.doesNotMatch(body, /writeRunSettings|nextMetronomeBpm|metronomeBpm\s*=/,
      `${name} must not change the persisted metronome BPM while moving focus`);
  }
  assert.match(settingTapBody,
    /key\s*===\s*'metronome'[\s\S]*next\.metronomeBpm\s*=\s*nextMetronomeBpm\([\s\S]*startMetronomePreview\(bpm\)/,
    '只有用户确认切换节拍器档位才能启动试听');
  const persistAt = settingTapBody.indexOf('writeRunSettings');
  const previewAt = settingTapBody.indexOf('startMetronomePreview');
  assert.ok(persistAt >= 0 && previewAt > persistAt,
    '新节拍档位必须先持久化，再启动本次试听');

  for (const token of [
    'new SoundCtor(src)', 'this._sound.play()', 'this._sound.stop()',
    'this._sound.destroy()', 'this._generation', 'clearTimeout(this._timerId)',
    'if (this._destroyed) return false',
  ]) assert.ok(metronome.includes(token), `missing metronome lifecycle token: ${token}`);
});

test('01 是 448x150 单一安全入口，并把多目标选择交给沉浸菜单', () => {
  const source = read('pages/index/index.ink');
  const productVersion = JSON.parse(read('package.json')).version;
  for (const text of ['SmartRun', '自由开跑，智能相伴', '按确认键进入']) {
    assert.ok(source.includes(text));
  }
  assert.ok(source.includes(`homeVersion: 'v${productVersion}'`),
    '首页可见版本号必须与 package.json 产品版本一致');
  assert.match(source,
    /class="home-version-spacer"[\s\S]*class="home-brand-name">跑步教练<\/text>[\s\S]*class="home-version">\{\{ homeVersion \}\}<\/text>/);
  const version = cssBlock(source, '.home-version');
  assert.match(version, /width:\s*64px\s*;/);
  assert.match(version, /font-size:\s*12px\s*;/);
  assert.match(version, /line-height:\s*18px\s*;/);
  assert.doesNotMatch(version, /\bposition\s*:|\btransform\s*:/);
  const versionSpacer = cssBlock(source, '.home-version-spacer');
  assert.match(versionSpacer, /width:\s*64px\s*;/,
    '等宽占位必须抵消版本标签，保持图标与主标题居中');
  assert.doesNotMatch(versionSpacer, /\bposition\s*:|\btransform\s*:/);
  const brand = cssBlock(source, '.home-brand');
  assert.match(brand, /width:\s*420px\s*;/);
  assert.match(brand, /height:\s*34px\s*;/);
  const brandName = cssBlock(source, '.home-brand-name');
  assert.match(brandName, /font-size:\s*30px\s*;/);
  assert.match(brandName, /line-height:\s*34px\s*;/);
  const content = cssBlock(source, '.home-content');
  assert.match(content, /width:\s*444px\s*;/);
  assert.match(content, /height:\s*146px\s*;/);
  assert.match(content, /padding:\s*4px 12px\s*;/);
  const enter = cssBlock(source, '.home-enter');
  assert.match(enter, /width:\s*420px\s*;/);
  assert.match(enter, /height:\s*34px\s*;/);
  assert.match(source, /class="home-enter home-action-focused"[\s\S]*?tabindex="0"[\s\S]*?bindtap="openMenu"/);
  assert.doesNotMatch(source, /home-options|home-option|openSlowRun|openSettings|HOME_FOCUS_COUNT/);
  const focus = cssBlock(source, '.home-enter.home-action-focused');
  assert.match(focus, /outline-width:\s*2px\s*;/);
  assert.match(focus, /outline-style:\s*solid\s*;/);
  assert.match(focus, /outline-color:\s*var\(--color-primary/);
  assert.match(focus, /outline-offset:\s*-2px\s*;/);
  assert.doesNotMatch(focus, /\bborder\s*:/,
    '动态焦点不得通过改变 border 盒模型实现');
  assert.match(source, /const HOME_MENU_ROUTE = RUN_ROUTE \+ '\?mode=menu&inputGuard=1&fromHome=1';/);
  assert.match(source, /wx\.navigateTo\s*\(\s*\{[\s\S]*?url:\s*HOME_MENU_ROUTE\s*,/);
  const homeKeyUp = stripJsComments(source.match(/onKeyUp\(event\) \{([\s\S]*?)\n  \},/)[1]);
  assert.match(homeKeyUp, /code === 'GlobalHook'[\s\S]*preventDefault/);
  assert.doesNotMatch(homeKeyUp, /code === '(?:Enter|NumpadEnter|Space)'/,
    '单一原生按钮的标准确认键必须由宿主 bindtap 激活');
  assert.match(source, /this\.openMenu\(\)/);
  assert.doesNotMatch(source, /code === 'ArrowDown'|code === 'ArrowUp'/,
    '对话流首页不得劫持方向键或直接选择训练模式');
  assert.doesNotMatch(source, /navigator\.bluetooth|destination:/);
});

test('公开仓版本、许可、架构图与 BLE 演示入口保持一致', () => {
  const productVersion = JSON.parse(read('package.json')).version;
  const readme = read('README.md');
  const demo = read('docs/GARMIN_BLE_DEMO.md');
  const license = read('LICENSE');

  assert.ok(readme.includes(productVersion));
  assert.match(readme, /PolyForm Noncommercial 1\.0\.0/);
  assert.match(readme, /docs\/assets\/garmin-ble-running-architecture-handdrawn\.png/);
  assert.match(readme, /docs\/GARMIN_BLE_DEMO\.md/);
  assert.match(demo, /0x180D/);
  assert.match(demo, /0x2A37/);
  assert.match(demo, /0x1814/);
  assert.match(demo, /0x2A53/);
  assert.match(demo, /HRS success does not prove RSC success/);
  assert.match(license, /PolyForm Noncommercial License 1\.0\.0/);
});

test.skip('内部发布文档与设计预览由私有开发仓维护，不属于公开源码快照', () => {
  const productVersion = JSON.parse(read('package.json')).version;

  for (const rel of CURRENT_RELEASE_DOCS) {
    const source = read(rel);
    assert.ok(
      source.includes(productVersion),
      `${rel} must mention current package version ${productVersion}`,
    );
    assert.doesNotMatch(source, /\b0\.1\.(?:77|81)\b/,
      `${rel} must not retain a superseded 0.1.77/0.1.81 release`);
    assert.doesNotMatch(
      source,
      /AISmartRun-AIUI-v0\.1\.(?:77|81)|public-beta-v0\.1\.(?:77|81)/,
      `${rel} must not point to a superseded 0.1.77/0.1.81 artifact`,
    );
  }

  const readme = read('README.md');
  assert.match(readme, /cadence starts at `--` and returns to `--` after 3\.5 seconds/);
  assert.match(
    readme,
    /current cadence is held for only 3\.5 seconds[^.\n]*returns to `--`/,
    'README must explain that live cadence has only a bounded stale hold',
  );
  assert.match(
    readme,
    /post-run average cadence is calculated independently from valid samples/,
    'README must keep summary cadence independent from the live HUD stale state',
  );
  assert.match(
    readme,
    /`running` bout needs three strict[\s\S]*`uncertain` bout[\s\S]*needs four stable/,
    'README must describe the implemented 3-strict / 4-stable activity gate',
  );
  assert.match(
    readme,
    /After activation, every IMU step is still requalified[\s\S]*1800ms without qualified evidence returns the gate to probing/,
    'README must document active-state step requalification',
  );
  assert.match(
    readme,
    /RSC windows integrate bilateral 2A53 cadence[\s\S]*independently of glasses accepted-step counts/,
    'README must document RSC-only stride learning',
  );
  assert.match(
    readme,
    /Distance keeps one authoritative ledger: standard RSC total distance, filtered RSC speed integration, then accepted glasses-IMU steps/,
    'README must document the current RSC-to-IMU distance fallback without GPS',
  );
  assert.match(
    readme,
    /Each run pins the complete public device[\s\S]*Every other owner change invalidates old calibration, stride, live snapshot, summary, LLM and upload callbacks/,
    'README must document the in-flight owner isolation contract',
  );

  const chinesePrd = read('docs/AISmartRun_PRD.md');
  assert.doesNotMatch(
    chinesePrd,
    /曾就绪后[^。\n]{0,80}(?:停步|归零|当前无值)[^。\n]{0,40}(?:显示|变为)\s*`-`/,
    'Chinese PRD must not restore the retired ready-cadence dash contract',
  );
  assert.match(
    chinesePrd,
    /实时步频只短保持 3\.5 秒[^。\n]{0,80}恢复 `--`/,
    'Chinese PRD must describe the bounded live-cadence hold',
  );

  const englishPacker = read('tools/pack_aix_en.mjs');
  const japanesePacker = read('tools/pack_aix_ja.mjs');
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.scripts['build:ja'], 'npm run pack:aix:ja && npm run inspect:aix:ja');
  assert.equal(packageJson.scripts['build:all'], 'npm run build:local && npm run build:en && npm run build:ja');
  assert.equal(packageJson.devDependencies['@yodaos-pkg/aix-cli'], '^0.8.2');
  assert.equal(packageJson.scripts['preview:aix'], 'npm run build:local && node tools/preview_aix.mjs --launch');
  assert.equal(packageJson.scripts['preview:aix:dev'], 'node tools/preview_aix.mjs --source --dev --launch');
  assert.equal(packageJson.scripts['preview:aix:html'], 'npm run build:local && node tools/preview_aix.mjs --html-out tmp/aix-official-preview.html');
  const officialPreviewTool = read('tools/preview_aix.mjs');
  assert.match(officialPreviewTool, /\['preview', input\]/);
  assert.match(officialPreviewTool, /--html-out/);
  assert.match(officialPreviewTool, /PREVIEW_WIDTH\\s\*=\\s\*480/);
  assert.match(officialPreviewTool, /PREVIEW_HEIGHT\\s\*=\\s\*352/);
  assert.match(read('.agents/skills/aiui-dev/SKILL.md'), /## 9\. Global Preview SOP/);
  assert.match(read('AGENTS.md'), /`@yodaos-pkg\/aix-cli`/);
  assert.match(japanesePacker, /--ja/);
  assert.match(englishPacker, /AIX_LOCALES\.ja/);
  assert.match(englishPacker, /JA_TEXT_REPLACEMENTS/);
  assert.match(
    englishPacker,
    /RSC becomes live only after the first valid notification/,
    'English AIX manifest must distinguish RSC subscription from live data',
  );
  assert.match(
    englishPacker,
    /needs three strict accepted-step signals[\s\S]*four cadence-consistent signals/,
    'English AIX manifest must describe the 3-strict / 4-stable activity gate',
  );
  assert.match(
    englishPacker,
    /trusted cadence may be held for at most 3\.5 seconds[\s\S]*live rhythm is stale/,
    'English AIX manifest must describe the bounded live-cadence hold',
  );
  assert.doesNotMatch(
    englishPacker,
    /current zero or unavailable value is shown as \\`-\\`/,
    'English AIX manifest must not restore the old ready-cadence dash',
  );
  assert.match(
    englishPacker,
    /function assertJavaScriptSyntax\([^)]*\)[\s\S]*process\.execPath,\s*\['--check'/,
    'English AIX packer must run node --check for transformed JavaScript',
  );
  assert.match(
    englishPacker,
    /function assertStageJavaScriptSyntax\(\)[\s\S]*assertJavaScriptSyntax\([\s\S]*pages\/run_hud\/index\.ink[\s\S]*assertJavaScriptSyntax\(/,
    'English AIX packer must apply its syntax checker to transformed libraries and page scripts',
  );

  const projectStructure = read('docs/PROJECT_STRUCTURE.md');
  assert.doesNotMatch(
    projectStructure,
    /曾经就绪后[^。\n]{0,80}(?:显示|使用)\s*`-`/,
    'project structure must not restore a dash after cadence readiness',
  );

  const betaReadiness = read('docs/PUBLIC_BETA_READINESS.md');
  assert.doesNotMatch(
    betaReadiness,
    /停步后最多保留\s*5\s*秒最后可信即时配速/,
    'public-beta notes must use the current overall/safe-estimate sticky pace contract',
  );

  const matrix = read('docs/ALPHA_TEST_MATRIX.md');
  assert.doesNotMatch(matrix, /本地 SQLite/);
  assert.doesNotMatch(matrix, /均配一致、无 GPS/);
  assert.match(matrix, /Garmin accepted > 0、AIUI accepted > 0、matched > 0/);
  assert.match(matrix, /RSC_FIRST_PACKET/);
  assert.match(matrix, /旧 scope worker 被取消、磁盘目录被销毁/);

  const preview = read('preview/index.html');
  assert.ok(
    preview.includes(`<span class="version-pill">v${productVersion}</span>`),
    'canonical preview must expose the reviewed product version',
  );
  assert.ok(
    preview.includes(`const VERSION = '${productVersion}';`),
    'canonical preview runtime must use the package version',
  );
  assert.doesNotMatch(preview, /\bv0\.1\.(?:77|81)\b/,
    'preview must not retain the stale 0.1.77/0.1.81 review version');
  assert.doesNotMatch(
    preview,
    /(?:曾|已|首次)?就绪后[^。；\n]{0,40}(?:归零|零值)[^。；\n]{0,24}(?:显示|恢复|变为)\s*[-—]/,
    'trusted HUD values must not regress to a dash after a zero packet',
  );
  assert.match(
    preview,
    /首次形成可信值后[^。；\n]{0,80}仍保留本场可信数值/,
    'preview must explain the current sticky trusted-value HUD behavior',
  );
});

test('02 循环搜索、无条件下一步和 03 HUD 都在同一路由中', () => {
  const source = read('pages/run_hud/index.ink');
  for (const phase of [
    "surfacePhase: 'ready'", "surfacePhase: 'connecting'", "surfacePhase: 'menu'",
    "surfacePhase: 'training'", "surfacePhase: 'settings'", "surfacePhase: 'binding'",
    "surfacePhase: 'hud'", "surfacePhase: 'summary'", "surfacePhase: 'recovery'",
  ]) {
    assert.ok(source.includes(phase));
  }
  assert.doesNotMatch(source, /surfacePhase:\s*'slow-ready'|startSlowRun/,
    '超慢跑必须复用 02 搜索入口，不能另建易误触的准备页');
  assert.match(source, /openSlowMode/);
  assert.match(source, /class="slow-metrics"/);
  assert.match(source, />超慢跑<\/text>/);
  for (const text of [
    '准备开跑', '正在搜索心率设备...', '下一步', '已连接心率设备',
  ]) assert.ok(source.includes(text));
  for (const handler of [
    'openFreeMode', 'openSlowMode', 'openGarminVirtualMode', 'openTrainingMode',
    'openSettingsMode',
  ]) {
    assert.match(source, new RegExp('bindtap="' + handler + '"'),
      `沉浸菜单按钮必须把宿主 bindtap 接入 ${handler} 的统一输入门`);
  }
  const featureMarkup = source.slice(
    source.indexOf('<view class="feature-menu '),
    source.indexOf('<view class="training-screen"'),
  );
  assert.equal((featureMarkup.match(/<button\b/g) || []).length, 6,
    '训练菜单必须保留五个固定入口，并允许一个可选今日训练入口');
  assert.match(featureMarkup, /ink:if="{{ todayWorkoutAvailable }}"/,
    '今日训练入口必须仅在服务端存在当前计划时显示');
  assert.match(featureMarkup, />超慢跑<\/text>/,
    '原地跑入口必须使用面向用户的“超慢跑”名称');
  assert.match(featureMarkup, />室内跑<\/text>/,
    '跑步机入口必须使用面向用户的“室内跑”名称');
  assert.match(featureMarkup, />训练计划<\/text>/,
    '四种本地训练必须通过独立训练计划入口进入');
  assert.doesNotMatch(featureMarkup, /Garmin\s+虚拟跑/,
    '训练菜单不得把具体品牌写进模式名称');
  assert.match(source, /const BLE_READY_FALLBACK_MS = 500/);
  assert.match(source, /scheduleBleReadyFallback/);
  assert.match(source, /PAGE_READY_FALLBACK/);
  // 官方样例无额外周期性 UI 重绘：唯一 ticker 也必须经过与传感器事件
  // 共用的限频门，不能在录屏浮层饿死 timer 后让 HUD 长期停留占位。
  // 只检查 startTicker 方法，避免把后续相邻方法中的合法 setData 误算为 interval 回调体。
  const ticker = source.match(/startTicker\(\)\s*\{[\s\S]*?\n\s*\},\n\n\s*stopTicker/)[0];
  assert.match(ticker,
    /setInterval\(\(\) => this\.requestRunTick\('timer'\), TICK_MS\)/);
  assert.doesNotMatch(ticker, /setData\(/);
  const signalTicker = stripJsComments(methodBody(source, 'requestRunTick'));
  assert.match(signalTicker, /this\.tick\(\)/);
  assert.doesNotMatch(signalTicker, /setInterval\(|setData\(/);
  assert.doesNotMatch(source, /CONNECT_DEADLINE_MS|MAX_AUTO_BLE_ATTEMPTS/);
  // 真机焦点登记要求 navigation 容器静态:字面量 class、无 ink:if、只包主按钮。
  // 主按钮的 Enter/NumpadEnter/Space 走宿主原生 bindtap；动态设备列表留在
  // navigation 容器外，候选焦点与 GlobalHook fallback 仍由页面统一接管。
  assert.match(source, /<view class="container" ink:if="\{\{ surfacePhase === 'ready' \|\| surfacePhase === 'connecting' \}\}">/);
  const searchNav = source.match(/<view class="connect-next-nav" role="navigation">([\s\S]*?)<\/view>/);
  assert.ok(searchNav, '02 主按钮必须拥有静态 navigation 容器');
  assert.equal((searchNav[1].match(/<button\b/g) || []).length, 1,
    '02 navigation 容器只能包含一个主按钮');
  assert.match(searchNav[1], /class="primary-button \{\{ searchPrimaryClass \}\}"[\s\S]*tabindex="0"[\s\S]*bindfocus="onSearchFocus"[\s\S]*bindtap="onScanTap"/);
  assert.match(source, /class="device-row \{\{ item\.deviceSelectedClass \}\} \{\{ item\.deviceFocusClass \}\}"/,
    '设备选中态和焦点态必须作为独立单 token modifier 绑定');
  assert.doesNotMatch(source, /<view class="list-card"[^>]*role="navigation"/);
  assert.match(cssBlock(source, '.primary-button'), /border:\s*0\s*;/);
  for (const selector of [
    '.feature-secondary.feature-focused', '.setting-row.setting-row-focused',
    '.primary-button.search-target-focused', '.device-row.device-row-focused',
  ]) {
    const focusRule = cssBlock(source, selector);
    assert.match(focusRule, /outline-width:\s*2px\s*;/, `${selector} must draw a focus outline`);
    assert.match(focusRule, /outline-style:\s*solid\s*;/);
    assert.match(focusRule, /outline-color:\s*var\(--color-primary/);
    assert.match(focusRule, /outline-offset:\s*-2px\s*;/);
    assert.doesNotMatch(focusRule, /\bborder\s*:/,
      `${selector} must not resize the focused button border box`);
  }
  assert.doesNotMatch(cssBlock(source, '.device-row-selected'), /\bborder\s*:/,
    '已选设备只能用非边框视觉状态表达');
  // 主按钮变身:搜到设备后原地变"下一步",焦点无需移动
  assert.match(source, /primaryLabel: '开始搜索'/);
  assert.match(source, /primaryLabel: '下一步'/);
  // 单按钮流:扫描启动即变"下一步",不再有第二个下一步按钮
  assert.doesNotMatch(source, /secondary-button/);
  assert.match(source, /\|\| this\.data\.bleState === 'scanning'[\s\S]{0,120}return this\.onConnectTap\(\);/);
  assert.match(source, /setSearchFocus/);
  assert.match(source, /activateSearchFocused/);
  assert.match(source, /<text class="hint beacon-hint" ink:if="\{\{ keyBeacon \}\}">\{\{ keyBeacon \}\}<\/text>/);
  for (const manualText of ['开始搜索', '单击开始搜索心率设备', '未搜索']) {
    assert.ok(source.includes(manualText), `missing manual-start copy: ${manualText}`);
  }
  assert.doesNotMatch(source, /role="navigation"[^>]*ink:if|ink:if[^>]*role="navigation"/);
  assert.doesNotMatch(source, /class="\{\{[^"]*\}\}"[^>]*role="navigation"/);
  assert.match(source, /keyBeacon/);
  assert.doesNotMatch(source, /<scroll-view/);
  assert.match(source, /ink:for="\{\{ discoveredDevices \}\}"[\s\S]{0,80}ink:key="deviceId"/);
  assert.match(source, /discoveredDeviceCount/);
  assert.match(source, /recordDiscoveredDevice/);
  assert.match(source, /startDiscovery/);
  assert.match(source, /selectDevice/);
  assert.match(source, /scanProgressText/);
  assert.match(source, /rawAdvertisementCount/);
  assert.match(source, /\{\{ searchChip \}\} · \{\{ scanProgressText \}\}/);
  assert.doesNotMatch(source, /navigator\.bluetooth\.getDevices|findRememberedBleDevice/);
  assert.doesNotMatch(source, /<view class="[^"]*connect-next[^"]*"[^>]*tabindex=/);
  const onConnectBlock = methodBody(source, 'onConnectTap');
  assert.match(onConnectBlock,
    /preRunRequiredAfterSearch === true[\s\S]*autoConnectBestCandidate\(\{ scanAlreadyStopped: true \}\)[\s\S]*return this\.startPreRunGuide\(\)/,
    '菜单流程的下一步必须先停扫并进入跑前热身');
  assert.match(onConnectBlock,
    /this\.autoConnectBestCandidate\(\);[\s\S]*return this\.proceedToHud\(\)/,
    '诊断深链仍可保留直接进入 HUD 的兼容路径');
  // 02 候选方向键与 GlobalHook 由页面提供替代动作；主按钮的标准确认键保持
  // Native Single-Action，不在 keyup 中拦截或手动激活。04 Backspace 明确关闭。
  const keyDownBlock = methodBody(source, 'onKeyDown');
  const keyUpBlock = source.match(/onKeyUp\(event\) \{([\s\S]*?)\n  \},/)[1];
  const keyUpCode = stripJsComments(keyUpBlock);
  const directionCodeBody = methodBody(source, 'isSurfaceDirectionCode');
  const directionHandlerBody = methodBody(source, 'handleSurfaceDirection');
  // Standard confirm keys must not manually activate the single native search
  // button from keyup. Other phases may still update defensive copy (for
  // example HUD Backspace resets the three-confirm progress).
  assert.doesNotMatch(keyUpCode, /proceedToHud|onScanTap|onConnectTap/);
  assert.match(directionCodeBody, /ArrowUp[\s\S]*ArrowDown[\s\S]*ArrowLeft[\s\S]*ArrowRight/);
  assert.match(keyDownBlock,
    /isSurfaceDirectionCode[\s\S]*canHandleSurfaceDirection[\s\S]*DIRECTION_KEYDOWN/,
    'keydown may record diagnostics but must not commit page focus');
  assert.doesNotMatch(keyDownBlock,
    /handleSurfaceDirection|setMenuFocus|setSettingFocus|setBindingFocus|setSearchFocus/,
    'directional focus must not move before keyup');
  assert.match(keyUpBlock,
    /isSurfaceDirectionCode[\s\S]*preventDefault[\s\S]*handleSurfaceDirection\(code, Date\.now\(\), 'keyup'\)/,
    'keyup must prevent host defaults and remain the only direction commit point');
  assert.doesNotMatch(source, /surfaceDirectionDownClaims|DIRECTION_KEYUP_CONSUMED/,
    'focus-session churn must not revive the old keydown/keyup pairing state machine');
  assert.doesNotMatch(methodBody(source, 'onHostBlur'), /clearSurfaceDirectionBurst/,
    'host blur during one physical swipe must preserve direction de-duplication history');
  assert.match(directionHandlerBody,
    /clearPendingSurfaceGlobalHook\(\)[\s\S]*DIRECTION_RELEASE_GUARD_MS[\s\S]*setBindingFocus[\s\S]*setSearchFocus/,
    'shared direction handler must cancel pending tap activation and cover binding/search focus');
  assert.match(keyUpBlock, /Enter[\s\S]*NumpadEnter[\s\S]*Space[\s\S]*GlobalHook/);
  const nativeSearchPrimary = keyUpCode.indexOf("if (isSurfaceConfirm && code !== 'GlobalHook'");
  const searchFallback = keyUpCode.indexOf('if (isSurfaceConfirm', nativeSearchPrimary + 1);
  const fallbackPreventDefault = keyUpCode.indexOf('preventDefault', searchFallback);
  const fallbackActivation = keyUpCode.indexOf('activateMultiTargetFocused', searchFallback);
  assert.ok(nativeSearchPrimary >= 0, '02 must preserve a native standard-key branch');
  assert.match(
    keyUpCode.slice(nativeSearchPrimary, searchFallback),
    /isSearchPhase\(\)\s*&&\s*this\.searchFocusIndex\s*===\s*0[\s\S]*?\)\s*return;/,
    '02 primary Enter/NumpadEnter/Space must return without preventing or manually activating',
  );
  assert.doesNotMatch(
    keyUpCode.slice(nativeSearchPrimary, searchFallback),
    /surfacePhase === 'binding'/,
    '双目标绑定页不能误走搜索页 Native Single-Action 分支',
  );
  assert.ok(searchFallback > nativeSearchPrimary);
  assert.ok(fallbackPreventDefault > searchFallback,
    'GlobalHook/candidate fallback must replace the host action');
  assert.ok(fallbackActivation > fallbackPreventDefault,
    'GlobalHook/candidate fallback must reuse the page-owned multi-target activator');
  const multiTargetActivator = source.match(/activateMultiTargetFocused\(\) \{([\s\S]*?)\n  \},/)[1];
  const multiTargetSurface = methodBody(source, 'isMultiTargetSurface');
  assert.match(multiTargetSurface, /surfacePhase === 'binding'/,
    '绑定页必须加入多目标手势判别');
  assert.match(multiTargetActivator,
    /surfacePhase === 'binding'[\s\S]*bindingFocusIndex === 1[\s\S]*onBindingExportTap\(\)[\s\S]*onBindingActionTap\(\)/,
    '稳定确认必须只执行绑定页当前焦点对应的刷新或导出');
  assert.match(multiTargetActivator, /isSearchPhase\(\)[\s\S]*activateSearchFocused\(\)/,
    'the shared activator must delegate search candidates to activateSearchFocused');
  assert.match(source, /const GLOBAL_HOOK_DISAMBIGUATE_MS = 600/);
  assert.match(source, /const DIRECTION_RELEASE_GUARD_MS = 600/);
  assert.match(keyUpBlock,
    /code === 'GlobalHook' && isMultiTarget[\s\S]*deferSurfaceGlobalHook\(Date\.now\(\)\)/,
    'multi-target GlobalHook must be delayed until the gesture is known to be a tap');
  assert.match(directionHandlerBody,
    /clearPendingSurfaceGlobalHook\(\)[\s\S]*DIRECTION_RELEASE_GUARD_MS/,
    'a following direction event must cancel the pending GlobalHook activation');
  assert.match(keyUpBlock, /Backspace/);
  assert.match(keyUpBlock, /isSummaryPhase\(\)[\s\S]*preventDefault[\s\S]*closeAgentFromSummary/);
  assert.match(source, /isSummaryPhase\(\)[\s\S]*summaryEnteredAtMs != null/,
    'summary input routing must not depend only on delayed setData state');
  assert.match(source,
    /proceedToHud\(options = \{\}\)[\s\S]*return this\.finishEntry\(this\.surfaceGeneration, options\)/);
  assert.match(source, /valid BPM|有效通知|showConnectedResult/);
  assert.doesNotMatch(source, /wx\.(?:navigateTo|redirectTo)\([^)]*run_hud/);
});

test('BLE 在 02 interactive 后循环搜索，下一步不依赖结果并支持记住稳定 ID', () => {
  const source = read('pages/run_hud/index.ink');
  // 官方样例同构:生命周期不自动扫描,手势直达 scanDevices,零编排层。
  assert.doesNotMatch(source, /startInteractiveBleFlow|autoConnectBle|scheduleAutoConnectBle|scheduleBleRetry/);
  assert.doesNotMatch(source, /awaitBleHostCall|hasPendingBleHostCall|blockBleForGeneration/);
  assert.doesNotMatch(source, /orderedScanCandidates|connectVerifiedCandidates|BLE_CANDIDATE_LIMIT/);
  // 扫描前绝不预探测 getAvailability(样例心率页从不预探测)
  assert.doesNotMatch(source, /navigator\.bluetooth\.getAvailability/);
  assert.match(source, /ensureBleAvailable/);
  // 参数是每次调用新建的 hr-filter 字面量;冻结/共享对象过桥可能被宿主拒绝
  assert.match(source, /navigator\.bluetooth\.scanDevices\(\{\s*filters: \[\{ services: \['heart_rate'\] \}\],\s*\}\)/);
  assert.doesNotMatch(source, /Object\.freeze\(\{\s*(?:filters|acceptAllDevices)/);
  assert.doesNotMatch(source, /\boptionalServices\s*:/);
  assert.equal((source.match(/\bfilters\s*:/g) || []).length, 1,
    'heart_rate must stay the only scan filter');
  for (const token of [
    'scanDiagnostic',
    '[SmartRun BLE]',
    'SCAN_REQUEST',
    'SCAN_ACTIVE',
    'DEVICE_FOUND',
    'SCAN_STOPPED',
    '等待附近设备广播',
    '单击“下一步”使用眼镜估算',
    '当前无法搜索蓝牙设备',
    '单击“下一步”继续',
    '搜索失败，可使用眼镜估算',
    '正在连接心率设备',
    '点按设备重试',
  ]) assert.ok(source.includes(token), `missing BLE diagnostic token: ${token}`);
  assert.match(source, /<text class="hint" ink:if="\{\{ discoveredDeviceCount === 0 \}\}">\{\{ scanDiagnostic \}\}<\/text>/);
  assert.match(source, /scanDiagnostic:\s*'单击“下一步”使用眼镜估算'/);
  assert.match(source, /const HR_MEASUREMENT_UUID = '00002a37-0000-1000-8000-00805f9b34fb'/);
  // GATT 链路与官方样例逐行同序:connect → 180D → 2A37 → listener → notify
  const gattConnect = source.indexOf('await device.gatt.connect()');
  const serviceLookup = source.indexOf("await server.getPrimaryService('heart_rate')", gattConnect);
  const characteristicLookup = source.indexOf('await service.getCharacteristic(HR_MEASUREMENT_UUID)', serviceLookup);
  const notificationListener = source.indexOf("characteristic.addEventListener('characteristicvaluechanged', listener)", characteristicLookup);
  const notificationStart = source.indexOf('await characteristic.startNotifications()', notificationListener);
  assert.ok(gattConnect >= 0 && serviceLookup > gattConnect
    && characteristicLookup > serviceLookup && notificationListener > characteristicLookup
    && notificationStart > notificationListener,
  'GATT sequence must match the official AIUI heart-rate sample');
  // 设备行 = 可点按钮,手动点选后记住(样例 selectDevice 语义)
  assert.match(source, /bindtap="selectDevice"/);
  assert.match(source, /data-id="\{\{ item\.deviceId \}\}"/);
  assert.match(source, /writeHeartRateDevice\(wx, device\)/);
  const onLoadBody = source.match(/onLoad\([^)]*\)\s*\{([\s\S]*?)\n\s*\},\n\n\s*isSearchPhase/)[1];
  assert.doesNotMatch(onLoadBody, /scanDevices|getDevices/);
  const showConnected = source.match(/showConnectedResult\([^)]*\)\s*\{([\s\S]*?)\n\s*\},/)[1];
  assert.doesNotMatch(showConnected, /finishEntry/);
  assert.match(source, /hasFreshConnectedEntryBpm\([\s\S]*HR_STALE_MS/);
  assert.match(source, /scheduleHrWatchdog\(\)[\s\S]*onBleDropped\(reason, firstPacketFailure \? 'wd0' : 'wd'\)/);
  assert.match(source, /teardownBle\(\)[\s\S]*pendingEntryBpm = null/);
});

test('03 HUD 贴底，单眼镜和心率版的配速都在最右侧', () => {
  const source = read('pages/run_hud/index.ink');
  const runScreen = cssBlock(source, '.run-screen');
  assert.match(runScreen, /justify-content:\s*flex-end\s*;/);

  const unified = source.slice(
    source.indexOf('<view class="unified-grid"'),
    source.indexOf('<view class="glasses-grid"'),
  );
  assert.ok(unified.lastIndexOf('>配速</text>') > unified.lastIndexOf('>时长</text>'));
  const glasses = source.slice(
    source.indexOf('<view class="glasses-grid"'),
    source.indexOf('<view class="slow-metrics"'),
  );
  assert.ok(glasses.lastIndexOf('>配速</text>') > glasses.lastIndexOf('>时长</text>'));
  const slow = source.slice(
    source.indexOf('<view class="slow-metrics"'),
    source.indexOf('</view>\n        <text class="slow-coach"'),
  );
  assert.match(slow, />步频<\/text>/);
  assert.match(slow, />步数<\/text>/);
  assert.doesNotMatch(slow, />配速<\/text>|>距离<\/text>/,
    '超慢跑 HUD 不得展示原地运动不存在的配速或距离');

  const unifiedCadence = unified.match(
    /<text class="([^"]*)">\{\{\s*cadence\s*\}\}<\/text>/,
  );
  const glassesCadence = glasses.match(
    /<text class="([^"]*)">\{\{\s*cadence\s*\}\}<\/text>/,
  );
  assert.ok(unifiedCadence, '心率版 HUD 必须渲染步频数值');
  assert.ok(glassesCadence, '单眼镜版 HUD 必须渲染步频数值');
  assert.equal(unifiedCadence[1], 'run-value',
    '心率版步频只使用 28px 基础字号，不得绑定动态缩放 class');
  assert.equal(glassesCadence[1], 'run-value run-value-big',
    '单眼镜版步频只使用 34px 大字号，不得绑定动态缩放 class');

  assert.match(cssBlock(source, '.unified-grid'),
    /grid-template-columns:\s*14px 68px 60px 80px 94px 115px\s*;/);
  assert.match(cssBlock(source, '.glasses-grid'),
    /grid-template-columns:\s*84px 92px 116px 149px\s*;/);
  assert.match(cssBlock(source, '.run-value'),
    /font-size:\s*28px\s*;/);
  const largeValue = source.match(
    /\.run-value-hero,\s*\.run-value-big\s*\{([\s\S]*?)\}/,
  );
  assert.ok(largeValue, 'HUD 必须保留大字号数值样式');
  assert.match(largeValue[1], /font-size:\s*34px\s*;/);
  assert.ok(unified.indexOf('class="zone"') < unified.indexOf('>心率</text>'));
  assert.match(unified, /\{\{ dot5 \}\}[\s\S]*\{\{ dot1 \}\}/);
  assert.match(cssBlock(source, '.zone'), /width:\s*14px\s*;/);
  assert.match(cssBlock(source, '.dot'), /width:\s*10px\s*;[\s\S]*height:\s*6px\s*;/);
  const metric = cssBlock(source, '.run-metric');
  assert.match(metric, /border:\s*0\s*;/);
  assert.match(metric, /border-radius:\s*0\s*;/);
  assert.match(metric, /background-color:\s*transparent\s*;/);
  assert.match(source, /hudHint:\s*''/);
  assert.match(source, /safetyHudHint:\s*''/);
  assert.match(source, /runWarmupHint:\s*''/);
  assert.match(source, /const RUN_STABILIZE_HINT = '请稳定跑约 5 秒';/);
  assert.match(source, /const RUN_STABILIZE_MIN_MS = 5000;/);
  assert.doesNotMatch(source, /扫描已停止 · 确认键结束/);
  assert.match(source, /class="mode-chip" ink:if="\{\{ runWarmupHint && !safetyHudHint && !hudHint \}\}">\{\{ runWarmupHint \}\}<\/text>/);
  assert.match(source, /class="mode-chip" ink:if="\{\{ !runWarmupHint && !paceConnected && !safetyHudHint && !hudHint \}\}">\{\{ motionSourceHint \}\}<\/text>/);
  assert.match(source, /class="mode-chip" ink:if="\{\{ !runWarmupHint && paceConnected \}\}">配速接入<\/text>/);
  assert.match(source, /motionSourceHint:\s*'眼镜估算'/);
  assert.match(source,
    /const motionSourceHint = this\.isSlowJogMode\(\) \? '超慢跑' : '眼镜估算';/);
  assert.match(source, /if\s*\(cadenceReady\)\s*this\.cadenceEverReady\s*=\s*true;/);
  assert.match(source,
    /const cadenceVal\s*=\s*Number\.isFinite\(stickyCadenceSpm\)\s*&&\s*stickyCadenceSpm\s*>\s*0\s*\?\s*formatCadence\(stickyCadenceSpm\)\s*:\s*CADENCE_PENDING;/,
    '启动前或实时节奏超过 3.5 秒未更新时显示 --，短保持期间继续显示可信数字');
  assert.match(source, /cadence:\s*cadenceVal/);
  assert.doesNotMatch(source, /cadence:\s*(?:0|'0'|"0"|String\(\s*dispCadence\s*\))/,
    'HUD 不得把当前零步频直接渲染为 0');
  assert.doesNotMatch(source, /source-note|pace-chip/);
  assert.match(source, /<view class="summary-wrap" ink:if="\{\{ surfacePhase === 'summary' \}\}">/);
});

test('搜索特效只复用 1 秒状态循环，不使用 keyframes/animation/gradient', () => {
  const banned = /@keyframes|\banimation(?:-name)?\s*:|linear-gradient|radial-gradient/i;
  for (const rel of PAGE_FILES) {
    const source = read(rel);
    assert.doesNotMatch(source, banned, `${rel} must remain static`);
    const hex = source.match(/#[0-9a-f]{6}/ig) || [];
    assert.ok(hex.every((color) => ['#000000', '#40ff5e'].includes(color.toLowerCase())));
  }
  const run = read('pages/run_hud/index.ink');
  assert.equal((run.match(/setInterval\(/g) || []).length, 1, '只允许 ticker 一个业务循环(样例无周期任务)');
  // 官方样例无任何 transition/动效;02 克隆后页面为全静态
  assert.equal((run.match(/\btransition\s*:/g) || []).length, 0);
  assert.doesNotMatch(read('pages/index/index.ink'), /\btransition\s*:/);
});

test('Backspace 契约:02 按来源返回，HUD 不绕过三确认，完成后可选总结或关闭智能体', () => {
  const home = read('pages/index/index.ink');
  const homeBranch = home.match(/if \(code === 'Backspace'\) \{([\s\S]*?)\n\s*\}/);
  assert.ok(homeBranch);
  assert.doesNotMatch(homeBranch[1], /preventDefault|navigateTo|navigateBack|redirectTo/);

  const run = read('pages/run_hud/index.ink');
  const keyUp = stripJsComments(run.match(/onKeyUp\(event\) \{([\s\S]*?)\n  \},/)[1]);
  assert.match(keyUp, /isSummaryPhase\(\)[\s\S]*preventDefault[\s\S]*closeAgentFromSummary/);
  assert.match(keyUp, /surfacePhase === 'binding'[\s\S]*preventDefault[\s\S]*showSettingsFromBinding/);
  assert.match(keyUp, /surfacePhase === 'hud'[\s\S]*preventDefault[\s\S]*resetHudEndConfirmation[\s\S]*请按确认键3次结束/);
  assert.doesNotMatch(
    keyUp.match(/if \(code === 'Backspace'\) \{([\s\S]*?)\n    \}/)?.[1] || '',
    /finishRunToRecovery/,
  );
  assert.match(keyUp, /surfacePhase === 'hud' && this\.data\.running[\s\S]*preventDefault[\s\S]*onHudConfirmKey/);
  assert.match(keyUp, /markHostBackspaceIntent\(wx, 'run_hud'\)/,
    '02 与功能菜单仍由宿主默认返回');
  assert.doesNotMatch(keyUp, /navigateTo|navigateBack|redirectTo/);
  assert.match(run, /closeAgentFromSummary\([^)]*\)[\s\S]*agentExitTimer = setTimeout[\s\S]*beginTerminalBleCleanup\(\)/);
  assert.match(run, /dispatchAgentExit\(\)[\s\S]*wx\.exitMiniProgram\(\{\}\)/);
  assert.equal((run.match(/wx\.exitMiniProgram\(\{\}\)/g) || []).length, 1);
  assert.match(run, /const SUMMARY_EXIT_COPY = '按返回键结束并关闭智能体';/);
  assert.match(run, /summaryExitText:\s*SUMMARY_EXIT_COPY/);
  assert.match(run, /surfacePhase === 'summary'[\s\S]*ArrowDown[\s\S]*startRecoveryGuide\(\)/);
  assert.match(run, /finishRunToRecovery\(\)[\s\S]*finishRunToSummary\(\)[\s\S]*startRecoveryGuide\(\)/);
  assert.match(run, /recoveryChoiceVisible:\s*!preRun/);
  assert.match(run, /查看跑步总结<\/button>/);
  assert.match(run, /结束退出<\/button>/);
  assert.match(run, /closeAgentFromSummary\('recovery-skip-summary'\)/);
  assert.match(
    run,
    /<view class="recovery-wrap" ink:if="\{\{ surfacePhase === 'recovery' \|\| surfacePhase === 'pre_run' \}\}">/,
    '跑前热身与跑后恢复应复用同一套定时指导画布',
  );
  assert.match(run, /onSummaryConfirmKey\([^)]*\)[\s\S]*closeAgentFromSummary\('summary-double-confirm'\)/);
  assert.match(run, /closeAgentFromSummary\('summary-double-tap'\)/);
  assert.match(run, /HUD_CONFIRM_REQUIRED_COUNT = 3/);
  assert.match(run, /HUD_CONFIRM_INDEPENDENT_GAP_MS = 600/);
  assert.match(run, /再按2次结束/);
  assert.match(run, /再按1次结束/);
  assert.match(run, /writeScanExitHint\(wx\)/);
  assert.match(run, /前后划选择 · 单击执行/);
  assert.match(run, /返回键回首页 · 双击退出智能体/);
});

test('发布描述和权限按四屏产品最小化，并明确不申请眼镜定位', () => {
  const pkg = JSON.parse(read('package.json'));
  const app = JSON.parse(read('app.json'));
  const agents = read('AGENTS.md');
  assert.ok(pkg.description.length > 0);
  assert.ok(Buffer.byteLength(pkg.description, 'utf8') <= 200);
  assert.ok(pkg.description.split(/\s+/).length <= 200);
  assert.ok(agents.includes(pkg.description));
  const permissions = agents.match(/- \*\*Permissions\*\*:\s*\n((?:\s+-[^\n]+\n?)+)/)[1]
    .trim().split(/\n/).map((line) => line.trim().replace(/^-\s*/, ''));
  assert.deepEqual(permissions, [
    'bluetooth',
    'accelerometer',
    'gyroscope',
    'audio',
    'network',
  ]);
  assert.deepEqual(app.permissions, []);
  assert.match(agents, /`app\.json` 不申请定位权限/);
  assert.doesNotMatch(
    agents,
    /pages\/(?:bluetooth|settings|coach|hr_card)\/index|SpeechRecognition|\n\s*- microphone/,
  );
  assert.match(agents, /总结阶段可用 `LanguageModel` 原位升级点评/);
});
