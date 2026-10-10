// ─────────────────────────────────────────────────────────────────────────────
// D-DB grants (docs/P5-PLAN.md §4): mysql.db rows of CWP → explicit per-database
// grants of the target instance + their db_grants level. Pure.
//   - a mysql.db `Db` value is a LIKE pattern: `_` / `%` are wildcards, `\_` /
//     `\%` (as CWP stores them: acct1\_wp) are LITERALS — never unescape blindly;
//   - privileges ⊇ ALL (minus GRANT OPTION) → 'all'; SELECT only → 'readonly';
//     any other set → 'all' level in db_grants + the exact set in the instance
//     (dbGrantCustom).
// ─────────────────────────────────────────────────────────────────────────────

/** Database-level privileges of MariaDB (GRANT OPTION excluded). DELETE HISTORY is optional (MariaDB ≥ 10.3.4). */
export const ALL_DB_PRIVILEGES = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'REFERENCES', 'INDEX', 'ALTER', 'CREATE TEMPORARY TABLES',
  'LOCK TABLES', 'CREATE VIEW', 'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EXECUTE', 'EVENT', 'TRIGGER',
] as const;

const OPTIONAL_PRIVILEGES = new Set(['DELETE HISTORY']);
const KNOWN = new Set<string>([...ALL_DB_PRIVILEGES, ...OPTIONAL_PRIVILEGES]);

const ALIASES: Record<string, string> = {
  'CREATE TMP TABLE': 'CREATE TEMPORARY TABLES',
  'CREATE TMP TABLES': 'CREATE TEMPORARY TABLES',
  'LOCK TABLE': 'LOCK TABLES',
};

/** 'Select_priv' / 'select' / 'Create_tmp_table_priv' → 'SELECT' / 'CREATE TEMPORARY TABLES' (null = unknown / GRANT). */
export function normalizePrivilege(p: string): string | null {
  let s = String(p ?? '').trim().toUpperCase().replace(/_PRIV$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ');
  s = ALIASES[s] ?? s;
  if (s === 'ALL' || s === 'ALL PRIVILEGES') return 'ALL';
  return KNOWN.has(s) ? s : null;
}

export function normalizePrivileges(list: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of list) {
    const n = normalizePrivilege(p);
    if (n === 'ALL') ALL_DB_PRIVILEGES.forEach((x) => out.add(x));
    else if (n) out.add(n);
  }
  const order = [...ALL_DB_PRIVILEGES, 'DELETE HISTORY'];
  return [...out].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

export type GrantClass = 'all' | 'readonly' | 'custom';

export function classifyPrivileges(privs: readonly string[]): GrantClass {
  const set = new Set(privs);
  if (ALL_DB_PRIVILEGES.every((p) => set.has(p))) return 'all';
  if (set.size === 1 && set.has('SELECT')) return 'readonly';
  return 'custom';
}

/** mysql.db pattern → RegExp (escaped \_ \% are literals, bare _ % are LIKE wildcards). */
export function grantPatternRegex(pattern: string): RegExp {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) {
      re += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    } else if (c === '_') re += '.';
    else if (c === '%') re += '.*';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${re}$`, 's');
}

/** The pattern holds an unescaped wildcard. */
export function isWildcardPattern(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\') { i++; continue; }
    if (pattern[i] === '_' || pattern[i] === '%') return true;
  }
  return false;
}

export function expandGrantPattern(pattern: string, databases: readonly string[]): string[] {
  const re = grantPatternRegex(pattern);
  return databases.filter((d) => re.test(d));
}

/** DEFINER 'user@host' / '`user`@`host`' / "'user'@'host'" → user (null when unreadable). */
export function definerUser(definer: string): string | null {
  const s = String(definer ?? '').trim();
  const m = /^[`'"]?(.*?)[`'"]?@[`'"]?([^`'"]*)[`'"]?$/.exec(s);
  if (!m) return null;
  return m[1];
}
