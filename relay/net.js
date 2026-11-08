// Is an address or a page on this computer or the home network?
// No node: imports, because the Cloudflare Worker uses this file too.
const isV4 = (a) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(a) && a.split('.').every((n) => +n <= 255);
const isV6 = (a) => a.includes(':') && /^[0-9a-f:.]+$/.test(a);

function privateV4(a) {
  const m = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [x, y] = [+m[1], +m[2]];
  return x === 127 || x === 10 || (x === 192 && y === 168) || (x === 172 && y >= 16 && y <= 31)
    || (x === 100 && y >= 64 && y <= 127); // 100.64/10: Tailscale and similar private networks
}

export function isPrivateAddress(addr) {
  if (!addr) return false;
  let a = String(addr).toLowerCase().replace(/^\[|\]$/g, '');
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (isV4(a)) return privateV4(a);
  if (isV6(a)) return a === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(a);
  return false;
}

export function isLocalOrigin(origin) {
  if (!origin || origin === 'null') return false;
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  return host === 'localhost' || host.endsWith('.local') || isPrivateAddress(host);
}
