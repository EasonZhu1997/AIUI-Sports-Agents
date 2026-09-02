import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AIX_UUID_V4_RE, writeAixVersion } from '../tools/bump_version.mjs';
import {
  AIX_PLATFORM_LIMIT_BYTES,
  AIX_PLATFORM_METADATA_RESERVE_BYTES,
  AIX_PLATFORM_WARNING_BYTES,
  assertAixPlatformFootprint,
} from '../tools/aix_size_budget.mjs';
import { assertDistinctAixVersions, RELEASE_STEPS } from '../tools/verify_release.mjs';
import { ORPHAN_LIB_FILES, findOrphanLibReferences } from '../tools/pack_excludes.mjs';
import {
  AIX_MANIFEST_FILE,
  AIUI_ENGINE_RANGE,
  AIUI_TARGET_VERSION,
} from '../tools/aix_provenance.mjs';
import {
  calculateAixPackageId,
  inspectAixZipEntries,
  OFFICIAL_AIX_CLI_VERSION,
  packReadableAix,
} from '../tools/official_aix_pack.mjs';
import {
  auditSummaryCommitFirst,
  SUMMARY_COMMIT_DEFERRED_TOKENS,
  SUMMARY_FINALIZER_REQUIRED_TOKENS,
} from '../tools/summary_commit_guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { AixReaderWasm: CliAixReaderWasm } = require(path.join(
  ROOT,
  'node_modules/@yodaos-pkg/aix-cli/dist/pkg/aix_web.js',
));

test('总结首帧门禁把 storage/native 清理延后到 finalizer', () => {
  const summary = `
    this.sealBleForSummary();
    this.setData({ surfacePhase: 'summary' });
    this.stopTicker();
    this.summaryFinalizeTimer = setTimeout(
      () => this.finalizeRunAfterSummaryCommit(summary, wantsAi),
      0,
    );
  `;
  const finalizer = `
    this.persistSummaryQueues();
    this.stopAccel();
    this.stopMetronomePlayback({ destroy: true });
    clearLiveSnapshot(wx);
    this.beginTerminalBleCleanup();
  `;
  assert.deepEqual(auditSummaryCommitFirst(summary, finalizer), {
    ok: true,
    firstSetDataIndex: summary.indexOf('this.setData'),
    prematureDeferredTokens: [],
    missingFinalizerTokens: [],
  });
  assert.deepEqual(SUMMARY_COMMIT_DEFERRED_TOKENS, [
    'queueRunForUpload',
    'persistSummaryQueues',
    'stopAccel',
    'stopMetronomePlayback',
    'clearLiveSnapshot',
    'beginTerminalBleCleanup',
    'teardownBle',
    'releaseBleResources',
    'setStorageSync',
    'removeStorageSync',
    'clearStorageSync',
  ]);
  assert.deepEqual(SUMMARY_FINALIZER_REQUIRED_TOKENS, [
    'persistSummaryQueues',
    'stopAccel',
    'stopMetronomePlayback({ destroy: true })',
    'clearLiveSnapshot(wx)',
    'beginTerminalBleCleanup',
  ]);

  const premature = auditSummaryCommitFirst(
    `this.queueRunForUpload();\nthis.beginTerminalBleCleanup();\n${summary}`,
    finalizer,
  );
  assert.equal(premature.ok, false);
  assert.deepEqual(premature.prematureDeferredTokens, [
    'queueRunForUpload',
    'beginTerminalBleCleanup',
  ]);

  const incomplete = auditSummaryCommitFirst(summary, 'this.stopAccel();');
  assert.equal(incomplete.ok, false);
  assert.deepEqual(incomplete.missingFinalizerTokens, [
    'persistSummaryQueues',
    'stopMetronomePlayback({ destroy: true })',
    'clearLiveSnapshot(wx)',
    'beginTerminalBleCleanup',
  ]);
});

test('AIX 按 Craft 解压内容严格小于 2MB，并预留容器元数据空间', () => {
  const warningContent = AIX_PLATFORM_WARNING_BYTES - AIX_PLATFORM_METADATA_RESERVE_BYTES;
  assert.deepEqual(assertAixPlatformFootprint(warningContent - 1, 'fixture.aix'), {
    contentBytes: warningContent - 1,
    estimatedPlatformBytes: AIX_PLATFORM_WARNING_BYTES - 1,
    headroomBytes: AIX_PLATFORM_LIMIT_BYTES - AIX_PLATFORM_WARNING_BYTES + 1,
    warning: false,
  });
  assert.equal(assertAixPlatformFootprint(warningContent, 'fixture.aix').warning, true);
  const lastPassingContent = AIX_PLATFORM_LIMIT_BYTES - AIX_PLATFORM_METADATA_RESERVE_BYTES - 1;
  assert.equal(assertAixPlatformFootprint(lastPassingContent, 'fixture.aix').headroomBytes, 1);
  assert.throws(
    () => assertAixPlatformFootprint(lastPassingContent + 1, 'fixture.aix'),
    /estimated Craft package must stay below 2000000 bytes/,
  );
  assert.throws(() => assertAixPlatformFootprint(-1, 'fixture.aix'), /invalid content size/);
});

test('官方 prepared-file oracle 生成兼容 manifest，且包内 JS/Ink/WXSS 与 staging 逐字一致', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aismartrun-official-pack-'));
  const ink = '<script def>{"navigationBarTitleText":"Test"}</script>\n'
    + '<template><view class="panel">Readable</view></template>\n'
    + '<style>.panel { width: 480px; height: 352px; }</style>\n'
    + '<script>Page({ onLoad() { this.ready = true; } })</script>\n';
  const appJavaScript = '// Keep this application source readable.\n'
    + 'export default {\n  onLaunch() {\n    console.log("fixture launch");\n  },\n};\n';
  const runtimeJavaScript = '// Spacing and this comment must survive packaging.\n'
    + 'export function plusOne(value) {\n  return value + 1;\n}\n';
  const wxss = '.panel {\n  width: 480px;\n  height: 352px;\n}\n';
  const buildId = '123e4567-e89b-42d3-a456-426614174000';
  try {
    fs.mkdirSync(path.join(fixture, 'pages/index'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'styles'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'VERSION'), 'must-not-be-packed\n');
    fs.writeFileSync(path.join(fixture, 'app.json'), `${JSON.stringify({
      pages: ['pages/index/index'],
      engine: AIUI_ENGINE_RANGE,
      window: { navigationBarTitleText: 'Test' },
    })}\n`);
    fs.writeFileSync(path.join(fixture, 'app.js'), appJavaScript);
    fs.writeFileSync(path.join(fixture, 'lib/runtime.js'), runtimeJavaScript);
    fs.writeFileSync(path.join(fixture, 'pages/index/index.ink'), ink);
    fs.writeFileSync(path.join(fixture, 'styles/runtime.wxss'), wxss);
    const outputPath = path.join(fixture, 'fixture.aix');
    const packed = packReadableAix({
      root: fixture,
      packageEntries: ['app.json', 'app.js', 'lib', 'pages', 'styles', 'VERSION'],
      outputPath,
      buildId,
    });

    assert.equal(OFFICIAL_AIX_CLI_VERSION, '0.8.2');
    assert.equal(packed.manifest.format, 'aix');
    assert.equal(packed.manifest.version, buildId);
    assert.equal(packed.manifest.engine, AIUI_ENGINE_RANGE);
    assert.equal(packed.manifest.package_id, calculateAixPackageId(packed.manifest.entries));
    assert.equal(packed.entryCount, 7);
    assert.ok(packed.contentBytes > Buffer.byteLength(ink));
    assert.equal(fs.statSync(outputPath).size, packed.uploadBytes);
    assert.ok(
      inspectAixZipEntries(fs.readFileSync(outputPath))
        .every((entry) => entry.compressionMethod === 8),
      'every local and central ZIP entry must use Deflate',
    );

    const reader = new CliAixReaderWasm(Uint8Array.from(fs.readFileSync(outputPath)));
    try {
      assert.equal(new TextDecoder().decode(reader.read_file('VERSION')), buildId);
      for (const [file, expectedBytes] of [
        ['app.js', appJavaScript],
        ['lib/runtime.js', runtimeJavaScript],
        ['pages/index/index.ink', ink],
        ['styles/runtime.wxss', wxss],
      ]) {
        assert.equal(
          new TextDecoder().decode(reader.read_file(file)),
          expectedBytes,
          `${file} must remain byte-for-byte readable`,
        );
      }
      assert.ok(reader.list().some((entry) => entry.name === AIX_MANIFEST_FILE));
      assert.equal(reader.supports_engine('0.14.9'), false);
      assert.equal(reader.supports_engine('0.15.0'), true);
      assert.equal(reader.supports_engine(AIUI_TARGET_VERSION), true);
      assert.equal(reader.supports_engine('0.17.0'), false);
    } finally {
      reader.free?.();
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('AIX 版本工具只生成 UUID v4，不修改产品 semver 元数据', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aismartrun-version-'));
  try {
    fs.mkdirSync(path.join(fixture, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'VERSION'), '1.2.3\n');
    fs.writeFileSync(path.join(fixture, 'package.json'), '{"name":"AISmartRun","version":"1.2.3"}\n');
    fs.writeFileSync(path.join(fixture, 'AGENTS.md'), '- **Version**: 1.2.3\n');
    fs.writeFileSync(path.join(fixture, 'docs/AISmartRun_PRD.md'), '版本：1.2.3  \n');
    fs.writeFileSync(path.join(fixture, 'docs/AISmartRun_PRD_EN.md'), 'Version: 1.2.3  \n');

    const uuid = '5ee5bd2e-4392-4a62-9b28-9a2969a9e87f';
    assert.equal(writeAixVersion(fixture, () => uuid), uuid);
    assert.equal(fs.readFileSync(path.join(fixture, 'VERSION'), 'utf8'), `${uuid}\n`);
    assert.match(uuid, AIX_UUID_V4_RE);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8')).version, '1.2.3');
    assert.match(fs.readFileSync(path.join(fixture, 'AGENTS.md'), 'utf8'), /Version\*\*: 1\.2\.3/);
    assert.match(fs.readFileSync(path.join(fixture, 'docs/AISmartRun_PRD.md'), 'utf8'), /版本：1\.2\.3/);
    assert.match(fs.readFileSync(path.join(fixture, 'docs/AISmartRun_PRD_EN.md'), 'utf8'), /Version: 1\.2\.3/);
    assert.throws(
      () => writeAixVersion(fixture, () => '1.2.4'),
      /did not return a UUID v4/,
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('发布验证顺序覆盖三个包并要求中英日 UUID 不同', () => {
  const cn = '9ebc9564-979f-456c-890b-bef2fb47fb00';
  const en = '3cb7b431-236b-47ac-a3b5-e5a64bfde860';
  const ja = '17461e56-3bde-4408-bad3-8e514a17ac6a';
  assert.doesNotThrow(() => assertDistinctAixVersions(cn, en, ja));
  assert.throws(() => assertDistinctAixVersions(cn, cn), /must have distinct UUIDs/);
  assert.throws(() => assertDistinctAixVersions(cn, en, en), /must have distinct UUIDs/);
  assert.throws(() => assertDistinctAixVersions('0.1.31', en), /not a UUID v4/);

  const buildSteps = RELEASE_STEPS.filter(([, command]) => command.includes('build')
    || command.includes('build:en') || command.includes('build:ja'));
  assert.deepEqual(buildSteps, [
    ['Chinese AIX build', ['npm', 'run', 'build']],
    ['English AIX build', ['npm', 'run', 'build:en']],
    ['Japanese AIX build', ['npm', 'run', 'build:ja']],
  ]);
});

test('发布文件名携带 AIUI 产品版本与语言，不再使用 current 等歧义名称', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['inspect:aix:en'], 'node tools/inspect_aix.mjs --en');
  assert.equal(packageJson.scripts['inspect:aix:ja'], 'node tools/inspect_aix.mjs --ja');

  const cnSource = fs.readFileSync(path.join(ROOT, 'tools/pack_aix.mjs'), 'utf8');
  const enSource = fs.readFileSync(path.join(ROOT, 'tools/pack_aix_en.mjs'), 'utf8');
  const jaSource = fs.readFileSync(path.join(ROOT, 'tools/pack_aix_ja.mjs'), 'utf8');
  const inspectSource = fs.readFileSync(path.join(ROOT, 'tools/inspect_aix.mjs'), 'utf8');
  const verifySource = fs.readFileSync(path.join(ROOT, 'tools/verify_release.mjs'), 'utf8');

  assert.match(cnSource, /AISmartRun-AIUI-v\$\{PRODUCT_VERSION\}-cn\.aix/);
  assert.match(enSource, /AISmartRun-AIUI-v\$\{PRODUCT_VERSION\}-\$\{TARGET_LANGUAGE\}\.aix/);
  assert.match(jaSource, /--ja/);
  for (const source of [cnSource, enSource]) {
    assert.match(source, /REQUIRED_APP_PERMISSIONS = \[\]/);
    assert.match(source, /permissions must be exactly/);
  }
  for (const source of [cnSource, enSource, jaSource, inspectSource, verifySource]) {
    assert.doesNotMatch(source, /AISmartRun-current\.aix|AISmartRun-en\.aix/);
  }
});

test('发布契约锁定精简公开 manifest 与本地总结边界', () => {
  const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const englishPacker = fs.readFileSync(path.join(ROOT, 'tools/pack_aix_en.mjs'), 'utf8');

  assert.doesNotMatch(
    agents,
    /\/api\/coach|device_credential|ownership_epoch|data_namespace|durable FIFO/,
    'public Chinese manifest must not expose internal endpoint, identity or queue details',
  );

  assert.match(
    englishPacker,
    /Ending a run freezes a local rules-based summary first/,
    'English packaged AGENTS must retain the local-summary-first boundary',
  );
  assert.match(englishPacker, /running HUD, recovery, summary and settings/);
  assert.match(englishPacker, /remain real-device release gates/);
  assert.doesNotMatch(
    englishPacker,
    /\/api\/coach|device_credential|ownership_epoch|data_namespace/,
    'public locale manifest must not expose internal endpoint or identity-migration details',
  );
});

test('三语随包文案锁定默认沉浸首屏与 HUD 三次独立确认', () => {
  const source = fs.readFileSync(path.join(ROOT, 'tools/pack_aix_en.mjs'), 'utf8');
  const inspector = fs.readFileSync(path.join(ROOT, 'tools/inspect_aix.mjs'), 'utf8');
  assert.match(source, /First and default 480x352 immersive route/);
  assert.match(source, /Second 448x150 compatibility entry/);
  assert.match(source, /Both pages keep title-only metadata/);
  assert.doesNotMatch(source, /not registered as a conversation page tool|no callable page-tool schema/);
  assert.match(source, /const PAGE_DESC_EN = \{\};/);
  for (const phrase of [
    'Press 2 More Times to End',
    'Press 1 More Time to End',
    'Press Confirm 3 Times to End',
    'あと2回押すと終了',
    'あと1回押すと終了',
    '確認キーを3回押して終了',
  ]) {
    assert.ok(source.includes(phrase), `missing localized HUD end copy: ${phrase}`);
  }
  assert.match(inspector, /Press Confirm 3 Times to End/);
  assert.match(inspector, /確認キーを3回押して終了/);
});

test('已退役 lib 排除清单与公开源码互斥，发布代码不得引用', () => {
  // 清单成员必须从公开仓库移除，同时不能被 app.js / pages /
  // 随包 lib 引用——否则公开验证或打包守卫必须拒绝出包。
  for (const orphan of ORPHAN_LIB_FILES) {
    assert.ok(!fs.existsSync(path.join(ROOT, orphan)), `${orphan} must not exist in the public repo`);
  }
  assert.ok(ORPHAN_LIB_FILES.includes('lib/sport_agent.js'),
    '停用的 Sport Agent 源码不得出现在公开仓库或 AIX');
  assert.deepEqual(findOrphanLibReferences(ROOT), []);

  const cnSource = fs.readFileSync(path.join(ROOT, 'tools/pack_aix.mjs'), 'utf8');
  const enSource = fs.readFileSync(path.join(ROOT, 'tools/pack_aix_en.mjs'), 'utf8');
  for (const source of [cnSource, enSource]) {
    assert.match(source, /ORPHAN_LIB_FILES/);
    assert.match(source, /findOrphanLibReferences/);
  }
  // 英文包已不再随包携带 registry.js，本地化清单里不许再出现它。
  assert.doesNotMatch(enSource, /lib\/registry\.js/);
  assert.doesNotMatch(enSource, /replaceText\('lib\/sport_agent\.js'/,
    'orphan 删除后不得再尝试本地化不存在的 Sport Agent 文件');
  // 英文随包元数据只保留公开运行、隐私与证据边界。
  assert.match(enSource, /Network configuration must use HTTPS/);
  assert.match(enSource, /contains no built-in service URL or key/);
  assert.match(enSource, /runtime uses no GPS or route integration/);
  assert.match(enSource, /standard BLE compatibility example/);
  assert.doesNotMatch(enSource, /clearable in-memory run watch|trusted adjacent GPS path segments|one-shot AIUI Geolocation fix/);
  assert.doesNotMatch(enSource, /replaceText\('lib\/weather\.js'/);
  assert.doesNotMatch(enSource, /\/api\/coach|device_credential|ownership_epoch|data_namespace/);
});

test('三语指导与现场日志导出文案完整且无语言泄漏', () => {
  const source = fs.readFileSync(path.join(ROOT, 'tools/pack_aix_en.mjs'), 'utf8');

  for (const pair of [
    ["'日志已保存 · 部分需诊断'", "'Log saved · Some need review'"],
    ["'快速结束已开启 · 指导静音'", "'Quick exit on · Guide muted'"],
    ['<text class="setting-name">指导快速结束</text>', '<text class="setting-name">Quick Guide Exit</text>'],
    ["'跳过热身'", "'Skip Warm-up'"],
    ["'快速完成'", "'Quick Finish'"],
    ["'导出现场日志'", "'Export Field Log'"],
    ["'暂无可导出的跑步日志'", "'No Run Log Available'"],
    ["'完成一次跑步并保存总结后再导出'", "'Complete a Run and Save Its Summary First'"],
    ["'请保持电脑 ADB 实时抓取，看到 END 即完成'", "'Keep ADB Capture Running Until END'"],
    ["'现场日志导出完成'", "'Field Log Export Complete'"],
    ["'现场日志暂时无法导出'", "'Field Log Export Unavailable'"],
    ["'现场日志导出已暂停'", "'Field Log Export Paused'"],
    ['<text class="binding-foot">前后划选择 · 单击执行 · 返回键回设置</text>', '<text class="binding-foot">Swipe to Select · Tap to Run · Back to Settings</text>'],
    ["'前后划选择 · 单击确认 · 返回键退出'", "'Swipe to Select · Tap to Confirm · Back to Exit'"],
    ["'返回键退出 · 双击退出智能体'", "'Back to Exit · Double-tap to Exit'"],
    ["'正在恢复上次记录 · 请重试'", "'Restoring Previous Run · Retry'"],
  ]) {
    assert.ok(source.includes(pair[0]), `missing Chinese localization source: ${pair[0]}`);
    assert.ok(source.includes(pair[1]), `missing English localization target: ${pair[1]}`);
  }

  for (const pair of [
    ['Quick Guide Exit', 'ガイド即終了'],
    ['Est. zone', '推定区間'],
    ['Quick exit on · Guide muted', '即時終了オン · 音声ガイドなし'],
    ['Skip Warm-up', 'ウォームアップを省略'],
    ['Quick Finish', 'すぐ完了'],
    ['Log saved · Some need review', 'ログ保存済み · 一部要確認'],
    ['Recovery Needed', '復旧が必要'],
    ['4 exercises · 15 sec each · 1 min total', '4項目 · 各15秒 · 合計1分'],
    ['Pre-run warm-up has four exercises, fifteen seconds each, one minute total. ', 'ランニング前のウォームアップは4つ、各15秒、合計1分です。'],
    ['Lift knees and swing arms', '膝を上げ、腕を前後に振る'],
    ['Raise heels, lower slowly', 'かかとを上げ、ゆっくり下ろす'],
    ['Bring heels back, alternate sides', 'かかとを後ろへ、左右交互に'],
    ['Bend knees, shift side to side', '膝を曲げ、左右へ重心移動'],
    ['Exercise four, shift weight side to side for fifteen seconds.', '4つ目、左右への重心移動を15秒です。'],
    ['Recovery has four exercises, fifteen seconds each, one minute total. ', 'クールダウンは4つ、各15秒、合計1分です。'],
    ['Walk slowly, swing arms naturally', 'ゆっくり歩き、腕を自然に振る'],
    ['Heel down, switch sides', '後ろのかかとを床につけ、左右を替える'],
    ['Use wall, bend knee, switch sides', '壁に手を添えて膝を曲げ、左右を替える'],
    ['Toes up, switch sides', 'つま先を上げ、左右を替える'],
    ['Exercise four, back thigh stretch, alternate sides for fifteen seconds.', '4つ目、太もも後側を左右交互に15秒伸ばします。'],
    ['Resumed · Auto-start at zero', '再開 · 0秒で自動スタート'],
    ['Resumed · Auto-next after 15 sec', '再開 · 15秒後に自動で次へ'],
    ['Export Field Log', '現場ログを書き出す'],
    ['No Run Log Available', '書き出せるランニングログなし'],
    ['Complete a Run and Save Its Summary First', 'ランニング完了・結果保存後に書き出せます'],
    ['No Log', 'ログなし'],
    ['No Field Log', '現場ログなし'],
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
    ['Swipe to Select · Tap to Confirm · Back to Home', '前後にスワイプ · タップで決定 · 戻るでホーム'],
    ['Swipe to Select · Tap to Confirm · Back to Exit', '前後にスワイプ · タップで決定 · 戻るで終了'],
    ['Back to Exit · Double-tap to Exit', '戻るで終了 · ダブルタップで終了'],
    ['Restoring Previous Run · Retry', '前回の記録を復元中 · 再試行'],
  ]) {
    assert.ok(source.includes(`['${pair[0]}', '${pair[1]}']`),
      `missing exact Japanese localization pair: ${pair[0]}`);
  }

  assert.match(source, /function assertJapaneseGuideLocalization\(\)/);
  assert.match(source, /assertJapaneseGuideLocalization\(\);/);
  assert.match(source, /Japanese guide localization is incomplete/);
  assert.match(source, /function assertBindingExportEnglishLocalization\(\)/);
  assert.match(source, /assertBindingExportEnglishLocalization\(\);/);
  assert.match(source, /English binding-export localization is incomplete/);

  const japaneseGuard = source.slice(
    source.indexOf('function assertJapaneseGuideLocalization()'),
    source.indexOf('function localizeJapanese()'),
  );
  for (const phrase of [
    '現場ログを書き出す',
    '現場ログ書き出し中',
    '現場ログ書き出し完了',
    '現場ログ書き出し一時停止',
    '前後にスワイプ · タップで実行 · 戻るで設定',
    'Export Field Log',
    'Exporting Field Log',
    'Field Log Export Complete',
    'Field Log Export Paused',
    'Swipe to Select · Tap to Run · Back to Settings',
  ]) {
    assert.ok(japaneseGuard.includes(`'${phrase}'`),
      `Japanese binding-export leak guard must include: ${phrase}`);
  }
});

test('AIX 包内检查锁定默认沉浸首屏、兼容首页、多状态路由与停扫生命周期', () => {
  const source = fs.readFileSync(path.join(ROOT, 'tools/inspect_aix.mjs'), 'utf8');
  assert.match(source, /AIX_MANIFEST_FILE/);
  assert.match(source, /calculateManifestPackageId/);
  assert.match(source, /official-compatible manifest digest mismatch/);
  assert.match(source, /package_id does not match its ordered entries/);
  assert.match(source, /reader\.supports_engine\(runtimeVersion\)/);
  for (const version of ['0.14.9', '0.15.0', '0.16.1', '0.17.0']) {
    assert.ok(source.includes(`'${version}'`) || version === '0.16.1',
      `Inspector engine gate must cover ${version}`);
  }
  assert.ok(source.includes("typeof this.enableWorldAwareness !== 'function'"));
  assert.ok(source.includes("typeof this.disableWorldAwareness !== 'function'"));
  assert.match(source, /motionOrientationSensor fallback/);
  assert.ok(source.includes('/this\\.orientationSensor\\s*=(?!=)/'),
    'Inspector must reject assignment to the host orientationSensor');
  assert.ok(source.includes('/this\\.orientationSensor\\s*\\.\\s*stop\\s*\\(/'),
    'Inspector must reject stopping the host orientationSensor');
  assert.match(source, /never assign or stop the host orientationSensor/);
  assert.match(source, /ALLOWED_WXSS_AT_RULES = new Set\(\['import', 'media'\]\)/);
  assert.match(source, /unsupported @media/);
  assert.match(source, /extractMethodBody\(packagedHomeText, 'onTargetChanged'\)/,
    '包内 target 守卫不得依赖会被三语本地化删掉的相邻注释');
  for (const guideAsset of [
    'assets/warmup/march.gif',
    'assets/warmup/calf-raise.gif',
    'assets/warmup/butt-kick.gif',
    'assets/warmup/lateral-shift.gif',
    'assets/recovery/walk.gif',
    'assets/recovery/calf.gif',
    'assets/recovery/quad.gif',
    'assets/recovery/hamstring.gif',
  ]) {
    assert.match(source, new RegExp(guideAsset.replaceAll('.', '\\.')));
  }
  assert.match(source, /inspectGuideGif/);
  assert.match(source, /gif\.loopCount !== 0/);
  assert.match(source, /gif\.visibleFrameCount < 2/);
  assert.match(source, /gif\.uniqueVisibleFrameCount < 2/);
  assert.match(source, /bytes\.length >= 24 \* 1024/);
  assert.match(source, /AIX_UUID_V4_RE/);
  assert.match(source, /\.aixignore must ignore the source VERSION/);
  assert.match(source, /CN and EN AIX packages must have distinct UUIDs/);
  assert.match(source, /AIX permission entries must be bare tokens/);
  assert.match(source, /AIX permissions must be exactly/);
  assert.match(source, /AIX app\.json permissions must be exactly/);
  assert.match(source, /AIX app\.json permissions mismatch/);
  assert.match(source, /product semver mismatch between package\.json and AGENTS\.md/);
  assert.match(source, /'writeHeartRateDevice'/);
  assert.match(source, /'if \(!pref\.deviceId\) return false;'/);
  assert.match(source, /'pref\.deviceId === id'/);
  assert.match(source, /heartDeviceName/);
  assert.match(source, /deviceDisplayName/);
  assert.match(source, /hrSubscribedAtMs/);
  assert.match(source, /m\.bpm <= 0 \|\| m\.bpm >= 255/);
  assert.match(source, /fresh per-call literals/);
  assert.match(source, /fresh per-call literals matching the official sample shapes/);
  assert.match(source, /fresh per-call literals/);
  assert.match(source, /fresh per-call literals matching the official sample shapes/);
  assert.match(source, /scan must not add optionalServices to either scan request/);
  assert.match(source, /scanDiagnostic/);
  assert.match(source, /scanProgressText/);
  assert.match(source, /clearScanRetryTimer/);
  assert.match(source, /scanStartedSuccessfully/);
  assert.match(source, /\[SmartRun BLE\]/);
  for (const event of ['SCAN_REQUEST', 'SCAN_ACTIVE', 'DEVICE_FOUND', 'SCAN_STOPPED']) {
    assert.match(source, new RegExp(event));
  }
  assert.match(source, /must not restore the old scan-stopped\/end helper copy/);
  assert.match(source, /automatic entry deadline or finite search-attempt cap/);
  assert.match(source, /AIX Home wrapper must bottom-align its 448x150 card in the current host viewport/);
  assert.match(source, /AIX Home and immersive canvas surfaces must not draw outer border lines/);
  assert.match(source, /AIX Home must not add visual transitions/);
  assert.match(source, /AIX Home must not restore a post-run summary visual state/);
  assert.match(source, /AIX device networking must use explicit JSON text, a 12s phone-proxy timeout and bounded abort/);
  assert.match(source, /must pin dataType=json and responseType=text/);
  assert.match(source, /defensive JSON decoding for AIUI ArrayBuffer responses/);
  assert.match(source, /AIX Run HUD must remain keyframe\/animation\/gradient-free/);
  assert.match(source, /AIX Run HUD sample-clone Screen 02 must stay transition-free/);
  assert.match(source, /discoveredDevices/);
  assert.match(source, /discoveredDeviceCount/);
  assert.match(source, /recordDiscoveredDevice/);
  assert.match(source, /syncDiscoveredDevices/);
  assert.match(source, /control-card/);
  assert.match(source, /scheduleHrWatchdog/);
  assert.match(source, /clearHrWatchdogTimer/);
  assert.match(source, /pendingEntryBpm = null/);
  assert.match(source, /connectedHoldTimer/);
  assert.match(source, /launchDoneTimer/);
  assert.match(source, /VISUAL_STYLE_MOTION_RE/);
  assert.match(source, /OBSOLETE_VISUAL_MOTION_RE/);
  assert.match(source, /control-card/);
  assert.match(source, /proceedToHud/);
  assert.match(source, /onConnectTap/);
  assert.match(source, /ensureBleAvailable/);
  assert.match(source, /must not pre-probe getAvailability/);
  assert.match(source,
    /must commit custom direction focus only on keyup, preserve host-focus churn safety/);
  assert.match(source, /extractMethodBody/);
  assert.match(source, /extractMethodBody\(packagedRunHud, 'startTicker'\)/);
  assert.match(source, /setInterval\\\(\\\(\\\) => this\\\.requestRunTick/);
  assert.match(source, /stripJsComments/);
  assert.match(source, /summary close copy is stale/);
  assert.match(source, /Press Back to End and Close Agent/);
  assert.match(source, /<view class="connect-next-nav" role="navigation">/);
  assert.match(source, /one main button in a static role=navigation container and dynamic devices outside/);
  assert.match(source, /navigation containers must be static/);
  assert.match(source, /surfacePhase/);
  assert.match(source, /grid-template-columns: 84px 92px 116px 149px;/);
  assert.match(source, /grid-template-columns: 14px 68px 60px 80px 94px 115px;/);
  assert.match(source, /keep a safe numeric pace after trusted motion, expire stale cadence to -- after its short hold/);
  assert.match(source, /five-dot Z5-to-Z1 zone indicator to the left of heart rate/);
  assert.match(source, /show local time without weather or blocking status chips/);
  assert.doesNotMatch(source, /reader\.read_file\('lib\/weather\.js'\)/);
  assert.match(source, /must not request unavailable glasses geolocation or use GPS-derived motion/);
  assert.match(source, /passive metrics must remain borderless and transparent/);
  assert.match(source, /passive Pace Live chip only for live device pace/);
  assert.match(source, /feature menu must expose Free Run, Slow Jog, Indoor Run, Training Plans and Settings/);
  assert.match(source, /Settings must expose exactly six contiguous configuration rows/);
  assert.match(source, /Settings visual order must be Stride, Voice, Metronome, Guide, Binding, passive memory status, Heart, then the absolute Back control/);
  assert.match(source, /six 40px controls plus one 24px passive row, a 264px list, and a 24px footer inside the 480x352 canvas/);
  assert.match(source, /Settings must expose seven interactive targets with inward focus only on the selected target; the long-term-memory row remains passive/);
  assert.match(source, /long-term memory and its backend requirement as non-interactive capability copy/);
  assert.match(source, /settings data layer must keep AI summary and memory-context handling on/);
  assert.match(source, /metronome must ship 175-200ms of 44\.1kHz 16-bit stereo PCM with an audible transient in the first 12ms/);
  assert.match(source, /metronome \$\{bar\.bpm\} BPM four-beat bar is missing or invalid/);
  assert.match(source, /metronome must construct the documented per-BPM four-beat Sound player/);
  assert.match(source, /must stop Sound on hide and destroy the metronome on summary, exit and unload/);
  assert.match(source, /must stop metronome preview when focus leaves index 2 without changing the saved BPM/);
  assert.match(source, /must never auto-start metronome preview on focus or refocus/);
  assert.match(source, /Settings keyboard routing must be stride, voice, metronome, guide, binding, heart and back/);
  assert.match(source, /Settings Back must return to the menu and guard the menu from the same confirmation tail packet/);
  assert.match(source, /Slow Jog must reuse search\/HUD, keep distance disabled and ignore optional RSC speed/);
  assert.match(source, /missing the 456px grid/);
  assert.match(source, /Home slogan must keep the compact single-entry rhythm/);
  assert.match(source, /Home must expose exactly one safe menu entry/);
  assert.match(source, /SURFACE_CONFIRM_DEDUPE_MS/);
  assert.match(source, /Home may use only the fixed bottom wrapper; child positioning and transforms are forbidden/);
  assert.match(source, /must not start interactive BLE APIs from onLoad/);
  assert.match(source, /must cancel its onShow BLE fallback when hidden/);
  assert.match(source, /must start nearby scanning without waiting for the authorized-device cache/);
  assert.match(source, /must not count time before Next enters Screen 03/);
  assert.match(source, /invalidate delayed BLE work when hidden/);
  assert.match(source, /reader\.read_file\('pages\/run_hud\/index\.ink'\)/);
  assert.match(source, /reader\.read_file\('lib\/devices\.js'\)/);
  assert.match(source, /reader\.read_file\('lib\/device_identity\.js'\)/);
  assert.match(source, /reader\.read_file\('lib\/aiui_calibration\.js'\)/);
  assert.match(source, /reader\.read_file\('lib\/run_upload\.js'\)/);
  assert.match(source, /reader\.read_file\('lib\/heart_rate_policy\.js'\)/);
  assert.match(source, /reader\.read_file\('lib\/settings\.js'\)/);
  assert.match(source, /reader\.read_file\('lib\/metronome\.js'\)/);
  assert.doesNotMatch(source, /reader\.read_file\('lib\/weather\.js'\)/);
  assert.match(source, /AIX AIUI calibration must use the scoped batch endpoint/);
  assert.match(source, /AIX heart-rate policy must ship, freeze per run, keep missing policies dark, label estimated zones and reserve personalized coaching for trusted sources/);
  assert.match(source, /AIX AIUI calibration must persist on lifecycle boundaries/);
  assert.match(source, /AIX AIUI calibration must remain local during the run, batch only after Summary/);
  assert.match(source, /reader\.read_file\('assets\/audio\/metro_0468\.wav'\)/);
  assert.match(source, /server-issued identity\/AIUI ID guard/);
  assert.match(source, /DEVICE_REGISTRATION_CREDENTIAL_PATH/);
  assert.match(source, /smartrun_device_credential/);
  assert.match(source, /smartrun_device_registration_candidate/);
  assert.match(source, /device-registration-credential/);
  assert.match(source, /must use the long-lived device_credential contract without registration tickets/);
  assert.match(source, /must not read, simulate, hash or send a hardware serial number/);
  assert.match(source, /clearStorageValueVerified\(storage, AIUI_ID_STORAGE_KEY, ''\)/);
  assert.match(source, /run upload must not use the public AIUI ID/);
  assert.match(source, /Settings must order Stride, Voice, Metronome, Guide, Binding, Heart and Back at indexes 0-6/);
  assert.match(source, /must expose the permanent current AIUI ID and use Confirm only to refresh status/);
  assert.match(source, /fresh anonymous recovery must require userConfirmed/);
  assert.match(source, /Agent Binding Backspace must return to Settings/);
  assert.match(source, /must not retain pair-code, expiry or local binding-window state/);
  assert.match(source, /surfacePhase: 'binding'/);
  assert.match(source, /data-setting="binding"/);
  assert.match(source, /tabindex="5"/);
  assert.match(source, /keep a safe numeric pace after trusted motion, expire stale cadence to -- after its short hold, and never render cadence as a literal zero/);
  assert.match(source, /five-dot Z5-to-Z1 zone indicator to the left of heart rate/);
  assert.match(source, /show local time without weather or blocking status chips/);
  assert.doesNotMatch(source, /weather must use backend GET without glasses coordinates/);
  assert.match(source, /title-only Home fallback reader entry must have no parameters|Home fallback reader parameters must default to an empty object/);
  assert.match(source, /default title-only Run HUD reader entry must have no parameters|immersive reader parameters must default to an empty object/);
  assert.match(source, /single safe entry must keep the AIUI-safe inward focus outline/);
  assert.match(source, /must use the AIUI-safe inward focus outline without a dynamic border/);
  assert.match(source, /reader tool layout mismatch/);
  assert.match(source, /expectedPageSizes/);
  assert.match(source, /\['pages\/run_hud\/index', '_blank'\]/);
  assert.match(source, /\['pages\/index\/index', '_current'\]/);
  assert.match(source, /leading style comment/);
  for (const oldPage of ['bluetooth', 'settings', 'coach', 'hr_card']) {
    assert.doesNotMatch(source, new RegExp(`pages/${oldPage}/index`));
  }
});

test('AIUI doctor 同步守住 Home 贴底、画布无外框与生产页静态搜索', () => {
  const source = fs.readFileSync(path.join(ROOT, 'tools/aiui_doctor.mjs'), 'utf8');
  assert.match(source, /ALLOWED_WXSS_AT_RULES = new Set\(\['import', 'media'\]\)/);
  assert.match(source, /unsupported @media/);
  assert.match(source, /extractMethodBody\(homeText, 'onTargetChanged'\)/,
    '源码 target 守卫必须按方法体解析，不能依赖相邻注释');
  assert.match(source, /official AIX preview CLI/);
  assert.match(source, /official-compatible readable AIX packer/);
  assert.ok(
    source.includes('/compressionMethod\\s*!==\\s*8/'),
    'Doctor must recognize the Deflate compression gate in the readable packer',
  );
  assert.match(source, /readable JS\/Ink\/WXSS/);
  assert.ok(source.includes("typeof this.enableWorldAwareness !== 'function'"));
  assert.ok(source.includes("typeof this.disableWorldAwareness !== 'function'"));
  assert.match(source, /motionOrientationSensor fallback/);
  assert.ok(source.includes('/this\\.orientationSensor\\s*=(?!=)/'),
    'Doctor must reject assignment to the host orientationSensor');
  assert.ok(source.includes('/this\\.orientationSensor\\s*\\.\\s*stop\\s*\\(/'),
    'Doctor must reject stopping the host orientationSensor');
  assert.match(source, /never assign or stop the host orientationSensor/);
  assert.match(source, /PREVIEW_WIDTH\\s\*=\\s\*480/);
  assert.match(source, /PREVIEW_HEIGHT\\s\*=\\s\*352/);
  assert.match(source, /app\.json must keep the exact two-page route order|app\.json pages must register run_hud first for direct immersion/);
  assert.match(source, /title-only 448x150 compatibility fallback|index fallback must stay title-only/);
  assert.match(source, /first parameterless route derives _blank|first parameterless Reader route derives _blank/);

  for (const guideAsset of [
    'assets/warmup/march.gif',
    'assets/warmup/calf-raise.gif',
    'assets/warmup/butt-kick.gif',
    'assets/warmup/lateral-shift.gif',
    'assets/recovery/walk.gif',
    'assets/recovery/calf.gif',
    'assets/recovery/quad.gif',
    'assets/recovery/hamstring.gif',
  ]) {
    assert.match(source, new RegExp(guideAsset.replaceAll('.', '\\.')));
  }
  assert.match(source, /inspectGuideGif/);
  assert.match(source, /gif\.loopCount !== 0/);
  assert.match(source, /gif\.visibleFrameCount < 2/);
  assert.match(source, /gif\.uniqueVisibleFrameCount < 2/);
  assert.match(source, /8 compact infinite-loop 160x160 GIFs with visible motion/);

  assert.match(source, /\.home-wrap must keep a 448px card bottom-aligned in the host viewport/);
  assert.match(source, /home wrap must bottom-align the 448x150 card in expanded hosts/);
  assert.match(source, /Home and immersive canvas surfaces must not draw outer border lines/);
  assert.match(source, /Home must not animate or transition/);
  assert.match(source, /must not restore a post-run summary visual state/);
  assert.match(source, /sample-clone Screen 02 must stay transition-free/);
  assert.match(source, /Browser previews are review-only artifacts/);
  assert.match(source, /production \.ink pages above remain the sole runtime motion gate/);
  assert.match(source, /app\.json permissions must be exactly/);
  assert.match(source, /no glasses location permission/);
  assert.match(source, /must not request unavailable glasses geolocation or use GPS-derived motion/);
  assert.match(source, /check\('static production UI'/);
  assert.match(source, /Production \.ink is motion-free; browser previews are review-only/);
  assert.match(source, /freezeHeartRatePolicyForRun/);
  assert.match(source, /heartRatePolicyConfidence/);
  assert.match(source, /conservative high-heart-rate safety copy/);
  assert.match(source, /discoveredDevices/);
  assert.match(source, /discoveredDeviceCount/);
  assert.match(source, /recordDiscoveredDevice/);
  assert.match(source, /syncDiscoveredDevices/);
  assert.match(source, /fresh per-call literals/);
  assert.match(source, /fresh per-call literals matching the official sample shapes/);
  assert.match(source, /fresh per-call literals/);
  assert.match(source, /fresh per-call literals matching the official sample shapes/);
  assert.match(source, /scan must not add optionalServices to either scan request/);
  assert.match(source, /scanDiagnostic/);
  assert.match(source, /\[SmartRun BLE\]/);
  for (const event of ['SCAN_REQUEST', 'SCAN_ACTIVE', 'DEVICE_FOUND', 'SCAN_STOPPED']) {
    assert.match(source, new RegExp(event));
  }
  assert.match(source, /等待附近设备广播/);
  assert.match(source, /must not restore the old scan-stopped\/end helper copy/);
  assert.match(source, /当前无法搜索蓝牙设备/);
  assert.match(source, /搜索失败，可使用眼镜估算/);
  assert.match(source, /clearScanRetryTimer/);
  assert.match(source, /scanStartedSuccessfully/);
  assert.match(source, /extractMethodBody\(text, 'startTicker'\)/);
  assert.match(source, /setInterval\\\(\\\(\\\) => this\\\.requestRunTick/);
  assert.match(source, /control-card/);
  assert.match(source, /Settings must order Stride, Voice, Metronome, Guide, Binding, Heart and Back at indexes 0-6/);
  assert.match(source, /permanent current AIUI ID; Confirm refreshes status only when Refresh is focused; Export must use the separate focused field-log action with bounded completion and leave\/hide cancellation/);
  assert.match(source, /fresh anonymous recovery must require userConfirmed/);
  assert.match(source, /Agent Binding Backspace must return to Settings/);
  assert.match(source, /tabindex="5"/);
  assert.match(source, /passive metrics must remain borderless and transparent/);
  assert.match(source, /expose Pace Live only for live device pace/);
  assert.match(source, /feature menu must expose Free Run, Slow Jog, Indoor Run, Training Plans and Settings/);
  assert.match(source, /Settings must expose exactly six contiguous configuration rows/);
  assert.match(source, /Settings visual order must be Stride, Voice, Metronome, Guide, Binding, passive memory status, Heart, then the absolute Back control/);
  assert.match(source, /six 40px controls plus one 24px passive row, a 264px list, and a 24px footer inside the 480x352 canvas/);
  assert.match(source, /Settings must expose seven interactive targets with inward focus only on the selected target; the long-term-memory row remains passive/);
  assert.match(source, /long-term memory and its backend requirement as non-interactive capability copy/);
  assert.match(source, /settings data layer must keep AI summary and memory-context handling on/);
  assert.match(source, /metronome must ship the low-latency APK one-shot plus tail-trimmed 160\/170\/180 BPM four-beat stereo PCM bars/);
  assert.match(source, /metronome must construct the documented per-BPM four-beat Sound player/);
  assert.match(source, /must stop Sound on hide and destroy the metronome on summary, exit and unload/);
  assert.match(source, /must stop metronome preview when focus leaves index 2 without changing the saved BPM/);
  assert.match(source, /must never auto-start metronome preview on focus or refocus/);
  assert.match(source, /Settings keyboard routing must be stride, voice, metronome, guide, binding, heart and back/);
  assert.match(source, /Settings Back must return to the menu and guard the menu from the same confirmation tail packet/);
  assert.match(source, /AIUI calibration must use the scoped batch endpoint/);
  assert.match(source, /AIUI calibration must persist on lifecycle boundaries/);
  assert.match(source, /AIUI calibration must remain local during the run, batch only after Summary/);
  assert.match(source, /keep a safe numeric pace after trusted motion, expire stale cadence to -- after its short hold, and never render cadence as a literal zero/);
  assert.match(source, /Slow Jog must reuse search\/HUD, keep distance disabled and ignore optional RSC speed/);
});
