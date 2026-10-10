import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBanInput, refuseBanKey, webBanKey, type WebBanGuard } from './addresses';

// Never-ban classification and ban keys (docs/P4b-PLAN.md §9.5, BN1).

const guard: WebBanGuard = {
  protectedNets: ['10.224.0.0/12', '198.51.100.0/24', '2001:db8:dead::/48'],
  nodeAddresses: ['203.0.113.10', '2001:db8:1:2::10'],
  neverBan: ['192.0.2.128/25', '2a01:4f8:aa::/48', '45.1.1.1'],
};

test('webBanKey: IPv4 address, IPv6 /64, v4-mapped unmapped', () => {
  assert.equal(webBanKey('8.8.8.8', guard), '8.8.8.8');
  assert.equal(webBanKey(' 8.8.4.4 ', guard), '8.8.4.4');
  assert.equal(webBanKey('2a00:1450:4007:80e::200e', guard), '2a00:1450:4007:80e::/64');
  assert.equal(webBanKey('2A00:1450:4007:080E:0:0:0:1', guard), '2a00:1450:4007:80e::/64');
  assert.equal(webBanKey('::ffff:8.8.8.8', guard), '8.8.8.8');
  assert.equal(webBanKey('[2a00:1450:4007:80e::1]', guard), '2a00:1450:4007:80e::/64');
});

test('webBanKey: every non-public range is refused', () => {
  for (const ip of [
    '127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.5.4', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.254',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:10.0.0.1',
  ]) {
    assert.equal(webBanKey(ip, guard), null, ip);
    assert.equal(refuseBanKey(parseBanInput(ip) ?? ip, guard), parseBanInput(ip) ? 'notPublic' : 'invalid', ip);
  }
  // Edges of the ranges that ARE public.
  assert.equal(webBanKey('172.32.0.1', guard), '172.32.0.1');
  assert.equal(webBanKey('100.128.0.1', guard), '100.128.0.1');
  assert.equal(webBanKey('11.0.0.1', guard), '11.0.0.1');
});

test('webBanKey: node addresses, its /64, Docker subnets, neverBan (overlap for /64)', () => {
  assert.equal(webBanKey('203.0.113.10', guard), null);
  assert.equal(refuseBanKey('203.0.113.10', guard), 'node');
  assert.equal(webBanKey('2001:db8:1:2::abcd', guard), null, 'node /64');
  assert.equal(webBanKey('2001:db8:1:3::abcd', guard), '2001:db8:1:3::/64');
  assert.equal(refuseBanKey('198.51.100.7', guard), 'protected');
  assert.equal(refuseBanKey('2001:db8:dead:5::/64', guard), 'protected');
  assert.equal(refuseBanKey('192.0.2.200', guard), 'neverBan');
  assert.equal(refuseBanKey('192.0.2.1', guard), null);
  assert.equal(refuseBanKey('45.1.1.1', guard), 'neverBan');
  assert.equal(refuseBanKey('2a01:4f8:aa:1::/64', guard), 'neverBan');
  // A never-ban host INSIDE a /64 key blocks the whole /64.
  assert.equal(refuseBanKey('2a02:1:2:3::/64', { ...guard, neverBan: ['2a02:1:2:3::99'] }), 'neverBan');
  // Garbage in the guard is ignored.
  assert.equal(refuseBanKey('8.8.8.8', { protectedNets: ['nope'], nodeAddresses: ['x'], neverBan: ['300.1.1.1/8'] }), null);
});

test('parseBanInput: address, exact /32 or /64, nothing wider', () => {
  assert.equal(parseBanInput('8.8.8.8'), '8.8.8.8');
  assert.equal(parseBanInput('8.8.8.8/32'), '8.8.8.8');
  assert.equal(parseBanInput('2a00:1450:4007:80e::5'), '2a00:1450:4007:80e::/64');
  assert.equal(parseBanInput('2a00:1450:4007:80e:1:2:3:4/64'), '2a00:1450:4007:80e::/64');
  for (const bad of ['8.8.8.0/24', '2a00:1450::/48', '2a00:1450:4007:80e::1/128', '8.8.8', '8.8.8.8/33', 'x', '', null, 42, '1.2.3.4; drop']) {
    assert.equal(parseBanInput(bad), null, String(bad));
  }
});
