import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AIX_LOCALES,
  AIX_PROVENANCE_FILE,
  AIX_TRANSFORM_VERSIONS,
  computeAixTreeSha256,
  computeReleaseSourceTreeSha256,
  createAixProvenance,
  parseAndVerifyAixProvenance,
} from '../tools/aix_provenance.mjs';

function makeSourceTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aismartrun-provenance-'));
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aixignore'), 'VERSION\n');
  fs.writeFileSync(path.join(root, 'assets/tone.wav'), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(root, 'lib/runtime.js'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'lib/orphan.js'), 'test only\n');
  fs.writeFileSync(path.join(root, 'pages/index.ink'), '<page>home</page>\n');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agent\n');
  fs.writeFileSync(path.join(root, 'app.js'), 'export default {};\n');
  fs.writeFileSync(path.join(root, 'app.json'), '{"pages":["pages/index"]}\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}\n');
  fs.writeFileSync(path.join(root, 'VERSION'), 'uuid-one\n');
  return root;
}

test('发布源码树 SHA-256 稳定排序，忽略 VERSION、provenance 与明确孤儿模块', () => {
  const root = makeSourceTree();
  try {
    const entries = [
      '.aixignore',
      'assets',
      'lib',
      'pages',
      'AGENTS.md',
      'app.js',
      'app.json',
      'package.json',
      'VERSION',
    ];
    const options = {
      entries,
      excludedPaths: ['lib/orphan.js'],
    };
    const first = computeReleaseSourceTreeSha256(root, options);
    fs.writeFileSync(path.join(root, 'VERSION'), 'uuid-two\n');
    fs.writeFileSync(path.join(root, AIX_PROVENANCE_FILE), '{"ignored":true}\n');
    fs.writeFileSync(path.join(root, 'lib/orphan.js'), 'changed test only\n');
    assert.equal(computeReleaseSourceTreeSha256(root, options), first);

    fs.writeFileSync(path.join(root, 'lib/runtime.js'), 'export const value = 2;\n');
    assert.notEqual(computeReleaseSourceTreeSha256(root, options), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('payload 树哈希拒绝重复路径，并能检测任意运行时字节变化', () => {
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

test('provenance 同时锁定 locale、transform、当前源码与包内 payload', () => {
  const sourceHash = '1'.repeat(64);
  const payloadHash = '2'.repeat(64);
  const provenance = createAixProvenance({
    locale: AIX_LOCALES.en,
    sourceTreeSha256: sourceHash,
    payloadTreeSha256: payloadHash,
  });
  assert.deepEqual(provenance, {
    schemaVersion: 1,
    locale: 'en-US',
    transformVersion: AIX_TRANSFORM_VERSIONS['en-US'],
    sourceTreeSha256: sourceHash,
    payloadTreeSha256: payloadHash,
  });
  assert.deepEqual(
    parseAndVerifyAixProvenance(JSON.stringify(provenance), {
      expectedLocale: AIX_LOCALES.en,
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
    () => parseAndVerifyAixProvenance(provenance, {
      expectedLocale: AIX_LOCALES.cn,
    }),
    /locale mismatch/,
  );
});
