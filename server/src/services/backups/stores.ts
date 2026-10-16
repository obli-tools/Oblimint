import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { PassThrough, Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { Client as SshClient, type SFTPWrapper } from 'ssh2';
import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { BackupDestinationConfig } from '@oblimint/shared';
import { dataDir } from '../../config';

// ─────────────────────────────────────────────────────────────────────────────
// Backup destinations: a local folder of the data disk (not off-site: for
// tests or a mounted external disk), SFTP (host key pinned on first use) or
// any S3-compatible bucket (AWS, Backblaze B2, Wasabi, MinIO, Scaleway…).
// Keys are relative paths "accounts/<user>-<id>/<stamp>/files.tar.gz.obkp".
// ─────────────────────────────────────────────────────────────────────────────

export interface BackupStore {
  /** Writes the stream under key; resolves with the bytes written. */
  put(key: string, body: Readable): Promise<number>;
  get(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
  close(): Promise<void>;
}

const KEY_RE = /^[A-Za-z0-9._@+=-]+(?:\/[A-Za-z0-9._@+=-]+)*$/;
function checkKey(key: string): string {
  if (!KEY_RE.test(key) || key.split('/').some((s) => s === '.' || s === '..')) throw new Error(`invalid backup key: ${key}`);
  return key;
}

function counter(): { t: Transform; bytes: () => number } {
  let n = 0;
  return { t: new Transform({ transform(c: Buffer, _e, cb) { n += c.length; cb(null, c); } }), bytes: () => n };
}

/** Local folder: always inside the platform data directory. */
export const LOCAL_BACKUP_ROOT = path.join(dataDir, 'backups');

function localStore(cfg: Extract<BackupDestinationConfig, { kind: 'local' }>): BackupStore {
  const base = path.resolve(LOCAL_BACKUP_ROOT, (cfg.subdir ?? '').replace(/^\/+/, ''));
  if (base !== LOCAL_BACKUP_ROOT && !base.startsWith(LOCAL_BACKUP_ROOT + path.sep)) throw new Error('local backup folder outside the data directory');
  const file = (key: string) => path.join(base, ...checkKey(key).split('/'));
  return {
    async put(key, body) {
      const f = file(key);
      await fs.promises.mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
      const tmp = `${f}.part`;
      const c = counter();
      await pipeline(body, c.t, fs.createWriteStream(tmp, { mode: 0o600 }));
      await fs.promises.rename(tmp, f);
      return c.bytes();
    },
    async get(key) { return fs.createReadStream(file(key)); },
    async remove(key) {
      await fs.promises.rm(file(key), { force: true });
      // Empty run folders go too.
      let dir = path.dirname(file(key));
      while (dir.startsWith(base + path.sep)) {
        try { await fs.promises.rmdir(dir); } catch { break; }
        dir = path.dirname(dir);
      }
    },
    async close() { /* nothing */ },
  };
}

/** SHA-256 fingerprint of an SSH host key (base64, like OpenSSH "SHA256:…"). */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

async function sftpStore(cfg: Extract<BackupDestinationConfig, { kind: 'sftp' }>, onHostKey?: (fp: string) => void): Promise<BackupStore> {
  const conn = new SshClient();
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    conn.on('ready', () => conn.sftp((err, s) => (err ? reject(err) : resolve(s))));
    conn.on('error', reject);
    conn.connect({
      host: cfg.host, port: cfg.port ?? 22, username: cfg.username,
      ...(cfg.password ? { password: cfg.password } : {}), ...(cfg.privateKey ? { privateKey: cfg.privateKey } : {}),
      readyTimeout: 20_000,
      hostVerifier: (key: Buffer) => {
        const fp = hostKeyFingerprint(key);
        onHostKey?.(fp);
        return !cfg.hostKey || cfg.hostKey === fp; // pinned once known (trust on first test)
      },
    });
  });
  const root = (cfg.path || '.').replace(/\/+$/, '') || '.';
  const remote = (key: string) => `${root}/${checkKey(key)}`;
  const mkdirp = async (dir: string) => {
    const parts = dir.split('/');
    let cur = parts[0] === '' ? '' : '.';
    for (const p of parts) {
      if (!p || p === '.') continue;
      cur = cur === '' ? `/${p}` : `${cur}/${p}`;
      await new Promise<void>((resolve) => sftp.mkdir(cur, () => resolve())); // existing: fine
    }
  };
  return {
    async put(key, body) {
      const target = remote(key);
      await mkdirp(path.posix.dirname(target));
      const c = counter();
      await pipeline(body, c.t, sftp.createWriteStream(`${target}.part`, { mode: 0o600 }));
      await new Promise<void>((resolve) => sftp.unlink(target, () => resolve()));
      await new Promise<void>((resolve, reject) => sftp.rename(`${target}.part`, target, (err) => (err ? reject(err) : resolve())));
      return c.bytes();
    },
    async get(key) { return sftp.createReadStream(remote(key)); },
    async remove(key) { await new Promise<void>((resolve) => sftp.unlink(remote(key), () => resolve())); },
    async close() { conn.end(); },
  };
}

function s3Store(cfg: Extract<BackupDestinationConfig, { kind: 's3' }>): BackupStore {
  const client = new S3Client({
    region: cfg.region || 'us-east-1',
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    forcePathStyle: cfg.forcePathStyle ?? !!cfg.endpoint,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // The SDK's default CRC checksums on every part are refused by many S3-compatible providers.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const prefix = (cfg.prefix ?? '').replace(/^\/+|\/+$/g, '');
  const objectKey = (key: string) => (prefix ? `${prefix}/${checkKey(key)}` : checkKey(key));
  return {
    async put(key, body) {
      const c = counter();
      const pass = new PassThrough();
      const fed = pipeline(body, c.t, pass);
      const upload = new Upload({ client, params: { Bucket: cfg.bucket, Key: objectKey(key), Body: pass }, partSize: 16 * 1024 * 1024, queueSize: 2 });
      await Promise.all([upload.done(), fed]);
      return c.bytes();
    },
    async get(key) {
      const r = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: objectKey(key) }));
      return r.Body as Readable;
    },
    async remove(key) { await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: objectKey(key) })); },
    async close() { client.destroy(); },
  };
}

export async function openStore(cfg: BackupDestinationConfig, onHostKey?: (fp: string) => void): Promise<BackupStore> {
  if (cfg.kind === 'local') return localStore(cfg);
  if (cfg.kind === 'sftp') return sftpStore(cfg, onHostKey);
  return s3Store(cfg);
}

/** Writes, reads back and deletes a probe object. Returns the SFTP host key seen (to pin). */
export async function testStore(cfg: BackupDestinationConfig): Promise<{ hostKey: string | null }> {
  let hostKey: string | null = null;
  const store = await openStore(cfg, (fp) => { hostKey = fp; });
  try {
    const key = `oblimint-probe-${Date.now()}.txt`;
    const payload = Buffer.from(`oblimint backup probe ${new Date().toISOString()}`);
    await store.put(key, Readable.from([payload]));
    const chunks: Buffer[] = [];
    for await (const c of await store.get(key)) chunks.push(Buffer.from(c as Buffer));
    if (!Buffer.concat(chunks).equals(payload)) throw new Error('the probe read back differs');
    await store.remove(key);
  } finally {
    await store.close();
  }
  return { hostKey };
}
