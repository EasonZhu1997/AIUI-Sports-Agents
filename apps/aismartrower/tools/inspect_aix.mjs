import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertAixVersion } from './aix_identity.mjs';
import {
  AIX_LOCALE,
  AIX_PROVENANCE_FILE,
  AIX_TRANSFORM_VERSION,
  assertExactAixArchiveClosure,
  computeAixTreeSha256,
  computeReleaseSourceTreeSha256,
  listZipCentralDirectoryEntries,
  parseAndVerifyAixProvenance,
} from './aix_provenance.mjs';
import {
  assertRequiredRowerRuntime,
  discoverAixRuntimeFiles,
} from './aix_runtime_files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_PRODUCT_VERSION = '0.0.1';
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const TARGET = path.resolve(ROOT, process.argv[2] || `release/AISmartRower-AIUI-v${pkg.version}-cn.aix`);
const READER_MODULE = path.join(
  ROOT,
  'node_modules/@yodaos-pkg/aix-cli/dist/pkg/aix_web.js',
);
const MAX_PLATFORM_BYTES = 2_000_000;
const CRAFT_OVERHEAD_BYTES = 10_000;

function fail(message) { console.error(message); process.exit(1); }
function decode(reader, name) { return new TextDecoder().decode(reader.read_file(name)); }
function parseJson(reader, name) {
  try { return JSON.parse(decode(reader, name)); }
  catch (error) { fail(`Invalid JSON in ${name}: ${error.message}`); }
}

if (pkg.name !== 'AISmartRower' || pkg.version !== EXPECTED_PRODUCT_VERSION) {
  fail(`Source package must identify AISmartRower v${EXPECTED_PRODUCT_VERSION}`);
}
const runtime = discoverAixRuntimeFiles(ROOT);
assertRequiredRowerRuntime(runtime);
const required = [...runtime.files, AIX_PROVENANCE_FILE];
let aixModule;
try {
  aixModule = createRequire(import.meta.url)(READER_MODULE);
} catch (_error) {
  fail('Missing MIT-declared @yodaos-pkg/aix-cli reader; run npm ci');
}
const packageBytes = await fs.readFile(TARGET);
assertExactAixArchiveClosure(listZipCentralDirectoryEntries(packageBytes), required);
const reader = new aixModule.AixReaderWasm(new Uint8Array(packageBytes));
const entries = reader.list();
assertExactAixArchiveClosure(entries.map((entry) => String(entry.name || '')), required);

for (const relative of runtime.files) {
  const source = await fs.readFile(path.join(ROOT, relative));
  const packaged = Buffer.from(reader.read_file(relative));
  if (!source.equals(packaged)) fail(`AIX/source mismatch: ${relative}`);
}

const app = parseJson(reader, 'app.json');
const packagedPkg = parseJson(reader, 'package.json');
if (packagedPkg.name !== 'AISmartRower' || packagedPkg.version !== pkg.version
    || packagedPkg.description !== pkg.description
    || packagedPkg.license !== 'PolyForm-Noncommercial-1.0.0'
    || /\bindoor\b|\boutdoor\b/i.test(packagedPkg.description)) fail('Packaged product metadata mismatch');
if (JSON.stringify(app.pages) !== JSON.stringify(['pages/index/index', 'pages/rower_hud/index'])
    || JSON.stringify(app.permissions) !== '[]') fail('Packaged app route/permission mismatch');
if (app.window?.navigationBarTitleText !== '划船机教练') {
  fail('Packaged Chinese navigation title mismatch');
}
const manifest = decode(reader, 'AGENTS.md');
const packagedLicense = decode(reader, 'LICENSE');
const packagedCopyright = decode(reader, 'COPYRIGHT');
if (!packagedLicense.startsWith('# PolyForm Noncommercial License 1.0.0')
    || !packagedCopyright.includes('Required Notice: Copyright Yixiao Zhu')) {
  fail('Packaged license or required copyright notice mismatch');
}
if (!new RegExp(`\\*\\*Version\\*\\*:\\s*${EXPECTED_PRODUCT_VERSION.replaceAll('.', '\\.')}\\b`).test(manifest)
    || !manifest.includes('- **Name**: 划船机教练')
    || !manifest.includes(`AISmartRower-AIUI-v${EXPECTED_PRODUCT_VERSION}-cn.aix`)) {
  fail('Packaged AGENTS.md version/release identity mismatch');
}
if (/室内|户外|水上|AISmartPaddle|Kayak|皮划艇|桨板/.test(manifest)) {
  fail('Packaged manifest contains redundant or unrelated activity wording');
}

const home = decode(reader, 'pages/index/index.ink');
const immersive = decode(reader, 'pages/rower_hud/index.ink');
if (!/width:\s*448px;[^}]*height:\s*150px/s.test(home)) fail('Packaged home is not 448x150');
if (!/\.stage\s*\{[^}]*width:\s*480px;[^}]*height:\s*352px/s.test(immersive)) fail('Packaged immersive route is not 480x352');
if (!home.includes('<text class="name">划船机教练</text>')
    || !immersive.includes('<text class="title">划船机教练</text>')
    || !home.includes('"navigationBarTitleText": "划船机教练"')
    || !immersive.includes('"navigationBarTitleText": "划船机教练"')) {
  fail('Packaged visible Chinese product name mismatch');
}
if (/室内|同模式/.test(home + immersive)) fail('Packaged pages contain redundant mode wording');
const executable = ['app.js', ...runtime.pageFiles, ...runtime.moduleFiles]
  .map((name) => decode(reader, name)).join('\n');
for (const uuid of [
  '00001826-0000-1000-8000-00805f9b34fb',
  '00002acc-0000-1000-8000-00805f9b34fb',
  '00002ad1-0000-1000-8000-00805f9b34fb',
  '0000180d-0000-1000-8000-00805f9b34fb',
  '00002a37-0000-1000-8000-00805f9b34fb',
]) if (!executable.includes(uuid)) fail(`AIX BLE runtime UUID missing: ${uuid}`);
if (!executable.includes('new HeartRateSession')
    || !executable.includes('new HeartRateSourceArbiter')) {
  fail('AIX optional HRS session/arbitration wiring is missing');
}
if (/@keyframes|\banimation(?:-[a-z-]+)?\s*:|\btransition\s*:|gradient\s*\(/i.test(executable)) fail('AIX contains forbidden motion CSS');
if (/室内|navigator\.geolocation|wx\.getLocation|\bGPS\b|皮划艇|Kayak|\bSUP\b/.test(executable)) fail('AIX contains redundant or unrelated activity semantics');
if (/\bweather\b|WeatherIdentity|weather_identity|weather_registration|rowerWeather/i.test(executable)) fail('AIX contains unrelated weather identity semantics');
if (/119\.28|wx\.request|fetch\(|https?:\/\//i.test(executable)) fail('AIX runtime contains a network request or configured endpoint');
if (/device\.(?:name|deviceName|id|deviceId)|error\.message|String\([^)]*error/i.test(executable)) fail('AIX runtime exposes peripheral identity or native error text');
if (/UnitySendMessage|AndroidJavaObject|sendCommand|\bMAC\b|writeValue(?:With|Without)?Response/.test(executable)) fail('AIX contains a private bridge/control path');
if (/['"](?:AA|A_[^'"]*|B_[^'"]*|C_[^'"]*|D_[^'"]*|DP_[^'"]*)['"]/.test(executable)) fail('AIX contains a private command literal');

const contentBytes = entries.reduce((sum, entry) => sum + Number(entry.size || 0), 0);
if (contentBytes + CRAFT_OVERHEAD_BYTES >= MAX_PLATFORM_BYTES) fail('AIX exceeds strict Craft size budget');
const packagedUuid = assertAixVersion(decode(reader, 'VERSION'), 'Packaged AIX VERSION');
const sourceUuid = assertAixVersion(await fs.readFile(path.join(ROOT, 'VERSION'), 'utf8'), 'Source VERSION');
if (sourceUuid !== packagedUuid) fail('Source and packaged UUID differ');
const sourceTreeSha256 = computeReleaseSourceTreeSha256(ROOT, { entries: runtime.files });
const payloadTreeSha256 = computeAixTreeSha256(entries.map((entry) => ({ path: entry.name, bytes: reader.read_file(entry.name) })));
const provenance = parseAndVerifyAixProvenance(decode(reader, AIX_PROVENANCE_FILE), {
  expectedProductVersion: pkg.version,
  expectedAixUuid: packagedUuid,
  currentSourceTreeSha256: sourceTreeSha256,
  packagedPayloadTreeSha256: payloadTreeSha256,
});
if (provenance.locale !== AIX_LOCALE || provenance.transformVersion !== AIX_TRANSFORM_VERSION) fail('AIX locale provenance mismatch');
const sha256 = crypto.createHash('sha256').update(packageBytes).digest('hex');
console.log('OK AIX Inspector');
console.log(`artifact: ${path.relative(ROOT, TARGET)}`);
console.log(`version: ${pkg.version}`);
console.log(`AIX UUID: ${packagedUuid}`);
console.log(`SHA-256: ${sha256}`);
console.log(`archive/content/estimated: ${packageBytes.length}/${contentBytes}/${contentBytes + CRAFT_OVERHEAD_BYTES} bytes`);
console.log(`source/payload tree: ${sourceTreeSha256}/${payloadTreeSha256}`);
console.log(`runtime closure: ${runtime.files.length} files; ${runtime.moduleFiles.length} modules; ${runtime.assetFiles.length} assets`);
console.log('host gate: simultaneous FTMS + external HRS remains real-device unverified');
