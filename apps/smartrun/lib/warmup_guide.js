// One-minute pre-run warm-up shown after the user finishes the optional heart-
// rate setup and before the run starts. Keep this module free of page/runtime
// dependencies so the same contract drives AIX and preview tests.

export const WARMUP_OVERVIEW_COPY = '4项 · 每项15秒 · 共1分钟';
export const WARMUP_TTS_INTRO = '跑前热身共四个动作，每个十五秒，合计一分钟。';
export const WARMUP_COMPLETION_TTS = '热身完成，自动开始跑步。';
export const WARMUP_TOTAL_DURATION_SEC = 60;
export const WARMUP_STEP_DURATION_SEC = 15;

function warmupStep({
  id,
  title,
  instruction,
  safetyNote,
  imagePath,
  ttsCue,
  midpointCue = '',
}) {
  return Object.freeze({
    id,
    title,
    durationSec: WARMUP_STEP_DURATION_SEC,
    durationLabel: '15秒',
    instruction,
    safetyNote,
    imagePath,
    ttsCue,
    midpointCue,
  });
}

export const WARMUP_STEPS = Object.freeze([
  warmupStep({
    id: 'march',
    title: '原地踏步',
    instruction: '抬膝踏步，手臂前后摆',
    safetyNote: '身体保持直立',
    imagePath: '../../assets/warmup/march.gif',
    ttsCue: '第一项，原地踏步，十五秒。',
  }),
  warmupStep({
    id: 'calf_raise',
    title: '提踵激活',
    instruction: '脚跟抬起，缓慢落下',
    safetyNote: '膝盖保持放松',
    imagePath: '../../assets/warmup/calf-raise.gif',
    ttsCue: '第二项，提踵激活，十五秒。',
  }),
  warmupStep({
    id: 'butt_kick',
    title: '后踢腿',
    instruction: '脚跟后收，左右交替',
    safetyNote: '上身保持直立',
    imagePath: '../../assets/warmup/butt-kick.gif',
    ttsCue: '第三项，后踢腿，左右交替十五秒。',
  }),
  warmupStep({
    id: 'lateral_shift',
    title: '侧向移重心',
    instruction: '屈膝侧移，左右换边',
    safetyNote: '膝盖对准脚尖',
    imagePath: '../../assets/warmup/lateral-shift.gif',
    ttsCue: '第四项，侧向移重心，左右换边十五秒。',
    midpointCue: '换边。',
  }),
]);

export const WARMUP_STEP_COUNT = WARMUP_STEPS.length;

export function getWarmupStep(index) {
  if (!Number.isInteger(index) || index < 0 || index >= WARMUP_STEP_COUNT) return null;
  return WARMUP_STEPS[index];
}

export function getWarmupViewModel(index) {
  const step = getWarmupStep(index);
  if (!step) return null;
  return Object.freeze({
    ...step,
    index: index + 1,
    count: WARMUP_STEP_COUNT,
    buttonLabel: index === WARMUP_STEP_COUNT - 1 ? '立即开跑' : '下一步',
  });
}

export function getWarmupTtsCue(index, options = {}) {
  const step = getWarmupStep(index);
  if (!step) return '';
  return options.includeIntro === true
    ? WARMUP_TTS_INTRO + step.ttsCue
    : step.ttsCue;
}

export function getWarmupRhythmTtsCue(index, remainingSec) {
  const step = getWarmupStep(index);
  if (!step || !Number.isInteger(remainingSec)) return '';
  if (remainingSec === 3) return '三。二。一。';
  if (remainingSec === 7) return step.midpointCue;
  return '';
}
