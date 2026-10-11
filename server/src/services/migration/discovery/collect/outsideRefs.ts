import type { CwpAccount, CwpDomain, CwpOutsideEntry, CwpOutsideRef } from '@oblimint/shared';
import { parseRefsGrep } from '../parsers/refs';
import { baseName, dirName, type FindEntry } from '../parsers/system';
import { DiscoveryContext, isCleanPath, isUnder, stripSlash } from './context';
import { MAX_REF_NAMES } from '../../source/templates';

// ─────────────────────────────────────────────────────────────────────────────
// Entries outside the docroots that the code cites (end of phase docroots).
// CWP keeps secrets / shared code NEXT to the docroot (~/private_html/,
// ~/tools/config.php next to ~/tools/app): a copy of the docroot alone
// breaks `require __DIR__ . '/../../private_html/secrets.php'`.
//
// Candidates of a docroot: the entries of the home, and of every directory
// between the home and the docroot, that are not hidden, not CWP internals,
// not a docroot nor a directory holding one. fs.grepRefs reports which ones
// its code cites (matched fragments only) and the files writing an absolute
// /home/<user>/ path. Cited → CwpDomain.outsideRefs; cited by no docroot →
// CwpAccount.homeLeftovers (not migrated unless attached by the staff).
// ─────────────────────────────────────────────────────────────────────────────

const CANDIDATE_NAME_RE = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]{0,99}$/;
const HOME_RE = /^\/home\/[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const MAX_ABSOLUTE_SAMPLE = 10;

interface Candidate {
  path: string;
  type: 'dir' | 'file';
  size: number;
}

const isSiteLike = (d: CwpDomain) => d.serving === 'site' || d.serving === 'unknown' || d.serving === 'disabled';

function candidatesOf(entries: FindEntry[], roots: string[], keep: (p: string) => boolean, internals: ReadonlySet<string>): Candidate[] {
  return entries
    .filter((e) => e.type === 'd' || e.type === 'f')
    .filter((e) => {
      const n = baseName(e.path);
      return CANDIDATE_NAME_RE.test(n) && !internals.has(n) && isCleanPath(e.path) && keep(e.path)
        && !roots.some((r) => isUnder(r, e.path) || isUnder(e.path, r));
    })
    .map((e) => ({ path: stripSlash(e.path), type: e.type === 'd' ? 'dir' as const : 'file' as const, size: e.size }));
}

export async function collectOutsideRefs(ctx: DiscoveryContext, homeInternals: ReadonlySet<string>): Promise<void> {
  const st = ctx.state;
  for (const a of st.accounts) {
    ctx.checkAbort();
    await collectAccount(ctx, a, st.domains.filter((d) => d.account === a.username && isSiteLike(d) && !!d.docroot), homeInternals);
  }
}

async function collectAccount(ctx: DiscoveryContext, a: CwpAccount, domains: CwpDomain[], homeInternals: ReadonlySet<string>): Promise<void> {
  const home = stripSlash(a.homeDir);
  if (!isCleanPath(home) || !home.startsWith('/home/')) return;
  const roots = [...new Set(domains.map((d) => stripSlash(d.docroot as string)))]
    .filter((r) => isCleanPath(r) && isUnder(r, home) && r !== home).sort();
  if (roots.length === 0) return;

  const homeCands = candidatesOf(ctx.state.homeEntries.get(a.username) ?? [], roots, () => true, homeInternals);
  // Directories between the home and a docroot (~/tools for ~/tools/app), never inside another docroot.
  const ancestorsOf = (r: string): string[] => {
    const out: string[] = [];
    for (let p = dirName(r); p !== home && isUnder(p, home); p = dirName(p)) out.unshift(p);
    return out.filter((p) => !roots.some((o) => isUnder(p, o)));
  };
  const listed = new Map<string, Candidate[]>();
  for (const dir of [...new Set(roots.flatMap(ancestorsOf))].sort()) {
    const entries = await ctx.find(`entries of ${dir}`, dir, 1);
    listed.set(dir, candidatesOf(entries, roots, (p) => dirName(p) === dir, new Set()));
  }

  // Sizes: du of the directories, find size of the files.
  const all = [...homeCands, ...[...listed.values()].flat()];
  const du = await ctx.du(`outside entries of ${a.username}`, all.filter((c) => c.type === 'dir').map((c) => c.path));
  const entry = (c: Candidate): CwpOutsideEntry => ({ path: c.path, type: c.type, bytes: c.type === 'dir' ? du.get(c.path) ?? null : c.size });

  const cited = new Set<string>();
  const homeArg = HOME_RE.test(home) ? home : undefined;
  for (const root of roots) {
    ctx.checkAbort();
    // The nearest directory wins a name present at several levels (~/config.php vs ~/tools/config.php).
    const byName = new Map<string, Candidate>();
    for (const c of homeCands) byName.set(baseName(c.path), c);
    for (const dir of ancestorsOf(root)) for (const c of listed.get(dir) ?? []) byName.set(baseName(c.path), c);
    const names = [...byName.keys()].sort().slice(0, MAX_REF_NAMES);
    if (names.length === 0 && !homeArg) continue;
    const r = await ctx.tryRun(`references of ${root}`, 'fs.grepRefs', {
      root, names, ...(homeArg ? { home: homeArg } : {}),
    }, { allowNonZeroExit: true }, { kind: 'account', key: a.username, account: a.username });
    if (!r) continue;
    const g = parseRefsGrep(r.stdout, root, new Set(names), homeArg);
    const refs: CwpOutsideRef[] = [...g.cited.entries()]
      .map(([name, file]) => ({ ...entry(byName.get(name) as Candidate), citedBy: file }))
      .sort((x, y) => x.path.localeCompare(y.path));
    for (const ref of refs) cited.add(ref.path);
    for (const d of domains) {
      if (stripSlash(d.docroot as string) !== root) continue;
      d.outsideRefs = refs.map((x) => ({ ...x }));
      d.absoluteHomeRefs = g.absolute.slice(0, MAX_ABSOLUTE_SAMPLE);
    }
  }
  a.homeLeftovers = all.filter((c) => !cited.has(c.path)).map(entry).sort((x, y) => x.path.localeCompare(y.path));
}
