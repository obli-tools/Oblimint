import type {
  AppDeploymentStatus, ClientCapability, HostingMe, AppMaintenanceSchedule, AppStackStatus, AppTemplateField, ContainerState, UptimeStatus,
} from '@oblimint/shared';

// Pure helpers of the ui-apps screens (no React, no i18n instance): name rules
// mirrored from the server, tones, sizes, durations, generated secrets, dotenv,
// maintenance schedule maths. OWNED BY MODULE `ui-apps`.

export type Tone = 'muted' | 'green' | 'amber' | 'red' | 'accent' | 'blue';

/** Stack slug (server CHECK): [a-z0-9][a-z0-9-]{0,30}. */
export const STACK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** Status page slug: [a-z0-9][a-z0-9-]{2,62}. */
export const STATUS_SLUG_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;

/** Registry host (docker.io, ghcr.io, registry.example.com:5000). */
export const REGISTRY_RE = /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$/;

/** A free text turned into a valid stack slug ('' when nothing usable is left). */
export function slugify(text: string, max = 31): string {
  const s = text
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return s;
}

export function stackStatusTone(s: AppStackStatus): Tone {
  switch (s) {
    case 'running': return 'green';
    case 'partial': return 'amber';
    case 'deploying': return 'blue';
    case 'sleeping': return 'accent';
    case 'error': return 'red';
    default: return 'muted';
  }
}

export function deploymentStatusTone(s: AppDeploymentStatus): Tone {
  switch (s) {
    case 'succeeded': return 'green';
    case 'failed': return 'red';
    case 'running': return 'blue';
    case 'queued': return 'amber';
    default: return 'muted';
  }
}

export function containerStateTone(s: ContainerState): Tone {
  switch (s) {
    case 'running': return 'green';
    case 'restarting': return 'amber';
    case 'error': return 'red';
    case 'missing': return 'red';
    default: return 'muted';
  }
}

export function uptimeStatusTone(s: UptimeStatus): Tone {
  switch (s) {
    case 'up': return 'green';
    case 'down': return 'red';
    case 'pending': return 'amber';
    default: return 'muted';
  }
}

/** Colour of an uptime ratio (0…1) — bars, percentages. */
export function uptimeColor(ratio: number | null): string {
  if (ratio == null) return 'rgb(var(--c-text-muted) / 0.25)';
  if (ratio >= 0.999) return '#1edd8a';
  if (ratio >= 0.98) return '#f5b544';
  return '#ef4444';
}

/** "99.95 %" (2 decimals under 100). */
export function formatPct(ratio: number | null | undefined, decimals = 2): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  const v = ratio * 100;
  return `${v >= 100 ? '100' : v.toFixed(decimals)} %`;
}

export interface ByteUnits { b: string; kb: string; mb: string; gb: string; tb: string }

export function formatBytes(bytes: number | null | undefined, u: ByteUnits): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const abs = Math.abs(bytes);
  const steps: Array<[number, string]> = [[1024 ** 4, u.tb], [1024 ** 3, u.gb], [1024 ** 2, u.mb], [1024, u.kb]];
  for (const [size, label] of steps) {
    if (abs >= size) {
      const v = bytes / size;
      return `${trimNum(v, Math.abs(v) >= 100 ? 0 : 1)} ${label}`;
    }
  }
  return `${Math.round(bytes)} ${u.b}`;
}

export function trimNum(n: number, decimals = 2): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(decimals).replace(/\.?0+$/, '');
}

/** "850 ms" / "1.2 s". */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${trimNum(ms / 1000, 1)} s`;
}

/** Duration between two ISO dates ("42 s", "3 min 05 s"), '—' when unknown. */
export function formatSpan(from: string | null | undefined, to: string | null | undefined): string {
  if (!from || !to) return '—';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${trimNum(ms / 1000, 1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} min ${String(s).padStart(2, '0')} s`;
}

/** sha256:0123…cdef → 0123456789ab (first 12 hex). */
export function shortDigest(d: string | null | undefined): string {
  if (!d) return '—';
  const hex = d.includes(':') ? d.slice(d.indexOf(':') + 1) : d;
  return hex.slice(0, 12);
}

/** Commit SHA → 7 chars. */
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '—';
}

/** Names of the variables of a dotenv text (KEY=value lines, comments and blanks skipped). */
export function dotenvKeys(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Lines of a dotenv text that are neither blank, a comment nor KEY=value (1-based). */
export function dotenvBadLines(text: string): number[] {
  const bad: number[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (!/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=/.test(line)) bad.push(i + 1);
  });
  return bad;
}

function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

/** Value generated in the browser for a template field (the server also generates empty ones). */
export function generateFieldValue(kind: NonNullable<AppTemplateField['generate']>): string {
  switch (kind) {
    case 'hex32': return [...randomBytes(32)].map((b) => b.toString(16).padStart(2, '0')).join('');
    case 'base64-32': return btoa(String.fromCharCode(...randomBytes(32)));
    case 'uuid': return crypto.randomUUID();
    case 'password':
    default: {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
      return [...randomBytes(24)].map((b) => alphabet[b % alphabet.length]).join('');
    }
  }
}

/** Default value of a template field as a form string. */
export function fieldDefault(f: AppTemplateField): string | boolean {
  if (f.type === 'boolean') return f.default === true || f.default === 'true';
  if (f.default == null) return f.type === 'select' && f.options?.length ? f.options[0] : '';
  return String(f.default);
}

/** Form value → API value of a template field (numbers / booleans typed). */
export function fieldValueOut(f: AppTemplateField, v: string | boolean): string | number | boolean {
  if (f.type === 'boolean') return v === true;
  if (f.type === 'number') {
    const n = Number(String(v).trim().replace(',', '.'));
    return Number.isFinite(n) ? n : String(v);
  }
  return String(v);
}

/** Problem of one template field value (null = ok). */
export function fieldIssue(f: AppTemplateField, v: string | boolean): 'required' | 'number' | 'pattern' | 'email' | 'url' | 'domain' | null {
  if (f.type === 'boolean') return null;
  const s = String(v).trim();
  if (!s) return f.required && !(f.secret && f.generate) ? 'required' : null;
  if (f.type === 'number' && !Number.isFinite(Number(s.replace(',', '.')))) return 'number';
  if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'email';
  if (f.type === 'url' && !/^https?:\/\/\S+$/i.test(s)) return 'url';
  if (f.type === 'domain' && !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(s)) return 'domain';
  if (f.pattern) {
    try {
      if (!new RegExp(`^(?:${f.pattern})$`).test(s)) return 'pattern';
    } catch {
      return null;
    }
  }
  return null;
}

// ── Maintenance windows ─────────────────────────────────────────────────────

/** "HH:MM" valid 00:00–23:59. */
export function isHhMm(v: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

/** End time "HH:MM" (+ days overflow) of a window. */
export function windowEnd(s: Pick<AppMaintenanceSchedule, 'start' | 'durationMinutes'>): { end: string; nextDay: boolean } {
  if (!isHhMm(s.start)) return { end: '—', nextDay: false };
  const [h, m] = s.start.split(':').map(Number);
  const total = h * 60 + m + Math.max(0, s.durationMinutes);
  const d = Math.floor(total / 1440);
  const mm = total % 1440;
  return { end: `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`, nextDay: d > 0 };
}

/** Days 0 (Sunday) … 6 shown Monday first. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** Short localized weekday name (0 = Sunday). */
export function weekdayShort(day: number, lang: string): string {
  // 2023-01-01 was a Sunday.
  const d = new Date(Date.UTC(2023, 0, 1 + day, 12));
  return new Intl.DateTimeFormat(lang, { weekday: 'short', timeZone: 'UTC' }).format(d);
}

/** Localized date + time of an ISO string, '—' when absent. */
export function formatDateTime(iso: string | null | undefined, lang: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(lang);
}

/** Compact relative time ("3 min", "2 h", "5 d") between now and an ISO date. */
export function ago(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

// ── Query params ────────────────────────────────────────────────────────────

/** Copy of `prev` with `patch` applied (null deletes the key): functional setSearchParams updater. */
export function patchParams(prev: URLSearchParams, patch: Record<string, string | null>): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) next.delete(k); else next.set(k, v);
  }
  return next;
}

/** Byte unit labels (apps.units.*: the shared units only have MB / GB). */
export function byteUnits(t: (k: string) => string): ByteUnits {
  return {
    b: t('apps.units.b') || 'B', kb: t('apps.units.kb') || 'KB', mb: t('units.mb') || 'MB', gb: t('units.gb') || 'GB', tb: t('apps.units.tb') || 'TB',
  };
}

// ── Public status page ──────────────────────────────────────────────────────

/** Defence in depth: the server already sanitises the CSS (no @import / url() / expression, ≤ 16 KiB). */
export function safeCss(css: string | null): string {
  if (!css) return '';
  return css
    .slice(0, 16 * 1024)
    .replace(/<\/?style/gi, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\s*\([^)]*\)/gi, 'none')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/javascript:/gi, '');
}

// ── Access (mirrors server/src/services/hosting/access.ts) ──────────────────

export type P4bNeed = 'read' | 'apps.manage' | 'apps.console' | 'proxy.manage' | 'monitoring.manage';

const STAFF_READ = [
  'overview.read', 'accounts.manage', 'sites.manage', 'domains.manage', 'files.manage', 'plans.manage', 'databases.manage', 'dns.manage', 'mail.manage',
  'apps.manage', 'proxy.manage', 'monitoring.manage',
];

/**
 * Pure check. `accountId` undefined = "on some account"; null = a platform
 * object (no account): staff only.
 */
export function p4bCan(me: HostingMe | null, need: P4bNeed, accountId?: number | null): boolean {
  if (!me) return false;
  if (me.kind === 'staff') {
    if (me.staffCapabilities === '*') return true;
    const caps = me.staffCapabilities;
    return need === 'read' ? STAFF_READ.some((c) => caps.includes(c)) : caps.includes(need);
  }
  if (accountId === null) return false;
  const entries = accountId !== undefined ? [me.accounts[accountId]].filter(Boolean) : Object.values(me.accounts);
  return entries.some((caps) => need === 'read' || (caps as ClientCapability[]).includes(need as ClientCapability));
}
