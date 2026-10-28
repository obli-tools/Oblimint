import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { EMPTY_TREE, runGit } from './git';
import {
  clearStaleGitLocks, commitStaging, diffNameStatus, diffNumstat, diffStats, filePatch, headCommit, initBareRepo, lsTree, parseNameStatus,
  parseNumstat, parsePorcelain, parseRawZ, scanStaging, snapshotStagingCommit, stagingChanges, stagingDiffAgainst, stagingMatchesCommit, treesOf, writeExclude,
} from './repo';
import { tempDir, writeFiles } from './testUtil';

// Real git in temp dirs (docs/P1-PLAN.md §16): commit with exclusions, stats,
// nested repositories, diff / status parsing.

const author = { name: 'Alice <evil>\nX', email: 'alice@oblimint.local' };

async function setup(files: Record<string, string | Buffer>) {
  const root = tempDir('repo');
  const repo = `${root}/repo.git`;
  const staging = `${root}/staging`;
  fs.mkdirSync(staging);
  writeFiles(staging, files);
  assert.equal(await initBareRepo(repo), true);
  assert.equal(await initBareRepo(repo), false, 'idempotent');
  return { root, repo, staging };
}

async function commit(repo: string, staging: string, dataPaths: string[] = [], message = 'm') {
  const scan = scanStaging(staging, dataPaths);
  return commitStaging({ repoDir: repo, stagingDir: staging, dataPaths, nestedRepos: scan.nestedRepos, message, author });
}

test('commit excludes data paths and the staging .git, author sanitized, committer = panel', async () => {
  const { repo, staging } = await setup({
    'index.php': '<?php echo 1;',
    'wp-content/themes/t/style.css': 'body{}',
    'wp-content/uploads/2024/a.jpg': 'JPEG',
    '.git/config': '[core]',
  });
  assert.equal(await headCommit(repo), null);
  const sha = await commit(repo, staging, ['wp-content/uploads'], 'First');
  assert.match(sha, /^[0-9a-f]{40}$/);
  const paths = (await lsTree(repo, sha)).map((e) => e.path).sort();
  assert.deepEqual(paths, ['index.php', 'wp-content/themes/t/style.css']);
  const meta = (await runGit(['log', '-1', '--format=%an|%ae|%cn|%ce|%B', sha], { gitDir: repo })).stdout.toString();
  assert.equal(meta.trim(), 'Alice evilX|alice@oblimint.local|Oblimint|publish@oblimint.local|First');
  assert.match(fs.readFileSync(`${repo}/info/exclude`, 'utf8'), /^\/wp-content\/uploads$/m);
  assert.equal(fs.existsSync(`${repo}/hooks`), false);
});

test('a path that becomes a data path is untracked at the next commit', async () => {
  const { repo, staging } = await setup({ 'a.txt': 'a', 'files/x.txt': 'x' });
  const c1 = await commit(repo, staging);
  const c2 = await commit(repo, staging, ['files']);
  assert.deepEqual((await lsTree(repo, c2)).map((e) => e.path), ['a.txt']);
  const st = await diffStats(repo, c1, c2);
  assert.deepEqual({ a: st.added, m: st.modified, d: st.deleted }, { a: 0, m: 0, d: 1 });
});

test('stats against the empty tree and the previous commit', async () => {
  const { repo, staging } = await setup({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
  const c1 = await commit(repo, staging);
  const s1 = await diffStats(repo, null, c1);
  assert.deepEqual({ a: s1.added, m: s1.modified, d: s1.deleted }, { a: 3, m: 0, d: 0 });
  fs.writeFileSync(`${staging}/a.txt`, 'A2');
  fs.rmSync(`${staging}/b.txt`);
  writeFiles(staging, { 'd/e.txt': 'e' });
  const c2 = await commit(repo, staging);
  const s2 = await diffStats(repo, c1, c2);
  assert.deepEqual({ a: s2.added, m: s2.modified, d: s2.deleted }, { a: 1, m: 1, d: 1 });
  assert.deepEqual(s2.changed.sort(), ['a.txt', 'd/e.txt']);
  // Empty commit (no change) is allowed.
  const c3 = await commit(repo, staging);
  assert.notEqual(c3, c2);
  assert.equal((await diffStats(repo, c2, c3)).changed.length, 0);
});

test('nested repositories are detected and excluded (with their whole directory)', async () => {
  const { repo, staging } = await setup({ 'index.html': 'hi', 'vendor/lib/.git/HEAD': 'ref', 'vendor/lib/x.php': 'x', 'vendor/ok.php': 'ok' });
  const scan = scanStaging(staging, []);
  assert.deepEqual(scan.nestedRepos, ['vendor/lib']);
  assert.equal(scan.fileCount, 2);
  const sha = await commit(repo, staging);
  assert.deepEqual((await lsTree(repo, sha)).map((e) => e.path).sort(), ['index.html', 'vendor/ok.php']);
});

test('tenant .gitattributes cannot rewrite content (attributes read from the empty tree)', async () => {
  const crlf = 'line1\r\nline2\r\n';
  const { repo, staging } = await setup({ '.gitattributes': '* text=auto eol=lf\n*.txt filter=evil\n', 'win.txt': crlf });
  const sha = await commit(repo, staging);
  const blob = (await runGit(['cat-file', 'blob', `${sha}:win.txt`], { gitDir: repo })).stdout.toString();
  assert.equal(blob, crlf);
});

test('scanStaging counts regular files only, skips data paths, empty when absent', () => {
  const root = tempDir('scan');
  writeFiles(root, { 'a/b/c.txt': 'c', 'up/x.jpg': 'x' });
  fs.mkdirSync(`${root}/emptydir`);
  assert.equal(scanStaging(root, ['up']).fileCount, 1);
  assert.equal(scanStaging(`${root}/missing`, []).fileCount, 0);
  assert.equal(scanStaging(`${root}/emptydir`, []).fileCount, 0);
});

test('name-status / numstat parsing: renames, binary, deletions', async () => {
  const big = Array.from({ length: 50 }, (_, i) => `line ${i} of a file long enough to be detected as a rename`).join('\n');
  const { repo, staging } = await setup({ 'old/name.txt': big, 'bin.dat': Buffer.from([0, 1, 2, 3, 0, 255]), 'gone.txt': 'bye\n', 'mod.txt': 'a\nb\n' });
  const c1 = await commit(repo, staging);
  fs.mkdirSync(`${staging}/new`);
  fs.renameSync(`${staging}/old/name.txt`, `${staging}/new/name with space.txt`);
  fs.writeFileSync(`${staging}/bin.dat`, Buffer.from([0, 9, 9, 9, 0, 1]));
  fs.rmSync(`${staging}/gone.txt`);
  fs.writeFileSync(`${staging}/mod.txt`, 'a\nB\nc\n');
  const c2 = await commit(repo, staging);

  const ns = await diffNameStatus(repo, c1, c2, true);
  const byPath = new Map(ns.map((e) => [e.path, e]));
  assert.deepEqual(byPath.get('new/name with space.txt'), { status: 'renamed', path: 'new/name with space.txt', oldPath: 'old/name.txt' });
  assert.equal(byPath.get('gone.txt')?.status, 'deleted');
  assert.equal(byPath.get('mod.txt')?.status, 'modified');
  assert.equal(byPath.get('bin.dat')?.status, 'modified');

  const num = new Map((await diffNumstat(repo, c1, c2)).map((e) => [e.path, e]));
  assert.deepEqual(num.get('new/name with space.txt'), { path: 'new/name with space.txt', oldPath: 'old/name.txt', additions: 0, deletions: 0, binary: false });
  assert.equal(num.get('bin.dat')?.binary, true);
  assert.deepEqual([num.get('mod.txt')?.additions, num.get('mod.txt')?.deletions], [2, 1]);
  assert.deepEqual([num.get('gone.txt')?.additions, num.get('gone.txt')?.deletions], [0, 1]);

  const p = await filePatch(repo, c1, c2, 'mod.txt', null, 1 << 20);
  assert.match(p.patch, /^\+B$/m);
  assert.equal(p.truncated, false);
  const small = await filePatch(repo, c1, c2, 'mod.txt', null, 20);
  assert.equal(small.truncated, true);
  assert.equal(small.patch.length, 20);

  const fromEmpty = await diffNameStatus(repo, EMPTY_TREE, c1, true);
  assert.equal(fromEmpty.every((e) => e.status === 'added'), true);
});

test('pure parsers handle the -z formats', () => {
  assert.deepEqual(parseNameStatus('M\0a\0R087\0o\0n\0D\0d\0A\0x y\0T\0t\0'), [
    { status: 'modified', path: 'a', oldPath: null },
    { status: 'renamed', path: 'n', oldPath: 'o' },
    { status: 'deleted', path: 'd', oldPath: null },
    { status: 'added', path: 'x y', oldPath: null },
    { status: 'typechange', path: 't', oldPath: null },
  ]);
  assert.deepEqual(parseNumstat('1\t2\ta\0-\t-\tb.bin\0' + '3\t0\t\0o\0n\0'), [
    { path: 'a', oldPath: null, additions: 1, deletions: 2, binary: false },
    { path: 'b.bin', oldPath: null, additions: 0, deletions: 0, binary: true },
    { path: 'n', oldPath: 'o', additions: 3, deletions: 0, binary: false },
  ]);
  assert.deepEqual(parsePorcelain(' M a\0?? new file\0D  gone\0R  n\0o\0A  added\0'), [
    { path: 'a', status: 'modified' },
    { path: 'new file', status: 'added' },
    { path: 'gone', status: 'deleted' },
    { path: 'n', status: 'renamed' },
    { path: 'added', status: 'added' },
  ]);
});

test('staging status vs HEAD, data paths excluded, publication index untouched', async () => {
  const { root, repo, staging } = await setup({ 'a.txt': 'a', 'b.txt': 'b', 'up/x.jpg': 'x' });
  // Before any commit: everything is pending (data path excluded).
  let changes = await stagingChanges(repo, staging, ['up'], [], path.join(root, 'tmp.index'));
  assert.deepEqual(changes.map((c) => `${c.status}:${c.path}`).sort(), ['added:a.txt', 'added:b.txt']);
  await commit(repo, staging, ['up']);
  const indexBefore = fs.readFileSync(`${repo}/index`);
  fs.writeFileSync(`${staging}/a.txt`, 'A');
  fs.rmSync(`${staging}/b.txt`);
  writeFiles(staging, { 'sub/c.txt': 'c', 'up/y.jpg': 'y' });
  changes = await stagingChanges(repo, staging, ['up'], [], path.join(root, 'tmp2.index'));
  assert.deepEqual(changes.map((c) => `${c.status}:${c.path}`).sort(), ['added:sub/c.txt', 'deleted:b.txt', 'modified:a.txt']);
  assert.deepEqual(fs.readFileSync(`${repo}/index`), indexBefore);
  assert.equal(fs.existsSync(path.join(root, 'tmp2.index')), false);
});

test('stale git locks (killed git) are removed and the next commit succeeds', async () => {
  const { repo, staging } = await setup({ 'a.txt': 'a' });
  await commit(repo, staging);
  fs.writeFileSync(`${repo}/index.lock`, '');
  fs.mkdirSync(`${repo}/refs/heads`, { recursive: true });
  fs.writeFileSync(`${repo}/refs/heads/main.lock`, '');
  fs.writeFileSync(`${repo}/info/exclude.123.abcd.tmp`, '');
  writeFiles(staging, { 'b.txt': 'b' });
  await assert.rejects(commit(repo, staging), (e: Error & { stderr?: string }) => /index\.lock/.test(e.stderr ?? ''));
  assert.deepEqual(clearStaleGitLocks(repo).sort(), ['index.lock', 'info/exclude.123.abcd.tmp', 'refs/heads/main.lock']);
  const sha = await commit(repo, staging);
  assert.equal(await headCommit(repo), sha);
  assert.deepEqual(clearStaleGitLocks(repo), []);
});

test('writeExclude replaces info/exclude atomically (no temp file left)', async () => {
  const { repo } = await setup({});
  writeExclude(repo, ['up'], ['vendor/x']);
  assert.deepEqual(fs.readdirSync(`${repo}/info`), ['exclude']);
  assert.deepEqual(fs.readFileSync(`${repo}/info/exclude`, 'utf8').split('\n').slice(1, 4), ['/.git/', '/up', '/vendor/x']);
});

test('stagingMatchesCommit: same tree → true, commit rules (data paths, empty dirs); HEAD and index never move', async () => {
  const { root, repo, staging } = await setup({ 'a.txt': 'a', 'up/x.jpg': 'x', 'new/n.txt': 'n' });
  const c1 = await commit(repo, staging, ['up']);
  let i = 0;
  const match = (dataPaths: string[]) => stagingMatchesCommit({
    repoDir: repo, stagingDir: staging, dataPaths, nestedRepos: scanStaging(staging, dataPaths).nestedRepos, commit: c1,
    tmpIndex: path.join(root, `same-${++i}.index`),
  });
  const indexBefore = fs.readFileSync(`${repo}/index`);
  assert.equal(await match(['up']), true, 'unchanged staging');
  writeFiles(staging, { 'up/y.jpg': 'y' });
  assert.equal(await match(['up']), true, 'a change inside a data path is not a release change');
  fs.writeFileSync(`${staging}/a.txt`, 'A');
  assert.equal(await match(['up']), false, 'modified file');
  fs.writeFileSync(`${staging}/a.txt`, 'a');
  assert.equal(await match(['up']), true, 'reverted');
  assert.equal(await match(['up', 'new']), false, 'a committed path that became a data path leaves the tree');
  fs.mkdirSync(`${staging}/empty-dir`);
  assert.equal(await match(['up']), true, 'git does not version empty directories');
  fs.rmSync(`${staging}/new/n.txt`);
  assert.equal(await match(['up']), false, 'deleted file');
  assert.equal(await headCommit(repo), c1, 'HEAD unchanged');
  assert.deepEqual(fs.readFileSync(`${repo}/index`), indexBefore, 'publication index untouched');
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('same-')), [], 'temp indexes removed');
});

// ── Feature A: staging vs a commit, trees, snapshots ──

const diffOf = async (repo: string, staging: string, root: string, commitSha: string, dataPaths: string[] = []) => {
  const scan = scanStaging(staging, dataPaths);
  return stagingDiffAgainst({
    repoDir: repo, stagingDir: staging, dataPaths, nestedRepos: scan.nestedRepos, commit: commitSha,
    tmpIndex: path.join(root, `diff-${Math.random().toString(36).slice(2)}.index`),
  });
};
const statusMap = (entries: Array<{ path: string; status: string }>) => Object.fromEntries(entries.map((e) => [e.path, e.status]));

test('parseRawZ: modes, statuses, paths with spaces', () => {
  const z = ':100644 100755 aaa bbb M\0run sh\0:000000 100644 000 ccc A\0new.txt\0:160000 000000 ddd 000 D\0sub\0';
  assert.deepEqual(parseRawZ(z), [
    { path: 'run sh', status: 'modified', oldMode: '100644', newMode: '100755' },
    { path: 'new.txt', status: 'added', oldMode: '000000', newMode: '100644' },
    { path: 'sub', status: 'deleted', oldMode: '160000', newMode: '000000' },
  ]);
});

test('stagingDiffAgainst: compares with the given commit, never HEAD (staging = an older commit → no entry)', async () => {
  const { root, repo, staging } = await setup({ 'a.txt': 'a1', 'b.txt': 'b' });
  const c1 = await commit(repo, staging);
  fs.writeFileSync(`${staging}/a.txt`, 'a2');
  const c2 = await commit(repo, staging);
  assert.equal(await headCommit(repo), c2);
  fs.writeFileSync(`${staging}/a.txt`, 'a1');
  // `git status` (stagingChanges) compares with HEAD: one change; against c1: nothing (A3).
  assert.equal((await stagingChanges(repo, staging, [], [], path.join(root, 'st.index'))).length, 1);
  const r1 = await diffOf(repo, staging, root, c1);
  assert.deepEqual(r1.entries, []);
  const [t1] = await treesOf(repo, [c1]);
  assert.equal(r1.tree, t1, 'the tree a publication would commit');
  assert.deepEqual(statusMap((await diffOf(repo, staging, root, c2)).entries), { 'a.txt': 'modified' });
  // Added / deleted, data paths and nested repositories never listed.
  writeFiles(staging, { 'new.txt': 'n', 'uploads/u.jpg': 'J', 'vendor/lib/.git/config': '[core]', 'vendor/lib/x.php': 'x' });
  fs.rmSync(`${staging}/b.txt`);
  assert.deepEqual(statusMap((await diffOf(repo, staging, root, c1, ['uploads'])).entries), { 'b.txt': 'deleted', 'new.txt': 'added' });
  assert.equal(fs.existsSync(path.join(root, 'st.index')), false, 'throw-away indexes removed');
});

test('stagingDiffAgainst: a path become a data path and a gitlink of the commit are filtered (never deleted)', async () => {
  const { root, repo, staging } = await setup({ 'a.txt': 'a', 'cache/old.txt': 'o' });
  await commit(repo, staging);
  // A gitlink (160000) in the commit, absent from the staging.
  const head = (await headCommit(repo)) as string;
  await runGit(['update-index', '--add', '--cacheinfo', `160000,${head},sub`], { gitDir: repo, workTree: staging });
  await runGit(['commit', '-q', '--no-verify', '-m', 'gitlink'], {
    gitDir: repo, workTree: staging, env: { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  const withLink = (await headCommit(repo)) as string;
  assert.ok((await lsTree(repo, withLink)).some((e) => e.mode === '160000'));
  const r = await diffOf(repo, staging, root, withLink, ['cache']);
  assert.deepEqual(r.entries, [], 'cache/old.txt (data path) and sub (gitlink) are not listed');
});

test('treesOf: same order and length, null for null / non-hex / missing', async () => {
  const { repo, staging } = await setup({ 'a.txt': 'a' });
  const c1 = await commit(repo, staging);
  fs.writeFileSync(`${staging}/a.txt`, 'b');
  const c2 = await commit(repo, staging);
  const out = await treesOf(repo, [c1, null, 'zzz', '0'.repeat(40), undefined, c2]);
  assert.equal(out.length, 6);
  assert.match(out[0] as string, /^[0-9a-f]{40}$/);
  assert.deepEqual(out.slice(1, 5), [null, null, null, null]);
  assert.match(out[5] as string, /^[0-9a-f]{40}$/);
  assert.notEqual(out[0], out[5]);
  assert.deepEqual(await treesOf(repo, [null]), [null], 'no git call needed');
});

test('snapshotStagingCommit: HEAD moves on the staging tree; the backup ref is chained (two parents); same tree → null', async () => {
  const { root, repo, staging } = await setup({ 'a.txt': 'a' });
  const c1 = await commit(repo, staging);
  fs.writeFileSync(`${staging}/a.txt`, 'pending 1');
  const t1 = (await diffOf(repo, staging, root, c1)).tree;
  const REF = 'refs/oblimint/staging-before-restore' as const;
  const b1 = await snapshotStagingCommit({ repoDir: repo, ref: REF, tree: t1, message: 'before restore 1', author });
  assert.match(b1 as string, /^[0-9a-f]{40}$/);
  assert.equal(await headCommit(repo), c1, 'the backup ref never moves HEAD');
  const parents = async (ref: string) => (await runGit(['rev-list', '--parents', '-n', '1', ref], { gitDir: repo })).stdout.toString().trim().split(' ').slice(1);
  assert.deepEqual(await parents(REF), [c1]);
  fs.writeFileSync(`${staging}/a.txt`, 'pending 2');
  const t2 = (await diffOf(repo, staging, root, c1)).tree;
  const b2 = await snapshotStagingCommit({ repoDir: repo, ref: REF, tree: t2, message: 'before restore 2', author });
  assert.deepEqual(await parents(REF), [c1, b1 as string], 'chained: every copy stays reachable');
  assert.equal((await runGit(['show', `${b2}:a.txt`], { gitDir: repo })).stdout.toString(), 'pending 2');
  assert.equal((await runGit(['show', `${b1}:a.txt`], { gitDir: repo })).stdout.toString(), 'pending 1');
  // HEAD: parent = HEAD, then nothing to record for the same tree.
  const h = await snapshotStagingCommit({ repoDir: repo, ref: 'HEAD', tree: t2, message: 'restore', author });
  assert.equal(await headCommit(repo), h);
  assert.deepEqual(await parents('HEAD'), [c1]);
  assert.equal(await snapshotStagingCommit({ repoDir: repo, ref: 'HEAD', tree: t2, message: 'again', author }), null);
  assert.equal((await stagingChanges(repo, staging, [], [], path.join(root, 'st2.index'))).length, 0, 'pending changes now measured against the snapshot');
  // Compare-and-swap: a ref moved behind our back is never overwritten.
  await assert.rejects(runGit(['update-ref', REF, c1, (h as string)], { gitDir: repo }));
});
