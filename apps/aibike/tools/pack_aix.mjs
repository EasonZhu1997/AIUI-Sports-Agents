import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeAixVersion } from './bump_version.mjs';
import { findRuntimeLibFiles, findUnusedLibFiles } from './pack_excludes.mjs';
import { assertAixPlatformFootprint, measureAixContentBytes } from './aix_size_budget.mjs';
import {
  AIX_PROVENANCE_FILE,
  AIX_LOCALES,
  AIX_RELEASE_SOURCE_ENTRIES,
  computeReleaseSourceTreeSha256,
  writeAixProvenance,
} from './aix_provenance.mjs';
import {
  localizeEnglishStage,
  localizeJapaneseStage,
  outputArgument,
  resolveAixVariant,
} from './aix_locales.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PRODUCT_VERSION = String(packageJson.version || '').trim();
const PRODUCT_VERSION_RE = /^\d+\.\d+\.\d+$/;
const VARIANT = resolveAixVariant(process.argv.slice(2));
const DEFAULT_OUT_NAME = `AIBike-AIUI-v${PRODUCT_VERSION}-${VARIANT.suffix}.aix`;
const OUT = path.resolve(
  ROOT,
  outputArgument(process.argv.slice(2)) || `release/${DEFAULT_OUT_NAME}`,
);
const STAGE = path.join(
  os.tmpdir(),
  `.AIBike-${VARIANT.suffix}-${process.pid}.src.tmp`,
);
const TMP = path.join(
  path.dirname(OUT),
  `.${path.basename(OUT)}.${process.pid}.tmp`,
);

const PAGE_FILES = [
  'pages/index/index.ink',
  'pages/ride_hud/index.ink',
];
const SOURCE_ENTRIES = [...AIX_RELEASE_SOURCE_ENTRIES];
const PACKAGE_ENTRIES = [...SOURCE_ENTRIES, AIX_PROVENANCE_FILE];
const REQUIRED_PERMISSIONS = [
  'bluetooth',
  'accelerometer',
  'gyroscope',
  'audio',
];
const REQUIRED_APP_PERMISSIONS = [];

function fail(message) {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.rmSync(TMP, { force: true });
  console.error(message);
  process.exit(1);
}

function prepareStage(excludedFiles) {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  for (const entry of SOURCE_ENTRIES) {
    const source = path.join(ROOT, entry);
    const target = path.join(STAGE, entry);
    if (!fs.existsSync(source)) fail(`Missing package entry: ${entry}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }
  for (const excluded of excludedFiles) {
    fs.rmSync(path.join(STAGE, excluded), { force: true });
  }
  // The 186ms source click is build input only. Runtime uses the three
  // generated four-beat bars, so shipping the source wastes Craft headroom.
  fs.rmSync(path.join(STAGE, 'assets/audio/metro_0468.wav'), { force: true });
}

function readInkDef(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const match = text.match(/<script[^>]*\bdef\b[^>]*>\s*([\s\S]*?)\s*<\/script>/);
  if (!match) fail(`${rel} is missing <script def>`);
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    fail(`${rel} has invalid <script def>: ${error.message}`);
  }
}

function readManifestPermissions(text) {
  const section = text.match(/- \*\*Permissions\*\*:\s*\n((?:\s+-[^\n]+\n?)+)/);
  if (!section) fail('AGENTS.md is missing the Permissions list');
  return section[1].trim().split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*-\s+([a-z][a-z0-9_-]*)\s*$/);
    if (!match) fail(`AGENTS.md permission entries must be bare tokens: ${line.trim()}`);
    return match[1];
  });
}

if (packageJson.name !== 'AIBike' || !PRODUCT_VERSION_RE.test(PRODUCT_VERSION)) {
  fail('package.json must identify AIBike with a semantic product version');
}
if (!Object.values(AIX_LOCALES).includes(VARIANT.locale)) {
  fail(`Unsupported AIX locale: ${VARIANT.locale}`);
}
const storeDescription = String(packageJson.description || '').trim();
if (!storeDescription || /[\u3400-\u9fff]/.test(storeDescription)
    || Buffer.byteLength(storeDescription, 'utf8') > 200) {
  fail('package.json Description must be functional English within 200 bytes');
}

const agentManifest = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
if (!agentManifest.includes(storeDescription)
    || !agentManifest.includes('- **Name**: AIBike')
    || !agentManifest.includes(`- **Version**: ${PRODUCT_VERSION}`)) {
  fail('AGENTS.md identity and package.json metadata must stay in sync');
}
if (JSON.stringify(readManifestPermissions(agentManifest)) !== JSON.stringify(REQUIRED_PERMISSIONS)) {
  fail(`AGENTS.md permissions must be exactly: ${REQUIRED_PERMISSIONS.join(', ')}`);
}

const appManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
if (JSON.stringify(appManifest.pages) !== JSON.stringify([
  'pages/index/index',
  'pages/ride_hud/index',
])) {
  fail('app.json must register index then ride_hud');
}
if (JSON.stringify(appManifest.permissions) !== JSON.stringify(REQUIRED_APP_PERMISSIONS)) {
  fail(`app.json permissions must be exactly: ${REQUIRED_APP_PERMISSIONS.join(', ')}`);
}
if (appManifest.window?.navigationBarTitleText !== 'AIBike') {
  fail('app.json navigation title must be AIBike');
}

for (const entry of SOURCE_ENTRIES) {
  if (!fs.existsSync(path.join(ROOT, entry))) fail(`Missing package entry: ${entry}`);
}
for (const page of PAGE_FILES) {
  if (!fs.existsSync(path.join(ROOT, page))) fail(`Missing page: ${page}`);
}
const homeDef = readInkDef('pages/index/index.ink');
if (!homeDef.description || homeDef.schema?.data?.type !== 'object') {
  fail('pages/index/index.ink must remain the callable 448x150 page tool');
}
const rideDef = readInkDef('pages/ride_hud/index.ink');
if (rideDef.navigationBarTitleText !== 'AIBike AI 骑行'
    || 'description' in rideDef || 'schema' in rideDef) {
  fail('pages/ride_hud/index.ink must remain a title-only immersive route');
}
const runtimeLibs = findRuntimeLibFiles(ROOT, PAGE_FILES);
for (const required of [
  'lib/cycling.js',
  'lib/ftms.js',
  'lib/cycling_metrics.js',
  'lib/cycling_imu.js',
  'lib/cycling_imu_speed.js',
  'lib/aiui_world_awareness.js',
  'lib/ride_coach.js',
  'lib/ride_history.js',
  'lib/ride_source_health.js',
  'lib/ride_ai_advice.js',
  'lib/ride_warmup.js',
  'lib/network_policy.js',
  'lib/sports_identity.js',
  'lib/sports_workout.js',
  'lib/sports_workout_executor.js',
  'lib/sports_coach.js',
  'lib/sports_outbox.js',
  'lib/sport_agent.js',
]) {
  if (!runtimeLibs.includes(required)) {
    fail(`Riding runtime must import ${required}`);
  }
}
const excludedLibFiles = findUnusedLibFiles(ROOT, PAGE_FILES);
const excludedPackageFiles = [
  ...excludedLibFiles,
  'assets/audio/metro_0468.wav',
];

const zipCheck = spawnSync('zip', ['-v'], { cwd: ROOT, stdio: 'ignore' });
if (zipCheck.error || zipCheck.status !== 0) {
  fail('Missing Info-ZIP zip command');
}

// All non-mutating gates pass before a locale-specific staging tree is made.
// VERSION is excluded from both tree hashes because each artifact receives an
// independent UUID inside its own staging tree.
let sourceTreeSha256;
try {
  sourceTreeSha256 = computeReleaseSourceTreeSha256(ROOT, {
    excludedPaths: excludedPackageFiles,
  });
} catch (error) {
  fail(`Unable to hash the AIX release source: ${error.message}`);
}
let payloadTreeSha256;
try {
  prepareStage(excludedPackageFiles);
  writeAixVersion(STAGE);
  if (VARIANT.key === 'ja') localizeJapaneseStage(STAGE);
  else if (VARIANT.key === 'en') localizeEnglishStage(STAGE);
  payloadTreeSha256 = computeReleaseSourceTreeSha256(STAGE);
  writeAixProvenance(STAGE, {
    locale: VARIANT.locale,
    sourceTreeSha256,
    payloadTreeSha256,
  });
} catch (error) {
  fail(`Unable to stage AIX provenance: ${error.message}`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.rmSync(TMP, { force: true });

const zipArgs = ['-q', '-9', '-X', '-r', TMP, ...PACKAGE_ENTRIES];
const result = spawnSync('zip', zipArgs, { cwd: STAGE, stdio: 'inherit' });
if (result.error) fail(result.error.message);
if (result.status !== 0) fail(`zip failed with exit code ${result.status}`);

let sizeBudget;
try {
  const contentBytes = measureAixContentBytes(STAGE, PACKAGE_ENTRIES);
  sizeBudget = assertAixPlatformFootprint(contentBytes, path.basename(OUT));
} catch (error) {
  fail(error.message);
}

fs.renameSync(TMP, OUT);
fs.chmodSync(OUT, 0o664);
fs.rmSync(STAGE, { recursive: true, force: true });
console.log(
  `Packed ${path.relative(ROOT, OUT)} (upload ${fs.statSync(OUT).size} bytes; `
  + `Craft content ${sizeBudget.contentBytes} bytes; estimated final `
  + `${sizeBudget.estimatedPlatformBytes} bytes; runtime libs ${runtimeLibs.length}; `
  + `locale ${VARIANT.locale}; `
  + `source ${sourceTreeSha256}; payload ${payloadTreeSha256})`,
);
if (sizeBudget.warning) {
  console.warn('Warning: estimated Craft package is at or above 1800000 bytes');
}
