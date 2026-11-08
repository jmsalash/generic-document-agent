import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthToStatus, BANNER } from '../../widget/status.js';

test('healthToStatus maps health answers to the eye state', () => {
  assert.equal(healthToStatus(null), 'offline');
  assert.equal(healthToStatus({ ok: false }), 'offline');
  assert.equal(healthToStatus({ ok: true, sessions: 0, maxSessions: 3 }), 'invite');
  assert.equal(healthToStatus({ ok: true, sessions: 3, maxSessions: 3 }), 'busy');
  assert.equal(healthToStatus({ ok: true }), 'invite');
});

test('banner copy is exact and fits one line', () => {
  assert.deepEqual(BANNER, {
    invite: 'Click me to talk',
    offline: 'Assistant is offline',
    busy: 'Busy with visitors, try soon',
    micDenied: 'Microphone needed to talk',
    connecting: 'Connecting…',
    limit: "Time's up. Click to talk again",
    insecure: 'Needs a secure (https) page',
  });
  for (const v of Object.values(BANNER)) assert.ok(v.length <= 30, v);
});
