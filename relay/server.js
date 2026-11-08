// Starts the relay: HTTP on 8792 and HTTPS (self-signed) on 8793, on every network address.
import http from 'node:http';
import https from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { createLimits } from './limits.js';
import { makeClient } from './gemini.js';
import { createApp } from './app.js';
import { loadOrCreateCert } from './cert.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.DATA_DIR || join(root, 'data'));
const PORT = Number(process.env.PORT || 8792);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8793);

const store = createStore(dataDir);
const app = createApp({ store, limits: createLimits(), makeClient, httpsPort: HTTPS_PORT });

function portBusy(port) {
  return (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.error(`Port ${port} is already in use: another copy of the assistant (for example its Docker container) is probably running. Stop it first, or start this one with other ports (PORT=... HTTPS_PORT=...).`);
    process.exit(1);
  };
}

http.createServer(app).on('error', portBusy(PORT)).listen(PORT, '0.0.0.0', () => console.log(`Document agent relay on http://0.0.0.0:${PORT}`));
https.createServer(loadOrCreateCert(dataDir), app)
  .on('error', portBusy(HTTPS_PORT))
  .listen(HTTPS_PORT, '0.0.0.0', () => console.log(`Document agent relay on https://0.0.0.0:${HTTPS_PORT} (self-signed)`));

// One bad request must never take the relay down for every visitor.
process.on('unhandledRejection', (e) => console.error(`unexpected error: ${String(e?.message || e).slice(0, 300)}`));

// Stop cleanly when asked (a Stop button, Ctrl-C), so nothing is left serving an old version.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { console.log(`stopping (${sig})`); process.exit(0); });
process.on('exit', (code) => { if (code) console.log(`exiting with code ${code}`); });
