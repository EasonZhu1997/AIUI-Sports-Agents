// Static post-run recovery guidance for the AIUI summary flow.
//
// Keep this module free of page/runtime dependencies so the same immutable
// steps can be rendered by the Chinese AIX page and verified in Node tests.

export const RECOVERY_SAFETY_NOTE = '疼痛就停';

// Keep the plan count audible as well as visible. The first recovery cue joins
// this overview with step one so AIUI only has to enqueue one utterance and
// cannot overlap two back-to-back TTS requests on entry.
export const RECOVERY_OVERVIEW_COPY = '4项 · 每项15秒 · 共1分钟';
export const RECOVERY_TTS_INTRO = '放松共四个动作，每个十五秒，合计一分钟。';
export const RECOVERY_COMPLETION_TTS = '放松完成。请选择查看跑步总结，或结束退出。';

// The compact cooldown is intentionally one minute: four simple 15-second
// steps are readable on the 480×352 glasses canvas and easy to follow.
export const RECOVERY_TOTAL_DURATION_SEC = 60;
export const RECOVERY_STEP_DURATION_SEC = 15;

function recoveryStep({ id, title, durationLabel, instruction, imagePath, ttsCue }) {
  return Object.freeze({
    id,
    title,
    durationSec: RECOVERY_STEP_DURATION_SEC,
    durationLabel,
    instruction,
    safetyNote: RECOVERY_SAFETY_NOTE,
    imagePath,
    ttsCue,
  });
}

export const RECOVERY_STEPS = Object.freeze([
  recoveryStep({
    id: 'walk',
    title: '慢走放松',
    durationLabel: '15秒',
    instruction: '慢走，手臂自然摆动',
    imagePath: '../../assets/recovery/walk.gif',
    ttsCue: '第一项，慢走放松，十五秒。',
  }),
  recoveryStep({
    id: 'calf',
    title: '小腿后侧',
    durationLabel: '15秒',
    instruction: '后脚跟压地，左右换边',
    imagePath: '../../assets/recovery/calf.gif',
    ttsCue: '第二项，小腿后侧拉伸，左右交替十五秒。',
  }),
  recoveryStep({
    id: 'quad',
    title: '大腿前侧',
    durationLabel: '15秒',
    instruction: '扶墙屈膝，左右换边',
    imagePath: '../../assets/recovery/quad.gif',
    ttsCue: '第三项，大腿前侧拉伸，左右交替十五秒。',
  }),
  recoveryStep({
    id: 'hamstring',
    title: '大腿后侧',
    durationLabel: '15秒',
    instruction: '脚尖回勾，左右换边',
    imagePath: '../../assets/recovery/hamstring.gif',
    ttsCue: '第四项，大腿后侧拉伸，左右交替十五秒。',
  }),
]);

export const RECOVERY_STEP_COUNT = RECOVERY_STEPS.length;

// `index` is zero-based for controller state. Invalid or coerced values are
// rejected rather than silently selecting the wrong instruction.
export function getRecoveryStep(index) {
  if (!Number.isInteger(index) || index < 0 || index >= RECOVERY_STEP_COUNT) {
    return null;
  }
  return RECOVERY_STEPS[index];
}

// The rendered `index` is one-based so the page can display `1 / 4` directly.
export function getRecoveryViewModel(index) {
  const step = getRecoveryStep(index);
  if (!step) return null;
  return Object.freeze({
    ...step,
    index: index + 1,
    count: RECOVERY_STEP_COUNT,
    buttonLabel: index === RECOVERY_STEP_COUNT - 1 ? '完成放松' : '下一步',
  });
}

export function getRecoveryTtsCue(index, options = {}) {
  const step = getRecoveryStep(index);
  if (!step) return '';
  return options.includeIntro === true
    ? RECOVERY_TTS_INTRO + step.ttsCue
    : step.ttsCue;
}

// Stretching does not need a continuous metronome. Two short, deterministic
// cues are enough to keep the user oriented without flooding AIUI's TTS bridge:
// bilateral stretches change side near the midpoint, and the final count uses
// full stops plus a slower Web Speech rate so it remains one non-overlapping cue.
export function getRecoveryRhythmTtsCue(index, remainingSec) {
  const step = getRecoveryStep(index);
  if (!step || !Number.isInteger(remainingSec)) return '';
  if (remainingSec === 3) return '三。二。一。';
  if (index > 0 && remainingSec === 7) return '换边。';
  return '';
}
