import type { DbFamily } from '@oblimint/shared';
import { AppError } from '../../../middleware/errorHandler';

// ─────────────────────────────────────────────────────────────────────────────
// Incremental SQL splitter (console input and streamed imports). Text is
// pushed in chunks; complete items come out as soon as their end is seen, so
// a dump of any size is never held whole (one statement at most).
//
//   - quotes: '…' and "…" (MySQL: also `…`, backslash escapes; PostgreSQL:
//     backslash escapes in E'…' only), doubled quotes;
//   - comments: -- (MySQL: followed by a blank), # (MySQL), /* … */ (nested
//     on PostgreSQL); MySQL executable comments /*! … */ and /*M! … */ count
//     as code (mysqldump's SET / DISABLE KEYS lines);
//   - PostgreSQL dollar quoting ($$ … $$, $tag$ … $tag$, never inside an
//     identifier such as a$b$);
//   - MySQL client command DELIMITER (routines / triggers of a dump);
//   - PostgreSQL (imports): psql meta-commands (a line starting with \ between
//     statements: \restrict, \connect…) are reported and skipped; the data of
//     COPY … FROM stdin (up to the "\." line) comes out as raw lines.
// Each statement carries the 1-based line of its first character of code.
//
// Linear time whatever the input: every character is scanned once (the scan
// position always moves forward, never re-reads what a previous chunk saw),
// the text of the item in progress is kept as a list of pieces joined once at
// its end, and what is held at any time is capped (a statement / COPY line:
// maxStatement; a client command line: CLIENT_COMMAND_MAX).
// ─────────────────────────────────────────────────────────────────────────────

export type SplitItem =
  | { kind: 'statement'; sql: string; line: number }
  /** COPY … FROM stdin: copyData items follow, then copyEnd. */
  | { kind: 'copy'; sql: string; line: number }
  | { kind: 'copyData'; rows: string[]; line: number }
  | { kind: 'copyEnd'; line: number }
  /** A client command skipped (psql meta-command, DELIMITER). */
  | { kind: 'meta'; text: string; line: number };

export interface SplitterOptions {
  family: DbFamily;
  /** PostgreSQL: skip psql meta-commands and read COPY … FROM stdin data (imports). Default false. */
  psql?: boolean;
  /** MySQL: the DELIMITER client command. Default true. */
  delimiterCommand?: boolean;
  /** Largest statement / COPY line (characters). */
  maxStatement?: number;
}

type State =
  | { t: 'normal' }
  | { t: 'quote'; q: string; escapes: boolean }
  | { t: 'line' }
  | { t: 'block'; depth: number }
  | { t: 'dollar'; tag: string }
  | { t: 'copySkip' }
  | { t: 'copy' };

const ID_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const COPY_FROM_STDIN = /^copy\s[\s\S]*?\sfrom\s+stdin\b/i;
export const MAX_STATEMENT_CHARS = 64 * 1024 * 1024;
/** A client command line (DELIMITER, psql meta-command), or what follows COPY … FROM stdin; on its line. */
export const CLIENT_COMMAND_MAX = 4096;
/** Characters before the scan position a rule may look at (E'…', $tag$ after an identifier). */
const LOOKBACK = 2;

const isBlank = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

/** MySQL: `--` starts a comment only when followed by a blank / control character (or the end). */
const myDashComment = (next: string | undefined) => next === undefined || /[\s\x00-\x1f]/.test(next);

/**
 * Statement text without its leading comments, by the splitter's rules: PostgreSQL block comments
 * nest (a comment ends at its matching close, not at the first one), `#` is a comment on MySQL only,
 * MySQL `--` needs a blank after it, and a MySQL executable comment (`/*!`, `/*M!`) is code.
 */
export function stripLeadingComments(sql: string, family: DbFamily): string {
  const pg = family === 'postgresql';
  const n = sql.length;
  let i = 0;
  for (;;) {
    while (i < n && isBlank(sql[i])) i++;
    if (sql.startsWith('--', i) && (pg || myDashComment(sql[i + 2])) || (!pg && sql[i] === '#')) {
      const nl = sql.indexOf('\n', i);
      if (nl < 0) return '';
      i = nl + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      if (!pg && (sql[i + 2] === '!' || (sql[i + 2] === 'M' && sql[i + 3] === '!'))) return sql.slice(i);
      let depth = 1;
      let k = i + 2;
      while (k < n && depth) {
        if (sql[k] === '*' && sql[k + 1] === '/') { depth--; k += 2; } else if (pg && sql[k] === '/' && sql[k + 1] === '*') { depth++; k += 2; } else k++;
      }
      if (depth) return '';
      i = k;
      continue;
    }
    return sql.slice(i);
  }
}

/** First keyword of a statement (leading comments and parentheses skipped; a MySQL executable comment is no keyword). */
export function firstKeyword(sql: string, family: DbFamily): string {
  let s = sql;
  for (;;) {
    const t = stripLeadingComments(s, family).replace(/^[\s(]+/, '');
    if (t === s) break;
    s = t;
  }
  return (/^[A-Za-z]+/.exec(s)?.[0] ?? '').toLowerCase();
}

/**
 * The statement as audited: string literals (quoted, E'…', X'…', dollar-quoted bodies) and numbers
 * replaced by `?`, comments dropped; keywords and identifiers (quoted or not) kept. Same lexical
 * rules as the splitter.
 */
export function maskSqlLiterals(sql: string, family: DbFamily): string {
  const pg = family === 'postgresql';
  const n = sql.length;
  const out: string[] = [];
  let i = 0;
  let run = 0;
  const flush = (to: number) => { if (to > run) out.push(sql.slice(run, to)); };
  const literal = (from: number, to: number) => {
    // A one-letter prefix (E'…', X'…', B'…', N'…') goes with the literal.
    let s = from;
    if (s > run && /[EeXxBbNn]/.test(sql[s - 1]) && !ID_CHAR.test(sql[s - 2] ?? ' ')) s--;
    flush(s);
    out.push('?');
    i = to;
    run = to;
  };
  const drop = (to: number) => { flush(i); out.push(' '); i = to; run = to; };
  while (i < n) {
    const c = sql[i];
    const prev = sql[i - 1] ?? ' ';
    if ((c === '-' && sql[i + 1] === '-' && (pg || myDashComment(sql[i + 2]))) || (!pg && c === '#')) {
      const nl = sql.indexOf('\n', i);
      drop(nl < 0 ? n : nl);
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      if (!pg && (sql[i + 2] === '!' || (sql[i + 2] === 'M' && sql[i + 3] === '!'))) {
        // Executable comment: code; its version number is no literal.
        i += sql[i + 2] === '!' ? 3 : 4;
        while (i < n && sql[i] >= '0' && sql[i] <= '9') i++;
        continue;
      }
      let depth = 1;
      let k = i + 2;
      while (k < n && depth) {
        if (sql[k] === '*' && sql[k + 1] === '/') { depth--; k += 2; } else if (pg && sql[k] === '/' && sql[k + 1] === '*') { depth++; k += 2; } else k++;
      }
      drop(k);
      continue;
    }
    if (c === '\'' || (c === '"' && !pg)) {
      const escapes = !pg || ((prev === 'E' || prev === 'e') && !ID_CHAR.test(sql[i - 2] ?? ' '));
      let k = i + 1;
      while (k < n) {
        if (sql[k] === '\\' && escapes) { k += 2; continue; }
        if (sql[k] === c) { if (sql[k + 1] === c) { k += 2; continue; } k++; break; }
        k++;
      }
      literal(i, Math.min(k, n));
      continue;
    }
    if ((c === '"' && pg) || (c === '`' && !pg)) {
      // A quoted identifier: kept as written.
      let k = i + 1;
      while (k < n) { if (sql[k] === c) { if (sql[k + 1] === c) { k += 2; continue; } k++; break; } k++; }
      i = Math.min(k, n);
      continue;
    }
    if (pg && c === '$' && !ID_CHAR.test(prev)) {
      const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i, i + 66));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        literal(i, end < 0 ? n : end + m[0].length);
        continue;
      }
    }
    if (((c >= '0' && c <= '9') || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) && !ID_CHAR.test(prev) && prev !== '.') {
      const m = /^(?:0x[0-9A-Fa-f]+|0b[01]+|\d*\.?\d+(?:[eE][+-]?\d+)?|\d+\.)/.exec(sql.slice(i, i + 400))!;
      const end = i + m[0].length;
      if (end < n && ID_CHAR.test(sql[end])) {
        // MySQL allows identifiers starting with digits (1abc): kept.
        let k = end;
        while (k < n && ID_CHAR.test(sql[k])) k++;
        i = k;
        continue;
      }
      literal(i, end);
      continue;
    }
    i++;
  }
  flush(n);
  return out.join('');
}

export class SqlSplitter {
  private buf = '';
  private i = 0;
  private start = 0;
  /** Text of the item in progress already scanned and moved out of buf (joined once, at its end). */
  private parts: string[] = [];
  private partsLen = 0;
  /** atLineStart() at the beginning of buf while parts holds the start of the item. */
  private carryLineStart = true;
  /** COPY: characters skipped after the statement on its line. */
  private copySkipped = 0;
  private line = 1;
  private stmtLine = 0;
  private meaningful = false;
  private state: State = { t: 'normal' };
  private delimiter = ';';
  private readonly family: DbFamily;
  private readonly psql: boolean;
  private readonly delimiterCommand: boolean;
  private readonly max: number;
  private copyLine = 0;

  constructor(opts: SplitterOptions) {
    this.family = opts.family;
    this.psql = opts.family === 'postgresql' && opts.psql === true;
    this.delimiterCommand = opts.family === 'mysql' && opts.delimiterCommand !== false;
    this.max = opts.maxStatement ?? MAX_STATEMENT_CHARS;
  }

  push(text: string): SplitItem[] {
    this.buf = this.buf.length ? this.buf + text : text;
    return this.scan(false);
  }

  end(): SplitItem[] {
    return this.scan(true);
  }

  private run: { d: string; re: RegExp } | null = null;

  private runRe(): RegExp {
    if (!this.run || this.run.d !== this.delimiter) {
      const d0 = this.delimiter[0].replace(/[\\\]^-]/g, '\\$&');
      this.run = { d: this.delimiter, re: new RegExp(`[^'"\`\\-#/$\\\\\\n${d0}]+`, 'y') };
    }
    return this.run.re;
  }

  private static quoteRes = new Map<string, RegExp>();

  /** Sticky run of characters that cannot end (or escape inside) a quote. */
  private static quoteRe(q: string, escapes: boolean): RegExp {
    const k = `${q}${escapes ? '\\' : ''}`;
    let re = SqlSplitter.quoteRes.get(k);
    if (!re) {
      re = new RegExp(`[^${q === '\'' ? '\'' : q}${escapes ? '\\\\' : ''}]*`, 'y');
      SqlSplitter.quoteRes.set(k, re);
    }
    return re;
  }

  /** Current delimiter (MySQL DELIMITER). */
  get currentDelimiter(): string {
    return this.delimiter;
  }

  private adv(to: number): void {
    const buf = this.buf;
    let line = this.line;
    for (let k = this.i; k < to; k++) if (buf.charCodeAt(k) === 10) line++;
    this.line = line;
    this.i = to;
  }

  private mark(): void {
    if (!this.meaningful) {
      this.meaningful = true;
      this.stmtLine = this.line;
    }
  }

  /** Only blanks between the last line break (or the statement start) and pos. */
  private atLineStart(pos = this.i): boolean {
    for (let k = pos - 1; k >= this.start; k--) {
      const c = this.buf[k];
      if (c === '\n') return true;
      if (c !== ' ' && c !== '\t' && c !== '\r') return false;
    }
    return this.parts.length ? this.carryLineStart : true;
  }

  /** Text of the item in progress up to `end` (buf index); the pieces are released. */
  private take(end: number): string {
    const tail = this.buf.slice(this.start, end);
    if (!this.parts.length) return tail;
    const s = this.parts.join('') + tail;
    this.parts = [];
    this.partsLen = 0;
    return s;
  }

  /** Forgets the item in progress (skipped text) and starts the next one at the scan position. */
  private dropPending(): void {
    this.parts = [];
    this.partsLen = 0;
    this.start = this.i;
  }

  private emitStatement(out: SplitItem[], end: number): void {
    const sql = this.take(end).trim();
    if (sql && this.meaningful) {
      if (this.psql && COPY_FROM_STDIN.test(stripLeadingComments(sql, this.family))) {
        out.push({ kind: 'copy', sql, line: this.stmtLine });
        this.state = { t: 'copySkip' };
        this.copySkipped = 0;
      } else out.push({ kind: 'statement', sql, line: this.stmtLine });
    }
    this.meaningful = false;
    this.stmtLine = 0;
  }

  /** A client command line (DELIMITER, psql meta-command) starting at i: its text, or null when its end is not in buf yet. */
  private commandLine(final: boolean): { text: string; next: number } | null {
    const buf = this.buf;
    const nl = buf.indexOf('\n', this.i);
    const end = nl < 0 ? buf.length : nl;
    if (end - this.i > CLIENT_COMMAND_MAX) throw new AppError(413, `Client command line too long (line ${this.line})`, 'statementTooLarge');
    if (nl < 0 && !final) return null;
    return { text: buf.slice(this.i, end), next: nl < 0 ? buf.length : nl + 1 };
  }

  private scan(final: boolean): SplitItem[] {
    const out: SplitItem[] = [];
    let copyRows: string[] = [];
    let copyRowsLine = 0;
    const flushCopy = () => {
      if (copyRows.length) out.push({ kind: 'copyData', rows: copyRows, line: copyRowsLine });
      copyRows = [];
    };
    const n = () => this.buf.length;
    loop: while (this.i < n()) {
      const st = this.state;
      const buf = this.buf;
      const i = this.i;
      switch (st.t) {
        case 'copySkip': {
          // The data starts on the line after the COPY statement (the rest of its line is skipped).
          const nl = buf.indexOf('\n', i);
          const end = nl < 0 ? n() : nl;
          this.copySkipped += end - i;
          if (this.copySkipped > CLIENT_COMMAND_MAX) throw new AppError(413, `COPY statement line too long (line ${this.line})`, 'statementTooLarge');
          if (nl < 0) { this.adv(n()); this.dropPending(); break loop; }
          this.adv(nl + 1);
          this.dropPending();
          this.state = { t: 'copy' };
          this.copyLine = this.line;
          continue;
        }
        case 'copy': {
          // start = beginning of the data line; i = where the search for its end resumes.
          const nl = buf.indexOf('\n', i);
          if (nl < 0 && !final) { this.i = n(); break loop; }
          const end = nl < 0 ? n() : nl;
          const lineNo = this.line;
          const row = this.take(end).replace(/\r$/, '');
          this.adv(nl < 0 ? n() : nl + 1);
          this.start = this.i;
          if (row === '\\.') {
            flushCopy();
            out.push({ kind: 'copyEnd', line: lineNo });
            this.state = { t: 'normal' };
            continue;
          }
          if (!copyRows.length) copyRowsLine = lineNo;
          copyRows.push(row);
          if (copyRows.length >= 500) flushCopy();
          continue;
        }
        case 'quote': {
          const re = SqlSplitter.quoteRe(st.q, st.escapes);
          let k = i;
          for (;;) {
            re.lastIndex = k;
            re.exec(buf);
            k = re.lastIndex;
            if (k >= n()) break;
            if (buf[k] === '\\') { // escapes only
              if (k + 1 >= n()) break;
              k += 2;
              continue;
            }
            if (k + 1 >= n() && !final) break;
            if (buf[k + 1] === st.q) { k += 2; continue; }
            this.adv(k + 1);
            this.state = { t: 'normal' };
            continue loop;
          }
          this.adv(Math.min(k, n()));
          if (final) this.adv(n());
          break loop;
        }
        case 'line': {
          const nl = buf.indexOf('\n', i);
          if (nl < 0) { this.adv(n()); break loop; }
          this.adv(nl + 1);
          this.state = { t: 'normal' };
          continue;
        }
        case 'block': {
          let k = i;
          let depth = st.depth;
          while (k < n()) {
            if (buf[k] === '*' && buf[k + 1] === '/') { k += 2; depth--; if (!depth) break; continue; }
            if (this.family === 'postgresql' && buf[k] === '/' && buf[k + 1] === '*') { k += 2; depth++; continue; }
            if ((buf[k] === '*' || buf[k] === '/') && k + 1 >= n() && !final) break;
            k++;
          }
          this.adv(Math.min(k, n()));
          if (!depth) { this.state = { t: 'normal' }; continue; }
          this.state = { t: 'block', depth };
          break loop;
        }
        case 'dollar': {
          const end = buf.indexOf(st.tag, i);
          if (end < 0) {
            this.adv(Math.max(i, n() - st.tag.length + 1));
            if (final) this.adv(n());
            break loop;
          }
          this.adv(end + st.tag.length);
          this.state = { t: 'normal' };
          continue;
        }
        case 'normal': {
          if (this.meaningful) {
            // Fast path inside a statement: a run of ordinary characters (no line break: line counting stays exact).
            const re = this.runRe();
            re.lastIndex = i;
            const m = re.exec(buf);
            if (m && m[0].length > 1) { this.i = i + m[0].length; continue; }
          }
          const c = buf[i];
          // Client commands between statements.
          if (!this.meaningful && (this.delimiterCommand || this.psql) && (c === 'd' || c === 'D' || c === '\\') && this.atLineStart()) {
            if (this.delimiterCommand && (c === 'd' || c === 'D')) {
              const head = buf.slice(i, i + 10);
              if (head.length < 10 && !final && 'delimiter '.startsWith(head.toLowerCase())) break loop;
              if (/^delimiter[ \t]/i.test(head)) {
                const cmd = this.commandLine(final);
                if (!cmd) break loop;
                const tok = cmd.text.slice(10).trim().split(/\s+/)[0] ?? '';
                if (!tok) throw new AppError(400, `DELIMITER without a delimiter (line ${this.line})`, 'sqlError');
                out.push({ kind: 'meta', text: cmd.text.trim(), line: this.line });
                this.delimiter = tok;
                this.adv(cmd.next);
                this.dropPending();
                continue;
              }
            }
            if (this.psql && c === '\\') {
              const cmd = this.commandLine(final);
              if (!cmd) break loop;
              out.push({ kind: 'meta', text: cmd.text.trim(), line: this.line });
              this.adv(cmd.next);
              this.dropPending();
              continue;
            }
          }
          // Statement end.
          const d = this.delimiter;
          if (c === d[0]) {
            if (d.length === 1 || buf.startsWith(d, i)) {
              this.emitStatement(out, i);
              this.adv(i + d.length);
              this.start = this.i;
              continue;
            }
            if (n() - i < d.length && d.startsWith(buf.slice(i)) && !final) break loop;
          }
          if (c === '\'' || c === '"' || (c === '`' && this.family === 'mysql')) {
            this.mark();
            let escapes = this.family === 'mysql' && c !== '`';
            if (this.family === 'postgresql' && c === '\'' && (buf[i - 1] === 'E' || buf[i - 1] === 'e') && !ID_CHAR.test(buf[i - 2] ?? ' ')) escapes = true;
            this.state = { t: 'quote', q: c, escapes };
            this.adv(i + 1);
            continue;
          }
          if (c === '-' ) {
            if (i + 1 >= n() && !final) break loop;
            if (buf[i + 1] === '-') {
              if (this.family === 'mysql') {
                if (i + 2 >= n() && !final) break loop;
                const c3 = buf[i + 2];
                if (c3 !== undefined && !/[\s\x00-\x1f]/.test(c3)) { this.mark(); this.adv(i + 1); continue; }
              }
              this.state = { t: 'line' };
              this.adv(i + 2);
              continue;
            }
          }
          if (c === '#' && this.family === 'mysql') {
            this.state = { t: 'line' };
            this.adv(i + 1);
            continue;
          }
          if (c === '/') {
            if (i + 1 >= n() && !final) break loop;
            if (buf[i + 1] === '*') {
              if (this.family === 'mysql') {
                if (i + 3 >= n() && !final) break loop;
                if (buf[i + 2] === '!' || (buf[i + 2] === 'M' && buf[i + 3] === '!')) this.mark();
              }
              this.state = { t: 'block', depth: 1 };
              this.adv(i + 2);
              continue;
            }
          }
          if (c === '$' && this.family === 'postgresql' && !ID_CHAR.test(buf[i - 1] ?? ' ')) {
            const rest = buf.slice(i, i + 66);
            const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(rest);
            if (m) {
              this.mark();
              this.state = { t: 'dollar', tag: m[0] };
              this.adv(i + m[0].length);
              continue;
            }
            if (!final && /^\$[A-Za-z0-9_\u0080-￿]*$/.test(rest) && rest.length < 66) break loop;
          }
          if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') this.mark();
          this.adv(i + 1);
          continue;
        }
      }
    }
    flushCopy();
    if (final) {
      if (this.state.t === 'copy' || this.state.t === 'copySkip') {
        out.push({ kind: 'copyEnd', line: this.line });
        this.state = { t: 'normal' };
        this.i = n();
        this.dropPending();
      } else {
        this.emitStatement(out, n());
      }
      this.parts = [];
      this.partsLen = 0;
      this.start = n();
    }
    // The scanned part of the item in progress leaves buf (a few characters stay for the rules that look back).
    const keep = Math.max(this.start, this.i - LOOKBACK);
    if (keep > this.start) {
      this.carryLineStart = this.atLineStart(keep);
      this.parts.push(this.buf.slice(this.start, keep));
      this.partsLen += keep - this.start;
      this.start = keep;
    }
    if (this.partsLen + n() - this.start > this.max) {
      throw new AppError(413, this.state.t === 'copy' ? `COPY data line too long (line ${this.line})` : `Statement too long (line ${this.stmtLine || this.line})`, 'statementTooLarge');
    }
    if (this.start > 0) {
      this.buf = this.buf.slice(this.start);
      this.i -= this.start;
      this.start = 0;
    }
    return out;
  }
}

/** Console input → statements (DELIMITER understood on MySQL; no COPY / psql meta-commands). */
export function splitStatements(input: string, family: DbFamily): Array<{ sql: string; line: number }> {
  const s = new SqlSplitter({ family });
  return [...s.push(input), ...s.end()].flatMap((x) => (x.kind === 'statement' || x.kind === 'copy' ? [{ sql: x.sql, line: x.line }] : []));
}
