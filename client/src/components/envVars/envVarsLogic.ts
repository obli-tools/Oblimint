// Pure logic of the environment variables editor (EnvVarsEditor), shared by the
// site variables (SiteEnvTab) and the application .env (app Settings): rows,
// per-row problems, .env import, example import (missing keys only), body of
// the save. A secret is write-only: a stored secret left empty is unchanged;
// unchecking Secret on a stored one needs a new value.

export interface EnvVarView {
  name: string;
  /** null for a secret (never sent back). */
  value: string | null;
  secret: boolean;
}

export interface EnvVarSave {
  name: string;
  secret: boolean;
  value?: string;
}

export interface EnvRow {
  key: number;
  name: string;
  value: string;
  secret: boolean;
  /** Existing secret: its value is kept unless a new one is typed. */
  stored: boolean;
  reveal: boolean;
}

export type EnvProblem = 'nameRequired' | 'nameInvalid' | 'nameReserved' | 'nameDuplicate' | 'valueRequired' | 'unsecretValueRequired';

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

let seq = 0;
export const nextRowKey = (): number => seq++;

export function toRows(vars: readonly EnvVarView[]): EnvRow[] {
  return vars.map((v) => ({ key: seq++, name: v.name, value: v.value ?? '', secret: v.secret, stored: v.secret, reveal: false }));
}

export function emptyRow(): EnvRow {
  return { key: seq++, name: '', value: '', secret: false, stored: false, reveal: true };
}

/** KEY=VALUE lines of a .env (comments, export prefix and surrounding quotes handled). */
export function parseDotEnv(text: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out.push({ name: m[1], value: v });
  }
  return out;
}

/** First problem of a row (null = valid). `reserved`: names the platform keeps (sites). */
export function rowProblem(r: EnvRow, rows: readonly EnvRow[], reserved: (name: string) => boolean = () => false): EnvProblem | null {
  if (!r.name) return 'nameRequired';
  if (!ENV_NAME_RE.test(r.name)) return 'nameInvalid';
  if (reserved(r.name)) return 'nameReserved';
  if (rows.filter((x) => x.name === r.name).length > 1) return 'nameDuplicate';
  if (!r.stored && r.value === '' && r.secret) return 'valueRequired';
  if (r.stored && r.value === '' && !r.secret) return 'unsecretValueRequired';
  return null;
}

/** Secret proposed by the site import (unchanged behaviour of SiteEnvTab). */
export const siteGuessSecret = (name: string): boolean => /SECRET|PASSWORD|PASS|TOKEN|KEY|PRIVATE/i.test(name);

/** Pasted .env: existing names get the new value, the others are added (secret guessed from the name). */
export function importRows(rows: readonly EnvRow[], parsed: ReadonlyArray<{ name: string; value: string }>, guessSecret: (name: string) => boolean = siteGuessSecret): EnvRow[] {
  const next = [...rows];
  for (const p of parsed) {
    const i = next.findIndex((r) => r.name === p.name);
    if (i >= 0) next[i] = { ...next[i], value: p.value, stored: false };
    else next.push({ key: seq++, name: p.name, value: p.value, secret: guessSecret(p.name), stored: false, reveal: false });
  }
  return next;
}

/** .env example: ONLY the names absent from the rows are added (never a value overwritten), comments ignored. */
export function addMissingRows(rows: readonly EnvRow[], parsed: ReadonlyArray<{ name: string; value: string }>, guessSecret: (name: string) => boolean): { rows: EnvRow[]; added: string[] } {
  const have = new Set(rows.map((r) => r.name));
  const next = [...rows];
  const added: string[] = [];
  for (const p of parsed) {
    if (have.has(p.name)) continue;
    have.add(p.name);
    added.push(p.name);
    next.push({ key: seq++, name: p.name, value: p.value, secret: guessSecret(p.name), stored: false, reveal: false });
  }
  return { rows: next, added };
}

/** Body of the save: a stored secret left empty is sent without value (unchanged). */
export function saveBody(rows: readonly EnvRow[]): EnvVarSave[] {
  return rows.map((r) => ({ name: r.name, secret: r.secret, ...(r.stored && r.value === '' ? {} : { value: r.value }) }));
}
