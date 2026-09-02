export const GUIDE_STEP_DURATION_SEC = 15;
export const GUIDE_TOTAL_DURATION_SEC = 60;

export const WARMUP_STEPS = Object.freeze([
  Object.freeze({
    id: 'warmup-short-slide',
    title: '短滑轨腿驱',
    instruction: '坐稳脚踏，短行程向后推腿',
    safety: '低阻慢动，膝盖朝向脚尖',
    cue: '第一项，短滑轨腿驱，十五秒。',
  }),
  Object.freeze({
    id: 'warmup-body-swing',
    title: '躯干摆动',
    instruction: '腿保持伸展，髋部小幅前后摆',
    safety: '背部自然，不含胸猛甩',
    cue: '第二项，躯干摆动，十五秒。',
  }),
  Object.freeze({
    id: 'warmup-arm-draw',
    title: '手臂回拉',
    instruction: '躯干稳定，手柄轻拉向下肋',
    safety: '肩颈放松，手腕保持平直',
    cue: '第三项，手臂回拉，十五秒。',
  }),
  Object.freeze({
    id: 'warmup-full-stroke',
    title: '慢速完整划',
    instruction: '腿、躯干、手臂依次发力',
    safety: '低阻慢划，周围保持安全',
    cue: '第四项，慢速完整划，十五秒。',
  }),
]);

export const RECOVERY_STEPS = Object.freeze([
  Object.freeze({
    id: 'recovery-easy-row',
    title: '低桨频缓划',
    instruction: '降低阻力，放长回桨节奏',
    safety: '呼吸平稳，不要突然停下',
    cue: '第一项，低桨频缓划，十五秒。',
  }),
  Object.freeze({
    id: 'recovery-upper-back',
    title: '肩背放松',
    instruction: '手柄归位，站到平地双臂前伸',
    safety: '机器停稳后再离开滑座',
    cue: '第二项，肩背放松，十五秒。',
  }),
  Object.freeze({
    id: 'recovery-hamstring',
    title: '大腿后侧',
    instruction: '站在平地，一脚跟前伸并折髋',
    safety: '不要踩滑轨或移动滑座',
    cue: '第三项，大腿后侧放松，十五秒。',
  }),
  Object.freeze({
    id: 'recovery-hip-flexor',
    title: '髋前侧放松',
    instruction: '站在平地，前后分腿轻柔下沉',
    safety: '不扶手柄，保持身体稳定',
    cue: '第四项，髋前侧放松，十五秒。',
  }),
]);

export function guideStep(steps, index) {
  return Number.isInteger(index) && index >= 0 && index < steps.length
    ? { ...steps[index], index: index + 1, count: steps.length } : null;
}
