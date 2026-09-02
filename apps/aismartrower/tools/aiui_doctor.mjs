import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertRequiredRowerRuntime,
  discoverAixRuntimeFiles,
} from './aix_runtime_files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_PRODUCT_VERSION = '0.0.1';
function requireCondition(condition, message) { if (!condition) throw new Error(message); }
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const manifest = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
const pages = app.pages.map((route) => fs.readFileSync(path.join(ROOT, `${route}.ink`), 'utf8'));
const runtime = discoverAixRuntimeFiles(ROOT);
assertRequiredRowerRuntime(runtime);
requireCondition(
  pkg.name === 'AISmartRower' && pkg.version === EXPECTED_PRODUCT_VERSION,
  'Product metadata mismatch',
);
requireCondition(
  !/\bindoor\b|\boutdoor\b/i.test(pkg.description),
  'Product description must stay rowing-machine specific',
);
requireCondition(
  lock.name === pkg.name && lock.version === pkg.version
    && lock.packages?.['']?.name === pkg.name
    && lock.packages?.['']?.version === pkg.version,
  'package-lock product metadata mismatch',
);
requireCondition(
  new RegExp(`\\*\\*Version\\*\\*:\\s*${EXPECTED_PRODUCT_VERSION.replaceAll('.', '\\.')}\\b`).test(manifest),
  'AGENTS.md product version mismatch',
);
requireCondition(
  manifest.includes('- **Name**: 划船机教练'),
  'AGENTS.md Chinese product name mismatch',
);
requireCondition(
  manifest.includes(`AISmartRower-AIUI-v${EXPECTED_PRODUCT_VERSION}-cn.aix`),
  'AGENTS.md release filename mismatch',
);
requireCondition(
  JSON.stringify(app.pages) === JSON.stringify([
    'pages/index/index',
    'pages/rower_hud/index',
  ]),
  'app.json route mismatch',
);
requireCondition(JSON.stringify(app.permissions) === '[]', 'app.json permissions must remain empty');
requireCondition(
  app.window?.navigationBarTitleText === '划船机教练',
  'app.json Chinese navigation title mismatch',
);
for (const capability of ['bluetooth', 'audio']) requireCondition(manifest.includes(`  - ${capability}`), `Missing ${capability} capability`);
requireCondition(!manifest.includes('  - network'), 'Runtime manifest must remain offline');
requireCondition(/width:\s*448px;[^}]*height:\s*150px/s.test(pages[0]), 'Home canvas mismatch');
requireCondition(/\.stage\s*\{[^}]*width:\s*480px;[^}]*height:\s*352px/s.test(pages[1]), 'Immersive canvas mismatch');
for (const page of pages) {
  requireCondition(page.includes(`v${EXPECTED_PRODUCT_VERSION}`), 'Page product version mismatch');
  requireCondition(page.includes('"navigationBarTitleText": "划船机教练"'), 'Page Chinese navigation title mismatch');
  requireCondition(!page.includes('v0.1.0'), 'Superseded v0.1.0 identity leaked into page');
}
requireCondition(
  pages[0].includes('<text class="name">划船机教练</text>')
    && pages[1].includes('<text class="title">划船机教练</text>'),
  'Visible Chinese product name mismatch',
);
requireCondition(
  !/室内|同模式/.test(pages.join('\n')),
  'Redundant mode wording leaked into pages',
);
requireCondition(
  !/室内|户外|水上|AISmartPaddle|Kayak|皮划艇|桨板/.test(manifest),
  'Packaged manifest contains redundant or unrelated activity wording',
);
const executableFiles = ['app.js', ...runtime.pageFiles, ...runtime.moduleFiles];
const source = executableFiles.map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
for (const uuid of [
  '00001826-0000-1000-8000-00805f9b34fb',
  '00002acc-0000-1000-8000-00805f9b34fb',
  '00002ad1-0000-1000-8000-00805f9b34fb',
  '0000180d-0000-1000-8000-00805f9b34fb',
  '00002a37-0000-1000-8000-00805f9b34fb',
]) requireCondition(source.includes(uuid), `Missing standard BLE runtime UUID ${uuid}`);
requireCondition(
  source.includes('new HeartRateSession')
    && source.includes('new HeartRateSourceArbiter'),
  'Optional HRS session/arbitration is not wired into the runtime closure',
);
requireCondition(!/@keyframes|animation\s*:|transition\s*:|gradient\s*\(/i.test(source), 'Forbidden motion CSS');
requireCondition(!/UnitySendMessage|AndroidJavaObject|sendCommand|\bMAC\b|writeValue(?:With|Without)?Response/.test(source), 'Private bridge or physical control leaked into runtime');
requireCondition(!/['"](?:AA|A_[^'"]*|B_[^'"]*|C_[^'"]*|D_[^'"]*|DP_[^'"]*)['"]/.test(source), 'Private bridge command leaked into runtime');
requireCondition(!/室内|navigator\.geolocation|wx\.getLocation|\bGPS\b|皮划艇|Kayak|\bSUP\b/.test(source), 'Redundant or unrelated activity semantics leaked into runtime');
requireCondition(
  !/\bweather\b|WeatherIdentity|weather_identity|weather_registration|rowerWeather/i.test(source),
  'Unrelated weather identity semantics leaked into runtime',
);
requireCondition(
  !/119\.28|wx\.request|fetch\(|https?:\/\//i.test(source),
  'Runtime contains a network request or configured endpoint',
);
requireCondition(
  !/device\.(?:name|deviceName|id|deviceId)|error\.message|String\([^)]*error/i.test(source),
  'Runtime exposes peripheral identity or native error text',
);
for (const legalFile of ['LICENSE', 'COPYRIGHT']) {
  requireCondition(runtime.files.includes(legalFile), `AIX runtime missing ${legalFile}`);
}
console.log(
  `OK AIUI Doctor - v${EXPECTED_PRODUCT_VERSION}; ${runtime.files.length} runtime files; `
  + `${runtime.moduleFiles.length} modules; ${runtime.assetFiles.length} assets; `
  + 'required FTMS + optional HRS telemetry; dual-peripheral host gate remains open.',
);
