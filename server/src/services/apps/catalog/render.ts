import crypto from 'crypto';
import vm from 'vm';
import type { AppTemplateField } from '@oblimint/shared';
import { AppError } from '../../../middleware/errorHandler';
import { ENV_KEY_RE } from '../compose/dotenv';

// Template field values (docs/P4b-PLAN.md §5.3 catalog): user values checked against the field type /
// options / pattern, empty generated fields generated, every value written to the stack .env (the
// compose interpolates ${KEY} from it); only the NON-secret values are kept in clear (template_values).

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function generateValue(kind: NonNullable<AppTemplateField['generate']>): string {
  switch (kind) {
    case 'hex32': return crypto.randomBytes(32).toString('hex');
    case 'base64-32': return crypto.randomBytes(32).toString('base64');
    case 'uuid': return crypto.randomUUID();
    case 'password':
    default: {
      const bytes = crypto.randomBytes(24);
      let out = '';
      for (const b of bytes) out += PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length];
      return out;
    }
  }
}

/** Longest field pattern accepted (template definitions). */
export const MAX_FIELD_PATTERN = 256;

/**
 * Why a field pattern could backtrack catastrophically (null = safe). Template patterns are written by
 * tenant staff and run synchronously on the shared panel event loop (security audit P4b), so only a
 * linear-time subset is accepted: no backreference, no lookbehind, and no quantified group that itself
 * contains a quantifier or an alternation ((a+)+, (a|a)*, (\w*\s?){2,} …).
 */
export function unsafePattern(pattern: string): string | null {
  if (pattern.length > MAX_FIELD_PATTERN) return 'pattern too long';
  try { new RegExp(pattern); } catch { return 'invalid regular expression'; }
  if (/\\[1-9]|\\k<|\(\?<[=!]/.test(pattern)) return 'backreferences and lookbehinds are not allowed';
  // One frame per open group: does it contain a quantifier / an alternation?
  const stack: Array<{ quant: boolean; alt: boolean }> = [{ quant: false, alt: false }];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') { i++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    const top = stack[stack.length - 1];
    if (ch === '(') { stack.push({ quant: false, alt: false }); continue; }
    if (ch === '|') { top.alt = true; continue; }
    const quantAt = (j: number): boolean => {
      const c = pattern[j];
      if (c === '*' || c === '+') return true;
      if (c === '{') return /^\{\d*(,\d*)?\}/.test(pattern.slice(j)) && !/^\{0*1?\}/.test(pattern.slice(j));
      return false;
    };
    if (ch === ')') {
      const inner = stack.pop();
      if (!inner || stack.length === 0) return 'invalid regular expression';
      const parent = stack[stack.length - 1];
      if (quantAt(i + 1) && (inner.quant || inner.alt)) return 'nested quantifiers are not allowed';
      if (inner.quant || quantAt(i + 1)) parent.quant = true;
      continue;
    }
    if (quantAt(i)) top.quant = true;
  }
  return null;
}

/** Time budget of one pattern match (the structural check does not catch every polynomial blow-up). */
export const PATTERN_TIMEOUT_MS = 50;
/** Budget of the single retry after a timeout (a starved event loop / CPU can eat the first budget of a cheap match). */
export const PATTERN_RETRY_TIMEOUT_MS = 250;

/** re.test(value) interrupted after PATTERN_TIMEOUT_MS (V8 terminates a backtracking regexp); null = timed out. */
export function boundedTest(pattern: string, value: string): boolean | null {
  let re: RegExp;
  try { re = new RegExp(pattern); } catch { return null; }
  // One compiled script + one context, reused (a new context per match costs milliseconds of the budget).
  // A timeout is retried once with a larger budget: a busy event loop / CPU starvation can eat the budget
  // of a cheap match, a really slow pattern times out twice (worst case PATTERN_TIMEOUT_MS + PATTERN_RETRY_TIMEOUT_MS).
  for (const timeout of [PATTERN_TIMEOUT_MS, PATTERN_RETRY_TIMEOUT_MS]) {
    patternContext.re = re;
    patternContext.v = value;
    patternContext.out = false;
    try {
      PATTERN_SCRIPT.runInContext(patternContext, { timeout });
      return (patternContext.out as boolean) === true;
    } catch (err) {
      if ((err as { code?: string })?.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') return null;
    } finally {
      patternContext.re = null;
      patternContext.v = '';
    }
  }
  return null;
}
const PATTERN_SCRIPT = new vm.Script('out = re.test(v)');
const patternContext = vm.createContext({ re: null as RegExp | null, v: '', out: false }) as { re: RegExp | null; v: string; out: boolean };

function invalid(field: AppTemplateField, why: string): AppError {
  return new AppError(400, `Field ${field.label} (${field.key}): ${why}`, 'validation', { field: field.key });
}

function check(field: AppTemplateField, raw: string): string {
  const v = raw.trim();
  if (v.length > 2048 || /[\r\n\0]/.test(v)) throw invalid(field, 'invalid value');
  switch (field.type) {
    case 'number': if (!/^-?\d+(\.\d+)?$/.test(v)) throw invalid(field, 'a number is expected'); break;
    case 'boolean': if (v !== 'true' && v !== 'false') throw invalid(field, 'true or false is expected'); break;
    case 'select': if (!(field.options ?? []).includes(v)) throw invalid(field, 'value not in the list'); break;
    case 'email': if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw invalid(field, 'an e-mail address is expected'); break;
    case 'url': {
      let u: URL;
      try { u = new URL(v); } catch { throw invalid(field, 'a URL is expected'); }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw invalid(field, 'an http(s) URL is expected');
      break;
    }
    case 'domain': if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(v)) throw invalid(field, 'a domain name is expected'); break;
    default: break;
  }
  if (field.pattern) {
    // Fail closed: a pattern saved before this check (or unsafe) never runs on a value.
    if (unsafePattern(field.pattern)) throw invalid(field, 'the template pattern of this field is not usable');
    const matched = boundedTest(field.pattern, v);
    if (matched === null) throw invalid(field, 'the template pattern of this field is too slow for this value');
    if (!matched) throw invalid(field, 'value does not match the expected format');
  }
  return v;
}

export interface RenderedValues {
  /** Every field (generated included), for the .env. */
  env: Array<[string, string]>;
  /** Non-secret values (template_values). */
  values: Record<string, string | number | boolean>;
}

/**
 * `given`: user values; `existing`: current .env (update: a secret field sent empty keeps its value).
 * Required fields without a value (and nothing to generate) → 400.
 */
export function renderFieldValues(fields: AppTemplateField[], given: Record<string, string | number | boolean>, existing: ReadonlyMap<string, string> = new Map()): RenderedValues {
  const env: Array<[string, string]> = [];
  const values: RenderedValues['values'] = {};
  for (const f of fields) {
    if (!ENV_KEY_RE.test(f.key)) throw new AppError(400, `Invalid template field key ${f.key}`, 'validation');
    const raw = given[f.key];
    let v: string | null = raw === undefined || raw === null ? null : String(raw);
    if (v !== null && v.trim() === '') v = null;
    if (v === null) v = existing.get(f.key) ?? null;
    if (v === null && f.default !== null && f.default !== undefined && String(f.default) !== '') v = String(f.default);
    if (v === null && f.generate) v = generateValue(f.generate);
    if (v === null) {
      if (f.required) throw invalid(f, 'a value is required');
      continue;
    }
    v = f.generate && existing.get(f.key) === v ? v : check(f, v);
    env.push([f.key, v]);
    if (!f.secret) values[f.key] = f.type === 'boolean' ? v === 'true' : f.type === 'number' ? Number(v) : v;
  }
  return { env, values };
}
