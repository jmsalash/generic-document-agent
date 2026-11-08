import test from 'node:test';
import assert from 'node:assert/strict';
import { createLimits, originAllowed } from '../../relay/limits.js';
import { DEFAULTS } from '../../relay/store.js';

const clock = () => { let t = 1_000_000; return { now: () => t, add: (ms) => { t += ms; } }; };

test('sessions fill up and expire', () => {
  const c = clock(); const l = createLimits({ now: c.now }); const cfg = { ...DEFAULTS };
  for (const ip of ['a', 'b', 'c']) { assert.equal(l.check(ip, cfg), 'ok'); l.record(ip, cfg); }
  assert.equal(l.sessions(cfg), 3);
  assert.equal(l.check('d', cfg), 'busy');
  c.add(10 * 60_000 + 1);
  assert.equal(l.sessions(cfg), 0);
  assert.equal(l.check('d', cfg), 'ok');
});

test('per-address hourly limit', () => {
  const c = clock(); const l = createLimits({ now: c.now }); const cfg = { ...DEFAULTS, maxSessions: 99 };
  for (let i = 0; i < 10; i++) l.record('a', cfg);
  assert.equal(l.check('a', cfg), 'rate');
  assert.equal(l.check('b', cfg), 'ok');
  c.add(60 * 60_000 + 1);
  assert.equal(l.check('a', cfg), 'ok');
});

test('daily limit applies to everyone', () => {
  const c = clock(); const l = createLimits({ now: c.now }); const cfg = { ...DEFAULTS, maxSessions: 999, perIpPerHour: 999, perDay: 5 };
  for (let i = 0; i < 5; i++) l.record(`ip${i}`, cfg);
  assert.equal(l.check('new', cfg), 'rate');
  c.add(24 * 60 * 60_000 + 1);
  assert.equal(l.check('new', cfg), 'ok');
});

test('origin check', () => {
  const cfg = { ...DEFAULTS, origins: ['https://example.com'] };
  assert.equal(originAllowed('https://example.com', cfg), true);
  assert.equal(originAllowed('https://example.com/', cfg), true);
  assert.equal(originAllowed('https://evil.example', cfg), false);
  assert.equal(originAllowed(undefined, cfg), false);
  assert.equal(originAllowed('null', cfg), false);
  assert.equal(originAllowed('http://localhost:5500', cfg), true);
  assert.equal(originAllowed('https://example.com', { ...cfg, origins: ['https://example.com/'] }), true);
});

test('snapshot drops entries older than a day', () => {
  const c = clock(); const l = createLimits({ now: c.now });
  l.record('a'); c.add(23 * 60 * 60_000); l.record('b'); c.add(60 * 60_000 + 1);
  assert.deepEqual(l.snapshot().map((s) => s.ip), ['b']);
});

test('createLimits resumes from starts', () => {
  const c = clock(); const cfg = { ...DEFAULTS };
  const first = createLimits({ now: c.now });
  for (const ip of ['a', 'b', 'c']) first.record(ip);
  const again = createLimits({ now: c.now, starts: first.snapshot() });
  assert.equal(again.sessions(cfg), 3);
  assert.equal(again.check('d', cfg), 'busy');
});
