import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getWarmupRhythmTtsCue,
  getWarmupStep,
  getWarmupTtsCue,
  getWarmupViewModel,
  WARMUP_COMPLETION_TTS,
  WARMUP_OVERVIEW_COPY,
  WARMUP_STEP_COUNT,
  WARMUP_STEP_DURATION_SEC,
  WARMUP_STEPS,
  WARMUP_TOTAL_DURATION_SEC,
  WARMUP_TTS_INTRO,
} from '../lib/warmup_guide.js';

test('跑前热身固定为 4 项、15 秒一项、合计 1 分钟', () => {
  assert.equal(WARMUP_STEP_COUNT, 4);
  assert.equal(WARMUP_STEP_DURATION_SEC, 15);
  assert.equal(WARMUP_TOTAL_DURATION_SEC, 60);
  assert.equal(WARMUP_STEPS.length * WARMUP_STEP_DURATION_SEC, WARMUP_TOTAL_DURATION_SEC);
  assert.equal(Object.isFrozen(WARMUP_STEPS), true);
  for (const step of WARMUP_STEPS) {
    assert.equal(Object.isFrozen(step), true);
    assert.equal(step.durationSec, 15);
    assert.equal(step.durationLabel, '15秒');
    assert.ok(step.instruction.length <= 12, '眼镜端只保留动作要点');
    assert.ok(step.safetyNote.length <= 8, '安全提示保持简短');
    assert.match(step.ttsCue, /第[一二三四]项/);
    assert.match(step.ttsCue, /十五秒/);
  }
  assert.throws(() => WARMUP_STEPS.push({ id: 'extra' }), TypeError);
  assert.throws(() => { WARMUP_STEPS[0].title = '已改动'; }, TypeError);
});

test('跑前热身动作、简短文案与素材路径精确对应', () => {
  assert.equal(WARMUP_OVERVIEW_COPY, '4项 · 每项15秒 · 共1分钟');
  assert.deepEqual(WARMUP_STEPS.map((step) => ({
    id: step.id,
    title: step.title,
    instruction: step.instruction,
    imagePath: step.imagePath,
  })), [
    {
      id: 'march', title: '原地踏步', instruction: '抬膝踏步，手臂前后摆',
      imagePath: '../../assets/warmup/march.gif',
    },
    {
      id: 'calf_raise', title: '提踵激活', instruction: '脚跟抬起，缓慢落下',
      imagePath: '../../assets/warmup/calf-raise.gif',
    },
    {
      id: 'butt_kick', title: '后踢腿', instruction: '脚跟后收，左右交替',
      imagePath: '../../assets/warmup/butt-kick.gif',
    },
    {
      id: 'lateral_shift', title: '侧向移重心', instruction: '屈膝侧移，左右换边',
      imagePath: '../../assets/warmup/lateral-shift.gif',
    },
  ]);
});

test('跑前热身查找与视图模型严格拒绝越界值', () => {
  assert.equal(getWarmupStep(0), WARMUP_STEPS[0]);
  assert.equal(getWarmupStep(3), WARMUP_STEPS[3]);
  for (const invalid of [-1, 4, 1.5, '0', NaN, Infinity, null, undefined]) {
    assert.equal(getWarmupStep(invalid), null);
    assert.equal(getWarmupViewModel(invalid), null);
  }
  for (let index = 0; index < WARMUP_STEP_COUNT; index += 1) {
    const view = getWarmupViewModel(index);
    assert.equal(Object.isFrozen(view), true);
    assert.equal(view.index, index + 1);
    assert.equal(view.count, WARMUP_STEP_COUNT);
    assert.equal(view.buttonLabel, index === WARMUP_STEP_COUNT - 1
      ? '立即开跑' : '下一步');
  }
});

test('跑前热身 TTS 只播总览、换边和最后三秒节拍', () => {
  assert.match(WARMUP_TTS_INTRO, /四个动作/);
  assert.match(WARMUP_TTS_INTRO, /每个十五秒/);
  assert.match(WARMUP_TTS_INTRO, /一分钟/);
  assert.equal(
    getWarmupTtsCue(0, { includeIntro: true }),
    WARMUP_TTS_INTRO + WARMUP_STEPS[0].ttsCue,
  );
  assert.equal(getWarmupTtsCue(3), WARMUP_STEPS[3].ttsCue);
  assert.equal(getWarmupRhythmTtsCue(0, 7), '', '原地踏步不播换边');
  assert.equal(getWarmupRhythmTtsCue(1, 7), '', '提踵是双脚同步动作');
  assert.equal(getWarmupRhythmTtsCue(2, 7), '', '后踢腿从开始就持续交替');
  assert.equal(getWarmupRhythmTtsCue(3, 7), '换边。');
  for (const index of [0, 1, 2, 3]) assert.equal(getWarmupRhythmTtsCue(index, 8), '');
  for (let index = 0; index < WARMUP_STEP_COUNT; index += 1) {
    assert.equal(getWarmupRhythmTtsCue(index, 3), '三。二。一。');
    assert.equal(getWarmupRhythmTtsCue(index, 2), '');
  }
  assert.match(WARMUP_COMPLETION_TTS, /热身完成/);
  assert.match(WARMUP_COMPLETION_TTS, /自动开始跑步/);
  for (const invalid of [-1, 4, 1.5, '0', null, undefined]) {
    assert.equal(getWarmupTtsCue(invalid), '');
    assert.equal(getWarmupRhythmTtsCue(invalid, 7), '');
  }
});
