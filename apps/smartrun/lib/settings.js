export const RUN_SETTINGS_KEY = 'run_settings';

// 这里实际表示“每次落步前进的单步长度”，不是左右脚合计的一整步幅。
// 旧范围 0.70–1.00m 会把 180spm 的最快可表示配速锁死在 5'33"/km；
// 扩大范围后既覆盖小步慢跑，也覆盖高个跑者的大步幅，仍由 0.5–1.5m 归一化门保护。
export const STRIDE_OPTIONS_M = Object.freeze([
  0.55, 0.65, 0.75, 0.85, 0.95, 1.05, 1.15, 1.25, 1.35, 1.45,
]);
export const SLOW_JOG_TARGET_OPTIONS_MIN = Object.freeze([10, 20, 30, 0]);
export const METRONOME_BPM_OPTIONS = Object.freeze([0, 160, 170, 180]);

export const DEFAULT_RUN_SETTINGS = Object.freeze({
  strideM: 0.85,
  autoHeartRate: true,
  voiceCue: true,
  memoryContext: true,
  slowJogTargetMin: 20,
  // 节拍声必须由用户在设置页明确开启；新安装默认静音。
  metronomeBpm: 0,
  // 指导页快速结束是显式选项，默认关闭以避免误触。
  guideQuickExit: false,
  aiSummary: true,
});

function round2(value) {
  return Math.round(value * 100) / 100;
}

function normalizeStride(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.5 || n > 1.5) return DEFAULT_RUN_SETTINGS.strideM;
  return round2(n);
}

function normalizeOption(value, options, fallback) {
  const n = Number(value);
  return options.includes(n) ? n : fallback;
}

export function normalizeRunSettings(value) {
  const src = value && typeof value === 'object' ? value : {};
  return {
    strideM: normalizeStride(src.strideM),
    autoHeartRate: typeof src.autoHeartRate === 'boolean'
      ? src.autoHeartRate : DEFAULT_RUN_SETTINGS.autoHeartRate,
    voiceCue: typeof src.voiceCue === 'boolean'
      ? src.voiceCue : DEFAULT_RUN_SETTINGS.voiceCue,
    // 跑后总结与长期记忆是 SmartRun 的固定能力，不再暴露为用户开关。
    // 旧版本若曾持久化 false，也在下一次 read -> write 时迁移为 true。
    memoryContext: true,
    slowJogTargetMin: normalizeOption(
      src.slowJogTargetMin,
      SLOW_JOG_TARGET_OPTIONS_MIN,
      DEFAULT_RUN_SETTINGS.slowJogTargetMin,
    ),
    metronomeBpm: normalizeOption(
      src.metronomeBpm,
      METRONOME_BPM_OPTIONS,
      DEFAULT_RUN_SETTINGS.metronomeBpm,
    ),
    guideQuickExit: typeof src.guideQuickExit === 'boolean'
      ? src.guideQuickExit : DEFAULT_RUN_SETTINGS.guideQuickExit,
    aiSummary: true,
  };
}

export function readRunSettings(storage) {
  if (!storage || typeof storage.getStorageSync !== 'function') return { ...DEFAULT_RUN_SETTINGS };
  try {
    return normalizeRunSettings(storage.getStorageSync(RUN_SETTINGS_KEY));
  } catch (_e) {
    return { ...DEFAULT_RUN_SETTINGS };
  }
}

export function writeRunSettings(storage, settings) {
  const normalized = normalizeRunSettings(settings);
  if (!storage || typeof storage.setStorageSync !== 'function') return normalized;
  try {
    storage.setStorageSync(RUN_SETTINGS_KEY, normalized);
  } catch (_e) {}
  return normalized;
}

/** 新版 AIUI storage 写后读校验：页面可诚实显示“已保存/仅本次”。 */
export function isRunSettingsPersisted(storage, settings) {
  if (!storage || typeof storage.getStorageSync !== 'function') return false;
  try {
    const raw = storage.getStorageSync(RUN_SETTINGS_KEY);
    if (!raw || typeof raw !== 'object') return false;
    return JSON.stringify(normalizeRunSettings(raw))
      === JSON.stringify(normalizeRunSettings(settings));
  } catch (_e) {
    return false;
  }
}

export function nextStrideM(value) {
  const stride = normalizeStride(value);
  let bestIndex = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < STRIDE_OPTIONS_M.length; i += 1) {
    const delta = Math.abs(STRIDE_OPTIONS_M[i] - stride);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = i;
    }
  }
  return STRIDE_OPTIONS_M[(bestIndex + 1) % STRIDE_OPTIONS_M.length];
}

export function formatStrideM(value) {
  return `${normalizeStride(value).toFixed(2)}m`;
}

export function formatSwitch(value) {
  return value ? '开' : '关';
}

export function nextSlowJogTargetMin(value) {
  const current = normalizeOption(
    value,
    SLOW_JOG_TARGET_OPTIONS_MIN,
    DEFAULT_RUN_SETTINGS.slowJogTargetMin,
  );
  const index = SLOW_JOG_TARGET_OPTIONS_MIN.indexOf(current);
  return SLOW_JOG_TARGET_OPTIONS_MIN[(index + 1) % SLOW_JOG_TARGET_OPTIONS_MIN.length];
}

export function formatSlowJogTarget(value) {
  const target = normalizeOption(
    value,
    SLOW_JOG_TARGET_OPTIONS_MIN,
    DEFAULT_RUN_SETTINGS.slowJogTargetMin,
  );
  return target > 0 ? `${target} 分钟` : '不限时';
}

export function nextMetronomeBpm(value) {
  const current = normalizeOption(
    value,
    METRONOME_BPM_OPTIONS,
    DEFAULT_RUN_SETTINGS.metronomeBpm,
  );
  const index = METRONOME_BPM_OPTIONS.indexOf(current);
  return METRONOME_BPM_OPTIONS[(index + 1) % METRONOME_BPM_OPTIONS.length];
}

export function formatMetronomeBpm(value) {
  const bpm = normalizeOption(
    value,
    METRONOME_BPM_OPTIONS,
    DEFAULT_RUN_SETTINGS.metronomeBpm,
  );
  return bpm > 0 ? `${bpm} BPM` : '关闭';
}
