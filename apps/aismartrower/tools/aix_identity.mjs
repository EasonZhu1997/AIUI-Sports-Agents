import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AIX_UUID_V4_RE } from './aix_provenance.mjs';

export function assertAixVersion(value, label = 'AIX VERSION') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!AIX_UUID_V4_RE.test(normalized)) {
    throw new Error(`${label} must be a UUID v4: ${JSON.stringify(value)}`);
  }
  return normalized;
}

export function createAixVersion(createUuid = randomUUID) {
  return assertAixVersion(createUuid(), 'Generated AIX VERSION');
}

export function writeFileAtomic(target, bytes) {
  const absolute = path.resolve(target);
  const temp = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temp, bytes);
    fs.renameSync(temp, absolute);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function writeAixVersionAtomic(rootDir, aixUuid) {
  const normalized = assertAixVersion(aixUuid);
  writeFileAtomic(path.join(rootDir, 'VERSION'), `${normalized}\n`);
  return normalized;
}
