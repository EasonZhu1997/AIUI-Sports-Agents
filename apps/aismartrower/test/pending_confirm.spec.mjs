import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingConfirm } from '../lib/pending_confirm.js';

function fakeTimers() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    setTimer(callback) { const id = nextId++; callbacks.set(id, callback); return id; },
    clearTimer(id) { callbacks.delete(id); },
    fireAll() { for (const callback of [...callbacks.values()]) callback(); callbacks.clear(); },
    size() { return callbacks.size; },
  };
}

test('GlobalHook fallback waits and a direction event may cancel it', () => {
  const timers = fakeTimers();
  const pending = new PendingConfirm({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  let activations = 0;
  assert.equal(pending.schedule(() => { activations += 1; }), true);
  assert.equal(pending.schedule(() => { activations += 1; }), false);
  assert.equal(timers.size(), 1);
  assert.equal(pending.cancel(), true);
  timers.fireAll();
  assert.equal(activations, 0);
});

test('one uncancelled fallback activates exactly once', () => {
  const timers = fakeTimers();
  const pending = new PendingConfirm({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  let activations = 0;
  pending.schedule(() => { activations += 1; });
  timers.fireAll();
  timers.fireAll();
  assert.equal(activations, 1);
});
