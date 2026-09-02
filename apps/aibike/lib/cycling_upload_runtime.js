// AIBike Hermes 待上传队列执行器。
//
// 页面只负责把 wx.request 包装成 Promise；这里统一处理低权限鉴权、
// 明确 ACK、401 刷新、瞬时失败保留以及永久拒绝事件的本地隔离。

import {
  buildCyclingUploadRequest,
  classifyCyclingUploadRejection,
  isolateCyclingPoisonEvent,
  parseCyclingUploadResponse,
  quarantineCyclingUploadEvents,
  readPendingCyclingUploadEventsResult,
  removePendingCyclingUploadEvents,
  selectCyclingUploadBatch,
} from './cycling_upload.js';
import {
  clearCyclingUploadToken,
  ensureCyclingUploadToken,
} from './cycling_upload_auth.js';

const DEFAULT_MAX_REQUESTS = 40;
const MAX_TRANSIENT_RETRIES_PER_BATCH = 3;
const TRANSIENT_RETRY_DELAYS_MS = Object.freeze([300, 900, 1800]);

function statusCode(response) {
  const numeric = Number(response && response.statusCode);
  return Number.isFinite(numeric) ? numeric : 0;
}

function isTransientStatus(status) {
  return status === 0 || status === 408 || status === 425 || status === 429
    || status >= 500;
}

function transientReason(status) {
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'network';
}

async function waitBeforeTransientRetry(context, value) {
  const retryNumber = Math.max(1, Number(value.retryNumber) || 1);
  const delayMs = TRANSIENT_RETRY_DELAYS_MS[Math.min(
    retryNumber - 1,
    TRANSIENT_RETRY_DELAYS_MS.length - 1,
  )];
  const detail = {
    phase: 'retrying',
    retryNumber,
    delayMs,
    statusCode: Number(value.statusCode) || 0,
    batchSize: Number(value.batchSize) || 0,
  };
  progress(context.onProgress, detail);
  if (typeof context.waitBeforeRetry === 'function') {
    try { await context.waitBeforeRetry(detail); } catch (_error) {}
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function progress(callback, value) {
  if (typeof callback !== 'function') return;
  try { callback(value); } catch (_error) {}
}

function rememberPendingRead(context, pendingRead) {
  if (!pendingRead || pendingRead.ok !== true) return pendingRead;
  context.lastKnownPending = pendingRead.events.length;
  return pendingRead;
}

function readPending(context) {
  const pendingRead = rememberPendingRead(
    context,
    readPendingCyclingUploadEventsResult(context.storage),
  );
  if (pendingRead && pendingRead.ok !== true && !context.storageFailureStatus) {
    context.storageFailureStatus = pendingRead.status || 'read_failed';
  }
  return pendingRead;
}

function result(status, context, extra = {}, suppliedPendingRead = null) {
  const pendingRead = suppliedPendingRead || readPending(context);
  const storageReadable = pendingRead && pendingRead.ok === true;
  const pending = storageReadable
    ? pendingRead.events.length
    : (Number.isFinite(context.lastKnownPending)
      ? context.lastKnownPending : 0);
  const value = {
    status,
    acked: context.acked,
    stored: context.stored,
    duplicates: context.duplicates,
    quarantined: context.quarantined,
    pending,
    requestCount: context.requestCount,
    organizedRides: context.organizedRides.slice(),
    priorityRideQuarantined: context.priorityRideQuarantined,
    rejections: context.rejections.slice(),
    ...extra,
  };
  if (!storageReadable) {
    // A storage failure is not proof that the durable queue is empty.  Always
    // override optimistic terminal states so callers cannot report
    // "empty"/"uploaded" while the host-private journal is unreadable.
    value.status = 'pending';
    value.reason = 'storage';
    value.storageStatus = pendingRead && pendingRead.status
      ? pendingRead.status : 'unavailable';
    value.pendingKnown = false;
  } else {
    value.pendingKnown = true;
  }
  return value;
}

function rememberRejection(context, rejection) {
  const value = {
    statusCode: Number(rejection && rejection.statusCode) || 0,
    conflictCode: String(
      rejection && rejection.conflictCode || 'permanent_rejection',
    ),
    scope: rejection && rejection.scope === 'ride' ? 'ride' : 'event',
    count: Math.max(1, Number(rejection && rejection.count) || 1),
  };
  if (!context.rejections.some((item) => (
    item.statusCode === value.statusCode
      && item.conflictCode === value.conflictCode
      && item.scope === value.scope
  ))) context.rejections.push(value);
  if (context.rejections.length > 8) context.rejections.shift();
  progress(context.onProgress, { phase: 'rejected', ...value });
}

/**
 * 上传当前 storage 中的隐私白名单事件。
 *
 * request(options) 必须返回 Promise<wx.response-like>。HTTP 200 只有携带
 * 请求内明确 acked_event_ids 才算成功；网络、429 与 5xx 均完整保留。
 */
export async function flushPendingCyclingUploads(options = {}) {
  const storage = options.storage;
  const request = options.request;
  const maxRequests = Math.max(
    1,
    Math.min(120, Number(options.maxRequests) || DEFAULT_MAX_REQUESTS),
  );
  const context = {
    storage,
    request,
    baseUrl: options.baseUrl,
    onProgress: options.onProgress,
    waitBeforeRetry: options.waitBeforeRetry,
    priorityRideId: typeof options.priorityRideId === 'string'
      ? options.priorityRideId.trim() : '',
    maxRequests,
    requestCount: 0,
    token: '',
    authRefreshUsed: false,
    acked: 0,
    stored: 0,
    duplicates: 0,
    quarantined: 0,
    priorityRideQuarantined: false,
    rejections: [],
    organizedRides: [],
    lastKnownPending: null,
    storageFailureStatus: '',
  };

  if (!storage || typeof request !== 'function') {
    return result('pending', context, { reason: 'unavailable' });
  }
  const initialRead = readPending(context);
  if (!initialRead.ok) {
    return result('pending', context, { reason: 'storage' }, initialRead);
  }
  if (!initialRead.events.length) return result('empty', context, {}, initialRead);

  const auth = await ensureCyclingUploadToken({
    storage,
    request,
    baseUrl: context.baseUrl,
  });
  if (!auth.ready || !auth.token) {
    return result('pending', context, {
      reason: 'auth',
      statusCode: Number(auth.statusCode) || 0,
    });
  }
  context.token = auth.token;

  const refreshAuth = async () => {
    if (context.authRefreshUsed) return false;
    context.authRefreshUsed = true;
    clearCyclingUploadToken(storage);
    const refreshed = await ensureCyclingUploadToken({
      storage,
      request,
      baseUrl: context.baseUrl,
      forceRefresh: true,
    });
    if (!refreshed.ready || !refreshed.token) return false;
    context.token = refreshed.token;
    return true;
  };

  const sendBatch = async (batch, retryState = {}) => {
    if (!batch.length) return { progressed: false, stop: false };
    if (context.requestCount >= context.maxRequests) {
      return { progressed: false, stop: true, reason: 'budget' };
    }
    context.requestCount += 1;
    progress(context.onProgress, {
      phase: 'uploading',
      requestCount: context.requestCount,
      batchSize: batch.length,
    });
    let response = null;
    try {
      response = await request(buildCyclingUploadRequest({
        baseUrl: context.baseUrl,
        token: context.token,
        events: batch,
      }));
    } catch (_error) {}
    const status = statusCode(response);

    if (status === 401 && await refreshAuth()) {
      return sendBatch(batch, retryState);
    }

    const parsed = parseCyclingUploadResponse(response, batch);
    if (parsed) {
      const remaining = removePendingCyclingUploadEvents(
        storage,
        parsed.ackedEventIds,
      );
      if (remaining === null) {
        context.storageFailureStatus = context.storageFailureStatus
          || 'mutation_failed';
        return { progressed: false, stop: true, reason: 'storage' };
      }
      context.lastKnownPending = remaining.length;
      context.acked += parsed.ackedEventIds.length;
      context.stored += parsed.stored;
      context.duplicates += parsed.duplicates;
      for (let index = 0; index < parsed.organizedRides.length; index += 1) {
        const ride = parsed.organizedRides[index];
        const oldIndex = context.organizedRides.findIndex(
          (item) => item.test_ride_id === ride.test_ride_id,
        );
        if (oldIndex >= 0) context.organizedRides[oldIndex] = ride;
        else context.organizedRides.push(ride);
      }
      progress(context.onProgress, {
        phase: 'acked',
        acked: context.acked,
        pending: remaining.length,
      });
      return { progressed: true, stop: false };
    }

    const transientRetries = Math.max(
      0,
      Number(retryState.transientRetries) || 0,
    );
    if (isTransientStatus(status)
        && transientRetries < MAX_TRANSIENT_RETRIES_PER_BATCH) {
      await waitBeforeTransientRetry(context, {
        retryNumber: transientRetries + 1,
        statusCode: status,
        batchSize: batch.length,
      });
      return sendBatch(batch, {
        ...retryState,
        transientRetries: transientRetries + 1,
      });
    }

    const rejection = classifyCyclingUploadRejection(response);
    if (rejection && rejection.conflictCode === 'ride_lifecycle') {
      const rideId = batch[0] && batch[0].test_ride_id;
      const pendingRead = readPending(context);
      if (!pendingRead.ok) {
        return { progressed: false, stop: true, reason: 'storage' };
      }
      const rejectedRide = pendingRead.events.filter(
        (event) => event.test_ride_id === rideId,
      );
      const quarantined = quarantineCyclingUploadEvents(
        storage,
        rejectedRide,
        status,
        rejection.conflictCode,
      );
      if (!quarantined) {
        context.storageFailureStatus = context.storageFailureStatus
          || 'mutation_failed';
        return { progressed: false, stop: true, reason: 'storage' };
      }
      context.quarantined += rejectedRide.length;
      if (rideId && rideId === context.priorityRideId) {
        context.priorityRideQuarantined = true;
      }
      rememberRejection(context, {
        ...rejection,
        scope: 'ride',
        count: rejectedRide.length,
      });
      return { progressed: true, stop: false };
    }

    if (rejection && rejection.conflictCode === 'finish_conflict') {
      const finishEvents = batch.filter(
        (event) => event.event_type === 'finish',
      );
      if (finishEvents.length) {
        const quarantined = quarantineCyclingUploadEvents(
          storage,
          finishEvents,
          status,
          rejection.conflictCode,
        );
        if (!quarantined) {
          context.storageFailureStatus = context.storageFailureStatus
            || 'mutation_failed';
          return { progressed: false, stop: true, reason: 'storage' };
        }
        context.quarantined += finishEvents.length;
        if (finishEvents.some(
          (event) => event.test_ride_id === context.priorityRideId,
        )) context.priorityRideQuarantined = true;
        rememberRejection(context, {
          ...rejection,
          scope: 'event',
          count: finishEvents.length,
        });
        const sampleEvents = batch.filter(
          (event) => event.event_type !== 'finish',
        );
        if (!sampleEvents.length) return { progressed: true, stop: false };
        const child = await sendBatch(sampleEvents);
        return { ...child, progressed: true };
      }
    }

    const isolation = isolateCyclingPoisonEvent(status, batch);
    if (isolation.action === 'split') {
      let progressed = false;
      for (let index = 0; index < isolation.retryBatches.length; index += 1) {
        const child = await sendBatch(isolation.retryBatches[index]);
        progressed = progressed || child.progressed;
        if (child.stop) return { ...child, progressed };
      }
      return { progressed, stop: false };
    }
    if (isolation.action === 'quarantine' && isolation.poisonEvent) {
      const quarantined = quarantineCyclingUploadEvents(
        storage,
        [isolation.poisonEvent],
        status,
        rejection && rejection.conflictCode,
      );
      if (!quarantined) {
        context.storageFailureStatus = context.storageFailureStatus
          || 'mutation_failed';
        return { progressed: false, stop: true, reason: 'storage' };
      }
      context.quarantined += 1;
      if (isolation.poisonEvent.test_ride_id === context.priorityRideId) {
        context.priorityRideQuarantined = true;
      }
      rememberRejection(context, {
        statusCode: status,
        conflictCode: rejection && rejection.conflictCode,
        scope: 'event',
        count: 1,
      });
      return { progressed: true, stop: false };
    }
    return {
      progressed: false,
      stop: true,
      reason: status === 401 ? 'auth'
        : isTransientStatus(status) ? transientReason(status)
          : status >= 200 && status < 300 ? 'ack'
            : 'network',
      statusCode: status,
    };
  };

  let stopReason = '';
  let stopStatusCode = 0;
  while (context.requestCount < context.maxRequests) {
    const pendingRead = readPending(context);
    if (!pendingRead.ok) {
      stopReason = 'storage';
      break;
    }
    if (!pendingRead.events.length) break;
    const batch = selectCyclingUploadBatch(
      pendingRead.events,
      context.priorityRideId,
    );
    const outcome = await sendBatch(batch);
    if (outcome.stop) {
      stopReason = outcome.reason || 'pending';
      stopStatusCode = Number(outcome.statusCode) || 0;
      break;
    }
    if (!outcome.progressed) {
      stopReason = 'pending';
      break;
    }
  }

  const finalRead = readPending(context);
  if (!finalRead.ok) {
    return result('pending', context, {
      reason: 'storage',
      statusCode: stopStatusCode,
    }, finalRead);
  }
  if (stopReason === 'storage') {
    return result('pending', context, {
      reason: 'storage',
      storageStatus: context.storageFailureStatus || 'mutation_failed',
      statusCode: stopStatusCode,
    }, finalRead);
  }
  if (!finalRead.events.length) {
    return result(
      context.quarantined ? 'uploaded_with_quarantine' : 'uploaded',
      context,
      {},
      finalRead,
    );
  }
  return result('pending', context, {
    reason: stopReason || 'budget',
    statusCode: stopStatusCode,
  }, finalRead);
}
