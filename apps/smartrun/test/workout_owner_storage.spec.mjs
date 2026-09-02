import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeWorkoutOwnerStorage,
  rebindWorkoutOwnerStorage,
} from '../lib/workout_owner_storage.js';

const LEGACY_AGENT_KEYS = [
  'pending_sport_agent_runs_v1',
  'pending_sport_agent_runs_state_v1',
];

function storage(seed = {}) {
  const map = new Map(Object.entries(seed));
  let rejectLegacyRemoval = false;
  return {
    map,
    rejectLegacyRemoval(value = true) { rejectLegacyRemoval = value; },
    getStorage({ key, success, fail }) {
      if (map.has(key)) success({ data: map.get(key) });
      else fail({ errMsg: 'Key not found' });
    },
    getStorageSync(key) { return map.get(key); },
    setStorageSync(key, value) { map.set(key, value); },
    removeStorageSync(key) {
      if (rejectLegacyRemoval && LEGACY_AGENT_KEYS.includes(key)) {
        throw new Error('legacy cleanup blocked');
      }
      map.delete(key);
    },
  };
}

test('owner storage 初始化会 best-effort 清掉旧 Sport Agent 队列', async () => {
  const s = storage({
    [LEGACY_AGENT_KEYS[0]]: [{ stale: true }],
    [LEGACY_AGENT_KEYS[1]]: { stale: true },
  });
  assert.equal(await initializeWorkoutOwnerStorage(s), true);
  assert.equal(s.map.has(LEGACY_AGENT_KEYS[0]), false);
  assert.equal(s.map.has(LEGACY_AGENT_KEYS[1]), false);
});

test('旧 Sport Agent key 清理失败不阻断 owner 初始化与重绑', async () => {
  const s = storage();
  assert.equal(await initializeWorkoutOwnerStorage(s), true);
  s.map.set(LEGACY_AGENT_KEYS[0], [{ stale: true }]);
  s.map.set(LEGACY_AGENT_KEYS[1], { stale: true });
  s.rejectLegacyRemoval(true);

  assert.equal(await initializeWorkoutOwnerStorage(s), true);
  assert.equal(rebindWorkoutOwnerStorage(s, {
    publicDeviceId: 'SR-LEGACY-CLEANUP',
    ownershipEpoch: 1,
    dataNamespace: 'anon:legacy-cleanup:1',
    bound: false,
  }, {
    publicDeviceId: 'SR-LEGACY-CLEANUP',
    ownershipEpoch: 2,
    dataNamespace: 'user:legacy-cleanup:2',
    bound: true,
  }), true);
  assert.equal(s.map.has(LEGACY_AGENT_KEYS[0]), true,
    '清理失败时保留旧 key，等待后续启动重试');
  assert.equal(s.map.has(LEGACY_AGENT_KEYS[1]), true);
});
