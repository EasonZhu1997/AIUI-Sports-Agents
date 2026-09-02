import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testDir = path.join(ROOT, 'test');
const specs = fs.readdirSync(testDir)
  .filter((name) => name.endsWith('.spec.mjs'))
  .sort()
  .map((name) => path.join(testDir, name));
const coverage = process.argv.includes('--coverage');

if (!specs.length) {
  console.error('FAIL: test/ contains no *.spec.mjs files');
  process.exit(1);
}

const nodeArgs = ['--test'];
if (coverage) {
  nodeArgs.push(
    '--experimental-test-coverage',
    '--test-coverage-include=lib/*.js',
    '--test-coverage-lines=95',
    '--test-coverage-branches=85',
    '--test-coverage-functions=95',
  );
}
nodeArgs.push(...specs);

console.log(
  `running ${specs.length} spec files via node --test${coverage ? ' with lib coverage gates' : ''} ...`,
);
const result = spawnSync(process.execPath, nodeArgs, {
  cwd: ROOT,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`FAIL: unable to start node test runner: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
