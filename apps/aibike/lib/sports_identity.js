// AIBike 独立 sports realm 身份。旧 aismartrun 上传凭据使用不同 storage
// key，永远不会被这里读取、迁移或当作 aibike 身份。

import { normalizeWxJsonResponse } from './wx_json.js';
import { normalizeHttpsBaseUrl } from './network_policy.js';

export const SPORTS_APP_ID = 'aibike';
export const SPORTS_ACCEPT_LANGUAGE = 'zh-CN';
export const SPORTS_HERMES_BASE_URL = '';
export const SPORTS_CREDENTIAL_PATH =
  '/api/coach-svc/coach/device-registration-credential';
export const SPORTS_BOOTSTRAP_PATH =
  '/api/coach-svc/coach/device-bootstrap';
export const SPORTS_CREDENTIAL_KEY = 'aibike_sports_credential_v1';
export const SPORTS_IDENTITY_KEY = 'aibike_sports_identity_v1';

const INSTALLATION_RE = /^[A-Za-z0-9._:-]{8,160}$/;
const OWNER_ID_RE = /^[A-Za-z0-9_-]{8,160}$/;
const NAMESPACE_RE = /^[A-Za-z0-9._:-]{8,200}$/;
const SERVER_NAMESPACE_RE = /^ns_[a-f0-9]{24}$/;

function compact(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function dataOf(response) {
  const normalized = normalizeWxJsonResponse(response);
  return normalized && normalized.data && typeof normalized.data === 'object'
    ? normalized.data : null;
}

export function normalizeSportsBaseUrl(value) {
  return normalizeHttpsBaseUrl(value);
}

function post(path, data, options = {}) {
  return {
    url: normalizeSportsBaseUrl(options.baseUrl) + path,
    method: 'POST',
    header: {
      'Content-Type': 'application/json',
      'Accept-Language': SPORTS_ACCEPT_LANGUAGE,
    },
    dataType: 'json',
    responseType: 'text',
    timeout: Number(options.timeout) || 12000,
    data,
  };
}

export function buildSportsCredentialRequest(options = {}) {
  return post(options.path || SPORTS_CREDENTIAL_PATH, {
    app_id: SPORTS_APP_ID,
  }, options);
}

export function parseSportsCredentialResponse(response) {
  const data = dataOf(response);
  if (!(Number(response && response.statusCode) >= 200
      && Number(response && response.statusCode) < 300) || !data) return null;
  const installationId = compact(data.installation_id, 160);
  const deviceCredential = compact(data.device_credential, 2048);
  return INSTALLATION_RE.test(installationId) && deviceCredential.length >= 32
    ? { installation_id: installationId, device_credential: deviceCredential }
    : null;
}

export function normalizeSportsCredential(value) {
  return parseSportsCredentialResponse({ statusCode: 200, data: value });
}

export function readSportsCredential(storage) {
  try {
    return storage && typeof storage.getStorageSync === 'function'
      ? normalizeSportsCredential(storage.getStorageSync(SPORTS_CREDENTIAL_KEY))
      : null;
  } catch (_error) {
    return null;
  }
}

export function writeSportsCredential(storage, value) {
  const credential = normalizeSportsCredential(value);
  if (!credential || !storage || typeof storage.setStorageSync !== 'function'
      || typeof storage.getStorageSync !== 'function') return null;
  try {
    storage.setStorageSync(SPORTS_CREDENTIAL_KEY, credential);
    const readback = readSportsCredential(storage);
    return JSON.stringify(readback) === JSON.stringify(credential) ? readback : null;
  } catch (_error) {
    return null;
  }
}

export function buildSportsBootstrapRequest(credential, options = {}) {
  const normalized = normalizeSportsCredential(credential);
  if (!normalized) return null;
  return post(options.path || SPORTS_BOOTSTRAP_PATH, {
    app_id: SPORTS_APP_ID,
    installation_id: normalized.installation_id,
    device_credential: normalized.device_credential,
  }, options);
}

export function normalizeSportsIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  const token = compact(value.token, 4096);
  const publicDeviceId = compact(value.public_device_id, 160);
  const dataNamespace = compact(value.data_namespace, 200);
  const ownershipEpoch = Number(value.ownership_epoch);
  if (token.length < 32 || !OWNER_ID_RE.test(publicDeviceId)
      || !NAMESPACE_RE.test(dataNamespace)
      || !Number.isSafeInteger(ownershipEpoch) || ownershipEpoch < 1) return null;
  return {
    app_id: SPORTS_APP_ID,
    token,
    public_device_id: publicDeviceId,
    ownership_epoch: ownershipEpoch,
    data_namespace: dataNamespace,
  };
}

export function normalizeSportsOwner(value) {
  if (!value || typeof value !== 'object') return null;
  const publicDeviceId = compact(value.public_device_id, 160);
  const dataNamespace = compact(value.data_namespace, 200);
  const ownershipEpoch = Number(value.ownership_epoch);
  return OWNER_ID_RE.test(publicDeviceId) && NAMESPACE_RE.test(dataNamespace)
    && Number.isSafeInteger(ownershipEpoch) && ownershipEpoch >= 1 ? {
      public_device_id: publicDeviceId,
      ownership_epoch: ownershipEpoch,
      data_namespace: dataNamespace,
    } : null;
}

export function normalizeSportsOwnershipTransition(value) {
  if (!value || typeof value !== 'object' || value.kind !== 'anonymous_claim') return null;
  const previousEpoch = Number(value.previous_ownership_epoch);
  const currentEpoch = Number(value.current_ownership_epoch);
  const previousNamespace = compact(value.previous_data_namespace, 200);
  const currentNamespace = compact(value.current_data_namespace, 200);
  return Number.isSafeInteger(previousEpoch) && previousEpoch >= 1
    && Number.isSafeInteger(currentEpoch) && currentEpoch === previousEpoch + 1
    && SERVER_NAMESPACE_RE.test(previousNamespace)
    && SERVER_NAMESPACE_RE.test(currentNamespace) ? {
      kind: 'anonymous_claim',
      previous_ownership_epoch: previousEpoch,
      previous_data_namespace: previousNamespace,
      current_ownership_epoch: currentEpoch,
      current_data_namespace: currentNamespace,
    } : null;
}

export function parseSportsBootstrapResponse(response) {
  if (Number(response && response.statusCode) !== 200) return null;
  const data = dataOf(response);
  const identity = normalizeSportsIdentity(data);
  if (!identity) return null;
  const transition = normalizeSportsOwnershipTransition(data && data.ownership_transition);
  if (data && data.ownership_transition && !transition) return null;
  if (transition && (
    transition.current_ownership_epoch !== identity.ownership_epoch
    || transition.current_data_namespace !== identity.data_namespace
  )) return null;
  return transition ? { ...identity, ownership_transition: transition } : identity;
}

export function sameSportsOwner(a, b) {
  const left = normalizeSportsIdentity(a);
  const right = normalizeSportsIdentity(b);
  return !!left && !!right
    && left.public_device_id === right.public_device_id
    && left.ownership_epoch === right.ownership_epoch
    && left.data_namespace === right.data_namespace;
}

export function isSportsAnonymousClaimTransition(previous, current) {
  const oldIdentity = normalizeSportsIdentity(previous);
  const newIdentity = normalizeSportsIdentity(current);
  const transition = normalizeSportsOwnershipTransition(
    current && current.ownership_transition,
  );
  return !!oldIdentity && !!newIdentity && !!transition
    && oldIdentity.public_device_id === newIdentity.public_device_id
    && transition.kind === 'anonymous_claim'
    && transition.previous_ownership_epoch === oldIdentity.ownership_epoch
    && transition.previous_data_namespace === oldIdentity.data_namespace
    && transition.current_ownership_epoch === newIdentity.ownership_epoch
    && transition.current_data_namespace === newIdentity.data_namespace;
}

export function sportsOwnerMarker(identity) {
  const value = normalizeSportsIdentity(identity) || normalizeSportsOwner(identity);
  return value ? normalizeSportsOwner(value) : null;
}

export function readSportsIdentity(storage) {
  try {
    return storage && typeof storage.getStorageSync === 'function'
      ? normalizeSportsIdentity(storage.getStorageSync(SPORTS_IDENTITY_KEY))
      : null;
  } catch (_error) {
    return null;
  }
}

export function writeSportsIdentity(storage, value) {
  const identity = normalizeSportsIdentity(value);
  if (!identity || !storage || typeof storage.setStorageSync !== 'function'
      || typeof storage.getStorageSync !== 'function') return null;
  try {
    storage.setStorageSync(SPORTS_IDENTITY_KEY, identity);
    const readback = readSportsIdentity(storage);
    return JSON.stringify(readback) === JSON.stringify(identity) ? readback : null;
  } catch (_error) {
    return null;
  }
}

export function readSportsToken(storage) {
  const identity = readSportsIdentity(storage);
  return identity ? identity.token : '';
}

export function writeSportsToken(storage, token) {
  const identity = readSportsIdentity(storage);
  if (!identity) return '';
  const stored = writeSportsIdentity(storage, { ...identity, token });
  return stored ? stored.token : '';
}

export function clearSportsToken(storage) {
  if (!storage) return false;
  try {
    if (typeof storage.removeStorageSync === 'function') {
      storage.removeStorageSync(SPORTS_IDENTITY_KEY);
    } else if (typeof storage.setStorageSync === 'function') {
      storage.setStorageSync(SPORTS_IDENTITY_KEY, null);
    } else return false;
    return readSportsIdentity(storage) == null;
  } catch (_error) {
    return false;
  }
}

export async function ensureSportsIdentity(options = {}) {
  const { storage, request } = options;
  if (!storage || typeof request !== 'function') {
    return { ready: false, token: '', reason: 'unavailable' };
  }
  if (options.forceRefresh !== true) {
    const cached = readSportsIdentity(storage);
    if (cached) return { ...cached, ready: true, fromCache: true };
  }

  let credential = readSportsCredential(storage);
  if (!credential) {
    let response = null;
    try { response = await request(buildSportsCredentialRequest(options)); } catch (_error) {}
    credential = writeSportsCredential(storage, parseSportsCredentialResponse(response));
    if (!credential) return {
      ready: false,
      token: '',
      reason: 'credential',
      statusCode: Number(response && response.statusCode) || 0,
    };
  }

  let response = null;
  try {
    response = await request(buildSportsBootstrapRequest(credential, options));
  } catch (_error) {}
  const parsed = parseSportsBootstrapResponse(response);
  const transition = parsed && parsed.ownership_transition;
  const identity = writeSportsIdentity(storage, parsed);
  return identity ? {
    ...identity,
    ready: true,
    fromCache: false,
    ...(transition ? { ownership_transition: transition } : {}),
  } : {
    ready: false,
    token: '',
    reason: 'bootstrap',
    statusCode: Number(response && response.statusCode) || 0,
  };
}
