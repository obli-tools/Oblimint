import fs from 'fs';
import path from 'path';
import readline from 'readline';
import zlib from 'zlib';
import type { Readable } from 'stream';
import type { LogFileInfo, LogLine } from '@oblimint/shared';
import {
  O_NOFOLLOW, accessLineOf, matchesAccess, parseAccessFileName, regularFile, utcDay, type AccessFilter,
} from './accessLog';

// ─────────────────────────────────────────────────────────────────────────────
// Reads the persisted access log of ONE site (directory already resolved and
// checked by the caller: existingSiteLogDir). Query = newest days first,
// bounded (≤ 2000 lines kept, ≤ 50 MiB scanned): for today's plain file only
// its tail within the remaining budget is read (the newest lines). A gzipped
// day cannot be read from its end: once started it is streamed to its end
// (a rolling ring keeps its newest matches), beyond the budget if needed, up
// to a hard ceiling (GZ_SCAN_FACTOR × budget in total, against gzip bombs).
// A gzipped day cut by that ceiling contributes NO line (its partial matches
// would be its OLDEST ones, not contiguous with the newer days): the result
// is always the newest matching lines; `truncated` says older ones may exist.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_QUERY_LINES = 2000;
export const MAX_SCAN_BYTES = 50 * 1024 * 1024;
/** A started gzipped day may push the scan up to GZ_SCAN_FACTOR × the budget (decompressed bytes, in total). */
export const GZ_SCAN_FACTOR = 4;

export interface DayFile {
  day: string;
  gz: boolean;
  file: string;
  size: number;
}

/** Persisted days of a site directory, newest first (a day with both forms lists both, plain first). */
export function listDayFiles(dir: string | null): DayFile[] {
  if (!dir) return [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: DayFile[] = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const parsed = parseAccessFileName(ent.name);
    if (!parsed) continue;
    const file = path.join(dir, ent.name);
    const st = regularFile(file);
    if (!st) continue;
    out.push({ day: parsed.day, gz: parsed.gz, file, size: st.size });
  }
  return out.sort((a, b) => (a.day === b.day ? Number(a.gz) - Number(b.gz) : a.day < b.day ? 1 : -1));
}

/** GET …/logs/files: one entry per day (sizes of both forms added). */
export function filesInfo(dir: string | null): LogFileInfo[] {
  const byDay = new Map<string, number>();
  for (const f of listDayFiles(dir)) byDay.set(f.day, (byDay.get(f.day) ?? 0) + f.size);
  return [...byDay.entries()].map(([date, sizeBytes]) => ({ date, source: 'access' as const, sizeBytes }));
}

/**
 * Lines of a day file as a readable text stream (gzip decompressed on the
 * fly; plain files from `start`). Opened with O_NOFOLLOW.
 */
export async function openDayStream(f: Pick<DayFile, 'file' | 'gz'>, start = 0): Promise<Readable> {
  const fh = await fs.promises.open(f.file, fs.constants.O_RDONLY | O_NOFOLLOW);
  const raw = fh.createReadStream({ start: f.gz ? 0 : start, autoClose: true });
  if (!f.gz) return raw;
  const gunzip = zlib.createGunzip();
  raw.on('error', (err) => gunzip.destroy(err));
  return raw.pipe(gunzip);
}

export interface AccessQueryResult {
  lines: LogLine[];
  truncated: boolean;
  scannedBytes: number;
}

/**
 * The `limit` newest matching lines (chronological order in the result),
 * scanning day files newest first within [since, until].
 */
export async function queryAccess(dir: string | null, filter: AccessFilter, limit: number, budget = MAX_SCAN_BYTES): Promise<AccessQueryResult> {
  const max = Math.min(MAX_QUERY_LINES, Math.max(1, Math.floor(limit)));
  const sinceDay = filter.sinceMs !== null ? utcDay(new Date(filter.sinceMs)) : null;
  const untilDay = filter.untilMs !== null ? utcDay(new Date(filter.untilMs)) : null;
  const days = listDayFiles(dir).filter((f) => (!sinceDay || f.day >= sinceDay) && (!untilDay || f.day <= untilDay));

  // Newest first: collected[0] = the newest group of lines.
  const collected: LogLine[][] = [];
  let count = 0;
  let scanned = 0;
  let truncated = false;
  const ceiling = budget * GZ_SCAN_FACTOR;

  for (const f of days) {
    if (count >= max) { truncated = true; break; }
    const remaining = budget - scanned;
    if (remaining <= 0) { truncated = true; break; }
    let start = 0;
    if (!f.gz && f.size > remaining) {
      start = f.size - remaining;
      truncated = true;
    }
    // Ring of the last (max - count) matches of this file.
    const room = max - count;
    const ring: LogLine[] = [];
    let fileMatches = 0;
    let cut = false; // gzipped day stopped by the ceiling before its end
    let skipFirst = start > 0; // partial first line after a seek
    const stream = await openDayStream(f, start);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const text of rl) {
        scanned += Buffer.byteLength(text) + 1;
        if (skipFirst) { skipFirst = false; continue; }
        if (text.length === 0) continue;
        const line = accessLineOf(text);
        if (line && matchesAccess(line, text.toLowerCase(), filter)) {
          fileMatches++;
          ring.push(line);
          if (ring.length > room) ring.shift();
        }
        // A plain file was started at its tail within the budget; a gzipped day goes on to its end.
        if (!f.gz && scanned >= budget) { truncated = true; break; }
        if (f.gz && scanned >= ceiling) { truncated = true; cut = true; break; }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
    if (cut) break; // not the newest matches of that day: none kept
    if (fileMatches > room) truncated = true;
    collected.push(ring);
    count += ring.length;
    if (scanned >= budget) {
      if (f !== days[days.length - 1]) truncated = true; // older days left unread
      break;
    }
  }

  const lines: LogLine[] = [];
  for (let i = collected.length - 1; i >= 0; i--) lines.push(...collected[i]);
  return { lines, truncated, scannedBytes: scanned };
}
