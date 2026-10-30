import {
  LEAK_FINDINGS_MAX, normalizeLeakAllowlistEntry,
  type LeakFinding, type LeakPolicy, type LeakReport, type LeakRule,
} from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Leak guard of the publication (item 9 of the second feature audit): every
// release is checked for committed secrets and for files that should never be
// published — dumps, copies of configuration files, backups, phpinfo pages,
// database managers, version control metadata, logs.
//
//  - Rules on the FILE (name, place) run on the whole release tree: a dump
//    published earlier under the warn policy is still reported.
//  - Rules on the CONTENT (secrets, phpinfo(), .env values) read the changed
//    files only (and a few named candidates: *.sql, phpinfo.php…), within a
//    budget (files, bytes, time): what is left unread is counted, never silent.
//  - A finding names the file, the line and the rule. The secret itself is
//    NEVER copied anywhere (no excerpt, no prefix): only its position.
//  - Severity: critical when the web server would hand the file out as is
//    (inside the document root, not executed as PHP, not refused by the
//    site configuration), warn otherwise. A panel token is critical anywhere;
//    a browser key public by design (Google AIza…) is a warning everywhere.
//  - Policy block: a critical finding stops the publication (the pipeline
//    fails it, errorCode leakBlocked). Policy warn: reported only. Paths of
//    the allowlist (globs) are ignored and counted.
// Pure module apart from the injected reader (table-tested in leakGuard.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

export interface LeakEntry {
  /** Relative POSIX path in the release. */
  path: string;
  size: number;
  type: 'file' | 'symlink';
}

export interface LeakBudget {
  /** Files whose content is read (default 20 000). */
  files: number;
  /** Bytes read in all (default 128 MB). */
  bytes: number;
  /** Bytes read per file (default 1 MB: the start of a larger file). */
  fileBytes: number;
  /** Files larger than this are not read at all (default 16 MB). */
  maxFileSize: number;
  /** Wall-clock budget of the content pass (default 30 s). */
  ms: number;
}

export const DEFAULT_LEAK_BUDGET: LeakBudget = {
  files: 20_000, bytes: 128 * 1024 * 1024, fileBytes: 1024 * 1024, maxFileSize: 16 * 1024 * 1024, ms: 30_000,
};

export interface LeakGuardInput {
  /** Every entry of the release (directories implied by the paths). */
  entries: LeakEntry[];
  /** Files whose content is read (the changed files); null = all of them. */
  contentPaths: Set<string> | null;
  /** Start of a regular file (at most maxBytes), null when absent / unreadable. */
  read(rel: string, maxBytes: number): Promise<Buffer | null>;
  /** Document root of the site ('' = the release root). */
  docroot: string;
  /** Web server of the site's base (what it refuses differs); null = unknown (Apache rules, the most permissive). */
  engine: 'apache' | 'nginx' | null;
  policy: LeakPolicy;
  allowlist: string[];
  budget?: Partial<LeakBudget>;
  now?: () => number;
}

// ── paths ────────────────────────────────────────────────────────────────────

const baseOf = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);
const segmentsOf = (rel: string) => rel.split('/');

/** PHP sources executed (.php) or refused (.phtml, .php5…) by the site configuration: never handed out as text. */
const PHP_EXT_RE = /\.(php[0-9]?|phtml|pht|phps|phar)$/i;
/** Third-party / test trees: a key there is usually a fixture (lower severity, still reported). */
const FIXTURE_DIR_RE = /(^|\/)(vendor|node_modules|bower_components|tests?|__tests__|spec|fixtures?|testdata|test-data|examples?|docs?)\//i;
/** Code shipped by others (CMS extensions): a sample .sql or a .bak there is theirs — reported, never blocking. */
const THIRD_PARTY_DIR_RE = /(^|\/)(wp-content\/(plugins|mu-plugins|themes)|modules|plugins|libraries|extensions)\//i;

/** Inside the document root (the only part of the release the web server serves). */
export function inDocroot(rel: string, docroot: string): boolean {
  const d = docroot.replace(/^\/+|\/+$/g, '');
  return d === '' || rel.startsWith(`${d}/`);
}

/** Refused by the site configuration whatever its extension (images/siteconf templates). */
export function refusedByServer(rel: string, engine: 'apache' | 'nginx' | null): boolean {
  const segs = segmentsOf(rel);
  if (engine === 'nginx') {
    // location ~ /\.(?!well-known/) — any dot segment but .well-known.
    return segs.some((s) => s.startsWith('.') && s !== '.well-known');
  }
  // Apache: <FilesMatch "^\.(ht|user\.ini|git|svn|env)"> and <DirectoryMatch "/\.(git|svn|hg)(/|$)">.
  if (/^\.(ht|user\.ini|git|svn|env)/.test(segs[segs.length - 1])) return true;
  return segs.slice(0, -1).some((s) => s === '.git' || s === '.svn' || s === '.hg');
}

/** Reachable over HTTP (served as is, or run for a PHP file). */
export function reachable(rel: string, docroot: string, engine: 'apache' | 'nginx' | null): boolean {
  return inDocroot(rel, docroot) && !refusedByServer(rel, engine);
}

/** Handed out AS IS by the web server: reachable and not a PHP source (run or refused). */
export function servedRaw(rel: string, docroot: string, engine: 'apache' | 'nginx' | null): boolean {
  return reachable(rel, docroot, engine) && !PHP_EXT_RE.test(baseOf(rel));
}

// ── allowlist (globs, matched without backtracking) ──────────────────────────

const enum Tok { Char, One, Star, Globstar }
type GlobToken = { t: Tok; c?: number };
const SLASH = 47;

function tokenize(g: string): GlobToken[] {
  const out: GlobToken[] = [];
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    const last = out[out.length - 1]?.t;
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (last !== Tok.Globstar) out.push({ t: Tok.Globstar });
      } else if (last !== Tok.Globstar && last !== Tok.Star) out.push({ t: Tok.Star });
    } else if (c === '?') out.push({ t: Tok.One });
    else out.push({ t: Tok.Char, c: g.charCodeAt(i) });
  }
  return out;
}

/** Dynamic program over (token, character): O(tokens × length), whatever the glob. */
function tokensMatch(toks: GlobToken[], s: string): boolean {
  const n = s.length;
  let prev = new Uint8Array(n + 1);
  let cur = new Uint8Array(n + 1);
  prev[0] = 1;
  for (const tk of toks) {
    cur.fill(0);
    let any = false;
    for (let j = 0; j <= n; j++) {
      let v = 0;
      switch (tk.t) {
        case Tok.Char: v = j > 0 && prev[j - 1] && s.charCodeAt(j - 1) === tk.c ? 1 : 0; break;
        case Tok.One: v = j > 0 && prev[j - 1] && s.charCodeAt(j - 1) !== SLASH ? 1 : 0; break;
        case Tok.Star: v = prev[j] || (j > 0 && cur[j - 1] && s.charCodeAt(j - 1) !== SLASH) ? 1 : 0; break;
        case Tok.Globstar: v = prev[j] || (j > 0 && cur[j - 1]) ? 1 : 0; break;
      }
      cur[j] = v;
      if (v) any = true;
    }
    if (!any) return false;
    [prev, cur] = [cur, prev];
  }
  return prev[n] === 1;
}

/**
 * Matcher of the allowlist of a site. An entry ending with "/" is a folder
 * (everything under it); an entry without "/" matches the file name at any
 * depth ("*.sql", "install.sql"); otherwise the glob matches the path or one
 * of its folders ("wp-content/plugins/x" covers everything below it).
 * "*" stays within a segment, "**" crosses them, "?" is one character.
 * Invalid entries are ignored.
 */
export function compileLeakAllowlist(list: readonly string[]): (rel: string) => boolean {
  const entries = list.map(normalizeLeakAllowlistEntry).filter((e): e is string => e !== null)
    .map((e) => (e.endsWith('/')
      ? { kind: 'dir' as const, toks: tokenize(e.slice(0, -1)) }
      : { kind: e.includes('/') ? 'path' as const : 'name' as const, toks: tokenize(e) }));
  if (!entries.length) return () => false;
  return (rel) => {
    const dirs: string[] = [];
    for (let i = rel.indexOf('/'); i > 0; i = rel.indexOf('/', i + 1)) dirs.push(rel.slice(0, i));
    const clean = rel.endsWith('/') ? rel.slice(0, -1) : rel;
    return entries.some((e) => {
      if (e.kind === 'name') return tokensMatch(e.toks, baseOf(clean)) || segmentsOf(clean).slice(0, -1).some((s) => tokensMatch(e.toks, s));
      if (e.kind === 'dir') return dirs.some((d) => tokensMatch(e.toks, d)) || (rel.endsWith('/') && tokensMatch(e.toks, clean));
      return tokensMatch(e.toks, clean) || dirs.some((d) => tokensMatch(e.toks, d));
    });
  };
}

// ── rules ────────────────────────────────────────────────────────────────────

type Sev = LeakFinding['severity'];

const MESSAGES: Record<LeakRule, string> = {
  'secret.panel-token': 'An access key or token of this panel is written in this file: revoke it (Access keys) and remove it from the code.',
  'secret.private-key': 'A private key is committed in this file: move it out of the code (site variables) and replace it.',
  'secret.cloud': 'A cloud / SaaS credential is committed in this file: rotate it at the provider and read it from a site variable instead.',
  'secret.env-file': 'A .env file with secret values is published: use the site variables instead and keep the file out of the code.',
  'secret.key-file': 'A key store or credentials file is published: remove it from the code.',
  'expose.dump': 'A database dump with data is published: remove it (import it into the database, keep backups off the site).',
  'expose.config-backup': 'A copy of a source / configuration file would be served as plain text: remove it.',
  'expose.backup-archive': 'An archive named like a site or database backup is published: remove it.',
  'expose.diagnostic': 'A phpinfo() page shows the server and the environment variables (secrets included): remove it.',
  'expose.db-tool': 'A database manager is published in the code: remove it, use the panel instead.',
  'expose.vcs': 'Version control metadata (history, remotes) is published: remove it.',
  'expose.log': 'A log file is served: remove it (logs can hold secrets and personal data).',
};

const DUMP_EXT_RE = /\.(sql|mysql|pgsql|psql|dump)(\.(gz|bz2|xz|zst|zip|7z|tar|tgz))?$/i;
const DUMP_PLAIN_RE = /\.(sql|mysql|pgsql|psql)$/i;
// Linear patterns only (tenant-controlled text of up to 1 MB, run on the event
// loop): the line start is [ \t]*, never \s* (which crosses newlines and makes
// every line start rescan the rest), and a single greedy class per line.
const DUMP_DATA_RE = /^[ \t]*(INSERT[ \t]+(IGNORE[ \t]+)?INTO\b|REPLACE[ \t]+INTO\b|COPY[ \t]+[^;\n]*\bFROM[ \t]+stdin\b)/im;

const BACKUP_SUFFIX_RE = /(?:[._-](?:bak|backup|old|orig|original|save|sav|swp|swo|tmp|temp|copy|txt|\d{1,8})|~)$/i;
const SOURCE_EXT_RE = /\.(php[0-9]?|phtml|inc|ini|conf|cnf|config|cfg|env|ya?ml|json|xml|htaccess|htpasswd|properties|toml|py|rb|js|ts)$/i;
const CONFIG_NAME_RE = /(config|settings|configuration|database|db|\.env|local|parameters|secrets?|credentials?|connect|wp-config|htpasswd|htaccess)/i;

const ARCHIVE_EXT_RE = /\.(zip|tar|tgz|tar\.gz|tar\.bz2|tbz2?|tar\.xz|txz|tar\.zst|gz|bz2|xz|7z|rar|bak|wpress|jpa|daf)$/i;
const BACKUP_TOOL_EXT_RE = /\.(wpress|jpa|daf)$/i;
/** Stem of an archive (extension removed) named like a backup: a backup word, or exactly the name of a site tree. */
const BACKUP_NAME_RE = /(^|[._-])(backups?|bak|dump|sauvegardes?|db|database|sql|mysql)([._-]|\d|$)|^(site|website|www|html|public|htdocs|public_html|httpdocs|web|wp-content|wordpress|app|src|code|full|home)([._-]?\d[\d._-]*)?$/i;

const LOG_NAME_RE = /(\.log(\.\d+)?|^error_log|^php_errors?\.log)$/i;

const KEY_FILE_NAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.htpasswd', '.git-credentials', '.netrc', '_netrc', '.pgpass', '.my.cnf', '.s3cfg', '.dockercfg', '.boto']);
const KEY_FILE_EXT_RE = /\.(p12|pfx|jks|keystore|ppk|kdbx)$/i;

const PHPINFO_NAMES = new Set(['phpinfo.php', 'info.php', 'i.php', 'pi.php', 'php.php', 'test.php', 'phptest.php', 'php_info.php', 'infos.php', 'phpversion.php']);
const PHPINFO_RE = /\bphpinfo\s*\(/i;
/** A phpinfo() call counts in a SMALL file only (a page dedicated to it, not an admin tool that offers it). */
const PHPINFO_MAX_SIZE = 8 * 1024;
const DB_TOOL_NAME_RE = /^(adminer[\w.-]*|phpliteadmin|sqlbuddy|dumper|sypex_dumper)\.php$/i;
const DB_TOOL_CONTENT_RE = /\bAdminer\b[\s\S]{0,4000}\badminer\.org\b|\badminer\.org\b[\s\S]{0,4000}\bAdminer\b/;
const PHPMYADMIN_RE = /(^|\/)phpmyadmin[^/]*\/index\.php$/i;

const VCS_DIRS = new Set(['.svn', '.hg', '.bzr', 'CVS', '_darcs']);

const ENV_NAME_RE = /^\.env(\.[\w.-]+)?$|^[\w.-]+\.env$/i;
const ENV_TEMPLATE_RE = /\.(example|sample|dist|template|tpl|defaults?)$|^\.env\.(example|sample|dist|template|tpl|defaults?)\b/i;
const ENV_SECRET_KEY_RE = /(PASS|PWD|SECRET|TOKEN|KEY|CREDENTIAL|PRIVATE|AUTH|SALT|SIGNATURE|DSN|DATABASE_URL)/i;
const ENV_PLACEHOLDER_RE = /^(|null|none|changeme|change_me|change-me|secret|password|xxx+|\*+|todo|example|your[-_ ].*|<.*>|\$\{.*\}|%.*%)$/i;

const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP |SSH2 )?PRIVATE KEY(?: BLOCK)?-----/g;
const PANEL_TOKEN_RE = /(?<![A-Za-z0-9_])(?:ob([kt])_([1-9]\d{0,9})_[A-Za-z0-9_-]{43}|oba_[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g;
/**
 * Cloud / SaaS credentials. `browser`: a key that is public by design (shipped
 * in served JS / HTML, restricted by referrer at the provider: Google Maps,
 * Firebase web config) — reported as a warning, never blocking.
 */
const CLOUD_RES: { re: RegExp; browser?: true }[] = [
  { re: /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/g },               // AWS access key id
  { re: /(?<![A-Za-z0-9_])(?:sk|rk)_live_[0-9a-zA-Z]{20,}/g },                  // Stripe live secret / restricted key
  { re: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,}/g },                       // GitHub tokens
  { re: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{50,}/g },                     // GitHub fine-grained token
  { re: /(?<![A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,}/g },                         // GitLab personal token
  { re: /(?<![A-Za-z0-9_])xox[abposr]-[A-Za-z0-9-]{10,}/g },                    // Slack tokens
  { re: /(?<![A-Za-z0-9_])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, browser: true }, // Google API key (browser key)
  { re: /(?<![A-Za-z0-9_])SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g },         // SendGrid
  { re: /(?<![A-Za-z0-9_])sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g },     // OpenAI project / service keys
  { re: /(?<![A-Za-z0-9_])sk-ant-[A-Za-z0-9_-]{20,}/g },                        // Anthropic
];
/** Documentation placeholders (AKIAIOSFODNN7EXAMPLE…). */
const EXAMPLE_TOKEN_RE = /EXAMPLE|XXXXXXXX|0{16}/i;
const NPM_TOKEN_RE = /_authToken\s*=\s*(?!\$\{)\S{8,}/;
const COMPOSER_AUTH_RE = /"(github-oauth|gitlab-token|gitlab-oauth|bitbucket-oauth|http-basic|bearer)"\s*:\s*\{/;
const PYPIRC_RE = /^[ \t]*password[ \t]*[=:][ \t]*\S/im;
const ENV_LINE_RE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.]*)[ \t]*=(.*)$/;

/** Value of a .env line without its trailing comment (" #…" or "\t#…"), without a regex. */
function stripEnvComment(value: string): string {
  for (let i = value.indexOf('#'); i !== -1; i = value.indexOf('#', i + 1)) {
    if (i > 0 && (value[i - 1] === ' ' || value[i - 1] === '\t')) return value.slice(0, i);
  }
  return value;
}

/** Extensions never read for content (media, fonts, archives, binaries). */
const NO_CONTENT_EXT_RE = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|mp[34]|m4a|ogg|wav|flac|webm|mov|avi|mkv|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|rar|tar|zst|jar|war|pdf|docx?|xlsx?|pptx?|odt|ods|exe|dll|so|dylib|bin|class|pyc|wasm|swf|mo|sqlite3?|db)$/i;

/** Rough order of interest for the content budget: served text first, PHP after, the rest last. */
function contentPriority(rel: string, docroot: string, engine: 'apache' | 'nginx' | null): number {
  const b = baseOf(rel);
  if (ENV_NAME_RE.test(b) || /\.(pem|key|json|ya?ml|ini|conf|cnf|env|txt|js|xml|properties|toml|npmrc|pypirc)$/i.test(b)) {
    return servedRaw(rel, docroot, engine) ? 0 : 1;
  }
  if (PHP_EXT_RE.test(b) || /\.inc$/i.test(b)) return 2;
  return FIXTURE_DIR_RE.test(rel) ? 4 : 3;
}

/** 1-based line of a character index. */
function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

const PER_RULE_PER_FILE = 5;

export async function detectLeaks(input: LeakGuardInput): Promise<LeakReport> {
  const budget: LeakBudget = { ...DEFAULT_LEAK_BUDGET, ...(input.budget ?? {}) };
  const now = input.now ?? Date.now;
  const { docroot, engine } = input;
  const allowed = compileLeakAllowlist(input.allowlist);
  const findings: LeakFinding[] = [];
  let allowlisted = 0;
  const seen = new Set<string>();

  const add = (path: string, rule: LeakRule, severity: Sev, served: boolean, line: number | null = null, keyId: number | null = null) => {
    const k = `${path}\0${rule}\0${line ?? ''}`;
    if (seen.has(k)) return;
    seen.add(k);
    if (allowed(path)) { allowlisted++; return; }
    findings.push({ path, line, rule, severity, served, ...(rule === 'secret.panel-token' ? { keyId } : {}), message: MESSAGES[rule] });
  };
  const exposure = (rel: string): { sev: Sev; served: boolean } => {
    const s = servedRaw(rel, docroot, engine);
    return { sev: s ? 'critical' : 'warn', served: s };
  };
  /** Exposure of a file shipped with third-party code or tests (dumps, backups): warn at most. */
  const shippedExposure = (rel: string): { sev: Sev; served: boolean } => {
    const e = exposure(rel);
    return FIXTURE_DIR_RE.test(rel) || THIRD_PARTY_DIR_RE.test(rel) ? { sev: 'warn', served: e.served } : e;
  };

  const files = input.entries.filter((e) => e.type === 'file');
  const sizeOf = new Map(files.map((f) => [f.path, f.size]));

  // Content budget, shared by every read below.
  const started = now();
  let readBytes = 0;
  let readFiles = 0;
  let skipped = 0;
  const outOfBudget = () => readFiles >= budget.files || readBytes >= budget.bytes || now() - started > budget.ms;
  const readText = async (rel: string, max = budget.fileBytes): Promise<string | null> => {
    const size = sizeOf.get(rel) ?? 0;
    if (size > budget.maxFileSize || outOfBudget()) { skipped++; return null; }
    const want = Math.min(max, budget.fileBytes, Math.max(0, budget.bytes - readBytes));
    let buf: Buffer | null = null;
    try { buf = await input.read(rel, want); } catch { buf = null; }
    readFiles++;
    if (!buf) { skipped++; return null; }
    readBytes += buf.length;
    if (buf.subarray(0, 8000).includes(0)) return null; // binary
    return buf.toString('utf8');
  };
  const contentDone = new Map<string, string | null>();
  const textOf = async (rel: string): Promise<string | null> => {
    if (!contentDone.has(rel)) contentDone.set(rel, await readText(rel));
    return contentDone.get(rel) ?? null;
  };

  // ── 1. rules on the file itself (whole tree) ──
  const vcsReported = new Set<string>();
  for (const f of files) {
    const rel = f.path;
    const b = baseOf(rel);
    const segs = segmentsOf(rel);

    const vcsIdx = segs.slice(0, -1).findIndex((s) => VCS_DIRS.has(s));
    if (vcsIdx >= 0) {
      const dir = `${segs.slice(0, vcsIdx + 1).join('/')}/`;
      if (!vcsReported.has(dir)) {
        vcsReported.add(dir);
        const e = exposure(`${dir}x`);
        add(dir, 'expose.vcs', e.sev, e.served);
      }
      continue;
    }
    // (.git itself never reaches a release: git does not track it, nested repositories are excluded.)

    if (DUMP_EXT_RE.test(b)) {
      const e = shippedExposure(rel);
      if (DUMP_PLAIN_RE.test(b)) {
        // A schema (install.sql of a plugin) is no leak: only a dump WITH data is.
        const text = await textOf(rel);
        if (text === null) add(rel, 'expose.dump', e.sev, e.served);
        else {
          const m = DUMP_DATA_RE.exec(text);
          if (m) add(rel, 'expose.dump', e.sev, e.served, lineAt(text, m.index + (m[0].length - m[0].trimStart().length)));
        }
      } else add(rel, 'expose.dump', e.sev, e.served);
      continue;
    }

    if (BACKUP_SUFFIX_RE.test(b) && !/\.dist$/i.test(b)) {
      const stem = b.replace(BACKUP_SUFFIX_RE, '');
      if (SOURCE_EXT_RE.test(stem) || ENV_NAME_RE.test(stem)) {
        const e = shippedExposure(rel);
        add(rel, 'expose.config-backup', e.sev === 'critical' && CONFIG_NAME_RE.test(stem) ? 'critical' : 'warn', e.served);
        continue;
      }
    }

    if (ARCHIVE_EXT_RE.test(b) && (BACKUP_TOOL_EXT_RE.test(b) || /\.bak$/i.test(b) || BACKUP_NAME_RE.test(b.replace(ARCHIVE_EXT_RE, '')))) {
      const e = shippedExposure(rel);
      add(rel, 'expose.backup-archive', e.sev, e.served);
      continue;
    }

    if (KEY_FILE_NAMES.has(b) || /^id_(rsa|dsa|ecdsa|ed25519)[\w-]*$/.test(b) || KEY_FILE_EXT_RE.test(b)
      || (b === 'credentials' && segs[segs.length - 2] === '.aws')) {
      const e = exposure(rel);
      add(rel, 'secret.key-file', e.sev, e.served);
      continue;
    }

    if (DB_TOOL_NAME_RE.test(b) || PHPMYADMIN_RE.test(rel)) {
      const r = reachable(rel, docroot, engine);
      add(PHPMYADMIN_RE.test(rel) ? rel.replace(/index\.php$/i, '') : rel, 'expose.db-tool', r ? 'critical' : 'warn', r);
      continue;
    }

    if (PHPINFO_NAMES.has(b.toLowerCase()) && f.size <= PHPINFO_MAX_SIZE) {
      const text = await textOf(rel);
      const m = text ? PHPINFO_RE.exec(text) : null;
      if (m && text) {
        const r = reachable(rel, docroot, engine);
        add(rel, 'expose.diagnostic', r ? 'critical' : 'warn', r, lineAt(text, m.index));
      }
    }

    if (LOG_NAME_RE.test(b) && servedRaw(rel, docroot, engine)) {
      add(rel, 'expose.log', 'warn', true);
    }
  }

  // ── 2. rules on the content (changed files, by priority, within the budget) ──
  const toRead = files
    .filter((f) => (input.contentPaths ? input.contentPaths.has(f.path) : true) && !NO_CONTENT_EXT_RE.test(baseOf(f.path)))
    .sort((a, b) => contentPriority(a.path, docroot, engine) - contentPriority(b.path, docroot, engine) || a.size - b.size);
  let scanned = 0;
  for (const f of toRead) {
    const rel = f.path;
    const text = await textOf(rel);
    if (text === null) continue;
    scanned++;
    const b = baseOf(rel);
    const raw = servedRaw(rel, docroot, engine);
    const fixture = FIXTURE_DIR_RE.test(rel);

    let n = 0;
    for (const m of text.matchAll(PANEL_TOKEN_RE)) {
      if (n++ >= PER_RULE_PER_FILE) break;
      add(rel, 'secret.panel-token', 'critical', raw, lineAt(text, m.index ?? 0), m[1] === 'k' ? Number(m[2]) : null);
    }
    n = 0;
    for (const m of text.matchAll(PRIVATE_KEY_RE)) {
      if (n++ >= PER_RULE_PER_FILE) break;
      const encrypted = m[0].includes('ENCRYPTED');
      // Same exposure rule as every secret: critical only when handed out as is
      // (a key outside the document root, or in PHP code, is reported, not blocking).
      add(rel, 'secret.private-key', raw && !fixture && !encrypted ? 'critical' : 'warn', raw, lineAt(text, m.index ?? 0));
    }
    n = 0;
    for (const { re, browser } of CLOUD_RES) {
      for (const m of text.matchAll(re)) {
        if (EXAMPLE_TOKEN_RE.test(m[0])) continue;
        if (n++ >= PER_RULE_PER_FILE) break;
        add(rel, 'secret.cloud', raw && !fixture && !browser ? 'critical' : 'warn', raw, lineAt(text, m.index ?? 0));
      }
    }
    if (ENV_NAME_RE.test(b) && !ENV_TEMPLATE_RE.test(b)) {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
        const mm = ENV_LINE_RE.exec(line);
        if (!mm || !ENV_SECRET_KEY_RE.test(mm[1])) continue;
        const value = stripEnvComment(mm[2]).trim().replace(/^(['"])(.*)\1$/, '$2').trim();
        if (ENV_PLACEHOLDER_RE.test(value)) continue;
        add(rel, 'secret.env-file', raw ? 'critical' : 'warn', raw, i + 1);
        break; // one line per file: the file is the problem
      }
    }
    const keyFileContent = (re: RegExp) => {
      const m = re.exec(text);
      if (m) add(rel, 'secret.key-file', raw ? 'critical' : 'warn', raw, lineAt(text, m.index));
    };
    if (b === '.npmrc') keyFileContent(NPM_TOKEN_RE);
    else if (b === 'auth.json') keyFileContent(COMPOSER_AUTH_RE);
    else if (b === '.pypirc') keyFileContent(PYPIRC_RE);

    if (PHP_EXT_RE.test(b)) {
      const r = reachable(rel, docroot, engine);
      if (f.size <= PHPINFO_MAX_SIZE && !PHPINFO_NAMES.has(b.toLowerCase())) {
        const m = PHPINFO_RE.exec(text);
        if (m) add(rel, 'expose.diagnostic', r ? 'critical' : 'warn', r, lineAt(text, m.index));
      }
      if (!DB_TOOL_NAME_RE.test(b) && DB_TOOL_CONTENT_RE.test(text.slice(0, 64 * 1024))) {
        add(rel, 'expose.db-tool', r ? 'critical' : 'warn', r);
      }
    }
  }
  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1)
    || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));
  const critical = findings.filter((f) => f.severity === 'critical').length;
  return {
    policy: input.policy,
    blocked: input.policy === 'block' && critical > 0,
    critical,
    warn: findings.length - critical,
    findings: findings.slice(0, LEAK_FINDINGS_MAX),
    allowlisted,
    contentScanned: scanned,
    contentSkipped: skipped,
  };
}
