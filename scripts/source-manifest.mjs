import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectId = process.argv[2];

if (!/^[a-z0-9-]+$/.test(projectId ?? '')) {
  console.error('Usage: npm run source:manifest -- <project-id>');
  process.exit(2);
}

const sourcePath = `apps/${projectId}`;
const approvalPath = `${sourcePath}/SOURCE_DISTRIBUTION_APPROVAL.json`;
const gitEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };

const indexOutput = execFileSync(
  'git',
  ['-C', root, 'ls-files', '-s', '-z', '--', sourcePath],
  { encoding: 'utf8', env: gitEnv, maxBuffer: 20 * 1024 * 1024 },
);

const entries = indexOutput.split('\0').filter(Boolean).map((record) => {
  const tab = record.indexOf('\t');
  const [mode, oid, stage] = record.slice(0, tab).split(' ');
  return { mode, oid, stage, relative: record.slice(tab + 1) };
}).filter((entry) => entry.relative !== approvalPath).sort((left, right) => {
  if (left.relative < right.relative) return -1;
  if (left.relative > right.relative) return 1;
  return 0;
});

if (entries.length === 0) {
  console.error(`${sourcePath}: no tracked source files found in the Git index`);
  process.exit(1);
}

const lines = [];
for (const entry of entries) {
  if (!['100644', '100755'].includes(entry.mode) || entry.stage !== '0') {
    console.error(`${entry.relative}: expected a stage-0 regular file, found mode=${entry.mode} stage=${entry.stage}`);
    process.exit(1);
  }
  const data = execFileSync('git', ['-C', root, 'cat-file', 'blob', entry.oid], {
    encoding: null,
    env: gitEnv,
    maxBuffer: 100 * 1024 * 1024,
  });
  const fileSha256 = createHash('sha256').update(data).digest('hex');
  const appRelative = entry.relative.slice(sourcePath.length + 1);
  lines.push(`${appRelative}\0${data.length}\0${fileSha256}\n`);
}

const manifestSha256 = createHash('sha256').update(lines.join('')).digest('hex');
console.log(JSON.stringify({
  projectId,
  sourcePath,
  fileCount: entries.length,
  contentManifestSha256: manifestSha256,
}, null, 2));
