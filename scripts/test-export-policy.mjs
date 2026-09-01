import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-export-policy-'));
const hubRoot = path.join(temporaryRoot, 'hub');
const sourceRoot = path.join(temporaryRoot, 'source');
const projectId = 'test-app';
const version = '1.2.3';
const licensor = 'Northstar Licensing Entity Ltd.';
const centralApprovalPath = path.join(hubRoot, 'registry/source-approvals', `${projectId}.json`);

async function write(relative, value) {
  const target = path.join(sourceRoot, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value, 'utf8');
}

async function writeApprovalBoth(approval) {
  const text = `${JSON.stringify(approval, null, 2)}\n`;
  await write('SOURCE_DISTRIBUTION_APPROVAL.json', text);
  await fs.mkdir(path.dirname(centralApprovalPath), { recursive: true });
  await fs.writeFile(centralApprovalPath, text, 'utf8');
}

async function git(args) {
  return execFileAsync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8' });
}

async function hubGit(args) {
  return execFileAsync('git', ['-C', hubRoot, ...args], { encoding: 'utf8' });
}

async function commit(message) {
  await git(['add', '-A']);
  await git([
    '-c', 'user.name=AIUI Export Policy Test',
    '-c', 'user.email=export-policy-test@example.invalid',
    'commit', '-m', message,
  ]);
  const { stdout } = await git(['rev-parse', 'HEAD']);
  return stdout.trim();
}

async function commitHub(paths, message) {
  await hubGit(['add', '--', ...paths]);
  await hubGit([
    '-c', 'user.name=AIUI Export Policy Test',
    '-c', 'user.email=export-policy-test@example.invalid',
    'commit', '-m', message,
  ]);
}

async function runExport(id = projectId, writeExport = false) {
  try {
    const args = [path.join(hubRoot, 'scripts/export-project.mjs'), '--project', id];
    if (writeExport) args.push('--write');
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      args,
      { cwd: hubRoot, encoding: 'utf8' },
    );
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    return {
      code: Number.isInteger(error?.code) ? error.code : 1,
      output: String(error?.stdout ?? '') + String(error?.stderr ?? ''),
    };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function reset(revision) {
  await git(['reset', '--hard', revision]);
  await git(['clean', '-fd']);
}

try {
  await fs.mkdir(path.join(hubRoot, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(hubRoot, 'registry'), { recursive: true });
  await fs.copyFile(path.join(root, 'scripts/export-project.mjs'), path.join(hubRoot, 'scripts/export-project.mjs'));
  await fs.mkdir(sourceRoot, { recursive: true });

  const polyForm = await fs.readFile(path.join(root, 'licenses/PolyForm-Noncommercial-1.0.0.md'), 'utf8');
  await write('.gitignore', 'node_modules/\n');
  await write('COMMERCIAL_LICENSE.md', `# Commercial License\n\nCommercial Licensor: ${licensor}\n\nThis file does not grant commercial rights.\n`);
  await write('CONTRIBUTING.md', '# Contributing\n\nExternal application-source contributions are closed until a final CLA is enabled.\n');
  await write('COPYRIGHT', `Required Notice: Copyright ${licensor}\n`);
  await write('LICENSE', polyForm);
  await write('PRIVACY.md', '# Privacy\n');
  await write('README.md', '# Test App\n');
  await write('SECURITY.md', '# Security\n');
  await write('THIRD_PARTY_NOTICES.md', '# Third-party notices\n\nNo bundled third-party content.\n');
  await write('TRADEMARKS.md', '# Trademarks\n');
  await write('app.js', 'export const ready = true;\n');
  await write('package.json', `${JSON.stringify({
    name: '@test/app',
    version,
    private: true,
    type: 'module',
    license: 'PolyForm-Noncommercial-1.0.0',
    scripts: { test: 'node --check app.js', build: 'node --check app.js' },
  }, null, 2)}\n`);
  await write('SOURCE_DISTRIBUTION_APPROVAL.json', `${JSON.stringify({
    schemaVersion: 1,
    status: 'draft',
    projectId,
    version,
    licensor,
    contributorRightsStatus: 'pending',
    contributorRightsBasis: null,
    thirdPartyRightsStatus: 'pending',
    reviewedSourceRevision: '0'.repeat(40),
    contentManifestSha256: '0'.repeat(64),
    reviewedBy: 'Policy Test Reviewer',
    reviewedAt: '2026-09-01',
  }, null, 2)}\n`);

  await git(['init', '-b', 'main']);
  const reviewedRevision = await commit('test: seed source candidate');

  await fs.writeFile(path.join(hubRoot, 'registry/projects.json'), `${JSON.stringify({
    schemaVersion: 2,
    projects: [{
      id: projectId,
      name: 'Test App',
      version,
      sourceRepository: null,
      approvalRecord: `registry/source-approvals/${projectId}.json`,
      sourceDistribution: {
        status: 'ready',
        model: 'source-available-dual-license',
        communityLicense: 'PolyForm-Noncommercial-1.0.0',
        commercialAuthorization: 'written-agreement-required',
        licensor,
      },
    }],
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(hubRoot, 'registry/local-projects.json'), `${JSON.stringify({ [projectId]: sourceRoot }, null, 2)}\n`, 'utf8');
  await fs.mkdir(path.join(hubRoot, 'registry/source-approvals'), { recursive: true });
  await fs.copyFile(
    path.join(sourceRoot, 'SOURCE_DISTRIBUTION_APPROVAL.json'),
    path.join(hubRoot, 'registry/source-approvals', `${projectId}.json`),
  );
  await hubGit(['init', '-b', 'main']);
  await commitHub([
    'scripts/export-project.mjs',
    'registry/projects.json',
    `registry/source-approvals/${projectId}.json`,
  ], 'test: seed Hub trust records');

  const draft = await runExport();
  assert(draft.code === 1, 'draft approval must fail the dry-run');
  const manifest = draft.output.match(/content manifest SHA-256: ([0-9a-f]{64})/i)?.[1];
  assert(manifest, 'dry-run must report the candidate manifest');

  await write('SOURCE_DISTRIBUTION_APPROVAL.json', `${JSON.stringify({
    schemaVersion: 1,
    status: 'ready',
    projectId,
    version,
    licensor,
    contributorRightsStatus: 'verified',
    contributorRightsBasis: 'sole-author',
    thirdPartyRightsStatus: 'verified',
    reviewedSourceRevision: reviewedRevision,
    contentManifestSha256: manifest,
    reviewedBy: 'Policy Test Reviewer',
    reviewedAt: '2026-09-01',
  }, null, 2)}\n`);
  await fs.copyFile(
    path.join(sourceRoot, 'SOURCE_DISTRIBUTION_APPROVAL.json'),
    path.join(hubRoot, 'registry/source-approvals', `${projectId}.json`),
  );
  await commitHub([`registry/source-approvals/${projectId}.json`], 'test: approve authoritative Hub record');
  const approvedRevision = await commit('test: approve source candidate');
  const approvedApproval = JSON.parse(await fs.readFile(path.join(sourceRoot, 'SOURCE_DISTRIBUTION_APPROVAL.json'), 'utf8'));
  const approved = await runExport();
  assert(approved.code === 0, `approved clean candidate must pass:\n${approved.output}`);
  const written = await runExport(projectId, true);
  assert(written.code === 0, `approved clean candidate must write a local snapshot:\n${written.output}`);
  assert(await fs.readFile(path.join(hubRoot, 'dist', projectId, 'LICENSE'), 'utf8') === polyForm, 'written LICENSE must match the approved source');

  await fs.rm(path.join(hubRoot, 'dist'), { recursive: true, force: true });
  const outsideDist = path.join(temporaryRoot, 'outside-dist');
  await fs.mkdir(outsideDist, { recursive: true });
  await fs.symlink(outsideDist, path.join(hubRoot, 'dist'));
  const linkedDist = await runExport(projectId, true);
  assert(linkedDist.code === 1 && linkedDist.output.includes('Refusing to use dist'), 'symbolic-link dist root must fail');
  await fs.unlink(path.join(hubRoot, 'dist'));

  await fs.unlink(centralApprovalPath);
  await fs.symlink(path.join(sourceRoot, 'SOURCE_DISTRIBUTION_APPROVAL.json'), centralApprovalPath);
  const linkedCentralApproval = await runExport();
  assert(
    linkedCentralApproval.code === 1 && linkedCentralApproval.output.includes('must be a regular non-symlink file'),
    'authoritative Hub approval record must not be a symbolic link',
  );
  await fs.unlink(centralApprovalPath);
  await fs.writeFile(centralApprovalPath, `${JSON.stringify(approvedApproval, null, 2)}\n`, 'utf8');

  const uncommittedCentralApproval = { ...approvedApproval, reviewedAt: '2026-09-02' };
  await fs.writeFile(centralApprovalPath, `${JSON.stringify(uncommittedCentralApproval, null, 2)}\n`, 'utf8');
  const uncommittedCentral = await runExport();
  assert(
    uncommittedCentral.code === 1 && uncommittedCentral.output.includes('tracked, index, and worktree bytes must exactly match'),
    'an uncommitted authoritative Hub approval must not authorize an export',
  );
  await fs.writeFile(centralApprovalPath, `${JSON.stringify(approvedApproval, null, 2)}\n`, 'utf8');

  await fs.writeFile(centralApprovalPath, 'null\n', 'utf8');
  await commitHub([`registry/source-approvals/${projectId}.json`], 'test: use JSON null as Hub approval');
  const nullCentralApproval = await runExport();
  assert(
    nullCentralApproval.code === 1
      && nullCentralApproval.output.includes('authoritative Hub approval must be a JSON object'),
    'a valid but non-object authoritative Hub approval must fail closed',
  );
  await fs.writeFile(centralApprovalPath, `${JSON.stringify(approvedApproval, null, 2)}\n`, 'utf8');
  await commitHub([`registry/source-approvals/${projectId}.json`], 'test: restore authoritative Hub approval');

  await hubGit(['update-index', '--assume-unchanged', `registry/source-approvals/${projectId}.json`]);
  await fs.writeFile(centralApprovalPath, `${JSON.stringify(uncommittedCentralApproval, null, 2)}\n`, 'utf8');
  const hiddenHubChange = await runExport();
  assert(
    hiddenHubChange.code === 1 && hiddenHubChange.output.includes('without assume-unchanged or skip-worktree'),
    'assume-unchanged must not hide a modified Hub trust record',
  );
  await hubGit(['update-index', '--no-assume-unchanged', `registry/source-approvals/${projectId}.json`]);
  await fs.writeFile(centralApprovalPath, `${JSON.stringify(approvedApproval, null, 2)}\n`, 'utf8');

  const invalidId = await runExport('../../escape');
  assert(invalidId.code === 2 && invalidId.output.includes('Project id must contain only'), 'path-traversal project id must fail');

  const registryPath = path.join(hubRoot, 'registry/projects.json');
  const approvedRegistry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  const placeholderRegistry = structuredClone(approvedRegistry);
  placeholderRegistry.projects[0].sourceDistribution.licensor = 'EXACT_LEGAL_LICENSOR_NAME';
  await fs.writeFile(registryPath, `${JSON.stringify(placeholderRegistry, null, 2)}\n`, 'utf8');
  await commitHub(['registry/projects.json'], 'test: use placeholder licensor in committed registry');
  const placeholderLicensor = await runExport();
  assert(placeholderLicensor.code === 1 && placeholderLicensor.output.includes('real non-placeholder legal identity'), 'placeholder licensor must fail');
  await fs.writeFile(registryPath, `${JSON.stringify(approvedRegistry, null, 2)}\n`, 'utf8');
  await commitHub(['registry/projects.json'], 'test: restore committed registry');

  const placeholderReviewerApproval = { ...approvedApproval, reviewedBy: 'REVIEWER_IDENTITY' };
  await writeApprovalBoth(placeholderReviewerApproval);
  await commitHub([`registry/source-approvals/${projectId}.json`], 'test: record placeholder reviewer');
  await commit('test: use placeholder reviewer');
  const placeholderReviewer = await runExport();
  assert(placeholderReviewer.code === 1 && placeholderReviewer.output.includes('reviewedBy must identify'), 'placeholder reviewer must fail');
  await reset(approvedRevision);
  await writeApprovalBoth(approvedApproval);
  await commitHub([`registry/source-approvals/${projectId}.json`], 'test: restore reviewer approval');

  const sourceOnlyApproval = { ...approvedApproval, reviewedAt: '2026-09-02' };
  await write('SOURCE_DISTRIBUTION_APPROVAL.json', `${JSON.stringify(sourceOnlyApproval, null, 2)}\n`);
  await commit('test: change only the application approval copy');
  const selfApproved = await runExport();
  assert(
    selfApproved.code === 1 && selfApproved.output.includes('does not exactly match the authoritative Hub approval record'),
    'an application repository must not approve itself without a matching authoritative Hub record',
  );
  await reset(approvedRevision);
  await writeApprovalBoth(approvedApproval);

  await git(['update-index', '--assume-unchanged', 'app.js']);
  await write('app.js', 'export const ready = false;\n');
  const hiddenSourceChange = await runExport();
  assert(
    hiddenSourceChange.code === 1 && hiddenSourceChange.output.includes('source Git index uses assume-unchanged'),
    'assume-unchanged must not hide modified application source',
  );
  await git(['update-index', '--no-assume-unchanged', 'app.js']);
  await reset(approvedRevision);
  await writeApprovalBoth(approvedApproval);

  await write('SOURCE_DISTRIBUTION_APPROVAL.json', 'null\n');
  await commit('test: replace application approval with JSON null');
  const nullApplicationApproval = await runExport();
  assert(
    nullApplicationApproval.code === 1
      && nullApplicationApproval.output.includes('does not exactly match the authoritative Hub approval record'),
    'a valid but non-object application approval JSON must fail closed',
  );
  await reset(approvedRevision);
  await writeApprovalBoth(approvedApproval);

  await write('package.json', 'null\n');
  await commit('test: replace package metadata with JSON null');
  const nullPackage = await runExport();
  assert(
    nullPackage.code === 1 && nullPackage.output.includes('package.json must contain a JSON object'),
    'a valid but non-object package.json must fail closed',
  );
  await reset(approvedRevision);
  await writeApprovalBoth(approvedApproval);

  const invalidScriptsPackage = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  invalidScriptsPackage.scripts = { test: {}, build: [] };
  await write('package.json', `${JSON.stringify(invalidScriptsPackage, null, 2)}\n`);
  await commit('test: use non-string package scripts');
  const invalidScripts = await runExport();
  assert(
    invalidScripts.code === 1
      && invalidScripts.output.includes('non-empty string test script')
      && invalidScripts.output.includes('must define build or build:local'),
    'package scripts must be executable non-empty strings',
  );
  await reset(approvedRevision);
  await writeApprovalBoth(approvedApproval);

  const missingRightsBasisApproval = { ...approvedApproval, contributorRightsBasis: null };
  await writeApprovalBoth(missingRightsBasisApproval);
  await commitHub([`registry/source-approvals/${projectId}.json`], 'test: record missing rights basis');
  await commit('test: omit contributor rights basis');
  const missingRightsBasis = await runExport();
  assert(missingRightsBasis.code === 1 && missingRightsBasis.output.includes('contributorRightsBasis is invalid'), 'unselected contributor rights basis must fail');
  await reset(approvedRevision);
  await writeApprovalBoth(approvedApproval);
  await commitHub([`registry/source-approvals/${projectId}.json`], 'test: restore rights approval');

  for (const requiredFile of ['LICENSE', 'package.json', 'COPYRIGHT', 'COMMERCIAL_LICENSE.md']) {
    await write(requiredFile, '');
    await commit(`test: empty ${requiredFile}`);
    const emptyRequired = await runExport();
    assert(
      emptyRequired.code === 1 && emptyRequired.output.includes(`${requiredFile}: required source file must not be empty`),
      `empty ${requiredFile} must fail`,
    );
    await reset(approvedRevision);
  }

  await fs.unlink(path.join(sourceRoot, 'LICENSE'));
  await fs.symlink(path.join(root, 'licenses/PolyForm-Noncommercial-1.0.0.md'), path.join(sourceRoot, 'LICENSE'));
  const symlink = await runExport();
  assert(symlink.code === 1 && symlink.output.includes('symbolic links are not allowed'), 'required-file symlink must fail');
  await reset(approvedRevision);

  const credentialFixture = 'api' + '_key=' + 'live-secret-value' + '\n';
  await write('lib/secret.js', credentialFixture);
  await commit('test: add secret fixture');
  const secret = await runExport();
  assert(secret.code === 1 && secret.output.includes('possible credential assignment'), 'credential content must fail');
  await reset(approvedRevision);

  const expandedCredentialFixture = [
    '-----BEGIN ' + 'DSA PRIVATE KEY-----',
    '-----BEGIN ' + 'PGP PRIVATE KEY BLOCK-----',
    'ASIA' + 'A'.repeat(16),
    'AWS_' + 'SECRET_ACCESS_KEY=' + 'synthetic-secret-value',
    'AWS_' + 'SESSION_TOKEN=' + 'synthetic-session-value',
  ].join('\n');
  await write('lib/expanded-credentials.js', `${expandedCredentialFixture}\n`);
  await commit('test: add expanded credential fixtures');
  const expandedCredentials = await runExport();
  assert(
    expandedCredentials.code === 1
      && expandedCredentials.output.includes('possible private key block')
      && expandedCredentials.output.includes('possible AWS access key')
      && expandedCredentials.output.includes('possible credential assignment'),
    'DSA/PGP private keys, AWS temporary access keys, and AWS secret/session assignments must fail',
  );
  await reset(approvedRevision);

  const fineGrainedToken = 'github' + '_pat_' + 'A'.repeat(30);
  await write('pages/secret.vue', `<template>${fineGrainedToken}</template>\n`);
  await commit('test: add token in unknown text extension');
  const unknownTextSecret = await runExport();
  assert(unknownTextSecret.code === 1 && unknownTextSecret.output.includes('GitHub fine-grained access token'), 'unknown text extension must be scanned');
  await reset(approvedRevision);

  await write('assets/secret.png', `${fineGrainedToken}\n`);
  await commit('test: disguise a token as an image');
  const disguisedBinarySecret = await runExport();
  assert(
    disguisedBinarySecret.code === 1
      && disguisedBinarySecret.output.includes('GitHub fine-grained access token')
      && disguisedBinarySecret.output.includes('binary signature'),
    'a token hidden behind an allowed binary extension must fail closed',
  );
  await reset(approvedRevision);

  await fs.mkdir(path.join(sourceRoot, 'lib'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'lib/.NPMRC'), 'registry=https://example.invalid/\n', 'utf8');
  await commit('test: add uppercase credential filename');
  const uppercaseCredentialFile = await runExport();
  assert(uppercaseCredentialFile.code === 1 && uppercaseCredentialFile.output.includes('forbidden artifact type'), 'credential filenames must be case-insensitive');
  await reset(approvedRevision);

  await fs.mkdir(path.join(sourceRoot, 'assets'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'assets/unknown.bin'), Buffer.from([0, 1, 2, 3]));
  await commit('test: add unknown binary');
  const unknownBinary = await runExport();
  assert(unknownBinary.code === 1 && unknownBinary.output.includes('unknown binary content'), 'unknown binary content must fail closed');
  await reset(approvedRevision);

  await write('app.js', 'export const ready = false;\n');
  await commit('test: make approval stale');
  const stale = await runExport();
  assert(stale.code === 1 && stale.output.includes('contentManifestSha256 does not match'), 'stale manifest must fail');

  const refreshedManifest = stale.output.match(/content manifest SHA-256: ([0-9a-f]{64})/i)?.[1];
  assert(refreshedManifest, 'changed candidate must still report its manifest');
  const staleApproval = JSON.parse(await fs.readFile(path.join(sourceRoot, 'SOURCE_DISTRIBUTION_APPROVAL.json'), 'utf8'));
  staleApproval.contentManifestSha256 = refreshedManifest;
  await writeApprovalBoth(staleApproval);
  await commitHub([`registry/source-approvals/${projectId}.json`], 'test: record refreshed stale manifest');
  await commit('test: refresh only the manifest without a new review revision');
  const unreviewedChange = await runExport();
  assert(
    unreviewedChange.code === 1 && unreviewedChange.output.includes('only SOURCE_DISTRIBUTION_APPROVAL.json may change'),
    'refreshing only the manifest must not bless code changed after reviewedSourceRevision',
  );
  await reset(approvedRevision);
  await writeApprovalBoth(approvedApproval);
  await commitHub([`registry/source-approvals/${projectId}.json`], 'test: restore approved manifest');

  const packageJson = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  packageJson.license = 'Apache-2.0';
  await write('package.json', `${JSON.stringify(packageJson, null, 2)}\n`);
  await commit('test: use wrong package license');
  const wrongLicense = await runExport();
  assert(wrongLicense.code === 1 && wrongLicense.output.includes('package.json license must be'), 'wrong package license must fail');

  console.log('Export policy tests passed: approved write, containment, symlinks, credentials, stale/unreviewed manifests, and package license.');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
