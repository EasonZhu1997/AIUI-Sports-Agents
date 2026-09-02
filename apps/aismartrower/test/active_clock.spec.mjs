import assert from 'node:assert/strict';
import test from 'node:test';
import { ActiveClock } from '../lib/active_clock.js';

test('active clock excludes hidden pauses and is monotonic', () => {
  const clock = new ActiveClock();
  assert.equal(clock.start(1000), true);
  assert.equal(clock.elapsedMs(4000), 3000);
  assert.equal(clock.pause(5000), true);
  assert.equal(clock.elapsedMs(9000), 4000);
  assert.equal(clock.resume(10000), true);
  assert.equal(clock.finish(13000), true);
  assert.deepEqual(clock.snapshot(20000), {
    state: 'finished', startedAtMs: 1000, finishedAtMs: 13000, elapsedMs: 7000,
  });
});

test('active clock rejects duplicate and backward transitions', () => {
  const clock = new ActiveClock();
  assert.equal(clock.pause(1), false);
  assert.equal(clock.start(100), true);
  assert.equal(clock.start(200), false);
  assert.equal(clock.pause(99), false);
  assert.equal(clock.pause(200), true);
  assert.equal(clock.pause(300), false);
  assert.equal(clock.resume(400), true);
  assert.equal(clock.finish(350), false);
  assert.equal(clock.finish(500), true);
  assert.equal(clock.resume(600), false);
});
