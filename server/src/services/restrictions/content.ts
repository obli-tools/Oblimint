import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Transform, type Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { AppError } from '../../middleware/errorHandler';

// ─────────────────────────────────────────────────────────────────────────────
// A large content (an SQL dump) entering the fingerprint of a protected action
// (spec §1.4: sha256 + size): copied to a private temporary file while hashed,
// then the operation reads THAT copy — never its source again, which could
// have changed between the approval and the execution.
// ─────────────────────────────────────────────────────────────────────────────

/** Largest content a protected import holds on disk while it is fingerprinted (the dump limit). */
export const SPOOL_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export interface Spooled {
  file: string;
  sha256: string;
  size: number;
  open(): Readable;
  /** Removes the copy (never throws). */
  cleanup(): Promise<void>;
}

/** Copies `src` into a private temporary file, hashing it; 413 above `max` bytes. */
export async function spoolHashed(src: Readable, max = SPOOL_MAX_BYTES): Promise<Spooled> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oblimint-gated-'));
  const file = path.join(dir, 'content');
  const cleanup = () => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  const h = crypto.createHash('sha256');
  let size = 0;
  const count = new Transform({
    transform(c: Buffer, _e, cb) {
      size += c.length;
      if (size > max) { cb(new AppError(413, `A protected import is at most ${max} bytes`, 'fileTooLarge')); return; }
      h.update(c);
      cb(null, c);
    },
  });
  try {
    await pipeline(src, count, fs.createWriteStream(file, { mode: 0o600 }));
  } catch (err) {
    await cleanup();
    src.resume?.();
    throw err;
  }
  return { file, sha256: h.digest('hex'), size, open: () => fs.createReadStream(file), cleanup };
}
