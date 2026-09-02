// Deterministic, local training presets expressed through the same strict
// schema-v2 contract as server-issued workouts. Every stage completes by time;
// heart-rate ranges are coaching hints only and never execution gates.

import {
  normalizeWorkoutOwner,
  normalizeWorkoutPlan,
  WORKOUT_SCHEMA_VERSION,
} from './workout_contract.js';

export const TRAINING_PRESET_IDS = Object.freeze([
  'easy',
  'long',
  'fartlek',
  'interval',
]);

// Local presets are generated on the user's explicit selection, so they only
// need a short execution window. Keep them inside the same 36-hour freshness
// ceiling enforced for every executable schema-v2 plan.
const PRESET_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DATE_MS = 8_640_000_000_000_000;

function target(durationSec, heartZoneMin, heartZoneMax) {
  return {
    duration_sec: durationSec,
    distance_m: null,
    pace_min_sec_per_km: null,
    pace_max_sec_per_km: null,
    heart_zone_min: heartZoneMin,
    heart_zone_max: heartZoneMax,
    cadence_min_spm: null,
    cadence_max_spm: null,
  };
}

function stage(type, title, durationSec, heartZoneMin, heartZoneMax) {
  return {
    type,
    title,
    ...target(durationSec, heartZoneMin, heartZoneMax),
  };
}

function alternatingStages(repetitions, work, recovery) {
  const stages = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    stages.push(stage(
      'work',
      '第' + repetition + '组·' + work.title,
      work.durationSec,
      work.heartZoneMin,
      work.heartZoneMax,
    ));
    stages.push(stage(
      'recovery',
      '第' + repetition + '组·' + recovery.title,
      recovery.durationSec,
      recovery.heartZoneMin,
      recovery.heartZoneMax,
    ));
  }
  return stages;
}

const PRESETS = Object.freeze({
  easy: Object.freeze({
    type: 'easy',
    title: '轻松跑',
    heartZoneMin: 1,
    heartZoneMax: 3,
    stages: Object.freeze([
      stage('warmup', '热身慢走', 5 * 60, 1, 2),
      stage('work', '轻松跑·可完整交谈', 20 * 60, 2, 3),
      stage('cooldown', '放松慢走', 5 * 60, 1, 2),
    ]),
  }),
  long: Object.freeze({
    type: 'long',
    title: 'LSD长距离跑',
    heartZoneMin: 1,
    heartZoneMax: 3,
    stages: Object.freeze([
      stage('warmup', '热身慢走', 5 * 60, 1, 2),
      stage('work', '长距离慢跑·保持交谈', 40 * 60, 2, 3),
      stage('cooldown', '放松慢走', 5 * 60, 1, 2),
    ]),
  }),
  fartlek: Object.freeze({
    // “法特莱克”是用户可见模板名；跨端 canonical workout type 仍为
    // interval，避免本地处方引入 Hermes/Android 不认识的第十种类型。
    type: 'interval',
    title: '法特莱克跑',
    heartZoneMin: 1,
    heartZoneMax: 4,
    stages: Object.freeze([
      stage('warmup', '热身慢跑', 8 * 60, 1, 2),
      ...alternatingStages(
        6,
        { title: '轻快跑·可说短句', durationSec: 60, heartZoneMin: 3, heartZoneMax: 4 },
        { title: '轻松恢复·放慢呼吸', durationSec: 2 * 60, heartZoneMin: 1, heartZoneMax: 2 },
      ),
      stage('cooldown', '放松慢走', 5 * 60, 1, 2),
    ]),
  }),
  interval: Object.freeze({
    type: 'interval',
    title: '间歇跑',
    heartZoneMin: 1,
    heartZoneMax: 4,
    stages: Object.freeze([
      stage('warmup', '热身慢跑', 10 * 60, 1, 2),
      ...alternatingStages(
        4,
        { title: '较快跑·保持动作稳定', durationSec: 2 * 60, heartZoneMin: 4, heartZoneMax: 4 },
        { title: '慢跑恢复·恢复呼吸', durationSec: 2 * 60, heartZoneMin: 1, heartZoneMax: 2 },
      ),
      stage('cooldown', '放松慢走', 8 * 60, 1, 2),
    ]),
  }),
});

function hash32(text, seed = 0x811c9dc5) {
  let hash = seed;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function canonicalHexId(prefix, text) {
  const body = [
    hash32(text, 0x811c9dc5),
    hash32(text, 0x9e3779b9),
    hash32(text, 0x85ebca6b),
  ].map((value) => value.toString(16).padStart(8, '0')).join('');
  return prefix + body;
}

function canonicalPlanId(text) {
  // 19 decimal digits, always positive and below 9e18. This matches the
  // Hermes/Android plan locator grammar without relying on BigInt support in
  // older AIUI hosts.
  const high = 100_000_000 + (hash32('plan:high:' + text) % 800_000_000);
  const low = String(hash32('plan:low:' + text)).padStart(10, '0');
  return 'plan_' + String(high) + low;
}

function scheduledDate(nowMs) {
  const iso = new Date(nowMs).toISOString();
  return iso.slice(0, 10);
}

function withIds(stages, invocationSource) {
  return stages.map((value, order) => ({
    stage_id: canonicalHexId('stg_', 'stage:' + invocationSource + ':' + order),
    order,
    ...value,
  }));
}

export function buildTrainingPreset(presetId, owner, nowMs = Date.now()) {
  const preset = PRESETS[presetId];
  const normalizedOwner = normalizeWorkoutOwner(owner);
  if (!preset || !normalizedOwner || !Number.isInteger(nowMs)
      || nowMs < 0 || nowMs > MAX_DATE_MS - PRESET_TTL_MS) return null;

  const invocationSource = [
    presetId,
    normalizedOwner.ownershipEpoch,
    normalizedOwner.dataNamespace,
    normalizedOwner.publicDeviceId,
    nowMs,
  ].join(':');
  const durationSec = preset.stages.reduce((sum, value) => sum + value.duration_sec, 0);
  const rawPlan = {
    schema_version: WORKOUT_SCHEMA_VERSION,
    workout_id: canonicalHexId('wrk_', 'workout:' + invocationSource),
    plan_id: canonicalPlanId(invocationSource),
    plan_session_id: canonicalHexId('ps_', 'session:' + invocationSource),
    revision: 1,
    type: preset.type,
    title: preset.title,
    scheduled_date: scheduledDate(nowMs),
    status: 'accepted',
    target: target(durationSec, preset.heartZoneMin, preset.heartZoneMax),
    stages: withIds(preset.stages, invocationSource),
    issued_at_ms: nowMs,
    expires_at_ms: nowMs + PRESET_TTL_MS,
    ownership_epoch: normalizedOwner.ownershipEpoch,
    data_namespace: normalizedOwner.dataNamespace,
  };
  return normalizeWorkoutPlan(rawPlan, normalizedOwner, { nowMs });
}
