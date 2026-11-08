import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../cloud/handler.js';

const KEY = ['fake', 'test', 'key', '4f2a'].join('-');
const SITE = 'https://ana.github.io';
const PASS = ['auth_tokens', 't1'].join('/');
const SETTINGS = { ready: true, instructions: 'Speak about Ana.', voice: 'Despina', origins: [SITE], sessionMinutes: 10, maxSessions: 3, perIpPerHour: 10, perDay: 200 };
const quiet = { error() {} };

function make({ verdict = 'ok', gemini = { status: 200, body: { name: PASS } }, settings = SETTINGS } = {}) {
  const taken = [];
  const limiter = { sessions: async () => 1, take: async (ip) => { taken.push(ip); return verdict; } };
  const fetchImpl = async () => new Response(JSON.stringify(gemini.body), { status: gemini.status });
  const assets = { '/widget/main.js': { type: 'text/javascript; charset=utf-8', body: 'export {};' } };
  return { taken, handle: createHandler({ settings, geminiKey: KEY, limiter, fetchImpl, assets, log: quiet }) };
}
const req = (path, { method = 'GET', origin, ip } = {}) => new Request(`https://document-agent.x.workers.dev${path}`, {
  method, headers: { ...(origin ? { origin } : {}), ...(ip ? { 'cf-connecting-ip': ip } : {}) },
});
async function secretFree(res) {
  const text = await res.clone().text();
  assert.ok(!text.includes(KEY));
  assert.ok(![...res.headers.values()].some((v) => v.includes(KEY)));
  return text ? JSON.parse(text) : null;
}

test('health', async () => {
  const res = await make().handle(req('/health', { origin: SITE }));
  assert.deepEqual(await secretFree(res), { ok: true, sessions: 1, maxSessions: 3 });
  assert.equal(res.headers.get('access-control-allow-origin'), SITE);
  assert.equal((await (await make({ settings: { ...SETTINGS, ready: false } }).handle(req('/health'))).json()).ok, false);
});

test('/document-agent prefix works like the root', async () => {
  assert.equal((await (await make().handle(req('/document-agent/health'))).json()).ok, true);
  assert.equal((await make().handle(req('/document-agent/widget/main.js'))).status, 200);
});

test('token for a listed website, with CORS', async () => {
  const m = make();
  const res = await m.handle(req('/token', { method: 'POST', origin: SITE, ip: '1.2.3.4' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await secretFree(res), { token: PASS, model: 'gemini-3.1-flash-live-preview' });
  assert.equal(res.headers.get('access-control-allow-origin'), SITE);
  assert.deepEqual(m.taken, ['1.2.3.4']);
});

test('token refusals', async () => {
  let res = await make().handle(req('/token', { method: 'POST', origin: 'https://evil.example' }));
  assert.equal(res.status, 403); assert.equal((await res.json()).error, 'origin');
  res = await make({ verdict: 'busy' }).handle(req('/token', { method: 'POST', origin: SITE }));
  assert.equal(res.status, 503); assert.equal((await res.json()).error, 'busy');
  res = await make({ verdict: 'rate' }).handle(req('/token', { method: 'POST', origin: SITE }));
  assert.equal(res.status, 429); assert.equal((await res.json()).error, 'rate');
  res = await make({ settings: { ...SETTINGS, ready: false } }).handle(req('/token', { method: 'POST', origin: SITE }));
  assert.equal(res.status, 503); assert.equal((await res.json()).error, 'offline');
});

test('Gemini error gives 502 and never leaks the key', async () => {
  const res = await make({ gemini: { status: 400, body: { error: { message: `bad key ${KEY}` } } } }).handle(req('/token', { method: 'POST', origin: SITE }));
  assert.equal(res.status, 502);
  assert.deepEqual(await secretFree(res), { error: 'gemini' });
});

test('preflight and widget files', async () => {
  const pre = await make().handle(req('/token', { method: 'OPTIONS', origin: SITE }));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-methods'), 'POST');
  const w = await make().handle(req('/widget/main.js'));
  assert.equal(w.headers.get('access-control-allow-origin'), '*');
  assert.equal(await w.text(), 'export {};');
  assert.equal((await make().handle(req('/setup'))).status, 404);
});
