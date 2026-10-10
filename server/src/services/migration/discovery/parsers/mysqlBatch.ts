// ─────────────────────────────────────────────────────────────────────────────
// `mysql --batch` output (docs/P5-PLAN.md §5.4 bis): one line per row, columns
// separated by TAB, SQL NULL printed as the literal `NULL`, and the cell
// escapes \t \n \\ \0 (mysql also escapes \r in batch mode on some builds:
// accepted). A literal string "NULL" cannot be told apart from SQL NULL in
// batch mode: both become null here (harmless for every column we read).
// ─────────────────────────────────────────────────────────────────────────────

export type BatchCell = string | null;

function unescapeCell(raw: string): BatchCell {
  if (raw === 'NULL') return null;
  if (!raw.includes('\\')) return raw;
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c !== '\\' || i === raw.length - 1) { out += c; continue; }
    const n = raw[i + 1];
    i += 1;
    switch (n) {
      case 't': out += '\t'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case '0': out += '\0'; break;
      case '\\': out += '\\'; break;
      default: out += `\\${n}`;
    }
  }
  return out;
}

function splitLines(stdout: string): string[] {
  const lines = stdout.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Rows as arrays of cells (no header handling). */
export function parseMysqlRows(stdout: string): BatchCell[][] {
  return splitLines(stdout).map((line) => line.split('\t').map(unescapeCell));
}

/**
 * header: true → the first line names the columns and every row becomes an
 * object keyed by column name; header: false → arrays keyed by index ('0', '1'…).
 * Short rows get null for the missing cells; extra cells are dropped.
 */
export function parseMysqlBatch(stdout: string, opts: { header: boolean }): Array<Record<string, BatchCell>> {
  const rows = parseMysqlRows(stdout);
  if (rows.length === 0) return [];
  const columns = opts.header ? rows[0].map((c) => c ?? 'NULL') : rows[0].map((_, i) => String(i));
  const body = opts.header ? rows.slice(1) : rows;
  const width = opts.header ? columns.length : Math.max(...rows.map((r) => r.length));
  const names = opts.header ? columns : Array.from({ length: width }, (_, i) => String(i));
  return body.map((r) => {
    const o: Record<string, BatchCell> = {};
    names.forEach((n, i) => { o[n] = i < r.length ? r[i] : null; });
    return o;
  });
}

/** Integer cell (null / '' / non-numeric → null). */
export function cellInt(v: BatchCell | undefined): number | null {
  if (v === null || v === undefined || v.trim() === '') return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function cellStr(v: BatchCell | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v;
}
