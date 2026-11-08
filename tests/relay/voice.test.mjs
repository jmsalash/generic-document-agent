import test from 'node:test';
import assert from 'node:assert/strict';
import { pcm16ToWav, speakSample, sampleLine } from '../../relay/voice.js';

test('WAV header for 24 kHz mono PCM16', () => {
  const wav = pcm16ToWav(Buffer.alloc(480), 24000);
  assert.equal(wav.length, 44 + 480);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), 480);
});

test('sample uses the chosen voice and joins the audio', async () => {
  let params, sent;
  const client = { live: { connect: async (p) => { params = p; return {
    sendClientContent: (c) => { sent = c; setTimeout(() => {
      p.callbacks.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(100).toString('base64') } }] } } });
      p.callbacks.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(60).toString('base64') } }] }, turnComplete: true } });
    }, 1); },
    close() {},
  }; } } };
  const wav = await speakSample({ client, voice: 'Puck', name: 'Ana' });
  assert.equal(params.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
  assert.ok(params.config.systemInstruction.includes('British Received Pronunciation'));
  assert.equal(sent.turns[0].parts[0].text, sampleLine('Ana'));
  assert.ok(sampleLine('Ana').includes("Ana's AI assistant"));
  assert.equal(wav.readUInt32LE(40), 160);
});

test('no audio is an error, not a hang', async () => {
  const client = { live: { connect: async (p) => ({ sendClientContent: () => setTimeout(() => p.callbacks.onclose(), 1), close() {} }) } };
  await assert.rejects(speakSample({ client, voice: 'Kore', name: '' }), /closed early/);
  const silent = { live: { connect: async () => ({ sendClientContent() {}, close() {} }) } };
  await assert.rejects(speakSample({ client: silent, voice: 'Kore', name: '', timeoutMs: 30 }), /timed out/);
});

test('an error before the connection opens rejects once and leaves nothing unhandled', async () => {
  const unhandled = [];
  const onU = (e) => unhandled.push(e);
  process.on('unhandledRejection', onU);
  const client = { live: { connect: async (p) => { p.callbacks.onerror({ message: 'Unexpected server response: 404' }); throw new Error('Live connection failed before setup completed'); } } };
  await assert.rejects(speakSample({ client, voice: 'Kore', name: '' }), /before setup completed/);
  await new Promise((r) => setTimeout(r, 20));
  process.off('unhandledRejection', onU);
  assert.deepEqual(unhandled, []);
});
