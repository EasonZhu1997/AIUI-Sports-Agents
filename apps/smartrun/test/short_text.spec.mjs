// 眼镜话术长度审计:跑步时用户没时间听长句 —— 所有兜底回复与主动提示
// 必须 ≤15 个汉字(含数字/标点的总码点放宽到 18)。新增话术忘了控长会在这里红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackCoachReply, nextProactiveCue } from '../lib/coach.js';

const MAX_CODEPOINTS = 18;   // ≈15 汉字 + 数字/标点余量
const TRUSTED = { heartRateMaxHrBpm: 190, heartRatePolicySource: 'user_explicit' };

function assertShort(text, label) {
  assert.ok(typeof text === 'string' && text.length > 0, `${label}: 空回复`);
  const n = [...text].length;
  assert.ok(n <= MAX_CODEPOINTS, `${label}: ${n} 码点超长 → "${text}"`);
}

test('fallbackCoachReply：全意图 × 有/无数据 × 各区间，全部 ≤15 字', () => {
  const snaps = [
    { bpm: 156, zone: 4, paceSecPerKm: 342, cadenceSpm: 178, distanceM: 3200, elapsedMs: 1140000 },
    { bpm: 184, zone: 5, paceSecPerKm: 300, distanceM: 9800, elapsedMs: 3000000 },
    { bpm: 121, zone: 1, paceSecPerKm: 432, distanceM: 900, elapsedMs: 300000 },
    { zone: 0 },   // 无数据
    {},
    null,
  ];
  const questions = ['配速怎么样', '心率高吗', '跑多远了', '跑了多久', '加油', ''];
  for (const s of snaps) {
    for (const q of questions) {
      assertShort(fallbackCoachReply(s, q), `fallback(${JSON.stringify(s)}, ${q})`);
    }
  }
});

test('nextProactiveCue：四类主动提示全部 ≤15 字', () => {
  const cues = [
    nextProactiveCue({ zone: 3, ...TRUSTED }, { zone: 5, ...TRUSTED }),                 // Z5 安全
    nextProactiveCue({ zone: 5, elapsedMs: 659000, ...TRUSTED },
      { zone: 5, elapsedMs: 661000, ...TRUSTED }),                                     // Z5 持续每分钟
    nextProactiveCue({ distanceM: 990 }, { distanceM: 1010, paceSecPerKm: 330 }),       // 整公里+配速
    nextProactiveCue({ distanceM: 11990 }, { distanceM: 12010 }),                       // 整公里无配速(两位数)
    nextProactiveCue({ elapsedMs: 299000 }, { elapsedMs: 301000, cadenceSpm: 176 }),    // 5 分钟+步频
    nextProactiveCue({ elapsedMs: 1499000 }, { elapsedMs: 1501000 }),                   // 25 分钟无步频
    nextProactiveCue({ zone: 2, ...TRUSTED }, { zone: 4, ...TRUSTED }),                 // 进 Z4
  ];
  for (const c of cues) assertShort(c, `cue: ${c}`);
});
