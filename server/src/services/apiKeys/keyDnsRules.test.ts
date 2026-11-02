import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_KEY_DNS_TYPES, OWNERSHIP_TXT_LABEL } from '@oblimint/shared';
import { autoRecords, type GeneratedRecord } from '../dns/records';
import { keyWriteGuard, platformNamesIn, protectedRecordError, storedReadOnly } from './keyDnsRules';

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
  assert.equal(keyWriteGuard({ name: 'selector2._domainkey', type: 'TXT', content: 'v=DKIM1; p=abc' }, noMail), null, 'a DKIM selector of a mail hosted elsewhere');
});

test('the names served by the sites are never repointed', () => {
  for (const name of ['@', 'www', 'shop']) {
    assert.equal(keyWriteGuard({ name, type: 'A', content: '203.0.113.50' }, generated), 'generated', name);
  }
  assert.equal(keyWriteGuard({ name: '*.shop', type: 'A', content: '203.0.113.50' }, generated), 'reserved', 'a wildcard name');
  assert.equal(keyWriteGuard({ name: 'www', type: 'CNAME', content: 'elsewhere.example.org.' }, generated), 'generated', 'a CNAME would hide them');
  assert.equal(keyWriteGuard({ name: 'www', type: 'AAAA', content: '2001:db8::9' }, generated), 'generated');
  assert.equal(keyWriteGuard({ name: 'api.shop', type: 'A', content: '203.0.113.50' }, generated), 'generated', 'answered by the wildcard of a site');
  assert.equal(keyWriteGuard({ name: 'api.shop', type: 'TXT', content: 'hello' }, generated), 'generated', 'a TXT would create the name: the wildcard stops answering it');
  assert.equal(keyWriteGuard({ name: 'api.shop', type: 'TXT', content: 'hello' }, generated, { existing: ['api.shop'] }), null, 'the name exists already: nothing changes for the wildcard');
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
  assert.equal(storedReadOnly({ name: 'www', type: 'A', content: '203.0.113.9', origin: 'manual', byKey: true }, generated), 'generated', 'a key\'s record shadowed by a site: never a human\'s override');
  assert.equal(storedReadOnly({ name: 'api.shop', type: 'TXT', content: 'x', origin: 'manual' }, generated), null, 'a stored record makes its own name exist');
});

test('the refusal is a clear 403 dnsRecordProtected with its reason', () => {
  const e = protectedRecordError('generated', { name: 'www', type: 'A' });
  assert.equal(e.statusCode, 403);
  assert.equal(e.code, 'dnsRecordProtected');
  assert.deepEqual(e.details, { reason: 'generated', name: 'www', type: 'A' });
  assert.match(e.message, /routes \/ subdomains/);
  assert.match(protectedRecordError('type', { name: 'sub', type: 'NS' }).message, /A, AAAA, CNAME, TXT, MX, SRV, CAA/);
});

test('an address beside a generated one: the other family is the platform\'s too (IPv4-only platform)', () => {
  const v4only = autoRecords({ ...ctx, ipv6: null }, [{ name: 'example.com', includeWww: true, wildcard: false }]);
  assert.equal(v4only.some((g) => g.type === 'AAAA'), false);
  assert.equal(keyWriteGuard({ name: 'www', type: 'AAAA', content: '2001:db8::66' }, v4only), 'generated', 'dual-stack visitors would go there');
  assert.equal(keyWriteGuard({ name: '@', type: 'AAAA', content: '2001:db8::66' }, v4only), 'generated');
  const v6only = autoRecords({ ...ctx, ipv4: null }, [{ name: 'example.com', includeWww: false, wildcard: false }]);
  assert.equal(keyWriteGuard({ name: '@', type: 'A', content: '203.0.113.66' }, v6only), 'generated');
  assert.equal(keyWriteGuard({ name: 'other', type: 'AAAA', content: '2001:db8::66' }, v4only), null, 'a name no site serves');
});

test('wildcard names are never a key\'s (they would answer the challenge names)', () => {
  for (const [name, type, content] of [['*', 'TXT', 'token'], ['*', 'CNAME', 'elsewhere.example.org.'], ['*.x', 'TXT', 'token'], ['*', 'A', '203.0.113.5']] as const) {
    assert.equal(keyWriteGuard({ name, type, content }, noMail), 'reserved', `${name} ${type}`);
  }
  assert.match(protectedRecordError('reserved', { name: '*', type: 'TXT' }).message, /wildcard/);
});

test('below a generated wildcard: no new name, nor empty non-terminal, hides it', () => {
  const apexWildcard = autoRecords({ ...ctx, mailEngine: null }, [{ name: 'example.com', includeWww: true, wildcard: true }]);
  assert.equal(keyWriteGuard({ name: '_minecraft._tcp.play', type: 'SRV', content: '5 25565 mc.example.org.' }, apexWildcard), 'generated', 'play would stop being served');
  assert.equal(keyWriteGuard({ name: 'play', type: 'TXT', content: 'x' }, apexWildcard), 'generated');
  assert.equal(keyWriteGuard({ name: '_minecraft._tcp.play', type: 'SRV', content: '5 25565 mc.example.org.' }, apexWildcard, { existing: ['play'] }), null, 'play exists already: _tcp.play is a service name');
  assert.equal(keyWriteGuard({ name: '_minecraft._tcp', type: 'SRV', content: '5 25565 mc.example.org.' }, apexWildcard), null, 'service labels are never site names');
  assert.equal(keyWriteGuard({ name: '_minecraft._tcp.www', type: 'SRV', content: '5 25565 mc.example.org.' }, apexWildcard), null, 'www is generated');
  assert.equal(keyWriteGuard({ name: 'x._tcp.api.shop', type: 'SRV', content: '5 1 t.example.org.' }, generated), 'generated', 'api.shop would become an empty non-terminal');
  assert.equal(keyWriteGuard({ name: 'api.shop', type: 'SRV', content: '5 1 t.example.org.' }, generated), 'generated');
  assert.equal(keyWriteGuard({ name: '@', type: 'TXT', content: 'google-site-verification=abc' }, apexWildcard), null, 'the apex is not answered by its wildcard');
});

test('platform host names falling in an account zone: any type', () => {
  const hosts = { panelHostname: 'panel.example.com', clientPanelHostname: 'my.example.com', previewDomain: 'preview.example.com', dbAdminHostname: 'db.example.com', probeHostV4: 'v4.example.com', probeHostV6: null };
  const platformNames = platformNamesIn('example.com', hosts);
  assert.deepEqual(platformNames.sort(), ['*.preview', 'db', 'my', 'panel', 'preview', 'v4'].sort());
  assert.deepEqual(platformNamesIn('other.example', hosts), []);
  for (const [name, type, content] of [['panel', 'A', '203.0.113.5'], ['panel', 'CAA', '0 issue "letsencrypt.org"'], ['my', 'TXT', 'x'], ['site1.preview', 'A', '203.0.113.5'], ['preview', 'MX', 'mx.example.org.']] as const) {
    assert.equal(keyWriteGuard({ name, type, content }, noMail, { platformNames }), 'generated', `${name} ${type}`);
  }
  assert.equal(keyWriteGuard({ name: 'spawn', type: 'A', content: '203.0.113.5' }, noMail, { platformNames }), null);
  assert.deepEqual(platformNamesIn('preview.example.com', hosts).sort(), ['*', '@'].sort(), 'the preview domain as a zone: everything');
});

test('hosted mail: every MX and mail TXT stays the platform\'s; CAA only for the platform\'s authority', () => {
  for (const [name, type, content] of [
    ['x._domainkey', 'TXT', 'v=DKIM1; p=abc'], ['news', 'MX', 'mx.elsewhere.example.'], ['news', 'TXT', 'v=spf1 include:elsewhere.example -all'],
    ['_mta-sts', 'TXT', 'v=STSv1; id=1'], ['_smtp._tls', 'TXT', 'v=TLSRPTv1; rua=mailto:a@example.org'], ['_dmarc.news', 'TXT', 'v=DMARC1; p=none'],
  ] as const) {
    assert.equal(keyWriteGuard({ name, type, content }, generated), 'generated', `${name} ${type}`);
    assert.equal(keyWriteGuard({ name, type, content }, noMail), null, `${name} ${type} without hosted mail`);
  }
  assert.equal(keyWriteGuard({ name: '@', type: 'CAA', content: '0 issue "letsencrypt.org"' }, noMail), null);
  assert.equal(keyWriteGuard({ name: '@', type: 'CAA', content: '0 iodef "mailto:sec@example.org"' }, noMail), null);
  assert.equal(keyWriteGuard({ name: '@', type: 'CAA', content: '0 issue ";"' }, noMail), 'caa', 'no authority at all');
  assert.equal(keyWriteGuard({ name: '@', type: 'CAA', content: '0 issue "digicert.com"' }, noMail), 'caa');
  assert.equal(keyWriteGuard({ name: 'x', type: 'CAA', content: '0 issuewild "letsencrypt.org; validationmethods=dns-01"' }, noMail), 'caa', 'parameters narrow the platform\'s issuance');
  assert.match(protectedRecordError('caa', { name: '@', type: 'CAA' }).message, /letsencrypt\.org/);
});