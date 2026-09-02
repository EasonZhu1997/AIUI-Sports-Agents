import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AIX_UUID_V4_RE } from './bump_version.mjs';
import { assertAixPlatformFootprint } from './aix_size_budget.mjs';
import { findUnusedLibFiles } from './pack_excludes.mjs';
import {
  AIX_LOCALES,
  AIX_PROVENANCE_FILE,
  AIX_TRANSFORM_VERSIONS,
  computeAixTreeSha256,
  computeReleaseSourceTreeSha256,
  parseAndVerifyAixProvenance,
} from './aix_provenance.mjs';
import {
  ENGLISH_FORBIDDEN_UI_COPY,
  ENGLISH_LOCALIZED_FILES,
  ENGLISH_REQUIRED_MARKERS,
  ENGLISH_STORE_DESCRIPTION,
  JAPANESE_FORBIDDEN_UI_COPY,
  JAPANESE_LOCALIZED_FILES,
  JAPANESE_REQUIRED_MARKERS,
  JAPANESE_STORE_DESCRIPTION,
  assertEnglishRuntimeCopy,
  assertJapaneseRuntimeCopy,
  outputArgument,
  resolveAixVariant,
} from './aix_locales.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const PRODUCT_VERSION = String(packageJson.version || '').trim();
const VARIANT = resolveAixVariant(process.argv.slice(2));
const RELEASE_NAME = `AIBike-AIUI-v${PRODUCT_VERSION}-${VARIANT.suffix}.aix`;
const TARGET = path.resolve(
  ROOT,
  outputArgument(process.argv.slice(2)) || `release/${RELEASE_NAME}`,
);
const AIX_WEB = pathToFileURL(path.join(ROOT, 'node_modules/@yodaos-pkg/aix/pkg/aix_web.js')).href;
const WASM_PATH = path.join(ROOT, 'node_modules/@yodaos-pkg/aix/pkg/aix_web_bg.wasm');
const REQUIRED_FILES = [
  '.aixignore',
  AIX_PROVENANCE_FILE,
  'AGENTS.md',
  'LICENSE',
  'COPYRIGHT',
  'COMMERCIAL_LICENSE.md',
  'TRADEMARKS.md',
  'VERSION',
  'assets/audio/NOTICE.md',
  'assets/audio/metro_0468_bar_80.wav',
  'assets/audio/metro_0468_bar_90.wav',
  'assets/audio/metro_0468_bar_100.wav',
  'app.js',
  'app.json',
  'package.json',
  'pages/index/index.ink',
  'pages/ride_hud/index.ink',
  'lib/cycling.js',
  'lib/ftms.js',
  'lib/cycling_metrics.js',
  'lib/cycling_imu.js',
  'lib/cycling_imu_speed.js',
  'lib/aiui_world_awareness.js',
  'lib/ride_coach.js',
  'lib/ride_warmup.js',
  'lib/ride_history.js',
  'lib/ride_source_health.js',
  'lib/ride_ai_advice.js',
  'lib/network_policy.js',
  'lib/sports_identity.js',
  'lib/sports_workout.js',
  'lib/sports_workout_executor.js',
  'lib/sports_coach.js',
  'lib/sports_outbox.js',
  'lib/sport_agent.js',
];
const PAGE_FILES = [
  'pages/index/index.ink',
  'pages/ride_hud/index.ink',
];
const FORBIDDEN_PREFIXES = [
  'test/',
  'preview/',
  'docs/',
  'release/',
  'release-archive/',
  'sample-release/',
  'node_modules/',
  'assets/warmup/',
];
const FORBIDDEN_FILES = [
  'PROGRESS.md',
  'DEVICES.md',
  'assets/aibike-cyclist-48.png',
  'assets/smartrun-runner-48.png',
];
const REQUIRED_PERMISSIONS = [
  'bluetooth',
  'accelerometer',
  'gyroscope',
  'audio',
];
const REQUIRED_APP_PERMISSIONS = [];
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;
const OLD_PRODUCT_RE = /\bAISmartRun\b|\bSmartRun\b|pages\/run_hud|跑步|步频|配速/;
const NON_ENGLISH_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const CJK_PUNCTUATION_RE = /[，。；：、！？【】「」『』（）]/u;
const ENGLISH_INTERNAL_LITERAL_ALLOWLIST = new Map([
  ['lib/ride_ai_advice.js', new Set(['高', '中', '低'])],
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(reader, name) {
  try {
    return JSON.parse(new TextDecoder().decode(reader.read_file(name)));
  } catch (error) {
    fail(`Invalid JSON in ${name}: ${error.message}`);
  }
}

function readText(reader, name) {
  return new TextDecoder().decode(reader.read_file(name));
}

function extractInkDef(text, file) {
  const match = text.match(/<script[^>]*\bdef\b[^>]*>\s*([\s\S]*?)\s*<\/script>/);
  if (!match) fail(`AIX page is missing <script def>: ${file}`);
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    fail(`AIX page has invalid <script def>: ${file}: ${error.message}`);
  }
}

function extractRule(text, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  return match ? match[1] : '';
}

function assertCanvas(text, file, selector, width, height) {
  const rule = extractRule(text, selector);
  if (!new RegExp(`\\bwidth:\\s*${width}px;`).test(rule)
      || !new RegExp(`\\bheight:\\s*${height}px;`).test(rule)
      || /\b(?:min|max)-(?:width|height):/.test(rule)) {
    fail(`AIX canvas mismatch: ${file} ${selector} must be exactly ${width}x${height}px`);
  }
}

function pixelWidth(text, selector) {
  const match = extractRule(text, selector).match(/\bwidth:\s*(\d+)px;/);
  return match ? Number(match[1]) : null;
}

function manifestPermissions(text) {
  const section = text.match(/- \*\*Permissions\*\*:\s*\n((?:\s+-[^\n]+\n?)+)/);
  if (!section) fail('AIX AGENTS.md is missing Permissions');
  return section[1].trim().split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*-\s+([a-z][a-z0-9_-]*)\s*$/);
    if (!match) fail(`AIX permission entries must be bare tokens: ${line.trim()}`);
    return match[1];
  });
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

function sourceStringLiterals(value, { detectRegex = true, lineOffset = 0 } = {}) {
  const source = String(value ?? '').replace(/<!--[\s\S]*?-->/g, ' ');
  const literals = [];
  let index = 0;
  let line = 1 + lineOffset;
  let canStartRegex = true;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '\n') {
      line += 1;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') line += 1;
        index += 1;
      }
      index += 2;
      continue;
    }
    if (detectRegex && char === '/' && canStartRegex) {
      let inCharacterClass = false;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (current === '\\') {
          index += 2;
          continue;
        }
        if (current === '\n') break;
        if (current === '[') inCharacterClass = true;
        else if (current === ']') inCharacterClass = false;
        else if (current === '/' && !inCharacterClass) {
          index += 1;
          while (/[a-z]/i.test(source[index] || '')) index += 1;
          break;
        }
        index += 1;
      }
      canStartRegex = false;
      continue;
    }
    if (char !== "'" && char !== '"' && char !== '`') {
      if (/[A-Za-z_$]/.test(char)) {
        const start = index;
        index += 1;
        while (/[A-Za-z0-9_$]/.test(source[index] || '')) index += 1;
        canStartRegex = REGEX_PREFIX_KEYWORDS.has(source.slice(start, index));
        continue;
      }
      if (/\d/.test(char)) {
        index += 1;
        while (/[\w.]/.test(source[index] || '')) index += 1;
        canStartRegex = false;
        continue;
      }
      if (char === ')' || char === ']' || char === '}' || char === '.') {
        canStartRegex = false;
      } else if (!/\s/.test(char)) {
        canStartRegex = true;
      }
      index += 1;
      continue;
    }

    const quote = char;
    const startLine = line;
    let literal = '';
    index += 1;
    while (index < source.length) {
      const current = source[index];
      if (current === '\\') {
        literal += current;
        if (index + 1 < source.length) {
          literal += source[index + 1];
          if (source[index + 1] === '\n') line += 1;
        }
        index += 2;
        continue;
      }
      if (current === quote) {
        index += 1;
        break;
      }
      if (current === '\n') line += 1;
      literal += current;
      index += 1;
    }
    literals.push({ line: startLine, value: literal });
    canStartRegex = false;
  }
  return literals;
}

function pageSourceStringLiterals(value) {
  const source = String(value ?? '');
  const literals = [];
  for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const lineOffset = source.slice(0, match.index).split('\n').length - 1;
    literals.push(...sourceStringLiterals(match[1], { lineOffset }));
  }
  const markup = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (block) => block.replace(/[^\n]/g, ' '));
  literals.push(...sourceStringLiterals(markup, { detectRegex: false }));
  return literals;
}

function visiblePageText(value) {
  const match = String(value ?? '').match(/<page\b[^>]*>([\s\S]*?)<\/page>/i);
  if (!match) return '';
  return match[1]
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/\{\{[\s\S]*?\}\}/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function englishRuntimePurityIssues(files) {
  const issues = [];
  for (const [file, text] of files) {
    if (!/^(?:pages\/|lib\/)/.test(file) || !ENGLISH_LOCALIZED_FILES.includes(file)) continue;
    const candidates = file.endsWith('.ink')
      ? pageSourceStringLiterals(text)
      : sourceStringLiterals(text);
    const visible = visiblePageText(text);
    if (visible) candidates.push({ line: 'template', value: visible });
    const allowlist = ENGLISH_INTERNAL_LITERAL_ALLOWLIST.get(file) || new Set();
    for (const candidate of candidates) {
      if (allowlist.has(candidate.value)) continue;
      const script = candidate.value.match(NON_ENGLISH_SCRIPT_RE);
      const punctuation = candidate.value.match(CJK_PUNCTUATION_RE);
      if (!script && !punctuation) continue;
      const excerpt = candidate.value.replace(/\s+/g, ' ').slice(0, 72);
      const kind = script ? 'non-English script' : 'CJK punctuation';
      issues.push(`${file}:${candidate.line} ${kind} ${JSON.stringify(excerpt)}`);
      if (issues.length >= 12) return issues;
    }
  }
  return issues;
}

async function assertPackagedEnglishRuntime(reader, entryNames) {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aibike-inspect-en-'));
  let caught = null;
  try {
    for (const rel of ENGLISH_LOCALIZED_FILES) {
      if (!entryNames.has(rel)) continue;
      const target = path.join(stagingRoot, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, reader.read_file(rel));
    }
    assertEnglishRuntimeCopy(stagingRoot);
  } catch (error) {
    caught = error;
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
  if (caught) fail(`English AIX runtime-copy helper failed: ${caught.message}`);
}

async function assertPackagedJapaneseRuntime(reader, entryNames) {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aibike-inspect-ja-'));
  let caught = null;
  try {
    for (const rel of JAPANESE_LOCALIZED_FILES) {
      if (!entryNames.has(rel)) continue;
      const target = path.join(stagingRoot, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, reader.read_file(rel));
    }
    assertJapaneseRuntimeCopy(stagingRoot);
  } catch (error) {
    caught = error;
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
  if (caught) fail(`Japanese AIX runtime-copy helper failed: ${caught.message}`);
}

let aixModule;
try {
  aixModule = await import(AIX_WEB);
} catch (error) {
  fail(`Unable to load @yodaos-pkg/aix reader: ${error.message}`);
}
const { default: init, AixReaderWasm } = aixModule;
await init({ module_or_path: await fs.readFile(WASM_PATH) });

const reader = new AixReaderWasm(new Uint8Array(await fs.readFile(TARGET)));
const entries = reader.list();
const entryNames = entries.map((entry) => String(entry.name || ''));
if (new Set(entryNames).size !== entryNames.length) {
  fail('AIX package contains duplicate ZIP paths and cannot be provenance-verified');
}
const packagedFileEntries = entries.filter(
  (entry) => !String(entry.name || '').endsWith('/'),
);
const names = new Set(entryNames);
const missing = REQUIRED_FILES.filter((name) => !names.has(name));
if (missing.length) fail(`AIX package is missing: ${missing.join(', ')}`);

let currentSourceTreeSha256;
let packagedPayloadTreeSha256;
let packagedProvenance;
try {
  currentSourceTreeSha256 = computeReleaseSourceTreeSha256(ROOT, {
    excludedPaths: [
      ...findUnusedLibFiles(ROOT, PAGE_FILES),
      'assets/audio/metro_0468.wav',
    ],
  });
  packagedPayloadTreeSha256 = computeAixTreeSha256(
    packagedFileEntries.map((entry) => ({
      path: String(entry.name || ''),
      bytes: reader.read_file(entry.name),
    })),
  );
  packagedProvenance = parseAndVerifyAixProvenance(
    readText(reader, AIX_PROVENANCE_FILE),
    {
      expectedLocale: VARIANT.locale,
      currentSourceTreeSha256,
      packagedPayloadTreeSha256,
    },
  );
} catch (error) {
  fail(`AIX provenance verification failed: ${error.message}`);
}

const forbidden = entryNames.filter(
  (name) => FORBIDDEN_FILES.includes(name)
    || FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix)),
);
if (forbidden.length) fail(`AIX package leaks internal files: ${forbidden.join(', ')}`);

const contentBytes = entries.reduce((total, entry) => total + Number(entry.size || 0), 0);
const sizeBudget = assertAixPlatformFootprint(contentBytes, path.basename(TARGET));

const packagedIgnore = readText(reader, '.aixignore');
if (!packagedIgnore.split(/\r?\n/).map((line) => line.trim()).includes('VERSION')) {
  fail('AIX .aixignore must preserve Craft-generated VERSION');
}
const aixUuid = readText(reader, 'VERSION').trim();
if (!AIX_UUID_V4_RE.test(aixUuid)) fail(`AIX VERSION is not UUID v4: ${aixUuid}`);

const pkg = readJson(reader, 'package.json');
const expectedDescription = VARIANT.key === 'ja'
  ? JAPANESE_STORE_DESCRIPTION
  : VARIANT.key === 'en'
    ? ENGLISH_STORE_DESCRIPTION
    : packageJson.description;
if (pkg.name !== 'AIBike' || pkg.version !== PRODUCT_VERSION
    || pkg.description !== expectedDescription) {
  fail('AIX package.json metadata mismatch');
}
const app = readJson(reader, 'app.json');
if (JSON.stringify(app.pages) !== JSON.stringify([
  'pages/index/index',
  'pages/ride_hud/index',
])) {
  fail('AIX app.json routes must be index then ride_hud');
}
if (JSON.stringify(app.permissions) !== JSON.stringify(REQUIRED_APP_PERMISSIONS)
    || app.window?.navigationBarTitleText !== 'AIBike') {
  fail('AIX app.json permissions or title mismatch');
}

const agents = readText(reader, 'AGENTS.md');
if (!agents.includes('- **Name**: AIBike')
    || !agents.includes(`- **Version**: ${PRODUCT_VERSION}`)
    || !agents.includes(expectedDescription)
    || JSON.stringify(manifestPermissions(agents)) !== JSON.stringify(REQUIRED_PERMISSIONS)) {
  fail('AIX AGENTS.md metadata or permissions mismatch');
}

const home = readText(reader, 'pages/index/index.ink');
const ride = readText(reader, 'pages/ride_hud/index.ink');
const worldAwareness = readText(reader, 'lib/aiui_world_awareness.js');
const homeDef = extractInkDef(home, 'pages/index/index.ink');
const rideDef = extractInkDef(ride, 'pages/ride_hud/index.ink');
if (!homeDef.description || homeDef.schema?.data?.type !== 'object'
    || Object.keys(homeDef.schema.data.properties || {}).length !== 0
    || 'required' in homeDef.schema.data) {
  fail('AIX Home must be a zero-argument callable page tool');
}
if ('description' in rideDef || 'schema' in rideDef) {
  fail('AIX ride_hud must remain a title-only immersive route');
}
if (homeDef.navigationBarTitleText !== 'AIBike'
    || rideDef.navigationBarTitleText !== VARIANT.rideTitle) {
  fail(`AIX page titles must use AIBike / ${VARIANT.rideTitle}`);
}

assertCanvas(home, 'pages/index/index.ink', '.home-card', 448, 150);
assertCanvas(ride, 'pages/ride_hud/index.ink', '.immersive-root', 480, 352);
assertCanvas(ride, 'pages/ride_hud/index.ink', '.hud-wrap', 480, 352);
const homeVersionSpacerWidth = pixelWidth(home, '.home-version-spacer');
const homeVersionWidth = pixelWidth(home, '.home-version');
if (!home.includes(`homeVersion: 'v${PRODUCT_VERSION}'`)
    || !/class="home-version-spacer"/.test(home)
    || !/class="home-version">\{\{\s*homeVersion\s*\}\}<\/text>/.test(home)
    || homeVersionSpacerWidth == null
    || homeVersionSpacerWidth !== homeVersionWidth) {
  fail('AIX Home must show the product version in symmetric brand slots');
}
if (!/wx\.exitMiniProgram\s*\(\s*\{\s*\}\s*\)/.test(home)) {
  fail('AIX Home exit must call wx.exitMiniProgram({}) for AIUI 0.15 host compatibility');
}
if (!home.includes('returnCard=1')
    || !home.includes('HOME_RETURN_INPUT_GUARD_MS = 800')
    || !ride.includes('writeRideFinishedHint(wx) === true')
    || !ride.includes('clearRideFinishedHint')
    || !/wx\.navigateBack\s*\(\s*\{\s*delta:\s*1\s*\}\s*\)/.test(ride)) {
  fail('AIX ride completion must return to the guarded Home conversation card');
}
if (!/wx\.exitMiniProgram\s*\(\s*\{\s*\}\s*\)/.test(ride)
    || ride.includes('this.finish()')
    || !ride.includes('bleLifecycleGeneration')
    || !ride.includes('connectAttemptId')
    || !ride.includes('isBleAttemptCurrent')
    || !ride.includes('notificationOwnerResources')
    || !ride.includes('clearRideStartTimer')
    || !ride.includes(
      'Math.max(SEARCH_DOUBLE_TAP_WINDOW_MS, GLOBAL_HOOK_DISAMBIGUATE_MS)',
    )
    || !ride.includes('CADENCE_TONE_BEATS_PER_PLAYBACK = 4')
    || !ride.includes('menuHasWorkout: false')
    || !ride.includes('const order = hasWorkout ? [0, 1, 2] : [1, 2]')
    || !ride.includes(
      'const order = this.data.menuHasWorkout === true ? [0, 1, 2] : [1, 2]',
    )
    || !ride.includes('ink:if="{{ menuHasWorkout }}"')
    || !ride.includes('this.setMenuFocus(this.data.menuHasWorkout ? 0 : 1)')
    || !ride.includes('refreshTodayWorkout({ jit: true })')
    || !ride.includes('createSportsWorkoutExecutor')
    || !ride.includes('flushSportsActivityOutbox')
    || !ride.includes('invalidateHermesLifecycle()')
    || !ride.includes('isHermesLifecycleCurrent(lifecycleGeneration)')
    || ![80, 90, 100].every(
      (rpm) => ride.includes(`metro_0468_bar_${rpm}.wav`),
    )
    || !ride.includes('[AIBike HUD] STATUS')) {
  fail('AIX ride_hud is missing AIUI 0.15 lifecycle, four-beat audio or diagnostics gates');
}
if (!ride.includes("from '../../lib/aiui_world_awareness.js'")
    || !ride.includes('this.rideOrientationSensor')
    || /\bthis\.orientationSensor\s*=/.test(ride)
    || !ride.includes('if (!owned) listeners.orientationstabilitychange = onStability;')
    || !ride.includes('if (owned) orientation.start();')
    || !worldAwareness.includes('page.enableWorldAwareness();')
    || worldAwareness.includes('enableWorldAwareness({')
    || !worldAwareness.includes('diagnostic-only')) {
  fail('AIX AIUI 0.16.0 app World Awareness compatibility must remain feature-gated, single-owner and diagnostic-only; docs/browser 0.16.1 are separate');
}
const sportsIdentity = readText(reader, 'lib/sports_identity.js');
const cyclingUpload = readText(reader, 'lib/cycling_upload.js');
const networkPolicy = readText(reader, 'lib/network_policy.js');
const sportsWorkout = readText(reader, 'lib/sports_workout.js');
const sportsOutbox = readText(reader, 'lib/sports_outbox.js');
const sportAgent = readText(reader, 'lib/sport_agent.js');
const expectedSportAgentLocale = VARIANT.locale;
if (!sportsIdentity.includes("SPORTS_APP_ID = 'aibike'")
    || !sportsIdentity.includes('aibike_sports_credential_v1')
    || !sportsWorkout.includes('/api/coach-svc/coach/aiui-sports/workouts/current')
    || !sportsWorkout.includes("'Cache-Control': 'no-store'")
    || !sportsOutbox.includes('/api/coach-svc/coach/aiui-sports/activities')
    || !sportsOutbox.includes("data.accepted !== true")
    || !sportAgent.includes('/api/coach-svc/coach/sport-agent')
    || !sportAgent.includes(`SPORT_AGENT_LOCALE = '${expectedSportAgentLocale}'`)
    || !sportAgent.includes('locale: SPORT_AGENT_LOCALE')
    || !sportAgent.includes('data.locale !== SPORT_AGENT_LOCALE')
    || !sportAgent.includes("data.locale !== SPORT_AGENT_LOCALE\n      || data.session_id !== item.session_id")
    || [...sportAgent.matchAll(/data\.locale !== SPORT_AGENT_LOCALE/g)].length !== 3
    || [...sportAgent.matchAll(/SPORT_AGENT_LOCALE = '([^']+)'/g)].length !== 1
    || !sportAgent.includes('heart_rate_bpm')
    || sportAgent.includes("['heart_zone'")
    || !ride.includes('prepareSportAgentSession')
    || !ride.includes('activateSportAgentPrestart')
    || !ride.includes('markSportAgentCompletionQueued')
    || !ride.includes('abortRecoveredSportAgent')
    || !ride.includes('migrateSportAgentHandshakeForAnonymousClaim')
    || !ride.includes('SPORT_AGENT_EVENT_INTERVAL_MS = 30000')
    || !ride.includes('flushSportAgentSessionOutbox')
    || !sportAgent.includes("SPORT_AGENT_PRESTART_KEY = 'aibike_sport_agent_prestart_v2'")
    || !sportAgent.includes("SPORT_AGENT_ACTIVE_KEY = 'aibike_sport_agent_active_v2'")
    || !sportAgent.includes('reconcileSportAgentActiveCompletion')
    || !sportAgent.includes('completion_queued')
    || sportAgent.includes('speed_min_kmh')
    || sportAgent.includes('speed_max_kmh')
    || !sportAgent.includes('workout_revision')
    || !sportAgent.includes('duration_s')
    || !sportAgent.includes('source_coverage')
    || !sportAgent.includes('max_cadence_rpm')
    || !sportAgent.includes('max_power_w')
    || !ride.includes('&& !commit.deepSportAgent')
    || !ride.includes('completion.workout_revision = commit.workoutResult.revision')
    || !ride.includes('duration_s: stage.duration_sec')
    || sportsOutbox.includes("['moving_time_sec'")
    || sportsOutbox.includes("['completed', 'stopped']")
    || !ride.includes("status: completedWorkout ? 'completed' : 'partial'")) {
  fail('AIX sports training modules violate realm, JIT workout, strict payload or ACK-only gates');
}
if (!sportsIdentity.includes("SPORTS_HERMES_BASE_URL = ''")
    || !cyclingUpload.includes("CYCLING_UPLOAD_DEFAULT_BASE_URL = ''")
    || !networkPolicy.includes('source.networkSyncEnabled === true')
    || !networkPolicy.includes("const HTTPS_PREFIX = 'https://'")
    || !ride.includes('authorizeNetworkRequest(')
    || !ride.includes("errMsg: 'offline policy'")) {
  fail('AIX public network policy must default offline with no production endpoint');
}

const license = readText(reader, 'LICENSE');
const copyright = readText(reader, 'COPYRIGHT');
if (!license.includes('# PolyForm Noncommercial License 1.0.0')
    || !copyright.includes('Required Notice: Copyright (c) 2026 Yixiao Zhu.')) {
  fail('AIX must carry the PolyForm terms and Yixiao Zhu required notice');
}

const auditedTextFiles = [
  ['AGENTS.md', agents],
  ['LICENSE', license],
  ['COPYRIGHT', copyright],
  ['assets/audio/NOTICE.md', readText(reader, 'assets/audio/NOTICE.md')],
  ['package.json', JSON.stringify(pkg)],
  ['app.json', JSON.stringify(app)],
  ['pages/index/index.ink', home],
  ['pages/ride_hud/index.ink', ride],
  ...entries
    .map((entry) => entry.name)
    .filter((name) => /^lib\/[^/]+\.js$/.test(name))
    .map((name) => [name, readText(reader, name)]),
];
for (const [file, text] of auditedTextFiles) {
  if (OLD_PRODUCT_RE.test(text)) fail(`AIX contains obsolete running copy: ${file}`);
  if (EMOJI_PATTERN.test(text)) fail(`AIX contains emoji: ${file}`);
}
const localizedRuntimeText = auditedTextFiles
  .filter(([file]) => (
    VARIANT.key === 'en' ? ENGLISH_LOCALIZED_FILES : JAPANESE_LOCALIZED_FILES
  ).includes(file))
  .map(([, text]) => text)
  .join('\n');
if (VARIANT.key === 'ja') {
  const missingJapanese = JAPANESE_REQUIRED_MARKERS.filter(
    (marker) => !localizedRuntimeText.includes(marker),
  );
  const remainingChinese = JAPANESE_FORBIDDEN_UI_COPY.filter(
    (copy) => localizedRuntimeText.includes(copy),
  );
  if (missingJapanese.length) {
    fail(`Japanese AIX is missing required UI copy: ${missingJapanese.join(', ')}`);
  }
  if (remainingChinese.length) {
    fail(`Japanese AIX contains Chinese UI fallback: ${remainingChinese.join(', ')}`);
  }
  await assertPackagedJapaneseRuntime(reader, names);
} else if (VARIANT.key === 'en') {
  const missingEnglish = ENGLISH_REQUIRED_MARKERS.filter(
    (marker) => !localizedRuntimeText.includes(marker),
  );
  const remainingLocalizedFallback = ENGLISH_FORBIDDEN_UI_COPY.filter(
    (copy) => localizedRuntimeText.includes(copy),
  );
  if (missingEnglish.length) {
    fail(`English AIX is missing required UI copy: ${missingEnglish.join(', ')}`);
  }
  if (remainingLocalizedFallback.length) {
    fail(`English AIX contains localized UI fallback: ${remainingLocalizedFallback.join(', ')}`);
  }
  await assertPackagedEnglishRuntime(reader, names);
  const purityIssues = englishRuntimePurityIssues(auditedTextFiles);
  if (purityIssues.length) {
    fail(`English AIX user-visible copy is not English-pure:\n${purityIssues.join('\n')}`);
  }
} else {
  const leakedJapanese = ['AIサイクリング', 'ライド前ストレッチ', 'テストログ保存待ち']
    .filter((copy) => `${home}\n${ride}`.includes(copy));
  if (leakedJapanese.length) {
    fail(`Chinese AIX contains Japanese UI copy: ${leakedJapanese.join(', ')}`);
  }
}
for (const [file, text] of [
  ['pages/index/index.ink', home],
  ['pages/ride_hud/index.ink', ride],
]) {
  if (/\banimation(?:-[a-z-]+)?\s*:|@keyframes\b|(?:linear|radial|conic)-gradient\s*\(/i.test(text)) {
    fail(`AIX production page contains unsupported visual motion: ${file}`);
  }
}

const pagePaths = ['pages/index/index', 'pages/ride_hud/index'];
const readerPages = reader.get_pages();
const readerTools = reader.get_tools();
const expectedPageSizes = new Map([
  ['pages/index/index', [448, 150]],
  ['pages/ride_hud/index', [480, 352]],
]);
if (JSON.stringify(readerPages.map((page) => page.name))
    !== JSON.stringify(pagePaths)) {
  fail(`AIX reader page order mismatch: ${JSON.stringify(readerPages.map((page) => page.name))}`);
}
for (const page of readerPages) {
  const expected = expectedPageSizes.get(page.name);
  if (!expected || page.size.width !== expected[0] || page.size.height !== expected[1]) {
    fail(`AIX reader page layout mismatch: ${page.name} is ${page.size.width}x${page.size.height}`);
  }
}
if (JSON.stringify(readerTools.map((tool) => tool.function.name))
    !== JSON.stringify(pagePaths)) {
  fail(`AIX reader tool order mismatch: ${JSON.stringify(readerTools.map((tool) => tool.function.name))}`);
}
const expectedToolTargets = new Map([
  ['pages/index/index', '_blank'],
  ['pages/ride_hud/index', '_current'],
]);
for (const tool of readerTools) {
  const name = tool.function.name;
  const expected = expectedPageSizes.get(name);
  if (!expected || tool.target !== expectedToolTargets.get(name)
      || tool.layout.width !== expected[0] || tool.layout.height !== expected[1]) {
    fail(`AIX reader tool layout mismatch: ${name} target=${tool.target} `
      + `layout=${tool.layout.width}x${tool.layout.height}`);
  }
}
const homeTool = readerTools.find(
  (tool) => tool.function.name === 'pages/index/index',
);
if (!homeTool
    || Object.keys(homeTool.function.parameters.properties || {}).length !== 0) {
  fail('AIX Home tool must not accept parameters');
}
const rideEntry = readerTools.find(
  (tool) => tool.function.name === 'pages/ride_hud/index',
);
if (!rideEntry
    || Object.keys(rideEntry.function.parameters?.properties || {}).length !== 0) {
  fail('AIX ride_hud reader entry must not accept callable parameters');
}
if (packagedProvenance.locale !== VARIANT.locale
    || packagedProvenance.transformVersion !== AIX_TRANSFORM_VERSIONS[VARIANT.locale]
    || !Object.values(AIX_LOCALES).includes(packagedProvenance.locale)) {
  fail('AIX provenance locale or transform version changed during inspection');
}
console.log(`AIX OK: ${path.relative(ROOT, TARGET)}`);
console.log('title: AIBike');
console.log(`product version: ${PRODUCT_VERSION}`);
console.log(`locale: ${VARIANT.locale}`);
console.log(`AIX UUID: ${aixUuid}`);
console.log(`upload size: ${(await fs.stat(TARGET)).size} bytes`);
console.log(`Craft content: ${sizeBudget.contentBytes} bytes`);
console.log(`estimated Craft final: ${sizeBudget.estimatedPlatformBytes} bytes (${sizeBudget.headroomBytes} bytes headroom)`);
console.log(`entries: ${entries.length}`);
console.log(`pages: ${pagePaths.join(', ')}`);
console.log(`reader pages: ${readerPages.length}; reader tools: ${readerTools.length}`);
console.log('visual assets: programmatic placeholders; no unverified logo or guide GIF');
console.log(
  `provenance: ${packagedProvenance.locale} / `
  + `${packagedProvenance.transformVersion} / schema `
  + `${packagedProvenance.schemaVersion}`,
);
console.log(`source tree SHA-256: ${currentSourceTreeSha256}`);
console.log(`payload tree SHA-256: ${packagedPayloadTreeSha256}`);
