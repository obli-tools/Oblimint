import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMailFirewallState, MAX_MAIL_BANS, mailBanKey, type BanGuard } from './bans';

const guard: BanGuard = {
  protectedNets: ['172.20.0.0/16', 'fd00:dead:beef::/48', '198.51.100.0/24'],
  nodeAddresses: ['203.0.113.5', '2001:db8:5:5::1'],
};

test('ban key: IPv4 address, IPv6 /64', () => {
  assert.equal(mailBanKey('203.0.113.9', guard), '203.0.113.9');
  assert.equal(mailBanKey('::ffff:203.0.113.9', guard), '203.0.113.9');
  assert.equal(mailBanKey('2001:db8:aa:bb:1:2:3:4', guard), '2001:db8:aa:bb::/64');
  assert.equal(mailBanKey('[2001:db8:aa:bb::9]', guard), '2001:db8:aa:bb::/64');
});

test('never banned: internal, loopback, link-local, private, node, protected subnets (MA8)', () => {
  for (const ip of [
    '127.0.0.1', '::1', '0.0.0.0', '::',
    '169.254.1.1', 'fe80::1',
    '10.1.2.3', '172.17.0.2', '192.168.1.10', 'fd12:3456::1', // Docker / LAN
    '10.0.0.151', // a LAN client brute-forcing (the Linux test host): deliberately never banned (plan §9.6)
    '100.64.0.1', // CGNAT
    '224.0.0.5', 'ff02::1',
    '203.0.113.5', // the node
    '2001:db8:5:5::abcd', // the node's /64
    '198.51.100.7', // protected subnet (custom Docker pool on a public range)
    'not an ip', '1.2.3', '203.0.113.9%eth0', '',
  ]) {
    assert.equal(mailBanKey(ip, guard), null, ip);
  }
});

test('hostd state: live bans only, latest expiry first, deduplicated, capped, mail ports', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  const s = buildMailFirewallState([
    { ip: '203.0.113.9', expiresAt: '2026-10-09T13:00:00Z' },
    { ip: '203.0.113.10', expiresAt: '2026-10-09T11:00:00Z' }, // expired
    { ip: '203.0.113.11', expiresAt: new Date('2026-10-09T12:00:00.500Z') }, // < 1 s: gone anyway
    { ip: '2001:db8:aa:bb::/64', expiresAt: '2026-10-09T14:00:00Z' },
    { ip: '203.0.113.9', expiresAt: '2026-10-09T12:30:00Z' }, // duplicate: the later expiry wins
  ], now);
  assert.deepEqual(s.ports, [25, 110, 143, 465, 587, 993, 995, 4190]);
  assert.deepEqual(s.bans, [
    { cidr: '2001:db8:aa:bb::/64', expiresAt: '2026-10-09T14:00:00.000Z' },
    { cidr: '203.0.113.9', expiresAt: '2026-10-09T13:00:00.000Z' },
  ]);
  const many = Array.from({ length: MAX_MAIL_BANS + 10 }, (_, i) => ({ ip: `203.0.${Math.floor(i / 250)}.${i % 250}`, expiresAt: new Date(now.getTime() + 60_000 + i * 1000) }));
  const capped = buildMailFirewallState(many, now);
  assert.equal(capped.bans.length, MAX_MAIL_BANS);
  assert.equal(capped.bans[0].cidr, many[many.length - 1].ip, 'the latest-expiring are kept');
});
