// ─────────────────────────────────────────────────────────────────────────────
// Minimal PHP lexer for the change-scanner heuristics (docs/P3-PLAN.md §9.2) —
// PURE, linear, no recursion (a hostile input cannot overflow the stack).
//
// The regular-expression rules must look at CODE, not at what PHP never runs:
// docblocks quote `$_GET` in Markdown backticks, comments mention variable
// names followed by parentheses, single-quoted strings hold SQL with
// backticks… Those produced critical false positives on a pristine WordPress.
//
// lexPhp() returns two views of the text, each the SAME length as the input
// (offsets and line numbers are unchanged; newlines are kept):
//   - noComments: comments blanked (spaces);
//   - code:       comments AND the content of non-interpolating literals
//                 (single-quoted strings, nowdocs) blanked.
// Double-quoted strings, heredocs and backtick strings are kept: they
// interpolate variables, so request input inside them is real data flow.
// The spans of backtick (shell execution) literals are reported as well.
//
// Soundness (a hostile file must not hide code from the rules): the lexer only
// blanks what PHP itself treats as a comment / literal, and where it may
// diverge it errs towards "code":
//   - outside PHP tags nothing is blanked (inline HTML stays visible);
//   - `#[` is an attribute (PHP 8), never a comment;
//   - `?>` ends a line comment (as in PHP), never a block comment or string;
//   - `{$ … }` and `${ … }` inside interpolating strings are lexed as code
//     (nested strings / comments there do not end the outer string);
//   - the short open tag `<?` depends on short_open_tag (PHP_INI_PERDIR: a
//     .user.ini can turn it on): callers lex with both settings when the file
//     holds a bare `<?` (see needsShortTagVariant) and union the findings.
// ─────────────────────────────────────────────────────────────────────────────

export interface PhpViews {
  noComments: string;
  code: string;
  /** [start, end) of each backtick (shell execution) literal, quotes included. */
  backticks: Array<[number, number]>;
}

const NL = 10;
const CR = 13;
const SPACE = 32;

type Frame =
  | { t: 'code'; top: boolean; depth: number }
  | { t: 'str'; end: number; start: number }
  | { t: 'here'; id: string; body: number };

const HEREDOC_HEAD = /<<<[ \t]*(?:"([A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*)"|'([A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*)'|([A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*))(\r\n|\n|\r)/y;

function isIdentChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 0x80;
}

function isWs(c: number): boolean {
  return c === SPACE || c === 9 || c === NL || c === CR;
}

/** The file holds a `<?` that is neither `<?php` + whitespace nor `<?=`: its meaning depends on short_open_tag. */
export function needsShortTagVariant(text: string): boolean {
  for (let j = text.indexOf('<?'); j !== -1; j = text.indexOf('<?', j + 2)) {
    if (!openerAt(text, j, false)) return true;
  }
  return false;
}

/** Length of the PHP open tag at j (0: none). */
function openerAt(text: string, j: number, shortTags: boolean): number {
  if (text.charCodeAt(j + 2) === 61 /* = */) return 3;
  if (/^php$/i.test(text.slice(j + 2, j + 5)) && (j + 5 >= text.length || isWs(text.charCodeAt(j + 5)))) return 5;
  return shortTags ? 2 : 0;
}

/** Index of the closing quote of a single-quoted string whose content starts at `from` (-1: unterminated). */
function endOfSingle(text: string, from: number): number {
  const n = text.length;
  for (let k = from; k < n; k++) {
    const c = text.charCodeAt(k);
    if (c === 92) k++;
    else if (c === 39) return k;
  }
  return -1;
}

/** Heredoc / nowdoc closing marker at line start `k` (optional indentation): position after the label, or -1. */
function closingAt(text: string, k: number, id: string): number {
  let p = k;
  while (p < text.length && (text.charCodeAt(p) === SPACE || text.charCodeAt(p) === 9)) p++;
  if (!text.startsWith(id, p)) return -1;
  const after = p + id.length;
  return after < text.length && isIdentChar(text.charCodeAt(after)) ? -1 : after;
}

export function lexPhp(text: string, shortTags = false): PhpViews {
  const n = text.length;
  const nc = Buffer.from(text, 'latin1');
  const cd = Buffer.from(nc);
  const backticks: Array<[number, number]> = [];
  const blank = (buf: Buffer, from: number, to: number) => {
    for (let k = from; k < to; k++) {
      const c = buf[k];
      if (c !== NL && c !== CR) buf[k] = SPACE;
    }
  };
  const stack: Frame[] = [];
  let i = 0;

  while (i < n) {
    const f = stack[stack.length - 1];
    if (!f) {
      // Inline HTML: nothing is blanked, look for the next open tag.
      let j = text.indexOf('<?', i);
      let len = 0;
      while (j !== -1 && !(len = openerAt(text, j, shortTags))) j = text.indexOf('<?', j + 2);
      if (j === -1) break;
      i = j + len;
      stack.push({ t: 'code', top: true, depth: 0 });
      continue;
    }

    const c = text.charCodeAt(i);
    if (f.t === 'code') {
      const c1 = text.charCodeAt(i + 1);
      if (f.top && c === 63 /* ? */ && c1 === 62 /* > */) {
        stack.pop();
        i += 2;
        continue;
      }
      if (c === 35 /* # */ && c1 === 91 /* [ */) { i += 2; continue; }
      if (c === 35 || (c === 47 /* / */ && c1 === 47)) {
        // Line comment: ends at a newline or at `?>` (which then closes PHP mode).
        let k = i;
        while (k < n) {
          const x = text.charCodeAt(k);
          if (x === NL || x === CR || (x === 63 && text.charCodeAt(k + 1) === 62)) break;
          k++;
        }
        blank(nc, i, k);
        blank(cd, i, k);
        i = k;
        continue;
      }
      if (c === 47 && c1 === 42 /* * */) {
        const e = text.indexOf('*/', i + 2);
        const k = e === -1 ? n : e + 2;
        blank(nc, i, k);
        blank(cd, i, k);
        i = k;
        continue;
      }
      if (c === 39 /* ' */) {
        const close = endOfSingle(text, i + 1);
        blank(cd, i + 1, close === -1 ? n : close);
        i = close === -1 ? n : close + 1;
        continue;
      }
      if (c === 34 /* " */ || c === 96 /* ` */) {
        stack.push({ t: 'str', end: c, start: i });
        i++;
        continue;
      }
      if (c === 60 /* < */ && c1 === 60 && text.charCodeAt(i + 2) === 60) {
        HEREDOC_HEAD.lastIndex = i;
        const m = HEREDOC_HEAD.exec(text);
        if (m) {
          const body = i + m[0].length;
          if (m[2] !== undefined) {
            // Nowdoc: no interpolation, find the closing line.
            let k = body;
            let end = -1;
            for (;;) {
              end = closingAt(text, k, m[2]);
              if (end !== -1) break;
              let nl = k;
              while (nl < n && text.charCodeAt(nl) !== NL && text.charCodeAt(nl) !== CR) nl++;
              if (nl >= n) break;
              k = nl + 1;
            }
            blank(cd, body, end === -1 ? n : k);
            i = end === -1 ? n : end;
          } else {
            stack.push({ t: 'here', id: m[1] ?? m[3], body });
            i = body;
          }
          continue;
        }
        i += 3;
        continue;
      }
      if (!f.top) {
        if (c === 123 /* { */) f.depth++;
        else if (c === 125 /* } */) {
          if (f.depth === 0) {
            stack.pop();
            i++;
            continue;
          }
          f.depth--;
        }
      }
      i++;
      continue;
    }

    if (f.t === 'here' && (i === f.body || text.charCodeAt(i - 1) === NL || text.charCodeAt(i - 1) === CR)) {
      const end = closingAt(text, i, f.id);
      if (end !== -1) {
        stack.pop();
        i = end;
        continue;
      }
    }
    if (c === 92 /* \ */) {
      const next = text.charCodeAt(i + 1);
      // In a heredoc a backslash never swallows the newline (closing-line detection).
      i += f.t === 'here' && (next === NL || next === CR) ? 1 : 2;
      continue;
    }
    if (f.t === 'str' && c === f.end) {
      stack.pop();
      if (c === 96) backticks.push([f.start, i + 1]);
      i++;
      continue;
    }
    if (c === 123 && text.charCodeAt(i + 1) === 36 /* $ */) {
      stack.push({ t: 'code', top: false, depth: 0 });
      i++;
      continue;
    }
    if (c === 36 && text.charCodeAt(i + 1) === 123) {
      stack.push({ t: 'code', top: false, depth: 0 });
      i += 2;
      continue;
    }
    i++;
  }

  // An unterminated backtick literal still runs nothing (parse error) but stays visible to the rules.
  for (const fr of stack) if (fr.t === 'str' && fr.end === 96) backticks.push([fr.start, n]);
  return { noComments: nc.toString('latin1'), code: cd.toString('latin1'), backticks };
}
