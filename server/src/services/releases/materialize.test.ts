import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { commitStaging, initBareRepo, scanStaging } from './repo';
import {
  createDataLinks, dataLinksMatch, materializeRelease, MaterializeError, readCurrent, realLinkOps, removeTmpEntries, removeUnder, switchCurrent,
} from './materialize';
import { canSymlink, commitSymlinkEntry, emulatedLinkOps, tempDir, writeFiles } from './testUtil';

// Release trees: content, modes, hardlink reuse (R3), symlink entries never
// followed, data links with parent checks (R1), atomic `current` switch.
// Tests needing real symlinks are SKIPPED when this box cannot create them
// (Windows without developer mode) — never reported green.

const author = { name: 't', email: 't@oblimint.local' };
const SYMLINK_SKIP = canSymlink() ? false : 'symlinks unavailable on this box (EPERM)';

async function site(files: Record<string, string | Buffer>) {
  const root = tempDir('mat');
  const repo = `${root}/repo.git`;
  const staging = `${root}/staging`;
  const releases = `${root}/releases`;
  fs.mkdirSync(staging);
  fs.mkdirSync(releases);
  writeFiles(staging, files);
  await initBareRepo(repo);
  const commit = (dataPaths: string[] = []) => commitStaging({
    repoDir: repo, stagingDir: staging, dataPaths, nestedRepos: scanStaging(staging, dataPaths).nestedRepos, message: 'm', author,
  });
  return { root, repo, staging, releases, commit };
}

const ino = (p: string): bigint => fs.statSync(p, { bigint: true }).ino;

test('materialize: content equality, nested dirs, binary, empty file, .tmp renamed', async () => {
  const bin = Buffer.alloc(300_000);
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 7) % 256;
  const s = await site({ 'index.php': '<?php echo "x";', 'a/b/c/deep.txt': 'deep', 'img/big.bin': bin, 'empty.txt': '', 'dup1.txt': 'same', 'dup2.txt': 'same' });
  const c1 = await s.commit();
  const res = await materializeRelease({ repoDir: s.repo, releasesDir: s.releases, number: 1, commit: c1, dataPaths: [], base: null, links: emulatedLinkOps() });
  assert.equal(res.files, 6);
  const dir = `${s.releases}/1`;
  assert.equal(fs.existsSync(`${dir}.tmp`), false);
  assert.equal(fs.readFileSync(`${dir}/index.php`, 'utf8'), '<?php echo "x";');
  assert.equal(fs.readFileSync(`${dir}/a/b/c/deep.txt`, 'utf8'), 'deep');
  assert.deepEqual(fs.readFileSync(`${dir}/img/big.bin`), bin);
  assert.equal(fs.readFileSync(`${dir}/empty.txt`, 'utf8'), '');
  assert.equal(fs.readFileSync(`${dir}/dup2.txt`, 'utf8'), 'same');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(`${dir}/index.php`).mode & 0o777, 0o644);
    assert.equal(fs.statSync(`${dir}/a/b`).mode & 0o777, 0o755);
  }
});

test('materialize: the executable bit is kept (0755), other files 0644, same content with both modes', { skip: process.platform === 'win32' ? 'POSIX modes only' : false }, async () => {
  const s = await site({ 'run.sh': '#!/bin/sh\n', 'copy.sh': '#!/bin/sh\n', 'plain.txt': 'x' });
  fs.chmodSync(`${s.staging}/run.sh`, 0o755);
  const c1 = await s.commit();
  await materializeRelease({ repoDir: s.repo, releasesDir: s.releases, number: 1, commit: c1, dataPaths: [], base: null });
  assert.equal(fs.statSync(`${s.releases}/1/run.sh`).mode & 0o777, 0o755);
  assert.equal(fs.statSync(`${s.releases}/1/copy.sh`).mode & 0o777, 0o644, 'same blob, not executable: a copy, not a hardlink');
  assert.equal(fs.statSync(`${s.releases}/1/plain.txt`).mode & 0o777, 0o644);
  // Hardlinked from the base only with the same mode; the base tree is never modified.
  fs.chmodSync(`${s.staging}/run.sh`, 0o644);
  const c2 = await s.commit();
  await materializeRelease({ repoDir: s.repo, releasesDir: s.releases, number: 2, commit: c2, dataPaths: [], base: { number: 1, commit: c1 } });
  assert.equal(fs.statSync(`${s.releases}/2/run.sh`).mode & 0o777, 0o644);
  assert.equal(fs.statSync(`${s.releases}/1/run.sh`).mode & 0o777, 0o755);
});

test('materialize: unchanged blobs are hardlinked to the base release, changed ones are fresh', async () => {
  const s = await site({ 'same.txt': 'unchanged', 'changed.txt': 'v1', 'moved.txt': 'mv' });
  const c1 = await s.commit();
  const links = emulatedLinkOps();
  await materializeRelease({ repoDir: s.repo, releasesDir: s.releases, number: 1, commit: c1, dataPaths: [], base: null, links });
  fs.writeFileSync(`${s.staging}/changed.txt`, 'v2');
  fs.mkdirSync(`${s.staging}/sub`);
  fs.renameSync(`${s.staging}/moved.txt`, `${s.staging}/sub/moved.txt`);
  const c2 = await s.commit();
  const res = await materializeRelease({ repoDir: s.repo, releasesDir: s.releases, number: 2, commit: c2, dataPaths: [], base: { number: 1, commit: c1 }, links });
  assert.equal(res.linked, 1);
  assert.equal(ino(`${s.releases}/2/same.txt`), ino(`${s.releases}/1/same.txt`));
  assert.notEqual(ino(`${s.releases}/2/changed.txt`), ino(`${s.releases}/1/changed.txt`));
  assert.equal(fs.readFileSync(`${s.releases}/1/changed.txt`, 'utf8'), 'v1', 'R3: the old release is untouched');
  assert.equal(fs.readFileSync(`${s.releases}/2/changed.txt`, 'utf8'), 'v2');
  assert.equal(fs.readFileSync(`${s.releases}/2/sub/moved.txt`, 'utf8'), 'mv');
  // Re-materializing an existing number replaces it (a pruned release brought back).
  await materializeRelease({ repoDir: s.repo, releasesDir: s.releases, number: 2, commit: c2, dataPaths: [], base: null, links });
  assert.equal(fs.readFileSync(`${s.releases}/2/changed.txt`, 'utf8'), 'v2');
});

test('materialize: git symlink entries become links with the stored target (emulated: never resolved)', async () => {
  const s = await site({ 'index.html': 'hi' });
  await s.commit();
  const c2 = await commitSymlinkEntry(s.repo, s.staging, 'evil', '/etc/passwd');
  const links = emulatedLinkOps();
  const res = await materializeRelease({ repoDir: s.repo, releasesDir: s.releases, number: 1, commit: c2, dataPaths: [], base: null, links });
  assert.equal(res.symlinks, 1);
  assert.deepEqual(links.created.map((c) => c.target), ['/etc/passwd']);
  assert.equal(links.readlink(`${s.releases}/1/evil`), '/etc/passwd');
});

test('materialize: git symlink entries are real symlinks, never followed', { skip: SYMLINK_SKIP }, async () => {
  const s = await site({ 'index.html': 'hi' });
  await s.commit();
  const outside = `${s.root}/outside.txt`;
  fs.writeFileSync(outside, 'secret');
  const c2 = await commitSymlinkEntry(s.repo, s.staging, 'evil', outside);
  await materializeRelease({ repoDir: s.repo, releasesDir: s.releases, number: 1, commit: c2, dataPaths: [], base: null });
  assert.equal(fs.lstatSync(`${s.releases}/1/evil`).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(`${s.releases}/1/evil`), outside);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'secret');
});

test('data links: created as /srv/data/<path>, parents made as real dirs (emulated links)', async () => {
  const s = await site({ 'wp-content/themes/t.css': 'x', 'wp-content/uploads/old.jpg': 'J' });
  const c1 = await s.commit(['wp-content/uploads', 'cache/deep/tmp']);
  const links = emulatedLinkOps();
  await materializeRelease({ repoDir: s.repo, releasesDir: s.releases, number: 1, commit: c1, dataPaths: ['wp-content/uploads', 'cache/deep/tmp'], base: null, links });
  assert.deepEqual(links.created.map((c) => c.target).sort(), ['/srv/data/cache/deep/tmp', '/srv/data/wp-content/uploads']);
  assert.equal(fs.lstatSync(`${s.releases}/1/cache/deep`).isDirectory(), true);
});

test('data links: a file in the way of a parent is a conflict', () => {
  const dir = tempDir('dl');
  fs.writeFileSync(`${dir}/wp-content`, 'not a dir');
  assert.throws(() => createDataLinks(dir, ['wp-content/uploads'], emulatedLinkOps()), (e: Error) => e instanceof MaterializeError && /chemin de données en conflit: wp-content\/uploads/.test(e.message));
  fs.mkdirSync(`${dir}/a/b`, { recursive: true });
  assert.throws(() => createDataLinks(dir, ['a/b'], emulatedLinkOps()), MaterializeError, 'existing leaf');
});

test('data links: a symlink entry of the tree in the way fails the materialization (emulated links)', async () => {
  const s = await site({ 'index.html': 'hi' });
  await s.commit();
  const c2 = await commitSymlinkEntry(s.repo, s.staging, 'wp-content', '/tmp');
  await assert.rejects(
    materializeRelease({ repoDir: s.repo, releasesDir: s.releases, number: 1, commit: c2, dataPaths: ['wp-content/uploads'], base: null, links: emulatedLinkOps() }),
    /chemin de données en conflit: wp-content\/uploads/,
  );
  assert.equal(fs.existsSync(`${s.releases}/1`), false);
  assert.equal(fs.existsSync(`${s.releases}/1.tmp`), false);
});

test('data links: a SYMLINKED parent is refused, nothing written through it (R1)', { skip: SYMLINK_SKIP }, async () => {
  const s = await site({ 'index.html': 'hi' });
  await s.commit();
  const victim = `${s.root}/victim`;
  fs.mkdirSync(victim);
  const c2 = await commitSymlinkEntry(s.repo, s.staging, 'wp-content', victim);
  await assert.rejects(
    materializeRelease({ repoDir: s.repo, releasesDir: s.releases, number: 1, commit: c2, dataPaths: ['wp-content/uploads'], base: null }),
    /chemin de données en conflit: wp-content\/uploads/,
  );
  assert.deepEqual(fs.readdirSync(victim), []);
  assert.equal(fs.existsSync(`${s.releases}/1`), false);
  assert.equal(fs.existsSync(`${s.releases}/1.tmp`), false);
});

test('data links with real symlinks point to the absolute container path', { skip: SYMLINK_SKIP }, () => {
  const dir = tempDir('dlr');
  createDataLinks(dir, ['wp-content/uploads'], realLinkOps);
  assert.equal(fs.readlinkSync(`${dir}/wp-content/uploads`), '/srv/data/wp-content/uploads');
});

test('current switch: relative target, replaced atomically, removable (emulated)', () => {
  const dir = tempDir('cur');
  const links = emulatedLinkOps();
  assert.equal(readCurrent(dir, links), null);
  switchCurrent(dir, 3, links);
  assert.equal(readCurrent(dir, links), 3);
  switchCurrent(dir, 4, links);
  assert.equal(readCurrent(dir, links), 4);
  assert.equal(fs.existsSync(`${dir}/current.tmp`), false);
  switchCurrent(dir, null, links);
  assert.equal(readCurrent(dir, links), null);
});

test('current switch with real symlinks: rename over the old link', { skip: SYMLINK_SKIP }, () => {
  const dir = tempDir('curr');
  fs.mkdirSync(`${dir}/1`);
  fs.mkdirSync(`${dir}/2`);
  fs.writeFileSync(`${dir}/2/marker`, 'two');
  switchCurrent(dir, 1);
  switchCurrent(dir, 2);
  assert.equal(fs.readlinkSync(`${dir}/current`), '2');
  assert.equal(fs.readFileSync(`${dir}/current/marker`, 'utf8'), 'two');
  assert.equal(fs.existsSync(`${dir}/current.tmp`), false);
});

test('removeUnder refuses paths outside the root', () => {
  const dir = tempDir('rm');
  fs.mkdirSync(`${dir}/inside`);
  assert.throws(() => removeUnder(`${dir}/inside`, dir));
  assert.throws(() => removeUnder(dir, path.join(dir, '..', 'x')));
  assert.throws(() => removeUnder(dir, dir));
  removeUnder(dir, `${dir}/inside`);
  assert.equal(fs.existsSync(`${dir}/inside`), false);
});

test('hardlink reuse never goes through a symlinked parent of the base release (R1)', { skip: SYMLINK_SKIP }, async () => {
  const s = await site({ 'D/x': 'same', 'keep.txt': 'k' });
  const c1 = await s.commit();
  await materializeRelease({ repoDir: s.repo, releasesDir: s.releases, number: 1, commit: c1, dataPaths: [], base: null });
  // The base release now has D as a symlink to a directory outside the release (like a data link).
  const outside = tempDir('outside');
  fs.writeFileSync(`${outside}/x`, 'same');
  fs.rmSync(`${s.releases}/1/D`, { recursive: true, force: true });
  fs.symlinkSync(outside, `${s.releases}/1/D`, 'dir');
  const res = await materializeRelease({ repoDir: s.repo, releasesDir: s.releases, number: 2, commit: c1, dataPaths: [], base: { number: 1, commit: c1 } });
  assert.equal(res.linked, 1, 'keep.txt only');
  assert.notEqual(ino(`${s.releases}/2/D/x`), ino(`${outside}/x`));
  assert.equal(fs.readFileSync(`${s.releases}/2/D/x`, 'utf8'), 'same');
});

test('dataLinksMatch: exact set of /srv/data links of a tree (emulated links)', async () => {
  const s = await site({ 'index.php': 'x', 'a/b.txt': 'b' });
  const c1 = await s.commit(['up', 'a/cache']);
  const links = emulatedLinkOps();
  await materializeRelease({ repoDir: s.repo, releasesDir: s.releases, number: 1, commit: c1, dataPaths: ['up', 'a/cache'], base: null, links });
  const dir = `${s.releases}/1`;
  assert.equal(dataLinksMatch(dir, ['a/cache', 'up'], links), true);
  assert.equal(dataLinksMatch(dir, ['up'], links), false, 'a data path was removed');
  assert.equal(dataLinksMatch(dir, ['up', 'a/cache', 'new'], links), false, 'a data path was added');
  const plain = await site({ 'index.php': 'x' });
  const c2 = await plain.commit();
  await materializeRelease({ repoDir: plain.repo, releasesDir: plain.releases, number: 1, commit: c2, dataPaths: [], base: null, links });
  assert.equal(dataLinksMatch(`${plain.releases}/1`, [], links), true);
});

test('removeTmpEntries removes <n>.tmp and current.tmp only', () => {
  const dir = tempDir('tmpent');
  fs.mkdirSync(`${dir}/3.tmp/sub`, { recursive: true });
  fs.writeFileSync(`${dir}/current.tmp`, '@@link:3');
  fs.mkdirSync(`${dir}/2`);
  fs.writeFileSync(`${dir}/current`, '@@link:2');
  fs.mkdirSync(`${dir}/x.tmp`);
  assert.deepEqual(removeTmpEntries(dir).sort(), ['3.tmp', 'current.tmp']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2', 'current', 'x.tmp']);
});

test('symlinkDataTarget / exposesTypedPath: lexical resolution in the container view', async () => {
  const { symlinkDataTarget, exposesTypedPath } = await import('./materialize');
  const dp = ['img', 'storage', 'wp-content/uploads'];
  assert.equal(symlinkDataTarget('pics', 'img', 4, dp), 'img');
  assert.equal(symlinkDataTarget('a/pics', '../img/thumbs', 4, dp), 'img/thumbs');
  assert.equal(symlinkDataTarget('pics', '/srv/data/img', 4, dp), 'img');
  assert.equal(symlinkDataTarget('pics', '/srv/data', 4, dp), '');
  assert.equal(symlinkDataTarget('x/y', '../../../data/img', 4, dp), 'img');
  assert.equal(symlinkDataTarget('x/y', '../../../../data/img', 4, dp), null);
  assert.equal(symlinkDataTarget('pics', '/srv/releases/current/img', 4, dp), 'img');
  assert.equal(symlinkDataTarget('self', '.', 4, dp), '');
  assert.equal(symlinkDataTarget('wp', 'wp-content', 4, dp), 'wp-content');
  assert.equal(symlinkDataTarget('public/storage', '../storage/app/public', 4, dp), 'storage/app/public');
  assert.equal(symlinkDataTarget('lib', 'vendor/lib', 4, dp), null);
  assert.equal(symlinkDataTarget('evil', '/etc/passwd', 4, dp), null);
  assert.equal(symlinkDataTarget('self', '.', 4, []), null);

  assert.equal(exposesTypedPath('img', ['img']), true);
  assert.equal(exposesTypedPath('img/thumbs', ['img']), true);
  assert.equal(exposesTypedPath('', ['img']), true);
  assert.equal(exposesTypedPath('a', ['a/img']), true);
  assert.equal(exposesTypedPath('images', ['img']), false);
  assert.equal(exposesTypedPath('storage/app/public', ['img']), false);
});

test('materialize: a symlink reaching a typed data path is skipped, one into a persistent path is kept (emulated)', async () => {
  const s = await site({ 'index.php': '<?php' });
  await s.commit(['img', 'storage']);
  await commitSymlinkEntry(s.repo, s.staging, 'pics', 'img');
  const c = await commitSymlinkEntry(s.repo, s.staging, 'public/storage', '../storage/app/public');
  const links = emulatedLinkOps();
  const warnings: string[] = [];
  const res = await materializeRelease({
    repoDir: s.repo, releasesDir: s.releases, number: 1, commit: c, dataPaths: ['img', 'storage'], typedDataPaths: ['img'],
    base: null, links, log: (level, m) => { if (level === 'warn') warnings.push(m); },
  });
  assert.equal(res.symlinks, 1);
  const created = links.created.map((l) => `${path.posix.relative(`${s.releases}/1`, l.path.replace(/\.tmp(?=\/|$)/, ''))} -> ${l.target}`).sort();
  assert.ok(created.includes('public/storage -> ../storage/app/public'), created.join('\n'));
  assert.ok(!created.some((l) => l.startsWith('pics ')), created.join('\n'));
  assert.ok(warnings.some((w) => w.includes('pics')), warnings.join('\n'));
});

test('staleDataExposure: dropped data links and code links into newly typed paths (emulated)', async () => {
  const { staleDataExposure } = await import('./materialize');
  const s = await site({ 'index.php': '<?php' });
  await s.commit(['img', 'storage']);
  await commitSymlinkEntry(s.repo, s.staging, 'pics', 'img');
  const c = await commitSymlinkEntry(s.repo, s.staging, 'public/storage', '../storage/app/public');
  const links = emulatedLinkOps();
  // Built while both paths were persistent: both code links kept.
  await materializeRelease({ repoDir: s.repo, releasesDir: s.releases, number: 1, commit: c, dataPaths: ['img', 'storage'], typedDataPaths: [], base: null, links });
  const dir = `${s.releases}/1`;
  assert.deepEqual(staleDataExposure(dir, 1, ['img', 'storage'], [], links), [], 'unchanged data paths: the tree may stay live');
  assert.deepEqual(staleDataExposure(dir, 1, ['img', 'storage', 'new'], [], links), [], 'a NEW data path is not a reason');
  // `img` deleted: its data link would be served with the code rules.
  assert.deepEqual(staleDataExposure(dir, 1, ['storage'], [], links), ['lien de données obsolète : img']);
  // `img` becomes typed: the code link `pics` bypasses the whitelist.
  assert.deepEqual(staleDataExposure(dir, 1, ['img', 'storage'], ['img'], links), ['lien symbolique vers un chemin de données typé : pics']);
  // `storage` typed: public/storage reaches inside it.
  assert.deepEqual(staleDataExposure(dir, 1, ['img', 'storage'], ['storage'], links), ['lien symbolique vers un chemin de données typé : public/storage']);
});

test('fsyncDir never throws (directories cannot be opened on Windows)', async () => {
  const { fsyncDir } = await import('./materialize');
  const dir = tempDir('fsync');
  fsyncDir(dir);
  fsyncDir(`${dir}/missing`);
});
