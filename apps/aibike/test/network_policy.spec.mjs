import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeNetworkRequest,
  networkPolicyFromSettings,
  normalizeHttpsBaseUrl,
} from '../lib/network_policy.js';

test('public network policy is denied unless opt-in and HTTPS base URL both exist', () => {
  assert.deepEqual(networkPolicyFromSettings({}), {
    enabled: false,
    baseUrl: '',
    allowed: false,
  });
  assert.equal(authorizeNetworkRequest({ url: '/api/test' }, {}), null);
  assert.equal(authorizeNetworkRequest({ url: '/api/test' }, {
    networkSyncEnabled: true,
  }), null);
  assert.equal(authorizeNetworkRequest({ url: '/api/test' }, {
    networkBaseUrl: 'https://example.test',
  }), null);
});

test('network policy accepts explicit HTTPS base and keeps requests on that base', () => {
  const settings = {
    networkSyncEnabled: true,
    networkBaseUrl: 'https://example.test/coach/',
  };
  assert.equal(normalizeHttpsBaseUrl(settings.networkBaseUrl),
    'https://example.test/coach');
  assert.deepEqual(authorizeNetworkRequest({ url: '/api/test', method: 'POST' }, settings), {
    url: 'https://example.test/coach/api/test',
    method: 'POST',
  });
  assert.equal(authorizeNetworkRequest({ url: 'https://other.test/api' }, settings), null);
});

test('network policy rejects insecure, credentialed, malformed and invalid-port bases', () => {
  for (const value of [
    'http://example.test',
    'https://user@example.test',
    'https://example.test?token=x',
    'https://example.test/#fragment',
    'https://example..test',
    'https://example.test:70000',
  ]) assert.equal(normalizeHttpsBaseUrl(value), '');
});
