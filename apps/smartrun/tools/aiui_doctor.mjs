import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSummaryCommitFirst } from './summary_commit_guard.mjs';
import { AIUI_ENGINE_RANGE, AIUI_TARGET_VERSION } from './aix_provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PAGE_FILES = [
  'pages/run_hud/index.ink',
  'pages/index/index.ink',
];
const REQUIRED_APP_PERMISSIONS = [];

const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;
const NAMED_COLOR_BLACKLIST = /\b(red|blue|orange|yellow|purple|pink|cyan|magenta)\b/i;
const ALLOWED_WXSS_PROPERTIES = new Set([
  'display',
  'flex-direction', 'flex-wrap', 'justify-content', 'align-items',
  'flex-grow', 'flex-shrink', 'flex-basis', 'gap', 'row-gap', 'column-gap',
  'grid-template-columns', 'grid-template-rows', 'grid-auto-columns',
  'grid-auto-rows', 'grid-auto-flow', 'grid-column', 'grid-column-start',
  'grid-column-end', 'grid-row', 'grid-row-start', 'grid-row-end', 'grid-area',
  'align-content', 'justify-items', 'align-self', 'justify-self',
  'width', 'height', 'min-width', 'min-height', 'margin', 'padding', 'box-sizing', 'position',
  'top', 'right', 'bottom', 'left', 'inset', 'z-index',
  'overflow', 'overflow-x', 'overflow-y',
  'color', 'background-color',
  'border', 'border-width', 'border-style', 'border-color', 'border-radius',
  'outline', 'outline-width', 'outline-style', 'outline-color', 'outline-offset',
  'font-size', 'line-height', 'font-weight', 'font-family', 'font-style', 'text-align',
  'opacity', 'box-shadow', 'filter', 'transform', 'transform-origin',
  'transition', 'transition-property', 'transition-duration',
  'transition-timing-function', 'transition-delay',
]);
const ALLOWED_WXSS_AT_RULES = new Set(['import', 'media']);
const VISUAL_STYLE_MOTION_RE = /\banimation(?:-[a-z-]+)?\s*:|@keyframes\b|(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/i;
const OBSOLETE_VISUAL_MOTION_RE = /\b(?:homeMotionClass|homeLogoClass|startHomeMotion|stopHomeMotion|setHomeMotionPhase|connectMotionClass|startConnectMotion|connectMotionTimer|connectMinTimer|connectedHoldTimer|launchDoneTimer|launchFlightTimer|HOME_MOTION_PERIOD_MS|HOME_SWEEP_DELAY_MS|HOME_BURST_DELAY_MS|HOME_CLEAR_DELAY_MS|CONNECT_MOTION_STEP_MS|CONNECT_MIN_MS|CONNECTED_HOLD_MS|LAUNCH_DONE_MS|LAUNCH_FLIGHT_MS)\b|(?:home-energy|home-speed-line|phase-(?:sweep|burst|clear)|logo-(?:sweep|burst|clear)|connect-step-[a-z]|launch-phase-(?:ready|flight))/i;

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function check(label, ok, detail) {
  const mark = ok ? 'OK' : 'MISS';
  console.log(`${mark} ${label}${detail ? ` - ${detail}` : ''}`);
  return ok;
}

function readPackageJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch (_e) {
    return null;
  }
}

function readText(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch (_e) {
    return null;
  }
}

const WARMUP_GUIDE_ASSETS = [
  'assets/warmup/march.gif',
  'assets/warmup/calf-raise.gif',
  'assets/warmup/butt-kick.gif',
  'assets/warmup/lateral-shift.gif',
];

const RECOVERY_GUIDE_ASSETS = [
  'assets/recovery/walk.gif',
  'assets/recovery/calf.gif',
  'assets/recovery/quad.gif',
  'assets/recovery/hamstring.gif',
];

function readGifSubBlocks(bytes, startOffset) {
  let offset = startOffset;
  let payloadBytes = 0;
  let firstPayload = null;
  while (offset < bytes.length) {
    const size = bytes[offset];
    offset += 1;
    if (size === 0) return { offset, payloadBytes, firstPayload };
    if (offset + size > bytes.length) return null;
    if (firstPayload == null) firstPayload = bytes.subarray(offset, offset + size);
    payloadBytes += size;
    offset += size;
  }
  return null;
}

function inspectGuideGif(bytes) {
  const invalid = {
    valid: false,
    width: 0,
    height: 0,
    loopCount: null,
    visibleFrameCount: 0,
    uniqueVisibleFrameCount: 0,
  };
  if (!Buffer.isBuffer(bytes)
      || bytes.length < 14
      || !/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return invalid;

  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  const screenPacked = bytes[10];
  let offset = 13;
  if (screenPacked & 0x80) offset += 3 * (1 << ((screenPacked & 0x07) + 1));
  if (offset > bytes.length) return invalid;

  let loopCount = null;
  let visibleFrameCount = 0;
  const uniqueVisibleFrames = new Set();
  while (offset < bytes.length) {
    const marker = bytes[offset];
    if (marker === 0x3b) {
      return {
        valid: true,
        width,
        height,
        loopCount,
        visibleFrameCount,
        uniqueVisibleFrameCount: uniqueVisibleFrames.size,
      };
    }
    if (marker === 0x21) {
      if (offset + 2 >= bytes.length) return invalid;
      const label = bytes[offset + 1];
      offset += 2;
      if (label === 0xff) {
        const appSize = bytes[offset];
        offset += 1;
        if (!Number.isInteger(appSize) || offset + appSize > bytes.length) return invalid;
        const appId = bytes.subarray(offset, offset + appSize).toString('ascii');
        offset += appSize;
        const blocks = readGifSubBlocks(bytes, offset);
        if (!blocks) return invalid;
        if (appId === 'NETSCAPE2.0'
            && blocks.firstPayload?.length >= 3
            && blocks.firstPayload[0] === 1) {
          loopCount = blocks.firstPayload.readUInt16LE(1);
        }
        offset = blocks.offset;
        continue;
      }
      const blocks = readGifSubBlocks(bytes, offset);
      if (!blocks) return invalid;
      offset = blocks.offset;
      continue;
    }
    if (marker === 0x2c) {
      const frameStart = offset;
      offset += 1;
      if (offset + 9 > bytes.length) return invalid;
      const left = bytes.readUInt16LE(offset);
      const top = bytes.readUInt16LE(offset + 2);
      const frameWidth = bytes.readUInt16LE(offset + 4);
      const frameHeight = bytes.readUInt16LE(offset + 6);
      const framePacked = bytes[offset + 8];
      offset += 9;
      if (framePacked & 0x80) offset += 3 * (1 << ((framePacked & 0x07) + 1));
      if (offset >= bytes.length) return invalid;
      offset += 1; // LZW minimum code size.
      const blocks = readGifSubBlocks(bytes, offset);
      if (!blocks) return invalid;
      offset = blocks.offset;
      if (frameWidth > 0
          && frameHeight > 0
          && left + frameWidth <= width
          && top + frameHeight <= height
          && blocks.payloadBytes > 0) {
        visibleFrameCount += 1;
        uniqueVisibleFrames.add(bytes.subarray(frameStart, offset).toString('base64'));
      }
      continue;
    }
    return invalid;
  }
  return invalid;
}

function scanRecoveryAssets() {
  const issues = [];
  for (const rel of [...WARMUP_GUIDE_ASSETS, ...RECOVERY_GUIDE_ASSETS]) {
    try {
      const bytes = fs.readFileSync(path.join(ROOT, rel));
      const gif = inspectGuideGif(bytes);
      if (!gif.valid
          || gif.width !== 160
          || gif.height !== 160
          || bytes.length >= 24 * 1024
          || gif.loopCount !== 0
          || gif.visibleFrameCount < 2
          || gif.uniqueVisibleFrameCount < 2) {
        issues.push(`${rel}: expected compact infinite-loop 160x160 GIF with multiple visible frames`);
      }
    } catch (_e) {
      issues.push(`${rel}: missing`);
    }
  }
  const page = readText('pages/run_hud/index.ink') || '';
  const warmupGuide = readText('lib/warmup_guide.js') || '';
  const recoveryGuide = readText('lib/recovery_guide.js') || '';
  const preRunBody = stripJsComments(extractMethodBody(page, 'startPreRunGuide'));
  const openRunBody = stripJsComments(extractMethodBody(page, 'openRunMode'));
  const onConnectBody = stripJsComments(extractMethodBody(page, 'onConnectTap'));
  const onRecoveryTapBody = stripJsComments(extractMethodBody(page, 'onRecoveryTap'));
  const onRecoveryBackBody = stripJsComments(extractMethodBody(page, 'onRecoveryBack'));
  const finishRecoveryCountdownBody = stripJsComments(extractMethodBody(page, 'finishRecoveryCountdown'));
  const updateRecoveryCountdownBody = stripJsComments(extractMethodBody(page, 'updateRecoveryCountdown'));
  const queueRecoverySpeechBody = stripJsComments(extractMethodBody(page, 'queueRecoverySpeech'));
  const finishEntryBody = stripJsComments(extractMethodBody(page, 'finishEntry'));
  const enterSearchBody = stripJsComments(extractMethodBody(page, 'enterSearchReady'));
  if (!page.includes('queueRecoveryTts(0, { includeIntro: true })')
      || !page.includes('cancelRecoveryTts()')
      || !page.includes("surfacePhase === 'recovery' || surfacePhase === 'pre_run'")
      || !warmupGuide.includes('WARMUP_TTS_INTRO')
      || !warmupGuide.includes("WARMUP_OVERVIEW_COPY = '4项 · 每项15秒 · 共1分钟'")
      || !warmupGuide.includes("imagePath: '../../assets/warmup/march.gif'")
      || !warmupGuide.includes("imagePath: '../../assets/warmup/calf-raise.gif'")
      || !warmupGuide.includes("imagePath: '../../assets/warmup/butt-kick.gif'")
      || !warmupGuide.includes("imagePath: '../../assets/warmup/lateral-shift.gif'")
      || !warmupGuide.includes("? '立即开跑' : '下一步'")
      || !warmupGuide.includes("WARMUP_COMPLETION_TTS = '热身完成，自动开始跑步。'")
      || !recoveryGuide.includes('RECOVERY_TTS_INTRO')
      || !recoveryGuide.includes("RECOVERY_OVERVIEW_COPY = '4项 · 每项15秒 · 共1分钟'")
      || !page.includes('timedGuideQuickExitEnabled()')
      || !page.includes('timedGuideSpeechEnabled()')
      || !/!this\.timedGuideSpeechEnabled\(\)/.test(queueRecoverySpeechBody)
      || /get(?:Warmup|Recovery)RhythmTtsCue\(this\.recoveryIndex,\s*3\)/.test(
        updateRecoveryCountdownBody,
      )
      || /preferWebSpeech|speechRate/.test(updateRecoveryCountdownBody)) {
    issues.push('timed guides must announce steps by default, mute all guide TTS when quick exit is enabled, and keep the final three seconds visual-only');
  }
  if (!/surfacePhase:\s*'pre_run'/.test(preRunBody)
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
      || !/fromWarmup/.test(finishEntryBody)
      || !/this\.startRun\(\)/.test(finishEntryBody)
      || !/surfacePhase:\s*'ready'/.test(enterSearchBody)
      || !/primaryLabel:\s*'开始搜索'/.test(enterSearchBody)
      || /startDiscovery|scanDevices|startSensors|startTicker|startAccel/.test(preRunBody)) {
    issues.push('Search setup must enter sensor-free pre_run, then the final warm-up deadline must auto-start the HUD');
  }
  return issues;
}

function readInkDef(rel) {
  const text = readText(rel) || '';
  const match = text.match(/<script[^>]*\bdef\b[^>]*>\s*([\s\S]*?)\s*<\/script>/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch (_e) { return null; }
}

function listPreviewHtml() {
  const dir = path.join(ROOT, 'preview');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.html'))
    .sort()
    .map((name) => `preview/${name}`);
}

function extractRule(text, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  return match ? match[1] : '';
}

function extractLastRule(text, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...text.matchAll(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, 'g'))];
  return matches.length ? matches[matches.length - 1][1] : '';
}

function inspectPcmWav(buffer) {
  if (!buffer || buffer.length < 44
      || buffer.subarray(0, 4).toString('ascii') !== 'RIFF'
      || buffer.subarray(8, 12).toString('ascii') !== 'WAVE') return null;
  let format = null;
  let dataBytes = null;
  let dataStart = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const chunkId = buffer.subarray(offset, offset + 4).toString('ascii');
    const chunkBytes = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (bodyStart + chunkBytes > buffer.length) return null;
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
  if (!format || !(format.byteRate > 0) || dataBytes == null) return null;
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

function countRuleDeclarations(text, selector, declaration) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, 'g');
  let count = 0;
  let match = matcher.exec(text);
  while (match) {
    count += (match[1].match(declaration) || []).length;
    match = matcher.exec(text);
  }
  return count;
}

function scanStaticPrimaryUi() {
  const issues = [];
  for (const rel of [
    'pages/index/index.ink',
    'pages/run_hud/index.ink',
  ]) {
    const text = readText(rel) || '';
    const styleMotion = text.match(VISUAL_STYLE_MOTION_RE);
    if (styleMotion) issues.push(`${rel}: visual style ${styleMotion[0]}`);
    const obsoleteMotion = text.match(OBSOLETE_VISUAL_MOTION_RE);
    if (obsoleteMotion) issues.push(`${rel}: obsolete visual motion ${obsoleteMotion[0]}`);
    const transitionCount = (text.match(/\btransition(?:-[a-z-]+)?\s*:/gi) || []).length;
    if (rel === 'pages/index/index.ink' && transitionCount !== 0) {
      issues.push(`${rel}: Home must not animate or transition`);
    }
    if (rel === 'pages/run_hud/index.ink' && transitionCount !== 0) {
      // 官方样例形态:02 全静态,无任何 transition/动效
      issues.push(`${rel}: sample-clone Screen 02 must stay transition-free`);
    }
  }
  // Browser previews are review-only artifacts. They must never be treated as
  // evidence that an animation or transition exists in the shipped AIX; the
  // production .ink pages above remain the sole runtime motion gate.
  return issues;
}

function scanSurfaceRegistration() {
  const issues = [];
  const app = readPackageJson('app.json');
  const expectedRoutes = [
    'pages/run_hud/index',
    'pages/index/index',
  ];
  if (JSON.stringify(app && app.pages) !== JSON.stringify(expectedRoutes)) {
    issues.push('app.json must keep the exact two-page route order');
  }
  if (JSON.stringify(app && app.permissions) !== JSON.stringify(REQUIRED_APP_PERMISSIONS)) {
    issues.push(`app.json permissions must be exactly: ${REQUIRED_APP_PERMISSIONS.join(', ')}`);
  }
  if (app && app.engine !== AIUI_ENGINE_RANGE) {
    issues.push(`app.json engine must be exactly: ${AIUI_ENGINE_RANGE}`);
  }

  const home = readInkDef('pages/index/index.ink');
  if (!home || JSON.stringify(Object.keys(home)) !== JSON.stringify(['navigationBarTitleText'])) {
    issues.push('pages/index/index.ink must stay a title-only 448x150 compatibility fallback');
  }

  const runDef = readInkDef('pages/run_hud/index.ink');
  if (!runDef || JSON.stringify(Object.keys(runDef)) !== JSON.stringify(['navigationBarTitleText'])) {
    issues.push('pages/run_hud/index.ink must stay title-only so the first parameterless route derives _blank');
  }
  return issues;
}

function scanStyleEntry() {
  return PAGE_FILES.filter((rel) => /<style[^>]*>\s*\/\*/.test(readText(rel) || ''))
    .map((rel) => `${rel} has a leading style comment that breaks AIX layout discovery`);
}

function scanCanvasSizes() {
  const issues = [];
  // 本应用按目标宿主区分两种画布：对话式 448x150，沉浸式 480x352。
  const roots = [
    ['pages/run_hud/index.ink', '.immersive-root'],
  ];
  const surfaces = [
    ['pages/index/index.ink', ['.home-card'], 448, 150],
    ['pages/run_hud/index.ink', ['.hud'], 480, 352],
  ];
  for (const [rel, selector] of roots) {
    const rule = extractRule(readText(rel) || '', selector);
    if (!/\bwidth:\s*480px;/.test(rule)
        || !/\bheight:\s*352px;/.test(rule)
        || /\b(?:min|max)-(?:width|height):/.test(rule)) {
      issues.push(`${rel} ${selector} must be exactly 480x352px`);
    }
  }
  for (const [rel, selectors, width, height] of surfaces) {
    const text = readText(rel) || '';
    for (const selector of selectors) {
      const rule = extractRule(text, selector);
      if (!new RegExp(`\\bwidth:\\s*${width}px;`).test(rule)
          || !new RegExp(`\\bheight:\\s*${height}px;`).test(rule)
          || /min-height:/.test(rule)) {
        issues.push(`${rel} ${selector} must be ${width}x${height}px`);
      }
    }
  }
  const homeText = readText('pages/index/index.ink') || '';
  const homeWrap = extractRule(homeText, '.home-wrap');
  if (!/\bwidth:\s*448px;/.test(homeWrap) || !/\bheight:\s*150px;/.test(homeWrap)
      || !/\bjustify-content:\s*flex-end;/.test(homeWrap)
      || !/\bposition:\s*fixed;/.test(homeWrap)
      || !/\bbottom:\s*0;/.test(homeWrap)
      || !/\bleft:\s*0;/.test(homeWrap)
      || !/\bright:\s*0;/.test(homeWrap)) {
    issues.push('pages/index/index.ink .home-wrap must keep a 448px card bottom-aligned in the host viewport');
  }
  if (!/@media\s*\(target:\s*_current\)\s*\{[\s\S]*?\.home-wrap\s*\{[\s\S]*?\bwidth:\s*448px;[\s\S]*?\bheight:\s*150px;/.test(homeText)
      || !/@media\s*\(target:\s*_blank\)\s*\{[\s\S]*?\.home-wrap\s*\{[\s\S]*?\bwidth:\s*480px;[\s\S]*?\bheight:\s*352px;[\s\S]*?\.home-card\s*\{[\s\S]*?\bwidth:\s*448px;[\s\S]*?\bheight:\s*352px;/.test(homeText)) {
    issues.push('pages/index/index.ink must adapt the same Home page with _current=448x150 and _blank=480x352 target media rules');
  }
  if (!/onTargetChanged\(target, previousTarget\)[\s\S]*?target === '_blank'[\s\S]*?this\.setData\(\{ hostTarget \}\)/.test(homeText)) {
    issues.push('pages/index/index.ink must synchronize hostTarget through onTargetChanged without viewport sniffing');
  }
  const targetHandler = stripJsComments(extractMethodBody(homeText, 'onTargetChanged'));
  if (!targetHandler
      || /\b(?:navigateTo|redirectTo|switchTab|reLaunch|scanDevices|innerWidth|innerHeight|getWindowInfo|getSystemInfoSync)\b/.test(targetHandler)) {
    issues.push('pages/index/index.ink onTargetChanged must only synchronize local target state');
  }
  const homeCard = extractRule(homeText, '.home-card');
  const runHud = extractRule(readText('pages/run_hud/index.ink') || '', '.hud');
  if (/\bborder\s*:/.test(homeCard) || /\bborder\s*:/.test(runHud)) {
    issues.push('Home and immersive canvas surfaces must not draw outer border lines');
  }
  return issues;
}

function scanHomePixelAlignment() {
  const issues = [];
  const rel = 'pages/index/index.ink';
  const text = readText(rel) || '';
  const rules = {
    wrap: extractRule(text, '.home-wrap'),
    card: extractRule(text, '.home-card'),
    content: extractRule(text, '.home-content'),
    slogan: extractRule(text, '.home-slogan'),
  };
  for (const [name, rule] of Object.entries({
    card: rules.card,
    content: rules.content,
  })) {
    if (!/\balign-items:\s*center;/.test(rule)
        || !/\bjustify-content:\s*center;/.test(rule)
        || !/\bbox-sizing:\s*border-box;/.test(rule)) {
      issues.push(`${rel} home ${name} must use exact flex centering and border-box sizing`);
    }
  }
  if (!/\balign-items:\s*center;/.test(rules.wrap)
      || !/\bjustify-content:\s*flex-end;/.test(rules.wrap)
      || !/\bbox-sizing:\s*border-box;/.test(rules.wrap)) {
    issues.push(`${rel} home wrap must bottom-align the 448x150 card in expanded hosts`);
  }
  if (!/\bmargin:\s*0;/.test(rules.card) || !/\bpadding:\s*0;/.test(rules.card)) {
    issues.push(`${rel} .home-card must reset margin and padding`);
  }
  if (!/\bmargin:\s*0 auto;/.test(rules.wrap)) {
    issues.push(`${rel} .home-wrap must center the 448px card when the host expands to 480px`);
  }
  if (!/\bwidth:\s*444px;/.test(rules.content)
      || !/\bheight:\s*146px;/.test(rules.content)
      || !/\bpadding:\s*4px 12px;/.test(rules.content)) {
    issues.push(`${rel} .home-content must preserve the 444x146 inner safe area`);
  }
  if (!/\bheight:\s*24px;/.test(rules.slogan)
      || !/\bmargin:\s*1px 0 3px;/.test(rules.slogan)) {
    issues.push(`${rel} .home-slogan must keep the compact single-entry rhythm`);
  }
  const nonWrapperRules = [rules.card, rules.content, rules.slogan].join('\n');
  if (/\bposition\s*:/.test(nonWrapperRules)
      || /\btransform\s*:/.test(Object.values(rules).join('\n'))) {
    issues.push(`${rel} Home may use only the fixed bottom wrapper; child positioning and transforms are forbidden`);
  }
  return issues;
}

function scanHomeVersionLabel(productVersion) {
  const rel = 'pages/index/index.ink';
  const text = readText(rel) || '';
  const version = String(productVersion || '').trim();
  const versionRule = extractRule(text, '.home-version');
  const spacerRule = extractRule(text, '.home-version-spacer');
  const expected = `homeVersion: 'v${version}'`;
  const issues = [];
  if (!/^\d+\.\d+\.\d+$/.test(version) || !text.includes(expected)) {
    issues.push(`${rel} visible Home version must match package.json (${version || 'missing'})`);
  }
  if (!/class="home-version">\{\{\s*homeVersion\s*\}\}<\/text>/.test(text)
      || !/\bfont-size:\s*12px;/.test(versionRule)
      || !/\bline-height:\s*18px;/.test(versionRule)
      || /\b(?:position|transform)\s*:/.test(versionRule)) {
    issues.push(`${rel} must render the product version as a small title-side label`);
  }
  if (!/\bwidth:\s*64px;/.test(versionRule)
      || !/\bwidth:\s*64px;/.test(spacerRule)
      || /\b(?:position|transform)\s*:/.test(spacerRule)
      || !text.includes('class="home-version-spacer"')) {
    issues.push(`${rel} must keep an equal version spacer so the SmartRun title stays centered`);
  }
  return issues;
}

function extractBackspaceBranch(text) {
  const needle = "if (code === 'Backspace') {";
  const start = text.indexOf(needle);
  if (start < 0) return '';
  const nextBranch = text.indexOf('\n    if (', start + needle.length);
  const handlerEnd = text.indexOf('\n  },', start + needle.length);
  const end = nextBranch >= 0 && (handlerEnd < 0 || nextBranch < handlerEnd)
    ? nextBranch : handlerEnd;
  return end >= 0 ? text.slice(start, end) : '';
}

function stripJsComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function extractMethodBody(text, methodName) {
  const escaped = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Accept one nested parenthesis level in defaults such as `now = Date.now()`.
  const signature = new RegExp(
    `(?:^|\\n)\\s*(?:async\\s+)?${escaped}\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*\\{`,
    'm',
  );
  const match = signature.exec(text);
  if (!match) return '';
  const open = text.indexOf('{', match.index + match[0].lastIndexOf('{'));
  let depth = 0;
  let quote = '';
  let escapedChar = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (escapedChar) { escapedChar = false; continue; }
      if (ch === '\\') { escapedChar = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return '';
}

function scanHostBackspacePolicy() {
  const issues = [];
  const pages = [
    ['pages/index/index.ink', null],
    ['pages/run_hud/index.ink', 'run_hud'],
  ];
  for (const [rel, source] of pages) {
    const text = readText(rel) || '';
    // 不允许页面自行开第二条返回路由;run_hud 仅允许总结页明确关闭智能体。
    if (/wx\.navigateBack\s*\(/.test(text)) {
      issues.push(`${rel} may leave the app`);
      continue;
    }
    const branch = extractBackspaceBranch(text);
    if (!branch) {
      issues.push(`${rel} does not listen for Backspace`);
      continue;
    }
    if (/wx\.(?:navigateTo|redirectTo|navigateBack)\s*\(/.test(branch)) {
      issues.push(`${rel} starts a competing navigation inside Backspace`);
    }
    if (!source) {
      if (/preventDefault\s*\(/.test(branch)) {
        issues.push(`${rel} intercepts Backspace instead of preserving the host default`);
      }
      const totalExits = (stripJsComments(text).match(/wx\.exitMiniProgram\s*\(/g) || []).length;
      const branchExits = (stripJsComments(branch).match(/wx\.exitMiniProgram\s*\(/g) || []).length;
      if (totalExits !== 1 || branchExits !== 1) {
        issues.push(`${rel} exit must live only inside the double-press Backspace confirm branch`);
      }
    } else {
      if (!branch.includes(`markHostBackspaceIntent(wx, '${source}')`)) {
        issues.push(`${rel} does not persist the Screen 02 host Backspace intent`);
      }
      if (!/isSummaryPhase\s*\(\s*\)[\s\S]*preventDefault\s*\([\s\S]*closeAgentFromSummary\s*\(/.test(branch)) {
        issues.push(`${rel} summary Backspace must replace host return with the explicit agent close flow`);
      }
      if (!/surfacePhase\s*===\s*'hud'[\s\S]*preventDefault\s*\([\s\S]*resetHudEndConfirmation\s*\([\s\S]*请按确认键3次结束/.test(branch)
          || /surfacePhase\s*===\s*'hud'[\s\S]*finishRunToRecovery\s*\(/.test(branch)) {
        issues.push(`${rel} HUD Backspace must preserve the strict three-confirm end guard`);
      }
      const keyUp = stripJsComments(extractMethodBody(text, 'onKeyUp'));
      if (!/surfacePhase\s*===\s*'hud'[\s\S]*data\.running[\s\S]*preventDefault\s*\([\s\S]*onHudConfirmKey\s*\(/.test(keyUp)) {
        issues.push(`${rel} HUD confirmation must prevent the host default before opening Screen 04`);
      }
      if (!/surfacePhase\s*===\s*'binding'[\s\S]*preventDefault\s*\([\s\S]*showSettingsFromBinding\s*\(/.test(branch)) {
        issues.push(`${rel} Agent Binding Backspace must return to Settings without leaving the immersive route`);
      }
      const hudConfirm = stripJsComments(extractMethodBody(text, 'onHudConfirmKey'));
      if (!/HUD_CONFIRM_REQUIRED_COUNT\s*=\s*3/.test(text)
          || !/HUD_CONFIRM_INDEPENDENT_GAP_MS\s*=\s*600/.test(text)
          || !/hudEndConfirmCount[\s\S]*HUD_CONFIRM_REQUIRED_COUNT[\s\S]*finishRunToRecovery\s*\(/.test(hudConfirm)
          || !hudConfirm.includes('再按2次结束')
          || !hudConfirm.includes('再按1次结束')) {
        issues.push(`${rel} HUD end must require three independently deduplicated confirmations`);
      }
      const cleanText = stripJsComments(text);
      const cleanClose = stripJsComments(extractMethodBody(text, 'closeAgentFromSummary'));
      const cleanDispatch = stripJsComments(extractMethodBody(text, 'dispatchAgentExit'));
      const cleanSummaryConfirm = stripJsComments(extractMethodBody(text, 'onSummaryConfirmKey'));
      const totalExits = (cleanText.match(/wx\.exitMiniProgram\s*\(/g) || []).length;
      const fallbackIndex = cleanClose.indexOf('agentExitTimer = setTimeout');
      const teardownIndex = cleanClose.indexOf('beginTerminalBleCleanup()');
      if (totalExits !== 1 || fallbackIndex < 0 || teardownIndex < 0
          || !/persistSummaryQueues\(\)[\s\S]*summaryExitPersistenceConfirmed/.test(cleanClose)
          || !/beginTerminalBleCleanup\(\)[\s\S]*Promise\.resolve\(cleanup\)[\s\S]*dispatchAgentExit\(\)/.test(cleanClose)
          || !/wx\.exitMiniProgram\s*\(/.test(cleanDispatch)
          || !/closeAgentFromSummary\s*\(\s*'summary-double-confirm'\s*\)/.test(cleanSummaryConfirm)
          || !text.includes('<text class="summary-exit">{{ summaryExitText }}</text>')
          || !text.includes("const SUMMARY_EXIT_COPY = '按返回键结束并关闭智能体'")
          || !text.includes('summaryExitText: SUMMARY_EXIT_COPY')
          || !/isSummaryPhase\(\)[\s\S]*timedGuideKind\s*!==\s*'recovery'[\s\S]*ArrowDown[\s\S]*startRecoveryGuide\(\)/.test(keyUp)
          || !text.includes('<view class="recovery-wrap" ink:if="{{ surfacePhase === \'recovery\' || surfacePhase === \'pre_run\' }}">')
          || !text.includes("closeAgentFromSummary('recovery-skip-summary')")
          || !text.includes('showSummaryAfterRecovery()')
          || !/closeAgentFromSummary\(\s*'summary-double-tap'\s*\)/.test(cleanSummaryConfirm)) {
        issues.push(`${rel} must expose a non-blocking summary exit and clean BLE before its single app exit`);
      }
      if (!/if\s*\(this\.isSearchPhase\(\)\)\s*writeScanExitHint\(wx\)/.test(branch)
          || !text.includes('前后划选择 · 单击执行')
          || !text.includes('返回键回首页 · 双击退出智能体')
          || !/SEARCH_DOUBLE_TAP_WINDOW_MS\s*=\s*420/.test(text)
          || !/closeAgentFromSummary\(\s*'search-double-tap'\s*\)/.test(text)) {
        issues.push(`${rel} must expose Screen 02 swipe/select/double-tap exit plus the Backspace fallback`);
      }
    }
  }
  const home = readText('pages/index/index.ink') || '';
  if (!home.includes('/pages/run_hud/index')) {
    issues.push('pages/index/index.ink is missing the run_hud immersive route');
  }
  if (!/const HOME_MENU_ROUTE = RUN_ROUTE \+ '\?mode=menu&inputGuard=1&fromHome=1';/.test(home)
      || !/wx\.navigateTo\s*\(\s*\{[\s\S]*?url:\s*HOME_MENU_ROUTE\s*,/.test(home)
      || /wx\.redirectTo\s*\(/.test(home)) {
    issues.push('pages/index/index.ink must keep the conversation root and use navigateTo only');
  }
  if (!/<view class="home-card" role="navigation">/.test(home)
      || !/class="home-enter home-action-focused"[\s\S]*?tabindex="0"[\s\S]*?bindtap="openMenu"/.test(home)
      || /home-options|home-option|openSlowRun|openSettings|HOME_FOCUS_COUNT/.test(home)) {
    issues.push('pages/index/index.ink must expose exactly one safe menu entry');
  }
  const homeKeyUp = stripJsComments(extractMethodBody(home, 'onKeyUp'));
  if (!/openMenu/.test(home)
      || !/code === 'GlobalHook'/.test(homeKeyUp)
      || !/preventDefault\s*\(/.test(homeKeyUp)
      || /code === '(?:Enter|NumpadEnter|Space)'/.test(homeKeyUp)
      || !/HOME_CONFIRM_DEDUPE_MS/.test(home)
      || !/runNavigationPending/.test(home)
      || /code === 'ArrowDown'|code === 'ArrowUp'/.test(home)) {
    issues.push('pages/index/index.ink must keep native Enter/Space activation, de-duplicate only GlobalHook, and leave direction keys to the host');
  }
  if (/navigator\.bluetooth\.|readHeartRateDevice|matchesHeartRateDevice/.test(home)) {
    issues.push('pages/index/index.ink must keep the conversation Home free of Bluetooth state work');
  }
  if (/\b(?:home-slogan-summary|sloganClass|generateRunSummary)\b/.test(home)) {
    issues.push('pages/index/index.ink must not restore a post-run summary visual state');
  }
  return issues;
}

function scanRunEntryPolicy() {
  const issues = [];
  const text = readText('pages/run_hud/index.ink') || '';
  const cleanText = stripJsComments(text);
  const home = readText('pages/index/index.ink') || '';
  const identity = readText('lib/device_identity.js') || '';
  const coachApi = readText('lib/coach_api.js') || '';
  const runUpload = readText('lib/run_upload.js') || '';
  const workoutOwnerStorage = readText('lib/workout_owner_storage.js') || '';
  const packExcludes = readText('tools/pack_excludes.mjs') || '';
  const workoutCompletion = readText('lib/workout_completion.js') || '';
  const aiuiCalibration = readText('lib/aiui_calibration.js') || '';
  const runningLocalFieldLog = readText('lib/running_local_field_log.js') || '';
  const wxJson = readText('lib/wx_json.js') || '';
  const settings = readText('lib/settings.js') || '';
  const metronome = readText('lib/metronome.js') || '';
  const metronomeAudioPath = path.join(ROOT, 'assets/audio/metro_0468.wav');
  const metronomeBarAudio = [
    [160, 1225.011],
    [170, 1158.821],
    [180, 1100.000],
  ];
  const onLoad = text.slice(text.indexOf('  onLoad('), text.indexOf('  isSearchPhase() {'));
  const onShow = text.slice(text.indexOf('  onShow() {'), text.indexOf('  clearSurfaceTimers() {'));
  const calibrationCapture = text.slice(
    text.indexOf('  captureAiuiCalibrationSnapshot('),
    text.indexOf('  async flushAiuiCalibrationUploads()'),
  );
  const summaryClose = text.slice(
    text.indexOf('  closeAgentFromSummary('),
    text.indexOf('  onHudConfirmKey()'),
  );
  const cleanSummaryClose = stripJsComments(summaryClose);
  const summaryFinalizer = text.slice(
    text.indexOf('  finalizeRunAfterSummaryCommit('),
    text.indexOf('  finishRunToSummary()'),
  );
  const summaryUploadStarter = stripJsComments(
    extractMethodBody(text, 'startSummaryHermesUploads'),
  );
  if (!cleanText.includes("typeof this.enableWorldAwareness !== 'function'")
      || !/this\.enableWorldAwareness\(\{\s*mode:\s*'normal'\s*\}\)/.test(cleanText)
      || !cleanText.includes("typeof this.disableWorldAwareness !== 'function'")
      || !cleanText.includes('this.disableWorldAwareness()')
      || !cleanText.includes('this.motionOrientationSensor')
      || !cleanText.includes('new AbsoluteOrientationSensor(')
      || /this\.orientationSensor\s*=(?!=)/.test(cleanText)
      || /this\.orientationSensor\s*\.\s*stop\s*\(/.test(cleanText)) {
    issues.push('AIUI 0.16.1 World Awareness must be guarded, retain the motionOrientationSensor fallback, and never assign or stop the host orientationSensor');
  }
  if (!/const DEVICE_REQUEST_TIMEOUT_MS = 12000;/.test(text)
      || !/dataType:\s*'json'/.test(text)
      || !/responseType:\s*'text'/.test(text)
      || !/timeout:\s*timeoutMs/.test(text)
      || !/requestTask\.abort\(\)/.test(text)) {
    issues.push('device identity network requests must use explicit JSON text, a 12s phone-proxy timeout, and abort the bounded fallback');
  }
  if (!/dataType:\s*'json'/.test(identity)
      || !/responseType:\s*'text'/.test(identity)
      || !/timeout:\s*12000/.test(identity)
      || !coachApi.includes("dataType: 'json'")
      || !coachApi.includes("responseType: 'text'")
      || !runUpload.includes("dataType: 'json'")
      || !runUpload.includes("responseType: 'text'")
      || !aiuiCalibration.includes("dataType: 'json'")
      || !aiuiCalibration.includes("responseType: 'text'")
      || !wxJson.includes('normalizeWxJsonResponse')) {
    issues.push('all shipped backend builders must pin the AIUI JSON response contract and retain ArrayBuffer fallback decoding');
  }
  const retiredAgentReference = /(?:(?:from|import)[^\n]*sport_agent\.js|SportAgent|sportAgent|(?<!LEGACY_)SPORT_AGENT)/;
  if (retiredAgentReference.test(text)
      || retiredAgentReference.test(identity)
      || retiredAgentReference.test(workoutOwnerStorage)
      || !packExcludes.includes("'lib/sport_agent.js'")
      || !text.includes("import { nextProactiveCue } from '../../lib/coach.js';")
      || !text.includes('const cue = nextProactiveCue(this.prevCue, cur);')
      || !text.includes('async generateSummaryAiText(summary)')
      || !text.includes('LanguageModel.create({')) {
    issues.push('retired Sport Agent must have no production runtime references and must be excluded from AIX while local coaching cues and on-device summary remain');
  }
  const workoutCompletionBuilder = workoutCompletion.slice(
    workoutCompletion.indexOf('export function buildWorkoutCompletion('),
    workoutCompletion.indexOf('function clone(value)'),
  );
  if (/\brpe\b|\bpain\b|training_context/i.test(workoutCompletionBuilder)
      || workoutCompletion.includes("normalizeOptionalInt(result, raw, 'rpe'")) {
    issues.push('new AIX workout completion must strip legacy RPE and never emit RPE, pain or training_context');
  }
  if (!aiuiCalibration.includes(
    "AIUI_CALIBRATION_PATH =\n  '/api/coach-svc/coach/aiui-calibration/batch'",
  )
      || !aiuiCalibration.includes(
        "PENDING_AIUI_CALIBRATION_KEY =\n  'pending_aiui_calibration_events'",
      )
      || !aiuiCalibration.includes("source: 'aiui_glasses'")
      || !aiuiCalibration.includes('acked_event_ids')
      || !aiuiCalibration.includes('AIUI_CALIBRATION_BATCH_SIZE = 500')
      || !aiuiCalibration.includes('AIUI_CALIBRATION_CAPTURE_INTERVAL_MS = 1000')
      || !/status === 400 \|\| status === 409 \|\| status === 422/.test(
        aiuiCalibration,
      )
      || /\b(?:latitude|longitude|raw_acceleration|raw_gyroscope)\b/.test(
        aiuiCalibration,
      )) {
    issues.push('AIUI calibration must use the scoped batch endpoint, 1Hz derived-only events, explicit ACKs and isolated permanent conflicts without raw coordinates or sensors');
  }
  if (calibrationCapture.includes('flushAiuiCalibrationUploads()')
      || onLoad.includes('flushAiuiCalibrationUploads()')
      || onShow.includes('flushAiuiCalibrationUploads()')
      || cleanSummaryClose.includes('this.flushAiuiCalibrationUploads()')
      || cleanSummaryClose.includes('this.flushRunUploads()')
      || !cleanSummaryClose.includes('startSummaryHermesUploads(')
      || !cleanSummaryClose.includes('allowDuringExit: true')
      || !summaryFinalizer.includes('startSummaryHermesUploads(')
      || !summaryUploadStarter.includes('flushAiuiCalibrationUploads()')
      || !summaryUploadStarter.includes('flushRunUploads()')) {
    issues.push('AIUI calibration must remain local during the run, batch only after Summary, and use Home only for durable retry');
  }
  if (!text.includes("from '../../lib/aiui_calibration.js'")
      || !text.includes('createAiuiCalibrationStream(startMs)')
      || !text.includes('captureAiuiCalibrationSnapshot(now, motion, {')
      || !/algorithmSpeedMps:\s*this\.isSlowJogMode\(\)\s*\|\|\s*livePaceSec\s*==\s*null\s*\?\s*null\s*:\s*1000\s*\/\s*livePaceSec/.test(text)
      || !text.includes('persistAiuiCalibrationBuffer()')
      || !text.includes('onOwnerDataCleared: () => this.handleCalibrationOwnerDataCleared()')
      || !text.includes(
        'clearDeviceAuth(wx, { coachTokenStorageKey: COACH_TOKEN_STORAGE_KEY })',
      )
      || !home.includes('flushAiuiCalibrationUploads()')
      || !identity.includes("'pending_aiui_calibration_events'")) {
    issues.push('AIUI calibration must persist on lifecycle boundaries, refresh scoped auth safely, isolate owner changes and retry from Home');
  }
  if (!text.includes("from '../../lib/running_local_field_log.js'")
      || !text.includes('beginRunningLocalFieldCapture(startMs)')
      || !text.includes("this.captureRunningLocalFieldSample(now, motion, 'ticker')")
      || !text.includes('finishRunningLocalFieldCapture(pendingSummary, motion, now)')
      || !text.includes('buildRunningLocalFieldLogReplayLines(run)')
      || !text.includes('LOCAL_FIELD_LOG_NOISY_EVENT_INTERVAL_MS = 5 * 60 * 1000')
      || !text.includes('flushRunningLocalFieldNoisyEvents()')
      || !runningLocalFieldLog.includes(
        'RUNNING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS = 5000',
      )
      || !runningLocalFieldLog.includes(
        'RUNNING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RUN = 8640',
      )
      || !runningLocalFieldLog.includes(
        'RUNNING_LOCAL_FIELD_LOG_MAX_TOTAL_BYTES = 2 * 1024 * 1024',
      )
      || !runningLocalFieldLog.includes('const firstByType = new Map()')
      || !runningLocalFieldLog.includes("return 'SMARTRUN_LOCAL_LOG|' + kind")
      || !identity.includes('clearRunningLocalFieldLogs')) {
    issues.push('marathon field archive must retain 12-hour derived capture, first-event anchors, five-minute noisy-event write limiting, owner cleanup and bounded ADB replay');
  }
  if (/navigator\.geolocation|getCurrentPosition|watchPosition|createGeolocationWatch|GpsPathTracker|onGpsPathMeasurement|startRunGeolocationWatch|stopRunGeolocationWatch/.test(text)) {
    issues.push('run HUD must not request unavailable glasses geolocation or use GPS-derived motion');
  }
  if (!/surfacePhase:\s*'ready'/.test(text)) issues.push('run HUD must start in ready');
  if (/role="navigation"[^>]*ink:if|ink:if[^>]*role="navigation"/.test(text)
      || /class="\{\{[^"]*\}\}"[^>]*role="navigation"|role="navigation"[^>]*class="\{\{/.test(text)) {
    issues.push('run HUD navigation containers must be static: literal class, no ink:if (device focus registration)');
  }
  if (/<view[^>]*connect-next[^>]*tabindex=/.test(text)) {
    issues.push('run HUD must not emulate its hardware Next action with view role=button');
  }
  const scanKeyUp = text.slice(text.indexOf('  onKeyUp(event)'), text.indexOf('\n  },', text.indexOf('  onKeyUp(event)')));
  if (/proceedToHud|onScanTap|onConnectTap/.test(scanKeyUp)
      || !/Backspace/.test(scanKeyUp)
      || !/isSurfaceConfirm\s*&&\s*code\s*!==\s*'GlobalHook'[\s\S]*?isSearchPhase\(\)\s*&&\s*this\.searchFocusIndex\s*===\s*0[\s\S]*?\)\s*return;/.test(scanKeyUp)) {
    issues.push('run HUD onKeyUp must preserve native Enter/Space activation for the single search primary button and never jump directly to the HUD');
  }
  if (/autoConnectBle|scheduleAutoConnectBle|startExplicitConnection/.test(onLoad)) {
    issues.push('run HUD onLoad must not start Bluetooth');
  }
  for (const phase of [
    'ready', 'connecting', 'menu', 'training', 'settings', 'binding', 'hud', 'summary',
    'recovery',
  ]) {
    if (!text.includes(`surfacePhase: '${phase}'`)) issues.push(`run HUD lacks ${phase} phase`);
  }
  if (/surfacePhase:\s*'slow-ready'|startSlowRun/.test(text)
      || !/class="slow-metrics"/.test(text)
      || !/openSlowMode/.test(text)
      || !/trackDistance:\s*!this\.isSlowJogMode\(\)/.test(text)
      || !/probeOptionalRsc\(device, server = null\)[\s\S]*?if \(this\.isSlowJogMode\(\)/.test(text)) {
    issues.push('run HUD Slow Jog must reuse search/HUD, keep distance disabled and ignore optional RSC speed');
  }
  for (const token of [
    'data-setting="binding"',
    'settingBindingClass',
    'bindingAiuiId',
    'bindingActionLabel',
    'bindingExportLabel',
    'bindingRefreshClass',
    'bindingExportClass',
    'openDevicePairing',
    'setBindingFocus',
    'onBindingFocus',
    'onBindingTap',
    'onBindingActionTap',
    'onBindingExportTap',
    'replayRunningLocalFieldLog',
    'refreshDeviceIdentity',
    'showSettingsFromBinding',
    'userConfirmed: true',
  ]) {
    if (!text.includes(token)) issues.push(`run HUD Agent Binding is missing: ${token}`);
  }
  if (!/class="setting-row \{\{ settingMetronomeClass \}\}"\s+tabindex="2"\s+data-setting="metronome"\s+data-index="2"/.test(text)
      || !/class="setting-row \{\{ settingGuideQuickExitClass \}\}"\s+tabindex="3"\s+data-setting="guide"\s+data-index="3"/.test(text)
      || !/class="setting-row \{\{ settingBindingClass \}\}"\s+tabindex="4"\s+data-setting="binding"\s+data-index="4"/.test(text)
      || !/class="setting-row \{\{ settingHeartRateClass \}\}"\s+tabindex="5"\s+data-setting="heart"\s+data-index="5"/.test(text)
      || !/class="settings-back \{\{ settingBackClass \}\}"\s+tabindex="6"\s+data-setting="back"\s+data-index="6"/.test(text)
      || !/<view class="binding-screen" ink:if="\{\{ surfacePhase === 'binding' \}\}">/.test(text)
      || !/<text class="binding-label">AIUI ID<\/text>/.test(text)
      || !/<button class="binding-action \{\{ bindingRefreshClass \}\}"\s+tabindex="0"\s+data-action="refresh"\s+data-index="0"\s+bindfocus="onBindingFocus"\s+bindtap="onBindingTap">/.test(text)
      || !/<button class="binding-action binding-action-export \{\{ bindingExportClass \}\}"\s+tabindex="1"\s+data-action="export"\s+data-index="1"\s+bindfocus="onBindingFocus"\s+bindtap="onBindingTap">/.test(text)) {
    issues.push('run HUD Settings must order Stride, Voice, Metronome, Guide, Binding, Heart and Back at indexes 0-6');
  }
  const normalizeSettingsMatch = settings.match(
    /export function normalizeRunSettings\(value\) \{([\s\S]*?)\n\}/,
  );
  const normalizeSettingsBody = stripJsComments(normalizeSettingsMatch ? normalizeSettingsMatch[1] : '');
  if (!/<view class="setting-info">\s*<text class="setting-name">长期记忆<\/text><text class="setting-value">需配置后端<\/text>\s*<\/view>/.test(text)
      || /<button[^>]*data-setting="(?:summary|memory)"|settingAiSummaryClass|settingMemoryClass/.test(text)
      || /key\s*===\s*'(?:summary|memory)'/.test(text)) {
    issues.push('run HUD must present long-term memory and its backend requirement as non-interactive capability copy, never focusable Settings rows');
  }
  if (!/memoryContext:\s*true/.test(settings)
      || !/aiSummary:\s*true/.test(settings)
      || !/memoryContext:\s*true/.test(normalizeSettingsBody)
      || !/aiSummary:\s*true/.test(normalizeSettingsBody)
      || /src\.(?:memoryContext|aiSummary)/.test(normalizeSettingsBody)) {
    issues.push('run settings data layer must keep AI summary and memory-context handling on, including legacy stored false values');
  }
  let metronomeAudio = null;
  try { metronomeAudio = fs.readFileSync(metronomeAudioPath); } catch (_e) {}
  const metronomeWav = inspectPcmWav(metronomeAudio);
  const metronomeBarsOk = metronomeBarAudio.every(([bpm, expectedDurationMs]) => {
    let bytes = null;
    try {
      bytes = fs.readFileSync(path.join(
        ROOT,
        `assets/audio/metro_0468_bar_${bpm}.wav`,
      ));
    } catch (_e) {}
    const wav = inspectPcmWav(bytes);
    return wav
      && wav.pcmFormat === 1
      && wav.channels === 2
      && wav.sampleRate === 44100
      && wav.bitsPerSample === 16
      && Math.abs(wav.durationMs - expectedDurationMs) <= 2
      && wav.durationMs >= 1098
      && wav.durationMs <= 1227
      && wav.firstAudibleMs != null
      && wav.firstAudibleMs <= 12;
  });
  if (!metronomeWav
      || metronomeWav.pcmFormat !== 1
      || metronomeWav.channels !== 2
      || metronomeWav.sampleRate !== 44100
      || metronomeWav.bitsPerSample !== 16
      || metronomeWav.durationMs < 175
      || metronomeWav.durationMs > 200
      || !(metronomeWav.firstAudibleMs != null && metronomeWav.firstAudibleMs <= 12)
      || !metronomeBarsOk) {
    issues.push('metronome must ship the low-latency APK one-shot plus tail-trimmed 160/170/180 BPM four-beat stereo PCM bars');
  }
  for (const token of [
    'new SoundCtor(src)', 'this._sound.play()', 'this._sound.stop()',
    'this._sound.destroy()', 'this._generation', 'clearTimeout(this._timerId)',
    'if (this._destroyed) return false',
  ]) {
    if (!metronome.includes(token)) issues.push(`metronome lifecycle is missing: ${token}`);
  }
  const ensureMetronomeBody = stripJsComments(extractMethodBody(text, 'ensureMetronome'));
  const stopMetronomeBody = stripJsComments(extractMethodBody(text, 'stopMetronomePlayback'));
  const startRunBody = stripJsComments(extractMethodBody(text, 'startRun'));
  const onShowBody = stripJsComments(extractMethodBody(text, 'onShow'));
  const onHideBody = stripJsComments(extractMethodBody(text, 'onHide'));
  const unloadBody = stripJsComments(extractMethodBody(text, 'onUnload'));
  const summaryBody = stripJsComments(extractMethodBody(text, 'finishRunToSummary'));
  const summaryFinalizeBody = stripJsComments(extractMethodBody(text, 'finalizeRunAfterSummaryCommit'));
  const persistSummaryQueuesBody = stripJsComments(
    extractMethodBody(text, 'persistSummaryQueues'),
  );
  const summaryCommitAudit = auditSummaryCommitFirst(summaryBody, summaryFinalizeBody);
  const closeSummaryBody = stripJsComments(extractMethodBody(text, 'closeAgentFromSummary'));
  const settingFocusBody = stripJsComments(extractMethodBody(text, 'setSettingFocus'));
  const settingFocusHandlerBody = stripJsComments(extractMethodBody(text, 'onSettingFocus'));
  const settingTapBody = stripJsComments(extractMethodBody(text, 'onSettingTap'));
  if (!/import \{ Sound \} from 'audio';/.test(text)
      || !/import \{ Metronome \} from '\.\.\/\.\.\/lib\/metronome\.js';/.test(text)
      || !/160:\s*'\.\.\/\.\.\/assets\/audio\/metro_0468_bar_160\.wav'/.test(text)
      || !/170:\s*'\.\.\/\.\.\/assets\/audio\/metro_0468_bar_170\.wav'/.test(text)
      || !/180:\s*'\.\.\/\.\.\/assets\/audio\/metro_0468_bar_180\.wav'/.test(text)
      || !/const METRONOME_BEATS_PER_PLAYBACK = 4;/.test(text)
      || !/new Metronome\([\s\S]*SoundCtor:\s*Sound[\s\S]*src:\s*audioSrc[\s\S]*beatsPerPlayback:\s*METRONOME_BEATS_PER_PLAYBACK/.test(ensureMetronomeBody)) {
    issues.push('run HUD metronome must construct the documented per-BPM four-beat Sound player');
  }
  if (!/metronome\.stop\(\)[\s\S]*options\.destroy === true[\s\S]*metronome\.destroy\(\)/.test(stopMetronomeBody)
      || !/startRunMetronome\(\)/.test(startRunBody)
      || !/startRunMetronome\(\)/.test(onShowBody)
      || !/stopMetronomePlayback\(\)/.test(onHideBody)
      || !/stopMetronomePlayback\(\{ destroy: true \}\)/.test(unloadBody)
      || !/setData\([\s\S]*summaryFinalizeTimer\s*=\s*setTimeout/.test(summaryBody)
      || !/stopMetronomePlayback\(\{ destroy: true \}\)/.test(summaryFinalizeBody)
      || !/stopMetronomePlayback\(\{ destroy: true \}\)/.test(closeSummaryBody)) {
    issues.push('run HUD must stop Sound on hide and destroy the metronome on summary, exit and unload');
  }
  if (!summaryCommitAudit.ok) {
    const details = [];
    if (summaryCommitAudit.firstSetDataIndex < 0) details.push('missing first setData');
    if (summaryCommitAudit.prematureDeferredTokens.length) {
      details.push(`before first setData: ${summaryCommitAudit.prematureDeferredTokens.join(', ')}`);
    }
    if (summaryCommitAudit.missingFinalizerTokens.length) {
      details.push(`missing from finalizer: ${summaryCommitAudit.missingFinalizerTokens.join(', ')}`);
    }
    issues.push(`run HUD summary must commit its first frame before storage/native cleanup (${details.join('; ')})`);
  }
  if (!/queueRunForUpload\(\s*this\.pendingSummarySnapshot\s*\)/.test(
    persistSummaryQueuesBody,
  ) || !/persistAiuiCalibrationBuffer\(\)/.test(persistSummaryQueuesBody)) {
    issues.push('run HUD durable summary finalizer must persist both run summary and calibration queues');
  }
  if (!/next\s*!==\s*2[\s\S]*stopMetronomePlayback\(\)/.test(settingFocusBody)
      || /writeRunSettings|nextMetronomeBpm|metronomeBpm\s*=/.test(settingFocusBody)
      || /writeRunSettings|nextMetronomeBpm|metronomeBpm\s*=/.test(settingFocusHandlerBody)) {
    issues.push('run HUD must stop metronome preview when focus leaves index 2 without changing the saved BPM');
  }
  const focusMayStartMetronome = /startMetronomePreview|startRunMetronome|ensureMetronome/;
  const settingPersistAt = settingTapBody.indexOf('writeRunSettings');
  const settingPreviewAt = settingTapBody.indexOf('startMetronomePreview');
  if (focusMayStartMetronome.test(settingFocusBody)
      || focusMayStartMetronome.test(settingFocusHandlerBody)
      || !/key\s*===\s*'metronome'[\s\S]*next\.metronomeBpm\s*=\s*nextMetronomeBpm\([\s\S]*startMetronomePreview\(bpm\)/.test(settingTapBody)
      || settingPersistAt < 0
      || settingPreviewAt <= settingPersistAt) {
    issues.push('run HUD must never auto-start metronome preview on focus or refocus; only an explicit persisted Metronome activation may start it');
  }
  if (!/key\s*===\s*'back'[\s\S]*showFeatureMenu\(\)[\s\S]*menuEntryConfirmGuardUntilMs\s*=\s*Date\.now\(\)\s*\+\s*SURFACE_ENTRY_CONFIRM_GRACE_MS/.test(settingTapBody)
      || !/claimMenuActivation[\s\S]{0,400}isMenuEntryInputGuarded\(now\)/.test(text)) {
    issues.push('run HUD Settings Back must return to the menu and guard the menu from the same confirmation tail packet');
  }
  const openBindingBody = stripJsComments(extractMethodBody(text, 'openDevicePairing'));
  const bindingActionBody = stripJsComments(extractMethodBody(text, 'onBindingActionTap'));
  const bindingExportBody = stripJsComments(extractMethodBody(text, 'onBindingExportTap'));
  const bindingReplayBody = stripJsComments(
    extractMethodBody(text, 'replayRunningLocalFieldLog'),
  );
  const bindingReturnBody = stripJsComments(
    extractMethodBody(text, 'showSettingsFromBinding'),
  );
  const bindingActionRule = extractRule(text, '.binding-action');
  const bindingFocusedRule = extractRule(text, '.binding-action-focused');
  if (!openBindingBody
      || /recoverFreshAnonymousDeviceIdentity/.test(openBindingBody)
      || !/refreshDeviceIdentity/.test(bindingActionBody)
      || !/readLatestRunningLocalFieldLog/.test(bindingExportBody)
      || !/暂无可导出的跑步日志/.test(bindingExportBody)
      || !/replayRunningLocalFieldLog[\s\S]*onComplete/.test(bindingExportBody)
      || !/typeof options\.onComplete === 'function'[\s\S]*options\.onComplete\(\)/.test(bindingReplayBody)
      || !/cancelRunningLocalFieldLogReplay\(\)/.test(bindingReturnBody)
      || !/bindingExportWasPending[\s\S]*cancelRunningLocalFieldLogReplay\(\)[\s\S]*现场日志导出已暂停/.test(onHideBody)
      || /\boutline(?:-[a-z-]+)?\s*:/.test(bindingActionRule)
      || !/\boutline-width:\s*2px;/.test(bindingFocusedRule)
      || !/\boutline-style:\s*solid;/.test(bindingFocusedRule)
      || !/\boutline-color:\s*var\(--color-primary/.test(bindingFocusedRule)
      || !/\boutline-offset:\s*-2px;/.test(bindingFocusedRule)
      || !text.includes('可在已登录 APK 输入此 ID 绑定')
      || /buildDevicePairCodeRequest|parseDevicePairCodeResponse|device-pair-code|expires_in_s|expiresInS|bindingWindow/.test(text + '\n' + identity)) {
    issues.push('run HUD Agent Binding must expose the permanent current AIUI ID; Confirm refreshes status only when Refresh is focused; Export must use the separate focused field-log action with bounded completion and leave/hide cancellation');
  }
  const recoveryBody = stripJsComments(extractMethodBody(text, 'recoverDeviceIdentityFromBinding'));
  if (!/recoverFreshAnonymousDeviceIdentity/.test(recoveryBody)
      || !/userConfirmed:\s*true/.test(recoveryBody)
      || !identity.includes('opts.userConfirmed !== true')
      || !identity.includes('userConfirmationRequired: true')) {
    issues.push('fresh anonymous recovery must require userConfirmed from the visible binding action');
  }
  if (!text.includes('正在搜索心率设备') || !text.includes('下一步')
      || !text.includes('showConnectedResult') || !text.includes('finishEntry')) {
    issues.push('run HUD lacks active search feedback or the unconditional Next entry');
  }
  if (/navigator\.bluetooth\.getDevices\s*\(/.test(text)
      || /findRememberedBleDevice/.test(text)) {
    issues.push('run HUD must start nearby scanning without waiting for the authorized-device cache');
  }
  if (!/class="unified-grid"\s+ink:if="\{\{ runMode !== 'slow' && showHeartRate \}\}"/.test(text)
      || !/class="glasses-grid"\s+ink:if="\{\{ runMode !== 'slow' && !showHeartRate \}\}"/.test(text)) {
    issues.push('run HUD must expose both the 03 heart-rate and glasses-only states');
  }
  if (!/class="mode-chip"\s+ink:if="\{\{ showHeartRate \}\}"/.test(text)) {
    issues.push('run HUD must hide the heart-rate chip in glasses-only state');
  }
  const hasShortGlassesEstimate = text.includes("motionSourceHint: '眼镜估算'")
    || text.includes("motionSourceHint: 'Glasses est.'");
  const hasRunWarmup = /const RUN_STABILIZE_HINT = '(?:请稳定跑约 5 秒|Run steady ~5 sec)';/.test(text)
    && /const RUN_STABILIZE_MIN_MS = 5000;/.test(text)
    && /class="mode-chip"\s+ink:if="\{\{ runWarmupHint && !safetyHudHint && !hudHint \}\}"[^>]*>\{\{ runWarmupHint \}\}<\/text>/.test(text);
  const hasFrozenPolicyHeartRateSafety = /freezeHeartRatePolicyForRun\(startMs\)/.test(text)
    && /runHeartRateZone\(bpm\)[\s\S]{0,180}this\.frozenHeartRatePolicy/.test(text)
    && /runHeartRateHigh\(bpm\)[\s\S]{0,180}this\.frozenHeartRatePolicy/.test(text);
  const hasVisibleSafetyHeartRateCue = /safetyHudHint:\s*''/.test(text)
    && /safetyHudHint:\s*this\.runHeartRateHigh\([\s\S]{0,160}heartRatePolicyConfidence\(this\.frozenHeartRatePolicy\)\s*===\s*'trusted'[\s\S]{0,120}zone\s*>=\s*5\s*\?\s*'心率 Z5 · 请降速'\s*:\s*'心率偏高 · 请降速'\)\s*:\s*''/.test(text)
    && /class="hud-hint"\s+ink:if="\{\{ safetyHudHint \}\}">\{\{ safetyHudHint \}\}<\/text>/.test(text)
    && /pauseMetronomeForSafetyCue\(\)/.test(text)
    && /resumeMetronomeAfterSafetyCue\(generation\)/.test(text)
    && hasFrozenPolicyHeartRateSafety;
  if (!/class="mode-chip"\s+ink:if="\{\{ !runWarmupHint && !paceConnected && !safetyHudHint && !hudHint \}\}"[^>]*>\{\{ motionSourceHint \}\}<\/text>/.test(text)
      || !/class="mode-chip(?: pace-chip)?"\s+ink:if="\{\{ !runWarmupHint && paceConnected \}\}"/.test(text)
      || !hasShortGlassesEstimate
      || !hasRunWarmup
      || !hasVisibleSafetyHeartRateCue
      || /class="source-note"\s+ink:if="\{\{ !paceConnected && !hudHint \}\}"/.test(text)
      || text.includes('步频 / 配速由眼镜估算')
      || text.includes('未接入设备步频 / 配速 · 已切换眼镜估算')) {
    issues.push('run HUD must freeze its heart-rate policy, show trusted Z5 or conservative high-heart-rate safety copy, keep the five-second stabilization hint and short Glasses Estimate, and expose Pace Live only for live device pace');
  }
  for (const token of [
    'class="feature-nav" role="navigation"',
    'class="settings-list" role="navigation"',
    'const SURFACE_CONFIRM_DEDUPE_MS = 400',
    'tabindex="0"', 'tabindex="1"', 'tabindex="2"', 'tabindex="3"',
    'tabindex="4"', 'tabindex="5"', 'settingBackClass',
  ]) {
    if (!text.includes(token)) issues.push(`run HUD is missing page-owned focus invariant: ${token}`);
  }
  const featureStart = text.indexOf('<view class="feature-menu ');
  const trainingStart = text.indexOf('<view class="training-screen"', featureStart);
  const featureMarkup = featureStart >= 0 && trainingStart > featureStart
    ? text.slice(featureStart, trainingStart) : '';
  if ((featureMarkup.match(/<button\b/g) || []).length !== 6
      || !featureMarkup.includes('bindtap="openFreeMode"')
      || !featureMarkup.includes('bindtap="openSlowMode"')
      || !featureMarkup.includes('bindtap="openGarminVirtualMode"')
      || !featureMarkup.includes('bindtap="openTrainingMode"')
      || !featureMarkup.includes('bindtap="openSettingsMode"')
      || !featureMarkup.includes('>超慢跑</text>')
      || !featureMarkup.includes('>室内跑</text>')
      || !featureMarkup.includes('ink:if="{{ todayWorkoutAvailable }}"')
      || (featureMarkup.match(/bindfocus="onMenuFocus"/g) || []).length !== 6
      || !/shouldAcceptHostFocus[\s\S]*onMenuFocus/.test(text)) {
    issues.push('run HUD feature menu must expose Free Run, Slow Jog, Indoor Run, Training Plans and Settings');
  }
  const settingsListStart = text.indexOf('<view class="settings-list" role="navigation">');
  const settingsFootStart = text.indexOf('<text class="settings-foot">', settingsListStart);
  const settingsMarkup = settingsListStart >= 0 && settingsFootStart > settingsListStart
    ? text.slice(settingsListStart, settingsFootStart) : '';
  if (!/data-setting="stride"[\s\S]*data-setting="voice"[\s\S]*data-setting="metronome"[\s\S]*data-setting="guide"[\s\S]*data-setting="binding"[\s\S]*class="setting-info"[\s\S]*data-setting="heart"[\s\S]*data-setting="back"/.test(settingsMarkup)) {
    issues.push('run HUD Settings visual order must be Stride, Voice, Metronome, Guide, Binding, passive memory status, Heart, then the absolute Back control');
  }
  const settingIndexes = [...settingsMarkup.matchAll(/class="setting-row \{\{ setting[A-Za-z]+Class \}\}"\s+tabindex="(\d)"/g)]
    .map((match) => Number(match[1]));
  if (settingIndexes.join(',') !== '0,1,2,3,4,5') {
    issues.push('run HUD Settings must expose exactly six contiguous configuration rows');
  }
  const passiveSettingsRow = settingsMarkup.match(/<view class="setting-info"([^>]*)>/);
  const settingsCanvasRule = extractRule(text, '.settings-screen');
  const settingsScreenRule = extractLastRule(text, '.settings-screen');
  const settingsTopRule = extractLastRule(text, '.settings-top');
  const settingsListRule = extractLastRule(text, '.settings-list');
  const settingRowRule = extractLastRule(text, '.setting-row');
  const settingInfoRule = extractLastRule(text, '.setting-info');
  const settingsFootRule = extractLastRule(text, '.settings-foot');
  const settingFocusedRule = extractLastRule(text, '.setting-row.setting-row-focused');
  const settingsBackRule = extractLastRule(text, '.settings-back');
  const settingsBackFocusedRule = extractLastRule(
    text,
    '.settings-back.setting-row-focused',
  );
  const settingsVerticalPx = 12 + 36 + 2 + 264 + 2 + 24 + 12;
  if (!/\bwidth:\s*480px;/.test(settingsCanvasRule)
      || !/\bheight:\s*352px;/.test(settingsCanvasRule)
      || !/\bbox-sizing:\s*border-box;/.test(settingsCanvasRule)
      || !/\bpadding:\s*12px 14px;/.test(settingsScreenRule)
      || !/\bheight:\s*36px;/.test(settingsTopRule)
      || !/\bheight:\s*264px;/.test(settingsListRule)
      || !/\bmargin:\s*2px 0 0;/.test(settingsListRule)
      || !/\bheight:\s*40px;/.test(settingRowRule)
      || !/\bheight:\s*24px;/.test(settingInfoRule)
      || !/\bheight:\s*24px;/.test(settingsFootRule)
      || !/\bmargin:\s*2px 0 0;/.test(settingsFootRule)
      || !/\bline-height:\s*24px;/.test(settingsFootRule)
      || settingsVerticalPx !== 352) {
    issues.push('run HUD Settings must use six 40px controls plus one 24px passive row, a 264px list, and a 24px footer inside the 480x352 canvas');
  }
  const settingsStyle = text.slice(text.indexOf('<style>'));
  if ((settingsMarkup.match(/<button\b/g) || []).length !== 7
      || (settingsMarkup.match(/class="setting-row /g) || []).length !== 6
      || (settingsMarkup.match(/class="setting-info"/g) || []).length !== 1
      || !passiveSettingsRow
      || /\b(?:tabindex|role|bindfocus|bindtap)\s*=/.test(passiveSettingsRow ? passiveSettingsRow[1] : '')
      || /\boutline(?:-[a-z-]+)?\s*:/.test(settingRowRule)
      || /\boutline(?:-[a-z-]+)?\s*:/.test(settingInfoRule)
      || /\boutline(?:-[a-z-]+)?\s*:/.test(settingsBackRule)
      || !/\boutline-width:\s*2px;/.test(settingFocusedRule)
      || !/\boutline-width:\s*2px;/.test(settingsBackFocusedRule)
      || !/\boutline-style:\s*solid;/.test(settingsBackFocusedRule)
      || !/\boutline-offset:\s*-2px;/.test(settingsBackFocusedRule)
      || /\.setting-info[^,{]*(?:focus|focused)[^{]*\{/.test(settingsStyle)) {
    issues.push('run HUD Settings must expose seven interactive targets with inward focus only on the selected target; the long-term-memory row remains passive');
  }
  if (!/const SETTINGS_FOCUS_COUNT = 7;/.test(text)
      || !/raw % SETTINGS_FOCUS_COUNT/.test(settingFocusBody)
      || !/const keys = \[\s*'stride', 'voice', 'metronome', 'guide', 'binding', 'heart', 'back',\s*\]/.test(text)) {
    issues.push('run HUD Settings keyboard routing must be stride, voice, metronome, guide, binding, heart and back');
  }
  if (/class="(?:passive-footer|hud-footer|hud-heart-card)"/.test(text)) {
    issues.push('run HUD must keep the latest footer-free layout');
  }
  const containerRule = extractRule(text, '.container');
  if (!/\bmin-height:\s*352px;/.test(containerRule)
      || !/\bflex-direction:\s*column;/.test(containerRule)) {
    issues.push('run entry container must be the sample-clone flow root with a 352px floor');
  }
  const runRule = extractRule(text, '.run-screen');
  if (!/\bjustify-content:\s*flex-end;/.test(runRule)
      || !/\bpadding:\s*5px 10px 4px;/.test(runRule)) {
    issues.push('run HUD metrics must stay anchored to the bottom safe area');
  }
  for (const grid of [
    'grid-template-columns: 84px 92px 116px 149px;',
    'grid-template-columns: 14px 68px 60px 80px 94px 115px;',
  ]) {
    if (!text.includes(grid)) issues.push(`run HUD is missing the 456px grid: ${grid}`);
  }
  if (/pace:\s*(?:'正在计算'|'Calculating')/.test(text)
      || !/const\s+INITIAL_PACE\s*=\s*formatPace\(null\)/.test(text)
      || !/pace:\s*INITIAL_PACE/.test(text)
      || !/cadence:\s*CADENCE_PENDING/.test(text)
      || !/if\s*\(cadenceReady\)\s*this\.cadenceEverReady\s*=\s*true;/.test(text)
      || !/const cadenceVal\s*=\s*Number\.isFinite\(stickyCadenceSpm\)\s*&&\s*stickyCadenceSpm\s*>\s*0\s*\?\s*formatCadence\(stickyCadenceSpm\)\s*:\s*CADENCE_PENDING;/.test(text)
      || !/cadence:\s*cadenceVal/.test(text)
      || /cadence:\s*(?:0|'0'|"0"|String\(\s*dispCadence\s*\))/.test(text)
      || !/estimatePaceSecPerKmFromCadence/.test(text)
      || !/pace:\s*paceVal/.test(text)
      || !/paceStateClass:\s*''/.test(text)) {
    issues.push('run HUD must keep a safe numeric pace after trusted motion, expire stale cadence to -- after its short hold, and never render cadence as a literal zero');
  }
  const environmentRule = extractRule(text, '.hud-environment');
  if (!/<text class="hud-environment"\s+ink:if="\{\{ !safetyHudHint && !hudHint \}\}">\{\{ hudEnvironment \}\}<\/text>/.test(text)
      || !/formatHudClock/.test(text)
      || /refreshHudWeather|lib\/weather\.js/.test(text)
      || !/\bwidth:\s*154px;/.test(environmentRule)
      || !/\bline-height:\s*26px;/.test(environmentRule)) {
    issues.push('run HUD top row must show local time without weather or blocking status chips');
  }
  const metricRule = extractRule(text, '.run-metric');
  if (!/\bborder:\s*0;/.test(metricRule)
      || !/\bborder-radius:\s*0;/.test(metricRule)
      || !/\bbackground-color:\s*transparent;/.test(metricRule)) {
    issues.push('run HUD passive metrics must remain borderless and transparent');
  }
  if (!/hudHint:\s*''/.test(text) || text.includes('扫描已停止 · 确认键结束')) {
    issues.push('run HUD normal state must keep hudHint empty and must not restore the old scan-stopped/end helper copy');
  }
  const unifiedStart = text.indexOf('<view class="unified-grid"');
  const glassesStart = text.indexOf('<view class="glasses-grid"');
  const slowStart = text.indexOf('<view class="slow-metrics"');
  const unifiedMarkup = unifiedStart >= 0 && glassesStart > unifiedStart
    ? text.slice(unifiedStart, glassesStart) : '';
  const glassesMarkup = glassesStart >= 0 && slowStart > glassesStart
    ? text.slice(glassesStart, slowStart) : '';
  const zoneRule = extractRule(text, '.zone');
  const dotRule = extractRule(text, '.dot');
  const dotOnRule = extractRule(text, '.dot-on');
  if (!/<view class="zone">\s*<view class="\{\{ dot5 \}\}"><\/view>\s*<view class="\{\{ dot4 \}\}"><\/view>\s*<view class="\{\{ dot3 \}\}"><\/view>\s*<view class="\{\{ dot2 \}\}"><\/view>\s*<view class="\{\{ dot1 \}\}"><\/view>\s*<\/view>\s*<view class="run-metric run-hero">/.test(unifiedMarkup)
      || !/heartZoneDotFields\(zone\)/.test(text)
      || !/\bflex-direction:\s*column;/.test(zoneRule)
      || !/\bwidth:\s*14px;/.test(zoneRule)
      || !/\bwidth:\s*10px;/.test(dotRule)
      || !/\bheight:\s*6px;/.test(dotRule)
      || !/\bbackground-color:\s*var\(--color-primary/.test(dotOnRule)) {
    issues.push('run HUD heart-rate state must restore the five-dot Z5-to-Z1 zone indicator to the left of heart rate');
  }
  for (const [name, markup] of [['heart-rate', unifiedMarkup], ['glasses-only', glassesMarkup]]) {
    const pace = Math.max(markup.lastIndexOf('>配速</text>'), markup.lastIndexOf('>Pace</text>'));
    const elapsed = Math.max(markup.lastIndexOf('>时长</text>'), markup.lastIndexOf('>Time</text>'));
    if (pace < 0 || elapsed < 0 || pace < elapsed) {
      issues.push(`run HUD ${name} state must keep pace in the rightmost metric column`);
    }
  }
  for (const token of [
    'writeHeartRateDevice',
    "filters: [{ services: ['heart_rate'] }]",
    'scanDiagnostic',
    '[SmartRun BLE]',
    'SCAN_REQUEST',
    'SCAN_ACTIVE',
    'DEVICE_FOUND',
    'SCAN_STOPPED',
    'scanStartedSuccessfully',
    'clearScanRetryTimer',
    '等待附近设备广播',
    '单击“下一步”使用眼镜估算',
    '当前无法搜索蓝牙设备',
    '单击“下一步”继续',
    '搜索失败，可使用眼镜估算',
    '正在连接心率设备',
    '点按设备重试',
    '<text class="hint" ink:if="{{ discoveredDeviceCount === 0 }}">{{ scanDiagnostic }}</text>',
    "const HR_MEASUREMENT_UUID = '00002a37-0000-1000-8000-00805f9b34fb';",
    'await device.gatt.connect()',
    "await server.getPrimaryService('heart_rate')",
    'await service.getCharacteristic(HR_MEASUREMENT_UUID)',
    'await characteristic.startNotifications()',
    'control-card',
    'primary-button',
    'bindtap="selectDevice"',
    'keyBeacon',
    'proceedToHud',
    'ensureBleAvailable',
    'startDiscovery',
    'discoveredDevices',
    'discoveredDeviceCount',
    'recordDiscoveredDevice',
    'syncDiscoveredDevices',
    'scheduleHrWatchdog',
    'clearHrWatchdogTimer',
    'pendingEntryBpm = null',
    'hrSubscribedAtMs',
    'm.bpm <= 0 || m.bpm >= 255',
  ]) {
    if (!text.includes(token)) issues.push(`run HUD is missing BLE gate invariant: ${token}`);
  }
  if (!/navigator\.bluetooth\.scanDevices\(\{\s*filters: \[\{ services: \['heart_rate'\] \}\],\s*\}\)/.test(text)) {
    issues.push('run HUD scan options must be fresh per-call literals matching the official sample shapes');
  }
  if (/Object\.freeze\(\{\s*(?:filters|acceptAllDevices)/.test(text)) {
    issues.push('run HUD must not pass frozen/shared options objects across the host bridge');
  }
  if (/navigator\.bluetooth\.getAvailability/.test(text)) {
    issues.push('run HUD must not pre-probe getAvailability before scanDevices (sample-clone contract)');
  }
  if (/\boptionalServices\s*:/.test(text)) {
    issues.push('run HUD scan must not add optionalServices to either scan request');
  }
  const searchNav = text.match(
    /<view class="connect-next-nav" role="navigation">([\s\S]*?)<\/view>/,
  );
  if (!searchNav
      || (searchNav[1].match(/<button\b/g) || []).length !== 1
      || !/class="primary-button \{\{ searchPrimaryClass \}\}"[\s\S]*tabindex="0"[\s\S]*bindfocus="onSearchFocus"[\s\S]*bindtap="onScanTap"/.test(searchNav[1])
      || !/class="device-row \{\{ item\.deviceSelectedClass \}\} \{\{ item\.deviceFocusClass \}\}"/.test(text)
      || /<view class="list-card"[^>]*role="navigation"/.test(text)) {
    issues.push('run HUD search must keep one main button in a static role=navigation container and dynamic devices outside');
  }
  const tickerBody = stripJsComments(extractMethodBody(text, 'startTicker'));
  const signalTickerBody = stripJsComments(extractMethodBody(text, 'requestRunTick'));
  if (!/setInterval\(\(\) => this\.requestRunTick\('timer'\), TICK_MS\)/.test(tickerBody)
      || /setData\(/.test(tickerBody)
      || !/this\.tick\(\)/.test(signalTickerBody)
      || /setInterval\(|setData\(/.test(signalTickerBody)) {
    issues.push('run HUD must keep one bounded timer routed through the shared tick throttle');
  }
  if (/CONNECT_DEADLINE_MS|MAX_AUTO_BLE_ATTEMPTS/.test(text)) {
    issues.push('run HUD must not restore an automatic entry deadline or a finite search-attempt cap');
  }
  const keyUpStart = text.indexOf('  onKeyUp(event) {');
  const keyUpEnd = text.indexOf('\n  },\n};', keyUpStart);
  const keyUpBlock = keyUpStart >= 0 && keyUpEnd > keyUpStart
    ? text.slice(keyUpStart, keyUpEnd) : '';
  const keyDownBody = stripJsComments(extractMethodBody(text, 'onKeyDown'));
  const directionCodeBody = stripJsComments(extractMethodBody(text, 'isSurfaceDirectionCode'));
  const directionHandlerBody = stripJsComments(
    extractMethodBody(text, 'handleSurfaceDirection'),
  );
  const hostFocusBody = stripJsComments(extractMethodBody(text, 'onHostFocus'));
  const hostBlurBody = stripJsComments(extractMethodBody(text, 'onHostBlur'));
  const nativeSearchPrimary = keyUpBlock.indexOf("if (isSurfaceConfirm && code !== 'GlobalHook'");
  const searchFallback = keyUpBlock.indexOf('if (isSurfaceConfirm', nativeSearchPrimary + 1);
  const fallbackPreventDefault = keyUpBlock.indexOf('preventDefault', searchFallback);
  const fallbackActivation = Math.max(
    keyUpBlock.indexOf('activateSearchFocused', searchFallback),
    keyUpBlock.indexOf('activateMultiTargetFocused', searchFallback),
  );
  if (/proceedToHud|onScanTap|onConnectTap/.test(keyUpBlock)
      || !/ArrowUp[\s\S]*ArrowDown[\s\S]*ArrowLeft[\s\S]*ArrowRight/.test(directionCodeBody)
      || !/isSurfaceDirectionCode[\s\S]*canHandleSurfaceDirection[\s\S]*DIRECTION_KEYDOWN/.test(keyDownBody)
      || /handleSurfaceDirection|setMenuFocus|setSettingFocus|setBindingFocus|setSearchFocus/.test(keyDownBody)
      || !/isSurfaceDirectionCode[\s\S]*preventDefault[\s\S]*handleSurfaceDirection\(code, Date\.now\(\), 'keyup'\)/.test(keyUpBlock)
      || /surfaceDirectionDownClaims|DIRECTION_KEYUP_CONSUMED/.test(text)
      || !/clearPendingSurfaceGlobalHook\(\)[\s\S]*DIRECTION_RELEASE_GUARD_MS[\s\S]*setBindingFocus[\s\S]*setSearchFocus/.test(directionHandlerBody)
      || !/HOST_FOCUS/.test(hostFocusBody)
      || !/clearPendingSurfaceGlobalHook\(\)[\s\S]*HOST_BLUR/.test(hostBlurBody)
      || /clearSurfaceDirectionBurst\(\)/.test(hostBlurBody)
      || !/Enter[\s\S]*NumpadEnter[\s\S]*Space[\s\S]*GlobalHook/.test(keyUpBlock)
      || nativeSearchPrimary < 0
      || !/isSearchPhase\(\)\s*&&\s*this\.searchFocusIndex\s*===\s*0[\s\S]*?\)\s*return;/.test(keyUpBlock.slice(nativeSearchPrimary, searchFallback))
      || /surfacePhase === 'binding'/.test(keyUpBlock.slice(nativeSearchPrimary, searchFallback))
      || searchFallback <= nativeSearchPrimary
      || fallbackPreventDefault <= searchFallback
      || fallbackActivation <= fallbackPreventDefault
      || !/isSummaryPhase\s*\(\s*\)[\s\S]*preventDefault[\s\S]*closeAgentFromSummary/.test(keyUpBlock)
      || !/surfacePhase\s*===\s*'hud'[\s\S]*preventDefault[\s\S]*onHudConfirmKey/.test(keyUpBlock)) {
    issues.push('run HUD must commit custom direction focus only on keyup, preserve host-focus churn safety, and keep the primary search button native for Enter/Space');
  }
  const multiTargetBody = stripJsComments(extractMethodBody(text, 'isMultiTargetSurface'));
  const activateMultiTargetBody = stripJsComments(
    extractMethodBody(text, 'activateMultiTargetFocused'),
  );
  const deferGlobalHookStart = text.indexOf('  deferSurfaceGlobalHook(');
  const deferGlobalHookEnd = text.indexOf('  isTimedInputGuarded(', deferGlobalHookStart);
  const deferGlobalHookBody = stripJsComments(
    deferGlobalHookStart >= 0 && deferGlobalHookEnd > deferGlobalHookStart
      ? text.slice(deferGlobalHookStart, deferGlobalHookEnd) : '',
  );
  const directionCancelIndex = directionHandlerBody.indexOf('this.clearPendingSurfaceGlobalHook()');
  const directionDeltaIndex = directionHandlerBody.indexOf(
    "const delta = code === 'ArrowDown' || code === 'ArrowRight' ? 1 : -1;",
  );
  const menuFocusBody = stripJsComments(extractMethodBody(text, 'setMenuFocus'));
  const directionClaimBody = stripJsComments(extractMethodBody(text, 'claimSurfaceDirection'));
  if (!/const DIRECTION_RELEASE_GUARD_MS = 600;/.test(text)
      || !/const DIRECTION_REPEAT_DEDUPE_MS = 220;/.test(text)
      || !/const DIRECTION_ALIAS_DEDUPE_MS = 600;/.test(text)
      || !/const MENU_FOCUS_COUNT = 5;/.test(text)
      || !/const TRAINING_FOCUS_COUNT = 5;/.test(text)
      || !/surfaceEntryConfirmGuardUntilMs = now \+ DIRECTION_RELEASE_GUARD_MS;/.test(directionHandlerBody)
      || directionCancelIndex < 0
      || directionDeltaIndex <= directionCancelIndex
      || !/claimSurfaceDirection\(code, delta, now\)/.test(directionHandlerBody)
      || !/setMenuFocus\(this\.menuFocusIndex \+ delta\)/.test(directionHandlerBody)
      || !/setTrainingFocus\(this\.trainingFocusIndex \+ delta\)/.test(directionHandlerBody)
      || !/setSettingFocus\(this\.settingFocusIndex \+ delta\)/.test(directionHandlerBody)
      || !/setBindingFocus\(this\.bindingFocusIndex \+ delta\)/.test(directionHandlerBody)
      || !/setSearchFocus\(this\.searchFocusIndex \+ delta\)/.test(directionHandlerBody)
      || !/const count = this\.todayWorkoutPlan \? MENU_FOCUS_COUNT \+ 1 : MENU_FOCUS_COUNT;[\s\S]*raw % count/.test(menuFocusBody)
      || !/raw % SETTINGS_FOCUS_COUNT/.test(settingFocusBody)
      || !/lastSurfaceDirectionPhase === phase[\s\S]*lastSurfaceDirectionDelta === delta[\s\S]*DIRECTION_REPEAT_DEDUPE_MS[\s\S]*DIRECTION_ALIAS_DEDUPE_MS/.test(directionClaimBody)
      || /lastSurfaceActivationId\s*===\s*actionId/.test(text)) {
    issues.push('run HUD must map all four direction keys to wrapped forward/back focus with a 600ms release guard');
  }
  if (!/const GLOBAL_HOOK_DISAMBIGUATE_MS = 600;/.test(text)
      || !/surfacePhase === 'menu'[\s\S]*surfacePhase === 'training'[\s\S]*surfacePhase === 'settings'[\s\S]*surfacePhase === 'binding'[\s\S]*isSearchPhase\(\)/.test(multiTargetBody)
      || !/\['free', 'slow', 'garmin_virtual', 'training', 'settings'\]/.test(activateMultiTargetBody)
      || !/isRecoveryChoicePhase\(\)[\s\S]*activateRecoveryCompletionFocused\(\)/.test(activateMultiTargetBody)
      || !/selected === 'slow'[\s\S]*openSlowMode\(\)/.test(activateMultiTargetBody)
      || !/selected === 'garmin_virtual'[\s\S]*openGarminVirtualMode\(\)/.test(activateMultiTargetBody)
      || !/selected === 'training'[\s\S]*openTrainingMode\(\)/.test(activateMultiTargetBody)
      || !/selected === 'settings'[\s\S]*openSettingsMode\(\)/.test(activateMultiTargetBody)
      || !/surfacePhase === 'training'[\s\S]*activateTrainingFocused\(\)/.test(activateMultiTargetBody)
      || !/onSettingTap\s*\(/.test(activateMultiTargetBody)
      || !/surfacePhase === 'binding'[\s\S]*bindingFocusIndex === 1[\s\S]*onBindingExportTap\(\)[\s\S]*onBindingActionTap\(\)/.test(activateMultiTargetBody)
      || !/activateSearchFocused\s*\(/.test(activateMultiTargetBody)
      || !/isMultiTargetSurface\(\)/.test(deferGlobalHookBody)
      || !/setTimeout\s*\(/.test(deferGlobalHookBody)
      || !/activateMultiTargetFocused\s*\(/.test(deferGlobalHookBody)
      || !/GLOBAL_HOOK_DISAMBIGUATE_MS/.test(deferGlobalHookBody)
      || !/code === 'GlobalHook'\s*&&\s*isMultiTarget[\s\S]*preventDefault[\s\S]*deferSurfaceGlobalHook\(Date\.now\(\)\)[\s\S]*return;/.test(keyUpBlock)
      || !/isStableConfirm\s*&&\s*isMultiTarget\)\s*this\.clearPendingSurfaceGlobalHook\(\)/.test(keyUpBlock)) {
    issues.push('run HUD must defer multi-target GlobalHook for 600ms and cancel it when a direction or stable confirm disambiguates the gesture');
  }
  if (/proceedToHud\s*\(/.test(keyUpBlock)) {
    issues.push('run HUD onKeyUp must never jump straight to proceedToHud');
  }
  if (!/surfacePhase\s*===\s*'binding'[\s\S]*preventDefault[\s\S]*showSettingsFromBinding/.test(keyUpBlock)) {
    issues.push('run HUD Agent Binding Backspace must return to Settings');
  }
  const connectedStart = text.indexOf('  showConnectedResult(');
  const finishStart = text.indexOf('  finishEntry(', connectedStart);
  const connectedBlock = connectedStart >= 0 && finishStart > connectedStart
    ? text.slice(connectedStart, finishStart) : '';
  if (/finishEntry\s*\(/.test(connectedBlock)) {
    issues.push('a heart-rate result must remain on Screen 02 until Next');
  }
  const outcomeStart = text.indexOf('  markEntryConnectionOutcome(');
  const showConnectedStart = text.indexOf('  showConnectedResult(', outcomeStart);
  const outcomeBlock = outcomeStart >= 0 && showConnectedStart > outcomeStart
    ? text.slice(outcomeStart, showConnectedStart) : '';
  if (/autoFallbackDevice/.test(text)) {
    issues.push('run HUD must not contain the obsolete automatic fallback chain');
  }
  return issues;
}

// Design constraint: no emoji anywhere in page markup or HTML previews.
function scanEmoji() {
  const offenders = [];
  for (const rel of [...PAGE_FILES, ...listPreviewHtml()]) {
    const text = readText(rel);
    if (text !== null && EMOJI_PATTERN.test(text)) offenders.push(rel);
  }
  return offenders;
}

// Design constraint: single green accent. Grayscale (r == g == b) and
// green-dominant (g strictly greater than both r and b) colors are allowed.
function isAllowedRgb(r, g, b) {
  if (r === g && g === b) return true;
  return g > r && g > b;
}

function parseHexColor(hex) {
  const digits = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  return [
    parseInt(digits.slice(0, 2), 16),
    parseInt(digits.slice(2, 4), 16),
    parseInt(digits.slice(4, 6), 16),
  ];
}

function scanStyleColors() {
  const offenders = [];
  for (const rel of PAGE_FILES) {
    const text = readText(rel);
    if (text === null) continue;
    for (const styleMatch of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
      const css = styleMatch[1];
      for (const m of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
        const [r, g, b] = parseHexColor(m[1]);
        if (!isAllowedRgb(r, g, b)) offenders.push(`${rel}: ${m[0]}`);
      }
      for (const m of css.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/gi)) {
        if (!isAllowedRgb(Number(m[1]), Number(m[2]), Number(m[3]))) {
          offenders.push(`${rel}: ${m[0]})`);
        }
      }
      const named = css.match(NAMED_COLOR_BLACKLIST);
      if (named) offenders.push(`${rel}: named color "${named[0]}"`);
    }
  }
  return offenders;
}

function scanWxssSupport() {
  const offenders = [];
  for (const rel of PAGE_FILES) {
    const text = readText(rel);
    if (text === null) continue;
    for (const styleMatch of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
      const css = styleMatch[1].replace(/\/\*[\s\S]*?\*\//g, '');
      for (const atRule of css.matchAll(/@([a-z-]+)/gi)) {
        const name = atRule[1].toLowerCase();
        if (!ALLOWED_WXSS_AT_RULES.has(name)) offenders.push(`${rel}: @${name}`);
      }
      for (const mediaRule of css.matchAll(/@media\s*\(([^)]*)\)/gi)) {
        if (!/^\s*target\s*:\s*_(?:current|blank)\s*$/i.test(mediaRule[1])) {
          offenders.push(`${rel}: unsupported @media (${mediaRule[1].trim()})`);
        }
      }
      if (/(?:linear|radial)-gradient\s*\(/i.test(css)) {
        offenders.push(`${rel}: CSS gradient`);
      }
      if (/:nth-child\s*\(/i.test(css)) offenders.push(`${rel}: :nth-child selector`);
      for (const block of css.matchAll(/\{([^{}]*)\}/g)) {
        for (const part of block[1].split(';')) {
          const declaration = part.trim();
          if (!declaration) continue;
          const propertyMatch = declaration.match(/^(--[\w-]+|[a-z][\w-]*)\s*:\s*(.+)$/i);
          if (!propertyMatch) continue;
          const property = propertyMatch[1].toLowerCase();
          const value = propertyMatch[2].trim().toLowerCase();
          if (!property.startsWith('--') && !ALLOWED_WXSS_PROPERTIES.has(property)) {
            offenders.push(`${rel}: ${property}`);
          } else if (property === 'display' && !/^(?:flex|grid)$/.test(value)) {
            offenders.push(`${rel}: display:${value}`);
          } else if (property === 'position'
              && !/^(?:static|relative|absolute|fixed)$/.test(value)) {
            offenders.push(`${rel}: position:${value}`);
          }
        }
      }
    }
  }
  return [...new Set(offenders)];
}

const pkg = readPackageJson('package.json') || {};
const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const missingPages = PAGE_FILES.filter((rel) => !exists(rel));
const emojiOffenders = scanEmoji();
const colorOffenders = scanStyleColors();
const wxssOffenders = scanWxssSupport();
const canvasIssues = scanCanvasSizes();
const surfaceRegistrationIssues = scanSurfaceRegistration();
const styleEntryIssues = scanStyleEntry();
const homeAlignmentIssues = scanHomePixelAlignment();
const homeVersionIssues = scanHomeVersionLabel(pkg.version);
const backspaceIssues = scanHostBackspacePolicy();
const runEntryIssues = scanRunEntryPolicy();
const staticPrimaryUiIssues = scanStaticPrimaryUi();
const recoveryAssetIssues = scanRecoveryAssets();
const aixCliSource = readText('node_modules/@yodaos-pkg/aix-cli/dist/cli.js') || '';
const officialPackHelper = readText('tools/official_aix_pack.mjs') || '';
const installedAixCli = readPackageJson('node_modules/@yodaos-pkg/aix-cli/package.json');
const aixPreviewReady = exists('node_modules/.bin/aix')
  && /PREVIEW_WIDTH\s*=\s*480\b/.test(aixCliSource)
  && /PREVIEW_HEIGHT\s*=\s*352\b/.test(aixCliSource);
const officialPreparedPackerReady = installedAixCli?.version === '0.8.2'
  && /pack_aix:\s*packAix/.test(officialPackHelper)
  && /packAix\(preparedFiles, normalizedBuildId, engineRange, null\)/.test(officialPackHelper)
  && /READABLE_RUNTIME_RE\s*=\s*\/\\\.\(\?:js\|mjs\|cjs\|ink\|wxss\)/.test(officialPackHelper)
  && /calculateAixPackageId/.test(officialPackHelper)
  && /createReadableZip/.test(officialPackHelper)
  && /deflateRawSync/.test(officialPackHelper)
  && /compressionMethod\s*!==\s*8/.test(officialPackHelper)
  && /Readable AIX unexpectedly rewrote prepared file/.test(officialPackHelper)
  && !/pack_aix_from_source\s*\(/.test(officialPackHelper);

const checks = [
  check('AIUI manifest', exists('AGENTS.md') && exists('app.json') && exists('app.js')),
  check('AIUI pages', missingPages.length === 0,
    missingPages.length ? `missing ${missingPages.join(', ')}` : `${PAGE_FILES.length} pages present`),
  check('create-aiui-agent CLI', exists('node_modules/.bin/create-aiui-agent'),
    deps['@yodaos-pkg/create-aiui-agent'] || 'not installed'),
  check('AIX reader package', exists('node_modules/@yodaos-pkg/aix/index.js'),
    deps['@yodaos-pkg/aix'] || 'not installed'),
  check('official AIX preview CLI', aixPreviewReady,
    aixPreviewReady ? `${deps['@yodaos-pkg/aix-cli']} at 480x352` : 'missing or viewport mismatch'),
  check('official-compatible readable AIX packer', officialPreparedPackerReady,
    officialPreparedPackerReady
      ? `@yodaos-pkg/aix-cli 0.8.2 oracle, readable JS/Ink/WXSS, AIUI ${AIUI_TARGET_VERSION}, engine ${AIUI_ENGINE_RANGE}`
      : 'prepared-file oracle or readable-runtime manifest finalizer is missing or incompatible'),
  check('no emoji glyphs', emojiOffenders.length === 0,
    emojiOffenders.length ? emojiOffenders.join(', ') : 'pages and previews scanned'),
  check('single green palette', colorOffenders.length === 0,
    colorOffenders.length ? colorOffenders.join('; ') : 'grayscale and green-dominant colors only'),
  check('confirmed AIUI WXSS only', wxssOffenders.length === 0,
    wxssOffenders.length ? wxssOffenders.join('; ') : 'all production style properties are documented'),
  check('static production UI', staticPrimaryUiIssues.length === 0,
    staticPrimaryUiIssues.length
      ? staticPrimaryUiIssues.join('; ')
      : 'Production .ink is motion-free; browser previews are review-only; timed guides use bounded packaged GIF playback'),
  check('warm-up/recovery wearables and TTS', recoveryAssetIssues.length === 0,
    recoveryAssetIssues.length
      ? recoveryAssetIssues.join('; ')
      : '8 compact infinite-loop 160x160 GIFs with visible motion plus two one-minute speech guides'),
  check('fixed AIUI canvases', canvasIssues.length === 0,
    canvasIssues.length ? canvasIssues.join('; ') : 'conversation 448x150; immersive 480x352'),
  check('page surface registration', surfaceRegistrationIssues.length === 0,
    surfaceRegistrationIssues.length
      ? surfaceRegistrationIssues.join('; ')
      : 'default title-only immersive route derives _blank; title-only 448x150 compatibility fallback derives _current; no glasses location permission'),
  check('AIX layout discovery', styleEntryIssues.length === 0,
    styleEntryIssues.length ? styleEntryIssues.join('; ') : 'root selectors start each style block'),
  check('whole-pixel Home alignment', homeAlignmentIssues.length === 0,
    homeAlignmentIssues.length
      ? homeAlignmentIssues.join('; ')
      : '448x150 card and all vertical edges resolve to integer pixels'),
  check('visible Home version', homeVersionIssues.length === 0,
    homeVersionIssues.length
      ? homeVersionIssues.join('; ')
      : `v${pkg.version} shown beside SmartRun without shifting the centered title`),
  check('phase-aware Backspace', backspaceIssues.length === 0,
    backspaceIssues.length
      ? backspaceIssues.join('; ')
      : 'Screen 02 preserves host return; HUD Back preserves the three-confirm guard; Recovery chooses Summary or bounded cleanup exit'),
  check('explicit Run entry', runEntryIssues.length === 0,
    runEntryIssues.length
      ? runEntryIssues.join('; ')
      : 'Seven Settings targets, guarded 0.16.1 World Awareness with 0.15 sensor fallback, and Screen 02 to Warm-up to HUD entry are ready'),
];

console.log('');
console.log('AIUI workflow notes:');
console.log('- npm run build:local creates a source .aix and verifies it with @yodaos-pkg/aix.');
console.log('- Official signing, final packaging, and upload remain in AIUI Studio.');
console.log('- Memory-backend credentials and storage routing are deployment configuration, not app secrets.');

if (checks.some((ok) => !ok)) process.exit(1);
