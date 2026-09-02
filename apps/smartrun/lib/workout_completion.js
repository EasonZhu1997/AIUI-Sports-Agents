// Durable, idempotent Super Coach completion queue. Payloads are rebuilt from
// an explicit allowlist so raw sensor, route and credential fields cannot leak.

import { DEFAULT_BASE_URL, normalizeBaseUrl } from './coach_api.js';
import {
  normalizeWorkoutOwner,
  PLAN_SESSION_ID_RE,
  sameWorkoutOwner,
  WORKOUT_ID_RE,
  WORKOUT_STAGE_ID_RE,
} from './workout_contract.js';
import { normalizeWxJsonResponse } from './wx_json.js';

export const WORKOUT_COMPLETION_QUEUE_KEY = 'pending_workout_completions_v2';
export const WORKOUT_COMPLETION_QUEUE_STATE_KEY =
  'pending_workout_completions_state_v1';
export const WORKOUT_COMPLETION_QUEUE_MAX = 32;
export const WORKOUT_COMPLETION_QUARANTINE_KEY =
  'quarantined_workout_completions_v1';
export const WORKOUT_COMPLETION_QUARANTINE_STATE_KEY =
  'quarantined_workout_completions_state_v1';
export const WORKOUT_COMPLETION_QUARANTINE_MAX = 32;
export const WORKOUT_COMPLETION_PATH_PREFIX =
  '/api/coach-svc/coach/aiui-workouts/';

const ID_RE = /^[A-Za-z0-9._:-]{8,80}$/;
const EXECUTION_STATUSES = new Set(['completed', 'partial', 'aborted']);
const STAGE_STATUSES = new Set(['completed', 'partial', 'skipped']);

function integer(value, min, max) {
  const rounded = typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value) : NaN;
  return Number.isInteger(rounded) && rounded >= min && rounded <= max ? rounded : null;
}

function iso(value) {
  const date = typeof value === 'number' ? new Date(value) : new Date(value || '');
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function normalizeOptionalInt(target, source, key, min, max) {
  if (source[key] == null) return true;
  const value = integer(source[key], min, max);
  if (value === null) return false;
  target[key] = value;
  return true;
}

function normalizeStageResult(raw, allowedStageIds) {
  if (!raw || typeof raw !== 'object' || !WORKOUT_STAGE_ID_RE.test(raw.stage_id)
      || !allowedStageIds.has(raw.stage_id)
      || !STAGE_STATUSES.has(raw.status)) return null;
  const duration = integer(raw.duration_s, 0, 86_400);
  const distance = integer(raw.distance_m, 0, 200_000);
  if (duration === null || distance === null) return null;
  const result = {
    stage_id: raw.stage_id,
    status: raw.status,
    duration_s: duration,
    distance_m: distance,
  };
  if (!normalizeOptionalInt(result, raw, 'avg_pace_s', 60, 7_200)
      || !normalizeOptionalInt(result, raw, 'avg_hr', 20, 240)
      || !normalizeOptionalInt(result, raw, 'cadence_avg', 0, 300)) return null;
  return result;
}

function normalizeAllowedStageIds(raw) {
  if (!Array.isArray(raw) || !raw.length
      || raw.some((value) => typeof value !== 'string'
        || !WORKOUT_STAGE_ID_RE.test(value))) return null;
  if (new Set(raw).size !== raw.length) return null;
  return raw.slice();
}

function hashText(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function createWorkoutClientRunId(execution) {
  const start = Math.max(0, Math.trunc(execution && execution.started_at_ms || Date.now()));
  const source = String(execution && execution.client_execution_id || '') + ':' + start;
  return 'run-workout-' + start.toString(36) + '-' + hashText(source);
}

export function normalizeWorkoutCompletion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const workoutId = typeof raw.workout_id === 'string' ? raw.workout_id : '';
  const planSessionId = typeof raw.plan_session_id === 'string'
    ? raw.plan_session_id : '';
  if (!WORKOUT_ID_RE.test(workoutId) || !PLAN_SESSION_ID_RE.test(planSessionId)
      || !ID_RE.test(String(raw.client_execution_id || ''))
      || !ID_RE.test(String(raw.client_run_id || ''))
      || !EXECUTION_STATUSES.has(raw.status)) return null;
  const revision = integer(raw.revision, 1, 1_000_000_000);
  const duration = integer(raw.duration_s, raw.status === 'aborted' ? 0 : 1, 86_400);
  const distance = integer(raw.distance_m, 0, 200_000);
  const startedAt = iso(raw.started_at);
  const endedAt = iso(raw.ended_at);
  const normalizedAllowedIds = normalizeAllowedStageIds(raw.allowed_stage_ids);
  const allowedIds = new Set(normalizedAllowedIds || []);
  if (revision === null || duration === null || distance === null
      || !startedAt || !endedAt || Date.parse(endedAt) < Date.parse(startedAt)
      || !allowedIds.size || !Array.isArray(raw.stage_results)) return null;
  const stageResults = raw.stage_results.map((item) => normalizeStageResult(item, allowedIds));
  if (stageResults.some((item) => !item)
      || new Set(stageResults.map((item) => item.stage_id)).size !== stageResults.length) return null;
  const result = {
    workout_id: workoutId,
    plan_session_id: planSessionId,
    client_execution_id: raw.client_execution_id,
    client_run_id: raw.client_run_id,
    revision,
    status: raw.status,
    started_at: startedAt,
    ended_at: endedAt,
    duration_s: duration,
    distance_m: distance,
    stage_results: stageResults,
  };
  if (!normalizeOptionalInt(result, raw, 'avg_pace_s', 60, 7_200)
      || !normalizeOptionalInt(result, raw, 'avg_hr', 20, 240)
      || !normalizeOptionalInt(result, raw, 'max_hr', 20, 240)
      || !normalizeOptionalInt(result, raw, 'cadence_avg', 0, 300)) return null;
  if (result.avg_hr != null && result.max_hr != null && result.max_hr < result.avg_hr) {
    result.max_hr = result.avg_hr;
  }
  return result;
}

export function buildWorkoutCompletion({ execution, summary = {}, clientRunId } = {}) {
  if (!execution || execution.status !== 'finished' || !execution.plan) return null;
  const allowedStageIds = execution.plan.stages.map((stage) => stage.stage_id);
  const requestedDuration = summary.duration_s ?? summary.durationS
    ?? execution.active_elapsed_ms / 1000;
  const candidate = {
    workout_id: execution.plan.workout_id,
    plan_session_id: execution.plan.plan_session_id,
    client_execution_id: execution.client_execution_id,
    client_run_id: ID_RE.test(String(clientRunId || ''))
      ? clientRunId : createWorkoutClientRunId(execution),
    revision: execution.plan.revision,
    status: execution.outcome,
    started_at: execution.started_at_ms,
    ended_at: execution.ended_at_ms,
    duration_s: execution.outcome === 'aborted'
      ? requestedDuration : Math.max(1, Number(requestedDuration) || 0),
    distance_m: summary.distance_m ?? summary.distanceM ?? 0,
    avg_pace_s: summary.avg_pace_s ?? summary.avgPaceSecPerKm,
    avg_hr: summary.avg_hr ?? summary.avgBpm,
    max_hr: summary.max_hr ?? summary.maxBpm,
    cadence_avg: summary.cadence_avg ?? summary.avgCadenceSpm,
    stage_results: execution.stage_results,
    allowed_stage_ids: allowedStageIds,
  };
  return normalizeWorkoutCompletion(candidate);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  try { return JSON.stringify(value); } catch (_error) { return ''; }
}

function storageStateRecord(targetKey, value) {
  const committedValue = clone(value);
  const json = stableJson(committedValue);
  return {
    schema_version: 1,
    target_key: targetKey,
    value_digest: hashText(json),
    committed_value: committedValue,
  };
}

function normalizeStorageStateRecord(raw, targetKey) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || raw.schema_version !== 1 || raw.target_key !== targetKey
      || typeof raw.value_digest !== 'string'
      || !Object.prototype.hasOwnProperty.call(raw, 'committed_value')) return null;
  const json = stableJson(raw.committed_value);
  if (!json || hashText(json) !== raw.value_digest) return null;
  return clone(raw.committed_value);
}

function readSyncState(storage, key) {
  if (!storage || typeof storage.getStorageSync !== 'function') {
    return { ok: false, found: false, value: undefined, reason: 'storage_unavailable' };
  }
  try {
    const first = storage.getStorageSync(key);
    if (first !== undefined) return { ok: true, found: true, value: first, reason: '' };
    const second = storage.getStorageSync(key);
    return second === undefined
      ? { ok: true, found: false, value: undefined, reason: '' }
      : { ok: true, found: true, value: second, reason: '' };
  } catch (_error) {
    return { ok: false, found: false, value: undefined, reason: 'storage_read_failed' };
  }
}

function isKeyNotFound(error) {
  return !!error && typeof error.errMsg === 'string'
    && error.errMsg.trim().toLowerCase() === 'key not found';
}

function readExactKeyImmediate(storage, key) {
  if (!storage || typeof storage.getStorage !== 'function') {
    return { complete: false, ok: false, found: false, value: undefined };
  }
  const result = { complete: false, ok: false, found: false, value: undefined };
  try {
    storage.getStorage({
      key,
      success(response) {
        result.complete = true;
        result.ok = !!response && Object.prototype.hasOwnProperty.call(response, 'data');
        result.found = result.ok;
        result.value = result.ok ? response.data : undefined;
      },
      fail(error) {
        result.complete = true;
        result.ok = isKeyNotFound(error);
        result.found = false;
      },
    });
  } catch (_error) {
    result.complete = true;
  }
  return result;
}

function readExactKey(storage, key, timeoutMs = 1200) {
  return new Promise((resolve) => {
    if (!storage || typeof storage.getStorage !== 'function') {
      resolve({ ok: false, found: false, value: undefined, reason: 'storage_unavailable' });
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish({
      ok: false, found: false, value: undefined, reason: 'storage_read_timeout',
    }), timeoutMs);
    try {
      storage.getStorage({
        key,
        success(response) {
          if (!response || !Object.prototype.hasOwnProperty.call(response, 'data')) {
            finish({ ok: false, found: false, value: undefined, reason: 'storage_read_failed' });
            return;
          }
          finish({ ok: true, found: true, value: response.data, reason: '' });
        },
        fail(error) {
          finish(isKeyNotFound(error)
            ? { ok: true, found: false, value: undefined, reason: '' }
            : { ok: false, found: false, value: undefined, reason: 'storage_read_failed' });
        },
      });
    } catch (_error) {
      finish({ ok: false, found: false, value: undefined, reason: 'storage_read_failed' });
    }
  });
}

function writeDurableValue(storage, targetKey, stateKey, value) {
  if (!storage || typeof storage.setStorageSync !== 'function'
      || typeof storage.getStorageSync !== 'function') return false;
  const next = clone(value);
  const record = storageStateRecord(targetKey, next);
  try {
    const targetBefore = readSyncState(storage, targetKey);
    const stateBefore = readSyncState(storage, stateKey);
    if (!targetBefore.ok || !stateBefore.ok) return false;
    if (stateBefore.found) {
      const committed = normalizeStorageStateRecord(stateBefore.value, targetKey);
      if (committed === null || !targetBefore.found
          || stableJson(targetBefore.value) !== stableJson(committed)) return false;
    }
    storage.setStorageSync(targetKey, next);
    const targetAfter = readSyncState(storage, targetKey);
    if (!targetAfter.ok || !targetAfter.found
        || stableJson(targetAfter.value) !== stableJson(next)) return false;
    storage.setStorageSync(stateKey, record);
    const stateAfter = readSyncState(storage, stateKey);
    return stateAfter.ok && stateAfter.found
      && stableJson(stateAfter.value) === stableJson(record);
  } catch (_error) {
    return false;
  }
}

function writeDurableStateOnly(storage, targetKey, stateKey, value) {
  if (!storage || typeof storage.setStorageSync !== 'function'
      || typeof storage.getStorageSync !== 'function') return false;
  const record = storageStateRecord(targetKey, value);
  try {
    storage.setStorageSync(stateKey, record);
    const stateAfter = readSyncState(storage, stateKey);
    return stateAfter.ok && stateAfter.found
      && stableJson(stateAfter.value) === stableJson(record);
  } catch (_error) {
    return false;
  }
}

function writeDurableTargetOnly(storage, targetKey, value) {
  if (!storage || typeof storage.setStorageSync !== 'function'
      || typeof storage.getStorageSync !== 'function') return false;
  const next = clone(value);
  try {
    storage.setStorageSync(targetKey, next);
    const targetAfter = readSyncState(storage, targetKey);
    return targetAfter.ok && targetAfter.found
      && stableJson(targetAfter.value) === stableJson(next);
  } catch (_error) {
    return false;
  }
}

function forceWriteDurableValue(storage, targetKey, stateKey, value) {
  if (!writeDurableTargetOnly(storage, targetKey, value)) return false;
  if (!writeDurableStateOnly(storage, targetKey, stateKey, value)) return false;
  const target = readSyncState(storage, targetKey);
  const state = readSyncState(storage, stateKey);
  const committed = state.ok && state.found
    ? normalizeStorageStateRecord(state.value, targetKey) : null;
  return target.ok && target.found && committed !== null
    && stableJson(target.value) === stableJson(value)
    && stableJson(committed) === stableJson(value);
}

function resolveExactPair(storage, targetKey, stateKey, targetExact, stateExact) {
  if (!targetExact.complete || !stateExact.complete
      || !targetExact.ok || !stateExact.ok) {
    return { ok: false, value: undefined, reason: 'storage_initialization_required' };
  }
  if (stateExact.found) {
    const committed = normalizeStorageStateRecord(stateExact.value, targetKey);
    if (committed === null) {
      return { ok: false, value: undefined, reason: 'storage_state_invalid' };
    }
    if (targetExact.found
        && stableJson(targetExact.value) !== stableJson(committed)) {
      return { ok: false, value: undefined, reason: 'storage_state_conflict' };
    }
    return { ok: true, value: committed, reason: '' };
  }
  if (targetExact.found) {
    return { ok: true, value: targetExact.value, reason: 'legacy' };
  }
  if (!writeDurableValue(storage, targetKey, stateKey, [])) {
    return { ok: false, value: undefined, reason: 'storage_initialization_failed' };
  }
  return { ok: true, value: [], reason: '' };
}

function readDurableValueState(storage, targetKey, stateKey) {
  const target = readSyncState(storage, targetKey);
  const state = readSyncState(storage, stateKey);
  if (state.ok && state.found) {
    const committed = normalizeStorageStateRecord(state.value, targetKey);
    if (committed === null) {
      return { ok: false, value: undefined, reason: 'storage_state_invalid' };
    }
    if (!target.ok) {
      return { ok: false, value: undefined, reason: target.reason };
    }
    if (!target.found) {
      return { ok: true, value: committed, reason: 'mirror_recovery' };
    }
    return stableJson(target.value) === stableJson(committed)
      ? { ok: true, value: committed, reason: '' }
      : { ok: false, value: undefined, reason: 'storage_state_conflict' };
  }
  if (state.ok && !state.found && target.ok && target.found) {
    return { ok: true, value: target.value, reason: 'legacy' };
  }
  if (!state.ok && target.ok && target.found) {
    return { ok: false, value: undefined, reason: state.reason };
  }
  const targetExact = readExactKeyImmediate(storage, targetKey);
  const stateExact = readExactKeyImmediate(storage, stateKey);
  return resolveExactPair(storage, targetKey, stateKey, targetExact, stateExact);
}

async function initializeDurableValue(storage, targetKey, stateKey) {
  const [target, state] = await Promise.all([
    readExactKey(storage, targetKey),
    readExactKey(storage, stateKey),
  ]);
  if (!target.ok || !state.ok) return false;
  const resolved = resolveExactPair(
    storage,
    targetKey,
    stateKey,
    { complete: true, ...target },
    { complete: true, ...state },
  );
  if (!resolved.ok) return false;
  // A valid committed mirror is authoritative when the exact async read proves
  // that only the target key is missing. Restore the target before declaring
  // the pair ready; later ACK/mutation paths deliberately refuse a mirror-only
  // transaction because they cannot prove a write did not discard old FIFO data.
  if (state.found && !target.found) {
    return writeDurableTargetOnly(storage, targetKey, resolved.value);
  }
  if (!state.found && target.found) {
    return writeDurableStateOnly(storage, targetKey, stateKey, resolved.value);
  }
  return true;
}

export async function initializeWorkoutCompletionStorage(storage) {
  const results = await Promise.all([
    initializeDurableValue(
      storage,
      WORKOUT_COMPLETION_QUEUE_KEY,
      WORKOUT_COMPLETION_QUEUE_STATE_KEY,
    ),
    initializeDurableValue(
      storage,
      WORKOUT_COMPLETION_QUARANTINE_KEY,
      WORKOUT_COMPLETION_QUARANTINE_STATE_KEY,
    ),
  ]);
  return results.every(Boolean);
}

function ownerPairIsContinuous(previousOwner, nextOwner) {
  const previous = normalizeWorkoutOwner(previousOwner);
  const next = normalizeWorkoutOwner(nextOwner);
  return !!previous && !!next
    && previous.publicDeviceId === next.publicDeviceId
    && next.ownershipEpoch === previous.ownershipEpoch + 1;
}

function rebindQueueItemOwner(item, previousOwner, nextOwner) {
  if (sameWorkoutOwner(item.owner, nextOwner)) return item;
  if (!sameWorkoutOwner(item.owner, previousOwner)) return null;
  return { ...item, owner: clone(nextOwner) };
}

/**
 * Rebind the durable completion/quarantine FIFO during the one server-proven
 * anonymous -> bound claim. Both collections must be readable and contain only
 * the previous or already-migrated next owner. A partial write is never treated
 * as success; callers may then clear the workout-only state and block identity
 * commit without touching unrelated anonymous queues.
 */
export function rebindWorkoutCompletionStorageOwner(
  storage,
  previousOwner,
  nextOwner,
) {
  const previous = normalizeWorkoutOwner(previousOwner);
  const next = normalizeWorkoutOwner(nextOwner);
  if (!ownerPairIsContinuous(previous, next)) return false;
  const queueState = readDurableValueState(
    storage,
    WORKOUT_COMPLETION_QUEUE_KEY,
    WORKOUT_COMPLETION_QUEUE_STATE_KEY,
  );
  const quarantineState = readDurableValueState(
    storage,
    WORKOUT_COMPLETION_QUARANTINE_KEY,
    WORKOUT_COMPLETION_QUARANTINE_STATE_KEY,
  );
  if (!queueState.ok || !quarantineState.ok
      || !Array.isArray(queueState.value)
      || queueState.value.length > WORKOUT_COMPLETION_QUEUE_MAX
      || !Array.isArray(quarantineState.value)
      || quarantineState.value.length > WORKOUT_COMPLETION_QUARANTINE_MAX) return false;

  const queue = queueState.value.map(normalizeQueueItem);
  const quarantine = quarantineState.value.map(normalizeQuarantineEntry);
  if (queue.some((item) => !item) || quarantine.some((entry) => !entry)) return false;
  const reboundQueue = queue.map((item) => rebindQueueItemOwner(item, previous, next));
  const reboundQuarantine = quarantine.map((entry) => {
    const item = rebindQueueItemOwner(entry.item, previous, next);
    return item ? { ...entry, item } : null;
  });
  if (reboundQueue.some((item) => !item) || reboundQuarantine.some((entry) => !entry)) {
    return false;
  }
  if (new Set(reboundQueue.map((item) => item.client_execution_id)).size
        !== reboundQueue.length
      || new Set(reboundQuarantine.map(
        (entry) => entry.item.client_execution_id,
      )).size !== reboundQuarantine.length) return false;
  if (!writeQueue(storage, reboundQueue)) return false;
  if (!writeQuarantine(storage, reboundQuarantine)) return false;
  const verifiedQueue = readDurableValueState(
    storage,
    WORKOUT_COMPLETION_QUEUE_KEY,
    WORKOUT_COMPLETION_QUEUE_STATE_KEY,
  );
  const verifiedQuarantine = readDurableValueState(
    storage,
    WORKOUT_COMPLETION_QUARANTINE_KEY,
    WORKOUT_COMPLETION_QUARANTINE_STATE_KEY,
  );
  return verifiedQueue.ok && verifiedQuarantine.ok
    && stableJson(verifiedQueue.value) === stableJson(reboundQueue)
    && stableJson(verifiedQuarantine.value) === stableJson(reboundQuarantine);
}

export function resetWorkoutCompletionStorage(storage) {
  const queueReset = forceWriteDurableValue(
    storage,
    WORKOUT_COMPLETION_QUEUE_KEY,
    WORKOUT_COMPLETION_QUEUE_STATE_KEY,
    [],
  );
  const quarantineReset = forceWriteDurableValue(
    storage,
    WORKOUT_COMPLETION_QUARANTINE_KEY,
    WORKOUT_COMPLETION_QUARANTINE_STATE_KEY,
    [],
  );
  return queueReset && quarantineReset;
}

function sameQueueItem(left, right) {
  return left.client_execution_id === right.client_execution_id
    && JSON.stringify(left.payload) === JSON.stringify(right.payload)
    && JSON.stringify(left.allowed_stage_ids) === JSON.stringify(right.allowed_stage_ids)
    && sameWorkoutOwner(left.owner, right.owner);
}

function normalizeQueueItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const owner = normalizeWorkoutOwner(raw.owner);
  const allowedStageIds = normalizeAllowedStageIds(raw.allowed_stage_ids);
  if (!allowedStageIds) return null;
  const payload = normalizeWorkoutCompletion({
    ...raw.payload,
    allowed_stage_ids: allowedStageIds,
  });
  if (!owner || !payload || payload.client_execution_id !== raw.client_execution_id) return null;
  return {
    client_execution_id: payload.client_execution_id,
    owner,
    allowed_stage_ids: allowedStageIds,
    payload,
  };
}

function normalizeQuarantineEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const item = normalizeQueueItem(raw.item);
  const statusCode = integer(raw.status_code, 400, 599);
  const quarantinedAtMs = integer(raw.quarantined_at_ms, 1, 8_640_000_000_000_000);
  if (!item || statusCode === null || quarantinedAtMs === null) return null;
  return {
    item,
    status_code: statusCode,
    quarantined_at_ms: quarantinedAtMs,
  };
}

export function readPendingWorkoutCompletionsState(storage, expectedOwner = null) {
  const storageState = readDurableValueState(
    storage,
    WORKOUT_COMPLETION_QUEUE_KEY,
    WORKOUT_COMPLETION_QUEUE_STATE_KEY,
  );
  if (!storageState.ok) {
    return { ok: false, items: [], reason: storageState.reason };
  }
  const raw = storageState.value;
  if (!Array.isArray(raw) || raw.length > WORKOUT_COMPLETION_QUEUE_MAX) {
    return { ok: false, items: [], reason: 'storage_value_invalid' };
  }
  const owner = expectedOwner ? normalizeWorkoutOwner(expectedOwner) : null;
  if (expectedOwner && !owner) {
    return { ok: false, items: [], reason: 'owner_invalid' };
  }
  const normalized = raw.map(normalizeQueueItem);
  if (normalized.some((item) => !item)) {
    return { ok: false, items: [], reason: 'storage_value_invalid' };
  }
  const items = owner
    ? normalized.filter((item) => sameWorkoutOwner(item.owner, owner))
    : normalized;
  return { ok: true, items, reason: storageState.reason || '' };
}

export function readPendingWorkoutCompletions(storage, expectedOwner = null) {
  const state = readPendingWorkoutCompletionsState(storage, expectedOwner);
  return state.ok ? state.items : null;
}

function readQueueForMutation(storage) {
  const state = readDurableValueState(
    storage,
    WORKOUT_COMPLETION_QUEUE_KEY,
    WORKOUT_COMPLETION_QUEUE_STATE_KEY,
  );
  if (!state.ok) return null;
  if (!Array.isArray(state.value)
      || state.value.length > WORKOUT_COMPLETION_QUEUE_MAX) return null;
  const items = state.value.map(normalizeQueueItem);
  return items.some((item) => !item) ? null : items;
}

function readQuarantineForMutation(storage) {
  const state = readDurableValueState(
    storage,
    WORKOUT_COMPLETION_QUARANTINE_KEY,
    WORKOUT_COMPLETION_QUARANTINE_STATE_KEY,
  );
  if (!state.ok) return null;
  if (!Array.isArray(state.value)) return null;
  const entries = state.value.map(normalizeQuarantineEntry);
  if (entries.some((entry) => !entry)) return null;
  return entries.slice(-WORKOUT_COMPLETION_QUARANTINE_MAX);
}

function writeQueue(storage, items) {
  return writeDurableValue(
    storage,
    WORKOUT_COMPLETION_QUEUE_KEY,
    WORKOUT_COMPLETION_QUEUE_STATE_KEY,
    items,
  );
}

function writeQuarantine(storage, entries) {
  return writeDurableValue(
    storage,
    WORKOUT_COMPLETION_QUARANTINE_KEY,
    WORKOUT_COMPLETION_QUARANTINE_STATE_KEY,
    entries,
  );
}

export function isPermanentWorkoutCompletionRejection(statusCode) {
  return statusCode === 400 || statusCode === 409 || statusCode === 422;
}

export function readQuarantinedWorkoutCompletionsState(storage, expectedOwner = null) {
  const storageState = readDurableValueState(
    storage,
    WORKOUT_COMPLETION_QUARANTINE_KEY,
    WORKOUT_COMPLETION_QUARANTINE_STATE_KEY,
  );
  if (!storageState.ok) {
    return { ok: false, entries: [], reason: storageState.reason };
  }
  const raw = storageState.value;
  if (!Array.isArray(raw)) {
    return { ok: false, entries: [], reason: 'storage_value_invalid' };
  }
  const owner = expectedOwner ? normalizeWorkoutOwner(expectedOwner) : null;
  if (expectedOwner && !owner) {
    return { ok: false, entries: [], reason: 'owner_invalid' };
  }
  const normalized = raw.map(normalizeQuarantineEntry);
  if (normalized.some((entry) => !entry)) {
    return { ok: false, entries: [], reason: 'storage_value_invalid' };
  }
  const entries = normalized.slice(-WORKOUT_COMPLETION_QUARANTINE_MAX);
  return {
    ok: true,
    entries: owner
    ? entries.filter((entry) => sameWorkoutOwner(entry.item.owner, owner))
      : entries,
    reason: storageState.reason || '',
  };
}

export function readQuarantinedWorkoutCompletions(storage, expectedOwner = null) {
  const state = readQuarantinedWorkoutCompletionsState(storage, expectedOwner);
  return state.ok ? state.entries : null;
}

/**
 * A permanent server rejection must never disappear silently. Persist the exact
 * owner-scoped queue item in a bounded quarantine and read it back before the
 * caller is allowed to remove the FIFO item.
 */
export function quarantineWorkoutCompletion(
  storage,
  completionItem,
  statusCode,
  options = {},
) {
  const item = normalizeQueueItem(completionItem);
  if (!item || !isPermanentWorkoutCompletionRejection(statusCode)) return false;
  const nowMs = integer(options.nowMs ?? Date.now(), 1, 8_640_000_000_000_000);
  if (nowMs === null) return false;
  const current = readQuarantineForMutation(storage);
  if (!current) return false;
  const entry = {
    item,
    status_code: statusCode,
    quarantined_at_ms: nowMs,
  };
  const withoutDuplicate = current.filter((existing) => !(
    existing.item.client_execution_id === item.client_execution_id
      && sameWorkoutOwner(existing.item.owner, item.owner)
  ));
  const next = [...withoutDuplicate, entry].slice(-WORKOUT_COMPLETION_QUARANTINE_MAX);
  if (!writeQuarantine(storage, next)) return false;
  const storedEntries = readQuarantineForMutation(storage);
  return !!storedEntries && storedEntries.some(
    (stored) => stored.item.client_execution_id === item.client_execution_id
      && stored.status_code === statusCode
      && stored.quarantined_at_ms === nowMs
      && sameQueueItem(stored.item, item),
  );
}

export function enqueueWorkoutCompletion(storage, payload, owner, options = {}) {
  const normalizedOwner = normalizeWorkoutOwner(owner);
  const allowedStageIds = normalizeAllowedStageIds(Array.isArray(options.allowedStageIds)
    ? options.allowedStageIds
    : (Array.isArray(payload && payload.stage_results)
      ? payload.stage_results.map((item) => item.stage_id) : []));
  if (!allowedStageIds) return null;
  const normalized = normalizeWorkoutCompletion({
    ...payload,
    allowed_stage_ids: allowedStageIds,
  });
  if (!normalizedOwner || !normalized) return null;
  const all = readQueueForMutation(storage);
  if (!all) return null;
  const item = {
    client_execution_id: normalized.client_execution_id,
    owner: normalizedOwner,
    allowed_stage_ids: allowedStageIds,
    payload: normalized,
  };
  const existingIndex = all.findIndex(
    (entry) => entry.client_execution_id === item.client_execution_id
      && sameWorkoutOwner(entry.owner, item.owner),
  );
  if (existingIndex >= 0) {
    if (!sameQueueItem(all[existingIndex], item)) return null;
    return all;
  }
  if (all.length >= WORKOUT_COMPLETION_QUEUE_MAX) return null;
  const next = [...all, item];
  return writeQueue(storage, next) ? next : null;
}

export function removePendingWorkoutCompletion(storage, acknowledged, expectedOwner) {
  const owner = normalizeWorkoutOwner(expectedOwner);
  if (!owner || !acknowledged || !ID_RE.test(String(acknowledged.client_execution_id || ''))) {
    return null;
  }
  const all = readQueueForMutation(storage);
  if (!all) return null;
  const next = all.filter((item) => !(
    item.client_execution_id === acknowledged.client_execution_id
      && sameWorkoutOwner(item.owner, owner)
      && (!acknowledged.payload || JSON.stringify(item.payload) === JSON.stringify(acknowledged.payload))
  ));
  if (next.length === all.length) return all;
  return writeQueue(storage, next) ? next : null;
}

export function buildWorkoutCompletionRequest({ token, payload, baseUrl = DEFAULT_BASE_URL } = {}) {
  const normalized = normalizeWorkoutCompletion({
    ...payload,
    allowed_stage_ids: Array.isArray(payload && payload.stage_results)
      ? payload.stage_results.map((item) => item.stage_id) : [],
  });
  const safeToken = typeof token === 'string' ? token.trim() : '';
  if (!normalized || safeToken.length < 8) return null;
  const { workout_id: workoutId, plan_session_id: _planSessionId, ...data } = normalized;
  return {
    url: normalizeBaseUrl(baseUrl) + WORKOUT_COMPLETION_PATH_PREFIX
      + encodeURIComponent(workoutId) + '/complete',
    method: 'POST',
    header: {
      Authorization: 'Bearer ' + safeToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    data,
    dataType: 'json',
    responseType: 'text',
    timeout: 12_000,
  };
}

export function parseWorkoutCompletionResponse(response) {
  const normalizedResponse = normalizeWxJsonResponse(response);
  if (!normalizedResponse
      || (normalizedResponse.statusCode !== 200 && normalizedResponse.statusCode !== 201)
      || !normalizedResponse.data || typeof normalizedResponse.data !== 'object'
      || normalizedResponse.data.accepted !== true) return null;
  const executionId = typeof normalizedResponse.data.execution_id === 'string'
    ? normalizedResponse.data.execution_id.trim() : '';
  if (!executionId || executionId.length > 160) return null;
  return {
    executionId,
    duplicate: normalizedResponse.data.duplicate === true,
    nextPlanRefreshRequired: normalizedResponse.data.next_plan_refresh_required === true,
  };
}
