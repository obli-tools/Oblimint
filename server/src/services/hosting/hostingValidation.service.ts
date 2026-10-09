import { domainToASCII } from 'url';
import { isIP } from 'net';
import type { PhpSettings } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Pure validation rules of the hosting API (docs/P1-PLAN.md §3, §6, §14 H5).
// No database here: the zod schemas (validators/hosting.schema.ts) and the
// services build on these functions, and the tests exercise them directly.
// ─────────────────────────────────────────────────────────────────────────────

/** System / SFTP user name of a hosting account (same CHECK as the migration). */
export const ACCOUNT_USERNAME_RE = /^[a-z][a-z0-9-]{2,31}$/;

/** Names that would clash with system users, services or the panel itself. */
export const RESERVED_ACCOUNT_USERNAMES: ReadonlySet<string> = new Set([
  'root', 'admin', 'administrator', 'oblimint', 'www', 'www-data', 'mail', 'postmaster', 'ftp', 'sftp', 'ssh',
  'postgres', 'mysql', 'mariadb', 'nginx', 'apache', 'httpd', 'nobody', 'daemon', 'bin', 'sys', 'sync', 'games',
  'man', 'lp', 'news', 'uucp', 'proxy', 'backup', 'list', 'irc', 'gnats', 'systemd', 'node', 'git',
]);

export function isReservedAccountUsername(username: string): boolean {
  return RESERVED_ACCOUNT_USERNAMES.has(username.toLowerCase());
}

export function isValidAccountUsername(username: unknown): username is string {
  return typeof username === 'string' && ACCOUNT_USERNAME_RE.test(username) && !isReservedAccountUsername(username);
}

/** Client (panel) user name: same rule as the staff users, og_ reserved for Obligate. */
export const CLIENT_USERNAME_RE = /^[a-zA-Z0-9_.-]{3,64}$/;

export function isValidClientUsername(username: unknown): username is string {
  return typeof username === 'string' && CLIENT_USERNAME_RE.test(username) && !username.toLowerCase().startsWith('og_');
}

/** Site slug = SFTP folder name (same CHECK as the migration). */
export const SITE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Healthcheck path: absolute, printable ASCII, no space. */
export const HEALTHCHECK_PATH_RE = /^\/[\x21-\x7e]{0,254}$/;

/** Extension of a `typed` data path (lower-case, no dot). */
export const EXTENSION_RE = /^[a-z0-9]{1,10}$/;
export const MAX_TYPED_EXTENSIONS = 100;

/**
 * Extensions that can never be whitelisted in a `typed` data path (a PHP
 * handler could still pick them up). Same pattern as images/siteconf
 * config.go phpLikeExtRE: the image refuses the WHOLE config otherwise.
 */
export const PHP_LIKE_EXTENSION_RE = /^(php[0-9]?|phar|phtml|pht|phps)$/;

/**
 * Hard limits of the site container renderer (images/siteconf config.go:
 * maxDataPaths, maxPrefixes). Beyond them the image refuses the whole
 * SiteRuntimeConfig and the container restarts in a loop: the panel refuses first.
 */
export const MAX_DATA_PATHS_PER_SITE = 64;
export const MAX_SERVED_PREFIXES_PER_RUNTIME = 64;

/** Custom nginx rules of a site (only ever rendered inside the site container). */
export const CUSTOM_NGINX_MAX_BYTES = 16 * 1024;

// ── Domain names ─────────────────────────────────────────────────────────────

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Normalises a domain name: trimmed, lower-case, IDN → punycode, one
 * trailing dot tolerated (removed). Returns null when the result is not a
 * plain host name of ≥ 2 labels (no IP, no wildcard, labels 1..63
 * [a-z0-9-] not starting / ending with '-', ≤ 253 characters, TLD not
 * numeric).
 */
export function normalizeDomainName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (!s || s.length > 1024) return null;
  if (isIP(s) || s.startsWith('[')) return null;
  // Only host-name characters (and non-ASCII for IDN) may reach domainToASCII.
  if (/[\s/\\:@?#*%_]/.test(s)) return null;
  const ascii = domainToASCII(s);
  if (!ascii || ascii.length > 253) return null;
  if (isIP(ascii)) return null;
  const labels = ascii.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((l) => LABEL_RE.test(l))) return null;
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return null;
  return ascii;
}

/**
 * The panel host name and its preview zone belong to the platform: a tenant
 * can never claim them (the edge would route them away from the panel).
 */
export function isPlatformReservedDomain(name: string, panelHostname: string | null | undefined): boolean {
  const panel = (panelHostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!panel) return false;
  const preview = `preview.${panel}`;
  return name === panel || name === preview || name.endsWith(`.${preview}`);
}

// ── Data paths ───────────────────────────────────────────────────────────────

/** True when one path is the other or contains it (segment-wise: 'img' contains 'img/a', not 'images'). */
export function dataPathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Segment names refused in a data path whatever their case (config read per directory by PHP / the web server). */
export const FORBIDDEN_DATA_PATH_SEGMENTS: ReadonlySet<string> = new Set(['php.ini', 'web.config']);

/**
 * A data path becomes, in every release, a symlink `<path>` → `/srv/data/<path>`
 * whose target the SITE can replace (its parent is rw in the container). A
 * path naming a per-directory config file (`.user.ini` = PHP_INI_PERDIR,
 * `.htaccess` = AllowOverride, `php.ini`…) would let code in the site write
 * that config (auto_prepend_file, AddHandler…) and bypass "PHP never runs
 * from data" for good. Any segment starting with '.' is refused (`.htaccess`,
 * `.htpasswd`, `.user.ini`, `.git`, `.well-known`…), plus
 * FORBIDDEN_DATA_PATH_SEGMENTS. Returns an English message or null.
 */
export function dataPathForbiddenError(path: string): string | null {
  for (const seg of path.split('/')) {
    if (seg.startsWith('.')) return `A data path segment may not start with a dot (${seg})`;
    if (FORBIDDEN_DATA_PATH_SEGMENTS.has(seg.toLowerCase())) return `A data path may not be named ${seg}`;
  }
  return null;
}

/**
 * True when the data path is the docroot or one of its ancestors: the whole
 * document root (the site's code) would then live in writable data.
 * docroot '' (release root) never conflicts (a data path is never empty).
 */
export function dataPathContainsDocroot(path: string, docroot: string): boolean {
  if (!path) return false;
  return docroot === path || docroot.startsWith(`${path}/`);
}

/** First existing path overlapping `candidate`, else null. */
export function findDataPathOverlap(existing: readonly string[], candidate: string): string | null {
  for (const p of existing) if (dataPathsOverlap(p, candidate)) return p;
  return null;
}

/**
 * Extensions of a `typed` data path: lower-cased, leading dot removed,
 * deduplicated, 1..100 items of ^[a-z0-9]{1,10}$, never PHP-like
 * (PHP_LIKE_EXTENSION_RE). null when invalid.
 */
export function normalizeExtensions(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return null;
    const ext = raw.trim().toLowerCase().replace(/^\./, '');
    if (!EXTENSION_RE.test(ext) || PHP_LIKE_EXTENSION_RE.test(ext)) return null;
    if (!out.includes(ext)) out.push(ext);
  }
  if (out.length < 1 || out.length > MAX_TYPED_EXTENSIONS) return null;
  return out;
}

// ── Site settings ────────────────────────────────────────────────────────────

/** PHP memory_limit ceiling: 2048 MiB, or the plan's memory when lower. */
export function phpMemoryCeiling(planMemoryMb: number | null): number {
  return planMemoryMb === null ? 2048 : Math.max(32, Math.min(2048, planMemoryMb));
}

/**
 * Checks merged PHP settings against the ranges (memoryLimitMb 32..min(2048,
 * plan memory), uploadMaxFilesizeMb 1..2048, postMaxSizeMb ≥ upload and
 * ≤ 2048, maxExecutionTime 5..3600). Returns an English message or null.
 */
export function phpSettingsError(php: PhpSettings, planMemoryMb: number | null): string | null {
  const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v);
  const ceiling = phpMemoryCeiling(planMemoryMb);
  if (php.memoryLimitMb !== undefined && (!int(php.memoryLimitMb) || php.memoryLimitMb < 32 || php.memoryLimitMb > ceiling)) {
    return `php.memoryLimitMb must be between 32 and ${ceiling}`;
  }
  if (php.uploadMaxFilesizeMb !== undefined && (!int(php.uploadMaxFilesizeMb) || php.uploadMaxFilesizeMb < 1 || php.uploadMaxFilesizeMb > 2048)) {
    return 'php.uploadMaxFilesizeMb must be between 1 and 2048';
  }
  if (php.postMaxSizeMb !== undefined && (!int(php.postMaxSizeMb) || php.postMaxSizeMb < 1 || php.postMaxSizeMb > 2048)) {
    return 'php.postMaxSizeMb must be between 1 and 2048';
  }
  if (php.postMaxSizeMb !== undefined && php.uploadMaxFilesizeMb !== undefined && php.postMaxSizeMb < php.uploadMaxFilesizeMb) {
    return 'php.postMaxSizeMb must be greater than or equal to php.uploadMaxFilesizeMb';
  }
  if (php.maxExecutionTime !== undefined && (!int(php.maxExecutionTime) || php.maxExecutionTime < 5 || php.maxExecutionTime > 3600)) {
    return 'php.maxExecutionTime must be between 5 and 3600';
  }
  return null;
}

/** Custom nginx rules: ≤ 16 KiB, no NUL byte. Returns an English message or null. */
export function customNginxError(text: string): string | null {
  if (text.includes('\0')) return 'customNginx must not contain NUL bytes';
  if (Buffer.byteLength(text, 'utf8') > CUSTOM_NGINX_MAX_BYTES) return `customNginx must not exceed ${CUSTOM_NGINX_MAX_BYTES} bytes`;
  return null;
}

/** Postgres unique violation (retry / 409 mapping). */
export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === '23505';
}
