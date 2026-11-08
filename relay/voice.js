// A short spoken sample of a Gemini voice, so the owner can hear it before choosing.
import { LIVE_MODEL } from './gemini.js';
import { ACCENT } from './document.js';

export function pcm16ToWav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export const sampleLine = (name) =>
  `Hi! I'm ${name || 'the site owner'}'s AI assistant. Ask me anything about their experience.`;

// Uses the same live model and voice visitors will hear. Resolves to a WAV buffer.
export async function speakSample({ client, voice, name, text, timeoutMs = 20000 }) {
  const chunks = [];
  let done, fail;
  const finished = new Promise((res, rej) => { done = res; fail = rej; });
  finished.catch(() => {}); // a failure before connect() returns is reported by connect() itself
  const session = await client.live.connect({
    model: LIVE_MODEL,
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      systemInstruction: `Read the user's message aloud exactly as written, warmly and naturally. Say nothing else. ${ACCENT}`,
    },
    callbacks: {
      onmessage: (m) => {
        for (const p of m.serverContent?.modelTurn?.parts ?? []) if (p.inlineData?.data) chunks.push(Buffer.from(p.inlineData.data, 'base64'));
        if (m.serverContent?.turnComplete) done();
      },
      onerror: (e) => fail(new Error(e?.message || 'voice sample failed')),
      onclose: () => (chunks.length ? done() : fail(new Error('voice sample closed early'))),
    },
  });
  const timer = setTimeout(() => fail(new Error('voice sample timed out')), timeoutMs);
  try {
    session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: text ?? sampleLine(name) }] }], turnComplete: true });
    await finished;
  } finally {
    clearTimeout(timer);
    try { session.close(); } catch { /* closed */ }
  }
  if (!chunks.length) throw new Error('no audio');
  return pcm16ToWav(Buffer.concat(chunks));
}
