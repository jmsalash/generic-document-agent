// A self-signed certificate so the microphone works when the demo page is opened from another device.
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import selfsigned from 'selfsigned';

export function loadOrCreateCert(dataDir) {
  const keyPath = join(dataDir, 'key.pem'), certPath = join(dataDir, 'cert.pem');
  if (existsSync(keyPath) && existsSync(certPath)) return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  const ips = Object.values(networkInterfaces()).flat().filter(Boolean).map((i) => i.address);
  const altNames = [{ type: 2, value: 'localhost' }, ...ips.map((ip) => ({ type: 7, ip }))];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'generic-document-agent' }], {
    days: 3650, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames }],
  });
  writeFileSync(keyPath, pems.private, { mode: 0o600 });
  writeFileSync(certPath, pems.cert, { mode: 0o600 });
  return { key: pems.private, cert: pems.cert };
}
