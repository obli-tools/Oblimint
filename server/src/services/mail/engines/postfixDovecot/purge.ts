import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../../../../utils/logger';
import { MailDriverError } from '../../driver';
import { DOMAIN_RE, LOCAL_PART_RE } from './validate';

// ─────────────────────────────────────────────────────────────────────────────
// Deletion of the DATA of a removed mailbox / domain (mail_purge_queue, after
// the grace period — MA12), R1: never follows a symbolic link.
//
// The path is computed (vmail/<domain>[/<local>]) from validated names only,
// never from raw input. Every component from the vmail root down is lstat'ed:
// a symlink anywhere refuses the purge. The target is first RENAMED to a
// hidden trash name in the same directory, DETERMINISTIC per target (rename
// acts on the link itself, never on what it points to), re-checked, then
// removed recursively (Node's fs.rm unlinks the symlinks it meets, it does
// not descend into them). Missing data = success (idempotent) — but a trash
// left by an interrupted attempt (rm failed, panel restarted between the
// rename and the rm) is found again by its name and finished first, so a
// tombstone is never marked purged while its data is still on disk (MA12).
// Every purge also sweeps any other leftover '.oblimint-purge-*' (earlier
// random names) under the vmail root and the domain directories.
// ─────────────────────────────────────────────────────────────────────────────

export type PurgeTarget = { kind: 'mailbox' | 'domain'; name: string };

/** Relative components of the target under vmail/, validated. */
export function purgeComponents(target: PurgeTarget): string[] {
  const name = String(target?.name ?? '').trim().toLowerCase();
  if (target?.kind === 'domain') {
    if (!DOMAIN_RE.test(name)) throw new MailDriverError('invalidState', 'Invalid domain name to purge');
    return [name];
  }
  if (target?.kind === 'mailbox') {
    const at = name.lastIndexOf('@');
    const local = name.slice(0, at);
    const domain = name.slice(at + 1);
    if (at <= 0 || !LOCAL_PART_RE.test(local) || !DOMAIN_RE.test(domain)) throw new MailDriverError('invalidState', 'Invalid mailbox address to purge');
    return [domain, local];
  }
  throw new MailDriverError('invalidState', 'Invalid purge target');
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export const PURGE_TRASH_PREFIX = '.oblimint-purge-';

/** Trash name of a target (same for every attempt: a retry finds and finishes it). */
export function purgeTrashName(target: PurgeTarget): string {
  const parts = purgeComponents(target);
  return `${PURGE_TRASH_PREFIX}${crypto.createHash('sha256').update(`${target.kind}:${parts.join('/')}`).digest('hex').slice(0, 24)}`;
}

/** Removes one trash entry (a link is unlinked, never followed). Returns true when something was removed. */
async function removeTrash(p: string): Promise<boolean> {
  const st = lstatOrNull(p);
  if (!st) return false;
  if (st.isSymbolicLink() || !st.isDirectory()) {
    fs.unlinkSync(p);
    return true;
  }
  await fs.promises.rm(p, { recursive: true, force: true });
  return true;
}

/**
 * Removes every leftover trash ('.oblimint-purge-*') directly under the vmail
 * root and under each domain directory (never descends into a link).
 * Returns how many were removed; failures are returned, not thrown.
 */
export async function sweepPurgeLeftovers(vmailRoot: string): Promise<{ removed: number; errors: string[] }> {
  const out = { removed: 0, errors: [] as string[] };
  const root = path.resolve(vmailRoot);
  const rootSt = lstatOrNull(root);
  if (!rootSt || rootSt.isSymbolicLink() || !rootSt.isDirectory()) return out;
  const dirs = [root];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.')) dirs.push(path.join(root, e.name));
  }
  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { out.errors.push((err as Error).message); continue; }
    for (const e of entries) {
      if (!e.name.startsWith(PURGE_TRASH_PREFIX)) continue;
      try {
        if (await removeTrash(path.join(dir, e.name))) out.removed++;
      } catch (err) {
        out.errors.push(`${e.name}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
      }
    }
  }
  return out;
}

/** Removes vmail/<domain>[/<local>] under `vmailRoot` (local path). Returns false when there was nothing to remove. */
export async function purgeMailData(vmailRoot: string, target: PurgeTarget): Promise<boolean> {
  const parts = purgeComponents(target);
  const trashName = purgeTrashName(target);
  const root = path.resolve(vmailRoot);
  const rootSt = lstatOrNull(root);
  if (!rootSt) return false;
  if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) throw new MailDriverError('invalidState', 'The mail data directory is not a plain directory: purge refused');

  // 1. this target's own trash from an interrupted attempt: finished first
  //    (an error here throws: the tombstone stays and is retried).
  let finished = false;
  let dir = root;
  for (let i = 0; i < parts.length; i++) {
    const st = i === 0 ? rootSt : lstatOrNull(dir);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) break;
    if (i === parts.length - 1 && await removeTrash(path.join(dir, trashName))) finished = true;
    dir = path.join(dir, parts[i]);
  }
  // 2. other leftovers (earlier versions' random names, other targets): best effort.
  const swept = await sweepPurgeLeftovers(root);
  if (swept.errors.length > 0) logger.warn({ errors: swept.errors.slice(0, 5) }, 'mail purge: leftover trash not removed yet (retried at the next purge)');

  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const st = lstatOrNull(current);
    if (!st) return finished;
    if (st.isSymbolicLink()) throw new MailDriverError('invalidState', 'A symbolic link was found in the mail data path: purge refused');
    if (!st.isDirectory()) throw new MailDriverError('invalidState', 'Unexpected file in the mail data path: purge refused');
  }

  const parent = path.dirname(current);
  const realRoot = fs.realpathSync(root);
  const assertInside = () => {
    const real = fs.realpathSync(parent);
    if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
      throw new MailDriverError('invalidState', 'The mail data path escaped the data directory: purge refused');
    }
  };
  assertInside();
  const trash = path.join(parent, trashName);
  fs.renameSync(current, trash);
  const st = lstatOrNull(trash);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) {
    throw new MailDriverError('invalidState', 'The mail data path changed during the purge: refused');
  }
  assertInside();
  await fs.promises.rm(trash, { recursive: true, force: true });
  return true;
}
