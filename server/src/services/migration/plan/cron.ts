import type { CwpCronEntry, DataPathTemplate, MigrationSeverity } from '@oblimint/shared';
import { normalizePhpVersion } from './php';
import { pathWithin, trimSlash } from './util';

// ─────────────────────────────────────────────────────────────────────────────
// D-CRON (docs/P5-PLAN.md §4): a user crontab line of CWP → a cron of the
// site container. Pure rewriting:
//   - PHP CLI binaries (/usr/local/bin/php, /opt/alt/phpXX/usr/bin/php…) → `php`
//     of the site image (cronPhpVersion when the version differs);
//   - <sourceRoot>/… → /srv/releases/current/… ; inside a data path → /srv/data/…;
//   - a redirection into the code (or anywhere else in the CWP home) → /dev/null
//     (cronWritesToCode: the release is read-only);
//   - @hourly / @daily… expanded to 5 fields, @reboot refused (cronSpecial).
// ─────────────────────────────────────────────────────────────────────────────

export const RELEASE_ROOT = '/srv/releases/current';
export const DATA_ROOT = '/srv/data';

export interface CronSiteView {
  sourceRoot: string;
  dataPaths: DataPathTemplate[];
  /** PHP version of the site base ('8.3'), null for static. */
  php: string | null;
  /** Home of the CWP account (redirections into it are dropped). */
  homeDir?: string | null;
}

export interface CronMessage {
  severity: MigrationSeverity;
  code: string;
  params: Record<string, string | number | boolean | null>;
}

export interface RewrittenCron {
  command: string;
  messages: CronMessage[];
}

const PHP_BINARY_RE = /(^|[\s;&|(`])(\/usr\/local\/bin\/php(?:-cli)?|\/usr\/bin\/php(?:\d+)?(?:-cli)?|\/opt\/alt\/php\d+\/usr\/bin\/php(?:-cgi)?|\/opt\/alt\/php-fpm\d+\/usr\/bin\/php|\/usr\/local\/cwp\/php\d+\/bin\/php)(?=$|[\s;&|)`])/g;
const PATH_TOKEN_RE = /(^|[\s'"=<>])(\/[^\s'";|&()<>`]+)/g;
const REDIRECT_RE = /(^|[^<>&\d])(\d?>>?|&>>?)(\s*)([^\s;|&()<>`]+)/g;

const SPECIALS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

/** 5-field schedule (null = @reboot / unreadable). */
export function normalizeSchedule(schedule: string): string | null {
  const s = schedule.trim().replace(/\s+/g, ' ');
  if (s.startsWith('@')) return SPECIALS[s.toLowerCase()] ?? null;
  return s.split(' ').length === 5 ? s : null;
}

function fieldValues(field: string, max: number): number[] | 'every' | null {
  if (field === '*') return 'every';
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    let lo = 0;
    let hi = max - 1;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      lo = a;
      hi = b === undefined ? (m[2] ? max - 1 : a) : b;
    }
    const step = m[2] ? Math.max(1, Number(m[2])) : 1;
    for (let v = lo; v <= hi && v < max; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

function minGap(values: number[], period: number): number {
  if (values.length <= 1) return period;
  let gap = period;
  for (let i = 1; i < values.length; i++) gap = Math.min(gap, values[i] - values[i - 1]);
  return Math.min(gap, period - values[values.length - 1] + values[0]);
}

/** Shortest interval (minutes) between two runs of a 5-field schedule (approximation by minute / hour fields). */
export function minIntervalMinutes(schedule: string): number {
  const f = schedule.trim().split(/\s+/);
  if (f.length !== 5) return 1440;
  const minutes = fieldValues(f[0], 60);
  const hours = fieldValues(f[1], 24);
  if (minutes === null || hours === null) return 1;
  const everyHour = hours === 'every' || hours.length === 24;
  if (minutes === 'every') return 1;
  if (minutes.length > 1) {
    const g = minGap(minutes, 60);
    return everyHour ? g : Math.min(g, 60);
  }
  if (everyHour) return 60;
  return minGap(hours, 24) * 60;
}

/** Absolute paths named in a command (outside URLs). */
export function commandPaths(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(PATH_TOKEN_RE)) out.push(m[2]);
  return out;
}

/**
 * Absolute paths a command USES (scripts, arguments, cd targets…): commandPaths minus the targets of output
 * redirections (`>> /home/u/public_html/logs/cron.log`) — a log file says nothing about which site the job
 * belongs to (D-CRON site selection) and is rewritten to /dev/null or a data path anyway.
 */
export function usedPaths(command: string): string[] {
  return commandPaths(command.replace(REDIRECT_RE, (_all, pre: string, op: string, sp: string) => `${pre}${op}${sp}redirect-target`));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dataPathOf(rel: string, site: CronSiteView): DataPathTemplate | null {
  return site.dataPaths.find((d) => rel === d.path || rel.startsWith(`${d.path}/`)) ?? null;
}

/** Path on the source → path in the site container (null = outside the source root). */
function mapPath(path: string, site: CronSiteView): string | null {
  const root = trimSlash(site.sourceRoot);
  if (!pathWithin(path, root)) return null;
  const rel = trimSlash(path).slice(root.length).replace(/^\/+/, '');
  if (rel === '') return RELEASE_ROOT + (path.endsWith('/') ? '/' : '');
  const suffix = path.endsWith('/') ? '/' : '';
  return dataPathOf(rel, site) ? `${DATA_ROOT}/${rel}${suffix}` : `${RELEASE_ROOT}/${rel}${suffix}`;
}

export function rewriteCronCommand(entry: Pick<CwpCronEntry, 'command' | 'phpBinary' | 'phpVersion'>, site: CronSiteView): RewrittenCron {
  const messages: CronMessage[] = [];
  let cmd = entry.command;

  // 1. PHP CLI binaries → `php` of the image.
  let php = false;
  cmd = cmd.replace(PHP_BINARY_RE, (_all, pre: string) => { php = true; return `${pre}php`; });
  if (entry.phpBinary && entry.phpBinary.startsWith('/') && cmd.includes(entry.phpBinary)) {
    cmd = cmd.replace(new RegExp(`(^|[\\s;&|(\`])${escapeRe(entry.phpBinary)}(?=$|[\\s;&|)\`])`, 'g'), (_a, pre: string) => `${pre}php`);
    php = true;
  }
  const from = normalizePhpVersion(entry.phpVersion);
  if ((php || from) && from && site.php && from !== site.php) {
    messages.push({ severity: 'info', code: 'cronPhpVersion', params: { from, to: site.php } });
  }

  // 2. Redirections into the (read-only) code or the old home → /dev/null.
  cmd = cmd.replace(REDIRECT_RE, (all, pre: string, op: string, sp: string, target: string) => {
    const t = target.replace(/^['"]|['"]$/g, '');
    if (!t.startsWith('/') || t === '/dev/null' || t.startsWith('/dev/') || t.startsWith('/tmp/')) return all;
    const root = trimSlash(site.sourceRoot);
    if (pathWithin(t, root)) {
      const rel = trimSlash(t).slice(root.length).replace(/^\/+/, '');
      if (rel && dataPathOf(rel, site)) return all; // data path: rewritten below, writable
    } else if (!site.homeDir || !pathWithin(t, site.homeDir)) {
      if (!t.startsWith('/home/')) return all;
    }
    messages.push({ severity: 'warning', code: 'cronWritesToCode', params: { path: t } });
    return `${pre}${op}${sp}/dev/null`;
  });

  // 3. Paths of the source root → release / data paths.
  const root = trimSlash(site.sourceRoot);
  if (root !== '/') {
    const re = new RegExp(`(^|[\\s'"=<>])(${escapeRe(root)}(?:/[^\\s'";|&()<>\`]*)?)(?=$|[\\s'";|&()<>\`])`, 'g');
    cmd = cmd.replace(re, (all, pre: string, p: string) => {
      const mapped = mapPath(p, site);
      return mapped ? `${pre}${mapped}` : all;
    });
  }
  return { command: cmd, messages };
}

/** Interpreters whose next argument is code to execute. */
const INTERPRETER_RE = /^(?:php(?:\d+(?:\.\d+)?)?(?:-cli)?|sh|bash|dash|ksh|zsh|perl\d*|python\d*(?:\.\d+)?|ruby|node|nodejs|source|\.)$/;
const SCRIPT_EXT_RE = /\.(?:php\d?|phtml|phar|sh|bash|py|pl|cgi|rb|js)$/i;

/**
 * D-CRON + ARCHITECTURE §1 (data paths are writable, NEVER executable): the path of code a final cron command
 * would execute from a data path (/srv/data/…), else null. A job running code from a PHP-writable place is a
 * persistent backdoor waiting for any web-level write primitive: the planner creates it DISABLED and warns.
 * Executed = an argument of an interpreter, a script file (by extension) or the first word of a command.
 */
export function executesFromData(command: string): string | null {
  const segments = command.split(/&&|\|\||[;|&\n`()]/);
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^['"]+|['"]+$/g, ''));
    let afterRedirect = false;
    let interpreter = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (/^\d?>>?$|^&>>?$|^<$/.test(t)) { afterRedirect = true; continue; }
      const inline = /^\d?>>?|^&>>?|^</.exec(t);
      const word = inline ? t.slice(inline[0].length) : t;
      const isTarget = afterRedirect || !!inline;
      afterRedirect = false;
      if (!isTarget && (word === DATA_ROOT || word.startsWith(`${DATA_ROOT}/`))) {
        if (i === 0 || interpreter || SCRIPT_EXT_RE.test(word)) return word;
      }
      const base = word.split('/').pop() ?? '';
      if (!isTarget && INTERPRETER_RE.test(base)) interpreter = true;
      else if (!word.startsWith('-')) interpreter = false;
    }
  }
  return null;
}
