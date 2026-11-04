import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import path from 'path';
import type { IncomingMessage } from 'http';
import { APP_INSTALL_LOCALE_RE, type SiteBaseId } from '@oblimint/shared';
import { allowedChecksumUrl, fetchChecksumJson } from '../checksums/fetch';
import { localContentTree } from '../maintenance/contracts';
import { CONTAINER_PATHS } from '../hosting/paths';

// ─────────────────────────────────────────────────────────────────────────────
// WordPress side of the installer: which version, the verified archive, the
// generated files, the WP-CLI commands.
//
// PRE-DOWNLOAD, NOT AN EXCEPTION IN THE ACCOUNT'S FILTER. The panel fetches the
// archive (HTTPS, downloads.wordpress.org only, same-host redirects, size cap),
// compares it with the published SHA-1, keeps it in <root>/app-dist/ and hands it
// to the tools container through a read-only bind. The container runs with NO
// network at all: no tenant filter to open, nothing to keep open, no window in
// which a container of the account may reach the outside. After extraction,
// every core file is compared with the official per-file list (api.wordpress.org).
//
// wp-config.php holds no secret: everything comes from the site's environment
// (sealed variables). The release tree and its git history stay free of them.
// ─────────────────────────────────────────────────────────────────────────────

export const WP_VERSION_RE = /^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/;
export const ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_REDIRECTS = 3;

export class WordPressDistError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'WordPressDistError';
  }
}

export function assertLocale(locale: string): void {
  if (!APP_INSTALL_LOCALE_RE.test(locale)) throw new WordPressDistError('localeInvalid', `Invalid locale ${JSON.stringify(locale)}`);
}

/** URLs built only from a validated version and locale. */
export function archiveUrl(version: string, locale: string): string {
  if (!WP_VERSION_RE.test(version)) throw new WordPressDistError('versionInvalid', 'Invalid WordPress version');
  assertLocale(locale);
  return locale === 'en_US'
    ? `https://downloads.wordpress.org/release/wordpress-${version}.tar.gz`
    : `https://downloads.wordpress.org/release/${locale}/wordpress-${version}.tar.gz`;
}

export function archiveFileName(version: string, locale: string): string {
  return `wordpress-${version}-${locale}.tar.gz`;
}

const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

export interface WpOffer { version: string; phpVersion: string | null }

/**
 * The newest build of this locale in a version-check answer. An offer of
 * another locale is a fallback of the API (no such translated build): refused,
 * so that the site never silently comes up in another language.
 */
export function pickOffer(doc: unknown, locale: string): WpOffer | null {
  const offers = (doc as { offers?: unknown } | null)?.offers;
  if (!Array.isArray(offers)) return null;
  let best: WpOffer | null = null;
  for (const o of offers as Array<Record<string, unknown>>) {
    if (o?.locale !== locale || typeof o.version !== 'string' || !WP_VERSION_RE.test(o.version)) continue;
    if (!best || compareVersions(o.version, best.version) > 0) {
      best = { version: o.version, phpVersion: typeof o.php_version === 'string' ? o.php_version : null };
    }
  }
  return best;
}

export function phpSatisfies(php: string, required: string | null): boolean {
  return !required || compareVersions(php, required) >= 0;
}

/** One HTTPS GET of an allow-listed URL to a sink (file or memory), same-host redirects only. */
export type DistGet = (url: string, sink: fs.WriteStream | null, maxBytes: number) => Promise<{ status: number; body: Buffer }>;

const httpsGet: DistGet = async (raw, sink, maxBytes) => {
  let url = allowedChecksumUrl(raw);
  if (!url) throw new WordPressDistError('downloadFailed', 'URL outside the official WordPress hosts');
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  for (let hop = 0; ; hop++) {
    const current = url;
    const r = await new Promise<{ status: number; location: string | null; body: Buffer }>((resolve, reject) => {
      const req = https.get(current, { headers: { 'user-agent': 'Oblimint application installer' }, agent: false }, (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location : null;
        if (status !== 200) {
          res.resume();
          resolve({ status, location, body: Buffer.alloc(0) });
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy(new WordPressDistError('downloadFailed', 'Archive larger than expected'));
            return;
          }
          if (sink) sink.write(c);
          else chunks.push(c);
        });
        res.once('end', () => resolve({ status, location: null, body: Buffer.concat(chunks) }));
        res.once('error', reject);
      });
      req.setTimeout(Math.max(1000, deadline - Date.now()), () => req.destroy(new WordPressDistError('downloadFailed', 'Download timed out')));
      req.once('error', reject);
    });
    if (r.status >= 300 && r.status < 400 && r.location && hop < MAX_REDIRECTS) {
      const next = allowedChecksumUrl(new URL(r.location, current).toString());
      if (!next || next.hostname !== current.hostname) throw new WordPressDistError('downloadFailed', 'Redirect outside the official host');
      url = next;
      continue;
    }
    return { status: r.status, body: r.body };
  }
};

let getImpl: DistGet = httpsGet;
/** Tests: replaces the HTTP layer (null restores). */
export function setDistGetForTests(fn: DistGet | null): void { getImpl = fn ?? httpsGet; }

async function sha1File(file: string): Promise<string> {
  const hash = crypto.createHash('sha1');
  await new Promise<void>((resolve, reject) => {
    const s = fs.createReadStream(file);
    s.on('data', (c) => hash.update(c));
    s.once('end', () => resolve());
    s.once('error', reject);
  });
  return hash.digest('hex');
}

/** Concurrent installations of one build share ONE download. */
const downloads = new Map<string, Promise<string>>();

/**
 * The verified archive of a version + locale in `dir`: from the cache when its
 * hash still matches the published one, downloaded otherwise (temporary file,
 * hash compared, then atomic rename). A mismatch never leaves a file behind.
 * Other cached builds of the locale are dropped (installations in progress
 * hold hard links of their own).
 */
export function ensureArchive(dir: string, version: string, locale: string): Promise<string> {
  const file = path.join(dir, archiveFileName(version, locale));
  const running = downloads.get(file);
  if (running) return running;
  const p = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    const url = archiveUrl(version, locale);
    const sum = await getImpl(`${url}.sha1`, null, 1024);
    if (sum.status !== 200) throw new WordPressDistError('checksumUnavailable', `No published checksum for WordPress ${version} (${locale})`);
    const expected = sum.body.toString('utf8').trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(expected)) throw new WordPressDistError('checksumUnavailable', 'Unreadable published checksum');
    if (fs.existsSync(file)) {
      if (await sha1File(file) === expected) return file;
      fs.rmSync(file, { force: true });
    }
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      const sink = fs.createWriteStream(tmp, { mode: 0o644 });
      const r = await getImpl(url, sink, ARCHIVE_MAX_BYTES);
      await new Promise<void>((resolve, reject) => { sink.once('error', reject); sink.end(() => resolve()); });
      if (r.status !== 200) throw new WordPressDistError('downloadFailed', `WordPress archive: HTTP ${r.status}`);
      const got = await sha1File(tmp);
      if (got !== expected) throw new WordPressDistError('checksumMismatch', `The downloaded archive does not match its published checksum (${got} ≠ ${expected})`);
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    for (const name of fs.readdirSync(dir)) {
      if (name !== path.basename(file) && name.startsWith('wordpress-') && name.endsWith(`-${locale}.tar.gz`)) fs.rmSync(path.join(dir, name), { force: true });
    }
    return file;
  })().finally(() => downloads.delete(file));
  downloads.set(file, p);
  return p;
}

/** The current build of a locale (404 / no build of this locale: localeUnavailable). */
export async function latestOffer(locale: string): Promise<WpOffer> {
  assertLocale(locale);
  const doc = await fetchChecksumJson(`https://api.wordpress.org/core/version-check/1.7/?locale=${encodeURIComponent(locale)}`);
  const offer = pickOffer(doc, locale);
  if (!offer) throw new WordPressDistError('localeUnavailable', `No WordPress build for the locale ${locale}`);
  return offer;
}

export interface CoreVerification {
  /** false: the official list could not be read (the archive hash still held). */
  available: boolean;
  checked: number;
  mismatched: string[];
}

/** Every file of the official list (wp-content/ excepted, as `wp core verify-checksums`) against the staging, no link followed. */
export async function verifyCoreFiles(stagingDir: string, version: string, locale: string): Promise<CoreVerification> {
  let doc: unknown;
  try {
    doc = await fetchChecksumJson(`https://api.wordpress.org/core/checksums/1.0/?version=${encodeURIComponent(version)}&locale=${encodeURIComponent(locale)}`);
  } catch {
    return { available: false, checked: 0, mismatched: [] };
  }
  const list = (doc as { checksums?: unknown } | null)?.checksums;
  if (!list || typeof list !== 'object') return { available: false, checked: 0, mismatched: [] };
  const tree = localContentTree(stagingDir);
  const mismatched: string[] = [];
  let checked = 0;
  for (const [rel, md5] of Object.entries(list as Record<string, unknown>)) {
    if (rel.startsWith('wp-content/') || typeof md5 !== 'string') continue;
    checked++;
    const f = await tree.read(rel, ARCHIVE_MAX_BYTES);
    if (!f || f.truncated || crypto.createHash('md5').update(f.data).digest('hex') !== md5.toLowerCase()) mismatched.push(rel);
  }
  return { available: true, checked, mismatched };
}

// ── generated files (pure) ───────────────────────────────────────────────────

export const WP_SALT_NAMES = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'] as const;

/**
 * The address comes from the request (the edge only forwards the host names
 * declared on the platform, and nothing else reaches a site container): a
 * domain attached later, or a preview, works without touching the database or
 * the code. WP-CLI has no request: it falls back on the stored option.
 */
export function wpConfigPhp(): string {
  return `<?php
/**
 * Generated by the Oblimint application installer. This file holds no secret:
 * the database credentials and the keys are environment variables of the site.
 * The code is read-only in production: extensions, themes and updates go through
 * a release (staging, modification window, or the panel's maintenance).
 */
$oblimint_env = static function ($name, $default = '') {
    $value = getenv($name);
    return ($value === false || $value === '') ? $default : $value;
};

define('DB_NAME', $oblimint_env('DB_NAME'));
define('DB_USER', $oblimint_env('DB_USER'));
define('DB_PASSWORD', $oblimint_env('DB_PASSWORD'));
define('DB_HOST', $oblimint_env('DB_SOCKET') !== '' ? 'localhost:' . $oblimint_env('DB_SOCKET') : $oblimint_env('DB_HOST', 'localhost'));
define('DB_CHARSET', 'utf8mb4');
define('DB_COLLATE', '');

foreach (['${WP_SALT_NAMES.join("', '")}'] as $oblimint_key) {
    define($oblimint_key, $oblimint_env('WP_' . $oblimint_key));
}

$table_prefix = 'wp_';

define('WP_DEBUG', false);
define('DISALLOW_FILE_EDIT', true);
define('DISALLOW_FILE_MODS', true);
define('AUTOMATIC_UPDATER_DISABLED', true);
define('WP_AUTO_UPDATE_CORE', false);

if (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') {
    $_SERVER['HTTPS'] = 'on';
}
if (PHP_SAPI !== 'cli' && preg_match('/^[A-Za-z0-9.-]+(:[0-9]+)?$/', $_SERVER['HTTP_HOST'] ?? '') === 1) {
    $oblimint_url = ((($_SERVER['HTTPS'] ?? '') === 'on') ? 'https://' : 'http://') . $_SERVER['HTTP_HOST'];
    define('WP_HOME', $oblimint_url);
    define('WP_SITEURL', $oblimint_url);
}

if (!defined('ABSPATH')) {
    define('ABSPATH', __DIR__ . '/');
}
require_once ABSPATH . 'wp-settings.php';
`;
}

/** WordPress cannot write its own .htaccess in a release: the standard block, for the pretty permalinks. */
export function wpHtaccess(): string {
  return `# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /
RewriteRule ^index\\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
`;
}

export const isApacheBase = (base: SiteBaseId): boolean => base.startsWith('apache-');

// ── commands (pure): argv elements, never a shell string ─────────────────────

export const ARCHIVE_IN_DIST = 'app.tar.gz';
const dist = (name: string) => `${CONTAINER_PATHS.toolsDist}/${name}`;
const WP_FLAGS = [`--path=${CONTAINER_PATHS.toolsApp}`, '--skip-plugins', '--skip-themes', '--no-color'];

/** Environment name of the admin password in the only step that receives it. */
export const ADMIN_PASSWORD_ENV = 'OBLIMINT_INSTALL_ADMIN_PASSWORD';
export const ADMIN_USER_ENV = 'OBLIMINT_INSTALL_ADMIN_USER';

/** Fixed code: the password is read from the environment, it never appears in the command line. */
const SET_PASSWORD_PHP = `$u = get_user_by('login', getenv('${ADMIN_USER_ENV}')); if (!$u) { exit(1); } wp_set_password(getenv('${ADMIN_PASSWORD_ENV}'), $u->ID);`;

export const wpInstallCommands = {
  extract: () => ['tar', '-xzf', dist(ARCHIVE_IN_DIST), '--strip-components=1', '--no-same-owner', '-C', CONTAINER_PATHS.toolsApp],
  config: (withHtaccess: boolean) => ['cp', dist('wp-config.php'), ...(withHtaccess ? [dist('.htaccess')] : []), `${CONTAINER_PATHS.toolsApp}/`],
  /**
   * Without --admin_password WP-CLI draws a random one and prints it: never
   * used (replaced at once by setPassword), and the output of this step is scrubbed.
   */
  coreInstall: (title: string, adminUser: string, adminEmail: string) => ['wp', 'core', 'install', '--url=http://localhost', `--title=${title}`,
    `--admin_user=${adminUser}`, `--admin_email=${adminEmail}`, '--skip-email', ...WP_FLAGS],
  setPassword: () => ['wp', 'eval', SET_PASSWORD_PHP, ...WP_FLAGS],
  permalinks: () => ['wp', 'option', 'update', 'permalink_structure', '/%postname%/', ...WP_FLAGS],
};

/** Removes any known secret, and what WP-CLI prints of a generated password, from a text kept or shown. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = String(text ?? '').replace(/(Admin password:\s*)\S+/gi, '$1***');
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out;
}
