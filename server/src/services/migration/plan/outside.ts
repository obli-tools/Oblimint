import { OUTSIDE_AUTO_MAX_BYTES, type CwpOutsideEntry, type CwpOutsideRef, type PlannedOutsideEntry } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Entries outside the docroot copied with a site (CWP layout kept as is:
// ~/private_html next to ~/public_html, ~/tools/config.php next to
// ~/tools/app). The cited ones (discovery outsideRefs) are attached
// automatically up to OUTSIDE_AUTO_MAX_BYTES; a staff choice (absolute paths)
// replaces the detection. With an attachment the copy becomes SELECTIVE: the
// source root is the common parent of the application root and the attached
// entries, only those paths are copied (copyPaths, the application root
// first), at the same relative place — `__DIR__ . '/../../private_html'` keeps
// working, the attached entries stay outside the docroot (never served).
// ─────────────────────────────────────────────────────────────────────────────

/** Path components the rsync filters can express literally (no glob character). */
const SAFE_COMPONENT = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]{0,254}$/;

export interface OutsideProblem {
  severity: 'warning' | 'info';
  code: 'outsideTooLarge' | 'outsideInvalid' | 'outsideAttached';
  params: Record<string, string | number | null>;
}

export interface OutsidePlan {
  sourceRoot: string;
  docroot: string;
  /** [] = the whole sourceRoot is copied. */
  copyPaths: string[];
  outside: PlannedOutsideEntry[];
  attachedBytes: number;
  problems: OutsideProblem[];
}

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
const within = (p: string, d: string) => p === d || p.startsWith(`${d}/`);
const relOf = (p: string, root: string) => (p === root ? '' : p.slice(root.length + 1));

function cleanAbs(p: string): boolean {
  if (!p.startsWith('/') || p.endsWith('/') || p.includes('//')) return false;
  return p.split('/').slice(1).every((c) => c !== '.' && c !== '..' && c.length > 0);
}

/** Common parent directory of absolute paths. */
export function commonParent(paths: string[]): string {
  const split = paths.map((p) => trim(p).split('/'));
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const c = split[0][i];
    if (c === undefined || split.some((s) => s[i] !== c)) break;
    out.push(c);
  }
  return out.join('/') || '/';
}

export function planOutside(input: {
  home: string;
  /** Root copied without attachment (docroot, or its parent for public/ layouts). */
  appRoot: string;
  /** Docroot relative to appRoot. */
  docroot: string;
  refs: CwpOutsideRef[];
  leftovers: CwpOutsideEntry[];
  /** Staff choice: absolute paths (null = automatic). */
  choice: string[] | null;
  /** Docroots of the OTHER sites of the account (absolute). */
  otherRoots: string[];
}): OutsidePlan {
  const home = trim(input.home);
  const appRoot = trim(input.appRoot);
  const problems: OutsideProblem[] = [];
  const known = new Map<string, { entry: CwpOutsideEntry; citedBy: string | null }>();
  for (const e of input.leftovers) known.set(trim(e.path), { entry: e, citedBy: null });
  for (const r of input.refs) known.set(trim(r.path), { entry: r, citedBy: r.citedBy });

  let wanted: string[];
  if (input.choice) {
    wanted = [...new Set(input.choice.map(trim))];
  } else {
    wanted = [];
    for (const r of input.refs) {
      if (r.bytes !== null && r.bytes <= OUTSIDE_AUTO_MAX_BYTES) wanted.push(trim(r.path));
      else problems.push({ severity: 'warning', code: 'outsideTooLarge', params: { path: r.path, bytes: r.bytes } });
    }
  }

  const attached: string[] = [];
  for (const p of wanted) {
    const reason = !cleanAbs(p) ? 'path'
      : !within(p, home) || p === home ? 'outsideHome'
      : within(p, appRoot) || within(appRoot, p) ? 'site'
      : input.otherRoots.some((r) => within(trim(r), p) || within(p, trim(r))) ? 'otherSite'
      : relOf(p, home).split('/').some((c) => !SAFE_COMPONENT.test(c)) ? 'name'
      : !known.has(p) ? 'unknown'
      : null;
    if (reason) problems.push({ severity: 'warning', code: 'outsideInvalid', params: { path: p, reason } });
    else attached.push(p);
  }

  const listed = new Set([...input.refs.map((r) => trim(r.path)), ...attached]);
  if (attached.length === 0) {
    return {
      sourceRoot: appRoot, docroot: input.docroot, copyPaths: [], attachedBytes: 0, problems,
      outside: [...listed].sort().map((p) => entryOf(p, '', false, known)),
    };
  }
  // The application root's own components must be expressible too (selective rsync filters).
  if (relOf(appRoot, home).split('/').some((c) => !SAFE_COMPONENT.test(c))) {
    problems.push({ severity: 'warning', code: 'outsideInvalid', params: { path: appRoot, reason: 'name' } });
    return {
      sourceRoot: appRoot, docroot: input.docroot, copyPaths: [], attachedBytes: 0, problems,
      outside: [...listed].sort().map((p) => entryOf(p, '', false, known)),
    };
  }
  const root = commonParent([appRoot, ...attached]);
  const appRel = relOf(appRoot, root);
  const docroot = [appRel, input.docroot].filter(Boolean).join('/');
  const set = new Set(attached);
  const outside = [...listed].sort().map((p) => entryOf(p, set.has(p) ? relOf(p, root) : '', set.has(p), known));
  const attachedBytes = outside.filter((o) => o.attached).reduce((n, o) => n + (o.bytes ?? 0), 0);
  problems.push({
    severity: 'info', code: 'outsideAttached',
    params: { paths: outside.filter((o) => o.attached).map((o) => o.rel).join(', '), root },
  });
  return { sourceRoot: root, docroot, copyPaths: [appRel, ...attached.map((p) => relOf(p, root)).sort()], outside, attachedBytes, problems };
}

function entryOf(path: string, rel: string, attached: boolean, known: Map<string, { entry: CwpOutsideEntry; citedBy: string | null }>): PlannedOutsideEntry {
  const k = known.get(path);
  return { path, type: k?.entry.type ?? 'dir', bytes: k?.entry.bytes ?? null, rel, citedBy: k?.citedBy ?? null, attached };
}

/**
 * rsync filters of a selective copy (relative to the source root): every directory leading to a kept path and
 * the kept paths are included, everything else at those levels excluded. A kept directory's content follows
 * the other excludes (data paths, nested sites) as before.
 */
export function selectiveFilters(copyPaths: string[]): { includes: string[]; excludes: string[] } {
  const includes = new Set<string>();
  const levels = new Set<string>();
  for (const p of copyPaths) {
    const parts = p.split('/').filter(Boolean);
    levels.add('');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      includes.add(`/${dir}/`);
      levels.add(dir);
    }
    if (parts.length) includes.add(`/${parts.join('/')}`);
  }
  // A level that is itself kept whole is not narrowed.
  const kept = new Set(copyPaths.map((p) => p.split('/').filter(Boolean).join('/')));
  const excludes = [...levels].filter((l) => !kept.has(l)).sort().map((l) => (l ? `/${l}/*` : '/*'));
  return { includes: [...includes].sort(), excludes };
}

/** Absolute directories (or files) a site copies: its copy paths below the source root, else the source root. */
export function copiedAreas(site: { sourceRoot: string; copyPaths?: string[] }): string[] {
  const root = trim(site.sourceRoot);
  const paths = site.copyPaths ?? [];
  return paths.length ? paths.map((p) => (p ? `${root}/${p}` : root)) : [root];
}
