const HTTPS_PREFIX = 'https://';

function compact(value, max = 512) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function normalizeHttpsBaseUrl(value) {
  const input = compact(value).replace(/\/+$/, '');
  if (!input.startsWith(HTTPS_PREFIX) || /[\s?#]/.test(input)) return '';
  const remainder = input.slice(HTTPS_PREFIX.length);
  const slash = remainder.indexOf('/');
  const authority = slash >= 0 ? remainder.slice(0, slash) : remainder;
  const path = slash >= 0 ? remainder.slice(slash) : '';
  if (!authority || authority.includes('@') || authority.includes('..')) return '';
  const authorityMatch = authority.match(/^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/);
  if (!authorityMatch || authorityMatch[1].startsWith('.')
      || authorityMatch[1].endsWith('.')) return '';
  if (authorityMatch[2]) {
    const port = Number(authorityMatch[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return '';
  }
  if (path && !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(path)) return '';
  return HTTPS_PREFIX + authority + path;
}

export function networkPolicyFromSettings(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const baseUrl = normalizeHttpsBaseUrl(source.networkBaseUrl);
  return {
    enabled: source.networkSyncEnabled === true,
    baseUrl,
    allowed: source.networkSyncEnabled === true && Boolean(baseUrl),
  };
}

export function authorizeNetworkRequest(options, settings) {
  const policy = networkPolicyFromSettings(settings);
  if (!policy.allowed || !options || typeof options !== 'object') return null;
  const rawUrl = compact(options.url, 1024);
  if (!rawUrl || /[\r\n]/.test(rawUrl)) return null;
  let url = '';
  if (rawUrl.startsWith('/')) {
    url = policy.baseUrl + rawUrl;
  } else if (rawUrl.startsWith(policy.baseUrl + '/')) {
    url = rawUrl;
  } else {
    return null;
  }
  return { ...options, url };
}
