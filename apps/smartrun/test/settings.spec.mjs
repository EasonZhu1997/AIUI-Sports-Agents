import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RUN_SETTINGS,
  METRONOME_BPM_OPTIONS,
  RUN_SETTINGS_KEY,
  SLOW_JOG_TARGET_OPTIONS_MIN,
  formatMetronomeBpm,
  formatSlowJogTarget,
  formatStrideM,
  formatSwitch,
  isRunSettingsPersisted,
  nextMetronomeBpm,
  nextSlowJogTargetMin,
  nextStrideM,
  normalizeRunSettings,
  readRunSettings,
  writeRunSettings,
} from '../lib/settings.js';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getStorageSync(key) { return map.get(key); },
    setStorageSync(key, value) { map.set(key, value); },
    removeStorageSync(key) { map.delete(key); },
  };
}

test('normalizeRunSettings keeps configurable values and forces AI summary plus memory on', () => {
  assert.deepEqual(normalizeRunSettings({
    strideM: 0.9,
    autoHeartRate: false,
    voiceCue: false,
    memoryContext: false,
    slowJogTargetMin: 30,
    metronomeBpm: 170,
    guideQuickExit: true,
    aiSummary: false,
  }), {
    strideM: 0.9,
    autoHeartRate: false,
    voiceCue: false,
    memoryContext: true,
    slowJogTargetMin: 30,
    metronomeBpm: 170,
    guideQuickExit: true,
    aiSummary: true,
  });

  assert.deepEqual(normalizeRunSettings({
    strideM: 9,
    autoHeartRate: 'yes',
    voiceCue: 1,
    memoryContext: null,
  }), DEFAULT_RUN_SETTINGS);
});

test('readRunSettings and writeRunSettings roundtrip through storage', () => {
  const storage = fakeStorage();
  const saved = writeRunSettings(storage, {
    strideM: 0.75,
    autoHeartRate: false,
    voiceCue: true,
    memoryContext: false,
    slowJogTargetMin: 10,
    metronomeBpm: 160,
    guideQuickExit: true,
    aiSummary: false,
  });
  assert.deepEqual(saved, {
    strideM: 0.75,
    autoHeartRate: false,
    voiceCue: true,
    memoryContext: true,
    slowJogTargetMin: 10,
    metronomeBpm: 160,
    guideQuickExit: true,
    aiSummary: true,
  });
  assert.deepEqual(readRunSettings(storage), saved);
  assert.equal(isRunSettingsPersisted(storage, saved), true);
});

test('readRunSettings falls back to defaults when storage is missing or invalid', () => {
  assert.deepEqual(readRunSettings(null), DEFAULT_RUN_SETTINGS);
  const storage = fakeStorage({ [RUN_SETTINGS_KEY]: { strideM: 'bad' } });
  assert.deepEqual(readRunSettings(storage), DEFAULT_RUN_SETTINGS);
  assert.equal(isRunSettingsPersisted(null, DEFAULT_RUN_SETTINGS), false);
  assert.equal(isRunSettingsPersisted(storage, DEFAULT_RUN_SETTINGS), true,
    '旧/损坏字段经规范化后仍可与当前默认值比较');
});

test('storage write failure is reported as not persisted without breaking settings', () => {
  const broken = {
    setStorageSync() { throw new Error('unavailable'); },
    getStorageSync() { return undefined; },
  };
  const saved = writeRunSettings(broken, { memoryContext: false });
  assert.equal(saved.memoryContext, true);
  assert.equal(isRunSettingsPersisted(broken, saved), false);
});

test('settings labels stay compact for glasses UI', () => {
  assert.equal(DEFAULT_RUN_SETTINGS.metronomeBpm, 0, '新安装默认关闭节拍器');
  assert.equal(DEFAULT_RUN_SETTINGS.guideQuickExit, false, '新安装默认禁用指导快速结束');
  assert.equal(formatStrideM(0.8), '0.80m');
  assert.equal(formatSwitch(true), '开');
  assert.equal(formatSwitch(false), '关');
  assert.equal(nextStrideM(0.85), 0.95);
  assert.equal(nextStrideM(1.0), 1.05);
  assert.equal(nextStrideM(1.45), 0.55);
  assert.deepEqual(SLOW_JOG_TARGET_OPTIONS_MIN, [10, 20, 30, 0]);
  assert.deepEqual(METRONOME_BPM_OPTIONS, [0, 160, 170, 180]);
  assert.equal(formatSlowJogTarget(20), '20 分钟');
  assert.equal(formatSlowJogTarget(0), '不限时');
  assert.equal(nextSlowJogTargetMin(30), 0);
  assert.equal(nextSlowJogTargetMin(0), 10);
  assert.equal(formatMetronomeBpm(180), '180 BPM');
  assert.equal(formatMetronomeBpm(0), '关闭');
  assert.equal(nextMetronomeBpm(180), 0);
  assert.equal(nextMetronomeBpm(0), 160);
});
