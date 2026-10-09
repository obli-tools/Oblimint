import type {
  AdapterUpdate, AdapterUpdateKind, ChangeKind, RiskLevel, WindowFile, WindowStatus,
} from '@oblimint/shared';

// Pure helpers of the P3 maintenance UI (no React, no '@/…' import: unit-tested
// with node in the scratchpad). The server stays the authority for every rule.

// ── Sizes, durations ────────────────────────────────────────────────────────

/** "0 B" / "12.3 KB" / "4.5 MB" / "1.2 GB" (base 1024, one decimal). */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** Seconds left until `iso` (0 when past or absent). */
export function secondsUntil(iso: string | null | undefined, now: number): number {
  if (!iso) return 0;
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.floor((at - now) / 1000));
}

/** Countdown "h:mm:ss" / "m:ss". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Duration choices (minutes) of the open / extend pickers, capped by the platform maximum. */
export const DURATION_CHOICES: readonly number[] = [15, 30, 60, 120, 240, 480, 1440];

export function durationChoices(max: number, extra?: number): number[] {
  const list = DURATION_CHOICES.filter((m) => m <= max);
  if (extra != null && extra >= 5 && extra <= max && !list.includes(extra)) list.push(extra);
  if (list.length === 0) list.push(Math.max(5, max));
  return list.sort((a, b) => a - b);
}

/** Minutes → "30 min" / "2 h" / "1 h 30" (units passed by the caller for i18n). */
export function formatMinutes(min: number, units: { h: string; min: string }): string {
  if (min < 60) return `${min} ${units.min}`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} ${units.h} ${String(m).padStart(2, '0')}` : `${h} ${units.h}`;
}

/** Integer in [min, max] parsed from a field, null otherwise. */
export function intIn(v: string, min: number, max: number): number | null {
  const s = v.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

// ── Statuses ────────────────────────────────────────────────────────────────

/** Statuses during which the window is busy on the server (spinner, no action). */
export const WINDOW_BUSY_STATUSES: readonly WindowStatus[] = ['opening', 'closing', 'analyzing', 'validating', 'rejecting'];

/** Tone of a risk level: none / low neutral, medium amber, high / critical red. */
export function riskTone(level: RiskLevel | null | undefined): 'muted' | 'amber' | 'red' {
  if (level === 'high' || level === 'critical') return 'red';
  if (level === 'medium') return 'amber';
  return 'muted';
}

const RISK_ORDER: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

export function maxRiskLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

// ── Time zones ──────────────────────────────────────────────────────────────

/** Used when the browser has no Intl.supportedValuesOf (old Safari / Firefox). */
export const FALLBACK_TIMEZONES: readonly string[] = [
  'UTC', 'Europe/Paris', 'Europe/London', 'Europe/Brussels', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome', 'Europe/Zurich',
  'Europe/Amsterdam', 'Europe/Lisbon', 'Europe/Warsaw', 'Europe/Moscow', 'Africa/Casablanca', 'Africa/Algiers', 'Africa/Tunis',
  'Africa/Dakar', 'Africa/Abidjan', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Montreal', 'America/Toronto', 'America/Sao_Paulo', 'America/Martinique', 'America/Guadeloupe', 'America/Cayenne',
  'Indian/Reunion', 'Indian/Mayotte', 'Pacific/Noumea', 'Pacific/Tahiti', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore',
  'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney',
];

/** IANA zones of the browser (UTC first), or the fallback list; `current` is always included. */
export function listTimezones(current?: string | null): string[] {
  let zones: string[] = [];
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (typeof fn === 'function') zones = fn('timeZone');
  } catch {
    zones = [];
  }
  if (zones.length === 0) zones = [...FALLBACK_TIMEZONES];
  const set = new Set(zones);
  set.delete('UTC');
  if (current && current !== 'UTC') set.add(current);
  return ['UTC', ...[...set].sort()];
}

/** Zone of the browser, 'UTC' when unknown. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ── Kick path, slugs, packages ──────────────────────────────────────────────

/** Path requested during a scheduled window: absolute, no scheme / host, no space, ≤ 255. */
export function isValidKickPath(p: string): boolean {
  return p.length <= 255 && /^\/[^\s?#]*(\?[^\s#]*)?$/.test(p) && !p.startsWith('//');
}

export const WP_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export const COMPOSER_PACKAGE_RE = /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]?|-{0,2})[a-z0-9]+)*$/;

/** "a, b  c" → ['a', 'b', 'c'] (deduplicated, lower case). */
export function splitList(input: string): string[] {
  return [...new Set(input.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

// ── Updates ─────────────────────────────────────────────────────────────────

const KIND_ORDER: readonly AdapterUpdateKind[] = ['core', 'plugin', 'theme', 'translation', 'package', 'module', 'app'];

/** Updates grouped by kind, in a stable order (core first). */
export function groupUpdates(updates: readonly AdapterUpdate[]): Array<{ kind: AdapterUpdateKind; items: AdapterUpdate[] }> {
  const map = new Map<AdapterUpdateKind, AdapterUpdate[]>();
  for (const u of updates) {
    const list = map.get(u.kind) ?? [];
    list.push(u);
    map.set(u.kind, list);
  }
  return KIND_ORDER.filter((k) => map.has(k)).map((kind) => ({ kind, items: map.get(kind)!.sort((a, b) => a.name.localeCompare(b.name)) }));
}

// ── Change tree (review page) ───────────────────────────────────────────────

export interface TreeCounts {
  total: number;
  added: number;
  modified: number;
  deleted: number;
  executable: number;
  ignored: number;
  findings: number;
  maxLevel: RiskLevel;
}

export interface TreeDir {
  name: string;
  /** '' for the root, 'wp-content/plugins' otherwise. */
  path: string;
  dirs: TreeDir[];
  files: WindowFile[];
  counts: TreeCounts;
}

function emptyCounts(): TreeCounts {
  return { total: 0, added: 0, modified: 0, deleted: 0, executable: 0, ignored: 0, findings: 0, maxLevel: 'none' };
}

function addFile(c: TreeCounts, f: WindowFile): void {
  c.total += 1;
  if (f.change === 'added') c.added += 1;
  else if (f.change === 'deleted') c.deleted += 1;
  else c.modified += 1; // modified + typechange
  if (f.executable) c.executable += 1;
  if (f.ignored) c.ignored += 1;
  c.findings += f.findings.length;
  c.maxLevel = maxRiskLevel(c.maxLevel, f.level);
}

/**
 * Folder tree of the changed paths, with counts per folder (every ancestor
 * counts the files below it). Folders first, then files, alphabetical. Linear
 * in the number of path segments: fine for tens of thousands of entries.
 */
export function buildFileTree(files: readonly WindowFile[]): TreeDir {
  const root: TreeDir = { name: '', path: '', dirs: [], files: [], counts: emptyCounts() };
  const index = new Map<string, TreeDir>([['', root]]);
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let dir = root;
    addFile(root.counts, f);
    for (let i = 0; i < parts.length - 1; i += 1) {
      const path = parts.slice(0, i + 1).join('/');
      let next = index.get(path);
      if (!next) {
        next = { name: parts[i], path, dirs: [], files: [], counts: emptyCounts() };
        index.set(path, next);
        dir.dirs.push(next);
      }
      addFile(next.counts, f);
      dir = next;
    }
    dir.files.push(f);
  }
  const sortDir = (d: TreeDir) => {
    d.dirs.sort((a, b) => a.name.localeCompare(b.name));
    d.files.sort((a, b) => a.path.localeCompare(b.path));
    d.dirs.forEach(sortDir);
  };
  sortDir(root);
  return root;
}

/** Collapses chains of single-child folders ("wp-content/plugins/akismet") for a compact tree. */
export function compactDir(d: TreeDir): TreeDir {
  let cur = d;
  let name = d.name;
  while (cur.files.length === 0 && cur.dirs.length === 1) {
    cur = cur.dirs[0];
    name = name ? `${name}/${cur.name}` : cur.name;
  }
  return cur === d ? d : { ...cur, name };
}

/** Folders to open by default: the ancestors of risky files, plus the root levels when the tree is small. */
export function defaultExpanded(root: TreeDir, smallTree = 200): Set<string> {
  const open = new Set<string>(['']);
  const walk = (d: TreeDir) => {
    const risky = d.counts.maxLevel === 'medium' || d.counts.maxLevel === 'high' || d.counts.maxLevel === 'critical';
    if (risky || root.counts.total <= smallTree) open.add(d.path);
    d.dirs.forEach(walk);
  };
  root.dirs.forEach(walk);
  return open;
}

export function fileName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

export const CHANGE_KINDS: readonly ChangeKind[] = ['added', 'modified', 'deleted', 'typechange'];

// ── Quarantine preview ──────────────────────────────────────────────────────

/** Base64 → bytes (empty on invalid input). */
export function decodeBase64(b64: string): Uint8Array {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

/** Classic hex dump: "00000000  3c 3f 70 68 70 20 …  |<?php …|", 16 bytes per line. */
export function hexDump(bytes: Uint8Array, maxBytes = 4096): string {
  const n = Math.min(bytes.length, maxBytes);
  const lines: string[] = [];
  for (let off = 0; off < n; off += 16) {
    const chunk = bytes.subarray(off, Math.min(off + 16, n));
    const hex: string[] = [];
    let ascii = '';
    for (let i = 0; i < 16; i += 1) {
      if (i < chunk.length) {
        hex.push(chunk[i].toString(16).padStart(2, '0'));
        ascii += chunk[i] >= 0x20 && chunk[i] < 0x7f ? String.fromCharCode(chunk[i]) : '.';
      } else {
        hex.push('  ');
      }
    }
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.slice(0, 8).join(' ')}  ${hex.slice(8).join(' ')}  |${ascii}|`);
  }
  return lines.join('\n');
}

/** UTF-8 text of the bytes (invalid sequences replaced), NUL bytes shown as ␀. */
export function bytesToText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return text.replace(/\u0000/g, '␀');
}

// ── Site API ────────────────────────────────────────────────────────────────

/** curl example of the token API (POST /api/site-api/window). */
export function curlOpenExample(origin: string, token: string, durationMinutes = 30): string {
  const base = origin.replace(/\/+$/, '');
  return [
    `curl -X POST ${base}/api/site-api/window \\`,
    `  -H "Authorization: Bearer ${token}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '{"durationMinutes": ${durationMinutes}}'`,
  ].join('\n');
}
