// Browser check: the eye appears on the demo page, its banner stays on one line, and it goes grey when the relay is down.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { launch } from './cdp.mjs';

const PORT = 18890;
const dataDir = mkdtempSync(join(tmpdir(), 'cva-browser-'));
writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ apiKey: ['fake', 'key', '0000'].join('-'), name: 'Ana Ruiz', docText: 'Robotics engineer.\n'.repeat(80) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const startRelay = async () => {
  const p = spawn(process.execPath, ['relay/server.js'], { env: { ...process.env, DATA_DIR: dataDir, PORT, HTTPS_PORT: PORT + 1 }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); return p; } catch { await sleep(100); } }
  throw new Error('relay did not start');
};

let relay = await startRelay();
const b = await launch();
try {
  for (const width of [1280, 390, 360]) {
    await b.goto(`http://127.0.0.1:${PORT}/`, width);
    await b.waitFor(`document.querySelector('.cva.shown')?.dataset.state === 'invite'`);
    const r = await b.evaluate(`(() => {
      const bub = document.querySelector('.cva-bubble'), eye = document.querySelector('.cva-eye');
      const lh = parseFloat(getComputedStyle(bub).fontSize) * 1.6 + 14;
      const e = eye.getBoundingClientRect(), bb = bub.getBoundingClientRect();
      return { text: bub.textContent, h: bb.height, lh, left: bb.left, eyeRight: e.right, eyeW: e.width,
               overflow: document.documentElement.scrollWidth > innerWidth };
    })()`);
    assert.equal(r.text, 'Click me to talk');
    assert.ok(r.h <= r.lh, `banner wraps at ${width}px (${r.h} > ${r.lh})`);
    assert.ok(r.left >= 0, `banner off screen at ${width}px`);
    assert.ok(r.eyeRight <= width, `eye off screen at ${width}px`);
    assert.equal(r.overflow, false, `horizontal scroll at ${width}px`);
    // Scrolling hides the banner and keeps the eye.
    await b.evaluate('scrollTo(0, 400)');
    await b.waitFor(`document.querySelector('.cva').classList.contains('scrolled') && getComputedStyle(document.querySelector('.cva-bubble')).display === 'none'`);
    console.log(`  ${width}px: eye ${r.eyeW}px, banner one line`);
  }
  await b.evaluate('scrollTo(0, 0)');
  relay.kill();
  await sleep(300);
  // With the relay down, a fresh look turns the eye grey.
  await b.evaluate(`document.querySelector('.cva-eye').click()`);
  await b.waitFor(`['offline'].includes(document.querySelector('.cva').dataset.state)`, 20000);
  assert.equal(await b.evaluate(`document.querySelector('.cva-bubble').textContent`), 'Assistant is offline');
  assert.equal(await b.evaluate(`document.querySelector('.cva-eye').getAttribute('aria-disabled')`), 'true');
  const errors = b.logs.filter((l) => l.startsWith('EXCEPTION'));
  assert.deepEqual(errors, []);
  console.log('OK');
} finally {
  relay.kill();
  await b.close();
}
