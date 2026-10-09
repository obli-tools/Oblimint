// Pure unified-diff parser for the release diff viewer (no imports: unit-
// tested from a node harness). Input = the `patch` of one ReleaseDiffFile
// (git unified diff, possibly with its `diff --git` / `index` / `---` / `+++`
// header lines); output = display rows with old / new line numbers.

export type DiffRowKind = 'hunk' | 'add' | 'del' | 'ctx' | 'note';

export interface DiffRow {
  kind: DiffRowKind;
  /** Line number in the old file (del / ctx), null otherwise. */
  oldNo: number | null;
  /** Line number in the new file (add / ctx), null otherwise. */
  newNo: number | null;
  /** Line text WITHOUT its +/-/space prefix (hunk: the whole @@ header). */
  text: string;
}

export interface ParsedDiff {
  rows: DiffRow[];
  additions: number;
  deletions: number;
  hunks: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseUnifiedDiff(patch: string | null | undefined): ParsedDiff {
  const out: ParsedDiff = { rows: [], additions: 0, deletions: 0, hunks: 0 };
  if (!patch) return out;
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  // A trailing newline yields one empty last element: not a diff line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  // Lines still expected in the current hunk (header counts): the hunk ends
  // when both reach 0, so a following file header such as "--- a/x" is
  // never mistaken for a deleted line.
  let oldLeft = 0;
  let newLeft = 0;

  for (const line of lines) {
    const m = HUNK_RE.exec(line);
    if (m) {
      inHunk = true;
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      out.hunks++;
      out.rows.push({ kind: 'hunk', oldNo: null, newNo: null, text: line });
      continue;
    }
    const c = line.charAt(0);
    if (c === '\\') {
      // "\ No newline at end of file" — follows the last line of a hunk.
      if (out.hunks > 0) out.rows.push({ kind: 'note', oldNo: null, newNo: null, text: line.slice(2) });
      continue;
    }
    // File header lines (diff --git, index, ---, +++, mode…) outside hunks.
    if (!inHunk) continue;
    const text = line.slice(1);
    if (c === '+') {
      out.rows.push({ kind: 'add', oldNo: null, newNo: newNo++, text });
      out.additions++;
      newLeft--;
    } else if (c === '-') {
      out.rows.push({ kind: 'del', oldNo: oldNo++, newNo: null, text });
      out.deletions++;
      oldLeft--;
    } else if (c === ' ' || line === '') {
      // Some producers strip the single space of an empty context line.
      out.rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text });
      oldLeft--;
      newLeft--;
    } else {
      // Unexpected line (e.g. a header without counts): wait for the next hunk.
      inHunk = false;
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) inHunk = false;
  }
  return out;
}
