import assert from 'node:assert/strict';
import test from 'node:test';

import { flushPendingAiuiRecords } from '../lib/aiui_record_upload.js';
import {
  enqueueAiuiRecord,
  readPendingAiuiRecords,
} from '../lib/aiui_record_queue.js';

function storage() {
  const values = new Map();
  return {
    getStorageSync(key) { return values.get(key); },
    setStorageSync(key, value) { values.set(key, structuredClone(value)); },
    removeStorageSync(key) { values.delete(key); },
  };
}

function enqueue(wx, reply = '完成本次训练。') {
  return enqueueAiuiRecord(wx, {
    question: '本次跑步总结',
    reply,
    source: 'run-summary',
    createdAtMs: 1000,
  });
}

test('明确 ACK 后逐条删除后端待传记录', async () => {
  const wx = storage();
  enqueue(wx);
  const requests = [];
  const ok = await flushPendingAiuiRecords({
    storage: wx,
    baseUrl: 'https://coach.example',
    token: 'device-token',
    request: async (request) => {
      requests.push(request);
      return { statusCode: 200, data: { ok: true } };
    },
  });
  assert.equal(ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].header.Authorization, 'Bearer device-token');
  assert.equal(readPendingAiuiRecords(wx).length, 0);
});

test('网络失败、无 ACK 与 owner 代次变化均保留队列', async () => {
  for (const mode of ['network', 'no-ack', 'owner-changed']) {
    const wx = storage();
    enqueue(wx, mode);
    let current = true;
    const ok = await flushPendingAiuiRecords({
      storage: wx,
      token: 'device-token',
      request: async () => {
        if (mode === 'network') throw new Error('offline');
        if (mode === 'owner-changed') current = false;
        return { statusCode: 200, data: { ok: mode !== 'no-ack' } };
      },
      stillCurrent: () => current,
    });
    assert.equal(ok, false, mode);
    assert.equal(readPendingAiuiRecords(wx).length, 1, mode);
  }
});

test('401 通知调用者刷新身份且不 ACK', async () => {
  const wx = storage();
  enqueue(wx);
  let unauthorized = '';
  const ok = await flushPendingAiuiRecords({
    storage: wx,
    token: 'old-token',
    request: async () => ({ statusCode: 401, data: {} }),
    onUnauthorized: (token) => { unauthorized = token; },
  });
  assert.equal(ok, false);
  assert.equal(unauthorized, 'old-token');
  assert.equal(readPendingAiuiRecords(wx).length, 1);
});
