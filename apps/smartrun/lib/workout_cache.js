// Owner-isolated, write-read verified persistence for Super Coach plans and
// executor checkpoints. Corrupt, expired or cross-owner values fail closed.

import {
  normalizeWorkoutOwner,
  normalizeWorkoutPlan,
  sameWorkoutOwner,
} from './workout_contract.js';
import { normalizeWorkoutExecution } from './workout_executor.js';

export const WORKOUT_PLAN_CACHE_KEY = 'smartrun_workout_plan_v2';
export const WORKOUT_EXECUTION_CACHE_KEY = 'smartrun_workout_execution_v1';
export const WORKOUT_EXECUTION_STATE_KEY = 'smartrun_workout_execution_state_v1';

const WORKOUT_EXECUTION_EMPTY = Object.freeze({
  __smartrun_workout_execution_empty_v1__: true,
});

function read(storage, key) {
  const state = readState(storage, key);
  return state.ok ? state.value : undefined;
}

function readState(storage, key) {
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

function remove(storage, key) {
  try {
    if (!storage || typeof storage.removeStorageSync !== 'function') return false;
    storage.removeStorageSync(key);
    return read(storage, key) == null || read(storage, key) === '';
  } catch (_error) {
    return false;
  }
}

function stableJson(value) {
  try { return JSON.stringify(value); } catch (_error) { return ''; }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hashText(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function executionStateRecord(value) {
  const committedValue = clone(value);
  const json = stableJson(committedValue);
  return {
    schema_version: 1,
    target_key: WORKOUT_EXECUTION_CACHE_KEY,
    value_digest: hashText(json),
    committed_value: committedValue,
  };
}

function normalizeExecutionStateRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || raw.schema_version !== 1 || raw.target_key !== WORKOUT_EXECUTION_CACHE_KEY
      || typeof raw.value_digest !== 'string'
      || !Object.prototype.hasOwnProperty.call(raw, 'committed_value')) return null;
  const json = stableJson(raw.committed_value);
  if (!json || hashText(json) !== raw.value_digest) return null;
  return clone(raw.committed_value);
}

function isExecutionTombstone(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && value.__smartrun_workout_execution_empty_v1__ === true
    && Object.keys(value).length === 1;
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

function writeExecutionValue(storage, value) {
  if (!storage || typeof storage.setStorageSync !== 'function'
      || typeof storage.getStorageSync !== 'function') return false;
  const target = clone(value);
  const stateRecord = executionStateRecord(target);
  try {
    const targetBefore = readState(storage, WORKOUT_EXECUTION_CACHE_KEY);
    const stateBefore = readState(storage, WORKOUT_EXECUTION_STATE_KEY);
    if (!targetBefore.ok || !stateBefore.ok) return false;
    if (stateBefore.found) {
      const committed = normalizeExecutionStateRecord(stateBefore.value);
      if (committed === null || !targetBefore.found
          || stableJson(targetBefore.value) !== stableJson(committed)) return false;
    }
    storage.setStorageSync(WORKOUT_EXECUTION_CACHE_KEY, target);
    const targetAfter = readState(storage, WORKOUT_EXECUTION_CACHE_KEY);
    if (!targetAfter.ok || !targetAfter.found
        || stableJson(targetAfter.value) !== stableJson(target)) return false;
    storage.setStorageSync(WORKOUT_EXECUTION_STATE_KEY, stateRecord);
    const stateAfter = readState(storage, WORKOUT_EXECUTION_STATE_KEY);
    return stateAfter.ok && stateAfter.found
      && stableJson(stateAfter.value) === stableJson(stateRecord);
  } catch (_error) {
    return false;
  }
}

function writeExecutionStateOnly(storage, value) {
  if (!storage || typeof storage.setStorageSync !== 'function'
      || typeof storage.getStorageSync !== 'function') return false;
  const stateRecord = executionStateRecord(value);
  try {
    storage.setStorageSync(WORKOUT_EXECUTION_STATE_KEY, stateRecord);
    const stateAfter = readState(storage, WORKOUT_EXECUTION_STATE_KEY);
    return stateAfter.ok && stateAfter.found
      && stableJson(stateAfter.value) === stableJson(stateRecord);
  } catch (_error) {
    return false;
  }
}

function writeExecutionTargetOnly(storage, value) {
  if (!storage || typeof storage.setStorageSync !== 'function'
      || typeof storage.getStorageSync !== 'function') return false;
  const target = clone(value);
  try {
    storage.setStorageSync(WORKOUT_EXECUTION_CACHE_KEY, target);
    const targetAfter = readState(storage, WORKOUT_EXECUTION_CACHE_KEY);
    return targetAfter.ok && targetAfter.found
      && stableJson(targetAfter.value) === stableJson(target);
  } catch (_error) {
    return false;
  }
}

function forceWriteExecutionValue(storage, value) {
  if (!writeExecutionTargetOnly(storage, value)) return false;
  if (!writeExecutionStateOnly(storage, value)) return false;
  const target = readState(storage, WORKOUT_EXECUTION_CACHE_KEY);
  const state = readState(storage, WORKOUT_EXECUTION_STATE_KEY);
  const committed = state.ok && state.found
    ? normalizeExecutionStateRecord(state.value) : null;
  return target.ok && target.found && committed !== null
    && stableJson(target.value) === stableJson(value)
    && stableJson(committed) === stableJson(value);
}

function resolveExactExecutionPair(storage, target, state) {
  if (!target.complete || !state.complete || !target.ok || !state.ok) {
    return { ok: false, value: undefined, reason: 'storage_initialization_required' };
  }
  if (state.found) {
    const committed = normalizeExecutionStateRecord(state.value);
    if (committed === null) {
      return { ok: false, value: undefined, reason: 'storage_state_invalid' };
    }
    if (target.found && stableJson(target.value) !== stableJson(committed)) {
      return { ok: false, value: undefined, reason: 'storage_state_conflict' };
    }
    return { ok: true, value: committed, reason: '' };
  }
  if (target.found) {
    if (isExecutionTombstone(target.value)) {
      return { ok: false, value: undefined, reason: 'storage_state_missing' };
    }
    return { ok: true, value: target.value, reason: 'legacy' };
  }
  if (!writeExecutionValue(storage, WORKOUT_EXECUTION_EMPTY)) {
    return { ok: false, value: undefined, reason: 'storage_initialization_failed' };
  }
  return { ok: true, value: WORKOUT_EXECUTION_EMPTY, reason: '' };
}

function readExecutionValueState(storage) {
  const target = readState(storage, WORKOUT_EXECUTION_CACHE_KEY);
  const state = readState(storage, WORKOUT_EXECUTION_STATE_KEY);
  if (state.ok && state.found) {
    const committed = normalizeExecutionStateRecord(state.value);
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
    if (isExecutionTombstone(target.value)) {
      return { ok: false, value: undefined, reason: 'storage_state_missing' };
    }
    return { ok: true, value: target.value, reason: 'legacy' };
  }
  if (!state.ok && target.ok && target.found) {
    return { ok: false, value: undefined, reason: state.reason };
  }
  return resolveExactExecutionPair(
    storage,
    readExactKeyImmediate(storage, WORKOUT_EXECUTION_CACHE_KEY),
    readExactKeyImmediate(storage, WORKOUT_EXECUTION_STATE_KEY),
  );
}

export async function initializeWorkoutExecutionStorage(storage) {
  const [target, state] = await Promise.all([
    readExactKey(storage, WORKOUT_EXECUTION_CACHE_KEY),
    readExactKey(storage, WORKOUT_EXECUTION_STATE_KEY),
  ]);
  if (!target.ok || !state.ok) return false;
  const resolved = resolveExactExecutionPair(
    storage,
    { complete: true, ...target },
    { complete: true, ...state },
  );
  if (!resolved.ok) return false;
  if (state.found && !target.found) {
    return writeExecutionTargetOnly(storage, resolved.value);
  }
  if (!state.found && target.found) return writeExecutionStateOnly(storage, resolved.value);
  return true;
}

function ownerPairIsContinuous(previousOwner, nextOwner) {
  const previous = normalizeWorkoutOwner(previousOwner);
  const next = normalizeWorkoutOwner(nextOwner);
  return !!previous && !!next
    && previous.publicDeviceId === next.publicDeviceId
    && next.ownershipEpoch === previous.ownershipEpoch + 1;
}

/** Re-owner one active staged-workout checkpoint before the new binding commits. */
export function rebindWorkoutExecutionStorageOwner(storage, previousOwner, nextOwner) {
  const previous = normalizeWorkoutOwner(previousOwner);
  const next = normalizeWorkoutOwner(nextOwner);
  if (!ownerPairIsContinuous(previous, next)) return false;
  const state = readExecutionValueState(storage);
  if (!state.ok) return false;
  if (isExecutionTombstone(state.value)) {
    return writeExecutionValue(storage, WORKOUT_EXECUTION_EMPTY);
  }
  const record = state.value;
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || record.schema_version !== 1) return false;
  const alreadyRebound = sameWorkoutOwner(record, next)
    && normalizeWorkoutExecution(record.execution, next);
  let execution = alreadyRebound;
  if (!execution) {
    const previousExecution = sameWorkoutOwner(record, previous)
      ? normalizeWorkoutExecution(record.execution, previous) : null;
    if (!previousExecution) return false;
    const candidate = clone(previousExecution);
    candidate.owner = clone(next);
    candidate.plan.ownership_epoch = next.ownershipEpoch;
    candidate.plan.data_namespace = next.dataNamespace;
    execution = normalizeWorkoutExecution(candidate, next);
  }
  if (!execution) return false;
  const rebound = {
    schema_version: 1,
    ownership_epoch: next.ownershipEpoch,
    data_namespace: next.dataNamespace,
    public_device_id: next.publicDeviceId,
    execution,
  };
  if (!writeExecutionValue(storage, rebound)) return false;
  const verified = readExecutionValueState(storage);
  return verified.ok && stableJson(verified.value) === stableJson(rebound);
}

export function resetWorkoutExecutionStorage(storage) {
  return forceWriteExecutionValue(storage, WORKOUT_EXECUTION_EMPTY);
}

function verifiedWrite(storage, key, value) {
  try {
    if (!storage || typeof storage.setStorageSync !== 'function') return false;
    storage.setStorageSync(key, value);
    return stableJson(read(storage, key)) === stableJson(value);
  } catch (_error) {
    return false;
  }
}

export function clearCachedWorkout(storage) {
  return remove(storage, WORKOUT_PLAN_CACHE_KEY);
}

/**
 * Preserve one still-valid Today Workout cache across the server-proven first
 * anonymous -> bound claim. Unknown/cross-owner records fail closed; an expired
 * cache is safe to remove because it is no longer executable for either owner.
 */
export function rebindCachedWorkoutStorageOwner(
  storage,
  previousOwner,
  nextOwner,
  options = {},
) {
  const previous = normalizeWorkoutOwner(previousOwner);
  const next = normalizeWorkoutOwner(nextOwner);
  if (!ownerPairIsContinuous(previous, next)) return false;
  const state = readState(storage, WORKOUT_PLAN_CACHE_KEY);
  if (!state.ok) return false;
  if (!state.found) return true;
  const record = state.value;
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || record.schema_version !== 1
      || typeof record.fetched_at_ms !== 'number'
      || !Number.isFinite(record.fetched_at_ms)
      || typeof record.expires_at_ms !== 'number'
      || !Number.isFinite(record.expires_at_ms)) return false;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  if (record.expires_at_ms <= nowMs) return clearCachedWorkout(storage);
  if (!sameWorkoutOwner(record, previous) && !sameWorkoutOwner(record, next)) return false;
  const planOwner = sameWorkoutOwner(record, next) ? next : previous;
  const plan = normalizeWorkoutPlan(record.plan, planOwner, { nowMs });
  if (!plan || plan.expires_at_ms !== record.expires_at_ms) return false;
  if (sameWorkoutOwner(record, next)) return true;
  const reboundPlan = normalizeWorkoutPlan({
    ...plan,
    ownership_epoch: next.ownershipEpoch,
    data_namespace: next.dataNamespace,
  }, next, { nowMs });
  if (!reboundPlan) return false;
  return verifiedWrite(storage, WORKOUT_PLAN_CACHE_KEY, {
    ...record,
    ownership_epoch: next.ownershipEpoch,
    data_namespace: next.dataNamespace,
    public_device_id: next.publicDeviceId,
    plan: reboundPlan,
  });
}

export function writeCachedWorkout(storage, plan, expectedOwner, options = {}) {
  const owner = normalizeWorkoutOwner(expectedOwner);
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const normalized = owner && normalizeWorkoutPlan(plan, owner, { nowMs });
  if (!owner || !normalized) return false;
  const record = {
    schema_version: 1,
    ownership_epoch: owner.ownershipEpoch,
    data_namespace: owner.dataNamespace,
    public_device_id: owner.publicDeviceId,
    fetched_at_ms: nowMs,
    expires_at_ms: normalized.expires_at_ms,
    plan: normalized,
  };
  return verifiedWrite(storage, WORKOUT_PLAN_CACHE_KEY, record);
}

export function readCachedWorkout(storage, expectedOwner, options = {}) {
  const owner = normalizeWorkoutOwner(expectedOwner);
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const record = read(storage, WORKOUT_PLAN_CACHE_KEY);
  if (!owner || !record || typeof record !== 'object' || Array.isArray(record)
      || record.schema_version !== 1
      || !sameWorkoutOwner(record, owner)
      || typeof record.fetched_at_ms !== 'number'
      || !Number.isFinite(record.fetched_at_ms)
      || typeof record.expires_at_ms !== 'number'
      || record.expires_at_ms <= nowMs) {
    if (record != null && record !== '') clearCachedWorkout(storage);
    return null;
  }
  const plan = normalizeWorkoutPlan(record.plan, owner, { nowMs });
  if (!plan || plan.expires_at_ms !== record.expires_at_ms) {
    clearCachedWorkout(storage);
    return null;
  }
  return plan;
}

export function clearWorkoutExecutionCheckpoint(storage) {
  return writeExecutionValue(storage, WORKOUT_EXECUTION_EMPTY);
}

export function writeWorkoutExecutionCheckpoint(storage, execution, expectedOwner) {
  const owner = normalizeWorkoutOwner(expectedOwner);
  if (!owner || !execution || typeof execution !== 'object') return false;
  if (!sameWorkoutOwner(execution.owner, owner)) return false;
  const record = {
    schema_version: 1,
    ownership_epoch: owner.ownershipEpoch,
    data_namespace: owner.dataNamespace,
    public_device_id: owner.publicDeviceId,
    execution,
  };
  return writeExecutionValue(storage, record);
}

export function readWorkoutExecutionCheckpointState(
  storage,
  expectedOwner,
  normalizeExecution,
) {
  const owner = normalizeWorkoutOwner(expectedOwner);
  const storageState = readExecutionValueState(storage);
  if (!storageState.ok) {
    return {
      ok: false,
      found: false,
      execution: null,
      reason: storageState.reason,
    };
  }
  const record = storageState.value;
  if (isExecutionTombstone(record)) {
    return {
      ok: true,
      found: false,
      execution: null,
      reason: 'missing',
    };
  }
  if (!owner || !record || typeof record !== 'object' || Array.isArray(record)
      || record.schema_version !== 1 || !sameWorkoutOwner(record, owner)
      || typeof normalizeExecution !== 'function') {
    return {
      ok: false,
      found: false,
      execution: null,
      reason: 'storage_value_invalid',
    };
  }
  const execution = normalizeExecution(record.execution, owner);
  if (!execution) {
    return {
      ok: false,
      found: false,
      execution: null,
      reason: 'storage_value_invalid',
    };
  }
  return {
    ok: true,
    found: true,
    execution,
    reason: '',
  };
}

export function readWorkoutExecutionCheckpoint(storage, expectedOwner, normalizeExecution) {
  const state = readWorkoutExecutionCheckpointState(
    storage,
    expectedOwner,
    normalizeExecution,
  );
  if (!state.ok) {
    const error = new Error('Workout execution checkpoint storage read failed');
    error.code = 'WORKOUT_CHECKPOINT_READ_FAILED';
    error.reason = state.reason;
    throw error;
  }
  return state.execution;
}
