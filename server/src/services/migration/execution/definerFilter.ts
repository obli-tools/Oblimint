import { Transform, type TransformCallback } from 'stream';
import { mysqlAccount } from '../../databases/sql';

// ─────────────────────────────────────────────────────────────────────────────
// DEFINER filter of a CWP dump (docs/P5-PLAN.md D-DB, invariant MG7). PURE
// stream transform between the spooled mysqldump and the SQL client of the
// temporary restore user (who holds SET USER during the import). The dump is
// NOT trusted:
//
//  - every `DEFINER=<user>[@<host>]` (backticks, quotes, double quotes, bare
//    words, comments between the tokens; inside /*!50013 … */, /*!50017 … */
//    versioned comments too) whose user is one of the account's MIGRATED
//    database users is kept with its host rewritten to '%' (the only host the
//    migration creates); any other definer (root, another account, a role,
//    CURRENT_ROLE, an orphan…) becomes the restore user (counted: warning
//    dbDefinerForeign) — the dump can never create an object running with
//    someone else's rights. A DEFINER clause the filter cannot read (odd
//    syntax, split over two lines) fails the whole import;
//  - a statement that would act outside the database (CREATE USER, GRANT,
//    DROP USER, USE, CREATE DATABASE, client commands…) fails the import: a
//    mysqldump of ONE database never contains them;
//  - session changes that would make the client split statements differently
//    from this filter (NO_BACKSLASH_ESCAPES, a client character set whose
//    multibyte characters may end in a backslash, sql_mode from an expression)
//    fail the import.
//
// Bounded memory: mysqldump writes one row batch per line (`INSERT INTO …
// VALUES (…),(…);`). Such data statements are streamed through without being
// buffered, but under a lexer that mirrors the mysql client's (quotes,
// backslash escapes, comments, delimiter): the data statement ends at its
// first unquoted ';' and whatever follows it goes through the full filter
// (`INSERT …; CREATE DEFINER=… PROCEDURE …` cannot smuggle a definer). Inside
// a data statement, code outside the literals may not contain comments,
// client commands or user variables (mysqldump never writes them). The
// lexer state is carried across lines, so a literal spanning several lines
// is never mistaken for a new statement. Other lines are buffered whole
// (≤ maxLineBytes) and rewritten. The text is handled as latin1 (byte
// preserving).
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when the dump contains a statement a single-database dump never has. */
export class DumpRefusedError extends Error {
  constructor(public readonly statement: string, public readonly line: number) {
    super(`Dump refusé : instruction interdite « ${statement} » à la ligne ${line} (le dump d'une base ne doit ni créer de compte, ni donner de droits, ni changer de base)`);
    this.name = 'DumpRefusedError';
  }
}

export interface DefinerFilterOptions {
  /** Database users migrated for this account (exact, case-sensitive MySQL user names). */
  migratedUsers: Iterable<string>;
  /** Temporary restore user that receives every foreign definer. */
  restoreUser: string;
  /** Longest non-data line kept in memory (default 16 MiB). */
  maxLineBytes?: number;
}

export interface DefinerFilterStats {
  lines: number;
  /** Definers of migrated users (host rewritten to '%'). */
  kept: number;
  /** Definers rewritten to the restore user. */
  foreign: number;
  /** Distinct foreign definer users (≤ 20, names only). */
  foreignUsers: string[];
}

const DEFAULT_MAX_LINE = 16 * 1024 * 1024;
/** Characters read before deciding whether a line is a data line. */
const HEAD_BYTES = 64;
/** Characters of lookahead the lexer needs (`/*M!`). */
const LOOKAHEAD = 3;

/** One quoted or bare MySQL name. */
const NAME = "`(?:[^`]|``)*`|'(?:[^'\\\\]|\\\\.|'')*'|\"(?:[^\"\\\\]|\\\\.|\"\")*\"|[A-Za-z0-9_$.%:-]+";
/** What MySQL accepts between two tokens: blanks, plain comments, versioned comment openers / closers. */
const SEP = '(?:\\s|/\\*(?!M?!)[\\s\\S]*?\\*/|/\\*M?!\\d*|\\*/)*';
const DEFINER_RE = new RegExp(
  `\\bDEFINER${SEP}=${SEP}(?:(CURRENT_USER\\b(?:${SEP}\\(${SEP}\\))?)|(CURRENT_ROLE\\b(?:${SEP}\\(${SEP}\\))?)|(${NAME})(?:${SEP}@${SEP}(${NAME}))?)`,
  'gi',
);
const DEFINER_WORD_RE = /\bDEFINER\b/gi;
const SEP_START_RE = new RegExp(`^${SEP}`);
const SECURITY_BEFORE_RE = new RegExp(`\\bSECURITY${SEP}$`, 'i');
const CURRENT_USER_START_RE = /^CURRENT_USER\b/i;

const DATA_LINE_RE = /^\s*(?:INSERT|REPLACE)\s/i;
const DELIMITER_RE = /^\s*DELIMITER\s+(\S+)\s*$/i;
/** Leading versioned / plain comment openers stripped before the dangerous-statement check. */
const COMMENT_OPENER_RE = /^\s*\/\*!?\d*\s*/;

/**
 * Statements a mysqldump of ONE database never contains. Matched at the start of a
 * (comment-stripped) line. Session SET lines of mysqldump (SET NAMES, SET @OLD_…,
 * SET TIME_ZONE…) stay allowed; global ones do not.
 */
const DANGEROUS: Array<[RegExp, string]> = [
  [/^CREATE\s+(?:OR\s+REPLACE\s+)?USER\b/i, 'CREATE USER'],
  [/^CREATE\s+(?:OR\s+REPLACE\s+)?ROLE\b/i, 'CREATE ROLE'],
  [/^CREATE\s+(?:OR\s+REPLACE\s+)?(?:DATABASE|SCHEMA)\b/i, 'CREATE DATABASE'],
  [/^CREATE\s+(?:OR\s+REPLACE\s+)?SERVER\b/i, 'CREATE SERVER'],
  [/^DROP\s+(?:USER|ROLE|DATABASE|SCHEMA|SERVER)\b/i, 'DROP USER / DATABASE'],
  [/^ALTER\s+(?:USER|DATABASE|SCHEMA|SERVER)\b/i, 'ALTER USER / DATABASE'],
  [/^RENAME\s+USER\b/i, 'RENAME USER'],
  [/^GRANT\b/i, 'GRANT'],
  [/^REVOKE\b/i, 'REVOKE'],
  [/^SET\s+(?:PASSWORD|ROLE|DEFAULT\s+ROLE|GLOBAL\b|@@GLOBAL\b)/i, 'SET PASSWORD / GLOBAL'],
  [/^USE(?:\s|`|;|$)/i, 'USE'],
  [/^(?:INSTALL|UNINSTALL)\s+(?:PLUGIN|SONAME)\b/i, 'INSTALL PLUGIN'],
  [/^LOAD\s+(?:DATA|XML)\b/i, 'LOAD DATA'],
  [/^(?:SHUTDOWN|KILL)\b/i, 'SHUTDOWN / KILL'],
  [/^CHANGE\s+(?:MASTER|REPLICATION)\b/i, 'CHANGE MASTER'],
  [/^(?:CALL|PREPARE|EXECUTE)\b/i, 'CALL / PREPARE / EXECUTE'],
  [/^(?:\\!|\\\.|SYSTEM\s|SOURCE\s)/i, 'commande du client'],
];

/** Long-form mysql client commands, honoured at the start of a statement only. */
const CLIENT_COMMAND_RE = /^\s*(?:CONNECT|PAGER|TEE|CHARSET|EDIT)(?:\s|;|$)/i;

/** Client character sets whose multibyte characters may contain 0x5C (the client would not see a backslash escape). */
const UNSAFE_CHARSET = '(?:big5|cp932|gbk|gb18030|sjis)';
const QUOTED_LITERAL = `'[^'\\\\]*'|"[^"\\\\]*"`;
const VALUE_END = `(?=${SEP}(?:[,;)]|\\*/|FOR\\b|$))`;

/** Session guards: [assignment regex, accepted value regex (anchored at the value), label]. */
const SESSION_GUARDS: Array<[RegExp, RegExp, string]> = [
  // SET sql_mode = 'literal' | @@sql_mode | @saved_sql_mode | DEFAULT — never an expression (CONCAT, numbers…).
  [new RegExp(`\\bsql_mode${SEP}:?=${SEP}`, 'gi'),
    new RegExp(`^(?:(?:${QUOTED_LITERAL})${VALUE_END}|@@(?:session\\.|local\\.)?sql_mode\\b|@[\\w$.]*sql_mode[\\w$.]*\\b|DEFAULT\\b)`, 'i'), 'sql_mode'],
  // @saved_sql_mode / @OLD_SQL_MODE only ever hold @@sql_mode or a literal.
  [new RegExp(`@[\\w$.]*sql_mode[\\w$.]*${SEP}:?=${SEP}`, 'gi'),
    new RegExp(`^(?:(?:${QUOTED_LITERAL})${VALUE_END}|@@(?:session\\.|local\\.)?sql_mode\\b)`, 'i'), 'sql_mode'],
  // character_set_client: a literal / name that is not an unsafe multibyte set, @@character_set_client, a saved copy, DEFAULT.
  [new RegExp(`\\bcharacter_set_client${SEP}:?=${SEP}`, 'gi'),
    new RegExp(`^(?:(?!['"\`]?${UNSAFE_CHARSET}\\b)(?:${QUOTED_LITERAL}|[A-Za-z0-9_]+)${VALUE_END}|@@(?:session\\.|local\\.)?character_set_client\\b|@[\\w$.]*(?:cs_client|character_set_client)[\\w$.]*\\b|DEFAULT\\b)`, 'i'),
    'character_set_client'],
  [new RegExp(`@[\\w$.]*(?:cs_client|character_set_client)[\\w$.]*${SEP}:?=${SEP}`, 'gi'),
    new RegExp(`^(?:(?!['"\`]?${UNSAFE_CHARSET}\\b)(?:${QUOTED_LITERAL}|[A-Za-z0-9_]+)${VALUE_END}|@@(?:session\\.|local\\.)?character_set_client\\b)`, 'i'),
    'character_set_client'],
];
const SET_NAMES_UNSAFE_RE = new RegExp(`\\bSET${SEP}(?:NAMES|CHARACTER\\s+SET|CHARSET)${SEP}['"\`]?${UNSAFE_CHARSET}\\b`, 'i');
const INTO_GUARDED_VAR_RE = new RegExp(`\\bINTO${SEP}@[\\w$.]*(?:sql_mode|cs_client|character_set_client)`, 'i');

/** Decodes one quoted / bare MySQL name. */
export function unquoteMysqlName(raw: string): string {
  const q = raw[0];
  if (q === '`') return raw.slice(1, -1).replace(/``/g, '`');
  if (q === "'" || q === '"') {
    const inner = raw.slice(1, -1);
    return inner.replace(q === "'" ? /''/g : /""/g, q).replace(/\\(.)/g, (_m, c: string) => {
      switch (c) {
        case '0': return '\0';
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'Z': return '\x1a';
        default: return c;
      }
    });
  }
  return raw;
}

/** The forbidden statement a (non-data) line starts with, else null. */
export function dangerousStatement(line: string): string | null {
  let s = line;
  // Strip nested comment openers: "/*!50003 GRANT …", "/* x */ GRANT" (the closing of a plain comment is skipped too).
  for (let i = 0; i < 4; i++) {
    const plain = /^\s*\/\*(?!!)[\s\S]*?\*\/\s*/.exec(s);
    if (plain) { s = s.slice(plain[0].length); continue; }
    const m = COMMENT_OPENER_RE.exec(s);
    if (!m || !m[0].includes('/*')) break;
    s = s.slice(m[0].length);
  }
  s = s.trimStart();
  for (const [re, label] of DANGEROUS) if (re.test(s)) return label;
  return null;
}

/** A session change that would desynchronise the client's statement splitting from this filter, else null. */
export function unsafeSessionChange(line: string): string | null {
  if (/NO_BACKSLASH_ESCAPES/i.test(line)) return 'NO_BACKSLASH_ESCAPES';
  if (SET_NAMES_UNSAFE_RE.test(line)) return 'SET NAMES (jeu de caractères multi-octets)';
  if (INTO_GUARDED_VAR_RE.test(line)) return 'SELECT … INTO @variable de session';
  for (const [assign, value, label] of SESSION_GUARDS) {
    assign.lastIndex = 0;
    for (let m = assign.exec(line); m; m = assign.exec(line)) {
      if (!value.test(line.slice(m.index + m[0].length))) return `${label} (valeur calculée)`;
      if (m[0].length === 0) assign.lastIndex++;
    }
  }
  return null;
}

/** Rewrites the DEFINER clauses of one line (stats updated). */
export function rewriteDefiners(line: string, migrated: ReadonlySet<string>, restoreUser: string, stats: DefinerFilterStats): string {
  DEFINER_RE.lastIndex = 0;
  return line.replace(DEFINER_RE, (whole: string, currentUser?: string, currentRole?: string, user?: string) => {
    if (currentUser !== undefined) return whole; // CURRENT_USER = the restore user at import time
    const name = currentRole !== undefined ? 'CURRENT_ROLE' : unquoteMysqlName(user ?? '');
    if (currentRole === undefined && migrated.has(name)) {
      stats.kept++;
      return `DEFINER=${mysqlAccount(name)}`;
    }
    stats.foreign++;
    if (stats.foreignUsers.length < 20 && !stats.foreignUsers.includes(name.slice(0, 64))) stats.foreignUsers.push(name.slice(0, 64));
    return `DEFINER=${mysqlAccount(restoreUser)}`;
  });
}

/**
 * After the rewrite, every DEFINER keyword of a line must be readable: `SQL SECURITY DEFINER`,
 * a clause the rewrite produced, `DEFINER = CURRENT_USER`, or the word alone (text). Returns
 * 'refuse' for a clause the filter could not read, 'pending' when the line ends right after
 * the keyword (the `=` could start the next line), else 'ok'.
 */
export function checkDefiners(line: string, allowed: readonly string[]): 'ok' | 'pending' | 'refuse' {
  let pending = false;
  DEFINER_WORD_RE.lastIndex = 0;
  for (let m = DEFINER_WORD_RE.exec(line); m; m = DEFINER_WORD_RE.exec(line)) {
    const before = line.slice(Math.max(0, m.index - 400), m.index);
    if (SECURITY_BEFORE_RE.test(before)) continue;
    const rest = line.slice(m.index + m[0].length);
    const after = rest.slice((SEP_START_RE.exec(rest)?.[0] ?? '').length);
    if (after.startsWith('=')) {
      const value = after.slice(1);
      const v = value.slice((SEP_START_RE.exec(value)?.[0] ?? '').length);
      if (CURRENT_USER_START_RE.test(v) || allowed.some((a) => v.startsWith(a))) continue;
      return 'refuse';
    }
    // Keyword at the end of the line (maybe inside an unterminated comment): the clause may continue below.
    if (after === '' || after.startsWith('/*') || /^(?:--\s|#)/.test(after)) pending = true;
  }
  return pending ? 'pending' : 'ok';
}

/** Does a line continue a DEFINER keyword left at the end of the previous line with its `=`? */
function continuesDefiner(line: string, inComment: boolean): 'pending' | 'refuse' | 'clear' {
  let s = line;
  if (inComment) {
    const end = s.indexOf('*/');
    if (end < 0) return 'pending';
    s = s.slice(end + 2);
  }
  s = s.slice((SEP_START_RE.exec(s)?.[0] ?? '').length);
  if (s === '' || s.startsWith('/*') || /^(?:--\s|#)/.test(s)) return 'pending';
  return s.startsWith('=') ? 'refuse' : 'clear';
}

const SQ_SPECIAL = /['\\]/g;
const DQ_SPECIAL = /["\\]/g;

/** Index of the next match of `re` in s[from, limit), else -1. */
function nextSpecial(re: RegExp, s: string, from: number, limit: number): number {
  re.lastIndex = from;
  const m = re.exec(s);
  return m && m.index < limit ? m.index : -1;
}

type LexState = 'code' | 'sq' | 'dq' | 'bt' | 'block' | 'mblock' | 'line';

/**
 * Statement splitter mirroring the mysql client (add_line): quotes with backslash escapes
 * (not in backticks), plain / line comments, executable comments, delimiter.
 */
class ClientLexer {
  state: LexState = 'code';
  esc = false;
  /** Something other than blanks / comments was read since the last delimiter. */
  stmtOpen = false;

  atStatementStart(): boolean {
    return this.state === 'code' && !this.stmtOpen;
  }

  inComment(): boolean {
    return this.state === 'block' || this.state === 'mblock';
  }

  /**
   * Scans s[from, limit) (lookahead may read up to s.length). In `data` mode (a data
   * statement) the scan stops right after the delimiter and returns that index, and code
   * outside the literals may not hold comments, client commands or variables. Otherwise
   * the whole range is scanned (onBoundary called after each delimiter) and -1 returned.
   */
  scan(s: string, from: number, limit: number, delimiter: string, data: boolean, line: () => number, onBoundary?: (index: number) => void): number {
    const refuse = (what: string): never => { throw new DumpRefusedError(what, line()); };
    let i = from;
    while (i < limit) {
      const c = s[i];
      switch (this.state) {
        case 'sq':
        case 'dq': {
          if (this.esc) { this.esc = false; i++; continue; }
          // Fast path: jump to the next quote / backslash (data literals are most of a dump).
          const next = nextSpecial(this.state === 'sq' ? SQ_SPECIAL : DQ_SPECIAL, s, i, limit);
          if (next < 0) { i = limit; continue; }
          if (s[next] === '\\') this.esc = true;
          else this.state = 'code';
          i = next + 1;
          continue;
        }
        case 'bt': {
          const next = s.indexOf('`', i);
          if (next < 0 || next >= limit) { i = limit; continue; }
          this.state = 'code';
          i = next + 1;
          continue;
        }
        case 'block':
        case 'mblock':
          if (c === '*' && s[i + 1] === '/') { this.state = 'code'; i += 2; continue; }
          // Older clients read /*M! … */ as a plain comment, MariaDB runs it: no quote may make the two readings differ.
          if (this.state === 'mblock' && (c === "'" || c === '"' || c === '`')) refuse('commentaire conditionnel MariaDB contenant des guillemets');
          i++;
          continue;
        case 'line':
          if (c === '\n') this.state = 'code';
          i++;
          continue;
        default:
          break;
      }
      if (s.startsWith(delimiter, i)) {
        this.stmtOpen = false;
        i += delimiter.length;
        if (data) return i;
        onBoundary?.(i);
        continue;
      }
      switch (c) {
        case "'": this.state = 'sq'; this.stmtOpen = true; break;
        case '"': this.state = 'dq'; this.stmtOpen = true; break;
        case '`': this.state = 'bt'; this.stmtOpen = true; break;
        case '/':
          if (s[i + 1] === '*') {
            if (data) refuse('commentaire dans une instruction de données');
            if (s[i + 2] === '!') { this.stmtOpen = true; i += 3; continue; }
            if (s[i + 2] === 'M' && s[i + 3] === '!') { this.state = 'mblock'; this.stmtOpen = true; i += 4; continue; }
            this.state = 'block';
            i += 2;
            continue;
          }
          this.stmtOpen = true;
          break;
        case '#':
          if (data) refuse('commentaire dans une instruction de données');
          this.state = 'line';
          break;
        case '-':
          if (s[i + 1] === '-' && (i + 2 >= s.length || s.charCodeAt(i + 2) <= 32)) {
            if (data) refuse('commentaire dans une instruction de données');
            this.state = 'line';
            i += 2;
            continue;
          }
          this.stmtOpen = true;
          break;
        case '\\':
          refuse('commande du client');
          break;
        case '@':
          if (data) refuse('variable dans une instruction de données');
          this.stmtOpen = true;
          break;
        case ' ': case '\t': case '\n': case '\r': case '\f': case '\v':
          break;
        default:
          this.stmtOpen = true;
      }
      i++;
    }
    return -1;
  }
}

export type DefinerFilter = Transform & { readonly stats: DefinerFilterStats };

export function createDefinerFilter(opts: DefinerFilterOptions): DefinerFilter {
  const migrated = new Set(opts.migratedUsers);
  const restoreUser = opts.restoreUser;
  const allowed = [...migrated, restoreUser].map((u) => mysqlAccount(u));
  const maxLine = opts.maxLineBytes ?? DEFAULT_MAX_LINE;
  const stats: DefinerFilterStats = { lines: 0, kept: 0, foreign: 0, foreignUsers: [] };
  const lexer = new ClientLexer();
  /** 'head' = start of a statement / line being classified, 'data' = data statement streamed, 'line' = buffered line. */
  let mode: 'head' | 'data' | 'line' = 'head';
  let pending = '';
  let delimiter = ';';
  /** A DEFINER keyword ended the previous filtered line. */
  let definerPending = false;

  const finishLine = (line: string): string => {
    stats.lines++;
    const startedInComment = lexer.inComment();
    const atStart = lexer.atStatementStart();
    const inCode = lexer.state === 'code';
    const d = DELIMITER_RE.exec(line.replace(/\r?\n$/, ''));
    if (d && atStart) {
      delimiter = d[1];
      return line;
    }
    if (definerPending) {
      const c = continuesDefiner(line, startedInComment);
      if (c === 'refuse') throw new DumpRefusedError('DEFINER illisible (coupé sur deux lignes)', stats.lines);
      definerPending = c === 'pending';
    }
    // A line starting inside a literal / comment does not start a statement (the client reads it as text).
    const bad = (inCode ? dangerousStatement(line) : null) ?? (atStart && CLIENT_COMMAND_RE.test(line) ? 'commande du client' : null) ?? unsafeSessionChange(line);
    if (bad) throw new DumpRefusedError(bad, stats.lines);
    const out = rewriteDefiners(line, migrated, restoreUser, stats);
    const check = checkDefiners(out, allowed);
    if (check === 'refuse') throw new DumpRefusedError('DEFINER illisible', stats.lines);
    if (check === 'pending') definerPending = true;
    // Statements starting after a delimiter inside the line are checked too (`SELECT 1; GRANT …`).
    const boundaries: number[] = [];
    lexer.scan(out, 0, out.length, delimiter, false, () => stats.lines, (i) => boundaries.push(i));
    for (const b of boundaries) {
      const next = dangerousStatement(out.slice(b));
      if (next) throw new DumpRefusedError(next, stats.lines);
    }
    return out;
  };

  /** Consumes `pending` as far as possible; returns the text to emit. */
  const drain = (final: boolean): string => {
    let out = '';
    while (pending.length > 0) {
      if (mode === 'head') {
        const nl = pending.indexOf('\n');
        if (nl < 0 && pending.length < HEAD_BYTES && !final) break;
        const head = pending.slice(0, nl < 0 ? HEAD_BYTES : Math.min(nl + 1, HEAD_BYTES));
        // A data statement starts at a statement boundary, outside any literal / comment, under ';'.
        mode = delimiter === ';' && lexer.atStatementStart() && DATA_LINE_RE.test(head) ? 'data' : 'line';
        continue;
      }
      if (mode === 'data') {
        const limit = final ? pending.length : pending.length - LOOKAHEAD;
        if (limit <= 0) break;
        const end = lexer.scan(pending, 0, limit, ';', true, () => stats.lines + 1);
        const upTo = end >= 0 ? end : limit;
        const piece = pending.slice(0, upTo);
        for (let k = piece.indexOf('\n'); k >= 0; k = piece.indexOf('\n', k + 1)) stats.lines++;
        out += piece;
        pending = pending.slice(upTo);
        // End of the data statement: whatever follows on the line is classified again (full filter unless data).
        if (end >= 0) mode = 'head';
        continue;
      }
      // 'line'
      const nl = pending.indexOf('\n');
      if (nl < 0 && !final) {
        if (pending.length > maxLine) throw new Error(`Dump refusé : ligne ${stats.lines + 1} de plus de ${Math.round(maxLine / 1048576)} Mio hors données`);
        break;
      }
      const line = nl < 0 ? pending : pending.slice(0, nl + 1);
      pending = pending.slice(line.length);
      out += finishLine(line);
      // A statement left open by a filtered line is not a data statement; a data statement left open goes on streaming.
      mode = 'head';
    }
    return out;
  };

  const transform = new Transform({
    transform(chunk: Buffer | string, _enc: BufferEncoding, cb: TransformCallback) {
      try {
        pending += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk;
        const out = drain(false);
        if (out) this.push(Buffer.from(out, 'latin1'));
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb: TransformCallback) {
      try {
        const out = drain(true);
        if (out) this.push(Buffer.from(out, 'latin1'));
        if (definerPending) throw new DumpRefusedError('DEFINER illisible (fin du dump)', stats.lines);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
  return Object.assign(transform, { stats }) as DefinerFilter;
}
