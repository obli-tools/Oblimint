import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addressAt, allocationOffsets, defaultIpRange, fabricAccountId, inDynamicRange, isEphemeralContainer, isManagedNetwork, layoutOf, offsetOf, poolOffsets,
  poolOffsetsFromTop, poolSize, sameIdentity,
  slotFor, slotUsable,
} from './addressLayout';

// Fixed addresses of the managed networks (migration 031): layout, slots, pool, dynamic range.

test('managed networks: account fabrics and platform networks only', () => {
  for (const n of ['oblimint', 'oblimint-mail', 'oblimint-mail-core', 'oblimint-auth', 'oblimint-acct-1', 'oblimint-acct-42-db']) assert.ok(isManagedNetwork(n), n);
  for (const n of ['oblimint-app-3-default', 'oblimint-pv-7', 'oblimint-build', 'bridge', 'host', 'oblimint-acct-x', 'oblimint-acct-1-db-2', 'oblimintx']) {
    assert.equal(isManagedNetwork(n), false, n);
  }
  assert.equal(fabricAccountId('oblimint-acct-42-db'), 42);
  assert.equal(fabricAccountId('oblimint-acct-7'), 7);
  assert.equal(fabricAccountId('oblimint-mail'), null);
});

test('slots: panel by its own name, platform containers, file server of any account, nothing for the others', () => {
  assert.deepEqual(slotFor('oblimint', null), { offset: 2, name: 'panel' });
  assert.deepEqual(slotFor('my-panel', 'my-panel'), { offset: 2, name: 'panel' });
  assert.equal(slotFor('oblimint', 'my-panel'), null, 'the default name is not the panel when it is called otherwise');
  assert.equal(slotFor('oblimint-postgres', null)?.offset, 3);
  assert.equal(slotFor('oblimint-edge', null)?.offset, 4);
  assert.equal(slotFor('oblimint-pdns', null)?.offset, 5);
  assert.equal(slotFor('oblimint-phpmyadmin', null)?.offset, 6);
  assert.equal(slotFor('oblimint-adminer', null)?.offset, 7);
  assert.equal(slotFor('oblimint-scanner', null)?.offset, 8);
  assert.equal(slotFor('oblimint-mail', null)?.offset, 9);
  assert.equal(slotFor('oblimint-mail-relay', null)?.offset, 10);
  assert.equal(slotFor('oblimint-webmail', null)?.offset, 11);
  assert.equal(slotFor('oblimint-mail-rspamd', null)?.offset, 12);
  assert.equal(slotFor('oblimint-mail-redis', null)?.offset, 13);
  assert.equal(slotFor('oblimint-auth-redis', null)?.offset, 14);
  assert.deepEqual(slotFor('oblimint-files-12', null), { offset: 15, name: 'files' });
  assert.equal(slotFor('oblimint-site-3', null), null);
  assert.equal(slotFor('oblimint-oauth2-4', null), null);
  assert.equal(slotFor('oblimint-old-1730000000000', 'oblimint'), null, 'previous panel of a self-update');
});

test('ephemeral containers never get an address', () => {
  assert.ok(isEphemeralContainer('oblimint-old-1730000000000'));
  assert.ok(isEphemeralContainer('oblimint-updater-abc'));
  assert.ok(isEphemeralContainer('oblimint-ipprobe-12-1'));
  assert.equal(isEphemeralContainer('oblimint-site-1'), false);
});

test('a /24 fabric: pool .32–.239, dynamic range .240/28, gateway .1', () => {
  assert.equal(defaultIpRange('10.224.5.0/24'), '10.224.5.240/28');
  const l = layoutOf('10.224.5.0/24', '10.224.5.240/28');
  assert.equal(l.gateway, '10.224.5.1');
  const pool = [...poolOffsets(l)];
  assert.equal(pool[0], 32);
  assert.equal(pool[pool.length - 1], 239);
  assert.equal(poolSize(l), 208);
  assert.ok(inDynamicRange(l, 240) && inDynamicRange(l, 255) && !inDynamicRange(l, 239));
  assert.equal(addressAt(l, 2), '10.224.5.2');
  assert.equal(offsetOf(l, '10.224.5.77/24'), 77);
  assert.equal(offsetOf(l, '10.224.6.1'), null);
  assert.ok(slotUsable(l, 2) && slotUsable(l, 15));
  assert.equal(slotUsable(l, 1), false, 'gateway');
  assert.equal(slotUsable(l, 245), false, 'dynamic range');
});

test('prefixes /16 to /26 have a pool; /27 and longer are refused', () => {
  for (let bits = 16; bits <= 26; bits++) {
    const size = 2 ** (32 - bits);
    const cidr = `10.240.0.0/${bits}`;
    const range = defaultIpRange(cidr);
    const l = layoutOf(cidr, range);
    const pool = [...poolOffsets(l)];
    assert.ok(pool.length > 0, `/${bits} has a pool`);
    assert.equal(pool[0], 32);
    assert.equal(pool[pool.length - 1], size - 16 - 1, `/${bits} pool ends before the dynamic /28`);
    assert.ok(pool.every((o) => !inDynamicRange(l, o)));
  }
  for (const bits of [27, 28, 30]) {
    assert.throws(() => layoutOf(`10.240.0.0/${bits}`, null), /too small/);
    assert.throws(() => defaultIpRange(`10.240.0.0/${bits}`), /too small/);
  }
});

test('adopted network without IPRange (Docker default /16): the pool runs to the broadcast − 1', () => {
  const l = layoutOf('172.18.0.0/16', null);
  assert.equal(l.dynamic, null);
  const pool = [...poolOffsets(l)];
  assert.equal(pool[0], 32);
  assert.equal(pool[pool.length - 1], 65534);
  assert.throws(() => layoutOf('172.18.0.0/16', '10.240.0.0/28'), /not inside/);
});

test('the stopped copy left by a replacement is the same identity, never an owner of its own', () => {
  assert.ok(isEphemeralContainer('oblimint-edge-oblimint-prev'), 'platform update copy: never allocated');
  assert.ok(sameIdentity('oblimint-edge', 'oblimint-edge'));
  assert.ok(sameIdentity('oblimint-edge-oblimint-prev', 'oblimint-edge'));
  assert.ok(sameIdentity('oblimint-site-7-oblimint-prev', 'oblimint-site-7'));
  assert.ok(sameIdentity('oblimint-old-1730000000000', 'oblimint'), 'self-update copy of the panel');
  assert.equal(sameIdentity('oblimint-site-7-oblimint-prev', 'oblimint-site-70'), false);
  assert.equal(sameIdentity('oblimint-site-70-oblimint-prev', 'oblimint-site-7'), false);
  assert.equal(sameIdentity('oblimint-scanner', 'oblimint-edge'), false);
  assert.equal(sameIdentity(null, 'oblimint-edge'), false);
});

test('allocation order: from the bottom with a dynamic range, from the top without one (adopted network)', () => {
  const ranged = layoutOf('10.224.7.0/24', '10.224.7.240/28');
  assert.deepEqual([...allocationOffsets(ranged)].slice(0, 2), [32, 33]);
  const adopted = layoutOf('172.18.0.0/16', null);
  const top = [...poolOffsetsFromTop(adopted)];
  assert.equal(top[0], 65534, 'broadcast − 1 first');
  assert.equal(top[top.length - 1], 32);
  assert.deepEqual([...allocationOffsets(adopted)].slice(0, 2), [65534, 65533]);
  const legacy24 = layoutOf('172.20.0.0/24', null);
  assert.equal(addressAt(legacy24, [...allocationOffsets(legacy24)][0]), '172.20.0.254');
});
