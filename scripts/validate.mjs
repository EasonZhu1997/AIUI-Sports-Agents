import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowedStatuses = new Set(['candidate', 'labs', 'incubating', 'stable']);
const allowedMetricStatuses = new Set(['pass', 'partial', 'blocked', 'not_run']);
const allowedEvidence = new Set(['L1', 'L2', 'L3', 'L4', 'L5']);
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
  'LICENSE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'PRIVACY.md',
  'THIRD_PARTY_NOTICES.md',
  'CODE_OF_CONDUCT.md',
  'GOVERNANCE.md',
  'ROADMAP.md',
  'benchmark/result.schema.json',
  'registry/projects.json',
];
const forbiddenExtensions = new Set([
  '.aix', '.apk', '.aab', '.pem', '.key', '.jks', '.keystore', '.p12', '.db', '.jsonl', '.zip',
]);
const ignoredDirs = new Set(['.git', 'node_modules', 'dist']);
const forbiddenSecretPatterns = [
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['OpenAI-style API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['GitHub access token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/],
];
const errors = [];

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
    return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
  } catch (error) {
    errors.push(`${relativePath}: invalid or unreadable JSON (${error.message})`);
    return null;
  }
}

function checkRelativeFile(value, label) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.split('/').includes('..')) {
    errors.push(`${label}: must be a repository-relative path`);
    return false;
  }
  return true;
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

async function walk(relativeDir = '') {
  const absolute = path.join(root, relativeDir);
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(relativeDir.split(path.sep).join('/'), entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue;
      files.push(...await walk(relative));
      continue;
    }
    if (entry.isSymbolicLink()) {
      errors.push(`${relative}: symbolic links are not allowed in the public hub`);
      continue;
    }
    if (relative === 'registry/local-projects.json') continue;
    files.push(relative);
  }
  return files;
}

for (const relativePath of requiredPublicFiles) {
  if (!await exists(relativePath)) errors.push(`${relativePath}: required public file is missing`);
}

const registry = await readJson('registry/projects.json');
const projectIds = new Set();
let projectCount = 0;
let metricCount = 0;

if (registry) {
  if (registry.schemaVersion !== 1) errors.push('registry/projects.json: schemaVersion must be 1');
  if (!Array.isArray(registry.projects) || registry.projects.length === 0) {
    errors.push('registry/projects.json: projects must be a non-empty array');
  } else {
    projectCount = registry.projects.length;
    for (const project of registry.projects) {
      const prefix = `project:${project.id ?? '<missing>'}`;
      if (!/^[a-z0-9-]+$/.test(project.id ?? '')) errors.push(`${prefix}: invalid id`);
      if (projectIds.has(project.id)) errors.push(`${prefix}: duplicate id`);
      projectIds.add(project.id);
      if (!allowedStatuses.has(project.status)) errors.push(`${prefix}: invalid status`);
      if (!project.version || typeof project.version !== 'string') errors.push(`${prefix}: version is required`);
      if (!Array.isArray(project.protocols) || project.protocols.length === 0) errors.push(`${prefix}: protocols are required`);
      for (const field of ['profile', 'result']) {
        const value = project[field];
        if (checkRelativeFile(value, `${prefix}.${field}`) && !await exists(value)) {
          errors.push(`${prefix}.${field}: referenced file does not exist (${value})`);
        }
      }

      const result = await readJson(project.result);
      if (!result) continue;
      if (result.schemaVersion !== 1) errors.push(`${project.result}: schemaVersion must be 1`);
      if (result.projectId !== project.id) errors.push(`${project.result}: projectId does not match registry`);
      if (result.version !== project.version) errors.push(`${project.result}: version does not match registry`);
      if (!allowedEvidence.has(result.evidenceLevel)) errors.push(`${project.result}: invalid evidenceLevel`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(result.lastUpdated ?? '')) errors.push(`${project.result}: invalid lastUpdated`);
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
          if (checkRelativeFile(evidencePath, `${project.result}:${metric.id}.evidence`) && !await exists(evidencePath)) {
            errors.push(`${project.result}:${metric.id}: missing evidence path ${evidencePath}`);
          }
        }
      }
    }
  }
}

const files = await walk();
const absoluteHomePattern = new RegExp('/' + 'Users' + '/');
const windowsHomePattern = new RegExp('[A-Za-z]:\\\\' + 'Users' + '\\\\');
for (const relative of files) {
  const base = path.basename(relative);
  const extension = path.extname(base).toLowerCase();
  if (forbiddenExtensions.has(extension) || base === '.env' || base.startsWith('.env.')) {
    errors.push(`${relative}: forbidden public artifact type`);
  }
  if (!['.md', '.json', '.mjs', '.yml', '.yaml', '.txt', ''].includes(extension)) continue;
  const text = await fs.readFile(path.join(root, relative), 'utf8');
  if (absoluteHomePattern.test(text) || windowsHomePattern.test(text) || text.includes('file:' + '//')) {
    errors.push(`${relative}: contains a local absolute path`);
  }
  for (const [label, pattern] of forbiddenSecretPatterns) {
    if (pattern.test(text)) errors.push(`${relative}: contains a possible ${label}`);
  }
}

if (errors.length > 0) {
  console.error(`AIUI Sports Agents validation failed with ${errors.length} issue(s):`);
  for (const issue of errors) console.error(`- ${issue}`);
  process.exitCode = 1;
} else {
  console.log(`AIUI Sports Agents validation passed: ${projectCount} projects, ${metricCount} metrics, ${files.length} public files.`);
}
