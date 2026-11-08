import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleGenAI } from '@google/genai';
import { mintToken, tokenRequest, LIVE_MODEL } from '../../relay/token.js';

const KEY = ['fake', 'test', 'key', '4f2a'].join('-');
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const PASS = ['auth_tokens', 'abc'].join('/');

test('token request matches what the SDK sends', async () => {
  const realFetch = globalThis.fetch;
  let recorded;
  globalThis.fetch = async (url, init) => { recorded = { url: String(url), body: init.body }; return new Response(JSON.stringify({ name: PASS }), { headers: { 'content-type': 'application/json' } }); };
  try {
    const ai = new GoogleGenAI({ apiKey: KEY, httpOptions: { apiVersion: 'v1alpha' } });
    await ai.authTokens.create({ config: {
      uses: 1,
      expireTime: new Date(NOW + 10 * 60_000).toISOString(),
      newSessionExpireTime: new Date(NOW + 60_000).toISOString(),
      liveConnectConstraints: { model: LIVE_MODEL, config: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Umbriel' } } },
        systemInstruction: 'Speak about Ana.',
        inputAudioTranscription: {}, outputAudioTranscription: {},
      } },
      lockAdditionalFields: [],
      httpOptions: { apiVersion: 'v1alpha' },
    } });
  } finally { globalThis.fetch = realFetch; }
  const ours = tokenRequest({ voice: 'Umbriel', instructions: 'Speak about Ana.', sessionMinutes: 10 }, NOW);
  assert.equal(new URL(recorded.url).pathname, new URL(ours.url).pathname);
  assert.deepEqual(JSON.parse(recorded.body), ours.body);
});

test('token is single-use, short-lived and locked to the document', async () => {
  let sent;
  const fetchImpl = async (url, init) => { sent = { url, init }; return new Response(JSON.stringify({ name: PASS })); };
  const out = await mintToken({ apiKey: KEY, voice: 'Umbriel', instructions: 'Robotics engineer. Ten years consulting', sessionMinutes: 10, fetchImpl, now: () => NOW });
  assert.deepEqual(out, { token: PASS, model: LIVE_MODEL, expiresAt: new Date(NOW + 10 * 60_000).toISOString() });
  assert.ok(!JSON.stringify(out).includes(KEY));
  assert.equal(sent.init.headers['x-goog-api-key'], KEY);
  assert.ok(!sent.url.includes(KEY) && !sent.init.body.includes(KEY));
  const b = JSON.parse(sent.init.body);
  assert.equal(b.uses, 1);
  assert.equal(b.newSessionExpireTime, new Date(NOW + 60_000).toISOString());
  assert.equal(b.expireTime, new Date(NOW + 10 * 60_000).toISOString());
  const c = b.bidiGenerateContentSetup;
  assert.equal(c.model, `models/${LIVE_MODEL}`);
  assert.deepEqual(c.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(c.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Umbriel');
  assert.ok(c.systemInstruction.parts[0].text.includes('Robotics engineer'));
  assert.ok(c.systemInstruction.parts[0].text.includes('Ten years consulting'));
  assert.deepEqual(c.inputAudioTranscription, {});
  assert.deepEqual(c.outputAudioTranscription, {});
});

test('mintToken throws Gemini\'s message on 400', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 });
  await assert.rejects(mintToken({ apiKey: KEY, voice: 'Despina', instructions: 'x', sessionMinutes: 10, fetchImpl }), /API key not valid/);
});
