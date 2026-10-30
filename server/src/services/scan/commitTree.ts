import type { ContentTree, TreeStat } from '../maintenance/contracts';
import { runGit, splitZ } from '../releases/git';

// ─────────────────────────────────────────────────────────────────────────────
// ContentTree over a COMMIT of the site's internal repository (docs/P3-PLAN.md
// §9.3). The pre-publish scanner analyses exactly what the release will
// contain: the committed blobs, never the staging (still writable by the
// tenant over SFTP while the publication runs — reading it after the commit
// would be a TOCTOU bypass: swap / delete the webshell once the commit is
// taken and the scanner sees a benign file).
//
// No filesystem path is ever built from a tree path (lookup in the ls-tree
// listing, content by object id through `git cat-file`): no traversal, no
// symlink to follow. The hardened runner of releases/git.ts is reused.
// ─────────────────────────────────────────────────────────────────────────────

const OID = /^[0-9a-f]{40,64}$/;

interface Entry {
  mode: string;
  type: string;
  oid: string;
  size: number;
}

/** Parses `git ls-tree -r -l -z` output ("<mode> <type> <oid> <size>\t<path>"). */
export function parseLsTreeLong(buf: Buffer | string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const rec of splitZ(buf)) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, oid, size] = rec.slice(0, tab).trim().split(/\s+/);
    if (!mode || !type || !oid || !OID.test(oid)) continue;
    const n = Number(size);
    out.set(rec.slice(tab + 1), { mode, type, oid, size: Number.isFinite(n) && n >= 0 ? n : 0 });
  }
  return out;
}

function statOf(e: Entry): TreeStat {
  if (e.type === 'blob' && e.mode === '120000') return { type: 'symlink', size: e.size, mode: 0o777 };
  if (e.type === 'blob') return { type: 'file', size: e.size, mode: e.mode === '100755' ? 0o755 : 0o644 };
  // Gitlink (160000): no content in this repository.
  return { type: 'other', size: 0, mode: 0 };
}

/**
 * Read-only ContentTree of `commit` in the bare repository `repoDir`. The
 * listing is loaded once (lazily). Throws (GitError) when the commit cannot be
 * listed: the caller fails closed.
 */
export function commitContentTree(repoDir: string, commit: string): ContentTree & {
  load(): Promise<void>;
  /** Every file and symlink of the commit (gitlinks left out), for whole-tree rules (leak guard). */
  entries(): Promise<Array<{ path: string; size: number; type: 'file' | 'symlink' }>>;
} {
  if (!OID.test(commit)) throw new Error('invalid commit id');
  let listing: Promise<{ files: Map<string, Entry>; dirs: Set<string> }> | null = null;
  const load = () => {
    listing ??= (async () => {
      const r = await runGit(['ls-tree', '-r', '-l', '-z', '--full-tree', commit], { gitDir: repoDir, maxBuffer: 256 * 1024 * 1024 });
      const files = parseLsTreeLong(r.stdout);
      const dirs = new Set<string>();
      for (const p of files.keys()) {
        for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) {
          const d = p.slice(0, i);
          if (dirs.has(d)) break;
          dirs.add(d);
        }
      }
      return { files, dirs };
    })();
    return listing;
  };
  const blob = async (oid: string, maxBytes: number): Promise<Buffer> => {
    const r = await runGit(['cat-file', 'blob', oid], { gitDir: repoDir, maxBuffer: Math.max(1, maxBytes), allowTruncate: true });
    return r.stdout.length > maxBytes ? r.stdout.subarray(0, maxBytes) : r.stdout;
  };

  return {
    root: `${repoDir}#${commit}`,
    async load() { await load(); },
    async entries() {
      const { files } = await load();
      const out: Array<{ path: string; size: number; type: 'file' | 'symlink' }> = [];
      for (const [p, e] of files) {
        const st = statOf(e);
        if (st.type === 'file' || st.type === 'symlink') out.push({ path: p, size: st.size, type: st.type });
      }
      return out;
    },
    async stat(rel) {
      const { files, dirs } = await load();
      const e = files.get(rel);
      if (e) return statOf(e);
      return dirs.has(rel) ? { type: 'dir', size: 0, mode: 0o755 } : null;
    },
    async read(rel, maxBytes) {
      const { files } = await load();
      const e = files.get(rel);
      if (!e || statOf(e).type !== 'file') return null;
      const want = Math.max(0, Math.min(e.size, Math.floor(maxBytes)));
      const data = want === 0 ? Buffer.alloc(0) : await blob(e.oid, want);
      return { data, truncated: e.size > data.length, size: e.size };
    },
    async readlink(rel) {
      const { files } = await load();
      const e = files.get(rel);
      if (!e || statOf(e).type !== 'symlink') return null;
      return (await blob(e.oid, 4096)).toString('utf8');
    },
  };
}
