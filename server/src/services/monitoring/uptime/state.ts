import type { PublicStatusPage, UptimeStatus } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Uptime — pure rules (docs/P4b-PLAN.md §10.2 / §10.3): state transitions of
// a monitor, custom CSS of a status page, public projection of a status page
// (invariant MO2: names + statuses + uptime only — never a URL, a host, an
// error text, an id or an account).
// ─────────────────────────────────────────────────────────────────────────────

export interface MonitorState {
  status: UptimeStatus;
  consecutiveFailures: number;
}

export interface Transition extends MonitorState {
  /** 'down' when the monitor just went down (notify uptime.down), 'up' when it recovered from down (uptime.up). */
  event: 'down' | 'up' | null;
}

/**
 * Next state after one check. `retries` = consecutive failures before
 * 'down' (at least 1). Recovery is notified only from 'down' (a pending
 * monitor that comes up is not an event); 'down' is notified once per outage.
 */
export function nextState(prev: MonitorState, ok: boolean, retries: number): Transition {
  if (ok) return { status: 'up', consecutiveFailures: 0, event: prev.status === 'down' ? 'up' : null };
  const failures = prev.consecutiveFailures + 1;
  const threshold = Math.max(1, Math.floor(retries) || 0);
  if (failures >= threshold) return { status: 'down', consecutiveFailures: failures, event: prev.status === 'down' ? null : 'down' };
  // Not down yet: keep the previous verdict (an 'up' monitor stays 'up' through the retries).
  return { status: prev.status === 'paused' ? 'pending' : prev.status, consecutiveFailures: failures, event: null };
}

// ── Status page CSS (§10.3) ──────────────────────────────────────────────────

export const MAX_CSS_BYTES = 16 * 1024;

/**
 * Why a custom CSS is refused (null = acceptable). Refused rather than
 * silently rewritten: escapes (\75rl), comments splitting a keyword and
 * HTML breakouts are all closed by refusing backslashes and '<' outright.
 */
export function cssProblem(css: string): string | null {
  if (Buffer.byteLength(css, 'utf8') > MAX_CSS_BYTES) return `CSS larger than ${MAX_CSS_BYTES / 1024} KiB`;
  if (/[\\<]/.test(css)) return 'backslashes and "<" are not allowed in the CSS';
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '').toLowerCase().replace(/\s+/g, '');
  if (flat.includes('/*')) return 'unterminated comment';
  for (const banned of ['@import', 'url(', 'image-set(', 'expression(', 'expression', 'javascript:', 'behavior:', '-moz-binding', '@charset', '@namespace', '@font-face']) {
    if (flat.includes(banned)) return `"${banned}" is not allowed in the CSS`;
  }
  return null;
}

// ── Public projection ────────────────────────────────────────────────────────

export interface PublicMonitorInput {
  name: string;
  status: UptimeStatus;
  enabled: boolean;
  uptime24h: number | null;
  uptime30d: number | null;
  lastLatencyMs: number | null;
  /** Daily uptime ratios keyed by YYYY-MM-DD. */
  daily: ReadonlyMap<string, number>;
}

export function overallStatus(statuses: readonly UptimeStatus[]): PublicStatusPage['overall'] {
  const live = statuses.filter((s) => s === 'up' || s === 'down');
  if (live.length === 0) return 'unknown';
  const down = live.filter((s) => s === 'down').length;
  if (down === 0) return 'up';
  return down === live.length ? 'down' : 'degraded';
}

/** The last `days` UTC days ending at `now`, oldest first. */
export function lastDays(now: Date, days: number): string[] {
  const out: string[] = [];
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = days - 1; i >= 0; i--) out.push(new Date(base - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** Builds the public page (pure). Only the whitelisted fields are copied. */
export function projectStatusPage(
  page: { slug: string; title: string; description: string | null; customCss: string | null },
  monitors: readonly PublicMonitorInput[],
  now: Date,
): PublicStatusPage {
  const days = lastDays(now, 90);
  const items = monitors.map((m) => ({
    name: m.name,
    status: (m.enabled ? m.status : 'paused') as UptimeStatus,
    uptime24h: m.uptime24h,
    uptime30d: m.uptime30d,
    latencyMs: m.lastLatencyMs,
    history: days.map((day) => ({ day, uptime: m.daily.has(day) ? m.daily.get(day)! : null })),
  }));
  return {
    slug: page.slug,
    title: page.title,
    description: page.description,
    customCss: page.customCss,
    generatedAt: now.toISOString(),
    overall: overallStatus(items.map((i) => i.status)),
    monitors: items,
  };
}
