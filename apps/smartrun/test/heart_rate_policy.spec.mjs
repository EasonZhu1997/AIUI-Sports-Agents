import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearHeartRatePolicyStorage,
  HEART_RATE_POLICY_STORAGE_KEY,
  heartRatePolicyConfidence,
  heartRateZoneFromPolicy,
  isConservativeHighHeartRate,
  normalizeHeartRatePolicy,
  readHeartRatePolicy,
  writeHeartRatePolicy,
} from '../lib/heart_rate_policy.js';
import {
  beginWorkoutOwnerStorageRebind,
  initializeWorkoutOwnerStorage,
} from '../lib/workout_owner_storage.js';

const NOW = 1_800_000_000_000;
const OWNER = {
  publicDeviceId: 'SR-HR-POLICY-1',
  ownershipEpoch: 7,
  dataNamespace: 'owner:7:heart-rate-policy',
};

function policy(source = 'user_explicit', overrides = {}) {
  return {
    schema_version: 1,
    max_hr_bpm: 200,
    source,
    issued_at_ms: NOW - 1000,
    expires_at_ms: NOW + 60_000,
    ...overrides,
  };
}

function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getStorageSync(key) { return values.get(key); },
    getStorage({ key, success, fail, complete }) {
      if (values.has(key)) success?.({ data: values.get(key) });
      else fail?.({ errMsg: 'Key not found' });
      complete?.();
    },
    setStorageSync(key, value) {
      values.set(key, JSON.parse(JSON.stringify(value)));
    },
    removeStorageSync(key) { values.delete(key); },
  };
}

test('策略白名单严格校验版本、字段、最大心率、来源与有效期', () => {
  assert.deepEqual(normalizeHeartRatePolicy(policy(), { nowMs: NOW }), policy());
  assert.equal(normalizeHeartRatePolicy(policy('user_explicit', {
    maximum_hr: 999,
    trusted: true,
  }), { nowMs: NOW }), null,
  'schema v1 未知字段必须 fail closed，与 Hermes/Android exact-key 合同一致');
  assert.equal(normalizeHeartRatePolicy(policy('unknown'), { nowMs: NOW }), null);
  assert.equal(normalizeHeartRatePolicy(policy('age_estimate', { max_hr_bpm: 119 }), {
    nowMs: NOW,
  }), null);
  assert.equal(normalizeHeartRatePolicy(policy('age_estimate', { max_hr_bpm: 231 }), {
    nowMs: NOW,
  }), null);
  assert.equal(normalizeHeartRatePolicy(policy('age_estimate', { expires_at_ms: NOW }), {
    nowMs: NOW,
  }), null);
  assert.equal(normalizeHeartRatePolicy(policy('age_estimate', {
    issued_at_ms: NOW + 60_001,
    expires_at_ms: NOW + 120_000,
  }), { nowMs: NOW }), null, '签发时间最多允许 60 秒时钟偏差');
  assert.equal(normalizeHeartRatePolicy(policy('age_estimate', {
    issued_at_ms: NOW - 1000,
    expires_at_ms: NOW - 1000 + 7 * 24 * 60 * 60 * 1000 + 1,
  }), { nowMs: NOW }), null, '策略 TTL 不得超过七天');
  const boundary = policy('age_estimate', {
    issued_at_ms: NOW + 60_000,
    expires_at_ms: NOW + 60_000 + 7 * 24 * 60 * 60 * 1000,
  });
  assert.deepEqual(normalizeHeartRatePolicy(boundary, { nowMs: NOW }), boundary,
    '60 秒时钟偏差与七天 TTL 边界仍可接受');
});

test('前三种来源按完整 owner marker 写后读回，default 永不持久化', () => {
  for (const source of ['user_explicit', 'garmin_profile', 'age_estimate']) {
    const s = storage();
    assert.equal(writeHeartRatePolicy(s, policy(source), OWNER, { nowMs: NOW }), true);
    assert.deepEqual(readHeartRatePolicy(s, OWNER, { nowMs: NOW }), policy(source));
  }
  const s = storage();
  assert.equal(writeHeartRatePolicy(
    s,
    policy('conservative_default'),
    OWNER,
    { nowMs: NOW },
  ), false);
  assert.equal(s.values.has(HEART_RATE_POLICY_STORAGE_KEY), false);
});

test('跨 owner、损坏、过期记录 fail closed 并清理', () => {
  const cases = [
    {
      stored: null,
      readOwner: { ...OWNER, ownershipEpoch: OWNER.ownershipEpoch + 1 },
      nowMs: NOW,
    },
    { stored: { schema_version: 1, owner: {}, policy: {} }, readOwner: OWNER, nowMs: NOW },
    { stored: null, readOwner: OWNER, nowMs: NOW + 60_001 },
  ];
  for (const item of cases) {
    const s = storage();
    assert.equal(writeHeartRatePolicy(s, policy(), OWNER, { nowMs: NOW }), true);
    if (item.stored) s.values.set(HEART_RATE_POLICY_STORAGE_KEY, item.stored);
    assert.equal(readHeartRatePolicy(s, item.readOwner, { nowMs: item.nowMs }), null);
    assert.equal(s.values.has(HEART_RATE_POLICY_STORAGE_KEY), false);
  }
});

test('策略来源区分可信、估算与缺失；有效估算可点亮中性区间', () => {
  assert.equal(heartRatePolicyConfidence(policy('user_explicit')), 'trusted');
  assert.equal(heartRatePolicyConfidence(policy('garmin_profile')), 'trusted');
  assert.equal(heartRatePolicyConfidence(policy('age_estimate')), 'estimated');
  assert.equal(heartRatePolicyConfidence(policy('conservative_default')), 'estimated');
  assert.equal(heartRatePolicyConfidence(null), 'missing');
  assert.equal(heartRateZoneFromPolicy(160, policy('user_explicit')), 4);
  assert.equal(heartRateZoneFromPolicy(160, policy('garmin_profile')), 4);
  assert.equal(heartRateZoneFromPolicy(160, policy('age_estimate')), 4);
  assert.equal(heartRateZoneFromPolicy(160, policy('conservative_default')), 4);
  assert.equal(heartRateZoneFromPolicy(160, null), 0);
});

test('估算与缺失策略只保留更保守的偏高降速门', () => {
  assert.equal(isConservativeHighHeartRate(179, policy('user_explicit')), false);
  assert.equal(isConservativeHighHeartRate(180, policy('user_explicit')), true);
  assert.equal(isConservativeHighHeartRate(169, policy('age_estimate')), false);
  assert.equal(isConservativeHighHeartRate(170, policy('age_estimate')), true);
  assert.equal(isConservativeHighHeartRate(169, null), false);
  assert.equal(isConservativeHighHeartRate(170, null), true);
});

test('清理必须读回确认，remove 静默 no-op 时写空值自愈', () => {
  const s = storage({ [HEART_RATE_POLICY_STORAGE_KEY]: { stale: true } });
  s.removeStorageSync = () => {};
  assert.equal(clearHeartRatePolicyStorage(s), true);
  assert.equal(s.values.get(HEART_RATE_POLICY_STORAGE_KEY), '');
});

test('替换旧 trusted 策略时 silent no-op 写入必须清旧值而不是下次复活', () => {
  const s = storage();
  assert.equal(writeHeartRatePolicy(s, policy('user_explicit'), OWNER, {
    nowMs: NOW,
  }), true);
  const originalSet = s.setStorageSync.bind(s);
  s.setStorageSync = (key, value) => {
    if (key === HEART_RATE_POLICY_STORAGE_KEY) return;
    originalSet(key, value);
  };
  assert.equal(writeHeartRatePolicy(s, policy('garmin_profile', {
    max_hr_bpm: 185,
  }), OWNER, { nowMs: NOW }), false);
  assert.equal(s.values.has(HEART_RATE_POLICY_STORAGE_KEY), false,
    '写后读回不一致时必须 best-effort 清除仍有效的旧 trusted 策略');
});

test('owner marker 迁移会清策略，身份提交失败时可精确回滚旧 owner 策略', async () => {
  const s = storage();
  const nextOwner = {
    publicDeviceId: OWNER.publicDeviceId,
    ownershipEpoch: OWNER.ownershipEpoch + 1,
    dataNamespace: 'owner:8:heart-rate-policy',
  };
  assert.equal(await initializeWorkoutOwnerStorage(s), true);
  assert.equal(writeHeartRatePolicy(s, policy(), OWNER, { nowMs: NOW }), true);

  let transaction = beginWorkoutOwnerStorageRebind(s, OWNER, nextOwner);
  assert.equal(transaction.ok, true);
  assert.equal(s.values.has(HEART_RATE_POLICY_STORAGE_KEY), false,
    '新 owner 身份发布前，旧策略已从 active storage 清除');
  assert.equal(transaction.rollback(), true);
  assert.deepEqual(readHeartRatePolicy(s, OWNER, { nowMs: NOW }), policy(),
    '后续身份写入失败必须恢复旧 owner 的精确策略 preimage');

  transaction = beginWorkoutOwnerStorageRebind(s, OWNER, nextOwner);
  assert.equal(transaction.ok, true);
  assert.equal(transaction.commit(), true);
  assert.equal(readHeartRatePolicy(s, nextOwner, { nowMs: NOW }), null,
    '成功换 owner 后必须等待 Hermes 为新 owner 重发策略');
});
