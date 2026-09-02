import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  normalizeWorkoutPlan,
  parseCurrentWorkoutResponse,
} from '../lib/workout_contract.js';


const CORPUS_PATH = new URL(
  './fixtures/super_coach_v2/plan_cases.v1.json',
  import.meta.url,
);
const CORPUS = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
const ENVELOPE_CORPUS_PATH = new URL(
  './fixtures/super_coach_v2/aiui_current_envelope_cases.v1.json',
  import.meta.url,
);
const ENVELOPE_CORPUS = JSON.parse(fs.readFileSync(ENVELOPE_CORPUS_PATH, 'utf8'));

function deepMerge(base, overrides) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

test('shared Super Coach corpus metadata and IDs are stable', () => {
  assert.equal(CORPUS.corpus_schema_version, 1);
  assert.equal(CORPUS.contract, 'smartrun.super_coach.plan.v2');
  assert.equal(
    CORPUS.merge_semantics,
    'recursive_objects_replace_arrays_keep_nulls_v1',
  );
  const caseIds = CORPUS.cases.map((item) => item.id);
  assert.equal(new Set(caseIds).size, caseIds.length);
  assert.deepEqual(new Set(CORPUS.cases.map((item) => item.expect)), new Set(['accept', 'reject']));
});

test('shared AIUI current-workout envelope corpus metadata and IDs are stable', () => {
  assert.equal(ENVELOPE_CORPUS.corpus_schema_version, 1);
  assert.equal(
    ENVELOPE_CORPUS.contract,
    'smartrun.super_coach.aiui-current-envelope.v1',
  );
  assert.equal(
    ENVELOPE_CORPUS.merge_semantics,
    'recursive_objects_replace_arrays_keep_nulls_v1',
  );
  const caseIds = ENVELOPE_CORPUS.cases.map((item) => item.id);
  assert.equal(new Set(caseIds).size, caseIds.length);
  assert.deepEqual(
    new Set(ENVELOPE_CORPUS.cases.map((item) => item.expect)),
    new Set(['accept', 'reject']),
  );
});

for (const contractCase of CORPUS.cases) {
  test(`shared Super Coach corpus: ${contractCase.id}`, () => {
    const raw = deepMerge(CORPUS.base_plan, contractCase.overrides);
    const parsed = normalizeWorkoutPlan(raw, CORPUS.owner, { nowMs: CORPUS.now_ms });
    if (contractCase.expect === 'accept') {
      assert.ok(parsed, `${contractCase.id} unexpectedly failed AIX parsing`);
      assert.deepEqual(parsed, raw);
    } else {
      assert.equal(parsed, null, `${contractCase.id} unexpectedly parsed on AIX`);
    }
  });
}

for (const contractCase of ENVELOPE_CORPUS.cases) {
  test(`shared AIUI envelope corpus: ${contractCase.id}`, () => {
    const raw = deepMerge(ENVELOPE_CORPUS.base_response, contractCase.overrides);
    const parsed = parseCurrentWorkoutResponse(
      { statusCode: 200, data: raw },
      ENVELOPE_CORPUS.owner,
      { nowMs: ENVELOPE_CORPUS.now_ms },
    );
    if (contractCase.expect === 'accept') {
      assert.ok(parsed, `${contractCase.id} unexpectedly failed AIX parsing`);
    } else {
      assert.equal(parsed, null, `${contractCase.id} unexpectedly parsed on AIX`);
    }
  });
}
