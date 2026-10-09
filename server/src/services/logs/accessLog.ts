import fs from 'fs';
import path from 'path';
import type { AccessLogEntry, LogLine } from '@oblimint/shared';
import type { EdgeLogEntry } from '../usage/edgeLog';

// ─────────────────────────────────────────────────────────────────────────────
// Persisted access log format (docs/P2-PLAN.md §9.7):
//   <logsDir>/<accountId>/<siteId>/access-YYYY-MM-DD.log      (today, appended)
//   <logsDir>/<accountId>/<siteId>/access-YYYY-MM-DD.log.gz   (past days)
// One JSON object per line (StoredAccessRecord). The tree is panel-only
// (never mounted in a tenant container), but it is still walked with lstat
// and never through a symbolic link.
// ─────────────────────────────────────────────────────────────────────────────

/** One persisted line (AccessLogEntry + a few edge fields useful later). */
export interface StoredAccessRecord extends AccessLogEntry {
  kind?: string;
  bytesOut?: number;
  bytesIn?: number;
  upstreamStatus?: string | null;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^access-(\d{4}-\d{2}-\d{2})\.log(\.gz)?$/;

/** UTC day of a date: YYYY-MM-DD. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Is `s` a real calendar day YYYY-MM-DD? */
export function isValidDay(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && utcDay(d) === s;
}

export function accessFileName(day: string, gz = false): string {
  return `access-${day}.log${gz ? '.gz' : ''}`;
}

/** { day, gz } of a persisted file name, null for anything else. */
export function parseAccessFileName(name: string): { day: string; gz: boolean } | null {
  const m = FILE_RE.exec(name);
  if (!m || !isValidDay(m[1])) return null;
  return { day: m[1], gz: !!m[2] };
}

/** Edge entry → persisted record (null when it does not belong to a site of an account). */
export function recordOf(e: EdgeLogEntry): StoredAccessRecord | null {
  if (!isPositiveInt(e.siteId) || !isPositiveInt(e.accountId)) return null;
  const rec: StoredAccessRecord = {
    time: e.time,
    host: e.host,
    remoteAddr: e.remoteAddr,
    method: e.method,
    uri: e.uri,
    status: Number(e.status) || 0,
    bytes: Number(e.bytes) || 0,
    requestTime: Number(e.requestTime) || 0,
    userAgent: e.userAgent ?? '',
    kind: e.kind,
    bytesOut: Number(e.bytesOut) || 0,
    bytesIn: Number(e.bytesIn) || 0,
    upstreamStatus: e.upstreamStatus ?? null,
  };
  if (e.referer) rec.referer = e.referer;
  return rec;
}

/** The API shape of a persisted record. */
export function accessEntryOf(r: StoredAccessRecord): AccessLogEntry {
  const out: AccessLogEntry = {
    time: String(r.time ?? ''),
    host: String(r.host ?? ''),
    remoteAddr: String(r.remoteAddr ?? ''),
    method: String(r.method ?? ''),
    uri: String(r.uri ?? ''),
    status: Number(r.status) || 0,
    bytes: Number(r.bytes) || 0,
    requestTime: Number(r.requestTime) || 0,
    userAgent: String(r.userAgent ?? ''),
  };
  if (r.referer) out.referer = String(r.referer);
  return out;
}

/** A persisted JSON line → LogLine (null when unreadable). */
export function accessLineOf(text: string): LogLine | null {
  let rec: StoredAccessRecord;
  try {
    rec = JSON.parse(text) as StoredAccessRecord;
  } catch {
    return null;
  }
  if (!rec || typeof rec !== 'object') return null;
  const access = accessEntryOf(rec);
  return { at: access.time, source: 'access', text, access };
}

/** Live tail / writer: an edge entry → LogLine (same text as the persisted line). */
export function accessLineFromRecord(rec: StoredAccessRecord): LogLine {
  const access = accessEntryOf(rec);
  return { at: access.time, source: 'access', text: JSON.stringify(rec), access };
}

export function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

// ── filters ──────────────────────────────────────────────────────────────────

export interface AccessFilter {
  sinceMs: number | null;
  untilMs: number | null;
  /** Lowercased substring. */
  q: string | null;
  /** Status filter: class ('5xx') or exact code ('404'). */
  status: { min: number; max: number } | null;
}

/** '5xx' → 500…599, '404' → 404…404; null when invalid. */
export function parseStatusFilter(s: string | null | undefined): { min: number; max: number } | null | 'invalid' {
  if (s === null || s === undefined || s === '') return null;
  const v = String(s).trim().toLowerCase();
  if (/^[1-5]xx$/.test(v)) {
    const c = Number(v[0]) * 100;
    return { min: c, max: c + 99 };
  }
  if (/^[1-5]\d\d$/.test(v)) return { min: Number(v), max: Number(v) };
  return 'invalid';
}

export function matchesAccess(line: LogLine, rawLower: string, f: AccessFilter): boolean {
  const a = line.access;
  if (!a) return false;
  if (f.status && (a.status < f.status.min || a.status > f.status.max)) return false;
  if (f.sinceMs !== null || f.untilMs !== null) {
    const t = Date.parse(a.time);
    if (Number.isNaN(t)) return false;
    if (f.sinceMs !== null && t < f.sinceMs) return false;
    if (f.untilMs !== null && t > f.untilMs) return false;
  }
  if (f.q && !rawLower.includes(f.q)) return false;
  return true;
}

// ── path safety ──────────────────────────────────────────────────────────────

/**
 * Creates `<root>/<accountId>/<siteId>` (0750) refusing any symbolic link
 * on the way (lstat of every component below root). Returns the directory.
 */
export function ensureSiteLogDir(root: string, accountId: number, siteId: number): string {
  if (!isPositiveInt(accountId) || !isPositiveInt(siteId)) throw new Error('invalid site log id');
  ensureRealDir(root);
  const acct = path.join(root, String(accountId));
  ensureRealDir(acct);
  const site = path.join(acct, String(siteId));
  ensureRealDir(site);
  return site;
}

function ensureRealDir(dir: string): void {
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (!st) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    st = fs.lstatSync(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`refusing ${dir}: not a real directory`);
}

/**
 * The site's log directory if it exists as a real directory (no symlink in
 * <root>/<account>/<site>), else null. Read paths only.
 */
export function existingSiteLogDir(root: string, accountId: number, siteId: number): string | null {
  if (!isPositiveInt(accountId) || !isPositiveInt(siteId)) return null;
  const parts = [root, path.join(root, String(accountId)), path.join(root, String(accountId), String(siteId))];
  for (const p of parts) {
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    } catch {
      return null;
    }
  }
  return parts[2];
}

/** lstat of a log file: a regular file (never a link), else null. */
export function regularFile(p: string): fs.Stats | null {
  try {
    const st = fs.lstatSync(p);
    return st.isFile() && !st.isSymbolicLink() ? st : null;
  } catch {
    return null;
  }
}

/** open(2) flags refusing a symbolic link at the last component where the OS supports it. */
export const O_NOFOLLOW = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;
