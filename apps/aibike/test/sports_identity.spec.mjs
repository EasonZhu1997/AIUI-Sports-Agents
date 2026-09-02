import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPORTS_APP_ID,
  SPORTS_CREDENTIAL_KEY,
  SPORTS_IDENTITY_KEY,
  buildSportsCredentialRequest,
  ensureSportsIdentity,
  readSportsCredential,
  readSportsIdentity,
  isSportsAnonymousClaimTransition,
} from '../lib/sports_identity.js';

function storage() {
  const values = new Map();
  return {
    values,
    getStorageSync(key) { return values.get(key); },
    setStorageSync(key, value) { values.set(key, JSON.parse(JSON.stringify(value))); },
    removeStorageSync(key) { values.delete(key); },
  };
}

const credential = {
  installation_id: 'inst_aibike_00000001',
  device_credential: 'c'.repeat(64),
};
const bootstrap = {
  token: 't'.repeat(64),
  public_device_id: 'bike_public_001',
  ownership_epoch: 2,
  data_namespace: 'bike_owner_namespace_002',
};

test('AIBike sports identity uses aibike realm and isolated storage keys', () => {
  const request = buildSportsCredentialRequest();
  assert.equal(SPORTS_APP_ID, 'aibike');
  assert.equal(request.data.app_id, 'aibike');
  assert.match(SPORTS_CREDENTIAL_KEY, /sports/);
  assert.match(SPORTS_IDENTITY_KEY, /sports/);
  assert.doesNotMatch(SPORTS_CREDENTIAL_KEY + SPORTS_IDENTITY_KEY, /cycling_upload/);
});

test('old aismartrun upload keys are never accepted as sports identity', async () => {
  const local = storage();
  local.setStorageSync('aibike_cycling_upload_credential_v1', credential);
  local.setStorageSync('aibike_cycling_upload_token_v1', 'old'.repeat(32));
  const requests = [];
  const result = await ensureSportsIdentity({
    storage: local,
    async request(options) {
      requests.push(options);
      return requests.length === 1
        ? { statusCode: 200, data: credential }
        : { statusCode: 200, data: bootstrap };
    },
  });
  assert.equal(result.ready, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].data.app_id, 'aibike');
  assert.equal(requests[1].data.app_id, 'aibike');
  assert.deepEqual(readSportsCredential(local), credential);
  assert.deepEqual(readSportsIdentity(local), { app_id: 'aibike', ...bootstrap });
});

test('bootstrap without complete owner marker fails closed and is not cached', async () => {
  const local = storage();
  local.setStorageSync(SPORTS_CREDENTIAL_KEY, credential);
  const result = await ensureSportsIdentity({
    storage: local,
    async request() { return { statusCode: 200, data: { token: 't'.repeat(64) } }; },
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'bootstrap');
  assert.equal(readSportsIdentity(local), null);
});

test('bootstrap only accepts a server-shaped adjacent anonymous claim proof', async () => {
  const local = storage();
  local.setStorageSync(SPORTS_CREDENTIAL_KEY, credential);
  const previous = {
    token: 'o'.repeat(64), public_device_id: 'bike_public_001', ownership_epoch: 1,
    data_namespace: 'ns_' + 'a'.repeat(24),
  };
  local.setStorageSync(SPORTS_IDENTITY_KEY, previous);
  const current = {
    token: 'n'.repeat(64), public_device_id: 'bike_public_001', ownership_epoch: 2,
    data_namespace: 'ns_' + 'b'.repeat(24),
    ownership_transition: {
      kind: 'anonymous_claim', previous_ownership_epoch: 1,
      previous_data_namespace: 'ns_' + 'a'.repeat(24),
      current_ownership_epoch: 2,
      current_data_namespace: 'ns_' + 'b'.repeat(24),
    },
  };
  const result = await ensureSportsIdentity({
    storage: local, forceRefresh: true,
    async request() { return { statusCode: 200, data: current }; },
  });
  assert.equal(result.ready, true);
  assert.equal(isSportsAnonymousClaimTransition(previous, result), true);
  assert.equal(readSportsIdentity(local).ownership_transition, undefined);
});
