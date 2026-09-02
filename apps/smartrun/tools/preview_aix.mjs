import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const argv = process.argv.slice(2);

let source = false;
let language = 'cn';
let dev = false;
let launch = false;
let htmlOut = '';

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--source') source = true;
  else if (arg === '--dev') dev = true;
  else if (arg === '--launch') launch = true;
  else if (arg === '--lang') language = String(argv[++index] || '');
  else if (arg === '--html-out') htmlOut = String(argv[++index] || '');
  else throw new Error(`Unknown preview option: ${arg}`);
}

if (!['cn', 'en', 'ja'].includes(language)) {
  throw new Error(`Unsupported preview language: ${language}`);
}
if (dev && htmlOut) throw new Error('--dev cannot be combined with --html-out');
if (launch && htmlOut) throw new Error('--launch cannot be combined with --html-out');

const input = source
  ? ROOT
  : path.join(ROOT, 'release', `AISmartRun-AIUI-v${pkg.version}-${language}.aix`);
if (!fs.existsSync(input)) {
  throw new Error(`AIX preview input does not exist: ${input}`);
}

const cli = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'aix.cmd' : 'aix');
const cliRuntime = path.join(ROOT, 'node_modules', '@yodaos-pkg', 'aix-cli', 'dist', 'cli.js');
const cliSource = fs.readFileSync(cliRuntime, 'utf8');
if (!/PREVIEW_WIDTH\s*=\s*480\b/.test(cliSource)
  || !/PREVIEW_HEIGHT\s*=\s*352\b/.test(cliSource)) {
  throw new Error('Official AIX preview viewport must remain 480x352 for AISmartRun');
}
const args = ['preview', input];
if (dev) args.push('--dev');
if (launch) args.push('--launch');
if (htmlOut) {
  const output = path.resolve(ROOT, htmlOut);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  args.push('--html-out', output);
}

console.log(`[AIX Preview] input=${path.relative(ROOT, input) || '.'}`);
console.log(`[AIX Preview] mode=${htmlOut ? 'static-html' : dev ? 'development' : 'package-snapshot'}`);
console.log('[AIX Preview] viewport=480x352');
const result = spawnSync(cli, args, { cwd: ROOT, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
