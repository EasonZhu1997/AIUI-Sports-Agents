import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRunningLocalFieldLogReplayLines,
  createRunningLocalFieldLogId,
} from '../lib/running_local_field_log.js';
import {
  extractRunningLocalFieldLogReplays,
} from '../tools/extract_running_local_field_log.mjs';

const START = 1787000000000;
const RUN_ID = createRunningLocalFieldLogId(START, 'extractor1');

function replayLines() {
  return buildRunningLocalFieldLogReplayLines({
    run_id: RUN_ID,
    started_at_ms: START,
    ended_at_ms: START + 10000,
    status: 'completed',
    samples: [
      {
        captured_at_ms: START + 5000,
        elapsed_ms: 5000,
        cadence_spm: 172,
        pace_sec_per_km: 330,
        distance_m: 15,
        steps_total: 14,
        distance_source: 'imu',
        cadence_source: 'imu',
        trigger: 'ticker',
      },
      {
        captured_at_ms: START + 10000,
        elapsed_ms: 10000,
        cadence_spm: 174,
        pace_sec_per_km: 325,
        distance_m: 31,
        steps_total: 29,
        distance_source: 'imu',
        cadence_source: 'imu',
        trigger: 'finish',
      },
    ],
    events: [],
  });
}

test('从带 logcat 前缀的 BEGIN/CHUNK/END 重组并校验跑步档案', () => {
  const text = replayLines().map(
    (line, index) => `08-16 05:00:${String(index).padStart(2, '0')} I/jsai: ${line}`,
  ).join('\n');
  const result = extractRunningLocalFieldLogReplays(text);
  assert.equal(result.complete_sessions, 1);
  assert.equal(result.valid_sessions, 1);
  assert.equal(result.sessions[0].ok, true);
  assert.equal(result.sessions[0].payload.run.run_id, RUN_ID);
  assert.equal(result.sessions[0].payload.run.samples.length, 2);
});

test('缺片、篡改和跨场 END 都不能伪装成有效跑步档案', () => {
  const lines = replayLines();
  const missing = extractRunningLocalFieldLogReplays(
    lines.filter((line) => !line.includes('|CHUNK|')).join('\n'),
  );
  assert.equal(missing.valid_sessions, 0);
  assert.match(missing.sessions[0].errors.join(','), /missing_part/);

  const changed = lines.map((line) => (
    line.includes('|CHUNK|') ? line.replace('data":"', 'data":"x') : line
  ));
  const tampered = extractRunningLocalFieldLogReplays(changed.join('\n'));
  assert.equal(tampered.valid_sessions, 0);
  assert.match(tampered.sessions[0].errors.join(','), /byte_length|checksum/);

  const wrongId = createRunningLocalFieldLogId(START + 1000, 'wrongend1');
  const wrongEnd = lines.map((line) => (
    line.includes('|END|') ? line.replace(RUN_ID, wrongId) : line
  ));
  const mismatched = extractRunningLocalFieldLogReplays(wrongEnd.join('\n'));
  assert.equal(mismatched.complete_sessions, 0);
  assert.equal(mismatched.valid_sessions, 0);
});
