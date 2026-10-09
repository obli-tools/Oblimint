import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_HOSTING_SETTINGS } from '@oblimint/shared';
import { localContentTree, type AnalyzeInput, type ContentTree } from '../maintenance/contracts';
import { initBareRepo, commitStaging } from '../releases/repo';
import { analyzeChanges } from './analyze';
import { commitContentTree, parseLsTreeLong } from './commitTree';
import { createPrePublishScanner, type PublishSiteInfo } from './prePublish';

// Pre-publish scanner mapping (ScanContext → AnalyzeInput → ScanSummary) with an injected site loader.

const roots: string[] = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-prepub-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

/** Local tree with git-like modes (Windows reports 0o666 for every file). */
function stagingTree(root: string): ContentTree {
  const t = localContentTree(root);
  return { ...t, stat: async (rel) => { const st = await t.stat(rel); return st ? { ...st, mode: st.type === 'dir' ? 0o755 : 0o644 } : null; } };
}

// Sloppy command injection rather than a canonical webshell (nothing an antivirus removes from the temp dir).
const COOKIE = ['$', '_COOKIE'].join('');
const INJECTION = ['<?php', `$p = proc_open('convert ' . ${COOKIE}['f'], $spec, $pipes);`, ''].join('\n');

test('pre-publish: staging files mapped (added / modified from the live release), analysis returned as ScanSummary', async () => {
  const staging = tree({
    'index.php': '<?php echo "v2";',
    'app/Http/New.php': '<?php echo 1;',
    'tools/run.php': INJECTION,
    'docs/a.md': '# doc',
    'public/dir/x.txt': 'x',
  });
  fs.mkdirSync(path.join(staging, 'emptydir'));
  const live = tree({ 'index.php': '<?php echo "v1";', 'app/Http/Kernel.php': '<?php', 'docs/a.md': '# old' });
  const site: PublishSiteInfo = {
    tenantId: 3, name: 'Shop', appProfile: 'laravel', dataPaths: [{ path: 'storage', policy: 'persistent', allowedExtensions: null }], liveReleaseDir: live,
  };
  const seen: AnalyzeInput[] = [];
  const scanner = createPrePublishScanner({
    loadSite: async (siteId, accountId) => (siteId === 7 && accountId === 2 ? site : null),
    openTree: async (ctx) => stagingTree(ctx.stagingDir),
    analyze: async (input, opts) => {
      seen.push(input);
      return analyzeChanges(input, { settings: { ...DEFAULT_HOSTING_SETTINGS.scanner, enabled: false }, engine: null, baseCodeDir: opts.baseCodeDir });
    },
  });
  const summary = await scanner.scan({
    siteId: 7, accountId: 2, stagingDir: staging, commitSha: 'a'.repeat(40),
    changedFiles: ['index.php', 'app/Http/New.php', 'tools/run.php', 'docs/a.md', 'index.php'],
  });
  const input = seen[0];
  assert.equal(input.origin, 'publish');
  assert.equal(input.appProfile, 'laravel');
  assert.equal(input.siteId, 7);
  assert.deepEqual(input.dataPaths, site.dataPaths);
  assert.deepEqual(input.files.map((f) => [f.path, f.change, f.type]), [
    ['index.php', 'modified', 'file'],
    ['app/Http/New.php', 'added', 'file'],
    ['tools/run.php', 'added', 'file'],
    ['docs/a.md', 'modified', 'file'],
  ]);
  assert.equal(summary.scanner, 'heuristic');
  assert.equal(summary.verdict, 'suspicious');
  assert.equal(summary.blocked, true, 'request-driven command execution (70) + new code outside the code dirs (25) ⇒ 80 ≥ blockScore');
  const rules = summary.findings.map((f) => `${f.path}:${f.rule}`).sort();
  assert.deepEqual(rules, ['tools/run.php:exec.new-outside-expected', 'tools/run.php:php.request-exec']);
  const hit = summary.findings.find((f) => f.rule === 'php.request-exec');
  assert.equal(hit?.engine, 'heuristic');
  assert.equal(hit?.line, 2);
});

test('pre-publish: first publication (no live release) and unknown site still analyse with defaults', async () => {
  const staging = tree({ 'a.php': '<?php echo 1;', 'lib/b.php': '<?php echo 2;' });
  const scanner = createPrePublishScanner({
    loadSite: async () => null,
    openTree: async (ctx) => stagingTree(ctx.stagingDir),
    analyze: (input, opts) => {
      assert.equal(opts.baseCodeDir, null);
      return analyzeChanges(input, { settings: DEFAULT_HOSTING_SETTINGS.scanner, engine: null, baseCodeDir: opts.baseCodeDir });
    },
  });
  const summary = await scanner.scan({ siteId: 1, accountId: 1, stagingDir: staging, commitSha: 'b'.repeat(40), changedFiles: ['a.php', 'lib/b.php'] });
  assert.equal(summary.verdict, 'clean');
  assert.equal(summary.blocked, false);
  assert.deepEqual(summary.findings, []);
});

const OFF = { ...DEFAULT_HOSTING_SETTINGS.scanner, enabled: false };

test('pre-publish: a changed path missing from the scanned tree fails the scan (never dropped)', async () => {
  const staging = tree({ 'a.php': '<?php echo 1;' });
  const scanner = createPrePublishScanner({
    loadSite: async () => null,
    openTree: async (ctx) => stagingTree(ctx.stagingDir),
    analyze: (input, opts) => analyzeChanges(input, { settings: OFF, engine: null, baseCodeDir: opts.baseCodeDir }),
  });
  await assert.rejects(scanner.scan({ siteId: 1, accountId: 1, stagingDir: staging, commitSha: 'c'.repeat(40), changedFiles: ['a.php', 'gone.php'] }), /missing from the committed tree/);
});

test('commit tree: ls-tree -l parsing (files, executables, symlinks, gitlinks)', () => {
  const oid = 'd'.repeat(40);
  const m = parseLsTreeLong([
    `100644 blob ${oid}      12\ta b/c.php`,
    `100755 blob ${oid}       3\tbin/run`,
    `120000 blob ${oid}       9\tlink`,
    `160000 commit ${oid}       -\tsub`,
    'garbage',
    '',
  ].join('\0'));
  assert.deepEqual([...m.keys()], ['a b/c.php', 'bin/run', 'link', 'sub']);
  assert.equal(m.get('a b/c.php')!.size, 12);
  assert.equal(m.get('sub')!.size, 0);
});

test('pre-publish: the COMMIT is scanned, not the staging rewritten after the commit (TOCTOU)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-prepub-git-'));
  roots.push(root);
  const repo = path.join(root, 'repo.git');
  const staging = path.join(root, 'staging');
  fs.mkdirSync(path.join(staging, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'index.php'), '<?php echo 1;');
  fs.writeFileSync(path.join(staging, 'lib', 'run.php'), INJECTION);
  fs.writeFileSync(path.join(staging, 'lib', 'gone.php'), INJECTION);
  await initBareRepo(repo);
  const sha = await commitStaging({ repoDir: repo, stagingDir: staging, dataPaths: [], nestedRepos: [], message: 'p', author: { name: 't', email: 't@x' } });

  // The tenant rewrites / deletes the files over SFTP once the commit is taken.
  fs.writeFileSync(path.join(staging, 'lib', 'run.php'), '<?php echo "benign";');
  fs.rmSync(path.join(staging, 'lib', 'gone.php'));

  const ct = commitContentTree(repo, sha);
  assert.deepEqual(await ct.stat('lib'), { type: 'dir', size: 0, mode: 0o755 });
  assert.equal((await ct.stat('lib/run.php'))?.type, 'file');
  assert.equal(await ct.stat('../x'), null);
  const head = await ct.read('lib/run.php', 5);
  assert.equal(head?.data.toString(), '<?php');
  assert.equal(head?.truncated, true);

  const scanner = createPrePublishScanner({
    loadSite: async () => null,
    openTree: async (ctx) => commitContentTree(repo, ctx.commitSha),
    analyze: (input, opts) => analyzeChanges(input, { settings: OFF, engine: null, baseCodeDir: opts.baseCodeDir }),
  });
  const summary = await scanner.scan({ siteId: 1, accountId: 1, stagingDir: staging, commitSha: sha, changedFiles: ['index.php', 'lib/run.php', 'lib/gone.php'] });
  const hits = summary.findings.filter((f) => f.rule === 'php.request-exec').map((f) => f.path).sort();
  assert.deepEqual(hits, ['lib/gone.php', 'lib/run.php']);
  assert.equal(summary.verdict, 'suspicious');
  assert.equal(summary.blocked, true, 'two files at 70 ⇒ 70 ≥ blockScore');
});
