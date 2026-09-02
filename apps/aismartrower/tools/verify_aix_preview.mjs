import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertRequiredRowerRuntime,
  discoverAixRuntimeFiles,
} from './aix_runtime_files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_PRODUCT_VERSION = '0.0.1';
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SOURCE_NAME = `AISmartRower-AIUI-v${pkg.version}-cn.aix`;
const ARTIFACT = path.join(ROOT, 'release', SOURCE_NAME);
const CLI_PACKAGE = '@yodaos-pkg/aix-cli';
const CLI_VERSION = '0.8.2';
const INK_SDK_URL = 'https://esm.sh/@yodaos-pkg/ink';
const CLI_ENTRY = path.join(ROOT, 'node_modules', '@yodaos-pkg', 'aix-cli', 'dist', 'cli.js');
const runtime = discoverAixRuntimeFiles(ROOT);
assertRequiredRowerRuntime(runtime);
const EXPECTED_BUNDLE_FILES = new Set([...runtime.files, 'AIX_PROVENANCE.json']);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function previewConfig(html) {
  const match = String(html || '').match(
    /<script id=["']aix-preview-config["'] type=["']application\/json["']>([\s\S]*?)<\/script>/,
  );
  requireCondition(match, 'Official preview is missing aix-preview-config');
  return JSON.parse(match[1]);
}

function inspectHtml(html) {
  const source = String(html || '');
  const config = previewConfig(source);
  const state = config.initialState;
  requireCondition(config.mode === 'static', 'Official preview must use static mode');
  requireCondition(config.inkSdkUrl === INK_SDK_URL, 'Official Ink SDK URL mismatch');
  requireCondition(state?.sourceKind === 'aix-file', 'Preview must read the packaged AIX');
  requireCondition(state?.sourceName === SOURCE_NAME, 'Preview source filename mismatch');
  requireCondition(state?.title === '划船机教练', 'Preview Chinese product title mismatch');
  requireCondition(Array.isArray(state?.files), 'Preview bundle files are missing');
  const files = new Set(state.files.map((entry) => entry.path));
  for (const relative of EXPECTED_BUNDLE_FILES) {
    requireCondition(files.has(relative), `Preview is missing ${relative}`);
  }
  requireCondition(
    files.size === EXPECTED_BUNDLE_FILES.size
      && state.files.length === EXPECTED_BUNDLE_FILES.size,
    'Official preview bundle is not the exact v0.0.1 runtime closure',
  );
  requireCondition(/width:\s*480,/.test(source) && /height:\s*352,/.test(source),
    'Official preview host must be 480x352');
  requireCondition(/view\.openBundle\(\{/.test(source), 'Official preview does not open Ink bundle');
  return state.files.length;
}

function waitForUrl(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => finish(
      reject,
      new Error(`Official preview server timed out: ${stdout} ${stderr}`),
    ), timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/Preview server running at (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) finish(resolve, match[1]);
    });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => finish(reject, error));
    child.once('exit', (code) => finish(
      reject,
      new Error(`Official preview exited before ready: ${code} ${stderr}`),
    ));
  });
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Official preview did not stop')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  requireCondition(
    pkg.name === 'AISmartRower' && pkg.version === EXPECTED_PRODUCT_VERSION,
    `Source package must identify AISmartRower v${EXPECTED_PRODUCT_VERSION}`,
  );
  requireCondition(fs.existsSync(CLI_ENTRY), `Missing ${CLI_PACKAGE}; run npm install`);
  requireCondition(fs.existsSync(ARTIFACT), `Missing ${SOURCE_NAME}; build the AIX first`);
  const cliPkg = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'node_modules', '@yodaos-pkg', 'aix-cli', 'package.json'),
    'utf8',
  ));
  requireCondition(cliPkg.version === CLI_VERSION, `Official AIX CLI must be ${CLI_VERSION}`);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rower-aix-preview-'));
  const output = path.join(temp, 'preview.html');
  let fileCount = 0;
  try {
    const staticResult = spawnSync(
      process.execPath,
      [CLI_ENTRY, 'preview', ARTIFACT, '--html-out', output],
      { cwd: ROOT, encoding: 'utf8' },
    );
    requireCondition(!staticResult.error && staticResult.status === 0,
      `Official static preview failed: ${staticResult.error?.message || staticResult.stderr}`);
    fileCount = inspectHtml(fs.readFileSync(output, 'utf8'));

    const child = spawn(process.execPath, [CLI_ENTRY, 'preview', ARTIFACT], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let url;
    try {
      url = await waitForUrl(child);
      const health = await fetch(new URL('/health', url));
      requireCondition(health.ok && await health.text() === 'ok', 'Preview health check failed');
      const page = await fetch(url);
      requireCondition(page.ok, 'Preview browser page failed to load');
      inspectHtml(await page.text());
    } finally {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
      await waitForExit(child);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(
    `OK official AIX preview - v${EXPECTED_PRODUCT_VERSION}; ${CLI_PACKAGE}@${CLI_VERSION}; `
    + `${fileCount} exact-closure files; 480x352; dual-peripheral host gate remains open.`,
  );
}

main().catch((error) => {
  console.error(`Official AIX preview failed: ${error.message}`);
  process.exit(1);
});
