// ─────────────────────────────────────────────────────────────────────────────
// .env example of an application source (`.env.example` and its usual
// variants): where it is looked for, which variables it declares, and how it
// is merged into a stack .env WITHOUT ever overwriting a value already set.
// PURE (shared by the server and the client).
// ─────────────────────────────────────────────────────────────────────────────

/** Names of the .env example, in order of preference. */
export const APP_ENV_EXAMPLE_NAMES = ['.env.example', '.env.sample', '.env.dist', 'example.env'] as const;

/** Largest example read (same bound as a stack .env). */
export const APP_ENV_EXAMPLE_MAX_BYTES = 64 * 1024;

/** GET /apps/stacks/:id/env-template, POST /apps/git/env-template */
export interface AppEnvTemplate {
  /** Path of the example found, relative to the source root (null: none). */
  file: string | null;
  /** Its text: example values, not secret (null when none). */
  content: string | null;
  /** Variable names the example declares, in order. */
  keys: string[];
  /** Keys of the example absent from the stack .env (the whole `keys` for a repository not created yet). */
  missingKeys: string[];
}

/** POST /apps/git/env-template: the repository of an application not created yet (same rules as the git source). */
export interface AppEnvTemplateProbe {
  accountId: number;
  repoUrl: string;
  branch?: string;
  composePath?: string;
  /** Access token of a private repository (never stored by this call). */
  token?: string | null;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Paths (relative to the source root) where the example is looked for: the directory of the compose
 * file first, then the root; each in the order of APP_ENV_EXAMPLE_NAMES.
 */
export function envExampleCandidates(composePath: string | null | undefined): string[] {
  const p = (composePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  const out: string[] = [];
  if (dir && !dir.split('/').some((s) => s === '..' || s === '' || s === '.')) for (const n of APP_ENV_EXAMPLE_NAMES) out.push(`${dir}/${n}`);
  for (const n of APP_ENV_EXAMPLE_NAMES) out.push(n);
  return out;
}

interface EnvEntry {
  key: string;
  /** The comment block right above the assignment (no blank line between) + the assignment line(s). */
  lines: string[];
}

/** Key of an assignment line (`KEY=…`, `export KEY=…`), null otherwise. */
function assignmentKey(line: string): string | null {
  let s = line.trim();
  if (!s || s.startsWith('#')) return null;
  if (s.startsWith('export ')) s = s.slice(7).trim();
  const eq = s.indexOf('=');
  if (eq <= 0) return null;
  const key = s.slice(0, eq).trim();
  return KEY_RE.test(key) ? key : null;
}

/** Whether the quoted value opened on this assignment line is still open at its end. */
function opensMultiline(line: string): string | null {
  const eq = line.indexOf('=');
  const raw = line.slice(eq + 1).trim();
  const q = raw[0];
  if (q !== '"' && q !== "'") return null;
  return closes(raw.slice(1), q) ? null : q;
}

function closes(body: string, q: string): boolean {
  for (let j = 0; j < body.length; j++) {
    if (body[j] === '\\' && q === '"') { j++; continue; }
    if (body[j] === q) return true;
  }
  return false;
}

/** Entries of a dotenv text (multi-line quoted values kept whole). */
function entries(text: string): EnvEntry[] {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: EnvEntry[] = [];
  let comments: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { comments = []; continue; }
    if (t.startsWith('#')) { comments.push(line); continue; }
    const key = assignmentKey(line);
    if (!key) { comments = []; continue; }
    const own = [...comments, line];
    comments = [];
    let q = opensMultiline(line);
    let body = '';
    while (q && i + 1 < lines.length) {
      i++;
      own.push(lines[i]);
      body += `${lines[i]}\n`;
      if (closes(body, q)) q = null;
    }
    out.push({ key, lines: own });
  }
  return out;
}

/** Variable names of a dotenv text, first occurrence order, no duplicate. */
export function dotenvExampleKeys(text: string): string[] {
  const seen = new Set<string>();
  for (const e of entries(text)) seen.add(e.key);
  return [...seen];
}

/**
 * Adds to `current` the variables of `example` it does not set yet (with the comment block right above
 * each of them), after an optional `header` comment line. `current` is never rewritten: only appended
 * to, so every value (and comment) already there stays as it is.
 */
export function mergeEnvExample(current: string, example: string, header?: string): { text: string; added: string[] } {
  const have = new Set(entries(current).map((e) => e.key));
  const block: string[] = [];
  const added: string[] = [];
  for (const e of entries(example)) {
    if (have.has(e.key)) continue;
    have.add(e.key);
    added.push(e.key);
    block.push(...e.lines);
  }
  if (!added.length) return { text: current, added };
  let text = current ?? '';
  if (text && !text.endsWith('\n')) text += '\n';
  if (text.trim()) text += '\n';
  if (header) text += `${header.startsWith('#') ? header : `# ${header}`}\n`;
  text += `${block.join('\n')}\n`;
  return { text, added };
}

// ─── Variables of an application .env (Settings, same editor as the site variables) ───

/** Names whose value is treated as secret by default (masking, import, migration 050). */
export const ENV_SECRET_KEY_RE = /(PASS|PWD|SECRET|TOKEN|KEY|CREDENTIAL|PRIVATE|AUTH|SALT|SIGNATURE|CERT|DSN|DATABASE_URL|_URI$|COOKIE|SESSION)/i;

export function envKeyLooksSecret(name: string): boolean {
  return ENV_SECRET_KEY_RE.test(name);
}

/** GET /apps/stacks/:id/env: one entry per variable of the sealed .env. */
export interface AppEnvVar {
  name: string;
  /** null for a secret: the value is never sent back (write-only). */
  value: string | null;
  secret: boolean;
}

export interface AppEnvVarInput {
  name: string;
  /** Omitted / null on an existing secret: the stored value is kept. */
  value?: string | null;
  secret?: boolean;
}

/** PUT /apps/stacks/:id/env: the whole set (the form sends every variable). */
export interface AppEnvUpdate {
  vars: AppEnvVarInput[];
}
