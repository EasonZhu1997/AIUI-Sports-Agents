// Legacy filename kept for existing release tooling. AIX VERSION is a package
// identity, not the product semver: generate a fresh UUID v4 for every package
// and leave package.json / AGENTS.md / the Chinese PRD unchanged.
//   node tools/bump_version.mjs        # refresh the source AIX package identity
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const AIX_UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function writeAixVersion(root = ROOT, createUuid = randomUUID) {
  const next = String(createUuid()).trim();
  if (!AIX_UUID_V4_RE.test(next)) {
    throw new Error(`AIX VERSION generator did not return a UUID v4: ${JSON.stringify(next)}`);
  }

  fs.writeFileSync(path.join(root, 'VERSION'), `${next}\n`);
  console.log(`AIX VERSION generated: ${next}`);
  return next;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeAixVersion();
}
