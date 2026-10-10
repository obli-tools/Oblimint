import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import yauzl from 'yauzl';
import { AppError } from '../../middleware/errorHandler';

// ─────────────────────────────────────────────────────────────────────────────
// ZIP source of a stack (docs/P4b-PLAN.md §5.3). The request body is spooled
// to a temporary file (≤ zipMaxMb, 413 zipTooLarge beyond — yauzl needs the
// central directory), then extracted entry by entry with:
//   - names normalized: no absolute path, no drive letter, no `..`, no
//     backslash tricks, no NUL; directories created by the extractor only;
//   - symbolic links (and any non-regular entry) refused;
//   - the EXPANDED size counted on the actual bytes written (a lying header
//     cannot bypass zipMaxExpandedMb: zip bombs stop at the limit);
//   - at most MAX_ENTRIES entries.
// Any violation → 400 zipInvalid / 413 zipTooLarge, the partial tree removed
// by the caller.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_ENTRIES = 10_000;

export interface ZipLimits {
  maxCompressedBytes: number;
  maxExpandedBytes: number;
}

/** Copies `body` to `file`, failing with 413 beyond `max` bytes. */
export async function spoolUpload(body: NodeJS.ReadableStream, file: string, max: number): Promise<number> {
  let total = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > max) cb(new AppError(413, `The archive is larger than ${Math.round(max / 1048576)} MiB`, 'zipTooLarge'));
      else cb(null, chunk);
    },
  });
  await pipeline(body, limiter, fs.createWriteStream(file, { mode: 0o600 }));
  return total;
}

/** Safe relative path of an entry (POSIX), null when refused. */
export function safeEntryName(raw: string): string | null {
  if (!raw || raw.includes('\0') || raw.length > 1024) return null;
  const s = raw.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null;
  const parts = s.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  if (!parts.length) return null;
  return parts.join('/');
}

function invalid(message: string): AppError {
  return new AppError(400, message, 'zipInvalid');
}

/** Unix mode of an entry (upper 16 bits of the external attributes when made on Unix). */
function entryMode(entry: yauzl.Entry): number {
  const madeBy = entry.versionMadeBy >> 8;
  return madeBy === 3 ? (entry.externalFileAttributes >>> 16) & 0xffff : 0;
}

/** Extracts `zipFile` into `dest` (must not exist yet). Returns the number of files written. */
export async function extractZip(zipFile: string, dest: string, limits: ZipLimits): Promise<number> {
  fs.mkdirSync(dest, { recursive: false, mode: 0o755 });
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true, autoClose: true, strictFileNames: false, validateEntrySizes: true, decodeStrings: true }, (err, z) => {
      if (err || !z) reject(invalid(`Not a valid ZIP archive (${err?.message ?? 'unknown error'})`));
      else resolve(z);
    });
  });
  if (zip.entryCount > MAX_ENTRIES) {
    zip.close();
    throw invalid(`Too many entries (${MAX_ENTRIES} max)`);
  }
  let expanded = 0;
  let files = 0;
  return new Promise<number>((resolve, reject) => {
    let failed = false;
    const fail = (err: unknown) => {
      if (failed) return;
      failed = true;
      try { zip.close(); } catch { /* already closed */ }
      reject(err instanceof AppError ? err : invalid(`Extraction failed (${(err as Error)?.message ?? String(err)})`));
    };
    zip.on('error', fail);
    zip.on('end', () => { if (!failed) resolve(files); });
    zip.on('entry', (entry: yauzl.Entry) => {
      if (failed) return;
      const name = safeEntryName(entry.fileName);
      if (!name) { fail(invalid(`Refused entry name "${entry.fileName.slice(0, 120)}"`)); return; }
      const mode = entryMode(entry);
      const type = mode & 0o170000;
      const isDir = entry.fileName.endsWith('/');
      if (type === 0o120000) { fail(invalid(`Symbolic links are not allowed (${name.slice(0, 120)})`)); return; }
      if (type !== 0 && type !== 0o100000 && type !== 0o040000) { fail(invalid(`Special file refused (${name.slice(0, 120)})`)); return; }
      const target = path.join(dest, ...name.split('/'));
      if (!target.startsWith(path.resolve(dest) + path.sep)) { fail(invalid('Entry outside the destination')); return; }
      if (isDir || type === 0o040000) {
        try { mkdirChain(dest, name); } catch (err) { fail(err); return; }
        zip.readEntry();
        return;
      }
      if (expanded + entry.uncompressedSize > limits.maxExpandedBytes) {
        fail(new AppError(413, `The expanded archive exceeds ${Math.round(limits.maxExpandedBytes / 1048576)} MiB`, 'zipTooLarge'));
        return;
      }
      try {
        mkdirChain(dest, name.split('/').slice(0, -1).join('/'));
      } catch (err) { fail(err); return; }
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) { fail(err ?? new Error('no stream')); return; }
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            expanded += chunk.length;
            if (expanded > limits.maxExpandedBytes) cb(new AppError(413, `The expanded archive exceeds ${Math.round(limits.maxExpandedBytes / 1048576)} MiB`, 'zipTooLarge'));
            else cb(null, chunk);
          },
        });
        // wx: never write through an existing path (a duplicate entry or a planted link).
        pipeline(stream, counter, fs.createWriteStream(target, { flags: 'wx', mode: (mode & 0o111) ? 0o755 : 0o644 }))
          .then(() => { files++; zip.readEntry(); })
          .catch(fail);
      });
    });
    zip.readEntry();
  });
}

/** mkdir -p of `rel` under `root`, refusing links and non-directories on the way. */
function mkdirChain(root: string, rel: string): void {
  let cur = root;
  for (const part of rel.split('/').filter(Boolean)) {
    cur = path.join(cur, part);
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(cur); } catch { /* missing */ }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw invalid(`Path conflict in the archive (${rel.slice(0, 120)})`);
    if (!st) fs.mkdirSync(cur, { mode: 0o755 });
  }
}

/** Compose file of an extracted tree: at the root, or inside a single top directory (that becomes the root). */
export function findComposeRoot(dir: string): { root: string; file: string } | null {
  const names = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
  const at = (d: string) => names.find((n) => {
    try { return fs.lstatSync(path.join(d, n)).isFile(); } catch { return false; }
  });
  const direct = at(dir);
  if (direct) return { root: '', file: direct };
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('__MACOSX'));
  if (entries.length === 1 && entries[0].isDirectory()) {
    const inner = at(path.join(dir, entries[0].name));
    if (inner) return { root: entries[0].name, file: inner };
  }
  return null;
}
