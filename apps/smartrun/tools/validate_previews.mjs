import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREVIEW_REL = 'preview/index.html';
const PREVIEW_PNG_REL = 'preview/index.png';
const RUN_HUD_REL = 'pages/run_hud/index.ink';
const WARMUP_GUIDE_REL = 'lib/warmup_guide.js';
const RECOVERY_GUIDE_REL = 'lib/recovery_guide.js';
const SETTINGS_REL = 'lib/settings.js';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fail(errors, message) {
  errors.push(message);
  console.error(`MISS ${message}`);
}

function readRequired(errors, rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    fail(errors, `${rel} missing`);
    return '';
  }
  return fs.readFileSync(abs, 'utf8');
}

function extractRule(text, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  return match ? match[1] : '';
}

function expectRule(errors, source, selector, declarations, message) {
  const rule = extractRule(source, selector);
  if (!rule || !declarations.test(rule)) fail(errors, message);
}

function extractMethodBody(text, methodName) {
  const start = text.indexOf(`  ${methodName}(`);
  if (start < 0) return '';
  const paramsStart = text.indexOf('(', start);
  if (paramsStart < 0) return '';
  let paramsDepth = 0;
  let paramsQuote = '';
  let paramsEscaped = false;
  let paramsEnd = -1;
  for (let i = paramsStart; i < text.length; i += 1) {
    const char = text[i];
    if (paramsQuote) {
      if (paramsEscaped) paramsEscaped = false;
      else if (char === '\\') paramsEscaped = true;
      else if (char === paramsQuote) paramsQuote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      paramsQuote = char;
      continue;
    }
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        paramsEnd = i;
        break;
      }
    }
  }
  if (paramsEnd < 0) return '';
  const bodyStart = text.indexOf('{', paramsEnd);
  if (bodyStart < 0) return '';
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = bodyStart; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(bodyStart + 1, i);
    }
  }
  return '';
}

function checkPng(errors, rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    fail(errors, `${rel} missing`);
    return;
  }
  const stat = fs.statSync(abs);
  if (stat.size < 20_000) fail(errors, `${rel} is too small (${stat.size} bytes)`);
  const signature = fs.readFileSync(abs).subarray(0, PNG_SIGNATURE.length);
  if (!signature.equals(PNG_SIGNATURE)) fail(errors, `${rel} is not a PNG`);
}

const errors = [];
const packageSource = readRequired(errors, 'package.json');
let productVersion = '';
try {
  productVersion = String(JSON.parse(packageSource).version || '').trim();
} catch (_error) {
  fail(errors, 'package.json must contain a valid version');
}

const preview = readRequired(errors, PREVIEW_REL);
const runHud = readRequired(errors, RUN_HUD_REL);
const warmupGuide = readRequired(errors, WARMUP_GUIDE_REL);
const recoveryGuide = readRequired(errors, RECOVERY_GUIDE_REL);
const settings = readRequired(errors, SETTINGS_REL);

// Only product-flow HTML files at preview root compete with the canonical
// review harness. Locale store collateral is intentionally isolated under its
// own directory and the Japanese listing sheet has no runtime controls.
const previewHtmlFiles = fs.readdirSync(path.join(ROOT, 'preview'))
  .filter((name) => name.endsWith('.html') && !/-store-review\.html$/.test(name));
if (previewHtmlFiles.length !== 1 || previewHtmlFiles[0] !== 'index.html') {
  fail(errors, `preview must expose only index.html; found ${previewHtmlFiles.join(', ')}`);
}

if (preview) {
  if (!productVersion
      || !preview.includes(`<span class="version-pill">v${productVersion}</span>`)
      || !preview.includes(`const VERSION = '${productVersion}';`)) {
    fail(errors, `${PREVIEW_REL} must match package version v${productVersion || '?'}`);
  }

  if (/\p{Extended_Pictographic}/u.test(preview)) {
    fail(errors, `${PREVIEW_REL} contains unsupported emoji`);
  }
  for (const pattern of [/@keyframes\b/i, /\banimation(?:-[a-z-]+)?\s*:/i, /\b(?:linear|radial|conic)-gradient\s*\(/i]) {
    if (pattern.test(preview)) fail(errors, `${PREVIEW_REL} contains forbidden visual motion (${pattern})`);
  }

  expectRule(
    errors,
    preview,
    '.surface.compact',
    /\bwidth:\s*448px;[\s\S]*\bheight:\s*150px;/,
    'conversation preview must be exactly 448x150',
  );
  expectRule(
    errors,
    preview,
    '.surface.immersive',
    /\bwidth:\s*480px;[\s\S]*\bheight:\s*352px;/,
    'immersive preview must be exactly 480x352',
  );
  if (!preview.includes('data-jump="home-current"')
      || !preview.includes('data-jump="home-blank"')
      || !preview.includes("homeTarget: '_current'")
      || !preview.includes("state.homeTarget === '_blank'")
      || !preview.includes('data-preview-target="${state.homeTarget}"')) {
    fail(errors, 'Home preview must expose explicit _current 448x150 and _blank 480x352 design states');
  }
  expectRule(
    errors,
    preview,
    '.home-screen.target-blank',
    /\bwidth:\s*448px;[\s\S]*\bheight:\s*352px;/,
    'blank-target Home preview must keep a 448px safe area inside the 480x352 host',
  );
  expectRule(
    errors,
    preview,
    '.host',
    /\bjustify-content:\s*flex-end;[\s\S]*\bflex-direction:\s*column;/,
    'host must bottom-align the compact Home surface',
  );
  expectRule(
    errors,
    preview,
    '.action.focused',
    /outline-width:\s*2px;[\s\S]*outline-style:\s*solid;[\s\S]*outline-color:\s*var\(--green\);[\s\S]*outline-offset:\s*-2px;/,
    'focused targets must use the AIUI-safe long-form outline',
  );
  if (/\bborder\s*:/.test(extractRule(preview, '.surface'))) {
    fail(errors, 'preview surface must not draw an outer canvas border');
  }

  const requiredFlowMarkers = [
    'data-screen="01"',
    'data-state="home"',
    'data-state="menu"',
    'data-state="training"',
    'data-state="settings"',
    'data-state="binding"',
    'data-screen="02"',
    'data-screen="03"',
    'data-screen="04"',
    'data-state="${state.screen}-${step.id}"',
    'data-state="closed"',
  ];
  for (const marker of requiredFlowMarkers) {
    if (!preview.includes(marker)) fail(errors, `${PREVIEW_REL} missing ${marker}`);
  }

  const menuOrder = ['自由跑', '超慢跑', '室内跑', '训练计划', '设置'];
  let previousMenuIndex = -1;
  for (const copy of menuOrder) {
    const index = preview.indexOf(`title: '${copy}'`);
    if (index <= previousMenuIndex) fail(errors, `menu order is missing or wrong at ${copy}`);
    previousMenuIndex = index;
  }
  if (!preview.includes("{ id: 'today', title: '今日训练'")) {
    fail(errors, 'preview must expose optional server Today Training first');
  }

  for (const copy of ['轻松跑', 'LSD 长距离跑', '法特莱克跑', '间歇跑', '返回训练菜单']) {
    if (!preview.includes(copy)) fail(errors, `training flow missing ${copy}`);
  }
  for (const copy of ['估算步长', '语音提示', '节拍器', '指导快速结束', '智能体绑定', '心率搜索', '记忆使用 EverMind']) {
    if (!preview.includes(copy)) fail(errors, `settings flow missing ${copy}`);
  }
  if (!preview.includes("['0.55m', '0.65m', '0.75m', '0.85m', '0.95m', '1.05m', '1.15m', '1.25m', '1.35m', '1.45m']")) {
    fail(errors, 'preview must mirror all ten stride options');
  }

  if (!preview.includes("const HEART_RATE_FILTER = \"scanDevices({ filters: [{ services: ['heart_rate'] }] })\"")) {
    fail(errors, 'search preview must show the official heart_rate-filtered scan');
  }
  if (/\bacceptAllDevices\b|全量(?:扫描|发现|搜索)|自动搜索/.test(preview)) {
    fail(errors, 'search preview must not claim accept-all or automatic discovery');
  }
  for (const copy of ['开始搜索', '下一步', 'Garmin fenix 8', '未连接也可以使用眼镜估算开跑']) {
    if (!preview.includes(copy)) fail(errors, `search flow missing ${copy}`);
  }

  for (const copy of ['眼镜估算', '心率接入', '配速接入', '请稳定跑约 5 秒', '平均步频', '每公里配速', '每分钟步频']) {
    if (!preview.includes(copy)) fail(errors, `HUD or summary flow missing ${copy}`);
  }
  if ((preview.match(/class=\"zone-dot(?: on)?\"/g) || []).length !== 5) {
    fail(errors, 'heart-rate HUD must render exactly five zone dots');
  }
  if (preview.includes('class=\"hud-hint\"')
      || !preview.includes('grid-template-columns: 84px 92px 116px 149px;')
      || !preview.includes('grid-template-columns: 14px 68px 60px 80px 94px 115px;')
      || !preview.includes('height: 76px;')) {
    fail(errors, 'HUD preview must preserve the approved bottom-only legacy layout without a separate hint bar');
  }

  const warmupMarkers = [
    '../assets/warmup/march.gif?v=13',
    '../assets/warmup/calf-raise.gif?v=13',
    '../assets/warmup/butt-kick.gif?v=13',
    '../assets/warmup/lateral-shift.gif?v=13',
    '跑前热身共四个动作，每个十五秒，合计一分钟。',
    "goTo('search', `已选择${modeName()}，先完成心率设备搜索与配置`)",
    "goTo('warmup', state.selectedDevice",
    "goTo('hud', '跑前热身倒计时结束，自动开始跑步并进入跑步 HUD')",
    "setEvent('末 3 秒仅视觉倒计时 · 不播报')",
  ];
  for (const marker of warmupMarkers) {
    if (!preview.includes(marker)) fail(errors, `warm-up flow missing ${marker}`);
  }
  if (!preview.includes('跑前热身')
      || (preview.match(/data-warmup-jump="[0-3]"/g) || []).length !== 4) {
    fail(errors, 'all four pre-run warm-up actions must be visible from the default preview page');
  }
  if (!preview.includes('guideQuickExit: false')
      || !preview.includes('if (state.guideQuickExit) {')
      || !preview.includes("setEvent('快速结束关闭：单击不跳过，等待自动切换')")
      || !preview.includes('state.guideQuickExit && !state.recoveryComplete')
      || !preview.includes("goTo('hud', '快速结束：跳过热身并进入跑步 HUD')")
      || !preview.includes("setEvent('快速完成放松，请选择查看总结或结束退出')")) {
    fail(errors, 'preview timed guides must default to no tap-skip and expose muted one-tap exit only after Quick Guide Exit is enabled');
  }
  if (/speakRecoveryPreview\(\s*['"]三。二。一。['"]/.test(preview)) {
    fail(errors, 'preview timed guides must keep the final three seconds visual-only');
  }

  const recoveryMarkers = [
    '../assets/recovery/walk.gif?v=13',
    '../assets/recovery/calf.gif?v=13',
    '../assets/recovery/quad.gif?v=13',
    '../assets/recovery/hamstring.gif?v=13',
    '4项 · 每项15秒 · 共1分钟',
    '放松共四个动作，每个十五秒，合计一分钟。',
    'state.recoveryComplete && !isWarmup',
    'data-action="recovery-summary">查看跑步总结',
    'data-action="recovery-exit">结束退出',
  ];
  for (const marker of recoveryMarkers) {
    if (!preview.includes(marker)) fail(errors, `recovery flow missing ${marker}`);
  }
  if (!preview.includes('放松')
      || (preview.match(/data-recovery-jump=\"[0-3]\"/g) || []).length !== 4) {
    fail(errors, 'all four recovery actions must be visible from the default preview page');
  }
  if ((preview.match(/duration: '15秒'/g) || []).length !== 8) {
    fail(errors, 'preview must contain four warm-up and four recovery steps of 15 seconds each');
  }
  if (preview.includes('?v=10')
      || preview.includes('?v=11')
      || preview.includes('?v=12')
      || (preview.match(/\.gif\?v=13/g) || []).length < 8) {
    fail(errors, 'all guide GIF references must use the current v13 cache key');
  }
  for (const copy of [
    '抬膝踏步，手臂前后摆',
    '脚跟抬起，缓慢落下',
    '脚跟后收，左右交替',
    '屈膝侧移，左右换边',
    '慢走，手臂自然摆动',
    '后脚跟压地，左右换边',
    '扶墙屈膝，左右换边',
    '脚尖回勾，左右换边',
  ]) {
    if (!preview.includes(copy)) fail(errors, `timed guide is missing concise instruction: ${copy}`);
  }

  for (const marker of [
    'function moveFocus(delta)',
    'state.focus = (state.focus + delta + count) % count;',
    'const HUD_END_CONFIRM_WINDOW_MS = 3000;',
    'const HUD_END_CONFIRM_GAP_MS = 600;',
    'state.hudConfirmCount += 1;',
    "setEvent('第一次确认：再按2次结束')",
    "setEvent('第二次确认：再按1次结束')",
    "goTo('recovery', '第三次确认：结束跑步并进入1分钟放松')",
    "goTo('summary', '放松完成，查看跑步总结')",
    "goTo('closed', '放松完成，跳过总结并关闭智能体')",
    '首页第一次返回：3 秒内再次返回才退出',
  ]) {
    if (!preview.includes(marker)) fail(errors, `interaction flow missing ${marker}`);
  }
  for (const key of ['Backspace', 'Enter', 'ArrowUp', 'ArrowDown']) {
    if (!preview.includes(`data-key="${key}"`)) fail(errors, `hardware pad missing ${key}`);
  }
}

if (runHud) {
  if (!runHud.includes('const MENU_FOCUS_COUNT = 5;')
      || !/\? \['today', 'free', 'slow', 'garmin_virtual', 'training', 'settings'\]/.test(runHud)
      || !/: \['free', 'slow', 'garmin_virtual', 'training', 'settings'\]/.test(runHud)) {
    fail(errors, `${RUN_HUD_REL} must keep five fixed menu entries plus optional Today Training`);
  }
  if (!runHud.includes("const SUMMARY_EXIT_COPY = '按返回键结束并关闭智能体';")
      || !runHud.includes("closeAgentFromSummary('recovery-skip-summary')")
      || !runHud.includes('finishRunToRecovery()')
      || !runHud.includes('showSummaryAfterRecovery()')) {
    fail(errors, `${RUN_HUD_REL} must preserve HUD-to-Recovery and optional Summary/Exit cleanup`);
  }
  const preRunBody = extractMethodBody(runHud, 'startPreRunGuide');
  const openRunBody = extractMethodBody(runHud, 'openRunMode');
  const onConnectBody = extractMethodBody(runHud, 'onConnectTap');
  const onRecoveryTapBody = extractMethodBody(runHud, 'onRecoveryTap');
  const onRecoveryBackBody = extractMethodBody(runHud, 'onRecoveryBack');
  const finishRecoveryCountdownBody = extractMethodBody(runHud, 'finishRecoveryCountdown');
  const updateRecoveryCountdownBody = extractMethodBody(runHud, 'updateRecoveryCountdown');
  const queueRecoverySpeechBody = extractMethodBody(runHud, 'queueRecoverySpeech');
  const timedGuideSpeechBody = extractMethodBody(runHud, 'timedGuideSpeechEnabled');
  const finishEntryBody = extractMethodBody(runHud, 'finishEntry');
  const enterSearchBody = extractMethodBody(runHud, 'enterSearchReady');
  if (!runHud.includes("surfacePhase === 'recovery' || surfacePhase === 'pre_run'")
      || !/surfacePhase:\s*'pre_run'/.test(preRunBody)
      || !/return this\.enterSearchReady\(\{ fromModeSelection: true \}\)/.test(openRunBody)
      || !/preRunRequiredAfterSearch === true/.test(onConnectBody)
      || !/return this\.startPreRunGuide\(\)/.test(onConnectBody)
      || !/return this\.proceedToHud\(\)/.test(onRecoveryTapBody)
      || !/const preRun = this\.timedGuideKind === 'pre_run'/.test(finishRecoveryCountdownBody)
      || !/if \(preRun\)[\s\S]*return this\.proceedToHud\(\{ suppressStartCue: true \}\)/.test(finishRecoveryCountdownBody)
      || !/recoveryActionLabel:\s*preRun \? '正在开跑' : '查看跑步总结'/.test(finishRecoveryCountdownBody)
      || !/recoveryChoiceVisible:\s*!preRun/.test(finishRecoveryCountdownBody)
      || !/return this\.enterSearchReady\(\{ fromWarmupBack: true \}\)/.test(onRecoveryBackBody)
      || !/if \(!this\.timedGuideQuickExitEnabled\(\)\) return false/.test(onRecoveryTapBody)
      || !/return !this\.timedGuideQuickExitEnabled\(\)/.test(timedGuideSpeechBody)
      || !/!this\.timedGuideSpeechEnabled\(\)/.test(queueRecoverySpeechBody)
      || !runHud.includes('ink:if="{{ !recoveryChoiceVisible && guideQuickExitEnabled }}"')
      || /get(?:Warmup|Recovery)RhythmTtsCue\(this\.recoveryIndex,\s*3\)/.test(updateRecoveryCountdownBody)
      || /preferWebSpeech|speechRate/.test(updateRecoveryCountdownBody)
      || !/fromWarmup/.test(finishEntryBody)
      || !/this\.startRun\(\)/.test(finishEntryBody)
      || !/surfacePhase:\s*'ready'/.test(enterSearchBody)
      || !/primaryLabel:\s*'开始搜索'/.test(enterSearchBody)) {
    fail(errors, `${RUN_HUD_REL} must keep default no-skip guides, mute enabled quick exit, keep the final three seconds visual-only, and auto-start the HUD at the final warm-up deadline`);
  }
  if (/startDiscovery|scanDevices|startSensors|startTicker|startAccel/.test(preRunBody)) {
    fail(errors, `${RUN_HUD_REL} pre_run must not start BLE, sensors, or run timing`);
  }
}

if (warmupGuide) {
  if (!warmupGuide.includes("WARMUP_OVERVIEW_COPY = '4项 · 每项15秒 · 共1分钟'")
      || !warmupGuide.includes("WARMUP_TOTAL_DURATION_SEC = 60")
      || !warmupGuide.includes("WARMUP_STEP_DURATION_SEC = 15")
      || !warmupGuide.includes("imagePath: '../../assets/warmup/march.gif'")
      || !warmupGuide.includes("imagePath: '../../assets/warmup/calf-raise.gif'")
      || !warmupGuide.includes("imagePath: '../../assets/warmup/butt-kick.gif'")
      || !warmupGuide.includes("imagePath: '../../assets/warmup/lateral-shift.gif'")
      || !warmupGuide.includes("? '立即开跑' : '下一步'")
      || !warmupGuide.includes("WARMUP_COMPLETION_TTS = '热身完成，自动开始跑步。'")
      || !warmupGuide.includes('WARMUP_TTS_INTRO')
      || !warmupGuide.includes('WARMUP_COMPLETION_TTS')) {
    fail(errors, `${WARMUP_GUIDE_REL} must preserve four 15-second pre-run steps and automatic Run destination`);
  }
}

if (settings) {
  if (!/guideQuickExit:\s*false/.test(settings)
      || !/guideQuickExit:\s*typeof src\.guideQuickExit === 'boolean'[\s\S]*?DEFAULT_RUN_SETTINGS\.guideQuickExit/.test(settings)) {
    fail(errors, `${SETTINGS_REL} must default Quick Guide Exit off and preserve only an explicit stored boolean`);
  }
}

if (recoveryGuide) {
  if (!recoveryGuide.includes("? '完成放松' : '下一步'")
      || !recoveryGuide.includes('请选择查看跑步总结')
      || !recoveryGuide.includes('RECOVERY_TTS_INTRO')
      || !recoveryGuide.includes('getRecoveryTtsCue')
      || !recoveryGuide.includes('第一项，慢走放松，十五秒。')
      || !recoveryGuide.includes('第四项，大腿后侧拉伸，左右交替十五秒。')) {
    fail(errors, `${RECOVERY_GUIDE_REL} must preserve four-step TTS and final exit`);
  }
}

checkPng(errors, PREVIEW_PNG_REL);

if (errors.length) {
  console.error(`\nPreview validation failed: ${errors.length} issue(s).`);
  process.exit(1);
}

console.log('OK Preview validation - one canonical HTML covers Home target adaptation (_current 448x150 and _blank 480x352), 480x352 menu/search/HUD/recovery/summary, four training plans, settings/binding, v13 four-step guides, default no-skip and muted Quick Guide Exit, visual-only final countdown, automatic warm-up-to-HUD, and hardware-key flow.');
