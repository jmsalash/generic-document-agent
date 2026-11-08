import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, DEFAULTS } from '../../relay/store.js';

const dir = () => mkdtempSync(join(tmpdir(), 'cva-store-'));
const KEY = ['fake', 'test', 'key', '4f2a'].join('-');

test('empty dir gives defaults', () => {
  const s = createStore(dir());
  assert.deepEqual(s.get(), DEFAULTS);
  assert.equal(s.get().maxSessions, 3);
  assert.equal(s.get().sessionMinutes, 10);
  assert.equal(s.get().perIpPerHour, 10);
  assert.equal(s.get().perDay, 200);
  assert.equal(s.get().voice, 'Despina');
});

test('set persists and survives a restart', () => {
  const d = dir();
  createStore(d).set({ apiKey: KEY, name: 'Ana' });
  const again = createStore(d);
  assert.equal(again.get().apiKey, KEY);
  assert.equal(again.get().name, 'Ana');
  assert.equal(JSON.parse(readFileSync(join(d, 'config.json'), 'utf8')).name, 'Ana');
});

test('publicView hides the key', () => {
  const s = createStore(dir());
  s.set({ apiKey: KEY });
  const v = s.publicView();
  assert.equal(v.apiKey, undefined);
  assert.equal(v.keyHint, '…4f2a');
  assert.ok(!JSON.stringify(v).includes(KEY));
  assert.equal(createStore(dir()).publicView().keyHint, null);
});

test('files round-trip', () => {
  const s = createStore(dir());
  assert.equal(s.readFile('cv.pdf'), null);
  s.saveFile('cv.pdf', Buffer.from('x'));
  assert.equal(s.readFile('cv.pdf').toString(), 'x');
});

test('Gemini client uses the API version the Live API answers on', async () => {
  const { makeClient, API_VERSION } = await import('../../relay/gemini.js');
  assert.equal(API_VERSION, 'v1alpha');
  assert.ok(makeClient('x'));
});

test('a saved voice that is no longer offered falls back to the default', () => {
  const d = dir();
  createStore(d).set({ voice: 'Kore' });
  assert.equal(createStore(d).get().voice, 'Despina');
});

test('the Cloudflare token is kept but never in the public view', () => {
  const s = createStore(dir());
  const t = ['fake', 'cf', 'token', '9z9z'].join('-');
  s.set({ cfToken: t, cfAccountId: 'acc123' });
  assert.equal(s.get().cfToken, t);
  const v = s.publicView();
  assert.equal(v.cfToken, undefined);
  assert.equal(v.cfTokenHint, '…9z9z');
  assert.ok(!JSON.stringify(v).includes(t));
});

test('new fields: example instructions and worker name, also for an older saved config', async () => {
  const { DEFAULT_INSTRUCTIONS } = await import('../../relay/document.js');
  const { writeFileSync } = await import('node:fs');
  const s = createStore(dir());
  assert.equal(s.get().instructions, DEFAULT_INSTRUCTIONS);
  assert.equal(s.get().workerName, 'document-agent');
  const d = dir();
  writeFileSync(join(d, 'config.json'), JSON.stringify({ name: 'Old' }));
  assert.equal(createStore(d).get().instructions, DEFAULT_INSTRUCTIONS);
});
