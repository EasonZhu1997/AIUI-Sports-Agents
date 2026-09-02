// Best-effort uploader for the durable post-run record queue.
// Page code supplies the current scoped token and owner-generation guard; this
// module owns only FIFO iteration and explicit-ACK deletion.
import {
  buildAiuiRecordRequest,
  parseAiuiRecordResponse,
} from './coach_api.js';
import {
  readPendingAiuiRecords,
  removePendingAiuiRecord,
} from './aiui_record_queue.js';

export async function flushPendingAiuiRecords(options = {}) {
  const storage = options.storage;
  const token = String(options.token || '');
  const request = options.request;
  const stillCurrent = typeof options.stillCurrent === 'function'
    ? options.stillCurrent : () => true;
  if (!storage || !token || typeof request !== 'function' || !stillCurrent()) {
    return false;
  }
  const pending = readPendingAiuiRecords(storage);
  if (!pending.length) return true;
  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index];
    if (!stillCurrent()) return false;
    let response = null;
    try {
      response = await request(buildAiuiRecordRequest({
        baseUrl: options.baseUrl,
        token,
        question: item.question,
        reply: item.reply,
        source: item.source,
        recordId: item.id,
      }));
    } catch (_e) {
      return false;
    }
    if (!stillCurrent()) return false;
    if (response && response.statusCode === 401) {
      if (typeof options.onUnauthorized === 'function') {
        options.onUnauthorized(token);
      }
      return false;
    }
    if (!parseAiuiRecordResponse(response)) return false;
    const remaining = removePendingAiuiRecord(storage, item);
    if (!remaining) return false;
  }
  return readPendingAiuiRecords(storage).length === 0;
}
