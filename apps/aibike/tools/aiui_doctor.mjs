import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findRuntimeLibFiles, findUnusedLibFiles } from './pack_excludes.mjs';
import { AIX_RELEASE_SOURCE_ENTRIES } from './aix_provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_FILES = ['pages/index/index.ink', 'pages/ride_hud/index.ink'];
const REQUIRED_FILES = [
  '.aixignore', '.gitignore', 'AGENTS.md', 'README.md', 'LICENSE', 'COPYRIGHT',
  'COMMERCIAL_LICENSE.md', 'TRADEMARKS.md', 'SECURITY.md', 'PRIVACY.md',
  'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md', 'VERSION', 'app.js', 'app.json',
  'package.json', 'package-lock.json',
  'assets/audio/NOTICE.md', 'assets/audio/metro_0468.wav',
  'assets/audio/metro_0468_bar_80.wav',
  'assets/audio/metro_0468_bar_90.wav',
  'assets/audio/metro_0468_bar_100.wav',
  ...PAGE_FILES,
  'lib/network_policy.js', 'lib/cycling.js', 'lib/ftms.js', 'lib/hr.js',
  'lib/cycling_metrics.js', 'lib/cycling_imu.js', 'lib/cycling_imu_speed.js',
  'lib/cycling_motion_quality.js', 'lib/aiui_world_awareness.js',
  'lib/ride_devices.js', 'lib/ride_warmup.js', 'lib/ride_summary.js',
  'tools/pack_aix.mjs', 'tools/inspect_aix.mjs', 'tools/aix_provenance.mjs',
  'scripts/run_tests.mjs',
];
const FORBIDDEN_PATHS = [
  '.git', '.agents', '.claude', 'tmp', 'preview', 'release', 'release-archive',
  'PROGRESS.md', 'OPEN_SOURCE_READINESS.md', 'DEVICES.md',
  'assets/aibike-cyclist-48.png', 'assets/warmup',
  'lib/cycling_rollout_model.js', 'lib/geolocation.js', 'lib/gps_path.js',
  'lib/weather.js', 'tools/mac_hr_probe.swift', 'tools/mac_hr_simulator.swift',
  'tools/esp32_hr_sim',
];
const REQUIRED_PERMISSIONS = ['bluetooth', 'accelerometer', 'gyroscope', 'audio'];
const PRODUCT_DESCRIPTION = 'AIBike is a cycling HUD for Rokid Glasses with verified sensor metrics, local summaries, and privacy-bounded field telemetry.';
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  try { return JSON.parse(read(rel)); } catch (_error) { return null; }
}

function manifestPermissions(text) {
  const section = text.match(/- \*\*Permissions\*\*:\s*\n((?:\s+-[^\n]+\n?)+)/);
  if (!section) return [];
  return section[1].trim().split(/\r?\n/).map(
    (line) => line.match(/^\s*-\s+([a-z][a-z0-9_-]*)\s*$/)?.[1] || '',
  );
}

function extractRule(text, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] || '';
}

function exactCanvas(text, selector, width, height) {
  const rule = extractRule(text, selector);
  return new RegExp(`\\bwidth:\\s*${width}px;`).test(rule)
    && new RegExp(`\\bheight:\\s*${height}px;`).test(rule);
}

function walkText(dir, rel = '', results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'test'].includes(entry.name) && !rel) {
      if (entry.name === 'node_modules') continue;
    }
    const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkText(abs, nextRel, results);
    else if (/\.(?:js|mjs|json|ink|md|txt)$/.test(entry.name)
        || ['LICENSE', 'COPYRIGHT', 'VERSION'].includes(entry.name)) {
      results.push([nextRel, fs.readFileSync(abs, 'utf8')]);
    }
  }
  return results;
}

function sha256(rel) {
  return createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
}

function check(label, ok, detail = '') {
  console.log(`${ok ? 'OK' : 'MISS'} ${label}${detail ? ` - ${detail}` : ''}`);
  return ok;
}

const pkg = readJson('package.json') || {};
const lock = readJson('package-lock.json') || {};
const app = readJson('app.json') || {};
const agents = read('AGENTS.md');
const home = read(PAGE_FILES[0]);
const ride = read(PAGE_FILES[1]);
const identity = read('lib/sports_identity.js');
const upload = read('lib/cycling_upload.js');
const policy = read('lib/network_policy.js');
const provenance = read('tools/aix_provenance.mjs');
const runtimeLibs = findRuntimeLibFiles(ROOT, PAGE_FILES);
const unusedLibs = findUnusedLibFiles(ROOT, PAGE_FILES);
const textFiles = walkText(ROOT);

const localPaths = textFiles.filter(([, text]) => /\/Users\/[^/]+\//.test(text));
const unverifiedVisualRefs = textFiles.filter(([file, text]) => (
  /^(?:pages|lib)\//.test(file)
  && /aibike-cyclist-48|assets\/warmup\/|\.gif\b/i.test(text)
));
const pageEmoji = PAGE_FILES.filter((rel) => EMOJI_PATTERN.test(read(rel)));
const zip = spawnSync('zip', ['-v'], { cwd: ROOT, stdio: 'ignore' });

const checks = [
  check('public source files', REQUIRED_FILES.every(exists),
    `${REQUIRED_FILES.filter((rel) => !exists(rel)).length} missing`),
  check('forbidden export paths absent', FORBIDDEN_PATHS.every((rel) => !exists(rel)),
    FORBIDDEN_PATHS.filter(exists).join(', ')),
  check('metadata and source-available license',
    pkg.name === 'AIBike' && pkg.version === '0.3.80'
      && pkg.description === PRODUCT_DESCRIPTION
      && pkg.license === 'PolyForm-Noncommercial-1.0.0'
      && lock.name === pkg.name && lock.version === pkg.version
      && lock.packages?.['']?.license === pkg.license
      && agents.includes('- **Author**: Yixiao Zhu'),
    `${pkg.name || 'missing'} ${pkg.version || 'missing'}`),
  check('PolyForm and required copyright notice',
    read('LICENSE').includes('# PolyForm Noncommercial License 1.0.0')
      && read('COPYRIGHT').includes('Required Notice: Copyright (c) 2026 Yixiao Zhu.')),
  check('minimal public permissions',
    JSON.stringify(app.permissions) === JSON.stringify([])
      && JSON.stringify(manifestPermissions(agents)) === JSON.stringify(REQUIRED_PERMISSIONS),
    REQUIRED_PERMISSIONS.join(', ')),
  check('AIUI routes and canvases',
    JSON.stringify(app.pages) === JSON.stringify(PAGE_FILES.map((rel) => rel.replace(/\.ink$/, '')))
      && exactCanvas(home, '.home-card', 448, 150)
      && exactCanvas(ride, '.immersive-root', 480, 352)
      && exactCanvas(ride, '.hud-wrap', 480, 352)),
  check('runtime dependency closure', unusedLibs.length === 0,
    `${runtimeLibs.length} runtime libs; unused ${unusedLibs.join(', ') || 'none'}`),
  check('offline network policy',
    identity.includes("SPORTS_HERMES_BASE_URL = ''")
      && upload.includes("CYCLING_UPLOAD_DEFAULT_BASE_URL = ''")
      && policy.includes('source.networkSyncEnabled === true')
      && policy.includes("const HTTPS_PREFIX = 'https://'")
      && ride.includes('authorizeNetworkRequest(')
      && ride.includes("errMsg: 'offline policy'")),
  check('BLE production logging is bounded',
    ride.includes("return 'connection_failed'")
      && ride.includes("return 'unknown'")
      && !ride.includes("id=' + String(deviceId")
      && !/bleErrorText\([^)]*\)[\s\S]{0,180}slice\(0,\s*120\)/.test(ride)
      && !ride.includes('raw packet')),
  check('programmatic visual placeholders',
    home.includes('<text class="bike-logo-text">AB</text>')
      && ride.includes('<text class="bike-logo-text">AB</text>')
      && ride.includes('跟随文字动作')
      && unverifiedVisualRefs.length === 0,
    unverifiedVisualRefs.map(([file]) => file).join(', ')),
  check('no local workstation paths', localPaths.length === 0,
    localPaths.map(([file]) => file).join(', ')),
  check('no emoji in runtime pages', pageEmoji.length === 0, pageEmoji.join(', ')),
  check('AIX legal files are provenance inputs',
    ['LICENSE', 'COPYRIGHT', 'COMMERCIAL_LICENSE.md', 'TRADEMARKS.md']
      .every((rel) => AIX_RELEASE_SOURCE_ENTRIES.includes(rel))
      && provenance.includes("'LICENSE'") && provenance.includes("'COPYRIGHT'")),
  check('cadence audio hashes match notice',
    read('assets/audio/NOTICE.md').includes(sha256('assets/audio/metro_0468.wav'))
      && read('assets/audio/NOTICE.md').includes(sha256('assets/audio/metro_0468_bar_80.wav'))
      && read('assets/audio/NOTICE.md').includes(sha256('assets/audio/metro_0468_bar_90.wav'))
      && read('assets/audio/NOTICE.md').includes(sha256('assets/audio/metro_0468_bar_100.wav'))),
  check('AIX reader installed',
    exists('node_modules/@yodaos-pkg/aix/pkg/aix_web.js')
      && exists('node_modules/@yodaos-pkg/aix/pkg/aix_web_bg.wasm')),
  check('zip command', !zip.error && zip.status === 0),
];

console.log('');
console.log('AIBike public snapshot: offline by default; local build evidence only.');
console.log('Signing, upload, installation and real-device BLE validation remain external gates.');
if (checks.some((ok) => !ok)) process.exit(1);
