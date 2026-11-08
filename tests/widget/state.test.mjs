import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextIdle, canStart, isLive, isIdle } from '../../widget/state.js';
import { healthToStatus } from '../../widget/status.js';

test('a relay that comes back turns the eye yellow again', () => {
  assert.equal(nextIdle(healthToStatus(null)), 'offline');
  assert.equal(nextIdle(healthToStatus({ ok: true, sessions: 0, maxSessions: 3 })), 'invite');
  assert.equal(nextIdle('weird'), 'offline');
});

test('only an inviting eye starts a conversation', () => {
  for (const s of ['checking', 'offline', 'busy', 'connecting', 'intro', 'listening', 'thinking', 'speaking'])
    assert.equal(canStart(s), false, s);
  assert.equal(canStart('invite'), true);
});

test('live and idle states', () => {
  for (const s of ['intro', 'listening', 'thinking', 'speaking']) { assert.equal(isLive(s), true); assert.equal(isIdle(s), false); }
  for (const s of ['checking', 'invite', 'offline', 'busy']) { assert.equal(isLive(s), false); assert.equal(isIdle(s), true); }
  assert.equal(isLive('connecting'), false);
  assert.equal(isIdle('connecting'), false);
});
