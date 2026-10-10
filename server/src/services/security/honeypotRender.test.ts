import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aclTrapLines, baitLocations, banCheckLines, effectiveBaitPaths, HONEYPOT_PRESETS, honeypotLocationBlocks, normalizeBaitPath, type HoneypotRenderInput,
} from './honeypotRender';

// Pure nginx snippets of the honeypot / ban checks (docs/P4b-PLAN.md §9.2, H5).

const input = (over: Partial<HoneypotRenderInput> = {}): HoneypotRenderInput => ({
  proxyHostId: 7,
  accountId: 12,
  tenantId: 3,
  honeypot: { enabled: true, paths: ['/wp-login.php', '/.env'], banAclViolations: true, banDurationMinutes: null },
  routePaths: [],
  logKind: 'proxy',
  ...over,
});

test('banCheckLines: platform check always, account check for a valid id only', () => {
  assert.deepEqual(banCheckLines(null), ['    if ($oblimint_ban_p) { return 444; }']);
  assert.deepEqual(banCheckLines(12, '\t'), [
    '\tif ($oblimint_ban_p) { return 444; }',
    '\tif ($oblimint_ban_a ~ "\\|12\\|") { return 444; }',
  ]);
  // A garbage id never builds a regex.
  for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 40, '12' as unknown as number]) {
    assert.deepEqual(banCheckLines(bad), ['    if ($oblimint_ban_p) { return 444; }'], String(bad));
  }
});

test('honeypotLocationBlocks: segment-bounded locations per bait with the log variables, 404', () => {
  const lines = honeypotLocationBlocks(input(), '  ');
  assert.deepEqual(lines.slice(0, 10), [
    '  location = /wp-login.php {',
    '      set $oblimint_kind proxy;',
    '      set $oblimint_site "";',
    '      set $oblimint_account 12;',
    '      set $oblimint_tenant 3;',
    '      set $oblimint_host 7;',
    '      set $oblimint_app "";',
    '      set $oblimint_hp path;',
    '      return 404;',
    '  }',
  ]);
  assert.equal(lines.filter((l) => l.includes('  location ')).length, 4);
  for (const l of ['  location ^~ /wp-login.php/ {', '  location = /.env {', '  location ^~ /.env/ {']) assert.ok(lines.includes(l), l);
});

/** Which bait (if any) nginx would pick for a URI among the rendered prefix / exact locations. */
function baitFor(lines: string[], uri: string): string | null {
  let best: string | null = null;
  for (const l of lines) {
    const m = /location (=|\^~) (\S+) \{/.exec(l);
    if (!m) continue;
    if (m[1] === '=' && uri === m[2]) return m[2];
    if (m[1] === '^~' && uri.startsWith(m[2]) && (best === null || m[2].length > best.length)) best = m[2];
  }
  return best;
}

test('bait locations: segment-bounded, never a raw string prefix', () => {
  assert.deepEqual(baitLocations('/console'), ['= /console', '^~ /console/']);
  assert.deepEqual(baitLocations('/admin/'), ['^~ /admin/']);
  const lines = honeypotLocationBlocks(input({ honeypot: { enabled: true, paths: HONEYPOT_PRESETS.map((p) => p.path), banAclViolations: false, banDurationMinutes: null } }));
  for (const legit of ['/consoles', '/console-games/x', '/horizontal-menu.css', '/telescopes/buy', '/mysql-tutorial', '/pmax', '/administrators', '/.hgignore', '/actuators', '/backup.zip.html', '/.envelope']) {
    assert.equal(baitFor(lines, legit), null, legit);
  }
  for (const [uri, bait] of [['/console', '/console'], ['/console/login', '/console/'], ['/horizon', '/horizon'], ['/.env', '/.env'], ['/wp-admin/install.php', '/wp-admin/'], ['/.git/config', '/.git/config']]) {
    assert.equal(baitFor(lines, uri), bait, uri);
  }
});

test('honeypotLocationBlocks: disabled honeypot, invalid ids, bad log kind', () => {
  assert.deepEqual(honeypotLocationBlocks(input({ honeypot: { enabled: false, paths: ['/x'], banAclViolations: false, banDurationMinutes: null } })), []);
  assert.deepEqual(honeypotLocationBlocks(input({ proxyHostId: 0 })), []);
  assert.deepEqual(honeypotLocationBlocks(input({ accountId: -3 })), []);
  const lines = honeypotLocationBlocks(input({ logKind: 'proxy; return 200' }));
  assert.ok(lines.includes('        set $oblimint_kind proxy;'), 'an invalid kind falls back to proxy');
});

test('bait paths: hostile values are dropped, never escaped (H5)', () => {
  const hostile = [
    '/a;b', '/a{', '/a}', '/a\nlocation / {', '/a$b', '/a"b', "/a'b", '/a b', '/a\\b', 'relative', '', '/', '/../etc', '/a/../b',
    '/a/./b', '//double', `/${'x'.repeat(200)}`, '/a#b', '/a?b', '/a%2e', '/ä', 42 as unknown as string,
  ];
  for (const p of hostile) assert.equal(normalizeBaitPath(p), null, JSON.stringify(p));
  for (const p of ['/wp-login.php', '/.env', '/.git/config', '/a~b', '/x-y_z', '/admin/', `/${'x'.repeat(199)}`]) {
    assert.equal(normalizeBaitPath(p), p);
  }
  assert.equal(normalizeBaitPath('  /.env  '), '/.env', 'trimmed');
  const lines = honeypotLocationBlocks(input({ honeypot: { enabled: true, paths: hostile, banAclViolations: false, banDurationMinutes: null } }));
  assert.deepEqual(lines, []);
});

test('bait paths: a route wins (equal / under), reserved locations skipped, duplicates removed', () => {
  const hp = { enabled: true, paths: ['/api', '/api/v1/actuator', '/apix', '/admin/', '/admin/x', '/.env', '/.env', '/oauth2/start', '/.well-known/acme-challenge/x', '/__oblimint/ping', '/b'], banAclViolations: false, banDurationMinutes: null };
  assert.deepEqual(effectiveBaitPaths(hp, ['/api', '/admin/', '/']), ['/apix', '/.env', '/b']);
  // '/shop' next to a route '/shop/' (its `= /shop` redirect + `^~ /shop/`): the route wins.
  assert.deepEqual(effectiveBaitPaths({ ...hp, paths: ['/shop', '/shopx'] }, ['/shop/']), ['/shopx']);
  // Two baits never render the same location.
  assert.deepEqual(effectiveBaitPaths({ ...hp, paths: ['/admin', '/admin/', '/admin/x'] }, []), ['/admin', '/admin/x']);
  // The root location never shadows a bait.
  assert.deepEqual(effectiveBaitPaths({ ...hp, paths: ['/x'] }, ['/']), ['/x']);
  assert.deepEqual(effectiveBaitPaths(null, []), []);
});

test('reserved bait paths: internal locations by raw prefix, refused by the validator', () => {
  for (const p of ['/__oblimint_edge/', '/__oblimint_px/404.html', '/__oblimint_fa/auth', '/__oblimint', '/__oblimintx', '/oauth2', '/oauth2/start', '/.well-known/acme-challenge/x']) {
    assert.equal(normalizeBaitPath(p), null, p);
  }
  for (const p of ['/__oblimin', '/oauth2x', '/.well-known']) assert.equal(normalizeBaitPath(p), p, p);
  assert.deepEqual(effectiveBaitPaths({ enabled: true, paths: ['/__oblimint_px/404.html', '/__oblimint_edge/', '/x'], banAclViolations: false, banDurationMinutes: null }, []), ['/x']);
});

test('aclTrapLines: error_page + named location with $oblimint_hp acl; none without banAclViolations', () => {
  assert.deepEqual(aclTrapLines(input()), [
    '    set $oblimint_fa_status "";',
    '    auth_request_set $oblimint_fa_status $upstream_status;',
    '    error_page 403 = @oblimint_acl_trap;',
    '    location @oblimint_acl_trap {',
    '        if ($oblimint_exploit) { return 403; }',
    '        if ($oblimint_fa_status ~ "403") { return 403; }',
    '        set $oblimint_kind proxy;',
    '        set $oblimint_site "";',
    '        set $oblimint_account 12;',
    '        set $oblimint_tenant 3;',
    '        set $oblimint_host 7;',
    '        set $oblimint_app "";',
    '        set $oblimint_hp acl;',
    '        return 404;',
    '    }',
  ]);
  assert.deepEqual(aclTrapLines(input({ honeypot: { enabled: true, paths: [], banAclViolations: false, banDurationMinutes: null } })), []);
  assert.deepEqual(aclTrapLines(input({ tenantId: 0 })), []);
});

test('HONEYPOT_PRESETS: ~45+ valid, unique, categorized paths, all rendered', () => {
  assert.ok(HONEYPOT_PRESETS.length >= 45, String(HONEYPOT_PRESETS.length));
  const cats = new Set(['wordpress', 'secrets', 'vcs', 'admin', 'java', 'php', 'iot', 'other']);
  const seen = new Set<string>();
  for (const p of HONEYPOT_PRESETS) {
    assert.equal(normalizeBaitPath(p.path), p.path, p.path);
    assert.ok(cats.has(p.category), p.category);
    assert.ok(!seen.has(p.path), `duplicate ${p.path}`);
    seen.add(p.path);
  }
  for (const must of ['/wp-login.php', '/wp-admin', '/.env', '/.git/config', '/.aws/credentials', '/phpmyadmin', '/actuator', '/server-status', '/vendor/phpunit', '/HNAP1', '/api/jsonws/invoke']) {
    assert.ok(seen.has(must), must);
  }
  const lines = honeypotLocationBlocks(input({ honeypot: { enabled: true, paths: HONEYPOT_PRESETS.map((p) => p.path), banAclViolations: false, banDurationMinutes: null } }));
  const expected = HONEYPOT_PRESETS.reduce((n, p) => n + baitLocations(p.path).length, 0);
  assert.equal(lines.filter((l) => /location (=|\^~) /.test(l)).length, expected);
  assert.ok(Object.isFrozen(HONEYPOT_PRESETS));
});
