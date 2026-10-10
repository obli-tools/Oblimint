import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNIT_ID_RE } from '../edge/units';
import { BANS_FALLBACK_CONFIG, bansUnit, buildWebFirewallState, MAX_FIREWALL_BANS, renderBansConfig, type ActiveBan } from './bansUnit';

// g-bans unit + hostd web firewall body (docs/P4b-PLAN.md §9.2, §9.4).

const now = new Date('2026-10-10T12:00:00Z');
const later = (min: number) => new Date(now.getTime() + min * 60_000);

const bans: ActiveBan[] = [
  { ip: '8.8.8.8', scope: 'account', accountId: 15, bannedUntil: later(60) },
  { ip: '8.8.8.8', scope: 'account', accountId: 12, bannedUntil: null },
  { ip: '9.9.9.9', scope: 'platform', accountId: null, bannedUntil: later(5) },
  { ip: '9.9.9.9', scope: 'account', accountId: 12, bannedUntil: later(5) },
  { ip: '2a00:1450:4007:80e::/64', scope: 'platform', accountId: null, bannedUntil: null },
  { ip: '2a00:1:2:3::/64', scope: 'account', accountId: 3, bannedUntil: later(1) },
  // expired / invalid rows never rendered
  { ip: '7.7.7.7', scope: 'platform', accountId: null, bannedUntil: later(-1) },
  { ip: '6.6.6.6; deny all', scope: 'platform', accountId: null, bannedUntil: null },
  { ip: '2a00:1:2:3::1', scope: 'account', accountId: 3, bannedUntil: null },
  { ip: '5.5.5.5', scope: 'account', accountId: null, bannedUntil: null },
];

test('renderBansConfig: platform geo + account geo, sorted, platform supersedes', () => {
  assert.equal(renderBansConfig(bans, now), [
    '# Oblimint web bans: 2 platform, 3 account address(es)',
    'geo $remote_addr $oblimint_ban_p {',
    '    default 0;',
    '    2a00:1450:4007:80e::/64 1;',
    '    9.9.9.9 1;',
    '}',
    'geo $remote_addr $oblimint_ban_a {',
    '    default "";',
    '    2a00:1:2:3::/64 "|3|";',
    '    8.8.8.8 "|12|15|";',
    '}',
    '',
  ].join('\n'));
  assert.equal(renderBansConfig([], now), [
    '# Oblimint web bans: 0 platform, 0 account address(es)',
    'geo $remote_addr $oblimint_ban_p {', '    default 0;', '}',
    'geo $remote_addr $oblimint_ban_a {', '    default "";', '}', '',
  ].join('\n'));
});

test('bansUnit: global http unit g-bans with a defaults-only fallback; disabled = fallback', () => {
  const u = bansUnit(bans, now);
  assert.ok(UNIT_ID_RE.test(u.id));
  assert.equal(u.id, 'g-bans');
  assert.equal(u.scope, 'http');
  assert.equal(u.level, 'global');
  assert.deepEqual(u.serverNames, []);
  assert.equal(u.fallbackConfig, BANS_FALLBACK_CONFIG);
  assert.match(u.fallbackConfig!, /geo \$remote_addr \$oblimint_ban_p \{\n {4}default 0;\n\}/);
  assert.match(u.fallbackConfig!, /geo \$remote_addr \$oblimint_ban_a \{\n {4}default "";\n\}/);
  assert.ok(!/include|load_module|proxy_pass/.test(u.config));
  assert.equal(bansUnit(bans, now, false).config, BANS_FALLBACK_CONFIG);
});

test('buildWebFirewallState: live platform bans only, permanent first, capped, off = empty', () => {
  const st = buildWebFirewallState(bans, now, true);
  assert.deepEqual(st.ports, [80, 443]);
  assert.deepEqual(st.bans, [
    { cidr: '2a00:1450:4007:80e::/64', expiresAt: null },
    { cidr: '9.9.9.9', expiresAt: later(5).toISOString() },
  ]);
  assert.deepEqual(buildWebFirewallState(bans, now, false), { ports: [80, 443], bans: [] });
  // Under a second left: not pushed (nft cannot express it).
  assert.deepEqual(buildWebFirewallState([{ ip: '1.1.1.1', scope: 'platform', accountId: null, bannedUntil: new Date(now.getTime() + 500) }], now, true).bans, []);
  const many: ActiveBan[] = Array.from({ length: MAX_FIREWALL_BANS + 10 }, (_, i) => ({
    ip: `11.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, scope: 'platform', accountId: null, bannedUntil: null,
  }));
  assert.equal(buildWebFirewallState(many, now, true).bans.length, MAX_FIREWALL_BANS);
});
