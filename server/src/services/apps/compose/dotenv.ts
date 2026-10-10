// ─────────────────────────────────────────────────────────────────────────────
// .env of a stack (docs/P4b-PLAN.md §5.3): dotenv text → ordered key / value
// pairs. PURE. The text is stored sealed (secretBox('apps')), only the keys
// in clear (app_stacks.env_keys). Supported: KEY=value, `export KEY=value`,
// comments (#, also after an unquoted value), single quotes (literal) and
// double quotes (\n \t \" \\ escapes). Values are never interpolated here:
// ${VAR} in the COMPOSE is resolved from these values (interpolate.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Hard limits of a stack .env (the route also bounds the body). */
export const ENV_MAX_BYTES = 64 * 1024;
export const ENV_MAX_KEYS = 500;

export interface DotenvResult {
  values: Map<string, string>;
  errors: Array<{ line: number; message: string }>;
}

function unescapeDouble(s: string): string {
  return s.replace(/\\([nrt"\\$])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
}

export function parseDotenv(text: string): DotenvResult {
  const values = new Map<string, string>();
  const errors: DotenvResult['errors'] = [];
  if (Buffer.byteLength(text ?? '', 'utf8') > ENV_MAX_BYTES) {
    errors.push({ line: 0, message: `.env larger than ${ENV_MAX_BYTES / 1024} KiB` });
    return { values, errors };
  }
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) { errors.push({ line: lineNo, message: 'expected KEY=value' }); continue; }
    const key = line.slice(0, eq).trim();
    if (!ENV_KEY_RE.test(key)) { errors.push({ line: lineNo, message: `invalid variable name "${key.slice(0, 64)}"` }); continue; }
    let raw = line.slice(eq + 1).trim();
    let value: string;
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const q = raw[0];
      // Multi-line quoted values: join the following lines until the closing quote.
      let body = raw.slice(1);
      let close = findClose(body, q);
      while (close < 0 && i + 1 < lines.length) {
        i++;
        body += `\n${lines[i]}`;
        close = findClose(body, q);
      }
      if (close < 0) { errors.push({ line: lineNo, message: 'unterminated quoted value' }); continue; }
      const inner = body.slice(0, close);
      value = q === '"' ? unescapeDouble(inner) : inner;
    } else {
      const hash = raw.search(/\s#/);
      if (hash >= 0) raw = raw.slice(0, hash).trim();
      value = raw;
    }
    values.set(key, value);
    if (values.size > ENV_MAX_KEYS) { errors.push({ line: lineNo, message: `more than ${ENV_MAX_KEYS} variables` }); break; }
  }
  return { values, errors };
}

function findClose(body: string, q: string): number {
  for (let j = 0; j < body.length; j++) {
    if (body[j] === '\\' && q === '"') { j++; continue; }
    if (body[j] === q) return j;
  }
  return -1;
}

/** Serializes values back to dotenv text (double-quoted when needed). */
export function stringifyDotenv(values: Iterable<[string, string]>): string {
  const out: string[] = [];
  for (const [k, v] of values) {
    if (!ENV_KEY_RE.test(k)) continue;
    const plain = /^[A-Za-z0-9_./:@%+,=-]*$/.test(v);
    out.push(plain ? `${k}=${v}` : `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/\$/g, '\\$')}"`);
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

/** Variable names whose value must never be shown (inspect, effective YAML, logs). */
export const SECRET_KEY_RE = /(PASS|PWD|SECRET|TOKEN|KEY|CREDENTIAL|PRIVATE|AUTH|SALT|SIGNATURE|CERT|DSN|DATABASE_URL|_URI$|COOKIE|SESSION)/i;

export function looksSecret(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}
