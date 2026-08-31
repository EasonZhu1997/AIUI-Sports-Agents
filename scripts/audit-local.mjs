import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const mappingPath = path.join(root, 'registry/local-projects.json');
const registryPath = path.join(root, 'registry/projects.json');
const requiredFiles = [
  'LICENSE',
  'README.md',
  'PRIVACY.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'THIRD_PARTY_NOTICES.md',
  'OPEN_SOURCE_READINESS.md',
  '.gitignore',
];
const riskyEntries = [
  '.git',
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
const riskyExtensions = new Set(['.aix', '.apk', '.aab', '.pem', '.key', '.jks', '.keystore', '.p12', '.zip', '.jsonl', '.db']);

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

if (!await exists(mappingPath)) {
  console.error('registry/local-projects.json is missing. Copy local-projects.example.json first.');
  process.exit(1);
}

const mappings = await readJson(mappingPath);
const registry = await readJson(registryPath);
const findings = [];

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
  try {
    packageJson = await readJson(path.join(sourceRoot, 'package.json'));
  } catch {
    findings.push({ severity: 'blocker', project: project.id, message: 'package.json is missing or invalid' });
  }
  if (packageJson && packageJson.version !== project.version) {
    findings.push({ severity: 'blocker', project: project.id, message: `registry version ${project.version} differs from package version` });
  }
  if (packageJson && !packageJson.scripts?.test) {
    findings.push({ severity: 'blocker', project: project.id, message: 'no test script' });
  }
  if (packageJson && !packageJson.scripts?.build && !packageJson.scripts?.['build:local']) {
    findings.push({ severity: 'warning', project: project.id, message: 'no local build script' });
  }

  for (const relative of requiredFiles) {
    if (!await exists(path.join(sourceRoot, relative))) {
      findings.push({ severity: 'blocker', project: project.id, message: `missing ${relative}` });
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
    const extension = path.extname(entry.name).toLowerCase();
    if (riskyExtensions.has(extension) || entry.name === '.env' || entry.name.startsWith('.env.')) {
      findings.push({ severity: 'blocker', project: project.id, message: `${entry.name} must not enter the public export` });
    }
  }

  if (!await exists(path.join(sourceRoot, '.git'))) {
    findings.push({ severity: 'warning', project: project.id, message: 'no canonical Git history yet' });
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
console.log(`\n${findings.length} finding(s), including ${blockers} blocker(s). No file contents or secret values were read.`);
if (strict && findings.length > 0) process.exitCode = 1;
