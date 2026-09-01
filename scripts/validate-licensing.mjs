import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

const apachePath = 'LICENSE';
const polyFormPath = 'licenses/PolyForm-Noncommercial-1.0.0.md';
const requiredPolicyFiles = [
  'LICENSE_POLICY.md',
  'COMMERCIAL_LICENSE.md',
  'TRADEMARKS.md',
  'CLA.md',
];

// SHA-256 of the canonical Apache License 2.0 text currently used at the
// repository root, after normalizing line endings and trailing whitespace.
const apache20Sha256 = 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4';
const polyFormNoncommercial100Sha256 = 'c0ea4a896d2c8c394b29f9427589996db826cd501c512279ff0ed3ef48fabbe5';

function normalize(text) {
  return text
    .replaceAll('\r\n', '\n')
    .replace(/[ \t]+$/gm, '')
    .trimEnd()
    .concat('\n');
}

function sha256(text) {
  return createHash('sha256').update(normalize(text), 'utf8').digest('hex');
}

async function readRequired(relativePath) {
  try {
    const text = await fs.readFile(path.join(root, relativePath), 'utf8');
    if (!text.trim()) {
      errors.push(`${relativePath}: file is empty`);
      return null;
    }
    return text;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      errors.push(`${relativePath}: required licensing file is missing`);
    } else {
      errors.push(`${relativePath}: cannot be read (${error.message})`);
    }
    return null;
  }
}

function requireFragments(relativePath, text, fragments) {
  for (const fragment of fragments) {
    if (!text.includes(fragment)) {
      errors.push(`${relativePath}: missing canonical text: ${JSON.stringify(fragment)}`);
    }
  }
}

function requirePattern(relativePath, text, pattern, description) {
  if (!pattern.test(text)) errors.push(`${relativePath}: ${description}`);
}

function checkNodeVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isInteger(major) || major < 20 || major >= 26) {
    errors.push(`runtime: Node.js 20-25 is required (current: ${process.versions.node})`);
  }
}

function checkApacheLicense(text) {
  requireFragments(apachePath, text, [
    'Apache License',
    'Version 2.0, January 2004',
    'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
    '2. Grant of Copyright License.',
    '3. Grant of Patent License.',
    '6. Trademarks.',
    'END OF TERMS AND CONDITIONS',
    'http://www.apache.org/licenses/LICENSE-2.0',
  ]);

  const actual = sha256(text);
  if (actual !== apache20Sha256) {
    errors.push(`${apachePath}: canonical Apache-2.0 text changed (SHA-256 ${actual})`);
  }
}

function checkPolyFormTemplate(text) {
  const requiredHeadings = [
    '# PolyForm Noncommercial License 1.0.0',
    '## Acceptance',
    '## Copyright License',
    '## Distribution License',
    '## Notices',
    '## Changes and New Works License',
    '## Patent License',
    '## Noncommercial Purposes',
    '## Personal Uses',
    '## Noncommercial Organizations',
    '## Fair Use',
    '## No Other Rights',
    '## Patent Defense',
    '## Violations',
    '## No Liability',
    '## Definitions',
  ];

  let offset = -1;
  for (const heading of requiredHeadings) {
    const next = text.indexOf(heading, offset + 1);
    if (next === -1) {
      errors.push(`${polyFormPath}: missing canonical heading ${JSON.stringify(heading)}`);
      continue;
    }
    if (next < offset) {
      errors.push(`${polyFormPath}: canonical headings are out of order near ${JSON.stringify(heading)}`);
    }
    offset = next;
  }

  requireFragments(polyFormPath, text, [
    'https://polyformproject.org/licenses/noncommercial/1.0.0',
    'In order to get any license under these terms, you must agree to them as both strict obligations and conditions to all your licenses.',
    'The licensor grants you an additional copyright license to distribute copies of the software.',
    'The licensor grants you an additional copyright license to make changes and new works based on the software for any permitted purpose.',
    'Any noncommercial purpose is a permitted purpose.',
    'without any anticipated commercial application, is use for a permitted purpose.',
    'regardless of the source of funding or obligations resulting from the funding.',
    'These terms do not limit them.',
    'within 32 days of receiving notice.',
    'The **licensor** is the individual or entity offering these terms, and the **software** is the software the licensor makes available under these terms.',
    '**Your licenses** are all the licenses granted to you for the software under these terms.',
    '**Use** means anything you do with the software requiring one of your licenses.',
  ]);

  const actual = sha256(text);
  if (actual !== polyFormNoncommercial100Sha256) {
    errors.push(`${polyFormPath}: official PolyForm Noncommercial 1.0.0 template changed (SHA-256 ${actual})`);
  }
}

function checkPolicyDocuments(documents) {
  const policy = documents.get('LICENSE_POLICY.md');
  if (policy) {
    requirePattern(
      'LICENSE_POLICY.md',
      policy,
      /Apache(?: License)?[- ]?2\.0/i,
      'must identify Apache-2.0 as the current Hub license',
    );
    requirePattern(
      'LICENSE_POLICY.md',
      policy,
      /PolyForm[ -]Noncommercial(?: License)?[ -]1\.0\.0/i,
      'must identify the PolyForm Noncommercial 1.0.0 application-source template',
    );
    requirePattern(
      'LICENSE_POLICY.md',
      policy,
      /(?:Hub|总仓|本仓库|current repository).{0,120}Apache|Apache.{0,120}(?:Hub|总仓|本仓库|current repository)/is,
      'must explicitly bind the current Hub to Apache-2.0',
    );
  }

  const commercial = documents.get('COMMERCIAL_LICENSE.md');
  if (commercial) {
    requirePattern(
      'COMMERCIAL_LICENSE.md',
      commercial,
      /commercial|商业/i,
      'must describe the commercial-license path',
    );
  }

  const trademarks = documents.get('TRADEMARKS.md');
  if (trademarks) {
    requirePattern(
      'TRADEMARKS.md',
      trademarks,
      /trademark|商标/i,
      'must describe the trademark boundary',
    );
  }

  const cla = documents.get('CLA.md');
  if (cla) {
    requirePattern(
      'CLA.md',
      cla,
      /contribut|贡献/i,
      'must describe contribution terms',
    );
    requirePattern(
      'CLA.md',
      cla,
      /licen[cs]e|许可|授权/i,
      'must include a contribution license grant or license terms',
    );
  }
}

function checkHubSurfaces(files) {
  const packageJsonText = files.get('package.json');
  if (packageJsonText) {
    try {
      const packageJson = JSON.parse(packageJsonText);
      if (packageJson.license !== 'Apache-2.0') {
        errors.push(`package.json: license must remain Apache-2.0 (found ${JSON.stringify(packageJson.license)})`);
      }
      const engine = packageJson.engines?.node;
      if (engine !== '>=20 <26') {
        errors.push(`package.json: engines.node must remain \">=20 <26\" (found ${JSON.stringify(engine)})`);
      }
    } catch (error) {
      errors.push(`package.json: invalid JSON (${error.message})`);
    }
  }

  const forbiddenClaims = [
    /\b(?:this|the current)\s+(?:repository|repo|hub)\s+(?:is|uses?|is licensed under)\s+(?:the\s+)?(?:PolyForm|noncommercial|non-commercial)\b/i,
    /\b(?:PolyForm\s+Noncommercial(?:\s+License)?|noncommercial\s+license)\s+(?:applies|covers|governs)\s+(?:to\s+)?(?:this|the current)\s+(?:repository|repo|hub)\b/i,
    /(?:本|当前)(?:公开)?(?:仓库|总仓|Hub|hub).{0,24}(?:采用|适用|使用|受限于|授权为|许可为).{0,20}(?:PolyForm|非商业)/i,
    /(?:PolyForm|非商业).{0,20}(?:适用于|覆盖|管辖).{0,20}(?:本|当前)(?:公开)?(?:仓库|总仓|Hub|hub)/i,
  ];
  const explicitNegation = /\b(?:not|does not|isn't|is not)\b|不(?:采用|适用|覆盖|是|受限于)|并非|不是/i;

  const authoritativeSurfaces = [
    'README.md',
    'README.en.md',
    'CONTRIBUTING.md',
    'GOVERNANCE.md',
    'LICENSE_POLICY.md',
    'COMMERCIAL_LICENSE.md',
    'TRADEMARKS.md',
    'CLA.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/ISSUE_TEMPLATE/contribution-survey.yml',
    '.github/ISSUE_TEMPLATE/bug-and-device-evidence.yml',
    'articles/从本地到GitHub_一步步开源AIUI项目.md',
  ];
  for (const relativePath of authoritativeSurfaces) {
    const text = files.get(relativePath);
    if (!text) continue;
    for (const [index, line] of text.split('\n').entries()) {
      for (const pattern of forbiddenClaims) {
        const match = line.match(pattern);
        if (match && !explicitNegation.test(match[0])) {
          errors.push(`${relativePath}:${index + 1}: current Hub must not be declared noncommercial or PolyForm-licensed`);
          break;
        }
      }
    }
  }
}

function isPlaceholderIdentity(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return true;
  return /^(?:EXACT_LEGAL_LICENSOR_NAME|LEGAL_NAME|YOUR_(?:LEGAL_)?NAME|REVIEWER_IDENTITY|TODO|TBD|UNKNOWN|EXAMPLE(?: LEGAL)? LICENSOR|TEST LICENSOR)$/i.test(value.trim());
}

function checkRegistry(text) {
  if (!text) return { unpublished: 0, published: 0 };
  let registry;
  try {
    registry = JSON.parse(text);
  } catch (error) {
    errors.push(`registry/projects.json: invalid JSON (${error.message})`);
    return { unpublished: 0, published: 0 };
  }

  if (!Array.isArray(registry.projects)) {
    errors.push('registry/projects.json: projects must be an array');
    return { unpublished: 0, published: 0 };
  }
  if (registry.schemaVersion !== 2) {
    errors.push(`registry/projects.json: licensing boundary requires schemaVersion 2 (found ${JSON.stringify(registry.schemaVersion)})`);
  }

  let unpublished = 0;
  let published = 0;
  for (const project of registry.projects) {
    const label = project?.id || '<missing-id>';
    const expectedApprovalRecord = `registry/source-approvals/${label}.json`;
    if (Object.hasOwn(project ?? {}, 'openSourceExport')) {
      errors.push(`registry/projects.json:${label}: legacy openSourceExport field is forbidden`);
    }
    const hasRepository = typeof project?.sourceRepository === 'string'
      && project.sourceRepository.trim().length > 0;
    const distribution = project?.sourceDistribution;
    const distributionStatus = distribution?.status;
    if (!distribution || typeof distribution !== 'object' || Array.isArray(distribution)) {
      errors.push(`registry/projects.json:${label}: sourceDistribution must be an object`);
    } else {
      if (!['pending', 'ready', 'published'].includes(distribution.status)) {
        errors.push(`registry/projects.json:${label}: invalid sourceDistribution.status`);
      }
      if (distribution.model !== 'source-available-dual-license') {
        errors.push(`registry/projects.json:${label}: sourceDistribution.model must be source-available-dual-license`);
      }
      if (distribution.communityLicense !== 'PolyForm-Noncommercial-1.0.0') {
        errors.push(`registry/projects.json:${label}: sourceDistribution.communityLicense must be PolyForm-Noncommercial-1.0.0`);
      }
      if (distribution.commercialAuthorization !== 'written-agreement-required') {
        errors.push(`registry/projects.json:${label}: commercial authorization must require a written agreement`);
      }
    }

    if (distributionStatus !== 'published') {
      unpublished += 1;
      if (distributionStatus === 'pending' && hasRepository) {
        errors.push(`registry/projects.json:${label}: pending application source must not advertise sourceRepository`);
      }
      if (distributionStatus === 'pending' && project?.approvalRecord !== null) {
        errors.push(`registry/projects.json:${label}: pending application source must not advertise approvalRecord`);
      }
      if (distributionStatus === 'ready'
          && isPlaceholderIdentity(distribution?.licensor)) {
        errors.push(`registry/projects.json:${label}: ready application source requires a named licensor`);
      }
      if (distributionStatus === 'ready' && project?.approvalRecord !== expectedApprovalRecord) {
        errors.push(`registry/projects.json:${label}: ready application source requires its authoritative Hub approval record`);
      }
      // Unpublished application source is intentionally outside this Hub's
      // Apache license check. A null licensor is acceptable until publication,
      // and must not be mistaken for an invalid Hub license.
      continue;
    }

    published += 1;
    if (!hasRepository) {
      errors.push(`registry/projects.json:${label}: published application source requires sourceRepository`);
    }
    if (isPlaceholderIdentity(distribution?.licensor)) {
      errors.push(`registry/projects.json:${label}: published application source requires a named licensor`);
    }
    if (project?.approvalRecord !== expectedApprovalRecord) {
      errors.push(`registry/projects.json:${label}: published application source requires its authoritative Hub approval record`);
    }
  }
  return { unpublished, published };
}

checkNodeVersion();

const requiredPaths = [
  apachePath,
  polyFormPath,
  ...requiredPolicyFiles,
  'package.json',
  'README.md',
  'README.en.md',
  'CONTRIBUTING.md',
  'GOVERNANCE.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/CODEOWNERS',
  '.github/ISSUE_TEMPLATE/contribution-survey.yml',
  '.github/ISSUE_TEMPLATE/bug-and-device-evidence.yml',
  'articles/从本地到GitHub_一步步开源AIUI项目.md',
  'registry/projects.json',
];
const entries = await Promise.all(requiredPaths.map(async (relativePath) => [
  relativePath,
  await readRequired(relativePath),
]));
const files = new Map(entries);

const apache = files.get(apachePath);
if (apache) checkApacheLicense(apache);

const polyForm = files.get(polyFormPath);
if (polyForm) checkPolyFormTemplate(polyForm);

checkPolicyDocuments(files);
checkHubSurfaces(files);
const registrySummary = checkRegistry(files.get('registry/projects.json'));

if (errors.length > 0) {
  console.error(`Licensing boundary validation failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    'Licensing boundary validation passed: '
      + 'Apache-2.0 Hub; canonical PolyForm Noncommercial 1.0.0 markers; '
      + `${requiredPolicyFiles.length} policy documents; `
      + `${registrySummary.unpublished} unpublished application source entr${registrySummary.unpublished === 1 ? 'y' : 'ies'} skipped; `
      + `${registrySummary.published} published application source entr${registrySummary.published === 1 ? 'y' : 'ies'} observed.`,
  );
}
