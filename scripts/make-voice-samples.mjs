// Makes the voice samples the setup page plays (voices/<Voice>.mp3), using the key saved on the setup page.
// Run once: node scripts/make-voice-samples.mjs   (needs ffmpeg). The files go in the repository.
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../relay/store.js';
import { makeClient, VOICES, TEXT_MODEL } from '../relay/gemini.js';
import { speakSample } from '../relay/voice.js';

export const SAMPLE_TEXT = "Hi! I'm the AI assistant on this page. Ask me anything about the document it covers.";

const apiKey = process.env.GEMINI_KEY || createStore(process.env.DATA_DIR || 'data').get().apiKey;
if (!apiKey) { console.error('Save a Gemini key on the setup page first.'); process.exit(1); }
const client = makeClient(apiKey);
mkdirSync('voices', { recursive: true });
for (const voice of process.argv.slice(2).length ? process.argv.slice(2) : VOICES) {
  // Gemini's accent varies from take to take: keep the first take that a listening check hears as British.
  let wav, heard;
  for (let take = 1; take <= 4; take++) {
    wav = await speakSample({ client, voice, text: SAMPLE_TEXT });
    heard = (await client.models.generateContent({ model: TEXT_MODEL, contents: [
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } },
      { text: 'Which English accent does the speaker have? One word: British, American, or Other.' }] })).text.trim();
    if (/british/i.test(heard)) break;
  }
  console.log(`${voice}: heard as ${heard}`);
  const tmp = join(tmpdir(), `cva-${voice}.wav`);
  writeFileSync(tmp, wav);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, '-ac', '1', '-b:a', '48k', `voices/${voice}.mp3`]);
  unlinkSync(tmp);
  console.log(`voices/${voice}.mp3`);
}
