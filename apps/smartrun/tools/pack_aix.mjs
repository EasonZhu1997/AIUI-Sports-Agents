import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAixVersion } from './bump_version.mjs';
import { ORPHAN_LIB_FILES, findOrphanLibReferences } from './pack_excludes.mjs';
import { assertAixPlatformFootprint } from './aix_size_budget.mjs';
import {
  AIX_LOCALES,
  AIX_PROVENANCE_FILE,
  AIX_RELEASE_SOURCE_ENTRIES,
  AIUI_ENGINE_RANGE,
  computeReleaseSourceTreeSha256,
  writeAixProvenance,
} from './aix_provenance.mjs';
import { packReadableAix } from './official_aix_pack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PRODUCT_VERSION = String(packageJson.version || '').trim();
const DEFAULT_OUT_NAME = `AISmartRun-AIUI-v${PRODUCT_VERSION}-cn.aix`;
const OUT = path.resolve(ROOT, process.argv[2] || `release/${DEFAULT_OUT_NAME}`);
const STAGE = path.resolve(ROOT, 'release/.AISmartRun-cn.src.tmp');
const TMP = path.resolve(ROOT, `release/.${DEFAULT_OUT_NAME}.tmp`);
const REQUIRED_PERMISSIONS = [
  'bluetooth',
  'accelerometer',
  'gyroscope',
  'audio',
  'network',
];
const REQUIRED_APP_PERMISSIONS = [];

const SOURCE_ENTRIES = [...AIX_RELEASE_SOURCE_ENTRIES];
const PACKAGE_ENTRIES = [...SOURCE_ENTRIES, AIX_PROVENANCE_FILE];

function fail(message) {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.rmSync(TMP, { force: true });
  console.error(message);
  process.exit(1);
}

function prepareStage() {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  for (const entry of SOURCE_ENTRIES) {
    const src = path.join(ROOT, entry);
    const dst = path.join(STAGE, entry);
    if (!fs.existsSync(src)) fail(`Missing package entry: ${entry}`);
    fs.cpSync(src, dst, { recursive: true });
  }
  for (const orphan of ORPHAN_LIB_FILES) {
    fs.rmSync(path.join(STAGE, orphan), { force: true });
  }
}

function readInkDef(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const match = text.match(/<script[^>]*\bdef\b[^>]*>\s*([\s\S]*?)\s*<\/script>/);
  if (!match) fail(`${rel} is missing <script def>`);
  try { return { def: JSON.parse(match[1]), text }; } catch (error) {
    fail(`${rel} has invalid <script def>: ${error.message}`);
  }
}

function assertExactPermissions(text, label) {
  const section = text.match(/- \*\*Permissions\*\*:\s*\n((?:\s+-[^\n]+\n?)+)/);
  if (!section) fail(`${label} is missing the Permissions list`);
  const lines = section[1].trim().split(/\r?\n/);
  const permissions = [];
  for (const line of lines) {
    const match = line.match(/^\s*-\s+([a-z][a-z0-9_-]*)\s*$/);
    if (!match) fail(`${label} permission entries must be bare tokens: ${line.trim()}`);
    permissions.push(match[1]);
  }
  if (JSON.stringify(permissions) !== JSON.stringify(REQUIRED_PERMISSIONS)) {
    fail(`${label} permissions must be exactly: ${REQUIRED_PERMISSIONS.join(', ')}`);
  }
}

function assertExactAppPermissions(app, label) {
  const permissions = app && app.permissions;
  if (JSON.stringify(permissions) !== JSON.stringify(REQUIRED_APP_PERMISSIONS)) {
    fail(`${label} permissions must be exactly: ${REQUIRED_APP_PERMISSIONS.join(', ')}`);
  }
  if (app.engine !== AIUI_ENGINE_RANGE) {
    fail(`${label} engine must be exactly: ${AIUI_ENGINE_RANGE}`);
  }
}

// Product semver lives in package.json / AGENTS.md / the PRDs. VERSION is the
// AIX package identity and is regenerated as a UUID v4 for every CN artifact.

// Release metadata gate: every package must carry a concise English functional
// Description. Keep the platform's stricter 200-byte limit in addition to the
// product requirement of no more than 200 words.
const storeDescription = String(packageJson.description || '').trim();
const descriptionWords = storeDescription.split(/\s+/).filter(Boolean);
if (!storeDescription || /[\u3400-\u9fff]/.test(storeDescription)) {
  fail('package.json Description must be functional English');
}
if (descriptionWords.length > 200) {
  fail(`package.json Description exceeds 200 words: ${descriptionWords.length}`);
}
if (Buffer.byteLength(storeDescription, 'utf8') > 200) {
  fail(`package.json Description exceeds 200 bytes: ${Buffer.byteLength(storeDescription, 'utf8')}`);
}
const agentManifest = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
if (!agentManifest.includes(storeDescription)) {
  fail('AGENTS.md and package.json Description must stay in sync');
}
assertExactPermissions(agentManifest, 'AGENTS.md');
let appManifest;
try {
  appManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
} catch (error) {
  fail(`app.json is invalid: ${error.message}`);
}
assertExactAppPermissions(appManifest, 'app.json');
if (JSON.stringify(appManifest.pages || []) !== JSON.stringify([
  'pages/run_hud/index',
  'pages/index/index',
])) {
  fail('app.json must register the direct immersive route first and the 448x150 fallback second');
}

for (const entry of SOURCE_ENTRIES) {
  if (!fs.existsSync(path.join(ROOT, entry))) {
    fail(`Missing package entry: ${entry}`);
  }
}

const orphanReferences = findOrphanLibReferences(ROOT);
if (orphanReferences.length) {
  fail(`Excluded lib modules are referenced by shipped code; update ORPHAN_LIB_FILES first:\n${orphanReferences.join('\n')}`);
}

for (const rel of [
  'pages/run_hud/index.ink',
  'pages/index/index.ink',
]) {
  const { def } = readInkDef(rel);
  if (JSON.stringify(Object.keys(def)) !== JSON.stringify(['navigationBarTitleText'])) {
    fail(`${rel} must stay title-only; Reader target is derived from app.json order, not page schema`);
  }
}
for (const rel of [
  'pages/index/index.ink',
  'pages/run_hud/index.ink',
]) {
  const { text } = readInkDef(rel);
  if (/<style[^>]*>\s*\/\*/.test(text)) {
    fail(`${rel} has a leading style comment that breaks AIX layout discovery`);
  }
}

// Validate all non-mutating release gates first, then mint the package identity
// only when packaging can proceed. This never changes the product semver.
const buildId = writeAixVersion();
const sourceTreeSha256 = computeReleaseSourceTreeSha256(ROOT, {
  excludedPaths: ORPHAN_LIB_FILES,
});
prepareStage();
const payloadTreeSha256 = computeReleaseSourceTreeSha256(STAGE);
writeAixProvenance(STAGE, {
  locale: AIX_LOCALES.cn,
  sourceTreeSha256,
  payloadTreeSha256,
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
try {
  fs.rmSync(TMP, { force: true });
} catch {
  // Ignore stale temp cleanup failures; the next zip step will surface real errors.
}

let sizeBudget;
let packResult;
try {
  packResult = packReadableAix({
    root: STAGE,
    packageEntries: PACKAGE_ENTRIES,
    outputPath: TMP,
    buildId,
    engineRange: AIUI_ENGINE_RANGE,
    expectedPayloadTreeSha256: payloadTreeSha256,
  });
  sizeBudget = assertAixPlatformFootprint(packResult.contentBytes, path.basename(OUT));
} catch (error) {
  fs.rmSync(TMP, { force: true });
  fail(error.message);
}

fs.renameSync(TMP, OUT);
fs.chmodSync(OUT, 0o664);
fs.rmSync(STAGE, { recursive: true, force: true });

console.log(
  `Official-compatible readable AIX packed ${path.relative(ROOT, OUT)} `
  + `(${packResult.entryCount} entries; `
  + `upload ${fs.statSync(OUT).size} bytes; `
  + `Craft content ${sizeBudget.contentBytes} bytes; estimated final `
  + `${sizeBudget.estimatedPlatformBytes} bytes)`,
);
if (sizeBudget.warning) {
  console.warn('Warning: estimated Craft package is at or above 1800000 bytes; review content growth.');
}
