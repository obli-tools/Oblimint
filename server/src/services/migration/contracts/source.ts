import type { Writable } from 'stream';
import type { MigrationCommandPhase } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT of the read-only executor (docs/P5-PLAN.md §5). ARCHITECT FILE,
// frozen during the phase. Implemented by module `source-executor`
// (services/migration/source/**); consumed by `discovery`, `executor-web-db`,
// `executor-mail-dns` through SourceSession ONLY — no module ever gets a raw
// SSH channel or a free-form command string.
//
// Every remote command is one of the CLOSED templates below. The executor
// validates the arguments (paths, identifiers, SQL guard), renders a fixed
// POSIX command with single-quoted arguments (+ `sudo -n --` when the source
// says so), logs it in migration_command_log (output of `sensitive` templates
// is never logged nor kept), and refuses anything else IN CODE (status
// 'refused', SourceCommandRefusedError). Nothing writes on the source: no
// template creates, modifies, deletes, restarts or locks anything there.
// Internal templates (never callable through run()): `rsync.sender` (remote
// side of rsyncPull) and `fs.realpath` (MG10: no file under /home or
// /var/vmail is read, no directory pulled, when its path crosses a symlink —
// realpath -e must equal the requested path). Output formats of the constant
// templates: docs/P5-PLAN.md §5.4 bis.
// ─────────────────────────────────────────────────────────────────────────────

/** Arguments of every template. A template not listed here does not exist. */
export interface CommandTemplateArgs {
  // ── system (discovery + transfer) ──
  /** cat /etc/os-release /etc/redhat-release */
  'sys.osRelease': Record<string, never>;
  /** hostname -f */
  'sys.hostname': Record<string, never>;
  /** ip -o addr show (addresses of the source) */
  'sys.ipAddrs': Record<string, never>;
  /** id -un (who we are: root expected unless sudo) */
  'sys.whoami': Record<string, never>;
  /** getent passwd (no hash: passwd has none) */
  'sys.passwd': Record<string, never>;
  /**
   * Versions of a CLOSED list of tools (rsync, mysqldump, mysql, named-checkzone, postconf, doveconf): for each,
   * `command -v` then its own version flag, first line only, 200 characters at most. Never rpm / dnf / yum, never
   * /var/lib/rpm (P6: an rpm query is not a pure read, MG1). One line per tool: `<tool>|<path or ->|<version line>`.
   */
  'sys.toolVersions': Record<string, never>;
  /** One systemd unit file with Environment= values redacted ON THE SOURCE (path under /etc/systemd/system, *.service). */
  'sys.unitFile': { path: string };
  // ── files (read roots + deny list of §5.3) ──
  /** cat -- <path> (deny list: shadow, private keys, pureftpd.passwd, .ssh, .my.cnf, wp-config.php…) */
  'fs.cat': { path: string; maxBytes?: number };
  /**
   * Several files in one round trip. Output framing (parsed by session.readFiles):
   * for each path, in order: a header line `@@OBLIMINT-FILE@@ <size|-1> <path>\n`
   * then min(size, maxBytesPerFile) raw bytes then `\n` (-1 = missing / unreadable).
   */
  'fs.catMany': { paths: string[]; maxBytesPerFile?: number };
  /** ls -la --time-style=+%s -- <path> */
  'fs.ls': { path: string };
  /** stat -c '%n|%F|%s|%u|%g|%a|%Y' -- <paths> (missing paths silently absent, exit 0) */
  'fs.stat': { paths: string[] };
  /**
   * find <path> -maxdepth <1..6> [-type f|d|l] [-name <glob>] -printf '%y|%m|%u|%g|%s|%T@|%p|%l\n'
   * glob: [A-Za-z0-9._*?-]{1,64}. Never follows symlinks (-P).
   */
  'fs.find': { path: string; maxDepth: number; type?: 'f' | 'd' | 'l'; name?: string };
  /** du -sb -- <paths> (bytes, missing ignored) */
  'fs.du': { paths: string[] };
  /** wc -l -- <paths> (authorized_keys counting is allowed here, never cat) */
  'fs.lineCount': { paths: string[] };
  /**
   * PHP handler lines of the .htaccess files under a docroot (≤ 6 levels, files < 1 MiB):
   * find <root> -maxdepth N -name .htaccess -type f -size -1024k -exec grep -HinE '^[[:space:]]*(AddHandler|SetHandler|AddType)[[:space:]].*php' {} +
   */
  'fs.grepHtaccess': { root: string; maxDepth: number };
  // ── MySQL / MariaDB (root via /root/.my.cnf) ──
  /**
   * mysql --batch --skip-column-names (header: false) | --batch (header: true) -e <sql>.
   * SQL GUARD: one statement, SELECT / SHOW only, no comment, no INTO, no LOAD_FILE,
   * no SLEEP / BENCHMARK / GET_LOCK, no FOR UPDATE / LOCK IN SHARE MODE, no SET / CALL /
   * HANDLER, no variable assignment, and NEVER the columns password / authentication_string
   * (hashes only flow through the secret.* templates).
   */
  'mysql.query': { sql: string; header?: boolean };
  /** Constant SQL: User, Host, plugin, hash KIND (native / old-password / none / other), max_user_connections — never the hash. */
  'mysql.userMeta': Record<string, never>;
  /** mysqldump --no-data --skip-lock-tables --single-transaction --skip-dump-date --routines --triggers --events -- <db> */
  'mysql.dumpSchema': { database: string };
  /** Constant SQL on postfix.mailbox: every column but password, plus the hash SCHEME computed on the source. */
  'mail.mailboxMeta': Record<string, never>;
  /** postconf -n */
  'mail.postconf': Record<string, never>;
  /** doveconf -n */
  'mail.doveconf': Record<string, never>;
  // ── DNS ──
  /** /etc/named.conf with every `secret "…"` redacted ON THE SOURCE (sed). */
  'dns.namedConf': Record<string, never>;
  /** named-checkzone -j -D -o - <zone> <file>: canonical dump, journal (.jnl) applied, read-only. */
  'dns.zoneDump': { zone: string; file: string };
  /** dig +noall +answer AXFR <zone> @127.0.0.1 (fallback for dynamic zones). */
  'dns.axfr': { zone: string };
  // ── FTP ──
  /** login:uid:gid:dir:scheme of /etc/pure-ftpd/pureftpd.passwd — the hash field is NOT printed (awk on the source). */
  'ftp.listUsers': Record<string, never>;
  // ── transfer only (phase 'transfer') ──
  /** mysqldump --single-transaction --skip-lock-tables --quick --routines --triggers --events --hex-blob --default-character-set=<cs> --skip-dump-date -- <db> [| gzip -1c] */
  /**
   * consistent (default true): --single-transaction (one InnoDB snapshot). false = last resort when a table keeps being
   * re-created during the dump (MariaDB 1412 on every attempt): each table read as it is, still never locked.
   */
  'mysql.dumpData': { database: string; charset: 'utf8mb4' | 'latin1' | 'binary'; gzip: boolean; consistent?: boolean };
  /** SENSITIVE. SELECT username, password FROM postfix.mailbox WHERE domain = '<domain>' */
  'secret.mailboxHashes': { domain: string };
  /** SENSITIVE. SELECT User, Host, plugin, Password, authentication_string FROM mysql.user WHERE User IN (…) */
  'secret.mysqlUserHashes': { users: string[] };
  /** SENSITIVE. cat /etc/opendkim/userkeys/<domain>/<selector>.private */
  'secret.dkimPrivateKey': { domain: string; selector: string };
  /** SENSITIVE. cat /etc/pki/tls/private/<fqdn>.key */
  'secret.certificateKey': { fqdn: string };
  /** SENSITIVE. hash field of one pureftpd.passwd line (exact login match, awk). */
  'secret.ftpUserHash': { login: string };
}

export type CommandTemplateId = keyof CommandTemplateArgs;

/** Templates whose stdout may be streamed (session.stream). */
export type StreamTemplateId = 'mysql.dumpData' | 'mysql.dumpSchema' | 'dns.zoneDump' | 'dns.axfr' | 'fs.cat';

export interface RunOptions {
  timeoutMs?: number;
  /** Buffered stdout cap (default 16 MiB): beyond, the command is killed and the result is truncated. */
  maxBytes?: number;
  /** A non-zero exit resolves instead of throwing SourceCommandError. */
  allowNonZeroExit?: boolean;
  signal?: AbortSignal;
}

export interface StreamOptions {
  stdout: Writable;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with the byte count streamed so far (throttled by the executor). */
  onBytes?: (bytes: number) => void;
}

export interface CommandResult {
  exitCode: number;
  /** '' for stream(). */
  stdout: string;
  /** Capped at 64 KiB. Never logged for sensitive templates. */
  stderr: string;
  truncated: boolean;
  bytesOut: number;
  durationMs: number;
}

export type RsyncPreset = 'site-files' | 'site-data' | 'maildir';

/**
 * Who a transfer is for (docs/P5-PLAN.md §5.3, MG6). The EXECUTOR ties both paths to it, not only the caller:
 *   account  (site-files / site-data): remote under /home/<cwpUsername>/, local under
 *            accounts/<targetAccountId>/staging|data/, and the remote sender runs AS that CWP user
 *            (a folder swapped for a link can only expose what that user may read anyway);
 *   mailbox  (maildir): remote = /var/vmail/<domain>/<local> or …/<local>/sieve, local under the
 *            mail root of that address (…/vmail/<domain>/<local>/).
 */
export type RsyncBinding =
  | { kind: 'account'; cwpUsername: string; targetAccountId: number }
  | { kind: 'mailbox'; address: string };

export interface RsyncPullRequest {
  /** Owner of the transfer: the executor refuses paths that are not this account's / mailbox's. */
  binding: RsyncBinding;
  /** Absolute directory on the source; its CONTENT is copied (trailing slash implied). Under /home/ or /var/vmail/. */
  remotePath: string;
  /** Absolute local destination directory (must exist; written as uid:gid). */
  localPath: string;
  /** The local rsync runs with these ids (never root): it can only write what this uid can. */
  uid: number;
  gid: number;
  preset: RsyncPreset;
  /** rsync exclude patterns, relative ([A-Za-z0-9._*?/@+-], no '..'). */
  excludes?: string[];
  /** --delete (receiver side, inside localPath only). */
  deleteExtraneous?: boolean;
  /** KiB/s, 0 / undefined = settings default. */
  bwLimitKbps?: number;
  /** --dry-run --itemize-changes (estimate a delta). */
  dryRun?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (p: { bytes: number; files: number }) => void;
}

export interface RsyncPullResult {
  exitCode: number;
  files: number;
  bytes: number;
  deleted: number;
  /** Symlinks dropped by --safe-links (absolute / escaping the tree), relative paths. */
  unsafeLinks: string[];
  /** Exit 24 (files vanished during the transfer): accepted, reported. */
  partial: boolean;
  /** Dry run with deleteExtraneous only: receiver paths --delete would remove (relative, capped at MAX_DRY_RUN_DELETIONS). */
  deletions?: string[];
  durationMs: number;
}

export interface SessionContext {
  phase: MigrationCommandPhase;
  /** Exactly one of them for the command log. */
  discoveryId?: number | null;
  runId?: number | null;
  signal?: AbortSignal;
}

/**
 * A read-only session on one source (one SSH connection, several channels).
 * Obtained from sourceExecutor.session(sourceId, ctx). Closed by its owner.
 */
export interface SourceSession {
  readonly sourceId: number;
  readonly phase: MigrationCommandPhase;
  run<T extends CommandTemplateId>(template: T, args: CommandTemplateArgs[T], opts?: RunOptions): Promise<CommandResult>;
  stream<T extends StreamTemplateId>(template: T, args: CommandTemplateArgs[T], opts: StreamOptions): Promise<CommandResult>;
  /** fs.catMany with framing parsed: path → content (UTF-8, null = missing / unreadable / denied). Batches internally. */
  readFiles(paths: string[], opts?: { maxBytesPerFile?: number }): Promise<Map<string, string | null>>;
  /** Pull through the local rsync + tunnel; the remote side is the `rsync --server --sender` template only. */
  rsyncPull(req: RsyncPullRequest): Promise<RsyncPullResult>;
  /** False once the session or its SSH connection is closed (connection lost): the engine then reopens one. Absent = assumed alive. */
  alive?(): boolean;
  close(): Promise<void>;
}

// ── errors (implemented here, thrown by the executor and by the fakes) ──────

export type SourceConnectionErrorCode =
  | 'hostKeyUnpinned' | 'hostKeyMismatch' | 'authFailed' | 'connectFailed' | 'timeout' | 'noSecret' | 'sudoFailed';

/** Connection-level failure (nothing ran). */
export class SourceConnectionError extends Error {
  constructor(public readonly code: SourceConnectionErrorCode, message: string) {
    super(message);
    this.name = 'SourceConnectionError';
  }
}

/** The command is not allowed (unknown template, invalid / denied argument, SQL guard, wrong phase). Logged 'refused'. */
export class SourceCommandRefusedError extends Error {
  readonly code = 'commandRefused';
  constructor(public readonly template: string, public readonly reason: string) {
    super(`Command refused (${template}): ${reason}`);
    this.name = 'SourceCommandRefusedError';
  }
}

/** The command ran and failed (non-zero exit, timeout, output cap). Never carries the output of a sensitive template. */
export class SourceCommandError extends Error {
  readonly code = 'commandFailed';
  constructor(public readonly template: string, public readonly exitCode: number | null, message: string) {
    super(message);
    this.name = 'SourceCommandError';
  }
}
