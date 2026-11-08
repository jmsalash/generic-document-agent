// Reads a whole website as plain text, so it can be the agent's document. Runs on the owner's computer only.
import { parse, NodeType } from 'node-html-parser';

const UA = 'GenericDocumentAgent/1.0';
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const MAX_SITEMAPS = 5;
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'nav', 'header', 'footer', 'form', 'template', 'iframe', 'head', 'button', 'select']);
const INLINE_TAGS = new Set(['a', 'b', 'i', 'em', 'strong', 'span', 'small', 'code', 'abbr', 'sup', 'sub', 'mark', 'label', 'time', 'q', 'u', 's', 'cite', 'kbd', 'var', 'data']);
const NOT_PAGES = /\.(pdf|png|jpe?g|gif|svg|webp|avif|ico|zip|gz|mp4|mp3|wav|webm|docx?|xlsx?|pptx?|css|js|json|xml|txt|rss|atom)$/i;

const bareHost = (u) => u.hostname.replace(/^www\./, '');
export const sameSite = (a, b) => bareHost(a) === bareHost(b);

// One key per page, so /about, /about/ and www.site/about#team are read once.
function pageKey(u) {
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
  return `${bareHost(u)}${path}${u.search}`;
}

function hiddenElement(el) {
  if (el.hasAttribute?.('hidden') || el.getAttribute?.('aria-hidden') === 'true') return true;
  return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(el.getAttribute?.('style') || '');
}

export function htmlToText(html, pageUrl) {
  const root = parse(html, { comment: false });
  const base = root.querySelector('base[href]')?.getAttribute('href');
  let baseUrl;
  try { baseUrl = new URL(base || pageUrl, pageUrl); } catch { baseUrl = new URL(pageUrl); }
  const links = [];
  for (const a of root.querySelectorAll('a[href]')) {
    try {
      const u = new URL(a.getAttribute('href').trim(), baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      u.hash = '';
      links.push(u.href);
    } catch { /* not an address */ }
  }
  const parts = [];
  const walk = (node) => {
    if (node.nodeType === NodeType.TEXT_NODE) { parts.push(node.text); return; }
    if (node.nodeType !== NodeType.ELEMENT_NODE && node !== root) return;
    const tag = (node.tagName || '').toLowerCase();
    if (SKIP_TAGS.has(tag) || (tag && hiddenElement(node))) return;
    const block = tag && !INLINE_TAGS.has(tag);
    if (block) parts.push('\n');
    for (const c of node.childNodes) walk(c);
    if (block) parts.push('\n');
  };
  walk(root);
  const text = parts.join('').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  const title = (root.querySelector('title')?.text || root.querySelector('h1')?.text || pageUrl).replace(/\s+/g, ' ').trim();
  return { title, text, links };
}

function robotsRules(txt) {
  const disallow = [];
  let applies = false, inAgents = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const [, field, value] = [m[0], m[1].toLowerCase(), m[2].trim()];
    if (field === 'user-agent') {
      if (!inAgents) applies = false;
      inAgents = true;
      if (value === '*' || value.toLowerCase().startsWith('genericdocumentagent')) applies = true;
    } else {
      inAgents = false;
      if (field === 'disallow' && applies && value) disallow.push(value);
    }
  }
  return (u) => !disallow.some((p) => u.pathname.startsWith(p));
}

const reason = (e) => {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timed out';
  const msg = String(e?.cause?.code || e?.message || e);
  return /E[A-Z]{3,}/.exec(msg)?.[0] || msg.slice(0, 80);
};

export async function crawlSite(startUrl, { fetchImpl = (...a) => fetch(...a), maxPages = 100, tooBig = async () => false, concurrency = 2 } = {}) {
  let start;
  try { start = new URL(String(startUrl).trim()); } catch { throw new Error('bad address'); }
  if (start.protocol !== 'http:' && start.protocol !== 'https:') throw new Error('bad address');
  start.hash = '';

  const get = (url) => fetchImpl(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  const getText = async (url) => {
    try {
      const res = await get(url);
      return res.ok ? await res.text() : '';
    } catch { return ''; }
  };

  const allowed = robotsRules(await getText(new URL('/robots.txt', start).href));
  const seen = new Set();
  const queue = [];
  const enqueue = (href) => {
    let u;
    try { u = new URL(href); } catch { return; }
    u.hash = '';
    if (!sameSite(u, start) || NOT_PAGES.test(u.pathname) || !allowed(u)) return;
    const key = pageKey(u);
    if (seen.has(key)) return;
    seen.add(key);
    queue.push(u.href);
  };

  // A page's text, or a reason it was not read.
  const readPage = async (url) => {
    let res;
    try { res = await get(url); } catch (e) { return { error: reason(e) }; }
    if (!res.ok) return { error: String(res.status) };
    if (!String(res.headers.get('content-type') || '').includes('text/html')) return { error: 'not a web page' };
    if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) return { error: 'too large' };
    let html;
    try { html = await res.text(); } catch (e) { return { error: reason(e) }; }
    if (html.length > MAX_BYTES) return { error: 'too large' };
    return { url, finalUrl: res.url || url, ...htmlToText(html, res.url || url) };
  };

  seen.add(pageKey(start));
  const first = await readPage(start.href);
  if (first.error) throw new Error(`unreachable: ${first.error}`);
  for (const l of first.links) enqueue(l);

  const sitemapLocs = async (url, depth = 0) => {
    const xml = await getText(url);
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
    if (!/<sitemapindex/i.test(xml)) return locs;
    if (depth > 0) return [];
    const out = [];
    for (const child of locs.slice(0, MAX_SITEMAPS)) out.push(...await sitemapLocs(child, depth + 1));
    return out;
  };
  for (const loc of await sitemapLocs(new URL('/sitemap.xml', start).href)) enqueue(loc);

  const pages = [];
  const joined = () => pages.map((p) => `## ${p.title}\n(${p.url})\n\n${p.text}`).join('\n\n');
  const add = async (p) => {
    if (!p.text) return false;
    pages.push(p);
    return pages.length >= maxPages || await tooBig(joined());
  };

  let stop = await add(first);
  while (!stop && queue.length) {
    const batch = queue.splice(0, Math.max(1, concurrency));
    const results = await Promise.all(batch.map(readPage));
    for (const r of results) {
      if (r.error) continue;
      for (const l of r.links) enqueue(l);
      if (await add(r)) { stop = true; break; }
    }
  }

  // Lines on most pages (menus, cookie banners) say nothing about any one page.
  if (pages.length >= 3) {
    const counts = new Map();
    for (const p of pages) for (const l of new Set(p.text.split('\n'))) counts.set(l, (counts.get(l) || 0) + 1);
    for (const p of pages) p.text = p.text.split('\n').filter((l) => counts.get(l) <= pages.length / 2).join('\n');
  }
  const kept = pages.filter((p) => p.text);
  if (!kept.length) throw new Error('no text');
  pages.splice(0, pages.length, ...kept);
  return { text: joined(), pages: pages.length, host: bareHost(start) };
}
