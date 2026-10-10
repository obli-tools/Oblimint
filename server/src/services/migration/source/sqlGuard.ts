// ─────────────────────────────────────────────────────────────────────────────
// SQL guard of mysql.query (docs/P5-PLAN.md §5.4) — PURE.
//
// A small lexer (strings '…', "…" and identifiers `…`, with their escapes) then
// rules on the token stream: exactly ONE statement (a trailing `;` is
// tolerated), first keyword SELECT or SHOW, no comment of any kind (`--`, `#`,
// `/* */`, `/*! */` — the last one is EXECUTED by MySQL), no INTO (OUTFILE /
// DUMPFILE / @variable), no file / lock / sleep functions, no locking reads, no
// SET / CALL / HANDLER / assignment, no PROCEDURE ANALYSE, and never a hash
// column: identifiers password / authentication_string / token (and the
// look-alikes listed below) are refused outside string literals — bare,
// qualified or back-quoted — and `SELECT *` is refused (it would return them
// without naming them). Hashes only flow through the secret.* templates.
// Refuse rather than sanitize: a refused query is logged 'refused'.
//
// mysql CLIENT commands (MG1): the statement is rendered as `mysql -e '<sql>'`
// and the client's add_line() executes one-character commands (`\!` shell,
// `\T` tee, `\.` source, `\g` send-and-continue…) anywhere outside a string,
// and named commands (`system`, `source`, `delimiter`…) at the start of a
// line. So: NO backslash anywhere (not even inside a literal — under
// NO_BACKSLASH_ESCAPES the client and this lexer would disagree on where a
// string ends), no control character at all inside a literal, and the ASCII
// whitespace outside literals (\t \n \r \f \v) is rendered as a plain space:
// the rendered statement is always a single line.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_SQL_BYTES = 16 * 1024;

export class SqlGuardError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'SqlGuardError';
  }
}

type Token =
  | { kind: 'word'; value: string; upper: string }
  | { kind: 'ident'; value: string; lower: string }
  | { kind: 'string'; quote: "'" | '"'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'sym'; value: string };

/** ASCII whitespace only: anything else (NBSP…) is an identifier character for MySQL. */
const WS = /[ \t\n\r\f\v]/;
/** Control characters (C0 except the whitespace above, and DEL). */
const CTRL = /[\x00-\x08\x0e-\x1f\x7f]/;

/** Lexes a statement. Throws SqlGuardError on comments, unterminated strings, backslashes, control characters. */
export function lexSql(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === '\0') throw new SqlGuardError('NUL character');
    if (c === '\\') throw new SqlGuardError('backslash (mysql client command / escape)');
    if (CTRL.test(c)) throw new SqlGuardError('control character');
    if (WS.test(c)) { i++; continue; }
    if (c === '#') throw new SqlGuardError('comment (#)');
    if (c === '-' && sql[i + 1] === '-') throw new SqlGuardError('comment (--)');
    if (c === '/' && sql[i + 1] === '*') throw new SqlGuardError('comment (/* */)');
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < n) {
        const d = sql[j];
        if (d === '\0') throw new SqlGuardError('NUL character');
        if (d === '\\') throw new SqlGuardError('backslash (mysql client command / escape)');
        if (CTRL.test(d) || (WS.test(d) && d !== ' ')) throw new SqlGuardError('control character inside a string or identifier');
        if (d === q) {
          if (sql[j + 1] === q) { value += q; j += 2; continue; }
          closed = true;
          j++;
          break;
        }
        value += d;
        j++;
      }
      if (!closed) throw new SqlGuardError('unterminated string or identifier');
      if (q === '`') out.push({ kind: 'ident', value, lower: value.toLowerCase() });
      else out.push({ kind: 'string', quote: q, value });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9A-Za-z_.$]/.test(sql[j])) j++;
      const value = sql.slice(i, j);
      // 1abc is an identifier in MySQL: treat letters-containing tokens as words.
      if (/^[0-9.]+(e[0-9]+)?$/i.test(value) || /^0x[0-9a-f]+$/i.test(value)) out.push({ kind: 'number', value });
      else out.push({ kind: 'word', value, upper: value.toUpperCase() });
      i = j;
      continue;
    }
    if (/[A-Za-z_$@]/.test(c) || c.charCodeAt(0) > 127) {
      let j = i;
      while (j < n && (/[A-Za-z0-9_$@]/.test(sql[j]) || sql.charCodeAt(j) > 127)) j++;
      const value = sql.slice(i, j);
      out.push({ kind: 'word', value, upper: value.toUpperCase() });
      i = j;
      continue;
    }
    // Two-character operators that matter.
    const two = sql.slice(i, i + 2);
    if (two === ':=' || two === '<=' || two === '>=' || two === '<>' || two === '!=' || two === '||' || two === '&&' || two === '<<' || two === '>>') {
      out.push({ kind: 'sym', value: two });
      i += 2;
      continue;
    }
    out.push({ kind: 'sym', value: c });
    i++;
  }
  return out;
}

/** Functions / words refused anywhere outside literals. */
const FORBIDDEN_WORDS = new Set([
  'INTO', 'OUTFILE', 'DUMPFILE', 'LOAD_FILE', 'SLEEP', 'BENCHMARK', 'GET_LOCK', 'RELEASE_LOCK', 'RELEASE_ALL_LOCKS',
  'SET', 'CALL', 'HANDLER', 'NEXTVAL', 'SETVAL', 'LASTVAL', 'MASTER_POS_WAIT', 'MASTER_GTID_WAIT', 'SYS_EXEC', 'SYS_EVAL',
]);

/** Identifier fragments that designate a credential column / table. */
const SECRET_IDENT = /(password|passwd|authentication_string|token|secret|global_priv)/i;

/** Adjacent keyword pairs refused (locking reads, PROCEDURE ANALYSE, sequences, grants dump). */
const FORBIDDEN_PAIRS: ReadonlyArray<[string, string, string]> = [
  ['FOR', 'UPDATE', 'FOR UPDATE'],
  ['LOCK', 'IN', 'LOCK IN SHARE MODE'],
  ['PROCEDURE', 'ANALYSE', 'PROCEDURE ANALYSE'],
  ['NEXT', 'VALUE', 'NEXT VALUE FOR'],
  ['PREVIOUS', 'VALUE', 'PREVIOUS VALUE FOR'],
];

/**
 * Validates a read-only statement. Returns the statement without its trailing
 * `;` (what is rendered). Throws SqlGuardError with the reason.
 */
export function checkSql(sql: unknown): string {
  if (typeof sql !== 'string') throw new SqlGuardError('not a string');
  if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) throw new SqlGuardError(`longer than ${MAX_SQL_BYTES} bytes`);
  const tokens = lexSql(sql);
  if (tokens.length === 0) throw new SqlGuardError('empty statement');

  // One statement: a `;` may only be the very last token.
  let end = tokens.length;
  if (tokens[end - 1].kind === 'sym' && tokens[end - 1].value === ';') end--;
  for (let k = 0; k < end; k++) {
    const t = tokens[k];
    if (t.kind === 'sym' && t.value === ';') throw new SqlGuardError('more than one statement');
  }
  if (end === 0) throw new SqlGuardError('empty statement');

  const first = tokens[0];
  if (first.kind !== 'word' || (first.upper !== 'SELECT' && first.upper !== 'SHOW')) {
    throw new SqlGuardError('only SELECT and SHOW statements are allowed');
  }

  for (let k = 0; k < end; k++) {
    const t = tokens[k];
    const next = tokens[k + 1];
    if (t.kind === 'sym') {
      if (t.value === ':=') throw new SqlGuardError('variable assignment (:=)');
      if (t.value === '*') {
        // Only COUNT(*)-like uses: `(` `*` `)`. A select-list star would return hash columns unnamed.
        const prev = tokens[k - 1];
        if (!(prev?.kind === 'sym' && prev.value === '(' && next?.kind === 'sym' && next.value === ')')) {
          throw new SqlGuardError('* is only allowed as COUNT(*) (name the columns)');
        }
      }
      continue;
    }
    if (t.kind === 'word') {
      if (FORBIDDEN_WORDS.has(t.upper)) throw new SqlGuardError(`forbidden keyword ${t.upper}`);
      if (t.upper.startsWith('@') && next?.kind === 'sym' && (next.value === '=' || next.value === ':=')) {
        // `@@x = …` is only an assignment after SET (refused anyway); kept for clarity.
        throw new SqlGuardError('variable assignment');
      }
      if (SECRET_IDENT.test(t.value)) throw new SqlGuardError(`credential column / table ${t.value}`);
      for (const [a, b, label] of FORBIDDEN_PAIRS) {
        if (t.upper === a && next?.kind === 'word' && next.upper === b) throw new SqlGuardError(`forbidden clause ${label}`);
      }
      continue;
    }
    if (t.kind === 'ident') {
      if (SECRET_IDENT.test(t.value)) throw new SqlGuardError(`credential column / table \`${t.value}\``);
      continue;
    }
    if (t.kind === 'string' && t.quote === '"') {
      // Under ANSI_QUOTES a "…" is an identifier: never let it name a credential column.
      if (SECRET_IDENT.test(t.value) && /^[A-Za-z0-9_$]+$/.test(t.value)) {
        throw new SqlGuardError(`credential column "${t.value}" (double-quoted)`);
      }
    }
  }

  // SHOW GRANTS / SHOW CREATE USER print `IDENTIFIED BY PASSWORD '*…'` on MariaDB.
  if (first.upper === 'SHOW') {
    const words = tokens.slice(1, end).filter((t) => t.kind === 'word').map((t) => (t as { upper: string }).upper);
    if (words[0] === 'GRANTS') throw new SqlGuardError('SHOW GRANTS prints password hashes');
    if (words[0] === 'CREATE' && words[1] === 'USER') throw new SqlGuardError('SHOW CREATE USER prints password hashes');
  }

  // Render on ONE line (the lexer guaranteed no whitespace control character inside a
  // literal, so this only rewrites separators) and without the trailing ';'.
  // ASCII trim only: a non-ASCII space is part of an identifier for MySQL.
  let s = sql.replace(/[\t\n\r\f\v]/g, ' ').replace(/^ +| +$/g, '');
  if (s.endsWith(';')) s = s.slice(0, -1).replace(/ +$/, '');
  return s;
}
