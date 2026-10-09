import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFileServerSourceCheck, isLoopback, normalizeIp } from './hookSource';

test('normalizeIp / isLoopback', () => {
  assert.equal(normalizeIp('::ffff:172.18.0.4'), '172.18.0.4');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(normalizeIp('not-an-ip'), null);
  assert.equal(normalizeIp(undefined), null);
  assert.ok(isLoopback('127.0.0.1') && isLoopback('::1'));
  assert.ok(!isLoopback('172.18.0.1'));
});

test('hook source: only the address of oblimint-files-<account> (or loopback) is accepted', async () => {
  let t = 1_000_000;
  const lookups: string[] = [];
  let fsIp = '172.20.0.3';
  const check = createFileServerSourceCheck({
    resolve: async (name) => {
      lookups.push(name);
      if (name === 'oblimint-files-7') return [fsIp];
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    },
    now: () => t,
    ttlMs: 30_000,
    retryMs: 2_000,
  });
  assert.equal(await check(7, '::ffff:172.20.0.3'), true, 'the file server of account 7');
  assert.equal(await check(7, '127.0.0.1'), true, 'loopback (the panel itself)');
  assert.equal(await check(7, '172.20.0.5'), false, 'a site container of the same account network');
  assert.equal(await check(8, '172.20.0.3'), false, 'account 7\'s file server calling account 8\'s hooks');
  assert.equal(await check(7, undefined), false);
  assert.equal(await check(0, '127.0.0.1'), false);
  assert.deepEqual(lookups, ['oblimint-files-7', 'oblimint-files-8']);

  // A hostile peer does not trigger a DNS lookup per request (retry delay).
  for (let i = 0; i < 20; i++) assert.equal(await check(7, '172.20.0.5'), false);
  assert.equal(lookups.filter((n) => n === 'oblimint-files-7').length, 1);

  // File server recreated with a new address: re-resolved after the retry delay.
  fsIp = '172.20.0.9';
  t += 3_000;
  assert.equal(await check(7, '172.20.0.9'), true);
  assert.equal(await check(7, '172.20.0.3'), false, 'the old address is no longer trusted');
});
