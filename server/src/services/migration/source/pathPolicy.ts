// ─────────────────────────────────────────────────────────────────────────────
// Path policy of the read-only executor (docs/P5-PLAN.md §5.3) — PURE.
//
// Every path sent to the source is: absolute, normalized (no `..`, `.`, `//`,
// trailing slash), free of NUL / newline / control characters and of glob
// characters, ≤ 1024 bytes; it lies under a READ ROOT that allows the kind of
// access asked for (content, listing, size…); content reads also go through
// the DENY LIST (shadow, private keys, .ssh, .my.cnf, wp-config.php, .env…)
// and, under /home, through an ALLOW-LIST of file names. Anything else is
// refused (refuse rather than sanitize, H5).
//
// MG10: /home and /var/vmail are written by the clients of the source; every
// access below them is rendered with a source-side `realpath -e` guard
// (templates.ts) — see `needsSymlinkGuard`.
// ─────────────────────────────────────────────────────────────────────────────

export class PathPolicyError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'PathPolicyError';
  }
}

/** What a template does with a path. */
export type PathAccess =
  /** File content (fs.cat, fs.catMany). */
  | 'content'
  /** Line count (fs.lineCount: authorized_keys counting allowed). */
  | 'lineCount'
  /** Directory listing / tree walk (fs.ls, fs.find). */
  | 'list'
  /** PHP handler lines of .htaccess files (fs.grepHtaccess). */
  | 'htaccess'
  /** Metadata (fs.stat). */
  | 'stat'
  /** Sizes (fs.du). */
  | 'du';

export const MAX_PATH_LENGTH = 1024;

interface ReadRoot {
  /** Directory root (trailing '/') or exact file path. */
  path: string;
  access: ReadonlySet<PathAccess>;
}

const ALL: ReadonlySet<PathAccess> = new Set<PathAccess>(['content', 'lineCount', 'list', 'htaccess', 'stat', 'du']);
const NO_HTACCESS: ReadonlySet<PathAccess> = new Set<PathAccess>(['content', 'lineCount', 'list', 'stat', 'du']);
const FILE_ONLY: ReadonlySet<PathAccess> = new Set<PathAccess>(['content', 'lineCount', 'stat']);

/**
 * Read roots (§5.3). `/etc/named.conf` is only reachable through dns.namedConf, unit
 * files' content only through sys.unitFile, zone files through dns.zoneDump.
 */
export const READ_ROOTS: readonly ReadRoot[] = [
  { path: '/home/', access: ALL },
  { path: '/etc/nginx/', access: NO_HTACCESS },
  { path: '/usr/local/apache/conf.d/', access: NO_HTACCESS },
  { path: '/usr/local/apache/conf/', access: NO_HTACCESS },
  { path: '/etc/varnish/', access: NO_HTACCESS },
  { path: '/var/named/', access: NO_HTACCESS },
  { path: '/etc/opendkim/', access: NO_HTACCESS },
  { path: '/etc/pki/tls/certs/', access: NO_HTACCESS },
  { path: '/var/spool/cron/', access: NO_HTACCESS },
  { path: '/usr/local/cwp/.conf/', access: NO_HTACCESS },
  { path: '/usr/local/cwp/users/suspended/', access: new Set<PathAccess>(['list', 'stat', 'du']) },
  { path: '/usr/local/cwpsrv/htdocs/resources/admin/include/version.php', access: FILE_ONLY },
  { path: '/usr/local/cwpsrv/htdocs/resources/conf/web_servers/', access: NO_HTACCESS },
  { path: '/usr/local/etc/suphp.conf', access: FILE_ONLY },
  { path: '/opt/alt/', access: NO_HTACCESS },
  { path: '/etc/pure-ftpd/', access: NO_HTACCESS },
  { path: '/etc/systemd/system/', access: new Set<PathAccess>(['list', 'stat']) },
  { path: '/var/vmail/', access: new Set<PathAccess>(['list', 'stat', 'du']) },
  { path: '/usr/local/apache/domlogs/', access: new Set<PathAccess>(['du']) },
  { path: '/etc/os-release', access: FILE_ONLY },
  { path: '/etc/redhat-release', access: FILE_ONLY },
];

/** Under /home, fs.cat / fs.catMany only read these files (§5.3). */
const HOME_CONTENT_BASENAMES = new Set(['.htaccess', 'php.ini', '.user.ini', 'package.json', 'composer.json', 'requirements.txt', 'cron']);
const HOME_CONTENT_PATTERNS: readonly RegExp[] = [
  /^\/home\/[^/]+\/\.conf\/webservers\/[^/]+\.conf$/,
  /^\/home\/[^/]+\/\.conf\/\.addons_wp$/,
];

/** Syntactic checks shared by every path argument. Throws PathPolicyError. */
export function assertCleanPath(p: unknown, what = 'path'): asserts p is string {
  if (typeof p !== 'string' || p.length === 0) throw new PathPolicyError(`${what}: empty`);
  if (Buffer.byteLength(p, 'utf8') > MAX_PATH_LENGTH) throw new PathPolicyError(`${what}: longer than ${MAX_PATH_LENGTH} bytes`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) throw new PathPolicyError(`${what}: control character`);
  if (!p.startsWith('/')) throw new PathPolicyError(`${what}: not absolute`);
  if (p === '/') throw new PathPolicyError(`${what}: root directory`);
  if (p.includes('//')) throw new PathPolicyError(`${what}: not normalized (//)`);
  if (p.endsWith('/')) throw new PathPolicyError(`${what}: trailing slash`);
  const segs = p.split('/').slice(1);
  if (segs.some((s) => s === '.' || s === '..')) throw new PathPolicyError(`${what}: not normalized (. or ..)`);
  if (/[*?[\]\\]/.test(p)) throw new PathPolicyError(`${what}: glob or backslash character`);
}

function rootOf(p: string): ReadRoot | null {
  for (const r of READ_ROOTS) {
    if (r.path.endsWith('/')) {
      if (p === r.path.slice(0, -1) || p.startsWith(r.path)) return r;
    } else if (p === r.path) {
      return r;
    }
  }
  return null;
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Deny list (§5.3). Returns the reason or null. `access` lets fs.lineCount count .ssh keys. */
export function denyReason(p: string, access: PathAccess): string | null {
  const base = basename(p);
  const lower = p.toLowerCase();
  if (p === '/etc/shadow' || p === '/etc/gshadow' || p.startsWith('/etc/shadow') || p.startsWith('/etc/gshadow')) return 'denied: shadow file';
  if (p === '/root' || p.startsWith('/root/')) return 'denied: /root';
  if (p.startsWith('/etc/named/keys/') || p === '/etc/named/keys') return 'denied: named keys';
  if (base.endsWith('.private')) return 'denied: private key file';
  if (p.startsWith('/etc/pki/tls/private/') || p === '/etc/pki/tls/private') return 'denied: TLS private keys';
  if (base === 'pureftpd.passwd' || base === 'pureftpd.pdb') return 'denied: FTP password database';
  if (access !== 'lineCount' && /^\/home\/[^/]+\/\.ssh(\/|$)/.test(p)) return 'denied: .ssh (line count only)';
  if (base === '.my.cnf') return 'denied: .my.cnf';
  if (base === 'wp-config.php') return 'denied: wp-config.php';
  if (base === '.env' || base.startsWith('.env.')) return 'denied: .env';
  if (access === 'content' && (p === '/var/vmail' || p.startsWith('/var/vmail/'))) return 'denied: mail content';
  if (p.startsWith('/usr/local/cwp/.conf/mysql_manager/') || p === '/usr/local/cwp/.conf/mysql_manager') return 'denied: mysql_manager';
  if (lower.startsWith('/usr/local/cwp/.conf/')) {
    const rel = lower.slice('/usr/local/cwp/.conf/'.length);
    if (/(pass|secret|token|key)/.test(rel)) return 'denied: secret-looking name under /usr/local/cwp/.conf';
  }
  return null;
}

/**
 * Full policy for a path argument of an fs.* template. Throws PathPolicyError
 * (outside roots, access not allowed by the root, deny list, /home allow-list).
 */
export function checkReadPath(p: unknown, access: PathAccess, what = 'path'): string {
  assertCleanPath(p, what);
  const root = rootOf(p);
  if (!root) throw new PathPolicyError(`${what}: outside the read roots`);
  if (!root.access.has(access)) throw new PathPolicyError(`${what}: ${access} not allowed under ${root.path}`);
  if (access === 'content' || access === 'lineCount' || access === 'htaccess') {
    const denied = denyReason(p, access);
    if (denied) throw new PathPolicyError(`${what}: ${denied}`);
  } else {
    // Listing / metadata: only the hard denials (never list what is never readable).
    if (p === '/root' || p.startsWith('/root/') || p.startsWith('/etc/pki/tls/private') || p.startsWith('/etc/named/keys')) {
      throw new PathPolicyError(`${what}: denied`);
    }
  }
  if (access === 'content' && (p === '/home' || p.startsWith('/home/'))) {
    if (!HOME_CONTENT_BASENAMES.has(basename(p)) && !HOME_CONTENT_PATTERNS.some((re) => re.test(p))) {
      throw new PathPolicyError(`${what}: file not in the /home read allow-list`);
    }
  }
  if (access === 'htaccess' && !p.startsWith('/home/')) throw new PathPolicyError(`${what}: .htaccess scan is limited to /home`);
  return p;
}

/** MG10: paths written by the source's clients — rendered with the realpath guard. */
export function needsSymlinkGuard(p: string): boolean {
  return p === '/home' || p.startsWith('/home/') || p === '/var/vmail' || p.startsWith('/var/vmail/');
}

/** sys.unitFile: a *.service file under /etc/systemd/system (content redacted on the source). */
export function checkUnitFilePath(p: unknown): string {
  assertCleanPath(p, 'path');
  if (!p.startsWith('/etc/systemd/system/')) throw new PathPolicyError('path: not under /etc/systemd/system');
  if (!/^[A-Za-z0-9@._:/-]+$/.test(p) || !p.endsWith('.service')) throw new PathPolicyError('path: not a .service unit file');
  return p;
}

/** dns.zoneDump: a zone file under /var/named (never the keys). */
export function checkZoneFilePath(p: unknown): string {
  assertCleanPath(p, 'file');
  if (!p.startsWith('/var/named/')) throw new PathPolicyError('file: not under /var/named');
  const denied = denyReason(p, 'content');
  if (denied) throw new PathPolicyError(`file: ${denied}`);
  return p;
}

// ── identifiers (§5.4) ──────────────────────────────────────────────────────

const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function checkDomain(v: unknown, what = 'domain'): string {
  if (typeof v !== 'string' || !DOMAIN_RE.test(v)) throw new PathPolicyError(`${what}: invalid domain name`);
  return v;
}

export function checkDatabaseName(v: unknown, what = 'database'): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_$-]{1,64}$/.test(v) || v.startsWith('-')) throw new PathPolicyError(`${what}: invalid identifier`);
  return v;
}

/**
 * Schemas of the system / CWP itself — never dumped (they hold MySQL user
 * hashes, mailbox hashes, panel data): hashes only flow through secret.*
 * (D-SECRETS-JIT, MG2). Same list as discovery's SYSTEM_SCHEMAS.
 */
export const DUMP_FORBIDDEN_SCHEMAS: ReadonlySet<string> = new Set([
  'mysql', 'information_schema', 'performance_schema', 'sys', 'root_cwp', 'postfix', 'postfix_policyd', 'roundcube', 'oauthv2',
  'root_cpmigrations',
]);

/** checkDatabaseName + refusal of the system schemas (mysql.dumpSchema / mysql.dumpData). */
export function checkDumpDatabase(v: unknown, what = 'database'): string {
  const name = checkDatabaseName(v, what);
  if (DUMP_FORBIDDEN_SCHEMAS.has(name.toLowerCase())) throw new PathPolicyError(`${what}: system schema ${name} is never dumped`);
  return name;
}

export function checkMysqlUser(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_$-]{1,80}$/.test(v) || v.startsWith('-')) throw new PathPolicyError('users: invalid user name');
  return v;
}

export function checkDkimSelector(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9._-]{1,63}$/.test(v) || v.startsWith('.') || v.startsWith('-')) {
    throw new PathPolicyError('selector: invalid DKIM selector');
  }
  return v;
}

export function checkFtpLogin(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9._@+-]{1,128}$/.test(v) || v.startsWith('-')) throw new PathPolicyError('login: invalid FTP login');
  return v;
}

export function checkRpmPackage(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(v)) throw new PathPolicyError('packages: invalid package name');
  return v;
}

/** fs.find -name glob. */
export function checkFindName(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9._*?-]{1,64}$/.test(v) || v.startsWith('-')) throw new PathPolicyError('name: invalid find pattern');
  return v;
}

export function checkDepth(v: unknown, what = 'maxDepth'): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 6) throw new PathPolicyError(`${what}: must be an integer 1..6`);
  return v;
}
