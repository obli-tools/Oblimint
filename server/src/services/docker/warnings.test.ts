import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { comparePhp, scanReleaseFacts, switchWarnings, type ReleaseFacts } from './warnings';

const none: ReleaseFacts = { hasHtaccess: false, hasPhp: false, truncated: false };
const codes = (w: Array<{ code: string }>) => w.map((x) => x.code).sort();

test('comparePhp orders versions numerically', () => {
  assert.equal(comparePhp('8.10', '8.9'), 1);
  assert.equal(comparePhp('7.4', '8.1'), -1);
  assert.equal(comparePhp('8.3', '8.3'), 0);
});

test('apache → nginx with .htaccess in the release warns', () => {
  const w = switchWarnings({ current: 'apache-php8.3', target: 'nginx-php8.3', release: { ...none, hasHtaccess: true }, imagePresent: true, imageRef: 'x' });
  assert.deepEqual(codes(w), ['htaccessIgnored']);
  assert.deepEqual(codes(switchWarnings({ current: 'apache-php8.3', target: 'apache-php8.4', release: { ...none, hasHtaccess: true }, imagePresent: true, imageRef: 'x' })), []);
});

test('unmaintained target, downgrade and major change', () => {
  const w = switchWarnings({ current: 'apache-php8.3', target: 'apache-php7.4', release: none, imagePresent: true, imageRef: 'x' });
  assert.deepEqual(codes(w), ['phpDowngrade', 'phpMajorChange', 'unmaintainedRuntime', 'vulnerableRuntime']);
  assert.deepEqual(codes(switchWarnings({ current: 'apache-php8.4', target: 'nginx-php8.2', release: none, imagePresent: true, imageRef: 'x' })), ['phpDowngrade']);
  assert.deepEqual(codes(switchWarnings({ current: 'apache-php7.4', target: 'apache-php8.3', release: none, imagePresent: true, imageRef: 'x' })), ['phpMajorChange']);
});

test('static base over a PHP release, missing image', () => {
  const w = switchWarnings({ current: 'apache-php8.3', target: 'nginx-static', release: { hasHtaccess: true, hasPhp: true, truncated: false }, imagePresent: false, imageRef: 'meejay/oblimint-nginx-static:latest' });
  assert.deepEqual(codes(w), ['htaccessIgnored', 'imageMissing', 'staticBaseWithPhp']);
  assert.ok(w.find((x) => x.code === 'imageMissing')!.message.includes('meejay/oblimint-nginx-static:latest'));
  // Unknown image state (Docker unreachable) and no release: no warning invented.
  assert.deepEqual(codes(switchWarnings({ current: 'apache-php8.3', target: 'nginx-static', release: null, imagePresent: null, imageRef: 'x' })), []);
});

test('scanReleaseFacts: finds markers in sub directories, never follows symlinks, respects the cap', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'b', 'index.html'), 'x');
  assert.deepEqual(await scanReleaseFacts(root), none);

  fs.writeFileSync(path.join(root, 'a', 'b', '.htaccess'), 'RewriteEngine On');
  fs.writeFileSync(path.join(root, 'a', 'index.php'), '<?php');
  assert.deepEqual(await scanReleaseFacts(root), { hasHtaccess: true, hasPhp: true, truncated: false });

  const capped = await scanReleaseFacts(root, 1);
  assert.equal(capped.truncated, true);
  assert.equal(await scanReleaseFacts(path.join(root, 'missing')).then((f) => f.hasPhp), false);
});

test('scanReleaseFacts: a symlinked directory with PHP inside is not followed (R1)', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-scan-link-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const outside = path.join(base, 'outside');
  const root = path.join(base, 'release');
  fs.mkdirSync(outside);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(outside, 'evil.php'), '<?php');
  try {
    // 'junction' works without privilege on Windows and is reported as a link by lstat.
    fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('symlinks not permitted on this machine');
    return;
  }
  assert.ok(fs.lstatSync(path.join(root, 'link')).isSymbolicLink());
  assert.equal((await scanReleaseFacts(root)).hasPhp, false);
});
