import type { AppEnvVar, AppEnvVarInput } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';
import { ENV_KEY_RE, ENV_MAX_KEYS, looksSecret, stringifyDotenv } from './compose/dotenv';

// ─────────────────────────────────────────────────────────────────────────────
// The .env of an application as variables (Settings, same editor as the site
// variables, shared/src/siteEnv.ts): the .env stays ONE sealed dotenv text
// (env_sealed), the Secret flags live beside it (env_secret_keys, migration
// 050). A secret is write-only: its value is never sent back, a secret sent
// without a value keeps the stored one, and turning a secret visible needs a
// new value (the stored one would come back in clear). PURE.
// ─────────────────────────────────────────────────────────────────────────────

/** Longest value of one variable (like a site variable). */
export const APP_ENV_MAX_VALUE = 32 * 1024;

/** Variables of a .env for the API: values of the secrets never included. */
export function envVarsOf(env: ReadonlyMap<string, string>, secretKeys: Iterable<string>): AppEnvVar[] {
  const secret = new Set(secretKeys);
  return [...env].map(([name, value]) => (secret.has(name) ? { name, value: null, secret: true } : { name, value, secret: false }));
}

/**
 * Secret names after a .env given as TEXT (creation, catalog, older clients): a key stays secret when it
 * was, a key is secret when its name looks secret or the catalog template declares it secret; a flag given
 * explicitly (`flags`, the variables form) wins for the names it covers.
 */
export function secretKeysFor(keys: Iterable<string>, opts: { previous?: Iterable<string>; templateSecret?: Iterable<string>; flags?: ReadonlyMap<string, boolean> } = {}): string[] {
  const previous = new Set(opts.previous ?? []);
  const template = new Set(opts.templateSecret ?? []);
  const out: string[] = [];
  for (const k of keys) {
    const flag = opts.flags?.get(k);
    if (flag !== undefined ? flag : previous.has(k) || looksSecret(k) || template.has(k)) out.push(k);
  }
  return out;
}

/**
 * The .env text + flags a variables form stands for, against the stored .env. 400 when a name is invalid or
 * repeated, a value too long / with NUL, a new variable has no value, or a stored secret turned visible has
 * no new value.
 */
export function envFromVars(vars: AppEnvVarInput[], current: ReadonlyMap<string, string>, currentSecret: ReadonlySet<string>): { text: string; env: Map<string, string>; flags: Map<string, boolean> } {
  if (vars.length > ENV_MAX_KEYS) throw new AppError(400, `At most ${ENV_MAX_KEYS} variables`, 'validation');
  const env = new Map<string, string>();
  const flags = new Map<string, boolean>();
  for (const v of vars) {
    if (!ENV_KEY_RE.test(v.name)) throw new AppError(400, `Invalid name: ${v.name.slice(0, 64)} (letters, digits, _; not starting with a digit)`, 'envNameInvalid', { name: v.name.slice(0, 128) });
    if (env.has(v.name)) throw new AppError(400, `Duplicate variable ${v.name}`, 'envNameDuplicate', { name: v.name });
    const secret = v.secret === true;
    let value: string;
    if (v.value === undefined || v.value === null) {
      const stored = current.get(v.name);
      if (stored === undefined) throw new AppError(400, `${v.name}: a value is required`, 'envValueRequired', { name: v.name });
      if (currentSecret.has(v.name) && !secret) throw new AppError(400, `${v.name}: a new value is required to make a secret visible`, 'envValueRequired', { name: v.name });
      value = stored;
    } else {
      if (v.value.length > APP_ENV_MAX_VALUE) throw new AppError(400, `${v.name}: value too long`, 'validation', { name: v.name });
      if (v.value.includes('\0')) throw new AppError(400, `${v.name}: NUL character not allowed`, 'validation', { name: v.name });
      value = v.value;
    }
    env.set(v.name, value);
    flags.set(v.name, secret);
  }
  return { text: stringifyDotenv(env), env, flags };
}

/** Same variables and same secret flags (nothing to save). */
export function sameEnv(a: ReadonlyMap<string, string>, aSecret: ReadonlySet<string>, b: ReadonlyMap<string, string>, bSecret: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
    if (aSecret.has(k) !== bSecret.has(k)) return false;
  }
  return true;
}
