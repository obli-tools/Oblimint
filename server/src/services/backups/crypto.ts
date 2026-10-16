import crypto from 'crypto';
import { Transform, type TransformCallback } from 'stream';

// ─────────────────────────────────────────────────────────────────────────────
// Encryption of the backup objects (streaming, any size):
//
//   header  "OBKP" | version 1 | salt[16] | chunk size u32 BE
//   frames  flags u8 (1 = last) | length u32 BE | nonce[12] | ciphertext | tag[16]
//
// Key = scrypt(passphrase, salt, N 2^15, r 8, p 1) → 32 bytes, AES-256-GCM per
// frame with a random nonce; the AAD of a frame is the header + its index +
// its flags, so frames cannot be reordered, dropped or the stream cut short
// (a missing last frame is an error). Decryptable without the panel: the
// format is documented here and in docs (any language with scrypt + GCM).
// ─────────────────────────────────────────────────────────────────────────────

const MAGIC = Buffer.from('OBKP');
const VERSION = 1;
const HEADER_LEN = 4 + 1 + 16 + 4;
export const BACKUP_CHUNK = 1024 * 1024;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32, SCRYPT);
}

function aad(header: Buffer, index: number, flags: number): Buffer {
  const b = Buffer.alloc(header.length + 9);
  header.copy(b, 0);
  b.writeBigUInt64BE(BigInt(index), header.length);
  b.writeUInt8(flags, header.length + 8);
  return b;
}

/** Encrypting transform (plaintext in, OBKP stream out). */
export function encryptStream(passphrase: string, chunk = BACKUP_CHUNK): Transform {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(passphrase, salt);
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  header.writeUInt8(VERSION, 4);
  salt.copy(header, 5);
  header.writeUInt32BE(chunk, 21);
  let pending: Buffer = Buffer.alloc(0);
  let index = 0;
  let started = false;
  const frame = (t: Transform, data: Buffer, last: boolean) => {
    const flags = last ? 1 : 0;
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
    c.setAAD(aad(header, index++, flags));
    const ct = Buffer.concat([c.update(data), c.final()]);
    const head = Buffer.alloc(5);
    head.writeUInt8(flags, 0);
    head.writeUInt32BE(ct.length, 1);
    t.push(Buffer.concat([head, nonce, ct, c.getAuthTag()]));
  };
  return new Transform({
    transform(data: Buffer, _enc, cb: TransformCallback) {
      if (!started) { this.push(header); started = true; }
      pending = pending.length ? Buffer.concat([pending, data]) : data;
      // Keep at least one byte back: the last frame is emitted at flush.
      while (pending.length > chunk) {
        frame(this, pending.subarray(0, chunk), false);
        pending = pending.subarray(chunk);
      }
      cb();
    },
    flush(cb: TransformCallback) {
      if (!started) { this.push(header); started = true; }
      frame(this, pending, true);
      cb();
    },
  });
}

export class BackupDecryptError extends Error {}

/** Decrypting transform (OBKP stream in, plaintext out). Fails on any alteration or truncation. */
export function decryptStream(passphrase: string): Transform {
  let buf: Buffer = Buffer.alloc(0);
  let header: Buffer | null = null;
  let key: Buffer | null = null;
  let maxChunk = 0;
  let index = 0;
  let done = false;
  return new Transform({
    transform(data: Buffer, _enc, cb: TransformCallback) {
      buf = buf.length ? Buffer.concat([buf, data]) : data;
      try {
        if (!header) {
          if (buf.length < HEADER_LEN) return cb();
          header = Buffer.from(buf.subarray(0, HEADER_LEN));
          if (!header.subarray(0, 4).equals(MAGIC) || header.readUInt8(4) !== VERSION) throw new BackupDecryptError('not an Oblimint backup (bad header)');
          key = deriveKey(passphrase, header.subarray(5, 21));
          maxChunk = header.readUInt32BE(21);
          buf = buf.subarray(HEADER_LEN);
        }
        while (buf.length >= 5) {
          if (done) throw new BackupDecryptError('data after the last frame');
          const flags = buf.readUInt8(0);
          const len = buf.readUInt32BE(1);
          if (len > maxChunk + 16) throw new BackupDecryptError('frame too large');
          const total = 5 + 12 + len + 16;
          if (buf.length < total) break;
          const nonce = buf.subarray(5, 17);
          const ct = buf.subarray(17, 17 + len);
          const tag = buf.subarray(17 + len, total);
          const d = crypto.createDecipheriv('aes-256-gcm', key!, nonce);
          d.setAAD(aad(header, index++, flags));
          d.setAuthTag(tag);
          let plain: Buffer;
          try { plain = Buffer.concat([d.update(ct), d.final()]); } catch { throw new BackupDecryptError('wrong passphrase or altered backup'); }
          if (plain.length) this.push(plain);
          if (flags & 1) done = true;
          buf = buf.subarray(total);
        }
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb: TransformCallback) {
      if (!done) return cb(new BackupDecryptError('truncated backup (no last frame)'));
      cb();
    },
  });
}
