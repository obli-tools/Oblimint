import fs from 'fs';
import path from 'path';
import selfsigned from 'selfsigned';
import { dataDir } from '../config';
import { logger } from './logger';

export interface TlsMaterial { key: string; cert: string }

/**
 * Self-signed certificate of the panel (PANEL_TLS=selfsigned). Generated at
 * the first start and kept under <data dir>/panel/tls so it does not change
 * at every restart (the browser exception stays valid). When the data dir is
 * not writable (no volume yet), an in-memory certificate is used and a
 * warning is logged.
 */
export function loadOrCreateSelfSignedCert(extraHostnames: string[] = []): TlsMaterial {
  const dir = path.join(dataDir, 'panel', 'tls');
  const keyPath = path.join(dir, 'panel.key');
  const certPath = path.join(dir, 'panel.crt');
  try {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      return { key: fs.readFileSync(keyPath, 'utf-8'), cert: fs.readFileSync(certPath, 'utf-8') };
    }
  } catch (err) {
    logger.warn({ err }, 'TLS: existing self-signed certificate unreadable — generating a new one');
  }

  const altNames: Array<{ type: number; value?: string; ip?: string }> = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
  ];
  for (const h of extraHostnames) {
    if (!h) continue;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) altNames.push({ type: 7, ip: h });
    else altNames.push({ type: 2, value: h });
  }
  const pems = selfsigned.generate([{ name: 'commonName', value: extraHostnames[0] || 'oblimint' }], {
    keySize: 2048,
    days: 3650,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
  const material = { key: pems.private, cert: pems.cert };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyPath, material.key, { mode: 0o600 });
    fs.writeFileSync(certPath, material.cert, { mode: 0o644 });
    logger.info({ certPath }, 'TLS: self-signed certificate generated');
  } catch (err) {
    logger.warn({ err, dir }, 'TLS: data dir not writable — self-signed certificate kept in memory (changes at each restart)');
  }
  return material;
}
