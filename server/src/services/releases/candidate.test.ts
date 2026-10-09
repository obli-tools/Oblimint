import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { localContentTree, type ChangedPath } from '../maintenance/contracts';
import {
  blobOid, buildCandidate, classifyChanges, commitWholeTree, conflictsWithStaging, dropCandidateRef, fastForwardHead, fileDiffBetween,
  ignoreReasonOf, nestedRepoRoots, parentOf, writeBlob,
} from './candidate';
import { runGit } from './git';
import { commitStaging, headCommit, initBareRepo, lsTree } from './repo';
import { canSymlink, tempDir, writeFiles } from './testUtil';

// ─────────────────────────────────────────────────────────────────────────────
// Candidate commits against REAL git in a temp dir (docs/P3-PLAN.md §15):
// change lists (adds / modifies / deletes / symlinks / dir ↔ file), ignore
// rules (data paths, nested .git, .sftpgo-upload.*, invalid, tooLarge),
// whole-tree commits (adapters), one-file diffs, staging conflicts, refs,
// HEAD fast-forward. Symlink cases are skipped without the privilege.
// ─────────────────────────────────────────────────────────────────────────────

const AUTHOR = { name: 'window #1', email: 'window-1@oblimint.local' };

async function setup(files: Record<string, string>, dataPaths: string[] = []) {
  const root = tempDir('cand');
  const repo = `${root}/repo.git`;
  const staging = `${root}/staging`;
  fs.mkdirSync(staging, { recursive: true });
  writeFiles(staging, files);
  await initBareRepo(repo);
  const base = await commitStaging({ repoDir: repo, stagingDir: staging, dataPaths, nestedRepos: [], message: 'base', author: { name: 't', email: 't@t' } });
  const exp = `${root}/export`;
  fs.mkdirSync(exp, { recursive: true });
  return { root, repo, staging, base, exp };
}

async function show(repo: string, commit: string, rel: string): Promise<string | null> {
  const r = await runGit(['cat-file', '-p', `${commit}:${rel}`], { gitDir: repo, okCodes: [128] });
  return r.code === 0 ? r.stdout.toString('utf8') : null;
}

const ch = (p: string, change: ChangedPath['change'], type: ChangedPath['type'] = 'file', extra: Partial<ChangedPath> = {}): ChangedPath =>
  ({ path: p, change, type, size: null, ...extra });

test('ignore rules: data paths, nested repos, temp uploads, invalid paths, hostd skips', () => {
  const roots = nestedRepoRoots(['wp-content/plugins/x/.git/HEAD', 'a.php', '.git/config']);
  assert.deepEqual([...roots].sort(), ['', 'wp-content/plugins/x']);
  const dp = ['wp-content/uploads', 'cache'];
  const cases: Array<[string, 'tooLarge' | 'special' | null, string | null]> = [
    ['index.php', null, null],
    ['wp-content/uploads', null, 'dataPath'],
    ['wp-content/uploads/x.php', null, 'dataPath'],
    ['wp-content/uploadsX/x.php', null, null],
    ['cache/a', null, 'dataPath'],
    ['wp-content/plugins/x/.git/HEAD', null, 'nestedRepo'],
    ['wp-content/plugins/x/main.php', null, 'nestedRepo'],
    ['.git/config', null, 'nestedRepo'],
    ['dir/.sftpgo-upload.123.tmp', null, 'special'],
    ['../etc/passwd', null, 'invalidPath'],
    ['a//b', null, 'invalidPath'],
    ['/abs', null, 'invalidPath'],
    ['big.zip', 'tooLarge', 'tooLarge'],
    ['fifo', 'special', 'special'],
  ];
  for (const [p, skipped, want] of cases) assert.equal(ignoreReasonOf({ path: p, skipped }, dp, roots), want, p);
  const classified = classifyChanges([{ ...ch('a.php', 'added'), ignored: 'tooLarge' }, ch('cache/x', 'added')], dp);
  assert.equal(classified[0].ignored, 'tooLarge', 'an existing reason is kept');
  assert.equal(classified[1].ignored, 'dataPath');
});

test('writeBlob writes loose objects git reads back (same id as git hash-object)', async () => {
  const { repo } = await setup({ 'a.txt': 'a' });
  const content = Buffer.from('hello\0world\n');
  const oid = writeBlob(repo, content);
  assert.equal(oid, blobOid(content));
  const r = await runGit(['hash-object', '--stdin'], { gitDir: repo, input: content });
  assert.equal(r.stdout.toString().trim(), oid);
  assert.deepEqual((await runGit(['cat-file', 'blob', oid], { gitDir: repo })).stdout, content);
  assert.equal(writeBlob(repo, content), oid, 'idempotent');
});

test('buildCandidate: adds, modifies, deletes (file + directory), exec bit, data paths excluded; HEAD untouched', async () => {
  const s = await setup({
    'index.php': '<?php echo 1;', 'wp-config.php': 'cfg', 'old/a.php': 'a', 'old/b/c.php': 'c', 'keep.txt': 'k',
  });
  const headBefore = await headCommit(s.repo);
  writeFiles(s.exp, {
    'index.php': '<?php echo 2;', 'wp-content/plugins/p/p.php': '<?php // plugin', 'bin/run.sh': '#!/bin/sh\n',
    'wp-content/uploads/evil.php': '<?php system($_GET[1]);',
  });
  const cand = await buildCandidate({
    repoDir: s.repo, baseCommit: s.base, tree: localContentTree(s.exp), dataPaths: ['wp-content/uploads'],
    message: 'Fenêtre #1', author: AUTHOR, refName: 'refs/oblimint/candidates/window-1',
    changes: [
      ch('index.php', 'modified'), ch('wp-content/plugins', 'added', 'dir'), ch('wp-content/plugins/p', 'added', 'dir'),
      ch('wp-content/plugins/p/p.php', 'added'), ch('bin/run.sh', 'added', 'file', { mode: 0o755 }),
      ch('wp-config.php', 'deleted'), ch('old', 'deleted', 'dir'), ch('wp-content/uploads/evil.php', 'added'),
    ],
  });
  assert.equal(cand.baseCommit, s.base);
  assert.equal(await parentOf(s.repo, cand.commit), s.base);
  assert.equal(await headCommit(s.repo), headBefore, 'HEAD untouched');
  const ref = (await runGit(['rev-parse', 'refs/oblimint/candidates/window-1'], { gitDir: s.repo })).stdout.toString().trim();
  assert.equal(ref, cand.commit);
  assert.equal(await show(s.repo, cand.commit, 'index.php'), '<?php echo 2;');
  assert.equal(await show(s.repo, cand.commit, 'wp-content/plugins/p/p.php'), '<?php // plugin');
  assert.equal(await show(s.repo, cand.commit, 'wp-config.php'), null);
  assert.equal(await show(s.repo, cand.commit, 'old/a.php'), null);
  assert.equal(await show(s.repo, cand.commit, 'old/b/c.php'), null, 'a deleted directory takes its subtree');
  assert.equal(await show(s.repo, cand.commit, 'keep.txt'), 'k');
  assert.equal(await show(s.repo, cand.commit, 'wp-content/uploads/evil.php'), null, 'data path never committed');
  const entries = await lsTree(s.repo, cand.commit);
  assert.equal(entries.find((e) => e.path === 'bin/run.sh')?.mode, '100755');
  assert.equal(entries.find((e) => e.path === 'index.php')?.mode, '100644');
  assert.deepEqual(cand.ignored, [{ path: 'wp-content/uploads/evil.php', reason: 'dataPath' }]);
  assert.deepEqual(cand.files.map((f) => `${f.change}:${f.path}`).sort(), [
    'added:bin/run.sh', 'added:wp-content/plugins/p/p.php', 'deleted:old/a.php', 'deleted:old/b/c.php', 'deleted:wp-config.php', 'modified:index.php',
  ]);
  assert.equal(cand.added, 2);
  assert.equal(cand.modified, 1);
  assert.equal(cand.deleted, 3);
  // Author = the window, committer = the panel.
  const meta = (await runGit(['log', '-1', '--format=%an|%ae|%cn|%s', cand.commit], { gitDir: s.repo })).stdout.toString().trim();
  assert.equal(meta, 'window #1|window-1@oblimint.local|Oblimint|Fenêtre #1');
});

test('buildCandidate: a file replacing a directory and a directory replacing a file; missing export content is ignored', async () => {
  const s = await setup({ 'x/y.txt': 'y', 'x/z/w.txt': 'w', 'f': 'file' });
  writeFiles(s.exp, { x: 'now a file', 'f/inner.txt': 'inner' });
  const cand = await buildCandidate({
    repoDir: s.repo, baseCommit: s.base, tree: localContentTree(s.exp), dataPaths: [], message: 'm', author: AUTHOR,
    refName: 'refs/oblimint/candidates/window-2',
    changes: [ch('x', 'typechange', 'file'), ch('f', 'typechange', 'dir'), ch('f/inner.txt', 'added'), ch('missing.php', 'added')],
  });
  assert.equal(await show(s.repo, cand.commit, 'x'), 'now a file');
  assert.equal(await show(s.repo, cand.commit, 'x/y.txt'), null);
  assert.equal(await show(s.repo, cand.commit, 'f/inner.txt'), 'inner');
  assert.deepEqual(cand.ignored, [{ path: 'missing.php', reason: 'special' }]);
});

test('buildCandidate: no effective change gives the base tree; refs are validated', async () => {
  const s = await setup({ 'a.txt': 'a' });
  writeFiles(s.exp, { 'a.txt': 'a' });
  const cand = await buildCandidate({
    repoDir: s.repo, baseCommit: s.base, tree: localContentTree(s.exp), dataPaths: [], message: 'm', author: AUTHOR,
    refName: 'refs/oblimint/candidates/window-3', changes: [ch('a.txt', 'modified')],
  });
  assert.deepEqual(cand.files, []);
  await assert.rejects(buildCandidate({
    repoDir: s.repo, baseCommit: s.base, tree: localContentTree(s.exp), dataPaths: [], message: 'm', author: AUTHOR,
    refName: 'refs/heads/main', changes: [],
  }), /invalid candidate ref/);
  await dropCandidateRef(s.repo, 'refs/oblimint/candidates/window-3');
  const r = await runGit(['rev-parse', '-q', '--verify', 'refs/oblimint/candidates/window-3'], { gitDir: s.repo, okCodes: [1] });
  assert.equal(r.code, 1);
});

test('buildCandidate: symlinks are committed as links (never followed)', async (t) => {
  if (!canSymlink()) { t.skip('symlinks unavailable on this box'); return; }
  const s = await setup({ 'a.txt': 'a' });
  fs.mkdirSync(`${s.exp}/d`, { recursive: true });
  fs.symlinkSync('../a.txt', path.join(s.exp, 'd', 'link'));
  fs.symlinkSync('/etc', path.join(s.exp, 'parentlink'));
  const cand = await buildCandidate({
    repoDir: s.repo, baseCommit: s.base, tree: localContentTree(s.exp), dataPaths: [], message: 'm', author: AUTHOR,
    refName: 'refs/oblimint/candidates/window-4',
    changes: [ch('d/link', 'added', 'symlink'), ch('parentlink/passwd', 'added', 'file')],
  });
  const e = (await lsTree(s.repo, cand.commit)).find((x) => x.path === 'd/link');
  assert.equal(e?.mode, '120000');
  assert.equal(await show(s.repo, cand.commit, 'd/link'), '../a.txt');
  assert.deepEqual(cand.ignored, [{ path: 'parentlink/passwd', reason: 'special' }], 'content behind a symlinked parent is never read');
});

test('commitWholeTree: whole workspace, data paths and nested repos excluded, temp uploads ignored', async () => {
  const s = await setup({ 'index.php': 'v1', 'composer.json': '{}', 'wp-content/uploads/a.jpg': 'J' }, ['wp-content/uploads']);
  const ws = `${s.root}/ws`;
  writeFiles(ws, {
    'index.php': 'v2', 'vendor/pkg/src/A.php': '<?php', 'wp-content/uploads/b.jpg': 'J2', 'vendor/nested/.git/HEAD': 'ref',
    'vendor/nested/x.php': 'x', 'tmp/.sftpgo-upload.1.part': 'p',
  });
  const cand = await commitWholeTree({
    repoDir: s.repo, baseCommit: s.base, workTree: ws, dataPaths: ['wp-content/uploads'], message: 'adapter',
    author: { name: 'adapter wordpress #1', email: 'adapter-1@oblimint.local' }, refName: 'refs/oblimint/candidates/adapter-1',
  });
  assert.deepEqual(cand.files.map((f) => `${f.change}:${f.path}`).sort(), ['added:vendor/pkg/src/A.php', 'deleted:composer.json', 'modified:index.php']);
  assert.deepEqual(cand.ignored, [{ path: 'vendor/nested', reason: 'nestedRepo' }]);
  assert.equal(await parentOf(s.repo, cand.commit), s.base);
});

test('fileDiffBetween: text patch, binary, sizes; conflictsWithStaging', async () => {
  const s = await setup({ 'a.txt': 'one\ntwo\n', 'img.bin': '\0\x01\x02', 'same.txt': 's', 'gone.txt': 'g' });
  writeFiles(s.exp, { 'a.txt': 'one\nTWO\n', 'img.bin': '\0\x01\x03\x04', 'new.txt': 'n' });
  const cand = await buildCandidate({
    repoDir: s.repo, baseCommit: s.base, tree: localContentTree(s.exp), dataPaths: [], message: 'm', author: AUTHOR,
    refName: 'refs/oblimint/candidates/window-5',
    changes: [ch('a.txt', 'modified'), ch('img.bin', 'modified'), ch('new.txt', 'added'), ch('gone.txt', 'deleted')],
  });
  const d = await fileDiffBetween(s.repo, s.base, cand.commit, 'a.txt', 64 * 1024);
  assert.equal(d.binary, false);
  assert.match(d.patch ?? '', /-two\n\+TWO/);
  assert.equal(d.oldSize, 8);
  assert.equal(d.newSize, 8);
  const b = await fileDiffBetween(s.repo, s.base, cand.commit, 'img.bin', 64 * 1024);
  assert.equal(b.binary, true);
  assert.equal(b.patch, null);
  const n = await fileDiffBetween(s.repo, s.base, cand.commit, 'new.txt', 64 * 1024);
  assert.equal(n.oldSize, null);
  assert.equal(n.newSize, 1);

  // Staging: unchanged since the base → no conflict; changed / deleted / created → conflict.
  assert.deepEqual(await conflictsWithStaging(s.repo, s.staging, s.base, ['a.txt', 'img.bin', 'new.txt', 'gone.txt', 'same.txt']), []);
  writeFiles(s.staging, { 'a.txt': 'edited in sftp', 'new.txt': 'also created in sftp' });
  fs.rmSync(`${s.staging}/gone.txt`);
  assert.deepEqual(await conflictsWithStaging(s.repo, s.staging, s.base, ['a.txt', 'img.bin', 'new.txt', 'gone.txt', 'same.txt', '../x']),
    ['a.txt', 'gone.txt', 'new.txt']);
});

test('fastForwardHead moves HEAD only from the expected parent', async () => {
  const s = await setup({ 'a.txt': 'a' });
  writeFiles(s.exp, { 'b.txt': 'b' });
  const cand = await buildCandidate({
    repoDir: s.repo, baseCommit: s.base, tree: localContentTree(s.exp), dataPaths: [], message: 'm', author: AUTHOR,
    refName: 'refs/oblimint/candidates/window-6', changes: [ch('b.txt', 'added')],
  });
  assert.equal(await fastForwardHead(s.repo, cand.commit, '0'.repeat(40)), false);
  assert.equal(await headCommit(s.repo), s.base);
  assert.equal(await fastForwardHead(s.repo, cand.commit, s.base), true);
  assert.equal(await headCommit(s.repo), cand.commit);
});

test('large files are streamed: same blob id as git, content intact, max blob honoured, staging conflicts hashed by chunks', async () => {
  const { STREAM_BLOB_BYTES } = await import('./candidate');
  const s = await setup({ 'index.php': '<?php echo 1;' });
  const big = Buffer.alloc(STREAM_BLOB_BYTES + 3 * 1024 * 1024 + 7);
  for (let i = 0; i < big.length; i += 4093) big[i] = i % 251;
  fs.mkdirSync(`${s.exp}/assets`, { recursive: true });
  fs.writeFileSync(`${s.exp}/assets/video.bin`, big);
  const cand = await buildCandidate({
    repoDir: s.repo, baseCommit: s.base, tree: localContentTree(s.exp), dataPaths: [],
    message: 'big', author: AUTHOR, refName: 'refs/oblimint/candidates/window-7', changes: [ch('assets/video.bin', 'added')],
  });
  assert.deepEqual(cand.ignored, []);
  const oid = (await runGit(['rev-parse', `${cand.commit}:assets/video.bin`], { gitDir: s.repo })).stdout.toString().trim();
  assert.equal(oid, blobOid(big));
  const back = (await runGit(['cat-file', 'blob', oid], { gitDir: s.repo, maxBuffer: 64 * 1024 * 1024 })).stdout;
  assert.ok(back.equals(big), 'content intact');
  assert.equal((await runGit(['fsck', '--no-dangling'], { gitDir: s.repo, okCodes: [0] })).code, 0);
  assert.deepEqual(fs.readdirSync(`${s.repo}/objects`).filter((n) => n.startsWith('tmp_obj_')), [], 'no temp file left');
  // Above maxBlobBytes: listed as tooLarge, never written.
  const small = await buildCandidate({
    repoDir: s.repo, baseCommit: s.base, tree: localContentTree(s.exp), dataPaths: [], maxBlobBytes: STREAM_BLOB_BYTES,
    message: 'big', author: AUTHOR, refName: 'refs/oblimint/candidates/window-8', changes: [ch('assets/video.bin', 'added')],
  });
  assert.deepEqual(small.ignored, [{ path: 'assets/video.bin', reason: 'tooLarge' }]);
  // Staging conflicts on a large file: streamed hash.
  fs.mkdirSync(`${s.staging}/assets`, { recursive: true });
  fs.writeFileSync(`${s.staging}/assets/video.bin`, big);
  assert.deepEqual(await conflictsWithStaging(s.repo, s.staging, cand.commit, ['assets/video.bin']), []);
  big[big.length - 1] ^= 0xff;
  fs.writeFileSync(`${s.staging}/assets/video.bin`, big);
  assert.deepEqual(await conflictsWithStaging(s.repo, s.staging, cand.commit, ['assets/video.bin']), ['assets/video.bin']);
});
