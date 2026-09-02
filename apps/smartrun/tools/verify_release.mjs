import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AIX_UUID_V4_RE } from './bump_version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT_VERSION = String(JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
).version || '').trim();
const CN_RELEASE_NAME = `AISmartRun-AIUI-v${PRODUCT_VERSION}-cn.aix`;
const EN_RELEASE_NAME = `AISmartRun-AIUI-v${PRODUCT_VERSION}-en.aix`;
const JA_RELEASE_NAME = `AISmartRun-AIUI-v${PRODUCT_VERSION}-ja.aix`;

export const RELEASE_STEPS = [
  ['AIUI doctor', ['npm', 'run', 'doctor:aiui']],
  ['Preview validation', ['npm', 'run', 'preview:check']],
  ['Unit, metadata and coverage tests', ['npm', 'run', 'test:coverage']],
  // Order is intentional: each build mints its own AIX UUID v4 while product
  // semver remains unchanged in package.json, AGENTS.md and both PRDs.
  ['Chinese AIX build', ['npm', 'run', 'build']],
  ['English AIX build', ['npm', 'run', 'build:en']],
  ['Japanese AIX build', ['npm', 'run', 'build:ja']],
];

const PRODUCT_METADATA_FILES = [
  'package.json',
  'AGENTS.md',
  'docs/AISmartRun_PRD.md',
  'docs/AISmartRun_PRD_EN.md',
];

export function readPackagedAixVersion(target) {
  const result = spawnSync('unzip', ['-p', target, 'VERSION'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to read AIX VERSION from ${target}: ${result.error?.message || result.stderr || result.status}`);
  }
  return String(result.stdout || '').trim();
}

export function assertDistinctAixVersions(cnVersion, enVersion, jaVersion = null) {
  if (!AIX_UUID_V4_RE.test(cnVersion)) {
    throw new Error(`Chinese AIX VERSION is not a UUID v4: ${JSON.stringify(cnVersion)}`);
  }
  if (!AIX_UUID_V4_RE.test(enVersion)) {
    throw new Error(`English AIX VERSION is not a UUID v4: ${JSON.stringify(enVersion)}`);
  }
  if (cnVersion === enVersion) {
    throw new Error(`CN and EN AIX packages must have distinct UUIDs: ${cnVersion}`);
  }
  if (jaVersion != null) {
    if (!AIX_UUID_V4_RE.test(jaVersion)) {
      throw new Error(`Japanese AIX VERSION is not a UUID v4: ${JSON.stringify(jaVersion)}`);
    }
    if (new Set([cnVersion, enVersion, jaVersion]).size !== 3) {
      throw new Error('CN, EN and JA AIX packages must have distinct UUIDs.');
    }
  }
}

export function runReleaseVerification() {
  const initialProductMetadata = new Map(PRODUCT_METADATA_FILES.map((file) => [
    file,
    fs.readFileSync(path.join(ROOT, file), 'utf8'),
  ]));

  for (const [label, command] of RELEASE_STEPS) {
    console.log(`\n== ${label} ==`);
    const result = spawnSync(command[0], command.slice(1), {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (result.error) {
      console.error(`\n${label} failed: ${result.error.message}`);
      process.exit(1);
    }
    if (result.status !== 0) {
      console.error(`\n${label} failed with exit code ${result.status}`);
      process.exit(result.status || 1);
    }
  }

  for (const [file, initialText] of initialProductMetadata) {
    const finalText = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (finalText !== initialText) {
      console.error(`\nRelease packaging must not mutate product metadata: ${file}`);
      process.exit(1);
    }
  }

  try {
    const cnVersion = readPackagedAixVersion(path.join(ROOT, 'release', CN_RELEASE_NAME));
    const enVersion = readPackagedAixVersion(path.join(ROOT, 'release', EN_RELEASE_NAME));
    const jaVersion = readPackagedAixVersion(path.join(ROOT, 'release', JA_RELEASE_NAME));
    assertDistinctAixVersions(cnVersion, enVersion, jaVersion);

    const sourceVersion = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
    if (sourceVersion !== cnVersion) {
      throw new Error(`Source VERSION must match the latest CN package UUID: ${sourceVersion} != ${cnVersion}`);
    }
  } catch (error) {
    console.error(`\nRelease package identity verification failed: ${error.message}`);
    process.exit(1);
  }

  console.log('\nOK release verification - doctor, previews, tests and all three AIX builds passed with distinct UUIDs.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReleaseVerification();
}
