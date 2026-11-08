// A pass a visitor's browser can use once, for a few minutes, to talk to Gemini as the document agent.
// The same request is sent by the local relay and by the Cloudflare Worker, so this file imports nothing.
export const LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const TOKEN_URL = 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens';

// The JSON Google's own SDK sends for a one-use pass locked to the model, voice and instructions.
export function tokenRequest({ voice, instructions, sessionMinutes }, nowMs) {
  return {
    url: TOKEN_URL,
    body: {
      expireTime: new Date(nowMs + sessionMinutes * 60_000).toISOString(),
      newSessionExpireTime: new Date(nowMs + 60_000).toISOString(),
      uses: 1,
      bidiGenerateContentSetup: {
        model: `models/${LIVE_MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
        systemInstruction: { parts: [{ text: instructions }], role: 'user' },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      fieldMask: 'model,generationConfig.responseModalities,generationConfig.speechConfig,systemInstruction.parts,'
        + 'systemInstruction.role,inputAudioTranscription,outputAudioTranscription',
    },
  };
}

export async function mintToken({ apiKey, voice, instructions, sessionMinutes, fetchImpl = fetch, now = Date.now }) {
  const { url, body } = tokenRequest({ voice, instructions, sessionMinutes }, now());
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.name) throw new Error(data?.error?.message || `Gemini answered ${res.status}`);
  return { token: data.name, model: LIVE_MODEL, expiresAt: body.expireTime };
}
