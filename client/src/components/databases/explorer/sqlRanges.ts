import type { DbFamily } from '@oblimint/shared';

/**
 * Statement ranges of an SQL text (console: Ctrl+Enter runs the statement under
 * the cursor). Same rules as the server splitter (server/…/explorer/sqlStream.ts):
 * quotes, comments, PostgreSQL dollar quoting, MySQL DELIMITER lines. A range
 * covers the statement text without its delimiter.
 */
export interface SqlRange {
  from: number;
  to: number;
  /** MySQL DELIMITER in force (a statement run alone needs no DELIMITER line). */
  delimiter: string;
}

const ID_CHAR = /[A-Za-z0-9_$\u0080-￿]/;

export function sqlRanges(text: string, family: DbFamily): SqlRange[] {
  const out: SqlRange[] = [];
  const n = text.length;
  let delimiter = ';';
  let start = 0;
  let i = 0;
  let code = false;
  const push = (end: number) => {
    if (code) out.push({ from: start, to: end, delimiter });
    code = false;
  };
  while (i < n) {
    const c = text[i];
    if (!code && family === 'mysql' && (c === 'd' || c === 'D') && /(^|\n)[ \t]*$/.test(text.slice(Math.max(start, i - 200), i)) && /^delimiter[ \t]/i.test(text.slice(i, i + 10))) {
      const nl = text.indexOf('\n', i);
      const tok = text.slice(i + 10, nl < 0 ? n : nl).trim().split(/\s+/)[0];
      if (tok) delimiter = tok;
      i = nl < 0 ? n : nl + 1;
      start = i;
      continue;
    }
    if (text.startsWith(delimiter, i)) {
      push(i);
      i += delimiter.length;
      start = i;
      continue;
    }
    if (c === '\'' || c === '"' || (c === '`' && family === 'mysql')) {
      code = true;
      const escapes = (family === 'mysql' && c !== '`') || (family === 'postgresql' && c === '\'' && /[eE]/.test(text[i - 1] ?? '') && !ID_CHAR.test(text[i - 2] ?? ' '));
      i++;
      while (i < n) {
        if (text[i] === '\\' && escapes) { i += 2; continue; }
        if (text[i] === c) { if (text[i + 1] === c) { i += 2; continue; } break; }
        i++;
      }
      i++;
      continue;
    }
    if ((c === '-' && text[i + 1] === '-' && (family === 'postgresql' || /[\s\x00-\x1f]/.test(text[i + 2] ?? ' '))) || (c === '#' && family === 'mysql')) {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      if (family === 'mysql' && (text[i + 2] === '!' || (text[i + 2] === 'M' && text[i + 3] === '!'))) code = true;
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '$' && family === 'postgresql' && !ID_CHAR.test(text[i - 1] ?? ' ')) {
      const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(text.slice(i, i + 66));
      if (m) {
        code = true;
        const end = text.indexOf(m[0], i + m[0].length);
        i = end < 0 ? n : end + m[0].length;
        continue;
      }
    }
    if (!/\s/.test(c)) code = true;
    i++;
  }
  push(n);
  return out;
}

/**
 * The statement under (or just before) `pos`, ready to run alone: a MySQL
 * statement written under another DELIMITER (routine body) is wrapped in
 * DELIMITER lines so its inner ; stay inside.
 */
export function statementAt(text: string, pos: number, family: DbFamily): string | null {
  const ranges = sqlRanges(text, family);
  if (!ranges.length) return null;
  let pick = ranges[0];
  for (const r of ranges) {
    if (r.from <= pos) pick = r;
    if (pos <= r.to + r.delimiter.length) break;
  }
  const sql = text.slice(pick.from, pick.to).trim();
  if (!sql) return null;
  return pick.delimiter === ';' ? sql : `DELIMITER ${pick.delimiter}\n${sql}${pick.delimiter}\nDELIMITER ;`;
}
