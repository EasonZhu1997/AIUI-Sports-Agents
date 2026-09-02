import assert from 'node:assert/strict';
import test from 'node:test';
import { SurfaceActionGate } from '../lib/input.js';

test('native tap and GlobalHook form one transactional action', () => {
  let now = 1000;
  const gate = new SurfaceActionGate({ now: () => now, surfaceEntryMs: 700, actionDedupeMs: 600 });
  gate.markSurfaceEntry(now);
  now = 1699;
  assert.equal(gate.canClaim('menu:0'), false);
  now = 1700;
  assert.equal(gate.canClaim('menu:0'), true);
  now = 1750;
  assert.equal(gate.canClaim('menu:0'), false);
  now = 2300;
  assert.equal(gate.canClaim('menu:0'), true);
});

test('swipe tail is blocked even on a single-target surface', () => {
  let now = 5000;
  const gate = new SurfaceActionGate({ now: () => now, directionReleaseMs: 600 });
  gate.markDirectionRelease(now);
  now = 5599;
  assert.equal(gate.canClaim('scan:0'), false);
  now = 5600;
  assert.equal(gate.canClaim('scan:0'), true);
});
