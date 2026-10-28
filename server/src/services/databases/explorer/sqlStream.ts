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

/** Statement text without its leading comments (to recognise its first keyword). */
export function stripLeadingComments(sql: string): string {
  let s = sql;
  for (;;) {
    const t = s.replace(/^\s+/, '');
    if (t.startsWith('--') || t.startsWith('#')) {
      const nl = t.indexOf('\n');
      s = nl < 0 ? '' : t.slice(nl + 1);
    } else if (t.startsWith('/*') && !/^\/\*M?!/.test(t)) {
      const end = t.indexOf('*/');
      s = end < 0 ? '' : t.slice(end + 2);
    } else return t;
  }
}

export class SqlSplitter {
  private buf = '';
  private i = 0;
  private start = 0;
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
    this.buf += text;
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

  /** Current delimiter (MySQL DELIMITER). */
  get currentDelimiter(): string {
    return this.delimiter;
  }

  private adv(to: number): void {
    for (let k = this.i; k < to; k++) if (this.buf.charCodeAt(k) === 10) this.line++;
    this.i = to;
  }

  private mark(): void {
    if (!this.meaningful) {
      this.meaningful = true;
      this.stmtLine = this.line;
    }
  }

  /** Only blanks between the last line break (or the statement start) and i. */
  private atLineStart(): boolean {
    for (let k = this.i - 1; k >= this.start; k--) {
      const c = this.buf[k];
      if (c === '\n') return true;
      if (c !== ' ' && c !== '\t' && c !== '\r') return false;
    }
    return true;
  }

  private emitStatement(out: SplitItem[], end: number): void {
    const sql = this.buf.slice(this.start, end).trim();
    if (sql && this.meaningful) {
      if (this.psql && COPY_FROM_STDIN.test(stripLeadingComments(sql))) {
        out.push({ kind: 'copy', sql, line: this.stmtLine });
        this.state = { t: 'copySkip' };
      } else out.push({ kind: 'statement', sql, line: this.stmtLine });
    }
    this.meaningful = false;
    this.stmtLine = 0;
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
          // The data starts on the line after the COPY statement.
          const nl = buf.indexOf('\n', i);
          if (nl < 0) { if (!final) break loop; this.adv(n()); break; }
          this.adv(nl + 1);
          this.start = this.i;
          this.state = { t: 'copy' };
          this.copyLine = this.line;
          continue;
        }
        case 'copy': {
          const nl = buf.indexOf('\n', i);
          if (nl < 0 && !final) {
            if (n() - i > this.max) throw new AppError(413, 'COPY data line too long', 'statementTooLarge');
            break loop;
          }
          const end = nl < 0 ? n() : nl;
          const row = buf.slice(i, end).replace(/\r$/, '');
          const lineNo = this.line;
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
          let k = i;
          while (k < n()) {
            const c = buf[k];
            if (c === '\\' && st.escapes) {
              if (k + 1 >= n()) break;
              k += 2;
              continue;
            }
            if (c === st.q) {
              if (k + 1 >= n() && !final) break;
              if (buf[k + 1] === st.q) { k += 2; continue; }
              this.adv(k + 1);
              this.state = { t: 'normal' };
              continue loop;
            }
            k++;
          }
          this.adv(Math.min(k, n()));
          if (final) { this.adv(n()); break loop; }
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
                const nl = buf.indexOf('\n', i);
                if (nl < 0 && !final) break loop;
                const lineText = buf.slice(i, nl < 0 ? n() : nl);
                const tok = lineText.slice(10).trim().split(/\s+/)[0] ?? '';
                if (!tok) throw new AppError(400, `DELIMITER without a delimiter (line ${this.line})`, 'sqlError');
                out.push({ kind: 'meta', text: lineText.trim(), line: this.line });
                this.delimiter = tok;
                this.adv(nl < 0 ? n() : nl + 1);
                this.start = this.i;
                continue;
              }
            }
            if (this.psql && c === '\\') {
              const nl = buf.indexOf('\n', i);
              if (nl < 0 && !final) break loop;
              out.push({ kind: 'meta', text: buf.slice(i, nl < 0 ? n() : nl).trim(), line: this.line });
              this.adv(nl < 0 ? n() : nl + 1);
              this.start = this.i;
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
      } else {
        this.emitStatement(out, n());
      }
      this.start = n();
    }
    if (this.i - this.start > this.max) throw new AppError(413, `Statement too long (line ${this.stmtLine || this.line})`, 'statementTooLarge');
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
