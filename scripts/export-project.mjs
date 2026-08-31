import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');
const projectFlag = process.argv.indexOf('--project');
const projectId = projectFlag >= 0 ? process.argv[projectFlag + 1] : '';
const mappingPath = path.join(root, 'registry/local-projects.json');
const registryPath = path.join(root, 'registry/projects.json');
const allowedRootFiles = new Set([
  '.aixignore',
  '.gitignore',
  '.npmignore',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'OPEN_SOURCE_READINESS.md',
  'PRIVACY.md',
  'README.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
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
  '.aix', '.apk', '.aab', '.pem', '.key', '.jks', '.keystore', '.p12', '.db', '.jsonl', '.zip', '.log',
]);
const excludedRelativePaths = new Set([
  'tools/ftms_control_handshake_probe_macos.swift',
  'tools/ftms_resistance_control_test_macos.swift',
]);
const maxFileBytes = 2_000_000;

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

if (!projectId) {
  console.error('Usage: npm run export:dry -- --project <project-id>');
  process.exit(2);
}
if (!await exists(mappingPath)) {
  console.error('registry/local-projects.json is missing. Copy the example first.');
  process.exit(2);
}

const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
const project = registry.projects.find((candidate) => candidate.id === projectId);
if (!project) {
  console.error(`Unknown project id: ${projectId}`);
  process.exit(2);
}
const mappings = JSON.parse(await fs.readFile(mappingPath, 'utf8'));
const sourceRoot = path.resolve(path.dirname(mappingPath), mappings[projectId] ?? '');
if (!mappings[projectId] || !await exists(sourceRoot)) {
  console.error(`Local source is not configured for ${projectId}.`);
  process.exit(2);
}

const readinessPath = path.join(sourceRoot, 'OPEN_SOURCE_READINESS.md');
let readiness = '';
if (await exists(readinessPath)) readiness = await fs.readFile(readinessPath, 'utf8');
const ready = /^PUBLIC_EXPORT_STATUS:\s*READY\s*$/m.test(readiness);
const planned = [];
const blockers = [];

async function collect(absoluteDir, relativeDir) {
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const relative = path.posix.join(relativeDir.split(path.sep).join('/'), entry.name);
    if (excludedRelativePaths.has(relative)) continue;
    if (excludedNames.has(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      blockers.push(`${relative}: symbolic link requires manual review`);
      continue;
    }
    if (entry.isDirectory()) {
      await collect(path.join(absoluteDir, entry.name), relative);
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (excludedExtensions.has(extension) || entry.name === '.env' || entry.name.startsWith('.env.')) {
      blockers.push(`${relative}: forbidden artifact type`);
      continue;
    }
    const stat = await fs.stat(path.join(absoluteDir, entry.name));
    if (stat.size > maxFileBytes) {
      blockers.push(`${relative}: exceeds ${maxFileBytes} bytes and requires manual review`);
      continue;
    }
    planned.push({ source: path.join(absoluteDir, entry.name), relative, size: stat.size });
  }
}

for (const entry of await fs.readdir(sourceRoot, { withFileTypes: true })) {
  if (entry.isFile() && allowedRootFiles.has(entry.name)) {
    const stat = await fs.stat(path.join(sourceRoot, entry.name));
    if (stat.size <= maxFileBytes) planned.push({ source: path.join(sourceRoot, entry.name), relative: entry.name, size: stat.size });
    else blockers.push(`${entry.name}: exceeds ${maxFileBytes} bytes`);
  }
  if (entry.isDirectory() && allowedRootDirs.has(entry.name)) {
    await collect(path.join(sourceRoot, entry.name), entry.name);
  }
}

planned.sort((a, b) => a.relative.localeCompare(b.relative));
console.log(`${write ? 'Write' : 'Dry-run'} export for ${project.name} ${project.version}`);
console.log(`- planned files: ${planned.length}`);
console.log(`- planned bytes: ${planned.reduce((sum, item) => sum + item.size, 0)}`);
console.log(`- review blockers: ${blockers.length}`);
for (const blocker of blockers) console.log(`  - ${blocker}`);

if (!ready) {
  console.error('- PUBLIC_EXPORT_STATUS is not READY; write export is blocked.');
  if (write) process.exit(1);
}
if (!write) process.exit(0);
if (blockers.length > 0) {
  console.error('Write export is blocked until every listed file is reviewed or excluded.');
  process.exit(1);
}

const outputRoot = path.join(root, 'dist', projectId);
if (await exists(outputRoot)) {
  console.error(`Refusing to overwrite existing output: ${path.relative(root, outputRoot)}`);
  process.exit(1);
}
for (const item of planned) {
  const destination = path.join(outputRoot, item.relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(item.source, destination);
}
console.log(`Local export created at ${path.relative(root, outputRoot)}. No remote action was performed.`);
