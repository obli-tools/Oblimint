import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HOSTING_SETTINGS, cmsGuardRelaxes, effectiveCmsGuardMode, type BansSettings } from '@oblimint/shared';
import {
  CmsFailureWindow, banKeyOfWindowKey, classifyCmsLogin, cmsExempt, cmsWindowKey, normalisePath, observeCmsLine,
} from './cmsGuardRules';
import { cmsGuard, CMS_MAX_NEW_BANS_PER_HOUR, type CmsGuardDeps, type CmsGuardSiteInfo } from './cmsGuard.service';
import type { CmsBanInput } from './bans.service';
import type { EdgeLogEntry } from '../usage/edgeLog';

// CMS login guard (audit item 15): classification of the edge log lines
// (success / failure / attempt per CMS, false positives), sliding window,
// IPv6 aggregation by /64, and the guard driven through injected dependencies
// (modes, per-site settings, exemptions, budget) — no database.

const post = (uri: string, status: number) => classifyCmsLogin({ method: 'POST', uri, status });

test('WordPress wp-login.php: 200 = failure, 302 = success, other actions and methods ignored', () => {
  assert.deepEqual(post('/wp-login.php', 200), { cms: 'wordpress', outcome: 'failure' });
  assert.deepEqual(post('/wp-login.php', 302), { cms: 'wordpress', outcome: 'success' });
  assert.deepEqual(post('/wp-login.php?action=login', 200), { cms: 'wordpress', outcome: 'failure' });
  assert.deepEqual(post('/blog/wp-login.php', 200), { cms: 'wordpress', outcome: 'failure' }, 'a WordPress in a sub-folder');
  assert.deepEqual(post('//blog//WP-Login.php', 200), { cms: 'wordpress', outcome: 'failure' }, 'case and repeated slashes');
  assert.deepEqual(post('/wp-login%2ephp', 200), { cms: 'wordpress', outcome: 'failure' }, 'percent-encoded');
  assert.equal(classifyCmsLogin({ method: 'GET', uri: '/wp-login.php', status: 200 }), null, 'showing the form is not an attempt');
  assert.equal(post('/wp-login.php?action=lostpassword', 200), null, 'lost password form');
  assert.equal(post('/wp-login.php?action=register', 200), null);
  assert.equal(post('/wp-login.php?action=postpass', 302), null, 'post password');
  assert.equal(post('/wp-login.php', 403), null, 'blocked by a plugin: not an outcome');
  assert.equal(post('/wp-login.php', 429), null);
  assert.equal(post('/wp-login.php', 404), null, 'no WordPress there');
  assert.equal(post('/wp-login.php', 500), null);
  assert.equal(post('/wp-login.php.bak', 200), null);
  assert.equal(post('/wp-admin/admin-ajax.php', 200), null, 'AJAX of a logged-in site');
  assert.equal(post('/wp-comments-post.php', 302), null);
  assert.equal(post('/index.php', 200), null);
});

test('XML-RPC: every POST answered 200 is an attempt; Jetpack exempt', () => {
  assert.deepEqual(post('/xmlrpc.php', 200), { cms: 'wordpress-xmlrpc', outcome: 'attempt' });
  assert.equal(post('/xmlrpc.php', 403), null, 'XML-RPC disabled by the site');
  assert.equal(post('/xmlrpc.php', 405), null);
  assert.equal(classifyCmsLogin({ method: 'GET', uri: '/xmlrpc.php', status: 200 }), null);
  assert.equal(cmsExempt('wordpress-xmlrpc', '192.0.100.7'), true, 'Automattic / Jetpack range');
  assert.equal(cmsExempt('wordpress', '192.0.100.7'), false, 'only for XML-RPC');
  assert.equal(cmsExempt('wordpress-xmlrpc', '203.0.113.7'), false);
});

test('Joomla administrator: the login form only, never the logged-in admin forms', () => {
  assert.deepEqual(post('/administrator/index.php', 303), { cms: 'joomla', outcome: 'attempt' });
  assert.deepEqual(post('/administrator/', 303), { cms: 'joomla', outcome: 'attempt' });
  assert.deepEqual(post('/administrator/index.php?option=com_login&task=login', 303), { cms: 'joomla', outcome: 'attempt' });
  assert.equal(post('/administrator/index.php?option=com_content&task=article.save', 303), null, 'saving an article');
  assert.equal(post('/administrator/index.php?option=com_content&view=articles', 200), null);
  assert.equal(post('/administrator/index.php?option=com_login&task=logout', 303), null, 'logout');
  assert.equal(post('/administrator/index.php', 404), null);
});

test('Drupal /user/login: 200 = failure, 302 / 303 = success, REST login left out', () => {
  assert.deepEqual(post('/user/login', 200), { cms: 'drupal', outcome: 'failure' });
  assert.deepEqual(post('/user/login?destination=/node/1', 200), { cms: 'drupal', outcome: 'failure' });
  assert.deepEqual(post('/fr/user/login', 200), { cms: 'drupal', outcome: 'failure' }, 'language prefix');
  assert.deepEqual(post('/user/login', 303), { cms: 'drupal', outcome: 'success' });
  assert.deepEqual(post('/user/login', 302), { cms: 'drupal', outcome: 'success' });
  assert.deepEqual(post('/?q=user/login', 200), { cms: 'drupal', outcome: 'failure' }, 'Drupal 7 without clean URLs');
  assert.deepEqual(post('/index.php?q=user', 200), { cms: 'drupal', outcome: 'failure' });
  assert.equal(post('/user/login?_format=json', 200), null, 'REST login');
  assert.equal(post('/user/login?_format=json', 400), null);
  assert.equal(post('/user/register', 200), null);
  assert.equal(post('/user/login/extra', 200), null);
  assert.equal(post('/?q=node/add', 200), null);
});

test('PrestaShop back office: AJAX login of the renamed admin folder, Symfony login', () => {
  assert.deepEqual(post('/admin123abc/index.php?rand=1730000000000', 200), { cms: 'prestashop', outcome: 'attempt' });
  assert.deepEqual(post('/shop/admin-dev/index.php?controller=AdminLogin', 200), { cms: 'prestashop', outcome: 'attempt' });
  assert.deepEqual(post('/admin_x9/login', 302), { cms: 'prestashop', outcome: 'attempt' }, 'PrestaShop 9');
  assert.deepEqual(post('/admin_x9/index.php/login', 302), { cms: 'prestashop', outcome: 'attempt' });
  assert.equal(post('/admin123abc/index.php?controller=AdminProducts&token=abc&ajax=1', 200), null, 'logged-in back office');
  assert.equal(post('/admin123abc/index.php?rand=12&ajax=1', 200), null);
  assert.equal(post('/admin123abc/ajax-tab.php?rand=1730000000000', 200), null);
  assert.equal(post('/admin123abc/index.php?rand=1730000000000', 403), null);
});

test('phpMyAdmin hosted in a site: login form 200 = failure, 302 = success, logged-in requests ignored', () => {
  assert.deepEqual(post('/phpmyadmin/index.php?route=/', 200), { cms: 'phpmyadmin', outcome: 'failure' });
  assert.deepEqual(post('/phpMyAdmin/', 200), { cms: 'phpmyadmin', outcome: 'failure' });
  assert.deepEqual(post('/tools/pma/index.php', 302), { cms: 'phpmyadmin', outcome: 'success' });
  assert.deepEqual(post('/phpmyadmin-5.2.1/index.php?lang=fr', 200), { cms: 'phpmyadmin', outcome: 'failure' });
  assert.equal(post('/phpmyadmin/index.php?route=/sql', 200), null, 'a query of a logged-in user');
  assert.equal(post('/phpmyadmin/import.php', 200), null);
  assert.equal(post('/phpmyadmin/index.php?route=/&ajax_request=true', 200), null);
});

test('path normalisation and garbage', () => {
  assert.equal(normalisePath('/A//B/../c?x=1'), '/a/b/../c');
  assert.equal(normalisePath('http://example.com/wp-login.php'), '/wp-login.php', 'absolute-form request line');
  assert.equal(normalisePath('*'), null);
  assert.equal(normalisePath(''), null);
  assert.equal(normalisePath('/%00wp-login.php'), null, 'control character');
  assert.equal(normalisePath('/%E0%A4%A'), '/%e0%a4%a', 'malformed escapes kept');
  assert.equal(post('*', 200), null);
  assert.equal(classifyCmsLogin({ method: 'POST', uri: '/wp-login.php', status: Number.NaN }), null);
});

test('sliding window: threshold, expiry, success clears, bounded memory', () => {
  const win = new CmsFailureWindow();
  const th = { maxFailures: 3, windowMinutes: 5 };
  const line = (uri: string, status: number, ip = '203.0.113.9', siteId = 7) => ({ method: 'POST', uri, status, remoteAddr: ip, siteId });
  let t = 1_000_000;
  assert.deepEqual(observeCmsLine(win, line('/wp-login.php', 200), t, th), { kind: 'counted', key: '7|203.0.113.9', cms: 'wordpress', count: 1 });
  assert.equal(observeCmsLine(win, line('/wp-login.php', 200), t += 60_000, th).kind, 'counted');
  // The first one leaves the window: still 2.
  t += 4 * 60_000 + 1;
  const third = observeCmsLine(win, line('/wp-login.php', 200), t, th);
  assert.equal(third.kind === 'counted' && third.count, 2, 'first failure out of the 5 min window');
  const hit = observeCmsLine(win, line('/xmlrpc.php', 200), t += 1000, th);
  assert.deepEqual(hit, { kind: 'threshold', key: '7|203.0.113.9', cms: 'wordpress-xmlrpc', count: 3 }, 'mixed rules of one site add up');
  assert.equal(win.count('7|203.0.113.9', t, 300_000), 0, 'counter restarted at the threshold');
  assert.equal(banKeyOfWindowKey('7|203.0.113.9'), '203.0.113.9');

  // Per site: the same address on two sites counts twice separately.
  observeCmsLine(win, line('/wp-login.php', 200, '203.0.113.9', 8), t, th);
  observeCmsLine(win, line('/wp-login.php', 200, '203.0.113.9', 9), t, th);
  assert.equal(win.count('8|203.0.113.9', t, 300_000), 1);
  assert.equal(win.count('9|203.0.113.9', t, 300_000), 1);

  // A successful login clears the address on that site (a typo streak, then the right password).
  observeCmsLine(win, line('/wp-login.php', 200, '203.0.113.9', 8), t, th);
  assert.deepEqual(observeCmsLine(win, line('/wp-login.php', 302, '203.0.113.9', 8), t, th), { kind: 'cleared', key: '8|203.0.113.9', cms: 'wordpress' });
  assert.equal(win.count('8|203.0.113.9', t, 300_000), 0);

  // Not a login / exempt / garbage address: ignored, nothing tracked.
  const before = win.size;
  assert.equal(observeCmsLine(win, line('/index.php', 200), t, th).kind, 'ignored');
  assert.equal(observeCmsLine(win, line('/xmlrpc.php', 200, '192.0.64.1'), t, th).kind, 'ignored', 'Jetpack');
  assert.equal(observeCmsLine(win, line('/wp-login.php', 200, 'garbage'), t, th).kind, 'ignored');
  assert.equal(win.size, before);

  // At most `limit` timestamps per key, and the oldest keys evicted past the cap.
  const small = new CmsFailureWindow(4);
  for (let i = 0; i < 50; i++) small.record('k', i, 1_000_000, 10);
  assert.equal(small.count('k', 50, 1_000_000), 10);
  for (let i = 0; i < 10; i++) small.record(`k${i}`, 100 + i, 1_000_000, 10);
  assert.ok(small.size <= 4, 'bounded number of keys');
  assert.equal(small.count('k9', 200, 1_000_000), 1, 'the most recent key survives');
  small.sweep(10_000_000, 1000);
  assert.equal(small.size, 0, 'stale keys swept');
});

test('IPv6: one /64 is one key (rotating addresses in a /64 adds up), another /64 is another', () => {
  const win = new CmsFailureWindow();
  const th = { maxFailures: 3, windowMinutes: 5 };
  const l = (ip: string) => ({ method: 'POST', uri: '/user/login', status: 200, remoteAddr: ip, siteId: 3 });
  assert.equal(cmsWindowKey(3, '2001:db8:1:2::a'), '3|2001:db8:1:2::/64');
  observeCmsLine(win, l('2001:db8:1:2::a'), 1, th);
  observeCmsLine(win, l('2001:db8:1:2:ffff::1'), 2, th);
  assert.equal(observeCmsLine(win, l('2001:db8:1:3::a'), 3, th).kind, 'counted', 'another /64');
  const out = observeCmsLine(win, l('2001:db8:1:2:dead:beef:0:1'), 4, th);
  assert.equal(out.kind, 'threshold');
  assert.equal(out.kind === 'threshold' && banKeyOfWindowKey(out.key), '2001:db8:1:2::/64');
  assert.equal(cmsWindowKey(3, '::ffff:203.0.113.4'), '3|203.0.113.4', 'IPv4-mapped address');
});

test('shared: effective mode (auto = journal for 48 h) and what relaxes a site', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  assert.equal(effectiveCmsGuardMode({ cmsGuardMode: 'auto', cmsGuardAutoAt: null }, now), 'log');
  assert.equal(effectiveCmsGuardMode({ cmsGuardMode: 'auto', cmsGuardAutoAt: '2026-11-05T12:00:00Z' }, now), 'log');
  assert.equal(effectiveCmsGuardMode({ cmsGuardMode: 'auto', cmsGuardAutoAt: '2026-11-04T11:00:00Z' }, now), 'on');
  assert.equal(effectiveCmsGuardMode({ cmsGuardMode: 'off', cmsGuardAutoAt: null }, now), 'off');
  assert.equal(effectiveCmsGuardMode({ cmsGuardMode: 'on', cmsGuardAutoAt: null }, now), 'on');
  assert.equal(DEFAULT_HOSTING_SETTINGS.bans.cmsGuardMode, 'auto');
  assert.equal(DEFAULT_HOSTING_SETTINGS.bans.cmsGuardMaxFailures, 10);
  assert.equal(DEFAULT_HOSTING_SETTINGS.bans.cmsGuardWindowMinutes, 5);
  const p = { maxFailures: 10, windowMinutes: 5 };
  const on = { enabled: true, maxFailures: null, windowMinutes: null };
  assert.equal(cmsGuardRelaxes(on, { ...on, enabled: false }, p), true, 'switched off');
  assert.equal(cmsGuardRelaxes({ ...on, enabled: false }, on, p), false, 'switched on');
  assert.equal(cmsGuardRelaxes(on, { ...on, maxFailures: 20 }, p), true, 'more failures tolerated');
  assert.equal(cmsGuardRelaxes(on, { ...on, maxFailures: 5 }, p), false, 'stricter');
  assert.equal(cmsGuardRelaxes(on, { ...on, windowMinutes: 2 }, p), true, 'shorter window');
  assert.equal(cmsGuardRelaxes(on, { ...on, windowMinutes: 30 }, p), false, 'longer window');
  assert.equal(cmsGuardRelaxes({ ...on, maxFailures: 5 }, on, p), true, 'back to the platform default (10 > 5)');
});

// ── the guard through injected dependencies ──────────────────────────────────

test('guard: modes, per-site settings, exemptions (never-ban, panel sessions), journal dedup, ban input', async () => {
  let now = Date.parse('2026-11-04T12:00:00Z');
  let settings: BansSettings = { ...DEFAULT_HOSTING_SETTINGS.bans, cmsGuardMode: 'on', cmsGuardMaxFailures: 3, cmsGuardWindowMinutes: 5 };
  const sites = new Map<number, CmsGuardSiteInfo>([
    [1, { id: 1, accountId: 10, tenantId: 2, name: 'shop', accountUsername: 'acme', enabled: true, maxFailures: null, windowMinutes: null }],
    [2, { id: 2, accountId: 10, tenantId: 2, name: 'blog', accountUsername: 'acme', enabled: false, maxFailures: null, windowMinutes: null }],
    [3, { id: 3, accountId: 11, tenantId: 2, name: 'strict', accountUsername: 'bee', enabled: true, maxFailures: 5, windowMinutes: null }],
  ]);
  const bans: CmsBanInput[] = [];
  const journal: Array<{ site: number; key: string }> = [];
  const savedAutoAt: string[] = [];
  let sessionIps = ['2001:db8:9:9::5'];
  const deps: Partial<CmsGuardDeps> = {
    now: () => now,
    settings: async () => settings,
    saveAutoAt: async (at) => { savedAutoAt.push(at); settings = { ...settings, cmsGuardAutoAt: at }; },
    site: async (id) => sites.get(id) ?? null,
    sessionIps: async () => sessionIps,
    banGuard: async () => ({ protectedNets: ['172.17.0.0/16'], nodeAddresses: ['203.0.113.250'], neverBan: ['198.51.100.0/24'] }),
    ban: async (input) => { bans.push(input); return null; },
    logWouldBan: async (site, key) => { journal.push({ site: site.id, key }); },
  };
  cmsGuard.setDepsForTests(deps);
  const entry = (over: Partial<EdgeLogEntry> = {}): EdgeLogEntry => ({
    time: new Date(now).toISOString(), host: 'shop.example.com', remoteAddr: '203.0.113.9', method: 'POST', uri: '/wp-login.php', status: 200,
    bytes: 0, bytesOut: 0, bytesIn: 0, requestTime: 0, upstream: null, upstreamStatus: null, userAgent: 'bot', referer: null,
    siteId: 1, accountId: 10, tenantId: 2, kind: 'site', ...over,
  });
  const feed = async (n: number, over: Partial<EdgeLogEntry> = {}) => {
    for (let i = 0; i < n; i++) cmsGuard.onEdgeLogEntry(entry(over));
    await cmsGuard.idle();
  };

  // on: 3 failures in 5 min ⇒ one ban with the site and a French reason.
  await feed(3);
  assert.equal(bans.length, 1);
  assert.deepEqual({ ...bans[0], reason: undefined }, {
    key: '203.0.113.9', accountId: 10, tenantId: 2, siteId: 1, siteName: 'shop', accountUsername: 'acme', hits: 3, reason: undefined,
  });
  assert.equal(bans[0].reason, '3 échecs de connexion WordPress en 5 min sur shop.example.com/wp-login.php');

  // Lines that are not a site's own traffic, not a login, or not a POST never reach the window.
  await feed(5, { kind: 'preview' });
  await feed(5, { kind: 'proxy', siteId: null });
  await feed(5, { method: 'GET' });
  await feed(5, { uri: '/wp-login.php?action=lostpassword' });
  assert.equal(bans.length, 1);

  // Site switched off: never counted. Site threshold 5 instead of 3.
  await feed(5, { siteId: 2, host: 'blog.example.com' });
  assert.equal(bans.length, 1, 'site 2 disabled');
  await feed(4, { siteId: 3, remoteAddr: '203.0.113.20' });
  assert.equal(bans.length, 1, '4 < 5 on site 3');
  await feed(1, { siteId: 3, remoteAddr: '203.0.113.20' });
  assert.equal(bans.length, 2);
  assert.equal(bans[1].hits, 5);

  // Never-ban: neverBan, node address, private, Docker; an open panel session (by /64).
  await feed(3, { remoteAddr: '198.51.100.7' });
  await feed(3, { remoteAddr: '203.0.113.250' });
  await feed(3, { remoteAddr: '10.1.2.3' });
  await feed(3, { remoteAddr: '172.17.0.5' });
  await feed(3, { remoteAddr: '2001:db8:9:9::77' });
  assert.equal(bans.length, 2, 'exempt addresses never banned');
  sessionIps = [];
  now += 20_000; // session cache (15 s) expired
  await feed(3, { remoteAddr: '2001:db8:9:9::77' });
  assert.equal(bans.length, 3, 'the session is gone: banned');
  assert.equal(bans[2].key, '2001:db8:9:9::/64');

  // A success in between clears the streak.
  await feed(2, { remoteAddr: '203.0.113.30' });
  await feed(1, { remoteAddr: '203.0.113.30', status: 302 });
  await feed(2, { remoteAddr: '203.0.113.30' });
  assert.equal(bans.length, 3);

  // log: journal instead of a ban, once per address and site per 10 min.
  settings = { ...settings, cmsGuardMode: 'log' };
  await feed(3, { remoteAddr: '203.0.113.40' });
  await feed(3, { remoteAddr: '203.0.113.40' });
  assert.equal(bans.length, 3);
  assert.deepEqual(journal, [{ site: 1, key: '203.0.113.40' }]);
  now += 11 * 60_000;
  await feed(3, { remoteAddr: '203.0.113.40' });
  assert.equal(journal.length, 2, 'journaled again after 10 min');

  // off, and bans disabled altogether: nothing.
  settings = { ...settings, cmsGuardMode: 'off' };
  await feed(6, { remoteAddr: '203.0.113.41' });
  settings = { ...settings, cmsGuardMode: 'on', enabled: false };
  await feed(6, { remoteAddr: '203.0.113.42' });
  assert.equal(bans.length, 3);
  assert.equal(journal.length, 2);

  // auto: the first run stores now + 48 h and journals; past it, bans.
  settings = { ...settings, enabled: true, cmsGuardMode: 'auto', cmsGuardAutoAt: null };
  assert.equal(await cmsGuard.mode(), 'log');
  assert.equal(savedAutoAt.length, 1);
  assert.equal(Date.parse(savedAutoAt[0]) - now, 48 * 3_600_000);
  await feed(3, { remoteAddr: '203.0.113.50' });
  assert.equal(bans.length, 3);
  assert.equal(journal.length, 3);
  now += 49 * 3_600_000;
  assert.equal(await cmsGuard.mode(), 'on');
  await feed(3, { remoteAddr: '203.0.113.51' });
  assert.equal(bans.length, 4);
  assert.equal(savedAutoAt.length, 1, 'stored once');

  // A site whose settings changed is reloaded (siteChanged), not after the 60 s cache.
  sites.set(1, { ...sites.get(1)!, enabled: false });
  cmsGuard.siteChanged(1);
  await feed(3, { remoteAddr: '203.0.113.52' });
  assert.equal(bans.length, 4);

  cmsGuard.setDepsForTests(null);
});

test('guard: hourly budget of new bans', async () => {
  let now = Date.parse('2026-11-04T12:00:00Z');
  let banned = 0;
  cmsGuard.setDepsForTests({
    now: () => now,
    settings: async () => ({ ...DEFAULT_HOSTING_SETTINGS.bans, cmsGuardMode: 'on', cmsGuardMaxFailures: 3 }),
    site: async (id) => ({ id, accountId: 1, tenantId: 1, name: 's', accountUsername: 'a', enabled: true, maxFailures: null, windowMinutes: null }),
    sessionIps: async () => [],
    banGuard: async () => ({ protectedNets: [], nodeAddresses: [], neverBan: [] }),
    ban: async () => { banned++; return null; },
  });
  const line = (i: number) => ({ siteId: 1, remoteAddr: `2001:db8:${(i >> 8) & 0xff}:${i & 0xff}::1`, method: 'POST', uri: '/user/login', status: 200, host: 'x.example.com', at: now });
  const out: string[] = [];
  for (let i = 0; i <= CMS_MAX_NEW_BANS_PER_HOUR; i++) for (let k = 0; k < 3; k++) out.push(await cmsGuard.apply(line(i)));
  assert.equal(banned, CMS_MAX_NEW_BANS_PER_HOUR);
  assert.equal(out.at(-1), 'budget');
  now += 3_600_001;
  for (let k = 0; k < 3; k++) await cmsGuard.apply({ ...line(5000), at: now });
  assert.equal(banned, CMS_MAX_NEW_BANS_PER_HOUR + 1, 'budget back after an hour');
  cmsGuard.setDepsForTests(null);
});
