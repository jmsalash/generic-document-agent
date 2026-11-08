// The document agent widget: a yellow eye in the corner that visitors can talk to.
// Embed, served by the relay:     <script type="module" src="https://<relay address>/widget.js"></script>
// or, copied onto your own site:  <script type="module" src="/document-agent/main.js" data-relay="https://<relay address>"></script>
// Copied onto the site, the eye still shows (grey, "Assistant is offline") when the relay cannot be reached.
import { BANNER } from './status.js';
import { relayBase, fetchHealth } from './relay.js';
import { Player } from './audio.js';
import { startLive } from './live.js';
import { nextIdle, canStart, isLive, isIdle } from './state.js';

const REPO_URL = 'https://github.com/jmsalash/generic-document-agent';           // the project's public repository, shown in the card once it exists
const MIC = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
const CONNECT_TIMEOUT_MS = 15000;
const CANCEL_AFTER_MS = 600;   // a click this soon after starting is a double-click, not a cancel
const RECHECK_MS = Number(document.querySelector('script[data-recheck-ms]')?.dataset.recheckMs) || 30000;
const LABELS = { intro: 'introducing', listening: 'listening…', thinking: 'thinking…', speaking: 'speaking' };
const DEFAULT_BANNER = { invite: 'invite', offline: 'offline', busy: 'busy', connecting: 'connecting' };

const here = new URL(import.meta.url);
const relayAttr = document.querySelector('script[data-relay]')?.dataset.relay;
const base = relayAttr ? relayBase(new URL(relayAttr, location.href).href) : relayBase(here.href);
const asset = (p) => new URL(p, here).href;

if (!window.__cvaLoaded) { window.__cvaLoaded = true; init(); }

function init() {
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = asset('./widget.css');
  document.head.appendChild(css);

  const root = document.createElement('div');
  root.className = 'cva';
  root.dataset.state = 'checking';
  root.innerHTML = `
    <div class="cva-bubble hide"></div>
    <button class="cva-eye" type="button"></button>
    <div class="cva-panel hide">
      <div class="cva-st"><span class="cva-lbl"></span><b>● mic on</b></div>
      <div class="cva-you"></div>
      <div class="cva-me"></div>
      <div class="cva-foot">
        <span>AI voice · not a live person · can make mistakes</span>
        <a class="cva-repo hide" target="_blank" rel="noopener noreferrer">powered by Gemini · source</a>
        <button type="button" class="cva-end">end</button>
      </div>
    </div>
    <span class="cva-sr" aria-live="polite"></span>`;
  document.body.appendChild(root);
  const $ = (sel) => root.querySelector(sel);
  const eye = $('.cva-eye'), bubble = $('.cva-bubble'), panel = $('.cva-panel'), sr = $('.cva-sr');
  if (REPO_URL) { $('.cva-repo').href = REPO_URL; $('.cva-repo').classList.remove('hide'); }

  let state = 'checking';
  let recheckTimer = null;
  let conversation = null; // { ctx, player, stream, node, live, ready, introDone, ended, raf, timer, startedAt }

  function setState(next, bannerKey) {
    state = next;
    root.dataset.state = next;
    const key = bannerKey || DEFAULT_BANNER[next];
    const live = isLive(next);
    bubble.textContent = key ? BANNER[key] : '';
    bubble.classList.toggle('hide', !key);
    panel.classList.toggle('hide', !live);
    $('.cva-lbl').textContent = LABELS[next] || '';
    eye.setAttribute('aria-disabled', String(next === 'offline' || next === 'busy'));
    eye.setAttribute('aria-label', live || next === 'connecting'
      ? 'End the conversation with the AI assistant'
      : 'Talk to the AI assistant about this document');
    sr.textContent = key ? BANNER[key] : (LABELS[next] || '');
  }

  async function refreshIdle(bannerKey) {
    clearTimeout(recheckTimer);
    const status = nextIdle(await fetchHealth(base));
    if (!isIdle(state)) return;
    setState(status, bannerKey && status === 'invite' ? bannerKey : undefined);
    root.classList.add('shown');
    // Keep looking while idle, so the eye greys out on its own if the relay goes away, and comes back when it returns.
    recheckTimer = setTimeout(() => refreshIdle(), RECHECK_MS);
  }

  const onScroll = () => root.classList.toggle('scrolled', window.scrollY > 60);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const say = (you, me) => {
    if (you !== undefined) $('.cva-you').textContent = you ? `You: ${you}` : '';
    if (me !== undefined) $('.cva-me').textContent = me;
  };

  eye.addEventListener('click', () => {
    if (conversation) {
      if (state === 'connecting' && performance.now() - conversation.startedAt < CANCEL_AFTER_MS) return;
      endConversation('user');
      return;
    }
    if (!canStart(state)) return;
    // No microphone on plain-http pages (except on this computer itself): say so instead of failing.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { setState('invite', 'insecure'); return; }
    startConversation();
  });
  $('.cva-end').addEventListener('click', () => endConversation('user'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) endConversation('hidden'); });
  addEventListener('pagehide', () => endConversation('hidden'));

  // Everything up to setState runs synchronously inside the click: iOS only unlocks audio there.
  function startConversation() {
    clearTimeout(recheckTimer);
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    ctx.resume();
    const c = { ctx, player: new Player(ctx), sent: 0, ready: false, introDone: false, ended: false, raf: 0, startedAt: performance.now() };
    conversation = c;
    setState('connecting');
    connect(c);
  }

  async function connect(c) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC });
      if (c.ended) { stopTracks(stream); return; }
      c.stream = stream;
      // From here the mic is live: if Gemini never answers, don't leave it on.
      c.timer = setTimeout(() => { if (c === conversation && !c.ready) endConversation('offline'); }, CONNECT_TIMEOUT_MS);
      await c.ctx.audioWorklet.addModule(asset('./mic-worklet.js'));
      if (c.ended) return;
      const src = c.ctx.createMediaStreamSource(stream);
      c.node = new AudioWorkletNode(c.ctx, 'cva-mic-frames');
      src.connect(c.node);
      c.node.port.onmessage = (ev) => {
        // The introduction is the disclosure: it always plays in full, so the mic is not sent until it ends.
        if (c === conversation && c.introDone) {
          c.live.sendAudio(ev.data, c.ctx.sampleRate);
          root.dataset.sent = String(++c.sent); // frames sent this conversation (handy when testing)
        }
      };
    } catch (e) {
      if (c.ended) return;
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      endConversation(denied ? 'micDenied' : 'offline');
      return;
    }
    c.live = startLive({ base, on: (m) => onEvent(c, m) });
  }

  // Run fn once the assistant has finished talking (turnDone arrives before the audio has played out).
  function afterDrain(c, fn) {
    const tick = () => {
      if (c !== conversation) return;
      if (c.player.playing) { requestAnimationFrame(tick); return; }
      fn();
    };
    tick();
  }

  function levelLoop(c) {
    if (c !== conversation) return;
    root.style.setProperty('--level', c.player.level.toFixed(3));
    c.raf = requestAnimationFrame(() => levelLoop(c));
  }

  function onEvent(c, m) {
    if (c !== conversation) return;
    switch (m.type) {
      case 'ready':
        c.ready = true;
        clearTimeout(c.timer);
        say('', '');
        setState('intro');
        levelLoop(c);
        c.live.intro();
        break;
      case 'audio':
        c.player.play(m.data);
        if (c.introDone && state !== 'speaking') setState('speaking');
        break;
      case 'you':
        if (!c.introDone) break;
        say(m.text, '');
        if (state === 'listening') setState('thinking');
        break;
      case 'me':
        say(undefined, m.text);
        break;
      case 'interrupted':
        c.player.stop();
        if (c.introDone) setState('listening');
        break;
      case 'turnDone':
        afterDrain(c, () => { c.introDone = true; setState('listening'); });
        break;
      case 'closed':
        endConversation({ busy: 'busy', offline: 'offline', limit: 'limit', user: 'user' }[m.reason] || (c.ready ? 'closed' : 'offline'));
        break;
    }
  }

  const stopTracks = (stream) => stream?.getTracks().forEach((t) => t.stop());

  function endConversation(reason) {
    const c = conversation;
    if (!c) return;
    conversation = null;
    c.ended = true;
    clearTimeout(c.timer);
    cancelAnimationFrame(c.raf);
    root.style.setProperty('--level', '0');
    stopTracks(c.stream);
    try { c.node?.disconnect(); } catch { /* gone */ }
    c.player.stop();
    c.live?.end();
    c.ctx.close().catch(() => {});
    say('', '');
    if (reason === 'busy' || reason === 'offline') {
      setState(reason);
      recheckTimer = setTimeout(() => refreshIdle(), RECHECK_MS);
      return;
    }
    const banner = reason === 'micDenied' || reason === 'limit' ? reason : undefined;
    setState('checking', banner);
    refreshIdle(banner);
  }

  refreshIdle();
}
