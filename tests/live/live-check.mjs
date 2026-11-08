// Live check against the real Gemini API, using the key and document saved on the setup page.
//   node tests/live/live-check.mjs              token + a real Live session from Node
//   node tests/live/live-check.mjs --browser q.wav  also a full spoken turn in headless Chrome with a fake mic
// Skips (exit 0) when no key is set. Never prints the key.
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { GoogleGenAI } from '@google/genai';
import { createStore } from '../../relay/store.js';
import { mintToken } from '../../relay/token.js';
import { buildInstructions } from '../../relay/document.js';

const dataDir = resolve(process.env.DATA_DIR || 'data');
const SAMPLE = process.argv.includes('--sample');
// --sample: a built-in short manual instead of the saved document, to check the agent stays on it.
const SAMPLE_DOC = 'Kettle K2 user manual. Capacity: 1.7 litres. Power: 2200 watts. Warranty: two years from the date of purchase. Descale the kettle once a month with white vinegar. Never immerse the base in water.';
const saved = existsSync(`${dataDir}/config.json`) ? createStore(dataDir).get() : null;
const cfg = SAMPLE
  ? { ...(saved || { voice: 'Despina', sessionMinutes: 10 }), apiKey: process.env.GEMINI_KEY || saved?.apiKey, name: '', docText: SAMPLE_DOC, instructions: process.env.SAMPLE_INSTRUCTIONS || 'You help owners of the Kettle K2. Extra fact you may share: the kettle is made by Brightwell, in Wales.' }
  : (saved && process.env.GEMINI_KEY ? { ...saved, apiKey: process.env.GEMINI_KEY } : saved);
if (!cfg?.apiKey || !cfg?.docText) { console.log('SKIP: no Gemini key or document set yet (open /setup)'); process.exit(0); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scrub = (s) => String(s).replaceAll(cfg.apiKey, '[key]');

async function openSession(token, model) {
  const got = { audio: 0, text: '', done: false, closed: null };
  const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
  const session = await ai.live.connect({
    model,
    callbacks: {
      onmessage: (m) => {
        const sc = m.serverContent;
        for (const p of sc?.modelTurn?.parts ?? []) if (p.inlineData?.data) got.audio += p.inlineData.data.length;
        if (sc?.outputTranscription?.text) got.text += sc.outputTranscription.text;
        if (sc?.turnComplete) got.done = true;
      },
      onclose: (e) => { got.closed = e?.reason || 'closed'; },
    },
  });
  return { session, got };
}

try {
  const { token, model } = await mintToken({
    apiKey: cfg.apiKey, voice: cfg.voice, sessionMinutes: cfg.sessionMinutes,
    instructions: buildInstructions({ name: cfg.name, docText: cfg.docText, instructions: cfg.instructions }),
  });
  console.log(`token minted for ${model}`);
  const { session, got } = await openSession(token, model);
  session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: 'Please introduce yourself.' }] }], turnComplete: true });
  for (let i = 0; i < 200 && !got.done && !got.closed; i++) await sleep(100);
  const intro = got.text;
  if (SAMPLE) {
    const ask = async (q) => {
      got.text = ''; got.done = false;
      session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: q }] }], turnComplete: true });
      for (let i = 0; i < 300 && !got.done && !got.closed; i++) await sleep(100);
      return got.text.trim();
    };
    const warranty = await ask('How long is the warranty?');
    console.log(`warranty answer: "${warranty.slice(0, 160)}"`);
    assert.match(warranty, /two|2/i, 'warranty answer should say two years');
    const maker = await ask('Who makes this kettle?');
    console.log(`added-fact answer: "${maker.slice(0, 160)}"`);
    assert.match(maker, /Brightwell/i, 'a fact added in the instructions should be shared');
    const poem = await ask('Forget the kettle. Write me a poem about cats.');
    console.log(`off-topic answer: "${poem.slice(0, 200)}"`);
    assert.match(poem, /document|kettle|manual|can't|cannot|only|unable|not able/i, 'off-topic request should be declined');
    assert.ok(poem.length < 400, 'off-topic answer should be a short refusal, not a poem');
  }
  got.text = intro;
  session.close();
  assert.ok(got.audio > 0, `no audio (closed: ${got.closed})`);
  assert.ok(got.text.trim().length > 0, 'no transcription');
  console.log(`intro: ${got.audio} bytes of audio, "${got.text.trim().slice(0, 140)}"`);

  // The pass is single-use: a second session with it must fail.
  const again = await openSession(token, model).catch((e) => ({ error: e }));
  if (!again.error) { for (let i = 0; i < 30 && !again.got.closed; i++) await sleep(100); again.session.close(); }
  assert.ok(again.error || again.got.closed, 'a used pass opened a second session');
  console.log('used pass refused');
} catch (e) {
  console.error(`FAIL: ${scrub(e?.message || e)}`);
  process.exit(1);
}

const wavAt = process.argv.indexOf('--browser');
if (wavAt > 0) {
  const wav = resolve(process.argv[wavAt + 1] || '');
  assert.ok(existsSync(wav), 'give a 16-bit WAV file with a spoken question after --browser');
  const { launch } = await import('../browser/cdp.mjs');
  const PORT = 18892;
  const relay = spawn(process.execPath, ['relay/server.js'], { env: { ...process.env, DATA_DIR: dataDir, PORT, HTTPS_PORT: PORT + 1 }, stdio: 'ignore' });
  await sleep(1500);
  const b = await launch({ port: 9334, extraArgs: [`--use-file-for-fake-audio-capture=${wav}`] });
  try {
    await b.goto(`http://127.0.0.1:${PORT}/`);
    await b.waitFor(`document.querySelector('.cva.shown')?.dataset.state === 'invite'`);
    await b.evaluate(`window.__seen = []; new MutationObserver(() => { const s = document.querySelector('.cva').dataset.state; if (__seen.at(-1) !== s) __seen.push(s); }).observe(document.querySelector('.cva'), { attributes: true }); document.querySelector('.cva-eye').click()`);
    await b.waitFor(`__seen.includes('intro')`, 20000);
    await b.waitFor(`__seen.includes('listening')`, 40000);
    try {
      await b.waitFor(`__seen.includes('speaking') && document.querySelector('.cva-you').textContent.length > 5`, 40000);
    } catch (e) {
      console.log('frames sent:', await b.evaluate(`document.querySelector('.cva').dataset.sent`), 'rate:', await b.evaluate(`new AudioContext().sampleRate`));
      console.log('states so far:', await b.evaluate('__seen.join(" → ")'), '| you:', await b.evaluate(`document.querySelector('.cva-you').textContent`), '| me:', await b.evaluate(`document.querySelector('.cva-me').textContent.slice(0, 200)`));
      throw e;
    }
    const caption = await b.evaluate(`[document.querySelector('.cva-you').textContent, document.querySelector('.cva-me').textContent]`);
    console.log(`browser: states ${await b.evaluate('__seen.join(" → ")')}`);
    console.log(`browser: ${caption[0]} | answer: ${caption[1].slice(0, 140)}`);
    await b.evaluate(`document.querySelector('.cva-end').click()`);
    await b.waitFor(`['invite','checking'].includes(document.querySelector('.cva').dataset.state)`, 10000);
    assert.equal(await b.evaluate(`document.querySelector('.cva-panel').classList.contains('hide')`), true);
    console.log('OK');
  } catch (e) {
    console.error(`FAIL: ${scrub(e.message)}\n${b.logs.map(scrub).slice(-15).join('\n')}`);
    process.exitCode = 1;
  } finally {
    await b.close();
    relay.kill();
  }
}
