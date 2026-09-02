import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCyclingLocalFieldLogReplayLines,
} from '../lib/cycling_local_field_log.js';
import {
  extractCyclingLocalFieldLogReplays,
} from '../tools/extract_local_field_log.mjs';

const RIDE_ID = 'ride-abcdef12-123456789012';
const START = 1786660800000;

function replayLines() {
  return buildCyclingLocalFieldLogReplayLines({
    ride_id: RIDE_ID,
    started_at_ms: START,
    ended_at_ms: START + 3000,
    status: 'completed',
    samples: [
      {
        captured_at_ms: START + 1000,
        elapsed_ms: 1000,
        distance_m: 2.5,
        distance_coverage_ms: 1000,
        speed_kmh: 9,
        speed_source: 'imu',
        speed_state: 'live',
      },
      {
        captured_at_ms: START + 2000,
        elapsed_ms: 2000,
        distance_m: 5,
        distance_coverage_ms: 2000,
        speed_kmh: 9,
        speed_source: 'imu',
        speed_state: 'live',
      },
    ],
    lifecycle: [],
    tts: [],
    uploads: [],
  });
}

test('从带 logcat 前缀的 BEGIN/CHUNK/END 完整重组本地日志并校验', () => {
  const text = replayLines().map(
    (line, index) => `08-14 12:30:${String(index).padStart(2, '0')} I/jsai: ${line}`,
  ).join('\n');
  const result = extractCyclingLocalFieldLogReplays(text);
  assert.equal(result.complete_sessions, 1);
  assert.equal(result.valid_sessions, 1);
  assert.equal(result.sessions[0].ok, true);
  assert.equal(result.sessions[0].payload.ride.ride_id, RIDE_ID);
  assert.equal(result.sessions[0].payload.ride.samples.length, 2);
});

test('缺片、篡改或不同场次尾标不能伪装成可用日志', () => {
  const lines = replayLines();
  const missing = extractCyclingLocalFieldLogReplays(
    lines.filter((line) => !line.includes('|CHUNK|')).join('\n'),
  );
  assert.equal(missing.valid_sessions, 0);
  assert.match(missing.sessions[0].errors.join(','), /missing_part/);

  const changed = lines.map((line) => (
    line.includes('|CHUNK|') ? line.replace('data":"', 'data":"x') : line
  ));
  const tampered = extractCyclingLocalFieldLogReplays(changed.join('\n'));
  assert.equal(tampered.valid_sessions, 0);
  assert.match(tampered.sessions[0].errors.join(','), /byte_length|checksum/);

  const wrongEnd = lines.map((line) => (
    line.includes('|END|') ? line.replace(RIDE_ID, 'ride-deadbeef-123456789012') : line
  ));
  const mismatched = extractCyclingLocalFieldLogReplays(wrongEnd.join('\n'));
  assert.equal(mismatched.complete_sessions, 0);
  assert.equal(mismatched.valid_sessions, 0);
});
