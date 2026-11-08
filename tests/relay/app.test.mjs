import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../../relay/store.js';
import { createLimits } from '../../relay/limits.js';
import { createApp } from '../../relay/app.js';
import { PDFDocument } from 'pdf-lib';

async function makePdf(n) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage();
  return Buffer.from(await doc.save());
}
const PDF3 = await makePdf(3);

const KEY = ['fake', 'test', 'key', '4f2a'].join('-');
const SITE = 'https://example.com';
const bodies = [];
const sentPdfs = [];

async function start({ pdfFails = false, deploy, pdfText = 'PDF document text' } = {}) {
  const store = createStore(mkdtempSync(join(tmpdir(), 'cva-app-')));
  const makeClient = () => ({
    authTokens: { create: async () => ({ name: ['auth_tokens', 't1'].join('/') }) },
    models: {
      generateContent: async (req) => { sentPdfs.push(Buffer.from(req.contents[0].inlineData.data, 'base64')); if (pdfFails) throw new Error(`bad key ${KEY}`); return { text: pdfText }; },
      countTokens: async ({ contents }) => ({ totalTokens: contents.split(/\s+/).filter(Boolean).length }),
    },
  });
  const fetchImpl = async () => new Response(JSON.stringify({ name: ['auth_tokens', 't1'].join('/') }), { status: 200 });
  const server = http.createServer(createApp({ store, limits: createLimits(), makeClient, fetchImpl, deploy, log: { error() {}, log() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, opts = {}) => {
    const res = await fetch(base + path, { redirect: 'manual', ...opts });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, text, headers: res.headers, json: () => JSON.parse(text) };
  };
  return { store, call, base, close: () => server.close() };
}

function setupForm(fields, file) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  if (file) f.set('docFile', new Blob([file.data], { type: file.type }), file.name);
  return f;
}

const SETUP = { apiKey: KEY, name: 'Ana', docText: 'Robotics engineer', origins: SITE, voice: 'Despina', maxSessions: '3' };

test('setup, health, token and secrecy', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('/health')).json().ok, false);
    assert.ok((await s.call('/setup')).text.includes('Not ready yet: add your Gemini key and your document'));
    assert.equal((await s.call('/token', { method: 'POST', headers: { origin: 'http://localhost:3000' } })).json().error, 'offline');

    const saved = await s.call('/setup', { method: 'POST', body: setupForm(SETUP) });
    assert.equal(saved.status, 303);
    const h = await s.call('/health', { headers: { origin: SITE } });
    assert.deepEqual(h.json(), { ok: true, sessions: 0, maxSessions: 3 });
    assert.equal(h.headers.get('access-control-allow-origin'), SITE);

    const page = await s.call('/setup');
    assert.ok(page.text.includes('Ready: the eye is live'));
    assert.ok(page.text.includes('…4f2a'));
    assert.ok(!page.text.includes(KEY));

    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, apiKey: '', instructions: 'Ten years consulting' }) });
    assert.equal(s.store.get().instructions, 'Ten years consulting');
    assert.ok((await s.call('/setup')).text.includes('>Ten years consulting</textarea>'));
    // Saving again with an empty key keeps the key.
    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, apiKey: '' }) });
    assert.equal(s.store.get().apiKey, KEY);

    const t = await s.call('/token', { method: 'POST', headers: { origin: SITE } });
    assert.equal(t.status, 200);
    assert.deepEqual(t.json(), { token: ['auth_tokens', 't1'].join('/'), model: 'gemini-3.1-flash-live-preview' });

    for (const origin of ['https://evil.example', 'null', undefined]) {
      const r = await s.call('/token', { method: 'POST', headers: origin ? { origin } : {} });
      assert.equal(r.status, 403, String(origin));
    }

    await s.call('/token', { method: 'POST', headers: { origin: SITE, 'cf-connecting-ip': '1.1.1.1' } });
    await s.call('/token', { method: 'POST', headers: { origin: SITE, 'cf-connecting-ip': '1.1.1.2' } });
    const busy = await s.call('/token', { method: 'POST', headers: { origin: SITE, 'cf-connecting-ip': '1.1.1.3' } });
    assert.equal(busy.status, 503);
    assert.equal(busy.json().error, 'busy');
    assert.equal((await s.call('/health')).json().sessions, 3);

    const demo = await s.call('/');
    assert.ok(demo.text.includes('Robotics engineer'));
    assert.ok(demo.text.includes('src="/widget.js"'));
  } finally { s.close(); }
});

test('setup is hidden behind a proxy or tunnel', async () => {
  const s = await start();
  try {
    for (const h of [{ 'x-forwarded-for': '8.8.8.8' }, { 'cf-connecting-ip': '8.8.8.8' }, { forwarded: 'for=8.8.8.8' }]) {
      assert.equal((await s.call('/setup', { headers: h })).status, 404);
      assert.equal((await s.call('/setup', { method: 'POST', headers: h, body: setupForm(SETUP) })).status, 404);
    }
    assert.equal(s.store.get().apiKey, '');
    assert.ok(!(await s.call('/', { headers: { 'x-forwarded-for': '8.8.8.8' } })).text.includes('/setup'));
  } finally { s.close(); }
});

test('a PDF Gemini cannot read keeps the old CV', async () => {
  const s = await start({ pdfFails: true });
  try {
    await s.call('/setup', { method: 'POST', body: setupForm(SETUP) });
    const r = await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, apiKey: '' }, { data: PDF3, type: 'application/pdf', name: 'cv.pdf' }) });
    assert.equal(r.status, 400);
    assert.ok(r.text.includes('your document was not changed'));
    assert.ok(r.text.includes('the key was not accepted') === false);
    assert.equal(s.store.get().docText, 'Robotics engineer');
    const bad = await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, apiKey: '' }, { data: 'x', type: 'application/msword', name: 'cv.doc' }) });
    assert.ok(bad.text.includes('PDF or a text file'));
  } finally { s.close(); }
});

test('a CV that cannot be read still saves the key', async () => {
  const s = await start({ pdfFails: true });
  try {
    const r = await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, docText: '' }, { data: PDF3, type: 'application/pdf', name: 'cv.pdf' }) });
    assert.equal(r.status, 400);
    assert.ok(r.text.includes('Your other settings were saved'));
    assert.ok(!r.text.includes(KEY));
    assert.equal(s.store.get().apiKey, KEY);
    assert.equal(s.store.get().name, 'Ana');
    assert.ok(r.text.includes('Not ready yet: add your document.'));
  } finally { s.close(); }
});

test('a PDF upload replaces the CV text', async () => {
  const s = await start();
  try {
    await s.call('/setup', { method: 'POST', body: setupForm(SETUP, { data: PDF3, type: 'application/pdf', name: 'cv.pdf' }) });
    assert.equal(s.store.get().docText, 'PDF document text');
  } finally { s.close(); }
});

test('network visitors are sent to the secure page, this computer is not', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'cva-app-')));
  const server = http.createServer(createApp({ store, limits: createLimits(), makeClient: () => ({}), httpsPort: 8791, log: { error() {}, log() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = (host) => new Promise((resolve) => http.get({ port, path: '/', headers: { host } }, (res) => { res.resume(); resolve(res); }));
  try {
    const away = await get('192.168.1.50:8790');
    assert.equal(away.statusCode, 302);
    assert.equal(away.headers.location, 'https://192.168.1.50:8791/');
    assert.equal((await get('localhost:8790')).statusCode, 200);
    assert.equal((await get('127.0.0.1:8790')).statusCode, 200);
    // Through a Cloudflare Tunnel the visitor is already on HTTPS: no redirect.
    const viaTunnel = await new Promise((resolve) => http.get({ port, path: '/', headers: { host: 'document-agent.example.com', 'cf-connecting-ip': '8.8.8.8' } }, (res) => { res.resume(); resolve(res); }));
    assert.equal(viaTunnel.statusCode, 200);
  } finally { server.close(); }
});

test('widget files are served, nothing else', async () => {
  const s = await start();
  try {
    const w = await s.call('/widget.js');
    assert.equal(w.status, 200);
    assert.match(w.headers.get('content-type'), /text\/javascript/);
    assert.equal((await s.call('/widget/../relay/store.js')).status, 404);
    assert.equal((await s.call('/widget/%2e%2e/package.json')).status, 404);
    assert.equal((await s.call('/data/config.json')).status, 404);
  } finally { s.close(); }
});

test('voice samples are ready-made files', async () => {
  const s = await start();
  try {
    const { VOICES } = await import('../../relay/gemini.js');
    for (const v of VOICES) {
      const r = await fetch(`${s.base}/voices/${v}.mp3`);
      assert.equal(r.status, 200, v);
      assert.equal(r.headers.get('content-type'), 'audio/mpeg');
      assert.ok((await r.arrayBuffer()).byteLength > 10000, v);
    }
    assert.equal((await s.call('/voices/Nobody.mp3')).status, 404);
    assert.equal((await s.call('/voices/..%2Fpackage.json')).status, 404);
    assert.equal((await s.call('/setup/voice', { method: 'POST', body: '{}' })).status, 404);
    const page = (await s.call('/setup')).text;
    assert.ok(page.includes('Listen') && page.includes("'/voices/'"));
  } finally { s.close(); }
});

test('no response ever contained the key', () => {
  assert.ok(bodies.length > 10);
  for (const b of bodies) assert.ok(!b.includes(KEY));
});

const CFT = ['fake', 'cf', 'token', '9z9z'].join('-');

function fakeDeploy({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    deployToCloudflare: async ({ cfg }) => { calls.push(['send', cfg]); if (fail) throw new Error(fail); return { url: `https://${cfg.workerName}.ana.workers.dev` }; },
    removeFromCloudflare: async ({ cfg, name }) => { calls.push(['remove', cfg, name ?? cfg.cfWorker ?? cfg.workerName]); },
  };
}

test('Send to Cloudflare uses the saved settings and shows the address and the script line', async () => {
  const d = fakeDeploy();
  const s = await start({ deploy: d });
  try {
    let page = await s.call('/setup');
    assert.ok(page.text.includes('Send to Cloudflare'));
    assert.ok(page.text.includes('Cloudflare: needed to use the assistant on your website'));
    assert.ok(!page.text.includes('Cloudflare (optional)'));
    assert.ok(!page.text.includes('Remove from Cloudflare'));
    assert.ok(page.text.includes('<b>Edit Cloudflare Workers</b> press <b>Use template</b>'));
    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, cfAccountId: 'acc123', cfToken: CFT, action: 'cloudflare-send' }) });
    assert.equal(d.calls.length, 1);
    assert.equal(d.calls[0][1].cfToken, CFT);
    assert.equal(d.calls[0][1].apiKey, KEY);
    assert.equal(d.calls[0][1].cfAccountId, 'acc123');
    assert.equal(s.store.get().cfUrl, 'https://document-agent.ana.workers.dev');
    assert.ok(s.store.get().cfUpdatedAt);
    page = await s.call('/setup');
    assert.ok(page.text.includes('Running on Cloudflare at'));
    assert.ok(page.text.includes('&lt;script type=&quot;module&quot; src=&quot;https://document-agent.ana.workers.dev/widget.js&quot;&gt;&lt;/script&gt;'));
    assert.ok(page.text.includes('…9z9z'));
    assert.ok(page.text.includes('Remove from Cloudflare'));
    // The token never appears in any page or response.
    assert.ok(!bodies.some((b) => b.includes(CFT)));
  } finally { s.close(); }
});

test('a plain save updates Cloudflare only when connected, and keeps the token', async () => {
  const d = fakeDeploy();
  const s = await start({ deploy: d });
  try {
    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, cfAccountId: 'acc123', cfToken: CFT }) });
    assert.equal(d.calls.length, 0);
    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, cfAccountId: 'acc123', action: 'cloudflare-send' }) });
    assert.equal(d.calls.length, 1);
    assert.equal(d.calls[0][1].cfToken, CFT);
    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, cfAccountId: 'acc123', instructions: 'New notes' }) });
    assert.equal(d.calls.length, 2);
    assert.equal(d.calls[1][1].instructions, 'New notes');
  } finally { s.close(); }
});

test('a Cloudflare failure keeps the local settings and shows the reason', async () => {
  const d = fakeDeploy({ fail: `The Cloudflare token was not accepted ${CFT}` });
  const s = await start({ deploy: d });
  try {
    const r = await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, cfAccountId: 'acc123', cfToken: CFT, action: 'cloudflare-send' }) });
    assert.equal(r.status, 303);
    assert.equal(s.store.get().name, 'Ana');
    assert.equal(s.store.get().cfUrl, '');
    const page = await s.call('/setup');
    assert.ok(page.text.includes('Cloudflare was not updated: The Cloudflare token was not accepted [token]'));
    assert.ok(!bodies.some((b) => b.includes(CFT)));
  } finally { s.close(); }
});

test('Remove from Cloudflare clears the address', async () => {
  const d = fakeDeploy();
  const s = await start({ deploy: d });
  try {
    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, cfAccountId: 'acc123', cfToken: CFT, action: 'cloudflare-send' }) });
    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, cfAccountId: 'acc123', action: 'cloudflare-remove' }) });
    assert.deepEqual(d.calls.map((c) => c[0]), ['send', 'remove']);
    assert.equal(s.store.get().cfUrl, '');
    assert.ok((await s.call('/setup')).text.includes('Send to Cloudflare'));
  } finally { s.close(); }
});

test('Cloudflare actions are refused from outside the home network', async () => {
  const d = fakeDeploy();
  const s = await start({ deploy: d });
  try {
    const r = await s.call('/setup', { method: 'POST', headers: { 'cf-connecting-ip': '8.8.8.8' }, body: setupForm({ ...SETUP, cfAccountId: 'acc123', cfToken: CFT, action: 'cloudflare-send' }) });
    assert.equal(r.status, 404);
    assert.equal(d.calls.length, 0);
  } finally { s.close(); }
});

test('worker name is checked; instructions are cut to 4000 and may be cleared', async () => {
  const s = await start();
  try {
    let r = await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, workerName: 'My Agent', name: 'Cy' }) });
    assert.equal(r.status, 400);
    assert.ok(r.text.includes('Worker name: use lowercase letters, numbers and dashes.'));
    assert.equal(s.store.get().workerName, 'document-agent');
    assert.equal(s.store.get().name, 'Cy');
    r = await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, workerName: 'ana-cv-2' }) });
    assert.equal(r.status, 303);
    assert.equal(s.store.get().workerName, 'ana-cv-2');
    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, instructions: 'x'.repeat(5000) }) });
    assert.equal(s.store.get().instructions.length, 4000);
    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, instructions: '' }) });
    assert.equal(s.store.get().instructions, '');
  } finally { s.close(); }
});

test('setup page speaks of a document and starts with the example instructions', async () => {
  const { DEFAULT_INSTRUCTIONS } = await import('../../relay/document.js');
  const s = await start();
  try {
    const page = (await s.call('/setup')).text;
    for (const p of ['Your document', 'Instructions for the agent', 'Worker name', 'value="document-agent"', '3 is the most a free Gemini key allows']) assert.ok(page.includes(p), p);
    const esc = DEFAULT_INSTRUCTIONS.replaceAll("'", '&#39;');
    assert.ok(page.includes(esc) || page.includes(DEFAULT_INSTRUCTIONS), 'example in the box');
    const withoutExample = page.replace(esc, '').replace(DEFAULT_INSTRUCTIONS, '');
    assert.doesNotMatch(withoutExample, /\bCV\b/);
    const demo = (await s.call('/')).text;
    assert.doesNotMatch(demo, /\bCV\b/);
  } finally { s.close(); }
});

test('a new worker name uploads the new worker and removes the old one', async () => {
  const d = fakeDeploy();
  const s = await start({ deploy: d });
  try {
    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, cfAccountId: 'acc123', cfToken: CFT, workerName: 'old-name', action: 'cloudflare-send' }) });
    assert.equal(s.store.get().cfWorker, 'old-name');
    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, cfAccountId: 'acc123', workerName: 'new-name' }) });
    assert.deepEqual(d.calls.map((c) => [c[0], c[0] === 'send' ? c[1].workerName : c[2]]), [['send', 'old-name'], ['send', 'new-name'], ['remove', 'old-name']]);
    assert.equal(s.store.get().cfWorker, 'new-name');
    assert.equal(s.store.get().cfUrl, 'https://new-name.ana.workers.dev');
    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, cfAccountId: 'acc123', workerName: 'new-name', action: 'cloudflare-remove' }) });
    assert.deepEqual(d.calls.at(-1).slice(0, 1).concat(d.calls.at(-1)[2]), ['remove', 'new-name']);
    assert.equal(s.store.get().cfWorker, '');
    assert.equal(s.store.get().cfUrl, '');
  } finally { s.close(); }
});

const wordsDoc = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

test('a long pasted document is cut to 32,000 tokens with a warning that stays on the page', async () => {
  const s = await start();
  try {
    const r = await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, docText: wordsDoc(40000) }) });
    assert.equal(r.status, 303);
    const cfg = s.store.get();
    assert.ok(cfg.docTokens <= 32000 && cfg.docTokens > 31000);
    assert.ok(wordsDoc(40000).startsWith(cfg.docText));
    const page = (await s.call('/setup')).text;
    assert.ok(page.includes('Your document was 40,000 tokens. The free Gemini plan works with up to 32,000 tokens, so it was cut to'));
    assert.ok(page.includes('Ready: the eye is live'));
    assert.equal((await s.call('/health')).json().ok, true);
  } finally { s.close(); }
});

test('a document between 30,000 and 32,000 tokens is kept whole, with a warning; a short one has none', async () => {
  const s = await start();
  try {
    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, docText: wordsDoc(31000) }) });
    assert.equal(s.store.get().docTokens, 31000);
    assert.ok((await s.call('/setup')).text.includes('Your document is 31,000 tokens, close to the 32,000-token limit of the free Gemini plan.'));
    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, docText: 'short text' }) });
    assert.equal(s.store.get().docTokens, 2);
    assert.equal(s.store.get().docNotice, '');
    assert.ok(!(await s.call('/setup')).text.includes('free Gemini plan works'));
  } finally { s.close(); }
});

test('an uploaded or PDF document is fitted too', async () => {
  const s = await start({ pdfText: wordsDoc(33000) });
  try {
    await s.call('/setup', { method: 'POST', body: setupForm(SETUP) });
    await s.call('/setup', { method: 'POST', body: setupForm(SETUP, { data: wordsDoc(35000), type: 'text/plain', name: 'big.txt' }) });
    assert.ok(s.store.get().docTokens <= 32000);
    assert.match(s.store.get().docNotice, /was 35,000 tokens/);
    await s.call('/setup', { method: 'POST', body: setupForm(SETUP, { data: PDF3, type: 'application/pdf', name: 'a.pdf' }) });
    assert.match(s.store.get().docNotice, /was 33,000 tokens/);
  } finally { s.close(); }
});

test('a saved document never counted is not ready until saved again', async () => {
  const s = await start();
  try {
    await s.call('/setup', { method: 'POST', body: setupForm(SETUP) });
    s.store.set({ docText: 'x'.repeat(263677), docTokens: 0, docNotice: '' });
    assert.ok((await s.call('/setup')).text.includes('Not ready yet: press Save so your document can be checked against the free plan\'s 32,000-token limit.'));
    assert.equal((await s.call('/health')).json().ok, false);
    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, docText: s.store.get().docText }) });
    assert.equal((await s.call('/health')).json().ok, true);
  } finally { s.close(); }
});

test('PDF pages: only the chosen pages are read, and changing them re-reads the saved PDF', async () => {
  const s = await start();
  const pagesSent = async () => (await PDFDocument.load(sentPdfs.at(-1))).getPageCount();
  try {
    const PDF10 = await makePdf(10);
    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, pageFrom: '3', pageTo: '7' }, { data: PDF10, type: 'application/pdf', name: 'book.pdf' }) });
    assert.equal(await pagesSent(), 5);
    let cfg = s.store.get();
    assert.deepEqual([cfg.pageFrom, cfg.pageTo, cfg.pdfTotal, cfg.docPdf], [3, 7, 10, true]);
    let page = (await s.call('/setup')).text;
    assert.ok(page.includes('Your PDF has 10 pages; the agent uses pages 3 to 7.'));
    assert.ok(page.includes('id="pageFrom" name="pageFrom" type="number" min="1" value="3"'));
    const before = sentPdfs.length;
    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, docText: cfg.docText, pageFrom: '2', pageTo: '' }) });
    assert.equal(sentPdfs.length, before + 1);
    assert.equal(await pagesSent(), 9);
    cfg = s.store.get();
    assert.deepEqual([cfg.pageFrom, cfg.pageTo], [2, 0]);
    // Saving again with the same pages does not read it again.
    await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, docText: cfg.docText, pageFrom: '2', pageTo: '' }) });
    assert.equal(sentPdfs.length, before + 1);
    const bad = await s.call('/setup', { method: 'POST', body: setupForm({ ...SETUP, docText: cfg.docText, pageFrom: '12' }) });
    assert.equal(bad.status, 400);
    assert.ok(bad.text.includes('your document was not changed. The PDF has 10 pages, so it cannot start at page 12.'));
  } finally { s.close(); }
});
