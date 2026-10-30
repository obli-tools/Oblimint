import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { AppError } from '../../middleware/errorHandler';
import type { AccountRow } from '../hosting/rows';
import { Readable } from 'stream';
import { filesService, setFilesDeps } from './files.service';
import { compileGlob, fileTools, normalizeSha256 } from './fileTools';
import { memHostd, type MemHostd } from './testUtil';

// Fine file tools of the keys (fileTools.ts) on an in-memory hostd: partial
// reads (lines / bytes) with the hash of the whole file, exact edits all or
// nothing, the SHA-256 precondition (409 fileChanged + currentSha256, also when
// the file moves between the read and the write), listing hashes, bounded
// search (globs, vendor, binaries, links, caps, regex time limit).

const account = { id: 7, tenant_id: 2, node_id: 1, uid: 10007, gid: 10007, status: 'active', username: 'acct' } as AccountRow;
const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
const code = (c: string) => (e: AppError) => e.code === c;
let mem: MemHostd;
let notified: number[];

beforeEach(() => {
  mem = memHostd();
  notified = [];
  setFilesDeps({
    hostd: mem.hostd,
    uploadsBlocked: async () => false,
    sitesOf: async () => [{ id: 31, slug: 'web', label: 'example.com' }],
    notifyChange: (id) => notified.push(id),
  });
});
afterEach(() => setFilesDeps(null));

test('read by lines: the range, totalLines and the hash of the whole file; chunk boundaries inside characters', async () => {
  const body = 'line 1\r\nlíne 2 é\nline 3\n€ line 4\nline 5';
  mem.put('staging/web/a.php', body);
  mem.chunkSize = 3; // every multi-byte character crosses a chunk
  const r = await fileTools.readRange(account, '/staging/web/a.php', { startLine: 2, endLine: 4 });
  assert.equal(r.content, 'líne 2 é\nline 3\n€ line 4');
  assert.deepEqual([r.mode, r.totalLines, r.startLine, r.endLine, r.nextLine, r.truncated], ['lines', 5, 2, 4, null, false]);
  assert.equal(r.sha256, sha(body));
  assert.equal(r.size, Buffer.byteLength(body));
  const all = await fileTools.readRange(account, '/staging/web/a.php');
  assert.equal(all.content, body, 'default: the whole (small) file, line endings kept');
  assert.equal(all.endLine, 5);
  const past = await fileTools.readRange(account, '/staging/web/a.php', { startLine: 9 });
  assert.deepEqual([past.content, past.endLine, past.nextLine, past.truncated], ['', 8, null, false]);
  mem.put('staging/web/nl.txt', 'a\nb\n');
  assert.equal((await fileTools.readRange(account, '/staging/web/nl.txt')).totalLines, 2, 'a final newline ends the last line');
});

test('read by lines: caps give truncated + nextLine; a huge line is cut; binary and over-limit files', async () => {
  mem.put('staging/web/l.txt', Array.from({ length: 10 }, (_, i) => `row ${i + 1}`).join('\n'));
  const r = await fileTools.readRange(account, '/staging/web/l.txt', { startLine: 3, maxChars: 12 });
  assert.equal(r.content, 'row 3\nrow 4');
  assert.deepEqual([r.endLine, r.nextLine, r.truncated, r.totalLines], [4, 5, true, 10]);
  mem.put('staging/web/long.min.js', `${'x'.repeat(50)}\nend`);
  const cut = await fileTools.readRange(account, '/staging/web/long.min.js', { maxChars: 20 });
  assert.equal(cut.content, 'x'.repeat(20));
  assert.deepEqual([cut.truncated, cut.nextLine], [true, 2]);
  mem.put('staging/web/i.png', Buffer.from([0x89, 0x50, 0, 1, 2]));
  const bin = await fileTools.readRange(account, '/staging/web/i.png');
  assert.deepEqual([bin.binary, bin.content, bin.totalLines], [true, null, null]);
  assert.equal(bin.sha256, sha(Buffer.from([0x89, 0x50, 0, 1, 2])), 'a binary file still has its hash');
  await assert.rejects(fileTools.readRange(account, '/staging/web/l.txt', { startLine: 4, endLine: 2 }), code('invalid'));
  await assert.rejects(fileTools.readRange(account, '/staging/web/l.txt', { startLine: 1, offset: 0 }), code('invalid'));
  await assert.rejects(fileTools.readRange(account, '/staging/web/none.txt'), code('fileNotFound'));
});

test('read by bytes: window, nextOffset, base64, binary in utf8', async () => {
  const buf = Buffer.from('0123456789abcdef');
  mem.put('staging/web/b.bin', buf);
  mem.chunkSize = 5;
  const w = await fileTools.readRange(account, '/staging/web/b.bin', { offset: 3, length: 6 });
  assert.deepEqual([w.mode, w.content, w.offset, w.length, w.nextOffset, w.sha256], ['bytes', '345678', 3, 6, 9, sha(buf)]);
  const end = await fileTools.readRange(account, '/staging/web/b.bin', { offset: 12, length: 100, encoding: 'base64' });
  assert.deepEqual([Buffer.from(end.content!, 'base64').toString(), end.nextOffset], ['cdef', null]);
  mem.put('staging/web/z.bin', Buffer.from([1, 0, 2]));
  const z = await fileTools.readRange(account, '/staging/web/z.bin', { offset: 0 });
  assert.deepEqual([z.binary, z.content], [true, null]);
});

test('edit: exact replacements in order, the new hash, the site notified', async () => {
  const before = '<?php\n$a = 1;\n$b = 2;\necho $a;\n';
  mem.put('staging/web/i.php', before);
  const r = await fileTools.edit(account, '/staging/web/i.php', [
    { oldString: '$a = 1;', newString: '$a = 10;' },
    { oldString: '$a', newString: '$x', replaceAll: true },
    { oldString: '$x = 10;\n$b', newString: '$x = 10; // $ & $1\n$b' },
  ], sha(before));
  const after = '<?php\n$x = 10; // $ & $1\n$b = 2;\necho $x;\n';
  assert.equal(mem.text('staging/web/i.php'), after, 'replacement strings are literal ($ & $1 kept)');
  assert.deepEqual([r.sha256, r.previousSha256, r.replacements, r.size, r.executableBitLost], [sha(after), sha(before), 4, Buffer.byteLength(after), false]);
  assert.deepEqual(notified, [31]);
  // Without precondition it still edits the CURRENT content.
  await fileTools.edit(account, '/staging/web/i.php', [{ oldString: 'echo', newString: 'print' }]);
  assert.match(mem.text('staging/web/i.php')!, /print \$x/);
});

test('edit: all or nothing; not found, not unique, same text, binary, not UTF-8', async () => {
  const body = 'a = 1\na = 1\nb = 2\n';
  mem.put('staging/web/c.ini', body);
  await assert.rejects(fileTools.edit(account, '/staging/web/c.ini', [{ oldString: 'b = 2', newString: 'b = 3' }, { oldString: 'zzz', newString: 'y' }]),
    (e: AppError) => e.code === 'editNotFound' && (e.details as { index: number }).index === 1);
  await assert.rejects(fileTools.edit(account, '/staging/web/c.ini', [{ oldString: 'a = 1', newString: 'a = 2' }]),
    (e: AppError) => e.code === 'editNotUnique' && (e.details as { occurrences: number }).occurrences === 2 && e.statusCode === 409);
  await assert.rejects(fileTools.edit(account, '/staging/web/c.ini', [{ oldString: 'b', newString: 'b' }]), code('editNoChange'));
  assert.equal(mem.text('staging/web/c.ini'), body, 'nothing written');
  mem.put('staging/web/x.bin', Buffer.from([0x61, 0, 0x62]));
  await assert.rejects(fileTools.edit(account, '/staging/web/x.bin', [{ oldString: 'a', newString: 'c' }]), code('binaryFile'));
  mem.put('staging/web/latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  await assert.rejects(fileTools.edit(account, '/staging/web/latin1.txt', [{ oldString: 'ca', newString: 'co' }]), code('notUtf8'));
  await assert.rejects(fileTools.edit(account, '/staging/web/none.txt', [{ oldString: 'a', newString: 'b' }]), code('fileNotFound'));
  mem.put('staging/web/run.sh', '#!/bin/sh\necho hi\n', 0o755);
  assert.equal((await fileTools.edit(account, '/staging/web/run.sh', [{ oldString: 'hi', newString: 'ho' }])).executableBitLost, true);
});

test('precondition: a human change since the read is never overwritten (409 fileChanged + currentSha256)', async () => {
  mem.put('staging/web/i.php', 'v1');
  const read = await fileTools.readRange(account, '/staging/web/i.php');
  mem.put('staging/web/i.php', 'v1 changed over SFTP');
  await assert.rejects(fileTools.edit(account, '/staging/web/i.php', [{ oldString: 'v1', newString: 'v2' }], read.sha256),
    (e: AppError) => e.code === 'fileChanged' && e.statusCode === 409 && (e.details as { currentSha256: string }).currentSha256 === sha('v1 changed over SFTP'));
  assert.equal(mem.text('staging/web/i.php'), 'v1 changed over SFTP');
  // A change landing between the edit's read and its write: refused by the mtime pin.
  mem.onOpen = (rel) => { mem.onOpen = null; mem.put(rel, 'v1 changed again'); };
  await assert.rejects(fileTools.edit(account, '/staging/web/i.php', [{ oldString: 'changed', newString: 'x' }]), code('fileChanged'));
  assert.equal(mem.text('staging/web/i.php'), 'v1 changed again');
  // assertSha256 (write_file / PUT): match → the mtime to pin; mismatch; absent; bad hash.
  const mtime = await fileTools.assertSha256(account, '/staging/web/i.php', sha('v1 changed again').toUpperCase());
  assert.equal(mtime, mem.files.get('staging/web/i.php')!.mtime);
  await assert.rejects(fileTools.assertSha256(account, '/staging/web/i.php', sha('v1')), code('fileChanged'));
  await assert.rejects(fileTools.assertSha256(account, '/staging/web/gone.php', sha('v1')),
    (e: AppError) => e.code === 'fileChanged' && (e.details as { currentSha256: null }).currentSha256 === null);
  await assert.rejects(fileTools.edit(account, '/staging/web/gone.php', [{ oldString: 'a', newString: 'b' }], sha('v1')), code('fileChanged'));
  assert.throws(() => normalizeSha256('abc'), code('invalidSha256'));
  assert.equal(normalizeSha256(`"${sha('x').toUpperCase()}"`), sha('x'), 'an ETag-style quoted value is accepted');
});

test('precondition: a file changed or deleted between the edit\'s read and its write (currentSha256, null when gone)', async () => {
  mem.put('staging/web/e.php', 'v1');
  mem.onOpen = (r) => { mem.onOpen = null; mem.put(r, 'human'); };
  await assert.rejects(fileTools.edit(account, '/staging/web/e.php', [{ oldString: 'v1', newString: 'v2' }], sha('v1')),
    (e: AppError) => e.code === 'fileChanged' && (e.details as { currentSha256: string }).currentSha256 === sha('human'));
  assert.equal(mem.text('staging/web/e.php'), 'human');
  mem.onOpen = (r) => { mem.onOpen = null; mem.files.delete(r); };
  await assert.rejects(fileTools.edit(account, '/staging/web/e.php', [{ oldString: 'human', newString: 'agent' }], sha('human')),
    (e: AppError) => e.code === 'fileChanged' && (e.details as { currentSha256: null }).currentSha256 === null);
  assert.equal(mem.files.has('staging/web/e.php'), false, 'a file deleted meanwhile is not recreated');
});

test('precondition: checked again right before the commit (slow body, long upload session)', async () => {
  // One request: the change lands while the body streams.
  mem.put('staging/web/p.txt', 'v1');
  const mtime = mem.files.get('staging/web/p.txt')!.mtime;
  mem.onUpload = (r) => { mem.onUpload = null; mem.put(r, 'human'); };
  await assert.rejects(filesService.putSmall(account, { path: '/staging/web/p.txt', size: 5, expectedMtime: mtime, mustExist: true }, Readable.from([Buffer.from('agent')])),
    code('fileChanged'));
  assert.equal(mem.text('staging/web/p.txt'), 'human');
  // Deleted while streaming: refused with mustExist (key precondition), recreated by the editor's save.
  const m2 = mem.files.get('staging/web/p.txt')!.mtime;
  mem.onUpload = (r) => { mem.onUpload = null; mem.files.delete(r); };
  await assert.rejects(filesService.putSmall(account, { path: '/staging/web/p.txt', size: 5, expectedMtime: m2, mustExist: true }, Readable.from([Buffer.from('agent')])),
    code('fileChanged'));
  assert.equal(mem.files.has('staging/web/p.txt'), false);
  mem.onUpload = (r) => { mem.onUpload = null; mem.files.delete(r); };
  await filesService.putSmall(account, { path: '/staging/web/p.txt', size: 6, expectedMtime: m2 }, Readable.from([Buffer.from('editor')]));
  assert.equal(mem.text('staging/web/p.txt'), 'editor');
  // A session: the change lands between its start and its last chunk.
  const m3 = mem.files.get('staging/web/p.txt')!.mtime;
  const s = await filesService.uploadStart(account, 5, { path: '/staging/web/p.txt', size: 5, expectedMtime: m3, mustExist: true });
  mem.put('staging/web/p.txt', 'human over SFTP');
  await assert.rejects(filesService.uploadChunk(account, 5, s.id, 0, 5, Readable.from([Buffer.from('agent')])), code('fileChanged'));
  assert.equal(mem.text('staging/web/p.txt'), 'human over SFTP');
  assert.throws(() => filesService.uploadStatus(account, 5, s.id), code('uploadNotFound'), 'the session is over');
  // withCurrent: the bare 409 of the pin → the current hash.
  const e = await fileTools.withCurrent(account, '/staging/web/p.txt', new AppError(409, 'x', 'fileChanged')) as AppError;
  assert.equal((e.details as { currentSha256: string }).currentSha256, sha('human over SFTP'));
  // Unchanged: the session commits.
  const m4 = mem.files.get('staging/web/p.txt')!.mtime;
  const ok = await filesService.uploadStart(account, 5, { path: '/staging/web/p.txt', size: 5, expectedMtime: m4, mustExist: true });
  assert.equal((await filesService.uploadChunk(account, 5, ok.id, 0, 5, Readable.from([Buffer.from('agent')]))).done, true);
  assert.equal(mem.text('staging/web/p.txt'), 'agent');
});

test('edit: the size is checked before each replacement (no exponential growth)', async () => {
  mem.put('staging/web/g.txt', 'a'.repeat(1024));
  const t0 = Date.now();
  // Each edit doubles the content: stopped by the replacement cap (100 000 per call) at the 7th.
  await assert.rejects(fileTools.edit(account, '/staging/web/g.txt', Array.from({ length: 20 }, () => ({ oldString: 'a', newString: 'aa', replaceAll: true }))),
    (e: AppError) => e.code === 'tooManyReplacements' && (e.details as { index: number }).index === 6);
  // 4 MB, then 12 MB: refused at the one that would pass 8 MB, before it is built.
  await assert.rejects(fileTools.edit(account, '/staging/web/g.txt', [
    { oldString: 'a', newString: 'b'.repeat(4096), replaceAll: true },
    { oldString: 'b'.repeat(4096), newString: 'c'.repeat(3 * 4096), replaceAll: true },
  ]), (e: AppError) => e.code === 'fileTooLarge' && e.statusCode === 413 && (e.details as { index: number }).index === 1);
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  assert.equal(mem.text('staging/web/g.txt'), 'a'.repeat(1024), 'nothing written');
  const big = '€'.repeat(1000);
  mem.put('staging/web/u.txt', big);
  await assert.rejects(fileTools.edit(account, '/staging/web/u.txt', [{ oldString: '€', newString: '€'.repeat(3000), replaceAll: true }]),
    (e: AppError) => e.code === 'fileTooLarge' && (e.details as { index: number }).index === 0, 'counted in UTF-8 bytes');
});

test('listing hashes: files only, folders untouched', async () => {
  mem.put('staging/web/a.txt', 'A');
  mem.put('staging/web/sub/b.txt', 'B');
  const h = await fileTools.hashListing(account, '/staging/web', [
    { name: 'a.txt', kind: 'file', size: 1, mtime: 1, mode: 0o644 },
    { name: 'sub', kind: 'dir', size: 0, mtime: 1, mode: 0o750 },
    { name: 'gone.txt', kind: 'file', size: 1, mtime: 1, mode: 0o644 },
  ]);
  assert.deepEqual(h.entries.map((e) => [e.name, e.sha256]), [['a.txt', sha('A')], ['sub', undefined], ['gone.txt', null]]);
  assert.equal(h.skipped, 1);
});

test('globs', () => {
  const g = (glob: string, s: string) => compileGlob(glob).test(s);
  assert.ok(g('*.php', 'index.php') && !g('*.php', 'a/index.php'));
  assert.ok(g('wp-content/**/*.php', 'wp-content/plugins/x/a.php'));
  assert.ok(g('wp-content/**/*.php', 'wp-content/a.php'));
  assert.ok(!g('wp-content/**/*.php', 'wp-contentx/a.php') && !g('wp-content/**/*.php', 'wp-content/a.js'));
  assert.ok(g('wp-content/**', 'wp-content/a/b.txt') && g('**/readme.txt', 'readme.txt') && g('**/readme.txt', 'a/b/readme.txt'));
  assert.ok(g('a**b', 'a/x/b') && g('***.js', 'x/y.js') && !g('a*b', 'a/b'));
  assert.ok(g('/src/{a,b}/?.js', 'src/b/x.js') && !g('src/{a,b}/?.js', 'src/c/x.js') && !g('src/{a,b}/?.js', 'src/a/xy.js'));
  assert.ok(g('a.(b)+', 'a.(b)+') && !g('a.(b)+', 'axb'), 'regex characters are literal');
  assert.throws(() => compileGlob('src/{a,b'), code('invalid'));
  assert.throws(() => compileGlob('{a,b}{c,d}{e,f}{g,h}{i,j}'), code('invalid'), 'at most 16 alternatives');
});

test('globs: no backtracking, whatever the glob (linear in the name)', async () => {
  const t0 = Date.now();
  assert.equal(compileGlob('*a*a*a*a*a*a*a*a*a*a*a*a*b').test('a'.repeat(250)), false);
  assert.ok(Date.now() - t0 < 200, `${Date.now() - t0} ms`);
  mem.put(`staging/web/${'a'.repeat(200)}`, 'needle');
  mem.put('staging/web/ab', 'needle');
  const t1 = Date.now();
  const r = await fileTools.search(account, '/staging/web', { query: 'needle', include: [...Array.from({ length: 19 }, () => `${'*a'.repeat(30)}*b`), '*b'] }, rel);
  assert.deepEqual(r.matches.map((m) => m.path), ['/ab']);
  assert.ok(Date.now() - t1 < 2000, `${Date.now() - t1} ms`);
});

const rel = (v: string) => v.replace(/^\/staging\/web/, '') || '/';

test('search: literal (case-insensitive), globs, vendor / binaries / links skipped, order', async () => {
  mem.put('staging/web/index.php', '<?php\nrequire "config.php";\n// TODO: Fix me\n');
  mem.put('staging/web/wp-content/plugins/p/main.php', 'function todo_list() {}\n');
  mem.put('staging/web/wp-content/plugins/p/readme.txt', 'todo\n');
  mem.put('staging/web/vendor/lib/x.php', '// todo in vendor\n');
  mem.put('staging/web/node_modules/m/i.js', 'todo\n');
  mem.put('staging/web/logo.png', 'todo (not really a png)');
  mem.put('staging/web/data.json', Buffer.from('todo\0binary'));
  mem.links.set('staging/web/link.php', '/etc/passwd');
  const r = await fileTools.search(account, '/staging/web', { query: 'todo' }, rel);
  assert.deepEqual(r.matches.map((m) => [m.path, m.line, m.column]), [
    ['/index.php', 3, 4],
    ['/wp-content/plugins/p/main.php', 1, 10],
    ['/wp-content/plugins/p/readme.txt', 1, 1],
  ]);
  assert.equal(r.matches[0].text, '// TODO: Fix me');
  assert.deepEqual(r.skipped, { binary: 2, tooLarge: 0, links: 1, dirs: ['/node_modules', '/vendor'] });
  assert.deepEqual([r.filesScanned, r.filesMatched, r.truncated, r.stoppedBy, r.path], [4, 3, false, null, '/']);
  const php = await fileTools.search(account, '/staging/web', { query: 'TODO', caseSensitive: true, include: ['*.php'], includeVendor: true }, rel);
  assert.deepEqual(php.matches.map((m) => m.path), ['/index.php']);
  const scoped = await fileTools.search(account, '/staging/web/wp-content', { query: 'todo', include: ['wp-content/**/*.php'], exclude: ['**/readme.txt'] }, rel);
  assert.deepEqual([scoped.path, scoped.matches.map((m) => m.path)], ['/wp-content', ['/wp-content/plugins/p/main.php']]);
  const vendor = await fileTools.search(account, '/staging/web', { query: 'in vendor', includeVendor: true }, rel);
  assert.deepEqual(vendor.matches.map((m) => m.path), ['/vendor/lib/x.php']);
  await assert.rejects(fileTools.search(account, '/staging/web/nope', { query: 'x' }, rel), code('fileNotFound'));
  await assert.rejects(fileTools.search(account, '/staging', { query: 'x' }, rel), code('invalidPath'));
});

test('search: regular expressions, caps (results, files, size), long lines cut around the match', async () => {
  for (let i = 0; i < 6; i++) mem.put(`staging/web/f${i}.php`, `<?php\n$v${i} = getenv("DB_PASS");\n$w = getenv('HOME');\n`);
  const re = await fileTools.search(account, '/staging/web', { query: 'getenv\\("DB_\\w+"\\)', regex: true }, rel);
  assert.equal(re.matches.length, 6);
  assert.deepEqual([re.matches[0].line, re.matches[0].column], [2, 7]);
  const capped = await fileTools.search(account, '/staging/web', { query: 'getenv', maxResults: 3, maxPerFile: 1 }, rel);
  assert.deepEqual([capped.matches.length, capped.truncated, capped.stoppedBy], [3, true, 'maxResults']);
  const fewFiles = await fileTools.search(account, '/staging/web', { query: 'getenv' }, rel, { files: 2, bytes: 1e9, ms: 10_000, fileBytes: 1e6 });
  assert.deepEqual([fewFiles.filesScanned, fewFiles.truncated, fewFiles.stoppedBy], [2, true, 'files']);
  mem.put('staging/web/big.php', 'x'.repeat(300));
  const small = await fileTools.search(account, '/staging/web', { query: 'xxx' }, rel, { files: 100, bytes: 1e9, ms: 10_000, fileBytes: 200 });
  assert.deepEqual([small.matches.length, small.skipped.tooLarge], [0, 1]);
  mem.put('staging/web/min.js', `${'a'.repeat(1000)}NEEDLE${'b'.repeat(1000)}`);
  const long = await fileTools.search(account, '/staging/web', { query: 'needle' }, rel);
  assert.equal(long.matches[0].column, 1001);
  assert.ok(long.matches[0].text.length <= 302 && long.matches[0].text.includes('NEEDLE'), long.matches[0].text);
  await assert.rejects(fileTools.search(account, '/staging/web', { query: '(', regex: true }, rel), code('invalidRegex'));
});

test('search: a catastrophic regular expression is stopped (regexTooSlow), the server is not held', async () => {
  mem.put('staging/web/evil.txt', `${'a'.repeat(40)}!`);
  const t0 = Date.now();
  await assert.rejects(fileTools.search(account, '/staging/web', { query: '^(a+)+$', regex: true }, rel, { files: 10, bytes: 1e6, ms: 400, fileBytes: 1e6 }),
    code('regexTooSlow'));
  assert.ok(Date.now() - t0 < 5000, `stopped in ${Date.now() - t0} ms`);
});

test('search: the regex runs off the event loop (timers keep firing during a catastrophic one)', async () => {
  mem.put('staging/web/evil.txt', `${'a'.repeat(40)}!`);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 10);
  try {
    await assert.rejects(fileTools.search(account, '/staging/web', { query: '^(a+)+$', regex: true }, rel, { files: 10, bytes: 1e6, ms: 1000, fileBytes: 1e6 }),
      code('regexTooSlow'));
  } finally { clearInterval(timer); }
  assert.ok(ticks >= 10, `${ticks} ticks during a 500 ms regex`);
});

test('search: regex anchors work on CRLF files', async () => {
  mem.put('staging/web/win.php', '<?php\r\nexit;\r\n$a = f( 1 )  \r\n');
  const r = await fileTools.search(account, '/staging/web', { query: 'exit;$', regex: true }, rel);
  assert.deepEqual(r.matches.map((m) => [m.line, m.column, m.text]), [[2, 1, 'exit;']]);
  assert.equal((await fileTools.search(account, '/staging/web', { query: '\\)\\s*$', regex: true }, rel)).matches[0]?.line, 3);
});

test('search: a regex slow only because the budget is nearly spent stops with stoppedBy time (results kept)', async () => {
  mem.put('staging/web/a.txt', 'aaaa');
  mem.put('staging/web/b.txt', `${'a'.repeat(40)}!`);
  // Reading b.txt eats most of the budget: its regex gets the little time left, not the per-file cap.
  mem.onOpen = (r) => { if (r.endsWith('b.txt')) { const end = Date.now() + 2000; while (Date.now() < end) { /* busy */ } } };
  const r = await fileTools.search(account, '/staging/web', { query: '^(a+)+$', regex: true }, rel, { files: 10, bytes: 1e6, ms: 3000, fileBytes: 1e6 });
  mem.onOpen = null;
  assert.deepEqual([r.matches.map((m) => m.path), r.stoppedBy, r.truncated], [['/a.txt'], 'time', true]);
});
