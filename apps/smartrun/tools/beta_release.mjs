import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AIX_UUID_V4_RE } from './bump_version.mjs';
import {
  AIX_LOCALES,
  AIX_PROVENANCE_FILE,
  parseAndVerifyAixProvenance,
} from './aix_provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const GIT_COMMIT_RE = /^[0-9a-f]{40}$/;

export const PUBLIC_BETA_STATUS = 'public-beta-candidate';

export const LOCAL_PACKAGE_BOUNDARY = Object.freeze({
  packageType: 'local-unsigned-aix',
  signed: false,
  uploaded: false,
  craftValidated: false,
  realDeviceValidated: false,
  statement: 'These files are local unsigned AIX candidates. They are not an AIUI Studio release or proof of runtime acceptance.',
});

export const REQUIRED_EXTERNAL_ACCEPTANCE = Object.freeze([
  'Import all three language packages into AIUI Studio / Craft and pass package inspection.',
  'Pass Craft interaction checks for focus, forward/back swipe, confirm, Backspace, summary and exit.',
  'Pass Rokid real-device checks for Bluetooth HRS/RSC lifecycle, sensors, audio and multilingual layout.',
]);

export function assertProductVersion(value) {
  const version = String(value || '').trim();
  if (!SEMVER_RE.test(version)) {
    throw new Error(`Invalid product semver: ${JSON.stringify(value)}`);
  }
  return version;
}

export function getReleaseNames(productVersion) {
  const version = assertProductVersion(productVersion);
  return {
    cn: `AISmartRun-AIUI-v${version}-cn.aix`,
    en: `AISmartRun-AIUI-v${version}-en.aix`,
    ja: `AISmartRun-AIUI-v${version}-ja.aix`,
    directory: `public-beta-v${version}`,
  };
}

export function assertCleanGitStatus(statusText) {
  const status = String(statusText || '').trim();
  if (status) {
    throw new Error(`Public beta source worktree must be clean:\n${status}`);
  }
  return true;
}

export function assertGitSource({ commit, branch }) {
  const normalizedCommit = String(commit || '').trim().toLowerCase();
  const normalizedBranch = String(branch || '').trim();
  if (!GIT_COMMIT_RE.test(normalizedCommit)) {
    throw new Error(`Unable to resolve a full Git HEAD commit: ${JSON.stringify(commit)}`);
  }
  if (!normalizedBranch || normalizedBranch === 'HEAD') {
    throw new Error('Public beta source must be on a named Git branch.');
  }
  return { commit: normalizedCommit, branch: normalizedBranch, clean: true };
}

export function countZipEntries(listingText) {
  const entries = String(listingText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!entries.length) {
    throw new Error('AIX archive has no readable ZIP entries.');
  }
  return entries.length;
}

export function assertAixIdentity(uuid, label = 'AIX') {
  const normalized = String(uuid || '').trim();
  if (!AIX_UUID_V4_RE.test(normalized)) {
    throw new Error(`${label} VERSION is not a UUID v4: ${JSON.stringify(uuid)}`);
  }
  return normalized;
}

export function assertSourceVersionMatches(sourceVersion, cnAixVersion) {
  const source = assertAixIdentity(sourceVersion, 'source VERSION');
  const packaged = assertAixIdentity(cnAixVersion, 'CN AIX');
  if (source !== packaged) {
    throw new Error(
      `Source VERSION must match the verified CN AIX UUID: ${source} != ${packaged}`,
    );
  }
  return source;
}

export function buildPublicBetaManifest({
  productVersion,
  generatedAt,
  source,
  artifacts,
}) {
  const version = assertProductVersion(productVersion);
  const instant = new Date(generatedAt);
  if (!Number.isFinite(instant.getTime())) {
    throw new Error(`Invalid candidate generation time: ${JSON.stringify(generatedAt)}`);
  }
  const normalizedSource = assertGitSource(source || {});
  if (source?.clean !== true) {
    throw new Error('Public beta manifest cannot be created from a dirty source tree.');
  }

  const normalizedArtifacts = {};
  for (const language of ['cn', 'en', 'ja']) {
    const artifact = artifacts?.[language];
    if (!artifact || typeof artifact !== 'object') {
      throw new Error(`Missing ${language.toUpperCase()} AIX artifact metadata.`);
    }
    const bytes = Number(artifact.bytes);
    const entryCount = Number(artifact.entryCount);
    const sha256 = String(artifact.sha256 || '').trim().toLowerCase();
    if (!path.basename(String(artifact.fileName || '')).endsWith(`-${language}.aix`)) {
      throw new Error(`Invalid ${language.toUpperCase()} AIX file name.`);
    }
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new Error(`Invalid ${language.toUpperCase()} AIX byte size.`);
    }
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`Invalid ${language.toUpperCase()} AIX SHA-256.`);
    }
    if (!Number.isSafeInteger(entryCount) || entryCount <= 0) {
      throw new Error(`Invalid ${language.toUpperCase()} AIX ZIP entry count.`);
    }
    normalizedArtifacts[language] = {
      schemaVersion: Number(artifact.schemaVersion),
      fileName: path.basename(artifact.fileName),
      bytes,
      sha256,
      aixVersionUuid: assertAixIdentity(
        artifact.aixVersionUuid,
        language.toUpperCase(),
      ),
      entryCount,
      locale: String(artifact.locale || ''),
      transformVersion: String(artifact.transformVersion || ''),
      sourceTreeSha256: String(artifact.sourceTreeSha256 || '').toLowerCase(),
      payloadTreeSha256: String(artifact.payloadTreeSha256 || '').toLowerCase(),
    };
    const expectedLocale = language === 'cn'
      ? AIX_LOCALES.cn
      : (language === 'ja' ? AIX_LOCALES.ja : AIX_LOCALES.en);
    parseAndVerifyAixProvenance(normalizedArtifacts[language], { expectedLocale });
  }
  if (new Set(Object.values(normalizedArtifacts).map((item) => item.aixVersionUuid)).size !== 3) {
    throw new Error('CN, EN and JA public beta AIX packages must have distinct VERSION UUIDs.');
  }
  if (new Set(Object.values(normalizedArtifacts).map((item) => item.sourceTreeSha256)).size !== 1) {
    throw new Error('CN, EN and JA public beta AIX packages must trace to the same release source tree.');
  }

  return {
    schemaVersion: 2,
    productVersion: version,
    candidateStatus: PUBLIC_BETA_STATUS,
    generatedAt: instant.toISOString(),
    source: normalizedSource,
    artifacts: normalizedArtifacts,
    localPackageBoundary: { ...LOCAL_PACKAGE_BOUNDARY },
    requiredExternalAcceptance: [...REQUIRED_EXTERNAL_ACCEPTANCE],
  };
}

function runCheckedCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message || String(result.stderr || '').trim() || `exit ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed: ${reason}`);
  }
  return String(result.stdout || '');
}

async function sha256File(file) {
  const bytes = await fs.readFile(file);
  return createHash('sha256').update(bytes).digest('hex');
}

async function inspectAix(file, fileName, commandRunner, root) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    throw new Error(`Required AIX package is missing: ${file} (${error.message})`);
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Required AIX package is not a non-empty file: ${file}`);
  }
  commandRunner(process.execPath, [path.join(root, 'tools/inspect_aix.mjs'), file], root);
  const aixVersionUuid = assertAixIdentity(
    commandRunner('unzip', ['-p', file, 'VERSION'], root),
    fileName,
  );
  const entryCount = countZipEntries(
    commandRunner('unzip', ['-Z1', file], root),
  );
  let provenance;
  try {
    provenance = parseAndVerifyAixProvenance(
      commandRunner('unzip', ['-p', file, AIX_PROVENANCE_FILE], root),
      {
        expectedLocale: fileName.endsWith('-cn.aix')
          ? AIX_LOCALES.cn
          : (fileName.endsWith('-ja.aix') ? AIX_LOCALES.ja : AIX_LOCALES.en),
      },
    );
  } catch (error) {
    throw new Error(`${fileName} provenance failed: ${error.message}`);
  }
  return {
    fileName,
    bytes: stat.size,
    sha256: await sha256File(file),
    aixVersionUuid,
    entryCount,
    ...provenance,
  };
}

async function assertCandidatePathAbsent(targetDir) {
  try {
    await fs.lstat(targetDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error(`Unable to inspect candidate destination ${targetDir}: ${error.message}`);
  }
  throw new Error(`Public beta candidate destination already exists: ${targetDir}`);
}

export async function createPublicBetaCandidate({
  root = ROOT,
  now = () => new Date(),
  commandRunner = runCheckedCommand,
} = {}) {
  const packageFile = path.join(root, 'package.json');
  let packageJson;
  try {
    packageJson = JSON.parse(await fs.readFile(packageFile, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read product metadata from ${packageFile}: ${error.message}`);
  }
  const productVersion = assertProductVersion(packageJson.version);
  const names = getReleaseNames(productVersion);
  const releaseDir = path.join(root, 'release');
  const targetDir = path.join(releaseDir, names.directory);
  await assertCandidatePathAbsent(targetDir);

  // Check the entire repository. The project release workflow is responsible
  // for ignoring generated candidate directories; this gate never weakens the
  // clean-tree requirement with path exclusions.
  const status = commandRunner('git', [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ], root);
  assertCleanGitStatus(status);
  const source = assertGitSource({
    commit: commandRunner('git', ['rev-parse', 'HEAD'], root),
    branch: commandRunner('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], root),
  });

  const artifacts = {
    cn: await inspectAix(
      path.join(releaseDir, names.cn),
      names.cn,
      commandRunner,
      root,
    ),
    en: await inspectAix(
      path.join(releaseDir, names.en),
      names.en,
      commandRunner,
      root,
    ),
    ja: await inspectAix(
      path.join(releaseDir, names.ja),
      names.ja,
      commandRunner,
      root,
    ),
  };
  let sourceVersion;
  try {
    sourceVersion = await fs.readFile(path.join(root, 'VERSION'), 'utf8');
  } catch (error) {
    throw new Error(`Unable to read source VERSION: ${error.message}`);
  }
  assertSourceVersionMatches(sourceVersion, artifacts.cn.aixVersionUuid);
  const manifest = buildPublicBetaManifest({
    productVersion,
    generatedAt: now(),
    source,
    artifacts,
  });

  const tempDir = path.join(
    releaseDir,
    `.${names.directory}.tmp-${process.pid}-${Date.now()}`,
  );
  await fs.rm(tempDir, { recursive: true, force: true });
  try {
    await fs.mkdir(tempDir, { recursive: true });
    await Promise.all([
      fs.copyFile(path.join(releaseDir, names.cn), path.join(tempDir, names.cn)),
      fs.copyFile(path.join(releaseDir, names.en), path.join(tempDir, names.en)),
      fs.copyFile(path.join(releaseDir, names.ja), path.join(tempDir, names.ja)),
    ]);
    await fs.writeFile(
      path.join(tempDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    // Refuse to overwrite a candidate created since the initial preflight.
    await assertCandidatePathAbsent(targetDir);
    await fs.rename(tempDir, targetDir);
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  return {
    outputDir: targetDir,
    manifestPath: path.join(targetDir, 'manifest.json'),
    manifest,
  };
}

async function main() {
  try {
    const result = await createPublicBetaCandidate();
    console.log(`OK public beta candidate: ${result.outputDir}`);
    console.log(`Manifest: ${result.manifestPath}`);
    console.log('Boundary: local unsigned packages only; no signing or upload was performed.');
  } catch (error) {
    console.error(`Public beta candidate gate failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
