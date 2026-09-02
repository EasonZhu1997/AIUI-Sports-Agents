import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeSnapshot, buildCoachSystemPrompt, buildCoachPersonaPrompt,
  classifyIntent, fallbackCoachReply, nextProactiveCue, sanitizeCoachReply,
} from '../lib/coach.js';

const FULL = {
  bpm: 158, zone: 4, paceSecPerKm: 330, cadenceSpm: 178,
  distanceM: 5230, elapsedMs: 1800000, paused: false,
  heartRateMaxHrBpm: 190, heartRatePolicySource: 'user_explicit',
};
const TRUSTED = { heartRateMaxHrBpm: 190, heartRatePolicySource: 'user_explicit' };

test('summarizeSnapshot：全字段拼成一行，配速用 M:SS/km', () => {
  const s = summarizeSnapshot(FULL);
  assert.match(s, /心率 158\(Z4\)/);
  assert.match(s, /配速 5:30\/km/);
  assert.match(s, /步频 178/);
  assert.match(s, /距离 5\.23km/);
  assert.match(s, /时长 30:00/);
});

test('summarizeSnapshot：空/非法输入返回占位而非 NaN', () => {
  assert.equal(summarizeSnapshot(null), '暂无运动数据');
  assert.equal(summarizeSnapshot({}), '暂无运动数据');
  assert.equal(summarizeSnapshot({ bpm: 0, paceSecPerKm: 0 }), '暂无运动数据');
  // 慢于 30:00/km 的配速被 formatPace 拒绝 → 不进串
  assert.equal(summarizeSnapshot({ paceSecPerKm: 5000 }), '暂无运动数据');
});

test('summarizeSnapshot：暂停态附加标记', () => {
  assert.match(summarizeSnapshot({ distanceM: 1000, paused: true }), /已暂停/);
});

test('buildCoachSystemPrompt：含人设 + 实时数据 + 医疗免责', () => {
  const p = buildCoachSystemPrompt(FULL);
  assert.match(p, /AI 跑步教练/);
  assert.match(p, /不给医疗建议/);
  assert.match(p, /当前实时数据：/);
  assert.match(p, /配速 5:30\/km/);
});

test('classifyIntent：配速/心率/距离/时间/通用', () => {
  assert.equal(classifyIntent('我配速怎么样'), 'pace');
  assert.equal(classifyIntent('能再快点吗'), 'pace');
  assert.equal(classifyIntent('我现在该加速吗'), 'pace');
  assert.equal(classifyIntent('心率高不高'), 'hr');
  assert.equal(classifyIntent('还有多远'), 'distance');
  assert.equal(classifyIntent('跑了多久了'), 'time');
  assert.equal(classifyIntent('今天天气真好'), 'general');
});

test('fallbackCoachReply：Z5 安全优先，覆盖任何问题意图', () => {
  const r = fallbackCoachReply({ zone: 5, paceSecPerKm: 300, ...TRUSTED }, '我能再快点吗');
  assert.match(r, /Z5/);
  assert.match(r, /降|慢|呼吸/);
});

test('fallbackCoachReply：配速问题引用真实配速', () => {
  assert.match(fallbackCoachReply(FULL, '配速如何'), /5:30/);
  assert.equal(
    fallbackCoachReply({ zone: 2 }, '我快吗').includes('两分钟'),
    true, '无配速数据时给引导而非编造',
  );
});

test('fallbackCoachReply：心率问题——有数据报读，无数据不暗示必须连蓝牙', () => {
  assert.match(fallbackCoachReply(FULL, '心率多少'), /158/);
  const noHr = fallbackCoachReply({ zone: 0 }, '心率呢');
  assert.match(noHr, /无心率数据/);
  assert.doesNotMatch(noHr, /胸带|手表|广播|蓝牙/);
});

test('fallbackCoachReply：距离/时间问题', () => {
  assert.match(fallbackCoachReply(FULL, '跑多远了'), /5\.23 公里/);
  assert.match(fallbackCoachReply(FULL, '跑了多久'), /30:00/);
});

test('fallbackCoachReply：通用问题按心率区间给鼓励，绝不返回空串', () => {
  assert.ok(fallbackCoachReply({ zone: 4 }, '加油').length > 0);
  assert.match(fallbackCoachReply({ zone: 1 }, '嗯'), /轻松|提速|稳/);
  assert.match(fallbackCoachReply({}, ''), /先稳跑/);
  assert.match(fallbackCoachReply({ elapsedMs: 20000 }, '随便鼓励一句'), /先稳跑/);
  assert.match(fallbackCoachReply({ cadenceSpm: 172 }, '随便鼓励一句'), /保持稳定/);
});

test('缺失或估算最大心率时不建议提速，只保留中性描述与偏高降速', () => {
  assert.doesNotMatch(fallbackCoachReply({ bpm: 130, zone: 1 }, '嗯'), /提速|加速/);
  assert.doesNotMatch(fallbackCoachReply({
    bpm: 130,
    zone: 2,
    heartRateMaxHrBpm: 190,
    heartRatePolicySource: 'age_estimate',
  }, '嗯'), /提速|加速/);
  assert.match(fallbackCoachReply({ bpm: 170 }, '我能加速吗'), /降速/);
});

test('nextProactiveCue：进 Z5 安全降速优先，且盖过整公里里程碑', () => {
  const cue = nextProactiveCue(
    { zone: 3, distanceM: 990, ...TRUSTED },
    { zone: 5, distanceM: 1010, paceSecPerKm: 300, ...TRUSTED },
  );
  assert.match(cue, /Z5/);
  assert.match(cue, /降|呼吸/);
});

test('nextProactiveCue：跨整公里 → 里程碑播报(带配速)', () => {
  const cue = nextProactiveCue({ zone: 3, distanceM: 990 }, { zone: 3, distanceM: 1010, paceSecPerKm: 330 });
  assert.match(cue, /第 1 公里/);
  assert.match(cue, /5:30/);
});

test('nextProactiveCue：跨 5 分钟 → 播新鲜心率与可信配速，不播步频', () => {
  const cue = nextProactiveCue(
    { elapsedMs: 299000, distanceM: 800 },
    { elapsedMs: 301000, distanceM: 850, bpm: 158,
      cadenceSpm: 176, paceSecPerKm: 330 },
  );
  assert.match(cue, /心率158/);
  assert.match(cue, /配速5:30/);
  assert.doesNotMatch(cue, /步频|176/);
  assert.ok(cue.length <= 15, `周期数值播报需 ≤15 字: ${cue}`);
  assert.equal(
    nextProactiveCue(
      { elapsedMs: 599000, distanceM: 1200 },
      { elapsedMs: 601000, distanceM: 1210, cadenceSpm: 176 },
    ),
    '10分钟了，保持节奏。',
  );
});

test('nextProactiveCue：刚进 Z4 → 提醒；无事件 → null', () => {
  assert.match(nextProactiveCue({ zone: 2, ...TRUSTED }, { zone: 4, ...TRUSTED }), /Z4/);
  assert.equal(nextProactiveCue({ zone: 3, distanceM: 1500, elapsedMs: 120000 },
                                { zone: 3, distanceM: 1550, elapsedMs: 122000 }), null);
  assert.equal(nextProactiveCue(null, null), null);
});

test('nextProactiveCue：持续停留 Z5 → 每满 1 分钟重复安全提醒(边沿一次不够)', () => {
  // 同一分钟内:不重复
  assert.equal(nextProactiveCue({ zone: 5, elapsedMs: 610000, distanceM: 1500, ...TRUSTED },
                                { zone: 5, elapsedMs: 615000, distanceM: 1520, ...TRUSTED }), null);
  // 跨分钟边界:重复提醒,且盖过里程碑
  const cue = nextProactiveCue({ zone: 5, elapsedMs: 659000, distanceM: 1990, ...TRUSTED },
                               { zone: 5, elapsedMs: 661000, distanceM: 2010, ...TRUSTED });
  assert.match(cue, /Z5/);
  assert.ok(cue.length <= 15, `Z5 持续提醒需 ≤15 字: ${cue}`);
});

test('buildCoachPersonaPrompt：只含人设约束,不含实时数据(每轮注入,防冻结)', () => {
  const p = buildCoachPersonaPrompt();
  assert.match(p, /AI 跑步教练/);
  assert.match(p, /不给医疗建议/);
  assert.match(p, /15个汉字/);
  assert.match(p, /用户明确设置或 Garmin 档案/);
  assert.match(p, /缺失策略只能中性描述/);
  assert.doesNotMatch(p, /当前实时数据/);
});

test('sanitizeCoachReply：LLM 输出后置消毒——markdown/换行/超长的确定性防线', () => {
  // 正常短句原样通过
  assert.equal(sanitizeCoachReply('配速稳住，呼吸放松。'), '配速稳住，呼吸放松。');
  // markdown 标记与换行清掉
  assert.equal(sanitizeCoachReply('**建议**：\n- 降速\n- 深呼吸'), '建议 ： 降速 深呼吸');
  // 代码块整体丢弃
  assert.doesNotMatch(sanitizeCoachReply('好的```const x=1```保持节奏。'), /const/);
  // 超长截到句读,不整段上屏挤爆 64px 气泡
  const long = '现在你的配速是每公里五分三十秒，心率一百五十八，建议你保持当前节奏并注意摆臂放松，落地轻一点，眼睛看前方。';
  const cut = sanitizeCoachReply(long);
  assert.ok(cut.length <= 42, `超长必须截断: ${cut.length}`);
  assert.match(cut, /[。，,.!！]$/);
  // 空/纯符号 → ''(调用方走规则兜底)
  assert.equal(sanitizeCoachReply(''), '');
  assert.equal(sanitizeCoachReply('###\n\n***'), '');
});
