import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(await fs.readFile(path.join(root, 'registry/projects.json'), 'utf8'));

console.log('| Project | Sport | Track | Version | Evidence | Common | Sport | Open gates | Source distribution |');
console.log('|---|---|---|---|---|---|---|---:|---|');

for (const project of registry.projects) {
  const result = JSON.parse(await fs.readFile(path.join(root, project.result), 'utf8'));
  const summarize = (metrics) => {
    const counts = { pass: 0, partial: 0, blocked: 0, not_run: 0 };
    for (const metric of metrics) counts[metric.status] += 1;
    return `P${counts.pass}/~${counts.partial}/B${counts.blocked}/N${counts.not_run}`;
  };
  const source = project.sourceDistribution;
  const sourceSummary = source
    ? `${source.status ?? 'invalid'} · ${project.sourcePath ?? 'no public path'} · ${source.communityLicense ?? 'invalid'}`
    : 'invalid';
  console.log(`| ${project.name} | ${project.sport} | ${project.status} | ${project.version} | ${result.evidenceLevel} | ${summarize(result.common)} | ${summarize(result.sportSpecific)} | ${result.openGates.length} | ${sourceSummary} |`);
}

console.log('\nLegend: P=pass, ~=partial, B=blocked, N=not run. Every status is bounded by the listed evidence level. Source distribution status is separate from evidence maturity.');
