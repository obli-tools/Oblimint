import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  EXTRACT_PLUGIN_PHP, LSCACHE_PLUGIN_SLUG, lscachePluginCommands, parsePluginChecksums, pluginArchiveUrl, pluginVerifiedFiles, verifyPluginFiles,
} from './lscachePlugin';
import { readsHtaccessRewrites, verifiedFilesOf, wpConfigPhp } from './wordpress';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');

test('plugin archive URL: official host, validated slug and version only', () => {
  assert.equal(pluginArchiveUrl('litespeed-cache', '7.9.3'), 'https://downloads.wordpress.org/plugin/litespeed-cache.7.9.3.zip');
  assert.throws(() => pluginArchiveUrl('litespeed-cache', '7.9.3/../../x'));
  assert.throws(() => pluginArchiveUrl('../evil', '1.0'));
  assert.throws(() => pluginArchiveUrl('litespeed-cache', '7.9.3?x=1'));
});

test('plugin checksums: files with md5 / sha256 (string or list); any unsafe path refuses the whole list', () => {
  const list = parsePluginChecksums({ files: {
    'litespeed-cache.php': { md5: 'AA', sha256: 'BB' },
    'src/x.php': { md5: ['c1', 'c2'], sha256: ['d1', 'd2'] },
  } });
  assert.deepEqual(list?.get('litespeed-cache.php'), { md5: ['aa'], sha256: ['bb'] });
  assert.deepEqual(list?.get('src/x.php'), { md5: ['c1', 'c2'], sha256: ['d1', 'd2'] });
  assert.equal(parsePluginChecksums({ files: { '../x.php': { md5: 'a', sha256: 'b' } } }), null);
  assert.equal(parsePluginChecksums({ files: { '/abs.php': { md5: 'a', sha256: 'b' } } }), null);
  assert.equal(parsePluginChecksums({ files: { 'x.php': { md5: 'a' } } }), null);
  assert.equal(parsePluginChecksums({ files: {} }), null);
  assert.equal(parsePluginChecksums(null), null);
});

test('verifyPluginFiles: every listed file matches, nothing else, no link', async (t) => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-lscache-'));
  t.after(() => fs.rmSync(staging, { recursive: true, force: true }));
  const dir = path.join(staging, 'wp-content', 'plugins', LSCACHE_PLUGIN_SLUG);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'litespeed-cache.php'), '<?php // main');
  fs.writeFileSync(path.join(dir, 'src', 'core.php'), '<?php // core');
  const list = new Map([
    ['litespeed-cache.php', { md5: [md5('<?php // main')], sha256: [sha256('<?php // main')] }],
    ['src/core.php', { md5: [md5('<?php // core')], sha256: [sha256('<?php // core')] }],
  ]);
  assert.deepEqual(await verifyPluginFiles(staging, LSCACHE_PLUGIN_SLUG, list), { available: true, checked: 2, mismatched: [], unexpected: [] });

  fs.writeFileSync(path.join(dir, 'src', 'core.php'), '<?php // tampered');
  fs.writeFileSync(path.join(dir, 'src', 'shell.php'), '<?php system($_GET["c"]);');
  const v = await verifyPluginFiles(staging, LSCACHE_PLUGIN_SLUG, list);
  assert.deepEqual(v.mismatched, ['src/core.php']);
  assert.deepEqual(v.unexpected, ['src/shell.php']);
  assert.deepEqual(await verifyPluginFiles(staging, LSCACHE_PLUGIN_SLUG, null), { available: false, checked: 0, mismatched: [], unexpected: [] });
});

test('verified files of the release: the plugin files under their staging path', () => {
  const m = pluginVerifiedFiles(LSCACHE_PLUGIN_SLUG, new Map([['a/b.php', { md5: ['m1', 'm2'], sha256: ['s'] }]]));
  assert.deepEqual([...m], [['wp-content/plugins/litespeed-cache/a/b.php', 'm1']]);
  assert.equal(pluginVerifiedFiles(LSCACHE_PLUGIN_SLUG, null).size, 0);
});

test('plugin steps: argv only, fixed extraction code refusing entries outside the plugin folder', () => {
  const x = lscachePluginCommands.extract();
  assert.equal(x[0], 'php');
  assert.equal(x[1], '-r');
  assert.equal(x[2], EXTRACT_PLUGIN_PHP);
  assert.equal(x.length, 6);
  assert.ok(x[3].endsWith('/plugin-lscache.zip'));
  assert.ok(x[4].endsWith('/wp-content/plugins'));
  assert.equal(x[5], 'litespeed-cache');
  for (const piece of ['strpos($n, $slug . "/") !== 0', 'strpos($n, "\\0")', 'preg_match("#(^|/)\\.\\.?(/|$)#", $n)', '$z->extractTo($dest)']) {
    assert.ok(EXTRACT_PLUGIN_PHP.includes(piece), piece);
  }
  assert.deepEqual(lscachePluginCommands.activate().slice(0, 4), ['wp', 'plugin', 'activate', 'litespeed-cache']);
  assert.deepEqual(lscachePluginCommands.remove().slice(0, 3), ['rm', '-rf', '--']);
  assert.ok(lscachePluginCommands.remove()[3].endsWith('/wp-content/plugins/litespeed-cache'));
});

test('wp-config: WP_CACHE defined only with the plugin (the plugin then never edits it); .htaccess for Apache and OpenLiteSpeed', () => {
  assert.ok(!wpConfigPhp().includes('WP_CACHE'));
  assert.ok(wpConfigPhp({ wpCache: true }).includes("define('WP_CACHE', true);"));
  assert.notEqual(verifiedFilesOf(null, { wpCache: true }).get('wp-config.php'), verifiedFilesOf(null).get('wp-config.php'));
  assert.equal(readsHtaccessRewrites('apache-php8.3'), true);
  assert.equal(readsHtaccessRewrites('litespeed-php8.3'), true);
  assert.equal(readsHtaccessRewrites('nginx-php8.3'), false);
});
