// The two pages the relay shows: setup (for the owner, home network only) and a demo page with the document.
import { VOICES } from './gemini.js';
import { MAX_DOC_TOKENS } from './document.js';

const siteHost = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STYLE = `
  :root { --paper:#101318; --ink:#E8EAE6; --slate:#98A1AC; --line:#2A2F36; --card:#171B21; --eye:#ffc21a; color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font:16px/1.55 system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 96px 20px 64px; }
  h1 { font-size: 1.8rem; margin: 0 0 .3em; } h2 { font-size: 1.05rem; color: var(--eye); margin: 2em 0 .5em; }
  .mono, label, .note { font-family: "IBM Plex Mono", ui-monospace, monospace; }
  .note { color: var(--slate); font-size: .85rem; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin: 16px 0; }
  label { display:block; font-size:.8rem; color:var(--slate); margin: 14px 0 4px; }
  input, select, textarea { width:100%; background:var(--paper); color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:9px 10px; font:inherit; }
  textarea { min-height: 8em; font: .9rem/1.45 ui-monospace, monospace; }
  .row { display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0 12px; align-items: end; }
  button { margin-top: 18px; background: var(--eye); color:#111; border:0; border-radius: 999px; padding: 10px 20px; font-weight:600; cursor:pointer; }
  .voice { display:flex; gap:10px; } .voice select { flex:1; }
  button.ghost { margin:0; background:none; color:var(--eye); border:1px solid var(--eye); white-space:nowrap; }
  button:disabled { opacity: .6; cursor: progress; }
  .saving { margin-left: 12px; display: inline-flex; align-items: center; gap: 8px; }
  .saving[hidden] { display: none; }
  .spin { width: 14px; height: 14px; border: 2px solid var(--line); border-top-color: var(--eye); border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .ok { color: #8fd18f; } .err { color: #ff8a80; }
  .doc { white-space: pre-wrap; }
  .cloud { border: 1px solid var(--line); border-radius: 10px; padding: 4px 16px 16px; margin: 22px 0 0; }
  .cloud legend { color: var(--eye); font-weight: 600; padding: 0 6px; }
  .cloud ol { padding-left: 1.2em; margin: 8px 0; } .cloud li { margin: 3px 0; }
  .cloud pre { white-space: pre-wrap; word-break: break-all; background: var(--paper); border: 1px solid var(--line); border-radius: 8px; padding: 10px; font-size: .8rem; }
  .cloud-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
  a { color: var(--eye); }
`;

const page = (title, body, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>${STYLE}</style>${head}</head><body><main>${body}</main></body></html>`;

// What still stops the eye from working, in plain words.
export function readiness(view) {
  const missing = [!view.keyHint && 'your Gemini key', !view.docText && 'your document'].filter(Boolean);
  const notice = view.docNotice ? `<p class="err mono" id="docNotice">${esc(view.docNotice)}</p>` : '';
  if (!missing.length && !(view.docTokens > 0)) {
    return `<p class="err mono" id="readiness">Not ready yet: press Save so your document can be checked against the free plan's ${MAX_DOC_TOKENS.toLocaleString('en')}-token limit.</p>`;
  }
  return (missing.length
    ? `<p class="err mono" id="readiness">Not ready yet: add ${missing.join(' and ')}. Until then the eye says "Assistant is offline".</p>`
    : '<p class="ok mono" id="readiness">Ready: the eye is live. <a href="/">Try it on the demo page</a>.</p>') + notice;
}

// The part visitors use runs on the owner's free Cloudflare account: that is how a public website gets its passes.
function cloudflareBox(view) {
  const connected = Boolean(view.cfUrl);
  const when = view.cfUpdatedAt ? new Date(view.cfUpdatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const line = `<script type="module" src="${view.cfUrl}/widget.js"></script>`;
  return `<fieldset class="cloud" id="cloudflare">
    <legend>Cloudflare: needed to use the assistant on your website</legend>
    <p class="note">Your website gets the assistant's passes from Cloudflare, so this step is needed before the eye works there. Without it the assistant only works on this computer and your home network, for trying it out.</p>
    <ol class="note">
      <li>Create a free account at <a href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noopener">dash.cloudflare.com</a>.</li>
      <li>Open <b>Workers &amp; Pages</b> once and choose your free <b>workers.dev</b> name.</li>
      <li>Copy your <b>Account ID</b> (on the Workers &amp; Pages page, or under Account home → the ⋯ menu next to your account) into the box below.</li>
      <li>Create a token: click your profile icon, then <b>My Profile → API Tokens → Create Token</b>. Do not pick
        permissions yourself: next to <b>Edit Cloudflare Workers</b> press <b>Use template</b>. Under
        <b>Account Resources</b> choose your account, under <b>Zone Resources</b> choose <b>All zones</b>, then
        <b>Continue to summary → Create Token</b>. Copy the token (Cloudflare shows it only once) and paste it below.</li>
      <li>Press <b>Send to Cloudflare</b>. After that, every Save updates Cloudflare too.</li>
    </ol>
    <label for="workerName">Worker name (lowercase letters, numbers and dashes; use a different one for each agent)</label>
    <input id="workerName" name="workerName" autocomplete="off" value="${esc(view.workerName)}">
    <label for="cfAccountId">Cloudflare account ID</label>
    <input id="cfAccountId" name="cfAccountId" autocomplete="off" value="${esc(view.cfAccountId)}" placeholder="32 letters and numbers">
    <label for="cfToken">Cloudflare token ${view.cfTokenHint ? `(set, ends in ${esc(view.cfTokenHint)}; leave empty to keep it)` : ''}</label>
    <input id="cfToken" name="cfToken" type="password" autocomplete="off" placeholder="${view.cfTokenHint ? 'keep the current token' : 'paste your token'}">
    ${view.cfError ? `<p class="err mono" id="cfError">Cloudflare was not updated: ${esc(view.cfError)}</p>` : ''}
    ${connected ? `<p class="ok mono" id="cfStatus">Running on Cloudflare at <a href="${esc(view.cfUrl)}/" target="_blank" rel="noopener">${esc(view.cfUrl)}</a>${when ? ` (updated ${esc(when)})` : ''}.</p>
    <p class="note">Paste this line into your website's pages, just before <code>&lt;/body&gt;</code>, and make sure your website's address is in the allowed websites above:</p>
    <pre class="mono" id="cfLine">${esc(line)}</pre>` : ''}
    <div class="row cloud-actions">
      <button type="submit" name="action" value="cloudflare-send" class="ghost" id="cfSend">${connected ? 'Update Cloudflare now' : 'Send to Cloudflare'}</button>
      ${connected ? '<button type="submit" name="action" value="cloudflare-remove" class="ghost" id="cfRemove">Remove from Cloudflare</button>' : ''}
    </div>
  </fieldset>`;
}

export function setupPage(view, { saved = false, error = '' } = {}) {
  const voices = VOICES.map((v) => `<option${v === view.voice ? ' selected' : ''}>${v}</option>`).join('');
  const num = (name, label) => `<div><label for="${name}">${label}</label><input id="${name}" name="${name}" type="number" min="1" value="${esc(view[name])}"></div>`;
  return page('Set up your document agent', `
  <h1>Set up your document agent</h1>
  <p class="note">One setup is one agent. For another agent, run another copy with its own worker name.</p>
  <p class="note">This page only opens from this computer or your home network. Your key stays on this computer.</p>
  ${readiness(view)}
  ${saved ? '<p class="ok mono">Saved.</p>' : ''}${error ? `<p class="err mono">${esc(error)}</p>` : ''}
  <form method="post" action="/setup" enctype="multipart/form-data" class="card" id="setupForm">
    <button type="submit" tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden">Save</button>
    <label for="apiKey">Gemini key ${view.keyHint ? `(set, ends in ${esc(view.keyHint)}; leave empty to keep it)` : '(free, from aistudio.google.com/apikey)'}</label>
    <input id="apiKey" name="apiKey" type="password" autocomplete="off" placeholder="${view.keyHint ? 'keep the current key' : 'paste your key'}">
    <label for="name">Agent name (optional): how it calls itself</label>
    <input id="name" name="name" value="${esc(view.name)}" placeholder="the Acme manual helper">
    <label for="docFile">Your document as a PDF, text or Markdown file (replaces the text below; 20 MB at most)</label>
    <input id="docFile" name="docFile" type="file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown">
    <div class="row">
      <div><label for="pageFrom">PDF only: from page</label><input id="pageFrom" name="pageFrom" type="number" min="1" value="${view.pageFrom || ''}" placeholder="first"></div>
      <div><label for="pageTo">to page</label><input id="pageTo" name="pageTo" type="number" min="1" value="${view.pageTo || ''}" placeholder="last"></div>
    </div>
    <p class="note" id="pagesNote">Leave empty for the whole PDF. Use them to skip parts such as the index or a glossary, or to make an agent for one chapter.${view.docPdf && view.pdfTotal ? ` Your PDF has ${view.pdfTotal} pages${view.pageFrom || view.pageTo ? `; the agent uses pages ${view.pageFrom || 1} to ${view.pageTo || view.pdfTotal}` : ''}. Changing the pages and pressing Save reads it again, no need to upload it again.` : ''}</p>
    <label for="siteUrl">Or a website address (the agent reads the whole site)</label>
    <div class="voice"><input id="siteUrl" name="siteUrl" type="url" inputmode="url" placeholder="https://example.com" value="${esc(view.sourceUrl)}">
      <button type="submit" name="action" value="read-site" class="ghost" id="readSite">${view.sourceUrl ? 'Read it again' : 'Read website'}</button></div>
    ${view.sourceUrl ? `<p class="note ok" id="siteSource">From the website ${esc(siteHost(view.sourceUrl))}, ${view.pagesRead} page${view.pagesRead === 1 ? '' : 's'}, read on ${esc(new Date(view.readAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}. Up to 100 pages; sites that build their pages in the browser or need a login cannot be read.</p>` : '<p class="note">Up to 100 pages. Sites that build their pages in the browser or need a login cannot be read.</p>'}
    <label for="docText">Document text the agent uses (check it and correct it here; the free Gemini plan takes up to 32,000 tokens, about 24,000 words, and longer text is cut)</label>
    <textarea id="docText" name="docText">${esc(view.docText)}</textarea>
    <label for="instructions">Instructions for the agent: what it is for, its tone, what to stress, and any extra facts it may share beyond the document (it never talks about anything else)</label>
    <textarea id="instructions" name="instructions" style="min-height:8em" maxlength="4000">${esc(view.instructions)}</textarea>
    <label for="origins">Websites allowed to use it, one per line (for example https://yoursite.com)</label>
    <textarea id="origins" name="origins" style="min-height:4em">${esc(view.origins.join('\n'))}</textarea>
    <label for="voice">Voice</label>
    <div class="voice"><select id="voice" name="voice">${voices}</select>
      <button type="button" id="listen" class="ghost">▶ Listen</button></div>
    <p id="voiceMsg" class="note" aria-live="polite"></p>
    <div class="row">${num('maxSessions', 'Conversations at once')}${num('sessionMinutes', 'Minutes per conversation')}${num('perIpPerHour', 'Per visitor per hour')}${num('perDay', 'Per day')}</div>
    <p class="note" id="concurrencyNote">Conversations at once: 3 is the most a free Gemini key allows. A paid Gemini key allows many more (Google does not publish a fixed number; it grows with your paid tier, and AI Studio shows your current limits).</p>
    ${cloudflareBox(view)}
    <button type="submit" id="save">Save</button>
    <span id="saving" class="note saving" hidden><span class="spin"></span> <span id="savingText">Saving…</span></span>
  </form>
  <p class="note"><a href="/">Open the demo page</a> to try it. From a phone or another computer it opens on the secure
  address (port 8793); the first time, the browser warns about the certificate: choose to continue.</p>
  <script>
    document.getElementById('setupForm').addEventListener('submit', (e) => {
      const save = document.getElementById('save'), file = document.getElementById('docFile');
      const toCloud = e.submitter && e.submitter.name === 'action';
      save.disabled = true;
      save.textContent = 'Saving…';
      const site = e.submitter && e.submitter.value === 'read-site';
      document.getElementById('savingText').textContent = site ? 'Reading the website. This can take a minute…' : file.files.length
        ? 'Saving, and Gemini is reading your document. This can take up to a minute…'
        : toCloud ? 'Saving and updating Cloudflare…' : 'Saving…';
      document.getElementById('saving').hidden = false;
    });
    addEventListener('pageshow', () => { // coming back with the browser's Back button
      const save = document.getElementById('save');
      save.disabled = false; save.textContent = 'Save';
      document.getElementById('saving').hidden = true;
    });
    const listen = document.getElementById('listen'), msg = document.getElementById('voiceMsg');
    let player = null;
    listen.addEventListener('click', async () => {
      const voice = document.getElementById('voice').value;
      if (player) player.pause();
      player = new Audio('/voices/' + voice + '.mp3');
      try {
        await player.play();
        msg.textContent = 'Playing ' + voice + '. Pick another and press Listen to compare.';
      } catch (e) {
        msg.textContent = e && e.name === 'NotAllowedError'
          ? 'Your browser blocked the sound. Press Listen again.'
          : 'Could not play the sample. Is the assistant running?';
      }
    });
  </script>`);
}

export function demoPage(view, { showSetupLink = false } = {}) {
  const ready = view.keyHint && view.docText;
  const body = ready
    ? `<h1>${esc(view.name || 'Talk to this document')}</h1>
       <p class="note">Click the yellow eye in the corner to talk with the AI assistant about this document.</p>
       <div class="card doc">${esc(view.docText)}</div>`
    : `<h1>Document Agent</h1>
       <p>Not set up yet: it needs ${[!view.keyHint && 'a Gemini key', !view.docText && 'a document'].filter(Boolean).join(' and ')}.</p>
       ${showSetupLink ? '<p><a href="/setup">Open the setup page</a></p>' : ''}`;
  return page(view.name || 'Document Agent', body,
    '<script type="module" src="/widget.js"></script>');
}
