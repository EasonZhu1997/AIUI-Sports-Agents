import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CYCLING_UPLOAD_BOOTSTRAP_PATH,
  CYCLING_UPLOAD_CREDENTIAL_KEY,
  CYCLING_UPLOAD_CREDENTIAL_PATH,
  CYCLING_UPLOAD_TOKEN_KEY,
  buildCyclingUploadBootstrapRequest,
  buildCyclingUploadCredentialRequest,
  clearCyclingUploadToken,
  ensureCyclingUploadToken,
  parseCyclingUploadBootstrapResponse,
  parseCyclingUploadCredentialResponse,
  readCyclingUploadCredential,
  readCyclingUploadToken,
} from '../lib/cycling_upload_auth.js';

function storage() {
  const values = new Map();
  return {
    values,
    getStorageSync(key) {
      return values.has(key)
        ? JSON.parse(JSON.stringify(values.get(key))) : undefined;
    },
    setStorageSync(key, value) {
      values.set(key, JSON.parse(JSON.stringify(value)));
    },
    removeStorageSync(key) {
      values.delete(key);
    },
  };
}

const credential = {
  installation_id: 'inst_aibike_00000001',
  device_credential: 'c'.repeat(64),
};

const identity = {
  token: 't'.repeat(64),
  public_device_id: 'aibike-device-0001',
  ownership_epoch: 1,
  data_namespace: 'aibike.owner.0001',
};

test('安装凭据请求默认保持相对路径，显式 HTTPS 配置后才绑定来源', () => {
  const request = buildCyclingUploadCredentialRequest();
  assert.equal(request.url, CYCLING_UPLOAD_CREDENTIAL_PATH);
  const configured = buildCyclingUploadCredentialRequest({
    baseUrl: 'https://hermes.test/base/',
  });
  assert.equal(configured.url, `https://hermes.test/base${CYCLING_UPLOAD_CREDENTIAL_PATH}`);
  assert.equal(request.method, 'POST');
  assert.equal(request.data.app_id, 'aibike');
  assert.equal(request.responseType, 'text');
  assert.equal(request.dataType, 'json');
});

test('bootstrap 只发送服务端安装凭据，不读取或上传硬件与公开 ID', () => {
  const request = buildCyclingUploadBootstrapRequest(credential);
  assert.match(request.url, new RegExp(`${CYCLING_UPLOAD_BOOTSTRAP_PATH}$`));
  assert.deepEqual(Object.keys(request.data).sort(), [
    'app_id',
    'device_credential',
    'installation_id',
  ]);
  const serialized = JSON.stringify(request);
  for (const key of [
    'hardware_fingerprint',
    'serial',
    'public_device_id',
    'aiui_id',
    'legacy_device_id',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(key, 'i'));
  }
});

test('响应解析保留 AIBike scoped token 与完整 owner marker', () => {
  assert.deepEqual(parseCyclingUploadCredentialResponse({
    statusCode: 200,
    data: credential,
  }), credential);
  assert.deepEqual(parseCyclingUploadBootstrapResponse({
    statusCode: 200,
    data: { ...identity, aiui_id: 'A1B2C3D4', bound: true },
  }), { app_id: 'aibike', ...identity });
  assert.deepEqual(parseCyclingUploadCredentialResponse({
    statusCode: 200,
    data: JSON.stringify(credential),
  }), credential);
  const encoded = new TextEncoder().encode(JSON.stringify({
    ...identity,
    token: 'b'.repeat(64),
  }));
  assert.deepEqual(parseCyclingUploadBootstrapResponse({
    statusCode: 200,
    data: encoded.buffer,
  }), { app_id: 'aibike', ...identity, token: 'b'.repeat(64) });
});

test('首次鉴权先写后读安装凭据，再 bootstrap 并缓存低权限 token', async () => {
  const local = storage();
  const requests = [];
  const result = await ensureCyclingUploadToken({
    storage: local,
    async request(options) {
      requests.push(options);
      if (requests.length === 1) {
        return { statusCode: 200, data: credential };
      }
      return {
        statusCode: 200,
        data: { ...identity, aiui_id: 'A1B2C3D4' },
      };
    },
  });

  assert.equal(result.ready, true);
  assert.equal(result.token, 't'.repeat(64));
  assert.equal(requests.length, 2);
  assert.deepEqual(readCyclingUploadCredential(local), credential);
  assert.equal(readCyclingUploadToken(local), identity.token);
  const stored = JSON.stringify([...local.values.entries()]);
  assert.doesNotMatch(stored, /A1B2C3D4/);
  assert.match(stored, /aibike-device-0001|aibike\.owner\.0001/);
  assert.ok(local.values.has(CYCLING_UPLOAD_CREDENTIAL_KEY));
  assert.ok(local.values.has(CYCLING_UPLOAD_TOKEN_KEY));
});

test('正常调用复用 token；401 刷新只复用同一个安装凭据', async () => {
  const local = storage();
  local.setStorageSync(CYCLING_UPLOAD_CREDENTIAL_KEY, credential);
  local.setStorageSync(CYCLING_UPLOAD_TOKEN_KEY, {
    ...identity,
    token: 'o'.repeat(64),
    app_id: 'aibike',
  });
  let requests = 0;
  const cached = await ensureCyclingUploadToken({
    storage: local,
    async request() {
      requests += 1;
      return null;
    },
  });
  assert.equal(cached.token, 'o'.repeat(64));
  assert.equal(requests, 0);

  const refreshed = await ensureCyclingUploadToken({
    storage: local,
    forceRefresh: true,
    async request(options) {
      requests += 1;
      assert.equal(options.data.installation_id, credential.installation_id);
      return {
        statusCode: 200,
        data: { ...identity, token: 'n'.repeat(64) },
      };
    },
  });
  assert.equal(refreshed.token, 'n'.repeat(64));
  assert.equal(requests, 1);
  assert.equal(clearCyclingUploadToken(local), true);
  assert.equal(readCyclingUploadToken(local), '');
});

test('服务端异常或 storage 写后读回失败时保持未就绪', async () => {
  const broken = storage();
  broken.setStorageSync = () => {};
  const result = await ensureCyclingUploadToken({
    storage: broken,
    async request() {
      return { statusCode: 200, data: credential };
    },
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'credential');
  assert.equal(readCyclingUploadToken(broken), '');
});
