import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_PLAN_LIMITS, SITE_BASES, litespeedBaseFor, siteBaseDef, type PlanLimits } from '@oblimint/shared';
import {
  baseTmpfs, LSCACHE_TMPFS_PATH, lscacheTmpfsMb, releasePreviewContainerSpec, siteContainerSpec, specHash, type SiteContainerInput,
} from './specs';
import { buildPreviewRuntimeConfig, buildRuntimeConfigs, type RuntimeConfigInput } from './runtimeConfig';
import { lswsIgnoredDirectives, scanReleaseFacts, switchWarnings, type ReleaseFacts } from './warnings';
import { siteContainerBases, siteHasPageCache } from './siteOps';
import { refusedByServer } from '../scan/leakGuard';
import { selectBase } from '../migration/plan/php';

// litespeed-php8.1 … 8.4 (images/litespeed): catalogue, container spec,
// runtime config, switch warnings, leak guard, migration base.

const ROOT = '/srv/oblimint';
const limits: PlanLimits = { ...DEFAULT_PLAN_LIMITS, memoryMb: 512, cpuCores: 1, pidsLimit: 300 };

function siteInput(over: Partial<SiteContainerInput> = {}): SiteContainerInput {
  return {
    siteId: 7, accountId: 3, uid: 20001, gid: 20001, slug: 'blog', role: 'primary', runtimeId: null, base: 'litespeed-php8.3', limits,
    releasesDir: `${ROOT}/accounts/3/sites/7/releases`, dataDir: `${ROOT}/accounts/3/data/blog`,
    runtimeConfigFile: `${ROOT}/accounts/3/sites/7/runtime/primary.json`,
    ...over,
  };
}

test('catalogue: four litespeed bases, OpenLiteSpeed, rewrite-only .htaccess, LSCache', () => {
  const ls = SITE_BASES.filter((b) => b.engine === 'litespeed');
  assert.deepEqual(ls.map((b) => b.id), ['litespeed-php8.4', 'litespeed-php8.3', 'litespeed-php8.2', 'litespeed-php8.1']);
  for (const b of ls) {
    assert.equal(b.htaccess, false);
    assert.equal(b.htaccessRewrite, true);
    assert.equal(b.lscache, true);
    assert.equal(b.image, `meejay/oblimint-${b.id}`);
  }
  assert.equal(siteBaseDef('litespeed-php8.1').unmaintained, true);
  assert.equal(siteBaseDef('apache-php8.3').lscache, false);
  assert.equal(siteBaseDef('apache-php8.3').htaccessRewrite, true);
  assert.equal(siteBaseDef('nginx-php8.3').htaccessRewrite, false);
  assert.equal(litespeedBaseFor('8.3'), 'litespeed-php8.3');
  assert.equal(litespeedBaseFor('7.4'), null);
  assert.equal(litespeedBaseFor(null), null);
});

test('spec: a litespeed site gets its LSCache tmpfs (bounded, noexec, 1777), hardened like any site', () => {
  const spec = siteContainerSpec(siteInput());
  const hc = spec.HostConfig!;
  assert.equal(hc.Tmpfs?.[LSCACHE_TMPFS_PATH], 'rw,noexec,nosuid,nodev,mode=1777,size=128m');
  assert.equal(hc.ReadonlyRootfs, true);
  assert.deepEqual(hc.CapDrop, ['ALL']);
  assert.equal(spec.User, '20001:20001');
  assert.equal(spec.Image?.endsWith('oblimint-litespeed-php8.3:latest') || spec.Image?.includes('litespeed-php8.3'), true);
  // The other bases: no extra tmpfs, their spec (hash) is unchanged by the feature.
  const apache = siteContainerSpec(siteInput({ base: 'apache-php8.3' }));
  assert.deepEqual(Object.keys(apache.HostConfig!.Tmpfs!).sort(), ['/run', '/tmp']);
  assert.notEqual(specHash(apache), specHash(spec));
  // Preview of a release on a litespeed base: the smallest store.
  const preview = releasePreviewContainerSpec({
    siteId: 7, previewId: 2, accountId: 3, uid: 20001, gid: 20001, base: 'litespeed-php8.4', limits,
    previewReleasesDir: '/x/r', previewRuntimeDir: '/x/rt', dataDir: '/x/d', ephemeralPaths: [], caps: { memoryMb: 256, cpus: 1 },
  });
  assert.equal(preview.HostConfig!.Tmpfs?.[LSCACHE_TMPFS_PATH], 'rw,noexec,nosuid,nodev,mode=1777,size=32m');
});

test('LSCache tmpfs size: a quarter of the memory, 32–512 MiB, 256 MiB when unlimited', () => {
  assert.equal(lscacheTmpfsMb(null), 256);
  assert.equal(lscacheTmpfsMb(64), 32);
  assert.equal(lscacheTmpfsMb(1024), 256);
  assert.equal(lscacheTmpfsMb(8192), 512);
  assert.deepEqual(baseTmpfs('nginx-php8.3', 1024), {});
  assert.deepEqual(baseTmpfs('nginx-static', null), {});
});

function rcInput(over: Partial<RuntimeConfigInput['site']> = {}, runtimes: RuntimeConfigInput['runtimes'] = []): RuntimeConfigInput {
  return {
    site: { id: 7, accountId: 3, base: 'litespeed-php8.3', previewBase: null, docroot: '', basePath: '/', phpSettings: {}, customNginx: null, healthcheckPath: '/', ...over },
    runtimes,
    dataPaths: [{ path: 'wp-content/uploads', policy: 'persistent', allowedExtensions: null }],
    routes: [],
  };
}

test('runtime config: lscache only for a litespeed base (the other configs keep their bytes)', () => {
  const files = buildRuntimeConfigs(rcInput({ lscacheEnabled: false, previewBase: 'apache-php8.3' }, [{ id: 4, base: 'litespeed-php8.4' }]));
  const by = new Map(files.map((f) => [f.file, f.config]));
  assert.deepEqual(by.get('primary.json')?.lscache, { enabled: false });
  assert.deepEqual(by.get('secondary-4.json')?.lscache, { enabled: false });
  assert.equal('lscache' in by.get('preview.json')!, false);
  // Absent setting = enabled.
  assert.deepEqual(buildRuntimeConfigs(rcInput())[0].config.lscache, { enabled: true });
  const apache = buildRuntimeConfigs(rcInput({ base: 'apache-php8.3', lscacheEnabled: false }))[0].config;
  assert.equal('lscache' in apache, false);
  assert.deepEqual(buildPreviewRuntimeConfig(rcInput({ lscacheEnabled: true }), 'litespeed-php8.2').config.lscache, { enabled: true });
});

test('page cache of a site: primary, secondaries and preview on a litespeed base', () => {
  const site = { id: 7, base: 'apache-php8.3', preview_base: null } as never;
  assert.equal(siteHasPageCache({ site, runtimes: [] }), false);
  assert.equal(siteHasPageCache({ site, runtimes: [{ id: 2, base: 'litespeed-php8.3' } as never] }), true);
  const withPreview = { id: 7, base: 'nginx-php8.3', preview_base: 'litespeed-php8.4' } as never;
  assert.deepEqual(siteContainerBases({ site: withPreview, runtimes: [] }).map((c) => c.name), ['oblimint-site-7', 'oblimint-site-7-preview']);
  assert.equal(siteHasPageCache({ site: withPreview, runtimes: [] }), true);
});

const none: ReleaseFacts = { hasHtaccess: false, hasPhp: false, truncated: false };
const codes = (w: Array<{ code: string }>) => w.map((x) => x.code).sort();

test('switch to litespeed: .htaccess directives OpenLiteSpeed ignores are listed; never the nginx warning', () => {
  const w = switchWarnings({
    current: 'apache-php8.3', target: 'litespeed-php8.3', imagePresent: true, imageRef: 'x',
    release: { ...none, hasHtaccess: true, htaccessIgnored: ['AuthType', 'php_value', 'Require'] },
  });
  assert.deepEqual(codes(w), ['htaccessPartial']);
  assert.equal(w[0].params?.directives, 'AuthType, php_value, Require');
  // Rewrite rules only: nothing lost, no warning.
  assert.deepEqual(codes(switchWarnings({ current: 'apache-php8.3', target: 'litespeed-php8.3', imagePresent: true, imageRef: 'x', release: { ...none, hasHtaccess: true, htaccessIgnored: [] } })), []);
  // Unknown content (scan without the option): the generic warning.
  assert.deepEqual(codes(switchWarnings({ current: 'apache-php8.3', target: 'litespeed-php8.3', imagePresent: true, imageRef: 'x', release: { ...none, hasHtaccess: true } })), ['htaccessPartial']);
  // litespeed → litespeed: nothing changes for the .htaccess files.
  assert.deepEqual(codes(switchWarnings({ current: 'litespeed-php8.2', target: 'litespeed-php8.3', imagePresent: true, imageRef: 'x', release: { ...none, hasHtaccess: true, htaccessIgnored: ['Require'] } })), []);
  // litespeed → nginx: the nginx warning.
  assert.deepEqual(codes(switchWarnings({ current: 'litespeed-php8.3', target: 'nginx-php8.3', imagePresent: true, imageRef: 'x', release: { ...none, hasHtaccess: true } })), ['htaccessIgnored']);
});

test('lswsIgnoredDirectives: rewrite / LSCache directives and IfModule kept, the rest listed once', () => {
  const text = [
    '# BEGIN WordPress',
    '<IfModule mod_rewrite.c>',
    'RewriteEngine On',
    'RewriteBase /',
    'RewriteCond %{REQUEST_FILENAME} !-f',
    'RewriteRule . /index.php [L]',
    '</IfModule>',
    '<IfModule LiteSpeed>',
    'CacheLookup on',
    '</IfModule>',
    'php_value upload_max_filesize 64M',
    'php_flag display_errors off',
    'AuthType Basic',
    'authtype basic',
    'Require valid-user',
    '<Files wp-config.php>',
    'Order allow,deny',
    'Deny from all',
    '</Files>',
    'Header set X-Frame-Options SAMEORIGIN',
    '   ErrorDocument 404 /404.php',
  ].join('\r\n');
  // Access control is handled by the base (reproduced or closed): never listed as ignored.
  assert.deepEqual(lswsIgnoredDirectives(text), ['php_value', 'php_flag', 'Header', 'ErrorDocument']);
  assert.deepEqual(lswsIgnoredDirectives('RewriteEngine On\nRewriteRule ^x$ /y [R=301,L]\n'), []);
});

test('scanReleaseFacts with htaccessDirectives: every .htaccess read (bounded), links never followed', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-lsws-scan-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'release');
  fs.mkdirSync(path.join(root, 'admin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.php'), '<?php');
  fs.writeFileSync(path.join(root, '.htaccess'), 'RewriteEngine On\nRewriteRule . /index.php [L]\n');
  fs.writeFileSync(path.join(root, 'admin', '.htaccess'), 'AuthType Basic\nAuthUserFile /x\nRequire valid-user\nHeader set X-A b\n');
  fs.writeFileSync(path.join(base, 'outside.htaccess'), 'php_value auto_prepend_file /x\n');
  try {
    fs.mkdirSync(path.join(root, 'linked'));
    fs.symlinkSync(path.join(base, 'outside.htaccess'), path.join(root, 'linked', '.htaccess'));
  } catch { /* no symlinks on this machine: the rest still holds */ }
  const facts = await scanReleaseFacts(root, undefined, { htaccessDirectives: true });
  assert.equal(facts.hasHtaccess, true);
  assert.equal(facts.hasPhp, true);
  assert.deepEqual(facts.htaccessIgnored, ['Header']);
  // Without the option: the historical shape (no extra field).
  assert.deepEqual(await scanReleaseFacts(root), { hasHtaccess: true, hasPhp: true, truncated: false });
});

test('leak guard: OpenLiteSpeed refuses every dot segment but .well-known (like nginx)', () => {
  assert.equal(refusedByServer('.env', 'litespeed'), true);
  assert.equal(refusedByServer('wp-content/.backup/x.zip', 'litespeed'), true);
  assert.equal(refusedByServer('.well-known/security.txt', 'litespeed'), false);
  assert.equal(refusedByServer('dump.sql', 'litespeed'), false);
});

test('migration: a source on LiteSpeed / with LSCache gets the litespeed base of its PHP branch', () => {
  const php = (version: string) => ({ version, handler: 'php-fpm', source: 'apache-vhost', htaccessOverrides: [] }) as never;
  const a = selectBase(php('8.3'), { litespeedSource: true, htaccess: false });
  assert.equal(a.base, 'litespeed-php8.3');
  assert.deepEqual(a.warnings.map((w) => w.code), ['litespeedSource']);
  const b = selectBase(php('8.1'), { litespeedSource: true, htaccess: true });
  assert.equal(b.base, 'litespeed-php8.1');
  assert.deepEqual(b.warnings.map((w) => w.code).sort(), ['litespeedBaseHtaccess', 'litespeedSource', 'phpUnmaintained']);
  // No litespeed base for PHP 7.4: the Apache one.
  assert.equal(selectBase(php('7.4'), { litespeedSource: true }).base, 'apache-php7.4');
  // Not allowed by the plan: the Apache base, without a blocking message.
  const c = selectBase(php('8.3'), { litespeedSource: true, allowedBases: ['apache-php8.3'] });
  assert.equal(c.base, 'apache-php8.3');
  assert.deepEqual(c.warnings, []);
  // Not a LiteSpeed source: unchanged mapping; a staff choice always wins.
  assert.equal(selectBase(php('8.3'), {}).base, 'apache-php8.3');
  assert.equal(selectBase(php('8.3'), { litespeedSource: true, choice: 'nginx-php8.3' }).base, 'nginx-php8.3');
});

// ── .htaccess access rules (twin of images/siteconf/htaccess.go) ─────────────

test('parseHtaccessAccess: same verdicts as siteconf (reproduced, closed, nothing)', async () => {
  const { parseHtaccessAccess } = await import('@oblimint/shared');
  const one = (s: string) => parseHtaccessAccess(s).map((r) => [r.action, r.directive, r.files?.kind ?? null, r.files?.pattern ?? null]);
  assert.deepEqual(one('Require all denied\n'), [['deny', 'Require all denied', null, null]]);
  assert.deepEqual(one('Order Deny,Allow\r\nDeny from all\r\n'), [['deny', 'Deny from all', null, null]]);
  assert.deepEqual(one('Order allow,deny\n'), [['deny', 'Order allow,deny', null, null]]);
  assert.deepEqual(one('<Files xmlrpc.php>\norder deny,allow\ndeny from all\n</Files>\n'), [['deny', 'Deny from all', 'name', 'xmlrpc.php']]);
  assert.deepEqual(one('<FilesMatch "\.(ini|log)$">\nRequire all denied\n</FilesMatch>'), [['deny', 'Require all denied', 'regex', '\.(ini|log)$']]);
  assert.deepEqual(one('<Files *.log>\nDeny from all\n</Files>'), [['deny', 'Deny from all', 'glob', '*.log']]);
  assert.deepEqual(one('AuthType Basic\nAuthName "x"\nRequire valid-user\n'), [['closed', 'AuthType Basic', null, null]]);
  assert.deepEqual(one('Order deny,allow\nDeny from all\nAllow from 203.0.113.9\n'), [['closed', 'Allow from 203.0.113.9', null, null]]);
  assert.deepEqual(one('Require ip 10.1.2.0/24\n'.replace('10.1', '172.16')), [['closed', 'Require ip 172.16.2.0/24', null, null]]);
  assert.deepEqual(one('<Limit GET POST>\nDeny from all\n</Limit>\n'), [['closed', '<limit> Deny from all', null, null]]);
  assert.deepEqual(one('<Files secret.txt>\nDeny from all\n'), [['closed', '<files> non fermé', null, null]]);
  for (const none of ['RewriteEngine On\nRewriteRule . /index.php [L]\n', 'Require all granted\n', 'Order allow,deny\nAllow from all\n', '<Limit GET>\nRequire all granted\n</Limit>\n', '# Deny from all\n']) {
    assert.deepEqual(one(none), [], none);
  }
});

test('htaccessAccessRules: walks real folders only, one rule per scope, French lines', async (t) => {
  const { htaccessAccessRules, htaccessAccessLine, basesEnforceHtaccessAccess } = await import('./htaccessAccess');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-lsws-acc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mk = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  mk('.htaccess', 'RewriteEngine On\n<Files xmlrpc.php>\nDeny from all\n</Files>\n');
  mk('private/.htaccess', 'Deny from all\n');
  mk('admin/.htaccess', 'AuthType Basic\nRequire valid-user\n');
  mk('ok/.htaccess', 'Options -Indexes\n');
  const { rules, truncated } = await htaccessAccessRules(root);
  assert.equal(truncated, false);
  assert.deepEqual(rules.map((r) => [r.dir, r.files?.pattern ?? null, r.action]), [['', 'xmlrpc.php', 'deny'], ['admin', null, 'closed'], ['private', null, 'deny']]);
  assert.match(htaccessAccessLine(rules[1]), /admin\/ fermé \(403\)/);
  assert.match(htaccessAccessLine(rules[2]), /private\/ refusé \(403\)/);
  assert.equal(basesEnforceHtaccessAccess(['apache-php8.3', null]), false);
  assert.equal(basesEnforceHtaccessAccess(['apache-php8.3', 'litespeed-php8.4']), true);
});
