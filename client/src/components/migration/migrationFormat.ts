import type {
  MigrationDiscoveryStatus, MigrationFollowUp, MigrationPlanResult, MigrationRunStatus, MigrationSeverity, MigrationWarning,
} from '@oblimint/shared';

// Pure helpers of the CWP migration screens (docs/P5-PLAN.md §11). OWNED BY MODULE `ui-migration`.

export interface ByteUnits { b: string; kb: string; mb: string; gb: string; tb: string }

/** "1.4 GB" (1024 based, units translated: o / Ko / Mo / Go in French). */
export function formatBytes(bytes: number | null | undefined, u: ByteUnits): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const steps: Array<[number, string]> = [[1024 ** 4, u.tb], [1024 ** 3, u.gb], [1024 ** 2, u.mb], [1024, u.kb]];
  for (const [size, unit] of steps) {
    if (Math.abs(bytes) >= size) return `${trimNum(bytes / size)} ${unit}`;
  }
  return `${Math.round(bytes)} ${u.b}`;
}

export function trimNum(n: number, decimals = 1): string {
  return Number(n.toFixed(decimals)).toString();
}

/** "850 ms", "12 s", "3 min 05 s", "2 h 07 min". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Duration between two ISO dates (end = now when still running). */
export function durationBetween(start: string | null | undefined, end: string | null | undefined, now = Date.now()): number | null {
  if (!start) return null;
  const a = Date.parse(start);
  const b = end ? Date.parse(end) : now;
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
}

export function formatDateTime(iso: string | null | undefined, lang: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' });
}

/** 0…100, null when the total is unknown. */
export function progressPct(done: number | null | undefined, total: number | null | undefined): number | null {
  if (done == null || !total || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

/** "key=value" chips of message parameters (stable order, nulls shown as —). */
export function paramEntries(params: Record<string, string | number | boolean | null> | null | undefined): Array<[string, string]> {
  if (!params) return [];
  return Object.keys(params).sort().map((k) => {
    const v = params[k];
    return [k, v == null ? '—' : String(v)];
  });
}

/** Raw rendering of an untranslated code: `code (a=1, b=x)` — keeps a server / client mismatch visible. */
export function rawCode(code: string, params?: Record<string, string | number | boolean | null> | null): string {
  const p = paramEntries(params);
  return p.length ? `${code} (${p.map(([k, v]) => `${k}=${v}`).join(', ')})` : code;
}

export const SEVERITY_ORDER: readonly MigrationSeverity[] = ['blocking', 'warning', 'info'];

export function severityCounts(warnings: ReadonlyArray<{ severity: MigrationSeverity }>): Record<MigrationSeverity, number> {
  const c: Record<MigrationSeverity, number> = { blocking: 0, warning: 0, info: 0 };
  for (const w of warnings) c[w.severity] = (c[w.severity] ?? 0) + 1;
  return c;
}

export function sortWarnings<T extends MigrationWarning>(warnings: readonly T[]): T[] {
  return [...warnings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    || (a.scope.account ?? '').localeCompare(b.scope.account ?? '') || a.code.localeCompare(b.code));
}

/** Warnings attached to one object of the plan (scope kind + key). */
export function warningsFor<T extends MigrationWarning>(warnings: readonly T[], kind: string | readonly string[], key: string): T[] {
  const kinds = typeof kind === 'string' ? [kind] : kind;
  return warnings.filter((w) => kinds.includes(w.scope.kind) && w.scope.key === key);
}

export const ACTIVE_RUN_STATUSES: readonly MigrationRunStatus[] = ['queued', 'running', 'paused'];
export function isRunActive(s: MigrationRunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(s);
}
export function isDiscoveryActive(s: MigrationDiscoveryStatus): boolean {
  return s === 'running';
}

/** Applies a patch to URL search params (null removes the key). */
export function patchSearchParams(prev: URLSearchParams, patch: Record<string, string | null>): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '') next.delete(k);
    else next.set(k, v);
  }
  return next;
}

export interface TargetLink { kind: string; id: number; to: string }

const LINK_KEYS: Array<{ keys: string[]; kind: string; path: (id: number) => string }> = [
  { keys: ['accountId', 'accountIds'], kind: 'account', path: (id) => `/accounts/${id}` },
  { keys: ['siteId', 'siteIds'], kind: 'site', path: (id) => `/sites/${id}` },
  { keys: ['instanceId', 'dbInstanceId', 'instanceIds'], kind: 'dbInstance', path: (id) => `/databases/${id}` },
  { keys: ['mailDomainId', 'mailDomainIds'], kind: 'mailDomain', path: (id) => `/mail/domains/${id}` },
  { keys: ['mailboxId', 'mailboxIds'], kind: 'mailbox', path: (id) => `/mail/mailboxes/${id}` },
  { keys: ['zoneId', 'zoneIds', 'dnsZoneId'], kind: 'zone', path: (id) => `/dns/zones/${id}` },
  { keys: ['proxyHostId', 'proxyHostIds'], kind: 'proxyHost', path: (id) => `/proxy/hosts/${id}` },
];

function ids(v: unknown): number[] {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return [v];
  if (Array.isArray(v)) return v.filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0);
  return [];
}

/** Links to the target objects named in a step result ({ siteId, domainIds… }). */
export function targetLinks(result: Record<string, unknown> | null | undefined): TargetLink[] {
  if (!result) return [];
  const out: TargetLink[] = [];
  for (const def of LINK_KEYS) {
    for (const k of def.keys) {
      for (const id of ids(result[k])) {
        if (!out.some((l) => l.kind === def.kind && l.id === id)) out.push({ kind: def.kind, id, to: def.path(id) });
      }
    }
  }
  return out;
}

/** Scalar entries of a step result that are not links (counts, names…), for a compact summary. */
export function resultSummary(result: Record<string, unknown> | null | undefined): Array<[string, string]> {
  if (!result) return [];
  const linkKeys = new Set(LINK_KEYS.flatMap((d) => d.keys));
  return Object.keys(result).filter((k) => !linkKeys.has(k)).flatMap((k): Array<[string, string]> => {
    const v = result[k];
    if (v == null) return [];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return [[k, String(v)]];
    if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) return [[k, v.join(', ')]];
    return [];
  }).slice(0, 12);
}

/** Text search over a few fields (case-insensitive). */
export function matches(q: string, ...fields: Array<string | null | undefined>): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return fields.some((f) => (f ?? '').toLowerCase().includes(s));
}

/** Debounce helper usable outside React state (returns a function + cancel). */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): { call: (...args: A) => void; flush: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | null = null;
  return {
    call: (...args: A) => {
      pending = args;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { const a = pending; pending = null; timer = undefined; if (a) fn(...a); }, ms);
    },
    flush: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      const a = pending;
      pending = null;
      if (a) fn(...a);
    },
    cancel: () => { if (timer) clearTimeout(timer); timer = undefined; pending = null; },
  };
}

/**
 * Warnings / follow-ups of a dry-run. By default only what concerns the SELECTED accounts: plan-level items with no
 * account, or an account that is selected (an unselected account is not executed, its warnings are noise).
 * `all` = every account of the discovery.
 */
export function planWarnings(r: MigrationPlanResult, all = false): { warnings: MigrationWarning[]; followUps: MigrationFollowUp[] } {
  const accounts = all ? r.accounts : r.accounts.filter((a) => a.selected);
  const keep = new Set(accounts.map((a) => a.cwpUsername));
  // Without an account, only the server-wide messages stay: an object of no account (an orphan zone, a domain or
  // a database left by a deleted user…) is not migrated with the selected accounts.
  const ofSelected = (s: { kind?: string; account?: string | null }) => all
    || (s.account ? keep.has(s.account) : s.kind === 'server' || s.kind === 'package');
  return {
    warnings: [...r.warnings.filter((w) => ofSelected(w.scope)), ...accounts.flatMap((a) => a.warnings)],
    followUps: [...r.followUps.filter((f) => ofSelected(f.scope)), ...accounts.flatMap((a) => a.followUps)],
  };
}
