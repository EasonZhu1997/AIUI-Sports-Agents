#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  runningLocalFieldLogChecksum,
  runningLocalFieldLogUtf8Bytes,
} from '../lib/running_local_field_log.js';

const MARKER = 'SMARTRUN_LOCAL_LOG|';

function integer(value, min = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min ? number : null;
}

function parseMarkedLine(line) {
  const offset = String(line || '').indexOf(MARKER);
  if (offset < 0) return null;
  const content = String(line).slice(offset + MARKER.length);
  const separator = content.indexOf('|');
  if (separator <= 0) return null;
  const kind = content.slice(0, separator);
  if (!['BEGIN', 'CHUNK', 'END'].includes(kind)) return null;
  try {
    const value = JSON.parse(content.slice(separator + 1));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { kind, value } : null;
  } catch (_error) {
    return null;
  }
}

function finishSession(session, end) {
  const errors = [];
  const begin = session.begin;
  const runId = String(begin.run_id || '');
  const parts = integer(begin.parts, 1);
  const bytes = integer(begin.bytes, 0);
  const checksum = typeof begin.checksum === 'string' ? begin.checksum : '';
  if (!runId || parts === null || bytes === null || !checksum) {
    errors.push('invalid_begin');
  }
  if (String(end.run_id || '') !== runId
      || integer(end.parts, 1) !== parts
      || integer(end.bytes, 0) !== bytes
      || String(end.checksum || '') !== checksum) {
    errors.push('end_mismatch');
  }
  const fragments = [];
  for (let part = 1; parts !== null && part <= parts; part += 1) {
    const fragment = session.chunks.get(part);
    if (typeof fragment !== 'string') errors.push('missing_part_' + String(part));
    else fragments.push(fragment);
  }
  const payloadText = errors.length ? '' : fragments.join('');
  if (payloadText && runningLocalFieldLogUtf8Bytes(payloadText) !== bytes) {
    errors.push('byte_length_mismatch');
  }
  if (payloadText && runningLocalFieldLogChecksum(payloadText) !== checksum) {
    errors.push('checksum_mismatch');
  }
  let payload = null;
  if (!errors.length) {
    try { payload = JSON.parse(payloadText); } catch (_error) {
      errors.push('invalid_payload_json');
    }
  }
  if (payload && String(payload.run && payload.run.run_id || '') !== runId) {
    errors.push('run_id_mismatch');
    payload = null;
  }
  return {
    ok: errors.length === 0,
    run_id: runId,
    parts: parts || 0,
    bytes: bytes || 0,
    checksum,
    errors,
    ...(payload ? { payload } : {}),
  };
}

export function extractRunningLocalFieldLogReplays(text) {
  const sessions = [];
  let active = null;
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseMarkedLine(lines[index]);
    if (!parsed) continue;
    const value = parsed.value;
    if (parsed.kind === 'BEGIN') {
      active = { begin: value, chunks: new Map() };
      continue;
    }
    if (!active || String(value.run_id || '')
        !== String(active.begin.run_id || '')) continue;
    if (parsed.kind === 'CHUNK') {
      const part = integer(value.part, 1);
      const parts = integer(value.parts, 1);
      if (part === null || parts !== integer(active.begin.parts, 1)
          || typeof value.data !== 'string') continue;
      const previous = active.chunks.get(part);
      if (previous !== undefined && previous !== value.data) {
        active.chunks.set(part, null);
      } else active.chunks.set(part, value.data);
      continue;
    }
    sessions.push(finishSession(active, value));
    active = null;
  }
  return {
    schema_version: 1,
    complete_sessions: sessions.length,
    valid_sessions: sessions.filter((session) => session.ok).length,
    sessions,
  };
}

function parseCli(argv) {
  const args = argv.slice();
  const input = args.shift();
  let output = '';
  while (args.length) {
    const flag = args.shift();
    if (flag === '--out') output = args.shift() || '';
    else throw new Error('Unknown argument: ' + String(flag));
  }
  if (!input) {
    throw new Error(
      'Usage: node tools/extract_running_local_field_log.mjs '
        + '<adb-log.txt> [--out result.json]',
    );
  }
  return {
    input: path.resolve(input),
    output: output ? path.resolve(output) : '',
  };
}

export function runRunningLocalFieldLogExtractor(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  const result = extractRunningLocalFieldLogReplays(
    fs.readFileSync(options.input, 'utf8'),
  );
  const serialized = JSON.stringify(result, null, 2) + '\n';
  if (options.output) fs.writeFileSync(options.output, serialized);
  else process.stdout.write(serialized);
  if (!result.valid_sessions) process.exitCode = 2;
  return result;
}

if (process.argv[1]
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { runRunningLocalFieldLogExtractor(); } catch (error) {
    process.stderr.write(String(error && error.message ? error.message : error) + '\n');
    process.exitCode = 1;
  }
}
