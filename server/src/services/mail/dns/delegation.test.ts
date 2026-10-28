import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicDnsError } from '../../../utils/publicDns';
import { apexCandidates, classifyDelegation, lookupDelegation, ourNameservers } from './delegation';

// Public delegation of the zone of a mail domain (delegation.ts): classification
// of the public NS against our name servers, walk-up to the zone apex.

const OURS = ['ns1.example.net', 'ns2.example.net'];

test('classifyDelegation: ours / elsewhere / mixed / unknown', () => {
  assert.equal(classifyDelegation(['ns1.example.net', 'ns2.example.net'], OURS), 'ours');
  assert.equal(classifyDelegation(['NS1.Example.NET.'], OURS), 'ours', 'case and trailing dot ignored');
  assert.equal(classifyDelegation(['dns1.registrar.example', 'dns2.registrar.example'], OURS), 'elsewhere');
  assert.equal(classifyDelegation(['ns1.example.net', 'dns2.registrar.example'], OURS), 'mixed');
  assert.equal(classifyDelegation([], OURS), 'unknown', 'no NS found');
  assert.equal(classifyDelegation(['', ' '], OURS), 'unknown');
  assert.equal(classifyDelegation(['ns1.example.net'], []), 'elsewhere', 'no name servers of ours configured');
});

test('ourNameservers: normalised, none when the DNS module is off', () => {
  assert.deepEqual(ourNameservers({ enabled: true, nameservers: ['NS1.example.net.', 'ns1.example.net', 'ns2.example.net'] }), OURS);
  assert.deepEqual(ourNameservers({ enabled: false, nameservers: OURS }), []);
});

test('apexCandidates: the name then its parents, down to two labels', () => {
  assert.deepEqual(apexCandidates('Mail.Shop.Example.com.'), ['mail.shop.example.com', 'shop.example.com', 'example.com']);
  assert.deepEqual(apexCandidates('example.com'), ['example.com']);
  assert.deepEqual(apexCandidates('localhost'), []);
});

function fakeNs(table: Record<string, string[]>, fail: string[] = []) {
  const calls: string[] = [];
  return {
    calls,
    async ns(name: string) {
      calls.push(name);
      if (fail.includes(name)) throw new PublicDnsError(`NS ${name}: ETIMEOUT`, 'ETIMEOUT');
      return table[name] ?? [];
    },
  };
}

test('lookupDelegation: hosted zone name used as is', async () => {
  const l = fakeNs({ 'example.com': ['ns2.example.net', 'ns1.example.net', 'ns1.example.net'] });
  const d = await lookupDelegation(l, { zone: 'example.com', name: 'shop.example.com', expected: OURS });
  assert.deepEqual(d, { zone: 'example.com', found: OURS, status: 'ours', failed: false });
  assert.deepEqual(l.calls, ['example.com'], 'no walk-up when the zone is known');
});

test('lookupDelegation: walk-up to the first name with NS records', async () => {
  const l = fakeNs({ 'example.com': ['dns1.registrar.example', 'dns2.registrar.example'] });
  const d = await lookupDelegation(l, { zone: null, name: 'mail.shop.example.com', expected: OURS });
  assert.equal(d.zone, 'example.com');
  assert.equal(d.status, 'elsewhere');
  assert.deepEqual(d.found, ['dns1.registrar.example', 'dns2.registrar.example']);
  assert.deepEqual(l.calls, ['mail.shop.example.com', 'shop.example.com', 'example.com']);
  // A delegated sub-zone stops the walk.
  const sub = await lookupDelegation(fakeNs({ 'shop.example.com': ['ns1.example.net', 'dns1.registrar.example'] }), { zone: null, name: 'shop.example.com', expected: OURS });
  assert.equal(sub.zone, 'shop.example.com');
  assert.equal(sub.status, 'mixed');
});

test('lookupDelegation: resolver failure → unknown (never throws), nothing found → unknown', async () => {
  const failed = await lookupDelegation(fakeNs({}, ['example.com']), { zone: 'example.com', name: 'example.com', expected: OURS });
  assert.deepEqual(failed, { zone: 'example.com', found: [], status: 'unknown', failed: true });
  const none = await lookupDelegation(fakeNs({}), { zone: null, name: 'mail.example.com', expected: OURS });
  assert.deepEqual(none, { zone: 'example.com', found: [], status: 'unknown', failed: false });
});
