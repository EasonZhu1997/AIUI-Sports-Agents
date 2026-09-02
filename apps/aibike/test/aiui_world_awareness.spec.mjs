import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAiuiWorldAwarenessDiagnostics,
  disableAiuiWorldAwareness,
  enableAiuiWorldAwareness,
  recordAiuiHeadGesture,
  recordAiuiOrientationStability,
  snapshotAiuiWorldAwareness,
} from '../lib/aiui_world_awareness.js';

test('AIUI 0.15 缺少 World Awareness 时无损标记 unsupported', () => {
  const state = enableAiuiWorldAwareness(
    {},
    createAiuiWorldAwarenessDiagnostics(),
    { generation: 3, now: 1000 },
  );
  assert.equal(state.supported, false);
  assert.equal(state.enabled, false);
  assert.equal(state.state, 'unsupported');
  assert.equal(state.generation, 3);
});

test('AIUI 0.16 enable/disable 只调用一次同步页面能力', () => {
  const calls = [];
  const page = {
    enableWorldAwareness() { calls.push('enable'); },
    disableWorldAwareness() { calls.push('disable'); },
  };
  let state = enableAiuiWorldAwareness(
    page,
    createAiuiWorldAwarenessDiagnostics(),
    { generation: 4, now: 2000 },
  );
  assert.equal(state.enabled, true);
  const sameGeneration = enableAiuiWorldAwareness(page, state, {
    generation: 4,
    now: 2500,
  });
  assert.deepEqual(sameGeneration, state);
  assert.deepEqual(calls, ['enable']);
  state = disableAiuiWorldAwareness(page, state, { now: 3000 });
  state = disableAiuiWorldAwareness(page, state, { now: 3100 });
  assert.deepEqual(calls, ['enable', 'disable']);
  assert.equal(state.state, 'disabled');
});

test('能力异常只记录 error，不能向业务层抛出', () => {
  const page = {
    enableWorldAwareness() { throw new Error('host unsupported'); },
    disableWorldAwareness() {},
  };
  assert.doesNotThrow(() => enableAiuiWorldAwareness(
    page,
    createAiuiWorldAwarenessDiagnostics(),
    { generation: 1, now: 4000 },
  ));
  const state = enableAiuiWorldAwareness(
    page,
    createAiuiWorldAwarenessDiagnostics(),
    { generation: 1, now: 4000 },
  );
  assert.equal(state.state, 'error');
  assert.equal(state.errorCount, 1);
});

test('disable 异常仍安全关闭业务状态且不向骑行主流程抛出', () => {
  const page = {
    enableWorldAwareness() {},
    disableWorldAwareness() { throw new Error('host teardown failure'); },
  };
  const enabled = enableAiuiWorldAwareness(
    page,
    createAiuiWorldAwarenessDiagnostics(),
    { generation: 6, now: 4200 },
  );
  let disabled;
  assert.doesNotThrow(() => {
    disabled = disableAiuiWorldAwareness(page, enabled, { now: 4300 });
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.state, 'error');
  assert.equal(disabled.errorCount, 1);
  assert.equal(disabled.cleanupPending, true);
});

test('清理失败锁阻止重复 enable，明确 disable 成功后才允许新一代', () => {
  let enableCalls = 0;
  let disableCalls = 0;
  let disableThrows = true;
  const page = {
    enableWorldAwareness() { enableCalls += 1; },
    disableWorldAwareness() {
      disableCalls += 1;
      if (disableThrows) throw new Error('still active');
    },
  };
  let state = enableAiuiWorldAwareness(
    page,
    createAiuiWorldAwarenessDiagnostics(),
    { generation: 1, now: 4400 },
  );
  state = disableAiuiWorldAwareness(page, state, { now: 4500 });
  state = enableAiuiWorldAwareness(page, state, {
    generation: 2,
    now: 4600,
  });
  assert.equal(enableCalls, 1);
  assert.equal(disableCalls, 2);
  assert.equal(state.cleanupPending, true);
  disableThrows = false;
  state = enableAiuiWorldAwareness(page, state, {
    generation: 2,
    now: 4700,
  });
  assert.equal(disableCalls, 3);
  assert.equal(enableCalls, 2);
  assert.equal(state.enabled, true);
  assert.equal(state.cleanupPending, false);
  assert.equal(state.generation, 2);
});

test('缺少对称 disable API 时不调用半套 preview 能力', () => {
  let enableCalls = 0;
  const state = enableAiuiWorldAwareness({
    enableWorldAwareness() { enableCalls += 1; },
  }, createAiuiWorldAwarenessDiagnostics(), {
    generation: 1,
    now: 4500,
  });
  assert.equal(enableCalls, 0);
  assert.equal(state.state, 'unsupported');
});

test('头部手势严格限制 nod/shake，并去重同一宿主尾包', () => {
  let state = enableAiuiWorldAwareness(
    { enableWorldAwareness() {}, disableWorldAwareness() {} },
    createAiuiWorldAwarenessDiagnostics(),
    { generation: 8, now: 5000 },
  );
  state = recordAiuiHeadGesture(state, { gesture: 'nod' }, {
    generation: 8,
    now: 5200,
  });
  state = recordAiuiHeadGesture(state, { gesture: 'nod' }, {
    generation: 8,
    now: 5300,
  });
  state = recordAiuiHeadGesture(state, { gesture: 'turn-left' }, {
    generation: 8,
    now: 5600,
  });
  assert.equal(state.lastGesture, 'nod');
  assert.equal(state.gestureCount, 1);
  assert.equal(state.nodCount, 1);
  assert.equal(state.shakeCount, 0);
  const snapshot = snapshotAiuiWorldAwareness(state, 6000);
  assert.equal(snapshot.headGestureAgeMs, 800);
});

test('从未收到事件时 age 保持 null，计数器按一百万饱和', () => {
  let state = enableAiuiWorldAwareness(
    { enableWorldAwareness() {}, disableWorldAwareness() {} },
    {
      ...createAiuiWorldAwarenessDiagnostics(),
      gestureCount: 1000000,
      nodCount: 1000000,
    },
    { generation: 3, now: 6100 },
  );
  let snapshot = snapshotAiuiWorldAwareness(state, 6200);
  assert.equal(snapshot.headGestureAgeMs, null);
  assert.equal(snapshot.orientationStabilityAgeMs, null);
  state = recordAiuiHeadGesture(state, { gesture: 'nod' }, {
    generation: 3,
    now: 6300,
  });
  snapshot = snapshotAiuiWorldAwareness(state, 6400);
  assert.equal(snapshot.headGestureCount, 1000000);
  assert.equal(snapshot.headNodCount, 1000000);
});

test('姿态稳定事件按 generation 隔离并去重', () => {
  let state = enableAiuiWorldAwareness(
    { enableWorldAwareness() {}, disableWorldAwareness() {} },
    createAiuiWorldAwarenessDiagnostics(),
    { generation: 9, now: 7000 },
  );
  state = recordAiuiOrientationStability(state, { stable: true }, {
    generation: 8,
    now: 7100,
  });
  assert.equal(state.orientationStable, null);
  state = recordAiuiOrientationStability(state, { stable: true }, {
    generation: 9,
    now: 7200,
  });
  state = recordAiuiOrientationStability(state, { stable: true }, {
    generation: 9,
    now: 7500,
  });
  state = recordAiuiOrientationStability(state, { stable: false }, {
    generation: 9,
    now: 7600,
  });
  assert.equal(state.orientationStable, false);
  assert.equal(state.stabilityChangeCount, 2);
});

test('诊断快照只含有界派生状态，不接受原始姿态字段', () => {
  let state = enableAiuiWorldAwareness(
    { enableWorldAwareness() {}, disableWorldAwareness() {} },
    createAiuiWorldAwarenessDiagnostics(),
    { generation: 2, now: 8000 },
  );
  state = recordAiuiHeadGesture(state, {
    gesture: 'shake',
    quaternion: [1, 2, 3, 4],
  }, { generation: 2, now: 8100 });
  const snapshot = snapshotAiuiWorldAwareness(state, 8200);
  assert.equal(snapshot.headGesture, 'shake');
  assert.equal(JSON.stringify(snapshot).includes('quaternion'), false);
});
