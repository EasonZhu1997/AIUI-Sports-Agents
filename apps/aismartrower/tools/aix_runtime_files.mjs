import fs from 'node:fs';
import path from 'node:path';

export const AIX_RUNTIME_METADATA_FILES = Object.freeze([
  '.aixignore',
  'AGENTS.md',
  'COPYRIGHT',
  'LICENSE',
  'VERSION',
  'app.js',
  'app.json',
  'package.json',
]);

export const AIX_REQUIRED_BLE_MODULE_FILES = Object.freeze([
  'lib/ftms_rower.js',
  'lib/ftms_session.js',
  'lib/hr.js',
  'lib/heart_rate_session.js',
  'lib/heart_rate_source.js',
]);

const IMPORT_RE = /\b(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/g;
const TEMPLATE_ASSET_RE = /\b(?:src|poster)\s*=\s*["']([^"'{}]+)["']/g;
const CSS_ASSET_RE = /\burl\(\s*["']?([^"')]+)["']?\s*\)/g;
const MODULE_ASSET_RE = /\b(?:assetPath|audioPath|fontPath|imagePath|poster|src)\s*:\s*["']([^"']+)["']/g;

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function toRelative(root, absolute) {
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (!relative
      || relative === '..'
      || relative.startsWith('../')
      || path.isAbsolute(relative)
      || relative.includes('\0')) {
    throw new Error(`Runtime dependency escapes the project root: ${absolute}`);
  }
  return relative;
}

function assertRegularFile(root, relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Missing AIX runtime file: ${relative}`);
  }
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    throw new Error(`AIX runtime closure must not contain symbolic links: ${relative}`);
  }
  if (!stat.isFile()) {
    throw new Error(`AIX runtime closure contains a non-file entry: ${relative}`);
  }
  return absolute;
}

function resolveLocalFile(root, ownerFile, specifier, kind) {
  const raw = String(specifier || '').trim();
  if (!raw.startsWith('.')) return null;
  const base = path.resolve(path.dirname(ownerFile), raw);
  const candidates = kind === 'module' ? [base, `${base}.js`] : [base];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) {
    throw new Error(
      `Unresolved local ${kind} in ${toRelative(root, ownerFile)}: ${raw}`,
    );
  }
  const relative = toRelative(root, resolved);
  assertRegularFile(root, relative);
  if (kind === 'module' && !relative.startsWith('lib/')) {
    throw new Error(
      `Local runtime modules must live under lib/: ${toRelative(root, ownerFile)} -> ${relative}`,
    );
  }
  if (kind === 'asset' && !relative.startsWith('assets/')) {
    throw new Error(
      `Local page assets must live under assets/: ${toRelative(root, ownerFile)} -> ${relative}`,
    );
  }
  return { absolute: resolved, relative };
}

function literalAssetSpecifiers(text) {
  const values = [];
  for (const pattern of [TEMPLATE_ASSET_RE, CSS_ASSET_RE]) {
    for (const match of text.matchAll(pattern)) values.push(match[1]);
  }
  return values;
}

function moduleAssetSpecifiers(text) {
  return [...text.matchAll(MODULE_ASSET_RE)].map((match) => match[1]);
}

function resolveProjectAssetLiteral(root, specifier) {
  const raw = String(specifier || '').trim().replaceAll('\\', '/');
  const marker = raw.match(/(?:^|\/)(assets\/.*)$/);
  if (!marker) return null;
  const relative = marker[1];
  if (!/^assets\/[a-z0-9_./-]+$/i.test(relative)
      || relative.includes('//')
      || relative.includes('/../')
      || relative.includes('/./')
      || relative.endsWith('/..')
      || relative.endsWith('/.')) {
    throw new Error(`Unsafe dynamic AIX asset path: ${JSON.stringify(specifier)}`);
  }
  assertRegularFile(root, relative);
  return relative;
}

export function assertRequiredRowerRuntime(runtime) {
  const moduleFiles = new Set(runtime?.moduleFiles || []);
  const missingModules = AIX_REQUIRED_BLE_MODULE_FILES.filter(
    (relative) => !moduleFiles.has(relative),
  );
  if (missingModules.length) {
    throw new Error(`missing required BLE modules: ${missingModules.join(', ')}`);
  }
  return true;
}

export function discoverAixRuntimeFiles(rootDir) {
  const root = path.resolve(rootDir);
  const appJsonPath = assertRegularFile(root, 'app.json');
  let app;
  try {
    app = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid app.json while discovering the AIX runtime closure: ${error.message}`);
  }
  if (!Array.isArray(app.pages) || app.pages.length === 0) {
    throw new Error('app.json must declare at least one AIX page route');
  }

  const pageFiles = app.pages.map((route) => {
    const normalized = String(route || '').trim().replaceAll('\\', '/');
    if (!/^pages\/[a-z0-9_/-]+$/i.test(normalized)
        || normalized.includes('//')
        || normalized.includes('/../')) {
      throw new Error(`Unsafe AIX page route: ${JSON.stringify(route)}`);
    }
    const relative = `${normalized}.ink`;
    assertRegularFile(root, relative);
    return relative;
  });
  if (new Set(pageFiles).size !== pageFiles.length) {
    throw new Error('app.json contains duplicate AIX page routes');
  }

  const files = new Set(AIX_RUNTIME_METADATA_FILES);
  const moduleFiles = new Set();
  const assetFiles = new Set();
  const queue = [
    assertRegularFile(root, 'app.js'),
    ...pageFiles.map((relative) => assertRegularFile(root, relative)),
  ];
  const visited = new Set();

  for (const relative of pageFiles) files.add(relative);

  while (queue.length) {
    const owner = queue.shift();
    if (visited.has(owner)) continue;
    visited.add(owner);
    const text = fs.readFileSync(owner, 'utf8');
    for (const match of text.matchAll(IMPORT_RE)) {
      const resolved = resolveLocalFile(root, owner, match[1], 'module');
      if (!resolved) continue;
      if (!moduleFiles.has(resolved.relative)) {
        moduleFiles.add(resolved.relative);
        queue.push(resolved.absolute);
      }
    }
    if (owner.endsWith('.ink')) {
      for (const specifier of literalAssetSpecifiers(text)) {
        if (!String(specifier).trim().startsWith('.')) continue;
        const resolved = resolveLocalFile(root, owner, specifier, 'asset');
        assetFiles.add(resolved.relative);
      }
    }
    if (owner.endsWith('.js') || owner.endsWith('.mjs')) {
      for (const specifier of moduleAssetSpecifiers(text)) {
        const relative = resolveProjectAssetLiteral(root, specifier);
        if (relative) assetFiles.add(relative);
      }
    }
  }

  for (const font of Array.isArray(app.fonts) ? app.fonts : []) {
    const source = String(font?.src || '').trim();
    if (!source || /^(?:https?:|data:|\/)/i.test(source)) continue;
    const relative = source.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!relative.startsWith('assets/')) {
      throw new Error(`Bundled font must live under assets/: ${JSON.stringify(source)}`);
    }
    assertRegularFile(root, relative);
    assetFiles.add(relative);
  }

  for (const relative of moduleFiles) files.add(relative);
  for (const relative of assetFiles) files.add(relative);
  for (const relative of AIX_RUNTIME_METADATA_FILES) assertRegularFile(root, relative);

  return Object.freeze({
    files: Object.freeze([...files].sort(compareUtf8)),
    pageFiles: Object.freeze([...pageFiles]),
    moduleFiles: Object.freeze([...moduleFiles].sort(compareUtf8)),
    assetFiles: Object.freeze([...assetFiles].sort(compareUtf8)),
  });
}
