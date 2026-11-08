// Keeps one visitor, or a crowd, from using up the owner's free Gemini allowance.
import { isLocalOrigin } from './net.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export function createLimits({ now = Date.now, starts: initial = [] } = {}) {
  let starts = [...initial]; // { ip, at }
  const prune = () => { const t = now(); starts = starts.filter((s) => t - s.at < DAY); };
  return {
    sessions(cfg) {
      const t = now();
      return starts.filter((s) => t - s.at < cfg.sessionMinutes * 60_000).length;
    },
    check(ip, cfg) {
      prune();
      if (starts.length >= cfg.perDay) return 'rate';
      const t = now();
      if (starts.filter((s) => s.ip === ip && t - s.at < HOUR).length >= cfg.perIpPerHour) return 'rate';
      if (this.sessions(cfg) >= cfg.maxSessions) return 'busy';
      return 'ok';
    },
    record(ip) { prune(); starts.push({ ip, at: now() }); },
    // The list to keep (the Cloudflare Durable Object stores it between visitors).
    snapshot() { prune(); return starts.map((s) => ({ ...s })); },
  };
}

const trim = (s) => String(s).replace(/\/+$/, '').toLowerCase();

export function originAllowed(origin, cfg) {
  if (!origin || origin === 'null') return false;
  if (isLocalOrigin(origin)) return true;
  return cfg.origins.some((o) => trim(o) === trim(origin));
}
