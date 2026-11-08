// Browser check: the widget copied onto a website shows a grey "offline" eye whenever the relay cannot be reached,
// and turns yellow again by itself when it comes back.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { launch } from './cdp.mjs';

const RELAY = 18920, SITE = 18921;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataDir = mkdtempSync(join(tmpdir(), 'cva-off-'));
writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ apiKey: ['fake', 'key'].join('-'), name: 'Ana', docText: 'Engineer.' }));

// A stand-in for the owner's website, hosting its own copy of the widget.
const site = mkdtempSync(join(tmpdir(), 'cva-site-'));
mkdirSync(join(site, 'document-agent'));
for (const f of readdirSync('widget')) copyFileSync(join('widget', f), join(site, 'document-agent', f));
writeFileSync(join(site, 'index.html'), `<!doctype html><meta charset="utf-8"><h1>My page</h1>
<script type="module" src="/document-agent/main.js" data-relay="http://127.0.0.1:${RELAY}" data-recheck-ms="1000"></script>`);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const web = http.createServer(async (req, res) => {
  const p = req.url === '/' ? '/index.html' : req.url;
  try { const b = await readFile(join(site, p)); res.writeHead(200, { 'content-type': types[p.slice(p.lastIndexOf('.'))] || 'text/plain' }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
}).listen(SITE, '127.0.0.1');

const startRelay = async () => {
  const p = spawn(process.execPath, ['relay/server.js'], { env: { ...process.env, DATA_DIR: dataDir, PORT: RELAY, HTTPS_PORT: RELAY + 2 }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${RELAY}/health`); return p; } catch { await sleep(100); } }
  throw new Error('relay did not start');
};
const state = `document.querySelector('.cva.shown')?.dataset.state`;
const bubble = `document.querySelector('.cva-bubble').textContent`;

const b = await launch({ port: 9339 });
let relay;
try {
  // Relay down from the start: the eye still appears, grey.
  await b.goto(`http://127.0.0.1:${SITE}/`);
  await b.waitFor(`${state} === 'offline'`, 10000);
  assert.equal(await b.evaluate(bubble), 'Assistant is offline');
  assert.equal(await b.evaluate(`document.querySelector('.cva-eye').getAttribute('aria-disabled')`), 'true');
  console.log('relay down at load: grey eye, "Assistant is offline"');
  // Relay comes up: yellow without reloading.
  relay = await startRelay();
  await b.waitFor(`${state} === 'invite'`, 10000);
  console.log('relay up: yellow eye');
  // Relay goes away while the page is open: grey again by itself.
  relay.kill();
  await b.waitFor(`${state} === 'offline'`, 10000);
  console.log('relay stopped: grey again');
  console.log('OK');
} finally {
  relay?.kill();
  web.close();
  await b.close();
}
