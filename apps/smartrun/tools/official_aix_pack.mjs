import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants as zlibConstants, deflateRawSync } from 'node:zlib';

import {
  AIX_MANIFEST_FILE,
  AIUI_ENGINE_RANGE,
  AIUI_TARGET_VERSION,
  computeAixTreeSha256,
} from './aix_provenance.mjs';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOLS_DIR, '..');
const require = createRequire(import.meta.url);
const AIX_CLI_PACKAGE = require(path.join(
  ROOT,
  'node_modules/@yodaos-pkg/aix-cli/package.json',
));
const {
  AixReaderWasm,
  pack_aix: packAix,
} = require(path.join(
  ROOT,
  'node_modules/@yodaos-pkg/aix-cli/dist/pkg/aix_web.js',
));

export const OFFICIAL_AIX_CLI_VERSION = '0.8.2';

const GENERATED_FILES = new Set(['VERSION', AIX_MANIFEST_FILE]);
const READABLE_RUNTIME_RE = /\.(?:js|mjs|cjs|ink|wxss)$/i;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = 0x0021; // 1980-01-01, the earliest portable DOS date.

function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function normalizeRelativePath(value) {
  const normalized = String(value || '').split(path.sep).join('/');
  if (!normalized
      || normalized.startsWith('/')
      || normalized === '..'
      || normalized.startsWith('../')
      || normalized.includes('/../')
      || normalized.includes('\\')
      || normalized.includes('\0')) {
    throw new Error(`Unsafe AIX prepared-file path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

export function collectPreparedAixFiles(root, packageEntries) {
  const rootAbs = path.resolve(root);
  const files = [];
  const seen = new Set();

  function visit(abs, rel) {
    const normalizedRel = normalizeRelativePath(rel);
    if (GENERATED_FILES.has(normalizedRel)) return;
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) {
      throw new Error(`AIX prepared tree must not contain symbolic links: ${normalizedRel}`);
    }
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(abs).sort(compareUtf8)) {
        visit(path.join(abs, child), `${normalizedRel}/${child}`);
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`AIX prepared tree contains a non-file entry: ${normalizedRel}`);
    }
    if (seen.has(normalizedRel)) {
      throw new Error(`AIX prepared tree contains a duplicate file: ${normalizedRel}`);
    }
    seen.add(normalizedRel);
    files.push({
      path: normalizedRel,
      data: Buffer.from(fs.readFileSync(abs)),
    });
  }

  for (const entry of packageEntries) {
    const normalizedEntry = normalizeRelativePath(entry);
    if (GENERATED_FILES.has(normalizedEntry)) continue;
    const abs = path.join(rootAbs, normalizedEntry);
    if (!fs.existsSync(abs)) {
      throw new Error(`Missing prepared AIX entry: ${normalizedEntry}`);
    }
    visit(abs, normalizedEntry);
  }
  return files.sort((a, b) => compareUtf8(a.path, b.path));
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function calculateAixPackageId(entries) {
  const hash = createHash('sha256');
  for (const entry of entries) {
    const pathBytes = Buffer.from(String(entry.path), 'utf8');
    const pathLength = Buffer.allocUnsafe(4);
    pathLength.writeUInt32BE(pathBytes.length);
    const size = Buffer.allocUnsafe(8);
    size.writeBigUInt64BE(BigInt(entry.size));
    const digestBytes = Buffer.from(String(entry.sha256), 'utf8');
    const digestLength = Buffer.allocUnsafe(4);
    digestLength.writeUInt32BE(digestBytes.length);
    hash.update(pathLength);
    hash.update(pathBytes);
    hash.update(size);
    hash.update(digestLength);
    hash.update(digestBytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function buildReadableManifest(preparedFiles, buildId, engineRange) {
  const payloadFiles = [
    ...preparedFiles,
    { path: 'VERSION', data: Buffer.from(buildId, 'utf8') },
  ].sort((a, b) => compareUtf8(a.path, b.path));
  const entries = payloadFiles.map((file) => ({
    path: file.path,
    size: file.data.length,
    sha256: sha256Hex(file.data),
  }));
  return {
    payloadFiles,
    manifest: {
      format: 'aix',
      version: buildId,
      engine: engineRange,
      algorithm: 'ed25519',
      digest: 'sha256',
      key_id: '',
      package_id: calculateAixPackageId(entries),
      entries,
    },
  };
}

function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC32_TABLE = createCrc32Table();

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function createReadableZip(files) {
  const sorted = [...files].sort((a, b) => compareUtf8(a.path, b.path));
  if (sorted.length > 0xffff) throw new Error('AIX contains too many ZIP entries.');
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const file of sorted) {
    const name = Buffer.from(normalizeRelativePath(file.path), 'utf8');
    const data = Buffer.from(file.data);
    const compressed = deflateRawSync(data, {
      level: 9,
      strategy: zlibConstants.Z_DEFAULT_STRATEGY,
    });
    if (name.length > 0xffff
        || data.length > 0xffffffff
        || compressed.length > 0xffffffff
        || localOffset > 0xffffffff) {
      throw new Error(`AIX entry exceeds classic ZIP limits: ${file.path}`);
    }
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(ZIP_VERSION, 4);
    localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    localHeader.writeUInt16LE(8, 8); // Deflate only; extracted bytes stay readable and unchanged.
    localHeader.writeUInt16LE(ZIP_DOS_TIME, 10);
    localHeader.writeUInt16LE(ZIP_DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | ZIP_VERSION, 4);
    centralHeader.writeUInt16LE(ZIP_VERSION, 6);
    centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(ZIP_DOS_TIME, 12);
    centralHeader.writeUInt16LE(ZIP_DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function inspectAixZipEntries(archiveBytes) {
  const bytes = Buffer.from(archiveBytes);
  const minimumEndOffset = Math.max(0, bytes.length - 0xffff - 22);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= minimumEndOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error('Readable AIX ZIP is missing its end record.');
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Readable AIX ZIP has an invalid central entry at index ${index}.`);
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const compressionMethod = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Readable AIX ZIP has an invalid local entry: ${name}`);
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localCompressionMethod = bytes.readUInt16LE(localOffset + 8);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localName = bytes
      .subarray(localOffset + 30, localOffset + 30 + localNameLength)
      .toString('utf8');
    if (name !== localName
        || flags !== localFlags
        || compressionMethod !== localCompressionMethod) {
      throw new Error(`Readable AIX ZIP local/central metadata mismatch: ${name}`);
    }
    entries.push({
      path: name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== centralOffset + centralSize || offset !== endOffset) {
    throw new Error('Readable AIX ZIP central-directory bounds are inconsistent.');
  }
  return entries;
}

function runOfficialPack(preparedFiles, normalizedBuildId, engineRange) {
  let packedResult;
  try {
    // This official prepared-file call is the compatibility oracle. aix-cli
    // 0.8.2 cannot disable its standalone JS/TS minifier, so that archive is
    // validated but not shipped; the final archive restores prepared bytes.
    packedResult = packAix(preparedFiles, normalizedBuildId, engineRange, null);
    return {
      bytes: Buffer.from(packedResult.data),
      report: packedResult.report,
    };
  } finally {
    packedResult?.free?.();
  }
}

function validateOfficialOracle(packed, buildId, engineRange) {
  const reader = new AixReaderWasm(Uint8Array.from(packed.bytes));
  try {
    const manifest = JSON.parse(
      new TextDecoder().decode(reader.read_file(AIX_MANIFEST_FILE)),
    );
    if (manifest.format !== 'aix'
        || manifest.version !== buildId
        || manifest.engine !== engineRange
        || manifest.algorithm !== 'ed25519'
        || manifest.digest !== 'sha256'
        || manifest.key_id !== ''
        || !Array.isArray(manifest.entries)
        || calculateAixPackageId(manifest.entries) !== manifest.package_id) {
      throw new Error('Official AIX compatibility oracle returned an unexpected manifest contract.');
    }
    for (const entry of manifest.entries) {
      const bytes = Buffer.from(reader.read_file(entry.path));
      if (entry.size !== bytes.length || entry.sha256 !== sha256Hex(bytes)) {
        throw new Error(`Official AIX compatibility oracle digest mismatch: ${entry.path}`);
      }
    }
    for (const [runtimeVersion, expected] of [
      ['0.14.9', false],
      ['0.15.0', true],
      [AIUI_TARGET_VERSION, true],
      ['0.17.0', false],
    ]) {
      if (reader.supports_engine(runtimeVersion) !== expected) {
        throw new Error(
          `Official AIX engine gate mismatch for AIUI ${runtimeVersion}: expected ${expected}`,
        );
      }
    }
    return {
      manifestKeys: Object.keys(manifest),
      entryKeys: manifest.entries.length ? Object.keys(manifest.entries[0]) : [],
      entryPaths: manifest.entries.map((entry) => entry.path),
    };
  } finally {
    reader.free?.();
  }
}

function verifyReadableArtifact(packedBytes, preparedFiles, manifest, buildId, engineRange) {
  const zipEntries = inspectAixZipEntries(packedBytes);
  const nonDeflated = zipEntries.filter((entry) => entry.compressionMethod !== 8);
  if (nonDeflated.length) {
    throw new Error(
      `Readable AIX must use ZIP Deflate for every entry: `
      + nonDeflated.map((entry) => entry.path).join(', '),
    );
  }
  const reader = new AixReaderWasm(Uint8Array.from(packedBytes));
  try {
    const entries = reader.list();
    const names = entries.map((entry) => String(entry.name || ''));
    const expectedNames = [
      ...preparedFiles.map((file) => file.path),
      'VERSION',
      AIX_MANIFEST_FILE,
    ].sort(compareUtf8);
    if (JSON.stringify([...names].sort(compareUtf8)) !== JSON.stringify(expectedNames)) {
      throw new Error('Readable AIX entry set differs from the official manifest input set.');
    }
    if (reader.get_version() !== buildId) {
      throw new Error('Readable AIX VERSION does not match the requested build ID.');
    }
    const packagedManifest = JSON.parse(
      new TextDecoder().decode(reader.read_file(AIX_MANIFEST_FILE)),
    );
    if (JSON.stringify(packagedManifest) !== JSON.stringify(manifest)
        || packagedManifest.engine !== engineRange) {
      throw new Error('Readable AIX manifest changed while finalizing the archive.');
    }
    for (const file of preparedFiles) {
      const packagedBytes = Buffer.from(reader.read_file(file.path));
      if (!packagedBytes.equals(file.data)) {
        throw new Error(`Readable AIX unexpectedly rewrote prepared file: ${file.path}`);
      }
    }
    const readableRuntimeFiles = preparedFiles.filter((entry) => READABLE_RUNTIME_RE.test(entry.path));
    if (!readableRuntimeFiles.length) {
      throw new Error('Readable AIX contains no runtime JavaScript, Ink, or WXSS files.');
    }
    for (const file of readableRuntimeFiles) {
      if (!Buffer.from(reader.read_file(file.path)).equals(file.data)) {
        throw new Error(`Readable runtime gate failed for ${file.path}`);
      }
    }
    for (const [runtimeVersion, expected] of [
      ['0.14.9', false],
      ['0.15.0', true],
      [AIUI_TARGET_VERSION, true],
      ['0.17.0', false],
    ]) {
      if (reader.supports_engine(runtimeVersion) !== expected) {
        throw new Error(`Readable AIX engine gate mismatch for AIUI ${runtimeVersion}.`);
      }
    }
    return entries;
  } finally {
    reader.free?.();
  }
}

export function packReadableAix({
  root,
  packageEntries,
  outputPath,
  buildId,
  engineRange = AIUI_ENGINE_RANGE,
  expectedPayloadTreeSha256,
}) {
  const normalizedBuildId = String(buildId || '').trim();
  if (!UUID_V4_RE.test(normalizedBuildId)) {
    throw new Error(`Official AIX build ID must be a UUID v4: ${JSON.stringify(buildId)}`);
  }
  if (AIX_CLI_PACKAGE.version !== OFFICIAL_AIX_CLI_VERSION) {
    throw new Error(
      `Official AIX packer version mismatch: expected ${OFFICIAL_AIX_CLI_VERSION}, `
      + `found ${AIX_CLI_PACKAGE.version || 'unknown'}`,
    );
  }
  const preparedFiles = collectPreparedAixFiles(root, packageEntries);
  if (!preparedFiles.length) throw new Error('Official AIX packer received no prepared files.');

  const official = runOfficialPack(preparedFiles, normalizedBuildId, engineRange);
  const officialContract = validateOfficialOracle(
    official,
    normalizedBuildId,
    engineRange,
  );

  const { payloadFiles, manifest } = buildReadableManifest(
    preparedFiles,
    normalizedBuildId,
    engineRange,
  );
  if (JSON.stringify(Object.keys(manifest)) !== JSON.stringify(officialContract.manifestKeys)
      || JSON.stringify(Object.keys(manifest.entries[0] || {}))
        !== JSON.stringify(officialContract.entryKeys)
      || JSON.stringify(manifest.entries.map((entry) => entry.path))
        !== JSON.stringify(officialContract.entryPaths)) {
    throw new Error('Readable AIX manifest structure differs from the official unsigned contract.');
  }
  const finalFiles = [
    ...payloadFiles,
    { path: AIX_MANIFEST_FILE, data: Buffer.from(JSON.stringify(manifest), 'utf8') },
  ];
  const packedBytes = createReadableZip(finalFiles);
  const entries = verifyReadableArtifact(
    packedBytes,
    preparedFiles,
    manifest,
    normalizedBuildId,
    engineRange,
  );
  const payloadTreeSha256 = computeAixTreeSha256(preparedFiles.map((file) => ({
    path: file.path,
    bytes: file.data,
  })));
  if (expectedPayloadTreeSha256
      && payloadTreeSha256 !== String(expectedPayloadTreeSha256).trim().toLowerCase()) {
    throw new Error(
      `Readable AIX payload digest differs from provenance: `
      + `${expectedPayloadTreeSha256} != ${payloadTreeSha256}`,
    );
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, packedBytes);
  const originalSize = preparedFiles.reduce((total, file) => total + file.data.length, 0);
  return {
    uploadBytes: packedBytes.length,
    contentBytes: entries.reduce((total, entry) => total + Number(entry.size || 0), 0),
    entryCount: entries.length,
    manifest,
    payloadTreeSha256,
    report: {
      files: preparedFiles.map((file) => ({
        path: file.path,
        status: 'unchanged',
        original_size: file.data.length,
        output_size: file.data.length,
        saved_bytes: 0,
        converted_to_utf8: false,
      })),
      original_size: originalSize,
      output_size: originalSize,
      saved_bytes: 0,
    },
    officialReport: official.report,
  };
}
