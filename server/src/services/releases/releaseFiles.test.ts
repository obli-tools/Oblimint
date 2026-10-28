import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { commitStaging, initBareRepo, scanStaging } from './repo';
import {
  __releaseTreeCache, cleanReleasePath, pageEntries, parseLsTreeLong, readReleaseBlob, releaseTree, streamReleaseBlob, toFileEntry, utf8SafeCut,
} from './releaseFiles';
import { commitSymlinkEntry, tempDir, writeFiles } from './testUtil';

// Files of a release read from git (Feature A): exact lookups, odd names,
// symlink entries, the tree cache budget, size-bounded pages.

const author = { name: 'T', email: 't@oblimint.local' };

async function repoWith(files: Record<string, string | Buffer>) {
  const root = tempDir('relfiles');
  const repo = `${root}/repo.git`;
  const staging = `${root}/staging`;
  fs.mkdirSync(staging);
  writeFiles(staging, files);
  await initBareRepo(repo);
  const commit = async () => commitStaging({ repoDir: repo, stagingDir: staging, dataPaths: [], nestedRepos: scanStaging(staging, []).nestedRepos, message: 'm', author });
  return { root, repo, staging, commit };
}

test('cleanReleasePath: root, slashes, backslashes, no character whitelist, .. / .git refused', () => {
  assert.equal(cleanReleasePath('/', true), '');
  assert.equal(cleanReleasePath('', true), '');
  assert.equal(cleanReleasePath(undefined, true), '');
  assert.equal(cleanReleasePath('/', false), null);
  assert.equal(cleanReleasePath('', false), null);
  assert.equal(cleanReleasePath(' /dir/a b.txt/ ', false), 'dir/a b.txt');
  assert.equal(cleanReleasePath('dir\\sub\\x#y~.php', false), 'dir/sub/x#y~.php');
  assert.equal(cleanReleasePath('café/é.txt', false), 'café/é.txt');
  assert.equal(cleanReleasePath('../x', false), null);
  assert.equal(cleanReleasePath('a//b', false), null);
  assert.equal(cleanReleasePath('a/.git/config', false), null);
  assert.equal(cleanReleasePath('a/.GIT/config', false), null);
  assert.equal(cleanReleasePath(42, false), null);
  assert.equal(cleanReleasePath('x'.repeat(4097), false), null);
});

test('releaseTree: names with space, accent, # and ~; exact lookup; sizes, executable', async () => {
  const s = await repoWith({ 'dir/a b.txt': 'hello', 'é.txt': 'é', 'x#y.php': '<?php', '~tmp': '', 'run.sh': '#!/bin/sh\n' });
  if (process.platform !== 'win32') fs.chmodSync(`${s.staging}/run.sh`, 0o755);
  const c = await s.commit();
  const tree = await releaseTree(s.repo, c);
  assert.deepEqual(tree.entries.map((e) => e.path).sort(), ['dir/a b.txt', 'run.sh', 'x#y.php', '~tmp', 'é.txt'].sort());
  const e = tree.byPath.get(cleanReleasePath('/dir/a b.txt', false) as string);
  assert.ok(e);
  assert.deepEqual(toFileEntry(e), { path: 'dir/a b.txt', type: 'file', size: 5, executable: false });
  if (process.platform !== 'win32') assert.equal(tree.byPath.get('run.sh')?.mode, '100755');
  assert.equal(tree.byPath.get('x#y.php')?.size, 5);
  assert.equal(tree.byPath.get('dir'), undefined, 'directories are never entries');
  const r = await readReleaseBlob(s.repo, tree.byPath.get('dir/a b.txt')!, { offset: 1, maxBytes: 3 });
  assert.equal(r.data.toString(), 'ell');
  assert.equal(r.truncated, true);
  const chunks: Buffer[] = [];
  const st = streamReleaseBlob(s.repo, tree.byPath.get('é.txt')!.sha);
  for await (const b of st.stream) chunks.push(b as Buffer);
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'é');
});

test('releaseTree: symlink entries (120000) are listed as symlinks, their content is the target', async () => {
  const s = await repoWith({ 'index.php': 'x' });
  await s.commit();
  const c = await commitSymlinkEntry(s.repo, s.staging, 'link', '../outside');
  const tree = await releaseTree(s.repo, c);
  const l = tree.byPath.get('link')!;
  assert.equal(l.type, 'symlink');
  assert.equal(l.mode, '120000');
  assert.equal((await readReleaseBlob(s.repo, l, { offset: 0, maxBytes: 100 })).data.toString(), '../outside');
});

test('parseLsTreeLong: gitlinks counted, unsafe paths and .git segments dropped', () => {
  const z = ['100644 blob aaaa      12\tok.txt', '160000 commit bbbb       -\tsub', '100644 blob cccc 3\ta/.git/x', '100644 blob dddd 3\t../evil', '120000 blob eeee 7\tl', ''].join('\0');
  const r = parseLsTreeLong(z);
  assert.equal(r.gitlinks, 1);
  assert.deepEqual(r.entries.map((e) => [e.path, e.type, e.size]), [['ok.txt', 'file', 12], ['l', 'symlink', 7]]);
});

test('the tree cache stays under its entry budget (least recently used evicted)', async () => {
  __releaseTreeCache.clear();
  __releaseTreeCache.setBudget(5);
  try {
    const s = await repoWith({ a: '1', b: '1', c: '1' });
    const c1 = await s.commit();
    fs.writeFileSync(`${s.staging}/d`, '1');
    const c2 = await s.commit();
    await releaseTree(s.repo, c1); // 3 entries
    await releaseTree(s.repo, c2); // 4 entries: 7 > 5 → c1 evicted
    assert.deepEqual(__releaseTreeCache.keys(), [`${s.repo}#${c2}`]);
    assert.equal(__releaseTreeCache.entries(), 4);
    await releaseTree(s.repo, c1); // c2 evicted in turn, the newest is always kept
    assert.deepEqual(__releaseTreeCache.keys(), [`${s.repo}#${c1}`]);
  } finally {
    __releaseTreeCache.setBudget(null);
    __releaseTreeCache.clear();
  }
});

test('pageEntries: maxChars stops the page, nextOffset continues it, 500 long paths stay valid JSON under 200 000 characters', () => {
  const all = Array.from({ length: 500 }, (_, i) => ({ path: `${'very-long-folder-name/'.repeat(40)}file-${i}.php`, type: 'file', size: i, executable: false }));
  const first = pageEntries(all, 0, 500, 150_000);
  assert.ok(first.page.length > 0 && first.page.length < 500);
  assert.equal(first.nextOffset, first.page.length);
  const json = JSON.stringify({ entries: first.page, nextOffset: first.nextOffset }, null, 2);
  assert.ok(json.length < 200_000, `${json.length}`);
  assert.doesNotThrow(() => JSON.parse(json));
  let offset = 0;
  let seen = 0;
  for (let guard = 0; guard < 100; guard++) {
    const p = pageEntries(all, offset, 500, 150_000);
    seen += p.page.length;
    if (p.nextOffset === null) break;
    assert.equal(p.nextOffset, offset + p.page.length);
    offset = p.nextOffset;
  }
  assert.equal(seen, 500, 'every entry once');
  assert.deepEqual(pageEntries(all, 0, 2).page.length, 2);
  assert.equal(pageEntries(all, 499, 10).nextOffset, null);
  assert.equal(pageEntries([{ huge: 'x'.repeat(10) }], 0, 10, 1).page.length, 1, 'at least one entry');
});

test('utf8SafeCut: a window never ends inside a character', () => {
  const b = Buffer.from('aé€😀', 'utf8'); // 1 + 2 + 3 + 4 bytes
  assert.equal(utf8SafeCut(b).toString('utf8'), 'aé€😀');
  assert.equal(utf8SafeCut(b.subarray(0, 2)).toString('utf8'), 'a');
  assert.equal(utf8SafeCut(b.subarray(0, 5)).toString('utf8'), 'aé');
  assert.equal(utf8SafeCut(b.subarray(0, 8)).toString('utf8'), 'aé€');
  assert.equal(utf8SafeCut(b.subarray(0, 10)).toString('utf8'), 'aé€😀');
});

test('streamReleaseBlob: a spawn failure reaches the stream as an error (never an uncaught child error)', async () => {
  const { config } = await import('../../config');
  const prev = config.hosting.gitBinary;
  config.hosting.gitBinary = `${tempDir('nogit')}/missing-git-binary`;
  try {
    const st = streamReleaseBlob(tempDir('norepo'), 'a'.repeat(40));
    const err = await new Promise<Error | null>((resolve) => {
      st.stream.on('error', (e) => resolve(e));
      st.stream.on('end', () => resolve(null));
      st.stream.resume();
    });
    assert.ok(err, 'the stream errors');
    assert.equal(err?.name, 'GitError');
    st.kill(); // no throw on a child that never started
  } finally {
    config.hosting.gitBinary = prev;
  }
});
