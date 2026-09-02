import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRecoveryRhythmTtsCue,
  getRecoveryStep,
  getRecoveryTtsCue,
  getRecoveryViewModel,
  RECOVERY_COMPLETION_TTS,
  RECOVERY_OVERVIEW_COPY,
  RECOVERY_SAFETY_NOTE,
  RECOVERY_STEP_COUNT,
  RECOVERY_STEP_DURATION_SEC,
  RECOVERY_TTS_INTRO,
  RECOVERY_TOTAL_DURATION_SEC,
  RECOVERY_STEPS,
} from '../lib/recovery_guide.js';

test('跑后恢复指导固定为 4 个深冻结步骤', () => {
  assert.equal(RECOVERY_STEP_COUNT, 4);
  assert.equal(Object.isFrozen(RECOVERY_STEPS), true);
  for (const step of RECOVERY_STEPS) {
    assert.equal(Object.isFrozen(step), true);
    assert.equal(step.safetyNote, RECOVERY_SAFETY_NOTE);
    assert.equal(step.durationSec, RECOVERY_STEP_DURATION_SEC);
    assert.equal(step.safetyNote, '疼痛就停');
    assert.ok(step.instruction.length <= 12, '眼镜端只保留动作要点');
    assert.match(step.ttsCue, /第[一二三四]项/);
    assert.match(step.ttsCue, /十五秒/);
  }
  assert.throws(() => {
    RECOVERY_STEPS.push({ id: 'extra' });
  }, TypeError);
  assert.throws(() => {
    RECOVERY_STEPS[0].title = '已改动';
  }, TypeError);
});

test('步骤文案、时长与素材占位路径精确对应', () => {
  assert.equal(RECOVERY_TOTAL_DURATION_SEC, 60);
  assert.equal(RECOVERY_STEP_DURATION_SEC, 15);
  assert.equal(RECOVERY_STEPS.every((step) => step.durationLabel.includes('15秒')), true);
  assert.equal(RECOVERY_STEPS.length * 15, RECOVERY_TOTAL_DURATION_SEC);
  assert.deepEqual(RECOVERY_STEPS.map((step) => ({
    id: step.id,
    title: step.title,
    durationLabel: step.durationLabel,
    imagePath: step.imagePath,
  })), [
    {
      id: 'walk', title: '慢走放松', durationLabel: '15秒',
      imagePath: '../../assets/recovery/walk.gif',
    },
    {
      id: 'calf', title: '小腿后侧', durationLabel: '15秒',
      imagePath: '../../assets/recovery/calf.gif',
    },
    {
      id: 'quad', title: '大腿前侧', durationLabel: '15秒',
      imagePath: '../../assets/recovery/quad.gif',
    },
    {
      id: 'hamstring', title: '大腿后侧', durationLabel: '15秒',
      imagePath: '../../assets/recovery/hamstring.gif',
    },
  ]);
  assert.deepEqual(RECOVERY_STEPS.map((step) => step.instruction), [
    '慢走，手臂自然摆动',
    '后脚跟压地，左右换边',
    '扶墙屈膝，左右换边',
    '脚尖回勾，左右换边',
  ]);
});

test('安全查找严格拒绝越界与隐式类型转换', () => {
  assert.equal(getRecoveryStep(0), RECOVERY_STEPS[0]);
  assert.equal(getRecoveryStep(3), RECOVERY_STEPS[3]);
  for (const invalid of [-1, 4, 1.5, '0', NaN, Infinity, null, undefined]) {
    assert.equal(getRecoveryStep(invalid), null);
    assert.equal(getRecoveryViewModel(invalid), null);
  }
});

test('视图模型提供一起始进度与正确导航文案', () => {
  for (let index = 0; index < RECOVERY_STEP_COUNT; index += 1) {
    const view = getRecoveryViewModel(index);
    assert.equal(Object.isFrozen(view), true);
    assert.equal(view.index, index + 1);
    assert.equal(view.count, RECOVERY_STEP_COUNT);
    assert.equal(view.buttonLabel, index === RECOVERY_STEP_COUNT - 1
      ? '完成放松'
      : '下一步');
  }
});

test('语音引导先明确四项与一分钟，再逐项播报序号、动作和时长', () => {
  assert.equal(RECOVERY_OVERVIEW_COPY, '4项 · 每项15秒 · 共1分钟');
  assert.match(RECOVERY_TTS_INTRO, /四个动作/);
  assert.match(RECOVERY_TTS_INTRO, /每个十五秒/);
  assert.match(RECOVERY_TTS_INTRO, /一分钟/);
  assert.equal(
    getRecoveryTtsCue(0, { includeIntro: true }),
    RECOVERY_TTS_INTRO + RECOVERY_STEPS[0].ttsCue,
  );
  assert.equal(getRecoveryTtsCue(3), RECOVERY_STEPS[3].ttsCue);
  for (const invalid of [-1, 4, 1.5, '0', null, undefined]) {
    assert.equal(getRecoveryTtsCue(invalid), '');
  }
});

test('恢复节奏只在换边和最后三秒提供短 TTS，不逐秒轰炸用户', () => {
  assert.equal(getRecoveryRhythmTtsCue(0, 7), '', '慢走无需换边提示');
  for (const index of [1, 2, 3]) {
    assert.match(getRecoveryRhythmTtsCue(index, 7), /换边/);
    assert.equal(getRecoveryRhythmTtsCue(index, 8), '');
  }
  for (let index = 0; index < RECOVERY_STEP_COUNT; index += 1) {
    assert.equal(getRecoveryRhythmTtsCue(index, 3), '三。二。一。');
    assert.equal(getRecoveryRhythmTtsCue(index, 2), '');
  }
  assert.match(RECOVERY_COMPLETION_TTS, /放松完成/);
  for (const invalid of [-1, 4, '1', null, undefined]) {
    assert.equal(getRecoveryRhythmTtsCue(invalid, 7), '');
  }
});
