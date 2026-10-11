import type { MigrationCommandPhase, MigrationCommandTemplateInfo } from '@oblimint/shared';
import {
  SourceCommandRefusedError, type CommandTemplateArgs, type CommandTemplateId,
} from '../contracts/source';
import {
  PathPolicyError, checkDepth, checkDumpDatabase, checkDkimSelector, checkDomain, checkFindName, checkFtpLogin, checkMysqlUser,
  checkReadPath, checkUnitFilePath, checkZoneFilePath, needsSymlinkGuard, assertCleanPath,
} from './pathPolicy';
import { SqlGuardError, checkSql } from './sqlGuard';

// ─────────────────────────────────────────────────────────────────────────────
// CLOSED template registry of the read-only executor (docs/P5-PLAN.md §5.2) —
// PURE (validation + rendering, no I/O).
//
// Rendering is deterministic (snapshot-tested): every command starts with
// `LC_ALL=C `; every caller-provided value is validated FIRST then rendered
// single-quoted (`'` → `'\''`); fixed flags are literal. Compound commands
// (loops, guards, pipes) are a CONSTANT `sh -c '<script>'` whose arguments
// are passed positionally (`oblimint '<arg>'…`): no caller value is ever
// spliced into a script. With source.use_sudo the whole rendering is wrapped
// as `sudo -n -- sh -c '<rendered>'` (renderForSource).
//
// MG10: any access below /home or /var/vmail goes through GUARD_SCRIPT: the
// path must equal its `realpath -e` on the source, otherwise the command exits
// SYMLINK_EXIT without running (refused 'symlinkPath'); a missing path runs the
// command normally (its own "no such file" error). fs.catMany / fs.lineCount
// treat such a file as missing; fs.stat / fs.du (which do not follow the last
// component) skip a path whose PARENT is not its realpath. Residual risk (documented): a client can still
// swap a path between the check and the read (TOCTOU); the window is a few
// milliseconds, the read is still bounded by the deny list and the allow-list.
//
// No template writes, deletes, locks or restarts anything (MG1). The internal
// templates (`fs.realpath`, `rsync.sender`) are never reachable through run().
// ─────────────────────────────────────────────────────────────────────────────

export type InternalTemplateId = 'fs.realpath' | 'rsync.sender';

export interface InternalTemplateArgs {
  /** realpath -e -- <path> (MG10 check before an rsync pull). */
  'fs.realpath': { path: string };
  /**
   * rsync --server --sender <validated options> . <path>/ (remote side of rsyncPull; options validated by rsyncArgv.ts),
   * always behind the MG10 guard IN THE SAME SHELL, and run as the CWP account `runAs` (runuser) for a /home pull:
   * a directory swapped for a link after the check can then only expose what that user may already read.
   */
  'rsync.sender': { options: string[]; path: string; runAs?: string | null };
}

export type AnyTemplateId = CommandTemplateId | InternalTemplateId;

/** Exit code of the MG10 guard (never used by cat / find / ls / grep / wc themselves). */
export const SYMLINK_EXIT = 86;

export const READ_TIMEOUT_MS = 30_000;
export const WALK_TIMEOUT_MS = 10 * 60_000;
export const DUMP_TIMEOUT_MS = 2 * 3600_000;
export const RSYNC_TIMEOUT_MS = 12 * 3600_000;

/** fs.catMany framing (§5.4 bis). */
export const CAT_MANY_MARKER = '@@OBLIMINT-FILE@@';
export const DEFAULT_MAX_BYTES_PER_FILE = 1024 * 1024;
export const MAX_MAX_BYTES_PER_FILE = 8 * 1024 * 1024;
export const MAX_PATHS_PER_CALL = 200;
const MAX_FS_CAT_BYTES = 64 * 1024 * 1024;

/** POSIX single-quoting: the only way a caller value reaches a command line. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const PREFIX = 'LC_ALL=C ';

/** Constant scripts (no single quote inside: they are single-quoted as a whole). */
export const GUARD_SCRIPT =
  'p=$1; shift; if [ -e "$p" ] || [ -L "$p" ]; then [ "$(realpath -e -- "$p")" = "$p" ] || '
  + `{ echo "oblimint: path crosses a symbolic link" >&2; exit ${SYMLINK_EXIT}; }; fi; exec "$@"`;

export const CAT_MANY_SCRIPT =
  'm=$1; shift; for p do s=-1; if [ -f "$p" ] && [ -r "$p" ]; then case "$p" in '
  + '/home/*|/var/vmail/*) if [ "$(realpath -e -- "$p")" = "$p" ]; then s=$(stat -c %s -- "$p" 2>/dev/null) || s=-1; fi ;; '
  + '*) s=$(stat -L -c %s -- "$p" 2>/dev/null) || s=-1 ;; esac; fi; [ -n "$s" ] || s=-1; '
  + `printf "${CAT_MANY_MARKER} %s %s\\n" "$s" "$p"; `
  + 'if [ "$s" -ge 0 ]; then n=$s; if [ "$n" -gt "$m" ]; then n=$m; fi; '
  + '{ head -c "$n" -- "$p" 2>/dev/null; cat /dev/zero; } | head -c "$n"; fi; printf "\\n"; done';

export const LINE_COUNT_SCRIPT =
  'for p do case "$p" in /home/*|/var/vmail/*) if [ -e "$p" ] || [ -L "$p" ]; then '
  + '[ "$(realpath -e -- "$p")" = "$p" ] || continue; fi ;; esac; wc -l -- "$p" 2>/dev/null; done; exit 0';

/**
 * MG10 for metadata (fs.stat / fs.du): stat and du do not follow the LAST
 * component (a final symlink is reported as a link — discovery wants that),
 * but the kernel follows every intermediate one. Below /home and /var/vmail the
 * PARENT directory must therefore equal its realpath, else the path is skipped
 * (no output line, like a missing path).
 */
const PARENT_GUARD =
  'case "$p" in /home/*|/var/vmail/*) d=${p%/*}; [ "$(realpath -e -- "$d" 2>/dev/null)" = "$d" ] || continue ;; esac; ';
export const STAT_SCRIPT = `for p do ${PARENT_GUARD}stat -c "%n|%F|%s|%u|%g|%a|%Y" -- "$p" 2>/dev/null; done; exit 0`;
export const DU_SCRIPT = `for p do ${PARENT_GUARD}du -sb -- "$p" 2>/dev/null; done; exit 0`;
export const PIPEFAIL_GZIP_SCRIPT = 'set -o pipefail; "$@" | gzip -1c';

/**
 * sys.toolVersions (P6, replaces the rpm query — docs/P6-PLAN.md §17): the CLOSED list of tools discovery
 * reports, each located with `command -v` then asked its own version (first line, ≤ 200 characters, stdin
 * closed). Pure reads: no package manager, no /var/lib/rpm (an rpm query may write its lock / environment
 * files there, MG1). Output, one line per tool, in this order:
 *   <tool>|<absolute path>|<first line of its version output, without '|' / CR>
 *   <tool>|-|                      (not installed / not in PATH)
 * doveconf has no version flag: its line carries `dovecot --version` (same package).
 */
export const VERSION_TOOLS = ['rsync', 'mysqldump', 'mysql', 'named-checkzone', 'postconf', 'doveconf'] as const;
export const TOOL_VERSIONS_SCRIPT =
  'PATH="$PATH:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"; '
  + `for t in ${VERSION_TOOLS.join(' ')}; do p=$(command -v "$t" 2>/dev/null) || p=; `
  + 'case "$p" in /*) ;; *) printf "%s|-|\\n" "$t"; continue ;; esac; '
  + 'case "$t" in '
  + 'named-checkzone) v=$("$p" -v 2>&1 </dev/null | head -n 1) ;; '
  + 'postconf) v=$("$p" -d mail_version 2>/dev/null </dev/null | head -n 1) ;; '
  + 'doveconf) d=$(command -v dovecot 2>/dev/null) || d=; v=; case "$d" in /*) v=$("$d" --version 2>/dev/null </dev/null | head -n 1) ;; esac ;; '
  + '*) v=$("$p" --version 2>&1 </dev/null | head -n 1) ;; '
  + 'esac; '
  + 'printf "%s|%s|%s\\n" "$t" "$p" "$(printf "%s" "$v" | tr -d "|\\r" | cut -c 1-200)"; done; exit 0';

for (const s of [GUARD_SCRIPT, CAT_MANY_SCRIPT, LINE_COUNT_SCRIPT, STAT_SCRIPT, DU_SCRIPT, PIPEFAIL_GZIP_SCRIPT, TOOL_VERSIONS_SCRIPT]) {
  if (s.includes("'")) throw new Error('executor script contains a single quote');
}

const sh = (script: string, args: string[]) => `${PREFIX}sh -c ${shQuote(script)} oblimint ${args.join(' ')}`.trimEnd();

/** Command (argv already rendered) on `path`, behind the MG10 guard when the path is client-writable. */
function onPath(path: string, argv: string[]): string {
  if (needsSymlinkGuard(path)) return sh(GUARD_SCRIPT, [shQuote(path), ...argv]);
  return PREFIX + argv.join(' ');
}

// ── constant SQL (§5.4 bis, NORMATIVE: discovery parses these columns) ─────

export const USER_META_SQL =
  "SELECT User, Host, plugin, CASE "
  + "WHEN Password REGEXP '^[*][0-9A-Fa-f]{40}$' OR authentication_string REGEXP '^[*][0-9A-Fa-f]{40}$' THEN 'native' "
  + "WHEN LENGTH(Password) = 16 THEN 'old-password' "
  + "WHEN COALESCE(Password, '') = '' AND COALESCE(authentication_string, '') = '' THEN 'none' "
  + "ELSE 'other' END AS hash_kind, max_user_connections FROM mysql.user ORDER BY User, Host";

export const MAILBOX_META_SQL =
  "SELECT username, local_part, domain, maildir, quota, uid, gid, active, name, CASE "
  + "WHEN COALESCE(password, '') = '' THEN '' "
  + "WHEN password REGEXP '^[{](SHA512-CRYPT|SHA256-CRYPT|MD5-CRYPT|BLF-CRYPT|SSHA512|SSHA256|SSHA)[}]' "
  + "THEN UPPER(SUBSTRING_INDEX(SUBSTRING(password, 2), '}', 1)) "
  + "WHEN password LIKE '$6$%' THEN 'SHA512-CRYPT*' "
  + "WHEN password LIKE '$5$%' THEN 'SHA256-CRYPT*' "
  + "WHEN password LIKE '$1$%' THEN 'MD5-CRYPT*' "
  + "WHEN password REGEXP '^[$]2[abxy]?[$]' THEN 'BLF-CRYPT*' "
  + "ELSE 'other' END AS scheme FROM postfix.mailbox ORDER BY username";

/** login:uid:gid:dir:scheme — the hash field ($2) is only classified, never printed. */
export const FTP_LIST_AWK =
  'NF >= 6 { h = $2; s = "other"; '
  + 'if (h ~ /^\\$2a\\$/) s = "2a"; else if (h ~ /^\\$2b\\$/) s = "2b"; else if (h ~ /^\\$2y\\$/) s = "2y"; '
  + 'else if (h ~ /^\\$6\\$/) s = "6"; else if (h ~ /^\\$5\\$/) s = "5"; else if (h ~ /^\\$1\\$/) s = "1"; '
  + 'print $1 ":" $3 ":" $4 ":" $6 ":" s }';

/** fs.grepRefs: depth, pruned directories, code files read (never wp-config.php / .env*). */
export const REFS_DEPTH = 6;
export const MAX_REF_NAMES = 64;
const REF_NAME_RE = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]{0,99}$/;
const REF_HOME_RE = /^\/home\/[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const REFS_PRUNE = ['vendor', 'node_modules', '.git'];
const REFS_CODE = ['*.php', '*.inc', '*.phtml', '*.ini', '*.py', '*.pl', '*.cgi', '*.sh', '.htaccess', '.user.ini'];
const reEscape = (v: string) => v.replace(/[.+]/g, (c) => `\\${c}`);

/**
 * ERE of fs.grepRefs: a name preceded by a slash and followed by a path delimiter (/../private_html/,
 * /../config.php'), or quoted and followed by a slash ('private_html/), plus /home/<user>/ when given.
 * A bare quoted word ('Save') never matches.
 */
export function refsRegex(names: string[], home?: string): string {
  const alt = names.map(reEscape).join('|');
  const parts = names.length ? [`/(${alt})([/'"]|$)`, `['"](${alt})/`] : [];
  if (home) parts.push(`${reEscape(home)}/`);
  return parts.join('|');
}

const HTACCESS_GREP = '^[[:space:]]*(AddHandler|SetHandler|AddType)[[:space:]].*php';
const FIND_PRINTF = '%y|%m|%u|%g|%s|%T@|%p|%l\\n';
const NAMED_SED = 's/(secret[[:space:]]+)"[^"]*"/\\1"<redacted>"/g';
const UNIT_SED = 's/^([[:space:]]*Environment[[:space:]]*=).*/\\1<redacted>/';
const PUREFTPD_PASSWD = '/etc/pure-ftpd/pureftpd.passwd';

// ── registry ────────────────────────────────────────────────────────────────

export interface TemplateSpec {
  id: AnyTemplateId;
  phases: readonly MigrationCommandPhase[];
  /** Output never stored / logged anywhere, errors generic. */
  sensitive: boolean;
  timeoutMs: number;
  /** Never reachable through run() / stream(). */
  internal: boolean;
  /** Validates the arguments (throws PathPolicyError / SqlGuardError / Error) and renders the command. */
  render(args: unknown): string;
}

const BOTH: readonly MigrationCommandPhase[] = ['discovery', 'transfer'];
const TRANSFER: readonly MigrationCommandPhase[] = ['transfer'];

class ArgError extends Error {}

function obj(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new ArgError('arguments must be an object');
  return args as Record<string, unknown>;
}

function noArgs(args: unknown): void {
  const o = obj(args);
  if (Object.keys(o).length > 0) throw new ArgError('this template takes no argument');
}

function onlyKeys(o: Record<string, unknown>, allowed: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new ArgError(`unknown argument ${k}`);
}

function strList(v: unknown, what: string, max: number): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new ArgError(`${what}: non-empty array expected`);
  if (v.length > max) throw new ArgError(`${what}: at most ${max} entries`);
  return v as string[];
}

function optInt(v: unknown, what: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ArgError(`${what}: integer ${min}..${max} expected`);
  return v;
}

const constant = (id: CommandTemplateId, command: string, timeoutMs = READ_TIMEOUT_MS): TemplateSpec => ({
  id, phases: BOTH, sensitive: false, timeoutMs, internal: false,
  render: (args) => { noArgs(args); return PREFIX + command; },
});

const SPECS: TemplateSpec[] = [
  // ── system ──
  constant('sys.osRelease', 'cat /etc/os-release /etc/redhat-release'),
  constant('sys.hostname', 'hostname -f'),
  constant('sys.ipAddrs', 'ip -o addr show'),
  constant('sys.whoami', 'id -un'),
  constant('sys.passwd', 'getent passwd'),
  constant('sys.toolVersions', `sh -c ${shQuote(TOOL_VERSIONS_SCRIPT)}`),
  {
    id: 'sys.unitFile', phases: BOTH, sensitive: false, timeoutMs: READ_TIMEOUT_MS, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['path']);
      const p = checkUnitFilePath(o.path);
      return `${PREFIX}sed -E ${shQuote(UNIT_SED)} -- ${shQuote(p)}`;
    },
  },
  // ── files ──
  {
    id: 'fs.cat', phases: BOTH, sensitive: false, timeoutMs: READ_TIMEOUT_MS, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['path', 'maxBytes']);
      const p = checkReadPath(o.path, 'content');
      const max = optInt(o.maxBytes, 'maxBytes', 1, MAX_FS_CAT_BYTES);
      const argv = max === undefined ? ['cat', '--', shQuote(p)] : ['head', '-c', String(max), '--', shQuote(p)];
      return onPath(p, argv);
    },
  },
  {
    id: 'fs.catMany', phases: BOTH, sensitive: false, timeoutMs: READ_TIMEOUT_MS * 4, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['paths', 'maxBytesPerFile']);
      const paths = strList(o.paths, 'paths', MAX_PATHS_PER_CALL).map((p, i) => checkReadPath(p, 'content', `paths[${i}]`));
      const max = optInt(o.maxBytesPerFile, 'maxBytesPerFile', 0, MAX_MAX_BYTES_PER_FILE) ?? DEFAULT_MAX_BYTES_PER_FILE;
      return sh(CAT_MANY_SCRIPT, [String(max), ...paths.map(shQuote)]);
    },
  },
  {
    id: 'fs.ls', phases: BOTH, sensitive: false, timeoutMs: READ_TIMEOUT_MS, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['path']);
      const p = checkReadPath(o.path, 'list');
      return onPath(p, ['ls', '-la', '--time-style=+%s', '--', shQuote(p)]);
    },
  },
  {
    id: 'fs.stat', phases: BOTH, sensitive: false, timeoutMs: READ_TIMEOUT_MS, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['paths']);
      const paths = strList(o.paths, 'paths', MAX_PATHS_PER_CALL).map((p, i) => checkReadPath(p, 'stat', `paths[${i}]`));
      return sh(STAT_SCRIPT, paths.map(shQuote));
    },
  },
  {
    id: 'fs.find', phases: BOTH, sensitive: false, timeoutMs: WALK_TIMEOUT_MS, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['path', 'maxDepth', 'type', 'name']);
      const p = checkReadPath(o.path, 'list');
      const depth = checkDepth(o.maxDepth);
      const argv = ['find', '-P', shQuote(p), '-maxdepth', String(depth)];
      if (o.type !== undefined && o.type !== null) {
        if (o.type !== 'f' && o.type !== 'd' && o.type !== 'l') throw new ArgError('type: f, d or l expected');
        argv.push('-type', o.type);
      }
      if (o.name !== undefined && o.name !== null) argv.push('-name', shQuote(checkFindName(o.name)));
      argv.push('-printf', shQuote(FIND_PRINTF));
      return onPath(p, argv);
    },
  },
  {
    id: 'fs.du', phases: BOTH, sensitive: false, timeoutMs: WALK_TIMEOUT_MS, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['paths']);
      const paths = strList(o.paths, 'paths', MAX_PATHS_PER_CALL).map((p, i) => checkReadPath(p, 'du', `paths[${i}]`));
      return sh(DU_SCRIPT, paths.map(shQuote));
    },
  },
  {
    id: 'fs.lineCount', phases: BOTH, sensitive: false, timeoutMs: READ_TIMEOUT_MS, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['paths']);
      const paths = strList(o.paths, 'paths', MAX_PATHS_PER_CALL).map((p, i) => checkReadPath(p, 'lineCount', `paths[${i}]`));
      return sh(LINE_COUNT_SCRIPT, paths.map(shQuote));
    },
  },
  {
    id: 'fs.grepHtaccess', phases: BOTH, sensitive: false, timeoutMs: WALK_TIMEOUT_MS, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['root', 'maxDepth']);
      const root = checkReadPath(o.root, 'htaccess', 'root');
      const depth = checkDepth(o.maxDepth);
      return onPath(root, [
        'find', '-P', shQuote(root), '-maxdepth', String(depth), '-name', '.htaccess', '-type', 'f', '-size', '-1024k',
        '-exec', 'grep', '-HinE', shQuote(HTACCESS_GREP), "'{}'", '+',
      ]);
    },
  },
  {
    id: 'fs.grepRefs', phases: BOTH, sensitive: false, timeoutMs: WALK_TIMEOUT_MS, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['root', 'names', 'home']);
      const root = checkReadPath(o.root, 'refs', 'root');
      // [] allowed: only the absolute /home/<user>/ paths are looked for then (home required below).
      const names = Array.isArray(o.names) && o.names.length === 0 ? [] as string[] : strList(o.names, 'names', MAX_REF_NAMES);
      for (const n of names) if (!REF_NAME_RE.test(n)) throw new ArgError('names: invalid name');
      let home: string | undefined;
      if (o.home !== undefined && o.home !== null) {
        if (typeof o.home !== 'string' || !REF_HOME_RE.test(o.home)) throw new ArgError('home: /home/<user> expected');
        home = o.home;
      }
      if (names.length === 0 && !home) throw new ArgError('names: at least one name (or home) expected');
      const prune = REFS_PRUNE.flatMap((n, i) => [...(i ? ['-o'] : []), '-name', shQuote(n)]);
      const code = REFS_CODE.flatMap((n, i) => [...(i ? ['-o'] : []), '-name', shQuote(n)]);
      return onPath(root, [
        'find', '-P', shQuote(root), '-maxdepth', String(REFS_DEPTH), shQuote('('), ...prune, shQuote(')'), '-prune', '-o',
        '-type', 'f', shQuote('('), ...code, shQuote(')'), '!', '-name', shQuote('wp-config.php'), '!', '-name', shQuote('.env*'),
        '-size', '-1024k', '-exec', 'grep', '-HoE', '--', shQuote(refsRegex(names, home)), "'{}'", '+',
      ]);
    },
  },
  // ── MySQL ──
  {
    id: 'mysql.query', phases: BOTH, sensitive: false, timeoutMs: 2 * 60_000, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['sql', 'header']);
      if (o.header !== undefined && typeof o.header !== 'boolean') throw new ArgError('header: boolean expected');
      const sql = checkSql(o.sql);
      return `${PREFIX}mysql --batch${o.header ? '' : ' --skip-column-names'} -e ${shQuote(sql)}`;
    },
  },
  constant('mysql.userMeta', `mysql --batch -e ${shQuote(USER_META_SQL)}`),
  {
    id: 'mysql.dumpSchema', phases: BOTH, sensitive: false, timeoutMs: DUMP_TIMEOUT_MS, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['database']);
      const dbName = checkDumpDatabase(o.database);
      return `${PREFIX}mysqldump --no-data --skip-lock-tables --single-transaction --skip-dump-date --routines --triggers --events -- ${shQuote(dbName)}`;
    },
  },
  constant('mail.mailboxMeta', `mysql --batch -e ${shQuote(MAILBOX_META_SQL)}`),
  constant('mail.postconf', 'postconf -n'),
  constant('mail.doveconf', 'doveconf -n'),
  // ── DNS ──
  constant('dns.namedConf', `sed -E ${shQuote(NAMED_SED)} /etc/named.conf`),
  {
    id: 'dns.zoneDump', phases: BOTH, sensitive: false, timeoutMs: READ_TIMEOUT_MS * 2, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['zone', 'file']);
      const zone = checkDomain(o.zone, 'zone');
      const file = checkZoneFilePath(o.file);
      return `${PREFIX}named-checkzone -j -D -o - ${shQuote(zone)} ${shQuote(file)}`;
    },
  },
  {
    id: 'dns.axfr', phases: BOTH, sensitive: false, timeoutMs: READ_TIMEOUT_MS * 2, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['zone']);
      return `${PREFIX}dig +noall +answer AXFR ${shQuote(checkDomain(o.zone, 'zone'))} @127.0.0.1`;
    },
  },
  // ── FTP ──
  constant('ftp.listUsers', `awk -F: ${shQuote(FTP_LIST_AWK)} ${PUREFTPD_PASSWD}`),
  // ── transfer only ──
  {
    id: 'mysql.dumpData', phases: TRANSFER, sensitive: false, timeoutMs: DUMP_TIMEOUT_MS, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['database', 'charset', 'gzip', 'consistent']);
      const dbName = checkDumpDatabase(o.database);
      if (o.charset !== 'utf8mb4' && o.charset !== 'latin1' && o.charset !== 'binary') throw new ArgError('charset: utf8mb4, latin1 or binary expected');
      if (typeof o.gzip !== 'boolean') throw new ArgError('gzip: boolean expected');
      if (o.consistent !== undefined && typeof o.consistent !== 'boolean') throw new ArgError('consistent: boolean expected');
      // Read-only either way (--skip-lock-tables: never a LOCK TABLES on the source).
      const snapshot = o.consistent === false ? '' : '--single-transaction ';
      const dump = `mysqldump ${snapshot}--skip-lock-tables --quick --routines --triggers --events --hex-blob --default-character-set=${o.charset} --skip-dump-date -- ${shQuote(dbName)}`;
      return o.gzip ? sh(PIPEFAIL_GZIP_SCRIPT, dump.split(' ')) : PREFIX + dump;
    },
  },
  {
    id: 'secret.mailboxHashes', phases: TRANSFER, sensitive: true, timeoutMs: READ_TIMEOUT_MS, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['domain']);
      const d = checkDomain(o.domain);
      return `${PREFIX}mysql --batch -e ${shQuote(`SELECT username, password FROM postfix.mailbox WHERE domain = '${d}' ORDER BY username`)}`;
    },
  },
  {
    id: 'secret.mysqlUserHashes', phases: TRANSFER, sensitive: true, timeoutMs: READ_TIMEOUT_MS, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['users']);
      const users = [...new Set(strList(o.users, 'users', 200).map(checkMysqlUser))];
      const list = users.map((u) => `'${u}'`).join(', ');
      return `${PREFIX}mysql --batch -e ${shQuote(`SELECT User, Host, plugin, Password, authentication_string FROM mysql.user WHERE User IN (${list}) ORDER BY User, Host`)}`;
    },
  },
  {
    id: 'secret.dkimPrivateKey', phases: TRANSFER, sensitive: true, timeoutMs: READ_TIMEOUT_MS, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['domain', 'selector']);
      const d = checkDomain(o.domain);
      const s = checkDkimSelector(o.selector);
      return `${PREFIX}cat -- ${shQuote(`/etc/opendkim/userkeys/${d}/${s}.private`)}`;
    },
  },
  {
    id: 'secret.certificateKey', phases: TRANSFER, sensitive: true, timeoutMs: READ_TIMEOUT_MS, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['fqdn']);
      const f = checkDomain(o.fqdn, 'fqdn');
      return `${PREFIX}cat -- ${shQuote(`/etc/pki/tls/private/${f}.key`)}`;
    },
  },
  {
    id: 'secret.ftpUserHash', phases: TRANSFER, sensitive: true, timeoutMs: READ_TIMEOUT_MS, internal: false,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['login']);
      const login = checkFtpLogin(o.login);
      return `${PREFIX}awk -F: -v u=${shQuote(login)} ${shQuote('$1 == u { print $2; exit }')} ${PUREFTPD_PASSWD}`;
    },
  },
  // ── internal ──
  {
    id: 'fs.realpath', phases: TRANSFER, sensitive: false, timeoutMs: READ_TIMEOUT_MS, internal: true,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['path']);
      assertCleanPath(o.path);
      return `${PREFIX}realpath -e -- ${shQuote(o.path)}`;
    },
  },
  {
    id: 'rsync.sender', phases: TRANSFER, sensitive: false, timeoutMs: RSYNC_TIMEOUT_MS, internal: true,
    render: (args) => {
      const o = obj(args); onlyKeys(o, ['options', 'path', 'runAs']);
      // Values come from validateRsyncServerArgv / validateRsyncRequest (rsyncArgv.ts) — re-checked here (defense in depth).
      if (!Array.isArray(o.options) || o.options.some((x) => typeof x !== 'string' || !/^-[A-Za-z0-9.=%-]+$/.test(x))) {
        throw new ArgError('options: invalid');
      }
      if (typeof o.path !== 'string' || !/^\/[A-Za-z0-9._@+/-]+\/$/.test(o.path)) throw new ArgError('path: invalid');
      const dir = o.path.replace(/\/+$/, '');
      const rsync = ['rsync', '--server', '--sender', ...(o.options as string[]).map(shQuote), '.', shQuote(o.path)];
      let argv = rsync;
      if (o.runAs !== undefined && o.runAs !== null) {
        if (typeof o.runAs !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(o.runAs) || o.runAs === 'root') throw new ArgError('runAs: invalid');
        // The home itself: selective site copy (rsyncArgv.ts allows it only with includes + the '/*' catch-all).
        if (!dir.startsWith(`/home/${o.runAs}/`) && dir !== `/home/${o.runAs}`) throw new ArgError('runAs: path outside the user home');
        argv = ['runuser', '-u', shQuote(o.runAs), '--', ...rsync];
      } else if (dir.startsWith('/home/')) {
        throw new ArgError('runAs: required for a /home pull');
      }
      // MG10 check and exec in ONE shell: no window between a separate check and the sender start.
      return sh(GUARD_SCRIPT, [shQuote(dir), ...argv]);
    },
  },
];

export const TEMPLATE_REGISTRY: ReadonlyMap<string, TemplateSpec> = new Map(SPECS.map((s) => [s.id, s]));

/** Templates whose stdout may be streamed (contract StreamTemplateId). */
export const STREAM_TEMPLATES: ReadonlySet<string> = new Set(['mysql.dumpData', 'mysql.dumpSchema', 'dns.zoneDump', 'dns.axfr', 'fs.cat']);

/** Wraps a rendering for a non-root source (`sudo -n`: never prompts, fails with sudoFailed). */
export function wrapSudo(rendered: string, useSudo: boolean): string {
  return useSudo ? `sudo -n -- sh -c ${shQuote(rendered)}` : rendered;
}

export type RenderOutcome =
  | { ok: true; spec: TemplateSpec; command: string }
  | { ok: false; spec: TemplateSpec | null; reason: string };

/**
 * Validates + renders `template` for a session of `phase` (no I/O). Never
 * throws: a refusal carries its reason (logged 'refused' by the session).
 * `allowInternal` is only set by the executor itself (rsyncPull).
 */
export function renderCommand(
  template: unknown, args: unknown, phase: MigrationCommandPhase, useSudo: boolean, allowInternal = false,
): RenderOutcome {
  if (typeof template !== 'string' || !TEMPLATE_REGISTRY.has(template)) return { ok: false, spec: null, reason: 'unknown template' };
  const spec = TEMPLATE_REGISTRY.get(template)!;
  if (spec.internal && !allowInternal) return { ok: false, spec, reason: 'internal template' };
  if (!spec.phases.includes(phase)) return { ok: false, spec, reason: `${phase === 'discovery' ? 'transfer-only template in a discovery session' : 'template not allowed in this phase'}` };
  try {
    return { ok: true, spec, command: wrapSudo(spec.render(args), useSudo) };
  } catch (err) {
    if (err instanceof PathPolicyError || err instanceof SqlGuardError || err instanceof ArgError) {
      return { ok: false, spec, reason: err instanceof SqlGuardError ? `sql: ${err.reason}` : err.message };
    }
    return { ok: false, spec, reason: 'invalid arguments' };
  }
}

/** Throwing variant (tests, documentation). */
export function renderOrThrow<T extends CommandTemplateId>(template: T, args: CommandTemplateArgs[T], phase: MigrationCommandPhase = 'transfer', useSudo = false): string {
  const r = renderCommand(template, args, phase, useSudo);
  if (!r.ok) throw new SourceCommandRefusedError(String(template), r.reason);
  return r.command;
}

/** Public allow-list (GET /allowlist): internal templates excluded. Description = i18n key suffix. */
export function templateInfos(): MigrationCommandTemplateInfo[] {
  return SPECS.filter((s) => !s.internal).map((s) => ({
    id: s.id, phases: [...s.phases], sensitive: s.sensitive, description: s.id,
  }));
}
