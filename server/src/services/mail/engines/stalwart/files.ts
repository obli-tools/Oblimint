import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// File writes of the stalwart driver (config.toml, DKIM keys, sync
// bookkeeping) under paths.mailEngineConfig('stalwart') — root-owned and
// mounted READ-ONLY in the container: the panel never writes into the
// container-writable store (mailEngineData), only creates that directory.
// Atomic (temporary file + rename), never through a symbolic link (R1), mode
// and owner set through the open handle, only when the content changes
// (idempotent sync: no rewrite, no reload). Ownership root:<engine gid> when
// `owner` is given (skipped on Windows).
// ─────────────────────────────────────────────────────────────────────────────

export interface FileOwner { uid: number; gid: number }

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** mkdir -p + mode / owner of the last component; refuses a symbolic link in its place. */
export async function ensureDir(dir: string, mode: number, owner: FileOwner | null): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true, mode });
  const st = await lstatOrNull(dir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (process.platform === 'win32') return;
  await fs.promises.chmod(dir, mode);
  if (owner) await fs.promises.chown(dir, owner.uid, owner.gid);
}

/** Writes `content` atomically when it differs. true = written. */
export async function writeIfChanged(file: string, content: string, mode: number, owner: FileOwner | null): Promise<boolean> {
  const st = await lstatOrNull(file);
  if (st?.isSymbolicLink()) throw new Error(`${path.basename(file)} is a symbolic link: refused`);
  if (st?.isFile()) {
    const current = await readNoFollow(file).catch(() => null);
    if (current === content) return false;
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  // O_CREAT|O_EXCL never follows a symbolic link; mode and owner are set
  // through the open handle (never by path: no symlink swap between close and
  // chmod / chown).
  const fh = await fs.promises.open(tmp, 'wx', mode);
  try {
    try {
      if (process.platform !== 'win32') {
        await fh.chmod(mode);
        if (owner) await fh.chown(owner.uid, owner.gid);
      }
      await fh.writeFile(content, 'utf8');
      await fh.sync().catch(() => undefined);
    } finally {
      await fh.close();
    }
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  return true;
}

/** Removes the regular files of `dir` matching `pattern` that are not in `keep`. true = something removed. */
export async function removeStale(dir: string, pattern: RegExp, keep: Set<string>): Promise<boolean> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  let removed = false;
  for (const n of names) {
    if (!pattern.test(n) || keep.has(n)) continue;
    const st = await lstatOrNull(path.join(dir, n));
    if (!st || !(st.isFile() || st.isSymbolicLink())) continue;
    await fs.promises.rm(path.join(dir, n), { force: true });
    removed = true;
  }
  return removed;
}

/** Reads a regular file without following a symbolic link (O_NOFOLLOW + fstat where available); null when absent. */
async function readNoFollow(file: string): Promise<string | null> {
  const st = await lstatOrNull(file);
  if (!st || !st.isFile()) return null;
  const fh = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await fh.stat()).isFile()) return null;
    return await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    const text = await readNoFollow(file);
    return text === null ? null : JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function fileExists(file: string): Promise<boolean> {
  const st = await lstatOrNull(file);
  return !!st && st.isFile();
}
