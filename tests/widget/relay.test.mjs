import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayBase, fetchHealth, fetchToken } from '../../widget/relay.js';

const reply = (status, body) => async () => new Response(JSON.stringify(body), { status });

test('relay address comes from the widget script address', () => {
  assert.equal(relayBase('https://x.example:8791/widget.js'), 'https://x.example:8791');
  assert.equal(relayBase('http://192.168.1.50:8790/widget.js?v=2'), 'http://192.168.1.50:8790');
});

test('relay address keeps a path, such as a Cloudflare Worker under /document-agent', () => {
  assert.equal(relayBase('https://document-agent.x.workers.dev/widget/main.js'), 'https://document-agent.x.workers.dev');
  assert.equal(relayBase('https://a.b/document-agent/widget/main.js'), 'https://a.b/document-agent');
  assert.equal(relayBase('https://a.b/document-agent/widget.js'), 'https://a.b/document-agent');
  assert.equal(relayBase('https://a.b/widget.js'), 'https://a.b');
});

test('a data-relay address is used as it is, without a trailing slash', () => {
  assert.equal(relayBase('https://document-agent.x.workers.dev'), 'https://document-agent.x.workers.dev');
  assert.equal(relayBase('https://document-agent.x.workers.dev/'), 'https://document-agent.x.workers.dev');
  assert.equal(relayBase('https://a.b/document-agent/'), 'https://a.b/document-agent');
});

test('health', async () => {
  assert.equal(await fetchHealth('http://r', reply(200, { ok: true, sessions: 0, maxSessions: 3 })), 'invite');
  assert.equal(await fetchHealth('http://r', reply(200, { ok: true, sessions: 3, maxSessions: 3 })), 'busy');
  assert.equal(await fetchHealth('http://r', async () => { throw new TypeError('network'); }), 'offline');
  const hang = (url, { signal }) => new Promise((_, reject) => {
    const keepAlive = setTimeout(() => {}, 5000); // a real network wait keeps the page alive; so does this
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); });
  });
  const t0 = Date.now();
  assert.equal(await fetchHealth('http://r', hang, 50), 'offline');
  assert.ok(Date.now() - t0 < 1000);
});

test('token', async () => {
  let seen;
  const ok = async (url, opts) => { seen = { url, opts }; return new Response(JSON.stringify({ token: 't', model: 'm' })); };
  assert.deepEqual(await fetchToken('http://r', ok), { token: 't', model: 'm' });
  assert.equal(seen.url, 'http://r/token');
  assert.equal(seen.opts.method, 'POST');
  assert.deepEqual(await fetchToken('http://r', reply(503, { error: 'busy' })), { error: 'busy' });
  assert.deepEqual(await fetchToken('http://r', reply(429, { error: 'rate' })), { error: 'rate' });
  assert.deepEqual(await fetchToken('http://r', async () => { throw new TypeError('x'); }), { error: 'offline' });
  assert.deepEqual(await fetchToken('http://r', async () => new Response('<html>', { status: 502 })), { error: 'offline' });
});
