import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('CI locks the local Node and npm toolchain and runs the complete release gate', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const nodeVersion = read('.nvmrc').trim();
  const workflow = read('.github/workflows/ci.yml');

  assert.equal(nodeVersion, '24.14.0');
  assert.equal(pkg.packageManager, 'npm@11.9.0');
  assert.equal(pkg.engines.node, '>=24.14.0 <25');
  assert.equal(pkg.engines.npm, '>=11.9.0 <12');
  assert.deepEqual(lock.packages[''].engines, pkg.engines);
  assert.equal(
    pkg.devDependencies['@yodaos-pkg/create-aiui-agent'],
    '2.1.2',
    'AIUI scaffold must remain exactly pinned while upstream 2.1.3 ships an invalid template declaration',
  );
  assert.equal(
    lock.packages[''].devDependencies['@yodaos-pkg/create-aiui-agent'],
    '2.1.2',
  );

  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /timeout-minutes:\s*20/);
  assert.match(
    workflow,
    /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\s+# v7\.0\.1/,
  );
  assert.match(
    workflow,
    /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020\s+# v7\.0\.0/,
  );
  assert.doesNotMatch(workflow, /uses:\s*actions\/(?:checkout|setup-node)@v\d+\b/);
  assert.match(workflow, /node-version-file:\s*\.nvmrc/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /run:\s*npm audit --audit-level=high/);
  assert.match(workflow, /run:\s*npm run validate:public/);
  assert.match(workflow, /run:\s*npm test/);
  assert.match(workflow, /run:\s*npm run doctor:aiui/);
  assert.match(workflow, /run:\s*npm run build:all/);
  assert.equal(pkg.scripts['test:coverage'], 'node scripts/run_tests.mjs --coverage');
  const releaseGate = read('tools/verify_release.mjs');
  assert.match(releaseGate, /\['npm', 'run', 'test:coverage'\]/);
  const runner = read('scripts/run_tests.mjs');
  assert.match(runner, /--test-coverage-include=lib\/\*\.js/);
  assert.match(runner, /--test-coverage-lines=95/);
  assert.match(runner, /--test-coverage-branches=85/);
  assert.match(runner, /--test-coverage-functions=95/);
  assert.doesNotMatch(workflow, /\b(?:pull_request_target|contents:\s*write|id-token:\s*write)\b/);
});

test('generated AIX packages stay local and are never treated as platform releases', () => {
  const ignore = read('.gitignore');
  const readme = read('README.md');

  assert.match(ignore, /^release\/$/m);
  assert.match(ignore, /^\*\.aix$/m);
  assert.match(readme, /Generated `\.aix` packages remain local/);
  assert.match(readme, /does not upload to AIUI Studio/);
  assert.match(readme, /Local tests, Reader checks, or an AIX build do not prove those hardware gates/);
});
