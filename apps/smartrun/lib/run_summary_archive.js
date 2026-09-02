// Durable post-run archive transaction shared by immersive-only startup.
//
// The old compact launcher used to consume pending_run_summary on its onLoad.
// An immersive-first app cannot depend on that page ever being instantiated,
// so this module keeps the transaction independent from any visible surface.
// Network delivery remains a separate best-effort step: this function only
// mutates write-verified local queues.
import { enqueueAiuiRecord } from './aiui_record_queue.js';
import { enqueueLocalRunMemory } from './local_run_memory.js';
import {
  buildRunUploadPayload,
  enqueueRunUpload,
} from './run_upload.js';
import {
  RUN_SUMMARY_QUESTION,
  clearPendingRunSummary,
  fallbackRunSummary,
  finalizeRunSummaryText,
  readPendingRunSummaryState,
} from './run_summary.js';

export const RUN_SUMMARY_ARCHIVE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function result(ok, status, extra = {}) {
  return Object.freeze({ ok, status, ...extra });
}

/**
 * Consume one pending summary into local memory + the durable EverMind queue.
 *
 * The caller must prove that owner-scoped storage is currently available.
 * Keeping that proof outside the pure transaction prevents an old owner's
 * summary from being reinterpreted after bind/unbind recovery.
 */
export function archivePendingRunSummary(storage, options = {}) {
  if (options.ownerReady !== true) return result(false, 'owner_unavailable');
  const nowMs = Number.isFinite(Number(options.nowMs))
    ? Number(options.nowMs) : Date.now();
  const pendingState = readPendingRunSummaryState(storage);
  if (!pendingState.ok) {
    return result(false, 'pending_' + pendingState.status);
  }
  const pending = pendingState.summary;
  if (!pending) return result(true, 'empty');

  if (pending.endedAtMs > 0
      && nowMs - pending.endedAtMs > RUN_SUMMARY_ARCHIVE_MAX_AGE_MS) {
    return clearPendingRunSummary(storage)
      ? result(true, 'expired_cleared')
      : result(false, 'expired_clear_failed');
  }

  const quickText = fallbackRunSummary(pending);
  if (!quickText) return result(false, 'summary_invalid');
  const safe = finalizeRunSummaryText(pending, pending.text || quickText);
  const text = safe.text || quickText;
  const endedAtMs = pending.endedAtMs || nowMs;

  const memories = enqueueLocalRunMemory(
    storage,
    { ...pending, text, endedAtMs },
    nowMs,
  );
  if (!memories) return result(false, 'memory_write_failed');

  const records = enqueueAiuiRecord(storage, {
    question: RUN_SUMMARY_QUESTION,
    reply: text,
    source: 'run-summary',
    createdAtMs: endedAtMs,
  });
  if (!records) return result(false, 'record_write_failed');

  // Rebuild the canonical run queue before clearing the only replay marker.
  // enqueueRunUpload is idempotent by client_run_id, so this is safe when the
  // HUD already committed the same run before the process was interrupted.
  const elapsedMs = Number(pending.elapsedMs) || 0;
  const persistedStartMs = Number(pending.startedAtMs) || 0;
  const startMs = persistedStartMs > 0
    ? persistedStartMs
    : (endedAtMs > elapsedMs ? endedAtMs - elapsedMs : 0);
  const payload = startMs > 0 ? buildRunUploadPayload({
    startMs,
    endMs: endedAtMs,
    mode: pending.mode,
    elapsedMs,
    distanceM: pending.distanceM,
    avgPaceSecPerKm: pending.avgPaceSecPerKm,
    avgBpm: pending.avgBpm,
    maxBpm: pending.maxBpm,
    avgCadenceSpm: pending.avgCadenceSpm,
  }) : null;
  if (payload && !enqueueRunUpload(storage, payload)) {
    return result(false, 'run_queue_write_failed');
  }

  if (!clearPendingRunSummary(storage)) {
    return result(false, 'pending_clear_failed');
  }
  return result(true, 'archived', {
    text,
    memoryCount: memories.length,
    recordCount: records.length,
    runQueued: !!payload,
  });
}
