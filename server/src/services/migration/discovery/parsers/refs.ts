// ─────────────────────────────────────────────────────────────────────────────
// fs.grepRefs output (`grep -HoE` on the code files of a docroot): one line per
// matched fragment, `<file>:<fragment>`. A fragment is a candidate name between
// path delimiters (/private_html/, /config.php', 'private_html/) or the
// /home/<user>/ prefix (absolute path written in the code). Fragments never
// contain ':' (names and home are validated), so the LAST ':' splits the line.
// ─────────────────────────────────────────────────────────────────────────────

export interface RefsGrep {
  /** Cited name → first citing file (relative to the root, smallest path first). */
  cited: Map<string, string>;
  /** Files citing an absolute /home/<user>/ path (relative to the root, sorted). */
  absolute: string[];
}

const DELIMS = /^[/'"]+|[/'"]+$/g;

export function parseRefsGrep(stdout: string, root: string, names: ReadonlySet<string>, home?: string): RefsGrep {
  const prefix = `${root.replace(/\/+$/, '')}/`;
  const cited = new Map<string, string>();
  const absolute = new Set<string>();
  const rows = stdout.split('\n').filter(Boolean).map((l) => {
    const i = l.lastIndexOf(':');
    return i > 0 ? { file: l.slice(0, i), fragment: l.slice(i + 1) } : null;
  }).filter((r): r is { file: string; fragment: string } => r !== null && r.file.startsWith(prefix))
    .sort((a, b) => a.file.localeCompare(b.file));
  for (const { file, fragment } of rows) {
    const rel = file.slice(prefix.length);
    if (home && fragment === `${home}/`) {
      absolute.add(rel);
      continue;
    }
    const name = fragment.replace(DELIMS, '');
    if (names.has(name) && !cited.has(name)) cited.set(name, rel);
  }
  return { cited, absolute: [...absolute].sort() };
}
