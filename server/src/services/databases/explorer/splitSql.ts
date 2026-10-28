import type { DbFamily } from '@oblimint/shared';
import { splitStatements } from './sqlStream';

/**
 * Splits an SQL console input into statements on the top-level delimiter
 * (sqlStream.ts: quotes, comments, PostgreSQL dollar quoting, MySQL executable
 * comments and the DELIMITER client command — a routine body is written
 * between DELIMITER $$ … $$ / DELIMITER ;). Statements made of blanks and
 * comments only are dropped.
 */
export function splitSql(input: string, family: DbFamily): string[] {
  return splitStatements(input, family).map((s) => s.sql);
}
