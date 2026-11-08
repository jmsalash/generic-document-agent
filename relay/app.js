// The relay's web routes: health, tokens, setup, demo page and the widget files.
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { isPrivateAddress } from './net.js';
import { originAllowed } from './limits.js';
import { mintToken } from './token.js';
import { docToText, buildInstructions, fitToTokens, geminiCounter, estimateTokens, docFits, pdfPages, MAX_DOC_TOKENS } from './document.js';
import { crawlSite } from './crawl.js';
import { VOICES } from './gemini.js';
import { setupPage, demoPage } from './pages.js';
import { deployToCloudflare, removeFromCloudflare } from '../cloud/deploy.js';

const WIDGET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'widget');
const VOICES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'voices');
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const MAX_UPLOAD = 20 * 1024 * 1024;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NOT_CHANGED = 'Your other settings were saved, but your document was not changed.';

const isReady = (cfg) => Boolean(cfg.apiKey && docFits(cfg));

async function readBody(req, max) {
  let s = '';
  for await (const chunk of req) { s += chunk; if (s.length > max) throw new Error('too large'); }
  return s;
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object';
  res.writeHead(status, {
    'content-type': isJson ? 'application/json' : 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

// The setup page is for the owner only: this computer or the home network, never through a tunnel or proxy.
function ownerOnly(req) {
  if (req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['forwarded']) return false;
  return isPrivateAddress(req.socket.remoteAddress);
}

function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown';
}

function guessType(file) {
  if (file.type && file.type !== 'application/octet-stream') return file.type;
  const ext = extname(file.name || '').toLowerCase();
  return { '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown' }[ext] || file.type;
}

// Gemini's error, in a few words the owner can act on.
function geminiReason(msg) {
  if (/API key not valid|API_KEY_INVALID/i.test(msg)) return 'the key was not accepted';
  if (/quota|RESOURCE_EXHAUSTED|429/i.test(msg)) return 'the free daily limit is used up for now';
  if (/not found|404/i.test(msg)) return 'the reading model is not available';
  if (/permission|403/i.test(msg)) return 'the key is not allowed to use Gemini';
  return msg.replace(/\s+/g, ' ').slice(0, 120);
}

const intIn = (v, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 && n <= 100000 ? n : fallback;
};

export function createApp({
  store, limits, makeClient, fetchImpl = (...a) => fetch(...a), httpsPort = null, log = console,
  deploy = { deployToCloudflare, removeFromCloudflare }, crawl = crawlSite,
}) {
  // Counts the document in tokens (with Gemini when there is a key) and keeps it within the free plan's limit.
  async function fit(docText, key) {
    if (!docText) return { docText: '', docTokens: 0, docNotice: '' };
    const count = key ? geminiCounter(makeClient(key)) : estimateTokens;
    const out = await fitToTokens({ text: docText, count });
    if (out.cut) log.log?.(`document cut from ${out.originalTokens} to ${out.tokens} tokens`);
    return { docText: out.text, docTokens: out.tokens, docNotice: out.notice };
  }

  // Reads the whole website and makes its text the document, within the free plan's token limit.
  async function readWebsite(siteUrl, key) {
    let site;
    try {
      site = await crawl(siteUrl, { tooBig: async (t) => (await estimateTokens(t)) > MAX_DOC_TOKENS * 1.2 });
    } catch (e) {
      const msg = String(e?.message || e);
      log.error?.(`website not read (${siteUrl}): ${msg.slice(0, 200)}`);
      const why = msg === 'bad address' ? 'Please give a web address starting with https://'
        : msg === 'no text' ? 'No text could be read from that website. It may build its pages in the browser; paste the text instead.'
        : `That website could not be read (${msg.replace(/^unreachable: /, '')}).`;
      throw new Error(`${NOT_CHANGED} ${why}`);
    }
    const fitted = await fit(site.text, key);
    const read = `Read ${site.pages} page${site.pages === 1 ? '' : 's'} from ${site.host}.`;
    store.set({
      ...fitted, docNotice: fitted.docNotice ? `${read} ${fitted.docNotice}` : read,
      sourceUrl: siteUrl, pagesRead: site.pages, readAt: new Date().toISOString(),
      docPdf: false, pageFrom: 0, pageTo: 0, pdfTotal: 0,
    });
    log.log?.(`read ${site.pages} pages from ${site.host}`);
  }

  async function saveSetup(req) {
    if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) throw new Error('That file is too large (20 MB at most).');
    const form = await new Request('http://relay/setup', {
      method: 'POST', headers: req.headers, body: Readable.toWeb(req), duplex: 'half',
    }).formData();
    const cfg = store.get();
    const patch = {};
    const apiKey = String(form.get('apiKey') || '').trim();
    if (apiKey) patch.apiKey = apiKey;
    const action = String(form.get('action') || 'save');
    if (form.has('cfAccountId')) patch.cfAccountId = String(form.get('cfAccountId')).trim();
    const cfToken = String(form.get('cfToken') || '').trim();
    if (cfToken) patch.cfToken = cfToken;
    patch.name = String(form.get('name') || '').trim();
    patch.instructions = String(form.get('instructions') ?? cfg.instructions).replace(/\r\n/g, '\n').trim().slice(0, 4000);
    patch.origins = String(form.get('origins') || '').split(/\s+/).map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
    const voice = String(form.get('voice') || '');
    patch.voice = VOICES.includes(voice) ? voice : cfg.voice;
    let badWorker = '';
    if (form.has('workerName')) {
      const w = String(form.get('workerName')).trim();
      if (WORKER_NAME.test(w)) patch.workerName = w;
      else badWorker = 'Worker name: use lowercase letters, numbers and dashes.';
    }
    for (const k of ['maxSessions', 'sessionMinutes', 'perIpPerHour', 'perDay']) patch[k] = intIn(form.get(k), cfg[k]);
    const page = (v) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n >= 1 ? n : 0; };
    const pageFrom = form.has('pageFrom') ? page(form.get('pageFrom')) : cfg.pageFrom;
    const pageTo = form.has('pageTo') ? page(form.get('pageTo')) : cfg.pageTo;
    const pagesChanged = pageFrom !== cfg.pageFrom || pageTo !== cfg.pageTo;
    const file = form.get('docFile');
    const hasFile = file && typeof file === 'object' && file.size > 0;
    const siteUrl = String(form.get('siteUrl') || '').trim();
    if (!hasFile && siteUrl && (siteUrl !== cfg.sourceUrl || action === 'read-site')) {
      store.set(patch); // everything else is kept even if the website cannot be read
      await readWebsite(siteUrl, store.get().apiKey);
      if (badWorker) throw new Error(badWorker);
      return action;
    }
    const storedPdf = !hasFile && pagesChanged && cfg.docPdf ? store.readFile('document-upload.pdf') : null;
    if (!hasFile && !storedPdf) {
      const docText = String(form.get('docText') ?? cfg.docText).replace(/\r\n/g, '\n').trim();
      if (docText !== cfg.docText || !cfg.docTokens) Object.assign(patch, await fit(docText, patch.apiKey || cfg.apiKey));
      store.set(patch);
      if (badWorker) throw new Error(badWorker);
      return action;
    }
    // Everything else is saved first, so a document that cannot be read never loses the key or the other settings.
    store.set(patch);
    const key = store.get().apiKey;
    const type = storedPdf ? 'application/pdf' : guessType(file);
    if (type === 'application/pdf' && !key) throw new Error('Your other settings were saved. Add your Gemini key: it is needed to read a PDF.');
    const buffer = storedPdf || Buffer.from(await file.arrayBuffer());
    let text, pages = null;
    try {
      let readable = buffer;
      if (type === 'application/pdf') {
        try { pages = await pdfPages(buffer, pageFrom, pageTo); } catch (e) { throw Object.assign(new Error(e.message), { pages: true }); }
        readable = pages.buffer;
      }
      text = await docToText({ buffer: readable, mimeType: type, client: key ? makeClient(key) : null });
    } catch (e) {
      const reason = String(e?.message || e).replaceAll(key, '[key]');
      log.error?.(`document upload failed (${type}, ${buffer.length} bytes): ${reason.slice(0, 400)}`);
      const why = e.pages ? e.message
        : e.message === 'unsupported file' ? 'Please use a PDF or a text file.'
        : e.message === 'empty document' ? 'No text could be read from that file.'
        : `Gemini could not read that file (${geminiReason(reason)}). You can paste the document text in the box instead.`;
      throw new Error(`${NOT_CHANGED} ${why}`);
    }
    if (!storedPdf) store.saveFile(type === 'application/pdf' ? 'document-upload.pdf' : 'document-upload.txt', buffer);
    store.set({
      ...await fit(text, key),
      docPdf: type === 'application/pdf', sourceUrl: '', pagesRead: 0, readAt: '',
      pageFrom: pages ? pageFrom : 0, pageTo: pages ? pageTo : 0, pdfTotal: pages ? pages.total : 0,
    });
    if (badWorker) throw new Error(badWorker);
    return action;
  }

  // Keeps Cloudflare in step with the setup page. A failure never loses the local settings: it is shown instead.
  async function syncCloudflare(action) {
    const cfg = store.get();
    try {
      if (action === 'cloudflare-remove') {
        await deploy.removeFromCloudflare({ cfg });
        store.set({ cfUrl: '', cfWorker: '', cfUpdatedAt: '', cfError: '' });
        log.log?.('removed from Cloudflare');
      } else if (action === 'cloudflare-send' || cfg.cfUrl) {
        const { url } = await deploy.deployToCloudflare({ cfg });
        store.set({ cfUrl: url, cfWorker: cfg.workerName, cfUpdatedAt: new Date().toISOString(), cfError: '' });
        log.log?.(`sent to Cloudflare: ${url}`);
        // A new worker name made a new Worker: the old one goes, so visitors are not left on stale settings.
        if (cfg.cfWorker && cfg.cfWorker !== cfg.workerName) {
          await deploy.removeFromCloudflare({ cfg, name: cfg.cfWorker });
          log.log?.(`removed the old Worker ${cfg.cfWorker}`);
        }
      }
    } catch (e) {
      const msg = String(e?.message || e).replaceAll(cfg.cfToken || '\0', '[token]').replaceAll(cfg.apiKey || '\0', '[key]');
      store.set({ cfError: msg });
      log.log?.(`Cloudflare not updated: ${msg}`);
    }
  }

  async function serveWidget(res, path) {
    if (path === '/widget.js') { // a stable address that loads the widget from its folder
      res.writeHead(200, { 'content-type': TYPES['.js'], 'access-control-allow-origin': '*', 'cache-control': 'no-cache' });
      return res.end("import './widget/main.js';\n");
    }
    const rel = path.slice('/widget/'.length);
    const full = normalize(join(WIDGET_DIR, rel));
    if (!full.startsWith(WIDGET_DIR + '/') || !TYPES[extname(full)]) return send(res, 404, { error: 'not found' });
    try {
      const body = await readFile(full);
      res.writeHead(200, { 'content-type': TYPES[extname(full)], 'access-control-allow-origin': '*', 'cache-control': 'no-cache' });
      res.end(body);
    } catch { send(res, 404, { error: 'not found' }); }
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://relay');
    const path = url.pathname;
    const origin = req.headers.origin;
    const cfg = store.get();
    const cors = originAllowed(origin, cfg) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : { vary: 'Origin' };
    try {
      if (path === '/health' && req.method === 'GET') {
        return send(res, 200, { ok: isReady(cfg), sessions: limits.sessions(cfg), maxSessions: cfg.maxSessions }, cors);
      }
      if (path === '/token' && req.method === 'OPTIONS') {
        return send(res, 204, '', { ...cors, 'access-control-allow-methods': 'POST', 'access-control-max-age': '600' });
      }
      if (path === '/token' && req.method === 'POST') {
        if (!originAllowed(origin, cfg)) return send(res, 403, { error: 'origin' }, cors);
        if (!isReady(cfg)) return send(res, 503, { error: 'offline' }, cors);
        const ip = clientIp(req);
        const verdict = limits.check(ip, cfg);
        if (verdict === 'busy') return send(res, 503, { error: 'busy' }, cors);
        if (verdict === 'rate') return send(res, 429, { error: 'rate' }, cors);
        try {
          const { token, model } = await mintToken({
            apiKey: cfg.apiKey, voice: cfg.voice, sessionMinutes: cfg.sessionMinutes, fetchImpl,
            instructions: buildInstructions({ name: cfg.name, docText: cfg.docText, instructions: cfg.instructions }),
          });
          limits.record(ip, cfg);
          return send(res, 200, { token, model }, cors);
        } catch (e) {
          log.error?.(`token request failed: ${String(e?.message || e).replaceAll(cfg.apiKey, '[key]').slice(0, 300)}`);
          return send(res, 502, { error: 'gemini' }, cors);
        }
      }
      const voiceFile = path.match(/^\/voices\/([A-Za-z]+)\.mp3$/);
      if (voiceFile && req.method === 'GET') {
        if (!VOICES.includes(voiceFile[1])) return send(res, 404, { error: 'not found' });
        const mp3 = await readFile(join(VOICES_DIR, `${voiceFile[1]}.mp3`));
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': mp3.length, 'cache-control': 'public, max-age=86400' });
        return res.end(mp3);
      }
      if (path === '/setup') {
        if (!ownerOnly(req)) return send(res, 404, { error: 'not found' });
        if (req.method === 'GET') return send(res, 200, setupPage(store.publicView(), { saved: url.searchParams.has('saved') }));
        if (req.method === 'POST') {
          try {
            const t0 = Date.now();
            const action = await saveSetup(req);
            await syncCloudflare(action);
            log.log?.(`settings saved (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
            return send(res, 303, '', { location: '/setup?saved=1' });
          } catch (e) {
            log.log?.(`settings not fully saved: ${e.message}`);
            return send(res, 400, setupPage(store.publicView(), { error: e.message }));
          }
        }
      }
      // Browsers only allow the microphone on secure pages (or on this computer itself), so a visitor on the
      // home network opening the plain address is sent to the secure one.
      if (path === '/' && req.method === 'GET' && httpsPort && !req.socket.encrypted) {
        const host = String(req.headers.host || '').replace(/:\d+$/, '');
        const onThisComputer = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host);
        const viaProxy = req.headers['x-forwarded-proto'] || req.headers['cf-connecting-ip'] || req.headers['cf-visitor'];
        if (host && !onThisComputer && !viaProxy) {
          return send(res, 302, '', { location: `https://${host}:${httpsPort}/` });
        }
      }
      if (path === '/' && req.method === 'GET') {
        return send(res, 200, demoPage(store.publicView(), { showSetupLink: ownerOnly(req) }));
      }
      if ((path === '/widget.js' || path.startsWith('/widget/')) && req.method === 'GET') return serveWidget(res, path);
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      log.error?.(`request failed: ${String(e?.message || e).slice(0, 300)}`);
      if (!res.headersSent) send(res, 500, { error: 'server' });
    }
  };
}
