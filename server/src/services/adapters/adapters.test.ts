import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AdapterUpdate } from '@oblimint/shared';
import { localContentTree } from '../maintenance/contracts';
import { appPath, extractJson, safeDocroot, type ToolsAdapterContext, type ToolsStepResult } from './common';
import { composerCommands, composerUpdateArgv, parseComposerOutdated } from './composer';
import { drupalAdapter, drupalCommands, drupalKindOf, parseDrupalVersion } from './drupal';
import { nextcloudAdapter, nextcloudCommands, parseAppUpdateShowOnly, parseInfoXmlVersion, parseUpdateCheck } from './nextcloud';
import { ADAPTERS } from './registry';
import { allowedByMinorOnly, classifyLevel, compareVersions, versionParts, wordpressCoreLevel } from './versions';
import {
  parseCoreCheckUpdate, parseExtensionList, parseLanguageList, planWordPressUpdate, wordpressAdapter, wpCommands,
} from './wordpress';

// ─────────────────────────────────────────────────────────────────────────────
// Adapters, pure layer (docs/P3-PLAN.md §11): version levels, argv builders
// (fixed argv, validated inputs, WP-CLI global flags), output parsers against
// fixtures of the real CLIs, update selection, detection on a tree.
// ─────────────────────────────────────────────────────────────────────────────

// ── versions ─────────────────────────────────────────────────────────────────

test('versions: parts, compare, levels', () => {
  assert.deepEqual(versionParts('v1.2.3-beta1'), [1, 2, 3]);
  assert.equal(versionParts('dev-main'), null);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('x', '1'), null);
  assert.equal(classifyLevel('1.2.3', '2.0.0'), 'major');
  assert.equal(classifyLevel('1.2.3', '1.3.0'), 'minor');
  assert.equal(classifyLevel('1.2.3', '1.2.4'), 'patch');
  assert.equal(classifyLevel('5.3', '5.3.1'), 'patch');
  assert.equal(classifyLevel(null, '1.0'), 'unknown');
  assert.equal(classifyLevel('dev-main', '1.0'), 'unknown');
  // WordPress: x.Y is the major branch.
  assert.equal(wordpressCoreLevel('6.5.5', '6.6.2'), 'major');
  assert.equal(wordpressCoreLevel('6.6.1', '6.6.2'), 'patch');
  assert.equal(wordpressCoreLevel('6.9', '7.0'), 'major');
  assert.equal(allowedByMinorOnly('major', true), false);
  assert.equal(allowedByMinorOnly('minor', true), true);
  assert.equal(allowedByMinorOnly('unknown', true), true);
  assert.equal(allowedByMinorOnly('major', false), true);
});

// ── helpers ──────────────────────────────────────────────────────────────────

test('extractJson tolerates notices around the document', () => {
  assert.deepEqual(extractJson('[{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(extractJson('PHP Deprecated: foo in /srv/app/wp-config.php on line 3\n[{"a":1}]\n'), [{ a: 1 }]);
  assert.deepEqual(extractJson('Warning: x\n{\n  "installed": []\n}\n'), { installed: [] });
  assert.equal(extractJson('Success: WordPress is at the latest version.'), undefined);
  assert.equal(extractJson(''), undefined);
});

test('docroot: safe relative path only', () => {
  assert.equal(safeDocroot('public'), 'public');
  assert.equal(safeDocroot('/web/'), 'web');
  assert.equal(safeDocroot('../etc'), '');
  assert.equal(safeDocroot('a b'), '');
  assert.equal(appPath(''), '/srv/app');
  assert.equal(appPath('web'), '/srv/app/web');
});

// ── WordPress ────────────────────────────────────────────────────────────────

const WP_FLAGS = ['--path=/srv/app', '--skip-plugins', '--skip-themes', '--no-color'];

test('wordpress: argv builders', () => {
  assert.deepEqual(wpCommands.coreCheckUpdate(''), ['wp', 'core', 'check-update', '--format=json', ...WP_FLAGS]);
  assert.deepEqual(wpCommands.pluginList('')[0], 'wp');
  assert.ok(wpCommands.pluginList('').includes('--update=available'));
  assert.ok(wpCommands.pluginList('').includes('--format=json'));
  assert.deepEqual(wpCommands.coreUpdate('', true), ['wp', 'core', 'update', '--minor', ...WP_FLAGS]);
  assert.deepEqual(wpCommands.coreUpdate('wp', false), ['wp', 'core', 'update', '--path=/srv/app/wp', '--skip-plugins', '--skip-themes', '--no-color']);
  assert.deepEqual(wpCommands.extensionUpdate('', 'plugin', 'all', false), ['wp', 'plugin', 'update', '--all', ...WP_FLAGS]);
  // Invalid slugs never reach argv (no option injection, no shell).
  assert.deepEqual(wpCommands.extensionUpdate('', 'theme', ['twentytwentyfour', '--exec=evil', 'a;rm -rf /'], true),
    ['wp', 'theme', 'update', 'twentytwentyfour', '--minor', ...WP_FLAGS]);
  assert.deepEqual(wpCommands.languageUpdate('', 'core'), ['wp', 'language', 'core', 'update', ...WP_FLAGS]);
  assert.deepEqual(wpCommands.languageUpdate('', 'plugin'), ['wp', 'language', 'plugin', 'update', '--all', ...WP_FLAGS]);
  assert.deepEqual(wpCommands.coreUpdateDb(''), ['wp', 'core', 'update-db', ...WP_FLAGS]);
  const all = [
    wpCommands.coreCheckUpdate(''), wpCommands.pluginList(''), wpCommands.themeList(''), wpCommands.languageCoreList(''),
    wpCommands.coreUpdate('', false), wpCommands.extensionUpdate('', 'plugin', ['x'], false), wpCommands.languageUpdate('', 'theme'),
    wpCommands.coreUpdateDb(''),
  ];
  for (const argv of all) {
    for (const f of ['--skip-plugins', '--skip-themes', '--no-color']) assert.ok(argv.includes(f), `${argv.join(' ')} has ${f}`);
  }
});

// Fixtures: real WP-CLI 2.x output shapes.
const CORE_CHECK = 'PHP Notice:  Undefined index: x in /srv/app/wp-config.php on line 90\n'
  + '[{"version":"6.6.2","update_type":"major","package_url":"https:\\/\\/downloads.wordpress.org\\/release\\/wordpress-6.6.2.zip"},'
  + '{"version":"6.5.5","update_type":"minor","package_url":"https:\\/\\/downloads.wordpress.org\\/release\\/wordpress-6.5.5-partial-3.zip"}]\n';
const PLUGINS = '[{"name":"akismet","title":"Akismet Anti-spam: Spam Protection","version":"5.3.2","update_version":"5.3.3"},'
  + '{"name":"woocommerce","title":"WooCommerce","version":"8.9.3","update_version":"9.1.2"},'
  + '{"name":"../evil","title":"x","version":"1","update_version":"2"},'
  + '{"name":"no-update","title":"x","version":"1.0","update_version":""}]';
const THEMES = '[{"name":"twentytwentyfour","title":"Twenty Twenty-Four","version":"1.1","update_version":"1.2"}]';
const LANGS = '[{"language":"fr_FR","english_name":"French (France)","update":"available"},{"language":"de_DE","english_name":"German","update":"none"}]';

test('wordpress: parsers', () => {
  const core = parseCoreCheckUpdate(CORE_CHECK, '6.5.3');
  assert.deepEqual(core.map((u) => [u.newVersion, u.level]), [['6.6.2', 'major'], ['6.5.5', 'patch']]);
  assert.equal(core[0].kind, 'core');
  assert.equal(core[0].currentVersion, '6.5.3');
  assert.deepEqual(parseCoreCheckUpdate('Success: WordPress is at the latest version.\n', '6.6.2'), []);

  const plugins = parseExtensionList(PLUGINS, 'plugin');
  assert.deepEqual(plugins.map((u) => [u.name, u.currentVersion, u.newVersion, u.level]), [
    ['akismet', '5.3.2', '5.3.3', 'patch'],
    ['woocommerce', '8.9.3', '9.1.2', 'major'],
  ]);
  assert.equal(plugins[0].title, 'Akismet Anti-spam: Spam Protection');
  assert.deepEqual(parseExtensionList(THEMES, 'theme').map((u) => [u.kind, u.level]), [['theme', 'minor']]);
  assert.deepEqual(parseExtensionList('Error: Error establishing a database connection.', 'plugin'), []);
  assert.deepEqual(parseLanguageList(LANGS).map((u) => [u.kind, u.name]), [['translation', 'fr_FR']]);
});

test('wordpress: update plan', () => {
  const available: AdapterUpdate[] = [
    ...parseCoreCheckUpdate(CORE_CHECK, '6.5.3'),
    ...parseExtensionList(PLUGINS, 'plugin'),
    ...parseExtensionList(THEMES, 'theme'),
    ...parseLanguageList(LANGS),
  ];
  let plan = planWordPressUpdate(available, {});
  assert.equal(plan.core?.newVersion, '6.6.2');
  assert.equal(plan.plugins?.slugs, 'all');
  assert.equal(plan.plugins?.updates.length, 2);
  assert.equal(plan.themes?.slugs, 'all');
  assert.equal(plan.translations.length, 1);

  plan = planWordPressUpdate(available, { minorOnly: true });
  assert.equal(plan.core?.newVersion, '6.5.5', 'minorOnly: latest of the current branch');
  assert.deepEqual(plan.plugins?.updates.map((u) => u.name), ['akismet']);
  assert.equal(plan.minorOnly, true);

  plan = planWordPressUpdate(available, { core: false, plugins: ['woocommerce', 'unknown'], themes: false, translations: false });
  assert.equal(plan.core, null);
  assert.deepEqual(plan.plugins?.slugs, ['woocommerce']);
  assert.equal(plan.themes, null);
  assert.deepEqual(plan.translations, []);
  assert.equal(planWordPressUpdate([], {}).plugins, null);
});

// ── Composer ─────────────────────────────────────────────────────────────────

const OUTDATED = JSON.stringify({
  installed: [
    { name: 'laravel/framework', direct_dependency: true, homepage: 'https://laravel.com', source: 'x', version: 'v11.9.2', latest: 'v11.20.0', 'latest-status': 'semver-safe-update', description: 'The Laravel Framework.', abandoned: false },
    { name: 'guzzlehttp/guzzle', version: '7.8.1', latest: '7.9.2', 'latest-status': 'semver-safe-update', description: 'Guzzle' },
    { name: 'symfony/console', version: 'v6.4.8', latest: 'v7.1.3', 'latest-status': 'update-possible', description: 'Console' },
    { name: 'psr/log', version: '3.0.0', latest: '3.0.0', 'latest-status': 'up-to-date' },
    { name: 'Bad Name', version: '1', latest: '2' },
  ],
});

test('composer: argv builders and parser', () => {
  assert.deepEqual(composerCommands.outdated({ direct: true }),
    ['composer', 'outdated', '--direct', '--format=json', '--no-plugins', '--no-interaction', '--no-ansi', '--working-dir=/srv/app']);
  assert.deepEqual(composerUpdateArgv({}), ['composer', 'update', '--no-progress', '--optimize-autoloader', '--no-interaction', '--no-ansi', '--working-dir=/srv/app']);
  assert.deepEqual(composerUpdateArgv({ minorOnly: true, noDev: true, packages: ['laravel/framework', '--evil', 'x;y/z'] }),
    ['composer', 'update', 'laravel/framework', '--patch-only', '--no-dev', '--no-progress', '--optimize-autoloader', '--no-interaction', '--no-ansi', '--working-dir=/srv/app']);
  assert.deepEqual(composerUpdateArgv({ composerCommand: 'install', noDev: true }),
    ['composer', 'install', '--no-dev', '--no-progress', '--optimize-autoloader', '--no-interaction', '--no-ansi', '--working-dir=/srv/app']);

  const u = parseComposerOutdated(`Deprecation Notice: something\n${OUTDATED}`);
  assert.deepEqual(u.map((x) => [x.name, x.currentVersion, x.newVersion, x.level, x.kind]), [
    ['laravel/framework', 'v11.9.2', 'v11.20.0', 'minor', 'package'],
    ['guzzlehttp/guzzle', '7.8.1', '7.9.2', 'minor', 'package'],
    ['symfony/console', 'v6.4.8', 'v7.1.3', 'major', 'package'],
  ]);
  assert.deepEqual(parseComposerOutdated('{"installed":[]}'), []);
  assert.deepEqual(parseComposerOutdated('not json'), []);
});

// ── Drupal ───────────────────────────────────────────────────────────────────

test('drupal: argv builders, kinds, version file', () => {
  assert.deepEqual(drupalCommands.outdated(),
    ['composer', 'outdated', 'drupal/*', '--format=json', '--no-plugins', '--no-interaction', '--no-ansi', '--working-dir=/srv/app']);
  assert.deepEqual(drupalCommands.update(null, false).slice(0, 4), ['composer', 'update', 'drupal/core-*', '--with-all-dependencies']);
  assert.deepEqual(drupalCommands.update(['drupal/token', 'laravel/framework'], true).slice(0, 5),
    ['composer', 'update', 'drupal/token', '--with-all-dependencies', '--patch-only']);
  assert.deepEqual(drupalCommands.updateDb('web'), ['php', '/srv/app/vendor/bin/drush', '--root=/srv/app/web', 'updatedb', '-y', '--no-interaction']);
  assert.deepEqual(drupalCommands.cacheRebuild('web'), ['php', '/srv/app/vendor/bin/drush', '--root=/srv/app/web', 'cache:rebuild', '--no-interaction']);
  assert.equal(drupalKindOf('drupal/core-recommended'), 'core');
  assert.equal(drupalKindOf('drupal/core'), 'core');
  assert.equal(drupalKindOf('drupal/token'), 'module');
  assert.equal(parseDrupalVersion("class Drupal {\n  const VERSION = '10.2.5';\n"), '10.2.5');
  const out = JSON.stringify({ installed: [
    { name: 'drupal/core-recommended', version: '10.2.5', latest: '10.3.1', 'latest-status': 'semver-safe-update' },
    { name: 'drupal/token', version: '1.13.0', latest: '1.14.0', 'latest-status': 'semver-safe-update' },
  ] });
  assert.deepEqual(parseComposerOutdated(out, drupalKindOf).map((x) => [x.kind, x.level]), [['core', 'minor'], ['module', 'minor']]);
});

// ── Nextcloud ────────────────────────────────────────────────────────────────

test('nextcloud: argv builders and text parsers', () => {
  assert.deepEqual(nextcloudCommands.updateCheck(''), ['php', '/srv/app/occ', 'update:check', '--no-interaction', '--no-ansi']);
  assert.deepEqual(nextcloudCommands.appUpdateAll(''), ['php', '/srv/app/occ', 'app:update', '--all', '--no-interaction', '--no-ansi']);
  assert.deepEqual(nextcloudCommands.appUpdateOne('', 'calendar'), ['php', '/srv/app/occ', 'app:update', 'calendar', '--no-interaction', '--no-ansi']);
  assert.throws(() => nextcloudCommands.appUpdateOne('', '--all'));
  assert.deepEqual(nextcloudCommands.upgrade(''), ['php', '/srv/app/occ', 'upgrade', '--no-interaction', '--no-ansi']);
  assert.deepEqual(nextcloudCommands.maintenanceOff(''), ['php', '/srv/app/occ', 'maintenance:mode', '--off', '--no-interaction', '--no-ansi']);

  const check = 'Update for calendar to version 4.7.15 is available.\nNextcloud 28.0.9 is available. Get more information on how to update at https://docs.nextcloud.com/server/28/admin_manual/maintenance/upgrade.html.\n2 updates available\n';
  assert.deepEqual(parseUpdateCheck(check, '28.0.4').map((u) => [u.kind, u.newVersion, u.level]), [['core', '28.0.9', 'patch']]);
  assert.deepEqual(parseUpdateCheck('Everything up to date\n', '28.0.4'), []);
  const show = 'calendar new version available: 4.7.15\ncontacts new version available: 6.0.0\nnot an app line\n';
  const apps = parseAppUpdateShowOnly(show, new Map([['calendar', '4.7.13'], ['contacts', '5.5.3']]));
  assert.deepEqual(apps.map((u) => [u.name, u.currentVersion, u.newVersion, u.level]), [
    ['calendar', '4.7.13', '4.7.15', 'patch'],
    ['contacts', '5.5.3', '6.0.0', 'major'],
  ]);
  assert.equal(parseInfoXmlVersion('<info><id>calendar</id>\n<version>4.7.13</version></info>'), '4.7.13');
});

// ── detection on a tree ──────────────────────────────────────────────────────

function tmpTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(process.env.OBLIMINT_TEST_TMP || os.tmpdir(), 'oblimint-adapters-detect-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

test('detection: every adapter on its tree', async (t) => {
  const wp = tmpTree({ 'wp-includes/version.php': "<?php\n$wp_version = '6.5.3';\n$wp_db_version = 57155;\n", 'composer.json': '{"name":"roots/bedrock"}' });
  const drupal = tmpTree({ 'web/core/lib/Drupal.php': "<?php class Drupal { const VERSION = '10.2.5'; }", 'vendor/bin/drush': '<?php', 'composer.json': '{}', 'composer.lock': '{}' });
  const nc = tmpTree({ 'occ': '<?php', 'version.php': "<?php\n$OC_Version = array(28,0,4,1);\n$OC_VersionString = '28.0.4';\n" });
  t.after(() => { for (const d of [wp, drupal, nc]) fs.rmSync(d, { recursive: true, force: true }); });

  assert.deepEqual(await wordpressAdapter.detectIn(localContentTree(wp), ''), { detected: true, version: '6.5.3', detail: null });
  assert.equal((await wordpressAdapter.detectIn(localContentTree(wp), 'public')).detected, false);
  assert.deepEqual(await ADAPTERS.composer.detectIn(localContentTree(wp), ''), { detected: true, version: null, detail: 'roots/bedrock · sans composer.lock' });
  assert.deepEqual(await drupalAdapter.detectIn(localContentTree(drupal), 'web'), { detected: true, version: '10.2.5', detail: null });
  assert.equal((await drupalAdapter.detectIn(localContentTree(wp), '')).detected, false);
  assert.deepEqual(await nextcloudAdapter.detectIn(localContentTree(nc), ''), { detected: true, version: '28.0.4', detail: null });
  assert.equal((await nextcloudAdapter.detectIn(localContentTree(drupal), '')).detected, false);
});

// ── adapters against a scripted exec ─────────────────────────────────────────

function fakeCtx(root: string, outputs: (argv: string[]) => Partial<ToolsStepResult>, options = {}): { ctx: ToolsAdapterContext; calls: Array<{ step: string; argv: string[]; ro: boolean }> } {
  const calls: Array<{ step: string; argv: string[]; ro: boolean }> = [];
  const ctx: ToolsAdapterContext = {
    siteId: 1, accountId: 1, runId: 9, action: 'update', options, workspace: localContentTree(root), docroot: '',
    log: () => {},
    exec: async (step, argv, opts) => {
      calls.push({ step, argv, ro: opts?.workspaceReadOnly === true });
      const o = outputs(argv);
      const stdout = o.stdout ?? '';
      return { ok: o.ok ?? true, exitCode: o.exitCode ?? 0, output: stdout, outputTruncated: false, timedOut: false, stdout, stderr: '' };
    },
  };
  return { ctx, calls };
}

test('wordpress adapter: listUpdates read-only, apply argv, postDeploy', async (t) => {
  const root = tmpTree({ 'wp-includes/version.php': "<?php $wp_version = '6.5.3';" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { ctx, calls } = fakeCtx(root, (argv) => {
    const cmd = argv.slice(1, 3).join(' ');
    if (cmd === 'core check-update') return { stdout: CORE_CHECK };
    if (cmd === 'plugin list') return { stdout: PLUGINS };
    if (cmd === 'theme list') return { stdout: THEMES };
    if (cmd === 'language core') return { stdout: LANGS };
    return { stdout: 'Success\n' };
  }, { minorOnly: true, themes: false });
  const available = await wordpressAdapter.listUpdates(ctx);
  assert.equal(available.length, 6);
  assert.ok(calls.every((c) => c.ro), 'listings never write the workspace');
  calls.length = 0;
  const applied = await wordpressAdapter.apply(ctx, available);
  assert.deepEqual(calls.map((c) => c.argv.slice(0, 5)), [
    ['wp', 'core', 'update', '--minor', '--path=/srv/app'],
    ['wp', 'plugin', 'update', '--all', '--minor'],
    ['wp', 'language', 'core', 'update', '--path=/srv/app'],
    ['wp', 'language', 'plugin', 'update', '--all'],
    ['wp', 'language', 'theme', 'update', '--all'],
  ]);
  assert.deepEqual(applied.map((u) => u.name), ['wordpress', 'akismet', 'fr_FR']);
  calls.length = 0;
  const r = await wordpressAdapter.postDeploy!(ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].argv.slice(0, 3), ['wp', 'core', 'update-db']);
  assert.equal(calls[0].ro, true);

  // A failing update command fails the apply (nothing is published).
  const failing = fakeCtx(root, (argv) => (argv[2] === 'update' ? { ok: false, exitCode: 1, stdout: 'Error: Could not create directory.' } : { stdout: '[]' }));
  await assert.rejects(wordpressAdapter.apply(failing.ctx, available), /mise à jour du cœur WordPress : Error: Could not create directory/);
});

test('nextcloud adapter: minorOnly updates the allowed apps one by one', async (t) => {
  const root = tmpTree({ 'occ': '', 'version.php': "<?php $OC_VersionString = '28.0.4';" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { ctx, calls } = fakeCtx(root, () => ({ stdout: '' }), { minorOnly: true });
  const applied = await nextcloudAdapter.apply(ctx, [
    { kind: 'app', name: 'calendar', title: null, currentVersion: '4.7.13', newVersion: '4.7.15', level: 'patch' },
    { kind: 'app', name: 'contacts', title: null, currentVersion: '5.5.3', newVersion: '6.0.0', level: 'major' },
  ]);
  assert.deepEqual(applied.map((u) => u.name), ['calendar']);
  assert.deepEqual(calls.map((c) => c.argv.slice(2, 4)), [['app:update', 'calendar']]);
});

test('composer / drupal adapters: --patch-only claims patch jumps only; install claims nothing', async (t) => {
  const root = tmpTree({ 'composer.json': '{}' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const available: AdapterUpdate[] = [
    { kind: 'package', name: 'acme/patch', title: null, currentVersion: '1.2.3', newVersion: '1.2.4', level: 'patch' },
    { kind: 'package', name: 'acme/minor', title: null, currentVersion: '1.2.3', newVersion: '1.3.0', level: 'minor' },
    { kind: 'package', name: 'acme/major', title: null, currentVersion: '1.2.3', newVersion: '2.0.0', level: 'major' },
  ];
  const patch = fakeCtx(root, () => ({ stdout: '' }), { minorOnly: true });
  assert.deepEqual((await ADAPTERS.composer.apply(patch.ctx, available)).map((u) => u.name), ['acme/patch']);
  assert.ok(patch.calls[0].argv.includes('--patch-only'));
  const all = fakeCtx(root, () => ({ stdout: '' }), {});
  assert.equal((await ADAPTERS.composer.apply(all.ctx, available)).length, 3);
  const install = fakeCtx(root, () => ({ stdout: '' }), { composerCommand: 'install' });
  assert.deepEqual(await ADAPTERS.composer.apply(install.ctx, available), [], 'install follows the lock: no upgrade claimed');
  assert.equal(install.calls[0].argv[1], 'install');
  assert.equal(ADAPTERS.composer.applyWithoutUpdates?.({ composerCommand: 'install' }), true);
  assert.equal(ADAPTERS.composer.applyWithoutUpdates?.({}), false);
  const core = available.map((u) => ({ ...u, kind: 'core' as const, name: u.name.replace('acme/', 'drupal/core-') }));
  const dp = fakeCtx(root, () => ({ stdout: '' }), { minorOnly: true });
  assert.deepEqual((await drupalAdapter.apply(dp.ctx, core)).map((u) => u.name), ['drupal/core-patch']);
  assert.equal(nextcloudAdapter.applyTouchesDatabase, true);
  assert.ok(!wordpressAdapter.applyTouchesDatabase && !ADAPTERS.composer.applyTouchesDatabase && !drupalAdapter.applyTouchesDatabase);
});
