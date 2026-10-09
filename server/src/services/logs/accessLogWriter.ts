import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { logger } from '../../utils/logger';
import {
  O_NOFOLLOW, accessFileName, ensureSiteLogDir, isPositiveInt, parseAccessFileName, regularFile, utcDay,
  type StoredAccessRecord,
} from './accessLog';

// ─────────────────────────────────────────────────────────────────────────────
// Per-site access log writer (docs/P2-PLAN.md §9.7). Fed by the edge log
// subscription (logs.service.ts); entries are buffered in memory and appended
// every second to <root>/<account>/<site>/access-<UTC day>.log. At most ONE
// open file per active site (closed after 5 min without traffic or at the
// day change); past days are gzipped, files older than the retention are
// removed (maintenance, hourly + at start). Never follows a symbolic link
// (lstat on the tree, O_NOFOLLOW on open where the OS has it).
// ─────────────────────────────────────────────────────────────────────────────

export interface AccessLogWriterOptions {
  /** Root of the tree (config.hosting.logsDir). */
  root: string;
  now?: () => Date;
  flushMs?: number;
  idleCloseMs?: number;
  /** Memory bound of the pending lines (all sites): beyond, the oldest are dropped. */
  maxBufferedBytes?: number;
}

interface SiteState {
  accountId: number;
  siteId: number;
  lines: string[];
  bytes: number;
  fh: fs.promises.FileHandle | null;
  day: string | null;
  lastWrite: number;
}

const DAY_MS = 86_400_000;

export class AccessLogWriter {
  private readonly sites = new Map<string, SiteState>();
  private readonly now: () => Date;
  private readonly flushMs: number;
  private readonly idleCloseMs: number;
  private readonly maxBufferedBytes: number;
  private buffered = 0;
  private flushing: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private droppedWarned = false;
  /** Files being gzipped (never twice at once). */
  private readonly gzipping = new Set<string>();

  constructor(private readonly opts: AccessLogWriterOptions) {
    this.now = opts.now ?? (() => new Date());
    this.flushMs = opts.flushMs ?? 1000;
    this.idleCloseMs = opts.idleCloseMs ?? 5 * 60_000;
    this.maxBufferedBytes = opts.maxBufferedBytes ?? 16 * 1024 * 1024;
  }

  get root(): string {
    return this.opts.root;
  }

  /** Queues one record of a site (fast, never throws). */
  append(accountId: number, siteId: number, rec: StoredAccessRecord): void {
    if (!isPositiveInt(accountId) || !isPositiveInt(siteId)) return;
    const key = `${accountId}/${siteId}`;
    let st = this.sites.get(key);
    if (!st) {
      st = { accountId, siteId, lines: [], bytes: 0, fh: null, day: null, lastWrite: Date.now() };
      this.sites.set(key, st);
    }
    const line = JSON.stringify(rec);
    st.lines.push(line);
    st.bytes += line.length + 1;
    this.buffered += line.length + 1;
    if (this.buffered > this.maxBufferedBytes) this.dropOldest();
  }

  private dropOldest(): void {
    if (!this.droppedWarned) {
      logger.warn({ root: this.opts.root }, 'Access log writer: buffer full (disk slow or failing), dropping lines');
      this.droppedWarned = true;
    }
    for (const st of this.sites.values()) {
      while (st.lines.length > 0 && this.buffered > this.maxBufferedBytes / 2) {
        const l = st.lines.shift() as string;
        st.bytes -= l.length + 1;
        this.buffered -= l.length + 1;
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, this.flushMs);
    this.timer.unref?.();
  }

  /** Stops the timer, writes what is pending and closes every file. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    for (const st of this.sites.values()) await this.close(st);
    this.sites.clear();
  }

  /** Writes the pending lines of every site (serialized). */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.flushAll().finally(() => { this.flushing = null; });
    }
    return this.flushing;
  }

  private async flushAll(): Promise<void> {
    const day = utcDay(this.now());
    const nowMs = Date.now();
    for (const [key, st] of this.sites) {
      if (st.lines.length === 0) {
        if (st.fh && (nowMs - st.lastWrite > this.idleCloseMs || st.day !== day)) await this.rollOver(st);
        if (!st.fh) this.sites.delete(key);
        continue;
      }
      const lines = st.lines;
      const bytes = st.bytes;
      st.lines = [];
      st.bytes = 0;
      this.buffered -= bytes;
      try {
        if (st.fh && st.day !== day) await this.rollOver(st);
        if (!st.fh) await this.open(st, day);
        await st.fh!.write(`${lines.join('\n')}\n`);
        st.lastWrite = nowMs;
      } catch (err) {
        logger.warn({ err, accountId: st.accountId, siteId: st.siteId }, 'Access log writer: write failed, lines dropped');
        await this.close(st);
      }
    }
    if (this.buffered < this.maxBufferedBytes / 4) this.droppedWarned = false;
  }

  private async open(st: SiteState, day: string): Promise<void> {
    const dir = ensureSiteLogDir(this.opts.root, st.accountId, st.siteId);
    const file = path.join(dir, accessFileName(day));
    const existing = fs.existsSync(file) ? regularFile(file) : null;
    if (fs.existsSync(file) && !existing) throw new Error(`refusing ${file}: not a regular file`);
    st.fh = await fs.promises.open(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | O_NOFOLLOW, 0o640);
    st.day = day;
  }

  private async close(st: SiteState): Promise<void> {
    const fh = st.fh;
    st.fh = null;
    if (fh) {
      try { await fh.close(); } catch { /* already closed */ }
    }
  }

  /** Closes the current file; a past day is gzipped right away. */
  private async rollOver(st: SiteState): Promise<void> {
    const prevDay = st.day;
    await this.close(st);
    st.day = null;
    if (prevDay && prevDay < utcDay(this.now())) {
      const dir = path.join(this.opts.root, String(st.accountId), String(st.siteId));
      void this.gzip(path.join(dir, accessFileName(prevDay))).catch((err) => {
        logger.warn({ err, file: accessFileName(prevDay) }, 'Access log writer: gzip failed');
      });
    }
  }

  /** Days with an open file (never gzipped / purged under the writer's feet). */
  private openFiles(): Set<string> {
    const out = new Set<string>();
    for (const st of this.sites.values()) {
      if (st.fh && st.day) out.add(path.join(this.opts.root, String(st.accountId), String(st.siteId), accessFileName(st.day)));
    }
    return out;
  }

  /**
   * Gzips `<file>` into `<file>.gz` (appending a gzip member when the .gz
   * already exists: concatenated members are a valid gzip stream), then
   * removes the plain file.
   */
  async gzip(file: string): Promise<void> {
    if (this.gzipping.has(file)) return;
    this.gzipping.add(file);
    const tmp = `${file}.gz.tmp`;
    try {
      if (!regularFile(file)) return;
      const dest = `${file}.gz`;
      if (fs.existsSync(dest) && !regularFile(dest)) throw new Error(`refusing ${dest}: not a regular file`);
      try { fs.unlinkSync(tmp); } catch { /* none */ }
      const src = await fs.promises.open(file, fs.constants.O_RDONLY | O_NOFOLLOW);
      const out = await fs.promises.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o640);
      try {
        await pipeline(src.createReadStream(), zlib.createGzip(), out.createWriteStream());
      } finally {
        await src.close().catch(() => undefined);
        await out.close().catch(() => undefined);
      }
      if (regularFile(dest)) {
        await fs.promises.appendFile(dest, await fs.promises.readFile(tmp));
        await fs.promises.unlink(tmp);
      } else {
        await fs.promises.rename(tmp, dest);
      }
      await fs.promises.unlink(file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* none */ }
      throw err;
    } finally {
      this.gzipping.delete(file);
    }
  }

  /**
   * Walks <root>/<account>/<site>: gzips past plain days, removes the days
   * older than `retentionDays`. Symbolic links and foreign names are skipped.
   */
  async maintenance(retentionDays: number): Promise<{ gzipped: number; purged: number }> {
    const today = utcDay(this.now());
    const cutoff = utcDay(new Date(this.now().getTime() - Math.max(1, Math.floor(retentionDays)) * DAY_MS));
    const open = this.openFiles();
    let gzipped = 0;
    let purged = 0;
    for (const acct of realSubdirs(this.opts.root)) {
      for (const site of realSubdirs(acct)) {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(site, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
          if (!ent.isFile()) continue; // symbolic links / dirs are never touched
          const parsed = parseAccessFileName(ent.name);
          if (!parsed) continue;
          const file = path.join(site, ent.name);
          if (open.has(file)) continue;
          try {
            if (parsed.day < cutoff) {
              fs.unlinkSync(file);
              purged++;
            } else if (!parsed.gz && parsed.day < today) {
              await this.gzip(file);
              gzipped++;
            }
          } catch (err) {
            logger.warn({ err, file }, 'Access log maintenance failed for a file');
          }
        }
      }
    }
    return { gzipped, purged };
  }
}

/** Numeric, real (non-link) sub-directories of `dir`. */
function realSubdirs(dir: string): string[] {
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[1-9]\d{0,9}$/.test(e.name))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}
