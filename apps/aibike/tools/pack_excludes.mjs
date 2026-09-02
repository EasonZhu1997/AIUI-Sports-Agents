import fs from 'node:fs';
import path from 'node:path';

const IMPORT_RE = /\b(?:from\s+|import\s*(?:\(\s*)?)['"]([^'"]+)['"]/g;

function walkJavaScript(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJavaScript(abs, files);
    else if (entry.name.endsWith('.js')) files.push(abs);
  }
  return files;
}

function resolveImport(sourceFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const candidate = path.resolve(path.dirname(sourceFile), specifier);
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  if (fs.existsSync(`${candidate}.js`)) return `${candidate}.js`;
  return null;
}

/**
 * 从 app.js 与实际页面出发计算运行时 lib 依赖闭包。
 * 新增 cycling_metrics.js / cycling_imu.js 后，只要页面或已引用库 import，
 * 就会自动进入 AIX；未引用的旧运动模式与诊断模块不会泄漏到发布包。
 */
export function findRuntimeLibFiles(rootDir, pageFiles = [
  'pages/index/index.ink',
  'pages/ride_hud/index.ink',
]) {
  const root = path.resolve(rootDir);
  const queue = [
    path.join(root, 'app.js'),
    ...pageFiles.map((rel) => path.join(root, rel)),
  ].filter((abs) => fs.existsSync(abs));
  const visited = new Set();
  const runtimeLibs = new Set();

  while (queue.length) {
    const sourceFile = queue.shift();
    if (visited.has(sourceFile)) continue;
    visited.add(sourceFile);
    const text = fs.readFileSync(sourceFile, 'utf8');
    for (const match of text.matchAll(IMPORT_RE)) {
      const imported = resolveImport(sourceFile, match[1]);
      if (!imported || !imported.startsWith(path.join(root, 'lib') + path.sep)) continue;
      const rel = path.relative(root, imported).split(path.sep).join('/');
      if (!runtimeLibs.has(rel)) {
        runtimeLibs.add(rel);
        queue.push(imported);
      }
    }
  }
  return [...runtimeLibs].sort();
}

export function findUnusedLibFiles(rootDir, pageFiles) {
  const root = path.resolve(rootDir);
  const runtime = new Set(findRuntimeLibFiles(root, pageFiles));
  return walkJavaScript(path.join(root, 'lib'))
    .map((abs) => path.relative(root, abs).split(path.sep).join('/'))
    .filter((rel) => !runtime.has(rel))
    .sort();
}
