import type { DbFamily } from '@oblimint/shared';

/**
 * Splits an SQL console input into statements on top-level `;`: quotes
 * ('…', "…", `…` for MySQL), comments (--, # for MySQL, /* … *\/) and
 * PostgreSQL dollar quoting ($$ … $$, $tag$ … $tag$) are skipped. Empty
 * statements (only blanks / comments) are dropped. No DELIMITER support:
 * a MySQL routine body is sent as written in one statement only when the
 * input holds that statement alone.
 */
export function splitSql(input: string, family: DbFamily): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  let meaningful = false;
  const n = input.length;
  const push = (end: number) => {
    const s = input.slice(start, end).trim();
    if (s && meaningful) out.push(s);
    meaningful = false;
  };
  while (i < n) {
    const c = input[i];
    const next = input[i + 1];
    if (c === '-' && next === '-' && (family === 'postgresql' || /\s/.test(input[i + 2] ?? ' '))) {
      while (i < n && input[i] !== '\n') i++;
      continue;
    }
    if (c === '#' && family === 'mysql') {
      while (i < n && input[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = input.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '\'' || c === '"' || (c === '`' && family === 'mysql')) {
      meaningful = true;
      i++;
      while (i < n) {
        if (input[i] === '\\' && family === 'mysql' && c !== '`') { i += 2; continue; }
        if (input[i] === c) {
          if (input[i + 1] === c) { i += 2; continue; } // doubled quote
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === '$' && family === 'postgresql') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(input.slice(i, i + 64));
      if (m) {
        meaningful = true;
        const tag = m[0];
        const end = input.indexOf(tag, i + tag.length);
        i = end < 0 ? n : end + tag.length;
        continue;
      }
    }
    if (c === ';') {
      push(i);
      start = i + 1;
      i++;
      continue;
    }
    if (!/\s/.test(c)) meaningful = true;
    i++;
  }
  push(n);
  return out;
}
