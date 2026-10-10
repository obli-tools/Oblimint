import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cidrsOverlap, endpointIpv4, formatCidr4, gatewayOf, parseCidr4, parseIpv4, pickFreeSubnet, poolCapacity,
} from './ipv4';
import { relevantEvent } from './sync';
import { fabricBridgeName, observedBridgeName } from './fabric';

const c = (s: string) => parseCidr4(s)!;
const pick = (pool: string, prefix: number, taken: string[]) => {
  const r = pickFreeSubnet(c(pool), prefix, taken);
  return r ? formatCidr4(r) : null;
};

test('IPv4 parsing: canonical quads only, host bits cleared', () => {
  assert.equal(parseIpv4('10.224.0.1'), 0x0ae00001);
  assert.equal(parseIpv4('255.255.255.255'), 0xffffffff);
  for (const bad of ['10.0.0', '10.0.0.256', '010.0.0.1', '::1', '10.0.0.1 ', 'a.b.c.d', '']) assert.equal(parseIpv4(bad.trimEnd() === bad ? bad : 'x'), null, bad);
  assert.equal(formatCidr4(c('10.224.3.7/22')), '10.224.0.0/22');
  assert.equal(formatCidr4(c('10.1.2.3')), '10.1.2.3/32');
  assert.equal(parseCidr4('10.0.0.0/33'), null);
  assert.equal(parseCidr4('10.0.0.0/8/1'), null);
  assert.equal(parseCidr4('fd00::/64'), null);
  assert.equal(gatewayOf(c('10.240.0.32/27')), '10.240.0.33');
  assert.equal(endpointIpv4('172.18.0.5/16'), '172.18.0.5');
  assert.equal(endpointIpv4('fd00::5/64'), null);
  assert.equal(endpointIpv4(''), null);
  assert.ok(cidrsOverlap(c('10.0.0.0/8'), c('10.224.0.0/24')));
  assert.ok(!cidrsOverlap(c('10.224.0.0/24'), c('10.224.1.0/24')));
});

test('allocator: first free aligned block, skipping every overlap (any size)', () => {
  assert.equal(pick('10.224.0.0/12', 24, []), '10.224.0.0/24');
  assert.equal(pick('10.224.0.0/12', 24, ['10.224.0.0/24', '10.224.1.0/24']), '10.224.2.0/24');
  // A wider Docker network covering the start of the pool.
  assert.equal(pick('10.224.0.0/12', 24, ['10.224.0.0/20']), '10.224.16.0/24');
  // A tiny network in the middle of a candidate block.
  assert.equal(pick('10.224.0.0/12', 24, ['10.224.0.128/30']), '10.224.1.0/24');
  // Unsorted, overlapping, invalid and IPv6 entries.
  assert.equal(pick('10.240.0.0/12', 27, ['10.240.0.32/27', 'garbage', 'fd00::/8', '10.240.0.0/27', '10.240.0.40/29']), '10.240.0.64/27');
  // A network wider than the pool → exhausted.
  assert.equal(pick('10.224.0.0/12', 24, ['10.0.0.0/8']), null);
});

test('allocator: exhaustion and capacity', () => {
  assert.equal(poolCapacity(c('10.224.0.0/12'), 24), 4096);
  assert.equal(poolCapacity(c('10.240.0.0/12'), 27), 32768);
  assert.equal(poolCapacity(c('10.224.0.0/24'), 16), 0);
  const taken = Array.from({ length: 4 }, (_, i) => `192.168.0.${i * 64}/26`);
  assert.equal(pick('192.168.0.0/24', 26, taken.slice(0, 3)), '192.168.0.192/26');
  assert.equal(pick('192.168.0.0/24', 26, taken), null);
  // 4096 taken /24 of the fabric pool: full, found quickly.
  const all = Array.from({ length: 4096 }, (_, i) => `10.${224 + (i >> 8)}.${i & 255}.0/24`);
  const t0 = Date.now();
  assert.equal(pick('10.224.0.0/12', 24, all), null);
  assert.equal(pick('10.224.0.0/12', 24, all.filter((_, i) => i !== 4000)), '10.239.160.0/24');
  assert.ok(Date.now() - t0 < 500);
});

test('bridge names: omf / omb ≤ 15 chars, legacy br-<12 hex>', () => {
  assert.equal(fabricBridgeName(42, 'front'), 'omf42');
  assert.equal(fabricBridgeName(42, 'back'), 'omb42');
  assert.ok(fabricBridgeName(999999999999, 'back').length <= 15);
  assert.equal(observedBridgeName({ Id: '0123456789abcdef0123', Options: { 'com.docker.network.bridge.name': 'omf7' } }), 'omf7');
  assert.equal(observedBridgeName({ Id: '0123456789abcdef0123', Options: {} }), 'br-0123456789ab');
  assert.equal(observedBridgeName({ Id: 'short' }), null);
});

test('Docker events: only oblimint containers and account fabrics wake the loop', () => {
  assert.equal(relevantEvent({ Type: 'container', Action: 'start', Actor: { Attributes: { name: 'oblimint-site-3', 'oblimint.role': 'site' } } }), true);
  assert.equal(relevantEvent({ Type: 'container', Action: 'die', Actor: { Attributes: { name: 'oblimint-app-2-web' } } }), true);
  assert.equal(relevantEvent({ Type: 'container', Action: 'exec_start: sh', Actor: { Attributes: { 'oblimint.role': 'site' } } }), false);
  assert.equal(relevantEvent({ Type: 'container', Action: 'start', Actor: { Attributes: { name: 'random' } } }), false);
  assert.equal(relevantEvent({ Type: 'network', Action: 'connect', Actor: { Attributes: { name: 'oblimint-acct-4-db', container: 'x' } } }), true);
  assert.equal(relevantEvent({ Type: 'network', Action: 'connect', Actor: { Attributes: { name: 'bridge' } } }), false);
  assert.equal(relevantEvent({ Type: 'image', Action: 'pull' }), false);
});
