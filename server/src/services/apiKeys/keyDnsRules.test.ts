import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_KEY_DNS_TYPES, OWNERSHIP_TXT_LABEL } from '@oblimint/shared';
import { autoRecords, type GeneratedRecord } from '../dns/records';
import { keyWriteGuard, protectedRecordError, storedReadOnly } from './keyDnsRules';

// ─────────────────────────────────────────────────────────────────────────────
// What an access key may write in a DNS zone (keyDnsRules.ts): the platform's
// records (sites, subdomains, hosted mail, challenges, NS) never, the free
// records (another server, SRV of a game server, verification TXT) yes.
// ─────────────────────────────────────────────────────────────────────────────

const ctx = { zone: 'example.com', ttl: 3600, ipv4: '198.51.100.1', ipv6: '2001:db8::1', panelHostname: 'panel.example.net', mailEngine: 'stalwart' };
/** example.com served by a site (www), shop.example.com with a wildcard, the mail hosted. */
const generated: GeneratedRecord[] = autoRecords(ctx, [
  { name: 'example.com', includeWww: true, wildcard: false },
  { name: 'shop.example.com', includeWww: false, wildcard: true },
]);
const noMail: GeneratedRecord[] = autoRecords({ ...ctx, mailEngine: null }, [{ name: 'example.com', includeWww: false, wildcard: false }]);

test('free records: another server, game server SRV, verification TXT, CAA', () => {
  assert.equal(keyWriteGuard({ name: 'spawn', type: 'A', content: '203.0.113.50' }, generated), null);
  assert.equal(keyWriteGuard({ name: 'admin.spawn', type: 'AAAA', content: '2001:db8::5' }, generated), null);
  assert.equal(keyWriteGuard({ name: 'docs', type: 'CNAME', content: 'pages.example.org.' }, generated), null);
  assert.equal(keyWriteGuard({ name: '_minecraft._tcp.play', type: 'SRV', content: '5 25565 play.example.com.' }, generated), null);
  assert.equal(keyWriteGuard({ name: '@', type: 'TXT', content: 'google-site-verification=abc' }, generated), null, 'beside the SPF record');
  assert.equal(keyWriteGuard({ name: '@', type: 'CAA', content: '0 issue "letsencrypt.org"' }, generated), null);
  assert.equal(keyWriteGuard({ name: 'selector2._domainkey', type: 'TXT', content: 'v=DKIM1; p=abc' }, generated), null, 'another DKIM selector');
});

test('the names served by the sites are never repointed', () => {
  for (const name of ['@', 'www', 'shop', '*.shop']) {
    assert.equal(keyWriteGuard({ name, type: 'A', content: '203.0.113.50' }, generated), 'generated', name);
  }
  assert.equal(keyWriteGuard({ name: 'www', type: 'CNAME', content: 'elsewhere.example.org.' }, generated), 'generated', 'a CNAME would hide them');
  assert.equal(keyWriteGuard({ name: 'www', type: 'AAAA', content: '2001:db8::9' }, generated), 'generated');
  assert.equal(keyWriteGuard({ name: 'api.shop', type: 'A', content: '203.0.113.50' }, generated), 'generated', 'answered by the wildcard of a site');
  assert.equal(keyWriteGuard({ name: 'api.shop', type: 'TXT', content: 'hello' }, generated), null, 'a TXT does not change where it points');
});

test('the records of a hosted mail are the platform\'s; without hosted mail MX is free', () => {
  assert.equal(keyWriteGuard({ name: '@', type: 'MX', content: 'mx.elsewhere.example.' }, generated), 'generated');
  assert.equal(keyWriteGuard({ name: '@', type: 'TXT', content: 'v=spf1 include:elsewhere.example -all' }, generated), 'generated');
  assert.equal(keyWriteGuard({ name: '_dmarc', type: 'TXT', content: 'v=DMARC1; p=reject' }, generated), 'generated');
  assert.equal(keyWriteGuard({ name: '@', type: 'MX', content: 'mx.elsewhere.example.' }, noMail), null);
  assert.equal(keyWriteGuard({ name: '@', type: 'TXT', content: 'v=spf1 include:elsewhere.example -all' }, noMail), null);
});

test('NS, challenges: never; only the key types', () => {
  assert.equal(keyWriteGuard({ name: 'sub', type: 'NS', content: 'ns1.elsewhere.example.' }, generated), 'type');
  assert.equal(keyWriteGuard({ name: '_acme-challenge', type: 'TXT', content: 'x' }, generated), 'reserved');
  assert.equal(keyWriteGuard({ name: '_acme-challenge.spawn', type: 'TXT', content: 'x' }, generated), 'reserved');
  assert.equal(keyWriteGuard({ name: `${OWNERSHIP_TXT_LABEL}.spawn`, type: 'TXT', content: 'oblimint-verify=x' }, generated), 'reserved');
  assert.deepEqual([...API_KEY_DNS_TYPES].sort(), ['A', 'AAAA', 'CAA', 'CNAME', 'MX', 'SRV', 'TXT']);
});

test('stored records: auto / system are the platform\'s, a human override stays the panel\'s', () => {
  assert.equal(storedReadOnly({ name: '@', type: 'A', content: '198.51.100.1', origin: 'auto' }, generated), 'generated');
  assert.equal(storedReadOnly({ name: '_acme-challenge', type: 'TXT', content: 'x', origin: 'system' }, generated), 'generated');
  assert.equal(storedReadOnly({ name: 'www', type: 'A', content: '203.0.113.9', origin: 'manual' }, generated), 'override');
  assert.equal(storedReadOnly({ name: 'spawn', type: 'A', content: '203.0.113.9', origin: 'manual' }, generated), null);
  assert.equal(storedReadOnly({ name: 'spawn', type: 'A', content: '203.0.113.9', origin: 'template' }, generated), null);
  assert.equal(storedReadOnly({ name: 'sub', type: 'NS', content: 'ns1.x.example.', origin: 'manual' }, generated), 'type');
});

test('the refusal is a clear 403 dnsRecordProtected with its reason', () => {
  const e = protectedRecordError('generated', { name: 'www', type: 'A' });
  assert.equal(e.statusCode, 403);
  assert.equal(e.code, 'dnsRecordProtected');
  assert.deepEqual(e.details, { reason: 'generated', name: 'www', type: 'A' });
  assert.match(e.message, /routes \/ subdomains/);
  assert.match(protectedRecordError('type', { name: 'sub', type: 'NS' }).message, /A, AAAA, CNAME, TXT, MX, SRV, CAA/);
});
