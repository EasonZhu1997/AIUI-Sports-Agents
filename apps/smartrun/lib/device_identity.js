// SmartRun 设备身份与 APK 配对契约。
//
// 正常身份注册不读取或模拟设备 SN：首次安装由服务器签发 installation ID 与
// 长期不透明 device_credential，AIX 原子缓存后再 bootstrap，成功后继续长期
// 复用同一凭据。模块不读取、散列、模拟或发送 SN；公开 AIUI ID 只作 locator。

import { normalizeBaseUrl, DEFAULT_BASE_URL } from './coach_api.js';
import {
  beginHeartRatePolicyStorageClear,
  beginWorkoutOwnerStorageRebind,
  initializeWorkoutOwnerStorage,
} from './workout_owner_storage.js';
import { HEART_RATE_POLICY_STORAGE_KEY } from './heart_rate_policy.js';
import {
  RUNNING_LOCAL_FIELD_LOG_KEY,
  clearRunningLocalFieldLogs,
} from './running_local_field_log.js';

export const LEGACY_DEVICE_ID_STORAGE_KEY = 'smartrun_device_id';
export const INSTALLATION_ID_STORAGE_KEY = 'smartrun_installation_id';
export const PUBLIC_DEVICE_ID_STORAGE_KEY = 'smartrun_public_device_id';
export const AIUI_ID_STORAGE_KEY = 'smartrun_aiui_id';
export const DEVICE_TOKEN_STORAGE_KEY = 'smartrun_device_token';
export const DEVICE_CREDENTIAL_STORAGE_KEY = 'smartrun_device_credential';
// 旧包兼容：新注册不再生成、申请或写入 device_secret。
export const DEVICE_SECRET_STORAGE_KEY = 'smartrun_device_secret';
export const DEVICE_SECRET_BOOTSTRAP_STATE_STORAGE_KEY = 'smartrun_device_secret_bootstrap_state';
export const HARDWARE_FINGERPRINT_SUPPRESSED_STORAGE_KEY = 'smartrun_fingerprint_suppressed_for';
export const DEVICE_BINDING_STORAGE_KEY = 'smartrun_device_binding';
export const DEVICE_RECOVERY_STATE_STORAGE_KEY = 'smartrun_device_recovery_state';
export const DEVICE_RECOVERY_CANDIDATE_STORAGE_KEY = 'smartrun_device_recovery_candidate';
export const DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY =
  'smartrun_device_registration_candidate';
export const OWNER_TRANSITION_PENDING_STORAGE_KEY = 'smartrun_owner_transition_pending';
export const LEGACY_COACH_TOKEN_STORAGE_KEY = 'smartrun_legacy_coach_token';
export const LEGACY_MIGRATION_STATE_STORAGE_KEY = 'smartrun_legacy_migration_state';
// 全新安装首次离线跑步的本地待归属棘轮。它不是设备 ID、认证凭据或上传字段，
// 只证明这些本地记录诞生于“从未激活过服务器身份”的当前安装存储。
export const PREIDENTITY_OWNER_STORAGE_KEY = 'smartrun_preidentity_owner_v1';
export const PREIDENTITY_OWNER_VALUE = 'pending-first-server-owner-v1';
// 一旦任一服务器身份完整提交，本安装 storage 永久退出 preidentity。该墓碑
// 不随 owner 解绑/换绑清理，也不上传；它只防止 active 身份键异常丢失后，
// 旧 owner 私有数据被重新解释为“首次离线记录”。
export const IDENTITY_EVER_ACTIVATED_STORAGE_KEY =
  'smartrun_identity_ever_activated_v1';
export const IDENTITY_EVER_ACTIVATED_VALUE = 'server-identity-activated-v1';

const WORKOUT_COMPLETION_QUEUE_KEY = 'pending_workout_completions_v2';
const WORKOUT_COMPLETION_QUEUE_STATE_KEY = 'pending_workout_completions_state_v1';
const WORKOUT_COMPLETION_QUARANTINE_KEY = 'quarantined_workout_completions_v1';
const WORKOUT_COMPLETION_QUARANTINE_STATE_KEY =
  'quarantined_workout_completions_state_v1';
const WORKOUT_EXECUTION_CACHE_KEY = 'smartrun_workout_execution_v1';
const WORKOUT_EXECUTION_STATE_KEY = 'smartrun_workout_execution_state_v1';
const WORKOUT_EXECUTION_EMPTY = Object.freeze({
  __smartrun_workout_execution_empty_v1__: true,
});
// The runtime Sport Agent is disabled, but these legacy key names remain part
// of owner cleanup so an upgrade cannot expose an older user's queued records.
const LEGACY_SPORT_AGENT_QUEUE_KEY = 'pending_sport_agent_runs_v1';
const LEGACY_SPORT_AGENT_QUEUE_STATE_KEY =
  'pending_sport_agent_runs_state_v1';

// 这些值都可能包含上一位 APK 用户的跑步/记忆内容。设备偏好、心率设备、
// installation/public ID 与长期 device_credential 属于眼镜本身，不在所有权轮换时清除。
export const OWNER_SCOPED_STORAGE_KEYS = Object.freeze([
  'local_run_memories',
  'pending_run_uploads',
  'pending_aiui_records',
  'pending_aiui_calibration_events',
  WORKOUT_COMPLETION_QUEUE_KEY,
  WORKOUT_COMPLETION_QUEUE_STATE_KEY,
  WORKOUT_COMPLETION_QUARANTINE_KEY,
  WORKOUT_COMPLETION_QUARANTINE_STATE_KEY,
  'smartrun_workout_plan_v2',
  HEART_RATE_POLICY_STORAGE_KEY,
  WORKOUT_EXECUTION_CACHE_KEY,
  WORKOUT_EXECUTION_STATE_KEY,
  LEGACY_SPORT_AGENT_QUEUE_KEY,
  LEGACY_SPORT_AGENT_QUEUE_STATE_KEY,
  'run_upload_receipts_v1',
  'quarantined_run_uploads_v1',
  'quarantined_aiui_calibration_events_v1',
  'pending_run_summary',
  'run_snapshot',
  'smartrun_hud_weather_v1',
  // v1 可能含旧 GPS 漂移学习结果；owner 轮换时新旧版本都必须清理。
  'smartrun_adaptive_stride_v1',
  'smartrun_adaptive_stride_v2',
  'aiui_run_finished_at',
  'aiui_host_backspace_source',
  PREIDENTITY_OWNER_STORAGE_KEY,
  LEGACY_DEVICE_ID_STORAGE_KEY,
  LEGACY_COACH_TOKEN_STORAGE_KEY,
  LEGACY_MIGRATION_STATE_STORAGE_KEY,
  'coach_token',
]);

export const DEVICE_BOOTSTRAP_PATH = '/api/coach-svc/coach/device-bootstrap';
export const DEVICE_REGISTRATION_CREDENTIAL_PATH =
  '/api/coach-svc/coach/device-registration-credential';
export const DEVICE_PAIR_STATUS_PATH = '/api/coach-svc/coach/device-pair-status';

const INSTALLATION_ID_STORAGE_PROBE = 'installation-probe-v1';
const DEVICE_CREDENTIAL_PROBE_STORAGE_KEY = 'smartrun_device_credential_probe';
const DEVICE_CREDENTIAL_STORAGE_PROBE = 'credential-probe-v1-0123456789abcdef0123456789abcdef';
const OWNER_TRANSITION_PROBE_STORAGE_KEY = 'smartrun_owner_transition_probe';
const OWNER_TRANSITION_STORAGE_PROBE = 'owner-probe-v1';
const OWNER_SCOPED_ARRAY_KEYS = Object.freeze([
  'local_run_memories',
  'pending_run_uploads',
  'pending_aiui_records',
  'pending_aiui_calibration_events',
  WORKOUT_COMPLETION_QUEUE_KEY,
  WORKOUT_COMPLETION_QUARANTINE_KEY,
  LEGACY_SPORT_AGENT_QUEUE_KEY,
  'run_upload_receipts_v1',
  'quarantined_run_uploads_v1',
  'quarantined_aiui_calibration_events_v1',
]);
const registrationCredentialInflight = new WeakMap();
const recoveryCredentialInflight = new WeakMap();
const registrationBootstrapInflight = new WeakMap();
// 已激活身份允许首页与沉浸页并行刷新，但同一 storage/长期凭据的迟到响应
// 不能覆盖较新请求已经提交的 token/owner marker。只在当前 JS 生命周期内
// 保存请求代次；真正的所有权单调性仍由下方持久化前的 epoch 检查兜底。
const activeBootstrapRequestStates = new WeakMap();

function compact(value, max = 160) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function activeBootstrapCredentialKey(local) {
  const installationId = compact(local && local.installationId, 160);
  const credential = normalizeDeviceCredential(local && local.deviceCredential)
    || normalizeDeviceSecret(local && local.deviceSecret);
  return installationId && credential ? installationId + '\u0000' + credential : '';
}

function beginActiveBootstrapRequest(storage, local) {
  if (!storage || (typeof storage !== 'object' && typeof storage !== 'function')) return null;
  const credentialKey = activeBootstrapCredentialKey(local);
  if (!credentialKey) return null;
  let state = activeBootstrapRequestStates.get(storage);
  if (!state || state.credentialKey !== credentialKey) {
    state = {
      credentialKey,
      nextGeneration: 0,
      latestCommittedGeneration: 0,
    };
    activeBootstrapRequestStates.set(storage, state);
  }
  state.nextGeneration += 1;
  return {
    state,
    generation: state.nextGeneration,
    // 请求开始时固定二件套。后续 fresh recovery 即使返回更低 epoch，
    // 也会通过 storage 中当前二件套变化使所有旧响应无条件失效。
    credentialKey,
  };
}

function activeBootstrapResponseIsSuperseded(storage, ticket, parsed) {
  if (!ticket) return false;
  const state = activeBootstrapRequestStates.get(storage);
  if (!state || state !== ticket.state) return true;
  const currentCredentialKey = activeBootstrapCredentialKey({
    installationId: readString(storage, INSTALLATION_ID_STORAGE_KEY),
    deviceCredential: readString(storage, DEVICE_CREDENTIAL_STORAGE_KEY, 2048),
    deviceSecret: readString(storage, DEVICE_SECRET_STORAGE_KEY),
  });
  // ownership_epoch 只在同一长期设备凭据内单调；二件套一旦被显式恢复流程
  // 轮换，旧 owner 的更高 epoch 也绝不能覆盖新匿名身份。
  if (!currentCredentialKey || currentCredentialKey !== ticket.credentialKey) return true;
  const current = readBinding(storage);
  const currentEpoch = normalizeOwnershipEpoch(current && current.ownershipEpoch);
  const responseEpoch = normalizeOwnershipEpoch(parsed && parsed.ownershipEpoch);
  // 所有权 epoch 比请求先后更权威：即使较早发出的请求较晚拿到更高 epoch，
  // 也允许它推进；相同或更旧 epoch 则由最新已提交请求获胜。
  if (currentEpoch !== null && responseEpoch !== null && responseEpoch < currentEpoch) return true;
  return state.latestCommittedGeneration > ticket.generation
    && (currentEpoch === null || responseEpoch === null || responseEpoch <= currentEpoch);
}

function markActiveBootstrapCommitted(storage, ticket) {
  if (!ticket) return;
  const state = activeBootstrapRequestStates.get(storage);
  if (!state || state !== ticket.state) return;
  state.latestCommittedGeneration = Math.max(
    state.latestCommittedGeneration,
    ticket.generation,
  );
}

/**
 * User-facing AIUI locator. It is deliberately separate from public_device_id,
 * device_secret and the scoped bearer token: eight characters are suitable for
 * transcription, never for authentication.
 */
export function normalizeAiuiId(value) {
  return compact(value, 32).replace(/[\s-]/g, '').toUpperCase();
}

export function isValidAiuiId(value) {
  const normalized = normalizeAiuiId(value);
  return /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{8}$/.test(normalized);
}

export function formatAiuiId(value) {
  const source = value && typeof value === 'object' ? value.aiuiId : value;
  const normalized = normalizeAiuiId(source);
  if (!isValidAiuiId(normalized)) return '待分配';
  return normalized.slice(0, 4) + ' ' + normalized.slice(4);
}

function readAiuiId(storage, publicDeviceId = '', binding = null) {
  // A visible locator is meaningful only beside a complete owner marker. If
  // the binding record was lost or a transition is being replayed, hiding the
  // alias is safer than presenting an ID that may belong to the former owner.
  if (!binding) return '';
  let raw;
  try {
    if (!storage || typeof storage.getStorageSync !== 'function') return '';
    raw = storage.getStorageSync(AIUI_ID_STORAGE_KEY);
  } catch (_e) {
    return '';
  }
  // 滚动升级兼容早期仅保存字符串的开发包；正式格式会把 AIUI ID 与内部
  // public_device_id 成对保存，fresh identity 后不会误显示旧设备的别名。
  if (typeof raw === 'string') {
    return isValidAiuiId(raw) ? normalizeAiuiId(raw) : '';
  }
  if (!raw || typeof raw !== 'object') return '';
  const aiuiId = normalizeAiuiId(raw.aiuiId);
  const owner = compact(raw.publicDeviceId, 160);
  const expectedOwner = compact(publicDeviceId, 160);
  if (!isValidAiuiId(aiuiId) || !owner || (expectedOwner && owner !== expectedOwner)) return '';
  const storedEpoch = normalizeOwnershipEpoch(raw.ownershipEpoch);
  const storedNamespace = compact(raw.dataNamespace, 200);
  // v0.1.49 records do not contain these fields; accept them only while the
  // complete binding marker still exists. New records bind the alias to the
  // exact owner lifecycle so a stale ID cannot cross an unbind boundary.
  if (storedEpoch !== null && storedEpoch !== binding.ownershipEpoch) return '';
  if (storedNamespace && storedNamespace !== binding.dataNamespace) return '';
  return aiuiId;
}

function persistAiuiId(storage, aiuiId, publicDeviceId, binding) {
  const normalized = normalizeAiuiId(aiuiId);
  const owner = compact(publicDeviceId, 160);
  if (!isValidAiuiId(normalized) || !owner || !binding) return false;
  if (!writeValue(storage, AIUI_ID_STORAGE_KEY, {
    aiuiId: normalized,
    publicDeviceId: owner,
    ownershipEpoch: binding.ownershipEpoch,
    dataNamespace: binding.dataNamespace,
  })) return false;
  return readAiuiId(storage, owner, binding) === normalized;
}

function readString(storage, key, max = 160) {
  try {
    if (!storage || typeof storage.getStorageSync !== 'function') return '';
    return compact(storage.getStorageSync(key), max);
  } catch (_e) {
    return '';
  }
}

function writeValue(storage, key, value) {
  try {
    if (!storage || typeof storage.setStorageSync !== 'function') return false;
    storage.setStorageSync(key, value);
    return true;
  } catch (_e) {
    return false;
  }
}

function removeValue(storage, key) {
  try {
    if (!storage || typeof storage.removeStorageSync !== 'function') return false;
    storage.removeStorageSync(key);
    return true;
  } catch (_e) {
    return false;
  }
}

function readRawResult(storage, key) {
  try {
    if (!storage || typeof storage.getStorageSync !== 'function') {
      return { readable: false, value: undefined };
    }
    return { readable: true, value: storage.getStorageSync(key) };
  } catch (_e) {
    return { readable: false, value: undefined };
  }
}

function isEmptyStorageValue(value, fallback) {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(fallback) && Array.isArray(value) && value.length === 0) return true;
  if (fallback && typeof fallback === 'object' && value && typeof value === 'object') {
    try { return JSON.stringify(value) === JSON.stringify(fallback); } catch (_e) { return false; }
  }
  return false;
}

function storageValueHasContent(value) {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function ownerStateHash(value) {
  let text = '';
  try { text = JSON.stringify(value); } catch (_e) { return ''; }
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function ownerStateRecord(targetKey, value) {
  return {
    schema_version: 1,
    target_key: targetKey,
    value_digest: ownerStateHash(value),
    committed_value: value,
  };
}

function ownerStateCommittedValue(value, targetKey) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schema_version !== 1 || value.target_key !== targetKey
      || typeof value.value_digest !== 'string'
      || !Object.prototype.hasOwnProperty.call(value, 'committed_value')
      || ownerStateHash(value.committed_value) !== value.value_digest) {
    return { ok: false, value: undefined };
  }
  return { ok: true, value: value.committed_value };
}

function isEmptyWorkoutExecution(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && value.__smartrun_workout_execution_empty_v1__ === true
    && Object.keys(value).length === 1;
}

function storageValueHasOwnerContent(key, value) {
  if (value === undefined || value === null || value === '') return false;
  if (key === WORKOUT_EXECUTION_CACHE_KEY && isEmptyWorkoutExecution(value)) return false;
  let targetKey = '';
  if (key === WORKOUT_COMPLETION_QUEUE_STATE_KEY) targetKey = WORKOUT_COMPLETION_QUEUE_KEY;
  if (key === WORKOUT_COMPLETION_QUARANTINE_STATE_KEY) {
    targetKey = WORKOUT_COMPLETION_QUARANTINE_KEY;
  }
  if (key === WORKOUT_EXECUTION_STATE_KEY) targetKey = WORKOUT_EXECUTION_CACHE_KEY;
  if (key === LEGACY_SPORT_AGENT_QUEUE_STATE_KEY) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.schema_version !== 1
        || value.target_key !== LEGACY_SPORT_AGENT_QUEUE_KEY
        || !Array.isArray(value.value)
        || value.hash !== '741638a5'
        || value.value.length !== 0) return true;
    return false;
  }
  if (!targetKey) return storageValueHasContent(value);
  const committed = ownerStateCommittedValue(value, targetKey);
  // Malformed metadata may be the only surviving evidence of private owner data.
  if (!committed.ok) return true;
  if (targetKey === WORKOUT_EXECUTION_CACHE_KEY) {
    return !isEmptyWorkoutExecution(committed.value);
  }
  return storageValueHasContent(committed.value);
}

/**
 * 判断当前隔离 storage 是否仍含 owner 私有数据。preidentity 哨兵本身不算
 * 私有 payload；若任一读取异常则按“可能存在”处理，调用方只能 fail closed。
 */
export function hasOwnerScopedPrivateData(storage) {
  // The field-log index points at dynamic chunk keys that cannot be enumerated
  // in OWNER_SCOPED_STORAGE_KEYS. Even an empty-but-present index is treated as
  // owner evidence so a partial/crashed cleanup cannot be mistaken for a clean
  // first installation.
  const fieldLogIndex = readRawResult(storage, RUNNING_LOCAL_FIELD_LOG_KEY);
  if (!fieldLogIndex.readable || storageValueHasContent(fieldLogIndex.value)) return true;
  for (let i = 0; i < OWNER_SCOPED_STORAGE_KEYS.length; i += 1) {
    const key = OWNER_SCOPED_STORAGE_KEYS[i];
    if (key === PREIDENTITY_OWNER_STORAGE_KEY) continue;
    const result = readRawResult(storage, key);
    if (!result.readable || storageValueHasOwnerContent(key, result.value)) return true;
  }
  return false;
}

function clearRunningLocalFieldLogsForOwnerTransition(storage) {
  // Preserve the raw index until all referenced chunks and the index itself
  // have been proven absent. The archive clear may remove the index after a
  // partial chunk failure; restoring the index leaves a retryable journal
  // instead of an undiscoverable owner-private orphan.
  const indexPreimage = readRawResult(storage, RUNNING_LOCAL_FIELD_LOG_KEY);
  if (!indexPreimage.readable) return false;
  const result = clearRunningLocalFieldLogs(storage);
  if (result && result.ok === true) return true;
  restoreRawValue(storage, RUNNING_LOCAL_FIELD_LOG_KEY, indexPreimage.value);
  return false;
}

function freshFallback(value) {
  if (Array.isArray(value)) return [];
  if (value && typeof value === 'object') {
    try { return JSON.parse(JSON.stringify(value)); } catch (_e) { return value; }
  }
  return value;
}

/**
 * Remove a value and prove it is unreadable/semantically empty. Some AIUI hosts
 * have returned successfully from removeStorageSync without deleting anything;
 * an empty value is therefore written only when the key has a type-safe empty
 * representation, and that fallback is read back before success is reported.
 */
function clearStorageValueVerified(storage, key, fallback) {
  removeValue(storage, key);
  let result = readRawResult(storage, key);
  if (!result.readable) return false;
  if (isEmptyStorageValue(result.value, fallback)) return true;
  if (fallback === undefined || !writeValue(storage, key, freshFallback(fallback))) return false;
  result = readRawResult(storage, key);
  return result.readable && isEmptyStorageValue(result.value, fallback);
}

function ownerScopedFallback(key) {
  if (key === WORKOUT_COMPLETION_QUEUE_STATE_KEY) {
    return ownerStateRecord(WORKOUT_COMPLETION_QUEUE_KEY, []);
  }
  if (key === WORKOUT_COMPLETION_QUARANTINE_STATE_KEY) {
    return ownerStateRecord(WORKOUT_COMPLETION_QUARANTINE_KEY, []);
  }
  if (key === WORKOUT_EXECUTION_CACHE_KEY) return WORKOUT_EXECUTION_EMPTY;
  if (key === WORKOUT_EXECUTION_STATE_KEY) {
    return ownerStateRecord(WORKOUT_EXECUTION_CACHE_KEY, WORKOUT_EXECUTION_EMPTY);
  }
  if (key === LEGACY_SPORT_AGENT_QUEUE_STATE_KEY) {
    return {
      schema_version: 1,
      target_key: LEGACY_SPORT_AGENT_QUEUE_KEY,
      value: [],
      hash: '741638a5',
    };
  }
  return OWNER_SCOPED_ARRAY_KEYS.indexOf(key) >= 0 ? [] : '';
}

function hasWorkoutOwnerStorageEvidence(storage) {
  const keys = [
    WORKOUT_COMPLETION_QUEUE_KEY,
    WORKOUT_COMPLETION_QUEUE_STATE_KEY,
    WORKOUT_COMPLETION_QUARANTINE_KEY,
    WORKOUT_COMPLETION_QUARANTINE_STATE_KEY,
    WORKOUT_EXECUTION_CACHE_KEY,
    WORKOUT_EXECUTION_STATE_KEY,
    LEGACY_SPORT_AGENT_QUEUE_KEY,
    LEGACY_SPORT_AGENT_QUEUE_STATE_KEY,
  ];
  for (let index = 0; index < keys.length; index += 1) {
    const result = readRawResult(storage, keys[index]);
    if (!result.readable) return true;
    if (result.value !== undefined && result.value !== null && result.value !== '') return true;
  }
  return false;
}

function hasHeartRatePolicyStorageEvidence(storage) {
  const result = readRawResult(storage, HEART_RATE_POLICY_STORAGE_KEY);
  // An unreadable owner-scoped key is possible private evidence. The
  // standalone transaction will fail closed if it cannot capture a preimage.
  return !result.readable
    || (result.value !== undefined && result.value !== null && result.value !== '');
}

function verifyStorageRoundTrip(storage, key, value, max = 160) {
  if (!writeValue(storage, key, value)) return false;
  return readString(storage, key, max) === value;
}

export function hasIdentityEverActivated(storage) {
  return readString(storage, IDENTITY_EVER_ACTIVATED_STORAGE_KEY, 80)
    === IDENTITY_EVER_ACTIVATED_VALUE;
}

function persistIdentityEverActivated(storage) {
  if (hasIdentityEverActivated(storage)) return true;
  return verifyStorageRoundTrip(
    storage,
    IDENTITY_EVER_ACTIVATED_STORAGE_KEY,
    IDENTITY_EVER_ACTIVATED_VALUE,
    80,
  );
}

function probeDeviceCredentialStorage(storage) {
  const ok = verifyStorageRoundTrip(
    storage, DEVICE_CREDENTIAL_PROBE_STORAGE_KEY, DEVICE_CREDENTIAL_STORAGE_PROBE,
  );
  removeValue(storage, DEVICE_CREDENTIAL_PROBE_STORAGE_KEY);
  return ok;
}

function probeInstallationIdStorage(storage) {
  const ok = verifyStorageRoundTrip(
    storage, INSTALLATION_ID_STORAGE_KEY, INSTALLATION_ID_STORAGE_PROBE, 40,
  );
  if (!ok) {
    removeValue(storage, INSTALLATION_ID_STORAGE_KEY);
    return false;
  }
  // 这里只短暂写入固定 probe 并验证清除，不生成或留下本地 installation ID。
  return clearStorageValueVerified(storage, INSTALLATION_ID_STORAGE_KEY, '');
}

// journal 读取异常时，必须先证明其余同步 storage 仍能正常读写，才能把问题
// 归类为“这个键自身损坏”。全局/瞬时 storage 故障只允许 fail closed，绝不能
// 借自愈之名清除 owner 数据。
function probeOwnerTransitionStorage(storage) {
  const before = readRawResult(storage, OWNER_TRANSITION_PROBE_STORAGE_KEY);
  if (!before.readable) return false;
  const ok = verifyStorageRoundTrip(
    storage, OWNER_TRANSITION_PROBE_STORAGE_KEY, OWNER_TRANSITION_STORAGE_PROBE, 40,
  );
  if (!ok) return false;
  return clearStorageValueVerified(storage, OWNER_TRANSITION_PROBE_STORAGE_KEY, '');
}

function isDeviceSecretUnverified(storage) {
  return readString(storage, DEVICE_SECRET_BOOTSTRAP_STATE_STORAGE_KEY, 40) === 'unverified';
}

function markDeviceSecretUnverified(storage) {
  return verifyStorageRoundTrip(
    storage, DEVICE_SECRET_BOOTSTRAP_STATE_STORAGE_KEY, 'unverified', 40,
  );
}

function clearDeviceSecretUnverified(storage) {
  removeValue(storage, DEVICE_SECRET_BOOTSTRAP_STATE_STORAGE_KEY);
  if (!isDeviceSecretUnverified(storage)) return true;
  if (!writeValue(storage, DEVICE_SECRET_BOOTSTRAP_STATE_STORAGE_KEY, 'verified')) return false;
  return !isDeviceSecretUnverified(storage);
}

function isHardwareFingerprintSuppressed(storage, installationId) {
  const suppressedFor = readString(
    storage, HARDWARE_FINGERPRINT_SUPPRESSED_STORAGE_KEY, 160,
  );
  return !!suppressedFor && suppressedFor === compact(installationId, 160);
}

function persistHardwareFingerprintSuppression(storage, installationId) {
  const value = compact(installationId, 160);
  return !!value && verifyStorageRoundTrip(
    storage, HARDWARE_FINGERPRINT_SUPPRESSED_STORAGE_KEY, value, 160,
  );
}

function readRecoveryState(storage) {
  const value = readString(storage, DEVICE_RECOVERY_STATE_STORAGE_KEY, 220);
  return value === 'required' || value.startsWith('pending:') ? value : '';
}

function persistRecoveryState(storage, value) {
  return verifyStorageRoundTrip(storage, DEVICE_RECOVERY_STATE_STORAGE_KEY, value, 220);
}

function clearRecoveryState(storage) {
  removeValue(storage, DEVICE_RECOVERY_STATE_STORAGE_KEY);
  if (!readRecoveryState(storage)) return true;
  // 极少数宿主 remove 失效但 set 可用；写非状态值也能解除恢复棘轮。
  if (!writeValue(storage, DEVICE_RECOVERY_STATE_STORAGE_KEY, 'complete')) return false;
  return !readRecoveryState(storage);
}

function readRecoveryCandidate(storage) {
  try {
    if (!storage || typeof storage.getStorageSync !== 'function') return null;
    const raw = storage.getStorageSync(DEVICE_RECOVERY_CANDIDATE_STORAGE_KEY);
    if (!raw || typeof raw !== 'object') return null;
    const installationId = compact(raw.installationId || raw.installation_id, 160);
    const deviceCredential = normalizeDeviceCredential(
      raw.deviceCredential || raw.device_credential,
    );
    return installationId && deviceCredential
      ? { installationId, deviceCredential } : null;
  } catch (_e) {
    return null;
  }
}

function persistRecoveryCandidate(storage, candidate) {
  const normalized = candidate && {
    installationId: compact(candidate.installationId, 160),
    deviceCredential: normalizeDeviceCredential(candidate.deviceCredential),
  };
  if (!normalized || !normalized.installationId || !normalized.deviceCredential
      || !writeValue(storage, DEVICE_RECOVERY_CANDIDATE_STORAGE_KEY, normalized)) {
    return false;
  }
  const stored = readRecoveryCandidate(storage);
  return !!stored
    && stored.installationId === normalized.installationId
    && stored.deviceCredential === normalized.deviceCredential;
}

function clearRecoveryCandidate(storage) {
  removeValue(storage, DEVICE_RECOVERY_CANDIDATE_STORAGE_KEY);
  if (!readRecoveryCandidate(storage)) return true;
  if (!writeValue(storage, DEVICE_RECOVERY_CANDIDATE_STORAGE_KEY, 'complete')) return false;
  return !readRecoveryCandidate(storage);
}

function normalizeDeviceCredential(value) {
  const credential = compact(value, 2048);
  return credential.length >= 32 ? credential : '';
}

function readRegistrationCandidate(storage) {
  try {
    if (!storage || typeof storage.getStorageSync !== 'function') return null;
    const raw = storage.getStorageSync(DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY);
    if (!raw || typeof raw !== 'object') return null;
    const installationId = compact(raw.installationId || raw.installation_id, 160);
    const deviceCredential = normalizeDeviceCredential(
      raw.deviceCredential || raw.device_credential,
    );
    if (!installationId || !deviceCredential) return null;
    return { installationId, deviceCredential };
  } catch (_e) {
    return null;
  }
}

function persistRegistrationCandidate(storage, candidate) {
  const normalized = candidate && {
    installationId: compact(candidate.installationId, 160),
    deviceCredential: normalizeDeviceCredential(candidate.deviceCredential),
  };
  if (!normalized || !normalized.installationId || !normalized.deviceCredential
      || !writeValue(storage, DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY, normalized)) {
    return false;
  }
  const stored = readRegistrationCandidate(storage);
  return !!stored
    && stored.installationId === normalized.installationId
    && stored.deviceCredential === normalized.deviceCredential;
}

function sameRegistrationCandidate(left, right) {
  return !!left && !!right
    && left.installationId === right.installationId
    && left.deviceCredential === right.deviceCredential;
}

function clearRegistrationCandidate(storage) {
  removeValue(storage, DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY);
  if (!readRegistrationCandidate(storage)) return true;
  // removeStorageSync 在少数旧宿主中可能静默失效；写入不可解析的完成哨兵，
  // 确保已提交的 pending journal 不会在下次启动时再次进入首次注册链。
  if (!writeValue(storage, DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY, 'complete')) return false;
  return !readRegistrationCandidate(storage);
}

function restoreRawValue(storage, key, value) {
  if (value === undefined || value === null || value === '') {
    return clearStorageValueVerified(storage, key, '');
  }
  if (!writeValue(storage, key, value)) return false;
  const restored = readRawResult(storage, key);
  if (!restored.readable) return false;
  if (restored.value === value) return true;
  try {
    return JSON.stringify(restored.value) === JSON.stringify(value);
  } catch (_e) {
    return false;
  }
}

function normalizeDeviceSecret(value) {
  const secret = compact(value, 160);
  return secret.length >= 32 && secret.length <= 160 ? secret : '';
}

function readLegacyMigrationState(storage) {
  try {
    if (!storage || typeof storage.getStorageSync !== 'function') return null;
    const raw = storage.getStorageSync(LEGACY_MIGRATION_STATE_STORAGE_KEY);
    if (!raw || typeof raw !== 'object' || raw.complete !== true) return null;
    const legacyDeviceId = compact(raw.legacyDeviceId || raw.legacy_device_id, 160);
    return legacyDeviceId ? { complete: true, legacyDeviceId } : null;
  } catch (_e) {
    return null;
  }
}

function persistLegacyMigrationComplete(storage, legacyDeviceId) {
  const value = { complete: true, legacyDeviceId: compact(legacyDeviceId, 160) };
  if (!value.legacyDeviceId
      || !writeValue(storage, LEGACY_MIGRATION_STATE_STORAGE_KEY, value)) return false;
  const stored = readLegacyMigrationState(storage);
  return !!stored && stored.legacyDeviceId === value.legacyDeviceId;
}

function retireLegacyMigrationToken(storage) {
  removeValue(storage, LEGACY_COACH_TOKEN_STORAGE_KEY);
  if (!readString(storage, LEGACY_COACH_TOKEN_STORAGE_KEY, 4096)) return true;
  // remove 失效时用非 JWT 哨兵覆盖，确保旧 bearer 不再被读取或发送。
  if (!verifyStorageRoundTrip(storage, LEGACY_COACH_TOKEN_STORAGE_KEY, 'retired', 4096)) {
    return false;
  }
  return true;
}

function decodeJwtPayload(token, atobFn) {
  const value = compact(token, 4096);
  const parts = value.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  let decode = atobFn;
  if (typeof decode !== 'function') {
    try { decode = typeof atob === 'function' ? atob : null; } catch (_e) { decode = null; }
  }
  if (typeof decode !== 'function') return null;
  try {
    let body = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (body.length % 4) body += '=';
    const parsed = JSON.parse(decode(body));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_e) {
    return null;
  }
}

/** 只把明确的 user JWT（以及历史无 kind 的 user JWT）当作一次性迁移证明。 */
export function looksLikeLegacyUserToken(token, opts = {}) {
  const payload = decodeJwtPayload(token, opts.atobFn);
  if (!payload) return false;
  if (payload.kind === 'aiui_device') return false;
  if (payload.kind !== undefined && payload.kind !== null && payload.kind !== '') {
    return payload.kind === 'user';
  }
  return payload.sub !== undefined && payload.sub !== null && String(payload.sub).length > 0;
}

function prepareLegacyMigrationProof(storage, local, opts = {}) {
  const legacyDeviceId = compact(local && local.legacyDeviceId, 160);
  if (!legacyDeviceId) return { legacyDeviceId: '', token: '', complete: false };
  const completed = readLegacyMigrationState(storage);
  if (completed && completed.legacyDeviceId === legacyDeviceId) {
    return { legacyDeviceId, token: '', complete: true };
  }
  let token = readString(storage, LEGACY_COACH_TOKEN_STORAGE_KEY, 4096);
  if (!looksLikeLegacyUserToken(token, opts)) token = '';
  if (!token && opts.coachTokenStorageKey) {
    const coachToken = readString(storage, opts.coachTokenStorageKey, 4096);
    // 新 device token 与旧 user token 可能同时存在；绝不能把 device token 当迁移证明。
    if (coachToken && coachToken !== (local && local.deviceToken)
        && looksLikeLegacyUserToken(coachToken, opts)) token = coachToken;
  }
  if (!token) return { legacyDeviceId, token: '', complete: false };
  if (!verifyStorageRoundTrip(storage, LEGACY_COACH_TOKEN_STORAGE_KEY, token, 4096)) {
    return { legacyDeviceId, token: '', complete: false, storageUnavailable: true };
  }
  return { legacyDeviceId, token, complete: false };
}

function completeLegacyMigration(storage, proof, parsed, opts = {}) {
  if (!proof || !proof.legacyDeviceId || !parsed || parsed.legacyMigrationComplete !== true) {
    return false;
  }
  // 先 durable 标记响应已确认；旧 JWT 仍有单独副本，因此后续任一步失败都可恢复。
  if (!persistLegacyMigrationComplete(storage, proof.legacyDeviceId)) return false;
  if (opts.coachTokenStorageKey && !verifyStorageRoundTrip(
    storage, opts.coachTokenStorageKey, parsed.token, 4096,
  )) return false;
  return retireLegacyMigrationToken(storage);
}

function normalizeOwnershipEpoch(value) {
  if (value === null || value === undefined || value === '') return null;
  const epoch = Number(value);
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null;
}

function readOwnerTransitionState(storage) {
  const result = readRawResult(storage, OWNER_TRANSITION_PENDING_STORAGE_KEY);
  if (!result.readable) return { readable: false, pending: true, marker: null };
  const raw = result.value;
  if (raw === undefined || raw === null || raw === '' || raw === 'complete') {
    return { readable: true, pending: false, marker: null };
  }
  if (typeof raw !== 'object') {
    // 无法解析的非空 journal 不能当作“不存在”；保守重放整套清理。
    return { readable: true, pending: true, marker: null };
  }
  const ownershipEpoch = normalizeOwnershipEpoch(raw.ownershipEpoch);
  const dataNamespace = compact(raw.dataNamespace, 200);
  if (ownershipEpoch === null || !dataNamespace) {
    return { readable: true, pending: true, marker: null };
  }
  return {
    readable: true,
    pending: true,
    marker: { ownershipEpoch, dataNamespace, bound: raw.bound === true },
  };
}

function readOwnerTransitionPending(storage) {
  return readOwnerTransitionState(storage).marker;
}

function stageOwnerTransition(storage, next) {
  const marker = {
    ownershipEpoch: next.ownershipEpoch,
    dataNamespace: next.dataNamespace,
    bound: next.bound === true,
  };
  if (!writeValue(storage, OWNER_TRANSITION_PENDING_STORAGE_KEY, marker)) return false;
  const stored = readOwnerTransitionPending(storage);
  return !!stored
    && stored.ownershipEpoch === marker.ownershipEpoch
    && stored.dataNamespace === marker.dataNamespace
    && stored.bound === marker.bound;
}

function clearOwnerTransitionPending(storage) {
  removeValue(storage, OWNER_TRANSITION_PENDING_STORAGE_KEY);
  let state = readOwnerTransitionState(storage);
  if (!state.readable) return false;
  if (!state.pending) return true;
  // remove 失效时写非 marker 值解除启动期重放；同步 storage 调用完成后才返回。
  if (!writeValue(storage, OWNER_TRANSITION_PENDING_STORAGE_KEY, 'complete')) return false;
  state = readOwnerTransitionState(storage);
  return state.readable && !state.pending;
}

/**
 * 所有权轮换在 storage 中使用可重放的隐私清理 journal。若进程在清理与新 marker
 * 提交之间退出，下次任何身份/上传读取前都会再清一次，旧用户数据绝不穿越边界。
 */
export function replayPendingOwnerTransition(storage, opts = {}) {
  let state = readOwnerTransitionState(storage);
  if (!state.readable) {
    // 先用独立键证明其余 storage 正常，再重读一次 journal。无法证明是单键
    // 损坏时只封闭数据面，不清任何用户数据。
    if (!probeOwnerTransitionStorage(storage)) return false;
    state = readOwnerTransitionState(storage);
    if (state.readable) {
      if (!state.pending) return true;
      // 首次异常只是瞬时读失败；转入下方普通 durable replay。
    } else {
      // 连续两次仅 journal 不可读，且独立 round-trip 成功，才把它当作键级损坏。
      // 无法解析其 marker 时保守清理 owner 数据与半提交身份，然后以 remove 或
      // 可读的 complete 哨兵覆盖损坏值；任一步失败都继续 fail closed。
      const ownerStateCleared = clearOwnerScopedState(storage);
      const tokenCleared = clearStorageValueVerified(storage, DEVICE_TOKEN_STORAGE_KEY, '');
      const bindingCleared = clearStorageValueVerified(storage, DEVICE_BINDING_STORAGE_KEY, '');
      const aliasCleared = clearStorageValueVerified(storage, AIUI_ID_STORAGE_KEY, '');
      if (!ownerStateCleared || !tokenCleared || !bindingCleared || !aliasCleared) return false;
      if (typeof opts.onReplayed === 'function') {
        try { opts.onReplayed(); } catch (_e) {}
      }
      removeValue(storage, OWNER_TRANSITION_PENDING_STORAGE_KEY);
      let recovered = readOwnerTransitionState(storage);
      if (recovered.readable && !recovered.pending) return true;
      if (!writeValue(storage, OWNER_TRANSITION_PENDING_STORAGE_KEY, 'complete')) return false;
      recovered = readOwnerTransitionState(storage);
      return recovered.readable && !recovered.pending;
    }
  }
  if (!state.pending) return false;
  const ownerStateCleared = clearOwnerScopedState(storage);
  // 进程可能在写入新 token/binding 后、清 journal 前退出；重放时必须同时
  // 撤销这些可能属于新 owner 的半提交认证，避免混用旧队列与新凭据。
  const tokenCleared = clearStorageValueVerified(storage, DEVICE_TOKEN_STORAGE_KEY, '');
  const bindingCleared = clearStorageValueVerified(storage, DEVICE_BINDING_STORAGE_KEY, '');
  const aliasCleared = clearStorageValueVerified(storage, AIUI_ID_STORAGE_KEY, '');
  if (!ownerStateCleared || !tokenCleared || !bindingCleared || !aliasCleared) return false;
  if (typeof opts.onReplayed === 'function') {
    try { opts.onReplayed(); } catch (_e) {}
  }
  return clearOwnerTransitionPending(storage);
}

/**
 * owner journal 未完成或无法读取时，所有队列、记忆、总结与 owner token 都必须停用。
 * 调用会先尝试幂等重放；只有清理和 journal 提交均读回验证后才开放数据面。
 */
export function ownerScopedDataAvailable(storage, opts = {}) {
  let state = readOwnerTransitionState(storage);
  if (!state.readable) {
    if (!replayPendingOwnerTransition(storage, opts)) return false;
    state = readOwnerTransitionState(storage);
  }
  if (!state.pending) return true;
  if (!replayPendingOwnerTransition(storage, opts)) return false;
  state = readOwnerTransitionState(storage);
  const available = state.readable && !state.pending;
  return available;
}

function readBinding(storage) {
  try {
    if (!storage || typeof storage.getStorageSync !== 'function') return null;
    const raw = storage.getStorageSync(DEVICE_BINDING_STORAGE_KEY);
    if (!raw || typeof raw !== 'object') return null;
    return {
      bound: raw.bound === true,
      agentInstanceId: compact(raw.agentInstanceId || raw.agent_instance_id),
      agentAlias: compact(raw.agentAlias || raw.agent_alias, 80),
      ownershipEpoch: normalizeOwnershipEpoch(
        raw.ownershipEpoch !== undefined ? raw.ownershipEpoch : raw.ownership_epoch,
      ),
      dataNamespace: compact(raw.dataNamespace || raw.data_namespace, 200),
      updatedAtMs: Number.isFinite(Number(raw.updatedAtMs)) ? Number(raw.updatedAtMs) : 0,
    };
  } catch (_e) {
    return null;
  }
}

/**
 * 读取并补齐本地身份。legacyDeviceId 只读不改，供旧匿名账号迁移；
 * effectiveDeviceId 供旧 anon-login 兼容，不代表后端最终公开设备号。
 */
export function ensureLocalDeviceIdentity(storage, opts = {}) {
  const ownerDataReady = ownerScopedDataAvailable(storage);
  const legacyDeviceId = ownerDataReady
    ? readString(storage, LEGACY_DEVICE_ID_STORAGE_KEY) : '';
  let installationId = readString(storage, INSTALLATION_ID_STORAGE_KEY);
  let installationIdStorageReady = false;
  if (installationId) {
    installationIdStorageReady = verifyStorageRoundTrip(
      storage, INSTALLATION_ID_STORAGE_KEY, installationId, 160,
    );
  } else {
    // 新安装 ID 完全由服务器签发；首次联网前只验证独立 probe 键，不在 active
    // installation_id 键生成或保存本地占位值。
    installationIdStorageReady = probeInstallationIdStorage(storage);
  }
  const publicDeviceId = readString(storage, PUBLIC_DEVICE_ID_STORAGE_KEY);
  // JWT 通常远长于普通设备字段；绝不能套用 160 字符默认上限截断认证。
  const deviceToken = ownerDataReady
    ? readString(storage, DEVICE_TOKEN_STORAGE_KEY, 4096) : '';
  const deviceCredential = normalizeDeviceCredential(
    readString(storage, DEVICE_CREDENTIAL_STORAGE_KEY, 2048),
  );
  // 旧版 active 身份仍可使用已经落盘的 device_secret 刷新；新安装只会走
  // device_credential，绝不在眼镜端生成或向签发接口申请 secret。
  const deviceSecret = normalizeDeviceSecret(readString(storage, DEVICE_SECRET_STORAGE_KEY));
  let deviceSecretUnverified = deviceSecret ? isDeviceSecretUnverified(storage) : false;
  let deviceCredentialStorageReady = false;
  if (deviceCredential) {
    deviceCredentialStorageReady = verifyStorageRoundTrip(
      storage, DEVICE_CREDENTIAL_STORAGE_KEY, deviceCredential, 2048,
    );
  } else if (deviceSecret) {
    // 重写同值并读回，捕获“能读旧值但当前 storage 已只读/失效”的宿主状态。
    deviceCredentialStorageReady = verifyStorageRoundTrip(
      storage, DEVICE_SECRET_STORAGE_KEY, deviceSecret,
    );
  } else {
    // 首次联网前只探测长期凭据键可用性；probe 不是认证凭据，也不会发送。
    deviceCredentialStorageReady = probeDeviceCredentialStorage(storage);
  }
  const binding = ownerDataReady ? readBinding(storage) : null;
  const aiuiId = ownerDataReady ? readAiuiId(storage, publicDeviceId, binding) : '';
  // 滚动升级：旧版已经具备完整 active 身份时补写永久墓碑。写失败不会破坏
  // 当前可用身份，但以后缺失身份 marker 时仍会由 private-data 检查 fail closed。
  let identityEverActivated = hasIdentityEverActivated(storage);
  if (!identityEverActivated
      && publicDeviceId
      && binding
      && (deviceCredential || deviceSecret)) {
    identityEverActivated = persistIdentityEverActivated(storage);
  }
  return {
    installationId,
    installationIdStorageReady,
    legacyDeviceId,
    publicDeviceId,
    aiuiId,
    effectiveDeviceId: publicDeviceId || legacyDeviceId || installationId,
    deviceToken,
    deviceCredential,
    deviceSecret,
    deviceSecretUnverified,
    deviceCredentialStorageReady,
    // 兼容仍引用旧字段的上层诊断；其语义已是“任一长期认证凭据可持久化”。
    deviceSecretStorageReady: deviceCredentialStorageReady,
    bound: !!(binding && binding.bound),
    agentInstanceId: binding ? binding.agentInstanceId : '',
    agentAlias: binding ? binding.agentAlias : '',
    ownershipEpoch: binding ? binding.ownershipEpoch : null,
    dataNamespace: binding ? binding.dataNamespace : '',
    identityEverActivated,
    ownerTransitionBlocked: !ownerDataReady,
  };
}

function jsonRequest({ baseUrl, path, method = 'POST', token, data }) {
  const header = { 'Content-Type': 'application/json' };
  if (token) header.Authorization = 'Bearer ' + String(token).trim();
  return {
    url: normalizeBaseUrl(baseUrl || DEFAULT_BASE_URL) + path,
    method,
    header,
    dataType: 'json',
    responseType: 'text',
    timeout: 12000,
    ...(data === undefined ? {} : { data }),
  };
}

/** 首次无服务器凭据时申请服务端生成的安装 ID 与长期不透明设备凭据。 */
export function buildDeviceRegistrationCredentialRequest(opts = {}) {
  return jsonRequest({
    baseUrl: opts.baseUrl,
    path: opts.path || DEVICE_REGISTRATION_CREDENTIAL_PATH,
    data: {
      app_id: compact(opts.clientId || 'AISmartRun', 64) || 'AISmartRun',
    },
  });
}

export function parseDeviceRegistrationCredentialResponse(resp) {
  const statusCode = Number(resp && resp.statusCode);
  if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300
      || !resp || !resp.data || typeof resp.data !== 'object') return null;
  const installationId = compact(resp.data.installation_id, 160);
  const deviceCredential = normalizeDeviceCredential(resp.data.device_credential);
  if (!installationId || !deviceCredential) return null;
  return { installationId, deviceCredential };
}

async function obtainServerRegistrationCandidate(opts = {}) {
  const cached = readRegistrationCandidate(opts.storage);
  if (cached) return { candidate: cached, fromCache: true };
  if (!opts.storage || (typeof opts.storage !== 'object' && typeof opts.storage !== 'function')) {
    return { candidate: null, storageUnavailable: true };
  }
  const inflight = registrationCredentialInflight.get(opts.storage);
  if (inflight) return inflight;
  const task = (async () => {
    // 上一个并发调用可能已在当前任务排队期间完成写入；网络前再读一次。
    const racedBeforeRequest = readRegistrationCandidate(opts.storage);
    if (racedBeforeRequest) return { candidate: racedBeforeRequest, fromCache: true };
    let response = null;
    try {
      response = await opts.request(buildDeviceRegistrationCredentialRequest({
        baseUrl: opts.baseUrl,
        clientId: opts.clientId,
      }));
    } catch (_e) {}
    const issued = parseDeviceRegistrationCredentialResponse(response);
    if (!issued) {
      return {
        candidate: null,
        response,
        statusCode: response && response.statusCode,
      };
    }
    // 迟到的签发响应绝不能覆盖另一个已经 durable 化的新候选。
    const racedAfterRequest = readRegistrationCandidate(opts.storage);
    if (racedAfterRequest) return { candidate: racedAfterRequest, fromCache: true };
    if (!persistRegistrationCandidate(opts.storage, issued)) {
      return { candidate: null, response, storageUnavailable: true };
    }
    return { candidate: readRegistrationCandidate(opts.storage), fromCache: false };
  })();
  registrationCredentialInflight.set(opts.storage, task);
  try {
    return await task;
  } finally {
    if (registrationCredentialInflight.get(opts.storage) === task) {
      registrationCredentialInflight.delete(opts.storage);
    }
  }
}

/**
 * 显式恢复使用独立候选 journal。只有 recovery state 已由用户确认后的第一次
 * 尝试推进到 pending:<installation>，后续断网重试才允许复用；普通首次注册
 * 在确认前留下的 generic candidate 永远不能被拿来轮换旧身份。
 */
async function obtainServerRecoveryCandidate(opts = {}, recoveryState = '') {
  const pendingInstallationId = recoveryState.startsWith('pending:')
    ? compact(recoveryState.slice('pending:'.length), 160) : '';
  const cached = readRecoveryCandidate(opts.storage);
  if (pendingInstallationId && cached
      && cached.installationId === pendingInstallationId) {
    return { candidate: cached, fromCache: true };
  }
  if (!opts.storage || (typeof opts.storage !== 'object'
      && typeof opts.storage !== 'function')) {
    return { candidate: null, storageUnavailable: true };
  }
  // required 状态下的任何候选都不能证明它诞生于本次可见确认之后。
  if (cached) clearRecoveryCandidate(opts.storage);
  const inflight = recoveryCredentialInflight.get(opts.storage);
  if (inflight) return inflight;
  const task = (async () => {
    const latestState = readRecoveryState(opts.storage);
    const latestPendingInstallationId = latestState.startsWith('pending:')
      ? compact(latestState.slice('pending:'.length), 160) : '';
    const racedBeforeRequest = readRecoveryCandidate(opts.storage);
    if (latestPendingInstallationId && racedBeforeRequest
        && racedBeforeRequest.installationId === latestPendingInstallationId) {
      return { candidate: racedBeforeRequest, fromCache: true };
    }
    let response = null;
    try {
      response = await opts.request(buildDeviceRegistrationCredentialRequest({
        baseUrl: opts.baseUrl,
        clientId: opts.clientId,
      }));
    } catch (_e) {}
    const issued = parseDeviceRegistrationCredentialResponse(response);
    if (!issued) {
      return {
        candidate: null,
        response,
        statusCode: response && response.statusCode,
      };
    }
    if (!persistRecoveryCandidate(opts.storage, issued)
        || !persistRecoveryState(
          opts.storage,
          'pending:' + issued.installationId,
        )) {
      return { candidate: null, response, storageUnavailable: true };
    }
    return { candidate: readRecoveryCandidate(opts.storage), fromCache: false };
  })();
  recoveryCredentialInflight.set(opts.storage, task);
  try {
    return await task;
  } finally {
    if (recoveryCredentialInflight.get(opts.storage) === task) {
      recoveryCredentialInflight.delete(opts.storage);
    }
  }
}

/** 构造设备 bootstrap；只接受服务器签发的设备凭据与旧版本迁移证明。 */
export function buildDeviceBootstrapRequest(opts = {}) {
  const data = {
    app_id: compact(opts.clientId || 'AISmartRun', 64) || 'AISmartRun',
    installation_id: compact(opts.installationId, 160),
  };
  const appKey = compact(opts.appKey, 128);
  const deviceCredential = normalizeDeviceCredential(opts.deviceCredential);
  const deviceSecret = normalizeDeviceSecret(opts.deviceSecret);
  const legacy = compact(opts.legacyDeviceId, 160);
  const legacyToken = compact(opts.legacyToken, 4096);
  if (appKey) data.app_key = appKey;
  if (deviceCredential) data.device_credential = deviceCredential;
  // 只为旧版已落盘身份保留；新注册请求永远不生成该字段。
  else if (deviceSecret) data.device_secret = deviceSecret;
  // legacy ID 只随旧 user JWT 证明发送；共享 app_key 既不是所有权证明，也不作为
  // 迁移前提。普通匿名 bootstrap 即使无 key 也绝不泄露 legacy 标识。
  if (legacy && legacyToken) data.legacy_device_id = legacy;
  return jsonRequest({
    baseUrl: opts.baseUrl,
    path: opts.path || DEVICE_BOOTSTRAP_PATH,
    token: legacy && legacyToken ? legacyToken : '',
    data,
  });
}

export function parseDeviceBootstrapResponse(resp) {
  if (!resp || resp.statusCode !== 200 || !resp.data) return null;
  const data = resp.data;
  const publicDeviceId = compact(data.public_device_id || data.device_id, 160);
  const rawAiuiId = compact(data.aiui_id, 32);
  // AIUI ID 是公开定位别名，不参与认证。旧服务缺字段或异常值只让 UI 暂时显示
  // “待分配”，不能破坏已经完整验证的 device token/bootstrap 主链。
  const aiuiId = isValidAiuiId(rawAiuiId) ? normalizeAiuiId(rawAiuiId) : '';
  const token = compact(data.token, 4096);
  const ownershipEpoch = normalizeOwnershipEpoch(data.ownership_epoch);
  const dataNamespace = compact(data.data_namespace, 200);
  // 新设备端点必须给出完整所有权标记；继承旧值会让 AIX 无法判断换绑边界。
  if (!publicDeviceId || !token || ownershipEpoch === null || !dataNamespace) return null;
  let ownershipTransition = null;
  if (data.ownership_transition != null) {
    const transition = data.ownership_transition;
    const previousOwnershipEpoch = normalizeOwnershipEpoch(
      transition && transition.previous_ownership_epoch,
    );
    const previousDataNamespace = compact(
      transition && transition.previous_data_namespace,
      200,
    );
    const currentOwnershipEpoch = normalizeOwnershipEpoch(
      transition && transition.current_ownership_epoch,
    );
    const currentDataNamespace = compact(
      transition && transition.current_data_namespace,
      200,
    );
    if (!transition || transition.kind !== 'anonymous_claim'
        || previousOwnershipEpoch === null || !previousDataNamespace
        || currentOwnershipEpoch === null || !currentDataNamespace
        || currentOwnershipEpoch !== previousOwnershipEpoch + 1
        || currentOwnershipEpoch !== ownershipEpoch
        || currentDataNamespace !== dataNamespace
        || data.bound !== true) return null;
    ownershipTransition = Object.freeze({
      kind: 'anonymous_claim',
      previousOwnershipEpoch,
      previousDataNamespace,
      currentOwnershipEpoch,
      currentDataNamespace,
    });
  }
  return {
    publicDeviceId,
    aiuiId,
    token,
    // 首次由后端兼容生成时才返回；后续 null/缺失绝不能覆盖本地凭据。
    deviceSecret: normalizeDeviceSecret(data.device_secret),
    bound: data.bound === true,
    agentInstanceId: compact(data.agent_instance_id, 160),
    agentAlias: compact(data.agent_alias, 80),
    ownershipEpoch,
    dataNamespace,
    legacyMigrationComplete: data.legacy_migration_complete === true,
    ...(ownershipTransition ? { ownershipTransition } : {}),
  };
}

/** 清除上一所有者的本地内容；保留设备身份与设备级设置。 */
export function clearOwnerScopedState(storage) {
  // Dynamic field-log chunks must be cleared before fixed owner keys. If this
  // verified clear fails, keep the remaining owner state and pending journal
  // intact so a later startup can retry without publishing a new owner token.
  if (!clearRunningLocalFieldLogsForOwnerTransition(storage)) return false;
  let cleared = true;
  for (let i = 0; i < OWNER_SCOPED_STORAGE_KEYS.length; i += 1) {
    const key = OWNER_SCOPED_STORAGE_KEYS[i];
    if (!clearStorageValueVerified(storage, key, ownerScopedFallback(key))) cleared = false;
  }
  return cleared;
}

/**
 * 首次匿名→绑定允许历史连续迁移；已绑定后的解绑或所有者切换必须隔离本地内容。
 * ownership_epoch 是不透明版本标记，AIX 不保存/推断数据库主键。
 */
export function shouldClearOwnerScopedState(previous, next, ownershipTransition = null) {
  if (!previous || !next) return false;
  const previousEpoch = normalizeOwnershipEpoch(previous.ownershipEpoch);
  const nextEpoch = normalizeOwnershipEpoch(next.ownershipEpoch);
  const previousNamespace = compact(previous.dataNamespace, 200);
  const nextNamespace = compact(next.dataNamespace, 200);
  const markerComplete = previousEpoch !== null && nextEpoch !== null
    && !!previousNamespace && !!nextNamespace;

  // bound→unbound 本身就是所有权终止；即便异常后端没有轮换 marker 也必须清。
  if (previous.bound === true && next.bound !== true) return true;
  if (!markerComplete) {
    // 只要已有旧 binding 却缺任一 marker，就无法证明仍是同一所有者；无论旧值
    // bound/unbound 都保守隔离。previous=null 的首次注册已在函数开头放行。
    return true;
  }
  const markerChanged = previousEpoch !== nextEpoch || previousNamespace !== nextNamespace;
  if (!markerChanged) return false;

  // 后端保证正常首次 claim 只让 epoch +1。这个唯一特例保留尚未上传的匿名跑步，
  // 其余 unbound→unbound 变化或 epoch 跳跃都代表 AIX 漏过了解绑/换绑轮次。
  const previousPublicDeviceId = compact(previous.publicDeviceId, 160);
  const nextPublicDeviceId = compact(next.publicDeviceId, 160);
  if (previous.bound !== true && next.bound === true
      && nextEpoch === previousEpoch + 1
      && previousPublicDeviceId
      && previousPublicDeviceId === nextPublicDeviceId) {
    return !continuousFirstOwnerClaim(previous, next, ownershipTransition);
  }
  return true;
}

function continuousFirstOwnerClaim(previous, next, proof) {
  if (!previous || !next) return false;
  const previousEpoch = normalizeOwnershipEpoch(previous.ownershipEpoch);
  const nextEpoch = normalizeOwnershipEpoch(next.ownershipEpoch);
  const previousNamespace = compact(previous.dataNamespace, 200);
  const nextNamespace = compact(next.dataNamespace, 200);
  const previousPublicDeviceId = compact(previous.publicDeviceId, 160);
  const nextPublicDeviceId = compact(next.publicDeviceId, 160);
  return previous.bound !== true && next.bound === true
    && proof && proof.kind === 'anonymous_claim'
    && previousEpoch !== null
    && proof.previousOwnershipEpoch === previousEpoch
    && proof.previousDataNamespace === previousNamespace
    && nextEpoch !== null
    && proof.currentOwnershipEpoch === nextEpoch
    && proof.currentDataNamespace === nextNamespace
    && !!previousNamespace && !!nextNamespace
    && !!previousPublicDeviceId
    && previousPublicDeviceId === nextPublicDeviceId;
}

/** 保存公开身份与设备 token；不触碰 legacy key，更不会写硬件指纹。 */
export function persistDeviceBootstrap(storage, parsed, opts = {}) {
  if (!parsed || !parsed.publicDeviceId || !parsed.token) return false;
  // 上一次所有权切换尚未完全清理时，不得接受本次响应或激活任何新 token。
  if (!ownerScopedDataAvailable(storage)) return false;
  const parsedEpoch = normalizeOwnershipEpoch(parsed.ownershipEpoch);
  const parsedNamespace = compact(parsed.dataNamespace, 200);
  if (parsedEpoch === null || !parsedNamespace) return false;
  const previous = readBinding(storage);
  const previousEpoch = normalizeOwnershipEpoch(previous && previous.ownershipEpoch);
  // 同一 active credential 的所有权版本只能单调前进。显式 fresh-anonymous
  // 恢复会用全新服务器凭据并 forceOwnerClear，允许新身份从自己的 epoch 起步；
  // 其他迟到响应必须在写 credential/token、清 owner 队列之前直接拒绝。
  if (opts.forceOwnerClear !== true
      && previousEpoch !== null
      && parsedEpoch < previousEpoch) return false;
  // 必须先确保服务器签发的长期凭据已经真正落盘，才接受后端身份。否则一次
  // 成功响应后重启就会永久丢 credential；不能用“setStorageSync 没抛错”
  // 冒充持久化成功。device_secret 仅用于旧 active 身份兼容。
  const requestedCredential = normalizeDeviceCredential(opts.deviceCredential);
  let persistedCredential = normalizeDeviceCredential(
    readString(storage, DEVICE_CREDENTIAL_STORAGE_KEY, 2048),
  );
  if (requestedCredential) {
    const stored = verifyStorageRoundTrip(
      storage, DEVICE_CREDENTIAL_STORAGE_KEY, requestedCredential, 2048,
    );
    persistedCredential = stored
      ? normalizeDeviceCredential(readString(storage, DEVICE_CREDENTIAL_STORAGE_KEY, 2048))
      : '';
  }
  const responseSecret = normalizeDeviceSecret(parsed.deviceSecret);
  let persistedSecret = normalizeDeviceSecret(readString(storage, DEVICE_SECRET_STORAGE_KEY));
  if (!persistedCredential && responseSecret) {
    const stored = verifyStorageRoundTrip(storage, DEVICE_SECRET_STORAGE_KEY, responseSecret);
    persistedSecret = stored
      ? normalizeDeviceSecret(readString(storage, DEVICE_SECRET_STORAGE_KEY)) : '';
  }
  if (!persistedCredential && !persistedSecret) return false;
  const previousPublicDeviceId = readString(storage, PUBLIC_DEVICE_ID_STORAGE_KEY);
  const previousToken = readString(storage, DEVICE_TOKEN_STORAGE_KEY, 4096);
  const previousAliasResult = readRawResult(storage, AIUI_ID_STORAGE_KEY);
  const previousAiuiId = readAiuiId(storage, previousPublicDeviceId, previous);
  const next = {
    bound: parsed.bound === true,
    agentInstanceId: parsed.agentInstanceId || '',
    agentAlias: parsed.agentAlias || '',
    ownershipEpoch: parsedEpoch,
    dataNamespace: parsedNamespace,
  };
  const migrationContinuity = opts.legacyMigrationConfirmed === true
    && parsed.legacyMigrationComplete === true;
  // A public identity/token/alias without its binding marker is not a first
  // registration: the owner proof was lost. Conservatively journal and clear
  // every owner-scoped queue before accepting the server's current lifecycle.
  const missingPreviousMarker = !previous && (
    !!previousPublicDeviceId
    || !!previousToken
    || (previousAliasResult.readable
      && !isEmptyStorageValue(previousAliasResult.value, ''))
  );
  const ownerDataCleared = migrationContinuity
    ? false : (
      opts.forceOwnerClear === true
      || missingPreviousMarker
      || shouldClearOwnerScopedState(
        previous ? { ...previous, publicDeviceId: previousPublicDeviceId } : previous,
        { ...next, publicDeviceId: parsed.publicDeviceId },
        parsed.ownershipTransition,
      )
    );
  const continuousClaim = !ownerDataCleared && continuousFirstOwnerClaim(
    previous ? { ...previous, publicDeviceId: previousPublicDeviceId } : previous,
    { ...next, publicDeviceId: parsed.publicDeviceId },
    parsed.ownershipTransition,
  );
  // A continuous anonymous→bound claim migrates workout evidence before it
  // publishes the new scoped token. Capture every mutable identity key first:
  // if any later identity write fails, both sides must return to the same old
  // owner instead of deleting the marker and turning the retry into a
  // destructive "missing marker" transition.
  const continuousIdentityPreimage = continuousClaim
    ? snapshotActiveDeviceIdentity(storage, opts.coachTokenStorageKey)
    : null;
  if (continuousClaim && !continuousIdentityPreimage) return false;
  // Field logs are diagnostic health evidence rather than an upload queue.
  // A server-proven anonymous claim may rebind workout completion state, but
  // it must never move an old owner field archive under the new owner marker.
  // Privacy wins over rollback here: once verified absent, a later identity
  // write failure does not resurrect the archive.
  if (continuousClaim
      && !clearRunningLocalFieldLogsForOwnerTransition(storage)) return false;
  let workoutOwnerRebindTransaction = null;
  let heartRatePolicyClearTransaction = null;
  if (continuousClaim && hasWorkoutOwnerStorageEvidence(storage)) {
    // bootstrapDeviceIdentity proves the target+mirror pairs through exact
    // async reads before reaching this synchronous commit. Direct legacy
    // callers may only claim when no workout storage exists at all.
    if (opts.workoutStorageReady !== true) return false;
    const previousWorkoutOwner = {
      publicDeviceId: previousPublicDeviceId,
      ownershipEpoch: previous.ownershipEpoch,
      dataNamespace: previous.dataNamespace,
    };
    const nextWorkoutOwner = {
      publicDeviceId: parsed.publicDeviceId,
      ownershipEpoch: next.ownershipEpoch,
      dataNamespace: next.dataNamespace,
    };
    const transaction = beginWorkoutOwnerStorageRebind(
      storage,
      previousWorkoutOwner,
      nextWorkoutOwner,
    );
    if (!transaction.ok) {
      // The old identity remains authoritative. A verified preimage was
      // restored when possible; an unverifiable rollback stays fail closed and
      // can be resumed by a later bootstrap without deleting the evidence.
      return false;
    }
    workoutOwnerRebindTransaction = transaction;
  } else if (continuousClaim && hasHeartRatePolicyStorageEvidence(storage)) {
    // HeartRatePolicy must never migrate from the anonymous owner. It is
    // possible for this to be the only owner-scoped record, in which case the
    // full workout transaction is intentionally unnecessary.
    const transaction = beginHeartRatePolicyStorageClear(storage);
    if (!transaction.ok) return false;
    heartRatePolicyClearTransaction = transaction;
  }
  if (ownerDataCleared) {
    // 先把清理意图 durable 化，再清旧用户数据。若随后关键身份写入失败/进程退出，
    // 启动期会重放清理；没有 journal 则绝不提前破坏旧数据。
    if (!stageOwnerTransition(storage, next)) return false;
    if (!clearOwnerScopedState(storage)) return false;
    if (typeof opts.onOwnerDataCleared === 'function') {
      try { opts.onOwnerDataCleared(); } catch (_e) {}
    }
  }
  const failClosed = () => {
    // Continuous claims restore the exact workout *and* identity preimages.
    // Leaving token/binding empty here would make the next bootstrap treat the
    // old private evidence as an unknown owner and erase it. Destructive owner
    // transitions keep the existing token-clearing path below.
    if (workoutOwnerRebindTransaction) workoutOwnerRebindTransaction.rollback();
    if (heartRatePolicyClearTransaction) heartRatePolicyClearTransaction.rollback();
    if (continuousIdentityPreimage) {
      restoreActiveDeviceIdentity(
        storage,
        continuousIdentityPreimage,
        opts.coachTokenStorageKey,
      );
      return false;
    }
    clearStorageValueVerified(storage, DEVICE_TOKEN_STORAGE_KEY, '');
    if (opts.coachTokenStorageKey) {
      clearStorageValueVerified(storage, opts.coachTokenStorageKey, '');
    }
    clearStorageValueVerified(storage, DEVICE_BINDING_STORAGE_KEY, '');
    return false;
  };
  if (!verifyStorageRoundTrip(
    storage, PUBLIC_DEVICE_ID_STORAGE_KEY, parsed.publicDeviceId, 160,
  )) return failClosed();
  // 展示别名写失败不能降级认证或上传；但 public identity 或 owner 变化时必须先清掉
  // 旧别名。解绑后即使 public_device_id 不变、新 ID 暂缺，UI 也只能显示待分配。
  const aliasChanged = !!parsed.aiuiId && !!previousAiuiId
    && parsed.aiuiId !== previousAiuiId;
  const aliasResetRequired = ownerDataCleared
    || aliasChanged
    || (previousPublicDeviceId && previousPublicDeviceId !== parsed.publicDeviceId);
  if (aliasResetRequired
      && !clearStorageValueVerified(storage, AIUI_ID_STORAGE_KEY, '')) {
    return failClosed();
  }
  if (parsed.aiuiId) {
    // A failed alias write is non-authenticating and may degrade to “待分配”,
    // but only after any former owner's ID was proven absent above.
    persistAiuiId(storage, parsed.aiuiId, parsed.publicDeviceId, next);
  }
  if (!verifyStorageRoundTrip(
    storage, DEVICE_TOKEN_STORAGE_KEY, parsed.token, 4096,
  )) return failClosed();
  // 现有记忆/上传链路共用 coach_token；绑定/解绑刷新后必须原位替换旧 token。
  if (opts.coachTokenStorageKey && !verifyStorageRoundTrip(
    storage, opts.coachTokenStorageKey, parsed.token, 4096,
  )) return failClosed();
  const bindingValue = {
    ...next,
    updatedAtMs: Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now(),
  };
  if (!writeValue(storage, DEVICE_BINDING_STORAGE_KEY, bindingValue)) return failClosed();
  const storedBinding = readBinding(storage);
  if (!storedBinding
      || storedBinding.bound !== bindingValue.bound
      || storedBinding.ownershipEpoch !== bindingValue.ownershipEpoch
      || storedBinding.dataNamespace !== bindingValue.dataNamespace) return failClosed();
  // 墓碑必须写后读回成功，bootstrap 才算完整提交。它不参与认证，也不随
  // owner 清理，但能阻止未来的部分 storage 丢失把旧数据降级成 preidentity。
  // 必须先于 journal 提交：失败时 journal 仍可在下次启动重放隐私清理。
  if (!persistIdentityEverActivated(storage)) return failClosed();
  // 所有凭据状态和安装级墓碑都成功落盘后才能提交 journal；否则保持 pending
  // 并撤销半提交 token。
  if (persistedSecret && !clearDeviceSecretUnverified(storage)) return failClosed();
  if (ownerDataCleared && !clearOwnerTransitionPending(storage)) return failClosed();
  // 首次服务器身份完整提交后，本地待归属记录自然归入该匿名 owner。该标记
  // 不参与认证；清理失败也不能撤销已经原子提交的有效身份。
  if (!previousPublicDeviceId && !previous) {
    clearStorageValueVerified(storage, PREIDENTITY_OWNER_STORAGE_KEY, '');
  }
  if (workoutOwnerRebindTransaction) workoutOwnerRebindTransaction.commit();
  if (heartRatePolicyClearTransaction) heartRatePolicyClearTransaction.commit();
  return true;
}

function snapshotActiveDeviceIdentity(storage, coachTokenStorageKey) {
  const keys = [
    INSTALLATION_ID_STORAGE_KEY,
    DEVICE_CREDENTIAL_STORAGE_KEY,
    DEVICE_SECRET_STORAGE_KEY,
    PUBLIC_DEVICE_ID_STORAGE_KEY,
    AIUI_ID_STORAGE_KEY,
    DEVICE_TOKEN_STORAGE_KEY,
    DEVICE_BINDING_STORAGE_KEY,
    DEVICE_SECRET_BOOTSTRAP_STATE_STORAGE_KEY,
    OWNER_TRANSITION_PENDING_STORAGE_KEY,
    IDENTITY_EVER_ACTIVATED_STORAGE_KEY,
  ];
  if (coachTokenStorageKey) keys.push(coachTokenStorageKey);
  const values = new Map();
  for (const key of keys) {
    const result = readRawResult(storage, key);
    if (!result.readable) return null;
    let value = result.value;
    if (value && typeof value === 'object') {
      try { value = JSON.parse(JSON.stringify(value)); } catch (_e) { return null; }
    }
    values.set(key, value);
  }
  return {
    installationId: values.get(INSTALLATION_ID_STORAGE_KEY),
    deviceCredential: values.get(DEVICE_CREDENTIAL_STORAGE_KEY),
    deviceSecret: values.get(DEVICE_SECRET_STORAGE_KEY),
    publicDeviceId: values.get(PUBLIC_DEVICE_ID_STORAGE_KEY),
    aiuiId: values.get(AIUI_ID_STORAGE_KEY),
    deviceToken: values.get(DEVICE_TOKEN_STORAGE_KEY),
    binding: values.get(DEVICE_BINDING_STORAGE_KEY),
    secretBootstrapState: values.get(DEVICE_SECRET_BOOTSTRAP_STATE_STORAGE_KEY),
    ownerTransition: values.get(OWNER_TRANSITION_PENDING_STORAGE_KEY),
    identityEverActivated: values.get(IDENTITY_EVER_ACTIVATED_STORAGE_KEY),
    coachToken: coachTokenStorageKey
      ? values.get(coachTokenStorageKey) : undefined,
  };
}

function restoreActiveDeviceIdentity(storage, previous, coachTokenStorageKey) {
  if (!previous) return false;
  const restored = [
    restoreRawValue(storage, INSTALLATION_ID_STORAGE_KEY, previous.installationId),
    restoreRawValue(storage, DEVICE_CREDENTIAL_STORAGE_KEY, previous.deviceCredential),
    restoreRawValue(storage, DEVICE_SECRET_STORAGE_KEY, previous.deviceSecret),
    restoreRawValue(storage, PUBLIC_DEVICE_ID_STORAGE_KEY, previous.publicDeviceId),
    restoreRawValue(storage, AIUI_ID_STORAGE_KEY, previous.aiuiId),
    restoreRawValue(storage, DEVICE_TOKEN_STORAGE_KEY, previous.deviceToken),
    restoreRawValue(storage, DEVICE_BINDING_STORAGE_KEY, previous.binding),
    restoreRawValue(
    storage, DEVICE_SECRET_BOOTSTRAP_STATE_STORAGE_KEY, previous.secretBootstrapState,
    ),
    restoreRawValue(storage, OWNER_TRANSITION_PENDING_STORAGE_KEY, previous.ownerTransition),
    restoreRawValue(
      storage,
      IDENTITY_EVER_ACTIVATED_STORAGE_KEY,
      previous.identityEverActivated,
    ),
  ];
  if (coachTokenStorageKey) {
    restored.push(restoreRawValue(storage, coachTokenStorageKey, previous.coachToken));
  }
  return restored.every((value) => value === true);
}

/**
 * 将服务端长期凭据候选与 bootstrap 返回的公开身份一次性切为 active。
 * pending credential 始终先于网络 durable；ID/credential/token/owner marker 任一读回失败都
 * 回滚 active 键并保留 pending，响应丢失或进程重启后可用同一候选幂等重试。
 */
function commitServerRegistration(storage, candidate, parsed, opts = {}) {
  if (!candidate || !parsed || !parsed.aiuiId) return { committed: false };
  const recoveryCandidate = opts.candidateKind === 'recovery';
  const durableCandidate = recoveryCandidate
    ? readRecoveryCandidate(storage) : readRegistrationCandidate(storage);
  // 网络返回前另一条流程可能已经替换/清除了 pending。只有仍与实际请求二件套
  // 完全相同的响应才可切 active，迟到响应绝不能覆盖较新的候选。
  if (!sameRegistrationCandidate(durableCandidate, candidate)) {
    return { committed: false, superseded: true };
  }
  const previous = snapshotActiveDeviceIdentity(storage, opts.coachTokenStorageKey);
  if (!previous) return { committed: false };
  const candidateStored = verifyStorageRoundTrip(
    storage, INSTALLATION_ID_STORAGE_KEY, candidate.installationId, 160,
  ) && verifyStorageRoundTrip(
    storage, DEVICE_CREDENTIAL_STORAGE_KEY, candidate.deviceCredential, 2048,
  );
  const committed = candidateStored && persistDeviceBootstrap(storage, parsed, {
    deviceCredential: candidate.deviceCredential,
    coachTokenStorageKey: opts.coachTokenStorageKey,
    nowMs: opts.nowMs,
    forceOwnerClear: opts.forceOwnerClear === true,
    legacyMigrationConfirmed: opts.legacyMigrationConfirmed === true,
    onOwnerDataCleared: opts.onOwnerDataCleared,
    workoutStorageReady: opts.workoutStorageReady === true,
  });
  const active = committed ? ensureLocalDeviceIdentity(storage, opts) : null;
  const complete = !!active
    && active.installationId === candidate.installationId
    && active.deviceCredential === candidate.deviceCredential
    && active.publicDeviceId === parsed.publicDeviceId
    && active.aiuiId === parsed.aiuiId
    && active.deviceToken === parsed.token
    && active.ownershipEpoch === parsed.ownershipEpoch
    && active.dataNamespace === parsed.dataNamespace;
  if (!complete) {
    restoreActiveDeviceIdentity(storage, previous, opts.coachTokenStorageKey);
    return { committed: false };
  }
  return {
    committed: true,
    cleanupPending: !(recoveryCandidate
      ? clearRecoveryCandidate(storage) : clearRegistrationCandidate(storage)),
  };
}

/**
 * 401 后只清认证缓存。单个 401 无法证明已解绑，所以先保留展示 ID；
 * 下一次权威 bootstrap 一旦识别 owner transition，persistDeviceBootstrap 会替换它。
 */
export function clearDeviceAuth(storage, opts = {}) {
  const deviceToken = readString(storage, DEVICE_TOKEN_STORAGE_KEY, 4096);
  const preservedLegacyToken = readString(storage, LEGACY_COACH_TOKEN_STORAGE_KEY, 4096);
  removeValue(storage, DEVICE_TOKEN_STORAGE_KEY);
  if (opts.coachTokenStorageKey) {
    const coachToken = readString(storage, opts.coachTokenStorageKey, 4096);
    // 迁移未确认时 coach_token 仍可能是唯一旧 user proof；已有独立副本时也保留
    // 原位值，直到 marker=true。正常 device token 轮换则照旧清理。
    if (!preservedLegacyToken || coachToken === deviceToken) {
      removeValue(storage, opts.coachTokenStorageKey);
    }
  }
}

async function bootstrapServerRegisteredIdentity(opts, initialLocal) {
  const storage = opts.storage;
  const inflight = registrationBootstrapInflight.get(storage);
  if (inflight) return inflight;
  const task = (async () => {
    let issued = await obtainServerRegistrationCandidate(opts);
    if (!issued.candidate) {
      return {
        ...initialLocal,
        network: false,
        statusCode: issued.statusCode,
        credentialStorageUnavailable: issued.storageUnavailable === true,
        persistenceFailureReason: issued.storageUnavailable
          ? 'registration_candidate_storage' : '',
        registrationCredentialFailed: issued.storageUnavailable !== true,
        registrationPending: true,
      };
    }

    let candidate = issued.candidate;
    let response = null;
    const sendBootstrap = async () => {
      try {
        return await opts.request(buildDeviceBootstrapRequest({
          baseUrl: opts.baseUrl,
          clientId: opts.clientId,
          installationId: candidate.installationId,
          deviceCredential: candidate.deviceCredential,
        }));
      } catch (_e) {
        return null;
      }
    };
    response = await sendBootstrap();

    const parsed = parseDeviceBootstrapResponse(response);
    if (!parsed) {
      return {
        ...ensureLocalDeviceIdentity(storage, opts),
        network: false,
        statusCode: response && response.statusCode,
        registrationBootstrapFailed: true,
        registrationPending: true,
      };
    }
    let ownerDataCleared = false;
    const commit = commitServerRegistration(storage, candidate, parsed, {
      ...opts,
      onOwnerDataCleared: () => {
        ownerDataCleared = true;
        if (typeof opts.onOwnerDataCleared === 'function') opts.onOwnerDataCleared();
      },
    });
    if (!commit.committed) {
      return {
        ...ensureLocalDeviceIdentity(storage, opts),
        network: false,
        statusCode: response && response.statusCode,
        credentialPersistenceFailed: true,
        persistenceFailureReason: 'registration_commit_failed',
        registrationPending: true,
        registrationSuperseded: commit.superseded === true,
      };
    }
    return {
      ...ensureLocalDeviceIdentity(storage, opts),
      network: true,
      ownerDataCleared,
      serverRegistered: true,
      registrationCleanupPending: commit.cleanupPending === true,
    };
  })();
  registrationBootstrapInflight.set(storage, task);
  try {
    return await task;
  } finally {
    if (registrationBootstrapInflight.get(storage) === task) {
      registrationBootstrapInflight.delete(storage);
    }
  }
}

async function bootstrapLegacyWithServerRegistration(opts, initialLocal, legacyProof) {
  let issued = await obtainServerRegistrationCandidate(opts);
  if (!issued.candidate) {
    return {
      ...initialLocal,
      network: false,
      statusCode: issued.statusCode,
      credentialStorageUnavailable: issued.storageUnavailable === true,
      persistenceFailureReason: issued.storageUnavailable
        ? 'registration_candidate_storage' : '',
      registrationCredentialFailed: issued.storageUnavailable !== true,
      registrationPending: true,
      legacyMigrationPending: true,
    };
  }
  let candidate = issued.candidate;
  const sendMigration = async () => {
    try {
      return await opts.request(buildDeviceBootstrapRequest({
        baseUrl: opts.baseUrl,
        clientId: opts.clientId,
        installationId: candidate.installationId,
        deviceCredential: candidate.deviceCredential,
        legacyDeviceId: legacyProof.legacyDeviceId,
        legacyToken: legacyProof.token,
      }));
    } catch (_e) {
      return null;
    }
  };
  const response = await sendMigration();
  const parsed = parseDeviceBootstrapResponse(response);
  if (!parsed || parsed.legacyMigrationComplete !== true) {
    return {
      ...initialLocal,
      network: false,
      statusCode: response && response.statusCode,
      registrationBootstrapFailed: true,
      registrationPending: true,
      legacyMigrationPending: true,
    };
  }
  const commit = commitServerRegistration(opts.storage, candidate, parsed, {
    nowMs: opts.nowMs,
    legacyMigrationConfirmed: true,
    workoutStorageReady: opts.workoutStorageReady === true,
    // 旧 user JWT 仍是唯一迁移证明；完整 marker 落盘前不能覆盖 coach_token。
    coachTokenStorageKey: '',
  });
  if (!commit.committed || !completeLegacyMigration(
    opts.storage, legacyProof, parsed, opts,
  )) {
    return {
      ...ensureLocalDeviceIdentity(opts.storage, opts),
      network: false,
      statusCode: response && response.statusCode,
      credentialPersistenceFailed: true,
      persistenceFailureReason: 'registration_commit_failed',
      registrationPending: !commit.committed,
      registrationSuperseded: commit.superseded === true,
      legacyMigrationPending: true,
    };
  }
  return {
    ...ensureLocalDeviceIdentity(opts.storage, opts),
    ...(parsed.ownershipTransition
      ? { ownershipTransition: parsed.ownershipTransition } : {}),
    network: true,
    serverRegistered: true,
    legacyMigrationComplete: true,
    registrationCleanupPending: commit.cleanupPending === true,
  };
}

export async function bootstrapDeviceIdentity(opts = {}) {
  const hadStoredCredential = !!normalizeDeviceCredential(
    readString(opts.storage, DEVICE_CREDENTIAL_STORAGE_KEY, 2048),
  ) || (
    !!normalizeDeviceSecret(readString(opts.storage, DEVICE_SECRET_STORAGE_KEY))
    && !isDeviceSecretUnverified(opts.storage)
  );
  const local = ensureLocalDeviceIdentity(opts.storage, opts);
  if (local.ownerTransitionBlocked) {
    return {
      ...local,
      network: false,
      credentialStorageUnavailable: true,
      persistenceFailureReason: 'owner_journal_blocked',
    };
  }
  const workoutStorageReady = await initializeWorkoutOwnerStorage(opts.storage)
    .catch(() => false);
  if (!workoutStorageReady) {
    return {
      ...local,
      network: false,
      credentialStorageUnavailable: true,
      workoutStorageUnavailable: true,
      persistenceFailureReason: 'workout_storage_unavailable',
    };
  }
  opts = { ...opts, workoutStorageReady: true };
  // 新后端允许未配置共享 key 的低权限、限频设备 bootstrap；app_key 只是可选增强。
  // 因此不能因缺 key 跳过，否则“未绑定 APK 也能匿名上传”的主链会被本端掐断。
  if (!local.installationIdStorageReady || !local.deviceCredentialStorageReady) {
    return {
      ...local,
      network: false,
      credentialStorageUnavailable: true,
      persistenceFailureReason: 'storage_unavailable',
    };
  }
  const recoveryState = readRecoveryState(opts.storage);
  if (recoveryState) {
    return {
      ...local,
      network: false,
      credentialRecoveryRequired: true,
      credentialRecoveryPending: recoveryState.startsWith('pending:'),
    };
  }
  if (typeof opts.request !== 'function') return { ...local, network: false };
  const legacyProof = prepareLegacyMigrationProof(opts.storage, local, opts);
  if (legacyProof.storageUnavailable) {
    return {
      ...local,
      network: false,
      credentialStorageUnavailable: true,
      persistenceFailureReason: 'storage_unavailable',
    };
  }
  const activeServerCredential = !!local.publicDeviceId
    && (
      !!local.deviceCredential
      || (!!local.deviceSecret && local.deviceSecretUnverified !== true)
    );
  const activeBootstrapTicket = activeServerCredential
    ? beginActiveBootstrapRequest(opts.storage, local) : null;
  // 完整 active 身份优先于任何遗留首次注册 journal。清理失败也只忽略 pending，
  // 不能让 stale 候选覆盖 active installation/credential，更不能再次请求签发。
  if (activeServerCredential) clearRegistrationCandidate(opts.storage);
  // 已经有服务器公开身份却遗失 credential 时，绝不能悄悄创建第二个身份。
  // 该情况保持现有显式恢复流程，必须由可见绑定页二次确认。
  if (local.publicDeviceId && !activeServerCredential) {
    const recoveryStateStored = persistRecoveryState(opts.storage, 'required');
    return {
      ...local,
      network: false,
      credentialRecoveryRequired: true,
      credentialStorageUnavailable: !recoveryStateStored,
      persistenceFailureReason: recoveryStateStored ? '' : 'storage_unavailable',
    };
  }
  // 老版本用户可能持有可验证的 user JWT/legacy ID，但没有长期设备凭据。该分支
  // 先取得服务端二件套，再把 legacy proof 与 credential 放在同一个 bootstrap
  // 请求里完成迁移；绝不先建普通匿名身份。
  if (!local.publicDeviceId && legacyProof.token
      && !local.deviceCredential
      && (!local.deviceSecret || local.deviceSecretUnverified === true)) {
    return bootstrapLegacyWithServerRegistration(opts, local, legacyProof);
  }
  // 首次安装既无 active server credential、也无旧 user JWT 时，只走服务端长期
  // 凭据签发；app_key 不能绕过该链路。正常 bootstrap 不读取 SN 或 fingerprint。
  if (!activeServerCredential && !legacyProof.token) {
    return bootstrapServerRegisteredIdentity(opts, local);
  }

  // 升级用户先用旧 user JWT 对同一个 bootstrap 端点作一次显式迁移证明。
  // 这个请求每次 bootstrap 最多一次；非 200/marker 缺失时保留独立旧 token，
  // 随后仍允许普通匿名 bootstrap，避免迁移服务暂时失败就阻塞跑步。
  let legacyMigrationStatusCode = null;
  if (legacyProof.token) {
    let migrationResponse = null;
    try {
      migrationResponse = await opts.request(buildDeviceBootstrapRequest({
        baseUrl: opts.baseUrl,
        clientId: opts.clientId,
        appKey: opts.appKey,
        installationId: local.installationId,
        legacyDeviceId: legacyProof.legacyDeviceId,
        legacyToken: legacyProof.token,
        deviceCredential: local.deviceCredential,
        deviceSecret: local.deviceSecret,
      }));
    } catch (_e) {}
    legacyMigrationStatusCode = migrationResponse && migrationResponse.statusCode;
    const migrationParsed = parseDeviceBootstrapResponse(migrationResponse);
    if (migrationParsed && migrationParsed.legacyMigrationComplete === true) {
      if (activeBootstrapResponseIsSuperseded(
        opts.storage, activeBootstrapTicket, migrationParsed,
      )) {
        return {
          ...ensureLocalDeviceIdentity(opts.storage, opts),
          network: false,
          statusCode: legacyMigrationStatusCode,
          activeBootstrapSuperseded: true,
          legacyMigrationPending: true,
        };
      }
      let ownerDataCleared = false;
      const persisted = persistDeviceBootstrap(opts.storage, migrationParsed, {
        deviceCredential: local.deviceCredential,
        nowMs: opts.nowMs,
        legacyMigrationConfirmed: true,
        workoutStorageReady: opts.workoutStorageReady === true,
        onOwnerDataCleared: () => {
          ownerDataCleared = true;
          if (typeof opts.onOwnerDataCleared === 'function') opts.onOwnerDataCleared();
        },
      });
      if (persisted) markActiveBootstrapCommitted(opts.storage, activeBootstrapTicket);
      if (!persisted || !completeLegacyMigration(
        opts.storage, legacyProof, migrationParsed, opts,
      )) {
        const secretAvailable = !!normalizeDeviceCredential(
          readString(opts.storage, DEVICE_CREDENTIAL_STORAGE_KEY, 2048),
        ) || !!normalizeDeviceSecret(
          readString(opts.storage, DEVICE_SECRET_STORAGE_KEY),
        ) || !!normalizeDeviceSecret(migrationParsed.deviceSecret);
        return {
          ...ensureLocalDeviceIdentity(opts.storage, opts),
          network: false,
          statusCode: legacyMigrationStatusCode,
          credentialPersistenceFailed: true,
          persistenceFailureReason: secretAvailable
            ? 'identity_commit_failed' : 'secret_missing',
          legacyMigrationPending: true,
        };
      }
      return {
        ...ensureLocalDeviceIdentity(opts.storage, opts),
        ...(migrationParsed.ownershipTransition
          ? { ownershipTransition: migrationParsed.ownershipTransition } : {}),
        network: true,
        ownerDataCleared,
        legacyMigrationComplete: true,
      };
    }
  }

  let response = null;
  try {
    response = await opts.request(buildDeviceBootstrapRequest({
      baseUrl: opts.baseUrl,
      clientId: opts.clientId,
      appKey: opts.appKey,
      installationId: local.installationId,
      deviceCredential: local.deviceCredential,
      deviceSecret: local.deviceSecret,
    }));
  } catch (_e) {}
  const parsed = parseDeviceBootstrapResponse(response);
  if (!parsed) {
    const statusCode = response && response.statusCode;
    const recoveryRequired = statusCode === 401 && !hadStoredCredential;
    let recoveryStateStored = true;
    if (recoveryRequired) {
      recoveryStateStored = persistRecoveryState(opts.storage, 'required');
      // 若连恢复标记都无法落盘，保持 fail closed；新流程从不在眼镜端生成凭据。
    }
    return {
      ...local,
      network: false,
      statusCode,
      // 只有“启动前确实没有 stored secret + 后端明确 401”才开放显式新匿名恢复。
      // 有 secret 的 401 不能用此路径绕过认证。
      credentialRecoveryRequired: recoveryRequired,
      credentialStorageUnavailable: recoveryRequired && !recoveryStateStored,
    };
  }
  if (activeBootstrapResponseIsSuperseded(opts.storage, activeBootstrapTicket, parsed)) {
    return {
      ...ensureLocalDeviceIdentity(opts.storage, opts),
      network: false,
      statusCode: response && response.statusCode,
      activeBootstrapSuperseded: true,
    };
  }
  let ownerDataCleared = false;
  const persisted = persistDeviceBootstrap(opts.storage, parsed, {
    deviceCredential: local.deviceCredential,
    // 有待迁移的旧 user token 时先保留 coach_token；新 scoped token 已独立写入
    // DEVICE_TOKEN_STORAGE_KEY，待后端 marker=true 才替换旧 token。
    coachTokenStorageKey: legacyProof.token ? '' : opts.coachTokenStorageKey,
    nowMs: opts.nowMs,
    workoutStorageReady: opts.workoutStorageReady === true,
    onOwnerDataCleared: () => {
      ownerDataCleared = true;
      if (typeof opts.onOwnerDataCleared === 'function') opts.onOwnerDataCleared();
    },
  });
  if (persisted) markActiveBootstrapCommitted(opts.storage, activeBootstrapTicket);
  if (!persisted) {
    const secretAvailable = !!normalizeDeviceCredential(
      readString(opts.storage, DEVICE_CREDENTIAL_STORAGE_KEY, 2048),
    ) || !!normalizeDeviceSecret(
      readString(opts.storage, DEVICE_SECRET_STORAGE_KEY),
    ) || !!normalizeDeviceSecret(parsed.deviceSecret);
    return {
      ...ensureLocalDeviceIdentity(opts.storage, opts),
      network: false,
      statusCode: response && response.statusCode,
      credentialPersistenceFailed: true,
      persistenceFailureReason: secretAvailable
        ? 'identity_commit_failed' : 'secret_missing',
    };
  }
  if (legacyProof.complete && !retireLegacyMigrationToken(opts.storage)) {
    return {
      ...ensureLocalDeviceIdentity(opts.storage, opts),
      network: false,
      statusCode: response && response.statusCode,
      credentialPersistenceFailed: true,
      persistenceFailureReason: 'identity_commit_failed',
    };
  }
  return {
    ...ensureLocalDeviceIdentity(opts.storage, opts),
    ...(parsed.ownershipTransition
      ? { ownershipTransition: parsed.ownershipTransition } : {}),
    network: true,
    ownerDataCleared,
    legacyMigrationPending: !!legacyProof.token && !ownerDataCleared,
    legacyMigrationStatusCode,
  };
}

/**
 * 用户明确接受后创建全新匿名身份。它不尝试接管旧 fingerprint 对应身份：
 * 轮换 installation/secret，并省略 fingerprint、legacy ID 与旧 user bearer。
 */
export async function recoverFreshAnonymousDeviceIdentity(opts = {}) {
  const current = ensureLocalDeviceIdentity(opts.storage, opts);
  const durableRecoveryState = readRecoveryState(opts.storage);
  // `userConfirmed` 只证明一次可见点击；是否需要轮换身份必须先由正常 bootstrap
  // 的明确恢复路径 durable 化。健康 active 身份绝不接受直接重置。
  if (!durableRecoveryState) {
    return {
      ...current,
      network: false,
      credentialRecoveryRequired: false,
      recoveryNotRequired: true,
    };
  }
  // 该操作会轮换 installation/secret 并隔离旧 owner 数据，只能由可见 UI 的
  // 二次确认明确授权；任何后台调用或遗漏参数都必须 fail closed。
  if (opts.userConfirmed !== true) {
    return {
      ...current,
      network: false,
      credentialRecoveryRequired: true,
      userConfirmationRequired: true,
    };
  }
  if (current.ownerTransitionBlocked) {
    return { ...current, network: false, credentialStorageUnavailable: true };
  }
  const workoutStorageReady = await initializeWorkoutOwnerStorage(opts.storage)
    .catch(() => false);
  if (!workoutStorageReady) {
    return {
      ...current,
      network: false,
      credentialStorageUnavailable: true,
      workoutStorageUnavailable: true,
      persistenceFailureReason: 'workout_storage_unavailable',
    };
  }
  if (typeof opts.request !== 'function') {
    return { ...current, network: false, credentialRecoveryFailed: true };
  }
  // 从显式确认边界开始，generic 首次注册候选不再有资格参与恢复。它可能由
  // 用户确认前的旧请求留下，只能清理，不能当作恢复授权或长期凭据来源。
  clearRegistrationCandidate(opts.storage);
  const issued = await obtainServerRecoveryCandidate(opts, durableRecoveryState);
  if (!issued.candidate) {
    return {
      ...current,
      network: false,
      statusCode: issued.statusCode,
      credentialRecoveryFailed: issued.storageUnavailable !== true,
      credentialRecoveryRequired: true,
      credentialRecoveryPending: true,
      credentialStorageUnavailable: issued.storageUnavailable === true,
    };
  }
  const candidate = issued.candidate;

  const sendBootstrap = async () => {
    try {
      return await opts.request(buildDeviceBootstrapRequest({
        baseUrl: opts.baseUrl,
        clientId: opts.clientId,
        installationId: candidate.installationId,
        deviceCredential: candidate.deviceCredential,
        // 安全边界：恢复请求不读取/发送 fingerprint、legacy 或旧 bearer。
      }));
    } catch (_e) {
      return null;
    }
  };
  const response = await sendBootstrap();
  const parsed = parseDeviceBootstrapResponse(response);
  if (!parsed) {
    return {
      ...current,
      network: false,
      statusCode: response && response.statusCode,
      credentialRecoveryFailed: true,
      credentialRecoveryRequired: true,
      credentialRecoveryPending: true,
    };
  }

  // 保留旧版本降级保护标记：新身份从未绑定 SN，旧包也不得重新命中原身份。
  if (!persistHardwareFingerprintSuppression(opts.storage, candidate.installationId)) {
    return {
      ...current,
      network: false,
      credentialStorageUnavailable: true,
      credentialRecoveryRequired: true,
      credentialRecoveryPending: true,
    };
  }

  // 服务端确认 fresh row 后才切 active；pending 长期凭据已在网络前 durable 化。
  const commit = commitServerRegistration(opts.storage, candidate, parsed, {
    coachTokenStorageKey: opts.coachTokenStorageKey,
    nowMs: opts.nowMs,
    forceOwnerClear: true,
    candidateKind: 'recovery',
    workoutStorageReady: true,
    onOwnerDataCleared: opts.onOwnerDataCleared,
  });
  if (!commit.committed) {
    return {
      ...ensureLocalDeviceIdentity(opts.storage, opts),
      network: false,
      credentialPersistenceFailed: true,
      credentialRecoveryRequired: true,
      credentialRecoveryPending: true,
    };
  }
  // forceOwnerClear 已在新公开身份/token 提交前通过 durable journal 清掉旧用户内容，
  // 因此这里不能再全量清理（会误删刚写入的新 coach_token）。
  if (!clearRecoveryState(opts.storage)) {
    return {
      ...ensureLocalDeviceIdentity(opts.storage, opts),
      network: false,
      credentialPersistenceFailed: true,
      credentialRecoveryRequired: true,
    };
  }
  return {
    ...ensureLocalDeviceIdentity(opts.storage, opts),
    network: true,
    identityReset: true,
    registrationCleanupPending: commit.cleanupPending === true,
  };
}

export function buildDevicePairStatusRequest(opts = {}) {
  return jsonRequest({
    baseUrl: opts.baseUrl,
    path: opts.path || DEVICE_PAIR_STATUS_PATH,
    token: opts.token,
    data: {},
  });
}

export function parseDevicePairStatusResponse(resp) {
  return parseDeviceBootstrapResponse(resp);
}

/** 旧兼容/诊断格式；正式绑定 UI 只展示独立的 8 位 AIUI ID。 */
export function formatPublicDeviceId(identity) {
  const value = compact(identity && identity.publicDeviceId, 160);
  if (!value) return '待分配';
  return value.length <= 22 ? value : value.slice(0, 10) + '…' + value.slice(-8);
}
