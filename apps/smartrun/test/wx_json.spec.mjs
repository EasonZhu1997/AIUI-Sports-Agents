import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeWxJsonResponse, isJsonObjectResponse,
} from '../lib/wx_json.js';

test('AIUI ArrayBuffer JSON response is decoded defensively', () => {
  const bytes = new TextEncoder().encode(JSON.stringify({
    aiui_id: 'A7K2M9Q4', label: '跑步',
  }));
  const response = normalizeWxJsonResponse({ statusCode: 200, data: bytes.buffer });
  assert.deepEqual(response.data, { aiui_id: 'A7K2M9Q4', label: '跑步' });
  assert.equal(isJsonObjectResponse(response), true);
});

test('AIUI text JSON is parsed, invalid text remains diagnosable', () => {
  const parsed = normalizeWxJsonResponse({ statusCode: 200, data: '{"ok":true}' });
  assert.deepEqual(parsed.data, { ok: true });
  assert.equal(isJsonObjectResponse(parsed), true);

  const invalid = normalizeWxJsonResponse({ statusCode: 200, data: 'not-json' });
  assert.equal(invalid.data, 'not-json');
  assert.equal(isJsonObjectResponse(invalid), false);
});

test('AIUI typed-array views and the no-TextDecoder fallback preserve UTF-8 JSON', () => {
  const encoded = new TextEncoder().encode('xx{"label":"跑步🏃"}yy');
  const view = new Uint8Array(encoded.buffer, 2, encoded.byteLength - 4);
  const originalTextDecoder = globalThis.TextDecoder;
  globalThis.TextDecoder = class BrokenTextDecoder {
    decode() {
      throw new Error('old host decoder unavailable');
    }
  };
  try {
    const response = normalizeWxJsonResponse({ statusCode: 200, data: view });
    assert.deepEqual(response.data, { label: '跑步🏃' });
    assert.equal(isJsonObjectResponse(response), true);
  } finally {
    globalThis.TextDecoder = originalTextDecoder;
  }
});

test('AIUI JSON normalizer is identity-safe for objects, blanks and malformed bytes', () => {
  const objectResponse = { statusCode: 200, data: { ok: true } };
  assert.equal(normalizeWxJsonResponse(objectResponse), objectResponse);
  assert.equal(isJsonObjectResponse(objectResponse), true);

  for (const value of [null, undefined, 0, false, [], '   ']) {
    const response = { statusCode: 200, data: value };
    assert.equal(normalizeWxJsonResponse(response), response);
    assert.equal(isJsonObjectResponse(response), false);
  }
  assert.equal(normalizeWxJsonResponse(null), null);
  assert.equal(normalizeWxJsonResponse('raw'), 'raw');

  const malformedInputs = [
    new Uint8Array([0xff]),
    new Uint8Array([0xe8, 0xb7]),
    new Uint8Array([0xe8, 0x20, 0x80]),
  ];
  const originalTextDecoder = globalThis.TextDecoder;
  globalThis.TextDecoder = undefined;
  try {
    for (const malformed of malformedInputs) {
      const response = { statusCode: 200, data: malformed };
      assert.equal(normalizeWxJsonResponse(response), response);
      assert.equal(isJsonObjectResponse(response), false);
    }
  } finally {
    globalThis.TextDecoder = originalTextDecoder;
  }
});
