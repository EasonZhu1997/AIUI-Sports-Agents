import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AIX_LOCALE,
  AIX_LOCALES,
  AIX_PROVENANCE_FILE,
  AIX_PROVENANCE_SCHEMA_VERSION,
  AIX_RELEASE_SOURCE_ENTRIES,
  AIX_TRANSFORM_VERSION,
  AIX_TRANSFORM_VERSIONS,
  computeAixTreeSha256,
  computeReleaseSourceTreeSha256,
  createAixProvenance,
  parseAndVerifyAixProvenance,
  writeAixProvenance,
} from '../tools/aix_provenance.mjs';

function writeFixture(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function makeSourceTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibike-provenance-'));
  writeFixture(root, '.aixignore', 'VERSION\n');
  writeFixture(root, 'assets/audio/NOTICE.md', 'audio notice\n');
  writeFixture(root, 'lib/runtime.js', 'export const value = 1;\n');
  writeFixture(root, 'lib/unused.js', 'test only\n');
  writeFixture(root, 'pages/index/index.ink', '<page>home</page>\n');
  writeFixture(root, 'pages/ride_hud/index.ink', '<page>ride</page>\n');
  writeFixture(root, 'AGENTS.md', '# Agent\n');
  writeFixture(root, 'LICENSE', 'PolyForm Noncommercial License 1.0.0\n');
  writeFixture(root, 'COPYRIGHT', 'Copyright (c) 2026 Yixiao Zhu.\n');
  writeFixture(root, 'COMMERCIAL_LICENSE.md', '# Commercial licensing\n');
  writeFixture(root, 'TRADEMARKS.md', '# Trademarks\n');
  writeFixture(root, 'app.js', 'export default {};\n');
  writeFixture(
    root,
    'app.json',
    '{"pages":["pages/index/index","pages/ride_hud/index"]}\n',
  );
  writeFixture(root, 'package.json', '{"name":"AIBike","version":"0.1.18"}\n');
  writeFixture(root, 'VERSION', 'uuid-one\n');
  return root;
}

test('AIBike source-tree SHA-256 is stable and excludes package identity and unused libs', () => {
  const root = makeSourceTree();
  try {
    assert.deepEqual(AIX_RELEASE_SOURCE_ENTRIES, [
      '.aixignore',
      'assets/audio',
      'lib',
      'pages',
      'AGENTS.md',
      'LICENSE',
      'COPYRIGHT',
      'COMMERCIAL_LICENSE.md',
      'TRADEMARKS.md',
      'app.js',
      'app.json',
      'package.json',
      'VERSION',
    ]);
    const options = { excludedPaths: ['lib/unused.js'] };
    const first = computeReleaseSourceTreeSha256(root, options);
    writeFixture(root, 'VERSION', 'uuid-two\n');
    writeFixture(root, AIX_PROVENANCE_FILE, '{"ignored":true}\n');
    writeFixture(root, 'lib/unused.js', 'changed test only\n');
    assert.equal(computeReleaseSourceTreeSha256(root, options), first);

    writeFixture(root, 'lib/runtime.js', 'export const value = 2;\n');
    assert.notEqual(computeReleaseSourceTreeSha256(root, options), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('payload-tree SHA-256 rejects duplicate ZIP paths and detects runtime byte changes', () => {
  const original = [
    { path: 'app.js', bytes: Buffer.from('one') },
    { path: 'VERSION', bytes: Buffer.from('ignored-a') },
    { path: AIX_PROVENANCE_FILE, bytes: Buffer.from('ignored-b') },
  ];
  const expected = computeAixTreeSha256(original);
  assert.equal(
    computeAixTreeSha256([...original].reverse()),
    expected,
    'ZIP entry order must not affect the payload digest',
  );
  assert.notEqual(
    computeAixTreeSha256([{ path: 'app.js', bytes: Buffer.from('two') }]),
    expected,
  );
  assert.throws(
    () => computeAixTreeSha256([
      { path: 'app.js', bytes: Buffer.from('one') },
      { path: 'app.js', bytes: Buffer.from('two') },
    ]),
    /duplicate file entry/,
  );
});

test('Chinese/Japanese/English provenance verifies locale-specific transforms and both tree hashes', () => {
  const sourceHash = '1'.repeat(64);
  const payloadHash = '2'.repeat(64);
  const provenance = createAixProvenance({
    sourceTreeSha256: sourceHash,
    payloadTreeSha256: payloadHash,
  });
  assert.deepEqual(provenance, {
    schemaVersion: AIX_PROVENANCE_SCHEMA_VERSION,
    locale: AIX_LOCALE,
    transformVersion: AIX_TRANSFORM_VERSION,
    sourceTreeSha256: sourceHash,
    payloadTreeSha256: payloadHash,
  });
  assert.equal(AIX_LOCALE, 'zh-CN');
  assert.equal(AIX_TRANSFORM_VERSION, 'cn-identity-v1');
  assert.deepEqual(AIX_LOCALES, { cn: 'zh-CN', ja: 'ja-JP', en: 'en-US' });
  assert.equal(AIX_TRANSFORM_VERSIONS['ja-JP'], 'ja-localization-v1');
  assert.equal(AIX_TRANSFORM_VERSIONS['en-US'], 'en-localization-v1');
  assert.deepEqual(
    parseAndVerifyAixProvenance(JSON.stringify(provenance), {
      currentSourceTreeSha256: sourceHash,
      packagedPayloadTreeSha256: payloadHash,
    }),
    provenance,
  );
  assert.throws(
    () => parseAndVerifyAixProvenance(provenance, {
      currentSourceTreeSha256: '3'.repeat(64),
    }),
    /source is stale/,
  );
  const japanese = createAixProvenance({
    locale: AIX_LOCALES.ja,
    sourceTreeSha256: sourceHash,
    payloadTreeSha256: '5'.repeat(64),
  });
  assert.equal(japanese.locale, 'ja-JP');
  assert.equal(japanese.transformVersion, 'ja-localization-v1');
  assert.deepEqual(
    parseAndVerifyAixProvenance(japanese, {
      expectedLocale: AIX_LOCALES.ja,
      currentSourceTreeSha256: sourceHash,
      packagedPayloadTreeSha256: '5'.repeat(64),
    }),
    japanese,
  );
  const english = createAixProvenance({
    locale: AIX_LOCALES.en,
    sourceTreeSha256: sourceHash,
    payloadTreeSha256: '6'.repeat(64),
  });
  assert.equal(english.locale, 'en-US');
  assert.equal(english.transformVersion, 'en-localization-v1');
  assert.deepEqual(
    parseAndVerifyAixProvenance(english, {
      expectedLocale: AIX_LOCALES.en,
      currentSourceTreeSha256: sourceHash,
      packagedPayloadTreeSha256: '6'.repeat(64),
    }),
    english,
  );
  assert.throws(
    () => parseAndVerifyAixProvenance(japanese, {
      expectedLocale: AIX_LOCALES.cn,
    }),
    /locale mismatch/,
  );
  assert.throws(
    () => parseAndVerifyAixProvenance(provenance, {
      packagedPayloadTreeSha256: '4'.repeat(64),
    }),
    /payload integrity mismatch/,
  );
  assert.throws(
    () => parseAndVerifyAixProvenance({
      ...provenance,
      transformVersion: 'old-transform',
    }),
    /transform version mismatch/,
  );
  assert.throws(
    () => parseAndVerifyAixProvenance({
      ...provenance,
      locale: 'fr-FR',
    }),
    /Unsupported AIX provenance locale/,
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibike-provenance-write-'));
  try {
    writeAixProvenance(root, provenance);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, AIX_PROVENANCE_FILE), 'utf8')),
      provenance,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
