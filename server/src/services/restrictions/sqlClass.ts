import type { DbFamily, RestrictableActionKey } from '@oblimint/shared';
import { firstKeyword, maskSqlLiterals } from '../databases/explorer/sqlStream';

// ─────────────────────────────────────────────────────────────────────────────
// Free SQL (panel console, query_database of a key) as catalogue actions
// (spec §2): a statement is a READ only when it surely runs read-only; any
// doubt is a write. A write is db.query_write, plus db.ddl when it drops /
// empties an object, plus db.rows_write when it changes rows, plus db.import
// when the batch is a dump pasted in — the operation is gated ONCE on the
// strictest of them (gateStrictest), so the console never reaches for free what
// the explorer's buttons (DDL, rows, import) protect.
//
// Keywords are read on the statement with its literals and comments masked
// (a 'DELETE' inside a string is no write); a MySQL executable comment
// (/*! … */ runs) is the strictest of all.
// ─────────────────────────────────────────────────────────────────────────────

export interface SqlClass {
  write: boolean;
  /** The catalogue actions the batch amounts to (empty: a read). */
  actions: RestrictableActionKey[];
}

/** Statements that only read (still subject to the checks below). */
const READS = new Set(['select', 'with', 'show', 'describe', 'desc', 'explain', 'table', 'values']);
const ROW_WORDS = new Set(['insert', 'update', 'delete', 'replace', 'merge', 'copy', 'load', 'upsert']);
const DDL_WORDS = new Set(['drop', 'truncate']);
/** More writing statements than this in one batch: a dump pasted in (db.import too). */
export const PASTED_DUMP_STATEMENTS = 10;

const WRITE_INSIDE = /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|call|do|lock)\b/i;

interface One { write: boolean; ddl: boolean; rows: boolean; bulk: boolean }

function classifyOne(sql: string, family: DbFamily): One {
  // MySQL executable comment: its body runs whatever the masked text says.
  if (family !== 'postgresql' && /\/\*!|\/\*M!/.test(sql)) return { write: true, ddl: true, rows: true, bulk: false };
  const kw = firstKeyword(sql, family);
  const masked = maskSqlLiterals(sql, family);
  const body = masked.replace(/^[\s(]+/, '');
  if (READS.has(kw)) {
    let write = false;
    // A data-modifying CTE (WITH d AS (DELETE … RETURNING *) SELECT …) runs its writes.
    if (kw === 'with' && WRITE_INSIDE.test(masked)) write = true;
    // EXPLAIN ANALYZE (MySQL 8 too) and EXPLAIN (ANALYZE …) execute the statement.
    if (kw === 'explain' && (/\banaly[sz]e\b/i.test(masked) || /^explain\s*\(/i.test(body))) write = true;
    // SELECT … INTO new_table / INTO OUTFILE / INTO DUMPFILE writes.
    if ((kw === 'select' || kw === 'with' || kw === 'table' || kw === 'values') && /\binto\b/i.test(masked)) write = true;
    // A locking read (FOR UPDATE / FOR SHARE) or a function call writing is not detectable
    // statically for every function; a locking clause at least is a write intent.
    if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(masked)) write = true;
    if (!write) return { write: false, ddl: false, rows: false, bulk: false };
    const rows = /\b(insert|update|delete|merge|copy)\b/i.test(masked) || /\binto\b/i.test(masked);
    const ddl = /\b(drop|truncate)\b/i.test(masked);
    return { write: true, ddl, rows, bulk: false };
  }
  const ddl = DDL_WORDS.has(kw) || (kw === 'alter' && /\bdrop\b/i.test(masked));
  const rows = ROW_WORDS.has(kw);
  const bulk = (kw === 'copy' && /\bfrom\s+stdin\b/i.test(masked)) || (kw === 'load' && /\bdata\b/i.test(masked));
  return { write: true, ddl, rows, bulk };
}

/** The class of a batch of statements (already split). */
export function classifySql(statements: string[], family: DbFamily): SqlClass {
  let write = false; let ddl = false; let rows = false; let bulk = false; let writes = 0;
  for (const s of statements) {
    if (!s.trim()) continue;
    const c = classifyOne(s, family);
    if (!c.write) continue;
    write = true; writes++;
    ddl ||= c.ddl; rows ||= c.rows; bulk ||= c.bulk;
  }
  if (!write) return { write: false, actions: [] };
  const actions: RestrictableActionKey[] = ['db.query_write'];
  if (ddl) actions.push('db.ddl');
  if (rows) actions.push('db.rows_write');
  if (bulk || writes > PASTED_DUMP_STATEMENTS) actions.push('db.import');
  return { write, actions };
}
