import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertAixVersion } from './aix_identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_PRODUCT_VERSION = '0.0.1';
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (pkg.name !== 'AISmartRower' || pkg.version !== EXPECTED_PRODUCT_VERSION) {
  console.error(`Source package must identify AISmartRower v${EXPECTED_PRODUCT_VERSION}`);
  process.exit(1);
}
const RELEASE = path.join(ROOT, 'release', `AISmartRower-AIUI-v${pkg.version}-cn.aix`);
const STEPS = [
  ['tests', ['npm', 'test']],
  ['doctor', ['npm', 'run', 'doctor:aiui']],
  ['BLE contract', ['npm', 'run', 'contract:lint']],
  ['design preview', ['npm', 'run', 'preview:check']],
  ['AIX inspection', ['npm', 'run', 'inspect:aix']],
  ['official AIX preview', ['npm', 'run', 'aix:preview:check']],
];

for (const [label, command] of STEPS) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(command[0], command.slice(1), { cwd: ROOT, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(`Release verification failed at ${label}: ${result.error?.message || result.status}`);
    process.exit(1);
  }
}

const bytes = fs.readFileSync(RELEASE);
const uuid = assertAixVersion(fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8'), 'Release VERSION');
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
console.log('\nOK local release verification');
console.log(`artifact: ${path.relative(ROOT, RELEASE)}`);
console.log(`version: ${pkg.version}`);
console.log(`AIX UUID: ${uuid}`);
console.log(`SHA-256: ${sha256}`);
console.log(`archive size: ${bytes.length} bytes`);
console.log(
  'External gates: FTMS + independent HRS first packets, simultaneous dual-GATT/Notify '
  + 'for at least 15 minutes, single-link disconnect isolation, glasses input, '
  + 'Craft import/signing.',
);
