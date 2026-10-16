import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'stream';
import { AppError } from '../../middleware/errorHandler';
import { HostdError } from '../hostd/client';
import type { hostdFiles } from '../hostd/files';
import type { AccountRow } from '../hosting/rows';
import { UPLOAD_CHUNK_SIZE, fileError, filesService, joinVirtual, setFilesDeps, splitVirtual, sweep, validName } from './files.service';

// Web file explorer service: virtual paths, chunked uploads (auto-commit on the
// last chunk), quota block, publish notifications (fake hostd).

const account = { id: 7, tenant_id: 2, node_id: 1, uid: 10007, gid: 10007, status: 'active', username: 'acct' } as AccountRow;
let calls: Array<[string, ...unknown[]]>;
let notified: number[];
let blocked: boolean;
let now: number;
let failCommit: HostdError | null;

function fakeHostd(): typeof hostdFiles {
  const rec = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args.slice(2)]); };
  return {
    list: async (_t, rel) => {
      calls.push(['list', rel]);
      return { path: rel, uid: rel === 'data/site' ? 0 : 10007, truncated: false,
        entries: [{ name: 'site', kind: 'dir', size: 0, mtime: 1, mode: 0o750, uid: 10007 }, { name: 'f.txt', kind: 'file', size: 3, mtime: 42, mode: 0o644, uid: 10007 }] };
    },
    openContent: async () => { throw new Error('unused'); },
    openZip: async () => { throw new Error('unused'); },
    openTar: async () => { throw new Error('unused'); },
    untar: async () => { throw new Error('unused'); },
    extract: async (_t, _o, archive, to, overwrite) => { calls.push(['extract', archive, to, overwrite]); return { files: 2, dirs: 1, bytes: 10, skipped: 0, conflicts: [] }; },
    mkdir: rec('mkdir'),
    remove: rec('remove'),
    move: rec('move'),
    copy: rec('copy'),
    uploadBegin: rec('begin'),
    uploadChunk: async (_t, _o, rel, id, offset, length, body) => {
      let n = 0;
      for await (const c of body as AsyncIterable<Buffer>) n += c.length;
      calls.push(['chunk', rel, id, offset, length, n]);
    },
    uploadCommit: async (_t, _o, rel, id, size, overwrite) => {
      if (failCommit) throw failCommit;
      calls.push(['commit', rel, id, size, overwrite]);
    },
    uploadAbort: rec('abort'),
  };
}

beforeEach(() => {
  calls = [];
  notified = [];
  blocked = false;
  now = 1_000_000;
  failCommit = null;
  setFilesDeps({
    hostd: fakeHostd(),
    uploadsBlocked: async () => blocked,
    sitesOf: async () => [{ id: 31, slug: 'site', label: 'example.com' }],
    notifyChange: (id) => notified.push(id),
    now: () => now,
  });
});

afterEach(() => setFilesDeps(null));

const bytes = (n: number) => Readable.from([Buffer.alloc(n)]);

test('virtual paths: root, areas, refusals', () => {
  assert.deepEqual(splitVirtual('/'), []);
  assert.deepEqual(splitVirtual('/staging/site/a b/é.txt/'), ['staging', 'site', 'a b', 'é.txt']);
  for (const bad of ['/sites/1', '/staging/../x', '/staging/./x', '/staging/a\\b', '/data/a\0b', 7]) {
    assert.throws(() => splitVirtual(bad), (e: AppError) => e.code === 'invalidPath', String(bad));
  }
  assert.equal(joinVirtual(['staging', 'site']), '/staging/site');
  assert.ok(validName('index.php') && !validName('..') && !validName('a/b') && !validName(''));
});

test('listing: virtual root, site labels on the area level, writable only for the account\'s directories', async () => {
  const root = await filesService.list(account, '/');
  assert.deepEqual(root.entries.map((e) => e.name), ['staging', 'data']);
  assert.equal(root.writable, false);
  const staging = await filesService.list(account, '/staging');
  assert.equal(staging.writable, false, 'first level: never');
  assert.deepEqual(staging.entries[0].site, { id: 31, label: 'example.com' });
  assert.equal((await filesService.list(account, '/staging/site')).writable, true);
  assert.equal((await filesService.list(account, '/data/site')).writable, false, 'root-owned data/<site>');
  blocked = true;
  const over = await filesService.list(account, '/staging/site');
  assert.equal(over.writable, false);
  assert.equal(over.uploadsBlocked, true);
});

test('upload: chunks in any order, the last one commits and notifies the site', async () => {
  const size = UPLOAD_CHUNK_SIZE * 2 + 10;
  const s = await filesService.uploadStart(account, 5, { path: '/staging/site/big.zip', size });
  assert.equal(s.count, 3);
  assert.deepEqual(calls[0], ['begin', 'staging/site/big.zip', s.id, size, false]);
  await assert.rejects(filesService.uploadChunk(account, 5, s.id, 2, 11, bytes(11)), (e: AppError) => e.code === 'invalidChunk');
  assert.equal((await filesService.uploadChunk(account, 5, s.id, 2, 10, bytes(10))).done, false);
  await filesService.uploadChunk(account, 5, s.id, 0, UPLOAD_CHUNK_SIZE, bytes(UPLOAD_CHUNK_SIZE));
  assert.deepEqual(filesService.uploadStatus(account, 5, s.id).received, [0, 2]);
  // Another user (or account) never sees the session.
  assert.throws(() => filesService.uploadStatus(account, 6, s.id), (e: AppError) => e.code === 'uploadNotFound');
  const last = await filesService.uploadChunk(account, 5, s.id, 1, UPLOAD_CHUNK_SIZE, bytes(UPLOAD_CHUNK_SIZE));
  assert.deepEqual(last, { done: true, received: 3 });
  assert.deepEqual(calls.filter((c) => c[0] === 'chunk').map((c) => c[3]), [2 * UPLOAD_CHUNK_SIZE, 0, UPLOAD_CHUNK_SIZE]);
  assert.deepEqual(calls.at(-1), ['commit', 'staging/site/big.zip', s.id, size, false]);
  assert.deepEqual(notified, [31]);
  // Replayed after done: nothing written again.
  assert.equal((await filesService.uploadChunk(account, 5, s.id, 1, UPLOAD_CHUNK_SIZE, bytes(UPLOAD_CHUNK_SIZE))).done, true);
  assert.equal(calls.filter((c) => c[0] === 'commit').length, 1);
});

test('upload: empty file = one empty chunk; a failed commit is retried by the next chunk', async () => {
  const s = await filesService.uploadStart(account, 5, { path: '/data/site/uploads/empty', size: 0 });
  assert.equal(s.count, 1);
  failCommit = new HostdError(409, 'hostd POST /v1/x: data/site/uploads/empty already exists', 'exists');
  await assert.rejects(filesService.uploadChunk(account, 5, s.id, 0, 0, bytes(0)), (e: AppError) => e.code === 'fileExists' && !e.message.includes('/v1/'));
  failCommit = null;
  assert.equal((await filesService.uploadChunk(account, 5, s.id, 0, 0, bytes(0))).done, true);
  assert.deepEqual(notified, [], '/data changes publish nothing');
});

test('upload: refused over quota or on a suspended account; deleting stays possible over quota', async () => {
  blocked = true;
  await assert.rejects(filesService.uploadStart(account, 5, { path: '/staging/site/a', size: 1 }), (e: AppError) => e.code === 'uploadsBlocked');
  await assert.rejects(filesService.mkdir(account, '/staging/site/d'), (e: AppError) => e.code === 'uploadsBlocked');
  const res = await filesService.remove(account, ['/staging/site/a', '/staging/site']);
  assert.deepEqual(res.map((r) => [r.ok, r.code]), [[true, undefined], [false, 'fileForbidden']]);
  assert.deepEqual(notified, [31]);
  blocked = false;
  await assert.rejects(filesService.mkdir({ ...account, status: 'suspended' } as AccountRow, '/staging/site/d'), (e: AppError) => e.code === 'accountNotActive');
});

test('editor save: refused when the file changed since it was opened', async () => {
  await assert.rejects(filesService.uploadStart(account, 5, { path: '/staging/site/f.txt', size: 3, expectedMtime: 41 }), (e: AppError) => e.code === 'fileChanged');
  const s = await filesService.uploadStart(account, 5, { path: '/staging/site/f.txt', size: 3, expectedMtime: 42 });
  assert.deepEqual(calls.at(-1), ['begin', 'staging/site/f.txt', s.id, 3, true]);
});

test('move / copy: batch results, first two levels refused, both ends notified', async () => {
  const res = await filesService.move(account, [
    { from: '/staging/site/a', to: '/staging/site/b' },
    { from: '/staging/site', to: '/staging/other' },
  ], false);
  assert.deepEqual(res.map((r) => r.ok), [true, false]);
  assert.deepEqual(calls[0], ['move', 'staging/site/a', 'staging/site/b', false]);
  await filesService.copy(account, [{ from: '/staging/site/a', to: '/data/site/uploads/a' }]);
  assert.deepEqual(calls.at(-1), ['copy', 'staging/site/a', 'data/site/uploads/a']);
});

test('extract: into the archive folder by default, refused on the first level and over quota', async () => {
  const r = await filesService.extract(account, '/staging/site/wp.zip', undefined, false);
  assert.equal(r.files, 2);
  assert.deepEqual(calls.at(-1), ['extract', 'staging/site/wp.zip', 'staging/site', false]);
  assert.deepEqual(notified, [31]);
  await assert.rejects(filesService.extract(account, '/staging/site/wp.zip', '/staging', false), (e: AppError) => e.code === 'fileForbidden');
  blocked = true;
  await assert.rejects(filesService.extract(account, '/staging/site/wp.zip', undefined, false), (e: AppError) => e.code === 'uploadsBlocked');
});

test('small file in one request: begin + chunk + commit, aborted on failure', async () => {
  const p = await filesService.putSmall(account, { path: '/staging/site/a.css', size: 4 }, bytes(4));
  assert.equal(p, '/staging/site/a.css');
  assert.deepEqual(calls.map((c) => c[0]), ['begin', 'chunk', 'commit']);
  assert.deepEqual(notified, [31]);
  calls = [];
  failCommit = new HostdError(409, 'hostd POST /v1/x: exists', 'exists');
  await assert.rejects(filesService.putSmall(account, { path: '/staging/site/a.css', size: 4 }, bytes(4)), (e: AppError) => e.code === 'fileExists');
  assert.equal(calls.at(-1)?.[0], 'abort');
  await assert.rejects(filesService.putSmall(account, { path: '/staging/site/big', size: UPLOAD_CHUNK_SIZE + 1 }, bytes(1)), (e: AppError) => e.code === 'invalid');
});

test('abandoned sessions are aborted by the sweeper', async () => {
  const s = await filesService.uploadStart(account, 5, { path: '/staging/site/x', size: 5 });
  now += 31 * 60_000;
  await sweep();
  assert.deepEqual(calls.at(-1), ['abort', 'staging/site/x', s.id]);
  assert.throws(() => filesService.uploadStatus(account, 5, s.id), (e: AppError) => e.code === 'uploadNotFound');
});

test('hostd errors map to explorer codes without leaking the hostd request line', () => {
  const e = fileError(new HostdError(403, 'hostd POST /v1/accounts/7/files/mkdir: data/site is not writable by the account', 'forbidden'));
  assert.equal(e.statusCode, 403);
  assert.equal(e.code, 'fileForbidden');
  assert.equal(e.message, 'data/site is not writable by the account');
  assert.equal(fileError(new HostdError(507, 'x', 'quotaExceeded')).code, 'quotaExceeded');
  assert.equal(fileError(new HostdError(404, 'hostd GET /v1/accounts/3/files: no route GET /v1/accounts/3/files', 'notFound')).code, 'hostdOutdated');
  assert.equal(fileError(new HostdError(503, 'hostd unreachable', 'hostdUnavailable')).code, 'backendUnavailable');
});
