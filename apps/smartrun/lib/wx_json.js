// Keep AIUI JSON requests deterministic across host versions. Some runtimes
// return ArrayBuffer unless responseType is explicit, while older docs describe
// text as the default. Request options prevent that drift; this decoder is the
// defensive fallback for hosts that still return text or bytes.

function decodeUtf8Fallback(bytes) {
  let output = '';
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index++];
    if (first < 0x80) {
      output += String.fromCharCode(first);
      continue;
    }
    let needed = 0;
    let codePoint = 0;
    if ((first & 0xe0) === 0xc0) {
      needed = 1;
      codePoint = first & 0x1f;
    } else if ((first & 0xf0) === 0xe0) {
      needed = 2;
      codePoint = first & 0x0f;
    } else if ((first & 0xf8) === 0xf0) {
      needed = 3;
      codePoint = first & 0x07;
    } else {
      output += '\ufffd';
      continue;
    }
    if (index + needed > bytes.length) {
      output += '\ufffd';
      break;
    }
    let valid = true;
    for (let offset = 0; offset < needed; offset += 1) {
      const next = bytes[index++];
      if ((next & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (!valid) {
      output += '\ufffd';
      continue;
    }
    if (codePoint <= 0xffff) {
      output += String.fromCharCode(codePoint);
    } else {
      const adjusted = codePoint - 0x10000;
      output += String.fromCharCode(
        0xd800 + (adjusted >> 10),
        0xdc00 + (adjusted & 0x3ff),
      );
    }
  }
  return output;
}

function bytesFrom(value) {
  if (typeof ArrayBuffer === 'undefined' || value == null) return null;
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    return new Uint8Array(value);
  }
  if (typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function decodeBytes(bytes) {
  if (typeof TextDecoder === 'function') {
    try { return new TextDecoder('utf-8').decode(bytes); } catch (_error) {}
  }
  return decodeUtf8Fallback(bytes);
}

function parseJsonValue(value) {
  let text = null;
  if (typeof value === 'string') text = value;
  else {
    const bytes = bytesFrom(value);
    if (bytes) text = decodeBytes(bytes);
  }
  if (text == null) return value;
  const trimmed = text.trim();
  if (!trimmed) return value;
  try { return JSON.parse(trimmed); } catch (_error) { return value; }
}

export function normalizeWxJsonResponse(response) {
  if (!response || typeof response !== 'object') return response;
  const data = parseJsonValue(response.data);
  return data === response.data ? response : { ...response, data };
}

export function isJsonObjectResponse(response) {
  const data = response && response.data;
  return !!data && typeof data === 'object' && !Array.isArray(data)
    && bytesFrom(data) === null;
}
