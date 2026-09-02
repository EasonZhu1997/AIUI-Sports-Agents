import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RUN_SUMMARY_ARCHIVE_MAX_AGE_MS,
  archivePendingRunSummary,
} from '../lib/run_summary_archive.js';
import { readPendingAiuiRecords } from '../lib/aiui_record_queue.js';
import { readLocalRunMemories } from '../lib/local_run_memory.js';
import { readPendingRunUploads } from '../lib/run_upload.js';
import {
  readPendingRunSummary,
  readPendingRunSummaryState,
  writePendingRunSummary,
} from '../lib/run_summary.js';

function storage(options = {}) {
  const values = new Map();
  return {
    getStorageSync(key) {
      if (options.throwGetKey === key) throw new Error('read failed');
      return values.get(key);
    },
    setStorageSync(key, value) {
      if (options.noopKey === key) return;
      values.set(key, structuredClone(value));
    },
    removeStorageSync(key) {
      if (options.noopRemoveKey === key) return;
      values.delete(key);
    },
  };
}

function summary(endedAtMs = 80_000) {
  return {
    mode: 'free',
    startedAtMs: 10_000,
    endedAtMs,
    elapsedMs: 70_000,
    distanceM: 200,
    avgPaceSecPerKm: 400,
    avgBpm: 132,
    maxBpm: 145,
    avgCadenceSpm: 168,
    text: '完成本次训练。',
  };
}

test('沉浸首屏后台归档总结、记忆、EverMind 与 canonical run 队列', () => {
  const wx = storage();
  assert.ok(writePendingRunSummary(wx, summary()));
  const archived = archivePendingRunSummary(wx, {
    ownerReady: true,
    nowMs: 81_000,
  });
  assert.equal(archived.ok, true);
  assert.equal(archived.status, 'archived');
  assert.equal(readPendingRunSummary(wx), null);
  assert.equal(readLocalRunMemories(wx).length, 1);
  assert.equal(readPendingAiuiRecords(wx).length, 1);
  assert.equal(readPendingRunUploads(wx).length, 1);
});

test('owner 未证明时不读取或消费旧总结', () => {
  const wx = storage();
  assert.ok(writePendingRunSummary(wx, summary()));
  const archived = archivePendingRunSummary(wx, { ownerReady: false });
  assert.equal(archived.status, 'owner_unavailable');
  assert.ok(readPendingRunSummary(wx));
  assert.equal(readLocalRunMemories(wx).length, 0);
});

test('任何写后读回失败都保留 pending summary 供下次幂等重放', () => {
  const wx = storage({ noopKey: 'local_run_memories' });
  assert.ok(writePendingRunSummary(wx, summary()));
  const archived = archivePendingRunSummary(wx, {
    ownerReady: true,
    nowMs: 21_000,
  });
  assert.equal(archived.status, 'memory_write_failed');
  assert.ok(readPendingRunSummary(wx));
});

test('超过12小时的陈年待办只在删除读回成功后清理', () => {
  const endedAtMs = 80_000;
  const wx = storage();
  assert.ok(writePendingRunSummary(wx, summary(endedAtMs)));
  const archived = archivePendingRunSummary(wx, {
    ownerReady: true,
    nowMs: endedAtMs + RUN_SUMMARY_ARCHIVE_MAX_AGE_MS + 1,
  });
  assert.equal(archived.status, 'expired_cleared');
  assert.equal(readPendingRunSummary(wx), null);

  const stuck = storage({ noopRemoveKey: 'pending_run_summary' });
  assert.ok(writePendingRunSummary(stuck, summary(endedAtMs)));
  const failed = archivePendingRunSummary(stuck, {
    ownerReady: true,
    nowMs: endedAtMs + RUN_SUMMARY_ARCHIVE_MAX_AGE_MS + 1,
  });
  assert.equal(failed.status, 'expired_clear_failed');
  assert.ok(readPendingRunSummary(stuck));
});

test('待办读取异常或损坏时 fail closed，不得伪装为空并继续归档', () => {
  const controls = {};
  const unreadable = storage(controls);
  assert.ok(writePendingRunSummary(unreadable, summary()));
  controls.throwGetKey = 'pending_run_summary';
  const unreadableState = readPendingRunSummaryState(unreadable);
  assert.equal(unreadableState.ok, false);
  assert.equal(unreadableState.status, 'read_failed');
  const failed = archivePendingRunSummary(unreadable, {
    ownerReady: true,
    nowMs: 81_000,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'pending_read_failed');

  const corrupt = storage();
  corrupt.setStorageSync('pending_run_summary', { elapsedMs: 0, endedAtMs: 80_000 });
  const corruptState = readPendingRunSummaryState(corrupt);
  assert.equal(corruptState.ok, false);
  assert.equal(corruptState.status, 'corrupt');
  const rejected = archivePendingRunSummary(corrupt, {
    ownerReady: true,
    nowMs: 81_000,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 'pending_corrupt');
});
