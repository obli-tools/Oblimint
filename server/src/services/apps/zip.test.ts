import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { makeZip, type ZipEntry } from './testing/zipWriter';
import { extractZip, findComposeRoot, safeEntryName, spoolUpload } from './zip';

// ZIP sources (docs/P4b-PLAN.md §5.3): traversal, absolute names, symlinks, zip bombs (lying headers),
// compressed / expanded limits. Archives are built by a minimal writer below (no zip library installed).

type Entry = ZipEntry;

const limits = { maxCompressedBytes: 1 << 20, maxExpandedBytes: 1 << 20 };

function withTmp(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-zip-'));
    try { await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

async function extract(dir: string, entries: Entry[], lim = limits) {
  const file = path.join(dir, 'up.zip');
  fs.writeFileSync(file, makeZip(entries));
  return extractZip(file, path.join(dir, 'out'), lim);
}

test('safe entry names', () => {
  assert.equal(safeEntryName('a/b.txt'), 'a/b.txt');
  assert.equal(safeEntryName('./a//b'), 'a/b');
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'C:\\x', '..\\x', 'a\0b', '']) assert.equal(safeEntryName(bad), null, bad);
});

test('a normal archive extracts, compose found in a single top directory', withTmp(async (dir) => {
  const n = await extract(dir, [
    { name: 'app/', mode: 0o040755 },
    { name: 'app/docker-compose.yml', data: Buffer.from('services:\n  a:\n    image: nginx\n') },
    { name: 'app/conf/nginx.conf', data: Buffer.from('x') },
  ]);
  assert.equal(n, 2);
  assert.deepEqual(findComposeRoot(path.join(dir, 'out')), { root: 'app', file: 'docker-compose.yml' });
}));

test('traversal and absolute names are refused', withTmp(async (dir) => {
  await assert.rejects(extract(dir, [{ name: '../evil.txt', data: Buffer.from('x') }]), (e: { code?: string }) => e.code === 'zipInvalid');
  assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')));
}));

test('symbolic links are refused', withTmp(async (dir) => {
  await assert.rejects(extract(dir, [{ name: 'link', data: Buffer.from('/etc/passwd'), mode: 0o120777 }]), (e: { code?: string; message: string }) => e.code === 'zipInvalid' && /Symbolic/.test(e.message));
}));

test('zip bomb: the real expanded bytes are counted, whatever the header says', withTmp(async (dir) => {
  const bomb = Buffer.alloc(3 << 20, 0x41);
  await assert.rejects(extract(dir, [{ name: 'bomb.txt', data: bomb, lieSize: 10 }]), (e: { code?: string }) => e.code === 'zipTooLarge' || e.code === 'zipInvalid');
  const sub = path.join(dir, 'second');
  fs.mkdirSync(sub);
  await assert.rejects(extract(sub, [{ name: 'a.txt', data: Buffer.alloc(600_000) }, { name: 'b.txt', data: Buffer.alloc(600_000) }]),
    (e: { code?: string }) => e.code === 'zipTooLarge');
}));

test('duplicate entries never overwrite through an existing path', withTmp(async (dir) => {
  await assert.rejects(extract(dir, [{ name: 'a.txt', data: Buffer.from('1') }, { name: 'a.txt', data: Buffer.from('2') }]));
}));

test('upload spool: compressed limit → 413', withTmp(async (dir) => {
  await assert.rejects(spoolUpload(Readable.from([Buffer.alloc(2000)]), path.join(dir, 'x.zip'), 1000), (e: { code?: string }) => e.code === 'zipTooLarge');
  assert.equal(await spoolUpload(Readable.from([Buffer.alloc(500)]), path.join(dir, 'y.zip'), 1000), 500);
}));

test('garbage is not a ZIP', withTmp(async (dir) => {
  const file = path.join(dir, 'g.zip');
  fs.writeFileSync(file, 'not a zip');
  await assert.rejects(extractZip(file, path.join(dir, 'out'), limits), (e: { code?: string }) => e.code === 'zipInvalid');
}));
