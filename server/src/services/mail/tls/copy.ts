import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { isValidServerName } from '../../edge/nginxConfig';

// ─────────────────────────────────────────────────────────────────────────────
// Copy of an edge certificate into the mail certificate store (docs/P4-PLAN.md
// §4, §9.4) — module mail-dns-tls. edge/certs/<name>/{fullchain,privkey}.pem
// → mail/certs/<name>/ : mode 0640 (group = the engine's when given), atomic
// (temporary file + rename in the same directory), never through a symbolic
// link (source, destination directory or file: refused), content compared
// first so an unchanged renewal does not reload the engine.
// ─────────────────────────────────────────────────────────────────────────────

export const CERT_FILES = ['fullchain.pem', 'privkey.pem'] as const;

export class CertCopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CertCopyError';
  }
}

const O_NOFOLLOW = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;

/** Reads a regular file without following a link (lstat + O_NOFOLLOW where the OS has it). */
function readRegular(file: string): Buffer {
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new CertCopyError(`${path.basename(file)} is not a regular file`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function ensureDir(dir: string, mode: number, recursive = false): void {
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new CertCopyError(`${dir} is not a plain directory`);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(dir, { recursive, mode });
}

function writeAtomic(dir: string, name: string, data: Buffer, opts: { mode: number; gid: number | null }): void {
  const target = path.join(dir, name);
  try {
    const st = fs.lstatSync(target);
    if (!st.isFile()) throw new CertCopyError(`${name} exists and is not a regular file`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const tmp = path.join(dir, `.${name}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, opts.mode);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    if (opts.gid !== null && process.platform !== 'win32') fs.fchownSync(fd, 0, opts.gid);
    fs.fchmodSync(fd, opts.mode);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export interface CopyOptions {
  /** Group of the files (engine gid); null = the panel's (root). */
  gid?: number | null;
  /** File mode (default 0640). */
  mode?: number;
}

/**
 * Copies <srcRoot>/<name>/{fullchain,privkey}.pem into <dstRoot>/<name>/.
 * Returns true when a file changed, false when both were already identical.
 * Throws CertCopyError / fs errors (missing source, link, invalid name).
 */
export function copyCertificate(srcRoot: string, dstRoot: string, name: string, opts: CopyOptions = {}): boolean {
  if (!isValidServerName(name)) throw new CertCopyError('invalid certificate name');
  const mode = opts.mode ?? 0o640;
  const gid = opts.gid ?? null;
  const srcDir = path.join(srcRoot, name);
  const srcSt = fs.lstatSync(srcDir);
  if (srcSt.isSymbolicLink() || !srcSt.isDirectory()) throw new CertCopyError('the source certificate directory is not a plain directory');
  // Both files read first: never a new certificate with the old key.
  const data = CERT_FILES.map((f) => readRegular(path.join(srcDir, f)));
  if (data.some((d) => d.length === 0)) throw new CertCopyError('empty certificate file');
  ensureDir(dstRoot, 0o711, true);
  const dstDir = path.join(dstRoot, name);
  ensureDir(dstDir, 0o750);
  // The pair is replaced by two renames inside ONE synchronous call: no other
  // copier of this process (edge hook, certificates() during a sync) can run
  // in between, and the engine reload is requested only after it returns.
  // Keep this function synchronous.
  let changed = false;
  CERT_FILES.forEach((f, i) => {
    const target = path.join(dstDir, f);
    let current: Buffer | null = null;
    try { current = readRegular(target); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (current && current.equals(data[i])) return;
    writeAtomic(dstDir, f, data[i], { mode, gid });
    changed = true;
  });
  return changed;
}

/** Both files of a copied certificate exist (regular files). */
export function copiedCertificateExists(dstRoot: string, name: string): boolean {
  if (!isValidServerName(name)) return false;
  return CERT_FILES.every((f) => {
    try {
      return fs.lstatSync(path.join(dstRoot, name, f)).isFile();
    } catch {
      return false;
    }
  });
}

/** Names (plain directories or stray entries with a valid name) present under the mail certificate store. Never follows a link. */
export function listCopiedCertificates(dstRoot: string): string[] {
  try {
    const st = fs.lstatSync(dstRoot);
    if (st.isSymbolicLink() || !st.isDirectory()) return [];
  } catch {
    return [];
  }
  return fs.readdirSync(dstRoot).filter((n) => isValidServerName(n)).sort();
}

/**
 * Removes <dstRoot>/<name> (copied chain + private key of a certificate the
 * mail service no longer uses). The root must be a plain directory; a link in
 * place of <name> is unlinked itself, never followed (rmSync does not follow
 * links inside the tree). Returns true when something was removed.
 */
export function removeCopiedCertificate(dstRoot: string, name: string): boolean {
  if (!isValidServerName(name)) throw new CertCopyError('invalid certificate name');
  const rootSt = fs.lstatSync(dstRoot);
  if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) throw new CertCopyError('the mail certificate store is not a plain directory');
  const dir = path.join(dstRoot, name);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (!st.isDirectory()) {
    fs.unlinkSync(dir);
    return true;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
