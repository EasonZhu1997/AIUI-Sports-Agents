import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIX_UUID_V4_RE } from './bump_version.mjs';
import { assertAixPlatformFootprint } from './aix_size_budget.mjs';
import { auditSummaryCommitFirst } from './summary_commit_guard.mjs';
import { ORPHAN_LIB_FILES } from './pack_excludes.mjs';
import {
  AIX_LOCALES,
  AIX_MANIFEST_FILE,
  AIX_PROVENANCE_FILE,
  AIUI_ENGINE_RANGE,
  AIUI_TARGET_VERSION,
  computeAixTreeSha256,
  computeReleaseSourceTreeSha256,
  parseAndVerifyAixProvenance,
} from './aix_provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT_VERSION = String(JSON.parse(
  await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'),
).version || '').trim();
const CN_RELEASE_NAME = `AISmartRun-AIUI-v${PRODUCT_VERSION}-cn.aix`;
const EN_RELEASE_NAME = `AISmartRun-AIUI-v${PRODUCT_VERSION}-en.aix`;
const JA_RELEASE_NAME = `AISmartRun-AIUI-v${PRODUCT_VERSION}-ja.aix`;
const requestedTarget = process.argv[2] === '--en'
  ? `release/${EN_RELEASE_NAME}`
  : (process.argv[2] === '--ja'
    ? `release/${JA_RELEASE_NAME}`
    : (process.argv[2] || `release/${CN_RELEASE_NAME}`));
const TARGET = path.resolve(ROOT, requestedTarget);
const require = createRequire(import.meta.url);
const AIX_CLI_READER = path.join(
  ROOT,
  'node_modules/@yodaos-pkg/aix-cli/dist/pkg/aix_web.js',
);

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

const REQUIRED_FILES = [
  '.aixignore',
  AIX_MANIFEST_FILE,
  AIX_PROVENANCE_FILE,
  'AGENTS.md',
  'VERSION',
  'app.json',
  'package.json',
  'lib/aiui_calibration.js',
  'lib/device_identity.js',
  'lib/heart_rate_policy.js',
  'lib/imu.js',
  'lib/adaptive_stride.js',
  'lib/metronome.js',
  'lib/motion_quality.js',
  'lib/motion_metrics.js',
  'lib/rsc.js',
  'lib/run_upload.js',
  'lib/running_local_field_log.js',
  'lib/warmup_guide.js',
  'lib/recovery_guide.js',
  'lib/session.js',
  'lib/settings.js',
  'lib/speed_fusion.js',
  'lib/surface_resume.js',
  'lib/training_presets.js',
  'lib/workout_cache.js',
  'lib/workout_completion.js',
  'lib/workout_contract.js',
  'lib/workout_executor.js',
  'pages/index/index.ink',
  'pages/run_hud/index.ink',
  'assets/audio/metro_0468.wav',
  'assets/audio/metro_0468_bar_160.wav',
  'assets/audio/metro_0468_bar_170.wav',
  'assets/audio/metro_0468_bar_180.wav',
  ...WARMUP_GUIDE_ASSETS,
  ...RECOVERY_GUIDE_ASSETS,
];

const FORBIDDEN_FILES = [
  'PROGRESS.md',
  'DEVICES.md',
];

const PAGE_FILES = REQUIRED_FILES.filter((name) => name.endsWith('.ink'));
const REQUIRED_PERMISSIONS = [
  'bluetooth',
  'accelerometer',
  'gyroscope',
  'audio',
  'network',
];
const REQUIRED_APP_PERMISSIONS = [];
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

// 本应用按目标宿主区分两种画布：对话式 448x150，沉浸式 480x352。
const ROOT_CANVAS_RULES = [
  ['pages/run_hud/index.ink', '.immersive-root'],
];

const CANVAS_RULES = [
  ['pages/index/index.ink', ['.home-card'], 448, 150],
  ['pages/run_hud/index.ink', ['.hud'], 480, 352],
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

const HOST_BACKSPACE_RULES = [
  ['pages/index/index.ink', null],
  ['pages/run_hud/index.ink', 'run_hud'],
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function calculateManifestPackageId(entries) {
  const hash = createHash('sha256');
  for (const entry of entries) {
    const pathBytes = Buffer.from(String(entry.path), 'utf8');
    const pathLength = Buffer.allocUnsafe(4);
    pathLength.writeUInt32BE(pathBytes.length);
    const size = Buffer.allocUnsafe(8);
    size.writeBigUInt64BE(BigInt(entry.size));
    const digestBytes = Buffer.from(String(entry.sha256), 'utf8');
    const digestLength = Buffer.allocUnsafe(4);
    digestLength.writeUInt32BE(digestBytes.length);
    hash.update(pathLength);
    hash.update(pathBytes);
    hash.update(size);
    hash.update(digestLength);
    hash.update(digestBytes);
  }
  return `sha256:${hash.digest('hex')}`;
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

function inspectPcmWav(bytes) {
  if (!bytes || bytes.length < 44) return null;
  const asciiAt = (start, length) => String.fromCharCode(
    ...bytes.subarray(start, start + length),
  );
  if (asciiAt(0, 4) !== 'RIFF' || asciiAt(8, 4) !== 'WAVE') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format = null;
  let dataBytes = null;
  let dataStart = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const chunkId = asciiAt(offset, 4);
    const chunkBytes = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;
    if (bodyStart + chunkBytes > bytes.length) return null;
    if (chunkId === 'fmt ' && chunkBytes >= 16) {
      format = {
        pcmFormat: view.getUint16(bodyStart, true),
        channels: view.getUint16(bodyStart + 2, true),
        sampleRate: view.getUint32(bodyStart + 4, true),
        byteRate: view.getUint32(bodyStart + 8, true),
        bitsPerSample: view.getUint16(bodyStart + 14, true),
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
          Math.abs(view.getInt16(dataStart + frame * frameBytes + channel * 2, true)),
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

function extractInkDef(text, file) {
  const match = text.match(/<script[^>]*\bdef\b[^>]*>\s*([\s\S]*?)\s*<\/script>/);
  if (!match) fail(`AIX page is missing <script def>: ${file}`);
  try { return JSON.parse(match[1]); } catch (error) {
    fail(`AIX page has invalid <script def>: ${file}: ${error.message}`);
  }
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

function scanWxssSupport(text, file) {
  const offenders = [];
  for (const styleMatch of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = styleMatch[1].replace(/\/\*[\s\S]*?\*\//g, '');
    for (const atRule of css.matchAll(/@([a-z-]+)/gi)) {
      const name = atRule[1].toLowerCase();
      if (!ALLOWED_WXSS_AT_RULES.has(name)) offenders.push(`@${name}`);
    }
    for (const mediaRule of css.matchAll(/@media\s*\(([^)]*)\)/gi)) {
      if (!/^\s*target\s*:\s*_(?:current|blank)\s*$/i.test(mediaRule[1])) {
        offenders.push(`unsupported @media (${mediaRule[1].trim()})`);
      }
    }
    if (/(?:linear|radial)-gradient\s*\(/i.test(css)) offenders.push('CSS gradient');
    if (/:nth-child\s*\(/i.test(css)) offenders.push(':nth-child selector');
    for (const block of css.matchAll(/\{([^{}]*)\}/g)) {
      for (const part of block[1].split(';')) {
        const declaration = part.trim();
        if (!declaration) continue;
        const propertyMatch = declaration.match(/^(--[\w-]+|[a-z][\w-]*)\s*:\s*(.+)$/i);
        if (!propertyMatch) continue;
        const property = propertyMatch[1].toLowerCase();
        const value = propertyMatch[2].trim().toLowerCase();
        if (!property.startsWith('--') && !ALLOWED_WXSS_PROPERTIES.has(property)) {
          offenders.push(property);
        } else if (property === 'display' && !/^(?:flex|grid)$/.test(value)) {
          offenders.push(`display:${value}`);
        } else if (property === 'position'
            && !/^(?:static|relative|absolute|fixed)$/.test(value)) {
          offenders.push(`position:${value}`);
        }
      }
    }
  }
  return [...new Set(offenders)].map((entry) => `${file}: ${entry}`);
}

let AixReaderWasm;
try {
  ({ AixReaderWasm } = require(AIX_CLI_READER));
} catch (error) {
  fail(`Unable to load @yodaos-pkg/aix-cli 0.8.2 reader: ${error.message}`);
}

const reader = new AixReaderWasm(new Uint8Array(await fs.readFile(TARGET)));
const entries = reader.list();
const packagedFileEntries = entries.filter((entry) => !String(entry.name || '').endsWith('/'));
const packagedFileNames = packagedFileEntries.map((entry) => String(entry.name || ''));
if (new Set(packagedFileNames).size !== packagedFileNames.length) {
  fail('AIX package contains duplicate file entries and cannot be provenance-verified');
}
let inspectedSizeBudget;
try {
  const contentBytes = entries.reduce((total, entry) => total + Number(entry.size || 0), 0);
  inspectedSizeBudget = assertAixPlatformFootprint(contentBytes, path.basename(TARGET));
} catch (error) {
  fail(error.message);
}
const pages = reader.get_pages();
const tools = reader.get_tools();
const names = new Set(entries.map((entry) => entry.name));
const missing = REQUIRED_FILES.filter((name) => !names.has(name));
if (missing.length) fail(`AIX package is missing: ${missing.join(', ')}`);

let packagedAixManifest;
try {
  packagedAixManifest = JSON.parse(
    new TextDecoder().decode(reader.read_file(AIX_MANIFEST_FILE)),
  );
} catch (error) {
  fail(`AIX official-compatible manifest is invalid JSON: ${error.message}`);
}
const readerVersion = String(reader.get_version() || '').trim();
if (packagedAixManifest.format !== 'aix'
    || packagedAixManifest.version !== readerVersion
    || packagedAixManifest.engine !== AIUI_ENGINE_RANGE
    || packagedAixManifest.digest !== 'sha256'
    || packagedAixManifest.algorithm !== 'ed25519'
    || packagedAixManifest.key_id !== ''
    || !/^sha256:[0-9a-f]{64}$/.test(String(packagedAixManifest.package_id || ''))) {
  fail('AIX official-compatible unsigned manifest has an invalid identity, engine range, or digest contract');
}
const manifestEntries = Array.isArray(packagedAixManifest.entries)
  ? packagedAixManifest.entries : [];
const manifestEntryNames = manifestEntries.map((entry) => String(entry?.path || ''));
const expectedManifestEntryNames = packagedFileNames
  .filter((name) => name !== AIX_MANIFEST_FILE)
  .sort();
if (new Set(manifestEntryNames).size !== manifestEntryNames.length
    || JSON.stringify(manifestEntryNames) !== JSON.stringify(expectedManifestEntryNames)
    || manifestEntries.some((entry) => !Number.isSafeInteger(entry?.size)
      || entry.size < 0
      || !/^[0-9a-f]{64}$/.test(String(entry?.sha256 || '')))) {
  fail('AIX official-compatible manifest entries do not exactly cover the packaged payload');
}
for (const entry of manifestEntries) {
  const bytes = Buffer.from(reader.read_file(entry.path));
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  if (entry.size !== bytes.length || entry.sha256 !== actualSha256) {
    fail(`AIX official-compatible manifest digest mismatch: ${entry.path}`);
  }
}
if (packagedAixManifest.package_id !== calculateManifestPackageId(manifestEntries)) {
  fail('AIX official-compatible manifest package_id does not match its ordered entries');
}
for (const [runtimeVersion, expected] of [
  ['0.14.9', false],
  ['0.15.0', true],
  [AIUI_TARGET_VERSION, true],
  ['0.17.0', false],
]) {
  if (reader.supports_engine(runtimeVersion) !== expected) {
    fail(`AIX engine gate mismatch for AIUI ${runtimeVersion}: expected ${expected}`);
  }
}
for (const guideAsset of [...WARMUP_GUIDE_ASSETS, ...RECOVERY_GUIDE_ASSETS]) {
  const bytes = Buffer.from(reader.read_file(guideAsset));
  const gif = inspectGuideGif(bytes);
  if (!gif.valid
      || gif.width !== 160
      || gif.height !== 160
      || bytes.length >= 24 * 1024
      || gif.loopCount !== 0
      || gif.visibleFrameCount < 2
      || gif.uniqueVisibleFrameCount < 2) {
    fail(`AIX timed-guide asset must be a compact infinite-loop 160x160 GIF with multiple visible frames: ${guideAsset}`);
  }
}

let currentSourceTreeSha256;
let packagedPayloadTreeSha256;
let packagedProvenance;
try {
  currentSourceTreeSha256 = computeReleaseSourceTreeSha256(ROOT, {
    excludedPaths: ORPHAN_LIB_FILES,
  });
  packagedPayloadTreeSha256 = computeAixTreeSha256(packagedFileEntries.map((entry) => ({
    path: entry.name,
    bytes: reader.read_file(entry.name),
  })));
  const targetName = path.basename(TARGET);
  const expectedLocale = process.argv[2] === '--en' || targetName.endsWith('-en.aix')
    ? AIX_LOCALES.en
    : (process.argv[2] === '--ja' || targetName.endsWith('-ja.aix')
      ? AIX_LOCALES.ja
      : (targetName.endsWith('-cn.aix') ? AIX_LOCALES.cn : undefined));
  packagedProvenance = parseAndVerifyAixProvenance(
    new TextDecoder().decode(reader.read_file(AIX_PROVENANCE_FILE)),
    {
      expectedLocale,
      currentSourceTreeSha256,
      packagedPayloadTreeSha256,
    },
  );
} catch (error) {
  fail(`AIX provenance verification failed: ${error.message}`);
}

const forbidden = FORBIDDEN_FILES.filter((name) => names.has(name));
if (forbidden.length) {
  fail(`AIX package leaks internal files: ${forbidden.join(', ')}`);
}

const packagedAixIgnore = new TextDecoder().decode(reader.read_file('.aixignore'));
const aixIgnoreEntries = packagedAixIgnore.split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));
if (!aixIgnoreEntries.includes('VERSION')) {
  fail('AIX .aixignore must ignore the source VERSION so Craft keeps its generated UUID');
}

const packagedPageText = new Map(PAGE_FILES.map((file) => [
  file,
  new TextDecoder().decode(reader.read_file(file)),
]));
const packagedAgentManifest = new TextDecoder().decode(reader.read_file('AGENTS.md'));
for (const [file, text] of packagedPageText) {
  if (/<style[^>]*>\s*\/\*/.test(text)) {
    fail(`AIX layout discovery is unsafe: ${file} has a leading style comment`);
  }
}

const packagedHomeDef = extractInkDef(
  packagedPageText.get('pages/index/index.ink'), 'pages/index/index.ink',
);
const expectedPackageTitle = packagedProvenance.locale === AIX_LOCALES.cn
  ? '跑步教练' : 'SmartRun';
if (reader.get_title() !== expectedPackageTitle
    || packagedHomeDef.navigationBarTitleText !== expectedPackageTitle) {
  fail(`AIX localized title mismatch: expected "${expectedPackageTitle}"`);
}
const englishAgentManifest = packagedAgentManifest.includes('# Agent Manifest - AISmartRun');
if (englishAgentManifest) {
  for (const required of [
    'RSC becomes live only after the first valid notification',
    'needs three strict accepted-step signals',
    'four cadence-consistent signals',
    'held for at most 3.5 seconds',
    'completed-run summary still retains its independent average cadence',
  ]) {
    if (!packagedAgentManifest.includes(required)) {
      fail(`English AIX Agent Manifest is stale: missing ${required}`);
    }
  }
  if (packagedAgentManifest.includes('current zero or unavailable value is shown as `-`')) {
    fail('English AIX Agent Manifest restores the obsolete ready-cadence dash');
  }
} else {
  for (const required of [
    'RSC_FIRST_PACKET',
    'RSC_SILENT',
    '3 个严格证据',
    '4 个不高于 210spm',
    'HUD 对当前可信步频只做最多 3.5 秒短保持',
    '跑后总结仍独立保留有效样本计算出的平均步频',
  ]) {
    if (!packagedAgentManifest.includes(required)) {
      fail(`Chinese AIX Agent Manifest is stale: missing ${required}`);
    }
  }
}
if (JSON.stringify(Object.keys(packagedHomeDef)) !== JSON.stringify(['navigationBarTitleText'])) {
  fail('AIX Home must be a title-only 448x150 compatibility fallback');
}
const packagedRunDef = extractInkDef(
  packagedPageText.get('pages/run_hud/index.ink'), 'pages/run_hud/index.ink',
);
if (JSON.stringify(Object.keys(packagedRunDef)) !== JSON.stringify(['navigationBarTitleText'])) {
  fail('AIX Run HUD must stay title-only so the first parameterless route derives _blank');
}
const expectedRunTitle = packagedProvenance.locale === AIX_LOCALES.cn
  ? '跑步教练' : 'SmartRun Run';
if (packagedRunDef.navigationBarTitleText !== expectedRunTitle) {
  fail(`AIX localized immersive title mismatch: expected "${expectedRunTitle}"`);
}
const wxssOffenders = [...packagedPageText]
  .flatMap(([file, text]) => scanWxssSupport(text, file));
if (wxssOffenders.length) {
  fail(`AIX contains unsupported WXSS: ${wxssOffenders.join('; ')}`);
}

for (const [file, selector] of ROOT_CANVAS_RULES) {
  const text = packagedPageText.get(file);
  const rule = extractRule(text, selector);
  const ok = /\bwidth:\s*480px;/.test(rule)
    && /\bheight:\s*352px;/.test(rule)
    && !/\b(?:min|max)-(?:width|height):/.test(rule);
  if (!ok) fail(`AIX canvas mismatch: ${file} ${selector} must be exactly 480x352px`);
}

for (const [file, selectors, width, height] of CANVAS_RULES) {
  const text = packagedPageText.get(file);
  for (const selector of selectors) {
    const rule = extractRule(text, selector);
    const exact = new RegExp(`\\bwidth:\\s*${width}px;`).test(rule)
      && new RegExp(`\\bheight:\\s*${height}px;`).test(rule)
      && !/min-height:/.test(rule);
    if (!exact) fail(`AIX canvas mismatch: ${file} ${selector} must be ${width}x${height}px`);
  }
}

const packagedHomeText = packagedPageText.get('pages/index/index.ink');
const packagedHomeWrapRule = extractRule(packagedHomeText, '.home-wrap');
if (!/\bwidth:\s*448px;/.test(packagedHomeWrapRule)
    || !/\bheight:\s*150px;/.test(packagedHomeWrapRule)
    || !/\bjustify-content:\s*flex-end;/.test(packagedHomeWrapRule)
    || !/\bposition:\s*fixed;/.test(packagedHomeWrapRule)
    || !/\bbottom:\s*0;/.test(packagedHomeWrapRule)
    || !/\bleft:\s*0;/.test(packagedHomeWrapRule)
    || !/\bright:\s*0;/.test(packagedHomeWrapRule)) {
  fail('AIX Home wrapper must bottom-align its 448x150 card in the current host viewport');
}
if (!/@media\s*\(target:\s*_current\)\s*\{[\s\S]*?\.home-wrap\s*\{[\s\S]*?\bwidth:\s*448px;[\s\S]*?\bheight:\s*150px;/.test(packagedHomeText)
    || !/@media\s*\(target:\s*_blank\)\s*\{[\s\S]*?\.home-wrap\s*\{[\s\S]*?\bwidth:\s*480px;[\s\S]*?\bheight:\s*352px;[\s\S]*?\.home-card\s*\{[\s\S]*?\bwidth:\s*448px;[\s\S]*?\bheight:\s*352px;/.test(packagedHomeText)) {
  fail('AIX Home must adapt with _current=448x150 and _blank=480x352 target media rules');
}
if (!/onTargetChanged\(target, previousTarget\)[\s\S]*?target === '_blank'[\s\S]*?this\.setData\(\{ hostTarget \}\)/.test(packagedHomeText)) {
  fail('AIX Home must synchronize hostTarget through onTargetChanged without viewport sniffing');
}
const packagedTargetHandler = stripJsComments(extractMethodBody(packagedHomeText, 'onTargetChanged'));
if (!packagedTargetHandler
    || /\b(?:navigateTo|redirectTo|switchTab|reLaunch|scanDevices|innerWidth|innerHeight|getWindowInfo|getSystemInfoSync)\b/.test(packagedTargetHandler)) {
  fail('AIX Home onTargetChanged must only synchronize local target state');
}
if (/\bborder\s*:/.test(extractRule(packagedHomeText, '.home-card'))
    || /\bborder\s*:/.test(extractRule(packagedPageText.get('pages/run_hud/index.ink'), '.hud'))) {
  fail('AIX Home and immersive canvas surfaces must not draw outer border lines');
}

for (const [file, source] of HOST_BACKSPACE_RULES) {
  const text = new TextDecoder().decode(reader.read_file(file));
  // navigateBack stays banned. The immersive route may exit only from the
  // summary Backspace replacement after explicit BLE cleanup.
  if (/wx\.navigateBack\s*\(/.test(text)) {
    fail(`AIX back navigation may leave the app: ${file}`);
  }
  const branch = extractBackspaceBranch(text);
  if (!branch) {
    fail(`AIX page does not listen for Backspace: ${file}`);
  }
  if (/wx\.(?:navigateTo|redirectTo|navigateBack)\s*\(/.test(branch)) {
    fail(`AIX Backspace must not start a competing route: ${file}`);
  }
  if (!source) {
    if (/preventDefault\s*\(/.test(branch)) {
      fail(`AIX Home Backspace must preserve the host default: ${file}`);
    }
    const totalExits = (stripJsComments(text).match(/wx\.exitMiniProgram\s*\(/g) || []).length;
    const branchExits = (stripJsComments(branch).match(/wx\.exitMiniProgram\s*\(/g) || []).length;
    if (totalExits !== 1 || branchExits !== 1) {
      fail(`AIX Home exit must live only inside the double-press Backspace confirm branch: ${file}`);
    }
  } else {
    if (!branch.includes(`markHostBackspaceIntent(wx, '${source}')`)) {
      fail(`AIX Screen 02 host Backspace intent marker is missing: ${file}`);
    }
    if (!/isSummaryPhase\s*\(\s*\)[\s\S]*preventDefault\s*\([\s\S]*closeAgentFromSummary\s*\(/.test(branch)) {
      fail(`AIX summary Backspace close replacement is missing: ${file}`);
    }
    const hudBackCopy = packagedProvenance.locale === AIX_LOCALES.ja
      ? '確認キーを3回押して終了'
      : (packagedProvenance.locale === AIX_LOCALES.en
        ? 'Press Confirm 3 Times to End'
        : '请按确认键3次结束');
    if (!/surfacePhase\s*===\s*'hud'[\s\S]*preventDefault\s*\([\s\S]*resetHudEndConfirmation\s*\(/.test(branch)
        || !branch.includes(hudBackCopy)
        || /surfacePhase\s*===\s*'hud'[\s\S]*finishRunToRecovery\s*\(/.test(branch)) {
      fail(`AIX HUD Backspace must preserve the strict three-confirm end guard: ${file}`);
    }
    const keyUp = stripJsComments(extractMethodBody(text, 'onKeyUp'));
    if (!/surfacePhase\s*===\s*'hud'[\s\S]*data\.running[\s\S]*preventDefault\s*\([\s\S]*onHudConfirmKey\s*\(/.test(keyUp)) {
      fail(`AIX HUD confirmation must prevent the host default before opening Screen 04: ${file}`);
    }
    const hudConfirm = stripJsComments(extractMethodBody(text, 'onHudConfirmKey'));
    const threeConfirmCopy = packagedProvenance.locale === AIX_LOCALES.ja
      ? ['あと2回押すと終了', 'あと1回押すと終了']
      : (text.includes("'Press 2 More Times to End'")
        ? ['Press 2 More Times to End', 'Press 1 More Time to End']
        : ['再按2次结束', '再按1次结束']);
    if (!/HUD_CONFIRM_REQUIRED_COUNT\s*=\s*3/.test(text)
        || !/HUD_CONFIRM_INDEPENDENT_GAP_MS\s*=\s*600/.test(text)
        || !/hudEndConfirmCount[\s\S]*HUD_CONFIRM_REQUIRED_COUNT[\s\S]*finishRunToRecovery\s*\(/.test(hudConfirm)
        || threeConfirmCopy.some((copy) => !hudConfirm.includes(copy))) {
      fail(`AIX HUD end must require three independent confirmations: ${file}`);
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
        || !/closeAgentFromSummary\s*\(\s*'summary-double-tap'\s*\)/.test(cleanSummaryConfirm)) {
      fail(`AIX summary exit must remain responsive and clean BLE before its single app exit: ${file}`);
    }
    const englishSummary = text.includes('<text class="summary-title">Run Summary</text>')
      || text.includes('<text class="summary-title">Run Complete</text>');
    const requiredSummaryCopy = packagedProvenance.locale === AIX_LOCALES.ja
      ? "const SUMMARY_EXIT_COPY = '戻るキーで終了してエージェントを閉じる'"
      : (englishSummary
        ? "const SUMMARY_EXIT_COPY = 'Press Back to End and Close Agent'"
        : "const SUMMARY_EXIT_COPY = '按返回键结束并关闭智能体'");
    if (!text.includes('<text class="summary-exit">{{ summaryExitText }}</text>')
        || !text.includes(requiredSummaryCopy)
        || !text.includes('summaryExitText: SUMMARY_EXIT_COPY')
        || !/isSummaryPhase\(\)[\s\S]*timedGuideKind\s*!==\s*'recovery'[\s\S]*ArrowDown[\s\S]*startRecoveryGuide\(\)/.test(cleanText)
        || !text.includes('<view class="recovery-wrap" ink:if="{{ surfacePhase === \'recovery\' || surfacePhase === \'pre_run\' }}">')
        || !text.includes("closeAgentFromSummary('recovery-skip-summary')")
        || !text.includes('showSummaryAfterRecovery()')) {
      fail(`AIX summary close copy is stale: ${file}`);
    }
    const requiredScanCopy = packagedProvenance.locale === AIX_LOCALES.ja
      ? ['前後にスワイプ · タップで決定', '戻るでホーム · ダブルタップで終了']
      : (englishSummary
        ? ['Swipe to Select · Tap to Confirm', 'Back to Home · Double-tap to Exit']
        : ['前后划选择 · 单击执行', '返回键回首页 · 双击退出智能体']);
    if (!/if\s*\(this\.isSearchPhase\(\)\)\s*writeScanExitHint\(wx\)/.test(branch)
        || requiredScanCopy.some((copy) => !text.includes(copy))
        || !/SEARCH_DOUBLE_TAP_WINDOW_MS\s*=\s*420/.test(text)
        || !/closeAgentFromSummary\(\s*'search-double-tap'\s*\)/.test(text)) {
      fail(`AIX Screen 02 swipe/select/double-tap exit path is incomplete: ${file}`);
    }
  }
}

const packagedHome = packagedPageText.get('pages/index/index.ink');
for (const requiredToken of ['SmartRun', 'home-content']) {
  if (!packagedHome.includes(requiredToken)) {
    fail(`AIX Home is missing the simplified brand surface: ${requiredToken}`);
  }
}
const packagedHomeRules = {
  wrap: extractRule(packagedHome, '.home-wrap'),
  card: extractRule(packagedHome, '.home-card'),
  content: extractRule(packagedHome, '.home-content'),
  slogan: extractRule(packagedHome, '.home-slogan'),
  focused: extractRule(packagedHome, '.home-enter.home-action-focused'),
};
if (!/\.home-enter\.home-action-focused\s*\{\s*\n\s*outline-width:\s*2px;/.test(packagedHome)
    || !/\boutline-style:\s*solid;/.test(packagedHomeRules.focused)
    || !/\boutline-color:\s*var\(--color-primary/.test(packagedHomeRules.focused)
    || !/\boutline-offset:\s*-2px;/.test(packagedHomeRules.focused)
    || /\bborder\s*:/.test(packagedHomeRules.focused)
    || !packagedHome.includes('class="home-enter home-action-focused"')) {
  fail('AIX Home single safe entry must keep the AIUI-safe inward focus outline');
}

const packagedRunHudFocus = packagedPageText.get('pages/run_hud/index.ink');
for (const selector of [
  '.feature-secondary.feature-focused', '.setting-row.setting-row-focused',
  '.primary-button.search-target-focused', '.device-row.device-row-focused',
]) {
  const rule = extractRule(packagedRunHudFocus, selector);
  if (!/\boutline-width:\s*2px;/.test(rule)
      || !/\boutline-style:\s*solid;/.test(rule)
      || !/\boutline-color:\s*var\(--color-primary/.test(rule)
      || !/\boutline-offset:\s*-2px;/.test(rule)
      || /\bborder\s*:/.test(rule)) {
    fail(`AIX ${selector} must use the AIUI-safe inward focus outline without a dynamic border`);
  }
}
for (const [name, rule] of Object.entries({
  card: packagedHomeRules.card,
  content: packagedHomeRules.content,
})) {
  if (!/\balign-items:\s*center;/.test(rule)
      || !/\bjustify-content:\s*center;/.test(rule)
      || !/\bbox-sizing:\s*border-box;/.test(rule)) {
    fail(`AIX Home ${name} must use exact flex centering and border-box sizing`);
  }
}
if (!/\balign-items:\s*center;/.test(packagedHomeRules.wrap)
    || !/\bjustify-content:\s*flex-end;/.test(packagedHomeRules.wrap)
    || !/\bbox-sizing:\s*border-box;/.test(packagedHomeRules.wrap)) {
  fail('AIX Home wrapper must bottom-align the conversation card in expanded hosts');
}
if (!/\bmargin:\s*0;/.test(packagedHomeRules.card)
    || !/\bpadding:\s*0;/.test(packagedHomeRules.card)) {
  fail('AIX Home card must reset margin and padding');
}
if (!/\bmargin:\s*0 auto;/.test(packagedHomeRules.wrap)) {
  fail('AIX Home wrapper must center the 448px card inside a 480px interactive host');
}
if (!/\bwidth:\s*444px;/.test(packagedHomeRules.content)
    || !/\bheight:\s*146px;/.test(packagedHomeRules.content)
    || !/\bpadding:\s*4px 12px;/.test(packagedHomeRules.content)) {
  fail('AIX Home content must preserve the 444x146 inner safe area');
}
if (!/\bheight:\s*24px;/.test(packagedHomeRules.slogan)
    || !/\bmargin:\s*1px 0 3px;/.test(packagedHomeRules.slogan)) {
  fail('AIX Home slogan must keep the compact single-entry rhythm');
}
const packagedHomeNonWrapperRules = [
  packagedHomeRules.card,
  packagedHomeRules.content,
  packagedHomeRules.slogan,
].join('\n');
if (/\bposition\s*:/.test(packagedHomeNonWrapperRules)
    || /\btransform\s*:/.test(Object.values(packagedHomeRules).join('\n'))) {
  fail('AIX Home may use only the fixed bottom wrapper; child positioning and transforms are forbidden');
}
const hasChineseHomeCopy = packagedHome.includes('自由开跑，智能相伴')
  && packagedHome.includes('按确认键进入');
const hasEnglishHomeCopy = packagedHome.includes('Run Free. Run Smart.')
  && packagedHome.includes('Press Confirm to Enter');
const hasJapaneseHomeCopy = packagedHome.includes('自由に走る。スマートに走る。')
  && packagedHome.includes('確認キーで開始');
const hasLocalizedHomeCopy = hasChineseHomeCopy || hasEnglishHomeCopy || hasJapaneseHomeCopy;
if (!hasLocalizedHomeCopy) fail('AIX Home is missing localized slogan or enter copy');
if (/navigator\.bluetooth\.|readHeartRateDevice|matchesHeartRateDevice|\.gatt\.connect\s*\(/.test(packagedHome)) {
  fail('AIX Home must not read, scan, or connect Bluetooth from the conversation card');
}
if (/\b(?:home-slogan-summary|sloganClass|generateRunSummary)\b/.test(packagedHome)) {
  fail('AIX Home must not restore a post-run summary visual state');
}
if (!packagedHome.includes('/pages/run_hud/index')) {
  fail('AIX Home is missing the run_hud immersive destination');
}
if (!/const HOME_MENU_ROUTE = RUN_ROUTE \+ '\?mode=menu&inputGuard=1&fromHome=1';/.test(packagedHome)
    || !/wx\.navigateTo\s*\(\s*\{[\s\S]*?url:\s*HOME_MENU_ROUTE\s*,/.test(packagedHome)
    || /wx\.redirectTo\s*\(/.test(packagedHome)) {
  fail('AIX Home must preserve its conversation root and use navigateTo only');
}
if (!/<view class="home-card" role="navigation">/.test(packagedHome)
    || !/class="home-enter home-action-focused"[\s\S]*?tabindex="0"[\s\S]*?bindtap="openMenu"/.test(packagedHome)
    || /home-options|home-option|openSlowRun|openSettings|HOME_FOCUS_COUNT/.test(packagedHome)) {
  fail('AIX Home must expose exactly one safe menu entry');
}
const packagedHomeKeyUp = stripJsComments(extractMethodBody(packagedHome, 'onKeyUp'));
if (!/openMenu/.test(packagedHome)
    || !/code === 'GlobalHook'/.test(packagedHomeKeyUp)
    || !/preventDefault\s*\(/.test(packagedHomeKeyUp)
    || /code === '(?:Enter|NumpadEnter|Space)'/.test(packagedHomeKeyUp)
    || !/HOME_CONFIRM_DEDUPE_MS/.test(packagedHome)
    || !/runNavigationPending/.test(packagedHome)
    || /code === 'ArrowDown'|code === 'ArrowUp'/.test(packagedHome)) {
  fail('AIX Home must keep native Enter/Space activation, de-duplicate only GlobalHook, and leave direction keys to the host');
}
if (VISUAL_STYLE_MOTION_RE.test(packagedHome) || OBSOLETE_VISUAL_MOTION_RE.test(packagedHome)) {
  fail('AIX Home must remain completely static and free of obsolete visual-motion identifiers');
}
if (/\btransition(?:-[a-z-]+)?\s*:/.test(packagedHome)) {
  fail('AIX Home must not add visual transitions');
}

// 02 进入可交互前台后循环全量搜索，只有 Next 推进 03。稳定 ID 仅用于
// GATT 验证优先级，不得过滤发现结果。在包内检查，避免双语转换带回旧逻辑。
const packagedRunHud = new TextDecoder().decode(reader.read_file('pages/run_hud/index.ink'));
const packagedDeviceIdentity = new TextDecoder().decode(reader.read_file('lib/device_identity.js'));
const packagedCoachApi = new TextDecoder().decode(reader.read_file('lib/coach_api.js'));
const packagedRunUpload = new TextDecoder().decode(reader.read_file('lib/run_upload.js'));
const packagedWorkoutCompletion = new TextDecoder().decode(
  reader.read_file('lib/workout_completion.js'),
);
const packagedHeartRatePolicy = new TextDecoder().decode(
  reader.read_file('lib/heart_rate_policy.js'),
);
const packagedAiuiCalibration = new TextDecoder().decode(
  reader.read_file('lib/aiui_calibration.js'),
);
const packagedRunningLocalFieldLog = new TextDecoder().decode(
  reader.read_file('lib/running_local_field_log.js'),
);
const packagedWxJson = new TextDecoder().decode(reader.read_file('lib/wx_json.js'));
const packagedSettings = new TextDecoder().decode(reader.read_file('lib/settings.js'));
const packagedMetronome = new TextDecoder().decode(reader.read_file('lib/metronome.js'));
const packagedWarmupGuide = new TextDecoder().decode(reader.read_file('lib/warmup_guide.js'));
const packagedRecoveryGuide = new TextDecoder().decode(reader.read_file('lib/recovery_guide.js'));
const packagedAdaptiveStride = new TextDecoder().decode(
  reader.read_file('lib/adaptive_stride.js'),
);
const packagedMotionQuality = new TextDecoder().decode(
  reader.read_file('lib/motion_quality.js'),
);
const packagedSpeedFusion = new TextDecoder().decode(
  reader.read_file('lib/speed_fusion.js'),
);
const cleanPackagedRunHud = stripJsComments(packagedRunHud);
const retiredAgentReference = /(?:(?:from|import)[^\n]*sport_agent\.js|SportAgent|sportAgent|(?<!LEGACY_)SPORT_AGENT)/;
if (names.has('lib/sport_agent.js')
    || ORPHAN_LIB_FILES.indexOf('lib/sport_agent.js') < 0
    || retiredAgentReference.test(packagedRunHud)
    || retiredAgentReference.test(packagedDeviceIdentity)
    || !packagedRunHud.includes("import { nextProactiveCue } from '../../lib/coach.js';")
    || !packagedRunHud.includes('const cue = nextProactiveCue(this.prevCue, cur);')
    || !packagedRunHud.includes('async generateSummaryAiText(summary)')
    || !packagedRunHud.includes('LanguageModel.create({')) {
  fail('AIX must exclude the retired Sport Agent runtime while retaining local coaching cues and on-device summary');
}
if (!packagedRunHud.includes("from '../../lib/heart_rate_policy.js'")
    || !packagedRunHud.includes('freezeHeartRatePolicyForRun(startMs)')
    || !packagedHeartRatePolicy.includes(
      "HEART_RATE_POLICY_STORAGE_KEY = 'smartrun_heart_rate_policy_v1'",
    )
    || !packagedHeartRatePolicy.includes('HEART_RATE_POLICY_MAX_FUTURE_ISSUE_MS = 60_000')
    || !packagedHeartRatePolicy.includes(
      'HEART_RATE_POLICY_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000',
    )
    || !packagedHeartRatePolicy.includes(
      'keys.length !== HEART_RATE_POLICY_ALLOWED_KEYS.size',
    )
    || !packagedHeartRatePolicy.includes(
      "heartRatePolicyConfidence(policy) === 'missing'",
    )
    || !/\?\s*'(?:估算区间|Est\. zone|推定区間)'/.test(packagedRunHud)
    || !packagedRunHud.includes(
      "heartRatePolicyConfidence(this.frozenHeartRatePolicy) === 'trusted'",
    )) {
  fail('AIX heart-rate policy must ship, freeze per run, keep missing policies dark, label estimated zones and reserve personalized coaching for trusted sources');
}
const packagedWorkoutCompletionBuilder = packagedWorkoutCompletion.slice(
  packagedWorkoutCompletion.indexOf('export function buildWorkoutCompletion('),
  packagedWorkoutCompletion.indexOf('function clone(value)'),
);
if (/\brpe\b|\bpain\b|training_context/i.test(packagedWorkoutCompletionBuilder)
    || packagedWorkoutCompletion.includes("normalizeOptionalInt(result, raw, 'rpe'")) {
  fail('AIX workout completion must not emit legacy RPE, pain or training_context');
}
if (!packagedWarmupGuide.includes('WARMUP_TTS_INTRO')
    || !packagedWarmupGuide.includes('WARMUP_COMPLETION_TTS')
    || !packagedWarmupGuide.includes("imagePath: '../../assets/warmup/march.gif'")
    || !packagedWarmupGuide.includes("imagePath: '../../assets/warmup/calf-raise.gif'")
    || !packagedWarmupGuide.includes("imagePath: '../../assets/warmup/butt-kick.gif'")
    || !packagedWarmupGuide.includes("imagePath: '../../assets/warmup/lateral-shift.gif'")
    || !packagedWarmupGuide.includes('WARMUP_STEP_DURATION_SEC = 15')
    || !(packagedWarmupGuide.includes("? 'Start Now' : 'Next'")
      || packagedWarmupGuide.includes("? '立即开跑' : '下一步'")
      || packagedWarmupGuide.includes("? '今すぐスタート' : '次へ'"))
    || !(packagedWarmupGuide.includes("WARMUP_COMPLETION_TTS = 'Warm-up complete. Starting automatically.'")
      || packagedWarmupGuide.includes("WARMUP_COMPLETION_TTS = '热身完成，自动开始跑步。'")
      || packagedWarmupGuide.includes("WARMUP_COMPLETION_TTS = 'ウォームアップ完了。自動でスタートします。'"))
    || !packagedRecoveryGuide.includes('RECOVERY_TTS_INTRO')
    || !packagedRecoveryGuide.includes('getRecoveryTtsCue')
    || !(packagedWarmupGuide.includes('fifteen seconds')
      || packagedWarmupGuide.includes('每个十五秒')
      || packagedWarmupGuide.includes('15秒'))
    || !(packagedRecoveryGuide.includes('fifteen seconds')
      || packagedRecoveryGuide.includes('每个十五秒')
      || packagedRecoveryGuide.includes('15秒'))
    || !packagedRunHud.includes('queueRecoveryTts(0, { includeIntro: true })')
    || !packagedRunHud.includes('cancelRecoveryTts()')) {
  fail('AIX pre-run and recovery flows must announce four 15-second steps while keeping quick-exit guide audio cancellable by suppression');
}
const packagedPreRunBody = stripJsComments(extractMethodBody(packagedRunHud, 'startPreRunGuide'));
const packagedOpenRunBody = stripJsComments(extractMethodBody(packagedRunHud, 'openRunMode'));
const packagedOnConnectBody = stripJsComments(extractMethodBody(packagedRunHud, 'onConnectTap'));
const packagedOnRecoveryTapBody = stripJsComments(extractMethodBody(packagedRunHud, 'onRecoveryTap'));
const packagedOnRecoveryBackBody = stripJsComments(extractMethodBody(packagedRunHud, 'onRecoveryBack'));
const packagedFinishRecoveryCountdownBody = stripJsComments(extractMethodBody(packagedRunHud, 'finishRecoveryCountdown'));
const packagedUpdateRecoveryCountdownBody = stripJsComments(extractMethodBody(packagedRunHud, 'updateRecoveryCountdown'));
const packagedQueueRecoverySpeechBody = stripJsComments(extractMethodBody(packagedRunHud, 'queueRecoverySpeech'));
const packagedFinishEntryBody = stripJsComments(extractMethodBody(packagedRunHud, 'finishEntry'));
const packagedEnterSearchBody = stripJsComments(extractMethodBody(packagedRunHud, 'enterSearchReady'));
if (!packagedRunHud.includes("surfacePhase === 'recovery' || surfacePhase === 'pre_run'")
    || !/surfacePhase:\s*'pre_run'/.test(packagedPreRunBody)
    || !/return this\.enterSearchReady\(\{ fromModeSelection: true \}\)/.test(packagedOpenRunBody)
    || !/preRunRequiredAfterSearch === true/.test(packagedOnConnectBody)
    || !/return this\.startPreRunGuide\(\)/.test(packagedOnConnectBody)
    || !/return this\.proceedToHud\(\)/.test(packagedOnRecoveryTapBody)
    || !/const preRun = this\.timedGuideKind === 'pre_run'/.test(packagedFinishRecoveryCountdownBody)
    || !/if \(preRun\)[\s\S]*return this\.proceedToHud\(\{ suppressStartCue: true \}\)/.test(packagedFinishRecoveryCountdownBody)
    || !/recoveryActionLabel:\s*preRun \? '(?:正在开跑|Starting|開始中)' : '(?:查看跑步总结|View Run Summary|ランニング結果を見る)'/.test(packagedFinishRecoveryCountdownBody)
    || !/recoveryChoiceVisible:\s*!preRun/.test(packagedFinishRecoveryCountdownBody)
    || !/return this\.enterSearchReady\(\{ fromWarmupBack: true \}\)/.test(packagedOnRecoveryBackBody)
    || !/if \(!this\.timedGuideQuickExitEnabled\(\)\) return false/.test(packagedOnRecoveryTapBody)
    || !packagedRunHud.includes('timedGuideSpeechEnabled()')
    || !/!this\.timedGuideSpeechEnabled\(\)/.test(packagedQueueRecoverySpeechBody)
    || /get(?:Warmup|Recovery)RhythmTtsCue\(this\.recoveryIndex,\s*3\)/.test(
      packagedUpdateRecoveryCountdownBody,
    )
    || /preferWebSpeech|speechRate/.test(packagedUpdateRecoveryCountdownBody)
    || !/fromWarmup/.test(packagedFinishEntryBody)
    || !/this\.startRun\(\)/.test(packagedFinishEntryBody)
    || !/surfacePhase:\s*'ready'/.test(packagedEnterSearchBody)
    || /startDiscovery|scanDevices|startSensors|startTicker|startAccel/.test(packagedPreRunBody)) {
  fail('AIX Search setup must enter sensor-free pre_run, then the final warm-up deadline must auto-start the HUD');
}
const packagedCalibrationRunOnLoad = packagedRunHud.slice(
  packagedRunHud.indexOf('  onLoad('),
  packagedRunHud.indexOf('  isSearchPhase() {'),
);
const packagedCalibrationRunOnShow = packagedRunHud.slice(
  packagedRunHud.indexOf('  onShow() {'),
  packagedRunHud.indexOf('  clearSurfaceTimers() {'),
);
const packagedCalibrationCapture = packagedRunHud.slice(
  packagedRunHud.indexOf('  captureAiuiCalibrationSnapshot('),
  packagedRunHud.indexOf('  async flushAiuiCalibrationUploads()'),
);
const packagedSummaryClose = packagedRunHud.slice(
  packagedRunHud.indexOf('  closeAgentFromSummary('),
  packagedRunHud.indexOf('  onHudConfirmKey()'),
);
const cleanPackagedSummaryClose = stripJsComments(packagedSummaryClose);
const packagedSummaryFinalizer = packagedRunHud.slice(
  packagedRunHud.indexOf('  finalizeRunAfterSummaryCommit('),
  packagedRunHud.indexOf('  finishRunToSummary()'),
);
const packagedSummaryUploadStarter = stripJsComments(
  extractMethodBody(packagedRunHud, 'startSummaryHermesUploads'),
);
const packagedMetronomeAudio = reader.read_file('assets/audio/metro_0468.wav');
const packagedMetronomeBars = [
  [160, 1225.011],
  [170, 1158.821],
  [180, 1100.000],
].map(([bpm, expectedDurationMs]) => ({
  bpm,
  expectedDurationMs,
  wav: inspectPcmWav(reader.read_file(`assets/audio/metro_0468_bar_${bpm}.wav`)),
}));
if (!/const DEVICE_REQUEST_TIMEOUT_MS = 12000;/.test(packagedRunHud)
    || !/dataType:\s*'json'/.test(packagedRunHud)
    || !/responseType:\s*'text'/.test(packagedRunHud)
    || !/timeout:\s*timeoutMs/.test(packagedRunHud)
    || !/requestTask\.abort\(\)/.test(packagedRunHud)
    || !/dataType:\s*'json'/.test(packagedHome)
    || !/responseType:\s*'text'/.test(packagedHome)) {
  fail('AIX device networking must use explicit JSON text, a 12s phone-proxy timeout and bounded abort');
}
for (const [label, source] of [
  ['device identity', packagedDeviceIdentity],
  ['coach API', packagedCoachApi],
  ['run upload', packagedRunUpload],
  ['AIUI calibration', packagedAiuiCalibration],
]) {
  if (!source.includes("dataType: 'json'") || !source.includes("responseType: 'text'")) {
    fail(`AIX ${label} must pin dataType=json and responseType=text`);
  }
}
if (!packagedAiuiCalibration.includes(
  "AIUI_CALIBRATION_PATH =\n  '/api/coach-svc/coach/aiui-calibration/batch'",
)
    || !packagedAiuiCalibration.includes(
      "PENDING_AIUI_CALIBRATION_KEY =\n  'pending_aiui_calibration_events'",
    )
    || !packagedAiuiCalibration.includes("source: 'aiui_glasses'")
    || !packagedAiuiCalibration.includes('acked_event_ids')
    || !packagedAiuiCalibration.includes('AIUI_CALIBRATION_BATCH_SIZE = 500')
    || !packagedAiuiCalibration.includes('AIUI_CALIBRATION_CAPTURE_INTERVAL_MS = 1000')
    || !/status === 400 \|\| status === 409 \|\| status === 422/.test(
      packagedAiuiCalibration,
    )
    || /\b(?:latitude|longitude|raw_acceleration|raw_gyroscope)\b/.test(
      packagedAiuiCalibration,
    )) {
  fail('AIX AIUI calibration must use the scoped batch endpoint, 1Hz derived-only events, explicit ACKs and isolated permanent conflicts without raw coordinates or sensors');
}
if (packagedCalibrationCapture.includes('flushAiuiCalibrationUploads()')
    || packagedCalibrationRunOnLoad.includes('flushAiuiCalibrationUploads()')
    || packagedCalibrationRunOnShow.includes('flushAiuiCalibrationUploads()')
    || cleanPackagedSummaryClose.includes('this.flushAiuiCalibrationUploads()')
    || cleanPackagedSummaryClose.includes('this.flushRunUploads()')
    || !cleanPackagedSummaryClose.includes('startSummaryHermesUploads(')
    || !cleanPackagedSummaryClose.includes('allowDuringExit: true')
    || !packagedSummaryFinalizer.includes('startSummaryHermesUploads(')
    || !packagedSummaryUploadStarter.includes('flushAiuiCalibrationUploads()')
    || !packagedSummaryUploadStarter.includes('flushRunUploads()')) {
  fail('AIX AIUI calibration must remain local during the run, batch only after Summary, and use Home only for durable retry');
}
if (!packagedRunHud.includes("from '../../lib/aiui_calibration.js'")
    || !packagedRunHud.includes('createAiuiCalibrationStream(startMs)')
    || !packagedRunHud.includes('captureAiuiCalibrationSnapshot(now, motion, {')
    || !/algorithmSpeedMps:\s*this\.isSlowJogMode\(\)\s*\|\|\s*livePaceSec\s*==\s*null\s*\?\s*null\s*:\s*1000\s*\/\s*livePaceSec/.test(packagedRunHud)
    || !packagedRunHud.includes('persistAiuiCalibrationBuffer()')
    || !packagedRunHud.includes('onOwnerDataCleared: () => this.handleCalibrationOwnerDataCleared()')
    || !packagedRunHud.includes(
      'clearDeviceAuth(wx, { coachTokenStorageKey: COACH_TOKEN_STORAGE_KEY })',
    )
    || !packagedHome.includes('flushAiuiCalibrationUploads()')
    || !packagedDeviceIdentity.includes("'pending_aiui_calibration_events'")) {
  fail('AIX AIUI calibration must persist on lifecycle boundaries, refresh scoped auth safely, isolate owner changes and retry from Home');
}
if (!packagedRunHud.includes("from '../../lib/running_local_field_log.js'")
    || !packagedRunHud.includes('beginRunningLocalFieldCapture(startMs)')
    || !packagedRunHud.includes("this.captureRunningLocalFieldSample(now, motion, 'ticker')")
    || !packagedRunHud.includes('finishRunningLocalFieldCapture(pendingSummary, motion, now)')
    || !packagedRunHud.includes('buildRunningLocalFieldLogReplayLines(run)')
    || !packagedRunHud.includes('LOCAL_FIELD_LOG_NOISY_EVENT_INTERVAL_MS = 5 * 60 * 1000')
    || !packagedRunHud.includes('flushRunningLocalFieldNoisyEvents()')
    || !packagedRunningLocalFieldLog.includes(
      'RUNNING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS = 5000',
    )
    || !packagedRunningLocalFieldLog.includes(
      'RUNNING_LOCAL_FIELD_LOG_MAX_SAMPLES_PER_RUN = 8640',
    )
    || !packagedRunningLocalFieldLog.includes(
      'RUNNING_LOCAL_FIELD_LOG_MAX_TOTAL_BYTES = 2 * 1024 * 1024',
    )
    || !packagedRunningLocalFieldLog.includes('const firstByType = new Map()')
    || !packagedRunningLocalFieldLog.includes("return 'SMARTRUN_LOCAL_LOG|' + kind")
    || !packagedDeviceIdentity.includes('clearRunningLocalFieldLogs')) {
  fail('AIX must package the 12-hour privacy-bounded running field archive, first-event anchors, five-minute noisy-event write limiting, lifecycle capture, owner cleanup and ADB replay protocol');
}
if (!packagedWxJson.includes('normalizeWxJsonResponse')
    || !packagedWxJson.includes('decodeUtf8Fallback')) {
  fail('AIX must retain defensive JSON decoding for AIUI ArrayBuffer responses');
}
if (!packagedRunHud.includes("from '../../lib/motion_quality.js'")
    || !packagedRunHud.includes("from '../../lib/adaptive_stride.js'")
    || !packagedRunHud.includes("from '../../lib/speed_fusion.js'")
    || !(packagedRunHud.includes("typeof AbsoluteOrientationSensor !== 'undefined'")
      || packagedRunHud.includes("typeof AbsoluteOrientationSensor === 'undefined'"))
    || !packagedRunHud.includes("typeof Gyroscope !== 'undefined'")
    || !packagedRunHud.includes('startAuxMotionSensors(generation)')
    || !packagedRunHud.includes('orientation.start()')
    || !packagedRunHud.includes('gyro.start()')
    || !packagedRunHud.includes('try { gyro.stop(); }')
    || !packagedRunHud.includes('try { orientation.stop(); }')) {
  fail('AIX Run HUD must retain the optional AIUI 0.15 orientation/gyroscope path, fallback imports and bounded sensor lifecycle');
}
if (!cleanPackagedRunHud.includes("typeof this.enableWorldAwareness !== 'function'")
    || !/this\.enableWorldAwareness\(\{\s*mode:\s*'normal'\s*\}\)/.test(cleanPackagedRunHud)
    || !cleanPackagedRunHud.includes("typeof this.disableWorldAwareness !== 'function'")
    || !cleanPackagedRunHud.includes('this.disableWorldAwareness()')
    || !cleanPackagedRunHud.includes('this.motionOrientationSensor')
    || !cleanPackagedRunHud.includes('new AbsoluteOrientationSensor(')
    || /this\.orientationSensor\s*=(?!=)/.test(cleanPackagedRunHud)
    || /this\.orientationSensor\s*\.\s*stop\s*\(/.test(cleanPackagedRunHud)) {
  fail('AIX 0.16.1 World Awareness must be guarded, retain the motionOrientationSensor fallback, and never assign or stop the host orientationSensor');
}
if (!packagedMotionQuality.includes('export class MotionQualityGate')
    || !packagedMotionQuality.includes('export class VerticalAccelerationProjector')
    || !packagedMotionQuality.includes("HEAD_MOTION: 'head_motion'")
    || !packagedAdaptiveStride.includes("ADAPTIVE_STRIDE_STORAGE_KEY = 'smartrun_adaptive_stride_v2'")
    || !packagedAdaptiveStride.includes('export class AdaptiveStrideModel')
    || !packagedAdaptiveStride.includes('static restore(')
    || !packagedSpeedFusion.includes('export class MotionSpeedFusion')
    || !packagedSpeedFusion.includes('observeStationary(')
    || !packagedSpeedFusion.includes('paceSecPerKm')) {
  fail('AIX must package motion quality, owner-scoped adaptive stride and display-only speed fusion modules');
}
if (/navigator\.geolocation|getCurrentPosition|watchPosition|createGeolocationWatch|GpsPathTracker|onGpsPathMeasurement|startRunGeolocationWatch|stopRunGeolocationWatch/.test(packagedRunHud)) {
  fail('AIX Run HUD must not request unavailable glasses geolocation or use GPS-derived motion');
}
for (const requiredToken of [
  "AIUI_ID_STORAGE_KEY = 'smartrun_aiui_id'",
  "DEVICE_CREDENTIAL_STORAGE_KEY = 'smartrun_device_credential'",
  "DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY",
  "DEVICE_REGISTRATION_CREDENTIAL_PATH",
  "smartrun_device_registration_candidate",
  "device-registration-credential",
  "buildDeviceRegistrationCredentialRequest",
  "device_credential",
  "registrationBootstrapInflight",
  "commitServerRegistration",
  "serverRegistered: true",
  'normalizeAiuiId',
  'isValidAiuiId',
  'formatAiuiId',
  '/^(?=.*[A-Z])(?=.*\\d)[A-Z0-9]{8}$/',
  'publicDeviceId: owner',
  'recoverFreshAnonymousDeviceIdentity',
  'opts.userConfirmed !== true',
  'userConfirmationRequired: true',
  'if (ownerDataCleared',
  "clearStorageValueVerified(storage, AIUI_ID_STORAGE_KEY, '')",
]) {
  if (!packagedDeviceIdentity.includes(requiredToken)) {
    fail(`AIX device identity is missing the server-issued identity/AIUI ID guard: ${requiredToken}`);
  }
}
if (/registration_ticket|registrationTicket|device-registration-challenge|DEVICE_REGISTRATION_CHALLENGE/.test(
  packagedDeviceIdentity,
)) {
  fail('AIX device identity must use the long-lived device_credential contract without registration tickets');
}
if (/getDeviceSerialNumber|hardware_fingerprint|device_sn/.test(packagedDeviceIdentity)) {
  fail('AIX device identity must not read, simulate, hash or send a hardware serial number');
}
if (/buildDevicePairCodeRequest|parseDevicePairCodeResponse|device-pair-code|expires_in_s|expiresInS|bindingWindow/.test(
  packagedRunHud + '\n' + packagedDeviceIdentity,
)) {
  fail('AIX Agent Binding must not retain pair-code, expiry or local binding-window state');
}
if (packagedRunUpload.includes('aiui_id')) {
  fail('AIX run upload must not use the public AIUI ID as identity or authorization');
}
for (const forbiddenToken of ['autoFallbackDevice']) {
  if (packagedRunHud.includes(forbiddenToken)) {
    fail(`AIX Run HUD must not contain ${forbiddenToken}`);
  }
}
for (const requiredToken of [
  'writeHeartRateDevice',
  'heartDeviceName',
  'deviceDisplayName',
  'hrSubscribedAtMs',
  'm.bpm <= 0 || m.bpm >= 255',
  "filters: [{ services: ['heart_rate'] }]",
  'scanDiagnostic',
  'scanProgressText',
  '[SmartRun BLE]',
  'SCAN_REQUEST',
  'SCAN_ACTIVE',
  'DEVICE_FOUND',
  'SCAN_STOPPED',
  'scanStartedSuccessfully',
  'clearScanRetryTimer',
  '<text class="hint" ink:if="{{ discoveredDeviceCount === 0 }}">{{ scanDiagnostic }}</text>',
  '{{ searchChip }} · {{ scanProgressText }}',
  "const HR_MEASUREMENT_UUID = '00002a37-0000-1000-8000-00805f9b34fb';",
  'await device.gatt.connect()',
  "await server.getPrimaryService('heart_rate')",
  'await service.getCharacteristic(HR_MEASUREMENT_UUID)',
  'await characteristic.startNotifications()',
  'control-card',
  'primary-button',
  'beacon-hint',
  'bindtap="onScanTap"',
  'bindtap="selectDevice"',
  'startDiscovery',
  'selectDevice',
  'proceedToHud',
  'onConnectTap',
  'ensureBleAvailable',
  'discoveredDevices',
  'discoveredDeviceCount',
  'recordDiscoveredDevice',
  'syncDiscoveredDevices',
  'scheduleHrWatchdog',
  'clearHrWatchdogTimer',
  "import { MotionMetrics, MOTION_SOURCE } from '../../lib/motion_metrics.js';",
  "import { parseRscMeasurement } from '../../lib/rsc.js';",
  "const RSC_SERVICE_UUID = '00001814-0000-1000-8000-00805f9b34fb';",
  "const RSC_MEASUREMENT_UUID = '00002a53-0000-1000-8000-00805f9b34fb';",
  'probeOptionalRsc',
  'RSC_SUBSCRIBED',
  'keepRscConnectionWhenHeartRateStale',
  'rscPaceLive',
  'paceConnected',
  'motionSourceHint',
  'pendingEntryBpm = null',
  'keyBeacon',
  "surfacePhase: 'ready'",
  "surfacePhase: 'connecting'",
  "surfacePhase: 'menu'",
  "surfacePhase: 'training'",
  "surfacePhase: 'settings'",
  "surfacePhase: 'binding'",
  "surfacePhase: 'hud'",
  "surfacePhase: 'summary'",
  "surfacePhase: 'pre_run'",
  "surfacePhase: 'recovery'",
  'clearSurfaceTimers',
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
  if (!packagedRunHud.includes(requiredToken)) {
    fail(`AIX Run HUD is missing preferred-device guard: ${requiredToken}`);
  }
}
if (packagedRunHud.includes('扫描已停止 · 确认键结束')
    || packagedRunHud.includes('Scan stopped · Confirm to end')) {
  fail('AIX Run HUD must not restore the old scan-stopped/end helper copy');
}
if (/surfacePhase:\s*'slow-ready'|startSlowRun/.test(packagedRunHud)
    || !/class="slow-metrics"/.test(packagedRunHud)
    || !/openSlowMode/.test(packagedRunHud)
    || !/trackDistance:\s*!this\.isSlowJogMode\(\)/.test(packagedRunHud)
    || !/probeOptionalRsc\(device, server = null\)[\s\S]*?if \(this\.isSlowJogMode\(\)/.test(packagedRunHud)) {
  fail('AIX Slow Jog must reuse search/HUD, keep distance disabled and ignore optional RSC speed');
}
if (packagedRunHud.includes("surfacePhase: 'device-pairing'")
    || packagedRunHud.includes('device-pairing-screen')) {
  fail('AIX Agent Binding must use the shared binding state instead of a legacy route/state');
}
if (!/class="setting-row \{\{ settingMetronomeClass \}\}"\s+tabindex="2"\s+data-setting="metronome"\s+data-index="2"/.test(packagedRunHud)
    || !/class="setting-row \{\{ settingGuideQuickExitClass \}\}"\s+tabindex="3"\s+data-setting="guide"\s+data-index="3"/.test(packagedRunHud)
    || !/class="setting-row \{\{ settingBindingClass \}\}"\s+tabindex="4"\s+data-setting="binding"\s+data-index="4"/.test(packagedRunHud)
    || !/class="setting-row \{\{ settingHeartRateClass \}\}"\s+tabindex="5"\s+data-setting="heart"\s+data-index="5"/.test(packagedRunHud)
    || !/class="settings-back \{\{ settingBackClass \}\}"\s+tabindex="6"\s+data-setting="back"\s+data-index="6"/.test(packagedRunHud)
    || !/<view class="binding-screen" ink:if="\{\{ surfacePhase === 'binding' \}\}">/.test(packagedRunHud)
    || !/<text class="binding-label">AIUI ID<\/text>/.test(packagedRunHud)
    || !/<button class="binding-action \{\{ bindingRefreshClass \}\}"\s+tabindex="0"\s+data-action="refresh"\s+data-index="0"\s+bindfocus="onBindingFocus"\s+bindtap="onBindingTap">/.test(packagedRunHud)
    || !/<button class="binding-action binding-action-export \{\{ bindingExportClass \}\}"\s+tabindex="1"\s+data-action="export"\s+data-index="1"\s+bindfocus="onBindingFocus"\s+bindtap="onBindingTap">/.test(packagedRunHud)) {
  fail('AIX Settings must order Stride, Voice, Metronome, Guide, Binding, Heart and Back at indexes 0-6');
}
const packagedNormalizeSettingsMatch = packagedSettings.match(
  /export function normalizeRunSettings\(value\) \{([\s\S]*?)\n\}/,
);
const packagedNormalizeSettings = stripJsComments(
  packagedNormalizeSettingsMatch ? packagedNormalizeSettingsMatch[1] : '',
);
const hasAiEverMindCopy = /<view class="setting-info">\s*<text class="setting-name">(?:AI 大模型|AI Model|AIモデル)<\/text><text class="setting-value">(?:记忆使用 EverMind|Memory via EverMind|EverMindによる記憶)<\/text>\s*<\/view>/.test(packagedRunHud);
if (!hasAiEverMindCopy
    || /<button[^>]*data-setting="(?:summary|memory)"|settingAiSummaryClass|settingMemoryClass/.test(packagedRunHud)
    || /key\s*===\s*'(?:summary|memory)'/.test(packagedRunHud)) {
  fail('AIX Settings must present AI model and EverMind as non-interactive capability copy, never focusable rows');
}
if (!/memoryContext:\s*true/.test(packagedSettings)
    || !/aiSummary:\s*true/.test(packagedSettings)
    || !/memoryContext:\s*true/.test(packagedNormalizeSettings)
    || !/aiSummary:\s*true/.test(packagedNormalizeSettings)
    || /src\.(?:memoryContext|aiSummary)/.test(packagedNormalizeSettings)) {
  fail('AIX run settings data layer must force AI summary and EverMind memory on, including legacy stored false values');
}
const packagedMetronomeWav = inspectPcmWav(packagedMetronomeAudio);
if (!packagedMetronomeWav
    || packagedMetronomeWav.pcmFormat !== 1
    || packagedMetronomeWav.channels !== 2
    || packagedMetronomeWav.sampleRate !== 44100
    || packagedMetronomeWav.bitsPerSample !== 16
    || packagedMetronomeWav.durationMs < 175
    || packagedMetronomeWav.durationMs > 200
    || !(packagedMetronomeWav.firstAudibleMs != null
      && packagedMetronomeWav.firstAudibleMs <= 12)) {
  fail('AIX metronome must ship 175-200ms of 44.1kHz 16-bit stereo PCM with an audible transient in the first 12ms');
}
for (const bar of packagedMetronomeBars) {
  if (!bar.wav
      || bar.wav.pcmFormat !== 1
      || bar.wav.channels !== 2
      || bar.wav.sampleRate !== 44100
      || bar.wav.bitsPerSample !== 16
      || Math.abs(bar.wav.durationMs - bar.expectedDurationMs) > 2
      || bar.wav.durationMs < 1098
      || bar.wav.durationMs > 1227
      || !(bar.wav.firstAudibleMs != null && bar.wav.firstAudibleMs <= 12)) {
    fail(`AIX metronome ${bar.bpm} BPM four-beat bar is missing or invalid`);
  }
}
for (const token of [
  'new SoundCtor(src)', 'this._sound.play()', 'this._sound.stop()',
  'this._sound.destroy()', 'this._generation', 'clearTimeout(this._timerId)',
  'if (this._destroyed) return false',
]) {
  if (!packagedMetronome.includes(token)) {
    fail(`AIX metronome lifecycle is missing: ${token}`);
  }
}
const packagedEnsureMetronome = stripJsComments(extractMethodBody(packagedRunHud, 'ensureMetronome'));
const packagedStopMetronome = stripJsComments(extractMethodBody(packagedRunHud, 'stopMetronomePlayback'));
const packagedStartRun = stripJsComments(extractMethodBody(packagedRunHud, 'startRun'));
const packagedMetronomeOnShow = stripJsComments(extractMethodBody(packagedRunHud, 'onShow'));
const packagedMetronomeOnHide = stripJsComments(extractMethodBody(packagedRunHud, 'onHide'));
const packagedMetronomeOnUnload = stripJsComments(extractMethodBody(packagedRunHud, 'onUnload'));
const packagedMetronomeSummary = stripJsComments(extractMethodBody(packagedRunHud, 'finishRunToSummary'));
const packagedMetronomeSummaryFinalize = stripJsComments(
  extractMethodBody(packagedRunHud, 'finalizeRunAfterSummaryCommit'),
);
const packagedSummaryCommitAudit = auditSummaryCommitFirst(
  packagedMetronomeSummary,
  packagedMetronomeSummaryFinalize,
);
const packagedMetronomeClose = stripJsComments(extractMethodBody(packagedRunHud, 'closeAgentFromSummary'));
const packagedMenuFocus = stripJsComments(extractMethodBody(packagedRunHud, 'setMenuFocus'));
const packagedSettingFocus = stripJsComments(extractMethodBody(packagedRunHud, 'setSettingFocus'));
const packagedSettingFocusHandler = stripJsComments(extractMethodBody(packagedRunHud, 'onSettingFocus'));
const packagedSettingTap = stripJsComments(extractMethodBody(packagedRunHud, 'onSettingTap'));
const packagedDirectionClaim = stripJsComments(
  extractMethodBody(packagedRunHud, 'claimSurfaceDirection'),
);
const packagedDirectionCodes = stripJsComments(
  extractMethodBody(packagedRunHud, 'isSurfaceDirectionCode'),
);
const packagedDirectionHandler = stripJsComments(
  extractMethodBody(packagedRunHud, 'handleSurfaceDirection'),
);
const packagedRunKeyDown = stripJsComments(extractMethodBody(packagedRunHud, 'onKeyDown'));
const packagedHostFocus = stripJsComments(extractMethodBody(packagedRunHud, 'onHostFocus'));
const packagedHostBlur = stripJsComments(extractMethodBody(packagedRunHud, 'onHostBlur'));
if (!/import \{ Sound \} from 'audio';/.test(packagedRunHud)
    || !/import \{ Metronome \} from '\.\.\/\.\.\/lib\/metronome\.js';/.test(packagedRunHud)
    || !/160:\s*'\.\.\/\.\.\/assets\/audio\/metro_0468_bar_160\.wav'/.test(packagedRunHud)
    || !/170:\s*'\.\.\/\.\.\/assets\/audio\/metro_0468_bar_170\.wav'/.test(packagedRunHud)
    || !/180:\s*'\.\.\/\.\.\/assets\/audio\/metro_0468_bar_180\.wav'/.test(packagedRunHud)
    || !/const METRONOME_BEATS_PER_PLAYBACK = 4;/.test(packagedRunHud)
    || !/new Metronome\([\s\S]*SoundCtor:\s*Sound[\s\S]*src:\s*audioSrc[\s\S]*beatsPerPlayback:\s*METRONOME_BEATS_PER_PLAYBACK/.test(packagedEnsureMetronome)) {
  fail('AIX Run HUD metronome must construct the documented per-BPM four-beat Sound player');
}
if (!/metronome\.stop\(\)[\s\S]*options\.destroy === true[\s\S]*metronome\.destroy\(\)/.test(packagedStopMetronome)
    || !/startRunMetronome\(\)/.test(packagedStartRun)
    || !/startRunMetronome\(\)/.test(packagedMetronomeOnShow)
    || !/stopMetronomePlayback\(\)/.test(packagedMetronomeOnHide)
    || !/stopMetronomePlayback\(\{ destroy: true \}\)/.test(packagedMetronomeOnUnload)
    || !/setData\([\s\S]*summaryFinalizeTimer\s*=\s*setTimeout/.test(packagedMetronomeSummary)
    || !/stopMetronomePlayback\(\{ destroy: true \}\)/.test(packagedMetronomeSummaryFinalize)
    || !/stopMetronomePlayback\(\{ destroy: true \}\)/.test(packagedMetronomeClose)) {
  fail('AIX Run HUD must stop Sound on hide and destroy the metronome on summary, exit and unload');
}
if (!packagedSummaryCommitAudit.ok) {
  const details = [];
  if (packagedSummaryCommitAudit.firstSetDataIndex < 0) details.push('missing first setData');
  if (packagedSummaryCommitAudit.prematureDeferredTokens.length) {
    details.push(
      `before first setData: ${packagedSummaryCommitAudit.prematureDeferredTokens.join(', ')}`,
    );
  }
  if (packagedSummaryCommitAudit.missingFinalizerTokens.length) {
    details.push(
      `missing from finalizer: ${packagedSummaryCommitAudit.missingFinalizerTokens.join(', ')}`,
    );
  }
  fail(`AIX Run HUD summary must commit its first frame before storage/native cleanup (${details.join('; ')})`);
}
if (!/next\s*!==\s*2[\s\S]*stopMetronomePlayback\(\)/.test(packagedSettingFocus)
    || /writeRunSettings|nextMetronomeBpm|metronomeBpm\s*=/.test(packagedSettingFocus)
    || /writeRunSettings|nextMetronomeBpm|metronomeBpm\s*=/.test(packagedSettingFocusHandler)) {
  fail('AIX Run HUD must stop metronome preview when focus leaves index 2 without changing the saved BPM');
}
const packagedFocusMayStartMetronome = /startMetronomePreview|startRunMetronome|ensureMetronome/;
const packagedSettingPersistAt = packagedSettingTap.indexOf('writeRunSettings');
const packagedSettingPreviewAt = packagedSettingTap.indexOf('startMetronomePreview');
if (packagedFocusMayStartMetronome.test(packagedSettingFocus)
    || packagedFocusMayStartMetronome.test(packagedSettingFocusHandler)
    || !/key\s*===\s*'metronome'[\s\S]*next\.metronomeBpm\s*=\s*nextMetronomeBpm\([\s\S]*startMetronomePreview\(bpm\)/.test(packagedSettingTap)
    || packagedSettingPersistAt < 0
    || packagedSettingPreviewAt <= packagedSettingPersistAt) {
  fail('AIX Run HUD must never auto-start metronome preview on focus or refocus; only an explicit persisted Metronome activation may start it');
}
if (!/key\s*===\s*'back'[\s\S]*showFeatureMenu\(\)[\s\S]*menuEntryConfirmGuardUntilMs\s*=\s*Date\.now\(\)\s*\+\s*SURFACE_ENTRY_CONFIRM_GRACE_MS/.test(packagedSettingTap)
    || !/claimMenuActivation[\s\S]{0,400}isMenuEntryInputGuarded\(now\)/.test(packagedRunHud)) {
  fail('AIX Run HUD Settings Back must return to the menu and guard the menu from the same confirmation tail packet');
}
const packagedOpenBindingBody = stripJsComments(extractMethodBody(packagedRunHud, 'openDevicePairing'));
const packagedBindingActionBody = stripJsComments(extractMethodBody(packagedRunHud, 'onBindingActionTap'));
const packagedBindingExportBody = stripJsComments(
  extractMethodBody(packagedRunHud, 'onBindingExportTap'),
);
const packagedBindingReplayBody = stripJsComments(
  extractMethodBody(packagedRunHud, 'replayRunningLocalFieldLog'),
);
const packagedBindingReturnBody = stripJsComments(
  extractMethodBody(packagedRunHud, 'showSettingsFromBinding'),
);
const packagedBindingHideBody = stripJsComments(extractMethodBody(packagedRunHud, 'onHide'));
const packagedBindingActionRule = extractRule(packagedRunHud, '.binding-action');
const packagedBindingFocusedRule = extractRule(packagedRunHud, '.binding-action-focused');
if (!packagedOpenBindingBody
    || /recoverFreshAnonymousDeviceIdentity/.test(packagedOpenBindingBody)
    || !/refreshDeviceIdentity/.test(packagedBindingActionBody)
    || !/readLatestRunningLocalFieldLog/.test(packagedBindingExportBody)
    || !/replayRunningLocalFieldLog[\s\S]*onComplete/.test(packagedBindingExportBody)
    || !/typeof options\.onComplete === 'function'[\s\S]*options\.onComplete\(\)/.test(packagedBindingReplayBody)
    || !/cancelRunningLocalFieldLogReplay\(\)/.test(packagedBindingReturnBody)
    || !/bindingExportWasPending[\s\S]*cancelRunningLocalFieldLogReplay\(\)/.test(packagedBindingHideBody)
    || /\boutline(?:-[a-z-]+)?\s*:/.test(packagedBindingActionRule)
    || !/\boutline-width:\s*2px;/.test(packagedBindingFocusedRule)
    || !/\boutline-style:\s*solid;/.test(packagedBindingFocusedRule)
    || !/\boutline-color:\s*var\(--color-primary/.test(packagedBindingFocusedRule)
    || !/\boutline-offset:\s*-2px;/.test(packagedBindingFocusedRule)
    || !(packagedRunHud.includes('可在已登录 APK 输入此 ID 绑定')
      || packagedRunHud.includes('Enter this ID in the signed-in APK to pair'))) {
  fail('AIX Agent Binding must expose the permanent current AIUI ID and use Confirm only to refresh status when Refresh is focused; Export must use the separate focused field-log action with bounded completion and leave/hide cancellation');
}
const packagedRecoveryBody = stripJsComments(
  extractMethodBody(packagedRunHud, 'recoverDeviceIdentityFromBinding'),
);
if (!/recoverFreshAnonymousDeviceIdentity/.test(packagedRecoveryBody)
    || !/userConfirmed:\s*true/.test(packagedRecoveryBody)) {
  fail('AIX fresh anonymous recovery must require userConfirmed from the visible binding action');
}
if (!/navigator\.bluetooth\.scanDevices\(\{\s*filters: \[\{ services: \['heart_rate'\] \}\],\s*\}\)/.test(packagedRunHud)) {
  fail('AIX Run HUD scan options must be fresh per-call literals matching the official sample shapes');
}
if (/Object\.freeze\(\{\s*(?:filters|acceptAllDevices)/.test(packagedRunHud)) {
  fail('AIX Run HUD must not pass frozen/shared options objects across the host bridge');
}
if (/navigator\.bluetooth\.getAvailability/.test(packagedRunHud)) {
  fail('AIX Run HUD must not pre-probe getAvailability before scanDevices');
}
if (/\boptionalServices\s*:/.test(packagedRunHud)) {
  fail('AIX Run HUD scan must not add optionalServices to either scan request');
}
const packagedTickerBody = stripJsComments(extractMethodBody(packagedRunHud, 'startTicker'));
const packagedSignalTickerBody = stripJsComments(
  extractMethodBody(packagedRunHud, 'requestRunTick'),
);
if (!/setInterval\(\(\) => this\.requestRunTick\('timer'\), TICK_MS\)/.test(packagedTickerBody)
    || /setData\(/.test(packagedTickerBody)
    || !/this\.tick\(\)/.test(packagedSignalTickerBody)
    || /setInterval\(|setData\(/.test(packagedSignalTickerBody)) {
  fail('AIX Run HUD must keep one bounded timer routed through the shared tick throttle');
}
if (VISUAL_STYLE_MOTION_RE.test(packagedRunHud) || OBSOLETE_VISUAL_MOTION_RE.test(packagedRunHud)) {
  fail('AIX Run HUD must remain keyframe/animation/gradient-free');
}
const packagedTransitionCount = (packagedRunHud.match(/\btransition(?:-[a-z-]+)?\s*:/gi) || []).length;
if (packagedTransitionCount !== 0) {
  fail('AIX Run HUD sample-clone Screen 02 must stay transition-free');
}
if (/CONNECT_DEADLINE_MS|MAX_AUTO_BLE_ATTEMPTS/.test(packagedRunHud)) {
  fail('AIX Run HUD must not restore an automatic entry deadline or finite search-attempt cap');
}
if (/navigator\.bluetooth\.getDevices\s*\(/.test(packagedRunHud)
    || /findRememberedBleDevice/.test(packagedRunHud)) {
  fail('AIX Run HUD must start nearby scanning without waiting for the authorized-device cache');
}
const hasSearchingCopy = packagedRunHud.includes('正在搜索心率设备')
  || packagedRunHud.includes('Searching for HR devices')
  || packagedRunHud.includes('心拍デバイスを検索中');
const hasNextCopy = packagedRunHud.includes("primaryLabel: '下一步'")
  || packagedRunHud.includes("primaryLabel: 'Next'")
  || packagedRunHud.includes("primaryLabel: '次へ'");
if (!hasSearchingCopy || !hasNextCopy
    || !packagedRunHud.includes('showConnectedResult')
    || !packagedRunHud.includes('finishEntry')) {
  fail('AIX Run HUD must show active search feedback and expose unconditional Next entry');
}
const packagedSearchNav = packagedRunHud.match(
  /<view class="connect-next-nav" role="navigation">([\s\S]*?)<\/view>/,
);
if (!packagedSearchNav
    || (packagedSearchNav[1].match(/<button\b/g) || []).length !== 1
    || !/class="primary-button \{\{ searchPrimaryClass \}\}"[\s\S]*tabindex="0"[\s\S]*bindfocus="onSearchFocus"[\s\S]*bindtap="onScanTap"/.test(packagedSearchNav[1])
    || !/class="device-row \{\{ item\.deviceSelectedClass \}\} \{\{ item\.deviceFocusClass \}\}"/.test(packagedRunHud)
    || /<view class="list-card"[^>]*role="navigation"/.test(packagedRunHud)
    || !/autoConnectBestCandidate\(\);[\s\S]{0,40}return this\.proceedToHud\(\);/.test(packagedRunHud)) {
  fail('AIX Run HUD search must keep one main button in a static role=navigation container and dynamic devices outside');
}
if (/role="navigation"[^>]*ink:if|ink:if[^>]*role="navigation"/.test(packagedRunHud)
    || /class="\{\{[^"]*\}\}"[^>]*role="navigation"|role="navigation"[^>]*class="\{\{/.test(packagedRunHud)) {
  fail('AIX Run HUD navigation containers must be static: literal class, no ink:if');
}
if (/<view[^>]*connect-next[^>]*tabindex=/.test(packagedRunHud)) {
  fail('AIX Run HUD must not emulate its hardware Next action with view role=button');
}
const packagedConnectedStart = packagedRunHud.indexOf('  showConnectedResult(');
const packagedFinishStart = packagedRunHud.indexOf('  finishEntry(', packagedConnectedStart);
const packagedConnectedBlock = packagedConnectedStart >= 0 && packagedFinishStart > packagedConnectedStart
  ? packagedRunHud.slice(packagedConnectedStart, packagedFinishStart) : '';
if (/finishEntry\s*\(/.test(packagedConnectedBlock)) {
  fail('AIX Run HUD must remain on Screen 02 when a device or BPM is found');
}
const packagedOutcomeStart = packagedRunHud.indexOf('  markEntryConnectionOutcome(');
const packagedShowConnectedStart = packagedRunHud.indexOf('  showConnectedResult(', packagedOutcomeStart);
const packagedOutcomeBlock = packagedOutcomeStart >= 0 && packagedShowConnectedStart > packagedOutcomeStart
  ? packagedRunHud.slice(packagedOutcomeStart, packagedShowConnectedStart) : '';
if (!/class="unified-grid"\s+ink:if="\{\{ runMode !== 'slow' && showHeartRate \}\}"/.test(packagedRunHud)
    || !/class="glasses-grid"\s+ink:if="\{\{ runMode !== 'slow' && !showHeartRate \}\}"/.test(packagedRunHud)) {
  fail('AIX Run HUD must expose both the 03 heart-rate and glasses-only states');
}
for (const grid of [
  'grid-template-columns: 84px 92px 116px 149px;',
  'grid-template-columns: 14px 68px 60px 80px 94px 115px;',
]) {
  if (!packagedRunHud.includes(grid)) fail(`AIX Run HUD is missing the 456px grid: ${grid}`);
}
if (/pace:\s*(?:'正在计算'|'Calculating')/.test(packagedRunHud)
    || !/const\s+INITIAL_PACE\s*=\s*formatPace\(null\)/.test(packagedRunHud)
    || !/pace:\s*INITIAL_PACE/.test(packagedRunHud)
    || !/cadence:\s*CADENCE_PENDING/.test(packagedRunHud)
    || !/if\s*\(cadenceReady\)\s*this\.cadenceEverReady\s*=\s*true;/.test(packagedRunHud)
    || !/const cadenceVal\s*=\s*Number\.isFinite\(stickyCadenceSpm\)\s*&&\s*stickyCadenceSpm\s*>\s*0\s*\?\s*formatCadence\(stickyCadenceSpm\)\s*:\s*CADENCE_PENDING;/.test(packagedRunHud)
    || !/cadence:\s*cadenceVal/.test(packagedRunHud)
    || /cadence:\s*(?:0|'0'|"0"|String\(\s*dispCadence\s*\))/.test(packagedRunHud)
    || !/estimatePaceSecPerKmFromCadence/.test(packagedRunHud)
    || !/pace:\s*paceVal/.test(packagedRunHud)
    || !/paceStateClass:\s*''/.test(packagedRunHud)) {
  fail('AIX Run HUD must keep a safe numeric pace after trusted motion, expire stale cadence to -- after its short hold, and never render cadence as a literal zero');
}
const packagedEnvironmentRule = extractRule(packagedRunHud, '.hud-environment');
if (!/<text class="hud-environment"\s+ink:if="\{\{ !safetyHudHint && !hudHint \}\}">\{\{ hudEnvironment \}\}<\/text>/.test(packagedRunHud)
    || !/formatHudClock/.test(packagedRunHud)
    || /refreshHudWeather|lib\/weather\.js/.test(packagedRunHud)
    || !/\bwidth:\s*154px;/.test(packagedEnvironmentRule)
    || !/\bline-height:\s*26px;/.test(packagedEnvironmentRule)) {
  fail('AIX Run HUD top row must show local time without weather or blocking status chips');
}
if (!/class="mode-chip" ink:if="\{\{ showHeartRate \}\}"/.test(packagedRunHud)) {
  fail('AIX Run HUD must hide the top-right chip in glasses-only mode');
}
const packagedHasShortGlassesEstimate = packagedRunHud.includes("motionSourceHint: '眼镜估算'")
  || packagedRunHud.includes("motionSourceHint: 'Glasses est.'")
  || packagedRunHud.includes("motionSourceHint: 'メガネ推定'");
const packagedHasRunWarmup = /const RUN_STABILIZE_HINT = '(?:请稳定跑约 5 秒|Run steady ~5 sec|約5秒安定して走ってください)';/.test(packagedRunHud)
  && /const RUN_STABILIZE_MIN_MS = 5000;/.test(packagedRunHud)
  && /class="mode-chip"\s+ink:if="\{\{ runWarmupHint && !safetyHudHint && !hudHint \}\}"[^>]*>\{\{ runWarmupHint \}\}<\/text>/.test(packagedRunHud);
if (!/class="mode-chip"\s+ink:if="\{\{ !runWarmupHint && !paceConnected && !safetyHudHint && !hudHint \}\}"[^>]*>\{\{ motionSourceHint \}\}<\/text>/.test(packagedRunHud)
    || !/class="mode-chip(?: pace-chip)?"\s+ink:if="\{\{ !runWarmupHint && paceConnected \}\}"/.test(packagedRunHud)
    || !packagedHasShortGlassesEstimate
    || !packagedHasRunWarmup
    || /class="source-note"\s+ink:if="\{\{ !paceConnected && !hudHint \}\}"/.test(packagedRunHud)
    || packagedRunHud.includes('步频 / 配速由眼镜估算')
    || packagedRunHud.includes('未接入设备步频 / 配速 · 已切换眼镜估算')
    || packagedRunHud.includes('Cadence / pace from glasses')
    || packagedRunHud.includes('No device cadence / pace · Using glasses')) {
  fail('AIX Run HUD must show the five-second stabilization hint, then the short Glasses Estimate with mode-chip and a passive Pace Live chip only for live device pace');
}
for (const token of [
  'class="feature-nav" role="navigation"',
  'class="settings-list" role="navigation"',
  'const SURFACE_CONFIRM_DEDUPE_MS = 400',
  'tabindex="0"', 'tabindex="1"', 'tabindex="2"', 'tabindex="3"',
  'tabindex="4"', 'tabindex="5"', 'settingBackClass',
]) {
  if (!packagedRunHud.includes(token)) fail(`AIX Run HUD is missing page-owned focus invariant: ${token}`);
}
const packagedFeatureStart = packagedRunHud.indexOf('<view class="feature-menu ');
const packagedTrainingStart = packagedRunHud.indexOf(
  '<view class="training-screen"', packagedFeatureStart,
);
const packagedFeatureMarkup = packagedFeatureStart >= 0
  && packagedTrainingStart > packagedFeatureStart
  ? packagedRunHud.slice(packagedFeatureStart, packagedTrainingStart) : '';
const packagedIndoorRunLabel = packagedProvenance.locale === AIX_LOCALES.en
  ? '>Indoor Run</text>'
  : (packagedProvenance.locale === AIX_LOCALES.ja ? '>室内ラン</text>' : '>室内跑</text>');
const packagedSlowJogLabel = packagedProvenance.locale === AIX_LOCALES.en
  ? '>Slow Jog</text>'
  : (packagedProvenance.locale === AIX_LOCALES.ja ? '>スロージョグ</text>' : '>超慢跑</text>');
const packagedTrainingLabel = packagedProvenance.locale === AIX_LOCALES.en
  ? '>Training Plans</text>'
  : (packagedProvenance.locale === AIX_LOCALES.ja ? '>トレーニング</text>' : '>训练计划</text>');
if ((packagedFeatureMarkup.match(/<button\b/g) || []).length !== 6
    || !packagedFeatureMarkup.includes('bindtap="openFreeMode"')
    || !packagedFeatureMarkup.includes('bindtap="openSlowMode"')
    || !packagedFeatureMarkup.includes('bindtap="openGarminVirtualMode"')
    || !packagedFeatureMarkup.includes('bindtap="openTrainingMode"')
    || !packagedFeatureMarkup.includes('bindtap="openSettingsMode"')
    || !packagedFeatureMarkup.includes(packagedSlowJogLabel)
    || !packagedFeatureMarkup.includes(packagedIndoorRunLabel)
    || !packagedFeatureMarkup.includes(packagedTrainingLabel)
    || !packagedFeatureMarkup.includes('ink:if="{{ todayWorkoutAvailable }}"')
    || (packagedFeatureMarkup.match(/bindfocus="onMenuFocus"/g) || []).length !== 6
    || !/shouldAcceptHostFocus[\s\S]*onMenuFocus/.test(packagedRunHud)) {
  fail('AIX Run HUD feature menu must expose Free Run, Slow Jog, Indoor Run, Training Plans and Settings');
}
const packagedSettingsListStart = packagedRunHud.indexOf(
  '<view class="settings-list" role="navigation">',
);
const packagedSettingsFootStart = packagedRunHud.indexOf(
  '<text class="settings-foot">', packagedSettingsListStart,
);
const packagedSettingsMarkup = packagedSettingsListStart >= 0
    && packagedSettingsFootStart > packagedSettingsListStart
  ? packagedRunHud.slice(packagedSettingsListStart, packagedSettingsFootStart) : '';
if (!/data-setting="stride"[\s\S]*data-setting="voice"[\s\S]*data-setting="metronome"[\s\S]*data-setting="guide"[\s\S]*data-setting="binding"[\s\S]*class="setting-info"[\s\S]*data-setting="heart"[\s\S]*data-setting="back"/.test(packagedSettingsMarkup)) {
  fail('AIX Settings visual order must be Stride, Voice, Metronome, Guide, Binding, passive EverMind, Heart, then the absolute Back control');
}
const packagedSettingIndexes = [...packagedSettingsMarkup.matchAll(
  /class="setting-row \{\{ setting[A-Za-z]+Class \}\}"\s+tabindex="(\d)"/g,
)].map((match) => Number(match[1]));
if (packagedSettingIndexes.join(',') !== '0,1,2,3,4,5') {
  fail('AIX Run HUD Settings must expose exactly six contiguous configuration rows');
}
const packagedPassiveSettingsRow = packagedSettingsMarkup.match(
  /<view class="setting-info"([^>]*)>/,
);
const packagedSettingsCanvasRule = extractRule(packagedRunHud, '.settings-screen');
const packagedSettingsScreenRule = extractLastRule(packagedRunHud, '.settings-screen');
const packagedSettingsTopRule = extractLastRule(packagedRunHud, '.settings-top');
const packagedSettingsListRule = extractLastRule(packagedRunHud, '.settings-list');
const packagedSettingRowRule = extractLastRule(packagedRunHud, '.setting-row');
const packagedSettingInfoRule = extractLastRule(packagedRunHud, '.setting-info');
const packagedSettingsFootRule = extractLastRule(packagedRunHud, '.settings-foot');
const packagedSettingFocusedRule = extractLastRule(
  packagedRunHud,
  '.setting-row.setting-row-focused',
);
const packagedSettingsBackRule = extractLastRule(packagedRunHud, '.settings-back');
const packagedSettingsBackFocusedRule = extractLastRule(
  packagedRunHud,
  '.settings-back.setting-row-focused',
);
const packagedSettingsVerticalPx = 12 + 36 + 2 + 264 + 2 + 24 + 12;
if (!/\bwidth:\s*480px;/.test(packagedSettingsCanvasRule)
    || !/\bheight:\s*352px;/.test(packagedSettingsCanvasRule)
    || !/\bbox-sizing:\s*border-box;/.test(packagedSettingsCanvasRule)
    || !/\bpadding:\s*12px 14px;/.test(packagedSettingsScreenRule)
    || !/\bheight:\s*36px;/.test(packagedSettingsTopRule)
    || !/\bheight:\s*264px;/.test(packagedSettingsListRule)
    || !/\bmargin:\s*2px 0 0;/.test(packagedSettingsListRule)
    || !/\bheight:\s*40px;/.test(packagedSettingRowRule)
    || !/\bheight:\s*24px;/.test(packagedSettingInfoRule)
    || !/\bheight:\s*24px;/.test(packagedSettingsFootRule)
    || !/\bmargin:\s*2px 0 0;/.test(packagedSettingsFootRule)
    || !/\bline-height:\s*24px;/.test(packagedSettingsFootRule)
    || packagedSettingsVerticalPx !== 352) {
  fail('AIX Settings must use six 40px controls plus one 24px passive row, a 264px list, and a 24px footer inside the 480x352 canvas');
}
const packagedSettingsStyle = packagedRunHud.slice(packagedRunHud.indexOf('<style>'));
if ((packagedSettingsMarkup.match(/<button\b/g) || []).length !== 7
    || (packagedSettingsMarkup.match(/class="setting-row /g) || []).length !== 6
    || (packagedSettingsMarkup.match(/class="setting-info"/g) || []).length !== 1
    || !packagedPassiveSettingsRow
    || /\b(?:tabindex|role|bindfocus|bindtap)\s*=/.test(
      packagedPassiveSettingsRow ? packagedPassiveSettingsRow[1] : '',
    )
    || /\boutline(?:-[a-z-]+)?\s*:/.test(packagedSettingRowRule)
    || /\boutline(?:-[a-z-]+)?\s*:/.test(packagedSettingInfoRule)
    || /\boutline(?:-[a-z-]+)?\s*:/.test(packagedSettingsBackRule)
    || !/\boutline-width:\s*2px;/.test(packagedSettingFocusedRule)
    || !/\boutline-width:\s*2px;/.test(packagedSettingsBackFocusedRule)
    || !/\boutline-style:\s*solid;/.test(packagedSettingsBackFocusedRule)
    || !/\boutline-offset:\s*-2px;/.test(packagedSettingsBackFocusedRule)
    || /\.setting-info[^,{]*(?:focus|focused)[^{]*\{/.test(packagedSettingsStyle)) {
  fail('AIX Settings must expose seven interactive targets with inward focus only on the selected target; the AI / EverMind row remains passive');
}
if (!/const SETTINGS_FOCUS_COUNT = 7;/.test(packagedRunHud)
    || !/raw % SETTINGS_FOCUS_COUNT/.test(packagedSettingFocus)
    || !/const keys = \[\s*'stride', 'voice', 'metronome', 'guide', 'binding', 'heart', 'back',\s*\]/.test(packagedRunHud)) {
  fail('AIX Run HUD Settings keyboard routing must be stride, voice, metronome, guide, binding, heart and back');
}
if (/class="passive-footer"/.test(packagedRunHud)) {
  fail('AIX Run HUD must keep the latest footer-free display layout');
}
if (/class="(?:hud-footer|hud-heart-card)"/.test(packagedRunHud)) {
  fail('AIX Run HUD must not restore the obsolete footer or heart card');
}
const packagedContainerRule = extractRule(packagedRunHud, '.container');
if (!/\bmin-height:\s*352px;/.test(packagedContainerRule)
    || !/\bflex-direction:\s*column;/.test(packagedContainerRule)) {
  fail('AIX Run entry container must be the sample-clone flow root with a 352px floor');
}
const packagedRunRule = extractRule(packagedRunHud, '.run-screen');
if (!/\bjustify-content:\s*flex-end;/.test(packagedRunRule)
    || !/\bpadding:\s*5px 10px 4px;/.test(packagedRunRule)) {
  fail('AIX Run HUD metrics must stay anchored to the bottom safe area');
}
const packagedMetricRule = extractRule(packagedRunHud, '.run-metric');
if (!/\bborder:\s*0;/.test(packagedMetricRule)
    || !/\bborder-radius:\s*0;/.test(packagedMetricRule)
    || !/\bbackground-color:\s*transparent;/.test(packagedMetricRule)) {
  fail('AIX Run HUD passive metrics must remain borderless and transparent');
}
if (!/hudHint:\s*''/.test(packagedRunHud)) {
  fail('AIX Run HUD normal state must keep hudHint empty');
}
const unifiedStart = packagedRunHud.indexOf('<view class="unified-grid"');
const glassesStart = packagedRunHud.indexOf('<view class="glasses-grid"');
const slowStart = packagedRunHud.indexOf('<view class="slow-metrics"');
const unifiedMarkup = unifiedStart >= 0 && glassesStart > unifiedStart
  ? packagedRunHud.slice(unifiedStart, glassesStart) : '';
const glassesMarkup = glassesStart >= 0 && slowStart > glassesStart
  ? packagedRunHud.slice(glassesStart, slowStart) : '';
const packagedZoneRule = extractRule(packagedRunHud, '.zone');
const packagedDotRule = extractRule(packagedRunHud, '.dot');
const packagedDotOnRule = extractRule(packagedRunHud, '.dot-on');
if (!/<view class="zone">\s*<view class="\{\{ dot5 \}\}"><\/view>\s*<view class="\{\{ dot4 \}\}"><\/view>\s*<view class="\{\{ dot3 \}\}"><\/view>\s*<view class="\{\{ dot2 \}\}"><\/view>\s*<view class="\{\{ dot1 \}\}"><\/view>\s*<\/view>\s*<view class="run-metric run-hero">/.test(unifiedMarkup)
    || !/heartZoneDotFields\(zone\)/.test(packagedRunHud)
    || !/\bflex-direction:\s*column;/.test(packagedZoneRule)
    || !/\bwidth:\s*14px;/.test(packagedZoneRule)
    || !/\bwidth:\s*10px;/.test(packagedDotRule)
    || !/\bheight:\s*6px;/.test(packagedDotRule)
    || !/\bbackground-color:\s*var\(--color-primary/.test(packagedDotOnRule)) {
  fail('AIX Run HUD heart-rate state must restore the five-dot Z5-to-Z1 zone indicator to the left of heart rate');
}
for (const [name, markup] of [['heart-rate', unifiedMarkup], ['glasses-only', glassesMarkup]]) {
  const pace = Math.max(markup.lastIndexOf('>配速</text>'), markup.lastIndexOf('>Pace</text>'), markup.lastIndexOf('>ペース</text>'));
  const elapsed = Math.max(markup.lastIndexOf('>时长</text>'), markup.lastIndexOf('>Time</text>'), markup.lastIndexOf('>時間</text>'));
  if (pace < 0 || elapsed < 0 || pace < elapsed) {
    fail(`AIX Run HUD ${name} state must keep pace in the rightmost metric column`);
  }
}
const runOnLoadStart = packagedRunHud.indexOf('  onLoad(');
const runOnUnloadStart = packagedRunHud.indexOf('  onUnload() {');
const runOnHideStart = packagedRunHud.indexOf('  onHide() {');
const runOnShowStart = packagedRunHud.indexOf('  onShow() {');
const runClearSurfaceStart = packagedRunHud.indexOf('  clearSurfaceTimers() {');
const runStartRunStart = packagedRunHud.indexOf('  startRun() {');
if ([runOnLoadStart, runOnUnloadStart, runOnHideStart, runOnShowStart,
  runClearSurfaceStart, runStartRunStart]
  .some((index) => index < 0)) {
  fail('AIX Run HUD lifecycle blocks are incomplete');
}
const packagedRunOnLoad = packagedRunHud.slice(runOnLoadStart, runOnUnloadStart);
const packagedRunOnHide = packagedRunHud.slice(runOnHideStart, runOnShowStart);
const packagedRunOnShow = packagedRunHud.slice(runOnShowStart, runClearSurfaceStart);
const packagedRunKeyUpStart = packagedRunHud.indexOf('  onKeyUp(event) {');
const packagedRunKeyUpEnd = packagedRunHud.indexOf('\n  },\n};', packagedRunKeyUpStart);
const packagedRunKeyUp = packagedRunKeyUpStart >= 0 && packagedRunKeyUpEnd > packagedRunKeyUpStart
  ? packagedRunHud.slice(packagedRunKeyUpStart, packagedRunKeyUpEnd) : '';
const packagedNativeSearchPrimary = packagedRunKeyUp.indexOf(
  "if (isSurfaceConfirm && code !== 'GlobalHook'",
);
const packagedSearchFallback = packagedRunKeyUp.indexOf(
  'if (isSurfaceConfirm', packagedNativeSearchPrimary + 1,
);
const packagedFallbackPreventDefault = packagedRunKeyUp.indexOf(
  'preventDefault', packagedSearchFallback,
);
const packagedFallbackActivation = Math.max(
  packagedRunKeyUp.indexOf('activateSearchFocused', packagedSearchFallback),
  packagedRunKeyUp.indexOf('activateMultiTargetFocused', packagedSearchFallback),
);
if (/autoConnectBle|scheduleAutoConnectBle/.test(packagedRunOnLoad)) {
  fail('AIX Run HUD must not start interactive BLE APIs from onLoad');
}
if (!packagedRunOnHide.includes('this.clearSurfaceTimers();')
    || !/clearSurfaceTimers\(\)\s*\{[\s\S]*clearBleReadyFallback\(\)/.test(packagedRunHud)) {
  fail('AIX Run HUD must cancel its onShow BLE fallback when hidden');
}
if (/this\.startRun\(\)/.test(packagedRunOnLoad)) {
  fail('AIX Run HUD must not count time before Next enters Screen 03');
}
if (/proceedToHud|onScanTap|onConnectTap/.test(packagedRunKeyUp)
      || !/ArrowUp[\s\S]*ArrowDown[\s\S]*ArrowLeft[\s\S]*ArrowRight/.test(packagedDirectionCodes)
      || !/isSurfaceDirectionCode[\s\S]*canHandleSurfaceDirection[\s\S]*DIRECTION_KEYDOWN/.test(packagedRunKeyDown)
      || /handleSurfaceDirection|setMenuFocus|setSettingFocus|setBindingFocus|setSearchFocus/.test(packagedRunKeyDown)
      || !/isSurfaceDirectionCode[\s\S]*preventDefault[\s\S]*handleSurfaceDirection\(code, Date\.now\(\), 'keyup'\)/.test(packagedRunKeyUp)
      || /surfaceDirectionDownClaims|DIRECTION_KEYUP_CONSUMED/.test(packagedRunHud)
      || !/clearPendingSurfaceGlobalHook\(\)[\s\S]*DIRECTION_RELEASE_GUARD_MS[\s\S]*setBindingFocus[\s\S]*setSearchFocus/.test(packagedDirectionHandler)
      || !/HOST_FOCUS/.test(packagedHostFocus)
      || !/clearPendingSurfaceGlobalHook\(\)[\s\S]*HOST_BLUR/.test(packagedHostBlur)
      || /clearSurfaceDirectionBurst\(\)/.test(packagedHostBlur)
      || !/Enter[\s\S]*NumpadEnter[\s\S]*Space[\s\S]*GlobalHook/.test(packagedRunKeyUp)
    || packagedNativeSearchPrimary < 0
    || !/isSearchPhase\(\)\s*&&\s*this\.searchFocusIndex\s*===\s*0[\s\S]*?\)\s*return;/.test(
      packagedRunKeyUp.slice(packagedNativeSearchPrimary, packagedSearchFallback),
    )
    || /surfacePhase === 'binding'/.test(
      packagedRunKeyUp.slice(packagedNativeSearchPrimary, packagedSearchFallback),
    )
    || packagedSearchFallback <= packagedNativeSearchPrimary
    || packagedFallbackPreventDefault <= packagedSearchFallback
    || packagedFallbackActivation <= packagedFallbackPreventDefault
    || !/isSummaryPhase\s*\(\s*\)[\s\S]*preventDefault[\s\S]*closeAgentFromSummary/.test(packagedRunKeyUp)
    || !/Backspace/.test(packagedRunKeyUp)) {
  fail('AIX Run HUD must commit custom direction focus only on keyup, preserve host-focus churn safety, and keep the primary search button native for Enter/Space');
}
const packagedMultiTargetBody = stripJsComments(
  extractMethodBody(packagedRunHud, 'isMultiTargetSurface'),
);
const packagedActivateMultiTargetBody = stripJsComments(
  extractMethodBody(packagedRunHud, 'activateMultiTargetFocused'),
);
const packagedDeferGlobalHookStart = packagedRunHud.indexOf('  deferSurfaceGlobalHook(');
const packagedDeferGlobalHookEnd = packagedRunHud.indexOf(
  '  isTimedInputGuarded(', packagedDeferGlobalHookStart,
);
const packagedDeferGlobalHookBody = stripJsComments(
  packagedDeferGlobalHookStart >= 0
    && packagedDeferGlobalHookEnd > packagedDeferGlobalHookStart
    ? packagedRunHud.slice(packagedDeferGlobalHookStart, packagedDeferGlobalHookEnd) : '',
);
const packagedDirectionCancelIndex = packagedDirectionHandler.indexOf(
  'this.clearPendingSurfaceGlobalHook()',
);
const packagedDirectionDeltaIndex = packagedDirectionHandler.indexOf(
  "const delta = code === 'ArrowDown' || code === 'ArrowRight' ? 1 : -1;",
);
if (!/const DIRECTION_RELEASE_GUARD_MS = 600;/.test(packagedRunHud)
    || !/const DIRECTION_REPEAT_DEDUPE_MS = 220;/.test(packagedRunHud)
    || !/const DIRECTION_ALIAS_DEDUPE_MS = 600;/.test(packagedRunHud)
    || !/const MENU_FOCUS_COUNT = 5;/.test(packagedRunHud)
    || !/const TRAINING_FOCUS_COUNT = 5;/.test(packagedRunHud)
    || !/surfaceEntryConfirmGuardUntilMs = now \+ DIRECTION_RELEASE_GUARD_MS;/.test(packagedDirectionHandler)
    || packagedDirectionCancelIndex < 0
    || packagedDirectionDeltaIndex <= packagedDirectionCancelIndex
    || !/claimSurfaceDirection\(code, delta, now\)/.test(packagedDirectionHandler)
    || !/setMenuFocus\(this\.menuFocusIndex \+ delta\)/.test(packagedDirectionHandler)
    || !/setTrainingFocus\(this\.trainingFocusIndex \+ delta\)/.test(packagedDirectionHandler)
    || !/setSettingFocus\(this\.settingFocusIndex \+ delta\)/.test(packagedDirectionHandler)
    || !/setBindingFocus\(this\.bindingFocusIndex \+ delta\)/.test(packagedDirectionHandler)
    || !/setSearchFocus\(this\.searchFocusIndex \+ delta\)/.test(packagedDirectionHandler)
    || !/const count = this\.todayWorkoutPlan \? MENU_FOCUS_COUNT \+ 1 : MENU_FOCUS_COUNT;[\s\S]*raw % count/.test(packagedMenuFocus)
    || !/raw % SETTINGS_FOCUS_COUNT/.test(packagedSettingFocus)
    || !/lastSurfaceDirectionPhase === phase[\s\S]*lastSurfaceDirectionDelta === delta[\s\S]*DIRECTION_REPEAT_DEDUPE_MS[\s\S]*DIRECTION_ALIAS_DEDUPE_MS/.test(packagedDirectionClaim)
    || /lastSurfaceActivationId\s*===\s*actionId/.test(packagedRunHud)) {
  fail('AIX Run HUD must map all four direction keys to wrapped forward/back focus with a 600ms release guard');
}
if (!/const GLOBAL_HOOK_DISAMBIGUATE_MS = 600;/.test(packagedRunHud)
    || !/surfacePhase === 'menu'[\s\S]*surfacePhase === 'training'[\s\S]*surfacePhase === 'settings'[\s\S]*surfacePhase === 'binding'[\s\S]*isSearchPhase\(\)/.test(packagedMultiTargetBody)
    || !/\['free', 'slow', 'garmin_virtual', 'training', 'settings'\]/.test(packagedActivateMultiTargetBody)
    || !/isRecoveryChoicePhase\(\)[\s\S]*activateRecoveryCompletionFocused\(\)/.test(packagedActivateMultiTargetBody)
    || !/selected === 'slow'[\s\S]*openSlowMode\(\)/.test(packagedActivateMultiTargetBody)
    || !/selected === 'garmin_virtual'[\s\S]*openGarminVirtualMode\(\)/.test(packagedActivateMultiTargetBody)
    || !/selected === 'training'[\s\S]*openTrainingMode\(\)/.test(packagedActivateMultiTargetBody)
    || !/selected === 'settings'[\s\S]*openSettingsMode\(\)/.test(packagedActivateMultiTargetBody)
    || !/surfacePhase === 'training'[\s\S]*activateTrainingFocused\(\)/.test(packagedActivateMultiTargetBody)
    || !/onSettingTap\s*\(/.test(packagedActivateMultiTargetBody)
    || !/surfacePhase === 'binding'[\s\S]*bindingFocusIndex === 1[\s\S]*onBindingExportTap\(\)[\s\S]*onBindingActionTap\(\)/.test(packagedActivateMultiTargetBody)
    || !/activateSearchFocused\s*\(/.test(packagedActivateMultiTargetBody)
    || !/isMultiTargetSurface\(\)/.test(packagedDeferGlobalHookBody)
    || !/setTimeout\s*\(/.test(packagedDeferGlobalHookBody)
    || !/activateMultiTargetFocused\s*\(/.test(packagedDeferGlobalHookBody)
    || !/GLOBAL_HOOK_DISAMBIGUATE_MS/.test(packagedDeferGlobalHookBody)
    || !/code === 'GlobalHook'\s*&&\s*isMultiTarget[\s\S]*preventDefault[\s\S]*deferSurfaceGlobalHook\(Date\.now\(\)\)[\s\S]*return;/.test(packagedRunKeyUp)
    || !/isStableConfirm\s*&&\s*isMultiTarget\)\s*this\.clearPendingSurfaceGlobalHook\(\)/.test(packagedRunKeyUp)) {
  fail('AIX Run HUD must defer multi-target GlobalHook for 600ms and cancel it when a direction or stable confirm disambiguates the gesture');
}
if (!/surfacePhase\s*===\s*'binding'[\s\S]*preventDefault[\s\S]*showSettingsFromBinding/.test(packagedRunKeyUp)) {
  fail('AIX Agent Binding Backspace must return to Settings without leaving the immersive route');
}
if (!packagedRunOnHide.includes('this.pageVisible = false;')
    || !packagedRunOnHide.includes('this.bleLifecycleGeneration = (this.bleLifecycleGeneration || 0) + 1;')) {
  fail('AIX Run HUD must invalidate delayed BLE work when hidden');
}
const resetIndex = packagedRunHud.indexOf('this.lastHrAtMs = null;');
const listenIndex = packagedRunHud.indexOf("characteristic.addEventListener('characteristicvaluechanged'");
if (resetIndex < 0 || listenIndex < 0 || resetIndex > listenIndex) {
  fail('AIX Run HUD must reset the heart-rate timestamp before notifications can deliver a first packet');
}

const packagedDevices = new TextDecoder().decode(reader.read_file('lib/devices.js'));
for (const requiredToken of ['if (!pref.deviceId) return false;', 'pref.deviceId === id']) {
  if (!packagedDevices.includes(requiredToken)) {
    fail(`AIX device identity matching is not strict: ${requiredToken}`);
  }
}
if (/pref\.deviceName\s*===|===\s*pref\.deviceName/.test(packagedDevices)) {
  fail('AIX must never use a device name as automatic connection identity');
}

let packagedPackageJson;
try {
  packagedPackageJson = JSON.parse(new TextDecoder().decode(reader.read_file('package.json')));
} catch (error) {
  fail(`Unable to parse package.json inside the AIX package: ${error.message}`);
}
let repoPackageJson;
try {
  repoPackageJson = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
} catch (error) {
  fail(`Unable to parse repository package.json: ${error.message}`);
}
const packagedProductVersion = String(packagedPackageJson.version || '').trim();
if (!/^\d+\.\d+\.\d+$/.test(packagedProductVersion)
    || packagedProductVersion !== String(repoPackageJson.version || '').trim()) {
  fail(`AIX product version mismatch: package has "${packagedProductVersion}", repository has "${repoPackageJson.version || ''}"`);
}
if (!packagedHomeText.includes(`homeVersion: 'v${packagedProductVersion}'`)
    || !/class="home-version">\{\{\s*homeVersion\s*\}\}<\/text>/.test(packagedHomeText)
    || !/\bfont-size:\s*12px;/.test(extractRule(packagedHomeText, '.home-version'))
    || !/\bwidth:\s*64px;/.test(extractRule(packagedHomeText, '.home-version'))
    || !/\bwidth:\s*64px;/.test(extractRule(packagedHomeText, '.home-version-spacer'))
    || /\b(?:position|transform)\s*:/.test(extractRule(packagedHomeText, '.home-version'))
    || /\b(?:position|transform)\s*:/.test(extractRule(packagedHomeText, '.home-version-spacer'))) {
  fail(`AIX Home visible version must match product version v${packagedProductVersion}`);
}
const packagedDescription = String(packagedPackageJson.description || '').trim();
const packagedDescriptionWords = packagedDescription.split(/\s+/).filter(Boolean);
if (!packagedDescription
    || (packagedProvenance.locale !== AIX_LOCALES.ja
      && /[\u3400-\u9fff]/.test(packagedDescription))) {
  fail('AIX Description must be functional and localized');
}
if (packagedDescriptionWords.length > 200 || Buffer.byteLength(packagedDescription, 'utf8') > 200) {
  fail('AIX Description must stay within 200 words and 200 bytes');
}
const packagedAgents = new TextDecoder().decode(reader.read_file('AGENTS.md'));
const identityNameMatch = packagedAgents.match(/- \*\*Name\*\*:\s*([^\n]+)/);
if (!identityNameMatch || identityNameMatch[1].trim() !== expectedPackageTitle) {
  fail(`AIX localized Identity Name mismatch: expected "${expectedPackageTitle}"`);
}
const permissionSection = packagedAgents.match(/- \*\*Permissions\*\*:\s*\n((?:\s+-[^\n]+\n?)+)/);
if (!permissionSection) fail('AIX AGENTS.md is missing the Permissions list');
const packagedPermissions = [];
for (const line of permissionSection[1].trim().split(/\r?\n/)) {
  const match = line.match(/^\s*-\s+([a-z][a-z0-9_-]*)\s*$/);
  if (!match) fail(`AIX permission entries must be bare tokens: ${line.trim()}`);
  packagedPermissions.push(match[1]);
}
if (JSON.stringify(packagedPermissions) !== JSON.stringify(REQUIRED_PERMISSIONS)) {
  fail(`AIX permissions must be exactly: ${REQUIRED_PERMISSIONS.join(', ')}`);
}
const identityVersionMatch = packagedAgents.match(/- \*\*Version\*\*:\s*(\d+\.\d+\.\d+)/);
if (!identityVersionMatch || identityVersionMatch[1] !== packagedProductVersion) {
  fail('AIX product semver mismatch between package.json and AGENTS.md');
}
const storeDescriptionMatch = packagedAgents.match(/## (?:平台描述 \/ )?Store Description\s+([^\n]+)/);
const identityDescriptionMatch = packagedAgents.match(/- \*\*Description\*\*: ([^\n]+)/);
if (!storeDescriptionMatch || storeDescriptionMatch[1].trim() !== packagedDescription
    || !identityDescriptionMatch || identityDescriptionMatch[1].trim() !== packagedDescription) {
  fail('AIX Description mismatch between package.json and AGENTS.md');
}

let packagedAppJson;
try {
  packagedAppJson = JSON.parse(new TextDecoder().decode(reader.read_file('app.json')));
} catch (error) {
  fail(`Unable to parse app.json inside the AIX package: ${error.message}`);
}
if (!packagedAppJson.window
    || packagedAppJson.window.navigationBarTitleText !== expectedPackageTitle) {
  fail(`AIX localized app title mismatch: expected "${expectedPackageTitle}"`);
}
if (packagedAppJson.engine !== AIUI_ENGINE_RANGE) {
  fail(`AIX app.json engine must be exactly: ${AIUI_ENGINE_RANGE}`);
}
let repoAppJson;
try {
  repoAppJson = JSON.parse(await fs.readFile(path.join(ROOT, 'app.json'), 'utf8'));
} catch (error) {
  fail(`Unable to parse repository app.json: ${error.message}`);
}
const packagedPages = JSON.stringify(packagedAppJson.pages || []);
const repoPages = JSON.stringify(repoAppJson.pages || []);
if (packagedPages !== repoPages) {
  fail(`AIX app.json pages mismatch: package has ${packagedPages}, repository has ${repoPages}`);
}
const packagedAppPermissions = JSON.stringify(packagedAppJson.permissions || []);
const repoAppPermissions = JSON.stringify(repoAppJson.permissions || []);
const requiredAppPermissions = JSON.stringify(REQUIRED_APP_PERMISSIONS);
if (packagedAppPermissions !== requiredAppPermissions) {
  fail(`AIX app.json permissions must be exactly: ${REQUIRED_APP_PERMISSIONS.join(', ')}`);
}
if (repoAppPermissions !== requiredAppPermissions
    || packagedAppPermissions !== repoAppPermissions) {
  fail(`AIX app.json permissions mismatch: package has ${packagedAppPermissions}, repository has ${repoAppPermissions}`);
}
if (repoAppJson.engine !== AIUI_ENGINE_RANGE
    || packagedAppJson.engine !== repoAppJson.engine) {
  fail(`AIX app.json engine mismatch: package has ${packagedAppJson.engine}, repository has ${repoAppJson.engine}`);
}

const expectedPageSizes = new Map([
  ['pages/index/index', [448, 150]],
  ['pages/run_hud/index', [480, 352]],
]);
if (JSON.stringify(pages.map((page) => page.name)) !== packagedPages) {
  fail(`AIX reader page order mismatch: ${JSON.stringify(pages.map((page) => page.name))}`);
}
for (const page of pages) {
  const expected = expectedPageSizes.get(page.name);
  if (!expected || page.size.width !== expected[0] || page.size.height !== expected[1]) {
    fail(`AIX reader page layout mismatch: ${page.name} is ${page.size.width}x${page.size.height}`);
  }
}

// @yodaos-pkg/aix 0.7.0 exposes a reader entry for every route. Target is
// derived from app.json order: the first parameterless route opens `_blank`,
// while every later route opens `_current`. Missing schema warnings are
// intentional for these title-only routes; both still preserve their size.
if (JSON.stringify(tools.map((tool) => tool.function.name)) !== packagedPages) {
  fail(`AIX reader tool order mismatch: ${JSON.stringify(tools.map((tool) => tool.function.name))}`);
}
const expectedToolTargets = new Map([
  ['pages/run_hud/index', '_blank'],
  ['pages/index/index', '_current'],
]);
for (const tool of tools) {
  const expected = expectedPageSizes.get(tool.function.name);
  const expectedTarget = expectedToolTargets.get(tool.function.name);
  if (tool.target !== expectedTarget || !expected
      || tool.layout.width !== expected[0] || tool.layout.height !== expected[1]) {
    fail(`AIX reader tool layout mismatch: ${tool.function.name} target=${tool.target} `
      + `layout=${tool.layout.width}x${tool.layout.height}`);
  }
}
const homeTool = tools.find((tool) => tool.function.name === 'pages/index/index');
if (!homeTool || Object.keys(homeTool.function.parameters || {}).length !== 0) {
  fail('AIX title-only Home fallback reader entry must have no parameters');
}
const runEntry = tools.find((tool) => tool.function.name === 'pages/run_hud/index');
if (!runEntry || Object.keys(runEntry.function.parameters || {}).length !== 0) {
  fail('AIX default title-only Run HUD reader entry must have no parameters');
}

const packagedVersion = readerVersion;
if (!AIX_UUID_V4_RE.test(packagedVersion)) {
  fail(`AIX VERSION must be a UUID v4, got "${packagedVersion}"`);
}

const counterpartNames = {
  [CN_RELEASE_NAME]: EN_RELEASE_NAME,
  [EN_RELEASE_NAME]: CN_RELEASE_NAME,
  [JA_RELEASE_NAME]: CN_RELEASE_NAME,
};
const counterpartName = counterpartNames[path.basename(TARGET)];
if (counterpartName) {
  const counterpartPath = path.join(path.dirname(TARGET), counterpartName);
  try {
    const counterpartReader = new AixReaderWasm(new Uint8Array(await fs.readFile(counterpartPath)));
    const counterpartVersion = (counterpartReader.get_version() || '').trim();
    if (counterpartVersion === packagedVersion) {
      fail(`CN and EN AIX packages must have distinct UUIDs: ${packagedVersion}`);
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

console.log(`AIX OK: ${path.relative(ROOT, TARGET)}`);
console.log(`title: ${reader.get_title() || '(none)'}`);
console.log(`product version: ${packagedProductVersion}`);
console.log(`AIX UUID: ${packagedVersion}`);
console.log(`AIUI target: ${AIUI_TARGET_VERSION} (engine ${packagedAixManifest.engine})`);
console.log(`locale: ${packagedProvenance.locale}`);
console.log(`transform: ${packagedProvenance.transformVersion}`);
console.log(`release source SHA-256: ${packagedProvenance.sourceTreeSha256}`);
console.log(`payload tree SHA-256: ${packagedProvenance.payloadTreeSha256}`);
console.log(`upload size: ${(await fs.stat(TARGET)).size} bytes`);
console.log(`Craft content: ${inspectedSizeBudget.contentBytes} bytes`);
console.log(`estimated Craft final: ${inspectedSizeBudget.estimatedPlatformBytes} bytes (${inspectedSizeBudget.headroomBytes} bytes headroom)`);
console.log(`entries: ${entries.length}`);
console.log(`pages: ${pages.map((page) => page.name).join(', ')}`);
console.log(`reader tools: ${tools.length} (default immersive _blank, 448x150 fallback _current)`);
