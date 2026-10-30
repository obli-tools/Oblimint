import { createHash } from 'crypto';
import type { SiteErrorClass, SiteErrorLevel } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// PHP error lines of a site container (stderr) → error events (pure).
//
// Formats read (images/common/php.ini error_log = /proc/self/fd/2, php-fpm
// catch_workers_output; images/siteconf/templates/php-fpm.conf.tmpl):
//   [30-Oct-2026 10:00:00 UTC] PHP Warning:  msg in /srv/releases/12/a.php on line 3
//   [30-Oct-2026 10:00:00 UTC] PHP Fatal error:  Uncaught Exception: boom in /srv/releases/12/a.php:10
//   Stack trace:            ← continuation lines, without prefix
//   #0 /srv/releases/12/b.php(4): f('x')
//   #1 {main}
//     thrown in /srv/releases/12/a.php on line 10
//   PHP 5.6 / 7.2 (decorate_workers_output on): every line wrapped in
//   [date] WARNING: [pool site] child 12 said into stderr: "…"
//   web server relays: … FastCGI sent in stderr: "PHP message: PHP Warning: …"
//                      … AH01071: Got error 'PHP message: PHP Warning: …'
//   guard (images/common/guard.php): [date] oblimint guard: refused to execute X (real path: Y)
//   oblimint_exec: PHP Fatal error:  oblimint: refusing to execute X: PHP code only runs from the release …
// Everything else (php-fpm notices, the web server's own lines) is ignored.
//
// Fingerprint: level + normalized message (numbers, hex, hash-like names,
// release paths out; the target folder only for readOnlyWrite / execRefused)
// + file:line relative to the release. Numbers taken from the text are kept
// in PostgreSQL integer range, NUL removed. Sensitive values are masked in the
// message and the sample (arguments of the stack frames, key=value secrets,
// credentials of URLs).
// ─────────────────────────────────────────────────────────────────────────────

export interface ErrorEvent {
  /** Docker timestamp (RFC 3339 nano) of the first line; '' when absent. */
  at: string;
  level: SiteErrorLevel;
  errorClass: SiteErrorClass | null;
  /** Message without its location, release paths relative, masked. */
  message: string;
  file: string | null;
  line: number | null;
  /** Release number read from a /srv/releases/<n>/ path (null: none, or "current"). */
  releaseNumber: number | null;
  /** Stack trace lines (masked, relative), at most MAX_STACK_LINES. */
  stack: string[];
}

export const MAX_MESSAGE = 1000;
export const MAX_STACK_LINES = 60;
export const MAX_SAMPLE = 8 * 1024;
const CONTINUATION_WINDOW_MS = 2000;

const LEVELS: Record<string, SiteErrorLevel> = {
  'fatal error': 'fatal',
  'recoverable fatal error': 'fatal',
  'catchable fatal error': 'fatal',
  'core error': 'fatal',
  'compile error': 'fatal',
  'user error': 'fatal',
  'parse error': 'parse',
  warning: 'warning',
  'core warning': 'warning',
  'compile warning': 'warning',
  'user warning': 'warning',
  notice: 'notice',
  'user notice': 'notice',
  'strict standards': 'notice',
  deprecated: 'deprecated',
  'user deprecated': 'deprecated',
};

const FPM_DECORATION = /^\[[^\]]{1,40}\] (?:WARNING|NOTICE|ERROR): \[pool [^\]]{1,64}\] child \d+ said into std(?:err|out): "(.*?)"?(?: \.\.\.)?$/;
const PHP_DATE = /^\[\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2}(?: [^\]]{1,40})?\] /;
const PHP_ERROR = /^PHP ([A-Za-z ]{4,30}?):\s+(.*)$/;
const GUARD = /^oblimint guard: refused to execute (.*?)(?: \(real path: (.*)\))?$/;
const CONTINUATION = /^(?:Stack trace:|#\d+ |\s+thrown in |Next [\w\\]+(?::|$)|\s{2,}\S)/;
const LOC_ON_LINE = /^(.*) in (\/\S+) on line (\d+)\.?$/s;
const LOC_COLON = /^(.*) in (\/\S+?):(\d+)$/s;
const RELEASE_PATH = /\/srv\/releases\/(\d+|current)\//g;

/** "2026-10-30T10:00:00.1Z" → "2026-10-30T10:00:00.100000000Z" (sortable as text); '' stays ''. */
export function tsKey(at: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(at);
  if (!m) return '';
  if (m[3] !== 'Z') {
    const t = Date.parse(at);
    if (Number.isNaN(t)) return '';
    const base = new Date(Math.floor(t / 1000) * 1000).toISOString().slice(0, 19);
    return `${base}.${(m[2] ?? '').padEnd(9, '0')}Z`;
  }
  return `${m[1]}.${(m[2] ?? '').padEnd(9, '0')}Z`;
}

/**
 * Masks values that must never leave the container log (passwords, tokens,
 * credentials of URLs). A key only takes a value through an explicit "=" or
 * ":" (never "::" / "=="): "unexpected token \"}\"" or "Auth expects array"
 * stay readable — the token PHP points at is the clue of a parse error. A
 * bare whitespace separator is masked only after "Bearer" / "Basic" followed
 * by something shaped like a credential.
 */
export function maskSensitive(s: string): string {
  return s
    .replace(/(\/\/)[^/\s:@'"]+:[^/\s@'"]+@/g, '$1***:***@')
    .replace(
      /\b([\w.-]*?(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|auth(?:orization)?))(\s*(?:=(?!=)|:(?!:))\s*)((?:bearer|basic)\s+)?("[^"]*"|'[^']*'|[^\s,;&'")\]:][^\s,;&'")\]]*)/gi,
      (_m, k: string, sep: string, scheme: string | undefined) => `${k}${sep}${scheme ?? ''}***`,
    )
    .replace(/\b(bearer|basic)(\s+)([A-Za-z0-9._~+/-]{16,}=*)/gi, (_m, k: string, sep: string) => `${k}${sep}***`);
}

/** A stack frame "#0 file(12): fn('a', 'b')" → "#0 file(12): fn(…)": arguments never kept. */
export function maskFrame(line: string): string {
  const m = /^(#\d+ .*?: [^(]*)\((.*)\)\s*$/.exec(line);
  if (m && m[2].trim() !== '') return `${m[1]}(…)`;
  return line;
}

/** /srv/releases/<n>/x → x (paths of the live code made relative). */
export function relativize(s: string): string {
  return s.replace(RELEASE_PATH, '');
}

/** Largest value of a PostgreSQL integer column (release_number, line). */
export const PG_INT_MAX = 2_147_483_647;

/** A number read from log text → integer in 1..PG_INT_MAX, otherwise null (never fails the INSERT). */
export function pgPositiveInt(v: string | number): number | null {
  const n = typeof v === 'number' ? v : (/^\d{1,10}$/.test(v) ? Number(v) : Number.NaN);
  return Number.isSafeInteger(n) && n >= 1 && n <= PG_INT_MAX ? n : null;
}

function releaseNumberIn(s: string): number | null {
  RELEASE_PATH.lastIndex = 0;
  for (let m = RELEASE_PATH.exec(s); m; m = RELEASE_PATH.exec(s)) {
    if (m[1] === 'current') continue;
    const n = pgPositiveInt(m[1]);
    if (n !== null) return n;
  }
  return null;
}

/** NUL is refused by PostgreSQL text columns: removed from everything read in a log. */
export function stripNul(s: string): string {
  return s.includes('\u0000') ? s.replace(/\u0000/g, '') : s;
}

/**
 * Message normalized for the fingerprint: release paths, hash-like tokens
 * (cache file names, /tmp/phpXXXX, session ids: 8+ letters and digits
 * mixed), hex and numbers out, spaces folded.
 */
export function normalizeMessage(message: string): string {
  return relativize(message)
    .replace(/0x[0-9a-f]+/gi, '0xN')
    .replace(/(?<![A-Za-z0-9])(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{8,}(?![A-Za-z0-9])/g, 'H')
    .replace(/\b\d+(?:\.\d+)?\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** A path → its folder, at most 3 levels deep ("var/cache/prod/twig/ab/x.php" → "var/cache/prod/…"). */
function folderKey(path: string): string {
  const abs = path.startsWith('/');
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return `${abs ? '/' : ''}${parts.slice(0, 3).join('/')}/…`;
}

/**
 * Message used for the fingerprint. For the immutable-model classes the
 * target path is reduced to its folder: one root cause (a cache folder that
 * is not a data path, a script dropped in uploads) is ONE group, not one per
 * generated file — the hint says to declare the folder anyway.
 */
function fingerprintMessage(e: Pick<ErrorEvent, 'message'> & { errorClass?: SiteErrorClass | null }): string {
  const cls = e.errorClass ?? classify(e.message);
  if (cls !== 'readOnlyWrite' && cls !== 'execRefused') return e.message;
  return e.message.replace(/(?:\/|\b)[\w.@~+-]+(?:\/[\w.@~+-]+)+\/?/g, (p) => folderKey(p));
}

export function fingerprintOf(e: Pick<ErrorEvent, 'level' | 'message' | 'file' | 'line'> & { errorClass?: SiteErrorClass | null }): string {
  return createHash('sha1').update(`${e.level}\n${normalizeMessage(fingerprintMessage(e))}\n${e.file ?? ''}\n${e.line ?? ''}`).digest('hex');
}

export function classify(message: string): SiteErrorClass | null {
  if (/read-only file system/i.test(message)) return 'readOnlyWrite';
  if (/^oblimint(?: guard)?: refus/i.test(message)) return 'execRefused';
  return null;
}

/** Removes the wrappers around a PHP line (php-fpm decoration, web server relay, PHP date): the payloads it carries. */
export function unwrap(text: string): string[] {
  let s = text;
  const deco = FPM_DECORATION.exec(s);
  if (deco) s = deco[1];
  if (s.includes('PHP message: ')) {
    return s.split('PHP message: ').slice(1).map((p) => p
      .replace(/\\n$/, '')
      .replace(/"?(?:, client: .*| while (?:reading|sending) .*)$/, '')
      .replace(/['"]?(?:, referer: .*)?$/, '')
      .replace(/\\n$/, '')
      .trim());
  }
  return [s.replace(PHP_DATE, '')];
}

function cut(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** First line of an error → event (null when the line is not a PHP error). */
export function parseHead(text: string, at: string): ErrorEvent | null {
  const payload = stripNul(text);
  const g = GUARD.exec(payload);
  if (g) {
    const message = maskSensitive(`oblimint guard: refused to execute ${relativize(g[1])}${g[2] ? ` (real path: ${relativize(g[2])})` : ''}`);
    return { at, level: 'fatal', errorClass: 'execRefused', message: cut(message, MAX_MESSAGE), file: null, line: null, releaseNumber: releaseNumberIn(payload), stack: [] };
  }
  const m = PHP_ERROR.exec(payload);
  if (!m) return null;
  const level = LEVELS[m[1].trim().toLowerCase()];
  if (!level) return null;
  let body = m[2].trim();
  let file: string | null = null;
  let line: number | null = null;
  const loc = LOC_ON_LINE.exec(body) ?? LOC_COLON.exec(body);
  if (loc) {
    body = loc[1];
    file = loc[2];
    // Line 0 exists (internal code); beyond an integer column: unknown.
    line = loc[3] === '0' ? 0 : pgPositiveInt(loc[3]);
  }
  const releaseNumber = releaseNumberIn(file ?? '') ?? releaseNumberIn(body);
  const message = cut(maskSensitive(relativize(body)), MAX_MESSAGE);
  return {
    at, level, errorClass: classify(message), message,
    file: file ? cut(relativize(file), 500) : null, line,
    releaseNumber, stack: [],
  };
}

/**
 * Lines of ONE container, in order → events. A continuation line (stack
 * trace, "thrown in", "Next …") joins the event just before it when it
 * comes within 2 s.
 */
export function parseLines(lines: Array<{ at: string; text: string }>): ErrorEvent[] {
  const out: ErrorEvent[] = [];
  let open: ErrorEvent | null = null;
  let openMs = 0;
  for (const raw of lines) {
    for (const payload of unwrap(stripNul(raw.text))) {
      if (!payload) continue;
      const head = parseHead(payload, raw.at);
      if (head) {
        out.push(head);
        open = head;
        openMs = Date.parse(raw.at) || 0;
        continue;
      }
      const ms = Date.parse(raw.at) || 0;
      if (open && CONTINUATION.test(payload) && Math.abs(ms - openMs) <= CONTINUATION_WINDOW_MS) {
        if (open.releaseNumber === null) open.releaseNumber = releaseNumberIn(payload);
        if (open.stack.length < MAX_STACK_LINES) open.stack.push(cut(maskSensitive(relativize(maskFrame(payload))), 500));
        continue;
      }
      open = null;
    }
  }
  return out;
}

/** Sample stored for a group: message, location, stack (cut at MAX_SAMPLE). */
export function sampleOf(e: ErrorEvent): string {
  const head = `${e.message}${e.file ? ` in ${e.file}${e.line !== null ? ` on line ${e.line}` : ''}` : ''}`;
  return cut([head, ...e.stack].join('\n'), MAX_SAMPLE);
}

/** What to do, for the errors the immutable model explains (English, for agents and the API). */
export function hintOf(cls: SiteErrorClass | null): string | null {
  if (cls === 'readOnlyWrite') {
    return 'The live code is read-only: the site tried to write into its release. Declare the folder it writes to as a data path (add_data_path, or Site > Data paths in the panel) and publish again; never write cache or upload files next to the code.';
  }
  if (cls === 'execRefused') {
    return 'PHP only runs code from the release: a script under a data path or /tmp is refused (guard / oblimint_exec). Move the PHP file into the code (staging) and publish; never generate PHP at runtime.';
  }
  return null;
}
