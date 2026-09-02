import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertAixVersion,
  createAixVersion,
  writeAixVersionAtomic,
} from './aix_identity.mjs';
import {
  AIX_PROVENANCE_FILE,
  assertExactAixArchiveClosure,
  computeReleaseSourceTreeSha256,
  listZipCentralDirectoryEntries,
  writeAixProvenance,
} from './aix_provenance.mjs';
import {
  assertRequiredRowerRuntime,
  discoverAixRuntimeFiles,
} from './aix_runtime_files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_PRODUCT_VERSION = '0.0.1';
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PRODUCT_VERSION = String(pkg.version || '').trim();
const DEFAULT_NAME = `AISmartRower-AIUI-v${PRODUCT_VERSION}-cn.aix`;
const OUT = path.resolve(ROOT, process.argv[2] || `release/${DEFAULT_NAME}`);
const TEMP = path.join(
  path.dirname(OUT),
  `.${path.basename(OUT)}.${process.pid}.tmp`,
);
const MAX_PLATFORM_BYTES = 2_000_000;
const CRAFT_OVERHEAD_BYTES = 10_000;

let stage = '';
let sourceVersionCommitted = false;
const previousVersionBytes = fs.readFileSync(path.join(ROOT, 'VERSION'));
assertAixVersion(previousVersionBytes.toString('utf8'), 'Current source VERSION');

function cleanup() {
  if (stage) fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(TEMP, { force: true });
}

function fail(message) {
  if (sourceVersionCommitted) {
    try {
      const previous = previousVersionBytes.toString('utf8').trim();
      writeAixVersionAtomic(ROOT, previous);
      sourceVersionCommitted = false;
    } catch (rollbackError) {
      console.error(`VERSION rollback failed: ${rollbackError.message}`);
    }
  }
  cleanup();
  console.error(message);
  process.exit(1);
}

function copyRuntimeFile(relative) {
  const source = path.join(ROOT, relative);
  const target = path.join(stage, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function contentBytes(root, entries) {
  return entries.reduce(
    (sum, relative) => sum + fs.statSync(path.join(root, relative)).size,
    0,
  );
}

if (pkg.name !== 'AISmartRower' || PRODUCT_VERSION !== EXPECTED_PRODUCT_VERSION) {
  fail(`package.json must identify AISmartRower v${EXPECTED_PRODUCT_VERSION}`);
}

let runtime;
let sourceTreeSha256;
try {
  runtime = discoverAixRuntimeFiles(ROOT);
  assertRequiredRowerRuntime(runtime);
  sourceTreeSha256 = computeReleaseSourceTreeSha256(ROOT, {
    entries: runtime.files,
  });
} catch (error) {
  fail(`AIX runtime closure preflight failed: ${error.message}`);
}

const zipCheck = spawnSync('zip', ['-v'], { cwd: ROOT, stdio: 'ignore' });
if (zipCheck.error || zipCheck.status !== 0) {
  fail('Missing Info-ZIP zip command');
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.rmSync(TEMP, { force: true });
stage = fs.mkdtempSync(path.join(path.dirname(OUT), '.AISmartRower-cn-stage-'));

let aixUuid;
let payloadTreeSha256;
const packageFiles = [...runtime.files, AIX_PROVENANCE_FILE];
try {
  aixUuid = createAixVersion();
  for (const relative of runtime.files) copyRuntimeFile(relative);
  fs.writeFileSync(path.join(stage, 'VERSION'), `${aixUuid}\n`, 'utf8');

  payloadTreeSha256 = computeReleaseSourceTreeSha256(stage, {
    entries: runtime.files,
  });
  if (payloadTreeSha256 !== sourceTreeSha256) {
    throw new Error(
      `Chinese identity payload differs from its release source: ${payloadTreeSha256} != ${sourceTreeSha256}`,
    );
  }
  writeAixProvenance(stage, {
    productVersion: PRODUCT_VERSION,
    aixUuid,
    sourceTreeSha256,
    payloadTreeSha256,
  });

  const result = spawnSync(
    'zip',
    ['-q', '-9', '-X', TEMP, ...packageFiles],
    { cwd: stage, stdio: 'inherit' },
  );
  if (result.error) throw new Error(`zip unavailable: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`zip failed with exit code ${result.status}`);

  const packageBytes = fs.readFileSync(TEMP);
  assertExactAixArchiveClosure(
    listZipCentralDirectoryEntries(packageBytes),
    packageFiles,
  );

  const unpackedBytes = contentBytes(stage, packageFiles);
  const estimatedPlatformBytes = unpackedBytes + CRAFT_OVERHEAD_BYTES;
  if (estimatedPlatformBytes > MAX_PLATFORM_BYTES) {
    throw new Error(
      `AIX exceeds Craft budget: ${unpackedBytes} content + ${CRAFT_OVERHEAD_BYTES} overhead `
        + `> ${MAX_PLATFORM_BYTES}`,
    );
  }

  const finalSourceTreeSha256 = computeReleaseSourceTreeSha256(ROOT, {
    entries: runtime.files,
  });
  if (finalSourceTreeSha256 !== sourceTreeSha256) {
    throw new Error('AIX release source changed while the package was being assembled');
  }

  // Commit the build identity only after every non-mutating gate and the complete
  // temporary archive have passed. A later commit failure restores old VERSION.
  fs.chmodSync(TEMP, 0o664);
  writeAixVersionAtomic(ROOT, aixUuid);
  sourceVersionCommitted = true;
  fs.renameSync(TEMP, OUT);
  sourceVersionCommitted = false;

  console.log(`Packed ${path.relative(ROOT, OUT)}`);
  console.log(`product version: ${PRODUCT_VERSION}`);
  console.log(`AIX UUID: ${aixUuid}`);
  console.log(`locale/transform: zh-CN / cn-identity-v1`);
  console.log(`source tree SHA-256: ${sourceTreeSha256}`);
  console.log(`payload tree SHA-256: ${payloadTreeSha256}`);
  console.log(`runtime files: ${runtime.files.length}; modules: ${runtime.moduleFiles.length}; assets: ${runtime.assetFiles.length}`);
  console.log('BLE closure: required FTMS + optional external HRS; telemetry only');
  console.log(`archive size: ${fs.statSync(OUT).size} bytes`);
  console.log(`Craft content: ${unpackedBytes} bytes`);
  console.log(`estimated Craft final: ${estimatedPlatformBytes} bytes`);
  console.log(`headroom: ${MAX_PLATFORM_BYTES - estimatedPlatformBytes} bytes`);
} catch (error) {
  fail(`AIX packaging failed: ${error.message}`);
} finally {
  cleanup();
}
