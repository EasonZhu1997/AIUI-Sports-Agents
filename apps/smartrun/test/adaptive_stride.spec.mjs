import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_STRIDE_VERSION,
  AdaptiveStrideModel,
  CADENCE_BUCKET,
  cadenceBucketFor,
  effectiveImuStepLengthM,
} from '../lib/adaptive_stride.js';

function trustedWindow(overrides = {}) {
  return {
    cadenceSpm: 160,
    steps: 48,
    distanceM: 48,
    durationMs: 18000,
    source: 'rsc_total_distance',
    trusted: true,
    qualityScore: 1,
    ...overrides,
  };
}

test('按步频分桶；无可信样本时所有桶都回退人工步长', () => {
  const model = new AdaptiveStrideModel({ manualStepLengthM: 0.82 });
  assert.equal(cadenceBucketFor(149), CADENCE_BUCKET.SLOW);
  assert.equal(cadenceBucketFor(150), CADENCE_BUCKET.NORMAL);
  assert.equal(cadenceBucketFor(179), CADENCE_BUCKET.NORMAL);
  assert.equal(cadenceBucketFor(180), CADENCE_BUCKET.FAST);
  assert.equal(cadenceBucketFor(0), null);

  for (const cadence of [140, 165, 190, NaN]) {
    const estimate = model.estimate(cadence);
    assert.equal(estimate.stepLengthM, 0.82);
    assert.equal(estimate.confidence, 0);
    assert.equal(estimate.learned, false);
    assert.equal(estimate.source, 'manual');
  }
});

test('纯 IMU 按步频约束人工步长，可信个性化成熟后才允许越过上限', () => {
  assert.equal(effectiveImuStepLengthM(1.25, 0), 0.70);
  assert.equal(effectiveImuStepLengthM(1.25, 80), 0.70);
  assert.equal(effectiveImuStepLengthM(1.25, 119), 0.78);
  assert.equal(effectiveImuStepLengthM(1.25, 145), 0.90);
  assert.equal(effectiveImuStepLengthM(1.25, 170), 1.05);
  assert.equal(effectiveImuStepLengthM(1.25, 190), 1.20);
  assert.equal(effectiveImuStepLengthM(0.65, 80), 0.65);

  const immature = {
    stepLengthM: 1.08,
    confidence: 0.4,
    learned: true,
  };
  assert.equal(effectiveImuStepLengthM(1.25, 119, immature), 0.78);
  const mature = {
    stepLengthM: 0.92,
    confidence: 0.7,
    learned: true,
  };
  assert.equal(effectiveImuStepLengthM(1.25, 119, mature), 0.92);
});

test('RSC 可信窗口只学习对应桶，EMA 与置信度逐步改变而不跳变', () => {
  const model = new AdaptiveStrideModel({ manualStepLengthM: 0.8 });
  const first = model.observeWindow(trustedWindow({
    cadenceSpm: 160,
    steps: 48,
    distanceM: 49.92,
  }));
  assert.equal(first.accepted, true);
  assert.equal(first.bucket, CADENCE_BUCKET.NORMAL);
  assert.ok(first.boundedSampleM <= 1.04, '单次样本被最大更新跨度限制');

  const normal = model.estimate(160);
  assert.ok(normal.stepLengthM > 0.8);
  assert.ok(normal.stepLengthM < 1.04);
  assert.ok(normal.confidence > 0);
  assert.equal(normal.sampleCount, 1);
  assert.equal(normal.source, 'rsc');
  assert.equal(model.estimate(140).stepLengthM, 0.8);
  assert.equal(model.estimate(190).stepLengthM, 0.8);

  for (let index = 0; index < 8; index += 1) {
    model.observeWindow(trustedWindow({
      cadenceSpm: 160,
      steps: 48,
      distanceM: 49.92,
    }));
  }
  const mature = model.estimate(160);
  assert.ok(mature.confidence > normal.confidence);
  assert.ok(mature.stepLengthM > normal.stepLengthM);
  assert.ok(mature.stepLengthM < 1.04);
});

test('缺少显式质量门、来源不可信、窗口太短或步频不一致均拒绝学习', () => {
  const model = new AdaptiveStrideModel({ manualStepLengthM: 0.85 });
  assert.equal(
    model.observeWindow(trustedWindow({ trusted: false })).reason,
    'quality_gate_failed',
  );
  assert.equal(
    model.observeWindow(trustedWindow({ source: 'heart_rate' })).reason,
    'source_untrusted',
  );
  assert.equal(
    model.observeWindow(trustedWindow({ steps: 5, distanceM: 5 })).reason,
    'window_too_short',
  );
  assert.equal(
    model.observeWindow(trustedWindow({ durationMs: 60000 })).reason,
    'cadence_mismatch',
  );
  assert.equal(model.estimate(160).stepLengthM, 0.85);
  assert.equal(model.estimate(160).sampleCount, 0);
});

test('步长边界与 GPS 精度提供第二层防御', () => {
  const model = new AdaptiveStrideModel({ manualStepLengthM: 0.85 });
  assert.equal(
    model.observeWindow(trustedWindow({
      steps: 48,
      distanceM: 120,
    })).reason,
    'stride_out_of_bounds',
  );
  assert.equal(
    model.observeWindow(trustedWindow({
      source: 'gps_path',
      steps: 48,
      distanceM: 48,
      gpsAccuracyM: 30,
    })).reason,
    'gps_accuracy_low',
  );
  assert.equal(model.estimate(160).stepLengthM, 0.85);
});

test('GPS 必须两个一致窗口才学习，单个或互相冲突窗口不污染模型', () => {
  const model = new AdaptiveStrideModel({ manualStepLengthM: 0.8 });
  const first = model.observeWindow(trustedWindow({
    source: 'gps_path',
    steps: 48,
    distanceM: 49.92,
    gpsAccuracyM: 5,
  }));
  assert.equal(first.accepted, false);
  assert.equal(first.pending, true);
  assert.equal(first.reason, 'gps_confirmation_pending');
  assert.equal(model.estimate(160).stepLengthM, 0.8);

  const conflicting = model.observeWindow(trustedWindow({
    source: 'gps_path',
    steps: 48,
    distanceM: 40,
    gpsAccuracyM: 5,
  }));
  assert.equal(conflicting.accepted, false);
  assert.equal(conflicting.reason, 'gps_confirmation_replaced');
  assert.equal(model.estimate(160).stepLengthM, 0.8);

  const confirmed = model.observeWindow(trustedWindow({
    source: 'gps_path',
    steps: 48,
    distanceM: 41,
    gpsAccuracyM: 4,
  }));
  assert.equal(confirmed.accepted, true);
  assert.equal(confirmed.estimate.source, 'gps');
  assert.ok(model.estimate(160).stepLengthM > 0.8);
  assert.ok(model.estimate(160).stepLengthM < 0.9);
});

test('稳健历史拒绝偏离中位数的异常窗口', () => {
  const model = new AdaptiveStrideModel({ manualStepLengthM: 0.85 });
  for (const distanceM of [47.5, 48, 48.5]) {
    const result = model.observeWindow(trustedWindow({ distanceM }));
    assert.equal(result.accepted, true);
  }
  const before = model.estimate(160);
  const outlier = model.observeWindow(trustedWindow({ distanceM: 72 }));
  assert.equal(outlier.accepted, false);
  assert.equal(outlier.reason, 'stride_outlier');
  assert.deepEqual(model.estimate(160), before);
});

test('慢跑、常规跑、快跑三个模型互相独立', () => {
  const model = new AdaptiveStrideModel({ manualStepLengthM: 0.8 });
  model.observeWindow(trustedWindow({
    cadenceSpm: 140,
    steps: 42,
    durationMs: 18000,
    distanceM: 37.8,
  }));
  model.observeWindow(trustedWindow({
    cadenceSpm: 160,
    steps: 48,
    durationMs: 18000,
    distanceM: 48,
  }));
  model.observeWindow(trustedWindow({
    cadenceSpm: 190,
    steps: 57,
    durationMs: 18000,
    distanceM: 59.28,
  }));

  const slow = model.estimate(140);
  const normal = model.estimate(160);
  const fast = model.estimate(190);
  assert.ok(slow.stepLengthM < normal.stepLengthM);
  assert.ok(normal.stepLengthM < fast.stepLengthM);
  assert.equal(slow.bucket, CADENCE_BUCKET.SLOW);
  assert.equal(normal.bucket, CADENCE_BUCKET.NORMAL);
  assert.equal(fast.bucket, CADENCE_BUCKET.FAST);
});

test('serialize/restore 保留派生模型与 owner marker，且不包含坐标', () => {
  const model = new AdaptiveStrideModel({
    manualStepLengthM: 0.82,
    ownerMarker: 'epoch-7:namespace-A',
  });
  model.observeWindow(trustedWindow());
  const serialized = model.serialize();
  const serializedText = JSON.stringify(serialized);
  assert.equal(serialized.version, ADAPTIVE_STRIDE_VERSION);
  assert.equal(serialized.ownerMarker, 'epoch-7:namespace-A');
  assert.equal(/latitude|longitude|coordinate|track|position/i.test(serializedText), false);

  const restored = AdaptiveStrideModel.restore(serializedText, {
    ownerMarker: 'epoch-7:namespace-A',
  });
  assert.equal(restored.restoreStatus, 'restored');
  assert.deepEqual(restored.estimate(160), model.estimate(160));
});

test('owner marker 变化时不继承旧用户学习结果', () => {
  const oldModel = new AdaptiveStrideModel({
    manualStepLengthM: 0.8,
    ownerMarker: 'owner-A',
  });
  oldModel.observeWindow(trustedWindow({ distanceM: 49.92 }));
  assert.ok(oldModel.estimate(160).confidence > 0);

  const fresh = AdaptiveStrideModel.restore(oldModel.serialize(), {
    ownerMarker: 'owner-B',
    manualStepLengthM: 0.9,
  });
  assert.equal(fresh.restoreStatus, 'fresh_owner_mismatch');
  assert.equal(fresh.estimate(160).stepLengthM, 0.9);
  assert.equal(fresh.estimate(160).confidence, 0);
});

test('损坏 JSON、未知版本和损坏桶都安全回退人工先验', () => {
  const options = { manualStepLengthM: 0.88, ownerMarker: 'owner-A' };
  const badJson = AdaptiveStrideModel.restore('{not-json', options);
  assert.equal(badJson.restoreStatus, 'fresh_invalid');
  assert.equal(badJson.estimate(160).stepLengthM, 0.88);

  const wrongVersion = AdaptiveStrideModel.restore({
    version: 999,
    ownerMarker: 'owner-A',
  }, options);
  assert.equal(wrongVersion.restoreStatus, 'fresh_version_mismatch');
  assert.equal(wrongVersion.estimate(160).confidence, 0);

  const model = new AdaptiveStrideModel(options);
  model.observeWindow(trustedWindow());
  const corrupt = model.serialize();
  corrupt.bins.normal.emaM = 99;
  const restored = AdaptiveStrideModel.restore(corrupt, options);
  assert.equal(restored.restoreStatus, 'fresh_invalid');
  assert.equal(restored.estimate(160).stepLengthM, 0.88);
  assert.equal(restored.estimate(160).confidence, 0);
});

test('v2 不继承旧步长模型，并拒绝明显远离人工先验的漂移窗口', () => {
  const options = { manualStepLengthM: 0.8, ownerMarker: 'owner-A' };
  const oldPayload = {
    version: 1,
    ownerMarker: 'owner-A',
    manualStepLengthM: 0.8,
    bins: {},
  };
  const migrated = AdaptiveStrideModel.restore(oldPayload, options);
  assert.equal(migrated.restoreStatus, 'fresh_version_mismatch');
  assert.equal(migrated.estimate(160).stepLengthM, 0.8);

  const rejected = migrated.observeWindow(trustedWindow({
    distanceM: 57.6,
  }));
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'personalization_out_of_bounds');
  assert.equal(migrated.estimate(160).confidence, 0);
});

test('个人化输出始终限制在人工步长附近', () => {
  const model = new AdaptiveStrideModel({
    manualStepLengthM: 0.8,
    maxPersonalizationDeltaM: 0.24,
  });
  for (let index = 0; index < 30; index += 1) {
    const result = model.observeWindow(trustedWindow({
      distanceM: 49.92,
    }));
    assert.equal(result.accepted, true);
  }
  const estimate = model.estimate(160);
  assert.ok(estimate.stepLengthM > 0.8);
  assert.ok(estimate.stepLengthM <= 1.04);
});

test('v2 恢复时拒绝落在人工先验范围外的污染派生值', () => {
  const model = new AdaptiveStrideModel({
    manualStepLengthM: 0.8,
    ownerMarker: 'owner-A',
  });
  model.observeWindow(trustedWindow({ distanceM: 48 }));
  const payload = model.serialize();
  payload.bins.normal.emaM = 1.2;
  payload.bins.normal.recentM = [1.2];

  const restored = AdaptiveStrideModel.restore(payload, {
    manualStepLengthM: 0.8,
    ownerMarker: 'owner-A',
  });
  assert.equal(restored.restoreStatus, 'fresh_invalid');
  assert.equal(restored.estimate(160).stepLengthM, 0.8);
  assert.equal(restored.estimate(160).confidence, 0);
});

test('恢复时允许使用新的人工步长先验，但保留可信派生样本', () => {
  const model = new AdaptiveStrideModel({
    manualStepLengthM: 0.8,
    ownerMarker: 'owner-A',
  });
  model.observeWindow(trustedWindow({ distanceM: 49.92 }));
  const restored = AdaptiveStrideModel.restore(model.serialize(), {
    ownerMarker: 'owner-A',
    manualStepLengthM: 0.9,
  });
  assert.equal(restored.restoreStatus, 'restored');
  assert.equal(restored.manualStepLengthM, 0.9);
  assert.ok(restored.estimate(160).confidence > 0);
  assert.notEqual(restored.estimate(160).stepLengthM, 0.9);
});
