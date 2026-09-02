// Owner-scoped maximum-heart-rate policy received from Hermes.
//
// The public AIUI ID is not an owner proof. A cached policy is usable only
// when public_device_id, ownership_epoch and data_namespace all match the
// current identity. Conservative defaults are deliberately session-only so a
// generic fallback can never be mistaken for a learned personal setting.

import { hrZone } from './hr.js';

export const HEART_RATE_POLICY_SCHEMA_VERSION = 1;
export const HEART_RATE_POLICY_STORAGE_KEY = 'smartrun_heart_rate_policy_v1';
export const HEART_RATE_POLICY_UNKNOWN_HIGH_BPM = 170;

const HEART_RATE_POLICY_ALLOWED_KEYS = new Set([
  'schema_version',
  'max_hr_bpm',
  'source',
  'issued_at_ms',
  'expires_at_ms',
]);
const HEART_RATE_POLICY_MAX_FUTURE_ISSUE_MS = 60_000;
const HEART_RATE_POLICY_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const POLICY_SOURCES = new Set([
  'user_explicit',
  'garmin_profile',
  'age_estimate',
  'conservative_default',
]);
const PERSISTED_POLICY_SOURCES = new Set([
  'user_explicit',
  'garmin_profile',
  'age_estimate',
]);
const TRUSTED_POLICY_SOURCES = new Set(['user_explicit', 'garmin_profile']);

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteInteger(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= min && value <= max ? value : null;
}

function boundedString(value, min, max) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized.length >= min && normalized.length <= max ? normalized : '';
}

export function normalizeHeartRatePolicyOwner(value) {
  if (!isObject(value)) return null;
  const ownershipEpoch = finiteInteger(
    value.ownershipEpoch ?? value.ownership_epoch,
    1,
    1_000_000_000,
  );
  const dataNamespace = boundedString(
    value.dataNamespace ?? value.data_namespace,
    1,
    240,
  );
  const publicDeviceId = boundedString(
    value.publicDeviceId ?? value.public_device_id,
    1,
    160,
  );
  if (ownershipEpoch === null || !dataNamespace || !publicDeviceId) return null;
  return Object.freeze({ ownershipEpoch, dataNamespace, publicDeviceId });
}

export function sameHeartRatePolicyOwner(left, right) {
  const a = normalizeHeartRatePolicyOwner(left);
  const b = normalizeHeartRatePolicyOwner(right);
  return !!a && !!b
    && a.ownershipEpoch === b.ownershipEpoch
    && a.dataNamespace === b.dataNamespace
    && a.publicDeviceId === b.publicDeviceId;
}

export function normalizeHeartRatePolicy(raw, options = {}) {
  if (!isObject(raw) || raw.schema_version !== HEART_RATE_POLICY_SCHEMA_VERSION) return null;
  const keys = Object.keys(raw);
  if (keys.length !== HEART_RATE_POLICY_ALLOWED_KEYS.size
      || keys.some((key) => !HEART_RATE_POLICY_ALLOWED_KEYS.has(key))) return null;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const maxHrBpm = finiteInteger(raw.max_hr_bpm, 120, 230);
  const source = boundedString(raw.source, 1, 32);
  const issuedAtMs = finiteInteger(raw.issued_at_ms, 0, Number.MAX_SAFE_INTEGER);
  const expiresAtMs = finiteInteger(raw.expires_at_ms, 1, Number.MAX_SAFE_INTEGER);
  if (maxHrBpm === null || !POLICY_SOURCES.has(source)
      || issuedAtMs === null || expiresAtMs === null
      || issuedAtMs > nowMs + HEART_RATE_POLICY_MAX_FUTURE_ISSUE_MS
      || expiresAtMs <= issuedAtMs || expiresAtMs <= nowMs
      || expiresAtMs - issuedAtMs > HEART_RATE_POLICY_MAX_TTL_MS) return null;
  return Object.freeze({
    schema_version: HEART_RATE_POLICY_SCHEMA_VERSION,
    max_hr_bpm: maxHrBpm,
    source,
    issued_at_ms: issuedAtMs,
    expires_at_ms: expiresAtMs,
  });
}

export function isPersistableHeartRatePolicy(policy) {
  return !!policy && PERSISTED_POLICY_SOURCES.has(policy.source);
}

export function heartRatePolicyConfidence(policy) {
  if (!policy) return 'missing';
  if (TRUSTED_POLICY_SOURCES.has(policy.source)) return 'trusted';
  return policy.source === 'age_estimate' || policy.source === 'conservative_default'
    ? 'estimated' : 'missing';
}

export function heartRateZoneFromPolicy(bpm, policy) {
  // The HUD zone strip is a neutral visualization, not a coaching verdict.
  // A valid estimated policy may therefore light the strip as long as the UI
  // labels it as estimated. Callers must continue to gate personalized or
  // positive coaching on heartRatePolicyConfidence(policy) === 'trusted'.
  // Missing/expired policies remain dark rather than inventing a local max HR.
  if (heartRatePolicyConfidence(policy) === 'missing'
      || !Number.isFinite(Number(policy.max_hr_bpm))) return 0;
  return hrZone(Number(bpm), Number(policy.max_hr_bpm));
}

/**
 * Safety-only high-heart-rate gate. Trusted policies use the normal Z5 edge.
 * Estimated policies warn at 85% rather than offering positive intensity
 * guidance. With no policy, 170 bpm is only a generic caution threshold: it
 * never lights a zone or claims to know the user's individual maximum.
 */
export function isConservativeHighHeartRate(bpm, policy) {
  const value = Number(bpm);
  if (!Number.isFinite(value) || value <= 0) return false;
  const confidence = heartRatePolicyConfidence(policy);
  if (confidence === 'missing') return value >= HEART_RATE_POLICY_UNKNOWN_HIGH_BPM;
  const ratio = value / Number(policy.max_hr_bpm);
  return confidence === 'trusted' ? ratio >= 0.9 : ratio >= 0.85;
}

function clone(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (_error) { return null; }
}

function stableJson(value) {
  try { return JSON.stringify(value); } catch (_error) { return ''; }
}

function readRaw(storage) {
  try {
    if (!storage || typeof storage.getStorageSync !== 'function') {
      return { readable: false, value: undefined };
    }
    return { readable: true, value: storage.getStorageSync(HEART_RATE_POLICY_STORAGE_KEY) };
  } catch (_error) {
    return { readable: false, value: undefined };
  }
}

export function clearHeartRatePolicyStorage(storage) {
  if (!storage) return false;
  try {
    if (typeof storage.removeStorageSync === 'function') {
      storage.removeStorageSync(HEART_RATE_POLICY_STORAGE_KEY);
    }
    let read = readRaw(storage);
    if (!read.readable) return false;
    if (read.value === undefined || read.value === null || read.value === '') return true;
    if (typeof storage.setStorageSync !== 'function') return false;
    storage.setStorageSync(HEART_RATE_POLICY_STORAGE_KEY, '');
    read = readRaw(storage);
    return read.readable && (read.value === undefined || read.value === null || read.value === '');
  } catch (_error) {
    return false;
  }
}

function normalizeStoredRecord(raw, expectedOwner, nowMs) {
  if (!isObject(raw) || raw.schema_version !== HEART_RATE_POLICY_SCHEMA_VERSION
      || !sameHeartRatePolicyOwner(raw.owner, expectedOwner)) return null;
  const policy = normalizeHeartRatePolicy(raw.policy, { nowMs });
  if (!policy || !isPersistableHeartRatePolicy(policy)) return null;
  const owner = normalizeHeartRatePolicyOwner(raw.owner);
  return Object.freeze({
    schema_version: HEART_RATE_POLICY_SCHEMA_VERSION,
    owner,
    policy,
  });
}

/** Read exact-owner policy; damaged, expired and cross-owner records are removed. */
export function readHeartRatePolicy(storage, expectedOwner, options = {}) {
  const owner = normalizeHeartRatePolicyOwner(expectedOwner);
  if (!owner) return null;
  const read = readRaw(storage);
  if (!read.readable) return null;
  if (read.value === undefined || read.value === null || read.value === '') return null;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const record = normalizeStoredRecord(read.value, owner, nowMs);
  if (!record) {
    clearHeartRatePolicyStorage(storage);
    return null;
  }
  return record.policy;
}

/** Persist only personal/derived sources and prove the exact write by readback. */
export function writeHeartRatePolicy(storage, rawPolicy, expectedOwner, options = {}) {
  const owner = normalizeHeartRatePolicyOwner(expectedOwner);
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const policy = normalizeHeartRatePolicy(rawPolicy, { nowMs });
  if (!owner || !policy || !isPersistableHeartRatePolicy(policy)
      || !storage || typeof storage.setStorageSync !== 'function') return false;
  const record = {
    schema_version: HEART_RATE_POLICY_SCHEMA_VERSION,
    owner: {
      ownership_epoch: owner.ownershipEpoch,
      data_namespace: owner.dataNamespace,
      public_device_id: owner.publicDeviceId,
    },
    policy: clone(policy),
  };
  try {
    storage.setStorageSync(HEART_RATE_POLICY_STORAGE_KEY, record);
  } catch (_error) {
    // The previous value may still be a valid trusted policy. Once Hermes has
    // issued a replacement, a failed write must not let that stale value
    // silently become authoritative again on the next page generation.
    clearHeartRatePolicyStorage(storage);
    return false;
  }
  const read = readRaw(storage);
  if (!read.readable || stableJson(read.value) !== stableJson(record)) {
    clearHeartRatePolicyStorage(storage);
    return false;
  }
  const verified = normalizeStoredRecord(read.value, owner, nowMs);
  if (!verified || stableJson(verified.policy) !== stableJson(policy)) {
    clearHeartRatePolicyStorage(storage);
    return false;
  }
  return true;
}
