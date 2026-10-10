import fs from 'fs';
import path from 'path';
import { kindNoFollow, mkdirNoFollow, removeTreeNoFollow } from './fsSafe';

// ─────────────────────────────────────────────────────────────────────────────
// Immutable source trees of the deployments (docs/P4b-PLAN.md §5.3, AP1 / R1,
// security audit P4b). A stack has ONE mutable source tree (src/ for git / ZIP
// / catalog stacks, files/ for editor stacks): a pull, an upload or an edit
// replaces it. Containers never bind it: every deployment that mounts source
// files or builds an image first copies that tree into
//   accounts/<id>/apps/<stackId>/snapshots/<deploymentId>/<src|files>/…
// (hard links when possible — the source files are only ever replaced, never
// rewritten in place —, else a copy; a symbolic link anywhere ABORTS the copy,
// special files too) and the containers' binds point at that snapshot. So:
//   - a pull / upload / edit never changes what a running container sees;
//   - Docker re-resolving the bind sources at a restart (restart policy,
//     daemon restart, host reboot) finds the same link-free tree;
//   - a rollback re-points the binds at the snapshot of the target deployment.
// Snapshots are written only by the panel (nothing tenant-controlled ever
// writes there: binds are read-only, build contexts are packed by the panel)
// and pruned with the deployment retention (pruneSnapshots).
// ─────────────────────────────────────────────────────────────────────────────

export const SNAPSHOTS_DIR = 'snapshots';

export class SourceTreeError extends Error {
  constructor(message: string, readonly rel: string) {
    super(message);
    this.name = 'SourceTreeError';
  }
}

/** Relative path (to the stack dir) of the snapshot of deployment `id`. */
export function snapshotRel(id: number): string {
  return `${SNAPSHOTS_DIR}/${id}`;
}

/** Walks `root` without following links: throws SourceTreeError on a symbolic link or a special file. */
export function assertNoSymlinks(root: string): void {
  const walk = (dir: string, rel: string) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) throw new SourceTreeError(`A symbolic link is in the source tree (${r.slice(0, 200)})`, r);
      if (st.isDirectory()) walk(p, r);
      else if (!st.isFile()) throw new SourceTreeError(`A special file is in the source tree (${r.slice(0, 200)})`, r);
    }
  };
  let st: fs.Stats;
  try { st = fs.lstatSync(root); } catch { return; }
  if (st.isSymbolicLink()) throw new SourceTreeError('The source tree is a symbolic link', '');
  if (st.isDirectory()) walk(root, '');
}

/** Copies a link-free tree (`from` → `to`, `to` must not exist): hard links when possible, else copies. */
function copyTree(from: string, to: string, rel: string): void {
  fs.mkdirSync(to, { mode: 0o755 });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.lstatSync(src);
    if (st.isSymbolicLink()) throw new SourceTreeError(`A symbolic link is in the source tree (${r.slice(0, 200)})`, r);
    if (st.isDirectory()) { copyTree(src, dst, r); continue; }
    if (!st.isFile()) throw new SourceTreeError(`A special file is in the source tree (${r.slice(0, 200)})`, r);
    try {
      fs.linkSync(src, dst);
    } catch {
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE);
    }
    // The copy itself must be what was checked (a link swapped in between is refused).
    const out = fs.lstatSync(dst);
    if (!out.isFile()) throw new SourceTreeError(`The source tree changed during the snapshot (${r.slice(0, 200)})`, r);
  }
}

/**
 * Snapshot of the stack's source tree `rootDir` (src | files) for deployment `id`: returns its relative path
 * (snapshots/<id>), whose `<rootDir>/…` mirrors the source. A missing source tree gives an empty one.
 * Throws SourceTreeError on a symbolic link / special file (nothing is left behind).
 */
export function createSourceSnapshot(stackDir: string, rootDir: 'src' | 'files', id: number): string {
  const snapshots = mkdirNoFollow(stackDir, SNAPSHOTS_DIR, 0o711);
  const rel = snapshotRel(id);
  const final = path.join(stackDir, ...rel.split('/'));
  const tmp = path.join(snapshots, `.tmp-${id}-${process.pid}`);
  removeTreeNoFollow(tmp, snapshots);
  removeTreeNoFollow(final, snapshots);
  fs.mkdirSync(tmp, { mode: 0o755 });
  try {
    const kind = kindNoFollow(stackDir, rootDir);
    if (kind === 'symlink') throw new SourceTreeError('The source tree is a symbolic link', rootDir);
    if (kind === 'dir') copyTree(path.join(stackDir, rootDir), path.join(tmp, rootDir), '');
    else fs.mkdirSync(path.join(tmp, rootDir), { mode: 0o755 });
    fs.renameSync(tmp, final);
  } catch (err) {
    try { removeTreeNoFollow(tmp, snapshots); } catch { /* swept by the next prune */ }
    throw err;
  }
  return rel;
}

/** Is the snapshot of deployment `id` present (a real directory, no link)? */
export function snapshotExists(stackDir: string, id: number): boolean {
  return kindNoFollow(stackDir, snapshotRel(id)) === 'dir';
}

/** Removes the snapshot of deployment `id` (never through a link). */
export function removeSnapshot(stackDir: string, id: number): void {
  if (kindNoFollow(stackDir, SNAPSHOTS_DIR) !== 'dir') return;
  removeTreeNoFollow(path.join(stackDir, ...snapshotRel(id).split('/')), path.join(stackDir, SNAPSHOTS_DIR));
}

/**
 * Retention: removes every snapshot whose deployment id is not in `keep` and not above `keepAbove` (newer
 * than the last successful deployment: a running or failed-but-partly-converged one may be in use), plus
 * leftovers of interrupted copies. Returns the ids removed. Never follows a link.
 */
export function pruneSnapshots(stackDir: string, keep: ReadonlySet<number>, keepAbove: number | null): number[] {
  if (kindNoFollow(stackDir, SNAPSHOTS_DIR) !== 'dir') return [];
  const dir = path.join(stackDir, SNAPSHOTS_DIR);
  const removed: number[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.tmp-')) {
      const pid = Number(name.split('-')[2]);
      if (pid !== process.pid) removeTreeNoFollow(path.join(dir, name), dir);
      continue;
    }
    const id = Number(name);
    if (!Number.isInteger(id) || id <= 0) { removeTreeNoFollow(path.join(dir, name), dir); continue; }
    if (keep.has(id) || (keepAbove !== null && id > keepAbove)) continue;
    removeTreeNoFollow(path.join(dir, name), dir);
    removed.push(id);
  }
  return removed;
}
