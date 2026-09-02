import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  AIX_VARIANTS,
  ENGLISH_FORBIDDEN_UI_COPY,
  ENGLISH_LOCALIZED_FILES,
  ENGLISH_REQUIRED_MARKERS,
  ENGLISH_STORE_DESCRIPTION,
  JAPANESE_FORBIDDEN_UI_COPY,
  JAPANESE_LOCALIZED_FILES,
  JAPANESE_REQUIRED_MARKERS,
  JAPANESE_STORE_DESCRIPTION,
  assertJapaneseRuntimeCopy,
  assertEnglishRuntimeCopy,
  localizeEnglishStage,
  localizeEnglishText,
  localizeJapaneseStage,
  localizeJapaneseText,
  resolveAixVariant,
} from '../tools/aix_locales.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('AIX variants keep one semver with isolated Chinese, Japanese and English identities', () => {
  assert.deepEqual(AIX_VARIANTS.cn, {
    key: 'cn',
    suffix: 'cn',
    locale: 'zh-CN',
    transformVersion: 'cn-identity-v1',
    rideTitle: 'AIBike AI 骑行',
  });
  assert.deepEqual(AIX_VARIANTS.ja, {
    key: 'ja',
    suffix: 'ja',
    locale: 'ja-JP',
    transformVersion: 'ja-localization-v1',
    rideTitle: 'AIBike AIサイクリング',
  });
  assert.deepEqual(AIX_VARIANTS.en, {
    key: 'en',
    suffix: 'en',
    locale: 'en-US',
    transformVersion: 'en-localization-v1',
    rideTitle: 'AIBike AI Cycling',
  });
  assert.equal(resolveAixVariant([]), AIX_VARIANTS.cn);
  assert.equal(resolveAixVariant(['--cn']), AIX_VARIANTS.cn);
  assert.equal(resolveAixVariant(['--locale=zh-CN']), AIX_VARIANTS.cn);
  assert.equal(resolveAixVariant(['--ja']), AIX_VARIANTS.ja);
  assert.equal(resolveAixVariant(['--locale=ja-JP']), AIX_VARIANTS.ja);
  assert.equal(resolveAixVariant(['--en']), AIX_VARIANTS.en);
  assert.equal(resolveAixVariant(['--locale=en-US']), AIX_VARIANTS.en);
  assert.throws(() => resolveAixVariant(['--cn', '--en']), /Conflicting|exactly one/i);
  assert.throws(() => resolveAixVariant(['--locale=fr-FR']), /Unsupported AIX locale/);
  assert.ok(Buffer.byteLength(JAPANESE_STORE_DESCRIPTION, 'utf8') <= 200);
  assert.ok(Buffer.byteLength(ENGLISH_STORE_DESCRIPTION, 'utf8') <= 200);
});

test('English localization covers Home, HUD, guides, summaries, TTS, logs and model prompts', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aibike-en-stage-'));
  try {
    for (const rel of ENGLISH_LOCALIZED_FILES) {
      const source = path.join(ROOT, rel);
      const target = path.join(fixture, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(fixture, 'package.json'));
    localizeEnglishStage(fixture);
    assert.doesNotThrow(() => assertEnglishRuntimeCopy(fixture));
    const sportAgent = fs.readFileSync(path.join(fixture, 'lib/sport_agent.js'), 'utf8');
    assert.match(sportAgent, /SPORT_AGENT_LOCALE = 'en-US'/);
    assert.doesNotMatch(sportAgent, /SPORT_AGENT_LOCALE = 'zh-CN'/);
    assert.match(sportAgent, /locale: SPORT_AGENT_LOCALE/);
    assert.match(sportAgent, /data\.locale !== SPORT_AGENT_LOCALE/);
    assert.equal((sportAgent.match(/data\.locale !== SPORT_AGENT_LOCALE/g) || []).length, 3);

    const localized = ENGLISH_LOCALIZED_FILES.map(
      (rel) => fs.readFileSync(path.join(fixture, rel), 'utf8'),
    ).join('\n');
    for (const marker of ['keyBeacon', 'markBeacon', 'beacon-hint']) {
      assert.ok(!localized.includes(marker), `English stage must not expose ${marker}`);
    }
    for (const marker of ENGLISH_REQUIRED_MARKERS) assert.ok(localized.includes(marker));
    for (const marker of [
      'Local diagnostics',
      'Diagnostics stay on this device and are not written to logs',
    ]) assert.ok(localized.includes(marker));
    for (const copy of ENGLISH_FORBIDDEN_UI_COPY) assert.ok(!localized.includes(copy));
    const pkg = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8'));
    assert.equal(pkg.description, ENGLISH_STORE_DESCRIPTION);
    assert.match(localized, /\[A-Za-z\]/);
    assert.match(localized, /advice\|review\|summary/i);

    const advice = await import(
      `${pathToFileURL(path.join(fixture, 'lib/ride_ai_advice.js')).href}?english-stage=1`,
    );
    assert.equal(
      advice.sanitizeRideAiAdviceText('Ride advice: Keep an easy gear and hydrate.'),
      'Keep an easy gear and hydrate.',
    );
    assert.equal(
      advice.sanitizeRideAiAdviceText('You have arrhythmia; take medication.'),
      '',
    );
    assert.equal(
      advice.sanitizeRideAiAdviceText('The weather is calm, so ride faster.'),
      '',
    );
    assert.equal(
      advice.sanitizeRideAiAdviceText('You will improve speed by 10% next time.'),
      '',
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('Japanese localization covers Home, HUD, guides, summary, TTS and test-log semantics', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aibike-ja-stage-'));
  try {
    for (const rel of JAPANESE_LOCALIZED_FILES) {
      const source = path.join(ROOT, rel);
      const target = path.join(fixture, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(fixture, 'package.json'));
    localizeJapaneseStage(fixture);
    assert.doesNotThrow(() => assertJapaneseRuntimeCopy(fixture));
    const sportAgent = fs.readFileSync(path.join(fixture, 'lib/sport_agent.js'), 'utf8');
    assert.match(sportAgent, /SPORT_AGENT_LOCALE = 'ja-JP'/);
    assert.doesNotMatch(sportAgent, /SPORT_AGENT_LOCALE = 'zh-CN'/);
    assert.match(sportAgent, /locale: SPORT_AGENT_LOCALE/);
    assert.match(sportAgent, /data\.locale !== SPORT_AGENT_LOCALE/);
    assert.equal((sportAgent.match(/data\.locale !== SPORT_AGENT_LOCALE/g) || []).length, 3);

    const localized = JAPANESE_LOCALIZED_FILES.map(
      (rel) => fs.readFileSync(path.join(fixture, rel), 'utf8'),
    ).join('\n');
    for (const marker of ['keyBeacon', 'markBeacon', 'beacon-hint']) {
      assert.ok(!localized.includes(marker), `Japanese stage must not expose ${marker}`);
    }
    for (const marker of JAPANESE_REQUIRED_MARKERS) assert.ok(localized.includes(marker));
    for (const marker of [
      'ローカル診断',
      '診断は端末内にのみ保存し、ログには出力しません',
    ]) assert.ok(localized.includes(marker));
    for (const copy of JAPANESE_FORBIDDEN_UI_COPY) assert.ok(!localized.includes(copy));
    const pkg = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8'));
    assert.equal(pkg.description, JAPANESE_STORE_DESCRIPTION);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('Japanese transform preserves metric units and localized page markers', () => {
  const sample = localizeJapaneseText(
    'AI 骑行 · 速度 18.2 km/h · 踏频 82 rpm · 距离 3.40 km · 心率 128 bpm',
  );
  assert.equal(
    sample,
    'AIサイクリング · 速度 18.2 km/h · 回転数 82 rpm · 距離 3.40 km · 心拍 128 bpm',
  );

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aibike-ja-markers-'));
  try {
    for (const rel of JAPANESE_LOCALIZED_FILES) {
      const source = path.join(ROOT, rel);
      const target = path.join(fixture, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(fixture, 'package.json'));
    localizeJapaneseStage(fixture);
    const pages = [
      fs.readFileSync(path.join(fixture, 'pages/index/index.ink'), 'utf8'),
      fs.readFileSync(path.join(fixture, 'pages/ride_hud/index.ink'), 'utf8'),
    ].join('\n');
    for (const unit of ['km/h', 'rpm', 'km', 'bpm']) assert.ok(pages.includes(unit));
    for (const marker of JAPANESE_REQUIRED_MARKERS) assert.ok(pages.includes(marker));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('English transform preserves metric units and localized page markers', () => {
  const sample = localizeEnglishText(
    'AI 骑行 · 速度 18.2 km/h · 踏频 82 rpm · 距离 3.40 km · 心率 128 bpm',
  );
  assert.equal(
    sample,
    'AI Cycling · Speed 18.2 km/h · Cadence 82 rpm · Distance 3.40 km · Heart Rate 128 bpm',
  );

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aibike-en-markers-'));
  try {
    for (const rel of ENGLISH_LOCALIZED_FILES) {
      const source = path.join(ROOT, rel);
      const target = path.join(fixture, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(fixture, 'package.json'));
    localizeEnglishStage(fixture);
    const pages = [
      fs.readFileSync(path.join(fixture, 'pages/index/index.ink'), 'utf8'),
      fs.readFileSync(path.join(fixture, 'pages/ride_hud/index.ink'), 'utf8'),
    ].join('\n');
    for (const unit of ['km/h', 'rpm', 'km', 'bpm']) assert.ok(pages.includes(unit));
    for (const marker of ENGLISH_REQUIRED_MARKERS.filter(
      (candidate) => candidate !== 'one English sentence',
    )) assert.ok(pages.includes(marker));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('Sport Agent recovery states are translated as complete English and Japanese phrases', () => {
  const cases = [
    ['上次总结待同步', 'Previous summary awaiting sync', '前回の結果は同期待ち'],
    ['恢复未完成骑行', 'Recover unfinished ride', '未完了ライドを復旧'],
    ['等待总结同步', 'Waiting for summary sync', '結果の同期を待機中'],
    ['需结束上次骑行', 'End previous ride first', '前回のライドを終了してください'],
    ['恢复已确认训练', 'Resume confirmed workout', '確認済みワークアウトを復旧'],
    [
      '点击重试同步 · 确认后可再骑',
      'Press to retry sync · Ride again after sync',
      '押して同期を再試行 · 完了後に次のライドへ',
    ],
    [
      '点击安全结束 · 总结待同步',
      'Press to end safely · Summary awaits sync',
      '押して安全に終了 · 結果は同期待ち',
    ],
    [
      '已保留开骑确认 · 点击继续',
      'Start confirmation saved · Press to continue',
      '開始確認を保存済み · 押して続行',
    ],
  ];
  for (const [source, english, japanese] of cases) {
    assert.equal(localizeEnglishText(source), english);
    assert.equal(localizeJapaneseText(source), japanese);
  }
});
