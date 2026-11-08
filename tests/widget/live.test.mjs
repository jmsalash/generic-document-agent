import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLive } from '../../widget/live.js';
import { pcm16B64ToF32 } from '../../widget/audio.js';

const tick = () => new Promise((r) => setTimeout(r, 5));
const tokenOk = async () => new Response(JSON.stringify({ token: ['auth_tokens', 'x'].join('/'), model: 'm1' }));

function fakeSdk() {
  const rec = { connects: [], sent: [], closed: 0, clientArgs: null };
  const session = {
    sendClientContent: (c) => rec.sent.push(['content', c]),
    sendRealtimeInput: (i) => rec.sent.push(['audio', i]),
    close: () => { rec.closed++; },
  };
  const sdk = {
    GoogleGenAI: class {
      constructor(args) { rec.clientArgs = args; this.live = { connect: async (p) => { rec.connects.push(p); rec.cb = p.callbacks; return session; } }; }
    },
  };
  return { sdk, rec };
}

function run(opts = {}) {
  const events = [];
  const { sdk, rec } = fakeSdk();
  const live = startLive({ base: 'http://r', fetchImpl: opts.fetchImpl ?? tokenOk, loadSdk: opts.loadSdk ?? (async () => sdk), on: (e) => events.push(e) });
  return { live, events, rec, types: () => events.map((e) => e.type) };
}

test('busy pass: no connection', async () => {
  const r = run({ fetchImpl: async () => new Response(JSON.stringify({ error: 'busy' }), { status: 503 }) });
  await tick();
  assert.deepEqual(r.events, [{ type: 'closed', reason: 'busy' }]);
  assert.equal(r.rec.connects.length, 0);
});

test('connects with the pass and maps messages', async () => {
  const r = run();
  await tick();
  assert.equal(r.rec.clientArgs.apiKey, ['auth_tokens', 'x'].join('/'));
  assert.equal(r.rec.clientArgs.httpOptions.apiVersion, 'v1alpha');
  assert.equal(r.rec.connects[0].model, 'm1');
  assert.deepEqual(r.types(), ['ready']);
  r.live.intro();
  assert.equal(r.rec.sent[0][1].turns[0].parts[0].text, 'Please introduce yourself.');
  const m = (serverContent) => r.rec.cb.onmessage({ serverContent });
  m({ inputTranscription: { text: 'What did ' } });
  m({ inputTranscription: { text: 'she do?' } });
  m({ modelTurn: { parts: [{ inlineData: { data: 'AAA=' } }] }, outputTranscription: { text: 'She built robots.' } });
  m({ interrupted: true });
  m({ turnComplete: true });
  m({ inputTranscription: { text: 'Next' } });
  assert.deepEqual(r.events.slice(1), [
    { type: 'you', text: 'What did' },
    { type: 'you', text: 'What did she do?' },
    { type: 'me', text: 'She built robots.' },
    { type: 'audio', data: 'AAA=' },
    { type: 'interrupted' },
    { type: 'turnDone' },
    { type: 'you', text: 'Next' },
  ]);
});

test('mic audio goes up as 16 kHz PCM16', async () => {
  const r = run();
  await tick();
  r.live.sendAudio(new Float32Array(4800).fill(0.5), 48000);
  const [, input] = r.rec.sent[0];
  assert.equal(input.audio.mimeType, 'audio/pcm;rate=16000');
  assert.equal(pcm16B64ToF32(input.audio.data).length, 1600);
});

test('ending while the SDK is still loading never connects', async () => {
  let release;
  const { sdk } = fakeSdk();
  const r = run({ loadSdk: () => new Promise((res) => { release = () => res(sdk); }) });
  await tick();
  r.live.end();
  release();
  await tick();
  assert.equal(r.rec.connects.length, 0);
  assert.deepEqual(r.events, [{ type: 'closed', reason: 'user' }]);
});

test('closing: limit after goAway, dropped otherwise, only once', async () => {
  const a = run(); await tick();
  a.rec.cb.onmessage({ goAway: { timeLeft: '5s' } });
  a.rec.cb.onclose();
  a.rec.cb.onclose();
  assert.deepEqual(a.events.filter((e) => e.type === 'closed'), [{ type: 'closed', reason: 'limit' }]);
  const b = run(); await tick();
  b.rec.cb.onclose();
  assert.deepEqual(b.events.at(-1), { type: 'closed', reason: 'dropped' });
  const c = run(); await tick();
  c.live.end();
  assert.equal(c.rec.closed, 1);
  c.live.sendAudio(new Float32Array(10), 16000);
  assert.equal(c.rec.sent.length, 0);
});

test('SDK failing to load is offline', async () => {
  const r = run({ loadSdk: async () => { throw new Error('cdn down'); } });
  await tick();
  assert.deepEqual(r.events, [{ type: 'closed', reason: 'offline' }]);
});
