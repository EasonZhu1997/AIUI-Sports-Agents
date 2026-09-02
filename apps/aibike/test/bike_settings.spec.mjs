import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BIKE_SETTINGS_KEY,
  DEFAULT_BIKE_SETTINGS,
  formatCadenceTone,
  formatFtp,
  formatHudSkin,
  formatMaxHeartRate,
  formatRideGoal,
  formatWheelCircumference,
  isBikeSettingsPersisted,
  nextCadenceToneRpm,
  nextFtpW,
  nextHudSkin,
  nextMaxHeartRateBpm,
  nextRideGoal,
  nextWheelCircumferenceMm,
  normalizeBikeSettings,
  readBikeSettings,
  writeBikeSettings,
} from '../lib/bike_settings.js';

function memoryStorage() {
  const values = new Map();
  return {
    getStorageSync(key) { return values.get(key); },
    setStorageSync(key, value) { values.set(key, value); },
  };
}

test('bike settings normalize invalid values without inventing a wheel profile', () => {
  assert.deepEqual(normalizeBikeSettings({
    wheelCircumferenceMm: 9999,
    cadenceToneRpm: 180,
    maxHeartRateBpm: 260,
    maxHeartRateExplicit: 'yes',
    ftpW: 999,
    rideGoal: 'race',
    hudSkin: 'rainbow',
    autoHeartRate: false,
    voiceCue: false,
    autoPause: false,
  }), {
    wheelCircumferenceMm: DEFAULT_BIKE_SETTINGS.wheelCircumferenceMm,
    imuMetersPerCrank: DEFAULT_BIKE_SETTINGS.imuMetersPerCrank,
    cadenceToneRpm: DEFAULT_BIKE_SETTINGS.cadenceToneRpm,
    maxHeartRateBpm: DEFAULT_BIKE_SETTINGS.maxHeartRateBpm,
    maxHeartRateExplicit: false,
    ftpW: DEFAULT_BIKE_SETTINGS.ftpW,
    rideGoal: DEFAULT_BIKE_SETTINGS.rideGoal,
    hudSkin: DEFAULT_BIKE_SETTINGS.hudSkin,
    autoHeartRate: false,
    voiceCue: false,
    autoPause: false,
    networkSyncEnabled: false,
    networkBaseUrl: '',
  });
});

test('public network settings require explicit opt-in and a normalized HTTPS base', () => {
  assert.equal(normalizeBikeSettings({
    networkSyncEnabled: true,
    networkBaseUrl: 'http://example.test',
  }).networkBaseUrl, '');
  assert.deepEqual(normalizeBikeSettings({
    networkSyncEnabled: true,
    networkBaseUrl: ' https://example.test/base/ ',
  }), {
    ...DEFAULT_BIKE_SETTINGS,
    networkSyncEnabled: true,
    networkBaseUrl: 'https://example.test/base',
  });
});

test('bike settings cycle wheel and cadence presets', () => {
  assert.equal(nextWheelCircumferenceMm(2105), 2136);
  assert.equal(nextWheelCircumferenceMm(2298), 2070);
  assert.equal(nextCadenceToneRpm(0), 80);
  assert.equal(nextCadenceToneRpm(100), 0);
  assert.equal(nextMaxHeartRateBpm(190), 200);
  assert.equal(nextMaxHeartRateBpm(200), 160);
  assert.equal(nextFtpW(0), 150);
  assert.equal(nextFtpW(300), 0);
  assert.equal(nextRideGoal('free'), 'recovery');
  assert.equal(nextRideGoal('endurance'), 'free');
  assert.equal(nextHudSkin('aero'), 'atelier');
  assert.equal(nextHudSkin('noir'), 'aero');
  assert.equal(formatWheelCircumference(2105), '2105 mm');
  assert.equal(formatCadenceTone(90), '90 RPM');
  assert.equal(formatCadenceTone(0), '关闭');
  assert.equal(formatMaxHeartRate(180), '180 bpm');
  assert.equal(formatFtp(250), '250 W');
  assert.equal(formatFtp(0), '未设置');
  assert.equal(formatRideGoal('recovery'), '恢复骑');
  assert.equal(formatHudSkin('aero'), '破风带');
  assert.equal(formatHudSkin('atelier'), '数字高定');
  assert.equal(formatHudSkin('tempo'), '节拍线');
  assert.equal(formatHudSkin('horizon'), '零域');
  assert.equal(formatHudSkin('noir'), '静奢');
});

test('bike settings persist with a read-back verification', () => {
  const storage = memoryStorage();
  const value = writeBikeSettings(storage, {
    ...DEFAULT_BIKE_SETTINGS,
    cadenceToneRpm: 90,
  });
  assert.deepEqual(storage.getStorageSync(BIKE_SETTINGS_KEY), value);
  assert.deepEqual(readBikeSettings(storage), value);
  assert.equal(isBikeSettingsPersisted(storage, value), true);
});
