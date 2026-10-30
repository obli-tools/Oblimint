import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KeySecuritySettings } from '@oblimint/shared';
import { DEFAULT_KEY_SECURITY_SETTINGS, effectiveKeyStrictMode } from '@oblimint/shared';
import {
  BAN_SATURATION, computeRegime, effectiveKeyList, FailureWindow, ipMatcher, requireIpFor, SaturationIndex, widerNetworks, type ActiveKeyRow,
} from './keySurfaceRules';
import { keySurfaceGuard, MAX_NEW_BANS_PER_HOUR, type KeySurfaceDeps } from './keySurfaceGuard';
import type { KeySurfaceBanInput } from './bans.service';

// Spec §9 keySurfaceGuard.test.ts: regime (no key → watch, an open key → watch,
// every key closed → strict, connector with / without ranges), exemptions,
// failure window — the guard driven through injected dependencies (no database).

const ANTHROPIC = '160.79.104.0/21';

const key = (id: number, kind: 'key' | 'connector', allowedIps: string[]): ActiveKeyRow => ({
  id, name: `k${id}`, kind, allowedIps, tenantId: 1, tenantName: 'Default', accountId: 10, accountUsername: 'acme', owner: 'owner',
});

test('regime: no key, an open key, every key closed, connectors with and without ranges', () => {
  assert.equal(computeRegime([], [ANTHROPIC]).regime, 'watch');
  const open = computeRegime([key(1, 'key', ['203.0.113.4']), key(2, 'key', [])], [ANTHROPIC]);
  assert.equal(open.regime, 'watch');
  assert.deepEqual(open.openKeys.map((k) => k.id), [2]);
  const closed = computeRegime([key(1, 'key', ['203.0.113.4']), key(2, 'key', ['198.51.100.0/24'])], [ANTHROPIC]);
  assert.equal(closed.regime, 'strict');
  assert.deepEqual(closed.allowList.sort(), ['198.51.100.0/24', '203.0.113.4']);
  // A connector without addresses is open (like a key), whatever the ranges…
  assert.equal(computeRegime([key(1, 'key', ['203.0.113.4']), key(3, 'connector', [])], [ANTHROPIC]).regime, 'watch');
  // … a connector with addresses is closed, its list widened by the connectors' ranges.
  const conn = computeRegime([key(1, 'key', ['203.0.113.4']), key(3, 'connector', ['198.51.100.7'])], [ANTHROPIC]);
  assert.equal(conn.regime, 'strict');
  assert.ok(conn.allowList.includes(ANTHROPIC));
  assert.deepEqual(effectiveKeyList('connector', ['203.0.113.9'], [ANTHROPIC]), ['203.0.113.9', ANTHROPIC]);
  assert.equal(effectiveKeyList('key', [], [ANTHROPIC]), null);
  assert.equal(computeRegime([key(1, 'key', ['203.0.113.4'])], []).activeKeys, 1);
});

test('ipMatcher: addresses, CIDR v4 / v6, invalid entries ignored', () => {
  const m = ipMatcher(['203.0.113.4', '198.51.100.0/24', '2001:db8:1::/48', 'not an ip', ANTHROPIC]);
  assert.equal(m('203.0.113.4'), true);
  assert.equal(m('203.0.113.5'), false);
  assert.equal(m('198.51.100.77'), true);
  assert.equal(m('::ffff:198.51.100.77'), true);
  assert.equal(m('2001:db8:1:2::5'), true);
  assert.equal(m('2001:db8:2::5'), false);
  assert.equal(m('160.79.110.1'), true);
  assert.equal(m('garbage'), false);
});

test('requireIpFor: the tenant value wins, null inherits the platform', () => {
  assert.equal(requireIpFor(null, true), true);
  assert.equal(requireIpFor(undefined, false), false);
  assert.equal(requireIpFor(false, true), false);
  assert.equal(requireIpFor(true, false), true);
});

test('failure window: sliding, per address', () => {
  const w = new FailureWindow();
  const win = 15 * 60_000;
  assert.equal(w.record('a', 0, win), 1);
  assert.equal(w.record('a', 60_000, win), 2);
  assert.equal(w.record('b', 60_000, win), 1);
  assert.equal(w.record('a', win + 30_000, win), 2); // the first one left the window
  assert.equal(w.count('a', win + 30_000, win), 2);
  w.clear('a');
  assert.equal(w.count('a', win + 30_000, win), 0);
});

test('effective strict mode: auto is log-only until autoStrictAt', () => {
  const at = '2026-10-30T12:00:00.000Z';
  assert.equal(effectiveKeyStrictMode({ strictMode: 'auto', autoStrictAt: null }), 'log');
  assert.equal(effectiveKeyStrictMode({ strictMode: 'auto', autoStrictAt: at }, Date.parse(at) - 1), 'log');
  assert.equal(effectiveKeyStrictMode({ strictMode: 'auto', autoStrictAt: at }, Date.parse(at)), 'on');
  assert.equal(effectiveKeyStrictMode({ strictMode: 'off', autoStrictAt: at }, Date.parse(at) + 1), 'off');
});

// ── the guard, with fakes ────────────────────────────────────────────────────

interface Harness {
  settings: KeySecuritySettings;
  keys: ActiveKeyRow[];
  sessions: string[];
  bans: Map<string, number | null>;
  banned: KeySurfaceBanInput[];
  notified: Array<{ event: string; key: string }>;
  wouldBan: string[];
  config: Map<string, string>;
  now: number;
  edgeResyncs: number;
}

function harness(over: Partial<KeySecuritySettings> = {}): Harness {
  const h: Harness = {
    settings: { ...DEFAULT_KEY_SECURITY_SETTINGS, strictMode: 'on', autoStrictAt: null, ...over },
    // The connector has an address: closed, its list widened by the connectors' ranges.
    keys: [key(1, 'key', ['203.0.113.4']), key(2, 'connector', ['203.0.113.250'])],
    sessions: [],
    bans: new Map(),
    banned: [],
    notified: [],
    wouldBan: [],
    config: new Map(),
    now: Date.parse('2026-10-30T10:00:00Z'),
    edgeResyncs: 0,
  };
  const deps: Partial<KeySurfaceDeps> = {
    now: () => h.now,
    settings: async () => h.settings,
    saveAutoStrictAt: async (at) => { h.settings = { ...h.settings, autoStrictAt: at }; },
    activeKeys: async () => h.keys,
    adminSessionIps: async () => h.sessions,
    banGuard: async () => ({ protectedNets: ['172.17.0.0/16'], nodeAddresses: ['203.0.113.10'], neverBan: ['45.1.1.0/24'] }),
    platformBans: async () => new Map(h.bans),
    ban: async (input) => {
      h.banned.push(input);
      const until = input.permanent ? null : h.now + 60 * 60_000;
      h.bans.set(input.key, until);
      return { until };
    },
    notify: (event, payload) => { h.notified.push({ event, key: payload.key }); },
    configGet: async (k) => h.config.get(k) ?? null,
    configSet: async (k, v) => { h.config.set(k, v); },
    logWouldBan: async (ip) => { h.wouldBan.push(ip); },
    bansChangedElsewhere: () => { h.edgeResyncs++; },
  };
  keySurfaceGuard.setDepsForTests(deps);
  return h;
}

test('strict: an address outside every list is banned at once, permanently; allowed ones pass', async (t) => {
  t.after(() => keySurfaceGuard.setDepsForTests(null));
  const h = harness();
  assert.deepEqual(await keySurfaceGuard.gate('203.0.113.4', 'mcp'), { allowed: true, exempt: null });
  assert.deepEqual(await keySurfaceGuard.gate('203.0.113.99', 'key-api'), { allowed: false, reason: 'intrusion' });
  assert.equal(h.banned.length, 1);
  assert.equal(h.banned[0].source, 'key-intrusion');
  assert.equal(h.banned[0].permanent, true);
  assert.match(h.banned[0].reason, /\/api\/v1/);
  // Banned from now on (cache updated at once), without a second ban.
  assert.deepEqual(await keySurfaceGuard.gate('203.0.113.99', 'mcp'), { allowed: false, reason: 'banned' });
  assert.equal(h.banned.length, 1);
  // IPv6: the /64 is the key.
  await keySurfaceGuard.gate('2001:db8:5:6::1', 'oauth-token');
  assert.equal(h.banned[1].key, '2001:db8:5:6::/64');
});

test('watch: an open key (or no key) never bans an unknown address', async (t) => {
  t.after(() => keySurfaceGuard.setDepsForTests(null));
  const h = harness();
  h.keys = [key(1, 'key', ['203.0.113.4']), key(5, 'key', [])];
  assert.deepEqual(await keySurfaceGuard.gate('203.0.113.99', 'mcp'), { allowed: true, exempt: null });
  keySurfaceGuard.invalidate();
  h.keys = [];
  assert.deepEqual(await keySurfaceGuard.gate('203.0.113.98', 'mcp'), { allowed: true, exempt: null });
  assert.equal(h.banned.length, 0);
});

test('exemptions: never-ban, trusted, platform-admin session, Anthropic ranges, relays', async (t) => {
  t.after(() => keySurfaceGuard.setDepsForTests(null));
  const h = harness({ trustedIps: ['198.51.100.0/24'] });
  h.sessions = ['192.0.2.50'];
  assert.deepEqual(await keySurfaceGuard.gate('127.0.0.1', 'mcp'), { allowed: true, exempt: 'neverBanned' });
  assert.deepEqual(await keySurfaceGuard.gate('10.1.2.3', 'mcp'), { allowed: true, exempt: 'neverBanned' });
  assert.deepEqual(await keySurfaceGuard.gate('45.1.1.9', 'mcp'), { allowed: true, exempt: 'neverBanned' });
  assert.deepEqual(await keySurfaceGuard.gate('203.0.113.10', 'mcp'), { allowed: true, exempt: 'neverBanned' });
  assert.deepEqual(await keySurfaceGuard.gate('198.51.100.20', 'mcp'), { allowed: true, exempt: 'trusted' });
  assert.deepEqual(await keySurfaceGuard.gate('192.0.2.50', 'mcp'), { allowed: true, exempt: 'adminSession' });
  assert.deepEqual(await keySurfaceGuard.gate('160.79.105.3', 'mcp'), { allowed: true, exempt: 'connectorRange' });
  assert.deepEqual(await keySurfaceGuard.gate('203.0.113.77', 'mcp', { relay: true }), { allowed: true, exempt: 'neverBanned' });
  assert.equal(h.banned.length, 0);
  // Their bad keys are not counted…
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(await keySurfaceGuard.recordFailure('198.51.100.20', 'mcp', 'unknown'), { banned: false });
    assert.deepEqual(await keySurfaceGuard.recordFailure('192.0.2.50', 'mcp', 'unknown'), { banned: false });
  }
  // … and the connectors' ranges are never banned: an alert past the threshold.
  for (let i = 0; i < 5; i++) assert.deepEqual(await keySurfaceGuard.recordFailure('160.79.105.3', 'mcp', 'expired'), { banned: false });
  assert.equal(h.banned.length, 0);
  assert.deepEqual(h.notified.map((n) => n.event), ['security.keyAbuse']);
  // A trusted address stays reachable even with a stale ban (never locked out).
  h.bans.set('198.51.100.20', null);
  keySurfaceGuard.invalidate();
  assert.equal((await keySurfaceGuard.gate('198.51.100.20', 'mcp')).allowed, true);
});

test('failures: maxFailures within the window ⇒ escalating key-bruteforce ban; the window slides', async (t) => {
  t.after(() => keySurfaceGuard.setDepsForTests(null));
  const h = harness({ maxFailures: 3, failureWindowMinutes: 10 });
  assert.deepEqual(await keySurfaceGuard.recordFailure('203.0.113.4', 'key-api', 'unknown'), { banned: false });
  assert.deepEqual(await keySurfaceGuard.recordFailure('203.0.113.4', 'key-api', 'unknown'), { banned: false });
  h.now += 11 * 60_000; // both left the window
  assert.deepEqual(await keySurfaceGuard.recordFailure('203.0.113.4', 'key-api', 'ipNotAllowed'), { banned: false });
  assert.deepEqual(await keySurfaceGuard.recordFailure('203.0.113.4', 'key-api', 'ipNotAllowed'), { banned: false });
  assert.deepEqual(await keySurfaceGuard.recordFailure('203.0.113.4', 'key-api', 'ipNotAllowed'), { banned: true });
  assert.equal(h.banned.length, 1);
  assert.equal(h.banned[0].source, 'key-bruteforce');
  assert.equal(h.banned[0].permanent, false);
  assert.match(h.banned[0].reason, /3 tentatives.*ipNotAllowed/);
  assert.deepEqual(await keySurfaceGuard.gate('203.0.113.4', 'key-api'), { allowed: false, reason: 'banned' });
  // Lifted: the address and its counter are forgotten at once.
  h.bans.clear();
  keySurfaceGuard.banLifted('203.0.113.4');
  assert.deepEqual(await keySurfaceGuard.gate('203.0.113.4', 'key-api'), { allowed: true, exempt: null });
});

test('strict mode log / off: nothing banned, "would have banned" journaled once per 10 min', async (t) => {
  t.after(() => keySurfaceGuard.setDepsForTests(null));
  const h = harness({ strictMode: 'log' });
  assert.deepEqual(await keySurfaceGuard.gate('203.0.113.99', 'mcp'), { allowed: true, exempt: null });
  assert.deepEqual(await keySurfaceGuard.gate('203.0.113.99', 'mcp'), { allowed: true, exempt: null });
  assert.deepEqual(h.wouldBan, ['203.0.113.99']);
  h.now += 11 * 60_000;
  await keySurfaceGuard.gate('203.0.113.99', 'mcp');
  assert.equal(h.wouldBan.length, 2);
  h.settings = { ...h.settings, strictMode: 'off' };
  assert.deepEqual(await keySurfaceGuard.gate('203.0.113.98', 'mcp'), { allowed: true, exempt: null });
  assert.equal(h.banned.length, 0);
  assert.equal(h.wouldBan.length, 2);
});

test('auto: 48 h of log-only from the first run, then strict with one notification', async (t) => {
  t.after(() => keySurfaceGuard.setDepsForTests(null));
  const h = harness({ strictMode: 'auto', autoStrictAt: null });
  assert.equal((await keySurfaceGuard.gate('203.0.113.99', 'mcp')).allowed, true);
  assert.equal(h.settings.autoStrictAt, new Date(h.now + 48 * 3_600_000).toISOString());
  assert.equal(h.banned.length, 0);
  assert.equal(h.wouldBan.length, 1);
  await keySurfaceGuard.tick();
  assert.equal(h.notified.length, 0); // first tick: regime stored silently, still log-only
  h.now += 48 * 3_600_000;
  await keySurfaceGuard.tick();
  await keySurfaceGuard.tick();
  assert.deepEqual(h.notified.map((n) => n.key), ['auto-strict-on']);
  assert.deepEqual(await keySurfaceGuard.gate('203.0.113.97', 'mcp'), { allowed: false, reason: 'intrusion' });
});

test('regime: a key entry wider than an IPv4 /16 or an IPv6 /48 counts as open (tooWide)', () => {
  const r = computeRegime([
    key(1, 'key', ['203.0.113.4']), key(2, 'key', ['11.0.0.0/8']), key(3, 'key', ['2001:db8::/32']),
    key(4, 'key', ['2001:db8:1::/48', '198.51.0.0/16']), key(5, 'connector', []), key(6, 'key', []),
  ], [ANTHROPIC]);
  assert.equal(r.regime, 'watch');
  assert.deepEqual(r.openKeys.map((k) => [k.id, k.why]), [[2, 'tooWide'], [3, 'tooWide'], [5, 'noIp'], [6, 'noIp']]);
  assert.ok(!r.allowList.includes('11.0.0.0/8'), 'a wide entry never joins the allow-list');
  assert.ok(r.allowList.includes('2001:db8:1::/48'));
  // The connectors' ranges (platform setting) never make a connector "wide".
  assert.equal(computeRegime([key(5, 'connector', ['203.0.113.5'])], ['160.0.0.0/8']).regime, 'strict');
  // An IP-less connector is open, like an IP-less key (each account secures its own keys).
  assert.equal(computeRegime([key(5, 'connector', [])], [ANTHROPIC]).regime, 'watch');
  assert.equal(effectiveKeyList('connector', [], [ANTHROPIC]), null);
  assert.equal(effectiveKeyList('connector', [], []), null);
});

test('saturation index: /64 bans counted per /48 and /32', () => {
  const s = new SaturationIndex();
  for (let i = 0; i < BAN_SATURATION[0].max - 1; i++) s.add(`2001:db8:aa:${i.toString(16)}::/64`);
  assert.equal(s.saturated('2001:db8:aa:ff::/64'), null);
  s.add('2001:db8:aa:ff::/64');
  s.add('2001:db8:aa:ff::/64'); // counted once
  assert.equal(s.saturated('2001:db8:aa:1234::/64'), '2001:db8:aa::/48');
  assert.equal(s.saturated('2001:db8:bb:1::/64'), null);
  assert.equal(s.saturated('203.0.113.9'), null, 'IPv4 is never aggregated');
  assert.deepEqual(widerNetworks('2001:db8:aa:1::/64'), ['2001:db8:aa::/48', '2001:db8::/32']);
});

test('IPv6: an exempt address protects its whole /64 (the ban key) — never a neighbour ban that locks it out', async (t) => {
  t.after(() => keySurfaceGuard.setDepsForTests(null));
  const h = harness({ trustedIps: ['2001:db8:7:8::1'] });
  h.sessions = ['2001:db8:1:2::a'];
  assert.deepEqual(await keySurfaceGuard.gate('2001:db8:1:2::b', 'mcp'), { allowed: true, exempt: 'adminSession' });
  assert.deepEqual(await keySurfaceGuard.gate('2001:db8:7:8::99', 'mcp'), { allowed: true, exempt: 'trusted' });
  for (let i = 0; i < 10; i++) assert.deepEqual(await keySurfaceGuard.recordFailure('2001:db8:1:2::c', 'mcp', 'unknown'), { banned: false });
  assert.equal(h.banned.length, 0);
  // Another /64 of the same /48 is not exempt.
  assert.deepEqual(await keySurfaceGuard.gate('2001:db8:1:3::b', 'mcp'), { allowed: false, reason: 'intrusion' });
  assert.equal(h.banned[0].key, '2001:db8:1:3::/64');
});

test('IPv6 rotation: past BAN_SATURATION bans in a /48, the /48 is refused without new ban rows', async (t) => {
  t.after(() => keySurfaceGuard.setDepsForTests(null));
  const h = harness();
  h.keys = [...h.keys, key(7, 'key', ['2001:db8:aa:fff0::/64'])];
  const max = BAN_SATURATION[0].max;
  for (let i = 0; i < max; i++) assert.deepEqual(await keySurfaceGuard.gate(`2001:db8:aa:${i.toString(16)}::1`, 'mcp'), { allowed: false, reason: 'intrusion' });
  assert.equal(h.banned.length, max);
  for (let i = max; i < max + 50; i++) assert.deepEqual(await keySurfaceGuard.gate(`2001:db8:aa:${i.toString(16)}::1`, 'mcp'), { allowed: false, reason: 'banned' });
  assert.equal(h.banned.length, max, 'no new row for the rest of the /48');
  // Bad keys from a saturated /48 never reach a ban either (refused at the gate).
  // A key's own address inside the saturated /48 still reaches its credentials.
  assert.deepEqual(await keySurfaceGuard.gate('2001:db8:aa:fff0::5', 'mcp'), { allowed: true, exempt: null });
  // Another /48: banned normally.
  assert.deepEqual(await keySurfaceGuard.gate('2001:db8:bb:1::1', 'mcp'), { allowed: false, reason: 'intrusion' });
  assert.equal(h.banned.length, max + 1);
  // After a reload from the database (15 s cache), still saturated.
  h.now += 20_000;
  assert.deepEqual(await keySurfaceGuard.gate('2001:db8:aa:9999::1', 'mcp'), { allowed: false, reason: 'banned' });
});

test('log-only: rotating IPv6 /64s journals one "would have banned" per /48', async (t) => {
  t.after(() => keySurfaceGuard.setDepsForTests(null));
  const h = harness({ strictMode: 'log' });
  for (let i = 0; i < 40; i++) await keySurfaceGuard.gate(`2001:db8:cc:${i.toString(16)}::1`, 'mcp');
  assert.deepEqual(h.wouldBan, ['2001:db8:cc::/64']);
});

test('ban budget: past MAX_NEW_BANS_PER_HOUR new bans in an hour, refused without a ban row, one alert', async (t) => {
  t.after(() => keySurfaceGuard.setDepsForTests(null));
  const h = harness();
  for (let i = 0; i < MAX_NEW_BANS_PER_HOUR + 20; i++) {
    const verdict = await keySurfaceGuard.gate(`5.5.${Math.floor(i / 250)}.${(i % 250) + 1}`, 'mcp');
    assert.equal(verdict.allowed, false);
  }
  assert.equal(h.banned.length, MAX_NEW_BANS_PER_HOUR);
  assert.ok(h.notified.some((n) => n.key === 'keyban-budget'));
  // Bad keys past the budget: no ban either.
  for (let i = 0; i < 5; i++) await keySurfaceGuard.recordFailure('203.0.113.4', 'mcp', 'unknown');
  assert.equal(h.banned.length, MAX_NEW_BANS_PER_HOUR);
  h.now += 3_600_000 + 1;
  for (let i = 0; i < 5; i++) await keySurfaceGuard.recordFailure('203.0.113.4', 'mcp', 'unknown');
  assert.equal(h.banned.length, MAX_NEW_BANS_PER_HOUR + 1, 'the budget refills after an hour');
});

test('tick: regime switches are notified; a CLI change resyncs the edge', async (t) => {
  t.after(() => keySurfaceGuard.setDepsForTests(null));
  const h = harness();
  await keySurfaceGuard.tick();
  assert.equal(h.config.get('key_security.last_regime'), 'strict');
  assert.equal(h.notified.length, 0);
  h.keys = [...h.keys, key(9, 'key', [])];
  await keySurfaceGuard.tick();
  assert.deepEqual(h.notified.map((n) => n.key), ['regime:watch']);
  h.keys = h.keys.filter((k) => k.id !== 9);
  await keySurfaceGuard.tick();
  assert.deepEqual(h.notified.map((n) => n.key), ['regime:watch', 'regime:strict']);
  h.config.set('key_security.generation', 'cli-1');
  await keySurfaceGuard.tick();
  assert.equal(h.edgeResyncs, 1);
  await keySurfaceGuard.tick();
  assert.equal(h.edgeResyncs, 1);
});
