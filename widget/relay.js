// Talking to the relay that hands out passes: where it is, whether it is up, and getting a pass.
import { healthToStatus } from './status.js';

export const HEALTH_TIMEOUT_MS = 3000;

// From the widget's own script address (…/widget.js or …/widget/main.js) or a data-relay address, the service's
// address, keeping any path such as /document-agent.
export function relayBase(scriptUrl) {
  const u = new URL(scriptUrl);
  let path = u.pathname;
  if (/\.js$/i.test(path)) path = path.replace(/[^/]*$/, '').replace(/\/widget\/$/, '/');
  return u.origin + path.replace(/\/+$/, '');
}

export async function fetchHealth(base, fetchImpl = fetch, timeoutMs = HEALTH_TIMEOUT_MS) {
  try {
    const res = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    return healthToStatus(res.ok ? await res.json() : null);
  } catch {
    return 'offline';
  }
}

export async function fetchToken(base, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${base}/token`, { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(10000) });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.token) return { token: body.token, model: body.model };
    return { error: body.error === 'busy' || body.error === 'rate' ? body.error : 'offline' };
  } catch {
    return { error: 'offline' };
  }
}
