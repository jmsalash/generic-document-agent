// The pass service as it runs on Cloudflare: health, one-use Gemini passes and the widget files.
// It answers like the local relay. No node: imports: this file is uploaded to Cloudflare as it is.
import { originAllowed } from '../relay/limits.js';
import { mintToken } from '../relay/token.js';

const PREFIX = '/document-agent';

function json(status, body, headers = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

export function createHandler({ settings, geminiKey, limiter, fetchImpl = (...a) => fetch(...a), now = Date.now, assets = {}, log = console }) {
  const ready = Boolean(settings.ready && geminiKey);
  return async function handle(request) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path === PREFIX || path.startsWith(`${PREFIX}/`)) path = path.slice(PREFIX.length) || '/';
    const origin = request.headers.get('origin');
    const cors = originAllowed(origin, settings) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : { vary: 'Origin' };
    try {
      if (path === '/health' && request.method === 'GET') {
        return json(200, { ok: ready, sessions: await limiter.sessions(), maxSessions: settings.maxSessions }, cors);
      }
      if (path === '/token' && request.method === 'OPTIONS') {
        return json(204, null, { ...cors, 'access-control-allow-methods': 'POST', 'access-control-max-age': '600' });
      }
      if (path === '/token' && request.method === 'POST') {
        if (!originAllowed(origin, settings)) return json(403, { error: 'origin' }, cors);
        if (!ready) return json(503, { error: 'offline' }, cors);
        const ip = request.headers.get('cf-connecting-ip') || 'unknown';
        const verdict = await limiter.take(ip);
        if (verdict === 'busy') return json(503, { error: 'busy' }, cors);
        if (verdict === 'rate') return json(429, { error: 'rate' }, cors);
        try {
          const { token, model } = await mintToken({
            apiKey: geminiKey, voice: settings.voice, instructions: settings.instructions,
            sessionMinutes: settings.sessionMinutes, fetchImpl, now,
          });
          return json(200, { token, model }, cors);
        } catch (e) {
          log.error?.(`token request failed: ${String(e?.message || e).replaceAll(geminiKey, '[key]').slice(0, 300)}`);
          return json(502, { error: 'gemini' }, cors);
        }
      }
      const asset = request.method === 'GET' && assets[path];
      if (asset) {
        return new Response(asset.body, {
          headers: { 'content-type': asset.type, 'access-control-allow-origin': '*', 'cache-control': 'no-cache' },
        });
      }
      return json(404, { error: 'not found' });
    } catch (e) {
      log.error?.(`request failed: ${String(e?.message || e).replaceAll(geminiKey || '\0', '[key]').slice(0, 300)}`);
      return json(500, { error: 'server' });
    }
  };
}
