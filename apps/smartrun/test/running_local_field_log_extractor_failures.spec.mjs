import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRunningLocalFieldLogReplayLines,
  createRunningLocalFieldLogId,
  runningLocalFieldLogChecksum,
  runningLocalFieldLogUtf8Bytes,
} from '../lib/running_local_field_log.js';
import {
  extractRunningLocalFieldLogReplays,
} from '../tools/extract_running_local_field_log.mjs';

const START = 1787001000000;
const MARKER = 'SMARTRUN_LOCAL_LOG|';

function markedLine(kind, value) {
  return MARKER + kind + '|' + JSON.stringify(value);
}

function parsedLine(line) {
  const content = line.slice(line.indexOf(MARKER) + MARKER.length);
  const separator = content.indexOf('|');
  return {
    kind: content.slice(0, separator),
    value: JSON.parse(content.slice(separator + 1)),
  };
}

function mutateLine(line, mutate) {
  const parsed = parsedLine(line);
  return markedLine(parsed.kind, mutate({ ...parsed.value }));
}

function replayLines(offset, nonce, sampleCount = 12) {
  const startedAtMs = START + offset;
  const runId = createRunningLocalFieldLogId(startedAtMs, nonce);
  return buildRunningLocalFieldLogReplayLines({
    run_id: runId,
    started_at_ms: startedAtMs,
    ended_at_ms: startedAtMs + sampleCount * 5000,
    status: 'completed',
    samples: Array.from({ length: sampleCount }, (_, index) => ({
      captured_at_ms: startedAtMs + (index + 1) * 5000,
      elapsed_ms: (index + 1) * 5000,
      cadence_spm: 168 + (index % 4),
      pace_sec_per_km: 360 - index,
      distance_m: (index + 1) * 12,
      steps_total: (index + 1) * 14,
      distance_source: 'imu',
      cadence_source: 'imu',
      trigger: 'ticker',
    })),
    events: [],
  });
}

function rawPayloadSession(runId, payloadText) {
  const common = {
    run_id: runId,
    parts: 1,
    bytes: runningLocalFieldLogUtf8Bytes(payloadText),
    checksum: runningLocalFieldLogChecksum(payloadText),
  };
  return [
    markedLine('BEGIN', common),
    markedLine('CHUNK', {
      run_id: runId,
      part: 1,
      parts: 1,
      data: payloadText,
    }),
    markedLine('END', common),
  ];
}

test('空输入、无关日志和非法 marker JSON 都安全返回空结果', () => {
  for (const text of [
    '',
    'ordinary logcat output',
    [
      'SMARTRUN_LOCAL_LOG|BEGIN|not-json',
      'SMARTRUN_LOCAL_LOG|CHUNK|[]',
      'SMARTRUN_LOCAL_LOG|UNKNOWN|{}',
      'SMARTRUN_LOCAL_LOG|END|null',
    ].join('\n'),
  ]) {
    assert.deepEqual(extractRunningLocalFieldLogReplays(text), {
      schema_version: 1,
      complete_sessions: 0,
      valid_sessions: 0,
      sessions: [],
    });
  }
});

test('相同重复片可幂等接受，冲突重复片必须判为缺片', () => {
  const lines = replayLines(0, 'duplicate1');
  const chunkIndex = lines.findIndex((line) => line.includes('|CHUNK|'));
  const exactDuplicate = [
    ...lines.slice(0, chunkIndex + 1),
    lines[chunkIndex],
    ...lines.slice(chunkIndex + 1),
  ];
  const exact = extractRunningLocalFieldLogReplays(exactDuplicate.join('\n'));
  assert.equal(exact.complete_sessions, 1);
  assert.equal(exact.valid_sessions, 1);

  const conflict = mutateLine(lines[chunkIndex], (value) => ({
    ...value,
    data: value.data + 'conflict',
  }));
  const conflictingDuplicate = [
    ...lines.slice(0, chunkIndex + 1),
    conflict,
    ...lines.slice(chunkIndex + 1),
  ];
  const rejected = extractRunningLocalFieldLogReplays(
    conflictingDuplicate.join('\n'),
  );
  assert.equal(rejected.complete_sessions, 1);
  assert.equal(rejected.valid_sessions, 0);
  assert.match(rejected.sessions[0].errors.join(','), /missing_part_/);
});

test('乱序 CHUNK 按 part 重组，不按日志到达顺序拼接', () => {
  const lines = replayLines(1000, 'outorder1');
  const begin = lines[0];
  const end = lines.at(-1);
  const chunks = lines.slice(1, -1);
  assert.ok(chunks.length > 1, '测试档案必须跨多个 CHUNK');
  const result = extractRunningLocalFieldLogReplays(
    [begin, ...chunks.reverse(), end].join('\n'),
  );
  assert.equal(result.complete_sessions, 1);
  assert.equal(result.valid_sessions, 1);
  assert.equal(result.sessions[0].payload.run.samples.length, 12);
});

test('非法 Base64 外观和截断 JSON 都不能成为有效 payload', () => {
  const malformedPayloads = [
    '%%%not-base64%%%',
    '{"schema_version":1,"run":',
  ];
  for (let index = 0; index < malformedPayloads.length; index += 1) {
    const runId = createRunningLocalFieldLogId(
      START + 2000 + index,
      'badpayload' + String(index),
    );
    const result = extractRunningLocalFieldLogReplays(
      rawPayloadSession(runId, malformedPayloads[index]).join('\n'),
    );
    assert.equal(result.complete_sessions, 1);
    assert.equal(result.valid_sessions, 0);
    assert.deepEqual(result.sessions[0].errors, ['invalid_payload_json']);
  }
});

test('BEGIN 字段非法、END 元数据不匹配和跨 run END 都不能通过', () => {
  const invalidBegin = {
    run_id: '',
    parts: 1,
    bytes: 2,
    checksum: 'deadbeef',
  };
  const beginResult = extractRunningLocalFieldLogReplays([
    markedLine('BEGIN', invalidBegin),
    markedLine('CHUNK', {
      run_id: '', part: 1, parts: 1, data: '{}',
    }),
    markedLine('END', invalidBegin),
  ].join('\n'));
  assert.equal(beginResult.complete_sessions, 1);
  assert.equal(beginResult.valid_sessions, 0);
  assert.ok(beginResult.sessions[0].errors.includes('invalid_begin'));

  const lines = replayLines(3000, 'endmismatch1');
  const mismatchedEnd = mutateLine(lines.at(-1), (value) => ({
    ...value,
    bytes: value.bytes + 1,
  }));
  const metadataMismatch = extractRunningLocalFieldLogReplays(
    [...lines.slice(0, -1), mismatchedEnd].join('\n'),
  );
  assert.equal(metadataMismatch.complete_sessions, 1);
  assert.equal(metadataMismatch.valid_sessions, 0);
  assert.ok(metadataMismatch.sessions[0].errors.includes('end_mismatch'));

  const otherRunId = createRunningLocalFieldLogId(START + 4000, 'otherend1');
  const crossRunEnd = mutateLine(lines.at(-1), (value) => ({
    ...value,
    run_id: otherRunId,
  }));
  const ignored = extractRunningLocalFieldLogReplays(
    [...lines.slice(0, -1), crossRunEnd].join('\n'),
  );
  assert.equal(ignored.complete_sessions, 0);
  assert.equal(ignored.valid_sessions, 0);
});

test('多会话隔离统计：坏会话不污染前后两个有效会话', () => {
  const first = replayLines(5000, 'multisess1', 2);
  const broken = replayLines(6000, 'multisess2', 2);
  const last = replayLines(7000, 'multisess3', 2);
  broken[1] = mutateLine(broken[1], (value) => ({
    ...value,
    data: value.data.slice(0, -1) + 'x',
  }));
  const result = extractRunningLocalFieldLogReplays(
    [...first, ...broken, ...last].join('\n'),
  );
  assert.equal(result.complete_sessions, 3);
  assert.equal(result.valid_sessions, 2);
  assert.deepEqual(result.sessions.map((session) => session.ok), [true, false, true]);
  assert.match(result.sessions[1].errors.join(','), /checksum|byte_length/);
  assert.equal(result.sessions[0].payload.run.samples.length, 2);
  assert.equal(result.sessions[2].payload.run.samples.length, 2);
});

test('END 之前没有匹配 BEGIN、以及悬空 BEGIN 都不会计为完整会话', () => {
  const lines = replayLines(8000, 'dangling1', 2);
  const endFirst = extractRunningLocalFieldLogReplays(
    [lines.at(-1), ...lines.slice(0, -1)].join('\n'),
  );
  assert.equal(endFirst.complete_sessions, 0);
  assert.equal(endFirst.valid_sessions, 0);

  const dangling = extractRunningLocalFieldLogReplays(
    lines.slice(0, -1).join('\n'),
  );
  assert.equal(dangling.complete_sessions, 0);
  assert.equal(dangling.valid_sessions, 0);
});
