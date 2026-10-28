import type {
  DbFamily, DbxColumn, DbxColumnDef, DbxDdlPreview, DbxDdlRequest, DbxDdlWarning, DbxDefault, DbxFkAction, DbxObject, DbxTable, DbxTableInfo,
} from '@oblimint/shared';
import { DBX_FK_ACTIONS } from '@oblimint/shared';
import { AppError } from '../../../middleware/errorHandler';
import { quoteString } from '../sql';

// ─────────────────────────────────────────────────────────────────────────────
// Structure editing of the database explorer: a STRUCTURED request (shared
// DbxDdlRequest) → the DDL statements, per engine. Pure: the caller resolves
// the tables / objects against the catalog first (an existing table, column,
// index or object is never taken from the request as such). Every identifier
// goes through the quoting helpers, every literal through quoteString; a type
// must match a small grammar (words, sizes, enum literals, [] — no quote, no
// semicolon, no comment, no keyword that would change the statement); a
// default is NULL, a quoted literal or one of a few expressions. The same
// function builds the preview and the statements that run (the server never
// runs a DDL text received from the client on this path).
// ─────────────────────────────────────────────────────────────────────────────

export interface DdlContext {
  family: DbFamily;
  /** The table of the request (resolved from the catalog). */
  table?: DbxTableInfo;
  /** addForeignKey: the referenced table (resolved). */
  refTable?: DbxTableInfo;
  /** dropObject: the object (resolved). */
  object?: DbxObject;
}

const bad = (message: string, field?: string) => new AppError(400, message, 'invalidDdl', field ? { field } : undefined);

export const qMyId = (id: string) => `\`${id.replace(/`/g, '``')}\``;
export const qPgId = (id: string) => `"${id.replace(/"/g, '""')}"`;

/** An identifier given by the user for a NEW object (table, column, index, constraint). */
export function checkName(family: DbFamily, name: string, field = 'name'): string {
  if (typeof name !== 'string' || !name.length) throw bad('A name is required', field);
  if (name.includes('\0')) throw bad('NUL in a name', field);
  const max = family === 'postgresql' ? 63 : 64;
  if ([...name].length > max) throw bad(`Name too long (at most ${max} characters)`, field);
  if (family === 'mysql' && /\s$/.test(name)) throw bad('A MySQL name cannot end with a space', field);
  if (!name.trim()) throw bad('A name cannot be blank', field);
  return name;
}

const q = (family: DbFamily, id: string) => (family === 'postgresql' ? qPgId(id) : qMyId(id));

/** Quoted table reference (PostgreSQL: schema-qualified). */
export function tableRef(family: DbFamily, t: Pick<DbxTable, 'name' | 'schema'>): string {
  return family === 'postgresql' ? `${qPgId(t.schema ?? 'public')}.${qPgId(t.name)}` : qMyId(t.name);
}

// ── types ────────────────────────────────────────────────────────────────────

/** Words that would turn a type into more than a type. */
const FORBIDDEN_TYPE_WORDS = new Set([
  'default', 'null', 'not', 'primary', 'key', 'references', 'check', 'constraint', 'generated', 'as', 'auto_increment', 'comment',
  'unique', 'on', 'after', 'first', 'using', 'identity', 'always', 'stored', 'virtual', 'invisible', 'visible', 'select', 'drop', 'alter',
  'create', 'insert', 'update', 'delete', 'grant', 'revoke', 'into', 'from', 'where', 'and', 'or', 'then', 'begin', 'end', 'serial_default',
]);

/**
 * Validates a column type: a base name ([schema.]word), more words (modifiers:
 * unsigned, varying, with time zone, character set x, collate x…), at most two
 * argument groups ((n), (p, s), ('a', 'b') for enum / set) and [] suffixes.
 * Returns the type as given (trimmed, single spaces).
 */
export function checkType(family: DbFamily, raw: string): string {
  if (typeof raw !== 'string') throw bad('A type is required', 'type');
  const type = raw.trim().replace(/\s+/g, ' ');
  if (!type) throw bad('A type is required', 'type');
  if (type.length > 512) throw bad('Type too long', 'type');
  let i = 0;
  let words = 0;
  let groups = 0;
  const n = type.length;
  const skipSpace = () => { while (i < n && type[i] === ' ') i++; };
  while (i < n) {
    skipSpace();
    if (i >= n) break;
    const c = type[i];
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?/.exec(type.slice(i));
      const word = m![0];
      if (FORBIDDEN_TYPE_WORDS.has(word.toLowerCase())) throw bad(`Not allowed in a type: ${word}`, 'type');
      if (word.includes('.') && words > 0) throw bad('Invalid type', 'type');
      words++;
      i += word.length;
      continue;
    }
    if (c === '(') {
      if (!words || ++groups > 2) throw bad('Invalid type', 'type');
      i++;
      let args = 0;
      for (;;) {
        skipSpace();
        if (type[i] === '\'') {
          // enum / set literal: '' doubles a quote; no backslash (never an escape here).
          i++;
          for (;;) {
            if (i >= n) throw bad('Unterminated literal in the type', 'type');
            if (type[i] === '\\') throw bad('No backslash in a type literal', 'type');
            if (type[i] === '\'') {
              if (type[i + 1] === '\'') { i += 2; continue; }
              i++;
              break;
            }
            i++;
          }
        } else {
          const m = /^[0-9]{1,10}(?: [A-Za-z]+)?/.exec(type.slice(i)); // numeric(10,2), varchar(255), char(10 char) / timestamp(6)
          if (!m) throw bad('Invalid type arguments', 'type');
          if (m[0].includes(' ') && !/ (char|byte|chars|bytes)$/i.test(m[0])) throw bad('Invalid type arguments', 'type');
          i += m[0].length;
        }
        args++;
        skipSpace();
        if (type[i] === ',') { i++; if (args >= 1000) throw bad('Too many type arguments', 'type'); continue; }
        if (type[i] === ')') { i++; break; }
        throw bad('Invalid type arguments', 'type');
      }
      continue;
    }
    if (c === '[' && family === 'postgresql') {
      if (!words) throw bad('Invalid type', 'type');
      const m = /^\[[0-9]{0,6}\]/.exec(type.slice(i));
      if (!m) throw bad('Invalid array suffix', 'type');
      i += m[0].length;
      continue;
    }
    throw bad(`Invalid character in the type: ${c}`, 'type');
  }
  if (!words) throw bad('A type is required', 'type');
  return type;
}

const INTEGER_TYPES = /^(tiny|small|medium|big)?int(eger)?\b|^int[248]\b|^serial|^bigserial|^smallserial/i;

// ── defaults ─────────────────────────────────────────────────────────────────

/** Expressions allowed as a default (others: edit the DDL by hand). */
const DEFAULT_EXPRESSIONS = /^(current_timestamp|current_date|current_time|localtimestamp|localtime|now|utc_timestamp|curdate|curtime|uuid|uuid_short|gen_random_uuid|true|false|current_user|transaction_timestamp|statement_timestamp|clock_timestamp)(\(\s*\d{0,1}\s*\))?$/i;
const NUMERIC = /^-?(?:\d{1,40}(?:\.\d{1,40})?|\.\d{1,40})(?:e[+-]?\d{1,4})?$/i;

export function renderDefault(family: DbFamily, d: DbxDefault | null | undefined): string | null {
  if (!d) return null;
  if (d.kind === 'null') return 'NULL';
  if (d.kind === 'literal') {
    if (typeof d.value !== 'string') throw bad('Invalid default', 'default');
    if (d.value.length > 65_535) throw bad('Default too long', 'default');
    if (d.value.includes('\0')) throw bad('NUL in the default', 'default');
    return quoteString(family, d.value);
  }
  const v = String(d.value ?? '').trim();
  if (NUMERIC.test(v)) return v;
  if (!DEFAULT_EXPRESSIONS.test(v)) throw bad(`Default expression not allowed here: ${v.slice(0, 60)} (use a literal, or edit the DDL)`, 'default');
  // MySQL: an expression default other than CURRENT_TIMESTAMP needs parentheses (8.0.13+ / MariaDB 10.2+).
  if (family === 'mysql' && !/^(current_timestamp|now|localtimestamp|localtime|true|false)\b/i.test(v)) return `(${v})`;
  return v;
}

function checkComment(c: string | null | undefined): string | null {
  if (c === null || c === undefined || c === '') return null;
  if (typeof c !== 'string' || c.length > 1024) throw bad('Comment too long (1024 characters at most)', 'comment');
  if (c.includes('\0')) throw bad('NUL in the comment', 'comment');
  return c;
}

const ON_UPDATE_RE = /^on update (current_timestamp(?:\(\d?\))?)$/i;
const COLLATION_RE = /^[A-Za-z0-9_]{1,64}$/;
const TEXT_TYPE_RE = /^(var)?char\b|^(tiny|medium|long)?text\b|^enum\b|^set\b/i;

/** Column definition (CREATE TABLE / ADD COLUMN / CHANGE COLUMN). */
export function columnSql(family: DbFamily, def: DbxColumnDef, opts: { keep?: DbxColumn } = {}): string {
  const name = checkName(family, def.name, 'column');
  const type = checkType(family, def.type);
  const dflt = renderDefault(family, def.default);
  const comment = checkComment(def.comment);
  if (def.autoIncrement && !INTEGER_TYPES.test(type)) throw bad('Auto-increment needs an integer type', 'autoIncrement');
  if (def.autoIncrement && dflt !== null) throw bad('An auto-increment column has no default', 'default');
  const parts = [q(family, name), type];
  if (family === 'postgresql') {
    if (def.autoIncrement) parts.push('GENERATED BY DEFAULT AS IDENTITY');
    if (!def.nullable) parts.push('NOT NULL');
    if (dflt !== null) parts.push(`DEFAULT ${dflt}`);
    return parts.join(' ');
  }
  // Kept from the current column on a MySQL CHANGE (the full definition replaces it): collation, ON UPDATE.
  const keep = opts.keep;
  if (keep?.collation && COLLATION_RE.test(keep.collation) && TEXT_TYPE_RE.test(type) && !/\b(collate|charset|character set)\b/i.test(type)) {
    parts.push(`COLLATE ${keep.collation}`);
  }
  parts.push(def.nullable ? 'NULL' : 'NOT NULL');
  if (dflt !== null) parts.push(`DEFAULT ${dflt}`);
  const onUpdate = keep?.extra ? ON_UPDATE_RE.exec(keep.extra.trim()) : null;
  if (onUpdate && /^(timestamp|datetime)\b/i.test(type)) parts.push(`ON UPDATE ${onUpdate[1].toUpperCase()}`);
  if (def.autoIncrement) parts.push('AUTO_INCREMENT');
  if (comment !== null) parts.push(`COMMENT ${quoteString('mysql', comment)}`);
  return parts.join(' ');
}

// ── helpers on the resolved catalog ──────────────────────────────────────────

function need<T>(v: T | undefined, what: string): T {
  if (!v) throw new AppError(404, `${what} not found`, 'tableNotFound');
  return v;
}

function column(info: DbxTableInfo, name: string): DbxColumn {
  const c = info.columns.find((x) => x.name === name);
  if (!c) throw new AppError(400, `Unknown column: ${name}`, 'unknownColumn');
  return c;
}

function columnList(family: DbFamily, info: DbxTableInfo, names: string[], field: string): string {
  if (!Array.isArray(names) || !names.length) throw bad('At least one column', field);
  if (names.length > 64) throw bad('Too many columns', field);
  if (new Set(names).size !== names.length) throw bad('A column is listed twice', field);
  for (const n of names) column(info, n);
  return names.map((n) => q(family, n)).join(', ');
}

function fkAction(a: DbxFkAction): string {
  if (!DBX_FK_ACTIONS.includes(a)) throw bad('Invalid ON DELETE / ON UPDATE action', 'action');
  return a;
}

function confirmName(expected: string, given: string): void {
  if (given !== expected) throw new AppError(400, 'Type the exact name to confirm', 'confirmMismatch');
}

const W = {
  dataLoss: (what: string): DbxDdlWarning => ({ key: 'dataLoss', text: `Data is lost: ${what}. There is no undo — export first if in doubt.` }),
  rewrite: { key: 'rewrite', text: 'The table is rewritten (locked meanwhile on a big table).' },
  fullRedefinition: { key: 'fullRedefinition', text: 'The whole column is redefined: attributes not shown here are reset (the collation and ON UPDATE are kept).' },
  autoIncrementKey: { key: 'autoIncrementKey', text: 'An auto-increment column must be (the first column of) a key.' },
  definer: { key: 'definer', text: 'On MySQL / MariaDB, an object created here has the session\'s temporary SQL user as DEFINER: prefer SQL SECURITY INVOKER.' },
} as const;

/** Same default (PostgreSQL shows '0'::integer, 'x'::text, now()…): casts and outer parentheses dropped, literals unquoted. */
export function sameDefault(current: string | null, next: string | null): boolean {
  if (current === null || next === null) return current === next;
  const norm = (s: string) => {
    let v = s.trim().replace(/::[a-z_ ]+(\(\d+(,\d+)?\))?(\[\])?/gi, '').trim();
    while (/^\(.*\)$/s.test(v)) v = v.slice(1, -1).trim();
    const quoted = /^'(.*)'$/s.exec(v);
    return quoted ? { v: quoted[1].replace(/''/g, '\''), lit: true } : { v, lit: false };
  };
  const a = norm(current);
  const b = norm(next);
  return a.v === b.v || (!a.lit && !b.lit && a.v.toLowerCase() === b.v.toLowerCase());
}

// ── the requests ─────────────────────────────────────────────────────────────

export function buildDdl(req: DbxDdlRequest, ctx: DdlContext): DbxDdlPreview {
  const { family } = ctx;
  const pg = family === 'postgresql';
  const out: string[] = [];
  const warnings: DbxDdlWarning[] = [];
  const t = () => need(ctx.table, 'Table');
  const tref = () => tableRef(family, t().table);

  switch (req.op) {
    case 'createTable': {
      const name = checkName(family, req.name, 'name');
      if (!Array.isArray(req.columns) || !req.columns.length) throw bad('At least one column', 'columns');
      if (req.columns.length > 1000) throw bad('Too many columns', 'columns');
      const names = req.columns.map((c) => c.name);
      if (new Set(names).size !== names.length) throw bad('Two columns have the same name', 'columns');
      const lines = req.columns.map((c) => `  ${columnSql(family, c)}`);
      const pk = req.primaryKey ?? [];
      for (const k of pk) if (!names.includes(k)) throw new AppError(400, `Unknown column: ${k}`, 'unknownColumn');
      if (pk.length) lines.push(`  PRIMARY KEY (${pk.map((k) => q(family, k)).join(', ')})`);
      const comment = checkComment(req.comment);
      const ref = pg ? qPgId(name) : qMyId(name);
      out.push(`CREATE TABLE ${ref} (\n${lines.join(',\n')}\n)${!pg && comment !== null ? ` COMMENT=${quoteString('mysql', comment)}` : ''}`);
      if (pg) {
        if (comment !== null) out.push(`COMMENT ON TABLE ${ref} IS ${quoteString(family, comment)}`);
        for (const c of req.columns) {
          const cc = checkComment(c.comment);
          if (cc !== null) out.push(`COMMENT ON COLUMN ${ref}.${qPgId(c.name)} IS ${quoteString(family, cc)}`);
        }
      } else if (req.columns.some((c) => c.autoIncrement && !pk.includes(c.name))) warnings.push(W.autoIncrementKey);
      break;
    }
    case 'renameTable': {
      const name = checkName(family, req.newName, 'newName');
      out.push(pg ? `ALTER ${t().table.kind === 'view' ? (t().table.materialized ? 'MATERIALIZED VIEW' : 'VIEW') : 'TABLE'} ${tref()} RENAME TO ${qPgId(name)}` : `RENAME TABLE ${tref()} TO ${qMyId(name)}`);
      break;
    }
    case 'dropTable': {
      confirmName(t().table.name, req.confirm);
      const kind = t().table.kind === 'view' ? (t().table.materialized ? 'MATERIALIZED VIEW' : 'VIEW') : 'TABLE';
      out.push(`DROP ${kind} ${tref()}`);
      warnings.push(W.dataLoss(kind === 'TABLE' ? 'the table and all its rows' : 'the view'));
      break;
    }
    case 'truncateTable': {
      confirmName(t().table.name, req.confirm);
      if (t().table.kind !== 'table') throw bad('Only a table can be emptied');
      out.push(`TRUNCATE TABLE ${tref()}`);
      warnings.push(W.dataLoss('every row of the table'));
      break;
    }
    case 'addColumn': {
      if (t().columns.some((c) => c.name === req.column.name)) throw bad(`Column ${req.column.name} already exists`, 'column');
      let pos = '';
      if (!pg && req.after !== undefined && req.after !== null) pos = req.after === '' ? ' FIRST' : ` AFTER ${qMyId(column(t(), req.after).name)}`;
      out.push(`ALTER TABLE ${tref()} ADD COLUMN ${columnSql(family, req.column)}${pos}`);
      if (pg) {
        const cc = checkComment(req.column.comment);
        if (cc !== null) out.push(`COMMENT ON COLUMN ${tref()}.${qPgId(req.column.name)} IS ${quoteString(family, cc)}`);
      } else if (req.column.autoIncrement) warnings.push(W.autoIncrementKey);
      break;
    }
    case 'modifyColumn': {
      const cur = column(t(), req.column);
      const def = req.def;
      const newName = checkName(family, def.name, 'column');
      if (newName !== cur.name && t().columns.some((c) => c.name === newName)) throw bad(`Column ${newName} already exists`, 'column');
      if (!pg) {
        // CHANGE COLUMN rewrites the whole definition: a generated column would become a plain one (its values frozen),
        // an invisible one visible. Refused rather than half-kept.
        if (/\b(?:VIRTUAL|STORED|PERSISTENT) GENERATED\b/i.test(cur.extra ?? '')) {
          throw bad(`Column ${cur.name} is generated (computed from an expression): change it with SQL in the console (ALTER TABLE … MODIFY … AS (…))`, 'column');
        }
        if (/\bINVISIBLE\b/i.test(cur.extra ?? '')) throw bad(`Column ${cur.name} is invisible: change it with SQL in the console (ALTER TABLE … MODIFY … INVISIBLE)`, 'column');
        out.push(`ALTER TABLE ${tref()} CHANGE COLUMN ${qMyId(cur.name)} ${columnSql(family, def, { keep: cur })}`);
        warnings.push(W.fullRedefinition);
        if (checkType(family, def.type).toLowerCase() !== cur.type.toLowerCase()) warnings.push(W.rewrite);
        break;
      }
      const type = checkType(family, def.type);
      const dflt = renderDefault(family, def.default);
      const comment = checkComment(def.comment);
      if (def.autoIncrement && !INTEGER_TYPES.test(type)) throw bad('Auto-increment needs an integer type', 'autoIncrement');
      if (def.autoIncrement && dflt !== null) throw bad('An auto-increment column has no default', 'default');
      let col = qPgId(cur.name);
      if (newName !== cur.name) {
        out.push(`ALTER TABLE ${tref()} RENAME COLUMN ${col} TO ${qPgId(newName)}`);
        col = qPgId(newName);
      }
      const alter = (s: string) => out.push(`ALTER TABLE ${tref()} ALTER COLUMN ${col} ${s}`);
      if (type.toLowerCase() !== cur.type.toLowerCase()) {
        alter(`TYPE ${type} USING ${col}::${type}`);
        warnings.push(W.rewrite);
      }
      const serial = cur.autoIncrement && !cur.identity;
      if (cur.autoIncrement && !def.autoIncrement) alter(serial ? 'DROP DEFAULT' : 'DROP IDENTITY IF EXISTS');
      if (!def.autoIncrement || !serial) {
        // A serial column kept as is keeps its nextval() default.
        const curDefault = serial ? null : cur.default;
        if (!def.autoIncrement && !sameDefault(curDefault, dflt)) alter(dflt === null ? 'DROP DEFAULT' : `SET DEFAULT ${dflt}`);
      }
      if (def.autoIncrement && !cur.autoIncrement) {
        if (cur.default !== null) alter('DROP DEFAULT');
        alter('ADD GENERATED BY DEFAULT AS IDENTITY');
      }
      if (def.nullable !== cur.nullable) alter(def.nullable ? 'DROP NOT NULL' : 'SET NOT NULL');
      if ((comment ?? '') !== (cur.comment ?? '')) out.push(`COMMENT ON COLUMN ${tref()}.${col} IS ${comment === null ? 'NULL' : quoteString(family, comment)}`);
      break;
    }
    case 'dropColumn': {
      const c = column(t(), req.column);
      if (t().columns.length === 1 && !pg) throw bad('The last column of a table cannot be dropped: drop the table');
      out.push(`ALTER TABLE ${tref()} DROP COLUMN ${q(family, c.name)}`);
      warnings.push(W.dataLoss(`the values of column ${c.name}`));
      break;
    }
    case 'createIndex': {
      const name = checkName(family, req.name, 'name');
      if (t().indexes.some((i) => i.name === name)) throw bad(`Index ${name} already exists`, 'name');
      out.push(`CREATE ${req.unique ? 'UNIQUE ' : ''}INDEX ${q(family, name)} ON ${tref()} (${columnList(family, t(), req.columns, 'columns')})`);
      break;
    }
    case 'dropIndex': {
      const idx = t().indexes.find((i) => i.name === req.name);
      if (!idx) throw new AppError(404, 'Index not found', 'notFound');
      if (pg) {
        out.push(idx.primary || idx.constraint ? `ALTER TABLE ${tref()} DROP CONSTRAINT ${qPgId(idx.name)}` : `DROP INDEX ${qPgId(t().table.schema ?? 'public')}.${qPgId(idx.name)}`);
      } else {
        out.push(idx.primary ? `ALTER TABLE ${tref()} DROP PRIMARY KEY` : `DROP INDEX ${qMyId(idx.name)} ON ${tref()}`);
      }
      break;
    }
    case 'setPrimaryKey': {
      const cur = t().indexes.find((i) => i.primary);
      const cols = req.columns ?? [];
      const list = cols.length ? columnList(family, t(), cols, 'columns') : '';
      if (pg) {
        if (cur) out.push(`ALTER TABLE ${tref()} DROP CONSTRAINT ${qPgId(cur.name)}`);
        if (cols.length) out.push(`ALTER TABLE ${tref()} ADD PRIMARY KEY (${list})`);
      } else {
        const parts = [...(cur ? ['DROP PRIMARY KEY'] : []), ...(cols.length ? [`ADD PRIMARY KEY (${list})`] : [])];
        if (parts.length) out.push(`ALTER TABLE ${tref()} ${parts.join(', ')}`);
      }
      if (!out.length) throw bad('No primary key to drop');
      break;
    }
    case 'addForeignKey': {
      const name = checkName(family, req.name, 'name');
      const ref = need(ctx.refTable, 'Referenced table');
      if (req.columns.length !== req.refColumns.length) throw bad('As many referenced columns as columns', 'refColumns');
      const cols = columnList(family, t(), req.columns, 'columns');
      const refCols = columnList(family, ref, req.refColumns, 'refColumns');
      out.push(`ALTER TABLE ${tref()} ADD CONSTRAINT ${q(family, name)} FOREIGN KEY (${cols}) REFERENCES ${tableRef(family, ref.table)} (${refCols}) ON DELETE ${fkAction(req.onDelete)} ON UPDATE ${fkAction(req.onUpdate)}`);
      break;
    }
    case 'dropForeignKey': {
      const fk = t().foreignKeys.find((f) => f.name === req.name);
      if (!fk) throw new AppError(404, 'Foreign key not found', 'notFound');
      out.push(pg ? `ALTER TABLE ${tref()} DROP CONSTRAINT ${qPgId(fk.name)}` : `ALTER TABLE ${tref()} DROP FOREIGN KEY ${qMyId(fk.name)}`);
      break;
    }
    case 'dropObject': {
      const o = need(ctx.object, 'Object');
      confirmName(o.name, req.confirm);
      if (o.kind !== req.kind) throw new AppError(404, 'Object not found', 'notFound');
      out.push(dropObjectSql(family, o));
      warnings.push(W.dataLoss(`the ${o.kind} definition`));
      break;
    }
    default:
      throw bad('Unknown operation');
  }
  return { statements: out, warnings };
}

/** DROP of a catalog object (identifiers from the catalog, PostgreSQL argument types from pg_get_function_identity_arguments). */
export function dropObjectSql(family: DbFamily, o: DbxObject): string {
  if (family === 'mysql') return `DROP ${o.kind.toUpperCase()} ${qMyId(o.name)}`;
  const schema = qPgId(o.schema ?? 'public');
  switch (o.kind) {
    case 'view': return `DROP VIEW ${schema}.${qPgId(o.name)}`;
    case 'trigger': return `DROP TRIGGER ${qPgId(o.name)} ON ${schema}.${qPgId(o.table ?? '')}`;
    case 'procedure':
    case 'function': return `DROP ${o.kind.toUpperCase()} ${schema}.${qPgId(o.name)}(${o.args ?? ''})`;
    default: throw bad('Unknown object kind');
  }
}

export const DDL_WARNINGS = W;
