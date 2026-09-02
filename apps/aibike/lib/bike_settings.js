import {
  DEFAULT_IMU_METERS_PER_CRANK,
} from './cycling_imu_speed.js';
import { normalizeHttpsBaseUrl } from './network_policy.js';

export const BIKE_SETTINGS_KEY = 'aibike_settings_v1';

// Common measured tyre circumferences in millimetres. Riders can cycle through
// the presets on the glasses; a paired FTMS trainer that supplies distance does
// not depend on this value.
export const WHEEL_CIRCUMFERENCE_OPTIONS_MM = Object.freeze([
  2070, // 700×23C
  2105, // 700×25C
  2136, // 700×28C
  2298, // 29×2.2
]);

export const CADENCE_TONE_OPTIONS_RPM = Object.freeze([0, 80, 90, 100]);
export const MAX_HEART_RATE_OPTIONS_BPM = Object.freeze([160, 170, 180, 190, 200]);
export const FTP_OPTIONS_W = Object.freeze([0, 150, 200, 250, 300]);
export const RIDE_GOAL_OPTIONS = Object.freeze([
  'free',
  'recovery',
  'endurance',
]);
export const HUD_SKIN_OPTIONS = Object.freeze([
  'aero',
  'atelier',
  'tempo',
  'horizon',
  'noir',
]);

export const DEFAULT_BIKE_SETTINGS = Object.freeze({
  wheelCircumferenceMm: 2105,
  // 无外设固定挡位估算的“每曲柄圈前进距离”。它只用于明确标记的
  // IMU 估算值；3.2m/圈对应保守中低挡，真实 CSC/CPS/FTMS 数据始终优先。
  imuMetersPerCrank: DEFAULT_IMU_METERS_PER_CRANK,
  autoHeartRate: true,
  maxHeartRateBpm: 190,
  // 只有用户在设置中明确确认过最大心率，训练计划才能用相对区间给出
  // 强度与高心率提醒；默认值只用于普通 HUD 点阵显示。
  maxHeartRateExplicit: false,
  ftpW: 0,
  rideGoal: 'free',
  voiceCue: true,
  cadenceToneRpm: 0,
  hudSkin: 'aero',
  autoPause: true,
  // Public builds are offline unless both fields are deliberately configured.
  networkSyncEnabled: false,
  networkBaseUrl: '',
});

function normalizeOption(value, options, fallback) {
  const numeric = Number(value);
  return options.includes(numeric) ? numeric : fallback;
}

function normalizeStringOption(value, options, fallback) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return options.includes(normalized) ? normalized : fallback;
}

export function normalizeBikeSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    wheelCircumferenceMm: normalizeOption(
      source.wheelCircumferenceMm,
      WHEEL_CIRCUMFERENCE_OPTIONS_MM,
      DEFAULT_BIKE_SETTINGS.wheelCircumferenceMm,
    ),
    // 该字段从未暴露为用户设置。始终迁移到当前保守模型，避免旧安装里
    // 持久化的 5.5m/圈继续把轻松踩踏显示成约 30km/h。
    imuMetersPerCrank: DEFAULT_BIKE_SETTINGS.imuMetersPerCrank,
    autoHeartRate: typeof source.autoHeartRate === 'boolean'
      ? source.autoHeartRate : DEFAULT_BIKE_SETTINGS.autoHeartRate,
    maxHeartRateBpm: normalizeOption(
      source.maxHeartRateBpm,
      MAX_HEART_RATE_OPTIONS_BPM,
      DEFAULT_BIKE_SETTINGS.maxHeartRateBpm,
    ),
    maxHeartRateExplicit: source.maxHeartRateExplicit === true,
    ftpW: normalizeOption(
      source.ftpW,
      FTP_OPTIONS_W,
      DEFAULT_BIKE_SETTINGS.ftpW,
    ),
    rideGoal: normalizeStringOption(
      source.rideGoal,
      RIDE_GOAL_OPTIONS,
      DEFAULT_BIKE_SETTINGS.rideGoal,
    ),
    voiceCue: typeof source.voiceCue === 'boolean'
      ? source.voiceCue : DEFAULT_BIKE_SETTINGS.voiceCue,
    cadenceToneRpm: normalizeOption(
      source.cadenceToneRpm,
      CADENCE_TONE_OPTIONS_RPM,
      DEFAULT_BIKE_SETTINGS.cadenceToneRpm,
    ),
    hudSkin: normalizeStringOption(
      source.hudSkin,
      HUD_SKIN_OPTIONS,
      DEFAULT_BIKE_SETTINGS.hudSkin,
    ),
    autoPause: typeof source.autoPause === 'boolean'
      ? source.autoPause : DEFAULT_BIKE_SETTINGS.autoPause,
    networkSyncEnabled: source.networkSyncEnabled === true,
    networkBaseUrl: normalizeHttpsBaseUrl(source.networkBaseUrl),
  };
}

export function readBikeSettings(storage) {
  if (!storage || typeof storage.getStorageSync !== 'function') {
    return { ...DEFAULT_BIKE_SETTINGS };
  }
  try {
    return normalizeBikeSettings(storage.getStorageSync(BIKE_SETTINGS_KEY));
  } catch (_error) {
    return { ...DEFAULT_BIKE_SETTINGS };
  }
}

export function writeBikeSettings(storage, settings) {
  const normalized = normalizeBikeSettings(settings);
  if (!storage || typeof storage.setStorageSync !== 'function') return normalized;
  try {
    storage.setStorageSync(BIKE_SETTINGS_KEY, normalized);
  } catch (_error) {}
  return normalized;
}

export function isBikeSettingsPersisted(storage, settings) {
  if (!storage || typeof storage.getStorageSync !== 'function') return false;
  try {
    const stored = storage.getStorageSync(BIKE_SETTINGS_KEY);
    if (!stored || typeof stored !== 'object') return false;
    return JSON.stringify(normalizeBikeSettings(stored))
      === JSON.stringify(normalizeBikeSettings(settings));
  } catch (_error) {
    return false;
  }
}

function nextOption(value, options, fallback) {
  const current = normalizeOption(value, options, fallback);
  const index = options.indexOf(current);
  return options[(index + 1) % options.length];
}

export function nextWheelCircumferenceMm(value) {
  return nextOption(
    value,
    WHEEL_CIRCUMFERENCE_OPTIONS_MM,
    DEFAULT_BIKE_SETTINGS.wheelCircumferenceMm,
  );
}

export function nextCadenceToneRpm(value) {
  return nextOption(
    value,
    CADENCE_TONE_OPTIONS_RPM,
    DEFAULT_BIKE_SETTINGS.cadenceToneRpm,
  );
}

export function nextMaxHeartRateBpm(value) {
  return nextOption(
    value,
    MAX_HEART_RATE_OPTIONS_BPM,
    DEFAULT_BIKE_SETTINGS.maxHeartRateBpm,
  );
}

export function nextFtpW(value) {
  return nextOption(
    value,
    FTP_OPTIONS_W,
    DEFAULT_BIKE_SETTINGS.ftpW,
  );
}

export function nextRideGoal(value) {
  const current = normalizeStringOption(
    value,
    RIDE_GOAL_OPTIONS,
    DEFAULT_BIKE_SETTINGS.rideGoal,
  );
  const index = RIDE_GOAL_OPTIONS.indexOf(current);
  return RIDE_GOAL_OPTIONS[(index + 1) % RIDE_GOAL_OPTIONS.length];
}

export function nextHudSkin(value) {
  const current = normalizeStringOption(
    value,
    HUD_SKIN_OPTIONS,
    DEFAULT_BIKE_SETTINGS.hudSkin,
  );
  const index = HUD_SKIN_OPTIONS.indexOf(current);
  return HUD_SKIN_OPTIONS[(index + 1) % HUD_SKIN_OPTIONS.length];
}

export function formatWheelCircumference(value) {
  const normalized = normalizeOption(
    value,
    WHEEL_CIRCUMFERENCE_OPTIONS_MM,
    DEFAULT_BIKE_SETTINGS.wheelCircumferenceMm,
  );
  return `${normalized} mm`;
}

export function formatCadenceTone(value) {
  const normalized = normalizeOption(
    value,
    CADENCE_TONE_OPTIONS_RPM,
    DEFAULT_BIKE_SETTINGS.cadenceToneRpm,
  );
  return normalized > 0 ? `${normalized} RPM` : '关闭';
}

export function formatMaxHeartRate(value) {
  const normalized = normalizeOption(
    value,
    MAX_HEART_RATE_OPTIONS_BPM,
    DEFAULT_BIKE_SETTINGS.maxHeartRateBpm,
  );
  return `${normalized} bpm`;
}

export function formatFtp(value) {
  const normalized = normalizeOption(
    value,
    FTP_OPTIONS_W,
    DEFAULT_BIKE_SETTINGS.ftpW,
  );
  return normalized > 0 ? `${normalized} W` : '未设置';
}

export function formatRideGoal(value) {
  const normalized = normalizeStringOption(
    value,
    RIDE_GOAL_OPTIONS,
    DEFAULT_BIKE_SETTINGS.rideGoal,
  );
  if (normalized === 'recovery') return '恢复骑';
  if (normalized === 'endurance') return '耐力骑';
  return '自由骑';
}

export function formatHudSkin(value) {
  const normalized = normalizeStringOption(
    value,
    HUD_SKIN_OPTIONS,
    DEFAULT_BIKE_SETTINGS.hudSkin,
  );
  if (normalized === 'atelier') return '数字高定';
  if (normalized === 'tempo') return '节拍线';
  if (normalized === 'horizon') return '零域';
  if (normalized === 'noir') return '静奢';
  return '破风带';
}

export function formatSwitch(value) {
  return value ? '开' : '关';
}
