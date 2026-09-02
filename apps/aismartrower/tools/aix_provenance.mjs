import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const AIX_PROVENANCE_FILE = 'AIX_PROVENANCE.json';
export const AIX_PROVENANCE_SCHEMA_VERSION = 1;
export const AIX_LOCALE = 'zh-CN';
export const AIX_TRANSFORM_VERSION = 'cn-identity-v1';
export const AIX_UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PRODUCT_VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const HASH_EXCLUDED_FILES = new Set(['VERSION', AIX_PROVENANCE_FILE]);
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_MIN_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function normalizeRelativePath(value) {
  const raw = String(value || '');
  if (!raw
      || raw.includes('\\')
      || raw.includes('\0')
      || raw.startsWith('/')
      || raw.endsWith('/')
      || raw === '.'
      || raw === '..'
      || raw.startsWith('./')
      || raw.startsWith('../')
      || raw.includes('//')
      || raw.includes('/./')
      || raw.includes('/../')) {
    throw new Error(`Unsafe AIX file path: ${JSON.stringify(value)}`);
  }
  return raw;
}

function normalizedExclusions(excludedPaths = []) {
  return new Set(
    [...HASH_EXCLUDED_FILES, ...excludedPaths].map(normalizeRelativePath),
  );
}

export function computeAixTreeSha256(files, { excludedPaths = [] } = {}) {
  const excluded = normalizedExclusions(excludedPaths);
  const seen = new Set();
  const normalized = [];
  for (const file of files || []) {
    const relative = normalizeRelativePath(file?.path);
    if (excluded.has(relative)) continue;
    if (seen.has(relative)) {
      throw new Error(`AIX tree contains a duplicate file entry: ${relative}`);
    }
    seen.add(relative);
    normalized.push({
      path: relative,
      bytes: Buffer.from(file?.bytes || []),
    });
  }
  normalized.sort((left, right) => compareUtf8(left.path, right.path));

  const hash = createHash('sha256');
  hash.update('AISmartRower-AIX-tree-v1\0');
  for (const file of normalized) {
    const pathBytes = Buffer.from(file.path, 'utf8');
    const byteLength = Buffer.allocUnsafe(8);
    byteLength.writeBigUInt64BE(BigInt(file.bytes.length));
    hash.update(String(pathBytes.length));
    hash.update(':');
    hash.update(pathBytes);
    hash.update('\0');
    hash.update(byteLength);
    hash.update(file.bytes);
  }
  return hash.digest('hex');
}

export function computeReleaseSourceTreeSha256(rootDir, { entries } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('AIX source-tree hashing requires an explicit runtime file closure');
  }
  const root = path.resolve(rootDir);
  const files = entries.map((entry) => {
    const relative = normalizeRelativePath(entry);
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) {
      throw new Error(`Missing AIX release source file: ${relative}`);
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`AIX release source must not contain symbolic links: ${relative}`);
    }
    if (!stat.isFile()) {
      throw new Error(`AIX release source contains a non-file entry: ${relative}`);
    }
    return { path: relative, bytes: fs.readFileSync(absolute) };
  });
  return computeAixTreeSha256(files);
}

export function createAixProvenance({
  productVersion,
  aixUuid,
  sourceTreeSha256,
  payloadTreeSha256,
}) {
  const normalizedProductVersion = String(productVersion || '').trim();
  const normalizedUuid = String(aixUuid || '').trim().toLowerCase();
  const sourceHash = String(sourceTreeSha256 || '').trim().toLowerCase();
  const payloadHash = String(payloadTreeSha256 || '').trim().toLowerCase();
  if (!PRODUCT_VERSION_RE.test(normalizedProductVersion)) {
    throw new Error(`Invalid AISmartRower product version: ${JSON.stringify(productVersion)}`);
  }
  if (!AIX_UUID_V4_RE.test(normalizedUuid)) {
    throw new Error(`Invalid AISmartRower AIX UUID v4: ${JSON.stringify(aixUuid)}`);
  }
  if (!SHA256_RE.test(sourceHash)) {
    throw new Error('Invalid AISmartRower release source-tree SHA-256');
  }
  if (!SHA256_RE.test(payloadHash)) {
    throw new Error('Invalid AISmartRower payload-tree SHA-256');
  }
  return {
    schemaVersion: AIX_PROVENANCE_SCHEMA_VERSION,
    product: 'AISmartRower',
    productVersion: normalizedProductVersion,
    locale: AIX_LOCALE,
    transformVersion: AIX_TRANSFORM_VERSION,
    aixUuid: normalizedUuid,
    sourceTreeSha256: sourceHash,
    payloadTreeSha256: payloadHash,
  };
}

export function parseAndVerifyAixProvenance(raw, {
  expectedProductVersion,
  expectedAixUuid,
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
    throw new Error('AIX provenance must be a JSON object');
  }
  if (parsed.schemaVersion !== AIX_PROVENANCE_SCHEMA_VERSION) {
    throw new Error(`Unsupported AIX provenance schema: ${JSON.stringify(parsed.schemaVersion)}`);
  }
  if (parsed.product !== 'AISmartRower') {
    throw new Error(`AIX provenance product mismatch: ${JSON.stringify(parsed.product)}`);
  }
  if (parsed.locale !== AIX_LOCALE) {
    throw new Error(`AIX provenance locale mismatch: ${JSON.stringify(parsed.locale)}`);
  }
  if (parsed.transformVersion !== AIX_TRANSFORM_VERSION) {
    throw new Error(
      `AIX provenance transform mismatch: ${JSON.stringify(parsed.transformVersion)}`,
    );
  }
  const verified = createAixProvenance({
    productVersion: parsed.productVersion,
    aixUuid: parsed.aixUuid,
    sourceTreeSha256: parsed.sourceTreeSha256,
    payloadTreeSha256: parsed.payloadTreeSha256,
  });
  if (expectedProductVersion
      && verified.productVersion !== String(expectedProductVersion).trim()) {
    throw new Error(
      `AIX provenance product version mismatch: ${verified.productVersion} != ${expectedProductVersion}`,
    );
  }
  if (expectedAixUuid
      && verified.aixUuid !== String(expectedAixUuid).trim().toLowerCase()) {
    throw new Error(
      `AIX provenance UUID mismatch: ${verified.aixUuid} != ${expectedAixUuid}`,
    );
  }
  if (currentSourceTreeSha256
      && verified.sourceTreeSha256 !== String(currentSourceTreeSha256).trim().toLowerCase()) {
    throw new Error(
      `AIX source is stale: ${verified.sourceTreeSha256} != ${currentSourceTreeSha256}`,
    );
  }
  if (packagedPayloadTreeSha256
      && verified.payloadTreeSha256
        !== String(packagedPayloadTreeSha256).trim().toLowerCase()) {
    throw new Error(
      `AIX payload integrity mismatch: ${verified.payloadTreeSha256} != ${packagedPayloadTreeSha256}`,
    );
  }
  return verified;
}

export function writeAixProvenance(rootDir, provenance) {
  const verified = createAixProvenance(provenance);
  fs.writeFileSync(
    path.join(rootDir, AIX_PROVENANCE_FILE),
    `${JSON.stringify(verified, null, 2)}\n`,
    'utf8',
  );
  return verified;
}

export function listZipCentralDirectoryEntries(packageBytes) {
  const bytes = Buffer.from(packageBytes || []);
  if (bytes.length < ZIP_EOCD_MIN_BYTES) throw new Error('AIX ZIP is truncated');
  const searchStart = Math.max(
    0,
    bytes.length - ZIP_EOCD_MIN_BYTES - ZIP_MAX_COMMENT_BYTES,
  );
  let eocd = -1;
  for (let offset = bytes.length - ZIP_EOCD_MIN_BYTES; offset >= searchStart; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + ZIP_EOCD_MIN_BYTES + commentLength === bytes.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('AIX ZIP end-of-central-directory record is missing');

  const diskNumber = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const totalEntries = bytes.readUInt16LE(eocd + 10);
  const centralBytes = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new Error('Multi-disk AIX ZIP archives are not supported');
  }
  if (totalEntries === 0xffff
      || centralBytes === 0xffffffff
      || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 AIX archives are outside the local package contract');
  }
  if (centralOffset + centralBytes !== eocd) {
    throw new Error('AIX ZIP central-directory bounds are inconsistent');
  }

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error(`AIX ZIP central-directory entry ${index} is invalid`);
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > eocd) {
      throw new Error(`AIX ZIP central-directory entry ${index} is truncated`);
    }
    if ((flags & 0x1) !== 0) {
      throw new Error('Encrypted AIX ZIP entries are not allowed');
    }
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(nameBytes)) {
      throw new Error(`AIX ZIP entry ${index} has an invalid UTF-8 path`);
    }
    entries.push({ name, flags });
    cursor = recordEnd;
  }
  if (cursor !== eocd) {
    throw new Error('AIX ZIP central-directory contains unparsed trailing records');
  }
  return entries;
}

export function assertExactAixArchiveClosure(entries, expectedFiles) {
  const names = (entries || []).map((entry) => normalizeRelativePath(
    typeof entry === 'string' ? entry : entry?.name,
  ));
  const expected = (expectedFiles || []).map(normalizeRelativePath);
  if (new Set(names).size !== names.length) {
    throw new Error('AIX package contains duplicate ZIP paths');
  }
  if (new Set(expected).size !== expected.length) {
    throw new Error('Expected AIX runtime closure contains duplicate paths');
  }
  const actualSorted = [...names].sort(compareUtf8);
  const expectedSorted = [...expected].sort(compareUtf8);
  const actualSet = new Set(actualSorted);
  const expectedSet = new Set(expectedSorted);
  const missing = expectedSorted.filter((name) => !actualSet.has(name));
  const extra = actualSorted.filter((name) => !expectedSet.has(name));
  if (missing.length || extra.length) {
    const details = [];
    if (missing.length) details.push(`missing: ${missing.join(', ')}`);
    if (extra.length) details.push(`unexpected/unreachable: ${extra.join(', ')}`);
    throw new Error(`AIX package is not the exact runtime closure (${details.join('; ')})`);
  }
  return actualSorted;
}
