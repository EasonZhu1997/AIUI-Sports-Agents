import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AIX_LOCALES,
  AIX_PROVENANCE_FILE,
  AIX_TRANSFORM_VERSIONS,
} from '../tools/aix_provenance.mjs';
import {
  PUBLIC_BETA_STATUS,
  assertCleanGitStatus,
  assertGitSource,
  assertSourceVersionMatches,
  buildPublicBetaManifest,
  countZipEntries,
  createPublicBetaCandidate,
  getReleaseNames,
} from '../tools/beta_release.mjs';

const CN_UUID = '1a33d75a-1a60-44e6-931d-5f244ac9a58a';
const EN_UUID = '4f10cecb-cf18-455c-8164-8525a090c25b';
const JA_UUID = '65f3443e-a44e-4f85-a815-c6074bd137d2';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const SOURCE_TREE_SHA256 = '1'.repeat(64);

function artifact(fileName, uuid, language = fileName.endsWith('-cn.aix')
  ? 'cn' : (fileName.endsWith('-ja.aix') ? 'ja' : 'en')) {
  const locale = language === 'cn'
    ? AIX_LOCALES.cn : (language === 'ja' ? AIX_LOCALES.ja : AIX_LOCALES.en);
  return {
    fileName,
    bytes: 1234,
    sha256: 'a'.repeat(64),
    aixVersionUuid: uuid,
    entryCount: 47,
    schemaVersion: 1,
    locale,
    transformVersion: AIX_TRANSFORM_VERSIONS[locale],
    sourceTreeSha256: SOURCE_TREE_SHA256,
    payloadTreeSha256: (language === 'cn' ? '2' : (language === 'ja' ? '4' : '3')).repeat(64),
  };
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aismartrun-beta-'));
  const release = path.join(root, 'release');
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    '{"name":"AISmartRun","version":"1.2.3"}\n',
  );
  fs.writeFileSync(path.join(root, 'VERSION'), `${CN_UUID}\n`);
  const names = getReleaseNames('1.2.3');
  fs.writeFileSync(path.join(release, names.cn), 'cn-aix-fixture');
  fs.writeFileSync(path.join(release, names.en), 'en-aix-fixture');
  fs.writeFileSync(path.join(release, names.ja), 'ja-aix-fixture');
  return { root, release, names };
}

function fakeCommands({ status = '', inspectError = null } = {}) {
  return (command, args) => {
    if (command === 'git' && args[0] === 'status') return status;
    if (command === 'git' && args[0] === 'rev-parse') return `${COMMIT}\n`;
    if (command === 'git' && args[0] === 'symbolic-ref') return 'codex/public-beta-v1.2.3\n';
    if (command === process.execPath && args[0].endsWith('tools/inspect_aix.mjs')) {
      if (inspectError) throw new Error(inspectError);
      return 'AIX OK\n';
    }
    if (command === 'unzip' && args[0] === '-p') {
      if (args[2] === AIX_PROVENANCE_FILE) {
        const language = args[1].endsWith('-cn.aix')
          ? 'cn' : (args[1].endsWith('-ja.aix') ? 'ja' : 'en');
        return JSON.stringify(artifact(
          path.basename(args[1]),
          language === 'cn' ? CN_UUID : (language === 'ja' ? JA_UUID : EN_UUID),
          language,
        ));
      }
      return args[1].endsWith('-cn.aix')
        ? `${CN_UUID}\n` : (args[1].endsWith('-ja.aix') ? `${JA_UUID}\n` : `${EN_UUID}\n`);
    }
    if (command === 'unzip' && args[0] === '-Z1') {
      return 'AGENTS.md\nVERSION\napp.json\n';
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
}

test('纯函数锁定产品版本、Git 身份、ZIP entryCount 与脏树 fail closed', () => {
  assert.deepEqual(getReleaseNames('1.2.3'), {
    cn: 'AISmartRun-AIUI-v1.2.3-cn.aix',
    en: 'AISmartRun-AIUI-v1.2.3-en.aix',
    ja: 'AISmartRun-AIUI-v1.2.3-ja.aix',
    directory: 'public-beta-v1.2.3',
  });
  assert.deepEqual(assertGitSource({
    commit: COMMIT,
    branch: 'codex/public-beta-v1.2.3',
  }), {
    commit: COMMIT,
    branch: 'codex/public-beta-v1.2.3',
    clean: true,
  });
  assert.equal(assertCleanGitStatus(''), true);
  assert.throws(
    () => assertCleanGitStatus(' M pages/run_hud/index.ink'),
    /must be clean/,
  );
  assert.throws(
    () => assertGitSource({ commit: COMMIT, branch: 'HEAD' }),
    /named Git branch/,
  );
  assert.equal(countZipEntries('AGENTS.md\nVERSION\napp.json\n'), 3);
  assert.throws(() => countZipEntries('\n'), /no readable ZIP entries/);
  assert.throws(() => getReleaseNames('../1.2.3'), /Invalid product semver/);
  assert.equal(assertSourceVersionMatches(CN_UUID, CN_UUID), CN_UUID);
  assert.throws(
    () => assertSourceVersionMatches(CN_UUID, EN_UUID),
    /must match the verified CN AIX UUID/,
  );
});

test('manifest 明确本地未签名边界、外部验收项和三语 AIX 证据', () => {
  const names = getReleaseNames('1.2.3');
  const manifest = buildPublicBetaManifest({
    productVersion: '1.2.3',
    generatedAt: '2026-07-25T01:02:03.000Z',
    source: {
      commit: COMMIT,
      branch: 'codex/public-beta-v1.2.3',
      clean: true,
    },
    artifacts: {
      cn: artifact(names.cn, CN_UUID),
      en: artifact(names.en, EN_UUID),
      ja: artifact(names.ja, JA_UUID),
    },
  });

  assert.equal(manifest.productVersion, '1.2.3');
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.candidateStatus, PUBLIC_BETA_STATUS);
  assert.equal(manifest.generatedAt, '2026-07-25T01:02:03.000Z');
  assert.deepEqual(manifest.source, {
    commit: COMMIT,
    branch: 'codex/public-beta-v1.2.3',
    clean: true,
  });
  assert.equal(manifest.artifacts.cn.aixVersionUuid, CN_UUID);
  assert.equal(manifest.artifacts.en.entryCount, 47);
  assert.equal(manifest.artifacts.ja.aixVersionUuid, JA_UUID);
  assert.equal(manifest.artifacts.cn.locale, 'zh-CN');
  assert.equal(manifest.artifacts.en.transformVersion, AIX_TRANSFORM_VERSIONS['en-US']);
  assert.equal(manifest.artifacts.ja.transformVersion, AIX_TRANSFORM_VERSIONS['ja-JP']);
  assert.equal(manifest.artifacts.cn.sourceTreeSha256, SOURCE_TREE_SHA256);
  assert.equal(manifest.localPackageBoundary.signed, false);
  assert.equal(manifest.localPackageBoundary.uploaded, false);
  assert.equal(manifest.localPackageBoundary.realDeviceValidated, false);
  assert.equal(manifest.requiredExternalAcceptance.length, 3);

  assert.throws(
    () => buildPublicBetaManifest({
      productVersion: '1.2.3',
      generatedAt: '2026-07-25T01:02:03.000Z',
      source: { commit: COMMIT, branch: 'beta', clean: false },
      artifacts: {
        cn: artifact(names.cn, CN_UUID),
        en: artifact(names.en, EN_UUID),
        ja: artifact(names.ja, JA_UUID),
      },
    }),
    /dirty source tree/,
  );
  assert.throws(
    () => buildPublicBetaManifest({
      productVersion: '1.2.3',
      generatedAt: '2026-07-25T01:02:03.000Z',
      source: { commit: COMMIT, branch: 'beta', clean: true },
      artifacts: {
        cn: artifact(names.cn, CN_UUID),
        en: artifact(names.en, CN_UUID),
        ja: artifact(names.ja, JA_UUID),
      },
    }),
    /distinct VERSION UUIDs/,
  );
});

test('候选生成器复制当前三语包并原子生成 manifest.json', async () => {
  const fixture = makeFixture();
  try {
    const result = await createPublicBetaCandidate({
      root: fixture.root,
      now: () => new Date('2026-07-25T01:02:03.000Z'),
      commandRunner: fakeCommands(),
    });
    const files = fs.readdirSync(result.outputDir).sort();
    assert.deepEqual(files, [fixture.names.cn, fixture.names.en, fixture.names.ja, 'manifest.json'].sort());
    assert.equal(
      fs.readFileSync(path.join(result.outputDir, fixture.names.cn), 'utf8'),
      'cn-aix-fixture',
    );
    assert.equal(
      fs.readFileSync(path.join(result.outputDir, fixture.names.en), 'utf8'),
      'en-aix-fixture',
    );
    assert.equal(
      fs.readFileSync(path.join(result.outputDir, fixture.names.ja), 'utf8'),
      'ja-aix-fixture',
    );
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    assert.equal(manifest.source.commit, COMMIT);
    assert.equal(manifest.source.clean, true);
    assert.equal(manifest.artifacts.cn.bytes, Buffer.byteLength('cn-aix-fixture'));
    assert.equal(manifest.artifacts.en.bytes, Buffer.byteLength('en-aix-fixture'));
    assert.match(manifest.artifacts.cn.sha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.artifacts.cn.entryCount, 3);
    assert.equal(manifest.artifacts.cn.locale, AIX_LOCALES.cn);
    assert.equal(manifest.artifacts.en.locale, AIX_LOCALES.en);
    assert.equal(manifest.artifacts.ja.locale, AIX_LOCALES.ja);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('候选目录已存在时 fail closed，绝不覆盖旧候选', async () => {
  const fixture = makeFixture();
  const existing = path.join(fixture.release, fixture.names.directory);
  try {
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'keep.txt'), 'existing candidate');
    await assert.rejects(
      createPublicBetaCandidate({
        root: fixture.root,
        commandRunner: fakeCommands(),
      }),
      /candidate destination already exists/,
    );
    assert.equal(
      fs.readFileSync(path.join(existing, 'keep.txt'), 'utf8'),
      'existing candidate',
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('候选生成器把严格 inspect 的源码漂移或 payload 篡改失败向上传播', async () => {
  const fixture = makeFixture();
  try {
    await assert.rejects(
      createPublicBetaCandidate({
        root: fixture.root,
        commandRunner: fakeCommands({
          inspectError: 'AIX provenance verification failed: payload integrity mismatch',
        }),
      }),
      /payload integrity mismatch/,
    );
    assert.equal(
      fs.existsSync(path.join(fixture.release, fixture.names.directory)),
      false,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('候选生成器在脏树或三语包缺失时不产生目录', async () => {
  const dirtyFixture = makeFixture();
  try {
    await assert.rejects(
      createPublicBetaCandidate({
        root: dirtyFixture.root,
        commandRunner: fakeCommands({ status: ' M package.json\n' }),
      }),
      /must be clean/,
    );
    assert.equal(
      fs.existsSync(path.join(dirtyFixture.release, dirtyFixture.names.directory)),
      false,
    );
  } finally {
    fs.rmSync(dirtyFixture.root, { recursive: true, force: true });
  }

  const missingFixture = makeFixture();
  try {
    fs.rmSync(path.join(missingFixture.release, missingFixture.names.en));
    await assert.rejects(
      createPublicBetaCandidate({
        root: missingFixture.root,
        commandRunner: fakeCommands(),
      }),
      /Required AIX package is missing/,
    );
    assert.equal(
      fs.existsSync(path.join(missingFixture.release, missingFixture.names.directory)),
      false,
    );
  } finally {
    fs.rmSync(missingFixture.root, { recursive: true, force: true });
  }
});
