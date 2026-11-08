// Sends the pass service to the owner's free Cloudflare account, straight through Cloudflare's web API.
// Runs on the owner's computer (from the setup page); only the modules listed in UPLOAD go to Cloudflare.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInstructions, docFits } from '../relay/document.js';
import { demoPage } from '../relay/pages.js';

export const COMPATIBILITY_DATE = '2026-10-01';
const API = 'https://api.cloudflare.com/client/v4';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MODULES = ['cloud/worker.js', 'cloud/handler.js', 'relay/limits.js', 'relay/net.js', 'relay/token.js'];
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// The repository files the upload needs, as { 'repo/path': text }.
export function readUploadFiles(root = ROOT) {
  const files = {};
  for (const m of MODULES) files[m] = readFileSync(join(root, m), 'utf8');
  for (const f of readdirSync(join(root, 'widget'))) {
    if (TYPES[f.slice(f.lastIndexOf('.'))]) files[`widget/${f}`] = readFileSync(join(root, 'widget', f), 'utf8');
  }
  return files;
}

// What the Worker needs to answer visitors: the finished instructions, never the document upload or the setup.
export function settingsFor(cfg) {
  return {
    ready: Boolean(cfg.apiKey && docFits(cfg)),
    instructions: buildInstructions({ name: cfg.name, docText: cfg.docText, instructions: cfg.instructions }),
    voice: cfg.voice,
    origins: cfg.origins,
    sessionMinutes: cfg.sessionMinutes,
    maxSessions: cfg.maxSessions,
    perIpPerHour: cfg.perIpPerHour,
    perDay: cfg.perDay,
  };
}

function assetsModule(cfg, files) {
  const assets = { '/widget.js': { type: TYPES['.js'], body: "import './widget/main.js';\n" } };
  for (const [path, body] of Object.entries(files)) {
    if (path.startsWith('widget/')) assets[`/${path}`] = { type: TYPES[path.slice(path.lastIndexOf('.'))], body };
  }
  const view = { ...cfg, keyHint: cfg.apiKey ? 'set' : null };
  delete view.apiKey; delete view.cfToken;
  assets['/'] = { type: 'text/html; charset=utf-8', body: demoPage(view) };
  return `export const assets = ${JSON.stringify(assets)};\n`;
}

export function buildUpload({ cfg, files, withMigration = false }) {
  const metadata = {
    main_module: 'cloud/worker.js',
    compatibility_date: COMPATIBILITY_DATE,
    bindings: [
      { type: 'secret_text', name: 'GEMINI_KEY', text: cfg.apiKey },
      { type: 'durable_object_namespace', name: 'LIMITER', class_name: 'Limiter' },
    ],
    ...(withMigration ? { migrations: { new_tag: 'v1', new_sqlite_classes: ['Limiter'] } } : {}),
  };
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  const mod = (name, text) => form.set(name, new Blob([text], { type: 'application/javascript+module' }), name);
  for (const m of MODULES) mod(m, files[m]);
  mod('cloud/assets.js', assetsModule(cfg, files));
  mod('cloud/settings.js', `export const settings = ${JSON.stringify(settingsFor(cfg))};\n`);
  return form;
}

// Cloudflare's answer, or an error in words the owner can act on. The token never goes into a message.
async function call(fetchImpl, cfg, method, path, body) {
  const headers = { authorization: `Bearer ${cfg.cfToken}` };
  if (body && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetchImpl(`${API}/accounts/${encodeURIComponent(cfg.cfAccountId)}${path}`, {
      method, headers, body: body instanceof FormData || !body ? body : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error('Cloudflare could not be reached. Check the internet connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success !== false) return { status: res.status, result: data.result };
  const err = new Error(cloudflareReason(res.status, data, cfg.cfToken));
  err.status = res.status;
  err.missing = res.status === 404 && !err.message.startsWith('That Cloudflare account');
  throw err;
}

function cloudflareReason(status, data, token) {
  const first = data?.errors?.[0] || {};
  const msg = String(first.message || '');
  if (/could not route|object identifier|account.*(not found|invalid)/i.test(msg) || first.code === 7003) {
    return 'That Cloudflare account ID was not found.';
  }
  if (status === 401 || status === 403 || /authenticat|unauthori/i.test(msg)) {
    return 'The Cloudflare token was not accepted (it needs the "Edit Cloudflare Workers" permission).';
  }
  const said = (msg || `error ${status}`).replaceAll(token || '\0', '[token]').replace(/\s+/g, ' ').slice(0, 200);
  return `Cloudflare said: ${said}`;
}

export async function deployToCloudflare({ cfg, files = readUploadFiles(), fetchImpl = (...a) => fetch(...a) }) {
  if (!cfg.cfAccountId || !cfg.cfToken) throw new Error('Add your Cloudflare account ID and token first.');
  if (!cfg.apiKey || !cfg.docText) throw new Error('Add your Gemini key and your document first.');
  const SCRIPT = cfg.workerName || 'document-agent';
  let exists = true;
  try { await call(fetchImpl, cfg, 'GET', `/workers/scripts/${SCRIPT}/settings`); } catch (e) {
    if (!e.missing) throw e;
    exists = false;
  }
  let subdomain;
  try { subdomain = (await call(fetchImpl, cfg, 'GET', '/workers/subdomain')).result?.subdomain; } catch (e) {
    if (!e.missing) throw e;
  }
  if (!subdomain) throw new Error('Choose your free workers.dev name in Cloudflare (Workers & Pages) first.');
  await call(fetchImpl, cfg, 'PUT', `/workers/scripts/${SCRIPT}`, buildUpload({ cfg, files, withMigration: !exists }));
  await call(fetchImpl, cfg, 'POST', `/workers/scripts/${SCRIPT}/subdomain`, { enabled: true, previews_enabled: false });
  return { url: `https://${SCRIPT}.${subdomain}.workers.dev` };
}

export async function removeFromCloudflare({ cfg, name = cfg.cfWorker || cfg.workerName || 'document-agent', fetchImpl = (...a) => fetch(...a) }) {
  if (!cfg.cfAccountId || !cfg.cfToken) return;
  try { await call(fetchImpl, cfg, 'DELETE', `/workers/scripts/${encodeURIComponent(name)}?force=true`); } catch (e) {
    if (!e.missing) throw e;
  }
}
