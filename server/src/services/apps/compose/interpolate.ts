// ─────────────────────────────────────────────────────────────────────────────
// Compose variable interpolation (docs/P4b-PLAN.md §5.2). PURE. Values come
// from the stack .env ONLY — never from the panel's process environment.
//   $$            literal $
//   $VAR ${VAR}   value (missing → '' + warning)
//   ${VAR:-d} ${VAR-d}   default when unset or empty (:-) / unset (-)
//   ${VAR:?msg} ${VAR?msg} required (missing → error)
//   ${VAR:+alt} ${VAR+alt} alternative when set (and non-empty for :+)
// Defaults / alternatives / messages are themselves interpolated (nesting).
// ─────────────────────────────────────────────────────────────────────────────

export interface InterpolationProblem {
  kind: 'missing' | 'required' | 'syntax';
  variable: string;
  message: string;
}

export class InterpolationError extends Error {
  constructor(readonly problem: InterpolationProblem) {
    super(problem.message);
  }
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

/** Index of the `}` closing the `${` opened just before `start` (nested braces counted), -1 if none. */
function closingBrace(s: string, start: number): number {
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '$' && s[i + 1] === '$') { i++; continue; }
    if (c === '$' && s[i + 1] === '{') { depth++; i++; continue; }
    if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Interpolates one string. Missing plain variables are reported through
 * `problems` (kind 'missing', the value becomes ''); a required variable that
 * is missing, or a syntax error, throws InterpolationError.
 */
export function interpolate(input: string, env: ReadonlyMap<string, string>, problems: InterpolationProblem[] = [], depth = 0): string {
  if (depth > 8) throw new InterpolationError({ kind: 'syntax', variable: '', message: 'variable substitution nested too deeply' });
  if (!input.includes('$')) return input;
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c !== '$') { out += c; continue; }
    const next = input[i + 1];
    if (next === '$') { out += '$'; i++; continue; }
    if (next === '{') {
      const end = closingBrace(input, i + 2);
      if (end < 0) throw new InterpolationError({ kind: 'syntax', variable: '', message: `unterminated "\${" in "${input.slice(i, i + 40)}"` });
      const body = input.slice(i + 2, end);
      out += expand(body, env, problems, depth);
      i = end;
      continue;
    }
    const m = NAME_RE.exec(input.slice(i + 1));
    if (!m) { out += '$'; continue; } // a lone $ (e.g. "price: 5$") stays as is
    const name = m[0];
    const v = env.get(name);
    if (v === undefined) problems.push({ kind: 'missing', variable: name, message: `variable ${name} is not set (empty string used)` });
    out += v ?? '';
    i += name.length;
  }
  return out;
}

function expand(body: string, env: ReadonlyMap<string, string>, problems: InterpolationProblem[], depth: number): string {
  const m = NAME_RE.exec(body);
  if (!m) throw new InterpolationError({ kind: 'syntax', variable: '', message: `invalid substitution "\${${body.slice(0, 40)}}"` });
  const name = m[0];
  const rest = body.slice(name.length);
  const value = env.get(name);
  const set = value !== undefined;
  const nonEmpty = set && value !== '';
  if (rest === '') {
    if (!set) problems.push({ kind: 'missing', variable: name, message: `variable ${name} is not set (empty string used)` });
    return value ?? '';
  }
  const op = rest.startsWith(':') ? rest.slice(0, 2) : rest.slice(0, 1);
  const arg = rest.slice(op.length);
  const sub = () => interpolate(arg, env, problems, depth + 1);
  switch (op) {
    case ':-': return nonEmpty ? value! : sub();
    case '-': return set ? value! : sub();
    case ':+': return nonEmpty ? sub() : '';
    case '+': return set ? sub() : '';
    case ':?':
    case '?': {
      const ok = op === ':?' ? nonEmpty : set;
      if (ok) return value!;
      const msg = arg ? sub() : `required variable ${name} is missing a value`;
      throw new InterpolationError({ kind: 'required', variable: name, message: msg || `required variable ${name} is missing a value` });
    }
    default:
      throw new InterpolationError({ kind: 'syntax', variable: name, message: `invalid substitution "\${${body.slice(0, 40)}}"` });
  }
}
