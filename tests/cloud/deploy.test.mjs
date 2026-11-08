import test from 'node:test';
import assert from 'node:assert/strict';
import { deployToCloudflare, removeFromCloudflare, buildUpload, readUploadFiles, settingsFor, MODULES } from '../../cloud/deploy.js';
import { DEFAULTS } from '../../relay/store.js';

const KEY = ['fake', 'gemini', 'key', '4f2a'].join('-');
const CFT = ['fake', 'cf', 'token', '9z9z'].join('-');
const CFG = { ...DEFAULTS, apiKey: KEY, name: 'Ana', docText: `Robotics engineer. ${'Long experience. '.repeat(1500)}`, docTokens: 5000, instructions: 'Lead with robots', origins: ['https://ana.github.io'], cfAccountId: 'acc123', cfToken: CFT };
const files = readUploadFiles();

// A fake Cloudflare: answers by "METHOD path" and records every call.
function fakeCloudflare(answers = {}) {
  const calls = [];
  const defaults = {
    'GET /workers/scripts/document-agent/settings': [200, { success: true, result: {} }],
    'GET /workers/subdomain': [200, { success: true, result: { subdomain: 'ana' } }],
    'PUT /workers/scripts/document-agent': [200, { success: true, result: {} }],
    'POST /workers/scripts/document-agent/subdomain': [200, { success: true, result: {} }],
    'DELETE /workers/scripts/document-agent': [200, { success: true, result: {} }],
  };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: String(url), init });
    const key = `${init.method} ${u.pathname.replace('/client/v4/accounts/acc123', '')}`;
    const [status, body] = answers[key] || defaults[key] || [404, { success: false, errors: [{ code: 10007, message: 'not found' }] }];
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}
const metadataOf = async (form) => JSON.parse(await form.get('metadata').text());

test('upload carries the modules, the secret, the settings and the counter', async () => {
  const form = buildUpload({ cfg: CFG, files });
  const meta = await metadataOf(form);
  assert.equal(meta.main_module, 'cloud/worker.js');
  assert.equal(meta.compatibility_date, '2026-10-01');
  assert.deepEqual(meta.bindings.find((b) => b.name === 'GEMINI_KEY'), { type: 'secret_text', name: 'GEMINI_KEY', text: KEY });
  assert.deepEqual(meta.bindings.find((b) => b.name === 'LIMITER'), { type: 'durable_object_namespace', name: 'LIMITER', class_name: 'Limiter' });
  assert.equal(meta.bindings.length, 2);
  assert.ok(meta.bindings.every((b) => (b.text || '').length < 5000), 'Cloudflare refuses text bindings over about 5 KB');
  const settingsJs = await form.get('cloud/settings.js').text();
  assert.match(settingsJs, /^export const settings = \{.*\};\n$/s);
  const settings = JSON.parse(settingsJs.slice('export const settings = '.length, -2));
  assert.deepEqual(settings, settingsFor(CFG));
  assert.ok(settings.instructions.includes('Robotics engineer') && settings.instructions.includes('Lead with robots'));
  assert.equal(settings.ready, true);
  assert.ok(!JSON.stringify(settings).includes(KEY) && !JSON.stringify(meta).includes(CFT));
  for (const m of [...MODULES, 'cloud/assets.js', 'cloud/settings.js']) assert.equal(form.get(m).type, 'application/javascript+module', m);
  const assets = await form.get('cloud/assets.js').text();
  assert.ok(assets.includes('/widget/main.js') && assets.includes('/widget.js') && assets.includes('"/"'));
  assert.ok(!assets.includes(KEY) && !assets.includes(CFT));
});

test('no uploaded module imports node: or @google/genai', async () => {
  const form = buildUpload({ cfg: CFG, files });
  for (const m of MODULES) {
    const text = await form.get(m).text();
    assert.ok(!/from\s+['"]node:|import\s+['"]node:|@google\/genai/.test(text), m);
  }
  // The assets module is data only (the widget files, which load Gemini's browser SDK themselves).
  assert.match(await form.get('cloud/assets.js').text(), /^export const assets = \{.*\};\n$/s);
});

test('adds migration on first upload', async () => {
  const cf = fakeCloudflare({ 'GET /workers/scripts/document-agent/settings': [404, { success: false, errors: [{ code: 10007, message: 'workers.api.error.script_not_found' }] }] });
  const out = await deployToCloudflare({ cfg: CFG, files, fetchImpl: cf.fetchImpl });
  assert.deepEqual(out, { url: 'https://document-agent.ana.workers.dev' });
  const put = cf.calls.find((c) => c.init.method === 'PUT');
  assert.deepEqual((await metadataOf(put.init.body)).migrations, { new_tag: 'v1', new_sqlite_classes: ['Limiter'] });
  const sub = cf.calls.find((c) => c.url.endsWith('/document-agent/subdomain'));
  assert.deepEqual(JSON.parse(sub.init.body), { enabled: true, previews_enabled: false });
});

test('omits migration when script exists', async () => {
  const cf = fakeCloudflare();
  await deployToCloudflare({ cfg: CFG, files, fetchImpl: cf.fetchImpl });
  const put = cf.calls.find((c) => c.init.method === 'PUT');
  assert.equal((await metadataOf(put.init.body)).migrations, undefined);
});

test('token goes only to Cloudflare, in the authorization header', async () => {
  const cf = fakeCloudflare();
  await deployToCloudflare({ cfg: CFG, files, fetchImpl: cf.fetchImpl });
  for (const c of cf.calls) {
    assert.ok(c.url.startsWith('https://api.cloudflare.com/client/v4/'));
    assert.ok(!c.url.includes(CFT));
    assert.equal(c.init.headers.authorization, `Bearer ${CFT}`);
  }
});

test('errors in plain words', async () => {
  const run = (answers) => deployToCloudflare({ cfg: CFG, files, fetchImpl: fakeCloudflare(answers).fetchImpl });
  await assert.rejects(run({ 'GET /workers/scripts/document-agent/settings': [403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }] }), /token was not accepted/);
  await assert.rejects(run({ 'GET /workers/scripts/document-agent/settings': [404, { success: false, errors: [{ code: 7003, message: 'Could not route to /accounts/acc123, perhaps your object identifier is invalid?' }] }] }), /account ID was not found/);
  await assert.rejects(run({ 'GET /workers/subdomain': [404, { success: false, errors: [{ code: 10007, message: 'not found' }] }] }), /Choose your free workers.dev name/);
  await assert.rejects(run({ 'GET /workers/subdomain': [200, { success: true, result: { subdomain: null } }] }), /Choose your free workers.dev name/);
  await assert.rejects(run({ 'PUT /workers/scripts/document-agent': [400, { success: false, errors: [{ code: 1, message: `odd ${CFT}` }] }] }), (e) => /Cloudflare said: odd \[token\]/.test(e.message) && !e.message.includes(CFT));
  await assert.rejects(deployToCloudflare({ cfg: { ...CFG, cfToken: '' }, files, fetchImpl: fakeCloudflare().fetchImpl }), /account ID and token first/);
  await assert.rejects(deployToCloudflare({ cfg: { ...CFG, cfToken: CFT }, files, fetchImpl: async () => { throw new Error('offline'); } }), /could not be reached/);
});

test('remove deletes the Worker, and a missing one is fine', async () => {
  const cf = fakeCloudflare();
  await removeFromCloudflare({ cfg: CFG, fetchImpl: cf.fetchImpl });
  assert.ok(cf.calls[0].url.endsWith('/workers/scripts/document-agent?force=true'));
  assert.equal(cf.calls[0].init.method, 'DELETE');
  await removeFromCloudflare({ cfg: CFG, fetchImpl: fakeCloudflare({ 'DELETE /workers/scripts/document-agent': [404, { success: false, errors: [{ code: 10007, message: 'not found' }] }] }).fetchImpl });
});

test('uses the chosen worker name everywhere', async () => {
  const cf = fakeCloudflare({
    'GET /workers/scripts/acme-help/settings': [200, { success: true, result: {} }],
    'PUT /workers/scripts/acme-help': [200, { success: true, result: {} }],
    'POST /workers/scripts/acme-help/subdomain': [200, { success: true, result: {} }],
  });
  const out = await deployToCloudflare({ cfg: { ...CFG, workerName: 'acme-help' }, files, fetchImpl: cf.fetchImpl });
  assert.deepEqual(out, { url: 'https://acme-help.ana.workers.dev' });
  assert.ok(cf.calls.some((c) => c.init.method === 'PUT' && c.url.endsWith('/workers/scripts/acme-help')));
  assert.ok(!cf.calls.some((c) => c.url.includes('document-agent')));
});

test('remove deletes the named worker', async () => {
  const cf = fakeCloudflare({ 'DELETE /workers/scripts/old-one': [200, { success: true, result: {} }] });
  await removeFromCloudflare({ cfg: CFG, name: 'old-one', fetchImpl: cf.fetchImpl });
  assert.ok(cf.calls[0].url.endsWith('/workers/scripts/old-one?force=true'));
});

test('a document is required, and the largest one still fits Cloudflare', async () => {
  await assert.rejects(deployToCloudflare({ cfg: { ...CFG, docText: '' }, files, fetchImpl: fakeCloudflare().fetchImpl }), /Add your Gemini key and your document first\./);
  const big = { ...CFG, docText: 'Ünïcode text. '.repeat(21429).slice(0, 200000), docTokens: 32000 };
  const form = buildUpload({ cfg: big, files });
  const settings = await form.get('cloud/settings.js').text();
  assert.ok(settings.includes('"ready":true') && settings.includes('Ünïcode text.'));
  let size = 0;
  for (const [, v] of form) size += typeof v === 'string' ? v.length : v.size;
  assert.ok(size < 3 * 1024 * 1024, `upload is ${size} bytes`);
});
