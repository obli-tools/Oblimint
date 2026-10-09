import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  customNginxError, dataPathContainsDocroot, dataPathForbiddenError, dataPathsOverlap, findDataPathOverlap, isPlatformReservedDomain, isValidAccountUsername, isValidClientUsername,
  normalizeDomainName, normalizeExtensions, phpSettingsError,
} from './hostingValidation.service';
import {
  accountCreateSchema, clientUserAddSchema, dataPathInputSchema, domainCreateSchema, planLimitsSchema, routeInputSchema,
  siteCreateSchema, siteUpdateSchema,
} from '../../validators/hosting.schema';
import { DEFAULT_PLAN_LIMITS } from '@oblimint/shared';

test('account usernames: format and reserved names', () => {
  for (const ok of ['alice', 'a-b', 'client42', 'abc', 'a'.repeat(32)]) assert.equal(isValidAccountUsername(ok), true, ok);
  for (const bad of ['ab', 'Alice', '1abc', '-abc', 'a_b', 'a'.repeat(33), 'root', 'www-data', 'postgres', 'git', 'oblimint', 'nobody']) {
    assert.equal(isValidAccountUsername(bad), false, bad);
  }
  assert.equal(accountCreateSchema.safeParse({ username: 'admin', planId: 1 }).success, false);
  assert.equal(accountCreateSchema.safeParse({ username: 'shop', planId: 1 }).success, true);
  assert.equal(accountCreateSchema.safeParse({ username: 'shop', planId: 1, extra: true }).success, false);
});

test('client usernames: og_ prefix reserved, password ≥ 12', () => {
  assert.equal(isValidClientUsername('john.doe'), true);
  assert.equal(isValidClientUsername('OG_john'), false);
  assert.equal(isValidClientUsername('ab'), false);
  const base = { mode: 'create', username: 'john', password: 'x'.repeat(12), capabilities: ['sites.manage', 'sites.manage'] };
  const ok = clientUserAddSchema.safeParse(base);
  assert.equal(ok.success, true);
  if (ok.success && ok.data.mode === 'create') assert.deepEqual(ok.data.capabilities, ['sites.manage']);
  assert.equal(clientUserAddSchema.safeParse({ ...base, password: 'short' }).success, false);
  assert.equal(clientUserAddSchema.safeParse({ ...base, capabilities: ['accounts.manage'] }).success, false);
  assert.equal(clientUserAddSchema.safeParse({ mode: 'attach', userId: 3 }).success, true);
  assert.equal(clientUserAddSchema.safeParse({ ...base, email: '' }).success, true);
});

test('site slugs, docroots, base paths, healthchecks', () => {
  const site = { accountId: 1, name: 'Blog', slug: 'blog', base: 'apache-php8.3' };
  assert.equal(siteCreateSchema.safeParse(site).success, true);
  for (const slug of ['-blog', 'Blog', 'a'.repeat(41), 'b_log', '']) assert.equal(siteCreateSchema.safeParse({ ...site, slug }).success, false, slug);
  assert.equal(siteCreateSchema.safeParse({ ...site, slug: '0' }).success, true);
  assert.equal(siteCreateSchema.safeParse({ ...site, base: 'apache-php5.6' }).success, false);
  const parsed = siteCreateSchema.parse({ ...site, docroot: '/public/', basePath: 'blog' });
  assert.equal(parsed.docroot, 'public');
  assert.equal(parsed.basePath, '/blog/');
  assert.equal(siteCreateSchema.safeParse({ ...site, docroot: '../etc' }).success, false);
  assert.equal(siteCreateSchema.safeParse({ ...site, healthcheckPath: 'health' }).success, false);
  assert.equal(siteCreateSchema.safeParse({ ...site, healthcheckPath: '/health?x=1' }).success, true);
  assert.equal(siteCreateSchema.safeParse({ ...site, healthcheckPath: '/a b' }).success, false);
  assert.equal(siteCreateSchema.safeParse({ ...site, publishDebounceSec: 4 }).success, false);
  assert.equal(siteUpdateSchema.safeParse({ base: 'nginx-static' }).success, false); // base changes go through /runtime
});

test('route prefixes are normalised', () => {
  assert.equal(routeInputSchema.parse({ pathPrefix: 'shop', siteId: 1 }).pathPrefix, '/shop/');
  assert.equal(routeInputSchema.parse({ pathPrefix: '/', siteId: 1 }).pathPrefix, '/');
  assert.equal(routeInputSchema.safeParse({ pathPrefix: '/a/../b', siteId: 1 }).success, false);
  assert.equal(routeInputSchema.safeParse({ pathPrefix: '/a b/', siteId: 1 }).success, false);
});

test('domain names: normalisation, IDN → punycode, refusals', () => {
  assert.equal(normalizeDomainName('  Example.COM. '), 'example.com');
  assert.equal(normalizeDomainName('bücher.example'), 'xn--bcher-kva.example');
  assert.equal(normalizeDomainName('ÉCOLE.fr'), 'xn--cole-9oa.fr');
  assert.equal(normalizeDomainName('a-b.c-d.example.org'), 'a-b.c-d.example.org');
  for (const bad of ['localhost', 'example', '-a.com', 'a-.com', 'a..com', '*.example.com', '192.168.1.1', '[::1]', '::1',
    'exa_mple.com', 'example.com/x', 'user@example.com', 'a.123', `${'a'.repeat(64)}.com`, `${'a.'.repeat(127)}com`, '', ' ']) {
    assert.equal(normalizeDomainName(bad), null, bad);
  }
  assert.equal(normalizeDomainName(`${'a'.repeat(63)}.com`), `${'a'.repeat(63)}.com`);
  assert.equal(domainCreateSchema.parse({ accountId: 1, name: 'Bücher.Example' }).name, 'xn--bcher-kva.example');
  assert.equal(domainCreateSchema.safeParse({ accountId: 1, name: '10.0.0.1' }).success, false);
});

test('the panel host name and its preview zone are refused', () => {
  const panel = 'Panel.Example.com';
  assert.equal(isPlatformReservedDomain('panel.example.com', panel), true);
  assert.equal(isPlatformReservedDomain('preview.panel.example.com', panel), true);
  assert.equal(isPlatformReservedDomain('blog-3.preview.panel.example.com', panel), true);
  assert.equal(isPlatformReservedDomain('shop.example.com', panel), false);
  assert.equal(isPlatformReservedDomain('xpanel.example.com', panel), false);
  assert.equal(isPlatformReservedDomain('panel.example.com', null), false);
});

test('data paths overlap segment-wise', () => {
  assert.equal(dataPathsOverlap('wp-content/uploads', 'wp-content/uploads'), true);
  assert.equal(dataPathsOverlap('wp-content', 'wp-content/uploads'), true);
  assert.equal(dataPathsOverlap('wp-content/uploads/2024', 'wp-content/uploads'), true);
  assert.equal(dataPathsOverlap('img', 'images'), false);
  assert.equal(dataPathsOverlap('var/cache', 'var/logs'), false);
  assert.equal(findDataPathOverlap(['storage', 'bootstrap/cache'], 'storage/app'), 'storage');
  assert.equal(findDataPathOverlap(['storage'], 'public/storage'), null);
});

test('typed extensions are lower-cased, deduplicated and bounded', () => {
  assert.deepEqual(normalizeExtensions(['JPG', '.png', 'jpg']), ['jpg', 'png']);
  assert.equal(normalizeExtensions([]), null);
  assert.deepEqual(normalizeExtensions([' GIF ']), ['gif']);
  // PHP-like extensions never (images/siteconf phpLikeExtRE refuses the whole config).
  for (const ext of [' PHP ', 'php5', '.phar', 'PHTML', 'pht', 'phps']) assert.equal(normalizeExtensions(['jpg', ext]), null, ext);
  assert.deepEqual(normalizeExtensions(['phpx']), ['phpx']);
  assert.match(dataPathInputSchema.safeParse({ path: 'img', policy: 'typed', allowedExtensions: ['jpg', '.Php7'] }).error?.issues[0]?.message ?? '', /\.php7 can never be served/);
  assert.equal(normalizeExtensions(['ph p']), null);
  assert.equal(normalizeExtensions(['tar.gz']), null);
  assert.equal(normalizeExtensions(['a'.repeat(11)]), null);
  assert.equal(normalizeExtensions(Array.from({ length: 101 }, (_, i) => `e${i}`)), null);
  assert.equal(normalizeExtensions('jpg'), null);
  assert.equal(dataPathInputSchema.safeParse({ path: 'uploads', policy: 'typed' }).success, false);
  assert.deepEqual(dataPathInputSchema.parse({ path: '/uploads/', policy: 'typed', allowedExtensions: ['PNG'] }),
    { path: 'uploads', policy: 'typed', allowedExtensions: ['png'] });
  assert.equal(dataPathInputSchema.safeParse({ path: '', policy: 'persistent' }).success, false);
  assert.equal(dataPathInputSchema.safeParse({ path: 'a/../b', policy: 'persistent' }).success, false);
});

test('plan limits: strict ranges', () => {
  assert.equal(planLimitsSchema.safeParse(DEFAULT_PLAN_LIMITS).success, true);
  const bad: Array<Record<string, unknown>> = [
    { cpuCores: 0.05 }, { cpuCores: 65 }, { memoryMb: 63 }, { memoryMb: 65537 }, { pidsLimit: 31 }, { pidsLimit: 5000 },
    { diskMb: -1 }, { maxSites: 1.5 }, { allowedBases: [] }, { allowedBases: ['apache-php5.6'] }, { unknownKey: 1 },
  ];
  for (const b of bad) assert.equal(planLimitsSchema.safeParse({ ...DEFAULT_PLAN_LIMITS, ...b }).success, false, JSON.stringify(b));
  const parsed = planLimitsSchema.parse({ ...DEFAULT_PLAN_LIMITS, allowedBases: ['nginx-static', 'nginx-static'], diskMb: null });
  assert.deepEqual(parsed.allowedBases, ['nginx-static']);
  assert.equal(parsed.diskMb, null);
});

test('php settings and custom nginx rules', () => {
  assert.equal(phpSettingsError({ memoryLimitMb: 256 }, 512), null);
  assert.match(phpSettingsError({ memoryLimitMb: 1024 }, 512) ?? '', /32 and 512/);
  assert.match(phpSettingsError({ memoryLimitMb: 4096 }, null) ?? '', /32 and 2048/);
  assert.match(phpSettingsError({ uploadMaxFilesizeMb: 64, postMaxSizeMb: 32 }, null) ?? '', /postMaxSizeMb/);
  assert.equal(phpSettingsError({ uploadMaxFilesizeMb: 64, postMaxSizeMb: 64 }, null), null);
  assert.match(phpSettingsError({ maxExecutionTime: 4 }, null) ?? '', /maxExecutionTime/);
  assert.equal(customNginxError('location /x { return 204; }'), null);
  assert.notEqual(customNginxError('a\0b'), null);
  assert.notEqual(customNginxError('x'.repeat(16 * 1024 + 1)), null);
});

test('data paths: no per-directory config file, never the docroot or an ancestor', () => {
  for (const bad of ['.user.ini', '.htaccess', 'public/.htaccess', '.well-known', '.git', 'a/.hidden/b', 'php.ini', 'conf/PHP.INI', 'web.config']) {
    assert.notEqual(dataPathForbiddenError(bad), null, bad);
    assert.equal(dataPathInputSchema.safeParse({ path: bad, policy: 'persistent' }).success, false, bad);
  }
  for (const ok of ['wp-content/uploads', 'img', 'var/cache', 'user.ini', 'a.b/c']) assert.equal(dataPathForbiddenError(ok), null, ok);
  assert.equal(dataPathContainsDocroot('public', 'public'), true);
  assert.equal(dataPathContainsDocroot('web', 'web/public'), true);
  assert.equal(dataPathContainsDocroot('public/img', 'public'), false);
  assert.equal(dataPathContainsDocroot('pub', 'public'), false);
  assert.equal(dataPathContainsDocroot('storage', ''), false);
});
