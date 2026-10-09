import type { AppProfileId, ChangeKind, ChangedFileFinding } from '@oblimint/shared';
import type { AnalysisDataPath } from '../maintenance/contracts';
import { lexPhp, needsShortTagVariant, type PhpViews } from './phpLexer';

// ─────────────────────────────────────────────────────────────────────────────
// Panel heuristics of the change scanner (docs/P3-PLAN.md §9.2) — PURE module
// (no I/O, table-tested in heuristics.test.ts). Always active, with or without
// the scanner container. Every rule of the plan's table lives in
// HEURISTIC_RULES (id, points, severity, English message: the client may
// translate `scanner.rules.<id>`); findings never carry file content (A6).
//
// The content checks run on the first HEURISTIC_MAX_BYTES of a file, decoded as
// latin1 (one char per byte: binary-safe, indexes = byte offsets). Every
// regular expression is bounded (no nested unbounded quantifier) so a hostile
// 4 MiB file cannot make the panel backtrack for minutes.
//
// The code rules never match comments (phpLexer.ts): a docblock quoting
// `$_GET` in Markdown backticks is not a shell execution, a comment naming
// "$var (the key)" is not a call. Rules about data flow (request input reaching
// exec / include / a call / assert) also ignore single-quoted strings and
// nowdocs, which do not interpolate.
// ─────────────────────────────────────────────────────────────────────────────

/** Heuristics look at the first 4 MiB of a file (the engines get up to scanner.maxFileSizeMb). */
export const HEURISTIC_MAX_BYTES = 4 * 1024 * 1024;

export type HeuristicRuleId =
  | 'exec.new-outside-expected'
  | 'exec.in-media-dir'
  | 'exec.htaccess-handler'
  | 'php.eval-decode'
  | 'php.preg-e'
  | 'php.request-exec'
  | 'php.include-request'
  | 'php.dynamic-call'
  | 'php.assert-var'
  | 'php.create-function'
  | 'php.long-base64'
  | 'php.hex-chains'
  | 'php.one-liner'
  | 'php.nul-byte'
  | 'content.php-in-media'
  | 'file.double-ext'
  | 'file.hidden-php'
  | 'file.elf'
  | 'datapath.code'
  | 'perm.world-writable'
  | 'perm.exec-bit'
  | 'scan.skipped'
  | 'scan.exec-uninspected';

export interface HeuristicRule {
  id: HeuristicRuleId;
  points: number;
  severity: ChangedFileFinding['severity'];
  message: string;
}

const rule = (id: HeuristicRuleId, points: number, severity: HeuristicRule['severity'], message: string): HeuristicRule => ({ id, points, severity, message });

/** The rule table of docs/P3-PLAN.md §9.2 (points / severity are part of the contract). */
export const HEURISTIC_RULES: Readonly<Record<HeuristicRuleId, HeuristicRule>> = {
  'exec.new-outside-expected': rule('exec.new-outside-expected', 25, 'warn', 'New executable file outside the expected code directories'),
  'exec.in-media-dir': rule('exec.in-media-dir', 60, 'warn', 'PHP file in an upload / media / cache directory'),
  'exec.htaccess-handler': rule('exec.htaccess-handler', 50, 'warn', '.htaccess / .user.ini changes how files are executed (handler, auto_prepend_file, php_value)'),
  'php.eval-decode': rule('php.eval-decode', 70, 'critical', 'eval() of decoded data (base64_decode, gzinflate, str_rot13…)'),
  'php.preg-e': rule('php.preg-e', 70, 'critical', 'preg_replace() with the /e (code execution) modifier'),
  'php.request-exec': rule('php.request-exec', 70, 'critical', 'Shell command built from request input (system, exec, passthru, shell_exec…)'),
  'php.include-request': rule('php.include-request', 70, 'critical', 'include / require of a path taken from the request'),
  'php.dynamic-call': rule('php.dynamic-call', 60, 'warn', 'Function name taken from the request (dynamic call, call_user_func, array_map)'),
  'php.assert-var': rule('php.assert-var', 50, 'warn', 'assert() on a variable (code execution)'),
  'php.create-function': rule('php.create-function', 30, 'warn', 'create_function() (deprecated runtime code creation)'),
  'php.long-base64': rule('php.long-base64', 30, 'warn', 'Long base64 blob in a PHP file'),
  'php.hex-chains': rule('php.hex-chains', 30, 'warn', 'Long chains of escaped bytes or chr() concatenations (obfuscation)'),
  'php.one-liner': rule('php.one-liner', 30, 'warn', 'PHP line longer than 5,000 characters (packed / obfuscated code)'),
  'php.nul-byte': rule('php.nul-byte', 40, 'warn', 'NUL byte in a PHP source file (hides its content from text scanners)'),
  'content.php-in-media': rule('content.php-in-media', 80, 'critical', 'PHP code inside an image / media / text file'),
  'file.double-ext': rule('file.double-ext', 40, 'warn', 'Double extension mixing PHP and another type (x.php.jpg, x.jpg.php)'),
  'file.hidden-php': rule('file.hidden-php', 40, 'warn', 'Hidden PHP file (name starting with a dot)'),
  'file.elf': rule('file.elf', 60, 'warn', 'Linux executable (ELF) in the code'),
  'datapath.code': rule('datapath.code', 80, 'critical', 'Non-conforming file in a typed data path (code or a forbidden type)'),
  'perm.world-writable': rule('perm.world-writable', 5, 'info', 'World-writable file'),
  'perm.exec-bit': rule('perm.exec-bit', 5, 'info', 'Executable permission bit on a non-script file'),
  'scan.skipped': rule('scan.skipped', 0, 'info', 'Not sent to the scan engines (too large or unreadable)'),
  // Scored at least scanner.reviewScore (uninspectedExecFinding): never auto-validated, never published without a human.
  'scan.exec-uninspected': rule('scan.exec-uninspected', 30, 'warn', 'Executable file not fully inspected (larger than the inspected size, or unreadable): human review required'),
};

export const HEURISTIC_RULE_COUNT = Object.keys(HEURISTIC_RULES).length;

/** 30 points from 2 KiB of base64, 50 from 20 KiB. */
export const LONG_BASE64_MIN = 2048;
export const LONG_BASE64_HIGH = 20 * 1024;
export const LONG_BASE64_HIGH_POINTS = 50;
export const ONE_LINER_MAX = 5000;

// ── classification ───────────────────────────────────────────────────────────

/** Extensions PHP-FPM / Apache would run or that are PHP code (+ include files). */
const PHP_CODE_EXT = new Set(['php', 'php3', 'php4', 'php5', 'php6', 'php7', 'php8', 'phtml', 'pht', 'phps', 'phar']);
const EXECUTABLE_EXT = new Set([...PHP_CODE_EXT, 'inc']);
const EXECUTABLE_BASENAMES = new Set(['.htaccess', '.user.ini']);

/**
 * Directory names where a PHP file has no business (exec.in-media-dir).
 * Upload / media names count anywhere but in third-party dependency trees;
 * the generic names (cache, tmp, files) are legitimate code directories inside
 * libraries and applications (vendor/symfony/cache, bootstrap/cache, Nextcloud
 * apps/files): they only count when no code-container directory precedes them.
 */
const MEDIA_DIRS = new Set(['uploads', 'images', 'img', 'media']);
const GENERIC_DATA_DIRS = new Set(['cache', 'tmp', 'files']);
const DEPENDENCY_DIRS = new Set(['vendor', 'node_modules', 'bower_components']);
/** Bundled library trees (WordPress core ships SimplePie, getID3, sodium_compat… under wp-includes). */
const LIBRARY_DIRS = new Set([...DEPENDENCY_DIRS, 'wp-includes', 'wp-admin', 'lib', 'libs', 'library', 'libraries', 'getid3']);
const CODE_CONTAINER_DIRS = new Set([
  ...LIBRARY_DIRS, 'plugins', 'themes', 'mu-plugins', 'apps', 'modules', 'core', 'src', 'app', 'bootstrap', 'includes',
]);

/** Below a bundled library tree (LIBRARY_DIRS). */
function inLibraryDir(rel: string): boolean {
  return dirName(rel).split('/').some((x) => LIBRARY_DIRS.has(x.toLowerCase()));
}

/** exec.in-media-dir: a PHP file below an upload / media directory (see MEDIA_DIRS). */
export function inMediaDir(rel: string): boolean {
  const segs = dirName(rel).split('/').map((x) => x.toLowerCase());
  for (let i = 0; i < segs.length; i++) {
    const before = segs.slice(0, i);
    if (MEDIA_DIRS.has(segs[i]) && !before.some((x) => DEPENDENCY_DIRS.has(x))) return true;
    if (GENERIC_DATA_DIRS.has(segs[i]) && !before.some((x) => CODE_CONTAINER_DIRS.has(x))) return true;
  }
  return false;
}

/** Image / media / text types that must never contain PHP (content.php-in-media). */
const MEDIA_EXT = new Set([
  'jpg', 'jpeg', 'jpe', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff', 'svg', 'heic',
  'mp3', 'mp4', 'm4a', 'm4v', 'ogg', 'oga', 'ogv', 'wav', 'webm', 'mov', 'avi', 'flac',
  'pdf', 'txt', 'csv', 'log',
]);
const TEXT_MEDIA_EXT = new Set(['txt', 'csv', 'log']);
/** Documentation files legitimately quote PHP snippets (WordPress readme.txt…). */
const DOC_BASENAME = /^(?:readme|changelog|changes|license|licence|copying|install|upgrade|upgrading|faq|history|authors|credits|contributing)(?:[._-][^/]*)?$/i;

/** Suffixes after '.php' that never execute (templates, samples, backups). */
const SAFE_SECOND_EXT = new Set(['dist', 'sample', 'example', 'template', 'tpl', 'twig', 'stub', 'md', 'txt', 'orig', 'rej', 'bak', 'blade']);
/** Developer dot-files that are PHP on purpose. */
const KNOWN_DOT_PHP = /^\.(?:php[-_]cs(?:[-_]fixer)?(?:\.dist)?|phpstorm\.meta|php-version|phan)(?:\.dist)?\.php$/i;

function baseName(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? rel : rel.slice(i + 1);
}

function dirName(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

/** Lower-case extension without the dot ('' when none; '.htaccess' has none). */
export function extensionOf(rel: string): string {
  const b = baseName(rel);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
}

/** The web server would execute it (or PHP would include it): .php .php3-8 .phtml .pht .phps .phar .inc .htaccess .user.ini. */
export function isExecutablePath(rel: string): boolean {
  const b = baseName(rel).toLowerCase();
  if (EXECUTABLE_BASENAMES.has(b)) return true;
  return EXECUTABLE_EXT.has(extensionOf(rel));
}

/** PHP source by its name (.php*, .phtml, .phar, .inc). */
export function isPhpPath(rel: string): boolean {
  return EXECUTABLE_EXT.has(extensionOf(rel));
}

/** git's heuristic: a NUL byte in the first 8000 bytes. */
export function isBinary(data: Buffer): boolean {
  return data.subarray(0, 8000).includes(0);
}

export function isElf(data: Buffer): boolean {
  return data.length >= 4 && data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46;
}

/** Path is the data path itself or below it. */
export function dataPathOf(rel: string, dataPaths: AnalysisDataPath[]): AnalysisDataPath | null {
  let best: AnalysisDataPath | null = null;
  for (const dp of dataPaths) {
    const p = dp.path.replace(/^\/+|\/+$/g, '');
    if (!p) continue;
    if ((rel === p || rel.startsWith(`${p}/`)) && (!best || p.length > best.path.length)) best = dp;
  }
  return best;
}

// ── expected code directories (exec.new-outside-expected) ────────────────────

const WP_CODE_PREFIX = /(?:^|\/)(?:wp-content\/(?:plugins|themes|mu-plugins|languages)\/|wp-admin\/|wp-includes\/)/;
const WP_ROOT_FILE = /^(?:[^/]+\/)?(?:wp-[^/]*|index|xmlrpc)\.php$/;

/** WordPress: plugins / themes / mu-plugins / languages, wp-admin, wp-includes, root wp-*.php (also in a one-level sub-directory install). */
export function isWordPressCodePath(rel: string): boolean {
  return WP_CODE_PREFIX.test(rel) || WP_ROOT_FILE.test(rel);
}

/**
 * Generic applications: the directory (or one of its ancestors, the root
 * excepted — every application has an index.php there) already held an
 * executable file in the base release.
 */
export function inExpectedDir(rel: string, codeDirs: ReadonlySet<string>): boolean {
  let dir = dirName(rel);
  while (dir) {
    if (codeDirs.has(dir)) return true;
    dir = dirName(dir);
  }
  return false;
}

// ── content checks ───────────────────────────────────────────────────────────

const REQ = String.raw`\$_(?:GET|POST|REQUEST|COOKIE)\b`;
const REQ_SRV = String.raw`\$_(?:GET|POST|REQUEST|COOKIE|SERVER)\b`;
/** Not a method / static call / variable function name part. */
const NOT_MEMBER = String.raw`(?<![\w>$:\\])`;

const RE_EVAL_DECODE = /(?<![\w>$:\\])eval\s*\(\s*[^;\n]{0,200}?\b(?:base64_decode|gzinflate|gzuncompress|gzdecode|str_rot13|strrev|hex2bin|convert_uudecode|rawurldecode)\s*\(/i;
const RE_REQUEST_EXEC = new RegExp(String.raw`${NOT_MEMBER}(?:system|exec|passthru|shell_exec|proc_open|popen|pcntl_exec)\s*\(\s*[^;\n]{0,200}?${REQ_SRV}`, 'i');
const RE_REQ_SRV = new RegExp(REQ_SRV, 'i');
const RE_INCLUDE_REQUEST = new RegExp(String.raw`(?<![\w>$:\\])(?:include|require)(?:_once)?\b\s*\(?\s*[^;\n]{0,120}?${REQ}`, 'i');
const RE_DIRECT_REQUEST_CALL = new RegExp(String.raw`${REQ}\s*\[[^\]\n]{1,64}\]\s*\(`, 'i');
const RE_CALLBACK_FROM_REQUEST = new RegExp(String.raw`${NOT_MEMBER}(?:call_user_func(?:_array)?|array_map|register_shutdown_function|register_tick_function|forward_static_call(?:_array)?)\s*\(\s*(?:@\s*)?${REQ}`, 'i');
const RE_ASSIGN_FROM_REQUEST = new RegExp(String.raw`\$([A-Za-z_][A-Za-z0-9_]{0,63})\s*=\s*(?:@\s*)?(?:trim\s*\(\s*)?${REQ}`, 'gi');
/**
 * assert() only evaluates a STRING argument (PHP 7 with zend.assertions on;
 * never on PHP 8): a lone variable (possibly indexed) as the first argument,
 * request input anywhere in it, or a decoder call. An expression such as
 * assert($this->body !== null) or assert(is_array($x)) is a plain check.
 */
const RE_ASSERT_VAR = new RegExp(
  String.raw`${NOT_MEMBER}assert\s*\(\s*@?\s*(?:\$[A-Za-z_][A-Za-z0-9_]{0,63}(?:\s*\[[^\]\n]{0,64}\]){0,4}\s*[,)]|(?:base64_decode|gzinflate|gzuncompress|gzdecode|str_rot13|strrev|hex2bin|rawurldecode)\s*\(|[^;\n]{0,200}?${REQ})`,
  'i',
);
const RE_CREATE_FUNCTION = /(?<![\w>$:\\])create_function\s*\(/i;
const RE_PREG_REPLACE = /(?<![\w>$:\\])preg_replace\s*\(\s*(['"])([^'"\n]{1,500})\1/gi;
const RE_HEX_CHAIN = /(?:\\x[0-9a-fA-F]{2}){20,}|(?:\\[0-7]{3}){20,}/g;
/** Share of printable ASCII from which an escaped chain is hidden TEXT (code, function names), not binary data. */
const HEX_TEXT_RATIO = 0.75;
const RE_CHR_CHAIN = /(?:\bchr\s*\(\s*\d{1,3}\s*\)\s*\.\s*){8,}/i;
const RE_PHP_OPEN = /<\?php/i;
const RE_PHP_OPEN_ANY = /<\?(?:php|=)/i;
const RE_HTACCESS_HANDLER = /^[ \t]*(?:php_(?:admin_)?(?:value|flag)\b|auto_(?:prepend|append)_file\s*=|AddHandler\b|SetHandler\b|AddType\s+application\/x-httpd-php|ForceType\b)/im;

/** 1-based line of a character offset. */
export function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/** preg_replace pattern with the /e modifier (any delimiter, bracket pairs included). */
function findPregE(text: string): number {
  RE_PREG_REPLACE.lastIndex = 0;
  for (let m = RE_PREG_REPLACE.exec(text); m; m = RE_PREG_REPLACE.exec(text)) {
    const pattern = m[2];
    const open = pattern[0];
    if (/[\w\s\\]/.test(open)) continue;
    const close = ({ '(': ')', '{': '}', '[': ']', '<': '>' } as Record<string, string>)[open] ?? open;
    const end = pattern.lastIndexOf(close);
    if (end <= 0) continue;
    const mods = pattern.slice(end + 1);
    if (/^[a-zA-Z\s]*$/.test(mods) && mods.includes('e')) return m.index;
  }
  return -1;
}

/** Longest run of base64 characters that looks like data (mixed case + digits). Returns [index, length]. */
export function longestBase64Run(text: string): [number, number] {
  let best: [number, number] = [-1, 0];
  let start = -1;
  let upper = false;
  let lower = false;
  let digit = false;
  const close = (end: number) => {
    const len = end - start;
    if (start >= 0 && len > best[1] && upper && lower && digit) best = [start, len];
    start = -1;
    upper = lower = digit = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const isUpper = c >= 65 && c <= 90;
    const isLower = c >= 97 && c <= 122;
    const isDigit = c >= 48 && c <= 57;
    if (isUpper || isLower || isDigit || c === 43 || c === 47) {
      if (start < 0) start = i;
      upper ||= isUpper;
      lower ||= isLower;
      digit ||= isDigit;
    } else if (start >= 0) {
      close(i);
    }
  }
  if (start >= 0) close(text.length);
  return best;
}

/** A line of packed code needs this much code (outside literals) besides its raw length. */
export const ONE_LINER_MIN_CODE = 1000;

/**
 * Index of the first line longer than `max` characters that is CODE, or -1.
 * Long lines of data (an array of string literals such as WordPress' emoji
 * table, a DTD in a string) are not packed code: on the code view, the line
 * must still hold ONE_LINER_MIN_CODE characters that are not whitespace,
 * quotes, commas or the content of a single-quoted literal.
 */
function longLineIndex(text: string, code: string, max: number): number {
  let lineStart = 0;
  for (;;) {
    const nl = text.indexOf('\n', lineStart);
    const end = nl === -1 ? text.length : nl;
    if (end - lineStart > max) {
      let codeChars = 0;
      for (let k = lineStart; k < end && codeChars < ONE_LINER_MIN_CODE; k++) {
        const c = code.charCodeAt(k);
        if (c !== 32 && c !== 9 && c !== 13 && c !== 39 && c !== 34 && c !== 44) codeChars++;
      }
      if (codeChars >= ONE_LINER_MIN_CODE) return lineStart;
    }
    if (nl === -1) return -1;
    lineStart = nl + 1;
  }
}

/** Decoded bytes of an escaped chain (\xHH or \OOO runs). */
function decodeEscapes(chain: string): number[] {
  const out: number[] = [];
  for (const m of chain.matchAll(/\\(?:x([0-9a-fA-F]{2})|([0-7]{3}))/g)) out.push(m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2], 8) & 0xff);
  return out;
}

/**
 * First chain of escaped bytes that decodes to TEXT (obfuscated names / code:
 * "\x65\x76\x61\x6c…"), or -1. Binary constants (crypto tables, byte-order
 * marks: sodium_compat, SimplePie) decode to mostly non-printable bytes.
 */
function findTextHexChain(text: string): number {
  RE_HEX_CHAIN.lastIndex = 0;
  for (let m = RE_HEX_CHAIN.exec(text); m; m = RE_HEX_CHAIN.exec(text)) {
    const bytes = decodeEscapes(m[0]);
    const printable = bytes.filter((b) => (b >= 0x20 && b <= 0x7e) || b === 9 || b === 10 || b === 13).length;
    if (bytes.length > 0 && printable / bytes.length >= HEX_TEXT_RATIO) return m.index;
  }
  return -1;
}

/** Index of a request-fed variable function call ($f = $_GET['f']; … $f(…)), or -1. */
function findRequestVariableCall(text: string): number {
  RE_ASSIGN_FROM_REQUEST.lastIndex = 0;
  const names = new Set<string>();
  for (let m = RE_ASSIGN_FROM_REQUEST.exec(text); m && names.size < 20; m = RE_ASSIGN_FROM_REQUEST.exec(text)) {
    if (m[1] !== 'this') names.add(m[1]);
  }
  for (const name of names) {
    const call = new RegExp(String.raw`(?<![\w>:$\\])\$${name}\s*\(`);
    const hit = call.exec(text);
    if (hit) return hit.index;
  }
  return -1;
}

// ── evaluation ───────────────────────────────────────────────────────────────

export interface HeuristicFileInput {
  path: string;
  change: ChangeKind;
  /** First bytes of the new content (≤ HEURISTIC_MAX_BYTES), null when not read (symlink, unreadable). */
  data: Buffer | null;
  /** Permission bits when known (null: unknown, e.g. a Windows dev box). */
  mode: number | null;
}

export interface HeuristicContext {
  appProfile: AppProfileId | null;
  dataPaths: AnalysisDataPath[];
  /**
   * Generic applications: directories that held an executable file in the base
   * release. null = no base to compare with (first publication): the
   * exec.new-outside-expected rule is not evaluated.
   */
  codeDirs: ReadonlySet<string> | null;
}

function finding(id: HeuristicRuleId, line: number | null = null, override?: Partial<Pick<HeuristicRule, 'points' | 'message'>>): ChangedFileFinding {
  const r = HEURISTIC_RULES[id];
  return {
    engine: 'heuristic',
    rule: id,
    severity: r.severity,
    message: override?.message ?? r.message,
    line,
    score: override?.points ?? r.points,
  };
}

/** Name-only checks (no content needed). */
function nameFindings(input: HeuristicFileInput, ctx: HeuristicContext, out: ChangedFileFinding[]): void {
  const rel = input.path;
  const base = baseName(rel);
  const ext = extensionOf(rel);
  const executable = isExecutablePath(rel);
  const phpCode = PHP_CODE_EXT.has(ext);

  if (executable && input.change === 'added' && !dataPathOf(rel, ctx.dataPaths)) {
    const expected = ctx.appProfile === 'wordpress'
      ? isWordPressCodePath(rel)
      : ctx.codeDirs === null ? true : inExpectedDir(rel, ctx.codeDirs);
    if (!expected) out.push(finding('exec.new-outside-expected'));
  }
  if (phpCode && inMediaDir(rel)) {
    out.push(finding('exec.in-media-dir'));
  }

  const parts = base.toLowerCase().split('.');
  if (parts.length >= 3) {
    const last = parts[parts.length - 1];
    const prev = parts[parts.length - 2];
    const phpThenOther = PHP_CODE_EXT.has(prev) && !PHP_CODE_EXT.has(last) && !SAFE_SECOND_EXT.has(last) && last !== 'inc';
    // x.jpg.php (a script dressed as an image) — except module files of bundled
    // libraries outside media directories (getID3: wp-includes/ID3/module.audio.mp3.php).
    const mediaThenPhp = MEDIA_EXT.has(prev) && PHP_CODE_EXT.has(last) && !(inLibraryDir(rel) && !inMediaDir(rel));
    if (phpThenOther || mediaThenPhp) out.push(finding('file.double-ext'));
  }
  if (phpCode && base.startsWith('.') && !KNOWN_DOT_PHP.test(base)) out.push(finding('file.hidden-php'));
}

/** Lexed views of a PHP text: one per short_open_tag setting that changes its meaning. */
export function phpViewsOf(text: string): PhpViews[] {
  return needsShortTagVariant(text) ? [lexPhp(text, false), lexPhp(text, true)] : [lexPhp(text, false)];
}

/** Request input inside a backtick (shell execution) literal: index of the literal, or -1. */
function findBacktickRequest(v: PhpViews): number {
  for (const [start, end] of v.backticks) {
    if (RE_REQ_SRV.test(v.noComments.slice(start, end))) return start;
  }
  return -1;
}

/** Content checks of PHP code (by name, or any text file opening a PHP tag). */
function phpFindings(text: string, out: ChangedFileFinding[]): void {
  const push = (id: HeuristicRuleId, index: number, override?: Partial<Pick<HeuristicRule, 'points' | 'message'>>) => {
    out.push(finding(id, index >= 0 ? lineAt(text, index) : null, override));
  };
  const first = (re: RegExp, on: string = text): number => {
    re.lastIndex = 0;
    const m = re.exec(on);
    return m ? m.index : -1;
  };
  // Each view is a possible reading of the file by PHP: a rule fires when it matches in any.
  const views = phpViewsOf(text);
  const any = (check: (v: PhpViews) => number): number => {
    let best = -1;
    for (const v of views) {
      const i = check(v);
      if (i >= 0 && (best < 0 || i < best)) best = i;
    }
    return best;
  };

  let i = any((v) => first(RE_EVAL_DECODE, v.noComments));
  if (i >= 0) push('php.eval-decode', i);
  i = any((v) => findPregE(v.noComments));
  if (i >= 0) push('php.preg-e', i);
  i = any((v) => {
    const j = first(RE_REQUEST_EXEC, v.code);
    return j >= 0 ? j : findBacktickRequest(v);
  });
  if (i >= 0) push('php.request-exec', i);
  i = any((v) => first(RE_INCLUDE_REQUEST, v.code));
  if (i >= 0) push('php.include-request', i);
  i = any((v) => {
    let j = first(RE_DIRECT_REQUEST_CALL, v.code);
    if (j < 0) j = first(RE_CALLBACK_FROM_REQUEST, v.code);
    if (j < 0) j = findRequestVariableCall(v.code);
    return j;
  });
  if (i >= 0) push('php.dynamic-call', i);
  i = any((v) => first(RE_ASSERT_VAR, v.code));
  if (i >= 0) push('php.assert-var', i);
  i = any((v) => first(RE_CREATE_FUNCTION, v.noComments));
  if (i >= 0) push('php.create-function', i);
  const [b64At, b64Len] = longestBase64Run(text);
  if (b64Len >= LONG_BASE64_HIGH) push('php.long-base64', b64At, { points: LONG_BASE64_HIGH_POINTS, message: 'Very long base64 blob (≥ 20 KiB) in a PHP file' });
  else if (b64Len >= LONG_BASE64_MIN) push('php.long-base64', b64At);
  i = findTextHexChain(text);
  if (i < 0) i = first(RE_CHR_CHAIN);
  if (i >= 0) push('php.hex-chains', i);
  i = any((v) => longLineIndex(text, v.code, ONE_LINER_MAX));
  if (i >= 0) push('php.one-liner', i);
}

/** Every heuristic finding of one changed file (deletions / directories: none). */
export function runHeuristics(input: HeuristicFileInput, ctx: HeuristicContext): ChangedFileFinding[] {
  const out: ChangedFileFinding[] = [];
  if (input.change === 'deleted') return out;
  const rel = input.path;
  const base = baseName(rel);
  const lowerBase = base.toLowerCase();
  const ext = extensionOf(rel);
  const dp = dataPathOf(rel, ctx.dataPaths);
  const data = input.data;
  const binary = data ? isBinary(data) : false;
  const text = data ? data.toString('latin1') : '';

  // A typed data path only accepts its declared types, never code (ARCHITECTURE §2.1).
  if (dp && dp.policy === 'typed') {
    const allowed = dp.allowedExtensions?.map((e) => e.toLowerCase().replace(/^\./, '')) ?? null;
    const badType = allowed !== null && !allowed.includes(ext);
    const code = isExecutablePath(rel) || (data !== null && (isElf(data) || (binary ? RE_PHP_OPEN.test(text) : RE_PHP_OPEN_ANY.test(text))));
    if (badType || code) out.push(finding('datapath.code'));
  }

  nameFindings(input, ctx, out);

  if (data) {
    if (EXECUTABLE_BASENAMES.has(lowerBase)) {
      const m = RE_HTACCESS_HANDLER.exec(text);
      if (m) out.push(finding('exec.htaccess-handler', lineAt(text, m.index)));
    }
    if (isElf(data) && !dp) out.push(finding('file.elf', null));
    if (MEDIA_EXT.has(ext) && !(TEXT_MEDIA_EXT.has(ext) && DOC_BASENAME.test(base))) {
      // In binary data a random '<?=' is likely (3 bytes): only '<?php' counts there.
      const m = (binary ? RE_PHP_OPEN : RE_PHP_OPEN_ANY).exec(text);
      if (m) out.push(finding('content.php-in-media', lineAt(text, m.index)));
    }
    // A PHP-named file is analysed whatever its bytes: PHP runs a file with a NUL
    // inside a comment or a string, so a NUL must never switch the checks off.
    // Phar archives are binary by design (their stub is still checked when text).
    const phpByName = isPhpPath(rel) && !(binary && ext === 'phar');
    const phpLike = phpByName || (!binary && !MEDIA_EXT.has(ext) && RE_PHP_OPEN.test(text));
    if (phpLike) phpFindings(text, out);
    if (phpByName && binary) out.push(finding('php.nul-byte', lineAt(text, text.indexOf('\0'))));
  }

  if (input.mode !== null && Number.isFinite(input.mode)) {
    if (input.mode & 0o002) out.push(finding('perm.world-writable'));
    const shebang = !!data && data.length >= 2 && data[0] === 0x23 && data[1] === 0x21;
    if (input.mode & 0o111 && !shebang && !isElf(data ?? Buffer.alloc(0))) out.push(finding('perm.exec-bit'));
  }
  return out;
}

/** The scan.skipped info finding (engines not run on this file). */
export function skippedFinding(reason: 'size' | 'unreadable' | 'scanner', limitMb?: number): ChangedFileFinding {
  const message = reason === 'size'
    ? `Not sent to the scan engines: larger than ${limitMb ?? '?'} MB`
    : reason === 'unreadable' ? 'Not sent to the scan engines: unreadable' : 'Not sent to the scan engines: scanner unavailable';
  return finding('scan.skipped', null, { message });
}

/**
 * An executable file whose content was NOT inspected in full (heuristics read
 * the first HEURISTIC_MAX_BYTES, the engines did not cover it: too large,
 * disabled, unavailable, unreadable): a webshell appended after 4 MiB of
 * padding would otherwise score 0. Scored at least reviewScore so it always
 * needs a human (suspicious ⇒ awaiting approval, never auto-validated).
 */
export function uninspectedExecFinding(reviewScore: number): ChangedFileFinding {
  const points = Math.max(HEURISTIC_RULES['scan.exec-uninspected'].points, Math.min(100, Math.max(0, Math.round(reviewScore))));
  return finding('scan.exec-uninspected', null, { points });
}

/** Directories holding at least one executable among `paths` (code-dir evidence for generic apps). */
export function codeDirsOf(paths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    if (!isExecutablePath(p)) continue;
    const d = dirName(p);
    if (d) out.add(d);
  }
  return out;
}

