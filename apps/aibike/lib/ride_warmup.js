// Deterministic pre/post ride guides for the 480x352 glasses route.
// The public snapshot uses text and programmatic line placeholders, while
// preserving independent order, copy, timing and TTS semantics.

export const RIDE_GUIDE_KIND = Object.freeze({
  WARMUP: 'warmup',
  RECOVERY: 'recovery',
});

export const RIDE_WARMUP_OVERVIEW_COPY = '4项 · 每项20秒 · 共80秒';
export const RIDE_WARMUP_TTS_INTRO = '骑前拉伸共四个动作，每个二十秒，合计八十秒。';
export const RIDE_WARMUP_COMPLETION_TTS = '骑前拉伸完成，进入骑行准备。';
export const RIDE_WARMUP_STEP_SECONDS = 20;

export const RIDE_RECOVERY_OVERVIEW_COPY = '4项 · 每项15秒 · 共1分钟';
export const RIDE_RECOVERY_TTS_INTRO = '骑后放松共四个动作，每个十五秒，合计一分钟。';
export const RIDE_RECOVERY_COMPLETION_TTS = '骑后放松完成，可以按确认键退出。';
export const RIDE_RECOVERY_STEP_SECONDS = 15;
export const RIDE_RECOVERY_SAFETY_NOTE = '疼痛就停';

function guideStep({
  id,
  title,
  instruction,
  safetyNote,
  durationSec,
  imagePath,
  ttsCue,
  midpointCue = '',
}) {
  return Object.freeze({
    id,
    title,
    instruction,
    safetyNote,
    durationSec,
    durationLabel: String(durationSec) + '秒',
    imagePath,
    ttsCue,
    midpointCue,
    // Backward-compatible aliases used by the existing Bike page/tests.
    figure: id,
    safety: safetyNote,
    seconds: durationSec,
    asset: imagePath,
  });
}

export const RIDE_WARMUP_STEPS = Object.freeze([
  guideStep({
    id: 'chest',
    title: '肩胸打开',
    instruction: '双手身后轻握，肩胛向后收',
    safetyNote: '肩颈保持放松',
    durationSec: RIDE_WARMUP_STEP_SECONDS,
    imagePath: '',
    ttsCue: '第一项，肩胸打开，二十秒。',
  }),
  guideStep({
    id: 'hip',
    title: '髋屈肌伸展',
    instruction: '前后弓步，骨盆轻轻前推',
    safetyNote: '前膝对准脚尖',
    durationSec: RIDE_WARMUP_STEP_SECONDS,
    imagePath: '',
    ttsCue: '第二项，髋屈肌伸展，左右交替二十秒。',
    midpointCue: '换边。',
  }),
  guideStep({
    id: 'quad',
    title: '股四头肌拉伸',
    instruction: '扶稳车身，脚跟靠近臀部',
    safetyNote: '腰背不要后仰',
    durationSec: RIDE_WARMUP_STEP_SECONDS,
    imagePath: '',
    ttsCue: '第三项，股四头肌拉伸，左右交替二十秒。',
    midpointCue: '换边。',
  }),
  guideStep({
    id: 'calf',
    title: '小腿与脚踝',
    instruction: '扶车伸直前腿，脚尖轻轻回勾',
    safetyNote: '先停稳自行车',
    durationSec: RIDE_WARMUP_STEP_SECONDS,
    imagePath: '',
    ttsCue: '第四项，小腿与脚踝拉伸，左右交替二十秒。',
    midpointCue: '换边。',
  }),
]);

export const RIDE_RECOVERY_STEPS = Object.freeze([
  guideStep({
    id: 'calf_release',
    title: '小腿放松',
    instruction: '扶车伸直前腿，脚尖轻轻回勾',
    safetyNote: RIDE_RECOVERY_SAFETY_NOTE,
    durationSec: RIDE_RECOVERY_STEP_SECONDS,
    imagePath: '',
    ttsCue: '第一项，小腿放松，左右交替十五秒。',
    midpointCue: '换边。',
  }),
  guideStep({
    id: 'quad_release',
    title: '大腿前侧',
    instruction: '扶稳车身，脚跟靠近臀部',
    safetyNote: RIDE_RECOVERY_SAFETY_NOTE,
    durationSec: RIDE_RECOVERY_STEP_SECONDS,
    imagePath: '',
    ttsCue: '第二项，大腿前侧放松，左右交替十五秒。',
    midpointCue: '换边。',
  }),
  guideStep({
    id: 'hip_release',
    title: '髋部放松',
    instruction: '前后弓步，骨盆轻轻前推',
    safetyNote: RIDE_RECOVERY_SAFETY_NOTE,
    durationSec: RIDE_RECOVERY_STEP_SECONDS,
    imagePath: '',
    ttsCue: '第三项，髋部放松，左右交替十五秒。',
    midpointCue: '换边。',
  }),
  guideStep({
    id: 'chest_release',
    title: '肩胸舒展',
    instruction: '肩胛向后收，缓慢自然呼吸',
    safetyNote: RIDE_RECOVERY_SAFETY_NOTE,
    durationSec: RIDE_RECOVERY_STEP_SECONDS,
    imagePath: '',
    ttsCue: '第四项，肩胸舒展，十五秒。',
  }),
]);

export const RIDE_WARMUP_TOTAL_SECONDS = RIDE_WARMUP_STEPS.reduce(
  (total, step) => total + step.durationSec,
  0,
);
export const RIDE_RECOVERY_TOTAL_SECONDS = RIDE_RECOVERY_STEPS.reduce(
  (total, step) => total + step.durationSec,
  0,
);

export function normalizeRideWarmupStepIndex(index) {
  const value = Number(index);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(RIDE_WARMUP_STEPS.length - 1, Math.floor(value)));
}

export function getRideWarmupStep(index) {
  return RIDE_WARMUP_STEPS[normalizeRideWarmupStepIndex(index)];
}

export function getRideGuideSteps(kind) {
  return kind === RIDE_GUIDE_KIND.RECOVERY
    ? RIDE_RECOVERY_STEPS : RIDE_WARMUP_STEPS;
}

export function getRideGuideStep(kind, index) {
  const steps = getRideGuideSteps(kind);
  if (!Number.isInteger(index) || index < 0 || index >= steps.length) return null;
  return steps[index];
}

export function getRideGuideOverview(kind) {
  return kind === RIDE_GUIDE_KIND.RECOVERY
    ? RIDE_RECOVERY_OVERVIEW_COPY : RIDE_WARMUP_OVERVIEW_COPY;
}

export function getRideGuideTtsCue(kind, index, options = {}) {
  const step = getRideGuideStep(kind, index);
  if (!step) return '';
  const intro = kind === RIDE_GUIDE_KIND.RECOVERY
    ? RIDE_RECOVERY_TTS_INTRO : RIDE_WARMUP_TTS_INTRO;
  return options.includeIntro === true ? intro + step.ttsCue : step.ttsCue;
}

export function getRideGuideRhythmTtsCue(kind, index, remainingSec) {
  const step = getRideGuideStep(kind, index);
  if (!step || !Number.isInteger(remainingSec)) return '';
  if (remainingSec === 3) return '三。二。一。';
  if (remainingSec === Math.floor(step.durationSec / 2)) return step.midpointCue;
  return '';
}

export function warmupSecondsRemaining(step, remainingMs) {
  const duration = Number(step && (step.durationSec || step.seconds));
  const fallback = Number.isFinite(duration) && duration > 0 ? duration : 20;
  const ms = Number(remainingMs);
  if (!Number.isFinite(ms)) return fallback;
  return Math.max(0, Math.min(fallback, Math.ceil(ms / 1000)));
}
