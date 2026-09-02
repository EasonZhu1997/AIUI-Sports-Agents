import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  LEGACY_DEVICE_ID_STORAGE_KEY,
  INSTALLATION_ID_STORAGE_KEY,
  PUBLIC_DEVICE_ID_STORAGE_KEY,
  AIUI_ID_STORAGE_KEY,
  DEVICE_TOKEN_STORAGE_KEY,
  DEVICE_CREDENTIAL_STORAGE_KEY,
  DEVICE_SECRET_STORAGE_KEY,
  HARDWARE_FINGERPRINT_SUPPRESSED_STORAGE_KEY,
  DEVICE_BINDING_STORAGE_KEY,
  DEVICE_RECOVERY_STATE_STORAGE_KEY,
  DEVICE_RECOVERY_CANDIDATE_STORAGE_KEY,
  DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY,
  OWNER_TRANSITION_PENDING_STORAGE_KEY,
  LEGACY_COACH_TOKEN_STORAGE_KEY,
  LEGACY_MIGRATION_STATE_STORAGE_KEY,
  IDENTITY_EVER_ACTIVATED_STORAGE_KEY,
  IDENTITY_EVER_ACTIVATED_VALUE,
  PREIDENTITY_OWNER_STORAGE_KEY,
  PREIDENTITY_OWNER_VALUE,
  OWNER_SCOPED_STORAGE_KEYS,
  DEVICE_BOOTSTRAP_PATH,
  DEVICE_REGISTRATION_CREDENTIAL_PATH,
  DEVICE_PAIR_STATUS_PATH,
  looksLikeLegacyUserToken,
  ensureLocalDeviceIdentity,
  buildDeviceRegistrationCredentialRequest,
  parseDeviceRegistrationCredentialResponse,
  buildDeviceBootstrapRequest,
  parseDeviceBootstrapResponse,
  persistDeviceBootstrap,
  clearOwnerScopedState,
  hasIdentityEverActivated,
  hasOwnerScopedPrivateData,
  replayPendingOwnerTransition,
  ownerScopedDataAvailable,
  shouldClearOwnerScopedState,
  clearDeviceAuth,
  bootstrapDeviceIdentity,
  recoverFreshAnonymousDeviceIdentity,
  buildDevicePairStatusRequest,
  parseDevicePairStatusResponse,
  normalizeAiuiId,
  isValidAiuiId,
  formatAiuiId,
  formatPublicDeviceId,
} from '../lib/device_identity.js';
import {
  enqueueWorkoutCompletion,
  quarantineWorkoutCompletion,
  readPendingWorkoutCompletions,
  readQuarantinedWorkoutCompletions,
} from '../lib/workout_completion.js';
import {
  clearWorkoutExecutionCheckpoint,
  readCachedWorkout,
  readWorkoutExecutionCheckpoint,
  writeCachedWorkout,
  writeWorkoutExecutionCheckpoint,
  WORKOUT_EXECUTION_CACHE_KEY,
  WORKOUT_EXECUTION_STATE_KEY,
} from '../lib/workout_cache.js';
import {
  createWorkoutExecution,
  normalizeWorkoutExecution,
} from '../lib/workout_executor.js';
import { initializeWorkoutOwnerStorage } from '../lib/workout_owner_storage.js';
import {
  HEART_RATE_POLICY_STORAGE_KEY,
  readHeartRatePolicy,
  writeHeartRatePolicy,
} from '../lib/heart_rate_policy.js';
import {
  RUNNING_LOCAL_FIELD_LOG_KEY,
  appendRunningLocalFieldSamples,
  beginRunningLocalFieldLog,
  runningLocalFieldLogChunkKey,
} from '../lib/running_local_field_log.js';

test('设备身份只保留旧 Sport Agent key 的清理字面量，不再 import runtime', () => {
  const source = readFileSync(
    new URL('../lib/device_identity.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /from '\.\/sport_agent\.js'/);
  assert.match(source,
    /LEGACY_SPORT_AGENT_QUEUE_KEY = 'pending_sport_agent_runs_v1'/);
  assert.match(source,
    /LEGACY_SPORT_AGENT_QUEUE_STATE_KEY =[\s\S]*'pending_sport_agent_runs_state_v1'/);
});

function jwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return header + '.' + body + '.signature';
}

function storage(seed = {}) {
  const clone = (value) => value === undefined
    ? undefined : JSON.parse(JSON.stringify(value));
  const map = new Map(Object.entries(seed).map(([key, value]) => [key, clone(value)]));
  return {
    map,
    getStorageSync(key) { return map.has(key) ? clone(map.get(key)) : undefined; },
    getStorage({ key, success, fail, complete }) {
      if (map.has(key)) success?.({ data: clone(map.get(key)) });
      else fail?.({ errMsg: 'Key not found' });
      complete?.();
    },
    setStorageSync(key, value) { map.set(key, clone(value)); },
    removeStorageSync(key) { map.delete(key); },
  };
}

function seedRunningLocalFieldLog(target, suffix = 'abcdef') {
  const startedAtMs = 1_800_000_000_000;
  const runId = 'run-mara2026-' + suffix;
  assert.equal(beginRunningLocalFieldLog(target, { runId, startedAtMs }).ok, true);
  assert.equal(appendRunningLocalFieldSamples(target, runId, {
    captured_at_ms: startedAtMs,
    elapsed_ms: 0,
    bpm: 148,
    cadence_spm: 176,
    speed_mps: 3.1,
    distance_m: 0,
    steps_total: 0,
    distance_source: 'imu',
    cadence_source: 'imu',
    ble_state: 'connected',
    trigger: 'ticker',
  }).ok, true);
  return { runId, chunkKey: runningLocalFieldLogChunkKey(runId, 0) };
}

function registrationBundle(tag = 'a') {
  return {
    installation_id: 'inst_' + tag.repeat(28),
    device_credential: 'dcred_' + tag.repeat(40),
  };
}

const CLAIM_STARTED_AT = Date.parse('2026-08-07T10:00:00.000Z');
const CLAIM_WORKOUT_ID = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaa';
const CLAIM_PLAN_SESSION_ID = 'ps_bbbbbbbbbbbbbbbbbbbbbbbb';
const CLAIM_STAGE_ID = 'stg_cccccccccccccccccccccccc';

function claimOwner(bound, ownershipEpoch, dataNamespace) {
  return {
    publicDeviceId: 'SR-CLAIM-CONTINUITY',
    bound,
    ownershipEpoch,
    dataNamespace,
  };
}

function anonymousClaimProof(previousOwner, nextOwner) {
  return {
    kind: 'anonymous_claim',
    previousOwnershipEpoch: previousOwner.ownershipEpoch,
    previousDataNamespace: previousOwner.dataNamespace,
    currentOwnershipEpoch: nextOwner.ownershipEpoch,
    currentDataNamespace: nextOwner.dataNamespace,
  };
}

function claimPlan(owner) {
  const target = {
    duration_sec: 600,
    distance_m: null,
    pace_min_sec_per_km: null,
    pace_max_sec_per_km: null,
    heart_zone_min: null,
    heart_zone_max: null,
    cadence_min_spm: null,
    cadence_max_spm: null,
  };
  return {
    schema_version: 2,
    workout_id: CLAIM_WORKOUT_ID,
    plan_id: 'plan_91001',
    plan_session_id: CLAIM_PLAN_SESSION_ID,
    revision: 1,
    type: 'easy',
    title: 'Claim continuity',
    scheduled_date: '2026-08-07',
    status: 'planned',
    target,
    stages: [{
      ...target,
      stage_id: CLAIM_STAGE_ID,
      order: 0,
      type: 'work',
      title: 'Run',
    }],
    issued_at_ms: CLAIM_STARTED_AT - 1000,
    expires_at_ms: CLAIM_STARTED_AT + 86_400_000,
    ownership_epoch: owner.ownershipEpoch,
    data_namespace: owner.dataNamespace,
  };
}

function claimCompletion() {
  return {
    workout_id: CLAIM_WORKOUT_ID,
    plan_session_id: CLAIM_PLAN_SESSION_ID,
    client_execution_id: 'exec-claim-continuity',
    client_run_id: 'run-claim-continuity',
    revision: 1,
    status: 'completed',
    started_at: new Date(CLAIM_STARTED_AT).toISOString(),
    ended_at: new Date(CLAIM_STARTED_AT + 600_000).toISOString(),
    duration_s: 600,
    distance_m: 1500,
    stage_results: [{
      stage_id: CLAIM_STAGE_ID,
      status: 'completed',
      duration_s: 600,
      distance_m: 1500,
    }],
  };
}

test('首次本地初始化只做 storage probe，不生成 installation ID 占位', () => {
  const s = storage();
  let randomCalls = 0;
  const identity = ensureLocalDeviceIdentity(s, {
    cryptoObject: { randomUUID() { randomCalls += 1; return 'must-not-be-used'; } },
  });
  assert.equal(identity.installationId, '');
  assert.equal(randomCalls, 0);
  assert.equal(s.map.has(INSTALLATION_ID_STORAGE_KEY), false);
});

test('首次本地初始化不生成 device_secret 或 device_credential', () => {
  const s = storage();
  const identity = ensureLocalDeviceIdentity(s, { cryptoObject: webcrypto });
  assert.equal(identity.deviceCredential, '');
  assert.equal(identity.deviceSecret, '');
  assert.equal(s.map.has(DEVICE_CREDENTIAL_STORAGE_KEY), false);
  assert.equal(s.map.has(DEVICE_SECRET_STORAGE_KEY), false);
});

test('本地身份保留 legacy_device_id，并用后端公开 ID 作为有效身份', () => {
  const s = storage({
    [LEGACY_DEVICE_ID_STORAGE_KEY]: 'aiui-old-user',
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: 'SR-ABCD-1234',
    [AIUI_ID_STORAGE_KEY]: {
      aiuiId: 'A7K2M9Q4', publicDeviceId: 'SR-ABCD-1234',
    },
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: false, ownershipEpoch: 1, dataNamespace: 'anon-local', updatedAtMs: 1,
    },
  });
  const identity = ensureLocalDeviceIdentity(s, {
    cryptoObject: { randomUUID: () => 'install-uuid' },
  });
  assert.equal(identity.legacyDeviceId, 'aiui-old-user');
  assert.equal(identity.installationId, '', '新流程不生成本地 installation 占位');
  assert.equal(s.map.has(INSTALLATION_ID_STORAGE_KEY), false);
  assert.equal(identity.publicDeviceId, 'SR-ABCD-1234');
  assert.equal(identity.aiuiId, 'A7K2M9Q4');
  assert.equal(identity.effectiveDeviceId, 'SR-ABCD-1234');
  assert.equal(s.map.get(LEGACY_DEVICE_ID_STORAGE_KEY), 'aiui-old-user', 'legacy key 不可覆盖');
});

test('AIUI ID 固定为 8 位字母数字并按 XXXX XXXX 展示', () => {
  assert.equal(normalizeAiuiId(' a7k2-m9q4 '), 'A7K2M9Q4');
  assert.equal(isValidAiuiId('A7K2M9Q4'), true);
  assert.equal(isValidAiuiId('ABCDEFGH'), false, '必须至少含一个数字');
  assert.equal(isValidAiuiId('12345678'), false, '必须至少含一个字母');
  assert.equal(isValidAiuiId('A7K2M9Q'), false);
  assert.equal(isValidAiuiId('A7K2M9Q!'), false);
  assert.equal(formatAiuiId('a7k2m9q4'), 'A7K2 M9Q4');
  assert.equal(formatAiuiId('invalid'), '待分配');
});

test('本地缓存 JWT 不受普通字段 160 字符上限截断', () => {
  const longToken = 'header.' + 'x'.repeat(360) + '.signature';
  const s = storage({ [DEVICE_TOKEN_STORAGE_KEY]: longToken });
  assert.equal(ensureLocalDeviceIdentity(s).deviceToken, longToken);
});

test('身份模块不暴露 SN 读取或本地散列入口', async () => {
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../lib/device_identity.js', import.meta.url), 'utf8'));
  assert.equal(source.includes('getDeviceSerialNumber'), false);
  assert.equal(source.includes('hardware_fingerprint'), false);
});

test('服务器凭据签发请求不会接受或发送 SN 模拟字段', () => {
  const req = buildDeviceRegistrationCredentialRequest({
    clientId: 'AISmartRun',
    deviceSn: 'MUST-NOT-SEND',
    hardwareFingerprint: 'a'.repeat(64),
  });
  assert.deepEqual(req.data, { app_id: 'AISmartRun' });
  assert.equal(JSON.stringify(req).includes('MUST-NOT-SEND'), false);
});

test('首次注册凭据签发只发送 app_id，并严格解析服务端长期凭据', () => {
  const req = buildDeviceRegistrationCredentialRequest({
    baseUrl: 'https://example.test/',
    clientId: 'AISmartRun',
  });
  assert.equal(req.url, 'https://example.test' + DEVICE_REGISTRATION_CREDENTIAL_PATH);
  assert.deepEqual(req.data, { app_id: 'AISmartRun' });
  assert.equal('device_sn' in req.data, false);
  assert.equal('hardware_fingerprint' in req.data, false);
  const parsed = parseDeviceRegistrationCredentialResponse({
    statusCode: 200,
    data: {
      installation_id: 'inst_' + 'a'.repeat(28),
      device_credential: 'dcred_' + 'b'.repeat(40),
    },
  });
  assert.deepEqual(parsed, {
    installationId: 'inst_' + 'a'.repeat(28),
    deviceCredential: 'dcred_' + 'b'.repeat(40),
  });
  assert.equal(parseDeviceRegistrationCredentialResponse({
    statusCode: 200,
    data: { installation_id: 'inst_bad', device_credential: 'short' },
  }), null);
});

test('bootstrap 请求不接受指纹或原始 device_sn', () => {
  const req = buildDeviceBootstrapRequest({
    baseUrl: 'https://example.test/',
    clientId: 'AISmartRun',
    appKey: 'shared',
    deviceSecret: 's'.repeat(48),
    installationId: 'ins-1',
    legacyDeviceId: 'aiui-old',
    legacyToken: jwt({ sub: '7', kind: 'user' }),
    hardwareFingerprint: 'a'.repeat(64),
    deviceSn: 'SHOULD-NOT-LEAK',
  });
  assert.equal(req.url, 'https://example.test' + DEVICE_BOOTSTRAP_PATH);
  assert.equal(req.dataType, 'json');
  assert.equal(req.responseType, 'text');
  assert.ok(req.timeout >= 10000, '手机代理冷启动需要独立的身份请求超时');
  assert.deepEqual(req.data, {
    app_id: 'AISmartRun',
    installation_id: 'ins-1',
    app_key: 'shared',
    device_secret: 's'.repeat(48),
    legacy_device_id: 'aiui-old',
  });
  assert.match(req.header.Authorization, /^Bearer /);
  assert.equal('device_sn' in req.data, false);
  assert.equal('hardware_fingerprint' in req.data, false);
  assert.equal(JSON.stringify(req).includes('SHOULD-NOT-LEAK'), false);
  assert.equal(JSON.stringify(req).includes(PREIDENTITY_OWNER_STORAGE_KEY), false);
  assert.equal(JSON.stringify(req).includes(PREIDENTITY_OWNER_VALUE), false,
    'preidentity sentinel 只属于本地 storage，不能进入身份请求');
});

test('bootstrap 携带服务器长期 device_credential，但不会衍生或发送 SN', () => {
  const credential = 'dcred_' + 't'.repeat(40);
  const req = buildDeviceBootstrapRequest({
    installationId: 'inst_' + 'i'.repeat(28),
    deviceCredential: credential,
    deviceSn: 'NEVER-SEND',
  });
  assert.equal(req.data.device_credential, credential);
  assert.equal('device_secret' in req.data, false);
  assert.equal('device_sn' in req.data, false);
  assert.equal('hardware_fingerprint' in req.data, false);
});

test('无 app_key 时不发送 legacy_device_id，避免低权限请求泄露旧匿名标识', () => {
  const req = buildDeviceBootstrapRequest({
    installationId: 'ins-1', legacyDeviceId: 'legacy-private',
    deviceSecret: 'k'.repeat(48),
  });
  assert.equal('legacy_device_id' in req.data, false);
  assert.equal(req.data.device_secret, 'k'.repeat(48));
});

test('legacy_device_id 只由旧 user JWT 证明，无 app_key 也可安全迁移', () => {
  const oldToken = jwt({ sub: '42', kind: 'user' });
  const req = buildDeviceBootstrapRequest({
    installationId: 'ins-legacy', legacyDeviceId: 'old-device', legacyToken: oldToken,
    deviceSecret: 'z'.repeat(48),
  });
  assert.equal(req.data.legacy_device_id, 'old-device');
  assert.equal(req.header.Authorization, 'Bearer ' + oldToken);
  assert.equal('app_key' in req.data, false);
  assert.equal(looksLikeLegacyUserToken(oldToken), true);
  assert.equal(looksLikeLegacyUserToken(jwt({ sub: 'dev', kind: 'aiui_device' })), false);
  assert.equal(looksLikeLegacyUserToken(jwt({ sub: '9' })), true, '历史 token 允许缺 kind');
});

test('bootstrap 响应持久化公开 ID、设备凭据与不透明归属标记，不保存数据库用户主键', () => {
  const s = storage({
    coach_token: 'old-token',
    [LEGACY_DEVICE_ID_STORAGE_KEY]: 'legacy',
    [DEVICE_SECRET_STORAGE_KEY]: 'o'.repeat(48),
  });
  const parsed = parseDeviceBootstrapResponse({ statusCode: 200, data: {
    public_device_id: 'SR-NEW', aiui_id: 'A7K2M9Q4', token: 'device-jwt', bound: true,
    device_secret: 'n'.repeat(48),
    agent_instance_id: 'agent-7', agent_alias: '我的教练', effective_user_id: 42,
    ownership_epoch: 7, data_namespace: 'own_d4c6e6',
  } });
  assert.ok(parsed);
  assert.equal(persistDeviceBootstrap(s, parsed, {
    coachTokenStorageKey: 'coach_token', nowMs: 123,
  }), true);
  assert.equal(s.map.get(PUBLIC_DEVICE_ID_STORAGE_KEY), 'SR-NEW');
  assert.deepEqual(s.map.get(AIUI_ID_STORAGE_KEY), {
    aiuiId: 'A7K2M9Q4', publicDeviceId: 'SR-NEW',
    ownershipEpoch: 7, dataNamespace: 'own_d4c6e6',
  });
  assert.equal(ensureLocalDeviceIdentity(s).aiuiId, 'A7K2M9Q4');
  assert.equal(s.map.get(DEVICE_TOKEN_STORAGE_KEY), 'device-jwt');
  assert.equal(s.map.get(DEVICE_SECRET_STORAGE_KEY), 'n'.repeat(48));
  assert.equal(s.map.get('coach_token'), 'device-jwt');
  assert.deepEqual(s.map.get(DEVICE_BINDING_STORAGE_KEY), {
    bound: true,
    agentInstanceId: 'agent-7',
    agentAlias: '我的教练',
    ownershipEpoch: 7,
    dataNamespace: 'own_d4c6e6',
    updatedAtMs: 123,
  });
  assert.equal(JSON.stringify(s.map.get(DEVICE_BINDING_STORAGE_KEY)).includes('42'), false);
  assert.equal('effectiveUserId' in parsed, false);
  assert.equal(s.map.get(LEGACY_DEVICE_ID_STORAGE_KEY), 'legacy');
  assert.equal(
    s.map.get(IDENTITY_EVER_ACTIVATED_STORAGE_KEY),
    IDENTITY_EVER_ACTIVATED_VALUE,
  );
  assert.equal(hasIdentityEverActivated(s), true);
});

test('首次服务器身份接管本地待归属记录，不清跑步并移除非认证标记', () => {
  const credential = 'dcred_' + 'p'.repeat(40);
  const pendingSummary = {
    mode: 'free',
    startedAtMs: 1,
    elapsedMs: 120000,
    endedAtMs: 120001,
  };
  const s = storage({
    [DEVICE_CREDENTIAL_STORAGE_KEY]: credential,
    [PREIDENTITY_OWNER_STORAGE_KEY]: PREIDENTITY_OWNER_VALUE,
    pending_run_summary: pendingSummary,
    pending_run_uploads: [{ client_run_id: 'run-preidentity-0001' }],
  });

  assert.equal(persistDeviceBootstrap(s, {
    publicDeviceId: 'SR-FIRST-OWNER',
    aiuiId: 'F7R2S9T4',
    token: 'token-first-owner',
    bound: false,
    ownershipEpoch: 1,
    dataNamespace: 'anon-first-owner',
  }, {
    deviceCredential: credential,
    coachTokenStorageKey: 'coach_token',
  }), true);

  assert.deepEqual(s.map.get('pending_run_summary'), pendingSummary);
  assert.equal(s.map.get('pending_run_uploads').length, 1);
  assert.equal(s.map.has(PREIDENTITY_OWNER_STORAGE_KEY), false);
  assert.equal(s.map.get(PUBLIC_DEVICE_ID_STORAGE_KEY), 'SR-FIRST-OWNER');
  assert.equal(hasIdentityEverActivated(s), true);
});

test('旧 active 身份升级时补写永久激活墓碑，owner 清理不会删除它', () => {
  const s = storage({
    [INSTALLATION_ID_STORAGE_KEY]: 'inst_' + 'u'.repeat(28),
    [DEVICE_CREDENTIAL_STORAGE_KEY]: 'dcred_' + 'u'.repeat(40),
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: 'SR-UPGRADE',
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: false,
      ownershipEpoch: 3,
      dataNamespace: 'owner-upgrade-3',
      updatedAtMs: 1,
    },
    pending_run_uploads: [{ client_run_id: 'run-upgrade-owner' }],
  });

  assert.equal(s.map.has(IDENTITY_EVER_ACTIVATED_STORAGE_KEY), false);
  const identity = ensureLocalDeviceIdentity(s);
  assert.equal(identity.identityEverActivated, true);
  assert.equal(hasIdentityEverActivated(s), true);

  assert.equal(clearOwnerScopedState(s), true);
  assert.equal(hasIdentityEverActivated(s), true, 'owner 轮换不得清除安装级墓碑');
  assert.equal(s.map.has('pending_run_uploads'), false);
});

test('相同 preidentity 哨兵只作用于各自隔离 storage，不形成共享 owner', () => {
  const first = storage({
    [PREIDENTITY_OWNER_STORAGE_KEY]: PREIDENTITY_OWNER_VALUE,
    pending_run_summary: { text: 'device-a-private' },
  });
  const second = storage({
    [PREIDENTITY_OWNER_STORAGE_KEY]: PREIDENTITY_OWNER_VALUE,
  });

  assert.equal(hasOwnerScopedPrivateData(first), true);
  assert.equal(hasOwnerScopedPrivateData(second), false);
  first.removeStorageSync(PREIDENTITY_OWNER_STORAGE_KEY);
  assert.equal(
    second.map.get(PREIDENTITY_OWNER_STORAGE_KEY),
    PREIDENTITY_OWNER_VALUE,
    '一个 storage 的清理不能改变另一个 storage',
  );
});

test('现场日志 index 即使暂时没有 run 也属于 owner 私有证据', () => {
  const s = storage({
    [RUNNING_LOCAL_FIELD_LOG_KEY]: {
      schema_version: 1,
      runs: [],
      pending_cleanup: [],
    },
  });
  assert.equal(hasOwnerScopedPrivateData(s), true);
  s.removeStorageSync(RUNNING_LOCAL_FIELD_LOG_KEY);
  assert.equal(hasOwnerScopedPrivateData(s), false);
});

test('owner destructive clear 先验证删除现场日志 index 与动态 chunks', () => {
  const s = storage({ pending_run_summary: { text: 'old owner' } });
  const fieldLog = seedRunningLocalFieldLog(s, 'clear01');
  assert.equal(s.map.has(RUNNING_LOCAL_FIELD_LOG_KEY), true);
  assert.equal(s.map.has(fieldLog.chunkKey), true);
  assert.equal(clearOwnerScopedState(s), true);
  assert.equal(s.map.has(RUNNING_LOCAL_FIELD_LOG_KEY), false);
  assert.equal(s.map.has(fieldLog.chunkKey), false);
  assert.equal(s.map.has('pending_run_summary'), false);
  assert.equal(hasOwnerScopedPrivateData(s), false);
});

test('现场日志 chunk 无法删除时 owner clear 保留可重试 index 并停止后续清理', () => {
  const s = storage({ pending_run_summary: { text: 'must survive failed clear' } });
  const fieldLog = seedRunningLocalFieldLog(s, 'retry01');
  const removeStorageSync = s.removeStorageSync.bind(s);
  s.removeStorageSync = (key) => {
    if (key !== fieldLog.chunkKey) removeStorageSync(key);
  };

  assert.equal(clearOwnerScopedState(s), false);
  assert.equal(s.map.has(RUNNING_LOCAL_FIELD_LOG_KEY), true,
    'partial clear 必须恢复 index，避免动态 chunk 变成不可发现 orphan');
  assert.equal(s.map.has(fieldLog.chunkKey), true);
  assert.deepEqual(s.map.get('pending_run_summary'), {
    text: 'must survive failed clear',
  }, '现场日志未清完时不得继续清其他 owner 数据');
  assert.equal(hasOwnerScopedPrivateData(s), true);

  s.removeStorageSync = removeStorageSync;
  assert.equal(clearOwnerScopedState(s), true);
  assert.equal(s.map.has(RUNNING_LOCAL_FIELD_LOG_KEY), false);
  assert.equal(s.map.has(fieldLog.chunkKey), false);
  assert.equal(s.map.has('pending_run_summary'), false);
});

test('AIUI ID 异常或 storage 写失败只影响公开别名，不破坏设备认证主链', () => {
  const parsed = parseDeviceBootstrapResponse({ statusCode: 200, data: {
    public_device_id: 'SR-ALIAS', aiui_id: 'BAD!', token: 'device-token', bound: false,
    ownership_epoch: 1, data_namespace: 'anon-alias',
  } });
  assert.ok(parsed);
  assert.equal(parsed.aiuiId, '', '异常公开别名不得升级为认证失败');

  const s = storage({ [DEVICE_SECRET_STORAGE_KEY]: 's'.repeat(48) });
  const baseSet = s.setStorageSync.bind(s);
  s.setStorageSync = (key, value) => {
    if (key === AIUI_ID_STORAGE_KEY) throw new Error('alias storage unavailable');
    baseSet(key, value);
  };
  assert.equal(persistDeviceBootstrap(s, {
    ...parsed, aiuiId: 'A7K2M9Q4',
  }), true);
  assert.equal(s.map.get(DEVICE_TOKEN_STORAGE_KEY), 'device-token');
  assert.equal(ensureLocalDeviceIdentity(s).aiuiId, '');
});

test('AIUI ID 与内部公开设备成对保存，fresh identity 不沿用旧别名', () => {
  const s = storage({
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: 'SR-OLD',
    [AIUI_ID_STORAGE_KEY]: { aiuiId: 'A7K2M9Q4', publicDeviceId: 'SR-OLD' },
    [DEVICE_SECRET_STORAGE_KEY]: 's'.repeat(48),
  });
  assert.equal(persistDeviceBootstrap(s, {
    publicDeviceId: 'SR-FRESH', token: 'fresh-token', bound: false,
    ownershipEpoch: 1, dataNamespace: 'anon-fresh',
  }), true);
  assert.equal(ensureLocalDeviceIdentity(s).publicDeviceId, 'SR-FRESH');
  assert.equal(ensureLocalDeviceIdentity(s).aiuiId, '');
  assert.equal(s.map.has(AIUI_ID_STORAGE_KEY), false);
});

test('binding marker 丢失但已有公开身份时按 owner transition 清除旧队列', () => {
  const s = storage({
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: 'SR-EXISTING',
    [AIUI_ID_STORAGE_KEY]: { aiuiId: 'A7K2M9Q4', publicDeviceId: 'SR-EXISTING' },
    [DEVICE_TOKEN_STORAGE_KEY]: 'stale-token',
    [DEVICE_SECRET_STORAGE_KEY]: 's'.repeat(48),
    pending_run_uploads: [{ client_run_id: 'old-owner-run' }],
    local_run_memories: [{ text: 'old owner memory' }],
  });
  assert.equal(persistDeviceBootstrap(s, {
    publicDeviceId: 'SR-EXISTING', aiuiId: 'B8L3N0R5', token: 'fresh-token',
    bound: false, ownershipEpoch: 3, dataNamespace: 'anon-new-owner',
  }), true);
  assert.equal(s.map.has('pending_run_uploads'), false);
  assert.equal(s.map.has('local_run_memories'), false);
  assert.equal(ensureLocalDeviceIdentity(s).aiuiId, 'B8L3N0R5');
});

test('owner transition 无法验证清除旧 AIUI ID 时 fail closed 且不再展示旧 ID', () => {
  const s = storage({
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: 'SR-1',
    [AIUI_ID_STORAGE_KEY]: {
      aiuiId: 'A7K2M9Q4', publicDeviceId: 'SR-1',
      ownershipEpoch: 2, dataNamespace: 'user-old',
    },
    [DEVICE_SECRET_STORAGE_KEY]: 's'.repeat(48),
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: true, ownershipEpoch: 2, dataNamespace: 'user-old', updatedAtMs: 1,
    },
    pending_run_uploads: [{ client_run_id: 'old-owner-run' }],
  });
  const baseSet = s.setStorageSync.bind(s);
  s.removeStorageSync = (key) => {
    if (key !== AIUI_ID_STORAGE_KEY) s.map.delete(key);
  };
  s.setStorageSync = (key, value) => {
    if (key === AIUI_ID_STORAGE_KEY) throw new Error('alias storage unavailable');
    baseSet(key, value);
  };
  assert.equal(persistDeviceBootstrap(s, {
    publicDeviceId: 'SR-1', aiuiId: 'B8L3N0R5', token: 'fresh-token',
    bound: false, ownershipEpoch: 3, dataNamespace: 'anon-new',
  }), false);
  const local = ensureLocalDeviceIdentity(s);
  assert.equal(local.aiuiId, '', '旧 owner ID 绝不能继续进入 UI');
  assert.equal(local.deviceToken, '', '新 token 未完整提交时不得启用');
});

test('公开ID/token/binding 任一关键写入失败都 fail closed，不返回可用身份', () => {
  const s = storage({
    [DEVICE_SECRET_STORAGE_KEY]: 's'.repeat(48),
    coach_token: 'old',
  });
  const baseSet = s.setStorageSync.bind(s);
  s.setStorageSync = (key, value) => {
    if (key === DEVICE_BINDING_STORAGE_KEY) throw new Error('quota');
    baseSet(key, value);
  };
  const ok = persistDeviceBootstrap(s, {
    publicDeviceId: 'SR-PARTIAL', token: 'new-token', bound: false,
    ownershipEpoch: 1, dataNamespace: 'anon-partial',
  }, { coachTokenStorageKey: 'coach_token' });
  assert.equal(ok, false);
  assert.equal(s.map.has(DEVICE_TOKEN_STORAGE_KEY), false);
  assert.equal(s.map.has('coach_token'), false);
  assert.equal(s.map.has(DEVICE_BINDING_STORAGE_KEY), false);
});

test('激活墓碑无法写后读回时 bootstrap fail closed', () => {
  const s = storage({
    [DEVICE_CREDENTIAL_STORAGE_KEY]: 'dcred_' + 't'.repeat(40),
  });
  const baseSet = s.setStorageSync.bind(s);
  s.setStorageSync = (key, value) => {
    if (key === IDENTITY_EVER_ACTIVATED_STORAGE_KEY) return;
    baseSet(key, value);
  };

  assert.equal(persistDeviceBootstrap(s, {
    publicDeviceId: 'SR-TOMBSTONE-FAIL',
    aiuiId: 'T7O2M9B4',
    token: 'token-tombstone-fail',
    bound: false,
    ownershipEpoch: 1,
    dataNamespace: 'owner-tombstone-fail',
  }, {
    deviceCredential: 'dcred_' + 't'.repeat(40),
  }), false);
  assert.equal(s.map.has(DEVICE_TOKEN_STORAGE_KEY), false);
  assert.equal(s.map.has(DEVICE_BINDING_STORAGE_KEY), false);
  assert.equal(hasIdentityEverActivated(s), false);
});

test('owner 切换时墓碑落盘失败保留 journal，半提交 token 与 binding 不可用', () => {
  const credential = 'dcred_' + 'j'.repeat(40);
  const s = storage({
    [DEVICE_CREDENTIAL_STORAGE_KEY]: credential,
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: 'SR-OLD-TOMBSTONE',
    [DEVICE_TOKEN_STORAGE_KEY]: 'token-old-owner',
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: true,
      ownershipEpoch: 4,
      dataNamespace: 'owner-old-4',
      updatedAtMs: 1,
    },
    pending_run_uploads: [{ client_run_id: 'run-old-owner-private' }],
  });
  const baseSet = s.setStorageSync.bind(s);
  s.setStorageSync = (key, value) => {
    if (key === IDENTITY_EVER_ACTIVATED_STORAGE_KEY) return;
    baseSet(key, value);
  };

  assert.equal(persistDeviceBootstrap(s, {
    publicDeviceId: 'SR-OLD-TOMBSTONE',
    aiuiId: 'J7O2U9R4',
    token: 'token-new-owner',
    bound: false,
    ownershipEpoch: 5,
    dataNamespace: 'owner-new-5',
  }, {
    deviceCredential: credential,
  }), false);

  assert.equal(typeof s.map.get(OWNER_TRANSITION_PENDING_STORAGE_KEY), 'object',
    '墓碑未 durable 时不得提交清理 journal');
  assert.equal(s.map.has(DEVICE_TOKEN_STORAGE_KEY), false);
  assert.equal(s.map.has(DEVICE_BINDING_STORAGE_KEY), false);
  assert.equal(s.map.has('pending_run_uploads'), false,
    '旧 owner 私有数据已经清理后不得复活');
  assert.equal(hasIdentityEverActivated(s), false);
});

test('所有权切换先写 durable 清理 journal；写不出 journal 时不破坏旧用户数据', () => {
  const s = storage({
    pending_run_uploads: [{ owner: 'old' }],
    [DEVICE_SECRET_STORAGE_KEY]: 's'.repeat(48),
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: true, ownershipEpoch: 4, dataNamespace: 'user-old', updatedAtMs: 1,
    },
  });
  const baseSet = s.setStorageSync.bind(s);
  s.setStorageSync = (key, value) => {
    if (key === OWNER_TRANSITION_PENDING_STORAGE_KEY) throw new Error('journal unavailable');
    baseSet(key, value);
  };
  const ok = persistDeviceBootstrap(s, {
    publicDeviceId: 'SR-NEW', token: 'new-token', bound: false,
    ownershipEpoch: 5, dataNamespace: 'anon-new',
  });
  assert.equal(ok, false);
  assert.deepEqual(s.map.get('pending_run_uploads'), [{ owner: 'old' }]);
  assert.equal(s.map.has(DEVICE_TOKEN_STORAGE_KEY), false,
    'journal 失败发生在任何新 token/binding 写入之前');
});

test('所有权切换中途失败保留 pending journal，启动期在任何队列读取前重放清理', () => {
  const s = storage({
    pending_run_uploads: [{ owner: 'old' }],
    [DEVICE_SECRET_STORAGE_KEY]: 's'.repeat(48),
    [AIUI_ID_STORAGE_KEY]: {
      aiuiId: 'A7K2M9Q4', publicDeviceId: 'SR-OLD',
      ownershipEpoch: 8, dataNamespace: 'user-old',
    },
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: true, ownershipEpoch: 8, dataNamespace: 'user-old', updatedAtMs: 1,
    },
  });
  const baseSet = s.setStorageSync.bind(s);
  s.setStorageSync = (key, value) => {
    if (key === DEVICE_BINDING_STORAGE_KEY) throw new Error('commit interrupted');
    baseSet(key, value);
  };
  assert.equal(persistDeviceBootstrap(s, {
    publicDeviceId: 'SR-NEXT', token: 'next-token', bound: false,
    ownershipEpoch: 9, dataNamespace: 'anon-next',
  }), false);
  assert.equal(s.map.has('pending_run_uploads'), false);
  assert.ok(s.map.get(OWNER_TRANSITION_PENDING_STORAGE_KEY), '中断后 journal 必须留存');
  s.map.set('pending_run_uploads', [{ owner: 'stale-after-crash' }]);
  ensureLocalDeviceIdentity(s);
  assert.equal(s.map.has('pending_run_uploads'), false, '启动身份读取先重放隐私清理');
  assert.equal(s.map.has(OWNER_TRANSITION_PENDING_STORAGE_KEY), false);
});

test('removeStorageSync 静默 no-op 时，owner 清理写入类型安全空值并逐项读回验证', () => {
  const arrayKeys = new Set([
    'local_run_memories', 'pending_run_uploads', 'pending_aiui_records',
    'pending_aiui_calibration_events', 'run_upload_receipts_v1',
    'quarantined_run_uploads_v1',
    'quarantined_aiui_calibration_events_v1',
    'pending_workout_completions_v2',
    'quarantined_workout_completions_v1',
    'pending_sport_agent_runs_v1',
  ]);
  const seeded = Object.fromEntries(OWNER_SCOPED_STORAGE_KEYS.map((key) => [
    key, arrayKeys.has(key) ? [{ owner: 'old' }] : { owner: 'old' },
  ]));
  const s = storage(seeded);
  s.removeStorageSync = () => {}; // 模拟部分 AIUI 宿主“成功返回但没有删除”

  assert.equal(clearOwnerScopedState(s), true);
  for (const key of OWNER_SCOPED_STORAGE_KEYS) {
    const value = s.map.get(key);
    if (arrayKeys.has(key)) {
      assert.deepEqual(value, [], key + ' 必须语义为空');
    } else if (key === 'pending_workout_completions_state_v1') {
      assert.equal(value.target_key, 'pending_workout_completions_v2');
      assert.deepEqual(value.committed_value, []);
    } else if (key === 'quarantined_workout_completions_state_v1') {
      assert.equal(value.target_key, 'quarantined_workout_completions_v1');
      assert.deepEqual(value.committed_value, []);
    } else if (key === 'smartrun_workout_execution_v1') {
      assert.deepEqual(value, { __smartrun_workout_execution_empty_v1__: true });
    } else if (key === 'smartrun_workout_execution_state_v1') {
      assert.equal(value.target_key, 'smartrun_workout_execution_v1');
      assert.deepEqual(value.committed_value, {
        __smartrun_workout_execution_empty_v1__: true,
      });
    } else if (key === 'pending_sport_agent_runs_state_v1') {
      assert.equal(value.target_key, 'pending_sport_agent_runs_v1');
      assert.deepEqual(value.value, []);
      assert.equal(value.hash, '741638a5');
    } else {
      assert.equal(value, '', key + ' 必须语义为空');
    }
  }
  assert.equal(hasOwnerScopedPrivateData(s), false,
    '空队列镜像与 execution tombstone 不得被误认成上一 owner 私有数据');
});

for (const failureMode of ['no-op', 'throw']) {
  test(`owner 空值回退 ${failureMode} 时 journal 保留、身份与网络 fail closed，修复后可重放`, async () => {
    const blockedKey = 'pending_run_summary';
    const s = storage({
      [blockedKey]: { text: 'old private summary' },
      pending_run_uploads: [{ owner: 'old' }],
      local_run_memories: [{ text: 'old private memory' }],
      [DEVICE_SECRET_STORAGE_KEY]: 's'.repeat(48),
      [DEVICE_TOKEN_STORAGE_KEY]: 'old-token',
      [AIUI_ID_STORAGE_KEY]: {
        aiuiId: 'A7K2M9Q4', publicDeviceId: 'SR-OLD',
        ownershipEpoch: 20, dataNamespace: 'owner-old',
      },
      coach_token: 'old-token',
      [DEVICE_BINDING_STORAGE_KEY]: {
        bound: true, ownershipEpoch: 20, dataNamespace: 'owner-old', updatedAtMs: 1,
      },
    });
    const baseRemove = s.removeStorageSync.bind(s);
    const baseSet = s.setStorageSync.bind(s);
    s.removeStorageSync = (key) => {
      if (key !== blockedKey) return baseRemove(key);
      if (failureMode === 'throw') throw new Error('remove unavailable');
      return undefined;
    };
    s.setStorageSync = (key, value) => {
      if (key === blockedKey && value === '') {
        if (failureMode === 'throw') throw new Error('fallback unavailable');
        return;
      }
      baseSet(key, value);
    };

    assert.equal(persistDeviceBootstrap(s, {
      publicDeviceId: 'SR-NEXT', token: 'new-token', bound: false,
      ownershipEpoch: 21, dataNamespace: 'owner-next',
    }, { coachTokenStorageKey: 'coach_token' }), false);
    assert.equal(s.map.get(blockedKey).text, 'old private summary');
    assert.equal(typeof s.map.get(OWNER_TRANSITION_PENDING_STORAGE_KEY), 'object',
      '任何一项未确认清空时 journal 必须保留');
    assert.equal(s.map.get(DEVICE_TOKEN_STORAGE_KEY), 'old-token',
      '失败发生在新 token 持久化之前');

    const local = ensureLocalDeviceIdentity(s);
    assert.equal(local.ownerTransitionBlocked, true);
    assert.equal(local.deviceToken, '', 'pending journal 下旧 token 不得向调用方暴露');
    assert.equal(local.bound, false, 'pending journal 下旧 binding 不得向调用方暴露');
    let networkCalls = 0;
    const blocked = await bootstrapDeviceIdentity({
      storage: s,
      request: async () => { networkCalls += 1; return null; },
    });
    assert.equal(blocked.ownerTransitionBlocked, true);
    assert.equal(blocked.credentialStorageUnavailable, true);
    assert.equal(networkCalls, 0, '清理未完成不得 bootstrap、读记忆或上传');
    assert.equal(typeof s.map.get(OWNER_TRANSITION_PENDING_STORAGE_KEY), 'object');

    s.removeStorageSync = baseRemove;
    s.setStorageSync = baseSet;
    assert.equal(replayPendingOwnerTransition(s), true, 'storage 恢复后幂等重放成功');
    assert.equal(s.map.has(OWNER_TRANSITION_PENDING_STORAGE_KEY), false);
    assert.equal(s.map.has(blockedKey), false);
    assert.equal(s.map.has(DEVICE_TOKEN_STORAGE_KEY), false);
    assert.equal(s.map.has(DEVICE_BINDING_STORAGE_KEY), false);
    assert.equal(s.map.has(AIUI_ID_STORAGE_KEY), false,
      '普通 pending replay 也必须清掉可能半提交的旧公开别名');
    assert.equal(ownerScopedDataAvailable(s), true);
  });
}

test('损坏的 owner journal 会先保守清理旧用户数据，再自愈并恢复身份初始化', () => {
  const s = storage({
    [OWNER_TRANSITION_PENDING_STORAGE_KEY]: '{broken-json',
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: 'SR-DEVICE-STAYS',
    [AIUI_ID_STORAGE_KEY]: {
      aiuiId: 'A7K2M9Q4', publicDeviceId: 'SR-DEVICE-STAYS',
      ownershipEpoch: 2, dataNamespace: 'old-owner',
    },
    [DEVICE_SECRET_STORAGE_KEY]: 's'.repeat(48),
    [DEVICE_TOKEN_STORAGE_KEY]: 'old-device-token',
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: true, ownershipEpoch: 2, dataNamespace: 'old-owner', updatedAtMs: 1,
    },
    pending_run_uploads: [{ client_run_id: 'old-private-run' }],
    local_run_memories: [{ text: 'old private memory' }],
  });
  const baseGet = s.getStorageSync.bind(s);
  s.getStorageSync = (key) => {
    if (key === OWNER_TRANSITION_PENDING_STORAGE_KEY
        && s.map.get(key) === '{broken-json') {
      throw new Error('stored JSON cannot be parsed');
    }
    return baseGet(key);
  };

  let replayed = 0;
  assert.equal(ownerScopedDataAvailable(s, { onReplayed: () => { replayed += 1; } }), true);
  assert.equal(replayed, 1, '破损 journal 的 destructive replay 必须通知内存任务失效');
  assert.equal(s.map.has(OWNER_TRANSITION_PENDING_STORAGE_KEY), false);
  assert.equal(s.map.has('pending_run_uploads'), false);
  assert.equal(s.map.has('local_run_memories'), false);
  assert.equal(s.map.has(DEVICE_TOKEN_STORAGE_KEY), false);
  assert.equal(s.map.has(DEVICE_BINDING_STORAGE_KEY), false);
  assert.equal(s.map.has(AIUI_ID_STORAGE_KEY), false, '旧 owner 的公开别名也必须清除');
  assert.equal(s.map.get(PUBLIC_DEVICE_ID_STORAGE_KEY), 'SR-DEVICE-STAYS');
  assert.equal(s.map.get(DEVICE_SECRET_STORAGE_KEY), 's'.repeat(48));
});

test('journal 单键损坏且 remove 静默失效时可用 complete 覆盖自愈', () => {
  const s = storage({
    [OWNER_TRANSITION_PENDING_STORAGE_KEY]: '{broken-json',
    [AIUI_ID_STORAGE_KEY]: 'A7K2M9Q4',
    [DEVICE_TOKEN_STORAGE_KEY]: 'old-token',
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: true, ownershipEpoch: 4, dataNamespace: 'old-owner', updatedAtMs: 1,
    },
    pending_run_uploads: [{ owner: 'old' }],
  });
  const baseGet = s.getStorageSync.bind(s);
  const baseRemove = s.removeStorageSync.bind(s);
  s.getStorageSync = (key) => {
    if (key === OWNER_TRANSITION_PENDING_STORAGE_KEY
        && s.map.get(key) === '{broken-json') throw new Error('bad encoded value');
    return baseGet(key);
  };
  s.removeStorageSync = (key) => {
    if (key === OWNER_TRANSITION_PENDING_STORAGE_KEY) return;
    baseRemove(key);
  };

  assert.equal(ownerScopedDataAvailable(s), true);
  assert.equal(s.map.get(OWNER_TRANSITION_PENDING_STORAGE_KEY), 'complete');
  assert.equal(s.map.has('pending_run_uploads'), false);
  assert.equal(s.map.has(DEVICE_TOKEN_STORAGE_KEY), false);
  assert.equal(s.map.has(DEVICE_BINDING_STORAGE_KEY), false);
  assert.equal(s.map.has(AIUI_ID_STORAGE_KEY), false);
});

test('全局或瞬时 storage 读取故障只 fail closed，不清 owner 数据', () => {
  const s = storage({
    [OWNER_TRANSITION_PENDING_STORAGE_KEY]: '{unknown}',
    [AIUI_ID_STORAGE_KEY]: 'A7K2M9Q4',
    [DEVICE_TOKEN_STORAGE_KEY]: 'old-token',
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: true, ownershipEpoch: 4, dataNamespace: 'old-owner', updatedAtMs: 1,
    },
    pending_run_uploads: [{ owner: 'must-stay' }],
  });
  s.getStorageSync = () => { throw new Error('storage temporarily unavailable'); };

  assert.equal(ownerScopedDataAvailable(s), false);
  assert.deepEqual(s.map.get('pending_run_uploads'), [{ owner: 'must-stay' }]);
  assert.equal(s.map.get(DEVICE_TOKEN_STORAGE_KEY), 'old-token');
  assert.equal(s.map.get(AIUI_ID_STORAGE_KEY), 'A7K2M9Q4');
  assert.equal(typeof s.map.get(DEVICE_BINDING_STORAGE_KEY), 'object');
});

test('bootstrap 缺 ownership_epoch 或 data_namespace 时拒绝持久化草案响应', () => {
  assert.equal(parseDeviceBootstrapResponse({ statusCode: 200, data: {
    public_device_id: 'SR-X', token: 't', data_namespace: 'ns',
  } }), null);
  assert.equal(parseDeviceBootstrapResponse({ statusCode: 200, data: {
    public_device_id: 'SR-X', token: 't', ownership_epoch: 1,
  } }), null);
  assert.equal(parseDeviceBootstrapResponse({ statusCode: 200, data: {
    public_device_id: 'SR-X', token: 't', ownership_epoch: null, data_namespace: 'ns',
  } }), null);
  const s = storage({ [DEVICE_TOKEN_STORAGE_KEY]: 'old-token' });
  assert.equal(persistDeviceBootstrap(s, {
    publicDeviceId: 'SR-X', token: 'new-token', bound: false,
  }), false);
  assert.equal(s.map.get(DEVICE_TOKEN_STORAGE_KEY), 'old-token');
});

test('bootstrap 只接受与顶层新 owner 完全一致的匿名 claim 迁移证明', () => {
  const valid = parseDeviceBootstrapResponse({ statusCode: 200, data: {
    public_device_id: 'SR-CLAIM-PROOF', aiui_id: 'P7R2O9F4', token: 'proof-token',
    bound: true, ownership_epoch: 2, data_namespace: 'ns_current_owner_1234567890',
    ownership_transition: {
      kind: 'anonymous_claim',
      previous_ownership_epoch: 1,
      previous_data_namespace: 'ns_previous_own_1234567890',
      current_ownership_epoch: 2,
      current_data_namespace: 'ns_current_owner_1234567890',
    },
  } });
  assert.ok(valid);
  assert.deepEqual(valid.ownershipTransition, {
    kind: 'anonymous_claim',
    previousOwnershipEpoch: 1,
    previousDataNamespace: 'ns_previous_own_1234567890',
    currentOwnershipEpoch: 2,
    currentDataNamespace: 'ns_current_owner_1234567890',
  });
  assert.equal(parseDeviceBootstrapResponse({ statusCode: 200, data: {
    public_device_id: 'SR-CLAIM-PROOF', token: 'proof-token',
    bound: true, ownership_epoch: 2, data_namespace: 'ns_current_owner_1234567890',
    ownership_transition: {
      kind: 'anonymous_claim',
      previous_ownership_epoch: 1,
      previous_data_namespace: 'ns_previous_own_1234567890',
      current_ownership_epoch: 2,
      current_data_namespace: 'ns_wrong_current_1234567890',
    },
  } }), null);
});

test('bootstrap：app_key 可选；未绑定、无 key 的设备也可获得低权限 token', async () => {
  const s = storage({ [LEGACY_DEVICE_ID_STORAGE_KEY]: 'legacy' });
  let calls = 0;
  let uuidCounter = 0;
  const secureCrypto = {
    randomUUID: () => '123e4567-e89b-12d3-a456-42661417'
      + String(uuidCounter++).padStart(4, '0'),
  };
  const noKey = await bootstrapDeviceIdentity({
    storage: s,
    cryptoObject: secureCrypto,
    request: async (req) => {
      calls += 1;
      assert.equal('app_key' in req.data, false);
      assert.equal('legacy_device_id' in req.data, false);
      if (req.url.endsWith(DEVICE_REGISTRATION_CREDENTIAL_PATH)) {
        assert.deepEqual(req.data, { app_id: 'AISmartRun' });
        return { statusCode: 200, data: {
          installation_id: 'inst_' + 'n'.repeat(28),
          device_credential: 'dcred_' + 's'.repeat(40),
        } };
      }
      assert.equal(req.data.installation_id, 'inst_' + 'n'.repeat(28));
      assert.equal(req.data.device_credential, 'dcred_' + 's'.repeat(40));
      assert.equal('device_secret' in req.data, false);
      return { statusCode: 200, data: {
        public_device_id: 'SR-NOKEY', aiui_id: 'A7K2M9Q4',
        token: 'jwt-low-scope', bound: false,
        ownership_epoch: 1, data_namespace: 'anon-a',
      } };
    },
  });
  assert.equal(calls, 2);
  assert.equal(noKey.publicDeviceId, 'SR-NOKEY');
  assert.equal(noKey.aiuiId, 'A7K2M9Q4');
  assert.equal(noKey.installationId, 'inst_' + 'n'.repeat(28));
  assert.equal(noKey.deviceCredential, 'dcred_' + 's'.repeat(40));
  assert.equal(s.map.has(DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY), false);

  const yes = await bootstrapDeviceIdentity({
    storage: s,
    cryptoObject: webcrypto,
    navigatorObject: { getDeviceSerialNumber: () => 'SN-2' },
    TextEncoderCtor: TextEncoder,
    appKey: 'key',
    clientId: 'AISmartRun',
    coachTokenStorageKey: 'coach_token',
    request: async (req) => {
      calls += 1;
      assert.equal('hardware_fingerprint' in req.data, false,
        '正常刷新不再读取或发送 SN 指纹');
      assert.equal('device_sn' in req.data, false);
      assert.equal(req.data.device_credential, s.map.get(DEVICE_CREDENTIAL_STORAGE_KEY));
      assert.equal('legacy_device_id' in req.data, false,
        'app_key 不是 legacy 所有权证明，普通 bootstrap 不发送旧标识');
      return { statusCode: 200, data: {
        public_device_id: 'SR-ANON', token: 'jwt-anon', bound: false,
        ownership_epoch: 1, data_namespace: 'anon-a',
      } };
    },
  });
  assert.equal(calls, 3);
  assert.equal(yes.publicDeviceId, 'SR-ANON');
  assert.equal(yes.bound, false);
  assert.equal(s.map.get('coach_token'), 'jwt-anon');
});

test('旧 user JWT 一次性迁移：收到 durable marker 后才替换 coach_token，并保留同用户队列', async () => {
  const oldToken = jwt({ sub: '17', kind: 'user' });
  const s = storage({
    [LEGACY_DEVICE_ID_STORAGE_KEY]: 'legacy-17',
    [DEVICE_SECRET_STORAGE_KEY]: 'm'.repeat(48),
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: false, ownershipEpoch: 2, dataNamespace: 'throwaway-anon', updatedAtMs: 1,
    },
    coach_token: oldToken,
    pending_run_uploads: [{ client_run_id: 'run-keep-17' }],
  });
  const originalLog = console.log;
  let logCalls = 0;
  console.log = () => { logCalls += 1; };
  try {
    let calls = 0;
    const identity = await bootstrapDeviceIdentity({
      storage: s,
      coachTokenStorageKey: 'coach_token',
      request: async (req) => {
        calls += 1;
        assert.equal(req.header.Authorization, 'Bearer ' + oldToken);
        assert.equal(req.data.legacy_device_id, 'legacy-17');
        assert.equal(req.data.device_secret, 'm'.repeat(48));
        return { statusCode: 200, data: {
          public_device_id: 'SR-MIGRATED', token: 'new-device-token', bound: false,
          ownership_epoch: 3, data_namespace: 'legacy-user-17',
          legacy_migration_complete: true,
        } };
      },
    });
    assert.equal(calls, 1, '同一次 bootstrap 最多发送一次迁移证明');
    assert.equal(identity.legacyMigrationComplete, true);
    assert.equal(s.map.get('coach_token'), 'new-device-token');
    assert.equal(s.map.get(DEVICE_TOKEN_STORAGE_KEY), 'new-device-token');
    assert.equal(s.map.has(LEGACY_COACH_TOKEN_STORAGE_KEY), false);
    assert.deepEqual(s.map.get(LEGACY_MIGRATION_STATE_STORAGE_KEY), {
      complete: true, legacyDeviceId: 'legacy-17',
    });
    assert.equal(s.map.has('pending_run_uploads'), true,
      '显式旧 JWT 迁移即便 unbound marker 跳变，也属于同用户连续性');
    assert.equal(logCalls, 0, '迁移链路不得记录旧/新 token');
  } finally {
    console.log = originalLog;
  }
});

test('旧宿主无凭据时先缓存服务器长期凭据，再携 legacy JWT 原子迁移而非新建匿名身份', async () => {
  const oldToken = jwt({ sub: '18', kind: 'user' });
  const bundle = registrationBundle('m');
  const s = storage({
    [LEGACY_DEVICE_ID_STORAGE_KEY]: 'legacy-user-18',
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: false,
      ownershipEpoch: 2,
      dataNamespace: 'throwaway-pre-migration-owner',
      updatedAtMs: 1,
    },
    coach_token: oldToken,
    pending_run_uploads: [{ client_run_id: 'run-legacy-18' }],
  });
  let serialReads = 0;
  let calls = 0;
  const identity = await bootstrapDeviceIdentity({
    storage: s,
    cryptoObject: {},
    navigatorObject: {
      getDeviceSerialNumber() { serialReads += 1; return 'SHOULD-NOT-BE-READ'; },
    },
    coachTokenStorageKey: 'coach_token',
    request: async (req) => {
      calls += 1;
      if (req.url.endsWith(DEVICE_REGISTRATION_CREDENTIAL_PATH)) {
        assert.deepEqual(req.data, { app_id: 'AISmartRun' });
        return { statusCode: 200, data: bundle };
      }
      assert.equal(req.header.Authorization, 'Bearer ' + oldToken);
      assert.equal(req.data.legacy_device_id, 'legacy-user-18');
      assert.equal(req.data.installation_id, bundle.installation_id);
      assert.equal(req.data.device_credential, bundle.device_credential);
      assert.equal('device_secret' in req.data, false);
      assert.deepEqual(s.map.get(DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY), {
        installationId: bundle.installation_id,
        deviceCredential: bundle.device_credential,
      });
      return { statusCode: 200, data: {
        public_device_id: 'SR-LEGACY-18', aiui_id: 'M7G2R9T4',
        token: 'legacy-device-token-18', bound: false,
        ownership_epoch: 4, data_namespace: 'legacy-owner-18',
        legacy_migration_complete: true,
      } };
    },
  });
  assert.equal(calls, 2);
  assert.equal(serialReads, 0);
  assert.equal(identity.network, true);
  assert.equal(identity.legacyMigrationComplete, true);
  assert.equal(identity.installationId, bundle.installation_id);
  assert.equal(identity.deviceCredential, bundle.device_credential);
  assert.equal(identity.aiuiId, 'M7G2R9T4');
  assert.equal(s.map.get('coach_token'), 'legacy-device-token-18');
  assert.deepEqual(s.map.get('pending_run_uploads'), [
    { client_run_id: 'run-legacy-18' },
  ], '显式 legacy proof 即使跨旧 marker，也保留同一用户的待传历史');
  assert.equal(s.map.has(DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY), false);
  assert.equal(s.map.has(LEGACY_COACH_TOKEN_STORAGE_KEY), false);
});

test('legacy 迁移遇到服务端拒绝时保留长期凭据和旧 proof，不自动轮换身份', async () => {
  const oldToken = jwt({ sub: '19', kind: 'user' });
  const issued = registrationBundle('x');
  const s = storage({
    [LEGACY_DEVICE_ID_STORAGE_KEY]: 'legacy-user-19',
    coach_token: oldToken,
    [DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY]: {
      installationId: issued.installation_id,
      deviceCredential: issued.device_credential,
    },
  });
  let calls = 0;
  const identity = await bootstrapDeviceIdentity({
    storage: s,
    cryptoObject: {},
    coachTokenStorageKey: 'coach_token',
    request: async (req) => {
      calls += 1;
      assert.equal(req.header.Authorization, 'Bearer ' + oldToken);
      assert.equal(req.data.legacy_device_id, 'legacy-user-19');
      assert.equal(req.data.installation_id, issued.installation_id);
      assert.equal(req.data.device_credential, issued.device_credential);
      return { statusCode: 401, data: { detail: 'invalid_device_credential' } };
    },
  });
  assert.equal(calls, 1);
  assert.equal(identity.network, false);
  assert.equal(identity.registrationPending, true);
  assert.equal(s.map.get(LEGACY_COACH_TOKEN_STORAGE_KEY), oldToken);
  assert.deepEqual(s.map.get(DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY), {
    installationId: issued.installation_id,
    deviceCredential: issued.device_credential,
  });
});

test('旧 JWT 401：保留独立证明并匿名可用；后续只重试一次且成功后退休旧 token', async () => {
  const oldToken = jwt({ sub: '29' });
  const s = storage({
    [LEGACY_DEVICE_ID_STORAGE_KEY]: 'legacy-29',
    [DEVICE_SECRET_STORAGE_KEY]: 'q'.repeat(48),
    coach_token: oldToken,
  });
  let firstCalls = 0;
  const anonymous = await bootstrapDeviceIdentity({
    storage: s,
    coachTokenStorageKey: 'coach_token',
    request: async (req) => {
      firstCalls += 1;
      if (req.data.legacy_device_id) return { statusCode: 401, data: {} };
      assert.equal('Authorization' in req.header, false);
      return { statusCode: 200, data: {
        public_device_id: 'SR-TEMP', token: 'temporary-device-token', bound: false,
        ownership_epoch: 1, data_namespace: 'anon-29',
      } };
    },
  });
  assert.equal(firstCalls, 2, '迁移失败后只额外做一次普通匿名 bootstrap');
  assert.equal(anonymous.network, true);
  assert.equal(anonymous.legacyMigrationPending, true);
  assert.equal(anonymous.legacyMigrationStatusCode, 401);
  assert.equal(s.map.get('coach_token'), oldToken, '401 不得覆盖唯一旧 user token');
  assert.equal(s.map.get(LEGACY_COACH_TOKEN_STORAGE_KEY), oldToken);
  assert.equal(s.map.get(DEVICE_TOKEN_STORAGE_KEY), 'temporary-device-token');

  let retryCalls = 0;
  const migrated = await bootstrapDeviceIdentity({
    storage: s,
    coachTokenStorageKey: 'coach_token',
    request: async (req) => {
      retryCalls += 1;
      assert.equal(req.header.Authorization, 'Bearer ' + oldToken);
      return { statusCode: 200, data: {
        public_device_id: 'SR-LEGACY-29', token: 'migrated-device-token', bound: false,
        ownership_epoch: 2, data_namespace: 'legacy-29',
        legacy_migration_complete: true,
      } };
    },
  });
  assert.equal(retryCalls, 1);
  assert.equal(migrated.legacyMigrationComplete, true);
  assert.equal(s.map.get('coach_token'), 'migrated-device-token');
  assert.equal(s.map.has(LEGACY_COACH_TOKEN_STORAGE_KEY), false);
});

test('无 SN/无 Web Crypto 宿主先缓存服务端长期凭据，再幂等 bootstrap 并长期复用', async () => {
  const s = storage();
  let call = 0;
  const first = await bootstrapDeviceIdentity({
    storage: s,
    cryptoObject: {},
    nowMs: 10,
    randomFn: () => 0.5,
    request: async (req) => {
      call += 1;
      if (req.url.endsWith(DEVICE_REGISTRATION_CREDENTIAL_PATH)) {
        assert.deepEqual(req.data, { app_id: 'AISmartRun' });
        return { statusCode: 200, data: {
          installation_id: 'inst_' + 'a'.repeat(28),
          device_credential: 'dcred_' + 'f'.repeat(40),
        } };
      }
      assert.equal(req.data.installation_id, 'inst_' + 'a'.repeat(28));
      assert.equal(req.data.device_credential, 'dcred_' + 'f'.repeat(40));
      assert.equal('device_secret' in req.data, false);
      assert.deepEqual(s.map.get(DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY), {
        installationId: 'inst_' + 'a'.repeat(28),
        deviceCredential: 'dcred_' + 'f'.repeat(40),
      }, 'bootstrap 前服务端二件套已写入并可读回');
      return { statusCode: 200, data: {
        public_device_id: 'SR-FALLBACK', aiui_id: 'A7K2M9Q4',
        token: 't1', bound: false,
        ownership_epoch: 1, data_namespace: 'anon-f',
      } };
    },
  });
  assert.equal(first.deviceCredential, 'dcred_' + 'f'.repeat(40));
  assert.equal(first.installationId, 'inst_' + 'a'.repeat(28));
  assert.equal(first.aiuiId, 'A7K2M9Q4');
  assert.equal(s.map.has(DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY), false,
    'active 身份完整提交后删除 pending journal');
  await bootstrapDeviceIdentity({
    storage: s, cryptoObject: {},
    request: async (req) => {
      call += 1;
      assert.equal(req.url.endsWith(DEVICE_BOOTSTRAP_PATH), true);
      assert.equal(req.data.device_credential, 'dcred_' + 'f'.repeat(40));
      assert.equal('device_secret' in req.data, false);
      return { statusCode: 200, data: {
        public_device_id: 'SR-FALLBACK', aiui_id: 'A7K2M9Q4',
        token: 't2', bound: false,
        ownership_epoch: 1, data_namespace: 'anon-f',
      } };
    },
  });
  assert.equal(call, 3);
  assert.equal(s.map.get(DEVICE_CREDENTIAL_STORAGE_KEY), 'dcred_' + 'f'.repeat(40),
    '刷新响应不可覆盖长期凭据');
});

test('bootstrap 响应丢失后复用同一 pending 长期凭据，不重复签发或生成身份', async () => {
  const s = storage();
  const bundle = registrationBundle('l');
  let challengeCalls = 0;
  let bootstrapCalls = 0;
  let firstBootstrap = null;
  const first = await bootstrapDeviceIdentity({
    storage: s,
    cryptoObject: {},
    request: async (req) => {
      if (req.url.endsWith(DEVICE_REGISTRATION_CREDENTIAL_PATH)) {
        challengeCalls += 1;
        return { statusCode: 200, data: bundle };
      }
      bootstrapCalls += 1;
      firstBootstrap = req;
      return null;
    },
  });
  assert.equal(first.network, false);
  assert.equal(first.registrationPending, true);
  assert.equal(challengeCalls, 1);
  assert.equal(bootstrapCalls, 1);
  assert.ok(s.map.get(DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY));

  const second = await bootstrapDeviceIdentity({
    storage: s,
    cryptoObject: {},
    request: async (req) => {
      assert.equal(req.url.endsWith(DEVICE_REGISTRATION_CREDENTIAL_PATH), false);
      bootstrapCalls += 1;
      assert.deepEqual(req.data, firstBootstrap.data);
      return { statusCode: 200, data: {
        public_device_id: 'SR-LOST', aiui_id: 'L7S2T9R4',
        token: 'lost-response-token', bound: false,
        ownership_epoch: 1, data_namespace: 'anon-lost',
      } };
    },
  });
  assert.equal(challengeCalls, 1, '重试不得再次签发 installation/credential');
  assert.equal(bootstrapCalls, 2);
  assert.equal(second.network, true);
  assert.equal(second.installationId, bundle.installation_id);
  assert.equal(second.deviceCredential, bundle.device_credential);
  assert.equal(second.aiuiId, 'L7S2T9R4');
  assert.equal(s.map.has(DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY), false);
});

test('bootstrap 401 不会轮换已缓存的长期 device_credential', async () => {
  const bundle = registrationBundle('o');
  const s = storage({
    [DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY]: {
      installationId: bundle.installation_id,
      deviceCredential: bundle.device_credential,
    },
  });
  const requests = [];
  const identity = await bootstrapDeviceIdentity({
    storage: s,
    cryptoObject: {},
    request: async (req) => {
      requests.push(req);
      assert.equal(req.data.installation_id, bundle.installation_id);
      assert.equal(req.data.device_credential, bundle.device_credential);
      return { statusCode: 401, data: { detail: 'invalid_device_credential' } };
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(identity.network, false);
  assert.equal(identity.registrationPending, true);
  assert.deepEqual(s.map.get(DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY), {
    installationId: bundle.installation_id,
    deviceCredential: bundle.device_credential,
  });
});

test('并发首次 bootstrap single-flight，迟到凭据签发/响应不能重复创建', async () => {
  const s = storage();
  const bundle = registrationBundle('c');
  let challengeCalls = 0;
  let bootstrapCalls = 0;
  let releaseChallenge;
  const challengeGate = new Promise((resolve) => { releaseChallenge = resolve; });
  const request = async (req) => {
    if (req.url.endsWith(DEVICE_REGISTRATION_CREDENTIAL_PATH)) {
      challengeCalls += 1;
      await challengeGate;
      return { statusCode: 200, data: bundle };
    }
    bootstrapCalls += 1;
    return { statusCode: 200, data: {
      public_device_id: 'SR-CONCURRENT', aiui_id: 'C7N2R9T4',
      token: 'concurrent-token', bound: false,
      ownership_epoch: 1, data_namespace: 'anon-concurrent',
    } };
  };
  const first = bootstrapDeviceIdentity({ storage: s, cryptoObject: {}, request });
  const second = bootstrapDeviceIdentity({ storage: s, cryptoObject: {}, request });
  releaseChallenge();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(challengeCalls, 1);
  assert.equal(bootstrapCalls, 1);
  assert.equal(left.aiuiId, 'C7N2R9T4');
  assert.equal(right.aiuiId, 'C7N2R9T4');
});

test('active bootstrap 持久化前拒绝 ownership epoch 倒退且不清当前队列', () => {
  const credential = 'dcred_' + 'r'.repeat(40);
  const queuedRun = { client_run_id: 'run-current-owner' };
  const s = storage({
    [INSTALLATION_ID_STORAGE_KEY]: 'inst_' + 'r'.repeat(28),
    [DEVICE_CREDENTIAL_STORAGE_KEY]: credential,
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: 'SR-ACTIVE-REGRESSION',
    [DEVICE_TOKEN_STORAGE_KEY]: 'token-epoch-2',
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: true, ownershipEpoch: 2, dataNamespace: 'owner-epoch-2', updatedAtMs: 2,
    },
    pending_run_uploads: [queuedRun],
  });

  const persisted = persistDeviceBootstrap(s, {
    publicDeviceId: 'SR-ACTIVE-REGRESSION',
    aiuiId: 'R7E2G9S4',
    token: 'token-epoch-1-stale',
    bound: false,
    ownershipEpoch: 1,
    dataNamespace: 'owner-epoch-1',
  }, { deviceCredential: credential });

  assert.equal(persisted, false);
  assert.equal(s.map.get(DEVICE_TOKEN_STORAGE_KEY), 'token-epoch-2');
  assert.equal(s.map.get(DEVICE_BINDING_STORAGE_KEY).ownershipEpoch, 2);
  assert.deepEqual(s.map.get('pending_run_uploads'), [queuedRun]);
});

test('并发 active bootstrap：epoch2 先提交后，迟到 epoch1 不回滚 token 或队列', async () => {
  const credential = 'dcred_' + 'q'.repeat(40);
  const queuedRun = { client_run_id: 'run-owner-continuity' };
  const s = storage({
    [INSTALLATION_ID_STORAGE_KEY]: 'inst_' + 'q'.repeat(28),
    [DEVICE_CREDENTIAL_STORAGE_KEY]: credential,
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: 'SR-ACTIVE-RACE',
    [DEVICE_TOKEN_STORAGE_KEY]: 'token-epoch-1',
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: false, ownershipEpoch: 1, dataNamespace: 'anon-epoch-1', updatedAtMs: 1,
    },
    pending_run_uploads: [queuedRun],
  });
  const resolvers = [];
  const request = () => new Promise((resolve) => { resolvers.push(resolve); });
  const first = bootstrapDeviceIdentity({ storage: s, request });
  const second = bootstrapDeviceIdentity({ storage: s, request });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolvers.length, 2, 'active identity refreshes may overlap across page routes');

  resolvers[1]({
    statusCode: 200,
    data: {
      public_device_id: 'SR-ACTIVE-RACE',
      aiui_id: 'N7E2W9R4',
      token: 'token-epoch-2',
      bound: true,
      ownership_epoch: 2,
      data_namespace: 'bound-epoch-2',
      ownership_transition: {
        kind: 'anonymous_claim',
        previous_ownership_epoch: 1,
        previous_data_namespace: 'anon-epoch-1',
        current_ownership_epoch: 2,
        current_data_namespace: 'bound-epoch-2',
      },
    },
  });
  const newer = await second;
  assert.equal(newer.network, true);
  assert.equal(s.map.get(DEVICE_BINDING_STORAGE_KEY).ownershipEpoch, 2);

  resolvers[0]({
    statusCode: 200,
    data: {
      public_device_id: 'SR-ACTIVE-RACE',
      aiui_id: 'O7L2D9R4',
      token: 'token-epoch-1-stale',
      bound: false,
      ownership_epoch: 1,
      data_namespace: 'anon-epoch-1',
    },
  });
  const stale = await first;

  assert.equal(stale.network, false);
  assert.equal(stale.activeBootstrapSuperseded, true);
  assert.equal(s.map.get(DEVICE_TOKEN_STORAGE_KEY), 'token-epoch-2');
  assert.equal(s.map.get(DEVICE_BINDING_STORAGE_KEY).ownershipEpoch, 2);
  assert.equal(s.map.get(DEVICE_BINDING_STORAGE_KEY).dataNamespace, 'bound-epoch-2');
  assert.deepEqual(s.map.get('pending_run_uploads'), [queuedRun]);
});

test('fresh recovery 轮换长期二件套后，旧 active bootstrap 的更高 epoch 也必须失效', async () => {
  const oldCredential = 'dcred_' + 'o'.repeat(40);
  const oldInstallation = 'inst_' + 'o'.repeat(28);
  const s = storage({
    [INSTALLATION_ID_STORAGE_KEY]: oldInstallation,
    [DEVICE_CREDENTIAL_STORAGE_KEY]: oldCredential,
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: 'SR-OLD-ACTIVE',
    [AIUI_ID_STORAGE_KEY]: {
      aiuiId: 'O7L2D9R4',
      publicDeviceId: 'SR-OLD-ACTIVE',
      ownershipEpoch: 5,
      dataNamespace: 'owner-old-5',
    },
    [DEVICE_TOKEN_STORAGE_KEY]: 'token-old-5',
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: true, ownershipEpoch: 5, dataNamespace: 'owner-old-5', updatedAtMs: 5,
    },
    pending_run_uploads: [{ client_run_id: 'run-old-owner' }],
  });
  let resolveOldBootstrap;
  const oldBootstrap = bootstrapDeviceIdentity({
    storage: s,
    coachTokenStorageKey: 'coach_token',
    request: () => new Promise((resolve) => { resolveOldBootstrap = resolve; }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof resolveOldBootstrap, 'function');

  // 旧刷新挂起期间本地长期凭据丢失；正常 bootstrap 先 durable 化显式恢复状态。
  s.map.delete(DEVICE_CREDENTIAL_STORAGE_KEY);
  const recoveryNeeded = await bootstrapDeviceIdentity({
    storage: s,
    request: async () => {
      throw new Error('missing active credential must not silently register');
    },
  });
  assert.equal(recoveryNeeded.credentialRecoveryRequired, true);
  assert.equal(s.map.get(DEVICE_RECOVERY_STATE_STORAGE_KEY), 'required');

  const newBundle = registrationBundle('n');
  const recovered = await recoverFreshAnonymousDeviceIdentity({
    storage: s,
    clientId: 'AISmartRun',
    coachTokenStorageKey: 'coach_token',
    userConfirmed: true,
    request: async (req) => {
      if (req.url.endsWith(DEVICE_REGISTRATION_CREDENTIAL_PATH)) {
        return { statusCode: 200, data: newBundle };
      }
      return {
        statusCode: 200,
        data: {
          public_device_id: 'SR-NEW-ACTIVE',
          aiui_id: 'N7E2W9R4',
          token: 'token-new-1',
          bound: false,
          ownership_epoch: 1,
          data_namespace: 'owner-new-1',
        },
      };
    },
  });
  assert.equal(recovered.network, true);
  assert.equal(s.map.get(INSTALLATION_ID_STORAGE_KEY), newBundle.installation_id);
  assert.equal(s.map.get(DEVICE_CREDENTIAL_STORAGE_KEY), newBundle.device_credential);
  assert.equal(s.map.get(PUBLIC_DEVICE_ID_STORAGE_KEY), 'SR-NEW-ACTIVE');
  assert.equal(s.map.get(DEVICE_BINDING_STORAGE_KEY).ownershipEpoch, 1);

  resolveOldBootstrap({
    statusCode: 200,
    data: {
      public_device_id: 'SR-OLD-ACTIVE',
      aiui_id: 'O7L2D9R4',
      token: 'token-old-6-late',
      bound: true,
      ownership_epoch: 6,
      data_namespace: 'owner-old-6',
    },
  });
  const stale = await oldBootstrap;

  assert.equal(stale.network, false);
  assert.equal(stale.activeBootstrapSuperseded, true);
  assert.equal(s.map.get(INSTALLATION_ID_STORAGE_KEY), newBundle.installation_id);
  assert.equal(s.map.get(DEVICE_CREDENTIAL_STORAGE_KEY), newBundle.device_credential);
  assert.equal(s.map.get(PUBLIC_DEVICE_ID_STORAGE_KEY), 'SR-NEW-ACTIVE');
  assert.equal(s.map.get(DEVICE_TOKEN_STORAGE_KEY), 'token-new-1');
  assert.equal(s.map.get(DEVICE_BINDING_STORAGE_KEY).ownershipEpoch, 1);
  assert.equal(s.map.get(DEVICE_BINDING_STORAGE_KEY).dataNamespace, 'owner-new-1');
  assert.equal(s.map.has('pending_run_uploads'), false);
});

test('bootstrap 200 迟到时必须重新核对 pending 长期凭据，不能覆盖较新候选', async () => {
  const s = storage();
  const oldBundle = registrationBundle('d');
  const newBundle = registrationBundle('e');
  let releaseBootstrap;
  let markBootstrapStarted;
  const bootstrapGate = new Promise((resolve) => { releaseBootstrap = resolve; });
  const bootstrapStarted = new Promise((resolve) => { markBootstrapStarted = resolve; });
  const pending = bootstrapDeviceIdentity({
    storage: s,
    cryptoObject: {},
    request: async (req) => {
      if (req.url.endsWith(DEVICE_REGISTRATION_CREDENTIAL_PATH)) {
        return { statusCode: 200, data: oldBundle };
      }
      markBootstrapStarted();
      await bootstrapGate;
      return { statusCode: 200, data: {
        public_device_id: 'SR-STALE', aiui_id: 'D7L2Y9Q4',
        token: 'stale-token', bound: false,
        ownership_epoch: 1, data_namespace: 'anon-stale',
      } };
    },
  });
  await bootstrapStarted;
  s.setStorageSync(DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY, {
    installationId: newBundle.installation_id,
    deviceCredential: newBundle.device_credential,
  });
  releaseBootstrap();
  const identity = await pending;
  assert.equal(identity.network, false);
  assert.equal(identity.registrationSuperseded, true);
  assert.equal(s.map.has(PUBLIC_DEVICE_ID_STORAGE_KEY), false);
  assert.deepEqual(s.map.get(DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY), {
    installationId: newBundle.installation_id,
    deviceCredential: newBundle.device_credential,
  });
});

test('完整 active 身份忽略并清理 stale registration pending，不再签发或读取 SN', async () => {
  const stale = registrationBundle('z');
  const s = storage({
    [INSTALLATION_ID_STORAGE_KEY]: 'inst-active-server',
    [DEVICE_SECRET_STORAGE_KEY]: 'dsec_' + 'a'.repeat(36),
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: 'SR-ACTIVE',
    [AIUI_ID_STORAGE_KEY]: {
      aiuiId: 'A7C2T9V4', publicDeviceId: 'SR-ACTIVE',
      ownershipEpoch: 3, dataNamespace: 'active-owner',
    },
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: false, ownershipEpoch: 3, dataNamespace: 'active-owner', updatedAtMs: 1,
    },
    [DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY]: {
      installationId: stale.installation_id,
      deviceCredential: stale.device_credential,
    },
  });
  let serialReads = 0;
  let calls = 0;
  const identity = await bootstrapDeviceIdentity({
    storage: s,
    navigatorObject: { getDeviceSerialNumber: () => { serialReads += 1; return 'SN'; } },
    cryptoObject: webcrypto,
    TextEncoderCtor: TextEncoder,
    request: async (req) => {
      calls += 1;
      assert.equal(req.url.endsWith(DEVICE_BOOTSTRAP_PATH), true);
      assert.equal(req.data.installation_id, 'inst-active-server');
      assert.equal(req.data.device_secret, 'dsec_' + 'a'.repeat(36));
      assert.equal('hardware_fingerprint' in req.data, false);
      return { statusCode: 200, data: {
        public_device_id: 'SR-ACTIVE', aiui_id: 'A7C2T9V4',
        token: 'active-token', bound: false,
        ownership_epoch: 3, data_namespace: 'active-owner',
      } };
    },
  });
  assert.equal(calls, 1);
  assert.equal(serialReads, 0);
  assert.equal(identity.installationId, 'inst-active-server');
  assert.equal(identity.aiuiId, 'A7C2T9V4');
  assert.equal(s.map.has(DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY), false);
});

test('首次签发缺少长期 device_credential 时拒绝注册且不误报 storage 故障', async () => {
  const s = storage();
  const identity = await bootstrapDeviceIdentity({
    storage: s,
    cryptoObject: {},
    nowMs: 20,
    randomFn: () => 0.25,
    request: async () => ({ statusCode: 200, data: {
      installation_id: 'inst_' + 'x'.repeat(28),
    } }),
  });
  assert.equal(identity.network, false);
  assert.equal(identity.registrationCredentialFailed, true);
  assert.equal(identity.registrationPending, true);
  assert.notEqual(identity.credentialStorageUnavailable, true);
  assert.equal(s.map.has(PUBLIC_DEVICE_ID_STORAGE_KEY), false,
    '不完整签发响应不能半提交公开身份');
  assert.equal(s.map.has(DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY), false);
});

test('device_credential storage 无法写入/读回时 bootstrap fail closed，不注册不可恢复身份', async () => {
  let requests = 0;
  const broken = {
    getStorageSync() { return ''; },
    setStorageSync() { throw new Error('storage unavailable'); },
    removeStorageSync() {},
  };
  const identity = await bootstrapDeviceIdentity({
    storage: broken,
    cryptoObject: webcrypto,
    request: async () => { requests += 1; return null; },
  });
  assert.equal(requests, 0);
  assert.equal(identity.network, false);
  assert.equal(identity.credentialStorageUnavailable, true);
  assert.equal(identity.deviceCredential, '');
  assert.equal(identity.deviceSecret, '');
});

test('installation_id probe 被宿主吞掉时 fail closed，且不生成本地凭据或联网注册', async () => {
  const s = storage();
  const baseSet = s.setStorageSync.bind(s);
  s.setStorageSync = (key, value) => {
    if (key === INSTALLATION_ID_STORAGE_KEY) return;
    baseSet(key, value);
  };
  let requests = 0;
  const identity = await bootstrapDeviceIdentity({
    storage: s,
    cryptoObject: webcrypto,
    request: async () => { requests += 1; return null; },
  });
  assert.equal(requests, 0);
  assert.equal(identity.credentialStorageUnavailable, true);
  assert.equal(identity.installationIdStorageReady, false);
  assert.equal(identity.installationId, '');
  assert.equal(s.map.has(DEVICE_CREDENTIAL_STORAGE_KEY), false);
  assert.equal(s.map.has(DEVICE_SECRET_STORAGE_KEY), false);
});

test('secret 丢失的 401 只能经用户确认创建 fresh anonymous，恢复请求不携带指纹/legacy', async () => {
  const staleBeforeConfirmation = registrationBundle('p');
  const s = storage({
    [INSTALLATION_ID_STORAGE_KEY]: 'ins-old',
    [LEGACY_DEVICE_ID_STORAGE_KEY]: 'legacy-old',
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: 'SR-OLD',
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: true, ownershipEpoch: 5, dataNamespace: 'user-old', updatedAtMs: 1,
    },
    coach_token: 'legacy-user-token',
    pending_run_uploads: [{ old: true }],
    [DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY]: {
      installationId: staleBeforeConfirmation.installation_id,
      deviceCredential: staleBeforeConfirmation.device_credential,
    },
  });
  let uuid = 0;
  const cryptoObject = {
    subtle: webcrypto.subtle,
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    randomUUID: () => '123e4567-e89b-12d3-a456-42661417'
      + String(uuid++).padStart(4, '0'),
  };
  let unauthorizedNetworkCalls = 0;
  const first = await bootstrapDeviceIdentity({
    storage: s,
    appKey: 'recovery-key',
    navigatorObject: { getDeviceSerialNumber: () => 'KNOWN-SN' },
    cryptoObject,
    TextEncoderCtor: TextEncoder,
    request: async () => { unauthorizedNetworkCalls += 1; return null; },
  });
  assert.equal(first.credentialRecoveryRequired, true);
  assert.equal(unauthorizedNetworkCalls, 0,
    '已有 public ID 丢失 credential 时不能用 SN、app_key 或自动签发接管');
  assert.equal(s.map.has('pending_run_uploads'), true, '用户尚未接受前不清旧本地数据');
  const oldActive = {
    installationId: s.map.get(INSTALLATION_ID_STORAGE_KEY),
    deviceCredential: s.map.get(DEVICE_CREDENTIAL_STORAGE_KEY),
    deviceSecret: s.map.get(DEVICE_SECRET_STORAGE_KEY),
    publicDeviceId: s.map.get(PUBLIC_DEVICE_ID_STORAGE_KEY),
    binding: s.map.get(DEVICE_BINDING_STORAGE_KEY),
    coachToken: s.map.get('coach_token'),
  };

  let failedRecoveryRequest = null;
  let recoveryChallengeCalls = 0;
  const unconfirmed = await recoverFreshAnonymousDeviceIdentity({
    storage: s,
    clientId: 'AISmartRun',
    cryptoObject,
    coachTokenStorageKey: 'coach_token',
    request: async () => { throw new Error('unconfirmed recovery must not call network'); },
  });
  assert.equal(unconfirmed.userConfirmationRequired, true);
  assert.equal(s.map.has('pending_run_uploads'), true);
  assert.deepEqual(s.map.get(DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY), {
    installationId: staleBeforeConfirmation.installation_id,
    deviceCredential: staleBeforeConfirmation.device_credential,
  }, '未确认时不能把普通候选误当作恢复授权，也不提前修改其 journal');

  const failed = await recoverFreshAnonymousDeviceIdentity({
    storage: s,
    clientId: 'AISmartRun',
    cryptoObject,
    coachTokenStorageKey: 'coach_token',
    userConfirmed: true,
    request: async (req) => {
      if (req.url.endsWith(DEVICE_REGISTRATION_CREDENTIAL_PATH)) {
        recoveryChallengeCalls += 1;
        return { statusCode: 200, data: {
          installation_id: 'inst_' + 'r'.repeat(28),
          device_credential: 'dcred_' + 'r'.repeat(40),
        } };
      }
      failedRecoveryRequest = req;
      return null;
    },
  });
  assert.equal(recoveryChallengeCalls, 1);
  assert.notEqual(
    failedRecoveryRequest.data.installation_id,
    staleBeforeConfirmation.installation_id,
    '用户确认前留下的 generic candidate 不得被 fresh recovery 复用',
  );
  assert.equal(failed.credentialRecoveryPending, true);
  assert.equal('app_key' in failedRecoveryRequest.data, false,
    '低权限 fresh anonymous 恢复不要求共享 app key');
  assert.equal('hardware_fingerprint' in failedRecoveryRequest.data, false);
  assert.equal('legacy_device_id' in failedRecoveryRequest.data, false);
  assert.equal(s.map.get(INSTALLATION_ID_STORAGE_KEY), oldActive.installationId,
    '网络失败前不覆盖 active installation');
  assert.equal(s.map.get(DEVICE_CREDENTIAL_STORAGE_KEY), oldActive.deviceCredential,
    '网络失败前不覆盖 active credential');
  assert.equal(s.map.get(DEVICE_SECRET_STORAGE_KEY), oldActive.deviceSecret,
    '网络失败前不覆盖 active secret');
  assert.equal(s.map.get(PUBLIC_DEVICE_ID_STORAGE_KEY), oldActive.publicDeviceId);
  assert.deepEqual(s.map.get(DEVICE_BINDING_STORAGE_KEY), oldActive.binding);
  assert.equal(s.map.get('coach_token'), oldActive.coachToken);
  assert.equal(s.map.has('pending_run_uploads'), true);
  assert.deepEqual(s.map.get(DEVICE_RECOVERY_CANDIDATE_STORAGE_KEY), {
    installationId: failedRecoveryRequest.data.installation_id,
    deviceCredential: failedRecoveryRequest.data.device_credential,
  }, '确认后签发的长期凭据写入独立 recovery journal，供断网重试同一身份');
  assert.equal(s.map.has(DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY), false,
    'fresh recovery 不得污染或复用普通首次注册 candidate journal');
  assert.match(s.map.get(DEVICE_RECOVERY_STATE_STORAGE_KEY), /^pending:/);

  let recoveryRequest = null;
  const recovered = await recoverFreshAnonymousDeviceIdentity({
    storage: s,
    clientId: 'AISmartRun',
    cryptoObject,
    coachTokenStorageKey: 'coach_token',
    userConfirmed: true,
    request: async (req) => {
      recoveryRequest = req;
      return { statusCode: 200, data: {
        public_device_id: 'SR-FRESH', aiui_id: 'F7R2S9H4',
        token: 'fresh-token', bound: false,
        ownership_epoch: 1, data_namespace: 'anon-fresh',
      } };
    },
  });
  assert.ok(recoveryRequest);
  assert.equal('app_key' in recoveryRequest.data, false);
  assert.equal('hardware_fingerprint' in recoveryRequest.data, false);
  assert.equal('legacy_device_id' in recoveryRequest.data, false);
  assert.notEqual(recoveryRequest.data.installation_id, 'ins-old');
  assert.equal(recoveryRequest.data.installation_id, failedRecoveryRequest.data.installation_id,
    '断网重试复用 journal 中同一 installation');
  assert.equal(recoveryRequest.data.device_credential,
    failedRecoveryRequest.data.device_credential,
    '断网重试复用 journal 中同一长期 credential');
  assert.equal(recoveryRequest.data.device_credential,
    s.map.get(DEVICE_CREDENTIAL_STORAGE_KEY));
  assert.equal(recovered.identityReset, true);
  assert.equal(recovered.publicDeviceId, 'SR-FRESH');
  assert.equal(recovered.aiuiId, 'F7R2S9H4');
  assert.equal(s.map.has(LEGACY_DEVICE_ID_STORAGE_KEY), false);
  assert.equal(s.map.has('pending_run_uploads'), false);
  assert.equal(s.map.get('coach_token'), 'fresh-token');
  assert.equal(s.map.has(DEVICE_RECOVERY_CANDIDATE_STORAGE_KEY), false);
  assert.equal(s.map.has(DEVICE_REGISTRATION_CANDIDATE_STORAGE_KEY), false);
  assert.equal(s.map.has(DEVICE_RECOVERY_STATE_STORAGE_KEY), false);
  assert.equal(
    s.map.get(HARDWARE_FINGERPRINT_SUPPRESSED_STORAGE_KEY),
    recoveryRequest.data.installation_id,
  );

  let refreshRequest = null;
  const refreshed = await bootstrapDeviceIdentity({
    storage: s,
    navigatorObject: { getDeviceSerialNumber: () => 'KNOWN-SN' },
    cryptoObject,
    TextEncoderCtor: TextEncoder,
    coachTokenStorageKey: 'coach_token',
    request: async (req) => {
      refreshRequest = req;
      return { statusCode: 200, data: {
        public_device_id: 'SR-FRESH', aiui_id: 'F7R2S9H4',
        token: 'fresh-token-2', bound: false,
        ownership_epoch: 1, data_namespace: 'anon-fresh',
      } };
    },
  });
  assert.ok(refreshRequest);
  assert.equal('hardware_fingerprint' in refreshRequest.data, false,
    'fresh identity 后续启动必须持续走 installation+secret，不能重新命中旧 SN 身份');
  assert.equal(refreshRequest.data.installation_id, recoveryRequest.data.installation_id);
  assert.equal(refreshed.network, true);
  assert.equal(s.map.get('coach_token'), 'fresh-token-2');
});

test('健康 active 身份即使调用方传 userConfirmed 也不能直接触发 fresh recovery', async () => {
  const credential = 'dcred_' + 'h'.repeat(40);
  const s = storage({
    [INSTALLATION_ID_STORAGE_KEY]: 'inst_' + 'h'.repeat(28),
    [DEVICE_CREDENTIAL_STORAGE_KEY]: credential,
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: 'SR-HEALTHY',
    [DEVICE_TOKEN_STORAGE_KEY]: 'token-healthy',
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: false,
      ownershipEpoch: 1,
      dataNamespace: 'anon-healthy',
    },
  });
  let networkCalls = 0;
  const result = await recoverFreshAnonymousDeviceIdentity({
    storage: s,
    userConfirmed: true,
    request: async () => {
      networkCalls += 1;
      return null;
    },
  });
  assert.equal(result.recoveryNotRequired, true);
  assert.equal(result.credentialRecoveryRequired, false);
  assert.equal(networkCalls, 0);
  assert.equal(s.map.get(PUBLIC_DEVICE_ID_STORAGE_KEY), 'SR-HEALTHY');
  assert.equal(s.map.get(DEVICE_CREDENTIAL_STORAGE_KEY), credential);
});

test('所有权隔离：首次匿名绑定保留历史；解绑或换绑 epoch 变化清除用户数据', () => {
  const workoutDurableKeys = new Set([
    'pending_workout_completions_v2',
    'pending_workout_completions_state_v1',
    'quarantined_workout_completions_v1',
    'quarantined_workout_completions_state_v1',
    'smartrun_workout_execution_v1',
    'smartrun_workout_execution_state_v1',
    'pending_sport_agent_runs_v1',
    'pending_sport_agent_runs_state_v1',
  ]);
  const firstClaimScopedKeys = OWNER_SCOPED_STORAGE_KEYS.filter(
    (key) => !workoutDurableKeys.has(key),
  );
  const retainedClaimKeys = firstClaimScopedKeys.filter(
    (key) => key !== HEART_RATE_POLICY_STORAGE_KEY,
  );
  const scoped = Object.fromEntries(firstClaimScopedKeys.map((key) => [key, { old: key }]));
  const s = storage({
    ...scoped,
    run_settings: { strideM: 0.7 },
    [DEVICE_SECRET_STORAGE_KEY]: 's'.repeat(48),
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: 'SR-1',
    [AIUI_ID_STORAGE_KEY]: { aiuiId: 'A7K2M9Q4', publicDeviceId: 'SR-1' },
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: false, ownershipEpoch: 1, dataNamespace: 'anon-a', updatedAtMs: 1,
    },
  });
  let clears = 0;
  persistDeviceBootstrap(s, {
    publicDeviceId: 'SR-1', aiuiId: 'A7K2M9Q4', token: 'bound-token', bound: true,
    ownershipEpoch: 2, dataNamespace: 'user-a',
    ownershipTransition: anonymousClaimProof(
      claimOwner(false, 1, 'anon-a'),
      claimOwner(true, 2, 'user-a'),
    ),
  }, { onOwnerDataCleared: () => { clears += 1; } });
  assert.equal(clears, 0, '首次绑定允许匿名历史连续迁移');
  for (const key of retainedClaimKeys) assert.equal(s.map.has(key), true);
  assert.equal(s.map.has(HEART_RATE_POLICY_STORAGE_KEY), false,
    '最大心率策略不是可迁移历史，首次 claim 也必须等待新 owner 重新签发');

  persistDeviceBootstrap(s, {
    publicDeviceId: 'SR-1', aiuiId: 'B8L3N0R5', token: 'user-b-token', bound: true,
    ownershipEpoch: 3, dataNamespace: 'user-b',
  }, { onOwnerDataCleared: () => { clears += 1; } });
  assert.equal(clears, 1, '已绑定后换绑必须隔离');
  for (const key of OWNER_SCOPED_STORAGE_KEYS) assert.equal(s.map.has(key), false);
  assert.deepEqual(s.map.get('run_settings'), { strideM: 0.7 }, '设备级设置保留');
  assert.equal(s.map.get(DEVICE_SECRET_STORAGE_KEY), 's'.repeat(48));
  assert.deepEqual(s.map.get(AIUI_ID_STORAGE_KEY), {
    aiuiId: 'B8L3N0R5', publicDeviceId: 'SR-1',
    ownershipEpoch: 3, dataNamespace: 'user-b',
  }, '所有权变化后即使 public_device_id 不变，也要替换旧 AIUI ID');

  s.setStorageSync('pending_run_uploads', [{ old: true }]);
  persistDeviceBootstrap(s, {
    publicDeviceId: 'SR-1', aiuiId: 'C9M4P1S6', token: 'anon-token', bound: false,
    ownershipEpoch: 4, dataNamespace: 'anon-b',
  });
  assert.equal(s.map.has('pending_run_uploads'), false, '解绑同样清除新匿名用户不可见的旧历史');
  assert.deepEqual(s.map.get(AIUI_ID_STORAGE_KEY), {
    aiuiId: 'C9M4P1S6', publicDeviceId: 'SR-1',
    ownershipEpoch: 4, dataNamespace: 'anon-b',
  }, '解绑后必须用服务器新生成的 AIUI ID 覆盖旧值');

  s.setStorageSync(AIUI_ID_STORAGE_KEY, { aiuiId: 'C9M4P1S6', publicDeviceId: 'SR-1' });
  persistDeviceBootstrap(s, {
    publicDeviceId: 'SR-1', token: 'next-owner-token', bound: true,
    ownershipEpoch: 6, dataNamespace: 'user-c',
  });
  assert.equal(s.map.has(AIUI_ID_STORAGE_KEY), false,
    '所有权跳变但服务器未返回新 ID 时宁可待分配，不得显示旧 ID');

  const skipped = storage({
    pending_run_uploads: [{ old: true }],
    [DEVICE_SECRET_STORAGE_KEY]: 'p'.repeat(48),
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: false, ownershipEpoch: 10, dataNamespace: 'anon-before', updatedAtMs: 1,
    },
  });
  persistDeviceBootstrap(skipped, {
    publicDeviceId: 'SR-SKIP', token: 'anon-after-token', bound: false,
    ownershipEpoch: 12, dataNamespace: 'anon-after',
  });
  assert.equal(skipped.map.has('pending_run_uploads'), false,
    '未轮询到中间 bind→unbind 时也按 marker 跳跃隔离');
});

test('服务器证明的连续匿名 claim 保留普通待传队列但不迁移健康现场日志', () => {
  const previousOwner = claimOwner(false, 1, 'anon-field-log-1');
  const nextOwner = claimOwner(true, 2, 'user-field-log-2');
  const credential = 'dcred_' + 'm'.repeat(40);
  const pendingRuns = [{ client_run_id: 'anonymous-run-kept-by-existing-contract' }];
  const s = storage({
    [INSTALLATION_ID_STORAGE_KEY]: 'inst_' + 'm'.repeat(28),
    [DEVICE_CREDENTIAL_STORAGE_KEY]: credential,
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: previousOwner.publicDeviceId,
    [DEVICE_TOKEN_STORAGE_KEY]: 'token-before-field-log-claim',
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: false,
      ownershipEpoch: previousOwner.ownershipEpoch,
      dataNamespace: previousOwner.dataNamespace,
      updatedAtMs: 1,
    },
    pending_run_uploads: pendingRuns,
  });
  const fieldLog = seedRunningLocalFieldLog(s, 'claim01');

  assert.equal(persistDeviceBootstrap(s, {
    publicDeviceId: nextOwner.publicDeviceId,
    aiuiId: 'M7A2R9A4',
    token: 'token-after-field-log-claim',
    bound: true,
    ownershipEpoch: nextOwner.ownershipEpoch,
    dataNamespace: nextOwner.dataNamespace,
    ownershipTransition: anonymousClaimProof(previousOwner, nextOwner),
  }, {
    deviceCredential: credential,
  }), true);

  assert.deepEqual(s.map.get('pending_run_uploads'), pendingRuns,
    '既有 anonymous claim 契约仍可保留普通待传队列');
  assert.equal(s.map.has(RUNNING_LOCAL_FIELD_LOG_KEY), false,
    '现场诊断日志不得换 owner');
  assert.equal(s.map.has(fieldLog.chunkKey), false);
  assert.equal(s.map.get(DEVICE_TOKEN_STORAGE_KEY), 'token-after-field-log-claim');
  assert.equal(s.map.get(DEVICE_BINDING_STORAGE_KEY).ownershipEpoch, 2);
});

test('连续匿名 claim 无法验证删除现场日志时拒绝发布新 token 并保留旧 owner', () => {
  const previousOwner = claimOwner(false, 1, 'anon-field-blocked-1');
  const nextOwner = claimOwner(true, 2, 'user-field-blocked-2');
  const credential = 'dcred_' + 'n'.repeat(40);
  const oldBinding = {
    bound: false,
    ownershipEpoch: previousOwner.ownershipEpoch,
    dataNamespace: previousOwner.dataNamespace,
    updatedAtMs: 1,
  };
  const s = storage({
    [INSTALLATION_ID_STORAGE_KEY]: 'inst_' + 'n'.repeat(28),
    [DEVICE_CREDENTIAL_STORAGE_KEY]: credential,
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: previousOwner.publicDeviceId,
    [DEVICE_TOKEN_STORAGE_KEY]: 'token-before-blocked-field-claim',
    [DEVICE_BINDING_STORAGE_KEY]: oldBinding,
  });
  const fieldLog = seedRunningLocalFieldLog(s, 'claim02');
  const removeStorageSync = s.removeStorageSync.bind(s);
  s.removeStorageSync = (key) => {
    if (key !== fieldLog.chunkKey) removeStorageSync(key);
  };

  assert.equal(persistDeviceBootstrap(s, {
    publicDeviceId: nextOwner.publicDeviceId,
    aiuiId: 'N7A2R9A4',
    token: 'token-must-not-publish',
    bound: true,
    ownershipEpoch: nextOwner.ownershipEpoch,
    dataNamespace: nextOwner.dataNamespace,
    ownershipTransition: anonymousClaimProof(previousOwner, nextOwner),
  }, {
    deviceCredential: credential,
  }), false);

  assert.equal(s.map.get(DEVICE_TOKEN_STORAGE_KEY),
    'token-before-blocked-field-claim');
  assert.deepEqual(s.map.get(DEVICE_BINDING_STORAGE_KEY), oldBinding);
  assert.equal(s.map.has(RUNNING_LOCAL_FIELD_LOG_KEY), true);
  assert.equal(s.map.has(fieldLog.chunkKey), true);
});

test('正常匿名 claim 在新 binding 前 verified rebind workout FIFO/checkpoint，并保留其他匿名队列', async () => {
  const previousOwner = claimOwner(false, 1, 'anon-claim-1');
  const nextOwner = claimOwner(true, 2, 'user-claim-2');
  const credential = 'dcred_' + 'c'.repeat(40);
  const nonWorkoutQueue = [{ client_run_id: 'run-anon-preserved' }];
  const s = storage({
    [INSTALLATION_ID_STORAGE_KEY]: 'inst_' + 'c'.repeat(28),
    [DEVICE_CREDENTIAL_STORAGE_KEY]: credential,
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: previousOwner.publicDeviceId,
    [DEVICE_TOKEN_STORAGE_KEY]: 'token-anon-1',
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: false,
      ownershipEpoch: previousOwner.ownershipEpoch,
      dataNamespace: previousOwner.dataNamespace,
      updatedAtMs: 1,
    },
    pending_run_uploads: nonWorkoutQueue,
  });
  const completion = claimCompletion();
  assert.equal(enqueueWorkoutCompletion(s, completion, previousOwner, {
    allowedStageIds: [CLAIM_STAGE_ID],
  }).length, 1);
  const pendingItem = readPendingWorkoutCompletions(s, previousOwner)[0];
  assert.equal(quarantineWorkoutCompletion(s, pendingItem, 409, {
    nowMs: CLAIM_STARTED_AT + 700_000,
  }), true);
  const execution = createWorkoutExecution(claimPlan(previousOwner), previousOwner, {
    nowMs: CLAIM_STARTED_AT,
    clientExecutionId: 'exec-claim-checkpoint',
  });
  assert.equal(writeWorkoutExecutionCheckpoint(s, execution, previousOwner), true);
  const cacheNow = Date.now();
  const cachedPlan = claimPlan(previousOwner);
  cachedPlan.scheduled_date = new Date(cacheNow).toISOString().slice(0, 10);
  cachedPlan.issued_at_ms = cacheNow - 1000;
  cachedPlan.expires_at_ms = cacheNow + 86_400_000;
  assert.equal(writeCachedWorkout(s, cachedPlan, previousOwner, { nowMs: cacheNow }), true);
  assert.equal(await initializeWorkoutOwnerStorage(s), true);

  assert.equal(persistDeviceBootstrap(s, {
    publicDeviceId: nextOwner.publicDeviceId,
    aiuiId: 'C7L2A9M4',
    token: 'token-bound-2',
    bound: true,
    ownershipEpoch: nextOwner.ownershipEpoch,
    dataNamespace: nextOwner.dataNamespace,
    ownershipTransition: anonymousClaimProof(previousOwner, nextOwner),
  }, {
    deviceCredential: credential,
    workoutStorageReady: true,
  }), true);

  assert.deepEqual(s.map.get('pending_run_uploads'), nonWorkoutQueue);
  assert.equal(readPendingWorkoutCompletions(s, previousOwner).length, 0);
  assert.equal(readPendingWorkoutCompletions(s, nextOwner).length, 1);
  assert.equal(readQuarantinedWorkoutCompletions(s, nextOwner).length, 1);
  const reboundExecution = readWorkoutExecutionCheckpoint(
    s,
    nextOwner,
    normalizeWorkoutExecution,
  );
  assert.equal(reboundExecution.client_execution_id, 'exec-claim-checkpoint');
  assert.deepEqual(reboundExecution.owner, {
    publicDeviceId: nextOwner.publicDeviceId,
    ownershipEpoch: nextOwner.ownershipEpoch,
    dataNamespace: nextOwner.dataNamespace,
  });
  assert.equal(reboundExecution.plan.ownership_epoch, nextOwner.ownershipEpoch);
  assert.equal(reboundExecution.plan.data_namespace, nextOwner.dataNamespace);
  const reboundCachedPlan = readCachedWorkout(s, nextOwner, { nowMs: cacheNow + 1 });
  assert.equal(reboundCachedPlan.workout_id, CLAIM_WORKOUT_ID);
  assert.equal(reboundCachedPlan.ownership_epoch, nextOwner.ownershipEpoch);
  assert.equal(reboundCachedPlan.data_namespace, nextOwner.dataNamespace);
  assert.equal(s.map.get(DEVICE_BINDING_STORAGE_KEY).ownershipEpoch, 2);
  assert.equal(clearWorkoutExecutionCheckpoint(s), true);
});

test('匿名 claim 只有 HeartRatePolicy 时也先物理清旧策略，再提交新 owner', () => {
  const previousOwner = claimOwner(false, 1, 'anon-heart-policy-1');
  const nextOwner = claimOwner(true, 2, 'user-heart-policy-2');
  const credential = 'dcred_' + 'h'.repeat(40);
  const nowMs = 1_800_000_000_000;
  const previousPolicy = {
    schema_version: 1,
    max_hr_bpm: 196,
    source: 'user_explicit',
    issued_at_ms: nowMs - 1000,
    expires_at_ms: nowMs + 60_000,
  };
  const s = storage({
    [INSTALLATION_ID_STORAGE_KEY]: 'inst_' + 'h'.repeat(28),
    [DEVICE_CREDENTIAL_STORAGE_KEY]: credential,
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: previousOwner.publicDeviceId,
    [DEVICE_TOKEN_STORAGE_KEY]: 'token-anon-heart-1',
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: false,
      ownershipEpoch: previousOwner.ownershipEpoch,
      dataNamespace: previousOwner.dataNamespace,
      updatedAtMs: 1,
    },
  });
  assert.equal(writeHeartRatePolicy(s, previousPolicy, previousOwner, { nowMs }), true);
  assert.equal(s.map.size > 0, true);
  assert.equal(s.map.has('pending_workout_completions_v2'), false,
    'fixture 不能靠 workout FIFO 触发 owner transaction');
  assert.equal(s.map.has('pending_run_summary'), false,
    'fixture 不含 summary 私有数据');

  assert.equal(persistDeviceBootstrap(s, {
    publicDeviceId: nextOwner.publicDeviceId,
    aiuiId: 'H7R2P9L4',
    token: 'token-bound-heart-2',
    bound: true,
    ownershipEpoch: nextOwner.ownershipEpoch,
    dataNamespace: nextOwner.dataNamespace,
    ownershipTransition: anonymousClaimProof(previousOwner, nextOwner),
  }, {
    deviceCredential: credential,
    workoutStorageReady: true,
    nowMs,
  }), true);

  assert.equal(s.map.has(HEART_RATE_POLICY_STORAGE_KEY), false,
    '身份发布成功时旧匿名策略已经从物理 storage 删除');
  assert.equal(readHeartRatePolicy(s, nextOwner, { nowMs }), null,
    '新 owner 必须等待 Hermes 重新签发 exact-owner 策略');
  assert.equal(s.map.get(DEVICE_BINDING_STORAGE_KEY).ownershipEpoch, 2);
});

test('HeartRatePolicy-only claim 的身份后段失败会回滚旧 owner 策略，重试后再清除', () => {
  const previousOwner = claimOwner(false, 1, 'anon-heart-rollback-1');
  const nextOwner = claimOwner(true, 2, 'user-heart-rollback-2');
  const credential = 'dcred_' + 'q'.repeat(40);
  const nowMs = 1_800_000_000_000;
  const previousPolicy = {
    schema_version: 1,
    max_hr_bpm: 188,
    source: 'garmin_profile',
    issued_at_ms: nowMs - 1000,
    expires_at_ms: nowMs + 60_000,
  };
  const oldBinding = {
    bound: false,
    ownershipEpoch: previousOwner.ownershipEpoch,
    dataNamespace: previousOwner.dataNamespace,
    updatedAtMs: 1,
  };
  const s = storage({
    [INSTALLATION_ID_STORAGE_KEY]: 'inst_' + 'q'.repeat(28),
    [DEVICE_CREDENTIAL_STORAGE_KEY]: credential,
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: previousOwner.publicDeviceId,
    [DEVICE_TOKEN_STORAGE_KEY]: 'token-before-heart-rollback',
    [DEVICE_BINDING_STORAGE_KEY]: oldBinding,
  });
  assert.equal(writeHeartRatePolicy(s, previousPolicy, previousOwner, { nowMs }), true);

  const originalSet = s.setStorageSync.bind(s);
  let rejectBinding = true;
  s.setStorageSync = (key, value) => {
    if (rejectBinding && key === DEVICE_BINDING_STORAGE_KEY
        && value && value.ownershipEpoch === nextOwner.ownershipEpoch) return;
    originalSet(key, value);
  };
  const nextBootstrap = {
    publicDeviceId: nextOwner.publicDeviceId,
    aiuiId: 'Q7R2P9L4',
    token: 'token-after-heart-rollback',
    bound: true,
    ownershipEpoch: nextOwner.ownershipEpoch,
    dataNamespace: nextOwner.dataNamespace,
    ownershipTransition: anonymousClaimProof(previousOwner, nextOwner),
  };
  assert.equal(persistDeviceBootstrap(s, nextBootstrap, {
    deviceCredential: credential,
    workoutStorageReady: true,
    nowMs,
  }), false);
  assert.deepEqual(readHeartRatePolicy(s, previousOwner, { nowMs }), previousPolicy,
    '新身份未提交时必须恢复旧 owner 的精确策略 preimage');
  assert.deepEqual(s.map.get(DEVICE_BINDING_STORAGE_KEY), oldBinding);

  rejectBinding = false;
  assert.equal(persistDeviceBootstrap(s, nextBootstrap, {
    deviceCredential: credential,
    workoutStorageReady: true,
    nowMs,
  }), true);
  assert.equal(s.map.has(HEART_RATE_POLICY_STORAGE_KEY), false);
  assert.equal(readHeartRatePolicy(s, previousOwner, { nowMs }), null);
  assert.equal(readHeartRatePolicy(s, nextOwner, { nowMs }), null);
});

test('HeartRatePolicy-only claim 无法确认清理时拒绝发布新 token/owner', () => {
  const previousOwner = claimOwner(false, 1, 'anon-heart-unclearable-1');
  const nextOwner = claimOwner(true, 2, 'user-heart-unclearable-2');
  const credential = 'dcred_' + 'u'.repeat(40);
  const nowMs = 1_800_000_000_000;
  const previousPolicy = {
    schema_version: 1,
    max_hr_bpm: 192,
    source: 'user_explicit',
    issued_at_ms: nowMs - 1000,
    expires_at_ms: nowMs + 60_000,
  };
  const oldBinding = {
    bound: false,
    ownershipEpoch: previousOwner.ownershipEpoch,
    dataNamespace: previousOwner.dataNamespace,
    updatedAtMs: 1,
  };
  const s = storage({
    [INSTALLATION_ID_STORAGE_KEY]: 'inst_' + 'u'.repeat(28),
    [DEVICE_CREDENTIAL_STORAGE_KEY]: credential,
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: previousOwner.publicDeviceId,
    [DEVICE_TOKEN_STORAGE_KEY]: 'token-before-unclearable-policy',
    [DEVICE_BINDING_STORAGE_KEY]: oldBinding,
  });
  assert.equal(writeHeartRatePolicy(s, previousPolicy, previousOwner, { nowMs }), true);
  const originalSet = s.setStorageSync.bind(s);
  s.removeStorageSync = (key) => {
    if (key !== HEART_RATE_POLICY_STORAGE_KEY) s.map.delete(key);
  };
  s.setStorageSync = (key, value) => {
    if (key === HEART_RATE_POLICY_STORAGE_KEY && value === '') return;
    originalSet(key, value);
  };

  assert.equal(persistDeviceBootstrap(s, {
    publicDeviceId: nextOwner.publicDeviceId,
    aiuiId: 'U7R2P9L4',
    token: 'token-must-not-publish',
    bound: true,
    ownershipEpoch: nextOwner.ownershipEpoch,
    dataNamespace: nextOwner.dataNamespace,
    ownershipTransition: anonymousClaimProof(previousOwner, nextOwner),
  }, {
    deviceCredential: credential,
    workoutStorageReady: true,
    nowMs,
  }), false);
  assert.deepEqual(readHeartRatePolicy(s, previousOwner, { nowMs }), previousPolicy);
  assert.equal(s.map.get(DEVICE_TOKEN_STORAGE_KEY), 'token-before-unclearable-policy');
  assert.deepEqual(s.map.get(DEVICE_BINDING_STORAGE_KEY), oldBinding);
});

test('解绑与非连续 owner marker 轮换都会物理清除有效 HeartRatePolicy', () => {
  const nowMs = 1_800_000_000_000;
  const cases = [
    {
      name: 'unbind',
      previous: claimOwner(true, 5, 'bound-heart-owner-5'),
      next: claimOwner(false, 6, 'anon-heart-owner-6'),
    },
    {
      name: 'owner-jump',
      previous: claimOwner(true, 7, 'bound-heart-owner-7'),
      next: claimOwner(true, 9, 'other-heart-owner-9'),
    },
  ];
  for (const item of cases) {
    const credential = 'dcred_' + item.name[0].repeat(40);
    const s = storage({
      [INSTALLATION_ID_STORAGE_KEY]: 'inst_' + item.name[0].repeat(28),
      [DEVICE_CREDENTIAL_STORAGE_KEY]: credential,
      [PUBLIC_DEVICE_ID_STORAGE_KEY]: item.previous.publicDeviceId,
      [DEVICE_TOKEN_STORAGE_KEY]: 'token-before-' + item.name,
      [DEVICE_BINDING_STORAGE_KEY]: {
        bound: item.previous.bound,
        ownershipEpoch: item.previous.ownershipEpoch,
        dataNamespace: item.previous.dataNamespace,
        updatedAtMs: 1,
      },
    });
    const previousPolicy = {
      schema_version: 1,
      max_hr_bpm: 190,
      source: 'user_explicit',
      issued_at_ms: nowMs - 1000,
      expires_at_ms: nowMs + 60_000,
    };
    assert.equal(writeHeartRatePolicy(s, previousPolicy, item.previous, { nowMs }), true);
    let cleared = 0;
    assert.equal(persistDeviceBootstrap(s, {
      publicDeviceId: item.next.publicDeviceId,
      aiuiId: item.name === 'unbind' ? 'U7N2B9D4' : 'J7U2M9P4',
      token: 'token-after-' + item.name,
      bound: item.next.bound,
      ownershipEpoch: item.next.ownershipEpoch,
      dataNamespace: item.next.dataNamespace,
    }, {
      deviceCredential: credential,
      nowMs,
      onOwnerDataCleared() { cleared += 1; },
    }), true, item.name);
    assert.equal(cleared, 1, item.name);
    assert.equal(s.map.has(HEART_RATE_POLICY_STORAGE_KEY), false, item.name);
    assert.equal(readHeartRatePolicy(s, item.next, { nowMs }), null, item.name);
  }
});

test('匿名 claim 的 workout 证据不可验证时保留原始证据并阻止新 token，其他匿名队列保留', async () => {
  const previousOwner = claimOwner(false, 1, 'anon-claim-bad-1');
  const nextOwner = claimOwner(true, 2, 'user-claim-bad-2');
  const credential = 'dcred_' + 'f'.repeat(40);
  const nonWorkoutQueue = [{ client_run_id: 'run-anon-must-survive' }];
  const s = storage({
    [INSTALLATION_ID_STORAGE_KEY]: 'inst_' + 'f'.repeat(28),
    [DEVICE_CREDENTIAL_STORAGE_KEY]: credential,
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: previousOwner.publicDeviceId,
    [DEVICE_TOKEN_STORAGE_KEY]: 'token-anon-before-failure',
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: false,
      ownershipEpoch: previousOwner.ownershipEpoch,
      dataNamespace: previousOwner.dataNamespace,
      updatedAtMs: 1,
    },
    pending_run_uploads: nonWorkoutQueue,
  });
  const completion = claimCompletion();
  assert.equal(enqueueWorkoutCompletion(s, completion, previousOwner, {
    allowedStageIds: [CLAIM_STAGE_ID],
  }).length, 1);
  const execution = createWorkoutExecution(claimPlan(previousOwner), previousOwner, {
    nowMs: CLAIM_STARTED_AT,
    clientExecutionId: 'exec-claim-corrupt-checkpoint',
  });
  assert.equal(writeWorkoutExecutionCheckpoint(s, execution, previousOwner), true);
  assert.equal(await initializeWorkoutOwnerStorage(s), true);
  s.map.set(WORKOUT_EXECUTION_STATE_KEY, { malformed: true });

  assert.equal(persistDeviceBootstrap(s, {
    publicDeviceId: nextOwner.publicDeviceId,
    aiuiId: 'F7A2I9L4',
    token: 'token-must-not-commit',
    bound: true,
    ownershipEpoch: nextOwner.ownershipEpoch,
    dataNamespace: nextOwner.dataNamespace,
    ownershipTransition: anonymousClaimProof(previousOwner, nextOwner),
  }, {
    deviceCredential: credential,
    workoutStorageReady: true,
  }), false);

  assert.equal(s.map.get(DEVICE_TOKEN_STORAGE_KEY), 'token-anon-before-failure');
  assert.equal(s.map.get(DEVICE_BINDING_STORAGE_KEY).ownershipEpoch, 1);
  assert.deepEqual(s.map.get('pending_run_uploads'), nonWorkoutQueue);
  assert.equal(readPendingWorkoutCompletions(s, previousOwner).length, 1);
  assert.equal(readPendingWorkoutCompletions(s, nextOwner).length, 0);
  assert.deepEqual(s.map.get(WORKOUT_EXECUTION_STATE_KEY), { malformed: true },
    '失败事务必须恢复调用前的原始损坏证据，不能清空后假装首次运行');
  assert.throws(() => readWorkoutExecutionCheckpoint(
    s, previousOwner, normalizeWorkoutExecution,
  ), /storage read failed/);
});

test('匿名 claim 中途写失败会回滚完整 workout preimage，随后可原样重试', async () => {
  const previousOwner = claimOwner(false, 1, 'anon-claim-rollback-1');
  const nextOwner = claimOwner(true, 2, 'user-claim-rollback-2');
  const credential = 'dcred_' + 'r'.repeat(40);
  const s = storage({
    [INSTALLATION_ID_STORAGE_KEY]: 'inst_' + 'r'.repeat(28),
    [DEVICE_CREDENTIAL_STORAGE_KEY]: credential,
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: previousOwner.publicDeviceId,
    [DEVICE_TOKEN_STORAGE_KEY]: 'token-before-rollback',
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: false,
      ownershipEpoch: previousOwner.ownershipEpoch,
      dataNamespace: previousOwner.dataNamespace,
      updatedAtMs: 1,
    },
  });
  assert.equal(enqueueWorkoutCompletion(s, claimCompletion(), previousOwner, {
    allowedStageIds: [CLAIM_STAGE_ID],
  }).length, 1);
  const execution = createWorkoutExecution(claimPlan(previousOwner), previousOwner, {
    nowMs: CLAIM_STARTED_AT,
    clientExecutionId: 'exec-claim-rollback-checkpoint',
  });
  assert.equal(writeWorkoutExecutionCheckpoint(s, execution, previousOwner), true);
  assert.equal(await initializeWorkoutOwnerStorage(s), true);

  const setStorageSync = s.setStorageSync.bind(s);
  let failedExecutionWrite = false;
  s.setStorageSync = (key, value) => {
    if (key === WORKOUT_EXECUTION_CACHE_KEY && !failedExecutionWrite) {
      failedExecutionWrite = true;
      return;
    }
    setStorageSync(key, value);
  };
  const parsed = {
    publicDeviceId: nextOwner.publicDeviceId,
    aiuiId: 'R7B2K9M4',
    token: 'token-after-rollback',
    bound: true,
    ownershipEpoch: nextOwner.ownershipEpoch,
    dataNamespace: nextOwner.dataNamespace,
    ownershipTransition: anonymousClaimProof(previousOwner, nextOwner),
  };
  assert.equal(persistDeviceBootstrap(s, parsed, {
    deviceCredential: credential,
    workoutStorageReady: true,
  }), false);
  assert.equal(failedExecutionWrite, true);
  assert.equal(readPendingWorkoutCompletions(s, previousOwner).length, 1);
  assert.equal(readPendingWorkoutCompletions(s, nextOwner).length, 0);
  assert.equal(readWorkoutExecutionCheckpoint(
    s, previousOwner, normalizeWorkoutExecution,
  ).client_execution_id, 'exec-claim-rollback-checkpoint');
  assert.equal(s.map.get(DEVICE_BINDING_STORAGE_KEY).ownershipEpoch, 1);
  assert.equal(s.map.get(DEVICE_TOKEN_STORAGE_KEY), 'token-before-rollback');

  assert.equal(persistDeviceBootstrap(s, parsed, {
    deviceCredential: credential,
    workoutStorageReady: true,
  }), true);
  assert.equal(readPendingWorkoutCompletions(s, nextOwner).length, 1);
  assert.equal(readWorkoutExecutionCheckpoint(
    s, nextOwner, normalizeWorkoutExecution,
  ).client_execution_id, 'exec-claim-rollback-checkpoint');
});

test('匿名 claim 身份后段失败会同时恢复旧 token/binding，重试不误清训练证据', async () => {
  const previousOwner = claimOwner(false, 1, 'anon-claim-identity-rollback-1');
  const nextOwner = claimOwner(true, 2, 'user-claim-identity-rollback-2');
  const credential = 'dcred_' + 'i'.repeat(40);
  const oldAlias = {
    aiuiId: 'A7B2C9D4',
    publicDeviceId: previousOwner.publicDeviceId,
    ownershipEpoch: previousOwner.ownershipEpoch,
    dataNamespace: previousOwner.dataNamespace,
  };
  const oldBinding = {
    bound: false,
    ownershipEpoch: previousOwner.ownershipEpoch,
    dataNamespace: previousOwner.dataNamespace,
    updatedAtMs: 1,
  };
  const s = storage({
    [INSTALLATION_ID_STORAGE_KEY]: 'inst_' + 'i'.repeat(28),
    [DEVICE_CREDENTIAL_STORAGE_KEY]: credential,
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: previousOwner.publicDeviceId,
    [AIUI_ID_STORAGE_KEY]: oldAlias,
    [DEVICE_TOKEN_STORAGE_KEY]: 'token-before-identity-failure',
    [DEVICE_BINDING_STORAGE_KEY]: oldBinding,
    coach_token: 'token-before-identity-failure',
  });
  assert.equal(enqueueWorkoutCompletion(s, claimCompletion(), previousOwner, {
    allowedStageIds: [CLAIM_STAGE_ID],
  }).length, 1);
  assert.equal(await initializeWorkoutOwnerStorage(s), true);

  const setStorageSync = s.setStorageSync.bind(s);
  let rejectedNextBinding = false;
  s.setStorageSync = (key, value) => {
    if (key === DEVICE_BINDING_STORAGE_KEY
        && value && value.ownershipEpoch === nextOwner.ownershipEpoch
        && !rejectedNextBinding) {
      rejectedNextBinding = true;
      return;
    }
    setStorageSync(key, value);
  };
  const parsed = {
    publicDeviceId: nextOwner.publicDeviceId,
    aiuiId: 'E7F2G9H4',
    token: 'token-after-identity-failure',
    bound: true,
    ownershipEpoch: nextOwner.ownershipEpoch,
    dataNamespace: nextOwner.dataNamespace,
    ownershipTransition: anonymousClaimProof(previousOwner, nextOwner),
  };
  assert.equal(persistDeviceBootstrap(s, parsed, {
    deviceCredential: credential,
    coachTokenStorageKey: 'coach_token',
    workoutStorageReady: true,
  }), false);
  assert.equal(rejectedNextBinding, true);
  assert.equal(s.map.get(DEVICE_TOKEN_STORAGE_KEY), 'token-before-identity-failure');
  assert.equal(s.map.get('coach_token'), 'token-before-identity-failure');
  assert.deepEqual(s.map.get(DEVICE_BINDING_STORAGE_KEY), oldBinding);
  assert.deepEqual(s.map.get(AIUI_ID_STORAGE_KEY), oldAlias);
  assert.equal(readPendingWorkoutCompletions(s, previousOwner).length, 1);
  assert.equal(readPendingWorkoutCompletions(s, nextOwner).length, 0);

  assert.equal(persistDeviceBootstrap(s, parsed, {
    deviceCredential: credential,
    coachTokenStorageKey: 'coach_token',
    workoutStorageReady: true,
  }), true);
  assert.equal(s.map.get(DEVICE_TOKEN_STORAGE_KEY), parsed.token);
  assert.equal(s.map.get(DEVICE_BINDING_STORAGE_KEY).ownershipEpoch, 2);
  assert.equal(readPendingWorkoutCompletions(s, previousOwner).length, 0);
  assert.equal(readPendingWorkoutCompletions(s, nextOwner).length, 1);
});

test('旧 JWT/legacy ID 属于所有者：正常首次绑定可续接，解绑或跳 epoch 必须销毁证明', () => {
  const oldToken = jwt({ sub: '55', kind: 'user' });
  const s = storage({
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: 'SR-55',
    [DEVICE_SECRET_STORAGE_KEY]: 'r'.repeat(48),
    [LEGACY_DEVICE_ID_STORAGE_KEY]: 'legacy-owner-55',
    [LEGACY_COACH_TOKEN_STORAGE_KEY]: oldToken,
    [LEGACY_MIGRATION_STATE_STORAGE_KEY]: {
      complete: true, legacyDeviceId: 'legacy-owner-55',
    },
    coach_token: oldToken,
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: false, ownershipEpoch: 1, dataNamespace: 'anon-owner-55', updatedAtMs: 1,
    },
  });
  assert.equal(persistDeviceBootstrap(s, {
    publicDeviceId: 'SR-55', token: 'bound-token', bound: true,
    ownershipEpoch: 2, dataNamespace: 'user-owner-55',
    ownershipTransition: {
      kind: 'anonymous_claim',
      previousOwnershipEpoch: 1,
      previousDataNamespace: 'anon-owner-55',
      currentOwnershipEpoch: 2,
      currentDataNamespace: 'user-owner-55',
    },
  }), true);
  assert.equal(s.map.get(LEGACY_DEVICE_ID_STORAGE_KEY), 'legacy-owner-55',
    '正常匿名 claim 允许同用户 migration proof 连续');

  assert.equal(persistDeviceBootstrap(s, {
    publicDeviceId: 'SR-55', token: 'fresh-anon-token', bound: false,
    ownershipEpoch: 3, dataNamespace: 'anon-next-owner',
  }), true);
  assert.equal(s.map.has(LEGACY_DEVICE_ID_STORAGE_KEY), false);
  assert.equal(s.map.has(LEGACY_COACH_TOKEN_STORAGE_KEY), false);
  assert.equal(s.map.has(LEGACY_MIGRATION_STATE_STORAGE_KEY), false);
  assert.equal(s.map.has('coach_token'), false, '旧 user bearer 不可穿越解绑边界');
});

test('所有权判定与显式清理 helper 保持设备身份', () => {
  assert.equal(shouldClearOwnerScopedState(
    { bound: false, ownershipEpoch: 1, dataNamespace: 'anon-a', publicDeviceId: 'SR-A' },
    { bound: true, ownershipEpoch: 2, dataNamespace: 'user-a', publicDeviceId: 'SR-A' },
    {
      kind: 'anonymous_claim',
      previousOwnershipEpoch: 1,
      previousDataNamespace: 'anon-a',
      currentOwnershipEpoch: 2,
      currentDataNamespace: 'user-a',
    },
  ), false, '只有服务器精确证明的首次绑定才允许历史连续');
  assert.equal(shouldClearOwnerScopedState(
    { bound: false, ownershipEpoch: 1, dataNamespace: 'anon-a', publicDeviceId: 'SR-A' },
    { bound: true, ownershipEpoch: 2, dataNamespace: 'user-a', publicDeviceId: 'SR-A' },
  ), true, '缺少服务器 ownership_transition 时必须隔离');
  assert.equal(shouldClearOwnerScopedState(
    { bound: false, ownershipEpoch: 1, dataNamespace: 'anon-a', publicDeviceId: 'SR-A' },
    { bound: true, ownershipEpoch: 2, dataNamespace: 'user-a', publicDeviceId: 'SR-B' },
  ), true, '即使首次绑定恰好 +1，public_device_id 改变也必须隔离匿名历史');
  assert.equal(shouldClearOwnerScopedState(
    { bound: true, ownershipEpoch: 2, dataNamespace: 'user-a' },
    { bound: false, ownershipEpoch: 3, dataNamespace: 'anon-b' },
  ), true);
  assert.equal(shouldClearOwnerScopedState(
    { bound: false, ownershipEpoch: 1, dataNamespace: 'anon-a' },
    { bound: false, ownershipEpoch: 3, dataNamespace: 'anon-b' },
  ), true, 'AIX 未轮询到快速 bind→unbind 时，两端仍为 unbound 也必须清');
  assert.equal(shouldClearOwnerScopedState(
    { bound: false, ownershipEpoch: 1, dataNamespace: 'anon-a' },
    { bound: true, ownershipEpoch: 4, dataNamespace: 'user-b' },
  ), true, '首次观测到 bound 但 epoch 跳跃，说明中间发生过换绑');
  assert.equal(shouldClearOwnerScopedState(
    { bound: true, ownershipEpoch: 8, dataNamespace: 'user-a' },
    { bound: true, ownershipEpoch: 8, dataNamespace: 'user-b' },
  ), true, '即使异常后端 epoch 未变，namespace 变化仍隔离');
  assert.equal(shouldClearOwnerScopedState(
    { bound: false, ownershipEpoch: null, dataNamespace: '' },
    { bound: false, ownershipEpoch: 1, dataNamespace: 'anon-new' },
  ), true, '已有旧 binding 缺 marker 时无论 bound 与否都保守隔离');
  const s = storage({ pending_run_summary: { text: 'old' }, keep: 1 });
  clearOwnerScopedState(s);
  assert.equal(s.map.has('pending_run_summary'), false);
  assert.equal(s.map.get('keep'), 1);
});

test('绑定状态查询只携带 device bearer，并复用完整 bootstrap 身份解析', () => {
  const status = buildDevicePairStatusRequest({ baseUrl: 'https://x.test', token: 'dev-jwt' });
  assert.equal(status.url, 'https://x.test' + DEVICE_PAIR_STATUS_PATH);
  assert.equal(status.header.Authorization, 'Bearer dev-jwt');
  assert.deepEqual(status.data, {});
  assert.deepEqual(parseDevicePairStatusResponse({ statusCode: 200, data: {
    public_device_id: 'SR-1', aiui_id: 'A7K2M9Q4', token: 'dev-jwt-2', bound: false,
    ownership_epoch: 4, data_namespace: 'anon-4',
  } }), {
    publicDeviceId: 'SR-1', aiuiId: 'A7K2M9Q4', token: 'dev-jwt-2', deviceSecret: '',
    bound: false, agentInstanceId: '', agentAlias: '', ownershipEpoch: 4,
    dataNamespace: 'anon-4', legacyMigrationComplete: false,
  });
});

test('清理认证不清内部公开 ID 或用户可见 AIUI ID', () => {
  const s = storage({
    [PUBLIC_DEVICE_ID_STORAGE_KEY]: 'SR-PUBLIC-1234567890-ABCDEFG',
    [AIUI_ID_STORAGE_KEY]: {
      aiuiId: 'A7K2M9Q4', publicDeviceId: 'SR-PUBLIC-1234567890-ABCDEFG',
    },
    [DEVICE_TOKEN_STORAGE_KEY]: 'dev-token',
    [DEVICE_SECRET_STORAGE_KEY]: 's'.repeat(48),
    [DEVICE_BINDING_STORAGE_KEY]: {
      bound: false, ownershipEpoch: 1, dataNamespace: 'anon-local', updatedAtMs: 1,
    },
    coach_token: 'coach-token',
  });
  clearDeviceAuth(s, { coachTokenStorageKey: 'coach_token' });
  assert.equal(s.map.has(DEVICE_TOKEN_STORAGE_KEY), false);
  assert.equal(s.map.has('coach_token'), false);
  assert.equal(s.map.get(PUBLIC_DEVICE_ID_STORAGE_KEY), 'SR-PUBLIC-1234567890-ABCDEFG');
  assert.equal(ensureLocalDeviceIdentity(s).aiuiId, 'A7K2M9Q4');
  assert.equal(s.map.get(DEVICE_SECRET_STORAGE_KEY), 's'.repeat(48));
  assert.equal(formatPublicDeviceId(ensureLocalDeviceIdentity(s)), 'SR-PUBLIC-…-ABCDEFG');
  assert.equal(formatAiuiId(ensureLocalDeviceIdentity(s)), 'A7K2 M9Q4');
});
