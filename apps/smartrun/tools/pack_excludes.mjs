import fs from 'node:fs';
import path from 'node:path';

// 这些已退役的运行时模块不得出现在公开源码快照或 AIX 发布包中。
// 若某个模块重新被产品采用，必须先完成安全审查，再从清单移除。
export const ORPHAN_LIB_FILES = [
  'lib/cycling.js',
  'lib/ftms.js',
  'lib/geolocation.js',
  'lib/gps_path.js',
  'lib/motion_source_selector.js',
  'lib/plx.js',
  'lib/registry.js',
  'lib/sport_agent.js',
];

function walkFiles(dir, matcher, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(abs, matcher, files);
    else if (matcher.test(entry.name)) files.push(abs);
  }
  return files;
}

// 扫描发布包内的运行时源码（app.js、pages/**/*.ink、随包的 lib/*.js），
// 找出仍指向孤儿模块的 import。命中即说明清单过期，打包必须失败。
export function findOrphanLibReferences(rootDir) {
  const orphanSet = new Set(ORPHAN_LIB_FILES);
  const orphanNames = ORPHAN_LIB_FILES.map((rel) => path.basename(rel));
  const sources = [path.join(rootDir, 'app.js')]
    .concat(walkFiles(path.join(rootDir, 'pages'), /\.ink$/))
    .concat(walkFiles(path.join(rootDir, 'lib'), /\.js$/)
      .filter((abs) => !orphanSet.has(path.relative(rootDir, abs))));
  const hits = [];
  for (const abs of sources) {
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    for (const name of orphanNames) {
      if (text.includes(`/${name}`)) {
        hits.push(`${path.relative(rootDir, abs)} imports ${name}`);
      }
    }
  }
  return hits;
}
