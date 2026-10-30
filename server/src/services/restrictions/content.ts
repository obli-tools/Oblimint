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

/**
 * Copies held on disk at once: per principal (a key, a panel user) and in all.
 * A copy lives from its first byte until its cleanup (the import included);
 * above: 429 tooManyProtectedImports, before a single byte is written — 20
 * parallel 2 GB dumps never fill the panel's disk.
 */
export const SPOOL_MAX_PER_OWNER = 1;
export const SPOOL_MAX_TOTAL = 4;
const live = new Map<string, number>();
let liveTotal = 0;

function claim(owner: string): () => void {
  if ((live.get(owner) ?? 0) >= SPOOL_MAX_PER_OWNER || liveTotal >= SPOOL_MAX_TOTAL) {
    throw new AppError(429, 'Another protected import is being checked: wait for it to finish, then try again', 'tooManyProtectedImports', {
      perPrincipal: SPOOL_MAX_PER_OWNER, total: SPOOL_MAX_TOTAL,
    });
  }
  live.set(owner, (live.get(owner) ?? 0) + 1);
  liveTotal++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (live.get(owner) ?? 1) - 1;
    if (n <= 0) live.delete(owner); else live.set(owner, n);
    liveTotal = Math.max(0, liveTotal - 1);
  };
}

/** Tests: copies currently counted. */
export function spoolsInFlight(): number {
  return liveTotal;
}

/**
 * Copies `src` into a private temporary file, hashing it; 413 above `max`
 * bytes, 429 when `owner` (or the panel) already holds its share of copies.
 */
export async function spoolHashed(src: Readable, owner: string, max = SPOOL_MAX_BYTES): Promise<Spooled> {
  let release: () => void;
  try {
    release = claim(owner);
  } catch (err) {
    src.resume?.();
    throw err;
  }
  let dir: string;
  try {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oblimint-gated-'));
  } catch (err) {
    release();
    src.resume?.();
    throw err;
  }
  const file = path.join(dir, 'content');
  const cleanup = () => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined).finally(release);
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
