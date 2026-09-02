import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);

if (!args.length) {
  console.error('Please specify the project directory:');
  console.error('  npm run scaffold:aiui -- <new-agent-name>');
  process.exit(1);
}

const result = spawnSync('create-aiui-agent', args, { stdio: 'inherit' });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status || 0);
