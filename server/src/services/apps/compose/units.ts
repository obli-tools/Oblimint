// Compose value parsers (sizes, durations, CPUs, command lines). PURE.

const SIZE_UNITS: Record<string, number> = {
  '': 1, b: 1,
  k: 1024, kb: 1024, ki: 1024, kib: 1024,
  m: 1024 ** 2, mb: 1024 ** 2, mi: 1024 ** 2, mib: 1024 ** 2,
  g: 1024 ** 3, gb: 1024 ** 3, gi: 1024 ** 3, gib: 1024 ** 3,
  t: 1024 ** 4, tb: 1024 ** 4,
};

/** "512m", "1.5g", "1024" (bytes), 268435456 → bytes; null when unparsable. */
export function parseSize(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  if (typeof v !== 'string') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)\s*$/.exec(v);
  if (!m) return null;
  const unit = SIZE_UNITS[m[2].toLowerCase()];
  if (unit === undefined) return null;
  return Math.round(Number(m[1]) * unit);
}

const DURATION_UNITS: Record<string, number> = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** Go-style duration ("1m30s", "500ms", "10s") or a number of seconds → milliseconds; null when unparsable. */
export function parseDurationMs(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 1000) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
  let total = 0;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    total += Number(m[1]) * DURATION_UNITS[m[2]];
    consumed += m[0].length;
  }
  if (consumed === 0 || consumed !== s.length) return null;
  return Math.round(total);
}

/** cpus: 0.5, "1.5" → number; null when unparsable / not positive. */
export function parseCpus(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Shell-like word splitting of a compose string command (no expansion,
 * quotes and backslashes honoured, like compose's shlex).
 */
export function splitCommand(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === '\\' && quote === '"' && i + 1 < s.length && /["\\$`]/.test(s[i + 1])) { cur += s[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; inWord = true; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; inWord = true; continue; }
    if (/\s/.test(c)) {
      if (inWord) { out.push(cur); cur = ''; inWord = false; }
      continue;
    }
    cur += c;
    inWord = true;
  }
  if (inWord) out.push(cur);
  return out;
}

export const MiB = 1024 * 1024;
