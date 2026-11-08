// Cloudflare Worker entry: the settings module and the Gemini key secret are written by the local setup page.
import { DurableObject } from 'cloudflare:workers';
import { createHandler } from './handler.js';
import { createLimits } from '../relay/limits.js';
import { assets } from './assets.js';
// Written at upload time. A module, because Cloudflare limits text settings to about 5 KB and a document is bigger.
import { settings } from './settings.js';

// One counter for every visitor, wherever Cloudflare answers them, so the limits hold.
export class Limiter extends DurableObject {
  async load() { return (await this.ctx.storage.get('starts')) || []; }

  async sessions(cfg) { return createLimits({ starts: await this.load() }).sessions(cfg); }

  async take(ip, cfg) {
    const limits = createLimits({ starts: await this.load() });
    const verdict = limits.check(ip, cfg);
    if (verdict === 'ok') limits.record(ip);
    await this.ctx.storage.put('starts', limits.snapshot());
    return verdict;
  }
}

export default {
  async fetch(request, env) {
    const stub = env.LIMITER.get(env.LIMITER.idFromName('all'));
    const limiter = { sessions: () => stub.sessions(settings), take: (ip) => stub.take(ip, settings) };
    return createHandler({ settings, geminiKey: env.GEMINI_KEY, limiter, assets })(request);
  },
};
