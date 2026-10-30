import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, fingerprintOf, hintOf, maskFrame, maskSensitive, normalizeMessage, parseHead, parseLines, sampleOf, tsKey, unwrap,
} from './parse';

const AT = '2026-10-30T10:00:00.123456789Z';
const at = (s: number) => `2026-10-30T10:00:${String(s).padStart(2, '0')}.000000001Z`;

test('a PHP warning: level, message without location, relative file, release number', () => {
  const e = parseHead('PHP Warning:  Undefined variable $x in /srv/releases/12/app/index.php on line 5', AT)!;
  assert.equal(e.level, 'warning');
  assert.equal(e.message, 'Undefined variable $x');
  assert.equal(e.file, 'app/index.php');
  assert.equal(e.line, 5);
  assert.equal(e.releaseNumber, 12);
  assert.equal(e.errorClass, null);
});

test('levels: fatal, parse, notice, deprecated, user error; unknown lines ignored', () => {
  assert.equal(parseHead('PHP Fatal error:  Allowed memory size of 268435456 bytes exhausted in /srv/releases/3/a.php on line 9', AT)!.level, 'fatal');
  assert.equal(parseHead('PHP Parse error:  syntax error, unexpected token "}" in /srv/releases/3/a.php on line 2', AT)!.level, 'parse');
  assert.equal(parseHead('PHP Notice:  Undefined index: q in /srv/releases/3/a.php on line 2', AT)!.level, 'notice');
  assert.equal(parseHead('PHP Deprecated:  Function create_function() is deprecated in /srv/releases/3/a.php on line 2', AT)!.level, 'deprecated');
  assert.equal(parseHead('PHP User error:  custom in /srv/releases/3/a.php on line 2', AT)!.level, 'fatal');
  assert.equal(parseHead('NOTICE: fpm is running, pid 1', AT), null);
  assert.equal(parseHead('10.0.0.1 - GET /index.php 200', AT), null);
  assert.equal(parseHead('PHP Something odd:  x', AT), null);
});

test('greedy location: the LAST " in <path> on line" is the location', () => {
  const e = parseHead('PHP Warning:  include(/srv/data/x.php): Failed to open stream: No such file or directory in /srv/releases/4/a.php on line 7', AT)!;
  assert.equal(e.message, 'include(/srv/data/x.php): Failed to open stream: No such file or directory');
  assert.equal(e.file, 'a.php');
  assert.equal(e.line, 7);
});

test('uncaught exception with its stack: frames joined, arguments masked, releases relative', () => {
  const ev = parseLines([
    { at: at(1), text: '[30-Oct-2026 10:00:01 UTC] PHP Fatal error:  Uncaught PDOException: SQLSTATE[HY000] [1045] Access denied in /srv/releases/7/db.php:12' },
    { at: at(1), text: 'Stack trace:' },
    { at: at(1), text: "#0 /srv/releases/7/db.php(12): PDO->__construct('mysql:host=db', 'root', 'hunter2')" },
    { at: at(1), text: '#1 {main}' },
    { at: at(1), text: '  thrown in /srv/releases/7/db.php on line 12' },
    { at: at(2), text: '[30-Oct-2026 10:00:02 UTC] PHP Notice:  x in /srv/releases/7/b.php on line 1' },
  ]);
  assert.equal(ev.length, 2);
  const [f, n] = ev;
  assert.equal(f.level, 'fatal');
  assert.equal(f.file, 'db.php');
  assert.equal(f.line, 12);
  assert.equal(f.releaseNumber, 7);
  assert.equal(f.stack.length, 4);
  assert.equal(f.stack[1], '#0 db.php(12): PDO->__construct(…)');
  assert.ok(!sampleOf(f).includes('hunter2'));
  assert.ok(sampleOf(f).startsWith('Uncaught PDOException: SQLSTATE[HY000] [1045] Access denied in db.php on line 12\nStack trace:'));
  assert.equal(n.level, 'notice');
  assert.equal(n.stack.length, 0);
});

test('a continuation far from its head (or after an unrelated line) is not joined', () => {
  const ev = parseLines([
    { at: at(1), text: 'PHP Fatal error:  Uncaught Error: boom in /srv/releases/2/a.php:3' },
    { at: at(9), text: 'Stack trace:' },
  ]);
  assert.equal(ev[0].stack.length, 0);
  const ev2 = parseLines([
    { at: at(1), text: 'PHP Fatal error:  Uncaught Error: boom in /srv/releases/2/a.php:3' },
    { at: at(1), text: 'NOTICE: something else' },
    { at: at(1), text: '#0 {main}' },
  ]);
  assert.equal(ev2[0].stack.length, 0);
});

test('PHP 5.6 / 7.2 php-fpm decoration and web server relays are unwrapped', () => {
  assert.deepEqual(unwrap('[30-Oct-2026 10:00:00] WARNING: [pool site] child 31 said into stderr: "PHP Warning:  a in /srv/releases/1/x.php on line 2"'),
    ['PHP Warning:  a in /srv/releases/1/x.php on line 2']);
  const nginx = '2026/10/30 10:00:00 [error] 7#7: *1 FastCGI sent in stderr: "PHP message: PHP Warning:  a in /srv/releases/1/x.php on line 2PHP message: PHP Notice:  b in /srv/releases/1/y.php on line 3" while reading response header from upstream, client: 203.0.113.9';
  const parts = unwrap(nginx);
  assert.equal(parts.length, 2);
  assert.equal(parseHead(parts[0], AT)!.file, 'x.php');
  assert.equal(parseHead(parts[1], AT)!.file, 'y.php');
  const apache = "[proxy_fcgi:error] [pid 9] [client 203.0.113.9:5] AH01071: Got error 'PHP message: PHP Fatal error:  Uncaught Error: c in /srv/releases/1/z.php:4', referer: https://example.com/";
  const one = unwrap(apache);
  assert.equal(one.length, 1);
  const e = parseHead(one[0], AT)!;
  assert.equal(e.file, 'z.php');
  assert.equal(e.line, 4);
});

test('immutable model: read-only writes and refused execution are classified, with a hint', () => {
  const ro = parseHead('PHP Warning:  file_put_contents(/srv/releases/9/cache/a.txt): Failed to open stream: Read-only file system in /srv/releases/9/lib/cache.php on line 14', AT)!;
  assert.equal(ro.errorClass, 'readOnlyWrite');
  assert.equal(ro.message, 'file_put_contents(cache/a.txt): Failed to open stream: Read-only file system');
  assert.match(hintOf('readOnlyWrite')!, /add_data_path/);
  const guard = parseLines([{ at: AT, text: '[30-Oct-2026 10:00:00 UTC] oblimint guard: refused to execute /srv/data/uploads/shell.php (real path: /srv/data/uploads/shell.php)' }]);
  assert.equal(guard.length, 1);
  assert.equal(guard[0].errorClass, 'execRefused');
  assert.equal(guard[0].level, 'fatal');
  const exec = parseHead('PHP Fatal error:  oblimint: refusing to execute /tmp/x.php: PHP code only runs from the release (data paths and /tmp are never executable) in /srv/releases/5/index.php on line 3', AT)!;
  assert.equal(exec.errorClass, 'execRefused');
  assert.equal(classify('mkdir(): Read-only file system'), 'readOnlyWrite');
  assert.equal(hintOf(null), null);
});

test('fingerprint: numbers, hex and release numbers do not split a group; file:line and level do', () => {
  const a = parseHead('PHP Warning:  Undefined array key 42 at 0x7ffd in /srv/releases/3/a.php on line 5', AT)!;
  const b = parseHead('PHP Warning:  Undefined array key 7 at 0x10 in /srv/releases/4/a.php on line 5', AT)!;
  const c = parseHead('PHP Warning:  Undefined array key 7 at 0x10 in /srv/releases/4/a.php on line 6', AT)!;
  const d = parseHead('PHP Notice:  Undefined array key 7 at 0x10 in /srv/releases/4/a.php on line 5', AT)!;
  assert.equal(fingerprintOf(a), fingerprintOf(b));
  assert.notEqual(fingerprintOf(b), fingerprintOf(c));
  assert.notEqual(fingerprintOf(b), fingerprintOf(d));
  assert.equal(fingerprintOf(a).length, 40);
  assert.equal(normalizeMessage('Allowed memory size of 268435456 bytes exhausted (tried to allocate 20480 bytes)'), 'Allowed memory size of N bytes exhausted (tried to allocate N bytes)');
});

test('masking: passwords, tokens, URL credentials, frame arguments', () => {
  assert.equal(maskSensitive('connect failed password=hunter2; host=db'), 'connect failed password=***; host=db');
  assert.equal(maskSensitive("token: 'abc.def'"), 'token: ***');
  assert.equal(maskSensitive('GET https://user:s3cret@example.com/x'), 'GET https://***:***@example.com/x');
  assert.equal(maskFrame("#2 /srv/releases/1/a.php(3): login('admin', 'pw')"), '#2 /srv/releases/1/a.php(3): login(…)');
  assert.equal(maskFrame('#3 {main}'), '#3 {main}');
  assert.equal(maskFrame('#1 /srv/releases/1/a.php(3): f()'), '#1 /srv/releases/1/a.php(3): f()');
});

test('masking needs an explicit separator: parse errors and plain words stay readable', () => {
  const p = parseHead('PHP Parse error:  syntax error, unexpected token "}", expecting ";" in /srv/releases/3/a.php on line 7', AT)!;
  assert.equal(p.message, 'syntax error, unexpected token "}", expecting ";"');
  assert.equal(parseHead('PHP Fatal error:  Uncaught TypeError: Auth expects array in /srv/releases/3/a.php:2', AT)!.message, 'Uncaught TypeError: Auth expects array');
  assert.equal(maskSensitive('unexpected token "}"'), 'unexpected token "}"');
  assert.equal(maskSensitive('Call to undefined method Token::parse()'), 'Call to undefined method Token::parse()');
  assert.equal(maskSensitive('the secret sauce'), 'the secret sauce');
  // still masked: explicit separators, prefixed keys, Authorization schemes, bearer credentials
  assert.equal(maskSensitive('csrf_token=abc123'), 'csrf_token=***');
  assert.equal(maskSensitive('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y'), 'Authorization: Bearer ***');
  assert.equal(maskSensitive('sent Bearer eyJhbGciOiJIUzI1NiJ9abc'), 'sent Bearer ***');
  assert.equal(maskSensitive('Bearer authentication failed'), 'Bearer authentication failed');
  assert.equal(maskSensitive('DB_PASSWORD = "x y"'), 'DB_PASSWORD = ***');
});

test('fingerprint: hash-like file names do not split a group; read-only writes group by folder', () => {
  const w = (name: string) => parseHead(`PHP Warning:  file_put_contents(/srv/releases/3/var/cache/prod/twig/${name.slice(0, 2)}/${name}.php): Failed to open stream: Read-only file system in /srv/releases/3/vendor/x.php on line 9`, AT)!;
  const a = w('ab12cd34ef56');
  const b = w('d11819a8ffee');
  assert.equal(a.errorClass, 'readOnlyWrite');
  assert.equal(fingerprintOf(a), fingerprintOf(b));
  assert.ok(a.message.includes('var/cache/prod/twig/ab/ab12cd34ef56.php'), 'the stored message keeps the real path');
  const other = parseHead('PHP Warning:  file_put_contents(/srv/releases/3/public/uploads/a.jpg): Failed to open stream: Read-only file system in /srv/releases/3/vendor/x.php on line 9', AT)!;
  assert.notEqual(fingerprintOf(a), fingerprintOf(other), 'another folder is another root cause');
  assert.equal(normalizeMessage('move_uploaded_file(/tmp/phpA1b2C3d): x'), 'move_uploaded_file(/tmp/H): x');
  assert.equal(normalizeMessage('session sess_9f8e7d6c5b4a3 lost'), 'session sess_H lost');
  assert.equal(normalizeMessage('Class "Symfony\\Component\\Foo" not found'), 'Class "Symfony\\Component\\Foo" not found');
  const g1 = parseLines([{ at: AT, text: 'oblimint guard: refused to execute /srv/data/uploads/a1b2c3d4e5.php' }])[0];
  const g2 = parseLines([{ at: AT, text: 'oblimint guard: refused to execute /srv/data/uploads/zz/shell.php' }])[0];
  assert.equal(fingerprintOf(g1), fingerprintOf(g2));
});

test('numbers from the text stay in integer range; NUL removed', () => {
  const big = parseHead('PHP Warning:  include(/srv/releases/99999999999/x.php): Failed to open stream in /srv/releases/current/index.php on line 3', AT)!;
  assert.equal(big.releaseNumber, null);
  const both = parseHead('PHP Warning:  include(/srv/releases/99999999999/x.php): see /srv/releases/4/y.php', AT)!;
  assert.equal(both.releaseNumber, 4, 'an out-of-range number is skipped, the next path counts');
  assert.equal(parseHead('PHP Warning:  x in /srv/releases/2/a.php on line 99999999999', AT)!.line, null);
  assert.equal(parseHead('PHP Warning:  x in /srv/releases/2/a.php on line 0', AT)!.line, 0);
  const nul = parseLines([
    { at: AT, text: 'PHP Fatal error:  Uncaught Error: a\u0000b in /srv/releases/2/a\u0000.php:3' },
    { at: AT, text: '#0 /srv/releases/2/b.php(4): f\u0000()' },
  ])[0];
  assert.equal(nul.message, 'Uncaught Error: ab');
  assert.equal(nul.file, 'a.php');
  assert.ok(!sampleOf(nul).includes('\u0000'));
});

test('"current" in a path gives no release number (attributed by time instead)', () => {
  const e = parseHead('PHP Warning:  x in /srv/releases/current/a.php on line 1', AT)!;
  assert.equal(e.file, 'a.php');
  assert.equal(e.releaseNumber, null);
});

test('tsKey: Docker RFC 3339 nano timestamps become sortable text', () => {
  assert.equal(tsKey('2026-10-30T10:00:00.1Z'), '2026-10-30T10:00:00.100000000Z');
  assert.equal(tsKey('2026-10-30T10:00:00Z'), '2026-10-30T10:00:00.000000000Z');
  assert.ok(tsKey('2026-10-30T10:00:00.1Z') > tsKey('2026-10-30T10:00:00.099999999Z'));
  assert.equal(tsKey('2026-10-30T12:00:00.5+02:00'), '2026-10-30T10:00:00.500000000Z');
  assert.equal(tsKey(''), '');
  assert.equal(tsKey('garbage'), '');
});

test('long messages and stacks are bounded', () => {
  const e = parseLines([
    { at: AT, text: `PHP Fatal error:  Uncaught Error: ${'x'.repeat(5000)} in /srv/releases/1/a.php:1` },
    ...Array.from({ length: 200 }, (_, i) => ({ at: AT, text: `#${i} /srv/releases/1/a.php(1): f()` })),
  ])[0];
  assert.ok(e.message.length <= 1000);
  assert.equal(e.stack.length, 60);
  assert.ok(sampleOf(e).length <= 8 * 1024);
});
