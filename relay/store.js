// The owner's settings and files, kept in the data folder so a restart keeps them.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { VOICES as VOICE_NAMES } from './gemini.js';
import { DEFAULT_INSTRUCTIONS } from './document.js';

export const DEFAULTS = Object.freeze({
  apiKey: '',
  name: '',
  origins: [],
  voice: 'Despina',
  maxSessions: 3,
  sessionMinutes: 10,
  perIpPerHour: 10,
  perDay: 200,
  docText: '',
  docTokens: 0,
  docNotice: '',
  docPdf: false,
  pageFrom: 0,
  pageTo: 0,
  pdfTotal: 0,
  sourceUrl: '',
  pagesRead: 0,
  readAt: '',
  instructions: DEFAULT_INSTRUCTIONS,
  workerName: 'document-agent',
  cfWorker: '',
  cfAccountId: '',
  cfToken: '',
  cfUrl: '',
  cfUpdatedAt: '',
  cfError: '',
});

function writeAtomic(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export function createStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, 'config.json');
  let config = { ...DEFAULTS };
  if (existsSync(file)) {
    try { config = { ...DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { /* corrupt: start from defaults */ }
    if (!VOICE_NAMES.includes(config.voice)) config.voice = DEFAULTS.voice; // a voice no longer offered
  }
  return {
    dir: dataDir,
    get: () => ({ ...config, origins: [...config.origins] }),
    set(patch) {
      config = { ...config, ...patch };
      writeAtomic(file, JSON.stringify(config, null, 2));
      return this.get();
    },
    publicView() {
      const { apiKey, cfToken, ...rest } = config;
      return {
        ...rest, origins: [...rest.origins],
        keyHint: apiKey ? `…${apiKey.slice(-4)}` : null,
        cfTokenHint: cfToken ? `…${cfToken.slice(-4)}` : null,
      };
    },
    saveFile(name, buf) { writeAtomic(join(dataDir, name), buf); },
    readFile(name) {
      const p = join(dataDir, name);
      return existsSync(p) ? readFileSync(p) : null;
    },
  };
}
