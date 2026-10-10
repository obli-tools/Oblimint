// ─────────────────────────────────────────────────────────────────────────────
// Minimal nginx configuration tokenizer — PURE (module edge-robustness,
// docs/P4b-PLAN.md §8.5). Used by the advancedConfig linter (lint.ts) and by
// the re-check of every unit's configuration before its sandbox test
// (unitCheck.ts). Follows nginx's own lexer closely enough for directive /
// argument / block analysis:
//   - `#` starts a comment only at the start of a token (`a#b` is one word);
//   - a quote starts a quoted string only at the start of a token; backslash
//     escapes the next character inside it;
//   - `;`, `{`, `}` and whitespace end an unquoted word, except `${…}`
//     (variable in braces);
//   - `{` opens the block of the statement it ends, `}` closes the innermost.
// It never evaluates anything: nginx -t in the sandbox remains the judge, the
// parser only lets the panel refuse what must never reach nginx at all.
// ─────────────────────────────────────────────────────────────────────────────

export interface NginxStatement {
  directive: string;
  /** Arguments, quotes removed (escapes resolved). */
  args: string[];
  /** 1-based line of the directive name. */
  line: number;
  /** Number of enclosing blocks. */
  depth: number;
  /** Directives of the enclosing blocks, outermost first. */
  parents: string[];
  /** Statement ended by `{` (block) rather than `;`. */
  block: boolean;
}

export interface NginxParseIssue {
  line: number;
  code: 'unbalancedBraces' | 'syntax';
  message: string;
}

export interface NginxParseResult {
  statements: NginxStatement[];
  issues: NginxParseIssue[];
}

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

/** Tokenizes `text` into statements; never throws (problems are returned as issues). */
export function parseNginx(text: string): NginxParseResult {
  const src = String(text ?? '');
  const statements: NginxStatement[] = [];
  const issues: NginxParseIssue[] = [];
  const stack: Array<{ directive: string; line: number }> = [];
  let words: Array<{ value: string; line: number }> = [];
  let line = 1;
  let i = 0;

  const flush = (block: boolean, at: number) => {
    if (words.length === 0) {
      issues.push({ line: at, code: 'syntax', message: `unexpected "${block ? '{' : ';'}"` });
      return;
    }
    const [head, ...rest] = words;
    statements.push({
      directive: head.value,
      args: rest.map((w) => w.value),
      line: head.line,
      depth: stack.length,
      parents: stack.map((s) => s.directive),
      block,
    });
    if (block) stack.push({ directive: head.value, line: head.line });
    words = [];
  };

  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (isSpace(c)) { i++; continue; }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === ';') { flush(false, line); i++; continue; }
    if (c === '{') { flush(true, line); i++; continue; }
    if (c === '}') {
      if (words.length > 0) {
        issues.push({ line, code: 'syntax', message: `unexpected "}" (missing ";" after "${words[0].value}")` });
        words = [];
      }
      if (stack.length === 0) issues.push({ line, code: 'unbalancedBraces', message: 'unexpected "}": no block to close' });
      else stack.pop();
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      const startLine = line;
      let value = '';
      i++;
      let closed = false;
      while (i < src.length) {
        const d = src[i];
        if (d === '\\' && i + 1 < src.length) {
          const n = src[i + 1];
          if (n === '\n') line++;
          value += n === quote || n === '\\' ? n : `\\${n}`;
          i += 2;
          continue;
        }
        if (d === quote) { closed = true; i++; break; }
        if (d === '\n') line++;
        value += d;
        i++;
      }
      if (!closed) {
        issues.push({ line: startLine, code: 'syntax', message: 'unterminated quoted string' });
        return { statements, issues };
      }
      words.push({ value, line: startLine });
      continue;
    }
    // Unquoted word.
    const startLine = line;
    let value = '';
    while (i < src.length) {
      const d = src[i];
      if (isSpace(d) || d === ';' || d === '}') break;
      if (d === '{') {
        // `${name}`: variable in braces, part of the word.
        if (value.endsWith('$')) {
          const end = src.indexOf('}', i);
          if (end < 0) break;
          value += src.slice(i, end + 1);
          i = end + 1;
          continue;
        }
        break;
      }
      value += d;
      i++;
    }
    words.push({ value, line: startLine });
  }

  if (words.length > 0) issues.push({ line: words[0].line, code: 'syntax', message: `unexpected end of input (missing ";" after "${words[0].value}")` });
  for (const open of stack) issues.push({ line: open.line, code: 'unbalancedBraces', message: `block "${open.directive}" is never closed` });
  return { statements, issues };
}

/** A single nginx variable (`$name` / `${name}`), nothing else. */
export const NGINX_VARIABLE_RE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;

/** Directives that hand the request to an upstream: their target must be a variable (ED2). */
export const PASS_DIRECTIVES: ReadonlySet<string> = new Set(['proxy_pass', 'grpc_pass', 'fastcgi_pass', 'uwsgi_pass', 'scgi_pass', 'memcached_pass']);

/** Embedded-language / module-loading directives never accepted anywhere. */
export function isScriptingDirective(name: string): boolean {
  return /^(lua|perl|js)(_|$)/.test(name) || /_by_lua(_|$)/.test(name) || name === 'njs';
}
