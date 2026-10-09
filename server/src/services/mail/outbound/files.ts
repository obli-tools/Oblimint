import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// File writes of the outbound module (site msmtprc, relay files): atomic
// (temporary file created with O_EXCL in the same directory, then rename),
// never following a symlink (the directory is lstat-ed; O_EXCL refuses an
// existing link as temporary file; rename replaces a link at the target
// instead of writing through it), owner / mode set on the open descriptor
// before the rename. Ownership is skipped on Windows (dev / tests).
// ─────────────────────────────────────────────────────────────────────────────

export interface FileOwner {
  uid: number;
  gid: number;
  mode: number;
}

export class UnsafePathError extends Error {
  constructor(p: string, why: string) {
    super(`unsafe path ${p}: ${why}`);
    this.name = 'UnsafePathError';
  }
}

/** The directory exists, is a real directory (not a symlink). false = missing. */
export async function realDirectory(dir: string): Promise<boolean> {
  try {
    const st = await fs.promises.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new UnsafePathError(dir, 'not a directory');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

const canChown = () => process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0;

/** Writes `content` atomically to `file` (its directory must exist and be real). */
export async function writeFileAtomic(file: string, content: string, owner: FileOwner): Promise<void> {
  const dir = path.dirname(file);
  if (!(await realDirectory(dir))) throw new UnsafePathError(dir, 'missing directory');
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fh = await fs.promises.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await fh.writeFile(content, 'utf8');
    if (canChown()) await fh.chown(owner.uid, owner.gid);
    await fh.chmod(owner.mode);
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => {});
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  await fh.close();
  try {
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Content of a regular file (never through a symlink), null when missing / not a regular file. */
export async function readRegularFile(file: string): Promise<string | null> {
  try {
    const st = await fs.promises.lstat(file);
    if (!st.isFile()) return null;
    return await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Removes a file (or a stray symlink) without following it. true = something was removed. */
export async function removeFile(file: string): Promise<boolean> {
  try {
    const st = await fs.promises.lstat(file);
    if (st.isDirectory()) throw new UnsafePathError(file, 'is a directory');
    await fs.promises.unlink(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** mkdir -p + owner / mode of the LAST component (panel-owned trees only). */
export async function ensureDir(dir: string, owner: FileOwner): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true, mode: owner.mode });
  if (!(await realDirectory(dir))) throw new UnsafePathError(dir, 'missing directory');
  if (canChown()) await fs.promises.chown(dir, owner.uid, owner.gid);
  await fs.promises.chmod(dir, owner.mode);
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}
