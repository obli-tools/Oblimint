import fs from 'fs';
import path from 'path';
import { MailDriverError } from '../../driver';
import { isSecretFile, MANAGED_DIRS, MANIFEST_FILE, RSPAMD_GID } from './layout';
import { RSPAMD_WATCHED_MAPS } from './confRspamd';
import { isMassRemoval, removedMailboxes, type RenderOutput } from './render';

// ─────────────────────────────────────────────────────────────────────────────
// Application of a render to mail/config/postfix-dovecot + mail/dkim
// (apply.test.ts, temp dirs + fake reload). Rules (driver.ts header):
//  - idempotent: the manifest keeps the fingerprint of the last APPLIED
//    render; same fingerprint ⇒ nothing written, nothing reloaded;
//  - mass-removal guard against the previous render's mailbox list;
//  - every file is written `<file>.tmp` then renamed (atomic per file; the
//    directories are bind-mounted, never replaced); only changed files are
//    rewritten; stale files of the managed subdirectories are removed;
//  - the reload (checks first) failing ⇒ the previous files are restored and
//    the manifest is NOT updated (the next sync retries; a container restart
//    compiles the last good files);
//  - the manifest is written LAST: a crash in between only causes a retry;
//  - a part whose container is not running cannot be checked: the manifest
//    then records it as UNCONFIRMED and the next sync, even with the same
//    fingerprint, runs the checks + reload again (and reports a refusal)
//    instead of answering "unchanged" forever;
//  - the Rspamd limits maps (oblimint_*.map) need no reload at all: Rspamd
//    watches them (reloadPartOf), so a mailbox / alias change never restarts
//    the milter.
// Secrets: password files 0600 root, DKIM keys 0640 root:RSPAMD_GID; nothing
// of their content is ever logged nor put in an error (MA4).
// ─────────────────────────────────────────────────────────────────────────────

export interface Manifest {
  version: 1;
  fingerprint: string;
  generatedAt: string;
  mailboxes: string[];
  /** Parts written while their container was not running: never checked yet. */
  unconfirmed?: ReloadPart[];
}

export type ReloadPart = 'engine' | 'rspamd';

export interface ApplyDeps {
  /** Local path of mail/config/postfix-dovecot. */
  configDir: string;
  /** Local path of mail/dkim. */
  dkimDir: string;
  /** chown / chmod for real (Linux, running as root). */
  setOwners: boolean;
  /**
   * Checks + reloads the parts whose files changed. Throws
   * MailDriverError('applyFailed') when a check fails. Returns the parts it
   * could NOT check (container not running); nothing = all checked.
   */
  reload: (parts: Set<ReloadPart>) => Promise<ReloadPart[] | void>;
  now: () => Date;
}

export interface ApplyOutcome {
  changed: boolean;
  /** Parts reloaded (empty when unchanged). */
  parts: ReloadPart[];
  /** Parts written but not checked (container not running). */
  unconfirmed: ReloadPart[];
}

export function readManifest(configDir: string): Manifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(configDir, MANIFEST_FILE), 'utf8')) as Partial<Manifest>;
    if (m?.version !== 1 || typeof m.fingerprint !== 'string' || !Array.isArray(m.mailboxes)) return null;
    const unconfirmed = Array.isArray(m.unconfirmed) ? m.unconfirmed.filter((p): p is ReloadPart => p === 'engine' || p === 'rspamd') : [];
    return {
      version: 1, fingerprint: m.fingerprint, generatedAt: String(m.generatedAt ?? ''), mailboxes: m.mailboxes.filter((a): a is string => typeof a === 'string'),
      ...(unconfirmed.length ? { unconfirmed } : {}),
    };
  } catch {
    return null;
  }
}

function writeAtomic(file: string, content: string | Buffer, mode: number, gid: number | null, setOwners: boolean): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try { fs.unlinkSync(tmp); } catch { /* absent */ }
  // 'wx': never write through a link planted at the tmp name
  fs.writeFileSync(tmp, content, { mode, flag: 'wx' });
  if (setOwners) {
    fs.chownSync(tmp, 0, gid ?? 0);
    fs.chmodSync(tmp, mode);
  }
  fs.renameSync(tmp, file);
}

function removeIfExists(file: string): void {
  try { fs.unlinkSync(file); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Every regular file of the managed subdirectories (relative POSIX path → content). */
export function readManagedFiles(configDir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(configDir, rel), { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && !e.name.endsWith('.tmp')) out.set(r, fs.readFileSync(path.join(configDir, r)));
    }
  };
  for (const d of MANAGED_DIRS) walk(d);
  return out;
}

const WATCHED = new Set<string>(RSPAMD_WATCHED_MAPS.map((m) => `rspamd/${m}`));

/**
 * The part a changed file needs reloaded, or null when the daemon picks the
 * change up by itself: the limits maps (oblimint_*.map) are file maps Rspamd
 * watches (rspamd_config:add_map). Restarting Rspamd for them made Postfix
 * tempfail EVERY SMTP session (milter_default_action = tempfail) for ~30 s
 * on each mailbox / alias create or delete (the Linux test host). Any other rspamd/ file
 * is read at start only: restart.
 */
export function reloadPartOf(rel: string): ReloadPart | null {
  if (WATCHED.has(rel)) return null;
  return rel.startsWith('rspamd/') ? 'rspamd' : 'engine';
}
const fileMode = (rel: string): number => (isSecretFile(rel) ? 0o600 : 0o644);

function ensureDirs(deps: ApplyDeps): void {
  fs.mkdirSync(deps.configDir, { recursive: true, mode: 0o700 });
  for (const d of MANAGED_DIRS) fs.mkdirSync(path.join(deps.configDir, d), { recursive: true, mode: d === 'dovecot' ? 0o700 : 0o755 });
  fs.mkdirSync(deps.dkimDir, { recursive: true, mode: 0o750 });
  if (deps.setOwners) {
    fs.chmodSync(deps.configDir, 0o700);
    fs.chmodSync(path.join(deps.configDir, 'dovecot'), 0o700);
    fs.chownSync(deps.dkimDir, 0, RSPAMD_GID);
    fs.chmodSync(deps.dkimDir, 0o750);
  }
}

/** Makes the managed tree equal to `files` (only differences are written). Returns the changed relative paths. */
function writeTree(deps: ApplyDeps, files: Map<string, string | Buffer>, previous: Map<string, Buffer>): string[] {
  const changed: string[] = [];
  for (const [rel, content] of files) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const before = previous.get(rel);
    if (before && before.equals(buf)) continue;
    writeAtomic(path.join(deps.configDir, rel), buf, fileMode(rel), null, deps.setOwners);
    changed.push(rel);
  }
  for (const rel of previous.keys()) {
    if (!files.has(rel)) {
      removeIfExists(path.join(deps.configDir, rel));
      changed.push(rel);
    }
  }
  return changed;
}

function writeDkim(deps: ApplyDeps, keys: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [rel, content] of keys) {
    const [domain] = rel.split('/');
    const dir = path.join(deps.dkimDir, domain);
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    if (deps.setOwners) {
      fs.chownSync(dir, 0, RSPAMD_GID);
      fs.chmodSync(dir, 0o750);
    }
    const file = path.join(deps.dkimDir, rel);
    let same = false;
    try {
      const st = fs.lstatSync(file);
      same = st.isFile() && fs.readFileSync(file, 'utf8') === content;
    } catch { /* absent */ }
    if (same) continue;
    writeAtomic(file, content, 0o640, RSPAMD_GID, deps.setOwners);
    changed.push(rel);
  }
  return changed;
}

/** Removes the *.key files (and emptied domain dirs) that are not signing keys any more. */
function pruneDkim(deps: ApplyDeps, keys: Map<string, string>): void {
  let domains: fs.Dirent[];
  try {
    domains = fs.readdirSync(deps.dkimDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of domains) {
    if (!d.isDirectory()) continue;
    const dir = path.join(deps.dkimDir, d.name);
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile() || !/\.key(?:\.tmp)?$/.test(f.name)) continue;
      if (!keys.has(`${d.name}/${f.name}`)) removeIfExists(path.join(dir, f.name));
    }
    try { fs.rmdirSync(dir); } catch { /* not empty */ }
  }
}

export async function applyRender(out: RenderOutput, deps: ApplyDeps, opts: { allowMassRemoval?: boolean } = {}): Promise<ApplyOutcome> {
  const previous = readManifest(deps.configDir);
  if (previous && previous.fingerprint === out.fingerprint && !previous.unconfirmed?.length) return { changed: false, parts: [], unconfirmed: [] };

  if (previous && !opts.allowMassRemoval && isMassRemoval(previous.mailboxes, out.mailboxes)) {
    const removed = removedMailboxes(previous.mailboxes, out.mailboxes).length;
    throw new MailDriverError(
      'massRemoval',
      `The new mail state would remove ${removed} of the ${previous.mailboxes.length} mailboxes known to the engine: refused (force a sync to apply it)`,
    );
  }

  ensureDirs(deps);
  const before = readManagedFiles(deps.configDir);
  const changedFiles = writeTree(deps, out.files, before);
  const changedKeys = writeDkim(deps, out.dkimKeys);
  const parts = new Set<ReloadPart>();
  for (const rel of changedFiles) {
    const p = reloadPartOf(rel);
    if (p) parts.add(p);
  }
  if (changedKeys.length > 0) parts.add('rspamd');
  // Nothing differs on disk although the fingerprint changed: files already
  // written but never confirmed (crash, or the daemons were not reloaded):
  // reload everything. (A change limited to watched maps reloads nothing.)
  if (changedFiles.length === 0 && changedKeys.length === 0) { parts.add('engine'); parts.add('rspamd'); }

  for (const p of previous?.unconfirmed ?? []) parts.add(p);
  let unconfirmed: ReloadPart[] = [];
  try {
    if (parts.size > 0) unconfirmed = [...new Set((await deps.reload(parts)) ?? [])].filter((p) => parts.has(p)).sort();
  } catch (err) {
    // restore the previous files (the running daemons kept their configuration)
    writeTree(deps, before, readManagedFiles(deps.configDir));
    throw err instanceof MailDriverError ? err : new MailDriverError('applyFailed', 'The mail engine refused the new configuration', (err as Error)?.message ?? null);
  }

  pruneDkim(deps, out.dkimKeys);
  const manifest: Manifest = {
    version: 1, fingerprint: out.fingerprint, generatedAt: deps.now().toISOString(), mailboxes: out.mailboxes,
    ...(unconfirmed.length ? { unconfirmed } : {}),
  };
  writeAtomic(path.join(deps.configDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 0o600, null, deps.setOwners);
  return { changed: true, parts: [...parts].sort(), unconfirmed };
}
