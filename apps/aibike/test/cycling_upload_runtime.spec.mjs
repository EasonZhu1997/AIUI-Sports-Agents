import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendPendingCyclingUploadEvents,
  captureCyclingUploadFinish,
  captureCyclingUploadSample,
  createCyclingUploadSession,
  PENDING_CYCLING_UPLOAD_KEY,
  readPendingCyclingUploadEvents,
  readQuarantinedCyclingUploadEvents,
} from '../lib/cycling_upload.js';
import {
  writeCyclingUploadCredential,
} from '../lib/cycling_upload_auth.js';
import { flushPendingCyclingUploads } from '../lib/cycling_upload_runtime.js';

const START = 1785050000000;

function storage() {
  const map = new Map();
  return {
    map,
    getStorageSync(key) { return map.get(key); },
    setStorageSync(key, value) {
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
    removeStorageSync(key) { map.delete(key); },
  };
}

function rideEvents() {
  const stream = createCyclingUploadSession(START, { random: () => 0.4 });
  const first = captureCyclingUploadSample(stream, {
    speed_kmh: 23,
    cadence_rpm: 86,
    speed_source: 'gps',
    cadence_source: 'imu',
    speed_state: 'live',
    cadence_state: 'live',
  }, { capturedAtMs: START + 1000 });
  const second = captureCyclingUploadSample(stream, {
    speed_kmh: 24,
    cadence_rpm: 88,
    speed_source: 'gps',
    cadence_source: 'imu',
    speed_state: 'live',
    cadence_state: 'live',
  }, { capturedAtMs: START + 2000 });
  const finish = captureCyclingUploadFinish(stream, {
    endedAtMs: START + 3000,
    elapsedMs: 3000,
    sampleCount: 2,
    avgSpeedKmh: 23.5,
    avgCadenceRpm: 87,
    sources: ['gps', 'imu'],
  });
  return [first, second, finish];
}

function newerRideEvents() {
  const startedAt = START + 10000;
  const stream = createCyclingUploadSession(
    startedAt,
    { random: () => 0.7 },
  );
  const sample = captureCyclingUploadSample(stream, {
    speed_kmh: 18,
    cadence_rpm: 75,
    speed_source: 'imu',
    cadence_source: 'imu',
    distance_source: 'imu',
    distance_mode: 'cadence_model',
    speed_state: 'live',
    cadence_state: 'live',
    distance_state: 'live',
  }, { capturedAtMs: startedAt + 1000 });
  const finish = captureCyclingUploadFinish(stream, {
    endedAtMs: startedAt + 2000,
    elapsedMs: 2000,
    sampleCount: 1,
    distanceM: 10,
    sources: ['imu'],
    distanceSources: ['imu'],
    cadenceSources: ['imu'],
  });
  return [sample, finish];
}

function readyStorage(events) {
  const s = storage();
  writeCyclingUploadCredential(s, {
    installation_id: 'aibike-runtime-installation',
    device_credential: 'c'.repeat(64),
  });
  s.setStorageSync('aibike_sports_identity_v1', {
    app_id: 'aibike',
    token: 't'.repeat(64),
    public_device_id: 'aibike-device-runtime',
    ownership_epoch: 1,
    data_namespace: 'aibike.runtime.owner',
  });
  appendPendingCyclingUploadEvents(s, events);
  return s;
}

test('结束批次只有明确 ACK 后才清空，并返回服务端整理后的骑行', async () => {
  const events = rideEvents();
  const s = readyStorage(events);
  const result = await flushPendingCyclingUploads({
    storage: s,
    async request(options) {
      const requestEvents = options.data.events;
      return {
        statusCode: 200,
        data: {
          acked_event_ids: requestEvents.map((event) => event.event_id),
          stored: requestEvents.length,
          duplicates: 0,
          organized_rides: [{
            test_ride_id: events[0].test_ride_id,
            samples: 2,
            finish_received: true,
            started_at_ms: START,
            ended_at_ms: START + 3000,
          }],
        },
      };
    },
  });
  assert.equal(result.status, 'uploaded');
  assert.equal(result.acked, 3);
  assert.equal(result.pending, 0);
  assert.equal(result.organizedRides[0].finish_received, true);
  assert.equal(result.organizedRides[0].samples, 2);
});

test('HTTP 200 没有 acked_event_ids 仍完整保留，不能猜测服务端已写入', async () => {
  const events = rideEvents();
  const s = readyStorage(events);
  const result = await flushPendingCyclingUploads({
    storage: s,
    async request() {
      return { statusCode: 200, data: { stored: 3 } };
    },
  });
  assert.equal(result.status, 'pending');
  assert.equal(result.acked, 0);
  assert.equal(readPendingCyclingUploadEvents(s).length, 3);
});

test('网络、429 与 5xx 都保留原队列等待下次骑行结束或页面恢复', async () => {
  for (const statusCode of [0, 429, 503]) {
    const events = rideEvents();
    const s = readyStorage(events);
    const result = await flushPendingCyclingUploads({
      storage: s,
      async request() { return { statusCode }; },
      async waitBeforeRetry() {},
    });
    assert.equal(result.status, 'pending');
    assert.equal(result.requestCount, 4, '首次请求加每批最多三次瞬态重试');
    assert.equal(readPendingCyclingUploadEvents(s).length, 3);
    assert.equal(readQuarantinedCyclingUploadEvents(s).length, 0);
  }
});

test('网络、408、425、429 与 5xx 可在同一批有界重试后 ACK', async () => {
  for (const transientStatus of [0, 408, 425, 429, 503]) {
    const events = rideEvents();
    const s = readyStorage(events);
    const waits = [];
    let requestCount = 0;
    const result = await flushPendingCyclingUploads({
      storage: s,
      async request(options) {
        requestCount += 1;
        if (requestCount < 3) return { statusCode: transientStatus };
        return {
          statusCode: 200,
          data: {
            acked_event_ids: options.data.events.map((event) => event.event_id),
            stored: options.data.events.length,
            duplicates: 0,
          },
        };
      },
      async waitBeforeRetry(detail) { waits.push(detail); },
    });
    assert.equal(result.status, 'uploaded');
    assert.equal(result.acked, events.length);
    assert.equal(result.requestCount, 3);
    assert.deepEqual(waits.map((item) => item.retryNumber), [1, 2]);
    assert.deepEqual(waits.map((item) => item.delayMs), [300, 900]);
    assert.equal(readPendingCyclingUploadEvents(s).length, 0);
  }
});

test('瞬态重试预算耗尽后完整保留队列与明确失败原因', async () => {
  const events = rideEvents();
  const s = readyStorage(events);
  const waits = [];
  const result = await flushPendingCyclingUploads({
    storage: s,
    async request() { return { statusCode: 503 }; },
    async waitBeforeRetry(detail) { waits.push(detail); },
  });
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'server');
  assert.equal(result.statusCode, 503);
  assert.equal(result.requestCount, 4);
  assert.deepEqual(waits.map((item) => item.delayMs), [300, 900, 1800]);
  assert.deepEqual(readPendingCyclingUploadEvents(s), events);
});

test('401 仍只刷新一次，刷新后允许瞬态失败再恢复', async () => {
  const events = rideEvents();
  const s = readyStorage(events);
  writeCyclingUploadCredential(s, {
    installation_id: 'aibike-retry-installation',
    device_credential: 'c'.repeat(64),
  });
  let requestCount = 0;
  const result = await flushPendingCyclingUploads({
    storage: s,
    async request(options) {
      requestCount += 1;
      if (requestCount === 1) return { statusCode: 401 };
      if (options.url.endsWith('/device-bootstrap')) {
        return { statusCode: 200, data: {
          token: 'n'.repeat(64),
          public_device_id: 'aibike-device-runtime',
          ownership_epoch: 1,
          data_namespace: 'aibike.runtime.owner',
        } };
      }
      if (requestCount === 3) return { statusCode: 503 };
      return {
        statusCode: 200,
        data: {
          acked_event_ids: options.data.events.map((event) => event.event_id),
          stored: options.data.events.length,
          duplicates: 0,
        },
      };
    },
    async waitBeforeRetry() {},
  });
  assert.equal(result.status, 'uploaded');
  assert.equal(result.requestCount, 3, 'bootstrap 鉴权请求不占 batch 请求预算');
  assert.equal(readPendingCyclingUploadEvents(s).length, 0);
});

test('永久拒绝二分定位单条异常，隔离后继续 ACK 其余科学记录', async () => {
  const events = rideEvents();
  const poisonId = events[1].event_id;
  const s = readyStorage(events);
  const result = await flushPendingCyclingUploads({
    storage: s,
    async request(options) {
      const requestEvents = options.data.events;
      if (requestEvents.some((event) => event.event_id === poisonId)) {
        return { statusCode: 422, data: { detail: 'bad sample' } };
      }
      return {
        statusCode: 200,
        data: {
          acked_event_ids: requestEvents.map((event) => event.event_id),
          stored: requestEvents.length,
          duplicates: 0,
        },
      };
    },
  });
  assert.equal(result.status, 'uploaded_with_quarantine');
  assert.equal(result.acked, 2);
  assert.equal(result.quarantined, 1);
  assert.equal(result.pending, 0);
  assert.equal(
    readQuarantinedCyclingUploadEvents(s)[0].event.event_id,
    poisonId,
  );
});

test('当前刚结束骑行优先上传，旧生命周期冲突一次隔离且不再拖死新记录', async () => {
  const older = rideEvents();
  const current = newerRideEvents();
  const s = readyStorage([...older, ...current]);
  const requestRideOrder = [];
  const progress = [];
  const result = await flushPendingCyclingUploads({
    storage: s,
    priorityRideId: current[0].test_ride_id,
    onProgress(detail) { progress.push(detail); },
    async request(options) {
      const requestEvents = options.data.events;
      const rideId = requestEvents[0].test_ride_id;
      requestRideOrder.push(rideId);
      if (rideId === older[0].test_ride_id) {
        return {
          statusCode: 409,
          data: { detail: 'test_ride_id belongs to another lifecycle' },
        };
      }
      return {
        statusCode: 200,
        data: {
          acked_event_ids: requestEvents.map((event) => event.event_id),
          stored: requestEvents.length,
          duplicates: 0,
          organized_rides: [{
            test_ride_id: rideId,
            samples: 1,
            finish_received: true,
            started_at_ms: START + 10000,
            ended_at_ms: START + 12000,
          }],
        },
      };
    },
  });
  assert.deepEqual(requestRideOrder, [
    current[0].test_ride_id,
    older[0].test_ride_id,
  ]);
  assert.equal(result.status, 'uploaded_with_quarantine');
  assert.equal(result.acked, current.length);
  assert.equal(result.quarantined, older.length);
  assert.equal(result.requestCount, 2);
  assert.equal(result.priorityRideQuarantined, false);
  assert.equal(readPendingCyclingUploadEvents(s).length, 0);
  assert.equal(readQuarantinedCyclingUploadEvents(s).length, older.length);
  assert.deepEqual(result.rejections, [{
    statusCode: 409,
    conflictCode: 'ride_lifecycle',
    scope: 'ride',
    count: older.length,
  }]);
  assert.equal(
    progress.some((item) => item.phase === 'rejected'
      && item.conflictCode === 'ride_lifecycle'),
    true,
  );
});

test('finish 冲突只隔离 finish，回滚的样本会重新发送并得到明确 ACK', async () => {
  const batch = rideEvents();
  const s = readyStorage(batch);
  const requestSizes = [];
  const result = await flushPendingCyclingUploads({
    storage: s,
    priorityRideId: batch[0].test_ride_id,
    async request(options) {
      const requestEvents = options.data.events;
      requestSizes.push(requestEvents.length);
      if (requestEvents.some((event) => event.event_type === 'finish')) {
        return {
          statusCode: 409,
          data: { detail: 'ride already has a different finish event' },
        };
      }
      return {
        statusCode: 200,
        data: {
          acked_event_ids: requestEvents.map((event) => event.event_id),
          stored: requestEvents.length,
          duplicates: 0,
        },
      };
    },
  });
  assert.deepEqual(requestSizes, [3, 2]);
  assert.equal(result.status, 'uploaded_with_quarantine');
  assert.equal(result.acked, 2);
  assert.equal(result.quarantined, 1);
  assert.equal(result.priorityRideQuarantined, true);
  assert.equal(readPendingCyclingUploadEvents(s).length, 0);
  const quarantined = readQuarantinedCyclingUploadEvents(s);
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0].event.event_type, 'finish');
  assert.equal(quarantined[0].conflict_code, 'finish_conflict');
});

test('pending storage 不可用、损坏或读取异常一律 fail closed，不发请求也不误报空队列', async () => {
  const cases = [
    {
      expected: 'unavailable',
      storage: {},
    },
    {
      expected: 'invalid',
      storage: (() => {
        const s = readyStorage(rideEvents());
        s.map.set(PENDING_CYCLING_UPLOAD_KEY, { invalid: true });
        return s;
      })(),
    },
    {
      expected: 'read_failed',
      storage: (() => {
        const s = readyStorage(rideEvents());
        const read = s.getStorageSync.bind(s);
        s.getStorageSync = (key) => {
          if (key === PENDING_CYCLING_UPLOAD_KEY) {
            throw new Error('temporary pending read failure');
          }
          return read(key);
        };
        return s;
      })(),
    },
  ];

  for (const fixture of cases) {
    let requests = 0;
    const upload = await flushPendingCyclingUploads({
      storage: fixture.storage,
      async request() {
        requests += 1;
        return { statusCode: 200, data: { acked_event_ids: [] } };
      },
    });
    assert.equal(upload.status, 'pending');
    assert.equal(upload.reason, 'storage');
    assert.equal(upload.storageStatus, fixture.expected);
    assert.equal(upload.pendingKnown, false);
    assert.equal(upload.requestCount, 0);
    assert.equal(requests, 0);
  }
});

test('上传途中 pending 读回失败覆盖 optimistic ACK，绝不误报 uploaded', async () => {
  const events = rideEvents();
  const s = readyStorage(events);
  const read = s.getStorageSync.bind(s);
  let absentPendingReads = 0;
  s.getStorageSync = (key) => {
    if (key === PENDING_CYCLING_UPLOAD_KEY
        && !s.map.has(PENDING_CYCLING_UPLOAD_KEY)) {
      absentPendingReads += 1;
      // ACK removal performs one required empty-queue readback.  Fail the
      // following loop read to model a transient host storage outage after a
      // fully parsed server response.
      if (absentPendingReads >= 2) {
        throw new Error('post-ack pending read failure');
      }
    }
    return read(key);
  };

  const upload = await flushPendingCyclingUploads({
    storage: s,
    async request(options) {
      return {
        statusCode: 200,
        data: {
          acked_event_ids: options.data.events.map((event) => event.event_id),
          stored: options.data.events.length,
          duplicates: 0,
        },
      };
    },
  });

  assert.equal(upload.acked, events.length);
  assert.equal(upload.status, 'pending');
  assert.equal(upload.reason, 'storage');
  assert.equal(upload.storageStatus, 'read_failed');
  assert.equal(upload.pendingKnown, false);
  assert.equal(upload.requestCount, 1);
});

test('ACK 删除后的单次读回异常即使随后恢复，也必须保持 storage pending', async () => {
  const events = rideEvents();
  const s = readyStorage(events);
  const read = s.getStorageSync.bind(s);
  let failedOnce = false;
  s.getStorageSync = (key) => {
    if (!failedOnce && key === PENDING_CYCLING_UPLOAD_KEY
        && !s.map.has(PENDING_CYCLING_UPLOAD_KEY)) {
      failedOnce = true;
      throw new Error('one-shot removal verification failure');
    }
    return read(key);
  };

  const upload = await flushPendingCyclingUploads({
    storage: s,
    async request(options) {
      return {
        statusCode: 200,
        data: {
          acked_event_ids: options.data.events.map((event) => event.event_id),
          stored: options.data.events.length,
          duplicates: 0,
        },
      };
    },
  });

  assert.equal(failedOnce, true);
  assert.equal(upload.acked, 0, 'unverified removal cannot count as ACK');
  assert.equal(upload.status, 'pending');
  assert.equal(upload.reason, 'storage');
  assert.equal(upload.storageStatus, 'mutation_failed');
  assert.equal(upload.pendingKnown, true, 'the final recovery read is known');
  assert.equal(upload.requestCount, 1);
});

test('ride lifecycle 冲突隔离前若队列读取失败则停止，不能把未知队列当空场次', async () => {
  const events = rideEvents();
  const s = readyStorage(events);
  const read = s.getStorageSync.bind(s);
  let rejectReturned = false;
  s.getStorageSync = (key) => {
    if (rejectReturned && key === PENDING_CYCLING_UPLOAD_KEY) {
      throw new Error('conflict-time pending read failure');
    }
    return read(key);
  };

  const upload = await flushPendingCyclingUploads({
    storage: s,
    async request() {
      rejectReturned = true;
      return {
        statusCode: 409,
        data: { detail: 'test_ride_id belongs to another lifecycle' },
      };
    },
  });

  assert.equal(upload.status, 'pending');
  assert.equal(upload.reason, 'storage');
  assert.equal(upload.storageStatus, 'read_failed');
  assert.equal(upload.quarantined, 0);
  assert.equal(upload.requestCount, 1);
  assert.equal(s.map.has(PENDING_CYCLING_UPLOAD_KEY), true);
});
