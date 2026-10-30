import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runGit } from '../releases/git';
import { commitStaging, headCommit, initBareRepo } from '../releases/repo';
import { bundleRefs, bundleRepo, repoRefs, restoreRepoFromBundle } from './repoBundle';

// Release history backup: bundle of a real bare repository (staging as work
// tree, like the release pipeline), then in-place restore — into the same
// repository moved on / damaged, and into a missing one.

const author = { name: 'Test', email: 'test@example.com' };

test('repo bundle: missing / empty, bundle, in-place restore', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo.git');
  const staging = path.join(root, 'staging');
  fs.mkdirSync(staging);
  const out = path.join(root, 'site.bundle');

  assert.equal(await bundleRepo(repo, out), 'missing');
  await initBareRepo(repo);
  assert.equal(await bundleRepo(repo, out), 'empty');
  assert.equal(fs.existsSync(out), false);

  // Two releases and a pipeline ref (candidate).
  fs.writeFileSync(path.join(staging, 'index.php'), '<?php echo 1;');
  const c1 = await commitStaging({ repoDir: repo, stagingDir: staging, dataPaths: [], nestedRepos: [], message: 'r1', author });
  fs.writeFileSync(path.join(staging, 'index.php'), '<?php echo 2;');
  const c2 = await commitStaging({ repoDir: repo, stagingDir: staging, dataPaths: [], nestedRepos: [], message: 'r2', author });
  await runGit(['update-ref', 'refs/oblimint/candidates/c-1', c1], { gitDir: repo });
  const before = await repoRefs(repo);
  assert.equal(Object.keys(before).length, 2);

  assert.equal(await bundleRepo(repo, out), 'bundled');
  assert.ok(fs.statSync(out).size > 0);
  assert.deepEqual((await bundleRefs(repo, out)).sort(), Object.keys(before).sort());

  // The repository moves on: a third commit, an extra ref, the candidate dropped.
  fs.writeFileSync(path.join(staging, 'index.php'), '<?php echo 3;');
  const c3 = await commitStaging({ repoDir: repo, stagingDir: staging, dataPaths: [], nestedRepos: [], message: 'r3', author });
  await runGit(['update-ref', 'refs/oblimint/extra', c3], { gitDir: repo });
  await runGit(['update-ref', '-d', 'refs/oblimint/candidates/c-1'], { gitDir: repo });
  assert.equal(await headCommit(repo), c3);

  // In place: refs back to the backed-up values, the extra one pruned.
  const r = await restoreRepoFromBundle(repo, out);
  assert.equal(r.refs, 2);
  assert.deepEqual(await repoRefs(repo), before);
  assert.equal(await headCommit(repo), c2);

  // Lost repository: recreated from the bundle, every release commit readable.
  fs.rmSync(repo, { recursive: true, force: true });
  await restoreRepoFromBundle(repo, out);
  assert.deepEqual(await repoRefs(repo), before);
  assert.equal(await headCommit(repo), c2);
  const blob = await runGit(['show', `${c1}:index.php`], { gitDir: repo });
  assert.equal(blob.stdout.toString('utf8'), '<?php echo 1;');

  // A file that is not a bundle is refused, the repository left alone.
  const bogus = path.join(root, 'bogus.bundle');
  fs.writeFileSync(bogus, 'not a bundle');
  await assert.rejects(restoreRepoFromBundle(repo, bogus));
  assert.deepEqual(await repoRefs(repo), before);
});
