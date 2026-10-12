import type { DbFamily, DbxTable } from '@oblimint/shared';

/** Quoted reference of a table for the console (MySQL `name`, PostgreSQL "schema"."name"). */
export function qIdent(family: DbFamily, t: Pick<DbxTable, 'name' | 'schema'>): string {
  if (family === 'mysql') return `\`${t.name.replace(/`/g, '``')}\``;
  const q = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
  return t.schema && t.schema !== 'public' ? `${q(t.schema)}.${q(t.name)}` : q(t.name);
}
