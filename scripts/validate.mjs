import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowedStatuses = new Set(['candidate', 'labs', 'incubating', 'stable']);
const allowedMetricStatuses = new Set(['pass', 'partial', 'blocked', 'not_run']);
const allowedEvidence = new Set(['L1', 'L2', 'L3', 'L4', 'L5']);
const allowedSourceDistributionStatuses = new Set(['pending', 'ready', 'published']);
const sourceDistributionModel = 'source-available-dual-license';
const communityLicense = 'PolyForm-Noncommercial-1.0.0';
const commercialAuthorization = 'written-agreement-required';
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
const requiredCommon = new Set([
  'closed-loop',
  'data-truth',
  'agent-decision',
  'lifecycle',
  'offline-privacy',
  'reproducibility',
]);
const requiredPublicFiles = [
  'README.md',
  'README.en.md',
  'LICENSE',
  'LICENSE_POLICY.md',
  'COMMERCIAL_LICENSE.md',
  'TRADEMARKS.md',
  'CLA.md',
  'licenses/PolyForm-Noncommercial-1.0.0.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'PRIVACY.md',
  'THIRD_PARTY_NOTICES.md',
  'CODE_OF_CONDUCT.md',
  'GOVERNANCE.md',
  'ROADMAP.md',
  'benchmark/result.schema.json',
  'registry/projects.json',
  'registry/source-distribution-approval.example.json',
  'registry/source-approvals/README.md',
  '.github/CODEOWNERS',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/ISSUE_TEMPLATE/contribution-survey.yml',
  '.github/ISSUE_TEMPLATE/bug-and-device-evidence.yml',
  'articles/从本地到GitHub_一步步开源AIUI项目.md',
  'docs/SOURCE_DISTRIBUTION_APPROVAL.md',
  'package.json',
  'package-lock.json',
  'scripts/audit-local.mjs',
  'scripts/export-project.mjs',
  'scripts/validate.mjs',
  'scripts/validate-licensing.mjs',
  'scripts/test-export-policy.mjs',
  'scripts/source-manifest.mjs',
  'apps/README.md',
  'assets/README.md',
  'assets/project-icons/README.md',
  'assets/project-icons/smartrun-orange.png',
  'assets/project-icons/aibike-orange.png',
  'assets/project-icons/aismartrower-orange.png',
  'assets/project-icons/aismartpaddle-orange.png',
  'assets/architecture/aiui-sports-agents-agent-hub-blue-ink.png',
  'assets/architecture/aiui-sports-agents-home-overview-handdrawn-v3.png',
  'assets/architecture/aiui-sports-agents-technical-architecture-handdrawn.png',
];
const forbiddenExtensions = new Set([
  '.aix', '.apk', '.aab', '.pem', '.key', '.jks', '.keystore', '.p12', '.pfx', '.db', '.docx', '.jsonl', '.pdf', '.zip',
]);
const forbiddenExactNames = new Set(['.npmrc', '.netrc', 'id_rsa', 'id_ed25519']);
const forbiddenNamePatterns = [/^credentials.*\.json$/i, /^service-account.*\.json$/i];
const allowedBinaryExtensions = new Set([
  '.gif', '.jpeg', '.jpg', '.mp3', '.mp4', '.otf', '.png', '.ttf', '.wav', '.webp', '.woff', '.woff2',
]);
const forbiddenSecretPatterns = [
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
const errors = [];
const execFileAsync = promisify(execFile);
const publicDataByPath = new Map();
let canonicalGitIndex = false;
let capturedIndexTree = null;
let capturedIndexFlags = null;

async function exists(relativePath) {
  try {
    await fs.access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readJson(relativePath) {
  try {
    const data = canonicalGitIndex
      ? publicDataByPath.get(relativePath)
      : await fs.readFile(path.join(root, relativePath));
    if (!data) throw new Error('file is not present in the canonical Git index');
    return JSON.parse(data.toString('utf8'));
  } catch (error) {
    errors.push(`${relativePath}: invalid or unreadable JSON (${error.message})`);
    return null;
  }
}

function isJsonObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isHexString(value, length) {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`, 'i').test(value);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function isRealIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function inspectPublicData(relative, data) {
  const issues = [];
  const extension = path.extname(relative).toLowerCase();
  const searchableBytes = data.toString('latin1');
  const absoluteHomePattern = new RegExp('/' + 'Users' + '/');
  const windowsHomePattern = new RegExp('[A-Za-z]:\\\\' + 'Users' + '\\\\');
  if (absoluteHomePattern.test(searchableBytes)
      || windowsHomePattern.test(searchableBytes)
      || searchableBytes.includes('file:' + '//')) {
    issues.push('contains a local absolute path');
  }
  for (const [label, pattern] of forbiddenSecretPatterns) {
    if (pattern.test(searchableBytes)) issues.push(`contains a possible ${label}`);
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
    if (!hasSignature) issues.push('extension does not match the expected binary signature');
  } else {
    try {
      if (data.includes(0)) throw new Error('NUL byte');
      new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      issues.push('unknown binary content requires explicit review or exclusion');
    }
  }
  return issues;
}

function checkRelativeFile(value, label) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.split('/').includes('..')) {
    errors.push(`${label}: must be a repository-relative path`);
    return false;
  }
  return true;
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

function checkProtectedApproval(approval, project, distribution) {
  const prefix = `project:${project.id}.approvalRecord`;
  if (!hasExactApprovalShape(approval)) errors.push(`${prefix}: approval contains missing or unexpected fields`);
  if (approval?.schemaVersion !== 1 || approval?.status !== 'ready') {
    errors.push(`${prefix}: schemaVersion/status must be 1/ready`);
  }
  if (approval?.projectId !== project.id
      || approval?.version !== project.version
      || approval?.licensor !== distribution?.licensor) {
    errors.push(`${prefix}: project, version, or licensor does not match the registry`);
  }
  if (approval?.contributorRightsStatus !== 'verified'
      || !['sole-author', 'cla-complete', 'written-assignments', 'mixed-reviewed'].includes(approval?.contributorRightsBasis)) {
    errors.push(`${prefix}: contributor rights are not fully verified`);
  }
  if (approval?.thirdPartyRightsStatus !== 'verified') {
    errors.push(`${prefix}: third-party rights are not fully verified`);
  }
  if (!isHexString(approval?.reviewedSourceRevision, 40)
      || !isHexString(approval?.contentManifestSha256, 64)
      || !isRealIsoDate(approval?.reviewedAt)
      || isPlaceholderIdentity(approval?.reviewedBy)) {
    errors.push(`${prefix}: review metadata is incomplete or contains a placeholder`);
  }
}

async function checkIntegratedApplication(project, distribution, publicPaths) {
  const prefix = `project:${project.id}`;
  const expectedSourcePath = `apps/${project.id}`;
  if (project.sourcePath !== null && project.sourcePath !== expectedSourcePath) {
    errors.push(`${prefix}.sourcePath: must be null or ${expectedSourcePath}`);
  }
  if (distribution?.status === 'pending' && project.sourcePath !== null) {
    errors.push(`${prefix}: pending source distribution cannot advertise an integrated sourcePath`);
    return;
  }
  if (distribution?.status !== 'published') return;
  if (project.sourcePath !== expectedSourcePath) {
    errors.push(`${prefix}: published integrated source requires sourcePath ${expectedSourcePath}`);
    return;
  }

  const required = [
    'README.md',
    'LICENSE',
    'COPYRIGHT',
    'COMMERCIAL_LICENSE.md',
    'TRADEMARKS.md',
    'package.json',
    'SOURCE_DISTRIBUTION_APPROVAL.json',
  ].map((name) => `${expectedSourcePath}/${name}`);
  for (const relative of required) {
    if (!publicPaths.has(relative)) errors.push(`${prefix}: integrated source is missing tracked ${relative}`);
  }

  const licensePath = `${expectedSourcePath}/LICENSE`;
  const referenceLicense = publicDataByPath.get('licenses/PolyForm-Noncommercial-1.0.0.md');
  const appLicense = publicDataByPath.get(licensePath);
  if (!referenceLicense || !appLicense || !appLicense.equals(referenceLicense)) {
    errors.push(`${prefix}: integrated source LICENSE must exactly match the canonical PolyForm text`);
  }

  const packagePath = `${expectedSourcePath}/package.json`;
  let appPackage = null;
  try {
    appPackage = JSON.parse(publicDataByPath.get(packagePath)?.toString('utf8') ?? 'null');
  } catch (error) {
    errors.push(`${prefix}: integrated package.json is invalid (${error.message})`);
  }
  if (!isJsonObject(appPackage)
      || appPackage.version !== project.version
      || appPackage.license !== communityLicense) {
    errors.push(`${prefix}: integrated package version/license must match Registry and PolyForm`);
  }

  const sourceApprovalPath = `${expectedSourcePath}/SOURCE_DISTRIBUTION_APPROVAL.json`;
  const centralApprovalPath = `registry/source-approvals/${project.id}.json`;
  const sourceApprovalData = publicDataByPath.get(sourceApprovalPath);
  const centralApprovalData = publicDataByPath.get(centralApprovalPath);
  if (!sourceApprovalData || !centralApprovalData || !sourceApprovalData.equals(centralApprovalData)) {
    errors.push(`${prefix}: application and authoritative Hub approval records must be byte-identical`);
    return;
  }
  let approval = null;
  try {
    approval = JSON.parse(sourceApprovalData.toString('utf8'));
  } catch (error) {
    errors.push(`${prefix}: application approval is invalid JSON (${error.message})`);
    return;
  }
  if (!isJsonObject(approval)) {
    errors.push(`${prefix}: application approval must be a JSON object`);
    return;
  }

  const manifestInput = [...publicPaths]
    .filter((relative) => relative.startsWith(`${expectedSourcePath}/`)
      && relative !== sourceApprovalPath)
    .sort()
    .map((relative) => {
      const data = publicDataByPath.get(relative);
      return `${relative.slice(expectedSourcePath.length + 1)}\0${data.length}\0${sha256(data)}\n`;
    })
    .join('');
  if (approval.contentManifestSha256 !== sha256(manifestInput)) {
    errors.push(`${prefix}: approval manifest does not match integrated source bytes`);
  }

  if (capturedIndexTree && isHexString(approval.reviewedSourceRevision, 40)) {
    try {
      const { stdout } = await execFileAsync('git', [
        '-C', root, 'diff', '--name-only', '-z',
        approval.reviewedSourceRevision, capturedIndexTree, '--', expectedSourcePath,
      ], {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
      });
      const changed = stdout.split('\0').filter(Boolean);
      if (changed.length !== 1 || changed[0] !== sourceApprovalPath) {
        errors.push(`${prefix}: only the application approval record may change after reviewedSourceRevision`);
      }
    } catch (error) {
      errors.push(`${prefix}: reviewed source revision cannot be compared (${error.message})`);
    }
  }
}

function checkMetricList(metrics, label) {
  if (!Array.isArray(metrics) || metrics.length === 0) {
    errors.push(`${label}: must contain at least one metric`);
    return;
  }
  const ids = new Set();
  for (const [index, metric] of metrics.entries()) {
    const prefix = `${label}[${index}]`;
    if (!metric || typeof metric !== 'object') {
      errors.push(`${prefix}: must be an object`);
      continue;
    }
    if (!/^[a-z0-9-]+$/.test(metric.id ?? '')) errors.push(`${prefix}.id: invalid id`);
    if (ids.has(metric.id)) errors.push(`${prefix}.id: duplicate ${metric.id}`);
    ids.add(metric.id);
    if (!allowedMetricStatuses.has(metric.status)) errors.push(`${prefix}.status: invalid status`);
    if (!Array.isArray(metric.evidence)) errors.push(`${prefix}.evidence: must be an array`);
    if (typeof metric.notes !== 'string') errors.push(`${prefix}.notes: must be a string`);
  }
}

async function listPublicEntries() {
  const gitEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };
  try {
    const { stdout: topLevelOutput } = await execFileAsync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      env: gitEnv,
    });
    if (await fs.realpath(topLevelOutput.trim()) !== await fs.realpath(root)) {
      errors.push('validation root is not the canonical Git worktree root');
      return [];
    }
  } catch (error) {
    errors.push(`canonical Git worktree cannot be verified (${error.message})`);
    return [];
  }

  try {
    const { stdout: treeOutput } = await execFileAsync('git', ['-C', root, 'write-tree'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      env: gitEnv,
    });
    capturedIndexTree = treeOutput.trim();
    const [{ stdout: treeEntriesOutput }, { stdout: flagOutput }] = await Promise.all([
      execFileAsync('git', ['-C', root, 'ls-tree', '-r', '-z', '--full-tree', capturedIndexTree], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        env: gitEnv,
      }),
      execFileAsync('git', ['-C', root, 'ls-files', '-v', '-z', '--cached'], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        env: gitEnv,
      }),
    ]);
    capturedIndexFlags = flagOutput;
    const flags = new Map();
    for (const record of flagOutput.split('\0').filter(Boolean)) {
      flags.set(record.slice(2), record[0]);
    }
    const entries = [];
    for (const record of treeEntriesOutput.split('\0').filter(Boolean)) {
      const separator = record.indexOf('\t');
      if (separator === -1) {
        errors.push('Git index contains an unreadable ls-files entry');
        continue;
      }
      const [mode, type, oid] = record.slice(0, separator).split(' ');
      const relative = record.slice(separator + 1);
      entries.push({ relative, source: 'index', mode, type, oid, flag: flags.get(relative) });
    }
    canonicalGitIndex = true;
    if (entries.length === 0) errors.push('canonical Git index is empty');
    return entries.sort((left, right) => left.relative.localeCompare(right.relative));
  } catch (error) {
    errors.push(`Git index cannot be enumerated safely (${error.message})`);
    return [];
  }
}

async function readIndexBlob(oid) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'cat-file', 'blob', oid], {
      encoding: null,
      maxBuffer: 100 * 1024 * 1024,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (error) {
    errors.push(`Git index blob ${oid}: cannot be read (${error.message})`);
    return null;
  }
}

const publicEntries = await listPublicEntries();
if (canonicalGitIndex) {
  for (const entry of publicEntries) {
    const data = await readIndexBlob(entry.oid);
    if (data) publicDataByPath.set(entry.relative, data);
  }
}
const publicPaths = new Set(publicEntries.map((entry) => entry.relative));
for (const relativePath of requiredPublicFiles) {
  if (!await exists(relativePath)) errors.push(`${relativePath}: required public file is missing`);
  if (canonicalGitIndex && !publicPaths.has(relativePath)) {
    errors.push(`${relativePath}: required public file is not staged or tracked in the Git index`);
  }
}

const readmeText = publicDataByPath.get('README.md')?.toString('utf8') ?? '';
for (const requiredFragment of [
  'apps/smartrun',
  'apps/aibike',
  'apps/aismartrower',
  'assets/project-icons/smartrun-orange.png',
  'assets/project-icons/aibike-orange.png',
  'assets/project-icons/aismartrower-orange.png',
  'assets/project-icons/aismartpaddle-orange.png',
  'assets/architecture/aiui-sports-agents-home-overview-handdrawn-v3.png',
  'assets/architecture/aiui-sports-agents-agent-hub-blue-ink.png',
  'assets/architecture/aiui-sports-agents-technical-architecture-handdrawn.png',
  '## AISmartRun 的可选 EverMind 对接边界',
  'https://github.com/EverMind-AI',
  'apps/smartrun/README.md#evermind-oriented-backend-contract',
]) {
  if (!readmeText.includes(requiredFragment)) {
    errors.push(`README.md: homepage must expose ${requiredFragment}`);
  }
}

for (const [projectPage, expectedIcon] of Object.entries({
  'projects/smartrun.md': '../assets/project-icons/smartrun-orange.png',
  'projects/aibike.md': '../assets/project-icons/aibike-orange.png',
  'projects/aismartrower.md': '../assets/project-icons/aismartrower-orange.png',
  'projects/aismartpaddle.md': '../assets/project-icons/aismartpaddle-orange.png',
})) {
  const pageText = publicDataByPath.get(projectPage)?.toString('utf8') ?? '';
  if (!pageText.includes(expectedIcon)) {
    errors.push(`${projectPage}: project page must expose its corresponding icon ${expectedIcon}`);
  }
}

const registry = await readJson('registry/projects.json');
const approvalExample = await readJson('registry/source-distribution-approval.example.json');
const projectIds = new Set();
let projectCount = 0;
let metricCount = 0;

if (!isJsonObject(registry)) {
  errors.push('registry/projects.json: top-level JSON value must be an object');
} else {
  if (registry.schemaVersion !== 2) errors.push('registry/projects.json: schemaVersion must be 2');
  if (!Array.isArray(registry.projects) || registry.projects.length === 0) {
    errors.push('registry/projects.json: projects must be a non-empty array');
  } else {
    projectCount = registry.projects.length;
    for (const project of registry.projects) {
      if (!isJsonObject(project)) {
        errors.push('registry/projects.json: every project entry must be an object');
        continue;
      }
      const prefix = `project:${project.id ?? '<missing>'}`;
      if (Object.hasOwn(project, 'openSourceExport')) {
        errors.push(`${prefix}.openSourceExport: legacy field is forbidden; use sourceDistribution`);
      }
      if (!/^[a-z0-9-]+$/.test(project.id ?? '')) errors.push(`${prefix}: invalid id`);
      if (projectIds.has(project.id)) errors.push(`${prefix}: duplicate id`);
      projectIds.add(project.id);
      if (!allowedStatuses.has(project.status)) errors.push(`${prefix}: invalid status`);
      if (!project.version || typeof project.version !== 'string') errors.push(`${prefix}: version is required`);
      if (!Array.isArray(project.protocols) || project.protocols.length === 0) errors.push(`${prefix}: protocols are required`);
      if (project.sourceRepository !== null && (typeof project.sourceRepository !== 'string'
          || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(project.sourceRepository))) {
        errors.push(`${prefix}.sourceRepository: must be null or a GitHub repository URL`);
      }
      const expectedApprovalRecord = `registry/source-approvals/${project.id}.json`;
      if (project.approvalRecord !== null && project.approvalRecord !== expectedApprovalRecord) {
        errors.push(`${prefix}.approvalRecord: must be null or ${expectedApprovalRecord}`);
      }
      const distribution = project.sourceDistribution;
      if (!distribution || typeof distribution !== 'object' || Array.isArray(distribution)) {
        errors.push(`${prefix}.sourceDistribution: must be an object`);
      } else {
        if (!allowedSourceDistributionStatuses.has(distribution.status)) {
          errors.push(`${prefix}.sourceDistribution.status: invalid status`);
        }
        if (distribution.model !== sourceDistributionModel) {
          errors.push(`${prefix}.sourceDistribution.model: must be ${sourceDistributionModel}`);
        }
        if (distribution.communityLicense !== communityLicense) {
          errors.push(`${prefix}.sourceDistribution.communityLicense: must be ${communityLicense}`);
        }
        if (distribution.commercialAuthorization !== commercialAuthorization) {
          errors.push(`${prefix}.sourceDistribution.commercialAuthorization: must be ${commercialAuthorization}`);
        }
        if (distribution.licensor !== null
            && isPlaceholderIdentity(distribution.licensor)) {
          errors.push(`${prefix}.sourceDistribution.licensor: must be null or a real non-placeholder legal identity`);
        }
        if (distribution.status === 'pending' && project.sourceRepository !== null) {
          errors.push(`${prefix}: pending source distribution cannot advertise a source repository`);
        }
        if (distribution.status === 'pending' && project.approvalRecord !== null) {
          errors.push(`${prefix}: pending source distribution cannot advertise an approval record`);
        }
        if (distribution.status !== 'pending' && !distribution.licensor) {
          errors.push(`${prefix}: ready or published source distribution requires a legal licensor identity`);
        }
        if (distribution.status !== 'pending' && project.approvalRecord !== expectedApprovalRecord) {
          errors.push(`${prefix}: ready or published source distribution requires its authoritative Hub approval record`);
        }
        if (distribution.status === 'published' && project.sourceRepository === null) {
          errors.push(`${prefix}: published source distribution requires sourceRepository`);
        }
      }
      await checkIntegratedApplication(project, distribution, publicPaths);
      if (typeof project.approvalRecord === 'string') {
        if (canonicalGitIndex && !publicPaths.has(project.approvalRecord)) {
          errors.push(`${prefix}.approvalRecord: referenced approval is not staged or tracked in the Git index`);
        }
        const approvalPath = path.join(root, project.approvalRecord);
        let approvalStat = null;
        try {
          approvalStat = await fs.lstat(approvalPath);
        } catch (error) {
          if (error?.code !== 'ENOENT') errors.push(`${prefix}.approvalRecord: cannot inspect approval (${error.message})`);
        }
        if (!approvalStat) {
          errors.push(`${prefix}.approvalRecord: referenced approval does not exist`);
        } else if (approvalStat.isSymbolicLink() || !approvalStat.isFile()) {
          errors.push(`${prefix}.approvalRecord: approval must be a regular non-symlink file`);
        } else {
          const approval = await readJson(project.approvalRecord);
          if (!isJsonObject(approval)) {
            errors.push(`${prefix}.approvalRecord: top-level JSON value must be an object`);
          } else {
            checkProtectedApproval(approval, project, distribution);
          }
        }
      }
      for (const field of ['profile', 'result']) {
        const value = project[field];
        if (checkRelativeFile(value, `${prefix}.${field}`)) {
          if (canonicalGitIndex && !publicPaths.has(value)) {
            errors.push(`${prefix}.${field}: referenced file is not staged or tracked in the Git index (${value})`);
          }
          if (!await exists(value)) errors.push(`${prefix}.${field}: referenced file does not exist (${value})`);
        }
      }

      const result = await readJson(project.result);
      if (!isJsonObject(result)) {
        errors.push(`${project.result}: top-level JSON value must be an object`);
        continue;
      }
      if (result.schemaVersion !== 1) errors.push(`${project.result}: schemaVersion must be 1`);
      if (result.projectId !== project.id) errors.push(`${project.result}: projectId does not match registry`);
      if (result.version !== project.version) errors.push(`${project.result}: version does not match registry`);
      if (!allowedEvidence.has(result.evidenceLevel)) errors.push(`${project.result}: invalid evidenceLevel`);
      if (!isRealIsoDate(result.lastUpdated)) errors.push(`${project.result}: invalid lastUpdated`);
      if (!result.sourceRevision || typeof result.sourceRevision !== 'string') errors.push(`${project.result}: sourceRevision is required`);
      if (!Array.isArray(result.openGates)) errors.push(`${project.result}: openGates must be an array`);
      checkMetricList(result.common, `${project.result}.common`);
      checkMetricList(result.sportSpecific, `${project.result}.sportSpecific`);
      metricCount += (result.common?.length ?? 0) + (result.sportSpecific?.length ?? 0);
      const commonIds = new Set((result.common ?? []).map((metric) => metric.id));
      for (const id of requiredCommon) {
        if (!commonIds.has(id)) errors.push(`${project.result}: missing common metric ${id}`);
      }
      for (const metric of [...(result.common ?? []), ...(result.sportSpecific ?? [])]) {
        for (const evidencePath of metric.evidence ?? []) {
          if (checkRelativeFile(evidencePath, `${project.result}:${metric.id}.evidence`)) {
            if (canonicalGitIndex && !publicPaths.has(evidencePath)) {
              errors.push(`${project.result}:${metric.id}: evidence is not staged or tracked in the Git index (${evidencePath})`);
            }
            if (!await exists(evidencePath)) {
              errors.push(`${project.result}:${metric.id}: missing evidence path ${evidencePath}`);
            }
          }
        }
      }
    }
  }
}

if (!isJsonObject(approvalExample)) {
  errors.push('source approval example: top-level JSON value must be an object');
} else {
  if (approvalExample.schemaVersion !== 1) errors.push('source approval example: schemaVersion must be 1');
  if (approvalExample.status !== 'draft') errors.push('source approval example: status must remain draft');
  if (approvalExample.contributorRightsStatus !== 'pending') {
    errors.push('source approval example: contributorRightsStatus must remain pending');
  }
  if (approvalExample.thirdPartyRightsStatus !== 'pending') {
    errors.push('source approval example: thirdPartyRightsStatus must remain pending');
  }
  if (approvalExample.contributorRightsBasis !== null) {
    errors.push('source approval example: contributorRightsBasis must remain unselected');
  }
  if (approvalExample.projectId !== 'PROJECT_ID'
      || approvalExample.version !== 'PROJECT_VERSION'
      || approvalExample.licensor !== 'EXACT_LEGAL_LICENSOR_NAME') {
    errors.push('source approval example: identity placeholders must not be replaced in the Hub template');
  }
  if (typeof approvalExample.reviewedSourceRevision !== 'string'
      || typeof approvalExample.contentManifestSha256 !== 'string'
      || !/^0{40}$/.test(approvalExample.reviewedSourceRevision)
      || !/^0{64}$/.test(approvalExample.contentManifestSha256)) {
    errors.push('source approval example: revision and manifest must remain zero placeholders');
  }
}

for (const entry of publicEntries) {
  const { relative } = entry;
  const base = path.basename(relative);
  const lowerBase = base.toLowerCase();
  const extension = path.extname(base).toLowerCase();
  const pathSegments = relative.split('/').map((segment) => segment.toLowerCase());
  if (pathSegments[0] === 'dist' || pathSegments.includes('node_modules')) {
    errors.push(`${relative}: generated dist and dependency directories must not be tracked`);
  }
  if (forbiddenExtensions.has(extension)
      || forbiddenExactNames.has(lowerBase)
      || forbiddenNamePatterns.some((pattern) => pattern.test(lowerBase))
      || lowerBase === '.env'
      || lowerBase === '.envrc'
      || lowerBase.startsWith('.env.')) {
    errors.push(`${relative}: forbidden public artifact type`);
  }
  let data = null;
  if (entry.source === 'index') {
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
      errors.push(`${relative}: Git index mode ${entry.mode} is not a regular publishable file`);
      continue;
    }
    if (entry.flag !== 'H') {
      errors.push(`${relative}: Git index flag ${entry.flag ?? '<missing>'} is unsafe; clear assume-unchanged/skip-worktree state`);
    }
    data = publicDataByPath.get(relative) ?? null;
  } else {
    data = await fs.readFile(path.join(root, relative)).catch(() => null);
  }
  if (!data) continue;
  for (const issue of inspectPublicData(relative, data)) {
    errors.push(`${relative}: ${issue}`);
  }

  const absolute = path.join(root, relative);
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat) {
    errors.push(`${relative}: public file is missing from the worktree`);
    continue;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    errors.push(`${relative}: public worktree entry must be a regular non-symlink file`);
    continue;
  }
  if (entry.source === 'index') {
    const worktreeData = await fs.readFile(absolute);
    if (!worktreeData.equals(data)) {
      errors.push(`${relative}: worktree bytes differ from the staged Git index`);
      for (const issue of inspectPublicData(relative, worktreeData)) {
        errors.push(`${relative} (worktree): ${issue}`);
      }
    }
  }
}

if (canonicalGitIndex) {
  try {
    const gitEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };
    const [{ stdout: finalTreeOutput }, { stdout: finalFlagsOutput }] = await Promise.all([
      execFileAsync('git', ['-C', root, 'write-tree'], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        env: gitEnv,
      }),
      execFileAsync('git', ['-C', root, 'ls-files', '-v', '-z', '--cached'], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        env: gitEnv,
      }),
    ]);
    if (finalTreeOutput.trim() !== capturedIndexTree || finalFlagsOutput !== capturedIndexFlags) {
      errors.push('Git index changed while validation was running; rerun against a stable staged snapshot');
    }
  } catch (error) {
    errors.push(`Git index stability cannot be rechecked (${error.message})`);
  }
}

const disguisedTokenFixture = Buffer.from('github' + '_pat_' + 'A'.repeat(30), 'utf8');
const disguisedTokenIssues = inspectPublicData('fixture.png', disguisedTokenFixture);
if (!disguisedTokenIssues.some((issue) => issue.includes('GitHub fine-grained access token'))
    || !disguisedTokenIssues.some((issue) => issue.includes('binary signature'))) {
  errors.push('validator self-test: token disguised as PNG was not rejected');
}
const unknownBinaryIssues = inspectPublicData('fixture.unknown', Buffer.from([0, 1, 2, 3]));
if (!unknownBinaryIssues.some((issue) => issue.includes('unknown binary content'))) {
  errors.push('validator self-test: unknown binary content was not rejected');
}
const expandedCredentialFixture = Buffer.from([
  '-----BEGIN ' + 'DSA PRIVATE KEY-----',
  '-----BEGIN ' + 'PGP PRIVATE KEY BLOCK-----',
  'ASIA' + 'A'.repeat(16),
  'AWS_' + 'SECRET_ACCESS_KEY=' + 'synthetic-secret-value',
  'AWS_' + 'SESSION_TOKEN=' + 'synthetic-session-value',
].join('\n'), 'utf8');
const expandedCredentialIssues = inspectPublicData('fixture.txt', expandedCredentialFixture);
for (const label of ['private key block', 'AWS access key', 'credential assignment']) {
  if (!expandedCredentialIssues.some((issue) => issue.includes(label))) {
    errors.push(`validator self-test: expanded ${label} fixture was not rejected`);
  }
}

if (errors.length > 0) {
  console.error(`AIUI Sports Agents validation failed with ${errors.length} issue(s):`);
  for (const issue of errors) console.error(`- ${issue}`);
  process.exitCode = 1;
} else {
  console.log(`AIUI Sports Agents validation passed: ${projectCount} projects, ${metricCount} metrics, ${publicEntries.length} public files.`);
}
