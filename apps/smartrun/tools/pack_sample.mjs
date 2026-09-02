// Pack an official Rokid/AIUI reference sample (from rokid-samples/) into an .aix,
// using the SAME plain-zip method as pack_aix.mjs. Purpose: a known-good baseline
// to sideload on the glasses and isolate "our content" vs "our packaging/loading".
//
//   node tools/pack_sample.mjs rokid-samples/meal-card
//   node tools/pack_sample.mjs rokid-samples/bluetooth SAMPLE-bluetooth
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcArg = process.argv[2];
if (!srcArg) {
  console.error('usage: node tools/pack_sample.mjs <sample-dir> [outName]');
  process.exit(1);
}
const SRC = path.resolve(ROOT, srcArg);
if (!fs.existsSync(SRC) || !fs.statSync(SRC).isDirectory()) {
  console.error(`Not a directory: ${SRC}`);
  process.exit(1);
}
const outName = process.argv[3] || `SAMPLE-${path.basename(SRC)}`;
const OUT = path.resolve(ROOT, 'release', `${outName}.aix`);
const TMP = `${OUT}.tmp`;

// Always drop VCS/mac junk; also honor the sample's .aixignore (README.md etc.).
const ignore = ['.DS_Store', '.git', '.aixignore'];
const aixignore = path.join(SRC, '.aixignore');
if (fs.existsSync(aixignore)) {
  for (const line of fs.readFileSync(aixignore, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('#')) ignore.push(t);
  }
}
const excludes = [];
for (const p of ignore) {
  excludes.push('-x', p, '-x', `${p}/*`, '-x', `*/${p}`, '-x', `*/${p}/*`);
}

const zipCheck = spawnSync('zip', ['-v'], { stdio: 'ignore' });
if (zipCheck.error || zipCheck.status !== 0) {
  console.error('Missing zip command (Info-ZIP).');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.rmSync(TMP, { force: true });
const result = spawnSync('zip', ['-q', '-X', '-r', TMP, '.', ...excludes], {
  cwd: SRC,
  stdio: 'inherit',
});
if (result.error) { console.error(result.error.message); process.exit(1); }
if (result.status !== 0) { console.error(`zip failed (${result.status})`); process.exit(1); }
fs.renameSync(TMP, OUT);
fs.chmodSync(OUT, 0o664);
console.log(`Packed ${path.relative(ROOT, OUT)} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
