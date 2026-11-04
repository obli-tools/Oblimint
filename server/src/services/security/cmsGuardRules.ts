import type { CmsKind } from '@oblimint/shared';
import { banKey } from '../firewall/addresses';
import { ipMatcher } from './keySurfaceRules';

// ─────────────────────────────────────────────────────────────────────────────
// PURE rules of the CMS login guard (cmsGuard.service.ts applies them) —
// cmsGuardRules.test.ts. Import-light on purpose (no database, no service).
//
// The edge logs the method, the $request_uri and the status of every request
// of a site, never the body: a login outcome is read from the status only.
//   failure  the login form answered again (200): WordPress wp-login.php,
//            Drupal /user/login, phpMyAdmin;
//   success  the login redirected (302 / 303): clears the address' count on
//            that site (a typo streak followed by the right password);
//   attempt  the outcome cannot be told from the status (XML-RPC answers 200
//            with a fault in the body, Joomla and PrestaShop redirect / answer
//            the same way on success and failure): every POST counts. A human
//            logs in once; 10 posts in 5 minutes is a script.
// Only POST requests count; a status outside 2xx / 3xx (403, 404, 429,
// 444, 5xx) is not a login outcome (blocked, missing, broken) and is ignored.
// Paths are matched case-insensitively after percent-decoding and with
// repeated slashes collapsed, under any prefix (a site in /blog/, a language
// prefix /fr/user/login). Queries narrow the rules to the login form only
// (WordPress' lost-password form, Drupal's REST login, the logged-in admin
// pages of Joomla / phpMyAdmin are left out).
// ─────────────────────────────────────────────────────────────────────────────

export type CmsOutcome = 'failure' | 'success' | 'attempt';

export interface CmsMatch {
  cms: CmsKind;
  outcome: CmsOutcome;
}

export interface CmsLogLine {
  method: string;
  uri: string;
  status: number;
}

interface CmsRule {
  cms: CmsKind;
  /** Matched against the normalised, lowercased path. */
  path: RegExp;
  /** Narrows on the query (absent = any query). */
  query?: (q: URLSearchParams) => boolean;
  /** Outcome of a status (2xx / 3xx only reach it); null = not a login outcome. */
  outcome: (status: number) => CmsOutcome | null;
}

const PREFIX = '^(?:/[^/]+)*';
const formOutcome = (status: number): CmsOutcome | null => {
  if (status === 200) return 'failure';
  if (status === 302 || status === 303) return 'success';
  return null;
};
const attemptOutcome = (status: number): CmsOutcome | null => (status >= 200 && status < 400 ? 'attempt' : null);

/** Query keys of q, lowercased. */
const keys = (q: URLSearchParams): string[] => [...new Set([...q.keys()].map((k) => k.toLowerCase()))];
const value = (q: URLSearchParams, name: string): string | null => {
  for (const [k, v] of q) if (k.toLowerCase() === name) return v;
  return null;
};

/**
 * The declarative table of the login URLs. Order matters only for paths that
 * two rules could match (none today).
 */
export const CMS_RULES: readonly CmsRule[] = [
  {
    // WordPress: the login form posts to wp-login.php (?action=login or none);
    // 200 = the form again (bad password), 302 = logged in. Lost password,
    // registration, post password… are other actions.
    cms: 'wordpress',
    path: new RegExp(`${PREFIX}/wp-login\\.php$`),
    query: (q) => { const a = value(q, 'action'); return a === null || a === '' || a.toLowerCase() === 'login'; },
    outcome: formOutcome,
  },
  {
    // WordPress XML-RPC: always 200 (a fault in the body), one POST may carry a
    // system.multicall of hundreds of passwords. Jetpack's servers are exempt (CMS_GUARD_EXEMPT).
    cms: 'wordpress-xmlrpc',
    path: new RegExp(`${PREFIX}/xmlrpc\\.php$`),
    outcome: (status) => (status === 200 ? 'attempt' : null),
  },
  {
    // Joomla administrator: the login form posts to /administrator/index.php
    // without query (or option=com_login); the logged-in admin forms carry
    // their option / task in the query and are left out. 303 both ways.
    cms: 'joomla',
    path: new RegExp(`${PREFIX}/administrator/(?:index\\.php)?$`),
    query: (q) => {
      const k = keys(q);
      if (k.length === 0) return true;
      const option = value(q, 'option')?.toLowerCase();
      const task = value(q, 'task')?.toLowerCase() ?? '';
      return option === 'com_login' && !task.includes('logout');
    },
    outcome: attemptOutcome,
  },
  {
    // Drupal 8+: /user/login (any prefix: language, sub-site), 200 = the form
    // again, 302 / 303 = logged in. The REST login (?_format=json) answers
    // 400 / 403 on failure and 200 on success: left out.
    cms: 'drupal',
    path: new RegExp(`${PREFIX}/user/login$`),
    query: (q) => value(q, '_format') === null,
    outcome: formOutcome,
  },
  {
    // Drupal 7 without clean URLs: /?q=user/login or /index.php?q=user/login.
    cms: 'drupal',
    path: /^(?:\/[^/]+)*\/(?:index\.php)?$/,
    query: (q) => /^(?:[a-z]{2}(?:-[a-z]{2})?\/)?user(?:\/login)?$/i.test(value(q, 'q') ?? '') && value(q, '_format') === null,
    outcome: formOutcome,
  },
  {
    // PrestaShop 1.7 / 8: the back office lives in a renamed admin folder
    // (admin + random suffix); its login form posts by AJAX to
    // index.php?rand=<ms> (or index.php?controller=AdminLogin). 200 both ways.
    cms: 'prestashop',
    path: new RegExp(`${PREFIX}/admin[a-z0-9_-]*/index\\.php$`),
    query: (q) => {
      const controller = value(q, 'controller');
      if (controller !== null) return controller.toLowerCase() === 'adminlogin';
      const k = keys(q);
      return k.length === 1 && k[0] === 'rand' && /^\d{1,16}$/.test(value(q, 'rand') ?? '');
    },
    outcome: attemptOutcome,
  },
  {
    // PrestaShop 9 (Symfony back office): <admin folder>/login, 302 both ways.
    cms: 'prestashop',
    path: new RegExp(`${PREFIX}/admin[a-z0-9_-]*/(?:index\\.php/)?login$`),
    outcome: attemptOutcome,
  },
  {
    // phpMyAdmin hosted in a site (a folder phpmyadmin*, pma*): the login
    // form posts to index.php (?route=/ since 5.x), 200 = the form again,
    // 302 = logged in. Logged-in requests carry another route / script.
    cms: 'phpmyadmin',
    path: new RegExp(`${PREFIX}/(?:phpmyadmin|pma)[a-z0-9._-]*/(?:index\\.php)?$`),
    query: (q) => {
      const k = keys(q).filter((x) => x !== 'lang');
      if (k.length === 0) return true;
      return k.length === 1 && k[0] === 'route' && value(q, 'route') === '/';
    },
    outcome: formOutcome,
  },
];

/**
 * Addresses never counted for a CMS (published, documented ranges of
 * services that call the login surfaces on behalf of the site owner):
 * Automattic / Jetpack (192.0.64.0/18) for XML-RPC.
 */
export const CMS_GUARD_EXEMPT: Readonly<Partial<Record<CmsKind, readonly string[]>>> = {
  'wordpress-xmlrpc': ['192.0.64.0/18'],
};
const exemptMatchers = new Map<CmsKind, (ip: string) => boolean>(
  Object.entries(CMS_GUARD_EXEMPT).map(([k, v]) => [k as CmsKind, ipMatcher(v ?? [])]),
);

/** Normalised path of a $request_uri: no query, percent-decoded, repeated slashes collapsed, lowercased. null = garbage. */
export function normalisePath(uri: string): string | null {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 4096) return null;
  let path = uri.split('?')[0].split('#')[0];
  if (!path.startsWith('/')) {
    // An absolute-form request line (http://host/path).
    const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(path);
    if (!m) return null;
    path = m[1] ?? '/';
  }
  try { path = decodeURIComponent(path); } catch { /* malformed escapes: kept as is */ }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(path)) return null;
  return path.replace(/\/{2,}/g, '/').toLowerCase();
}

function queryOf(uri: string): URLSearchParams {
  const i = uri.indexOf('?');
  if (i < 0) return new URLSearchParams();
  try { return new URLSearchParams(uri.slice(i + 1).split('#')[0]); } catch { return new URLSearchParams(); }
}

/** What a log line means for the guard (null = not a CMS login). */
export function classifyCmsLogin(line: CmsLogLine): CmsMatch | null {
  if (!line || String(line.method).toUpperCase() !== 'POST') return null;
  const status = Number(line.status);
  if (!Number.isInteger(status) || status < 200 || status >= 400) return null;
  const path = normalisePath(line.uri);
  if (!path) return null;
  for (const rule of CMS_RULES) {
    if (!rule.path.test(path)) continue;
    if (rule.query && !rule.query(queryOf(line.uri))) continue;
    const outcome = rule.outcome(status);
    if (outcome) return { cms: rule.cms, outcome };
  }
  return null;
}

/** The address is exempt for this CMS (CMS_GUARD_EXEMPT). */
export function cmsExempt(cms: CmsKind, ip: string): boolean {
  return exemptMatchers.get(cms)?.(ip) ?? false;
}

// ── sliding window ───────────────────────────────────────────────────────────

/** Most distinct (site, address) pairs tracked; the stalest half is dropped past it. */
export const CMS_MAX_TRACKED = 50_000;

/**
 * Counts the failures of (site, ban key) in a sliding window. Bounded: at
 * most `limit` timestamps per key (enough to cross any threshold), at most
 * CMS_MAX_TRACKED keys (oldest activity evicted first).
 */
export class CmsFailureWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly maxTracked = CMS_MAX_TRACKED) {}

  /** Records one failure at `now`; returns the failures within the window (this one included). */
  record(key: string, now: number, windowMs: number, limit: number): number {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    list.push(now);
    while (list.length > Math.max(1, limit)) list.shift();
    // Re-inserted: the Map keeps the most recently active keys last.
    this.hits.delete(key);
    if (this.hits.size >= this.maxTracked) this.evict();
    this.hits.set(key, list);
    return list.length;
  }

  count(key: string, now: number, windowMs: number): number {
    return (this.hits.get(key) ?? []).filter((t) => now - t < windowMs).length;
  }

  clear(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }

  /** Forgets the keys whose last failure is older than maxAgeMs. */
  sweep(now: number, maxAgeMs: number): void {
    for (const [k, list] of this.hits) if (!list.length || now - list[list.length - 1] >= maxAgeMs) this.hits.delete(k);
  }

  get size(): number {
    return this.hits.size;
  }

  private evict(): void {
    let n = Math.ceil(this.hits.size / 2);
    for (const k of this.hits.keys()) {
      if (n-- <= 0) break;
      this.hits.delete(k);
    }
  }
}

export interface CmsThresholds {
  maxFailures: number;
  windowMinutes: number;
}

export type CmsObservation =
  | { kind: 'ignored' }
  | { kind: 'cleared'; key: string; cms: CmsKind }
  | { kind: 'counted'; key: string; cms: CmsKind; count: number }
  /** The threshold is reached: the counter restarts (the next burst counts again). */
  | { kind: 'threshold'; key: string; cms: CmsKind; count: number };

/** Key of the window: one site, one ban key (IPv4 address or IPv6 /64). */
export function cmsWindowKey(siteId: number, ip: string): string | null {
  const k = banKey(ip);
  return k ? `${siteId}|${k}` : null;
}

/** One log line of a site through the window (pure apart from the window itself). */
export function observeCmsLine(
  win: CmsFailureWindow,
  line: CmsLogLine & { siteId: number; remoteAddr: string },
  now: number,
  th: CmsThresholds,
): CmsObservation {
  const match = classifyCmsLogin(line);
  if (!match) return { kind: 'ignored' };
  if (cmsExempt(match.cms, line.remoteAddr)) return { kind: 'ignored' };
  const key = cmsWindowKey(line.siteId, line.remoteAddr);
  if (!key) return { kind: 'ignored' };
  if (match.outcome === 'success') {
    win.clear(key);
    return { kind: 'cleared', key, cms: match.cms };
  }
  const count = win.record(key, now, th.windowMinutes * 60_000, th.maxFailures);
  if (count >= th.maxFailures) {
    win.clear(key);
    return { kind: 'threshold', key, cms: match.cms, count };
  }
  return { kind: 'counted', key, cms: match.cms, count };
}

/** The ban key part of a window key. */
export function banKeyOfWindowKey(key: string): string {
  return key.slice(key.indexOf('|') + 1);
}
