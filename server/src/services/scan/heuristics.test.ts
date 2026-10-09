import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppProfileId, ChangeKind } from '@oblimint/shared';
import type { AnalysisDataPath } from '../maintenance/contracts';
import {
  codeDirsOf, HEURISTIC_RULE_COUNT, HEURISTIC_RULES, inExpectedDir, isBinary, isExecutablePath, isWordPressCodePath, lineAt,
  longestBase64Run, runHeuristics, type HeuristicContext, type HeuristicRuleId,
} from './heuristics';

// Rule table of docs/P3-PLAN.md §9.2: one positive and one negative sample per rule.
// Samples are assembled from fragments (never a contiguous real-malware string in the repo).

const EV = ['ev', 'al'].join('');
const B64D = ['base64', '_decode'].join('');
const SYS = ['sys', 'tem'].join('');
const SHX = ['shell', '_exec'].join('');
const G = ['$', '_GET'].join('');
const P = ['$', '_POST'].join('');
const R = ['$', '_REQUEST'].join('');

const ctx = (o: Partial<HeuristicContext> = {}): HeuristicContext => ({ appProfile: null, dataPaths: [], codeDirs: null, ...o });

function rules(path: string, content: string | Buffer | null, o: { change?: ChangeKind; mode?: number | null; ctx?: Partial<HeuristicContext> } = {}): HeuristicRuleId[] {
  const data = content === null ? null : Buffer.isBuffer(content) ? content : Buffer.from(content, 'latin1');
  return runHeuristics({ path, change: o.change ?? 'modified', data, mode: o.mode ?? null }, ctx(o.ctx)).map((f) => f.rule as HeuristicRuleId);
}

const has = (list: HeuristicRuleId[], id: HeuristicRuleId) => assert.ok(list.includes(id), `expected ${id} in [${list.join(', ')}]`);
const hasNot = (list: HeuristicRuleId[], id: HeuristicRuleId) => assert.ok(!list.includes(id), `unexpected ${id} in [${list.join(', ')}]`);

const LEGIT_WP_PLUGIN = `<?php
/**
 * Plugin Name: Hello Oblimint
 */
defined('ABSPATH') || exit;
add_action('init', function () {
  $page = isset(${G}['page']) ? sanitize_key(${G}['page']) : 'home';
  $data = array_filter(${P});
  $items = array_map('trim', (array) ${P});
  $ok = $wpdb->prepare('SELECT * FROM t WHERE id = %d', (int) ${G}['id']);
  $png = base64_encode(file_get_contents(__DIR__ . '/logo.png'));
  include __DIR__ . '/inc/' . 'helpers.php';
  require_once $_SERVER['DOCUMENT_ROOT'] . '/wp-load.php';
  $this->assertTrue(true);
  $pdo->exec($sql);
  curl_exec($ch);
  echo json_encode(['page' => $page]);
});
`;

test('rule table: every id of the plan with its points and severity', () => {
  const expected: Array<[HeuristicRuleId, number, string]> = [
    ['exec.new-outside-expected', 25, 'warn'], ['exec.in-media-dir', 60, 'warn'], ['exec.htaccess-handler', 50, 'warn'],
    ['php.eval-decode', 70, 'critical'], ['php.preg-e', 70, 'critical'], ['php.request-exec', 70, 'critical'],
    ['php.include-request', 70, 'critical'], ['php.dynamic-call', 60, 'warn'], ['php.assert-var', 50, 'warn'],
    ['php.create-function', 30, 'warn'], ['php.long-base64', 30, 'warn'], ['php.hex-chains', 30, 'warn'],
    ['php.one-liner', 30, 'warn'], ['php.nul-byte', 40, 'warn'],['content.php-in-media', 80, 'critical'], ['file.double-ext', 40, 'warn'],
    ['file.hidden-php', 40, 'warn'], ['file.elf', 60, 'warn'], ['datapath.code', 80, 'critical'],
    ['perm.world-writable', 5, 'info'], ['perm.exec-bit', 5, 'info'], ['scan.skipped', 0, 'info'], ['scan.exec-uninspected', 30, 'warn'],
  ];
  assert.equal(HEURISTIC_RULE_COUNT, expected.length);
  for (const [id, points, severity] of expected) {
    assert.equal(HEURISTIC_RULES[id].points, points, id);
    assert.equal(HEURISTIC_RULES[id].severity, severity, id);
  }
});

test('executable classification', () => {
  for (const p of ['a.php', 'x/B.PHP', 'a.php3', 'a.php5', 'a.php8', 'a.phtml', 'a.pht', 'a.phps', 'a.phar', 'lib/a.inc', '.htaccess', 'x/.user.ini', 'x/.HTACCESS']) {
    assert.ok(isExecutablePath(p), p);
  }
  for (const p of ['a.js', 'a.html', 'php', 'a.php.txt', 'x.ini', 'user.ini', 'htaccess', 'a.phpx', 'img/a.jpg']) {
    assert.ok(!isExecutablePath(p), p);
  }
});

test('binary detection, line numbers, base64 runs', () => {
  assert.equal(isBinary(Buffer.from('hello\nworld')), false);
  assert.equal(isBinary(Buffer.from([0x89, 0x50, 0x00, 0x47])), true);
  assert.equal(lineAt('a\nb\nc', 0), 1);
  assert.equal(lineAt('a\nb\nc', 4), 3);
  const blob = 'Ab1'.repeat(1000);
  const [at, len] = longestBase64Run(`x = "${blob}";`);
  assert.equal(at, 5);
  assert.equal(len, 3000);
  assert.equal(longestBase64Run('A'.repeat(5000))[1], 0, 'one-character runs are not data');
});

test('exec.new-outside-expected: WordPress profile', () => {
  const wp = { appProfile: 'wordpress' as AppProfileId };
  for (const p of ['wp-content/plugins/x/x.php', 'wp-content/themes/t/functions.php', 'wp-content/mu-plugins/m.php', 'wp-admin/a.php', 'wp-includes/b.php', 'wp-login.php', 'index.php', 'blog/wp-cron.php']) {
    assert.ok(isWordPressCodePath(p), p);
    hasNot(rules(p, '<?php echo 1;', { change: 'added', ctx: wp }), 'exec.new-outside-expected');
  }
  has(rules('wp-content/x.php', '<?php echo 1;', { change: 'added', ctx: wp }), 'exec.new-outside-expected');
  has(rules('evil.php', '<?php echo 1;', { change: 'added', ctx: wp }), 'exec.new-outside-expected');
  hasNot(rules('evil.php', '<?php echo 1;', { change: 'modified', ctx: wp }), 'exec.new-outside-expected');
  hasNot(rules('wp-content/x.js', 'x', { change: 'added', ctx: wp }), 'exec.new-outside-expected');
});

test('exec.new-outside-expected: generic applications use the code directories of the base', () => {
  const codeDirs = codeDirsOf(['app/Http/Kernel.php', 'public/index.php', 'README.md']);
  assert.deepEqual([...codeDirs].sort(), ['app/Http', 'public']);
  assert.ok(inExpectedDir('app/Http/Controllers/New.php', codeDirs), 'sub-directory of a code dir');
  hasNot(rules('app/Http/Controllers/New.php', '<?php', { change: 'added', ctx: { codeDirs } }), 'exec.new-outside-expected');
  has(rules('storage/x.php', '<?php', { change: 'added', ctx: { codeDirs } }), 'exec.new-outside-expected');
  has(rules('shell.php', '<?php', { change: 'added', ctx: { codeDirs } }), 'exec.new-outside-expected');
  hasNot(rules('shell.php', '<?php', { change: 'added', ctx: { codeDirs: null } }), 'exec.new-outside-expected');
});

test('exec.in-media-dir', () => {
  for (const p of ['wp-content/uploads/2026/10/x.php', 'images/a.phtml', 'img/a.phar', 'media/x.php5', 'cache/c.php', 'tmp/t.php', 'files/f.php']) {
    has(rules(p, '<?php echo 1;'), 'exec.in-media-dir');
  }
  hasNot(rules('wp-content/plugins/files-manager.php', '<?php echo 1;'), 'exec.in-media-dir');
  hasNot(rules('uploads/photo.jpg', 'JPEG'), 'exec.in-media-dir');
  hasNot(rules('src/Images.php', '<?php'), 'exec.in-media-dir');
  for (const p of ['sites/default/files/x.php', 'wp-content/cache/x.php', 'public/Uploads/x.php', 'wp-content/plugins/p/uploads/x.php', 'wp-content/themes/t/images/x.php']) {
    has(rules(p, '<?php echo 1;'), 'exec.in-media-dir');
  }
  // Legitimate code trees named cache / files / tmp (libraries, frameworks, applications).
  for (const p of [
    'vendor/symfony/cache/Adapter/ArrayAdapter.php', 'vendor/psr/cache/src/CacheItemInterface.php', 'vendor/doctrine/cache/lib/Doctrine/Common/Cache/Cache.php',
    'bootstrap/cache/packages.php', 'apps/files/lib/Controller/ViewController.php', 'core/lib/Drupal/Core/Cache/Cache.php',
    'wp-content/plugins/p/includes/cache/x.php', 'vendor/x/media/y.php', 'node_modules/x/images/y.php',
  ]) {
    hasNot(rules(p, '<?php echo 1;'), 'exec.in-media-dir');
  }
});

test('a NUL byte never switches the PHP content checks off', () => {
  const nul = String.fromCharCode(0);
  const shell = `<?php /*${nul}*/ ${EV}(${B64D}(${P}['x'])); ${SYS}(${G}['c']);`;
  const list = rules('wp-content/plugins/a/a.php', shell);
  has(list, 'php.eval-decode');
  has(list, 'php.request-exec');
  has(list, 'php.nul-byte');
  const padded = Buffer.concat([Buffer.from('<?php '), Buffer.alloc(9000, 0), Buffer.from(` ${SYS}(${G}['c']);`)]);
  has(rules('x.inc', padded), 'php.request-exec');
  hasNot(rules('a.php', '<?php echo 1;'), 'php.nul-byte');
  // Phar archives are binary by design: no NUL finding, no content checks on the binary.
  hasNot(rules('composer.phar', Buffer.concat([Buffer.from('<?php __HALT_COMPILER(); '), Buffer.alloc(16, 0)])), 'php.nul-byte');
});

test('exec.htaccess-handler', () => {
  has(rules('.htaccess', 'RewriteEngine On\nAddHandler application/x-httpd-php .jpg\n'), 'exec.htaccess-handler');
  has(rules('up/.htaccess', '<FilesMatch "x">\n  SetHandler application/x-httpd-php\n</FilesMatch>'), 'exec.htaccess-handler');
  has(rules('.htaccess', 'php_value auto_prepend_file /tmp/x'), 'exec.htaccess-handler');
  has(rules('.user.ini', 'auto_prepend_file = "/srv/data/x.jpg"'), 'exec.htaccess-handler');
  has(rules('.htaccess', 'AddType application/x-httpd-php .png'), 'exec.htaccess-handler');
  const f = runHeuristics({ path: '.htaccess', change: 'modified', data: Buffer.from('# BEGIN\nRewriteEngine On\nAddHandler x .y\n'), mode: null }, ctx())
    .find((x) => x.rule === 'exec.htaccess-handler');
  assert.equal(f?.line, 3);
  hasNot(rules('.htaccess', '# BEGIN WordPress\nRewriteEngine On\nRewriteRule . /index.php [L]\n# END WordPress\n'), 'exec.htaccess-handler');
  hasNot(rules('.user.ini', 'memory_limit = 256M\nupload_max_filesize = 64M\n'), 'exec.htaccess-handler');
  hasNot(rules('doc.txt', 'AddHandler application/x-httpd-php'), 'exec.htaccess-handler');
});

test('php.eval-decode', () => {
  has(rules('a.php', `<?php @${EV}(${B64D}("ZWNobyAxOw=="));`), 'php.eval-decode');
  has(rules('a.php', `<?php ${EV}( gzinflate( str_rot13( $x ) ) );`), 'php.eval-decode');
  has(rules('a.php', `<?php ${EV}(strrev($p));`), 'php.eval-decode');
  hasNot(rules('a.php', `<?php $y = ${B64D}($x); echo $y; // ${EV} is evil`), 'php.eval-decode');
  hasNot(rules('a.php', `<?php $math->${EV}($expr);`), 'php.eval-decode');
});

test('php.preg-e', () => {
  has(rules('a.php', `<?php preg_replace("/.*/e", ${P}['x'], '');`), 'php.preg-e');
  has(rules('a.php', `<?php preg_replace('#(.+)#ie', 'strtoupper("\\\\1")', $s);`), 'php.preg-e');
  has(rules('a.php', `<?php preg_replace('{x}e', $c, $s);`), 'php.preg-e');
  hasNot(rules('a.php', `<?php preg_replace('/\\s+/i', ' ', $s); preg_replace('/e/', 'E', $s);`), 'php.preg-e');
  hasNot(rules('a.php', `<?php preg_replace_callback('/x/', fn($m) => $m[0], $s);`), 'php.preg-e');
});

test('php.request-exec', () => {
  has(rules('a.php', `<?php ${SYS}(${G}['cmd']);`), 'php.request-exec');
  has(rules('a.php', `<?php echo ${SHX}('ls ' . ${R}['d']);`), 'php.request-exec');
  has(rules('a.php', `<?php passthru( "ping " . $_SERVER['HTTP_X'] );`), 'php.request-exec');
  has(rules('a.php', '<?php $o = `' + `${R}[c]` + '`;'), 'php.request-exec');
  hasNot(rules('a.php', `<?php ${SYS}('ls -la'); $pdo->exec(${P}['q']); curl_exec($ch);`), 'php.request-exec');
  hasNot(rules('a.php', "<?php $sql = 'SELECT `id` FROM `t`';"), 'php.request-exec');
});

test('php.include-request', () => {
  has(rules('a.php', `<?php include(${G}['page'] . '.php');`), 'php.include-request');
  has(rules('a.php', `<?php require_once 'pages/' . ${R}['p'];`), 'php.include-request');
  hasNot(rules('a.php', `<?php include $_SERVER['DOCUMENT_ROOT'] . '/x.php'; include 'header.php';`), 'php.include-request');
  hasNot(rules('a.php', LEGIT_WP_PLUGIN), 'php.include-request');
});

test('php.dynamic-call', () => {
  has(rules('a.php', `<?php ${G}['f'](${G}['a']);`), 'php.dynamic-call');
  has(rules('a.php', `<?php call_user_func(${P}['cb'], 1);`), 'php.dynamic-call');
  has(rules('a.php', `<?php array_map(${R}['f'], [1]);`), 'php.dynamic-call');
  has(rules('a.php', `<?php $fn = ${G}['fn'];\n$arg = 1;\n$fn($arg);`), 'php.dynamic-call');
  hasNot(rules('a.php', LEGIT_WP_PLUGIN), 'php.dynamic-call');
  hasNot(rules('a.php', `<?php $fn = 'strtoupper'; $fn('x'); $id = ${G}['id']; echo $id;`), 'php.dynamic-call');
});

test('php.assert-var / php.create-function', () => {
  has(rules('a.php', '<?php assert($code);'), 'php.assert-var');
  has(rules('a.php', '<?php @assert( @$_POST["x"] );'), 'php.assert-var');
  hasNot(rules('a.php', '<?php assert(is_int(1)); $this->assert($x); Assert::assert($y);'), 'php.assert-var');
  has(rules('a.php', "<?php $f = create_function('$a', 'return $a;');"), 'php.create-function');
  hasNot(rules('a.php', '<?php $this->create_function(); my_create_function_x();'), 'php.create-function');
});

test('php.long-base64 (30 from 2 KiB, 50 from 20 KiB)', () => {
  const small = runHeuristics({ path: 'a.php', change: 'added', data: Buffer.from(`<?php $x = "${'QmFz64'.repeat(400)}";`), mode: null }, ctx());
  assert.equal(small.find((f) => f.rule === 'php.long-base64')?.score, 30);
  const big = runHeuristics({ path: 'a.php', change: 'added', data: Buffer.from(`<?php $x = "${'QmFz64'.repeat(4000)}";`), mode: null }, ctx());
  assert.equal(big.find((f) => f.rule === 'php.long-base64')?.score, 50);
  hasNot(rules('a.php', `<?php $x = "${'QmFz64'.repeat(300)}";`), 'php.long-base64');
  hasNot(rules('a.js', `var x = "${'QmFz64'.repeat(4000)}";`), 'php.long-base64');
});

test('php.hex-chains', () => {
  has(rules('a.php', `<?php $f = "${'\\x65\\x76'.repeat(12)}";`), 'php.hex-chains');
  has(rules('a.php', `<?php $f = "${'\\145\\166'.repeat(12)}";`), 'php.hex-chains');
  has(rules('a.php', `<?php $f = ${'chr(101) . '.repeat(9)}'';`), 'php.hex-chains');
  hasNot(rules('a.php', '<?php $nl = "\\x0a\\x0d"; $c = chr(65) . chr(66);'), 'php.hex-chains');
});

test('php.one-liner', () => {
  has(rules('a.php', `<?php ${'$a=1;'.repeat(1100)}`), 'php.one-liner');
  hasNot(rules('a.php', `<?php\n${'$a = 1;\n'.repeat(2000)}`), 'php.one-liner');
  hasNot(rules('a.min.js', 'x'.repeat(6000)), 'php.one-liner');
});

test('content.php-in-media', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF<?php echo 1; ?>')]);
  has(rules('uploads/x.jpg', jpeg), 'content.php-in-media');
  has(rules('a.gif', 'GIF89a<?php phpinfo();'), 'content.php-in-media');
  has(rules('notes.txt', 'hello <?= $x ?>'), 'content.php-in-media');
  hasNot(rules('readme.txt', '=== Plugin ===\n<?php my_function(); ?>'), 'content.php-in-media');
  hasNot(rules('a.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.from('<?=')])), 'content.php-in-media');
  hasNot(rules('a.svg', '<?xml version="1.0"?><svg/>'), 'content.php-in-media');
});

test('file.double-ext / file.hidden-php', () => {
  has(rules('up/x.php.jpg', 'x'), 'file.double-ext');
  has(rules('up/x.jpg.php', '<?php'), 'file.double-ext');
  has(rules('x.phtml.png', 'x'), 'file.double-ext');
  hasNot(rules('config.php.dist', 'x'), 'file.double-ext');
  hasNot(rules('jquery.min.js', 'x'), 'file.double-ext');
  hasNot(rules('class.wp-x.php', '<?php'), 'file.double-ext');
  has(rules('wp-content/.cache.php', '<?php'), 'file.hidden-php');
  hasNot(rules('.php-cs-fixer.dist.php', '<?php'), 'file.hidden-php');
  hasNot(rules('.phpstorm.meta.php', '<?php'), 'file.hidden-php');
  hasNot(rules('.htaccess', 'x'), 'file.hidden-php');
});

test('file.elf', () => {
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]), Buffer.alloc(64)]);
  has(rules('bin/miner', elf), 'file.elf');
  hasNot(rules('bin/tool.sh', '#!/bin/sh\necho ELF'), 'file.elf');
});

test('datapath.code: typed data paths only accept their types, never code', () => {
  const dataPaths: AnalysisDataPath[] = [
    { path: 'wp-content/uploads', policy: 'typed', allowedExtensions: ['jpg', 'png', 'pdf'] },
    { path: 'var', policy: 'persistent', allowedExtensions: null },
  ];
  has(rules('wp-content/uploads/shell.php', '<?php', { ctx: { dataPaths } }), 'datapath.code');
  has(rules('wp-content/uploads/a.jpg', 'GIF89a<?php x', { ctx: { dataPaths } }), 'datapath.code');
  has(rules('wp-content/uploads/a.exe', 'MZ', { ctx: { dataPaths } }), 'datapath.code');
  hasNot(rules('wp-content/uploads/2026/a.JPG', Buffer.from([0xff, 0xd8, 0xff]), { ctx: { dataPaths } }), 'datapath.code');
  hasNot(rules('var/cache.php', '<?php', { ctx: { dataPaths } }), 'datapath.code');
  hasNot(rules('wp-content/uploads.php', '<?php', { ctx: { dataPaths } }), 'datapath.code');
  hasNot(rules('wp-content/uploads/new.php', '<?php', { change: 'added', ctx: { dataPaths, codeDirs: new Set() } }), 'exec.new-outside-expected');
});

test('perm.world-writable / perm.exec-bit (known modes only)', () => {
  has(rules('a.php', '<?php', { mode: 0o666 }), 'perm.world-writable');
  hasNot(rules('a.php', '<?php', { mode: 0o644 }), 'perm.world-writable');
  has(rules('a.php', '<?php', { mode: 0o755 }), 'perm.exec-bit');
  hasNot(rules('bin/console', '#!/usr/bin/env php\n<?php', { mode: 0o755 }), 'perm.exec-bit');
  hasNot(rules('a.php', '<?php', { mode: null }), 'perm.exec-bit');
  hasNot(rules('a.php', '<?php', { mode: null }), 'perm.world-writable');
});

test('deletions and a legitimate plugin produce no finding', () => {
  assert.deepEqual(rules('evil.php', null, { change: 'deleted' }), []);
  const legit = rules('wp-content/plugins/hello/hello.php', LEGIT_WP_PLUGIN, { change: 'added', ctx: { appProfile: 'wordpress' } });
  assert.deepEqual(legit, []);
});

test('a hostile 4 MiB file is evaluated quickly (bounded expressions)', () => {
  const hostile = `<?php ${EV}(` + ' '.repeat(1024 * 1024) + `preg_replace('` + 'a'.repeat(1024 * 1024) + `include ${'('.repeat(1024 * 1024)}`;
  const t0 = Date.now();
  rules('a.php', hostile);
  assert.ok(Date.now() - t0 < 5_000, `took ${Date.now() - t0} ms`);
});

// ── Regression: a pristine WordPress core must score 0 (P3 Linux validation) ──
// Excerpts reproduce the shapes of WordPress 7.1 core files that the first
// version of the rules flagged (blocked at 80 before publication).

test('pristine WordPress shapes produce no finding', () => {
  const wp = { appProfile: 'wordpress' as AppProfileId };
  const samples: Array<[string, string]> = [
    // load.php / class-wp-rest-request.php: Markdown backticks in a docblock.
    ['wp-includes/load.php', `<?php\n/**\n * Adds magic quotes to \`${G}\`, \`${P}\`, \`$_COOKIE\`, and \`$_SERVER\`.\n */\nfunction wp_magic_quotes() {\n\t${G} = add_magic_quotes( ${G} );\n}\n`],
    ['wp-includes/rest-api/class-wp-rest-server.php', `<?php\n\t/**\n\t * Uses \`${G}\`, \`${P}\`, \`$_SERVER\` (see \`$_FILES\`).\n\t */\n\t$request->set_query_params( wp_unslash( ${G} ) );\n`],
    // wp-cron.php: the request-fed variable is named in a comment followed by parentheses.
    ['wp-cron.php', `<?php\n$doing_wp_cron = ${G}['doing_wp_cron'];\n/*\n * The cron lock: a unix timestamp of when the cron was spawned.\n * $doing_wp_cron (the key) is compared to the transient.\n */\nif ( $doing_cron_transient !== $doing_wp_cron ) { return; }\n`],
    // SimplePie / Text_Diff: PHPStan assertions.
    ['wp-includes/SimplePie/src/File.php', "<?php\nassert($this->body !== null); // For PHPStan\nassert(is_array($info) && $info['redirect_count'] >= 0);\nassert($pos !== null, 'For PHPStan: $pos >= 1.');\n"],
    // SimplePie cache classes below wp-includes/…/library/…/Cache/.
    ['wp-includes/SimplePie/library/SimplePie/Cache/File.php', '<?php\nclass SimplePie_Cache_File {}\n'],
    // getID3 module names.
    ['wp-includes/ID3/module.audio.mp3.php', '<?php\nclass getid3_mp3 {}\n'],
    // sodium_compat / SimplePie: binary constants as escaped bytes.
    ['wp-includes/sodium_compat/src/Core/Curve25519/H.php', `<?php\nconst L = "${'\\xed\\xd3\\xf5\\x5c\\x1a\\x63\\x12\\x58\\xd6\\x9c\\xf7\\xa2\\xde\\xf9\\xde\\x14'}${'\\x00'.repeat(15)}\\x10";\n`],
    ['wp-includes/SimplePie/src/Misc.php', `<?php\nif (substr($data, 0, 20) === "${'\\x00\\x00\\x00\\x3C\\x00\\x00\\x00\\x3F'.repeat(3)}") {}\n`],
    // formatting.php / Parser.php: very long lines of string literals (data, not packed code).
    ['wp-includes/formatting.php', `<?php\n$entities = array( ${Array.from({ length: 900 }, (_, k) => `'&#x1f468;&#x${k.toString(16)};'`).join(', ')} );\n`],
    ['wp-includes/SimplePie/src/Parser.php', `<?php\nreturn '<!DOCTYPE rss [ ${'<!ENTITY nbsp "&#x00A0;"> '.repeat(300)}]>';\n`],
  ];
  for (const [path, content] of samples) {
    assert.deepEqual(rules(path, content, { change: 'added', ctx: wp }), [], path);
    assert.deepEqual(rules(path, content, { change: 'modified', ctx: wp }), [], path);
  }
});

test('code hidden next to comments / strings is still found (no lexer bypass)', () => {
  const cmd = `${SYS}(${G}['c']);`;
  has(rules('a.php', `<?php /* a */ ${cmd} /* b */`), 'php.request-exec');
  // ?> ends a line comment: the call after the next open tag runs.
  has(rules('a.php', `<?php // x ?> <?php ${cmd}`), 'php.request-exec');
  // PHP 8 attribute, not a comment.
  has(rules('a.php', `<?php #[A] ${cmd}`), 'php.request-exec');
  // A string nested in an interpolation does not open a comment.
  has(rules('a.php', `<?php $s = "{$a[" /* "]}"; ${cmd} /* */`), 'php.request-exec');
  // Inline HTML is never blanked (a code reading we do not share stays visible).
  has(rules('a.php', `<html> ${cmd}`), 'php.request-exec');
  // short_open_tag on (a .user.ini may set it): "<? // <?php '" is a comment, the call runs.
  has(rules('a.php', `<? // <?php '\n${cmd}\n'`), 'php.request-exec');
  // short_open_tag off: "<? '" is HTML, the call after <?php runs.
  has(rules('a.php', `<? $a = '\n<?php ${cmd} ?>\n';`), 'php.request-exec');
  // Interpolating literals keep their request input.
  has(rules('a.php', `<?php ${SYS}("ls {${G}['d']}");`), 'php.request-exec');
  has(rules('a.php', `<?php $o = \`ls {${G}["d"]}\`;`), 'php.request-exec');
  // Request input quoted in Markdown backticks inside a string is not an execution.
  hasNot(rules('a.php', `<?php __( 'Reads \`${G}\` and \`${P}\`.' ); $x = "a, \`b\`";`), 'php.request-exec');
  // A comment never feeds a dynamic call, code still does.
  hasNot(rules('a.php', `<?php $f = ${G}['f'];\n// $f (the callback) is checked\n`), 'php.dynamic-call');
  has(rules('a.php', `<?php $f = ${G}['f']; /* x */ $f ( 1 );`), 'php.dynamic-call');
  // eval of decoded data is found with the decoder in a string argument too.
  has(rules('a.php', `<?php /* ok */ @${EV}(${B64D}('ZWNobyAxOw=='));`), 'php.eval-decode');
});

test('php.assert-var: string-evaluating shapes only', () => {
  has(rules('a.php', '<?php assert($code);'), 'php.assert-var');
  has(rules('a.php', '<?php assert($c["x"], "m");'), 'php.assert-var');
  has(rules('a.php', `<?php assert(${B64D}($x));`), 'php.assert-var');
  has(rules('a.php', `<?php assert(trim(${R}['x']));`), 'php.assert-var');
  hasNot(rules('a.php', '<?php assert($this->registry !== null); assert($n > 0, "positive");'), 'php.assert-var');
  hasNot(rules('a.php', '<?php /* assert($code); */ echo 1;'), 'php.assert-var');
});

test('library trees: cache directories and module names are code, media directories are not', () => {
  for (const p of ['wp-includes/SimplePie/library/SimplePie/Cache/Redis.php', 'libs/cache/x.php', 'wp-admin/includes/cache/x.php']) {
    hasNot(rules(p, '<?php echo 1;'), 'exec.in-media-dir');
  }
  for (const p of ['wp-content/cache/x.php', 'cache/x.php', 'wp-content/uploads/x.php', 'wp-includes/images/x.php']) {
    has(rules(p, '<?php echo 1;'), 'exec.in-media-dir');
  }
  hasNot(rules('wp-includes/ID3/module.graphic.jpg.php', '<?php'), 'file.double-ext');
  hasNot(rules('wp-content/plugins/p/getid3/module.audio.ogg.php', '<?php'), 'file.double-ext');
  has(rules('wp-content/plugins/p/shell.jpg.php', '<?php'), 'file.double-ext');
  has(rules('wp-content/uploads/lib/shell.jpg.php', '<?php'), 'file.double-ext');
  has(rules('wp-includes/x.php.jpg', 'x'), 'file.double-ext');
});

test('php.hex-chains: escaped TEXT only; php.one-liner: packed code only', () => {
  has(rules('a.php', `<?php $f = "${'\\x73\\x79\\x73\\x74\\x65\\x6d'.repeat(4)}";`), 'php.hex-chains');
  hasNot(rules('a.php', `<?php $k = "${'\\x00\\x9c\\xf7\\xa2'.repeat(8)}";`), 'php.hex-chains');
  has(rules('a.php', `<?php $p = "${'$a=1;'.repeat(1100)}"; ${EV}($p);`), 'php.one-liner');
  hasNot(rules('a.php', `<?php $d = array(${"'abcdefgh', ".repeat(800)});`), 'php.one-liner');
});
