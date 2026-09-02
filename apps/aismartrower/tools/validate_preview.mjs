import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'preview/index.html'), 'utf8');
const EXPECTED_VIEWS = Object.freeze([
  'home', 'menu-free', 'menu-plan', 'settings', 'devices-idle',
  'devices-scanning', 'devices-found', 'devices-validating',
  'devices-ftms-silent', 'devices-ready', 'devices-error', 'warmup-1',
  'warmup-2', 'warmup-3', 'warmup-4', 'hud-waiting', 'hud-live',
  'hud-stale', 'hud-finish-confirm', 'summary-measured',
  'summary-stationary', 'summary-unavailable', 'recovery-1', 'recovery-2',
  'recovery-3', 'recovery-4', 'recovery-done',
]);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

requireCondition(/lang="zh-CN"/.test(html), 'Preview language must be zh-CN');
requireCondition(/AISmartRower v0\.0\.1/.test(html), 'Preview version mismatch');
requireCondition(/<span class="home-name">划船机教练<\/span>/.test(html), 'Product name missing');
requireCondition(/\.home\s*\{[^}]*width:448px;[^}]*height:150px/s.test(html), 'Home must be 448x150');
requireCondition(/\.immersive\s*\{[^}]*width:480px;[^}]*height:352px/s.test(html), 'Immersive preview must be 480x352');
requireCondition(/\.guide-figure\s*\{[^}]*width:160px;[^}]*height:160px/s.test(html), 'Guide placeholder must be 160x160');

const views = [...html.matchAll(/<button\s+role="tab"[^>]*data-view="([^"]+)"/g)]
  .map((match) => match[1]);
requireCondition(JSON.stringify(views) === JSON.stringify(EXPECTED_VIEWS), 'Preview state matrix mismatch');
for (const view of EXPECTED_VIEWS) {
  requireCondition(html.includes(`aria-controls="${view}"`), `Missing tab control ${view}`);
  requireCondition(new RegExp(`<section[^>]*id="${view}"[^>]*role="tabpanel"`).test(html), `Missing panel ${view}`);
}

for (const label of [
  '开始搜索', 'FTMS 必选', 'HRS 心率可选', '0x2ACC', '0x2AD1',
  '500m 分段', '桨频', '功率', '训练总结', 'DISTANCE MEASURED',
  'DISTANCE STATIONARY', 'DISTANCE UNAVAILABLE',
]) requireCondition(html.includes(label), `Preview missing ${label}`);

requireCondition((html.match(/programmatic-mark/g) || []).length >= 8, 'Programmatic product/sensor marks missing');
requireCondition((html.match(/<div class="guide-figure programmatic-rower"/g) || []).length === 8, 'Eight programmatic guide figures required');
requireCondition(!/<img\b|\.\.\/assets\//i.test(html), 'Preview must not reference unverified visual assets');
requireCondition(!/@keyframes|\banimation(?:-[a-z-]+)?\s*:|\btransition\s*:|gradient\s*\(/i.test(html), 'Preview must not use motion CSS or gradients');
requireCondition(!/119\.28|wx\.request|fetch\(|https?:\/\//i.test(html), 'Preview must remain offline');
requireCondition(!/GPS|皮划艇|桨板|Kayak|SUP|paddle_guide|aismartpaddle/i.test(html), 'Preview contains unrelated activity semantics');

console.log('OK design preview - v0.0.1; 27 states; programmatic marks; no external assets.');
