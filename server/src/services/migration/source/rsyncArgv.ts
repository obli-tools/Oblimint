import path from 'path';
import type { RsyncPreset, RsyncPullRequest } from '../contracts/source';
import { assertCleanPath, checkDomain, PathPolicyError } from './pathPolicy';

// ─────────────────────────────────────────────────────────────────────────────
// rsync argv of the pulls (docs/P5-PLAN.md §5.6, MG6) — PURE.
//
//  - validateRsyncRequest: what the caller may ask (remote dir under
//    /home/<acct>/… or /var/vmail/<domain>/<local>…, local dir under the data
//    dir, never uid / gid 0 nor < 1000, plain exclude patterns);
//  - buildLocalRsyncArgv: the LOCAL receiver's argv per preset;
//  - validateRsyncServerArgv: what the local rsync asks the remote shell (the
//    shim forwards it) — accepted only when it is exactly
//      [host, 'rsync', '--server', '--sender', <allowed options…>, '.', '<remotePath>/']
//    then re-rendered by the `rsync.sender` template (templates.ts).
//
// Server argv expected for our presets (the CLIENT — the panel image — builds
// it, the remote version does not matter; to be CONFIRMED on the Linux test host, risk
// R-MIG-RSYNC-VERSION):
//   rsync 3.1.x  : rsync --server --sender -ltre.iLsfxC . /home/acct1/public_html/
//   rsync 3.2.0-3: rsync --server --sender -ltre.iLsfxCIvu . /home/acct1/public_html/
//   rsync 3.2.4+ / 3.3 (Alpine): same as 3.2 (args escaped for the remote shell:
//                  no-op for our charset, see REMOTE_PATH_RE)
//   + `n` in the cluster with dryRun (-nltre.…), `--bwlimit=<n>` when a limit is set,
//   `--safe-links` / `--log-format=…` if a version forwards them (accepted, harmless for a sender).
// Short cluster = '-' + transfer letters (l t r, n dry-run, v verbose) + optional
// 'e.' + capability letters (i L s f x C I v u). Letters for owner / group / perms /
// devices / hard links / ACLs / xattrs / compression / backups / sparse… are refused:
// our presets never ask for them, so seeing one means the argv is not ours.
// ─────────────────────────────────────────────────────────────────────────────

export const RSYNC_HOST = 'oblimint-source';
export const MIN_TRANSFER_ID = 1000;
export const MAX_EXCLUDES = 100;

export class RsyncRequestError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'RsyncRequestError';
  }
}

/** Remote paths: a charset that rsync 3.2.4+ arg-escaping leaves untouched. */
const REMOTE_PATH_RE = /^\/[A-Za-z0-9._@+/-]+$/;
const HOME_RE = /^\/home\/[A-Za-z0-9_][A-Za-z0-9._-]*\/[^/]/;
const VMAIL_RE = /^\/var\/vmail\/([^/]+)\/[A-Za-z0-9._+-]+(\/|$)/;
/** The home itself: only for a SELECTIVE site copy (includes + the '/*' catch-all, never a hidden entry). */
const HOME_ROOT_RE = /^\/home\/[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const EXCLUDE_RE = /^[A-Za-z0-9._*?/@+-]{1,255}$/;

export interface ValidatedRsyncRequest {
  remotePath: string;
  localPath: string;
  uid: number;
  gid: number;
  preset: RsyncPreset;
  excludes: string[];
  /** Rendered before the excludes (selective copy). */
  includes: string[];
  deleteExtraneous: boolean;
  dryRun: boolean;
  bwLimitKbps: number;
  /** CWP user the remote sender runs as (site presets), null = root behind the MG10 guard (maildir). */
  runAs: string | null;
}

function checkId(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v === 0 || v < MIN_TRANSFER_ID || v > 0x7fffffff) {
    throw new RsyncRequestError(`${what}: must be an integer ≥ ${MIN_TRANSFER_ID} (never root)`);
  }
  return v;
}

/** Remote directory of a pull (MG10 realpath check is done on the source by rsync.ts). */
export function checkRemotePath(p: unknown, allowHomeRoot = false): string {
  try {
    assertCleanPath(p, 'remotePath');
  } catch (err) {
    throw new RsyncRequestError((err as PathPolicyError).reason);
  }
  if (!REMOTE_PATH_RE.test(p)) throw new RsyncRequestError('remotePath: characters outside [A-Za-z0-9._@+/-]');
  const segs = p.split('/');
  if (segs.some((s) => s === '.ssh')) throw new RsyncRequestError('remotePath: .ssh is never pulled');
  if (HOME_RE.test(p)) return p;
  if (allowHomeRoot && HOME_ROOT_RE.test(p)) return p;
  const m = VMAIL_RE.exec(p);
  if (m) {
    try { checkDomain(m[1]); } catch { throw new RsyncRequestError('remotePath: invalid mail domain'); }
    return p;
  }
  throw new RsyncRequestError('remotePath: must be under /home/<account>/ or /var/vmail/<domain>/<local>/');
}

/** Local destination: absolute, normalized, strictly under the data dir. */
export function checkLocalPath(p: unknown, dataRoot: string): string {
  if (typeof p !== 'string' || !p) throw new RsyncRequestError('localPath: empty');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) throw new RsyncRequestError('localPath: control character');
  // Production is Linux; a Windows dev box / test run uses 'C:/…' roots (forward slashes only).
  const stripDrive = (s: string) => (process.platform === 'win32' ? s.replace(/^[A-Za-z]:(?=\/)/, '') : s);
  const q = stripDrive(p);
  if (!path.posix.isAbsolute(q) || path.posix.normalize(q) !== q || q.endsWith('/') || p.includes('\\')) {
    throw new RsyncRequestError('localPath: not an absolute normalized path');
  }
  const root = dataRoot.replace(/\/+$/, '');
  if (!p.startsWith(`${root}/`)) throw new RsyncRequestError('localPath: outside the data directory');
  return p;
}

const CWP_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const MAIL_LOCAL_RE = /^[A-Za-z0-9._+-]{1,64}$/;

/**
 * §5.3 / MG6: both paths belong to the transfer's owner (checked HERE, not only by the caller).
 * Returns the CWP user the remote sender runs as (site presets), null for a maildir.
 */
export function checkBinding(req: RsyncPullRequest, remotePath: string, localPath: string, dataRoot: string): string | null {
  const b = req.binding as RsyncPullRequest['binding'] | undefined;
  if (!b || typeof b !== 'object') throw new RsyncRequestError('binding: missing (account or mailbox of the transfer)');
  const root = dataRoot.replace(/\/+$/, '');
  if (b.kind === 'account') {
    if (req.preset === 'maildir') throw new RsyncRequestError('binding: a maildir is bound to a mailbox');
    if (typeof b.cwpUsername !== 'string' || !CWP_USER_RE.test(b.cwpUsername) || b.cwpUsername === '.' || b.cwpUsername === '..') {
      throw new RsyncRequestError('binding: invalid CWP user');
    }
    if (!Number.isInteger(b.targetAccountId) || b.targetAccountId <= 0) throw new RsyncRequestError('binding: invalid target account');
    if (!remotePath.startsWith(`/home/${b.cwpUsername}/`) && remotePath !== `/home/${b.cwpUsername}`) {
      throw new RsyncRequestError("remotePath: not under the transfer account's home");
    }
    const acct = `${root}/accounts/${b.targetAccountId}`;
    const sub = req.preset === 'site-files' ? 'staging' : 'data';
    if (!localPath.startsWith(`${acct}/${sub}/`)) throw new RsyncRequestError(`localPath: not under the target account's ${sub}/`);
    return b.cwpUsername;
  }
  if (b.kind === 'mailbox') {
    if (req.preset !== 'maildir') throw new RsyncRequestError('binding: a mailbox binding is for the maildir preset');
    const addr = typeof b.address === 'string' ? b.address.toLowerCase() : '';
    const at = addr.lastIndexOf('@');
    const local = at > 0 ? addr.slice(0, at) : '';
    const domain = at > 0 ? addr.slice(at + 1) : '';
    try { checkDomain(domain); } catch { throw new RsyncRequestError('binding: invalid mailbox address'); }
    if (!MAIL_LOCAL_RE.test(local) || local === '.' || local === '..') throw new RsyncRequestError('binding: invalid mailbox address');
    const box = `/var/vmail/${domain}/${local}`;
    if (remotePath.toLowerCase() !== box && remotePath.toLowerCase() !== `${box}/sieve`) {
      throw new RsyncRequestError("remotePath: not the transfer mailbox's maildir");
    }
    const mailRoot = `${root}/mail/data/`;
    const tail = `/vmail/${domain}/${local}/`;
    const rest = localPath.startsWith(mailRoot) ? localPath.slice(mailRoot.length) : null;
    // <root>/mail/data/<engine>/vmail/<domain>/<local>/…
    if (rest === null || !/^[a-z0-9-]+\//.test(rest) || !`${rest.slice(rest.indexOf('/'))}/`.toLowerCase().startsWith(tail)) {
      throw new RsyncRequestError("localPath: not under the transfer mailbox's directory");
    }
    return null;
  }
  throw new RsyncRequestError('binding: account or mailbox expected');
}

export function validateRsyncRequest(req: RsyncPullRequest, dataRoot: string, defaultBwLimitKbps: number): ValidatedRsyncRequest {
  if (!req || typeof req !== 'object') throw new RsyncRequestError('invalid request');
  // The home itself is pulled only through a selective site copy: kept paths included, everything else at the
  // home level excluded ('/*'), never a hidden entry (.ssh, .bash_history, .conf…) — plan/outside.ts.
  const rawIncludes = Array.isArray(req.includes) ? req.includes : [];
  const selectiveHome = req.preset === 'site-files' && rawIncludes.length > 0 && (req.excludes ?? []).includes('/*')
    && rawIncludes.every((x) => typeof x === 'string' && x.startsWith('/') && !x.split('/').some((seg) => seg.startsWith('.')));
  const remotePath = checkRemotePath(req.remotePath, selectiveHome);
  const localPath = checkLocalPath(req.localPath, dataRoot);
  const uid = checkId(req.uid, 'uid');
  const gid = checkId(req.gid, 'gid');
  if (req.preset !== 'site-files' && req.preset !== 'site-data' && req.preset !== 'maildir') {
    throw new RsyncRequestError('preset: site-files, site-data or maildir expected');
  }
  if (req.preset === 'maildir' && !remotePath.startsWith('/var/vmail/')) throw new RsyncRequestError('preset maildir: remotePath must be under /var/vmail');
  if (req.preset !== 'maildir' && !remotePath.startsWith('/home/')) throw new RsyncRequestError(`preset ${req.preset}: remotePath must be under /home`);
  const runAs = checkBinding(req, remotePath, localPath, dataRoot);
  const excludes = req.excludes ?? [];
  if (!Array.isArray(excludes) || excludes.length > MAX_EXCLUDES) throw new RsyncRequestError(`excludes: at most ${MAX_EXCLUDES}`);
  for (const x of excludes) {
    if (typeof x !== 'string' || !EXCLUDE_RE.test(x) || x.includes('..')) throw new RsyncRequestError(`excludes: invalid pattern`);
  }
  const includes = req.includes ?? [];
  if (!Array.isArray(includes) || includes.length > MAX_EXCLUDES) throw new RsyncRequestError(`includes: at most ${MAX_EXCLUDES}`);
  for (const x of includes) {
    if (typeof x !== 'string' || !EXCLUDE_RE.test(x) || x.includes('..')) throw new RsyncRequestError(`includes: invalid pattern`);
  }
  const bw = req.bwLimitKbps && req.bwLimitKbps > 0 ? req.bwLimitKbps : defaultBwLimitKbps;
  if (!Number.isInteger(bw) || bw < 0 || bw > 10_000_000) throw new RsyncRequestError('bwLimitKbps: integer 0..10000000 expected');
  return {
    remotePath, localPath, uid, gid, preset: req.preset, excludes: [...excludes], includes: [...includes],
    deleteExtraneous: req.deleteExtraneous === true, dryRun: req.dryRun === true, bwLimitKbps: bw, runAs,
  };
}

/** --rsh value: tokens separated by spaces, single-quoted when needed (rsync splits it itself, no shell). */
export function rshCommandLine(parts: string[]): string {
  return parts.map((p) => {
    if (p.includes("'")) throw new RsyncRequestError('rsh: quote in a path');
    return /^[A-Za-z0-9._/:=@+-]+$/.test(p) ? p : `'${p}'`;
  }).join(' ');
}

/**
 * Per-file line of a real pull: fixed tag + file length + name, so progress can
 * sum bytes live and count ONLY these lines (warnings and --stats lines never
 * match). On a pull the local side is the receiver: rsync does not forward the
 * out-format to the remote sender (server_options only does so when am_sender).
 */
export const OUT_FORMAT = 'oblimint:%l:%n';
const OUT_LINE = /^oblimint:(\d+):(.+)$/;

/** Parses one stdout line of a pull: a transferred non-directory entry, or null. */
export function parseOutFormatLine(line: string): { bytes: number; name: string } | null {
  const m = OUT_LINE.exec(line.replace(/\r$/, ''));
  if (!m || m[2].endsWith('/')) return null;
  return { bytes: Number(m[1]), name: m[2] };
}

/**
 * Local receiver argv (§5.6). The destination is `.`: runRsyncPull spawns
 * rsync with cwd = localPath. rsync 3.5.0 (Alpine) resolves an absolute (or
 * `./`) destination component by component with O_RDONLY directory opens
 * (change_dir → open_no_attacker_symlinks_dirfd), which needs READ on every
 * ancestor — hostd's accounts/ and accounts/<id>/ are root:root 0711, so the
 * pull, running as the account uid (MG6), failed with
 * `change_dir#1 … Permission denied (13)` (exit 3). A bare `.` is the one
 * destination change_dir accepts without reopening the path (verified on
 * the Linux test host with rsync 3.5.0: absolute → exit 3, cwd + `.` → exit 0, with
 * --delete / --partial-dir / dry-run too). `--insecure-links` would also
 * work but drops the receiver's symlink-race protections and is unknown to
 * older rsync versions.
 */
export function buildLocalRsyncArgv(v: ValidatedRsyncRequest, rsh: string): string[] {
  const argv: string[] = ['-rlt', '--safe-links', '--no-protect-args'];
  if (v.preset === 'maildir') {
    argv.push('--chmod=D0700,F0600', '--exclude=dovecot.index*', '--exclude=dovecot.list.index*');
  } else {
    argv.push('--no-owner', '--no-group', '--chmod=D0755,F0644', '--partial-dir=.oblimint-partial');
  }
  for (const x of v.includes) argv.push(`--include=${x}`);
  for (const x of v.excludes) argv.push(`--exclude=${x}`);
  if (v.deleteExtraneous) argv.push('--delete');
  if (v.bwLimitKbps > 0) argv.push(`--bwlimit=${v.bwLimitKbps}`);
  if (v.dryRun) argv.push('--dry-run', '--itemize-changes');
  else argv.push(`--out-format=${OUT_FORMAT}`);
  argv.push('--stats', `--rsh=${rsh}`, `${RSYNC_HOST}:${v.remotePath}/`, '.');
  return argv;
}

// ── server argv (what the shim forwards) ────────────────────────────────────

const CLUSTER_RE = /^-([lrtnv]+)(?:e\.([iLsfxCIvu]*))?$/;
const LONG_ALLOWED: readonly RegExp[] = [
  /^--safe-links$/,
  /^--numeric-ids$/,
  /^--bwlimit=\d{1,8}$/,
  /^--log-format=[%A-Za-z0-9]{1,32}$/,
];
const LONG_REFUSED = /^--(remove-source-files|remove-sent-files|delete.*|files-from.*|rsync-path.*|log-file.*|write-batch.*|only-write-batch.*|read-batch.*|temp-dir.*|backup.*|suffix.*|server.*|sender.*|daemon.*|config.*)$/;

/**
 * Validates the argv the local rsync passed to its remote shell. Returns the
 * option tokens for the `rsync.sender` template; throws RsyncRequestError.
 */
export function validateRsyncServerArgv(argv: unknown, remotePath: string): { options: string[]; path: string } {
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) throw new RsyncRequestError('argv: not a string array');
  const a = argv as string[];
  if (a.length < 6 || a.length > 16) throw new RsyncRequestError('argv: unexpected length');
  if (a[0] !== RSYNC_HOST) throw new RsyncRequestError('argv: unexpected host');
  if (a[1] !== 'rsync' || a[2] !== '--server' || a[3] !== '--sender') throw new RsyncRequestError('argv: not `rsync --server --sender`');
  const expectedPath = `${remotePath}/`;
  if (a[a.length - 1] !== expectedPath) throw new RsyncRequestError('argv: path is not the path of this transfer');
  if (a[a.length - 2] !== '.') throw new RsyncRequestError('argv: missing `.` before the path');
  const options = a.slice(4, a.length - 2);
  let cluster = 0;
  for (const o of options) {
    if (o === '-e' || (o.startsWith('-e') && !CLUSTER_RE.test(o)) || o.startsWith('--rsh')) throw new RsyncRequestError('argv: -e (remote shell) refused');
    if (LONG_REFUSED.test(o)) throw new RsyncRequestError(`argv: option ${o.split('=')[0]} refused`);
    const m = CLUSTER_RE.exec(o);
    if (m) {
      cluster++;
      if (!m[1].includes('r')) throw new RsyncRequestError('argv: not a recursive pull');
      if (new Set(m[1]).size !== m[1].length || (m[2] && new Set(m[2]).size !== m[2].length)) {
        throw new RsyncRequestError('argv: repeated option letters');
      }
      continue;
    }
    if (LONG_ALLOWED.some((re) => re.test(o))) continue;
    throw new RsyncRequestError(`argv: option ${o.split('=')[0].slice(0, 40)} not allowed`);
  }
  if (cluster !== 1) throw new RsyncRequestError('argv: exactly one short option cluster expected');
  return { options, path: expectedPath };
}

// ── output parsing ──────────────────────────────────────────────────────────

const num = (s: string) => Number(s.replace(/[,.\s]/g, ''));

export interface RsyncStats {
  files: number;
  bytes: number;
  deleted: number;
}

/** --stats (3.1+: thousands separators). Missing lines = 0. */
export function parseRsyncStats(stdout: string): RsyncStats {
  const get = (re: RegExp) => {
    const m = re.exec(stdout);
    return m ? num(m[1]) : 0;
  };
  return {
    files: get(/^Number of regular files transferred:\s*([\d,.]+)/m),
    bytes: get(/^Total transferred file size:\s*([\d,.]+)/m),
    deleted: get(/^Number of deleted files:\s*([\d,.]+)/m),
  };
}

/** Itemized lines of a dry run: files to transfer and deletions. */
export function parseItemized(stdout: string): { files: number; deleted: number } {
  let files = 0;
  let deleted = 0;
  for (const line of stdout.split('\n')) {
    if (/^\*deleting\s/.test(line)) deleted++;
    else if (/^[<>ch.][fdLDS][.+?a-zA-Z]{9,10} /.test(line) && line[1] === 'f') files++;
  }
  return { files, deleted };
}

/** Cap of the deletion names a dry run reports (RsyncPullResult.deletions). */
export const MAX_DRY_RUN_DELETIONS = 10_000;

/** One itemized dry-run line: the receiver path --delete would remove, else null. */
export function parseDeletionLine(line: string): string | null {
  const m = /^\*deleting\s+(.+?)\r?$/.exec(line);
  return m && !m[1].endsWith('/') ? m[1] : null;
}

/** Symlinks dropped by --safe-links (receiver stderr), relative paths. */
export function parseUnsafeLinks(stderr: string): string[] {
  const out: string[] = [];
  for (const line of stderr.split('\n')) {
    const m = /ignoring unsafe symlink "?([^"]+?)"? -> /.exec(line);
    if (m && out.length < 1000) out.push(m[1].replace(/^\/+/, ''));
  }
  return out;
}
