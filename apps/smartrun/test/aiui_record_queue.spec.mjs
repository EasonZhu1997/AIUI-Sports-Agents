import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PENDING_AIUI_RECORDS_KEY,
  PENDING_AIUI_RECORDS_MAX,
  clearPendingAiuiRecords,
  enqueueAiuiRecord,
  normalizeAiuiRecord,
  readPendingAiuiRecords,
  readPendingAiuiRecordsState,
  removePendingAiuiRecord,
  writePendingAiuiRecords,
} from '../lib/aiui_record_queue.js';

function storage() {
  const map = new Map();
  return {
    map,
    getStorageSync(key) { return map.get(key); },
    setStorageSync(key, value) { map.set(key, value); },
    removeStorageSync(key) { map.delete(key); },
  };
}

test('record normalization keeps only bounded JSON-safe fields', () => {
  assert.deepEqual(normalizeAiuiRecord({
    question: '  本次\n跑步总结 ', reply: ' 状态不错  ', source: '', createdAtMs: 123,
  }), {
    question: '本次 跑步总结', reply: '状态不错', source: 'run-summary', createdAtMs: 123,
  });
  assert.equal(normalizeAiuiRecord({ question: '', reply: 'x' }), null);
  assert.equal(normalizeAiuiRecord({ question: 'x', reply: '' }), null);
});

test('persistent queue survives reads, caps at five and clears its storage key', () => {
  const s = storage();
  for (let i = 1; i <= 7; i += 1) {
    enqueueAiuiRecord(s, { question: `q${i}`, reply: `r${i}`, createdAtMs: i });
  }
  const queue = readPendingAiuiRecords(s);
  assert.equal(queue.length, PENDING_AIUI_RECORDS_MAX);
  assert.equal(queue[0].question, 'q3');
  assert.equal(queue[4].question, 'q7');
  assert.ok(queue.every((item) => item.id), 'new queue entries have stable ids');
  clearPendingAiuiRecords(s);
  assert.equal(s.map.has(PENDING_AIUI_RECORDS_KEY), false);
});

test('ack removes from a fresh queue without erasing an item enqueued in flight', () => {
  const s = storage();
  const first = enqueueAiuiRecord(s, { question: 'q1', reply: 'r1', createdAtMs: 1 })[0];
  enqueueAiuiRecord(s, { question: 'q2', reply: 'r2', createdAtMs: 2 });
  const next = removePendingAiuiRecord(s, first);
  assert.deepEqual(next.map((item) => item.question), ['q2']);
});

test('damaged or unavailable storage degrades to an empty queue', () => {
  const s = storage();
  s.setStorageSync(PENDING_AIUI_RECORDS_KEY, 'damaged');
  assert.deepEqual(readPendingAiuiRecords(s), []);
  assert.deepEqual(readPendingAiuiRecords(null), []);
  assert.equal(writePendingAiuiRecords(null, [{ question: 'q', reply: 'r' }]), null);
});

test('corrupt or unreadable queue is unknown and enqueue never overwrites old evidence', () => {
  const corrupt = storage();
  corrupt.map.set(PENDING_AIUI_RECORDS_KEY, 'damaged-evidence');
  assert.deepEqual(readPendingAiuiRecords(corrupt), []);
  assert.equal(readPendingAiuiRecordsState(corrupt).ok, false);
  assert.equal(enqueueAiuiRecord(
    corrupt, { question: 'new', reply: 'must not replace old', createdAtMs: 11 },
  ), null);
  assert.equal(corrupt.map.get(PENDING_AIUI_RECORDS_KEY), 'damaged-evidence');

  const unreadable = storage();
  const old = [{ question: 'old', reply: 'durable', createdAtMs: 10 }];
  unreadable.map.set(PENDING_AIUI_RECORDS_KEY, old);
  unreadable.getStorageSync = () => { throw new Error('temporary read failure'); };
  assert.equal(readPendingAiuiRecordsState(unreadable).reason, 'storage_read_failed');
  assert.equal(enqueueAiuiRecord(
    unreadable, { question: 'new', reply: 'must not replace old', createdAtMs: 11 },
  ), null);
  assert.deepEqual(unreadable.map.get(PENDING_AIUI_RECORDS_KEY), old);
});

test('legacy ID migration must round-trip before queue becomes mutable', () => {
  const s = storage();
  const legacy = [{ question: '旧问题', reply: '旧回答', source: 'run-summary' }];
  s.map.set(PENDING_AIUI_RECORDS_KEY, legacy);
  s.setStorageSync = () => {};
  assert.equal(readPendingAiuiRecordsState(s).reason, 'migration_readback_failed');
  assert.equal(enqueueAiuiRecord(
    s, { question: '新问题', reply: '新回答', createdAtMs: 11 },
  ), null);
  assert.deepEqual(s.map.get(PENDING_AIUI_RECORDS_KEY), legacy);
});

test('记录队列写入和 ACK 必须写后读回，静默 no-op 时保留待传项', () => {
  const silent = storage();
  silent.setStorageSync = () => {};
  assert.equal(enqueueAiuiRecord(
    silent, { question: 'q', reply: 'r', createdAtMs: 10 },
  ), null);
  assert.deepEqual(readPendingAiuiRecords(silent), []);

  const ack = storage();
  const first = enqueueAiuiRecord(
    ack, { question: 'q', reply: 'r', createdAtMs: 10 },
  )[0];
  ack.removeStorageSync = () => {};
  assert.equal(removePendingAiuiRecord(ack, first), null);
  assert.equal(readPendingAiuiRecords(ack).length, 1, '远端 ACK 后本地删除 no-op 仍须保留重试');

  const throwing = storage();
  throwing.setStorageSync = () => { throw new Error('quota'); };
  assert.equal(enqueueAiuiRecord(
    throwing, { question: 'q', reply: 'r', createdAtMs: 10 },
  ), null);
});

test('相同稳定记录会按 id 去重，归档重试不会制造重复 AIUI 记录', () => {
  const s = storage();
  const first = enqueueAiuiRecord(
    s, { question: 'q', reply: 'r', source: 'run-summary', createdAtMs: 10 },
  );
  const second = enqueueAiuiRecord(
    s, { question: 'q', reply: 'r', source: 'run-summary', createdAtMs: 10 },
  );
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(second[0].id, first[0].id);
});

test('升级前没有 id 的记录会获得内容稳定 id 并写回，重启读取不换值', () => {
  const s = storage();
  s.map.set(PENDING_AIUI_RECORDS_KEY, [{
    question: '旧问题', reply: '旧回答', source: 'run-summary',
  }]);
  const first = readPendingAiuiRecords(s);
  const second = readPendingAiuiRecords(s);
  assert.match(first[0].id, /^air-0-[0-9a-f]{8}$/);
  assert.equal(second[0].id, first[0].id);
  assert.equal(s.map.get(PENDING_AIUI_RECORDS_KEY)[0].id, first[0].id);
});
