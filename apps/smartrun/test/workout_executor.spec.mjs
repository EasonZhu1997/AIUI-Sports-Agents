import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceWorkoutExecution,
  createWorkoutExecution,
  finishWorkoutExecution,
  normalizeWorkoutExecution,
  restoreWorkoutExecution,
  workoutProgressView,
} from '../lib/workout_executor.js';
import {
  clearWorkoutExecutionCheckpoint,
  initializeWorkoutExecutionStorage,
  readWorkoutExecutionCheckpoint,
  readWorkoutExecutionCheckpointState,
  writeWorkoutExecutionCheckpoint,
  WORKOUT_EXECUTION_CACHE_KEY,
  WORKOUT_EXECUTION_STATE_KEY,
} from '../lib/workout_cache.js';

const START = Date.parse('2026-08-07T10:00:00.000Z');
const OWNER = { ownershipEpoch: 2, dataNamespace: 'ns-exec', publicDeviceId: 'SR-EXEC-1' };
const WORKOUT_ID = 'wrk_111111111111111111111111';
const PLAN_ID = 'plan_7001';
const PLAN_SESSION_ID = 'ps_222222222222222222222222';
const STAGE_MAIN_ID = 'stg_333333333333333333333333';
const STAGE_WARM_ID = 'stg_444444444444444444444444';
const STAGE_WORK_ID = 'stg_555555555555555555555555';
const STAGE_DISTANCE_ID = 'stg_666666666666666666666666';

function target(overrides = {}) {
  return {
    duration_sec: null, distance_m: null,
    pace_min_sec_per_km: null, pace_max_sec_per_km: null,
    heart_zone_min: null, heart_zone_max: null,
    cadence_min_spm: null, cadence_max_spm: null,
    ...overrides,
  };
}

function stage(id, order, type, bound, title = id) {
  return { stage_id: id, order, type, title, ...target(bound) };
}

function plan(stages = [stage(STAGE_MAIN_ID, 0, 'work', { duration_sec: 1800 })]) {
  return {
    schema_version: 2, workout_id: WORKOUT_ID, plan_id: PLAN_ID,
    plan_session_id: PLAN_SESSION_ID, revision: 7, type: 'easy', title: '今日训练',
    scheduled_date: '2026-08-07', status: 'planned', target: target({ duration_sec: 1800 }),
    stages, issued_at_ms: START - 1000, expires_at_ms: START + 86_400_000,
    ownership_epoch: OWNER.ownershipEpoch, data_namespace: OWNER.dataNamespace,
  };
}

function memoryStorage() {
  const map = new Map();
  const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  return {
    map,
    getStorageSync(k) { return map.has(k) ? copy(map.get(k)) : undefined; },
    getStorage({ key, success, fail, complete }) {
      if (map.has(key)) success?.({ data: copy(map.get(key)) });
      else fail?.({ errMsg: 'Key not found' });
      complete?.();
    },
    setStorageSync(k, v) { map.set(k, copy(v)); },
    removeStorageSync(k) { map.delete(k); },
  };
}

test('checkpoint 读取异常 fail closed，不把已有 execution 当作缺失覆盖', () => {
  const s = memoryStorage();
  const existing = createWorkoutExecution(plan(), OWNER, {
    nowMs: START,
    clientExecutionId: 'exec-existing-checkpoint',
  });
  assert.equal(writeWorkoutExecutionCheckpoint(s, existing, OWNER), true);
  const originalGet = s.getStorageSync.bind(s);
  let transientFailures = 2;
  s.getStorageSync = (key) => {
    if (key === WORKOUT_EXECUTION_CACHE_KEY && transientFailures > 0) {
      transientFailures -= 1;
      throw new Error('transient storage read failure');
    }
    return originalGet(key);
  };

  const state = readWorkoutExecutionCheckpointState(s, OWNER, normalizeWorkoutExecution);
  assert.deepEqual(state, {
    ok: false,
    found: false,
    execution: null,
    reason: 'storage_read_failed',
  });
  const originalSet = s.setStorageSync.bind(s);
  let writeAttempts = 0;
  s.setStorageSync = (key, value) => {
    writeAttempts += 1;
    return originalSet(key, value);
  };
  assert.throws(
    () => {
      const checkpoint = readWorkoutExecutionCheckpoint(s, OWNER, normalizeWorkoutExecution);
      const candidate = checkpoint || createWorkoutExecution(plan(), OWNER, {
        nowMs: START + 1000,
        clientExecutionId: 'exec-must-not-overwrite',
      });
      writeWorkoutExecutionCheckpoint(s, candidate, OWNER);
    },
    (error) => error?.code === 'WORKOUT_CHECKPOINT_READ_FAILED',
  );
  assert.equal(writeAttempts, 0, '读取失败必须在新 execution 写入前中止');

  const preserved = readWorkoutExecutionCheckpoint(s, OWNER, normalizeWorkoutExecution);
  assert.equal(preserved.client_execution_id, 'exec-existing-checkpoint');
});

test('checkpoint 普通缺失仍返回 null，不阻止首次建立 execution', () => {
  const s = memoryStorage();
  assert.deepEqual(
    readWorkoutExecutionCheckpointState(s, OWNER, normalizeWorkoutExecution),
    { ok: true, found: false, execution: null, reason: 'missing' },
  );
  assert.equal(readWorkoutExecutionCheckpoint(s, OWNER, normalizeWorkoutExecution), null);

  const created = createWorkoutExecution(plan(), OWNER, {
    nowMs: START,
    clientExecutionId: 'exec-first-checkpoint',
  });
  assert.equal(writeWorkoutExecutionCheckpoint(s, created, OWNER), true);
  assert.equal(
    readWorkoutExecutionCheckpoint(s, OWNER, normalizeWorkoutExecution).client_execution_id,
    'exec-first-checkpoint',
  );
});

test('checkpoint 单次 silent empty 由二次读取恢复，不覆盖既有 execution', () => {
  const s = memoryStorage();
  const existing = createWorkoutExecution(plan(), OWNER, {
    nowMs: START,
    clientExecutionId: 'exec-silent-read-preserved',
  });
  assert.equal(writeWorkoutExecutionCheckpoint(s, existing, OWNER), true);
  const getStorageSync = s.getStorageSync.bind(s);
  let hideOnce = true;
  s.getStorageSync = (key) => {
    if (key === WORKOUT_EXECUTION_CACHE_KEY && hideOnce) {
      hideOnce = false;
      return undefined;
    }
    return getStorageSync(key);
  };
  const state = readWorkoutExecutionCheckpointState(
    s,
    OWNER,
    normalizeWorkoutExecution,
  );
  assert.equal(state.ok, true);
  assert.equal(state.found, true);
  assert.equal(state.execution.client_execution_id, 'exec-silent-read-preserved');
});

test('checkpoint 目标键持续 silent undefined 时从专属镜像恢复，不当作首次缺失', () => {
  const s = memoryStorage();
  const existing = createWorkoutExecution(plan(), OWNER, {
    nowMs: START,
    clientExecutionId: 'exec-continuous-silent-preserved',
  });
  assert.equal(writeWorkoutExecutionCheckpoint(s, existing, OWNER), true);
  assert.equal(s.map.has(WORKOUT_EXECUTION_STATE_KEY), true);
  const getStorageSync = s.getStorageSync.bind(s);
  s.getStorageSync = (key) => key === WORKOUT_EXECUTION_CACHE_KEY
    ? undefined : getStorageSync(key);

  const state = readWorkoutExecutionCheckpointState(
    s,
    OWNER,
    normalizeWorkoutExecution,
  );
  assert.equal(state.ok, true);
  assert.equal(state.found, true);
  assert.equal(state.execution.client_execution_id, 'exec-continuous-silent-preserved');

  const replacement = createWorkoutExecution(plan(), OWNER, {
    nowMs: START + 1000,
    clientExecutionId: 'exec-must-not-claim-written',
  });
  assert.equal(writeWorkoutExecutionCheckpoint(s, replacement, OWNER), false);
  assert.equal(readWorkoutExecutionCheckpoint(
    s,
    OWNER,
    normalizeWorkoutExecution,
  ).client_execution_id, 'exec-continuous-silent-preserved');
});

test('legacy checkpoint 的 sync 目标静默时由 async 精确键初始化镜像', async () => {
  const s = memoryStorage();
  const seed = memoryStorage();
  const existing = createWorkoutExecution(plan(), OWNER, {
    nowMs: START,
    clientExecutionId: 'exec-legacy-silent-preserved',
  });
  assert.equal(writeWorkoutExecutionCheckpoint(seed, existing, OWNER), true);
  s.map.set(WORKOUT_EXECUTION_CACHE_KEY, seed.map.get(WORKOUT_EXECUTION_CACHE_KEY));
  const getStorageSync = s.getStorageSync.bind(s);
  s.getStorageSync = (key) => key === WORKOUT_EXECUTION_CACHE_KEY
    ? undefined : getStorageSync(key);

  assert.equal(await initializeWorkoutExecutionStorage(s), true);
  assert.equal(s.map.has(WORKOUT_EXECUTION_STATE_KEY), true);
  assert.equal(readWorkoutExecutionCheckpoint(
    s,
    OWNER,
    normalizeWorkoutExecution,
  ).client_execution_id, 'exec-legacy-silent-preserved');
});

test('有效 checkpoint 镜像且目标键精确缺失时恢复 target，随后可更新并清空', async () => {
  const s = memoryStorage();
  const existing = createWorkoutExecution(plan(), OWNER, {
    nowMs: START,
    clientExecutionId: 'exec-mirror-target-restore',
  });
  assert.equal(writeWorkoutExecutionCheckpoint(s, existing, OWNER), true);
  s.map.delete(WORKOUT_EXECUTION_CACHE_KEY);

  assert.equal(await initializeWorkoutExecutionStorage(s), true);
  assert.equal(readWorkoutExecutionCheckpoint(
    s,
    OWNER,
    normalizeWorkoutExecution,
  ).client_execution_id, 'exec-mirror-target-restore');
  const replacement = createWorkoutExecution(plan(), OWNER, {
    nowMs: START + 1000,
    clientExecutionId: 'exec-after-mirror-restore',
  });
  assert.equal(writeWorkoutExecutionCheckpoint(s, replacement, OWNER), true);
  assert.equal(readWorkoutExecutionCheckpoint(
    s,
    OWNER,
    normalizeWorkoutExecution,
  ).client_execution_id, 'exec-after-mirror-restore');
  assert.equal(clearWorkoutExecutionCheckpoint(s), true);
  assert.equal(readWorkoutExecutionCheckpoint(
    s,
    OWNER,
    normalizeWorkoutExecution,
  ), null);
});

test('checkpoint malformed/throw/conflict 均 fail closed，不清洗后覆盖', () => {
  const s = memoryStorage();
  const existing = createWorkoutExecution(plan(), OWNER, {
    nowMs: START,
    clientExecutionId: 'exec-malformed-preserved',
  });
  assert.equal(writeWorkoutExecutionCheckpoint(s, existing, OWNER), true);

  const originalState = s.map.get(WORKOUT_EXECUTION_STATE_KEY);
  s.map.set(WORKOUT_EXECUTION_STATE_KEY, { malformed: true });
  assert.deepEqual(readWorkoutExecutionCheckpointState(
    s,
    OWNER,
    normalizeWorkoutExecution,
  ), {
    ok: false,
    found: false,
    execution: null,
    reason: 'storage_state_invalid',
  });
  assert.equal(s.map.get(WORKOUT_EXECUTION_CACHE_KEY).execution.client_execution_id,
    'exec-malformed-preserved');

  s.map.set(WORKOUT_EXECUTION_STATE_KEY, originalState);
  const getStorageSync = s.getStorageSync.bind(s);
  s.getStorageSync = (key) => {
    if (key === WORKOUT_EXECUTION_CACHE_KEY) throw new Error('read failed');
    return getStorageSync(key);
  };
  assert.equal(readWorkoutExecutionCheckpointState(
    s,
    OWNER,
    normalizeWorkoutExecution,
  ).reason, 'storage_read_failed');
});

test('checkpoint clear 使用 verified tombstone，不被 silent no-op remove/set 欺骗', () => {
  const s = memoryStorage();
  const existing = createWorkoutExecution(plan(), OWNER, {
    nowMs: START,
    clientExecutionId: 'exec-clear-preserved',
  });
  assert.equal(writeWorkoutExecutionCheckpoint(s, existing, OWNER), true);
  s.removeStorageSync = () => {};
  assert.equal(clearWorkoutExecutionCheckpoint(s), true,
    '清理不依赖可能 silent no-op 的 removeStorageSync');
  assert.deepEqual(readWorkoutExecutionCheckpointState(
    s,
    OWNER,
    normalizeWorkoutExecution,
  ), { ok: true, found: false, execution: null, reason: 'missing' });

  assert.equal(writeWorkoutExecutionCheckpoint(s, existing, OWNER), true);
  const setStorageSync = s.setStorageSync.bind(s);
  s.setStorageSync = (key, value) => {
    if (key !== WORKOUT_EXECUTION_CACHE_KEY) setStorageSync(key, value);
  };
  assert.equal(clearWorkoutExecutionCheckpoint(s), false);
  assert.equal(readWorkoutExecutionCheckpoint(
    s,
    OWNER,
    normalizeWorkoutExecution,
  ).client_execution_id, 'exec-clear-preserved');
});

test('30 分钟计划仅按活跃时间推进；pause/hide/restart 均不补算停顿', () => {
  let state = createWorkoutExecution(plan(), OWNER, {
    nowMs: START, clientExecutionId: 'exec-fixed-0001', initialDistanceM: 0,
  });
  state = advanceWorkoutExecution(state, { type: 'tick', nowMs: START + 600_000 });
  state = advanceWorkoutExecution(state, { type: 'pause', nowMs: START + 600_000 });
  state = advanceWorkoutExecution(state, { type: 'resume', nowMs: START + 1_200_000 });
  state = advanceWorkoutExecution(state, { type: 'tick', nowMs: START + 1_500_000 });
  state = advanceWorkoutExecution(state, { type: 'hide', nowMs: START + 1_500_000 });
  assert.equal(state.active_elapsed_ms, 900_000);

  const s = memoryStorage();
  assert.equal(writeWorkoutExecutionCheckpoint(s, state, OWNER), true);
  let restored = readWorkoutExecutionCheckpoint(s, OWNER, normalizeWorkoutExecution);
  restored = restoreWorkoutExecution(restored, OWNER, START + 2_100_000);
  assert.equal(restored.status, 'paused');
  restored = advanceWorkoutExecution(restored, { type: 'show', nowMs: START + 2_100_000 });
  restored = advanceWorkoutExecution(restored, { type: 'tick', nowMs: START + 3_000_000 });
  assert.equal(restored.status, 'plan_complete');
  assert.equal(restored.active_elapsed_ms, 1_800_000);
  assert.equal(restored.stage_results.length, 1);
  assert.equal(restored.final_prompt_pending, true);
});

test('duration/distance first reached advances one stage，final stage 只提示不自动结束跑步', () => {
  const stages = [
    stage(STAGE_WARM_ID, 0, 'warmup', { duration_sec: 60 }),
    stage(STAGE_WORK_ID, 1, 'work', { distance_m: 100 }),
  ];
  let state = createWorkoutExecution(plan(stages), OWNER, {
    nowMs: START, clientExecutionId: 'exec-fixed-0002', initialDistanceM: 1000,
  });
  state = advanceWorkoutExecution(state, { type: 'tick', nowMs: START + 60_000 });
  assert.equal(state.stage_index, 1);
  assert.equal(state.status, 'running');
  state = advanceWorkoutExecution(state, {
    type: 'distance', nowMs: START + 61_000, distanceM: 1040,
  });
  assert.equal(state.stage_distance_m, 0, '新阶段首包只建立账本锚点');
  state = advanceWorkoutExecution(state, {
    type: 'distance', nowMs: START + 62_000, distanceM: 1140,
  });
  assert.equal(state.status, 'plan_complete');
  assert.equal(workoutProgressView(state).finalPromptPending, true);
  assert.equal(state.ended_at_ms, null, '训练阶段完成不能偷偷结束整场跑步');
  state = finishWorkoutExecution(state, START + 63_000);
  assert.equal(state.status, 'finished');
  assert.equal(state.outcome, 'completed');
});

test('RSC/GPS/IMU source_change 只重锚，不重置也不伪造阶段距离', () => {
  let state = createWorkoutExecution(
    plan([stage(STAGE_DISTANCE_ID, 0, 'work', { distance_m: 200 })]), OWNER,
    { nowMs: START, clientExecutionId: 'exec-fixed-0003', initialDistanceM: 0 },
  );
  state = advanceWorkoutExecution(state, {
    type: 'distance', nowMs: START + 1000, distanceM: 80,
  });
  assert.equal(state.stage_distance_m, 80);
  state = advanceWorkoutExecution(state, {
    type: 'source_change', nowMs: START + 1500, ledgerId: 'motion-ledger-v1',
  });
  state = advanceWorkoutExecution(state, {
    type: 'distance', nowMs: START + 2000, distanceM: 90,
  });
  assert.equal(state.stage_distance_m, 80, '切源后的首包不能重复补入');
  state = advanceWorkoutExecution(state, {
    type: 'distance', nowMs: START + 3000, distanceM: 210,
  });
  assert.equal(state.status, 'plan_complete');
  assert.equal(state.stage_results[0].distance_m, 200);
});

test('乱序 sensor 与巨大账本跳变不推进，普通折返后单调账本继续', () => {
  let state = createWorkoutExecution(
    plan([stage(STAGE_DISTANCE_ID, 0, 'work', { distance_m: 100 })]), OWNER,
    { nowMs: START, clientExecutionId: 'exec-fixed-0004', initialDistanceM: 500 },
  );
  state = advanceWorkoutExecution(state, {
    type: 'distance', nowMs: START + 2000, distanceM: 540,
  });
  const beforeLate = state.stage_distance_m;
  state = advanceWorkoutExecution(state, {
    type: 'distance', nowMs: START + 1000, distanceM: 600,
  });
  assert.equal(state.stage_distance_m, beforeLate);
  state = advanceWorkoutExecution(state, {
    type: 'distance', nowMs: START + 3000, distanceM: 9000,
  });
  assert.equal(state.stage_distance_m, 40, '异常跳变只重锚');
  state = advanceWorkoutExecution(state, {
    type: 'distance', nowMs: START + 4000, distanceM: 9060,
  });
  assert.equal(state.status, 'plan_complete');
});

test('服务端 revision 更新不覆盖正在执行的不可变快照', () => {
  const state = createWorkoutExecution(plan(), OWNER, {
    nowMs: START, clientExecutionId: 'exec-fixed-0005',
  });
  const changed = plan();
  changed.revision = 8;
  changed.title = '服务器新版';
  assert.equal(state.plan.revision, 7);
  assert.equal(state.plan.title, '今日训练');
  assert.equal(changed.revision, 8);
});

test('提前结束整场产生 partial/aborted，阶段只用 partial/skipped', () => {
  let partial = createWorkoutExecution(plan(), OWNER, {
    nowMs: START, clientExecutionId: 'exec-fixed-0006',
  });
  partial = advanceWorkoutExecution(partial, {
    type: 'tick', nowMs: START + 10_000, bpm: 148, cadenceSpm: 170,
  });
  partial = finishWorkoutExecution(partial, START + 10_000);
  assert.equal(partial.outcome, 'partial');
  assert.equal(partial.stage_results[0].avg_hr, 148);
  assert.equal(partial.stage_results[0].cadence_avg, 170);

  const aborted = finishWorkoutExecution(createWorkoutExecution(plan(), OWNER, {
    nowMs: START, clientExecutionId: 'exec-fixed-0007',
  }), START);
  assert.equal(aborted.outcome, 'aborted');
  assert.equal(aborted.stage_results[0].status, 'skipped');
  assert.equal(aborted.stage_results[0].duration_s, 0);
});

test('零进度终止即使已采到心率与步频也生成纯 skipped 结果', () => {
  let state = createWorkoutExecution(plan(), OWNER, {
    nowMs: START, clientExecutionId: 'exec-fixed-0008',
  });
  state = advanceWorkoutExecution(state, {
    type: 'tick', nowMs: START, bpm: 152, cadenceSpm: 176,
  });
  state = finishWorkoutExecution(state, START);

  assert.equal(state.outcome, 'aborted');
  assert.deepEqual(state.stage_results[0], {
    stage_id: STAGE_MAIN_ID,
    status: 'skipped',
    duration_s: 0,
    distance_m: 0,
  });
  assert.equal(normalizeWorkoutExecution(state, OWNER)?.stage_results[0].avg_hr, undefined);
  assert.equal(normalizeWorkoutExecution(state, OWNER)?.stage_results[0].cadence_avg, undefined);
});
