import type { LogLine } from '@oblimint/shared';

// Pure helpers of the logs tab (no React): memory cap of the live tail,
// status colours, client-side filtering of streamed lines.

/** Lines kept in memory by the tab (query result + live tail). */
export const LOG_LINES_CAP = 2000;

/** Append `incoming` to `current`, keeping the last `cap` lines. */
export function appendCapped<T>(current: readonly T[], incoming: readonly T[], cap = LOG_LINES_CAP): T[] {
  if (incoming.length === 0) return current as T[];
  const merged = [...current, ...incoming];
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

export type StatusClass = '' | '2xx' | '3xx' | '4xx' | '5xx';
export const STATUS_CLASSES: readonly Exclude<StatusClass, ''>[] = ['2xx', '3xx', '4xx', '5xx'];

/** Tailwind text colour of an HTTP status. */
export function statusColor(status: number): string {
  if (status >= 500) return 'text-status-down';
  if (status >= 400) return 'text-amber-400';
  if (status >= 300) return 'text-sky-400';
  if (status >= 200) return 'text-green-400';
  return 'text-text-muted';
}

/** Does a streamed line pass the filters of the tab (text, status class)? */
export function lineMatches(line: LogLine, q: string, status: StatusClass): boolean {
  if (status && line.access) {
    const cls = Math.floor(line.access.status / 100);
    if (`${cls}xx` !== status) return false;
  } else if (status && line.source === 'access' && !line.access) {
    return false;
  }
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return line.text.toLowerCase().includes(needle);
}

/** Chronological order (oldest first), stable for equal timestamps. */
export function sortByTime(lines: readonly LogLine[]): LogLine[] {
  return lines
    .map((l, i) => ({ l, i, ts: Date.parse(l.at) }))
    .sort((a, b) => ((Number.isNaN(a.ts) || Number.isNaN(b.ts) || a.ts === b.ts) ? a.i - b.i : a.ts - b.ts))
    .map((x) => x.l);
}

/** Bytes of a response, compact ("532", "12.4k", "3.1M"). */
export function compactBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1024 * 1024) return `${Math.round((n / (1024 * 1024)) * 10) / 10}M`;
  if (n >= 1024) return `${Math.round((n / 1024) * 10) / 10}k`;
  return String(n);
}

/** Request time (seconds, nginx $request_time) → "12 ms" / "1.24 s". */
export function formatRequestTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 1) return `${Math.round(sec * 1000)} ms`;
  return `${Math.round(sec * 100) / 100} s`;
}
