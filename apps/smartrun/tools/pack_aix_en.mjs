import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
const TARGET_LANGUAGE = process.argv.includes('--ja') ? 'ja' : 'en';
const TARGET_LOCALE = TARGET_LANGUAGE === 'ja' ? AIX_LOCALES.ja : AIX_LOCALES.en;
const outputArg = process.argv.slice(2).find((arg) => arg !== '--ja');
const DEFAULT_OUT_NAME = `AISmartRun-AIUI-v${PRODUCT_VERSION}-${TARGET_LANGUAGE}.aix`;
const OUT = path.resolve(ROOT, outputArg || `release/${DEFAULT_OUT_NAME}`);
const STAGE = path.resolve(ROOT, `release/.AISmartRun-${TARGET_LANGUAGE}.src.tmp`);
const TMP = path.resolve(ROOT, `release/.${DEFAULT_OUT_NAME}.tmp`);
const NON_EN_RE = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
const TEXT_FILE_RE = /\.(?:js|json|md|ink)$/;
const REQUIRED_PERMISSIONS = [
  'bluetooth',
  'accelerometer',
  'gyroscope',
  'audio',
  'network',
];
const REQUIRED_APP_PERMISSIONS = [];
// Product semver is release metadata; the package-local VERSION is a distinct
// UUID v4 minted in the English staging tree immediately before it is zipped.
const SOURCE_ENTRIES = [...AIX_RELEASE_SOURCE_ENTRIES];
const PACKAGE_ENTRIES = [...SOURCE_ENTRIES, AIX_PROVENANCE_FILE];

// Store Description is authored once in package.json. Both language packages reuse
// the same concise English functional copy so release metadata cannot drift.
const EN_DESCRIPTION = packageJson.description;
const JA_DESCRIPTION = 'SmartRunはRokid Glassesでランニングを記録し、心拍、ケイデンス、ペース、距離、時間と結果を表示します。';
const PAGE_DESCRIPTIONS = {};

const storeWords = EN_DESCRIPTION.trim().split(/\s+/).filter(Boolean);
if (!EN_DESCRIPTION || NON_EN_RE.test(EN_DESCRIPTION) || storeWords.length > 200) {
  fail(`Store Description must be functional English in 200 words or fewer: ${storeWords.length} words`);
}
if (Buffer.byteLength(EN_DESCRIPTION, 'utf8') > 200) {
  fail(`Store Description exceeds the stricter AIUI limit: ${Buffer.byteLength(EN_DESCRIPTION, 'utf8')} bytes`);
}

for (const [name, description] of Object.entries(PAGE_DESCRIPTIONS)) {
  if (description.length > 100) {
    fail(`English ${name} description is too long: ${description.length} chars`);
  }
}

const EN_AGENTS = `# Agent Manifest - AISmartRun

## Store Description

${EN_DESCRIPTION}

## Identity

- **Name**: SmartRun
- **Version**: ${PRODUCT_VERSION}
- **Description**: ${EN_DESCRIPTION}
- **Author**: Yixiao Zhu

## Capabilities

- **Permissions**:
  - bluetooth
  - accelerometer
  - gyroscope
  - audio
  - network

### Permission Usage

- \`bluetooth\`: Start discovery only after an explicit user action, connect compatible devices, use standard HRS (\`0x180D/0x2A37\`) for heart rate, and optionally use RSC (\`0x1814/0x2A53\`) for speed and cadence.
- \`accelerometer\`: Estimate steps, cadence, distance and pace from the glasses IMU when fresh RSC data is unavailable.
- \`gyroscope\`: Reject head turns, glasses adjustment and touch artifacts; angular velocity is never integrated into distance.
- \`audio\`: Play bundled metronome beats and short running or safety cues.
- \`network\`: Optionally upload a user-enabled run summary and derived metrics over HTTPS. Core running, HUD and local summary remain available offline.

## Runtime Contract

- Garmin is a standard BLE compatibility example, not a partnership or certification claim. Ordinary heart-rate broadcast generally guarantees only HRS. RSC is used only when the device exposes it and keeps sending valid data; some Garmin models require Virtual Run and START.
- Service discovery or subscription success is not live-data proof. HRS is confirmed by the first valid \`0x2A37\` notification. RSC becomes live only after the first valid notification, then remains usable only while \`0x2A53\` data is fresh. HRS and RSC fall back after 8-second and 2.5-second freshness windows respectively.
- Missing, silent, invalid or stale RSC preserves any usable HRS connection and falls back to glasses IMU. One distance ledger owns accumulation and re-anchors when the source changes, preventing duplicate distance.
- Each new glasses-motion bout needs three strict accepted-step signals after running quality is established, or four cadence-consistent signals no higher than 210 spm while quality remains uncertain. Unconfirmed candidates are never replayed.
- A current trusted cadence may be held for at most 3.5 seconds across a brief missed step, then returns to \`--\` when the live rhythm is stale; the completed-run summary still retains its independent average cadence from valid samples.
- Ending a run freezes a local rules-based summary first. An available \`LanguageModel\` may upgrade the review in place; the local result remains when the model is unavailable, fails or times out.
- \`app.json\` requests no location permission. The runtime uses no GPS or route integration. Raw BLE packets and raw accelerometer or gyroscope axes are neither persisted nor uploaded.
- Network configuration must use HTTPS and the package contains no built-in service URL or key. Offline operation remains the default-safe path.

## Pages

- \`pages/run_hud/index\`: First and default 480x352 immersive route for the menu, explicit BLE scan, warm-up, running HUD, recovery, summary and settings.
- \`pages/index/index\`: Second 448x150 compatibility entry. It never starts Bluetooth automatically.

Both pages keep title-only metadata. Canvas size, focus, keys, BLE lifecycle and exit behavior still require verification on the target AIUI host.

## Evidence Boundary

- Historical segmented device evidence shows valid standard Garmin HRS notifications.
- A complete Rokid Glasses loop on the current build and sustained Garmin Virtual Run RSC remain real-device release gates. The enhanced RSC path must not be described as fully verified until those gates pass.

## Build Boundary

- Use the \`@yodaos-pkg/aix-cli\`-compatible packaging chain. \`VERSION\` is an independent UUID for each package, not the product semantic version.
- CN, EN and JA packages are produced from one source tree and checked independently for Reader output, UUID, provenance and the 2 MB limit.
- Generated \`.aix\` files are local validation artifacts and are not committed to this source repository. Uploading to AIUI Studio, installing on glasses or submitting to a store requires separate authorization.
`;

function fail(message) {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.rmSync(TMP, { force: true });
  console.error(message);
  process.exit(1);
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

function rel(...parts) {
  return path.join(STAGE, ...parts);
}

function read(relPath) {
  return fs.readFileSync(rel(relPath), 'utf8');
}

function write(relPath, text) {
  fs.writeFileSync(rel(relPath), text);
}

function replaceText(relPath, pairs) {
  let text = read(relPath);
  for (const [from, to] of pairs) {
    text = text.split(from).join(to);
  }
  write(relPath, text);
}

function replaceRegex(relPath, pairs) {
  let text = read(relPath);
  for (const [from, to] of pairs) {
    text = text.replace(from, to);
  }
  write(relPath, text);
}

function listTextFiles(dir = STAGE) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTextFiles(abs));
    } else if (TEXT_FILE_RE.test(entry.name)) {
      files.push(abs);
    }
  }
  return files;
}

function prepareStage() {
  const orphanReferences = findOrphanLibReferences(ROOT);
  if (orphanReferences.length) {
    fail(`Excluded lib modules are referenced by shipped code; update ORPHAN_LIB_FILES first:\n${orphanReferences.join('\n')}`);
  }
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  for (const entry of SOURCE_ENTRIES) {
    const src = path.join(ROOT, entry);
    const dst = rel(entry);
    if (!fs.existsSync(src)) fail(`Missing package entry: ${entry}`);
    fs.cpSync(src, dst, { recursive: true });
  }
  for (const orphan of ORPHAN_LIB_FILES) {
    fs.rmSync(rel(orphan), { force: true });
  }
  normalizeStageLineEndings();
}

function normalizeStageLineEndings() {
  for (const abs of listTextFiles()) {
    const text = fs.readFileSync(abs, 'utf8');
    fs.writeFileSync(abs, text.replace(/\r\n/g, '\n'));
  }
}

function localizeMetadata() {
  write('AGENTS.md', EN_AGENTS);
  assertExactPermissions(EN_AGENTS, 'English AGENTS.md');
  const app = JSON.parse(read('app.json'));
  assertExactAppPermissions(app, 'English app.json');
  app.window = app.window || {};
  app.window.navigationBarTitleText = 'SmartRun';
  write('app.json', `${JSON.stringify(app, null, 2)}\n`);
  const pkg = JSON.parse(read('package.json'));
  pkg.description = EN_DESCRIPTION;
  write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
}

function localizeHome() {
  replaceText('pages/index/index.ink', [
    ['"navigationBarTitleText": "跑步教练"', '"navigationBarTitleText": "SmartRun"'],
    ['<text class="home-brand-name">跑步教练</text>', '<text class="home-brand-name">SmartRun</text>'],
    ["const LOCAL_MEMORY_LANGUAGE = 'zh-CN';", "const LOCAL_MEMORY_LANGUAGE = 'en-US';"],
    ["homeSlogan: '自由开跑，智能相伴'", "homeSlogan: 'Run Free. Run Smart.'"],
    ["enterText: '按确认键进入'", "enterText: 'Press Confirm to Enter'"],
    ["'原地小步慢跑，低冲击、易坚持'", "'Gentle steps in place. Low impact, easy to sustain.'"],
    ["'选择心率设备、节拍器与训练提示'", "'Choose HR device, metronome, and run cues'"],
    ["'自由开跑，智能相伴'", "'Run Free. Run Smart.'"],
    ["this.data.enterText !== '按确认键进入'", "this.data.enterText !== 'Press Confirm to Enter'"],
    ["this.setData({ enterText: '按确认键进入' });", "this.setData({ enterText: 'Press Confirm to Enter' });"],
    [".filter(Boolean).join('；');", ".filter(Boolean).join('; ');"],
    ["'你是眼镜端跑步教练,中文回答,不超过40个字,口语化,不用列表。'", "'You are a running coach on smart glasses. Reply in English, under 12 words, conversational, no lists.'"],
    ["'再按返回键退出'", "'Press Back again to exit'"],
    ["content: '你是眼镜端跑步教练。只描述给出的事实，可提示恢复或稳定节奏；'", "content: 'You are a running coach on smart glasses. Describe only supplied facts and suggest recovery or steady rhythm;'"] ,
    ["+ '不作医疗诊断，不承诺或建议提速，不猜测个人心率区间。'", "+ 'do not diagnose, promise or recommend speeding up, or guess personal heart-rate zones.'"],
    ["+ '中文回答，不超过40个字，不用列表或表情。'", "+ 'Reply in English within 12 words, without lists or emoji.'"],
  ]);
}

function localizeRunHud() {
  replaceText('pages/run_hud/index.ink', [
    ['"navigationBarTitleText": "跑步教练"', '"navigationBarTitleText": "SmartRun Run"'],
    ['<text class="feature-name">跑步教练</text>', '<text class="feature-name">SmartRun</text>'],
    ["const START_CUE = '开跑，呼吸放稳。';", "const START_CUE = 'Start easy, breathe.';"],
    ["const RUN_STABILIZE_HINT = '请稳定跑约 5 秒';", "const RUN_STABILIZE_HINT = 'Run steady ~5 sec';"],
    ["const SUMMARY_EXIT_COPY = '按返回键结束并关闭智能体';", "const SUMMARY_EXIT_COPY = 'Press Back to End and Close Agent';"],
    ["motionSourceHint: '眼镜估算'", "motionSourceHint: 'Glasses est.'"],
    ["const motionSourceHint = '眼镜估算';", "const motionSourceHint = 'Glasses est.';"],
    ["'眼镜估算'", "'Glasses est.'"],
    ["'正在搜索心率设备...'", "'Searching for HR devices...'"],
    ["'还没有开始搜索'", "'Search Has Not Started'"],
    ["'单击“下一步”使用眼镜估算'", "'Tap Next to Use Glasses Estimate'"],
    ["'蓝牙能力检测无响应'", "'Bluetooth check timed out'"],
    ["'当前无法搜索蓝牙设备'", "'Bluetooth Search Unavailable'"],
    ["'扫描接口无响应'", "'Scan timed out'"],
    ["'单击“下一步”继续'", "'Tap Next to Continue'"],
    ["'等待附近设备广播'", "'Waiting for Nearby Device Broadcasts'"],
    ["'已发现 ' + this.data.discoveredDeviceCount + ' 台设备'", "'Found ' + this.data.discoveredDeviceCount + ' devices'"],
    ["'已发现 ' + this.data.discoveredDeviceCount + ' 台'", "'Found ' + this.data.discoveredDeviceCount + ' devices'"],
    ["'已发现 ' + String(this.data.discoveredDeviceCount || 0) + ' 台'", "'Found ' + String(this.data.discoveredDeviceCount || 0) + ' devices'"],
    ["'扫描发生异常'", "'Scan error'"],
    ["scanKeyGuide: '前后划选择 · 单击执行'", "scanKeyGuide: 'Swipe to Select · Tap to Confirm'"],
    ["'前后划选择 · 单击确认 · 返回键回首页'", "'Swipe to Select · Tap to Confirm · Back to Home'"],
    ["'前后划选择 · 单击确认 · 返回键退出'", "'Swipe to Select · Tap to Confirm · Back to Exit'"],
    ["'返回键回首页 · 双击退出智能体'", "'Back to Home · Double-tap to Exit'"],
    ["'返回键退出 · 双击退出智能体'", "'Back to Exit · Double-tap to Exit'"],
    ["'正在恢复上次记录 · 请重试'", "'Restoring Previous Run · Retry'"],
    ["scanProgressText: '等待操作'", "scanProgressText: 'Waiting'"],
    ["scanProgressText: '已发现 0 台'", "scanProgressText: '0 devices found'"],
    ["return '准备';", "return 'Ready';"],
    ["'能力无响应'", "'Check timeout'"],
    ["'搜索中'", "'Searching'"],
    ["'启动中'", "'Starting'"],
    ["'搜索失败'", "'Search failed'"],
    ["'0 台'", "'0 found'"],
    ["'未搜索'", "'Not Searched'"],
    ["'正在读取绑定状态'", "'Reading Pairing Status'"],
    ["'身份只保存在本机与 SmartRun 服务器'", "'Identity stays on this device and the SmartRun server'"],
    ["'智能体已绑定'", "'AIUI Agent Paired'"],
    ["'尚未绑定智能体'", "'AIUI Agent Not Paired'"],
    ["' · 本地身份已保存'", "' · Identity saved locally'"],
    ["'可在已登录 APK 输入此 ID 绑定'", "'Enter this ID in the signed-in APK to pair'"],
    ["'本地身份凭据已失效'", "'Local Identity Credentials Expired'"],
    ["'确认后创建新的匿名身份；旧身份不会被接管'", "'Confirm to create a new anonymous identity; the old identity stays private'"],
    ["'确认重建本地身份'", "'Confirm Identity Reset'"],
    ["'本地存储暂不可用'", "'Local Storage Unavailable'"],
    ["'无法安全保存设备身份，请稍后重试'", "'Cannot safely save device identity. Try again later'"],
    ["'安全身份尚未建立'", "'Secure Identity Not Ready'"],
    ["'身份保存尚未完成'", "'Identity Save Incomplete'"],
    ["'服务器身份缓存未完成'", "'Server Identity Cache Incomplete'"],
    ["'服务器长期凭据尚未就绪，请联网后重试'", "'Long-lived server credential is not ready. Reconnect and retry'"],
    ["'ID 与安全凭据未完整写入，请重新同步'", "'ID and credentials were not fully saved. Sync again'"],
    ["'设备身份未完整提交，请重新同步'", "'Device identity was not fully saved. Sync again'"],
    ["'待重试'", "'Retry Needed'"],
    ["'正在等待服务器分配'", "'Waiting for Server Assignment'"],
    ["'本地身份已准备，联网后会自动继续'", "'Local identity is ready and will continue when online'"],
    ["'服务器连接超时'", "'Server Connection Timed Out'"],
    ["'请确认手机联网且眼镜已连接 Rokid App'", "'Check phone internet and the Rokid App connection'"],
    ["'连接超时'", "'Timed Out'"],
    ["'请求域名未放行'", "'Request Domain Not Allowed'"],
    ["'请检查 AIUI 开发后台的请求域名配置'", "'Check the AIUI request-domain configuration'"],
    ["'域名配置'", "'Domain Setup'"],
    ["'无法连接 SmartRun 服务器'", "'Cannot Reach SmartRun Server'"],
    ["'请检查手机网络与 Rokid App 连接'", "'Check phone internet and the Rokid App connection'"],
    ["'网络异常'", "'Network Error'"],
    ["'服务器暂时拒绝请求'", "'Server Rejected the Request'"],
    ["'本地记录安全保留，请稍后重试'", "'Local records are safe. Try again later'"],
    ["'服务异常'", "'Server Error'"],
    ["'服务器响应无法识别'", "'Unrecognized Server Response'"],
    ["'请更新 AIX 或稍后重试'", "'Update the AIX or try again later'"],
    ["'响应异常'", "'Response Error'"],
    ["'服务器暂不可用'", "'Server Unavailable'"],
    ["'本地设置与跑步记录仍可正常使用'", "'Local settings and run records remain available'"],
    ["'本地设置与跑步记录不会丢失'", "'Local settings and run records are safe'"],
    ["'长期设备凭据获取失败'", "'Long-lived Device Credential Failed'"],
    ["'正在建立设备身份'", "'Creating Device Identity'"],
    ["'服务器长期凭据会安全缓存并持续复用'", "'The long-lived server credential is cached and reused securely'"],
    ["todayWorkoutDetail: '需要联网确认，请重试'", "todayWorkoutDetail: 'Online confirmation required. Retry'"],
    ["'需要联网确认，请重试'", "'Online confirmation required. Retry'"],
    ["todayWorkoutDetail: '训练状态待确认，请重试'", "todayWorkoutDetail: 'Training status needs confirmation. Retry'"],
    ["todayWorkoutDetail: '正在确认训练安全…'", "todayWorkoutDetail: 'Checking training safety...'"],
    ["'身份状态已变化，请重试'", "'Identity changed. Retry'"],
    ["'训练校验失败，请重试'", "'Training check failed. Retry'"],
    ["'今日训练暂不可开始'", "'Today Training is not ready'"],
    ["'训练状态已更新，请重试'", "'Training status changed. Retry'"],
    ["todayWorkoutDetail: '训练已更新，请再次确认'", "todayWorkoutDetail: 'Training updated. Confirm again'"],
    ["'注册重试'", "'Registration Retry'"],
    ["'刷新状态'", "'Refresh Status'"],
    ["'导出现场日志'", "'Export Field Log'"],
    ["'暂无可导出的跑步日志'", "'No Run Log Available'"],
    ["'完成一次跑步并保存总结后再导出'", "'Complete a Run and Save Its Summary First'"],
    ["'无日志'", "'No Log'"],
    ["'暂无现场日志'", "'No Field Log'"],
    ["'正在导出现场日志'", "'Exporting Field Log'"],
    ["'请保持电脑 ADB 实时抓取，看到 END 即完成'", "'Keep ADB Capture Running Until END'"],
    ["'导出中'", "'Exporting'"],
    ["bindingExportLabel: '正在导出'", "bindingExportLabel: 'Exporting'"],
    ["'现场日志导出完成'", "'Field Log Export Complete'"],
    ["'电脑看到 END 后即可停止抓取并运行提取命令'", "'END Sent · Stop Capture and Run Extractor'"],
    ["'已导出'", "'Exported'"],
    ["'再次导出'", "'Export Again'"],
    ["'现场日志暂时无法导出'", "'Field Log Export Unavailable'"],
    ["'本地记录仍保留，请稍后重试'", "'Local Log Kept · Try Again Later'"],
    ["'导出失败'", "'Export Failed'"],
    ["'重试导出'", "'Retry Export'"],
    ["'现场日志导出已暂停'", "'Field Log Export Paused'"],
    ["'回到页面后请重新导出，本地记录不会丢失'", "'Return and Export Again · Local Log Is Safe'"],
    ["bindingChip: '已暂停'", "bindingChip: 'Paused'"],
    ["bindingExportLabel: '重新导出'", "bindingExportLabel: 'Export Again'"],
    ["'待分配'", "'Pending'"],
    ["'待联网'", "'Pending'"],
    ["'未绑定'", "'Not Paired'"],
    ["'已绑定'", "'Paired'"],
    ["'需恢复'", "'Recovery Needed'"],
    ["'存储异常'", "'Storage Error'"],
    ["'读取中'", "'Reading'"],
    ["'正在刷新'", "'Refreshing'"],
    ["'离线'", "'Offline'"],
    ["'未就绪'", "'Not Ready'"],
    ["'重试'", "'Retry'"],
    ["'已连接心率设备'", "'HR Device Connected'"],
    ["'已连接'", "'Connected'"],
    ["'首选'", "'Preferred'"],
    ["'已发现'", "'Found'"],
    ["'点按连接'", "'Tap to link'"],
    ["'验证中'", "'Checking'"],
    ["'正在验证心率设备 ' +", "'Checking HR devices ' +"],
    ["'正在验证心率设备'", "'Checking HR devices'"],
    ["'你是眼镜端跑步教练,中文回答,不超过40个字,口语化,不用列表。'", "'You are a running coach on smart glasses. Reply in English, under 12 words, conversational, no lists.'"],
    ["content: '你是眼镜端跑步教练。只描述给出的事实，可提示恢复或稳定节奏；'", "content: 'You are a running coach on smart glasses. Describe only supplied facts and suggest recovery or steady rhythm;'"] ,
    ["+ '不作医疗诊断，不承诺或建议提速，不猜测个人心率区间。'", "+ 'do not diagnose, promise or recommend speeding up, or guess personal heart-rate zones.'"],
    ["+ '中文回答，不超过40个字，不用列表或表情。'", "+ 'Reply in English within 12 words, without lists or emoji.'"],
    ["'再按2次结束'", "'Press 2 More Times to End'"],
    ["'再按1次结束'", "'Press 1 More Time to End'"],
    ["'请按确认键3次结束'", "'Press Confirm 3 Times to End'"],
    ["'再按确认结束'", "'Press Confirm Again to End'"],
    ["'扫描已停止 · 确认键结束'", "'Scan stopped · Confirm to end'"],
    ["'确认键结束'", "'Confirm to end'"],
    ['compactRunSummaryText(text, 44)', 'compactRunSummaryText(text, 84)'],
    ["'时间较短，下次再战！'", "'Short run - go again!'"],
    ["'AI 教练正在总结中…'", "'AI coach summarizing…'"],
    ["'总结中'", "'Summarizing'"],
    ["'本地总结'", "'Local summary'"],
    ["'AI 点评'", "'AI review'"],
    ["'Hermes 点评'", "'Hermes review'"],
    ["'本地点评'", "'Local review'"],
    ["'日志整理中'", "'Organizing log'"],
    ["'日志已保存 · 待补传'", "'Log saved · Upload pending'"],
    ["'日志已保存 · 上传中'", "'Log saved · Uploading'"],
    ["'日志已保存 · 部分需诊断'", "'Log saved · Some need review'"],
    ["'Hermes 已同步'", "'Hermes synced'"],
    [
      "summaryUploadText = 'Hermes 已上传 · ' + String(receipt.ackedCount) + '条';",
      "summaryUploadText = 'Hermes uploaded · ' + String(receipt.ackedCount);",
    ],
    ["'日志保存失败 · 请重试'", "'Log save failed · Retry'"],
    ["'日志保存中 · 正在重试'", "'Saving log · Retrying'"],
    ["'正在保存，请稍候'", "'Saving, please wait'"],
    ["'保存失败，请再按返回重试'", "'Save failed. Press Back to retry'"],
    ["searchText: '训练记录读取失败'", "searchText: 'Training record read failed'"],
    ["recoveryAutoHint: '训练记录读取失败 · 请再次确认'", "recoveryAutoHint: 'Training record unavailable · Confirm to retry'"],
    ["recoveryActionLabel: '重试开跑'", "recoveryActionLabel: 'Retry Start'"],
    ["searchChip: '请重试'", "searchChip: 'Retry'"],
    ["scanDiagnostic: '本地存储暂不可用 · 再按下一步重试'", "scanDiagnostic: 'Local storage unavailable · Tap Next to retry'"],
    ["scanProgressText: '未开始'", "scanProgressText: 'Not started'"],
    ["String(this.activeWorkoutPlan.title || '今日训练')", "String(this.activeWorkoutPlan.title || 'Today Training')"],
    ["'平均心率'", "'Avg HR'"],
    ["'平均步频'", "'Avg cadence'"],
    ['<text class="summary-title">跑步结束</text>', '<text class="summary-title">Run Complete</text>'],
    ['<text class="summary-label">公里</text>', '<text class="summary-label">km</text>'],
    ['<text class="summary-label">用时</text>', '<text class="summary-label">Time</text>'],
    ['<text class="summary-label">配速</text>', '<text class="summary-label">Pace</text>'],
    ["summaryExitText: '按返回键结束并关闭智能体'", "summaryExitText: 'Press Back to End and Close Agent'"],
    ["this.data.summaryExitText !== '按返回键结束并关闭智能体'", "this.data.summaryExitText !== 'Press Back to End and Close Agent'"],
    ["this.setData({ summaryExitText: '按返回键结束并关闭智能体' });", "this.setData({ summaryExitText: 'Press Back to End and Close Agent' });"],
    ["'再按确认键退出'", "'Press Confirm Again to Exit'"],
    ["'非心率'", "'Not HR'"],
    ["'连接中'", "'Linking'"],
    ["'可重试'", "'Retry'"],
    ["'已断开'", "'Offline'"],
    ["'自动重连中'", "'Auto reconnecting'"],
    ["modeLabel: '眼镜模式'", "modeLabel: 'Glasses mode'"],
    ["sourceMain: '眼镜估算'", "sourceMain: 'Glasses est.'"],
    ["coachLine: '准备开跑'", "coachLine: 'Ready to run'"],
    ["this.setData({ paused: true, coachLine: '已暂停' });", "this.setData({ paused: true, coachLine: 'Paused' });"],
    ["coachLine: '眼镜计时中'", "coachLine: 'Timing only'"],
    ["? '眼镜传感器恢复中' : '眼镜计时中'", "? 'Glasses sensors recovering' : 'Timing only'"],
    ["'估算区间'", "'Est. zone'"],
    ["'心率记录'", "'HR data'"],
    ["modeLabel: connected ? liveLabel : '心率已连'", "modeLabel: connected ? liveLabel : 'HR linked'"],
    ["'心率设备'", "'HR device'"],
    ["sourceMain: '心率+眼镜'", "sourceMain: 'HR+glasses'"],
    ["? '估算区间'", "? 'Est. zone'"],
    [": (policyConfidence === 'trusted' ? '心率接入' : '心率记录')", ": (policyConfidence === 'trusted' ? 'Heart Rate' : 'HR data')"],
    ["connected ? liveLabel : '心率已连'", "connected ? liveLabel : 'HR linked'"],
    ["sourceMain: '仅计时'", "sourceMain: 'Timing only'"],
    ["coachLine: '找心率设备'", "coachLine: 'Finding HR'"],
    ["coachLine: '用眼镜估算距离'", "coachLine: 'Using glasses'"],
    ["coachLine: '心率已连接'", "coachLine: 'HR linked'"],
    ["'匹配心率设备'", "'Matching HR'"],
    ["'未找到首选心率'", "'Preferred HR missing'"],
    ["'未找到心率设备'", "'No HR device found'"],
    ["'未发现附近设备'", "'No nearby devices'"],
    ["'未发现心率广播'", "'No HR broadcasts'"],
    ["'未验证到心率设备'", "'No verified HR device'"],
    ["'心率扫描失败'", "'HR scan failed'"],
    ["'正在连接心率设备'", "'Connecting HR Device'"],
    ["'等待心率数据'", "'Waiting for HR'"],
    ["'跑速已接入 · 等待心率'", "'Run speed live · Waiting for HR'"],
    ["'心率数据已接入'", "'HR data live'"],
    ["'心率无数据'", "'No HR data'"],
    ["'心率数据异常'", "'Invalid HR data'"],
    ["'心率连接失败'", "'HR link failed'"],
    ['<text class="metric-label">心率</text>', '<text class="metric-label">HR</text>'],
    ['<text class="metric-label">配速</text>', '<text class="metric-label">Pace</text>'],
    ['<text class="metric-label">步频</text>', '<text class="metric-label">Cad.</text>'],
    ['<text class="metric-label">距离</text>', '<text class="metric-label">Dist.</text>'],
    ['<text class="metric-label">时长</text>', '<text class="metric-label">Time</text>'],
    ["paused ? '已暂停' : '节奏很好，保持'", "paused ? 'Paused' : 'Good rhythm'"],
    ['<text class="connect-title">准备开跑</text>', '<text class="connect-title">Get Ready</text>'],
    ['<text class="device-list-title">全量扫描</text>', '<text class="device-list-title">All-device Scan</text>'],
    ['<text class="title">准备开跑</text>', '<text class="title">Get Ready</text>'],
    ['<text class="card-kicker">心率设备</text>', '<text class="card-kicker">HR Device</text>'],
    ['<text class="card-kicker">设备列表</text>', '<text class="card-kicker">Device List</text>'],
    ['>开始搜索</button>', '>Start Scan</button>'],
    ["'单击开始搜索心率设备'", "'Tap to Search for HR Devices'"],
    ["'原地小步 · 轻落地 · 保持轻松呼吸'", "'Jog in place · Land softly · Breathe easy'"],
    ["'超慢跑将由眼镜估算步频与步数'", "'Glasses estimate Slow Jog cadence and steps'"],
    ["'心率已连接 · 超慢跑准备就绪'", "'HR linked · Slow Jog ready'"],
    ["'可连接心率设备，也可直接下一步'", "'Link HR or continue directly'"],
    ["'超慢跑'", "'Slow Jog'"],
    ["'Garmin 手表请选择 Virtual Run 并按 START'", "'On Garmin, select Virtual Run and press START'"],
    ["'Garmin 数据优先 · 无设备时用眼镜估算'", "'Garmin data first · Glasses estimate without a device'"],
    ["'等待手表广播跑步数据'", "'Waiting for watch running data'"],
    ["'心率搜索已关闭，无法接收手表数据'", "'HR search is off; watch data is unavailable'"],
    ["'可继续使用眼镜估算，或先在设置中开启心率搜索'", "'Use glasses estimate or enable HR search in Settings'"],
    ["'正在搜索室内跑设备...'", "'Searching for Indoor Run devices...'"],
    ["'正在连接室内跑设备'", "'Connecting Indoor Run device'"],
    ["'心率已连接 · 等待室内跑数据'", "'HR linked · Waiting for Indoor Run data'"],
    ["'室内跑配速与步频已接入'", "'Indoor Run pace and cadence live'"],
    ["'室内跑数据在线 · 等待起跑'", "'Indoor Run data online · Waiting to run'"],
    ["'室内跑'", "'Indoor Run'"],
    ["'数据在线'", "'Data Online'"],
    ["'配速接入'", "'Pace Live'"],
    ["'心率接入'", "'Heart Rate'"],
    ["&& zone >= 5 ? '心率 Z5 · 请降速' : '心率偏高 · 请降速'", "&& zone >= 5 ? 'HR Z5 · Slow Down' : 'HR High · Slow Down'"],
    ["'原地小步，稳定约 5 秒'", "'Jog steadily in place for about 5 seconds'"],
    ["'超慢跑开始。原地小步，轻落地，保持轻松呼吸。'", "'Slow Jog started. Use short steps, land softly, and breathe easy.'"],
    ["'节奏稳定 · 保持轻松呼吸'", "'Steady rhythm · Keep breathing easy'"],
    ["'放小步幅 · 逐步接近 180'", "'Shorten steps · Ease toward 180'"],
    ["'保持轻松 · 不必追求更快'", "'Stay relaxed · No need to go faster'"],
    ["'目标完成 · 可三按确认结束'", "'Goal complete · Press Confirm 3 Times to End'"],
    ["todayWorkoutTitle: '今日训练'", "todayWorkoutTitle: 'Today Training'"],
    ["String(workoutPlan.title || '今日训练')", "String(workoutPlan.title || 'Today Training')"],
    ["+ '分钟'", "+ ' min'"],
    ["+ '公里'", "+ ' km'"],
    ["+ '米'", "+ ' m'"],
    ["+ '阶段'", "+ ' stages'"],
    ["'心率设备已关闭'", "'HR Device Off'"],
    ["'可在设置中重新开启心率设备'", "'Turn HR back on in Settings'"],
    ["return '配速偏快';", "return 'Pace Too Fast';"],
    ["return '配速偏慢';", "return 'Pace Too Slow';"],
    ["return '配速合适';", "return 'Pace on Target';"],
    ["return '心率偏低';", "return 'HR Below Target';"],
    ["return '心率偏高';", "return 'HR Above Target';"],
    ["return '心率过高 · 请降速';", "return 'HR Too High · Slow Down';"],
    ["return '心率偏高 · 请降速';", "return 'HR High · Slow Down';"],
    ["return '强度合适';", "return 'Effort on Target';"],
    ["return '步频偏低';", "return 'Cadence Below Target';"],
    ["return '步频偏高';", "return 'Cadence Above Target';"],
    ["return '节奏合适';", "return 'Rhythm on Target';"],
    ["progress.stageTitle || '训练'", "progress.stageTitle || 'Training'"],
    ["? '已完成'", "? 'Complete'"],
    ["fields.hudHint = '训练完成 · 三按确认结束';", "fields.hudHint = 'Training complete · Press Confirm 3 Times to End';"],
    ["this.playCueTts('进入' + String(next.stageTitle))", "this.playCueTts('Start ' + String(next.stageTitle))"],
    ["'搜索失败，可使用眼镜估算'", "'Search failed; use glasses estimate'"],
    ["'心率重连中'", "'HR reconnecting'"],
    ["primaryLabel: '开始搜索'", "primaryLabel: 'Start Scan'"],
    ["primaryLabel: '下一步'", "primaryLabel: 'Next'"],
    ["primaryLabel !== '下一步'", "primaryLabel !== 'Next'"],
    ["+ '台/'", "+ ' dev/'"],
    ["+ this.rawAdvertisementCount + '次',", "+ this.rawAdvertisementCount + ' adv',"],
    ["'设备已不在附近'", "'Device out of range'"],
    ["'点按设备重试'", "'Tap a device to retry'"],
    ['>等待确认</text>', '>Waiting</text>'],
    ['>连接中</text>', '>Connecting</text>'],
    ['<text class="connect-device-label">眼镜</text>', '<text class="connect-device-label">GLS</text>'],
    ['<text class="connect-main">连接心率</text>', '<text class="connect-main">Connect Heart Rate</text>'],
    ['<text class="connect-sub">再次按确认键开始</text>', '<text class="connect-sub">Press Enter Again to Start</text>'],
    ['<text class="connect-main">正在连接心率设备</text>', '<text class="connect-main">Connecting HR Device</text>'],
    ['<text class="connect-sub">正在匹配已记住的设备</text>', '<text class="connect-sub">Matching the remembered device</text>'],
    ['<text class="mode-chip" ink:if="{{ showHeartRate }}">{{ modeLabel }}</text>', '<text class="mode-chip" ink:if="{{ showHeartRate }}">{{ modeLabel }}</text>'],
    ['<text class="mode-chip" ink:if="{{ !runWarmupHint && paceConnected }}">配速接入</text>', '<text class="mode-chip" ink:if="{{ !runWarmupHint && paceConnected }}">Pace Live</text>'],
    ["sumMetricOneLabel: '公里'", "sumMetricOneLabel: 'km'"],
    ["sumMetricTwoLabel: '用时'", "sumMetricTwoLabel: 'Time'"],
    ["sumMetricThreeLabel: '配速'", "sumMetricThreeLabel: 'Pace'"],
    ["summaryChartTitle: '每分钟配速'", "summaryChartTitle: 'Pace by Minute'"],
    ["summaryChartUnit: '分/公里'", "summaryChartUnit: 'sec/km'"],
    ["summaryChartUnit: '秒/公里'", "summaryChartUnit: 'sec/km'"],
    ["slowTargetText: '目标 20 分钟'", "slowTargetText: 'Goal: 20 min'"],
    ["slowMetronomeUnit: 'BPM · 已开启'", "slowMetronomeUnit: 'BPM · On'"],
    ["slowCoachLine: '原地小步 · 轻落地 · 保持轻松呼吸'", "slowCoachLine: 'Jog in place · Land softly · Breathe easy'"],
    ["settingTarget: '20 分钟'", "settingTarget: '20 min'"],
    ["settingHeartRate: '开'", "settingHeartRate: 'On'"],
    ["settingVoiceCue: '开'", "settingVoiceCue: 'On'"],
    ["settingMetronome: '关闭'", "settingMetronome: 'Off'"],
    ["settingGuideQuickExit: '关'", "settingGuideQuickExit: 'Off'"],
    ["settingsSaveState: '已保存'", "settingsSaveState: 'Saved'"],
    ["settingsSaveState: this.settingsStored ? '已保存' : '仅本次'", "settingsSaveState: this.settingsStored ? 'Saved' : 'This Session'"],
    ["patch.settingsSaveState = this.settingsStored ? '已保存' : '仅本次'", "patch.settingsSaveState = this.settingsStored ? 'Saved' : 'This Session'"],
    ["settingsSaveState: '节拍器已关闭'", "settingsSaveState: 'Metronome Off'"],
    ["settingsSaveState: '暂时无法播放'", "settingsSaveState: 'Audio Unavailable'"],
    ["settingsSaveState: '正在试听 ' + bpm + ' BPM'", "settingsSaveState: 'Previewing ' + bpm + ' BPM'"],
    ["'快速结束已开启 · 指导静音'", "'Quick exit on · Guide muted'"],
    ["? '目标 ' + formatSlowJogTarget(settings.slowJogTargetMin)", "? 'Goal: ' + formatSlowJogTarget(settings.slowJogTargetMin)"],
    ["slowMetronomeUnit: bpm > 0 ? 'BPM · 已开启' : '自由节奏'", "slowMetronomeUnit: bpm > 0 ? 'BPM · On' : 'Free rhythm'"],
    ["searchText: '心率设备已关闭'", "searchText: 'HR Device Off'"],
    ["searchChip: '纯眼镜模式'", "searchChip: 'Glasses Only'"],
    ["scanDiagnostic: '可在设置中重新开启心率设备'", "scanDiagnostic: 'Turn HR back on in Settings'"],
    ["scanProgressText: '已关闭'", "scanProgressText: 'Off'"],
    [": '小步幅 · 轻落地 · 保持呼吸';", ": 'Short steps · Land softly · Breathe';"],
    ["summaryChartTitle: slow ? '每分钟步频' : '每分钟配速'", "summaryChartTitle: slow ? 'Cadence by Minute' : 'Pace by Minute'"],
    ["summaryChartUnit: slow ? '步/分钟' : '秒/公里'", "summaryChartUnit: slow ? 'steps/min' : 'sec/km'"],
    ["sumMetricOneLabel: slow ? '步数' : '公里'", "sumMetricOneLabel: slow ? 'Steps' : 'km'"],
    ["sumMetricTwoLabel: '用时'", "sumMetricTwoLabel: 'Time'"],
    ["sumMetricThreeLabel: slow ? '平均步频' : '配速'", "sumMetricThreeLabel: slow ? 'Avg cadence' : 'Pace'"],
    ["sumMetricFourLabel: slow ? '平均心率' : '平均步频'", "sumMetricFourLabel: slow ? 'Avg HR' : 'Avg cadence'"],
    ['<text class="feature-chip">选择功能</text>', '<text class="feature-chip">Choose an Option</text>'],
    ['<text class="feature-slogan">前后划选择 · 单击确认 · 返回键回首页</text>', '<text class="feature-slogan">Swipe to Select · Tap to Confirm · Back to Home</text>'],
    ['<text class="feature-main-title">自由跑</text>', '<text class="feature-main-title">Free Run</text>'],
    ['<text class="feature-main-sub">户外跑 · 设备配速与眼镜估算</text>', '<text class="feature-main-sub">Outdoor · Device Pace or Glasses Estimate</text>'],
    ['<text class="feature-secondary-title">室内跑</text>', '<text class="feature-secondary-title">Indoor Run</text>'],
    ['<text class="feature-secondary-sub">跑步机模式 · 接收手表配速与步频</text>', '<text class="feature-secondary-sub">Treadmill · Watch Pace and Cadence</text>'],
    ['<text class="feature-secondary-sub">Garmin 优先 · 无设备用眼镜估算</text>', '<text class="feature-secondary-sub">Garmin First · Glasses Fallback</text>'],
    ['<text class="feature-secondary-title">超慢跑</text>', '<text class="feature-secondary-title">Slow Jog</text>'],
    ['<text class="feature-secondary-sub">原地小步 · 低冲击</text>', '<text class="feature-secondary-sub">In-place Steps · Low Impact</text>'],
    ['<text class="feature-secondary-title">训练计划</text>', '<text class="feature-secondary-title">Training Plans</text>'],
    ['<text class="feature-secondary-sub">LSD · 轻松 · 变速 · 间歇</text>', '<text class="feature-secondary-sub">LSD · Easy · Fartlek · Intervals</text>'],
    ['<text class="feature-secondary-title">设置</text>', '<text class="feature-secondary-title">Settings</text>'],
    ['<text class="feature-secondary-sub">设备 · 步长 · 提示</text>', '<text class="feature-secondary-sub">Devices · Stride · Cues</text>'],
    ['<text class="feature-secondary-sub">步长 · 节拍器 · 心率设备</text>', '<text class="feature-secondary-sub">Stride · Metronome · HR Device</text>'],
    ['<text class="slow-title">超慢跑</text>', '<text class="slow-title">Slow Jog</text>'],
    ['<text class="slow-guide-label">节拍器 · 经典机械</text>', '<text class="slow-guide-label">Metronome · Classic Mechanical</text>'],
    ['<text class="slow-guide-copy">小步幅 · 轻落地 · 保持呼吸</text>', '<text class="slow-guide-copy">Short steps · Land softly · Breathe</text>'],
    ['<button class="slow-start" bindtap="startSlowRun">按确认键开始</button>', '<button class="slow-start" bindtap="startSlowRun">Press Enter to Start</button>'],
    ['>按确认键开始</button>', '>Press Enter to Start</button>'],
    ['<text class="settings-title">跑步设置</text>', '<text class="settings-title">Run Settings</text>'],
    ['<text class="settings-chip">自动保存</text>', '<text class="settings-chip">Auto Save</text>'],
    ['<text class="setting-name">超慢跑目标</text>', '<text class="setting-name">Slow Jog Goal</text>'],
    ['<text class="setting-name">节拍器</text>', '<text class="setting-name">Metronome</text>'],
    ['<text class="setting-name">指导快速结束</text>', '<text class="setting-name">Quick Guide Exit</text>'],
    ['<text class="setting-name">估算步长</text>', '<text class="setting-name">Estimated Stride</text>'],
    ['<text class="setting-name">心率搜索</text>', '<text class="setting-name">HR Search</text>'],
    ['<text class="setting-name">语音提示</text>', '<text class="setting-name">Voice Cues</text>'],
    ['<text class="setting-name">长期记忆</text>', '<text class="setting-name">Long-term memory</text>'],
    ['<text class="setting-value">需配置后端</text>', '<text class="setting-value">Backend required</text>'],
    ['<text class="setting-name">智能体绑定</text>', '<text class="setting-name">AIUI Agent Pairing</text>'],
    ['bindfocus="onSettingFocus" bindtap="onSettingTap">返回</button>', 'bindfocus="onSettingFocus" bindtap="onSettingTap">Back</button>'],
    ['<text class="settings-foot">训练设置与设备身份均保存在本机</text>', '<text class="settings-foot">Training settings and device identity are saved locally</text>'],
    ['<text class="settings-foot">确认节拍器可试听 · 总结与记忆始终开启</text>', '<text class="settings-foot">Confirm previews beat · Review and memory stay on</text>'],
    ['<text class="settings-foot">{{ settingsSaveState }} · 前后划选择 · 单击调整</text>', '<text class="settings-foot">{{ settingsSaveState }} · Swipe to Select · Tap to Adjust</text>'],
    ['<text class="binding-title">智能体绑定</text>', '<text class="binding-title">AIUI Agent Pairing</text>'],
    ['<text class="binding-foot">前后划选择 · 单击执行 · 返回键回设置</text>', '<text class="binding-foot">Swipe to Select · Tap to Run · Back to Settings</text>'],
    ['<text class="summary-title">跑步总结</text>', '<text class="summary-title">Run Summary</text>'],
    ['<text class="slow-hud-name" ink:if="{{ runMode === \'slow\' }}">超慢跑</text>', '<text class="slow-hud-name" ink:if="{{ runMode === \'slow\' }}">Slow Jog</text>'],
    ['<text class="mode-chip" ink:if="{{ runMode !== \'slow\' && showHeartRate }}">心率接入</text>', '<text class="mode-chip" ink:if="{{ runMode !== \'slow\' && showHeartRate }}">Heart Rate</text>'],
    ['<text class="slow-metric-label">步频</text>', '<text class="slow-metric-label">Cad.</text>'],
    ['<text class="slow-metric-label">时长</text>', '<text class="slow-metric-label">Time</text>'],
    ['<text class="slow-metric-label">步数</text>', '<text class="slow-metric-label">Steps</text>'],
    ['<text class="slow-metric-label">心率</text>', '<text class="slow-metric-label">HR</text>'],
    ['<text class="metric-label">步数</text>', '<text class="metric-label">Steps</text>'],
    ['<text class="training-title">选择训练</text>', '<text class="training-title">Choose Training</text>'],
    ['<text class="training-chip">按时间完成 · 强度仅作提示</text>', '<text class="training-chip">Time Based · Intensity Is Guidance</text>'],
    ['<text class="training-guide">前后划选择 · 单击确认 · 返回键回菜单</text>', '<text class="training-guide">Swipe to Select · Tap to Confirm · Back to Menu</text>'],
    ['<text class="training-option-title">轻松跑</text>', '<text class="training-option-title">Easy Run</text>'],
    ['<text class="training-option-sub">30 分钟 · 可完整交谈</text>', '<text class="training-option-sub">30 min · Full conversation</text>'],
    ['<text class="training-option-title">LSD 长距离跑</text>', '<text class="training-option-title">LSD Long Run</text>'],
    ['<text class="training-option-sub">50 分钟 · 低强度耐力</text>', '<text class="training-option-sub">50 min · Easy endurance</text>'],
    ['<text class="training-option-title">法特莱克跑</text>', '<text class="training-option-title">Fartlek Run</text>'],
    ['<text class="training-option-sub">31 分钟 · 6 组快慢交替</text>', '<text class="training-option-sub">31 min · 6 speed-play sets</text>'],
    ['<text class="training-option-title">间歇跑</text>', '<text class="training-option-title">Interval Run</text>'],
    ['<text class="training-option-sub">34 分钟 · 4 组跑休</text>', '<text class="training-option-sub">34 min · 4 work-rest sets</text>'],
    ['bindfocus="onTrainingFocus" bindtap="onTrainingTap">返回训练菜单</button>', 'bindfocus="onTrainingFocus" bindtap="onTrainingTap">Back to Training Menu</button>'],
    ["recoveryHeading: '放松'", "recoveryHeading: 'Recovery'"],
    ["recoveryTitle: '慢走放松'", "recoveryTitle: 'Gentle Walk'"],
    ["recoveryOverview: '4项 · 每项15秒 · 共1分钟'", "recoveryOverview: '4 exercises · 15 sec each · 1 min total'"],
    ["recoveryDuration: '15秒'", "recoveryDuration: '15 sec'"],
    ["recoveryInstruction: '慢走，手臂自然摆动'", "recoveryInstruction: 'Walk slowly, swing arms naturally'"],
    ["recoverySafety: '疼痛就停'", "recoverySafety: 'Stop if painful'"],
    ["recoveryCountdownUnit: '秒'", "recoveryCountdownUnit: 'sec'"],
    ["recoveryAutoHint: '15秒后自动切换'", "recoveryAutoHint: 'Auto-next after 15 sec'"],
    ["recoveryActionLabel: '下一步'", "recoveryActionLabel: 'Next'"],
    [": '已继续 · 15秒后自动切换'", ": 'Resumed · Auto-next after 15 sec'"],
    [": '15秒后自动切换'", ": 'Auto-next after 15 sec'"],
    ["recoveryCountdown: '完成'", "recoveryCountdown: 'Done'"],
    ["? '热身完成 · 正在开跑'", "? 'Warm-up done · Starting'"],
    [": '放松完成 · 请选择下一步'", ": 'Recovery done · Choose Next'"],
    ["recoveryActionLabel: preRun ? '正在开跑' : '查看跑步总结'", "recoveryActionLabel: preRun ? 'Starting' : 'View Run Summary'"],
    ["? (this.timedGuideKind === 'pre_run' ? '跳过热身' : '快速完成')", "? (this.timedGuideKind === 'pre_run' ? 'Skip Warm-up' : 'Quick Finish')"],
    [">查看跑步总结</button>", ">View Run Summary</button>"],
    [">结束退出</button>", ">End and Exit</button>"],
    ["? '已继续 · 倒计时结束自动开跑'", "? 'Resumed · Auto-start at zero'"],
    ["? '倒计时结束自动开跑'", "? 'Auto-start at zero'"],
    ["recoveryHeading: '跑前热身'", "recoveryHeading: 'Pre-run Warm-up'"],
    ["recoveryHeading: '放松'", "recoveryHeading: 'Recovery'"],
    ["'设备配置已保留 · 再按下一步进入热身'", "'Device setup saved · Press Next again for warm-up'"],
    ["'配置已保留'", "'Setup saved'"],
    ["slow ? 'Avg cadence' : '配速'", "slow ? 'Avg cadence' : 'Pace'"],
  ]);
}

function localizeLibraries() {
  replaceText('lib/run_summary.js', [
    ["'本次跑步总结'", "'Run summary'"],
    ['maxChars = 40', 'maxChars = 76'],
    ["'距离 ' + formatDistanceKm(summary.distanceM) + ' 公里'", "'Distance ' + formatDistanceKm(summary.distanceM) + ' km'"],
    ["'用时 ' + formatElapsed(summary.elapsedMs)", "'Time ' + formatElapsed(summary.elapsedMs)"],
    ["'平均配速 ' + formatPace(summary.avgPaceSecPerKm)", "'Avg pace ' + formatPace(summary.avgPaceSecPerKm)"],
    ["'平均心率 ' + Math.round(summary.avgBpm)", "'Avg HR ' + Math.round(summary.avgBpm)"],
    ["'(最高 ' + Math.round(summary.maxBpm) + ')'", "' (max ' + Math.round(summary.maxBpm) + ')'"],
    ["'平均步频 ' + Math.round(summary.avgCadenceSpm)", "'Avg cadence ' + Math.round(summary.avgCadenceSpm)"],
    ["parts.join('，')", "parts.join(', ')"],
    ["'请用不超过 ' + RUN_SUMMARY_MAX_CHARS + ' 个字的中文总结这次跑步,'", "'Summarize this run in English within 12 words,'"],
    ["'先说状态再给一句鼓励或建议,口语化,不用列表、不用表情。\\n'", "'state first then one encouragement or tip, conversational, no lists or emoji.\\n'"],
    ["'本次数据:' + stats", "'Data: ' + stats"],
    ["'\\n跑者历史:' + memory", "'\\nRunner history: ' + memory"],
    ["'本次跑步 ' + formatDistanceKm(summary.distanceM) + ' 公里，用时 '", "'You ran ' + formatDistanceKm(summary.distanceM) + ' km in '"],
    ["+ formatElapsed(summary.elapsedMs) + '。'", "+ formatElapsed(summary.elapsedMs) + '. '"],
    ["'强度偏高，注意恢复。'", "'Intensity was high, mind your recovery. '"],
    ["'强度扎实，练得不错。'", "'Solid intensity, good work. '"],
    ["'强度适中，节奏稳。'", "'Moderate intensity, steady rhythm. '"],
    ["'节奏保持得不错。'", "'Nice steady rhythm. '"],
    ["'继续加油！'", "'Keep it up!'"],
    ["'超慢跑步数 ' + Math.round(summary.steps)", "'Slow-jog steps ' + Math.round(summary.steps)"],
    ["'本次超慢跑 ' + Math.round(summary.steps) + ' 步，用时 '", "'Slow jog: ' + Math.round(summary.steps) + ' steps in '"],
    ["'本次没有可用心率，不得猜测心率或个体强度。'", "'No usable heart rate; do not guess heart rate or individual intensity.'"],
    ["'本次心率字段异常，不得解释心率或个体强度。'", "'Heart-rate fields are invalid; do not interpret heart rate or individual intensity.'"],
    ["'本次没有可信个人最大心率，只能复述 BPM，不得评价强度合适或建议提速。'", "'No trusted personal maximum heart rate; repeat BPM only and do not judge intensity or suggest speeding up.'"],
    ["'本次心率达到保守高值，只能中性复述事实，不得给积极强度结论或建议提速。'", "'Heart rate reached a conservative high threshold; state facts neutrally and do not give positive intensity conclusions or suggest speeding up.'"],
    ["'最大心率来自用户明确设置或 Garmin 档案；仍不得作医疗诊断或建议提速。'", "'Maximum heart rate comes from explicit user settings or a Garmin profile; still do not diagnose or suggest speeding up.'"],
    ["+ '只描述给出的事实，可给恢复或稳定节奏提示，不用列表、不用表情。'", "+ 'describe only supplied facts and suggest recovery or steady rhythm, without lists or emoji.'"],
    ["+ '不得作医疗诊断，不得承诺或建议提速。\\n'", "+ 'Do not diagnose, promise or suggest speeding up.\\n'"],
    ["+ '心率规则:' + heartRateRule + '\\n'", "+ 'Heart-rate rule: ' + heartRateRule + '\\n'"],
    ["? '本次超慢跑' + Math.round(summary.steps) + '步，用时'", "? 'Slow jog: ' + Math.round(summary.steps) + ' steps in '"],
    [": '本次跑步' + formatDistanceKm(summary.distanceM) + '公里，用时'", ": 'Run: ' + formatDistanceKm(summary.distanceM) + ' km in '"],
    ["text += '平均心率' + Math.round(summary.avgBpm);", "text += ' Avg HR ' + Math.round(summary.avgBpm);"],
    ["text += (summary.avgBpm > 0 ? '，' : '') + '最高' + Math.round(summary.maxBpm);", "text += (summary.avgBpm > 0 ? ', ' : '') + 'max ' + Math.round(summary.maxBpm);"],
    ["text += '。';", "text += '.';"],
    ["copy: '注意补水和恢复。'", "copy: 'Hydrate and recover.'"],
    ["copy: '保持稳定节奏。'", "copy: 'Keep a steady rhythm.'"],
    ["copy: '完成本次训练。'", "copy: 'Training complete.'"],
  ]);
  replaceRegex('lib/run_summary.js', [
    [
      /const MODEL_TEXT_ALLOWED_RE = .*?;\n/,
      "const MODEL_TEXT_ALLOWED_RE = /^[A-Za-z0-9\\s,.!?:;%/+\\-()]+$/;\n",
    ],
    [
      /const MODEL_TEXT_UNSAFE_RE = .*?;\n/,
      "const MODEL_TEXT_UNSAFE_RE = /(https?:\\/\\/|www\\.|diagnos|disease|arrhythmia|hypertension|medication|treatment|doctor|speed up|sprint|guarantee|ignore.{0,8}(rule|instruction|prompt)|system prompt)/i;\n",
    ],
    [
      /const MODEL_TEXT_HEART_RATE_CLAIM_RE = .*?;\n/,
      "const MODEL_TEXT_HEART_RATE_CLAIM_RE = /(heart rate|pulse|bpm|z[1-5]|zone|intensity|aerobic|anaerobic|lactate|fat burn)/i;\n",
    ],
    [
      /const MODEL_INTENT_ALLOWLIST = Object\.freeze\(\[[\s\S]*?\n\]\);/,
      `const MODEL_INTENT_ALLOWLIST = Object.freeze([
  Object.freeze({
    id: 'recovery',
    pattern: /(hydrate|recover|rest|relax|stretch)/i,
    copy: 'Hydrate and recover.',
  }),
  Object.freeze({
    id: 'steady',
    pattern: /(steady|rhythm|cadence|pace|maintain)/i,
    copy: 'Keep a steady rhythm.',
  }),
  Object.freeze({
    id: 'complete',
    pattern: /(complete|finish|continue|good|great|well done)/i,
    copy: 'Training complete.',
  }),
]);`,
    ],
  ]);
  replaceText('lib/format.js', [
    ["export const PACE_PENDING = '正在计算';", "export const PACE_PENDING = 'Calculating';"],
  ]);
  replaceText('lib/settings.js', [
    ["return value ? '开' : '关';", "return value ? 'On' : 'Off';"],
    ["return target > 0 ? `${target} 分钟` : '不限时';", "return target > 0 ? `${target} min` : 'No limit';"],
    ["return bpm > 0 ? `${bpm} BPM` : '关闭';", "return bpm > 0 ? `${bpm} BPM` : 'Off';"],
  ]);

  replaceText('lib/training_presets.js', [
    ["'第' + repetition + '组·' + work.title", "'Set ' + repetition + ' · ' + work.title"],
    ["'第' + repetition + '组·' + recovery.title", "'Set ' + repetition + ' · ' + recovery.title"],
    ["title: '轻松跑'", "title: 'Easy Run'"],
    ["'热身慢走'", "'Warm-up Walk'"],
    ["'轻松跑·可完整交谈'", "'Easy Run · Full Conversation'"],
    ["'放松慢走'", "'Cool-down Walk'"],
    ["title: 'LSD长距离跑'", "title: 'LSD Long Run'"],
    ["'长距离慢跑·保持交谈'", "'Long Easy Run · Keep Talking'"],
    ["title: '法特莱克跑'", "title: 'Fartlek Run'"],
    ["'热身慢跑'", "'Warm-up Jog'"],
    ["'轻快跑·可说短句'", "'Brisk Run · Short Phrases'"],
    ["'轻松恢复·放慢呼吸'", "'Easy Recovery · Slow Breathing'"],
    ["title: '间歇跑'", "title: 'Interval Run'"],
    ["'较快跑·保持动作稳定'", "'Fast Run · Keep Form Stable'"],
    ["'慢跑恢复·恢复呼吸'", "'Recovery Jog · Regain Breath'"],
  ]);

  replaceText('lib/warmup_guide.js', [
    ["'4项 · 每项15秒 · 共1分钟'", "'4 exercises · 15 sec each · 1 min total'"],
    ["'跑前热身共四个动作，每个十五秒，合计一分钟。'", "'Pre-run warm-up has four exercises, fifteen seconds each, one minute total. '"],
    ["'热身完成，自动开始跑步。'", "'Warm-up complete. Starting automatically.'"],
    ["durationLabel: '15秒'", "durationLabel: '15 sec'"],
    ["title: '原地踏步'", "title: 'March in Place'"],
    ["instruction: '抬膝踏步，手臂前后摆'", "instruction: 'Lift knees and swing arms'"],
    ["safetyNote: '身体保持直立'", "safetyNote: 'Stay upright'"],
    ["ttsCue: '第一项，原地踏步，十五秒。'", "ttsCue: 'Exercise one, march in place, fifteen seconds.'"],
    ["title: '提踵激活'", "title: 'Calf Raises'"],
    ["instruction: '脚跟抬起，缓慢落下'", "instruction: 'Raise heels, lower slowly'"],
    ["safetyNote: '膝盖保持放松'", "safetyNote: 'Keep knees relaxed'"],
    ["ttsCue: '第二项，提踵激活，十五秒。'", "ttsCue: 'Exercise two, calf raises, fifteen seconds.'"],
    ["title: '后踢腿'", "title: 'Butt Kicks'"],
    ["instruction: '脚跟后收，左右交替'", "instruction: 'Bring heels back, alternate sides'"],
    ["safetyNote: '上身保持直立'", "safetyNote: 'Keep your torso upright'"],
    ["ttsCue: '第三项，后踢腿，左右交替十五秒。'", "ttsCue: 'Exercise three, alternate butt kicks for fifteen seconds.'"],
    ["title: '侧向移重心'", "title: 'Lateral Weight Shift'"],
    ["instruction: '屈膝侧移，左右换边'", "instruction: 'Bend knees, shift side to side'"],
    ["safetyNote: '膝盖对准脚尖'", "safetyNote: 'Keep knees aligned with toes'"],
    ["ttsCue: '第四项，侧向移重心，左右换边十五秒。'", "ttsCue: 'Exercise four, shift weight side to side for fifteen seconds.'"],
    ["? '立即开跑' : '下一步'", "? 'Start Now' : 'Next'"],
    ["'三。二。一。'", "'Three. Two. One.'"],
    ["'换边。'", "'Switch sides.'"],
  ]);

  replaceText('lib/recovery_guide.js', [
    ["'疼痛就停'", "'Stop if painful'"],
    ["'4项 · 每项15秒 · 共1分钟'", "'4 exercises · 15 sec each · 1 min total'"],
    ["'放松共四个动作，每个十五秒，合计一分钟。'", "'Recovery has four exercises, fifteen seconds each, one minute total. '"],
    ["'放松完成。请选择查看跑步总结，或结束退出。'", "'Recovery complete. Choose Run Summary or End and Exit.'"],
    ["title: '慢走放松'", "title: 'Gentle Walk'"],
    ["durationLabel: '15秒'", "durationLabel: '15 sec'"],
    ["instruction: '慢走，手臂自然摆动'", "instruction: 'Walk slowly, swing arms naturally'"],
    ["ttsCue: '第一项，慢走放松，十五秒。'", "ttsCue: 'Exercise one, gentle walk, fifteen seconds.'"],
    ["title: '小腿后侧'", "title: 'Calf'"],
    ["instruction: '后脚跟压地，左右换边'", "instruction: 'Heel down, switch sides'"],
    ["ttsCue: '第二项，小腿后侧拉伸，左右交替十五秒。'", "ttsCue: 'Exercise two, calf stretch, alternate sides for fifteen seconds.'"],
    ["title: '大腿前侧'", "title: 'Front Thigh'"],
    ["instruction: '扶墙屈膝，左右换边'", "instruction: 'Use wall, bend knee, switch sides'"],
    ["ttsCue: '第三项，大腿前侧拉伸，左右交替十五秒。'", "ttsCue: 'Exercise three, front thigh stretch, alternate sides for fifteen seconds.'"],
    ["title: '大腿后侧'", "title: 'Back Thigh'"],
    ["instruction: '脚尖回勾，左右换边'", "instruction: 'Toes up, switch sides'"],
    ["ttsCue: '第四项，大腿后侧拉伸，左右交替十五秒。'", "ttsCue: 'Exercise four, back thigh stretch, alternate sides for fifteen seconds.'"],
    ["'完成放松'", "'Finish Recovery'"],
    ["'下一步'", "'Next'"],
    ["'三。二。一。'", "'Three. Two. One.'"],
    ["'换边。'", "'Switch sides.'"],
  ]);

  replaceText('lib/device_identity.js', [
    ["return '待分配';", "return 'Pending';"],
  ]);

  replaceText('assets/audio/NOTICE.md', [
    ['- Display name: Classic Mechanical / 经典机械', '- Display name: Classic Mechanical'],
  ]);

  replaceText('lib/devices.js', [
    ["compactDeviceName(device.deviceName) || (device.deviceId ? '已记住' : '自动选择')", "compactDeviceName(device.deviceName) || (device.deviceId ? 'Remembered' : 'Auto pick')"],
    ["device && (device.name || device.deviceName || '心率设备')", "device && (device.name || device.deviceName || 'HR device')"],
  ]);

  replaceText('lib/coach_api.js', [
    ["ctx && ctx !== '暂无运动数据' ? `[实时 ${ctx}] ${q}` : q", "ctx && ctx !== 'No run data' ? `[Live ${ctx}] ${q}` : q"],
    ["parts.push(`[关于我: ${snippets.join('; ')}]`);", "parts.push(`[About me: ${snippets.join('; ')}]`);"],
    ["parts.push(`[画像: ${sanitizeSnippet(memCtx.profile, MEMORY_PROFILE_MAX)}]`);", "parts.push(`[Profile: ${sanitizeSnippet(memCtx.profile, MEMORY_PROFILE_MAX)}]`);"],
    ["if (ctx && ctx !== '暂无运动数据') parts.push(`[实时: ${ctx}]`);", "if (ctx && ctx !== 'No run data') parts.push(`[Live: ${ctx}]`);"],
  ]);

  replaceText('lib/coach.js', [
    ["'你是 AISmartRun 的 AI 跑步教练，正通过 AI 眼镜陪用户跑步。' +\n  '回答必须是一句话、不超过15个汉字、口语化、可直接朗读，不用列表和表情。' +\n  '没有心率数据时不得猜心率，可按配速、步频和体感建议。' +\n  '不诊断疾病、不给医疗建议；心率明显偏高时优先提醒降速和呼吸。';", "'You are the AISmartRun AI running coach in Rokid glasses. ' +\n  'Answer in one short spoken sentence, no lists and no emoji. ' +\n  'Do not guess heart rate when no HR data is available; use pace, cadence and effort cues. ' +\n  'Do not give medical advice; if heart rate is high, prioritize slowing down and breathing.';"],
    ["return '暂无运动数据';", "return 'No run data';"],
    ["parts.push(`心率 ${Math.round(s.bpm)}${s.zone > 0 ? `(Z${s.zone})` : ''}`);", "parts.push(`HR ${Math.round(s.bpm)}${s.zone > 0 ? `(Z${s.zone})` : ''}`);"],
    ["if (p !== PACE_PENDING) parts.push(`配速 ${p}/km`);", "if (p !== PACE_PENDING) parts.push(`Pace ${p}/km`);"],
    ["parts.push(`步频 ${Math.round(s.cadenceSpm)}`);", "parts.push(`Cad ${Math.round(s.cadenceSpm)}`);"],
    ["parts.push(`距离 ${formatDistanceKm(s.distanceM)}km`);", "parts.push(`Dist ${formatDistanceKm(s.distanceM)}km`);"],
    ["parts.push(`时长 ${formatElapsed(s.elapsedMs)}`);", "parts.push(`Time ${formatElapsed(s.elapsedMs)}`);"],
    ["if (s.paused) parts.push('已暂停');", "if (s.paused) parts.push('Paused');"],
    ["return parts.length ? parts.join('，') : '暂无运动数据';", "return parts.length ? parts.join(', ') : 'No run data';"],
    ["return `${PERSONA}\\n当前实时数据：${summarizeSnapshot(s)}。`;", "return `${PERSONA}\\nLive data: ${summarizeSnapshot(s)}.`;"],
    ["if (cz >= 5 && pz < 5) return '心率 Z5 了，降速深呼吸。';", "if (cz >= 5 && pz < 5) return 'Z5 HR, slow down.';"],
    ["if (cMin > pMin) return '还在 Z5，先降下来。';", "if (cMin > pMin) return 'Still Z5, ease off.';"],
    ["? `第 ${km} 公里，配速 ${p}。`", "? `Km ${km}, pace ${p}.`"],
    [": `${km} 公里了，继续。`;", ": `${km} km, keep going.`;"],
    ["const cad = Number.isFinite(cur.cadenceSpm) && cur.cadenceSpm > 0 ? `，步频 ${Math.round(cur.cadenceSpm)}` : '';", "const cad = Number.isFinite(cur.cadenceSpm) && cur.cadenceSpm > 0 ? `, cad ${Math.round(cur.cadenceSpm)}` : '';"],
    ["return `跑了 ${cm * 5} 分钟${cad}。`;", "return `${cm * 5} min done${cad}.`;"],
    ["if (cz === 4 && pz < 4) return '到 Z4 了，别再加速。';", "if (cz === 4 && pz < 4) return 'Z4 now, do not push.';"],
    ["if (/配速|速度|快|慢|提速|加速|降速/.test(t)) return 'pace';", "if (/pace|speed|fast|slow|faster|slower/i.test(t)) return 'pace';"],
    ["if (/心率|心跳|bpm|区间|zone/i.test(t)) return 'hr';", "if (/bpm|zone|heart|hr|pulse/i.test(t)) return 'hr';"],
    ["if (/距离|多远|公里|千米|km/i.test(t)) return 'distance';", "if (/km|distance|far/i.test(t)) return 'distance';"],
    ["if (/多久|时间|多长|跑了多少时间|还要跑/.test(t)) return 'time';", "if (/time|long/i.test(t)) return 'time';"],
    ["return '心率 Z5 了，降速深呼吸。';", "return 'Z5 HR, slow down.';"],
    ["return `配速 ${p}，${zone >= 4 ? '稍收一点' : '保持住'}。`;", "return `Pace ${p}, ${zone >= 4 ? 'ease off' : 'hold it'}.`;"],
    ["return '先匀速跑两分钟再看。';", "return 'Run steady for 2 min.';"],
    ["return `心率 ${Math.round(snap.bpm)}${zone > 0 ? ` Z${zone}` : ''}，${zone >= 4 ? '偏高' : '很稳'}。`;", "return `HR ${Math.round(snap.bpm)}${zone > 0 ? ` Z${zone}` : ''}, ${zone >= 4 ? 'high' : 'steady'}.`;"],
    ["return '当前无心率数据。';", "return 'No HR data now.';"],
    ["return `已跑 ${formatDistanceKm(snap.distanceM)} 公里，加油。`;", "return `Done ${formatDistanceKm(snap.distanceM)} km.`;"],
    ["return '刚起步，慢慢来。';", "return 'Just started, ease in.';"],
    ["return `已跑 ${formatElapsed(snap.elapsedMs)}，稳住。`;", "return `Time ${formatElapsed(snap.elapsedMs)}, hold.`;"],
    ["return '刚开始，进状态。';", "return 'Getting started.';"],
    ["if (zone >= 4) return '心率偏高，放慢些。';", "if (zone >= 4) return 'HR high, slow down.';"],
    ["if (zone > 0 && zone <= 2) return '很轻松，可稳提速。';", "if (zone > 0 && zone <= 2) return 'Easy effort, lift gently.';"],
    ["if (!hasMotionData(snap)) return '先稳跑，找节奏。';", "if (!hasMotionData(snap)) return 'Settle into rhythm.';"],
    ["return '节奏很好，保持。';", "return 'Good rhythm, hold.';"],
    ["? `(Z${zone})`\n      : (zone > 0 && confidence === 'estimated' ? `(估算Z${zone})` : '');", "? `(Z${zone})`\n      : (zone > 0 && confidence === 'estimated' ? `(Est. Z${zone})` : '');"],
    ["parts.push(`心率 ${Math.round(s.bpm)}${zoneCopy}`);", "parts.push(`HR ${Math.round(s.bpm)}${zoneCopy}`);"],
    ["? '最大心率来源已确认，可按区间给建议。'", "? 'Maximum heart rate is confirmed; zone guidance is allowed.'"],
    ["? '心率区间仅为估算，禁止建议提速。'", "? 'Heart-rate zones are estimates; never suggest speeding up.'"],
    [": '没有个人最大心率策略，只显示 BPM，禁止推断区间或建议提速。'", ": 'No personal maximum-heart-rate policy; show BPM only and never infer zones or suggest speeding up.'"],
    ["return `${PERSONA}\\n心率策略：${policyCopy}\\n当前实时数据：${summarizeSnapshot(s)}。`;", "return `${PERSONA}\\nHeart-rate policy: ${policyCopy}\\nLive data: ${summarizeSnapshot(s)}.`;"],
    ["? '心率 Z5 了，降速深呼吸。'", "? 'Z5 HR, slow down and breathe.'"],
    [": '心率偏高，先降速。'", ": 'HR is high. Slow down.'"],
    ["? '还在 Z5，先降下来。'", "? 'Still Z5. Ease off.'"],
    [": '心率仍偏高，先降速。'", ": 'HR remains high. Slow down.'"],
    ["return '到 Z4 了，别再加速。';", "return 'Z4 now. Do not push.';"],
    ["return `配速 ${p}，稍收一点。`;", "return `Pace ${p}, ease off.`;"],
    ["return `配速 ${p}，保持稳定。`;", "return `Pace ${p}, stay steady.`;"],
    ["return `心率 ${Math.round(snap.bpm)} Z${zone}，${zone >= 4 ? '偏高' : '稳定'}。`;", "return `HR ${Math.round(snap.bpm)} Z${zone}, ${zone >= 4 ? 'high' : 'steady'}.`;"],
    ["return `心率 ${Math.round(snap.bpm)}，区间仅估算。`;", "return `HR ${Math.round(snap.bpm)}, zone estimated.`;"],
    ["return `心率 ${Math.round(snap.bpm)}，正在记录。`;", "return `HR ${Math.round(snap.bpm)}, recording.`;"],
    ["if (confidence === 'trusted' && zone >= 4) return '心率偏高，放慢些。';", "if (confidence === 'trusted' && zone >= 4) return 'HR high, slow down.';"],
    ["if (confidence === 'trusted' && zone > 0 && zone <= 2) return '很轻松，可稳提速。';", "if (confidence === 'trusted' && zone > 0 && zone <= 2) return 'Easy effort, lift gently.';"],
    ["return '数据记录中，保持稳定。';", "return 'Recording data. Stay steady.';"],
    ["return `心率${bpm}，配速${pace}。`;", "return `HR ${bpm}, pace ${pace}.`;"],
    ["return `心率${bpm}，保持节奏。`;", "return `HR ${bpm}, stay steady.`;"],
    ["? `${cm * 5}分钟，配速${pace}。`", "? `${cm * 5} min, pace ${pace}.`"],
    [": `${cm * 5}分钟了，保持节奏。`;", ": `${cm * 5} min, stay steady.`;"],
  ]);
  replaceRegex('lib/coach.js', [
    [
      /const PERSONA =[\s\S]*?;\n/,
      "const PERSONA =\n  'You are the AISmartRun AI running coach in Rokid glasses. ' +\n  'Answer in one short spoken sentence, no lists and no emoji. ' +\n  'Do not guess heart rate when no HR data is available; use pace, cadence and effort cues. ' +\n  'Do not give medical advice; if heart rate is high, prioritize slowing down and breathing.';\n",
    ],
    [
      /const cut = Math\.max\([\s\S]*?\n\s*\);\n/,
      "const cut = Math.max(\n    head.lastIndexOf('.'), head.lastIndexOf('!'), head.lastIndexOf('?'),\n    head.lastIndexOf(','),\n  );\n",
    ],
    [/if \(\/[^/\n]*pace\|speed\|fast\|slow\|faster\|slower\/i\.test\(t\)\) return 'pace';/g, "if (/pace|speed|fast|slow|faster|slower/i.test(t)) return 'pace';"],
    [/if \(\/[^/\n]*bpm\|[^/\n]*zone\|heart\|hr\|pulse\/i\.test\(t\)\) return 'hr';/g, "if (/bpm|zone|heart|hr|pulse/i.test(t)) return 'hr';"],
    [/if \(\/[^/\n]*km\|distance\|far\/i\.test\(t\)\) return 'distance';/g, "if (/km|distance|far/i.test(t)) return 'distance';"],
    [/if \(\/[^/\n]*time\|long\/i\.test\(t\)\) return 'time';/g, "if (/time|long/i.test(t)) return 'time';"],
  ]);
}

function stripChineseComments() {
  for (const abs of listTextFiles()) {
    let text = fs.readFileSync(abs, 'utf8');
    text = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => (
      NON_EN_RE.test(comment) ? '' : comment
    ));
    text = text.replace(/^[ \t]*\/\/.*[\u3000-\u303f\u3400-\u9fff\uff00-\uffef].*$/gm, '');
    text = text.replace(/[ \t]+\/\/.*[\u3000-\u303f\u3400-\u9fff\uff00-\uffef].*$/gm, '');
    fs.writeFileSync(abs, text);
  }
}

function assertNoChineseInStage() {
  const hits = [];
  for (const abs of listTextFiles()) {
    const relPath = path.relative(STAGE, abs);
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (NON_EN_RE.test(lines[i])) {
        hits.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
        if (hits.length >= 30) break;
      }
    }
  }
  if (hits.length) {
    fail(`English AIX still contains non-English CJK/fullwidth text:\n${hits.join('\n')}`);
  }
}

function assertBindingExportEnglishLocalization() {
  const text = read('pages/run_hud/index.ink');
  const required = [
    'Export Field Log',
    'No Run Log Available',
    'Complete a Run and Save Its Summary First',
    'No Log',
    'No Field Log',
    'Exporting Field Log',
    'Keep ADB Capture Running Until END',
    'Field Log Export Complete',
    'END Sent · Stop Capture and Run Extractor',
    'Exported',
    'Export Again',
    'Field Log Export Unavailable',
    'Local Log Kept · Try Again Later',
    'Export Failed',
    'Retry Export',
    'Field Log Export Paused',
    'Return and Export Again · Local Log Is Safe',
    'Swipe to Select · Tap to Run · Back to Settings',
  ];
  const forbidden = [
    '导出现场日志',
    '暂无可导出的跑步日志',
    '完成一次跑步并保存总结后再导出',
    '请保持电脑 ADB 实时抓取，看到 END 即完成',
    '现场日志导出完成',
    '现场日志暂时无法导出',
    '现场日志导出已暂停',
    '前后划选择 · 单击执行 · 返回键回设置',
  ];
  const problems = [];
  for (const phrase of required) {
    if (!text.includes(phrase)) problems.push(`missing ${phrase}`);
  }
  for (const phrase of forbidden) {
    if (text.includes(phrase)) problems.push(`Chinese leak ${phrase}`);
  }
  if (problems.length) {
    fail(`English binding-export localization is incomplete:\n${problems.join('\n')}`);
  }
}

function assertJavaScriptSyntax(file, label) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: STAGE,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message
      || String(result.stderr || result.stdout || '').trim()
      || `exit ${result.status}`;
    fail(`English stage JavaScript syntax failed for ${label}: ${reason}`);
  }
}

function assertStageJavaScriptSyntax() {
  for (const abs of listTextFiles(rel('lib')).filter((file) => file.endsWith('.js'))) {
    assertJavaScriptSyntax(abs, path.relative(STAGE, abs));
  }
  for (const pageFile of [
    'pages/index/index.ink',
    'pages/run_hud/index.ink',
  ]) {
    const source = read(pageFile);
    const match = source.match(/<script(?![^>]*\bdef\b)[^>]*>\s*([\s\S]*?)\s*<\/script>/);
    if (!match) fail(`English stage page is missing its runtime script: ${pageFile}`);
    const checkFile = rel(`${pageFile}.syntax-check.mjs`);
    try {
      fs.writeFileSync(checkFile, `${match[1]}\n`, 'utf8');
      assertJavaScriptSyntax(checkFile, `${pageFile} runtime`);
    } finally {
      fs.rmSync(checkFile, { force: true });
    }
  }
}

// Both routes are title-only. The first no-parameter run route is the official
// `_blank` immersive entry; the later 448x150 Home is compatibility-only.
const PAGE_DESC_EN = {};

function localizePageDescriptions() {
  for (const [file, en] of Object.entries(PAGE_DESC_EN)) {
    replaceRegex(file, [[/"description":\s*"[^"]*"/, `"description": "${en}"`]]);
  }
}

function localizeAll() {
  localizeMetadata();
  localizeHome();
  localizeRunHud();
  localizeLibraries();
  localizePageDescriptions();

  for (const pageFile of [
    'pages/index/index.ink',
    'pages/run_hud/index.ink',
  ]) {
    replaceRegex(pageFile, [
      [/"description": "中文：[^"]+ English: ([^"]+)"/g, '"description": "$1"'],
    ]);
  }
  stripChineseComments();
  assertBindingExportEnglishLocalization();
  assertStageJavaScriptSyntax();
  assertNoChineseInStage();
}

const JA_TEXT_REPLACEMENTS = Object.freeze([
  ['Run Free. Run Smart.', '自由に走る。スマートに走る。'],
  ['You are a running coach on smart glasses. Reply in English, under 12 words, conversational, no lists.', 'あなたはスマートグラスのランニングコーチです。日本語で短く自然に、一文で答えてください。'],
  ['Reply in English within 12 words, without lists or emoji.', '日本語で短く、箇条書きや絵文字を使わずに答えてください。'],
  ['Summarize this run in English within 12 words,', 'このランニングを日本語の短い一文でまとめ、'],
  ['You are the AISmartRun AI running coach in Rokid glasses. ', 'あなたはRokid GlassesのAISmartRun AIランニングコーチです。'],
  ['Answer in one short spoken sentence, no lists and no emoji. ', '読み上げやすい日本語の短い一文で答え、箇条書きや絵文字は使いません。'],
  ['Do not guess heart rate when no HR data is available; use pace, cadence and effort cues. ', '心拍データがない場合は推測せず、ペース、ピッチ、体感を使います。'],
  ['Do not give medical advice; if heart rate is high, prioritize slowing down and breathing.', '医療助言は行わず、心拍が高い場合は減速と呼吸を優先します。'],
  ['Press Confirm to Enter', '確認キーで開始'],
  ['Press Back again to exit', 'もう一度戻るキーで終了'],
  ['Free Run', 'フリーラン'],
  ['Slow Jog', 'スロージョグ'],
  ['Indoor Run', '室内ラン'],
  ['Training Plans', 'トレーニング'],
  ['Settings', '設定'],
  ['Today Training', '今日のトレーニング'],
  ['Choose Training', 'トレーニングを選択'],
  ['Easy Run', 'イージーラン'],
  ['LSD Long Run', 'LSDロングラン'],
  ['Fartlek Run', 'ファルトレク'],
  ['Interval Run', 'インターバル'],
  ['Back to Training Menu', 'トレーニングメニューへ戻る'],
  ['Swipe to Select · Tap to Confirm · Back to Menu', '前後にスワイプ · タップで決定 · 戻るでメニュー'],
  ['Swipe to Select · Tap to Confirm · Back to Home', '前後にスワイプ · タップで決定 · 戻るでホーム'],
  ['Swipe to Select · Tap to Confirm · Back to Exit', '前後にスワイプ · タップで決定 · 戻るで終了'],
  ['Swipe to Select · Tap to Confirm', '前後にスワイプ · タップで決定'],
  ['Back to Home · Double-tap to Exit', '戻るでホーム · ダブルタップで終了'],
  ['Back to Exit · Double-tap to Exit', '戻るで終了 · ダブルタップで終了'],
  ['Restoring Previous Run · Retry', '前回の記録を復元中 · 再試行'],
  ['Start Scan', '検索開始'],
  ['Searching for HR devices...', '心拍デバイスを検索中...'],
  ['Search Has Not Started', 'まだ検索していません'],
  ['Tap to Search for HR Devices', 'タップして心拍デバイスを検索'],
  ['Tap Next to Continue', '次へをタップ'],
  ['Tap Next to Use Glasses Estimate', '次へでメガネ推定を使用'],
  ['Waiting for Nearby Device Broadcasts', '周辺デバイスの信号を待機中'],
  ['Bluetooth Search Unavailable', 'Bluetooth検索を利用できません'],
  ['Bluetooth check timed out', 'Bluetooth確認がタイムアウトしました'],
  ['Scan timed out', '検索がタイムアウトしました'],
  ['Scan error', '検索エラー'],
  ['Search failed', '検索失敗'],
  ['Not Searched', '未検索'],
  ['Searching', '検索中'],
  ['Waiting', '待機中'],
  ['Next', '次へ'],
  ['Get Ready', 'ランニング準備'],
  ['Starting', '開始中'],
  ['HR Device', '心拍デバイス'],
  ['Device List', 'デバイス一覧'],
  ['Connected', '接続済み'],
  ['Connecting HR Device', '心拍デバイスに接続中'],
  ['Waiting for HR', '心拍データを待機中'],
  ['HR data live', '心拍データ接続'],
  ['No HR data', '心拍データなし'],
  ['HR link failed', '心拍接続失敗'],
  ['Auto reconnecting', '自動再接続中'],
  ['Glasses est.', 'メガネ推定'],
  ['Est. zone', '推定区間'],
  ['Pace Live', 'ペース接続'],
  ['Data Online', 'データ接続'],
  ['Heart Rate', '心拍接続'],
  ['HR data', '心拍記録'],
  ['Run steady ~5 sec', '約5秒安定して走ってください'],
  ['Start easy, breathe.', 'ゆっくり開始し、呼吸を整えましょう。'],
  ['Ready to run', 'スタート準備'],
  ['Paused', '一時停止'],
  ['Timing only', '時間のみ計測'],
  ['Good rhythm', '良いリズムです'],
  ['Pace', 'ペース'],
  ['Cad.', 'ピッチ'],
  ['Dist.', '距離'],
  ['Time', '時間'],
  ['Steps', '歩数'],
  ['Avg HR', '平均心拍'],
  ['Avg cadence', '平均ピッチ'],
  ['Quick Guide Exit', 'ガイド即終了'],
  ['Quick exit on · Guide muted', '即時終了オン · 音声ガイドなし'],
  ['Skip Warm-up', 'ウォームアップを省略'],
  ['Quick Finish', 'すぐ完了'],
  ['Pre-run Warm-up', 'ランニング前のウォームアップ'],
  ['4 exercises · 15 sec each · 1 min total', '4項目 · 各15秒 · 合計1分'],
  ['Pre-run warm-up has four exercises, fifteen seconds each, one minute total. ', 'ランニング前のウォームアップは4つ、各15秒、合計1分です。'],
  ['Warm-up done · Starting', 'ウォームアップ完了 · スタートします'],
  ['Warm-up complete. Starting automatically.', 'ウォームアップ完了。自動でスタートします。'],
  ['March in Place', 'その場で足踏み'],
  ['Lift knees and swing arms', '膝を上げ、腕を前後に振る'],
  ['Stay upright', '上体をまっすぐ保つ'],
  ['Exercise one, march in place, fifteen seconds.', '1つ目、その場で足踏み、15秒です。'],
  ['Calf Raises', 'かかと上げ'],
  ['Raise heels, lower slowly', 'かかとを上げ、ゆっくり下ろす'],
  ['Keep knees relaxed', '膝の力を抜く'],
  ['Exercise two, calf raises, fifteen seconds.', '2つ目、かかと上げ、15秒です。'],
  ['Butt Kicks', 'ヒールキック'],
  ['Bring heels back, alternate sides', 'かかとを後ろへ、左右交互に'],
  ['Keep your torso upright', '上体をまっすぐ保つ'],
  ['Exercise three, alternate butt kicks for fifteen seconds.', '3つ目、ヒールキックを左右交互に15秒です。'],
  ['Lateral Weight Shift', '左右への重心移動'],
  ['Bend knees, shift side to side', '膝を曲げ、左右へ重心移動'],
  ['Keep knees aligned with toes', '膝をつま先の向きに合わせる'],
  ['Exercise four, shift weight side to side for fifteen seconds.', '4つ目、左右への重心移動を15秒です。'],
  ['Resumed · Auto-start at zero', '再開 · 0秒で自動スタート'],
  ['Auto-start at zero', '0秒で自動スタート'],
  ['Start Now', '今すぐスタート'],
  ['Recovery', 'クールダウン'],
  ['Recovery has four exercises, fifteen seconds each, one minute total. ', 'クールダウンは4つ、各15秒、合計1分です。'],
  ['Recovery complete. Choose Run Summary or End and Exit.', 'クールダウン完了。ランニング結果を見るか、終了を選んでください。'],
  ['Gentle Walk', 'ゆっくり歩く'],
  ['Walk slowly, swing arms naturally', 'ゆっくり歩き、腕を自然に振る'],
  ['Exercise one, gentle walk, fifteen seconds.', '1つ目、ゆっくり歩く、15秒です。'],
  ['Calf', 'ふくらはぎ'],
  ['Heel down, switch sides', '後ろのかかとを床につけ、左右を替える'],
  ['Exercise two, calf stretch, alternate sides for fifteen seconds.', '2つ目、ふくらはぎを左右交互に15秒伸ばします。'],
  ['Front Thigh', '太もも前側'],
  ['Use wall, bend knee, switch sides', '壁に手を添えて膝を曲げ、左右を替える'],
  ['Exercise three, front thigh stretch, alternate sides for fifteen seconds.', '3つ目、太もも前側を左右交互に15秒伸ばします。'],
  ['Back Thigh', '太もも後側'],
  ['Toes up, switch sides', 'つま先を上げ、左右を替える'],
  ['Exercise four, back thigh stretch, alternate sides for fifteen seconds.', '4つ目、太もも後側を左右交互に15秒伸ばします。'],
  ['Stop if painful', '痛みがあれば中止'],
  ['Resumed · Auto-next after 15 sec', '再開 · 15秒後に自動で次へ'],
  ['Auto-next after 15 sec', '15秒後に自動で次へ'],
  ['Recovery done · Choose Next', 'クールダウン完了 · 次を選択'],
  ['Finish Recovery', 'クールダウンを完了'],
  ['Done', '完了'],
  ['View Run Summary', 'ランニング結果を見る'],
  ['End and Exit', '終了する'],
  ['Run Complete', 'ランニング完了'],
  ['Run summary', 'ランニング結果'],
  ['Local summary', 'ローカル結果'],
  ['AI review', 'AIレビュー'],
  ['Hermes review', 'Hermesレビュー'],
  ['Local review', 'ローカルレビュー'],
  ['Organizing log', 'ログ整理中'],
  ['Log saved · Upload pending', 'ログ保存済み · 送信待ち'],
  ['Log saved · Uploading', 'ログ保存済み · 送信中'],
  ['Log saved · Some need review', 'ログ保存済み · 一部要確認'],
  ['Hermes uploaded · ', 'Hermes送信済み · '],
  ['Hermes synced', 'Hermes同期済み'],
  ['Log save failed · Retry', 'ログ保存失敗 · 再試行'],
  ['Saving log · Retrying', 'ログ保存中 · 再試行中'],
  ['Saving, please wait', '保存中です'],
  ['Save failed. Press Back to retry', '保存失敗。戻るキーでもう一度'],
  ['AI coach summarizing…', 'AIコーチがまとめています…'],
  ['Summarizing', 'まとめ中'],
  ['Hydrate and recover.', '水分を取り、しっかり回復しましょう。'],
  ['Keep a steady rhythm.', '安定したリズムを保ちましょう。'],
  ['Training complete.', 'トレーニング完了です。'],
  ['Press Back to End and Close Agent', '戻るキーで終了してエージェントを閉じる'],
  ['Press Confirm Again to Exit', 'もう一度確認キーで終了'],
  ['Training complete · Press Confirm 3 Times to End', 'トレーニング完了 · 確認キーを3回押して終了'],
  ['Goal complete · Press Confirm 3 Times to End', '目標達成 · 確認キーを3回押して終了'],
  ['Press 2 More Times to End', 'あと2回押すと終了'],
  ['Press 1 More Time to End', 'あと1回押すと終了'],
  ['Press Confirm 3 Times to End', '確認キーを3回押して終了'],
  ['Press Confirm Again to End', 'もう一度確認キーでランニング終了'],
  ['Agent Pairing', 'エージェント連携'],
  ['AI Model', 'AIモデル'],
  ['AIUI Agent Pairing', 'AIUIエージェント連携'],
  ['AIUI Agent Paired', 'AIUIエージェント連携済み'],
  ['AIUI Agent Not Paired', 'AIUIエージェント未連携'],
  ['Refresh Status', '状態を更新'],
  ['Export Field Log', '現場ログを書き出す'],
  ['No Run Log Available', '書き出せるランニングログなし'],
  ['Complete a Run and Save Its Summary First', 'ランニング完了・結果保存後に書き出せます'],
  ['No Field Log', '現場ログなし'],
  ['No Log', 'ログなし'],
  ['Exporting Field Log', '現場ログ書き出し中'],
  ['Keep ADB Capture Running Until END', 'ENDまでADB取得を続けてください'],
  ['Exporting', '書き出し中'],
  ['Field Log Export Complete', '現場ログ書き出し完了'],
  ['END Sent · Stop Capture and Run Extractor', 'END出力済み · 取得を停止して抽出コマンドを実行'],
  ['Exported', '書き出し済み'],
  ['Export Again', 'もう一度書き出す'],
  ['Field Log Export Unavailable', '現場ログを書き出せません'],
  ['Local Log Kept · Try Again Later', 'ローカルログは保持済み · 後でもう一度'],
  ['Export Failed', '書き出し失敗'],
  ['Retry Export', '書き出しを再試行'],
  ['Field Log Export Paused', '現場ログ書き出し一時停止'],
  ['Return and Export Again · Local Log Is Safe', '戻って再度書き出し · ログは保持済み'],
  ['Swipe to Select · Tap to Run · Back to Settings', '前後にスワイプ · タップで実行 · 戻るで設定'],
  ['Not Paired', '未連携'],
  ['Paired', '連携済み'],
  ['Recovery Needed', '復旧が必要'],
  ['Metronome', 'メトロノーム'],
  ['Voice Cues', '音声ガイド'],
  ['Estimated Stride', '推定歩幅'],
  ['Long-term memory', '長期記憶'],
  ['Backend required', '要バックエンド'],
  ['On', 'オン'],
  ['Off', 'オフ'],
  ['Calculating', '計算中'],
  ['Three. Two. One.', '3。2。1。'],
  ['Switch sides.', '左右を替えます。'],
  ['15 sec', '15秒'],
  ['1 min total', '合計1分'],
]);

function assertJapaneseGuideLocalization() {
  const checks = [
    {
      file: 'pages/run_hud/index.ink',
      required: [
        'ガイド即終了',
        '推定区間',
        '即時終了オン · 音声ガイドなし',
        'ウォームアップを省略',
        'すぐ完了',
        'ログ保存済み · 一部要確認',
        '再開 · 0秒で自動スタート',
        '再開 · 15秒後に自動で次へ',
        'ウォームアップ完了 · スタートします',
        'クールダウン完了 · 次を選択',
        '現場ログを書き出す',
        '書き出せるランニングログなし',
        'ランニング完了・結果保存後に書き出せます',
        '現場ログ書き出し中',
        'ENDまでADB取得を続けてください',
        '現場ログ書き出し完了',
        'END出力済み · 取得を停止して抽出コマンドを実行',
        '現場ログを書き出せません',
        '現場ログ書き出し一時停止',
        '前後にスワイプ · タップで実行 · 戻るで設定',
        'あと2回押すと終了',
        'あと1回押すと終了',
        '確認キーを3回押して終了',
      ],
      forbidden: [
        'Quick Guide Exit',
        'Est. zone',
        'Quick exit on · Guide muted',
        'Skip Warm-up',
        'Quick Finish',
        'Log saved · Some need review',
        'Resumed · Auto-start at zero',
        'Resumed · Auto-next after 15 sec',
        'Export Field Log',
        'No Run Log Available',
        'Complete a Run and Save Its Summary First',
        'Exporting Field Log',
        'Keep ADB Capture Running Until END',
        'Field Log Export Complete',
        'END Sent · Stop Capture and Run Extractor',
        'Field Log Export Unavailable',
        'Field Log Export Paused',
        'Swipe to Select · Tap to Run · Back to Settings',
        'Press 2 More Times to End',
        'Press 1 More Time to End',
        'Press Confirm 3 Times to End',
      ],
    },
    {
      file: 'lib/warmup_guide.js',
      required: [
        '4項目 · 各15秒 · 合計1分',
        'ランニング前のウォームアップは4つ、各15秒、合計1分です。',
        'その場で足踏み',
        '膝を上げ、腕を前後に振る',
        'かかと上げ',
        'かかとを上げ、ゆっくり下ろす',
        '膝の力を抜く',
        'ヒールキック',
        'かかとを後ろへ、左右交互に',
        '上体をまっすぐ保つ',
        '左右への重心移動',
        '膝を曲げ、左右へ重心移動',
        '膝をつま先の向きに合わせる',
        '1つ目、その場で足踏み、15秒です。',
        '2つ目、かかと上げ、15秒です。',
        '3つ目、ヒールキックを左右交互に15秒です。',
        '4つ目、左右への重心移動を15秒です。',
      ],
      forbidden: [
        '4 exercises · 15 sec each · 1 min total',
        'Pre-run warm-up has four exercises',
        'Lift knees and swing arms',
        'Raise heels, lower slowly',
        'Bring heels back, alternate sides',
        'Bend knees, shift side to side',
        'Exercise one, march in place',
        'Exercise two, calf raises',
        'Exercise three, alternate butt kicks',
        'Exercise four, shift weight side to side',
      ],
    },
    {
      file: 'lib/recovery_guide.js',
      required: [
        'クールダウンは4つ、各15秒、合計1分です。',
        'クールダウン完了。ランニング結果を見るか、終了を選んでください。',
        '痛みがあれば中止',
        'ゆっくり歩き、腕を自然に振る',
        '後ろのかかとを床につけ、左右を替える',
        '壁に手を添えて膝を曲げ、左右を替える',
        'つま先を上げ、左右を替える',
        '1つ目、ゆっくり歩く、15秒です。',
        '2つ目、ふくらはぎを左右交互に15秒伸ばします。',
        '3つ目、太もも前側を左右交互に15秒伸ばします。',
        '4つ目、太もも後側を左右交互に15秒伸ばします。',
      ],
      forbidden: [
        'Recovery has four exercises',
        'Recovery complete. Choose Run Summary or End and Exit.',
        'Walk slowly, swing arms naturally',
        'Heel down, switch sides',
        'Use wall, bend knee, switch sides',
        'Toes up, switch sides',
        'Exercise one, gentle walk',
        'Exercise two, calf stretch',
        'Exercise three, front thigh stretch',
        'Exercise four, back thigh stretch',
      ],
    },
  ];

  const problems = [];
  for (const check of checks) {
    const text = read(check.file);
    for (const phrase of check.required) {
      if (!text.includes(phrase)) problems.push(`${check.file}: missing ${phrase}`);
    }
    for (const phrase of check.forbidden) {
      if (text.includes(phrase)) problems.push(`${check.file}: English leak ${phrase}`);
    }
  }
  if (problems.length) {
    fail(`Japanese guide localization is incomplete:\n${problems.join('\n')}`);
  }
}

function localizeJapanese() {
  for (const abs of listTextFiles()) {
    let text = fs.readFileSync(abs, 'utf8');
    for (const [from, to] of [...JA_TEXT_REPLACEMENTS]
      .sort((a, b) => b[0].length - a[0].length)) {
      text = text
        .split(`'${from}'`).join(`'${to}'`)
        .split(`"${from}"`).join(`"${to}"`)
        .split(`>${from}<`).join(`>${to}<`);
    }
    fs.writeFileSync(abs, text, 'utf8');
  }

  const app = JSON.parse(read('app.json'));
  app.window = app.window || {};
  app.window.navigationBarTitleText = 'SmartRun';
  write('app.json', `${JSON.stringify(app, null, 2)}\n`);

  const pkg = JSON.parse(read('package.json'));
  pkg.description = JA_DESCRIPTION;
  write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

  replaceText('pages/index/index.ink', [
    ["const LOCAL_MEMORY_LANGUAGE = 'en-US';", "const LOCAL_MEMORY_LANGUAGE = 'ja-JP';"],
  ]);
  replaceText('lib/coach.js', [
    ["return `HR ${bpm}, pace ${pace}.`;", "return `心拍${bpm}、ペース${pace}。`;"],
    ["return `HR ${bpm}, stay steady.`;", "return `心拍${bpm}、リズムを維持。`;"],
    ["? `${cm * 5} min, pace ${pace}.`", "? `${cm * 5}分、ペース${pace}。`"],
    [": `${cm * 5} min, stay steady.`;", ": `${cm * 5}分、リズムを維持。`;"],
  ]);
  replaceText('AGENTS.md', [
    [`${EN_DESCRIPTION}`, `${JA_DESCRIPTION}`],
    ['- **Name**: SmartRun', '- **Name**: SmartRun'],
  ]);
  replaceText('lib/run_summary.js', [
    [
      "const MODEL_TEXT_ALLOWED_RE = /^[A-Za-z0-9\\s,.!?:;%/+\\-()]+$/;",
      "const MODEL_TEXT_ALLOWED_RE = /^[A-Za-z0-9\\u3040-\\u30ff\\u3400-\\u9fff\\s、。,.!！?？:：;%/+\\-()]+$/;",
    ],
    [
      '/(hydrate|recover|rest|relax|stretch)/i',
      '/(hydrate|recover|rest|relax|stretch|水分|回復|休息|休む|リラックス|ストレッチ)/i',
    ],
    [
      '/(steady|rhythm|cadence|pace|maintain)/i',
      '/(steady|rhythm|cadence|pace|maintain|安定|リズム|ピッチ|ペース|維持)/i',
    ],
    [
      '/(complete|finish|continue|good|great|well done)/i',
      '/(complete|finish|continue|good|great|well done|完了|終了|継続|良い|お疲れ)/i',
    ],
  ]);
  assertStageJavaScriptSyntax();
  assertJapaneseGuideLocalization();
}

function packStage(buildId) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.rmSync(TMP, { force: true });
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
}

const sourceTreeSha256 = computeReleaseSourceTreeSha256(ROOT, {
  excludedPaths: ORPHAN_LIB_FILES,
});
prepareStage();
const buildId = writeAixVersion(STAGE);
localizeAll();
if (TARGET_LANGUAGE === 'ja') localizeJapanese();
const payloadTreeSha256 = computeReleaseSourceTreeSha256(STAGE);
writeAixProvenance(STAGE, {
  locale: TARGET_LOCALE,
  sourceTreeSha256,
  payloadTreeSha256,
});
packStage(buildId);
// 打包成功后清掉语言暂存树，不留残渣。
fs.rmSync(STAGE, { recursive: true, force: true });
