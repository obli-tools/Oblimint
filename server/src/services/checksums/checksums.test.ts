import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ChecksumFetchJson, ChangedPath, ChecksumProvider } from '../maintenance/contracts';
import { localContentTree } from '../maintenance/contracts';
import { checksumProviders, checksumService, mergeChecksumStatus, registerChecksumProvider, setChecksumFetchForTests } from './checksum.service';
import { allowedChecksumUrl, createCachedFetch, fetchChecksumJson, setChecksumHttpGetForTests } from './fetch';
import { coreChecksumMap, parsePluginHeader, parseWpVersionFile, pluginChecksumMap } from './wordpress';

// Official checksum providers (docs/P3-PLAN.md §10.1): parsing, WordPress core
// and WordPress.org plugin providers over a temp-dir tree with a fake fetcher,
// merge rules, fetcher allow-list / redirects / cache. No network.

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function tree(t: TestContext, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-checksums-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const changed = (p: string, change: ChangedPath['change'] = 'modified'): ChangedPath =>
  ({ path: p, change, type: 'file', size: change === 'deleted' ? null : 1 });

const VERSION_PHP = `<?php
/**
 * WordPress Version
 */
$wp_version = '6.5.2';
$wp_db_version = 57155;
$wp_local_package = 'fr_FR';
`;

const AKISMET_MAIN = `<?php
/**
 * @package Akismet
 */
/*
Plugin Name: Akismet Anti-spam: Spam Protection
Plugin URI: https://akismet.com/
Description: Used by millions.
Version: 5.3.2
Requires at least: 5.8
*/
`;

test('parsers: version.php, plugin header, response shapes', () => {
  assert.deepEqual(parseWpVersionFile(VERSION_PHP), { version: '6.5.2', locale: 'fr_FR' });
  assert.deepEqual(parseWpVersionFile(`<?php $wp_version = "6.6-beta1";`), { version: '6.6-beta1', locale: null });
  assert.deepEqual(parseWpVersionFile(`<?php $wp_version = '6.5/../../x';`), { version: null, locale: null }, 'not a version token');
  assert.equal(parseWpVersionFile(`<?php $wp_version = '1'; $wp_local_package = 'x&y=1';`).locale, null, 'locale validated');
  assert.equal(parseWpVersionFile(`<?php $wp_local_package = 'de_DE_formal'; $wp_version='6.5';`).locale, 'de_DE_formal');

  assert.deepEqual(parsePluginHeader(AKISMET_MAIN), { isPlugin: true, version: '5.3.2' });
  assert.deepEqual(parsePluginHeader(' * Plugin Name: X\n * Version: 1.2 */'), { isPlugin: true, version: '1.2' });
  assert.deepEqual(parsePluginHeader('<?php // helpers\n'), { isPlugin: false, version: null });
  assert.equal(parsePluginHeader('Plugin Name: X\nVersion: 1.0 ../evil').version, null, 'invalid version token');

  const flat = coreChecksumMap({ checksums: { 'index.php': md5('a'), bad: 'zz' } }, '6.5.2');
  assert.deepEqual([...flat!.keys()], ['index.php']);
  const nested = coreChecksumMap({ checksums: { '6.5.2': { 'index.php': md5('a') } } }, '6.5.2');
  assert.equal(nested!.get('index.php'), md5('a'));
  assert.equal(coreChecksumMap({ checksums: false }, '6.5.2'), null);
  assert.equal(coreChecksumMap(null, '6.5.2'), null);

  const plugin = pluginChecksumMap({ files: { 'a.php': { md5: md5('a'), sha256: [sha256('x'), sha256('a')] }, 'b.txt': { md5: [md5('b')] } } });
  assert.deepEqual(plugin!.get('a.php'), { md5: [md5('a')], sha256: [sha256('x'), sha256('a')] });
  assert.deepEqual(plugin!.get('b.txt'), { md5: [md5('b')], sha256: [] });
  assert.equal(pluginChecksumMap({}), null);
});

test('merge rule: mismatch > match > unknown', () => {
  assert.equal(mergeChecksumStatus(undefined, 'match'), 'match');
  assert.equal(mergeChecksumStatus('unknown', 'match'), 'match');
  assert.equal(mergeChecksumStatus('match', 'mismatch'), 'mismatch');
  assert.equal(mergeChecksumStatus('mismatch', 'match'), 'mismatch');
  assert.equal(mergeChecksumStatus('match', 'unknown'), 'match');
});

test('built-in providers are registered', () => {
  const ids = checksumProviders().map((p) => p.id);
  assert.ok(ids.includes('wordpress-core'));
  assert.ok(ids.includes('wordpress-plugins'));
});

test('WordPress core + plugins over a tree, with a fake fetcher', async (t) => {
  const root = tree(t, {
    'wp-includes/version.php': VERSION_PHP,
    'wp-includes/load.php': 'official load',
    'wp-includes/evil.php': '<?php // foreign',
    'wp-admin/index.php': 'tampered admin',
    'index.php': 'official index',
    'wp-config.php': '<?php // site config',
    'wp-content/plugins/akismet/akismet.php': AKISMET_MAIN,
    'wp-content/plugins/akismet/class.akismet.php': 'official class',
    'wp-content/plugins/akismet/extra.php': 'added to the plugin',
    'wp-content/plugins/custom-thing/custom-thing.php': '<?php\n/* Plugin Name: Custom\nVersion: 1.0 */',
    'wp-content/plugins/custom-thing/inc.php': 'custom code',
    'wp-content/plugins/noheader/x.php': 'no header',
    'wp-content/themes/mine/functions.php': 'theme',
    'wp-content/plugins/hello.php': 'single-file plugin',
  });
  const coreSums = {
    'wp-includes/version.php': md5(VERSION_PHP),
    'wp-includes/load.php': md5('official load'),
    'wp-admin/index.php': md5('official admin'),
    'wp-admin/still-shipped.php': md5('x'),
    'index.php': md5('official index'),
    'wp-content/plugins/akismet/akismet.php': md5('bundled older version'),
  };
  const calls: string[] = [];
  const fake: ChecksumFetchJson = async (url) => {
    calls.push(url);
    if (url.includes('locale=fr_FR')) return { checksums: false }; // no localized list: fallback en_US
    if (url === 'https://api.wordpress.org/core/checksums/1.0/?version=6.5.2&locale=en_US') return { checksums: { '6.5.2': coreSums } };
    if (url === 'https://downloads.wordpress.org/plugin-checksums/akismet/5.3.2.json') {
      return {
        plugin: 'akismet', version: '5.3.2',
        files: {
          'akismet.php': { md5: md5(AKISMET_MAIN), sha256: sha256(AKISMET_MAIN) },
          'class.akismet.php': { md5: [md5('older'), md5('official class')], sha256: [sha256('older'), sha256('official class')] },
          'gone-in-this-version.php': { md5: md5('x'), sha256: sha256('x') },
        },
      };
    }
    if (url.startsWith('https://downloads.wordpress.org/plugin-checksums/custom-thing/')) return null; // 404
    throw new Error(`unexpected URL ${url}`);
  };
  setChecksumFetchForTests(fake);
  t.after(() => setChecksumFetchForTests(null));

  const files: ChangedPath[] = [
    changed('wp-includes/version.php'),
    changed('wp-includes/load.php'),
    changed('wp-includes/evil.php', 'added'),
    changed('wp-includes/obsolete.php', 'deleted'),
    changed('wp-admin/index.php'),
    changed('wp-admin/still-shipped.php', 'deleted'),
    changed('index.php'),
    changed('wp-config.php'),
    changed('wp-content/plugins/akismet/akismet.php'),
    changed('wp-content/plugins/akismet/class.akismet.php'),
    changed('wp-content/plugins/akismet/extra.php', 'added'),
    changed('wp-content/plugins/akismet/removed-legit.php', 'deleted'),
    changed('wp-content/plugins/akismet/gone-in-this-version.php', 'deleted'),
    changed('wp-content/plugins/custom-thing/inc.php', 'added'),
    changed('wp-content/plugins/noheader/x.php', 'added'),
    changed('wp-content/themes/mine/functions.php'),
    changed('wp-content/plugins/hello.php'),
    { path: 'wp-content/uploads/big.bin', change: 'added', type: 'file', size: 1, ignored: 'dataPath' },
  ];
  const v = await checksumService.verify({ siteId: 1, appProfile: 'wordpress', tree: localContentTree(root), files });
  const st = (p: string) => v.files.get(p);

  // core
  assert.equal(st('wp-includes/version.php'), 'match');
  assert.equal(st('wp-includes/load.php'), 'match');
  assert.equal(st('wp-includes/evil.php'), 'mismatch', 'added in wp-includes, not listed');
  assert.equal(st('wp-includes/obsolete.php'), 'match', 'deleted and not listed for the new version');
  assert.equal(st('wp-admin/index.php'), 'mismatch', 'content differs');
  assert.equal(st('wp-admin/still-shipped.php'), 'mismatch', 'deleted but part of the new version');
  assert.equal(st('index.php'), 'match');
  assert.equal(st('wp-config.php'), 'unknown', 'root file outside the distribution');
  // plugins (core never judges wp-content: its bundled akismet md5 does not interfere)
  assert.equal(st('wp-content/plugins/akismet/akismet.php'), 'match');
  assert.equal(st('wp-content/plugins/akismet/class.akismet.php'), 'match', 'sha256 array');
  assert.equal(st('wp-content/plugins/akismet/extra.php'), 'mismatch', 'not in the distributed plugin');
  assert.equal(st('wp-content/plugins/akismet/removed-legit.php'), 'match');
  assert.equal(st('wp-content/plugins/akismet/gone-in-this-version.php'), 'mismatch');
  assert.equal(st('wp-content/plugins/custom-thing/inc.php'), 'unknown', '404: plugin outside the directory');
  assert.equal(st('wp-content/plugins/noheader/x.php'), 'unknown');
  assert.equal(st('wp-content/themes/mine/functions.php'), 'unknown', 'themes: no official API');
  assert.equal(st('wp-content/plugins/hello.php'), 'unknown', 'single-file plugin');
  assert.equal(st('wp-content/uploads/big.bin'), 'unknown', 'ignored path still reported');
  assert.equal(v.files.size, files.length);

  const r = v.report;
  assert.deepEqual(r.providers, ['wordpress-core', 'wordpress-plugins']);
  assert.equal(r.filesVerified + r.filesMismatched + r.filesUnknown, files.length);
  assert.equal(r.filesMismatched, 5);
  assert.equal(r.filesVerified, 7);
  const core = r.components.find((c) => c.provider === 'wordpress-core')!;
  assert.deepEqual({ ...core, detail: undefined }, {
    provider: 'wordpress-core', kind: 'core', name: 'WordPress', version: '6.5.2', status: 'mismatch', files: 7, mismatches: 3, detail: undefined,
  });
  const akismet = r.components.find((c) => c.name === 'akismet')!;
  assert.equal(akismet.status, 'mismatch');
  assert.equal(akismet.version, '5.3.2');
  assert.equal(akismet.files, 5);
  assert.equal(akismet.mismatches, 2);
  const custom = r.components.find((c) => c.name === 'custom-thing')!;
  assert.equal(custom.status, 'unavailable');
  assert.equal(custom.version, '1.0');
  assert.equal(r.components.find((c) => c.name === 'noheader')!.status, 'unavailable');
  assert.ok(calls.includes('https://api.wordpress.org/core/checksums/1.0/?version=6.5.2&locale=fr_FR'), 'localized list tried first');
  assert.ok(calls.every((u) => u.startsWith('https://api.wordpress.org/') || u.startsWith('https://downloads.wordpress.org/')));
});

test('remote failures never throw: components error / unavailable', async (t) => {
  const root = tree(t, {
    'wp-includes/version.php': `<?php $wp_version = '6.5.2';`,
    'wp-includes/load.php': 'x',
    'wp-content/plugins/akismet/akismet.php': AKISMET_MAIN,
    'wp-content/plugins/Bad_Slug/x.php': 'x',
  });
  const calls: string[] = [];
  setChecksumFetchForTests(async (url) => { calls.push(url); throw new Error('ETIMEDOUT'); });
  t.after(() => setChecksumFetchForTests(null));
  const v = await checksumService.verify({
    siteId: 1, appProfile: 'wordpress', tree: localContentTree(root),
    files: [changed('wp-includes/load.php'), changed('wp-content/plugins/akismet/akismet.php'), changed('wp-content/plugins/Bad_Slug/x.php', 'added')],
  });
  assert.equal(v.report.components.find((c) => c.provider === 'wordpress-core')!.status, 'error');
  assert.equal(v.report.components.find((c) => c.name === 'akismet')!.status, 'error');
  assert.equal(v.report.components.find((c) => c.name === 'Bad_Slug')!.status, 'unavailable');
  assert.ok(!calls.some((u) => u.includes('Bad_Slug')), 'invalid slug: no URL built (M11)');
  assert.equal(v.report.filesUnknown, 3);
});

test('core: unreadable version, no core path changed, unavailable list', async (t) => {
  const calls: string[] = [];
  setChecksumFetchForTests(async (url) => { calls.push(url); return { checksums: false }; });
  t.after(() => setChecksumFetchForTests(null));

  let root = tree(t, { 'wp-includes/version.php': '<?php // no version' });
  let v = await checksumService.verify({ siteId: 1, appProfile: null, tree: localContentTree(root), files: [changed('wp-includes/x.php')] });
  assert.equal(v.report.components[0].status, 'error');
  assert.equal(calls.length, 0);

  root = tree(t, { 'wp-includes/version.php': `<?php $wp_version = '6.5.2';`, 'wp-content/themes/a/x.php': 'x' });
  v = await checksumService.verify({ siteId: 1, appProfile: null, tree: localContentTree(root), files: [changed('wp-content/themes/a/x.php')] });
  assert.equal(v.report.components[0].status, 'verified');
  assert.equal(v.report.components[0].files, 0);
  assert.equal(calls.length, 0, 'nothing for core to judge: no request');

  v = await checksumService.verify({ siteId: 1, appProfile: null, tree: localContentTree(root), files: [changed('wp-includes/x.php')] });
  assert.equal(v.report.components[0].status, 'unavailable');
  assert.equal(v.files.get('wp-includes/x.php'), 'unknown');

  // Not WordPress at all: no provider applies.
  root = tree(t, { 'index.php': 'x' });
  v = await checksumService.verify({ siteId: 1, appProfile: null, tree: localContentTree(root), files: [changed('index.php')] });
  assert.deepEqual(v.report.providers, []);
  assert.equal(v.files.get('index.php'), 'unknown');
});

test('a throwing third-party provider becomes an error component; it cannot add paths', async (t) => {
  const root = tree(t, { 'a.php': 'x' });
  const bad: ChecksumProvider = {
    id: 'test-bad', label: 'Bad', applies: async () => true,
    verify: async () => { throw new Error('boom'); },
  };
  const extra: ChecksumProvider = {
    id: 'test-extra', label: 'Extra', applies: async () => true,
    verify: async () => ({ components: [], files: new Map([['a.php', 'match'], ['not-changed.php', 'match']]) }),
  };
  registerChecksumProvider(bad);
  registerChecksumProvider(extra);
  registerChecksumProvider(extra); // idempotent
  t.after(() => {
    const list = checksumProviders() as ChecksumProvider[];
    for (const id of ['test-bad', 'test-extra']) list.splice(list.findIndex((p) => p.id === id), 1);
  });
  assert.equal(checksumProviders().filter((p) => p.id === 'test-extra').length, 1);
  const v = await checksumService.verify({ siteId: 1, appProfile: null, tree: localContentTree(root), files: [changed('a.php')] });
  assert.equal(v.report.components.find((c) => c.provider === 'test-bad')!.status, 'error');
  assert.equal(v.files.get('a.php'), 'match');
  assert.equal(v.files.has('not-changed.php'), false);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => checksumService.verify({ siteId: 1, appProfile: null, tree: localContentTree(root), files: [], signal: ac.signal }), /aborted/);
});

test('fetcher: allow-list, same-host redirects only, 404 → null, JSON', async (t) => {
  assert.ok(allowedChecksumUrl('https://api.wordpress.org/core/checksums/1.0/?version=1'));
  assert.ok(allowedChecksumUrl('https://downloads.wordpress.org/plugin-checksums/a/1.json'));
  for (const bad of [
    'http://api.wordpress.org/x', 'https://evil.example/x', 'https://api.wordpress.org.evil.example/x',
    'https://user:pw@api.wordpress.org/x', 'https://api.wordpress.org:8443/x', 'file:///etc/passwd', 'not a url',
  ]) assert.equal(allowedChecksumUrl(bad), null, bad);

  const seen: string[] = [];
  const routes: Record<string, { status: number; location?: string; body?: string }> = {
    'https://api.wordpress.org/ok': { status: 200, body: '{"a":1}' },
    'https://api.wordpress.org/missing': { status: 404 },
    'https://api.wordpress.org/redir': { status: 301, location: '/ok' },
    'https://api.wordpress.org/offhost': { status: 302, location: 'https://downloads.wordpress.org/ok' },
    'https://api.wordpress.org/evil': { status: 302, location: 'https://evil.example/' },
    'https://api.wordpress.org/badjson': { status: 200, body: '<html>' },
    'https://api.wordpress.org/err': { status: 500 },
  };
  setChecksumHttpGetForTests(async (url) => {
    seen.push(url.toString());
    const r = routes[url.toString()];
    if (!r) throw new Error(`no route ${url}`);
    return { status: r.status, location: r.location ?? null, body: Buffer.from(r.body ?? '') };
  });
  t.after(() => setChecksumHttpGetForTests(null));

  assert.deepEqual(await fetchChecksumJson('https://api.wordpress.org/ok'), { a: 1 });
  assert.equal(await fetchChecksumJson('https://api.wordpress.org/missing'), null);
  assert.deepEqual(await fetchChecksumJson('https://api.wordpress.org/redir'), { a: 1 });
  await assert.rejects(() => fetchChecksumJson('https://api.wordpress.org/offhost'), /another host/);
  await assert.rejects(() => fetchChecksumJson('https://api.wordpress.org/evil'), /another host/);
  await assert.rejects(() => fetchChecksumJson('https://api.wordpress.org/badjson'), /invalid JSON/);
  await assert.rejects(() => fetchChecksumJson('https://api.wordpress.org/err'), /HTTP 500/);
  seen.length = 0;
  await assert.rejects(() => fetchChecksumJson('https://evil.example/x'), /official checksum hosts/);
  assert.equal(seen.length, 0, 'nothing sent outside the allow-list');
});

test('cache: TTL, LRU bound, shared in-flight, failures not cached', async () => {
  let clock = 0;
  let calls = 0;
  let fail = false;
  const inner: ChecksumFetchJson = async (url) => {
    calls++;
    if (fail) throw new Error('down');
    return url.endsWith('404') ? null : { url };
  };
  const cached = createCachedFetch(inner, { ttlMs: 1000, maxEntries: 2, now: () => clock });
  const [a, b] = await Promise.all([cached('u1'), cached('u1')]);
  assert.deepEqual(a, { url: 'u1' });
  assert.equal(a, b);
  assert.equal(calls, 1, 'concurrent calls share one request');
  assert.equal(await cached('x404'), null);
  assert.equal(await cached('x404'), null);
  assert.equal(calls, 2, 'a 404 is cached too');
  await cached('u1'); // touch: u1 most recent
  await cached('u3'); // evicts x404 (least recently used)
  assert.equal(cached.size(), 2);
  await cached('u1');
  assert.equal(calls, 3);
  await cached('x404');
  assert.equal(calls, 4, 'evicted entry refetched');
  clock = 5000;
  await cached('u1');
  assert.equal(calls, 5, 'expired after the TTL');
  fail = true;
  await assert.rejects(() => cached('u9'));
  fail = false;
  await cached('u9');
  assert.equal(calls, 7, 'a failure is not cached');
});
