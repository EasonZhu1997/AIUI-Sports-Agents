import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const mappingPath = path.join(root, 'registry/local-projects.json');
const expectedCommunityLicense = 'PolyForm-Noncommercial-1.0.0';
const expectedCommunityLicenseSha256 = 'c0ea4a896d2c8c394b29f9427589996db826cd501c512279ff0ed3ef48fabbe5';
const requiredFiles = [
  'LICENSE',
  'COMMERCIAL_LICENSE.md',
  'COPYRIGHT',
  'README.md',
  'PRIVACY.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'TRADEMARKS.md',
  'THIRD_PARTY_NOTICES.md',
  'SOURCE_DISTRIBUTION_APPROVAL.json',
  '.gitignore',
];
const riskyEntries = [
  '.agents',
  '.claude',
  'node_modules',
  'tmp',
  'evidence',
  'diagnostics',
  'captures',
  'release',
  'release-archive',
  'promo-video',
  'rokid-samples',
];
const riskyExtensions = new Set(['.aix', '.apk', '.aab', '.pem', '.key', '.jks', '.keystore', '.p12', '.pfx', '.zip', '.jsonl', '.db']);
const riskyExactNames = new Set(['.env', '.envrc', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519']);
const execFileAsync = promisify(execFile);
const approvalFieldNames = [
  'schemaVersion',
  'status',
  'projectId',
  'version',
  'licensor',
  'contributorRightsStatus',
  'contributorRightsBasis',
  'thirdPartyRightsStatus',
  'reviewedSourceRevision',
  'contentManifestSha256',
  'reviewedBy',
  'reviewedAt',
];

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function isRegularFile(file) {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function lstatIfExists(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function normalizedSha256(text) {
  const normalized = text
    .replaceAll('\r\n', '\n')
    .replace(/[ \t]+$/gm, '')
    .trimEnd()
    .concat('\n');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function isHexString(value, length) {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`, 'i').test(value);
}

function isRealIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isPlaceholderIdentity(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return true;
  return /^(?:EXACT_LEGAL_LICENSOR_NAME|LEGAL_NAME|YOUR_(?:LEGAL_)?NAME|REVIEWER_IDENTITY|TODO|TBD|UNKNOWN|EXAMPLE(?: LEGAL)? LICENSOR|TEST LICENSOR)$/i.test(value.trim());
}

function hasExactApprovalShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === approvalFieldNames.length
    && approvalFieldNames.every((key) => keys.includes(key));
}

function approvalsMatch(left, right) {
  return hasExactApprovalShape(left)
    && hasExactApprovalShape(right)
    && approvalFieldNames.every((key) => left[key] === right[key]);
}

async function runGit(workingRoot, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workingRoot, ...args], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

if (!await exists(mappingPath)) {
  console.error('registry/local-projects.json is missing. Copy local-projects.example.json first.');
  process.exit(1);
}

const mappings = await readJson(mappingPath);
const findings = [];
let hubHead = null;

const hubGitRoot = await runGit(root, ['rev-parse', '--show-toplevel']);
if (!hubGitRoot.ok) {
  findings.push({ severity: 'blocker', project: 'hub', message: 'Hub repository is not a readable Git worktree' });
} else {
  const rootReal = await fs.realpath(root);
  const hubGitReal = await fs.realpath(hubGitRoot.stdout.trim());
  if (rootReal !== hubGitReal) {
    findings.push({ severity: 'blocker', project: 'hub', message: 'audit must run from the Hub Git worktree root' });
  } else {
    const headResult = await runGit(root, ['rev-parse', '--verify', 'HEAD']);
    if (!headResult.ok || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(headResult.stdout.trim())) {
      findings.push({ severity: 'blocker', project: 'hub', message: 'Hub HEAD is not a readable commit object ID' });
    } else {
      hubHead = headResult.stdout.trim();
    }
  }
}

async function verifyHubTrustPath(relative) {
  if (!hubHead) return null;
  const tracked = await runGit(root, ['ls-files', '-v', '--error-unmatch', '--', relative]);
  if (!tracked.ok || tracked.stdout.slice(2).trim() !== relative) {
    findings.push({ severity: 'blocker', project: 'hub', message: `${relative} must be tracked by Git` });
    return null;
  }
  if (tracked.stdout[0] !== 'H') {
    findings.push({ severity: 'blocker', project: 'hub', message: `${relative} has an unsafe assume-unchanged/skip-worktree index flag` });
    return null;
  }
  const [headBlob, indexBlob, headEntry, indexEntry] = await Promise.all([
    runGit(root, ['show', `${hubHead}:${relative}`]),
    runGit(root, ['show', `:${relative}`]),
    runGit(root, ['ls-tree', '-z', hubHead, '--', relative]),
    runGit(root, ['ls-files', '-s', '-z', '--', relative]),
  ]);
  let worktreeText = null;
  try {
    const stat = await fs.lstat(path.join(root, relative));
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('not a regular file');
    worktreeText = await fs.readFile(path.join(root, relative), 'utf8');
  } catch {
    findings.push({ severity: 'blocker', project: 'hub', message: `${relative} must be a readable regular non-symlink file` });
    return null;
  }
  const headRecord = headEntry.stdout.split('\0').find(Boolean) ?? '';
  const indexRecord = indexEntry.stdout.split('\0').find(Boolean) ?? '';
  const headMode = headRecord.slice(0, headRecord.indexOf('\t')).split(' ')[0];
  const indexMode = indexRecord.slice(0, indexRecord.indexOf('\t')).split(' ')[0];
  if (!headEntry.ok || !indexEntry.ok
      || !['100644', '100755'].includes(headMode)
      || headMode !== indexMode) {
    findings.push({ severity: 'blocker', project: 'hub', message: `${relative} must use the same regular 100644/100755 mode in Hub HEAD and index` });
    return null;
  }
  if (!headBlob.ok || !indexBlob.ok
      || headBlob.stdout !== indexBlob.stdout
      || headBlob.stdout !== worktreeText) {
    findings.push({ severity: 'blocker', project: 'hub', message: `${relative} must byte-match the captured Hub commit in HEAD, index, and worktree` });
    return null;
  }
  return headBlob.stdout;
}

const trustedRegistryText = await verifyHubTrustPath('registry/projects.json');
await verifyHubTrustPath('scripts/audit-local.mjs');
await verifyHubTrustPath('scripts/export-project.mjs');
await verifyHubTrustPath('scripts/validate.mjs');
await verifyHubTrustPath('scripts/validate-licensing.mjs');

let registry = { projects: [] };
if (trustedRegistryText !== null) {
  try {
    const parsedRegistry = JSON.parse(trustedRegistryText);
    if (!parsedRegistry || typeof parsedRegistry !== 'object' || Array.isArray(parsedRegistry)
        || !Array.isArray(parsedRegistry.projects) || parsedRegistry.projects.length === 0) {
      findings.push({ severity: 'blocker', project: 'hub', message: 'trusted registry must contain a non-empty projects array' });
    } else {
      registry = parsedRegistry;
    }
  } catch {
    findings.push({ severity: 'blocker', project: 'hub', message: 'trusted registry is invalid JSON' });
  }
}

try {
  for (const validator of ['scripts/validate.mjs', 'scripts/validate-licensing.mjs']) {
    await execFileAsync(process.execPath, [path.join(root, validator)], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    });
  }
} catch {
  findings.push({ severity: 'blocker', project: 'hub', message: 'canonical Hub validation or licensing validation did not pass' });
}

for (const project of registry.projects) {
  const configured = mappings[project.id];
  if (!configured) {
    findings.push({ severity: 'blocker', project: project.id, message: 'no local path mapping' });
    continue;
  }
  const sourceRoot = path.resolve(path.dirname(mappingPath), configured);
  if (!await exists(sourceRoot)) {
    findings.push({ severity: 'blocker', project: project.id, message: 'mapped source directory does not exist' });
    continue;
  }

  let packageJson = null;
  const packagePath = path.join(sourceRoot, 'package.json');
  if (!await isRegularFile(packagePath)) {
    findings.push({ severity: 'blocker', project: project.id, message: 'package.json is missing or invalid' });
  } else {
    try {
      packageJson = await readJson(packagePath);
      if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
        findings.push({ severity: 'blocker', project: project.id, message: 'package.json must contain a JSON object' });
        packageJson = null;
      }
    } catch {
      findings.push({ severity: 'blocker', project: project.id, message: 'package.json is missing or invalid' });
    }
  }
  if (packageJson && packageJson.version !== project.version) {
    findings.push({ severity: 'blocker', project: project.id, message: `registry version ${project.version} differs from package version` });
  }
  if (packageJson && (typeof packageJson.scripts?.test !== 'string' || !packageJson.scripts.test.trim())) {
    findings.push({ severity: 'blocker', project: project.id, message: 'no non-empty string test script' });
  }
  if (packageJson) {
    const buildScript = packageJson.scripts?.build;
    const localBuildScript = packageJson.scripts?.['build:local'];
    if (!((typeof buildScript === 'string' && buildScript.trim())
        || (typeof localBuildScript === 'string' && localBuildScript.trim()))) {
      findings.push({ severity: 'blocker', project: project.id, message: 'no non-empty string local build script' });
    }
  }
  if (packageJson && packageJson.license !== expectedCommunityLicense) {
    findings.push({
      severity: 'blocker',
      project: project.id,
      message: `package license must be ${expectedCommunityLicense}`,
    });
  }

  const distribution = project.sourceDistribution;
  const licensor = typeof distribution?.licensor === 'string' ? distribution.licensor.trim() : '';
  const expectedApprovalRecord = `registry/source-approvals/${project.id}.json`;
  if (!distribution || distribution.model !== 'source-available-dual-license') {
    findings.push({ severity: 'blocker', project: project.id, message: 'registry source-distribution model is missing or invalid' });
  } else {
    if (distribution.communityLicense !== expectedCommunityLicense) {
      findings.push({ severity: 'blocker', project: project.id, message: 'registry community license does not match export policy' });
    }
    if (distribution.commercialAuthorization !== 'written-agreement-required') {
      findings.push({ severity: 'blocker', project: project.id, message: 'registry must require written commercial authorization' });
    }
    if (!['ready', 'published'].includes(distribution.status)) {
      findings.push({ severity: 'blocker', project: project.id, message: `source distribution status is ${distribution.status ?? 'missing'}, not ready/published` });
    }
    if (isPlaceholderIdentity(licensor)) {
      findings.push({ severity: 'blocker', project: project.id, message: 'legal licensor identity is missing or is still a placeholder' });
    }
  }
  if (project.approvalRecord !== expectedApprovalRecord) {
    findings.push({ severity: 'blocker', project: project.id, message: `registry approvalRecord must be ${expectedApprovalRecord}` });
  }

  const regularRequired = new Set();
  for (const relative of requiredFiles) {
    const absolute = path.join(sourceRoot, relative);
    const stat = await lstatIfExists(absolute);
    if (!stat) findings.push({ severity: 'blocker', project: project.id, message: `missing ${relative}` });
    else if (stat.isSymbolicLink()) findings.push({ severity: 'blocker', project: project.id, message: `${relative} must not be a symbolic link` });
    else if (!stat.isFile()) findings.push({ severity: 'blocker', project: project.id, message: `${relative} must be a regular file` });
    else {
      const text = await fs.readFile(absolute, 'utf8');
      if (!text.trim()) findings.push({ severity: 'blocker', project: project.id, message: `${relative} must not be empty` });
      regularRequired.add(relative);
    }
  }
  const licensePath = path.join(sourceRoot, 'LICENSE');
  if (regularRequired.has('LICENSE')) {
    const licenseText = await fs.readFile(licensePath, 'utf8');
    if (normalizedSha256(licenseText) !== expectedCommunityLicenseSha256) {
      findings.push({ severity: 'blocker', project: project.id, message: 'LICENSE is not the expected PolyForm Noncommercial 1.0.0 text' });
    }
  }
  const copyrightPath = path.join(sourceRoot, 'COPYRIGHT');
  if (regularRequired.has('COPYRIGHT')) {
    const copyrightText = await fs.readFile(copyrightPath, 'utf8');
    const expectedNotice = `Required Notice: Copyright ${licensor}`;
    if (!copyrightText.split(/\r?\n/).map((line) => line.trim()).includes(expectedNotice)) {
      findings.push({ severity: 'blocker', project: project.id, message: 'COPYRIGHT Required Notice does not exactly match the registry licensor' });
    }
  }
  const commercialPath = path.join(sourceRoot, 'COMMERCIAL_LICENSE.md');
  if (regularRequired.has('COMMERCIAL_LICENSE.md') && licensor) {
    const commercialText = await fs.readFile(commercialPath, 'utf8');
    const expectedLicensorLine = `Commercial Licensor: ${licensor}`;
    if (!commercialText.split(/\r?\n/).map((line) => line.trim()).includes(expectedLicensorLine)) {
      findings.push({ severity: 'blocker', project: project.id, message: 'COMMERCIAL_LICENSE.md does not exactly identify the registry licensor' });
    }
  }
  const approvalPath = path.join(sourceRoot, 'SOURCE_DISTRIBUTION_APPROVAL.json');
  let sourceApproval = null;
  let sourceApprovalText = null;
  if (regularRequired.has('SOURCE_DISTRIBUTION_APPROVAL.json')) {
    try {
      sourceApprovalText = await fs.readFile(approvalPath, 'utf8');
      sourceApproval = JSON.parse(sourceApprovalText);
    } catch {
      findings.push({ severity: 'blocker', project: project.id, message: 'SOURCE_DISTRIBUTION_APPROVAL.json is invalid JSON' });
    }
    if (!hasExactApprovalShape(sourceApproval)) {
      findings.push({ severity: 'blocker', project: project.id, message: 'application approval contains missing or unexpected fields' });
    }
  }

  let approval = null;
  let centralApprovalParsed = false;
  let centralApprovalText = null;
  if (project.approvalRecord === expectedApprovalRecord) {
    const trustedApprovalText = await verifyHubTrustPath(project.approvalRecord);
    const centralApprovalPath = path.resolve(root, project.approvalRecord);
    const centralRelative = path.relative(root, centralApprovalPath);
    if (centralRelative.startsWith('..') || path.isAbsolute(centralRelative)) {
      findings.push({ severity: 'blocker', project: project.id, message: 'registry approvalRecord escapes the Hub repository' });
    } else {
      const centralStat = await lstatIfExists(centralApprovalPath);
      if (!centralStat) {
        findings.push({ severity: 'blocker', project: project.id, message: 'authoritative Hub approval record is missing' });
      } else if (centralStat.isSymbolicLink() || !centralStat.isFile()) {
        findings.push({ severity: 'blocker', project: project.id, message: 'authoritative Hub approval record must be a regular non-symlink file' });
      } else if (trustedApprovalText !== null) {
        centralApprovalText = trustedApprovalText;
        if (!centralApprovalText.trim()) {
          findings.push({ severity: 'blocker', project: project.id, message: 'authoritative Hub approval record must not be empty' });
        }
        try {
          approval = JSON.parse(centralApprovalText);
          centralApprovalParsed = true;
        } catch {
          findings.push({ severity: 'blocker', project: project.id, message: 'authoritative Hub approval record is invalid JSON' });
        }
      }
    }
  }
  if (centralApprovalParsed && !approvalsMatch(sourceApproval, approval)) {
    findings.push({ severity: 'blocker', project: project.id, message: 'application approval does not exactly match the authoritative Hub approval record' });
  }
  if (centralApprovalText !== null && sourceApprovalText !== null && centralApprovalText !== sourceApprovalText) {
    findings.push({ severity: 'blocker', project: project.id, message: 'application approval bytes do not exactly match the authoritative Hub approval record' });
  }
  if (centralApprovalParsed && !hasExactApprovalShape(approval)) {
    findings.push({ severity: 'blocker', project: project.id, message: 'authoritative Hub approval must be a JSON object with the exact approval fields' });
  }
  if (hasExactApprovalShape(approval)) {
    if (approval.schemaVersion !== 1 || approval.status !== 'ready') {
      findings.push({ severity: 'blocker', project: project.id, message: 'source approval schema/status is invalid' });
    }
    if (approval.projectId !== project.id || approval.version !== project.version || approval.licensor !== licensor) {
      findings.push({ severity: 'blocker', project: project.id, message: 'source approval identity does not match registry project/version/licensor' });
    }
    if (approval.contributorRightsStatus !== 'verified'
        || !['sole-author', 'cla-complete', 'written-assignments', 'mixed-reviewed'].includes(approval.contributorRightsBasis)) {
      findings.push({ severity: 'blocker', project: project.id, message: 'contributor rights approval is missing or invalid' });
    }
    if (approval.thirdPartyRightsStatus !== 'verified') {
      findings.push({ severity: 'blocker', project: project.id, message: 'third-party rights approval is missing' });
    }
    if (!isHexString(approval.reviewedSourceRevision, 40)
        || !isHexString(approval.contentManifestSha256, 64)
        || !isRealIsoDate(approval.reviewedAt)
        || isPlaceholderIdentity(approval.reviewedBy)) {
      findings.push({ severity: 'blocker', project: project.id, message: 'source approval review metadata is incomplete or still contains a placeholder' });
    }
  }
  for (const entry of riskyEntries) {
    if (await exists(path.join(sourceRoot, entry))) {
      findings.push({ severity: 'warning', project: project.id, message: `${entry}/ must stay outside the public export` });
    }
  }

  const rootEntries = await fs.readdir(sourceRoot, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (!entry.isFile()) continue;
    const lowerName = entry.name.toLowerCase();
    const extension = path.extname(entry.name).toLowerCase();
    if (riskyExtensions.has(extension)
        || riskyExactNames.has(lowerName)
        || lowerName.startsWith('.env.')
        || /^credentials.*\.json$/i.test(lowerName)
        || /^service-account.*\.json$/i.test(lowerName)) {
      findings.push({ severity: 'blocker', project: project.id, message: `${entry.name} must not enter the public export` });
    }
  }

  if (!await exists(path.join(sourceRoot, '.git'))) {
    findings.push({ severity: 'blocker', project: project.id, message: 'no canonical Git history yet' });
  }

  try {
    await execFileAsync(
      process.execPath,
      [path.join(root, 'scripts/export-project.mjs'), '--project', project.id],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
      },
    );
  } catch {
    findings.push({
      severity: 'blocker',
      project: project.id,
      message: 'authoritative export dry-run did not pass; run npm run export:dry for details',
    });
  }
}

if (hubHead) {
  const finalHead = await runGit(root, ['rev-parse', '--verify', 'HEAD']);
  if (!finalHead.ok || finalHead.stdout.trim() !== hubHead) {
    findings.push({ severity: 'blocker', project: 'hub', message: 'Hub HEAD changed while the audit was running; rerun against a stable commit' });
  }
}

if (findings.length === 0) {
  console.log('Local project audit passed with no findings.');
  process.exit(0);
}

console.log('| Severity | Project | Finding |');
console.log('|---|---|---|');
for (const finding of findings) {
  console.log(`| ${finding.severity} | ${finding.project} | ${finding.message.replaceAll('|', '\\|')} |`);
}
const blockers = findings.filter((finding) => finding.severity === 'blocker').length;
console.log(`\n${findings.length} finding(s), including ${blockers} blocker(s). No secret values are printed.`);
if (strict && blockers > 0) process.exitCode = 1;
