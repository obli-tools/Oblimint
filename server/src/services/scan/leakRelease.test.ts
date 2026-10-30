import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { commitStaging, diffStats, initBareRepo, scanStaging } from '../releases/repo';
import { tempDir, writeFiles } from '../releases/testUtil';
import { commitLeakReport, leakLogLines, leakSettingsOf, leakSummaryLine, stagingLeakReport } from './leakRelease';

// Leak guard on its two sources: a real commit of a bare repository (what the
// pipeline publishes) and the staging walked from disk (check_leaks).

const AWS = 'AK' + 'IA' + 'ZXCVBNMASDFGHJKL';
const author = { name: 'Test', email: 'test@example.com' };

async function commit(repo: string, staging: string, dataPaths: string[] = []): Promise<string> {
  const scan = scanStaging(staging, dataPaths);
  return commitStaging({ repoDir: repo, stagingDir: staging, dataPaths, nestedRepos: scan.nestedRepos, message: 'm', author });
}

test('settings of a site row: block unless warn, allowlist from JSON, engine from the base', () => {
  assert.deepEqual(leakSettingsOf({ docroot: 'public', base: 'nginx-php8.3', leak_policy: null, leak_allowlist: '["a/","x.sql",3]' }),
    { policy: 'block', allowlist: ['a/', 'x.sql'], docroot: 'public', engine: 'nginx' });
  assert.deepEqual(leakSettingsOf({ docroot: '', base: 'apache-php8.4', leak_policy: 'warn', leak_allowlist: ['b'] }),
    { policy: 'warn', allowlist: ['b'], docroot: '', engine: 'apache' });
  assert.equal(leakSettingsOf({ docroot: '', base: 'unknown' }).engine, null);
});

test('commit: file rules on the whole tree, content rules on the changed files only', async () => {
  const root = tempDir('leak');
  const repo = `${root}/repo.git`;
  const staging = `${root}/staging`;
  fs.mkdirSync(staging);
  await initBareRepo(repo);
  writeFiles(staging, { 'index.php': '<?php echo 1;', 'old.js': `k="${AWS}"`, 'dump.sql': 'INSERT INTO t VALUES (1);\n' });
  const first = await commit(repo, staging);
  const site = { docroot: '', base: 'apache-php8.3', leak_policy: 'block', leak_allowlist: [] };

  const r1 = await commitLeakReport(repo, first, null, site);
  assert.deepEqual(r1.findings.map((f) => `${f.rule} ${f.path}`).sort(), ['expose.dump dump.sql', 'secret.cloud old.js']);
  assert.equal(r1.blocked, true);

  writeFiles(staging, { 'new.js': `k="${AWS}"`, 'uploads/x.js': `k="${AWS}"` });
  const second = await commit(repo, staging, ['uploads']);
  const stats = await diffStats(repo, first, second);
  const r2 = await commitLeakReport(repo, second, stats.changed, site);
  // old.js is unchanged (its content is not read again), the dump is still in the tree; uploads is a data path (not committed).
  assert.deepEqual(r2.findings.map((f) => `${f.rule} ${f.path}`).sort(), ['expose.dump dump.sql', 'secret.cloud new.js']);

  const allowed = await commitLeakReport(repo, second, stats.changed, { ...site, leak_allowlist: ['dump.sql', 'new.js'] });
  assert.deepEqual([allowed.findings.length, allowed.allowlisted, allowed.blocked], [0, 2, false]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('staging: data paths and nested repositories left out, every file read', async () => {
  const root = tempDir('leakst');
  writeFiles(root, {
    'a.js': `k="${AWS}"`,
    'wp-content/uploads/b.js': `k="${AWS}"`,
    'vendor/pkg/.git/HEAD': 'ref', 'vendor/pkg/c.js': `k="${AWS}"`,
    '.git/config': '[core]',
    'backup.zip': 'PK',
  });
  const r = await stagingLeakReport(root, ['wp-content/uploads'], { docroot: '', base: 'nginx-php8.3', leak_policy: 'warn', leak_allowlist: [] });
  assert.deepEqual(r.findings.map((f) => `${f.rule} ${f.path} ${f.severity}`).sort(), ['expose.backup-archive backup.zip critical', 'secret.cloud a.js critical']);
  assert.deepEqual([r.files, r.truncated, r.blocked, r.policy], [2, false, false, 'warn']);
  const lines = leakLogLines(r);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => !l.includes(AWS)));
  assert.match(leakSummaryLine(r), /2 critique\(s\), 0 avertissement\(s\)/);
  fs.rmSync(root, { recursive: true, force: true });
});
