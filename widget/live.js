// One spoken conversation with Gemini Live, using a single-use pass from the relay.
import { fetchToken } from './relay.js';
import { downsampleTo16k, f32ToPcm16B64 } from './audio.js';

export const SDK_URL = 'https://esm.sh/@google/genai@3.0.0';
export const loadSdkFromCdn = () => import(/* webpackIgnore: true */ SDK_URL);

export function startLive({ base, loadSdk = loadSdkFromCdn, fetchImpl = fetch, on }) {
  let ended = false;
  let session = null;
  let goAway = false;
  let you = '', me = '';

  const emit = (ev) => { if (!ended || ev.type === 'closed') on(ev); };
  const finish = (reason) => {
    if (ended) return;
    ended = true;
    try { session?.close(); } catch { /* already closed */ }
    on({ type: 'closed', reason });
  };

  function onMessage(msg) {
    if (ended) return;
    if (msg.goAway) goAway = true;
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.interrupted) emit({ type: 'interrupted' });
    if (sc.inputTranscription?.text) { you += sc.inputTranscription.text; emit({ type: 'you', text: you.trim() }); }
    if (sc.outputTranscription?.text) { me += sc.outputTranscription.text; emit({ type: 'me', text: me.trim() }); }
    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) emit({ type: 'audio', data: part.inlineData.data });
    }
    if (sc.turnComplete) { emit({ type: 'turnDone' }); you = ''; me = ''; }
  }

  (async () => {
    const pass = await fetchToken(base, fetchImpl);
    if (ended) return;
    if (pass.error) return finish(pass.error === 'offline' ? 'offline' : 'busy');
    let sdk;
    try { sdk = await loadSdk(); } catch { return finish('offline'); }
    if (ended) return;
    try {
      const ai = new sdk.GoogleGenAI({ apiKey: pass.token, httpOptions: { apiVersion: 'v1alpha' } });
      const s = await ai.live.connect({
        model: pass.model,
        callbacks: {
          onmessage: onMessage,
          onerror: () => { /* onclose follows */ },
          onclose: () => finish(goAway ? 'limit' : 'dropped'),
        },
      });
      if (ended) { try { s.close(); } catch { /* closing */ } return; }
      session = s;
      emit({ type: 'ready' });
    } catch {
      finish('offline');
    }
  })();

  return {
    get ready() { return Boolean(session) && !ended; },
    intro() {
      if (!session || ended) return;
      session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: 'Please introduce yourself.' }] }], turnComplete: true });
    },
    sendAudio(f32, rate) {
      if (!session || ended) return;
      session.sendRealtimeInput({ audio: { data: f32ToPcm16B64(downsampleTo16k(f32, rate)), mimeType: 'audio/pcm;rate=16000' } });
    },
    end() { finish('user'); },
  };
}
