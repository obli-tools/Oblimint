// CSV built for spreadsheets: every cell quoted, and a cell that a spreadsheet
// would read as a formula (= + - @, or a leading tab / CR that some apps strip
// before evaluating) is prefixed with a single quote so it stays plain text.

const FORMULA_START = /^[=+\-@\t\r]/;

/** One quoted CSV cell, neutralised against formula injection. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Rows (header included) to CSV text, one line per row. */
export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}
