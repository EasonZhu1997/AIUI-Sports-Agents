import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const AIX_PROVENANCE_FILE = 'AIX_PROVENANCE.json';
export const AIX_PROVENANCE_SCHEMA_VERSION = 1;
export const AIX_LOCALES = Object.freeze({
  cn: 'zh-CN',
  ja: 'ja-JP',
  en: 'en-US',
});
export const AIX_TRANSFORM_VERSIONS = Object.freeze({
  [AIX_LOCALES.cn]: 'cn-identity-v1',
  [AIX_LOCALES.ja]: 'ja-localization-v1',
  [AIX_LOCALES.en]: 'en-localization-v1',
});
// Backward-compatible aliases for callers that explicitly mean the canonical
// Chinese source package.
export const AIX_LOCALE = AIX_LOCALES.cn;
export const AIX_TRANSFORM_VERSION = AIX_TRANSFORM_VERSIONS[AIX_LOCALE];

export const AIX_RELEASE_SOURCE_ENTRIES = Object.freeze([
  '.aixignore',
  'assets/audio',
  'lib',
  'pages',
  'AGENTS.md',
  'LICENSE',
  'COPYRIGHT',
  'COMMERCIAL_LICENSE.md',
  'TRADEMARKS.md',
  'app.js',
  'app.json',
  'package.json',
  'VERSION',
]);

const SHA256_RE = /^[0-9a-f]{64}$/;
const HASH_EXCLUDED_FILES = new Set(['VERSION', AIX_PROVENANCE_FILE]);

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function normalizeRelativePath(value) {
  const normalized = String(value || '').replaceAll(path.sep, '/');
  if (!normalized
      || normalized.startsWith('/')
      || normalized === '..'
      || normalized.startsWith('../')
      || normalized.includes('/../')
      || normalized.includes('\0')) {
    throw new Error(`Unsafe release-tree path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function normalizeExcludedPaths(excludedPaths = []) {
  return new Set(
    [...HASH_EXCLUDED_FILES, ...excludedPaths].map(normalizeRelativePath),
  );
}

function collectReleaseFiles(root, entries, excludedPaths) {
  const rootAbs = path.resolve(root);
  const files = [];

  function visit(abs, rel) {
    const normalizedRel = normalizeRelativePath(rel);
    if (excludedPaths.has(normalizedRel)) return;
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) {
      throw new Error(`Release tree must not contain symbolic links: ${normalizedRel}`);
    }
    if (stat.isDirectory()) {
      const children = fs.readdirSync(abs, { withFileTypes: true })
        .map((entry) => entry.name)
        .sort(compareUtf8);
      for (const child of children) {
        visit(path.join(abs, child), `${normalizedRel}/${child}`);
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`Release tree contains a non-file entry: ${normalizedRel}`);
    }
    files.push({
      path: normalizedRel,
      bytes: fs.readFileSync(abs),
    });
  }

  for (const entry of entries) {
    const normalizedEntry = normalizeRelativePath(entry);
    if (excludedPaths.has(normalizedEntry)) continue;
    const abs = path.join(rootAbs, normalizedEntry);
    if (!fs.existsSync(abs)) {
      throw new Error(`Missing release source entry: ${normalizedEntry}`);
    }
    visit(abs, normalizedEntry);
  }
  return files;
}

export function computeAixTreeSha256(files, {
  excludedPaths = [],
} = {}) {
  const excluded = normalizeExcludedPaths(excludedPaths);
  const seen = new Set();
  const normalizedFiles = [];
  for (const file of files || []) {
    const rel = normalizeRelativePath(file?.path);
    if (excluded.has(rel) || rel.endsWith('/')) continue;
    if (seen.has(rel)) {
      throw new Error(`Release tree contains a duplicate file entry: ${rel}`);
    }
    seen.add(rel);
    normalizedFiles.push({
      path: rel,
      bytes: Buffer.from(file?.bytes || []),
    });
  }
  normalizedFiles.sort((left, right) => compareUtf8(left.path, right.path));

  const hash = createHash('sha256');
  hash.update('AIBike-AIX-tree-v1\0');
  for (const file of normalizedFiles) {
    const pathBytes = Buffer.from(file.path, 'utf8');
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(file.bytes.length));
    hash.update(String(pathBytes.length));
    hash.update(':');
    hash.update(pathBytes);
    hash.update('\0');
    hash.update(length);
    hash.update(file.bytes);
  }
  return hash.digest('hex');
}

export function computeReleaseSourceTreeSha256(root, {
  entries = AIX_RELEASE_SOURCE_ENTRIES,
  excludedPaths = [],
} = {}) {
  const excluded = normalizeExcludedPaths(excludedPaths);
  return computeAixTreeSha256(
    collectReleaseFiles(root, entries, excluded),
    { excludedPaths },
  );
}

export function createAixProvenance({
  locale = AIX_LOCALE,
  sourceTreeSha256,
  payloadTreeSha256,
}) {
  const normalizedLocale = String(locale || '').trim();
  const transformVersion = AIX_TRANSFORM_VERSIONS[normalizedLocale];
  if (!transformVersion) {
    throw new Error(`Unsupported AIX locale: ${JSON.stringify(locale)}`);
  }
  const sourceHash = String(sourceTreeSha256 || '').trim().toLowerCase();
  const payloadHash = String(payloadTreeSha256 || '').trim().toLowerCase();
  if (!SHA256_RE.test(sourceHash)) {
    throw new Error('Invalid AIX release source-tree SHA-256.');
  }
  if (!SHA256_RE.test(payloadHash)) {
    throw new Error('Invalid AIX payload-tree SHA-256.');
  }
  return {
    schemaVersion: AIX_PROVENANCE_SCHEMA_VERSION,
    locale: normalizedLocale,
    transformVersion,
    sourceTreeSha256: sourceHash,
    payloadTreeSha256: payloadHash,
  };
}

export function parseAndVerifyAixProvenance(raw, {
  expectedLocale = AIX_LOCALE,
  currentSourceTreeSha256,
  packagedPayloadTreeSha256,
} = {}) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    throw new Error(`AIX provenance is invalid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AIX provenance must be a JSON object.');
  }
  if (parsed.schemaVersion !== AIX_PROVENANCE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported AIX provenance schema: ${JSON.stringify(parsed.schemaVersion)}`,
    );
  }
  const locale = String(parsed.locale || '').trim();
  if (!AIX_TRANSFORM_VERSIONS[locale]) {
    throw new Error(`Unsupported AIX provenance locale: ${JSON.stringify(parsed.locale)}`);
  }
  if (expectedLocale && locale !== expectedLocale) {
    throw new Error(
      `AIX locale mismatch: package is ${JSON.stringify(parsed.locale)}, expected ${expectedLocale}`,
    );
  }
  const expectedTransformVersion = AIX_TRANSFORM_VERSIONS[locale];
  if (parsed.transformVersion !== expectedTransformVersion) {
    throw new Error(
      `AIX transform version mismatch: package is `
      + `${JSON.stringify(parsed.transformVersion)}, expected ${expectedTransformVersion}`,
    );
  }
  const sourceHash = String(parsed.sourceTreeSha256 || '').trim().toLowerCase();
  const payloadHash = String(parsed.payloadTreeSha256 || '').trim().toLowerCase();
  if (!SHA256_RE.test(sourceHash) || !SHA256_RE.test(payloadHash)) {
    throw new Error('AIX provenance contains an invalid SHA-256.');
  }
  if (currentSourceTreeSha256
      && sourceHash !== String(currentSourceTreeSha256).trim().toLowerCase()) {
    throw new Error(
      `AIX source is stale: package provenance ${sourceHash} does not match `
      + `current release source ${currentSourceTreeSha256}`,
    );
  }
  if (packagedPayloadTreeSha256
      && payloadHash !== String(packagedPayloadTreeSha256).trim().toLowerCase()) {
    throw new Error(
      `AIX payload integrity mismatch: package provenance ${payloadHash} does not match `
      + `packaged payload ${packagedPayloadTreeSha256}`,
    );
  }
  return createAixProvenance({
    locale,
    sourceTreeSha256: sourceHash,
    payloadTreeSha256: payloadHash,
  });
}

export function writeAixProvenance(root, provenance) {
  const verified = createAixProvenance(provenance);
  fs.writeFileSync(
    path.join(root, AIX_PROVENANCE_FILE),
    `${JSON.stringify(verified, null, 2)}\n`,
    'utf8',
  );
  return verified;
}
