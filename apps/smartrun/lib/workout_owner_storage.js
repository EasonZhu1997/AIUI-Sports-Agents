// Workout-specific durable storage lifecycle shared by device bootstrap and
// the immersive page. Identity claim must not expose a new scoped token until
// completion FIFOs and the active checkpoint have moved to the same owner.

import {
  initializeWorkoutCompletionStorage,
  rebindWorkoutCompletionStorageOwner,
  resetWorkoutCompletionStorage,
  WORKOUT_COMPLETION_QUARANTINE_KEY,
  WORKOUT_COMPLETION_QUARANTINE_STATE_KEY,
  WORKOUT_COMPLETION_QUEUE_KEY,
  WORKOUT_COMPLETION_QUEUE_STATE_KEY,
} from './workout_completion.js';
import {
  clearCachedWorkout,
  initializeWorkoutExecutionStorage,
  rebindCachedWorkoutStorageOwner,
  rebindWorkoutExecutionStorageOwner,
  resetWorkoutExecutionStorage,
  WORKOUT_EXECUTION_CACHE_KEY,
  WORKOUT_EXECUTION_STATE_KEY,
  WORKOUT_PLAN_CACHE_KEY,
} from './workout_cache.js';
import {
  clearHeartRatePolicyStorage,
  HEART_RATE_POLICY_STORAGE_KEY,
} from './heart_rate_policy.js';

// The network Sport Agent runtime is temporarily disabled. Keep only the two
// historical key names here so existing installations can discard its orphaned
// outbox without importing or packaging the retired runtime module.
const LEGACY_SPORT_AGENT_STORAGE_KEYS = Object.freeze([
  'pending_sport_agent_runs_v1',
  'pending_sport_agent_runs_state_v1',
]);

const WORKOUT_OWNER_STORAGE_KEYS = Object.freeze([
  WORKOUT_PLAN_CACHE_KEY,
  WORKOUT_COMPLETION_QUEUE_KEY,
  WORKOUT_COMPLETION_QUEUE_STATE_KEY,
  WORKOUT_COMPLETION_QUARANTINE_KEY,
  WORKOUT_COMPLETION_QUARANTINE_STATE_KEY,
  WORKOUT_EXECUTION_CACHE_KEY,
  WORKOUT_EXECUTION_STATE_KEY,
  HEART_RATE_POLICY_STORAGE_KEY,
]);

function clearLegacyAgentStorage(storage) {
  if (!storage || typeof storage.removeStorageSync !== 'function') return false;
  let cleared = true;
  for (const key of LEGACY_SPORT_AGENT_STORAGE_KEYS) {
    try {
      storage.removeStorageSync(key);
    } catch (_error) {
      cleared = false;
    }
  }
  return cleared;
}

function stableJson(value) {
  try { return JSON.stringify(value); } catch (_error) { return ''; }
}

function clone(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch (_error) { return undefined; }
}

function readSnapshotValue(storage, key) {
  if (!storage || typeof storage.getStorageSync !== 'function') return null;
  try {
    const value = storage.getStorageSync(key);
    if (value === undefined) return { key, found: false, value: undefined };
    const copied = clone(value);
    if (copied === undefined && value !== undefined) return null;
    return { key, found: true, value: copied };
  } catch (_error) {
    return null;
  }
}

function captureStorageKeys(storage, keys) {
  const entries = keys.map(
    (key) => readSnapshotValue(storage, key),
  );
  return entries.some((entry) => !entry) ? null : entries;
}

function captureWorkoutOwnerStorage(storage) {
  return captureStorageKeys(storage, WORKOUT_OWNER_STORAGE_KEYS);
}

function valueMatchesSnapshot(storage, entry) {
  if (!storage || typeof storage.getStorageSync !== 'function') return false;
  try {
    const first = storage.getStorageSync(entry.key);
    const value = first === undefined ? storage.getStorageSync(entry.key) : first;
    return entry.found
      ? value !== undefined && stableJson(value) === stableJson(entry.value)
      : value === undefined;
  } catch (_error) {
    return false;
  }
}

function restoreWorkoutOwnerStorage(storage, snapshot) {
  if (!Array.isArray(snapshot)) return false;
  let restored = true;
  for (const entry of snapshot) {
    try {
      if (entry.found) {
        if (!storage || typeof storage.setStorageSync !== 'function') {
          restored = false;
          continue;
        }
        storage.setStorageSync(entry.key, clone(entry.value));
      } else if (storage && typeof storage.removeStorageSync === 'function') {
        storage.removeStorageSync(entry.key);
      } else {
        restored = false;
        continue;
      }
      if (!valueMatchesSnapshot(storage, entry)) restored = false;
    } catch (_error) {
      restored = false;
    }
  }
  return restored;
}

export async function initializeWorkoutOwnerStorage(storage) {
  const results = await Promise.all([
    initializeWorkoutCompletionStorage(storage),
    initializeWorkoutExecutionStorage(storage),
  ]);
  // This is retirement cleanup, not an initialization prerequisite. A host
  // storage bridge that rejects removal must not block the current owner.
  clearLegacyAgentStorage(storage);
  return results.every((result) => result === true);
}

export function resetWorkoutOwnerStorage(storage) {
  const planReset = clearCachedWorkout(storage);
  const completionsReset = resetWorkoutCompletionStorage(storage);
  const executionReset = resetWorkoutExecutionStorage(storage);
  const heartRatePolicyReset = clearHeartRatePolicyStorage(storage);
  clearLegacyAgentStorage(storage);
  return planReset && completionsReset && executionReset
    && heartRatePolicyReset;
}

/**
 * Heart-rate policy is owner-scoped profile data, not transferable workout
 * evidence. A normal anonymous -> bound claim may have this single key without
 * any plan/FIFO/checkpoint records, so give identity commit a small standalone
 * transaction instead of leaving the former owner's policy in physical
 * storage until a later exact-owner read happens to notice it.
 */
export function beginHeartRatePolicyStorageClear(storage) {
  const snapshot = captureStorageKeys(storage, [HEART_RATE_POLICY_STORAGE_KEY]);
  if (!snapshot) return { ok: false, rollbackSucceeded: false };
  if (!clearHeartRatePolicyStorage(storage)) {
    return {
      ok: false,
      rollbackSucceeded: restoreWorkoutOwnerStorage(storage, snapshot),
    };
  }
  let active = true;
  return {
    ok: true,
    commit() {
      active = false;
      return true;
    },
    rollback() {
      if (!active) return true;
      const restored = restoreWorkoutOwnerStorage(storage, snapshot);
      if (restored) active = false;
      return restored;
    },
  };
}

/**
 * Rebind every owner-scoped workout record as one recoverable in-memory
 * transaction. The identity commit is synchronous in the same JS turn, so a
 * verified preimage can restore the exact old state if any later credential
 * write fails. If a hostile storage implementation also rejects rollback, the
 * new identity remains unpublished and a later bootstrap can resume because
 * each rebind helper accepts both the old and already-migrated owner.
 */
export function beginWorkoutOwnerStorageRebind(storage, previousOwner, nextOwner) {
  const snapshot = captureWorkoutOwnerStorage(storage);
  if (!snapshot) return { ok: false, rollbackSucceeded: false };
  const rebound = rebindCachedWorkoutStorageOwner(storage, previousOwner, nextOwner)
    && rebindWorkoutCompletionStorageOwner(storage, previousOwner, nextOwner)
    && rebindWorkoutExecutionStorageOwner(storage, previousOwner, nextOwner)
    // Heart-rate profile policy is not workout evidence. Any owner marker
    // change invalidates it; the next exact-owner current-workout response may
    // repopulate it. The snapshot above still makes rollback transactional.
    && clearHeartRatePolicyStorage(storage);
  clearLegacyAgentStorage(storage);
  if (!rebound) {
    return {
      ok: false,
      rollbackSucceeded: restoreWorkoutOwnerStorage(storage, snapshot),
    };
  }
  let active = true;
  return {
    ok: true,
    commit() {
      active = false;
      return true;
    },
    rollback() {
      if (!active) return true;
      const restored = restoreWorkoutOwnerStorage(storage, snapshot);
      if (restored) active = false;
      return restored;
    },
  };
}

export function rebindWorkoutOwnerStorage(storage, previousOwner, nextOwner) {
  const transaction = beginWorkoutOwnerStorageRebind(
    storage,
    previousOwner,
    nextOwner,
  );
  if (!transaction.ok) return false;
  transaction.commit();
  return true;
}
