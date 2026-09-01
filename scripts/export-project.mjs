import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');
const projectFlag = process.argv.indexOf('--project');
const projectId = projectFlag >= 0 ? process.argv[projectFlag + 1] : '';
const mappingPath = path.join(root, 'registry/local-projects.json');
const registryPath = path.join(root, 'registry/projects.json');
const expectedCommunityLicense = 'PolyForm-Noncommercial-1.0.0';
const expectedCommunityLicenseSha256 = 'c0ea4a896d2c8c394b29f9427589996db826cd501c512279ff0ed3ef48fabbe5';
const requiredSourceFiles = [
  '.gitignore',
  'COMMERCIAL_LICENSE.md',
  'CONTRIBUTING.md',
  'COPYRIGHT',
  'LICENSE',
  'PRIVACY.md',
  'README.md',
  'SECURITY.md',
  'SOURCE_DISTRIBUTION_APPROVAL.json',
  'THIRD_PARTY_NOTICES.md',
  'TRADEMARKS.md',
  'package.json',
];
const allowedRootFiles = new Set([
  '.aixignore',
  '.gitignore',
  '.npmignore',
  'AGENTS.md',
  'CLA.md',
  'COMMERCIAL_LICENSE.md',
  'CONTRIBUTING.md',
  'COPYRIGHT',
  'LICENSE',
  'PRIVACY.md',
  'README.md',
  'SECURITY.md',
  'SOURCE_DISTRIBUTION_APPROVAL.json',
  'THIRD_PARTY_NOTICES.md',
  'TRADEMARKS.md',
  'VERSION',
  'app.js',
  'app.json',
  'package-lock.json',
  'package.json',
]);
const allowedRootDirs = new Set(['assets', 'docs', 'lib', 'pages', 'scripts', 'test', 'tools']);
const excludedNames = new Set([
  '.git', '.agents', '.claude', 'node_modules', 'tmp', 'evidence', 'diagnostics', 'captures',
  'release', 'release-archive', 'promo-video', 'rokid-samples', '.pytest_cache', '.pages-build',
]);
const excludedExtensions = new Set([
  '.aix', '.apk', '.aab', '.pem', '.key', '.jks', '.keystore', '.p12', '.pfx', '.db', '.jsonl', '.zip', '.log', '.pdf',
]);
const excludedExactNames = new Set(['.npmrc', '.netrc', 'id_rsa', 'id_ed25519']);
const excludedNamePatterns = [/^credentials.*\.json$/i, /^service-account.*\.json$/i];
const excludedRelativePaths = new Set([
  'tools/ftms_control_handshake_probe_macos.swift',
  'tools/ftms_resistance_control_test_macos.swift',
]);
const maxFileBytes = 2_000_000;
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
const allowedBinaryExtensions = new Set([
  '.gif', '.jpeg', '.jpg', '.mp3', '.mp4', '.otf', '.png', '.ttf', '.wav', '.webp', '.woff', '.woff2',
]);
const forbiddenContentPatterns = [
  ['private key block', /-----BEGIN (?:(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/],
  ['OpenAI-style API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['GitHub access token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['GitHub fine-grained access token', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ['Slack access token', /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/],
  ['credential embedded in URL', /https?:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ['credential assignment', /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token|secret[_-]?access[_-]?key|session[_-]?token)\s*[:=]\s*["'`]?(?!<|your|example|test|dummy|redacted|x{4,}|\$\{)[A-Za-z0-9_+\/=:-]{8,}["'`]?/i],
  ['MAC address', /\b(?:[0-9A-F]{2}:){5}[0-9A-F]{2}\b/i],
];
let sourceObjectFormat = 'sha1';

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
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

function rawSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function gitBlobHash(data, objectFormat) {
  return createHash(objectFormat)
    .update(Buffer.from(`blob ${data.length}\0`, 'utf8'))
    .update(data)
    .digest('hex');
}

async function lstatIfExists(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function hasForbiddenName(name) {
  const lower = name.toLowerCase();
  return excludedExactNames.has(lower)
    || excludedNamePatterns.some((pattern) => pattern.test(lower))
    || lower === '.env'
    || lower === '.envrc'
    || lower.startsWith('.env.');
}

function isAllowedRelativePath(relative) {
  const segments = relative.split('/');
  const base = segments.at(-1);
  if (segments.length === 1) return allowedRootFiles.has(base);
  if (!allowedRootDirs.has(segments[0])) return false;
  if (excludedRelativePaths.has(relative)) return false;
  if (segments.some((segment) => excludedNames.has(segment.toLowerCase()))) return false;
  const extension = path.extname(base).toLowerCase();
  return !excludedExtensions.has(extension) && !hasForbiddenName(base);
}

async function inspectCandidateFile(absolute, relative, planned, blockers, preloadedData = null) {
  const extension = path.extname(relative).toLowerCase();
  const data = preloadedData ?? await fs.readFile(absolute);
  const size = data.length;
  if (size > maxFileBytes) blockers.push(`${relative}: exceeds ${maxFileBytes} bytes and requires manual review`);
  const searchableBytes = data.toString('latin1');
  if (searchableBytes.includes('/' + 'Users' + '/')
      || /[A-Za-z]:\\Users\\/.test(searchableBytes)
      || searchableBytes.includes('file:' + '//')) {
    blockers.push(`${relative}: contains a local absolute path`);
  }
  for (const [label, pattern] of forbiddenContentPatterns) {
    if (pattern.test(searchableBytes)) blockers.push(`${relative}: contains a possible ${label}`);
  }

  if (allowedBinaryExtensions.has(extension)) {
    const ascii = (start, end) => data.subarray(start, end).toString('ascii');
    const hasSignature = (() => {
      if (extension === '.png') return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      if (extension === '.jpg' || extension === '.jpeg') return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
      if (extension === '.gif') return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
      if (extension === '.webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
      if (extension === '.wav') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE';
      if (extension === '.mp4') return ascii(4, 8) === 'ftyp';
      if (extension === '.mp3') return ascii(0, 3) === 'ID3' || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0);
      if (extension === '.otf') return ascii(0, 4) === 'OTTO';
      if (extension === '.ttf') return data.subarray(0, 4).equals(Buffer.from([0x00, 0x01, 0x00, 0x00]))
        || ['true', 'typ1'].includes(ascii(0, 4));
      if (extension === '.woff') return ascii(0, 4) === 'wOFF';
      if (extension === '.woff2') return ascii(0, 4) === 'wOF2';
      return false;
    })();
    if (!hasSignature) blockers.push(`${relative}: extension does not match the expected binary signature`);
  } else {
    let text = '';
    try {
      if (data.includes(0)) throw new Error('NUL byte');
      text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      blockers.push(`${relative}: unknown binary content requires explicit review or exclusion`);
      planned.push({
        source: absolute,
        relative,
        size,
        sha256: rawSha256(data),
        gitBlobHash: gitBlobHash(data, sourceObjectFormat),
        data,
      });
      return;
    }
  }
  planned.push({
    source: absolute,
    relative,
    size,
    sha256: rawSha256(data),
    gitBlobHash: gitBlobHash(data, sourceObjectFormat),
    data,
  });
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

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isHexString(value, length) {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`, 'i').test(value);
}

async function runGit(sourceRoot, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', sourceRoot, ...args], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

function parseTreeEntry(output) {
  const record = output.split('\0').find(Boolean);
  if (!record) return null;
  const tab = record.indexOf('\t');
  const metadata = tab >= 0 ? record.slice(0, tab).split(' ') : [];
  return metadata[1] === 'blob' && /^[0-9a-f]{40,64}$/i.test(metadata[2] ?? '')
    ? { mode: metadata[0], hash: metadata[2] }
    : null;
}

function parseIndexEntry(output) {
  const record = output.split('\0').find(Boolean);
  if (!record) return null;
  const tab = record.indexOf('\t');
  const metadata = tab >= 0 ? record.slice(0, tab).split(' ') : [];
  return /^[0-9a-f]{40,64}$/i.test(metadata[1] ?? '') && metadata[2] === '0'
    ? { mode: metadata[0], hash: metadata[1] }
    : null;
}

async function verifyGitPathMatchesHead(workingRoot, relative, revision, objectFormat, issues, label) {
  let valid = true;
  const verbose = await runGit(workingRoot, ['ls-files', '-v', '-z', '--', relative]);
  const verboseRecord = verbose.stdout.split('\0').find(Boolean);
  if (!verbose.ok || !verboseRecord) {
    issues.push(`${label}: must be tracked by Git`);
    return null;
  }
  if (verboseRecord[0] !== 'H') {
    issues.push(`${label}: must use a normal index entry without assume-unchanged or skip-worktree`);
    valid = false;
  }
  const headEntry = await runGit(workingRoot, ['ls-tree', '-z', revision, '--', relative]);
  const indexEntry = await runGit(workingRoot, ['ls-files', '-s', '-z', '--', relative]);
  const headBlob = headEntry.ok ? parseTreeEntry(headEntry.stdout) : null;
  const indexBlob = indexEntry.ok ? parseIndexEntry(indexEntry.stdout) : null;
  let worktreeBlob = null;
  let worktreeData = null;
  const absolute = path.join(workingRoot, relative);
  const stat = await lstatIfExists(absolute);
  if (stat?.isFile() && !stat.isSymbolicLink()) {
    worktreeData = await fs.readFile(absolute);
    worktreeBlob = gitBlobHash(worktreeData, objectFormat);
  } else {
    issues.push(`${label}: must be a regular non-symlink file`);
    valid = false;
  }
  if (!headBlob || !indexBlob
      || !['100644', '100755'].includes(headBlob.mode)
      || headBlob.mode !== indexBlob.mode) {
    issues.push(`${label}: HEAD and index modes must match and be regular 100644/100755 files`);
    valid = false;
  }
  if (!headBlob || !indexBlob || !worktreeBlob
      || headBlob.hash !== indexBlob.hash || headBlob.hash !== worktreeBlob) {
    issues.push(`${label}: tracked, index, and worktree bytes must exactly match the current Git HEAD`);
    valid = false;
  }
  return valid ? worktreeData : null;
}

if (!projectId) {
  console.error('Usage: npm run export:dry -- --project <project-id>');
  process.exit(2);
}
if (!/^[a-z0-9-]+$/.test(projectId)) {
  console.error('Project id must contain only lowercase letters, digits, and hyphens.');
  process.exit(2);
}
if (!await exists(mappingPath)) {
  console.error('registry/local-projects.json is missing. Copy the example first.');
  process.exit(2);
}

const planned = [];
const blockers = [];
const sourceFiles = new Map();
const sourceFileBuffers = new Map();
let hubHead = '';
let hubObjectFormat = 'sha1';

const hubGitRoot = await runGit(root, ['rev-parse', '--show-toplevel']);
if (!hubGitRoot.ok) {
  blockers.push('Hub repository is not a readable Git worktree');
} else {
  const rootReal = await fs.realpath(root);
  const hubGitReal = await fs.realpath(hubGitRoot.stdout.trim());
  if (rootReal !== hubGitReal) blockers.push('exporter must run from the Hub Git worktree root');
  const hubHeadResult = await runGit(root, ['rev-parse', 'HEAD']);
  if (!hubHeadResult.ok || !/^[0-9a-f]{40}$/i.test(hubHeadResult.stdout.trim())) {
    blockers.push('cannot resolve Hub Git HEAD');
  } else {
    hubHead = hubHeadResult.stdout.trim();
  }
  const hubObjectFormatResult = await runGit(root, ['rev-parse', '--show-object-format']);
  if (!hubObjectFormatResult.ok || !['sha1', 'sha256'].includes(hubObjectFormatResult.stdout.trim())) {
    blockers.push('cannot resolve Hub Git object format');
  } else {
    hubObjectFormat = hubObjectFormatResult.stdout.trim();
  }
}

async function verifyHubTrustPath(relative) {
  return verifyGitPathMatchesHead(root, relative, hubHead, hubObjectFormat, blockers, `${relative}: Hub trust file`);
}

const registryBuffer = await verifyHubTrustPath('registry/projects.json');
const exporterBuffer = await verifyHubTrustPath('scripts/export-project.mjs');
if (!registryBuffer || !exporterBuffer) {
  console.error('Export is blocked because the Hub trust boundary does not match its current Git HEAD.');
  for (const blocker of blockers) console.error(`- ${blocker}`);
  process.exit(1);
}

let registry = null;
try {
  registry = JSON.parse(registryBuffer.toString('utf8'));
} catch {
  console.error('Export is blocked because the committed Hub registry is invalid JSON.');
  process.exit(1);
}
if (!registry || typeof registry !== 'object' || Array.isArray(registry) || !Array.isArray(registry.projects)) {
  console.error('Export is blocked because the committed Hub registry must contain a projects array.');
  process.exit(1);
}
const project = registry.projects.find((candidate) => candidate?.id === projectId);
if (!project) {
  console.error(`Unknown project id: ${projectId}`);
  process.exit(2);
}
const distribution = project.sourceDistribution;
const licensor = typeof distribution?.licensor === 'string' ? distribution.licensor.trim() : '';
const expectedApprovalRecord = `registry/source-approvals/${project.id}.json`;
const registryReady = ['ready', 'published'].includes(distribution?.status)
  && distribution?.model === 'source-available-dual-license'
  && distribution?.communityLicense === expectedCommunityLicense
  && distribution?.commercialAuthorization === 'written-agreement-required'
  && !isPlaceholderIdentity(licensor)
  && project.approvalRecord === expectedApprovalRecord
  && (distribution.status !== 'published'
    || /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(project.sourceRepository ?? ''));
let mappings = null;
try {
  mappings = JSON.parse(await fs.readFile(mappingPath, 'utf8'));
} catch {
  console.error('registry/local-projects.json must contain valid JSON.');
  process.exit(2);
}
const configuredSource = typeof mappings?.[projectId] === 'string' ? mappings[projectId] : '';
const sourceRoot = path.resolve(path.dirname(mappingPath), configuredSource);
if (!configuredSource || !await exists(sourceRoot)) {
  console.error(`Local source is not configured for ${projectId}.`);
  process.exit(2);
}

if (!registryReady) {
  blockers.push('registry source distribution is not ready/published or lacks complete licensing metadata');
}
if (isPlaceholderIdentity(licensor)) {
  blockers.push('registry licensor must be a real non-placeholder legal identity');
}
if (project.approvalRecord !== expectedApprovalRecord) {
  blockers.push(`registry approvalRecord must be ${expectedApprovalRecord}`);
}

for (const relative of requiredSourceFiles) {
  const absolute = path.join(sourceRoot, relative);
  const stat = await lstatIfExists(absolute);
  if (!stat) {
    blockers.push(`${relative} is missing`);
    sourceFiles.set(relative, null);
  } else if (stat.isSymbolicLink()) {
    blockers.push(`${relative}: symbolic links are not allowed for required source files`);
    sourceFiles.set(relative, null);
  } else if (!stat.isFile()) {
    blockers.push(`${relative}: required source entry must be a regular file`);
    sourceFiles.set(relative, null);
  } else {
    const data = await fs.readFile(absolute);
    const text = data.toString('utf8');
    if (!text.trim()) blockers.push(`${relative}: required source file must not be empty`);
    sourceFiles.set(relative, text);
    sourceFileBuffers.set(relative, data);
  }
}

const licenseText = sourceFiles.get('LICENSE');
if (licenseText !== null && licenseText !== undefined) {
  if (normalizedSha256(licenseText) !== expectedCommunityLicenseSha256) {
    blockers.push(`LICENSE does not match ${expectedCommunityLicense}`);
  }
}

let packageJson = null;
const packageText = sourceFiles.get('package.json');
if (packageText !== null && packageText !== undefined) {
  try {
    packageJson = JSON.parse(packageText);
    if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
      blockers.push('package.json must contain a JSON object');
      packageJson = null;
    }
  } catch {
    blockers.push('package.json is invalid JSON');
  }
}
if (packageJson) {
  if (packageJson.version !== project.version) blockers.push('package.json version does not match the registry version');
  if (packageJson.license !== expectedCommunityLicense) blockers.push(`package.json license must be ${expectedCommunityLicense}`);
  if (typeof packageJson.scripts?.test !== 'string' || !packageJson.scripts.test.trim()) {
    blockers.push('package.json must define a non-empty string test script');
  }
  const buildScript = packageJson.scripts?.build;
  const localBuildScript = packageJson.scripts?.['build:local'];
  if (!((typeof buildScript === 'string' && buildScript.trim())
      || (typeof localBuildScript === 'string' && localBuildScript.trim()))) {
    blockers.push('package.json must define build or build:local');
  }
}

const copyrightText = sourceFiles.get('COPYRIGHT');
if (copyrightText !== null && copyrightText !== undefined && licensor) {
  const expectedNotice = `Required Notice: Copyright ${licensor}`;
  if (!copyrightText.split(/\r?\n/).map((line) => line.trim()).includes(expectedNotice)) {
    blockers.push(`COPYRIGHT must contain the exact line: ${expectedNotice}`);
  }
}
const commercialText = sourceFiles.get('COMMERCIAL_LICENSE.md');
if (commercialText !== null && commercialText !== undefined && licensor) {
  const expectedLicensorLine = `Commercial Licensor: ${licensor}`;
  if (!commercialText.split(/\r?\n/).map((line) => line.trim()).includes(expectedLicensorLine)) {
    blockers.push(`COMMERCIAL_LICENSE.md must contain the exact line: ${expectedLicensorLine}`);
  }
}

let sourceApproval = null;
const approvalText = sourceFiles.get('SOURCE_DISTRIBUTION_APPROVAL.json');
if (approvalText !== null && approvalText !== undefined) {
  try {
    sourceApproval = JSON.parse(approvalText);
  } catch {
    blockers.push('SOURCE_DISTRIBUTION_APPROVAL.json is invalid JSON');
  }
}

let approval = null;
let centralApprovalParsed = false;
let centralApprovalText = null;
if (project.approvalRecord === expectedApprovalRecord) {
  const centralApprovalPath = path.resolve(root, project.approvalRecord);
  const centralRelative = path.relative(root, centralApprovalPath);
  if (centralRelative.startsWith('..') || path.isAbsolute(centralRelative)) {
    blockers.push('registry approvalRecord escapes the Hub repository');
  } else {
    const centralBuffer = await verifyHubTrustPath(project.approvalRecord);
    if (centralBuffer) {
      const centralText = centralBuffer.toString('utf8');
      centralApprovalText = centralText;
      if (!centralText.trim()) blockers.push('authoritative Hub approval record must not be empty');
      try {
        approval = JSON.parse(centralText);
        centralApprovalParsed = true;
      } catch {
        blockers.push('authoritative Hub approval record is invalid JSON');
      }
    }
  }
}
if (centralApprovalParsed && !approvalsMatch(sourceApproval, approval)) {
  blockers.push('application approval does not exactly match the authoritative Hub approval record');
}
if (centralApprovalText !== null && approvalText !== null && approvalText !== undefined
    && approvalText !== centralApprovalText) {
  blockers.push('application approval bytes must exactly match the authoritative Hub approval record');
}
if (centralApprovalParsed) {
  if (!hasExactApprovalShape(approval)) blockers.push('authoritative Hub approval must be a JSON object with the exact approval fields');
}
if (hasExactApprovalShape(approval)) {
  if (approval.schemaVersion !== 1) blockers.push('source approval schemaVersion must be 1');
  if (approval.status !== 'ready') blockers.push('source approval status must be ready');
  if (approval.projectId !== project.id) blockers.push('source approval projectId does not match the registry');
  if (approval.version !== project.version) blockers.push('source approval version does not match the registry');
  if (approval.licensor !== licensor) blockers.push('source approval licensor does not match the registry');
  if (approval.contributorRightsStatus !== 'verified') blockers.push('source approval contributorRightsStatus must be verified');
  if (!['sole-author', 'cla-complete', 'written-assignments', 'mixed-reviewed'].includes(approval.contributorRightsBasis)) {
    blockers.push('source approval contributorRightsBasis is invalid');
  }
  if (approval.thirdPartyRightsStatus !== 'verified') blockers.push('source approval thirdPartyRightsStatus must be verified');
  if (isPlaceholderIdentity(approval.reviewedBy)) {
    blockers.push('source approval reviewedBy must identify the reviewer');
  }
  if (!isValidIsoDate(approval.reviewedAt)) blockers.push('source approval reviewedAt must be a real YYYY-MM-DD date');
  if (!isHexString(approval.reviewedSourceRevision, 40)) {
    blockers.push('source approval reviewedSourceRevision must be a full Git commit');
  }
  if (!isHexString(approval.contentManifestSha256, 64)) {
    blockers.push('source approval contentManifestSha256 must be SHA-256');
  }
}

let sourceHead = '';
const gitRoot = await runGit(sourceRoot, ['rev-parse', '--show-toplevel']);
if (!gitRoot.ok) {
  blockers.push('source root is not a readable Git worktree');
} else {
  const sourceReal = await fs.realpath(sourceRoot);
  const gitReal = await fs.realpath(gitRoot.stdout.trim());
  if (sourceReal !== gitReal) blockers.push('local project mapping must point to the Git worktree root');
  const gitStatus = await runGit(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!gitStatus.ok || gitStatus.stdout.length > 0) blockers.push('source Git worktree must be clean before export');
  const head = await runGit(sourceRoot, ['rev-parse', 'HEAD']);
  if (!head.ok || !/^[0-9a-f]{40}$/i.test(head.stdout.trim())) blockers.push('cannot resolve source Git HEAD');
  else sourceHead = head.stdout.trim();
  const sourceObjectFormatResult = await runGit(sourceRoot, ['rev-parse', '--show-object-format']);
  if (!sourceObjectFormatResult.ok || !['sha1', 'sha256'].includes(sourceObjectFormatResult.stdout.trim())) {
    blockers.push('cannot resolve source Git object format');
  } else {
    sourceObjectFormat = sourceObjectFormatResult.stdout.trim();
  }
  if (approval && isHexString(approval.reviewedSourceRevision, 40)) {
    const revisionExists = await runGit(sourceRoot, ['cat-file', '-e', `${approval.reviewedSourceRevision}^{commit}`]);
    const revisionIsAncestor = await runGit(sourceRoot, ['merge-base', '--is-ancestor', approval.reviewedSourceRevision, sourceHead]);
    if (!revisionExists.ok || !revisionIsAncestor.ok) {
      blockers.push('source approval reviewedSourceRevision is not an ancestor of the current HEAD');
    } else {
      const changedSinceReview = await runGit(sourceRoot, [
        'diff', '--name-only', '-z', `${approval.reviewedSourceRevision}..${sourceHead}`, '--',
      ]);
      const changedPaths = new Set(changedSinceReview.stdout.split('\0').filter(Boolean));
      if (!changedSinceReview.ok
          || changedPaths.size !== 1
          || !changedPaths.has('SOURCE_DISTRIBUTION_APPROVAL.json')) {
        blockers.push('only SOURCE_DISTRIBUTION_APPROVAL.json may change after reviewedSourceRevision');
      }
    }
  }
}

async function collect(absoluteDir, relativeDir) {
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const relative = path.posix.join(relativeDir.split(path.sep).join('/'), entry.name);
    if (excludedRelativePaths.has(relative)) continue;
    if (excludedNames.has(entry.name.toLowerCase())) continue;
    if (entry.isSymbolicLink()) {
      blockers.push(`${relative}: symbolic link requires manual review`);
      continue;
    }
    if (entry.isDirectory()) {
      await collect(path.join(absoluteDir, entry.name), relative);
      continue;
    }
    if (!entry.isFile()) {
      blockers.push(`${relative}: only regular files may enter the export`);
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (excludedExtensions.has(extension) || hasForbiddenName(entry.name)) {
      blockers.push(`${relative}: forbidden artifact type`);
      continue;
    }
    const absolute = path.join(absoluteDir, entry.name);
    const stat = await fs.lstat(absolute);
    if (stat.size > maxFileBytes) {
      blockers.push(`${relative}: exceeds ${maxFileBytes} bytes and requires manual review`);
      continue;
    }
    await inspectCandidateFile(absolute, relative, planned, blockers);
  }
}

for (const entry of await fs.readdir(sourceRoot, { withFileTypes: true })) {
  if (entry.isSymbolicLink() && (allowedRootFiles.has(entry.name) || allowedRootDirs.has(entry.name))) {
    blockers.push(`${entry.name}: symbolic links are not allowed in the export allowlist`);
    continue;
  }
  if (entry.isFile() && allowedRootFiles.has(entry.name)) {
    const absolute = path.join(sourceRoot, entry.name);
    const stat = await fs.lstat(absolute);
    if (stat.size <= maxFileBytes) {
      await inspectCandidateFile(absolute, entry.name, planned, blockers, sourceFileBuffers.get(entry.name));
    }
    else blockers.push(`${entry.name}: exceeds ${maxFileBytes} bytes`);
  }
  if (entry.isDirectory() && allowedRootDirs.has(entry.name)) {
    await collect(path.join(sourceRoot, entry.name), entry.name);
  }
}

planned.sort((a, b) => a.relative.localeCompare(b.relative));
const sourceIndexFlags = await runGit(sourceRoot, ['ls-files', '-v', '-z']);
if (!sourceIndexFlags.ok) {
  blockers.push('cannot enumerate source Git index flags');
} else {
  const unsafeFlags = sourceIndexFlags.stdout
    .split('\0')
    .filter(Boolean)
    .filter((record) => record[0] !== 'H')
    .map((record) => record.slice(2));
  if (unsafeFlags.length > 0) {
    blockers.push(`source Git index uses assume-unchanged, skip-worktree, or a non-default stage: ${unsafeFlags.slice(0, 10).join(', ')}`);
  }
}
const sourceHeadTree = await runGit(sourceRoot, ['ls-tree', '-r', '-z', sourceHead || 'HEAD']);
const sourceIndex = await runGit(sourceRoot, ['ls-files', '-s', '-z']);
if (!sourceHeadTree.ok || !sourceIndex.ok) {
  blockers.push('cannot enumerate source HEAD and index blobs');
} else {
  const headEntries = new Map();
  for (const record of sourceHeadTree.stdout.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const metadata = tab >= 0 ? record.slice(0, tab).split(' ') : [];
    if (metadata.length === 3 && /^[0-9a-f]{40,64}$/i.test(metadata[2] ?? '')) {
      headEntries.set(record.slice(tab + 1), {
        mode: metadata[0],
        type: metadata[1],
        hash: metadata[2],
      });
    }
  }
  const indexBlobs = new Map();
  for (const record of sourceIndex.stdout.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const metadata = tab >= 0 ? record.slice(0, tab).split(' ') : [];
    if (/^[0-9a-f]{40,64}$/i.test(metadata[1] ?? '') && metadata[2] === '0') {
      indexBlobs.set(record.slice(tab + 1), { mode: metadata[0], hash: metadata[1] });
    }
  }
  const plannedPaths = new Set(planned.map((item) => item.relative));
  const expectedPaths = new Set();
  for (const [relative, entry] of headEntries) {
    if (!isAllowedRelativePath(relative)) continue;
    expectedPaths.add(relative);
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
      blockers.push(`${relative}: source HEAD allowlist entry must be a regular 100644/100755 blob, not a symlink or submodule`);
    }
  }
  const missingFromPlan = [...expectedPaths].filter((relative) => !plannedPaths.has(relative));
  if (missingFromPlan.length > 0) {
    blockers.push(`worktree candidate omitted source HEAD allowlist paths: ${missingFromPlan.slice(0, 20).join(', ')}`);
  }
  for (const item of planned) {
    const headEntry = headEntries.get(item.relative);
    const indexBlob = indexBlobs.get(item.relative);
    if (!headEntry || !indexBlob) {
      blockers.push(`${item.relative}: planned export file must exist in both source HEAD and index`);
    } else if (headEntry.mode !== indexBlob.mode
        || !['100644', '100755'].includes(indexBlob.mode)
        || headEntry.hash !== indexBlob.hash
        || headEntry.hash !== item.gitBlobHash) {
      blockers.push(`${item.relative}: worktree, index, and source HEAD modes/bytes must exactly match regular files`);
    }
  }
}
const manifestInput = planned
  .filter((item) => item.relative !== 'SOURCE_DISTRIBUTION_APPROVAL.json')
  .map((item) => `${item.relative}\0${item.size}\0${item.sha256}\n`)
  .join('');
const contentManifestSha256 = rawSha256(manifestInput);
if (approval?.contentManifestSha256 !== contentManifestSha256) {
  blockers.push('source approval contentManifestSha256 does not match the current export candidate');
}
const finalHubHead = await runGit(root, ['rev-parse', 'HEAD']);
if (!finalHubHead.ok || finalHubHead.stdout.trim() !== hubHead) {
  blockers.push('Hub HEAD changed during export evaluation');
}
const finalSourceHead = await runGit(sourceRoot, ['rev-parse', 'HEAD']);
if (!finalSourceHead.ok || finalSourceHead.stdout.trim() !== sourceHead) {
  blockers.push('source HEAD changed during export evaluation');
}
console.log(`${write ? 'Write' : 'Dry-run'} export for ${project.name} ${project.version}`);
console.log(`- planned files: ${planned.length}`);
console.log(`- planned bytes: ${planned.reduce((sum, item) => sum + item.size, 0)}`);
console.log(`- source HEAD: ${sourceHead || 'unavailable'}`);
console.log(`- Hub HEAD: ${hubHead || 'unavailable'}`);
console.log(`- content manifest SHA-256: ${contentManifestSha256}`);
console.log(`- review blockers: ${blockers.length}`);
for (const blocker of blockers) console.log(`  - ${blocker}`);

if (blockers.length > 0) {
  console.error(`${write ? 'Write export' : 'Dry-run'} is blocked until every listed issue is closed.`);
  process.exit(1);
}
if (!write) process.exit(0);

const distRoot = path.resolve(root, 'dist');
const outputRoot = path.resolve(distRoot, projectId);
const outputRelative = path.relative(distRoot, outputRoot);
if (!outputRelative || outputRelative.startsWith('..') || path.isAbsolute(outputRelative)) {
  console.error('Refusing an export path outside the repository dist directory.');
  process.exit(1);
}
const distStat = await lstatIfExists(distRoot);
if (distStat?.isSymbolicLink() || (distStat && !distStat.isDirectory())) {
  console.error('Refusing to use dist because it is a symbolic link or not a directory.');
  process.exit(1);
}
await fs.mkdir(distRoot, { recursive: true, mode: 0o700 });
const createdDistStat = await fs.lstat(distRoot);
const repositoryReal = await fs.realpath(root);
const distReal = await fs.realpath(distRoot);
if (createdDistStat.isSymbolicLink()
    || !createdDistStat.isDirectory()
    || path.dirname(distReal) !== repositoryReal
    || path.basename(distReal) !== 'dist') {
  console.error('Refusing to use a dist directory outside the real Hub repository root.');
  process.exit(1);
}
if (await lstatIfExists(outputRoot)) {
  console.error(`Refusing to overwrite existing output: ${path.relative(root, outputRoot)}`);
  process.exit(1);
}
const stagingRoot = await fs.mkdtemp(path.join(distRoot, `.tmp-${projectId}-`));
let published = false;
try {
  const stagingReal = await fs.realpath(stagingRoot);
  const stagingRelative = path.relative(distReal, stagingReal);
  if (!stagingRelative || stagingRelative.startsWith('..') || path.isAbsolute(stagingRelative)) {
    throw new Error('staging containment check failed');
  }
  for (const item of planned) {
    const destination = path.join(stagingRoot, item.relative);
    const destinationRelative = path.relative(stagingRoot, destination);
    if (!destinationRelative || destinationRelative.startsWith('..') || path.isAbsolute(destinationRelative)) {
      throw new Error(`destination containment check failed for ${item.relative}`);
    }
    const destinationParent = path.dirname(destination);
    await fs.mkdir(destinationParent, { recursive: true, mode: 0o700 });
    const parentReal = await fs.realpath(destinationParent);
    const parentRelative = path.relative(stagingReal, parentReal);
    if (parentRelative.startsWith('..') || path.isAbsolute(parentRelative)) {
      throw new Error(`destination parent escaped staging for ${item.relative}`);
    }
    await fs.writeFile(destination, item.data, { flag: 'wx', mode: 0o600 });
    const copiedStat = await fs.lstat(destination);
    if (copiedStat.isSymbolicLink() || !copiedStat.isFile()) {
      throw new Error(`copied entry is not a regular file: ${item.relative}`);
    }
    const copied = await fs.readFile(destination);
    if (rawSha256(copied) !== item.sha256) {
      throw new Error(`copied file hash mismatch: ${item.relative}`);
    }
  }
  const finalStagingStat = await fs.lstat(stagingRoot);
  const finalStagingReal = await fs.realpath(stagingRoot);
  if (finalStagingStat.isSymbolicLink()
      || !finalStagingStat.isDirectory()
      || finalStagingReal !== stagingReal
      || await lstatIfExists(outputRoot)) {
    throw new Error('staging directory changed or final output appeared during export');
  }
  await fs.rename(stagingRoot, outputRoot);
  published = true;
} catch {
  console.error('Local export failed safely; no final export was created.');
  process.exitCode = 1;
} finally {
  if (!published) {
    const stagingStat = await lstatIfExists(stagingRoot);
    if (stagingStat?.isSymbolicLink()) {
      await fs.unlink(stagingRoot);
    } else if (stagingStat?.isDirectory()) {
      const stagingReal = await fs.realpath(stagingRoot);
      const stagingRelative = path.relative(distReal, stagingReal);
      if (stagingRelative && !stagingRelative.startsWith('..') && !path.isAbsolute(stagingRelative)) {
        await fs.rm(stagingRoot, { recursive: true, force: true });
      }
    }
  }
}
if (published) console.log(`Local export created at ${path.relative(root, outputRoot)}. No remote action was performed.`);
