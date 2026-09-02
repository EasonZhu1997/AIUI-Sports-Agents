import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'README.md', 'LICENSE', 'COPYRIGHT', 'COMMERCIAL_LICENSE.md', 'TRADEMARKS.md',
  'THIRD_PARTY_NOTICES.md', 'PRIVACY.md', 'SECURITY.md', 'CONTRIBUTING.md',
  'app.js', 'app.json', 'package.json', 'docs/assets/garmin-ble-running-architecture-handdrawn.png',
];
const forbiddenDirectories = new Set([
  '.agents', '.claude', 'evidence', 'diagnostics',
  'release', 'release-archive', 'promo-video', 'rokid-samples',
]);
const ignoredLocalDirectories = new Set([
  '.git', 'node_modules', 'tmp', 'release', '.pages-build',
]);
const forbiddenExtensions = new Set([
  '.aix', '.apk', '.aab', '.pem', '.key', '.jks', '.keystore', '.p12', '.pfx',
  '.db', '.jsonl', '.zip', '.log', '.pdf', '.xlsx',
]);
const secretPatterns = [
  ['private key', /-----BEGIN (?:(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['AWS key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['credential URL', /https?:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ['local path', /(?:\/Users\/|[A-Za-z]:\\Users\\)/],
];
const allowedBinary = new Set(['.gif', '.png', '.wav']);

async function walk(dir, relative = '') {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (ignoredLocalDirectories.has(entry.name)) continue;
      if (forbiddenDirectories.has(entry.name)) throw new Error(`forbidden directory: ${rel}`);
      out.push(...await walk(path.join(dir, entry.name), rel));
    } else if (entry.isSymbolicLink()) {
      throw new Error(`symlink is not allowed: ${rel}`);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

for (const rel of required) {
  const stat = await fs.lstat(path.join(root, rel)).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`missing required regular file: ${rel}`);
}

const files = await walk(root);
for (const rel of files) {
  const ext = path.extname(rel).toLowerCase();
  if (forbiddenExtensions.has(ext)) throw new Error(`forbidden extension: ${rel}`);
  const data = await fs.readFile(path.join(root, rel));
  const latin1 = data.toString('latin1');
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(latin1)) throw new Error(`${rel}: possible ${label}`);
  }
  if (!allowedBinary.has(ext)) {
    if (data.includes(0)) throw new Error(`${rel}: unexpected binary file`);
    new TextDecoder('utf-8', { fatal: true }).decode(data);
  }
}

const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (packageJson.license !== 'PolyForm-Noncommercial-1.0.0') {
  throw new Error('package.json license must be PolyForm-Noncommercial-1.0.0');
}
const license = await fs.readFile(path.join(root, 'LICENSE'));
const normalized = license.toString('utf8').replaceAll('\r\n', '\n').replace(/[ \t]+$/gm, '').trimEnd() + '\n';
const digest = createHash('sha256').update(normalized).digest('hex');
if (digest !== 'c0ea4a896d2c8c394b29f9427589996db826cd501c512279ff0ed3ef48fabbe5') {
  throw new Error('LICENSE must be the unmodified PolyForm Noncommercial 1.0.0 text');
}
console.log(`public-source validation passed: ${files.length} files`);
