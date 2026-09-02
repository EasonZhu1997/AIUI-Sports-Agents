import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRuntimeLibFiles } from '../tools/pack_excludes.mjs';
import {
  AIX_LOCALE,
  AIX_LOCALES,
  AIX_PROVENANCE_FILE,
  AIX_PROVENANCE_SCHEMA_VERSION,
  AIX_TRANSFORM_VERSION,
  AIX_TRANSFORM_VERSIONS,
} from '../tools/aix_provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_FILES = ['pages/index/index.ink', 'pages/ride_hud/index.ink'];
const REQUIRED_PERMISSIONS = [
  'bluetooth',
  'accelerometer',
  'gyroscope',
  'audio',
];
const OLD_PRODUCT_RE = /\bAISmartRun\b|pages\/run_hud|跑步|步频|配速/;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readDef(rel) {
  const match = read(rel).match(/<script[^>]*\bdef\b[^>]*>\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(match, `${rel} must contain script def metadata`);
  return JSON.parse(match[1]);
}

function cssBlock(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing CSS selector ${selector}`);
  return match[1];
}

function exactCanvas(rel, selector, width, height) {
  const block = cssBlock(read(rel), selector);
  assert.match(block, new RegExp(`\\bwidth:\\s*${width}px\\s*;`));
  assert.match(block, new RegExp(`\\bheight:\\s*${height}px\\s*;`));
  assert.match(block, /\bbox-sizing:\s*border-box\s*;/);
}

function manifestPermissions(text) {
  const section = text.match(/- \*\*Permissions\*\*:\s*\n((?:\s+-[^\n]+\n?)+)/);
  assert.ok(section, 'AGENTS.md must declare permissions');
  return section[1].trim().split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*-\s+([a-z][a-z0-9_-]*)\s*$/);
    assert.ok(match, `permission must be a bare token: ${line}`);
    return match[1];
  });
}

test('AIBike metadata is synchronized at version 0.3.80', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const agents = read('AGENTS.md');
  assert.equal(pkg.name, 'AIBike');
  assert.equal(pkg.version, '0.3.80');
  assert.equal(lock.name, 'AIBike');
  assert.equal(lock.version, '0.3.80');
  assert.equal(lock.packages[''].version, '0.3.80');
  assert.match(pkg.description, /^AIBike is a cycling HUD/);
  assert.equal(pkg.license, 'PolyForm-Noncommercial-1.0.0');
  assert.deepEqual(pkg.repository, {
    type: 'git',
    url: 'https://github.com/EasonZhu1997/AIUI-Sports-Agents.git',
    directory: 'apps/aibike',
  });
  assert.match(agents, /- \*\*Name\*\*: AIBike/);
  assert.match(agents, /- \*\*Version\*\*: 0\.3\.80/);
  assert.ok(agents.includes(pkg.description));
  assert.deepEqual(manifestPermissions(agents), REQUIRED_PERMISSIONS);
  assert.equal(pkg.devDependencies['@yodaos-pkg/aix'], '^0.7.0');
  assert.equal(pkg.devDependencies['@yodaos-pkg/ink'], '0.16.1');
  assert.equal(lock.packages['node_modules/@yodaos-pkg/ink'].version, '0.16.1');
  assert.match(
    lock.packages['node_modules/@yodaos-pkg/ink'].integrity,
    /^sha512-/,
  );
});

test('public metadata documents the offline, source-available and hardware boundaries', () => {
  const releaseCopy = [read('AGENTS.md'), read('README.md')].join('\n');
  assert.match(releaseCopy, /fully offline|default offline policy/i);
  assert.match(releaseCopy, /PolyForm Noncommercial/i);
  assert.match(releaseCopy, /Garmin heart-rate broadcasting can validate HRS only/i);
  assert.match(releaseCopy, /real-device/i);
  assert.match(releaseCopy, /not compatibility proof/i);
  for (const excluded of ['preview/', 'release/', 'tmp/']) {
    assert.equal(fs.existsSync(path.join(ROOT, excluded)), false);
  }
});

test('AIX provenance metadata is versioned for Chinese, Japanese and English artifacts', () => {
  assert.equal(AIX_PROVENANCE_FILE, 'AIX_PROVENANCE.json');
  assert.equal(AIX_PROVENANCE_SCHEMA_VERSION, 1);
  assert.equal(AIX_LOCALE, 'zh-CN');
  assert.equal(AIX_TRANSFORM_VERSION, 'cn-identity-v1');
  assert.deepEqual(AIX_LOCALES, { cn: 'zh-CN', ja: 'ja-JP', en: 'en-US' });
  assert.equal(AIX_TRANSFORM_VERSIONS['ja-JP'], 'ja-localization-v1');
  assert.equal(AIX_TRANSFORM_VERSIONS['en-US'], 'en-localization-v1');
  assert.match(read('tools/aix_provenance.mjs'), /AIX_LOCALES/);
});

test('the app exposes one callable home and one title-only immersive ride route', () => {
  const app = JSON.parse(read('app.json'));
  assert.deepEqual(app.pages, ['pages/index/index', 'pages/ride_hud/index']);
  assert.deepEqual(app.permissions, []);
  assert.equal(app.window.navigationBarTitleText, 'AIBike');

  const pageDirs = fs.readdirSync(path.join(ROOT, 'pages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(pageDirs, ['index', 'ride_hud']);

  const home = readDef(PAGE_FILES[0]);
  const ride = readDef(PAGE_FILES[1]);
  assert.equal(home.navigationBarTitleText, 'AIBike');
  assert.match(home.description, /AIBike.*cycling/i);
  assert.deepEqual(home.schema, { data: { type: 'object', properties: {} } });
  assert.equal(ride.navigationBarTitleText, 'AIBike AI 骑行');
  assert.equal(Object.hasOwn(ride, 'description'), false);
  assert.equal(Object.hasOwn(ride, 'schema'), false);
});

test('home and ride canvases preserve the 448x150 and 480x352 AIUI contracts', () => {
  exactCanvas(PAGE_FILES[0], '.home-card', 448, 150);
  exactCanvas(PAGE_FILES[1], '.immersive-root', 480, 352);
  exactCanvas(PAGE_FILES[1], '.hud-wrap', 480, 352);
});

test('home opens ride_hud and the packaged pages contain cycling vocabulary only', () => {
  const home = read(PAGE_FILES[0]);
  const ride = read(PAGE_FILES[1]);
  assert.match(home, /wx\.navigateTo\s*\(/);
  assert.match(home, /\/pages\/ride_hud\/index/);
  for (const term of ['AI 骑行', '速度', '踏频', '距离', '时长']) {
    assert.ok(ride.includes(term), `ride_hud must include ${term}`);
  }
  for (const [rel, source] of [
    ['AGENTS.md', read('AGENTS.md')],
    ['assets/audio/NOTICE.md', read('assets/audio/NOTICE.md')],
    ['README.md', read('README.md')],
    ['package.json', read('package.json')],
    ['app.json', read('app.json')],
    [PAGE_FILES[0], home],
    [PAGE_FILES[1], ride],
    ...findRuntimeLibFiles(ROOT, PAGE_FILES).map((rel) => [rel, read(rel)]),
  ]) {
    assert.doesNotMatch(source, OLD_PRODUCT_RE, `${rel} still contains obsolete running copy`);
  }
});

test('ride_hud imports the cycling data path and omits public ID pairing UI', () => {
  const ride = read(PAGE_FILES[1]);
  for (const moduleName of [
    'cycling_metrics.js',
    'cycling_imu.js',
    'cycling_motion_quality.js',
    'cycling_local_field_log.js',
    'aiui_world_awareness.js',
  ]) {
    assert.match(ride, new RegExp(`\\.\\./\\.\\./lib/${moduleName.replace('.', '\\.')}`));
  }
  const runtimeLibs = findRuntimeLibFiles(ROOT, PAGE_FILES);
  for (const modulePath of [
    'lib/cycling.js',
    'lib/ftms.js',
    'lib/cycling_metrics.js',
    'lib/cycling_imu.js',
    'lib/cycling_motion_quality.js',
    'lib/cycling_local_field_log.js',
    'lib/aiui_world_awareness.js',
    'lib/ride_warmup.js',
  ]) {
    assert.ok(runtimeLibs.includes(modulePath), `runtime closure must include ${modulePath}`);
  }
  for (const removedModule of [
    'lib/geolocation.js',
    'lib/gps_path.js',
    'lib/weather.js',
    'lib/cycling_rollout_model.js',
  ]) {
    assert.equal(runtimeLibs.includes(removedModule), false);
  }
  assert.doesNotMatch(ride, /navigator\.geolocation|wx\.getLocation|天气/);
  assert.doesNotMatch(
    ride,
    /device_identity|AIUI ID|APK\s*绑定|pair(?:ing)?[-_ ]?code|surfacePhase:\s*['"]binding['"]/i,
  );
});
