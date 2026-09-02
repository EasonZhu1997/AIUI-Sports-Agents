import fs from 'node:fs';
import path from 'node:path';

export const AIX_PLATFORM_LIMIT_BYTES = 2_000_000;
export const AIX_PLATFORM_WARNING_BYTES = 1_800_000;
export const AIX_PLATFORM_METADATA_RESERVE_BYTES = 10_000;

function normalizedRelative(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function measureEntry(root, target, excluded) {
  if (excluded.has(normalizedRelative(root, target))) return 0;
  const stat = fs.statSync(target);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  return fs.readdirSync(target).reduce(
    (total, name) => total + measureEntry(root, path.join(target, name), excluded),
    0,
  );
}

export function measureAixContentBytes(root, packageEntries, excludedFiles = []) {
  const excluded = new Set(excludedFiles.map((file) => file.split(path.sep).join('/')));
  return packageEntries.reduce(
    (total, entry) => total + measureEntry(root, path.join(root, entry), excluded),
    0,
  );
}

export function assertAixPlatformFootprint(contentBytes, label = 'AIX package') {
  if (!Number.isInteger(contentBytes) || contentBytes < 0) {
    throw new Error(`${label} has an invalid content size: ${JSON.stringify(contentBytes)}`);
  }
  const estimatedPlatformBytes = contentBytes + AIX_PLATFORM_METADATA_RESERVE_BYTES;
  if (estimatedPlatformBytes >= AIX_PLATFORM_LIMIT_BYTES) {
    throw new Error(
      `${label} estimated Craft package must stay below ${AIX_PLATFORM_LIMIT_BYTES} bytes; `
      + `content ${contentBytes} + reserve ${AIX_PLATFORM_METADATA_RESERVE_BYTES} = `
      + `${estimatedPlatformBytes} bytes`,
    );
  }
  return {
    contentBytes,
    estimatedPlatformBytes,
    headroomBytes: AIX_PLATFORM_LIMIT_BYTES - estimatedPlatformBytes,
    warning: estimatedPlatformBytes >= AIX_PLATFORM_WARNING_BYTES,
  };
}
